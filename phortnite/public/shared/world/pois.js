// Places: where every named place and landmark sits, and the plan of each one (streets, building
// plots, fields, plazas) from its recipe. Buildings are placed on the plots later, once the roads
// are known (plots on roads or water are skipped).
//
// Layouts by kind: city = a street grid of blocks; town = a main street (plus a cross street) with
// plots on both sides; farm = fields around a farmyard; outpost = one landmark with a few
// buildings around it.
import { smoothstep } from '../rng.js';
import { BI } from './biomes.js';
import { flattenDisc, meanHeight, polyDist, polySegs } from './heights.js';
import { ARCHETYPES } from './buildings.js';

// 16 compass directions (literal unit vectors)
export const DIRS16 = [
  [1, 0], [0.92388, 0.38268], [0.70711, 0.70711], [0.38268, 0.92388], [0, 1], [-0.38268, 0.92388], [-0.70711, 0.70711], [-0.92388, 0.38268],
  [-1, 0], [-0.92388, -0.38268], [-0.70711, -0.70711], [-0.38268, -0.92388], [0, -1], [0.38268, -0.92388], [0.70711, -0.70711], [0.92388, -0.38268],
];

const COASTAL = new Set(['beach', 'pirate', 'lighthouse', 'port', 'cove']);

/** Snap a footprint centre so its corners land on the 4 m build grid (size = footprint length). */
export const snapC = (c, size) => Math.round((c - size / 2) / 4) * 4 + size / 2;
const snap4 = (c) => Math.round(c / 4) * 4;

/** rot (0-3) whose local +z (the front) points closest to the direction (dx, dz). */
export function rotToward(dx, dz) {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 0 : 2;
}

/**
 * Put every place near its hint: the first ring position (spiralling out) on fairly flat land,
 * clear of the river, the lake and the places already placed. Returns the regions list (named
 * places first, then landmarks), each with x, z, y (pad height), r, biome, kind, tier, named, recipe.
 */
export function placePlaces(G, L) {
  const regions = [];
  const riverSegs = polySegs(L.river.pts);
  const k = G.k;
  const all = [
    ...L.places.map((p) => ({ ...p, named: true })),
    ...L.landmarks.map((p) => ({ ...p, kind: 'landmark', tier: p.tier || 'normal', named: false })),
  ];
  for (const p of all) {
    let best = null, bestS = Infinity;
    for (let ring = 0; ring <= 8 && bestS > 0.5; ring++) {
      const rad = ring * 12 * k;
      const n = ring === 0 ? 1 : 16;
      for (let di = 0; di < n; di++) {
        const x = p.x + DIRS16[di][0] * rad, z = p.z + DIRS16[di][1] * rad;
        const s = siteScore(G, L, p, x, z, riverSegs, regions) + ring * 0.08;
        if (s < bestS) { bestS = s; best = [x, z]; }
      }
    }
    const [x, z] = best;
    const coastal = COASTAL.has(p.recipe);
    let y = meanHeight(G, x, z, p.r * 0.6);
    y = Math.max(y, coastal ? 2.2 : 2.6);
    const bi = G.biome[G.at(x, z)];
    regions.push({
      id: regions.length, name: p.name, x, z, y, r: p.r, biome: p.biome || biomeKey(bi), kind: p.kind, tier: p.tier,
      named: p.named, recipe: p.recipe,
    });
  }
  return regions;
}

const biomeKey = (i) => Object.keys(BI).find((kk) => BI[kk] === i) || 'meadow';

/** Lower is better: roughness, water, crowding. */
function siteScore(G, L, p, x, z, riverSegs, placed) {
  const r = p.r;
  let mn = Infinity, mx = -Infinity;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const h = G.heightAt(x + a * r * 0.3, z + b * r * 0.3);
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  const mountain = p.biome === 'snow' || p.biome === 'volcano';
  let s = (mx - mn) / (mountain ? 40 : 12);
  const hc = G.heightAt(x, z);
  const coastal = COASTAL.has(p.recipe);
  if (hc < 2) s += 3;
  if (!coastal && mn < 1.5) s += 2;
  if (coastal) {
    // wants the sea within reach (for piers), but the centre on land
    let sea = false;
    for (const [dx, dz] of DIRS16) if (G.heightAt(x + dx * (r + 10), z + dz * (r + 10)) < -1) { sea = true; break; }
    if (!sea) s += 1.5;
  }
  // the river and the lake
  if (p.recipe !== 'lake') {
    const dr = polyDist(riverSegs, x, z);
    const keep = r + 16 + Math.min(Math.max(G.heightAt(x, z), 0), 60) * 0.6;
    if (dr < keep) s += 3 * (1 - dr / keep) + 1;
    const lk = L.lake, dl = Math.sqrt((x - lk.x) * (x - lk.x) + (z - lk.z) * (z - lk.z));
    if (dl < lk.r * 1.3 + r * 0.7) s += 3;
  }
  // the volcano crater
  const v = L.volcano, dv = Math.sqrt((x - v.x) * (x - v.x) + (z - v.z) * (z - v.z));
  if (dv < v.crater * 2.2 + r) s += 4;
  for (const q of placed) {
    const dx = q.x - x, dz = q.z - z, d = Math.sqrt(dx * dx + dz * dz);
    const need = (q.r + r) * 0.9 + 8;
    if (d < need) s += 3 * (1 - d / need) + 1.5;
  }
  // stay on the island
  if (Math.sqrt(x * x + z * z) > G.R * 0.93) s += 2;
  return s;
}

/** Flatten every place's pad (towns fully, outposts softer); the lake place keeps its shore. */
export function flattenPlaces(G, regions) {
  for (const g of regions) {
    if (g.recipe === 'lake' || g.recipe === 'pirate') continue;
    const rr = g.kind === 'city' ? g.r * 0.95 : g.r * 0.75;
    flattenDisc(G, g.x, g.z, rr, g.r * 0.7, g.y, 1);
  }
}

// ------------------------------------------------------------------ plans
// plan = { hub: [x, z], streets: [{ x0, z0, x1, z1, w }], plots: [{ arch, x, z, rot, w, d, floors?, opts? }],
//          fields: [{ x, z, hx, hz, crop }], plazas: [{ x, z, hx, hz }], props: [...] }

function pick(rng, table) {
  let t = 0;
  for (const [, wgt] of table) t += wgt;
  let r = rng() * t;
  for (const [v, wgt] of table) { r -= wgt; if (r <= 0) return v; }
  return table[table.length - 1][0];
}

/** A plot of an archetype with its footprint; front facing (fx, fz). */
function plot(rng, arch, x, z, rot, opts = {}) {
  const A = ARCHETYPES[arch];
  const [w, d] = opts.size || A.size(rng);
  const floors = opts.floors ?? A.floors(rng);
  const hx = (rot % 2 ? d : w) / 2, hz = (rot % 2 ? w : d) / 2;
  return { arch, x: snapC(x, hx * 2), z: snapC(z, hz * 2), rot, w, d, floors, opts, must: !!opts.must };
}

/** Plots on both sides of an axis-aligned street (front doors facing it). */
function streetPlots(rng, plan, sx, sz, ax, len, sw, palette, { gap = 4, rows = 1, skip = null, setback = 2 } = {}) {
  for (const side of [-1, 1]) {
    for (let row = 0; row < rows; row++) {
      let a = -len / 2 + 2;
      let depthUsed = 0;
      while (a < len / 2 - 6) {
        const arch = pick(rng, palette);
        const A = ARCHETYPES[arch];
        const [w, d] = A.size(rng);
        const along = a + w / 2;
        if (skip && skip(along, w)) { a += 8; continue; }
        // the front sits 8 m from the street's centre line (on the 4 m grid), so no snapping shifts it
        const across = side * (Math.max(8, sw / 2 + setback) + d / 2 + row * (12 + 6));
        let rot;
        if (ax === 'x') rot = side < 0 ? 0 : 2; else rot = side < 0 ? 1 : 3;
        const x = ax === 'x' ? sx + along : sx + across;
        const z = ax === 'x' ? sz + across : sz + along;
        plan.plots.push(plot(rng, arch, x, z, rot, { size: [w, d] }));
        depthUsed = Math.max(depthUsed, d);
        a += w + gap + (rng() < 0.3 ? 4 : 0);
      }
    }
  }
}

function addStreet(plan, x0, z0, x1, z1, w, kind = 'street') {
  plan.streets.push({ x0: snap4(x0), z0: snap4(z0), x1: snap4(x1), z1: snap4(z1), w, kind });
}

/** A ring of candidate plots around the centre (outposts, farms), facing the centre. */
function ringPlots(rng, plan, g, list, rad, start = 0) {
  list.forEach((arch, i) => {
    const di = (start + i * 5) % 16;
    const [dx, dz] = DIRS16[di];
    const p = plot(rng, arch, g.x + dx * rad, g.z + dz * rad, rotToward(-dx, -dz));
    // other spots around the ring (and a little further out) if this one is taken or too steep
    p.alts = [];
    for (const k of [1, 1.25, 0.8]) {
      for (let t = 1; t < 16; t += 2) {
        const [ex, ez] = DIRS16[(di + t * 3) % 16];
        const rot = rotToward(-ex, -ez);
        const hx = (rot % 2 ? p.d : p.w) / 2, hz = (rot % 2 ? p.w : p.d) / 2;
        p.alts.push([snapC(g.x + ex * rad * k, hx * 2), snapC(g.z + ez * rad * k, hz * 2), rot]);
      }
    }
    plan.plots.push(p);
  });
}

const PALETTES = {
  suburb: [['house', 6], ['shop', 1]],
  chalets: [['cabin', 5], ['house', 1]],
  western: [['shop', 3], ['adobe', 3], ['house', 1]],
  oasis: [['adobe', 5], ['shop', 1]],
  swamp: [['stilt', 5], ['shack', 2]],
  treetop: [['treehouse', 4], ['stilt', 2]],
  mines: [['shed', 3], ['house', 1]],
  mill: [['house', 5], ['cabin', 1], ['shop', 1]],
  plaza: [['house', 4], ['shop', 2], ['apartment', 1]],
  bluffs: [['house', 6], ['cabin', 1]],
  beach: [['shack', 4], ['stilt', 2]],
  port: [['warehouse', 2], ['shed', 2], ['house', 1]],
  cove: [['house', 3], ['shack', 3]],
  mall: [['shop', 3], ['house', 3]],
};

/** The plan of one place from its recipe. */
export function planPlace(G, g, rng, regions) {
  const plan = { hub: [g.x, g.z], streets: [], plots: [], fields: [], plazas: [], props: [], parking: [] };
  const cx = snap4(g.x), cz = snap4(g.z);
  // main street axis: toward the nearest other named place
  let near = null, nd = Infinity;
  for (const q of regions) {
    if (q === g) continue;
    const d = (q.x - g.x) * (q.x - g.x) + (q.z - g.z) * (q.z - g.z);
    if (d < nd) { nd = d; near = q; }
  }
  const ax = near && Math.abs(near.x - g.x) > Math.abs(near.z - g.z) ? 'x' : 'z';
  g.axis = ax;
  const street = (len, w = 8, kind = 'street', ox = 0, oz = 0, axis = ax) => {
    if (axis === 'x') addStreet(plan, cx - len / 2 + ox, cz + oz, cx + len / 2 + ox, cz + oz, w, kind);
    else addStreet(plan, cx + ox, cz - len / 2 + oz, cx + ox, cz + len / 2 + oz, w, kind);
  };
  const r = g.r;
  const other = ax === 'x' ? 'z' : 'x';
  switch (g.recipe) {
    case 'downtown': {
      // 3 x 3 blocks of 40 m (pitch 56), streets 10 m wide between and around them
      const P = 56, half = 1.5 * P;
      for (const o of [-half, -P / 2, P / 2, half]) {
        addStreet(plan, cx - half, cz + o, cx + half, cz + o, 10);
        addStreet(plan, cx + o, cz - half, cx + o, cz + half, 10);
      }
      plan.hub = [cx + P / 2, cz + P / 2];
      plan.plazas.push({ x: cx, z: cz, hx: 20, hz: 20 });
      plan.plots.push(plot(rng, 'clocktower', cx, cz, 0, { must: true }));
      let towers = 0;
      for (const bx of [-P, 0, P]) {
        for (const bz of [-P, 0, P]) {
          if (bx === 0 && bz === 0) continue;
          for (const [lx, lz] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) {
            const x = cx + bx + lx, z = cz + bz + lz;
            // face the street on the lot's outer side (the nearer of x / z)
            const rot = Math.abs(lx) >= Math.abs(lz) && rng() < 0.5 ? (lx > 0 ? 1 : 3) : (lz > 0 ? 0 : 2);
            const roll = rng();
            if (roll < 0.1) continue; // a little park
            if ((towers < 7 && roll < 0.42) || (bx !== 0 && bz !== 0 && towers < 3 && roll < 0.6)) {
              towers++;
              plan.plots.push(plot(rng, 'skyscraper', x, z, rot, { must: true }));
            } else if (roll < 0.72) plan.plots.push(plot(rng, 'apartment', x, z, rot, { size: [12, 12] }));
            else plan.plots.push(plot(rng, 'shop', x, z, rot, { size: [12, 12] }));
          }
        }
      }
      break;
    }
    case 'mall': {
      street(r * 1.9, 8);
      street(r * 1.2, 8, 'street', 0, 0, other);
      // the big store and its car park on one side of the main street
      const s = ax === 'x' ? [0, -1] : [-1, 0];
      const mx = cx + s[0] * 30, mz = cz + s[1] * 30;
      plan.plots.push(plot(rng, 'mall', mx + (ax === 'x' ? -24 : 0), mz + (ax === 'x' ? 0 : -24), rotToward(-s[0], -s[1]), { must: true }));
      plan.parking.push({ x: mx + (ax === 'x' ? 18 : 0), z: mz + (ax === 'x' ? 0 : 18), hx: ax === 'x' ? 16 : 12, hz: ax === 'x' ? 12 : 16 });
      streetPlots(rng, plan, cx, cz, ax, r * 1.9, 8, PALETTES.mall, { skip: (a) => Math.abs(a) < 8 });
      streetPlots(rng, plan, cx, cz, other, r * 1.2, 8, PALETTES.suburb, { skip: (a) => Math.abs(a) < 10 });
      break;
    }
    case 'depot': {
      street(r * 1.8, 10);
      const s = ax === 'x' ? 'z' : 'x';
      for (let i = -1; i <= 1; i++) {
        const along = i * 28;
        const x = cx + (ax === 'x' ? along : -22), z = cz + (ax === 'x' ? -22 : along);
        plan.plots.push(plot(rng, 'warehouse', x, z, ax === 'x' ? 0 : 1, { size: [24, 16], must: true }));
      }
      plan.plots.push(plot(rng, 'gas', cx + (ax === 'x' ? 14 : 22), cz + (ax === 'x' ? 22 : 14), ax === 'x' ? 2 : 3, { must: true }));
      streetPlots(rng, plan, cx, cz, ax, r * 1.8, 10, [['shed', 3], ['house', 1]], { skip: (a) => Math.abs(a) < 30 });
      plan.props.push({ type: 'containers', x: cx + (ax === 'x' ? -30 : 26), z: cz + (ax === 'x' ? 26 : -30), n: 8 });
      void s;
      break;
    }
    case 'western': {
      street(r * 1.9, 10, 'dirt');
      plan.plots.push(plot(rng, 'saloon', cx + (ax === 'x' ? 0 : -15), cz + (ax === 'x' ? -15 : 0), ax === 'x' ? 0 : 1, { must: true }));
      plan.plots.push(plot(rng, 'watchtower', cx + (ax === 'x' ? 30 : 14), cz + (ax === 'x' ? 14 : 30), 0));
      streetPlots(rng, plan, cx, cz, ax, r * 1.9, 10, PALETTES.western, { skip: (a, w) => Math.abs(a) < 6 + w / 2 + 4 });
      break;
    }
    case 'oasis': {
      street(r * 1.6, 8);
      plan.plots.push(plot(rng, 'motel', cx + (ax === 'x' ? 0 : -14), cz + (ax === 'x' ? -14 : 0), ax === 'x' ? 0 : 1, { size: [32, 8], must: true }));
      plan.props.push({ type: 'pond', x: cx + (ax === 'x' ? 0 : 20), z: cz + (ax === 'x' ? 20 : 0), r: 9 });
      streetPlots(rng, plan, cx, cz, ax, r * 1.6, 8, PALETTES.oasis, { skip: (a) => Math.abs(a) < 22 });
      break;
    }
    case 'chalets': case 'mill': case 'plaza': case 'bluffs': case 'mines': case 'cove': case 'swamp': case 'treehouses': case 'beach': case 'port': {
      const pal = { chalets: 'chalets', mill: 'mill', plaza: 'plaza', bluffs: 'bluffs', mines: 'mines', cove: 'cove', swamp: 'swamp', treehouses: 'treetop', beach: 'beach', port: 'port' }[g.recipe];
      const dirt = ['chalets', 'mines', 'swamp', 'treehouses', 'beach', 'cove'].includes(g.recipe);
      street(r * 1.8, dirt ? 6 : 8, dirt ? 'dirt' : 'street');
      if (r > 56 && !dirt) street(r * 1.1, 8, 'street', 0, 0, other);
      // a landmark at the centre or beside it
      const side = ax === 'x' ? [0, 1] : [1, 0];
      const lm = { mill: 'windmill', plaza: null, mines: 'mine', port: 'warehouse', swamp: 'warehouse', chalets: 'lodge', treehouses: null, beach: 'watchtower', cove: null, bluffs: null }[g.recipe];
      // the landmark sits in a corner between the main and the cross street, facing the main street
      const along = ax === 'x' ? [1, 0] : [0, 1];
      if (lm) plan.plots.push(plot(rng, lm, cx + side[0] * 18 + along[0] * 18, cz + side[1] * 18 + along[1] * 18, rotToward(-side[0], -side[1]), { must: true }));
      if (g.recipe === 'plaza') {
        plan.plazas.push({ x: cx, z: cz, hx: 14, hz: 14 });
        plan.props.push({ type: 'fountain', x: cx, z: cz });
        plan.props.push({ type: 'stalls', x: cx, z: cz, n: 4 });
      }
      if (g.recipe === 'port' || g.recipe === 'beach' || g.recipe === 'cove' || g.recipe === 'swamp') plan.piers = g.recipe === 'swamp' ? 1 : 2;
      if (g.recipe === 'port') plan.props.push({ type: 'containers', x: cx - side[0] * 20, z: cz - side[1] * 20, n: 10 });
      streetPlots(rng, plan, cx, cz, ax, r * 1.8, dirt ? 6 : 8, PALETTES[pal], {
        skip: (a, w) => (lm || g.recipe === 'plaza') && Math.abs(a - (lm ? 18 : 0)) < 12 + w / 2,
        gap: g.recipe === 'bluffs' || g.recipe === 'chalets' ? 8 : 4,
      });
      if (r > 56 && !dirt) streetPlots(rng, plan, cx, cz, other, r * 1.1, 8, PALETTES[pal], { skip: (a) => Math.abs(a) < 14 });
      break;
    }
    case 'farm': case 'pumpkins': {
      street(r * 1.5, 6, 'dirt');
      const s = ax === 'x' ? [0, -1] : [-1, 0];
      plan.plots.push(plot(rng, 'barn', cx + s[0] * 20 + (ax === 'x' ? -10 : 0), cz + s[1] * 20 + (ax === 'x' ? 0 : -10), rotToward(-s[0], -s[1]), { must: true }));
      plan.plots.push(plot(rng, 'house', cx + s[0] * 18 + (ax === 'x' ? 14 : 0), cz + s[1] * 18 + (ax === 'x' ? 0 : 14), rotToward(-s[0], -s[1]), { floors: 2, size: [12, 8] }));
      if (g.recipe === 'farm') {
        plan.plots.push(plot(rng, 'silo', cx + s[0] * 20 + (ax === 'x' ? -24 : 0), cz + s[1] * 20 + (ax === 'x' ? 0 : -24), 0));
        plan.plots.push(plot(rng, 'silo', cx + s[0] * 30 + (ax === 'x' ? -24 : 0), cz + s[1] * 30 + (ax === 'x' ? 0 : -24), 0));
        plan.plots.push(plot(rng, 'shed', cx - s[0] * 18 + (ax === 'x' ? 18 : 0), cz - s[1] * 18 + (ax === 'x' ? 0 : 18), rotToward(s[0], s[1])));
      }
      // fields on the far side of the farm road
      const crop = g.recipe === 'farm' ? 'wheat' : 'pumpkin';
      for (let i = -1; i <= 1; i++) {
        const along = i * 34;
        const fx = cx + (ax === 'x' ? along : 24), fz = cz + (ax === 'x' ? 24 : along);
        plan.fields.push({ x: fx, z: fz, hx: ax === 'x' ? 15 : 12, hz: ax === 'x' ? 12 : 15, crop: i === 0 && crop === 'wheat' ? 'field' : crop });
      }
      plan.props.push({ type: 'hay', x: cx + s[0] * 6, z: cz + s[1] * 6, n: 6 });
      break;
    }
    // outposts: one landmark in the middle, a few buildings around it
    case 'ski':
      plan.plots.push(plot(rng, 'lodge', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      ringPlots(rng, plan, g, ['cabin', 'cabin', 'watchtower'], r * 0.75, 2);
      plan.hubCore = 14;
      break;
    case 'icecastle':
      plan.plots.push(plot(rng, 'icecastle', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      ringPlots(rng, plan, g, ['cabin', 'cabin'], r * 0.95, 6);
      plan.hubCore = 22;
      break;
    case 'castle':
      plan.plots.push(plot(rng, 'castle', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      ringPlots(rng, plan, g, ['house', 'watchtower', 'barn'], r * 1.05, 3);
      plan.hubCore = 26;
      break;
    case 'canyon':
      plan.plots.push(plot(rng, 'watchtower', cx, cz, 0, { must: true }));
      ringPlots(rng, plan, g, ['adobe', 'shed', 'adobe', 'watchtower'], r * 0.6, 1);
      plan.hubCore = 8;
      break;
    case 'temple':
      plan.plots.push(plot(rng, 'temple', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      ringPlots(rng, plan, g, ['shack', 'watchtower', 'shack'], r * 0.9, 4);
      plan.hubCore = 22;
      break;
    case 'lair':
      plan.plots.push(plot(rng, 'lair', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      ringPlots(rng, plan, g, ['watchtower', 'shed', 'watchtower'], r * 0.7, 5);
      plan.hubCore = 12;
      break;
    case 'pirate':
      plan.ship = true;
      ringPlots(rng, plan, g, ['shack', 'shack', 'watchtower'], r * 0.5, 0);
      plan.piers = 1;
      plan.hubCore = 10;
      break;
    case 'lighthouse':
      plan.plots.push(plot(rng, 'lighthouse', cx, cz, 0, { must: true }));
      ringPlots(rng, plan, g, ['house', 'shed'], r * 0.6, 3);
      plan.piers = 1;
      plan.hubCore = 8;
      break;
    case 'lake':
      plan.lake = true;
      plan.hubCore = r;
      break;
    // landmarks
    case 'gas':
      plan.plots.push(plot(rng, 'gas', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      plan.hubCore = 0;
      break;
    case 'camp':
      plan.plots.push(plot(rng, 'cabin', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      plan.props.push({ type: 'camp', x: cx + 10, z: cz + 10 });
      plan.hubCore = 8;
      break;
    case 'radio':
      plan.plots.push(plot(rng, 'radio', cx, cz, 0, { must: true }));
      plan.plots.push(plot(rng, 'shed', cx + 10, cz, 3));
      plan.hubCore = 8;
      break;
    case 'stadium':
      plan.plots.push(plot(rng, 'stadium', cx, cz, ax === 'x' ? 0 : 1, { must: true }));
      plan.hubCore = 34;
      break;
    case 'motel':
      plan.plots.push(plot(rng, 'motel', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      plan.plots.push(plot(rng, 'shed', cx + (ax === 'x' ? 22 : 0), cz + (ax === 'x' ? 0 : 22), 0));
      plan.hubCore = 10;
      break;
    case 'lookout':
      plan.plots.push(plot(rng, 'watchtower', cx, cz, 0, { must: true }));
      plan.hubCore = 6;
      break;
    case 'junkyard':
      plan.plots.push(plot(rng, 'shed', cx, cz, rotToward(-g.x, -g.z), { must: true }));
      plan.props.push({ type: 'junk', x: cx, z: cz, n: 10 });
      plan.hubCore = 10;
      break;
    default:
      ringPlots(rng, plan, g, ['house', 'house'], r * 0.5);
  }
  return plan;
}

/** Smoothly lower a bowl (the oasis pond) to y below 0. */
export function stampPond(G, x, z, r) {
  const { N, cell, half, heights } = G;
  const R2 = r * 1.8;
  for (let iz = Math.max(0, Math.floor((z - R2 + half) / cell)); iz <= Math.min(N - 1, Math.ceil((z + R2 + half) / cell)); iz++) {
    for (let ix = Math.max(0, Math.floor((x - R2 + half) / cell)); ix <= Math.min(N - 1, Math.ceil((x + R2 + half) / cell)); ix++) {
      const px = -half + ix * cell, pz = -half + iz * cell;
      const d = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z)) / r;
      if (d >= 1.8) continue;
      const i = iz * N + ix;
      const t = d < 1 ? -1.8 + d * 1.2 : heights[i] + (-0.6 - heights[i]) * smoothstep(1.8, 1, d);
      if (t < heights[i]) heights[i] = t;
      if (d < 1.2) G.inland[i] = 1;
    }
  }
}
