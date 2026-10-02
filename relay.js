/**
 * @file server/relay.js
 * Standalone WebSocket relay for BENEDICT LASO VS JOJO THE DESTROYER.
 *
 * The relay contains ZERO game logic. It owns rooms, six-digit join codes and
 * reconnection slots, and forwards opaque gameplay bytes between the two peers of
 * a room. See docs/ARCHITECTURE.md section 5 for the contract this implements.
 *
 * Wire framing (matches src/js/net/Protocol.js):
 *   byte 0x01 + UTF-8 JSON  -> control message, shaped `{ t: <MSG>, ...fields }`
 *   byte 0x02 + arbitrary   -> opaque gameplay payload, forwarded verbatim
 * A plain WebSocket *text* frame containing JSON is also accepted as a control
 * message; the relay then answers that socket with text frames too, which makes
 * the browser-console smoke test in README.md a one-liner.
 *
 * Runtime dependencies: node >= 18 builtins + the `ws` package. Nothing else.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { handleSideloadRequest } from './sideload.js';

/** Relay build version, reported by `GET /health`. @type {string} */
export const VERSION = '1.0.0';

/** Wire protocol version — must equal `PROTOCOL_VERSION` in src/js/net/Protocol.js. @type {number} */
export const PROTOCOL_VERSION = 1;

/** Message type ids, mirroring `MSG` in src/js/net/Protocol.js. @type {Readonly<Record<string, number>>} */
export const MSG = Object.freeze({
  HELLO: 1, HOSTED: 2, JOIN: 3, JOINED: 4, PEER_JOINED: 5, PEER_LEFT: 6, ERROR: 7,
  LOBBY_STATE: 8, READY: 9, START: 10, PING: 11, PONG: 12, RECONNECT: 13, CHAT: 14,
  INPUT: 20, SNAPSHOT: 21, EVENT: 22, FULL_STATE: 23
});

/** Leading framing byte of every WebSocket binary frame. @type {Readonly<Record<string, number>>} */
export const FRAME = Object.freeze({ CONTROL: 0x01, BINARY: 0x02 });

/** Machine-readable `ERROR` codes sent as `{ t: MSG.ERROR, code, message }`. @type {Readonly<Record<string, string>>} */
export const ERR = Object.freeze({
  BAD_VERSION: 'BAD_VERSION',
  BAD_MESSAGE: 'BAD_MESSAGE',
  BAD_FRAME: 'BAD_FRAME',
  BAD_TOKEN: 'BAD_TOKEN',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_CLOSED: 'ROOM_CLOSED',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_READY: 'NOT_READY',
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_LARGE: 'TOO_LARGE',
  SERVER_FULL: 'SERVER_FULL',
  SHUTTING_DOWN: 'SHUTTING_DOWN'
});

const GRACE_MS = 90_000;          // a dropped peer keeps its slot this long
const ROOM_IDLE_MS = 600_000;     // rooms are garbage collected after 10 min idle
const HEARTBEAT_MS = 30_000;      // ws ping interval; a missed pong reaps the socket
const SWEEP_MS = 5_000;           // room/grace/handshake janitor interval
const HANDSHAKE_MS = 30_000;      // a socket must send HELLO within this window
const START_DEBOUNCE_MS = 1_000;  // ignore duplicate START bursts
const MAX_NAME = 20;
const MAX_CHAT = 240;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Parse an integer environment value, falling back when absent or malformed.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function envInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the relay configuration from environment variables.
 * Recognised: PORT, HOST, MAX_ROOMS, MAX_CONNS_PER_IP, MAX_MESSAGE_BYTES,
 * ORIGIN_ALLOWLIST, LOG_LEVEL, TRUST_PROXY, ROOM_GRACE_MS, ROOM_IDLE_MS.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{port:number, host:string, maxRooms:number, maxConnectionsPerIp:number,
 *   maxMessageBytes:number, originAllowlist:string[], logLevel:string, trustProxy:boolean,
 *   graceMs:number, roomIdleMs:number}}
 */
export function loadConfig(env = process.env) {
  return {
    port: envInt(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    maxRooms: envInt(env.MAX_ROOMS, 500),
    maxConnectionsPerIp: envInt(env.MAX_CONNS_PER_IP, 16),
    maxMessageBytes: envInt(env.MAX_MESSAGE_BYTES, 65_536),
    originAllowlist: String(env.ORIGIN_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: String(env.LOG_LEVEL || 'info').toLowerCase(),
    trustProxy: env.TRUST_PROXY !== '0' && env.TRUST_PROXY !== 'false',
    graceMs: envInt(env.ROOM_GRACE_MS, GRACE_MS),
    roomIdleMs: envInt(env.ROOM_IDLE_MS, ROOM_IDLE_MS)
  };
}

/**
 * Create a structured (one JSON object per line) logger.
 * @param {string} [level='info'] One of debug|info|warn|error|silent.
 * @param {(line: string) => void} [write] Sink, defaults to stdout.
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 */
export function createLogger(level = 'info', write = (line) => process.stdout.write(line)) {
  const min = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const base = { ts: new Date().toISOString(), level: lvl, svc: 'relay', msg };
    let line;
    try {
      line = JSON.stringify(fields ? Object.assign(base, fields) : base);
    } catch {
      line = JSON.stringify(base);
    }
    write(`${line}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f)
  };
}

/**
 * Normalise a room code the way src/js/net/RoomCode.js does.
 * Accepts 'BX-739421', 'bx739421' and '739421'.
 * @param {unknown} raw
 * @returns {string|null} `BX-######` or null when unparseable.
 */
function normalizeCode(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('BX')) s = s.slice(2);
  return /^\d{6}$/.test(s) ? `BX-${s}` : null;
}

/**
 * Strip control characters from untrusted client text and cap its length.
 * @param {unknown} raw
 * @param {number} max Maximum number of characters retained.
 * @returns {string}
 */
function sanitizeText(raw, max) {
  const src = String(raw ?? '');
  let out = '';
  for (let i = 0; i < src.length && out.length < max; i++) {
    const code = src.charCodeAt(i);
    out += code < 32 || code === 127 ? ' ' : src[i];
  }
  return out.trim();
}

/**
 * Sanitise a player name: control characters stripped, length capped.
 * @param {unknown} raw
 * @param {string} [fallback='PLAYER']
 * @returns {string}
 */
function cleanName(raw, fallback = 'PLAYER') {
  return sanitizeText(raw, MAX_NAME) || fallback;
}

/**
 * Wrap a control object in the 0x01 JSON frame.
 * @param {object} obj
 * @returns {Buffer}
 */
function frameControl(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.allocUnsafe(json.length + 1);
  out[0] = FRAME.CONTROL;
  json.copy(out, 1);
  return out;
}

/**
 * Coerce whatever `ws` handed us into a single Buffer.
 * @param {Buffer|ArrayBuffer|Buffer[]} data
 * @returns {Buffer}
 */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Compare two secrets without leaking length-independent timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Test an Origin header against an allowlist that may contain `*` wildcards.
 * An absent Origin is allowed: only browsers send one, so the check exists purely
 * to stop cross-site WebSocket hijacking, which non-browser clients cannot perform.
 * @param {string|undefined} origin
 * @param {string[]} list
 * @returns {boolean}
 */
function originAllowed(origin, list) {
  if (!list.length || !origin) return true;
  const target = String(origin).toLowerCase();
  return list.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === '*') return true;
    if (!p.includes('*')) return p === target;
    const rx = new RegExp(`^${p.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return rx.test(target);
  });
}

/**
 * Resolve the client IP, honouring proxy headers on hosts like Render/Fly/Railway.
 * @param {http.IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
function remoteIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    const direct = req.headers['fly-client-ip'] || req.headers['cf-connecting-ip'];
    if (typeof direct === 'string' && direct.length) return direct.trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Simple token bucket used for per-connection rate limiting. */
class TokenBucket {
  /**
   * @param {number} capacity Burst size.
   * @param {number} rate Tokens refilled per second.
   */
  constructor(capacity, rate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.rate = rate;
    this.last = Date.now();
  }

  /**
   * Consume tokens if available.
   * @param {number} [n=1]
   * @returns {boolean} False when the bucket is empty (caller should reject).
   */
  take(n = 1) {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    if (dt > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + dt * this.rate);
      this.last = now;
    }
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** One of the (at most two) player slots in a room. Survives a disconnect. */
class Slot {
  /**
   * @param {number} index 0 = host, 1 = guest.
   * @param {string} name Display name.
   * @param {Room} room Owning room.
   */
  constructor(index, name, room) {
    this.index = index;
    this.name = name;
    this.room = room;
    this.ready = false;
    this.token = crypto.randomBytes(16).toString('hex');
    this.conn = null;
    this.disconnectedAt = 0;
    this.joinedAt = Date.now();
  }

  /** @returns {boolean} True while a live socket is attached. */
  get connected() {
    return this.conn !== null;
  }

  /** @returns {{slot:number, name:string, ready:boolean, connected:boolean, isHost:boolean}} */
  toJSON() {
    return { slot: this.index, name: this.name, ready: this.ready, connected: this.connected, isHost: this.index === 0 };
  }
}

/** A two-peer match room addressed by a `BX-######` code. */
class Room {
  /** @param {string} code */
  constructor(code) {
    this.code = code;
    /** @type {Array<Slot|null>} */
    this.slots = [null, null];
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.startedAt = 0;
    this.bytes = 0;
    this.messages = 0;
  }

  /** @returns {string} Host display name, or '' when the host slot is gone. */
  get hostName() {
    return this.slots[0] ? this.slots[0].name : '';
  }

  /** @returns {number} Index of a free slot, or -1 when the room is full. */
  freeIndex() {
    if (!this.slots[0]) return 0;
    if (!this.slots[1]) return 1;
    return -1;
  }

  /**
   * @param {Slot} slot
   * @returns {Slot|null} The other slot in this room.
   */
  other(slot) {
    return this.slots[slot.index === 0 ? 1 : 0];
  }

  /** Mark the room as active so the idle collector leaves it alone. */
  touch() {
    this.lastActivity = Date.now();
  }
}

/**
 * The relay: an HTTP server (health + status page) with a WebSocket upgrade on the
 * same port, so one free-tier web service hosts everything.
 */
export class RelayServer {
  /**
   * @param {{config?: object, logger?: object}} [options]
   */
  constructor(options = {}) {
    this.config = Object.assign(loadConfig(), options.config || {});
    this.log = options.logger || createLogger(this.config.logLevel);
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Set<object>} */
    this.conns = new Set();
    /** @type {Map<string, number>} */
    this.ipCounts = new Map();
    this.startedAt = Date.now();
    this.closing = false;
    this.stats = { connections: 0, roomsCreated: 0, messagesForwarded: 0, bytesForwarded: 0, errors: 0 };
    this._connSeq = 0;
    this._timers = [];

    this.http = http.createServer((req, res) => this._onRequest(req, res));
    this.http.on('clientError', (err, socket) => {
      if (socket && !socket.destroyed) socket.destroy();
    });
    this.wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: this.config.maxMessageBytes
    });
    this.http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
  }

  /** @returns {number} Whole seconds since the relay started listening. */
  get uptime() {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Start listening and arm the heartbeat/janitor timers.
   * @returns {Promise<RelayServer>}
   */
  listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.http.once('error', onError);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.removeListener('error', onError);
        this.startedAt = Date.now();
        this._timers.push(setInterval(() => this._heartbeat(), HEARTBEAT_MS));
        this._timers.push(setInterval(() => this._sweep(), SWEEP_MS));
        this.log.info('relay listening', {
          port: this.config.port,
          host: this.config.host,
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          maxRooms: this.config.maxRooms,
          originAllowlist: this.config.originAllowlist.length ? this.config.originAllowlist : 'any'
        });
        resolve(this);
      });
    });
  }

  /**
   * Gracefully shut down: warn every peer, close sockets, then close the HTTP server.
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<void>}
   */
  async close(options = {}) {
    const timeoutMs = options.timeoutMs ?? 3000;
    if (this.closing) return;
    this.closing = true;
    for (const timer of this._timers) clearInterval(timer);
    this._timers.length = 0;
    this.log.info('relay shutting down', { rooms: this.rooms.size, peers: this.conns.size });
    for (const conn of this.conns) {
      this._send(conn, { t: MSG.ERROR, code: ERR.SHUTTING_DOWN, message: 'relay is restarting, reconnect shortly' });
      try { conn.ws.close(1012, 'server restarting'); } catch { /* socket already gone */ }
    }
    await new Promise((resolve) => {
      const force = setTimeout(() => {
        for (const conn of this.conns) {
          try { conn.ws.terminate(); } catch { /* already destroyed */ }
        }
        resolve();
      }, timeoutMs);
      this.http.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
    try { this.wss.close(); } catch { /* already closed */ }
    this.rooms.clear();
    this.conns.clear();
    this.ipCounts.clear();
  }

  /**
   * Alias for {@link RelayServer#close} so the relay matches the project-wide
   * "everything holding resources exposes dispose()" rule.
   * @returns {Promise<void>}
   */
  dispose() {
    return this.close();
  }

  // ---------------------------------------------------------------- HTTP -----

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {void}
   */
  _onRequest(req, res) {
    const path = (req.url || '/').split('?')[0];
    // Self-hosted OTA app-install portal, mounted under /sideload/ (see sideload.js).
    // It claims every /sideload* path; everything else falls through to the relay.
    if (handleSideloadRequest(req, res)) return;
    if (path === '/health' || path === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        rooms: this.rooms.size,
        peers: this.conns.size,
        uptime: this.uptime,
        version: VERSION,
        protocol: PROTOCOL_VERSION
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (path === '/' || path === '/index.html') {
      const body = this._statusPage();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const body = JSON.stringify({ ok: false, error: 'not found' });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /** @returns {string} A tiny dependency-free status page. */
  _statusPage() {
    const mins = Math.floor(this.uptime / 60);
    return `<!doctype html><meta charset="utf-8"><title>Jojo Relay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#12100f;color:#f4e9dd;font:15px/1.6 ui-monospace,Consolas,monospace;margin:0;padding:2.5rem 1.5rem;display:flex;justify-content:center}
main{max-width:34rem;width:100%}h1{color:#e2725b;font-size:1.15rem;letter-spacing:.14em;margin:0 0 1.25rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1.25rem;margin:0 0 1.5rem}dt{color:#8d8378}dd{margin:0}
code{background:#1e1a18;padding:.15rem .4rem;border-radius:3px;color:#d2601a}p{color:#8d8378}</style>
<main><h1>BENEDICT LASO VS JOJO THE DESTROYER &mdash; RELAY</h1>
<dl><dt>status</dt><dd>ok</dd><dt>version</dt><dd>${VERSION}</dd><dt>protocol</dt><dd>${PROTOCOL_VERSION}</dd>
<dt>rooms</dt><dd>${this.rooms.size} / ${this.config.maxRooms}</dd><dt>peers</dt><dd>${this.conns.size}</dd>
<dt>uptime</dt><dd>${this.uptime}s (${mins}m)</dd></dl>
<p>This host relays match traffic only &mdash; no game logic, no persistence.</p>
<p>Paste <code id="u">wss://&hellip;</code> into the game's SERVER field. Health JSON lives at <code>/health</code>.</p>
<p>On an iPad? Open the <a href="/sideload/" style="color:#d2601a">Sideload portal</a> to install signed apps over the air.</p></main>
<script>document.getElementById('u').textContent=(location.protocol==='https:'?'wss://':'ws://')+location.host;</script>`;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @returns {void}
   */
  _onUpgrade(req, socket, head) {
    if (this.closing) return rejectUpgrade(socket, 503, 'Service Unavailable');
    const origin = req.headers.origin;
    if (!originAllowed(origin, this.config.originAllowlist)) {
      this.log.warn('origin rejected', { origin });
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const ip = remoteIp(req, this.config.trustProxy);
    if ((this.ipCounts.get(ip) || 0) >= this.config.maxConnectionsPerIp) {
      this.log.warn('per-ip connection limit', { ip });
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws, ip, origin));
  }

  // ----------------------------------------------------------- connections ---

  /**
   * @param {WebSocket} ws
   * @param {string} ip
   * @param {string|undefined} origin
   * @returns {void}
   */
  _onConnection(ws, ip, origin) {
    const conn = {
      id: `c${++this._connSeq}`,
      ws,
      ip,
      origin: origin || '',
      opened: Date.now(),
      lastSeen: Date.now(),
      alive: true,
      hello: false,
      prefersText: false,
      name: 'PLAYER',
      /** @type {Slot|null} */
      slot: null,
      msgBucket: new TokenBucket(900, 300),
      ctrlBucket: new TokenBucket(40, 10),
      byteBucket: new TokenBucket(1_048_576, 262_144)
    };
    this.conns.add(conn);
    this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);
    this.stats.connections++;
    ws.on('message', (data, isBinary) => this._onMessage(conn, data, isBinary));
    ws.on('pong', () => {
      conn.alive = true;
      conn.lastSeen = Date.now();
    });
    ws.on('error', (err) => this.log.warn('socket error', { conn: conn.id, error: String(err && err.message) }));
    ws.on('close', (code, reason) => this._onClose(conn, code, reason));
    this.log.debug('connection open', { conn: conn.id, ip, origin: conn.origin, peers: this.conns.size });
  }

  /**
   * @param {object} conn
   * @param {number} code
   * @param {Buffer} reason
   * @returns {void}
   */
  _onClose(conn, code, reason) {
    if (!this.conns.delete(conn)) return;
    const left = (this.ipCounts.get(conn.ip) || 1) - 1;
    if (left > 0) this.ipCounts.set(conn.ip, left);
    else this.ipCounts.delete(conn.ip);

    const slot = conn.slot;
    conn.slot = null;
    if (slot && slot.conn === conn) {
      slot.conn = null;
      slot.disconnectedAt = Date.now();
      const room = slot.room;
      room.touch();
      const peer = room.other(slot);
      this._sendSlot(peer, {
        t: MSG.PEER_LEFT,
        code: room.code,
        slot: slot.index,
        name: slot.name,
        final: false,
        graceMs: this.config.graceMs
      });
      this._broadcastLobby(room);
      this.log.info('peer disconnected', {
        conn: conn.id, room: room.code, slot: slot.index, closeCode: code,
        reason: reason && reason.length ? reason.toString('utf8').slice(0, 64) : ''
      });
    } else {
      this.log.debug('connection closed', { conn: conn.id, closeCode: code });
    }
  }

  // -------------------------------------------------------------- messages ---

  /**
   * @param {object} conn
   * @param {Buffer|ArrayBuffer|Buffer[]} data
   * @param {boolean} isBinary
   * @returns {void}
   */
  _onMessage(conn, data, isBinary) {
    const buf = toBuffer(data);
    conn.lastSeen = Date.now();
    conn.alive = true;
    if (buf.length > this.config.maxMessageBytes) {
      return this._kick(conn, ERR.TOO_LARGE, `message exceeds ${this.config.maxMessageBytes} bytes`);
    }
    if (!conn.msgBucket.take(1) || !conn.byteBucket.take(buf.length)) {
      return this._kick(conn, ERR.RATE_LIMITED, 'message rate limit exceeded');
    }
    if (!isBinary) {
      conn.prefersText = true;
      return this._onControl(conn, buf.toString('utf8'));
    }
    if (buf.length === 0) return;
    const kind = buf[0];
    if (kind === FRAME.BINARY) return this._forwardBinary(conn, buf);
    if (kind === FRAME.CONTROL) return this._onControl(conn, buf.toString('utf8', 1));
    if (kind === 0x7b) return this._onControl(conn, buf.toString('utf8')); // bare JSON in a binary frame
    this._error(conn, ERR.BAD_FRAME, `unknown frame byte 0x${kind.toString(16)}`);
  }

  /**
   * Forward an opaque gameplay frame to the other peer, verbatim and unparsed.
   * @param {object} conn
   * @param {Buffer} buf Complete frame including the 0x02 lead byte.
   * @returns {void}
   */
  _forwardBinary(conn, buf) {
    const slot = conn.slot;
    if (!slot) return this._error(conn, ERR.NOT_IN_ROOM, 'join or host a room before sending gameplay data');
    const room = slot.room;
    room.touch();
    room.messages++;
    room.bytes += buf.length;
    const peer = room.other(slot);
    if (!peer || !peer.conn || peer.conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      peer.conn.ws.send(buf, { binary: true });
      this.stats.messagesForwarded++;
      this.stats.bytesForwarded += buf.length;
    } catch (err) {
      this.log.warn('forward failed', { room: room.code, error: String(err && err.message) });
    }
  }

  /**
   * @param {object} conn
   * @param {string} text UTF-8 JSON control payload.
   * @returns {void}
   */
  _onControl(conn, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this._error(conn, ERR.BAD_MESSAGE, 'malformed JSON control frame');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'number') {
      return this._error(conn, ERR.BAD_MESSAGE, 'control frames must be { t: <number>, ... }');
    }
    if (msg.t < 20 && !conn.ctrlBucket.take(1)) {
      return this._kick(conn, ERR.RATE_LIMITED, 'control message rate limit exceeded');
    }
    switch (msg.t) {
      case MSG.HELLO: return this._onHello(conn, msg);
      case MSG.HOSTED: return this._onHost(conn, msg);
      case MSG.JOIN: return this._onJoin(conn, msg);
      case MSG.READY: return this._onReady(conn, msg);
      case MSG.START: return this._onStart(conn, msg);
      case MSG.PING: return this._onPing(conn, msg);
      case MSG.PONG: return this._relayControl(conn, Object.assign({}, msg, { src: 'peer' }));
      case MSG.RECONNECT: return this._onReconnect(conn, msg);
      case MSG.CHAT: return this._onChat(conn, msg);
      default:
        if (msg.t >= 20) return this._relayControl(conn, msg);
        return this._error(conn, ERR.BAD_MESSAGE, `unsupported control type ${msg.t}`);
    }
  }

  /**
   * Version handshake. A HELLO may also carry the room intent so a client can host
   * or join in a single round trip.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onHello(conn, msg) {
    const v = msg.v ?? msg.version ?? msg.protocol;
    if (typeof v === 'number' && v !== PROTOCOL_VERSION) {
      this._error(conn, ERR.BAD_VERSION, `relay speaks protocol ${PROTOCOL_VERSION}, client sent ${v}`);
      try { conn.ws.close(1002, 'bad protocol version'); } catch { /* already closing */ }
      return;
    }
    conn.hello = true;
    conn.name = cleanName(msg.name ?? msg.playerName, 'PLAYER');
    this._send(conn, {
      t: MSG.HELLO,
      ok: true,
      v: PROTOCOL_VERSION,
      server: VERSION,
      id: conn.id,
      heartbeatMs: HEARTBEAT_MS,
      graceMs: this.config.graceMs,
      maxMessageBytes: this.config.maxMessageBytes
    });
    const code = msg.code ?? msg.room ?? msg.roomCode;
    if (code !== undefined && code !== null && String(code).length) return this._onJoin(conn, msg);
    if (wantsHost(msg)) return this._onHost(conn, msg);
  }

  /**
   * Create a room and answer with HOSTED { code, sessionToken }.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onHost(conn, msg) {
    if (conn.slot) return this._error(conn, ERR.ALREADY_IN_ROOM, `already in room ${conn.slot.room.code}`);
    if (this.rooms.size >= this.config.maxRooms) {
      this.log.warn('room cap reached', { rooms: this.rooms.size, maxRooms: this.config.maxRooms });
      return this._error(conn, ERR.SERVER_FULL, 'relay is at capacity, try again shortly');
    }
    const code = this._allocCode();
    if (!code) return this._error(conn, ERR.SERVER_FULL, 'could not allocate a free room code');
    const room = new Room(code);
    const slot = new Slot(0, cleanName(msg.name ?? msg.playerName ?? conn.name, 'BENEDICT'), room);
    room.slots[0] = slot;
    slot.conn = conn;
    conn.slot = slot;
    conn.hello = true;
    this.rooms.set(code, room);
    this.stats.roomsCreated++;
    this._send(conn, {
      t: MSG.HOSTED,
      code,
      sessionToken: slot.token,
      slot: 0,
      isHost: true,
      name: slot.name
    });
    this._broadcastLobby(room);
    this.log.info('room created', { room: code, conn: conn.id, name: slot.name, rooms: this.rooms.size });
  }

  /**
   * Join an existing room by code. A JOIN without a code creates a room instead,
   * which keeps clients that skip the explicit host step working.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onJoin(conn, msg) {
    if (conn.slot) return this._error(conn, ERR.ALREADY_IN_ROOM, `already in room ${conn.slot.room.code}`);
    const raw = msg.code ?? msg.room ?? msg.roomCode;
    if (raw === undefined || raw === null || !String(raw).length) return this._onHost(conn, msg);
    const code = normalizeCode(raw);
    if (!code) return this._error(conn, ERR.ROOM_NOT_FOUND, 'room codes look like BX-123456');
    const room = this.rooms.get(code);
    if (!room) return this._error(conn, ERR.ROOM_NOT_FOUND, `no room ${code} — check the code or ask the host to re-host`);
    const index = room.freeIndex();
    if (index < 0) return this._error(conn, ERR.ROOM_FULL, 'that room already has two boxers');
    const slot = new Slot(index, cleanName(msg.name ?? msg.playerName ?? conn.name, 'PLAYER 2'), room);
    room.slots[index] = slot;
    slot.conn = conn;
    conn.slot = slot;
    conn.hello = true;
    room.touch();
    this._send(conn, {
      t: MSG.JOINED,
      code,
      hostName: room.hostName,
      sessionToken: slot.token,
      slot: index,
      isHost: index === 0,
      name: slot.name
    });
    this._sendSlot(room.other(slot), {
      t: MSG.PEER_JOINED,
      code,
      slot: index,
      name: slot.name,
      reconnected: false
    });
    this._broadcastLobby(room);
    this.log.info('peer joined', { room: code, conn: conn.id, slot: index, name: slot.name });
  }

  /**
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onReady(conn, msg) {
    const slot = conn.slot;
    if (!slot) return this._error(conn, ERR.NOT_IN_ROOM, 'not in a room');
    slot.ready = msg.ready !== false;
    slot.room.touch();
    this._broadcastLobby(slot.room);
    this.log.debug('ready toggled', { room: slot.room.code, slot: slot.index, ready: slot.ready });
  }

  /**
   * Broadcast START once both slots are present and ready. Host-supplied fields
   * (seed, difficulty, mode) are passed through untouched.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onStart(conn, msg) {
    const slot = conn.slot;
    if (!slot) return this._error(conn, ERR.NOT_IN_ROOM, 'not in a room');
    const room = slot.room;
    const both = room.slots[0] && room.slots[1];
    if (!both || !room.slots[0].ready || !room.slots[1].ready) {
      return this._error(conn, ERR.NOT_READY, 'both boxers must be ready before the bell');
    }
    const now = Date.now();
    if (now - room.startedAt < START_DEBOUNCE_MS) return;
    room.startedAt = now;
    room.touch();
    const payload = {
      t: MSG.START,
      code: room.code,
      seed: Number.isFinite(msg.seed) ? msg.seed >>> 0 : crypto.randomInt(1, 2 ** 31),
      at: now,
      by: slot.index
    };
    if (typeof msg.difficulty === 'string') payload.difficulty = msg.difficulty.slice(0, 16);
    if (typeof msg.mode === 'string') payload.mode = msg.mode.slice(0, 16);
    this._broadcast(room, payload);
    this.log.info('match start', { room: room.code, seed: payload.seed, by: slot.index });
  }

  /**
   * Answer PING with PONG so the client can measure RTT to the relay. When the
   * client sets `peer: true` the PING is also forwarded, giving true peer RTT.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onPing(conn, msg) {
    const pong = { t: MSG.PONG, now: Date.now(), src: 'relay' };
    if (msg.id !== undefined) pong.id = msg.id;
    if (msg.ts !== undefined) pong.ts = msg.ts;
    if (msg.t0 !== undefined) pong.t0 = msg.t0;
    if (msg.seq !== undefined) pong.seq = msg.seq;
    this._send(conn, pong);
    if (msg.peer === true && conn.slot) {
      this._relayControl(conn, Object.assign({}, msg, { src: 'peer' }));
    }
  }

  /**
   * Re-attach a dropped socket to its existing slot using { code, sessionToken }.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onReconnect(conn, msg) {
    if (conn.slot) return this._error(conn, ERR.ALREADY_IN_ROOM, `already in room ${conn.slot.room.code}`);
    const code = normalizeCode(msg.code ?? msg.room ?? msg.roomCode);
    const token = typeof msg.sessionToken === 'string' ? msg.sessionToken : String(msg.token || '');
    if (!code) return this._error(conn, ERR.ROOM_NOT_FOUND, 'room codes look like BX-123456');
    const room = this.rooms.get(code);
    if (!room) return this._error(conn, ERR.ROOM_NOT_FOUND, `room ${code} has already been closed`);
    const slot = room.slots.find((s) => s && safeEqual(s.token, token)) || null;
    if (!slot) return this._error(conn, ERR.BAD_TOKEN, 'session token does not match any slot in that room');
    if (slot.conn && slot.conn !== conn) {
      const stale = slot.conn;
      stale.slot = null;
      try { stale.ws.close(4001, 'replaced by reconnect'); } catch { /* already gone */ }
    }
    slot.conn = conn;
    slot.disconnectedAt = 0;
    if (msg.name !== undefined) slot.name = cleanName(msg.name, slot.name);
    conn.slot = slot;
    conn.hello = true;
    room.touch();
    const peer = room.other(slot);
    this._send(conn, {
      t: MSG.RECONNECT,
      ok: true,
      code: room.code,
      slot: slot.index,
      isHost: slot.index === 0,
      sessionToken: slot.token,
      hostName: room.hostName,
      name: slot.name,
      peerConnected: Boolean(peer && peer.connected),
      started: room.startedAt > 0
    });
    this._sendSlot(peer, {
      t: MSG.PEER_JOINED,
      code: room.code,
      slot: slot.index,
      name: slot.name,
      reconnected: true
    });
    this._broadcastLobby(room);
    this.log.info('peer reconnected', { room: room.code, slot: slot.index, conn: conn.id });
  }

  /**
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _onChat(conn, msg) {
    const slot = conn.slot;
    if (!slot) return this._error(conn, ERR.NOT_IN_ROOM, 'not in a room');
    const text = sanitizeText(msg.text ?? msg.message, MAX_CHAT);
    if (!text) return;
    slot.room.touch();
    this._sendSlot(slot.room.other(slot), {
      t: MSG.CHAT,
      from: slot.index,
      name: slot.name,
      text,
      at: Date.now()
    });
  }

  /**
   * Forward a JSON message to the other peer with the sender's slot stamped on it.
   * @param {object} conn
   * @param {object} msg
   * @returns {void}
   */
  _relayControl(conn, msg) {
    const slot = conn.slot;
    if (!slot) return this._error(conn, ERR.NOT_IN_ROOM, 'not in a room');
    slot.room.touch();
    slot.room.messages++;
    const peer = slot.room.other(slot);
    if (!peer) return;
    if (this._sendSlot(peer, Object.assign({}, msg, { from: slot.index }))) this.stats.messagesForwarded++;
  }

  // ---------------------------------------------------------------- rooms ----

  /** @returns {string|null} A collision-checked `BX-######` code. */
  _allocCode() {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = `BX-${String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')}`;
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /**
   * @param {Room} room
   * @returns {object} The LOBBY_STATE payload for a room.
   */
  _lobbyState(room) {
    const peers = room.slots.filter(Boolean).map((s) => s.toJSON());
    return {
      t: MSG.LOBBY_STATE,
      code: room.code,
      hostName: room.hostName,
      started: room.startedAt > 0,
      canStart: peers.length === 2 && peers.every((p) => p.ready && p.connected),
      peers
    };
  }

  /**
   * @param {Room} room
   * @returns {void}
   */
  _broadcastLobby(room) {
    this._broadcast(room, this._lobbyState(room));
  }

  /**
   * @param {Room} room
   * @param {object} payload
   * @returns {void}
   */
  _broadcast(room, payload) {
    for (const slot of room.slots) this._sendSlot(slot, payload);
  }

  /**
   * Close a room, notifying whoever is still attached.
   * @param {Room} room
   * @param {string} reason
   * @returns {void}
   */
  _closeRoom(room, reason) {
    for (const slot of room.slots) {
      if (!slot) continue;
      const conn = slot.conn;
      slot.conn = null;
      if (!conn) continue;
      conn.slot = null;
      this._send(conn, { t: MSG.ERROR, code: ERR.ROOM_CLOSED, message: `room closed (${reason})` });
      try { conn.ws.close(1000, 'room closed'); } catch { /* already closing */ }
    }
    room.slots[0] = null;
    room.slots[1] = null;
    this.rooms.delete(room.code);
    this.log.info('room closed', {
      room: room.code, reason, rooms: this.rooms.size,
      messages: room.messages, bytes: room.bytes, ageSec: Math.round((Date.now() - room.createdAt) / 1000)
    });
  }

  // -------------------------------------------------------------- janitors ---

  /** Ping every socket; reap the ones that missed the previous round. @returns {void} */
  _heartbeat() {
    for (const conn of this.conns) {
      if (!conn.alive) {
        this.log.debug('reaping dead socket', { conn: conn.id, room: conn.slot ? conn.slot.room.code : '' });
        try { conn.ws.terminate(); } catch { /* already destroyed */ }
        continue;
      }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* socket closing */ }
    }
  }

  /** Expire reconnection grace windows, empty rooms and idle rooms. @returns {void} */
  _sweep() {
    const now = Date.now();
    for (const conn of this.conns) {
      if (!conn.hello && now - conn.opened > HANDSHAKE_MS) {
        this._error(conn, ERR.BAD_MESSAGE, 'no HELLO received');
        try { conn.ws.close(1008, 'handshake timeout'); } catch { /* already closing */ }
      }
    }
    for (const room of [...this.rooms.values()]) {
      for (const slot of room.slots) {
        if (!slot || slot.conn || now - slot.disconnectedAt <= this.config.graceMs) continue;
        room.slots[slot.index] = null;
        this._sendSlot(room.other(slot), {
          t: MSG.PEER_LEFT,
          code: room.code,
          slot: slot.index,
          name: slot.name,
          final: true,
          expired: true
        });
        this.log.info('grace expired', { room: room.code, slot: slot.index, name: slot.name });
        this._broadcastLobby(room);
      }
      if (!room.slots[0] && !room.slots[1]) this._closeRoom(room, 'empty');
      else if (now - room.lastActivity > this.config.roomIdleMs) this._closeRoom(room, 'idle');
    }
  }

  // ----------------------------------------------------------------- send ----

  /**
   * @param {object|null} conn
   * @param {object} payload
   * @returns {boolean} True when the payload reached the socket.
   */
  _send(conn, payload) {
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      if (conn.prefersText) conn.ws.send(JSON.stringify(payload));
      else conn.ws.send(frameControl(payload), { binary: true });
      return true;
    } catch (err) {
      this.log.warn('control send failed', { conn: conn.id, error: String(err && err.message) });
      return false;
    }
  }

  /**
   * @param {Slot|null|undefined} slot
   * @param {object} payload
   * @returns {boolean}
   */
  _sendSlot(slot, payload) {
    return slot ? this._send(slot.conn, payload) : false;
  }

  /**
   * @param {object} conn
   * @param {string} code One of {@link ERR}.
   * @param {string} message Human-readable detail.
   * @returns {void}
   */
  _error(conn, code, message) {
    this.stats.errors++;
    this.log.debug('protocol error', { conn: conn.id, code, message });
    this._send(conn, { t: MSG.ERROR, code, message });
  }

  /**
   * Report an error then close the offending socket.
   * @param {object} conn
   * @param {string} code
   * @param {string} message
   * @returns {void}
   */
  _kick(conn, code, message) {
    this._error(conn, code, message);
    this.log.warn('closing abusive socket', { conn: conn.id, ip: conn.ip, code });
    try { conn.ws.close(1008, code); } catch { /* already closing */ }
  }
}

/**
 * Does this HELLO/JOIN ask the relay to create a room?
 * @param {object} msg
 * @returns {boolean}
 */
function wantsHost(msg) {
  if (msg.host === true || msg.create === true) return true;
  const intent = String(msg.intent ?? msg.role ?? msg.mode ?? msg.action ?? '').toUpperCase();
  return intent === 'HOST' || intent === 'HOSTED' || intent === 'CREATE';
}

/**
 * Answer a rejected WebSocket upgrade with a real HTTP status, then hang up.
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {string} text
 * @returns {void}
 */
function rejectUpgrade(socket, status, text) {
  try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* peer vanished */ }
  socket.destroy();
}

/**
 * Construct a relay without starting it (handy for tests and for the Electron
 * main process, which embeds the relay for LAN self-hosting).
 * @param {{config?: object, logger?: object}} [options]
 * @returns {RelayServer}
 */
export function createRelay(options) {
  return new RelayServer(options);
}

/**
 * Construct and start a relay.
 * @param {{config?: object, logger?: object}} [options]
 * @returns {Promise<RelayServer>}
 */
export async function startRelay(options) {
  const relay = createRelay(options);
  await relay.listen();
  return relay;
}

/**
 * CLI entry point: start the relay and wire graceful SIGTERM/SIGINT shutdown.
 * @returns {Promise<void>}
 */
async function main() {
  const relay = createRelay();
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    relay.log.info('signal received', { signal });
    await relay.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('uncaughtException', (err) => {
    relay.log.error('uncaught exception', { error: String(err && err.stack ? err.stack : err) });
  });
  process.on('unhandledRejection', (err) => {
    relay.log.error('unhandled rejection', { error: String(err) });
  });
  await relay.listen();
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', svc: 'relay', msg: 'startup failed', error: String(err && err.message ? err.message : err) })}\n`);
    process.exit(1);
  });
}
