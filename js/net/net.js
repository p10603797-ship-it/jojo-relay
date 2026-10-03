// Network transports. WsNet talks to the Phortnite server; LocalNet runs the authoritative
// Room inside the page for solo games. Both expose the same API.
import { Room } from '../../shared/room.js';
import { TICK_HZ } from '../../shared/constants.js';

class Emitter {
  constructor() { this.handlers = new Set(); this.queue = []; }
  onMessage(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  emit(msg) { for (const h of this.handlers) h(msg); }
}

export class WsNet extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.open = false;
    this.rtt = 0;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Connection timed out')); try { ws.close(); } catch (e) { /* */ } } }, 6000);
      ws.onopen = () => {
        this.open = true;
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(); }
        this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'pong') {
          const rtt = performance.now() - msg.c;
          this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
        }
        this.emit(msg);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('Could not reach the Phortnite server')); }
      };
      ws.onclose = () => {
        this.open = false;
        clearInterval(this.pingTimer);
        if (this.onClose) this.onClose();
      };
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.onClose = null;
    clearInterval(this.pingTimer);
    try { this.ws && this.ws.close(); } catch (e) { /* */ }
  }
}

/** Runs a Room locally. Messages are delivered asynchronously like a real network. */
export class LocalNet extends Emitter {
  constructor(hello) {
    super();
    this.rtt = 0;
    this.room = new Room({ code: 'SOLO', name: 'Solo', solo: true, now: () => performance.now() });
    this.conn = { id: 'local', ip: 'local', send: (m) => this.inbox.push(m) };
    this.inbox = [];
    this.hello = hello;
    this.open = true;
  }

  connect() {
    this.room.join(this.conn, this.hello);
    this.timer = setInterval(() => this.room.tick(), 1000 / TICK_HZ);
    this.pump = setInterval(() => this.flush(), 4);
    return Promise.resolve();
  }

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
