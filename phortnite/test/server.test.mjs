// Run with: npm test   (starts the real server on a spare port and talks to it over WebSocket)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
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

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
