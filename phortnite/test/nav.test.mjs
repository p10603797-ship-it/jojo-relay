// Bot navigation (public/js/ai/nav.js): pure functions on a synthetic 1.6 km island with a river,
// bridges and cliffs, and on today's world (whatever generateWorld builds). At the end, the bot
// brain's pure parts (js/ai/goals.js, farsim.js, buildfight.js) with small fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Nav, PathFollower, F_WATER, F_BLOCK, F_HOUSE, F_CLIFF, F_STEEP, F_DOWN, STUCK_S, wpNode } from '../public/js/ai/nav.js';
import { generateWorld } from '../public/shared/worldgen.js';
import * as goals from '../public/js/ai/goals.js';
import { wantFar, farUpdate, FAR_IN, FAR_OUT } from '../public/js/ai/farsim.js';
import { ENV, WEAPONS } from '../public/shared/constants.js';
import { BuildFight, hasCone } from '../public/js/ai/buildfight.js';

// ------------------------------------------------------------------ a synthetic island
// 1600 m, 4 m cells: rolling land inside radius 700, a river from north to south carved to -2.5 m
// with three bridges, a 30 m mesa ringed by cliffs with one ramp up (gentle sides), and a cliff
// wall with a pass.
function synthWorld() {
  const size = 1600, res = 400, cell = size / res, N = res + 1, half = size / 2;
  const heights = new Float32Array(N * N);
  const riverX = (z) => 60 * Math.sin(z / 260);
  const H = (x, z) => {
    const r = Math.sqrt(x * x + z * z);
    if (r > 700) return -16;
    let h = 8 + 4 * Math.sin(x / 90) * Math.cos(z / 120);
    if (r > 640) h = -16 + (h + 16) * (700 - r) / 60;
    // the river: 24 m wide, carved below the water line
    const dr = Math.abs(x - riverX(z));
    if (dr < 12 && r < 690) h = -2.5; else if (dr < 20 && r < 690) h = Math.min(h, -2.5 + (dr - 12) * 1.2);
    // the mesa: a 30 m plateau (centre 360, -200, radius 90) with a ramp up its west side
    const mx = x - 360, mz = z + 200, md = Math.sqrt(mx * mx + mz * mz);
    if (md < 90) h = 38;
    else if (mx < 0 && md < 200) h = Math.max(h, 38 - (md - 90) * 0.3 - Math.max(0, Math.abs(mz) - 10) * 0.5);
    // a cliff wall from the west coast to x = -60 at z = 300, with a pass at x = -300
    if (z > 300 && z < 312 && x < -60 && Math.abs(x + 300) > 10) h = 40;
    return h;
  };
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) heights[iz * N + ix] = H(-half + ix * cell, -half + iz * cell);
  const heightAt = (x, z) => {
    const fx = (x + half) / cell, fz = (z + half) / cell;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    ix = Math.max(0, Math.min(res - 1, ix)); iz = Math.max(0, Math.min(res - 1, iz));
    const u = Math.max(0, Math.min(1, fx - ix)), v = Math.max(0, Math.min(1, fz - iz));
    const i = iz * N + ix;
    const h00 = heights[i], h10 = heights[i + 1], h01 = heights[i + N], h11 = heights[i + N + 1];
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };
  // a few solid blocks (a "town" of crates) east of the river
  const solids = [];
  for (let k = 0; k < 12; k++) solids.push({ x0: 150 + k * 14, x1: 156 + k * 14, z0: 40, z1: 52 });
  const solidNear = (x, y, z, d, pad = 0.35) => solids.some((s) => x > s.x0 - pad && x < s.x1 + pad && z > s.z0 - pad && z < s.z1 + pad && y < heightAt(x, z) + 3);
  const bridge = (z) => ({ kind: 'road', w: 8, bridge: true, pts: [[riverX(z) - 30, z, 9], [riverX(z) + 30, z, 9]] });
  const regions = [
    [-400, -350], [-300, 0], [-450, 450], [-200, 200], // west
    [300, 100], [450, -450], [200, 450], [500, 300],   // east
    [360, -200],                                       // on the mesa
    [-300, 400],                                       // north of the cliff wall
  ].map(([x, z], id) => ({ id, name: `R${id}`, x, z, r: 50, tier: 'normal', named: true }));
  return {
    size, res, cell, N, half, heights, heightAt, solidNear, regions, version: 2,
    roads: [bridge(-400), bridge(0), bridge(420)], rivers: [], lakes: [], pads: [], lava: [], houses: [],
  };
}

const SYN = synthWorld();
const TODAY = generateWorld();

/** Cells (4 m) of a route: [x, z, flags] sampled every 2 m (launch pad throws fly over). */
function routeCells(nav, pts) {
  const out = [];
  for (let k = 4; k < pts.length; k += 4) {
    if (nav.isPad(wpNode(pts[k - 1]), wpNode(pts[k + 3]))) continue;
    const ax = pts[k - 4], az = pts[k - 2], bx = pts[k], bz = pts[k + 2];
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 2));
    for (let j = 0; j <= n; j++) {
      const x = ax + ((bx - ax) * j) / n, z = az + ((bz - az) * j) / n;
      out.push([x, z, nav.flagsAt(x, z)]);
    }
  }
  return out;
}

/** Fine-grid ground components (4-neighbour) over cells without `bad` flags: who can walk to whom. */
function fineComponents(nav, bad) {
  const n = nav.nx, comp = new Int32Array(n * n).fill(-1), q = new Int32Array(n * n);
  let c = 0;
  for (let s = 0; s < n * n; s++) {
    if (nav.flags[s] & bad || comp[s] >= 0) continue;
    let h = 0, t = 0;
    q[t++] = s; comp[s] = c;
    while (h < t) {
      const u = q[h++], ux = u % n, uz = (u / n) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx && dz) continue; // no squeezing diagonally between two blocked cells
          const vx = ux + dx, vz = uz + dz;
          if (vx < 0 || vz < 0 || vx >= n || vz >= n) continue;
          const v = vz * n + vx;
          if (nav.flags[v] & bad || comp[v] >= 0) continue;
          comp[v] = c; q[t++] = v;
        }
      }
    }
    c++;
  }
  return (x, z) => { const o = nav.nearestOpen(x, z, 30); return o ? comp[nav.cellOf(o.x, o.z)] : -1; };
}

function built(world) {
  const nav = new Nav(world);
  const t0 = performance.now();
  nav.build();
  return { nav, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------ the synthetic island
test('nav: the synthetic 1.6 km island builds within 150 ms and 2 MB', () => {
  // (the best of 5 runs: other processes on a busy machine only ever add time)
  const runs = [built(SYN), built(SYN), built(SYN), built(SYN), built(SYN)];
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b), ms = sorted[0];
  const nav = runs[0].nav;
  console.log(`  synthetic build: best ${ms.toFixed(1)} ms (median ${sorted[2].toFixed(1)}), ${(nav.bytes() / 1e6).toFixed(2)} MB, ${nav.nn} blocks`);
  assert.ok(ms <= 150, `build took ${ms.toFixed(1)} ms`);
  assert.ok(nav.bytes() <= 2e6, `graph holds ${nav.bytes()} bytes`);
  // the river is water, the bridges dry, the mesa rim a cliff
  assert.ok(nav.flagsAt(60 * Math.sin(200 / 260), 200) & F_WATER, 'river');
  assert.equal(nav.flagsAt(SYN.roads[1].pts[0][0] + 30, 0) & F_WATER, 0, 'bridge deck');
  assert.ok(nav.flagsAt(360 - 90, -170) & F_CLIFF || nav.flagsAt(360, -200 + 90) & F_CLIFF, 'mesa rim');
});

test('nav: a route exists between every pair of region centres (synthetic island)', () => {
  const nav = new Nav(SYN);
  nav.build();
  const R = SYN.regions;
  let n = 0;
  for (const a of R) {
    for (const b of R) {
      if (a === b) continue;
      const pts = nav.route(a.x, SYN.heightAt(a.x, a.z), a.z, b.x, SYN.heightAt(b.x, b.z), b.z);
      assert.ok(pts && pts.length >= 4, `${a.name} -> ${b.name}`);
      const end = pts.length - 4;
      assert.ok(Math.hypot(pts[end] - b.x, pts[end + 2] - b.z) < 1e-6, 'ends at the goal');
      n++;
    }
  }
  assert.equal(n, R.length * (R.length - 1));
});

test('nav: routes cross the river only on bridges and avoid slopes over 40 degrees (synthetic)', () => {
  const nav = new Nav(SYN);
  nav.build();
  for (const a of SYN.regions) {
    for (const b of SYN.regions) {
      if (a === b) continue;
      const pts = nav.route(a.x, SYN.heightAt(a.x, a.z), a.z, b.x, SYN.heightAt(b.x, b.z), b.z);
      for (const [x, z, f] of routeCells(nav, pts)) {
        assert.equal(f & F_WATER, 0, `${a.name} -> ${b.name} swims at ${x.toFixed(0)}, ${z.toFixed(0)}`);
        assert.equal(f & (F_STEEP | F_DOWN | F_CLIFF | F_BLOCK), 0, `${a.name} -> ${b.name} climbs at ${x.toFixed(0)}, ${z.toFixed(0)} (flags ${f})`);
      }
    }
  }
  // the way onto the mesa is its ramp, and the way past the cliff wall its pass
  const up = nav.route(300, SYN.heightAt(300, 0), 0, 360, 38, -200);
  assert.ok(routeCells(nav, up).some(([x, z]) => x < 270 && Math.abs(z + 200) < 12), 'mesa by the ramp');
  const north = nav.route(-450, SYN.heightAt(-450, 200), 200, -450, SYN.heightAt(-450, 400), 400);
  assert.ok(routeCells(nav, north).some(([x, z]) => Math.abs(x + 300) < 14 && z > 296 && z < 316), 'wall by the pass');
});

test('nav: A* queries average at most 3 ms (synthetic island and today\'s world)', () => {
  for (const world of [SYN, TODAY]) {
    const nav = new Nav(world);
    nav.build();
    // places, and open spots spread over the island
    const pts = (world.regions || []).slice();
    for (let k = 0; k < 40; k++) {
      const a = k * 2.39996, r = world.size * 0.4 * Math.sqrt((k + 0.5) / 40);
      const o = nav.nearestOpen(Math.cos(a) * r, Math.sin(a) * r, 40);
      if (o) pts.push({ x: o.x, z: o.z });
    }
    let n = 0, ms = 0;
    for (let i = 0; i < pts.length && n < 300; i++) {
      for (let j = i + 1; j < pts.length && n < 300; j += 2) {
        const s = nav.nodeAt(pts[i].x, pts[i].z), g = nav.nodeAt(pts[j].x, pts[j].z);
        nav.cache.clear();
        const t0 = performance.now();
        nav.path(s, g);
        ms += performance.now() - t0;
        n++;
      }
    }
    console.log(`  ${world === SYN ? 'synthetic' : 'today'}: ${n} queries, ${(ms / n).toFixed(3)} ms average, max ${nav.stats.maxMs.toFixed(2)} ms`);
    assert.ok(n > 20);
    assert.ok(ms / n <= 3, `average ${(ms / n).toFixed(2)} ms`);
    // a search only runs when it will find a way (no whole-island searches that come back empty)
    assert.equal(nav.stats.fails, 0, 'canReach is exact');
  }
});

test('nav: the storm flow field leads every node into the circle within 10 ms', () => {
  const nav = new Nav(SYN);
  nav.build();
  const times = [];
  // best of six circles (a timing on a shared machine: one quiet run is the real cost)
  for (const [x, z, r] of [[200, 100, 150], [-100, -300, 90], [0, 400, 110], [300, -200, 130], [-200, 250, 100], [-300, 0, 120]]) {
    const t0 = performance.now();
    nav.flowTo(x, z, r);
    times.push(performance.now() - t0);
  }
  const ms = times.sort((a, b) => a - b)[0];
  console.log(`  flow field: best ${ms.toFixed(1)} ms (median ${times[3].toFixed(1)})`);
  assert.ok(ms <= 10, `flow field took ${ms.toFixed(1)} ms`);
  const f = nav.flowTo(-300, 0, 120);
  assert.equal(nav.flowTo(-300, 0, 120), f, 'cached per circle');
  // from the far east bank (across the river), downhill all the way in
  const s = nav.nodeAt(500, 300);
  const nodes = nav.flowPath(f, s);
  assert.ok(nodes && nodes.length > 10);
  for (let k = 1; k < nodes.length; k++) assert.ok(f.dist[nodes[k]] < f.dist[nodes[k - 1]]);
  const last = nodes[nodes.length - 1];
  assert.ok(Math.hypot(nav.nodeX[last] + 300, nav.nodeZ[last]) <= 120 * 0.85 + 12, 'ends inside');
  // ...over a bridge, not through the river
  let wet = false;
  for (let k = 1; k < nodes.length; k++) if (nav.lineWet(nav.nodeX[nodes[k - 1]], nav.nodeZ[nodes[k - 1]], nav.nodeX[nodes[k]], nav.nodeZ[nodes[k]])) wet = true;
  assert.equal(wet, false, 'rotates over a bridge');
});

test('nav: the A* budget allows 6 queries a second across all bots, paths are cached', () => {
  const nav = new Nav(SYN);
  nav.build();
  let ok = 0;
  for (let i = 0; i < 20; i++) if (nav.take(10)) ok++;
  assert.equal(ok, 6, 'a burst of 6');
  assert.equal(nav.take(10.1), false);
  assert.equal(nav.take(10 + 1 / 6 + 0.01), true, 'one more a sixth of a second later');
  const s = nav.nodeAt(-400, -350), g = nav.nodeAt(450, -450);
  const a = nav.path(s, g), q = nav.stats.queries;
  assert.equal(nav.path(s, g), a, 'second query comes from the cache');
  assert.equal(nav.stats.queries, q);
});

test('nav: a walker that gets stuck gives up on that link for 30 s and goes another way', () => {
  const nav = new Nav(SYN);
  nav.build();
  const f = new PathFollower(nav);
  // walk from the west bank to the east bank; an invisible wall blocks the middle bridge
  let x = -150, z = 0, t = 0;
  f.goal(300, SYN.heightAt(300, 100), 100);
  const wall = (nx) => Math.abs(nx - SYN.roads[1].pts[0][0]) < 2 && Math.abs(z) < 20;
  let arrived = false, blockedSeen = false;
  for (let i = 0; i < 60 * 240 && !arrived; i++) {
    t += 1 / 60;
    const r = f.step(x, SYN.heightAt(x, z), z, t, 1 / 60);
    if (r === 0) { arrived = true; break; }
    assert.notEqual(r, -1, 'never gives up while another bridge exists');
    const dx = f.tx - x, dz = f.tz - z, l = Math.hypot(dx, dz) || 1;
    const nx = x + (dx / l) * 6.2 / 60, nz = z + (dz / l) * 6.2 / 60;
    if (!wall(nx)) { x = nx; z = nz; }
    if (f.blocked.size) blockedSeen = true;
  }
  assert.ok(blockedSeen, `blocked a link after ${STUCK_S} s without progress`);
  assert.ok(arrived, `arrived (at ${x.toFixed(0)}, ${z.toFixed(0)})`);
});

test('nav: buildings with doors are entered through the door and climbed by their stairs', () => {
  // a 12 x 12 m two-storey box with a door on its west side and a flight of stairs inside
  const house = {
    id: 0, x: 0, z: -300, y: 8, bounds: [-6, -306, 6, -294], levels: [8, 11.2], top: 14,
    doors: [[-6, -300, 8, -1, 0, 2.4, 2]], stairs: [[2, -303, 8, 2, -297, 11.2, 1.6]],
  };
  const world = { ...SYN, houses: [house] };
  world.solidNear = (x, y, z, d, pad) => SYN.solidNear(x, y, z, d, pad) || (x > -6.5 && x < 6.5 && z > -306.5 && z < -293.5 && (Math.abs(x) > 5.5 || Math.abs(z + 300) > 5.5));
  const nav = new Nav(world);
  nav.build();
  assert.ok(nav.roomAt(0, -300), 'inside the room');
  assert.ok(nav.flagsAt(0, -300) & F_HOUSE);
  // from the east (around the building) to the upstairs floor
  const pts = nav.route(40, SYN.heightAt(40, -300), -300, 3, 11.2, -296);
  assert.ok(pts);
  const n = pts.length / 4;
  const wp = (k) => [pts[k * 4], pts[k * 4 + 1], pts[k * 4 + 2]];
  const iOut = [...Array(n).keys()].find((k) => Math.abs(wp(k)[0] + 8.4) < 0.01);
  assert.ok(iOut >= 0, 'goes to the outside of the door');
  assert.ok(Math.abs(wp(iOut + 1)[0] + 4.6) < 0.01, 'then just inside it');
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  assert.ok(near(wp(iOut + 2), [2, 8, -304.3]), 'then lined up a step before the stairs');
  assert.deepEqual(wp(iOut + 3), [2, 8, -303], 'then the foot of the stairs');
  assert.deepEqual(wp(iOut + 4), [2, 11.2, -297], 'then their head');
  assert.ok(near(wp(iOut + 5), [2, 11.2, -295.8]), 'and a step on');
  // never through the walls on the way round
  for (const [, , f] of routeCells(nav, pts.slice(0, (iOut + 1) * 4))) assert.equal(f & (F_HOUSE | F_BLOCK), 0);
  // and out again: down the stairs (lined up at their head), through the door
  const out = nav.route(3, 11.2, -296, -40, SYN.heightAt(-40, -300), -300);
  assert.deepEqual([out[4], out[5], out[6]], [2, 11.2, -297]);
  assert.deepEqual([out[8], out[9], out[10]], [2, 8, -303]);
  // stairs that start against a wall (as the generated buildings' do, 0.2 m off the back wall):
  // stepped onto from their open side, half a metre up, where the edge is low enough to step on
  const wallFlight = { ...nav.rooms[0], stairs: [[-5.3, -305, 8, -0.5, -305, 11.2, 1.7]] };
  const leg = [];
  nav.roomLeg(wallFlight, 8, 11.2, 0, 11.2, -300, leg);
  assert.equal(leg.length, 16, 'four waypoints');
  const [ax, ay, az] = leg, [fx, fy, fz] = leg.slice(4);
  assert.ok(Math.abs(ax - -4.8) < 1e-6 && ay === 8 && Math.abs(az - (-305 + 1.75)) < 1e-6, `lined up beside the stairs (${ax}, ${ay}, ${az})`);
  assert.ok(Math.abs(fx - -4.8) < 1e-6 && Math.abs(fy - (8 + 3.2 / 4.8 * 0.5)) < 1e-6 && fz === -305, 'stepped onto them half a metre up');
  assert.deepEqual(leg.slice(8, 11), [-0.5, 11.2, -305], 'then their head');
  assert.ok(Math.abs(leg[12] - 0.7) < 1e-6 && leg[13] === 11.2, 'and a step on');
});

// ------------------------------------------------------------------ today's world
test('nav: today\'s world builds within budget and connects its places', () => {
  const runs = [built(TODAY), built(TODAY), built(TODAY)];
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b), ms = sorted[0];
  const nav = runs[0].nav;
  console.log(`  today (${TODAY.size} m, version ${TODAY.version}): build best ${ms.toFixed(1)} ms (median ${sorted[1].toFixed(1)}), ${(nav.bytes() / 1e6).toFixed(2)} MB`);
  assert.ok(ms <= 150, `build took ${ms.toFixed(1)} ms`);
  assert.ok(nav.bytes() <= 2e6);
  // every pair of places on the same ground (walls, cliffs and slopes too steep to climb aside) is
  // connected; a place on a plateau ringed by cliffs is reachable only from the bus (none on the
  // 640 m island), and walking down from it is checked below
  const ground = fineComponents(nav, F_BLOCK | F_HOUSE | F_CLIFF | F_DOWN);
  const dry = fineComponents(nav, F_BLOCK | F_HOUSE | F_CLIFF | F_WATER);
  const flat = fineComponents(nav, F_BLOCK | F_HOUSE | F_CLIFF | F_STEEP | F_DOWN);
  const R = TODAY.regions;
  let pairs = 0, skipped = 0, wetDetour = 0, steepRoutes = 0;
  for (const a of R) {
    for (const b of R) {
      if (a === b) continue;
      if (ground(a.x, a.z) !== ground(b.x, b.z)) { skipped++; continue; }
      const pts = nav.route(a.x, TODAY.heightAt(a.x, a.z), a.z, b.x, TODAY.heightAt(b.x, b.z), b.z);
      assert.ok(pts, `${a.name} -> ${b.name}`);
      pairs++;
      const cells = routeCells(nav, pts);
      // over 45 degrees (walking down) only where the flat ground doesn't connect the two places,
      // or for a step or two (a steep bit of road): at most 8 m of a route
      if (flat(a.x, a.z) === flat(b.x, b.z)) {
        const steep = cells.filter(([, , f]) => f & (F_DOWN | F_CLIFF)).length * 2;
        assert.ok(steep <= 8, `${a.name} -> ${b.name}: ${steep} m on slopes over 45 degrees`);
        if (steep) steepRoutes++;
      }
      // wet only when dry land doesn't connect them, or the bridge is a long way round (a swim
      // across a river beats a detour of hundreds of metres)
      if (dry(a.x, a.z) === dry(b.x, b.z) && cells.some(([, , f]) => f & F_WATER)) wetDetour++;
    }
  }
  // ...and from every place, high or low, there is a way down to the biggest stretch of ground
  let down = 0;
  const sizes = new Map();
  for (const r of R) sizes.set(ground(r.x, r.z), (sizes.get(ground(r.x, r.z)) || 0) + 1);
  const main = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const hub = R.find((r) => ground(r.x, r.z) === main);
  for (const a of R) {
    if (ground(a.x, a.z) === main) continue;
    assert.ok(nav.route(a.x, TODAY.heightAt(a.x, a.z), a.z, hub.x, TODAY.heightAt(hub.x, hub.z), hub.z), `${a.name} has a way down`);
    down++;
  }
  console.log(`  today: ${pairs} place pairs routed, ${skipped} skipped (no ground connection; ${down} places only reached from the air, all with a way down), ${wetDetour} swim a river instead of a long detour, ${steepRoutes} take a steep step`);
  assert.ok(steepRoutes <= pairs * 0.03, 'at most 3% take a steep step');
  assert.ok(R.length - down >= R.length * 0.9, 'nearly every place is on the same ground');
  assert.ok(wetDetour <= pairs * 0.01, 'at most 1% swim where a bridge exists');
});

// ------------------------------------------------------------------ the bot brain's pure parts
// js/ai/goals.js (what the mode wants), js/ai/farsim.js (who gets the cheap simulation) and
// js/ai/buildfight.js (piece pacing and the rules), with small fakes instead of a real Game.

function fakeGame(rules = {}, extra = {}) {
  const g = {
    phase: 'match', time: 0, rules: { win: 'last', build: 'on', pvp: true, ...rules }, modeState: {}, roles: new Map(),
    world: { data: { heightAt: () => 5, size: 640 } }, bots: new Map(), remotes: new Map(), me: null, area: null,
    storm: { state: null }, spectateId: 0, camera: { position: { x: 0, y: 0, z: 0 } }, teams: new Map(),
    friendly(a, b) { return a !== b && (this.teamOf(a) === this.teamOf(b)); },
    teamOf(id) { const a = this.actorById(id); return a && a.team !== undefined ? a.team : id; },
    roleOf(id) { return this.roles.get(id) ?? null; },
    actorById(id) { if (this.me && this.me.id === id) return this.me; return this.bots.get(id) || this.remotes.get(id) || null; },
    ...extra,
  };
  return g;
}
function fakeActor(g, id, x, z, o = {}) {
  const a = {
    id, game: g, pos: { x, y: 5, z }, alive: true, inBus: false, isBot: true, team: o.team, far: false, mode: 'ground', time: 0,
    brain: { farChkT: 0, farWant: false, hurtNearT: -99, skill: 0.5, easy: false },
    build: { busy: false }, nav: { ready: true },
    isEnemy(b) { return b !== this && b.alive && !g.friendly(this.id, b.id); },
    ...o,
  };
  return a;
}

test('bots: the mode decides the goal (hill, Juggernaut, zombies, survivors) and who is worth shooting', () => {
  const out = {};
  // King of the hill: onto the hill, and whoever stands on it is the target
  let g = fakeGame({ win: 'koth' }, { modeState: { g: { hill: { x: 40, z: -20, r: 9 } } } });
  let bot = fakeActor(g, 1, 0, 0);
  g.bots.set(1, bot);
  assert.equal(goals.modeGoal(bot, out), 'hill');
  assert.ok(Math.hypot(out.x - 40, out.z + 20) < 9);
  assert.equal(goals.targetBonus(bot, fakeActor(g, 2, 41, -21)) > 0, true);
  assert.equal(goals.targetBonus(bot, fakeActor(g, 3, 80, 80)), 0);
  // Juggernaut: everyone hunts the Juggernaut
  g = fakeGame({ win: 'juggernaut' }, { modeState: { g: { j: 7 } } });
  bot = fakeActor(g, 1, 0, 0);
  const jugg = fakeActor(g, 7, 100, 50);
  g.bots.set(1, bot); g.bots.set(7, jugg);
  assert.equal(goals.modeGoal(bot, out), 'hunt');
  assert.deepEqual([out.x, out.z], [100, 50]);
  assert.equal(goals.targetBonus(bot, jugg), 45);
  assert.equal(goals.modeGoal(jugg, out), '', 'the Juggernaut plays as usual');
  // Infection: zombies chase the nearest survivor and never loot; survivors stick together
  g = fakeGame({ win: 'infection' });
  const z = fakeActor(g, 1, 0, 0, { team: 2 }), s1 = fakeActor(g, 2, 30, 0, { team: 1 }), s2 = fakeActor(g, 3, 90, 0, { team: 1 }), s3 = fakeActor(g, 4, 90, 40, { team: 1 });
  for (const a of [z, s1, s2, s3]) g.bots.set(a.id, a);
  g.roles.set(1, 'zombie');
  assert.equal(goals.isHunter(z), true);
  assert.equal(goals.wantsLoot(z), false);
  assert.equal(goals.modeGoal(z, out), 'hunt');
  assert.equal(out.x, 30, 'the nearest survivor');
  assert.equal(goals.wantsLoot(s1), true);
  assert.equal(goals.modeGoal(s1, out), 'group');
  assert.ok(out.x > 60, 'toward the other survivors');
  // Gun game: the ladder gives the guns; Playground: nobody is a target
  assert.equal(goals.wantsLoot(fakeActor(fakeGame({ win: 'gungame' }), 1, 0, 0)), false);
  assert.equal(goals.passive(fakeGame({ pvp: false })), true);
  assert.equal(goals.passive(fakeGame()), false);
  // the play area
  g = fakeGame({}, { area: { x: 100, z: 0, r: 50 } });
  assert.equal(goals.inArea(g, 120, 10), true);
  assert.equal(goals.inArea(g, 0, 0), false);
});

test('bots: a human teammate within reach is followed when there is nothing else to do', () => {
  const out = {};
  const g = fakeGame({ teams: 2 });
  const bot = fakeActor(g, 1, 0, 0, { team: 1 });
  const me = fakeActor(g, 2, 40, 0, { team: 1, isBot: false });
  g.bots.set(1, bot); g.me = me;
  assert.equal(goals.modeGoal(bot, out), 'follow');
  assert.ok(out.x > 25 && out.x < 40, 'just short of them');
  me.team = 2;
  assert.equal(goals.modeGoal(bot, out), '', 'not an enemy');
});

test('bots: far from every human (and the camera) a bot gets the cheap simulation', () => {
  const g = fakeGame();
  const me = fakeActor(g, 2, 0, 0, { isBot: false });
  g.me = me;
  const bot = fakeActor(g, 1, FAR_OUT + 20, 0);
  g.bots.set(1, bot);
  assert.equal(wantFar(bot, 0.016), true);
  // coming back within FAR_OUT isn't enough to wake it, within FAR_IN is
  bot.far = true;
  bot.pos.x = (FAR_IN + FAR_OUT) / 2; bot.brain.farChkT = 0; g.time += 1;
  assert.equal(wantFar(bot, 0.016), true, 'hysteresis');
  bot.pos.x = FAR_IN - 5; bot.brain.farChkT = 0; g.time += 1;
  assert.equal(wantFar(bot, 0.016), false);
  // the camera counts as a human (spectating), and so does being shot by someone nearby
  bot.far = false; bot.pos.x = 500; bot.brain.farChkT = 0; g.time += 1;
  g.camera.position.x = 450;
  assert.equal(wantFar(bot, 0.016), false, 'the camera is close');
  g.camera.position.x = 0; bot.brain.farChkT = 0; g.time += 1; bot.time = 10; bot.brain.hurtNearT = 9;
  assert.equal(wantFar(bot, 0.016), false, 'just shot by someone nearby');
  bot.brain.hurtNearT = -99; bot.brain.farChkT = 0; g.time += 1;
  g.spectateId = 1;
  assert.equal(wantFar(bot, 0.016), false, 'spectated');
  g.spectateId = 0; g.phase = 'bus'; bot.brain.farChkT = 0;
  assert.equal(wantFar(bot, 0.016), false, 'only in the match');
});

test('bots: a far bot low on materials stops at a tree it passes and harvests it with real swings', () => {
  const sent = [];
  let treeUp = true;
  const g = fakeGame({}, { send: (m) => sent.push(m), loot: { items: new Map() }, nearestChest: () => null });
  g.world.isAlive = () => treeUp;
  g.world.data.objects = [];
  g.world.data.objects[7] = { id: 7, kind: 'tree', x: 3, y: 5, z: 0 };
  const mats = { wood: 0, stone: 0, metal: 0 };
  let planned = 0;
  const bot = fakeActor(g, 1, 0, 0, {
    far: true, cool: 0, flags: 0, pitch: 0, yaw: 0, inv: { mats, slots: [] },
    brain: { farThinkT: 0, farHarv: -1, farHealT: -1, farTarget: null, farCoverT: -99, hurtT: -99, planT: 5, goalT: 5, matsWant: 150, destKind: '', skill: 0.5, easy: false, persona: { build: 0.5 } },
    stormUrgency: () => 0, healSlot: () => -1, hasGun: () => true, current: () => ({ k: 'ar' }),
    totalMats: () => mats.wood + mats.stone + mats.metal, addMats(k, n) { mats[k] += n; },
    nearestTree: (r) => (r >= 3 && treeUp ? 7 : null), planTravel() { planned++; },
    mover: { vel: { set() {} }, pos: null }, nav: { ready: true, groundY: () => 5 }, animate() {},
  });
  bot.mover.pos = bot.pos;
  g.bots.set(1, bot);
  for (let i = 0; i < 3 * 60; i++) farUpdate(bot, 1 / 60);
  const swings = sent.filter((m) => m.t === 'od' && m.o === 7 && m.id === 1);
  // a pickaxe's rate (1.7 swings a second) after a moment to line up: 4 or 5 in 3 s
  assert.ok(swings.length >= 4 && swings.length <= 5, `${swings.length} swings`);
  assert.equal(swings[0].d, WEAPONS.pickaxe.dmg[0] * WEAPONS.pickaxe.struct, 'a pickaxe hit');
  assert.equal(mats.wood, swings.length * ENV.harvest.wood, 'the yield a player gets');
  assert.equal(planned, 0, 'stood still while harvesting');
  // the tree falls: on our way again
  treeUp = false;
  for (let i = 0; i < 90; i++) farUpdate(bot, 1 / 60);
  assert.equal(bot.brain.farHarv, -1);
  assert.ok(planned > 0, 'planning the way on');
  // with building off (or plenty of materials) nobody stops for trees
  g.rules.build = 'off'; treeUp = true; sent.length = 0;
  for (let i = 0; i < 3 * 60; i++) farUpdate(bot, 1 / 60);
  assert.equal(sent.filter((m) => m.t === 'od').length, 0);
});

test('bots: build fights place a piece every 0.1-0.3 s, box up with a roof, and obey the build rule', () => {
  const placed = [];
  const g = fakeGame();
  const bot = fakeActor(g, 1, 0, 0, {
    brain: { skill: 0.9, easy: false }, healT: -1, time: 0,
    canAct: () => true, autoMat: () => true,
    placeAt(type, yaw, pitch) { placed.push({ type, yaw, pitch, t: this.time }); return true; },
  });
  const B = new BuildFight(bot);
  assert.equal(B.start('box', 0), true);
  for (let i = 0; i < 300 && B.busy; i++) { bot.time += 1 / 60; B.update(1 / 60); }
  assert.equal(placed.length, 5);
  assert.deepEqual(placed.slice(0, 4).map((p) => p.type), ['w', 'w', 'w', 'w']);
  assert.equal(placed[4].type, hasCone() ? 'c' : 'f', 'a cone roof when the game has cones');
  assert.ok(placed[4].pitch > 0.55, 'the roof goes above our head');
  for (let i = 1; i < placed.length; i++) assert.ok(placed[i].t - placed[i - 1].t >= 0.1 - 1e-9, 'never faster than one piece every 0.1 s');
  assert.ok(placed[4].t - placed[0].t <= 4 * 0.3 + 0.05);
  // a slow, easy bot builds more slowly; and nobody builds when the rules say no
  g.rules.build = 'off';
  assert.equal(B.start('wall', 0), false);
});
