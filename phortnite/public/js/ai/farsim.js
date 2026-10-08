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
import { WEAPONS, HEALS, ANIM, PLAYER, ENV } from '../../shared/constants.js';
import { passive, buildRule, isHunter, modeKey } from './goals.js';
import { hasCone } from './buildfight.js';

export const FAR_OUT = 180, FAR_IN = 160;
const CHECK_S = 0.5;          // how often a bot asks whether it is far
const THINK_S = 1;            // far brains think once a second
const FIGHT_S = 0.5;          // far fights are rolled twice a second
const FIGHT_R = 70;           // m: far bots notice and fight each other within this (snipers further)
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// ------------------------------------------------------------------ who could see a bot
const _hum = { g: null, t: -1, n: 0, xs: new Float32Array(64), zs: new Float32Array(64) };
function addHuman(x, z) {
  if (_hum.n < 64) { _hum.xs[_hum.n] = x; _hum.zs[_hum.n] = z; _hum.n++; }
}
/** Positions of every human in the session plus the camera (rebuilt once per game frame). */
function humans(g) {
  if (_hum.g === g && _hum.t === g.time) return _hum;
  _hum.g = g; _hum.t = g.time; _hum.n = 0;
  if (g.me && g.me.alive && !g.me.inBus) addHuman(g.me.pos.x, g.me.pos.z);
  for (const r of g.remotes.values()) if (!r.isBot && r.alive !== false && r.hasState !== false) addHuman(r.pos.x, r.pos.z);
  if (g.camera) addHuman(g.camera.position.x, g.camera.position.z);
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
  // (floor is lava: standing on what you build is the game, so always the real thing)
  if (g.phase === 'match' && bot.alive && !bot.inBus && g.spectateId !== bot.id && bot.nav && bot.nav.ready
    && bot.time - b.hurtNearT > 4 && !bot.build.busy && modeKey(g) !== 'lava') {
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
  b.farHarv = -1;
  b.farTarget = null;
  b.wallReq = false;
  bot.build.clear();
  bot.mover.vel.set(0, 0, 0);
  bot.mover.groundInfo = null;
}

/** Back to the full simulation: the capsule on open ground under us. */
export function exitFar(bot) {
  const b = bot.brain, nav = bot.nav, p = bot.pos;
  bot.far = false;
  b.farTarget = null;
  b.farHealT = -1;
  b.farHarv = -1;
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
  // harvesting the tree (or rock) we stopped at: real swings ('od', like the pickaxe sends), the
  // same yield per swing as a player gets
  if (b.farHarv >= 0) {
    const id = b.farHarv;
    if (b.farTarget || b.farHealT >= 0 || b.urgent || b.farHarvN >= 8 || !g.world.isAlive(id) || bot.totalMats() >= bot.brain.matsWant) b.farHarv = -1;
    else if ((b.farHarvT -= dt) <= 0) {
      const w = WEAPONS.pickaxe, o = g.world.data.objects[id];
      b.farHarvT = 1 / w.rate;
      b.farHarvN++;
      g.send({ t: 'od', id: bot.id, o: id, d: w.dmg[0] * w.struct });
      const rock = o && (o.kind === 'rock' || o.mat === 'stone');
      if (!bot.infinite) bot.addMats(rock ? 'stone' : 'wood', rock ? ENV.harvest.stone : ENV.harvest.wood);
    }
  }
  // standing still while fighting, healing or harvesting, otherwise along the route
  let moving = false;
  // closing in on someone out of our gun's range (straight at them: it's a short way)
  const ft = b.farTarget;
  if (ft && b.farChase && b.farHealT < 0) {
    const dx = ft.pos.x - bot.pos.x, dz = ft.pos.z - bot.pos.z, l = Math.hypot(dx, dz);
    if (l > 1) {
      const sp = PLAYER.run * (bot.mover.mods ? bot.mover.mods.speed : 1);
      const nx = bot.pos.x + (dx / l) * sp * dt, nz = bot.pos.z + (dz / l) * sp * dt;
      if (bot.nav.walkable(nx, nz)) {
        const ny = bot.nav.groundY(nx, nz);
        bot.mover.vel.set((nx - bot.pos.x) / dt, (ny - bot.pos.y) / dt, (nz - bot.pos.z) / dt);
        bot.mover.pos.set(nx, ny, nz);
        bot.speed = sp; bot.anim = ANIM.RUN;
        moving = true;
      }
    }
  }
  // an item we can't get (no room for it, gone, somewhere we can't reach): forget it
  if (b.destKind === 'loot' && b.lootRef && bot.time - b.lootT > 10) {
    b.badLoot.add(b.lootRef.id); if (b.badLoot.size > 24) b.badLoot.clear();
    b.destKind = ''; b.lootRef = null; b.planT = 0;
  }
  if ((!b.farTarget || isHunter(bot)) && b.farHealT < 0 && b.farHarv < 0 && b.destKind) {
    bot.navGoal(b.dest);
    // (sliding along the ground, a spot upstairs counts as reached when we're under it)
    const under = Math.hypot(b.dest.x - bot.pos.x, b.dest.z - bot.pos.z) < 2;
    const r = under ? 0 : bot.follow.step(bot.pos.x, bot.pos.y, bot.pos.z, bot.time, dt);
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
      if (r === -1 && b.destKind === 'chest') b.badChest.add(b.chestI);
      b.destKind = ''; b.planT = 0;
      if (r === -1) b.goalT = 0;
    }
  }
  b.moving = moving;
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

/** Low on materials and in a game where they matter? */
function wantsMats(bot) {
  const g = bot.game;
  return buildRule(g) === 'on' && !bot.infMats && !bot.infinite && !passive(g) && bot.hasGun() && bot.totalMats() < bot.brain.matsWant * 0.6;
}

function farThink(bot) {
  const b = bot.brain, g = bot.game;
  b.urgent = bot.stormUrgency();
  // pick things up we're standing next to, open chests we're passing
  if (b.farHealT < 0) {
    for (const it of g.loot.items.values()) {
      const dx = it.x - bot.pos.x, dz = it.z - bot.pos.z;
      if (dx * dx + dz * dz > 9 || Math.abs(it.y - bot.pos.y) > 6 || bot.pendingPick.has(it.id)) continue;
      if (bot.lootValue(it.item) > 0) bot.grab(it);
    }
    const c = g.nearestChest(bot.pos, 6);
    if (c && Math.hypot(c.x - bot.pos.x, c.z - bot.pos.z) < 4.5) g.openChest(bot, c.i);
  }
  // heal up when nothing is going on
  if (b.farHealT < 0 && !b.farTarget && bot.time - b.hurtT > 4) {
    const s = bot.healSlot();
    if (s > 0 && (bot.hp < 75 || bot.sh < 50 || (bot.sh < 100 && has(HEALS, bot.inv.slots[s].k) && HEALS[bot.inv.slots[s].k].sh))) {
      b.farHealT = 0; b.farHealSlot = s;
      bot.select(s);
    }
  }
  // materials: players harvest on the way, so a far bot low on them stops at a tree or rock it
  // passes (a few swings, real damage to it)
  if (b.farHarv < 0 && b.farHealT < 0 && !b.farTarget && !b.urgent && wantsMats(bot)) {
    const id = bot.nearestTree(5);
    if (id !== null && id !== undefined) { b.farHarv = id; b.farHarvT = 0.3; b.farHarvN = 0; }
  }
  if (b.farHealT < 0 && b.farHarv < 0 && (!b.destKind || b.planT <= 0)) bot.planTravel(true);
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
const DUTY = 0.3;            // share of a fight spent actually shooting
const SIGHT = 0.4;            // chance a sight line is open (no house, tree or hill in the way)

function noticeRange(b) { return 55 + 55 * b.skill; }

/**
 * A real build piece from a far bot (networked and paid for like any other: someone walking by
 * later finds the fight's walls). The rules decide whether bots build at all.
 */
function farPiece(a, type, yaw, pitch) {
  if (buildRule(a.game) === 'off' || !a.autoMat()) return false;
  return a.placeAt(type, yaw, pitch);
}

/** Box up: four walls and a roof (a cone when the game has it). True if it went up. */
function farBox(a) {
  if (buildRule(a.game) === 'off' || a.totalMats() < 50) return false;
  let n = 0;
  for (let i = 0; i < 4; i++) if (farPiece(a, 'w', a.yaw + i * Math.PI / 2, 0)) n++;
  if (!(hasCone() && farPiece(a, 'c', a.yaw, 0.7))) farPiece(a, 'f', a.yaw, 0.7);
  return n >= 3;
}

/** Would this far bot take a fight with o at distance d (the brain's decide(), roughly)? */
function wantsFight(a, o, d, now) {
  const b = a.brain, P = b.persona;
  if (isHunter(a)) return d < 30; // the infected run them down (their goal is the nearest survivor)
  if (!a.hasGun()) return false;
  const threat = now - b.hurtT < 4;
  if (b.urgent === 2 && d > 25 && !threat) return false;
  if (a.itemCount() < 2 && !threat && d > 15) return false;
  if (a.calm(d, threat)) return false;
  const s = a.bestWeaponFor(d);
  if (s < 0) return false;
  const rg = a.rangeOf(a.inv.slots[s].k);
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
        const pNotice = (0.15 + 0.6 * (1 - d / (R * 1.5))) * (best.time - best.lastShot < 1 ? 1.6 : 1) * SIGHT * dt;
        if (Math.random() < pNotice && wantsFight(a, best, d, now)) t = best;
      }
    }
    ab.farTarget = t;
    if (!t) { ab.farChase = false; continue; }
    const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    a.yaw = Math.atan2(-dx, -dz);
    // hurt: box up and heal (the box is cover while it lasts)
    if (a.hp + a.sh < 70 && ab.farHealT < 0 && now > ab.farCoverT) {
      const hs = a.healSlot();
      if (hs > 0 && Math.random() < 0.5 + 0.4 * ab.persona.build) {
        if (farBox(a)) ab.farCoverT = now + HEALS[a.inv.slots[hs].k].time + 0.5;
        ab.farHealT = 0; ab.farHealSlot = hs;
        a.select(hs);
        continue;
      }
    }
    if (ab.farHealT >= 0) continue;
    if (isHunter(a)) {
      // claws: a swing now and then once they've caught up
      if (d < 3.5 && Math.random() < WEAPONS.pickaxe.rate * dt * (0.4 + 0.3 * ab.skill)) {
        if (a.inv.sel !== 0) a.select(0);
        g.send({ t: 'hit', id: a.id, tg: t.id, w: 'pickaxe', r: 0, d: 1, n: 1, nh: 0 });
      }
      continue;
    }
    // a gunfight is a build fight too: now and then a wall in front (cover for a moment), and the
    // builders a ramp behind it for the height
    if (d < 70 && !(now < ab.farBuildT) && Math.random() < (0.12 + 0.45 * ab.persona.build) * ab.buildK * dt) {
      ab.farBuildT = now + 2 + Math.random() * 3;
      if (farPiece(a, 'w', a.yaw, 0)) {
        ab.farCoverT = Math.max(ab.farCoverT, now + 0.6 + Math.random() * 0.6);
        if (Math.random() < ab.persona.build && farPiece(a, 'r', a.yaw, 0)) ab.farCoverT += 0.4;
      }
    }
    const slot = a.bestWeaponFor(d);
    if (slot > 0 && slot !== a.inv.sel) a.select(slot);
    const cur = a.current();
    if (!cur || !has(WEAPONS, cur.k) || WEAPONS[cur.k].melee) continue;
    const w = WEAPONS[cur.k];
    const rg = a.rangeOf(cur.k);
    ab.farChase = d > rg[2] * 1.1;
    if (d > rg[2] * 1.3) continue; // out of this gun's range: closing in
    // hit chance: skill, how well the gun suits the range; easy bots miss a lot more
    let p = (0.12 + 0.35 * ab.skill) * 0.75;
    if (d < rg[0] || d > rg[2]) p *= 0.4;
    else p *= 1 - 0.5 * Math.abs(d - rg[1]) / Math.max(10, rg[2]);
    if (ab.easy) p *= 0.55;
    // the target behind a wall it just put up takes nothing
    const covered = now < t.brain.farCoverT;
    // shots this tick: the gun's rate over the time spent shooting (a bolt-action sniper gets one
    // now and then, an SMG a handful)
    const shots = Math.floor(w.rate * dt * DUTY * (w.burst || 1) * (0.7 + Math.random() * 0.6) + Math.random());
    if (!shots) continue;
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
      if (now > tb.farCoverT + 1 && Math.random() < (0.3 + 0.6 * tb.persona.build * (0.5 + 0.5 * tb.skill)) * tb.buildK
        && farPiece(t, 'w', Math.atan2(t.pos.x - a.pos.x, t.pos.z - a.pos.z), 0)) {
        tb.farCoverT = now + 0.8 + Math.random();
        // builders take the height too: a ramp behind the wall
        if (Math.random() < 0.6 * tb.persona.build * tb.buildK && farPiece(t, 'r', Math.atan2(t.pos.x - a.pos.x, t.pos.z - a.pos.z), 0)) tb.farCoverT += 0.6;
      }
    }
  }
}
