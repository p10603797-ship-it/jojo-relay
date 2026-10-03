// Run with: npm test   (uses Node's built-in test runner)
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../public/shared/worldgen.js';
import { BuildGrid, pieceKey, parseKey } from '../public/shared/buildgrid.js';
import { Room } from '../public/shared/room.js';
import { weaponDamage, MAP } from '../public/shared/constants.js';

test('world generation is deterministic', () => {
  const a = generateWorld(MAP.seed), b = generateWorld(MAP.seed);
  assert.equal(a.checksum, b.checksum);
  assert.equal(a.objects.length, b.objects.length);
  assert.ok(a.houses.length > 20, 'island has towns');
  assert.ok(a.chests.length > 20 && a.lootSpots.length > 100, 'island has loot');
  for (const o of a.objects) assert.ok(Number.isFinite(o.x) && Number.isFinite(o.z));
});

test('heightAt follows the terrain grid', () => {
  const w = generateWorld(MAP.seed);
  const { N, cell, half, heights } = w;
  for (const [ix, iz] of [[10, 10], [80, 80], [120, 40]]) {
    assert.ok(Math.abs(w.heightAt(-half + ix * cell, -half + iz * cell) - heights[iz * N + ix]) < 1e-4);
  }
});

test('builds need support and collapse when it is removed', () => {
  const g = new BuildGrid(() => 0.5, () => false);
  const mk = (t, cx, cy, cz, o, d = 0) => { const k = pieceKey(t, cx, cy, cz, o); return Object.assign(parseKey(k), { k, d }); };
  const ramp = mk('r', 0, 0, 0), ramp2 = mk('r', 0, 1, 1), floor = mk('f', 0, 2, 2), floating = mk('f', 5, 3, 5);
  for (const p of [ramp, ramp2, floor]) { assert.ok(g.canSupport(p)); g.add(p); }
  assert.equal(g.canSupport(floating), false);
  g.remove(ramp.k);
  assert.deepEqual(new Set(g.collapseFrom([ramp])), new Set([ramp2.k, floor.k]));
});

test('damage falloff and headshots', () => {
  assert.equal(weaponDamage('ar', 0, 10, false), 30);
  assert.equal(weaponDamage('ar', 0, 10, true), 45);
  assert.ok(weaponDamage('ar', 0, 200, false) < 30);
  assert.equal(weaponDamage('sniper', 4, 300, true), 121 * 2.5);
});

function makeRoom() {
  let t = 1000;
  const room = new Room({ code: 'TEST', now: () => t });
  const inbox = {};
  const join = (id, name) => { inbox[id] = []; room.join({ id, send: (m) => inbox[id].push(m) }, { name }); return [...room.players.values()].find((p) => p.name === name); };
  return { room, inbox, join, tick: (ms) => { t += ms; room.tick(); } };
}

test('match flow: start, damage, elimination, win, back to lobby', () => {
  const { room, inbox, join, tick } = makeRoom();
  const a = join('a', 'Ann');
  const b = join('b', 'Ben');
  room.message('a', { t: 'start', bots: 0, mats: 0 });
  assert.equal(room.phase, 'bus');
  room.message('a', { t: 'drop' });
  room.message('b', { t: 'drop' });
  room.message('a', { t: 'hit', tg: b.id, w: 'shotgun', r: 3, d: 3, n: 8, nh: 2 });
  assert.equal(b.alive, false, 'pump to the face eliminates');
  assert.equal(a.kills, 1);
  assert.equal(room.phase, 'ended');
  assert.ok(inbox.b.some((m) => m.t === 'win' && m.id === a.id));
  tick(11000);
  assert.equal(room.phase, 'lobby');
});

test('squad mode: no friendly fire, the squad wins together', () => {
  const { room, inbox, join } = makeRoom();
  const a = join('a', 'Ann');
  const b = join('b', 'Ben');
  room.message('a', { t: 'start', bots: 2, mats: 0, mode: 'squad' });
  for (const p of room.players.values()) p.inBus = false;
  room.phase = 'match';
  room.message('a', { t: 'hit', tg: b.id, w: 'sniper', r: 4, d: 10, n: 0, nh: 1 });
  assert.equal(b.hp, 100);
  for (const p of [...room.players.values()].filter((x) => x.bot)) room.message('a', { t: 'hit', tg: p.id, w: 'sniper', r: 4, d: 10, n: 0, nh: 1 });
  const win = inbox.b.find((m) => m.t === 'win');
  assert.ok(win && win.team === a.team && win.team === b.team);
});

test('loot can only be picked up once and only nearby', () => {
  const { room, inbox, join } = makeRoom();
  const a = join('a', 'Ann');
  const b = join('b', 'Ben');
  room.message('a', { t: 'start', bots: 0, mats: 0 });
  room.message('a', { t: 'drop' });
  room.message('b', { t: 'drop' });
  const l = [...room.loot.values()][0];
  for (const p of [a, b]) { p.x = l.x; p.y = l.y; p.z = l.z; }
  b.x += 50;
  room.message('b', { t: 'pick', l: l.id });
  assert.ok(inbox.b.some((m) => m.t === 'gotno'));
  room.message('a', { t: 'pick', l: l.id });
  room.message('a', { t: 'pick', l: l.id });
  assert.equal(inbox.a.filter((m) => m.t === 'got').length, 1);
});

test('room survives junk messages', () => {
  const { room, join } = makeRoom();
  join('a', 'Ann');
  for (const m of [null, 1, 'x', { t: 'hit' }, { t: 'b', k: '../../etc' }, { t: 'u', s: 'nope' }, { t: 'dropi', items: [{ k: 'ar', r: 99 }] }, { t: 'od', o: 1e9 }, { t: 'start', bots: -5 }]) {
    room.message('a', m);
  }
  assert.ok(room.players.size >= 1);
});
