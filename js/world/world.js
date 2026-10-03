// Builds the island scene + physics from the shared world data.
import * as THREE from 'three';
import { Perlin, smoothstep } from '../../shared/rng.js';
import { GROUP } from '../physics.js';
import { createSky, SUN_DIR, SKY_COLORS } from '../gfx/sky.js';
import { createWater } from '../gfx/water.js';
import { createGrass } from '../gfx/grass.js';
import { Batch } from './batch.js';
import * as M from './models.js';

const CHUNK = 160;
const PAINTS = [0xf1e7d0, 0x9fc6ea, 0xf3d473, 0xb7dca0];
const ROOFS = [0xa53c2b, 0x3e5574, 0x6c4a32, 0x4b6f3d];
const CONTAINERS = [0xc0392b, 0x2e6db4, 0x3f8f4f, 0xe08a1e];
const CARS = [0xd23c2c, 0x2e7dd1, 0xf0c419, 0xeeeeee, 0x37a35a];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _up = new THREE.Vector3();
const _snap = new THREE.Vector3();

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

    this.buildLights();
    this.buildSky();
    this.buildTerrain();
    this.buildMaterials();
    this.buildStatic();
    this.buildTrees();
    this.buildRocks();
    this.buildChests();
    this.buildBarrels();
    this.buildMinimap();
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
  }

  buildSky() {
    this.sky = createSky(this.T.noise.map);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(SKY_COLORS.fog, 140, this.quality.drawDist);
    this.scene.background = SKY_COLORS.horizon.clone();
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
  }

  // ------------------------------------------------------------------ terrain
  buildTerrain() {
    const d = this.data;
    const { N, res, cell, half, heights } = d;
    const noise = new Perlin(d.seed + 7);
    const pos = new Float32Array(N * N * 3);
    const nor = new Float32Array(N * N * 3);
    const splat = new Float32Array(N * N * 4);
    const info = new Float32Array(N * N * 4);
    const H = (ix, iz) => heights[Math.min(N - 1, Math.max(0, iz)) * N + Math.min(N - 1, Math.max(0, ix))];

    // dirt roads between nearby POIs (minimum spanning tree)
    const roads = [];
    const pois = d.pois;
    if (pois.length > 1) {
      const inTree = new Set([0]);
      while (inTree.size < pois.length) {
        let best = null;
        for (const a of inTree) {
          for (let b = 0; b < pois.length; b++) {
            if (inTree.has(b)) continue;
            const dd = Math.hypot(pois[a].x - pois[b].x, pois[a].z - pois[b].z);
            if (!best || dd < best.d) best = { a, b, d: dd };
          }
        }
        inTree.add(best.b);
        roads.push([pois[best.a], pois[best.b]]);
      }
    }
    this.roads = roads;
    const roadDist = (x, z) => {
      let m = Infinity;
      for (const [a, b] of roads) {
        const dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
        const wob = noise.noise(x * 0.03, z * 0.03) * 3;
        const ex = a.x + dx * t - x, ez = a.z + dz * t - z;
        m = Math.min(m, Math.sqrt(ex * ex + ez * ez) + wob);
      }
      return m;
    };

    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const x = -half + ix * cell, z = -half + iz * cell, h = heights[i];
        pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
        let nx = H(ix - 1, iz) - H(ix + 1, iz), ny = 2 * cell, nz = H(ix, iz - 1) - H(ix, iz + 1);
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
        const slope = 1 - ny;
        let sand = smoothstep(3.2, 1.7, h);
        let rock = smoothstep(0.2, 0.4, slope) + smoothstep(40, 52, h) * 0.8;
        let dirt = smoothstep(0.3, 0.5, noise.fbm(x * 0.018, z * 0.018, 3)) * 0.8;
        let houseMask = 0;
        for (const hs of d.houses) {
          const ddx = Math.max(Math.abs(x - hs.x) - hs.hx, 0), ddz = Math.max(Math.abs(z - hs.z) - hs.hz, 0);
          const dd = Math.hypot(ddx, ddz);
          if (dd < 6) { houseMask = Math.max(houseMask, smoothstep(6, 1.5, dd)); }
        }
        dirt = Math.max(dirt, houseMask * 0.9);
        if (h > 1.8) dirt = Math.max(dirt, smoothstep(4.2, 1.6, roadDist(x, z)));
        rock = Math.min(rock, 1);
        sand = Math.min(1, sand * (1 - rock * 0.5));
        let grass = Math.max(0, 1 - sand - rock - dirt);
        const sum = sand + rock + dirt + grass || 1;
        splat[i * 4] = grass / sum; splat[i * 4 + 1] = sand / sum; splat[i * 4 + 2] = rock / sum; splat[i * 4 + 3] = dirt / sum;
        info[i * 4] = h;
        info[i * 4 + 1] = Math.max(0, (grass / sum) * 1.2 - 0.2) * (1 - houseMask);
        info[i * 4 + 2] = sand / sum;
        info[i * 4 + 3] = 1;
      }
    }
    this.splat = splat;
    const idx = new Uint32Array(res * res * 6);
    let k = 0;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const a = iz * N + ix, b = a + 1, c = a + N, e = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const T = this.T;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        tGrass: { value: T.grass.map }, nGrass: { value: T.grass.normal },
        tSand: { value: T.sand.map }, nSand: { value: T.sand.normal },
        tRock: { value: T.rock.map }, nRock: { value: T.rock.normal },
        tDirt: { value: T.dirt.map }, nDirt: { value: T.dirt.normal },
        tMacro: { value: T.noise.map },
      });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vTW;\nvarying vec3 vTN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tGrass, tSand, tRock, tDirt, nGrass, nSand, nRock, nDirt, tMacro;
varying vec4 vSplat;
varying vec3 vTW;
varying vec3 vTN;`)
        .replace('#include <map_fragment>', `
vec4 tw = vSplat / max(dot(vSplat, vec4(1.0)), 1e-3);
vec2 tuv = vTW.xz * 0.21;
vec3 tgn = normalize(vTN);
vec3 tan_ = abs(tgn);
vec2 ruvSide = (tan_.x > tan_.z ? vTW.zy : vTW.xy) * 0.12;
float rockTop = smoothstep(0.6, 0.88, tan_.y);
float macro = texture2D(tMacro, vTW.xz * 0.0033).r;
float macro2 = texture2D(tMacro, vTW.xz * 0.017).g;
vec3 tcol = vec3(0.0);
vec3 tnrm = vec3(0.0);
if (tw.x > 0.01) {
  vec3 g1 = texture2D(tGrass, tuv).rgb;
  vec3 g2 = texture2D(tGrass, tuv * 0.21 + 0.37).rgb;
  tcol += mix(g1, g2, 0.42) * tw.x;
  tnrm += (texture2D(nGrass, tuv).xyz * 2.0 - 1.0) * tw.x;
}
if (tw.y > 0.01) {
  tcol += texture2D(tSand, tuv * 0.8).rgb * tw.y;
  tnrm += (texture2D(nSand, tuv * 0.8).xyz * 2.0 - 1.0) * tw.y;
}
if (tw.z > 0.01) {
  vec3 rs = texture2D(tRock, ruvSide).rgb;
  vec3 rt = texture2D(tRock, tuv * 0.55).rgb;
  tcol += mix(rs, rt, rockTop) * tw.z;
  tnrm += (mix(texture2D(nRock, ruvSide).xyz, texture2D(nRock, tuv * 0.55).xyz, rockTop) * 2.0 - 1.0) * tw.z;
}
if (tw.w > 0.01) {
  tcol += texture2D(tDirt, tuv * 0.9).rgb * tw.w;
  tnrm += (texture2D(nDirt, tuv * 0.9).xyz * 2.0 - 1.0) * tw.w;
}
tcol *= 0.8 + macro * 0.36;
tcol *= 0.9 + macro2 * 0.2;
diffuseColor.rgb *= tcol;
`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = dot(tw, vec4(0.95, 0.9, 0.84, 0.96));')
        .replace('#include <normal_fragment_maps>', `
vec3 tT = normalize(vec3(1.0, 0.0, 0.0) - tgn * tgn.x);
vec3 tB = normalize(vec3(0.0, 0.0, 1.0) - tgn * tgn.z);
vec3 wN = normalize(tT * tnrm.x + tB * tnrm.y + tgn * max(tnrm.z, 0.25));
normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
`);
    };
    this.terrainMat = mat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    this.terrain = mesh;

    // physics heightfield (Rapier wants column-major: index = zi + xi * N)
    const R = this.physics.R;
    const hf = new Float32Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) hf[iz + ix * N] = heights[iz * N + ix];
    this.physics.collider(
      R.ColliderDesc.heightfield(res, res, hf, { x: d.size, y: 1, z: d.size }).setFriction(0.9),
      { kind: 'terrain' }, undefined, GROUP.WORLD,
    );
    // sea floor safety net
    this.physics.collider(R.ColliderDesc.cuboid(1000, 1, 1000).setTranslation(0, -18, 0), { kind: 'terrain' }, undefined, GROUP.WORLD);

    // terrain info texture for water depth & grass placement
    const half16 = new Uint16Array(info.length);
    for (let i = 0; i < info.length; i++) half16[i] = THREE.DataUtils.toHalfFloat(info[i]);
    const tex = new THREE.DataTexture(half16, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.infoTex = tex;

    this.water = createWater(T.noise.normal, tex, half, cell, N);
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
      this.scene.add(this.grass);
    }
  }

  /** Dominant terrain surface at a point: 'sand' | 'rock' | 'dirt' | 'grass'. */
  surfaceAt(x, z) {
    const d = this.data;
    const ix = Math.round((x + d.half) / d.cell), iz = Math.round((z + d.half) / d.cell);
    if (ix < 0 || iz < 0 || ix >= d.N || iz >= d.N) return 'sand';
    const i = (iz * d.N + ix) * 4, s = this.splat;
    let best = 0;
    for (let k = 1; k < 4; k++) if (s[i + k] > s[i + best]) best = k;
    return ['grass', 'sand', 'rock', 'dirt'][best];
  }

  // ------------------------------------------------------------------ materials
  buildMaterials() {
    const T = this.T;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const leaves = std({ map: T.foliage.map, normalMap: T.foliage.normal, vertexColors: true, roughness: 0.88 });
    this.mats = {
      siding: std({ map: T.siding.map, normalMap: T.siding.normal, vertexColors: true, roughness: 0.82 }),
      brick: std({ map: T.brick.map, normalMap: T.brick.normal, vertexColors: true, roughness: 0.9 }),
      metalwall: std({ map: T.metal.map, normalMap: T.metal.normal, vertexColors: true, roughness: 0.5, metalness: 0.45 }),
      roof: std({ map: T.shingles.map, normalMap: T.shingles.normal, vertexColors: true, roughness: 0.78 }),
      floor: std({ map: T.planks.map, normalMap: T.planks.normal, vertexColors: true, roughness: 0.72 }),
      concrete: std({ map: T.concrete.map, normalMap: T.concrete.normal, vertexColors: true, roughness: 0.9 }),
      car: std({ vertexColors: true, roughness: 0.32, metalness: 0.35 }),
      crate: std({ map: T.woodBuild.map, normalMap: T.woodBuild.normal, vertexColors: true, roughness: 0.8 }),
      bark: std({ map: T.bark.map, normalMap: T.bark.normal, roughness: 0.95, color: 0xc9b29a, vertexColors: true }),
      leaves,
      palm: Object.assign(leaves.clone(), { side: THREE.DoubleSide }),
      rock: std({ map: T.rock.map, normalMap: T.rock.normal, vertexColors: true, roughness: 0.92 }),
      chestWood: std({ map: T.planks.map, normalMap: T.planks.normal, color: 0xe6b070, roughness: 0.7 }),
      chestGold: std({ color: 0xffc23a, metalness: 1, roughness: 0.28, emissive: 0x7a4c00, emissiveIntensity: 0.6 }),
      barrel: std({ map: T.metal.map, normalMap: T.metal.normal, vertexColors: true, roughness: 0.45, metalness: 0.5 }),
    };
  }

  chunkOf(x, z) {
    const h = this.data.half;
    return `${Math.floor((x + h) / CHUNK)},${Math.floor((z + h) / CHUNK)}`;
  }

  // ------------------------------------------------------------------ houses + props (merged)
  buildStatic() {
    const d = this.data;
    const R = this.physics.R;
    const batch = new Batch();
    this.batch = batch;
    const houseById = d.houses;
    for (const o of d.objects) {
      if (o.kind !== 'part' && o.kind !== 'prop') continue;
      const chunk = this.chunkOf(o.x, o.z);
      let matKey, color;
      if (o.kind === 'part') {
        const h = houseById[o.house];
        switch (o.look) {
          case 'siding': matKey = 'siding'; color = PAINTS[h.paint % PAINTS.length]; break;
          case 'brick': matKey = 'brick'; color = 0xffffff; break;
          case 'metalwall': matKey = 'metalwall'; color = 0xa3b4c2; break;
          case 'roof': matKey = 'roof'; color = ROOFS[h.paint % ROOFS.length]; break;
          case 'floor': matKey = 'floor'; color = 0xffffff; break;
          case 'trim': matKey = 'concrete'; color = h.style === 'metal' ? 0x6d7b88 : 0xf6f3ec; break;
          case 'foundation': matKey = 'concrete'; color = 0xb3ada2; break;
          default: matKey = 'concrete'; color = 0xd2cdc3;
        }
        batch.add(matKey, chunk, o.id, M.partGeometry(o, color));
      } else if (o.type === 'container') {
        batch.add('metalwall', chunk, o.id, M.containerGeometry(o, CONTAINERS[o.color % CONTAINERS.length]));
      } else if (o.type === 'car') {
        const g = M.carGeometry(CARS[o.color % CARS.length]);
        g.rotateY(o.yaw);
        g.translate(o.x, o.y, o.z);
        batch.add('car', chunk, o.id, g);
      } else if (o.type === 'crate') {
        const g = M.crateGeometry();
        g.translate(o.x, o.y, o.z);
        batch.add('crate', chunk, o.id, g);
      }
      const make = () => this.staticColliders(o, R);
      this.objs[o.id] = { o, alive: true, colliders: make(), make, render: 'batch' };
    }
    this.staticMeshes = batch.build(this.mats, this.root);
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

  // ------------------------------------------------------------------ trees & rocks (chunked instancing)
  buildInstanced(items, parts, matrixOf, castShadow = true) {
    const byChunk = new Map();
    for (const o of items) {
      const c = this.chunkOf(o.x, o.z);
      let l = byChunk.get(c);
      if (!l) byChunk.set(c, (l = []));
      l.push(o);
    }
    const refs = new Map();
    for (const list of byChunk.values()) {
      for (const p of parts) {
        const mesh = new THREE.InstancedMesh(p.geo, p.mat, list.length);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        list.forEach((o, i) => {
          matrixOf(o, _m);
          mesh.setMatrixAt(i, _m);
          let r = refs.get(o.id);
          if (!r) refs.set(o.id, (r = []));
          r.push({ mesh, i, m: _m.clone() });
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.root.add(mesh);
      }
    }
    return refs;
  }

  buildTrees() {
    const d = this.data;
    const R = this.physics.R;
    this.treeGeos = [0, 1, 2].map((t) => M.treeGeometry(t));
    for (let type = 0; type < 3; type++) {
      const items = d.objects.filter((o) => o.kind === 'tree' && o.type === type);
      const g = this.treeGeos[type];
      const refs = this.buildInstanced(items, [
        { geo: g.trunk, mat: this.mats.bark },
        { geo: g.leaves, mat: type === 2 ? this.mats.palm : this.mats.leaves },
      ], (o, m) => m.compose(_v.set(o.x, o.y, o.z), _q.setFromAxisAngle(_s.set(0, 1, 0), o.yaw), _s.setScalar(o.s)));
      for (const o of items) {
        const make = () => {
          const info = { kind: 'obj', id: o.id, mat: 'wood' };
          const s = o.s;
          const cols = [this.physics.collider(R.ColliderDesc.cylinder(2.0 * s, 0.34 * s).setTranslation(o.x, o.y + 2.0 * s, o.z), info, undefined, GROUP.WORLD)];
          if (type === 0) cols.push(this.physics.collider(R.ColliderDesc.cone(2.8 * s, 2.2 * s).setTranslation(o.x, o.y + 5.6 * s, o.z), info, undefined, GROUP.WORLD));
          if (type === 1) cols.push(this.physics.collider(R.ColliderDesc.ball(2.25 * s).setTranslation(o.x, o.y + 5.0 * s, o.z), info, undefined, GROUP.WORLD));
          return cols;
        };
        this.objs[o.id] = { o, alive: true, colliders: make(), make, inst: refs.get(o.id) };
      }
    }
  }

  buildRocks() {
    const d = this.data;
    const R = this.physics.R;
    this.rockGeos = [0, 1, 2].map((v) => M.rockGeometry(v));
    for (let type = 0; type < 3; type++) {
      const items = d.objects.filter((o) => o.kind === 'rock' && o.type === type);
      const geo = this.rockGeos[type];
      const matrixOf = (o, m) => m.compose(_v.set(o.x, o.y, o.z), _q.setFromAxisAngle(_s.set(0, 1, 0), o.yaw), _s.setScalar(o.s));
      const refs = this.buildInstanced(items, [{ geo, mat: this.mats.rock }], matrixOf);
      // convex hull collider from the transformed rock vertices
      const p = geo.attributes.position;
      for (const o of items) {
        matrixOf(o, _m);
        const pts = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) {
          _v.fromBufferAttribute(p, i).applyMatrix4(_m);
          pts[i * 3] = _v.x; pts[i * 3 + 1] = _v.y; pts[i * 3 + 2] = _v.z;
        }
        const make = () => {
          const desc = R.ColliderDesc.convexHull(pts);
          return desc ? [this.physics.collider(desc, { kind: 'obj', id: o.id, mat: 'stone' }, undefined, GROUP.WORLD)] : [];
        };
        this.objs[o.id] = { o, alive: true, colliders: make(), make, inst: refs.get(o.id) };
      }
    }
  }

  // ------------------------------------------------------------------ chests & barrels
  buildChests() {
    const d = this.data;
    const R = this.physics.R;
    const closed = M.chestGeometry(), open = M.openChestGeometry();
    const n = d.chests.length;
    const mk = (geo, mat) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.castShadow = true;
      m.receiveShadow = true;
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
    for (const m of [...this.chestMeshes.closed, ...this.chestMeshes.open]) m.instanceMatrix.needsUpdate = true;
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
    this.barrels.forEach((b, i) => {
      if (!force && b.body.isSleeping()) return;
      const t = b.body.translation(), r = b.body.rotation();
      if (t.y < -30) {
        b.body.setTranslation(b.home, true);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      _m.compose(_v.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.setScalar(1));
      this.barrelMesh.setMatrixAt(i, _m);
      dirty = true;
    });
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
    if (r.inst) {
      for (const ref of r.inst) {
        ref.mesh.setMatrixAt(ref.i, ZERO);
        ref.mesh.instanceMatrix.needsUpdate = true;
      }
    } else {
      this.batch.setVisible(id, false);
    }
    if (r.o.kind === 'tree' && !quiet) this.spawnFallingTree(r.o, fromDir);
    return r.o;
  }

  restoreAll() {
    this.destroyedIds.clear();
    for (const r of this.objs) {
      if (!r || r.alive) continue;
      r.alive = true;
      r.colliders = r.make();
      if (r.inst) {
        for (const ref of r.inst) {
          ref.mesh.setMatrixAt(ref.i, ref.m);
          ref.mesh.instanceMatrix.needsUpdate = true;
        }
      } else {
        this.batch.setVisible(r.o.id, true);
      }
    }
    for (const f of this.falling) this.root.remove(f.group);
    this.falling.length = 0;
    this.resetChests();
    this.resetBarrels();
  }

  spawnFallingTree(o, fromDir) {
    const g = this.treeGeos[o.type];
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(g.trunk, this.mats.bark);
    const leaves = new THREE.Mesh(g.leaves, o.type === 2 ? this.mats.palm : this.mats.leaves);
    trunk.castShadow = leaves.castShadow = true;
    group.add(trunk, leaves);
    group.position.set(o.x, o.y, o.z);
    group.rotation.y = o.yaw;
    group.scale.setScalar(o.s);
    const pivot = new THREE.Group();
    pivot.position.set(o.x, o.y, o.z);
    group.position.set(0, 0, 0);
    pivot.add(group);
    this.root.add(pivot);
    let ax = 1, az = 0;
    if (fromDir) {
      ax = fromDir.z;
      az = -fromDir.x;
      const l = Math.hypot(ax, az) || 1;
      ax /= l; az /= l;
    }
    this.falling.push({ group: pivot, t: 0, angle: 0, vel: 0.15, axis: new THREE.Vector3(ax, 0, az) });
  }

  // ------------------------------------------------------------------ minimap
  buildMinimap() {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const d = this.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const wx = -d.half + (x + 0.5) / S * d.size, wz = -d.half + (y + 0.5) / S * d.size;
        const h = d.heightAt(wx, wz);
        let r, gg, b;
        if (h < 0) {
          const t = Math.min(1, -h / 12);
          r = 70 - 40 * t; gg = 190 - 80 * t; b = 210 - 40 * t;
        } else {
          const s = this.surfaceAt(wx, wz);
          if (s === 'sand') { r = 226; gg = 208; b = 150; } else if (s === 'rock') { r = 140; gg = 138; b = 132; } else if (s === 'dirt') { r = 150; gg = 118; b = 80; } else { r = 96; gg = 168; b = 70; }
          const shade = 0.85 + Math.min(0.3, h / 160);
          const hx = d.heightAt(wx + 2, wz) - d.heightAt(wx - 2, wz);
          const lit = 1 - hx * 0.05;
          r *= shade * lit; gg *= shade * lit; b *= shade * lit;
        }
        const i = (y * S + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const k = S / d.size;
    for (const h of d.houses) {
      g.fillStyle = h.roof === 'gable' ? '#' + ROOFS[h.paint % ROOFS.length].toString(16).padStart(6, '0') : '#c9c4ba';
      g.fillRect((h.x - h.hx + d.half) * k, (h.z - h.hz + d.half) * k, h.hx * 2 * k, h.hz * 2 * k);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.strokeRect((h.x - h.hx + d.half) * k, (h.z - h.hz + d.half) * k, h.hx * 2 * k, h.hz * 2 * k);
    }
    this.mapCanvas = c;
  }

  // ------------------------------------------------------------------ per frame
  update(dt, camera, focus) {
    this.time += dt;
    this.sky.position.copy(camera.position);
    this.sky.material.uniforms.uTime.value = this.time;
    this.water.material.uniforms.uTime.value = this.time;
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
        f.group.scale.setScalar(k);
      }
      if (f.t > 2.8) {
        this.root.remove(f.group);
        this.falling.splice(i, 1);
      }
    }
  }
}
