// Procedural 3D models (geometry only). Everything is built from primitives at load time.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPECIES_TYPE } from '../../shared/world/keys.js';

const _c = new THREE.Color();

/** Ensure position/normal/uv/color attributes exist (needed for merging). */
export function normalizeGeo(g, color = 0xffffff) {
  if (g.index === null) {
    // keep non-indexed; mergeGeometries requires consistency so we index everything
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.attributes.color) paint(g, color);
  for (const k of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
  }
  return g;
}

export function paint(g, color, jitter = 0, seed = 1) {
  _c.set(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  let s = seed;
  for (let i = 0; i < n; i++) {
    let k = 1;
    if (jitter) { s = (s * 16807) % 2147483647; k = 1 - jitter / 2 + (s / 2147483647) * jitter; }
    arr[i * 3] = _c.r * k; arr[i * 3 + 1] = _c.g * k; arr[i * 3 + 2] = _c.b * k;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

export function merge(list) {
  return mergeGeometries(list.map((g) => normalizeGeo(g)), false);
}

/** Planar UVs in metres picked by the dominant normal axis. */
export function worldUV(g, scale, offset = [0, 0, 0], swap = false) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = g.attributes.uv || new THREE.Float32BufferAttribute(new Float32Array(p.count * 2), 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + offset[0], y = p.getY(i) + offset[1], z = p.getZ(i) + offset[2];
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = z; v = y; } else if (ay >= az) { u = swap ? z : x; v = swap ? x : z; } else { u = x; v = y; }
    uv.setXY(i, u / scale, v / scale);
  }
  g.setAttribute('uv', uv);
  return g;
}

// ------------------------------------------------------------------ house parts
const UV_SCALE = {
  siding: 2.6, brick: 2.2, metalwall: 3, roof: 2.4, floor: 2.6, foundation: 4, slab: 4, trim: 2,
  glass: 4, stucco: 3, adobe: 3, logs: 2.4, planks: 2.6, corrugated: 3, rooftile: 2.4, shingle: 2.4, sandstone: 3,
  concrete: 4, panel: 4, ice: 3, castle: 3.2,
};
/** Metres per texture repeat for a part look (unknown looks: 3). */
export const uvScaleOf = (look) => UV_SCALE[look] || 3;

export function partGeometry(o, color) {
  let g;
  const scale = UV_SCALE[o.look] || 3;
  if (o.shape === 'prism') {
    const p = o.pts;
    const P = (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    const [a, b, c, d, e, f] = [0, 1, 2, 3, 4, 5].map(P);
    const tris = [[a, b, c], [d, f, e], [a, d, e], [a, e, b], [b, e, f], [b, f, c], [c, f, d], [c, d, a]];
    const cx = o.x, cy = o.y, cz = o.z;
    const pos = [];
    for (const t of tris) {
      // orient outward
      const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
      const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const mx = (t[0][0] + t[1][0] + t[2][0]) / 3 - cx, my = (t[0][1] + t[1][1] + t[2][1]) / 3 - cy, mz = (t[0][2] + t[1][2] + t[2][2]) / 3 - cz;
      const order = nx * mx + ny * my + nz * mz >= 0 ? [0, 1, 2] : [0, 2, 1];
      for (const k of order) pos.push(...t[k]);
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    worldUV(g, scale);
  } else {
    g = new THREE.BoxGeometry(o.hx * 2, o.hy * 2, o.hz * 2);
    worldUV(g, scale, [o.x, o.y, o.z], o.ax === 'z');
    if (o.ax) {
      const m = new THREE.Matrix4();
      if (o.ax === 'x') m.makeRotationX(o.ang); else m.makeRotationZ(o.ang);
      g.applyMatrix4(m);
    }
    g.translate(o.x, o.y, o.z);
  }
  paint(g, color);
  return normalizeGeo(g);
}

// ------------------------------------------------------------------ trees
// Ten species (shared/world/keys.js SPECIES) in three levels of detail:
//   lod 0: the full model, at most 420 triangles; lod 1: 40-120 triangles; lod 2: two crossed
//   silhouette cards, at most 12 triangles. Foliage gets planar (box-projected) UVs and vertex
//   colours with ambient occlusion baked in (darker low and inside the crown).
// treeGeometry(type, lod) returns { trunk, leaves } (the trunk takes the bark material, the leaves
// the foliage material; SPECIES_INFO says which species want double-sided leaves at lod 0 / 1;
// lod 2 cards are already wound both ways: draw them with a single-sided material).

let _seed = 1;
const rnd = () => ((_seed = (_seed * 16807) % 2147483647) / 2147483647);

function jitterGeo(g, amount, seed) {
  const p = g.attributes.position;
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = map.get(key);
    if (!d) map.set(key, (d = [r() * amount, r() * amount * 0.6, r() * amount]));
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  g.computeVertexNormals();
  return g;
}

/** Bottom-to-top colour ramp with baked ambient occlusion: darker low in the crown and toward its axis. */
function foliageColor(g, bottom, top, y0, y1, R = 2.5, snow = 0, seed = 3) {
  const cb = new THREE.Color(bottom), ct = new THREE.Color(top), white = new THREE.Color(0xf4f8ff);
  const p = g.attributes.position, n = g.attributes.normal;
  const arr = new Float32Array(p.count * 3);
  let s = seed;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), x = p.getX(i), z = p.getZ(i);
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    const outer = Math.min(1, Math.sqrt(x * x + z * z) / R);
    const ao = (0.62 + 0.38 * outer) * (0.78 + 0.22 * t);
    s = (s * 16807) % 2147483647;
    const j = 0.94 + (s / 2147483647) * 0.12;
    _c.copy(cb).lerp(ct, t).multiplyScalar(ao * j);
    if (snow && n && n.getY(i) > 0.5) {
      // snow sits on the upward-facing outer parts, in patches
      const patch = Math.sin(x * 2.3 + z * 1.7 + y * 3.1) * 0.5 + 0.5;
      _c.lerp(white, Math.min(1, (n.getY(i) - 0.5) * 3) * snow * (0.35 + 0.65 * patch) * outer);
    }
    arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

/** Bark colour with a little AO at the foot (and optional dark birch bands). */
function barkColor(g, hex, bands = false) {
  const c0 = new THREE.Color(hex);
  const p = g.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    let k = 0.7 + 0.3 * Math.min(1, y / 1.5);
    if (bands && Math.sin(y * 7.3 + p.getX(i) * 3) > 0.82) k *= 0.35;
    arr[i * 3] = c0.r * k; arr[i * 3 + 1] = c0.g * k; arr[i * 3 + 2] = c0.b * k;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

const cyl = (rt, rb, h, sides, segs, y0 = 0) => { const g = new THREE.CylinderGeometry(rt, rb, h, sides, segs, true); g.translate(0, y0 + h / 2, 0); return g; };
const cone = (r, h, sides, segs, y0) => { const g = new THREE.ConeGeometry(r, h, sides, segs, false); g.translate(0, y0 + h / 2, 0); return g; };
const ico = (r, detail, x, y, z, sx = 1, sy = 1, sz = 1) => { const g = new THREE.IcosahedronGeometry(r, detail); g.scale(sx, sy, sz); g.translate(x, y, z); return g; };
/** A branch: a thin open cylinder from (0, y, 0) leaning out by tilt toward angle a. */
const branch = (r0, r1, len, y, a, tilt, sides = 5) => {
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true);
  g.translate(0, len / 2, 0); g.rotateZ(tilt); g.rotateY(a); g.translate(0, y, 0);
  return g;
};

/** An empty geometry with the usual attributes (a LOD without a trunk). */
function emptyGeo() {
  const g = new THREE.BufferGeometry();
  for (const [k, n] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) g.setAttribute(k, new THREE.Float32BufferAttribute([], n));
  g.setIndex([]);
  return g;
}

/**
 * Two crossed silhouette cards (lod 2), at most 12 triangles: each card is a convex crown outline
 * (triangulated as a fan from its first point) written with both windings and up-facing normals,
 * so it reads the same from every side with a single-sided material and never goes dark edge-on.
 * trunk: [w, h] adds a trunk quad (pines), otherwise the trunk is empty.
 */
function cards(outline, y0, y1, cBottom, cTop, trunkWH, bark) {
  const crown = [], stems = [];
  for (const rot of [0, Math.PI / 2]) {
    const pos = [];
    for (let i = 1; i < outline.length - 1; i++) {
      const a = outline[0], b = outline[i], c = outline[i + 1];
      pos.push(a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0);   // front
      pos.push(a[0], a[1], 0, c[0], c[1], 0, b[0], b[1], 0);   // back
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // UVs across the card (x, y before turning it), normals up
    const uvs = [];
    for (let k = 0; k < pos.length; k += 3) uvs.push(pos[k] / 2.5, pos[k + 1] / 2.5);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    g.rotateY(rot);
    foliageColor(g, cBottom, cTop, y0, y1, 0.5, 0, 9);
    crown.push(g);
    if (trunkWH) {
      const [w, h] = trunkWH;
      const t = new THREE.BufferGeometry();
      t.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, w, h, 0, -w, 0, 0, w, h, 0, w, 0, 0], 3));
      t.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      t.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, w, 0, w, h, 0, 0, w, h, w, 0].map((v) => v / 1.2), 2));
      t.rotateY(rot);
      barkColor(t, bark);
      stems.push(t);
    }
  }
  return { trunk: stems.length ? merge(stems) : emptyGeo(), leaves: merge(crown) };
}

const LEG = ['pine', 'oak', 'palm'];

function pine(lod, snow) {
  const trunk = [], leaves = [];
  const g0 = snow ? 0x1e4a32 : 0x1a5230, g1 = snow ? 0x3f7a55 : 0x3f8f45;
  if (lod === 2) return cards([[-2.7, 1.4], [2.7, 1.4], [0, 8.6]], 1.4, 8.6, snow ? 0x5a7a6a : g0, snow ? 0xd8e4ea : g1, [0.25, 1.6], 0x6b4a2e);
  trunk.push(barkColor(cyl(0.17, 0.32, 4.2, lod ? 5 : 6, 1), 0xffffff));
  const layers = lod ? [[2.7, 3.6, 1.6], [1.8, 3.4, 4.6]] : [[2.7, 3.1, 1.6], [2.2, 2.8, 3.0], [1.65, 2.5, 4.6], [1.05, 2.2, 6.1]];
  layers.forEach(([r, h, y], i) => {
    const c = cone(r, h, lod ? 8 : 10, lod ? 1 : 2, y);
    if (!lod) jitterGeo(c, 0.32, 7 + i);
    worldUV(c, 1.6);
    leaves.push(foliageColor(c, g0, g1, 1.2, 8.4, 2.6, snow ? 0.9 : 0, 5 + i));
  });
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function oak(lod, birch = false) {
  const trunk = [], leaves = [];
  const g0 = birch ? 0x3f7f2a : 0x255f24, g1 = birch ? 0x9ed05a : 0x6fae3e;
  const bark = birch ? 0xf2efe6 : 0xffffff;
  if (lod === 2) {
    return cards(birch
      ? [[-0.25, 0], [-1.9, 4.6], [0, 7.8], [1.9, 4.6], [0.25, 0]]
      : [[-0.35, 0], [-3.0, 4.4], [0, 7.4], [3.0, 4.4], [0.35, 0]], 0, 7.6, birch ? 0x6a6a5a : 0x4a4030, g1);
  }
  if (birch) {
    trunk.push(barkColor(cyl(0.13, 0.22, 5.6, lod ? 4 : 6, lod ? 1 : 3), bark, true));
    if (!lod) for (const [a, t] of [[0.9, 0.6], [3.4, 0.7]]) trunk.push(barkColor(branch(0.09, 0.05, 1.3, 3.4, a, t), bark));
    const blobs = lod ? [[0, 5.6, 0, 1.5, 0, 1.6], [0.4, 4.3, 0.2, 1.3, 0, 1.4]] : [[0, 6.0, 0, 1.45, 1, 1.5], [0.8, 4.6, 0.4, 1.1, 0, 1.4], [-0.7, 4.8, -0.4, 1.15, 0, 1.4], [0.2, 4.2, -0.9, 1.0, 0, 1.3], [-0.3, 7.0, 0.2, 0.9, 0, 1.3]];
    blobs.forEach(([x, y, z, r, d, sy], i) => {
      const b = ico(r, d, x, y, z, 1, sy, 1);
      if (!lod) jitterGeo(b, 0.25, 21 + i);
      worldUV(b, 1.4);
      leaves.push(foliageColor(b, g0, g1, 3.2, 7.8, 2, 0, 11 + i));
    });
    return { trunk: merge(trunk), leaves: merge(leaves) };
  }
  const t = cyl(0.26, 0.42, 3.8, lod ? 5 : 7, lod ? 1 : 2);
  if (!lod) jitterGeo(t, 0.05, 3);
  trunk.push(barkColor(t, bark));
  if (!lod) for (const [a, tl] of [[0.4, 0.75], [2.6, 0.8], [4.4, 0.7]]) trunk.push(barkColor(branch(0.16, 0.09, 1.8, 2.9, a, tl), bark));
  const blobs = lod
    ? [[0, 5.3, 0, 2.5, 0], [0.6, 4.4, 0.4, 1.9, 0]]
    : [[0, 5.3, 0, 2.3, 1], [1.4, 4.6, 0.5, 1.7, 1], [-1.3, 4.7, -0.4, 1.8, 1], [0.3, 4.4, -1.4, 1.5, 0], [-0.4, 4.4, 1.4, 1.5, 0], [0.2, 6.4, 0.2, 1.4, 0]];
  blobs.forEach(([x, y, z, r, d], i) => {
    const b = ico(r, d, x, y, z);
    if (!lod) jitterGeo(b, 0.35, 11 + i);
    worldUV(b, 1.4);
    leaves.push(foliageColor(b, g0, g1, 3.0, 7.4, 2.8, 0, 13 + i));
  });
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function palm(lod) {
  const trunk = [], leaves = [];
  const g0 = 0x3a8a2c, g1 = 0x9bd65a;
  if (lod === 2) return cards([[-0.3, 0], [-3.4, 5.6], [0, 7.4], [3.4, 5.6], [0.3, 0]], 0, 7.4, 0x6a5a3a, g1);
  let x = 0, y = 0;
  const segs = lod ? 3 : 6, sh = 7.2 / segs;
  for (let i = 0; i < segs; i++) {
    const seg = new THREE.CylinderGeometry(0.2 - i * 0.012, 0.25 - i * 0.012, sh + 0.05, lod ? 5 : 6, 1, true);
    seg.rotateZ(-0.05 - i * 0.04 * (6 / segs));
    seg.translate(x + 0.04, y + sh / 2, 0);
    trunk.push(barkColor(seg, 0xf2dcc0));
    x += (0.06 + i * 0.045) * (6 / segs);
    y += sh;
  }
  const fronds = lod ? 5 : 8;
  for (let i = 0; i < fronds; i++) {
    const ang = (i / fronds) * Math.PI * 2 + 0.3;
    const f = new THREE.PlaneGeometry(0.95, 3.6, 1, lod ? 2 : 5);
    const p = f.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const ly = p.getY(k) + 1.8;
      const lx = p.getX(k) * (1 - ly / 4.4);
      p.setXYZ(k, lx, -0.13 * ly * ly, ly);
    }
    f.computeVertexNormals();
    f.rotateY(ang);
    f.translate(x, y + 0.1, 0);
    worldUV(f, 1.5);
    leaves.push(foliageColor(f, g0, g1, y - 1.6, y + 0.2, 4));
  }
  if (!lod) for (const [dx, dz] of [[0.15, 0.2], [-0.2, 0.1], [0.05, -0.22]]) leaves.push(paint(worldUV(ico(0.2, 0, x + dx, y - 0.25, dz), 1), 0x5a3a1c));
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function cactus(lod) {
  const trunk = [], leaves = [];
  const g0 = 0x2f6f35, g1 = 0x5fa04a;
  if (lod === 2) return cards([[-0.45, 0], [-0.45, 4.2], [0, 4.6], [0.45, 4.2], [0.45, 0]], 0, 4.6, g0, g1);
  // a little sandy root stub (trunk), the green body is the "leaves"
  trunk.push(barkColor(cyl(0.42, 0.5, 0.3, lod ? 5 : 8, 1, -0.1), 0xd9c08a));
  const sides = lod ? 6 : 8;
  const body = cyl(0.36, 0.42, 4, sides, lod ? 1 : 3, 0.1);
  const cap = lod ? cone(0.36, 0.5, sides, 1, 4.1) : (() => { const c = new THREE.SphereGeometry(0.36, sides, 3, 0, Math.PI * 2, 0, Math.PI / 2); c.translate(0, 4.1, 0); return c; })();
  const parts = [body, cap];
  for (const [sx, y0, h] of [[1, 1.6, 1.6], [-1, 2.2, 1.2]]) {
    const arm = new THREE.CylinderGeometry(0.22, 0.24, 0.9, sides, 1, true);
    arm.rotateZ(Math.PI / 2);
    arm.translate(sx * 0.75, y0, 0);
    const up = cyl(0.2, 0.22, h, sides, 1, y0);
    up.translate(sx * 1.15, 0, 0);
    parts.push(arm, up);
    if (!lod) { const c = new THREE.SphereGeometry(0.2, sides, 2, 0, Math.PI * 2, 0, Math.PI / 2); c.translate(sx * 1.15, y0 + h, 0); parts.push(c); }
  }
  for (const g of parts) { worldUV(g, 1.2); leaves.push(foliageColor(g, g0, g1, 0, 4.6, 0.5, 0, 31)); }
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function jungle(lod) {
  const trunk = [], leaves = [];
  const g0 = 0x16502a, g1 = 0x4d9a3c;
  if (lod === 2) return cards([[-0.4, 0], [-4.2, 7.6], [0, 9.9], [4.2, 7.6], [0.4, 0]], 0, 9.9, 0x4a4030, g1);
  trunk.push(barkColor(cyl(0.3, 0.55, 8, lod ? 5 : 7, lod ? 1 : 3), 0xe0d0b8));
  if (!lod) {
    // buttress roots
    for (let i = 0; i < 3; i++) {
      const r = new THREE.BoxGeometry(0.12, 1.4, 1.3);
      r.translate(0, 0.7, 0.75);
      r.rotateY((i / 3) * Math.PI * 2 + 0.4);
      trunk.push(barkColor(worldUV(r, 1.2), 0xd8c4a8));
    }
  }
  const blobs = lod
    ? [[0, 8.6, 0, 3.6, 0, 0.45], [0.8, 7.6, -0.6, 2.4, 0, 0.5]]
    : [[0, 8.8, 0, 3.4, 1, 0.42], [1.6, 7.8, 1.0, 2.2, 1, 0.5], [-1.8, 7.9, -0.8, 2.3, 0, 0.5], [-0.4, 7.5, 1.9, 1.8, 0, 0.55]];
  blobs.forEach(([x, y, z, r, d, sy], i) => {
    const b = ico(r, d, x, y, z, 1, sy, 1);
    if (!lod) jitterGeo(b, 0.4, 41 + i);
    worldUV(b, 1.5);
    leaves.push(foliageColor(b, g0, g1, 6.6, 9.8, 3.6, 0, 17 + i));
  });
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function swampTree(lod) {
  const trunk = [], leaves = [];
  const g0 = 0x3b5a2a, g1 = 0x7f9a4a;
  if (lod === 2) return cards([[-0.4, 0], [-2.8, 4.4], [0, 6.3], [2.8, 4.4], [0.4, 0]], 0, 6.3, 0x4a4030, g1);
  // a leaning, crooked trunk
  const segs = lod ? [[0.38, 0.45, 2.4, 0, 0.12]] : [[0.36, 0.45, 1.8, 0, 0.1], [0.3, 0.36, 1.6, 1.8, 0.25], [0.24, 0.3, 1.2, 3.3, -0.1]];
  let ox = 0;
  for (const [rt, rb, h, y, lean] of segs) {
    const c = new THREE.CylinderGeometry(rt, rb, h + 0.1, lod ? 5 : 6, 1, true);
    c.translate(0, h / 2, 0); c.rotateZ(lean); c.translate(ox, y, 0);
    ox += -Math.sin(lean) * h;
    trunk.push(barkColor(c, 0xc8b8a0));
  }
  const crown = ico(2.4, lod ? 0 : 1, ox, 4.9, 0, 1.15, 0.6, 1.15);
  if (!lod) jitterGeo(crown, 0.35, 51);
  worldUV(crown, 1.5);
  leaves.push(foliageColor(crown, g0, g1, 3.6, 6.2, 2.8, 0, 23));
  // hanging moss strands
  const strands = lod ? 3 : 6;
  for (let i = 0; i < strands; i++) {
    const a = (i / strands) * Math.PI * 2;
    const m = new THREE.ConeGeometry(0.28, 2.2, 4, 1, true);
    m.rotateX(Math.PI);
    m.translate(ox + Math.cos(a) * 1.9, 3.6, Math.sin(a) * 1.9);
    worldUV(m, 1.2);
    leaves.push(foliageColor(m, 0x4f6a3a, 0x8aa262, 2.5, 4.7, 3));
  }
  if (!lod) for (const [x, z] of [[1.6, 0.8], [-1.5, -0.9]]) { const b = ico(1.2, 0, ox + x, 4.4, z, 1, 0.65, 1); worldUV(b, 1.4); leaves.push(foliageColor(b, g0, g1, 3.6, 6, 2.8)); }
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function deadTree(lod) {
  const trunk = [], leaves = [];
  if (lod === 2) return cards([[-0.25, 0], [-1.6, 5.4], [0, 6.0], [1.6, 5.4], [0.25, 0]], 0, 6.0, 0x4a3a2c, 0x6b5640);
  trunk.push(barkColor(cyl(0.16, 0.32, 5, lod ? 5 : 6, lod ? 1 : 3), 0xb8a890));
  const brs = lod ? [[0.5, 3.0, 0.7], [2.6, 3.6, 0.8], [4.4, 2.6, 0.9]] : [[0.5, 3.0, 0.7], [1.8, 3.8, 0.6], [2.9, 2.6, 0.85], [4.2, 3.5, 0.75], [5.4, 4.3, 0.5]];
  brs.forEach(([a, y, t]) => trunk.push(barkColor(branch(0.1, 0.04, 1.8, y, a, t, lod ? 4 : 5), 0xb0a088)));
  // a few bare twigs at the top (the "leaves", so the tree still sways in the wind)
  const tw = lod ? 2 : 6;
  for (let i = 0; i < tw; i++) {
    const g = branch(0.05, 0.02, 1.1, 4.6 + (i % 3) * 0.3, i * 1.7, 0.9, 4);
    worldUV(g, 1);
    leaves.push(paint(g, 0x5a4634));
  }
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

function bush(lod) {
  const trunk = [], leaves = [];
  const g0 = 0x2a6a2c, g1 = 0x6aa848;
  if (lod === 2) return cards([[-1.3, 0], [-1.5, 0.9], [0, 1.7], [1.5, 0.9], [1.3, 0]], 0, 1.7, g0, g1);
  trunk.push(barkColor(cyl(0.08, 0.12, 0.4, lod ? 3 : 5, 1), 0xa08060));
  const blobs = lod ? [[0, 0.8, 0, 1.05, 0], [0.5, 0.6, 0.3, 0.75, 0]] : [[0, 0.85, 0, 1.0, 1], [0.7, 0.6, 0.35, 0.7, 0], [-0.6, 0.6, -0.3, 0.75, 0]];
  blobs.forEach(([x, y, z, r, d], i) => {
    const b = ico(r, d, x, y, z, 1, 0.8, 1);
    if (!lod) jitterGeo(b, 0.18, 61 + i);
    worldUV(b, 1.1);
    leaves.push(foliageColor(b, g0, g1, 0, 1.7, 1.2, 0, 29 + i));
  });
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

const TREE_BUILDERS = {
  pine: (lod) => pine(lod, false), snowpine: (lod) => pine(lod, true), oak: (lod) => oak(lod, false), birch: (lod) => oak(lod, true),
  palm, cactus, jungle, swamp: swampTree, dead: deadTree, bush,
};
const _treeCache = new Map();

/**
 * Tree geometry { trunk, leaves } for a SPECIES key (shared/world/keys.js) or a legacy type
 * (0 pine, 1 oak, 2 palm); unknown keys get the oak. lod 0 (full), 1 (mid), 2 (far cards).
 * Geometries are cached and shared: clone them before changing them.
 */
export function treeGeometry(typeOrSpecies, lod = 0) {
  let sp = typeof typeOrSpecies === 'number' ? LEG[typeOrSpecies] : typeOrSpecies;
  if (!Object.prototype.hasOwnProperty.call(TREE_BUILDERS, sp)) sp = 'oak';
  const l = lod === 1 || lod === 2 ? lod : 0;
  const key = `${sp}|${l}`;
  let g = _treeCache.get(key);
  if (!g) {
    _seed = 7;
    g = TREE_BUILDERS[sp](l);
    _treeCache.set(key, g);
  }
  return g;
}

/**
 * Per species: colliders in tree units (multiply every length by the tree's scale s; y is above
 * its foot): cylinder { hh, r }, cone { hh, r }, ball { r }. walk: true = bullets and the pickaxe
 * hit it but players walk through (bushes). Also the look: bark / leaf tints, double-sided leaves,
 * wind sway, height.
 */
export const SPECIES_COLLIDERS = {
  pine: [{ shape: 'cylinder', y: 2.0, hh: 2.0, r: 0.34 }, { shape: 'cone', y: 5.6, hh: 2.8, r: 2.2 }],
  snowpine: [{ shape: 'cylinder', y: 2.0, hh: 2.0, r: 0.34 }, { shape: 'cone', y: 5.6, hh: 2.8, r: 2.2 }],
  oak: [{ shape: 'cylinder', y: 2.0, hh: 2.0, r: 0.34 }, { shape: 'ball', y: 5.0, r: 2.25 }],
  birch: [{ shape: 'cylinder', y: 2.4, hh: 2.4, r: 0.24 }, { shape: 'ball', y: 5.3, r: 1.6 }],
  palm: [{ shape: 'cylinder', y: 3.4, hh: 3.4, r: 0.28 }],
  cactus: [{ shape: 'cylinder', y: 2.1, hh: 2.1, r: 0.45 }],
  jungle: [{ shape: 'cylinder', y: 3.8, hh: 3.8, r: 0.5 }, { shape: 'ball', y: 8.4, r: 3.0 }],
  swamp: [{ shape: 'cylinder', y: 2.2, hh: 2.2, r: 0.42 }, { shape: 'ball', y: 4.9, r: 2.3 }],
  dead: [{ shape: 'cylinder', y: 2.5, hh: 2.5, r: 0.3 }],
  bush: [{ shape: 'ball', y: 0.75, r: 0.95, walk: true }],
};

export const SPECIES_INFO = {
  pine: { bark: 0x8a6a4a, leaves: 0x2f7a3a, doubleSided: false, sway: 0.5, height: 8.4 },
  snowpine: { bark: 0x7a6248, leaves: 0x2c5e44, doubleSided: false, sway: 0.4, height: 8.4 },
  oak: { bark: 0x7a5a3a, leaves: 0x4a8f34, doubleSided: false, sway: 0.7, height: 7.6 },
  birch: { bark: 0xe8e4da, leaves: 0x7ab848, doubleSided: false, sway: 0.9, height: 7.8 },
  palm: { bark: 0xa88a62, leaves: 0x6ab84a, doubleSided: true, sway: 1.0, height: 7.6 },
  cactus: { bark: 0xd9c08a, leaves: 0x47883f, doubleSided: false, sway: 0, height: 4.6 },
  jungle: { bark: 0x8a7458, leaves: 0x2f7a32, doubleSided: false, sway: 0.5, height: 9.8 },
  swamp: { bark: 0x6a5a44, leaves: 0x5f7a3a, doubleSided: false, sway: 0.6, height: 6.2 },
  dead: { bark: 0x8a7a64, leaves: 0x5a4634, doubleSided: false, sway: 0.2, height: 6.0 },
  bush: { bark: 0x7a6040, leaves: 0x4a8a3a, doubleSided: false, sway: 1.1, height: 1.7 },
};

/** Rock tint per biome (multiply the rock texture). */
export const ROCK_TINTS = {
  ocean: 0x9a968e, beach: 0xd8cfb8, meadow: 0xa8a49a, forest: 0x8e9286, farm: 0xb0a898, city: 0xb4b2ac,
  snow: 0xd6dee8, desert: 0xd9a46a, mesa: 0xc4724a, jungle: 0x7e8a70, swamp: 0x7a7a62, volcano: 0x4a4440,
};

export function rockGeometry(variant) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  const seed = 31 + variant * 17;
  const f = (x, y, z) => Math.sin(x * 2.1 + seed) * Math.cos(y * 2.7 + seed * 0.3) * Math.sin(z * 1.9 - seed);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1 + 0.22 * f(x, y, z) + 0.1 * f(x * 3, y * 3, z * 3);
    x *= d * (variant === 1 ? 1.4 : 1.1);
    z *= d * (variant === 2 ? 1.3 : 1.0);
    y *= d * (variant === 2 ? 0.55 : 0.75);
    if (y < -0.3) y = -0.3 + (y + 0.3) * 0.3;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  worldUV(g, 1.6);
  paint(g, 0xffffff, 0.12, 5 + variant);
  return normalizeGeo(g);
}

// ------------------------------------------------------------------ props
export function carGeometry(colorHex) {
  const parts = [];
  const body = new THREE.BoxGeometry(1.95, 0.7, 4.2, 1, 1, 2);
  body.translate(0, -0.15, 0);
  parts.push(paint(body, colorHex));
  const hood = new THREE.BoxGeometry(1.9, 0.12, 1.3);
  hood.translate(0, 0.25, 1.35);
  parts.push(paint(hood, colorHex));
  const cabin = new THREE.BoxGeometry(1.7, 0.62, 2.1);
  cabin.translate(0, 0.5, -0.3);
  parts.push(paint(cabin, 0x22303d));
  const roof = new THREE.BoxGeometry(1.72, 0.08, 1.9);
  roof.translate(0, 0.84, -0.35);
  parts.push(paint(roof, colorHex));
  for (const [x, z] of [[0.92, 1.35], [-0.92, 1.35], [0.92, -1.35], [-0.92, -1.35]]) {
    const w = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 12);
    w.rotateZ(Math.PI / 2);
    w.translate(x, -0.42, z);
    parts.push(paint(w, 0x161616));
    const hub = new THREE.CylinderGeometry(0.16, 0.16, 0.3, 8);
    hub.rotateZ(Math.PI / 2);
    hub.translate(x * 1.01, -0.42, z);
    parts.push(paint(hub, 0xb8b8b8));
  }
  for (const x of [0.62, -0.62]) {
    const hl = new THREE.BoxGeometry(0.4, 0.16, 0.05);
    hl.translate(x, -0.02, 2.11);
    parts.push(paint(hl, 0xfff2b0));
    const tl = new THREE.BoxGeometry(0.4, 0.14, 0.05);
    tl.translate(x, -0.02, -2.11);
    parts.push(paint(tl, 0xd8261b));
  }
  const bumper = new THREE.BoxGeometry(2.0, 0.18, 0.15);
  bumper.translate(0, -0.42, 2.12);
  parts.push(paint(bumper, 0x8a8a8a));
  const bumper2 = bumper.clone();
  bumper2.translate(0, 0, -4.24);
  parts.push(bumper2);
  return merge(parts);
}

export function chestGeometry() {
  const wood = [], gold = [];
  const base = new THREE.BoxGeometry(0.9, 0.5, 0.58);
  base.translate(0, 0.25, 0);
  wood.push(worldUV(base, 0.9));
  const lid = new THREE.CylinderGeometry(0.29, 0.29, 0.9, 12, 1, false, 0, Math.PI);
  lid.rotateZ(Math.PI / 2);
  lid.translate(0, 0.5, 0);
  wood.push(worldUV(lid, 0.9));
  for (const x of [-0.38, 0, 0.38]) {
    const band = new THREE.BoxGeometry(0.07, 0.52, 0.6);
    band.translate(x, 0.25, 0);
    gold.push(band);
    const lb = new THREE.CylinderGeometry(0.305, 0.305, 0.07, 12, 1, false, 0, Math.PI);
    lb.rotateZ(Math.PI / 2);
    lb.translate(x, 0.5, 0);
    gold.push(lb);
  }
  const lock = new THREE.BoxGeometry(0.16, 0.2, 0.06);
  lock.translate(0, 0.45, 0.3);
  gold.push(lock);
  return { wood: merge(wood), gold: merge(gold) };
}

export function openChestGeometry() {
  const wood = [], gold = [];
  const base = new THREE.BoxGeometry(0.9, 0.5, 0.58);
  base.translate(0, 0.25, 0);
  wood.push(worldUV(base, 0.9));
  const lid = new THREE.CylinderGeometry(0.29, 0.29, 0.9, 12, 1, false, 0, Math.PI);
  lid.rotateZ(Math.PI / 2);
  lid.translate(0, 0, 0.29);
  lid.rotateX(-1.9);
  lid.translate(0, 0.5, -0.29);
  wood.push(worldUV(lid, 0.9));
  for (const x of [-0.38, 0.38]) {
    const band = new THREE.BoxGeometry(0.07, 0.52, 0.6);
    band.translate(x, 0.25, 0);
    gold.push(band);
  }
  return { wood: merge(wood), gold: merge(gold) };
}

export function barrelGeometry() {
  const g = new THREE.CylinderGeometry(0.38, 0.38, 1.1, 14, 1);
  worldUV(g, 1.2);
  paint(g, 0xc8432c);
  const rings = [];
  for (const y of [-0.35, 0.35]) {
    const r = new THREE.TorusGeometry(0.385, 0.03, 4, 16);
    r.rotateX(Math.PI / 2);
    r.translate(0, y, 0);
    rings.push(paint(r, 0x444444));
  }
  return merge([g, ...rings]);
}

export function crateGeometry() {
  const g = new THREE.BoxGeometry(1.2, 1.2, 1.2);
  paint(g, 0xe0b080);
  return normalizeGeo(g);
}

export function containerGeometry(o, color) {
  const g = new THREE.BoxGeometry(o.hx * 2, o.hy * 2, o.hz * 2);
  worldUV(g, 3.0, [o.x, o.y, o.z]);
  g.translate(o.x, o.y, o.z);
  paint(g, color);
  return normalizeGeo(g);
}

// ------------------------------------------------------------------ props, decor and pads
// propGeometry(type, variant) for every prop (shared/world/props.js PROP_TYPES), decor
// (DECOR_TYPES) and pad (PADS) type: vertex-coloured, standing on y = 0, centred on x / z, front
// toward +z. Place props at (o.x, o.y - o.hy, o.z) turned by o.yaw; decor and pads at (x, y, z)
// (decor scaled by o.s). variant: a colour index (o.color) where the type has colours.
const box = (w, h, d, x, y, z, color) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); worldUV(g, 1.5); return paint(g, color); };
const cylP = (rt, rb, h, sides, x, y, z, color, open = false) => { const g = new THREE.CylinderGeometry(rt, rb, h, sides, 1, open); g.translate(x, y + h / 2, z); worldUV(g, 1.2); return paint(g, color); };
const coneP = (r, h, sides, x, y, z, color) => { const g = new THREE.ConeGeometry(r, h, sides, 1); g.translate(x, y + h / 2, z); worldUV(g, 1.2); return paint(g, color); };
const ballP = (r, detail, x, y, z, color, sx = 1, sy = 1, sz = 1) => { const g = new THREE.IcosahedronGeometry(r, detail); g.scale(sx, sy, sz); g.translate(x, y, z); worldUV(g, 1); return paint(g, color); };

export const PROP_COLORS = {
  car: [0xd23c2c, 0x2e7dd1, 0xf0c419, 0xeeeeee, 0x37a35a, 0x7a4a32, 0x6a6058],
  container: [0xc0392b, 0x2e6db4, 0x3f8f4f, 0xe08a1e],
  stall: [0xd8433a, 0x2f7de1, 0xf0b429, 0x3fa34d, 0x9b51e0, 0xff7a1a],
  tent: [0xe2732e, 0x2f8de1, 0x3fa34d, 0xd8433a],
  umbrella: [0xff5a5a, 0x3fb6ff, 0xffd23f, 0x7ce05a],
  flowers: [0xff5ab4, 0xffd23f, 0xffffff, 0x9b6bff, 0xff7a3a],
};

const PROP_BUILDERS = {
  car(v) {
    const g = carGeometry(PROP_COLORS.car[v % PROP_COLORS.car.length]);
    g.translate(0, 0.78, 0);
    return g;
  },
  container(v) {
    const parts = [box(2.5, 2.6, 6, 0, 0, 0, PROP_COLORS.container[v % 4])];
    for (const z of [-2.95, 2.95]) parts.push(box(2.56, 2.66, 0.08, 0, -0.03, z, 0x2a2a2a));
    for (const x of [-0.55, 0.55]) parts.push(box(0.06, 2.2, 0.06, x, 0.2, 3.0, 0x8a8a8a));
    return merge(parts);
  },
  crate() { const g = crateGeometry(); g.translate(0, 0.6, 0); return g; },
  lamp() {
    return merge([
      cylP(0.18, 0.22, 0.3, 8, 0, 0, 0, 0x3a3f46),
      cylP(0.07, 0.09, 5.2, 6, 0, 0.3, 0, 0x4a525c),
      box(0.12, 0.1, 1.4, 0, 5.3, 0.6, 0x4a525c),
      box(0.42, 0.18, 0.6, 0, 5.2, 1.2, 0x2a2f36),
      box(0.36, 0.06, 0.5, 0, 5.15, 1.2, 0xfff2b0),
    ]);
  },
  bench() {
    const wood = 0xb07a48, iron = 0x2f3338;
    return merge([
      box(1.8, 0.08, 0.45, 0, 0.42, 0, wood), box(1.8, 0.4, 0.06, 0, 0.5, -0.24, wood),
      box(0.06, 0.42, 0.45, -0.8, 0, 0, iron), box(0.06, 0.42, 0.45, 0.8, 0, 0, iron),
    ]);
  },
  fence() {
    const w = 0xc89a64;
    return merge([
      box(0.12, 1.1, 0.12, -1.94, 0, 0, w), box(0.12, 1.1, 0.12, 1.94, 0, 0, w),
      box(4, 0.12, 0.06, 0, 0.35, 0, w), box(4, 0.12, 0.06, 0, 0.8, 0, w),
    ]);
  },
  hay() {
    const g = new THREE.CylinderGeometry(0.7, 0.7, 1.5, 12, 1);
    g.rotateZ(Math.PI / 2); g.translate(0, 0.7, 0);
    worldUV(g, 0.8);
    return merge([paint(g, 0xe0c26a, 0.1, 9), (() => { const r = new THREE.TorusGeometry(0.71, 0.03, 4, 12); r.rotateY(Math.PI / 2); r.translate(0.3, 0.7, 0); return paint(r, 0x8a6a3a); })()]);
  },
  stall(v) {
    const c = PROP_COLORS.stall[v % PROP_COLORS.stall.length];
    const parts = [box(2.6, 0.9, 1.4, 0, 0, 0, 0xb07a48), box(2.7, 0.08, 1.5, 0, 0.9, 0, 0xd8b07a)];
    for (const [x, z] of [[-1.3, -0.7], [1.3, -0.7], [-1.3, 0.7], [1.3, 0.7]]) parts.push(box(0.08, 2.3, 0.08, x, 0, z, 0x8a6a3a));
    for (let i = 0; i < 6; i++) parts.push(box(0.47, 0.1, 1.9, -1.18 + i * 0.47, 2.3, 0, i % 2 ? 0xffffff : c));
    parts.push(ballP(0.15, 0, -0.6, 1.08, 0.2, 0xe23b2e), ballP(0.15, 0, -0.2, 1.08, 0.25, 0xf0b429), ballP(0.15, 0, 0.3, 1.08, 0.15, 0x5ad13a));
    return merge(parts);
  },
  fountain() {
    const stone = 0xc9c3b6;
    return merge([
      cylP(2.6, 2.7, 0.6, 12, 0, 0, 0, stone), cylP(2.3, 2.3, 0.02, 12, 0, 0.58, 0, 0x4fa8d8),
      cylP(0.35, 0.45, 1.6, 8, 0, 0.6, 0, stone), cylP(1.0, 0.4, 0.3, 10, 0, 2.2, 0, stone),
      cylP(0.85, 0.85, 0.02, 10, 0, 2.49, 0, 0x6fc3e8), coneP(0.25, 0.6, 6, 0, 2.5, 0, 0xbfe8ff),
    ]);
  },
  sign() {
    const g = [box(0.14, 2.5, 0.14, -1.45, 0, 0, 0x8a6a3a), box(0.14, 2.5, 0.14, 1.45, 0, 0, 0x8a6a3a)];
    // the board's front face (+z) has u, v in 0..1 so a name texture can go on it
    const b = new THREE.BoxGeometry(3.4, 1.2, 0.12);
    b.translate(0, 1.85, 0.06);
    g.push(paint(b, 0xf4efe2));
    g.push(box(3.5, 0.08, 0.16, 0, 2.45, 0.06, 0x2f7de1));
    return merge(g);
  },
  pump() {
    return merge([box(0.8, 1.5, 0.6, 0, 0, 0, 0xe23b2e), box(0.6, 0.35, 0.05, 0, 1.0, 0.31, 0x1a2633), box(0.9, 0.12, 0.7, 0, 1.5, 0, 0xf4efe2), cylP(0.04, 0.04, 0.9, 6, 0.42, 0.4, 0.1, 0x222222)]);
  },
  tent(v) {
    const c = PROP_COLORS.tent[v % PROP_COLORS.tent.length];
    const g = new THREE.BufferGeometry();
    const W = 1.4, H = 1.8, D = 1.7;
    const P = [[-W, 0, -D], [W, 0, -D], [0, H, -D], [-W, 0, D], [W, 0, D], [0, H, D]];
    const tris = [[0, 5, 2], [0, 3, 5], [1, 5, 4], [1, 2, 5], [0, 2, 1], [3, 4, 5]];
    const pos = [];
    for (const t of tris) for (const k of t) pos.push(...P[k]);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    worldUV(g, 1.5);
    paint(g, c, 0.08, 4);
    return merge([g, box(0.6, 1.2, 0.02, 0, 0, D + 0.01, 0x3a2a1a)]);
  },
  hydrant() { return merge([cylP(0.16, 0.18, 0.7, 8, 0, 0, 0, 0xd8261b), ballP(0.17, 0, 0, 0.72, 0, 0xd8261b, 1, 0.6, 1), cylP(0.06, 0.06, 0.4, 6, 0, 0.42, 0, 0xd0d0d0)]); },
  dumpster() { return merge([box(2.0, 1.2, 1.2, 0, 0, 0, 0x2f7a46), box(2.05, 0.1, 1.25, 0, 1.2, 0, 0x1f5a32), box(1.6, 0.25, 0.1, 0, 0.1, 0.62, 0x222222)]); },
  // decor
  cone() { return merge([cylP(0.2, 0.2, 0.05, 4, 0, 0, 0, 0x222222), coneP(0.16, 0.7, 8, 0, 0.05, 0, 0xff7a1a), cylP(0.09, 0.12, 0.12, 8, 0, 0.32, 0, 0xffffff)]); },
  umbrella(v) {
    const c = PROP_COLORS.umbrella[v % 4];
    const can = new THREE.ConeGeometry(1.4, 0.55, 8, 1, true);
    can.translate(0, 2.2, 0);
    const p = can.attributes.position;
    const col = new Float32Array(p.count * 3);
    const a = new THREE.Color(c), b = new THREE.Color(0xffffff);
    for (let i = 0; i < p.count; i++) { const k = Math.floor(((Math.atan2(p.getZ(i), p.getX(i)) + Math.PI) / (Math.PI * 2)) * 8) % 2 ? a : b; col[i * 3] = k.r; col[i * 3 + 1] = k.g; col[i * 3 + 2] = k.b; }
    can.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    worldUV(can, 1.5);
    return merge([cylP(0.04, 0.04, 2.4, 5, 0, 0, 0, 0xdddddd), can]);
  },
  flowers(v) {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const a = i * 1.26 + v, r = 0.18 + (i % 2) * 0.14;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = 0.28 + (i % 3) * 0.08;
      parts.push(box(0.03, h, 0.03, x, 0, z, 0x3f8f2f));
      parts.push(ballP(0.07, 0, x, h + 0.04, z, PROP_COLORS.flowers[(v + i) % PROP_COLORS.flowers.length]));
    }
    return merge(parts);
  },
  pumpkin() {
    const g = new THREE.SphereGeometry(0.45, 10, 6);
    g.scale(1, 0.72, 1); g.translate(0, 0.32, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const a = Math.atan2(p.getZ(i), p.getX(i)); const k = 1 + 0.07 * Math.cos(a * 8); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); }
    g.computeVertexNormals();
    worldUV(g, 0.8);
    return merge([paint(g, 0xff8a1a, 0.08, 3), cylP(0.04, 0.06, 0.18, 5, 0, 0.62, 0, 0x4a6a2a)]);
  },
  campfire() {
    const parts = [];
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; parts.push(ballP(0.16, 0, Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55, 0x7a7670, 1, 0.7, 1)); }
    for (const a of [0.3, 1.9, 3.5]) { const l = new THREE.CylinderGeometry(0.06, 0.07, 0.8, 5); l.rotateZ(Math.PI / 2.4); l.rotateY(a); l.translate(0, 0.25, 0); worldUV(l, 1); parts.push(paint(l, 0x6a4a2a)); }
    parts.push(coneP(0.28, 0.6, 6, 0, 0.1, 0, 0xff8a1a), coneP(0.16, 0.45, 5, 0.05, 0.12, 0.04, 0xffd23f));
    return merge(parts);
  },
  tuft() {
    const parts = [];
    for (let i = 0; i < 3; i++) { const g = new THREE.PlaneGeometry(0.5, 0.45); g.translate(0, 0.22, 0); g.rotateY(i * 1.05); worldUV(g, 0.6); parts.push(paint(g, i % 2 ? 0xb8a85a : 0xd0c070)); }
    return merge(parts);
  },
  reeds() {
    const parts = [];
    for (let i = 0; i < 6; i++) { const a = i * 1.1; parts.push(box(0.04, 1.1 + (i % 3) * 0.3, 0.04, Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25, 0x5a7a3a)); }
    parts.push(cylP(0.05, 0.05, 0.25, 5, 0.1, 1.2, 0.1, 0x6a4a2a));
    return merge(parts);
  },
  shroom() {
    const cap = new THREE.SphereGeometry(0.32, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.translate(0, 0.34, 0);
    worldUV(cap, 0.6);
    const p = cap.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const dot = Math.sin(p.getX(i) * 22) * Math.sin(p.getZ(i) * 22) > 0.6; const c = new THREE.Color(dot ? 0xffffff : 0xd8261b); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    cap.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return merge([cylP(0.08, 0.1, 0.36, 6, 0, 0, 0, 0xf2ead8), cap]);
  },
  log() { const g = new THREE.CylinderGeometry(0.28, 0.32, 3.2, 7); g.rotateZ(Math.PI / 2); g.translate(0, 0.28, 0); worldUV(g, 1.2); return paint(g, 0x7a5a38, 0.08, 5); },
  stump() { return merge([cylP(0.42, 0.5, 0.55, 8, 0, 0, 0, 0x7a5a38), cylP(0.4, 0.4, 0.02, 8, 0, 0.55, 0, 0xd8b07a)]); },
  lily() { return merge([cylP(0.5, 0.5, 0.04, 8, 0, 0, 0, 0x4f8f3a), ballP(0.1, 0, 0.1, 0.1, 0.05, 0xffb0d0, 1, 0.7, 1)]); },
  shell() { const g = new THREE.ConeGeometry(0.12, 0.22, 6); g.rotateX(Math.PI / 2); g.translate(0, 0.06, 0); worldUV(g, 0.4); return paint(g, 0xf4d8c8); },
  // pads
  launch() {
    const parts = [cylP(1.5, 1.6, 0.25, 16, 0, 0, 0, 0x2a3a5a), cylP(1.25, 1.25, 0.04, 16, 0, 0.25, 0, 0x3fb6ff)];
    // a chevron pointing up the pad (+z)
    for (const k of [0, 1]) {
      for (const sx of [-1, 1]) {
        const b = new THREE.BoxGeometry(0.22, 0.05, 0.9);
        b.rotateY(sx * 0.6); b.translate(sx * 0.3, 0.3, -0.2 + k * 0.6);
        worldUV(b, 1); parts.push(paint(b, 0xffffff));
      }
    }
    return merge(parts);
  },
  geyser() {
    const parts = [];
    for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; parts.push(ballP(0.5, 0, Math.cos(a) * 1.3, 0.2, Math.sin(a) * 1.3, 0x5a5048, 1, 0.8, 1)); }
    parts.push(cylP(1.0, 1.1, 0.12, 10, 0, 0, 0, 0x2a2420), cylP(0.6, 0.6, 0.02, 10, 0, 0.13, 0, 0xbfe8ff));
    return merge(parts);
  },
  mushroom() {
    const cap = new THREE.SphereGeometry(1.7, 14, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.55, 1); cap.translate(0, 1.2, 0);
    worldUV(cap, 1.2);
    const p = cap.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const dot = Math.sin(p.getX(i) * 4.1) * Math.sin(p.getZ(i) * 4.1) > 0.55; const c = new THREE.Color(dot ? 0xfff2ff : 0xd04ad8); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    cap.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const under = new THREE.CircleGeometry(1.7, 14); under.rotateX(Math.PI / 2); under.translate(0, 1.2, 0); worldUV(under, 1.2);
    return merge([cylP(0.35, 0.5, 1.25, 8, 0, 0, 0, 0xf2ead8), cap, paint(under, 0xf8d8f0)]);
  },
};

const _propCache = new Map();
/** Geometry for a prop / decor / pad type (cached and shared; clone before changing it). */
export function propGeometry(type, variant = 0) {
  const key = `${type}|${variant | 0}`;
  let g = _propCache.get(key);
  if (!g) {
    const fn = PROP_BUILDERS[type] || PROP_BUILDERS.crate;
    g = normalizeGeo(fn(variant | 0));
    _propCache.set(key, g);
  }
  return g;
}
export const PROP_MODEL_TYPES = Object.keys(PROP_BUILDERS);

// ------------------------------------------------------------------ fast building parts
/**
 * Write a building part straight into preallocated typed arrays (no BufferGeometry per part):
 * A = { pos: Float32Array, nor: Float32Array, uv: Float32Array, col: Float32Array, idx: Uint32Array,
 * layer?: Float32Array | Uint8Array, v: next vertex, i: next index }. Boxes (optionally tilted by
 * ax / ang) and prisms both write PART_VERTS (24) vertices and PART_INDICES (36) indices, with the
 * same world-planar UVs as partGeometry. Returns the first vertex written (for hiding ranges).
 */
export const PART_VERTS = 24, PART_INDICES = 36;
const BOX_FACES = [
  // normal, then the 4 corners as signs of (x, y, z)
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
];
export function writeBox(A, o, color, uvScale = uvScaleOf(o.look), layer = 0) {
  _c.set(color);
  const r = _c.r, g = _c.g, b = _c.b;
  const v0 = A.v;
  let v = A.v, i = A.i;
  const { pos, nor, uv, col, idx } = A;
  const tilt = o.ax ? o.ang : 0;
  const cs = Math.cos(tilt), sn = Math.sin(tilt);
  const ax = o.ax;
  const swap = ax === 'z';
  for (let f = 0; f < 6; f++) {
    const [nx0, ny0, nz0, corners] = BOX_FACES[f];
    let nx = nx0, ny = ny0, nz = nz0;
    // world-planar UVs from the un-tilted box (like worldUV(g, s, [x, y, z], ax === 'z'))
    const anx = Math.abs(nx0), any = Math.abs(ny0);
    if (ax === 'x') { const yy = ny * cs - nz * sn, zz = ny * sn + nz * cs; ny = yy; nz = zz; } else if (ax === 'z') { const xx = nx * cs - ny * sn, yy = nx * sn + ny * cs; nx = xx; ny = yy; }
    for (let k = 0; k < 4; k++) {
      const c = corners[k];
      let lx = c[0] * o.hx, ly = c[1] * o.hy, lz = c[2] * o.hz;
      let u, w;
      const wx = lx + o.x, wy = ly + o.y, wz = lz + o.z;
      if (anx) { u = wz; w = wy; } else if (any) { u = swap ? wz : wx; w = swap ? wx : wz; } else { u = wx; w = wy; }
      if (ax === 'x') { const yy = ly * cs - lz * sn, zz = ly * sn + lz * cs; ly = yy; lz = zz; } else if (ax === 'z') { const xx = lx * cs - ly * sn, yy = lx * sn + ly * cs; lx = xx; ly = yy; }
      const p3 = v * 3;
      pos[p3] = lx + o.x; pos[p3 + 1] = ly + o.y; pos[p3 + 2] = lz + o.z;
      nor[p3] = nx; nor[p3 + 1] = ny; nor[p3 + 2] = nz;
      col[p3] = r; col[p3 + 1] = g; col[p3 + 2] = b;
      uv[v * 2] = u / uvScale; uv[v * 2 + 1] = w / uvScale;
      if (A.layer) A.layer[v] = layer;
      v++;
    }
    const q = v - 4;
    idx[i++] = q; idx[i++] = q + 1; idx[i++] = q + 2; idx[i++] = q; idx[i++] = q + 2; idx[i++] = q + 3;
  }
  A.v = v; A.i = i;
  return v0;
}

/** writeBox for any part: prisms (6 points) become their 8 triangles (24 vertices, 36 indices: 4 degenerate). */
export function writePart(A, o, color, uvScale = uvScaleOf(o.look), layer = 0) {
  if (o.shape !== 'prism') return writeBox(A, o, color, uvScale, layer);
  const g = partGeometry(o, color);
  const v0 = A.v;
  const pa = g.attributes.position.array, na = g.attributes.normal.array, ua = g.attributes.uv.array, ca = g.attributes.color.array;
  const n = g.attributes.position.count; // 24
  A.pos.set(pa, v0 * 3); A.nor.set(na, v0 * 3); A.uv.set(ua, v0 * 2); A.col.set(ca, v0 * 3);
  if (A.layer) for (let k = 0; k < n; k++) A.layer[v0 + k] = layer;
  for (let k = 0; k < n; k++) A.idx[A.i + k] = v0 + k;
  for (let k = n; k < PART_INDICES; k++) A.idx[A.i + k] = v0;  // pad to 36 with degenerate indices
  A.v += n; A.i += PART_INDICES;
  g.dispose();
  return v0;
}

/** Arrays for n parts (writeBox / writePart). */
export function partArrays(n, withLayer = false) {
  const V = n * PART_VERTS;
  return {
    pos: new Float32Array(V * 3), nor: new Float32Array(V * 3), uv: new Float32Array(V * 2), col: new Float32Array(V * 3),
    idx: new Uint32Array(n * PART_INDICES), layer: withLayer ? new Float32Array(V) : null, v: 0, i: 0,
  };
}

// ------------------------------------------------------------------ battle bus + glider
export function busGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(2.8, 2.6, 8.5);
  body.translate(0, 1.6, 0);
  parts.push(paint(body, 0x2f7de1));
  const stripe = new THREE.BoxGeometry(2.84, 0.3, 8.54);
  stripe.translate(0, 1.0, 0);
  parts.push(paint(stripe, 0xffd23f));
  for (let i = 0; i < 5; i++) {
    for (const x of [1.42, -1.42]) {
      const w = new THREE.BoxGeometry(0.04, 0.9, 1.1);
      w.translate(x, 2.2, -3 + i * 1.45);
      parts.push(paint(w, 0x1a2633));
    }
  }
  const front = new THREE.BoxGeometry(2.4, 1.0, 0.05);
  front.translate(0, 2.2, 4.26);
  parts.push(paint(front, 0x1a2633));
  for (const [x, z] of [[1.3, 2.8], [-1.3, 2.8], [1.3, -2.8], [-1.3, -2.8]]) {
    const w = new THREE.CylinderGeometry(0.6, 0.6, 0.4, 12);
    w.rotateZ(Math.PI / 2);
    w.translate(x, 0.3, z);
    parts.push(paint(w, 0x1a1a1a));
  }
  // hot-air balloon
  const balloon = new THREE.SphereGeometry(4.2, 18, 14);
  balloon.scale(1, 1.15, 1);
  balloon.translate(0, 10.5, 0);
  const p = balloon.attributes.position;
  const col = new Float32Array(p.count * 3);
  const cA = new THREE.Color(0xff4f9a), cB = new THREE.Color(0xffffff), cC = new THREE.Color(0x3fd0ff);
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const band = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 3;
    const c = band === 0 ? cA : band === 1 ? cB : cC;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  balloon.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  parts.push(balloon);
  for (const [x, z] of [[1.2, 3.5], [-1.2, 3.5], [1.2, -3.5], [-1.2, -3.5]]) {
    const rope = new THREE.CylinderGeometry(0.04, 0.04, 4.6, 4);
    rope.translate(0, 2.3, 0);
    rope.rotateX(z > 0 ? -0.5 : 0.5);
    rope.rotateZ(x > 0 ? 0.15 : -0.15);
    rope.translate(x, 2.9, z);
    parts.push(paint(rope, 0x6b5030));
  }
  // propellers at the back
  for (const x of [0.9, -0.9]) {
    const fan = new THREE.TorusGeometry(0.55, 0.08, 6, 14);
    fan.translate(x, 2.0, -4.4);
    parts.push(paint(fan, 0xdddddd));
  }
  return merge(parts);
}

export function gliderGeometry(colorHex, accentHex) {
  const parts = [];
  const canopy = new THREE.SphereGeometry(1.8, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.32);
  canopy.scale(1.25, 0.6, 0.85);
  const p = canopy.attributes.position;
  const col = new Float32Array(p.count * 3);
  const a = new THREE.Color(colorHex), b = new THREE.Color(accentHex);
  for (let i = 0; i < p.count; i++) {
    const ang = Math.atan2(p.getZ(i), p.getX(i));
    const c = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 8) % 2 ? a : b;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  canopy.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  canopy.translate(0, 0.6, 0);
  parts.push(canopy);
  for (const x of [-0.9, 0.9]) {
    const s = new THREE.CylinderGeometry(0.025, 0.025, 1.4, 4);
    s.rotateZ(x > 0 ? -0.55 : 0.55);
    s.translate(x * 0.55, 0.2, 0);
    parts.push(paint(s, 0x333333));
  }
  const bar = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6);
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, -0.35, 0);
  parts.push(paint(bar, 0x333333));
  const g = merge(parts);
  return g;
}
