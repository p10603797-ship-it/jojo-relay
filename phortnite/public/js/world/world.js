// Builds the island scene + physics from the shared world data, and keeps the big map cheap:
//   terrain.js     LOD tiles with the biome splat, roads, the physics heightfield
//   batch.js       buildings and props in 128 m chunk batches (HLOD boxes far away)
//   vegetation.js  trees, rocks and decor in NEAR / MID / FAR rings
//   colliders.js   physics colliders only near players (64 m chunks, streamed)
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
import { paintMapArt } from '../ui/mapview.js';
import * as M from './models.js';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const FIX_CHUNK = 128;        // indestructible geometry: one trimesh per 128 m chunk (and material)
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
    t('map', () => { this.mapCanvas = paintMapArt(this); });
    this.requestLayers();
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
   * Every solid object gets a make() closure for its colliders. Indestructible ones (hp 0) are
   * merged into one triangle mesh per 128 m chunk and material, always there; everything else is
   * streamed: its colliders exist only while a chunk it touches is near someone.
   */
  buildColliders() {
    const d = this.data;
    const R = this.physics.R;
    this.streamer = new ColliderStreamer({ size: d.size, create: (id) => this.streamIn(id), remove: (id) => this.streamOut(id) });
    const fixed = new Map(); // `${chunk}|${mat}` -> { v: [], i: [] }
    for (const o of d.objects) {
      if (o.kind === 'decor') continue;
      if (o.kind === 'part' || o.kind === 'prop') {
        if (!(o.hp > 0)) { this.addFixed(fixed, o); this.objs[o.id] = { o, alive: true, colliders: [], make: () => [], fixed: true }; continue; }
        const make = () => this.staticColliders(o, R);
        this.objs[o.id] = { o, alive: true, colliders: [], make, r: this.radiusOf(o) };
      } else if (o.kind === 'tree') {
        const spec = this.veg.models[this.veg.modelOf.get(this.veg.keyOf(o))];
        const cols = spec ? spec.colliders : null;
        const make = () => this.treeColliders(o, cols, R);
        this.objs[o.id] = { o, alive: true, colliders: [], make, r: 3 * (o.s || 1) };
      } else if (o.kind === 'rock') {
        const make = () => this.rockColliders(o, R);
        this.objs[o.id] = { o, alive: true, colliders: [], make, r: 2 * (o.s || 1) };
      } else continue;
      const r = this.objs[o.id];
      this.streamer.add(o.id, o.x, o.z, Math.min(r.r, 40));
    }
    this.streamer.finalize();
    this.physics.streamer = this.streamer;
    // the fixed meshes
    let n = 0;
    for (const [key, g] of fixed) {
      const mat = key.split('|')[1];
      const desc = R.ColliderDesc.trimesh(new Float32Array(g.v), new Uint32Array(g.i), R.TriMeshFlags ? R.TriMeshFlags.FIX_INTERNAL_EDGES : undefined);
      this.physics.collider(desc, { kind: 'obj', id: -1, mat }, undefined, GROUP.WORLD);
      n++;
    }
    this.fixedMeshes = n;
    // focus points scratch (x, z pairs)
    this._pts = new Float64Array(128);
  }

  radiusOf(o) {
    if (o.bb) return Math.max(o.bb[3] - o.bb[0], o.bb[5] - o.bb[2]) / 2;
    if (o.shape === 'prism') {
      let r = 0;
      for (let i = 0; i < 6; i++) r = Math.max(r, Math.hypot(o.pts[i * 3] - o.x, o.pts[i * 3 + 2] - o.z));
      return r;
    }
    return Math.hypot(o.hx || 1, o.hz || 1) + (o.ax ? (o.hy || 0) : 0);
  }

  /** Append an indestructible object's triangles to its chunk's fixed mesh. */
  addFixed(fixed, o) {
    const h = this.data.half;
    const key = `${Math.floor((o.x + h) / FIX_CHUNK)},${Math.floor((o.z + h) / FIX_CHUNK)}|${o.mat || 'stone'}`;
    let g = fixed.get(key);
    if (!g) fixed.set(key, (g = { v: [], i: [] }));
    const base = g.v.length / 3;
    if (o.shape === 'prism') {
      const p = o.pts;
      for (let k = 0; k < 18; k++) g.v.push(p[k]);
      // two triangles (0 1 2 / 3 4 5) and the three sides between them
      g.i.push(base, base + 1, base + 2, base + 3, base + 5, base + 4);
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) g.i.push(base + a, base + 3 + a, base + 3 + b, base + a, base + 3 + b, base + b);
      return;
    }
    // a box (tilted about x or z, or turned by yaw)
    _m.identity();
    if (o.ax === 'x') _m.makeRotationX(o.ang); else if (o.ax === 'z') _m.makeRotationZ(o.ang); else if (o.yaw) _m.makeRotationY(o.yaw);
    _m.setPosition(o.x, o.y, o.z);
    for (let c = 0; c < 8; c++) {
      _a.set(c & 1 ? o.hx : -o.hx, c & 2 ? o.hy : -o.hy, c & 4 ? o.hz : -o.hz).applyMatrix4(_m);
      g.v.push(_a.x, _a.y, _a.z);
    }
    const F = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (const [a, b, c, e] of F) g.i.push(base + a, base + b, base + c, base + a, base + c, base + e);
  }

  /** A streamed object's chunk came near: make its colliders (when it still stands). */
  streamIn(id) {
    const r = this.objs[id];
    if (!r || !r.alive || r.colliders.length) return 0;
    r.colliders = r.make();
    const o = r.o;
    this.physics.markFresh(r.colliders, o.x, o.y, o.z, (r.r || 3) + 6);
    return r.colliders.length;
  }

  streamOut(id) {
    const r = this.objs[id];
    if (!r || !r.colliders.length) return;
    for (const c of r.colliders) this.physics.removeCollider(c);
    r.colliders = [];
  }

  staticColliders(o, R) {
    const info = { kind: 'obj', id: o.id, mat: o.mat };
    const out = [];
    if (o.shape === 'prism') {
      const desc = R.ColliderDesc.convexHull(new Float32Array(o.pts));
      if (desc) out.push(this.physics.collider(desc, info, undefined, GROUP.WORLD));
      return out;
    }
    const desc = R.ColliderDesc.cuboid(o.hx, o.hy, o.hz).setTranslation(o.x, o.y, o.z);
    if (o.ax) {
      const s = Math.sin(o.ang / 2), c = Math.cos(o.ang / 2);
      desc.setRotation(o.ax === 'x' ? { x: s, y: 0, z: 0, w: c } : { x: 0, y: 0, z: s, w: c });
    } else if (o.yaw) {
      desc.setRotation({ x: 0, y: Math.sin(o.yaw / 2), z: 0, w: Math.cos(o.yaw / 2) });
    }
    out.push(this.physics.collider(desc, info, undefined, GROUP.WORLD));
    return out;
  }

  treeColliders(o, spec, R) {
    const info = { kind: 'obj', id: o.id, mat: 'wood' };
    const s = o.s || 1;
    const out = [];
    for (const c of spec || []) {
      let desc;
      if (c.shape === 'cylinder') desc = R.ColliderDesc.cylinder(c.hh * s, c.r * s);
      else if (c.shape === 'cone') desc = R.ColliderDesc.cone(c.hh * s, c.r * s);
      else desc = R.ColliderDesc.ball(c.r * s);
      desc.setTranslation(o.x, o.y + c.y * s, o.z);
      out.push(this.physics.collider(desc, info, undefined, c.walk ? GROUP.FOLIAGE : GROUP.WORLD));
    }
    return out;
  }

  rockColliders(o, R) {
    // convex hull from the transformed rock vertices
    const geo = this.veg.geometryOf(o);
    if (!geo) return [];
    const p = geo.attributes.position;
    _m.compose(_v.set(o.x, o.y, o.z), _q.setFromAxisAngle(_s.set(0, 1, 0), o.yaw || 0), _s.setScalar(o.s || 1));
    const pts = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(_m);
      pts[i * 3] = _v.x; pts[i * 3 + 1] = _v.y; pts[i * 3 + 2] = _v.z;
    }
    const desc = R.ColliderDesc.convexHull(pts);
    return desc ? [this.physics.collider(desc, { kind: 'obj', id: o.id, mat: 'stone' }, undefined, GROUP.WORLD)] : [];
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
    for (const c of r.colliders) this.physics.removeCollider(c);
    r.colliders = [];
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
      if (this.streamer.isLive(r.o.id) && !r.colliders.length) {
        r.colliders = r.make();
        this.physics.markFresh(r.colliders, r.o.x, r.o.y, r.o.z, (r.r || 3) + 6);
      }
      if (this.veg.has(r.o.id)) veg = true;
      else this.batch.setVisible(r.o.id, true);
    }
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
      stream: this.streamer.stats(),
      veg: this.veg.counts(),
      terrainTris: this.terrain.triangles(),
      fogFar: Math.round(this.fogFar),
      updateMs: +(this.updateMs || 0).toFixed(3),
    };
  }
}
