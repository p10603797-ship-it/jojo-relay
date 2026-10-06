// Peer-to-peer parties (no server of our own): one browser hosts the authoritative Room,
// friends connect to it directly over WebRTC data channels. PeerJS's free public service is
// only used to introduce the devices to each other (and as a relay when a direct link fails).
import { Room } from '../../shared/room.js';
import { TICK_HZ } from '../../shared/constants.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm';
const PREFIX = 'phortnite-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

let PeerCtor = null;
async function loadPeer() {
  if (PeerCtor) return PeerCtor;
  let m;
  try {
    m = await import(PEERJS_URL);
  } catch (e) {
    throw new Error('Could not load the online party service. Check that this device is connected to the internet.');
  }
  PeerCtor = m.Peer || (m.default && (m.default.Peer || m.default));
  return PeerCtor;
}

function randomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

/** Optional self-hosted signalling server for testing: ?peerserver=host:port/path */
function peerOptions() {
  const opts = { debug: 0 };
  try {
    const s = new URLSearchParams(location.search).get('peerserver');
    const m = s && /^([\w.-]+):(\d+)(\/.*)?$/.exec(s);
    if (m) Object.assign(opts, { host: m[1], port: +m[2], path: m[3] || '/', secure: location.protocol === 'https:' });
  } catch (e) { /* default public service */ }
  return opts;
}

function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const opts = peerOptions();
    const peer = id ? new Peer(id, opts) : new Peer(opts);
    const timer = setTimeout(() => {
      peer.destroy();
      reject(Object.assign(new Error('The online party service did not answer. Try again in a moment.'), { type: 'timeout' }));
    }, 12000);
    peer.once('open', () => { clearTimeout(timer); resolve(peer); });
    peer.once('error', (e) => { clearTimeout(timer); peer.destroy(); reject(e); });
  });
}

// Messages travel as JSON text. Data channels only promise delivery of messages up to ~16 KB
// on every browser, so bigger ones (the match start, mid-match joins) are split into pieces.
const CHUNK = 5000; // characters; at most 3 bytes each in UTF-8

function sender(dc) {
  let seq = 0;
  return (msg) => {
    if (!dc.open) return;
    const s = JSON.stringify(msg);
    try {
      if (s.length <= CHUNK) { dc.send(s); return; }
      const cuts = [0];
      while (cuts[cuts.length - 1] < s.length) {
        let end = Math.min(s.length, cuts[cuts.length - 1] + CHUNK);
        // never split a surrogate pair (emoji in names)
        if (end < s.length && (s.charCodeAt(end) & 0xfc00) === 0xdc00) end--;
        cuts.push(end);
      }
      const id = (seq = (seq + 1) % 1e6).toString(36);
      const n = cuts.length - 1;
      for (let i = 0; i < n; i++) dc.send(`~${id}|${i}|${n}|${s.slice(cuts[i], cuts[i + 1])}`);
    } catch (e) { /* channel closing */ }
  };
}

function receiver(onMsg) {
  const parts = new Map();
  return (data) => {
    if (typeof data !== 'string') return;
    if (data[0] === '~') {
      const a = data.indexOf('|'), b = data.indexOf('|', a + 1), c = data.indexOf('|', b + 1);
      if (a < 0 || b < 0 || c < 0) return;
      const id = data.slice(1, a), i = +data.slice(a + 1, b), n = +data.slice(b + 1, c);
      if (!(Number.isInteger(i) && Number.isInteger(n) && n > 1 && n <= 400 && i >= 0 && i < n)) return;
      let p = parts.get(id);
      if (!p) {
        if (parts.size > 8) parts.clear();
        p = { n, got: 0, list: [] };
        parts.set(id, p);
      }
      if (p.n !== n || p.list[i] !== undefined) return;
      p.list[i] = data.slice(c + 1);
      if (++p.got < n) return;
      parts.delete(id);
      data = p.list.join('');
    }
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg && typeof msg === 'object' && typeof msg.t === 'string') onMsg(msg);
  };
}

class Emitter {
  constructor() { this.handlers = new Set(); }
  onMessage(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  emit(msg) { for (const h of this.handlers) h(msg); }
}

/** Hosts a party: runs the Room locally and accepts friends' connections. */
export class P2PHost extends Emitter {
  constructor(hello) {
    super();
    this.hello = hello;
    this.rtt = 0;
    this.open = false;
    this.code = '';
    this.inbox = [];
    this.links = new Set();
    this.closed = false;
  }

  async connect() {
    const Peer = await loadPeer();
    let lastErr = null;
    for (let tries = 0; tries < 6 && !this.peer && !this.closed; tries++) {
      const code = randomCode();
      try {
        this.peer = await openPeer(Peer, PREFIX + code);
        this.code = code;
      } catch (e) {
        lastErr = e;
        if (e.type !== 'unavailable-id') break;
      }
    }
    if (this.closed) { this.close(); throw new Error('Cancelled'); }
    if (!this.peer) throw new Error(lastErr && lastErr.message ? lastErr.message : 'Could not create a party.');
    this.room = new Room({ code: this.code, name: `${this.hello.name || 'Player'}'s party`, now: () => performance.now() });
    this.local = { id: 'host', ip: 'p2p', send: (m) => this.inbox.push(m) };
    this.room.join(this.local, this.hello);
    this.peer.on('connection', (dc) => this.accept(dc));
    // keep listening for new friends if the introduction service hiccups
    this.peer.on('disconnected', () => { if (this.open) setTimeout(() => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } }, 1000); });
    this.peer.on('error', () => { /* individual link errors are handled per connection */ });
    this.tickTimer = setInterval(() => this.room.tick(), 1000 / TICK_HZ);
    this.pumpTimer = setInterval(() => this.flush(), 4);
    this.open = true;
  }

  accept(dc) {
    let joined = false;
    const conn = {
      id: `p${Math.random().toString(36).slice(2, 10)}`,
      ip: 'p2p',
      send: sender(dc),
    };
    this.links.add(dc);
    dc.on('data', receiver((msg) => {
      if (msg.t === 'join') {
        if (!joined) joined = this.room.join(conn, msg.hello && typeof msg.hello === 'object' ? msg.hello : {});
        // turned away (full, different version): let the error message reach them, then hang up
        if (!joined) setTimeout(() => { try { dc.close(); } catch (e) { /* closing */ } }, 500);
        return;
      }
      if (joined) this.room.message(conn.id, msg);
    }));
    const gone = () => {
      if (!this.links.has(dc)) return;
      this.links.delete(dc);
      if (joined) this.room.leave(conn.id);
      joined = false;
    };
    dc.on('close', gone);
    dc.on('error', gone);
  }

  flush() {
    if (!this.inbox.length) return;
    const list = this.inbox;
    this.inbox = [];
    for (const m of list) this.emit(m);
  }

  send(msg) {
    this.room.message('host', JSON.parse(JSON.stringify(msg)));
  }

  close() {
    this.closed = true;
    this.open = false;
    clearInterval(this.tickTimer);
    clearInterval(this.pumpTimer);
    for (const dc of this.links) { try { dc.close(); } catch (e) { /* ignore */ } }
    this.links.clear();
    try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
  }
}

/** Joins a friend's party by its 4-letter code. */
export class P2PClient extends Emitter {
  constructor(code, hello) {
    super();
    this.code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    this.hello = hello;
    this.rtt = 0;
    this.open = false;
    this.onClose = null;
    this.closed = false;
  }

  async connect() {
    const Peer = await loadPeer();
    if (this.closed) throw new Error('Cancelled');
    this.peer = await openPeer(Peer, null);
    if (this.closed) { this.close(); throw new Error('Cancelled'); }
    const dc = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'raw' });
    this.dc = dc;
    this.out = sender(dc);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not connect to that party. Make sure the host still has the game open and try again.')), 15000);
      dc.on('open', () => { clearTimeout(timer); resolve(); });
      this.peer.on('error', (e) => {
        clearTimeout(timer);
        reject(e && e.type === 'peer-unavailable'
          ? new Error(`No party with code ${this.code}. Check the code, and make sure the host still has the game open.`)
          : new Error((e && e.message) || 'Connection failed'));
      });
      dc.on('error', (e) => { clearTimeout(timer); reject(new Error((e && e.message) || 'Connection failed')); });
    });
    if (this.closed) { this.close(); throw new Error('Cancelled'); }
    this.open = true;
    this.lastRx = performance.now();
    dc.on('data', receiver((msg) => {
      this.lastRx = performance.now();
      if (msg.t === 'pong' && typeof msg.c === 'number') {
        const rtt = performance.now() - msg.c;
        this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
      }
      this.emit(msg);
    }));
    dc.on('close', () => this.lost());
    this.out({ t: 'join', hello: this.hello });
    this.pingTimer = setInterval(() => {
      // a host whose iPad went to sleep may never close the link: give up after 15 s of silence
      if (performance.now() - this.lastRx > 15000 && !document.hidden) { this.lost(); return; }
      this.send({ t: 'ping', c: performance.now() });
    }, 2000);
    // coming back to the page after a while: allow the host a moment to answer again
    this.onVisible = () => { if (!document.hidden) this.lastRx = Math.max(this.lastRx, performance.now() - 5000); };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  lost() {
    if (!this.open) return;
    const cb = this.onClose;
    this.close();
    if (cb) cb();
  }

  send(msg) {
    if (this.out) this.out(msg);
  }

  close() {
    this.closed = true;
    this.onClose = null;
    this.open = false;
    clearInterval(this.pingTimer);
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    try { this.dc && this.dc.close(); } catch (e) { /* ignore */ }
    try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
  }
}

/** A QR code (data URL) for a link, drawn with a small library from the CDN. */
export async function qrDataUrl(text) {
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
    const QR = m.default || m;
    return await QR.toDataURL(text, { margin: 1, width: 240 });
  } catch (e) {
    return '';
  }
}

export { sender as frameSender, receiver as frameReceiver };
