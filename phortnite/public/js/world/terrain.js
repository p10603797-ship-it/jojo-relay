// The island's ground: level-of-detail tiles, the biome splat from the surface grid, paved road
// ribbons, the physics heightfield and the info texture (height, grass, tint) that the water and
// the grass read.
//
// Geometry: one vertex grid for the whole map (the data's heights, with normals and a per-biome
// tint) plus 6 m skirts hanging from every tile edge. The map is cut into 8 x 8 tiles (200 m on
// the 1.6 km island); each tile is drawn at a 4, 8 or 16 m step by distance (with hysteresis), and
// 2 x 2 tiles share one draw call whose index buffer is rewritten only when one of its tiles
// changes step. Groups are frustum culled; tiles deep under the sea are skipped.
//
// Splat: the surface grid (data.surface, or a grass / sand / rock / dirt grid derived like today's
// look on the old island) is a texture of layer indexes. Each pixel blends the layers of its 4
// nearest grid points (borders wobbled by noise, sharpened by the layers' heights) from a texture
// array (albedo + height, and normals), so most pixels read a single layer. Cliffs get a
// triplanar rock layer, lava glows, sand is darker and shinier along the shore.
import * as THREE from 'three';
import { Perlin, smoothstep } from '../../shared/rng.js';
import { BIOMES, SURFACES, STEP_SOUND } from '../../shared/world/keys.js';
import { GROUP } from '../physics.js';
import { SURFACE_LAYERS, surfaceLayer } from '../gfx/textures.js';

const TILES = 8;          // tiles per side
const STEPS = [1, 2, 4];  // grid cells per vertex at each LOD
const SKIRT = 6;          // metres
const DEEP = -6;          // tiles whose every point is below this are not drawn

/** Per-biome ground tint (multiplies the textures; subtle). */
const BIOME_TINT = {
  ocean: [1, 1, 1], beach: [1.04, 1.0, 0.94], meadow: [1.0, 1.04, 0.94], forest: [0.86, 0.95, 0.88], farm: [1.06, 1.02, 0.88],
  city: [0.97, 0.97, 0.98], snow: [1.0, 1.02, 1.06], desert: [1.06, 0.98, 0.9], mesa: [1.08, 0.94, 0.86], jungle: [0.86, 1.04, 0.82],
  swamp: [0.86, 0.9, 0.76], volcano: [0.82, 0.8, 0.8],
};
/** Grass density per surface (0 = none). */
const GRASS = { grass: 1, junglefloor: 1, wheat: 1, field: 0.35, mud: 0.3, dirt: 0.12, redsand: 0.04 };
/** Texture tiling (repeats per metre) and roughness per surface layer. */
const UV_SCALE = { grass: 0.21, dirt: 0.19, sand: 0.17, rock: 0.12, snow: 0.15, ice: 0.11, redsand: 0.13, strata: 0.06, mud: 0.17, junglefloor: 0.2, ash: 0.16, lava: 0.08, asphalt: 0.18, cobble: 0.3, field: 0.12, wheat: 0.2, asphaltLines: 1 };
const ROUGH = { grass: 0.95, dirt: 0.96, sand: 0.9, rock: 0.84, snow: 0.6, ice: 0.25, redsand: 0.92, strata: 0.86, mud: 0.6, junglefloor: 0.95, ash: 0.95, lava: 0.55, asphalt: 0.8, cobble: 0.82, field: 0.96, wheat: 0.95, asphaltLines: 0.8 };
/** Grass tint ids: one per biome (BIOMES index), then special ones. */
export const GRASS_TINT_WHEAT = BIOMES.length;

const BI = Object.fromEntries(BIOMES.map((k, i) => [k, i]));
const SI = Object.fromEntries(SURFACES.map((k, i) => [k, i]));

export class Terrain {
  constructor(world) {
    this.world = world;
    const d = (this.data = world.data);
    this.T = world.T;
    const { N } = d;
    this.N = N;
    this.layerKeys = SURFACE_LAYERS;
    this.surf = this.surfaceGrid();            // Uint8 SURFACE_LAYERS index per grid point
    this.buildInfo();
    this.buildGeometry();
    this.buildMaterial();
    this.buildMeshes();
    this.buildRoads();
    this.buildPhysics();
    this._cam = new THREE.Vector3();
  }

  // ------------------------------------------------------------------ grids
  /**
   * The surface layer of every grid point: the data's surface grid on the biome island, or on the
   * old island a grid like today's look (sand by the sea, rock on slopes and the summit, dirt in
   * patches, around houses and along the roads between the places, grass elsewhere).
   */
  surfaceGrid() {
    const d = this.data;
    const { N, res, cell, half, heights } = d;
    const out = new Uint8Array(N * N);
    if (d.surface && d.surface.length === N * N) {
      for (let i = 0; i < N * N; i++) out[i] = surfaceLayer(SURFACES[d.surface[i]]);
      this.legacy = false;
      return out;
    }
    this.legacy = true;
    const noise = new Perlin(d.seed + 7);
    const H = (ix, iz) => heights[Math.min(N - 1, Math.max(0, iz)) * N + Math.min(N - 1, Math.max(0, ix))];
    // dirt around houses and along roads between the places (stamped over each one's box)
    const dirtMask = new Float32Array(N * N);
    const houseMask = new Float32Array(N * N);
    const stampBox = (x0, z0, x1, z1, pad, fn) => {
      const ix0 = Math.max(0, Math.floor((x0 - pad + half) / cell)), ix1 = Math.min(N - 1, Math.ceil((x1 + pad + half) / cell));
      const iz0 = Math.max(0, Math.floor((z0 - pad + half) / cell)), iz1 = Math.min(N - 1, Math.ceil((z1 + pad + half) / cell));
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) fn(iz * N + ix, -half + ix * cell, -half + iz * cell);
    };
    for (const hs of d.houses) {
      stampBox(hs.x - hs.hx, hs.z - hs.hz, hs.x + hs.hx, hs.z + hs.hz, 6, (i, x, z) => {
        const dx = Math.max(Math.abs(x - hs.x) - hs.hx, 0), dz = Math.max(Math.abs(z - hs.z) - hs.hz, 0);
        const m = smoothstep(6, 1.5, Math.sqrt(dx * dx + dz * dz));
        if (m > houseMask[i]) houseMask[i] = m;
      });
    }
    // roads: a minimum spanning tree between the places (like the old renderer)
    const pois = d.pois || [];
    const roads = [];
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
    for (const [a, b] of roads) {
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
      stampBox(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z), 8, (i, x, z) => {
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
        const ex = a.x + dx * t - x, ez = a.z + dz * t - z;
        const m = smoothstep(4.2, 1.6, Math.sqrt(ex * ex + ez * ez) + noise.noise(x * 0.03, z * 0.03) * 3);
        if (m > dirtMask[i]) dirtMask[i] = m;
      });
    }
    const dens = (this.legacyGrass = new Float32Array(N * N));
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const x = -half + ix * cell, z = -half + iz * cell, h = heights[i];
        const nx = H(ix - 1, iz) - H(ix + 1, iz), ny = 2 * cell, nz = H(ix, iz - 1) - H(ix, iz + 1);
        const slope = 1 - ny / Math.sqrt(nx * nx + ny * ny + nz * nz);
        let sand = smoothstep(3.2, 1.7, h);
        let rock = Math.min(1, smoothstep(0.2, 0.4, slope) + smoothstep(40, 52, h) * 0.8);
        let dirt = smoothstep(0.3, 0.5, noise.fbm(x * 0.018, z * 0.018, 3)) * 0.8;
        dirt = Math.max(dirt, houseMask[i] * 0.9);
        if (h > 1.8) dirt = Math.max(dirt, dirtMask[i]);
        sand = Math.min(1, sand * (1 - rock * 0.5));
        const grass = Math.max(0, 1 - sand - rock - dirt);
        const sum = sand + rock + dirt + grass || 1;
        let best = SI.grass, bw = grass;
        if (dirt > bw) { best = SI.dirt; bw = dirt; }
        if (sand > bw) { best = SI.sand; bw = sand; }
        if (rock > bw) { best = SI.rock; bw = rock; }
        out[i] = best;
        dens[i] = Math.max(0, (grass / sum) * 1.2 - 0.2) * (1 - houseMask[i]);
      }
    }
    void res;
    return out;
  }

  /** The info texture: R height, G grass density, B road (0..1), A grass tint id. */
  buildInfo() {
    const d = this.data;
    const { N, cell, half, heights } = d;
    const info = new Float32Array(N * N * 4);
    const surfKey = SURFACE_LAYERS;
    const biome = d.biome, roadMask = d.roadMask;
    // building footprints keep their floors free of grass
    const block = new Uint8Array(N * N);
    if (!this.legacy) {
      for (const hs of d.houses) {
        const b = hs.bounds || [hs.x - hs.hx, hs.z - hs.hz, hs.x + hs.hx, hs.z + hs.hz];
        const ix0 = Math.max(0, Math.floor((b[0] - 1 + half) / cell)), ix1 = Math.min(N - 1, Math.ceil((b[2] + 1 + half) / cell));
        const iz0 = Math.max(0, Math.floor((b[1] - 1 + half) / cell)), iz1 = Math.min(N - 1, Math.ceil((b[3] + 1 + half) / cell));
        for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) block[iz * N + ix] = 1;
      }
    }
    for (let i = 0; i < N * N; i++) {
      const h = heights[i];
      const key = surfKey[this.surf[i]];
      let g;
      if (this.legacy) g = this.legacyGrass[i];
      else {
        g = (GRASS[key] || 0) * (block[i] ? 0 : 1) * (roadMask && roadMask[i] ? 0 : 1);
        if (h < 0.4) g = 0;
      }
      const b = biome ? biome[i] : (h < 3 ? BI.beach : BI.meadow);
      info[i * 4] = h;
      info[i * 4 + 1] = g;
      info[i * 4 + 2] = roadMask ? (roadMask[i] ? 1 : 0) : 0;
      info[i * 4 + 3] = key === 'wheat' ? GRASS_TINT_WHEAT : b;
    }
    const half16 = new Uint16Array(info.length);
    for (let i = 0; i < info.length; i++) half16[i] = THREE.DataUtils.toHalfFloat(info[i]);
    const tex = new THREE.DataTexture(half16, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.infoTex = tex;
    // the layer index grid for the splat shader
    const idx = new THREE.DataTexture(this.surf, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    idx.magFilter = idx.minFilter = THREE.NearestFilter;
    idx.wrapS = idx.wrapT = THREE.ClampToEdgeWrapping;
    idx.generateMipmaps = false;
    idx.unpackAlignment = 1;
    idx.needsUpdate = true;
    this.idxTex = idx;
  }

  // ------------------------------------------------------------------ geometry
  buildGeometry() {
    const d = this.data;
    const { N, res, cell, half, heights } = d;
    const ts = Math.ceil(res / TILES);       // cells per tile
    this.ts = ts;
    this.tileM = ts * cell;
    // skirt vertices: one per grid point on each tile edge (both sides of a shared edge have their own)
    const edgeVerts = TILES * TILES * 4 * (ts + 1);
    const V = N * N + edgeVerts;
    const pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), col = new Uint8Array(V * 3);
    const H = (ix, iz) => heights[Math.min(N - 1, Math.max(0, iz)) * N + Math.min(N - 1, Math.max(0, ix))];
    const biome = d.biome, biome2 = d.biome2, blend = d.blend;
    const tint = BIOMES.map((k) => BIOME_TINT[k] || [1, 1, 1]);
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        pos[i * 3] = -half + ix * cell; pos[i * 3 + 1] = heights[i]; pos[i * 3 + 2] = -half + iz * cell;
        let nx = H(ix - 1, iz) - H(ix + 1, iz), ny = 2 * cell, nz = H(ix, iz - 1) - H(ix, iz + 1);
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= nl; ny /= nl; nz /= nl;
        nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
        let r = 1, g = 1, b = 1;
        if (biome) {
          const t1 = tint[biome[i]] || tint[0], t2 = biome2 ? tint[biome2[i]] || t1 : t1;
          const k = blend ? blend[i] / 255 : 1;
          r = t1[0] * k + t2[0] * (1 - k); g = t1[1] * k + t2[1] * (1 - k); b = t1[2] * k + t2[2] * (1 - k);
        }
        // vertex colours are 0..1 (Uint8 normalised); the shader scales them by 1/0.8 so tints above 1 work
        col[i * 3] = Math.min(255, r * 0.8 * 255); col[i * 3 + 1] = Math.min(255, g * 0.8 * 255); col[i * 3 + 2] = Math.min(255, b * 0.8 * 255);
      }
    }
    // skirts: tile t, side s (0 north z0, 1 south z1, 2 west x0, 3 east x1), k along the edge
    this.skirtBase = (t, s) => N * N + (t * 4 + s) * (ts + 1);
    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        const t = tz * TILES + tx;
        const x0 = Math.min(tx * ts, res), z0 = Math.min(tz * ts, res), x1 = Math.min(x0 + ts, res), z1 = Math.min(z0 + ts, res);
        for (let s = 0; s < 4; s++) {
          const base = this.skirtBase(t, s);
          for (let k = 0; k <= ts; k++) {
            let ix, iz;
            if (s === 0) { ix = Math.min(x0 + k, x1); iz = z0; } else if (s === 1) { ix = Math.min(x0 + k, x1); iz = z1; } else if (s === 2) { ix = x0; iz = Math.min(z0 + k, z1); } else { ix = x1; iz = Math.min(z0 + k, z1); }
            const src = iz * N + ix, v = base + k;
            pos[v * 3] = pos[src * 3]; pos[v * 3 + 1] = pos[src * 3 + 1] - SKIRT; pos[v * 3 + 2] = pos[src * 3 + 2];
            nor[v * 3] = nor[src * 3]; nor[v * 3 + 1] = nor[src * 3 + 1]; nor[v * 3 + 2] = nor[src * 3 + 2];
            col[v * 3] = col[src * 3]; col[v * 3 + 1] = col[src * 3 + 1]; col[v * 3 + 2] = col[src * 3 + 2];
          }
        }
      }
    }
    this.attrs = {
      position: new THREE.BufferAttribute(pos, 3),
      normal: new THREE.BufferAttribute(nor, 3),
      color: new THREE.BufferAttribute(col, 3, true),
    };
    // per tile: grid rectangle, height range, deep flag
    this.tiles = [];
    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        const x0 = Math.min(tx * ts, res), z0 = Math.min(tz * ts, res), x1 = Math.min(x0 + ts, res), z1 = Math.min(z0 + ts, res);
        let lo = Infinity, hi = -Infinity;
        for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) { const h = heights[iz * N + ix]; if (h < lo) lo = h; if (h > hi) hi = h; }
        this.tiles.push({
          t: tz * TILES + tx, x0, z0, x1, z1, lo: lo - SKIRT, hi, lod: -1,
          box: new THREE.Box3(new THREE.Vector3(-half + x0 * cell, lo - SKIRT, -half + z0 * cell), new THREE.Vector3(-half + x1 * cell, hi, -half + z1 * cell)),
          empty: x1 <= x0 || z1 <= z0 || hi < DEEP,
        });
      }
    }
  }

  /** Write tile t's indices at its LOD into arr from offset o; returns the new offset. */
  writeTile(tile, lod, arr, o) {
    const N = this.N, step = STEPS[lod];
    const { x0, z0, x1, z1 } = tile;
    // vertex columns / rows at this step, always ending on the tile edge
    const xs = [], zs = [];
    for (let x = x0; x < x1; x += step) xs.push(x);
    xs.push(x1);
    for (let z = z0; z < z1; z += step) zs.push(z);
    zs.push(z1);
    for (let j = 0; j < zs.length - 1; j++) {
      for (let i = 0; i < xs.length - 1; i++) {
        const a = zs[j] * N + xs[i], b = zs[j] * N + xs[i + 1], c = zs[j + 1] * N + xs[i], e = zs[j + 1] * N + xs[i + 1];
        arr[o++] = a; arr[o++] = c; arr[o++] = b;
        arr[o++] = b; arr[o++] = c; arr[o++] = e;
      }
    }
    // skirts: a strip from each edge down to its skirt copy (faces outward, drawn double-sided by
    // winding both ways would cost more; the outward side is the one ever seen through a crack)
    const t = tile.t;
    const edge = (s, list, fixed, along) => {
      const base = this.skirtBase(t, s);
      for (let k = 0; k < list.length - 1; k++) {
        const ka = list[k] - along, kb = list[k + 1] - along;
        const ga = s < 2 ? fixed * N + list[k] : list[k] * N + fixed;
        const gb = s < 2 ? fixed * N + list[k + 1] : list[k + 1] * N + fixed;
        const sa = base + ka, sb = base + kb;
        if (s === 0 || s === 3) { arr[o++] = ga; arr[o++] = gb; arr[o++] = sa; arr[o++] = gb; arr[o++] = sb; arr[o++] = sa; } else { arr[o++] = ga; arr[o++] = sa; arr[o++] = gb; arr[o++] = gb; arr[o++] = sa; arr[o++] = sb; }
      }
    };
    edge(0, xs, z0, x0);
    edge(1, xs, z1, x0);
    edge(2, zs, x0, z0);
    edge(3, zs, x1, z0);
    return o;
  }

  /** Indices of a tile at a LOD (an upper bound, for sizing). */
  tileCount(tile, lod) {
    const step = STEPS[lod];
    const nx = Math.ceil((tile.x1 - tile.x0) / step), nz = Math.ceil((tile.z1 - tile.z0) / step);
    return nx * nz * 6 + 2 * (nx + nz) * 6;
  }

  // ------------------------------------------------------------------ material
  buildMaterial() {
    const d = this.data;
    const L = this.T.layers;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, vertexColors: true });
    const n = SURFACE_LAYERS.length;
    const uv = new Float32Array(n), rough = new Float32Array(n);
    SURFACE_LAYERS.forEach((k, i) => { uv[i] = UV_SCALE[k] || 0.2; rough[i] = ROUGH[k] || 0.9; });
    const id = (k) => SURFACE_LAYERS.indexOf(k).toFixed(1);
    const uniforms = {
      tSurf: { value: L ? L.surfaces.albedo : null },
      tSurfN: { value: L ? L.surfaces.normal : null },
      tIdx: { value: this.idxTex },
      tMacro: { value: this.T.noise.map },
      uHalf: { value: d.half }, uCell: { value: d.cell }, uN: { value: d.N },
      uSea: { value: 0 }, uTime: { value: 0 },
      uUV: { value: Array.from(uv) }, uRough: { value: Array.from(rough) },
    };
    this.uniforms = uniforms;
    mat.userData.textures = L ? [L.surfaces.albedo, L.surfaces.normal] : [];
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTW;\nvarying vec3 vTN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray tSurf, tSurfN;
uniform sampler2D tIdx, tMacro;
uniform float uHalf, uCell, uN, uSea, uTime;
uniform float uUV[${n}], uRough[${n}];
varying vec3 vTW;
varying vec3 vTN;
float tId(ivec2 p) {
  int m = int(uN) - 1;
  p = clamp(p, ivec2(0), ivec2(m));
  return floor(texelFetch(tIdx, p, 0).r * 255.0 + 0.5);
}
vec4 tAlb(float id) { return texture(tSurf, vec3(vTW.xz * uUV[int(id)], id)); }
vec3 tNrm(float id) { return texture(tSurfN, vec3(vTW.xz * uUV[int(id)], id)).xyz * 2.0 - 1.0; }
`)
        .replace('#include <map_fragment>', `
// ---- splat: the 4 nearest grid points' layers, merged when equal
vec2 tg = (vTW.xz + uHalf) / uCell;
vec4 tmz = texture(tMacro, vTW.xz * 0.031);
tg += (tmz.rg - 0.5) * 1.1;
vec2 ti = floor(tg), tf = smoothstep(0.15, 0.85, tg - ti);
ivec2 tp = ivec2(ti);
float lA = tId(tp), lB = tId(tp + ivec2(1, 0)), lC = tId(tp + ivec2(0, 1)), lD = tId(tp + ivec2(1, 1));
float wA = (1.0 - tf.x) * (1.0 - tf.y), wB = tf.x * (1.0 - tf.y), wC = (1.0 - tf.x) * tf.y, wD = tf.x * tf.y;
float i1 = lA, i2 = -1.0, i3 = -1.0, i4 = -1.0;
float v1 = wA, v2 = 0.0, v3 = 0.0, v4 = 0.0;
if (lB == i1) v1 += wB; else { i2 = lB; v2 = wB; }
if (lC == i1) v1 += wC; else if (lC == i2) v2 += wC; else if (i2 < 0.0) { i2 = lC; v2 = wC; } else { i3 = lC; v3 = wC; }
if (lD == i1) v1 += wD; else if (lD == i2) v2 += wD; else if (lD == i3) v3 += wD; else if (i2 < 0.0) { i2 = lD; v2 = wD; } else if (i3 < 0.0) { i3 = lD; v3 = wD; } else { i4 = lD; v4 = wD; }
vec4 s1 = tAlb(i1), s2 = vec4(0.0), s3 = vec4(0.0), s4 = vec4(0.0);
if (i2 >= 0.0) s2 = tAlb(i2);
if (i3 >= 0.0) s3 = tAlb(i3);
if (i4 >= 0.0) s4 = tAlb(i4);
// height blend: the taller texture wins the border
float h1 = v1 + s1.a * 0.45, h2 = i2 >= 0.0 ? v2 + s2.a * 0.45 : -9.0, h3 = i3 >= 0.0 ? v3 + s3.a * 0.45 : -9.0, h4 = i4 >= 0.0 ? v4 + s4.a * 0.45 : -9.0;
float hm = max(max(h1, h2), max(h3, h4)) - 0.22;
v1 = max(h1 - hm, 0.0); v2 = max(h2 - hm, 0.0); v3 = max(h3 - hm, 0.0); v4 = max(h4 - hm, 0.0);
float vs = max(v1 + v2 + v3 + v4, 1e-4);
v1 /= vs; v2 /= vs; v3 /= vs; v4 /= vs;
vec3 tcol = s1.rgb * v1 + s2.rgb * v2 + s3.rgb * v3 + s4.rgb * v4;
vec3 tnrm = tNrm(i1) * v1;
if (v2 > 0.02) tnrm += tNrm(i2) * v2;
if (v3 > 0.02) tnrm += tNrm(i3) * v3;
if (v4 > 0.02) tnrm += tNrm(i4) * v4;
float tRough = uRough[int(i1)] * v1 + (i2 >= 0.0 ? uRough[int(i2)] * v2 : 0.0) + (i3 >= 0.0 ? uRough[int(i3)] * v3 : 0.0) + (i4 >= 0.0 ? uRough[int(i4)] * v4 : 0.0);
float tLava = (i1 == ${id('lava')} ? v1 * s1.a : 0.0) + (i2 == ${id('lava')} ? v2 * s2.a : 0.0) + (i3 == ${id('lava')} ? v3 * s3.a : 0.0) + (i4 == ${id('lava')} ? v4 * s4.a : 0.0);
float tSand = (i1 == ${id('sand')} ? v1 : 0.0) + (i2 == ${id('sand')} ? v2 : 0.0) + (i3 == ${id('sand')} ? v3 : 0.0) + (i4 == ${id('sand')} ? v4 : 0.0);
// ---- cliffs: triplanar rock (strata where the ground is mesa rock)
vec3 tgn = normalize(vTN);
float cliff = smoothstep(0.55, 0.72, 1.0 - tgn.y);
if (cliff > 0.01) {
  float cl = (i1 == ${id('strata')} || i1 == ${id('redsand')}) ? ${id('strata')} : (i1 == ${id('snow')} || i1 == ${id('ice')}) ? ${id('rock')} : (i1 == ${id('ash')} || i1 == ${id('lava')}) ? ${id('ash')} : ${id('rock')};
  float su = uUV[int(cl)] * 0.8;
  vec3 an = abs(tgn); an /= (an.x + an.z + 1e-4);
  vec4 cx = texture(tSurf, vec3(vTW.zy * su, cl)), cz = texture(tSurf, vec3(vTW.xy * su, cl));
  vec3 nx = texture(tSurfN, vec3(vTW.zy * su, cl)).xyz * 2.0 - 1.0, nz = texture(tSurfN, vec3(vTW.xy * su, cl)).xyz * 2.0 - 1.0;
  tcol = mix(tcol, cx.rgb * an.x + cz.rgb * an.z, cliff);
  tnrm = mix(tnrm, nx * an.x + nz * an.z, cliff);
  tRough = mix(tRough, 0.85, cliff);
}
// ---- large-scale variation and the shore
float macro = texture(tMacro, vTW.xz * 0.0033).r, macro2 = texture(tMacro, vTW.xz * 0.017).g;
tcol *= 0.84 + macro * 0.3;
tcol *= 0.9 + macro2 * 0.2;
float wet = (1.0 - smoothstep(uSea + 0.25, uSea + 1.4, vTW.y)) * tSand;
tcol *= 1.0 - wet * 0.38;
tRough = mix(tRough, 0.35, wet);
diffuseColor.rgb *= tcol * 1.25;
`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace('#include <normal_fragment_maps>', `
vec3 tT = normalize(vec3(1.0, 0.0, 0.0) - tgn * tgn.x);
vec3 tB = normalize(vec3(0.0, 0.0, 1.0) - tgn * tgn.z);
vec3 wN = normalize(tT * tnrm.x + tB * tnrm.y + tgn * max(tnrm.z, 0.25));
normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (tLava > 0.01) totalEmissiveRadiance += tcol * tLava * (2.2 + 0.8 * sin(uTime * 1.7 + vTW.x * 0.13 + vTW.z * 0.07));
`);
    };
    mat.customProgramCacheKey = () => 'terrain-splat-v2';
    this.mat = mat;
  }

  buildMeshes() {
    const d = this.data;
    this.root = new THREE.Group();
    this.root.name = 'terrain';
    this.groups = [];
    const G = TILES / 2;
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const tiles = [];
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(this.tiles[(gz * 2 + dz) * TILES + gx * 2 + dx]);
        const live = tiles.filter((t) => !t.empty);
        let max = 0;
        for (const t of live) max += this.tileCount(t, 0);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', this.attrs.position);
        geo.setAttribute('normal', this.attrs.normal);
        geo.setAttribute('color', this.attrs.color);
        const index = new THREE.BufferAttribute(new Uint32Array(Math.max(3, max)), 1);
        index.setUsage(THREE.DynamicDrawUsage);
        geo.setIndex(index);
        const box = new THREE.Box3();
        for (const t of live) box.union(t.box);
        if (live.length) {
          geo.boundingBox = box.clone();
          geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
        } else {
          geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
        }
        geo.setDrawRange(0, 0);
        const mesh = new THREE.Mesh(geo, this.mat);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.visible = live.length > 0;
        mesh.name = 'terrain';
        this.root.add(mesh);
        this.groups.push({ mesh, geo, tiles: live, dirty: true });
      }
    }
    void d;
  }

  /** Pick each tile's LOD from the camera (hysteresis) and rewrite the groups that changed. */
  update(camera, dt = 0) {
    this.uniforms.uTime.value += dt;
    const cp = camera.position;
    const tm = this.tileM;
    const D0 = Math.max(150, tm * 0.8), D1 = Math.max(380, tm * 2.0), HY = 18;
    for (const g of this.groups) {
      for (const t of g.tiles) {
        const b = t.box;
        const dx = Math.max(b.min.x - cp.x, 0, cp.x - b.max.x), dy = Math.max(b.min.y - cp.y, 0, cp.y - b.max.y), dz = Math.max(b.min.z - cp.z, 0, cp.z - b.max.z);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let lod = t.lod;
        if (lod < 0) lod = dist < D0 ? 0 : dist < D1 ? 1 : 2;
        else {
          if (lod === 0 && dist > D0 + HY) lod = 1;
          if (lod === 1 && dist < D0 - HY) lod = 0;
          else if (lod === 1 && dist > D1 + HY) lod = 2;
          if (lod === 2 && dist < D1 - HY) lod = dist < D0 - HY ? 0 : 1;
        }
        if (lod !== t.lod) { t.lod = lod; g.dirty = true; }
      }
      if (g.dirty) this.rebuild(g);
    }
  }

  rebuild(g) {
    g.dirty = false;
    const arr = g.geo.index.array;
    let o = 0;
    for (const t of g.tiles) o = this.writeTile(t, Math.max(0, t.lod), arr, o);
    g.geo.setDrawRange(0, o);
    const idx = g.geo.index;
    idx.clearUpdateRanges();
    idx.addUpdateRange(0, o);
    idx.needsUpdate = true;
  }

  /** Triangles drawn right now (all groups, before frustum culling). */
  triangles() {
    let n = 0;
    for (const g of this.groups) n += g.geo.drawRange.count / 3;
    return n;
  }

  // ------------------------------------------------------------------ roads
  /** Paved roads and streets as ribbons over the ground (lane lines along them). */
  buildRoads() {
    const d = this.data;
    const roads = (d.roads || []).filter((r) => !r.bridge && r.kind !== 'dirt' && r.pts && r.pts.length > 1);
    if (!roads.length || !this.T.layers) return;
    const pos = [], uv = [], nor = [], idx = [];
    const STEP = 3;
    for (const r of roads) {
      const w = (r.w || 8) / 2;
      // resample the centreline every STEP metres
      const pts = [];
      for (let k = 0; k < r.pts.length - 1; k++) {
        const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(L / STEP));
        for (let s = 0; s < n; s++) pts.push([ax + (bx - ax) * (s / n), az + (bz - az) * (s / n)]);
      }
      pts.push([r.pts[r.pts.length - 1][0], r.pts[r.pts.length - 1][1]]);
      let along = 0;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
        let tx = b[0] - a[0], tz = b[1] - a[1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        if (k > 0) along += Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]);
        const base = pos.length / 3;
        for (let s = -1; s <= 1; s++) {
          const x = p[0] - tz * w * s, z = p[1] + tx * w * s;
          pos.push(x, d.heightAt(x, z) + 0.06, z);
          nor.push(0, 1, 0);
          uv.push((s + 1) / 2, along / (r.w || 8));
        }
        if (k > 0) {
          const q = base - 3;
          for (let s = 0; s < 2; s++) idx.push(q + s, base + s, q + s + 1, q + s + 1, base + s, base + s + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const L = this.T.layers;
    const layer = SURFACE_LAYERS.indexOf('asphaltLines');
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.tSurf = { value: L.surfaces.albedo };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray tSurf;\nvarying vec2 vRUv;')
        .replace('#include <map_fragment>', `diffuseColor.rgb *= texture(tSurf, vec3(vRUv, ${layer}.0)).rgb * 1.1;`);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vRUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRUv = uv;');
    };
    mat.customProgramCacheKey = () => 'road-ribbon';
    mat.userData.textures = [L.surfaces.albedo];
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'roads';
    this.roads = mesh;
    this.root.add(mesh);
  }

  // ------------------------------------------------------------------ physics
  buildPhysics() {
    const d = this.data;
    const { N, res, heights } = d;
    const physics = this.world.physics;
    const R = physics.R;
    // Rapier wants column-major: index = zi + xi * N
    const hf = new Float32Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) hf[iz + ix * N] = heights[iz * N + ix];
    physics.collider(R.ColliderDesc.heightfield(res, res, hf, { x: d.size, y: 1, z: d.size }).setFriction(0.9), { kind: 'terrain' }, undefined, GROUP.WORLD);
    // sea floor safety net
    physics.collider(R.ColliderDesc.cuboid(d.size, 1, d.size).setTranslation(0, -18, 0), { kind: 'terrain' }, undefined, GROUP.WORLD);
  }

  // ------------------------------------------------------------------ queries
  /** Surface key (SURFACES) under a point. */
  surfaceKeyAt(x, z) {
    const d = this.data;
    const ix = Math.round((x + d.half) / d.cell), iz = Math.round((z + d.half) / d.cell);
    if (ix < 0 || iz < 0 || ix >= d.N || iz >= d.N) return 'sand';
    return SURFACE_LAYERS[this.surf[iz * d.N + ix]] || 'grass';
  }

  /** Footstep / impact kind under a point: grass | dirt | sand | stone | snow (keys.js STEP_SOUND). */
  surfaceAt(x, z) {
    const k = this.surfaceKeyAt(x, z);
    if (this.legacy) return k === 'rock' ? 'rock' : k;
    return STEP_SOUND[k] || 'grass';
  }

  setSeaLevel(y) { this.uniforms.uSea.value = y; }

  /** The new textures arrived: nothing to do (the arrays are the same objects). */
  dispose() {
    for (const g of this.groups) g.geo.dispose();
    this.mat.dispose();
    if (this.roads) { this.roads.geometry.dispose(); this.roads.material.dispose(); }
  }
}
