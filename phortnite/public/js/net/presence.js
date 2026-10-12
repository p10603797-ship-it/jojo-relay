// The live player count: everyone with Phortnite open, anywhere, with no server of our own.
// It rides on the free public MQTT brokers that party relay links use (relay.js), on a
// connection of its own: every page keeps one small retained message there,
//   topic phortnite/presence/v1/<id>   payload {"s":"l"|"m","t":<unix seconds>}   (m: in a match)
// and listens to everyone else's ('phortnite/presence/v1/+'). New pages get everyone at once (the
// broker hands retained messages to new subscribers). A page that leaves deletes its message (an
// empty retained one); one that vanishes (a crash, the Wi-Fi gone, an iPad asleep) has the broker
// do it for it (its Last Will). Each page refreshes its message now and then, so a ghost the
// broker kept by mistake fades out instead of being counted for ever. A will can come late (the
// broker notices a dead connection only after the page has reconnected): a page that hears its
// own message deleted says it again.
//
// The id is random per page load and never stored, and nothing else is sent: no names, no
// tracking. Traffic stays tiny however many play: with N playing everyone refreshes every
// max(2 min, N s), so each page hears about one message a second at most.
import { Mqtt } from './mqtt.js';
import { brokers } from './relay.js';

export const PRESENCE_PREFIX = 'phortnite/presence/v1/';
const FILTER = `${PRESENCE_PREFIX}+`;
const ID_RE = /^[a-z0-9]{1,24}$/;

// timings in ms (tests pass smaller ones)
const DEFAULTS = {
  refreshMs: 120000, // say we're here at least this often…
  perPlayerMs: 1000, // …but no more than once per N s with N playing (±10% so pages don't line up)
  staleMin: 360000, // not heard for 3 refreshes (at least 6 min): gone
  minGapMs: 2000, // between our own messages when we go lobby <-> match
  hideMs: 30000, // off screen this long: leave (a quick app switch keeps you counted)
  tickMs: 2000, // state changes, the sweep
  settleMs: 1500, // after subscribing: the broker's snapshot of everyone comes in
  notifyMs: 500, // onChange at most twice a second
  backoffMs: 1000, // reconnecting: 1 s, 2 s, 4 s … 30 s
  maxBackoffMs: 30000,
  connectMs: 7000,
  homeMs: 300000, // on a fallback broker: try the first one again this often
  clearMs: 86400000, // a ghost this old (a day: further off than any clock) is taken off the broker
  max: 5000, // people kept track of (a broker flooded with junk can't eat the iPad's memory)
  clock: () => Date.now(), // the time sent to and judged against other devices (tests: a wrong one)
};

function newId() {
  let s = '';
  while (s.length < 12) s += Math.random().toString(36).slice(2);
  return s.slice(0, 12);
}

/** A presence message, or null when it isn't one. */
function parse(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) { return null; }
  if (!v || typeof v !== 'object' || (v.s !== 'l' && v.s !== 'm') || !Number.isFinite(v.t)) return null;
  return v;
}

export class Presence {
  /** opts.state() -> 'm' while in a match, else 'l'; plus any of the DEFAULTS timings. */
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.state = typeof opts.state === 'function' ? opts.state : () => 'l';
    this.id = newId();
    this.topic = PRESENCE_PREFIX + this.id;
    this.peers = new Map(); // id -> { s, at: when we last heard (local clock) }
    this.snap = new Map(); // the broker's snapshot while it comes in: id -> { s, t }
    this.fns = [];
    this.m = null; // the broker connection in use
    this.pending = null; // one being made
    this.online = false; // connected, and the snapshot of everyone is in
    this.off = false; // no brokers (?relay=off)
    this.started = false;
    this.stopped = false;
    this.away = false; // off screen for a while, or the page is going away
    this.dialing = false;
    this.settled = false;
    this.mine = 'l'; // what we last told everyone
    this.lastSay = 0;
    this.lastNotify = 0;
    this.shown = '';
    this.wait = this.o.backoffMs;
  }

  /** fn({ total, inMatch, inLobby, online }) whenever those change (at most ~2 a second). */
  onChange(fn) { this.fns.push(fn); }

  /** Go online. False when there are no brokers to use (?relay=off). */
  start() {
    if (this.started) return !this.off;
    this.started = true;
    if (!brokers().length) { this.off = true; return false; }
    this.lastTick = Date.now();
    this.ticker = setInterval(() => this.tick(), this.o.tickMs);
    if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
      this.onVis = () => this.hidden(document.hidden);
      this.onPageHide = () => this.leave();
      this.onPageShow = (e) => { if (e.persisted) this.hidden(!!document.hidden); }; // back from the back/forward cache
      document.addEventListener('visibilitychange', this.onVis);
      addEventListener('pagehide', this.onPageHide);
      addEventListener('pageshow', this.onPageShow);
      if (document.hidden) this.hidden(true);
    }
    this.connect();
    return true;
  }

  /** Leave for good (our entry goes at once). */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.hangUp();
    clearInterval(this.ticker);
    clearTimeout(this.hideTimer);
    clearTimeout(this.notifyTimer);
    if (this.onVis) {
      document.removeEventListener('visibilitychange', this.onVis);
      removeEventListener('pagehide', this.onPageHide);
      removeEventListener('pageshow', this.onPageShow);
    }
  }

  /** Everyone heard, us included: { total, inMatch, inLobby, online }. */
  get counts() {
    let inMatch = this.own() === 'm' ? 1 : 0;
    for (const p of this.peers.values()) if (p.s === 'm') inMatch++;
    const total = this.peers.size + 1;
    return { total, inMatch, inLobby: total - inMatch, online: this.online };
  }

  own() {
    try { return this.state() === 'm' ? 'm' : 'l'; } catch (e) { return 'l'; }
  }

  refreshMs(n) { return Math.max(this.o.refreshMs, this.o.perPlayerMs * n); }

  staleMs(n) { return Math.max(this.o.staleMin, 3 * this.refreshMs(n)); }

  want() { return this.started && !this.stopped && !this.away && !this.off; }

  /** Our clock in unix seconds (other devices' clocks can be off: an iPad whose date was changed). */
  secs() { return Math.floor(this.o.clock() / 1000); }

  // ------------------------------------------------------------------ the connection
  /** Connect if we should be and aren't. */
  connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    if (!this.want() || this.m || this.dialing) return;
    this.dial();
  }

  /** The first broker that lets us in, in order (shiftr.io first: port 443 gets through school firewalls). */
  async dial(list = brokers()) {
    this.dialing = true;
    try {
      for (const server of list) {
        if (!this.want()) return;
        const m = new Mqtt(server, { will: { topic: this.topic, payload: '', retain: true } });
        this.pending = m;
        try {
          await m.connect(this.o.connectMs);
          if (this.pending !== m || !this.want()) throw new Error('not needed any more');
          this.pending = null;
          // back on the first broker from a fallback one: leave the fallback cleanly
          const old = this.m;
          this.m = null;
          this.bye(old);
          this.use(m);
          await m.subscribe(FILTER, (text, topic, retained) => this.heard(m, text, topic, retained));
          if (this.m !== m) return; // dropped (or left) meanwhile
          clearTimeout(this.settleTimer);
          this.settleTimer = setTimeout(() => this.settle(m), this.o.settleMs);
          this.homeward();
          return;
        } catch (e) {
          if (this.pending === m) this.pending = null;
          if (this.m === m) this.dropped(m);
          this.bye(m); // (said hello, then the topic was refused)
        }
      }
      // still on a fallback broker (the first one is still down): try it again later
      if (this.m) { this.homeward(); return; }
      // no broker reachable from here (yet)
      this.setOnline(false);
      this.retry();
    } finally {
      this.dialing = false;
    }
  }

  /**
   * On a fallback broker (the first one was down or slow when we connected): everyone else is most
   * likely on the first one, and brokers don't share messages, so the count would split in two.
   * Try the first one again now and then; dial() moves over when it answers.
   */
  homeward() {
    clearTimeout(this.homeTimer);
    const first = brokers()[0];
    if (!this.m || !first || this.m.server.url === first.url) return;
    this.homeTimer = setTimeout(() => {
      if (this.m && !this.dialing && this.want()) this.dial([first]);
    }, this.o.homeMs * (0.75 + Math.random() * 0.5));
  }

  use(m) {
    this.m = m;
    this.upAt = Date.now();
    m.onClose = () => this.dropped(m);
    this.since = Date.now();
    this.settled = false;
    this.snap.clear();
    this.say();
  }

  /** The connection dropped by itself: try again in a moment. */
  dropped(m) {
    if (this.m !== m) return;
    this.m = null;
    clearTimeout(this.sayTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.homeTimer);
    // a connection that stayed up a good while starts the backoff over
    if (Date.now() - this.upAt > this.o.maxBackoffMs) this.wait = this.o.backoffMs;
    this.setOnline(false);
    if (!this.dialing) this.retry();
  }

  retry() {
    if (!this.want() || this.retryTimer) return;
    const ms = this.wait * (0.75 + Math.random() * 0.5);
    this.wait = Math.min(this.wait * 2, this.o.maxBackoffMs);
    this.retryTimer = setTimeout(() => { this.retryTimer = 0; this.connect(); }, ms);
  }

  /** Say goodbye (our entry is deleted at once) and hang up. */
  hangUp() {
    clearTimeout(this.sayTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.homeTimer);
    this.retryTimer = 0;
    const p = this.pending;
    this.pending = null;
    if (p) p.close(); // still connecting: dial() gives up
    const m = this.m;
    this.m = null;
    this.bye(m);
    this.setOnline(false);
  }

  /** Hang up one connection cleanly (call with this.m no longer pointing at it). */
  bye(m) {
    if (!m) return;
    m.onClose = null;
    // (a clean goodbye means the broker skips our will: delete the entry ourselves)
    if (m.open) m.publish(this.topic, '', { retain: true });
    m.close();
  }

  // ------------------------------------------------------------------ on and off screen
  /** The page went off screen (true) or came back (false). */
  hidden(on) {
    clearTimeout(this.hideTimer);
    if (on) {
      if (!this.away) this.hideTimer = setTimeout(() => this.leave(), this.o.hideMs);
    } else if (this.away) {
      this.away = false;
      this.wait = this.o.backoffMs;
      this.connect();
    }
  }

  /** Off screen for a while, or the page is going away: not playing any more (until we're back). */
  leave() {
    clearTimeout(this.hideTimer);
    this.away = true;
    this.hangUp();
  }

  // ------------------------------------------------------------------ messages
  /** Tell everyone we're here (retained: newcomers hear it too), and when to say it again. */
  say() {
    const m = this.m;
    if (!m || !m.open) return;
    this.mine = this.own();
    this.lastSay = Date.now();
    m.publish(this.topic, JSON.stringify({ s: this.mine, t: this.secs() }), { retain: true });
    clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(() => this.say(), this.refreshMs(this.peers.size + 1) * (0.9 + Math.random() * 0.2));
    this.changed();
  }

  /** Lobby <-> match: tell everyone now (or at the next tick, so a flip-flop can't spam). */
  update() {
    if (!this.m || !this.m.open || this.own() === this.mine) return;
    this.changed();
    if (Date.now() - this.lastSay >= Math.max(this.o.minGapMs, this.o.perPlayerMs * (this.peers.size + 1) / 20)) this.say();
  }

  /**
   * Our own entry was deleted while we're connected: the will of a connection we already gave up
   * on, spoken late (the broker noticed it dead only after we had reconnected), or a newcomer that
   * took us for a ghost. Say it again (no more than once per minGapMs).
   */
  reclaim() {
    const wait = this.lastSay + this.o.minGapMs - Date.now();
    if (wait <= 0) { this.say(); return; }
    clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(() => this.say(), wait);
  }

  heard(m, text, topic, retained) {
    if (m !== this.m || !topic.startsWith(PRESENCE_PREFIX)) return;
    const id = topic.slice(PRESENCE_PREFIX.length);
    if (!ID_RE.test(id)) return;
    if (id === this.id) { // (our own goodbyes go out after this.m has let go, so they never get here)
      if (!text) this.reclaim();
      return;
    }
    if (!text) { // left
      this.snap.delete(id);
      if (this.peers.delete(id)) this.changed();
      return;
    }
    const v = parse(text);
    if (!v) return;
    if (retained) {
      // the broker's snapshot: judged once it is all in (how old is too old depends on how many play)
      if (!this.settled) {
        if (this.snap.size < this.o.max || this.snap.has(id)) this.snap.set(id, v);
        return;
      }
      if (this.tooOld(v.t, this.peers.size + 1)) return;
    }
    this.put(id, v.s);
  }

  /** A retained entry from before the last STALE (k of them): a ghost (its will got lost), not a player. */
  tooOld(t, n) {
    return this.secs() - t > Math.ceil(this.staleMs(n) / 1000);
  }

  put(id, s) {
    const p = this.peers.get(id);
    if (p) {
      p.at = Date.now();
      if (p.s !== s) { p.s = s; this.changed(); }
      return;
    }
    if (this.peers.size >= this.o.max) return;
    this.peers.set(id, { s, at: Date.now() });
    this.changed();
  }

  /** The snapshot is in: count it, and forget whoever left while we weren't listening. */
  settle(m) {
    if (m !== this.m || m.dead) return;
    const ids = new Set(this.snap.keys());
    for (const [id, p] of this.peers) if (p.at >= this.since) ids.add(id);
    const n = ids.size + 1;
    for (const [id, p] of this.peers) if (p.at < this.since && !this.snap.has(id)) this.peers.delete(id);
    const dead = [];
    let fresh = 0;
    for (const [id, v] of this.snap) {
      if (!this.tooOld(v.t, n)) { this.put(id, v.s); fresh++; continue; }
      if (this.peers.has(id) && this.peers.get(id).at < this.since) this.peers.delete(id);
      if (this.secs() - v.t > this.o.clearMs / 1000) dead.push(id);
    }
    // ghosts dead for a day: take them off the broker for everyone, a few at a time. Only when our
    // clock agrees with someone who is playing: on an iPad whose date was changed everyone looks
    // long dead. (A live page cleared by mistake hears it and says it again: see reclaim().)
    if (fresh) for (const id of dead.slice(0, 20)) m.publish(PRESENCE_PREFIX + id, '', { retain: true });
    this.snap.clear();
    this.settled = true;
    this.setOnline(true);
    this.changed();
  }

  /** Every 2 s: our state, and drop whoever stopped refreshing (a ghost the broker kept). */
  tick() {
    const now = Date.now();
    const frozen = now - this.lastTick - this.o.tickMs;
    this.lastTick = now;
    // timers were frozen (an app switch): we heard nothing meanwhile, and that's nobody's fault
    if (frozen > this.o.tickMs * 2) for (const p of this.peers.values()) p.at += frozen;
    this.update();
    if (!this.settled) return;
    const limit = this.staleMs(this.peers.size + 1);
    let gone = false;
    for (const [id, p] of this.peers) if (now - p.at > limit) { this.peers.delete(id); gone = true; }
    if (gone) this.changed();
  }

  // ------------------------------------------------------------------ telling the lobby
  setOnline(on) {
    if (this.online === on) return;
    this.online = on;
    this.changed();
  }

  changed() {
    if (this.notifyTimer || !this.fns.length || this.stopped) return;
    const ms = Math.max(0, this.lastNotify + this.o.notifyMs - Date.now());
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = 0;
      this.lastNotify = Date.now();
      this.emit();
    }, ms);
  }

  emit() {
    // offline until the snapshot is in: the lobby shows nothing rather than flash '1 PLAYING'
    const c = this.counts;
    const key = c.online ? `${c.total}|${c.inMatch}` : 'off';
    if (key === this.shown) return;
    this.shown = key;
    for (const fn of this.fns) {
      try { fn(c); } catch (e) { console.error('presence', e); }
    }
  }
}
