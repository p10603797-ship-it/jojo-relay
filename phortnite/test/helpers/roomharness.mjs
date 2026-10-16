// Test harness for the shared Room (the same code runs on the Node server, the P2P host and in
// solo). A fake clock drives the room, connections collect what the room sends them.
//
//   const H = makeRoom({ settings: { mode: 'squad' } });
//   const a = H.join('Ann'), b = H.join('Ben');      // connections; a.pid, a.p (player record)
//   H.send(a, { t: 'start', bots: 0 });
//   H.advance(1000);                                // 1 s of fake time, room.tick() at 20 Hz
//   H.msgs(b, 'elim'); H.last(a, 'win');
//
// makeRoom(opts): Room constructor options (settings, maxHumans, solo, code, plugins, …) plus
//   t0     fake start time in ms (default 1000)
//   clone  deliver JSON copies of every message, like a real network (default true)
//   drop   message types not to keep in the inboxes, e.g. ['s'] for long simulations
// Every 'handler error' / 'plugin error' the room logs is collected in H.errors.
import { Room } from '../../public/shared/room.js';
import { PROTOCOL, TICK_HZ } from '../../public/shared/constants.js';

const TICK_MS = 1000 / TICK_HZ;

export function makeRoom(opts = {}) {
  const { t0 = 1000, clone = true, drop = [], ...roomOpts } = opts;
  let t = t0;
  let nextTick = t0 + TICK_MS;
  let nextConn = 1;
  const errors = [];
  const logs = [];
  const skip = new Set(drop);
  const room = new Room({
    code: 'TEST', name: 'Test party',
    log: (msg, data) => { logs.push([msg, data]); if (/error/.test(msg)) errors.push({ msg, ...data }); },
    ...roomOpts,
    now: () => t,
  });

  const H = {
    room, errors, logs,
    /** Current fake time (ms). */
    now: () => t,
    /** A connection that collects every message the room sends it. */
    conn(id = `c${nextConn++}`, ip = '127.0.0.1') {
      const c = {
        id, ip, inbox: [], pid: 0,
        send: (m) => { if (!skip.has(m.t)) c.inbox.push(clone ? JSON.parse(JSON.stringify(m)) : m); },
        get p() { return room.players.get(c.pid) || null; },
      };
      return c;
    },
    /** A new connection joins with hello {name, v: PROTOCOL, …}. c.ok is room.join's answer, c.pid the player id. */
    join(name, hello = {}, conn = H.conn()) {
      conn.ok = room.join(conn, { name, skin: 0, v: PROTOCOL, ...hello });
      const w = H.last(conn, 'welcome');
      if (w) conn.pid = w.you;
      return conn;
    },
    /** A message from a connection (copied, like the network does). */
    send(conn, msg) { room.message(conn.id, clone ? JSON.parse(JSON.stringify(msg)) : msg); },
    leave(conn) { room.leave(conn.id); },
    /** Move the fake clock on by ms, calling room.tick() on every 50 ms boundary (20 Hz). */
    advance(ms) {
      const end = t + ms;
      while (nextTick <= end) {
        t = nextTick;
        room.tick();
        nextTick += TICK_MS;
      }
      t = end;
    },
    /** Every message of type t this connection received (all of them without t). */
    msgs(conn, type) { return type ? conn.inbox.filter((m) => m.t === type) : conn.inbox; },
    /** The latest message of type t, or null. */
    last(conn, type) {
      for (let i = conn.inbox.length - 1; i >= 0; i--) if (!type || conn.inbox[i].t === type) return conn.inbox[i];
      return null;
    },
    clear(conn) { conn.inbox.length = 0; },
    player(id) { return room.players.get(id) || null; },
    bots() { return [...room.players.values()].filter((p) => p.bot); },
  };
  return H;
}
