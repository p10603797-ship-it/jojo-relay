// A tiny MQTT 3.1.1 client over WebSocket (QoS 0, clean sessions): just enough to pass party
// messages through a public broker when two devices can't open a direct link (see relay.js).
const enc = new TextEncoder();
const dec = new TextDecoder();

let WS = null;
/** Tests: use this WebSocket class instead of the browser's. */
export function useWebSocket(ctor) { WS = ctor; }

const PINGREQ = Uint8Array.of(0xc0, 0);
const DISCONNECT = Uint8Array.of(0xe0, 0);
const TICK_MS = 2000;
const ANSWER_MS = 8000; // a ping not answered in this long: the connection is dead
const MAX_BUFFERED = 2e6; // bytes waiting to leave: the connection is stuck

function utf8(s) {
  const b = enc.encode(s);
  const o = new Uint8Array(2 + b.length);
  o[0] = b.length >> 8;
  o[1] = b.length & 255;
  o.set(b, 2);
  return o;
}

function packet(head, parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const len = [];
  let x = n;
  do {
    let d = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) d |= 128;
    len.push(d);
  } while (x > 0);
  const out = new Uint8Array(1 + len.length + n);
  out[0] = head;
  out.set(len, 1);
  let o = 1 + len.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class Mqtt {
  /** server: { url, user?, pass? } */
  constructor(server, opts = {}) {
    this.server = server;
    this.keepalive = opts.keepalive || 20; // seconds
    this.id = opts.clientId || `phx${Math.random().toString(36).slice(2, 12)}`;
    this.subs = new Map(); // topic -> fn(text)
    this.acks = new Map(); // packet id -> fn(ok)
    this.pid = 0;
    this.rx = new Uint8Array(0);
    this.open = false;
    this.dead = false;
    this.onClose = null;
    this.onConnack = null;
  }

  /** Resolves once the broker lets us in; rejects on any failure or after ms. */
  connect(ms = 7000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this.abort = null;
        clearTimeout(timer);
        if (err) { this.teardown(); reject(err); } else resolve(this);
      };
      this.abort = done;
      const timer = setTimeout(() => done(new Error('The relay did not answer')), ms);
      let ws;
      try {
        ws = new (WS || globalThis.WebSocket)(this.server.url, ['mqtt']);
      } catch (e) { done(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.onConnack = (rc) => {
        if (rc !== 0) { done(new Error(`The relay refused us (${rc})`)); return; }
        this.open = true;
        this.lastRx = this.lastTick = this.lastPing = Date.now();
        this.timer = setInterval(() => this.tick(), TICK_MS);
        done();
      };
      ws.onopen = () => {
        const u = this.server.user, p = this.server.pass;
        const flags = 0x02 | (u ? 0x80 : 0) | (u && p ? 0x40 : 0); // clean session
        const parts = [utf8('MQTT'), Uint8Array.of(4, flags, this.keepalive >> 8, this.keepalive & 255), utf8(this.id)];
        if (u) parts.push(utf8(u));
        if (u && p) parts.push(utf8(p));
        this.raw(packet(0x10, parts));
      };
      ws.onmessage = (e) => this.data(e.data);
      ws.onerror = () => done(new Error('Could not reach the relay'));
      ws.onclose = () => { done(new Error('Could not reach the relay')); this.teardown(); };
    });
  }

  raw(buf) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    if (ws.bufferedAmount > MAX_BUFFERED) { this.teardown(); return false; }
    try { ws.send(buf); return true; } catch (e) { this.teardown(); return false; }
  }

  data(d) {
    const b = bytes(d);
    if (!b) return;
    this.lastRx = Date.now();
    let rx = b;
    if (this.rx.length) {
      rx = new Uint8Array(this.rx.length + b.length);
      rx.set(this.rx);
      rx.set(b, this.rx.length);
    }
    let o = 0;
    while (rx.length - o >= 2) {
      let len = 0, mult = 1, i = o + 1, byte;
      do {
        if (i >= rx.length) { byte = -1; break; }
        byte = rx[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128 && mult <= 128 ** 3);
      if (byte < 0 || rx.length < i + len) break;
      if (byte & 128) { this.teardown(); return; } // not MQTT
      this.handle(rx[o], rx.subarray(i, i + len));
      if (this.dead) return;
      o = i + len;
    }
    this.rx = o >= rx.length ? new Uint8Array(0) : rx.slice(o);
  }

  handle(head, body) {
    const type = head >> 4;
    if (type === 2) {
      if (this.onConnack) this.onConnack(body[1]);
    } else if (type === 3) {
      const qos = (head >> 1) & 3;
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      let off = 2 + tl;
      if (qos > 0) {
        if (qos === 1) this.raw(Uint8Array.of(0x40, 2, body[off], body[off + 1])); // PUBACK
        off += 2;
      }
      const fn = this.subs.get(topic);
      if (fn) fn(dec.decode(body.subarray(off)));
    } else if (type === 9) {
      const fn = this.acks.get((body[0] << 8) | body[1]);
      if (fn) fn(body[2] !== 0x80);
    }
    // PINGRESP and anything else: lastRx already moved on
  }

  /** Subscribe (QoS 0); fn(text) hears every message on the topic. */
  subscribe(topic, fn) {
    this.subs.set(topic, fn);
    this.pid = (this.pid % 65535) + 1;
    const id = this.pid;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.acks.delete(id); reject(new Error('The relay did not answer')); }, 6000);
      this.acks.set(id, (ok) => {
        clearTimeout(t);
        this.acks.delete(id);
        if (ok) resolve(); else reject(new Error('The relay refused the topic'));
      });
      if (!this.raw(packet(0x82, [Uint8Array.of(id >> 8, id & 255), utf8(topic), Uint8Array.of(0)]))) this.acks.get(id)(false);
    });
  }

  publish(topic, text) {
    if (!this.open) return false;
    return this.raw(packet(0x30, [utf8(topic), enc.encode(text)]));
  }

  /** Every 2 s: keep the broker happy, and notice a connection that died while the page slept. */
  tick() {
    const now = Date.now();
    const woke = now - this.lastTick > TICK_MS * 3; // timers were frozen (iPad app switch)
    this.lastTick = now;
    if (this.asked && this.lastRx >= this.asked) this.asked = 0;
    if (this.asked && now - this.asked > ANSWER_MS) { this.teardown(); return; }
    if (woke || now - this.lastPing >= this.keepalive * 500) {
      this.lastPing = now;
      if (!this.asked) this.asked = now;
      this.raw(PINGREQ);
    }
  }

  teardown() {
    if (this.dead) return;
    this.dead = true;
    this.open = false;
    clearInterval(this.timer);
    if (this.abort) this.abort(new Error('Closed'));
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => {}; // closing a socket that is still connecting reports an error
      try { ws.close(); } catch (e) { /* closing */ }
    }
    for (const fn of [...this.acks.values()]) fn(false);
    this.acks.clear();
    this.subs.clear();
    const cb = this.onClose;
    this.onClose = null;
    if (cb) cb();
  }

  close() {
    if (this.open) this.raw(DISCONNECT);
    this.onClose = null;
    this.teardown();
  }
}
