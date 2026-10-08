// Roads: a minimum spanning tree plus a few loop edges between the places, each routed by A* on a
// 16 m slope-cost grid (water may only be crossed straight along x or z: those runs become bridges),
// smoothed, given a gentle height profile and stamped into the terrain (levelled across, with
// soft shoulders) and into the road mask. Town streets are stamped the same way.
import { smoothstep, lerp, clamp } from '../rng.js';
import { bbox } from './heights.js';
import { OCC } from './grid.js';

const STEP = 16;

/** Which place pairs get a road: MST over all places, plus loops where the MST detour is long. */
export function roadEdges(regions, plans) {
  const n = regions.length;
  const hub = (i) => plans[i].hub;
  const dist = (a, b) => {
    const dx = hub(a)[0] - hub(b)[0], dz = hub(a)[1] - hub(b)[1];
    return Math.sqrt(dx * dx + dz * dz);
  };
  const inTree = new Uint8Array(n);
  inTree[0] = 1;
  const edges = [];
  const adj = Array.from({ length: n }, () => []);
  for (let added = 1; added < n; added++) {
    let best = null;
    for (let a = 0; a < n; a++) {
      if (!inTree[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inTree[b]) continue;
        const d = dist(a, b);
        if (!best || d < best[2]) best = [a, b, d];
      }
    }
    inTree[best[1]] = 1;
    edges.push(best);
    adj[best[0]].push([best[1], best[2]]);
    adj[best[1]].push([best[0], best[2]]);
  }
  // loops: for each place, its 2 nearest neighbours if the tree detour is > 1.7x the straight line
  const treeDist = (a, b) => {
    const d = new Float64Array(n).fill(Infinity);
    d[a] = 0;
    const stack = [a];
    while (stack.length) {
      const u = stack.pop();
      for (const [v, w] of adj[u]) if (d[v] === Infinity) { d[v] = d[u] + w; stack.push(v); }
    }
    return d[b];
  };
  const extra = [];
  for (let a = 0; a < n; a++) {
    if (!regions[a].named) continue;
    const near = [];
    for (let b = 0; b < n; b++) if (b !== a && regions[b].named) near.push([b, dist(a, b)]);
    near.sort((p, q) => p[1] - q[1]);
    for (const [b, d] of near.slice(0, 2)) {
      if (d > 360 || b < a && extra.some((e) => e[0] === b && e[1] === a)) continue;
      if (treeDist(a, b) > d * 1.7 && !extra.some((e) => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a))) extra.push([a, b, d]);
    }
  }
  extra.sort((p, q) => p[2] - q[2]);
  return [...edges, ...extra.slice(0, 10)];
}

/** The A* grid: node heights, water and blocked flags, place membership. */
export function makeRoadGrid(G, regions, plans, L) {
  const n = Math.floor(G.size / STEP) + 1;
  const half = G.half;
  const h = new Float32Array(n * n), water = new Uint8Array(n * n), blocked = new Uint8Array(n * n);
  const inPlace = new Int16Array(n * n).fill(-1), street = new Uint8Array(n * n), used = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * STEP, z = -half + j * STEP;
      const k = j * n + i;
      const y = G.heightAt(x, z);
      h[k] = y;
      if (y < 0.6) water[k] = 1;
      const gi = G.at(x, z);
      if (y < -0.8 && !G.inland[gi]) blocked[k] = 1;  // the sea
      if (G.land[gi] < 0.75) blocked[k] = 1;
      if (G.road[gi]) street[k] = 1;
      else if (G.occ[gi] === OCC.KEEP) blocked[k] = 1;
    }
  }
  // the volcano crater and the snowy summit are off limits
  const v = L.volcano;
  regions.forEach((g, ri) => {
    const r = g.r * 0.9;
    const i0 = Math.max(0, Math.floor((g.x - r + half) / STEP)), i1 = Math.min(n - 1, Math.ceil((g.x + r + half) / STEP));
    const j0 = Math.max(0, Math.floor((g.z - r + half) / STEP)), j1 = Math.min(n - 1, Math.ceil((g.z + r + half) / STEP));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -half + i * STEP, z = -half + j * STEP;
      if ((x - g.x) * (x - g.x) + (z - g.z) * (z - g.z) < r * r) inPlace[j * n + i] = ri;
    }
  });
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -half + i * STEP, z = -half + j * STEP;
    if ((x - v.x) * (x - v.x) + (z - v.z) * (z - v.z) < (v.crater * 1.5) * (v.crater * 1.5)) blocked[j * n + i] = 1;
  }
  return { n, half, h, water, blocked, inPlace, street, used };
}

// a small binary heap of node ids keyed by f-scores
class Heap {
  constructor(cap) { this.ids = new Int32Array(cap); this.keys = new Float64Array(cap); this.size = 0; }
  push(id, key) {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p]; i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop() {
    const top = this.ids[0];
    const id = this.ids[--this.size], key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c]; this.keys[i] = this.keys[c]; i = c;
    }
    this.ids[i] = id; this.keys[i] = key;
    return top;
  }
}

const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.41421356], [1, -1, 1.41421356], [-1, 1, 1.41421356], [-1, -1, 1.41421356]];

/** A* between two points; returns the node path [[x, z, isWater, node], ...] or null. */
export function routeRoad(RG, ax, az, bx, bz, ends) {
  const { n, half, h, water, blocked, inPlace, street, used } = RG;
  const idx = (x, z) => clamp(Math.round((z + half) / STEP), 0, n - 1) * n + clamp(Math.round((x + half) / STEP), 0, n - 1);
  const s = idx(ax, az), t = idx(bx, bz);
  const N2 = n * n;
  const g = RG.g || (RG.g = new Float64Array(N2));
  const came = RG.came || (RG.came = new Int32Array(N2));
  const closed = RG.closed || (RG.closed = new Uint8Array(N2));
  g.fill(Infinity); closed.fill(0);
  const heap = RG.heap || (RG.heap = new Heap(N2 * 8));
  heap.size = 0;
  const tx = t % n, tz = (t / n) | 0;
  g[s] = 0; came[s] = -1;
  heap.push(s, 0);
  while (heap.size) {
    const u = heap.pop();
    if (u === t) break;
    if (closed[u]) continue;
    closed[u] = 1;
    const ux = u % n, uz = (u / n) | 0;
    for (let nb = 0; nb < 8; nb++) {
      const dx = NB[nb][0], dz = NB[nb][1], len = NB[nb][2];
      const vx = ux + dx, vz = uz + dz;
      if (vx < 0 || vz < 0 || vx >= n || vz >= n) continue;
      const v = vz * n + vx;
      if (closed[v] || (blocked[v] && v !== t)) continue;
      const wv = water[v], wu = water[u];
      // water only straight along x or z (bridges), never diagonal
      if ((wv || wu) && len > 1) continue;
      const L = len * STEP;
      const dh = Math.abs(h[v] - h[u]);
      const slope = dh / L;
      if (slope > 0.45 && !wv && !wu) continue;
      let c = L * (1 + 22 * slope * slope);
      if (slope > 0.22) c *= 2.5;
      if (wv) c = L * 7;
      const pl = inPlace[v];
      if (pl >= 0 && !street[v]) c *= 6;
      if (street[v]) c *= 0.4;
      else if (used[v]) c *= 0.5;
      const ng = g[u] + c;
      if (ng < g[v]) {
        g[v] = ng; came[v] = u;
        const ex = vx - tx, ez = vz - tz;
        heap.push(v, ng + Math.sqrt(ex * ex + ez * ez) * STEP * 0.4);
      }
    }
  }
  if (g[t] === Infinity) return null;
  const path = [];
  for (let u = t; u !== -1; u = came[u]) {
    path.push([-half + (u % n) * STEP, -half + ((u / n) | 0) * STEP, water[u], u]);
    used[u] = 1;
  }
  path.reverse();
  return path;
}

/** Chaikin smoothing of a polyline segment (keeps the end points). */
function chaikin(pts, iters) {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    if (p.length < 3) return p;
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      if (i > 0) q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      if (i < p.length - 2) q.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/**
 * Turn a node path into road pieces: land runs (smoothed polylines with a height profile) and
 * bridges (straight water runs). Returns [{ bridge, pts: [[x, z, y], ...] }].
 */
export function shapeRoad(G, path) {
  // split into land / water runs; a water run takes the land nodes on both sides as its ends
  const runs = [];
  let i = 0;
  while (i < path.length) {
    if (!path[i][2]) {
      let j = i;
      while (j + 1 < path.length && !path[j + 1][2]) j++;
      runs.push({ bridge: false, a: i, b: j });
      i = j + 1;
    } else {
      let j = i;
      while (j + 1 < path.length && path[j + 1][2]) j++;
      runs.push({ bridge: true, a: Math.max(0, i - 1), b: Math.min(path.length - 1, j + 1) });
      i = j + 1;
    }
  }
  // a "water" run only becomes a bridge over real water (somewhere below -0.3 m); else it is road
  for (const r of runs) {
    if (!r.bridge) continue;
    let deep = false;
    for (let k = r.a; k <= r.b; k++) if (path[k][2] && G.heightAt(path[k][0], path[k][1]) < -0.3) deep = true;
    if (!deep) r.bridge = false;
  }
  for (let k = runs.length - 1; k > 0; k--) {
    // merge neighbouring land runs
    if (!runs[k].bridge && !runs[k - 1].bridge) { runs[k - 1].b = Math.max(runs[k - 1].b, runs[k].b); runs.splice(k, 1); }
  }
  const out = [];
  for (const r of runs) {
    if (r.bridge) {
      const A = path[r.a], Bp = path[r.b];
      const y = Math.max(G.heightAt(A[0], A[1]), G.heightAt(Bp[0], Bp[1]), 2.4) + 0.3;
      out.push({ bridge: true, pts: [[A[0], A[1], y], [Bp[0], Bp[1], y]] });
    } else {
      let pts = path.slice(r.a, r.b + 1).map((p) => [p[0], p[1]]);
      if (pts.length < 2) continue;
      // drop collinear nodes, then smooth
      const simp = [pts[0]];
      for (let k = 1; k < pts.length - 1; k++) {
        const [ax, az] = simp[simp.length - 1], [bx, bz] = pts[k], [cx, cz] = pts[k + 1];
        if ((bx - ax) * (cz - bz) - (bz - az) * (cx - bx) !== 0) simp.push(pts[k]);
      }
      simp.push(pts[pts.length - 1]);
      pts = chaikin(simp, 2);
      out.push({ bridge: false, pts: pts.map(([x, z]) => [x, z, G.heightAt(x, z)]) });
    }
  }
  // height profile: land runs ramp to the bridge decks at their ends, then a gentle smoothing
  for (let k = 0; k < out.length; k++) {
    const r = out[k];
    if (r.bridge) continue;
    const prev = out[k - 1], next = out[k + 1];
    const pts = r.pts;
    for (let pass = 0; pass < 4; pass++) {
      const y = pts.map((p) => p[2]);
      for (let m = 1; m < pts.length - 1; m++) pts[m][2] = (y[m - 1] + 2 * y[m] + y[m + 1]) / 4;
    }
    if (prev && prev.bridge) rampEnd(pts, prev.pts[0][2], false);
    if (next && next.bridge) rampEnd(pts, next.pts[0][2], true);
  }
  return out;
}

/** Blend the road height toward a bridge deck over the last 30 m at one end. */
function rampEnd(pts, deckY, atEnd) {
  const n = pts.length;
  let acc = 0;
  for (let m = 0; m < n; m++) {
    const i = atEnd ? n - 1 - m : m;
    if (m > 0) {
      const j = atEnd ? i + 1 : i - 1;
      const dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1];
      acc += Math.sqrt(dx * dx + dz * dz);
    }
    if (acc > 30) break;
    pts[i][2] = lerp(deckY, pts[i][2], smoothstep(0, 30, acc));
  }
}

/**
 * Stamp a road / street polyline into the terrain: level within half width + 1 m to the
 * centreline height, soft shoulders out to +7 m (max weight wins, so crossings stay smooth),
 * the road mask (1 dirt, 2 paved) and the occupancy grid.
 */
export function stampRoad(G, pts, w, paved, padW, padY) {
  const { N, cell, half, heights, road, occ } = G;
  const hw = w / 2, sh = 7;
  for (let s = 0; s < pts.length - 1; s++) {
    const [ax, az, ay] = pts[s], [bx, bz, by] = pts[s + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    if (L2 < 1e-6) continue;
    const [ix0, ix1, iz0, iz1] = bbox(G, Math.min(ax, bx) - hw - sh, Math.min(az, bz) - hw - sh, Math.max(ax, bx) + hw + sh, Math.max(az, bz) + hw + sh);
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = -half + iz * cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -half + ix * cell;
        let t = ((x - ax) * dx + (z - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        const d = Math.sqrt(ex * ex + ez * ez);
        if (d > hw + sh) continue;
        const i = iz * N + ix;
        if (heights[i] < -0.3 && G.inland[i]) continue; // never fill the river or the lake
        const wgt = d <= hw + 1 ? 1 : smoothstep(hw + sh, hw + 1, d);
        if (wgt > padW[i]) { padW[i] = wgt; padY[i] = ay + (by - ay) * t - 0.02; }
        if (d <= hw) road[i] = Math.max(road[i], paved ? 2 : 1);
        if (d <= hw + 1.5) occ[i] = OCC.ROAD;
      }
    }
  }
}

/** Apply the max-weight stamp buffers to the heights (and clear them). */
export function applyPads(G, padW, padY) {
  const { heights } = G;
  for (let i = 0; i < heights.length; i++) {
    const w = padW[i];
    if (w > 0) { heights[i] = heights[i] + (padY[i] - heights[i]) * w; padW[i] = 0; }
  }
}

/**
 * Trim a routed path to the part between two places' street networks: it starts at the last
 * street node of place a and ends at the first street node of place b (towns), so roads join the
 * streets instead of cutting through the plots.
 */
export function trimToStreets(RG, path, a, b) {
  const isStreet = (p, pl) => RG.street[p[3]] && RG.inPlace[p[3]] === pl;
  let s = 0, e = path.length - 1;
  for (let i = 0; i < path.length; i++) if (isStreet(path[i], a)) s = i; else if (RG.inPlace[path[i][3]] !== a) break;
  for (let i = path.length - 1; i > s; i--) if (isStreet(path[i], b)) e = i; else if (RG.inPlace[path[i][3]] !== b) break;
  return path.slice(s, e + 1);
}
