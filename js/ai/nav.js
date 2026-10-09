// Bot navigation over the island: a walkability grid, a coarse graph with A*, a shared storm flow
// field and a path follower. Plain data and math only (no three.js, no DOM), so Node tests can
// drive it on any world (test/nav.test.mjs).
//
// Built once per world (navFor(data)), a few milliseconds per frame (build(budgetMs)):
//  - fine grid, 4 m cells: slopes over 40° are avoided (6x the cost), over 45° they can only be
//    walked down and over 55° (cliffs) only jumped down a few metres; something solid 0.9 m above the ground
//    (data.solidNear) blocks a cell; water (ground under -0.5 m) is swimmable at 4x the cost; roads cost
//    0.7x; bridges (data.roads with bridge: true) are walkable decks over the water; lava discs and
//    the deep ocean are blocked; buildings with doors (data.houses[].doors) are rooms you enter
//    through a door (and climb by their stairs), never shortcuts
//  - coarse graph, 16 m: one node per block (its most walkable cell), 8 neighbours whose links are
//    checked on the fine grid; launch pads (data.pads) add one-way links to where they throw you
//  - A* with a binary heap and a (from, goal) path cache; queries are rationed to QUERY_RATE a second
//    across all bots (take())
//  - one Dijkstra per storm circle (flowTo) that every bot rotating into the circle shares
const C = 4;                  // fine cell (m)
const K = 4;                  // fine cells per coarse block side (16 m)
const CC = C * K;
const MAX_SLOPE = 0.8391;     // tan 40°: steeper ground is avoided...
const MAX_STEEP = 1.0;        // ...over 45° it is only walked downhill (the mover climbs up to 52°)...
const MAX_DOWN = 1.43;        // ...and over 55° it is a cliff (jump down at most CLIFF_DROP)
const CLIFF_DROP = 5;         // m: a fall that costs no health (PLAYER.fallSafe is ~7.5 m)
const DROP_COST = 60;         // m: jumping down a ledge counts this much extra (only to save a long way round)
const WATER_ENTRY = 40;       // m: wading in counts this much extra (bridges win short detours)
const WATER_H = -0.5;         // ground below this is water (the sea is the y = 0 plane)
const OCEAN_H = -5;           // ...and below this it is open sea: not worth swimming through
const SWIM_Y = -1.15;         // where a swimmer's feet are (js/actors/mover.js WATER_FEET)
const SOLID_Y = 0.9;          // probe height above the ground
const SOLID_PAD = 0.55;
export const QUERY_RATE = 6;  // A* queries a second, shared by every bot on this device
const CACHE_MAX = 512;

// fine cell flags
// (lava and the open sea are F_BLOCK)
export const F_BLOCK = 1, F_WATER = 2, F_ROAD = 4, F_BRIDGE = 8, F_HOUSE = 16, F_CLIFF = 32, F_STEEP = 64, F_DOWN = 128;
/** What a straight walk may not cross: walls, buildings, cliffs, water and steep slopes (routes may). */
export const STRICT = F_BLOCK | F_HOUSE | F_CLIFF | F_WATER | F_STEEP | F_DOWN;
const WALL = F_BLOCK | F_HOUSE | F_CLIFF;

// the 8 neighbour directions of the coarse graph (index d) and their lengths in blocks
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];
const DIR = [5, 6, 7, 4, -1, 0, 3, 2, 1]; // DIR[(dz + 1) * 3 + dx + 1] = d
/**
 * Waypoint codes: >= 0 a graph node; <= VIA a corner on the way into node VIA - code; ROOM a door
 * or room point (no graph node); STAIR a point of a flight of stairs (walked exactly); PAD the
 * launch pad itself, just before a pad link (walked exactly, so the pad throws you).
 */
export const ROOM = -1, STAIR = -2, PAD = -3, VIA = -10;
export const PADS_OFF_S = 60; // a pad that didn't throw anyone is left out of routes this long
const PAD_CLIMB = 1.0;        // the walk onto a pad: no steeper than 45° uphill (per 0.5 m)
const PAD_REACH = 1.2;        // ...up to this far from its centre (inside its trigger, traversal.padAt)
/** Graph node of a waypoint code (-1: not a graph point). */
export const wpNode = (code) => (code >= 0 ? code : code <= VIA ? VIA - code : -1);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const _navs = new WeakMap();
/** The (shared) navigation for a world's data; build() it before use. */
export function navFor(data) {
  let n = _navs.get(data);
  if (!n) { n = new Nav(data); _navs.set(data, n); }
  return n;
}

/** Binary min-heap of node indexes keyed by a float. */
class Heap {
  constructor(cap) { this.n = new Int32Array(cap); this.f = new Float64Array(cap); this.size = 0; }
  clear() { this.size = 0; }
  push(node, f) {
    if (this.size >= this.n.length) {
      const n = new Int32Array(this.n.length * 2), ff = new Float64Array(this.n.length * 2);
      n.set(this.n); ff.set(this.f); this.n = n; this.f = ff;
    }
    let i = this.size++;
    const N = this.n, F = this.f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      N[i] = N[p]; F[i] = F[p]; i = p;
    }
    N[i] = node; F[i] = f;
  }
  pop() {
    const N = this.n, F = this.f;
    const top = N[0];
    const last = --this.size;
    if (last > 0) {
      const ln = N[last], lf = F[last];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= last) break;
        if (c + 1 < last && F[c + 1] < F[c]) c++;
        if (F[c] >= lf) break;
        N[i] = N[c]; F[i] = F[c]; i = c;
      }
      N[i] = ln; F[i] = lf;
    }
    return top;
  }
}

export class Nav {
  constructor(data) {
    this.data = data;
    const size = data.size || 640;
    this.nx = Math.ceil(size / C);
    this.x0 = -(data.half ?? size / 2);
    this.nf = this.nx * this.nx;
    this.flags = new Uint8Array(this.nf);
    this.cost = new Uint8Array(this.nf);          // x20 (1 = 20)
    this.house = new Int16Array(this.nf).fill(-1); // doored building over this cell
    this.cnx = Math.ceil(this.nx / K);
    this.nn = this.cnx * this.cnx;
    this.rep = new Int32Array(this.nn).fill(-1);   // the node's fine cell (-1: no node)
    this.nodeX = new Float32Array(this.nn);
    this.nodeZ = new Float32Array(this.nn);
    this.ecost = new Float32Array(this.nn * 8).fill(Infinity);
    this.comp = new Int32Array(this.nn).fill(-1);  // connected component
    this.extra = new Map();                        // node -> [[to, cost], ...] (launch pads)
    this.vias = new Map();                         // u * 8 + d -> fine cells to walk via (links round a corner)
    this.padBad = new Map();                       // pad node -> until (page clock): a pad that didn't throw a walker
    this.padFails = new Map();                     // pad node -> times it failed
    this.cadjX = null;                             // component links without those pads
    this.ready = false;
    this.stage = 0;
    this.row = 0;
    this.buildMs = 0;
    // A* scratch
    this.g = new Float32Array(this.nn);
    this.parent = new Int32Array(this.nn);
    this.seen = new Uint32Array(this.nn);
    this.closed = new Uint32Array(this.nn);
    this.stamp = 0;
    this.heap = new Heap(1024);
    this.cache = new Map();
    this.flows = [];
    this.tokens = QUERY_RATE;
    this.tokT = -1;
    this.stats = { queries: 0, hits: 0, ms: 0, maxMs: 0, flows: 0, flowMs: 0, fails: 0 };
    // doored buildings: rooms with doors and stairs
    this.rooms = [];
    this.bridges = [];
    this._bfsQ = new Int32Array(K * K * 4 * 2);
    this._bfsD = new Int16Array(K * K * 4);
    this._bfsP = new Int16Array(K * K * 4);
    this._via = null;
  }

  // ------------------------------------------------------------------ building
  /** Work for up to budgetMs (Infinity: finish now). Returns true once the graph is ready. */
  build(budgetMs = Infinity) {
    if (this.ready) return true;
    const t0 = now();
    const end = t0 + budgetMs;
    while (!this.ready) {
      if (this.stage === 0) { this.prepare(); this.stage = 1; this.row = 0; } else if (this.stage === 1) {
        this.fineRow(this.row++);
        if (this.row >= this.nx) { this.overlays(); this.stage = 2; this.row = 0; }
      } else if (this.stage === 2) {
        this.nodeRow(this.row++);
        if (this.row >= this.cnx) { this.stage = 3; this.row = 0; }
      } else if (this.stage === 3) {
        this.edgeRow(this.row++);
        if (this.row >= this.cnx) { this.pads(); this.components(); this.ready = true; this.corner = null; }
      }
      if (now() > end) break;
    }
    this.buildMs += now() - t0;
    return this.ready;
  }

  prepare() {
    const d = this.data, nx = this.nx, n1 = nx + 1;
    // ground height at every fine corner
    const ch = (this.corner = new Float32Array(n1 * n1));
    for (let iz = 0; iz < n1; iz++) {
      const z = this.x0 + iz * C;
      for (let ix = 0; ix < n1; ix++) ch[iz * n1 + ix] = d.heightAt(this.x0 + ix * C, z);
    }
    // bridges: straight decks over the water
    for (const r of d.roads || []) {
      if (!r || !r.bridge || !Array.isArray(r.pts) || r.pts.length < 2) continue;
      const a = r.pts[0], b = r.pts[r.pts.length - 1];
      this.bridges.push({ ax: a[0], az: a[1], ay: a[2] ?? 0, bx: b[0], bz: b[1], by: b[2] ?? a[2] ?? 0, hw: Math.max(1.5, (r.w || 5) / 2) });
    }
    // buildings with doors (and their stairs): a room per building
    for (const h of d.houses || []) {
      if (!h || h.open || !Array.isArray(h.doors) || !h.doors.length || !Array.isArray(h.bounds)) continue;
      const doors = [];
      for (const dr of h.doors) {
        const [x, z, y, nx2, nz2] = dr;
        doors.push({ x, z, y, nx: nx2, nz: nz2, ox: x + nx2 * 2.4, oz: z + nz2 * 2.4, ix: x - nx2 * 1.4, iz: z - nz2 * 1.4 });
      }
      this.rooms[h.id] = { id: h.id, bounds: h.bounds, levels: h.levels || [h.y], stairs: h.stairs || [], doors, y: h.y ?? h.base ?? 0, top: h.top ?? (h.y + 4) };
    }
  }

  /** Slope, water, solids and costs for one row of fine cells. */
  fineRow(iz) {
    const d = this.data, nx = this.nx, n1 = nx + 1, ch = this.corner;
    const solidNear = d.solidNear;
    const z = this.x0 + (iz + 0.5) * C;
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix, j = iz * n1 + ix;
      const h00 = ch[j], h10 = ch[j + 1], h01 = ch[j + n1], h11 = ch[j + n1 + 1];
      const h = (h00 + h10 + h01 + h11) * 0.25;
      let f = 0;
      let s = Math.max(Math.abs(h10 - h00), Math.abs(h01 - h00), Math.abs(h11 - h10), Math.abs(h11 - h01),
        Math.abs(h11 - h00) * 0.7071, Math.abs(h10 - h01) * 0.7071) / C;
      if (h < WATER_H) { f |= F_WATER; s = 0; if (h < OCEAN_H) f |= F_BLOCK; } else if (s > MAX_DOWN) f |= F_CLIFF;
      else if (s > MAX_STEEP) f |= F_DOWN;
      else if (s > MAX_SLOPE) f |= F_STEEP;
      const x = this.x0 + (ix + 0.5) * C;
      if (!(f & (F_BLOCK | F_CLIFF)) && solidNear && solidNear(x, Math.max(h, SWIM_Y) + SOLID_Y, z, null, SOLID_PAD)) f |= F_BLOCK;
      this.flags[i] = f;
      const c = (f & F_WATER ? 4 : f & F_STEEP ? 6 : f & (F_DOWN | F_CLIFF) ? 12 : 1) * (1 + Math.max(0, Math.min(s, MAX_SLOPE) - 0.35) * 2);
      this.cost[i] = Math.min(255, Math.round(c * 20));
    }
  }

  /** Roads, bridges, lava and doored buildings on top of the terrain. */
  overlays() {
    const d = this.data, nx = this.nx, N = d.N;
    // roads: the world's road mask (grid points), else the road centrelines
    if (d.roadMask && N) {
      const cell = d.cell || C, half = d.half ?? -this.x0;
      for (let i = 0; i < this.nf; i++) {
        const ix = i % nx, iz = (i / nx) | 0;
        const gx = Math.round((this.x0 + (ix + 0.5) * C + half) / cell), gz = Math.round((this.x0 + (iz + 0.5) * C + half) / cell);
        if (gx >= 0 && gz >= 0 && gx < N && gz < N && d.roadMask[gz * N + gx]) this.markRoad(i);
      }
    } else {
      for (const r of d.roads || []) {
        if (!r || r.bridge || !Array.isArray(r.pts)) continue;
        for (let k = 1; k < r.pts.length; k++) {
          const a = r.pts[k - 1], b = r.pts[k];
          this.stamp2(a[0], a[1], b[0], b[1], (r.w || 6) / 2, (i) => this.markRoad(i));
        }
      }
    }
    for (const b of this.bridges) {
      this.stamp2(b.ax, b.az, b.bx, b.bz, b.hw, (i) => {
        this.flags[i] = (this.flags[i] & ~(F_BLOCK | F_CLIFF | F_WATER | F_STEEP | F_DOWN)) | F_BRIDGE | F_ROAD;
        this.cost[i] = 14;
      });
    }
    for (const L of d.lava || []) {
      if (!L) continue;
      this.stampDisc(L.x, L.z, (L.r || 5) + 2, (i) => { this.flags[i] |= F_BLOCK; });
    }
    for (const r of this.rooms) {
      if (!r) continue;
      const [x0, z0, x1, z1] = r.bounds;
      const a = this.cellOf(x0 + 0.6, z0 + 0.6), b = this.cellOf(x1 - 0.6, z1 - 0.6);
      if (a < 0 || b < 0) continue;
      const ax = a % nx, az = (a / nx) | 0, bx = b % nx, bz = (b / nx) | 0;
      for (let iz = az; iz <= bz; iz++) {
        for (let ix = ax; ix <= bx; ix++) {
          const i = iz * nx + ix;
          this.flags[i] |= F_HOUSE;
          this.house[i] = r.id;
        }
      }
    }
  }

  markRoad(i) {
    const f = this.flags[i];
    if (f & (F_WATER | F_BLOCK)) return;
    this.flags[i] = f | F_ROAD;
    if (!(f & (F_STEEP | F_DOWN | F_CLIFF))) this.cost[i] = Math.min(this.cost[i], 14);
  }

  /** fn(i) for every fine cell whose centre is within hw of the segment a-b. */
  stamp2(ax, az, bx, bz, hw, fn) {
    const nx = this.nx;
    const x0 = Math.min(ax, bx) - hw, x1 = Math.max(ax, bx) + hw, z0 = Math.min(az, bz) - hw, z1 = Math.max(az, bz) + hw;
    const ix0 = Math.max(0, Math.floor((x0 - this.x0) / C)), ix1 = Math.min(nx - 1, Math.floor((x1 - this.x0) / C));
    const iz0 = Math.max(0, Math.floor((z0 - this.x0) / C)), iz1 = Math.min(nx - 1, Math.floor((z1 - this.x0) / C));
    const ux = bx - ax, uz = bz - az, l2 = ux * ux + uz * uz || 1;
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = this.x0 + (iz + 0.5) * C;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.x0 + (ix + 0.5) * C;
        const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / l2));
        const ex = ax + ux * t - x, ez = az + uz * t - z;
        if (ex * ex + ez * ez <= hw * hw) fn(iz * nx + ix);
      }
    }
  }

  stampDisc(cx, cz, r, fn) { this.stamp2(cx, cz, cx, cz, r, fn); }

  /** The coarse node of each block in this row: its most walkable cell, nearest the middle. */
  nodeRow(cz) {
    const nx = this.nx, cnx = this.cnx;
    for (let cx = 0; cx < cnx; cx++) {
      const n = cz * cnx + cx;
      let best = -1, bestS = Infinity;
      for (let a = 0; a < K; a++) {
        const iz = cz * K + a;
        if (iz >= nx) break;
        for (let b = 0; b < K; b++) {
          const ix = cx * K + b;
          if (ix >= nx) break;
          const i = iz * nx + ix;
          const f = this.flags[i];
          if (f & WALL) continue;
          const s = this.cost[i] + (f & F_WATER ? 200 : f & (F_STEEP | F_DOWN) ? 100 : 0) + (Math.abs(a - 1.5) + Math.abs(b - 1.5)) * 4;
          if (s < bestS) { bestS = s; best = i; }
        }
      }
      this.rep[n] = best;
      if (best >= 0) {
        this.nodeX[n] = this.x0 + ((best % nx) + 0.5) * C;
        this.nodeZ[n] = this.x0 + (((best / nx) | 0) + 0.5) * C;
      }
    }
  }

  /** Links from each node of this row to its E, SE, S and SW neighbours (both ways). */
  edgeRow(cz) {
    const cnx = this.cnx;
    for (let cx = 0; cx < cnx; cx++) {
      const u = cz * cnx + cx;
      if (this.rep[u] < 0) continue;
      for (let d = 0; d < 4; d++) {
        const vx = cx + DX[d], vz = cz + DZ[d];
        if (vx < 0 || vz < 0 || vx >= cnx || vz >= cnx) continue;
        const v = vz * cnx + vx;
        if (this.rep[v] < 0) continue;
        // a diagonal needs one of its two corners open (no squeezing between two blocked blocks)
        if (d & 1 && this.rep[cz * cnx + vx] < 0 && this.rep[vz * cnx + cx] < 0) continue;
        // each way on its own: a slope too steep to climb can still be walked (slid) down
        let c = this.lineCost(this.nodeX[u], this.nodeZ[u], this.nodeX[v], this.nodeZ[v], WALL, true);
        let r = this.lineCost(this.nodeX[v], this.nodeZ[v], this.nodeX[u], this.nodeZ[u], WALL, true);
        if (!(c < Infinity) && !(r < Infinity)) {
          c = r = this.bfsCost(u, v);
          // not a straight walk: the corners to walk by
          if (c < Infinity && this._via) {
            this.vias.set(u * 8 + d, Int32Array.from(this._via));
            this.vias.set(v * 8 + d + 4, Int32Array.from(this._via).reverse());
          }
        }
        if (c < Infinity) this.ecost[u * 8 + d] = c;
        if (r < Infinity) this.ecost[v * 8 + d + 4] = r;
      }
    }
  }

  /**
   * Fine-grid cost (m x cost) of walking straight from a to b, or Infinity if it crosses a cell
   * with any of the `mask` flags (default: walls and buildings). Wading into water costs extra;
   * with downhill set, slopes too steep to climb pass going down, and cliffs if the drop is short.
   */
  lineCost(ax, az, bx, bz, mask = WALL, downhill = false) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / (C * 0.5)));
    const step = len / n;
    const hAt = this.data.heightAt;
    const m = downhill ? mask & ~F_CLIFF : mask;
    let c = 0, wet = -1, hp = NaN, drop = 0;
    for (let k = 0; k <= n; k++) {
      const x = ax + (dx * k) / n, z = az + (dz * k) / n;
      const i = this.cellOf(x, z);
      if (i < 0) return Infinity;
      const f = this.flags[i];
      if (f & m) return Infinity;
      if (f & (F_DOWN | F_CLIFF)) {
        if (!downhill) return Infinity;
        const h = hAt(x, z);
        if (!(h < hp + 0.3)) return Infinity;
        if (f & F_CLIFF) {
          if (!drop) c += DROP_COST;
          drop += hp - h + 1e-3;
          if (drop > CLIFF_DROP) return Infinity;
        } else drop = 0;
        hp = h;
      } else { hp = downhill ? hAt(x, z) : NaN; drop = 0; }
      const w = f & F_WATER ? 1 : 0;
      if (wet === 0 && w) c += WATER_ENTRY;
      wet = w;
      if (k > 0) c += this.cost[i] * 0.05 * step;
    }
    return c;
  }

  /**
   * Two neighbour blocks whose straight link is blocked: are they connected inside the two blocks
   * (the 2x2 around a diagonal)? Breadth-first over their fine cells; cost from the step count.
   * Leaves in this._via up to two corner cells that make the way a few straight walks (or null).
   */
  bfsCost(u, v) {
    const cnx = this.cnx, nx = this.nx;
    const ux = u % cnx, uz = (u / cnx) | 0, vx = v % cnx, vz = (v / cnx) | 0;
    const bx0 = Math.min(ux, vx) * K, bz0 = Math.min(uz, vz) * K;
    const w = (Math.abs(ux - vx) + 1) * K, h = (Math.abs(uz - vz) + 1) * K;
    const D = this._bfsD, Q = this._bfsQ, P = this._bfsP;
    D.fill(-1, 0, w * h);
    this._via = null;
    const a = this.rep[u], b = this.rep[v];
    const loc = (i) => { const ix = (i % nx) - bx0, iz = ((i / nx) | 0) - bz0; return ix >= 0 && iz >= 0 && ix < w && iz < h ? iz * w + ix : -1; };
    const la = loc(a), lb = loc(b);
    if (la < 0 || lb < 0) return Infinity;
    let qh = 0, qt = 0;
    Q[qt++] = la; D[la] = 0;
    let sum = 0;
    while (qh < qt) {
      const l = Q[qh++];
      if (l === lb) break;
      const lx = l % w, lz = (l / w) | 0;
      for (let k = 0; k < 4; k++) {
        const mx = lx + (k === 0 ? 1 : k === 1 ? -1 : 0), mz = lz + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (mx < 0 || mz < 0 || mx >= w || mz >= h) continue;
        const m = mz * w + mx;
        if (D[m] >= 0) continue;
        const fi = (bz0 + mz) * nx + bx0 + mx;
        if (bx0 + mx >= nx || bz0 + mz >= nx || this.flags[fi] & (WALL | F_DOWN)) continue;
        D[m] = D[l] + 1;
        P[m] = l;
        sum += this.cost[fi];
        Q[qt++] = m;
      }
    }
    if (D[lb] < 0) return Infinity;
    // the corners: from where we stand, the farthest cell of the way still in plain view
    const path = [];
    for (let l = lb; l !== la; l = P[l]) path.push((bz0 + ((l / w) | 0)) * nx + bx0 + (l % w));
    path.push(a);
    path.reverse();
    const cx = (i) => this.x0 + ((i % nx) + 0.5) * C, cz = (i) => this.x0 + (((i / nx) | 0) + 0.5) * C;
    const clear = (i, j) => this.lineCost(cx(i), cz(i), cx(j), cz(j)) < Infinity;
    let from = a, k = 0;
    const via = [];
    while (via.length < 2 && !clear(from, b)) {
      let best = -1;
      for (let j = path.length - 2; j > k; j--) if (clear(from, path[j])) { best = j; break; }
      if (best < 0) break;
      via.push(path[best]);
      from = path[best]; k = best;
    }
    if (via.length) this._via = via;
    const avg = qt > 1 ? (sum / (qt - 1)) * 0.05 : 1;
    const wade = (this.flags[a] ^ this.flags[b]) & F_WATER ? WATER_ENTRY : 0;
    return D[lb] * C * avg * 0.85 + wade;
  }

  /**
   * Launch pads: one-way links from the pad's approach node (padApproach) to open ground it can
   * throw you to.
   */
  pads() {
    const d = this.data;
    for (const p of d.pads || []) {
      // (a bounce mushroom throws you a few metres: walking is as good)
      if (!p || p.kind === 'mushroom') continue;
      // (a pad up on a roof is no use to someone walking the ground graph)
      const py = p.y ?? d.heightAt(p.x, p.z);
      if (p.roof || py > d.heightAt(p.x, p.z) + 2.5) continue;
      const u = this.padApproach(p);
      if (u < 0) continue;
      const pw = p.power || 1;
      const list = [];
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        for (const r of [45 * pw, 80 * pw]) {
          const v = this.nodeAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 1);
          if (v < 0 || v === u) continue;
          const vi = this.rep[v];
          if (this.flags[vi] & F_WATER) continue;
          if (d.heightAt(this.nodeX[v], this.nodeZ[v]) > py + 25) continue;
          list.push([v, r * 0.5 + 8, p.x, p.z, py]); // (the pad's own spot: the route walks onto it)
        }
      }
      if (list.length) this.extra.set(u, (this.extra.get(u) || []).concat(list));
    }
  }

  /**
   * The node a walker gets onto pad p from: the nearest one (within 16 m) whose straight walk onto
   * the pad is clear, or -1 (then the pad is no route). A geyser on the volcano's flank with a rock
   * in the way, or the crater's geysers in their lava, would otherwise be a route the bots walk
   * forever and never get thrown.
   */
  padApproach(p) {
    const cx = Math.floor((p.x - this.x0) / CC), cz = Math.floor((p.z - this.x0) / CC);
    const cands = [];
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        const nx = cx + b, nz = cz + a;
        if (nx < 0 || nz < 0 || nx >= this.cnx || nz >= this.cnx) continue;
        const n = nz * this.cnx + nx;
        if (this.rep[n] < 0) continue;
        const L = Math.hypot(this.nodeX[n] - p.x, this.nodeZ[n] - p.z);
        if (L <= 16) cands.push([L, n]);
      }
    }
    cands.sort((x, y) => x[0] - y[0]);
    for (const [, n] of cands) if (this.padWalk(this.nodeX[n], this.nodeZ[n], p)) return n;
    return -1;
  }

  /** Can someone walk straight from (ax, az) onto pad p: no water, lava, house or solid object in the way, nothing too steep? */
  padWalk(ax, az, p) {
    const d = this.data, hAt = d.heightAt, solid = d.solidNear;
    const L = Math.hypot(p.x - ax, p.z - az);
    if (L <= PAD_REACH) return true;
    const ux = (p.x - ax) / L, uz = (p.z - az) / L;
    const n = Math.ceil((L - PAD_REACH) / 0.5);
    let hp = hAt(ax, az);
    for (let k = 1; k <= n; k++) {
      const t = Math.min(L - PAD_REACH, k * 0.5);
      const x = ax + ux * t, z = az + uz * t;
      const h = hAt(x, z);
      if (h < WATER_H || (h - hp) / 0.5 > PAD_CLIMB) return false;
      hp = h;
      if (this.flagsAt(x, z) & (F_BLOCK | F_HOUSE | F_WATER | F_CLIFF)) return false;
      if (solid && solid(x, h + SOLID_Y, z, null, 0.4)) return false;
    }
    return true;
  }

  /**
   * Components of the two-way links, so impossible queries fail fast; a component with one-way
   * exits (a slope you can only slide down, a launch pad) may still reach others (exits[c]).
   */
  components() {
    const comp = this.comp, cnx = this.cnx, ec = this.ecost;
    let c = 0;
    const q = new Int32Array(this.nn);
    for (let s = 0; s < this.nn; s++) {
      if (this.rep[s] < 0 || comp[s] >= 0) continue;
      let h = 0, t = 0;
      q[t++] = s; comp[s] = c;
      while (h < t) {
        const u = q[h++];
        for (let d = 0; d < 8; d++) {
          if (!(ec[u * 8 + d] < Infinity)) continue;
          const v = u + DZ[d] * cnx + DX[d];
          if (!(ec[v * 8 + ((d + 4) & 7)] < Infinity)) continue; // one way only
          if (comp[v] < 0) { comp[v] = c; q[t++] = v; }
        }
      }
      c++;
    }
    this.ncomp = c;
    this.exits = new Uint8Array(c);
    this.entries = new Uint8Array(c);
    for (let u = 0; u < this.nn; u++) {
      if (comp[u] < 0) continue;
      for (let d = 0; d < 8; d++) {
        if (!(ec[u * 8 + d] < Infinity)) continue;
        const v = u + DZ[d] * cnx + DX[d];
        if (comp[v] !== comp[u]) { this.exits[comp[u]] = 1; this.entries[comp[v]] = 1; }
      }
    }
    for (const [u, list] of this.extra) {
      if (comp[u] >= 0) this.exits[comp[u]] = 1;
      for (const [v] of list) if (comp[v] >= 0) this.entries[comp[v]] = 1;
    }
    // the one-way links between components (drops, cliffs, pads), for canReach
    const adj = [];
    for (let k = 0; k < c; k++) adj.push(new Set());
    for (let u = 0; u < this.nn; u++) {
      const cu = comp[u];
      if (cu < 0 || !this.exits[cu]) continue;
      for (let d = 0; d < 8; d++) {
        if (!(ec[u * 8 + d] < Infinity)) continue;
        const cv = comp[u + DZ[d] * cnx + DX[d]];
        if (cv >= 0 && cv !== cu) adj[cu].add(cv);
      }
    }
    this.cadjG = adj.map((set) => Int32Array.from(set)); // on foot
    for (const [u, list] of this.extra) for (const [v] of list) if (comp[u] >= 0 && comp[v] >= 0 && comp[u] !== comp[v]) adj[comp[u]].add(comp[v]);
    this.cadjP = adj.map((set) => Int32Array.from(set)); // and the pads
    this.creach = new Map();
  }

  /**
   * Could a route from node s ever reach node g? The same component (two-way links), or one
   * reachable from it through one-way links (computed once per starting component, then kept).
   */
  canReach(s, g) {
    const a = this.comp[s], b = this.comp[g];
    if (a < 0 || b < 0) return false;
    if (a === b) return true;
    if (!this.exits[a] || !this.entries[b]) return false;
    // (pads count while they work: one that didn't throw us is left out a while, see PathFollower)
    const adj = this.padBad.size ? this.padAdj() : this.cadjP, key = a;
    let r = this.creach.get(key);
    if (!r) {
      r = new Uint8Array(this.ncomp);
      const q = [a];
      r[a] = 1;
      while (q.length) for (const v of adj[q.pop()]) if (!r[v]) { r[v] = 1; q.push(v); }
      if (this.creach.size >= 256) this.creach.delete(this.creach.keys().next().value);
      this.creach.set(key, r);
    }
    return r[b] === 1;
  }

  // ------------------------------------------------------------------ queries
  cellOf(x, z) {
    const ix = Math.floor((x - this.x0) / C), iz = Math.floor((z - this.x0) / C);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nx) return -1;
    return iz * this.nx + ix;
  }

  flagsAt(x, z) { const i = this.cellOf(x, z); return i < 0 ? F_BLOCK : this.flags[i]; }

  /** Can you walk here (water counts; buildings with doors do not)? */
  walkable(x, z) { return !(this.flagsAt(x, z) & WALL); }

  /** The doored building this point is inside (its room), or null. */
  roomAt(x, z) {
    const i = this.cellOf(x, z);
    if (i < 0 || this.house[i] < 0) return null;
    const r = this.rooms[this.house[i]];
    if (!r) return null;
    const [x0, z0, x1, z1] = r.bounds;
    return x > x0 && x < x1 && z > z0 && z < z1 ? r : null;
  }

  /** Height of the walking surface: a bridge deck, the swim line, or the ground. */
  groundY(x, z) {
    const f = this.flagsAt(x, z);
    if (f & F_BRIDGE) {
      for (const b of this.bridges) {
        const ux = b.bx - b.ax, uz = b.bz - b.az, l2 = ux * ux + uz * uz || 1;
        const t = Math.max(0, Math.min(1, ((x - b.ax) * ux + (z - b.az) * uz) / l2));
        const ex = b.ax + ux * t - x, ez = b.az + uz * t - z;
        if (ex * ex + ez * ez <= (b.hw + 2) * (b.hw + 2)) return b.ay + (b.by - b.ay) * t;
      }
    }
    return Math.max(SWIM_Y, this.data.heightAt(x, z));
  }

  /** A plain straight walk a-b: no walls, buildings, water or steep slopes on the way? */
  lineWalk(ax, az, bx, bz, mask = STRICT) { return this.lineCost(ax, az, bx, bz, mask) < Infinity; }

  /** Does a straight line a-b cross water (not counting bridges)? */
  lineWet(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / 2));
    for (let k = 0; k <= n; k++) if (this.flagsAt(ax + (dx * k) / n, az + (dz * k) / n) & F_WATER) return true;
    return false;
  }

  /** The node for a point: its own block's, else the nearest valid one within `ring` blocks. */
  nodeAt(x, z, ring = 3, comp = -1) {
    const cx = Math.floor((x - this.x0) / CC), cz = Math.floor((z - this.x0) / CC);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= ring; r++) {
      for (let a = -r; a <= r; a++) {
        for (let b = -r; b <= r; b++) {
          if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
          const nx = cx + b, nz = cz + a;
          if (nx < 0 || nz < 0 || nx >= this.cnx || nz >= this.cnx) continue;
          const n = nz * this.cnx + nx;
          if (this.rep[n] < 0 || (comp >= 0 && this.comp[n] !== comp)) continue;
          const dx = this.nodeX[n] - x, dz = this.nodeZ[n] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = n; }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** The nearest open (walkable, outside buildings, dry if possible) spot to (x, z) within maxR. */
  nearestOpen(x, z, maxR = 24, out = {}) {
    let best = -1, bestD = Infinity;
    const nx = this.nx, c0 = this.cellOf(x, z);
    if (c0 >= 0 && !(this.flags[c0] & (WALL | F_WATER | F_DOWN))) { out.x = x; out.z = z; return out; }
    const R = Math.ceil(maxR / C);
    const ix0 = Math.floor((x - this.x0) / C), iz0 = Math.floor((z - this.x0) / C);
    for (let a = -R; a <= R; a++) {
      for (let b = -R; b <= R; b++) {
        const ix = ix0 + b, iz = iz0 + a;
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nx) continue;
        const i = iz * nx + ix;
        const f = this.flags[i];
        if (f & WALL) continue;
        const d = a * a + b * b + (f & F_WATER ? 50 : 0) + (f & (F_STEEP | F_DOWN) ? 20 : 0);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0) return null;
    out.x = this.x0 + ((best % nx) + 0.5) * C;
    out.z = this.x0 + (((best / nx) | 0) + 0.5) * C;
    return out;
  }

  /** Spend one of the shared A* queries (QUERY_RATE a second, bursts of QUERY_RATE). t in s. */
  take(t) {
    if (this.tokT < 0 || t < this.tokT) this.tokT = t;
    this.tokens = Math.min(QUERY_RATE, this.tokens + (t - this.tokT) * QUERY_RATE);
    this.tokT = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /**
   * A* from node s to node g. blocked: optional Map(edge key u * nn + v -> until) of links this
   * bot gave up on (t = now, s). Returns an Int32Array of nodes (s ... g), or null.
   */
  /** Component links with the pads that work (none left out: cadjP). */
  padAdj() {
    if (this.cadjX) return this.cadjX;
    const comp = this.comp;
    const adj = this.cadjG.map((a) => new Set(a));
    for (const [u, list] of this.extra) {
      if (this.padBad.has(u)) continue;
      for (const [v] of list) if (comp[u] >= 0 && comp[v] >= 0 && comp[u] !== comp[v]) adj[comp[u]].add(comp[v]);
    }
    this.cadjX = adj.map((set) => Int32Array.from(set));
    return this.cadjX;
  }

  /** Do the pads all work right now (none left out of routes)? */
  get padsOn() { return this.padBad.size === 0; }

  /** Routes planned with or without some pad are planned again. */
  padsChanged() {
    this.cache.clear();
    if (this.creach) this.creach.clear();
    this.cadjX = null;
  }

  /**
   * Pads back once their time-out is over. On the page's clock: bots' own clocks differ, and the
   * Nav outlives a match.
   */
  padsCheck() {
    if (!this.padBad.size) return;
    const t = now();
    let back = false;
    for (const [u, until] of this.padBad) if (t >= until) { this.padBad.delete(u); back = true; }
    if (back) this.padsChanged();
  }

  /**
   * The pad at node u did not throw a walker: leave that pad (every pad when u is not given) out
   * of routes for PADS_OFF_S, twice as long each time it fails again (up to 16x). The others keep
   * working.
   */
  padsOff(u = -1) {
    const t = now();
    const off = (k) => {
      const n = Math.min(4, this.padFails.get(k) || 0);
      this.padFails.set(k, n + 1);
      this.padBad.set(k, t + PADS_OFF_S * 1000 * 2 ** n);
    };
    if (u >= 0) off(u);
    else for (const k of this.extra.keys()) off(k);
    this.padsChanged();
  }

  path(s, g, blocked = null, t = 0) {
    if (s < 0 || g < 0) return null;
    this.padsCheck();
    if (s === g) return Int32Array.of(s);
    if (!this.canReach(s, g)) return null;
    const useCache = !blocked || !blocked.size;
    const key = s * this.nn + g;
    if (useCache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) {
        this.cache.delete(key); this.cache.set(key, hit);
        this.stats.hits++;
        return hit;
      }
    }
    const t0 = now();
    const nodes = this.astar(s, g, blocked, t);
    const ms = now() - t0;
    this.stats.queries++;
    this.stats.ms += ms;
    if (ms > this.stats.maxMs) this.stats.maxMs = ms;
    if (!nodes) this.stats.fails++;
    if (useCache) {
      this.cache.set(key, nodes);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    return nodes;
  }

  astar(s, goal, blocked, t) {
    const cnx = this.cnx, nn = this.nn, ec = this.ecost, G = this.g, P = this.parent, seen = this.seen, closed = this.closed;
    const stamp = ++this.stamp;
    const heap = this.heap;
    heap.clear();
    const gx = goal % cnx, gz = (goal / cnx) | 0;
    const H = CC * 0.7;
    const h = (n) => {
      const dx = Math.abs((n % cnx) - gx), dz = Math.abs(((n / cnx) | 0) - gz);
      return (dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx) * H;
    };
    G[s] = 0; P[s] = -1; seen[s] = stamp;
    heap.push(s, h(s));
    const extra = this.extra.size ? this.extra : null;
    const bad = this.padBad.size ? this.padBad : null;
    const bl = blocked && blocked.size ? blocked : null;
    // with links blocked the goal may be cut off: don't search the whole island to find out
    let budget = bl ? 4000 : Infinity;
    let found = false;
    while (heap.size) {
      const u = heap.pop();
      if (closed[u] === stamp) continue;
      closed[u] = stamp;
      if (--budget < 0) break;
      if (u === goal) { found = true; break; }
      const gu = G[u];
      for (let d = 0; d < 8; d++) {
        const c = ec[u * 8 + d];
        if (!(c < Infinity)) continue;
        const v = u + DZ[d] * cnx + DX[d];
        if (closed[v] === stamp) continue;
        if (bl) { const until = bl.get(u * nn + v); if (until !== undefined && until > t) continue; }
        const ng = gu + c;
        if (seen[v] !== stamp || ng < G[v]) { seen[v] = stamp; G[v] = ng; P[v] = u; heap.push(v, ng + h(v)); }
      }
      if (extra) {
        const ex = bad && bad.has(u) ? null : extra.get(u);
        if (ex) {
          for (const [v, c] of ex) {
            if (closed[v] === stamp) continue;
            if (bl) { const until = bl.get(u * nn + v); if (until !== undefined && until > t) continue; }
            const ng = gu + c;
            if (seen[v] !== stamp || ng < G[v]) { seen[v] = stamp; G[v] = ng; P[v] = u; heap.push(v, ng + h(v)); }
          }
        }
      }
    }
    if (!found) return null;
    let n = 0;
    for (let u = goal; u >= 0; u = P[u]) n++;
    const out = new Int32Array(n);
    for (let u = goal, k = n - 1; u >= 0; u = P[u]) out[k--] = u;
    return out;
  }

  /** Corner cells (fine indexes) on the walk from node u to its neighbour v, or null. */
  viaOf(u, v) {
    if (!this.vias.size) return null;
    const cnx = this.cnx;
    const dx = (v % cnx) - (u % cnx), dz = ((v / cnx) | 0) - ((u / cnx) | 0);
    if (dx < -1 || dx > 1 || dz < -1 || dz > 1) return null;
    const d = DIR[(dz + 1) * 3 + dx + 1];
    return d >= 0 ? this.vias.get(u * 8 + d) || null : null;
  }

  /** Is the link u -> v a launch pad throw (not a walk)? */
  isPad(u, v) {
    const ex = this.extra.get(u);
    if (!ex) return false;
    for (const e of ex) if (e[0] === v) return true;
    return false;
  }

  /**
   * The storm's shared flow field toward a circle: dist[node] = cost to get inside (r * 0.85).
   * One Dijkstra per circle (cached), walking links only.
   */
  flowTo(cx, cz, r) {
    const key = `${Math.round(cx)},${Math.round(cz)},${Math.round(r)}`;
    for (const f of this.flows) if (f.key === key) return f;
    const t0 = now();
    const nn = this.nn, cnx = this.cnx, ec = this.ecost;
    const dist = new Float32Array(nn).fill(Infinity);
    const heap = this.fheap || (this.fheap = new Heap(8192));
    heap.clear();
    const rr = Math.max(8, r * 0.85) ** 2;
    let any = false;
    for (let n = 0; n < nn; n++) {
      if (this.rep[n] < 0) continue;
      const dx = this.nodeX[n] - cx, dz = this.nodeZ[n] - cz;
      if (dx * dx + dz * dz <= rr) { dist[n] = 0; heap.push(n, 0); any = true; }
    }
    if (!any) {
      const n = this.nodeAt(cx, cz, 8);
      if (n >= 0) { dist[n] = 0; heap.push(n, 0); }
    }
    // outward from the circle over the REVERSE links: dist[v] is the cost of walking v -> u -> ...
    // into the circle (a one-way link, a slope you can only slide down, counts in its own direction)
    const done = this.fdone && this.fdone.length === nn ? this.fdone.fill(0) : (this.fdone = new Uint8Array(nn));
    while (heap.size) {
      const u = heap.pop();
      if (done[u]) continue; // (a stale heap entry)
      done[u] = 1;
      const du = dist[u];
      const ux = u % cnx, uz = (u / cnx) | 0;
      for (let d = 0; d < 8; d++) {
        const vx = ux + DX[d], vz = uz + DZ[d];
        if (vx < 0 || vz < 0 || vx >= cnx || vz >= cnx) continue;
        const v = vz * cnx + vx;
        const c = ec[v * 8 + ((d + 4) & 7)]; // the link v -> u
        if (!(c < Infinity)) continue;
        const nd = du + c;
        if (nd < dist[v]) { dist[v] = nd; heap.push(v, nd); }
      }
    }
    const f = { key, cx, cz, r, dist };
    this.flows.unshift(f);
    if (this.flows.length > 2) this.flows.pop();
    const ms = now() - t0;
    this.stats.flows++;
    this.stats.flowMs = Math.max(this.stats.flowMs, ms);
    return f;
  }

  /** Nodes from s down the flow field until inside the circle (at most `max`). */
  flowPath(f, s, max = 400) {
    if (s < 0 || !(f.dist[s] < Infinity)) return null;
    const out = [s];
    const cnx = this.cnx, ec = this.ecost, dist = f.dist;
    let u = s;
    for (let k = 0; k < max && dist[u] > 0; k++) {
      let best = -1, bestV = dist[u];
      for (let d = 0; d < 8; d++) {
        const c = ec[u * 8 + d];
        if (!(c < Infinity)) continue;
        const v = u + DZ[d] * cnx + DX[d];
        if (dist[v] < bestV) { bestV = dist[v]; best = v; }
      }
      if (best < 0) break;
      out.push(best);
      u = best;
    }
    return Int32Array.from(out);
  }

  /** The highest open nodes inside a circle (for climbing away from rising lava). */
  highSpots(cx, cz, r, n = 8) {
    const key = `${Math.round(cx)},${Math.round(cz)},${Math.round(r)}`;
    if (this._high && this._high.key === key) return this._high.list;
    const cand = [];
    const rr = r * r;
    for (let k = 0; k < this.nn; k++) {
      const i = this.rep[k];
      if (i < 0 || this.flags[i] & F_WATER) continue;
      const dx = this.nodeX[k] - cx, dz = this.nodeZ[k] - cz;
      if (dx * dx + dz * dz > rr) continue;
      cand.push([this.data.heightAt(this.nodeX[k], this.nodeZ[k]), k]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    const list = cand.slice(0, n).map(([y, k]) => ({ x: this.nodeX[k], z: this.nodeZ[k], y }));
    this._high = { key, list };
    return list;
  }

  /** Bytes held by the graph (the build budget is 2 MB on the big island). */
  bytes() {
    let b = this.flags.byteLength + this.cost.byteLength + this.house.byteLength + this.rep.byteLength + this.nodeX.byteLength * 2
      + this.ecost.byteLength + this.comp.byteLength + this.g.byteLength + this.parent.byteLength + this.seen.byteLength + this.closed.byteLength;
    for (const f of this.flows) b += f.dist.byteLength;
    for (const v of this.cache.values()) if (v) b += v.byteLength + 48;
    for (const v of this.vias.values()) b += v.byteLength + 64;
    for (const v of this.creach.values()) b += v.byteLength + 48;
    return b;
  }

  // ------------------------------------------------------------------ routes (waypoints)
  /**
   * Waypoints [x, y, z, node, ...] (node -1 for room / door points) from (ax, ay, az) to
   * (bx, by, bz): out of a building through its door, along the graph, in through the target
   * building's door and up its stairs. null when there is no way.
   */
  route(ax, ay, az, bx, by, bz, blocked = null, t = 0) {
    const ra = this.roomAt(ax, az), rb = this.roomAt(bx, bz);
    const pre = [], post = [];
    let sx = ax, sz = az, ex = bx, ez = bz;
    if (ra && ra === rb) {
      // same building: stairs between the two floors only
      this.roomLeg(ra, ay, by, bx, by, bz, pre);
      pre.push(bx, by, bz, ROOM);
      return pre;
    }
    if (ra) {
      const dr = nearestDoor(ra, ax, az);
      this.roomLeg(ra, ay, dr.y, dr.ix, dr.y, dr.iz, pre);
      pre.push(dr.ix, dr.y, dr.iz, ROOM, dr.ox, dr.y, dr.oz, ROOM);
      sx = dr.ox; sz = dr.oz;
    }
    if (rb) {
      const dr = nearestDoor(rb, bx, bz);
      post.push(dr.ox, dr.y, dr.oz, ROOM, dr.ix, dr.y, dr.iz, ROOM);
      this.roomLeg(rb, dr.y, by, bx, by, bz, post);
      ex = dr.ox; ez = dr.oz;
    }
    const out = pre;
    if (Math.hypot(ex - sx, ez - sz) > 6 && !this.lineWalkShort(sx, sz, ex, ez)) {
      const s = this.nodeAt(sx, sz, 3);
      let g = this.nodeAt(ex, ez, 3);
      // somewhere we can't get to (a plateau ringed by cliffs): as close as our side allows
      if (s >= 0 && g >= 0 && !this.canReach(s, g)) {
        if (rb) return null;
        g = this.nodeAt(ex, ez, 3, this.comp[s]);
      }
      let nodes = this.path(s, g, blocked, t);
      if (!nodes && !rb && s >= 0 && g >= 0 && this.comp[s] !== this.comp[g]) {
        const g2 = this.nodeAt(ex, ez, 6, this.comp[s]);
        if (g2 >= 0 && g2 !== g) nodes = this.path(s, g2, blocked, t);
      }
      if (!nodes) return null;
      this.nodePts(nodes, out);
    }
    for (let k = 0; k < post.length; k++) out.push(post[k]);
    if (!rb) out.push(bx, by, bz, ROOM);
    return out;
  }

  /**
   * Waypoints [x, y, z, code, ...] along a node path (with the corners of links that bend, and the
   * pad's own spot before a launch pad link: the pad node is only the block's most walkable cell).
   */
  nodePts(nodes, out = []) {
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      if (k > 0) {
        const pad = this.padOf(nodes[k - 1], n);
        if (pad) out.push(pad[0], pad[2], pad[1], PAD); // (with its height: a walker below it hops up)
        else {
          const via = this.viaOf(nodes[k - 1], n);
          if (via) for (const i of via) out.push(this.x0 + ((i % this.nx) + 0.5) * C, NaN, this.x0 + (((i / this.nx) | 0) + 0.5) * C, VIA - n);
        }
      }
      out.push(this.nodeX[n], NaN, this.nodeZ[n], n);
    }
    return out;
  }

  /** The pad [x, z] of a launch pad link u -> v, or null for a walk. */
  padOf(u, v) {
    const ex = this.extra.get(u);
    if (!ex) return null;
    for (const e of ex) if (e[0] === v && e.length > 3) return [e[2], e[3], e.length > 4 ? e[4] : NaN];
    return null;
  }

  lineWalkShort(ax, az, bx, bz) { return Math.hypot(bx - ax, bz - az) < 40 && this.lineWalk(ax, az, bx, bz); }

  /**
   * Stairs inside a building between the floors at heights y0 and y1 (toward the point tx, tz on
   * y1): pushes [x, y, z, -1] for each flight's foot and head.
   */
  roomLeg(r, y0, y1, tx, ty, tz, out) {
    const lv = r.levels;
    if (!lv || lv.length < 2 || !r.stairs.length) return;
    const level = (y) => { let k = 0; for (let i = 0; i < lv.length; i++) if (y >= lv[i] - 1.2) k = i; return k; };
    let a = level(y0), b = level(y1);
    if (a === b) return;
    const flights = [];
    const step = a < b ? 1 : -1;
    for (let k = a; k !== b; k += step) {
      const lo = Math.min(k, k + step), hi = lo + 1;
      // the flight from storey lo up to storey hi
      let best = null, bestD = Infinity;
      for (const s of r.stairs) {
        if (Math.abs(s[2] - lv[lo]) > 1.6 || Math.abs(s[5] - lv[hi]) > 1.6) continue;
        const d = Math.hypot(s[0] - tx, s[1] - tz);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) return;
      flights.push(step > 0 ? [best[0], best[2], best[1], best[3], best[5], best[4], best[6]] : [best[3], best[5], best[4], best[0], best[2], best[1], best[6]]);
    }
    // each flight: line up a step before its start, walk it end to end, then a step on. A flight
    // whose end is against a wall (stairs start 0.2 m from the back wall) is stepped on / off from
    // its open side instead (toward the middle of the building), half a metre along: the edge is
    // ~0.3 m high there, which the mover's autostep climbs.
    const [bx0, bz0, bx1, bz1] = r.bounds;
    const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
    const inside = (x, z) => x > bx0 + 0.75 && x < bx1 - 0.75 && z > bz0 + 0.75 && z < bz1 - 0.75;
    for (const f of flights) {
      const ux = f[3] - f[0], uz = f[5] - f[2], ul = Math.hypot(ux, uz) || 1;
      const nx = ux / ul, nz = uz / ul, k = (f[4] - f[1]) / ul;
      const hw = (f[6] || 1.7) / 2 + 0.9;
      // the open side: the perpendicular that points toward the building's middle
      let px = -nz, pz = nx;
      if ((cx - f[0]) * px + (cz - f[2]) * pz < 0) { px = -px; pz = -pz; }
      if (inside(f[0] - nx * 1.3, f[2] - nz * 1.3)) out.push(f[0] - nx * 1.3, f[1], f[2] - nz * 1.3, ROOM, f[0], f[1], f[2], STAIR);
      else {
        const sx = f[0] + nx * 0.5, sz = f[2] + nz * 0.5;
        out.push(sx + px * hw, f[1], sz + pz * hw, ROOM, sx, f[1] + k * 0.5, sz, STAIR);
      }
      if (inside(f[3] + nx * 1.2, f[5] + nz * 1.2)) out.push(f[3], f[4], f[5], STAIR, f[3] + nx * 1.2, f[4], f[5] + nz * 1.2, ROOM);
      else {
        const sx = f[3] - nx * 0.5, sz = f[5] - nz * 0.5;
        out.push(sx, f[4] - k * 0.5, sz, STAIR, sx + px * hw, f[4], sz + pz * hw, ROOM);
      }
    }
  }
}

function nearestDoor(r, x, z) {
  let best = r.doors[0], bestD = Infinity;
  for (const d of r.doors) {
    const dd = (d.x - x) ** 2 + (d.z - z) ** 2;
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}

// ------------------------------------------------------------------ following a route
/**
 * Follows routes for one walker (a bot): plans when the goal changes (rationed by nav.take), skips
 * waypoints it can walk straight past, and gives up on a link after STUCK_S without progress
 * (that link is avoided for BLOCK_S and the route is planned again; stuck twice in the same spot
 * and the whole node is avoided). step() returns
 *   1: steer toward (tx, ty, tz)   0: arrived   -1: no way there (pick another goal)
 */
export const STUCK_S = 3, BLOCK_S = 30;
export class PathFollower {
  constructor(nav) {
    this.nav = nav;
    this.pts = null;        // [x, y, z, code, ...] (code: see wpNode)
    this.i = 0;
    this.gx = NaN; this.gy = 0; this.gz = 0;
    this.plan = true;
    this.direct = false;
    this.retryT = 0;
    this.blocked = new Map();
    this.bestD = Infinity;
    this.progT = 0;
    this.stuckN = 0;
    this.stuckX = NaN; this.stuckZ = 0; this.stuckT = -99;
    this.lastT = -1;
    this.smoothT = 0;
    this.tx = 0; this.ty = 0; this.tz = 0;
    this.pad = false;       // the current link is a launch pad throw
    this.replans = 0;
    this.flowKey = '';
    this.flowGx = NaN; this.flowGz = NaN;
    this.flowOff = 0;
  }

  reset() {
    this.pts = null; this.i = 0; this.gx = NaN; this.plan = true; this.direct = false; this.retryT = 0;
    this.bestD = Infinity; this.progT = 0; this.stuckN = 0; this.pad = false; this.flowKey = '';
  }

  /** Where to go. A goal that moved more than `slack` metres is planned again. */
  goal(x, y, z, slack = 6) {
    const dx = x - this.gx, dz = z - this.gz;
    if (!(dx * dx + dz * dz <= slack * slack) || Math.abs(y - this.gy) > 3) {
      this.gx = x; this.gy = y; this.gz = z;
      this.plan = true; this.stuckN = 0; this.retryT = 0; this.flowKey = '';
    }
  }

  /** The route has been planned and is being walked (not just heading straight at the goal). */
  get routed() { return !!this.pts && !this.direct; }

  /**
   * Rotating into the storm's next circle: follow the shared flow field (no A* query) to the spot
   * (x, y, z) inside it. After getting stuck on the way, routes are planned (A*) for a while.
   */
  useFlow(f, px, pz, x, y, z, t) {
    if (this.flowKey === f.key && this.flowGx === x && this.flowGz === z) return;
    this.flowKey = f.key; this.flowGx = x; this.flowGz = z;
    if (t < this.flowOff) { this.goal(x, y, z); return; }
    const nav = this.nav;
    const nodes = nav.flowPath(f, nav.nodeAt(px, pz, 3));
    if (!nodes || nodes.length < 2) { this.goal(x, y, z); return; }
    this.gx = x; this.gy = y; this.gz = z;
    this.pts = nav.nodePts(nodes);
    this.i = 1;
    this.plan = false; this.direct = false; this.stuckN = 0;
    this.bestD = Infinity; this.progT = 0;
  }

  /** Seconds without progress on the current link (0..STUCK_S). */
  get stalled() { return this.progT; }

  /** Heading for a door or a flight of stairs (walk it exactly: no swerving round obstacles). */
  get precise() {
    if (!this.pts || this.i >= this.pts.length >> 2) return false;
    const c = this.pts[this.i * 4 + 3];
    return c === STAIR || c === PAD || (c === ROOM && this.i < (this.pts.length >> 2) - 1);
  }

  step(px, py, pz, t, dt) {
    const nav = this.nav;
    if (t - this.lastT > 0.5) { this.bestD = Infinity; this.progT = 0; }
    this.lastT = t;
    const gdx = this.gx - px, gdz = this.gz - pz;
    const gd = Math.sqrt(gdx * gdx + gdz * gdz);
    if (gd < 1.3 && Math.abs(this.gy - py) < 2.2) return 0;
    if (this.plan && t >= this.retryT) {
      if (this.makePlan(px, py, pz, gd, t) < 0) return -1;
    }
    this.pad = false;
    if (!this.pts) {
      this.tx = this.gx; this.ty = this.gy; this.tz = this.gz;
      this.progress(gd, t, dt, px, pz);
      return 1;
    }
    const P = this.pts;
    const n = P.length >> 2;
    // reached the waypoint (or walked past it)?
    for (;;) {
      if (this.i >= n) { this.tx = this.gx; this.ty = this.gy; this.tz = this.gz; this.progress(gd, t, dt, px, pz); return 1; }
      const j = this.i * 4;
      const wx = P[j] - px, wz = P[j + 2] - pz, wy = P[j + 1];
      const d2 = wx * wx + wz * wz;
      const code = P[j + 3];
      const near = code >= 0 ? 2.6 : code <= VIA ? 1.6 : code === STAIR ? 0.7 : code === PAD ? 0.9 : 1.4;
      if (d2 < near * near && (!(wy === wy) || Math.abs(wy - py) < (code === STAIR ? 1.2 : 2.4))) { this.next(); continue; }
      break;
    }
    // walk straight past waypoints that are in plain reach (graph points outside buildings)
    if ((this.smoothT -= dt) <= 0 && nav.ready) {
      this.smoothT = 0.4;
      while (this.i + 1 < n) {
        const j = (this.i + 1) * 4;
        const a = wpNode(P[this.i * 4 + 3]), b = wpNode(P[j + 3]);
        if (a < 0 || b < 0) break;
        const dx = P[j] - px, dz = P[j + 2] - pz;
        if (dx * dx + dz * dz > 48 * 48 || nav.isPad(a, b) || !nav.lineWalk(px, pz, P[j], P[j + 2])) break;
        this.next();
      }
    }
    const j = this.i * 4;
    this.tx = P[j]; this.ty = P[j + 1] === P[j + 1] ? P[j + 1] : py; this.tz = P[j + 2];
    // on a pad link (walking onto the pad, or thrown toward its far end): no sprinting
    if (P[j + 3] === PAD) this.pad = true;
    else if (this.i > 0 && P[j + 3] >= 0) {
      let u = -1;
      for (let k = this.i - 1; k >= 0 && u < 0; k--) u = wpNode(P[k * 4 + 3]);
      this.pad = u >= 0 && nav.isPad(u, P[j + 3]);
    }
    this.progress(Math.hypot(this.tx - px, this.tz - pz), t, dt, px, pz);
    return 1;
  }

  /** Progress toward the current waypoint (distance d); STUCK_S without any gives up on the link. */
  progress(d, t, dt, px, pz) {
    if (d < this.bestD - 1) { this.bestD = d; this.progT = 0; return; }
    if ((this.progT += dt) > STUCK_S) this.stuck(t, px, pz);
  }

  next() { this.i++; this.bestD = Infinity; this.progT = 0; }

  /** No progress on this link for STUCK_S: avoid it for a while and plan again. */
  stuck(t, px, pz) {
    const nav = this.nav, nn = nav.nn, P = this.pts;
    const again = t - this.stuckT < BLOCK_S && (px - this.stuckX) ** 2 + (pz - this.stuckZ) ** 2 < 400;
    this.stuckT = t; this.stuckX = px; this.stuckZ = pz;
    let v = -1, u = -1;
    if (P && this.i < P.length >> 2) {
      // stuck on the way onto a pad: the link to blame is the pad's (to the node after it)
      const k0 = P[this.i * 4 + 3] === PAD && this.i + 1 < P.length >> 2 ? this.i + 1 : this.i;
      v = wpNode(P[k0 * 4 + 3]);
      for (let k = this.i - 1; k >= 0 && u < 0; k--) { const w = wpNode(P[k * 4 + 3]); if (w >= 0 && w !== v) u = w; }
    }
    if (v >= 0 && u >= 0) {
      this.blocked.set(u * nn + v, t + BLOCK_S);
      this.blocked.set(v * nn + u, t + BLOCK_S);
      if (nav.isPad(u, v)) nav.padsOff(u); // stood on a pad and nothing threw us: that pad is off for a while
    }
    // stuck here again (or with no link to blame): stay off the node we can't reach
    if (again || u < 0) {
      const w = v >= 0 ? v : nav.nodeAt(px, pz, 1);
      if (w >= 0) {
        for (let d = 0; d < 8; d++) {
          const x = w + DZ[d] * nav.cnx + DX[d];
          if (x >= 0 && x < nn) { this.blocked.set(x * nn + w, t + BLOCK_S); this.blocked.set(w * nn + x, t + BLOCK_S); }
        }
      }
    }
    this.stuckN++;
    this.plan = true;
    this.retryT = 0;
    if (this.flowKey) { this.flowKey = ''; this.flowOff = t + 10; } // the flow field led us here: plan around it
    this.bestD = Infinity; this.progT = 0;
    for (const [k, until] of this.blocked) if (until <= t) this.blocked.delete(k);
  }

  makePlan(px, py, pz, gd, t) {
    const nav = this.nav;
    this.plan = false;
    this.i = 0;
    this.bestD = Infinity; this.progT = 0;
    // stuck again and again (or right next to a goal we can't get at): give up on it
    if (this.stuckN > 4 || (this.stuckN >= 2 && gd < 8)) { this.pts = null; return -1; }
    // close by in plain reach, or no graph yet: straight there
    if (!nav.ready || (gd < 32 && !this.stuckN && !nav.roomAt(px, pz) && !nav.roomAt(this.gx, this.gz) && nav.lineWalk(px, pz, this.gx, this.gz))) {
      this.pts = null; this.direct = true;
      if (!nav.ready) { this.plan = true; this.retryT = t + 1; }
      return 1;
    }
    if (!nav.take(t)) {
      // no query to spare this moment: head straight there and ask again shortly
      this.pts = null; this.direct = true; this.plan = true; this.retryT = t + 0.25 + Math.random() * 0.5;
      return 1;
    }
    this.replans++;
    const pts = nav.route(px, py, pz, this.gx, this.gy, this.gz, this.blocked, t);
    if (!pts) { this.pts = null; this.direct = false; return -1; }
    this.pts = pts; this.direct = false;
    // the first graph point is often just behind us
    if ((pts.length >> 2) > 1 && pts[3] >= 0) {
      const dx = pts[0] - px, dz = pts[2] - pz, ex = pts[4] - px, ez = pts[6] - pz;
      if (dx * ex + dz * ez < 0 || dx * dx + dz * dz > ex * ex + ez * ez) this.i = 1;
    }
    return 1;
  }
}
