// A small MQTT 3.1.1 broker over WebSocket for tests (QoS 0), standing in for the public brokers
// P2P parties use as a relay (public/js/net/relay.js) and the live player count uses
// (public/js/net/presence.js): retained messages, '+' / '#' filters and Last Wills.
//
//   const b = await startBroker({ user: 'public', pass: 'public', split: true });
//   b.url              ws://127.0.0.1:<port>/mqtt
//   b.published        how many PUBLISH packets clients sent
//   b.retained         topic -> payload (Buffer) the broker keeps for new subscribers
//   b.clients()        the connected clients: [{ id, will }]
//   b.drop(id)         drop one client (by MQTT client id, or a fn(client)) without a goodbye: its will goes out
//   b.drop(id, { lateWillMs })  …and its will only that much later (a real broker notices a dead
//                      connection only after 1.5 x keepalive, often after the client has reconnected)
//   b.kill()           drop every client connection (a broker hiccup; their wills go out)
//   b.stop()           shut down
// split: send every packet in two WebSocket frames (clients must put packets back together)
import { WebSocketServer } from 'ws';

const enc = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const len = (n) => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Buffer.from(o); };
const pkt = (h, body) => Buffer.concat([Buffer.from([h]), len(body.length), body]);
const isWild = (f) => /[+#]/.test(f);

/** MQTT filter matching, written separately from the client's (public/js/net/mqtt.js) on purpose. */
function matches(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return t.length === f.length;
}

export async function startBroker(opts = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port || 0, handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
  await new Promise((r) => wss.once('listening', r));
  const subs = new Map(); // exact topic -> Set(client)
  const wild = new Map(); // filter with + or # -> Set(client)
  const retained = new Map(); // topic -> payload
  const clients = new Set();
  const B = {
    url: `ws://127.0.0.1:${wss.address().port}/mqtt`,
    published: 0,
    connects: 0,
    retained,
    clients: () => [...clients].filter((c) => c.ok).map((c) => ({ id: c.id, will: c.will })),
    drop(match, { lateWillMs = 0 } = {}) {
      for (const c of clients) {
        if (typeof match === 'function' ? match(c) : c.id === match) { c.lateWillMs = lateWillMs; c.ws.terminate(); }
      }
    },
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
  /** A message to everyone subscribed (once each, however many of their filters match). */
  const deliver = (topic, payload, retain) => {
    if (retain) {
      // an empty retained message deletes the kept one (and still goes to current subscribers)
      if (payload.length) retained.set(topic, Buffer.from(payload)); else retained.delete(topic);
    }
    const to = new Set(subs.get(topic) || []);
    for (const [f, set] of wild) if (matches(f, topic)) for (const c of set) to.add(c);
    if (!to.size) return;
    // the retain flag is only for messages sent because of a new subscription
    const msg = pkt(0x30, Buffer.concat([enc(topic), payload]));
    for (const c of to) out(c, msg);
  };
  wss.on('connection', (ws) => {
    const c = { ws, topics: new Set(), ok: false, rx: Buffer.alloc(0), id: '', will: null, gone: false };
    clients.add(c);
    const bye = () => {
      if (c.gone) return;
      c.gone = true;
      clients.delete(c);
      for (const t of c.topics) {
        const m = isWild(t) ? wild : subs;
        const set = m.get(t);
        if (set) { set.delete(c); if (!set.size) m.delete(t); }
      }
      // gone without a DISCONNECT: the broker speaks the client's will
      const w = c.will;
      c.will = null;
      if (c.ok && w) {
        if (c.lateWillMs) setTimeout(() => deliver(w.topic, w.payload, w.retain), c.lateWillMs);
        else deliver(w.topic, w.payload, w.retain);
      }
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
      // CONNECT: protocol name, level, flags, keepalive, client id, [will topic, will message], [user], [pass]
      let o = 2 + body.readUInt16BE(0);
      const level = body[o++], flags = body[o++];
      o += 2;
      const bin = () => { const l = body.readUInt16BE(o); const s = body.subarray(o + 2, o + 2 + l); o += 2 + l; return s; };
      const str = () => bin().toString();
      c.id = str();
      const will = flags & 0x04 ? { topic: str(), payload: Buffer.from(bin()), retain: !!(flags & 0x20) } : null;
      const user = flags & 0x80 ? str() : '', pass = flags & 0x40 ? str() : '';
      const good = level === 4 && (!opts.user || (user === opts.user && pass === opts.pass));
      out(c, pkt(0x20, Buffer.from([0, good ? 0 : 4])));
      if (!good) { setTimeout(() => c.ws.close(), 10); return; }
      c.ok = true;
      c.will = will;
      B.connects++;
    } else if (type === 8) {
      // SUBSCRIBE: packet id, then (filter, qos) pairs; every filter granted QoS 0
      const id = body.subarray(0, 2);
      const filters = [];
      for (let o = 2; o + 2 <= body.length;) {
        const l = body.readUInt16BE(o);
        filters.push(body.subarray(o + 2, o + 2 + l).toString());
        o += 3 + l;
      }
      for (const f of filters) {
        const m = isWild(f) ? wild : subs;
        if (!m.has(f)) m.set(f, new Set());
        m.get(f).add(c);
        c.topics.add(f);
      }
      out(c, pkt(0x90, Buffer.concat([id, Buffer.alloc(filters.length)])));
      // then whatever the broker kept that the new filters match, flagged as retained
      for (const [topic, payload] of retained) {
        if (filters.some((f) => f === topic || (isWild(f) && matches(f, topic)))) out(c, pkt(0x31, Buffer.concat([enc(topic), payload])));
      }
    } else if (type === 3) {
      B.published++;
      const l = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + l).toString();
      deliver(topic, body.subarray(2 + l), (head & 1) === 1);
    } else if (type === 12) out(c, Buffer.from([0xd0, 0]));
    else if (type === 14) { c.will = null; c.ws.close(); } // a goodbye: no will
  }
  return B;
}
