// The biome island (world version 2): determinism, budgets, buildings you can walk through, loot
// on land, biomes, the river, places and spawn points, the drop reach, and the 1200 m fallback.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, POI_NAMES } from '../public/shared/worldgen.js';
import { MAP, BUS, DROP, PLAYER, PROTOCOL } from '../public/shared/constants.js';
import { BIOMES, SURFACES, SPECIES, SPECIES_TYPE, LOOKS, LOOK_ALIASES, PADS, TIERS } from '../public/shared/world/keys.js';
import { ARCHETYPES } from '../public/shared/world/buildings.js';
import { PROP_TYPES, DECOR_TYPES } from '../public/shared/world/props.js';

const CHECKSUM = 341022309;   // pinned: the island everyone plays on (update deliberately with the map)

const worlds = new Map();
const world = (size = MAP.size) => {
  if (!worlds.has(size)) worlds.set(size, generateWorld(MAP.seed, { size }));
  return worlds.get(size);
};

// ------------------------------------------------------------------ exact geometry helpers
/** Is (x, y, z) strictly inside part / prop o (eps metres inside its surface)? */
function inside(o, x, y, z, eps = 0.02) {
  if (o.shape === 'prism') return insidePrism(o.pts, x, y, z, eps);
  let lx = x - o.x, ly = y - o.y, lz = z - o.z;
  if (o.ax) {
    const c = Math.cos(-o.ang), s = Math.sin(-o.ang);
    if (o.ax === 'x') { const ny = ly * c - lz * s, nz = ly * s + lz * c; ly = ny; lz = nz; } else { const nx = lx * c - ly * s, ny = lx * s + ly * c; lx = nx; ly = ny; }
  } else if (o.yaw) {
    // three.js / Rapier yaw: local = rotate world offset by -yaw about +y
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    const nx = lx * c - lz * s, nz = lx * s + lz * c;
    lx = nx; lz = nz;
  }
  return Math.abs(lx) < o.hx - eps && Math.abs(ly) < o.hy - eps && Math.abs(lz) < o.hz - eps;
}

function insidePrism(p, x, y, z, eps) {
  const P = (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const [a, b, c, d, e, f] = [0, 1, 2, 3, 4, 5].map(P);
  const cen = [0, 1, 2].map((k) => (a[k] + b[k] + c[k] + d[k] + e[k] + f[k]) / 6);
  const faces = [[a, b, c], [d, e, f], [a, b, e], [b, c, f], [c, a, d]];
  for (const [u, v, w] of faces) {
    const e1 = [v[0] - u[0], v[1] - u[1], v[2] - u[2]], e2 = [w[0] - u[0], w[1] - u[1], w[2] - u[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    const side = (q) => ((q[0] - u[0]) * n[0] + (q[1] - u[1]) * n[1] + (q[2] - u[2]) * n[2]) / len;
    const sc = side(cen), sp = side([x, y, z]);
    if (sc > 0 ? sp < eps : sp > -eps) return false;
  }
  return true;
}

function partsByHouse(w) {
  const m = new Map();
  for (const o of w.objects) {
    if (o.kind !== 'part') continue;
    let l = m.get(o.house);
    if (!l) m.set(o.house, (l = []));
    l.push(o);
  }
  return m;
}

/** Problems with a house's stairs, storeys and doors (empty when you can walk everywhere). */
function walkProblems(w, h, parts) {
  const out = [];
  const blocked = (x, y, z) => parts.some((o) => inside(o, x, y, z));
  // stairs: at most 45 degrees, head room for a 1.8 m player all along
  for (const [x0, z0, y0, x1, z1, y1, wd] of h.stairs) {
    const run = Math.hypot(x1 - x0, z1 - z0);
    if (Math.abs(y1 - y0) > run + 1e-6) out.push(`stair steeper than 45 degrees (${(y1 - y0).toFixed(2)} over ${run.toFixed(2)})`);
    const ux = (x1 - x0) / run, uz = (z1 - z0) / run, nx = -uz, nz = ux;
    // the ramp's walking surface really is there (just under the centreline, not above it)
    for (const t of [0.2, 0.5, 0.8]) {
      const sx = x0 + (x1 - x0) * t, sz = z0 + (z1 - z0) * t, sy = y0 + (y1 - y0) * t;
      if (!blocked(sx, sy - 0.08, sz)) out.push(`no ramp under the stair at t=${t}`);
      if (blocked(sx, sy + 0.12, sz)) out.push(`something on the stair surface at t=${t}`);
    }
    for (let t = 0.12; t <= 0.9; t += 0.13) {
      const sx = x0 + (x1 - x0) * t, sz = z0 + (z1 - z0) * t, sy = y0 + (y1 - y0) * t;
      for (const off of wd > 1.2 ? [-(wd / 2 - 0.45), 0, wd / 2 - 0.45] : [0]) {
        for (const up of [0.3, 1.0, 1.75]) {
          if (blocked(sx + nx * off, sy + up, sz + nz * off)) { out.push(`stair blocked at t=${t.toFixed(2)} off=${off.toFixed(2)} up=${up}`); break; }
        }
      }
    }
  }
  // storeys: every level height is reached from floor 0 through the stairs
  const levels = [];
  for (const l of h.levels) if (!levels.some((m) => Math.abs(m - l) < 0.05)) levels.push(l);
  const reached = new Set([0]);
  for (let pass = 0; pass < levels.length + 2; pass++) {
    for (const s of h.stairs) {
      const a = levels.findIndex((l) => Math.abs(l - s[2]) < 0.6), b = levels.findIndex((l) => Math.abs(l - s[5]) < 0.6);
      if (a >= 0 && b >= 0 && (reached.has(a) || reached.has(b))) { reached.add(a); reached.add(b); }
    }
  }
  levels.forEach((l, i) => { if (!reached.has(i)) out.push(`level ${i} (${(l - h.y).toFixed(2)} m) unreachable`); });
  // doors: tall enough, nothing in the opening or right outside it
  for (const [x, z, y, nx, nz, hgt, wd] of h.doors) {
    if (hgt < 2.35) out.push(`door only ${hgt} m tall`);
    const lx = -nz, lz = nx;
    for (const along of [-0.7, -0.3, 0, 0.4, 0.9]) {
      for (const lat of wd >= 1.6 ? [-(wd / 2 - 0.45), 0, wd / 2 - 0.45] : [0]) {
        for (const up of [0.3, 1.2, Math.min(2.1, hgt - 0.15)]) {
          const px = x + nx * along + lx * lat, pz = z + nz * along + lz * lat, py = y + up;
          let hit = blocked(px, py, pz);
          if (!hit && along > 0) w.objectsNear(px, pz, 6, (o) => { if ((o.kind === 'part' || o.kind === 'prop') && inside(o, px, py, pz)) { hit = true; return true; } return false; });
          if (hit) { out.push(`door at ${along}/${lat.toFixed(2)}/${up.toFixed(2)} blocked`); break; }
        }
      }
    }
  }
  if (!h.open && h.doors.length === 0 && h.archetype !== 'radio') out.push('no door');
  return out;
}

/** Structural checks shared by the 1.6 km island and the 1200 m fallback. */
function structural(w) {
  // places: all 26 names exactly once, then landmarks
  const named = w.regions.filter((g) => g.named);
  assert.deepEqual(named.map((g) => g.name).sort(), POI_NAMES.slice().sort(), 'all 26 named places');
  assert.equal(new Set(named.map((g) => g.name)).size, 26);
  assert.ok(w.regions.length - named.length >= 12, 'landmarks');
  for (const g of w.regions) {
    assert.ok(w.heightAt(g.x, g.z) > 0.5, `${g.name} on land`);
    assert.ok(BIOMES.includes(g.biome) && TIERS.includes(g.tier) && ['city', 'town', 'farm', 'outpost', 'landmark'].includes(g.kind), g.name);
  }
  const tiers = named.reduce((a, g) => { a[g.tier]++; return a; }, { hot: 0, normal: 0, quiet: 0 });
  assert.ok(tiers.hot >= 5 && tiers.hot <= 7 && tiers.normal >= 12 && tiers.normal <= 16, JSON.stringify(tiers));
  // named places don't sit on each other
  for (const a of named) for (const b of named) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > (a.r + b.r) * 0.6, `${a.name} / ${b.name}`);
  // spawn points
  for (const g of named) assert.ok(w.spawnPoints.filter((s) => s.region === g.id).length >= 8, `${g.name} spawn points`);
  for (const s of w.spawnPoints) {
    const h = w.heightAt(s.x, s.z);
    assert.ok(Math.abs(s.y - h) < 0.01 && h > 0, 'on the ground, on land');
    assert.ok(Math.abs(s.x) < w.half && Math.abs(s.z) < w.half);
    assert.equal(w.solidNear(s.x, s.y + 0.9, s.z, null, 0.3), false, 'not inside anything');
  }
  // buildings: no overlaps, no base below 1 m, parts inside their footprint
  const hs = w.houses;
  for (let i = 0; i < hs.length; i++) {
    const a = hs[i];
    assert.ok(a.base >= 1.0 || ['pier', 'bridge', 'ship'].includes(a.archetype) && a.y >= 1.0, `house ${i} ${a.archetype} base ${a.base}`);
    assert.ok(ARCHETYPES[a.archetype], a.archetype);
    for (let j = i + 1; j < hs.length; j++) {
      const b = hs[j];
      const ov = Math.abs(a.x - b.x) < a.hx + b.hx && Math.abs(a.z - b.z) < a.hz + b.hz;
      assert.ok(!ov, `houses ${i} (${a.archetype}) and ${j} (${b.archetype}) overlap`);
    }
    const [x0, z0, x1, z1] = a.bounds;
    assert.ok(x0 > a.x - a.hx - 1.6 && x1 < a.x + a.hx + 1.6 && z0 > a.z - a.hz - 1.6 && z1 < a.z + a.hz + 1.6, `house ${i} (${a.archetype}) parts stay on its footprint`);
  }
  // walking: every storey reachable by ramps of at most 45 degrees, every door clear
  const byHouse = partsByHouse(w);
  const problems = [];
  for (const h of hs) {
    const p = walkProblems(w, h, byHouse.get(h.id) || []);
    if (p.length) problems.push(`#${h.id} ${h.archetype} rot ${h.rot}: ${p.slice(0, 3).join('; ')}`);
  }
  assert.deepEqual(problems, [], `${problems.length} buildings with walking problems`);
  // loot and chests: on land, nothing solid half a metre up
  for (const l of [...w.lootSpots, ...w.chests]) {
    assert.ok(w.heightAt(l.x, l.z) > 0 && l.y > 0, `loot at ${l.x.toFixed(1)},${l.z.toFixed(1)} on land`);
    assert.ok(l.y >= w.heightAt(l.x, l.z) - 0.35, 'not under the ground');
    assert.equal(w.solidNear(l.x, l.y + 0.5, l.z), false, `loot at ${l.x.toFixed(1)},${l.y.toFixed(1)},${l.z.toFixed(1)} is free`);
    assert.ok(TIERS.includes(l.tier));
  }
  // the river: water cells connected from the snow to the sea
  const { N, heights, biome } = w;
  const BI = Object.fromEntries(BIOMES.map((k, i) => [k, i]));
  const seen = new Uint8Array(N * N);
  const q = [];
  const [sx, sz] = w.rivers[0].pts[0];
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
    const ix = Math.round((sx + w.half) / w.cell) + dx, iz = Math.round((sz + w.half) / w.cell) + dz;
    const i = iz * N + ix;
    if (heights[i] < 0 && biome[i] === BI.snow) { seen[i] = 1; q.push(i); }
  }
  assert.ok(q.length > 0, 'the river starts in the snow');
  let sea = false;
  while (q.length && !sea) {
    const i = q.pop();
    if (biome[i] === BI.ocean) { sea = true; break; }
    const ix = i % N, iz = (i / N) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
      const j = jz * N + jx;
      if (!seen[j] && heights[j] < 0) { seen[j] = 1; q.push(j); }
    }
  }
  assert.ok(sea, 'river water reaches the sea');
  // each land biome covers at least 3 % of the land
  const count = new Array(BIOMES.length).fill(0);
  let land = 0;
  for (let i = 0; i < N * N; i++) if (heights[i] > 0) { land++; count[biome[i]]++; }
  for (const b of BIOMES.slice(1)) assert.ok(count[BI[b]] / land >= 0.03, `${b} ${(100 * count[BI[b]] / land).toFixed(1)} % of the land`);
  // the contract's grids and lookups
  assert.equal(w.version, 2);
  for (const g of ['biome', 'biome2', 'blend', 'surface', 'roadMask']) assert.ok(w[g] instanceof Uint8Array && w[g].length === N * N, g);
  for (let i = 0; i < N * N; i += 97) assert.ok(w.surface[i] < SURFACES.length && w.biome[i] < BIOMES.length);
  for (const pad of w.pads) assert.ok(PADS.includes(pad.kind) && pad.y >= w.heightAt(pad.x, pad.z) - 0.3, 'pad on the ground or a roof');
  for (const o of w.objects) {
    if (o.kind === 'tree') assert.ok(SPECIES.includes(o.species) && SPECIES_TYPE[o.species] === o.type);
    else if (o.kind === 'part') assert.ok(LOOKS.includes(o.look) || Object.hasOwn(LOOK_ALIASES, o.look), o.look);
    else if (o.kind === 'prop') assert.ok(PROP_TYPES[o.type] && o.hx > 0 && o.hy > 0 && o.hz > 0 && Number.isFinite(o.yaw), o.type);
    else if (o.kind === 'decor') assert.ok(DECOR_TYPES.includes(o.type), o.type);
    else assert.equal(o.kind, 'rock');
    assert.ok(['wood', 'stone', 'metal'].includes(o.mat) || o.kind === 'decor', `${o.kind} mat ${o.mat}`);
  }
  for (const r of w.roads) {
    assert.ok(['road', 'dirt', 'street'].includes(r.kind) && r.w > 0 && r.pts.length >= 2);
    if (r.bridge) assert.ok(r.house >= 0 && w.houses[r.house].archetype === 'bridge', 'bridge piece has its bridge');
  }
}

// ------------------------------------------------------------------ tests
test('world v2: deterministic, with a pinned checksum, in under 600 ms', () => {
  // wall-clock and CPU time per run; the shared CI / dev VM is often oversubscribed, so the budget
  // is checked on the median wall time, or on the median CPU time when the machine is overloaded
  const times = [], cpus = [];
  // the first (cold) run compiles the generator; the budget is for the median of 3 runs after it
  const t0 = performance.now();
  let a = generateWorld(MAP.seed);
  const cold = performance.now() - t0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now(), c = process.cpuUsage();
    const w = generateWorld(MAP.seed);
    times.push(performance.now() - t);
    const cu = process.cpuUsage(c);
    cpus.push((cu.user + cu.system) / 1000);
    if (a) {
      assert.equal(w.checksum, a.checksum);
      assert.equal(w.objects.length, a.objects.length);
      assert.deepEqual(w.objects[w.objects.length - 1], a.objects[a.objects.length - 1]);
      assert.deepEqual(Array.from(w.heights.slice(80000, 80100)), Array.from(a.heights.slice(80000, 80100)));
    }
    a = w;
  }
  const med = (v) => v.slice().sort((x, y) => x - y)[1];
  console.log(`# generateWorld ${MAP.size} m: cold ${cold.toFixed(0)} ms, then wall ${times.map((t) => t.toFixed(0)).join(' / ')} ms (median ${med(times).toFixed(0)}), cpu ${cpus.map((t) => t.toFixed(0)).join(' / ')} ms (median ${med(cpus).toFixed(0)}), checksum ${a.checksum}, objects ${a.objects.length}`);
  assert.ok(med(times) <= 600 || med(cpus) <= 600, `median ${med(times).toFixed(0)} ms wall, ${med(cpus).toFixed(0)} ms cpu`);
  assert.equal(a.checksum, CHECKSUM, 'the pinned island (change CHECKSUM on purpose when the map changes)');
  assert.equal(a.version, 2);
  assert.equal(PROTOCOL >= 2, true);
  worlds.set(MAP.size, a);
});

test('world v2: scale, bus and drop numbers', () => {
  assert.deepEqual([MAP.size, MAP.res, MAP.islandRadius], [1600, 400, 640]);
  assert.deepEqual(BUS, { height: 230, speed: 42, length: 1500, forceDrop: 0.9 });
  for (const k of Object.keys(DROP)) assert.equal(PLAYER[k], DROP[k]);
  const w = world();
  assert.equal(w.N, 401);
  assert.equal(w.size, 1600);
});

test('world v2: counts within budget', () => {
  const w = world();
  const n = {};
  for (const o of w.objects) n[o.kind] = (n[o.kind] || 0) + 1;
  const counts = { buildings: w.houses.length, parts: n.part, trees: n.tree, rocks: n.rock, props: n.prop, decor: n.decor || 0, chests: w.chests.length, loot: w.lootSpots.length, pads: w.pads.length };
  console.log('# counts', JSON.stringify(counts));
  assert.ok(counts.buildings >= 250 && counts.buildings <= 320, `buildings ${counts.buildings}`);
  assert.ok(counts.parts <= 22000, `parts ${counts.parts}`);
  assert.ok(counts.trees <= 9000 && counts.trees >= 4000, `trees and bushes ${counts.trees}`);
  assert.ok(counts.rocks <= 2000, `rocks ${counts.rocks}`);
  assert.ok(counts.props <= 3000, `props ${counts.props}`);
  assert.ok(counts.decor <= 6000, `decor ${counts.decor}`);
  assert.ok(counts.chests >= 250 && counts.chests <= 350, `chests ${counts.chests}`);
  assert.ok(counts.loot >= 800 && counts.loot <= 1100, `loot spots ${counts.loot}`);
  assert.ok(counts.pads >= 20 && counts.pads <= 40, `pads ${counts.pads}`);
  for (const k of PADS) assert.ok(w.pads.some((p) => p.kind === k), k);
  assert.ok(w.lava.length >= 1);
  // about 18 building types and the landmarks, all used
  const archs = new Set(w.houses.map((h) => h.archetype));
  assert.ok(archs.size >= 25, `${archs.size} archetypes used: ${[...archs].join(' ')}`);
  // hot places: about a chest per building, floor loot on every storey
  const hot = w.houses.filter((h) => h.tier === 'hot' && !['bridge', 'pier'].includes(h.archetype));
  const hotChests = w.chests.filter((c) => c.tier === 'hot').length;
  assert.ok(hotChests >= hot.length * 0.8, `hot chests ${hotChests} for ${hot.length} hot buildings`);
});

test('world v2: structural checks (places, buildings, loot, river, biomes, spawns)', () => {
  structural(world());
});

test('world v2: a drop from the bus reaches 400 m sideways', () => {
  // mirrors mover.js: skydive (no dive) until glideHeight above the ground, then glide, from bus.y - 4 at vy -5
  const sim = (ground) => {
    let y = BUS.height - 4, vy = -5, vx = 0, x = 0, mode = 'skydive';
    const dt = 1 / 60;
    for (let t = 0; t < 120 && y > ground; t += dt) {
      if (mode === 'skydive' && y - ground < DROP.glideHeight) mode = 'glide';
      if (mode === 'skydive') { vy += (-DROP.skydiveFall - vy) * Math.min(1, dt * 1.5); vx += (DROP.skydiveSpeed - vx) * Math.min(1, dt * 1.6); } else { vy += (-DROP.glideFall - vy) * Math.min(1, dt * 2.5); vx += (DROP.glideSpeed - vx) * Math.min(1, dt * 1.4); }
      y += vy * dt; x += vx * dt;
    }
    return x;
  };
  for (const g of [0, 5, 20]) assert.ok(sim(g) >= 400, `ground ${g} m: ${sim(g).toFixed(0)} m`);
});

test('world v2: the 1200 m fallback island passes the same structural checks', () => {
  const w = world(1200);
  assert.equal(w.size, 1200);
  assert.equal(w.N, 301);
  assert.ok(w.houses.length >= 180, `${w.houses.length} buildings`);
  structural(w);
});

test('world v2: lookups and indexes', () => {
  const w = world();
  // regionAt finds Tilty Towers in Tilty Towers, nothing far out at sea
  const tt = w.regions.find((g) => g.name === 'Tilty Towers');
  assert.equal(w.regionAt(tt.x, tt.z).name, 'Tilty Towers');
  assert.equal(w.regionAt(w.half - 5, w.half - 5), null);
  assert.equal(w.biomeAt(w.half - 5, w.half - 5), 'ocean');
  // the chunk index holds every object once
  const seen = new Uint8Array(w.objects.length);
  for (let c = 0; c < w.chunks.nx * w.chunks.nz; c++) w.chunks.forEach(c, (id) => { seen[id]++; });
  assert.ok(seen.every((v) => v === 1));
  const o = w.objects[1234];
  let found = false;
  w.chunks.forEach(w.chunks.of(o.x, o.z), (id) => { if (id === o.id) found = true; });
  assert.ok(found);
  // every surface and biome shows up somewhere
  const surf = new Set(w.surface), bio = new Set(w.biome);
  for (const k of SURFACES) assert.ok(surf.has(SURFACES.indexOf(k)), `surface ${k}`);
  for (const k of BIOMES) assert.ok(bio.has(BIOMES.indexOf(k)), `biome ${k}`);
  // the roads mask: paved roads and dirt roads both exist; bridges sit over water
  assert.ok(w.roadMask.includes(1) && w.roadMask.includes(2));
  assert.ok(w.roads.some((r) => r.bridge), 'at least one bridge');
  for (const r of w.roads.filter((rr) => rr.bridge)) {
    const [[ax, az], [bx, bz]] = r.pts;
    assert.ok(w.heightAt((ax + bx) / 2, (az + bz) / 2) < 0.6, 'a bridge crosses water');
  }
});

test('map art: tree LODs within budget, colliders, props, writeBox, texture layers', async () => {
  const M = await import('../public/js/world/models.js');
  const tris = (g) => (g.trunk.index.count + g.leaves.index.count) / 3;
  for (const sp of SPECIES) {
    const [t0, t1, t2] = [0, 1, 2].map((l) => tris(M.treeGeometry(sp, l)));
    assert.ok(t0 <= 420 && t1 >= 40 && t1 <= 120 && t2 <= 12, `${sp}: ${t0} / ${t1} / ${t2} triangles`);
    assert.ok(Array.isArray(M.SPECIES_COLLIDERS[sp]) && M.SPECIES_INFO[sp], sp);
    for (const l of [0, 1, 2]) {
      const g = M.treeGeometry(sp, l);
      for (const part of [g.trunk, g.leaves]) for (const k of ['position', 'normal', 'uv', 'color']) assert.ok(part.attributes[k], `${sp} ${l} ${k}`);
      assert.ok(g.leaves.index.count > 0);
    }
  }
  assert.equal(tris(M.treeGeometry(0)), tris(M.treeGeometry('pine')), 'legacy types are their species');
  for (const b of BIOMES) assert.ok(Number.isInteger(M.ROCK_TINTS[b]), b);
  for (const t of [...Object.keys(PROP_TYPES), ...DECOR_TYPES, ...PADS]) {
    const g = M.propGeometry(t, 2);
    assert.ok(g.index.count > 0 && g.attributes.color && g.attributes.uv, t);
    g.computeBoundingBox();
    assert.ok(g.boundingBox.min.y > -0.2, `${t} stands on y = 0`);
  }
  // the typed-array fast path writes the same boxes as partGeometry
  const w = world();
  const parts = w.objects.filter((o) => o.kind === 'part').slice(0, 3000);
  const A = M.partArrays(parts.length, true);
  for (const o of parts) M.writePart(A, o, 0xffffff);
  assert.equal(A.v, parts.length * M.PART_VERTS);
  assert.equal(A.i, parts.length * M.PART_INDICES);
  for (let k = 0; k < parts.length; k += 37) {
    const o = parts[k];
    const g = M.partGeometry(o, 0xffffff);
    const P = g.attributes.position.array;
    let bx = Infinity, Bx = -Infinity, ax = Infinity, Ax = -Infinity;
    for (let i = 0; i < P.length; i += 3) { bx = Math.min(bx, P[i] + P[i + 1] + P[i + 2]); Bx = Math.max(Bx, P[i] + P[i + 1] + P[i + 2]); }
    for (let i = k * 72; i < (k + 1) * 72; i += 3) { ax = Math.min(ax, A.pos[i] + A.pos[i + 1] + A.pos[i + 2]); Ax = Math.max(Ax, A.pos[i] + A.pos[i + 1] + A.pos[i + 2]); }
    assert.ok(Math.abs(ax - bx) < 1e-3 && Math.abs(Ax - Bx) < 1e-3, `part ${o.id} (${o.look})`);
  }
  // a texture for every surface and look, tileable, lava with an emissive mask
  const { layerTexture } = await import('../public/js/gfx/texgen.js');
  for (const k of [...SURFACES, ...LOOKS]) {
    const img = layerTexture(k, 64);
    assert.ok(img.size === 64 && img.color.length === 64 * 64 * 4 && img.height.length === 64 * 64, k);
    let edge = 0, inner = 0;
    for (let y = 0; y < 64; y++) {
      for (let c = 0; c < 3; c++) {
        edge += Math.abs(img.color[(y * 64 + 63) * 4 + c] - img.color[(y * 64) * 4 + c]);
        inner += Math.abs(img.color[(y * 64 + 31) * 4 + c] - img.color[(y * 64 + 32) * 4 + c]);
      }
    }
    assert.ok(edge <= inner * 3 + 64 * 3 * 24, `${k} wraps around (edge ${edge}, inner ${inner})`);
  }
  const lava = layerTexture('lava', 64);
  assert.ok(lava.emissive && lava.emissive.length === 64 * 64 && Math.max(...lava.emissive) > 200);
});
