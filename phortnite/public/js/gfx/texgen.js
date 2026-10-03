// Procedural, tileable texture generators. Pure JS (no DOM / WebGL) so they can run
// anywhere; textures.js wraps the output into three.js textures.
//
// Every generator returns { size, color: Uint8Array RGBA, height: Float32Array }.
// Normals are derived from height by textures.js.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const hash = (n) => {
  let x = Math.imul(n ^ 0x27d4eb2d, 0x165667b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) % 100000) / 100000;
};

/** Tileable value noise. Periods must be integers so the texture wraps. */
class ValueNoise {
  constructor(seed) {
    this.seed = seed;
    this.lat = new Map();
  }
  lattice(P) {
    let a = this.lat.get(P);
    if (!a) {
      const r = mulberry32(this.seed * 131 + P * 7919);
      a = new Float32Array(P * P);
      for (let i = 0; i < a.length; i++) a[i] = r();
      this.lat.set(P, a);
    }
    return a;
  }
  sample(u, v, Px, Py = Px) {
    const P = Math.max(Px, Py);
    const a = this.lattice(P);
    const x = u * Px, y = v * Py;
    let xi = Math.floor(x), yi = Math.floor(y);
    const fx = smooth(x - xi), fy = smooth(y - yi);
    xi = ((xi % Px) + Px) % Px;
    yi = ((yi % Py) + Py) % Py;
    const x1 = (xi + 1) % Px, y1 = (yi + 1) % Py;
    const a00 = a[yi * P + xi], a10 = a[yi * P + x1], a01 = a[y1 * P + xi], a11 = a[y1 * P + x1];
    return mix(mix(a00, a10, fx), mix(a01, a11, fx), fy);
  }
  fbm(u, v, P, oct = 4, gain = 0.5, Py = P) {
    let sum = 0, amp = 1, norm = 0, px = P, py = Py;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.sample(u + i * 0.137, v + i * 0.271, px, py);
      norm += amp;
      amp *= gain;
      px *= 2;
      py *= 2;
    }
    return sum / norm;
  }
}

/** Tileable cellular noise (F1, F2 and cell id). */
class Worley {
  constructor(seed, P) {
    this.P = P;
    const r = mulberry32(seed);
    this.pts = new Float32Array(P * P * 2);
    for (let i = 0; i < P * P * 2; i++) this.pts[i] = r();
    this.out = { f1: 0, f2: 0, id: 0 };
  }
  sample(u, v) {
    const P = this.P;
    const x = u * P, y = v * P;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i, cy = yi + j;
        const wx = ((cx % P) + P) % P, wy = ((cy % P) + P) % P;
        const k = (wy * P + wx) * 2;
        const dx = cx + this.pts[k] - x, dy = cy + this.pts[k + 1] - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; id = wy * P + wx; } else if (d < f2) f2 = d;
      }
    }
    this.out.f1 = f1; this.out.f2 = f2; this.out.id = id;
    return this.out;
  }
}

function makeImg(size) {
  return { size, color: new Uint8Array(size * size * 4), height: new Float32Array(size * size) };
}

function put(img, i, r, g, b, h) {
  const c = img.color;
  c[i * 4] = clamp01(r) * 255;
  c[i * 4 + 1] = clamp01(g) * 255;
  c[i * 4 + 2] = clamp01(b) * 255;
  c[i * 4 + 3] = 255;
  img.height[i] = h;
}

// ------------------------------------------------------------------ terrain
export function grass(size = 512, seed = 1) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const c1 = hex(0x4f9d33), c2 = hex(0x6cbf3f), c3 = hex(0x3b7f28), dry = hex(0x9fbf4a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const big = n.fbm(u, v, 4, 3);
      const mid = n.fbm(u, v, 16, 3);
      const blades = n.sample(u, v, 128, 24) * 0.6 + n.sample(u, v, 256, 48) * 0.4;
      const speck = n.sample(u, v, 160);
      let r = mix(c1[0], c2[0], big), g = mix(c1[1], c2[1], big), b = mix(c1[2], c2[2], big);
      const dk = smooth(clamp01((mid - 0.35) * 2));
      r = mix(r, c3[0], dk * 0.45); g = mix(g, c3[1], dk * 0.45); b = mix(b, c3[2], dk * 0.45);
      const dr = smooth(clamp01((n.fbm(u + 0.5, v, 6, 2) - 0.62) * 4));
      r = mix(r, dry[0], dr * 0.5); g = mix(g, dry[1], dr * 0.5); b = mix(b, dry[2], dr * 0.5);
      const lb = 0.82 + blades * 0.32;
      r *= lb; g *= lb; b *= lb;
      if (speck > 0.8) { r *= 1.15; g *= 1.12; }
      put(img, i, r, g, b, blades * 0.7 + mid * 0.3);
    }
  }
  return img;
}

export function sand(size = 512, seed = 2) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const base = hex(0xe7d29b), dark = hex(0xcbb37a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const warp = n.fbm(u, v, 4, 3) * 3;
      const rip = Math.sin((v * 14 + warp) * Math.PI * 2) * 0.5 + 0.5;
      const grain = n.sample(u, v, 256) * 0.6 + n.sample(u, v, 128) * 0.4;
      const patch = n.fbm(u, v, 6, 3);
      const t = clamp01(patch * 0.8 + rip * 0.15);
      let r = mix(base[0], dark[0], t), g = mix(base[1], dark[1], t), b = mix(base[2], dark[2], t);
      const k = 0.9 + grain * 0.18;
      put(img, i, r * k, g * k, b * k, rip * 0.5 + grain * 0.35);
    }
  }
  return img;
}

export function rock(size = 512, seed = 3) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 9, 6);
  const c1 = hex(0x8f8d86), c2 = hex(0x6a665f), moss = hex(0x5d7a3a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 6, 5);
      const strata = Math.sin((v * 9 + f * 1.6) * Math.PI * 2) * 0.5 + 0.5;
      const cell = w.sample(u, v);
      const crackVis = smooth(clamp01((n.fbm(u + 0.3, v, 5, 2) - 0.35) * 3));
      const crack = 1 - (1 - smooth(clamp01((cell.f2 - cell.f1) * 22))) * crackVis;
      const fine = n.sample(u, v, 128);
      let r = mix(c1[0], c2[0], strata * 0.6 + f * 0.4);
      let g = mix(c1[1], c2[1], strata * 0.6 + f * 0.4);
      let b = mix(c1[2], c2[2], strata * 0.6 + f * 0.4);
      const tint = (hash(cell.id) * 0.1 - 0.05) * crackVis;
      r += tint; g += tint; b += tint * 0.8;
      const mz = smooth(clamp01((n.fbm(u, v, 4, 3) - 0.62) * 5));
      r = mix(r, moss[0], mz * 0.6); g = mix(g, moss[1], mz * 0.6); b = mix(b, moss[2], mz * 0.6);
      const k = (0.55 + crack * 0.45) * (0.88 + fine * 0.22);
      put(img, i, r * k, g * k, b * k, f * 0.5 + crack * 0.6 + strata * 0.15 + fine * 0.1);
    }
  }
  return img;
}

export function dirt(size = 512, seed = 4) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 3, 24);
  const c1 = hex(0x8a6644), c2 = hex(0x6b4c31), peb = hex(0xa69680);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 8, 4);
      const cell = w.sample(u, v);
      const pebble = hash(cell.id) > 0.78 ? smooth(clamp01((0.26 - cell.f1) * 7)) : 0;
      let r = mix(c1[0], c2[0], f), g = mix(c1[1], c2[1], f), b = mix(c1[2], c2[2], f);
      const pv = 0.6 + hash(cell.id + 7) * 0.35;
      r = mix(r, peb[0] * pv, pebble); g = mix(g, peb[1] * pv, pebble); b = mix(b, peb[2] * pv, pebble);
      const k = 0.88 + n.sample(u, v, 200) * 0.24;
      put(img, i, r * k, g * k, b * k, f * 0.4 + pebble * 0.8);
    }
  }
  return img;
}

// ------------------------------------------------------------------ building materials
/** Wooden planks. frame>0 adds a chunky border (used for player builds). */
export function planks(size = 512, seed = 5, { frame = 0, base = 0xc08048, rows = 8, vertical = false } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = hex(base);
  const ph = size / rows;
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const x = vertical ? yy : xx, y = vertical ? xx : yy;
      const u = x / size, v = y / size, i = yy * size + xx;
      const row = Math.floor(y / ph);
      const ry = (y - row * ph) / ph;
      const jointX = hash(row * 17 + seed) * size;
      const lx = (x - jointX + size) % size;
      const seg = lx < size * 0.58 ? 0 : 1;
      const pid = row * 2 + seg;
      const tint = 0.82 + hash(pid * 31 + seed) * 0.3;
      const gw = n.fbm(u, v, 3, 3, 0.5, 24);
      const grainLines = Math.abs(Math.sin((ry * 3 + gw * 5 + hash(pid) * 9) * Math.PI));
      const grain = 0.8 + 0.2 * smooth(grainLines);
      const knotW = n.sample(u, v, 6, 6);
      const knot = knotW > 0.82 ? (knotW - 0.82) * 4 : 0;
      let h = 0.8;
      let k = tint * grain * (1 - knot * 0.5);
      const edge = Math.min(ry, 1 - ry);
      if (edge < 0.05) { k *= 0.45 + edge * 8; h = edge * 12; }
      const jd = Math.min(Math.abs(lx), Math.abs(lx - size * 0.58), size - lx);
      if (jd < 2.5) { k *= 0.5; h = 0.2; }
      // nails near joints
      const nx = Math.min(Math.abs(lx - 7), Math.abs(lx - size * 0.58 - 7));
      const ny = Math.min(Math.abs(ry - 0.25), Math.abs(ry - 0.75)) * ph;
      if (nx * nx + ny * ny < 5) { k = 0.35; h = 1; }
      let r = col[0] * k, g = col[1] * k, b = col[2] * k;
      if (frame > 0) {
        const fu = Math.min(u, 1 - u, v, 1 - v);
        if (fu < frame) {
          const fk = 0.62 + 0.25 * n.fbm(u, v, 8, 2);
          const bevel = clamp01(fu / frame);
          r = col[0] * fk * 0.85; g = col[1] * fk * 0.8; b = col[2] * fk * 0.75;
          h = 1.2 + bevel * 0.2;
          if (fu < frame * 0.12 || Math.abs(fu - frame) < frame * 0.1) { r *= 0.6; g *= 0.6; b *= 0.6; h = 0.9; }
        }
      }
      put(img, i, r, g, b, h + grainLines * 0.05);
    }
  }
  return img;
}

export function brick(size = 512, seed = 6, { frame = 0, base = 0xb5553a, rows = 10 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = hex(base);
  const mortar = hex(0xcfc6b8);
  const bh = size / rows, bw = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const row = Math.floor(y / bh);
      const off = row % 2 ? bw / 2 : 0;
      const bx = (x + off) % size;
      const col_i = Math.floor(bx / bw);
      const id = row * 8 + col_i;
      const lx = bx - col_i * bw, ly = y - row * bh;
      const ex = Math.min(lx, bw - lx), ey = Math.min(ly, bh - ly);
      const e = Math.min(ex, ey);
      const mw = 3.2;
      const fine = n.fbm(u, v, 32, 3);
      let r, g, b, h;
      if (e < mw) {
        const k = 0.85 + fine * 0.2;
        r = mortar[0] * k; g = mortar[1] * k; b = mortar[2] * k;
        h = 0.1 + fine * 0.1;
      } else {
        const t = hash(id + seed * 13);
        const k = (0.72 + t * 0.4) * (0.85 + fine * 0.3);
        r = col[0] * k * (1 + (hash(id + 3) - 0.5) * 0.15);
        g = col[1] * k;
        b = col[2] * k * (1 + (hash(id + 5) - 0.5) * 0.2);
        const bevel = clamp01((e - mw) / 4);
        h = 0.55 + bevel * 0.4 + fine * 0.12;
        const soot = n.fbm(u, v, 4, 3);
        if (soot > 0.6) { const s = (soot - 0.6) * 1.4; r *= 1 - s; g *= 1 - s; b *= 1 - s; }
      }
      if (frame > 0) {
        const fu = Math.min(u, 1 - u, v, 1 - v);
        if (fu < frame) {
          const k = 0.55 + 0.25 * n.fbm(u, v, 12, 3);
          r = 0.62 * k; g = 0.6 * k; b = 0.58 * k;
          h = 1.1 + clamp01(fu / frame) * 0.2;
          if (fu < frame * 0.1) { r *= 0.6; g *= 0.6; b *= 0.6; }
        }
      }
      put(img, i, r, g, b, h);
    }
  }
  return img;
}

export function metal(size = 512, seed = 7, { frame = 0, base = 0x8d9aa6, ribs = 16 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 1, 7);
  const col = hex(base);
  const rust = hex(0x9a5a2c);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const rib = Math.sin(u * ribs * Math.PI * 2) * 0.5 + 0.5;
      const panel = Math.floor(v * 2);
      const pv = v * 2 - panel;
      const seam = Math.min(pv, 1 - pv);
      const scratch = n.sample(u, v, 256, 8);
      const grime = n.fbm(u, v, 4, 4);
      let k = 0.78 + rib * 0.18 + (scratch - 0.5) * 0.12;
      let h = rib * 0.6;
      if (seam < 0.025) { k *= 0.55; h = 0; }
      // rivets along seams
      const rx = (u * ribs) % 1;
      const rd = Math.abs(rx - 0.5) * size / ribs;
      const ryd = Math.min(Math.abs(pv - 0.06), Math.abs(pv - 0.94)) * size / 2;
      if (rd * rd + ryd * ryd < 9) { k = 1.05; h = 1.1; }
      let r = col[0] * k, g = col[1] * k, b = col[2] * k;
      const cell = w.sample(u, v);
      const rs = smooth(clamp01((grime - 0.58) * 4)) * (0.6 + hash(cell.id) * 0.4);
      r = mix(r, rust[0], rs * 0.75); g = mix(g, rust[1], rs * 0.75); b = mix(b, rust[2], rs * 0.75);
      if (frame > 0) {
        const fu = Math.min(u, 1 - u, v, 1 - v);
        if (fu < frame) {
          const kk = 0.5 + 0.15 * n.fbm(u, v, 10, 2);
          r = 0.36 * kk * 1.4; g = 0.4 * kk * 1.4; b = 0.46 * kk * 1.4;
          h = 1.2;
          const bolt = (Math.floor((u + v) * 12) % 2 === 0) && fu > frame * 0.35 && fu < frame * 0.65;
          if (bolt && ((u * 12) % 1 < 0.2 || (v * 12) % 1 < 0.2)) { r *= 1.6; g *= 1.6; b *= 1.6; h = 1.5; }
        }
      }
      put(img, i, r, g, b, h);
    }
  }
  return img;
}

/** Lap siding (painted boards) — neutral so materials can tint it. */
export function siding(size = 512, seed = 8) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const rows = 12;
  const ph = size / rows;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const ry = (y % ph) / ph;
      const lap = ry; // thicker at bottom of each board
      const paint = 0.9 + n.fbm(u, v, 8, 3) * 0.1;
      const chip = n.fbm(u, v, 32, 2) > 0.86 ? 0.8 : 1;
      let k = paint * chip * (0.78 + lap * 0.22);
      if (ry > 0.94) k *= 0.55;
      put(img, i, 0.95 * k, 0.94 * k, 0.9 * k, lap);
    }
  }
  return img;
}

export function shingles(size = 512, seed = 9) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const rows = 10;
  const ph = size / rows, pw = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const row = Math.floor(y / ph);
      const ry = (y - row * ph) / ph;
      const off = (row % 2) * pw / 2;
      const sx = (x + off) % size;
      const si = Math.floor(sx / pw);
      const lx = sx - si * pw;
      const id = row * 16 + si;
      const t = 0.8 + hash(id + seed) * 0.35;
      let k = t * (0.7 + ry * 0.35) * (0.9 + n.sample(u, v, 128) * 0.2);
      let h = ry;
      if (lx < 2 || ry < 0.05) { k *= 0.5; h = 0; }
      put(img, i, 0.92 * k, 0.88 * k, 0.86 * k, h);
    }
  }
  return img;
}

export function concrete(size = 512, seed = 10, { base = 0xb9b6ae } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = hex(base);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 6, 5);
      const pores = n.sample(u, v, 256);
      const stain = smooth(clamp01((n.fbm(u, v, 3, 3) - 0.55) * 3));
      let k = (0.82 + f * 0.25) * (pores < 0.12 ? 0.7 : 1) * (1 - stain * 0.25);
      const seam = Math.min(u % 0.5, 0.5 - (u % 0.5), v % 0.5, 0.5 - (v % 0.5));
      let h = f * 0.5 + (pores < 0.12 ? -0.2 : 0);
      if (seam < 0.004) { k *= 0.6; h = -0.3; }
      put(img, i, col[0] * k, col[1] * k, col[2] * k, h);
    }
  }
  return img;
}

export function bark(size = 256, seed = 11) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const c1 = hex(0x6b4a2e), c2 = hex(0x3f2a19);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const s = n.fbm(u, v, 24, 3, 0.5, 4);
      const ridges = Math.abs(Math.sin((u * 10 + s * 2) * Math.PI));
      const t = smooth(ridges);
      const k = 0.85 + n.sample(u, v, 64) * 0.3;
      put(img, i, mix(c2[0], c1[0], t) * k, mix(c2[1], c1[1], t) * k, mix(c2[2], c1[2], t) * k, t);
    }
  }
  return img;
}

export function foliage(size = 256, seed = 12) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed, 14);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const c = w.sample(u, v);
      const leaf = smooth(clamp01(1 - c.f1 * 1.6));
      const t = hash(c.id);
      const k = (0.65 + leaf * 0.45) * (0.85 + t * 0.3) * (0.92 + n.sample(u, v, 64) * 0.16);
      put(img, i, k, k, k, leaf * 0.8 + t * 0.2);
    }
  }
  return img;
}

// ------------------------------------------------------------------ misc
export function noiseTile(size = 256, seed = 13, P = 4, oct = 5) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const f = n.fbm(x / size, y / size, P, oct);
      const g = n.fbm(x / size + 0.31, y / size + 0.77, P * 2, oct);
      put(img, i, f, g, f * 0.5 + g * 0.5, f);
    }
  }
  return img;
}

export const GENERATORS = {
  grass, sand, rock, dirt, planks, brick, metal, siding, shingles, concrete, bark, foliage, noiseTile,
};
