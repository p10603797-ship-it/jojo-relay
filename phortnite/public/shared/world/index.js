// generateWorld: the biome island pipeline (the output is documented at the top of
// shared/worldgen.js). Every stage stamps its features over their own bounding boxes and uses
// spatial hashes, so the cost grows with the map's area, not with area x features.
//
//  1 biome field + base heights (biomes.js, heights.js)
//  2 places: positions, pads, plans (pois.js); the lake, the river, ponds
//  3 town streets and the roads between places (roads.js), bridges
//  4 buildings on the plots (buildings.js), piers, the pirate ship, lone houses along the roads
//  5 props and decor (props.js), trees / rocks / pads / lava (scatter.js)
//  6 surfaces, loot and chests, spatial indexes, spawn points, checksum
import { MAP } from './scale.js';
import { BIOMES, SURFACES } from './keys.js';
import { mulberry32, smoothstep, clamp } from '../rng.js';
import { layoutFor } from './layout.js';
import { makeGrid, OCC, BoxHash, makeSolidNear, makeObjectsNear, makeChunkIndex, markOcc, occBlocked } from './grid.js';
import { biomeField, classifyCoast, surfaceGrid, BI } from './biomes.js';
import { baseHeights, stampLake, stampRiver, rangeRect } from './heights.js';
import { placePlaces, flattenPlaces, planPlace, stampPond, DIRS16, snapC, rotToward } from './pois.js';
import { roadEdges, makeRoadGrid, routeRoad, shapeRoad, stampRoad, applyPads, trimToStreets } from './roads.js';
import { emitBuilding, ARCHETYPES, YAWS } from './buildings.js';
import { placeProps } from './props.js';
import { scatter, padsAndLava } from './scatter.js';

export const WORLD_VERSION = 2;

export function generateWorld(seed = MAP.seed, opts = {}) {
  const size = opts.size || MAP.size;
  const res = size === MAP.size ? MAP.res : Math.round(size / 4);
  const R = size === MAP.size ? MAP.islandRadius : size * 0.4;
  const G = makeGrid(seed, size, res, R);
  const L = layoutFor(size);
  const { N } = G;
  const T = opts.timings;
  let tLap = T ? performance.now() : 0;
  const lap = T ? (name) => { const t = performance.now(); T[name] = (T[name] || 0) + t - tLap; tLap = t; } : () => {};
  const rPlan = mulberry32(seed ^ 0x51ed);
  const rBuild = mulberry32(seed ^ 0xb11d);

  // ---------------------------------------------------------------- 1 terrain
  biomeField(G, L);
  baseHeights(G, L);
  lap('terrain');

  // ---------------------------------------------------------------- 2 places, water
  const regions = placePlaces(G, L);
  flattenPlaces(G, regions);
  stampLake(G, L.lake);
  stampRiver(G, L.river);
  const plans = regions.map((g) => planPlace(G, g, rPlan, regions));
  plans.forEach((p) => { for (const pr of p.props) if (pr.type === 'pond') stampPond(G, pr.x, pr.z, pr.r); });
  classifyCoast(G);
  lap('places');

  // ---------------------------------------------------------------- 3 streets and roads
  const padW = new Float32Array(N * N), padY = new Float32Array(N * N);
  const roads = [];
  plans.forEach((p, pi) => {
    for (const s of p.streets) {
      const pts = densify(G, [[s.x0, s.z0], [s.x1, s.z1]], 8);
      for (const q of pts) q[2] = Math.max(regions[pi].y, 1.6) * 0.6 + q[2] * 0.4;
      stampRoad(G, pts, s.w, s.kind !== 'dirt', padW, padY);
      roads.push({ kind: s.kind === 'dirt' ? 'dirt' : 'street', w: s.w, bridge: false, pts, region: pi });
    }
    for (const pk of p.parking) {
      const y = regions[pi].y;
      const pts = pk.hx >= pk.hz ? [[pk.x - pk.hx + pk.hz, pk.z, y], [pk.x + pk.hx - pk.hz, pk.z, y]] : [[pk.x, pk.z - pk.hz + pk.hx, y], [pk.x, pk.z + pk.hz - pk.hx, y]];
      stampRoad(G, pts, 2 * Math.min(pk.hx, pk.hz), true, padW, padY);
    }
  });
  applyPads(G, padW, padY);
  // reserve the landmark plots so no road runs through them
  for (const p of plans) for (const pl of p.plots) {
    if (!pl.must) continue;
    const hx = (pl.rot % 2 ? pl.d : pl.w) / 2, hz = (pl.rot % 2 ? pl.w : pl.d) / 2;
    markOcc(G, pl.x, pl.z, hx + 6, hz + 6, OCC.KEEP, true);
  }
  lap('streets');
  const RG = makeRoadGrid(G, regions, plans, L);
  const major = (g) => g.kind === 'city' || g.kind === 'town' || ['gas', 'stadium', 'motel'].includes(g.recipe);
  const bridges = [];
  // roads join a town at the end of one of its streets (its gates), outposts at their middle
  const gates = plans.map((p, i) => {
    if (p.streets.length) return p.streets.flatMap((s) => [[s.x0, s.z0], [s.x1, s.z1]]);
    const g = regions[i], d = (p.hubCore || 0) + 12;
    const out = [[g.x + d, g.z], [g.x - d, g.z], [g.x, g.z + d], [g.x, g.z - d]].filter(([x, z]) => G.heightAt(x, z) > 1.2);
    return out.length ? out : [p.hub];
  });
  for (const [a, b] of roadEdges(regions, plans, L.links)) {
    let A = null, B = null, best = Infinity;
    for (const ga of gates[a]) for (const gb of gates[b]) {
      const d = (ga[0] - gb[0]) * (ga[0] - gb[0]) + (ga[1] - gb[1]) * (ga[1] - gb[1]);
      if (d < best) { best = d; A = ga; B = gb; }
    }
    let path = routeRoad(RG, A[0], A[1], B[0], B[1], new Set([a, b]));
    if (!path) continue;
    path = trimToStreets(RG, path, a, b);
    path = trimCore(path, regions[a], plans[a].hubCore, false);
    path = trimCore(path, regions[b], plans[b].hubCore, true);
    if (path.length < 2) continue;
    const paved = major(regions[a]) && major(regions[b]);
    const w = paved ? 8 : 5;
    for (const piece of shapeRoad(G, path)) {
      if (piece.bridge) bridges.push({ piece, w });
      else stampRoad(G, piece.pts, w, paved, padW, padY);
      roads.push({ kind: paved ? 'road' : 'dirt', w, bridge: piece.bridge, pts: piece.pts, from: a, to: b });
    }
  }
  applyPads(G, padW, padY);
  lap('roads');
  // water and coast in the occupancy grid
  for (let i = 0; i < N * N; i++) if (G.heights[i] < 0.9 && G.occ[i] === OCC.FREE) G.occ[i] = OCC.WATER;

  // ---------------------------------------------------------------- 4 buildings
  const W = {
    objects: [], houses: [], lootCand: [], chestCand: [],
    add(o) { o.id = this.objects.length; this.objects.push(o); return o; },
  };
  const boxes = new BoxHash(32);
  const placed = [];
  const BLOCK = (1 << OCC.ROAD) | (1 << OCC.WATER) | (1 << OCC.BUILDING) | (1 << OCC.FIELD) | (1 << OCC.PLAZA);
  const dbg = opts.debug;
  const no = (why, pl, ri) => {
    if (dbg) { const k = `${ri >= 0 ? regions[ri].name : '-'}|${pl.arch}|${why}`; dbg[k] = (dbg[k] || 0) + 1; (dbg.list || (dbg.list = [])).push([ri, pl.arch, why, pl.x, pl.z, pl.rot]); }
    return false;
  };
  const tryPlot = (pl, ri, extra = {}) => {
    const hx = (pl.rot % 2 ? pl.d : pl.w) / 2, hz = (pl.rot % 2 ? pl.w : pl.d) / 2;
    const x = pl.x, z = pl.z;
    if (Math.abs(x) > G.half - hx - 8 || Math.abs(z) > G.half - hz - 8) return no('edge', pl, ri);
    if (boxes.hits(x - hx, z - hz, x + hx, z + hz, extra.margin ?? 3.9)) return no('overlap', pl, ri);
    if (!extra.waterOk) { const ob = occBlocked(G, x, z, hx, hz, BLOCK); if (ob) return no('occ' + (ob - 1), pl, ri); }
    const rg = rangeRect(G, x, z, hx, hz);
    if (!extra.waterOk && rg.min < 1.0) return no('low', pl, ri);
    if (!extra.waterOk && rg.max - rg.min > (extra.range ?? 7)) return no('steep', pl, ri);
    const base = extra.base ?? Math.max(1.5, (rg.min + rg.max) / 2);
    boxes.add({ x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz });
    markOcc(G, x, z, hx + 1, hz + 1, OCC.BUILDING);
    placed.push({ ...pl, hx, hz, base, ri, lift: extra.lift, waterOk: extra.waterOk });
    return true;
  };
  // bridges first (they must sit where the roads cross water)
  for (const { piece, w } of bridges) {
    const [[ax, az, y], [bx, bz]] = piece.pts;
    const alongZ = Math.abs(bz - az) > Math.abs(bx - ax);
    const len = Math.abs(alongZ ? bz - az : bx - ax) + 8;
    const pl = { arch: 'bridge', x: (ax + bx) / 2, z: (az + bz) / 2, rot: alongZ ? 0 : 1, w: w + 2, d: len, floors: 1, opts: {} };
    if (tryPlot(pl, -1, { waterOk: true, base: y, lift: 0, margin: 1 })) piece.house = placed.length - 1;
  }
  // every place's landmark ("must") plots first, then the rest
  for (const pass of [true, false]) {
    plans.forEach((p, ri) => {
      for (const pl of p.plots) {
        if (pl.must !== pass) continue;
        if (tryPlot(pl, ri, { range: pl.must ? 12 : 7 }) || !pl.alts) continue;
        for (const [x, z, rot] of pl.alts) if (tryPlot({ ...pl, x, z, rot }, ri, { range: 8 })) break;
      }
    });
  }
  // fields and plazas keep their ground clear
  plans.forEach((p) => {
    for (const f of p.fields) markOcc(G, f.x, f.z, f.hx, f.hz, OCC.FIELD, true);
    for (const pz of p.plazas) markOcc(G, pz.x, pz.z, pz.hx, pz.hz, OCC.PLAZA, true);
  });
  // coast: piers and the pirate ship; the lake: island house, piers, boathouses
  plans.forEach((p, ri) => {
    const g = regions[ri];
    if (p.piers) for (let k = 0; k < p.piers; k++) placePier(G, g, k, tryPlot, p.ship && k === 0);
    if (p.lake) placeLake(G, L.lake, ri, tryPlot);
  });
  // lone houses along the roads, until the island has its 280 or so buildings
  loneHouses(G, roads, regions, placed, tryPlot, rPlan, 285);
  lap('plots');
  // building pads, then emit
  for (const pl of placed) if (!pl.waterOk) padRect(G, pl.x, pl.z, pl.hx, pl.hz, pl.base - 0.05, padW, padY);
  applyPads(G, padW, padY);
  for (const pl of placed) {
    const g = regions[pl.ri];
    emitBuilding(W, pl.arch, {
      ...pl.opts, x: pl.x, z: pl.z, rot: pl.rot, w: pl.w, d: pl.d, floors: pl.floors, base: pl.base, lift: pl.lift,
      region: pl.ri, tier: g ? g.tier : 'quiet', rng: rBuild,
    });
  }
  for (const r of roads) if (r.bridge && r.house === undefined) {
    const h = W.houses.find((hh) => hh.archetype === 'bridge' && Math.abs(hh.x - (r.pts[0][0] + r.pts[1][0]) / 2) < 0.1 && Math.abs(hh.z - (r.pts[0][1] + r.pts[1][1]) / 2) < 0.1);
    r.house = h ? h.id : -1;
  }

  lap('buildings');
  // ---------------------------------------------------------------- 5 props, decor, vegetation
  const barrels = [];
  placeProps(G, W, regions, plans, roads, barrels, mulberry32(seed ^ 0x9a0b));
  const pads = [], lava = [];
  lap('props');
  padsAndLava(G, L, W, regions, pads, lava, mulberry32(seed ^ 0x7ad5));
  scatter(G, L, W, regions, mulberry32(seed ^ 0x5ca7));

  lap('scatter');
  // ---------------------------------------------------------------- 6 surfaces, indexes, loot
  const surface = surfaceGrid(G, L, plans, lava);
  lap('surface');
  const { objects, houses } = W;
  const solidNear = makeSolidNear(objects);
  const objectsNear = makeObjectsNear(objects);
  const chunks = makeChunkIndex(objects, size);
  lap('indexes');
  const { chests, lootSpots } = finalizeLoot(G, W, regions, solidNear, mulberry32(seed ^ 0x100f));

  for (const g of regions) { g.y = G.heightAt(g.x, g.z); delete g.axis; }
  const pois = regions.map((g) => ({ name: g.name, x: g.x, z: g.z, y: g.y, r: g.r, type: g.kind }));
  const spawnPoints = makeSpawnPoints(G, regions, solidNear, mulberry32(seed ^ 0x5b0a));
  // warm-up spots: open ground around the most central place
  const center = regions.slice().sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z))[0];
  const spawns = [];
  const rs = mulberry32(seed ^ 0x3a7);
  for (let t = 0; t < 800 && spawns.length < 24; t++) {
    const x = center.x + (rs() - 0.5) * 100, z = center.z + (rs() - 0.5) * 100;
    const y = G.heightAt(x, z);
    if (y < 2 || solidNear(x, y + 0.9, z, null, 1.2)) continue;
    spawns.push({ x, z });
  }
  const rv = L.river;
  const rivers = [{ pts: rv.pts.map(([x, z]) => [x, z]), w0: rv.w0, w1: rv.w1, w: (rv.w0 + rv.w1) / 2, bed: rv.bed }];
  const lk = L.lake;
  const lakes = [{ x: lk.x, z: lk.z, r: lk.r, y: lk.bed, island: { x: lk.x, z: lk.z, r: lk.island } }];

  lap('loot+spawns');
  const checksum = makeChecksum(G, objects, chests, lootSpots, regions, roads, pads, lava, surface);
  lap('checksum');
  const biome = G.biome;
  const at = G.at;
  return {
    seed, size, res, cell: G.cell, half: G.half, N, heights: G.heights, heightAt: G.heightAt,
    pois, houses, objects, chests, lootSpots, barrels, spawns, solidNear,
    mountain: { x: L.peak.x, z: L.peak.z }, checksum,
    version: WORLD_VERSION, regions, biome, biome2: G.biome2, blend: G.blend, surface,
    biomeAt: (x, z) => BIOMES[biome[at(x, z)]],
    surfaceKeyAt: (x, z) => SURFACES[surface[at(x, z)]],
    regionAt: makeRegionAt(regions),
    roads, rivers, lakes, pads, lava, roadMask: G.road,
    spawnPoints, objectsNear, chunks, islandRadius: R,
  };
}

// ------------------------------------------------------------------ helpers
/** Points every `step` metres along a polyline, with terrain heights: [[x, z, y], ...]. */
function densify(G, pts, step) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const dx = bx - ax, dz = bz - az, L = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) {
      const x = ax + dx * k / n, z = az + dz * k / n;
      out.push([x, z, G.heightAt(x, z)]);
    }
  }
  const [x, z] = pts[pts.length - 1];
  out.push([x, z, G.heightAt(x, z)]);
  return out;
}

/** Drop the path nodes inside a place's core (outposts end their road at the core's edge). */
function trimCore(path, g, core, atEnd) {
  if (!core) return path;
  const inside = (p) => (p[0] - g.x) * (p[0] - g.x) + (p[1] - g.z) * (p[1] - g.z) < core * core;
  if (atEnd) { let n = path.length; while (n > 1 && inside(path[n - 1])) n--; return path.slice(0, n); }
  let s = 0;
  while (s < path.length - 1 && inside(path[s])) s++;
  return path.slice(s);
}

/** A building pad: flat inside the footprint + 2.5 m, easing back to the terrain over 9 m (max weight wins). */
function padRect(G, cx, cz, hx, hz, y, padW, padY) {
  const { N, cell, half, road } = G;
  const inner = 2.5, edge = 9;
  const ix0 = clamp(Math.floor((cx - hx - edge + half) / cell), 0, N - 1), ix1 = clamp(Math.ceil((cx + hx + edge + half) / cell), 0, N - 1);
  const iz0 = clamp(Math.floor((cz - hz - edge + half) / cell), 0, N - 1), iz1 = clamp(Math.ceil((cz + hz + edge + half) / cell), 0, N - 1);
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = -half + iz * cell, dz = Math.max(Math.abs(z - cz) - hz, 0);
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * cell, dx = Math.max(Math.abs(x - cx) - hx, 0);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= edge) continue;
      const i = iz * N + ix;
      if (road[i] && d > 0.5) continue;
      if (G.inland[i] && G.heights[i] < 0) continue;
      const w = d <= inner ? 1 : smoothstep(edge, inner, d);
      if (w > padW[i]) { padW[i] = w; padY[i] = y; }
    }
  }
}

/** A pier from a coastal place out into the sea (and the pirate ship beside the first one). */
function placePier(G, g, k, tryPlot, ship) {
  let best = null;
  for (let t = 0; t < 16 && !best; t++) {
    const di = (t * 4 + k * 4) % 16;  // the 4 axis directions first, rotating with k
    const [dx, dz] = DIRS16[di];
    if (Math.abs(dx) > 0.01 && Math.abs(dz) > 0.01) continue;
    for (let s = g.r * 0.3; s < g.r * 2.4; s += 4) {
      const h = G.heightAt(g.x + dx * s, g.z + dz * s);
      if (h < 0.4) { best = [Math.round(dx), Math.round(dz), s]; break; }
    }
  }
  if (!best) return;
  const [ux, uz, s] = best;
  const len = 24;
  const rot = uz !== 0 ? (uz > 0 ? 0 : 2) : (ux > 0 ? 1 : 3);
  const side = ship ? 0 : (k % 2 ? 1 : -1) * 10;
  const sx = g.x + ux * (s + len / 2 - 6) + (uz !== 0 ? side : 0), sz = g.z + uz * (s + len / 2 - 6) + (ux !== 0 ? side : 0);
  tryPlot({ arch: 'pier', x: snapC(sx, rot % 2 ? len : 4), z: snapC(sz, rot % 2 ? 4 : len), rot, w: 4, d: len, floors: 1, opts: {} }, g.id, { waterOk: true, base: 1.3, lift: 0, margin: 2 });
  if (ship) {
    // the pirate ship moored beside the pier, its deck 2.8 m above the water
    const off = 10;
    const shx = sx + (uz !== 0 ? off : ux * 6), shz = sz + (ux !== 0 ? off : uz * 6);
    tryPlot({ arch: 'ship', x: snapC(shx, rot % 2 ? 28 : 10), z: snapC(shz, rot % 2 ? 10 : 28), rot, w: 10, d: 28, floors: 2, opts: { must: true } }, g.id, { waterOk: true, base: -2, lift: 4.8, margin: 1 });
  }
}

/** Splashy Lake: a house on the island, piers and boathouses on the shore. */
function placeLake(G, lake, ri, tryPlot) {
  const y = G.heightAt(lake.x, lake.z);
  tryPlot({ arch: 'house', x: snapC(lake.x, 8), z: snapC(lake.z, 8), rot: 0, w: 8, d: 8, floors: 2, opts: { must: true } }, ri, { waterOk: true, base: Math.max(y, 2.2), margin: 1 });
  for (const [dx, dz, rot] of [[1, 0, 3], [-1, 0, 1], [0, 1, 2], [0, -1, 0]]) {
    const sx = lake.x + dx * (lake.r + 18), sz = lake.z + dz * (lake.r + 18);
    tryPlot({ arch: 'shack', x: snapC(sx, 8), z: snapC(sz, 8), rot, w: 8, d: 8, floors: 1, opts: {} }, ri, { range: 9 });
    const pxx = lake.x + dx * (lake.r - 4), pzz = lake.z + dz * (lake.r - 4);
    const prot = dz ? 0 : 1;
    tryPlot({ arch: 'pier', x: snapC(pxx, prot ? 20 : 4), z: snapC(pzz, prot ? 4 : 20), rot: prot, w: 4, d: 20, floors: 1, opts: {} }, ri, { waterOk: true, base: 1.3, lift: 0, margin: 2 });
  }
}

/** Biome-appropriate lone buildings beside the roads between places, then out in the countryside. */
function loneHouses(G, roads, regions, placed, tryPlot, rng, target) {
  const byBiome = {
    [BI.snow]: [['cabin', 3], ['lodge', 1]], [BI.desert]: [['adobe', 3], ['shed', 1]], [BI.mesa]: [['adobe', 3], ['watchtower', 1]],
    [BI.jungle]: [['stilt', 2], ['shack', 1], ['treehouse', 1]], [BI.swamp]: [['stilt', 3], ['shack', 1]], [BI.volcano]: [['shed', 2], ['watchtower', 1]],
    [BI.farm]: [['house', 2], ['barn', 1], ['silo', 1]], [BI.forest]: [['cabin', 3], ['house', 1]], [BI.city]: [['house', 2], ['shop', 1]],
    [BI.meadow]: [['house', 3], ['cabin', 1]], [BI.beach]: [['shack', 2], ['house', 1]],
  };
  const pick = (t) => { let s = 0; for (const [, w] of t) s += w; let r = rng() * s; for (const [v, w] of t) { r -= w; if (r <= 0) return v; } return t[0][0]; };
  const nearPlace = (x, z, pad) => regions.some((g) => (g.x - x) * (g.x - x) + (g.z - z) * (g.z - z) < (g.r + pad) * (g.r + pad));
  const build = (x, z, rot, faceX, faceZ) => {
    const table = byBiome[G.biome[G.at(x, z)]] || byBiome[BI.meadow];
    const arch = pick(table);
    const A = ARCHETYPES[arch];
    const [w, d] = A.size(rng);
    const r = rot ?? rotToward(faceX, faceZ);
    const hx = (r % 2 ? d : w) / 2, hz = (r % 2 ? w : d) / 2;
    return tryPlot({ arch, x: snapC(x, hx * 2), z: snapC(z, hz * 2), rot: r, w, d, floors: A.floors(rng), opts: {} }, -1, { range: 8 });
  };
  // beside the roads: every 40 m, alternating sides, set back from the road edge
  let side = 1;
  for (const rd of roads) {
    if (rd.bridge || rd.kind === 'street') continue;
    let acc = 0;
    for (let s = 0; s < rd.pts.length - 1 && placed.length < target; s++) {
      const [ax, az] = rd.pts[s], [bx, bz] = rd.pts[s + 1];
      const dx = bx - ax, dz = bz - az, L = Math.sqrt(dx * dx + dz * dz);
      acc += L;
      if (acc < 40 || L < 1) continue;
      acc = 0;
      side = -side;
      const nx = -dz / L * side, nz = dx / L * side;
      const off = rd.w / 2 + 12;
      const x = ax + nx * off, z = az + nz * off;
      if (nearPlace(x, z, 6) || G.heightAt(x, z) < 2) continue;
      build(x, z, null, -nx, -nz);
    }
  }
  // out in the countryside: a coarse grid of candidate spots on open, gentle ground
  for (let gz = -G.half + 40; gz < G.half - 40 && placed.length < target; gz += 72) {
    for (let gx = -G.half + 40; gx < G.half - 40 && placed.length < target; gx += 72) {
      const x = gx + (rng() - 0.5) * 40, z = gz + (rng() - 0.5) * 40;
      if (Math.sqrt(x * x + z * z) > G.R * 0.92 || nearPlace(x, z, 20) || G.heightAt(x, z) < 3 || G.slope(x, z) > 1.5) continue;
      build(x, z, Math.floor(rng() * 4));
    }
  }
}

/** Validate loot / chest candidates (on land, nothing solid at y + 0.5) and top up outdoors. */
function finalizeLoot(G, W, regions, solidNear, rng) {
  const lootSpots = [], chests = [];
  const ok = (p) => G.heightAt(p.x, p.z) > 0.3 && p.y > G.heightAt(p.x, p.z) - 0.3 && !solidNear(p.x, p.y + 0.5, p.z) && p.y > 0.4;
  const near = (list, p, r) => list.some((q) => (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z) + (q.y - p.y) * (q.y - p.y) < r * r);
  for (const c of W.chestCand) {
    if (!ok(c) || near(chests, c, 4)) continue;
    chests.push({ x: c.x, y: c.y, z: c.z, yaw: c.yaw, tier: c.tier });
  }
  for (const l of W.lootCand) {
    if (!ok(l) || near(chests, l, 1.4)) continue;
    lootSpots.push({ x: l.x, y: l.y, z: l.z, tier: l.tier });
  }
  const tierOf = (x, z) => {
    let t = 'quiet', bestD = Infinity;
    for (const g of regions) {
      const d = Math.sqrt((g.x - x) * (g.x - x) + (g.z - z) * (g.z - z));
      if (d < g.r * 1.2 && d < bestD) { bestD = d; t = g.tier; }
    }
    return t;
  };
  const free = (x, y, z) => !solidNear(x, y + 0.5, z, null, 0.6) && !solidNear(x, y + 1.4, z, null, 0.4);
  // ground loot around every place (more in hot places), then across the island
  for (const g of regions) {
    const n = g.tier === 'hot' ? 6 : g.tier === 'normal' ? 4 : 2;
    for (let t = 0, got = 0; t < n * 6 && got < n; t++) {
      const [dx, dz] = DIRS16[Math.floor(rng() * 16)];
      const s = g.r * (0.2 + rng() * 0.9);
      const x = g.x + dx * s, z = g.z + dz * s, y = G.heightAt(x, z);
      if (y < 1.2 || G.slope(x, z) > 2.5 || !free(x, y, z)) continue;
      lootSpots.push({ x, y, z, ground: true, tier: g.tier });
      got++;
    }
  }
  const half = G.half;
  for (let t = 0; t < 4000 && lootSpots.length < 960; t++) {
    const x = (rng() - 0.5) * 2 * half * 0.85, z = (rng() - 0.5) * 2 * half * 0.85, y = G.heightAt(x, z);
    if (y < 1.5 || G.slope(x, z) > 2.5 || !free(x, y, z)) continue;
    lootSpots.push({ x, y, z, ground: true, tier: tierOf(x, z) });
  }
  for (let t = 0; t < 3000 && chests.length < 290; t++) {
    const x = (rng() - 0.5) * 2 * half * 0.8, z = (rng() - 0.5) * 2 * half * 0.8, y = G.heightAt(x, z);
    if (y < 2 || G.slope(x, z) > 1.8 || !free(x, y, z) || near(chests, { x, y, z }, 30)) continue;
    chests.push({ x, y, z, yaw: YAWS[Math.floor(rng() * 4)], tier: tierOf(x, z) });
  }
  return { chests, lootSpots };
}

/** Open ground on rings around every place (at least 8 per named place) plus a scatter across the island. */
function makeSpawnPoints(G, regions, solidNear, rng) {
  const out = [];
  const good = (x, z) => {
    const y = G.heightAt(x, z);
    if (y < 1.5 || G.slope(x, z) > 2.4) return -1;
    if (solidNear(x, y + 0.9, z, null, 0.6) || solidNear(x, y + 0.3, z, null, 0.6)) return -1;
    return y;
  };
  for (const g of regions) {
    let n = 0;
    for (const [k, odd] of [[0.55, 0], [0.95, 1], [1.35, 0], [1.75, 1], [2.2, 0], [2.7, 1]]) {
      for (let i = odd; i < 16; i += 2) {
        const x = g.x + DIRS16[i][0] * g.r * k, z = g.z + DIRS16[i][1] * g.r * k;
        const y = good(x, z);
        if (y < 0) continue;
        out.push({ x, y, z, region: g.id });
        n++;
      }
      if (n >= 16) break;
    }
  }
  const half = G.half;
  for (let gz = -half + 20; gz < half; gz += 48) {
    for (let gx = -half + 20; gx < half; gx += 48) {
      const x = gx + rng() * 24, z = gz + rng() * 24;
      if (Math.sqrt(x * x + z * z) > G.R * 1.15) continue;
      const y = good(x, z);
      if (y < 0) continue;
      out.push({ x, y, z, region: -1 });
    }
  }
  return out;
}

/** regionAt(x, z): the smallest region whose circle holds the point (named places first), or null. */
function makeRegionAt(regions) {
  const list = regions.slice().sort((a, b) => (Number(b.named) - Number(a.named)) || (a.r - b.r));
  return (x, z) => {
    for (const g of list) if ((g.x - x) * (g.x - x) + (g.z - z) * (g.z - z) <= g.r * g.r) return g;
    return null;
  };
}

/** The checksum compared between the Room and every client: objects, loot, places, roads, grids. */
function makeChecksum(G, objects, chests, lootSpots, regions, roads, pads, lava, surface) {
  const M = 1000000007;
  let c = objects.length * 7919 + chests.length * 31 + lootSpots.length;
  for (const o of objects) c = (c + Math.floor(o.x * 10) * 13 + Math.floor(o.z * 10) * 17 + Math.floor(o.y * 10) * 7) % M;
  for (const ch of chests) c = (c + Math.floor(ch.x * 10) * 3 + Math.floor(ch.z * 10) * 5) % M;
  for (const l of lootSpots) c = (c + Math.floor(l.x * 10) * 11 + Math.floor(l.z * 10) * 19) % M;
  for (const g of regions) c = (c + Math.floor(g.x * 10) * 23 + Math.floor(g.z * 10) * 29) % M;
  for (const r of roads) for (const p of r.pts) c = (c + Math.floor(p[0] * 10) * 31 + Math.floor(p[1] * 10) * 37) % M;
  for (const p of pads) c = (c + Math.floor(p.x * 10) * 41 + Math.floor(p.z * 10) * 43) % M;
  for (const l of lava) c = (c + Math.floor(l.x * 10) * 47 + Math.floor(l.r * 10)) % M;
  const { heights, biome, N } = G;
  for (let i = 0; i < N * N; i += 7) c = (c + Math.floor(heights[i] * 100) * (i % 97 + 1) + biome[i] * 53 + surface[i] * 59) % M;
  return c;
}
