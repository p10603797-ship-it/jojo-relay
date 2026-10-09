// A small MQTT 3.1.1 broker over WebSocket for tests (QoS 0, exact topics), standing in for the
// public brokers P2P parties use as a relay (public/js/net/relay.js).
//
//   const b = await startBroker({ user: 'public', pass: 'public', split: true });
//   b.url              ws://127.0.0.1:<port>/mqtt
//   b.published        how many PUBLISH packets clients sent
//   b.kill()           drop every client connection (a broker hiccup)
//   b.stop()           shut down
// split: send every packet in two WebSocket frames (clients must put packets back together)
import { WebSocketServer } from 'ws';

const enc = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const len = (n) => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Buffer.from(o); };
const pkt = (h, body) => Buffer.concat([Buffer.from([h]), len(body.length), body]);

export async function startBroker(opts = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port || 0, handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
  await new Promise((r) => wss.once('listening', r));
  const subs = new Map(); // topic -> Set(client)
  const clients = new Set();
  const B = {
    url: `ws://127.0.0.1:${wss.address().port}/mqtt`,
    published: 0,
    connects: 0,
    kill() { for (const c of clients) c.ws.terminate(); },
    stop() { B.kill(); return new Promise((r) => wss.close(r)); },
  };
  const out = (c, buf) => {
    if (c.ws.readyState !== 1) return;
    if (opts.split && buf.length > 2) {
      const cut = Math.max(1, buf.length >> 1);
      c.ws.send(buf.subarray(0, cut));
      c.ws.send(buf.subarray(cut));
    } else c.ws.send(buf);
  };
  wss.on('connection', (ws) => {
    const c = { ws, topics: new Set(), ok: false, rx: Buffer.alloc(0) };
    clients.add(c);
    const bye = () => {
      clients.delete(c);
      for (const t of c.topics) subs.get(t)?.delete(c);
    };
    ws.on('close', bye);
    ws.on('error', bye);
    ws.on('message', (data) => {
      c.rx = Buffer.concat([c.rx, data]);
      for (;;) {
        if (c.rx.length < 2) return;
        let n = 0, mult = 1, i = 1, b;
        do { if (i >= c.rx.length) return; b = c.rx[i++]; n += (b & 127) * mult; mult *= 128; } while (b & 128);
        if (c.rx.length < i + n) return;
        const head = c.rx[0], body = c.rx.subarray(i, i + n);
        c.rx = c.rx.subarray(i + n);
        handle(c, head, body);
      }
    });
  });
  function handle(c, head, body) {
    const type = head >> 4;
    if (!c.ok && type !== 1) { c.ws.terminate(); return; }
    if (type === 1) {
      // CONNECT: protocol name, level, flags, keepalive, client id, [user], [pass]
      let o = 2 + body.readUInt16BE(0);
      const level = body[o++], flags = body[o++];
      o += 2;
      const str = () => { const l = body.readUInt16BE(o); const s = body.subarray(o + 2, o + 2 + l).toString(); o += 2 + l; return s; };
      str(); // client id
      const user = flags & 0x80 ? str() : '', pass = flags & 0x40 ? str() : '';
      const good = level === 4 && (!opts.user || (user === opts.user && pass === opts.pass));
      out(c, pkt(0x20, Buffer.from([0, good ? 0 : 4])));
      if (!good) { setTimeout(() => c.ws.close(), 10); return; }
      c.ok = true;
      B.connects++;
    } else if (type === 8) {
      const id = body.subarray(0, 2);
      const l = body.readUInt16BE(2);
      const topic = body.subarray(4, 4 + l).toString();
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(c);
      c.topics.add(topic);
      out(c, pkt(0x90, Buffer.concat([id, Buffer.from([0])])));
    } else if (type === 3) {
      B.published++;
      const l = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + l).toString();
      const msg = pkt(0x30, Buffer.concat([enc(topic), body.subarray(2 + l)]));
      for (const s of subs.get(topic) || []) out(s, msg);
    } else if (type === 12) out(c, Buffer.from([0xd0, 0]));
    else if (type === 14) c.ws.close();
  }
  return B;
}
