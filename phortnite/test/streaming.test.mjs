// Collider streaming (js/world/colliders.js): chunk bookkeeping, the active set around focus
// points, the per-frame budget, the 3 s keep-alive, reference counts across chunk borders and
// ensureAlong for bullets. Pure logic: no Rapier, no three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ColliderStreamer, STREAM } from '../public/js/world/colliders.js';

/** A streamer over a size x size map with objects on a grid every `step` metres. */
function makeWorld({ size = 640, step = 8, radius = 0, perFrame = STREAM.perFrame, objects } = {}) {
  const made = new Map(); // id -> live colliders (1 each)
  const log = { created: 0, removed: 0 };
  const dead = new Set();
  const S = new ColliderStreamer({
    size, perFrame,
    create(id) { if (dead.has(id)) return 0; assert.ok(!made.has(id), `object ${id} created twice`); made.set(id, 1); log.created++; return 1; },
    remove(id) { if (made.delete(id)) log.removed++; },
  });
  const objs = objects || [];
  if (!objects) {
    let id = 0;
    for (let z = -size / 2 + step / 2; z < size / 2; z += step) for (let x = -size / 2 + step / 2; x < size / 2; x += step) objs.push({ id: id++, x, z, r: radius });
  }
  for (const o of objs) S.add(o.id, o.x, o.z, o.r || 0);
  S.finalize();
  return { S, made, log, objs, dead };
}

const near = (o, x, z, R) => {
  // object o (square footprint) is in some chunk within R of (x, z)
  return Math.hypot(o.x - x, o.z - z) <= R + 64 * Math.SQRT2 + (o.r || 0);
};

test('streaming: chunk index, clamping and membership across chunk borders', () => {
  const { S } = makeWorld({ objects: [{ id: 0, x: -10, z: -10, r: 0 }, { id: 1, x: 63.9, z: 10, r: 2 }, { id: 2, x: 900, z: -900, r: 0 }] });
  assert.equal(S.n, 10);
  assert.equal(S.chunkAt(-320, -320), 0);
  assert.equal(S.chunkAt(319.9, 319.9), 99);
  assert.equal(S.chunkAt(5000, -5000), 9, 'clamped to the map');
  const c0 = S.chunkAt(-10, -10);
  assert.deepEqual([...S.members(c0)], [0]);
  // id 1 straddles x = 64 (a chunk border at 320 - 256 = 64): member of both chunks
  const a = S.chunkAt(60, 10), b = S.chunkAt(66, 10);
  assert.notEqual(a, b);
  assert.ok(S.members(a).includes(1) && S.members(b).includes(1));
  assert.ok(S.members(S.chunkAt(319, -319)).includes(2), 'an object outside the map lands in the edge chunk');
});

test('streaming: the active set is every chunk within 96 m of the focus points, nearest first', () => {
  const { S, made, objs } = makeWorld({ perFrame: 1e9 });
  const pts = [10, -20];
  S.update(0.016, pts, 1);
  for (const o of objs) {
    const want = S.isActive(S.chunkAt(o.x, o.z));
    assert.equal(made.has(o.id), want, `object ${o.id}`);
    if (want) assert.ok(near(o, 10, -20, 96));
  }
  // every chunk whose square comes within 96 m is on, the rest off
  for (let c = 0; c < S.count; c++) {
    const cx = c % S.n, cz = Math.floor(c / S.n);
    const x0 = -320 + cx * 64, z0 = -320 + cz * 64;
    const dx = Math.max(x0 - 10, 0, 10 - x0 - 64), dz = Math.max(z0 + 20, 0, -20 - z0 - 64);
    assert.equal(S.isActive(c), Math.hypot(dx, dz) <= 96, `chunk ${c}`);
  }
  assert.ok(made.size > 0 && made.size < objs.length / 3);
});

test('streaming: at most perFrame new colliders a frame, nearest chunk first', () => {
  const { S, made } = makeWorld({ step: 2, perFrame: 600 });
  const pts = [0, 0];
  const counts = [];
  for (let f = 0; f < 200 && (f === 0 || S.queue.length); f++) counts.push(S.update(1 / 60, pts, 1));
  assert.ok(counts.every((n) => n <= 600), `per frame ${Math.max(...counts)}`);
  assert.ok(counts.length > 5, 'needs several frames');
  assert.equal(S.queue.length, 0);
  // the chunk under the point is the first one finished
  const { S: S2, made: m2 } = makeWorld({ step: 2, perFrame: 600 });
  const c = S2.chunkAt(5, 5);
  let first = -1;
  for (let f = 0; f < 50 && first < 0; f++) {
    S2.update(1 / 60, [5, 5], 1);
    for (let k = 0; k < S2.count; k++) if (S2.isActive(k)) { first = k; break; }
  }
  assert.equal(first, c, 'the focus chunk is built first');
  for (const id of S2.members(c)) assert.ok(m2.has(id));
  assert.ok(made.size > 0);
});

test('streaming: chunks stay 3 s after nobody wants them, then lose their colliders', () => {
  const { S, made, log } = makeWorld({ perFrame: 1e9 });
  S.update(0.1, [-250, -250], 1);
  const c = S.chunkAt(-250, -250);
  assert.ok(S.isActive(c));
  const n0 = made.size;
  // move far away: the old chunk is kept for 3 s
  let t = 0;
  while (t < 2.8) { S.update(0.1, [250, 250], 1); t += 0.1; }
  assert.ok(S.isActive(c), 'kept for 3 s');
  while (t < 3.6) { S.update(0.1, [250, 250], 1); t += 0.1; }
  assert.ok(!S.isActive(c), 'dropped after 3 s');
  assert.ok(log.removed >= n0, 'every old collider removed');
  for (const id of S.members(c)) assert.ok(!made.has(id));
});

test('streaming: an object on a chunk border lives while either chunk is active', () => {
  const objs = [{ id: 0, x: 64, z: 32, r: 3 }];
  const { S, made } = makeWorld({ objects: objs, perFrame: 1e9 });
  const a = S.chunkAt(62, 32), b = S.chunkAt(66, 32);
  S.activate(a);
  assert.ok(made.has(0));
  S.activate(b);
  S.deactivate(a);
  assert.ok(made.has(0), 'still held by the other chunk');
  S.deactivate(b);
  assert.ok(!made.has(0));
  assert.equal(S.live, 0);
});

test('streaming: ensureAlong builds every chunk a bullet path crosses at once', () => {
  const { S, made } = makeWorld({ step: 4, perFrame: 1 });
  // a 300 m sniper shot across chunks nobody has visited
  const made1 = S.ensureAlong(-300, 5, -1, 5);
  assert.ok(made1 > 0);
  for (let x = -300; x <= -1; x += 0.5) assert.ok(S.isActive(S.chunkAt(x, 5)), `chunk under x=${x}`);
  // nothing beyond the segment's end
  assert.ok(!S.isActive(S.chunkAt(40, 5)));
  // every object in those chunks has its collider now, ignoring the 1 per frame budget
  for (let x = -300; x <= -1; x += 64) for (const id of S.members(S.chunkAt(x, 5))) assert.ok(made.has(id));
  // the bullet's chunks stay for 3 s, then go
  for (let t = 0; t < 3.5; t += 0.1) S.update(0.1, [250, 250], 1);
  assert.ok(!S.isActive(S.chunkAt(-150, 5)));
});

test('streaming: ensureAlong covers every chunk of random segments (diagonals, reversed, tiny)', () => {
  const { S } = makeWorld({ step: 16, perFrame: 0 });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 400; k++) {
    S.clear();
    for (let c = 0; c < S.count; c++) S.wanted[c] = -1e9;
    const x0 = (rnd() - 0.5) * 640, z0 = (rnd() - 0.5) * 640;
    const L = k % 4 === 0 ? rnd() * 3 : rnd() * 400, a = rnd() * Math.PI * 2;
    const x1 = Math.max(-319, Math.min(319, x0 + Math.cos(a) * L)), z1 = Math.max(-319, Math.min(319, z0 + Math.sin(a) * L));
    S.ensureAlong(x0, z0, x1, z1);
    const need = new Set();
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25) + 1;
    for (let i = 0; i <= n; i++) need.add(S.chunkAt(x0 + (x1 - x0) * (i / n), z0 + (z1 - z0) * (i / n)));
    for (const c of need) assert.ok(S.isActive(c), `segment ${k} misses chunk ${c}`);
    let on = 0;
    for (let c = 0; c < S.count; c++) if (S.isActive(c)) on++;
    assert.ok(on <= need.size + 2, `segment ${k}: ${on} chunks on for ${need.size} crossed`);
  }
});

test('streaming: dead objects make no colliders and come back when restored in an active chunk', () => {
  const { S, made, dead } = makeWorld({ perFrame: 1e9 });
  const id = S.members(S.chunkAt(0, 0))[0];
  dead.add(id);
  S.update(0.1, [0, 0], 1);
  assert.ok(!made.has(id), 'destroyed: no collider');
  assert.ok(S.isLive(id), 'but its chunk is live, so a restore must build it');
  dead.delete(id);
  // the World rebuilds restored objects whose chunk is live
  if (S.isLive(id)) S.create(id);
  assert.ok(made.has(id));
});

test('streaming: many focus points share chunks; the active count matches the union', () => {
  const { S, made, objs } = makeWorld({ perFrame: 1e9 });
  const pts = [0, 0, 20, 10, -200, 150, 250, -250];
  S.update(0.1, pts, 4);
  for (const o of objs) {
    const on = S.isActive(S.chunkAt(o.x, o.z));
    assert.equal(made.has(o.id), on);
  }
  const st = S.stats();
  assert.equal(st.live, made.size);
  assert.ok(st.active > 0 && st.queued === 0);
});
