// Kinematic character movement on top of Rapier's character controller.
// Shared by the local player and the bots.
import * as THREE from 'three';
import { PLAYER } from '../../shared/constants.js';
import { GROUP, MOVE_FILTER, RAY_STATIC, RAY_SOLID } from '../physics.js';

const HH = PLAYER.halfHeight, RAD = PLAYER.radius;
const CENTER = HH + RAD; // capsule centre above the feet
const WATER_FEET = -1.15;

export class Mover {
  constructor(physics, member = GROUP.PLAYER) {
    this.physics = physics;
    const R = physics.R;
    this.collider = physics.collider(R.ColliderDesc.capsule(HH, RAD).setTranslation(0, 200, 0), { kind: 'actor', mover: this }, undefined, member);
    const cc = physics.world.createCharacterController(0.04);
    cc.setUp({ x: 0, y: 1, z: 0 });
    cc.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    cc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    cc.enableAutostep(0.55, 0.2, true);
    cc.enableSnapToGround(0.45);
    cc.setApplyImpulsesToDynamicBodies(true);
    cc.setCharacterMass(70);
    cc.setSlideEnabled(true);
    this.cc = cc;
    this.pos = new THREE.Vector3(0, 200, 0);   // feet
    this.vel = new THREE.Vector3();
    this.mode = 'air';
    this.grounded = false;
    this.groundInfo = null;
    this.heightAboveGround = 0;
    this.crouch = false;
    this.lastGroundY = 0;
    this.airTime = 0;
    // mode mutators (rules.speed / gravity / jump): multipliers on running speed, gravity and jump
    this.mods = { speed: 1, gravity: 1, jump: 1 };
    this.launched = false; // thrown into the air by launch() and not landed yet
    this.glideAny = false; // glider redeploy whenever falling from high up (sky-spawn modes)
    this.redeployT = 0;
    this._desired = { x: 0, y: 0, z: 0 };
    this.predicate = (c) => c.handle !== this.collider.handle;
  }

  teleport(x, y, z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.collider.setTranslation({ x, y: y + CENTER, z });
  }

  setEnabled(on) {
    this.collider.setEnabled(on);
  }

  remove() {
    this.physics.removeCollider(this.collider);
    this.physics.world.removeCharacterController(this.cc);
  }

  /** Throw the character (launch pads, geysers): this velocity, in the air. */
  launch(vx, vy, vz) {
    if (this.mode === 'bus' || this.mode === 'dead') return;
    this.vel.set(vx, vy, vz);
    this.mode = 'air';
    this.grounded = false;
    this.airTime = 0;
    this.launched = true;
  }

  /**
   * ctl: { wx, wz (desired world dir * 0..1), sprint, crouch, jump, ads, pitch }
   * Returns events { landed: impactSpeed|0, jumped, splash }.
   */
  step(dt, ctl) {
    const ev = { landed: 0, jumped: false, splash: false };
    const v = this.vel;
    const mode = this.mode;
    if (mode === 'bus' || mode === 'dead') return ev;

    // glider redeploy: falling from high up after a launch (pads) or in sky-spawn modes opens the
    // glider again (checked a few times a second while falling)
    if (mode === 'air' && (this.launched || this.glideAny) && v.y < -2) {
      this.redeployT -= dt;
      if (this.redeployT <= 0) {
        this.redeployT = 0.15;
        const h = this.physics.raycast(this.pos.x, this.pos.y, this.pos.z, 0, -1, 0, 600, RAY_STATIC);
        this.heightAboveGround = h ? h.dist : Math.max(0, this.pos.y);
        if (this.heightAboveGround > 15) this.mode = 'glide';
      }
    } else this.redeployT = 0;

    // height above the ground (for glider deploy)
    if (this.mode === 'skydive' || this.mode === 'glide') {
      const h = this.physics.raycast(this.pos.x, this.pos.y, this.pos.z, 0, -1, 0, 600, RAY_STATIC);
      this.heightAboveGround = h ? h.dist : Math.max(0, this.pos.y);
      if (mode === 'skydive' && this.heightAboveGround < PLAYER.glideHeight) this.mode = 'glide';
    }

    const inWater = this.pos.y < WATER_FEET + 0.05;
    if (inWater && (this.mode === 'air' || this.mode === 'ground' || this.mode === 'glide')) {
      if (this.mode !== 'swim') ev.splash = true;
      this.mode = 'swim';
    }

    if (this.mode === 'skydive') {
      const dive = ctl.pitch < -0.5 && (ctl.wx || ctl.wz) ? 1 : 0;
      const targetVy = -(dive ? PLAYER.skydiveDive : PLAYER.skydiveFall);
      v.y += (targetVy - v.y) * Math.min(1, dt * 1.5);
      const hs = PLAYER.skydiveSpeed * (dive ? 1.15 : 1);
      v.x += (ctl.wx * hs - v.x) * Math.min(1, dt * 1.6);
      v.z += (ctl.wz * hs - v.z) * Math.min(1, dt * 1.6);
    } else if (this.mode === 'glide') {
      const dive = ctl.pitch < -0.45 && (ctl.wx || ctl.wz) ? 1 : 0;
      const targetVy = -(PLAYER.glideFall + dive * 5);
      v.y += (targetVy - v.y) * Math.min(1, dt * 2.5);
      const hs = PLAYER.glideSpeed * (dive ? 1.25 : 1);
      v.x += (ctl.wx * hs - v.x) * Math.min(1, dt * 1.4);
      v.z += (ctl.wz * hs - v.z) * Math.min(1, dt * 1.4);
    } else if (this.mode === 'swim') {
      const target = WATER_FEET;
      v.y += ((target - this.pos.y) * 4 - v.y) * Math.min(1, dt * 5);
      const sp = 3.6 * this.mods.speed;
      v.x += (ctl.wx * sp - v.x) * Math.min(1, dt * 4);
      v.z += (ctl.wz * sp - v.z) * Math.min(1, dt * 4);
      if (ctl.jump && this.pos.y > WATER_FEET - 0.3) { v.y = 5; }
    } else {
      this.crouch = !!ctl.crouch && this.grounded;
      let speed = PLAYER.run;
      if (this.crouch) speed = PLAYER.crouch;
      else if (ctl.ads) speed = PLAYER.ads;
      else if (ctl.sprint) speed = PLAYER.sprint;
      speed *= this.mods.speed;
      const tx = ctl.wx * speed, tz = ctl.wz * speed;
      const accel = this.grounded ? 70 : 14;
      const dx = tx - v.x, dz = tz - v.z;
      const dl = Math.hypot(dx, dz);
      const maxDv = accel * dt;
      if (dl > maxDv) { v.x += (dx / dl) * maxDv; v.z += (dz / dl) * maxDv; } else { v.x = tx; v.z = tz; }
      if (ctl.jump && this.grounded) {
        v.y = PLAYER.jump * this.mods.jump;
        this.grounded = false;
        this.mode = 'air';
        ev.jumped = true;
      }
      v.y -= PLAYER.gravity * this.mods.gravity * dt;
      if (v.y < -60) v.y = -60;
    }

    const d = this._desired;
    d.x = v.x * dt; d.y = v.y * dt; d.z = v.z * dt;
    this.cc.computeColliderMovement(this.collider, d, this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS, MOVE_FILTER, this.predicate);
    const m = this.cc.computedMovement();
    const wasGrounded = this.grounded;
    const fallSpeed = -v.y;
    this.pos.x += m.x; this.pos.y += m.y; this.pos.z += m.z;
    this.collider.setTranslation({ x: this.pos.x, y: this.pos.y + CENTER, z: this.pos.z });
    const grounded = this.cc.computedGrounded();

    // ceiling bump
    if (d.y > 0 && m.y < d.y * 0.5) v.y = Math.min(v.y, 0);
    // blocked horizontally -> kill velocity into the wall
    if (dt > 0) {
      const ax = m.x / dt, az = m.z / dt;
      if (Math.abs(ax) < Math.abs(v.x) * 0.5) v.x = ax;
      if (Math.abs(az) < Math.abs(v.z) * 0.5) v.z = az;
    }

    if (grounded && v.y <= 0.01) {
      if (this.mode === 'air' || this.mode === 'skydive' || this.mode === 'glide' || this.mode === 'swim') {
        if (this.mode !== 'swim' || this.pos.y > WATER_FEET + 0.25) {
          ev.landed = this.mode === 'air' ? Math.max(0.01, fallSpeed) : 0.01;
          this.mode = 'ground';
        }
      }
      if (this.mode === 'ground') { v.y = -2; this.launched = false; }
      this.airTime = 0;
      this.lastGroundY = this.pos.y;
    } else if (this.mode === 'ground') {
      this.airTime += dt;
      if (this.airTime > 0.12) this.mode = 'air';
    }
    this.grounded = grounded && this.mode === 'ground';
    if (!wasGrounded && this.grounded && ev.landed === 0) ev.landed = 0.01;

    // what are we standing on?
    if (this.grounded) {
      const h = this.physics.raycast(this.pos.x, this.pos.y + 0.3, this.pos.z, 0, -1, 0, 0.8, RAY_SOLID);
      this.groundInfo = h ? h.info : null;
    } else this.groundInfo = null;
    return ev;
  }
}
