// Relay links for P2P parties. Some Wi-Fi never lets two devices link up directly over WebRTC
// (networks that keep devices apart, routers without hairpin NAT, iPads hiding their local
// address, school firewalls), and PeerJS's free relay servers are gone. Then party messages
// travel through free public MQTT brokers instead, over a normal secure WebSocket.
//
// The host listens on every broker it can reach. A friend knocks on each one, and the first
// broker the host answers on carries the link. A link looks like a PeerJS data channel to
// p2p.js: open, send(text), close(), on('data' | 'close' | 'error', fn).
//
// Wire format: every MQTT message is <link id: 10 chars><kind: 1 char><body>.
//   friend -> host  (topic <base>/h):        k knock, d data, x close
//   host -> friend  (topic <base>/c/<link>): a answer, d data, x close
// d bodies are text frames joined by '\n' (JSON text never holds a raw line break). Public brokers
// allow about 100 messages a second from one network (both iPads on the same Wi-Fi count
// together), so a link sends at most 10 a second, each carrying everything since the last.
import { Mqtt } from './mqtt.js';

export const BROKERS = [
  { url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' }, // port 443: passes strict firewalls
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
];
const BATCH = 16000; // characters per MQTT message
const FLUSH_MS = 100;
const KNOCK_MS = 1500;
const IDLE_MS = 20000; // a friend's link that has been silent this long is gone (they ping every 2 s)
const MAX_LINKS = 32;
const ID_RE = /^[a-z0-9]{10}$/;

let override = null;
/** Tests: relay through these brokers ([] turns the relay off; null goes back to the default). */
export function useBrokers(list) { override = list; }

/** The brokers to use: ?relay=off, or ?relay=ws://host:port/path,... for testing. */
export function brokers() {
  if (override) return override;
  try {
    const s = new URLSearchParams(location.search).get('relay');
    if (s === 'off') return [];
    if (s) {
      return s.split(',').map((u) => {
        const url = new URL(u);
        const b = { url: `${url.protocol}//${url.host}${url.pathname === '/' && !/\/$/.test(u) ? '' : url.pathname}` };
        if (url.username) b.user = decodeURIComponent(url.username);
        if (url.password) b.pass = decodeURIComponent(url.password);
        return b;
      }).filter((b) => /^wss?:$/.test(new URL(b.url).protocol));
    }
  } catch (e) { /* the default brokers */ }
  return BROKERS;
}

/** The party's topic: a hash, so the code is not on show on the public brokers. */
export function topicFor(code) {
  const s = `phortnite-party-v1:${code}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `phortnite/p1/${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function linkId() {
  let s = '';
  while (s.length < 10) s += Math.random().toString(36).slice(2);
  return s.slice(0, 10);
}

/** One end of a relayed link (looks like a PeerJS data channel). */
export class RelayLink {
  constructor(mqtt, out, id) {
    this.mqtt = mqtt;
    this.out = out;
    this.id = id;
    this.relay = true;
    this.open = true;
    this.h = {};
    this.q = [];
    this.qn = 0;
    this.queued = false;
    this.flushTimer = 0;
    this.lastFlush = 0;
    this.lastRx = Date.now();
    this.heardData = false;
    this.onDrop = null;
  }

  on(ev, fn) { (this.h[ev] || (this.h[ev] = [])).push(fn); }

  fire(ev, a) {
    for (const fn of [...(this.h[ev] || [])]) {
      try { fn(a); } catch (e) { console.error('relay', ev, e); }
    }
  }

  say(kind, body) { return this.mqtt.publish(this.out, this.id + kind + body); }

  send(text) {
    if (!this.open) return;
    this.q.push(text);
    this.qn += text.length + 1;
    if (this.qn >= BATCH) this.flush();
    else if (!this.queued) {
      // right away after a quiet spell, else with whatever else comes in the next moment
      this.queued = true;
      this.flushTimer = setTimeout(() => this.flush(), Math.max(0, this.lastFlush + FLUSH_MS - Date.now()));
    }
  }

  flush() {
    this.queued = false;
    clearTimeout(this.flushTimer);
    this.lastFlush = Date.now();
    if (!this.open || !this.q.length) { this.q = []; this.qn = 0; return; }
    let batch = [], n = 0;
    for (const s of this.q) {
      if (batch.length && n + s.length > BATCH) { this.say('d', batch.join('\n')); batch = []; n = 0; }
      batch.push(s);
      n += s.length + 1;
    }
    this.q = [];
    this.qn = 0;
    if (batch.length) this.say('d', batch.join('\n'));
  }

  heard(kind, body) {
    if (!this.open) return;
    this.lastRx = Date.now();
    if (kind === 'd') {
      this.heardData = true;
      for (const f of body.split('\n')) if (f && this.open) this.fire('data', f);
    } else if (kind === 'x') this.drop();
  }

  /** Hang up (the other end hears it). */
  close() {
    if (!this.open) return;
    this.flush();
    this.say('x', '');
    this.drop();
  }

  /** The link is gone (the other end hung up, or the broker connection dropped). */
  drop() {
    if (!this.open) return;
    this.open = false;
    this.q = [];
    clearTimeout(this.flushTimer);
    const cb = this.onDrop;
    this.onDrop = null;
    if (cb) cb();
    this.fire('close');
  }
}

/** The host's side: stays connected to every broker it can reach while the party is open. */
export class RelayHost {
  constructor(code, onLink) {
    this.base = topicFor(code);
    this.onLink = onLink;
    this.conns = new Set();
    this.links = new Map(); // link id -> RelayLink
    this.closed = false;
    this.waiters = [];
  }

  start() {
    const list = brokers();
    for (const b of list) this.keep(b);
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), 2000);
    return list.length > 0;
  }

  get ready() { return this.conns.size > 0; }

  /** Resolves true once a broker is listening (false after ms). */
  whenReady(ms) {
    if (this.ready) return Promise.resolve(true);
    if (this.closed || !brokers().length) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = (ok) => { clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(false); }, ms);
      this.waiters.push(w);
    });
  }

  async keep(server) {
    let wait = 1000;
    while (!this.closed) {
      const m = new Mqtt(server);
      const lost = new Promise((r) => { m.onClose = r; });
      try {
        await m.connect();
        await m.subscribe(`${this.base}/h`, (text) => this.rx(m, text));
        if (this.closed) { m.close(); return; }
        this.conns.add(m);
        wait = 1000;
        for (const w of this.waiters.splice(0)) w(true);
        await lost;
      } catch (e) {
        m.close();
      }
      this.conns.delete(m);
      for (const link of [...this.links.values()]) if (link.mqtt === m) link.drop();
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, wait * (0.75 + Math.random() * 0.5)));
      wait = Math.min(wait * 2, 30000);
    }
  }

  rx(m, text) {
    if (this.closed) return;
    const id = text.slice(0, 10), kind = text[10];
    if (!ID_RE.test(id)) return;
    const link = this.links.get(id);
    if (kind === 'k') {
      if (link) {
        // a knock repeated: answer again on the broker the link uses (knocks on others go unanswered)
        if (link.mqtt === m && !link.heardData) link.say('a', '');
        return;
      }
      if (this.links.size >= MAX_LINKS) return;
      const nl = new RelayLink(m, `${this.base}/c/${id}`, id);
      nl.onDrop = () => { if (this.links.get(id) === nl) this.links.delete(id); };
      this.links.set(id, nl);
      nl.say('a', '');
      this.onLink(nl);
      return;
    }
    if (link && link.mqtt === m) link.heard(kind, text.slice(11));
    else if (!link && kind === 'd') m.publish(`${this.base}/c/${id}`, `${id}x`); // a link from before a reload: hang up so they knock again
  }

  /** Drop links that went silent. After the page slept (timers frozen) everyone gets a fresh start. */
  tick() {
    const now = Date.now();
    const woke = now - this.lastTick > 6000;
    this.lastTick = now;
    for (const link of [...this.links.values()]) {
      if (woke) link.lastRx = now;
      else if (now - link.lastRx > IDLE_MS) link.close();
    }
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const link of [...this.links.values()]) link.close();
    this.links.clear();
    for (const w of this.waiters.splice(0)) w(false);
    // a moment for the goodbyes to leave
    const conns = [...this.conns];
    this.conns.clear();
    setTimeout(() => { for (const m of conns) m.close(); }, 200);
  }
}

/**
 * A friend's side: reach the host of this party through any broker. Resolves with an open
 * RelayLink. Rejects with type 'relay-offline' (no broker reachable from here) or 'relay-nohost'
 * (brokers reached, but no host answered).
 */
export function relayDial(code, ms = 9000) {
  const base = topicFor(code);
  const id = linkId();
  const list = brokers();
  return new Promise((resolve, reject) => {
    const conns = new Set();
    const timers = [];
    let done = false, reached = 0, failed = 0, link = null;
    const finish = (err, winner) => {
      if (done) return;
      done = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      for (const m of conns) if (!winner || m !== winner.mqtt) m.close();
      if (err) reject(err); else resolve(winner);
    };
    const fail = (type) => finish(Object.assign(new Error(type === 'relay-offline' ? 'Could not reach a relay' : 'No host answered on the relay'), { type }));
    if (!list.length) { fail('relay-offline'); return; }
    timers.push(setTimeout(() => fail(reached ? 'relay-nohost' : 'relay-offline'), ms));
    for (const server of list) {
      const m = new Mqtt(server);
      conns.add(m);
      m.connect()
        .then(() => m.subscribe(`${base}/c/${id}`, (text) => {
          if (text.slice(0, 10) !== id) return;
          if (link) { if (link.mqtt === m) link.heard(text[10], text.slice(11)); return; }
          if (done || text[10] !== 'a') return;
          link = new RelayLink(m, `${base}/h`, id);
          m.onClose = () => link.drop();
          finish(null, link);
        }))
        .then(() => {
          if (done) return;
          reached++;
          const knock = () => { if (!done) m.publish(`${base}/h`, `${id}k`); };
          knock();
          timers.push(setInterval(knock, KNOCK_MS));
        })
        .catch(() => {
          conns.delete(m);
          m.close();
          if (++failed === list.length) fail('relay-offline');
        });
    }
  });
}
