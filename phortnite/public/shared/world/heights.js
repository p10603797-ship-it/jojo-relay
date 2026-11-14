// Terrain heights: one height function per biome, blended by the biome field, plus the snow
// massif and the volcano cone, then a warped coastline. Features are stamped afterwards, each
// over its own bounding box only (lake, river, place pads, roads, building pads).
//
// Deterministic: only + - * / floor sqrt and rng.js noise.
import { smoothstep, lerp, clamp } from '../rng.js';
import { BI } from './biomes.js';

/** Per biome base height (pure: no captured state, so the hot loop stays allocation free). */
function biomeHeight(b, hills, detail, dunes, mesaN, swampN, inl) {
  switch (b) {
    case BI.city: return 6.6 + hills * 2.4 + detail * 0.15;
    case BI.meadow: return 4.2 + hills * hills * 30 + detail * 0.8;
    case BI.forest: return 6 + hills * 30 + detail;
    case BI.farm: return 3.8 + hills * 7.5 + detail * 0.35;
    case BI.jungle: return 2.4 + hills * 13 + detail * 0.9;
    case BI.swamp: return 1.0 + hills * 3.2 + swampN * 2.2;
    case BI.desert: return 5 + dunes * 7 + smoothstep(0.2, 0.245, mesaN) * 28 * inl;
    case BI.mesa: return 7 + dunes * 2.5 + (smoothstep(0.02, 0.06, mesaN) * 18 + smoothstep(0.17, 0.2, mesaN) * 20) * inl;
    case BI.snow: return 12 + hills * 22 + detail;
    case BI.volcano: return 5 + hills * 9 + detail * 0.6;
    default: return 3 + hills * 6;
  }
}

/**
 * A slowly varying noise field sampled every `step` grid points and bilinearly interpolated
 * (warps and coastlines need no 4 m detail). fn(x, z) -> value. Returns Float32Array(N * N).
 */
export function coarseField(G, step, fn) {
  const { N, cell, half } = G;
  const M = Math.ceil((N - 1) / step) + 1;
  const c = new Float64Array(M * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) c[j * M + i] = fn(-half + i * step * cell, -half + j * step * cell);
  const out = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    const fj = iz / step, j = Math.min(Math.floor(fj), M - 2), v = fj - j;
    for (let ix = 0; ix < N; ix++) {
      const fi = ix / step, i = Math.min(Math.floor(fi), M - 2), u = fi - i;
      const a = c[j * M + i], b = c[j * M + i + 1], d = c[(j + 1) * M + i], e = c[(j + 1) * M + i + 1];
      out[iz * N + ix] = (a + (b - a) * u) + ((d + (e - d) * u) - (a + (b - a) * u)) * v;
    }
  }
  return out;
}

/** Base heights for every grid point -> G.heights, G.land (coast factor 0..1). */
export function baseHeights(G, L) {
  const { N, cell, half, k } = G;
  const n2 = G.n2;
  const fk = 1 / k;
  // the coastline wobble varies slowly: sample it every 4 grid points (16 m)
  const warpF = coarseField(G, 4, (x, z) => n2.fbm(x * 0.0022 * fk, z * 0.0022 * fk, 3) + n2.noise(x * 0.011, z * 0.011) * 0.12);
  const C = {
    G, L, fk, heights: new Float32Array(N * N), land: new Float32Array(N * N), warpF,
    pr2: L.peak.r * L.peak.r, DES: BI.desert, MES: BI.mesa, SWA: BI.swamp,
  };
  for (let iz = 0; iz < N; iz++) {
    const z = -half + iz * cell;
    for (let ix = 0; ix < N; ix++) pointHeight(C, -half + ix * cell, z, iz * N + ix);
  }
  G.heights = C.heights;
  G.land = C.land;
  G.inland = new Uint8Array(N * N);
}

/** The base height of one grid point (a small function so it is optimised and allocation free). */
function pointHeight(C, x, z, i) {
  const { G, L } = C;
  const noise = G.n1, n2 = G.n2;
  const dist = Math.sqrt(x * x + z * z) / (G.R * (1 + 0.2 * C.warpF[i]));
  const c = smoothstep(1.06, 0.8, dist);
  C.land[i] = c;
  if (c <= 0) { C.heights[i] = -14; return; }
  const hills = noise.fbm(x * 0.006, z * 0.006, 4) * 0.5 + 0.5;
  const detail = n2.noise(x * 0.035, z * 0.035);
  const b1 = G.biome[i], b2 = G.biome2[i];
  let dunes = 0, mesaN = 0, swampN = 0;
  if (b1 === C.DES || b1 === C.MES || b2 === C.DES || b2 === C.MES) {
    dunes = n2.ridged(x * 0.011, z * 0.019, 2);
    mesaN = noise.fbm(x * 0.0075 * C.fk + 9, z * 0.0075 * C.fk - 4, 2);
  }
  if (b1 === C.SWA || b2 === C.SWA) swampN = n2.fbm(x * 0.02 + 31, z * 0.02 - 7, 2);
  const inl = smoothstep(0.82, 0.97, c); // no mesas sticking out into the sea
  const h1 = biomeHeight(b1, hills, detail, dunes, mesaN, swampN, inl);
  let h = b2 === b1 ? h1 : lerp(biomeHeight(b2, hills, detail, dunes, mesaN, swampN, inl), h1, G.bw[i]);
  // the snow massif (a ridged dome)
  const peak = L.peak;
  const dpx = x - peak.x, dpz = z - peak.z, pd2 = dpx * dpx + dpz * dpz;
  if (pd2 < C.pr2) {
    const kk = 1 - pd2 / C.pr2;
    h += kk * kk * peak.h + noise.ridged(x * 0.012, z * 0.012, 4) * 34 * kk;
  }
  // the volcano cone and its crater
  const v = L.volcano;
  const dvx = x - v.x, dvz = z - v.z;
  const vd = Math.sqrt(dvx * dvx + dvz * dvz);
  if (vd < v.r) h += volcanoProfile(v, vd);
  // beaches: the last stretch before the sea flattens out into sand
  if (c < 1 && h < 14) h = lerp(lerp(1.2, h, smoothstep(0.55, 1, c)), h, smoothstep(10, 14, h));
  C.heights[i] = -14 + (h + 14) * c;
}

/** Height the volcano adds at distance vd from its centre (cone, rim and the flat crater floor). */
export function volcanoProfile(v, vd) {
  const t = 1 - vd / v.r;
  let h = v.h * t * (0.35 + 0.65 * t);
  const cr = v.crater;
  if (vd < cr * 1.6) {
    // rim lip, then a bowl down to a flat floor (the lava pool)
    const u = vd / cr;
    if (u < 1) {
      const bowl = (1 - u * u);
      h -= v.depth * smoothstep(0, 1, bowl * 1.25);
    } else h += 3 * smoothstep(1.6, 1, u);
  }
  return h;
}

/** Height of the crater floor (where the lava pool sits). */
export function craterFloor(G, v) {
  return G.heightAt(v.x, v.z);
}

// ------------------------------------------------------------------ stamping helpers (bbox only)
/** Grid index range covering [x0, x1] x [z0, z1] (clamped), as [ix0, ix1, iz0, iz1]. */
export function bbox(G, x0, z0, x1, z1) {
  const { N, cell, half } = G;
  return [
    clamp(Math.floor((x0 + half) / cell), 0, N - 1), clamp(Math.ceil((x1 + half) / cell), 0, N - 1),
    clamp(Math.floor((z0 + half) / cell), 0, N - 1), clamp(Math.ceil((z1 + half) / cell), 0, N - 1),
  ];
}

/** Flatten a disc toward y: full strength inside r, fading out to r + edge. */
export function flattenDisc(G, cx, cz, r, edge, y, strength = 1) {
  const { N, cell, half, heights } = G;
  const R2 = r + edge;
  const [ix0, ix1, iz0, iz1] = bbox(G, cx - R2, cz - R2, cx + R2, cz + R2);
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = -half + iz * cell, dz = z - cz;
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * cell, dx = x - cx;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= R2) continue;
      const w = (d <= r ? 1 : smoothstep(R2, r, d)) * strength;
      const i = iz * N + ix;
      heights[i] = lerp(heights[i], y, w);
    }
  }
}

/** Flatten an axis-aligned rectangle (half sizes hx, hz) toward y, fading out over edge metres. */
export function flattenRect(G, cx, cz, hx, hz, edge, y, inner = 0) {
  const { N, cell, half, heights } = G;
  const [ix0, ix1, iz0, iz1] = bbox(G, cx - hx - edge, cz - hz - edge, cx + hx + edge, cz + hz + edge);
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = -half + iz * cell;
    const dz = Math.max(Math.abs(z - cz) - hz, 0);
    if (dz >= edge) continue;
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * cell;
      const dx = Math.max(Math.abs(x - cx) - hx, 0);
      if (dx >= edge) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= edge) continue;
      const w = d <= inner ? 1 : smoothstep(edge, inner, d);
      const i = iz * N + ix;
      heights[i] = lerp(heights[i], y, w);
    }
  }
}

/** Mean terrain height over a 5 x 5 sample grid spanning the disc. */
export function meanHeight(G, x, z, r) {
  let s = 0;
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) s += G.heightAt(x + a * r * 0.4, z + b * r * 0.4);
  return s / 25;
}

/** Min / max terrain height over a 5 x 5 sample grid spanning a rectangle. */
export function rangeRect(G, x, z, hx, hz) {
  let mn = Infinity, mx = -Infinity;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const h = G.heightAt(x + a * hx * 0.5, z + b * hz * 0.5);
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  return { min: mn, max: mx };
}

// ------------------------------------------------------------------ water: lake and river
/** Splashy Lake: a bowl down to lake.bed with a small island in the middle. */
export function stampLake(G, lake) {
  const { N, cell, half, heights, inland } = G;
  const R2 = lake.r * 1.7;
  const [ix0, ix1, iz0, iz1] = bbox(G, lake.x - R2, lake.z - R2, lake.x + R2, lake.z + R2);
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = -half + iz * cell;
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * cell;
      const dx = x - lake.x, dz = z - lake.z;
      const wob = G.n2.noise(x * 0.03, z * 0.03) * 5;
      const d = (Math.sqrt(dx * dx + dz * dz) + wob) / lake.r;
      if (d >= 1.7) continue;
      const i = iz * N + ix;
      let t;
      if (d < 0.75) t = lake.bed;
      else if (d < 1) t = lerp(lake.bed, -0.6, (d - 0.75) * 4);
      else t = lerp(-0.6, Math.max(heights[i], 2.2), smoothstep(1, 1.7, d));
      if (d < 1.25) inland[i] = 1;
      if (t < heights[i] || d < 1.15) heights[i] = t;
      // the island
      const di = Math.sqrt(dx * dx + dz * dz) / lake.island;
      if (di < 1.6) heights[i] = Math.max(heights[i], di < 1 ? 3.4 - di * 0.6 : lerp(2.8, lake.bed, (di - 1) / 0.6));
    }
  }
}

/** Precomputed segments of a polyline ([[x, z], ...]) for polyDist. */
export function polySegs(pts) {
  const segs = [];
  let total = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const ax = pts[s][0], az = pts[s][1], dx = pts[s + 1][0] - ax, dz = pts[s + 1][1] - az;
    const L2 = dx * dx + dz * dz, len = Math.sqrt(L2);
    segs.push({ ax, az, dx, dz, L2, len, acc: total });
    total += len;
  }
  segs.total = total;
  return segs;
}

/** Distance from (x, z) to a polyline (polySegs); out.t = the along-path fraction, out.s = segment. */
export function polyDist(segs, x, z, out) {
  let best = Infinity, bestT = 0, bestS = 0;
  for (let s = 0; s < segs.length; s++) {
    const g = segs[s];
    let t = ((x - g.ax) * g.dx + (z - g.az) * g.dz) / g.L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = g.ax + g.dx * t - x, ez = g.az + g.dz * t - z;
    const d = ex * ex + ez * ez;
    if (d < best) { best = d; bestT = (g.acc + t * g.len) / segs.total; bestS = s; }
  }
  if (out) { out.t = bestT; out.s = bestS; }
  return Math.sqrt(best);
}

/**
 * The river: carved down to river.bed (so the y = 0 water plane fills it), widening downstream,
 * with banks that slope back up to the terrain (wider banks where the terrain is high: a canyon).
 */
export function stampRiver(G, river) {
  const { N, cell, half, heights, inland } = G;
  const segs = polySegs(river.pts);
  const tmp = { t: 0, s: 0 };
  const maxBank = 34 + 0.6 * 80;
  for (let si = 0; si < segs.length; si++) {
    const g = segs[si];
    const pad = river.w1 / 2 + maxBank;
    const [ix0, ix1, iz0, iz1] = bbox(G, Math.min(g.ax, g.ax + g.dx) - pad, Math.min(g.az, g.az + g.dz) - pad,
      Math.max(g.ax, g.ax + g.dx) + pad, Math.max(g.az, g.az + g.dz) + pad);
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = -half + iz * cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -half + ix * cell;
        const d0 = polyDist(segs, x, z, tmp);
        // only the closest segment carves a point (so every point is carved once)
        if (tmp.s !== si) continue;
        const w = lerp(river.w0, river.w1, tmp.t) / 2;
        const i = iz * N + ix;
        const h0 = heights[i];
        const bank = 34 + 0.6 * clamp(h0, 0, 80);
        const d = d0 + G.n2.noise(x * 0.03, z * 0.03) * 3.5;
        if (d > w + bank) continue;
        let target;
        if (d < w) target = river.bed;
        else if (d < w + 6) target = lerp(river.bed, -0.4, (d - w) / 6);
        else target = lerp(-0.4, Math.max(h0, 1.5), smoothstep(w + 6, w + bank, d));
        if (target < h0) heights[i] = target;
        if (d < w + 10) inland[i] = 1;
      }
    }
  }
  return segs;
}
