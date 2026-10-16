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
    this.lat = [];   // lattice per period (sparse array: periods are small integers)
  }
  lattice(P) {
    let a = this.lat[P];
    if (!a) {
      const r = mulberry32(this.seed * 131 + P * 7919);
      a = new Float32Array(P * P);
      for (let i = 0; i < a.length; i++) a[i] = r();
      this.lat[P] = a;
    }
    return a;
  }
  sample(u, v, Px, Py = Px) {
    const P = Px > Py ? Px : Py;
    const a = this.lat[P] || this.lattice(P);
    const x = u * Px, y = v * Py;
    let xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    xi %= Px; if (xi < 0) xi += Px;
    yi %= Py; if (yi < 0) yi += Py;
    const x1 = xi + 1 === Px ? 0 : xi + 1, y1 = yi + 1 === Py ? 0 : yi + 1;
    const a00 = a[yi * P + xi], a10 = a[yi * P + x1], a01 = a[y1 * P + xi], a11 = a[y1 * P + x1];
    const b0 = a00 + (a10 - a00) * fx, b1 = a01 + (a11 - a01) * fx;
    return b0 + (b1 - b0) * fy;
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
  const c1 = hex(0x3f9440), c2 = hex(0x5cb04e), c3 = hex(0x2a6c34), dry = hex(0x8fb24e);
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

// ------------------------------------------------------------------ biome surfaces
// All tileable; colours are final albedo (no tinting needed). Every generator: (size, seed, opts).

const rgb = (h) => hex(h);
function shade3(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
function mix3(a, b, t) { return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; }

export function snow(size = 512, seed = 41) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const base = rgb(0xf4f8fd), blue = rgb(0xb4c8e2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 4, 3);
      const drift = n.sample(u + f * 0.3, v * 0.5, 6, 3);
      const t = smooth(clamp01((f - 0.4) * 2.6)) * 0.7 + drift * 0.2;
      const c = mix3(base, blue, t);
      const sp = hash(i * 7 + seed) > 0.992 ? 1.08 : 1;
      put(img, i, c[0] * sp, c[1] * sp, c[2] * sp, f * 0.6 + drift * 0.3);
    }
  }
  return img;
}

export function ice(size = 512, seed = 42) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 5, 5);
  const deep = rgb(0x7fb8d8), light = rgb(0xd6f0fb);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const c = w.sample(u, v);
      const crack = 1 - smooth(clamp01((c.f2 - c.f1) * 18));
      const f = n.fbm(u, v, 3, 3);
      const streak = smooth(clamp01((n.sample(u + v * 0.6, v, 2, 16) - 0.6) * 4));
      let col = mix3(deep, light, 0.35 + f * 0.5 + hash(c.id) * 0.15);
      col = mix3(col, [1, 1, 1], streak * 0.35);
      col = shade3(col, 1 - crack * 0.35);
      put(img, i, col[0], col[1], col[2], 0.6 - crack * 0.5 + f * 0.1);
    }
  }
  return img;
}

/** Sand with wind ripples (desert sand, red sand); base / dark colours. */
export function dunes(size = 512, seed = 43, { base = 0xd9824e, dark = 0xb4633a, ripples = 14 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const b = rgb(base), d = rgb(dark);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const warp = n.fbm(u, v, 3, 2) * 2.5;
      const rip = Math.sin((v * ripples + u * 2 + warp) * Math.PI * 2) * 0.5 + 0.5;
      const patch = n.fbm(u, v, 5, 2);
      const grain = hash(i + seed * 977);
      const c = mix3(b, d, clamp01(patch * 0.7 + rip * 0.25));
      const k = 0.9 + grain * 0.16;
      put(img, i, c[0] * k, c[1] * k, c[2] * k, rip * 0.5 + grain * 0.25);
    }
  }
  return img;
}

export function strata(size = 512, seed = 44) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const bands = [rgb(0xe8c89a), rgb(0xd98a52), rgb(0xb4583a), rgb(0xcf7a48), rgb(0x8a4a32), rgb(0xe0a46a), rgb(0xc0603e), rgb(0xa8583c)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const warp = n.fbm(u, v, 3, 2) * 0.6;
      const bv = (v * 8 + warp + 8) % 8;
      const bi = Math.floor(bv), bt = bv - bi;
      const c0 = bands[bi % 8], c1 = bands[(bi + 1) % 8];
      let c = mix3(c0, c1, smooth(clamp01((bt - 0.82) * 6)));
      const grain = n.sample(u, v, 128, 32);
      const crack = n.sample(u, v, 24, 3) > 0.86 && n.sample(u, v, 64, 16) > 0.5 ? 0.78 : 1;
      const lip = bt < 0.06 ? 0.75 : 1;
      c = shade3(c, (0.85 + grain * 0.25) * crack * lip);
      put(img, i, c[0], c[1], c[2], grain * 0.4 + (1 - bt) * 0.4 + (crack < 1 ? -0.3 : 0));
    }
  }
  return img;
}

export function mud(size = 512, seed = 45) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const c1 = rgb(0x5e4a34), c2 = rgb(0x3e3022), wet = rgb(0x2e2a22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 4, 4);
      const puddle = smooth(clamp01((n.fbm(u + 0.4, v, 3, 2) - 0.58) * 6));
      let c = mix3(c1, c2, f);
      const k = 0.85 + n.sample(u, v, 96) * 0.25;
      c = mix3(shade3(c, k), wet, puddle * 0.8);
      put(img, i, c[0], c[1], c[2], f * 0.5 * (1 - puddle) + 0.1);
    }
  }
  return img;
}

export function junglefloor(size = 512, seed = 46) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 3, 22);
  const moss = rgb(0x2e5a24), dark = rgb(0x1f3a18), litter = [rgb(0x5a6a2a), rgb(0x6a4a2a), rgb(0x3f6a2a), rgb(0x7a5a2a)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const c = w.sample(u, v);
      const leaf = smooth(clamp01((0.42 - c.f1) * 5));
      const f = n.fbm(u, v, 6, 3);
      let col = mix3(dark, moss, f);
      const lc = litter[Math.floor(hash(c.id + 11) * 4)];
      col = mix3(col, lc, leaf * (hash(c.id) > 0.35 ? 0.85 : 0));
      const k = 0.85 + n.sample(u, v, 128) * 0.25;
      put(img, i, col[0] * k, col[1] * k, col[2] * k, leaf * 0.6 + f * 0.3);
    }
  }
  return img;
}

export function ash(size = 512, seed = 47) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 1, 9);
  const c1 = rgb(0x3e3a38), c2 = rgb(0x24211f), fleck = rgb(0x8a8480);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 5, 4);
      const c = w.sample(u, v);
      const crack = 1 - smooth(clamp01((c.f2 - c.f1) * 14));
      let col = mix3(c1, c2, f);
      if (hash(i * 3 + seed) > 0.985) col = mix3(col, fleck, 0.6);
      col = shade3(col, 1 - crack * 0.4);
      put(img, i, col[0], col[1], col[2], f * 0.4 + (1 - crack) * 0.4);
    }
  }
  return img;
}

/** Lava: black crust plates with glowing cracks. img.emissive (Uint8, 0..255) marks the glow. */
export function lava(size = 512, seed = 48) {
  const img = makeImg(size);
  img.emissive = new Uint8Array(size * size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 7, 7);
  const crust = rgb(0x2a1e1a), hot = rgb(0xff7a1a), white = rgb(0xffe08a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const c = w.sample(u, v);
      const e = c.f2 - c.f1;
      const glow = 1 - smooth(clamp01(e * 7 + n.sample(u, v, 16) * 0.35 - 0.05));
      const f = n.fbm(u, v, 6, 3);
      let col = shade3(crust, 0.8 + f * 0.5);
      col = mix3(col, mix3(hot, white, smooth(clamp01((glow - 0.6) * 2.5))), glow);
      put(img, i, col[0], col[1], col[2], (1 - glow) * 0.8 + f * 0.2);
      img.emissive[i] = clamp01(glow * 1.1) * 255;
    }
  }
  return img;
}

/** Asphalt; lines: a dashed yellow centre line along v (at u = 0.5) and white edge lines (road ribbons). */
export function asphalt(size = 512, seed = 49, { lines = true } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const base = rgb(0x4a4d52), dark = rgb(0x2f3236), yellow = rgb(0xf2c53d), white = rgb(0xeeeeea);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 6, 3);
      const grain = hash(i + seed * 31);
      const crack = n.sample(u, v, 20, 6) > 0.86 ? 0.7 : 1;
      let c = shade3(mix3(base, dark, f * 0.6), (0.88 + grain * 0.18) * crack);
      let h = grain * 0.3 + f * 0.2;
      if (lines) {
        const wear = 0.75 + n.sample(u, v, 64) * 0.25;
        if (Math.abs(u - 0.5) < 0.012 && (v * 4) % 1 < 0.55) { c = mix3(c, yellow, wear); h += 0.1; }
        if (Math.abs(u - 0.06) < 0.008 || Math.abs(u - 0.94) < 0.008) { c = mix3(c, white, wear * 0.9); h += 0.1; }
      }
      put(img, i, c[0], c[1], c[2], h);
    }
  }
  return img;
}

export function cobble(size = 512, seed = 50) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const w = new Worley(seed + 2, 12);
  const c1 = rgb(0x9a948a), c2 = rgb(0x7a7268), gap = rgb(0x4a4640);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const c = w.sample(u, v);
      const e = c.f2 - c.f1;
      const stone = smooth(clamp01(e * 9));
      const dome = clamp01(1 - c.f1 * 1.7);
      let col = mix3(c1, c2, hash(c.id) * 0.8 + n.sample(u, v, 64) * 0.2);
      col = shade3(col, 0.8 + dome * 0.3);
      col = mix3(gap, col, stone);
      put(img, i, col[0], col[1], col[2], stone * (0.5 + dome * 0.5));
    }
  }
  return img;
}

export function field(size = 512, seed = 51) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const c1 = rgb(0x8a6040), c2 = rgb(0x5e3f28), sprout = rgb(0x6a8a3a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const w = n.sample(u, v, 4, 2) * 0.05;
      const row = Math.sin((u + w) * 16 * Math.PI * 2) * 0.5 + 0.5;
      const f = n.fbm(u, v, 8, 3);
      let c = mix3(c2, c1, row * 0.7 + f * 0.3);
      if (row > 0.85 && n.sample(u, v, 32, 128) > 0.62) c = mix3(c, sprout, 0.7);
      const k = 0.88 + hash(i + seed) * 0.16;
      put(img, i, c[0] * k, c[1] * k, c[2] * k, row * 0.7 + f * 0.2);
    }
  }
  return img;
}

export function wheat(size = 512, seed = 52) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const gold = rgb(0xe8c25a), deep = rgb(0xb8902e), pale = rgb(0xf4dc8a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const stalk = n.sample(u, v, 128, 8);
      const tuft = n.fbm(u, v, 6, 3);
      let c = mix3(deep, gold, stalk);
      c = mix3(c, pale, smooth(clamp01((tuft - 0.6) * 4)) * 0.5);
      const gapK = n.sample(u, v, 256, 16) < 0.25 ? 0.7 : 1;
      put(img, i, c[0] * gapK, c[1] * gapK, c[2] * gapK, stalk * 0.6 + tuft * 0.3);
    }
  }
  return img;
}

// ------------------------------------------------------------------ building looks
export function glass(size = 512, seed = 61) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const top = rgb(0xa8d4ee), bottom = rgb(0x4f7fa8), frame = rgb(0x39424c);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const pu = (u * 2) % 1, pv = (v * 2) % 1;
      const edge = Math.min(pu, 1 - pu, pv, 1 - pv);
      let c = mix3(bottom, top, 1 - pv);
      const refl = smooth(clamp01(1 - Math.abs(((pu - pv * 0.6 + 2) % 1) - 0.35) * 9)) * 0.35;
      c = mix3(c, [1, 1, 1], refl + n.sample(u, v, 8) * 0.06);
      let h = 0.2;
      if (edge < 0.025) { c = frame; h = 1; }
      put(img, i, c[0], c[1], c[2], h);
    }
  }
  return img;
}

export function plaster(size = 512, seed = 62, { base = 0xeadfc8, bricks = 0 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = rgb(base), brick = shade3(col, 0.72);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const f = n.fbm(u, v, 6, 4);
      const pores = hash(i * 13 + seed) > 0.97 ? 0.9 : 1;
      let c = shade3(col, (0.88 + f * 0.18) * pores);
      let h = f * 0.3;
      if (bricks) {
        // patches where the plaster has fallen off and bricks show through
        const patch = smooth(clamp01((n.fbm(u + 0.3, v, 3, 3) - (1 - bricks * 0.75)) * 8));
        if (patch > 0) {
          const row = Math.floor(v * 16), off = row % 2 ? 0.0625 : 0;
          const bu = ((u + off) * 8) % 1, bv = (v * 16) % 1;
          const mortar = bu < 0.07 || bv < 0.12;
          c = mix3(c, mortar ? shade3(col, 0.9) : shade3(brick, 0.9 + hash(row * 64 + Math.floor((u + off) * 8)) * 0.2), patch);
          h = mix(h, mortar ? 0 : 0.6, patch);
        }
      }
      put(img, i, c[0], c[1], c[2], h);
    }
  }
  return img;
}

export function logs(size = 512, seed = 64, { base = 0x9a6a3e, rows = 6 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = rgb(base), gap = rgb(0x3a2a1a);
  const ph = size / rows;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const row = Math.floor(y / ph), ry = (y - row * ph) / ph;
      const round = Math.sqrt(clamp01(1 - (ry * 2 - 1) * (ry * 2 - 1)));
      const grain = 0.85 + 0.15 * Math.sin((ry * 6 + n.fbm(u, v, 3, 3, 0.5, 24) * 4 + hash(row) * 7) * Math.PI);
      const tint = 0.85 + hash(row * 7 + seed) * 0.25;
      let c = shade3(col, (0.45 + round * 0.6) * grain * tint);
      if (round < 0.25) c = mix3(gap, c, round * 4);
      put(img, i, c[0], c[1], c[2], round);
    }
  }
  return img;
}

export function rooftile(size = 512, seed = 67, { base = 0xc0603a } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = rgb(base);
  const rows = 8, cols = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const row = Math.floor(v * rows), rv = v * rows - row;
      const cu = (u * cols + (row % 2) * 0.5) % 1;
      const barrel = Math.sin(cu * Math.PI);
      const tint = 0.85 + hash(row * 31 + Math.floor(u * cols + (row % 2) * 0.5)) * 0.25;
      let k = (0.55 + barrel * 0.5) * tint * (0.75 + rv * 0.3);
      if (rv > 0.93) k *= 0.55;
      k *= 0.92 + n.sample(u, v, 64) * 0.16;
      put(img, i, col[0] * k, col[1] * k, col[2] * k, barrel * 0.8 + rv * 0.2);
    }
  }
  return img;
}

/** Large stone blocks (sandstone, castle, ice blocks): rows of blocks with irregular widths. */
export function blocks(size = 512, seed = 69, { base = 0xd8b680, rows = 4, cols = 3, mortar = 0.025, moss = 0, lines = 0 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = rgb(base), mossC = rgb(0x5d7a3a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const row = Math.floor(v * rows), rv = v * rows - row;
      const off = hash(row * 13 + seed) * 0.6;
      const bu = (u * cols + off) % cols;
      const bi = Math.floor(bu), lu = bu - bi;
      const id = row * 16 + bi;
      const e = Math.min(lu / cols * rows, (1 - lu) / cols * rows, rv, 1 - rv) / rows;
      const f = n.fbm(u, v, 8, 4);
      let c = shade3(col, (0.74 + hash(id + seed) * 0.36) * (0.84 + f * 0.26));
      if (lines) c = shade3(c, 0.94 + 0.06 * Math.sin((v * rows * 6 + f) * Math.PI * 2));
      let h = 0.7 + f * 0.2;
      const bevel = clamp01(e / mortar);
      if (e < mortar) { c = shade3(col, 0.55); h = 0.1; } else h *= 0.6 + 0.4 * clamp01(bevel - 1);
      if (moss) { const m = smooth(clamp01((n.fbm(u, v, 4, 3) - (1 - moss)) * 5)) * (1 - v); c = mix3(c, mossC, m * 0.7); }
      put(img, i, c[0], c[1], c[2], h);
    }
  }
  return img;
}

export function panel(size = 512, seed = 70, { base = 0xc9ced4 } = {}) {
  const img = makeImg(size);
  const n = new ValueNoise(seed);
  const col = rgb(base);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const pu = (u * 2) % 1, pv = (v * 2) % 1;
      const seam = Math.min(pu, 1 - pu, pv, 1 - pv);
      const f = n.fbm(u, v, 6, 4);
      const pid = Math.floor(u * 2) + Math.floor(v * 2) * 2;
      let k = (0.86 + hash(pid + seed) * 0.12) * (0.92 + f * 0.12);
      let h = 0.6 + f * 0.1;
      if (seam < 0.012) { k *= 0.55; h = 0; }
      // a bolt near each panel corner
      const bx = Math.min(Math.abs(pu - 0.08), Math.abs(pu - 0.92)), by = Math.min(Math.abs(pv - 0.08), Math.abs(pv - 0.92));
      if (bx * bx + by * by < 0.0004) { k *= 1.15; h = 1; }
      // rain streaks
      k *= 1 - smooth(clamp01((n.sample(u, v, 32, 2) - 0.7) * 3)) * 0.12;
      put(img, i, col[0] * k, col[1] * k, col[2] * k, h);
    }
  }
  return img;
}

export const GENERATORS = {
  grass, sand, rock, dirt, planks, brick, metal, siding, shingles, concrete, bark, foliage, noiseTile,
  snow, ice, dunes, strata, mud, junglefloor, ash, lava, asphalt, cobble, field, wheat,
  glass, plaster, logs, rooftile, blocks, panel,
};

// ------------------------------------------------------------------ layers by name
// One texture for every ground surface and building look (SURFACES and LOOKS in
// shared/world/keys.js), e.g. for the renderer's texture arrays. dirt, sand, rock and today's
// looks (siding, brick, metalwall, roof, floor, trim, foundation, concrete) are today's textures;
// grass is today's with deeper, slightly bluer greens. Unknown keys get concrete.
// The lava layer carries emissive (Uint8, the glow mask); 'asphalt' has lane lines (u across the
// road: a dashed centre line at u = 0.5, edge lines near 0 and 1); 'asphaltPlain' has none.
const LAYERS = {
  // surfaces
  grass: (s) => grass(s, 1),
  dirt: (s) => dirt(s, 4),
  sand: (s) => sand(s, 2),
  rock: (s) => rock(s, 3),
  snow: (s) => snow(s, 41),
  ice: (s) => ice(s, 42),
  redsand: (s) => dunes(s, 43),
  strata: (s) => strata(s, 44),
  mud: (s) => mud(s, 45),
  junglefloor: (s) => junglefloor(s, 46),
  ash: (s) => ash(s, 47),
  lava: (s) => lava(s, 48),
  asphalt: (s) => asphalt(s, 49),
  asphaltPlain: (s) => asphalt(s, 49, { lines: false }),
  cobble: (s) => cobble(s, 50),
  field: (s) => field(s, 51),
  wheat: (s) => wheat(s, 52),
  // looks
  siding: (s) => siding(s, 8),
  brick: (s) => brick(s, 6),
  metalwall: (s) => metal(s, 7),
  roof: (s) => shingles(s, 9),
  floor: (s) => planks(s, 5),
  trim: (s) => concrete(s, 10),
  foundation: (s) => concrete(s, 10),
  glass: (s) => glass(s, 61),
  stucco: (s) => plaster(s, 62),
  adobe: (s) => plaster(s, 63, { base: 0xc98f5e, bricks: 0.5 }),
  logs: (s) => logs(s, 64),
  planks: (s) => planks(s, 65, { base: 0xb98a58, rows: 8, vertical: true }),
  corrugated: (s) => metal(s, 66, { ribs: 32, base: 0x9aa4ae }),
  rooftile: (s) => rooftile(s, 67),
  shingle: (s) => shingles(s, 68),
  sandstone: (s) => blocks(s, 69, { base: 0xd8b680, rows: 4, cols: 2, lines: 1 }),
  concrete: (s) => concrete(s, 10),
  panel: (s) => panel(s, 70),
  castle: (s) => blocks(s, 72, { base: 0x9e9a92, rows: 5, cols: 3, mortar: 0.03, moss: 0.18 }),
};

/** SURFACES / LOOKS keys that have a generator of their own (the rest fall back to concrete). */
export const LAYER_KEYS = Object.keys(LAYERS);

/**
 * The texture image ({ size, color, height, emissive? }, like every generator) for a SURFACES or
 * LOOKS key. size: pixels at normal quality; low (the Low preset) halves it (512 -> 256).
 */
export function layerTexture(key, size = 512, low = false) {
  const S = low ? size >> 1 : size;
  const make = Object.prototype.hasOwnProperty.call(LAYERS, key) ? LAYERS[key] : LAYERS.concrete;
  return make(S);
}
