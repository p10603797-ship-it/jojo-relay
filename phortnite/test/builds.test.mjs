// Build 2.0: the cone piece and build edits (door / window / arch / half wall / floor hole).
// The edits Room plugin is driven through the shared Room (the same code runs solo, on the Node
// server and on a P2P host). Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BuildGrid, pieceKey, parseKey, corners, edges, piecePose, PIECE_TYPES, CONE_RISE,
  EDIT_FULL, EDIT_PRESETS, editAllowed, editOf, editBoxes, floorHoleFor,
} from '../public/shared/buildgrid.js';
import { BUILD, PROTOCOL } from '../public/shared/constants.js';
import { ROOM_PLUGINS } from '../public/shared/plugins/index.js';
import { edits } from '../public/shared/plugins/edits.js';
import { getWorld } from '../public/shared/room.js';
import { makeRoom } from './helpers/roomharness.mjs';

const C = BUILD.cell, L = BUILD.level;
const mk = (t, cx, cy, cz, o, d = 0) => { const k = pieceKey(t, cx, cy, cz, o); return Object.assign(parseKey(k), { k, d }); };

// ------------------------------------------------------------------ the cone
test('cone keys parse, round-trip and stay inside the grid bounds', () => {
  assert.ok(PIECE_TYPES.includes('c'));
  const p = parseKey('c3,1,-7');
  assert.deepEqual(p, { t: 'c', cx: 3, cy: 1, cz: -7 });
  assert.equal(pieceKey('c', 3, 1, -7), 'c3,1,-7');
  assert.equal(parseKey('c1,2'), null, 'needs three numbers');
  assert.equal(parseKey('c1,99,2'), null, 'level out of range');
  assert.equal(parseKey('c999999,0,0'), null, 'cell out of range');
  assert.equal(parseKey('x1,2,3'), null, 'unknown type');
  // it sits like a floor: same corners, so the same four edges
  assert.deepEqual(corners(mk('c', 2, 1, 5)), corners(mk('f', 2, 1, 5)));
  assert.deepEqual(edges(mk('c', 2, 1, 5)), edges(mk('f', 2, 1, 5)));
  // the pose is the centre of its base
  assert.deepEqual(piecePose(mk('c', 2, 1, 5)), { x: 2 * C + C / 2, y: L, z: 5 * C + C / 2 });
  assert.equal(CONE_RISE, 2);
});

test('a cone is supported on a floor, a wall top and a ramp end, and collapses when its support goes', () => {
  const setup = () => new BuildGrid(() => 0, () => false); // flat ground at y = 0, no scenery
  // a roof on a two-storey wall
  {
    const g = setup();
    const w0 = mk('w', 0, 0, 0, 'x'), w1 = mk('w', 0, 1, 0, 'x'), cone = mk('c', 0, 2, 0);
    for (const p of [w0, w1]) { assert.ok(g.canSupport(p)); g.add(p); }
    assert.ok(g.canSupport(cone), 'a cone sits on a wall top');
    g.add(cone);
    g.remove(w1.k);
    assert.deepEqual(g.collapseFrom([w1]), [cone.k], 'no wall, no roof');
  }
  {
    const g = setup();
    const ramp = mk('r', 0, 0, 0, undefined, 0), cone = mk('c', 0, 1, 1);
    g.add(ramp);
    assert.ok(g.canSupport(cone), 'a cone hangs off the top edge of a ramp');
    g.add(cone);
    g.remove(ramp.k);
    assert.deepEqual(g.collapseFrom([ramp]), [cone.k]);
  }
  {
    const g = setup();
    const w = mk('w', 4, 0, 4, 'z'), floor = mk('f', 4, 1, 4), cone = mk('c', 4, 1, 4), coneSide = mk('c', 5, 1, 4);
    g.add(w);
    assert.ok(g.canSupport(floor));
    g.add(floor);
    assert.ok(g.canSupport(cone), 'a floor and a cone can share a cell (roof over the floor)');
    g.add(cone);
    assert.ok(g.canSupport(coneSide), 'a cone next to a floor shares its edge');
    g.add(coneSide);
    g.remove(w.k);
    assert.deepEqual(new Set(g.collapseFrom([w])), new Set([floor.k, cone.k, coneSide.k]));
  }
  {
    const g = setup();
    assert.equal(g.canSupport(mk('c', 9, 8, 9)), false, 'a cone in the sky has nothing to stand on');
    assert.ok(g.canSupport(mk('c', 9, 0, 9)), 'a cone on the ground is grounded');
  }
});

// ------------------------------------------------------------------ edit presets
test('edit presets: the allow-list holds (presets only, walls and floors only)', () => {
  const w = EDIT_PRESETS.w, f = EDIT_PRESETS.f;
  assert.equal(EDIT_FULL.w, 0x1ff);
  assert.equal(EDIT_FULL.f, 0xf);
  assert.equal(w.door, 0x1ff & ~((1 << 1) | (1 << 4)));
  assert.equal(w.window, 0x1ff & ~(1 << 4));
  assert.equal(w.arch, 0x1ff & ~((1 << 1) | (1 << 3) | (1 << 4) | (1 << 5)));
  assert.equal(w.half, 0x1ff & ~((1 << 6) | (1 << 7) | (1 << 8)));
  for (const e of Object.values(w)) assert.ok(editAllowed('w', e));
  for (const e of Object.values(f)) assert.ok(editAllowed('f', e));
  // every other mask is refused, for every type
  let okW = 0;
  for (let e = -2; e < 0x400; e++) if (editAllowed('w', e)) okW++;
  assert.equal(okW, 5);
  for (const t of ['r', 'c', 'x', undefined]) for (const e of [0, 1, 0xf, 0x1ff, w.door]) assert.equal(editAllowed(t, e), false, `${t}:${e}`);
  for (const e of [w.door + 0.5, '493', null, undefined, NaN, 0, 0x1ff | 0x200]) assert.equal(editAllowed('w', e), false, String(e));
  assert.equal(editAllowed('f', w.window), false, 'a wall preset is not a floor preset');
  // tiles: a door keeps 7 of 9, a hole 3 of 4; the full piece has no tile list
  assert.equal(editBoxes('w', w.door).length, 7);
  assert.equal(editBoxes('w', w.arch).length, 5);
  assert.equal(editBoxes('f', f.hole2).length, 3);
  assert.equal(editBoxes('w', 0x1ff), null);
  assert.equal(editBoxes('r', 1), null);
  // the window tile is the centre: no box covers the wall's middle
  for (const [cx, cy, , hx, hy] of editBoxes('w', w.window)) assert.ok(Math.abs(cx) > hx - 1e-9 || Math.abs(cy) > hy - 1e-9);
  // floor holes open the quarter nearest the editor
  const fl = mk('f', 2, 0, 3);
  assert.equal(floorHoleFor(fl, 2 * C + 0.5, 3 * C + 0.5), f.hole0);
  assert.equal(floorHoleFor(fl, 3 * C - 0.5, 3 * C + 0.5), f.hole1);
  assert.equal(floorHoleFor(fl, 2 * C + 0.5, 4 * C - 0.5), f.hole2);
  assert.equal(floorHoleFor(fl, 3 * C - 0.5, 4 * C - 0.5), f.hole3);
  assert.equal(editOf(fl), 0xf);
  assert.equal(editOf({ t: 'w', e: w.door }), w.door);
  assert.equal(editOf({ t: 'r' }), 0);
});

// ------------------------------------------------------------------ the 'be' room handler
/**
 * A flat, open grid cell on whatever island the room runs (today's or the big map): ground level
 * lv (a wall at lv stands on the terrain, a floor at lv + 1 does not).
 */
function flatSpot() {
  const w = getWorld();
  const pts = [...(w.spawns || []), ...(w.spawnPoints || []), { x: 0, z: 0 }];
  for (const s0 of pts) {
    const bx = Math.floor(s0.x / C), bz = Math.floor(s0.z / C);
    for (let r = 0; r < 12; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = bx + dx, cz = bz + dz;
        const hs = [];
        for (let i = -1; i <= 2; i++) for (let j = -1; j <= 2; j++) hs.push(w.heightAt((cx + i) * C, (cz + j) * C));
        const lo = Math.min(...hs), hi = Math.max(...hs);
        if (lo < 1.5 || hi - lo > 1.2) continue;
        const lv = Math.floor((lo + 0.3) / L);
        if ((lv + 1) * L <= hi + 0.5) continue;
        let solid = false;
        for (let i = -1; i <= 2 && !solid; i++) for (let j = -1; j <= 2 && !solid; j++) for (const y of [lv * L + 1, (lv + 1) * L, (lv + 1) * L + 1.5]) if (w.solidNear((cx + i) * C, y, (cz + j) * C)) solid = true;
        if (solid) continue;
        return { cx, cz, lv, x: cx * C + C / 2, z: cz * C + C / 2, y: w.heightAt(cx * C + C / 2, cz * C + C / 2) };
      }
    }
  }
  throw new Error('no flat open cell found');
}
const S = flatSpot();
// keys around the spot: K.wall = the wall on its +z edge, K.floor / K.cone one level up, …
const K = {
  wall: pieceKey('w', S.cx, S.lv, S.cz + 1, 'x'),
  floor: pieceKey('f', S.cx, S.lv + 1, S.cz),
  cone: pieceKey('c', S.cx, S.lv + 1, S.cz),
  ramp: pieceKey('r', S.cx + 1, S.lv, S.cz),
  coneLow: pieceKey('c', S.cx, S.lv, S.cz - 1),
  far: pieceKey('w', S.cx + 9, S.lv, S.cz + 9, 'x'),
};

/** A party of two in the warm-up, both standing in that cell. */
function party() {
  assert.ok(ROOM_PLUGINS.includes(edits), 'the edits plugin is a room plugin');
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  const at = (c, x, z) => H.send(c, { t: 'u', s: [x, S.y + 0.1, z, 0, 0, 0, 0, 0, 0, 'pickaxe', 0] });
  at(a, S.x, S.z); at(b, S.x + 1, S.z);
  return { H, a, b, at };
}

test("'be' through the shared Room: the builder edits, everyone sees it, junk and strangers are refused", () => {
  const { H, a, b } = party();
  H.send(a, { t: 'b', k: K.wall, m: 'wood' });
  assert.ok(H.last(b, 'b+'), 'the wall is built');
  const door = EDIT_PRESETS.w.door;
  H.clear(a); H.clear(b);
  H.send(a, { t: 'be', k: K.wall, e: door });
  assert.deepEqual(H.last(a, 'be'), { t: 'be', k: K.wall, e: door });
  assert.deepEqual(H.last(b, 'be'), { t: 'be', k: K.wall, e: door });
  assert.equal(H.room.grid.get(K.wall).e, door);
  // not a preset / wrong type / no such piece: nothing changes, nobody else hears about it
  H.advance(500);
  H.clear(a); H.clear(b);
  for (const e of [0x1f0, 0, -1, 1.5, '493', null, EDIT_PRESETS.f.hole1]) H.send(a, { t: 'be', k: K.wall, e });
  H.send(a, { t: 'be', k: K.far, e: door });
  H.send(a, { t: 'be', k: 42, e: door });
  assert.equal(H.msgs(b, 'be').length, 0, 'refused edits are not broadcast');
  assert.ok(H.msgs(a, 'be').every((m) => m.e === door), 'the sender is told the real mask');
  assert.equal(H.room.grid.get(K.wall).e, door);
  // ramps and cones have no edits
  H.send(a, { t: 'b', k: K.ramp, m: 'wood', d: 0 });
  H.send(a, { t: 'b', k: K.coneLow, m: 'wood' });
  assert.ok(H.room.grid.get(K.coneLow), 'the room accepts a cone');
  H.advance(500);
  H.clear(b);
  H.send(a, { t: 'be', k: K.ramp, e: 1 });
  H.send(a, { t: 'be', k: K.coneLow, e: 1 });
  assert.equal(H.msgs(b, 'be').length, 0);
  // another player (in the warm-up everyone is on their own) may not edit Ann's wall
  H.advance(500);
  H.clear(a); H.clear(b);
  H.send(b, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.window });
  assert.equal(H.msgs(a, 'be').length, 0);
  assert.deepEqual(H.last(b, 'be'), { t: 'be', k: K.wall, e: door }, 'Ben is told the real mask');
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test("'be': another team is refused, a teammate is allowed, range and the cooldown hold", () => {
  const { H, a, b, at } = party();
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  H.send(a, { t: 'drop' });
  H.send(b, { t: 'drop' });
  H.advance(100);
  at(a, S.x, S.z); at(b, S.x + 1, S.z);
  H.send(a, { t: 'b', k: K.wall, m: 'stone' });
  assert.ok(H.room.grid.get(K.wall), 'built during the match');
  const pa = H.player(a.pid), pb = H.player(b.pid);
  assert.notEqual(pa.team, pb.team, 'free for all: two teams');
  H.clear(a);
  H.send(b, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.window });
  assert.equal(H.msgs(a, 'be').length, 0, 'an enemy cannot edit your wall');
  pb.team = pa.team; // teammates
  H.send(b, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.window });
  assert.equal(H.last(a, 'be').e, EDIT_PRESETS.w.window, 'a teammate can');
  // cooldown: one edit per actor per 0.1 s (the client waits 0.16 s: room for network jitter)
  H.clear(a);
  H.advance(160);
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.arch });
  H.advance(50);
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.half });
  assert.deepEqual(H.msgs(a, 'be').map((m) => m.e), [EDIT_PRESETS.w.arch, EDIT_PRESETS.w.arch], 'the second edit in 50 ms is refused');
  H.advance(60);
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.half });
  assert.equal(H.last(a, 'be').e, EDIT_PRESETS.w.half, 'after 0.1 s it works again');
  // range: 6 m from the piece's centre
  H.advance(200);
  at(a, S.x, S.z + 30);
  H.clear(b);
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.reset });
  assert.equal(H.msgs(b, 'be').length, 0, 'too far away');
  at(a, S.x, S.z + 4.5);
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.reset });
  assert.equal(H.last(b, 'be').e, EDIT_PRESETS.w.reset, 'in range again');
  assert.equal(H.room.grid.get(K.wall).e, undefined, 'reset clears the edit');
  // a dead player can't edit
  pa.alive = false;
  H.advance(200);
  H.clear(b);
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.door });
  assert.equal(H.msgs(b, 'be').length, 0);
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('welcome and b+ replay edits; support and collapse stay edge-based', () => {
  const { H, a } = party();
  H.send(a, { t: 'b', k: K.wall, m: 'wood' });
  H.send(a, { t: 'b', k: K.floor, m: 'wood' });
  H.send(a, { t: 'b', k: K.cone, m: 'metal' });
  const bplus = H.msgs(a, 'b+');
  assert.equal(bplus.length, 3);
  assert.ok(bplus.every((m) => !('e' in m)), 'a new piece is whole');
  H.send(a, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.door });
  H.advance(200);
  H.send(a, { t: 'be', k: K.floor, e: EDIT_PRESETS.f.hole3 });
  // a late joiner sees the door and the hole
  const c = H.join('Cat');
  const w = H.last(c, 'welcome');
  const byK = Object.fromEntries(w.builds.map((m) => [m.k, m]));
  assert.equal(byK[K.wall].e, EDIT_PRESETS.w.door);
  assert.equal(byK[K.floor].e, EDIT_PRESETS.f.hole3);
  assert.ok(!('e' in byK[K.cone]));
  assert.equal(H.room.pieceMsg(H.room.grid.get(K.wall)).e, EDIT_PRESETS.w.door, 'pieceMsg (b+) carries e');
  // an edited wall still holds the floor and the roof; breaking it drops both
  H.send(a, { t: 'bd', k: K.wall, d: 1000 });
  const del = H.last(c, 'b-');
  assert.deepEqual(del.k, [K.wall]);
  assert.deepEqual(new Set(del.c), new Set([K.floor, K.cone]));
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('the room harness speaks the current protocol', () => {
  const H = makeRoom();
  const old = H.join('Old', { v: PROTOCOL - 1 });
  assert.equal(old.ok, false);
  const ok = H.join('New');
  assert.equal(ok.ok, true);
  H.send(ok, { t: 'be', k: K.wall, e: EDIT_PRESETS.w.door });
  assert.equal(H.msgs(ok, 'be').length, 0, 'editing nothing is a no-op');
  assert.equal(H.errors.length, 0);
});

import { editInReach } from '../public/shared/buildgrid.js';

test('edit reach: the client offers EDIT only where the room takes the edit (same rule, with slack)', () => {
  const { H, a, at } = party();
  H.send(a, { t: 'b', k: K.wall, m: 'wood' });
  const pc = parseKey(K.wall);
  let offeredButRefused = 0, tried = 0;
  for (let dx = -9; dx <= 9; dx += 0.5) {
    for (let dz = -9; dz <= 9; dz += 0.5) {
      const x = S.x + dx, z = S.z + dz;
      at(a, x, z);
      const p = H.player(a.pid);
      const offered = editInReach(pc, p.x, p.y, p.z, 0.5); // what buildClient checks
      if (!offered) continue;
      tried++;
      H.advance(120);
      H.clear(a);
      const e = H.room.grid.get(K.wall).e === EDIT_PRESETS.w.door ? EDIT_PRESETS.w.reset : EDIT_PRESETS.w.door;
      H.send(a, { t: 'be', k: K.wall, e });
      const got = H.last(a, 'be');
      if (!got || got.e !== e) offeredButRefused++;
    }
  }
  assert.ok(tried > 50);
  assert.equal(offeredButRefused, 0);
  assert.equal(H.errors.length, 0);
});
