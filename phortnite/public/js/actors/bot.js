// AI opponents. Bots are simulated by one client (the party leader) with the exact same
// movement / weapon code as players and are networked like any other player.
//
// The brain tries to play like a person, not an aimbot:
//  - eyes: a ~115° view cone (up to ~160° only for close or fast movers), sight range by skill,
//    line of sight to the head or chest, and an awareness meter that fills faster for close,
//    central, moving, shooting or building targets before anyone counts as "spotted"
//  - ears (Game.noise): gunshots, footsteps, building, chests and explosions give a rough position
//    to look at or investigate, never an aim point; getting hit gives a rough direction
//  - memory: last known position, pre-aimed or searched, forgotten after 10-20 s
//  - hands: reaction time, an aim error that settles while tracking and jumps when the target
//    jukes, imperfect lead and drop, a human trigger rhythm, scoping in before a sniper shot
//  - personalities (casual, W-key rusher, camper, builder, loot goblin) over a skill spread
// Each bot thinks ~4 times a second (staggered); per-frame work is steering and aiming only.
import * as THREE from 'three';
import { WEAPONS, HEALS, MAP, FLAG, MAT_KEYS } from '../../shared/constants.js';
import { Combatant, forwardFromAngles } from './combatant.js';
import { RAY_STATIC, RAY_SOLID } from '../physics.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _s = new THREE.Vector3();

const TAU = Math.PI * 2;
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const rnd = (a, b) => a + Math.random() * (b - a);
// cheap bell curve (sd ~0.58, never beyond +-1.7)
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const velOf = (a) => (a.mover ? a.mover.vel : a.vel);

const FOV = 1.0;          // half-angle of the view cone (~115°)
const FOV_WIDE = 1.4;     // peripheral vision (~160°): only close or fast-moving targets
const FOV_V = 0.95;       // vertical half-angle
const LOS_CHECKS = 3;     // candidates ray-tested per think (2 rays each at most); the target is extra

// preferred engagement ranges [min, ideal, max] in m; guns not listed are derived from their stats
const RANGES = { shotgun: [0, 7, 14], smg: [0, 12, 28], pistol: [0, 15, 35], ar: [8, 40, 120], sniper: [45, 110, 400], rocket: [12, 35, 80] };
const _ranges = Object.create(null);

export function weaponRange(k) {
  let r = _ranges[k];
  if (r) return r;
  const w = has(WEAPONS, k) ? WEAPONS[k] : null;
  if (has(RANGES, k)) r = RANGES[k];
  else if (!w || w.melee) r = [0, 1.5, 2.6];
  else if ((w.pellets || 1) > 1) {
    const m = w.falloff ? Math.max(10, Math.min(20, w.falloff[1] * 0.6)) : 15;
    r = [0, m * 0.5, m];
  } else if (w.scope) r = [40, 110, 400];
  else if (w.splash) r = [Math.max(10, w.splash * 2), 35, 80];
  else if (w.falloff) r = [w.auto || w.burst ? 5 : 0, Math.min(60, (w.falloff[0] + w.falloff[1]) / 2), Math.max(30, w.falloff[1])];
  else if (w.auto || w.burst) r = [5, 35, 100];
  else r = [0, 25, 70];
  _ranges[k] = r;
  return r;
}

/** 0 close, 1 mid, 2 long, 3 explosive: a bot wants one of each before doubling up. */
function weaponClass(k) {
  const w = WEAPONS[k];
  if (w && w.splash) return 3;
  const r = weaponRange(k);
  return r[2] <= 30 ? 0 : r[1] >= 80 ? 2 : 1;
}

/** How far (m) a shot from this gun can be heard. */
export function shotNoise(k) {
  const w = has(WEAPONS, k) ? WEAPONS[k] : null;
  if (!w) return 60;
  if (w.melee) return 20;
  if (w.silenced || w.suppressed) return 35;
  if (w.scope) return 170;
  if (w.splash) return 150;
  if ((w.pellets || 1) > 1) return 90;
  if (w.auto) return w.rate > 8 ? 80 : 110;
  return 70;
}

// what a sound is worth turning around for (plus 0..1 for loudness)
const NOISE_PRI = { hit: 6, boom: 4, shot: 4, step: 3, build: 2.5, harvest: 2, chest: 1.5 };

// aggro: pushes / third-parties; build: walls, ramps, boxes; camp: holds angles; rotate: 1 = rotates
// early; loot: how far out of the way they loot; snipe: likes long range; dance: emotes after a kill;
// hot: likes busy drops
const PERSONAS = [
  { key: 'casual', w: 34, aggro: 0.5, build: 0.25, camp: 0.3, rotate: 0.5, loot: 0.6, snipe: 0.3, dance: 0.35, hot: 0.45 },
  { key: 'rusher', w: 20, aggro: 0.95, build: 0.45, camp: 0, rotate: 0.25, loot: 0.35, snipe: 0.05, dance: 0.6, hot: 0.9 },
  { key: 'camper', w: 16, aggro: 0.2, build: 0.3, camp: 0.95, rotate: 0.95, loot: 0.6, snipe: 0.5, dance: 0.15, hot: 0.1 },
  { key: 'builder', w: 12, aggro: 0.75, build: 1, camp: 0.1, rotate: 0.6, loot: 0.5, snipe: 0.3, dance: 0.5, hot: 0.6 },
  { key: 'goblin', w: 18, aggro: 0.3, build: 0.3, camp: 0.45, rotate: 0.75, loot: 1, snipe: 0.9, dance: 0.3, hot: 0.2 },
];

function pickPersona() {
  let n = Math.random() * PERSONAS.reduce((s, p) => s + p.w, 0);
  for (const p of PERSONAS) { n -= p.w; if (n <= 0) return p; }
  return PERSONAS[0];
}

function rollSkill() {
  const r = Math.random();
  if (r < 0.12) return rnd(0.78, 0.97); // a few sweats
  if (r < 0.4) return rnd(0.5, 0.75);
  return rnd(0.15, 0.5); // most lobbies are casual
}

/** Everything that follows from skill and personality. */
function traits(skill, persona) {
  return {
    skill, persona,
    sight: 55 + 55 * skill, // m in the open
    ears: 0.8 + 0.35 * skill,
    reactBase: 0.8 - 0.55 * skill, // s from spotting to the first deliberate shot
    memory: 10 + 10 * persona.camp + Math.random() * 3,
    turnSpeed: 4 + 9 * skill, // rad/s flick limit
    turnK: 6 + 10 * skill,
    trackK: 0.55 + 0.4 * skill, // how much of a moving target's motion the hand follows
    settle: 1 + 2.5 * skill, // aim error settling rate (1/s)
    scopeSettle: 0.35 + 0.7 * (1 - skill),
  };
}

// every actor in the session, rebuilt at most once per game frame (no per-bot allocations)
const _list = [];
let _listG = null, _listT = -1;
function actorList(g) {
  if (_listG !== g || _listT !== g.time) {
    _listG = g; _listT = g.time;
    _list.length = 0;
    if (g.me) _list.push(g.me);
    for (const b of g.bots.values()) _list.push(b);
    for (const r of g.remotes.values()) _list.push(r);
  }
  return _list;
}

export class Bot extends Combatant {
  constructor(game, info) {
    super(game, info.id, info.name, info.skin, true);
    this.unlimitedAmmo = true;
    const persona = pickPersona();
    let skill = rollSkill();
    if (persona.key === 'builder') skill = Math.min(0.97, skill + 0.15);
    this.brain = {
      ...traits(skill, persona),
      rotK: rnd(0.7, 1.3),
      mode: 'travel', modeT: 0,
      recs: new Map(), scanI: 0,
      target: null, trec: null,
      thinkT: Math.random() * 0.3, thinkAcc: 0, planT: 0,
      // aim
      reaction: 0, errMag: 0.05, errY: 0, errP: 0, errTY: 0, errTP: 0, errT: 0, leadK: 1, dropK: 1, headAim: false,
      prevYawD: NaN, prevPitchD: 0, latSign: 0, tgtAir: false, aimDist: 100,
      tapT: 0, burstT: 0, burstOn: false, graceT: 0, scopeT: 0, wantSlot: -1,
      // movement
      strafe: 1, strafeT: 0, crouchOn: false, crouchT: 0, jumpT: 0, avoid: 0, avoidT: 0, probeT: 0, fleeSide: 1,
      stuckT: 0, stuckN: 0, lastPos: new THREE.Vector3(), moving: false, breakT: 0, breakX: 0, breakY: 0, breakZ: 0,
      progT: 0, progD: 0, progX: 0, progZ: 0, noProg: 0, detourT: 0, detourX: 0, detourZ: 0,
      glance: 0, glanceT: 1,
      goal: null, goalT: 0, dest: new THREE.Vector3(), destKind: '', lootRef: null, lootT: 0, badLoot: new Set(),
      chestI: -1, harvest: null, treeT: 0,
      urgent: 0, safeKey: 0, safeX: 0, safeZ: 0,
      holdX: 0, holdZ: 0, holdSet: false, holdUntil: 0, campCool: 0, lookYaw: 0, lookT: 0,
      // ears / getting hurt
      noiseT: -99, noiseT0: -99, noisePri: 0, noiseKind: '', noiseSrc: 0, noiseX: 0, noiseY: 0, noiseZ: 0, noiseD: 0,
      noiseDelay: 0.3, noiseDone: true, noiseGo: false,
      hurtT: -99, wallReq: false, buildT: 0, boxStep: 0, boxN: 4, boxYaw: 0, lowPlan: '',
      killT: -99, killX: 0, killY: 0, killZ: 0, danceT: 0,
      // set by the game while in the bus
      dropAt: 0, landAt: null, skyT: -99, spread: false,
      lastHp: 100,
    };
    this.ctl = { mx: 0, my: 0, fire: false, firePressed: false, ads: false, jump: false, crouch: false, sprint: false, reload: false };
    this.aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1, tx: 0, ty: 0, tz: 0 };
  }

  static shotNoise(k) { return shotNoise(k); }

  /** Set skill (0..1) and/or personality ('casual', 'rusher', 'camper', 'builder', 'goblin'). */
  configure(skill, personaKey) {
    const b = this.brain;
    const p = PERSONAS.find((x) => x.key === personaKey) || b.persona;
    Object.assign(b, traits(skill ?? b.skill, p));
  }

  // ------------------------------------------------------------------ inventory helpers
  hasGun() { return this.gunCount() > 0; }

  gunCount() {
    let n = 0;
    for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && has(WEAPONS, s.k) && !WEAPONS[s.k].melee) n++; }
    return n;
  }

  hasClass(cls) {
    for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && has(WEAPONS, s.k) && weaponClass(s.k) === cls) return true; }
    return false;
  }

  bestWeaponFor(dist) {
    const b = this.brain;
    let best = -1, bestScore = -1e9;
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s || !has(WEAPONS, s.k) || WEAPONS[s.k].melee) continue;
      const r = weaponRange(s.k);
      let score = (s.r | 0) * 0.3;
      if (dist >= r[0] && dist <= r[2]) score += 3 - Math.abs(dist - r[1]) / Math.max(8, r[2]);
      else if (dist < r[0]) score -= 3 + (r[0] - dist) * 0.3; // never a rocket point blank
      else score -= ((dist - r[2]) / Math.max(10, r[2])) * 2;
      if (s.m <= 0) score -= 0.3 + 1.2 * b.skill; // good players swap instead of reloading
      if (i === this.inv.sel) score += 0.5; // don't flip-flop
      if (WEAPONS[s.k].scope && dist > 45) score += b.persona.snipe;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /** Switch to a slot unless that would throw away a reload that's nearly done. */
  equip(slot) {
    if (slot <= 0 || slot === this.inv.sel || this.buildMode) return;
    const cur = this.current();
    const w = cur && has(WEAPONS, cur.k) ? WEAPONS[cur.k] : null;
    if (this.reloadT >= 0 && w && this.reloadT > w.reload * 0.6) return;
    this.select(slot);
  }

  healSlot() {
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s || !has(HEALS, s.k)) continue;
      const h = HEALS[s.k];
      if ((h.hp && this.hp < h.cap - 5) || (h.sh && this.sh < h.cap - 5)) return i;
    }
    return -1;
  }

  totalMats() { return this.inv.mats.wood + this.inv.mats.stone + this.inv.mats.metal; }

  /** How much a bot wants this floor item (0 = ignore). Weapons > shields/heals > better rarity. */
  lootValue(item) {
    const k = item.k;
    if (has(WEAPONS, k)) {
      const w = WEAPONS[k];
      if (w.melee) return 0;
      const r = item.r | 0;
      let guns = 0;
      for (let i = 1; i <= 5; i++) {
        const s = this.inv.slots[i];
        if (!s || !has(WEAPONS, s.k)) continue;
        guns++;
        if (s.k === k) return r > (s.r | 0) ? 2 + r - (s.r | 0) : 0; // a rarity upgrade
      }
      if (!guns) return 12 + r;
      const missing = !this.hasClass(weaponClass(k));
      if (this.freeSlot() < 0) return missing && this.swapSlotFor(item) > 0 ? 3 + r * 0.5 : 0;
      let v = (missing ? 5 : 1.2) + r * 0.6;
      if (w.scope) v += this.brain.persona.snipe * 2 - 0.6;
      return v;
    }
    if (has(HEALS, k)) {
      if (!this.canAutoPick(item)) return 0;
      let n = 0;
      for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && has(HEALS, s.k)) n++; }
      return (HEALS[k].sh ? 4 : 3) + (n ? 0 : 2);
    }
    if (MAT_KEYS.includes(k)) return this.canAutoPick(item) && this.totalMats() < 300 ? 0.8 : 0;
    return 0; // ammo: bots never run dry
  }

  /** Full inventory: which slot to give up for this item (-1 = none). */
  swapSlotFor(item) {
    const k = item.k;
    if (!has(WEAPONS, k)) return -1;
    let worst = -1, worstV = 1e9;
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s) return -1;
      if (s.k === k) return (s.r | 0) < (item.r | 0) ? i : -1;
      let v;
      if (has(WEAPONS, s.k)) {
        // only a gun whose class we have twice is spare
        let twin = false;
        for (let j = 1; j <= 5; j++) {
          const o = this.inv.slots[j];
          if (j !== i && o && has(WEAPONS, o.k) && weaponClass(o.k) === weaponClass(s.k)) twin = true;
        }
        v = twin ? (s.r | 0) : 100;
      } else v = has(HEALS, s.k) ? 3 + (s.n | 0) * 0.5 : 0;
      if (v < worstV) { worstV = v; worst = i; }
    }
    return worstV < 50 ? worst : -1;
  }

  /** Drop the worse of two identical guns (after a rarity upgrade). */
  tidyInventory() {
    for (let i = 1; i <= 5; i++) {
      const a = this.inv.slots[i];
      if (!a || !has(WEAPONS, a.k)) continue;
      for (let j = i + 1; j <= 5; j++) {
        const c = this.inv.slots[j];
        if (!c || c.k !== a.k) continue;
        const worse = (c.r | 0) <= (a.r | 0) ? j : i;
        const it = this.inv.slots[worse];
        this.inv.slots[worse] = null;
        if (this.inv.sel === worse) this.select(worse === i ? j : i);
        this.game.send({ t: 'dropi', id: this.id, items: [{ ...it, near: true }], x: this.pos.x, y: this.pos.y, z: this.pos.z });
        this.onInventory();
        return;
      }
    }
  }

  grab(it) {
    const g = this.game;
    if (g.slotPickPending(this)) return;
    if (this.canAutoPick(it.item)) { g.botPick(this, it); return; }
    const slot = this.freeSlot() < 0 ? this.swapSlotFor(it.item) : -1;
    if (slot > 0) { this.select(slot); g.pick(this, it, true); }
  }

  // ------------------------------------------------------------------ perception
  isEnemy(a) {
    if (a === this || !a.alive || a.inBus || a.hasState === false) return false;
    const m = a.mode;
    if (m === 'bus' || m === 'dead') return false;
    const g = this.game;
    return g.phase !== 'lobby' && !g.friendly(a.id, this.id);
  }

  /** Someone's health as a player would know it: from our own hit markers, else assume healthy. */
  guessHp(a) {
    return a === this.brain.target && this.time - this.lastShot < 4 ? a.hp + a.sh : 150;
  }

  /** Still part of this session (remotes can leave mid-match)? */
  present(a) {
    const g = this.game;
    return a === g.me || g.bots.get(a.id) === a || g.remotes.get(a.id) === a;
  }

  recOf(a) {
    const recs = this.brain.recs;
    let r = recs.get(a.id);
    if (!r || r.actor !== a) {
      r = {
        actor: a, aw: 0, spotted: false, vis: false, checkT: -99, seenT: -99, spotT: -99, lostT: -99, heardT: -99, hurtT: -99,
        x: a.pos.x, y: a.pos.y, z: a.pos.z, vx: 0, vy: 0, vz: 0, hx: a.pos.x, hy: a.pos.y, hz: a.pos.z,
      };
      recs.set(a.id, r);
    }
    return r;
  }

  /** Line of sight from the eye to the head, then the chest: either is enough. */
  canSee(ex, ey, ez, a, crouch) {
    const p = a.pos;
    return this.clear(ex, ey, ez, p.x, p.y + (crouch ? 1.27 : 1.7), p.z) || this.clear(ex, ey, ez, p.x, p.y + (crouch ? 0.85 : 1.15), p.z);
  }

  clear(ox, oy, oz, tx, ty, tz) {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.3) return true;
    return !this.game.physics.raycast(ox, oy, oz, dx / len, dy / len, dz / len, len - 0.25, RAY_SOLID);
  }

  /**
   * Vision pass (think rate): view cone, sight range, a few line-of-sight rays, awareness meters.
   * dt = time since the last pass.
   */
  perceive(dt) {
    const b = this.brain, now = this.time;
    const list = actorList(this.game);
    const n = list.length;
    if (!n) return;
    const p = this.pos;
    const ex = p.x, ey = p.y + this.eyeHeight(), ez = p.z;
    let checks = LOS_CHECKS, next = b.scanI;
    for (let k = 0; k < n; k++) {
      const idx = (b.scanI + k) % n;
      const a = list[idx];
      if (!this.isEnemy(a)) continue;
      const r = this.recOf(a);
      const ap = a.pos;
      const crouch = !!a.crouching;
      const dx = ap.x - ex, dy = ap.y + (crouch ? 0.85 : 1.15) - ey, dz = ap.z - ez;
      const hd = Math.hypot(dx, dz), d = Math.hypot(hd, dy);
      const speed = a.speed || 0;
      const fl = a.flags | 0;
      const firing = (fl & FLAG.FIRING) !== 0, building = (fl & FLAG.BUILD) !== 0;
      const am = a.mode;
      const flying = am === 'skydive' || am === 'glide';
      // players on other devices far from this device's camera aren't animated, so their steps
      // never reach Game.onStep: hear them here instead
      if (!a.mover && d < 18 && speed > 1 && !flying && this.game.isFar(ap)) this.hear(ap.x, ap.y, ap.z, crouch ? 4 : speed > 7 ? 18 : 12, 'step', a.id);
      // how far away this target stands out at all
      let range = b.sight;
      if (firing) range *= 1.5;
      else if (flying) range *= 1.6;
      else if (crouch) range *= speed < 0.5 ? 0.55 : 0.7;
      else if (speed < 0.5) range *= 0.85;
      let vis = false, wide = false, ang = 0;
      if (d < range) {
        ang = Math.abs(wrap(Math.atan2(-dx, -dz) - this.yaw));
        const pa = Math.abs(Math.atan2(dy, hd) - this.pitch);
        const inCone = ang < FOV && pa < FOV_V;
        wide = !inCone && ang < FOV_WIDE && pa < FOV_V + 0.3 && (d < 15 || speed > 7.5 || flying || (firing && d < 40));
        if (inCone || wide) {
          if (a === b.target || checks > 0) {
            if (a !== b.target) { checks--; next = idx + 1; }
            vis = this.canSee(ex, ey, ez, a, crouch);
            r.checkT = now;
          } else vis = r.vis && now - r.checkT < 0.7; // not re-tested this pass: trust a fresh result
        }
      }
      const was = r.vis;
      r.vis = vis;
      if (vis) {
        // seconds it takes to notice this target from scratch (~0.3 s up close in plain view,
        // a few seconds far out at the edge of vision)
        const dn = d / range;
        let t = 0.15 + dn * 0.35 + dn * dn * 1.1;
        t *= wide ? 3 : 1 + 0.9 * (ang / FOV) * (ang / FOV);
        if (firing) t *= 0.45;
        else if (building) t *= 0.6;
        else if (speed < 0.5) t *= crouch ? 1.5 : 1.3;
        else if (crouch) t *= 1.15;
        else if (speed > 7.5) t *= 0.8;
        if (now - r.hurtT < 4) t *= 0.4; // we know roughly where the shots came from
        else if (now - r.heardT < 5) t *= 0.55;
        if (this.healT >= 0 || b.destKind === 'loot') t *= 1.3; // busy
        t *= 1.35 - 0.6 * b.skill;
        r.aw = Math.min(1.5, r.aw + dt / t);
        if (r.aw >= 1) {
          if (!r.spotted) { r.spotted = true; r.spotT = now; }
          r.seenT = now;
          r.x = ap.x; r.y = ap.y; r.z = ap.z;
          const v = velOf(a);
          r.vx = v.x; r.vy = v.y; r.vz = v.z;
          if (!was && a === b.target && now - r.lostT > 0.6) this.engage(r, true);
        }
      } else {
        if (was) r.lostT = now;
        r.aw = Math.max(0, r.aw - dt * (r.spotted ? 0.1 : 0.35));
        if (r.spotted && now - r.seenT > b.memory) r.spotted = false;
      }
    }
    b.scanI = next % n;
  }

  /** Game.noise: something audible happened at (x, y, z). */
  hear(x, y, z, radius, kind, src) {
    if (!this.alive || this.inBus) return;
    const b = this.brain;
    const dx = x - this.pos.x, dy = y - this.pos.y, dz = z - this.pos.z;
    const range = radius * b.ears;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > range * range) return;
    if (kind === 'chest' && d2 < 12) return; // that was (almost certainly) us
    const a = src ? this.game.actorById(src) : null;
    if (a && !this.isEnemy(a)) return;
    const now = this.time;
    const d = Math.sqrt(d2);
    const loud = 1 - d / range;
    const pri = (NOISE_PRI[kind] || 1) + loud;
    // you can tell roughly where a sound came from, worse when it is far or faint
    const err = d * (0.05 + 0.2 * (1 - loud)) * (1.25 - 0.5 * b.skill);
    const nx = x + gauss() * err, nz = z + gauss() * err;
    if (now - b.noiseT > 2.5 || pri >= b.noisePri) {
      const fresh = now - b.noiseT > 2.5 || b.noiseSrc !== (src || 0);
      b.noiseT = now; b.noisePri = pri; b.noiseKind = kind; b.noiseSrc = src || 0;
      b.noiseX = nx; b.noiseY = y; b.noiseZ = nz; b.noiseD = d;
      if (fresh) {
        b.noiseT0 = now;
        b.noiseDelay = rnd(0.15, 0.45) * (1.4 - 0.6 * b.skill);
        b.noiseDone = false;
        // go and check (third-party a fight), or just look and hold?
        const P = b.persona;
        const fight = kind === 'shot' || kind === 'boom';
        const healthy = this.hp + this.sh > 60;
        b.noiseGo = d < 140 && Math.random() < (fight ? P.aggro * (healthy ? 1 : 0.3) : 0.25 + 0.6 * P.aggro);
      }
    }
    if (a) {
      const r = this.recOf(a);
      r.heardT = now; r.hx = nx; r.hy = y; r.hz = nz;
      // hearing makes someone easier to pick out, but never spots them by itself
      if (r.aw < 0.6) r.aw = Math.min(0.6, r.aw + (kind === 'shot' ? 0.3 : 0.12) * loud);
    }
  }

  /** Took damage (from Game.on_dmg). The attacker's rough direction is all we learn. */
  hurtBy(a, amt) {
    const b = this.brain, now = this.time;
    b.hurtT = now;
    if (!a || a === this || !this.isEnemy(a)) return;
    const r = this.recOf(a);
    r.hurtT = now;
    const d = Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z);
    const err = 1.5 + d * 0.1 * (1.2 - 0.5 * b.skill);
    r.hx = a.pos.x + gauss() * err; r.hy = a.pos.y; r.hz = a.pos.z + gauss() * err; r.heardT = now;
    if (r.aw < 0.7) r.aw = 0.7;
    if (b.noiseKind !== 'hit' || now - b.noiseT > 1) { b.noiseT0 = now; b.noiseDelay = rnd(0.1, 0.35) * (1.4 - 0.6 * b.skill); }
    b.noiseT = now; b.noisePri = NOISE_PRI.hit + 1; b.noiseKind = 'hit'; b.noiseSrc = a.id;
    b.noiseX = r.hx; b.noiseY = r.hy; b.noiseZ = r.hz; b.noiseD = d; b.noiseDone = false;
    b.noiseGo = Math.random() < b.persona.aggro;
    // throw up a wall (or a ramp to fight for height) between us and the shooter
    if (!b.wallReq && amt > 0 && Math.random() < 0.12 + 0.75 * b.persona.build * (0.4 + 0.6 * b.skill)) b.wallReq = true;
  }

  // ------------------------------------------------------------------ decisions (think rate)
  chooseTarget() {
    const b = this.brain, now = this.time;
    let best = null, bestS = -1e9;
    for (const r of b.recs.values()) {
      const a = r.actor;
      if (!r.spotted || now - r.seenT > b.memory) continue;
      if (!this.isEnemy(a) || !this.present(a)) continue;
      const d = Math.hypot(r.x - this.pos.x, r.z - this.pos.z);
      let s = (r.vis ? 60 : 0) - d * 0.4 - (now - r.seenT) * 4;
      if (now - r.hurtT < 3) s += 35;
      if (r === b.trec) s += 20;
      if (this.guessHp(a) < 50) s += 10;
      if (s > bestS) { bestS = s; best = r; }
    }
    if (best !== b.trec) {
      b.trec = best;
      b.target = best ? best.actor : null;
      if (best && best.vis) this.engage(best, now - best.lostT < 2);
    }
  }

  /** A target (re)appears: reaction time, a fresh aim error, this engagement's lead habits. */
  engage(r, again) {
    const b = this.brain;
    b.reaction = b.reactBase * rnd(0.8, 1.25) * (again ? 0.5 : 1);
    const e0 = 0.03 + 0.06 * (1 - b.skill);
    b.errMag = again ? Math.max(b.errMag, e0 * 0.6) : e0;
    b.errT = 0;
    b.leadK = 1 - rnd(0.05, 0.6) * (1 - b.skill) + gauss() * 0.1;
    b.dropK = 1 - rnd(-0.2, 0.4) * (1 - b.skill);
    b.headAim = Math.random() < b.skill * 0.45;
    b.prevYawD = NaN;
    b.tapT = rnd(0, 0.1);
    b.scopeT = 0;
    b.graceT = 0;
    b.latSign = 0;
  }

  stormUrgency() {
    const st = this.game.storm.state;
    if (!st) return 0;
    const p = this.pos;
    if (Math.hypot(p.x - st.cx, p.z - st.cz) > st.r - 3) return 2; // in the storm already
    const over = Math.hypot(p.x - st.ncx, p.z - st.ncz) - st.nr * 0.85;
    if (over <= 0) return 0;
    const need = over / 6.5 + 4; // s of running to get in, with some slack
    if (st.shrinking) return need > st.secs * 0.7 ? 2 : 1;
    // early rotators leave as soon as the circle shows, late ones wait for the last moment
    return st.secs < need + 5 + 70 * this.brain.persona.rotate * this.brain.rotK ? 1 : 0;
  }

  decide() {
    const b = this.brain, now = this.time, P = b.persona;
    const t0 = b.target;
    if (t0 && (!t0.alive || !this.present(t0))) {
      if (!t0.alive && now - this.lastShot < 2.5) {
        // (probably) our kill: celebrate, then go through their loot
        b.killT = now; b.killX = t0.pos.x; b.killY = t0.pos.y; b.killZ = t0.pos.z;
        if (Math.random() < P.dance * 0.5) b.danceT = rnd(1.5, 3);
      }
      b.recs.delete(t0.id);
      b.target = null; b.trec = null;
    }
    this.chooseTarget();
    const urg = (b.urgent = this.stormUrgency());
    const hpNow = this.hp + this.sh;
    if (hpNow > 75) b.lowPlan = '';
    const t = b.target, r = b.trec;
    const gun = this.hasGun();
    const healS = this.healSlot();
    let mode = 'travel';
    if (b.mode === 'box' && b.boxStep < b.boxN && now - b.modeT < 3) mode = 'box';
    else if (t && (r.vis || now - r.seenT < 0.5)) {
      const d = Math.hypot(r.x - this.pos.x, r.z - this.pos.z);
      const threat = now - r.hurtT < 4;
      b.wantSlot = this.bestWeaponFor(d);
      const reach = b.wantSlot > 0 ? weaponRange(this.inv.slots[b.wantSlot].k)[2] * 1.2 : 0;
      if (hpNow < 50 && !b.lowPlan) {
        // losing a fight: box up and heal, run, or keep swinging
        const canBox = this.totalMats() >= 40 && healS > 0 && Math.random() < 0.1 + P.build * (0.4 + 0.6 * b.skill);
        b.lowPlan = canBox ? 'box' : P.aggro < 0.8 && Math.random() < 0.7 - P.aggro * 0.5 ? 'flee' : 'fight';
        if (canBox) { b.boxStep = 0; b.boxN = P.build > 0.6 ? 5 : 4; b.boxYaw = Math.atan2(-(r.x - this.pos.x), -(r.z - this.pos.z)); }
      }
      // no gun yet: swing at someone in our face, back off from someone close, else keep looting
      if (!gun) mode = d < 5 ? 'melee' : d < 25 || threat ? 'flee' : 'travel';
      else if (urg === 2 && d > 25 && !threat) mode = 'travel';
      else if (b.lowPlan === 'box' && b.boxStep < b.boxN) mode = 'box';
      else if (b.lowPlan === 'flee' && hpNow < 50 && now - b.hurtT < 6 && this.guessHp(t) > hpNow + 20) mode = 'flee';
      else if (threat || (d < reach && (P.aggro >= 0.4 || d < 35 + 60 * P.snipe))) mode = 'fight';
      else mode = P.aggro >= 0.4 ? 'fight' : 'watch'; // fight = close the distance
    } else if (t) {
      mode = urg === 2 || !gun ? 'travel' : healS > 0 && hpNow < 75 ? 'heal' : 'search';
      b.wantSlot = this.bestWeaponFor(Math.hypot(r.x - this.pos.x, r.z - this.pos.z));
    } else if (b.danceT > 0) mode = 'emote';
    else if (urg === 2) mode = 'travel';
    else if (healS > 0 && now - b.hurtT > 1.5) mode = 'heal';
    else if (gun && !b.noiseDone && now - b.noiseT < 10) mode = 'investigate';
    else if (gun && P.camp > 0.6 && !urg && now > b.campCool && (this.gunCount() >= 2 || now > 120)) mode = 'hold';
    if (mode !== b.mode) this.enterMode(mode);
    if (mode !== 'emote') b.danceT = 0;
    if (mode === 'travel' && (b.planT <= 0 || !b.destKind)) this.planTravel();
    this.tidyInventory();
  }

  enterMode(mode) {
    const b = this.brain;
    b.mode = mode;
    b.modeT = this.time;
    this.dancing = mode === 'emote';
    if (mode === 'hold') b.holdSet = false;
    if (mode === 'flee') b.fleeSide = Math.random() < 0.5 ? -1 : 1;
    if (mode === 'travel') b.planT = 0;
  }

  // ------------------------------------------------------------------ travel planning
  planTravel() {
    const b = this.brain, g = this.game, P = b.persona, now = this.time;
    b.planT = rnd(0.6, 1);
    const urg = b.urgent;
    const gun = this.hasGun();
    // loot worth the detour (more of a detour for goblins, none when the storm is on us)
    let radius = urg === 2 ? 5 : urg ? 12 : !gun ? 50 : 15 + 25 * P.loot;
    if (now - b.killT < 25) radius = Math.max(radius, Math.hypot(b.killX - this.pos.x, b.killZ - this.pos.z) + 4);
    const it = this.bestLoot(radius);
    if (it) {
      if (b.lootRef !== it) b.lootT = now;
      b.destKind = 'loot'; b.lootRef = it; b.dest.set(it.x, it.y, it.z);
      return;
    }
    b.lootRef = null;
    if (urg < 2) {
      const c = g.nearestChest(this.pos, urg ? 10 : !gun ? 40 : 10 + 25 * P.loot);
      if (c) { b.destKind = 'chest'; b.chestI = c.i; b.dest.set(c.x, c.y, c.z); return; }
    }
    // mats: builders keep a stack, everyone else a little
    if (!urg && b.harvest === null && this.totalMats() < (P.build > 0.6 ? 250 : 60) && now > b.treeT) {
      b.treeT = now + 6;
      b.harvest = g.nearestTree(this.pos, P.build > 0.6 ? 35 : 20);
    }
    if (!urg && b.harvest !== null) {
      const o = g.world.objs[b.harvest];
      if (o && o.alive && this.totalMats() < (P.build > 0.6 ? 300 : 90)) { b.destKind = 'tree'; b.dest.set(o.o.x, o.o.y, o.o.z); return; }
      b.harvest = null;
    }
    if (urg) {
      this.safeSpot();
      b.destKind = 'storm'; b.dest.set(b.safeX, 0, b.safeZ);
      return;
    }
    if (!b.goal || b.goalT <= 0 || Math.hypot(b.goal.x - this.pos.x, b.goal.z - this.pos.z) < 4) this.pickGoal();
    b.destKind = 'goal'; b.dest.copy(b.goal);
  }

  bestLoot(radius) {
    const b = this.brain;
    const r2 = radius * radius;
    let best = null, bestS = 0;
    for (const it of this.game.loot.items.values()) {
      const dx = it.x - this.pos.x, dz = it.z - this.pos.z, dy = it.y - this.pos.y;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || dy > 1.8 || dy < -1.8 || this.pendingPick.has(it.id) || b.badLoot.has(it.id)) continue;
      const v = this.lootValue(it.item);
      if (v <= 0) continue;
      const s = v / (1 + Math.sqrt(d2) / 10);
      if (s > bestS) { bestS = s; best = it; }
    }
    return best;
  }

  /** Where to stand in the next circle: edge players stop early, rushers head for the middle. */
  safeSpot() {
    const b = this.brain, st = this.game.storm.state;
    const key = st.ncx * 7 + st.ncz * 13 + st.nr;
    if (b.safeKey === key) return;
    b.safeKey = key;
    const dx = this.pos.x - st.ncx, dz = this.pos.z - st.ncz;
    const d = Math.hypot(dx, dz) || 1;
    const f = st.nr * (0.25 + 0.5 * (1 - b.persona.aggro) * Math.random());
    b.safeX = st.ncx + (dx / d) * f + (Math.random() - 0.5) * st.nr * 0.3;
    b.safeZ = st.ncz + (dz / d) * f + (Math.random() - 0.5) * st.nr * 0.3;
  }

  /** Campers find a corner (a loot spot inside a house if one is near) and hold it a while. */
  pickHold() {
    const b = this.brain, g = this.game, st = g.storm.state;
    let best = null, bestD = 70;
    for (const s of g.world.data.lootSpots) {
      if (s.ground) continue;
      if (st && Math.hypot(s.x - st.ncx, s.z - st.ncz) > st.nr * 0.85) continue;
      const d = Math.hypot(s.x - this.pos.x, s.z - this.pos.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    b.holdX = best ? best.x : this.pos.x;
    b.holdZ = best ? best.z : this.pos.z;
    b.holdSet = true;
    b.holdUntil = this.time + rnd(35, 80);
  }

  pickGoal() {
    const g = this.game, b = this.brain, P = b.persona;
    const st = g.storm.state;
    const data = g.world.data;
    if (!b.goal) b.goal = new THREE.Vector3();
    // rushers head where the people are; goblins toward unopened chests
    if (Math.random() < P.hot * 0.6 && data.pois.length) {
      const q = data.pois[(Math.random() * data.pois.length) | 0];
      if (!st || Math.hypot(q.x - st.ncx, q.z - st.ncz) < st.nr) {
        b.goal.set(q.x + (Math.random() - 0.5) * 40, 0, q.z + (Math.random() - 0.5) * 40);
        b.goalT = 30 + Math.random() * 20;
        return;
      }
    }
    if (Math.random() < P.loot * 0.5) {
      const c = g.nearestChest(this.pos, 120);
      if (c && (!st || Math.hypot(c.x - st.ncx, c.z - st.ncz) < st.nr)) { b.goal.set(c.x, 0, c.z); b.goalT = 30; return; }
    }
    for (let tries = 0; tries < 12; tries++) {
      let x, z;
      if (st) {
        const r = st.nr * Math.sqrt(Math.random()) * 0.85;
        const a = Math.random() * Math.PI * 2;
        x = st.ncx + Math.cos(a) * r;
        z = st.ncz + Math.sin(a) * r;
      } else {
        x = this.pos.x + (Math.random() - 0.5) * 120;
        z = this.pos.z + (Math.random() - 0.5) * 120;
      }
      if (data.heightAt(x, z) > 1.5 && Math.hypot(x, z) < MAP.islandRadius) {
        b.goal.set(x, 0, z);
        b.goalT = 25 + Math.random() * 20;
        return;
      }
    }
    b.goal.set(0, 0, 0);
    b.goalT = 20;
  }

  chooseLanding() {
    const g = this.game, b = this.brain, P = b.persona;
    const spots = g.world.data.lootSpots, pois = g.world.data.pois;
    const p = this.pos;
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 40 && spots.length; i++) {
      const s = spots[(Math.random() * spots.length) | 0];
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      let score = -Math.max(0, d - 110) * 0.8 - d * 0.1 + Math.random() * 30;
      // hot drops (busy towns) or quiet edges, by personality
      let town = false;
      for (const q of pois) if (Math.hypot(q.x - s.x, q.z - s.z) < 55) { town = true; break; }
      score += town ? (P.hot - 0.5) * 60 : (0.5 - P.hot) * 40;
      // don't all land on the same roof
      for (const o of g.bots.values()) {
        const l = o !== this && o.brain.landAt;
        if (l && Math.hypot(l.x - s.x, l.z - s.z) < 15) score -= 25 * (1 - P.hot);
      }
      if (score > bestS) { bestS = score; best = s; }
    }
    b.landAt = best ? new THREE.Vector3(best.x, best.y, best.z) : new THREE.Vector3(0, 0, 0);
  }

  // ------------------------------------------------------------------ per frame
  think(dt) {
    const b = this.brain;
    const ctl = this.ctl;
    ctl.mx = 0; ctl.my = 0; ctl.fire = false; ctl.firePressed = false; ctl.jump = false; ctl.sprint = false; ctl.reload = false; ctl.ads = false; ctl.crouch = false;
    if (!this.alive || this.inBus) return;
    const m = this.mode;
    if (m === 'skydive' || m === 'glide') { this.skydive(dt); return; }
    // bots dropped together (the bus's forced drop) can land on each other's capsules mid-air,
    // which turns the skydive into a free fall: deploy again if that just happened
    if ((m === 'air' || m === 'ground') && this.time - b.skyT < 4 && this.pos.y > 2
      && this.pos.y - this.game.world.data.heightAt(this.pos.x, this.pos.z) > 20) {
      this.mover.mode = 'skydive';
      this.skydive(dt);
      return;
    }

    b.thinkAcc += dt;
    b.thinkT -= dt; b.planT -= dt; b.goalT -= dt; b.buildT -= dt; b.jumpT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = rnd(0.2, 0.3);
      this.perceive(Math.min(0.5, b.thinkAcc));
      b.thinkAcc = 0;
      this.decide();
    }
    b.moving = false;
    if (b.breakT > 0 && b.mode !== 'fight' && b.mode !== 'watch' && b.mode !== 'box') this.breakThrough(dt);
    else {
      switch (b.mode) {
        case 'fight': this.fight(dt); break;
        case 'watch': this.watch(dt); break;
        case 'search': this.search(dt); break;
        case 'flee': this.flee(dt); break;
        case 'box': this.boxUp(dt); break;
        case 'heal': this.heal(dt); break;
        case 'melee': this.melee(dt); break;
        case 'emote': this.emote(dt); break;
        case 'investigate': this.investigate(dt); break;
        case 'hold': this.hold(dt); break;
        default: this.travel(dt);
      }
    }
    if (b.wallReq && b.buildT <= 0 && b.mode !== 'emote' && b.mode !== 'box') this.reactiveBuild();
    this.checkStuck(dt);
  }

  skydive(dt) {
    const b = this.brain;
    b.skyT = this.time;
    if (!b.spread) {
      // everyone leaves the bus at the same point: fan out so nobody stands on anyone
      b.spread = true;
      this.mover.teleport(this.pos.x + rnd(-5, 5), this.pos.y - rnd(0, 8), this.pos.z + rnd(-5, 5));
      this.mover.vel.y = -5;
    }
    if (!b.landAt) this.chooseLanding();
    _d.set(b.landAt.x - this.pos.x, 0, b.landAt.z - this.pos.z);
    const dist = _d.length();
    const yawT = Math.atan2(-_d.x, -_d.z);
    this.turnTo(yawT, this.mode === 'skydive' && dist > 60 ? -0.9 : -0.2, dt, 3);
    this.ctl.my = dist > 4 ? 1 : 0;
  }

  checkStuck(dt) {
    const b = this.brain;
    b.stuckT += dt;
    if (b.stuckT < 1) return;
    const moved = Math.hypot(b.lastPos.x - this.pos.x, b.lastPos.z - this.pos.z);
    if (b.moving && moved < 0.6) {
      this.ctl.jump = true;
      b.avoid = Math.random() < 0.5 ? 1 : -1;
      b.avoidT = 1.2;
      if (++b.stuckN >= 3) {
        // give up on whatever we were walking to
        b.stuckN = 0;
        if (b.lootRef) { b.badLoot.add(b.lootRef.id); if (b.badLoot.size > 24) b.badLoot.clear(); }
        b.harvest = null;
        b.destKind = '';
        b.safeKey = 0; // a different spot in the circle (maybe a different way around)
        this.pickGoal();
      }
    } else if (moved > 1.5) b.stuckN = 0;
    b.lastPos.copy(this.pos);
    b.stuckT = 0;
  }

  travel(dt) {
    const b = this.brain, g = this.game, ctl = this.ctl, now = this.time;
    const cur = this.current();
    if (cur && has(HEALS, cur.k)) { const s = this.bestWeaponFor(30); this.select(s > 0 ? s : 0); }
    const d = b.dest;
    switch (b.destKind) {
      case 'loot': {
        const it = b.lootRef;
        if (!it || g.loot.items.get(it.id) !== it || this.pendingPick.has(it.id)) { b.destKind = ''; b.planT = 0; break; }
        if (Math.hypot(it.x - this.pos.x, it.z - this.pos.z) < 1.8 && Math.abs(it.y - this.pos.y) < 2) { this.grab(it); b.planT = Math.min(b.planT, 0.3); }
        if (now - b.lootT > 12) { b.badLoot.add(it.id); b.destKind = ''; }
        break;
      }
      case 'chest':
        if (g.world.chestOpen.has(b.chestI)) { b.destKind = ''; b.planT = 0; break; }
        if (Math.hypot(d.x - this.pos.x, d.z - this.pos.z) < 2.2) g.openChest(this, b.chestI);
        break;
      case 'tree': {
        const o = b.harvest !== null ? g.world.objs[b.harvest] : null;
        if (!o || !o.alive) { b.harvest = null; b.destKind = ''; b.planT = 0; break; }
        if (Math.hypot(d.x - this.pos.x, d.z - this.pos.z) < 2.2) {
          if (this.inv.sel !== 0) this.select(0);
          this.faceToward(_v.set(o.o.x, this.pos.y + 1.2, o.o.z), dt, 8);
          ctl.fire = true;
          return;
        }
        break;
      }
      case '':
        if (!b.goal) this.pickGoal();
        d.copy(b.goal);
    }
    const hd = Math.hypot(d.x - this.pos.x, d.z - this.pos.z);
    if (hd < 0.6) { this.lookAround(this.yaw, -0.05, dt, true); return; }
    const urgent = b.urgent === 2;
    if (this.detour(d, hd, dt)) return;
    this.goTo(d.x, d.z, dt, urgent || hd > 25);
    this.lookAround(Math.atan2(-(d.x - this.pos.x), -(d.z - this.pos.z)), -0.05, dt, !urgent);
  }

  /**
   * Not getting any closer to where we're going (pacing against a house, a cliff, a fence):
   * walk around it via a point off to one side; after a few tries give up on that destination.
   * Returns true while a detour is being walked.
   */
  detour(d, hd, dt) {
    const b = this.brain;
    if (b.detourT > 0) {
      b.detourT -= dt;
      const dx = b.detourX - this.pos.x, dz = b.detourZ - this.pos.z;
      if (dx * dx + dz * dz > 1) {
        this.goTo(b.detourX, b.detourZ, dt, true);
        this.lookAround(Math.atan2(-dx, -dz), -0.05, dt, false);
        return true;
      }
      b.detourT = 0;
    }
    if ((b.progT -= dt) > 0) return false;
    b.progT = 2.5;
    const same = Math.abs(d.x - b.progX) + Math.abs(d.z - b.progZ) < 3;
    const stalled = same && hd > 4 && b.progD - hd < 1.5;
    b.progX = d.x; b.progZ = d.z; b.progD = hd;
    if (!stalled) { b.noProg = 0; return false; }
    if (++b.noProg >= 4) {
      b.noProg = 0;
      if (b.lootRef) b.badLoot.add(b.lootRef.id);
      b.harvest = null;
      b.destKind = '';
      b.safeKey = 0;
      this.pickGoal();
      return false;
    }
    const side = Math.random() < 0.5 ? -1 : 1, ux = (d.x - this.pos.x) / hd, uz = (d.z - this.pos.z) / hd;
    const off = rnd(8, 16) * b.noProg;
    b.detourX = this.pos.x - uz * side * off - ux * 3;
    b.detourZ = this.pos.z + ux * side * off - uz * 3;
    b.detourT = rnd(1.5, 3);
    return false;
  }

  /** Walk toward (x, z) whichever way we are looking. */
  goTo(x, z, dt, sprint) {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    if (dx * dx + dz * dz < 0.25) return;
    this.moveWorld(dx, dz, dt);
    this.ctl.sprint = !!sprint;
  }

  /** Move along a world direction (length = speed 0..1), probing for obstacles a few times a second. */
  moveWorld(wx, wz, dt) {
    const b = this.brain;
    const l = Math.hypot(wx, wz);
    if (l < 1e-3) return;
    const m = Math.min(1, l);
    wx /= l; wz /= l;
    if (b.avoidT > 0) {
      b.avoidT -= dt;
      const c = Math.cos(b.avoid * 0.9), s = Math.sin(b.avoid * 0.9);
      const rx = wx * c - wz * s, rz = wx * s + wz * c;
      wx = rx; wz = rz;
    } else if ((b.probeT -= dt) <= 0) {
      b.probeT = 0.15;
      const h = this.game.physics.raycast(this.pos.x, this.pos.y + 0.8, this.pos.z, wx, 0, wz, 2.2, RAY_STATIC);
      if (h && h.ny < 0.5) {
        if (h.dist < 1.6 && b.mode !== 'fight' && b.mode !== 'box' && this.breakable(h.info, b.noProg > 0 || b.urgent === 2)) {
          // a wall in the way (often our own box, or a house we can't find a way around): pickaxe through
          b.breakT = 1.8; b.breakX = h.x; b.breakY = h.y; b.breakZ = h.z;
        } else { b.avoid = Math.random() < 0.5 ? 1 : -1; b.avoidT = 0.8; }
      }
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.ctl.my = -(sy * wx + cy * wz) * m;
    this.ctl.mx = (cy * wx - sy * wz) * m;
    b.moving = true;
  }

  /** Builds can always be pickaxed out of the way; destructible scenery only when we're stuck. */
  breakable(info, stuck) {
    if (!info) return false;
    if (info.kind === 'build') return true;
    if (!stuck || info.kind !== 'obj') return false;
    const o = this.game.world.data.objects[info.id];
    return !!o && o.hp > 0 && this.game.world.isAlive(info.id);
  }

  breakThrough(dt) {
    const b = this.brain;
    b.breakT -= dt;
    if (this.inv.sel !== 0) this.select(0);
    this.faceToward(_v.set(b.breakX, b.breakY, b.breakZ), dt, 10);
    this.ctl.fire = true;
    // stop once the piece is gone
    if (this.swingT < 0 && this.cool < 0.05) {
      const dx = b.breakX - this.pos.x, dz = b.breakZ - this.pos.z, l = Math.hypot(dx, dz) || 1;
      const h = this.game.physics.raycast(this.pos.x, this.pos.y + 0.8, this.pos.z, dx / l, 0, dz / l, 2.2, RAY_STATIC);
      if (!h || !this.breakable(h.info, true)) b.breakT = 0;
    }
  }

  /**
   * Idle looking: where we're going, with the odd glance around, and turning toward noises
   * (after a short human delay) because that's where trouble comes from.
   */
  lookAround(yawT, pitchT, dt, glance) {
    const b = this.brain, now = this.time;
    // a burst of sounds counts from its first one (the reaction delay); look for a few seconds
    const since = now - b.noiseT0;
    if (since > b.noiseDelay && since < b.noiseDelay + 3 && now - b.noiseT < 2.5 && b.noisePri >= 2) {
      const dx = b.noiseX - this.pos.x, dz = b.noiseZ - this.pos.z;
      const pt = Math.max(-0.5, Math.min(0.5, Math.atan2(b.noiseY + 1.2 - this.pos.y - 1.5, Math.hypot(dx, dz))));
      return this.turnHuman(Math.atan2(-dx, -dz), pt, dt, b.turnSpeed * 0.8, b.turnK * 0.6);
    }
    if (glance) {
      // people look around every few seconds
      b.glanceT -= dt;
      if (b.glanceT <= 0) {
        if (b.glance) { b.glance = 0; b.glanceT = rnd(1.5, 4.5) * (1.4 - 0.6 * b.skill); } else { b.glance = (Math.random() < 0.5 ? -1 : 1) * rnd(0.6, 1.8); b.glanceT = rnd(0.5, 1.2); }
      }
    } else b.glance = 0;
    return this.turnHuman(yawT + b.glance, pitchT, dt, b.turnSpeed * 0.6, b.turnK * 0.4);
  }

  /** Aim at (and track) a target. Returns true when the bot believes it is on target. */
  aimAt(t, r, w, dt) {
    const b = this.brain;
    const s = this.shoulder(_s);
    // perceived position: live while in sight, the last sighting otherwise
    let px, py, pz, vx = 0, vy = 0, vz = 0;
    if (r.vis) {
      px = t.pos.x; py = t.pos.y; pz = t.pos.z;
      const v = velOf(t);
      vx = v.x; vy = v.y; vz = v.z;
    } else { px = r.x; py = r.y; pz = r.z; }
    const crouch = !!t.crouching;
    let hy = crouch ? 0.8 : 1.1;
    if (w.splash) hy = 0.25; // rockets at the feet
    else if (b.headAim && (w.pellets || 1) === 1) hy = crouch ? 1.2 : 1.6;
    let dx = px - s.x, dy = py + hy - s.y, dz = pz - s.z;
    const d = Math.hypot(dx, dy, dz);
    // lead and drop, both imperfect
    if (w.speed) {
      const tt = d / w.speed;
      dx += vx * tt * b.leadK; dz += vz * tt * b.leadK; dy += vy * tt * b.leadK * 0.3;
      if (w.grav) dy += 0.5 * 9.81 * w.grav * tt * tt * b.dropK;
    }
    const hd = Math.hypot(dx, dz);
    const yawD = Math.atan2(-dx, -dz);
    const pitchD = Math.atan2(dy, hd);
    if (r.vis) {
      // jukes: strafe flips and jumps throw the aim off
      const lat = (vx * dz - vz * dx) / Math.max(1, hd);
      const sg = lat > 2 ? 1 : lat < -2 ? -1 : 0;
      if (sg && b.latSign && sg !== b.latSign) b.errMag += 0.015 + 0.035 * (1 - b.skill);
      if (sg) b.latSign = sg;
      if (vy > 4 && !b.tgtAir) b.errMag += 0.015 + 0.02 * (1 - b.skill);
      b.tgtAir = vy > 1;
    }
    // the error settles toward a floor: hand steadiness, own movement, distance
    let floor = 0.01 + 0.04 * (1 - b.skill) + d * 0.00006;
    if (!this.mover.grounded) floor *= 2.2;
    else if (this.speed > 4) floor *= 1.4;
    if (this.ads) floor *= 0.8;
    b.errMag += (floor - b.errMag) * Math.min(1, dt * b.settle);
    b.errT -= dt;
    if (b.errT <= 0) { b.errT = rnd(0.1, 0.3); b.errTY = gauss() * b.errMag * 1.6; b.errTP = gauss() * b.errMag * 1.1; }
    b.errY += (b.errTY - b.errY) * Math.min(1, dt * 8);
    b.errP += (b.errTP - b.errP) * Math.min(1, dt * 8);
    // follow a moving target like a hand on the mouse (never perfectly)
    if (r.vis && b.prevYawD === b.prevYawD) {
      this.yaw += wrap(yawD - b.prevYawD) * b.trackK;
      this.pitch += (pitchD - b.prevPitchD) * b.trackK;
    }
    b.prevYawD = r.vis ? yawD : NaN;
    b.prevPitchD = pitchD;
    const slow = b.reaction > 0 ? 0.6 : 1;
    const left = this.turnHuman(yawD + b.errY, pitchD + b.errP, dt, b.turnSpeed * slow, b.turnK * slow);
    b.reaction -= dt;
    b.aimDist = d;
    const tol = Math.max(0.012, Math.atan2((w.pellets || 1) > 1 ? 0.9 : 0.45, d)) * (1.5 - 0.5 * b.skill);
    return left < tol;
  }

  /**
   * Pull the trigger like a person would with this gun. on = crosshair where we mean it to be;
   * can = target in sight and the reaction time is over.
   */
  trigger(cur, w, dist, on, can, dt) {
    const b = this.brain, ctl = this.ctl;
    if (this.reloadT >= 0) return;
    if (cur.m <= 0) { ctl.reload = true; return; }
    const r = weaponRange(cur.k);
    if (!can || dist > r[2] * 1.3 || (w.splash && dist < r[0] * 0.6)) { b.graceT = 0; b.burstOn = false; return; }
    const ready = on;
    if (w.scope) {
      // scope in, let the crosshair settle, one shot, then re-settle after the bolt
      if (!this.ads) { b.scopeT = 0; return; }
      b.scopeT += dt;
      if (ready && b.scopeT >= b.scopeSettle && this.cool <= dt) { ctl.firePressed = true; b.scopeT = -rnd(0.15, 0.4); }
      return;
    }
    if (w.auto) {
      // keep spraying through a brief slip off target, longer for casuals
      if (ready) b.graceT = 0.1 + 0.15 * (1 - b.skill);
      else if ((b.graceT -= dt) <= 0) return;
      if (dist > 28 && w.bloomMax) {
        // bursts at range so the bloom resets (sweats are more disciplined)
        b.burstT -= dt;
        if (b.burstT <= 0) {
          b.burstOn = !b.burstOn;
          b.burstT = b.burstOn ? rnd(2, 5 + 5 * (1 - b.skill)) / w.rate : rnd(0.18, 0.45);
        }
        ctl.fire = b.burstOn;
      } else ctl.fire = true;
      return;
    }
    // semi-auto: a press per shot, as fast as a person taps, with a beat between pump shots
    b.tapT -= dt;
    if (ready && b.tapT <= 0 && this.cool <= dt) {
      ctl.firePressed = true;
      b.tapT = 1 / (3.2 + 3 * b.skill) + rnd(0.02, 0.12 + 0.15 * (1 - b.skill));
    }
  }

  fight(dt) {
    const b = this.brain, t = b.target, r = b.trec;
    if (!t || !r) return;
    this.equip(b.wantSlot);
    const cur = this.current();
    const w = cur && has(WEAPONS, cur.k) ? WEAPONS[cur.k] : null;
    const px = r.vis ? t.pos.x : r.x, py = r.vis ? t.pos.y : r.y, pz = r.vis ? t.pos.z : r.z;
    const dist = Math.hypot(px - this.pos.x, py - this.pos.y, pz - this.pos.z);
    if (!w || w.melee) {
      this.faceToward(_v.set(px, py + 1.2, pz), dt, 6);
      return;
    }
    const on = this.aimAt(t, r, w, dt);
    this.trigger(cur, w, b.aimDist, on, r.vis && b.reaction <= 0, dt);
    this.fightMove(t, r, w, cur.k, dist, dt);
  }

  fightMove(t, r, w, k, dist, dt) {
    const b = this.brain, ctl = this.ctl, P = b.persona, now = this.time;
    const rg = weaponRange(k);
    const tx = (r.vis ? t.pos.x : r.x) - this.pos.x, tz = (r.vis ? t.pos.z : r.z) - this.pos.z;
    const hd = Math.hypot(tx, tz) || 1;
    const ux = tx / hd, uz = tz / hd;
    // push someone who's weak (our hit markers say so), reloading or healing; otherwise keep this gun's range
    const weak = this.guessHp(t) < 50 || (r.vis && ((t.flags | 0) & (FLAG.RELOAD | FLAG.HEAL)) !== 0);
    let want = rg[1];
    if (weak && P.aggro > 0.3 && b.skill > 0.3) want = Math.min(want, Math.max(rg[0], 6));
    else if (P.aggro > 0.85) want = Math.min(want, Math.max(rg[0], 8));
    let fwd = 0;
    if (dist > want + 4 + 10 * (1 - P.aggro)) fwd = 1;
    else if (dist < Math.max(rg[0], want * 0.5) - 1) fwd = -1;
    // ADAD: flip direction every fraction of a second; casuals often just stand and shoot
    b.strafeT -= dt;
    if (b.strafeT <= 0) {
      const still = Math.random() < 0.4 * (1 - b.skill);
      b.strafe = still ? 0 : b.strafe > 0 ? -1 : b.strafe < 0 ? 1 : Math.random() < 0.5 ? -1 : 1;
      b.strafeT = rnd(0.22, 0.6) + 0.7 * (1 - b.skill) * Math.random();
    }
    const scoped = !!w.scope;
    const pellets = (w.pellets || 1) > 1;
    ctl.ads = !pellets && (scoped || dist > 16 || (dist > 10 && b.skill < 0.5));
    let side = scoped && dist > 20 ? 0 : b.strafe * (ctl.ads ? 0.6 : 1);
    if (fwd > 0 && !ctl.ads) side *= 0.5;
    // crouch peeks at range for the patient ones
    if (dist > 30 && fwd <= 0 && (P.camp > 0.5 || scoped)) {
      b.crouchT -= dt;
      if (b.crouchT <= 0) { b.crouchOn = !b.crouchOn; b.crouchT = b.crouchOn ? rnd(0.8, 2) : rnd(0.5, 1.4); }
      ctl.crouch = b.crouchOn;
      if (ctl.crouch) side *= 0.3;
    }
    // hop while pushing, or to dodge when getting beamed
    if (b.jumpT <= 0 && this.mover.grounded) {
      const pushing = fwd > 0 && dist < 30;
      const beamed = now - b.hurtT < 1;
      if ((pushing && Math.random() < 0.02 + 0.05 * P.aggro) || (beamed && Math.random() < 0.06 * b.skill)) {
        ctl.jump = true;
        b.jumpT = rnd(0.9, 2.2);
      }
    }
    if (fwd || side) this.moveWorld(ux * fwd - uz * side, uz * fwd + ux * side, dt);
    ctl.sprint = fwd > 0 && dist > 20 && !ctl.ads;
    // high ground: builders ramp up toward the enemy
    const above = (r.vis ? t.pos.y : r.y) - this.pos.y;
    if (above > 3 && dist < 30 && P.build > 0.4 && b.buildT <= 0 && this.autoMat()) {
      this.placeAt('r', Math.atan2(-ux, -uz), 0);
      b.buildT = rnd(0.35, 0.7) * (1.6 - b.skill);
      this.moveWorld(ux, uz, dt);
    }
  }

  /** Spotted but not worth shooting yet (too far for a patient player): keep eyes on, stay low. */
  watch(dt) {
    const b = this.brain, t = b.target, r = b.trec;
    if (!t || !r) return;
    this.equip(b.wantSlot);
    const cur = this.current();
    const w = cur && has(WEAPONS, cur.k) ? WEAPONS[cur.k] : null;
    if (w && !w.melee) this.aimAt(t, r, w, dt);
    else this.faceToward(_v.set(r.x, r.y + 1.2, r.z), dt, 4);
    this.ctl.crouch = true;
  }

  /** Lost sight: pre-aim the last known spot, push it (aggressive) or hold it (passive), then give up. */
  search(dt) {
    const b = this.brain, t = b.target, r = b.trec, P = b.persona, now = this.time;
    if (!t || !r) return;
    this.equip(b.wantSlot);
    const cur = this.current();
    const w = cur && has(WEAPONS, cur.k) ? WEAPONS[cur.k] : null;
    // reload behind cover
    if (w && w.mag && cur.m < w.mag * 0.5) this.ctl.reload = true;
    // they were moving that way: look a little ahead of where they vanished
    const lost = Math.min(1.2, now - r.seenT);
    const ex = r.x + r.vx * lost * 0.6, ez = r.z + r.vz * lost * 0.6;
    const dx = ex - this.pos.x, dz = ez - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 4) {
      // got there and they're gone: look around a little, then move on
      this.lookAround(this.yaw, -0.05, dt, true);
      if (now - r.seenT > 4) r.spotted = false;
      return;
    }
    if (w && !w.melee) {
      const ox = r.x, oz = r.z;
      r.x = ex; r.z = ez;
      this.aimAt(t, r, w, dt);
      r.x = ox; r.z = oz;
      this.ctl.ads = d < 30 && d > 8 && (w.pellets || 1) === 1;
    } else this.faceToward(_v.set(ex, r.y + 1.2, ez), dt, 5);
    const push = P.aggro > 0.5 || this.guessHp(t) < 50;
    if (push) this.goTo(ex, ez, dt, d > 30 && !this.ctl.ads);
    else this.ctl.crouch = P.camp > 0.3;
    if (!push && now - r.seenT > b.memory * 0.6) r.spotted = false; // passive players move on sooner
  }

  flee(dt) {
    const b = this.brain, r = b.trec;
    let ax, az;
    if (r) { ax = this.pos.x - r.x; az = this.pos.z - r.z; } else { ax = this.pos.x - b.noiseX; az = this.pos.z - b.noiseZ; }
    const l = Math.hypot(ax, az) || 1;
    const c = Math.cos(b.fleeSide * 0.6), s = Math.sin(b.fleeSide * 0.6);
    let wx = (ax / l) * c - (az / l) * s, wz = (ax / l) * s + (az / l) * c;
    const st = this.game.storm.state;
    if (st && b.urgent) {
      const sx = st.ncx - this.pos.x, sz = st.ncz - this.pos.z, sl = Math.hypot(sx, sz) || 1;
      wx += (sx / sl) * 0.8; wz += (sz / sl) * 0.8;
    }
    this.moveWorld(wx, wz, dt);
    this.ctl.sprint = true;
    this.turnHuman(Math.atan2(-wx, -wz), -0.05, dt, b.turnSpeed * 0.7, b.turnK * 0.5);
    if (b.jumpT <= 0 && Math.random() < 0.02) { this.ctl.jump = true; b.jumpT = rnd(1, 2); }
    const cur = this.current();
    if (cur && has(HEALS, cur.k)) this.select(0);
  }

  heal(dt) {
    const b = this.brain;
    const s = this.healSlot();
    if (s < 0) { this.enterMode('travel'); return; }
    if (this.inv.sel !== s) this.select(s);
    this.ctl.fire = true;
    this.ctl.crouch = b.persona.camp > 0.3 || this.time - b.hurtT < 10;
    // keep an eye on where the trouble was
    const r = b.trec;
    if (r) this.turnHuman(Math.atan2(-(r.x - this.pos.x), -(r.z - this.pos.z)), -0.05, dt, b.turnSpeed * 0.5, b.turnK * 0.4);
    else this.lookAround(this.yaw, -0.05, dt, false);
  }

  /** Four walls (and a roof for builders) around us, one piece at a time. */
  boxUp() {
    const b = this.brain;
    if (b.buildT > 0) return;
    if (b.boxStep >= b.boxN || !this.autoMat()) { b.boxStep = b.boxN; return; }
    const i = b.boxStep++;
    if (i < 4) this.placeAt('w', b.boxYaw + i * Math.PI / 2, 0);
    else this.placeAt('f', this.yaw, 0.7);
    b.buildT = rnd(0.08, 0.2) * (1.6 - b.skill);
  }

  /** Build without moving the view (the camera angles pick the grid slot). */
  placeAt(type, yaw, pitch) {
    const y0 = this.yaw, p0 = this.pitch, t0 = this.buildType;
    this.yaw = yaw; this.pitch = pitch; this.buildType = type;
    const ok = this.game.tryPlaceBuild(this);
    this.yaw = y0; this.pitch = p0; this.buildType = t0;
    return ok;
  }

  reactiveBuild() {
    const b = this.brain, P = b.persona;
    b.wallReq = false;
    if (this.buildMode || this.healT >= 0 || !this.autoMat()) return;
    const r = b.trec && this.time - b.trec.hurtT < 2 ? b.trec : null;
    const hx = r ? (r.vis ? r.x : r.hx) : b.noiseX, hz = r ? (r.vis ? r.z : r.hz) : b.noiseZ, hy = r ? r.y : b.noiseY;
    const dx = hx - this.pos.x, dz = hz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.5 || d > 160) return;
    const ramp = hy - this.pos.y > 3 && d < 30 && P.build > 0.5;
    this.placeAt(ramp ? 'r' : 'w', Math.atan2(-dx, -dz), 0);
    b.buildT = rnd(1, 2.5) * (1.5 - b.skill);
  }

  melee(dt) {
    const t = this.brain.target;
    if (!t) return;
    if (this.inv.sel !== 0) this.select(0);
    this.faceToward(_v.set(t.pos.x, t.pos.y + 1.2, t.pos.z), dt, 10);
    this.ctl.fire = true;
    this.goTo(t.pos.x, t.pos.z, dt, false);
  }

  emote(dt) {
    const b = this.brain;
    b.danceT -= dt;
    this.dancing = b.danceT > 0;
    if (!this.dancing) this.enterMode('travel');
  }

  /** Heard something: look that way; the bold go and see (third-partying a fight). */
  investigate(dt) {
    const b = this.brain, now = this.time, P = b.persona;
    const dx = b.noiseX - this.pos.x, dz = b.noiseZ - this.pos.z;
    const d = Math.hypot(dx, dz);
    // done when it goes quiet, when we get there, or when we've spent long enough on it
    if (now - b.noiseT > (b.noiseGo ? 14 : 5) || now - b.noiseT0 > (b.noiseGo ? 25 : 8) || (b.noiseGo && d < 6)) {
      b.noiseDone = true;
      this.enterMode('travel');
      return;
    }
    this.equip(this.bestWeaponFor(Math.max(8, d)));
    if (now - b.noiseT0 > b.noiseDelay) {
      const pt = Math.max(-0.4, Math.min(0.4, Math.atan2(b.noiseY + 1.2 - this.pos.y - 1.5, d)));
      this.turnHuman(Math.atan2(-dx, -dz), pt, dt, b.turnSpeed * 0.8, b.turnK * 0.6);
    }
    if (b.noiseGo) {
      // approach carefully: no sprinting into a fight, crouch near it if patient
      this.goTo(b.noiseX, b.noiseZ, dt, d > 60);
      this.ctl.ads = d < 35 && d > 10;
      this.ctl.crouch = d < 20 && P.camp > 0.4;
    } else this.ctl.crouch = P.camp > 0.4;
  }

  /** Campers: get to the spot, crouch, and hold angles. */
  hold(dt) {
    const b = this.brain, now = this.time;
    if (!b.holdSet) this.pickHold();
    const dx = b.holdX - this.pos.x, dz = b.holdZ - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (now > b.holdUntil || b.urgent) { b.holdSet = false; b.campCool = now + rnd(20, 40); this.enterMode('travel'); return; }
    if (d > 1.5) {
      this.goTo(b.holdX, b.holdZ, dt, d > 30);
      this.lookAround(Math.atan2(-dx, -dz), -0.05, dt, true);
      return;
    }
    this.ctl.crouch = true;
    b.lookT -= dt;
    if (b.lookT <= 0) { b.lookT = rnd(1.5, 4); b.lookYaw = this.yaw + rnd(-2.2, 2.2); }
    this.lookAround(b.lookYaw, -0.05, dt, false);
  }

  /** Rotate toward a world point. Returns remaining angular error (radians). */
  faceToward(p, dt, rate) {
    const sx = this.shoulder(_e);
    const dx = p.x - sx.x, dy = p.y - sx.y, dz = p.z - sx.z;
    const yawT = Math.atan2(-dx, -dz);
    const pitchT = Math.atan2(dy, Math.hypot(dx, dz));
    return this.turnTo(yawT, pitchT, dt, rate);
  }

  turnTo(yawT, pitchT, dt, rate) {
    let dy = yawT - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const k = Math.min(1, dt * rate);
    this.yaw += dy * k;
    this.pitch += (pitchT - this.pitch) * k;
    return Math.abs(dy) + Math.abs(pitchT - this.pitch);
  }

  /** Human-ish turning: eases in, but never faster than a wrist can flick. Returns what's left. */
  turnHuman(yawT, pitchT, dt, speed, k) {
    const dy = wrap(yawT - this.yaw);
    const dp = pitchT - this.pitch;
    const f = Math.min(1, dt * k), max = speed * dt;
    let sy = dy * f, sp = dp * f;
    if (sy > max) sy = max; else if (sy < -max) sy = -max;
    if (sp > max) sp = max; else if (sp < -max) sp = -max;
    this.yaw = wrap(this.yaw + sy);
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + sp));
    return Math.abs(dy - sy) + Math.abs(dp - sp);
  }

  update(dt) {
    this.think(dt);
    this.move(dt, this.ctl);
    // bullets go where the bot is actually looking (its aim error and lag are real)
    const a = this.aim;
    const s = this.shoulder(_v);
    forwardFromAngles(this.yaw, this.pitch, _d);
    const r = this.brain.mode === 'fight' ? Math.max(2, this.brain.aimDist) : 100;
    a.ox = s.x; a.oy = s.y; a.oz = s.z; a.dx = _d.x; a.dy = _d.y; a.dz = _d.z;
    a.tx = s.x + _d.x * r; a.ty = s.y + _d.y * r; a.tz = s.z + _d.z * r;
    this.act(dt, this.ctl, a);
    this.animate(dt);
  }
}
