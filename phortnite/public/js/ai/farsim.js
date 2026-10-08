// Cheap simulation for bots nobody can see: more than FAR_OUT metres from every human (and from
// the camera, so a spectator never watches one) a bot switches to 'far' mode until a human comes
// within FAR_IN:
//  - no physics: the capsule is switched off and the bot slides along its nav route at running
//    speed with y on the walking surface (Nav.groundY); it still sends its state like any bot
//  - it thinks once a second: storm, loot and chests it walks past, healing, where to go next
//  - far-vs-far fights are resolved statistically (the gun's damage x a hit chance from skill and
//    range) but every hit is a real 'hit' message, so the room keeps authority and the kill feed,
//    storm, siphon and modes see nothing different
// Waking up snaps the capsule to open ground (never inside a wall or a building).
import { WEAPONS, HEALS, ANIM, PLAYER } from '../../shared/constants.js';
import { weaponRange } from '../actors/bot.js';
import { passive, buildRule } from './goals.js';

export const FAR_OUT = 180, FAR_IN = 160;
const CHECK_S = 0.5;          // how often a bot asks whether it is far
const THINK_S = 1;            // far brains think once a second
const FIGHT_S = 0.5;          // far fights are rolled twice a second
const FIGHT_R = 70;           // m: far bots notice and fight each other within this (snipers further)
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// ------------------------------------------------------------------ who could see a bot
const _hum = { g: null, t: -1, n: 0, xs: new Float32Array(64), zs: new Float32Array(64) };
/** Positions of every human in the session plus the camera (rebuilt once per game frame). */
function humans(g) {
  if (_hum.g === g && _hum.t === g.time) return _hum;
  _hum.g = g; _hum.t = g.time; _hum.n = 0;
  const add = (x, z) => { if (_hum.n < 64) { _hum.xs[_hum.n] = x; _hum.zs[_hum.n] = z; _hum.n++; } };
  if (g.me && g.me.alive && !g.me.inBus) add(g.me.pos.x, g.me.pos.z);
  for (const r of g.remotes.values()) if (!r.isBot && r.alive !== false) add(r.pos.x, r.pos.z);
  if (g.camera) add(g.camera.position.x, g.camera.position.z);
  return _hum;
}

/** Squared distance from (x, z) to the nearest human (or the camera). */
export function humanDist2(g, x, z) {
  const h = humans(g);
  let best = Infinity;
  for (let i = 0; i < h.n; i++) {
    const dx = h.xs[i] - x, dz = h.zs[i] - z, d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Should this bot be simulated cheaply right now? Checked every CHECK_S per bot (staggered);
 * returns the current wish in between.
 */
export function wantFar(bot, dt) {
  const b = bot.brain, g = bot.game;
  if ((b.farChkT -= dt) > 0) return b.farWant;
  b.farChkT = CHECK_S * (0.8 + Math.random() * 0.4);
  let want = false;
  if (g.phase === 'match' && bot.alive && !bot.inBus && g.spectateId !== bot.id && bot.nav && bot.nav.ready
    && bot.time - b.hurtNearT > 4 && !bot.build.busy) {
    const m = bot.mode;
    const r = bot.far ? FAR_IN : FAR_OUT;
    if ((bot.far || m === 'ground' || m === 'swim') && humanDist2(g, bot.pos.x, bot.pos.z) > r * r) want = true;
  }
  b.farWant = want;
  return want;
}

/** Switch the capsule off and start sliding along the nav route. */
export function enterFar(bot) {
  const b = bot.brain;
  bot.far = true;
  bot.mover.setEnabled(false);
  bot.ads = false;
  bot.dancing = false;
  b.farThinkT = Math.random() * THINK_S;
  b.farHealT = -1;
  b.farTarget = null;
  b.wallReq = false;
  bot.build.clear();
  bot.mover.vel.set(0, 0, 0);
}

/** Back to the full simulation: the capsule on open ground under us. */
export function exitFar(bot) {
  const b = bot.brain, nav = bot.nav, p = bot.pos;
  bot.far = false;
  b.farTarget = null;
  b.farHealT = -1;
  let x = p.x, z = p.z;
  if (nav && nav.ready) {
    const o = nav.nearestOpen(x, z, 16, _o);
    if (o) { x = o.x; z = o.z; }
  }
  const y = nav && nav.ready ? nav.groundY(x, z) : bot.game.world.data.heightAt(x, z);
  bot.mover.setEnabled(true);
  bot.mover.teleport(x, y + 0.25, z);
  bot.mover.mode = y <= -1 ? 'swim' : 'air';
  b.lastPos.copy(bot.pos);
  b.stuckT = 0; b.stuckN = 0; b.noProg = 0; b.detourT = 0; b.breakT = 0;
  bot.follow.lastT = -1; // progress timers start over
  // a moment for the world's colliders around us to stream back in (js/world/colliders.js skips
  // far bots) before walking anywhere
  b.wakeT = bot.time + 0.4;
}
const _o = { x: 0, z: 0 };

// ------------------------------------------------------------------ the far brain
/** One frame of a far bot: think now and then, follow the route, heal, never touch physics. */
export function farUpdate(bot, dt) {
  const b = bot.brain, g = bot.game;
  bot.time += dt;
  bot.cool = Math.max(0, bot.cool - dt);
  b.planT -= dt; b.goalT -= dt;
  if ((b.farThinkT -= dt) <= 0) {
    b.farThinkT = THINK_S;
    farThink(bot);
  }
  farFights(g);
  // a heal in progress
  if (b.farHealT >= 0) {
    b.farHealT += dt;
    const s = bot.inv.slots[b.farHealSlot];
    const h = s && has(HEALS, s.k) ? HEALS[s.k] : null;
    if (!h) b.farHealT = -1;
    else if (b.farHealT >= h.time) {
      b.farHealT = -1;
      g.reportHeal(bot, s.k);
      s.n -= 1;
      if (s.n <= 0) { bot.inv.slots[b.farHealSlot] = null; bot.select(0); }
      bot.onInventory();
    }
  }
  // standing still while fighting or healing, otherwise along the route
  let moving = false;
  if (!b.farTarget && b.farHealT < 0 && b.destKind) {
    bot.navGoal(b.dest);
    const r = bot.follow.step(bot.pos.x, bot.pos.y, bot.pos.z, bot.time, dt);
    if (r === 1) {
      const dx = bot.follow.tx - bot.pos.x, dz = bot.follow.tz - bot.pos.z, l = Math.hypot(dx, dz);
      if (l > 0.05) {
        const water = bot.pos.y < -0.9;
        const sprint = b.urgent > 0 || l > 30;
        const sp = (water ? 3.6 : sprint ? PLAYER.sprint : PLAYER.run) * (bot.mover.mods ? bot.mover.mods.speed : 1);
        const k = Math.min(l, sp * dt) / l;
        const nx = bot.pos.x + dx * k, nz = bot.pos.z + dz * k;
        const ny = bot.nav.groundY(nx, nz);
        bot.mover.vel.set((nx - bot.pos.x) / dt, (ny - bot.pos.y) / dt, (nz - bot.pos.z) / dt);
        bot.mover.pos.set(nx, ny, nz);
        bot.yaw = Math.atan2(-dx, -dz);
        bot.speed = sp;
        bot.anim = water ? ANIM.RUN : sprint ? ANIM.SPRINT : ANIM.RUN;
        moving = true;
      }
    } else if (r === 0 || r === -1) {
      if (r === -1 && b.lootRef) b.badLoot.add(b.lootRef.id);
      b.destKind = ''; b.planT = 0;
      if (r === -1) b.goalT = 0;
    }
  }
  if (!moving) {
    bot.mover.vel.set(0, 0, 0);
    bot.speed = 0;
    bot.anim = ANIM.IDLE;
    const y = bot.nav.groundY(bot.pos.x, bot.pos.z);
    if (Math.abs(y - bot.pos.y) > 0.05) bot.mover.pos.y = y;
  }
  bot.flags = 0;
  bot.pitch = 0;
  bot.animate(dt);
}

function farThink(bot) {
  const b = bot.brain, g = bot.game;
  b.urgent = bot.stormUrgency();
  // pick things up we're standing next to, open chests we're passing
  if (b.farHealT < 0) {
    for (const it of g.loot.items.values()) {
      const dx = it.x - bot.pos.x, dz = it.z - bot.pos.z;
      if (dx * dx + dz * dz > 9 || Math.abs(it.y - bot.pos.y) > 3 || bot.pendingPick.has(it.id)) continue;
      if (bot.lootValue(it.item) > 0) bot.grab(it);
    }
    const c = g.nearestChest(bot.pos, 5);
    if (c) g.openChest(bot, c.i);
  }
  // heal up when nothing is going on
  if (b.farHealT < 0 && !b.farTarget && bot.time - b.hurtT > 4) {
    const s = bot.healSlot();
    if (s > 0 && (bot.hp < 75 || bot.sh < 50 || (bot.sh < 100 && has(HEALS, bot.inv.slots[s].k) && HEALS[bot.inv.slots[s].k].sh))) {
      b.farHealT = 0; b.farHealSlot = s;
      bot.select(s);
    }
  }
  if (b.farHealT < 0 && (!b.destKind || b.planT <= 0)) bot.planTravel(true);
  // the gun for the fight we're in
  if (b.farTarget) {
    const d = Math.hypot(b.farTarget.pos.x - bot.pos.x, b.farTarget.pos.z - bot.pos.z);
    const s = bot.bestWeaponFor(d);
    if (s > 0 && s !== bot.inv.sel) bot.select(s);
  } else if (b.farHealT < 0) {
    const cur = bot.current();
    if (!cur || !has(WEAPONS, cur.k)) { const s = bot.bestWeaponFor(30); if (s > 0) bot.select(s); }
  }
}

// ------------------------------------------------------------------ statistical fights
// Modelled on the full brain: an enemy is noticed within sight range (sooner up close, or when it
// shoots), bots with almost nothing yet keep looting instead of taking long fights, the patient
// ones don't shoot at long range, a hit gets a wall up now and then (cover for a moment), and a
// hurt bot boxes up and heals. Hit chance from skill and how well the gun suits the range, with
// time spent strafing, reloading and re-peeking (DUTY).
const _fs = { g: null, t: -99 };
const _far = [];
const DUTY = 0.45;

function noticeRange(b) { return 55 + 55 * b.skill; }

/** Materials for pieces nobody sees go down (most plentiful material first). */
function spend(a, n) {
  if (a.infMats || a.infinite) return true;
  const m = a.inv.mats;
  const k = m.wood >= m.stone && m.wood >= m.metal ? 'wood' : m.stone >= m.metal ? 'stone' : 'metal';
  if (m[k] < n) return false;
  m[k] -= n;
  return true;
}

/** Would this far bot take a fight with o at distance d (the brain's decide(), roughly)? */
function wantsFight(a, o, d, now) {
  const b = a.brain, P = b.persona;
  if (!a.hasGun()) return false;
  const threat = now - b.hurtT < 4;
  if (b.urgent === 2 && d > 25 && !threat) return false;
  if (a.itemCount() < 2 && !threat && d > 15) return false;
  const s = a.bestWeaponFor(d);
  if (s < 0) return false;
  const rg = weaponRange(a.inv.slots[s].k);
  const reach = Math.min(rg[2] * 1.2, rg[1] * 2 * (0.5 + P.aggro));
  return threat || d < reach || P.aggro >= 0.7 || (P.aggro >= 0.4 && a.gunCount() >= 2);
}

/** Twice a second, once per game: far bots near each other trade (real) hits. */
export function farFights(g) {
  if (_fs.g !== g) { _fs.g = g; _fs.t = -99; }
  if (g.time - _fs.t < FIGHT_S) return;
  const dt = Math.min(1, g.time - _fs.t);
  _fs.t = g.time;
  if (passive(g) || g.phase !== 'match') return;
  _far.length = 0;
  for (const b of g.bots.values()) if (b.far && b.alive) _far.push(b);
  for (const a of _far) {
    const ab = a.brain, now = a.time;
    // keep (or find) someone to fight
    let t = ab.farTarget;
    if (t && (!t.alive || !t.far || !a.isEnemy(t))) t = null;
    if (t) {
      const d = Math.hypot(t.pos.x - a.pos.x, t.pos.z - a.pos.z);
      if (d > noticeRange(ab) * 1.3 || !wantsFight(a, t, d, now)) t = null;
    } else {
      let bd = Infinity, best = null;
      const R = noticeRange(ab);
      for (const o of _far) {
        if (o === a || !a.isEnemy(o)) continue;
        const dx = o.pos.x - a.pos.x, dz = o.pos.z - a.pos.z, d2 = dx * dx + dz * dz;
        if (d2 < bd && d2 < R * R * (o.time - o.lastShot < 1 ? 2.25 : 1)) { bd = d2; best = o; }
      }
      if (best) {
        const d = Math.sqrt(bd);
        // noticing takes a moment: about a second up close, several at the edge of sight
        const pNotice = (0.15 + 0.6 * (1 - d / (R * 1.5))) * (best.time - best.lastShot < 1 ? 1.6 : 1) * dt;
        if (Math.random() < pNotice && wantsFight(a, best, d, now)) t = best;
      }
    }
    ab.farTarget = t;
    if (!t) continue;
    const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    a.yaw = Math.atan2(-dx, -dz);
    // hurt: box up and heal (the box is cover while it lasts)
    if (a.hp + a.sh < 70 && ab.farHealT < 0 && now > ab.farCoverT) {
      const hs = a.healSlot();
      if (hs > 0 && Math.random() < 0.5 + 0.4 * ab.persona.build) {
        if (spend(a, 40)) ab.farCoverT = now + HEALS[a.inv.slots[hs].k].time + 0.5;
        ab.farHealT = 0; ab.farHealSlot = hs;
        a.select(hs);
        continue;
      }
    }
    if (ab.farHealT >= 0) continue;
    const slot = a.bestWeaponFor(d);
    if (slot > 0 && slot !== a.inv.sel) a.select(slot);
    const cur = a.current();
    if (!cur || !has(WEAPONS, cur.k) || WEAPONS[cur.k].melee) continue;
    const w = WEAPONS[cur.k];
    const rg = weaponRange(cur.k);
    if (d > rg[2] * 1.3) continue; // out of this gun's range: closing in
    // hit chance: skill, how well the gun suits the range; easy bots miss a lot more
    let p = (0.12 + 0.35 * ab.skill) * 0.75;
    if (d < rg[0] || d > rg[2]) p *= 0.4;
    else p *= 1 - 0.5 * Math.abs(d - rg[1]) / Math.max(10, rg[2]);
    if (ab.easy) p *= 0.55;
    // the target behind a wall it just put up takes nothing
    const covered = now < t.brain.farCoverT;
    const shots = Math.max(1, Math.round(w.rate * dt * DUTY * (w.burst || 1) * (0.7 + Math.random() * 0.6)));
    const pellets = w.pellets || 1;
    let hit = false;
    for (let k = 0; k < shots && t.alive && !covered; k++) {
      if (pellets > 1) {
        let n = 0;
        for (let j = 0; j < pellets; j++) if (Math.random() < p * 0.9) n++;
        if (n) { g.send({ t: 'hit', id: a.id, tg: t.id, w: cur.k, r: cur.r | 0, d: Math.round(d * 10) / 10, n, nh: 0 }); hit = true; }
      } else if (Math.random() < p) {
        const head = Math.random() < 0.08 + 0.15 * ab.skill;
        g.send({ t: 'hit', id: a.id, tg: t.id, w: cur.k, r: cur.r | 0, d: Math.round(d * 10) / 10, n: head ? 0 : 1, nh: head ? 1 : 0 });
        hit = true;
      }
    }
    a.lastShot = now;
    // shot at: the target fights back, and may throw up a wall (cover for a second or so)
    const tb = t.brain;
    if (!tb.farTarget) tb.farTarget = a;
    if (hit) {
      tb.hurtT = now;
      if (now > tb.farCoverT + 1 && buildRule(g) !== 'off' && Math.random() < (0.3 + 0.6 * tb.persona.build * (0.5 + 0.5 * tb.skill)) * tb.buildK && spend(t, 10)) {
        tb.farCoverT = now + 0.8 + Math.random();
      }
    }
  }
}
