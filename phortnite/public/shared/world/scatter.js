// Vegetation, rocks and natural decor on a 6 m jittered grid with per-biome tables; launch pads,
// geysers and bounce mushrooms; lava zones.
//
// Trees: { kind: 'tree', type (legacy 0 pine / 1 oak / 2 palm), species (a SPECIES key), mat, hp, x, y, z, s, yaw }
// Rocks: { kind: 'rock', type 0-2, mat, hp, x, y, z, s, yaw }
// Pads (data.pads): { id, kind: 'launch' | 'geyser' | 'mushroom', x, y, z, region, power }
// Lava (data.lava): { x, z, r, y } discs of lava at height y
import { ENV } from '../constants.js';
import { SPECIES_TYPE } from './keys.js';
import { OCC, BoxHash, markOcc } from './grid.js';
import { BI } from './biomes.js';
import { smoothstep } from '../rng.js';
import { coarseField } from './heights.js';
import { DIRS16 } from './pois.js';

// per biome: tree density (0..1 of cells at full forest noise), species weights, bush share,
// rock density, decor (type, share of cells)
const FLORA = {
  [BI.meadow]: { trees: 0.12, species: [['oak', 5], ['birch', 3], ['pine', 1]], bush: 0.07, rocks: 0.05, decor: [['flowers', 0.07], ['stump', 0.004]] },
  [BI.forest]: { trees: 0.42, species: [['pine', 5], ['oak', 3], ['birch', 2]], bush: 0.1, rocks: 0.06, decor: [['shroom', 0.02], ['log', 0.008], ['stump', 0.01]] },
  [BI.farm]: { trees: 0.05, species: [['oak', 4], ['birch', 1]], bush: 0.04, rocks: 0.02, decor: [['flowers', 0.03]] },
  [BI.city]: { trees: 0.03, species: [['oak', 3], ['birch', 2]], bush: 0.05, rocks: 0.0, decor: [['flowers', 0.02]] },
  [BI.snow]: { trees: 0.2, species: [['snowpine', 8], ['dead', 1]], bush: 0.0, rocks: 0.12, decor: [['log', 0.004]] },
  [BI.desert]: { trees: 0.045, species: [['cactus', 6], ['palm', 1], ['dead', 1]], bush: 0.03, rocks: 0.06, decor: [['tuft', 0.05], ['shell', 0.002]] },
  [BI.mesa]: { trees: 0.04, species: [['cactus', 5], ['dead', 2]], bush: 0.03, rocks: 0.1, decor: [['tuft', 0.05]] },
  [BI.jungle]: { trees: 0.42, species: [['jungle', 6], ['palm', 3]], bush: 0.16, rocks: 0.03, decor: [['shroom', 0.02], ['flowers', 0.02]] },
  [BI.swamp]: { trees: 0.26, species: [['swamp', 6], ['dead', 2]], bush: 0.12, rocks: 0.02, decor: [['reeds', 0.06], ['lily', 0.01], ['shroom', 0.01]] },
  [BI.volcano]: { trees: 0.03, species: [['dead', 4], ['pine', 1]], bush: 0.0, rocks: 0.14, decor: [] },
  [BI.beach]: { trees: 0.05, species: [['palm', 1]], bush: 0.02, rocks: 0.02, decor: [['shell', 0.01], ['tuft', 0.02]] },
};
// size ranges per species
const SCALE = { pine: [0.8, 0.6], oak: [0.8, 0.55], palm: [0.85, 0.45], birch: [0.8, 0.5], snowpine: [0.75, 0.7], cactus: [0.7, 0.6], jungle: [0.9, 0.6], swamp: [0.8, 0.5], dead: [0.7, 0.5], bush: [0.6, 0.6] };
const HP = { bush: 0.35, cactus: 0.6, dead: 0.7 };

export function scatter(G, L, W, regions, rng) {
  const { N, cell, half, heights, occ, biome } = G;
  const k = G.k;
  const houses = new BoxHash(32);
  for (const h of W.houses) houses.add({ x0: h.x - h.hx, z0: h.z - h.hz, x1: h.x + h.hx, z1: h.z + h.hz });
  const props = new BoxHash(16);
  for (const o of W.objects) if (o.kind === 'prop') props.add({ x0: o.x - Math.max(o.hx, o.hz), z0: o.z - Math.max(o.hx, o.hz), x1: o.x + Math.max(o.hx, o.hz), z1: o.z + Math.max(o.hx, o.hz) });
  // keep the middle of towns clear, thin trees out around them: a factor per grid point, stamped per place
  const pfGrid = new Float32Array(N * N).fill(1);
  for (const g of regions) {
    const rr = g.r * 1.15;
    const core = g.kind === 'city' || g.recipe === 'stadium' ? 1.1 : g.kind === 'landmark' ? 0.6 : 0.75;
    const ix0 = Math.max(0, Math.floor((g.x - rr + half) / cell)), ix1 = Math.min(N - 1, Math.ceil((g.x + rr + half) / cell));
    const iz0 = Math.max(0, Math.floor((g.z - rr + half) / cell)), iz1 = Math.min(N - 1, Math.ceil((g.z + rr + half) / cell));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const dx = -half + ix * cell - g.x, dz = -half + iz * cell - g.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > rr * rr) continue;
      const d = Math.sqrt(d2) / rr;
      const f = d < core ? 0 : smoothstep(core, 1, d) * 0.8;
      const i = iz * N + ix;
      if (f < pfGrid[i]) pfGrid[i] = f;
    }
  }
  const pickW = (t, r) => {
    let sum = 0;
    for (let j = 0; j < t.length; j++) sum += t[j][1];
    let v = r * sum;
    for (let j = 0; j < t.length; j++) { v -= t[j][1]; if (v <= 0) return t[j][0]; }
    return t[0][0];
  };
  const fk = 1 / k;
  // forest patches: slow noise, sampled every 2 grid points (8 m)
  const forestF = coarseField(G, 2, (x, z) => G.n4.fbm(x * 0.008 * fk + 40, z * 0.008 * fk - 13, 3) * 0.5 + 0.5);
  const S = 6;
  // the per-cell work lives in small functions (called thousands of times, so they get optimised
  // quickly and their numbers stay unboxed)
  const C = { G, W, N, half, cell, heights, occ, biome, road: G.road, houses, props, pfGrid, forestF, rng, pickW, trees: 0, r: new Float64Array(6) };
  for (let gz = -half + 3; gz < half - 3; gz += S) {
    for (let gx = -half + 3; gx < half - 3; gx += S) floraCell(C, gx, gz, S);
  }
  // rocks: a coarser grid; more on mountains, mesas and the volcano, a few boulders everywhere
  const RS = 17;
  C.rocks = 0;
  for (let gz = -half + 8; gz < half - 8; gz += RS) {
    for (let gx = -half + 8; gx < half - 8; gx += RS) rockCell(C, gx, gz, RS);
  }
}

function draw6(C) {
  const r = C.r, rng = C.rng;
  for (let k = 0; k < 6; k++) r[k] = rng();
  return r;
}

/** One 6 m vegetation cell: maybe a tree, a bush or a bit of decor. Always draws 6 random numbers. */
function floraCell(C, gx, gz, S) {
  const r = draw6(C);
  const { N, half, cell, heights, biome } = C;
  const x = gx + (r[0] - 0.5) * S * 0.9, z = gz + (r[1] - 0.5) * S * 0.9;
  const ix = Math.round((x + half) / cell), iz = Math.round((z + half) / cell);
  const i = iz * N + ix;
  const h = heights[i];
  if (h < 0.7 || C.occ[i] !== OCC.FREE || C.road[i]) return;
  const F = FLORA[biome[i]];
  if (!F) return;
  // steepness from the neighbouring grid points (summed rise over 8 m)
  const sl = ix > 0 && iz > 0 && ix < N - 1 && iz < N - 1 ? Math.abs(heights[i + 1] - heights[i - 1]) + Math.abs(heights[i + N] - heights[i - N]) : 9;
  const pf = C.pfGrid[i];
  const forest = C.forestF[i];
  const dens = F.trees * (0.7 + forest * forest * 6) * pf;
  const W = C.W;
  if (r[2] < dens && sl < 6.8 && C.trees < 8600) {
    const near = C.houses.hits(x - 1, z - 1, x + 1, z + 1, 3) || C.props.hits(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 1.2);
    if (!near) {
      let species = C.pickW(F.species, r[3]);
      if (biome[i] === BI.beach && h > 6) species = 'oak';
      const sc = SCALE[species];
      const s = sc[0] + r[4] * sc[1];
      W.add({ kind: 'tree', type: SPECIES_TYPE[species], species, mat: 'wood', hp: Math.round(ENV.treeHp * s * (HP[species] || 1)), x, y: footY(C.G, x, z, 0.5), z, s, yaw: r[5] * 6.283185307179586 });
      C.trees++;
      return;
    }
  }
  if (r[2] > 0.985 - F.bush * pf * (0.5 + forest) && sl < 6 && C.trees < 8900 && pf > 0.2) {
    if (!C.houses.hits(x - 0.6, z - 0.6, x + 0.6, z + 0.6, 1.5) && !C.props.hits(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 0.8)) {
      const s = 0.55 + r[4] * 0.6;
      W.add({ kind: 'tree', type: SPECIES_TYPE.bush, species: 'bush', mat: 'wood', hp: Math.round(ENV.treeHp * s * HP.bush), x, y: footY(C.G, x, z, 0.5), z, s, yaw: r[5] * 6.283185307179586 });
      C.trees++;
      return;
    }
  }
  // natural decor (no colliders)
  const decor = F.decor;
  for (let d = 0; d < decor.length; d++) {
    if (r[3] < decor[d][1] * (0.4 + pf)) {
      // (not on steep ground: a log or a tuft on a cliff floats at one end)
      if (sl < 5 && !C.houses.hits(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 0.8)) W.add({ kind: 'decor', type: decor[d][0], x, y: footY(C.G, x, z, 0.5), z, s: 0.7 + r[4] * 0.6, yaw: r[5] * 6.283185307179586 });
      return;
    }
  }
}

/**
 * The ground under a footprint: the lowest real height at the centre and r m around it (the grid
 * point's height floats things on a slope: trees up to 4 m, decor up to 10 m up a cliff).
 */
function footY(G, x, z, r) {
  return Math.min(G.heightAt(x, z), G.heightAt(x + r, z), G.heightAt(x - r, z), G.heightAt(x, z + r), G.heightAt(x, z - r));
}

/** One 17 m rock cell. Always draws 6 random numbers. */
function rockCell(C, gx, gz, RS) {
  const r = draw6(C);
  const { G, heights, occ, biome } = C;
  const x = gx + (r[0] - 0.5) * RS, z = gz + (r[1] - 0.5) * RS;
  const i = G.at(x, z);
  const h = heights[i];
  if (h < 0.6 || occ[i] !== OCC.FREE || C.road[i] || C.rocks >= 1950) return;
  const F = FLORA[biome[i]];
  if (!F) return;
  const sl = G.slope(x, z);
  const rocky = F.rocks * (1 + smoothstep(1.5, 5, sl) * 2.5) * C.pfGrid[i] * 4;
  if (r[2] > rocky) return;
  if (C.houses.hits(x - 2, z - 2, x + 2, z + 2, 3) || C.props.hits(x - 2, z - 2, x + 2, z + 2, 1)) return;
  const s = 0.9 + r[3] * r[3] * 2.8;
  C.W.add({ kind: 'rock', type: Math.floor(r[4] * 3), mat: 'stone', hp: Math.round(ENV.rockHp * (0.6 + s * 0.25)), x, y: footY(G, x, z, 0.5) - 0.25 * s, z, s, yaw: r[5] * 6.283185307179586 });
  C.rocks++;
}

/** Launch pads (place edges, mesa feet, two skyscraper roofs), volcano geysers, jungle mushrooms; lava. */
export function padsAndLava(G, L, W, regions, pads, lava, rng) {
  const houses = new BoxHash(32);
  for (const h of W.houses) houses.add({ x0: h.x - h.hx, z0: h.z - h.hz, x1: h.x + h.hx, z1: h.z + h.hz });
  const openAt = (x, z, maxSlope = 1.6) => {
    const i = G.at(x, z);
    const h = G.heights[i];
    if (h < 1.2 || G.road[i] || G.slope(x, z) > maxSlope) return false;
    if (G.occ[i] !== OCC.FREE && G.occ[i] !== OCC.YARD) return false;
    if (houses.hits(x - 2, z - 2, x + 2, z + 2, 2.5)) return false;
    for (const p of pads) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 30 * 30) return false;
    return true;
  };
  const add = (kind, x, y, z, region, power) => {
    pads.push({ id: pads.length, kind, x, y, z, region, power });
    markOcc(G, x, z, 2.5, 2.5, OCC.KEEP);
  };
  // launch pads at the edge of the hot and normal named places
  for (const g of regions) {
    if (!g.named || g.tier === 'quiet' || pads.length >= 14) continue;
    for (let t = 0; t < 16; t++) {
      const [dx, dz] = DIRS16[(g.id * 3 + t * 5) % 16];
      const x = g.x + dx * g.r * 0.95, z = g.z + dz * g.r * 0.95;
      if (openAt(x, z)) { add('launch', x, G.heightAt(x, z), z, g.id, 1); break; }
    }
  }
  // two on skyscraper roofs in Tilty Towers
  let roofs = 0;
  for (const h of W.houses) {
    if (h.archetype !== 'skyscraper' || roofs >= 2) continue;
    const lx = -h.w / 4, lz = -h.d / 4;
    const [x, z] = h.rot === 1 ? [h.x + lz, h.z - lx] : h.rot === 2 ? [h.x - lx, h.z - lz] : h.rot === 3 ? [h.x - lz, h.z + lx] : [h.x + lx, h.z + lz];
    pads.push({ id: pads.length, kind: 'launch', x, y: h.y + h.floors * 3.6 + 0.3, z, region: h.region, power: 1, roof: true });
    roofs++;
  }
  // at the feet of mesas: low desert / mesa ground right next to a cliff
  let mesas = 0;
  for (let t = 0; t < 600 && mesas < 4; t++) {
    const x = (rng() - 0.5) * G.size * 0.8, z = (rng() - 0.5) * G.size * 0.8;
    const b = G.biome[G.at(x, z)];
    if (b !== BI.mesa && b !== BI.desert) continue;
    if (!openAt(x, z)) continue;
    const h = G.heightAt(x, z);
    let cliff = false;
    for (const [dx, dz] of DIRS16) if (G.heightAt(x + dx * 10, z + dz * 10) > h + 9) { cliff = true; break; }
    if (cliff) { add('launch', x, h, z, -1, 1); mesas++; }
  }
  // geysers on the volcano's slopes
  const v = L.volcano;
  let gey = 0;
  for (let t = 0; t < 64 && gey < 6; t++) {
    const [dx, dz] = DIRS16[(t * 7) % 16];
    const s = v.r * (0.35 + ((t * 13) % 10) / 22);
    const x = v.x + dx * s, z = v.z + dz * s;
    if (Math.sqrt(x * x + z * z) > G.R * 0.95) continue;
    if (openAt(x, z, 4)) { add('geyser', x, G.heightAt(x, z), z, -1, 1.4); gey++; }
  }
  // bounce mushrooms in the jungle and the swamp
  let mush = 0;
  for (let t = 0; t < 900 && mush < 6; t++) {
    const x = (rng() - 0.5) * G.size * 0.8, z = (rng() - 0.5) * G.size * 0.8;
    const b = G.biome[G.at(x, z)];
    if (b !== BI.jungle && b !== BI.swamp) continue;
    if (openAt(x, z)) { add('mushroom', x, G.heightAt(x, z), z, -1, 0.8); mush++; }
  }
  // lava: the crater pool, plus two small pools on the flanks. The pool fills the bowl out to where
  // its walls rise above the lava (~0.74 x the crater radius): the painted lava and the lava that
  // hurts are the same (biomes.js paints only below its top), so there is no lava-looking ring
  // that doesn't hurt. Four geysers on the bowl's low ring (where anyone who falls in ends up; the
  // mound in the middle is too steep to climb) throw you out of the pit.
  const floorY = G.heightAt(v.x, v.z);
  lava.push({ x: v.x, z: v.z, r: v.crater * 0.74, y: floorY + 0.25 });
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const x = v.x + dx * v.crater * 0.45, z = v.z + dz * v.crater * 0.45;
    pads.push({ id: pads.length, kind: 'geyser', x, y: G.heightAt(x, z), z, region: -1, power: 1.4 });
  }
  for (const [dx, dz] of [[0.70711, 0.70711], [-0.92388, -0.38268]]) {
    const x = v.x + dx * v.r * 0.55, z = v.z + dz * v.r * 0.55;
    if (Math.sqrt(x * x + z * z) > G.R * 0.9 || G.occ[G.at(x, z)] !== OCC.FREE) continue;
    const y = G.heightAt(x, z);
    lavaPit(G, x, z, 7, y - 1.2);
    lava.push({ x, z, r: 6, y: y - 1.0 });
    markOcc(G, x, z, 9, 9, OCC.KEEP);
  }
}

/** A small round pit with a flat floor at y (a lava pool). */
function lavaPit(G, x, z, r, y) {
  const { N, cell, half, heights } = G;
  const R2 = r * 1.8;
  for (let iz = Math.max(0, Math.floor((z - R2 + half) / cell)); iz <= Math.min(N - 1, Math.ceil((z + R2 + half) / cell)); iz++) {
    for (let ix = Math.max(0, Math.floor((x - R2 + half) / cell)); ix <= Math.min(N - 1, Math.ceil((x + R2 + half) / cell)); ix++) {
      const px = -half + ix * cell, pz = -half + iz * cell;
      const d = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z));
      if (d >= R2) continue;
      const i = iz * N + ix;
      const t = d < r ? y : y + (heights[i] - y) * smoothstep(r, R2, d);
      if (t < heights[i]) heights[i] = t;
    }
  }
}
