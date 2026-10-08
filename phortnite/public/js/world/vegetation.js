// Trees, rocks and ground decor, drawn in distance rings from one InstancedMesh per
// model-part-LOD for the whole island:
//   NEAR (up to 70 m)  full trees, casting shadows, swaying in the wind
//   MID  (up to 220 m) simpler trees, no shadows
//   FAR  (up to the fog) flat silhouette cards
// The objects live in a 32 m grid of compact records (matrix, model, alive). The rings are
// rebuilt ("rebucketed") when the camera moves 8 m, turns, or every 0.5 s; the far ring less
// often. Grid cells outside a widened view frustum are skipped, except near the player, where
// trees outside the view still cast shadows into it. Only trees close to the player are drawn
// into the shadow map (they come first in the NEAR buffers; onBeforeShadow draws just those).
// Instances shrink over the last 10 m of a ring, so LOD changes and the far edge do not pop.
// Destroyed objects are skipped.
import * as THREE from 'three';
import * as M from './models.js';
import { SPECIES, SPECIES_TYPE } from '../../shared/world/keys.js';
import { SURFACE_LAYERS } from '../gfx/textures.js';

export const RINGS = { near: 70, mid: 220, rockFar: 320, decor: 110, shadow: 46, fade: 10 };
const CELL = 32;
const LEGACY_SPECIES = ['pine', 'oak', 'palm'];
const ROCK_TINTS = { ocean: 0x9a968e, beach: 0xd8cfb8, meadow: 0xa8a49a, forest: 0x8e9286, farm: 0xb0a898, city: 0xb4b2ac, snow: 0xd6dee8, desert: 0xd9a46a, mesa: 0xc4724a, jungle: 0x7e8a70, swamp: 0x7a7a62, volcano: 0x4a4440 };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _fr = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _c = new THREE.Color();
const _fwd = new THREE.Vector3();

const tris = (g) => (g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0);

// ------------------------------------------------------------------ simpler LODs when the models have none
/**
 * Vertex clustering: snap vertices to a grid of `cell` metres, average them, drop collapsed
 * triangles. A cheap, generic way to make a mid-distance version of any model.
 */
export function decimate(geo, cell) {
  const pos = geo.attributes.position, col = geo.attributes.color, uv = geo.attributes.uv;
  const n = pos.count;
  const idx = geo.index ? geo.index.array : null;
  const map = new Map(), rep = new Int32Array(n);
  const acc = [];
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    let k = map.get(key);
    if (k === undefined) { k = acc.length; map.set(key, k); acc.push([0, 0, 0, 0, 0, 0, 0, 0, 0]); }
    const a = acc[k];
    a[0] += x; a[1] += y; a[2] += z;
    if (col) { a[3] += col.getX(i); a[4] += col.getY(i); a[5] += col.getZ(i); }
    if (uv) { a[6] += uv.getX(i); a[7] += uv.getY(i); }
    a[8]++;
    rep[i] = k;
  }
  const P = [], C = [], U = [];
  for (const a of acc) {
    P.push(a[0] / a[8], a[1] / a[8], a[2] / a[8]);
    C.push(a[3] / a[8], a[4] / a[8], a[5] / a[8]);
    U.push(a[6] / a[8], a[7] / a[8]);
  }
  const I = [];
  const seen = new Set();
  const nt = (idx ? idx.length : n) / 3;
  for (let t = 0; t < nt; t++) {
    const a = rep[idx ? idx[t * 3] : t * 3], b = rep[idx ? idx[t * 3 + 1] : t * 3 + 1], c = rep[idx ? idx[t * 3 + 2] : t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const s = [a, b, c].sort((u, v) => u - v).join(',');
    if (seen.has(s)) continue;
    seen.add(s);
    I.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

/** Two crossed silhouette cards (8 triangles, both sides) in the model's average colour. */
export function cards(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const col = geo.attributes.color;
  let r = 0, g = 0, bl = 0;
  for (let i = 0; i < col.count; i++) { r += col.getX(i); g += col.getY(i); bl += col.getZ(i); }
  r /= col.count; g /= col.count; bl /= col.count;
  const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2, y0 = Math.max(0, b.min.y), y1 = b.max.y, ym = y0 + (y1 - y0) * 0.45;
  const outline = [[-w * 0.15, y0], [-w, ym], [0, y1], [w, ym], [w * 0.15, y0]];
  const P = [], N = [], C = [], U = [];
  for (const rot of [0, Math.PI / 2]) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    for (let i = 1; i < outline.length - 1; i++) {
      const tri = [outline[0], outline[i], outline[i + 1]];
      for (const order of [[0, 1, 2], [0, 2, 1]]) {
        for (const k of order) {
          const [x, y] = tri[k];
          P.push(x * cs, y, x * sn);
          N.push(0, 1, 0);
          const shade = 0.75 + 0.35 * ((y - y0) / Math.max(0.1, y1 - y0));
          C.push(r * shade, g * shade, bl * shade);
          U.push(x / 2.5, y / 2.5);
        }
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return out;
}

/** Tree geometry at a LOD; models without real LODs get decimated / card versions. */
function treeLods(species) {
  const l0 = M.treeGeometry(species, 0);
  const l1 = M.treeGeometry(species, 1), l2 = M.treeGeometry(species, 2);
  const real = tris(l1.leaves) + tris(l1.trunk) < 0.8 * (tris(l0.leaves) + tris(l0.trunk));
  if (real) return [l0, l1, l2];
  return [l0, { trunk: decimate(l0.trunk, 0.5), leaves: decimate(l0.leaves, 1.1) }, { trunk: null, leaves: cards(l0.leaves) }];
}

// ------------------------------------------------------------------ materials
function swayMaterial(base, amp) {
  const mat = base.clone();
  const uniforms = { uTime: { value: 0 } };
  mat.userData.time = uniforms.uTime;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 tw = instanceMatrix[3].xyz;
  float sway = sin(uTime * 1.6 + tw.x * 0.21 + tw.z * 0.17) + 0.4 * sin(uTime * 2.7 + tw.x * 0.5);
  float hk = max(transformed.y - 1.5, 0.0);
  transformed.x += sway * ${amp.toFixed(3)} * hk * hk * 0.004;
  transformed.z += sway * ${(amp * 0.6).toFixed(3)} * hk * hk * 0.004;
#endif`);
  };
  mat.customProgramCacheKey = () => `sway-${amp}-${base.side}`;
  return mat;
}

function arrayMaterial(layers, layer, opts) {
  const mat = new THREE.MeshStandardMaterial(opts);
  if (!layers) return mat;
  mat.userData.textures = [layers.surfaces.albedo];
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tSurf = { value: layers.surfaces.albedo };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vAUv;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvAUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2DArray tSurf;\nvarying vec2 vAUv;')
      .replace('#include <map_fragment>', `diffuseColor.rgb *= texture(tSurf, vec3(vAUv, ${layer}.0)).rgb * 1.15;`);
  };
  mat.customProgramCacheKey = () => `array-${layer}`;
  return mat;
}

// ------------------------------------------------------------------ vegetation
export class Vegetation {
  /**
   * @param {object} world   { data, root, T, mats? }
   * @param {object} opts    { castShadow }
   */
  constructor(world, opts = {}) {
    this.world = world;
    const d = (this.data = world.data);
    this.root = new THREE.Group();
    this.root.name = 'vegetation';
    world.root.add(this.root);
    this.castShadow = opts.castShadow !== false;
    this.time = 0;
    this.far = 520;
    this.dirtyNear = true;
    this.dirtyFar = true;
    this.lastNear = new THREE.Vector3(1e9, 0, 0);
    this.lastFar = new THREE.Vector3(1e9, 0, 0);
    this.lastFwd = new THREE.Vector3();
    this.lastFarFwd = new THREE.Vector3();
    this.tNear = 0;
    this.tFar = 0;
    this.fatCam = new THREE.PerspectiveCamera();
    this.buildMaterials();
    this.buildModels();
    this.buildRecords();
    this.stats = { near: 0, mid: 0, far: 0, shadow: 0, rebuckets: 0 };
  }

  buildMaterials() {
    const T = this.world.T;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const leaves = std({ map: T.foliage.map, normalMap: T.foliage.normal, vertexColors: true, roughness: 0.88 });
    const palm = Object.assign(leaves.clone(), { side: THREE.DoubleSide });
    const bark = std({ map: T.bark.map, normalMap: T.bark.normal, roughness: 0.95, color: 0xc9b29a, vertexColors: true });
    const rockLayer = SURFACE_LAYERS.indexOf('rock');
    this.mats = {
      bark, leaves, palm,
      leavesSway: swayMaterial(leaves, 1), palmSway: swayMaterial(palm, 1.6),
      card: std({ vertexColors: true, roughness: 0.95 }),
      rock: arrayMaterial(T.layers, rockLayer, { vertexColors: true, roughness: 0.9 }),
      decor: std({ vertexColors: true, roughness: 0.8 }),
    };
  }

  /** Models: one per species / rock variant / decor type, each with parts and LOD geometries. */
  buildModels() {
    const d = this.data;
    this.models = [];
    this.modelOf = new Map();
    const add = (key, kind, parts, maxLod) => {
      const m = { key, kind, parts, maxLod, n: 0, meshes: [[], [], []], attr: [null, null, null], color: [null, null, null], counts: [0, 0, 0], shadowCount: 0 };
      this.modelOf.set(key, this.models.length);
      this.models.push(m);
      return m;
    };
    // count records per model first
    const need = new Map();
    for (const o of d.objects) {
      const k = this.keyOf(o);
      if (k) need.set(k, (need.get(k) || 0) + 1);
    }
    for (const [key, n] of need) {
      let m;
      if (key.startsWith('tree:')) {
        const sp = key.slice(5);
        const L = treeLods(sp);
        const doubleSided = sp === 'palm' || (M.SPECIES_INFO && M.SPECIES_INFO[sp] && M.SPECIES_INFO[sp].doubleSided);
        m = add(key, 'tree', [
          { lods: [L[0].trunk, L[1].trunk, L[2].trunk], mats: [this.mats.bark, this.mats.bark, this.mats.bark] },
          { lods: [L[0].leaves, L[1].leaves, L[2].leaves], mats: [doubleSided ? this.mats.palmSway : this.mats.leavesSway, doubleSided ? this.mats.palm : this.mats.leaves, this.mats.card] },
        ], 2);
        m.species = sp;
        m.lod0 = L[0];
        m.colliders = this.colliderSpec(sp);
      } else if (key.startsWith('rock:')) {
        const g = M.rockGeometry(+key.slice(5));
        m = add(key, 'rock', [{ lods: [g, decimate(g, 0.42), decimate(g, 0.95)], mats: [this.mats.rock, this.mats.rock, this.mats.rock] }], 2);
        m.lod0 = g;
      } else {
        const [type, v] = key.slice(6).split('|');
        const g = M.propGeometry ? M.propGeometry(type, +v) : null;
        if (!g) continue;
        m = add(key, 'decor', [{ lods: [g, null, null], mats: [this.mats.decor, null, null] }], 0);
      }
      m.n = n;
      this.makeMeshes(m);
    }
  }

  keyOf(o) {
    if (o.kind === 'tree') {
      const sp = o.species && Object.prototype.hasOwnProperty.call(SPECIES_TYPE, o.species) ? o.species : LEGACY_SPECIES[o.type] || 'oak';
      return `tree:${sp}`;
    }
    if (o.kind === 'rock') return `rock:${(o.type | 0) % 3}`;
    if (o.kind === 'decor') return `decor:${o.type}|${o.color | 0}`;
    return null;
  }

  /** Collider shapes of a species, in tree units ({shape, y, hh, r, walk}). */
  colliderSpec(sp) {
    if (M.SPECIES_COLLIDERS && M.SPECIES_COLLIDERS[sp]) return M.SPECIES_COLLIDERS[sp];
    const t = SPECIES_TYPE[sp] ?? 1;
    const trunk = { shape: 'cylinder', y: 2.0, hh: 2.0, r: 0.34 };
    if (t === 0) return [trunk, { shape: 'cone', y: 5.6, hh: 2.8, r: 2.2 }];
    if (t === 1) return [trunk, { shape: 'ball', y: 5.0, r: 2.25 }];
    return [trunk];
  }

  makeMeshes(m) {
    for (let lod = 0; lod <= m.maxLod; lod++) {
      let attr = null, color = null;
      for (let p = 0; p < m.parts.length; p++) {
        const part = m.parts[p];
        const g = part.lods[lod];
        if (!g || !tris(g)) { m.meshes[lod][p] = null; continue; }
        const mesh = new THREE.InstancedMesh(g, part.mats[lod], m.n);
        if (attr) mesh.instanceMatrix = attr; else { attr = mesh.instanceMatrix; attr.setUsage(THREE.DynamicDrawUsage); }
        if (m.kind === 'rock') {
          if (!color) { color = new THREE.InstancedBufferAttribute(new Float32Array(m.n * 3), 3); color.setUsage(THREE.DynamicDrawUsage); }
          mesh.instanceColor = color;
        }
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.receiveShadow = true;
        mesh.castShadow = lod === 0 && this.castShadow && m.kind !== 'decor';
        if (mesh.castShadow) {
          mesh.onBeforeShadow = () => { mesh.count = m.shadowCount; };
          mesh.onAfterShadow = () => { mesh.count = m.counts[0]; };
        }
        mesh.name = `${m.key}#${lod}`;
        this.root.add(mesh);
        m.meshes[lod][p] = mesh;
      }
      m.attr[lod] = attr;
      m.color[lod] = color;
    }
  }

  /** The 32 m grid of compact records. */
  buildRecords() {
    const d = this.data;
    const list = [];
    for (const o of d.objects) {
      const k = this.keyOf(o);
      if (k !== null && this.modelOf.has(k)) list.push(o);
    }
    const n = list.length;
    this.n = n;
    this.ids = new Int32Array(n);
    this.model = new Uint16Array(n);
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.mat = new Float32Array(n * 16);
    this.tint = new Float32Array(n * 3);
    this.dead = new Uint8Array(n);
    let maxId = 0;
    for (const o of list) if (o.id > maxId) maxId = o.id;
    this.recOf = new Int32Array(maxId + 1).fill(-1);
    const half = d.half;
    const gn = (this.gn = Math.ceil(d.size / CELL));
    const counts = new Int32Array(gn * gn + 1);
    const cellOf = new Int32Array(n);
    this.cellLo = new Float32Array(gn * gn).fill(Infinity);
    this.cellHi = new Float32Array(gn * gn).fill(-Infinity);
    for (let i = 0; i < n; i++) {
      const o = list[i];
      this.ids[i] = o.id;
      this.recOf[o.id] = i;
      this.model[i] = this.modelOf.get(this.keyOf(o));
      this.px[i] = o.x; this.pz[i] = o.z;
      const s = o.s || 1;
      _q.setFromAxisAngle(_up, o.yaw || 0);
      _m.compose(_p.set(o.x, o.y, o.z), _q, _s.set(s, s, s));
      _m.toArray(this.mat, i * 16);
      if (o.kind === 'rock') {
        const b = d.biomeAt ? d.biomeAt(o.x, o.z) : 'meadow';
        _c.setHex(ROCK_TINTS[b] || ROCK_TINTS.meadow);
        this.tint[i * 3] = _c.r * 1.25; this.tint[i * 3 + 1] = _c.g * 1.25; this.tint[i * 3 + 2] = _c.b * 1.25;
      }
      const cx = Math.min(gn - 1, Math.max(0, Math.floor((o.x + half) / CELL))), cz = Math.min(gn - 1, Math.max(0, Math.floor((o.z + half) / CELL)));
      const c = cz * gn + cx;
      cellOf[i] = c;
      counts[c + 1]++;
      const top = o.y + s * (o.kind === 'tree' ? 10 : 3);
      if (o.y - 1 < this.cellLo[c]) this.cellLo[c] = o.y - 1;
      if (top > this.cellHi[c]) this.cellHi[c] = top;
    }
    for (let c = 0; c < gn * gn; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellIds = new Int32Array(n);
    const fill = counts.slice(0, gn * gn);
    for (let i = 0; i < n; i++) this.cellIds[fill[cellOf[i]]++] = i;
  }

  // ------------------------------------------------------------------ destruction
  kill(id) {
    const r = id < this.recOf.length ? this.recOf[id] : -1;
    if (r < 0 || this.dead[r]) return;
    this.dead[r] = 1;
    this.dirtyNear = this.dirtyFar = true;
  }

  reviveAll() {
    this.dead.fill(0);
    this.dirtyNear = this.dirtyFar = true;
  }

  has(id) { return id < this.recOf.length && this.recOf[id] >= 0; }

  /** Full-detail geometry of an object's model ({ trunk, leaves } for trees). */
  geometryOf(o) {
    const m = this.models[this.modelOf.get(this.keyOf(o))];
    return m ? m.lod0 : null;
  }

  // ------------------------------------------------------------------ rings
  setFar(far) {
    if (Math.abs(far - this.far) > 30) { this.far = far; this.dirtyFar = true; }
  }

  /**
   * Rebucket when needed. camera: the render camera; focus: the point shadows centre on.
   */
  update(dt, camera, focus) {
    this.time += dt;
    const t = this.mats.leavesSway.userData.time;
    if (t) t.value = this.time;
    if (this.mats.palmSway.userData.time) this.mats.palmSway.userData.time.value = this.time;
    this.tNear += dt;
    this.tFar += dt;
    const cp = camera.position;
    camera.getWorldDirection(_fwd);
    const turned = _fwd.dot(this.lastFwd) < 0.978;    // ~12 degrees
    const nearDue = this.dirtyNear || this.tNear > 0.5 || turned || cp.distanceToSquared(this.lastNear) > 64;
    const farDue = this.dirtyFar || this.tFar > 2 || _fwd.dot(this.lastFarFwd) < 0.94 || cp.distanceToSquared(this.lastFar) > 40 * 40;
    if (!nearDue && !farDue) return false;
    this.fatFrustum(camera);
    if (nearDue) {
      this.rebucket(0, camera, focus);
      this.tNear = 0; this.dirtyNear = false;
      this.lastNear.copy(cp); this.lastFwd.copy(_fwd);
    }
    if (farDue) {
      this.rebucket(2, camera, focus);
      this.tFar = 0; this.dirtyFar = false;
      this.lastFar.copy(cp); this.lastFarFwd.copy(_fwd);
    }
    this.stats.rebuckets++;
    return true;
  }

  /** A frustum ~25 degrees wider than the camera's, so turning between rebuckets shows no gaps. */
  fatFrustum(camera) {
    const f = this.fatCam;
    f.fov = Math.min(150, camera.fov + 50);
    f.aspect = camera.aspect * 1.2;
    f.near = 0.5;
    f.far = Math.max(this.far, RINGS.mid) + 80;
    f.updateProjectionMatrix();
    camera.updateMatrixWorld();
    _pm.multiplyMatrices(f.projectionMatrix, camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm);
  }

  /**
   * which 0: the NEAR and MID rings; 2: the FAR ring. Writes every visible record's matrix into
   * its model's buffer for that ring.
   */
  rebucket(which, camera, focus) {
    const cp = camera.position;
    const models = this.models;
    const R0 = RINGS.near, R1 = RINGS.mid, R2 = Math.max(R1 + 20, this.far), FADE = RINGS.fade, S = RINGS.shadow;
    const lods = which === 0 ? [0, 1] : [2];
    for (const m of models) for (const l of lods) m.counts[l] = 0;
    const gn = this.gn, half = this.data.half;
    const rMax = which === 0 ? R1 : R2;
    const rMin = which === 0 ? 0 : R1 - FADE;
    const cx0 = Math.max(0, Math.floor((cp.x - rMax + half) / CELL)), cx1 = Math.min(gn - 1, Math.floor((cp.x + rMax + half) / CELL));
    const cz0 = Math.max(0, Math.floor((cp.z - rMax + half) / CELL)), cz1 = Math.min(gn - 1, Math.floor((cp.z + rMax + half) / CELL));
    const fx = focus ? focus.x : cp.x, fz = focus ? focus.z : cp.z;
    // NEAR: shadow casters first, the rest after (indices kept in a scratch list)
    const later = this._later || (this._later = new Int32Array(this.n));
    let nLater = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      const z0 = -half + cz * CELL;
      const dz = Math.max(z0 - cp.z, 0, cp.z - z0 - CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * gn + cx;
        const s = this.cellStart[c], e = this.cellStart[c + 1];
        if (s === e) continue;
        const x0 = -half + cx * CELL;
        const dx = Math.max(x0 - cp.x, 0, cp.x - x0 - CELL);
        const dmin = Math.sqrt(dx * dx + dz * dz);
        if (dmin > rMax) continue;
        // cells by the player may hold shadow casters even when out of view
        const sdx = Math.max(x0 - fx, 0, fx - x0 - CELL), sdz = Math.max(z0 - fz, 0, fz - z0 - CELL);
        const shadowCell = which === 0 && sdx * sdx + sdz * sdz < S * S;
        _box.min.set(x0, this.cellLo[c], z0);
        _box.max.set(x0 + CELL, this.cellHi[c], z0 + CELL);
        const inView = _fr.intersectsBox(_box);
        if (!inView && !shadowCell) continue;
        for (let k = s; k < e; k++) {
          const i = this.cellIds[k];
          if (this.dead[i]) continue;
          const m = models[this.model[i]];
          const ex = this.px[i] - cp.x, ez = this.pz[i] - cp.z;
          const d = Math.sqrt(ex * ex + ez * ez);
          let lod, scale = 1;
          if (m.kind === 'decor') {
            if (which !== 0 || d > RINGS.decor) continue;
            lod = 0;
            if (d > RINGS.decor - FADE) scale = (RINGS.decor - d) / FADE;
          } else if (d < R0) {
            if (which !== 0) continue;
            lod = 0;
            if (d > R0 - FADE) scale = 1 - 0.12 * ((d - (R0 - FADE)) / FADE);
          } else if (d < R1) {
            if (which !== 0) continue;
            lod = 1;
            if (d < R0 + FADE) scale = 0.88 + 0.12 * ((d - R0) / FADE);
            else if (d > R1 - FADE) scale = 1 - 0.12 * ((d - (R1 - FADE)) / FADE);
          } else {
            if (which !== 2) continue;
            const far = m.kind === 'rock' ? Math.min(R2, RINGS.rockFar) : R2;
            if (d > far) continue;
            lod = Math.min(2, m.maxLod);
            if (d < R1 + FADE) scale = 0.88 + 0.12 * ((d - R1) / FADE);
            else if (d > far - FADE * 3) scale = Math.max(0, (far - d) / (FADE * 3));
          }
          if (lod > m.maxLod || !m.attr[lod]) continue;
          if (!inView && lod !== 0) continue;
          if (lod === 0 && !inView) {
            // out of view: only as a shadow caster
            const qx = this.px[i] - fx, qz = this.pz[i] - fz;
            if (qx * qx + qz * qz > S * S) continue;
          }
          if (lod === 0 && m.kind !== 'decor') {
            const qx = this.px[i] - fx, qz = this.pz[i] - fz;
            if (qx * qx + qz * qz > S * S) { later[nLater++] = i; continue; }
          }
          this.put(m, lod, i, scale);
        }
      }
    }
    if (which === 0) {
      for (const m of models) m.shadowCount = m.counts[0];
      // the NEAR trees beyond the shadow radius (no shadows: after the casters)
      for (let k = 0; k < nLater; k++) {
        const i = later[k];
        const m = models[this.model[i]];
        const ex = this.px[i] - cp.x, ez = this.pz[i] - cp.z;
        const d = Math.sqrt(ex * ex + ez * ez);
        this.put(m, 0, i, d > R0 - FADE ? 1 - 0.12 * ((d - (R0 - FADE)) / FADE) : 1);
      }
    }
    // upload
    const st = this.stats;
    if (which === 0) { st.near = 0; st.mid = 0; st.shadow = 0; } else st.far = 0;
    for (const m of models) {
      for (const l of lods) {
        const attr = m.attr[l];
        if (!attr) continue;
        const n = m.counts[l];
        attr.clearUpdateRanges();
        if (n) { attr.addUpdateRange(0, n * 16); attr.needsUpdate = true; }
        const col = m.color[l];
        if (col && n) { col.clearUpdateRanges(); col.addUpdateRange(0, n * 3); col.needsUpdate = true; }
        for (const mesh of m.meshes[l]) {
          if (!mesh) continue;
          mesh.count = n;
          mesh.visible = n > 0;
        }
        if (l === 0) { st.near += n; st.shadow += m.shadowCount; } else if (l === 1) st.mid += n; else st.far += n;
      }
    }
  }

  /** Append record i to model m's buffer of ring lod, scaled by k about its foot. */
  put(m, lod, i, k) {
    const n = m.counts[lod]++;
    const dst = m.attr[lod].array, o = n * 16, src = i * 16;
    if (k >= 0.999) {
      for (let j = 0; j < 16; j++) dst[o + j] = this.mat[src + j];
    } else {
      for (let j = 0; j < 12; j++) dst[o + j] = this.mat[src + j] * (j % 4 === 3 ? 1 : k);
      dst[o + 12] = this.mat[src + 12]; dst[o + 13] = this.mat[src + 13]; dst[o + 14] = this.mat[src + 14]; dst[o + 15] = 1;
    }
    const col = m.color[lod];
    if (col) { const a = col.array; a[n * 3] = this.tint[i * 3]; a[n * 3 + 1] = this.tint[i * 3 + 1]; a[n * 3 + 2] = this.tint[i * 3 + 2]; }
  }

  setShadows(on) {
    for (const m of this.models) for (const mesh of m.meshes[0]) if (mesh && m.kind !== 'decor') mesh.castShadow = !!on && this.castShadow;
  }

  /** Instances drawn right now: { near, mid, far, shadow } (after the last rebucket). */
  counts() { return { ...this.stats }; }

  dispose() {
    for (const m of this.models) for (const l of m.meshes) for (const mesh of l) if (mesh) { mesh.dispose(); this.root.remove(mesh); }
  }
}
