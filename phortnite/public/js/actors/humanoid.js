// Procedural human body for the characters: the rig layout per skin and one skinned,
// vertex-coloured mesh lofted from smooth rings, with blended skin weights at every joint
// so shoulders, elbows, wrists, hips, knees and ankles bend without cracks.
// Everything here runs once per skin (cached by the caller); nothing is per-frame.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SKINS } from '../../shared/constants.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const C = (hex) => new THREE.Color(hex);
const mixC = (a, b, t) => a.clone().lerp(b instanceof THREE.Color ? b : C(b), t);
const TAU = Math.PI * 2;
const FRONT = Math.PI / 2; // ring angle that faces +z (the character looks down +z)

// ------------------------------------------------------------------ looks
// Body builds keep the height (and so the hitbox) identical; only widths change.
const BUILDS = {
  slim: { sh: 0.95, ch: 0.94, wa: 0.93, hp: 0.97, lb: 0.9, fem: 0 },
  avg: { sh: 1, ch: 1, wa: 1, hp: 1, lb: 1, fem: 0 },
  broad: { sh: 1.08, ch: 1.1, wa: 1.07, hp: 1.03, lb: 1.13, fem: 0 },
  fem: { sh: 0.91, ch: 0.93, wa: 0.85, hp: 1.06, lb: 0.86, fem: 1 },
};

// One entry per SKINS index: silhouette, hair, clothing cut and back bling.
export const LOOKS = [
  // Phantom: slim, hood up, tactical hoodie with gloves and knee pads
  { build: 'slim', hair: 'hood', top: 'hoodie', sleeve: 'long', glove: '#1c1f2b', eye: '#3d8bd9', pack: 'pack', knee: true },
  // Phlame: broad, flame spikes, t-shirt with a chest stripe
  { build: 'broad', hair: 'spiky', top: 'tee', sleeve: 'short', eye: '#5b3a1e', pack: 'pack' },
  // Phrost: ponytail, quilted parka with fur collar, white gloves, boots
  { build: 'fem', hair: 'ponytail', top: 'parka', sleeve: 'long', glove: '#f4f8ff', eye: '#4aa8ff', pack: 'pack', boots: true },
  // Phorest: broad, curly hair and stubble, field jacket with rolled sleeves, cargo pants, boots
  { build: 'broad', hair: 'curly', top: 'jacket', sleeve: 'rolled', eye: '#3a2414', beard: true, pack: 'roll', boots: true, cargo: true },
  // Phlamingo: long hair with bangs, cropped jacket
  { build: 'fem', hair: 'long', top: 'crop', sleeve: 'short', eye: '#3c9a5f', pack: 'heart' },
  // Pharaoh: nemes headdress, broad collar, bracers, kilt flap
  { build: 'broad', hair: 'nemes', top: 'pharaoh', sleeve: 'none', eye: '#2a1a10', liner: true, pack: 'tablet', bracers: true },
  // Phunky: mohawk and shades, open jacket over a tee
  { build: 'avg', hair: 'mohawk', top: 'open', sleeve: 'long', eye: '#4a3020', shades: true, pack: 'boombox' },
  // Phoenix: bob with goggles, flight jacket, gloves
  { build: 'fem', hair: 'bob', top: 'flight', sleeve: 'long', glove: '#d8261f', eye: '#8a5a2a', goggles: true, pack: 'wings' },
];

export function lookOf(skin) {
  const i = SKINS[skin] ? skin : 0;
  return { look: LOOKS[i % LOOKS.length], sk: SKINS[i] };
}

// ------------------------------------------------------------------ rig
// Bone order is fixed for every skin; only the rest positions depend on the build.
export const BONE_NAMES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'clavL', 'armL', 'foreL', 'handL', 'fingL',
  'clavR', 'armR', 'foreR', 'handR', 'fingR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
];
export const BI = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
const PARENT = {
  hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  clavL: 'chest', armL: 'clavL', foreL: 'armL', handL: 'foreL', fingL: 'handL',
  clavR: 'chest', armR: 'clavR', foreR: 'armR', handR: 'foreR', fingR: 'handR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL', toeL: 'footL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR', toeR: 'footR',
};

const rigCache = new Map();
/** { list: [[name, parentIndex, [x,y,z] model-space rest position]], pos: {name: [x,y,z]}, D } */
export function rigFor(skin) {
  let r = rigCache.get(skin);
  if (r) return r;
  const { look } = lookOf(skin);
  const b = BUILDS[look.build] || BUILDS.avg;
  const sw = 0.2 * b.sh, hw = 0.094 * b.hp;
  const D = {
    b, sw, hw, shY: 1.44, elY: 1.14, wrY: 0.878, knuY: 0.795, hipY: 0.905, kneeY: 0.5, ankY: 0.088, toeZ: 0.13,
  };
  const pos = {
    root: [0, 0, 0], hips: [0, 0.95, 0], spine: [0, 1.1, -0.005], chest: [0, 1.28, -0.01],
    neck: [0, 1.515, -0.022], head: [0, 1.635, -0.012],
  };
  for (const [s, k] of [['L', 1], ['R', -1]]) {
    pos[`clav${s}`] = [k * 0.03, 1.445, -0.012];
    pos[`arm${s}`] = [k * sw, D.shY, -0.018];
    pos[`fore${s}`] = [k * (sw + 0.016), D.elY, -0.038];
    pos[`hand${s}`] = [k * (sw + 0.026), D.wrY, -0.015];
    pos[`fing${s}`] = [k * (sw + 0.03), D.knuY, 0.0];
    pos[`thigh${s}`] = [k * hw, D.hipY, 0];
    pos[`shin${s}`] = [k * (hw + 0.006), D.kneeY, 0.012];
    pos[`foot${s}`] = [k * (hw + 0.01), D.ankY, -0.015];
    pos[`toe${s}`] = [k * (hw + 0.012), 0.022, D.toeZ];
  }
  const list = BONE_NAMES.map((n) => [n, PARENT[n] ? BI[PARENT[n]] : -1, pos[n]]);
  r = { list, pos, D };
  rigCache.set(skin, r);
  return r;
}

// ------------------------------------------------------------------ skin weights
// Position-based weights per body region (rest pose): smooth two-bone blends across
// every joint, plus small shoulder / hip spill-over so the torso follows the limbs.
function weigher(rig) {
  const D = rig.D, P = rig.pos;
  const ids = new Int32Array(8), ws = new Float32Array(8);
  let n = 0;
  const add = (name, w) => {
    if (w <= 1e-4) return;
    const b = BI[name];
    for (let k = 0; k < n; k++) if (ids[k] === b) { ws[k] += w; return; }
    ids[n] = b; ws[n++] = w;
  };
  const neckChain = (y, lo, hi) => {
    const a = sstep(lo, lo + 0.05, y), h = sstep(hi - 0.03, hi + 0.02, y);
    add('chest', 1 - a);
    add('neck', a * (1 - h));
    add('head', a * h);
  };
  return function weigh(region, x, y, z, outI, outW, o) {
    n = 0;
    const s = x >= 0 ? 'L' : 'R';
    const ax = Math.abs(x);
    switch (region) {
      case 'torso': {
        const hs = sstep(1.0, 1.1, y), sc = sstep(1.18, 1.3, y), cn = sstep(1.5, 1.555, y);
        let hips = 1 - hs, spine = hs * (1 - sc), chest = sc * (1 - cn);
        const neck = cn;
        // shoulders: the deltoid/trapezius area follows the clavicle and a bit of the arm
        const sh = sstep(0.1, 0.19, ax) * sstep(1.34, 1.43, y);
        add(`clav${s}`, chest * sh * 0.45);
        add(`arm${s}`, chest * sh * 0.25);
        chest *= 1 - sh * 0.7;
        // pelvis bottom follows the thighs a little so crouching does not split the crotch
        const lg = sstep(0.02, 0.1, ax) * (1 - sstep(0.8, 0.94, y));
        add(`thigh${s}`, hips * lg * 0.4);
        hips *= 1 - lg * 0.4;
        add('hips', hips); add('spine', spine); add('chest', chest); add('neck', neck);
        break;
      }
      case 'hips': add('hips', 1); break;
      case 'chest': add('chest', 1); break;
      case 'neck': neckChain(y, 1.5, 1.625); break;
      case 'hood': neckChain(y, 1.48, 1.6); break;
      case 'head': add('head', 1); break;
      case 'hair': { // long hair: the part resting on the back follows the chest
        const c = sstep(1.6, 1.48, y);
        add('head', 1 - c);
        add('chest', c);
        break;
      }
      case 'arm': {
        let fore = sstep(D.elY + 0.045, D.elY - 0.045, y);
        const hand = sstep(D.wrY + 0.012, D.wrY - 0.02, y);
        let arm = 1 - fore;
        fore *= 1 - hand;
        // inner top of the deltoid cap stays partly with the clavicle so raised arms read smoothly
        const top = sstep(D.shY - 0.03, D.shY + 0.05, y) * sstep(D.sw - 0.01, D.sw - 0.07, ax);
        add(`clav${s}`, arm * top * 0.35);
        arm *= 1 - top * 0.35;
        add(`arm${s}`, arm); add(`fore${s}`, fore); add(`hand${s}`, hand);
        break;
      }
      case 'hand': {
        const f = sstep(D.wrY - 0.012, D.wrY + 0.02, y);
        add(`fore${s}`, f);
        add(`hand${s}`, 1 - f);
        break;
      }
      case 'fing': {
        const f = sstep(D.knuY + 0.006, D.knuY - 0.014, y);
        add(`hand${s}`, 1 - f);
        add(`fing${s}`, f);
        break;
      }
      case 'leg': {
        let shin = sstep(D.kneeY + 0.05, D.kneeY - 0.05, y);
        const foot = sstep(D.ankY + 0.05, D.ankY + 0.005, y);
        const thigh = 1 - shin;
        shin *= 1 - foot;
        add(`thigh${s}`, thigh); add(`shin${s}`, shin); add(`foot${s}`, foot);
        break;
      }
      case 'foot': {
        const toe = sstep(D.toeZ - 0.035, D.toeZ + 0.02, z);
        const shin = 0.6 * sstep(D.ankY + 0.0, D.ankY + 0.05, y);
        add(`shin${s}`, shin);
        add(`foot${s}`, (1 - shin) * (1 - toe));
        add(`toe${s}`, (1 - shin) * toe);
        break;
      }
      default: add(region, 1);
    }
    // keep the 4 strongest, normalise
    for (let k = 0; k < 4; k++) {
      let best = k;
      for (let j = k + 1; j < n; j++) if (ws[j] > ws[best]) best = j;
      if (best !== k) {
        const ti = ids[k]; ids[k] = ids[best]; ids[best] = ti;
        const tw = ws[k]; ws[k] = ws[best]; ws[best] = tw;
      }
    }
    let sum = 0;
    for (let k = 0; k < Math.min(4, n); k++) sum += ws[k];
    for (let k = 0; k < 4; k++) {
      outI[o + k] = k < n ? ids[k] : 0;
      outW[o + k] = k < n && sum > 0 ? ws[k] / sum : 0;
    }
  };
}

// ------------------------------------------------------------------ geometry primitives
// Catmull-Rom through a table of rows [key, v1, v2, ...] (keys ascending).
function table(rows) {
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  return (k) => {
    const n = rows.length, out = new Array(rows[0].length - 1);
    if (k <= rows[0][0]) { for (let j = 1; j < rows[0].length; j++) out[j - 1] = rows[0][j]; return out; }
    if (k >= rows[n - 1][0]) { for (let j = 1; j < rows[0].length; j++) out[j - 1] = rows[n - 1][j]; return out; }
    let i = 0;
    while (i < n - 2 && k > rows[i + 1][0]) i++;
    const r0 = rows[Math.max(0, i - 1)], r1 = rows[i], r2 = rows[i + 1], r3 = rows[Math.min(n - 1, i + 2)];
    const t = (k - r1[0]) / (r2[0] - r1[0]);
    for (let j = 1; j < r1.length; j++) out[j - 1] = cr(r0[j], r1[j], r2[j], r3[j], t);
    return out;
  };
}

function uniformAngles(seg, breaks = []) {
  const a = [];
  for (let k = 0; k < seg; k++) a.push((k / seg) * TAU);
  // break pairs give crisp colour edges (two vertices a hair apart)
  for (const b of breaks) {
    const x = ((b % TAU) + TAU) % TAU;
    a.push(x - 0.006, x + 0.006);
  }
  a.sort((p, q) => p - q);
  const out = [];
  for (const x of a) if (!out.length || x - out[out.length - 1] > 0.004) out.push(x);
  if (out.length > 1 && out[0] + TAU - out[out.length - 1] < 0.004) out.pop();
  return out;
}

const _t = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3();

/**
 * Loft a closed tube through ring centres.
 * rings: [{ p:[x,y,z], rx, rf, rb, n, nf, col }]  rx = half width along u, rf/rb = half depth toward +v / -v,
 *   n/nf = superellipse exponents for the back/front halves (2 = ellipse, bigger = boxier).
 * o: { seg | angles, ref (initial v axis), axis (fixed tangent, keeps rings flat), cap0/cap1 (dome length,
 *   0 = flat fan, undefined = open), col, color(x,y,z,a,ring) -> Color, warp(vec, a, ring, scale, frame) }
 */
function tube(rings, o = {}) {
  const angles = o.angles || uniformAngles(o.seg || 12);
  const K = angles.length;
  const n = rings.length;
  const P = rings.map((r) => new THREE.Vector3(r.p[0], r.p[1], r.p[2]));
  const F = [];
  let v = new THREE.Vector3().fromArray(o.ref || [0, 0, 1]);
  for (let i = 0; i < n; i++) {
    const t = o.axis ? new THREE.Vector3().fromArray(o.axis).normalize()
      : new THREE.Vector3().subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
    v = v.clone().addScaledVector(t, -v.dot(t));
    if (v.lengthSq() < 1e-8) v.set(1, 0, 0).addScaledVector(t, -t.x);
    v.normalize();
    F.push({ t, v, u: new THREE.Vector3().crossVectors(t, v) });
  }
  const m = o.capSeg || 3;
  const list = [];
  if (o.cap0) for (let j = m; j >= 1; j--) { const th = (j / (m + 1)) * Math.PI / 2; list.push({ ri: 0, s: Math.cos(th), off: -Math.sin(th) * o.cap0 }); }
  for (let i = 0; i < n; i++) list.push({ ri: i, s: 1, off: 0 });
  if (o.cap1) for (let j = 1; j <= m; j++) { const th = (j / (m + 1)) * Math.PI / 2; list.push({ ri: n - 1, s: Math.cos(th), off: Math.sin(th) * o.cap1 }); }
  const pos = [], col = [], idx = [];
  const pushV = (vec, a, r) => {
    pos.push(vec.x, vec.y, vec.z);
    const c = o.color ? o.color(vec.x, vec.y, vec.z, a, r) : (r.col || o.col);
    col.push(c.r, c.g, c.b);
  };
  for (const L of list) {
    const r = rings[L.ri], f = F[L.ri];
    const ne = r.n || o.n || 2, nf = r.nf || o.nf || ne;
    for (let k = 0; k < K; k++) {
      const a = angles[k];
      const c = Math.cos(a), s = Math.sin(a);
      const e = 2 / (s >= 0 ? nf : ne);
      const ex = Math.sign(c) * Math.abs(c) ** e, ez = Math.sign(s) * Math.abs(s) ** e;
      _t.copy(P[L.ri]).addScaledVector(f.u, r.rx * ex * L.s).addScaledVector(f.v, (s >= 0 ? r.rf : r.rb) * ez * L.s).addScaledVector(f.t, L.off);
      if (o.warp) o.warp(_t, a, r, L, f);
      pushV(_t, a, r);
    }
  }
  const R = list.length;
  for (let i = 0; i < R - 1; i++) {
    for (let k = 0; k < K; k++) {
      const a = i * K + k, b = i * K + ((k + 1) % K), c = a + K, d = b + K;
      idx.push(a, c, b, b, c, d);
    }
  }
  if (o.cap0 !== undefined) {
    const r = rings[0];
    _t.copy(P[0]).addScaledVector(F[0].t, -(o.cap0 || 0));
    if (o.warp) o.warp(_t, -1, r, { s: 0, off: -(o.cap0 || 0) }, F[0]);
    const pi = pos.length / 3;
    pushV(_t, -1, r);
    for (let k = 0; k < K; k++) idx.push(pi, k, (k + 1) % K);
  }
  if (o.cap1 !== undefined) {
    const r = rings[n - 1];
    _t.copy(P[n - 1]).addScaledVector(F[n - 1].t, o.cap1 || 0);
    if (o.warp) o.warp(_t, -1, r, { s: 0, off: o.cap1 || 0 }, F[n - 1]);
    const pi = pos.length / 3, base = (R - 1) * K;
    pushV(_t, -1, r);
    for (let k = 0; k < K; k++) idx.push(pi, base + ((k + 1) % K), base + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function paint(g, c) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Welded, smooth-shaded copy of a three.js primitive (uv seams removed). */
function weld(g) {
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-5);
  g.dispose();
  return m;
}

function ell(rx, ry, rz, ws, hs, x, y, z, c, rot) {
  const g = weld(new THREE.SphereGeometry(1, ws, hs));
  g.scale(rx, ry, rz);
  if (rot) { if (rot[0]) g.rotateX(rot[0]); if (rot[1]) g.rotateY(rot[1]); if (rot[2]) g.rotateZ(rot[2]); }
  g.translate(x, y, z);
  paint(g, c);
  g.computeVertexNormals();
  return g;
}

/** Rounded box (corner radius r). */
function rbox(w, h, d, r, seg, x, y, z, c, rot) {
  const g = weld(new THREE.BoxGeometry(w, h, d, seg, seg, seg));
  const p = g.attributes.position;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
    const cx = clamp(px, -hx, hx), cy = clamp(py, -hy, hy), cz = clamp(pz, -hz, hz);
    _w.set(px - cx, py - cy, pz - cz);
    const l = _w.length();
    if (l > 1e-6) _w.multiplyScalar(r / l);
    p.setXYZ(i, cx + _w.x, cy + _w.y, cz + _w.z);
  }
  if (rot) { if (rot[0]) g.rotateX(rot[0]); if (rot[1]) g.rotateY(rot[1]); if (rot[2]) g.rotateZ(rot[2]); }
  g.translate(x, y, z);
  paint(g, c);
  g.computeVertexNormals();
  return g;
}

/** Thin round tube along a polyline (cords, brows, lids, straps), radius per point. */
function cord(points, radii, c, seg = 5, cap = true, ref) {
  const rings = points.map((p, i) => ({ p, rx: radii[i], rf: radii[i], rb: radii[i] }));
  const r0 = radii[0], r1 = radii[radii.length - 1];
  return tube(rings, { seg, col: c, cap0: cap ? r0 : undefined, cap1: cap ? r1 : undefined, capSeg: 1, ref });
}

/** Rings along a polyline path with a smooth profile and crisp colour bands. */
function bandRings(path, prof, bands, opt) {
  // cumulative length along the path
  const pts = path.map((p) => new THREE.Vector3().fromArray(p));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = cum[cum.length - 1];
  const at = (s) => {
    let i = 0;
    while (i < cum.length - 2 && s > cum[i + 1]) i++;
    const t = clamp((s - cum[i]) / (cum[i + 1] - cum[i] || 1), -0.5, 1.5);
    return new THREE.Vector3().lerpVectors(pts[i], pts[i + 1], t);
  };
  const s0 = opt.s0 !== undefined ? opt.s0 : 0, s1 = opt.s1 !== undefined ? opt.s1 : L;
  const S = new Set();
  for (let s = s0; s < s1; s += opt.step || 0.05) S.add(+s.toFixed(4));
  S.add(s1);
  for (const k of opt.keys || []) if (k > s0 && k < s1) S.add(k);
  for (const b of bands) for (const e of [b[0], b[1]]) if (e > s0 + 0.004 && e < s1 - 0.004) { S.add(e - 0.0015); S.add(e + 0.0015); }
  const ss = [...S].sort((a, b) => a - b).filter((s, i, a) => i === 0 || s - a[i - 1] > 0.001);
  const bandAt = (s) => { for (const b of bands) if (s >= b[0] && s < b[1]) return b; return null; };
  return ss.map((s) => {
    const d = prof(s, L);
    const b = bandAt(s);
    const lip = b && b[3] ? b[3] : 0;
    return { p: at(s).toArray(), rx: d[0] + lip, rf: d[1] + lip, rb: d[2] + lip, s, col: b ? b[2] : opt.col, n: d[3] || 2 };
  });
}

// ------------------------------------------------------------------ head shape
// Horizontal head rings: y -> [zc, rx, rf, rb, nf]. Front exponent nf > 2 flattens the face.
const HEAD = [
  [1.618, 0.046, 0.03, 0.026, 0.02, 2],
  [1.636, 0.03, 0.057, 0.062, 0.054, 2.1],
  [1.656, 0.02, 0.07, 0.078, 0.07, 2.2],
  [1.678, 0.012, 0.077, 0.087, 0.08, 2.25],
  [1.70, 0.008, 0.081, 0.092, 0.088, 2.3],
  [1.725, 0.004, 0.085, 0.094, 0.095, 2.5],
  [1.75, 0.0, 0.087, 0.093, 0.1, 2.5],
  [1.78, -0.004, 0.086, 0.089, 0.1, 2.4],
  [1.81, -0.008, 0.079, 0.078, 0.093, 2.2],
  [1.835, -0.012, 0.065, 0.062, 0.076, 2.1],
  [1.852, -0.014, 0.046, 0.043, 0.054, 2],
];
const HEAD_TOP = 1.852, HEAD_DOME = 0.016;
const HEAD_SCALE = 1.07, HEAD_PIVOT = [0, 1.6, -0.01], HEAD_DROP = 0.012;
const headTab = table(HEAD);
function headAt(y, fem) {
  const d = headTab(y);
  if (fem) { // softer, narrower jaw and chin
    const j = sstep(1.72, 1.635, y);
    d[1] *= 1 - 0.1 * j; d[2] *= 1 - 0.02 * j; d[4] -= 0.4 * j;
  }
  return { zc: d[0], rx: d[1], rf: d[2], rb: d[3], nf: d[4] };
}
/** Point on the head surface at height y, ring angle a. */
function headPoint(y, a, fem, out = new THREE.Vector3()) {
  const h = headAt(y, fem);
  const c = Math.cos(a), s = Math.sin(a);
  const e = 2 / (s >= 0 ? h.nf : 2);
  return out.set(h.rx * Math.sign(c) * Math.abs(c) ** e, y, h.zc + (s >= 0 ? h.rf : h.rb) * Math.sign(s) * Math.abs(s) ** e);
}
/** z of the face surface at (x, y). */
function faceZ(x, y, fem) {
  const h = headAt(y, fem);
  const q = clamp(Math.abs(x) / h.rx, 0, 0.999);
  return h.zc + h.rf * (1 - q ** h.nf) ** (1 / h.nf);
}

// ------------------------------------------------------------------ body builder
class Parts {
  constructor() { this.list = []; }
  add(g, region) { this.list.push({ g, region }); return g; }
}

function torsoProfile(b) {
  // y -> [zc, rx, rf, rb]
  const T = table([
    [0.80, 0.0, 0.06, 0.05, 0.05],
    [0.84, 0.0, 0.128, 0.084, 0.09],
    [0.89, -0.004, 0.158, 0.095, 0.112],
    [0.95, -0.004, 0.166, 0.097, 0.112],
    [1.0, -0.004, 0.162, 0.095, 0.1],
    [1.07, -0.002, 0.152, 0.093, 0.088],
    [1.15, -0.004, 0.153, 0.099, 0.088],
    [1.23, -0.008, 0.158, 0.108, 0.092],
    [1.31, -0.01, 0.162, 0.116, 0.098],
    [1.37, -0.012, 0.164, 0.114, 0.1],
    [1.42, -0.014, 0.165, 0.1, 0.097],
    [1.46, -0.016, 0.163, 0.084, 0.09],
    [1.495, -0.018, 0.135, 0.068, 0.075],
    [1.52, -0.02, 0.1, 0.062, 0.066],
    [1.54, -0.02, 0.074, 0.058, 0.062],
  ]);
  return (y) => {
    const [zc, rx0, rf0, rb0] = T(y);
    let rx = rx0, rf = rf0, rb = rb0;
    const hip = 1 - sstep(1.0, 1.08, y), waist = sstep(1.0, 1.08, y) * (1 - sstep(1.14, 1.24, y));
    const chest = sstep(1.14, 1.24, y) * (1 - sstep(1.42, 1.48, y)), sh = sstep(1.42, 1.48, y);
    rx *= hip * b.hp + waist * b.wa + chest * b.ch + sh * b.sh + (1 - hip - waist - chest - sh) * 1;
    const depth = 1.07 * (hip * (1 + (b.hp - 1) * 0.6) + waist * (1 + (b.wa - 1) * 0.5) + chest * (1 + (b.ch - 1) * 0.7) + (1 - hip - waist - chest));
    rf *= depth; rb *= depth;
    if (b.fem) {
      const bust = Math.exp(-(((y - 1.315) / 0.05) ** 2));
      rf += 0.024 * bust;
      rb += 0.01 * (1 - sstep(0.84, 0.92, y)) * sstep(0.8, 0.86, y) + 0.008 * Math.exp(-(((y - 0.92) / 0.06) ** 2));
    }
    return [zc, rx, rf, rb];
  };
}

function buildBody(skin, lod) {
  const { look, sk } = lookOf(skin);
  const rig = rigFor(skin);
  const D = rig.D, b = D.b, fem = !!b.fem;
  const hi = lod === 0;
  const parts = new Parts();
  const outfit = C(sk.outfit), accent = C(sk.accent), pants = C(sk.pants), skinC = C(sk.skin), hair = C(sk.hair), shoes = C(sk.shoes);
  const dark = C('#1d1a19'), leather = C('#3a2a1f'), white = C('#f4f4f4');
  const outfitDk = mixC(outfit, '#000000', 0.25), pantsDk = mixC(pants, '#000000', 0.3);
  const lipC = mixC(skinC, fem ? '#c2414f' : '#9a4a44', fem ? 0.5 : 0.28);
  const glove = look.glove ? C(look.glove) : null;
  const seg = (n) => Math.max(5, Math.round(n * (hi ? 1 : 0.6)));

  // ---------------- torso (pelvis to neck base)
  const tp = torsoProfile(b);
  const tb = []; // bands [y0, y1, color, lip]
  const top = look.top;
  let hemY = 1.07, hemLip = 0.004;
  if (top === 'parka') { hemY = 0.97; hemLip = 0.014; }
  if (top === 'crop') hemY = 1.2;
  if (top === 'flight') hemLip = 0.006;
  tb.push([0, 1.026, pants, 0.003]);
  tb.push([1.026, 1.07, leather, 0.008]); // belt
  if (top === 'crop') tb.push([1.07, hemY, accent, 0.0]);
  if (top === 'pharaoh') {
    tb.push([1.07, 1.36, outfit, 0.002]);
    // broad collar (usekh): concentric gold / blue rows
    const rows = [[1.36, 1.385, accent], [1.385, 1.41, outfit], [1.41, 1.435, accent], [1.435, 1.46, outfit], [1.46, 1.49, accent], [1.49, 1.6, outfit]];
    for (const [a, c, k] of rows) tb.push([a, c, k, 0.012]);
  } else if (top === 'parka') {
    tb.length = 1; tb[0] = [0, hemY - 0.03, pants, 0.003];
    tb.push([hemY - 0.03, hemY, mixC(outfit, '#ffffff', 0.35), hemLip + 0.004]);
    // quilted puffer rows
    let y = hemY;
    let k = 0;
    while (y < 1.47) { const y2 = Math.min(1.47, y + 0.075); tb.push([y, y2, k++ % 2 ? outfit : mixC(outfit, '#ffffff', 0.12), 0.012]); y = y2; }
    tb.push([1.47, 1.6, outfit, 0.006]);
  } else {
    if (top === 'flight' || top === 'hoodie') tb.push([hemY, hemY + 0.045, top === 'flight' ? accent : outfitDk, hemLip + 0.004]);
    const y0 = top === 'flight' || top === 'hoodie' ? hemY + 0.045 : hemY;
    if (top === 'tee') {
      tb.push([y0, 1.29, outfit, hemLip]);
      tb.push([1.29, 1.345, accent, hemLip + 0.001]);
      tb.push([1.345, 1.6, outfit, hemLip]);
    } else {
      tb.push([y0, 1.6, outfit, hemLip]);
    }
  }
  const zipBreak = top === 'hoodie' || top === 'flight' || top === 'parka' || top === 'jacket';
  const panel = top === 'open' ? 0.3 : 0;
  const breaks = [];
  if (zipBreak) breaks.push(FRONT - 0.018, FRONT + 0.018);
  if (panel) breaks.push(FRONT - panel, FRONT + panel);
  const torsoAngles = uniformAngles(seg(18), breaks);
  const zipC = top === 'hoodie' ? accent : top === 'jacket' ? outfitDk : dark;
  const ys = [0.8, 0.85, 0.92, 1.0, 1.1, 1.2, 1.3, 1.38, 1.44, 1.49, 1.525, 1.54];
  const tset = new Set(ys);
  for (const t of tb) for (const e of [t[0], t[1]]) if (e > 0.81 && e < 1.535) { tset.add(+(e - 0.0015).toFixed(4)); tset.add(+(e + 0.0015).toFixed(4)); }
  const tys = [...tset].sort((p, q) => p - q);
  const bandOf = (y) => { for (const t of tb) if (y >= t[0] && y < t[1]) return t; return tb[tb.length - 1]; };
  const torsoRings = tys.map((y) => {
    const [zc, rx, rf, rb] = tp(y);
    const t = bandOf(y);
    const lip = t[3] || 0;
    return { p: [0, y, zc], rx: rx + lip, rf: rf + lip, rb: rb + lip, n: 2.2, col: t[2], y };
  });
  const torso = tube(torsoRings, {
    angles: torsoAngles, axis: [0, 1, 0], cap0: 0.03,
    color: (x, y, z, a, r) => {
      const base = r.col;
      if (a < 0 || y < 1.075 || y > 1.535) return base;
      const da = Math.abs(a - FRONT);
      if (panel && da < panel && y < 1.5) return accent;
      if (zipBreak && da < 0.018 && base !== pants && y < 1.5) return zipC;
      return base;
    },
    warp: panel ? (p, a, r) => { // open jacket: lapels stand off the tee a little
      const da = Math.abs(a - FRONT);
      if (r.y > 1.075 && r.y < 1.5 && da >= panel && da < panel + 0.25) { p.z += 0.006; }
    } : undefined,
  });
  parts.add(torso, 'torso');

  // neck
  const nk = (fem ? 0.92 : 1.13) * (1 + (b.ch - 1) * 0.6);
  const neckRings = [
    { p: [0, 1.49, -0.018], rx: 0.06 * nk, rf: 0.052 * nk, rb: 0.058 * nk },
    { p: [0, 1.56, -0.016], rx: 0.053 * nk, rf: 0.049 * nk, rb: 0.053 * nk },
    { p: [0, 1.62, -0.013], rx: 0.05 * nk, rf: 0.044 * nk, rb: 0.052 * nk },
    { p: [0, 1.67, -0.01], rx: 0.047 * nk, rf: 0.036 * nk, rb: 0.05 * nk },
  ];
  parts.add(tube(neckRings, { seg: seg(11), axis: [0, 1, 0], col: skinC }), 'neck');

  // collar
  if (top === 'tee' || top === 'crop') {
    const c = top === 'tee' ? accent : outfit;
    parts.add(tube([
      { p: [0, 1.5, -0.02], rx: 0.084, rf: 0.07, rb: 0.074 },
      { p: [0, 1.527, -0.02], rx: 0.064, rf: 0.06, rb: 0.064 },
      { p: [0, 1.545, -0.02], rx: 0.06, rf: 0.056, rb: 0.062 },
    ], { seg: seg(16), axis: [0, 1, 0], col: c }), 'torso');
  } else if (top === 'jacket' || top === 'flight' || top === 'open') {
    parts.add(tube([
      { p: [0, 1.49, -0.02], rx: 0.09, rf: 0.072, rb: 0.08 },
      { p: [0, 1.53, -0.022], rx: 0.07, rf: 0.062, rb: 0.07 },
      { p: [0, 1.575, -0.024], rx: 0.078, rf: 0.07, rb: 0.074 },
    ], { seg: seg(16), axis: [0, 1, 0], col: top === 'flight' ? C('#e9d6b0') : mixC(outfit, '#ffffff', 0.12),
      warp: (p, a) => { const f = Math.sin(a); if (f > 0.75) { p.z -= (f - 0.75) * 0.08; p.y -= (f - 0.75) * 0.12; } } }), 'torso');
  } else if (top === 'parka') {
    // fur collar: lumpy ring
    parts.add(tube([
      { p: [0, 1.47, -0.02], rx: 0.11, rf: 0.086, rb: 0.094 },
      { p: [0, 1.515, -0.02], rx: 0.1, rf: 0.085, rb: 0.092 },
      { p: [0, 1.565, -0.02], rx: 0.078, rf: 0.07, rb: 0.08 },
    ], { seg: seg(18), axis: [0, 1, 0], cap1: 0.0, col: accent,
      warp: (p, a) => { const k = 1 + 0.08 * Math.sin(a * 7) * Math.sin(p.y * 90); p.x *= k; p.z = -0.02 + (p.z + 0.02) * k; } }), 'torso');
  }

  // ---------------- arms
  const lb = b.lb;
  for (const k of [1, -1]) {
    const s = k > 0 ? 'L' : 'R';
    const S = rig.pos[`arm${s}`], E = rig.pos[`fore${s}`], W = rig.pos[`hand${s}`];
    const Lu = Math.hypot(E[0] - S[0], E[1] - S[1], E[2] - S[2]);
    const prof = table([
      [-0.01, 0.054, 0.058, 0.056],
      [0.05, 0.054, 0.056, 0.053],
      [0.13, 0.049, 0.055, 0.049],
      [Lu - 0.05, 0.043, 0.046, 0.044],
      [Lu, 0.04, 0.042, 0.045],
      [Lu + 0.05, 0.043, 0.047, 0.045],
      [Lu + 0.15, 0.034, 0.039, 0.036],
      [Lu + 0.24, 0.021, 0.029, 0.027],
      [Lu + 0.28, 0.02, 0.026, 0.025],
    ]);
    const bands = [];
    const L = Lu + Math.hypot(W[0] - E[0], W[1] - E[1], W[2] - E[2]);
    const sl = look.sleeve;
    const sleeveEnd = sl === 'long' ? L - 0.035 : sl === 'short' ? 0.14 : sl === 'rolled' ? Lu + 0.035 : -1;
    if (sleeveEnd > 0) {
      const cuffW = sl === 'rolled' ? 0.045 : 0.032;
      const cuffC = sl === 'rolled' ? outfitDk : top === 'parka' ? mixC(outfit, '#ffffff', 0.35) : top === 'open' ? accent : sl === 'short' ? outfitDk : accent;
      bands.push([-1, sleeveEnd - cuffW, outfit, sl === 'short' ? 0.005 : 0.005]);
      bands.push([sleeveEnd - cuffW, sleeveEnd, cuffC, sl === 'rolled' ? 0.011 : 0.008]);
      if (top === 'flight') bands.push([0.07, 0.1, accent, 0.006]); // shoulder stripe
    }
    if (glove) bands.push([L - 0.03, L + 0.1, glove, 0.006]);
    if (look.bracers) bands.push([Lu + 0.08, L - 0.01, accent, 0.008], [L - 0.01, L + 0.1, outfit, 0.004]);
    // sort bands so the later (more specific) ones win
    const bs = bands.slice().reverse();
    const rings = bandRings([S, E, W], (sv) => {
      const d = prof(sv);
      return [d[0] * lb, d[1] * lb, d[2] * lb];
    }, bs, { s0: -0.0, s1: L + 0.01, step: 0.09, keys: [Lu - 0.035, Lu, Lu + 0.035, L - 0.02], col: skinC });
    parts.add(tube(rings, { seg: seg(9), ref: [0, 0, 1], cap0: 0.052 * lb, capSeg: 2, cap1: 0.01 }), 'arm');

    // hand: palm, four curled fingers, thumb (palm faces the thigh, thumb forward)
    const hc = glove || skinC;
    const inward = -k; // palm direction along x
    const wx = W[0], wy = W[1], wz = W[2];
    const palm = tube([
      { p: [wx, wy + 0.012, wz], rx: 0.019, rf: 0.026, rb: 0.024 },
      { p: [wx + inward * 0.001, wy - 0.02, wz + 0.003], rx: 0.018, rf: 0.036, rb: 0.03 },
      { p: [wx + inward * 0.002, wy - 0.055, wz + 0.004], rx: 0.019, rf: 0.04, rb: 0.035 },
      { p: [wx + inward * 0.001, wy - 0.083, wz + 0.004], rx: 0.016, rf: 0.04, rb: 0.035 },
    ], { seg: seg(8), axis: [0, -1, 0], ref: [0, 0, 1], cap1: 0.012, capSeg: 2, n: 2.6, col: hc });
    parts.add(palm, 'hand');
    if (hi) {
      const fz = [0.027, 0.009, -0.009, -0.026], fl = [0.94, 1.05, 1.0, 0.8];
      for (let i = 0; i < 4; i++) {
        const l = fl[i];
        const k0 = [wx + inward * 0.001, wy - 0.083, wz + 0.004 + fz[i]];
        const pts = [[k0[0], k0[1] + 0.004, k0[2]]];
        let x = k0[0], y = k0[1] + 0.004, ang = 0.25;
        const segs = [0.04 * l, 0.024 * l, 0.02 * l];
        for (let j = 0; j < 3; j++) {
          ang += j === 0 ? 0.55 : 0.6;
          x += inward * Math.sin(ang) * segs[j];
          y -= Math.cos(ang) * segs[j];
          pts.push([x, y, k0[2] - 0.002 * j]);
        }
        parts.add(cord(pts, [0.0098, 0.0094, 0.0084, 0.0074].map((r) => r * (i === 3 ? 0.88 : 1)), hc, 4), 'fing');
      }
      // thumb
      const t0 = [wx + inward * 0.008, wy - 0.022, wz + 0.03];
      parts.add(cord([t0, [t0[0] + inward * 0.008, t0[1] - 0.026, t0[2] + 0.018], [t0[0] + inward * 0.018, t0[1] - 0.046, t0[2] + 0.022], [t0[0] + inward * 0.024, t0[1] - 0.062, t0[2] + 0.018]],
        [0.0135, 0.012, 0.0105, 0.009], hc, 5), 'hand');
    } else {
      // far LOD: a curled mitten
      parts.add(ell(0.02, 0.03, 0.04, 6, 4, wx + inward * 0.012, wy - 0.095, wz + 0.004, hc), 'hand');
    }
  }

  // ---------------- legs
  for (const k of [1, -1]) {
    const s = k > 0 ? 'L' : 'R';
    const H = rig.pos[`thigh${s}`], K = rig.pos[`shin${s}`], A = rig.pos[`foot${s}`];
    const Lt = Math.hypot(K[0] - H[0], K[1] - H[1], K[2] - H[2]);
    const L = Lt + Math.hypot(A[0] - K[0], A[1] - K[1], A[2] - K[2]);
    const flb = 1.08 * (1 + (lb - 1) * 0.7);
    const prof = table([
      [0, 0.093, 0.095, 0.1],
      [0.1, 0.089, 0.09, 0.096],
      [0.22, 0.081, 0.082, 0.083],
      [Lt - 0.06, 0.068, 0.07, 0.067],
      [Lt, 0.064, 0.068, 0.064],
      [Lt + 0.08, 0.064, 0.064, 0.074],
      [Lt + 0.2, 0.057, 0.056, 0.061],
      [L - 0.06, 0.055, 0.055, 0.055],
      [L - 0.02, 0.054, 0.054, 0.054],
    ]);
    const bands = [];
    if (look.boots) bands.push([L - 0.2, L + 0.1, shoes, 0.008], [L - 0.215, L - 0.2, mixC(shoes, '#ffffff', 0.2), 0.012]);
    else bands.push([L - 0.075, L - 0.04, pantsDk, 0.007]);
    if (look.knee) bands.push([Lt - 0.045, Lt + 0.045, mixC(accent, '#000000', 0.55), 0.012]);
    const rings = bandRings([H, K, A], (sv) => { const d = prof(sv); return [d[0] * flb, d[1] * flb, d[2] * flb]; }, bands,
      { s0: 0, s1: L - 0.015, step: 0.09, keys: [Lt - 0.045, Lt, Lt + 0.045], col: pants });
    parts.add(tube(rings, { seg: seg(10), ref: [0, 0, 1], cap0: 0.07, capSeg: 2, cap1: 0 }), 'leg');
    if (look.cargo && hi) parts.add(rbox(0.02, 0.1, 0.085, 0.01, 2, H[0] + k * 0.085, H[1] - 0.2, H[2] + 0.005, pantsDk, [0, 0, k * 0.08]), 'leg');

    // shoe (upper lofted heel -> toe) + sole slab
    const ax = A[0], az = A[2];
    const toeUp = 0.004;
    const shoeTab = table([
      [-0.075, 0.056, 0.03, 0.03, 0.035],
      [-0.06, 0.061, 0.043, 0.05, 0.05],
      [-0.02, 0.064, 0.049, 0.064, 0.053],
      [0.03, 0.058, 0.051, 0.054, 0.047],
      [0.08, 0.05, 0.053, 0.042, 0.039],
      [0.13, 0.044, 0.052, 0.034, 0.033],
      [0.17, 0.041 + toeUp, 0.046, 0.029, 0.029],
      [0.195, 0.039 + toeUp, 0.034, 0.024, 0.026],
    ]);
    const boot = look.boots;
    const shoeRings = [];
    for (const zz of [-0.075, -0.055, -0.01, 0.05, 0.12, 0.17, 0.195]) {
      const d = shoeTab(zz);
      shoeRings.push({ p: [ax, d[0] + (boot && zz < 0.02 ? 0.01 : 0), az + zz], rx: d[1], rf: d[2] + (boot && zz < 0.02 ? 0.02 : 0), rb: d[3], n: 2.4 });
    }
    parts.add(tube(shoeRings, { seg: seg(10), ref: [0, 1, 0], cap0: 0.014, cap1: 0.02, capSeg: 2, col: shoes }), 'foot');
    const soleC = (shoes.r + shoes.g + shoes.b) > 2.2 ? C('#4a4a50') : white;
    const soleRings = [];
    for (const zz of [-0.08, -0.02, 0.08, 0.16, 0.2]) {
      const d = shoeTab(zz);
      soleRings.push({ p: [ax, 0.012 + (zz > 0.15 ? (zz - 0.15) * 0.15 : 0), az + zz], rx: d[1] + 0.005, rf: 0.012, rb: 0.012, n: 4 });
    }
    parts.add(tube(soleRings, { seg: seg(10), ref: [0, 1, 0], cap0: 0.012, cap1: 0.016, capSeg: 1, col: soleC }), 'foot');
    if (hi && !boot) {
      const lc = mixC(shoes, (shoes.r + shoes.g + shoes.b) > 2.2 ? '#888888' : '#ffffff', 0.6);
      for (const zz of [0.035, 0.06, 0.085]) {
        const d = shoeTab(zz);
        parts.add(rbox(0.045, 0.006, 0.01, 0.003, 1, ax, d[0] + d[2] - 0.002, az + zz, lc, [-0.35, 0, 0]), 'foot');
      }
    }
  }

  // ---------------- head & face
  const headRings = HEAD.map(([y]) => { const h = headAt(y, fem); return { p: [0, y, h.zc], rx: h.rx, rf: h.rf, rb: h.rb, nf: h.nf }; });
  const blush = mixC(skinC, '#e0606a', fem ? 0.22 : 0.1);
  const scalp = mixC(skinC, hair, look.hair === 'mohawk' ? 0.72 : 0.45);
  const stub = mixC(skinC, hair, 0.32);
  const buzz = look.hair === 'mohawk' || look.hair === 'nemes';
  parts.add(tube(headRings, {
    seg: seg(18), axis: [0, 1, 0], cap0: 0.006, cap1: HEAD_DOME, capSeg: 2,
    color: (x, y, z, a) => {
      const f = a < 0 ? (y > 1.7 ? 0 : 1) : Math.sin(a);
      if (look.beard && f > -0.2 && y < 1.69 && !(Math.abs(x) < 0.03 && y > 1.645 && f > 0.8)) {
        const jaw = sstep(1.7, 1.66, y) * sstep(-0.2, 0.2, f);
        return mixC(skinC, stub, jaw);
      }
      if (buzz && y > hairline(f, 'short') - 0.005) return scalp;
      // cheeks
      const ch = Math.exp(-(((y - 1.685) / 0.02) ** 2)) * sstep(0.35, 0.6, f) * sstep(0.9, 0.7, f) * sstep(0.02, 0.05, Math.abs(x));
      return ch > 0.05 ? mixC(skinC, blush, ch) : skinC;
    },
  }), 'head');

  const eyeY = 1.722, eyeX = fem ? 0.035 : 0.034;
  for (const k of [1, -1]) {
    const ex = k * eyeX;
    const fz = faceZ(ex, eyeY, fem);
    // ears
    const ey = 1.712, ez = -0.006;
    const hx = headAt(ey, fem).rx;
    parts.add(ell(0.011, 0.029, 0.019, seg(7), seg(5), k * (hx + 0.002), ey, ez, skinC, [0, k * 0.4, k * 0.12]), 'head');
    
    // eye: white, iris, pupil, glint, lid line, brow
    const eyeR = fem ? 0.0172 : 0.0165;
    const ec = new THREE.Vector3(ex, eyeY, fz - 0.008);
    const yaw = k * 0.22;
    const eyeGeo = (r, c, th, ws, hs, sx = 1.18, sy = 0.86, sz = 0.7, dy = 0, dx = 0) => {
      const g = th ? weld(new THREE.SphereGeometry(r, ws, hs, 0, TAU, 0, th)) : weld(new THREE.SphereGeometry(r, ws, hs));
      if (th) { g.rotateX(Math.PI / 2); g.translate(0, 0, -r + eyeR * sz + 0.0006); }
      else g.scale(sx, sy, sz);
      if (dy || dx) g.translate(dx, dy, 0);
      g.rotateY(yaw);
      g.translate(ec.x, ec.y, ec.z);
      paint(g, c);
      g.computeVertexNormals();
      return g;
    };
    parts.add(eyeGeo(eyeR, C('#f7f3ee'), 0, seg(8), seg(6)), 'head');
    if (!look.shades) {
      parts.add(eyeGeo(0.021, C(look.eye), 0.46, hi ? 9 : 6, 1), 'head');
      parts.add(eyeGeo(0.0215, C('#0d0a0a'), 0.24, hi ? 7 : 5, 1), 'head');
      if (hi) parts.add(eyeGeo(0.0222, C('#ffffff'), 0.1, 5, 1, 1, 1, 1, 0.0035, -k * 0.003), 'head');
    }
    if (hi && !look.shades) {
      // upper lid / lash line
      const lid = [];
      const lr = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5, ang = lerp(0.15, Math.PI - 0.15, t);
        // along the visible rim of the eye (where the eyeball leaves the face surface)
        const lx = Math.cos(ang) * eyeR * 1.18 * 0.78 * k;
        const ly = Math.sin(ang) * eyeR * 0.86 * 0.8 + 0.0009;
        _w.set(lx, ly, 0.0084).applyAxisAngle(_u.set(0, 1, 0), yaw).add(ec);
        lid.push(_w.toArray());
        const outer = 1 - t; // t = 0 is the outer corner
        lr.push((fem || look.liner ? 0.0026 : 0.0018) * (0.7 + 0.6 * Math.sin(t * Math.PI)) + (fem || look.liner ? outer * 0.0012 : 0));
      }
      if (fem || look.liner) {
        const o = lid[0];
        lid.unshift([o[0] + k * 0.006, o[1] + 0.003, o[2] - 0.003]);
        lr.unshift(0.0012);
      }
      parts.add(cord(lid, lr, mixC(hair, '#000000', 0.7), 4), 'head');
    }
    // brow
    const by = eyeY + 0.026;
    const brow = [], br = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const bx = k * lerp(0.013, 0.058, t);
      const yy = by + Math.sin(t * Math.PI * 0.85) * 0.006 - t * 0.002;
      brow.push([bx, yy, faceZ(bx, yy, fem) + 0.0025]);
      br.push(lerp(fem ? 0.0035 : 0.0048, 0.0022, t * t));
    }
    const browC = (hair.r + hair.g + hair.b) > 2.2 ? mixC(hair, '#8aa0b8', 0.4) : mixC(hair, '#000000', 0.15);
    parts.add(cord(brow, br, browC, 4), 'head');
  }
  // nose: bridge + tip + nostril wings
  {
    const ny = 1.692, nz = faceZ(0, ny, fem);
    const sc = fem ? 0.85 : 1;
    parts.add(cord([[0, 1.738, faceZ(0, 1.738, fem) - 0.003], [0, 1.712, faceZ(0, 1.712, fem) + 0.006 * sc], [0, ny + 0.004, nz + 0.019 * sc]],
      [0.0068 * sc, 0.0078 * sc, 0.0105 * sc], skinC, seg(7)), 'head');
    if (hi) for (const k of [1, -1]) parts.add(ell(0.0085 * sc, 0.0068 * sc, 0.009 * sc, 6, 4, k * 0.0115 * sc, ny + 0.001, nz + 0.007 * sc, skinC), 'head');
  }
  // mouth
  {
    const my = 1.664;
    const up = [], ur = [], lo = [], lr = [], line = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4, x = lerp(-0.022, 0.022, t), bow = Math.sin(t * Math.PI);
      up.push([x * (fem ? 0.95 : 0.92), my + 0.0035 + bow * 0.0012, faceZ(x, my + 0.004, fem) + 0.0016 * bow]);
      ur.push(lerp(0.0016, fem ? 0.0046 : 0.0036, bow));
      line.push([x * 0.95, my + 0.0005 - bow * 0.0004, faceZ(x, my, fem) - 0.0004 + 0.0015 * bow]);
      const xl = x * 0.8;
      lo.push([xl, my - 0.0042 - bow * 0.0012, faceZ(xl, my - 0.005, fem) + 0.0012 * bow]);
      lr.push(lerp(0.0018, fem ? 0.0058 : 0.0045, bow));
    }
    parts.add(cord(up, ur, lipC, 4), 'head');
    parts.add(cord(lo, lr, lipC, 4), 'head');
    if (hi) parts.add(cord(line, line.map(() => 0.0013), mixC(lipC, '#2a0e0e', 0.6), 4), 'head');
  }
  if (look.shades) {
    const sc = C('#121418'), fr = accent;
    for (const k of [1, -1]) {
      const g = rbox(0.046, 0.026, 0.008, 0.007, 2, 0, 0, 0, sc);
      g.rotateY(k * 0.2);
      g.translate(k * 0.035, 1.723, faceZ(0.035, 1.723, fem) + 0.008);
      parts.add(g, 'head');
    }
    parts.add(cord([[-0.06, 1.737, faceZ(0.06, 1.737, fem) + 0.004], [0, 1.736, faceZ(0, 1.736, fem) + 0.011], [0.06, 1.737, faceZ(0.06, 1.737, fem) + 0.004]], [0.0028, 0.0028, 0.0028], fr, 4), 'head');
    for (const k of [1, -1]) parts.add(cord([[k * 0.062, 1.736, 0.07], [k * 0.088, 1.73, 0.0], [k * 0.086, 1.715, -0.02]], [0.0025, 0.0025, 0.0025], fr, 4, false), 'head');
  }

  // ---------------- hair & headwear
  buildHair(parts, look, sk, { fem, hi, seg, hair, accent, outfit, outfitDk, skinC });
  // slightly heroic head size: scale everything above the jaw about the chin
  for (const pt of parts.list) {
    if (pt.region !== 'head' && pt.region !== 'hood' && pt.region !== 'hair') continue;
    pt.g.translate(0, -HEAD_PIVOT[1], -HEAD_PIVOT[2]);
    pt.g.scale(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE);
    pt.g.translate(0, HEAD_PIVOT[1] - HEAD_DROP, HEAD_PIVOT[2]);
  }

  // ---------------- back bling and straps
  buildPack(parts, look, sk, { hi, seg, outfit, accent, pants, dark, leather, b });

  // ---------------- extra clothing details
  if (top === 'hoodie' && hi) {
    // kangaroo pocket
    const [zc, , rf] = tp(1.15);
    parts.add(rbox(0.19 * b.wa, 0.085, 0.02, 0.008, 2, 0, 1.15, zc + rf + 0.002, outfitDk), 'torso');
  }
  if (top === 'jacket' && hi) {
    for (const k of [1, -1]) {
      const [zc, , rf] = tp(1.33);
      parts.add(rbox(0.06, 0.06, 0.016, 0.006, 2, k * 0.07, 1.34, zc + rf + 0.002 - 0.01, mixC(outfit, '#000000', 0.15), [0, k * 0.3, 0]), 'torso');
    }
  }
  // belt buckle
  {
    const [zc, , rf] = tp(1.048);
    parts.add(rbox(0.04, 0.032, 0.01, 0.005, 1, 0, 1.048, zc + rf + 0.01, top === 'pharaoh' ? accent : C('#c9b46a')), 'hips');
  }
  if (top === 'pharaoh') {
    // kilt flap (shendyt)
    const [zc, , rf] = tp(1.0);
    const flap = tube([
      { p: [0, 1.03, zc + rf + 0.012], rx: 0.06, rf: 0.006, rb: 0.006, n: 4 },
      { p: [0, 0.93, zc + rf + 0.02], rx: 0.07, rf: 0.006, rb: 0.006, n: 4 },
      { p: [0, 0.85, zc + rf + 0.028], rx: 0.08, rf: 0.006, rb: 0.006, n: 4 },
    ], { seg: 8, ref: [0, 0, 1], cap1: 0.004, color: (x) => (Math.abs(x) > 0.055 ? accent : outfit) });
    parts.add(flap, 'hips');
  }
  return { parts: parts.list, rig };
}

// ------------------------------------------------------------------ hair
const HAIRLINE = {
  // [front-ness f (sin of ring angle), hairline y]; interpolated
  short: [[-1, 1.645], [-0.4, 1.69], [0.0, 1.74], [0.35, 1.77], [0.7, 1.79], [1, 1.795]],
  bangs: [[-1, 1.64], [-0.4, 1.69], [0.0, 1.735], [0.4, 1.755], [0.7, 1.762], [1, 1.765]],
  high: [[-1, 1.67], [-0.4, 1.71], [0.0, 1.75], [0.4, 1.78], [1, 1.805]],
  hood: [[-1, 2], [0.4, 2], [0.6, 1.79], [1, 1.775]],
};
const hlTabs = {};
function hairline(f, style) {
  const t = hlTabs[style] || (hlTabs[style] = table(HAIRLINE[style]));
  return t(f)[0];
}

function shell(look, o) {
  // rings follow the head, inflated by T; outside the hair mask they sink under the skin
  const ys = [];
  for (let y = o.y0; y < HEAD_TOP; y += o.step || 0.028) ys.push(y);
  ys.push(HEAD_TOP);
  const rings = ys.map((y) => { const h = headAt(y, o.fem); const T = o.T(y); return { p: [0, y, h.zc], rx: h.rx + T, rf: h.rf + T, rb: h.rb + T, nf: h.nf, T, y }; });
  return tube(rings, {
    seg: o.seg, axis: [0, 1, 0], cap1: HEAD_DOME + o.T(HEAD_TOP), capSeg: 2,
    warp: (p, a, r, L) => {
      const f = a < 0 ? 0 : Math.sin(a), sd = a < 0 ? 0 : Math.cos(a);
      const m = o.mask(p.y, f, sd);
      const dx = p.x, dz = p.z - r.p[2], d = Math.hypot(dx, dz);
      let k = 1;
      if (m < 1 && d > 1e-5) k = lerp((d - r.T - 0.005) / d, 1, m);
      if (o.bump && m > 0 && d > 1e-5) k *= 1 + o.bump(p.y, a) * m / d;
      p.x = dx * k; p.z = r.p[2] + dz * k;
    },
    color: o.color || ((x, y, z, a) => (a < 0 ? o.col : mixC(o.col, '#000000', 0.12 + 0.12 * Math.sin(a * 17 + y * 30)))),
  });
}

function buildHair(parts, look, sk, ctx) {
  const { fem, hi, seg, hair, accent, outfit, outfitDk } = ctx;
  const style = look.hair;
  const hairDk = mixC(hair, '#000000', 0.35);
  const mk = (line, soft = 0.008) => (y, f, sd) => {
    const h = hairline(f, line) + 0.006 * Math.sin(Math.atan2(f, sd) * 13);
    return sstep(h - soft, h + soft, y);
  };
  const tip = (p0, dir, len, r0, c, sgm = 5) => {
    const d = new THREE.Vector3().fromArray(dir).normalize();
    const a = new THREE.Vector3().fromArray(p0);
    const pts = [a.toArray(), a.clone().addScaledVector(d, len * 0.45).toArray(), a.clone().addScaledVector(d, len * 0.8).toArray(), a.clone().addScaledVector(d, len).toArray()];
    return cord(pts, [r0, r0 * 0.72, r0 * 0.38, r0 * 0.12], c, sgm);
  };
  const scalpPoint = (y, a, T) => {
    const p = headPoint(y, a, fem);
    const h = headAt(y, fem);
    const dx = p.x, dz = p.z - h.zc, d = Math.hypot(dx, dz) || 1;
    p.x += (dx / d) * T; p.z += (dz / d) * T;
    return p;
  };
  if (style === 'hood') {
    // fringe peeking out under the hood
    parts.add(shell(look, { fem, seg: seg(18), y0: 1.7, T: () => 0.012, mask: mk('hood', 0.01), col: hair }), 'head');
    // hood: loose shell around the head with a face opening, draping onto the shoulders
    const prof = table([
      [1.455, -0.03, 0.16, 0.1, 0.12],
      [1.5, -0.028, 0.125, 0.092, 0.112],
      [1.56, -0.02, 0.1, 0.09, 0.106],
      [1.62, -0.006, 0.101, 0.104, 0.11],
      [1.68, -0.002, 0.106, 0.112, 0.118],
      [1.74, -0.004, 0.109, 0.112, 0.124],
      [1.8, -0.012, 0.101, 0.1, 0.122],
      [1.85, -0.02, 0.082, 0.074, 0.104],
      [1.875, -0.024, 0.056, 0.05, 0.075],
    ]);
    const ys = [1.455, 1.49, 1.53, 1.57, 1.6, 1.625, 1.66, 1.7, 1.74, 1.78, 1.81, 1.84, 1.875];
    const rings = ys.map((y) => { const d = prof(y); return { p: [0, y, d[0]], rx: d[1], rf: d[2], rb: d[3], nf: 2.3, y }; });
    const open = (y, f) => sstep(0.36, 0.52, f) * sstep(1.585, 1.612, y) * sstep(1.82, 1.795, y);
    const hoodIn = mixC(outfit, '#000000', 0.55);
    parts.add(tube(rings, {
      seg: seg(19), axis: [0, 1, 0], cap1: 0.024, capSeg: 2,
      warp: (p, a) => {
        if (a < 0) return;
        const f = Math.sin(a), m = open(p.y, f);
        if (m <= 0) return;
        const hp = headPoint(p.y, a, fem, _u);
        const h = headAt(p.y, fem);
        hp.x *= 0.96; hp.z = h.zc + (hp.z - h.zc) * 0.96;
        p.lerp(hp, m);
      },
      color: (x, y, z, a) => {
        if (a < 0) return outfit;
        // the opening slopes into the hood: shadowed lining, a thin accent trim on the lip
        const m = open(y, Math.sin(a));
        return m > 0.5 ? hoodIn : m > 0.02 ? accent : outfit;
      },
    }), 'hood');
    if (hi) for (const k of [1, -1]) parts.add(cord([[k * 0.042, 1.585, 0.085], [k * 0.046, 1.52, 0.1], [k * 0.044, 1.44, 0.122]], [0.004, 0.0035, 0.005], accent, 4), 'chest');
    return;
  }
  if (style === 'spiky') {
    parts.add(shell(look, { fem, seg: seg(18), y0: 1.62, T: () => 0.013, mask: mk('short'), col: hair }), 'head');
    const spikes = hi ? [
      [1.84, 1.9, 0.12, [0, 1, 0.45]], [1.83, 1.25, 0.1, [0.25, 1, 0.3]], [1.83, 2.55, 0.1, [-0.25, 1, 0.3]],
      [1.82, 0.5, 0.09, [0.6, 0.9, 0]], [1.82, 2.64, 0.09, [-0.6, 0.9, 0]], [1.84, 4.1, 0.1, [0.25, 1, -0.5]],
      [1.84, 5.3, 0.1, [-0.25, 1, -0.5]], [1.79, 3.9, 0.09, [0.3, 0.6, -1]], [1.79, 5.5, 0.09, [-0.3, 0.6, -1]],
      [1.86, 4.7, 0.11, [0, 1, -0.2]], [1.81, 1.57, 0.085, [0, 0.8, 0.9]],
    ] : [[1.84, 1.9, 0.12, [0, 1, 0.45]], [1.83, 0.5, 0.09, [0.6, 0.9, 0]], [1.83, 2.64, 0.09, [-0.6, 0.9, 0]], [1.84, 4.7, 0.11, [0, 1, -0.4]]];
    for (const [y, a, len, dir] of spikes) {
      const p = scalpPoint(y, a, 0.0);
      parts.add(tip(p.toArray(), dir, len, 0.026, hair, seg(6)), 'head');
    }
    return;
  }
  if (style === 'ponytail') {
    parts.add(shell(look, { fem, seg: seg(18), y0: 1.64, T: () => 0.011, mask: mk('high'), col: hair }), 'head');
    // side-swept strand over the forehead
    const path = [[0, 1.745, -0.09], [0, 1.745, -0.118], [0, 1.715, -0.152], [0, 1.655, -0.168], [0, 1.59, -0.165], [0, 1.53, -0.152], [0, 1.485, -0.14]];
    const rr = [0.024, 0.027, 0.032, 0.031, 0.026, 0.017, 0.006];
    const rings = path.map((p, i) => ({ p, rx: rr[i], rf: rr[i] * 0.9, rb: rr[i] * 0.9, col: i < 2 ? accent : hair }));
    rings.splice(2, 0, { p: [0, 1.742, -0.13], rx: 0.026, rf: 0.024, rb: 0.024, col: hair });
    rings[1].rx += 0.004; rings[1].rf += 0.004; rings[1].rb += 0.004;
    parts.add(tube(rings, { seg: seg(9), ref: [1, 0, 0], cap1: 0.01, capSeg: 2 }), 'hair');
    return;
  }
  if (style === 'curly') {
    parts.add(shell(look, {
      fem, seg: seg(24), y0: 1.62, step: hi ? 0.016 : 0.026, T: (y) => 0.024 + 0.01 * sstep(1.7, 1.84, y), mask: mk('short', 0.006),
      bump: hi ? (y, a) => 0.008 * Math.sin(a * 9 + y * 70) * Math.cos(y * 95 - a * 5) : null,
      color: (x, y, z, a) => {
        const v = a < 0 ? 0 : Math.sin(a * 9 + y * 70) * Math.cos(y * 95 - a * 5);
        return mixC(hair, '#000000', 0.25 - v * 0.2);
      },
    }), 'head');
    return;
  }
  if (style === 'long' || style === 'bob') {
    const bob = style === 'bob';
    parts.add(shell(look, { fem, seg: seg(18), y0: 1.63, T: (y) => 0.013 + 0.004 * sstep(1.76, 1.84, y), mask: mk('bangs'), col: hair }), 'head');
    // side-swept bangs
    if (hi) {
      parts.add(cord([[0.07, 1.82, 0.06], [0.03, 1.79, 0.093], [-0.01, 1.772, 0.1], [-0.05, 1.77, 0.088], [-0.08, 1.76, 0.05]], [0.008, 0.014, 0.014, 0.011, 0.006], hair, 6), 'head');
    }
    // curtain of hair: horseshoe-shaped tube open at the face
    const yEnd = bob ? 1.625 : 1.455;
    const ys = [];
    for (let y = 1.8; y > yEnd; y -= bob ? 0.035 : 0.045) ys.push(y);
    ys.push(yEnd, yEnd - 0.008);
    const K = seg(18) & ~1;
    const rings = ys.map((y) => {
      const t = (1.8 - y) / (1.8 - yEnd);
      const h = headAt(Math.max(y, 1.64), fem);
      const flare = bob ? 0.012 + 0.02 * t : 0.012 + 0.05 * sstep(0.35, 1, t);
      return { p: [0, y, h.zc - 0.012 - (bob ? 0 : 0.03 * sstep(0.4, 1, t))], rx: h.rx + flare, rf: h.rf + flare, rb: h.rb + flare + (bob ? 0 : 0.01 * t), t: Math.min(1, t), y, end: y < yEnd };
    });
    const angles = [];
    for (let k = 0; k < K; k++) angles.push(k);
    parts.add(tube(rings, {
      angles, axis: [0, -1, 0], ref: [0, 0, 1], col: hair,
      warp: (p, a, r, L, f) => {
        // a is a vertex index here: first half outer arc, second half inner arc (reversed)
        if (a < 0) return;
        const half = K / 2, outer = a < half, j = outer ? a : K - 1 - a;
        const open = (bob ? 1.25 : 1.15) - 0.25 * r.t; // half-opening around the face (rad)
        const ang = -FRONT + open + (j / (half - 1)) * (TAU - 2 * open); // measured from +x toward -z (back)
        const c = Math.cos(ang), s = Math.sin(ang);
        const th = r.end ? 0.007 : (outer ? 1 : 0) * (bob ? 0.016 : 0.014);
        const rz = (s < 0 ? r.rf : r.rb) - 0.014 + th;
        p.set(c * (r.rx - 0.014 + th), r.y, r.p[2] - s * rz);
        if (!bob) {
          // wavy ends
          p.y += 0.008 * Math.sin(j * 1.7) * r.t * r.t;
        }
      },
    }), 'hair');
    if (look.goggles) {
      const gy = 1.8;
      const h = headAt(gy, fem);
      parts.add(tube([
        { p: [0, gy - 0.012, h.zc], rx: h.rx + 0.019, rf: h.rf + 0.02, rb: h.rb + 0.02 },
        { p: [0, gy + 0.012, h.zc], rx: h.rx + 0.018, rf: h.rf + 0.019, rb: h.rb + 0.019 },
      ], { seg: seg(18), axis: [0, 1, 0], col: C('#2b1d16') }), 'head');
      for (const k of [1, -1]) {
        const lens = weld(new THREE.CylinderGeometry(0.024, 0.026, 0.02, seg(12), 1));
        lens.rotateX(Math.PI / 2 - 0.35); lens.rotateY(k * 0.3);
        lens.translate(k * 0.036, gy + 0.004, faceZ(0.036, gy, fem) + 0.026);
        paint(lens, accent);
        lens.computeVertexNormals();
        parts.add(lens, 'head');
        parts.add(ell(0.02, 0.02, 0.006, 8, 4, k * 0.036 + k * 0.003, gy + 0.008, faceZ(0.036, gy, fem) + 0.037, C('#ffb347'), [-0.35, k * 0.3, 0]), 'head');
      }
    }
    return;
  }
  if (style === 'mohawk') {
    // crest of spikes along the midline (sides are buzzed via head vertex colours)
    const cy = 1.735, cz = -0.004;
    const path = [], rf = [];
    const N = hi ? 12 : 7;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const ph = lerp(0.42, Math.PI + 0.45, t); // from forehead over the top to the nape
      const ry = 0.132, rz = Math.cos(ph) > 0 ? 0.096 : 0.104;
      path.push([0, cy + Math.sin(ph) * ry, cz + Math.cos(ph) * rz]);
      rf.push((i % 2 ? 0.05 : 0.085) * (0.5 + 0.5 * Math.sin(t * Math.PI)) + 0.012);
    }
    const rings = path.map((p, i) => ({ p, rx: 0.019 * (1 - 0.35 * Math.abs(i / N - 0.4)), rf: rf[i], rb: 0.014, nf: 1.5 }));
    parts.add(tube(rings, { seg: seg(8), ref: [0, 0.4, 1], cap0: 0.01, cap1: 0.01, capSeg: 2, col: hair }), 'head');
    return;
  }
  if (style === 'nemes') {
    // striped royal headcloth over a short shell, side lappets and a back panel
    const blue = accent, gold = outfit;
    const stripe = (y) => (Math.floor(y / 0.022) % 2 ? blue : gold);
    parts.add(shell(look, {
      fem, seg: seg(22), y0: 1.6, T: (y) => 0.02 + 0.006 * sstep(1.7, 1.82, y),
      mask: (y, f) => Math.max(sstep(1.782, 1.796, y), sstep(0.6, 0.45, f) * sstep(1.6, 1.625, y)),
      color: (x, y) => stripe(y),
    }), 'head');
    // brow band
    const by = 1.795, h = headAt(by, fem);
    parts.add(tube([
      { p: [0, by - 0.01, h.zc], rx: h.rx + 0.024, rf: h.rf + 0.024, rb: h.rb + 0.024 },
      { p: [0, by + 0.01, h.zc], rx: h.rx + 0.024, rf: h.rf + 0.024, rb: h.rb + 0.024 },
    ], { seg: seg(20), axis: [0, 1, 0], col: gold }), 'head');
    if (hi) parts.add(cord([[0, by - 0.004, h.zc + h.rf + 0.024], [0, by + 0.02, h.zc + h.rf + 0.035], [0, by + 0.035, h.zc + h.rf + 0.03]], [0.008, 0.006, 0.004], blue, 5), 'head');
    for (const k of [1, -1]) {
      const pts = [[k * 0.094, 1.7, 0.0], [k * 0.108, 1.6, 0.025], [k * 0.112, 1.5, 0.05], [k * 0.11, 1.41, 0.072]];
      const rings = pts.map((p, i) => ({ p, rx: 0.024 + i * 0.006, rf: 0.008, rb: 0.008, n: 4, y: p[1] }));
      parts.add(tube(rings, { seg: 8, ref: [0.3 * k, 0, 1], cap1: 0.006, capSeg: 1, color: (x, y) => stripe(y) }), 'hair');
    }
    const back = [[0, 1.7, -0.115], [0, 1.6, -0.12], [0, 1.5, -0.13], [0, 1.44, -0.14]];
    parts.add(tube(back.map((p, i) => ({ p, rx: 0.07 + i * 0.025, rf: 0.012, rb: 0.012, n: 4 })), { seg: 8, ref: [0, 0, -1], cap1: 0.008, capSeg: 1, color: (x, y) => stripe(y) }), 'hair');
    return;
  }
  // default short hair
  parts.add(shell(look, { fem, seg: seg(18), y0: 1.62, T: () => 0.013, mask: mk('short'), col: hair }), 'head');
}

// ------------------------------------------------------------------ back bling
function buildPack(parts, look, sk, ctx) {
  const { hi, seg, outfit, accent, pants, dark, leather, b } = ctx;
  const kind = look.pack;
  const zb = -0.1 - (b.ch - 1) * 0.08; // torso back surface around the shoulder blades
  const strapC = mixC(C(sk.pants), '#000000', 0.2);
  const straps = (topY, botY, c) => {
    for (const k of [1, -1]) {
      const pts = [[k * 0.075, topY, zb - 0.01], [k * 0.088, 1.49, -0.06], [k * 0.098, 1.5, 0.0], [k * 0.105, 1.45, 0.075], [k * 0.112, 1.33, 0.112 * b.ch + 0.002], [k * 0.13, 1.2, 0.1 * b.ch], [k * 0.15, botY, 0.02], [k * 0.13, botY - 0.01, zb]];
      const rings = pts.map((p) => ({ p, rx: 0.017, rf: 0.0045, rb: 0.0045, n: 3 }));
      parts.add(tube(rings, { seg: hi ? 6 : 4, ref: [0, 0, -1], col: c }), 'torso');
    }
  };
  if (kind === 'boombox') {
    parts.add(rbox(0.34, 0.2, 0.1, 0.02, hi ? 3 : 2, 0, 1.31, zb - 0.06, dark), 'chest');
    for (const k of [1, -1]) {
      const sp = weld(new THREE.CylinderGeometry(0.058, 0.062, 0.02, seg(14), 1));
      sp.rotateX(Math.PI / 2); sp.translate(k * 0.09, 1.31, zb - 0.115); paint(sp, accent); sp.computeVertexNormals();
      parts.add(sp, 'chest');
      parts.add(ell(0.026, 0.026, 0.01, seg(8), 4, k * 0.09, 1.31, zb - 0.125, C('#202020')), 'chest');
    }
    parts.add(cord([[-0.12, 1.41, zb - 0.06], [-0.1, 1.45, zb - 0.06], [0.1, 1.45, zb - 0.06], [0.12, 1.41, zb - 0.06]], [0.008, 0.008, 0.008, 0.008], C('#888888'), 5, false), 'chest');
    straps(1.38, 1.22, strapC);
    return;
  }
  if (kind === 'wings') {
    for (const k of [1, -1]) {
      const feathers = hi ? 3 : 2;
      for (let i = 0; i < feathers; i++) {
        const t = i / Math.max(1, feathers - 1);
        const p0 = [k * 0.06, 1.38 - t * 0.06, zb - 0.03];
        const pts = [p0, [k * (0.2 + t * 0.02), 1.48 - t * 0.12, zb - 0.1], [k * (0.34 - t * 0.04), 1.62 - t * 0.26, zb - 0.16]];
        const rings = pts.map((p, j) => ({ p, rx: [0.03, 0.045, 0.012][j], rf: 0.008, rb: 0.008, n: 2.6 }));
        parts.add(tube(rings, { seg: 6, ref: [0, 0, 1], cap0: 0.01, cap1: 0.02, capSeg: 1, color: () => mixC(i % 2 ? accent : outfit, '#ffd040', t * 0.4) }), 'chest');
      }
    }
    parts.add(rbox(0.12, 0.12, 0.05, 0.02, 2, 0, 1.36, zb - 0.025, accent), 'chest');
    straps(1.4, 1.26, strapC);
    return;
  }
  if (kind === 'heart') {
    for (const k of [1, -1]) parts.add(ell(0.085, 0.085, 0.055, seg(12), seg(8), k * 0.06, 1.34, zb - 0.055, accent), 'chest');
    const tipG = rbox(0.12, 0.12, 0.1, 0.03, 2, 0, 0, 0, accent, [0, 0, Math.PI / 4]);
    tipG.translate(0, 1.27, zb - 0.055);
    parts.add(tipG, 'chest');
    straps(1.38, 1.22, mixC(accent, '#ffffff', 0.4));
    return;
  }
  if (kind === 'tablet') {
    const g = rbox(0.24, 0.36, 0.07, 0.03, hi ? 3 : 2, 0, 1.29, zb - 0.045, outfit);
    parts.add(g, 'chest');
    for (const yy of [1.2, 1.28, 1.36]) parts.add(rbox(0.22, 0.025, 0.01, 0.005, 1, 0, yy, zb - 0.083, accent), 'chest');
    parts.add(ell(0.035, 0.035, 0.012, 8, 6, 0, 1.42, zb - 0.082, accent), 'chest');
    straps(1.42, 1.18, C(sk.accent));
    return;
  }
  // standard backpack (+ bed roll for 'roll')
  const pc = kind === 'roll' ? leather : accent;
  parts.add(rbox(0.26 * b.sh, 0.32, 0.12, 0.035, hi ? 3 : 2, 0, 1.285, zb - 0.058, pc), 'chest');
  parts.add(rbox(0.27 * b.sh, 0.1, 0.13, 0.03, 2, 0, 1.4, zb - 0.06, outfit, [0.12, 0, 0]), 'chest');
  if (hi) parts.add(rbox(0.16, 0.12, 0.04, 0.015, 2, 0, 1.21, zb - 0.125, kind === 'roll' ? mixC(leather, '#000000', 0.2) : mixC(accent, '#000000', 0.2)), 'chest');
  if (kind === 'roll') {
    const roll = weld(new THREE.CylinderGeometry(0.05, 0.05, 0.32, seg(12), 1));
    roll.rotateZ(Math.PI / 2); roll.translate(0, 1.47, zb - 0.07); paint(roll, C('#5d7a3a')); roll.computeVertexNormals();
    parts.add(roll, 'chest');
  }
  straps(1.42, 1.2, strapC);
}

// ------------------------------------------------------------------ assembly
export function buildHumanGeometry(skin, lod = 0) {
  const { parts, rig } = buildBody(skin, lod);
  const weigh = weigher(rig);
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.g.attributes.position.count; ni += p.g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const { g, region } of parts) {
    const P = g.attributes.position, N = g.attributes.normal, Cc = g.attributes.color;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const o = (vo + i) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      nor[o] = N.getX(i); nor[o + 1] = N.getY(i); nor[o + 2] = N.getZ(i);
      col[o] = Cc.getX(i); col[o + 1] = Cc.getY(i); col[o + 2] = Cc.getZ(i);
      weigh(region, x, y, z, si, sw, (vo + i) * 4);
    }
    const ix = g.index;
    for (let i = 0; i < ix.count; i++) index[io + i] = ix.getX(i) + vo;
    vo += P.count; io += ix.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}
