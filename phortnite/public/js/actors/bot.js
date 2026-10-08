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
//  - personalities (casual, W-key rusher, camper, builder, loot goblin) over a skill spread;
//    difficulty from the room (roster skill, rules.botSkill: easy bots react later, miss more and
//    rarely build)
//  - legs: routes over the whole island (js/ai/nav.js: around lakes and cliffs, over bridges,
//    in through doors and up stairs), landings spread over the places (hot drops and quiet edges)
//  - fights like a Fortnite player (js/ai/buildfight.js): a wall when shot, ramp pushes, 90s,
//    boxing up with a roof to heal, a shotgun up close, healing up after a fight
//  - plays the mode (js/ai/goals.js): holds the hill, hunts the Juggernaut, zombies chase, climbs
//    away from the lava, stays passive in Playground, tags along with a human teammate
//  - far from every human it is simulated cheaply (js/ai/farsim.js)
// Each bot thinks ~4 times a second (staggered); per-frame work is steering and aiming only.
import * as THREE from 'three';
import { WEAPONS, HEALS, FLAG, MAT_KEYS, PLAYER, BUS, DROP } from '../../shared/constants.js';
import { Combatant, forwardFromAngles } from './combatant.js';
import { RAY_STATIC, RAY_SOLID } from '../physics.js';
import { navFor, PathFollower } from '../ai/nav.js';
import { BuildFight } from '../ai/buildfight.js';
import {
  modeKey, passive, buildRule, wantsLoot, isHunter, modeGoal, targetBonus, roamPoint, lavaClose, hillOf, inArea,
} from '../ai/goals.js';
import { wantFar, enterFar, exitFar, farUpdate } from '../ai/farsim.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _s = new THREE.Vector3();
const _g = { x: 0, y: 0, z: 0 };

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
// health + shield: what everyone spawns with (all a player can assume about a stranger), and the most
const HS_START = PLAYER.maxHp + PLAYER.startShield, HS_MAX = PLAYER.maxHp + PLAYER.maxShield;
const SHOTGUN_NEAR = 10;  // m: inside this a shotgun is the gun
const CALM_S = 60;        // s after landing spent looting rather than starting fights (rushers: RUSH_CALM_S)
const RUSH_CALM_S = 15;

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

const isShotgun = (k) => has(WEAPONS, k) && (WEAPONS[k].pellets || 1) > 1;

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
  { key: 'casual', w: 34, aggro: 0.5, build: 0.45, camp: 0.3, rotate: 0.5, loot: 0.6, snipe: 0.3, dance: 0.35, hot: 0.35 },
  { key: 'rusher', w: 20, aggro: 0.95, build: 0.55, camp: 0, rotate: 0.25, loot: 0.35, snipe: 0.05, dance: 0.6, hot: 0.9 },
  { key: 'camper', w: 16, aggro: 0.2, build: 0.45, camp: 0.95, rotate: 0.95, loot: 0.6, snipe: 0.5, dance: 0.15, hot: 0.1 },
  { key: 'builder', w: 12, aggro: 0.75, build: 1, camp: 0.1, rotate: 0.6, loot: 0.5, snipe: 0.3, dance: 0.5, hot: 0.6 },
  { key: 'goblin', w: 18, aggro: 0.3, build: 0.4, camp: 0.45, rotate: 0.75, loot: 1, snipe: 0.9, dance: 0.3, hot: 0.2 },
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

/** Easy bots (rules.botSkill 'easy', or the easy third of 'mixed'): gentle for young kids. */
function easyFor(game, skill) {
  const lvl = game && game.rules && game.rules.botSkill;
  return lvl === 'easy' || (lvl === 'mixed' && skill <= 0.45);
}

/** Everything that follows from skill and personality (and an easy difficulty). */
function traits(skill, persona, easy) {
  return {
    skill, persona, easy,
    sight: (55 + 55 * skill) * (easy ? 0.8 : 1), // m in the open
    ears: 0.8 + 0.35 * skill,
    reactBase: 0.8 - 0.55 * skill + (easy ? 0.15 : 0), // s from spotting to the first deliberate shot
    aimK: easy ? 2.4 : 1, // aim error multiplier (easy bots: a shaky hand, for young kids)
    buildK: easy ? 0.25 : 1, // how often building is the answer
    memory: 10 + 10 * persona.camp + Math.random() * 3,
    turnSpeed: (4 + 9 * skill) * (easy ? 0.8 : 1), // rad/s flick limit
    turnK: 6 + 10 * skill,
    trackK: (0.55 + 0.4 * skill) * (easy ? 0.7 : 1), // how much of a moving target's motion the hand follows
    settle: 1 + 2.5 * skill, // aim error settling rate (1/s)
    scopeSettle: 0.35 + 0.7 * (1 - skill),
    matsWant: Math.round((persona.build > 0.6 ? 300 : 150) * (easy ? 0.5 : 1)), // keep about this many
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

/** Build the world's navigation a few ms per game frame until it is ready (shared by all bots). */
let _navFrame = -1, _navGame = null;
function stepNav(bot) {
  const nav = bot.nav;
  if (nav.ready) return nav;
  const g = bot.game;
  if (_navGame !== g || _navFrame !== g.time) { _navGame = g; _navFrame = g.time; nav.build(4); }
  return nav;
}

/** How far (m, sideways) a bot can get from the bus: skydive (no diving) then glide, with slack. */
function dropReach() {
  const sky = Math.max(0, BUS.height - 4 - DROP.glideHeight) / DROP.skydiveFall * DROP.skydiveSpeed;
  const glide = DROP.glideHeight / DROP.glideFall * DROP.glideSpeed;
  return (sky + glide) * 0.95;
}

/** Which region (place) a spot belongs to: regionAt when the world has it, else the nearest in range. */
const _spotRegion = new WeakMap();
function regionOfSpot(data, s) {
  let m = _spotRegion.get(data);
  if (!m) { m = new Map(); _spotRegion.set(data, m); }
  let r = m.get(s);
  if (r !== undefined) return r;
  r = -1;
  if (typeof data.regionAt === 'function') { const reg = data.regionAt(s.x, s.z); r = reg ? reg.id : -1; } else {
    let bd = Infinity;
    for (const g of data.regions || []) {
      const d = Math.hypot(g.x - s.x, g.z - s.z);
      if (d < (g.r || 55) * 1.2 && d < bd) { bd = d; r = g.id; }
    }
  }
  m.set(s, r);
  return r;
}

export class Bot extends Combatant {
  constructor(game, info) {
    super(game, info.id, info.name, info.skin, true);
    this.unlimitedAmmo = true;
    const persona = pickPersona();
    // the room's roll for this match's difficulty (roster skill), else our own
    let skill = typeof info.skill === 'number' && info.skill >= 0 && info.skill <= 1 ? info.skill : rollSkill();
    if (persona.key === 'builder' && typeof info.skill !== 'number') skill = Math.min(0.97, skill + 0.15);
    this.brain = {
      ...traits(skill, persona, easyFor(game, skill)),
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
      peekT: 0, peekS: 0, peekK: 0, peekUp: false,
      stuckT: 0, stuckN: 0, lastPos: new THREE.Vector3(), moving: false, breakT: 0, breakX: 0, breakY: 0, breakZ: 0,
      progT: 0, progD: 0, progX: 0, progZ: 0, noProg: 0, detourT: 0, detourX: 0, detourZ: 0,
      glance: 0, glanceT: 1,
      goal: null, goalT: 0, goalKind: '', dest: new THREE.Vector3(), destKind: '', lootRef: null, lootT: 0, badLoot: new Set(), badChest: new Set(),
      badTree: new Set(), harvestT: -1, harvestM: 0, wdT: 0, wdX: 0, wdZ: 0, wdMove: 0,
      chestI: -1, harvest: null, treeT: 0,
      urgent: 0, safeKey: 0, safeX: 0, safeZ: 0,
      holdX: 0, holdZ: 0, holdSet: false, holdUntil: 0, campCool: 0, lookYaw: 0, lookT: 0,
      holdSpot: null, holdChkT: 0, holdD: 0, holdStall: 0, badHold: new Set(),
      // ears / getting hurt (noiseTX/TZ: where the sound being followed really came from, to tell
      // more of the same fight from something new)
      noiseT: -99, noiseT0: -99, noisePri: 0, noiseKind: '', noiseSrc: 0, noiseX: 0, noiseY: 0, noiseZ: 0, noiseD: 0,
      noiseTX: 0, noiseTZ: 0, noiseDelay: 0.3, noiseDone: true, noiseGo: false,
      hurtT: -99, hurtNearT: -99, wallReq: false, relCov: false, buildT: 0, rampT: 0, ninetyT: 0, funT: rnd(10, 30), lowPlan: '', boxT: -99,
      killT: -99, killX: 0, killY: 0, killZ: 0, danceT: 0,
      // set by the game while in the bus (dropAt: see below), the landing we picked
      landAt: null, landRegion: -1, dropPlan: null, skyT: -99, spread: false,
      lastHp: 100,
      // far simulation (js/ai/farsim.js)
      farChkT: Math.random() * 0.5, farWant: false, farThinkT: 0, farHealT: -1, farHealSlot: -1, farTarget: null, farChase: false, farCoverT: -99, farBuildT: 0, farHarv: -1, farHarvT: 0, farHarvN: 0, wakeT: -99,
    };
    // Game sets brain.dropAt (seconds into the bus ride) to a random moment when the bus leaves;
    // we read back our own: the moment the bus passes the place we want to land.
    let dropDef = 0;
    Object.defineProperty(this.brain, 'dropAt', {
      enumerable: true,
      get: () => this.dropTime(dropDef),
      set: (v) => { dropDef = v; this.brain.dropPlan = null; this.brain.landAt = null; this.brain.landRegion = -1; },
    });
    this.ctl = { mx: 0, my: 0, fire: false, firePressed: false, ads: false, jump: false, crouch: false, sprint: false, reload: false };
    this.aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1, tx: 0, ty: 0, tz: 0 };
    this.nav = navFor(game.world.data);
    this.follow = new PathFollower(this.nav);
    this.build = new BuildFight(this);
    this.far = false;
  }

  static shotNoise(k) { return shotNoise(k); }

  /** Preferred engagement range [min, ideal, max] (m) of a gun (weaponRange). */
  rangeOf(k) { return weaponRange(k); }

  /** Set skill (0..1) and/or personality ('casual', 'rusher', 'camper', 'builder', 'goblin'). */
  configure(skill, personaKey) {
    const b = this.brain;
    const p = PERSONAS.find((x) => x.key === personaKey) || b.persona;
    const s = skill ?? b.skill;
    Object.assign(b, traits(s, p, easyFor(this.game, s)));
  }

  // ------------------------------------------------------------------ inventory helpers
  hasGun() { return this.gunCount() > 0; }

  gunCount() {
    let n = 0;
    for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && has(WEAPONS, s.k) && !WEAPONS[s.k].melee) n++; }
    return n;
  }

  /** Slots filled (guns and heals). */
  itemCount() {
    let n = 0;
    for (let i = 1; i <= 5; i++) if (this.inv.slots[i]) n++;
    return n;
  }

  hasClass(cls) {
    for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && has(WEAPONS, s.k) && weaponClass(s.k) === cls) return true; }
    return false;
  }

  hasShotgun() {
    for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && isShotgun(s.k)) return true; }
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
      // up close it's a shotgun fight (unless it's empty and a good player has something else)
      if (dist < SHOTGUN_NEAR && isShotgun(s.k)) score += 4;
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

  /** A heal that does something now: shields first when they're low, else whatever helps. */
  healSlot() {
    let best = -1, bestV = 0;
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s || !has(HEALS, s.k)) continue;
      const h = HEALS[s.k];
      let v = 0;
      if (h.hp && this.hp < h.cap - 5) v = Math.min(h.hp, h.cap - this.hp) + (this.hp < 50 ? 30 : 0);
      if (h.sh && this.sh < h.cap - 5) v = Math.max(v, Math.min(h.sh, h.cap - this.sh) + (this.sh < 50 ? 20 : 0));
      if (v > bestV) { bestV = v; best = i; }
    }
    return best;
  }

  /** A gun lying within r metres? */
  gunNear(r) {
    const p = this.pos, r2 = r * r;
    for (const it of this.game.loot.items.values()) {
      const dx = it.x - p.x, dz = it.z - p.z;
      if (dx * dx + dz * dz < r2 && Math.abs(it.y - p.y) < 2 && has(WEAPONS, it.item.k) && !WEAPONS[it.item.k].melee) return true;
    }
    return false;
  }

  /**
   * After a fight, the careful (and the builders) box up before they heal, like players do:
   * starts the box and says so.
   */
  boxToHeal(r) {
    const b = this.brain;
    if (this.build.busy || this.time - b.boxT < 20 || (this.totalMats() < 50 && !this.infMats)) return false;
    b.boxT = this.time; // (one try per fight)
    if (Math.random() > (0.4 + 0.6 * Math.max(b.persona.build, b.persona.camp)) * b.buildK) return false;
    const yaw = r ? Math.atan2(-(r.x - this.pos.x), -(r.z - this.pos.z)) : this.yaw;
    if (!this.build.start('box', yaw)) return false;
    b.lowPlan = 'box';
    return true;
  }

  /** Healing worth stopping for: under 75 health or 50 shield, with something that helps. */
  wantsHeal() {
    if (this.hp >= 75 && this.sh >= 50) return false;
    const s = this.healSlot();
    if (s < 0) return false;
    const h = HEALS[this.inv.slots[s].k];
    return (h.hp && this.hp < 75) || (h.sh && this.sh < 50) || (!!h.sh && this.hp >= 75);
  }

  totalMats() { return this.inv.mats.wood + this.inv.mats.stone + this.inv.mats.metal; }

  /** How much a bot wants this floor item (0 = ignore). Weapons > shields/heals > better rarity. */
  lootValue(item) {
    const k = item.k;
    if (!wantsLoot(this)) return 0;
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
      // a shotgun is a must-have until we hold one (close fights are shotgun fights)
      const needShotgun = isShotgun(k) && !this.hasShotgun();
      const missing = needShotgun || !this.hasClass(weaponClass(k));
      if (this.freeSlot() < 0) return missing && this.swapSlotFor(item) > 0 ? 3 + r * 0.5 + (needShotgun ? 3 : 0) : 0;
      let v = (missing ? 5 : 1.2) + r * 0.6 + (needShotgun ? 6 : 0);
      if (w.scope) v += this.brain.persona.snipe * 2 - 0.6;
      return v;
    }
    if (has(HEALS, k)) {
      if (!this.canAutoPick(item)) return 0;
      let n = 0;
      for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && has(HEALS, s.k)) n++; }
      return (HEALS[k].sh ? 4 : 3) + (n ? 0 : 2);
    }
    if (MAT_KEYS.includes(k)) {
      if (!this.canAutoPick(item) || buildRule(this.game) === 'off') return 0;
      const want = this.brain.matsWant * 1.5;
      return this.totalMats() < want ? (this.totalMats() < this.brain.matsWant ? 2 : 0.8) : 0;
    }
    return 0; // ammo: bots never run dry
  }

  /** Full inventory: which slot to give up for this item (-1 = none). */
  swapSlotFor(item) {
    const k = item.k;
    if (!has(WEAPONS, k)) return -1;
    const needShotgun = isShotgun(k) && !this.hasShotgun();
    let worst = -1, worstV = 1e9;
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s) return -1;
      if (s.k === k) return (s.r | 0) < (item.r | 0) ? i : -1;
      let v;
      if (has(WEAPONS, s.k)) {
        // only a gun whose class we have twice is spare (an SMG goes for our first shotgun)
        let twin = false;
        for (let j = 1; j <= 5; j++) {
          const o = this.inv.slots[j];
          if (j !== i && o && has(WEAPONS, o.k) && weaponClass(o.k) === weaponClass(s.k)) twin = true;
        }
        v = twin ? (s.r | 0) : needShotgun && weaponClass(s.k) === 0 ? 20 + (s.r | 0) : 100;
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
    if (passive(g)) return false; // Playground: nobody can be hurt, so nobody is a target
    return g.phase !== 'lobby' && !g.friendly(a.id, this.id);
  }

  /**
   * Someone's health + shield as a player would know it: what everyone spawns with, minus the
   * damage numbers we put on them ourselves, healed back up while out of sight.
   */
  guessHp(a) {
    const r = this.brain.recs.get(a.id);
    return r && r.actor === a ? r.est : HS_START;
  }

  /**
   * One of our hits landed (from Game.on_dmg): amt is the damage number we'd see, shLeft the
   * target's shield after it. A hit that leaves no shield shows as plain health damage: under 100.
   */
  dealt(a, amt, shLeft) {
    if (!a || a === this || !this.isEnemy(a)) return;
    const r = this.recOf(a);
    r.est = Math.max(1, r.est - amt);
    if (shLeft === 0) r.est = Math.min(r.est, 100);
    r.estT = this.time;
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
        est: HS_START, estT: -99, // guessed health + shield (guessHp) and when we last hit them
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
      if (!a.mover && d < 18 && speed > 1 && !flying && this.game.isFar(ap)) {
        this.hear(ap.x, ap.y, ap.z, crouch ? 4 : speed > 7 ? 18 : 12, 'step', a.id);
      }
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
      // a few seconds after our last hit, assume they're patching up whenever we can't see them (or
      // can see them healing), at about the rate of shield potions or a med kit
      if (r.est < HS_MAX && now - r.estT > 3 && (!vis || (fl & FLAG.HEAL) !== 0)) r.est = Math.min(HS_MAX, r.est + 12 * dt);
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
    if (!this.alive || this.inBus || this.far) return;
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
    // more from the spot we're already listening to (both sides of the same fight, someone still
    // walking around there): it hasn't gone quiet, but it isn't news either. A long fight is
    // worth a fresh look (and a fresh go / stay decision) about every 30 s.
    const same = now - b.noiseT < 4 && now - b.noiseT0 < 30 && (x - b.noiseTX) ** 2 + (z - b.noiseTZ) ** 2 < 625;
    if (same) {
      b.noiseT = now;
      if (pri >= b.noisePri) {
        b.noisePri = pri; b.noiseKind = kind; b.noiseSrc = src || 0;
        b.noiseX = nx; b.noiseY = y; b.noiseZ = nz; b.noiseD = d; b.noiseTX = x; b.noiseTZ = z;
      }
    } else if (now - b.noiseT > 2.5 || pri >= b.noisePri) {
      b.noiseT = now; b.noisePri = pri; b.noiseKind = kind; b.noiseSrc = src || 0;
      b.noiseX = nx; b.noiseY = y; b.noiseZ = nz; b.noiseD = d; b.noiseTX = x; b.noiseTZ = z;
      b.noiseT0 = now;
      b.noiseDelay = rnd(0.15, 0.45) * (1.4 - 0.6 * b.skill);
      b.noiseDone = false;
      // go and check (third-party a fight), or just look and hold?
      const P = b.persona;
      const fight = kind === 'shot' || kind === 'boom';
      const healthy = this.hp + this.sh > 60;
      b.noiseGo = d < 140 && Math.random() < (fight ? P.aggro * (healthy ? 1 : 0.3) : 0.25 + 0.6 * P.aggro);
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
    if (amt > 0) b.danceT = 0; // being shot ends the victory dance
    // shot by someone being simulated in full (a player, a bot near a player): wake up
    if (a && !a.far) { b.hurtNearT = now; if (this.far) b.farChkT = 0; }
    if (!a || a === this || !this.isEnemy(a)) return;
    const r = this.recOf(a);
    r.hurtT = now;
    const d = Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z);
    const err = 1.5 + d * 0.1 * (1.2 - 0.5 * b.skill);
    r.hx = a.pos.x + gauss() * err; r.hy = a.pos.y; r.hz = a.pos.z + gauss() * err; r.heardT = now;
    if (r.aw < 0.7) r.aw = 0.7;
    if (b.noiseKind !== 'hit' || now - b.noiseT > 1) {
      // (a burst of hits is one event: one reaction, one decision to go for them or not)
      b.noiseT0 = now; b.noiseDelay = rnd(0.1, 0.35) * (1.4 - 0.6 * b.skill);
      b.noiseGo = Math.random() < b.persona.aggro;
    }
    b.noiseT = now; b.noisePri = NOISE_PRI.hit + 1; b.noiseKind = 'hit'; b.noiseSrc = a.id;
    b.noiseX = r.hx; b.noiseY = r.hy; b.noiseZ = r.hz; b.noiseD = d; b.noiseDone = false;
    b.noiseTX = a.pos.x; b.noiseTZ = a.pos.z;
    // throw up a wall (or a ramp to fight for height) between us and the shooter, like players do
    if (!b.wallReq && amt > 0 && Math.random() < (0.4 + 0.5 * b.persona.build * (0.5 + 0.5 * b.skill)) * b.buildK) b.wallReq = true;
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
      s += targetBonus(this, a);
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
    const e0 = (0.03 + 0.06 * (1 - b.skill)) * b.aimK;
    b.errMag = again ? Math.max(b.errMag, e0 * 0.6) : e0;
    b.errT = 0;
    b.leadK = 1 - rnd(0.05, 0.6) * (1 - b.skill) + gauss() * 0.1;
    b.dropK = 1 - rnd(-0.2, 0.4) * (1 - b.skill);
    b.headAim = Math.random() < b.skill * 0.45 * (b.easy ? 0.4 : 1);
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
    const hunter = isHunter(this);
    let mode = 'travel';
    if (b.mode === 'box' && (this.build.busy || now - b.modeT < 0.5)) mode = 'box';
    else if (t && (r.vis || now - r.seenT < 0.5)) {
      const d = Math.hypot(r.x - this.pos.x, r.z - this.pos.z);
      const threat = now - r.hurtT < 4;
      b.wantSlot = this.bestWeaponFor(d);
      // where this gun is actually good, stretched by how keen this player is to fight
      const rg = b.wantSlot > 0 ? weaponRange(this.inv.slots[b.wantSlot].k) : null;
      const reach = rg ? Math.min(rg[2] * 1.2, rg[1] * 2 * (0.5 + P.aggro)) : 0;
      if (hpNow < 50 && !b.lowPlan) {
        // losing a fight: box up and heal, run, or keep swinging
        const canBox = healS > 0 && this.build.can() && Math.random() < (0.25 + P.build * (0.4 + 0.5 * b.skill)) * b.buildK;
        b.lowPlan = canBox ? 'box' : P.aggro < 0.8 && Math.random() < 0.7 - P.aggro * 0.5 ? 'flee' : 'fight';
        if (canBox) { this.build.start('box', Math.atan2(-(r.x - this.pos.x), -(r.z - this.pos.z))); b.boxT = now; }
      }
      // the infected only have claws: run them down
      if (hunter) mode = d < 30 || threat ? 'melee' : 'travel';
      // no gun yet: grab one (there's usually one close by after landing); swing back only at
      // someone hitting us when there's nothing to grab
      else if (!gun) mode = d < 5 && threat && !this.gunNear(12) ? 'melee' : d < 25 && threat ? 'flee' : 'travel';
      else if (urg === 2 && d > 25 && !threat) mode = 'travel';
      else if (b.lowPlan === 'box' && this.build.busy) mode = 'box';
      else if (b.lowPlan === 'flee' && hpNow < 50 && now - b.hurtT < 6 && this.guessHp(t) > hpNow + 20) mode = 'flee';
      // barely kitted out and nobody's shooting at us: keep looting rather than take a long fight
      else if (this.itemCount() < 3 && !threat && now - b.hurtT > 5 && d > 15) mode = 'travel';
      // just landed: loot up first (watch them if patient), unless they're in our face
      else if (this.calm(d, threat)) mode = P.camp >= 0.4 ? 'watch' : 'travel';
      else if (threat || d < reach) mode = 'fight';
      // out of range: the keen (or well kitted) close the distance, patient players keep an eye on
      // them, everyone else keeps looting and takes the fight if it comes to them
      else if (P.aggro >= 0.7 || (P.aggro >= 0.4 && this.gunCount() >= 2 && hpNow > 100) || targetBonus(this, t) > 0) mode = 'fight';
      else mode = P.camp >= 0.4 || P.snipe >= 0.5 ? 'watch' : 'travel';
    } else if (t) {
      const d = Math.hypot(r.x - this.pos.x, r.z - this.pos.z);
      b.wantSlot = this.bestWeaponFor(d);
      const rg = b.wantSlot > 0 ? weaponRange(this.inv.slots[b.wantSlot].k) : null;
      // someone we let go by (too far to bother with) isn't worth hunting down either
      const far = !rg || (d > rg[1] * 2 * (0.5 + P.aggro) && now - r.hurtT > 6 && P.aggro < 0.7);
      // running away: keep running while they're still on us (turning our back is what hides
      // them), and only stop to heal once it has been quiet for a moment. Someone who ran and
      // has nothing to heal with leaves instead of searching back toward them.
      const running = b.lowPlan === 'flee' && hpNow < 50 && (now - b.hurtT < 4 || now - r.seenT < 2);
      // after a fight (nobody seen for 3 s): patch up to 75 health and 50 shield first
      const settled = now - r.seenT > 3 && now - b.hurtT > 1.5;
      mode = urg === 2 || (!gun && !hunter) ? 'travel'
        : running ? 'flee'
        : settled && this.wantsHeal() ? this.boxToHeal(r) ? 'box' : 'heal'
        : healS > 0 && hpNow < 75 && now - r.seenT > 1.5 && now - b.hurtT > 1.5 ? 'heal'
        : far || b.lowPlan === 'flee' ? 'travel' : 'search';
    } else if (b.danceT > 0) mode = 'emote';
    else if (urg === 2) mode = 'travel';
    else if (healS > 0 && now - b.hurtT > 1.5) mode = 'heal';
    else if (gun && !b.noiseDone && now - b.noiseT < 10) mode = 'investigate';
    else if (this.onHill()) mode = 'hill';
    else if (gun && P.camp > 0.6 && !urg && now > b.campCool && (this.gunCount() >= 2 || now > 120) && modeKey(this.game) === 'br') mode = 'hold';
    if (mode !== b.mode) this.enterMode(mode);
    if (mode !== 'emote') b.danceT = 0;
    if (mode === 'travel' && (b.planT <= 0 || !b.destKind)) this.planTravel(false);
    this.idleBuild(mode);
    this.tidyInventory();
  }

  /**
   * The first CALM_S after landing: loot first, like people do. Nobody starts a fight unless the
   * target is right in front of us (or shooting at us); rushers don't care.
   */
  calm(d, threat) {
    const b = this.brain;
    return !threat && d > 10 && this.time - b.skyT < (b.persona.aggro < 0.9 ? CALM_S : RUSH_CALM_S) && modeKey(this.game) === 'br';
  }

  /** King of the hill: standing on it (nothing else going on: hold it). */
  onHill() {
    const h = hillOf(this.game);
    if (!h) return false;
    const dx = this.pos.x - h.x, dz = this.pos.z - h.z;
    return dx * dx + dz * dz < (h.r - 1) * (h.r - 1);
  }

  /**
   * Building outside fights: climbing away from rising lava, a fort now and then in Playground
   * (nobody can be hurt there, so building is the game).
   */
  idleBuild(mode) {
    const b = this.brain;
    if (this.build.busy || b.target || !this.build.can()) return;
    if (lavaClose(this)) { this.build.start('nineties', this.yaw); return; }
    if (passive(this.game) && mode === 'travel' && (b.funT -= 0.25) <= 0) {
      b.funT = rnd(15, 40);
      this.build.start(Math.random() < 0.5 ? 'box' : 'nineties', this.yaw);
    }
  }

  enterMode(mode) {
    const b = this.brain;
    if (b.mode === 'hold') b.noProg = 0; // (hold borrows it to pickaxe toward its spot)
    b.mode = mode;
    b.modeT = this.time;
    this.dancing = mode === 'emote';
    if (mode === 'hold') b.holdSet = false;
    if (mode === 'flee') b.fleeSide = Math.random() < 0.5 ? -1 : 1;
    if (mode === 'search') { b.peekT = 0; b.peekS = 0; b.peekK = 0; b.peekUp = false; }
    if (mode === 'travel') b.planT = 0;
  }

  // ------------------------------------------------------------------ travel planning
  /** Where to go next (far = the cheap far simulation: no harvesting). */
  planTravel(far) {
    const b = this.brain, g = this.game, P = b.persona, now = this.time;
    b.planT = rnd(0.6, 1);
    const urg = b.urgent;
    const gun = this.hasGun();
    const loot = wantsLoot(this);
    // the infected run down survivors before anything else
    if (isHunter(this) && modeGoal(this, _g) === 'hunt') {
      b.destKind = 'goal'; b.goalKind = 'hunt'; b.dest.set(_g.x, _g.y, _g.z); b.planT = 0.5;
      return;
    }
    // loot worth the detour (more of a detour for goblins, none when the storm is on us), plus
    // whatever our last kill dropped
    // a gun in hand and no materials at all: a tree or two first (fights need walls)
    if (!far && !urg && gun && b.harvest === null && this.totalMats() < 30 && now > b.treeT && buildRule(g) === 'on' && !this.infMats && !passive(g)) {
      b.treeT = now + 4;
      b.harvest = this.nearestTree(20);
      b.harvestT = -1;
      if (b.harvest !== null) {
        const o = g.world.objs[b.harvest];
        if (o && o.alive) { b.destKind = 'tree'; b.dest.set(o.o.x, o.o.y, o.o.z); return; }
        b.harvest = null;
      }
    }
    if (b.harvest !== null && b.destKind === 'tree' && this.totalMats() < 60) {
      const o = g.world.objs[b.harvest];
      if (o && o.alive) return; // keep at it
    }
    if (loot) {
      const radius = urg === 2 ? 5 : urg ? 12 : !gun ? 50 : 15 + 25 * P.loot;
      const it = this.bestLoot(radius, now - b.killT < 25);
      if (it) {
        if (b.lootRef !== it) b.lootT = now;
        b.destKind = 'loot'; b.lootRef = it; b.dest.set(it.x, it.y, it.z);
        return;
      }
    }
    b.lootRef = null;
    if (loot && urg < 2) {
      const c = g.nearestChest(this.pos, urg ? 10 : !gun ? 40 : 10 + 25 * P.loot);
      if (c && !b.badChest.has(c.i)) { b.destKind = 'chest'; b.chestI = c.i; b.dest.set(c.x, c.y, c.z); return; }
    }
    // mats: builders keep a big stack, everyone else enough for a few fights
    const matsOk = (buildRule(g) !== 'on' || this.infMats || this.infinite) && !passive(g);
    if (!far && !urg && !matsOk && b.harvest === null && this.totalMats() < b.matsWant * 0.6 && now > b.treeT && (gun || !loot)) {
      b.treeT = now + 4;
      b.harvest = this.nearestTree(P.build > 0.6 ? 40 : 28);
      b.harvestT = -1;
    }
    if (!far && !urg && b.harvest !== null) {
      const o = g.world.objs[b.harvest];
      if (o && o.alive && this.totalMats() < b.matsWant) { b.destKind = 'tree'; b.dest.set(o.o.x, o.o.y, o.o.z); return; }
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

  /** The nearest standing tree or rock within r (a 32 m hash walk when the world has one). */
  nearestTree(r) {
    const g = this.game, data = g.world.data, p = this.pos;
    if (typeof data.objectsNear !== 'function') return g.nearestTree(p, r);
    let best = null, bd = r * r;
    data.objectsNear(p.x, p.z, r, (o) => {
      if ((o.kind !== 'tree' && o.kind !== 'rock') || !(o.hp > 0) || Math.abs(o.y - p.y) > 3 || this.brain.badTree.has(o.id)) return false;
      const dx = o.x - p.x, dz = o.z - p.z, d = dx * dx + dz * dz;
      if (d < bd && g.world.isAlive(o.id)) { bd = d; best = o.id; }
      return false;
    });
    return best;
  }

  /**
   * The floor item most worth walking to within radius (or, with kill set, in the pile our last
   * kill dropped, wherever that is). With the storm on us, only what's on the way to safety.
   */
  bestLoot(radius, kill) {
    const b = this.brain, st = this.game.storm.state, p = this.pos;
    const r2 = radius * radius;
    // in (or about to be caught by) the storm: nothing farther from the next circle than we are
    // now, and a kill's pile only if it's inside the current circle
    let sx = 0, sz = 0, lim2 = Infinity, in2 = Infinity;
    if (b.urgent === 2 && st) {
      sx = st.ncx; sz = st.ncz;
      lim2 = (Math.hypot(p.x - sx, p.z - sz) + 1) ** 2;
      in2 = Math.max(0, st.r - 5) ** 2;
    }
    let best = null, bestS = 0;
    // a shotgun is worth a longer walk while we don't have one (not with the storm on us)
    const sg2 = b.urgent === 2 || this.hasShotgun() || !this.hasGun() ? 0 : Math.max(r2, 45 * 45);
    for (const it of this.game.loot.items.values()) {
      const dx = it.x - p.x, dz = it.z - p.z, dy = it.y - p.y;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 && !(d2 <= sg2 && isShotgun(it.item.k))) {
        // their stuff is scattered within a few metres of where they fell
        if (!kill || (it.x - b.killX) ** 2 + (it.z - b.killZ) ** 2 > 36) continue;
        if (in2 !== Infinity && (it.x - st.cx) ** 2 + (it.z - st.cz) ** 2 > in2) continue;
      }
      // upstairs / downstairs is fine when we can route there (through the door, up the stairs)
      if ((dy > 1.8 || dy < -1.8) && !(this.nav.ready && this.nav.roomAt(it.x, it.z))) continue;
      if (this.pendingPick.has(it.id) || b.badLoot.has(it.id)) continue;
      if (lim2 !== Infinity && (it.x - sx) ** 2 + (it.z - sz) ** 2 > lim2) continue;
      if (!inArea(this.game, it.x, it.z)) continue;
      const v = this.lootValue(it.item);
      if (v <= 0) continue;
      const s = v / (1 + Math.sqrt(d2 + dy * dy * 9) / 10);
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
    // somewhere we can stand (not in a lake or a wall)
    if (this.nav.ready) {
      const o = this.nav.nearestOpen(b.safeX, b.safeZ, 24, _g);
      if (o) { b.safeX = o.x; b.safeZ = o.z; }
    }
  }

  /** Campers find a corner (a loot spot inside a house if one is near) and hold it a while. */
  pickHold() {
    const b = this.brain, g = this.game, st = g.storm.state;
    let best = null, bestD = 70;
    for (const s of g.world.data.lootSpots) {
      if (s.ground || b.badHold.has(s)) continue;
      if (Math.abs(s.x - this.pos.x) > bestD || Math.abs(s.z - this.pos.z) > bestD) continue;
      if (st && Math.hypot(s.x - st.ncx, s.z - st.ncz) > st.nr * 0.85) continue;
      const d = Math.hypot(s.x - this.pos.x, s.z - this.pos.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    b.holdSpot = best;
    b.holdX = best ? best.x : this.pos.x;
    b.holdZ = best ? best.z : this.pos.z;
    b.holdSet = true;
    b.holdUntil = this.time + rnd(35, 80);
    b.holdChkT = 2.5; b.holdD = Infinity; b.holdStall = 0;
  }

  pickGoal() {
    const g = this.game, b = this.brain, P = b.persona;
    const st = g.storm.state;
    const data = g.world.data;
    if (!b.goal) b.goal = new THREE.Vector3();
    // the mode's goal (the hill, the Juggernaut, high ground, a human teammate...)
    const mk = modeGoal(this, _g);
    if (mk) {
      b.goal.set(_g.x, _g.y, _g.z); b.goalKind = mk;
      b.goalT = mk === 'hunt' || mk === 'follow' ? 3 : 10;
      return;
    }
    b.goalKind = '';
    const places = data.regions || data.pois || [];
    // rushers head where the people are (named places); goblins toward unopened chests
    if (Math.random() < P.hot * 0.6 && places.length) {
      const q = places[(Math.random() * places.length) | 0];
      if ((!st || Math.hypot(q.x - st.ncx, q.z - st.ncz) < st.nr) && inArea(g, q.x, q.z)) {
        b.goal.set(q.x + (Math.random() - 0.5) * 40, 0, q.z + (Math.random() - 0.5) * 40);
        b.goal.y = data.heightAt(b.goal.x, b.goal.z);
        b.goalT = 30 + Math.random() * 20;
        b.goalKind = 'place';
        return;
      }
    }
    if (Math.random() < P.loot * 0.5 && wantsLoot(this)) {
      const c = g.nearestChest(this.pos, 120);
      if (c && (!st || Math.hypot(c.x - st.ncx, c.z - st.ncz) < st.nr) && inArea(g, c.x, c.z)) { b.goal.set(c.x, c.y, c.z); b.goalT = 30; return; }
    }
    if (roamPoint(this, _g)) {
      b.goal.set(_g.x, _g.y, _g.z);
      b.goalT = 25 + Math.random() * 20;
      return;
    }
    b.goal.set(0, data.heightAt(0, 0), 0);
    b.goalT = 20;
  }

  // ------------------------------------------------------------------ the drop
  /**
   * The landing spot: a place first (hot drops for the keen, quiet places for the careful, never
   * more than ceil(bots / places) + 1 of us in one place, empty places preferred), then a loot spot
   * in it away from the others; 30% of the careful go for houses and spots out in the open, well
   * off the bus line. Never water, lava or a cliff, and always within gliding reach of the bus.
   */
  chooseLanding() {
    const g = this.game, b = this.brain, P = b.persona, data = g.world.data;
    const spots = data.lootSpots;
    const regions = data.regions || [];
    const bus = this.inBus && g.bus && g.bus.path ? g.bus.path : null;
    const reach = dropReach();
    let ax = 0, az = 0, ux = 0, uz = 0, blen = 0;
    if (bus) {
      ax = bus.ax; az = bus.az;
      const dx = bus.bx - bus.ax, dz = bus.bz - bus.az;
      blen = Math.hypot(dx, dz) || 1;
      ux = dx / blen; uz = dz / blen;
    }
    // sideways distance from the bus line (and whether the bus passes by at all)
    const lateral = (x, z) => {
      if (!bus) return Math.hypot(x - this.pos.x, z - this.pos.z);
      const rx = x - ax, rz = z - az, along = rx * ux + rz * uz;
      if (along < -reach * 0.3 || along > blen * BUS.forceDrop + reach * 0.3) return Infinity;
      return Math.abs(rx * uz - rz * ux);
    };
    const maxLat = bus ? reach : 220;
    // who is landing where already (this device's bots)
    const nBots = Math.max(1, g.bots.size);
    const counts = this._regionCounts || (this._regionCounts = new Map());
    counts.clear();
    for (const o of g.bots.values()) if (o !== this && o.brain.landAt && o.brain.landRegion >= 0) counts.set(o.brain.landRegion, (counts.get(o.brain.landRegion) || 0) + 1);
    const places = regions.length;
    const cap = Math.ceil(nBots / Math.max(1, places)) + 1;
    // 1. the place (or the open, for the edge droppers)
    const edge = P.hot < 0.5 && Math.random() < 0.3;
    let reg = -1;
    if (!edge && places) {
      let bestS = -Infinity;
      for (const r of regions) {
        if (!inArea(g, r.x, r.z, 10)) continue;
        const lat = Math.max(0, lateral(r.x, r.z) - (r.r || 40) * 0.7); // its near edge
        if (lat > maxLat) continue;
        const n = counts.get(r.id) || 0;
        if (n >= cap) continue;
        let s = Math.random() * 40;
        s += r.tier === 'hot' ? (P.hot - 0.5) * 80 : r.tier === 'quiet' ? (0.5 - P.hot) * 40 : 0;
        s += n === 0 ? 25 : -12 * n; // spread over the places
        s -= Math.max(0, lat - reach * 0.6) * 0.25; // long glides only when it's worth it
        if (r.named === false) s -= 10; // landmarks: a quieter start
        if (s > bestS) { bestS = s; reg = r.id; }
      }
    }
    // 2. a spot: in that place, or (edge) somewhere off the bus line
    const R = reg >= 0 ? regions[reg] : null;
    const p = this.pos;
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 80 && spots.length; i++) {
      const s = spots[(Math.random() * spots.length) | 0];
      const sr = regionOfSpot(data, s);
      if (R) { if (sr !== reg && Math.hypot(s.x - R.x, s.z - R.z) > (R.r || 50)) continue; } else if (sr >= 0 && regions[sr] && regions[sr].tier === 'hot') continue;
      const lat = lateral(s.x, s.z);
      if (lat > maxLat || !inArea(g, s.x, s.z, 10) || !this.landable(s.x, s.z)) continue;
      let score = Math.random() * 30;
      if (!bus) score -= Math.hypot(s.x - p.x, s.z - p.z) * 0.3; // mid-air (respawn, a handover): close by
      if (!R) score += (lat >= 110 ? 30 : -30) + (sr < 0 ? 15 : 0);
      // don't all land on the same roof: spread out even inside a busy town
      let near = 0;
      for (const o of g.bots.values()) {
        const l = o !== this && o.brain.landAt;
        if (!l) continue;
        const ld2 = (l.x - s.x) ** 2 + (l.z - s.z) ** 2;
        if (ld2 < 100) score -= 100;
        if (ld2 < 625) near++;
        else if (ld2 < 1600) score -= 25 * (1 - P.hot); // the careful keep their distance
      }
      if (near >= 2) score -= 80;
      if (score > bestS) { bestS = score; best = s; }
    }
    if (!best && R) {
      // a place without loot spots of its own (a landmark): its centre, if you can land there
      if (this.landable(R.x, R.z)) best = { x: R.x, y: data.heightAt(R.x, R.z), z: R.z };
    }
    if (!best) {
      // nothing good in reach (a mode without loot spots in the area): just below
      b.landAt = new THREE.Vector3(p.x, 0, p.z);
      if (this.nav.ready) { const o = this.nav.nearestOpen(p.x, p.z, 40, _g); if (o) b.landAt.set(o.x, 0, o.z); }
      b.landAt.y = data.heightAt(b.landAt.x, b.landAt.z);
      b.landRegion = -1;
      return;
    }
    b.landAt = new THREE.Vector3(best.x, best.y, best.z);
    b.landRegion = reg >= 0 ? reg : regionOfSpot(data, best);
  }

  /** Can you land at (x, z)? Not in water or lava, not on a cliff, inside the island. */
  landable(x, z) {
    const data = this.game.world.data;
    if (data.heightAt(x, z) < 0.8) return false;
    for (const L of data.lava || []) if (L && (x - L.x) ** 2 + (z - L.z) ** 2 < ((L.r || 5) + 4) ** 2) return false;
    const nav = this.nav;
    if (nav.ready) {
      const f = nav.flagsAt(x, z);
      if (f & (1 | 2 | 32 | 128)) { // block, water, cliff, too steep to climb
        // a loot spot inside a building sits in a room: that's fine
        if (!nav.roomAt(x, z)) return false;
      }
      // a plateau nobody can walk off (or onto) is a trap: only the main ground
      const n = nav.nodeAt(x, z, 2);
      if (n >= 0 && nav.exits && nav.comp[n] >= 0 && !nav.exits[nav.comp[n]] && nav.ncomp > 1) {
        const big = nav.mainComp ?? (nav.mainComp = mainComponent(nav));
        if (nav.comp[n] !== big) return false;
      }
    }
    return true;
  }

  /** Read by Game while we ride the bus: when to jump (s since the bus left). */
  dropTime(def) {
    stepNav(this);
    const g = this.game, b = this.brain;
    const bus = g.bus && g.bus.path;
    if (!bus || !this.inBus) return def;
    if (!b.dropPlan) {
      this.chooseLanding();
      const l = b.landAt;
      const dx = bus.bx - bus.ax, dz = bus.bz - bus.az, len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const rx = l.x - bus.ax, rz = l.z - bus.az;
      const along = rx * ux + rz * uz, lat = Math.abs(rx * uz - rz * ux);
      // jump a little before the bus passes the spot (the glide covers the rest diagonally)
      const at = Math.max(len * 0.04, Math.min(len * BUS.forceDrop * 0.98, along - lat * 0.3 + rnd(-8, 8)));
      b.dropPlan = { t: at / (bus.speed || BUS.speed) };
    }
    return b.dropPlan.t;
  }

  // ------------------------------------------------------------------ per frame
  think(dt) {
    const b = this.brain;
    const ctl = this.ctl;
    ctl.mx = 0; ctl.my = 0; ctl.fire = false; ctl.firePressed = false; ctl.jump = false; ctl.sprint = false; ctl.reload = false; ctl.ads = false; ctl.crouch = false;
    if (!this.alive || this.inBus) return;
    if (this.time < b.wakeT) return; // just woken from the far simulation: let the world settle
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
    b.thinkT -= dt; b.planT -= dt; b.goalT -= dt; b.buildT -= dt; b.jumpT -= dt; b.rampT -= dt; b.ninetyT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = rnd(0.2, 0.3);
      this.perceive(Math.min(0.5, b.thinkAcc));
      b.thinkAcc = 0;
      this.decide();
    }
    b.moving = false;
    this.build.update(dt);
    if (b.breakT > 0 && b.mode !== 'fight' && b.mode !== 'watch' && b.mode !== 'box' && !this.build.busy) this.breakThrough(dt);
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
        case 'hill': this.holdHill(dt); break;
        default: this.travel(dt);
      }
    }
    // a pattern running outside a fight (lava, Playground): walk it
    if (this.build.busy && b.mode !== 'fight' && b.mode !== 'box') this.buildMove(dt);
    if (b.wallReq && b.buildT <= 0 && b.mode !== 'emote' && b.mode !== 'box') this.reactiveBuild();
    this.checkStuck(dt);
  }

  skydive(dt) {
    const b = this.brain;
    // (gliding after a launch pad isn't a landing: the calm after landing doesn't start over)
    if (!this.mover.launched) b.skyT = this.time;
    if (!b.spread) {
      // everyone leaves the bus at the same point: fan out so nobody stands on anyone
      b.spread = true;
      this.mover.teleport(this.pos.x + rnd(-5, 5), this.pos.y - rnd(0, 8), this.pos.z + rnd(-5, 5));
      this.mover.vel.y = -5;
    }
    // thrown by a launch pad on the way somewhere: glide to where the route goes next
    if (this.mover.launched && this.follow.routed) {
      if (!b.landAt) b.landAt = new THREE.Vector3();
      b.landAt.set(this.follow.tx, 0, this.follow.tz);
    }
    if (!b.landAt) this.chooseLanding();
    _d.set(b.landAt.x - this.pos.x, 0, b.landAt.z - this.pos.z);
    const dist = _d.length();
    const yawT = Math.atan2(-_d.x, -_d.z);
    // dive (fast, steep) only when the spot is close enough that the glide still gets there
    const above = Math.max(0, this.pos.y - (this.game.world.data.heightAt(this.pos.x, this.pos.z)));
    const reachFlat = Math.max(0, above - DROP.glideHeight) / DROP.skydiveFall * DROP.skydiveSpeed + Math.min(above, DROP.glideHeight) / DROP.glideFall * DROP.glideSpeed;
    const dive = this.mode === 'skydive' && dist > 30 && dist < reachFlat * 0.45;
    this.turnTo(yawT, dive ? -0.9 : -0.2, dt, 3);
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
      // on a planned route the follower deals with it (avoids the link, plans again); heading
      // straight somewhere, give up on it after a few tries
      if (++b.stuckN >= 3 && !this.follow.routed) {
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
    // the last resort: wanting to go somewhere for 8 s and still within 2 m of where we were
    // (going back and forth, a destination nothing else gave up on): drop it and pick another
    if (b.moving) b.wdMove++;
    if ((b.wdT += 1) >= 8) {
      const far = Math.hypot(this.pos.x - b.wdX, this.pos.z - b.wdZ);
      if (b.wdMove >= 7 && far < 2) {
        if (b.lootRef) { b.badLoot.add(b.lootRef.id); if (b.badLoot.size > 24) b.badLoot.clear(); }
        if (b.destKind === 'chest') b.badChest.add(b.chestI);
        if (b.harvest !== null) { b.badTree.add(b.harvest); b.harvest = null; }
        b.destKind = ''; b.planT = 0; b.goalT = 0; b.safeKey = 0;
        this.follow.reset();
        b.avoid = Math.random() < 0.5 ? 1 : -1; b.avoidT = 1.5;
        if (b.mode !== 'travel' && b.mode !== 'fight') this.enterMode('travel');
      }
      b.wdT = 0; b.wdMove = 0; b.wdX = this.pos.x; b.wdZ = this.pos.z;
    }
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
        if (Math.hypot(it.x - this.pos.x, it.z - this.pos.z) < 1.8 && Math.abs(it.y - this.pos.y) < 2) {
          this.grab(it);
          b.planT = Math.min(b.planT, 0.3);
        }
        if (now - b.lootT > 20) { b.badLoot.add(it.id); b.destKind = ''; }
        break;
      }
      case 'chest':
        if (g.world.chestOpen.has(b.chestI)) { b.destKind = ''; b.planT = 0; break; }
        if (Math.hypot(d.x - this.pos.x, d.z - this.pos.z) < 2.2 && Math.abs(d.y - this.pos.y) < 2.5) g.openChest(this, b.chestI);
        break;
      case 'tree': {
        const o = b.harvest !== null ? g.world.objs[b.harvest] : null;
        if (!o || !o.alive) { b.harvest = null; b.destKind = ''; b.planT = 0; break; }
        const rock = o.o.kind === 'rock', reach = rock ? 1.7 + (o.o.s || 1) * 0.6 : 2.2;
        if (Math.hypot(d.x - this.pos.x, d.z - this.pos.z) < reach) {
          // swinging away and nothing comes of it (can't reach it from here): another one
          if (b.harvestT < 0) { b.harvestT = now; b.harvestM = this.totalMats(); } else if (now - b.harvestT > 5) {
            if (this.totalMats() <= b.harvestM) { b.badTree.add(b.harvest); b.harvest = null; b.destKind = ''; b.planT = 0; b.harvestT = -1; break; }
            b.harvestT = now; b.harvestM = this.totalMats();
          }
          if (this.inv.sel !== 0) this.select(0);
          this.faceToward(_v.set(o.o.x, rock ? Math.min(this.pos.y + 1.2, o.o.y + Math.max(0.5, (o.o.s || 1) * 0.5)) : this.pos.y + 1.2, o.o.z), dt, 8);
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
    if (hd < 0.6 && Math.abs(d.y - this.pos.y) < 2) { this.lookAround(this.yaw, -0.05, dt, true); return; }
    const urgent = b.urgent === 2;
    const r = this.navTo(d, dt, urgent || hd > 25);
    if (r <= 0) {
      // there (or no way there): something else next time we think
      if (r < 0) {
        if (b.lootRef) b.badLoot.add(b.lootRef.id);
        if (b.destKind === 'chest') { b.badChest.add(b.chestI); if (b.badChest.size > 24) b.badChest.clear(); b.chestI = -1; }
        if (b.destKind === 'tree' && b.harvest !== null) { b.badTree.add(b.harvest); if (b.badTree.size > 32) b.badTree.clear(); }
        b.harvest = null;
        b.goalT = 0;
        b.safeKey = 0;
      }
      b.destKind = ''; b.planT = 0;
      this.lookAround(this.yaw, -0.05, dt, true);
      return;
    }
    const f = this.follow;
    this.lookAround(Math.atan2(-(f.tx - this.pos.x), -(f.tz - this.pos.z)), -0.05, dt, !urgent);
  }

  /**
   * Head for the destination along a nav route (rotating into the storm by its shared flow field;
   * a short hop in plain view goes straight). 1 = moving, 0 = there, -1 = no way there.
   */
  navTo(d, dt, sprint) {
    const b = this.brain, f = this.follow, p = this.pos;
    this.navGoal(d);
    const r = f.step(p.x, p.y, p.z, this.time, dt);
    if (r !== 1) return r;
    // heading straight there (no route): the old way round obstacles
    if (!f.routed && this.detour(f.tx, f.tz, Math.hypot(f.tx - p.x, f.tz - p.z), dt)) return 1;
    // a stuck route lets us pickaxe through destructible scenery (probe in moveWorld)
    b.noProg = f.stalled > 1.5 ? 1 : 0;
    // through a door and up the stairs: exactly along the line, no sidestepping the frame
    b.precise = f.precise;
    this.goTo(f.tx, f.tz, dt, sprint && !f.pad && !b.precise);
    b.precise = false;
    // stairs and steps: hop when the next point is a little above us and we're slowing down
    if (f.ty - p.y > 0.6 && f.ty - p.y < 2.2 && this.speed < 2 && b.jumpT <= 0 && this.mover.grounded) { this.ctl.jump = true; b.jumpT = 0.8; }
    return 1;
  }

  /** Point the route follower at d (into the storm's next circle: along its shared flow field). */
  navGoal(d) {
    const b = this.brain, f = this.follow, nav = this.nav, p = this.pos;
    const st = this.game.storm.state;
    if (b.destKind === 'storm' && nav.ready && st) {
      const field = nav.flowTo(st.ncx, st.ncz, st.nr);
      f.useFlow(field, p.x, p.z, d.x, nav.groundY(d.x, d.z), d.z, this.time);
    } else f.goal(d.x, b.destKind === 'storm' ? nav.groundY(d.x, d.z) : d.y, d.z, b.destKind === 'goal' ? 8 : 2.5);
  }

  /**
   * Not getting any closer to where we're going (pacing against a house, a cliff, a fence):
   * walk around it via a point off to one side; after a few tries give up on that destination.
   * Returns true while a detour is being walked.
   */
  detour(dx0, dz0, hd, dt) {
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
    const same = Math.abs(dx0 - b.progX) + Math.abs(dz0 - b.progZ) < 3;
    const stalled = same && hd > 4 && b.progD - hd < 1.5;
    b.progX = dx0; b.progZ = dz0; b.progD = hd;
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
    const side = Math.random() < 0.5 ? -1 : 1, ux = (dx0 - this.pos.x) / hd, uz = (dz0 - this.pos.z) / hd;
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
    if (b.precise) { b.avoidT = 0; } else if (b.avoidT > 0) {
      b.avoidT -= dt;
      const c = Math.cos(b.avoid * 0.9), s = Math.sin(b.avoid * 0.9);
      const rx = wx * c - wz * s, rz = wx * s + wz * c;
      wx = rx; wz = rz;
    } else if ((b.probeT -= dt) <= 0) {
      b.probeT = 0.15;
      const h = this.game.physics.raycast(this.pos.x, this.pos.y + 0.8, this.pos.z, wx, 0, wz, 2.2, RAY_STATIC);
      if (h && h.ny < 0.5) {
        if (h.dist < 1.6 && b.mode !== 'fight' && b.mode !== 'box' && !this.build.busy && this.breakable(h.info, b.noProg > 0 || b.urgent === 2)) {
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
        if (b.glance) {
          b.glance = 0;
          b.glanceT = rnd(1.5, 4.5) * (1.4 - 0.6 * b.skill);
        } else {
          b.glance = (Math.random() < 0.5 ? -1 : 1) * rnd(0.6, 1.8);
          b.glanceT = rnd(0.5, 1.2);
        }
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
      if (sg && b.latSign && sg !== b.latSign) b.errMag += (0.015 + 0.035 * (1 - b.skill)) * b.aimK;
      if (sg) b.latSign = sg;
      if (vy > 4 && !b.tgtAir) b.errMag += (0.015 + 0.02 * (1 - b.skill)) * b.aimK;
      b.tgtAir = vy > 1;
    }
    // the error settles toward a floor: hand steadiness, own movement, distance
    let floor = (0.01 + 0.04 * (1 - b.skill)) * b.aimK + d * 0.00006;
    // easy bots also wobble by a hand's width whatever the range (they miss up close too)
    if (b.easy) floor += 0.3 / Math.max(3, d);
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
    const tol = Math.max(0.012, Math.atan2((w.pellets || 1) > 1 ? 0.9 : 0.45, d)) * (1.5 - 0.5 * b.skill) * (b.easy ? 1.2 : 1);
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
    // reloading in a gunfight: a wall in front of us first (once per reload), like players do
    if (this.reloadT < 0) b.relCov = false;
    else if (!b.relCov) {
      b.relCov = true;
      if (dist > 6 && dist < 90 && this.time - r.seenT < 2 && !this.build.busy && Math.random() < (0.3 + 0.5 * b.persona.build) * b.buildK) {
        this.build.start('wall', Math.atan2(-(px - this.pos.x), -(pz - this.pos.z)));
      }
    }
    if (this.build.busy) this.buildMove(dt);
    else this.fightMove(t, r, w, cur.k, dist, dt);
  }

  /** While a build pattern runs: walk up the ramp we just built, hop when it says so. */
  buildMove(dt) {
    const B = this.build;
    if (B.walkT > 0) this.moveWorld(-Math.sin(B.yaw), -Math.cos(B.yaw), dt);
    if (B.jump && this.mover.grounded) this.ctl.jump = true;
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
    // the keen take a shotgun to them (and swap to it on the way in)
    if (P.aggro >= 0.7 && this.hasShotgun() && dist < 45) want = 6;
    // no shotgun on us: up close is their game, keep a few steps further out
    const noSg = !this.hasShotgun();
    if (noSg) want = Math.max(want, 13);
    // ...and with someone in our face, a wall between us first (then back off)
    if (noSg && dist < 8 && b.buildT <= 0 && !this.build.busy && Math.random() < 0.6 * b.buildK && this.build.start('wall', Math.atan2(-ux, -uz))) b.buildT = rnd(1.2, 2.2);
    let fwd = 0;
    if (dist > want + 4 + 10 * (1 - P.aggro)) fwd = 1;
    else if (dist < Math.max(rg[0], want * 0.5) - 1 || (noSg && dist < SHOTGUN_NEAR)) fwd = -1;
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
    // building: ramp-rush someone above us, builders throw 90s up close for the high ground
    const yawT = Math.atan2(-ux, -uz);
    const above = (r.vis ? t.pos.y : r.y) - this.pos.y;
    if (above > 3 && dist < 35 && b.rampT <= 0 && Math.random() < (0.35 + 0.6 * P.build) * b.buildK) {
      b.rampT = rnd(3, 6);
      this.build.start('ramp', yawT);
    } else if (fwd > 0 && dist > 12 && dist < 40 && b.rampT <= 0 && P.build >= 0.45 && this.totalMats() >= 40 && Math.random() < 0.5 * b.buildK) {
      // pushing in: ramp rush (cover and height on the way)
      b.rampT = rnd(5, 9);
      this.build.start('ramp', yawT);
    } else if (P.build > 0.6 && dist < 30 && b.ninetyT <= 0 && this.totalMats() >= 60 && Math.random() < 0.5 * b.buildK) {
      b.ninetyT = rnd(6, 12) * (1.5 - b.skill);
      this.build.start('nineties', yawT);
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
    else {
      // hold the angle, low if patient, but only from where it can be seen
      const k = this.peek(ex, r.y, ez, dt);
      if (k === 2) {
        const s = (b.peekK < 1.5 ? b.peekS : -b.peekS) * 0.6;
        this.moveWorld(-(dz / d) * s, (dx / d) * s, dt);
      }
      this.ctl.crouch = k === 0 && P.camp > 0.3;
    }
    if (!push && now - r.seenT > b.memory * 0.6) r.spotted = false; // passive players move on sooner
  }

  /**
   * Holding an angle only works if we can see it: with a tree or a corner right in front of us
   * (our cover, not theirs) stand up, or step out to one side (then the other) until the spot is
   * in view. Our own builds are cover on purpose: stay behind those. Re-checked a few times a
   * second. Returns 0 = in view, 1 = only standing, 2 = stepping.
   */
  peek(x, y, z, dt) {
    const b = this.brain, p = this.pos;
    if ((b.peekT -= dt) <= 0) {
      b.peekT = 0.4;
      const near = Math.min(5, Math.hypot(x - p.x, z - p.z) * 0.5);
      const low = this.blockedNear(p.y + 1.1, x, y + 1.2, z, near);
      const high = low && this.blockedNear(p.y + PLAYER.eye, x, y + 1.2, z, near);
      b.peekUp = low;
      if (!high) b.peekS = 0;
      else if (!b.peekS && b.peekK < 4) b.peekS = Math.random() < 0.5 ? -1 : 1;
    }
    if (b.peekS && (b.peekK += dt) < 4) return 2;
    return b.peekUp ? 1 : 0;
  }

  /** Scenery (not builds) within `near` metres of us on the line from our eye (at ey) to (tx, ty, tz)? */
  blockedNear(ey, tx, ty, tz, near) {
    const p = this.pos, dx = tx - p.x, dy = ty - ey, dz = tz - p.z, l = Math.hypot(dx, dy, dz);
    if (l < 0.5) return false;
    const h = this.game.physics.raycast(p.x, ey, p.z, dx / l, dy / l, dz / l, Math.min(near, l), RAY_SOLID);
    return !!h && !(h.info && h.info.kind === 'build');
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
    // keep an eye on where the trouble was (unless we ran from it: then heal facing away, and
    // don't turn back to look until it's done)
    const r = b.trec;
    if (r && b.lowPlan !== 'flee') this.turnHuman(Math.atan2(-(r.x - this.pos.x), -(r.z - this.pos.z)), -0.05, dt, b.turnSpeed * 0.5, b.turnK * 0.4);
    else this.lookAround(this.yaw, -0.05, dt, false);
  }

  /** Boxed up (BuildFight 'box': four walls and a roof): stay in the middle, then heal inside. */
  boxUp(dt) {
    const b = this.brain;
    if (this.build.busy) {
      const r = b.trec;
      if (r) this.turnHuman(Math.atan2(-(r.x - this.pos.x), -(r.z - this.pos.z)), -0.05, dt, b.turnSpeed * 0.5, b.turnK * 0.4);
      return;
    }
    // the box is done: patch up in it
    if (this.healSlot() > 0) { this.enterMode('heal'); return; }
    this.enterMode('travel');
  }

  /** Build without moving the view (the camera angles pick the grid slot). */
  placeAt(type, yaw, pitch) {
    const y0 = this.yaw, p0 = this.pitch, t0 = this.buildType;
    this.yaw = yaw; this.pitch = pitch; this.buildType = type;
    let ok = false;
    try { ok = this.game.tryPlaceBuild(this); } finally { this.yaw = y0; this.pitch = p0; this.buildType = t0; }
    return ok;
  }

  /** Shot at: a wall toward the shooter (a ramp to fight for height when they're above us). */
  reactiveBuild() {
    const b = this.brain, P = b.persona;
    b.wallReq = false;
    if (this.buildMode || this.healT >= 0 || this.build.busy) return;
    const r = b.trec && this.time - b.trec.hurtT < 2 ? b.trec : null;
    const hx = r ? (r.vis ? r.x : r.hx) : b.noiseX, hz = r ? (r.vis ? r.z : r.hz) : b.noiseZ, hy = r ? r.y : b.noiseY;
    const dx = hx - this.pos.x, dz = hz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.5 || d > 160) return;
    const ramp = hy - this.pos.y > 3 && d < 30 && P.build > 0.5;
    if (this.build.start(ramp ? 'ramp' : 'wall', Math.atan2(-dx, -dz))) b.buildT = rnd(0.4, 1.2) * (1.5 - b.skill);
  }

  melee(dt) {
    const t = this.brain.target;
    if (!t) return;
    if (this.inv.sel !== 0) this.select(0);
    this.faceToward(_v.set(t.pos.x, t.pos.y + 1.2, t.pos.z), dt, 10);
    this.ctl.fire = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z) < 4;
    this.goTo(t.pos.x, t.pos.z, dt, true);
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
      if (d > 40) {
        _e.set(b.noiseX, b.noiseY, b.noiseZ);
        const kind = b.destKind;
        b.destKind = 'noise';
        if (this.navTo(_e, dt, d > 60) < 0) b.noiseDone = true;
        b.destKind = kind;
      } else this.goTo(b.noiseX, b.noiseZ, dt, false);
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
      // not getting any closer than we've been (sliding along a wall, the door round the other
      // side): pickaxe through the scenery, and after ~10 s just hold here and forget that spot
      if ((b.holdChkT -= dt) <= 0) {
        b.holdChkT = 2.5;
        if (d < b.holdD - 1) { b.holdD = d; b.holdStall = 0; b.noProg = 0; }
        else if (++b.holdStall >= 4) {
          if (b.holdSpot) { b.badHold.add(b.holdSpot); if (b.badHold.size > 16) b.badHold.clear(); }
          b.holdX = this.pos.x; b.holdZ = this.pos.z;
          b.holdStall = 0; b.noProg = 0;
          return;
        } else b.noProg = Math.max(b.noProg, 1);
      }
      this.goTo(b.holdX, b.holdZ, dt, d > 30);
      this.lookAround(Math.atan2(-dx, -dz), -0.05, dt, true);
      return;
    }
    this.ctl.crouch = true;
    b.lookT -= dt;
    if (b.lookT <= 0) { b.lookT = rnd(1.5, 4); b.lookYaw = this.yaw + rnd(-2.2, 2.2); }
    this.lookAround(b.lookYaw, -0.05, dt, false);
  }

  /** King of the hill: stand on it, keep moving a little, watch every way in. */
  holdHill(dt) {
    const b = this.brain, h = hillOf(this.game);
    if (!h) { this.enterMode('travel'); return; }
    const cur = this.current();
    if (!cur || !has(WEAPONS, cur.k)) { const s = this.bestWeaponFor(20); if (s > 0) this.select(s); }
    const dx = h.x - this.pos.x, dz = h.z - this.pos.z;
    if (dx * dx + dz * dz > (h.r * 0.6) ** 2) this.moveWorld(dx, dz, dt);
    else {
      b.strafeT -= dt;
      if (b.strafeT <= 0) { b.strafe = Math.random() < 0.4 ? 0 : Math.random() < 0.5 ? -1 : 1; b.strafeT = rnd(0.5, 1.5); }
      if (b.strafe) this.moveWorld(-Math.cos(this.yaw) * b.strafe * 0.5, Math.sin(this.yaw) * b.strafe * 0.5, dt);
    }
    b.lookT -= dt;
    if (b.lookT <= 0) { b.lookT = rnd(1, 2.5); b.lookYaw = this.yaw + rnd(-2.4, 2.4); }
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

  /**
   * Back in the match (a mode's respawn, a new round; Game calls this after placing us): forget
   * the old fight and plans, pick a fresh goal (and a landing spot when skydiving in).
   */
  onRespawn(m) {
    const b = this.brain;
    if (this.far) { this.far = false; this.mover.setEnabled(true); }
    b.mode = 'travel'; b.modeT = this.time;
    b.target = null; b.trec = null; b.recs.clear();
    b.lootRef = null; b.destKind = ''; b.chestI = -1; b.harvest = null; b.goal = null; b.goalT = 0;
    b.breakT = 0; b.stuckN = 0; b.noProg = 0; b.detourT = 0; b.wallReq = false; b.lowPlan = '';
    b.danceT = 0; this.dancing = false; b.hurtT = -99; b.noiseDone = true; b.farTarget = null; b.farHealT = -1;
    b.lastHp = this.hp;
    b.lastPos.copy(this.pos);
    b.skyT = this.time;
    this.follow.reset();
    this.build.clear();
    if (this.inBus) { b.landAt = null; b.spread = false; b.dropPlan = null; return; }
    b.spread = true;
    b.landAt = null;
    if (m && m.how === 'sky') this.chooseLanding();
  }

  update(dt) {
    stepNav(this);
    // nobody near: the cheap simulation (js/ai/farsim.js)
    if (wantFar(this, dt)) {
      if (!this.far) enterFar(this);
      farUpdate(this, dt);
      return;
    }
    if (this.far) exitFar(this);
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

/** The biggest component of the nav graph (where nearly everything is). */
function mainComponent(nav) {
  const n = new Int32Array(nav.ncomp);
  for (let k = 0; k < nav.nn; k++) if (nav.comp[k] >= 0) n[nav.comp[k]]++;
  let best = 0;
  for (let c = 1; c < n.length; c++) if (n[c] > n[best]) best = c;
  return best;
}
