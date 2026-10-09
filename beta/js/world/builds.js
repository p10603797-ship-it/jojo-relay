// Player building: walls, floors, ramps and cones on a 4 m grid, rendered with instancing.
// Edited walls and floors (doors, windows, holes…) draw from one instanced mesh per (type,
// material, edit mask), made lazily from the tiles the piece keeps; each kept tile has its own
// collider, so you walk through a door and shoot through a window.
import * as THREE from 'three';
import { BUILD } from '../../shared/constants.js';
import {
  BuildGrid, parseKey, pieceKey, piecePose, editBoxes, EDIT_FULL, CONE_RISE,
} from '../../shared/buildgrid.js';
import { GROUP } from '../physics.js';

const C = BUILD.cell, L = BUILD.level;
const RAMP_LEN = Math.hypot(C, L);
const TYPES = ['w', 'f', 'r', 'c'];
const MATS = ['wood', 'stone', 'metal'];
const CAP = BUILD.maxPieces;
const EDIT_CAP0 = 24; // first capacity of an edited-shape mesh (it doubles when full)

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _o = new THREE.Vector3();
const _qx = new THREE.Quaternion(), _qy = new THREE.Quaternion();

/** A square pyramid: base C x C at y = 0, apex CONE_RISE up, flat-shaded, closed underneath. */
function coneGeometry() {
  const h = C / 2, r = CONE_RISE;
  const A = [-h, 0, h], B = [h, 0, h], Cc = [h, 0, -h], D = [-h, 0, -h], P = [0, r, 0];
  const pos = [], uv = [];
  const tri = (a, b, c, ua, ub, uc) => { pos.push(...a, ...b, ...c); uv.push(...ua, ...ub, ...uc); };
  // four sloped faces (counter-clockwise seen from outside), planks running along the eave
  for (const [a, b] of [[A, B], [B, Cc], [Cc, D], [D, A]]) tri(a, b, P, [0, 0], [1, 0], [0.5, 1]);
  // the underside, seen from inside the box below
  tri(A, D, Cc, [0, 0], [0, 1], [1, 1]);
  tri(A, Cc, B, [0, 0], [1, 1], [1, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function geometryFor(t) {
  if (t === 'w') return new THREE.BoxGeometry(C, L, 0.2);
  if (t === 'f') return new THREE.BoxGeometry(C, 0.2, C);
  if (t === 'c') return coneGeometry();
  return new THREE.BoxGeometry(C, 0.2, RAMP_LEN);
}

/**
 * The kept tiles of an edited piece merged into one geometry. UVs are planar in the piece's frame
 * (same scale as the full piece), so the texture runs on across the tiles.
 */
function editedGeometry(t, e) {
  const boxes = editBoxes(t, e) || [];
  const pos = [], nor = [], uv = [], idx = [];
  for (const [cx, cy, cz, hx, hy, hz] of boxes) {
    const g = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    const p = g.attributes.position, n = g.attributes.normal;
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + cx, y = p.getY(i) + cy, z = p.getZ(i) + cz;
      const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
      pos.push(x, y, z);
      nor.push(nx, ny, nz);
      if (Math.abs(nz) > 0.5) uv.push(x / C + 0.5, y / L + 0.5);
      else if (Math.abs(nx) > 0.5) uv.push(z / C + 0.5, y / L + 0.5);
      else uv.push(x / C + 0.5, z / C + 0.5);
    }
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx.push(gi[i] + base);
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Orientation for a piece description. */
export function pieceQuat(p, out) {
  if (p.t === 'w') return out.setFromAxisAngle(_v.set(0, 1, 0), p.o === 'z' ? Math.PI / 2 : 0);
  if (p.t === 'f' || p.t === 'c') return out.identity();
  _qy.setFromAxisAngle(_v.set(0, 1, 0), (p.d | 0) * Math.PI / 2);
  _qx.setFromAxisAngle(_v.set(1, 0, 0), -Math.atan2(L, C));
  return out.copy(_qy).multiply(_qx);
}

/** Mark one instance's matrix + colour for upload (only that slice goes to the GPU). */
function touch(mesh, i) {
  mesh.instanceMatrix.addUpdateRange(i * 16, 16);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.addUpdateRange(i * 3, 3);
  mesh.instanceColor.needsUpdate = true;
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
    // meshes['wwood'] = full walls in wood; meshes['wwood:493'] = wood walls with a door, …
    this.meshes = {};
    for (const t of TYPES) for (const m of MATS) this.makeMesh(`${t}${m}`, this.geos[t], this.mats[m], CAP);
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

  /** An instanced mesh for one (type, material[, edit]) shape. Hidden while it has no instances. */
  makeMesh(key, geo, mat, cap) {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.owners = [];
    mesh.userData.key = key;
    this.scene.add(mesh);
    this.meshes[key] = mesh;
    return mesh;
  }

  /** The mesh a piece draws from (created on first use for an edit shape). */
  meshFor(p) {
    if (p.e === undefined) return this.meshes[p.t + p.m];
    const key = `${p.t}${p.m}:${p.e}`;
    let mesh = this.meshes[key];
    if (!mesh) {
      const gk = `${p.t}:${p.e}`;
      if (!this.geos[gk]) this.geos[gk] = editedGeometry(p.t, p.e);
      mesh = this.makeMesh(key, this.geos[gk], this.mats[p.m], EDIT_CAP0);
    }
    return mesh;
  }

  /** Edit meshes start small: move everything into one twice the size. */
  grow(mesh) {
    const key = mesh.userData.key;
    const cap = mesh.instanceMatrix.count * 2;
    const big = this.makeMesh(key, mesh.geometry, mesh.material, cap);
    big.instanceMatrix.array.set(mesh.instanceMatrix.array);
    big.instanceColor.array.set(mesh.instanceColor.array);
    big.count = mesh.count;
    big.visible = big.count > 0;
    big.userData.owners = mesh.userData.owners;
    for (let i = 0; i < big.count; i++) {
      const p = this.pieces.get(big.userData.owners[i]);
      if (p) p.mesh = big;
    }
    this.scene.remove(mesh);
    mesh.dispose();
    return big;
  }

  /** Put a piece into its mesh (by its type, material and edit). */
  link(p) {
    let mesh = this.meshFor(p);
    if (mesh.count >= mesh.instanceMatrix.count) {
      if (p.e === undefined) return false;
      mesh = this.grow(mesh);
    }
    p.mesh = mesh;
    p.index = mesh.count++;
    mesh.userData.owners[p.index] = p.k;
    mesh.visible = true;
    return true;
  }

  /** Take a piece out of its mesh (the last instance moves into its slot). */
  unlink(p) {
    const mesh = p.mesh;
    if (!mesh) return;
    const last = mesh.count - 1;
    if (p.index !== last) {
      const lk = mesh.userData.owners[last];
      const lp = this.pieces.get(lk);
      mesh.getMatrixAt(last, _m);
      mesh.setMatrixAt(p.index, _m);
      mesh.instanceColor.setXYZ(p.index, mesh.instanceColor.getX(last), mesh.instanceColor.getY(last), mesh.instanceColor.getZ(last));
      mesh.userData.owners[p.index] = lk;
      if (lp) lp.index = p.index;
      touch(mesh, p.index);
    }
    mesh.userData.owners.length = last;
    mesh.count = last;
    mesh.visible = last > 0;
    p.mesh = null;
  }

  /** Colliders: one box per kept tile of an edited piece, else the piece's own shape. */
  makeColliders(p) {
    const R = this.physics.R;
    const info = { kind: 'build', key: p.k, mat: p.m };
    const rot = { x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w };
    p.colliders = [];
    const add = (desc) => {
      desc.setFriction(0.9);
      p.colliders.push(this.physics.collider(desc, info, undefined, GROUP.BUILD));
    };
    const boxes = editBoxes(p.t, p.e);
    if (boxes) {
      for (const [cx, cy, cz, hx, hy, hz] of boxes) {
        _o.set(cx, cy, cz).applyQuaternion(p.quat).add(p.pos);
        add(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(_o.x, _o.y, _o.z).setRotation(rot));
      }
    } else if (p.t === 'c') {
      const h = C / 2;
      const hull = R.ColliderDesc.convexHull(new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h, 0, CONE_RISE, 0]));
      if (hull) add(hull.setTranslation(p.pos.x, p.pos.y, p.pos.z));
      else add(R.ColliderDesc.cuboid(h, CONE_RISE / 2, h).setTranslation(p.pos.x, p.pos.y + CONE_RISE / 2, p.pos.z));
    } else {
      let desc;
      if (p.t === 'w') desc = R.ColliderDesc.cuboid(C / 2, L / 2, 0.1);
      else if (p.t === 'f') desc = R.ColliderDesc.cuboid(C / 2, 0.1, C / 2);
      else desc = R.ColliderDesc.cuboid(C / 2, 0.1, RAMP_LEN / 2);
      add(desc.setTranslation(p.pos.x, p.pos.y, p.pos.z).setRotation(rot));
    }
    p.collider = p.colliders[0] || null;
  }

  removeColliders(p) {
    if (p.colliders) for (const c of p.colliders) this.physics.removeCollider(c);
    p.colliders = [];
    p.collider = null;
  }

  /** Physics/collider info lookup for raycasts. */
  pieceFromInfo(info) { return info && info.kind === 'build' ? this.pieces.get(info.key) : null; }

  has(k) { return this.pieces.has(k); }

  add(msg, local = false) {
    const existing = this.pieces.get(msg.k);
    if (existing) {
      const same = existing.m === (msg.m || existing.m) && (existing.d | 0) === (msg.d | 0) && (!msg.by || !existing.by || existing.by === msg.by);
      if (same) {
        existing.pending = false;
        existing.by = msg.by || existing.by;
        if (msg.hp !== undefined) { existing.hp = msg.hp; existing.max = msg.max; }
        if (!local) this.setEdit(msg.k, msg.e);
        return existing;
      }
      this.remove(msg.k, false);
    }
    const p = parseKey(msg.k);
    if (!p) return null;
    p.k = msg.k;
    p.d = msg.d | 0;
    p.m = MATS.includes(msg.m) ? msg.m : 'wood';
    p.e = Number.isInteger(msg.e) && editBoxes(p.t, msg.e) ? msg.e : undefined;
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
    p.mesh = null;
    if (!this.link(p)) return null;
    this.makeColliders(p);
    this.pieces.set(p.k, p);
    this.grid.add(p);
    this.growing.add(p);
    this.writeInstance(p);
    return p;
  }

  /**
   * Change a piece's edit mask (undefined or the full mask = no edit). Swaps its instance into the
   * right mesh and its colliders to the kept tiles. Returns true when something changed.
   */
  setEdit(k, e) {
    const p = this.pieces.get(k);
    if (!p || EDIT_FULL[p.t] === undefined) return false;
    const ne = Number.isInteger(e) && editBoxes(p.t, e) ? e : undefined;
    if (p.e === ne) return false;
    this.unlink(p);
    p.e = ne;
    this.link(p);
    this.removeColliders(p);
    this.makeColliders(p);
    this.writeInstance(p);
    if (this.fx) this.fx.decals.removeKey(k); // bullet holes would float in the new gaps
    return true;
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
    touch(p.mesh, p.index);
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
    this.removeColliders(p);
    this.unlink(p);
    if (this.fx) this.fx.decals.removeKey(k);
    if (fx) this.shatter(p, push);
    return p;
  }

  /** Break effect for a removed piece (can be played later than the removal). */
  shatter(p, push) {
    if (!this.fx) return;
    const he = p.t === 'w' ? [C / 2, L / 2, 0.1] : p.t === 'f' ? [C / 2, 0.1, C / 2] : p.t === 'c' ? [C / 2, CONE_RISE / 2, C / 2] : [C / 2, L / 2, C / 2];
    const hx = p.t === 'w' && p.o === 'z' ? he[2] : he[0], hz = p.t === 'w' && p.o === 'z' ? he[0] : he[2];
    const y = p.t === 'c' ? p.pos.y + CONE_RISE / 2 : p.pos.y;
    this.fx.shatter(p.m, p.pos.x, y, p.pos.z, hx, he[1], hz, push?.x || 0, push?.y || 0, push?.z || 0, 8);
  }

  clear() {
    for (const k of [...this.pieces.keys()]) this.remove(k, false);
    this.grid.clear();
    // Edited shapes (one mesh and geometry per type, material and edit mask, made on first use)
    // would pile up over a long session: drop them with the pieces; meshFor makes them again.
    for (const key of Object.keys(this.meshes)) {
      if (!key.includes(':')) continue;
      const mesh = this.meshes[key];
      this.scene.remove(mesh);
      mesh.dispose();
      delete this.meshes[key];
    }
    for (const gk of Object.keys(this.geos)) {
      if (!gk.includes(':')) continue;
      this.geos[gk].dispose();
      delete this.geos[gk];
    }
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
    } else if (type === 'c') {
      // looking up: the roof over your head; otherwise the cell in front
      if (pitch > 0.55) Object.assign(p, { cx, cy: level + 1, cz });
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
    if (this.ghost && this.ghosts[this.ghost.t]) this.ghosts[this.ghost.t].visible = false;
    this.ghost = p;
    if (!p || !this.ghosts[p.t]) return;
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
