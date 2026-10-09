// Builds the island scene + physics from the shared world data, and keeps the big map cheap:
//   terrain.js     LOD tiles with the biome splat, roads, the physics heightfield
//   batch.js       buildings and props in 128 m chunk batches (HLOD boxes far away)
//   vegetation.js  trees, rocks and decor in NEAR / MID / FAR rings
//   colliders.js   physics colliders only near players (compound units in 64 m chunks, streamed)
//   traversal.js   launch pads, geysers and bounce mushrooms
// The far view follows the camera's altitude: higher up, the fog (and the camera's far plane)
// reach further, so the whole island shows from the bus.
import * as THREE from 'three';
import { GROUP } from '../physics.js';
import { createSky, SUN_DIR, SKY_COLORS } from '../gfx/sky.js';
import { createWater } from '../gfx/water.js';
import { createGrass } from '../gfx/grass.js';
import { SURFACE_LAYERS, LOOK_LAYERS } from '../gfx/textures.js';
import { Batch } from './batch.js';
import { Vegetation } from './vegetation.js';
import { Terrain } from './terrain.js';
import { ColliderStreamer } from './colliders.js';
import { Traversal } from './traversal.js';
import { mapArtJob } from '../ui/mapview.js';
import * as M from './models.js';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const UNIT_CELL = 32;         // trees / rocks / props share one compound collider per 32 m cell
const FOG_NEAR = 200;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snap = new THREE.Vector3();
const _a = new THREE.Vector3();

/** The view distance the world works with: Low reaches 450 m (the old 380 m blanked the island from up high). */
export function drawDistOf(q) {
  return q && q.name === 'low' ? Math.max(450, q.drawDist || 0) : (q && q.drawDist) || 520;
}

export class World {
  constructor({ scene, physics, T, data, quality, renderer }) {
    this.scene = scene;
    this.physics = physics;
    this.T = T;
    this.data = data;
    this.quality = quality;
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);
    this.objs = new Array(data.objects.length);
    this.time = 0;
    this.falling = [];
    this.chestOpen = new Set();
    this.destroyedIds = new Set();
    this.fogFar = drawDistOf(quality);
    this.fogBoost = 0;          // eased 0..1 altitude factor
    this.seaLevel = 0;
    this.timings = {};
    const t = (name, fn) => { const t0 = performance.now(); fn(); this.timings[name] = +(performance.now() - t0).toFixed(1); };

    t('lights', () => this.buildLights());
    t('sky', () => this.buildSky());
    t('terrain', () => this.buildTerrain());
    t('materials', () => this.buildMaterials());
    t('static', () => this.buildStatic());
    t('vegetation', () => this.buildVegetation());
    t('chests', () => this.buildChests());
    t('barrels', () => this.buildBarrels());
    t('pads', () => { this.traversal = new Traversal(this); });
    t('colliders', () => this.buildColliders());
    this.requestLayers();
    // the painted map: a few rows at a time after boot (no long stall), finished at once if needed sooner
    this._mapJob = null;
    this._mapCanvas = null;
    this._mapMs = 0;
    const slice = () => {
      if (this._mapCanvas) return;
      if (!this._mapJob) this._mapJob = mapArtJob(this);
      const t0 = performance.now();
      const done = this._mapJob.step(40);
      this._mapMs += performance.now() - t0;
      if (done) { this._mapCanvas = this._mapJob.canvas; this.timings.map = +this._mapMs.toFixed(1); } else this._mapTimer = setTimeout(slice, 30);
    };
    this._mapTimer = setTimeout(slice, 800);
  }

  /** The island picture for the minimap, full map and mode creator (js/ui/mapview.js paintMapArt). */
  get mapCanvas() {
    if (!this._mapCanvas) {
      const t0 = performance.now();
      if (!this._mapJob) this._mapJob = mapArtJob(this);
      this._mapCanvas = this._mapJob.finish();
      this.timings.map = +(this._mapMs + performance.now() - t0).toFixed(1);
      if (this._mapTimer) { clearTimeout(this._mapTimer); this._mapTimer = 0; }
    }
    return this._mapCanvas;
  }

  // ------------------------------------------------------------------ lights & sky
  buildLights() {
    const q = this.quality;
    this.hemi = new THREE.HemisphereLight(0xd4ebff, 0x5c7a40, 0.85);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff0d8, 3.1);
    sun.position.copy(SUN_DIR).multiplyScalar(200);
    this.sun = sun;
    this.shadowExtent = 52;
    this.configureShadows(q);
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  configureShadows(q) {
    const sun = this.sun;
    sun.castShadow = !!q.shadows;
    if (q.shadows) {
      sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      const e = this.shadowExtent;
      const cam = sun.shadow.camera;
      cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
      cam.near = 10; cam.far = 420;
      cam.updateProjectionMatrix();
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.045;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    if (this.veg) this.veg.setShadows(!!q.shadows);
  }

  buildSky() {
    this.sky = createSky(this.T.noise.map);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(SKY_COLORS.fog, FOG_NEAR, this.fogFar);
    this.scene.background = SKY_COLORS.fog.clone();
    // image based lighting from a cloudless copy of the sky
    const envScene = new THREE.Scene();
    const envSky = createSky(this.T.noise.map, 400);
    envSky.material.uniforms.uClouds.value = 0;
    envScene.add(envSky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 16), new THREE.MeshBasicMaterial({ color: 0x4d6b38 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -20;
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(envScene, 0, 1, 1000);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    envSky.geometry.dispose();
    envSky.material.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
  }

  // ------------------------------------------------------------------ terrain, water, grass
  buildTerrain() {
    const d = this.data;
    this.terrain = new Terrain(this);
    this.root.add(this.terrain.root);
    this.terrainMat = this.terrain.mat;
    this.infoTex = this.terrain.infoTex;
    this.water = createWater(this.T.noise.normal, this.infoTex, d.half, d.cell, d.N);
    this.scene.add(this.water);
    this.grass = null;
    this.setGrass(this.quality.grass);
  }

  setGrass(side) {
    if (this.grass) {
      this.scene.remove(this.grass);
      this.grass.geometry.dispose();
      this.grass.material.dispose();
      this.grass = null;
    }
    if (side > 0) {
      const d = this.data;
      this.grass = createGrass(this.infoTex, d.half, d.cell, d.N, side, 0.5);
      this.grass.userData.setSea(this.seaLevel);
      this.scene.add(this.grass);
    }
  }

  /** Footstep / impact surface under a point (grass, dirt, sand, rock / stone, snow). */
  surfaceAt(x, z) { return this.terrain.surfaceAt(x, z); }

  /** Floor is Lava: raise the sea (y) and make it 'lava', or back to 'water'. */
  setSeaLevel(y, kind = 'water') {
    this.seaLevel = y;
    this.water.userData.setSeaLevel(y, kind);
    this.terrain.setSeaLevel(y);
    if (this.grass) this.grass.userData.setSea(y);
  }

  /** The named place (or landmark) around a point, or null. */
  regionAt(x, z) {
    const d = this.data;
    if (d.regionAt) return d.regionAt(x, z);
    let best = null, br = Infinity;
    for (const r of d.regions || d.pois || []) {
      const rr = Math.max(55, r.r || 0) * 1.1;
      const dx = r.x - x, dz = r.z - z;
      if (dx * dx + dz * dz < rr * rr && rr < br) { best = r; br = rr; }
    }
    return best;
  }

  // ------------------------------------------------------------------ materials (chests, barrels)
  buildMaterials() {
    const T = this.T;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    this.mats = {
      chestWood: std({ map: T.woodBuild.map, color: 0xf0c890, roughness: 0.7 }),
      chestGold: std({ color: 0xffc23a, metalness: 1, roughness: 0.28, emissive: 0x7a4c00, emissiveIntensity: 0.6 }),
      barrel: std({ map: T.metalBuild.map, normalMap: T.metalBuild.normal, vertexColors: true, roughness: 0.45, metalness: 0.5 }),
    };
  }

  // ------------------------------------------------------------------ buildings + props (batched)
  buildStatic() {
    const q = this.quality;
    this.batch = new Batch(this, { near: Math.min(480, Math.max(220, drawDistOf(q) * 0.55)) });
    this.staticMeshes = this.batch.build(this.data.objects);
    this.timings.batchWrite = +this.batch.writeMs.toFixed(1);
  }

  buildVegetation() {
    this.veg = new Vegetation(this, { castShadow: !!this.quality.shadows });
  }

  // ------------------------------------------------------------------ physics colliders
  /**
   * Colliders come in "units", each one Rapier compound collider: a building (all its parts), or
   * the trees and rocks, bushes, or props of a 32 m cell. Rapier's step costs about the same for a
   * compound of 50 boxes as for one box, so a whole town is a few dozen colliders. Units are
   * streamed in 64 m chunks near the people simulated or seen here (colliders.js), and a unit
   * whose member is destroyed or restored is rebuilt (once, right after the messages that did it).
   * Ray casts hitting a unit are resolved to the member they hit (physics.js calls unit.resolve),
   * so damage, harvesting and footsteps see the same { kind: 'obj', id, mat } as before.
   */
  buildColliders() {
    const d = this.data;
    const R = this.physics.R;
    this.units = [];
    this.unitOf = new Int32Array(d.objects.length).fill(-1);
    this.memberInfo = new Array(d.objects.length);
    const cells = new Map();
    const unitFor = (key, group, kind) => {
      let u = cells.get(key);
      if (!u) {
        u = { id: this.units.length, kind, group, members: [], collider: null, dirty: false, info: null };
        cells.set(key, u);
        this.units.push(u);
      }
      return u;
    };
    const cellKey = (o) => `${Math.floor((o.x + d.half) / UNIT_CELL)},${Math.floor((o.z + d.half) / UNIT_CELL)}`;
    for (const o of d.objects) {
      if (o.kind === 'decor') continue;
      let u = null;
      if (o.kind === 'part') u = unitFor(`h${o.house}`, GROUP.WORLD, 'building');
      else if (o.kind === 'prop') u = unitFor(`p${cellKey(o)}`, GROUP.WORLD, 'props');
      else if (o.kind === 'tree' || o.kind === 'rock') {
        const spec = o.kind === 'tree' ? this.treeSpec(o) : null;
        const walk = !!(spec && spec.length && spec.every((c) => c.walk));
        u = unitFor(`${walk ? 'b' : 'v'}${cellKey(o)}`, walk ? GROUP.FOLIAGE : GROUP.WORLD, walk ? 'bushes' : 'trees');
      }
      if (!u) continue;
      this.objs[o.id] = { o, alive: true, colliders: [] };
      this.unitOf[o.id] = u.id;
      u.members.push(o.id);
      this.memberInfo[o.id] = { kind: 'obj', id: o.id, mat: o.mat || (o.kind === 'tree' ? 'wood' : 'stone') };
    }
    this.streamer = new ColliderStreamer({ size: d.size, create: (id) => this.unitIn(id), remove: (id) => this.unitOut(id) });
    let shapes = 0;
    for (const u of this.units) {
      this.prepareUnit(u, R);
      shapes += u.members.length;
      this.streamer.add(u.id, u.cx, u.cz, Math.min(u.r, 120));
    }
    this.streamer.finalize();
    this.physics.streamer = this.streamer;
    this.colliderShapes = shapes;
    this.flushQueued = false;
    // focus points scratch (x, z pairs)
    this._pts = new Float64Array(128);
    this._np = 0;
  }

  treeSpec(o) {
    const m = this.veg.models[this.veg.modelOf.get(this.veg.keyOf(o))];
    return m ? m.colliders : null;
  }

  /**
   * Per member: its Rapier shapes (relative to the unit's centre) and its bounds for resolving
   * hits; per unit: centre, footprint radius, a bounds grid for big buildings, and the resolver.
   */
  prepareUnit(u, R) {
    const d = this.data;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const boxes = new Float32Array(u.members.length * 6);
    u.members.forEach((id, k) => {
      const b = this.boundsOf(d.objects[id]);
      boxes.set(b, k * 6);
      if (b[0] < x0) x0 = b[0];
      if (b[2] < z0) z0 = b[2];
      if (b[3] > x1) x1 = b[3];
      if (b[5] > z1) z1 = b[5];
    });
    u.cx = (x0 + x1) / 2; u.cz = (z0 + z1) / 2;
    u.r = Math.max(x1 - x0, z1 - z0) / 2 + 1;
    u.boxes = boxes;
    u.shapes = null; // built on first use (Rapier shape descriptions)
    u.info = { kind: 'unit', unit: u.id, mat: 'stone', resolve: (x, y, z, nx, ny, nz) => this.resolveHit(u, x, y, z, nx, ny, nz) };
    void R;
  }

  /** World bounds [x0, y0, z0, x1, y1, z1] of an object's colliders. */
  boundsOf(o) {
    if (o.bb) return o.bb;
    if (o.shape === 'prism') {
      const p = o.pts;
      let a = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 6; i++) for (let k = 0; k < 3; k++) { a[k] = Math.min(a[k], p[i * 3 + k]); a[k + 3] = Math.max(a[k + 3], p[i * 3 + k]); }
      return a;
    }
    if (o.kind === 'tree') {
      const s = o.s || 1, spec = this.treeSpec(o) || [];
      let r = 0.5, top = 2;
      for (const c of spec) { r = Math.max(r, c.r); top = Math.max(top, c.y + (c.hh || c.r)); }
      return [o.x - r * s, o.y, o.z - r * s, o.x + r * s, o.y + top * s, o.z + r * s];
    }
    if (o.kind === 'rock') {
      const s = o.s || 1;
      return [o.x - 1.5 * s, o.y - 0.4 * s, o.z - 1.5 * s, o.x + 1.5 * s, o.y + 1.1 * s, o.z + 1.5 * s];
    }
    let hx = o.hx || 0.5, hz = o.hz || 0.5;
    const hy = o.hy || 0.5;
    if (o.ax) { const e = Math.max(hx, hy, hz); return [o.x - (o.ax === 'z' ? e : hx), o.y - e, o.z - (o.ax === 'x' ? e : hz), o.x + (o.ax === 'z' ? e : hx), o.y + e, o.z + (o.ax === 'x' ? e : hz)]; }
    if (o.yaw) { const e = Math.hypot(hx, hz); hx = e; hz = e; }
    return [o.x - hx, o.y - hy, o.z - hz, o.x + hx, o.y + hy, o.z + hz];
  }

  /** The Rapier shapes of one object, relative to (ox, 0, oz): [{ shape, pos, rot }]. */
  shapesOf(o, ox, oz, R) {
    const out = [];
    const id = { x: 0, y: 0, z: 0, w: 1 };
    if (o.kind === 'tree') {
      const s = o.s || 1;
      for (const c of this.treeSpec(o) || []) {
        const shape = c.shape === 'cylinder' ? new R.Cylinder(c.hh * s, c.r * s) : c.shape === 'cone' ? new R.Cone(c.hh * s, c.r * s) : new R.Ball(c.r * s);
        out.push({ shape, pos: { x: o.x - ox, y: o.y + c.y * s, z: o.z - oz }, rot: id });
      }
      return out;
    }
    if (o.kind === 'rock') {
      const geo = this.veg.geometryOf(o);
      if (!geo) return out;
      const p = geo.attributes.position;
      _m.compose(_v.set(o.x - ox, o.y, o.z - oz), _q.setFromAxisAngle(_s.set(0, 1, 0), o.yaw || 0), _s.setScalar(o.s || 1));
      // a coarse hull is plenty (every 3rd vertex)
      const n = Math.ceil(p.count / 3);
      const pts = new Float32Array(n * 3);
      for (let i = 0, k = 0; i < p.count; i += 3, k++) {
        _v.fromBufferAttribute(p, i).applyMatrix4(_m);
        pts[k * 3] = _v.x; pts[k * 3 + 1] = _v.y; pts[k * 3 + 2] = _v.z;
      }
      out.push({ shape: new R.ConvexPolyhedron(pts, null), pos: { x: 0, y: 0, z: 0 }, rot: id });
      return out;
    }
    if (o.shape === 'prism') {
      const pts = new Float32Array(o.pts);
      for (let k = 0; k < 18; k += 3) { pts[k] -= ox; pts[k + 2] -= oz; }
      out.push({ shape: new R.ConvexPolyhedron(pts, null), pos: { x: 0, y: 0, z: 0 }, rot: id });
      return out;
    }
    let rot = id;
    if (o.ax) {
      const sn = Math.sin(o.ang / 2), cs = Math.cos(o.ang / 2);
      rot = o.ax === 'x' ? { x: sn, y: 0, z: 0, w: cs } : { x: 0, y: 0, z: sn, w: cs };
    } else if (o.yaw) rot = { x: 0, y: Math.sin(o.yaw / 2), z: 0, w: Math.cos(o.yaw / 2) };
    out.push({ shape: new R.Cuboid(Math.max(0.02, o.hx), Math.max(0.02, o.hy), Math.max(0.02, o.hz)), pos: { x: o.x - ox, y: o.y, z: o.z - oz }, rot });
    return out;
  }

  /** Build a unit's compound from its standing members (none standing: no collider). */
  buildUnit(u) {
    const R = this.physics.R;
    const d = this.data;
    if (!u.shapes) u.shapes = u.members.map((id) => this.shapesOf(d.objects[id], u.cx, u.cz, R));
    const shapes = [], pos = [], rot = [];
    for (let k = 0; k < u.members.length; k++) {
      const r = this.objs[u.members[k]];
      if (!r || !r.alive) continue;
      for (const s of u.shapes[k]) { shapes.push(s.shape); pos.push(s.pos); rot.push(s.rot); }
    }
    if (!shapes.length) return null;
    const desc = R.ColliderDesc.compound(shapes, pos, rot).setTranslation(u.cx, 0, u.cz);
    const c = this.physics.collider(desc, u.info, undefined, u.group);
    this.physics.markFresh([c], u.cx, (u.boxes[1] + u.boxes[4]) / 2, u.cz, u.r + 30);
    return c;
  }

  unitIn(id) {
    const u = this.units[id];
    if (u.collider) return 0;
    u.collider = this.buildUnit(u);
    u.dirty = false;
    return u.collider ? 1 : 0;
  }

  unitOut(id) {
    const u = this.units[id];
    if (u.collider) { this.physics.removeCollider(u.collider); u.collider = null; }
  }

  /** A member was destroyed or restored: rebuild its unit (if it has a collider now) after this message. */
  touchUnit(objId) {
    const ui = this.unitOf[objId];
    if (ui < 0) return;
    const u = this.units[ui];
    if (!u.collider) return; // rebuilt from the alive members when it streams in
    u.dirty = true;
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flushUnits());
    }
  }

  flushUnits() {
    this.flushQueued = false;
    for (const u of this.units) {
      if (!u.dirty) continue;
      u.dirty = false;
      if (!u.collider) continue;
      this.physics.removeCollider(u.collider);
      u.collider = this.buildUnit(u);
    }
  }

  /**
   * Which member of a unit a ray hit at (x, y, z) with surface normal n: the smallest standing
   * member whose bounds hold the point (stepped a little into the surface).
   */
  resolveHit(u, x, y, z, nx, ny, nz) {
    const px = x - nx * 0.03, py = y - ny * 0.03, pz = z - nz * 0.03;
    const B = u.boxes, E = 0.06;
    let best = -1, bv = Infinity;
    for (let k = 0; k < u.members.length; k++) {
      const o = k * 6;
      if (px < B[o] - E || px > B[o + 3] + E || py < B[o + 1] - E || py > B[o + 4] + E || pz < B[o + 2] - E || pz > B[o + 5] + E) continue;
      const id = u.members[k];
      const r = this.objs[id];
      if (!r || !r.alive) continue;
      const v = (B[o + 3] - B[o] + 0.1) * (B[o + 4] - B[o + 1] + 0.1) * (B[o + 5] - B[o + 2] + 0.1);
      if (v < bv) { bv = v; best = id; }
    }
    if (best >= 0) return this.memberInfo[best];
    // nothing holds the point (a rounding miss): the nearest standing member
    let bd = Infinity;
    for (let k = 0; k < u.members.length; k++) {
      const id = u.members[k];
      const r = this.objs[id];
      if (!r || !r.alive) continue;
      const o = k * 6;
      const dx = Math.max(B[o] - px, 0, px - B[o + 3]), dy = Math.max(B[o + 1] - py, 0, py - B[o + 4]), dz = Math.max(B[o + 2] - pz, 0, pz - B[o + 5]);
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bd) { bd = dd; best = id; }
    }
    return best >= 0 ? this.memberInfo[best] : { kind: 'obj', id: -1, mat: 'stone' };
  }

  // ------------------------------------------------------------------ chests & barrels
  buildChests() {
    const d = this.data;
    const R = this.physics.R;
    const closed = M.chestGeometry(), open = M.openChestGeometry();
    const n = d.chests.length;
    const mk = (geo, mat) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = n;
      this.root.add(m);
      return m;
    };
    this.chestMeshes = {
      closed: [mk(closed.wood, this.mats.chestWood), mk(closed.gold, this.mats.chestGold)],
      open: [mk(open.wood, this.mats.chestWood), mk(open.gold, this.mats.chestGold)],
    };
    this.chestMatrices = [];
    d.chests.forEach((c, i) => {
      _m.compose(_v.set(c.x, c.y, c.z), _q.setFromAxisAngle(_s.set(0, 1, 0), c.yaw), _s.setScalar(1));
      this.chestMatrices.push(_m.clone());
      const desc = R.ColliderDesc.cuboid(0.45, 0.32, 0.3).setTranslation(c.x, c.y + 0.32, c.z)
        .setRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) });
      this.physics.collider(desc, { kind: 'chest', i, mat: 'wood' }, undefined, GROUP.WORLD);
    });
    this.resetChests();
  }

  resetChests() {
    this.chestOpen.clear();
    for (let i = 0; i < this.data.chests.length; i++) this.setChestOpen(i, false, true);
    for (const m of [...this.chestMeshes.closed, ...this.chestMeshes.open]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }

  setChestOpen(i, open, bulk = false) {
    if (open) this.chestOpen.add(i); else this.chestOpen.delete(i);
    const m = this.chestMatrices[i];
    for (const mesh of this.chestMeshes.closed) { mesh.setMatrixAt(i, open ? ZERO : m); if (!bulk) mesh.instanceMatrix.needsUpdate = true; }
    for (const mesh of this.chestMeshes.open) { mesh.setMatrixAt(i, open ? m : ZERO); if (!bulk) mesh.instanceMatrix.needsUpdate = true; }
  }

  buildBarrels() {
    const d = this.data;
    const R = this.physics.R;
    const geo = M.barrelGeometry();
    this.barrelMesh = new THREE.InstancedMesh(geo, this.mats.barrel, Math.max(1, d.barrels.length));
    this.barrelMesh.castShadow = true;
    this.barrelMesh.receiveShadow = true;
    this.barrelMesh.frustumCulled = false;
    this.barrelMesh.count = d.barrels.length;
    this.root.add(this.barrelMesh);
    this.barrels = d.barrels.map((b, i) => {
      const body = this.physics.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(b.x, b.y + 0.05, b.z).setLinearDamping(0.2).setAngularDamping(0.6).setCcdEnabled(true));
      this.physics.collider(R.ColliderDesc.cylinder(0.55, 0.38).setMass(25).setFriction(0.8).setRestitution(0.25),
        { kind: 'barrel', i, mat: 'metal' }, body, GROUP.PROP);
      return { body, home: { x: b.x, y: b.y + 0.05, z: b.z } };
    });
    this.syncBarrels(true);
  }

  resetBarrels() {
    for (const b of this.barrels) {
      b.body.setTranslation(b.home, true);
      b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.syncBarrels(true);
  }

  syncBarrels(force) {
    let dirty = false;
    for (let i = 0; i < this.barrels.length; i++) {
      const b = this.barrels[i];
      if (!force && b.body.isSleeping()) continue;
      const t = b.body.translation(), r = b.body.rotation();
      if (t.y < -30) {
        b.body.setTranslation(b.home, true);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      _m.compose(_v.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.setScalar(1));
      this.barrelMesh.setMatrixAt(i, _m);
      dirty = true;
    }
    if (dirty) this.barrelMesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ object destruction
  isAlive(id) { const r = this.objs[id]; return !!(r && r.alive); }

  destroyObject(id, fromDir, quiet = false) {
    const r = this.objs[id];
    if (!r || !r.alive) return null;
    r.alive = false;
    this.destroyedIds.add(id);
    this.touchUnit(id);
    if (this.veg.has(id)) this.veg.kill(id);
    else this.batch.setVisible(id, false);
    if (r.o.kind === 'tree' && !quiet) this.spawnFallingTree(r.o, fromDir);
    return r.o;
  }

  restoreAll() {
    this.destroyedIds.clear();
    let veg = false;
    for (const r of this.objs) {
      if (!r || r.alive) continue;
      r.alive = true;
      this.touchUnit(r.o.id);
      if (this.veg.has(r.o.id)) veg = true;
      else this.batch.setVisible(r.o.id, true);
    }
    this.flushUnits();
    if (veg) this.veg.reviveAll();
    for (const f of this.falling) this.root.remove(f.group);
    this.falling.length = 0;
    this.resetChests();
    this.resetBarrels();
  }

  spawnFallingTree(o, fromDir) {
    const g = this.veg.geometryOf(o);
    if (!g) return;
    const group = new THREE.Group();
    const leavesMat = (o.species === 'palm' || o.type === 2) ? this.veg.mats.palm : this.veg.mats.leaves;
    if (g.trunk) { const trunk = new THREE.Mesh(g.trunk, this.veg.mats.bark); trunk.castShadow = true; group.add(trunk); }
    const leaves = new THREE.Mesh(g.leaves, leavesMat);
    leaves.castShadow = true;
    group.add(leaves);
    group.rotation.y = o.yaw || 0;
    group.scale.setScalar(o.s || 1);
    const pivot = new THREE.Group();
    pivot.position.set(o.x, o.y, o.z);
    pivot.add(group);
    this.root.add(pivot);
    let ax = 1, az = 0;
    if (fromDir) {
      ax = fromDir.z;
      az = -fromDir.x;
      const l = Math.hypot(ax, az) || 1;
      ax /= l; az /= l;
    }
    this.falling.push({ group: pivot, t: 0, angle: 0, vel: 0.15, axis: new THREE.Vector3(ax, 0, az), scale: o.s || 1, inner: group });
  }

  // ------------------------------------------------------------------ textures
  /** Paint the texture-array layers this island uses first, then the rest. */
  requestLayers() {
    const L = this.T.layers;
    if (!L) return;
    const surf = new Set();
    for (let i = 0; i < this.terrain.surf.length; i += 3) surf.add(SURFACE_LAYERS[this.terrain.surf[i]]);
    if (this.terrain.roads) surf.add('asphaltLines');
    surf.add('rock');
    const looks = new Set();
    for (const o of this.data.objects) if (o.kind === 'part') looks.add(o.look === 'trim' || o.look === 'foundation' || o.look === 'slab' ? 'concrete' : o.look);
    for (const k of ['planks', 'corrugated', 'panel', 'metalwall']) looks.add(k);
    L.request('surfaces', [...surf]);
    L.request('looks', [...looks].filter((k) => LOOK_LAYERS.includes(k)));
    L.requestAll();
  }

  // ------------------------------------------------------------------ far view
  /**
   * camera.far for the quality preset: the fog's end + 60 m. The fog reaches further with height
   * above the ground: drawDist x (1 + 1.5 x clamp((height - 30) / 150)), eased over a second.
   */
  farFor(q, camera) {
    void q; void camera;
    return this.fogFar + 60;
  }

  updateFog(dt, camera) {
    const d = this.data;
    const cp = camera.position;
    const ground = Math.max(d.heightAt(cp.x, cp.z), this.seaLevel);
    const k = Math.min(1, Math.max(0, (cp.y - ground - 30) / 150));
    const ease = Math.min(1, dt / 1.0);
    // eased over about a second (a jump to the bus or a respawn snaps faster)
    this.fogBoost += (k - this.fogBoost) * (Math.abs(k - this.fogBoost) > 0.6 ? 1 : ease * 3);
    const dd = drawDistOf(this.quality);
    this.fogFar = dd * (1 + 1.5 * this.fogBoost);
    const fog = this.scene.fog;
    if (fog) {
      fog.near = Math.min(FOG_NEAR * (1 + this.fogBoost * 1.5), this.fogFar * 0.6);
      fog.far = this.fogFar;
    }
    this.veg.setFar(this.fogFar);
  }

  // ------------------------------------------------------------------ per frame
  /**
   * focus: the point the player cares about (shadows centre on it). game (or null in the menu)
   * supplies the other focus points for collider streaming.
   */
  update(dt, camera, focus, game) {
    const t0 = performance.now();
    this.time += dt;
    this.sky.position.copy(camera.position);
    this.sky.material.uniforms.uTime.value = this.time;
    this.water.material.uniforms.uTime.value = this.time;
    this.updateFog(dt, camera);
    this.water.userData.follow(camera);
    if (this.grass) this.grass.userData.update(camera.position, this.time);
    if (this.sun.castShadow) {
      const e = this.shadowExtent;
      const texel = (2 * e) / this.sun.shadow.mapSize.x;
      const fwd = _v.copy(SUN_DIR).negate();
      const right = _s.crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize();
      const up = _up.crossVectors(right, fwd);
      const rr = Math.round(focus.dot(right) / texel) * texel;
      const uu = Math.round(focus.dot(up) / texel) * texel;
      const ff = focus.dot(fwd);
      const snapped = _snap.set(0, 0, 0).addScaledVector(right, rr).addScaledVector(up, uu).addScaledVector(fwd, ff);
      this.sun.target.position.copy(snapped);
      this.sun.position.copy(snapped).addScaledVector(SUN_DIR, 220);
      this.sun.target.updateMatrixWorld();
    }
    this.terrain.update(camera, dt);
    this.batch.update(camera);
    this.veg.update(dt, camera, focus);
    this.streamColliders(dt, focus, game);
    this.traversal.update(dt, camera);
    this.syncBarrels(false);
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      if (f.angle < 1.45) {
        f.vel += dt * 2.6;
        f.angle = Math.min(1.45, f.angle + f.vel * dt);
        f.group.quaternion.setFromAxisAngle(f.axis, f.angle);
      }
      if (f.t > 2.2) {
        const k = Math.max(0, 1 - (f.t - 2.2) / 0.6);
        f.inner.scale.setScalar(f.scale * k);
      }
      if (f.t > 2.8) {
        this.root.remove(f.group);
        this.falling.splice(i, 1);
      }
    }
    if (this.T.layers) this.T.layers.flush();
    this.updateMs = performance.now() - t0;
  }

  /** The focus points for collider streaming: everyone simulated or seen on this device. */
  streamColliders(dt, focus, game) {
    this._np = 0;
    if (focus) this.addPoint(focus.x, focus.z);
    if (game) {
      const me = game.me;
      if (me && me.pos && !me.inBus) this.addPoint(me.pos.x, me.pos.z);
      if (game.bots) for (const b of game.bots.values()) if (b.alive && !b.inBus && !b.far) this.addPoint(b.pos.x, b.pos.z);
      if (game.remotes) for (const r of game.remotes.values()) if (r.alive && r.pos) this.addPoint(r.pos.x, r.pos.z);
      if (game.spectateId && game.actorById) { const a = game.actorById(game.spectateId); if (a && a.pos) this.addPoint(a.pos.x, a.pos.z); }
      const list = game.ballistics && game.ballistics.list;
      if (list) for (let i = 0; i < list.length; i++) if (list[i].rocket) this.addPoint(list[i].x, list[i].z);
    }
    this.streamer.update(dt, this._pts, this._np);
  }

  /** Add a focus point unless one already listed is within 24 m (their chunks are the same). */
  addPoint(x, z) {
    let pts = this._pts;
    const n = this._np;
    for (let k = 0; k < n; k++) {
      const dx = pts[k * 2] - x, dz = pts[k * 2 + 1] - z;
      if (dx * dx + dz * dz < 24 * 24) return;
    }
    if (n * 2 + 2 > pts.length) { const p2 = new Float64Array(pts.length * 2); p2.set(pts); pts = this._pts = p2; }
    pts[n * 2] = x; pts[n * 2 + 1] = z;
    this._np = n + 1;
  }

  /** Numbers for the perf tools: colliders, chunks, instances. */
  stats() {
    return {
      colliders: this.physics.activeColliders(),
      shapes: this.colliderShapes,
      stream: this.streamer.stats(),
      veg: this.veg.counts(),
      terrainTris: this.terrain.triangles(),
      fogFar: Math.round(this.fogFar),
      updateMs: +(this.updateMs || 0).toFixed(3),
    };
  }
}
