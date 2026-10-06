// Run with: npm test   (uses Node's built-in test runner)
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../public/shared/worldgen.js';
import { BuildGrid, pieceKey, parseKey } from '../public/shared/buildgrid.js';
import { Room } from '../public/shared/room.js';
import { weaponDamage, MAP, PLAYER } from '../public/shared/constants.js';
import { frameSender, frameReceiver } from '../public/js/net/p2p.js';

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
  assert.ok(b.alive && b.sh === 0 && b.hp < 100, 'the shield soaks the first pump');
  room.message('a', { t: 'hit', tg: b.id, w: 'shotgun', r: 3, d: 3, n: 8, nh: 2 });
  assert.equal(b.alive, false, 'two pumps to the face eliminate');
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

test('player state is sanitised (yaw wrapped, unknown weapons rejected)', () => {
  const { room, join } = makeRoom();
  const a = join('a', 'Ann');
  room.message('a', { t: 'u', s: [1, 2, 3, 0, 0, 0, 1e300, 0, 1, 'constructor', 0] });
  assert.ok(Math.abs(a.yw) <= Math.PI + 1e-9);
  assert.equal(a.w, 'pickaxe');
  room.message('a', { t: 'u', s: [1, 2, 3, 0, 0, 0, 7, 0, 1, 'sniper:3', 0] });
  assert.equal(a.w, 'sniper:3');
  assert.ok(Math.abs(a.yw - (7 - 2 * Math.PI)) < 1e-9);
});

test('rejected builds always get an answer so materials can be refunded', () => {
  const { room, inbox, join, tick } = makeRoom();
  const a = join('a', 'Ann');
  join('b', 'Ben');
  room.message('a', { t: 'start', bots: 0, mats: 0 });
  room.message('a', { t: 'drop' });
  room.message('b', { t: 'drop' });
  room.message('b', { t: 'fall', d: 500 }); // Ben falls, Ann wins -> phase 'ended'
  assert.equal(room.phase, 'ended');
  room.message('a', { t: 'b', k: pieceKey('w', 0, 0, 0, 'x'), m: 'wood' });
  assert.ok(inbox.a.some((m) => m.t === 'bno'));
  assert.ok(a.alive);
});

test('bots move to an active device when their owner goes quiet', () => {
  const { room, inbox, join, tick } = makeRoom();
  join('a', 'Ann');
  const b = join('b', 'Ben');
  room.message('a', { t: 'start', bots: 3, mats: 0 });
  const bots = [...room.players.values()].filter((p) => p.bot);
  assert.ok(bots.every((x) => x.owner !== b.id));
  // only Ben keeps talking for 6 seconds
  for (let i = 0; i < 6; i++) { room.message('b', { t: 'ping', c: i }); tick(1000); }
  assert.ok(bots.every((x) => x.owner === b.id));
  assert.ok(inbox.b.some((m) => m.t === 'bots' && m.own.length === 3));
  assert.ok(inbox.a.some((m) => m.t === 'bots' && m.own.length === 0));
});

test('peer-to-peer messages of any size arrive whole, under the data channel size limit', () => {
  const wire = [];
  const send = frameSender({ open: true, send: (d) => wire.push(d) });
  const got = [];
  const recv = frameReceiver((m) => got.push(m));
  const big = { t: 'start', name: 'Zoë 😀'.repeat(3000), list: Array.from({ length: 4000 }, (_, i) => [i, i * 0.5]) };
  send({ t: 's', p: [[1, 2, 3]] });
  send(big);
  send({ t: 'pong', c: 5 });
  assert.ok(wire.length > 5, 'big message was split');
  for (const d of wire) assert.ok(Buffer.byteLength(d, 'utf8') < 16000);
  for (const d of wire) recv(d);
  assert.deepEqual(got, [{ t: 's', p: [[1, 2, 3]] }, big, { t: 'pong', c: 5 }]);
  recv('~zz|0|2|{"t":'); recv('not json'); recv(42);
  assert.equal(got.length, 3, 'junk and incomplete messages are ignored');
});

// ------------------------------------------------------------------ health, shield and siphon
const snapRow = (inbox, id) => { const s = inbox.filter((m) => m.t === 's').pop(); return s && s.p.find((r) => r[0] === id); };
// sniper headshot: 302 damage, more than a full 100 hp + 100 shield
const snipe = (room, connId, tg, id) => room.message(connId, { t: 'hit', id, tg: tg.id, w: 'sniper', r: 4, d: 10, n: 0, nh: 1 });

function startedRoom(names, opts = {}) {
  const env = makeRoom();
  const ps = names.map((n) => env.join(n.toLowerCase()[0], n));
  env.room.message('a', { t: 'start', bots: opts.bots || 0, mats: 0, mode: opts.mode || 'ffa' });
  for (const p of env.room.players.values()) p.inBus = false;
  env.room.phase = 'match';
  return { ...env, ps };
}

test('everyone starts with 100 health and 100 shield: lobby, match start, back in the lobby', () => {
  const { room, inbox, join, tick } = makeRoom();
  assert.equal(PLAYER.startShield, 100);
  const a = join('a', 'Ann');
  assert.deepEqual([a.hp, a.sh], [100, 100], 'warm-up lobby');
  tick(50);
  assert.deepEqual(snapRow(inbox.a, a.id).slice(9, 11), [100, 100], 'lobby snapshot');
  const b = join('b', 'Ben');
  assert.deepEqual([b.hp, b.sh], [100, 100], 'joining the lobby');
  a.sh = 12; b.hp = 40;
  room.message('a', { t: 'start', bots: 3, mats: 0 });
  assert.equal(room.phase, 'bus');
  const all = [...room.players.values()];
  assert.equal(all.length, 5);
  for (const p of all) assert.deepEqual([p.hp, p.sh, p.alive], [100, 100, true], `${p.name} on the bus`);
  tick(50);
  for (const p of all) assert.deepEqual(snapRow(inbox.b, p.id).slice(9, 11), [100, 100], 'bus snapshot');
  // a late joiner spectates, then plays the next round at full health + shield
  const c = join('c', 'Cat');
  assert.equal(c.alive, false);
  for (const p of all) p.sh = 0;
  room.message('a', { t: 'end' });
  assert.equal(room.phase, 'lobby');
  for (const p of room.players.values()) assert.deepEqual([p.hp, p.sh, p.alive], [100, 100, true], `${p.name} back in the lobby`);
});

test('siphon: an elimination heals the killer by 50, health first, then shield, capped at 100/100', () => {
  const { room, inbox, ps: [a, ...victims] } = startedRoom(['Ann', 'Ben', 'Cat', 'Dan']);
  const cases = [[30, 0, 80, 0, 50, 0], [90, 20, 100, 60, 10, 40], [100, 90, 100, 100, 0, 10]];
  cases.forEach(([hp, sh, hp2, sh2, dh, ds], i) => {
    a.hp = hp; a.sh = sh;
    snipe(room, 'a', victims[i]);
    assert.equal(victims[i].alive, false);
    assert.deepEqual([a.hp, a.sh], [hp2, sh2], `${hp}/${sh} + kill`);
    // every device hears about it right away, so the killer's HUD can show "+50"
    for (const box of [inbox.a, inbox.b]) {
      const m = box.filter((x) => x.t === 'siphon').pop();
      assert.deepEqual(m, { t: 'siphon', id: a.id, amt: dh + ds, dh, ds, hp: hp2, sh: sh2 });
    }
  });
  assert.equal(a.kills, 3);
  assert.equal(room.phase, 'ended', 'the last kill still won the match');
  // the siphon arrives after the elimination, before the win
  const order = inbox.a.map((m) => m.t).filter((t) => t === 'elim' || t === 'siphon' || t === 'win').slice(-3);
  assert.deepEqual(order, ['elim', 'siphon', 'win']);
});

test('siphon: nothing when already at 200, and fractional health stays capped', () => {
  const { room, inbox, ps: [a, b, c] } = startedRoom(['Ann', 'Ben', 'Cat']);
  snipe(room, 'a', b);
  assert.deepEqual([a.hp, a.sh], [100, 100]);
  assert.equal(inbox.a.filter((m) => m.t === 'siphon').length, 0, 'no popup for a full player');
  a.hp = 99.6; a.sh = 99.2;
  snipe(room, 'a', c);
  assert.deepEqual([a.hp, a.sh], [100, 100]);
  const m = inbox.a.find((x) => x.t === 'siphon');
  assert.ok(m && m.amt === 1 && m.dh + m.ds === m.amt && m.hp === 100 && m.sh === 100);
});

test('siphon: storm and fall deaths give nobody anything', () => {
  const { room, inbox, tick, ps: [a, b, c] } = startedRoom(['Ann', 'Ben', 'Cat']);
  a.hp = 30; a.sh = 0;
  for (const p of [a, b, c]) { p.x = 0; p.z = 0; }
  room.message('b', { t: 'fall', d: 500 });
  assert.equal(b.alive, false);
  c.hp = 1; c.x = 390; // far outside the first storm circle
  tick(1000);
  assert.equal(c.alive, false, 'the storm got Cat');
  assert.ok(inbox.a.some((m) => m.t === 'elim' && m.v === c.id && m.c === 'storm' && m.k === 0));
  assert.deepEqual([a.hp, a.sh], [30, 0]);
  assert.equal(inbox.a.filter((m) => m.t === 'siphon').length, 0);
});

test('siphon: bots get it too, dead killers do not', () => {
  const { room, inbox, ps: [a, b, c] } = startedRoom(['Ann', 'Ben', 'Cat'], { bots: 1 });
  const bot = [...room.players.values()].find((p) => p.bot);
  assert.equal(bot.owner, a.id);
  bot.hp = 20; bot.sh = 0;
  snipe(room, 'a', b, bot.id); // Ann's device simulates the bot
  assert.equal(b.alive, false);
  assert.deepEqual([bot.hp, bot.sh, bot.kills], [70, 0, 1]);
  assert.ok(inbox.c.some((m) => m.t === 'siphon' && m.id === bot.id && m.dh === 50));
  // Ann dies while her rocket is still in the air; it eliminates Cat but a dead player can't heal
  room.message('a', { t: 'fall', d: 500 });
  assert.equal(a.alive, false);
  c.hp = 5; c.sh = 0; c.x = 10; c.y = 5; c.z = 10;
  const before = inbox.c.filter((m) => m.t === 'siphon').length;
  room.message('a', { t: 'boom', w: 'rocket', r: 3, x: 10, y: 5.9, z: 10 });
  assert.equal(c.alive, false);
  assert.equal(a.kills, 1, 'the kill still counts');
  assert.deepEqual([a.hp, a.sh], [0, 0]);
  assert.equal(inbox.c.filter((m) => m.t === 'siphon').length, before);
});

test('siphon: squad teammates never feed each other, the eliminator alone is healed', () => {
  const { room, inbox, ps: [a, b] } = startedRoom(['Ann', 'Ben'], { mode: 'squad', bots: 2 });
  assert.equal(a.team, b.team);
  a.hp = 40; a.sh = 0; b.hp = 40; b.sh = 0;
  room.siphon(a, b); // can't happen through damage (no friendly fire), but must not pay out either
  assert.deepEqual([a.hp, a.sh], [40, 0]);
  const [bot1] = [...room.players.values()].filter((p) => p.bot);
  snipe(room, 'a', bot1);
  assert.equal(bot1.alive, false);
  assert.deepEqual([a.hp, a.sh], [90, 0]);
  assert.deepEqual([b.hp, b.sh], [40, 0], 'the teammate gets nothing');
  assert.equal(inbox.b.filter((m) => m.t === 'siphon').length, 1);
});
