// Projectile ballistics: every bullet is a real projectile with velocity and gravity,
// integrated in sub-steps and swept against the physics world + player hitboxes.
import * as THREE from 'three';
import { RAY_SOLID } from '../physics.js';

/** Ray (normalised dir) vs sphere. Returns distance or -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : -1;
}

/** Ray (normalised dir) vs capsule segment a-b with radius r. Returns distance or -1. */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  let b = baba * rdoa - baoa * bard;
  let c = baba * oaoa - baoa * baoa - r * r * baba;
  let h = b * b - a * c;
  if (h >= 0) {
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : -1;
    const ocx = y <= 0 ? oax : ox - bx, ocy = y <= 0 ? oay : oy - by, ocz = y <= 0 ? oaz : oz - bz;
    b = dx * ocx + dy * ocy + dz * ocz;
    c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
    h = b * b - c;
    if (h > 0) {
      const t2 = -b - Math.sqrt(h);
      return t2 >= 0 ? t2 : -1;
    }
  }
  return -1;
}

const GRAVITY = 9.81;
const _o = new THREE.Vector3();

export class Ballistics {
  /**
   * hooks = {
   *   targets(ownerId) -> [{ id, head:[x,y,z,r], body:[ax,ay,az,bx,by,bz,r] }],
   *   onHit(bullet, hit) where hit = { kind:'player', id, head, x,y,z, dist } | { kind:'world', x,y,z,nx,ny,nz, info, dist }
   *   onExpire(bullet)
   * }
   */
  constructor(physics, effects, hooks) {
    this.physics = physics;
    this.fx = effects;
    this.hooks = hooks;
    this.list = [];
    this.pool = [];
    this.rocketMeshes = [];
    this.scene = null;
  }

  setScene(scene, rocketGeo, rocketMat) {
    this.scene = scene;
    this.rocketGeo = rocketGeo;
    this.rocketMat = rocketMat;
  }

  fire(b) {
    const o = this.pool.pop() || {};
    o.x = b.ox; o.y = b.oy; o.z = b.oz;
    o.vx = b.dx * b.speed; o.vy = b.dy * b.speed; o.vz = b.dz * b.speed;
    o.g = (b.grav || 0) * GRAVITY;
    o.owner = b.owner;
    o.w = b.w;
    o.r = b.r || 0;
    o.auth = !!b.auth;
    o.rocket = !!b.rocket;
    o.shot = b.shot || 0;
    o.dist = 0;
    o.life = 0;
    o.maxLife = b.rocket ? 6 : 2.2;
    o.visOx = b.visX ?? b.ox; o.visOy = b.visY ?? b.oy; o.visOz = b.visZ ?? b.oz;
    o.visT = 0;
    o.tracer = b.tracer ?? 1;
    o.mesh = null;
    if (o.rocket && this.scene) {
      o.mesh = new THREE.Mesh(this.rocketGeo, this.rocketMat);
      o.mesh.position.set(o.x, o.y, o.z);
      this.scene.add(o.mesh);
    }
    this.list.push(o);
    return o;
  }

  update(dt) {
    const tr = this.fx.tracers;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      const sx = b.x, sy = b.y, sz = b.z;
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      const steps = Math.min(8, Math.max(1, Math.ceil((speed * dt) / 25)));
      const h = dt / steps;
      let done = false;
      for (let s = 0; s < steps && !done; s++) {
        const nvy = b.vy - b.g * h;
        const nx = b.x + b.vx * h, ny = b.y + (b.vy + nvy) * 0.5 * h, nz = b.z + b.vz * h;
        const ddx = nx - b.x, ddy = ny - b.y, ddz = nz - b.z;
        const len = Math.hypot(ddx, ddy, ddz);
        if (len > 1e-6) {
          const dx = ddx / len, dy = ddy / len, dz = ddz / len;
          let best = null;
          const wh = this.physics.raycast(b.x, b.y, b.z, dx, dy, dz, len, RAY_SOLID);
          if (wh) best = { kind: 'world', dist: wh.dist, x: wh.x, y: wh.y, z: wh.z, nx: wh.nx, ny: wh.ny, nz: wh.nz, info: wh.info, collider: wh.collider };
          const targets = this.hooks.targets(b.owner);
          for (const t of targets) {
            if (t.id === b.owner) continue;
            const maxD = best ? best.dist : len;
            const th = raySphere(b.x, b.y, b.z, dx, dy, dz, t.head[0], t.head[1], t.head[2], t.head[3]);
            const tb = rayCapsule(b.x, b.y, b.z, dx, dy, dz, t.body[0], t.body[1], t.body[2], t.body[3], t.body[4], t.body[5], t.body[6]);
            let hit = -1, head = false;
            if (th >= 0 && th <= maxD) { hit = th; head = true; }
            if (tb >= 0 && tb <= maxD && (hit < 0 || tb < hit - 0.05)) { hit = tb; head = false; }
            if (hit >= 0) best = { kind: 'player', id: t.id, head, dist: hit, x: b.x + dx * hit, y: b.y + dy * hit, z: b.z + dz * hit, dx, dy, dz };
          }
          // water surface
          if (!best && b.y > 0 && ny <= 0) {
            const t = b.y / (b.y - ny);
            best = { kind: 'water', dist: len * t, x: b.x + ddx * t, y: 0, z: b.z + ddz * t };
          }
          if (best) {
            b.dist += best.dist;
            b.x = best.x; b.y = best.y; b.z = best.z;
            best.travel = b.dist;
            best.dx = dx; best.dy = dy; best.dz = dz;
            this.hooks.onHit(b, best);
            done = true;
            break;
          }
          b.dist += len;
        }
        b.x = nx; b.y = ny; b.z = nz;
        b.vy = nvy;
      }
      b.life += dt;
      // visuals
      if (b.rocket) {
        if (b.mesh) {
          b.mesh.position.set(b.x, b.y, b.z);
          _o.set(b.x + b.vx, b.y + b.vy, b.z + b.vz);
          b.mesh.lookAt(_o);
        }
        this.fx.alpha.emit(b.x, b.y, b.z, (Math.random() - 0.5) * 0.6, 0.4, (Math.random() - 0.5) * 0.6, 1.4, 0.35, 1.6, 0.8, 0.8, 0.8, 0.5, -0.3, 1.5, 0.5);
        this.fx.add.emit(b.x, b.y, b.z, 0, 0, 0, 0.06, 0.6, 0.2, 1, 0.6, 0.2, 1);
      } else if (b.tracer) {
        // streak from the muzzle on the first frame, then behind the bullet
        const first = b.visT === 0;
        const ax = first ? b.visOx : sx, ay = first ? b.visOy : sy, az = first ? b.visOz : sz;
        const w = b.w === 'sniper' ? 0.05 : b.w === 'shotgun' ? 0.018 : 0.028;
        const bright = b.w === 'sniper' ? 1.4 : 1;
        tr.add(ax, ay, az, b.x, b.y, b.z, w, 1.0 * bright, 0.85 * bright, 0.55 * bright, 0.9, 0);
      }
      b.visT += dt;
      if (done || b.life > b.maxLife || b.y < -20) {
        if (!done) this.hooks.onExpire && this.hooks.onExpire(b);
        if (b.mesh) { this.scene.remove(b.mesh); b.mesh = null; }
        this.list.splice(i, 1);
        this.pool.push(b);
      }
    }
  }

  clear() {
    for (const b of this.list) if (b.mesh) this.scene.remove(b.mesh);
    this.list.length = 0;
  }
}
