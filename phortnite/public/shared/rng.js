// Deterministic random + noise. Only uses +, -, *, /, floor and sqrt so results are
// bit-identical between browsers and Node (no Math.sin/exp/pow in decision paths).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable value in [0, 1) for an integer cell (ix, iz) and a salt: per-cell randomness that does
 * not depend on the order things are generated in. */
export function hash2(ix, iz, salt = 0) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// gradient table as (x, y) pairs: the same 12 gradients as before, flattened for speed
const GRAD = new Float64Array([
  1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1,
  0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071,
]);

/** Classic 2D gradient (Perlin) noise with a seeded permutation table. Range ~[-1, 1]. */
export class Perlin {
  constructor(seed) {
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    // the gradient (times 2) behind every lattice hash, so noise() skips a % 12 per corner
    this.g = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.g[i] = (this.perm[i] % 12) * 2;
  }

  noise(x, y) {
    const xf = Math.floor(x), yf = Math.floor(y);
    const X = xf & 255, Y = yf & 255;
    x -= xf; y -= yf;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const P = this.perm, Gi = this.g;
    const a = P[X] + Y, b = P[X + 1] + Y;
    const i00 = Gi[a], i10 = Gi[b], i01 = Gi[a + 1], i11 = Gi[b + 1];
    const n00 = GRAD[i00] * x + GRAD[i00 + 1] * y;
    const n10 = GRAD[i10] * (x - 1) + GRAD[i10 + 1] * y;
    const n01 = GRAD[i01] * x + GRAD[i01 + 1] * (y - 1);
    const n11 = GRAD[i11] * (x - 1) + GRAD[i11 + 1] * (y - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4142;
  }

  fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * freq + i * 17.13, y * freq - i * 9.71);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  ridged(x, y, octaves = 4) {
    let amp = 0.5, freq = 1, sum = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq + i * 3.1, y * freq + i * 7.7));
      sum += n * n * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  }
}
