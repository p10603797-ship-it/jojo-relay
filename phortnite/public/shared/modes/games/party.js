// Party games: gungame, infection, koth, juggernaut, lava (+ hideseek, once rules.js lists it as a
// win option). See shared/modes/api.js for the Game
// plugin API. They run inside the shared Room (solo, Node server and P2P host alike), so they only
// use ctx: ctx.rng() for randomness and ctx.now() (ms) for time; no Math.random, Date or DOM.
// Their hud(ctx) answers reach clients as ms.g (js/game/modeClient.js draws them):
//   gungame {lv: [id, level, …]}   infection {s, z}   koth {hill: {x, z, r, owner, prog, ct}}
//   juggernaut {j}   lava {lava}   hideseek {h, s, hs (head start seconds left)}
import { WEAPONS, clampRarity } from '../../constants.js';
import { lastTeamStanding } from './core.js';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Gun Game ladder: one elimination per rung; a pickaxe elimination on the last rung wins. */
export const GUN_LADDER = Object.freeze(['rocket', 'sniper', 'shotgun', 'tactical', 'ar', 'burst', 'smg', 'pistol', 'pickaxe']);
export const HILL_RADIUS = 9;
export const HILL_MOVE_MS = 75000;
export const LAVA_START = -2;
export const LAVA_DPS = 10;

const matsOf = (rules) => ({ wood: rules.mats | 0, stone: rules.mats | 0, metal: rules.mats | 0 });

/** A loadout of legendary (or the best they come in) guns with infinite ammo; [] = pickaxe only. */
function kit(rules, keys) {
  const slots = [], ammo = {};
  for (const k of keys) {
    if (k === 'pickaxe' || !own(WEAPONS, k)) continue;
    const w = WEAPONS[k];
    slots.push({ k, r: clampRarity(k, 4), m: w.mag });
    ammo[w.ammo] = 999;
  }
  // kit: the mode handed it out (never dropped on death: a dead Juggernaut leaves no legendary rocket launcher)
  return { slots, ammo, mats: matsOf(rules), infAmmo: slots.length > 0, kit: true };
}

/** n distinct players picked at random (ctx.rng). */
function pick(ctx, list, n) {
  const a = list.slice();
  const out = [];
  while (out.length < n && a.length) out.push(a.splice(Math.floor(ctx.rng() * a.length), 1)[0]);
  return out;
}

const byId = (ctx, id) => ctx.players().find((p) => p.id === id) || null;
const r1 = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------------ Gun Game
const level = (ctx, p) => ctx.state.lv[p.id] | 0;

const gungame = {
  key: 'gungame',
  label: 'Gun Game',
  defaults: { respawn: 3, lives: 0, storm: 'none', ammo: 'infinite', floorLoot: false, chests: false, spawn: 'ground' },

  setup(ctx) {
    ctx.state.lv = {};
    ctx.state.winner = 0;
    for (const p of ctx.players()) ctx.state.lv[p.id] = 0;
  },

  loadout(ctx, p) { return kit(ctx.rules, [GUN_LADDER[level(ctx, p)]]); },

  /** Only your rung's gun hurts (and the pickaxe, which every rung has). */
  allowDamage(ctx, attacker, target, info) {
    if (!attacker || attacker === target || !info || !info.w) return true;
    return info.w === 'pickaxe' || info.w === GUN_LADDER[level(ctx, attacker)];
  },

  onKill(ctx, victim, killer, info = {}) {
    const st = ctx.state;
    if (killer && killer !== victim && !st.winner) {
      const lv = level(ctx, killer);
      if (lv >= GUN_LADDER.length - 1) {
        st.winner = killer.id; // an elimination on the pickaxe rung wins
      } else {
        st.lv[killer.id] = lv + 1;
        ctx.addScore(killer.id, 1);
        ctx.giveLoadout(killer, kit(ctx.rules, [GUN_LADDER[lv + 1]]));
      }
      // humiliation: a pickaxe elimination sends the victim one rung down
      if (info.w === 'pickaxe' && level(ctx, victim) > 0) {
        st.lv[victim.id] = level(ctx, victim) - 1;
        ctx.addScore(victim.id, -1);
      }
    }
    ctx.respawn(victim, 2, { keepLoot: false });
  },

  checkWin(ctx) { return ctx.state.winner ? { id: ctx.state.winner, reason: 'gungame' } : null; },

  hud(ctx) {
    const lv = [];
    for (const p of ctx.players()) if (level(ctx, p) > 0) lv.push(p.id, level(ctx, p));
    return { lv };
  },
};

// ------------------------------------------------------------------ the room's clock
/**
 * Infection, Hide & Seek and Floor is Lava count from set-up with the rules' time limit until the
 * room has its own clock (ctx.endTime: after setup, a bus ride first). From then on they follow it,
 * so the game ends exactly when the HUD clock (ms.tl) does: st.endAt becomes the room's end and
 * the game's other times (head start, scoring, the lava's rise) move by the bus ride with it.
 */
function syncClock(ctx) {
  const st = ctx.state;
  if (st.synced) return;
  const end = typeof ctx.endTime === 'function' ? ctx.endTime() : 0;
  if (!(end > 0)) return;
  st.synced = true;
  const shift = Number.isFinite(st.endAt) ? end - st.endAt : 0;
  st.endAt = end;
  if (!shift) return;
  for (const k of ['t0', 'seekAt', 'nextScore', 'nextHurt']) if (Number.isFinite(st[k])) st[k] += shift;
}

/** Ends the game for `team` when the room's clock is about to run out (just before the core time
 * limit, which would also pick the top score). */
function timeUp(ctx, team) {
  const st = ctx.state;
  if (!st.over && ctx.now() >= st.endAt - 150) {
    st.over = true;
    ctx.end({ team, reason: 'time' });
  }
}

// ------------------------------------------------------------------ Infection
const SURVIVORS = 1, INFECTED = 2;
const isZombie = (ctx, p) => ctx.roleOf(p) === 'zombie';

/** Everyone who started the match and is not a zombie (yet). */
function survivors(ctx) {
  const ids = ctx.state.ids || [];
  return ctx.players().filter((p) => ids.includes(p.id) && !isZombie(ctx, p));
}

function infect(ctx, p) {
  ctx.setTeam(p, INFECTED);
  ctx.setRole(p, 'zombie');
  ctx.setArmor(p, 0.7);
}

const infection = {
  key: 'infection',
  label: 'Infection',
  teamGame: true,
  teamNames: { [SURVIVORS]: 'Survivor', [INFECTED]: 'Zombie' }, // 'Zombie Team wins!'
  defaults: { teams: 'two', respawn: 3, lives: 0, storm: 'none', timeLimit: 300, spawn: 'ground', area: 'center' },

  setup(ctx) {
    const st = ctx.state;
    const ps = ctx.players();
    st.ids = ps.map((p) => p.id);
    st.t0 = ctx.now();
    st.endAt = st.t0 + (ctx.rules.timeLimit || 300) * 1000;
    st.nextScore = st.t0 + 1000;
    const n = ps.length;
    const first = n < 2 ? [] : pick(ctx, ps, Math.min(n - 1, Math.ceil(n / 6)));
    for (const p of ps) {
      if (first.includes(p)) infect(ctx, p);
      else { ctx.setTeam(p, SURVIVORS); ctx.setArmor(p, 1); }
    }
    if (first.length) ctx.note(`🧟 ${first.map((p) => p.name).join(', ')} ${first.length > 1 ? 'are' : 'is'} infected! Run!`);
  },

  /** Zombies only get a pickaxe; survivors get the mode's usual loadout. */
  loadout(ctx, p) { return isZombie(ctx, p) ? kit(ctx.rules, []) : null; },

  /** Zombies bite with their pickaxe only (no picked-up guns). */
  allowDamage(ctx, attacker, target, info) {
    if (!attacker || !isZombie(ctx, attacker) || !info || !info.w) return true;
    return info.w === 'pickaxe';
  },

  onKill(ctx, victim, killer, info = {}) {
    if (info.c === 'left') return;
    if (!isZombie(ctx, victim)) {
      infect(ctx, victim);
      if (killer && killer !== victim) ctx.addScore(INFECTED, 1);
      ctx.note(`🧟 ${victim.name} was infected!`);
    }
    ctx.respawn(victim, 3, { keepLoot: false });
  },

  tick(ctx) {
    syncClock(ctx);
    const st = ctx.state;
    const now = ctx.now();
    // every second some survivors are still standing, the survivors' team scores
    while (now >= st.nextScore) {
      st.nextScore += 1000;
      if (survivors(ctx).some((p) => p.alive)) ctx.addScore(SURVIVORS, 1);
    }
    // survivors win when the clock runs out
    timeUp(ctx, SURVIVORS);
  },

  checkWin(ctx) {
    return survivors(ctx).length === 0 ? { team: INFECTED, reason: 'infection' } : null;
  },

  hud(ctx) {
    let s = 0, z = 0;
    for (const p of ctx.players()) {
      if (isZombie(ctx, p)) z++;
      else if (p.alive && (ctx.state.ids || []).includes(p.id)) s++;
    }
    return { s, z };
  },
};

// ------------------------------------------------------------------ King of the Hill
function landAt(ctx, x, z) {
  const h = ctx.world && typeof ctx.world.heightAt === 'function' ? ctx.world.heightAt(x, z) : 0;
  return Number.isFinite(h) ? h : 0;
}

/** A new hill inside the play area: a place (region) centre, else open land; never the same spot twice. */
function placeHill(ctx, prev) {
  const a = ctx.area || { x: 0, z: 0, r: 300 };
  const regions = (ctx.world && Array.isArray(ctx.world.regions) ? ctx.world.regions : []).filter((g) => {
    const dx = g.x - a.x, dz = g.z - a.z;
    if (dx * dx + dz * dz > (a.r - HILL_RADIUS) * (a.r - HILL_RADIUS)) return false;
    if (prev && (g.x - prev.x) * (g.x - prev.x) + (g.z - prev.z) * (g.z - prev.z) < 30 * 30) return false;
    return landAt(ctx, g.x, g.z) > 0.5;
  });
  let x, z;
  if (regions.length) {
    const g = regions[Math.floor(ctx.rng() * regions.length)];
    x = g.x; z = g.z;
  } else {
    x = a.x; z = a.z;
    for (let i = 0; i < 40; i++) {
      const ang = ctx.rng() * Math.PI * 2, d = Math.sqrt(ctx.rng()) * a.r * 0.6;
      const tx = a.x + Math.cos(ang) * d, tz = a.z + Math.sin(ang) * d;
      if (landAt(ctx, tx, tz) <= 1.5) continue;
      if (prev && (tx - prev.x) * (tx - prev.x) + (tz - prev.z) * (tz - prev.z) < 30 * 30) continue;
      x = tx; z = tz;
      break;
    }
  }
  return { x: r1(x), z: r1(z), y: landAt(ctx, x, z), r: HILL_RADIUS };
}

/** Teams with a living player standing in the hill. */
function teamsInHill(ctx, h, out) {
  out.length = 0;
  for (const p of ctx.players()) {
    if (!p.alive) continue;
    const dx = p.x - h.x, dz = p.z - h.z;
    if (dx * dx + dz * dz > h.r * h.r || p.y < h.y - 3 || p.y > h.y + 10) continue;
    if (!out.includes(p.team)) out.push(p.team);
  }
  return out;
}

const koth = {
  key: 'koth',
  label: 'King of the Hill',
  teamGame: true,
  defaults: { teams: 'two', target: 100, respawn: 5, lives: 0, storm: 'none', spawn: 'ground', area: 'center' },

  setup(ctx) {
    const st = ctx.state;
    st.hill = placeHill(ctx, null);
    st.moveAt = ctx.now() + HILL_MOVE_MS;
    st.nextScore = ctx.now() + 1000;
    st.owner = 0;
    st.contested = false;
    st.inside = [];
  },

  tick(ctx) {
    const st = ctx.state;
    const now = ctx.now();
    if (now >= st.moveAt) {
      st.hill = placeHill(ctx, st.hill);
      st.moveAt += HILL_MOVE_MS;
      st.owner = 0;
      ctx.note('👑 The hill moved!');
    }
    while (now >= st.nextScore) {
      st.nextScore += 1000;
      const inside = teamsInHill(ctx, st.hill, st.inside);
      st.contested = inside.length > 1;
      st.owner = inside.length === 1 ? inside[0] : 0;
      if (st.owner) ctx.addScore(st.owner, 1);
    }
  },

  checkWin(ctx) {
    const top = ctx.scores()[0];
    const target = ctx.rules.target || 100;
    return top && top[1] >= target ? { team: top[0], reason: 'koth' } : null;
  },

  hud(ctx) {
    const st = ctx.state, h = st.hill;
    const prog = Math.max(0, Math.min(1, (st.moveAt - ctx.now()) / HILL_MOVE_MS));
    return { hill: { x: h.x, z: h.z, r: h.r, owner: st.owner, prog: Math.round(prog * 100) / 100, ct: st.contested ? 1 : 0 } };
  },
};

// ------------------------------------------------------------------ Juggernaut
const isJugg = (ctx, p) => ctx.roleOf(p) === 'jugg';

/** p becomes the Juggernaut; give = hand over the kit now (at the start, loadout() does it). */
function makeJugg(ctx, p, give = true) {
  const st = ctx.state;
  st.jugg = p.id;
  st.pickAt = 0;
  ctx.setRole(p, 'jugg');
  ctx.setArmor(p, 0.2);
  if (give) ctx.giveLoadout(p, kit(ctx.rules, ['ar', 'rocket']));
  ctx.note(`🦾 ${p.name} is the Juggernaut!`);
}

function pickJugg(ctx, give = true) {
  const alive = ctx.players().filter((p) => p.alive);
  if (alive.length) makeJugg(ctx, alive[Math.floor(ctx.rng() * alive.length)], give);
}

const juggernaut = {
  key: 'juggernaut',
  label: 'Juggernaut',
  defaults: { target: 100, respawn: 3, lives: 0, storm: 'none', spawn: 'ground', area: 'center' },

  setup(ctx) {
    const st = ctx.state;
    st.jugg = 0;
    st.pickAt = 0;
    st.nextScore = ctx.now() + 1000;
    pickJugg(ctx, false);
  },

  loadout(ctx, p) { return isJugg(ctx, p) ? kit(ctx.rules, ['ar', 'rocket']) : null; },

  onKill(ctx, victim, killer, info = {}) {
    const st = ctx.state;
    if (victim.id === st.jugg) {
      ctx.setRole(victim, null);
      ctx.setArmor(victim, 1);
      st.jugg = 0;
      if (killer && killer !== victim && killer.alive && info.c !== 'left') makeJugg(ctx, killer);
      else st.pickAt = ctx.now() + 1000; // the storm, a fall or leaving: a random new Juggernaut soon
    }
    if (info.c !== 'left') ctx.respawn(victim, 3, { keepLoot: false });
  },

  tick(ctx) {
    const st = ctx.state;
    const now = ctx.now();
    if (!st.jugg && st.pickAt && now >= st.pickAt) pickJugg(ctx);
    while (now >= st.nextScore) {
      st.nextScore += 1000;
      const j = st.jugg ? byId(ctx, st.jugg) : null;
      if (j && j.alive) ctx.addScore(j.id, 1);
    }
  },

  checkWin(ctx) {
    const top = ctx.scores()[0];
    const target = ctx.rules.target || 100;
    return top && top[1] >= target ? { id: top[0], reason: 'juggernaut' } : null;
  },

  hud(ctx) { return { j: ctx.state.jugg | 0 }; },
};

// ------------------------------------------------------------------ Floor is Lava
/**
 * Where the lava starts and ends ({lo, top}), from the area's real relief: it starts just under
 * the lowest land (5th percentile) and rises above most of it, med + 10 at least, up to the 90th
 * percentile + 3, never more than med + 25. Flat towns (the island's centre plateau) flood by mid
 * match, leaving the hilltops and what players build; mountains don't need a 50 m climb.
 */
export function lavaRange(ctx) {
  const a = ctx.area || { x: 0, z: 0, r: 300 };
  const hs = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = a.x - a.r + (2 * a.r * i) / n, z = a.z - a.r + (2 * a.r * j) / n;
      if ((x - a.x) * (x - a.x) + (z - a.z) * (z - a.z) > a.r * a.r) continue;
      const h = landAt(ctx, x, z);
      if (h > 0.5) hs.push(h);
    }
  }
  if (!hs.length) return { lo: LAVA_START, top: 8 };
  hs.sort((p, q) => p - q);
  const at = (f) => hs[Math.min(hs.length - 1, Math.floor((hs.length - 1) * f))];
  const med = at(0.5);
  const lo = Math.max(LAVA_START, at(0.05) - 1);
  const top = Math.max(lo + 4, Math.min(med + 25, Math.max(at(0.9) + 3, med + 10)));
  return { lo: r1(lo), top: r1(top) };
}

/** The lava height now: from st.lo up to st.top over the time limit (a little quicker at first). */
export function lavaLevel(ctx) {
  const st = ctx.state;
  const k = Math.max(0, Math.min(1, (ctx.now() - st.t0) / st.dur));
  const lo = Number.isFinite(st.lo) ? st.lo : LAVA_START;
  return lo + (st.top - lo) * Math.pow(k, 0.85);
}

const lava = {
  key: 'lava',
  label: 'Floor is Lava',
  defaults: { storm: 'none', spawn: 'ground', mats: 500, timeLimit: 300, area: 'center' },

  setup(ctx) {
    const st = ctx.state;
    st.t0 = ctx.now();
    st.dur = (ctx.rules.timeLimit || 300) * 1000;
    st.endAt = st.t0 + st.dur; // (moved to the room's clock by syncClock: the lava rises from the landing)
    const { lo, top } = lavaRange(ctx);
    st.lo = lo;
    st.top = top;
    st.level = lo;
    st.nextHurt = st.t0 + 1000;
  },

  tick(ctx) {
    syncClock(ctx);
    const st = ctx.state;
    const now = ctx.now();
    st.level = lavaLevel(ctx);
    // once a second, everyone in the lava takes LAVA_DPS (shields don't help)
    while (now >= st.nextHurt) {
      st.nextHurt += 1000;
      for (const p of ctx.players()) {
        if (!p.alive || p.y >= st.level + 0.2) continue;
        ctx.damage(p, LAVA_DPS, { c: 'lava', ignoreShield: true });
      }
      for (const p of ctx.players()) if (p.alive) ctx.addScore(p.id, 1);
    }
    // the clock runs out: everyone still standing survived the lava (one side left: that side wins;
    // more: a shared win, never the first to have joined on a tied score)
    if (!st.over && ctx.now() >= st.endAt - 150) {
      st.over = true;
      const alive = ctx.alive();
      const teams = [...new Set(alive.map((p) => p.team))];
      if (teams.length === 1) ctx.end(alive.length === 1 ? { id: alive[0].id, team: alive[0].team, reason: 'lava' } : { team: teams[0], reason: 'lava' });
      else ctx.end({ reason: 'survived' });
    }
  },

  /** The last side with someone alive or waiting to respawn (with respawns on, a death is not the end). */
  checkWin(ctx) {
    const w = lastTeamStanding(ctx, 'lava'); // null while two sides are in, or when only one side ever played
    if (!w || w.team === undefined) return w;
    const left = ctx.players().filter((p) => p.team === w.team && (p.alive || p.respawnAt > 0));
    return left.length === 1 ? { id: left[0].id, team: w.team, reason: 'lava' } : w;
  },

  hud(ctx) { return { lava: r1(ctx.state.level) }; },
};

// ------------------------------------------------------------------ Hide & Seek (stretch)
// Playable once 'hideseek' is one of the win options in shared/modes/rules.js (append-only).
export const HIDE_MS = 30000;
const HIDERS = 1, SEEKERS = 2;
const isSeeker = (ctx, p) => ctx.roleOf(p) === 'seeker';

function hiders(ctx) {
  const ids = ctx.state.ids || [];
  return ctx.players().filter((p) => ids.includes(p.id) && !isSeeker(ctx, p));
}

function makeSeeker(ctx, p) {
  ctx.setTeam(p, SEEKERS);
  ctx.setRole(p, 'seeker');
  ctx.setArmor(p, 1);
}

const hideseek = {
  key: 'hideseek',
  label: 'Hide & Seek',
  teamGame: true,
  teamNames: { [HIDERS]: 'Hider', [SEEKERS]: 'Seeker' },
  defaults: {
    teams: 'two', respawn: 3, lives: 0, storm: 'none', timeLimit: 300, spawn: 'ground', area: 'center', loadout: 'pickaxe',
    floorLoot: false, chests: false, build: 'off',
  },

  setup(ctx) {
    const st = ctx.state;
    const ps = ctx.players();
    st.ids = ps.map((p) => p.id);
    st.t0 = ctx.now();
    st.seekAt = st.t0 + HIDE_MS;
    st.endAt = st.t0 + (ctx.rules.timeLimit || 300) * 1000;
    st.nextScore = st.seekAt + 1000;
    const n = ps.length;
    const first = n < 2 ? [] : pick(ctx, ps, Math.min(n - 1, Math.max(1, Math.ceil(n / 5))));
    for (const p of ps) {
      if (first.includes(p)) makeSeeker(ctx, p);
      else { ctx.setTeam(p, HIDERS); ctx.setArmor(p, 1); }
    }
    if (first.length) ctx.note(`🙈 ${first.map((p) => p.name).join(', ')} ${first.length > 1 ? 'are' : 'is'} seeking! Hide!`);
  },

  /** Everyone has just a pickaxe. */
  loadout(ctx) { return kit(ctx.rules, []); },

  /** Nobody gets hurt during the head start; afterwards only seekers can tag (one hit finds you). */
  allowDamage(ctx, attacker, target) {
    if (!attacker || attacker === target) return true;
    syncClock(ctx);
    if (ctx.now() < ctx.state.seekAt) return false;
    return isSeeker(ctx, attacker) && !isSeeker(ctx, target);
  },

  scaleDamage(ctx, attacker, target, amount) { return attacker && isSeeker(ctx, attacker) ? 999 : amount; },

  onKill(ctx, victim, killer, info = {}) {
    if (info.c === 'left') return;
    if (!isSeeker(ctx, victim)) {
      makeSeeker(ctx, victim);
      if (killer && killer !== victim) ctx.addScore(SEEKERS, 1);
      ctx.note(`👀 ${victim.name} was found!`);
    }
    ctx.respawn(victim, 3, { keepLoot: false });
  },

  tick(ctx) {
    syncClock(ctx);
    const st = ctx.state;
    const now = ctx.now();
    while (now >= st.nextScore) {
      st.nextScore += 1000;
      if (hiders(ctx).some((p) => p.alive)) ctx.addScore(HIDERS, 1);
    }
    timeUp(ctx, HIDERS);
  },

  checkWin(ctx) {
    return hiders(ctx).length === 0 ? { team: SEEKERS, reason: 'hideseek' } : null;
  },

  hud(ctx) {
    let h = 0, s = 0;
    for (const p of ctx.players()) {
      if (isSeeker(ctx, p)) s++;
      else if (p.alive && (ctx.state.ids || []).includes(p.id)) h++;
    }
    return { h, s, hs: Math.max(0, Math.ceil((ctx.state.seekAt - ctx.now()) / 1000)) };
  },
};

export const PARTY_GAMES = { gungame, infection, koth, juggernaut, lava, hideseek };
