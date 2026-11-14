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
import { cleanSettings } from './public/shared/plugins/party.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
// X-Forwarded-For: '1' always trusted, '0' never; by default only from a reverse proxy on this
// machine (loopback), so a client cannot pick its own IP to get around the per-IP limits below
const TRUST_PROXY = process.env.TRUST_PROXY === '1' ? 'always' : process.env.TRUST_PROXY === '0' ? 'never' : 'loopback';
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
// per network (IP) limits: generous, since a home or a school behind NAT shares one public IP
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP) || 8;
const MAX_CREATES_PER_MIN = Number(process.env.MAX_CREATES_PER_MIN) || 10;
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP) || 64;

const VENDOR = {
  '/vendor/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three.core.js': 'node_modules/three/build/three.core.js',
  '/vendor/rapier.mjs': 'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs',
  '/vendor/es-module-shims.js': 'node_modules/es-module-shims/dist/es-module-shims.js',
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

// index.html points at the CDN; when we serve it ourselves use our local copies instead,
// so a LAN party keeps working even without internet.
const LOCAL_LIBS = [
  ['https://cdn.jsdelivr.net/npm/es-module-shims@2.8.4/dist/es-module-shims.js', 'vendor/es-module-shims.js'],
  ['https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js', './vendor/three.module.js'],
  ['https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/', './vendor/addons/'],
  ['https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs', './vendor/rapier.mjs'],
];
function localizeHtml(buf) {
  let s = buf.toString('utf8');
  for (const [cdn, local] of LOCAL_LIBS) s = s.split(cdn).join(local);
  // tells the page a party server is behind it (the static website plays peer-to-peer instead)
  s = s.replace('<html', '<html data-server="1"');
  return Buffer.from(s);
}

const ADDONS = path.join(ROOT, 'node_modules/three/examples/jsm');

/** decodeURIComponent, or null for a malformed escape (e.g. '%E0%A4%A'). */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** The file for a URL path: an absolute path, null (outside public/: 403) or undefined (malformed: 400). */
function resolvePath(urlPath) {
  if (VENDOR[urlPath]) return path.join(ROOT, VENDOR[urlPath]);
  if (urlPath.startsWith('/vendor/addons/')) {
    const rel = safeDecode(urlPath.slice('/vendor/addons/'.length));
    if (rel === null) return undefined;
    const abs = path.normalize(path.join(ADDONS, rel));
    return abs.startsWith(ADDONS) ? abs : null;
  }
  let p = safeDecode(urlPath.split('?')[0]);
  if (p === null) return undefined;
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
      // outside the request handler's try/catch: a file deleted or swapped between the stat and
      // the read must not become an uncaught exception that ends every party on the server
      try {
        let raw = fs.readFileSync(abs);
        if (abs === path.join(PUBLIC, 'index.html')) raw = localizeHtml(raw);
        entry = { mtime: st.mtimeMs, raw, gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 6 }) : null };
        cache.set(abs, entry);
      } catch (e) {
        log('serve error', { file: abs, err: String(e) });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end();
        return;
      }
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

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');

let proxyHinted = false;
function clientIp(req) {
  const raw = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fwd = req.headers['x-forwarded-for'];
  const trust = TRUST_PROXY === 'always' || (TRUST_PROXY === 'loopback' && isLoopback(raw));
  if (trust && typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().slice(0, 64);
  // a reverse proxy on another machine: every player would share its address (and the per-network
  // limits): say once how to trust it
  if (!proxyHinted && TRUST_PROXY === 'loopback' && typeof fwd === 'string' && fwd) {
    proxyHinted = true;
    log('proxy', { from: raw, hint: 'requests carry X-Forwarded-For from a proxy that is not on this machine: if it is yours, start with TRUST_PROXY=1 (see README) so each player gets their own per-network limits' });
  }
  return raw;
}

function badRequest(res) {
  if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  // one malformed request must never take the server (and every party on it) down
  try {
    await handleRequest(req, res);
  } catch (e) {
    log('request error', { url: String(req.url).slice(0, 200), err: String(e) });
    try { badRequest(res); } catch { /* the socket is gone */ }
  }
});

async function handleRequest(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { badRequest(res); return; }
  if (url.pathname === '/api/info') {
    const lan = lanAddresses().map((ip) => `http://${ip}${PORT === 80 ? '' : ':' + PORT}/`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    // lanUrl: the address friends' iPads can open (invite links use it when this page is on localhost)
    res.end(JSON.stringify({ name: 'phortnite', version: VERSION, lan, lanUrl: lan[0] || '', rooms: rooms.size }));
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
  if (abs === undefined) { badRequest(res); return; }
  if (!abs) {
    res.writeHead(403);
    res.end();
    return;
  }
  serveFile(req, res, abs);
}

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
    .filter((r) => !r.empty && r.conns.size > 0)
    .map((r) => r.publicInfo(ip))
    .sort((a, b) => Number(b.sameNet) - Number(a.sameNet) || b.players - a.players)
    .slice(0, 30);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
let connSeq = 0;
const connById = new Map(); // conn id -> conn (a room's onKick detaches a kicked or replaced connection)
// broadcasts send the same object to many sockets: stringify it once
const jsonCache = new WeakMap();
function encode(obj) {
  let s = jsonCache.get(obj);
  if (s === undefined) { s = JSON.stringify(obj); jsonCache.set(obj, s); }
  return s;
}

const connsPerIp = new Map(); // ip -> open sockets
const createsByIp = new Map(); // ip -> times of recent 'create's (the last minute)

/** Live parties started from this network, or with someone from it (held players included). */
function roomsOfIp(ip) {
  let n = 0;
  for (const r of rooms.values()) {
    if (r.empty) continue;
    if (r.ownerIp === ip || r.humans().some((p) => p.ip === ip)) n++;
  }
  return n;
}

/** May this network create another party now? (at most MAX_CREATES_PER_MIN a minute; this computer always may) */
function createAllowed(ip, now) {
  if (isLoopback(ip)) return true;
  const list = (createsByIp.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= MAX_CREATES_PER_MIN) { createsByIp.set(ip, list); return false; }
  list.push(now);
  createsByIp.set(ip, list);
  return true;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const open = (connsPerIp.get(ip) || 0) + 1;
  if (open > MAX_CONNS_PER_IP && !isLoopback(ip)) {
    try { ws.send(JSON.stringify({ t: 'err', msg: 'Too many connections from this network.' })); } catch { /* ignore */ }
    ws.close();
    return;
  }
  connsPerIp.set(ip, open);
  const conn = {
    id: `c${++connSeq}`,
    ip,
    room: null,
    alive: true,
    msgCount: 0,
    msgWindow: Date.now(),
    send(obj) {
      if (ws.readyState === 1 && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(encode(obj));
    },
  };
  ws.on('pong', () => { conn.alive = true; });
  connById.set(conn.id, conn);
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
        const busy = { t: 'err', msg: 'Too many parties from this network. Try again in a minute.' };
        if (!createAllowed(conn.ip, now)) { conn.send(busy); return; } // (stays in its party)
        // switching parties is a deliberate leave: never held for a rejoin (one socket, one room)
        if (conn.room) leaveRoom(conn, true);
        if (rooms.size >= MAX_ROOMS) { conn.send({ t: 'err', msg: 'Server is full, try again later.' }); return; }
        if (roomsOfIp(conn.ip) >= MAX_ROOMS_PER_IP && !isLoopback(conn.ip)) { conn.send(busy); return; }
        const code = newCode();
        if (!code) { conn.send({ t: 'err', msg: 'Server is full, try again later.' }); return; }
        const name = String(msg.hello?.name || 'Player').slice(0, 16);
        // the party keeps the mode its leader picked before inviting anyone
        const room = new Room({ code, name: `${name}'s party`, log, settings: cleanSettings(msg.settings) });
        room.ownerIp = conn.ip;
        room.onKick = onKick;
        // only list the party once its creator is in (an old cached page is turned away by join)
        if (!room.join(conn, msg.hello || {})) return;
        rooms.set(code, room);
        conn.room = room;
        log('room created', { code, by: name });
        return;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '');
        const room = rooms.get(code);
        if (!room || room.empty) { conn.send({ t: 'err', msg: `No party with code ${code || '?'} on this server.` }); return; }
        if (conn.room) leaveRoom(conn, true);
        if (room.join(conn, msg.hello || {})) conn.room = room;
        return;
      }
      case 'leave':
        leaveRoom(conn, true);
        return;
      default:
        if (conn.room) conn.room.message(conn.id, msg);
    }
  });

  ws.on('close', () => {
    connById.delete(conn.id);
    const n = (connsPerIp.get(ip) || 1) - 1;
    if (n > 0) connsPerIp.set(ip, n); else connsPerIp.delete(ip);
    // a dropped socket (Wi-Fi blip, locked iPad) is the one case held for a rejoin
    leaveRoom(conn);
  });
  ws.on('error', () => {});
  ws.conn = conn;
});

/** The room let go of this connection (kicked, or its player rejoined on a newer one). */
function onKick(connId) {
  const c = connById.get(connId);
  if (c) c.room = null;
}

/** onPurpose: the page chose to leave (create, join, leave): a 'bye' first, so it is not held. */
function leaveRoom(conn, onPurpose = false) {
  const room = conn.room;
  if (!room) return;
  conn.room = null;
  if (onPurpose) room.message(conn.id, { t: 'bye' });
  room.leave(conn.id);
  if (room.empty) {
    rooms.delete(room.code);
    log('room closed', { code: room.code });
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.empty) {
      try { room.tick(); } catch (e) { log('tick error', { room: room.code, err: String(e && e.stack || e) }); }
    }
    // a room can also empty itself (players held for a rejoin who never came back)
    if (room.empty) {
      rooms.delete(room.code);
      log('room closed', { code: room.code });
    }
  }
}, 1000 / TICK_HZ);

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of createsByIp) if (!list.some((t) => now - t < 60000)) createsByIp.delete(ip);
  for (const ws of wss.clients) {
    if (!ws.conn) continue;
    if (!ws.conn.alive) { ws.terminate(); continue; }
    ws.conn.alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);

// last-resort guards (the request handler and the room ticks catch their own errors): one bad
// request or message must never end every party on the server
process.on('unhandledRejection', (e) => log('unhandled rejection', { err: String((e && e.stack) || e) }));
process.on('uncaughtException', (e) => {
  log('uncaught exception', { err: String((e && e.stack) || e) });
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) process.exit(1);
});
// the server could not start listening (port taken, no permission, an address this machine does
// not have, …): say so and exit, instead of a process that looks alive but serves nothing. (ws
// re-emits the http server's errors on the WebSocketServer, so the handler goes there.)
function serverError(e) {
  log('server error', { err: String((e && e.stack) || e), code: e && e.code });
  if (!server.listening) {
    console.error(`  Phortnite could not start on ${HOST}:${PORT}: ${(e && e.message) || e}`);
    process.exit(1);
  }
}
wss.on('error', serverError);

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
  console.log('  Everyone on the same Wi-Fi opens that address: the leader taps + INVITE, friends tap JOIN A FRIEND (or scan the QR code).');
  console.log('');
});
