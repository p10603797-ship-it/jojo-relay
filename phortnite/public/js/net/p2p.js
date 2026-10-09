// Peer-to-peer parties (no server of our own): one browser hosts the authoritative Room,
// friends connect to it directly over WebRTC data channels. PeerJS's free public service is
// only used to introduce the devices to each other (and as a relay when a direct link fails).
//
// The host keeps its party code (localStorage), so friends' REJOIN still works after a reload. Its
// room clock pauses while the host's page is hidden during a match (an iPad app switch) instead of
// the party ending. Friends wait up to 45 s for a silent host ('Waiting for the host…' after 4 s)
// and get back into the same match after a dropped link (see net.js for the '_net' events).
import { Room } from '../../shared/room.js';
import { TICK_HZ } from '../../shared/constants.js';
import { cleanSettings } from '../../shared/plugins/party.js';
import { PausableClock, RETRY_MS, REJOIN_WINDOW } from './net.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm';
const PREFIX = 'phortnite-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const HOST_CODE_KEY = 'phortnite.hostCode';
export const P2P_MAX_HUMANS = 8; // the host's upload grows with every friend (snapshots to each)
const STALL_MS = 4000;
const SILENT_MS = 45000;

function storedCode() {
  try {
    const c = localStorage.getItem(HOST_CODE_KEY);
    return /^[A-Z]{4}$/.test(c || '') ? c : '';
  } catch (e) { return ''; }
}
function storeCode(c) { try { localStorage.setItem(HOST_CODE_KEY, c); } catch (e) { /* private mode */ } }

let PeerCtor = null;
/** Tests: use this Peer class instead of PeerJS from the CDN. */
export function usePeer(ctor) { PeerCtor = ctor; }
const pageHidden = () => typeof document !== 'undefined' && document.hidden;

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
  constructor(hello, opts = {}) {
    super();
    this.kind = 'p2p-host';
    this.hello = hello;
    this.settings = opts.settings || null;
    this.rtt = 0;
    this.open = false;
    this.code = '';
    this.inbox = [];
    this.links = new Set();
    this.dcById = new Map(); // room connection id -> data channel
    this.closed = false;
    this.clock = new PausableClock();
  }

  async connect() {
    const Peer = await loadPeer();
    let lastErr = null;
    // the same code as last time first, so friends' links and REJOIN keep working
    const first = storedCode();
    for (let tries = 0; tries < 6 && !this.peer && !this.closed; tries++) {
      const code = tries === 0 && first ? first : randomCode();
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
    storeCode(this.code);
    this.room = new Room({
      code: this.code, name: `${this.hello.name || 'Player'}'s party`, now: () => this.clock.now(),
      settings: cleanSettings(this.settings), maxHumans: P2P_MAX_HUMANS,
    });
    // a kicked friend hears it, then the link closes
    this.room.onKick = (cid) => {
      const dc = this.dcById.get(cid);
      if (dc) setTimeout(() => { try { dc.close(); } catch (e) { /* closing */ } }, 300);
    };
    this.local = { id: 'host', ip: 'p2p', send: (m) => this.inbox.push(m) };
    this.room.join(this.local, this.hello);
    this.peer.on('connection', (dc) => this.accept(dc));
    // keep listening for new friends if the introduction service hiccups
    this.peer.on('disconnected', () => { if (this.open) setTimeout(() => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } }, 1000); });
    this.peer.on('error', () => { /* individual link errors are handled per connection */ });
    this.tickTimer = setInterval(() => { if (!this.clock.paused) this.room.tick(); }, 1000 / TICK_HZ);
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
    this.dcById.set(conn.id, dc);
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
      this.dcById.delete(conn.id);
      if (joined) this.room.leave(conn.id);
      joined = false;
    };
    dc.on('close', gone);
    dc.on('error', gone);
  }

  get paused() { return this.clock.paused; }

  /** The host's page is hidden mid-match: the whole party waits (friends see 'Waiting for the host…'). */
  pause() { this.clock.pause(); }

  /** Returns how long the room was paused (ms). */
  resume() {
    const d = this.clock.resume();
    if (d > 1000 && this.room) this.room.broadcast({ t: 'note', msg: 'The host is back — game on!' });
    return d;
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
    // friends hear the party ended (instead of waiting 45 s for a host who is not coming back)
    if (this.room && this.open) this.room.broadcast({ t: 'partyend', msg: `${this.hello.name || 'The host'}'s party ended` });
    this.closed = true;
    this.open = false;
    clearInterval(this.tickTimer);
    clearInterval(this.pumpTimer);
    const links = [...this.links];
    this.links.clear();
    this.dcById.clear();
    // let the goodbye reach them first
    setTimeout(() => {
      for (const dc of links) { try { dc.close(); } catch (e) { /* ignore */ } }
      try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
    }, links.length ? 250 : 0);
  }
}

/** Joins a friend's party by its 4-letter code. */
export class P2PClient extends Emitter {
  constructor(code, hello) {
    super();
    this.kind = 'p2p';
    this.code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    this.hello = hello;
    this.rtt = 0;
    this.open = false;
    this.onClose = null;
    this.closed = false;
    // set once in the party: () => the join message that gets this page back in (resume token, keep)
    this.rejoin = null;
    this.retrying = false;
    this.awaitRejoin = false;
    this.stalled = false;
    this.stallMs = STALL_MS;
    this.silentMs = SILENT_MS;
  }

  async connect() {
    await this.link();
    this.out({ t: 'join', hello: this.hello });
    this.pingTimer = setInterval(() => this.watch(), Math.min(1000, this.stallMs / 2));
    // coming back to the page after a while: allow the host a moment to answer again
    this.onVisible = () => { if (!pageHidden()) this.lastRx = Math.max(this.lastRx, performance.now() - 5000); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  /** Open a peer and a data channel to the host. */
  async link() {
    const Peer = await loadPeer();
    if (this.closed) throw new Error('Cancelled');
    const peer = await openPeer(Peer, null);
    if (this.closed) { try { peer.destroy(); } catch (e) { /* */ } throw new Error('Cancelled'); }
    const dc = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'raw' });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not connect to that party. Make sure the host still has the game open and try again.')), 15000);
        dc.on('open', () => { clearTimeout(timer); resolve(); });
        peer.on('error', (e) => {
          clearTimeout(timer);
          reject(e && e.type === 'peer-unavailable'
            ? Object.assign(new Error(`No party with code ${this.code}. Check the code, and make sure the host still has the game open.`), { type: 'peer-unavailable' })
            : new Error((e && e.message) || 'Connection failed'));
        });
        dc.on('error', (e) => { clearTimeout(timer); reject(new Error((e && e.message) || 'Connection failed')); });
      });
    } catch (e) {
      try { peer.destroy(); } catch (e2) { /* */ }
      throw e;
    }
    if (this.closed) { try { peer.destroy(); } catch (e) { /* */ } throw new Error('Cancelled'); }
    this.peer = peer;
    this.dc = dc;
    this.out = sender(dc);
    this.open = true;
    this.lastRx = performance.now();
    dc.on('data', receiver((msg) => {
      if (this.dc !== dc) return;
      this.lastRx = performance.now();
      if (this.stalled) { this.stalled = false; this.emit({ t: '_net', state: 'online' }); }
      if (msg.t === 'pong' && typeof msg.c === 'number') {
        const rtt = performance.now() - msg.c;
        this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
      }
      if (msg.t === 'partyend' || msg.t === 'kicked') this.rejoin = null; // nothing to come back to
      if (this.awaitRejoin) {
        if (msg.t === 'resumed') this.awaitRejoin = false;
        else if (msg.t === 'welcome') { this.awaitRejoin = false; this.emit({ t: '_net', state: 'fresh', msg }); return; }
        else if (msg.t === 'err') { this.giveUp(msg); return; }
      }
      this.emit(msg);
    }));
    dc.on('close', () => { if (this.dc === dc) this.lost(); });
  }

  /** Once a second: ping, notice a silent host. */
  watch() {
    if (!this.open || this.retrying) return;
    const quiet = performance.now() - this.lastRx;
    // a host whose iPad went to sleep may never close the link
    if (quiet > this.silentMs && !pageHidden()) { this.lost(); return; }
    if (quiet > this.stallMs && !this.stalled && !pageHidden()) { this.stalled = true; this.emit({ t: '_net', state: 'stall' }); }
    this.pingN = (this.pingN || 0) + 1;
    if (this.pingN % 2 === 0) this.send({ t: 'ping', c: performance.now() });
  }

  /** The link dropped or went silent: get back into the party (same player) or give up. */
  lost() {
    if (!this.open || this.closed) return;
    this.open = false;
    this.stalled = false;
    try { this.dc && this.dc.close(); } catch (e) { /* */ }
    try { this.peer && this.peer.destroy(); } catch (e) { /* */ }
    this.dc = null;
    this.peer = null;
    if (this.rejoin) this.reconnect();
    else this.giveUp(null);
  }

  async reconnect() {
    if (this.retrying) return;
    this.retrying = true;
    this.emit({ t: '_net', state: 'reconnecting' });
    const t0 = performance.now();
    for (let i = 0; !this.closed && performance.now() - t0 < REJOIN_WINDOW; i++) {
      await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(i, RETRY_MS.length - 1)]));
      if (this.closed || !this.rejoin) break;
      try {
        await this.link();
        this.retrying = false;
        this.awaitRejoin = true;
        this.out(this.rejoin());
        this.emit({ t: '_net', state: 'online' });
        return;
      } catch (e) {
        if (e && e.type === 'peer-unavailable' && performance.now() - t0 > 15000) break; // the host is gone
      }
    }
    this.retrying = false;
    if (!this.closed) this.giveUp(null);
  }

  giveUp(msg) {
    const cb = this.onClose;
    this.emit({ t: '_net', state: 'lost', msg });
    this.close(false);
    if (cb) cb(msg);
  }

  send(msg) {
    if (this.out && this.open) this.out(msg);
  }

  /** Leave for good. bye tells the host it is on purpose (no 60 s hold for a rejoin). */
  close(bye = true) {
    if (bye && this.open && !this.closed) this.send({ t: 'bye' });
    this.closed = true;
    this.onClose = null;
    this.open = false;
    clearInterval(this.pingTimer);
    if (this.onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    const dc = this.dc, peer = this.peer;
    // a moment for the bye to leave
    setTimeout(() => {
      try { dc && dc.close(); } catch (e) { /* ignore */ }
      try { peer && peer.destroy(); } catch (e) { /* ignore */ }
    }, bye ? 150 : 0);
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
