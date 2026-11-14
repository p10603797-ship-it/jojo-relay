// Run with: npm test   (starts the real server on a spare port and talks to it over WebSocket)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import net from 'node:net';
import { PROTOCOL } from '../public/shared/constants.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function startServer() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return { port, proc };
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('server did not start');
}

function client(port, headers = undefined) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, headers ? { headers } : undefined);
    const queue = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else queue.push(m);
    });
    const next = (pred) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((res) => waiters.push({ pred, resolve: res }));
    };
    ws.on('open', () => resolve({ send: (m) => ws.send(JSON.stringify(m)), next, close: () => ws.close() }));
    ws.on('error', reject);
  });
}

test('an old cached page that tries to create a party is turned away and leaves no empty party behind', async () => {
  const { port, proc } = await startServer();
  try {
    const old = await client(port);
    for (let i = 0; i < 3; i++) {
      old.send({ t: 'create', hello: { name: `Old${i}` } }); // pages from before versions were sent
      const m = await old.next((x) => x.t === 'err' || x.t === 'welcome');
      assert.equal(m.t, 'err');
      assert.ok(m.ver);
    }
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.equal(info.rooms, 0);
    const cur = await client(port);
    cur.send({ t: 'list' });
    assert.deepEqual((await cur.next((x) => x.t === 'rooms')).rooms, []);
    cur.send({ t: 'create', hello: { name: 'Current', v: PROTOCOL } });
    assert.equal((await cur.next((x) => x.t === 'welcome' || x.t === 'err')).t, 'welcome');
    old.close();
    cur.close();
  } finally {
    proc.kill();
  }
});

test('server parties: create with settings, join by code, kick (the kicked socket can make a new party), rejoin after a drop', async () => {
  const { port, proc } = await startServer();
  const hello = (name, extra = {}) => ({ name, v: PROTOCOL, skin: 1, resume: '', ...extra });
  try {
    // the party of one's mode comes along when it invites friends
    const lead = await client(port);
    lead.send({ t: 'create', hello: hello('Mia', { lvl: 7 }), settings: { modeId: 'duos', rules: { teams: 2, gravity: 0.35, junk: 1 }, info: { name: 'Duos', emoji: '👯', color: '#5ad13a', tags: ['Duos'] }, bots: 3, evil: { x: 1 } } });
    const w = await lead.next((m) => m.t === 'welcome' || m.t === 'err');
    assert.equal(w.t, 'welcome');
    assert.equal(w.settings.modeId, 'duos');
    assert.equal(w.settings.rules.teams, 2);
    assert.equal(w.settings.rules.gravity, 0.35);
    assert.equal(w.settings.rules.junk, undefined, 'rules are normalized');
    assert.equal(w.settings.evil, undefined, 'unknown settings are dropped');
    assert.equal(w.settings.bots, 3);
    assert.match(w.resume, /^[A-Za-z0-9]{16}$/);
    assert.equal(w.players[0].lvl, 7);
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.equal(typeof info.lanUrl, 'string');
    // friends join by code
    const ben = await client(port);
    ben.send({ t: 'join', code: w.code.toLowerCase(), hello: hello('Ben') });
    const wb = await ben.next((m) => m.t === 'welcome' || m.t === 'err');
    assert.equal(wb.t, 'welcome');
    assert.equal(wb.code, w.code);
    const cat = await client(port);
    cat.send({ t: 'join', code: w.code, hello: hello('Cat') });
    const wc = await cat.next((m) => m.t === 'welcome');
    // kick Cat: she hears it, leaves the roster, and her socket is free for a party of her own
    lead.send({ t: 'kick', id: wc.you });
    assert.equal((await cat.next((m) => m.t === 'kicked')).t, 'kicked');
    const r1 = await lead.next((m) => m.t === 'roster' && !m.players.some((p) => p.id === wc.you));
    assert.equal(r1.players.length, 2);
    cat.send({ t: 'ready', on: true }); // no longer reaches Mia's party
    cat.send({ t: 'create', hello: hello('Cat') });
    const wc2 = await cat.next((m) => m.t === 'welcome');
    assert.notEqual(wc2.code, w.code);
    assert.equal(wc2.players.length, 1);
    // start (countdown) and drop Ben's socket mid-match: he comes back as the same player
    lead.send({ t: 'start', cd: 1 });
    await lead.next((m) => m.t === 'countdown' && m.s === 3);
    await ben.next((m) => m.t === 'start');
    ben.close();
    const held = await lead.next((m) => m.t === 'roster' && m.players.some((p) => p.id === wb.you && p.away === 1));
    assert.ok(held);
    const ben2 = await client(port);
    ben2.send({ t: 'join', code: w.code, hello: hello('Ben', { resume: wb.resume, keep: true }) });
    const rb = await ben2.next((m) => m.t === 'resumed' || m.t === 'welcome' || m.t === 'err');
    assert.equal(rb.t, 'resumed');
    assert.equal(rb.you, wb.you, 'same player id');
    assert.equal(rb.phase === 'bus' || rb.phase === 'match', true);
    assert.equal(rb.me.alive, true);
    await lead.next((m) => m.t === 'roster' && m.players.some((p) => p.id === wb.you && p.away === 0));
    // the party list shows Mia's party with 2 players
    const lister = await client(port);
    lister.send({ t: 'list' });
    const rooms = (await lister.next((m) => m.t === 'rooms')).rooms;
    assert.equal(rooms.find((r) => r.code === w.code).players, 2);
    for (const c of [lead, ben2, cat, lister]) c.close();
  } finally {
    proc.kill();
  }
});

/** A raw HTTP request line (fetch() refuses to send these), resolved with the status line or ''. */
function rawRequest(port, line) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('end', () => resolve(buf.split('\r\n')[0]));
    s.on('error', () => resolve(''));
    setTimeout(() => { s.destroy(); resolve(buf.split('\r\n')[0]); }, 2000);
  });
}

test('malformed requests get a 400 and never take the server (and its parties) down', async () => {
  const { port, proc } = await startServer();
  let exited = false;
  proc.on('exit', () => { exited = true; });
  try {
    const lead = await client(port);
    lead.send({ t: 'create', hello: { name: 'Mia', v: PROTOCOL } });
    assert.equal((await lead.next((m) => m.t === 'welcome' || m.t === 'err')).t, 'welcome');
    assert.match(await rawRequest(port, 'GET /%E0%A4%A HTTP/1.1'), / 400 /);
    assert.match(await rawRequest(port, 'GET /vendor/addons/%ZZ HTTP/1.1'), / 400 /);
    assert.match(await rawRequest(port, 'GET //[ HTTP/1.1'), / 400 /);
    assert.match(await rawRequest(port, 'GET /../../etc/passwd HTTP/1.1'), / (403|404) /);
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(await r.text(), 'ok');
    assert.equal(exited, false);
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.equal(info.rooms, 1, 'the party survived');
    lead.close();
  } finally {
    proc.kill();
  }
});

test('one socket cannot fill the server with parties: switching parties is never held, and creates are limited per network', async () => {
  const { port, proc } = await startServer();
  try {
    // a client on another network, behind a reverse proxy on the server's machine (X-Forwarded-For
    // is trusted from loopback only; this computer itself is never limited)
    const spam = await client(port, { 'x-forwarded-for': '203.0.113.7' });
    let welcomes = 0, errs = 0;
    for (let i = 0; i < 40; i++) {
      spam.send({ t: 'create', hello: { name: `S${i}`, v: PROTOCOL, resume: '' } });
      const m = await spam.next((x) => x.t === 'welcome' || x.t === 'err');
      if (m.t === 'welcome') welcomes++; else errs++;
    }
    assert.ok(welcomes >= 1 && welcomes <= 10, `creates per minute are limited (${welcomes})`);
    assert.ok(errs > 0);
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.equal(info.rooms, 1, 'each create left the previous party for good');
    spam.close();
  } finally {
    proc.kill();
  }
});

test('a server that cannot listen (an address this machine does not have) says so and exits', async () => {
  // 203.0.113.1 is TEST-NET-3: never one of this machine's addresses
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: '20999', HOST: '203.0.113.1', NO_QR: '1' }, stdio: 'ignore' });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { proc.kill(); resolve('still running'); }, 20000);
    proc.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 1);
});
