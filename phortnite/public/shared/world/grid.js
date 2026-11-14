// Grid context and spatial indexes: the terrain grid (G), heightAt, the occupancy grid used while
// placing things, the solid-part hash behind solidNear, the 32 m object hash behind objectsNear
// and the 64 m chunk index (for collider streaming).
import { Perlin, clamp } from '../rng.js';

/** The terrain grid context every stage writes into. */
export function makeGrid(seed, size, res, R) {
  const cell = size / res, N = res + 1, half = size / 2;
  const G = {
    seed, size, res, cell, N, half, R, k: size / 1600,
    n1: new Perlin(seed), n2: new Perlin(seed + 101), n3: new Perlin(seed + 202), n4: new Perlin(seed + 303),
    heights: null, land: null, inland: null, biome: null, biome2: null, blend: null, bw: null,
    surface: null, occ: new Uint8Array(N * N), road: new Uint8Array(N * N),
  };
  /** Same triangulation as Rapier's heightfield (split along the u + v = 1 diagonal). */
  G.heightAt = (x, z) => {
    const heights = G.heights;
    const fx = (x + half) / cell, fz = (z + half) / cell;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0) ix = 0; else if (ix > res - 1) ix = res - 1;
    if (iz < 0) iz = 0; else if (iz > res - 1) iz = res - 1;
    const u = clamp(fx - ix, 0, 1), v = clamp(fz - iz, 0, 1);
    const i = iz * N + ix;
    const h00 = heights[i], h10 = heights[i + 1], h01 = heights[i + N], h11 = heights[i + N + 1];
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };
  /** Nearest grid point index of (x, z). */
  G.at = (x, z) => {
    const ix = clamp(Math.round((x + half) / cell), 0, N - 1), iz = clamp(Math.round((z + half) / cell), 0, N - 1);
    return iz * N + ix;
  };
  /** Steepness at (x, z): summed height change over 4 m in x and z (0 = flat). */
  G.slope = (x, z) => Math.abs(G.heightAt(x + 2, z) - G.heightAt(x - 2, z)) + Math.abs(G.heightAt(x, z + 2) - G.heightAt(x, z - 2));
  return G;
}

// ------------------------------------------------------------------ occupancy (placement only)
export const OCC = { FREE: 0, ROAD: 1, BUILDING: 2, YARD: 3, WATER: 4, FIELD: 5, PLAZA: 6, KEEP: 7 };

/** Mark the grid points inside a rectangle in G.occ (soft: only free or yard points). */
export function markOcc(G, cx, cz, hx, hz, v, soft = false) {
  const { N, cell, half, occ } = G;
  const ix0 = clamp(Math.ceil((cx - hx + half) / cell), 0, N - 1), ix1 = clamp(Math.floor((cx + hx + half) / cell), 0, N - 1);
  const iz0 = clamp(Math.ceil((cz - hz + half) / cell), 0, N - 1), iz1 = clamp(Math.floor((cz + hz + half) / cell), 0, N - 1);
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
    const i = iz * N + ix;
    if (soft) { if (occ[i] === OCC.FREE || occ[i] === OCC.YARD) occ[i] = v; } else occ[i] = v;
  }
}

/** Is any grid point strictly inside the rectangle occupied by something in the mask (bits of OCC values)? */
export function occBlocked(G, cx, cz, hx, hz, mask) {
  const { N, cell, half, occ } = G;
  const ix0 = clamp(Math.ceil((cx - hx + half) / cell), 0, N - 1), ix1 = clamp(Math.floor((cx + hx + half) / cell), 0, N - 1);
  const iz0 = clamp(Math.ceil((cz - hz + half) / cell), 0, N - 1), iz1 = clamp(Math.floor((cz + hz + half) / cell), 0, N - 1);
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) if (mask & (1 << occ[iz * N + ix])) return occ[iz * N + ix] + 1;
  return 0;
}

/** A simple bucket hash of axis-aligned boxes {x0, z0, x1, z1} for overlap queries while placing. */
export class BoxHash {
  constructor(cell = 32) { this.cell = cell; this.map = new Map(); }
  key(gx, gz) { return (gx + 4096) * 8192 + (gz + 4096); }
  add(b) {
    const c = this.cell;
    for (let gx = Math.floor(b.x0 / c); gx <= Math.floor(b.x1 / c); gx++) {
      for (let gz = Math.floor(b.z0 / c); gz <= Math.floor(b.z1 / c); gz++) {
        const k = this.key(gx, gz);
        let l = this.map.get(k);
        if (!l) this.map.set(k, (l = []));
        l.push(b);
      }
    }
  }
  /** Does the box overlap any stored box (expanded by margin)? */
  hits(x0, z0, x1, z1, margin = 0) {
    const c = this.cell;
    for (let gx = Math.floor((x0 - margin) / c); gx <= Math.floor((x1 + margin) / c); gx++) {
      for (let gz = Math.floor((z0 - margin) / c); gz <= Math.floor((z1 + margin) / c); gz++) {
        const l = this.map.get(this.key(gx, gz));
        if (!l) continue;
        for (const b of l) if (x0 < b.x1 + margin && x1 > b.x0 - margin && z0 < b.z1 + margin && z1 > b.z0 - margin) return true;
      }
    }
    return false;
  }
}

// ------------------------------------------------------------------ the world's spatial queries
/** Axis-aligned bounds of an object for solidNear (null when it is not solid). */
export function solidBounds(o) {
  if (o.kind === 'part' || (o.kind === 'prop' && !o.walk)) {
    if (o.shape === 'prism') {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < o.pts.length; i += 3) {
        const px = o.pts[i], py = o.pts[i + 1], pz = o.pts[i + 2];
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
      }
      return { id: o.id, x0, y0, z0, x1, y1, z1 };
    }
    if (o.ax) {
      // a tilted slab (ramp, roof): its exact bounds (bb) when the builder gave them
      if (o.bb) return { id: o.id, x0: o.bb[0], y0: o.bb[1], z0: o.bb[2], x1: o.bb[3], y1: o.bb[4], z1: o.bb[5] };
      const r = Math.max(o.hx, o.hy, o.hz);
      return { id: o.id, x0: o.x - r, y0: o.y - r * 0.6, z0: o.z - r, x1: o.x + r, y1: o.y + r * 0.6, z1: o.z + r };
    }
    if (o.yaw) {
      const r = Math.sqrt(o.hx * o.hx + o.hz * o.hz);
      return { id: o.id, x0: o.x - r, y0: o.y - o.hy, z0: o.z - r, x1: o.x + r, y1: o.y + o.hy, z1: o.z + r };
    }
    return { id: o.id, x0: o.x - o.hx, y0: o.y - o.hy, z0: o.z - o.hz, x1: o.x + o.hx, y1: o.y + o.hy, z1: o.z + o.hz };
  }
  if (o.kind === 'rock') {
    const r = o.s * 1.1;
    return { id: o.id, x0: o.x - r, y0: o.y - r, z0: o.z - r, x1: o.x + r, y1: o.y + r, z1: o.z + r };
  }
  return null;
}

/** solidNear(x, y, z, destroyed?, pad?): is the point touching an intact solid world object? */
export function makeSolidNear(objects) {
  const HASH = 16;
  const solidHash = new Map();
  for (const o of objects) {
    const s = solidBounds(o);
    if (!s) continue;
    for (let gx = Math.floor(s.x0 / HASH); gx <= Math.floor(s.x1 / HASH); gx++) {
      for (let gz = Math.floor(s.z0 / HASH); gz <= Math.floor(s.z1 / HASH); gz++) {
        const k = gx * 1000 + gz;
        let list = solidHash.get(k);
        if (!list) solidHash.set(k, (list = []));
        list.push(s);
      }
    }
  }
  return function solidNear(x, y, z, destroyed, pad = 0.35) {
    const list = solidHash.get(Math.floor(x / HASH) * 1000 + Math.floor(z / HASH));
    if (!list) return false;
    for (const s of list) {
      if (destroyed && destroyed.has(s.id)) continue;
      if (x >= s.x0 - pad && x <= s.x1 + pad && y >= s.y0 - pad && y <= s.y1 + pad && z >= s.z0 - pad && z <= s.z1 + pad) return true;
    }
    return false;
  };
}

/** objectsNear(x, z, r, fn): fn(o) for every object whose centre is within r (32 m hash); fn returning true stops. */
export function makeObjectsNear(objects) {
  const NEAR = 32;
  const nearKey = (gx, gz) => (gx + 2048) * 4096 + (gz + 2048);
  const nearHash = new Map();
  for (const o of objects) {
    const k = nearKey(Math.floor(o.x / NEAR), Math.floor(o.z / NEAR));
    let list = nearHash.get(k);
    if (!list) nearHash.set(k, (list = []));
    list.push(o);
  }
  return function objectsNear(x, z, r, fn) {
    const gx0 = Math.floor((x - r) / NEAR), gx1 = Math.floor((x + r) / NEAR);
    const gz0 = Math.floor((z - r) / NEAR), gz1 = Math.floor((z + r) / NEAR);
    const rr = r * r;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = nearHash.get(nearKey(gx, gz));
        if (!list) continue;
        for (const o of list) {
          const dx = o.x - x, dz = o.z - z;
          if (dx * dx + dz * dz <= rr && fn(o) === true) return true;
        }
      }
    }
    return false;
  };
}

/**
 * The 64 m chunk index: every object id by the chunk its centre is in.
 * { size: 64, nx, nz, x0, z0, start: Int32Array(nx * nz + 1), ids: Int32Array } (CSR: the ids of chunk
 * (cx, cz) are ids[start[c] .. start[c + 1]) with c = cz * nx + cx); of(x, z) -> chunk number or -1;
 * forEach(c, fn) calls fn(id) for every object in chunk c.
 */
export function makeChunkIndex(objects, size, chunk = 64) {
  const half = size / 2;
  const nx = Math.ceil(size / chunk), nz = nx;
  const of = (x, z) => {
    const cx = Math.floor((x + half) / chunk), cz = Math.floor((z + half) / chunk);
    if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return -1;
    return cz * nx + cx;
  };
  const count = new Int32Array(nx * nz + 1);
  const cOf = new Int32Array(objects.length);
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    let c = of(o.x, o.z);
    if (c < 0) c = of(clamp(o.x, -half, half - 0.01), clamp(o.z, -half, half - 0.01));
    cOf[i] = c;
    count[c + 1]++;
  }
  for (let c = 0; c < nx * nz; c++) count[c + 1] += count[c];
  const start = count.slice();
  const fill = count.slice();
  const ids = new Int32Array(objects.length);
  for (let i = 0; i < objects.length; i++) ids[fill[cOf[i]]++] = i;
  return {
    size: chunk, nx, nz, x0: -half, z0: -half, start, ids, of,
    forEach(c, fn) { for (let k = start[c]; k < start[c + 1]; k++) fn(ids[k]); },
  };
}
