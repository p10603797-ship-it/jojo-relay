// The mode engine: data-driven rules played by the shared Room (solo, Node server and P2P host all
// run it). Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from './helpers/roomharness.mjs';
import { Room, getWorld, settingsFrom, modeSettings, GAME_OPTS } from '../public/shared/room.js';
import { generateWorld } from '../public/shared/worldgen.js';
import {
  MAP, PROTOCOL, PLAYER, WEAPONS, HEALS, STORM, STORM_PRESETS, TEAM_COLORS, SKY_SPAWN_HEIGHT, weaponDamage,
} from '../public/shared/constants.js';
import { normalizeRules, RULE_FIELDS } from '../public/shared/modes/rules.js';
import { MODES, CORE_MODES, modeRules, modeTags } from '../public/shared/modes/index.js';
import { GAMES } from '../public/shared/modes/games/index.js';
import { CORE_GAMES, lastTeamStanding } from '../public/shared/modes/games/core.js';
import {
  resolveArea, assignTeams, botCountFor, pickSpawns, spawnCandidates, rollBotSkill, fullArea,
} from '../public/shared/modes/runtime.js';
import {
  rollInitialLoot, rollWeapon, rollChest, makeLoadout, cleanLoadout, LOOT_POOLS, poolKeys,
} from '../public/shared/loot.js';
import { pieceKey } from '../public/shared/buildgrid.js';
import { mulberry32 } from '../public/shared/rng.js';
import { FakeCtx } from './helpers/fakectx.mjs';

const NAMES = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal'];
const world = getWorld();

/** A started match: humans (Ann, Ben, …) and a custom mode (defaults: no bots, ground spawn, no storm). */
function match(rules = {}, { humans = 2, solo = false, drop = ['s'], name = 'Test' } = {}) {
  const H = makeRoom({ solo, drop });
  const cs = [];
  for (let i = 0; i < humans; i++) cs.push(H.join(NAMES[i] || `P${i}`));
  H.send(cs[0], { t: 'mode', custom: { bots: 0, spawn: 'ground', storm: 'none', ...rules }, name });
  H.send(cs[0], { t: 'start' });
  return { H, cs, room: H.room, start: H.last(cs[0], 'start') };
}
// a sniper headshot: 302 damage, more than 100 hp + 100 shield
const snipe = (H, from, tg, id) => H.send(from, { t: 'hit', id, tg: tg.id ?? tg.pid, w: 'sniper', r: 4, d: 10, n: 0, nh: 1 });
const ar = (H, from, tg, n = 1, nh = 0) => H.send(from, { t: 'hit', tg: tg.pid ?? tg.id, w: 'ar', r: 0, d: 10, n, nh });

// ------------------------------------------------------------------ settings
test('settings: mode / tweak handlers are leader-only and lobby-only; legacy settings keep working', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  assert.equal(H.room.settings.modeId, 'solo');
  H.send(b, { t: 'mode', id: 'duos' });
  assert.equal(H.room.settings.modeId, 'solo', 'only the leader picks');
  H.send(a, { t: 'mode', id: 'nope' });
  assert.equal(H.room.settings.modeId, 'solo', 'unknown modes are ignored');
  H.send(a, { t: 'mode', id: 'duos' });
  const s = H.last(b, 'settings').settings;
  assert.equal(s.modeId, 'duos');
  assert.equal(s.rules.teams, 2);
  assert.deepEqual(s.info.name, 'Duos');
  assert.equal(s.custom, false);
  assert.deepEqual([s.bots, s.mats, s.mode], [s.rules.bots, s.rules.mats, 'ffa'], 'legacy mirror fields');
  assert.deepEqual(H.room.rules, s.rules);
  // tweak: bots and bot difficulty of the current mode
  H.send(a, { t: 'tweak', bots: 6, botSkill: 'hard' });
  assert.deepEqual([H.room.settings.rules.bots, H.room.settings.rules.botSkill], [5, 'hard']);
  H.send(b, { t: 'tweak', bots: 31 });
  assert.equal(H.room.settings.rules.bots, 5);
  // bot difficulty carries over to the next mode (unless the mode sets it)
  H.send(a, { t: 'mode', id: 'squadbots' });
  assert.equal(H.room.settings.rules.botSkill, 'hard');
  assert.equal(H.room.settings.mode, 'squad');
  // a custom mode is normalized, named and tagged
  H.send(a, { t: 'mode', custom: { teams: 2, loot: 'snipers', gravity: 0.4, respawn: 5, lives: 0, junk: 1, win: 'nope' }, name: '<b>Moon Snipers</b>' });
  const c = H.room.settings;
  assert.equal(c.custom, true);
  assert.equal(c.modeId, 'custom');
  assert.equal(c.info.name, 'bMoon Snipers/b');
  assert.deepEqual(c.rules, normalizeRules({ teams: 2, loot: 'snipers', gravity: 0.35, respawn: 5, lives: 0 }));
  assert.deepEqual(c.info.tags, ['Duos', 'Respawn', 'Low Gravity']);
  // the legacy 'settings' message maps onto modes / tweaks
  H.send(a, { t: 'settings', mode: 'squad', bots: 3, mats: 100 });
  assert.equal(H.room.settings.modeId, 'squadbots');
  assert.deepEqual([H.room.rules.bots, H.room.rules.mats, H.room.rules.teams], [3, 100, 'humans']);
  // no changes once the match runs
  H.send(a, { t: 'start' });
  assert.equal(H.room.phase, 'bus');
  H.send(a, { t: 'mode', id: 'solo' });
  H.send(a, { t: 'tweak', bots: 0 });
  assert.equal(H.room.settings.modeId, 'squadbots');
  assert.equal(H.room.rules.bots, 3);
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('settings: a party carries its mode to a new room (server create / P2P host), legacy settings map to modes', () => {
  const H = makeRoom();
  const a = H.join('Ann');
  H.send(a, { t: 'mode', id: 'playground' });
  H.send(a, { t: 'tweak', botSkill: 'easy' });
  const s = H.room.settings;
  const r2 = new Room({ now: () => 0, settings: JSON.parse(JSON.stringify(s)) });
  assert.deepEqual(r2.settings, s);
  assert.deepEqual(r2.rules, s.rules);
  const custom = settingsFrom({ rules: { teams: 3, junk: 2 }, custom: true, info: { name: 'Trio Time' } });
  assert.deepEqual([custom.modeId, custom.info.name, custom.rules.teams], ['custom', 'Trio Time', 3]);
  assert.equal(settingsFrom({ mode: 'squad', bots: 3 }).modeId, 'squadbots');
  assert.equal(settingsFrom({}, true).rules.bots, 19);
  assert.equal(settingsFrom({}).rules.bots, 7);
  assert.equal(settingsFrom({ modeId: 'duos' }).rules.teams, 2);
  // every playable registry mode turns into valid settings
  for (const m of MODES) {
    const ms = modeSettings(m.id);
    assert.equal(ms.modeId, m.id);
    assert.deepEqual(ms.rules, normalizeRules(ms.rules, GAME_OPTS));
  }
  assert.ok(modeTags(modeRules('playground')).includes('No Storm'));
});

// ------------------------------------------------------------------ teams
test('teams: party sizes 1-5 x teams 1/2/3/4/two/humans keep the party together and never pass maxPlayers', () => {
  for (const teams of [1, 2, 3, 4, 'two', 'humans']) {
    for (const maxPlayers of [32, 16, 8, 4]) {
      for (let humans = 1; humans <= 5; humans++) {
        const H = makeRoom({ drop: ['s'] });
        const cs = [];
        for (let i = 0; i < humans; i++) cs.push(H.join(NAMES[i]));
        H.send(cs[0], { t: 'mode', custom: { teams, maxPlayers, bots: 19 } });
        H.send(cs[0], { t: 'start' });
        const st = H.last(cs[0], 'start');
        const ps = [...H.room.players.values()];
        const hs = ps.filter((p) => !p.bot);
        const tag = `teams ${teams}, max ${maxPlayers}, ${humans} humans`;
        assert.ok(ps.length <= Math.max(maxPlayers, humans), `${tag}: ${ps.length} players`);
        assert.equal(hs.length, humans);
        assert.deepEqual(st.players.map((p) => p.team), [...H.room.players.values()].map((p) => p.team));
        if (typeof teams === 'number' && teams > 1) {
          // humans in join order fill teams: the first `teams` humans play together
          hs.forEach((p, i) => assert.equal(p.team, Math.floor(i / teams) + 1, tag));
          const size = new Map();
          for (const p of ps) size.set(p.team, (size.get(p.team) || 0) + 1);
          for (const n of size.values()) assert.ok(n <= teams, `${tag}: team of ${n}`);
          if (ps.some((p) => p.bot)) assert.equal(ps.length % teams, 0, `${tag}: full teams when bots fill in`);
          assert.equal(st.teams.length, size.size);
          st.teams.forEach((t, i) => assert.deepEqual(t, { id: i + 1, name: TEAM_COLORS[i].name, color: TEAM_COLORS[i].color }));
        } else if (teams === 'humans') {
          assert.ok(hs.every((p) => p.team === 1));
          assert.ok(ps.filter((p) => p.bot).every((p) => p.team !== 1 && p.team === 1000 + p.id));
          if (humans < maxPlayers) assert.ok(ps.some((p) => p.bot));
          assert.deepEqual(st.teams.map((t) => t.name), ['Your squad']);
        } else if (teams === 'two') {
          const n1 = ps.filter((p) => p.team === 1).length, n2 = ps.filter((p) => p.team === 2).length;
          assert.equal(n1 + n2, ps.length);
          assert.ok(Math.abs(n1 - n2) <= 1, `${tag}: ${n1} vs ${n2}`);
          const h1 = hs.filter((p) => p.team === 1).length;
          assert.ok(Math.abs(h1 - (humans - h1)) <= 1, 'humans split evenly');
        } else {
          assert.ok(ps.every((p) => p.team === 1000 + p.id), 'free for all');
          assert.equal(st.teams.length, 0);
        }
        assert.equal(H.errors.length, 0);
      }
    }
  }
  // the bot count rounding on its own
  const R = (x) => normalizeRules(x);
  assert.equal(botCountFor(R({ teams: 2, bots: 19 }), 1), 19);
  assert.equal(botCountFor(R({ teams: 2, bots: 19 }), 2), 20);
  assert.equal(botCountFor(R({ teams: 4, bots: 31 }), 3), 29);
  assert.equal(botCountFor(R({ teams: 2, bots: 0 }), 3), 0, 'no bots wanted: none added');
  assert.equal(botCountFor(R({ maxPlayers: 2, bots: 1 }), 3), 0);
});

// ------------------------------------------------------------------ areas and spawns
test('areas: full, center, random, a named place, a biome (and fallbacks)', () => {
  const IR = MAP.islandRadius;
  assert.deepEqual(resolveArea(world, 'full'), { x: 0, z: 0, r: IR * 1.1 });
  assert.deepEqual(resolveArea(world, 'center'), { x: 0, z: 0, r: IR * 0.35 });
  const rnd = resolveArea(world, 'random', mulberry32(3));
  assert.equal(rnd.r, 150);
  assert.ok(world.regions.some((g) => g.x === rnd.x && g.z === rnd.z));
  const g = world.regions[0];
  assert.deepEqual(resolveArea(world, `poi:${g.name}`), { x: g.x, z: g.z, r: Math.max(90, g.r * 2) });
  assert.deepEqual(resolveArea(world, `poi:${g.name.toUpperCase()}`), resolveArea(world, `poi:${g.name}`));
  assert.deepEqual(resolveArea(world, 'poi:Nowhere'), fullArea());
  const beach = resolveArea(world, 'biome:beach');
  assert.ok(beach.r > 60 && beach.r <= fullArea().r);
  assert.deepEqual(resolveArea(world, 'biome:volcano'), world.version === 1 ? fullArea() : resolveArea(world, 'biome:volcano'));
});

test('spawns: on land, inside the area, teammates within 15 m, enemy teams at least 40 m apart (200 seeds)', () => {
  const configs = [['full', 1, 20], ['full', 2, 20], ['full', 3, 18], ['full', 4, 20], ['full', 'two', 16], ['full', 1, 32],
    ['center', 'two', 16], ['random', 2, 8], ['random', 1, 4], [`poi:${world.regions[0].name}`, 1, 8]];
  let checked = 0;
  for (const [area, teams, n] of configs) {
    let minEnemy = Infinity, maxMate = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed * 7 + n);
      const A = resolveArea(world, area, rng);
      const ps = Array.from({ length: n }, (_, i) => ({ id: i + 1, bot: i > 1 }));
      assignTeams(ps.filter((p) => !p.bot), ps.filter((p) => p.bot), normalizeRules({ teams }));
      const sp = pickSpawns(world, A, ps, rng);
      for (const p of ps) {
        const s = sp.get(p.id);
        const h = world.heightAt(s.x, s.z);
        assert.ok(h > 1.5 && Math.abs(s.y - h) < 1e-9, `${area}: on land`);
        assert.ok(Math.hypot(s.x - A.x, s.z - A.z) <= A.r, `${area}: inside the area`);
        assert.equal(world.solidNear(s.x, s.y + 0.9, s.z, null, 0.3), false, 'not inside anything');
        for (const q of ps) {
          if (q.id <= p.id) continue;
          const t = sp.get(q.id), d = Math.hypot(s.x - t.x, s.z - t.z);
          if (q.team === p.team) maxMate = Math.max(maxMate, d); else minEnemy = Math.min(minEnemy, d);
        }
        checked++;
      }
    }
    assert.ok(maxMate <= 15, `${area} teams ${teams}: teammates ${maxMate.toFixed(1)} m apart`);
    assert.ok(minEnemy >= 40, `${area} teams ${teams} x${n}: enemies ${minEnemy.toFixed(1)} m apart`);
  }
  assert.ok(checked > 30000);
  // the room uses them: a ground start puts everyone on their spot, a sky start 90 m above it
  for (const spawn of ['ground', 'sky']) {
    const { H, start } = match({ spawn, teams: 2, bots: 5 });
    assert.equal(H.room.phase, 'match', 'no bus: straight into the match');
    assert.equal(start.bus, null);
    for (const p of H.room.players.values()) {
      const [x, y, z, how] = start.spawns[p.id];
      assert.equal(how, spawn);
      assert.ok(Math.abs(y - world.heightAt(x, z) - (spawn === 'sky' ? SKY_SPAWN_HEIGHT : 0)) < 0.02);
      assert.ok(Math.abs(p.x - x) < 0.01 && Math.abs(p.z - z) < 0.01 && !p.inBus);
    }
  }
});

// ------------------------------------------------------------------ respawn and lives
test('respawn: 5.00 s after the elimination, lives count down, the last life eliminates', () => {
  const { H, cs: [a, b] } = match({ respawn: 5, lives: 3, hp: 100, shield: 50 });
  const B = b.p;
  for (let life = 3; life >= 1; life--) {
    const t0 = H.now();
    snipe(H, a, B);
    assert.equal(B.alive, false);
    assert.equal(B.lives, life - 1);
    const elim = H.last(b, 'elim');
    if (life > 1) {
      assert.equal(elim.rs, 5, 'the elimination says a respawn is coming');
      H.advance(4900);
      assert.equal(B.alive, false);
      H.advance(150);
      const rsp = H.last(b, 'respawn');
      assert.ok(rsp && rsp.id === B.id, 'respawned');
      assert.ok(B.alive);
      const at = H.now() - t0;
      assert.ok(at >= 4940 && at <= 5060, `respawn after ${at} ms`);
      assert.equal(rsp.how, 'ground');
      assert.deepEqual([B.hp, B.sh, rsp.hp, rsp.sh], [100, 50, 100, 50]);
      assert.ok(world.heightAt(rsp.x, rsp.z) > 1.5);
      H.clear(b);
    } else {
      assert.equal(elim.rs, 0, 'out of lives');
      H.advance(6000);
      assert.equal(B.alive, false);
    }
  }
  assert.equal(H.room.phase, 'ended');
  assert.deepEqual([H.last(b, 'win').id, H.last(b, 'win').reason], [a.pid, 'last']);
});

test('respawn: in the sky by default, away from enemies, inside the storm; loadout again unless respawnKeep', () => {
  const { H, cs: [a, b] } = match({ respawn: 3, lives: 0, spawn: 'bus', loadout: 'zonewars', storm: 'classic' });
  for (const c of [a, b]) H.send(c, { t: 'drop' });
  H.room.phase = 'match';
  snipe(H, a, b.p);
  H.advance(3100);
  const r = H.last(b, 'respawn');
  assert.equal(r.how, 'sky');
  assert.ok(Math.abs(r.y - world.heightAt(r.x, r.z) - SKY_SPAWN_HEIGHT) < 0.02);
  assert.ok(r.lo && r.lo.slots.length === 4, 'zone wars loadout again');
  const st = H.room.stormNow();
  assert.ok(Math.hypot(r.x - st.cx, r.z - st.cz) < st.r);
  // far from the only enemy (Ann), when the area allows
  assert.ok(Math.hypot(r.x - a.p.x, r.z - a.p.z) >= 40);
  const keep = match({ respawn: 3, lives: 0, respawnKeep: true, loadout: 'pool' });
  snipe(keep.H, keep.cs[0], keep.cs[1].p);
  keep.H.advance(3100);
  assert.equal(keep.H.last(keep.cs[1], 'respawn').lo, null, 'respawnKeep: keep your loot');
});

test('respawn: a player who leaves never comes back and does not keep the match going', () => {
  const { H, cs: [a, b, c] } = match({ respawn: 3, lives: 0 }, { humans: 3 });
  snipe(H, a, b.p);
  assert.ok(b.p.respawnAt > 0);
  H.leave(b);
  H.advance(4000);
  assert.equal(H.msgs(a, 'respawn').length, 0);
  assert.equal(H.room.phase, 'match');
  H.leave(c); // only Ann left
  assert.equal(H.room.phase, 'ended');
  assert.equal(H.last(a, 'win').id, a.pid);
});

// ------------------------------------------------------------------ win types
test('win types: last, elims, teamelims and time pick the right winner and reason', () => {
  // last one standing
  {
    const { H, cs: [a, b, c] } = match({}, { humans: 3 });
    snipe(H, a, b.p);
    assert.equal(H.room.phase, 'match');
    snipe(H, c, a.p);
    const w = H.last(a, 'win');
    assert.deepEqual([w.id, w.reason, w.name, w.bot, w.early], [c.pid, 'last', 'Cat', false, false]);
    assert.ok(Array.isArray(w.scores) && w.mvp && w.mvp.id === c.pid || w.mvp.id === a.pid);
  }
  // first to 5 eliminations
  {
    const { H, cs: [a, b, c] } = match({ win: 'elims', target: 5, respawn: 3, lives: 0 }, { humans: 3 });
    for (let i = 0; i < 4; i++) { snipe(H, a, b.p); H.advance(3100); }
    snipe(H, c, b.p);
    H.advance(3100);
    assert.equal(H.room.phase, 'match');
    assert.deepEqual(H.room.runtime.scores(), [[a.pid, 4], [c.pid, 1]]);
    snipe(H, a, c.p);
    const w = H.last(b, 'win');
    assert.deepEqual([w.id, w.reason, w.name, w.byTeam], [a.pid, 'elims', 'Ann', false]);
    assert.deepEqual(w.scores, [[a.pid, 5], [c.pid, 1]]);
    assert.deepEqual([w.mvp.id, w.mvp.kills], [a.pid, 5]);
  }
  // team elimination race
  {
    const { H, cs: [a, b, c, d] } = match({ teams: 2, win: 'teamelims', target: 5, respawn: 3, lives: 0 }, { humans: 4 });
    assert.deepEqual([a.p.team, b.p.team, c.p.team, d.p.team], [1, 1, 2, 2]);
    snipe(H, a, b.p);
    assert.equal(b.p.alive, true, 'no friendly fire');
    for (let i = 0; i < 2; i++) { snipe(H, a, c.p); snipe(H, b, d.p); H.advance(3100); }
    snipe(H, d, a.p);
    H.advance(3100);
    assert.equal(H.room.phase, 'match');
    snipe(H, b, c.p);
    const w = H.last(c, 'win');
    assert.deepEqual([w.team, w.reason, w.name, w.byTeam], [1, 'teamelims', 'Blue Team', true]);
    assert.deepEqual(w.scores, [[1, 5], [2, 1]]);
    assert.ok(w.id === a.pid || w.id === b.pid);
  }
  // most eliminations when the time runs out (and the limit fires on time)
  {
    const { H, cs: [a, b, c] } = match({ win: 'time', timeLimit: 180, respawn: 3, lives: 0 }, { humans: 3 });
    assert.equal(H.room.rules.timeLimit, 180);
    const t0 = H.now();
    snipe(H, a, b.p); H.advance(3100);
    snipe(H, c, b.p); H.advance(3100);
    snipe(H, a, c.p);
    while (H.room.phase === 'match') H.advance(10);
    const late = H.now() - t0 - 180000;
    assert.ok(Math.abs(late) <= 60, `time limit fired ${late} ms off`);
    const w = H.last(b, 'win');
    assert.deepEqual([w.id, w.reason], [a.pid, 'time']);
  }
  // time with teams: per-team scores
  {
    const { H, cs: [a, b, c, d] } = match({ teams: 2, win: 'time', timeLimit: 180, respawn: 3, lives: 0 }, { humans: 4 });
    snipe(H, c, a.p);
    H.advance(181000);
    const w = H.last(a, 'win');
    assert.deepEqual([w.team, w.reason, w.byTeam], [2, 'time', true]);
  }
});

test('win types: core games through FakeCtx too (same API as the Room)', () => {
  const ctx = new FakeCtx({ game: CORE_GAMES.elims, rules: { win: 'elims', target: 5, respawn: 3, lives: 0 }, players: 3 });
  ctx.start();
  const [p1, p2, p3] = ctx.players();
  for (let i = 0; i < 4; i++) { ctx.hit(p1, i % 2 ? p2 : p3, 999); ctx.advance(3000); }
  assert.equal(ctx.result, null);
  ctx.hit(p1, p3, 999);
  assert.deepEqual(ctx.result, { id: p1.id, reason: 'elims' });
  const solo = new FakeCtx({ game: CORE_GAMES.last, players: 1 });
  solo.start();
  solo.advance(1000);
  assert.equal(solo.result, null, 'one team only (Playground): never "last standing"');
  assert.equal(lastTeamStanding(solo), null);
});

test('Playground on your own: no storm, no damage, infinite building, never ends by itself', () => {
  const H = makeRoom({ solo: true, drop: ['s'] });
  const a = H.join('Ann');
  H.send(a, { t: 'mode', id: 'playground' });
  H.send(a, { t: 'start' });
  const st = H.last(a, 'start');
  assert.equal(H.room.phase, 'match');
  assert.equal(H.room.storm, null);
  assert.equal(st.players.length, 1);
  const lo = st.lo[0][0];
  const best = (k) => Math.max(...WEAPONS[k].rarities);
  assert.ok(lo.infAmmo && lo.slots.length === 1 && lo.slots[0].r === best(lo.slots[0].k), 'the best version of a gun from the pool, infinite ammo');
  H.advance(120000);
  assert.equal(H.room.phase, 'match');
  assert.equal(H.msgs(a, 'dmg').length, 0);
  H.send(a, { t: 'end' });
  assert.equal(H.room.phase, 'lobby');
});

// ------------------------------------------------------------------ storm
test('storm: every preset reaches done, every circle centre is on land, the last circles drift', () => {
  for (const storm of ['classic', 'fast', 'slow', 'final', 'zonewars']) {
    for (const area of ['full', 'center', 'random', `poi:${world.regions[2].name}`]) {
      const { H, cs, room } = match({ storm, area }, { humans: 2 });
      for (const c of cs) c.p.hp = 1e9; // nobody dies, so the storm runs to the end
      const P = STORM_PRESETS[storm];
      const s = room.storm;
      if (storm === 'final') assert.ok(s.r <= 140 + 1e-9);
      if (storm === 'zonewars') assert.ok(s.r <= 120 + 1e-9 && s.tEnd - H.now() === P.phases[0].wait * 1000);
      const centres = [[s.cx, s.cz]];
      let lastI = -1;
      let guard = 0;
      while (room.storm.state !== 'done' && guard++ < 20000) {
        H.advance(500);
        if (room.storm.i !== lastI) { lastI = room.storm.i; centres.push([room.storm.ncx, room.storm.ncz]); }
      }
      assert.equal(room.storm.state, 'done', `${storm} / ${area} finished`);
      assert.equal(room.storm.phases.length, P.phases.length);
      for (const [x, z] of centres) assert.ok(world.heightAt(x, z) > 1.5, `${storm} / ${area}: centre ${x.toFixed(0)},${z.toFixed(0)} on land`);
      assert.equal(H.errors.length, 0);
    }
  }
  // presets: 6 classic phases on the 640 m island (8 on the big one); fast / slow scale the times
  assert.equal(STORM_PRESETS.classic.phases.length, MAP.size <= 700 ? 6 : 8);
  if (MAP.size <= 700) assert.deepEqual(STORM_PRESETS.classic.phases, STORM.phases);
  STORM_PRESETS.classic.phases.forEach((p, i) => {
    assert.equal(STORM_PRESETS.fast.phases[i].wait, Math.round(p.wait * 0.6));
    assert.equal(STORM_PRESETS.slow.phases[i].shrink, Math.round(p.shrink * 1.6));
  });
  assert.equal(STORM_PRESETS.final.phases.length, 3);
  assert.equal(STORM_PRESETS.none, null);
  const none = match({ storm: 'none' });
  assert.equal(none.room.storm, null);
  none.H.advance(5000);
  assert.equal(none.H.msgs(none.cs[0], 'dmg').length, 0);
});

test('storm: the wait is cut to 20 s once only 3 of 20 are left (not with 8 left)', () => {
  const { H, cs: [a], room } = match({ bots: 19, storm: 'classic' }, { humans: 1 });
  const bots = [...room.players.values()].filter((p) => p.bot);
  assert.equal(room.players.size, 20);
  assert.equal(room.storm.state, 'wait');
  const waitLeft = () => room.storm.tEnd - H.now();
  assert.ok(waitLeft() > 60000);
  for (const b of bots.slice(0, 12)) room.eliminate(b, null, { c: 'test' });
  H.advance(100);
  assert.ok(waitLeft() > 20000, '8 of 20 left: no cut');
  for (const b of bots.slice(12, 17)) room.eliminate(b, null, { c: 'test' });
  assert.equal(room.aliveCount(), 3);
  H.advance(100);
  assert.ok(waitLeft() <= 20000 && waitLeft() > 19000, `cut to 20 s (${waitLeft()} ms)`);
  assert.ok(H.msgs(a, 'note').some((n) => /20 seconds/.test(n.msg)));
  // once per phase
  const end = room.storm.tEnd;
  H.advance(1000);
  assert.equal(room.storm.tEnd, end);
});

test('storm: lava zones burn 10 per second through shields', () => {
  const { H, cs: [a, b], room } = match({});
  const saved = world.lava;
  try {
    world.lava = [{ x: a.p.x, z: a.p.z, r: 6 }];
    a.p.y = world.heightAt(a.p.x, a.p.z);
    H.advance(1050);
    assert.deepEqual([a.p.hp, a.p.sh], [90, 100]);
    assert.equal(b.p.hp, 100);
  } finally { world.lava = saved; }
});

// ------------------------------------------------------------------ loot
test('loot: the client rolls exactly the room\'s floor loot from lootSeed (20 seeds, many rule sets)', () => {
  const clientWorld = generateWorld(MAP.seed); // a separate island, as a browser builds its own
  const variants = [{}, { loot: 'snipers' }, { rarity: 'legendary' }, { heals: 'extra' }, { heals: 'none' }, { loot: 'pickaxe' },
    { area: 'center' }, { area: 'random' }, { rarity: 'common', loot: 'shotguns' }, { area: `poi:${world.regions[1].name}`, rarity: 'boosted' }];
  for (let i = 0; i < 20; i++) {
    const { H, cs: [a], room, start } = match(variants[i % variants.length], { humans: 1 });
    assert.equal(start.loot, undefined, 'no per-item list in start');
    assert.equal(start.lootN, room.loot.size);
    const mine = rollInitialLoot(clientWorld, start.lootSeed, normalizeRules(start.rules), start.area);
    assert.deepEqual(mine, [...room.loot.values()], `seed ${start.lootSeed}`);
    // a client whose list disagrees asks for the real one
    H.send(a, { t: 'lootall' });
    assert.deepEqual(H.last(a, 'lootall').loot, [...room.loot.values()]);
    H.send(a, { t: 'lootall' });
    assert.equal(H.msgs(a, 'lootall').length, 1, 'at most one answer per 2 s');
  }
});

test('loot: pools, rarity, heals, floor loot and chests follow the rules', () => {
  const items = (rules) => rollInitialLoot(world, 1234, normalizeRules(rules), null).map((l) => l.item);
  const guns = (list) => list.filter((it) => WEAPONS[it.k]);
  assert.ok(guns(items({})).length > 50);
  for (const [pool, keys] of Object.entries(LOOT_POOLS)) {
    const g = guns(items({ loot: pool }));
    if (!keys) continue;
    assert.ok(g.every((it) => keys.includes(it.k)), pool);
    assert.equal(g.length > 0, keys.length > 0, pool);
    assert.deepEqual(poolKeys(pool), keys);
  }
  assert.ok(guns(items({ rarity: 'legendary' })).every((it) => it.r === Math.max(...WEAPONS[it.k].rarities)));
  assert.ok(guns(items({ rarity: 'common' })).every((it) => it.r === Math.min(...WEAPONS[it.k].rarities)));
  const avg = (list) => list.reduce((s, it) => s + it.r, 0) / list.length;
  assert.ok(avg(guns(items({ rarity: 'boosted' }))) > avg(guns(items({}))) + 0.5);
  const heals = (list) => list.filter((it) => HEALS[it.k]).length;
  assert.equal(heals(items({ heals: 'none' })), 0);
  assert.ok(heals(items({ heals: 'extra' })) > heals(items({})) * 1.5);
  assert.deepEqual(items({ floorLoot: false }), []);
  // an area only gets the loot inside it (+30 m)
  const A = resolveArea(world, 'center');
  const inside = rollInitialLoot(world, 9, normalizeRules({}), A);
  assert.ok(inside.length > 0 && inside.every((l) => Math.hypot(l.x - A.x, l.z - A.z) < A.r + 31));
  assert.ok(inside.length < rollInitialLoot(world, 9, normalizeRules({}), null).length);
  // chests
  const rng = mulberry32(5);
  for (let i = 0; i < 200; i++) {
    const it = rollChest(rng, normalizeRules({ loot: 'snipers', heals: 'none' }), i % 2 ? 'hot' : 'normal');
    assert.equal(it[0].k, 'sniper');
    assert.ok(!it.some((x) => HEALS[x.k]));
  }
  assert.ok(rollChest(rng, normalizeRules({ loot: 'pickaxe' })).every((x) => !WEAPONS[x.k]));
  assert.equal(rollWeapon(rng, 'pickaxe'), null);
});

test('loot: no chests means the chest handler refuses and clients are told', () => {
  const { H, cs: [a], start } = match({ chests: false }, { humans: 1 });
  assert.equal(start.chestsOff, true);
  const ch = world.chests[0];
  Object.assign(a.p, { x: ch.x, y: ch.y, z: ch.z });
  H.send(a, { t: 'chest', c: 0 });
  assert.equal(H.msgs(a, 'chest').length, 0);
  assert.equal(H.room.chestsOpened.size, 0);
});

test('loot: a repeated chest request is answered once, to the sender only, with no duplicate loot', () => {
  const { H, cs: [a, b], room } = match({});
  const ch = world.chests[3];
  Object.assign(a.p, { x: ch.x, y: ch.y, z: ch.z });
  const n0 = room.loot.size;
  H.send(a, { t: 'chest', c: 3 });
  assert.equal(H.msgs(b, 'chest').length, 1);
  assert.equal(H.msgs(b, 'l+').length, 1);
  const n1 = room.loot.size;
  assert.ok(n1 >= n0 + 3);
  H.send(a, { t: 'chest', c: 3 });
  H.send(a, { t: 'chest', c: 3 });
  assert.equal(H.msgs(a, 'chest').length, 3, 'the sender hears the chest is open');
  assert.equal(H.msgs(b, 'chest').length, 1, 'nobody else is spammed');
  assert.equal(H.msgs(b, 'l+').length, 1);
  assert.equal(room.loot.size, n1, 'no duplicate loot');
});

test('loadouts: build fight, zone wars, pickaxe, pool; mats and infinite ammo from the rules', () => {
  const lo = (rules) => makeLoadout(normalizeRules(rules), mulberry32(1));
  const bf = lo({ loadout: 'buildfight', mats: 500 });
  assert.deepEqual(bf.slots, [{ k: 'shotgun', r: 3, m: 5 }, { k: 'ar', r: 4, m: 30 }, { k: 'shield_b', n: 2 }]);
  assert.deepEqual(bf.mats, { wood: 500, stone: 500, metal: 500 });
  assert.ok(bf.ammo.shells > 0 && bf.ammo.medium > 0);
  const zw = lo({ loadout: 'zonewars' });
  assert.deepEqual(zw.slots.map((s) => [s.k, s.r ?? s.n]), [['ar', 3], ['shotgun', 3], ['smg', 2], ['shield_b', 2]]);
  assert.deepEqual(lo({ loadout: 'pickaxe' }).slots, []);
  assert.equal(lo({}), null, 'no loadout, no mats: nothing');
  assert.deepEqual(lo({ mats: 100 }).mats, { wood: 100, stone: 100, metal: 100 });
  for (let i = 0; i < 50; i++) {
    const p = makeLoadout(normalizeRules({ loadout: 'pool', loot: 'shotguns', ammo: 'infinite' }), mulberry32(i));
    assert.equal(p.slots.length, 1);
    assert.ok(['shotgun', 'tactical'].includes(p.slots[0].k) && p.slots[0].r === 3);
    assert.equal(p.infAmmo, true);
  }
  // the start message carries them, grouped
  const { H, cs: [a, b], start } = match({ loadout: 'zonewars', mats: 200 });
  assert.equal(start.lo.length, 1);
  assert.deepEqual(start.lo[0][1].sort(), [a.pid, b.pid].sort());
  assert.equal(start.lo[0][0].mats.wood, 200);
  // a loadout from a game is made safe
  assert.deepEqual(cleanLoadout({ slots: [{ k: 'ar', r: 9, m: 999 }, { k: 'nope' }, { k: 'medkit', n: 50 }, { k: 'pickaxe' }], ammo: { medium: 5000, x: 3 }, mats: { wood: -4 } }),
    { slots: [{ k: 'ar', r: 4, m: 30 }, null, { k: 'medkit', n: 3 }], ammo: { medium: 999 }, mats: { wood: 0, stone: 0, metal: 0 } });
  assert.equal(H.errors.length, 0);
});

// ------------------------------------------------------------------ rules in play
test('rules in play: build off, pvp off, double damage, one shot, headshots only, armor, hp / shield / siphon', () => {
  // build off: the room says no (the warm-up still builds)
  {
    const H = makeRoom({ drop: ['s'] });
    const a = H.join('Ann'), b = H.join('Ben');
    H.send(a, { t: 'mode', custom: { build: 'off', bots: 0, spawn: 'ground' } });
    const g = world.pois[0];
    const k = `f${Math.floor(g.x / 4)},-1,${Math.floor(g.z / 4)}`;
    H.send(a, { t: 'b', k, m: 'wood' });
    assert.ok(H.last(b, 'b+'), 'warm-up building works');
    H.send(a, { t: 'start' });
    H.send(a, { t: 'b', k: pieceKey('f', Math.floor(a.p.x / 4), 0, Math.floor(a.p.z / 4)), m: 'wood' });
    assert.ok(H.last(a, 'bno'));
    assert.equal(H.room.grid.pieces.size, 0);
  }
  // pvp off: no damage between players
  {
    const { H, cs: [a, b] } = match({ pvp: false });
    snipe(H, a, b.p);
    assert.deepEqual([b.p.hp, b.p.sh, b.p.alive], [100, 100, true]);
    assert.equal(H.msgs(b, 'dmg').length, 0);
  }
  // double damage
  {
    const { H, cs: [a, b] } = match({ dmg: 2 });
    ar(H, a, b);
    assert.equal(b.p.sh, 100 - 2 * weaponDamage('ar', 0, 10, false));
  }
  // one shot: any hit eliminates from 100/100
  {
    const { H, cs: [a, b] } = match({ oneShot: true });
    H.send(a, { t: 'hit', tg: b.pid, w: 'pistol', r: 0, d: 10, n: 1, nh: 0 });
    assert.equal(b.p.alive, false);
  }
  // headshots only
  {
    const { H, cs: [a, b] } = match({ headOnly: true });
    ar(H, a, b, 1, 0);
    assert.equal(b.p.sh, 100, 'body shots do nothing');
    ar(H, a, b, 0, 1);
    assert.equal(b.p.sh, 100 - weaponDamage('ar', 0, 10, true));
    H.send(a, { t: 'boom', w: 'rocket', r: 3, x: b.p.x, y: b.p.y + 0.9, z: b.p.z });
    assert.equal(b.p.sh, 100 - weaponDamage('ar', 0, 10, true), 'no splash either');
  }
  // armor (a mode role): damage taken x armor
  {
    const { H, cs: [a, b], room } = match({});
    room.runtime.setArmor(b.p, 0.5);
    ar(H, a, b);
    assert.equal(b.p.sh, 100 - weaponDamage('ar', 0, 10, false) / 2);
  }
  // hp, shield and siphon
  {
    const { H, cs: [a, b, c] } = match({ hp: 50, shield: 0, siphon: 25 }, { humans: 3 });
    assert.deepEqual([a.p.hp, a.p.sh, a.p.maxHp], [50, 0, 50]);
    ar(H, b, a);
    assert.equal(a.p.hp, 50 - 30);
    snipe(H, a, c.p);
    assert.deepEqual([a.p.hp, a.p.sh], [45, 0], 'siphon 25 heals up to the 50 max');
    H.send(a, { t: 'heal', k: 'medkit' });
    assert.equal(a.p.hp, 50, 'heals stop at the mode\'s max health');
  }
  {
    const { H, cs: [a, b, c] } = match({ siphon: 0 }, { humans: 3 });
    a.p.hp = 20;
    snipe(H, a, b.p);
    assert.equal(a.p.hp, 20);
    assert.equal(H.msgs(c, 'siphon').length, 0);
  }
  // no fall damage
  {
    const { H, cs: [a] } = match({ fallDamage: false });
    H.send(a, { t: 'fall', d: 150 });
    assert.equal(a.p.hp, 100);
  }
});

test('the big map: positions clamp to the island plus a margin; rocket splash only checks nearby objects', () => {
  const { H, cs: [a, b], room } = match({});
  const lim = MAP.size / 2 + 60;
  H.send(a, { t: 'u', s: [1e6, 1e6, -1e6, 0, 0, 0, 0, 0, 0, 'ar', 0] });
  assert.deepEqual([a.p.x, a.p.y, a.p.z], [lim, 600, -lim]);
  H.send(a, { t: 'u', s: [500, -900, 500, 0, 0, 0, 0, 0, 0, 'ar', 0] });
  assert.deepEqual([a.p.x, a.p.y, a.p.z], [Math.min(500, lim), -50, Math.min(500, lim)]);
  // a rocket next to a tree damages exactly the objects a full scan would
  const tree = world.objects.find((o) => o.kind === 'tree' && o.hp > 0);
  const x = tree.x + 1.5, y = tree.y + 1, z = tree.z;
  const want = world.objects.filter((o) => o.hp > 0 && Math.hypot(o.x - x, o.y - y, o.z - z) < WEAPONS.rocket.splash + 2).map((o) => o.id).sort();
  H.send(a, { t: 'boom', w: 'rocket', r: 3, x, y, z });
  const got = [...room.objHp.keys(), ...room.destroyed].sort();
  assert.deepEqual(got, want);
  assert.ok(got.includes(tree.id));
});

// ------------------------------------------------------------------ the end
test('humans out: the bots play on for 20 s of spectating, then win.id 0 and no bot is named', () => {
  const { H, cs: [a], room } = match({ bots: 3 }, { humans: 1, solo: true });
  assert.equal(room.players.size, 4);
  H.send(a, { t: 'fall', d: 500 });
  assert.equal(a.p.alive, false);
  const elim = H.last(a, 'elim');
  assert.deepEqual([elim.place, elim.rs], [4, 0]);
  H.advance(19900);
  assert.equal(room.phase, 'match', 'the match keeps going while the human spectates');
  assert.equal(H.msgs(a, 'win').length, 0);
  H.advance(200);
  const w = H.last(a, 'win');
  assert.deepEqual([w.id, w.reason, w.name, w.bot, w.early], [0, 'humans-out', '', false, true]);
  H.advance(7100);
  assert.equal(room.phase, 'lobby');
  // the bots finishing it during the 20 s still names nobody
  const m2 = match({ bots: 2 }, { humans: 1, solo: true });
  m2.H.send(m2.cs[0], { t: 'fall', d: 500 });
  const [b1] = [...m2.room.players.values()].filter((p) => p.bot);
  m2.room.eliminate(b1, null, { c: 'storm' });
  const w2 = m2.H.last(m2.cs[0], 'win');
  assert.deepEqual([w2.id, w2.reason, w2.bot], [0, 'humans-out', false]);
  // a human still respawning is not out
  const m3 = match({ bots: 2, respawn: 3, lives: 0 }, { humans: 1, solo: true });
  m3.H.send(m3.cs[0], { t: 'fall', d: 500 });
  m3.H.advance(25000);
  assert.equal(m3.room.phase, 'match');
});

test('mode state: ms at most 4 times a second, only when it changes, small; welcome carries it', () => {
  const { H, cs: [a, b] } = match({ win: 'elims', target: 10, respawn: 5, lives: 0, timeLimit: 300 }, { drop: ['s'] });
  H.clear(a);
  H.advance(3000);
  const ms = H.msgs(a, 'ms');
  assert.ok(ms.length >= 3 && ms.length <= 4, `${ms.length} in 3 s (changes once a second: the clock)`);
  snipe(H, a, b.p);
  const m = H.last(a, 'ms');
  assert.deepEqual(m.sc, [[a.pid, 1]]);
  assert.equal(m.goal, 10);
  assert.ok(m.tl > 290 && m.tl <= 300);
  assert.deepEqual(m.rs, { [b.pid]: 5 }, 'the respawn timer goes out right away');
  assert.ok(JSON.stringify(m).length <= 300);
  for (let i = 0; i < 40; i++) H.advance(50);
  const times = H.msgs(a, 'ms').length;
  assert.ok(times - ms.length <= 4 + 1);
  const late = H.join('Cat');
  const wm = H.last(late, 'welcome');
  assert.equal(wm.ms.goal, 10);
  assert.equal(wm.rules.win, 'elims');
});

test('the Game plugin ctx on the Room: roles, armor, loadouts, team changes, notes, hud, errors', () => {
  const { H, cs: [a, b, c], room } = match({ respawn: 3, lives: 0 }, { humans: 3 });
  const ctx = room.runtime;
  const calls = [];
  ctx.game = {
    key: 'probe',
    tick(x, dt) { calls.push(['tick', dt]); },
    onKill(x, v, k) { calls.push(['kill', v.id, k && k.id]); x.setRole(v, 'zombie'); x.setTeam(v, 99); x.respawn(v, 1); },
    onRespawn(x, p) { calls.push(['respawn', p.id]); x.giveLoadout(p, { slots: [{ k: 'pickaxe' }, { k: 'rocket', r: 4 }], ammo: { rockets: 9 } }); },
    hud(x) { return { n: x.players().length, zombies: x.players().filter((p) => x.roleOf(p) === 'zombie').length }; },
    allowDamage(x, att, tg) { return x.roleOf(tg) !== 'ghost'; },
    scaleDamage(x, att, tg, amt) { return amt + 1; },
    checkWin() { throw new Error('oops'); },
  };
  H.advance(150);
  assert.ok(calls.some((e) => e[0] === 'tick' && Math.abs(e[1] - 0.1) < 0.051));
  assert.ok(H.errors.some((e) => e.msg === 'plugin error' && e.plugin === 'probe' && e.hook === 'checkWin'), 'a throwing game is logged');
  ar(H, a, c);
  assert.equal(c.p.sh, 100 - weaponDamage('ar', 0, 10, false) - 1, 'scaleDamage');
  snipe(H, a, b.p);
  assert.deepEqual(calls.find((e) => e[0] === 'kill'), ['kill', b.pid, a.pid]);
  assert.deepEqual(H.last(c, 'role'), { t: 'role', id: b.pid, role: 'zombie' });
  H.advance(100);
  assert.equal(H.last(c, 'roster').players.find((p) => p.id === b.pid).team, 99, 'team changes reach everyone');
  H.advance(1000);
  assert.ok(b.p.alive && calls.some((e) => e[0] === 'respawn'));
  const lo = H.last(b, 'lo');
  assert.deepEqual(lo, { t: 'lo', id: b.pid, lo: { slots: [{ k: 'rocket', r: 4, m: 1 }], ammo: { rockets: 9 }, mats: { wood: 0, stone: 0, metal: 0 } } });
  assert.equal(H.msgs(a, 'lo').length, 0, 'loadouts only go to the device that plays them');
  assert.deepEqual(H.last(a, 'ms').g, { n: 3, zombies: 1 });
  ctx.note('Hello');
  assert.equal(H.last(c, 'note').msg, 'Hello');
  ctx.game = { key: 'probe2', checkWin: () => null };
  ctx.end({ team: 99, reason: 'zombies' });
  const w = H.last(a, 'win');
  assert.deepEqual([w.id, w.team, w.reason], [b.pid, 99, 'zombies']);
});

test('bots: skill from rules.botSkill, in the roster', () => {
  const R = mulberry32(1);
  for (let i = 0; i < 500; i++) {
    const e = rollBotSkill('easy', R), h = rollBotSkill('hard', R), n = rollBotSkill('normal', R);
    assert.ok(e >= 0.15 && e <= 0.45 && h >= 0.6 && h <= 0.95 && n >= 0.15 && n <= 0.97);
  }
  const mixed = Array.from({ length: 30 }, (_, i) => rollBotSkill('mixed', R, i));
  assert.ok(mixed.some((x) => x < 0.45) && mixed.some((x) => x >= 0.6));
  const { H, cs: [a], start } = match({ bots: 7, botSkill: 'hard' }, { humans: 1 });
  const rows = start.players.filter((p) => p.bot);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((p) => p.skill >= 0.6 && p.skill <= 0.95));
  assert.ok(start.players.filter((p) => !p.bot).every((p) => p.skill === undefined));
  assert.equal(H.errors.length, 0);
});

test('start message: much smaller than before, even with 32 players (prints the size)', () => {
  const H = makeRoom({ drop: ['s'] });
  const cs = [];
  for (let i = 0; i < 16; i++) cs.push(H.join(`Player${i}`));
  H.send(cs[0], { t: 'mode', custom: { teams: 'two', bots: 31, spawn: 'sky', respawn: 5, lives: 0, win: 'teamelims', loadout: 'pool', storm: 'slow' }, name: 'Big Team Rumble' });
  H.send(cs[0], { t: 'start' });
  const st = H.last(cs[3], 'start');
  const bytes = Buffer.byteLength(JSON.stringify(st));
  console.log(`# start message: ${bytes} bytes with ${st.players.length} players, ${st.lootN} floor items`);
  assert.equal(st.players.length, 32);
  assert.ok(bytes < 8000, `${bytes} bytes`);
  // and a solo Battle Royale
  const solo = match({ bots: 19, spawn: 'bus', storm: 'classic' }, { humans: 1 });
  const b2 = Buffer.byteLength(JSON.stringify(solo.start));
  console.log(`# solo start message: ${b2} bytes`);
  assert.ok(b2 < 5000);
});

// ------------------------------------------------------------------ stretch: rounds, mystery
test('rounds: best of 3 with a short break, everyone back at their spot, the series decides', () => {
  const { H, cs: [a, b], room } = match({ rounds: 3, loadout: 'buildfight', mats: 500 });
  snipe(H, a, b.p);
  const r1 = H.last(b, 'round');
  assert.deepEqual([r1.n, r1.team, r1.series], [1, a.p.team, { [a.p.team]: 1 }]);
  assert.equal(room.phase, 'round');
  assert.equal(H.msgs(b, 'win').length, 0);
  H.advance(4100);
  const r2 = H.last(b, 'round');
  assert.ok(r2.start && r2.n === 2 && r2.spawns && r2.lo.length === 1);
  assert.equal(room.phase, 'match');
  assert.ok(a.p.alive && b.p.alive && b.p.hp === 100);
  assert.equal(r2.lootN, room.loot.size);
  snipe(H, b, a.p);
  H.advance(4100);
  assert.equal(H.last(a, 'round').n, 3);
  snipe(H, a, b.p);
  const w = H.last(b, 'win');
  assert.deepEqual([w.id, w.round.series], [a.pid, { [a.p.team]: 2, [b.p.team]: 1 }]);
});

test('mystery: a new mutator every 60 s ({t:"mut"}), replacing the last', () => {
  const { H, cs: [a], room } = match({ mystery: true, respawn: 3, lives: 0 });
  H.advance(59000);
  assert.equal(H.msgs(a, 'mut').length, 0);
  H.advance(1100);
  const m1 = H.last(a, 'mut');
  const changed = (r) => RULE_FIELDS.filter((f) => r[f.key] !== room.settings.rules[f.key]).map((f) => f.key);
  assert.equal(changed(m1.rules).length, 1);
  assert.deepEqual(room.rules, m1.rules);
  H.advance(60000);
  const m2 = H.last(a, 'mut');
  assert.equal(changed(m2.rules).length, 1);
  assert.notDeepEqual(changed(m2.rules), changed(m1.rules));
});

test('every catalogue mode starts and runs in a solo room without errors', () => {
  for (const m of MODES) {
    const H = makeRoom({ solo: true, drop: ['s'] });
    const a = H.join('Ann');
    H.send(a, { t: 'mode', id: m.id });
    H.send(a, { t: 'start' });
    assert.notEqual(H.room.phase, 'lobby', m.id);
    for (const p of H.room.players.values()) { p.inBus = false; }
    H.advance(30000);
    assert.equal(H.errors.length, 0, `${m.id}: ${JSON.stringify(H.errors)}`);
  }
  assert.ok(CORE_MODES.every((m) => MODES.includes(m)));
  assert.ok(Object.keys(CORE_GAMES).every((k) => GAMES[k]));
  assert.equal(PROTOCOL, PROTOCOL);
  assert.equal(PLAYER.maxHp, 100);
});
