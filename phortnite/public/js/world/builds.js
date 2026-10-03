// Player building: walls, floors and ramps on a 4 m grid, rendered with instancing.
import * as THREE from 'three';
import { BUILD } from '../../shared/constants.js';
import { BuildGrid, parseKey, pieceKey, piecePose } from '../../shared/buildgrid.js';
import { GROUP } from '../physics.js';

const C = BUILD.cell, L = BUILD.level;
const RAMP_LEN = Math.hypot(C, L);
const TYPES = ['w', 'f', 'r'];
const MATS = ['wood', 'stone', 'metal'];
const CAP = 700;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _qx = new THREE.Quaternion(), _qy = new THREE.Quaternion();

function geometryFor(t) {
  if (t === 'w') return new THREE.BoxGeometry(C, L, 0.2);
  if (t === 'f') return new THREE.BoxGeometry(C, 0.2, C);
  return new THREE.BoxGeometry(C, 0.2, RAMP_LEN);
}

/** Orientation for a piece description. */
export function pieceQuat(p, out) {
  if (p.t === 'w') return out.setFromAxisAngle(_v.set(0, 1, 0), p.o === 'z' ? Math.PI / 2 : 0);
  if (p.t === 'f') return out.identity();
  _qy.setFromAxisAngle(_v.set(0, 1, 0), (p.d | 0) * Math.PI / 2);
  _qx.setFromAxisAngle(_v.set(1, 0, 0), -Math.atan2(L, C));
  return out.copy(_qy).multiply(_qx);
}

export class Builds {
  constructor(scene, physics, T, data, effects) {
    this.scene = scene;
    this.physics = physics;
    this.fx = effects;
    this.grid = new BuildGrid(data.heightAt, data.solidNear);
    this.pieces = new Map();
    this.geos = Object.fromEntries(TYPES.map((t) => [t, geometryFor(t)]));
    const mk = (tex, extra = {}) => new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normal, roughness: 0.75, ...extra });
    this.mats = {
      wood: mk(T.woodBuild),
      stone: mk(T.brickBuild, { roughness: 0.9 }),
      metal: mk(T.metalBuild, { roughness: 0.42, metalness: 0.55 }),
    };
    this.meshes = {};
    for (const t of TYPES) {
      for (const m of MATS) {
        const mesh = new THREE.InstancedMesh(this.geos[t], this.mats[m], CAP);
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3);
        mesh.userData.owners = [];
        scene.add(mesh);
        this.meshes[t + m] = mesh;
      }
    }
    // ghost preview
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x55b8ff, transparent: true, opacity: 0.32, depthWrite: false });
    this.ghostEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    this.ghosts = {};
    for (const t of TYPES) {
      const g = new THREE.Mesh(this.geos[t], this.ghostMat);
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.geos[t]), this.ghostEdgeMat));
      g.visible = false;
      g.renderOrder = 30;
      scene.add(g);
      this.ghosts[t] = g;
    }
    this.ghost = null;
    this.time = 0;
    this.growing = new Set();
  }

  /** Physics/collider info lookup for raycasts. */
  pieceFromInfo(info) { return info && info.kind === 'build' ? this.pieces.get(info.key) : null; }

  has(k) { return this.pieces.has(k); }

  add(msg, local = false) {
    const existing = this.pieces.get(msg.k);
    if (existing) {
      existing.pending = false;
      if (msg.hp !== undefined) { existing.hp = msg.hp; existing.max = msg.max; }
      return existing;
    }
    const p = parseKey(msg.k);
    if (!p) return null;
    p.k = msg.k;
    p.d = msg.d | 0;
    p.m = MATS.includes(msg.m) ? msg.m : 'wood';
    const spec = BUILD.mats[p.m];
    p.max = msg.max || spec.hp;
    p.hp = msg.hp ?? spec.hp * BUILD.startFrac;
    p.age = msg.age || 0;
    p.grow = spec.grow;
    p.pending = local;
    p.by = msg.by;
    const pose = piecePose(p);
    p.pos = new THREE.Vector3(pose.x, pose.y, pose.z);
    p.quat = pieceQuat(p, new THREE.Quaternion());
    // collider
    const R = this.physics.R;
    let desc;
    if (p.t === 'w') desc = R.ColliderDesc.cuboid(C / 2, L / 2, 0.1);
    else if (p.t === 'f') desc = R.ColliderDesc.cuboid(C / 2, 0.1, C / 2);
    else desc = R.ColliderDesc.cuboid(C / 2, 0.1, RAMP_LEN / 2);
    desc.setTranslation(pose.x, pose.y, pose.z).setRotation({ x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w }).setFriction(0.9);
    p.collider = this.physics.collider(desc, { kind: 'build', key: p.k, mat: p.m }, undefined, GROUP.BUILD);
    // instance
    const mesh = this.meshes[p.t + p.m];
    if (mesh.count >= CAP) { this.physics.removeCollider(p.collider); return null; }
    p.mesh = mesh;
    p.index = mesh.count++;
    mesh.userData.owners[p.index] = p.k;
    this.pieces.set(p.k, p);
    this.grid.add(p);
    this.growing.add(p);
    this.writeInstance(p);
    return p;
  }

  writeInstance(p) {
    const t = Math.min(1, p.age / 0.18);
    const s = 0.55 + 0.45 * (1 - (1 - t) * (1 - t));
    _m.compose(p.pos, p.quat, _s.set(s, s, s));
    p.mesh.setMatrixAt(p.index, _m);
    const grow = Math.min(1, p.age / p.grow);
    const dmg = p.max ? Math.min(1, p.hp / p.max) : 1;
    const glow = 1 + (1 - grow) * 0.7;
    const k = (0.55 + 0.45 * Math.max(dmg, grow < 1 ? 1 : 0)) * glow;
    p.mesh.instanceColor.setXYZ(p.index, k * (grow < 1 ? 0.85 : 1), k * (grow < 1 ? 0.95 : 1), k * (grow < 1 ? 1.25 : 1));
    p.mesh.instanceMatrix.needsUpdate = true;
    p.mesh.instanceColor.needsUpdate = true;
  }

  setHp(k, hp, max) {
    const p = this.pieces.get(k);
    if (!p) return;
    p.hp = hp;
    if (max) p.max = max;
    this.writeInstance(p);
  }

  remove(k, fx = true, push) {
    const p = this.pieces.get(k);
    if (!p) return null;
    this.pieces.delete(k);
    this.grid.remove(k);
    this.growing.delete(p);
    this.physics.removeCollider(p.collider);
    const mesh = p.mesh;
    const last = mesh.count - 1;
    if (p.index !== last) {
      const lk = mesh.userData.owners[last];
      const lp = this.pieces.get(lk);
      mesh.getMatrixAt(last, _m);
      mesh.setMatrixAt(p.index, _m);
      mesh.instanceColor.setXYZ(p.index, mesh.instanceColor.getX(last), mesh.instanceColor.getY(last), mesh.instanceColor.getZ(last));
      mesh.userData.owners[p.index] = lk;
      if (lp) lp.index = p.index;
    }
    mesh.count = last;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    if (fx && this.fx) {
      const he = p.t === 'w' ? [C / 2, L / 2, 0.1] : p.t === 'f' ? [C / 2, 0.1, C / 2] : [C / 2, L / 2, C / 2];
      const hx = p.t === 'w' && p.o === 'z' ? he[2] : he[0], hz = p.t === 'w' && p.o === 'z' ? he[0] : he[2];
      this.fx.shatter(p.m, p.pos.x, p.pos.y, p.pos.z, hx, he[1], hz, push?.x || 0, push?.y || 0, push?.z || 0, 8);
      this.fx.decals.removeKey(k);
    }
    return p;
  }

  clear() {
    for (const k of [...this.pieces.keys()]) this.remove(k, false);
    this.grid.clear();
  }

  // ------------------------------------------------------------------ placement
  /**
   * Work out which grid slot a build would go into.
   * feet = player feet position, yaw/pitch = camera angles, onRamp = piece the player stands on (or null).
   */
  target(type, feet, yaw, pitch, onRamp) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let dir;
    if (Math.abs(fx) > Math.abs(fz)) dir = fx > 0 ? 1 : 3; else dir = fz > 0 ? 0 : 2;
    const dX = dir === 1 ? 1 : dir === 3 ? -1 : 0, dZ = dir === 0 ? 1 : dir === 2 ? -1 : 0;
    const level = Math.floor((feet.y + 0.3) / L);
    const cx = Math.floor(feet.x / C), cz = Math.floor(feet.z / C);
    const lx = feet.x / C - cx, lz = feet.z / C - cz;
    const along = dir === 0 ? lz : dir === 2 ? 1 - lz : dir === 1 ? lx : 1 - lx;
    const p = { t: type };
    if (type === 'w') {
      let wx = cx, wz = cz, o;
      if (dir === 0) { o = 'x'; wz = cz + 1; } else if (dir === 2) { o = 'x'; wz = cz; } else if (dir === 1) { o = 'z'; wx = cx + 1; } else { o = 'z'; wx = cx; }
      Object.assign(p, { cx: wx, cy: level + (pitch > 0.75 ? 1 : 0), cz: wz, o });
    } else if (type === 'f') {
      if (pitch < -0.8) Object.assign(p, { cx, cy: level, cz });
      else if (pitch > 0.55) Object.assign(p, { cx, cy: level + 1, cz });
      else Object.assign(p, { cx: cx + dX, cy: level, cz: cz + dZ });
    } else {
      let tx = cx + dX, tz = cz + dZ;
      if (along < 0.3) { tx = cx; tz = cz; }
      let ly = level;
      if (onRamp && onRamp.t === 'r' && (onRamp.d | 0) === dir && (onRamp.cx !== tx || onRamp.cz !== tz)) ly = onRamp.cy + 1;
      if (pitch > 0.8) ly += 1;
      Object.assign(p, { cx: tx, cy: ly, cz: tz, d: dir });
    }
    p.k = pieceKey(p.t, p.cx, p.cy, p.cz, p.o);
    p.d = p.d | 0;
    p.free = !this.pieces.has(p.k);
    p.supported = p.free && this.grid.canSupport(p);
    return p;
  }

  showGhost(p, ok) {
    for (const t of TYPES) this.ghosts[t].visible = false;
    this.ghost = p;
    if (!p) return;
    const g = this.ghosts[p.t];
    const pose = piecePose(p);
    g.position.set(pose.x, pose.y, pose.z);
    pieceQuat(p, g.quaternion);
    g.visible = true;
    this.ghostMat.color.setHex(ok ? 0x55b8ff : 0xff5050);
    this.ghostMat.opacity = 0.28 + Math.sin(this.time * 6) * 0.06;
  }

  update(dt) {
    this.time += dt;
    for (const p of this.growing) {
      p.age += dt;
      if (p.hp < p.max && p.age < p.grow) p.hp = Math.min(p.max, p.hp + p.max * (1 - BUILD.startFrac) / p.grow * dt);
      this.writeInstance(p);
      if (p.age >= p.grow) this.growing.delete(p);
    }
  }
}
