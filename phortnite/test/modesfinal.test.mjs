// Mode engine regressions (2.0 final review): respawn loadouts, best-of-N rounds (area, forfeit),
// two big teams, time-up ties, endless rule sets, no-damage falls, gun game blasts, lava spawns,
// team names and play areas. Room-level (solo, Node server and P2P host run the same Room).
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from './helpers/roomharness.mjs';
import { getWorld, modeSettings, customSettings } from '../public/shared/room.js';
import { normalizeRules } from '../public/shared/modes/rules.js';
import { modeRules } from '../public/shared/modes/index.js';
import {
  botCountFor, resolveArea, spawnCandidates, standable, nearLava, twoTeamFor, ModeRuntime,
} from '../public/shared/modes/runtime.js';
import { mulberry32 } from '../public/shared/rng.js';

const world = getWorld();
const RES = { resume: '' };

test('modes: a respawn that does not keep loot always sends an explicit loadout (never lo:null)', () => {
  // Boom Town-like: no loadout, no start materials, respawnKeep off -> the client drops everything
  // on death, so the respawn must empty the inventory (lo:null would keep the dropped items too)
  const H = makeRoom({ settings: customSettings({ respawn: 3, lives: 0, win: 'elims', bots: 0, storm: 'none', spawn: 'ground' }), drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'start' });
  H.advance(200);
  H.room.eliminate(b.p, a.p, { w: 'ar' });
  H.advance(3500);
  const rs = H.last(b, 'respawn');
  assert.ok(rs, 'respawned');
  assert.deepEqual(rs.lo, { slots: [], ammo: {}, mats: { wood: 0, stone: 0, metal: 0 } });
  // respawnKeep: null (keep your loot) as before
  const K = makeRoom({ settings: customSettings({ respawn: 3, lives: 0, win: 'elims', respawnKeep: true, bots: 0, storm: 'none', spawn: 'ground' }), drop: ['s'] });
  const x = K.join('X'), y = K.join('Y');
  K.send(x, { t: 'start' });
  K.advance(200);
  K.room.eliminate(y.p, x.p, { w: 'ar' });
  K.advance(3500);
  assert.equal(K.last(y, 'respawn').lo, null);
  assert.deepEqual([...H.errors, ...K.errors], []);
});

test('modes: the round start of a series carries the play area (no whole-island loot roll)', () => {
  const H = makeRoom({ settings: modeSettings('box-fight'), drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'start' });
  H.advance(300);
  const start = H.last(a, 'start');
  for (const p of H.room.runtime.list) if (p.team !== a.p.team && p.alive) H.room.eliminate(p, a.p, { w: 'ar' });
  H.advance(5000);
  const r2 = H.msgs(a, 'round').find((m) => m.start);
  assert.ok(r2, 'round 2');
  assert.deepEqual(r2.area, start.area);
  assert.deepEqual(H.errors, []);
});

test('modes: when the other side leaves a series, the side still here takes it at once', () => {
  const H = makeRoom({ settings: modeSettings('build-battle'), drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'start' });
  H.advance(500);
  assert.ok(H.room.round);
  H.leave(b); // LEAVE PARTY in round 1
  H.advance(6000);
  const win = H.last(a, 'win');
  assert.ok(win, 'the series is over');
  assert.equal(win.id, a.pid);
  assert.equal(win.reason, 'left');
  assert.equal(H.msgs(a, 'round').filter((m) => m.start).length, 0, 'no rounds against nobody');
  assert.deepEqual(H.errors, []);
});

test('modes: a tied top score when the clock runs out is a draw, not "whoever scored first"', () => {
  const H = makeRoom({ settings: modeSettings('team-rumble'), drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'start' });
  H.advance(500);
  const rt = H.room.runtime;
  rt.addScore(1, 2);
  rt.addScore(2, 2);
  assert.deepEqual(rt.timeUp(), { reason: 'time', draw: true });
  rt.addScore(2, 1);
  assert.deepEqual(rt.timeUp(), { team: 2, reason: 'time' });
  rt.addScore(1, 1);
  rt.endsAt = H.now() + 50;
  H.advance(200);
  const win = H.last(a, 'win');
  assert.equal(win.id, 0);
  assert.equal(win.draw, true);
  assert.equal(win.reason, 'time');
  assert.deepEqual(H.errors, []);
});

test('modes: rule sets that could never end are made finite; friends vs bots always has a bot', () => {
  assert.equal(normalizeRules({ respawn: 3, lives: 0 }).lives, 3);
  assert.equal(normalizeRules({ respawn: 3, lives: 0, storm: 'zonewars', rounds: 3 }).lives, 3);
  assert.deepEqual(normalizeRules(modeRules('build-practice')), modeRules('build-practice'), 'no-damage sandboxes unchanged');
  assert.equal(modeRules('playground').lives, 0);
  assert.ok(botCountFor(normalizeRules({ teams: 'humans', maxPlayers: 2 }), 2) >= 1);
  assert.ok(botCountFor(normalizeRules({ teams: 'humans', maxPlayers: 4, bots: 1 }), 4) >= 1);
  // a BR + respawn match ends: Ann runs out the others' lives
  const H = makeRoom({ settings: customSettings({ respawn: 3, lives: 0, bots: 0, storm: 'none', spawn: 'ground' }), drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'start' });
  H.advance(300);
  for (let i = 0; i < 3; i++) { H.room.eliminate(b.p, a.p, { w: 'ar' }); H.advance(3500); }
  assert.equal(H.last(a, 'win').id, a.pid);
  assert.deepEqual(H.errors, []);
});

test('modes: no-damage modes (Playground, Build Practice) have no fall damage either', () => {
  for (const id of ['playground', 'build-practice']) {
    const H = makeRoom({ settings: modeSettings(id), drop: ['s'] });
    const a = H.join('Ann');
    H.send(a, { t: 'start' });
    H.advance(300);
    H.send(a, { t: 'fall', d: 200 });
    assert.equal(a.p.hp, 100, id);
    assert.equal(a.p.alive, true, id);
    assert.deepEqual(H.errors, []);
  }
});

test('modes: one gun game rocket hits everyone in the blast (judged as it went off)', () => {
  const H = makeRoom({ settings: modeSettings('gun-game'), drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'start' });
  H.advance(300);
  const me = a.p;
  const bots = H.bots().slice(0, 3);
  bots.forEach((b, i) => { b.x = me.x + 10 + i * 0.5; b.y = me.y; b.z = me.z; b.hp = 20; b.sh = 0; });
  for (const b of H.bots().slice(3)) b.x = me.x + 200;
  H.send(a, { t: 'boom', id: me.id, w: 'rocket', r: 4, x: me.x + 10.5, y: me.y + 0.9, z: me.z });
  assert.ok(bots.every((b) => !b.alive), JSON.stringify(bots.map((b) => b.hp)));
  assert.equal(H.room.runtime.state.lv[me.id], 3, 'three rungs up');
  assert.deepEqual(H.errors, []);
});

test('modes: nobody spawns in (or next to) the volcano\'s lava pool', () => {
  assert.ok(world.lava && world.lava.length, 'the island has lava');
  const L = world.lava[0];
  assert.equal(standable(world, L.x, L.z), false);
  assert.equal(nearLava(world, L.x, L.z, 0), true);
  const area = resolveArea(world, 'biome:volcano');
  for (let s = 1; s <= 12; s++) {
    const C = spawnCandidates(world, { x: L.x, z: L.z, r: 102 }, mulberry32(s), 120);
    for (const c of C) for (const l of world.lava) assert.ok(Math.hypot(c.x - l.x, c.z - l.z) >= l.r + 4, `seed ${s}: (${c.x}, ${c.z})`);
  }
  assert.ok(area.r > 60);
});

test('modes: storm circles never close into the lava pool (volcano zone wars)', () => {
  const H = makeRoom({ settings: modeSettings('volcano-zone-wars'), drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'start' });
  const R = H.room;
  let bad = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    R.storm = R.makeStorm(H.now(), 0);
    for (let k = 0; k < R.storm.phases.length - 1; k++) {
      const s = R.storm;
      for (const l of world.lava) if (Math.hypot(s.ncx - l.x, s.ncz - l.z) < l.r + 15) bad++;
      n++;
      s.cx = s.ncx; s.cz = s.ncz; s.r = s.nr; s.i++;
      R.pickNextCircle();
    }
  }
  assert.equal(bad, 0, `${bad} of ${n} circles centred at the lava`);
  assert.deepEqual(H.errors, []);
});

test('modes: infection and hide & seek name their sides; the winners are "Zombie Team" / "Hider Team"', () => {
  const H = makeRoom({ settings: modeSettings('infection'), drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'start' });
  const st = H.last(a, 'start');
  assert.deepEqual(st.teams.map((t) => t.name), ['Survivor', 'Zombie']);
  for (const p of H.room.runtime.list) if (p.role !== 'zombie' && p.alive) H.room.eliminate(p, null, { c: 'storm' });
  H.advance(300);
  assert.equal(H.last(a, 'win').name, 'Zombie Team');
  const S = makeRoom({ settings: modeSettings('hide-and-seek'), drop: ['s'] });
  const x = S.join('X');
  S.send(x, { t: 'start' });
  S.room.runtime.endsAt = S.now() + 100;
  S.room.runtime.state.endAt = S.room.runtime.now() + 100;
  S.advance(400);
  assert.equal(S.last(x, 'win').name, 'Hider Team');
  assert.deepEqual([...H.errors, ...S.errors], []);
});

test('modes: two big teams keep the party together (bots balance the other side)', () => {
  for (let h = 1; h <= 6; h++) {
    const total = h + 15;
    const teams = Array.from({ length: h }, (_, i) => twoTeamFor(i, h, total));
    assert.ok(teams.every((t) => t === 1), `${h} friends with 15 bots: ${teams}`);
  }
  assert.deepEqual([0, 1].map((i) => twoTeamFor(i, 2, 2)), [1, 2], 'no bots: two friends face each other');
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => twoTeamFor(i, 5, 6)), [1, 1, 1, 2, 2]);
});

test('modes: a mode kit (gun game, Juggernaut) is marked so a death never drops it', () => {
  const H = makeRoom({ settings: modeSettings('juggernaut'), drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'start' });
  const R = H.room;
  const j = [...R.players.values()].find((p) => p.role === 'jugg');
  assert.ok(j && j.lo && j.lo.kit, 'the Juggernaut kit');
  const G = makeRoom({ settings: modeSettings('gun-game'), drop: ['s'] });
  const x = G.join('X');
  G.send(x, { t: 'start' });
  assert.ok(x.p.lo.kit);
  assert.deepEqual([...H.errors, ...G.errors], []);
});

test('modes: biome areas are the biome (its largest patch), not the whole island', () => {
  const full = resolveArea(world, 'full');
  for (const b of ['forest', 'volcano', 'snow', 'desert', 'jungle']) {
    const a = resolveArea(world, `biome:${b}`);
    assert.ok(a.r < full.r * 0.6, `${b}: r ${a.r}`);
    let land = 0, mine = 0;
    const rnd = mulberry32(7);
    for (let i = 0; i < 1500; i++) {
      const ang = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * a.r;
      const x = a.x + Math.cos(ang) * d, z = a.z + Math.sin(ang) * d;
      if (world.heightAt(x, z) > 1) { land++; if (world.biomeAt(x, z) === b) mine++; }
    }
    assert.ok(mine / land > 0.5, `${b}: ${(mine / land).toFixed(2)} of the circle's land`);
  }
});

test('modes: the runtime\'s respawnLoadout is never null', () => {
  const H = makeRoom();
  const rt = new ModeRuntime(H.room);
  rt.rules = normalizeRules({ respawn: 3 });
  const lo = rt.respawnLoadout({ id: 1 }, () => null);
  assert.deepEqual(lo, { slots: [], ammo: {}, mats: { wood: 0, stone: 0, metal: 0 } });
});
