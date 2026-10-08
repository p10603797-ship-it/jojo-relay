// Party games (shared/modes/games/party.js) on FakeCtx: the Game plugin API without a Room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeCtx, makePlayers } from './helpers/fakectx.mjs';
import { PARTY_GAMES, GUN_LADDER, HILL_MOVE_MS, LAVA_START } from '../public/shared/modes/games/party.js';
import { normalizeRules } from '../public/shared/modes/rules.js';
import { modeRules } from '../public/shared/modes/index.js';
import { WEAPONS } from '../public/shared/constants.js';
import { getWorld } from '../public/shared/room.js';

const { gungame, infection, koth, juggernaut, lava } = PARTY_GAMES;
const slotKeys = (lo) => lo.slots.map((s) => s.k);

test('party games: every game has its key, a label and only API hooks', () => {
  const HOOKS = ['key', 'label', 'teamGame', 'defaults', 'setup', 'tick', 'onKill', 'allowDamage', 'scaleDamage', 'onRespawn', 'loadout', 'checkWin', 'hud'];
  for (const [k, g] of Object.entries(PARTY_GAMES)) {
    assert.equal(g.key, k);
    assert.ok(typeof g.label === 'string' && g.label);
    for (const h of Object.keys(g)) assert.ok(HOOKS.includes(h), `${k}.${h} is not a Game hook`);
    if (g.defaults) assert.deepEqual(normalizeRules({ ...g.defaults, win: k }).win, k);
  }
  assert.deepEqual(GUN_LADDER, ['rocket', 'sniper', 'shotgun', 'tactical', 'ar', 'burst', 'smg', 'pistol', 'pickaxe']);
});

// ------------------------------------------------------------------ Gun Game
test('gun game: each kill gives the next rung, a pickaxe kill demotes, a pickaxe-rung kill wins', () => {
  const ctx = new FakeCtx({ game: gungame, rules: modeRules('gun-game'), players: 4 });
  ctx.start();
  const [a, b, c] = ctx.players();
  // everyone starts on the rocket, legendary, infinite ammo
  assert.equal(ctx.loadouts.length, 4);
  for (const { lo } of ctx.loadouts) {
    assert.deepEqual(slotKeys(lo), ['rocket']);
    assert.equal(lo.slots[0].r, 4);
    assert.equal(lo.slots[0].m, WEAPONS.rocket.mag);
    assert.equal(lo.infAmmo, true);
    assert.equal(lo.mats.wood, 100);
  }
  // only the rung's gun (or the pickaxe) hurts
  assert.equal(ctx.hit(a, b, 50, { w: 'ar' }), 0, 'not your rung');
  assert.ok(ctx.hit(a, b, 50, { w: 'rocket', c: 'boom' }) > 0);
  assert.ok(ctx.hit(a, b, 20, { w: 'pickaxe' }) > 0);
  // up: a rocket kill -> sniper
  ctx.eliminate(b, a, { w: 'rocket' });
  assert.equal(ctx.state.lv[a.id], 1);
  assert.deepEqual(slotKeys(ctx.loadouts.at(-1).lo), ['sniper']);
  assert.equal(ctx.loadouts.at(-1).id, a.id);
  assert.deepEqual(ctx.scores(), [[a.id, 1]]);
  // the victim is back after 2 s with its own rung
  assert.deepEqual(ctx.respawns.at(-1), { t: 0, id: b.id, at: 2000, keepLoot: false });
  ctx.advance(2000);
  assert.equal(b.alive, true);
  assert.deepEqual(slotKeys(ctx.loadouts.at(-1).lo), ['rocket']);
  assert.equal(ctx.loadouts.at(-1).id, b.id);
  assert.equal(ctx.hit(a, b, 50, { w: 'rocket' }), 0, 'a promoted player can no longer use the old gun');
  // down: a pickaxe kill sends the victim one rung down (the killer still goes up)
  ctx.eliminate(b, a, { w: 'rocket' }); // a: 2
  ctx.advance(2000);
  ctx.eliminate(c, a, { w: 'shotgun' }); // a: 3 (tactical)
  ctx.advance(2000);
  ctx.eliminate(a, b, { w: 'pickaxe' });
  assert.equal(ctx.state.lv[a.id], 2, 'demoted from 3 to 2');
  assert.equal(ctx.state.lv[b.id], 1, 'the pickaxe killer goes up');
  assert.equal(ctx.score(a.id), 2);
  ctx.advance(2000);
  assert.deepEqual(slotKeys(ctx.loadouts.filter((l) => l.id === a.id).at(-1).lo), ['shotgun'], 'respawns on the lower rung');
  // the win: a kill on the pickaxe rung
  ctx.state.lv[c.id] = GUN_LADDER.length - 1;
  assert.deepEqual(gungame.loadout(ctx, c).slots, [], 'the last rung is the pickaxe alone');
  assert.equal(ctx.hit(c, a, 50, { w: 'pistol' }), 0, 'only the pickaxe on the last rung');
  ctx.eliminate(a, c, { w: 'pickaxe' });
  assert.deepEqual(ctx.result, { id: c.id, reason: 'gungame' });
  // levels go out as a flat [id, level] list for players above the first rung
  const h = ctx.hud();
  assert.deepEqual(h.lv.length % 2, 0);
  assert.ok(h.lv.includes(c.id));
});

test('gun game: a storm or self elimination changes nothing, and the HUD stays small with 32 players', () => {
  const ctx = new FakeCtx({ game: gungame, rules: modeRules('gun-game'), players: 32 });
  ctx.start();
  const [a, b] = ctx.players();
  ctx.eliminate(a, null, { c: 'storm' });
  ctx.eliminate(b, b, { w: 'rocket', c: 'boom' });
  assert.equal(ctx.state.lv[a.id] | 0, 0);
  assert.equal(ctx.state.lv[b.id] | 0, 0);
  assert.equal(ctx.respawns.length, 2);
  for (const p of ctx.players()) ctx.state.lv[p.id] = 8; // everyone near the top (worst case)
  for (const p of ctx.players()) p.id += 900; // 3-digit ids
  for (const p of ctx.players()) ctx.state.lv[p.id] = 8;
  const bytes = JSON.stringify(ctx.hud()).length;
  assert.ok(bytes <= 300, `${bytes} bytes`);
});

// ------------------------------------------------------------------ Infection
test('infection: ceil(n/6) start infected; a killed survivor comes back as a zombie', () => {
  const ctx = new FakeCtx({ game: infection, rules: modeRules('infection'), players: 12, seed: 3 });
  ctx.start();
  const ps = ctx.players();
  const zombies = ps.filter((p) => p.role === 'zombie');
  assert.equal(zombies.length, 2, 'ceil(12 / 6)');
  for (const z of zombies) {
    assert.equal(z.team, 2);
    assert.equal(z.armor, 0.7);
    assert.deepEqual(ctx.loadouts.filter((l) => l.id === z.id).at(-1).lo.slots, [], 'pickaxe only');
  }
  for (const p of ps.filter((x) => x.role !== 'zombie')) assert.equal(p.team, 1);
  assert.ok(ctx.notes[0].includes('infected'));
  const z = zombies[0];
  const s = ps.find((p) => p.role !== 'zombie');
  // zombies bite with the pickaxe only; armour 0.7
  assert.equal(ctx.hit(z, s, 30, { w: 'ar' }), 0);
  assert.equal(ctx.hit(s, z, 100, { w: 'ar' }), 70);
  // conversion
  ctx.eliminate(s, z, { w: 'pickaxe' });
  assert.equal(s.role, 'zombie');
  assert.equal(s.team, 2);
  assert.deepEqual(ctx.respawns.at(-1), { t: 0, id: s.id, at: 3000, keepLoot: false });
  ctx.advance(2900);
  assert.equal(s.alive, false);
  ctx.advance(100);
  assert.equal(s.alive, true);
  assert.deepEqual(ctx.loadouts.at(-1), { t: 3000, id: s.id, lo: ctx.loadouts.at(-1).lo });
  assert.deepEqual(ctx.loadouts.at(-1).lo.slots, []);
  assert.deepEqual(ctx.hud(), { s: 9, z: 3 });
  // a zombie that is shot down respawns as a zombie
  ctx.eliminate(z, ps.find((p) => p.role !== 'zombie'), { w: 'ar' });
  assert.equal(z.role, 'zombie');
  ctx.advance(3000);
  assert.equal(z.alive, true);
});

test('infection: the infected win when no survivors are left', () => {
  const ctx = new FakeCtx({ game: infection, rules: modeRules('infection'), players: 6, seed: 9 });
  ctx.start();
  const z = ctx.players().find((p) => p.role === 'zombie');
  for (const p of ctx.players()) if (p.role !== 'zombie' && !ctx.ended) ctx.eliminate(p, z, { w: 'pickaxe' });
  assert.deepEqual(ctx.result, { team: 2, reason: 'infection' });
});

test('infection: the survivors win at the time limit (300 s)', () => {
  const ctx = new FakeCtx({ game: infection, rules: modeRules('infection'), players: 8 });
  ctx.start();
  const z = ctx.players().find((p) => p.role === 'zombie');
  ctx.eliminate(ctx.players().find((p) => p.role !== 'zombie'), z, { w: 'pickaxe' });
  ctx.advance(299700);
  assert.equal(ctx.result, null);
  ctx.advance(300);
  assert.deepEqual(ctx.result, { team: 1, reason: 'time' });
  assert.equal(ctx.scores()[0][0], 1, 'the survivors also have the top score (whichever ends the match first)');
});

// ------------------------------------------------------------------ King of the Hill
test('koth: one team in the hill scores 1/s, a contested hill scores nothing, the hill moves at 75 s', () => {
  const ctx = new FakeCtx({ game: koth, rules: modeRules('koth'), players: 6, seed: 4 });
  ctx.start();
  const h = ctx.state.hill;
  assert.equal(h.r, 9);
  assert.ok(ctx.world.regions.some((g) => g.x === h.x && g.z === h.z), 'on a place');
  const blue = ctx.players().filter((p) => p.team === 1), red = ctx.players().filter((p) => p.team === 2);
  const put = (p, inside) => { p.x = h.x + (inside ? 3 : 40); p.z = h.z; };
  for (const p of ctx.players()) put(p, false);
  put(blue[0], true);
  ctx.advance(10000);
  assert.equal(ctx.score(1), 10, 'blue alone: 1 point per second');
  assert.equal(ctx.score(2), 0);
  assert.equal(ctx.hud().hill.owner, 1);
  put(red[0], true);
  ctx.advance(5000);
  assert.equal(ctx.score(1), 10, 'contested: nobody scores');
  assert.equal(ctx.score(2), 0);
  assert.deepEqual([ctx.hud().hill.owner, ctx.hud().hill.ct], [0, 1]);
  // a dead player does not hold the hill
  ctx.eliminate(blue[0], red[0], { w: 'ar' });
  ctx.advance(3000);
  assert.equal(ctx.score(2), 3);
  // too high above the hill (skydiving) does not count
  red[0].y = 60;
  ctx.advance(2000);
  assert.equal(ctx.score(2), 3);
  red[0].y = 5;
  // the hill moves at 75 s, to another place
  ctx.advance(75000 - 20100);
  assert.deepEqual(ctx.state.hill, h, 'still there at 74.9 s');
  ctx.advance(100);
  assert.notDeepEqual([ctx.state.hill.x, ctx.state.hill.z], [h.x, h.z], 'moved at 75 s');
  assert.ok(ctx.notes.some((n) => n.includes('hill moved')));
  assert.ok(JSON.stringify(ctx.hud()).length <= 300);
  assert.ok(ctx.hud().hill.prog > 0.99);
});

test('koth: first team to the target wins; the hill sits on land inside the area of the real island', () => {
  const ctx = new FakeCtx({ game: koth, rules: { ...modeRules('koth'), target: 20 }, players: 4 });
  ctx.start();
  const h = ctx.state.hill;
  for (const p of ctx.players()) { p.x = p.team === 2 ? h.x : h.x + 50; p.z = h.z; }
  ctx.advance(19000);
  assert.equal(ctx.result, null);
  ctx.advance(1000);
  assert.deepEqual(ctx.result, { team: 2, reason: 'koth' });
  const world = getWorld();
  for (const seed of [1, 2, 3, 4, 5]) {
    const area = { x: 0, z: 0, r: 120 };
    const w = new FakeCtx({ game: koth, rules: modeRules('koth'), players: 4, seed, world, area });
    w.start();
    for (let i = 0; i < 4; i++) {
      const hh = w.state.hill;
      assert.ok(Math.hypot(hh.x - area.x, hh.z - area.z) <= area.r, 'inside the area');
      assert.ok(world.heightAt(hh.x, hh.z) > 0.5, 'on land');
      w.advance(HILL_MOVE_MS);
    }
  }
});

// ------------------------------------------------------------------ Juggernaut
test('juggernaut: a random first Juggernaut, transfer to whoever takes them down, 1 point per second', () => {
  const ctx = new FakeCtx({ game: juggernaut, rules: modeRules('juggernaut'), players: 5, seed: 11 });
  ctx.start();
  const j = ctx.players().find((p) => p.role === 'jugg');
  assert.ok(j);
  assert.equal(j.armor, 0.2);
  const lo = ctx.loadouts.filter((l) => l.id === j.id).at(-1).lo;
  assert.deepEqual(slotKeys(lo).sort(), ['ar', 'rocket']);
  assert.ok(lo.slots.every((s) => s.r === 4) && lo.infAmmo);
  assert.deepEqual(ctx.loadouts.map((l) => l.id), [j.id], 'only the Juggernaut gets a kit from the game (once, at the start)');
  assert.deepEqual(ctx.hud(), { j: j.id });
  ctx.advance(10000);
  assert.equal(ctx.score(j.id), 10);
  // armour 0.2: 100 damage takes 20
  const other = ctx.players().find((p) => p !== j);
  assert.equal(ctx.hit(other, j, 100, { w: 'ar' }), 20);
  // transfer
  ctx.eliminate(j, other, { w: 'ar' });
  assert.equal(j.role, null);
  assert.equal(j.armor, 1);
  assert.equal(other.role, 'jugg');
  assert.equal(other.armor, 0.2);
  assert.deepEqual(slotKeys(ctx.loadouts.at(-1).lo).sort(), ['ar', 'rocket']);
  assert.equal(ctx.loadouts.at(-1).id, other.id);
  assert.deepEqual(ctx.respawns.at(-1), { t: 10000, id: j.id, at: 13000, keepLoot: false });
  ctx.advance(5000);
  assert.equal(ctx.score(other.id), 5);
  assert.equal(ctx.score(j.id), 10, 'the old Juggernaut stops scoring');
  assert.equal(j.alive, true, 'back after 3 s');
  // a storm death: a random new Juggernaut a second later
  ctx.eliminate(other, null, { c: 'storm' });
  assert.equal(ctx.state.jugg, 0);
  ctx.advance(1000);
  assert.ok(ctx.state.jugg && ctx.players().find((p) => p.id === ctx.state.jugg).role === 'jugg');
});

test('juggernaut: 100 points wins', () => {
  const ctx = new FakeCtx({ game: juggernaut, rules: modeRules('juggernaut'), players: 3 });
  ctx.start();
  ctx.advance(99000);
  assert.equal(ctx.result, null);
  ctx.advance(1000);
  assert.deepEqual(ctx.result, { id: ctx.state.jugg, reason: 'juggernaut' });
});

// ------------------------------------------------------------------ Floor is Lava
test('lava: rises from -2 m to the 70th percentile of the land, 10 dps (no shields) only below the level', () => {
  const ctx = new FakeCtx({ game: lava, rules: modeRules('floor-is-lava'), players: 4 });
  ctx.start();
  assert.equal(ctx.state.top, 5, 'flat test island at 5 m');
  assert.deepEqual(ctx.hud(), { lava: LAVA_START });
  const [low, high, mid, safe] = ctx.players();
  low.y = 3; high.y = 9; mid.y = 4.4; safe.y = 30;
  ctx.advance(150000); // half way: -2 + 7 / 2
  assert.equal(ctx.hud().lava, 1.5);
  assert.equal(ctx.damages.length, 0, 'nobody below 1.7 m');
  // the level passes 2.8 m (+0.2 = the 3 m feet of 'low') at 205.7 s: hits at 206 .. 210 s
  ctx.advance(60000);
  const lowHits = ctx.damages.filter((d) => d.id === low.id);
  assert.equal(lowHits.length, 5);
  assert.ok(lowHits.every((d) => d.amount === 10 && d.by === 0 && d.t >= 206000));
  assert.deepEqual([low.hp, low.sh], [50, 100], 'shields do not help');
  assert.equal(ctx.damages.filter((d) => d.id !== low.id).length, 0, 'only the player below the lava');
  ctx.advance(6000);
  assert.equal(low.alive, false, '10 hits');
  // 'mid' (4.4 m) goes under at 265.7 s; the two on high ground stay dry
  ctx.advance(64000); // 280 s
  assert.equal(mid.alive, false);
  assert.ok(high.alive && safe.alive && high.hp === 100);
  assert.equal(ctx.result, null, 'two left');
  ctx.eliminate(high, null, { c: 'lava' });
  assert.deepEqual(ctx.result, { id: safe.id, team: safe.team, reason: 'lava' });
});

test('lava: the top comes from the real island inside the area', () => {
  const world = getWorld();
  const ctx = new FakeCtx({ game: lava, rules: modeRules('floor-is-lava'), players: 2, world, area: { x: 0, z: 0, r: 150 } });
  for (const p of ctx.players()) p.y = 200;
  ctx.start();
  assert.ok(ctx.state.top > 3 && ctx.state.top < 60, `top ${ctx.state.top}`);
  ctx.advance(300000);
  assert.ok(Math.abs(ctx.hud().lava - Math.round(ctx.state.top * 10) / 10) < 0.11);
});

test('party games: deterministic for a seed (same picks on every device)', () => {
  const run = (seed) => {
    const out = [];
    for (const [k, g] of Object.entries(PARTY_GAMES)) {
      const ctx = new FakeCtx({ game: g, rules: { win: k }, players: makePlayers(12, { rules: normalizeRules({ teams: 'two' }) }), seed });
      ctx.start();
      ctx.advance(80000);
      out.push(JSON.stringify([ctx.roleLog, ctx.state.hill, ctx.scores()]));
    }
    return out.join('|');
  };
  assert.equal(run(42), run(42));
  assert.notEqual(run(42), run(43));
});
