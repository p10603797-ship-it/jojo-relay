// Procedural 3D models (geometry only). Everything is built from primitives at load time.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
const UV_SCALE = { siding: 2.6, brick: 2.2, metalwall: 3, roof: 2.4, floor: 2.6, foundation: 4, slab: 4, trim: 2 };

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
function jitterGeo(g, amount, seed) {
  const p = g.attributes.position;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = map.get(key);
    if (!d) map.set(key, (d = [rnd() * amount, rnd() * amount * 0.6, rnd() * amount]));
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  g.computeVertexNormals();
  return g;
}

function gradientColor(g, bottom, top, y0, y1) {
  const cb = new THREE.Color(bottom), ct = new THREE.Color(top);
  const p = g.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
    _c.copy(cb).lerp(ct, t);
    arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

function sphereUV(g, scale) {
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) + p.getZ(i) * 0.7) / scale;
    uv[i * 2 + 1] = (p.getY(i) + p.getZ(i) * 0.4) / scale;
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export function treeGeometry(type) {
  const trunk = [], leaves = [];
  if (type === 0) {
    const t = new THREE.CylinderGeometry(0.17, 0.32, 4.2, 8, 3);
    t.translate(0, 2.1, 0);
    trunk.push(paint(t, 0xffffff));
    const layers = [[2.7, 3.1, 2.6], [2.2, 2.8, 4.3], [1.65, 2.5, 5.8], [1.05, 2.2, 7.2]];
    layers.forEach(([r, h, y], i) => {
      const c = new THREE.ConeGeometry(r, h, 9, 2);
      c.translate(0, y, 0);
      jitterGeo(c, 0.35, 7 + i);
      sphereUV(c, 1.6);
      gradientColor(c, 0x1d5a2a, 0x4f9e43, 1.5, 8.5);
      leaves.push(c);
    });
  } else if (type === 1) {
    const t = new THREE.CylinderGeometry(0.26, 0.42, 3.8, 8, 3);
    t.translate(0, 1.9, 0);
    jitterGeo(t, 0.06, 3);
    trunk.push(t);
    for (const [ang, tilt] of [[0.4, 0.7], [2.6, 0.8], [4.4, 0.65]]) {
      const b = new THREE.CylinderGeometry(0.1, 0.17, 1.8, 6);
      b.translate(0, 0.9, 0);
      b.rotateZ(tilt);
      b.rotateY(ang);
      b.translate(0, 3.0, 0);
      trunk.push(b);
    }
    const blobs = [[0, 5.2, 0, 2.3], [1.4, 4.6, 0.5, 1.7], [-1.3, 4.7, -0.4, 1.8], [0.3, 4.5, -1.4, 1.6], [-0.4, 4.4, 1.4, 1.6], [0.2, 6.3, 0.2, 1.5]];
    blobs.forEach(([x, y, z, r], i) => {
      const s = new THREE.IcosahedronGeometry(r, 1);
      s.translate(x, y, z);
      jitterGeo(s, 0.4, 11 + i);
      sphereUV(s, 1.4);
      gradientColor(s, 0x2f7a2a, 0x8cc84a, 3.2, 7.2);
      leaves.push(s);
    });
  } else {
    let x = 0, y = 0;
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.CylinderGeometry(0.2 - i * 0.015, 0.24 - i * 0.015, 1.25, 7);
      seg.rotateZ(-0.05 - i * 0.035);
      seg.translate(x + 0.04, y + 0.62, 0);
      trunk.push(seg);
      x += 0.06 + i * 0.045;
      y += 1.2;
    }
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const f = new THREE.PlaneGeometry(0.9, 3.4, 1, 5);
      const p = f.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const ly = p.getY(k) + 1.7;
        const lx = p.getX(k) * (1 - ly / 4.2);
        p.setXYZ(k, lx, -0.12 * ly * ly, ly);
      }
      f.computeVertexNormals();
      f.rotateY(ang);
      f.translate(x, y + 0.1, 0);
      sphereUV(f, 1.5);
      gradientColor(f, 0x3f8f2f, 0x9bd65a, y - 1.5, y + 0.2);
      leaves.push(f);
    }
    const coco = new THREE.IcosahedronGeometry(0.22, 0);
    coco.translate(x + 0.1, y - 0.25, 0.15);
    leaves.push(paint(sphereUV(coco, 1), 0x5a3a1c));
  }
  trunk.forEach((g) => sphereUV(g, 1.2));
  return { trunk: merge(trunk), leaves: merge(leaves) };
}

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
