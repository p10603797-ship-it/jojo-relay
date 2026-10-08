// The mode runtime: how the shared Room plays a mode. ModeRuntime implements the Game plugin ctx
// (shared/modes/api.js) on top of a Room, and this module also holds the match set-up helpers the
// Room uses: play areas, teams, spawns and bot skill. Shared by the Node server, the P2P host and
// solo (all run the same Room), so it must stay free of DOM / Node specific APIs.
import { MAP, TEAM_COLORS } from '../constants.js';
import { BIOMES } from '../world/keys.js';
import { mulberry32 } from '../rng.js';
import { GAMES } from './games/index.js';
import { cleanLoadout } from '../loot.js';

// ------------------------------------------------------------------ areas
const AREA_CACHE = new WeakMap(); // world -> Map(area key -> {x, z, r})

/** The whole island: centred on (0, 0), the island radius x 1.1. */
export function fullArea() { return { x: 0, z: 0, r: MAP.islandRadius * 1.1 }; }

/**
 * rules.area on this world -> {x, z, r}:
 * - full: (0, 0), islandRadius x 1.1; center: radius 0.35 x islandRadius
 * - random: a named place's centre, radius 150 (rng picks it)
 * - poi:<name>: that place, radius r x 2 (at least 90); biome:<key>: the bounding circle of the
 *   biome's cells. Anything that does not resolve is the whole island.
 */
export function resolveArea(world, area, rng = Math.random) {
  const IR = MAP.islandRadius;
  if (area === 'center') return { x: 0, z: 0, r: 0.35 * IR };
  const regions = (world && world.regions) || [];
  if (area === 'random') {
    const named = regions.filter((g) => g.named !== false);
    if (!named.length) return fullArea();
    const g = named[Math.floor(rng() * named.length) % named.length];
    return { x: g.x, z: g.z, r: 150 };
  }
  if (typeof area !== 'string' || area === 'full') return fullArea();
  let cache = AREA_CACHE.get(world);
  if (!cache) AREA_CACHE.set(world, (cache = new Map()));
  if (cache.has(area)) return { ...cache.get(area) };
  let out = null;
  if (area.startsWith('poi:')) {
    const name = area.slice(4).toLowerCase();
    const g = regions.find((x) => String(x.name).toLowerCase() === name);
    if (g) out = { x: g.x, z: g.z, r: Math.max(90, g.r * 2) };
  } else if (area.startsWith('biome:')) {
    out = biomeCircle(world, area.slice(6));
  }
  if (!out) out = fullArea();
  cache.set(area, out);
  return { ...out };
}

/** Bounding circle of a biome's land (centroid, then the 97th-percentile distance), or null. */
function biomeCircle(world, key) {
  const bi = BIOMES.indexOf(key);
  if (bi < 0 || !world) return null;
  const xs = [], zs = [];
  if (world.biome && world.N) {
    const { N, cell, half } = world;
    const step = N > 200 ? 2 : 1;
    for (let iz = 0; iz < N; iz += step) {
      for (let ix = 0; ix < N; ix += step) {
        if (world.biome[iz * N + ix] === bi) { xs.push(-half + ix * cell); zs.push(-half + iz * cell); }
      }
    }
  } else if (typeof world.biomeAt === 'function') {
    const half = world.half || MAP.size / 2;
    for (let z = -half; z <= half; z += 8) for (let x = -half; x <= half; x += 8) if (world.biomeAt(x, z) === key) { xs.push(x); zs.push(z); }
  }
  if (xs.length < 4) return null;
  let cx = 0, cz = 0;
  for (let i = 0; i < xs.length; i++) { cx += xs[i]; cz += zs[i]; }
  cx /= xs.length; cz /= xs.length;
  const d = xs.map((x, i) => Math.hypot(x - cx, zs[i] - cz)).sort((a, b) => a - b);
  const r = Math.min(fullArea().r, Math.max(60, d[Math.floor((d.length - 1) * 0.97)]));
  return { x: Math.round(cx * 10) / 10, z: Math.round(cz * 10) / 10, r: Math.round(r * 10) / 10 };
}

// ------------------------------------------------------------------ teams
/** Team id -> {id, name, color}. */
export function teamInfo(id) {
  const c = TEAM_COLORS[(id - 1) % TEAM_COLORS.length];
  const lap = Math.floor((id - 1) / TEAM_COLORS.length);
  return { id, name: lap ? `${c.name} ${lap + 1}` : c.name, color: c.color };
}

/** The team id of a player with no team (free for all: everyone on their own). */
export const soloTeam = (p) => 1000 + p.id;

/**
 * How many bots to add for these humans: rules.bots, capped by rules.maxPlayers (and maxTotal),
 * rounded so that fixed-size teams come out full when bots are playing at all.
 */
export function botCountFor(rules, humans, maxTotal = 32) {
  const cap = Math.max(0, Math.min(rules.maxPlayers, maxTotal) - humans);
  let n = Math.max(0, Math.min(rules.bots | 0, cap));
  const T = rules.teams;
  if (n > 0 && typeof T === 'number' && T > 1) {
    const rem = (humans + n) % T;
    if (rem) {
      if (n + (T - rem) <= cap) n += T - rem;
      else n = Math.max(0, n - rem);
    }
  }
  return n;
}

/**
 * Put players into teams (sets p.team) and return the listed teams [{id, name, color}]:
 * - teams N (2-4): humans fill teams in join order, so a party stays together; bots fill the rest
 * - 'two': humans alternate between two big teams, bots fill the smaller one
 * - 'humans': every human on one squad against bots who each play alone (today's squad mode)
 * - 1: free for all, everyone alone (team 1000 + id, not listed)
 */
export function assignTeams(humans, bots, rules) {
  const T = rules.teams;
  if (T === 'humans') {
    for (const p of humans) p.team = 1;
    for (const b of bots) b.team = soloTeam(b);
    return [{ id: 1, name: 'Your squad', color: TEAM_COLORS[0].color }];
  }
  if (T === 'two') {
    let n1 = 0, n2 = 0;
    humans.forEach((p, i) => { p.team = (i % 2) + 1; if (p.team === 1) n1++; else n2++; });
    for (const b of bots) {
      if (n1 <= n2) { b.team = 1; n1++; } else { b.team = 2; n2++; }
    }
    return [teamInfo(1), teamInfo(2)];
  }
  const all = [...humans, ...bots];
  if (typeof T === 'number' && T > 1) {
    all.forEach((p, i) => { p.team = Math.floor(i / T) + 1; });
    const out = [];
    for (let i = 1; i <= Math.ceil(all.length / T); i++) out.push(teamInfo(i));
    return out;
  }
  for (const p of all) p.team = soloTeam(p);
  return [];
}

// ------------------------------------------------------------------ spawns
const SPAWN_MARGIN = 5;
const MEMBER_RING = 3.5; // m: teammates stand around their team's spot (all within 2 x this)

/** Open land a player can stand on: above the sea, not too steep, not inside anything. */
export function standable(world, x, z, destroyed = null) {
  const h = world.heightAt(x, z);
  if (!(h > 1.5)) return false;
  const sl = Math.abs(world.heightAt(x + 1, z) - world.heightAt(x - 1, z)) * 0.5 + Math.abs(world.heightAt(x, z + 1) - world.heightAt(x, z - 1)) * 0.5;
  if (sl >= 0.6) return false;
  return !world.solidNear(x, h + 0.9, z, destroyed, 0.45);
}

/** How many spawn spots to look for when spreading `teams` teams out. */
const spotsFor = (teams) => Math.min(320, 48 + teams * 8);

/**
 * Spots for spawning in an area: the world's spawnPoints inside it, plus sampled open land when
 * there are fewer than `want`. [{x, y, z}] with y = ground height. `base`: spots found before.
 */
export function spawnCandidates(world, area, rng = Math.random, want = 48, base = null) {
  const out = base ? base.slice() : [];
  const R = Math.max(10, area.r - SPAWN_MARGIN), R2 = R * R;
  if (!base) {
    for (const s of world.spawnPoints || []) {
      const dx = s.x - area.x, dz = s.z - area.z;
      if (dx * dx + dz * dz <= R2 && s.y > 1.5) out.push({ x: s.x, y: s.y, z: s.z });
    }
  }
  for (let t = 0; t < want * 12 && out.length < want; t++) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R;
    const x = area.x + Math.cos(a) * d, z = area.z + Math.sin(a) * d;
    if (Math.abs(x) > MAP.size / 2 - 4 || Math.abs(z) > MAP.size / 2 - 4) continue;
    if (standable(world, x, z)) out.push({ x, y: world.heightAt(x, z), z });
  }
  return out;
}

/**
 * Start spots for every player: Map id -> {x, y, z}. Each team gets its own spot, as far from the
 * other teams' spots as the area allows (farthest-point sampling); teammates stand within
 * 2 x MEMBER_RING of each other around it.
 */
export function pickSpawns(world, area, players, rng = Math.random, cands = null) {
  const out = new Map();
  if (!players.length) return out;
  const byTeam = new Map();
  for (const p of players) {
    let list = byTeam.get(p.team);
    if (!list) byTeam.set(p.team, (list = []));
    list.push(p);
  }
  const teams = [...byTeam.values()];
  // more teams need more spots to spread them well
  const C = cands && cands.length >= spotsFor(teams.length) ? cands : spawnCandidates(world, area, rng, spotsFor(teams.length), cands);
  if (!C.length) {
    // nowhere sensible: the area centre, spread out a little
    teams.forEach((list, ti) => list.forEach((p, i) => {
      const x = area.x + ti * 6 + i * 1.5, z = area.z;
      out.set(p.id, { x, y: Math.max(0, world.heightAt(x, z)), z });
    }));
    return out;
  }
  // farthest-point sampling over the candidates
  const minD = new Float64Array(C.length).fill(Infinity);
  const used = new Uint8Array(C.length);
  let pick = Math.floor(rng() * C.length) % C.length;
  for (let ti = 0; ti < teams.length; ti++) {
    if (ti > 0) {
      let best = -1, bd = -1;
      for (let i = 0; i < C.length; i++) {
        if (used[i] && C.length > teams.length) continue;
        const d = minD[i] + rng() * 0.01; // ties: a random one
        if (d > bd) { bd = d; best = i; }
      }
      pick = best;
    }
    used[pick] = 1;
    const a = C[pick];
    for (let i = 0; i < C.length; i++) {
      const dx = C[i].x - a.x, dz = C[i].z - a.z, d = dx * dx + dz * dz;
      if (d < minD[i]) minD[i] = d;
    }
    const list = teams[ti];
    const turn = rng() * Math.PI * 2;
    list.forEach((p, i) => {
      let x = a.x, z = a.z;
      if (list.length > 1) {
        // around the team's spot; closer in (or another angle) when that is not open ground
        found: for (const rad of [MEMBER_RING, 2.2, 1.2]) {
          for (let k = 0; k < 4; k++) {
            const ang = turn + ((i + k * 0.37) / list.length) * Math.PI * 2;
            const tx = a.x + Math.cos(ang) * rad, tz = a.z + Math.sin(ang) * rad;
            if (standable(world, tx, tz)) { x = tx; z = tz; break found; }
          }
        }
      }
      out.set(p.id, { x, y: world.heightAt(x, z), z });
    });
  }
  return out;
}

// ------------------------------------------------------------------ bot skill
/** A bot's skill (0..1) for rules.botSkill; i spreads 'mixed' evenly. 'normal' is today's mix. */
export function rollBotSkill(level, rnd = Math.random, i = 0) {
  const r = (a, b) => a + rnd() * (b - a);
  if (level === 'mixed') level = ['easy', 'normal', 'hard'][i % 3];
  if (level === 'easy') return r(0.15, 0.45);
  if (level === 'hard') return r(0.6, 0.95);
  const x = rnd();
  if (x < 0.12) return r(0.78, 0.97);
  if (x < 0.4) return r(0.5, 0.75);
  return r(0.15, 0.5);
}

// ------------------------------------------------------------------ the runtime
const MS_EVERY = 250; // ms: the mode state goes out at most 4 times a second
const aliveOrComing = (p) => p.alive || p.respawnAt > 0;

/**
 * The Game plugin ctx for a Room (see shared/modes/api.js). One per Room; begin() starts a match.
 * The Room calls: begin, setup, startLoadout, onKill, allowDamage, scaleDamage, respawned,
 * checkWin, tick (10 Hz), timeUp, modeState.
 */
export class ModeRuntime {
  constructor(room) {
    this.room = room;
    this.game = null;
    this.rules = room.rules;
    this.world = room.world;
    this.area = fullArea();
    this.state = {};
    this.scoreMap = new Map();
    this.random = mulberry32(1);
    this.t0 = 0;
    this.endsAt = 0;
    this.started = false;
    this.startLo = new Map();
    this.teamList = [];
    this.list = [];
    this.msNext = 0;
    this.msLast = '';
    this.ms = null;
    this.ended = false;
  }

  /** A new match (or round): rules, area, seed and the players taking part. */
  begin(rules, area, seed, players, teamList) {
    this.rules = rules;
    this.game = Object.prototype.hasOwnProperty.call(GAMES, rules.win) ? GAMES[rules.win] : (GAMES.last || null);
    this.area = area;
    this.random = mulberry32((seed ^ 0x2545f491) >>> 0);
    this.state = {};
    this.scoreMap.clear();
    this.t0 = this.room.now();
    this.endsAt = 0;
    this.started = false;
    this.startLo.clear();
    this.list = players;
    this.teamList = teamList;
    this.msNext = 0;
    this.msLast = '';
    this.ms = null;
    this.ended = false;
  }

  /** Calls hook `name` of the game; a throwing game is logged ('plugin error') and ignored. */
  call(name, a, b, c, d) {
    const g = this.game;
    if (!g || typeof g[name] !== 'function') return undefined;
    try { return g[name](this, a, b, c, d); } catch (e) {
      this.room.log('plugin error', { plugin: g.key || 'game', hook: name, err: String((e && e.stack) || e) });
      return undefined;
    }
  }

  /** Are scores kept per team? (game.teamGame may be a function of the rules) */
  teamScores() {
    const tg = this.game && this.game.teamGame;
    return typeof tg === 'function' ? !!tg(this.rules) : !!tg;
  }

  // ------------------------------------------------------------------ ctx API (api.js)
  now() { return this.room.now() - this.t0; }
  rng() { return this.random(); }
  players() { return this.list; }
  alive() { return this.list.filter((p) => p.alive); }
  humans() { return this.list.filter((p) => !p.bot); }

  teams() {
    const out = this.teamList.slice();
    const seen = new Set(out.map((t) => t.id));
    for (const p of this.list) {
      if (seen.has(p.team)) continue;
      seen.add(p.team);
      out.push(p.team >= 1000 ? { id: p.team, name: p.name, color: '#ffffff' } : teamInfo(p.team));
    }
    return out;
  }

  addScore(key, n = 1) { this.scoreMap.set(key, (this.scoreMap.get(key) || 0) + n); }
  score(key) { return this.scoreMap.get(key) || 0; }
  /** [[key, n]], best first (ties keep the order they first scored in). */
  scores() { return [...this.scoreMap.entries()].sort((a, b) => b[1] - a[1]); }

  setRole(p, role) {
    p.role = role ?? null;
    this.room.broadcast({ t: 'role', id: p.id, role: p.role });
  }

  roleOf(p) { return p.role ?? null; }
  setArmor(p, k) { p.armor = Number.isFinite(k) ? Math.max(0, k) : 1; }

  setTeam(p, id) {
    if (p.team === id) return;
    p.team = id;
    this.room.rosterDirty = true;
  }

  giveLoadout(p, lo) {
    const clean = cleanLoadout(lo);
    if (!clean) return;
    if (this.rules.ammo === 'infinite') clean.infAmmo = true;
    p.lo = clean;
    if (!this.started) this.startLo.set(p.id, clean);
    else this.room.sendLoadout(p, clean);
  }

  respawn(p, delaySec = this.rules.respawn, opts = {}) {
    if (!p || p.alive || !p.inMatch || p.leaving || this.ended) return;
    const keepLoot = opts && opts.keepLoot !== undefined ? !!opts.keepLoot : !!this.rules.respawnKeep;
    p.respawnAt = this.room.now() + Math.max(0, Number(delaySec) || 0) * 1000;
    p.keepLoot = keepLoot;
  }

  eliminate(p, killer = null, info = {}) { this.room.eliminate(p, killer || null, info || {}); }
  damage(p, amount, info = {}) { this.room.applyDamage(p, amount, null, info || {}); }
  end(result) { this.room.endMatch(result || {}); }
  note(msg) { this.room.broadcast({ t: 'note', msg: String(msg).slice(0, 140) }); }

  // ------------------------------------------------------------------ used by the Room
  /** setup(ctx) + every player's start loadout; the loadouts are collected for the start message. */
  setup(defaultLoadout) {
    this.call('setup');
    for (const p of this.list) {
      if (this.startLo.has(p.id)) continue;
      const lo = this.call('loadout', p) || defaultLoadout(p);
      if (lo) this.giveLoadout(p, lo);
    }
    this.started = true;
  }

  /** A player's loadout on respawn: the game's, else the mode's. */
  respawnLoadout(p, defaultLoadout) {
    const lo = this.call('loadout', p) || defaultLoadout(p);
    const clean = cleanLoadout(lo);
    if (clean && this.rules.ammo === 'infinite') clean.infAmmo = true;
    if (clean) p.lo = clean;
    return clean;
  }

  /**
   * Damage after the mode's rules: pvp, no friendly fire, allowDamage, x rules.dmg x armor,
   * oneShot, scaleDamage. 0 = no damage.
   */
  damageFor(attacker, target, amount, info) {
    const R = this.rules;
    if (attacker && attacker !== target) {
      if (!R.pvp || attacker.team === target.team) return 0;
    }
    if (this.call('allowDamage', attacker, target, info) === false) return 0;
    let amt = amount * R.dmg * (target.armor ?? 1);
    if (R.oneShot && attacker && attacker !== target) amt = 999;
    const s = this.call('scaleDamage', attacker, target, amt, info);
    if (typeof s === 'number' && Number.isFinite(s)) amt = s;
    return amt > 0 ? amt : 0;
  }

  /** After the elimination bookkeeping: the game's onKill, then the core respawn rules. */
  onKill(victim, killer, info) {
    victim.respawnAt = 0;
    this.call('onKill', victim, killer, info);
    const R = this.rules;
    const out = R.lives > 0 && victim.lives <= 0;
    if (!victim.respawnAt && !this.ended && R.respawn > 0 && !out) this.respawn(victim, R.respawn);
  }

  /** The game's verdict, or null. */
  checkWin() {
    if (this.ended) return null;
    const w = this.call('checkWin');
    return w && typeof w === 'object' ? w : null;
  }

  /** At the time limit: the top score wins (no scores: the team with the most players left). */
  timeUp() {
    const top = this.scores()[0];
    if (top) return this.teamScores() ? { team: top[0], reason: 'time' } : { id: top[0], reason: 'time' };
    const n = new Map();
    for (const p of this.list) if (aliveOrComing(p)) n.set(p.team, (n.get(p.team) || 0) + 1);
    let best = null, bn = 0, tie = false;
    for (const [team, c] of n) {
      if (c > bn) { best = team; bn = c; tie = false; } else if (c === bn) tie = true;
    }
    return best !== null && !tie ? { team: best, reason: 'time' } : { reason: 'time' };
  }

  /**
   * The mode state message {t:'ms', sc, goal, tl, g, rs} when it changed (at most every 250 ms),
   * else null. sc: the top 5 scores; goal: rules.target; tl: seconds left (time limit);
   * g: the game's hud(ctx); rs: {id: seconds} until each pending respawn.
   */
  modeState(now) {
    if (now < this.msNext) return null;
    this.msNext = now + MS_EVERY;
    const m = { t: 'ms', sc: this.scores().slice(0, 5), goal: this.rules.target | 0 };
    if (this.endsAt) m.tl = Math.max(0, Math.ceil((this.endsAt - now) / 1000));
    const g = this.call('hud');
    if (g !== undefined && g !== null) m.g = g;
    let rs = null;
    for (const p of this.list) {
      if (p.alive || !(p.respawnAt > 0)) continue;
      (rs || (rs = {}))[p.id] = Math.max(0, Math.ceil((p.respawnAt - now) / 1000));
    }
    if (rs) m.rs = rs;
    const s = JSON.stringify(m);
    if (s === this.msLast) return null;
    this.msLast = s;
    this.ms = m;
    return m;
  }
}
