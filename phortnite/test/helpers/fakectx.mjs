// FakeCtx: the Game plugin ctx API (public/shared/modes/api.js) over plain player records, so a
// party game (shared/modes/games/*.js) can be tested without a Room.
//
//   const ctx = new FakeCtx({ game: PARTY_GAMES.koth, rules: { win: 'koth', teams: 2 }, players: 8 });
//   ctx.start();                       // setup(ctx) + loadout(ctx, p) for everyone
//   ctx.players()[0].x = 12;           // move players around by hand
//   ctx.hit(a, b, 40);                 // a damages b (allowDamage / scaleDamage / rules applied)
//   ctx.advance(5000);                 // 10 Hz: due respawns, tick(ctx, 0.1), time limit, checkWin
//   ctx.result; ctx.scores(); ctx.roleLog; ctx.loadouts; ctx.respawns; ctx.revived; ctx.elims; ctx.notes
//
// What it records: roles (roles Map + roleLog), loadouts, scores, scheduled respawns and revivals,
// eliminations, notes, hud() answers and the end result (the first end() wins).
import { normalizeRules } from '../../public/shared/modes/rules.js';
import { mulberry32 } from '../../public/shared/rng.js';

const TEAM_LOOK = [
  ['Blue', '#3ea4ff'], ['Red', '#ff4d4d'], ['Green', '#5ad13a'], ['Yellow', '#ffd23f'],
  ['Purple', '#bd52ff'], ['Orange', '#ff8a00'], ['Pink', '#ff6fb1'], ['Teal', '#2fd6c3'],
];
const STEP_MS = 100; // checkWin / tick run at 10 Hz, like the Room

/** A small flat stand-in for the world data contract (shared/worldgen.js). Pass getWorld() for the real island. */
export const FLAT_WORLD = {
  version: 1, size: 640, half: 320,
  heightAt: () => 5,
  biomeAt: () => 'meadow',
  surfaceKeyAt: null,
  regions: [
    { id: 0, name: 'Pinewood Plaza', x: -120, z: -60, r: 48, biome: 'meadow', kind: 'town', tier: 'normal', named: true },
    { id: 1, name: 'Breezy Bluffs', x: 80, z: -140, r: 48, biome: 'meadow', kind: 'town', tier: 'normal', named: true },
    { id: 2, name: 'Mossy Mill', x: 170, z: 20, r: 48, biome: 'meadow', kind: 'town', tier: 'normal', named: true },
  ],
  spawnPoints: [],
  roads: [], rivers: [], lakes: [], pads: [], lava: [],
  objects: [],
  objectsNear() {},
};

/** n player records as the Room keeps them; the first `humans` are humans, the rest bots. */
export function makePlayers(n, { humans = 1, rules = normalizeRules({}) } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = i + 1;
    const bot = i >= humans;
    let team = id;
    if (typeof rules.teams === 'number' && rules.teams > 1) team = Math.floor(i / rules.teams) + 1;
    else if (rules.teams === 'two') team = (i % 2) + 1;
    else if (rules.teams === 'humans') team = bot ? 1000 + id : 1;
    const a = (i / n) * Math.PI * 2;
    out.push({
      id, name: bot ? `Bot ${id}` : `Player ${id}`, bot, team, alive: true, hp: rules.hp, sh: rules.shield, kills: 0,
      x: Math.cos(a) * 40, y: 5, z: Math.sin(a) * 40, role: null, armor: 1, lives: rules.lives, respawnAt: 0,
    });
  }
  return out;
}

export class FakeCtx {
  /**
   * opts: game (a Game plugin), rules (deltas, normalized here), players (a count or records),
   * humans (how many of a count are humans, default 1), seed (rng), area {x,z,r}, world.
   */
  constructor({ game = null, rules = {}, players = 8, humans = 1, seed = 1, area = null, world = null } = {}) {
    this.game = game;
    this.rules = normalizeRules({ ...(game && game.defaults), ...rules });
    this.t = 0;
    this.t0 = 0;
    this.nextStep = STEP_MS;
    this.random = mulberry32(seed);
    this.list = Array.isArray(players) ? players : makePlayers(players, { humans, rules: this.rules });
    this.area = area || { x: 0, z: 0, r: 300 };
    this.world = world || FLAT_WORLD;
    this.state = {};
    // what happened
    this.roles = new Map();
    this.roleLog = [];
    this.loadouts = [];
    this.respawns = [];
    this.revived = [];
    this.elims = [];
    this.damages = [];
    this.notes = [];
    this.hudLog = [];
    this.scoreMap = new Map();
    this.result = null;
    this.ended = false;
  }

  // ------------------------------------------------------------------ the ctx API (api.js)
  now() { return this.t; }
  rng() { return this.random(); }
  players() { return this.list; }
  alive() { return this.list.filter((p) => p.alive); }
  humans() { return this.list.filter((p) => !p.bot); }

  teams() {
    const seen = [];
    for (const p of this.list) if (!seen.includes(p.team)) seen.push(p.team);
    return seen.map((id, i) => ({ id, name: TEAM_LOOK[i % TEAM_LOOK.length][0], color: TEAM_LOOK[i % TEAM_LOOK.length][1] }));
  }

  addScore(key, n = 1) { this.scoreMap.set(key, (this.scoreMap.get(key) || 0) + n); }
  score(key) { return this.scoreMap.get(key) || 0; }
  /** [[key, n]], best first (ties keep the order they first scored in). */
  scores() { return [...this.scoreMap.entries()].sort((a, b) => b[1] - a[1]); }

  setRole(p, role) {
    p.role = role ?? null;
    this.roles.set(p.id, p.role);
    this.roleLog.push({ t: this.t, id: p.id, role: p.role });
  }

  roleOf(p) { return p.role ?? null; }
  setArmor(p, k) { p.armor = k; }
  setTeam(p, id) { p.team = id; }

  giveLoadout(p, lo) {
    p.lo = lo;
    this.loadouts.push({ t: this.t, id: p.id, lo });
  }

  respawn(p, delaySec = this.rules.respawn, { keepLoot = this.rules.respawnKeep } = {}) {
    p.respawnAt = this.t + delaySec * 1000;
    p.keepLoot = !!keepLoot;
    this.respawns.push({ t: this.t, id: p.id, at: p.respawnAt, keepLoot: !!keepLoot });
  }

  /** Environmental damage (lava, hazards): no attacker; shield first unless info.ignoreShield. */
  damage(p, amount, info = {}) { return this.applyDamage(p, amount, null, info); }

  eliminate(p, killer = null, info = {}) {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.sh = 0;
    if (killer && killer !== p) killer.kills++;
    if (this.rules.lives > 0) p.lives = Math.max(0, p.lives - 1);
    this.elims.push({ t: this.t, victim: p.id, killer: killer ? killer.id : 0, info });
    p.respawnAt = 0;
    if (this.game && this.game.onKill) this.game.onKill(this, p, killer, info);
    // the core respawn rules apply unless the game scheduled one itself
    const out = this.rules.lives > 0 && p.lives <= 0;
    if (!p.respawnAt && !this.ended && this.rules.respawn > 0 && !out) this.respawn(p, this.rules.respawn);
    this.checkWin();
  }

  end(result) {
    if (this.ended) return;
    this.ended = true;
    this.result = result;
  }

  note(msg) { this.notes.push(msg); }

  // ------------------------------------------------------------------ driving a test
  /** Match start: setup(ctx), then everyone's loadout(ctx, p). */
  start() {
    this.t0 = this.t;
    if (this.game && this.game.setup) this.game.setup(this);
    for (const p of this.list) this.giveStartLoadout(p);
  }

  giveStartLoadout(p) {
    const lo = this.game && this.game.loadout ? this.game.loadout(this, p) : null;
    if (lo) this.giveLoadout(p, lo);
  }

  /** Move the clock on by ms in 10 Hz steps: due respawns, tick(ctx, 0.1), the time limit, checkWin. */
  advance(ms) {
    const end = this.t + ms;
    while (this.nextStep <= end && !this.ended) {
      this.t = this.nextStep;
      this.nextStep += STEP_MS;
      this.step(STEP_MS / 1000);
    }
    this.t = end;
  }

  step(dt) {
    for (const p of this.list) {
      if (p.alive || !p.respawnAt || this.t < p.respawnAt) continue;
      p.respawnAt = 0;
      p.alive = true;
      p.hp = this.rules.hp;
      p.sh = this.rules.shield;
      this.revived.push({ t: this.t, id: p.id });
      if (!p.keepLoot) this.giveStartLoadout(p);
      if (this.game && this.game.onRespawn) this.game.onRespawn(this, p);
    }
    if (this.game && this.game.tick) this.game.tick(this, dt);
    if (this.ended) return;
    if (this.rules.timeLimit > 0 && this.t - this.t0 >= this.rules.timeLimit * 1000) {
      const top = this.scores()[0];
      const team = this.game && this.game.teamGame;
      this.end(top ? { ...(team ? { team: top[0] } : { id: top[0] }), reason: 'time' } : { reason: 'time' });
      return;
    }
    this.checkWin();
  }

  checkWin() {
    if (this.ended || !this.game || !this.game.checkWin) return;
    const w = this.game.checkWin(this);
    if (w) this.end(w);
  }

  /**
   * attacker damages target the way the Room's hit handler does: pvp, no friendly fire,
   * allowDamage, × rules.dmg × target armor, oneShot, scaleDamage, then shield and health.
   */
  hit(attacker, target, amount, info = {}) {
    if (!target.alive || this.ended || !this.rules.pvp) return 0;
    if (attacker && attacker !== target && attacker.team === target.team) return 0;
    const g = this.game;
    if (g && g.allowDamage && !g.allowDamage(this, attacker, target, info)) return 0;
    let amt = amount * this.rules.dmg * (target.armor ?? 1);
    if (this.rules.oneShot) amt = 999;
    if (g && g.scaleDamage) amt = g.scaleDamage(this, attacker, target, amt, info);
    return this.applyDamage(target, amt, attacker, info);
  }

  applyDamage(p, amount, attacker, info) {
    if (!p.alive || !(amount > 0)) return 0;
    let rest = amount;
    if (!info.ignoreShield && p.sh > 0) {
      const s = Math.min(p.sh, rest);
      p.sh -= s;
      rest -= s;
    }
    p.hp = Math.max(0, p.hp - rest);
    this.damages.push({ t: this.t, id: p.id, by: attacker ? attacker.id : 0, amount });
    if (p.hp <= 0) this.eliminate(p, attacker, info);
    return amount;
  }

  /** The game's hud(ctx) answer (recorded); throws if it is over the 300 byte budget. */
  hud() {
    const h = this.game && this.game.hud ? this.game.hud(this) : null;
    const bytes = h == null ? 0 : JSON.stringify(h).length;
    if (bytes > 300) throw new Error(`hud(ctx) is ${bytes} bytes (at most 300)`);
    this.hudLog.push(h);
    return h;
  }
}
