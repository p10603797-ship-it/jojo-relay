// Phortnite LAN / internet game server.
//   npm install && npm start      ->  open the printed address on every device on the same Wi-Fi.
// Serves the website (public/), the vendored libraries and a WebSocket endpoint at /ws.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Room, getWorld } from './public/shared/room.js';
import { VERSION, TICK_HZ } from './public/shared/constants.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;

const VENDOR = {
  '/vendor/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three.core.js': 'node_modules/three/build/three.core.js',
  '/vendor/rapier.mjs': 'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.txt']);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // prefer typical home-router ranges first
  return out.sort((a, b) => score(b) - score(a));
  function score(ip) { return ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : ip.startsWith('172.') ? 1 : 0; }
}

const cache = new Map(); // abs path -> { mtime, raw, gz }

const ADDONS = path.join(ROOT, 'node_modules/three/examples/jsm');

function resolvePath(urlPath) {
  if (VENDOR[urlPath]) return path.join(ROOT, VENDOR[urlPath]);
  if (urlPath.startsWith('/vendor/addons/')) {
    const abs = path.normalize(path.join(ADDONS, decodeURIComponent(urlPath.slice('/vendor/addons/'.length))));
    return abs.startsWith(ADDONS) ? abs : null;
  }
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.normalize(path.join(PUBLIC, p));
  if (!abs.startsWith(PUBLIC)) return null;
  return abs;
}

function serveFile(req, res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    let entry = cache.get(abs);
    if (!entry || entry.mtime !== st.mtimeMs) {
      const raw = fs.readFileSync(abs);
      entry = { mtime: st.mtimeMs, raw, gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 6 }) : null };
      cache.set(abs, entry);
    }
    const etag = `"${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}"`;
    const headers = {
      'content-type': type,
      'cache-control': abs.includes('node_modules') ? 'public, max-age=86400' : 'no-cache',
      etag,
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const acceptGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (entry.gz && acceptGz) {
      headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(entry.gz);
    } else {
      res.writeHead(200, headers);
      res.end(entry.raw);
    }
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (TRUST_PROXY && typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    const lan = lanAddresses().map((ip) => `http://${ip}${PORT === 80 ? '' : ':' + PORT}/`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ name: 'phortnite', version: VERSION, lan, rooms: rooms.size }));
    return;
  }
  if (url.pathname === '/api/qr.svg') {
    const text = (url.searchParams.get('u') || '').slice(0, 300);
    try {
      const svg = await QRCode.toString(text || 'phortnite', { type: 'svg', margin: 1, color: { dark: '#111', light: '#fff' } });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(svg);
    } catch {
      res.writeHead(400);
      res.end();
    }
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const abs = resolvePath(url.pathname);
  if (!abs) {
    res.writeHead(403);
    res.end();
    return;
  }
  serveFile(req, res, abs);
});

// ---------------------------------------------------------------- rooms
const rooms = new Map(); // code -> Room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function log(msg, fields) {
  if (process.env.QUIET) return;
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`);
}

function roomList(ip) {
  return [...rooms.values()]
    .filter((r) => !r.empty)
    .map((r) => r.publicInfo(ip))
    .sort((a, b) => Number(b.sameNet) - Number(a.sameNet) || b.players - a.players)
    .slice(0, 30);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
let connSeq = 0;

wss.on('connection', (ws, req) => {
  const conn = {
    id: `c${++connSeq}`,
    ip: clientIp(req),
    room: null,
    alive: true,
    msgCount: 0,
    msgWindow: Date.now(),
    send(obj) {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    },
  };
  ws.on('pong', () => { conn.alive = true; });
  conn.send({ t: 'hi', v: VERSION });

  ws.on('message', (data) => {
    const now = Date.now();
    if (now - conn.msgWindow > 1000) { conn.msgWindow = now; conn.msgCount = 0; }
    if (++conn.msgCount > 400) return; // flood guard
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'list':
        conn.send({ t: 'rooms', rooms: roomList(conn.ip) });
        return;
      case 'create': {
        if (conn.room) leaveRoom(conn);
        if (rooms.size >= MAX_ROOMS) { conn.send({ t: 'err', msg: 'Server is full, try again later.' }); return; }
        const code = newCode();
        const name = String(msg.hello?.name || 'Player').slice(0, 16);
        const room = new Room({ code, name: `${name}'s party`, log });
        rooms.set(code, room);
        if (room.join(conn, msg.hello || {})) conn.room = room;
        log('room created', { code, by: name });
        return;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '');
        const room = rooms.get(code);
        if (!room || room.empty) { conn.send({ t: 'err', msg: `No party with code ${code || '?'} on this server.` }); return; }
        if (conn.room) leaveRoom(conn);
        if (room.join(conn, msg.hello || {})) conn.room = room;
        return;
      }
      case 'leave':
        leaveRoom(conn);
        return;
      default:
        if (conn.room) conn.room.message(conn.id, msg);
    }
  });

  ws.on('close', () => leaveRoom(conn));
  ws.on('error', () => {});
  ws.conn = conn;
});

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  conn.room = null;
  room.leave(conn.id);
  if (room.empty) {
    rooms.delete(room.code);
    log('room closed', { code: room.code });
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.empty) room.tick();
  }
}, 1000 / TICK_HZ);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.conn) continue;
    if (!ws.conn.alive) { ws.terminate(); continue; }
    ws.conn.alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);

// ---------------------------------------------------------------- start
const t0 = Date.now();
getWorld(); // warm the world generator
server.listen(PORT, HOST, async () => {
  const lan = lanAddresses();
  const main = lan.length ? `http://${lan[0]}:${PORT}/` : `http://localhost:${PORT}/`;
  console.log('');
  console.log('  ██████  PHORTNITE server v' + VERSION + `  (world ready in ${Date.now() - t0} ms)`);
  console.log('');
  console.log(`  On this computer:      http://localhost:${PORT}/`);
  for (const ip of lan) console.log(`  On your Wi-Fi (iPads):  http://${ip}:${PORT}/`);
  console.log('');
  if (lan.length && !process.env.NO_QR) {
    try {
      const qr = await QRCode.toString(main, { type: 'terminal', small: true });
      console.log('  Scan with an iPad camera to join:');
      console.log(qr.split('\n').map((l) => '   ' + l).join('\n'));
    } catch { /* ignore */ }
  }
  console.log('  Everyone on the same Wi-Fi opens that address, then Play with Friends -> join the party.');
  console.log('');
});
