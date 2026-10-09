// Fixes after the v2 integration check: Hide & Seek bots, best-of-N rounds, the 'resumed' rejoin,
// Zero Build warm-up edits, per-actor edit throttles, the party games' clocks and the removed
// legacy mode handler. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeRoom } from './helpers/roomharness.mjs';
import { normalizeRules, rulesFromSettings } from '../public/shared/modes/rules.js';
import { BUS } from '../public/shared/constants.js';

// ------------------------------------------------------------------ 1. Hide & Seek bots
import { modeGoal, headStart, seekerWaits, hider, hidingSpots, hideFound } from '../public/js/ai/goals.js';

/** A small Hide & Seek world: two houses (indoor loot spots), a bush, a spot out in the open. */
function hsGame(hs) {
  const objs = [{ kind: 'tree', species: 'bush', x: 0, y: 2, z: 90, s: 1 }, { kind: 'tree', species: 'oak', x: 5, y: 2, z: 5, s: 1 }];
  const g = {
    phase: 'match', rules: normalizeRules({ win: 'hideseek', teams: 'two' }), area: { x: 0, z: 0, r: 200 },
    modeState: hs === null ? {} : { g: { h: 2, s: 1, hs } }, roles: new Map(), me: null, bots: new Map(), remotes: new Map(),
    world: {
      data: {
        islandRadius: 300, size: 800, heightAt: () => 2,
        lootSpots: [{ x: 120, y: 2, z: 0 }, { x: 121, y: 2, z: 1 }, { x: -110, y: 2, z: 30 }, { x: 8, y: 2, z: 8, ground: true }],
        objectsNear: (x, z, r, fn) => { for (const o of objs) if (Math.hypot(o.x - x, o.z - z) <= r && fn(o)) return true; return false; },
      },
    },
    roleOf(id) { return this.roles.get(id) ?? null; },
    teamOf(id) { return this.roleOf(id) === 'seeker' ? 2 : 1; },
    friendly(a, b) { return this.teamOf(a) === this.teamOf(b); },
    actorById(id) { return this.bots.get(id) || null; },
  };
  return g;
}

function hsBot(g, id, x, z, role) {
  const b = {
    id, game: g, alive: true, isBot: true, pos: { x, y: 2, z }, time: 100, nav: null,
    brain: { recs: new Map(), memory: 15, noiseT: -99, noiseX: 0, noiseY: 0, noiseZ: 0, goalT: 5 },
    isEnemy(a) { return a !== this && a.alive && !g.friendly(a.id, this.id); },
  };
  if (role) g.roles.set(id, role);
  g.bots.set(id, b);
  return b;
}

test('hide & seek bots: seekers wait out the head start with their eyes shut', () => {
  const g = hsGame(20);
  const S = hsBot(g, 1, 0, 0, 'seeker'), H = hsBot(g, 2, 10, 0, null);
  assert.equal(headStart(g), 20);
  assert.equal(seekerWaits(S), true);
  assert.equal(seekerWaits(H), false, 'hiders run off');
  assert.equal(hider(H), true);
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(modeGoal(S, out), 'wait');
  assert.deepEqual([out.x, out.z], [0, 0], 'stays where it stands');
  // before the room's first mode state the head start counts as on (no early start)
  const g0 = hsGame(null);
  assert.equal(seekerWaits(hsBot(g0, 1, 0, 0, 'seeker')), true);
  // other modes: no head start
  g.rules = normalizeRules({ win: 'infection', teams: 'two' });
  assert.equal(headStart(g), 0);
});

test('hide & seek bots: hiders pick a hiding place (house or bush) away from the seekers', () => {
  const g = hsGame(25);
  hsBot(g, 1, 100, 0, 'seeker');
  const H = hsBot(g, 2, 0, 0, null), H2 = hsBot(g, 3, 1, 0, null);
  const spots = hidingSpots(g);
  assert.equal(spots.filter((s) => s.bush).length, 1, 'the bush (not the oak)');
  assert.equal(spots.filter((s) => !s.bush).length, 2, 'two houses: indoor spots a metre apart count once, ground loot never');
  const counts = new Map();
  for (let i = 0; i < 40; i++) {
    H.brain.hideSpot = null; H2.brain.hideSpot = null;
    const out = {};
    assert.equal(modeGoal(H, out), 'hide');
    assert.ok(Math.hypot(out.x - 100, out.z) > 60, `not next to the seeker (${out.x}, ${out.z})`);
    const k = out.x < -50 ? 'house' : 'bush';
    counts.set(k, (counts.get(k) || 0) + 1);
    // the same place for the rest of this life
    const again = {};
    modeGoal(H, again);
    assert.deepEqual(again, out);
  }
  assert.ok(counts.get('house') > 0 && counts.get('bush') > 0, `houses and bushes both get used: ${[...counts]}`);
  // a bush: crouch on its far side from the seeker
  for (let i = 0; i < 60 && !(H.brain.hideSpot && H.brain.hideSpot.ref.bush); i++) { H.brain.hideSpot = null; modeGoal(H, {}); }
  const h = H.brain.hideSpot;
  assert.ok(h.ref.bush);
  assert.ok(Math.hypot(h.x - 100, h.z) > Math.hypot(0 - 100, 90), 'behind the bush, seen from the seeker');
  // found there: never that place again
  hideFound(H);
  assert.equal(H.brain.hideSpot, null);
  assert.equal(H.brain.goalT, 0);
  for (let i = 0; i < 20; i++) { H.brain.hideSpot = null; const o = {}; modeGoal(H, o); assert.ok(H.brain.hideSpot.ref !== h.ref); }
});

test('hide & seek bots: after the head start seekers search like people, not straight at the nearest hider', () => {
  const g = hsGame(0);
  const S = hsBot(g, 1, 0, 0, 'seeker'), H = hsBot(g, 2, 12, 0, null);
  assert.equal(seekerWaits(S), false);
  const out = {};
  // nobody seen or heard: the next likely hiding place, never the hider's exact position
  const k = modeGoal(S, out);
  assert.equal(k, 'search');
  assert.ok(Math.hypot(out.x - 12, out.z) > 20, 'not where the hider is');
  assert.ok(hidingSpots(g).includes(S.brain.seekSpot), 'one of the hiding places');
  const pt = S.brain.seekPt;
  assert.deepEqual([out.x, out.z], [pt.x, pt.z]);
  if (S.brain.seekSpot.bush) assert.ok(Math.hypot(pt.x, pt.z) > Math.hypot(S.brain.seekSpot.x, S.brain.seekSpot.z), 'a bush: round to its far side');
  // heard footsteps: go and look there
  S.brain.noiseT = 99; S.brain.noiseX = 30; S.brain.noiseY = 2; S.brain.noiseZ = -5;
  assert.equal(modeGoal(S, out), 'hunt');
  assert.deepEqual([out.x, out.z], [30, -5]);
  S.brain.noiseT = -99;
  // seen (its own perception's record): after them, to where they were seen
  S.brain.recs.set(2, { actor: H, spotted: true, vis: false, seenT: 98, heardT: -99, x: 11, y: 2, z: 1 });
  assert.equal(modeGoal(S, out), 'hunt');
  assert.deepEqual([out.x, out.z], [11, 1]);
  // got there and they're gone: back to searching
  S.pos.x = 10; S.pos.z = 1;
  assert.equal(modeGoal(S, out), 'search');
  assert.equal(S.brain.recs.get(2).spotted, false);
  // looks around a moment at a hiding place, then moves on to another one
  const spot = S.brain.seekSpot, at = { ...S.brain.seekPt };
  S.pos.x = at.x; S.pos.z = at.z;
  assert.equal(modeGoal(S, out), 'search');
  assert.deepEqual([out.x, out.z], [at.x, at.z], 'stays a moment');
  S.time += 4;
  modeGoal(S, out);
  assert.notEqual(S.brain.seekSpot, spot, 'then the next place');
  assert.ok(S.brain.searched.has(spot));
});

test('infection is unchanged: zombies still know roughly where the nearest survivor is', () => {
  const g = hsGame(0);
  g.rules = normalizeRules({ win: 'infection', teams: 'two' });
  g.roleOf = function (id) { return this.roles.get(id) ?? null; };
  g.teamOf = function (id) { return this.roleOf(id) === 'zombie' ? 2 : 1; };
  const Z = hsBot(g, 1, 0, 0, 'zombie');
  hsBot(g, 2, 12, 0, null);
  const out = {};
  assert.equal(modeGoal(Z, out), 'hunt');
  assert.equal(out.x, 12);
});

// ------------------------------------------------------------------ 2. best of N
import { seriesRows } from '../public/js/game/modeClient.js';

test('best of N: series rows for the round card (two teams in order, free for all by wins)', () => {
  const g = {
    myId: 5, teams: new Map([[1, { id: 1, name: 'Blue', color: '#3ea4ff' }], [2, { id: 2, name: 'Red', color: '#ff4d4d' }]]),
    roster: new Map(), teamOf: (id) => (id === 5 ? 1 : 2), nameOf: (id) => `P${id}`,
  };
  assert.deepEqual(seriesRows(g, { n: 2, series: { 2: 1 } }).map((r) => [r.name, r.wins, r.mine]), [['Blue', 0, true], ['Red', 1, false]]);
  const f = {
    myId: 5, teams: new Map(), roster: new Map([[5, { id: 5 }], [3, { id: 3 }], [9, { id: 9, spec: true }]]),
    teamOf: (id) => 1000 + id, nameOf: (id) => `P${id}`,
  };
  const rows = seriesRows(f, { n: 2, series: { 1003: 1 } });
  assert.deepEqual(rows.map((r) => [r.name, r.wins, r.mine]), [['P3', 1, false], ['You', 0, true]]);
});

test('best of N: round results and the final carry the series score', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'mode', custom: { teams: 1, bots: 0, rounds: 3, spawn: 'ground', storm: 'none' }, name: 'Duel' });
  H.send(a, { t: 'start' });
  assert.deepEqual(H.last(b, 'start').round, { n: 1, series: {} });
  H.advance(500);
  H.room.eliminate(H.player(b.pid), H.player(a.pid), { c: 'gun', w: 'ar' });
  const r = H.last(b, 'round');
  assert.equal(r.n, 1);
  assert.equal(r.start, undefined);
  assert.equal(r.series[H.player(a.pid).team], 1);
  assert.ok(r.ends > 0, 'the countdown to the next round');
  assert.deepEqual(H.errors, []);
});

// ------------------------------------------------------------------ 3. the 'resumed' rejoin
import { PartyBridge } from '../public/js/lobby/bridge.js';

/** The game a page keeps through a Wi-Fi blip (just what PartyBridge.resumed touches). */
function keptGame(myId, inbox) {
  const g = {
    myId, phase: 'match', rules: normalizeRules({}), settingsState: {}, modeState: {}, partyInfo: {},
    roles: new Map(), roster: new Map(), remotes: new Map(), bots: new Map(), teams: new Map(),
    got: [], applied: [], given: [],
    me: { id: myId, alive: true, hp: 100, sh: 100, inBus: false },
    world: { restoreAll() {}, destroyObject() {}, setChestOpen() {} },
    builds: { clear() {}, add() {} }, pendingBuilds: new Set(), loot: { set() {} },
    roleOf(id) { return this.roles.get(id) ?? null; },
    setTeams(list) { this.teams.clear(); for (const t of list || []) this.teams.set(t.id, t); },
    onMessage(m) {
      this.got.push(m);
      if (m.t === 'role') { if (m.role) this.roles.set(m.id, m.role); else this.roles.delete(m.id); }
      if (m.t === 'ms') this.modeState = m;
    },
    ensureRemote() {}, onMyDeath() {}, plug() {},
    applyMode(a) { this.applied.push(a.id); },
    giveLoadout(a, lo) { this.given.push([a.id, lo]); },
  };
  // what the page had seen before the drop
  for (const m of inbox) if (m.t === 'role') g.onMessage(m);
  g.got.length = 0;
  g.app = { lobby: { render() {}, toast() {}, countdown() {} }, stage: {}, onWelcome() {} };
  return g;
}

test("a Wi-Fi blip rejoin ('resumed') applies the match's rules, teams, roles, mode state and loadout", () => {
  // Infection: Ben drops; while he is away he gets infected and so does a bot survivor
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann', { resume: '' }), b = H.join('Ben', { resume: '' });
  const token = H.last(b, 'welcome').resume;
  H.send(a, { t: 'mode', id: 'infection' });
  H.send(a, { t: 'tweak', bots: 7 });
  H.send(a, { t: 'start' });
  H.advance(500);
  const ben = H.player(b.pid);
  const seen = H.msgs(b).slice();
  const g = keptGame(b.pid, seen);
  g.bots.set(91, { id: 91 }); // a bot this page runs
  const wasZombie = g.roleOf(b.pid) === 'zombie';
  H.leave(b);
  H.advance(3000);
  const ps = [...H.room.players.values()];
  const z = ps.find((p) => p.role === 'zombie' && p.alive);
  const bot = ps.find((p) => p.bot && p.role !== 'zombie' && p.alive);
  H.room.eliminate(bot, z, { c: 'gun', w: 'pickaxe' });
  if (!wasZombie) H.room.eliminate(ben, z, { c: 'gun', w: 'pickaxe' });
  H.advance(4000); // respawned (as zombies)
  const b2 = H.join('Ben', { resume: token, keep: true });
  const m = H.last(b2, 'resumed');
  assert.ok(m, 'resumed');
  const pb = new PartyBridge(g);
  pb.resumed(m);
  assert.deepEqual(g.rules, normalizeRules(m.rules), 'the match rules');
  assert.deepEqual([...g.teams.keys()], m.teams.map((t) => t.id), 'the teams');
  assert.deepEqual([...g.roles].sort(), [...new Map(m.roles)].sort(), 'every role as the room has it');
  const roleMsgs = g.got.filter((x) => x.t === 'role');
  assert.ok(roleMsgs.some((x) => x.id === bot.id && x.role === 'zombie'), 'the bot that turned while we were away');
  assert.ok(g.got.some((x) => x.t === 'ms'), 'the mode state goes through the usual ms handling');
  assert.equal(g.roleOf(b.pid), 'zombie');
  if (!wasZombie) assert.deepEqual(g.given, [[b.pid, ben.lo]], 'a new role: the room\'s loadout (zombie claws)');
  assert.ok(g.applied.includes(b.pid) && g.applied.includes(91), 'mode looks / mods applied again to me and my bots');
  assert.deepEqual(H.errors, []);
});

test("'resumed' uses the match's rules over the lobby settings (Mystery Mutators)", () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann', { resume: '' }), b = H.join('Ben', { resume: '' });
  const token = H.last(b, 'welcome').resume;
  H.send(a, { t: 'mode', id: 'mystery' });
  H.send(a, { t: 'start' });
  // mutators change the rules now and then: wait for the first one
  for (let i = 0; i < 300 && !H.msgs(a, 'mut').length; i++) H.advance(1000);
  assert.ok(H.msgs(a, 'mut').length, 'a mutator');
  H.leave(b);
  H.advance(1000);
  const m = H.last(H.join('Ben', { resume: token, keep: true }), 'resumed');
  const g = keptGame(b.pid, []);
  new PartyBridge(g).resumed(m);
  assert.deepEqual(g.rules, normalizeRules(H.room.rules));
  assert.notDeepEqual(normalizeRules(H.room.rules), rulesFromSettings(m.settings), 'the settings alone would be wrong');
  assert.deepEqual(H.errors, []);
});

// ------------------------------------------------------------------ 5, 6. edits
import { BuildClient } from '../public/js/world/buildClient.js';
import { EDIT_PRESETS, EDIT_FULL } from '../public/shared/buildgrid.js';

function editGame() {
  const pieces = new Map([['k1', { k: 'k1', t: 'w', by: 1, pos: new THREE.Vector3(0, 1, -2) }]]);
  const sent = [];
  const g = {
    hud: {}, phase: 'lobby', rules: normalizeRules({ build: 'off' }), myId: 1, sent, sfx: {}, input: { touchMode: true },
    me: { id: 1, alive: true, inBus: false, pos: new THREE.Vector3(0, 0, 0), canAct: () => true },
    camera: { quaternion: new THREE.Quaternion(), position: new THREE.Vector3(0, 1, 0) },
    physics: { raycast: () => ({ x: 0, y: 1, z: -2, info: { kind: 'build', key: 'k1' } }) },
    builds: { pieces, setEdit: (k, e) => { pieces.get(k).e = e; return true; } },
    send: (m) => sent.push(m), friendly: () => true,
  };
  return g;
}

test('Zero Build: edits work in the lobby warm-up (building does too), not in the match', () => {
  const g = editGame();
  const bc = new BuildClient(g);
  assert.ok(bc.findTarget(), 'warm-up: your wall can be edited');
  g.phase = 'match';
  assert.equal(bc.findTarget(), null, 'Zero Build match: no edits');
  g.rules = normalizeRules({});
  assert.ok(bc.findTarget(), 'building on');
});

test('edit throttle is per actor: a bot editing does not swallow your edit tap', () => {
  const g = editGame();
  g.phase = 'match';
  g.rules = normalizeRules({});
  const bc = new BuildClient(g);
  bc.time = 10;
  const bot = { id: 7 };
  assert.equal(bc.editPiece(bot, 'k1', EDIT_PRESETS.w.door), true, 'a bot edits');
  // you tap DOOR on the same piece 0 s later: before, the shared throttle ignored it
  bc.editing = { k: 'k1', t: 'w', x: 0, z: -2 };
  bc.pick(0);
  assert.deepEqual(g.sent.map((m) => m.id), [7, 1], 'both edits went out');
  assert.equal(g.sent[1].e, EDIT_FULL.w, 'DOOR on a door shuts it');
  // one actor still waits between its own edits (the room takes one per 0.15 s)
  assert.equal(bc.editPiece(bot, 'k1', EDIT_PRESETS.w.window), false);
  bc.time += 0.2;
  assert.equal(bc.editPiece(bot, 'k1', EDIT_PRESETS.w.window), true);
});

// ------------------------------------------------------------------ 7. party game clocks
const BUS_S = BUS.length / BUS.speed;

test('infection with a bus start ends with the room clock (not a bus ride early)', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'mode', custom: { win: 'infection', teams: 'two', bots: 0, spawn: 'bus', respawn: 3, lives: 0, storm: 'none', timeLimit: 180 }, name: 'Bus Infection' });
  H.send(a, { t: 'start' });
  const t0 = H.now();
  const endsAt = H.room.runtime.endsAt;
  assert.ok(Math.abs(endsAt - (t0 + (BUS_S + 180) * 1000)) < 100, 'the room clock: bus ride + 3 min');
  H.advance(181000);
  assert.equal(H.msgs(a, 'win').length, 0, 'not over at 3:00 (the bus took the first ~36 s)');
  const tl = H.last(a, 'ms').tl;
  assert.ok(tl > 20, `the HUD clock still runs (${tl} s)`);
  H.advance((BUS_S + 1) * 1000);
  const w = H.last(a, 'win');
  assert.ok(w, 'over when the clock runs out');
  assert.equal(w.reason, 'time');
  assert.equal(w.team, 1, 'the survivors');
  assert.deepEqual(H.errors, []);
});

test('hide & seek with a bus start: the head start counts from the landing', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'mode', custom: { win: 'hideseek', teams: 'two', bots: 0, spawn: 'bus', respawn: 3, lives: 0, storm: 'none', timeLimit: 180, build: 'off', loadout: 'pickaxe' }, name: 'Bus H&S' });
  H.send(a, { t: 'start' });
  H.advance(50000);
  const hs = H.last(a, 'ms').g.hs;
  assert.ok(hs >= 14 && hs <= 17, `head start left at 50 s: ${hs} (bus ${BUS_S.toFixed(1)} s + 30 s)`);
  // and nobody can be tagged yet
  const [s, h] = [H.player(a.pid), H.player(b.pid)].sort((p, q) => (p.role === 'seeker' ? -1 : 1));
  assert.equal(H.room.runtime.damageFor(s, h, 50, { w: 'pickaxe' }), 0);
  H.advance(20000);
  assert.ok(H.room.runtime.damageFor(s, h, 50, { w: 'pickaxe' }) > 0, 'seeking after the head start');
  assert.deepEqual(H.errors, []);
});

test('infection and hide & seek always have a clock (time limit 0 means 5 minutes)', () => {
  for (const win of ['infection', 'hideseek', 'time']) assert.equal(normalizeRules({ win, timeLimit: 0 }).timeLimit, 300, win);
  assert.equal(normalizeRules({ win: 'last', timeLimit: 0 }).timeLimit, 0);
  assert.equal(normalizeRules({ win: 'koth', timeLimit: 0 }).timeLimit, 0);
});

// ------------------------------------------------------------------ 4. arena pacing on the big island
import { MAP } from '../public/shared/constants.js';
import { MODES } from '../public/shared/modes/index.js';

test('respawn arenas on the 1.6 km island play in its middle, with a clock as the backstop', () => {
  const arenas = MODES.filter((m) => m.rules.respawn > 0 && m.rules.pvp !== false && (m.rules.win === 'elims' || m.rules.win === 'teamelims'));
  assert.ok(arenas.length >= 8, arenas.map((m) => m.id).join());
  for (const m of arenas) {
    if (MAP.size > 700) assert.notEqual(m.rules.area, 'full', `${m.id}: not the whole island`);
    assert.ok(m.rules.timeLimit > 0 && m.rules.timeLimit <= 600, `${m.id}: a 10 minute clock at most`);
  }
  const tr = MODES.find((m) => m.id === 'team-rumble');
  assert.equal(tr.rules.target, 20);
  assert.ok(tr.tags.includes('First to 20') && /to 20 /.test(tr.desc), 'what the tile says matches the rules');
});

// ------------------------------------------------------------------ 8. the legacy mode handler is gone
test("the party plugin installs no 'mode' handler: the Room's own picks modes", () => {
  const H = makeRoom();
  assert.equal(H.room.pluginHandlers.mode, undefined);
  assert.equal(typeof H.room.baseHandlers.mode, 'function');
  const a = H.join('Ann');
  H.send(a, { t: 'mode', id: 'hide-and-seek' });
  assert.equal(H.room.settings.modeId, 'hide-and-seek');
  assert.deepEqual(H.errors, []);
});
