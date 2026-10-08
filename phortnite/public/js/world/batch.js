// Buildings and props, batched: every building part and prop of a 128 m chunk goes into one mesh
// (one material for every look: a texture array indexed by a per-vertex layer), with the glass of
// the chunk in a second, see-through mesh. Parts are written straight into typed arrays.
// Chunks further than the near distance are hidden and their buildings drawn as simple boxes
// (HLOD proxies: 10 triangles per building, all in one mesh), so a view from the bus costs a
// couple of draw calls for every building on the island.
//
// Destruction: setVisible(id, false) collapses an object's vertices (its triangles vanish) and
// setVisible(id, true) writes them again, with no extra draw calls.
import * as THREE from 'three';
import * as M from './models.js';
import { lookLayer } from '../gfx/textures.js';

export const BATCH_CHUNK = 128;
const PAINTS = [0xf1e7d0, 0x9fc6ea, 0xf3d473, 0xb7dca0];
const ROOFS = [0xa53c2b, 0x3e5574, 0x6c4a32, 0x4b6f3d];
const STUCCO = [0xfff4e4, 0xf7dccb, 0xe4efd9, 0xdde7f2];
const CONTAINERS = [0xc0392b, 0x2e6db4, 0x3f8f4f, 0xe08a1e];
const CARS = [0xd23c2c, 0x2e7dd1, 0xf0c419, 0xeeeeee, 0x37a35a];
const PLAIN = 255;     // layer value: no texture (vertex colour only)
const GLOW = 128;      // layer flag: emissive
/** Props that wear a building look (the rest are plain vertex colours). */
const PROP_LOOK = { container: 'corrugated', crate: 'planks', fence: 'planks', bench: 'planks', stall: 'planks', sign: 'panel', dumpster: 'metalwall' };

/** The colour a part is painted (vertex colour, multiplied with its look's texture). */
export function partColor(o, house) {
  if (o.tint !== undefined && o.tint !== null) return o.tint;
  const paint = (o.paint ?? (house && house.paint) ?? 0) | 0;
  switch (o.look) {
    case 'siding': return PAINTS[paint % PAINTS.length];
    case 'roof': return ROOFS[paint % ROOFS.length];
    case 'metalwall': return 0xa3b4c2;
    case 'trim': return house && house.style === 'metal' ? 0x6d7b88 : 0xf6f3ec;
    case 'foundation': return 0xb3ada2;
    case 'slab': return 0xd2cdc3;
    case 'stucco': return STUCCO[paint % STUCCO.length];
    default: return 0xffffff;
  }
}

const _c = new THREE.Color();
const _m = new THREE.Matrix4();

class Chunk {
  constructor(key, cx, cz) {
    this.key = key; this.cx = cx; this.cz = cz;
    this.items = [];      // flat [o, which (0 opaque / 1 glass), geometry | null, ...]
    this.verts = [0, 0];
    this.inds = [0, 0];
    this.meshes = [null, null];
    this.near = true;
    this.houses = [];     // houses whose centre is in this chunk (their HLOD proxies)
  }
}

export class Batch {
  /**
   * @param {object} world   { data, root, T }
   * @param {object} opts    { near: metres (HLOD beyond) }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.data = world.data;
    this.near = opts.near || 280;
    this.ranges = new Map();  // id -> { c, which, start, count, hidden }
    this.chunks = new Map();  // key -> Chunk
    this.list = [];
    this.meshes = [];
    this.layers = world.T && world.T.layers;
    this.materials = [this.makeMaterial(false), this.makeMaterial(true)];
    this.writeMs = 0;
    this.A = M.writePart && M.partArrays ? M.partArrays(1, true) : null;
  }

  // ------------------------------------------------------------------ materials
  makeMaterial(glass) {
    const L = this.layers;
    const mat = new THREE.MeshStandardMaterial(glass
      ? { vertexColors: true, roughness: 0.08, metalness: 0.15, transparent: true, opacity: 0.42, depthWrite: false, envMapIntensity: 1.6 }
      : { vertexColors: true, roughness: 0.82, metalness: 0 });
    const uniforms = {
      tLooks: { value: L ? L.looks.albedo : null },
      tLooksN: { value: L ? L.looks.normal : null },
    };
    mat.userData.textures = L ? [L.looks.albedo, L.looks.normal] : [];
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aLayer;\nvarying float vLayer;\nvarying float vGlow;\nvarying vec2 vLUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLUv = uv;\nvGlow = aLayer >= 127.5 && aLayer < 254.5 ? 1.0 : 0.0;\nvLayer = aLayer >= 254.5 ? -1.0 : aLayer - vGlow * 128.0;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2DArray tLooks, tLooksN;
varying float vLayer;
varying float vGlow;
varying vec2 vLUv;
mat3 lookFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz), q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st), st1 = dFdy(uv.st);
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}`)
        .replace('#include <map_fragment>', `
float lL = floor(vLayer + 0.5);
vec4 lTex = lL >= 0.0 ? texture(tLooks, vec3(vLUv, lL)) : vec4(1.0);
diffuseColor.rgb *= lTex.rgb;
`)
        .replace('#include <normal_fragment_maps>', `
if (lL >= 0.0) {
  vec3 lN = texture(tLooksN, vec3(vLUv, lL)).xyz * 2.0 - 1.0;
  lN.xy *= 0.9;
  normal = normalize(lookFrame(-vViewPosition, normal, vLUv) * lN);
}
`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * 2.2;');
    };
    mat.customProgramCacheKey = () => (glass ? 'looks-glass' : 'looks');
    return mat;
  }

  // ------------------------------------------------------------------ build
  chunkOf(x, z) {
    const h = this.data.half;
    const cx = Math.floor((x + h) / BATCH_CHUNK), cz = Math.floor((z + h) / BATCH_CHUNK);
    const key = cz * 1000 + cx;
    let c = this.chunks.get(key);
    if (!c) { c = new Chunk(key, cx, cz); this.chunks.set(key, c); this.list.push(c); }
    return c;
  }

  /** Geometry of a prop, positioned in the world. */
  propGeometry(o) {
    let g;
    if (M.propGeometry) {
      g = M.propGeometry(o.type, o.color | 0).clone();
      _m.makeRotationY(o.yaw || 0).setPosition(o.x, o.y - (o.hy || 0), o.z);
      g.applyMatrix4(_m);
    } else if (o.type === 'container') {
      g = M.containerGeometry(o, CONTAINERS[(o.color | 0) % CONTAINERS.length]);
    } else if (o.type === 'car') {
      g = M.carGeometry(CARS[(o.color | 0) % CARS.length]);
      g.rotateY(o.yaw || 0);
      g.translate(o.x, o.y, o.z);
    } else {
      g = M.crateGeometry();
      if (o.yaw) g.rotateY(o.yaw);
      g.translate(o.x, o.y, o.z);
    }
    return g;
  }

  /** Add every part and prop of the world and build the chunk meshes. */
  build(objects) {
    const t0 = performance.now();
    const fast = !!this.A;
    const houses = this.data.houses;
    for (const o of objects) {
      if (o.kind !== 'part' && o.kind !== 'prop') continue;
      const c = this.chunkOf(o.x, o.z);
      if (o.kind === 'part') {
        const which = o.look === 'glass' ? 1 : 0;
        const geo = fast ? null : M.partGeometry(o, partColor(o, houses[o.house]));
        c.items.push(o, which, geo);
        c.verts[which] += geo ? geo.attributes.position.count : M.PART_VERTS || 24;
        c.inds[which] += geo ? geo.index.count : M.PART_INDICES || 36;
      } else {
        const geo = this.propGeometry(o);
        c.items.push(o, 0, geo);
        c.verts[0] += geo.attributes.position.count;
        c.inds[0] += geo.index ? geo.index.count : geo.attributes.position.count;
      }
    }
    for (const c of this.list) this.writeChunk(c);
    houses.forEach((h, i) => this.chunkOf(h.x, h.z).houses.push(i));
    this.buildHlod();
    this.writeMs = performance.now() - t0;
    return this.meshes;
  }

  writeChunk(c) {
    for (let which = 0; which < 2; which++) {
      const V = c.verts[which], I = c.inds[which];
      if (!V) continue;
      const arr = {
        pos: new Float32Array(V * 3), nor: new Int8Array(V * 3), uv: new Float32Array(V * 2), col: new Uint8Array(V * 3), layer: new Uint8Array(V),
        idx: V > 65535 ? new Uint32Array(I) : new Uint16Array(I), v: 0, i: 0,
      };
      const items = c.items;
      for (let k = 0; k < items.length; k += 3) {
        if (items[k + 1] !== which) continue;
        const o = items[k];
        const v0 = arr.v;
        this.writeObject(arr, o, items[k + 2], true);
        this.ranges.set(o.id, { c, which, start: v0, count: arr.v - v0, hidden: false });
      }
      const geo = new THREE.BufferGeometry();
      const pa = new THREE.BufferAttribute(arr.pos, 3);
      pa.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pa);
      geo.setAttribute('normal', new THREE.BufferAttribute(arr.nor, 3, true));
      geo.setAttribute('uv', new THREE.BufferAttribute(arr.uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(arr.col, 3, true));
      geo.setAttribute('aLayer', new THREE.BufferAttribute(arr.layer, 1));
      geo.setIndex(new THREE.BufferAttribute(arr.idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, this.materials[which]);
      mesh.castShadow = which === 0;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = which ? 'glass' : 'buildings';
      if (which) mesh.renderOrder = 2;
      this.world.root.add(mesh);
      c.meshes[which] = mesh;
      this.meshes.push(mesh);
    }
    // the geometries the slow path built are not needed any more
    for (let k = 2; k < c.items.length; k += 3) if (c.items[k]) { c.items[k].dispose(); c.items[k] = null; }
    c.items = null;
  }

  /**
   * Write one object's vertices into arr at arr.v (and its indices at arr.i when withIndex).
   * Parts go through models.js writePart when it has one; anything else is copied from a geometry.
   */
  writeObject(arr, o, geo, withIndex) {
    const house = this.data.houses[o.house];
    const glow = o.glow ? GLOW : 0;
    if (o.kind === 'part' && !geo && this.A) {
      const A = this.A;
      A.v = 0; A.i = 0;
      const layer = lookLayer(o.look);
      M.writePart(A, o, partColor(o, house), undefined, layer);
      this.copy(arr, A.pos, A.nor, A.uv, A.col, A.v, A.idx, A.i, layer + glow, withIndex);
      return;
    }
    const g = geo || (o.kind === 'part' ? M.partGeometry(o, partColor(o, house)) : this.propGeometry(o));
    const a = g.attributes;
    const layer = o.kind === 'part' ? lookLayer(o.look) + glow : (PROP_LOOK[o.type] ? lookLayer(PROP_LOOK[o.type]) : PLAIN);
    const idx = g.index ? g.index.array : null;
    this.copy(arr, a.position.array, a.normal.array, a.uv.array, a.color.array, a.position.count, idx, idx ? idx.length : 0, layer, withIndex);
    if (!geo) g.dispose();
  }

  copy(arr, pos, nor, uv, col, nv, idx, ni, layer, withIndex) {
    const v0 = arr.v;
    arr.pos.set(pos.length === nv * 3 ? pos : pos.subarray(0, nv * 3), v0 * 3);
    arr.uv.set(uv.length === nv * 2 ? uv : uv.subarray(0, nv * 2), v0 * 2);
    const N = arr.nor, C = arr.col, Lr = arr.layer;
    for (let k = 0; k < nv; k++) {
      const s = k * 3, d = (v0 + k) * 3;
      N[d] = nor[s] * 127; N[d + 1] = nor[s + 1] * 127; N[d + 2] = nor[s + 2] * 127;
      C[d] = Math.min(255, col[s] * 255); C[d + 1] = Math.min(255, col[s + 1] * 255); C[d + 2] = Math.min(255, col[s + 2] * 255);
      Lr[v0 + k] = layer;
    }
    if (withIndex) {
      const I = arr.idx;
      if (idx) for (let k = 0; k < ni; k++) I[arr.i + k] = idx[k] + v0;
      else for (let k = 0; k < nv; k++) I[arr.i + k] = v0 + k;
      arr.i += idx ? ni : nv;
    }
    arr.v += nv;
  }

  // ------------------------------------------------------------------ HLOD
  /** One box per building (walls + roof, 10 triangles) for chunks beyond the near distance. */
  buildHlod() {
    const d = this.data;
    const H = d.houses;
    if (!H.length) return;
    // per house: bounds, top and average colours from its parts
    const info = H.map(() => ({ x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity, wall: [0, 0, 0, 0], roof: [0, 0, 0, 0] }));
    const avg = this.layers ? this.layers.looks.avg : null;
    for (const o of d.objects) {
      if (o.kind !== 'part' || o.house === undefined || !info[o.house] || o.look === 'glass') continue;
      const I = info[o.house];
      const hx = o.hx || 0.5, hy = o.hy || 0.5, hz = o.hz || 0.5;
      const bb = o.bb;
      const x0 = bb ? bb[0] : o.x - hx, x1 = bb ? bb[3] : o.x + hx;
      const z0 = bb ? bb[2] : o.z - hz, z1 = bb ? bb[5] : o.z + hz;
      const y0 = bb ? bb[1] : o.y - hy, y1 = bb ? bb[4] : o.y + hy;
      if (o.shape !== 'prism') {
        if (x0 < I.x0) I.x0 = x0;
        if (x1 > I.x1) I.x1 = x1;
        if (z0 < I.z0) I.z0 = z0;
        if (z1 > I.z1) I.z1 = z1;
        if (y0 < I.y0) I.y0 = y0;
      }
      if (y1 > I.y1) I.y1 = y1;
      _c.setHex(partColor(o, H[o.house]));
      const a = avg ? avg[lookLayer(o.look)] : [0.6, 0.6, 0.6];
      const area = hx * hy + hz * hy + hx * hz;
      const isRoof = o.look === 'roof' || o.look === 'shingle' || o.look === 'rooftile' || o.shape === 'prism' || !!o.ax;
      const t = isRoof ? I.roof : I.wall;
      t[0] += _c.r * a[0] * area; t[1] += _c.g * a[1] * area; t[2] += _c.b * a[2] * area; t[3] += area;
    }
    const n = H.length;
    const pos = new Float32Array(n * 20 * 3), nor = new Int8Array(n * 20 * 3), col = new Uint8Array(n * 20 * 3);
    const idx = n * 20 > 65535 ? new Uint32Array(n * 30) : new Uint16Array(n * 30);
    const faces = [ // outward normal, then corners (0 = min, 1 = max on x, y, z)
      [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
      [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
      [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
      [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
      [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    ];
    let v = 0, k = 0;
    this.hlodOf = new Int32Array(n);
    for (let h = 0; h < n; h++) {
      const I = info[h];
      this.hlodOf[h] = v;
      if (!(I.x1 > I.x0)) { I.x0 = I.x1 = H[h].x; I.z0 = I.z1 = H[h].z; I.y0 = I.y1 = H[h].y || 0; }
      const w = I.wall[3] ? [I.wall[0] / I.wall[3], I.wall[1] / I.wall[3], I.wall[2] / I.wall[3]] : [0.5, 0.48, 0.45];
      const r = I.roof[3] ? [I.roof[0] / I.roof[3], I.roof[1] / I.roof[3], I.roof[2] / I.roof[3]] : [w[0] * 0.8, w[1] * 0.8, w[2] * 0.8];
      const X = [I.x0, I.x1], Y = [I.y0, I.y1], Z = [I.z0, I.z1];
      for (let f = 0; f < 5; f++) {
        const [nn, cs] = faces[f];
        const cc = f === 4 ? r : w;
        const base = v;
        for (const [cx, cy, cz] of cs) {
          pos[v * 3] = X[cx]; pos[v * 3 + 1] = Y[cy]; pos[v * 3 + 2] = Z[cz];
          nor[v * 3] = nn[0] * 127; nor[v * 3 + 1] = nn[1] * 127; nor[v * 3 + 2] = nn[2] * 127;
          col[v * 3] = Math.min(255, cc[0] * 255); col[v * 3 + 1] = Math.min(255, cc[1] * 255); col[v * 3 + 2] = Math.min(255, cc[2] * 255);
          v++;
        }
        idx[k++] = base; idx[k++] = base + 1; idx[k++] = base + 2; idx[k++] = base; idx[k++] = base + 2; idx[k++] = base + 3;
      }
    }
    this.hlodOrig = pos.slice();
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
    mesh.matrixAutoUpdate = false;
    mesh.name = 'hlod';
    mesh.frustumCulled = false;
    this.world.root.add(mesh);
    this.hlod = mesh;
    // every proxy starts hidden (every chunk starts near); update() shows the far ones
    this.hlodShown = new Uint8Array(n).fill(1);
    for (let h = 0; h < n; h++) this.showProxy(h, false);
  }

  showProxy(h, on) {
    if (!this.hlod || !!this.hlodShown[h] === on) return;
    this.hlodShown[h] = on ? 1 : 0;
    const arr = this.hlod.geometry.attributes.position.array;
    const o = this.hlodOf[h] * 3;
    if (on) arr.set(this.hlodOrig.subarray(o, o + 60), o);
    else for (let k = 3; k < 60; k++) arr[o + k] = arr[o + (k % 3)];
    this.hlodDirty = true;
  }

  // ------------------------------------------------------------------ per frame
  /** Near chunks draw in full; far ones only through the HLOD boxes. */
  update(camera) {
    const cp = camera.position, R = this.near, HY = 20;
    const h = this.data.half;
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i];
      const x0 = -h + c.cx * BATCH_CHUNK, z0 = -h + c.cz * BATCH_CHUNK;
      const dx = Math.max(x0 - cp.x, 0, cp.x - x0 - BATCH_CHUNK), dz = Math.max(z0 - cp.z, 0, cp.z - z0 - BATCH_CHUNK);
      const bb = c.meshes[0] ? c.meshes[0].geometry.boundingBox : null;
      const dy = bb ? Math.max(bb.min.y - cp.y, 0, cp.y - bb.max.y) : 0;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const near = c.near ? d < R + HY : d < R - HY;
      if (near === c.near) continue;
      c.near = near;
      if (c.meshes[0]) c.meshes[0].visible = near;
      if (c.meshes[1]) c.meshes[1].visible = near;
      for (const hId of c.houses) this.showProxy(hId, !near);
    }
    if (this.hlodDirty && this.hlod) {
      this.hlodDirty = false;
      this.hlod.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ destruction
  setVisible(id, visible) {
    const r = this.ranges.get(id);
    if (!r || r.hidden === !visible) return;
    const mesh = r.c.meshes[r.which];
    if (!mesh) return;
    r.hidden = !visible;
    const attr = mesh.geometry.attributes.position;
    const arr = attr.array;
    const o = r.start * 3, count = r.count;
    if (visible) {
      // write the object again (only positions ever change)
      const tmp = { pos: new Float32Array(count * 3), nor: new Int8Array(count * 3), uv: new Float32Array(count * 2), col: new Uint8Array(count * 3), layer: new Uint8Array(count), idx: null, v: 0, i: 0 };
      this.writeObject(tmp, this.data.objects[id], null, false);
      arr.set(tmp.pos, o);
    } else {
      const x = arr[o], y = arr[o + 1], z = arr[o + 2];
      for (let k = 1; k < count; k++) { arr[o + k * 3] = x; arr[o + k * 3 + 1] = y; arr[o + k * 3 + 2] = z; }
    }
    attr.addUpdateRange(o, count * 3);
    attr.needsUpdate = true;
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); this.world.root.remove(m); }
    if (this.hlod) { this.hlod.geometry.dispose(); this.hlod.material.dispose(); this.world.root.remove(this.hlod); }
    for (const m of this.materials) m.dispose();
  }
}
