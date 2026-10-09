// Room plugin for the party: ready, kick, promote, look, start countdown, suggestions, map marks
// and rejoin after a dropped connection. See shared/plugins/index.js for the plugin interface.
//
// Messages (client -> room):
//   ready {on}              lobby only
//   look {name, skin, lvl}  name any time, skin only in the lobby
//   kick {id}               leader only, humans only, never yourself
//   promote {id}            leader only
//   start {cd: 1}           leader: a 3 s countdown, then the Room's own start. A start without
//                           cd starts at once, as before (PLAY AGAIN, older pages, tests).
//   cancel                  leader: stop the countdown
//   suggest {id}            a member asks the leader for a mode (at most 1 per 3 s)
//   mark {x, z} | {clear}   a map marker for your team (everyone in the lobby), at most 4 per second
//   bye                     the page leaves on purpose: its disconnect is not held for a rejoin
// Messages (room -> client): countdown {s, ends, ms} (s 0 = cancelled), kicked {msg},
//   suggest {id, from}, mark {id, x, z} | {id, clear}, and on a rejoin 'resumed' (see below).
//
// Rejoin: the welcome carries a 16-character resume token. A player whose hello said it can resume
// (hello.resume is a string, '' on a first join) and whose connection drops (in the lobby, the bus
// or the match; not on purpose: see bye) is held for 60 s (roster row away: 1). Joining again with hello.resume = token rebinds the
// new connection to the same player (same id, health, team and place in the match). The answer is
// the welcome with resumed: true and me {x, y, z, hp, sh, alive, inBus}; with hello.keep (the page
// still has its game running) it comes as {t: 'resumed'} instead, so the client's game is not reset.
import { SKINS, MAP } from '../constants.js';
import { normalizeRules } from '../modes/rules.js';
import { findMode, modeRules, modeInfo } from '../modes/index.js';
import { GAMES } from '../modes/games/index.js';

export const HOLD_MS = 60000;      // a dropped player keeps their spot this long
export const COUNTDOWN_MS = 3000;  // PLAY -> 3, 2, 1 -> the bus
export const SUGGEST_MS = 3000;    // one mode suggestion per player per 3 s
export const MARKS_PER_S = 4;
const LOOK_MS = 100;
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampInt = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(a, Math.min(b, Math.round(v))) : d);
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16) || 'Player';
const r1 = (v) => Math.round(v * 10) / 10;

function makeToken() {
  const out = [];
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    for (let i = 0; i < 16; i++) out.push(TOKEN_CHARS[b[i] % TOKEN_CHARS.length]);
  } else {
    for (let i = 0; i < 16; i++) out.push(TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)]);
  }
  return out.join('');
}

const inMatch = (room) => room.phase === 'bus' || room.phase === 'match';

/** The connection record { conn, pid, last } of player id, or null. */
function recOf(room, id) {
  for (const rec of room.conns.values()) if (rec.pid === id) return rec;
  return null;
}

/** The first connected human (in join order), or null. */
function firstConnected(room, except = 0) {
  for (const p of room.players.values()) {
    if (!p.bot && p.id !== except && !p.away && recOf(room, p.id)) return p;
  }
  return null;
}

function rosterOut(room) {
  room.broadcast({ t: 'roster', players: room.roster(), leader: room.leader });
}

function cancelCountdown(room, tell = true) {
  if (!room.party.cd) return;
  room.party.cd = null;
  if (tell) room.broadcast({ t: 'countdown', s: 0 });
}

/** Bots whose device is gone go to the leader (when the leader is here). */
function fixBotOwner(room) {
  let owner = -1;
  for (const p of room.players.values()) if (p.bot) { owner = p.owner; break; }
  if (owner < 0 || recOf(room, owner)) return;
  if (recOf(room, room.leader)) room.reassignBots(room.leader);
}

/** Remove a player for good (a hold ran out, a held player was kicked, the match ended). */
function dropPlayer(room, p, broadcast = true) {
  if (p.alive && inMatch(room)) room.eliminate(p, null, { c: 'left' });
  room.players.delete(p.id);
  room.party.suggestT.delete(p.id);
  room.party.marks.delete(p.id);
  room.party.lookT.delete(p.id);
  room.broadcast({ t: 'note', msg: `${p.name} left` });
  room.log('party drop', { room: room.code, id: p.id });
  const humans = room.humans();
  if (!humans.length) { room.empty = true; return; }
  if (room.leader === p.id || !room.players.has(room.leader)) room.leader = (firstConnected(room) || humans[0]).id;
  fixBotOwner(room);
  if (broadcast) rosterOut(room);
}

const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, n);

/**
 * Room settings sent by a page (server 'create' with the party-of-one's settings, a P2P host's
 * new Room): only the known keys, with sane types. Rules are normalized. Unknown input -> {}.
 */
export function cleanSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  if (typeof s.bots === 'number' && Number.isFinite(s.bots)) out.bots = Math.max(0, Math.min(31, Math.round(s.bots)));
  if (typeof s.mats === 'number' && Number.isFinite(s.mats)) out.mats = Math.max(0, Math.min(999, Math.round(s.mats)));
  if (s.mode === 'ffa' || s.mode === 'squad') out.mode = s.mode;
  if (typeof s.modeId === 'string' && /^[\w-]{1,48}$/.test(s.modeId)) out.modeId = s.modeId;
  if (typeof s.botSkill === 'string' && /^[a-z]{1,12}$/.test(s.botSkill)) out.botSkill = s.botSkill;
  if (s.rules && typeof s.rules === 'object' && !Array.isArray(s.rules)) {
    // the legacy mirror fields (bots, mats, botSkill) count when the rules leave them out
    const raw = { ...s.rules };
    for (const k of ['bots', 'mats', 'botSkill']) if (out[k] !== undefined && !Object.prototype.hasOwnProperty.call(s.rules, k)) raw[k] = out[k];
    out.rules = normalizeRules(raw, { games: Object.keys(GAMES) });
  }
  // custom: a flag, or the custom rules themselves
  if (s.custom && typeof s.custom === 'object' && !Array.isArray(s.custom)) out.custom = normalizeRules(s.custom, { games: Object.keys(GAMES) });
  else if (s.custom !== undefined) out.custom = !!s.custom;
  const i = s.info;
  if (i && typeof i === 'object' && !Array.isArray(i)) {
    out.info = {
      name: cleanText(i.name, 40) || 'Mode',
      emoji: cleanText(i.emoji, 8),
      color: typeof i.color === 'string' && /^#[0-9a-f]{6}$/i.test(i.color) ? i.color : '#8a8fa8',
      desc: cleanText(i.desc, 160),
      tags: Array.isArray(i.tags) ? i.tags.slice(0, 6).map((t) => cleanText(t, 24)).filter(Boolean) : [],
    };
  }
  return out;
}

/**
 * Mode picks ({t:'mode', id} or {t:'mode', custom, name}) for a Room without the mode engine's own
 * 'mode' handler: init() only installs this when room.baseHandlers.mode does not exist.
 */
function legacyModeHandler(c, m) {
  if (c.pid !== this.leader || this.phase !== 'lobby' || !m) return;
  const games = Object.keys(GAMES);
  let rules, info, modeId;
  if (typeof m.id === 'string') {
    const entry = findMode(m.id);
    if (!entry) return;
    rules = modeRules(m.id, { games });
    info = modeInfo(entry);
    modeId = entry.id;
  } else if (m.custom && typeof m.custom === 'object') {
    rules = normalizeRules(m.custom, { games });
    info = { name: String(m.name || 'Custom mode').replace(/[\u0000-\u001f<>&"']/g, '').slice(0, 40), emoji: '🛠️', color: '#8a8fa8', desc: 'A custom mode.', tags: ['Custom'] };
    modeId = 'custom';
  } else return;
  const s = this.settings;
  s.modeId = modeId;
  s.rules = rules;
  s.info = info;
  s.custom = modeId === 'custom';
  // today's Room still reads these two
  s.mode = rules.teams === 'humans' ? 'squad' : 'ffa';
  s.bots = rules.bots;
  this.rules = rules;
  this.broadcast({ t: 'settings', settings: s });
}

export const party = {
  name: 'party',

  init(room) {
    room.party = {
      cd: null,            // { ends, c, m } while the start countdown runs
      join: null,          // { hello, id }: the join in progress (its hello is applied in welcome)
      kicking: null,       // connection id being kicked (that leave is never held)
      suggestT: new Map(), // pid -> time of the last suggestion
      marks: new Map(),    // pid -> { ts: [MARKS_PER_S times], i }
      lookT: new Map(),    // pid -> time of the last look
      sweepT: 0,
    };
    if (!room.baseHandlers.mode && !room.pluginHandlers.mode) room.pluginHandlers.mode = legacyModeHandler;
  },

  onJoin(room, conn, hello) {
    const P = room.party;
    P.join = null;
    const tok = typeof hello.resume === 'string' ? hello.resume : '';
    if (tok.length === 16) {
      for (const p of room.players.values()) {
        if (!p.bot && p.token === tok) return rebind(room, conn, p, hello);
      }
    }
    P.join = { hello, id: room.nextId };
    return undefined;
  },

  onLeave(room, c, p) {
    // held in the lobby too (a Wi-Fi blip should not cost the leader the crown), not at the end screen
    if (!p || p.bot || !p.resumeOk || room.party.kicking === c.conn.id || room.phase === 'ended') return undefined;
    p.away = room.now() + HOLD_MS;
    // someone who is still here leads (and simulates the bots) while the leader is away
    if (room.leader === p.id) {
      const next = firstConnected(room, p.id);
      if (next) room.leader = next.id;
    }
    fixBotOwner(room);
    rosterOut(room);
    room.broadcast({ t: 'note', msg: `${p.name} lost connection…` });
    room.log('party hold', { room: room.code, id: p.id });
    return true;
  },

  roster(p) {
    if (p.bot) return null;
    return { ready: !!p.ready, lvl: p.lvl || 1, away: p.away ? 1 : 0 };
  },

  welcome(room, id) {
    const P = room.party;
    const p = room.players.get(id);
    if (!p || p.bot) return null;
    if (P.join && P.join.id === id) {
      const h = P.join.hello;
      P.join = null;
      p.ready = false;
      p.lvl = clampInt(h.lvl, 1, 999, 1);
      p.tier = h.tier === 'ipad' ? 'ipad' : 'desktop';
      p.resumeOk = typeof h.resume === 'string';
      p.away = 0;
      p.token = makeToken();
    }
    if (!p.token) p.token = makeToken();
    return {
      resume: p.token,
      party: { max: room.maxHumans, cd: P.cd ? Math.max(0, P.cd.ends - room.now()) : 0 },
      players: room.roster(), // again: the new player's row now has its level
    };
  },

  tick(room, now) {
    const P = room.party;
    if (P.cd && now >= P.cd.ends) fireCountdown(room);
    if (now - P.sweepT < 250) return;
    P.sweepT = now;
    for (const p of room.players.values()) {
      if (p.away && now >= p.away) dropPlayer(room, p);
    }
  },

  onStart(room) {
    room.party.cd = null;
  },

  onLobby(room) {
    const P = room.party;
    P.cd = null;
    P.marks.clear();
    P.suggestT.clear();
    // players still away when the match ends leave the party (they can join again as new players)
    for (const p of [...room.players.values()]) {
      if (p.bot) continue;
      p.ready = false;
      if (p.away) dropPlayer(room, p, false);
    }
  },

  handlers: {
    // the page is leaving on purpose (LEAVE PARTY, closed): its disconnect is not held for a rejoin
    bye(c) {
      const p = this.players.get(c.pid);
      if (p) p.resumeOk = false;
    },

    ready(c, m) {
      if (this.phase !== 'lobby') return;
      const p = this.players.get(c.pid);
      const on = !!(m && m.on);
      if (!p || p.ready === on) return;
      p.ready = on;
      rosterOut(this);
    },

    look(c, m) {
      const p = this.players.get(c.pid);
      if (!p || p.bot || !m) return;
      const now = this.now();
      const last = this.party.lookT.get(p.id);
      if (last !== undefined && now - last < LOOK_MS) return;
      this.party.lookT.set(p.id, now);
      let changed = false;
      if (typeof m.name === 'string') {
        const n = cleanName(m.name);
        if (n !== p.name) { p.name = n; changed = true; }
      }
      if (m.skin !== undefined && this.phase === 'lobby') {
        const s = clampInt(m.skin, 0, SKINS.length - 1, p.skin);
        if (s !== p.skin) { p.skin = s; changed = true; }
      }
      if (m.lvl !== undefined) {
        const l = clampInt(m.lvl, 1, 999, p.lvl || 1);
        if (l !== p.lvl) { p.lvl = l; changed = true; }
      }
      if (changed) rosterOut(this);
    },

    kick(c, m) {
      if (c.pid !== this.leader || !m) return;
      const id = num(m.id) | 0;
      if (id === c.pid) return;
      const p = this.players.get(id);
      if (!p || p.bot) return;
      let cid = null;
      for (const [k, r] of this.conns) if (r.pid === id) { cid = k; break; }
      this.log('party kick', { room: this.code, id });
      if (cid === null) { dropPlayer(this, p); return; } // held after a drop: just remove them
      this.send(this.conns.get(cid).conn, { t: 'kicked', msg: 'The party leader removed you from the party.' });
      this.party.kicking = cid;
      try {
        if (typeof this.onKick === 'function') this.onKick(cid);
        this.leave(cid);
      } finally {
        this.party.kicking = null;
      }
    },

    promote(c, m) {
      if (c.pid !== this.leader || !m) return;
      const id = num(m.id) | 0;
      const p = this.players.get(id);
      if (!p || p.bot || id === c.pid || p.away || !recOf(this, id)) return;
      this.leader = id;
      cancelCountdown(this);
      rosterOut(this);
      this.broadcast({ t: 'note', msg: `${p.name} is the party leader` });
    },

    start(c, m) {
      if (!m || !m.cd) {
        // an immediate start: the Room's own
        this.baseHandlers.start.call(this, c, m || {});
        if (this.phase !== 'lobby') this.party.cd = null;
        return;
      }
      if (c.pid !== this.leader || this.phase !== 'lobby' || this.party.cd) return;
      const rest = { ...m };
      delete rest.cd;
      const ends = this.now() + COUNTDOWN_MS;
      this.party.cd = { ends, c, m: rest };
      this.broadcast({ t: 'countdown', s: Math.round(COUNTDOWN_MS / 1000), ends, ms: COUNTDOWN_MS });
    },

    cancel(c) {
      if (c.pid !== this.leader) return;
      cancelCountdown(this);
    },

    suggest(c, m) {
      if (c.pid === this.leader || !m || typeof m.id !== 'string' || !/^[\w-]{1,48}$/.test(m.id)) return;
      const now = this.now();
      const last = this.party.suggestT.get(c.pid);
      if (last !== undefined && now - last < SUGGEST_MS) return;
      this.party.suggestT.set(c.pid, now);
      const lr = recOf(this, this.leader);
      if (lr) this.send(lr.conn, { t: 'suggest', id: m.id, from: c.pid });
    },

    mark(c, m) {
      const p = this.players.get(c.pid);
      if (!p || !m) return;
      let out;
      if (m.clear) out = { t: 'mark', id: p.id, clear: 1 };
      else {
        const x = num(m.x, NaN), z = num(m.z, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        const lim = MAP.size / 2 + 60;
        out = { t: 'mark', id: p.id, x: r1(Math.max(-lim, Math.min(lim, x))), z: r1(Math.max(-lim, Math.min(lim, z))) };
      }
      // at most MARKS_PER_S in any one second
      const now = this.now();
      let b = this.party.marks.get(p.id);
      if (!b) this.party.marks.set(p.id, (b = { ts: new Array(MARKS_PER_S).fill(-1e12), i: 0 }));
      if (now - b.ts[b.i] < 1000) return;
      b.ts[b.i] = now;
      b.i = (b.i + 1) % MARKS_PER_S;
      const lobby = this.phase === 'lobby';
      for (const rec of this.conns.values()) {
        const q = this.players.get(rec.pid);
        if (q && (lobby || q.team === p.team)) this.send(rec.conn, out);
      }
    },
  },
};

function fireCountdown(room) {
  const cd = room.party.cd;
  room.party.cd = null;
  if (room.phase !== 'lobby') return;
  const rec = room.conns.get(cd.c.conn.id);
  if (rec && rec.pid === room.leader) room.baseHandlers.start.call(room, rec, cd.m);
  // the leader left, or the Room refused the start: clear the countdown on every screen
  if (room.phase === 'lobby') room.broadcast({ t: 'countdown', s: 0 });
}

/** A held (or still bound) player comes back on a new connection. */
function rebind(room, conn, p, hello) {
  // a connection still bound to this player (its socket has not noticed the drop yet) is replaced
  for (const [cid, rec] of [...room.conns]) {
    if (rec.pid !== p.id) continue;
    room.conns.delete(cid);
    if (typeof room.onKick === 'function') room.onKick(cid);
  }
  room.conns.set(conn.id, { conn, pid: p.id, last: room.now() });
  const wasAway = !!p.away;
  p.away = 0;
  p.resumeOk = true;
  if (conn.ip) p.ip = conn.ip;
  if (hello.lvl !== undefined) p.lvl = clampInt(hello.lvl, 1, 999, p.lvl || 1);
  if (!room.leader || !room.players.has(room.leader) || !recOf(room, room.leader)) room.leader = p.id;
  const w = room.welcome(p.id);
  w.resumed = true;
  w.me = { x: r1(p.x), y: r1(p.y), z: r1(p.z), hp: Math.ceil(p.hp), sh: Math.ceil(p.sh), alive: !!p.alive, inBus: !!p.inBus };
  if (hello.keep) w.t = 'resumed';
  room.send(conn, w);
  room.broadcast({ t: 'roster', players: room.roster(), leader: room.leader }, conn.id);
  if (wasAway) room.broadcast({ t: 'note', msg: `${p.name} is back!` }, conn.id);
  fixBotOwner(room);
  room.log('party resume', { room: room.code, id: p.id });
  return true;
}
