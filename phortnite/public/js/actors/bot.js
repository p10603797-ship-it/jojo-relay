// AI opponents. Bots are simulated by one client (the party leader) with the exact same
// movement / weapon code as players and are networked like any other player.
import * as THREE from 'three';
import { WEAPONS, HEALS, BUILD, MAP } from '../../shared/constants.js';
import { Combatant, forwardFromAngles } from './combatant.js';
import { RAY_STATIC, RAY_SOLID } from '../physics.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();

const PREF_RANGE = { shotgun: [0, 14], smg: [0, 28], pistol: [0, 35], ar: [8, 120], sniper: [45, 400], rocket: [12, 80] };

export class Bot extends Combatant {
  constructor(game, info) {
    super(game, info.id, info.name, info.skin, true);
    this.unlimitedAmmo = true;
    const skill = 0.3 + Math.random() * 0.6;
    this.brain = {
      skill,
      state: 'idle',
      goal: null,
      goalT: 0,
      target: null,
      targetSeen: -10,
      reaction: 0,
      tracking: 0,
      strafe: 1,
      strafeT: 0,
      stuckT: 0,
      lastPos: new THREE.Vector3(),
      avoid: 0,
      avoidT: 0,
      thinkT: Math.random() * 0.3,
      lootId: 0,
      dropAt: 0,
      landAt: null,
      errX: 0, errY: 0, errZ: 0,
      buildT: 0,
      harvest: null,
      lastHp: 100,
      jumpT: 0,
    };
    this.ctl = { mx: 0, my: 0, fire: false, firePressed: false, ads: false, jump: false, crouch: false, sprint: false, reload: false };
    this.aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1, tx: 0, ty: 0, tz: 0 };
  }

  hasGun() {
    for (let i = 1; i <= 5; i++) { const s = this.inv.slots[i]; if (s && WEAPONS[s.k]) return true; }
    return false;
  }

  bestWeaponFor(dist) {
    let best = -1, bestScore = -1;
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s || !WEAPONS[s.k]) continue;
      const r = PREF_RANGE[s.k] || [0, 60];
      let score = 1 + s.r * 0.2;
      if (dist >= r[0] && dist <= r[1]) score += 3;
      if (s.m <= 0) score -= 0.5;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  healSlot() {
    for (let i = 1; i <= 5; i++) {
      const s = this.inv.slots[i];
      if (!s || !HEALS[s.k]) continue;
      const h = HEALS[s.k];
      if ((h.hp && this.hp < h.cap - 5) || (h.sh && this.sh < h.cap - 5)) return i;
    }
    return -1;
  }

  pickGoal() {
    const g = this.game;
    const st = g.storm.state;
    const data = g.world.data;
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
        this.brain.goal = new THREE.Vector3(x, 0, z);
        this.brain.goalT = 25 + Math.random() * 20;
        return;
      }
    }
    this.brain.goal = new THREE.Vector3(0, 0, 0);
  }

  chooseLanding() {
    const g = this.game;
    const spots = g.world.data.lootSpots;
    const p = this.pos;
    let best = null, bestD = Infinity;
    for (let i = 0; i < 30; i++) {
      const s = spots[Math.floor(Math.random() * spots.length)];
      const d = Math.hypot(s.x - p.x, s.z - p.z) + Math.random() * 60;
      if (d < bestD) { bestD = d; best = s; }
    }
    this.brain.landAt = best ? new THREE.Vector3(best.x, best.y, best.z) : new THREE.Vector3(0, 0, 0);
  }

  /** Line-of-sight check between two points. */
  los(a, b) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 0.1) return true;
    _d.divideScalar(len);
    const h = this.game.physics.raycast(a.x, a.y, a.z, _d.x, _d.y, _d.z, len - 0.3, RAY_SOLID);
    return !h;
  }

  findTarget() {
    const g = this.game;
    const eye = this.shoulder(new THREE.Vector3());
    let best = null, bestD = 90;
    for (const a of g.actors()) {
      if (a === this || !a.alive || a.mode === 'bus' || a.inBus) continue;
      if (g.phase === 'lobby') continue;
      const d = a.pos.distanceTo(this.pos);
      if (d > bestD) continue;
      _e.set(a.pos.x, a.pos.y + 1.2, a.pos.z);
      // bots notice nearby players even without perfect sight
      if (d < 8 || this.los(eye, _e)) { best = a; bestD = d; }
    }
    return best;
  }

  think(dt) {
    const b = this.brain;
    const ctl = this.ctl;
    const g = this.game;
    ctl.mx = 0; ctl.my = 0; ctl.fire = false; ctl.firePressed = false; ctl.jump = false; ctl.sprint = false; ctl.reload = false; ctl.ads = false; ctl.crouch = false;
    if (!this.alive || this.inBus) return;
    const m = this.mode;

    // ---------------- skydiving: steer to the landing spot
    if (m === 'skydive' || m === 'glide') {
      if (!b.landAt) this.chooseLanding();
      _d.set(b.landAt.x - this.pos.x, 0, b.landAt.z - this.pos.z);
      const dist = _d.length();
      const yawT = Math.atan2(-_d.x, -_d.z);
      this.turnTo(yawT, m === 'skydive' && dist > 60 ? -0.9 : -0.2, dt, 3);
      ctl.my = dist > 4 ? 1 : 0;
      return;
    }

    b.thinkT -= dt;
    b.goalT -= dt;
    b.strafeT -= dt;
    b.buildT -= dt;
    b.jumpT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = 0.35 + Math.random() * 0.2;
      const t = this.findTarget();
      if (t) {
        if (b.target !== t) { b.reaction = 0.35 + (1 - b.skill) * 0.5; b.tracking = 0; }
        b.target = t;
        b.targetSeen = this.time;
      } else if (b.target && this.time - b.targetSeen > 3) b.target = null;
      if (b.target && !b.target.alive) b.target = null;
    }

    // took damage? throw up a wall toward the threat
    if (this.hp + this.sh < b.lastHp - 8 && b.buildT <= 0 && b.target && this.autoMat() && Math.random() < 0.55 + b.skill * 0.3) {
      b.buildT = 2.5;
      this.faceToward(b.target.pos, dt, 100);
      this.buildType = 'w';
      g.tryPlaceBuild(this);
    }
    b.lastHp = this.hp + this.sh;

    const storm = g.storm.state;
    let outside = false;
    if (storm) {
      const dsx = this.pos.x - storm.ncx, dsz = this.pos.z - storm.ncz;
      outside = Math.hypot(dsx, dsz) > storm.nr * 0.92 && (storm.shrinking || storm.secs < 30);
      const dcur = Math.hypot(this.pos.x - storm.cx, this.pos.z - storm.cz);
      if (dcur > storm.r - 5) outside = true;
    }

    if (b.target && !outside) {
      this.fight(dt);
    } else {
      b.target = outside ? null : b.target;
      this.travel(dt, outside);
    }

    // stuck detection
    b.stuckT += dt;
    if (b.stuckT > 1) {
      const moved = b.lastPos.distanceTo(this.pos);
      if ((ctl.mx || ctl.my) && moved < 0.6) {
        ctl.jump = true;
        b.avoid = Math.random() < 0.5 ? 1 : -1;
        b.avoidT = 1.2;
        if (moved < 0.2 && Math.random() < 0.3) this.pickGoal();
      }
      b.lastPos.copy(this.pos);
      b.stuckT = 0;
    }
  }

  travel(dt, urgent) {
    const b = this.brain;
    const ctl = this.ctl;
    const g = this.game;
    // heal up when safe
    const hs = this.healSlot();
    if (hs > 0 && !urgent) {
      if (this.inv.sel !== hs) this.select(hs);
      ctl.fire = true;
      return;
    }
    // look for loot
    let dest = null;
    if (!urgent) {
      const want = (it) => {
        if (!this.canAutoPick(it.item)) return false;
        if (WEAPONS[it.item.k]) return true;
        if (HEALS[it.item.k]) return true;
        return false;
      };
      const l = g.loot.nearest(this.pos, this.hasGun() ? 22 : 45, want);
      if (l) {
        dest = _v.set(l.x, l.y, l.z);
        if (Math.hypot(l.x - this.pos.x, l.z - this.pos.z) < 1.8) g.botPick(this, l);
      } else {
        const chest = g.nearestChest(this.pos, this.hasGun() ? 15 : 30);
        if (chest) {
          dest = _v.set(chest.x, chest.y, chest.z);
          if (chest.dist < 2.2) g.openChest(this, chest.i);
        }
      }
      // harvest a bit of wood when we have nothing to build with
      if (!dest && this.inv.mats.wood < 40 && b.harvest === null && Math.random() < 0.02) {
        b.harvest = g.nearestTree(this.pos, 18);
      }
      if (!dest && b.harvest !== null) {
        const o = g.world.objs[b.harvest];
        if (!o || !o.alive || this.inv.mats.wood >= 60) b.harvest = null;
        else {
          dest = _v.set(o.o.x, o.o.y, o.o.z);
          if (Math.hypot(o.o.x - this.pos.x, o.o.z - this.pos.z) < 2.2) {
            if (this.inv.sel !== 0) this.select(0);
            this.faceToward(_v.set(o.o.x, this.pos.y + 1.2, o.o.z), dt, 8);
            ctl.fire = true;
            return;
          }
        }
      }
    }
    if (!dest) {
      if (!b.goal || b.goalT <= 0 || Math.hypot(b.goal.x - this.pos.x, b.goal.z - this.pos.z) < 4 || urgent) {
        if (!b.goal || b.goalT <= 0 || !urgent || Math.random() < 0.02) this.pickGoal();
        if (urgent && g.storm.state) b.goal = new THREE.Vector3(g.storm.state.ncx, 0, g.storm.state.ncz);
      }
      dest = b.goal;
    }
    // switch away from heals while travelling
    const cur = this.current();
    if (cur && HEALS[cur.k]) this.select(0);
    this.walkTo(dest, dt, urgent);
  }

  walkTo(dest, dt, sprint) {
    const b = this.brain;
    const ctl = this.ctl;
    _d.set(dest.x - this.pos.x, 0, dest.z - this.pos.z);
    if (_d.lengthSq() < 0.25) return;
    let yawT = Math.atan2(-_d.x, -_d.z);
    // obstacle avoidance: probe ahead
    if (b.avoidT > 0) {
      b.avoidT -= dt;
      yawT += b.avoid * 0.9;
    } else {
      const f = forwardFromAngles(yawT, 0, _e);
      const h = this.game.physics.raycast(this.pos.x, this.pos.y + 0.8, this.pos.z, f.x, 0, f.z, 2.2, RAY_STATIC);
      if (h && h.ny < 0.5) {
        b.avoid = Math.random() < 0.5 ? 1 : -1;
        b.avoidT = 0.8;
      }
    }
    this.turnTo(yawT, 0, dt, 5);
    ctl.my = 1;
    ctl.sprint = sprint || _d.length() > 25;
  }

  fight(dt) {
    const b = this.brain;
    const ctl = this.ctl;
    const t = b.target;
    const dist = t.pos.distanceTo(this.pos);
    // weapon choice
    if (!this.hasGun()) {
      // no gun: run away to find loot, or pickaxe if they're in our face
      if (dist < 3) {
        if (this.inv.sel !== 0) this.select(0);
        this.faceToward(_v.set(t.pos.x, t.pos.y + 1.2, t.pos.z), dt, 10);
        ctl.fire = true;
        ctl.my = 1;
      } else this.travel(dt, false);
      return;
    }
    const slot = this.bestWeaponFor(dist);
    if (slot > 0 && slot !== this.inv.sel && this.reloadT < 0) this.select(slot);
    const cur = this.current();
    const w = cur && WEAPONS[cur.k];
    if (!w) return;
    if (cur.m <= 0 && this.reloadT < 0) ctl.reload = true;

    // aim with lead + human-like error that shrinks while tracking
    b.tracking += dt;
    const speed = w.speed || 300;
    const tt = dist / speed;
    const tv = t.vel || t.mover?.vel || _e.set(0, 0, 0);
    const crouch = t.crouching;
    _v.set(t.pos.x + (tv.x || 0) * tt, t.pos.y + (crouch ? 0.9 : 1.2) + (tv.y || 0) * tt * 0.3, t.pos.z + (tv.z || 0) * tt);
    if (w.grav) _v.y += 0.5 * 9.81 * w.grav * tt * tt;
    const errMag = (0.25 + dist * 0.018) * (1.6 - b.skill) * Math.max(0.35, 1.4 - b.tracking * 0.5);
    if (Math.random() < dt * 3) {
      b.errX = (Math.random() - 0.5) * 2 * errMag;
      b.errY = (Math.random() - 0.5) * 1.4 * errMag;
      b.errZ = (Math.random() - 0.5) * 2 * errMag;
    }
    _v.x += b.errX; _v.y += b.errY; _v.z += b.errZ;
    const aligned = this.faceToward(_v, dt, 4 + b.skill * 5);
    this.aim.tx = _v.x; this.aim.ty = _v.y; this.aim.tz = _v.z;

    b.reaction -= dt;
    const range = PREF_RANGE[cur.k] || [0, 80];
    ctl.ads = dist > 15 && cur.k !== 'shotgun';
    if (b.reaction <= 0 && aligned < 0.12 && dist < range[1] * 1.6) {
      ctl.fire = true;
      ctl.firePressed = true;
    }
    // movement: keep preferred distance, strafe, hop
    if (b.strafeT <= 0) { b.strafe = Math.random() < 0.5 ? -1 : 1; b.strafeT = 0.6 + Math.random() * 1.2; }
    ctl.mx = b.strafe * (ctl.ads ? 0.6 : 1);
    if (dist > range[1]) ctl.my = 1;
    else if (dist < range[0]) ctl.my = -1;
    else ctl.my = cur.k === 'shotgun' ? 0.7 : 0;
    if (b.jumpT <= 0 && Math.random() < 0.15 * b.skill) { ctl.jump = true; b.jumpT = 1.5; }
    if (dist > 30 && Math.random() < 0.002) ctl.crouch = true;
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

  update(dt) {
    this.think(dt);
    this.move(dt, this.ctl);
    // view ray for melee/fire
    const a = this.aim;
    const s = this.shoulder(_v);
    forwardFromAngles(this.yaw, this.pitch, _d);
    a.ox = s.x; a.oy = s.y; a.oz = s.z; a.dx = _d.x; a.dy = _d.y; a.dz = _d.z;
    if (!this.ctl.fire || !this.brain.target) { a.tx = s.x + _d.x * 100; a.ty = s.y + _d.y * 100; a.tz = s.z + _d.z * 100; }
    this.act(dt, this.ctl, a);
    this.animate(dt);
  }
}
