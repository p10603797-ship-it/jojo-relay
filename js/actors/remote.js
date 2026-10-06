// Players simulated elsewhere (other devices, or bots owned by another device):
// snapshot buffering + interpolation, animated model, kinematic collider, hitboxes.
import * as THREE from 'three';
import { ANIM, FLAG, WEAPONS, HEALS, PLAYER } from '../../shared/constants.js';
import { Character } from './character.js';
import { GROUP } from '../physics.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const INTERP_MS = 110;

const TAU = Math.PI * 2;
function wrap(a) {
  if (!Number.isFinite(a)) return 0;
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}
function lerpAngle(a, b, t) {
  return a + wrap(b - a) * t;
}

export class RemotePlayer {
  constructor(game, info) {
    this.game = game;
    this.id = info.id;
    this.name = info.name;
    this.skin = info.skin;
    this.isBot = !!info.bot;
    this.owned = false;
    this.char = new Character(info.skin, info.name, { tagColor: info.bot ? '#ffd27a' : '#ffffff' });
    game.scene.add(this.char.group);
    const R = game.physics.R;
    this.collider = game.physics.collider(R.ColliderDesc.capsule(0.52, 0.38).setTranslation(0, -500, 0), { kind: 'remote', id: this.id }, undefined, GROUP.REMOTE);
    this.buf = [];
    this.pos = new THREE.Vector3(0, -500, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.anim = ANIM.IDLE;
    this.flags = 0;
    this.weapon = 'pickaxe';
    this.rarity = 0;
    this.alive = true;
    this.hp = 100;
    this.sh = PLAYER.startShield;
    this.speed = 0;
    this.moveAngle = 0;
    this.stepAcc = 0;
    this.hasState = false;
    this.dead = false;
  }

  get crouching() { return this.anim === ANIM.CROUCH || this.anim === ANIM.CROUCH_WALK; }
  get mode() {
    switch (this.anim) {
      case ANIM.SKYDIVE: return 'skydive';
      case ANIM.GLIDE: return 'glide';
      case ANIM.BUS: return 'bus';
      case ANIM.DEAD: return 'dead';
      case ANIM.AIR: return 'air';
      default: return 'ground';
    }
  }

  push(row, now) {
    // [id, x, y, z, yaw, pitch, anim, weapon, flags, hp, sh, vx, vy, vz]
    this.buf.push({ t: now, x: row[1], y: row[2], z: row[3], yw: row[4], pt: row[5], a: row[6], w: row[7], f: row[8], vx: row[11], vy: row[12], vz: row[13] });
    if (this.buf.length > 12) this.buf.shift();
    this.hp = row[9];
    this.sh = row[10];
    if (!this.hasState) {
      this.hasState = true;
      this.pos.set(row[1], row[2], row[3]);
    }
  }

  /** Take over a bot from a snapshot (used when ownership moves). */
  latest() { return this.buf[this.buf.length - 1] || null; }

  update(dt, now) {
    const rt = now - INTERP_MS;
    const b = this.buf;
    if (!b.length) return;
    let s0 = b[0], s1 = b[0];
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= rt) { s0 = b[i]; s1 = b[Math.min(i + 1, b.length - 1)]; break; }
    }
    let x, y, z, yw, pt;
    if (s0 === s1) {
      // extrapolate a little when packets are late
      const ext = Math.min(0.2, Math.max(0, (rt - s0.t) / 1000));
      x = s0.x + s0.vx * ext; y = s0.y + s0.vy * ext; z = s0.z + s0.vz * ext; yw = s0.yw; pt = s0.pt;
    } else {
      const t = Math.min(1, Math.max(0, (rt - s0.t) / Math.max(1, s1.t - s0.t)));
      x = s0.x + (s1.x - s0.x) * t; y = s0.y + (s1.y - s0.y) * t; z = s0.z + (s1.z - s0.z) * t;
      yw = lerpAngle(s0.yw, s1.yw, t); pt = s0.pt + (s1.pt - s0.pt) * t;
    }
    const snap = s1;
    // teleports (bus drop, respawn) shouldn't be smoothed
    const jx = this.pos.x - x, jy = this.pos.y - y, jz = this.pos.z - z;
    if (jx * jx + jy * jy + jz * jz > 30 * 30) this.pos.set(x, y, z);
    const px = this.pos.x, pz = this.pos.z;
    this.pos.set(x, y, z);
    this.vel.set(snap.vx, snap.vy, snap.vz);
    const hs = dt > 0 ? Math.hypot(x - px, z - pz) / dt : 0;
    this.speed += (Math.min(hs, 12) - this.speed) * Math.min(1, dt * 10);
    this.yaw = yw;
    this.pitch = pt;
    this.anim = snap.a;
    this.flags = snap.f;
    const [wk, wr] = String(snap.w || 'pickaxe').split(':');
    this.weapon = wk === 'build' || hasOwn(WEAPONS, wk) || hasOwn(HEALS, wk) ? wk : 'pickaxe';
    this.rarity = wr ? parseInt(wr, 10) || 0 : 0;
    this.moveAngle = this.speed > 0.4 ? wrap(Math.atan2(this.vel.x, this.vel.z) - (yw + Math.PI)) : 0;

    const visible = this.anim !== ANIM.BUS && !this.dead;
    const far = this.game.isFar(this.pos);
    this.char.setVisible((visible && !far) || !!this.char.ragdoll);
    if (this.char.ragdoll) {
      this.char.update(dt, {});
      return;
    }
    this.collider.setTranslation({ x, y: visible ? y + 0.9 : -500, z });
    if (!visible || far) return;
    const c = this.char;
    c.group.position.set(x, y, z);
    c.group.rotation.y = yw + Math.PI;
    const building = this.weapon === 'build';
    const w = hasOwn(WEAPONS, this.weapon) ? WEAPONS[this.weapon] : null;
    c.setWeapon(building ? null : this.weapon, Math.max(0, Math.min(4, this.rarity)));
    c.update(dt, {
      anim: this.anim, speed: this.speed, moveAngle: this.moveAngle, pitch: pt, ads: !!(this.flags & FLAG.ADS),
      gun: !!(w && !w.melee), building, healing: !!(this.flags & FLAG.HEAL), reload: this.flags & FLAG.RELOAD ? (now % 1000) / 1000 : -1,
    });
    // footsteps
    if ((this.anim === ANIM.RUN || this.anim === ANIM.SPRINT || this.anim === ANIM.CROUCH_WALK) && this.speed > 1) {
      this.stepAcc += dt * this.speed * 0.42;
      if (this.stepAcc > 1) { this.stepAcc = 0; this.game.onStep(this); }
    }
  }

  hitbox() {
    const p = this.pos;
    const c = this.crouching;
    return {
      id: this.id,
      head: [p.x, p.y + (c ? 1.27 : 1.7), p.z, 0.22],
      body: [p.x, p.y + 0.35, p.z, p.x, p.y + (c ? 0.95 : 1.32), p.z, 0.37],
    };
  }

  shoulder(out) {
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    return out.set(this.pos.x + rx * 0.28, this.pos.y + (this.crouching ? 1.05 : 1.45), this.pos.z + rz * 0.28);
  }

  die(impulse) {
    if (this.dead) return;
    this.dead = true;
    this.alive = false;
    this.collider.setTranslation({ x: 0, y: -500, z: 0 });
    this.char.startRagdoll(this.game.physics, impulse);
  }

  revive() {
    this.dead = false;
    this.alive = true;
    this.char.endRagdoll();
    this.char.setVisible(true);
  }

  setNameVisible(v) { if (this.char.tag) this.char.tag.visible = v; }

  dispose() {
    this.game.physics.removeCollider(this.collider);
    this.char.dispose();
    this.game.scene.remove(this.char.group);
  }
}
