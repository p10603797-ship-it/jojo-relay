// Authoritative game room. Transport agnostic: the Node server feeds it WebSocket
// connections, and solo mode runs the very same code inside the browser (so does the P2P host).
//
// A connection is any object with { id, send(obj), ip }.
//
// Game modes: room.settings = {modeId, rules, info, custom} (shared/modes/rules.js +
// shared/modes/index.js), played by the mode runtime (shared/modes/runtime.js): teams, spawns,
// respawns and lives, win types (shared/modes/games/), storm presets, play areas, seeded loot
// (shared/loot.js), loadouts and mutators.
//
// Room plugins (shared/plugins/index.js) hook into joins, leaves, roster rows, the welcome,
// ticks, match start / lobby / eliminations, build piece messages and client messages.
import {
  MAP, BUILD, MAT_KEYS, PLAYER, WEAPONS, WEAPON_KEYS, AMMO, HEALS, BUS, SKINS, BOT_NAMES,
  clampRarity, weaponDamage, MAX_MATS, PROTOCOL, ANIM, own, STORM_PRESETS, SKY_SPAWN_HEIGHT,
} from './constants.js';
import { generateWorld } from './worldgen.js';
import { BuildGrid, parseKey } from './buildgrid.js';
import { normalizeRules, rulesFromSettings, LEGACY_MODES } from './modes/rules.js';
import { findMode, modeInfo, modeTags } from './modes/index.js';
import { GAMES } from './modes/games/index.js';
import {
  ModeRuntime, resolveArea, assignTeams, botCountFor, spawnCandidates, pickSpawns, rollBotSkill, nearLava,
} from './modes/runtime.js';
import { rollInitialLoot, rollChest, makeLoadout } from './loot.js';
import { ROOM_PLUGINS } from './plugins/index.js';

let sharedWorld = null;
export function getWorld() {
  if (!sharedWorld) sharedWorld = generateWorld(MAP.seed);
  return sharedWorld;
}

const MAX_HUMANS = 16;
const MAX_TOTAL = 32;
const HUMANS_OUT_MS = 20000; // every human is out: bots play on this long (spectating) before the end
const MYSTERY_EVERY = 60000;
const ROUND_BREAK = 4000;
const LAVA_PAD = 15; // m: storm circles keep their centre this far from a lava pool's edge
// Mystery mode's mutators: [rule, value, banner]
const MYSTERY = [
  ['gravity', 0.35, 'Moon gravity!'], ['speed', 1.5, 'Super speed!'], ['bigHead', true, 'Big heads!'],
  ['dmg', 2, 'Double damage!'], ['oneShot', true, 'One shot, one elim!'],
];
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16) || 'Player';
const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, n);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** normalizeRules options for the Room: a win type needs its game. */
export const GAME_OPTS = Object.freeze({ games: Object.freeze(Object.keys(GAMES)) });

// ------------------------------------------------------------------ settings
/** Is this mode playable here (known, and its game exists)? */
function playableMode(id) {
  const m = typeof id === 'string' ? findMode(id) : null;
  if (!m) return null;
  if (m.requires && !hasOwn(GAMES, m.requires)) return null;
  const win = m.rules && m.rules.win;
  if (win && win !== 'last' && !hasOwn(GAMES, win)) return null;
  return m;
}

/** The legacy mirror fields old lobby code reads (bots, mats, mode 'ffa' | 'squad'). */
function withMirror(s) {
  s.bots = s.rules.bots;
  s.mats = s.rules.mats;
  s.mode = s.rules.teams === 'humans' ? 'squad' : 'ffa';
  return s;
}

/** Room settings for a catalogue mode, keeping the party's bot difficulty unless the mode sets one. */
export function modeSettings(id, prevRules = null) {
  const m = playableMode(id) || findMode('solo');
  const g = m.rules && hasOwn(GAMES, m.rules.win) ? GAMES[m.rules.win] : null;
  const deltas = { ...(g && g.defaults), ...m.rules };
  if (prevRules && !hasOwn(m.rules, 'botSkill')) deltas.botSkill = prevRules.botSkill;
  return withMirror({ modeId: m.id, rules: normalizeRules(deltas, GAME_OPTS), info: modeInfo(m), custom: false });
}

/** Room settings for a custom mode (the creator, or a code from a friend). */
export function customSettings(rules, name) {
  const r = normalizeRules(rules, GAME_OPTS);
  const title = cleanText(name, 40) || 'Custom Mode';
  return withMirror({
    modeId: 'custom', rules: r, custom: true,
    info: { name: title, emoji: '🛠️', color: '#2fd6c3', desc: 'A custom mode made in the creator.', tags: modeTags(r) },
  });
}

/**
 * Room settings from anything a transport passes in: {modeId, rules, info, custom} (a party
 * carrying its mode over), or the legacy {mode: 'ffa' | 'squad', bots, mats}.
 */
export function settingsFrom(input, solo = false) {
  const src = input && typeof input === 'object' ? input : {};
  if (src.rules && typeof src.rules === 'object') {
    const m = !src.custom && playableMode(src.modeId);
    if (m) return withMirror({ modeId: m.id, rules: normalizeRules(src.rules, GAME_OPTS), info: modeInfo(m), custom: false });
    return customSettings(src.rules, src.info && src.info.name);
  }
  if (typeof src.modeId === 'string' && playableMode(src.modeId)) return modeSettings(src.modeId);
  // legacy: {mode, bots, mats}
  const legacy = typeof src.mode === 'string' && hasOwn(LEGACY_MODES, src.mode) ? src.mode : 'ffa';
  const s = modeSettings(legacy === 'squad' ? 'squadbots' : 'solo');
  const bots = src.bots !== undefined ? num(src.bots, 0) : solo ? 19 : 8;
  s.rules = normalizeRules({ ...s.rules, ...LEGACY_MODES[legacy], bots, mats: num(src.mats, 0) }, GAME_OPTS);
  return withMirror(s);
}

/** Tweak bots / bot difficulty / start materials of the current settings (lobby only). */
function tweakSettings(s, { bots, botSkill, mats } = {}) {
  const d = { ...s.rules };
  if (typeof bots === 'number' && Number.isFinite(bots)) d.bots = bots;
  if (typeof botSkill === 'string') d.botSkill = botSkill;
  if (typeof mats === 'number' && Number.isFinite(mats)) d.mats = mats;
  return withMirror({ ...s, rules: normalizeRules(d, GAME_OPTS) });
}

export class Room {
  /**
   * settings: the mode ({modeId, rules, info, custom}, or the legacy {bots, mats, mode}).
   * maxHumans: party size limit. plugins: room plugins (default ROOM_PLUGINS).
   */
  constructor({
    code = 'SOLO', name = 'Party', solo = false, now = () => Date.now(), log = () => {},
    settings = null, maxHumans = MAX_HUMANS, plugins = ROOM_PLUGINS,
  } = {}) {
    this.code = code;
    this.name = name;
    this.solo = solo;
    this.now = now;
    this.log = log;
    this.maxHumans = maxHumans;
    this.created = now();
    this.world = getWorld();
    this.destroyed = new Set();
    this.objHp = new Map();
    this.grid = new BuildGrid(this.world.heightAt, this.world.solidNear);
    this.grid.destroyedObjects = this.destroyed;
    this.players = new Map();
    this.conns = new Map();   // connId -> { conn, pid }
    this.nextId = 1;
    this.phase = 'lobby';
    this.phaseEnds = 0;
    this.leader = 0;
    this.settings = settingsFrom(settings, solo);
    // the rules of the next / current match (settings.rules, plus mutators while one runs)
    this.rules = rulesFromSettings(this.settings, GAME_OPTS);
    this.runtime = new ModeRuntime(this);
    this.loot = new Map();
    this.nextLoot = 1;
    this.lootSeed = 0;
    this.chestsOpened = new Set();
    this.storm = null;
    this.bus = null;
    this.area = null;
    this.teamList = [];
    this.spawnCands = [];
    this.match = 0;
    this.stormTick = 0;
    this.modeTickT = 0;
    this.starters = 0;
    this.startTeams = 0;
    this.humansOutAt = 0;
    this.elimDepth = 0;
    this.pendingEnd = null;
    this.rolesHeld = false;   // the mode's set-up is running: roles go out after the start message
    this.rosterDirty = false;
    this.teamsDirty = false;
    this.round = null;        // best-of-N series: {n, series: {team: wins}, need}
    this.mystery = null;      // {at, key}: the mystery mutator running
    this.lastTick = now();
    this.empty = false;
    this.winner = null;
    // room plugins: their message handlers come before the Room's own (this.baseHandlers)
    this.plugins = plugins.slice();
    this.baseHandlers = HANDLERS;
    this.pluginHandlers = Object.create(null);
    for (const pl of this.plugins) if (pl.handlers) Object.assign(this.pluginHandlers, pl.handlers);
    this.plug('init', this);
  }

  // ------------------------------------------------------------------ plugins
  /** Run hook `name` on every room plugin that has it. A plugin error is logged, never thrown. */
  plug(name, a, b, c, d) {
    for (const pl of this.plugins) {
      if (typeof pl[name] !== 'function') continue;
      try { pl[name](a, b, c, d); } catch (e) { this.plugError(pl, name, e); }
    }
  }

  /** The first true / false answer of hook `name` (undefined when no plugin answers). */
  plugAnswer(name, a, b, c) {
    for (const pl of this.plugins) {
      if (typeof pl[name] !== 'function') continue;
      try {
        const r = pl[name](a, b, c);
        if (r === true || r === false) return r;
      } catch (e) { this.plugError(pl, name, e); }
    }
    return undefined;
  }

  /** Add the extra fields that plugins return from hook `name` to obj. */
  plugExtra(obj, name, a, b) {
    for (const pl of this.plugins) {
      if (typeof pl[name] !== 'function') continue;
      try {
        const x = pl[name](a, b);
        if (x && typeof x === 'object') Object.assign(obj, x);
      } catch (e) { this.plugError(pl, name, e); }
    }
    return obj;
  }

  plugError(pl, hook, e) {
    this.log('plugin error', { plugin: pl.name, hook, err: String((e && e.stack) || e) });
  }

  // ------------------------------------------------------------------ util
  humans() { return [...this.players.values()].filter((p) => !p.bot); }
  alivePlayers() { return [...this.players.values()].filter((p) => p.alive); }

  aliveCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.alive) n++;
    return n;
  }

  /** Players still in the match: alive, or waiting to respawn. */
  inGameCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.inMatch && (p.alive || p.respawnAt > 0)) n++;
    return n;
  }

  /**
   * Is a human's team still in the match (anyone on it alive or respawning)? A human whose bot
   * teammate fights on is still in it, spectating their team.
   */
  humansInGame() {
    let teams = null;
    for (const p of this.players.values()) if (!p.bot && p.inMatch) (teams || (teams = new Set())).add(p.team);
    if (!teams) return false;
    for (const p of this.players.values()) if (p.inMatch && (p.alive || p.respawnAt > 0) && teams.has(p.team)) return true;
    return false;
  }

  /** How many teams still have someone in the game. */
  teamsInGame() {
    const s = new Set();
    for (const p of this.players.values()) if (p.inMatch && (p.alive || p.respawnAt > 0)) s.add(p.team);
    return s.size;
  }

  send(conn, msg) { try { conn.send(msg); } catch (e) { /* ignore */ } }

  broadcast(msg, exceptConnId = null) {
    for (const { conn } of this.conns.values()) {
      if (conn.id !== exceptConnId) this.send(conn, msg);
    }
  }

  connOf(p) {
    const ownerId = p.bot ? p.owner : p.id;
    for (const c of this.conns.values()) if (c.pid === ownerId) return c.conn;
    return null;
  }

  /** The first human who is connected and not held away (join order), or null. */
  firstPresent(except = 0) {
    for (const p of this.players.values()) if (!p.bot && p.id !== except && !p.away && this.connOf(p)) return p;
    return null;
  }

  /**
   * Remove a player for good (left, a rejoin hold ran out, a held player was kicked): the mode
   * hears about it (onKill) but never respawns them, and stops counting them (runtime.list), in
   * every phase (a series' round break too, or the next round would revive a ghost). The caller
   * re-checks the win afterwards: the elimination's own checkWin still saw the player listed.
   */
  removePlayer(p) {
    p.leaving = true; // before the elimination, so the mode's onKill sees it
    p.respawnAt = 0;
    if (p.alive && (this.phase === 'match' || this.phase === 'bus')) this.eliminate(p, null, { c: 'left' });
    p.inMatch = false;
    p.respawnAt = 0;
    this.players.delete(p.id);
    this.runtime.list = this.runtime.list.filter((q) => q !== p);
    if (p.watch) { p.watch = 0; this.tellWatch(p); }
    this.broadcast({ t: 'note', msg: `${p.name} left` });
  }

  roster() {
    return [...this.players.values()].map((p) => {
      const row = { id: p.id, name: p.name, skin: p.skin, bot: p.bot, alive: p.alive, kills: p.kills, spec: p.spectator, team: p.team };
      if (p.bot && p.skill !== undefined) row.skill = p.skill;
      return this.plugExtra(row, 'roster', p);
    });
  }

  publicInfo(ip) {
    const humans = this.humans();
    return {
      code: this.code, name: this.name, phase: this.phase, players: humans.length,
      max: this.maxHumans, sameNet: !!ip && humans.some((p) => p.ip === ip),
    };
  }

  /** Which player may this connection act as? */
  actor(connId, id) {
    const c = this.conns.get(connId);
    if (!c) return null;
    if (id === undefined || id === null || id === c.pid) return this.players.get(c.pid) || null;
    const p = this.players.get(id);
    if (p && p.bot && p.owner === c.pid) return p;
    return null;
  }

  // ------------------------------------------------------------------ connections
  join(conn, hello = {}) {
    // a friend whose page is still on an older (or newer) build would play by different rules
    if ((hello.v | 0) !== PROTOCOL) {
      this.send(conn, { t: 'err', ver: true, msg: 'Phortnite was updated, and this page is on a different version than your friends. Everyone should reload the page, then try again.' });
      return false;
    }
    // a room plugin may take the join over (e.g. a rejoin after a dropped connection)
    const took = this.plugAnswer('onJoin', this, conn, hello);
    if (took !== undefined) return took;
    if (this.humans().length >= this.maxHumans) {
      this.send(conn, { t: 'err', msg: 'This party is full.' });
      return false;
    }
    const id = this.nextId++;
    const p = this.makePlayer(id, cleanName(hello.name), clampN(num(hello.skin) | 0, 0, SKINS.length - 1), false);
    p.ip = conn.ip || '';
    if (this.phase === 'lobby') {
      p.alive = true;
    } else {
      p.alive = false;
      p.spectator = true;
    }
    this.players.set(id, p);
    this.conns.set(conn.id, { conn, pid: id, last: this.now() });
    // a leader who is away (held for a rejoin) cannot start: the newcomer leads
    const lp = this.players.get(this.leader);
    if (!lp || lp.away || !this.connOf(lp)) this.leader = id;
    this.send(conn, this.welcome(id));
    this.broadcast({ t: 'roster', players: this.roster(), leader: this.leader }, conn.id);
    this.broadcast({ t: 'note', msg: `${p.name} joined the party` }, conn.id);
    this.log('join', { room: this.code, id, name: p.name });
    return true;
  }

  leave(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    const p = this.players.get(c.pid);
    // its page is gone: it watches nobody now (held for a rejoin or not)
    if (p && p.watch) { p.watch = 0; this.tellWatch(p); }
    // a room plugin may keep the player instead (e.g. held for a rejoin)
    if (this.plugAnswer('onLeave', this, c, p) === true) return;
    if (p) this.removePlayer(p);
    const humans = this.humans();
    if (!humans.length) {
      this.empty = true;
      return;
    }
    // someone who is here leads (a held player cannot start); all held: the first to come back will
    if (this.leader === c.pid || !this.players.has(this.leader)) this.leader = (this.firstPresent() || humans[0]).id;
    this.reassignBots();
    this.broadcast({ t: 'roster', players: this.roster(), leader: this.leader });
    if (this.phase === 'match' || this.phase === 'bus') this.checkWin();
  }

  makePlayer(id, name, skin, bot) {
    return {
      id, name, skin, bot, owner: 0, alive: false, spectator: false, hp: PLAYER.maxHp, sh: PLAYER.startShield, kills: 0, team: id,
      x: 0, y: 60, z: 0, vx: 0, vy: 0, vz: 0, yw: 0, pt: 0, a: ANIM.IDLE, w: 'pickaxe', f: 0,
      inBus: false, ip: '', lastSeen: this.now(),
      // mode state (shared/modes/api.js Player)
      maxHp: PLAYER.maxHp, role: null, armor: 1, lives: 1, respawnAt: 0, keepLoot: false, inMatch: false, lo: null, dmg: 0,
    };
  }

  /** If the device simulating the bots goes quiet, hand them to someone who is active. */
  checkBotOwner() {
    const now = this.now();
    let owner = 0;
    for (const p of this.players.values()) if (p.bot) { owner = p.owner; break; }
    if (!owner) return;
    let ownerConn = null;
    for (const c of this.conns.values()) if (c.pid === owner) ownerConn = c;
    if (ownerConn && now - ownerConn.last < 5000) return;
    let next = null;
    for (const c of this.conns.values()) {
      if (c.pid !== owner && now - c.last < 3000) { next = c; break; }
    }
    if (!next) return;
    if (ownerConn) this.send(ownerConn.conn, { t: 'bots', own: [] });
    this.reassignBots(next.pid);
  }

  /**
   * Hand every bot to player `to` ({t:'bots', own}). Mid-match the new owner also gets each live
   * bot's current mode loadout ('lo', after 'bots' on the same channel): a bot taken over keeps its
   * gun game rung or kit instead of starting again with a pickaxe (resend false: the start message
   * already carries the loadouts).
   */
  reassignBots(to = this.leader, resend = true) {
    const owner = this.players.get(to);
    if (!owner) return;
    const own = [];
    for (const p of this.players.values()) {
      if (p.bot) { p.owner = owner.id; own.push(p.id); }
    }
    const conn = this.connOf(owner);
    if (!conn) return;
    this.send(conn, { t: 'bots', own });
    if (resend && (this.phase === 'match' || this.phase === 'bus' || this.phase === 'round')) {
      for (const p of this.players.values()) if (p.bot && p.alive && p.lo) this.send(conn, { t: 'lo', id: p.id, lo: p.lo });
      // and who watches which bot
      for (const p of this.players.values()) if (!p.bot && p.watch) this.send(conn, { t: 'watch', from: p.id, id: p.watch });
    }
  }

  welcome(id) {
    const live = this.phase === 'match' || this.phase === 'bus' || this.phase === 'ended' || this.phase === 'round';
    const roles = [];
    for (const p of this.players.values()) if (p.role) roles.push([p.id, p.role]);
    return this.plugExtra({
      t: 'welcome', v: PROTOCOL, you: id, code: this.code, name: this.name, solo: this.solo,
      checksum: this.world.checksum, phase: this.phase === 'round' ? 'match' : this.phase, leader: this.leader, settings: this.settings,
      players: this.roster(),
      builds: [...this.grid.pieces.values()].map((b) => this.pieceMsg(b)),
      destroyed: [...this.destroyed],
      loot: [...this.loot.values()],
      chests: [...this.chestsOpened],
      bus: this.bus ? this.busMsg() : null,
      match: this.match,
      // the match being played (late joiners and rejoins)
      rules: this.rules,
      teams: live ? this.teamList : [],
      area: live ? this.area : null,
      ms: live ? this.runtime.ms : null,
      roles,
      chestsOff: live && this.rules.chests === false,
      round: live && this.round ? { n: this.round.n, series: this.round.series } : null,
    }, 'welcome', this, id);
  }

  // ------------------------------------------------------------------ messages
  message(connId, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const c = this.conns.get(connId);
    if (!c) return;
    c.last = this.now();
    const h = this.pluginHandlers[msg.t] || (hasOwn(HANDLERS, msg.t) ? HANDLERS[msg.t] : null);
    if (!h) return;
    try {
      h.call(this, c, msg);
    } catch (e) {
      this.log('handler error', { t: msg.t, err: String(e && e.stack || e) });
    }
  }

  get handlers() {
    return HANDLERS;
  }

  /** New settings (lobby): the next match's rules follow them; everyone hears about it. */
  setSettings(s) {
    this.settings = s;
    this.rules = rulesFromSettings(s, GAME_OPTS);
    this.broadcast({ t: 'settings', settings: s });
  }

  /** Old clients' {mode, bots, mats} (the legacy 'settings' / 'start' fields) as mode / tweak changes. */
  legacySettings(m) {
    let s = this.settings;
    if ((m.mode === 'ffa' || m.mode === 'squad') && m.mode !== s.mode) s = modeSettings(m.mode === 'squad' ? 'squadbots' : 'solo', s.rules);
    const t = {};
    if (m.bots !== undefined) t.bots = clampN(num(m.bots) | 0, 0, 31);
    if (m.mats !== undefined) t.mats = clampN(num(m.mats) | 0, 0, MAX_MATS);
    if (typeof m.botSkill === 'string') t.botSkill = m.botSkill;
    if (s !== this.settings || Object.keys(t).length) s = tweakSettings(s, t);
    return s;
  }

  // ------------------------------------------------------------------ match flow
  startMatch() {
    if (this.phase !== 'lobby') return;
    const R = this.rules = rulesFromSettings(this.settings, GAME_OPTS);
    const now = this.now();
    this.match++;
    this.winner = null;
    this.resetWorldState();
    this.humansOutAt = 0;
    this.pendingEnd = null;
    this.mystery = R.mystery ? { at: now + MYSTERY_EVERY, key: '' } : null;
    this.round = R.rounds > 1 ? { n: 1, series: {}, need: Math.ceil(R.rounds / 2) } : null;
    // remove stale bots, create new ones
    for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
    const humans = this.humans();
    const botCount = botCountFor(R, humans.length, MAX_TOTAL);
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    const bots = [];
    for (let i = 0; i < botCount; i++) {
      const id = this.nextId++;
      const b = this.makePlayer(id, names[i % names.length], Math.floor(Math.random() * SKINS.length), true);
      b.owner = this.leader;
      b.skill = Math.round(rollBotSkill(R.botSkill, Math.random, i) * 100) / 100;
      this.players.set(id, b);
      bots.push(b);
    }
    this.teamList = assignTeams(humans, bots, R);
    const all = [...humans, ...bots];
    // how many sides started (a series ends early once only one of them is left)
    this.startTeams = new Set(all.map((p) => p.team)).size;
    for (const p of all) {
      this.resetForMatch(p);
      p.kills = 0;
      p.dmg = 0;
      p.lives = R.lives;
    }
    this.starters = all.length;
    this.area = resolveArea(this.world, R.area);
    this.lootSeed = (Math.floor(Math.random() * 0x7fffffff) ^ (this.match * 7919)) >>> 0;
    this.runtime.begin(R, this.area, this.lootSeed, all, this.teamList);
    const { spawns, busTime } = this.placeEveryone(all, now);
    this.spawnInitialLoot();
    // the mode's set-up, then everyone's loadout (its roles go out after the start: sendRoles)
    this.rolesHeld = true;
    try { this.runtime.setup(() => makeLoadout(R, Math.random)); } finally { this.rolesHeld = false; }
    if (R.timeLimit > 0) this.runtime.endsAt = now + (busTime + R.timeLimit) * 1000;
    this.stormTick = now;
    this.modeTickT = now;
    this.broadcast({
      t: 'start', match: this.match, bus: this.bus ? this.busMsg() : null, players: this.roster(), leader: this.leader,
      settings: this.settings, rules: R, modeId: this.settings.modeId, teams: this.teamList, spawns,
      lootSeed: this.lootSeed, lootN: this.loot.size, lo: this.startLoadouts(), chestsOff: R.chests === false, area: this.area,
      round: this.round ? { n: 1, series: {} } : null,
    });
    this.sendRoles(all);
    this.reassignBots(this.leader, false);
    this.plug('onStart', this);
    this.log('match start', { room: this.code, players: this.players.size, mode: this.settings.modeId });
  }

  /** Match-start state of a player taking part. */
  resetForMatch(p) {
    const R = this.rules;
    p.watch = 0;
    p.alive = true;
    p.spectator = false;
    p.inMatch = true;
    p.leaving = false;
    p.maxHp = R.hp;
    p.hp = R.hp;
    p.sh = R.shield;
    p.role = null;
    p.armor = 1;
    p.respawnAt = 0;
    p.keepLoot = false;
    p.lo = null;
    p.vx = 0; p.vy = 0; p.vz = 0;
  }

  /**
   * Storm, bus and spawns for the start of a match (or a round): returns the start message's
   * spawns ({id: [x, y, z, how]}, null with the bus) and how long the bus flies (s).
   */
  placeEveryone(all, now) {
    const R = this.rules;
    const sky = R.spawn === 'sky';
    let busTime = 0;
    this.bus = null;
    if (R.spawn === 'bus') {
      this.makeBus(now);
      busTime = this.bus.len / this.bus.speed;
    }
    this.storm = this.makeStorm(now, busTime);
    // spawn where the first circle is, when it is smaller than the area
    const st = this.storm;
    const spawnArea = st && st.r < this.area.r ? { x: st.cx, z: st.cz, r: st.r * 0.85 } : this.area;
    this.spawnCands = spawnCandidates(this.world, spawnArea, Math.random);
    let spawns = null;
    if (this.bus) {
      this.phase = 'bus';
      for (const p of all) { p.inBus = true; p.a = ANIM.BUS; }
    } else {
      this.phase = 'match';
      spawns = {};
      const at = pickSpawns(this.world, spawnArea, all, Math.random, this.spawnCands);
      for (const p of all) {
        const s = at.get(p.id);
        p.inBus = false;
        p.x = s.x; p.z = s.z; p.y = s.y + (sky ? SKY_SPAWN_HEIGHT : 0);
        p.a = sky ? ANIM.SKYDIVE : ANIM.IDLE;
        spawns[p.id] = [r2(p.x), r2(p.y), r2(p.z), sky ? 'sky' : 'ground'];
      }
    }
    return { spawns, busTime };
  }

  /** Start loadouts grouped for the start message: [[Loadout, [ids]]]. */
  startLoadouts() {
    const groups = new Map();
    for (const [id, lo] of this.runtime.startLo) {
      const k = JSON.stringify(lo);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = [lo, []]));
      g[1].push(id);
    }
    return [...groups.values()];
  }

  /** A loadout mid-match: to the device that plays p (bots: their owner). */
  sendLoadout(p, lo) {
    const conn = this.connOf(p);
    if (conn) this.send(conn, { t: 'lo', id: p.id, lo });
  }

  resetWorldState() {
    this.grid.clear();
    this.destroyed.clear();
    this.objHp.clear();
    this.loot.clear();
    this.nextLoot = 1;
    this.chestsOpened.clear();
  }

  /** The bus flies over the play area's centre, across as much land as it can find. */
  makeBus(now) {
    const A = this.area;
    const full = this.rules.area === 'full';
    const len = full ? BUS.length : clampN(A.r * 2.5 + 160, 320, BUS.length);
    let best = null;
    for (let t = 0; t < 14; t++) {
      const ang = Math.random() * Math.PI * 2;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const off = (Math.random() - 0.5) * (full ? 140 : Math.min(140, A.r * 0.6));
      const cx = A.x - dz * off, cz = A.z + dx * off;
      let land = 0;
      for (let i = 0; i <= 20; i++) {
        const f = -0.35 + (0.7 * i) / 20;
        if (this.world.heightAt(cx + dx * len * f, cz + dz * len * f) > 1) land++;
      }
      if (!best || land > best.land) best = { cx, cz, dx, dz, land };
      // the whole island: any path over mostly land will do (keeps the routes varied)
      if (land >= 13) break;
    }
    const { cx, cz, dx, dz } = best;
    const ax = cx - dx * len / 2, az = cz - dz * len / 2;
    this.bus = { ax: r2(ax), az: r2(az), bx: r2(ax + dx * len), bz: r2(az + dz * len), y: BUS.height, speed: BUS.speed, len, t0: now };
  }

  busMsg() {
    const b = this.bus;
    return { ax: b.ax, az: b.az, bx: b.bx, bz: b.bz, y: b.y, speed: b.speed, el: (this.now() - b.t0) / 1000 };
  }

  busPos() {
    const b = this.bus;
    const t = Math.min(1, ((this.now() - b.t0) / 1000) * b.speed / b.len);
    // everyone still on board is pushed out before the bus leaves the island
    return { x: b.ax + (b.bx - b.ax) * t, y: b.y, z: b.az + (b.bz - b.az) * t, done: t >= BUS.forceDrop };
  }

  // ------------------------------------------------------------------ storm
  /** The first circle of rules.storm (null: no storm). Its centre is always on land. */
  makeStorm(now, busTime) {
    const P = own(STORM_PRESETS, this.rules.storm) ? STORM_PRESETS[this.rules.storm] : null;
    if (!P) return null;
    const A = this.area;
    let cx = A.x, cz = A.z, r;
    if (P.start === 'region') {
      const regions = (this.world.regions || []).filter((g) => g.named !== false && Math.hypot(g.x - A.x, g.z - A.z) < A.r && this.world.heightAt(g.x, g.z) > 1.5);
      const g = regions.length ? regions[Math.floor(Math.random() * regions.length)] : null;
      if (g) { cx = g.x; cz = g.z; }
      r = Math.min(P.startRadius, A.r * 1.25);
    } else if (P.startRadius > 200) {
      r = this.rules.area === 'full' ? P.startRadius : A.r * 1.25;
    } else {
      r = Math.min(P.startRadius, A.r * 1.25);
    }
    const s = {
      i: 0, cx, cz, r, ncx: cx, ncz: cz, nr: r, state: 'wait', t0: now, tEnd: 0, phases: P.phases, moving: !!P.moving, cut: false,
    };
    if (!(this.world.heightAt(cx, cz) > 1.5) || nearLava(this.world, cx, cz, LAVA_PAD)) {
      const l = this.landNear(cx, cz, r);
      s.cx = s.ncx = l.x; s.cz = s.ncz = l.z;
    }
    this.storm = s;
    this.pickNextCircle();
    s.tEnd = now + (busTime + P.phases[0].wait) * 1000;
    return s;
  }

  /** The land spot nearest to (x, z): a spawn candidate, a place, else (x, z) itself. */
  landNear(x, z) {
    let best = null, bd = Infinity;
    const consider = (px, pz) => {
      if (!(this.world.heightAt(px, pz) > 1.5) || nearLava(this.world, px, pz, LAVA_PAD)) return;
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; best = { x: px, z: pz }; }
    };
    for (const c of this.spawnCands) consider(c.x, c.z);
    if (!best) for (const s of this.world.spawnPoints || []) consider(s.x, s.z);
    if (!best) for (const g of this.world.regions || []) consider(g.x, g.z);
    return best || { x, z };
  }

  /**
   * The next circle: inside the current one, no further out than the play area allows, centred on
   * land. Moving presets (zone wars) may poke out of the old circle; the last 2 phases of every
   * preset drift up to 40 m further.
   */
  pickNextCircle() {
    const s = this.storm;
    const ph = s.phases[s.i];
    const A = this.area;
    s.nr = s.r * ph.ratio;
    const lastTwo = s.i >= s.phases.length - 2;
    const maxD = (s.r - s.nr) * 0.9 + (s.moving ? s.nr * 0.5 : 0) + (lastTwo ? 40 : 0);
    const lim = Math.max(A.r * 0.73, Math.hypot(s.cx - A.x, s.cz - A.z));
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * maxD;
      const x = s.cx + Math.cos(a) * d, z = s.cz + Math.sin(a) * d;
      // never a circle around the volcano's lava pool (its crater is a pit: lava inside, storm outside)
      if (Math.hypot(x - A.x, z - A.z) + s.nr * 0.35 <= lim && this.world.heightAt(x, z) > 1.5
        && !nearLava(this.world, x, z, LAVA_PAD + Math.min(s.nr, 10))) {
        s.ncx = x; s.ncz = z;
        return;
      }
    }
    // nowhere new on land: stay put if that is land, else the nearest land
    if (this.world.heightAt(s.cx, s.cz) > 1.5 && !nearLava(this.world, s.cx, s.cz, LAVA_PAD)) { s.ncx = s.cx; s.ncz = s.cz; return; }
    const l = this.landNear(s.cx, s.cz);
    s.ncx = l.x; s.ncz = l.z;
  }

  stormNow() {
    const s = this.storm;
    if (!s) return null;
    if (s.state !== 'shrink') return { cx: s.cx, cz: s.cz, r: s.r };
    const t = clampN((this.now() - s.t0) / (s.tEnd - s.t0), 0, 1);
    return { cx: s.cx + (s.ncx - s.cx) * t, cz: s.cz + (s.ncz - s.cz) * t, r: s.r + (s.nr - s.r) * t };
  }

  updateStorm() {
    const s = this.storm;
    if (!s || s.state === 'done') return;
    const now = this.now();
    // few players left: don't make them wait long for the next circle (once per phase)
    if (s.state === 'wait' && !s.cut && this.phase === 'match' && s.tEnd - now > 20000
      && this.inGameCount() <= Math.max(3, Math.ceil(this.starters * 0.35))) {
      s.cut = true;
      s.tEnd = now + 20000;
      this.broadcast({ t: 'note', msg: 'Storm eye shrinks in 20 seconds', storm: true });
    }
    if (now < s.tEnd) return;
    if (s.state === 'wait') {
      s.state = 'shrink';
      s.t0 = now;
      s.tEnd = now + s.phases[s.i].shrink * 1000;
      this.broadcast({ t: 'note', msg: 'The storm eye is shrinking!', storm: true });
    } else {
      s.cx = s.ncx; s.cz = s.ncz; s.r = s.nr;
      s.i++;
      if (s.i >= s.phases.length) {
        s.state = 'done';
        s.i = s.phases.length - 1;
        return;
      }
      s.state = 'wait';
      s.cut = false;
      s.t0 = now;
      s.tEnd = now + s.phases[s.i].wait * 1000;
      this.pickNextCircle();
      this.broadcast({ t: 'note', msg: `Storm eye shrinks in ${s.phases[s.i].wait} seconds`, storm: true });
    }
  }

  stormMsg() {
    const s = this.storm;
    if (!s) return null;
    const cur = this.stormNow();
    const ph = s.phases[Math.min(s.i, s.phases.length - 1)];
    return [
      r2(cur.cx), r2(cur.cz), r2(cur.r), r2(s.ncx), r2(s.ncz), r2(s.nr),
      Math.max(0, Math.round((s.tEnd - this.now()) / 1000)), s.state === 'shrink' ? 1 : s.state === 'done' ? 2 : 0, s.i, ph.dps,
    ];
  }

  /** Is p standing in a lava zone (world.lava: [{x, z, r, y?}])? */
  inLava(p) {
    const lava = this.world.lava;
    if (!lava || !lava.length) return false;
    for (const L of lava) {
      if (!L || !(L.r > 0)) continue;
      const dx = p.x - L.x, dz = p.z - L.z;
      if (dx * dx + dz * dz > L.r * L.r) continue;
      const top = (Number.isFinite(L.y) ? L.y : this.world.heightAt(p.x, p.z)) + 1.2;
      if (p.y < top) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ eliminations and the end
  eliminate(victim, killer, info = {}) {
    if (!victim.alive) return;
    this.elimDepth++;
    try {
      victim.alive = false;
      victim.hp = 0;
      victim.sh = 0;
      victim.a = ANIM.DEAD;
      victim.respawnAt = 0;
      if (killer && killer !== victim) killer.kills++;
      const live = this.phase === 'match' || this.phase === 'bus';
      if (live && victim.inMatch && this.rules.lives > 0) victim.lives = Math.max(0, victim.lives - 1);
      // the mode decides about a respawn first, so the elimination can say so
      if (live && victim.inMatch) this.runtime.onKill(victim, killer, info);
      const left = this.aliveCount();
      const rs = victim.respawnAt > 0 ? Math.round((victim.respawnAt - this.now()) / 100) / 10 : 0;
      this.broadcast({
        t: 'elim', v: victim.id, k: killer ? killer.id : 0, w: info.w || '', hs: !!info.hs, c: info.c || 'gun',
        place: left + 1, x: r2(victim.x), y: r2(victim.y), z: r2(victim.z), rs, lives: victim.lives,
      });
      this.siphon(killer, victim);
      this.plug('onElim', this, victim, killer, info);
    } finally {
      this.elimDepth--;
    }
    if (this.elimDepth === 0 && this.pendingEnd) {
      const res = this.pendingEnd;
      this.pendingEnd = null;
      this.endMatch(res);
      return;
    }
    if (this.elimDepth === 0) {
      this.checkWin();
      // the respawn timer goes out right away
      if (victim.respawnAt > 0 && (this.phase === 'match' || this.phase === 'bus')) {
        this.runtime.msNext = 0;
        const ms = this.runtime.modeState(this.now());
        if (ms) this.broadcast(ms);
      }
    }
  }

  /**
   * Elimination siphon: the killer instantly gets rules.siphon back, health first (up to max)
   * and the rest as shield. Storm / fall / left deaths have no killer and give nothing, and a
   * killer who died first (a rocket still in flight) gets nothing either.
   */
  siphon(killer, victim) {
    const amt = this.rules.siphon;
    if (!amt || !killer || killer === victim || !killer.alive || this.sameTeam(killer, victim)) return;
    const maxHp = killer.maxHp || PLAYER.maxHp;
    const dh = Math.min(amt, Math.max(0, maxHp - killer.hp));
    const ds = Math.min(amt - dh, Math.max(0, PLAYER.maxShield - killer.sh));
    if (dh + ds <= 0) return;
    const hp0 = Math.ceil(killer.hp), sh0 = Math.ceil(killer.sh);
    killer.hp = Math.min(maxHp, killer.hp + dh);
    killer.sh = Math.min(PLAYER.maxShield, killer.sh + ds);
    // the killer's device shows it right away; snapshots carry the same values afterwards.
    // dh/ds are what the (rounded-up) bars gain, so the "+N" popups always match the bars.
    const hp = Math.ceil(killer.hp), sh = Math.ceil(killer.sh);
    this.broadcast({ t: 'siphon', id: killer.id, amt: hp - hp0 + sh - sh0, dh: hp - hp0, ds: sh - sh0, hp, sh });
  }

  /**
   * After every elimination and at 10 Hz: the mode's verdict ends the match. When every human is
   * out (and nobody respawns) the bots play on for up to 20 s of spectating, then the match ends
   * as 'humans-out': a bot is never crowned just for outlasting the humans.
   */
  checkWin() {
    if ((this.phase !== 'match' && this.phase !== 'bus') || this.elimDepth > 0) return;
    const res = this.runtime.checkWin();
    if (this.phase !== 'match' && this.phase !== 'bus') return; // the game ended it itself (ctx.end)
    let humans = false;
    for (const p of this.players.values()) if (!p.bot && p.inMatch) { humans = true; break; }
    const humansIn = this.humansInGame();
    if (res) {
      // the humans' teams are all out: a bot is never crowned (in a best-of-N series a round
      // simply goes to whoever is left)
      if (humans && !humansIn && !this.round) {
        const face = res.id ? this.players.get(res.id) : res.team !== undefined && res.team !== null ? this.teamFace(res.team) : null;
        if (!face || face.bot) { this.endMatch({ id: 0, reason: 'humans-out' }); return; }
      }
      this.endMatch(res);
      return;
    }
    if (humans && !humansIn && !this.humansOutAt) this.humansOutAt = this.now() + HUMANS_OUT_MS;
  }

  /** The best player to stand for a winning team: an alive human, a human, anyone alive, anyone. */
  teamFace(team) {
    let best = null, bs = -1;
    for (const p of this.players.values()) {
      if (p.team !== team || !p.inMatch) continue;
      const s = (p.bot ? 0 : 2) + (p.alive ? 1 : 0);
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  /**
   * End the match (or the round) with a result {id?, team?, reason}: broadcasts
   * {t:'win', id, team, name, bot, early, reason, scores, byTeam, mvp}; id 0 = nobody (humans-out).
   */
  endMatch(res = {}) {
    if (this.phase !== 'match' && this.phase !== 'bus') return;
    if (this.elimDepth > 0) { if (!this.pendingEnd) this.pendingEnd = res; return; }
    const humansOut = res.reason === 'humans-out';
    let w = null;
    if (!humansOut) {
      if (res.id) w = this.players.get(res.id) || null;
      if (!w && res.team !== undefined && res.team !== null) w = this.teamFace(res.team);
    }
    let team = w ? w.team : 0;
    // best of N: a round is over, not the match (until a team has enough round wins); the
    // series goes to the team with the most round wins. A forfeit (the other side left) goes to
    // the side still here, whatever the round score.
    if (this.round && !humansOut && !res.forfeit) {
      if (this.roundWon(team, res)) return;
      let best = 0, bw = 0, tie = false;
      for (const [k, n] of Object.entries(this.round.series)) {
        if (n > bw) { bw = n; best = +k; tie = false; } else if (n === bw) tie = true;
      }
      w = best && !tie ? this.teamFace(best) : null;
      team = w ? w.team : 0;
    }
    this.runtime.ended = true;
    this.phase = 'ended';
    this.winner = w ? w.id : 0;
    this.humansOutAt = 0;
    this.phaseEnds = this.now() + (humansOut ? 7000 : 10000);
    const listed = this.teamList.find((t) => t.id === team);
    let name = '';
    if (w) {
      if (listed && this.rules.teams === 'humans') name = 'Your squad';
      else if (listed) name = `${listed.name} Team`;
      else name = w.name;
    }
    const sc = this.runtime.scores();
    const byTeam = sc.length > 0 && this.runtime.teamScores();
    const scores = sc.length ? sc.slice(0, 8)
      : [...this.players.values()].filter((p) => p.inMatch && p.kills > 0).sort((a, b) => b.kills - a.kills).slice(0, 8).map((p) => [p.id, p.kills]);
    this.broadcast({
      t: 'win', id: this.winner, team, name, bot: w ? w.bot : false, early: this.teamsInGame() > 1,
      reason: res.reason || 'last', scores, byTeam, mvp: this.mvp(), draw: !!res.draw && !w,
      round: this.round ? { n: this.round.n, series: this.round.series } : undefined,
    });
  }

  /** Most eliminations (then most damage): {id, name, kills, dmg}, or null. */
  mvp() {
    let best = null;
    for (const p of this.players.values()) {
      if (!p.inMatch) continue;
      if (!best || p.kills > best.kills || (p.kills === best.kills && p.dmg > best.dmg)) best = p;
    }
    if (!best || (best.kills === 0 && best.dmg === 0)) return null;
    return { id: best.id, name: best.name, kills: best.kills, dmg: Math.round(best.dmg), bot: best.bot };
  }

  // ------------------------------------------------------------------ rounds (best of N)
  /** Count a round win; true when the series goes on (a 4 s break, then the next round). */
  roundWon(team, res) {
    const r = this.round;
    if (team) r.series[team] = (r.series[team] || 0) + 1;
    const wins = team ? r.series[team] : 0;
    if (wins >= r.need || r.n >= this.rules.rounds) return false;
    this.phase = 'round';
    this.phaseEnds = this.now() + ROUND_BREAK;
    this.humansOutAt = 0;
    const listed = this.teamList.find((t) => t.id === team);
    const w = team ? this.teamFace(team) : null;
    const name = !w ? '' : listed ? `${listed.name} Team` : w.name;
    this.broadcast({ t: 'round', n: r.n, next: r.n + 1, series: r.series, team, name, reason: res.reason || 'last', ends: ROUND_BREAK / 1000 });
    return true;
  }

  /** The next round: a fresh island state, new loot, everyone back at their team's spot. */
  nextRound() {
    const now = this.now();
    const R = this.rules;
    const r = this.round;
    // a side left during the series (LEAVE PARTY, a rejoin hold that ran out): the side still
    // here takes it now, instead of playing every remaining round against nobody
    const here = new Set(this.runtime.list.filter((p) => this.players.has(p.id)).map((p) => p.team));
    if (here.size < 2 && this.startTeams > 1) {
      this.phase = 'match';
      this.endMatch(here.size ? { team: [...here][0], reason: 'left', forfeit: true } : { reason: 'left', forfeit: true });
      return;
    }
    r.n++;
    this.resetWorldState();
    const all = this.runtime.list;
    for (const p of all) { this.resetForMatch(p); p.lives = R.lives; }
    this.lootSeed = (this.lootSeed + r.n) >>> 0;
    this.runtime.begin(R, this.area, this.lootSeed, all, this.teamList);
    this.pendingEnd = null;
    const { spawns, busTime } = this.placeEveryone(all, now);
    this.spawnInitialLoot();
    this.rolesHeld = true;
    try { this.runtime.setup(() => makeLoadout(R, Math.random)); } finally { this.rolesHeld = false; }
    if (R.timeLimit > 0) this.runtime.endsAt = now + (busTime + R.timeLimit) * 1000;
    this.stormTick = now;
    this.modeTickT = now;
    this.broadcast({
      t: 'round', n: r.n, series: r.series, start: true, bus: this.bus ? this.busMsg() : null, spawns,
      lootSeed: this.lootSeed, lootN: this.loot.size, area: this.area, lo: this.startLoadouts(), players: this.roster(), teams: this.teamList,
    });
    this.sendRoles(all);
  }

  /** Tell the bots' device whom p is watching (p.watch, 0 = nobody). */
  tellWatch(p) {
    let owner = 0;
    for (const q of this.players.values()) if (q.bot) { owner = q.owner; break; }
    const op = owner ? this.players.get(owner) : null;
    const conn = op ? this.connOf(op) : null;
    if (conn) this.send(conn, { t: 'watch', from: p.id, id: p.watch | 0 });
  }

  /** The roles a game's set-up gave out, sent after the start (clients clear roles on start). */
  sendRoles(list) {
    for (const p of list) if (p.role) this.broadcast({ t: 'role', id: p.id, role: p.role });
  }

  sameTeam(a, b) { return a !== b && a.team === b.team; }

  returnToLobby() {
    this.phase = 'lobby';
    this.storm = null;
    this.bus = null;
    this.area = null;
    this.teamList = [];
    this.round = null;
    this.humansOutAt = 0;
    this.pendingEnd = null;
    this.runtime.ended = true;
    this.runtime.list = [];
    this.runtime.ms = null;
    if (this.mystery) { this.mystery = null; }
    this.rules = rulesFromSettings(this.settings, GAME_OPTS);
    this.resetWorldState();
    for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
    for (const p of this.players.values()) {
      p.alive = true;
      p.spectator = false;
      p.maxHp = PLAYER.maxHp;
      p.hp = PLAYER.maxHp;
      p.sh = PLAYER.startShield;
      p.inBus = false;
      p.inMatch = false;
      p.respawnAt = 0;
      p.role = null;
      p.armor = 1;
      p.a = ANIM.IDLE;
      p.team = p.id;
    }
    this.plug('onLobby', this);
    this.broadcast({ t: 'lobby', players: this.roster(), leader: this.leader, settings: this.settings });
  }

  // ------------------------------------------------------------------ respawns
  /**
   * Where p comes back: a spawn spot inside the storm, as far from living enemies as possible
   * (anything 80 m away or more counts the same, so respawns vary), but not out of reach of the
   * fight: more than 250 m from every enemy counts like 60 m (the 1.6 km island).
   */
  respawnSpot(p) {
    const C = this.spawnCands;
    const st = this.storm ? this.stormNow() : null;
    let best = null, bs = -Infinity;
    for (const c of C) {
      let score = Math.random() * 400;
      if (st) {
        const dx = c.x - st.cx, dz = c.z - st.cz, d = Math.sqrt(dx * dx + dz * dz);
        if (d > st.r - 8) score -= 1e6 + d;
      }
      let md = Infinity;
      for (const q of this.players.values()) {
        if (!q.alive || !q.inMatch || q.team === p.team) continue;
        const dx = q.x - c.x, dz = q.z - c.z, d = dx * dx + dz * dz;
        if (d < md) md = d;
      }
      score += md === Infinity ? 6400 : md > 62500 ? 3600 : Math.min(md, 6400);
      if (score > bs) { bs = score; best = c; }
    }
    if (best && (!st || bs > -1e5)) return best;
    // nothing inside the storm: its centre (always land)
    if (st) return { x: st.cx, y: Math.max(0, this.world.heightAt(st.cx, st.cz)), z: st.cz };
    return best || { x: this.area.x, y: Math.max(0, this.world.heightAt(this.area.x, this.area.z)), z: this.area.z };
  }

  /** Bring p back into the match: {t:'respawn', id, x, y, z, how, lo, hp, sh}. */
  respawnPlayer(p) {
    p.respawnAt = 0;
    if (!p.inMatch || p.alive) return;
    const R = this.rules;
    const how = R.spawn === 'ground' ? 'ground' : 'sky';
    const s = this.respawnSpot(p);
    p.alive = true;
    p.spectator = false;
    p.inBus = false;
    p.hp = p.maxHp;
    p.sh = R.shield;
    p.x = s.x; p.z = s.z; p.y = s.y + (how === 'sky' ? SKY_SPAWN_HEIGHT : 0);
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.a = how === 'sky' ? ANIM.SKYDIVE : ANIM.IDLE;
    const lo = p.keepLoot ? null : this.runtime.respawnLoadout(p, () => makeLoadout(R, Math.random));
    p.keepLoot = false;
    if (p.watch) { p.watch = 0; this.tellWatch(p); }
    this.broadcast({ t: 'respawn', id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), how, lo, hp: Math.ceil(p.hp), sh: Math.ceil(p.sh) });
    this.runtime.call('onRespawn', p);
  }

  // ------------------------------------------------------------------ mutators
  /** Mystery mode: every 60 s a new mutator replaces the last one ({t:'mut', rules, name}). */
  nextMystery(now) {
    const base = rulesFromSettings(this.settings, GAME_OPTS);
    const list = MYSTERY.filter(([k]) => k !== this.mystery.key);
    const [key, value, name] = list[Math.floor(Math.random() * list.length)];
    this.mystery = { at: now + MYSTERY_EVERY, key };
    this.rules = normalizeRules({ ...base, [key]: value }, GAME_OPTS);
    this.runtime.rules = this.rules;
    this.broadcast({ t: 'mut', rules: this.rules, name });
    this.broadcast({ t: 'note', msg: `Mystery: ${name}` });
  }

  // ------------------------------------------------------------------ damage
  applyDamage(target, amount, attacker, info = {}) {
    if (!target.alive || !(amount > 0)) return;
    let rest = amount;
    let shieldHit = 0;
    if (!info.ignoreShield && target.sh > 0) {
      shieldHit = Math.min(target.sh, rest);
      target.sh -= shieldHit;
      rest -= shieldHit;
    }
    const hpHit = Math.min(target.hp, rest);
    target.hp = Math.max(0, target.hp - rest);
    if (attacker && attacker !== target) attacker.dmg = (attacker.dmg || 0) + shieldHit + hpHit;
    this.broadcast({
      t: 'dmg', a: attacker ? attacker.id : 0, tg: target.id, amt: Math.round(amount), hs: !!info.hs,
      shd: shieldHit > 0 ? 1 : 0, hp: Math.ceil(target.hp), sh: Math.ceil(target.sh), c: info.c || 'gun',
      x: info.x, y: info.y, z: info.z,
    });
    if (target.hp <= 0) this.eliminate(target, attacker, info);
  }

  damageAllowed() { return this.phase === 'match' || this.phase === 'bus'; }

  // ------------------------------------------------------------------ builds
  pieceMsg(b) {
    return this.plugExtra({ k: b.k, m: b.m, d: b.d | 0, hp: Math.round(this.pieceHp(b)), max: b.max, by: b.by, age: (this.now() - b.born) / 1000 }, 'pieceMsg', b);
  }

  pieceHp(b) {
    const now = this.now();
    if (b.t1 < b.growUntil) {
      const until = Math.min(now, b.growUntil);
      b.hp = Math.min(b.max, b.hp + b.rate * (until - b.t1) / 1000);
      b.t1 = until;
    }
    return b.hp;
  }

  damagePiece(k, dmg, attacker) {
    const b = this.grid.get(k);
    if (!b) return;
    const hp = this.pieceHp(b) - dmg;
    b.hp = hp;
    if (hp > 0) {
      if (attacker) {
        const conn = this.connOf(attacker);
        if (conn) this.send(conn, { t: 'bh', k, hp: Math.round(hp), max: b.max });
      }
      return;
    }
    this.destroyPieces([k]);
  }

  destroyPieces(keys) {
    const removed = [];
    for (const k of keys) {
      const p = this.grid.remove(k);
      if (p) removed.push(p);
    }
    if (!removed.length) return;
    const fallen = this.grid.collapseFrom(removed);
    for (const k of fallen) this.grid.remove(k);
    this.broadcast({ t: 'b-', k: removed.map((p) => p.k), c: fallen });
  }

  damageObject(oid, dmg, attacker) {
    const o = this.world.objects[oid];
    if (!o || this.destroyed.has(oid) || !(o.hp > 0)) return;
    const hp = (this.objHp.has(oid) ? this.objHp.get(oid) : o.hp) - dmg;
    if (hp > 0) {
      this.objHp.set(oid, hp);
      return;
    }
    this.objHp.delete(oid);
    this.destroyed.add(oid);
    this.broadcast({ t: 'ox', o: oid, by: attacker ? attacker.id : 0 });
    // pieces leaning on this object may now collapse
    const near = [];
    const pad = 4.5;
    const bx0 = o.x - (o.hx || 3) - pad, bx1 = o.x + (o.hx || 3) + pad;
    const bz0 = o.z - (o.hz || 3) - pad, bz1 = o.z + (o.hz || 3) + pad;
    for (const p of this.grid.pieces.values()) {
      const x = p.cx * BUILD.cell, z = p.cz * BUILD.cell;
      if (x > bx0 && x < bx1 && z > bz0 && z < bz1 && !this.grid.grounded(p)) near.push(p);
    }
    if (near.length) {
      // collapse check: test each nearby piece's connected component directly
      const doomed = new Set();
      for (const p of near) {
        if (doomed.has(p.k) || !this.grid.has(p.k)) continue;
        const seen = new Set([p.k]);
        const q = [p.k];
        let ok = false;
        while (q.length && seen.size < 3000) {
          const k = q.shift();
          const piece = this.grid.get(k);
          if (!piece) continue;
          if (this.grid.grounded(piece)) { ok = true; break; }
          for (const n of this.grid.neighbors(piece)) if (!seen.has(n)) { seen.add(n); q.push(n); }
        }
        if (!ok) for (const k of seen) doomed.add(k);
      }
      if (doomed.size) {
        for (const k of doomed) this.grid.remove(k);
        this.broadcast({ t: 'b-', k: [], c: [...doomed] });
      }
    }
  }

  // ------------------------------------------------------------------ loot
  addLoot(item, x, y, z) {
    const id = this.nextLoot++;
    const l = { id, item, x: r2(x), y: r2(y), z: r2(z) };
    this.loot.set(id, l);
    return l;
  }

  /** The seeded floor loot (shared/loot.js): every client rolls the very same list from lootSeed. */
  spawnInitialLoot() {
    const list = rollInitialLoot(this.world, this.lootSeed, this.rules, this.area);
    for (const l of list) this.loot.set(l.id, l);
    this.nextLoot = list.length + 1;
  }

  openChest(ci) {
    const c = this.world.chests[ci];
    if (!c || this.chestsOpened.has(ci)) return;
    this.chestsOpened.add(ci);
    const items = rollChest(Math.random, this.rules, c.tier);
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    const spawned = items.map((it, i) => {
      const side = (i - (items.length - 1) / 2) * 0.7;
      return this.addLoot(it, c.x + fx * 1.3 + fz * side, c.y + 0.1, c.z + fz * 1.3 - fx * side);
    });
    this.broadcast({ t: 'chest', c: ci });
    this.broadcast({ t: 'l+', items: spawned });
  }

  // ------------------------------------------------------------------ tick
  tick() {
    const now = this.now();
    this.plug('tick', this, now);
    this.lastTick = now;

    if (this.phase === 'bus' && this.bus) {
      const bp = this.busPos();
      for (const p of this.players.values()) {
        if (p.inBus) { p.x = bp.x; p.y = bp.y; p.z = bp.z; }
      }
      if (bp.done) {
        const force = [];
        for (const p of this.players.values()) {
          if (p.inBus) { p.inBus = false; force.push(p.id); }
        }
        if (force.length) this.broadcast({ t: 'forcedrop', ids: force, x: bp.x, y: bp.y, z: bp.z });
        this.phase = 'match';
      }
    }

    if (this.phase === 'bus' || this.phase === 'match') {
      if (now - (this.botCheck || 0) > 1000) { this.botCheck = now; this.checkBotOwner(); }
      this.matchTick(now);
    }

    if (this.phase === 'round' && now >= this.phaseEnds) this.nextRound();
    if (this.phase === 'ended' && now >= this.phaseEnds) this.returnToLobby();
    if (this.teamsDirty) {
      this.teamsDirty = false;
      this.broadcast({ t: 'teams', teams: this.teamList });
    }
    if (this.rosterDirty) {
      this.rosterDirty = false;
      this.broadcast({ t: 'roster', players: this.roster(), leader: this.leader });
    }

    const P = [];
    for (const p of this.players.values()) {
      P.push([p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yw), r2(p.pt), p.alive ? (p.inBus ? ANIM.BUS : p.a) : ANIM.DEAD, p.w, p.f,
        Math.ceil(p.hp), Math.ceil(p.sh), r2(p.vx), r2(p.vy), r2(p.vz)]);
    }
    const snap = { t: 's', ts: now, phase: this.phase === 'round' ? 'match' : this.phase, p: P };
    if (this.storm) snap.st = this.stormMsg();
    if (this.phase === 'bus' && this.bus) {
      const bp = this.busPos();
      snap.bus = [r2(bp.x), r2(bp.y), r2(bp.z)];
    }
    if (this.phase === 'lobby') {
      let n = 0;
      for (const p of this.players.values()) if (!p.bot) n++;
      snap.alive = n;
    } else snap.alive = this.aliveCount();
    this.broadcast(snap);
  }

  /** The match, 20 times a second: storm, lava, respawns, the mode (10 Hz), time limit, humans out. */
  matchTick(now) {
    this.updateStorm();
    if (now - this.stormTick >= 1000) {
      this.stormTick = now;
      const s = this.storm;
      const st = s ? this.stormNow() : null;
      const dps = s ? s.phases[Math.min(s.i, s.phases.length - 1)].dps : 0;
      const lava = this.world.lava && this.world.lava.length;
      for (const p of this.players.values()) {
        if (!p.alive || p.inBus) continue;
        if (st) {
          const dx = p.x - st.cx, dz = p.z - st.cz;
          if (dx * dx + dz * dz > st.r * st.r) this.applyDamage(p, dps, null, { c: 'storm', ignoreShield: true });
        }
        if (lava && p.alive && this.inLava(p)) this.applyDamage(p, 10, null, { c: 'lava', ignoreShield: true });
        if (this.phase !== 'match' && this.phase !== 'bus') return;
      }
    }
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) this.respawnPlayer(p);
    }
    if (this.phase !== 'match' && this.phase !== 'bus') return;
    if (this.mystery && now >= this.mystery.at) this.nextMystery(now);
    // the game, 10 times a second
    if (now - this.modeTickT >= 100) {
      const dt = Math.min(0.5, (now - this.modeTickT) / 1000);
      this.modeTickT = now;
      this.runtime.call('tick', dt);
      this.checkWin();
      if (this.phase !== 'match' && this.phase !== 'bus') return;
    }
    if (this.runtime.endsAt && now >= this.runtime.endsAt) { this.endMatch(this.runtime.timeUp()); return; }
    if (this.humansOutAt && now >= this.humansOutAt) {
      // a series: nobody takes the round; otherwise the match is over for the humans
      this.endMatch(this.round ? { reason: 'last' } : { id: 0, reason: 'humans-out' });
      return;
    }
    const ms = this.runtime.modeState(now);
    if (ms) this.broadcast(ms);
  }
}

// ------------------------------------------------------------------ handlers
const TAU = Math.PI * 2;
const VALID_HELD = new Set(['pickaxe', 'build', ...WEAPON_KEYS, ...Object.keys(HEALS)]);
function cleanHeld(w) {
  if (typeof w !== 'string') return 'pickaxe';
  const [k, r] = w.split(':');
  if (!VALID_HELD.has(k)) return 'pickaxe';
  const rr = parseInt(r, 10);
  return Number.isFinite(rr) && rr > 0 && rr <= 4 ? `${k}:${rr}` : k;
}

// positions are clamped to the island (plus a margin) so the room never judges storm / hits far off the map
const XZ_LIMIT = MAP.size / 2 + 60;
// loot on the floor at most (an honest match starts with ~1500 items; 4000 is a ~300 KB welcome,
// well under the P2P reassembly limit of 400 x 5000 characters)
export const LOOT_CAP = 4000;
const DROP_PER_S = 60;           // items one actor may drop a second
const EMOTE_MS = 250;            // one emote per player every 250 ms
const dropBudget = new WeakMap(); // player record -> {t0, n}
const emoteT = new WeakMap();     // player record -> room time of the last emote

function setState(p, s) {
  if (!Array.isArray(s) || s.length < 11) return;
  if (!p.inBus) {
    p.x = clampN(num(s[0], p.x), -XZ_LIMIT, XZ_LIMIT);
    p.y = clampN(num(s[1], p.y), -50, 600);
    p.z = clampN(num(s[2], p.z), -XZ_LIMIT, XZ_LIMIT);
  }
  p.vx = clampN(num(s[3]), -80, 80);
  p.vy = clampN(num(s[4]), -80, 80);
  p.vz = clampN(num(s[5]), -80, 80);
  const yw = num(s[6]);
  p.yw = yw - TAU * Math.floor((yw + Math.PI) / TAU);
  p.pt = clampN(num(s[7]), -2, 2);
  if (p.alive && !p.inBus) p.a = clampN(num(s[8]) | 0, 0, 10);
  p.w = cleanHeld(s[9]);
  p.f = num(s[10]) | 0;
  p.lastSeen = Date.now();
}

const HANDLERS = {
  ping(c, m) {
    this.send(c.conn, { t: 'pong', c: m.c, ts: this.now() });
  },

  u(c, m) {
    const p = this.players.get(c.pid);
    if (p && (p.alive || this.phase === 'lobby')) setState(p, m.s);
  },

  ub(c, m) {
    if (!Array.isArray(m.b)) return;
    for (const row of m.b) {
      if (!Array.isArray(row)) continue;
      const p = this.actor(c.conn.id, row[0]);
      if (p && p.bot && p.alive) setState(p, row.slice(1));
    }
  },

  /** {t:'mode', id} or {t:'mode', custom: rules, name}: the leader picks the mode (lobby only). */
  mode(c, m) {
    if (c.pid !== this.leader || this.phase !== 'lobby') return;
    if (typeof m.id === 'string' && m.id !== 'custom') {
      if (!playableMode(m.id)) return;
      this.setSettings(modeSettings(m.id, this.settings.rules));
    } else if (m.custom && typeof m.custom === 'object') {
      this.setSettings(customSettings(m.custom, m.name));
    }
  },

  /** {t:'tweak', bots?, botSkill?}: the leader changes the bots of the current mode (lobby only). */
  tweak(c, m) {
    if (c.pid !== this.leader || this.phase !== 'lobby') return;
    const t = {};
    if (m.bots !== undefined) t.bots = clampN(num(m.bots, this.rules.bots), 0, 31);
    if (typeof m.botSkill === 'string') t.botSkill = m.botSkill;
    if (!Object.keys(t).length) return;
    this.setSettings(tweakSettings(this.settings, t));
  },

  start(c, m) {
    if (c.pid !== this.leader || this.phase !== 'lobby') return;
    // older clients still send {bots, mats, mode} with start
    if (m.bots !== undefined || m.mats !== undefined || m.mode !== undefined) {
      const s = this.legacySettings(m);
      if (s !== this.settings) { this.settings = s; this.rules = rulesFromSettings(s, GAME_OPTS); }
    }
    this.startMatch();
  },

  /** Legacy (pre-modes lobby): {mode: 'ffa' | 'squad', bots, mats} -> mode / tweak. */
  settings(c, m) {
    if (c.pid !== this.leader || this.phase !== 'lobby') return;
    const s = this.legacySettings(m);
    if (s !== this.settings) this.setSettings(s);
  },

  end(c) {
    if (c.pid !== this.leader) return;
    if (this.phase === 'match' || this.phase === 'bus' || this.phase === 'ended' || this.phase === 'round') this.returnToLobby();
  },

  /** A client's floor loot did not match the seeded list: send the real one. */
  lootall(c) {
    const now = this.now();
    if (now - (c.lootallT || -1e9) < 2000) return;
    c.lootallT = now;
    this.send(c.conn, { t: 'lootall', loot: [...this.loot.values()] });
  },

  drop(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.inBus || this.phase !== 'bus') return;
    p.inBus = false;
    const bp = this.busPos();
    p.x = bp.x; p.y = bp.y - 3; p.z = bp.z;
    p.a = ANIM.SKYDIVE;
  },

  sh(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.alive) return;
    if (!own(WEAPONS, m.w) || !Array.isArray(m.o) || !Array.isArray(m.d)) return;
    const o = m.o.slice(0, 3).map((v) => num(v));
    const d = m.d.slice(0, 30).map((v) => clampN(num(v), -1, 1));
    this.broadcast({ t: 'sh', id: p.id, w: m.w, o, d, r: clampN(num(m.r) | 0, 0, 4) }, c.conn.id);
  },

  sw(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (p && p.alive) this.broadcast({ t: 'sw', id: p.id }, c.conn.id);
  },

  hit(c, m) {
    const a = this.actor(c.conn.id, m.id);
    const tg = this.players.get(m.tg);
    if (!a || !tg || !a.alive || !tg.alive || tg.inBus || a === tg) return;
    if (!this.damageAllowed() || this.sameTeam(a, tg)) return;
    if (!own(WEAPONS, m.w)) return;
    const w = WEAPONS[m.w];
    const r = clampRarity(m.w, num(m.r) | 0);
    const dist = clampN(num(m.d), 0, 2000);
    const pellets = w.pellets || 1;
    let n = clampN(num(m.n, 1) | 0, 0, pellets);
    const nh = clampN(num(m.nh) | 0, 0, pellets - n);
    if (this.rules.headOnly) n = 0; // headshots only: body hits do nothing
    if (n + nh <= 0) return;
    const info = { w: m.w, hs: nh > 0, x: num(m.x), y: num(m.y), z: num(m.z) };
    const raw = n * weaponDamage(m.w, r, dist, false) + nh * weaponDamage(m.w, r, dist, true);
    const dmg = this.runtime.damageFor(a, tg, raw, info);
    if (dmg > 0) this.applyDamage(tg, dmg, a, info);
  },

  boom(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !own(WEAPONS, m.w)) return;
    const w = WEAPONS[m.w];
    if (!w.splash) return;
    const r = clampRarity(m.w, num(m.r) | 0);
    const x = num(m.x), y = num(m.y), z = num(m.z);
    this.broadcast({ t: 'boom', id: a.id, x: r2(x), y: r2(y), z: r2(z), w: m.w }, c.conn.id);
    const base = w.dmg[r];
    const R = w.splash;
    if (this.damageAllowed() && !this.rules.headOnly) {
      // judge the whole blast first, then apply it: the state when it went off counts for everyone
      // in it (a gun game promotion, an infection, a Juggernaut handoff by the first victim must
      // not change what it does to the others)
      const hits = [];
      for (const p of this.players.values()) {
        if (!p.alive || p.inBus || p === a || this.sameTeam(p, a)) continue;
        const dx = p.x - x, dy = p.y + 0.9 - y, dz = p.z - z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= R) continue;
        const info = { w: m.w, c: 'boom' };
        const dmg = this.runtime.damageFor(a, p, base * (1 - 0.6 * d / R), info);
        if (dmg > 0) hits.push([p, dmg, info]);
      }
      for (const [p, dmg, info] of hits) this.applyDamage(p, dmg, a, info);
    }
    // structures
    const hit = [];
    for (const b of this.grid.pieces.values()) {
      const bx = b.cx * BUILD.cell + BUILD.cell / 2, by = b.cy * BUILD.level + BUILD.level / 2, bz = b.cz * BUILD.cell + BUILD.cell / 2;
      const d = Math.sqrt((bx - x) ** 2 + (by - y) ** 2 + (bz - z) ** 2);
      if (d < R + 2.5) hit.push([b.k, base * w.struct * (1 - 0.5 * Math.max(0, d - 2) / R)]);
    }
    for (const [k, d] of hit) this.damagePiece(k, d, a);
    // world objects: only the ones around the blast (the 32 m object hash)
    const objs = [];
    const near = (o) => {
      if (!(o.hp > 0)) return;
      const dx = o.x - x, dy = o.y - y, dz = o.z - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < R + 2) objs.push([o.id, base * 2.2 * (1 - 0.5 * d / (R + 2))]);
    };
    if (this.world.objectsNear) this.world.objectsNear(x, z, R + 4, near);
    else for (const o of this.world.objects) near(o);
    for (const [id, d] of objs) this.damageObject(id, d, a);
  },

  fall(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.alive || !this.damageAllowed() || this.rules.fallDamage === false) return;
    this.applyDamage(p, clampN(num(m.d), 0, 200), null, { c: 'fall', ignoreShield: true });
  },

  heal(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.alive || !own(HEALS, m.k)) return;
    const h = HEALS[m.k];
    const cap = Math.min(h.cap, h.hp ? p.maxHp || PLAYER.maxHp : h.cap);
    if (h.hp && p.hp < cap) p.hp = Math.min(cap, p.hp + h.hp);
    if (h.sh && p.sh < h.cap) p.sh = Math.min(h.cap, p.sh + h.sh);
  },

  od(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a) return;
    this.damageObject(num(m.o, -1) | 0, clampN(num(m.d), 0, 600), a);
  },

  b(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !a.alive || a.inBus || (this.phase !== 'lobby' && this.phase !== 'match' && this.phase !== 'bus')
      || (this.phase !== 'lobby' && this.rules.build === 'off')) {
      this.send(c.conn, { t: 'bno', k: m.k });
      return;
    }
    const p = parseKey(m.k);
    if (!p || this.grid.has(m.k) || this.grid.pieces.size >= BUILD.maxPieces) {
      this.send(c.conn, { t: 'bno', k: m.k });
      return;
    }
    const mat = MAT_KEYS.includes(m.m) ? m.m : 'wood';
    p.k = m.k;
    p.d = clampN(num(m.d) | 0, 0, 3);
    if (!this.grid.canSupport(p)) {
      this.send(c.conn, { t: 'bno', k: m.k });
      return;
    }
    const spec = BUILD.mats[mat];
    const now = this.now();
    Object.assign(p, {
      m: mat, max: spec.hp, hp: spec.hp * BUILD.startFrac, born: now, t1: now, growUntil: now + spec.grow * 1000,
      rate: spec.hp * (1 - BUILD.startFrac) / spec.grow, by: a.id,
    });
    this.grid.add(p);
    this.broadcast({ t: 'b+', ...this.pieceMsg(p) });
  },

  bd(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a) return;
    this.damagePiece(String(m.k), clampN(num(m.d), 0, 1000), a);
  },

  pick(c, m) {
    const a = this.actor(c.conn.id, m.id);
    const l = this.loot.get(num(m.l) | 0);
    if (!a || !a.alive || !l) {
      this.send(c.conn, { t: 'gotno', l: m.l, id: m.id });
      return;
    }
    const dx = a.x - l.x, dz = a.z - l.z;
    if (dx * dx + dz * dz > 7 * 7) {
      this.send(c.conn, { t: 'gotno', l: m.l, id: m.id });
      return;
    }
    this.loot.delete(l.id);
    this.send(c.conn, { t: 'got', id: a.id, l: l.id, item: l.item, swap: m.swap });
    this.broadcast({ t: 'l-', l: l.id });
  },

  dropi(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !Array.isArray(m.items)) return;
    // dead actors and every phase may drop (death drops, swaps in the lobby): instead, drops land
    // where the actor really is, the room's loot is capped, and each actor drops at most
    // DROP_PER_S items a second (a flood would make the next joiner's welcome megabytes long)
    if (this.loot.size >= LOOT_CAP) return;
    const now = this.now();
    const bud = dropBudget.get(a);
    if (!bud || now - bud.t0 > 1000) dropBudget.set(a, { t0: now, n: 0 });
    const b = dropBudget.get(a);
    let x = num(m.x, a.x), y = num(m.y, a.y), z = num(m.z, a.z);
    if (Math.hypot(x - a.x, z - a.z) > 4) { x = a.x; y = a.y; z = a.z; }
    x = clampN(x, -XZ_LIMIT, XZ_LIMIT);
    z = clampN(z, -XZ_LIMIT, XZ_LIMIT);
    y = clampN(y, Math.max(-50, a.y - 6), Math.min(600, a.y + 6));
    const out = [];
    for (const it of m.items.slice(0, 12)) {
      if (b.n >= DROP_PER_S || this.loot.size >= LOOT_CAP) break;
      if (!it || typeof it.k !== 'string') continue;
      const k = it.k;
      let item = null;
      if (own(WEAPONS, k) && k !== 'pickaxe') item = { k, r: clampRarity(k, num(it.r) | 0), m: clampN(num(it.m) | 0, 0, WEAPONS[k].mag) };
      else if (own(AMMO, k)) item = { k, n: clampN(num(it.n) | 0, 1, 999) };
      else if (own(HEALS, k)) item = { k, n: clampN(num(it.n) | 0, 1, HEALS[k].stack) };
      else if (MAT_KEYS.includes(k)) item = { k, n: clampN(num(it.n) | 0, 1, MAX_MATS) };
      if (!item) continue;
      b.n++;
      const ang = out.length * 1.3;
      const rad = it.near ? 0.4 : 0.8 + out.length * 0.15;
      out.push(this.addLoot(item, x + Math.cos(ang) * rad, y + 0.05, z + Math.sin(ang) * rad));
    }
    if (out.length) this.broadcast({ t: 'l+', items: out });
  },

  chest(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !a.alive) return;
    const ci = num(m.c, -1) | 0;
    const ch = this.world.chests[ci];
    if (!ch) return;
    if (this.phase !== 'lobby' && this.rules.chests === false) return;
    const dx = a.x - ch.x, dz = a.z - ch.z;
    if (dx * dx + dz * dz > 6 * 6) return;
    // already open (the client missed it): tell just this device, without new loot
    if (this.chestsOpened.has(ci)) { this.send(c.conn, { t: 'chest', c: ci }); return; }
    this.openChest(ci);
  },

  /**
   * {t:'watch', id}: who this (eliminated) player spectates, 0 = nobody. The device running the bots
   * hears about watched bots ({t:'watch', from, id}) and keeps them in its full simulation.
   */
  watch(c, m) {
    const p = this.players.get(c.pid);
    if (!p || p.bot) return;
    let id = num(m.id) | 0;
    const t = id ? this.players.get(id) : null;
    if (!t || !t.bot) id = 0;
    if ((p.watch | 0) === id) return;
    p.watch = id;
    this.tellWatch(p);
  },

  emote(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.alive) return;
    const now = this.now();
    if (now - (emoteT.get(p) ?? -1e12) < EMOTE_MS) return;
    emoteT.set(p, now);
    this.broadcast({ t: 'emote', id: p.id, e: num(m.e) | 0 }, c.conn.id);
  },
};
