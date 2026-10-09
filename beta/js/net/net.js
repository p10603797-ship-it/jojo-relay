// Network transports. WsNet talks to the Phortnite server; LocalNet runs the authoritative
// Room inside the page for solo games (a party of one). Both expose the same API.
//
// Transport events reach the game as local messages {t: '_net', state, msg?} (never from a room):
//   'reconnecting'  the connection dropped: getting back into the party (for up to 45 s)
//   'online'        connected again (the party's 'resumed' follows)
//   'stall'         nothing heard for a few seconds (P2P: the host's iPad may be asleep)
//   'fresh'         connected again, but the party had let us go: msg is a brand-new welcome
//   'lost'          gave up (msg: the party's error, if any); onClose follows
import { Room } from '../../shared/room.js';
import { TICK_HZ } from '../../shared/constants.js';

/**
 * A room clock that can stop: solo and P2P-host rooms pause while the page is hidden (an iPad app
 * switch), so the bus, the storm and every timer wait for the player instead of running on.
 */
export class PausableClock {
  constructor(base = () => performance.now()) {
    this.base = base;
    this.off = 0;
    this.at = -1;
  }

  now() { return (this.at >= 0 ? this.at : this.base()) - this.off; }

  get paused() { return this.at >= 0; }

  pause() { if (this.at < 0) this.at = this.base(); }

  /** Resume; returns how long it was paused (ms). */
  resume() {
    if (this.at < 0) return 0;
    const d = this.base() - this.at;
    this.off += d;
    this.at = -1;
    return d;
  }
}

class Emitter {
  constructor() { this.handlers = new Set(); this.queue = []; }
  onMessage(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  emit(msg) { for (const h of this.handlers) h(msg); }
}

export const RETRY_MS = [500, 1000, 2000, 4000, 8000];
export const REJOIN_WINDOW = 45000;

export class WsNet extends Emitter {
  constructor(url) {
    super();
    this.kind = 'server';
    this.url = url;
    this.ws = null;
    this.open = false;
    this.rtt = 0;
    this.onClose = null;
    // set once in a party: () => the join message that gets this page back in (resume token, keep)
    this.rejoin = null;
    this.closed = false;
    this.retrying = false;
    this.awaitRejoin = false;
  }

  connect() {
    return this.dial().then((ws) => { this.attach(ws); });
  }

  /** Open a socket (rejects after 6 s or on an error). */
  dial() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      const fail = (msg) => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error(msg)); } };
      const timer = setTimeout(() => { fail('Connection timed out'); try { ws.close(); } catch (e) { /* */ } }, 6000);
      ws.onopen = () => { clearTimeout(timer); if (!settled) { settled = true; resolve(ws); } };
      ws.onerror = () => fail('Could not reach the Phortnite server');
      ws.onclose = () => fail('Could not reach the Phortnite server');
    });
  }

  attach(ws) {
    this.ws = ws;
    this.open = true;
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'pong') {
        const rtt = performance.now() - msg.c;
        this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
      }
      if (this.awaitRejoin) {
        if (msg.t === 'resumed') this.awaitRejoin = false;
        else if (msg.t === 'welcome') {
          // the party had already let us go: the app starts over with this welcome
          this.awaitRejoin = false;
          this.emit({ t: '_net', state: 'fresh', msg });
          return;
        } else if (msg.t === 'err') { this.giveUp(msg); return; }
      }
      this.emit(msg);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.open = false;
      clearInterval(this.pingTimer);
      if (this.closed) return;
      if (this.rejoin) this.reconnect();
      else if (this.onClose) this.onClose();
    };
  }

  /** The socket dropped while in a party: dial again (0.5, 1, 2, 4, 8, 8… s) for up to 45 s. */
  async reconnect() {
    if (this.retrying) return;
    this.retrying = true;
    this.emit({ t: '_net', state: 'reconnecting' });
    const t0 = performance.now();
    for (let i = 0; !this.closed && performance.now() - t0 < REJOIN_WINDOW; i++) {
      await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(i, RETRY_MS.length - 1)]));
      if (this.closed) break;
      try {
        const ws = await this.dial();
        if (this.closed) { try { ws.close(); } catch (e) { /* */ } break; }
        this.attach(ws);
        this.retrying = false;
        this.awaitRejoin = true;
        this.send(this.rejoin());
        this.emit({ t: '_net', state: 'online' });
        return;
      } catch (e) { /* try again */ }
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
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** Leave for good. bye tells the party it is on purpose (no 60 s hold for a rejoin). */
  close(bye = true) {
    if (bye && !this.closed) this.send({ t: 'bye' });
    this.closed = true;
    this.onClose = null;
    this.open = false;
    clearInterval(this.pingTimer);
    try { this.ws && this.ws.close(); } catch (e) { /* */ }
  }
}

/**
 * Runs a Room locally (solo, a party of one). Messages are delivered asynchronously like a real
 * network. The room clock stops with pause() (page hidden, pause menu open).
 */
export class LocalNet extends Emitter {
  constructor(hello, opts = {}) {
    super();
    this.kind = 'solo';
    this.rtt = 0;
    this.clock = new PausableClock();
    this.room = new Room({ code: 'SOLO', name: 'Solo', solo: true, now: () => this.clock.now(), settings: opts.settings || null });
    this.conn = { id: 'local', ip: 'local', send: (m) => this.inbox.push(m) };
    this.inbox = [];
    this.hello = hello;
    this.open = true;
  }

  connect() {
    this.room.join(this.conn, this.hello);
    this.timer = setInterval(() => { if (!this.clock.paused) this.room.tick(); }, 1000 / TICK_HZ);
    this.pump = setInterval(() => this.flush(), 4);
    return Promise.resolve();
  }

  get paused() { return this.clock.paused; }

  pause() { this.clock.pause(); }

  /** Returns how long the room was paused (ms). */
  resume() { return this.clock.resume(); }

  flush() {
    if (!this.inbox.length) return;
    const list = this.inbox;
    this.inbox = [];
    for (const m of list) this.emit(m);
  }

  send(msg) {
    // structured clone semantics like the real network
    this.room.message('local', JSON.parse(JSON.stringify(msg)));
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.pump);
    this.open = false;
  }
}
