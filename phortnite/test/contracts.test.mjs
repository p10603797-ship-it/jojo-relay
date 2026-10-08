// The shared interfaces of Phortnite 2.0 (mode rules, mode registry, room plugins, game plugins,
// world data contract). Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_FIELDS, RULE_DEFAULTS, LEGACY_MODES, AREA_RE, normalizeRules, rulesFingerprint, rulesFromSettings, ruleField,
} from '../public/shared/modes/rules.js';
import { CORE_MODES, MODES, findMode, modeRules, modeInfo } from '../public/shared/modes/index.js';
import { CATALOG } from '../public/shared/modes/catalog.js';
import { GAMES } from '../public/shared/modes/games/index.js';
import { CORE_GAMES } from '../public/shared/modes/games/core.js';
import { PARTY_GAMES } from '../public/shared/modes/games/party.js';
import { ROOM_PLUGINS } from '../public/shared/plugins/index.js';
import { BIOMES, SURFACES, SPECIES, SPECIES_TYPE, LOOKS, LOOK_ALIASES, PADS, TIERS, STEP_SOUND } from '../public/shared/world/keys.js';
import * as SCALE from '../public/shared/world/scale.js';
import { MAP, BUS, DROP, PLAYER } from '../public/shared/constants.js';
import { generateWorld } from '../public/shared/worldgen.js';
import { parseKey } from '../public/shared/buildgrid.js';
import { Room } from '../public/shared/room.js';
import { mulberry32 } from '../public/shared/rng.js';
import { makeRoom } from './helpers/roomharness.mjs';
import { FakeCtx } from './helpers/fakectx.mjs';

// ------------------------------------------------------------------ mode rules
// The option lists as the contracts package froze them. Mode codes store option indexes, so a list
// may only grow at its end (and new fields only after the last one).
const FROZEN = [
  ['teams', [1, 2, 3, 4, 'two', 'humans'], 1], ['bots', [0, 1, 3, 5, 7, 9, 11, 15, 19, 23, 27, 31], 19],
  ['maxPlayers', [32, 24, 16, 8, 4, 2], 32], ['botSkill', ['normal', 'easy', 'hard', 'mixed'], 'normal'],
  ['spawn', ['bus', 'sky', 'ground'], 'bus'], ['respawn', [0, 3, 5, 8, 12], 0], ['lives', [1, 2, 3, 5, 0], 1],
  ['respawnKeep', [false, true], false],
  ['win', ['last', 'elims', 'teamelims', 'time', 'gungame', 'infection', 'koth', 'juggernaut', 'lava'], 'last'],
  ['target', [0, 5, 10, 15, 20, 30, 50, 100], 0], ['timeLimit', [0, 180, 300, 420, 600, 900], 0], ['rounds', [1, 3, 5], 1],
  ['storm', ['classic', 'fast', 'slow', 'none', 'final', 'zonewars'], 'classic'], ['area', ['full', 'center', 'random'], 'full'],
  ['loot', ['all', 'ars', 'smgs', 'shotguns', 'snipers', 'pistols', 'rockets', 'explosive', 'pickaxe'], 'all'],
  ['rarity', ['normal', 'boosted', 'legendary', 'common'], 'normal'], ['floorLoot', [true, false], true], ['chests', [true, false], true],
  ['heals', ['normal', 'extra', 'none'], 'normal'], ['loadout', ['none', 'pool', 'buildfight', 'zonewars', 'pickaxe'], 'none'],
  ['ammo', ['normal', 'infinite'], 'normal'], ['build', ['on', 'off', 'infinite'], 'on'], ['mats', [0, 100, 200, 500, 999], 0],
  ['harvest', [1, 2, 3, 0], 1], ['hp', [100, 50], 100], ['shield', [100, 50, 0], 100], ['siphon', [50, 0, 25, 100], 50],
  ['gravity', [1, 0.5, 0.35, 1.5], 1], ['speed', [1, 1.25, 1.5, 0.8], 1], ['jump', [1, 1.5, 2], 1], ['dmg', [1, 0.5, 1.5, 2], 1],
  ['oneShot', [false, true], false], ['headOnly', [false, true], false], ['bigHead', [false, true], false],
  ['fallDamage', [true, false], true], ['mystery', [false, true], false], ['pvp', [true, false], true],
];

/** Throws unless r is a complete, valid, consistent rules object. */
function assertValidRules(r, games) {
  assert.deepEqual(Object.keys(r), RULE_FIELDS.map((f) => f.key), 'every field, in order, and nothing else');
  for (const f of RULE_FIELDS) {
    if (f.key === 'area') assert.ok(typeof r.area === 'string' && AREA_RE.test(r.area), `area ${r.area}`);
    else assert.ok(f.options.some((o) => Object.is(o, r[f.key])), `${f.key} = ${String(r[f.key])}`);
  }
  if (r.respawn === 0) assert.equal(r.lives, 1);
  if (r.win === 'elims' || r.win === 'teamelims' || r.win === 'koth') assert.ok(r.target > 0);
  if (r.win === 'time') assert.ok(r.timeLimit > 0);
  if (r.teams === 'humans') assert.ok(r.bots >= 1);
  if (games) assert.ok(r.win === 'last' || games.includes(r.win));
}

test('mode rules: the schema is frozen and append-only, and the defaults are today\'s Battle Royale', () => {
  assert.ok(Object.isFrozen(RULE_FIELDS) && RULE_FIELDS.every((f) => Object.isFrozen(f) && Object.isFrozen(f.options)));
  assert.ok(RULE_FIELDS.length >= FROZEN.length);
  FROZEN.forEach(([key, options, def], i) => {
    const f = RULE_FIELDS[i];
    assert.equal(f.key, key, `field ${i}`);
    assert.deepEqual(f.options.slice(0, options.length), options, `${key} options only grow at the end`);
    assert.equal(f.def, def, `${key} default`);
    assert.equal(ruleField(key), f);
  });
  assert.equal(ruleField('constructor'), undefined);
  // today's match: free for all, 19 bots, 100 health + 100 shield, 50 siphon, no start materials
  assert.deepEqual(
    [RULE_DEFAULTS.teams, RULE_DEFAULTS.bots, RULE_DEFAULTS.hp, RULE_DEFAULTS.shield, RULE_DEFAULTS.siphon, RULE_DEFAULTS.mats, RULE_DEFAULTS.win, RULE_DEFAULTS.spawn, RULE_DEFAULTS.storm],
    [1, 19, PLAYER.maxHp, PLAYER.startShield, PLAYER.siphon, 0, 'last', 'bus', 'classic'],
  );
});

test('mode rules: RULE_DEFAULTS normalizes to itself', () => {
  const r = normalizeRules(RULE_DEFAULTS);
  assert.deepEqual(r, { ...RULE_DEFAULTS });
  assert.notEqual(r, RULE_DEFAULTS, 'a fresh object');
  assert.deepEqual(normalizeRules({}), r);
  assertValidRules(r);
  assert.equal(rulesFingerprint(r), rulesFingerprint({}));
});

test('mode rules: snapping, fallbacks, area and consistency', () => {
  const n = (x, o) => normalizeRules(x, o);
  assert.equal(n({ bots: 8 }).bots, 7, 'a tie goes to the option listed first');
  assert.equal(n({ bots: 100 }).bots, 31);
  assert.equal(n({ bots: -3 }).bots, 0);
  assert.equal(n({ bots: -0 }).bots, 0);
  assert.ok(Object.is(n({ bots: -0 }).bots, 0));
  assert.equal(n({ teams: 5 }).teams, 4);
  assert.equal(n({ teams: 'three' }).teams, 1);
  assert.equal(n({ gravity: 0.4 }).gravity, 0.35);
  assert.equal(n({ respawn: 5, lives: 4 }).lives, 3, 'lives 4: a tie, the option listed first');
  assert.equal(n({ bots: '19' }).bots, 19, 'a string is not a number: default');
  assert.equal(n({ bots: NaN }).bots, 19);
  assert.equal(n({ oneShot: 1 }).oneShot, false);
  assert.equal(n({ storm: 'none', unknown: 1, __proto__: { pvp: false } }).pvp, true, 'only own keys count');
  assert.equal(n({ area: 'poi:Tilty Towers' }).area, 'poi:Tilty Towers');
  assert.equal(n({ area: 'biome:volcano' }).area, 'biome:volcano');
  for (const bad of ['poi:<b>', 'biome:Volcano', 'poi:', 'everywhere', 12, null]) assert.equal(n({ area: bad }).area, 'full', String(bad));
  assert.deepEqual([n({ win: 'elims' }).target, n({ win: 'teamelims' }).target, n({ win: 'koth' }).target], [15, 50, 100]);
  assert.equal(n({ win: 'elims', target: 30 }).target, 30);
  assert.equal(n({ win: 'time' }).timeLimit, 300);
  assert.equal(n({ teams: 'humans', bots: 0 }).bots, 1);
  assert.equal(n({ respawn: 0, lives: 3 }).lives, 1);
  assert.equal(n({ respawn: 5, lives: 0 }).lives, 0);
  // games: a win type without a game falls back to 'last'
  assert.equal(n({ win: 'koth' }).win, 'koth');
  assert.equal(n({ win: 'koth' }, { games: [] }).win, 'last');
  assert.equal(n({ win: 'koth' }, { games: ['koth'] }).win, 'koth');
  assert.equal(n({ win: 'koth' }, { games: new Set(['last']) }).win, 'last');
  assert.equal(n({ win: 'koth', target: 0 }, { games: { koth: {} } }).target, 100);
  // legacy room settings
  assert.deepEqual(rulesFromSettings({ bots: 8, mats: 0, mode: 'ffa' }), normalizeRules(LEGACY_MODES.ffa));
  assert.equal(rulesFromSettings({ mode: 'squad' }).teams, 'humans');
  assert.equal(rulesFromSettings({ mode: 'constructor' }).teams, 1);
  assert.equal(rulesFromSettings({ mode: 'squad', rules: { teams: 3 } }).teams, 3);
  assert.deepEqual(rulesFromSettings(undefined), normalizeRules({}));
});

test('mode rules: 500 random junk inputs normalize to valid, idempotent rules', () => {
  const rnd = mulberry32(2026);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const junkValue = () => pick([
    () => rnd() * 200 - 50, () => Math.floor(rnd() * 40), () => NaN, () => Infinity, () => -0, () => 'x', () => '',
    () => true, () => false, () => null, () => undefined, () => ({}), () => [1, 2], () => 'poi:Mossy Mill', () => 'biome:snow',
    () => 'poi:' + 'x'.repeat(40), () => 'constructor',
  ])();
  const games = ['koth', 'elims', 'gungame'];
  for (let i = 0; i < 500; i++) {
    let input;
    if (i % 50 === 0) input = pick([null, 42, 'rules', [1, 2, 3], undefined, true]);
    else {
      input = {};
      for (const f of RULE_FIELDS) {
        const x = rnd();
        if (x < 0.35) continue;
        input[f.key] = x < 0.7 ? pick(f.options) : junkValue();
      }
      for (let k = 0; k < 3; k++) if (rnd() < 0.3) input[pick(['foo', 'toString', '__proto__', 'Teams', 'bot', ''])] = junkValue();
    }
    const opts = i % 3 === 0 ? { games } : undefined;
    const r = normalizeRules(input, opts);
    assertValidRules(r, opts && games);
    assert.deepEqual(normalizeRules(r, opts), r, `idempotent (#${i})`);
    assert.deepEqual(normalizeRules(JSON.parse(JSON.stringify(r)), opts), r, 'survives the network');
    assert.equal(rulesFingerprint(normalizeRules(r)), rulesFingerprint(r));
    assert.match(rulesFingerprint(r), new RegExp(`^[0-9a-z]{${RULE_FIELDS.length - 1}}\\|`));
  }
});

test('mode rules: fingerprints are equal exactly when the rules are', () => {
  const rnd = mulberry32(7);
  const seen = new Map();
  for (let i = 0; i < 300; i++) {
    const input = {};
    for (const f of RULE_FIELDS) if (rnd() < 0.2) input[f.key] = f.options[Math.floor(rnd() * f.options.length)];
    if (rnd() < 0.2) input.area = `poi:Place ${Math.floor(rnd() * 3)}`;
    const r = normalizeRules(input);
    const fp = rulesFingerprint(r);
    const key = JSON.stringify(r);
    if (seen.has(fp)) assert.equal(seen.get(fp), key, 'same fingerprint, same rules');
    seen.set(fp, key);
  }
  assert.equal(new Set([...seen.values()]).size, seen.size, 'different rules, different fingerprints');
});

// ------------------------------------------------------------------ mode registry
test('mode registry: every CORE_MODES entry normalizes', () => {
  const CATS = ['br', 'team', 'party', 'mutators', 'builders', 'practice', 'places'];
  assert.deepEqual(CORE_MODES.map((m) => m.id), ['solo', 'squadbots', 'duos', 'playground']);
  for (const m of CORE_MODES) {
    assert.ok(typeof m.name === 'string' && m.name && typeof m.emoji === 'string' && /^#[0-9a-f]{6}$/i.test(m.color), m.id);
    assert.ok(CATS.includes(m.cat) && typeof m.desc === 'string' && typeof m.players === 'string' && Array.isArray(m.tags), m.id);
    assert.ok(m.rules && typeof m.rules === 'object');
    for (const k of Object.keys(m.rules)) assert.ok(ruleField(k), `${m.id}: ${k} is a rule`);
    const r = normalizeRules(m.rules);
    assertValidRules(r);
    for (const [k, v] of Object.entries(m.rules)) assert.equal(r[k], v, `${m.id}.${k} survives normalizing`);
    assert.deepEqual(modeRules(m.id), r);
    assert.equal(findMode(m.id), m);
    assert.deepEqual(modeInfo(m), { name: m.name, emoji: m.emoji, color: m.color, desc: m.desc, tags: m.tags });
  }
  assert.deepEqual(modeRules('solo'), normalizeRules({}), 'solo is today\'s Battle Royale');
  assert.equal(modeRules('squadbots').teams, 'humans');
  assert.equal(modeRules('squadbots').bots, 15);
  assert.equal(modeRules('duos').teams, 2);
  const pg = modeRules('playground');
  assert.deepEqual(
    [pg.spawn, pg.respawn, pg.lives, pg.storm, pg.build, pg.ammo, pg.pvp, pg.bots, pg.loadout, pg.rarity],
    ['ground', 3, 0, 'none', 'infinite', 'infinite', false, 0, 'pool', 'legendary'],
  );
  assert.equal(new Set(CORE_MODES.map((m) => rulesFingerprint(m.rules))).size, CORE_MODES.length);
  // the registry: core modes first, catalogue after, unique ids
  assert.ok(Array.isArray(CATALOG));
  assert.deepEqual(MODES.slice(0, CORE_MODES.length), CORE_MODES);
  assert.equal(new Set(MODES.map((m) => m.id)).size, MODES.length);
  assert.equal(findMode('nope'), null);
  assert.equal(findMode('constructor'), null);
  assert.equal(modeRules('nope'), null);
  // games
  for (const g of [GAMES, CORE_GAMES, PARTY_GAMES]) assert.ok(g && typeof g === 'object' && !Array.isArray(g));
  assert.deepEqual(Object.keys(GAMES).sort(), [...Object.keys(CORE_GAMES), ...Object.keys(PARTY_GAMES)].sort());
});

// ------------------------------------------------------------------ room
test('room: settings, maxHumans and rules (legacy modes keep working)', () => {
  const plain = new Room({ code: 'T', now: () => 0 });
  assert.deepEqual(plain.settings, { bots: 8, mats: 0, mode: 'ffa' });
  assert.deepEqual(plain.rules, normalizeRules({}));
  assert.equal(plain.maxHumans, 16);
  assert.equal(new Room({ solo: true, now: () => 0 }).settings.bots, 19);
  const squad = new Room({ now: () => 0, settings: { mode: 'squad', bots: 3 } });
  assert.deepEqual(squad.settings, { bots: 3, mats: 0, mode: 'squad' });
  assert.equal(squad.rules.teams, 'humans');
  const ruled = new Room({ now: () => 0, settings: { rules: { teams: 2, storm: 'fast' } } });
  assert.equal(ruled.rules.teams, 2);
  assert.equal(ruled.rules.storm, 'fast');
  // a full party
  const H = makeRoom({ maxHumans: 2 });
  const a = H.join('Ann'), b = H.join('Ben'), c = H.join('Cat');
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, false]);
  assert.match(H.last(c, 'err').msg, /full/);
  assert.equal(H.room.publicInfo('').max, 2);
  // the legacy start message switches to squad mode, and the rules follow
  H.send(a, { t: 'start', bots: 2, mats: 0, mode: 'squad' });
  assert.equal(H.room.rules.teams, 'humans');
  assert.equal(a.p.team, b.p.team);
  assert.equal(H.errors.length, 0);
});

test('room plugins: a plugin in ROOM_PLUGINS gets every hook and its handler during a scripted match', () => {
  const log = [];
  const order = [];
  let room = null;
  const plugin = {
    name: 'probe',
    init(r) { room = r; order.push('init'); log.push(['init', r]); },
    handlers: {
      probe(c, m) { order.push('probe'); log.push(['probe', this, c.pid, m.n]); },
      // wraps a Room handler: the Room's own one is still reachable
      start(c, m) { order.push('start'); this.baseHandlers.start.call(this, c, m); },
    },
    onJoin(r, conn, hello) { order.push('onJoin'); log.push(['onJoin', r, conn.id, hello.name]); },
    onLeave(r, c, p) { order.push('onLeave'); log.push(['onLeave', r, c.pid, p && p.name, r.conns.has(c.conn.id)]); },
    roster(p) { return { probe: p.id * 10 }; },
    welcome(r, id) { return { probe: `hi ${id}` }; },
    tick(r, now) { if (!order.includes('tick')) order.push('tick'); log.push(['tick', r, now]); },
    onStart(r) { order.push('onStart'); log.push(['onStart', r, r.phase, H.msgs(a, 'start').length]); },
    onLobby(r) { order.push('onLobby'); log.push(['onLobby', r, r.phase, H.msgs(a, 'lobby').length]); },
    onElim(r, victim, killer, info) { order.push('onElim'); log.push(['onElim', r, victim.name, killer && killer.name, info.w, r.phase]); },
    pieceMsg(b) { return { probe: `piece ${b.k}` }; },
  };
  ROOM_PLUGINS.push(plugin);
  let H, a;
  try {
    H = makeRoom();
  } finally {
    ROOM_PLUGINS.pop();
  }
  assert.ok(ROOM_PLUGINS.every((p) => p !== plugin), 'the list is restored');
  assert.equal(room, H.room, 'init(room) at construction');
  assert.ok(H.room.plugins.includes(plugin), 'the room keeps the plugins it was made with');
  a = H.join('Ann');
  const b = H.join('Ben');
  assert.ok(a.ok && b.ok);
  assert.deepEqual(log.filter((e) => e[0] === 'onJoin').map((e) => [e[1] === H.room, e[2], e[3]]), [[true, a.id, 'Ann'], [true, b.id, 'Ben']]);
  // roster rows and the welcome carry the plugin's fields
  assert.equal(H.last(a, 'welcome').probe, `hi ${a.pid}`);
  assert.ok(H.last(a, 'welcome').players.every((p) => p.probe === p.id * 10));
  assert.ok(H.last(a, 'roster').players.every((p) => p.probe === p.id * 10));
  // its handler, with this = room
  H.send(b, { t: 'probe', n: 7 });
  assert.deepEqual(log.find((e) => e[0] === 'probe').slice(1), [H.room, b.pid, 7]);
  // ticks
  H.advance(200);
  const ticks = log.filter((e) => e[0] === 'tick');
  assert.equal(ticks.length, 4, '20 Hz');
  assert.ok(ticks.every((e) => e[1] === H.room && e[2] <= H.now()));
  // a build piece message in the lobby warm-up
  const g = H.room.world.pois[0];
  const k = `f${Math.floor(g.x / 4)},-1,${Math.floor(g.z / 4)}`;
  H.send(a, { t: 'b', k, m: 'wood' });
  assert.equal(H.last(b, 'b+').probe, `piece ${k}`);
  // the match: start goes through the plugin's handler to the Room's own
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  assert.equal(H.room.phase, 'bus');
  assert.deepEqual(log.find((e) => e[0] === 'onStart').slice(1), [H.room, 'bus', 1], 'after the start broadcast');
  H.send(a, { t: 'drop' });
  H.send(b, { t: 'drop' });
  H.send(a, { t: 'hit', tg: b.pid, w: 'sniper', r: 4, d: 10, n: 0, nh: 1 });
  assert.equal(b.p.alive, false);
  assert.deepEqual(log.find((e) => e[0] === 'onElim').slice(1), [H.room, 'Ben', 'Ann', 'sniper', 'bus'], 'before checkWin ends the match');
  assert.equal(H.room.phase, 'ended');
  H.send(a, { t: 'end' });
  assert.deepEqual(log.find((e) => e[0] === 'onLobby').slice(1), [H.room, 'lobby', 0], 'before the lobby broadcast');
  assert.equal(H.msgs(a, 'lobby').length, 1);
  // leaving
  H.leave(b);
  assert.deepEqual(log.find((e) => e[0] === 'onLeave').slice(1), [H.room, b.pid, 'Ben', false]);
  assert.equal(H.room.players.has(b.pid), false, 'a leave the plugin did not take is the usual leave');
  assert.deepEqual(order.filter((x, i) => order.indexOf(x) === i), ['init', 'onJoin', 'probe', 'tick', 'start', 'onStart', 'onElim', 'onLobby', 'onLeave']);
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('room plugins: answers from onJoin / onLeave, handler precedence and errors', () => {
  const held = [];
  const gate = {
    name: 'gate',
    onJoin(room, conn, hello) {
      if (hello.name === 'Banned') { room.send(conn, { t: 'err', msg: 'nope' }); return false; }
      return undefined;
    },
    onLeave(room, c, p) { if (room.phase === 'match' || room.phase === 'bus') { held.push(p.id); return true; } return undefined; },
    handlers: { emote(c, m) { this.broadcast({ t: 'emote2', id: c.pid, e: m.e }); } },
    tick() { throw new Error('boom'); },
  };
  const H = makeRoom({ plugins: [gate] });
  const a = H.join('Ann'), b = H.join('Ben'), x = H.join('Banned');
  assert.deepEqual([a.ok, b.ok, x.ok], [true, true, false]);
  assert.equal(H.room.humans().length, 2);
  assert.equal(H.last(x, 'err').msg, 'nope');
  H.send(a, { t: 'emote', e: 2 });
  assert.equal(H.msgs(b, 'emote').length, 0, 'the plugin handler replaces the Room\'s');
  assert.deepEqual(H.last(b, 'emote2'), { t: 'emote2', id: a.pid, e: 2 });
  assert.equal(H.room.baseHandlers.emote.name, 'emote');
  H.advance(100);
  assert.equal(H.room.phase, 'lobby', 'a throwing plugin does not stop the room');
  assert.ok(H.errors.length >= 2 && H.errors.every((e) => e.msg === 'plugin error' && e.plugin === 'gate' && e.hook === 'tick'));
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  H.leave(b);
  assert.deepEqual(held, [b.pid]);
  assert.ok(H.room.players.get(b.pid).alive, 'a held player stays in the match');
  assert.equal(H.room.conns.size, 1);
  // unknown and prototype message types are ignored
  for (const t of ['constructor', '__proto__', 'toString', 'nope']) H.send(a, { t });
  assert.equal(H.room.phase, 'bus');
});

// ------------------------------------------------------------------ world
// The contract checks hold for every world version; the pinned numbers are the 640 m island's
// (version 1), which must not change until the new map replaces it.
test('world: the checksum equals the value before the change, and the contract fields are there', () => {
  const w = generateWorld(MAP.seed);
  assert.equal(SCALE.MAP, MAP);
  assert.equal(SCALE.BUS, BUS);
  assert.equal(SCALE.DROP, DROP);
  for (const k of Object.keys(DROP)) assert.equal(PLAYER[k], DROP[k], k);
  assert.ok(Number.isInteger(w.version) && w.version >= 1);
  if (w.version === 1) {
    assert.equal(w.checksum, 4856698, 'same island as 1.1');
    assert.equal(w.objects.length, 2396);
    assert.deepEqual([MAP.seed, MAP.size, MAP.res, MAP.islandRadius], [20261003, 640, 160, 268]);
    assert.deepEqual(BUS, { height: 135, speed: 30, length: 680, forceDrop: 0.84 });
    assert.deepEqual(DROP, { skydiveFall: 34, skydiveDive: 50, skydiveSpeed: 22, glideFall: 8, glideSpeed: 15, glideHeight: 55 });
    assert.equal(w.regions.length, w.pois.length);
    w.regions.forEach((g, i) => {
      const p = w.pois[i];
      assert.deepEqual(g, { id: i, name: p.name, x: p.x, z: p.z, r: p.r, biome: 'meadow', kind: p.type, tier: 'normal', named: true });
    });
    assert.deepEqual([w.biome, w.surface, w.surfaceKeyAt], [null, null, null]);
    for (const [x, z] of [[0, 0], [300, 300], [w.pois[0].x, w.pois[0].z], [-310, 10], [w.mountain.x, w.mountain.z]]) {
      assert.equal(w.biomeAt(x, z), w.heightAt(x, z) < 3 ? 'beach' : 'meadow');
    }
    for (const k of ['roads', 'rivers', 'lakes', 'pads', 'lava']) assert.deepEqual(w[k], [], k);
    for (const h of w.houses) assert.deepEqual([h.archetype, h.region], [h.style === 'metal' ? 'warehouse' : 'house', h.poi]);
    for (const c of [...w.chests, ...w.lootSpots]) assert.equal(c.tier, 'normal');
  }
  // keys
  assert.deepEqual(BIOMES, ['ocean', 'beach', 'meadow', 'forest', 'farm', 'city', 'snow', 'desert', 'mesa', 'jungle', 'swamp', 'volcano']);
  assert.deepEqual(SURFACES.slice(0, 4), ['grass', 'dirt', 'sand', 'rock']);
  assert.equal(SURFACES.length, 16);
  assert.deepEqual(SPECIES.slice(0, 3), ['pine', 'oak', 'palm']);
  for (const s of SPECIES) assert.ok([0, 1, 2].includes(SPECIES_TYPE[s]), s);
  assert.equal(LOOKS.length, 20);
  for (const k of Object.values(LOOK_ALIASES)) assert.ok(LOOKS.includes(k));
  assert.deepEqual([PADS, TIERS], [['launch', 'geyser', 'mushroom'], ['hot', 'normal', 'quiet']]);
  for (const s of SURFACES) assert.ok(['grass', 'dirt', 'sand', 'stone', 'snow', 'wood', 'metal'].includes(STEP_SOUND[s]), s);
  // terrain grids and lookups
  for (const g of ['biome', 'surface']) assert.ok(w[g] === null || (w[g] instanceof Uint8Array && w[g].length === w.N * w.N), g);
  assert.ok(w.surfaceKeyAt === null || typeof w.surfaceKeyAt === 'function');
  const rnd = mulberry32(5);
  for (let i = 0; i < 200; i++) {
    const x = (rnd() - 0.5) * w.size, z = (rnd() - 0.5) * w.size;
    assert.ok(BIOMES.includes(w.biomeAt(x, z)));
    if (w.surfaceKeyAt) assert.ok(SURFACES.includes(w.surfaceKeyAt(x, z)));
  }
  for (const k of ['roads', 'rivers', 'lakes', 'pads', 'lava']) assert.ok(Array.isArray(w[k]), k);
  for (const pad of w.pads) assert.ok(PADS.includes(pad.kind));
  // places
  assert.ok(w.regions.length > 0);
  w.regions.forEach((g, i) => {
    assert.equal(g.id, i);
    assert.ok(typeof g.name === 'string' && g.name && Number.isFinite(g.x) && Number.isFinite(g.z) && g.r > 0, g.name);
    assert.ok(BIOMES.includes(g.biome) && typeof g.kind === 'string' && TIERS.includes(g.tier) && typeof g.named === 'boolean', g.name);
  });
  // spawn points: open land around every named place
  for (const g of w.regions) if (g.named) assert.ok(w.spawnPoints.filter((s) => s.region === g.id).length >= 8, g.name);
  for (const s of w.spawnPoints) {
    const h = w.heightAt(s.x, s.z);
    assert.ok(Math.abs(s.y - h) < 0.01 && h > 0, 'on the ground, on land');
    assert.ok(s.region === -1 || (s.region >= 0 && s.region < w.regions.length));
    assert.equal(w.solidNear(s.x, s.y + 0.9, s.z, null, 0.3), false, 'not inside anything');
  }
  // objects, loot, houses
  for (const o of w.objects) {
    if (o.kind === 'tree') assert.equal(SPECIES_TYPE[o.species], o.type);
    if (o.kind === 'part') assert.ok(LOOKS.includes(o.look) || Object.hasOwn(LOOK_ALIASES, o.look), o.look);
  }
  for (const c of [...w.chests, ...w.lootSpots]) assert.ok(TIERS.includes(c.tier));
  for (const h of w.houses) assert.ok(typeof h.archetype === 'string' && Number.isInteger(h.region));
  // objectsNear = a brute-force search
  for (let i = 0; i < 60; i++) {
    const x = (rnd() - 0.5) * w.size, z = (rnd() - 0.5) * w.size, r = rnd() * 80;
    const got = [];
    assert.equal(w.objectsNear(x, z, r, (o) => { got.push(o.id); }), false);
    const want = w.objects.filter((o) => (o.x - x) ** 2 + (o.z - z) ** 2 <= r * r).map((o) => o.id);
    assert.deepEqual(got.sort((p, q) => p - q), want);
  }
  let n = 0;
  assert.equal(w.objectsNear(0, 0, w.size, () => ++n === 3), true, 'returning true stops the walk');
  assert.equal(n, 3);
  // build keys reach 1.25 map sizes out (200 cells on the 640 m island, as before)
  const max = Math.ceil((MAP.size * 1.25) / 4);
  if (w.version === 1) assert.equal(max, 200);
  assert.ok(parseKey(`w${max},0,${-max},x`) && parseKey(`f${-max},0,${max}`));
  assert.equal(parseKey(`w${max + 1},0,0,x`), null);
  assert.equal(parseKey(`f0,0,${-max - 1}`), null);
});

// ------------------------------------------------------------------ game plugins (FakeCtx)
test('FakeCtx: a small game runs through every hook', () => {
  // tag: the first player is 'it'; every kill scores, victims come back after 2 s with a pickaxe; 3 kills win
  const tag = {
    key: 'tag', label: 'Tag', defaults: { win: 'elims', target: 5 },
    setup(ctx) { ctx.setRole(ctx.players()[0], 'it'); ctx.state.started = ctx.now(); },
    onKill(ctx, victim, killer) {
      if (killer) ctx.addScore(killer.id);
      ctx.respawn(victim, 2);
    },
    allowDamage(ctx, attacker, target) { return !attacker || ctx.roleOf(attacker) === 'it'; },
    scaleDamage(ctx, attacker, target, amount) { return amount * 2; },
    onRespawn(ctx, p) { ctx.note(`${p.name} is back`); },
    loadout() { return { slots: [{ k: 'pickaxe', r: 0 }], ammo: {}, mats: { wood: 0, stone: 0, metal: 0 } }; },
    checkWin(ctx) { const top = ctx.scores()[0]; return top && top[1] >= 3 ? { id: top[0], reason: 'elims' } : null; },
    hud(ctx) { return { top: ctx.scores().slice(0, 3) }; },
  };
  const ctx = new FakeCtx({ game: tag, players: 4, rules: { shield: 0 } });
  assert.equal(ctx.rules.win, 'elims');
  assert.equal(ctx.rules.target, 5);
  assert.equal(ctx.rules.shield, 0);
  ctx.start();
  const [it, p2, p3, p4] = ctx.players();
  assert.equal(ctx.roleOf(it), 'it');
  assert.deepEqual(ctx.roleLog, [{ t: 0, id: it.id, role: 'it' }]);
  assert.equal(ctx.loadouts.length, 4);
  assert.deepEqual(ctx.teams().map((t) => t.id), [1, 2, 3, 4]);
  assert.ok(ctx.rng() >= 0 && ctx.rng() < 1);
  // damage goes through allowDamage and scaleDamage
  assert.equal(ctx.hit(p2, p3, 50), 0, 'only "it" can hurt');
  assert.equal(ctx.hit(it, p2, 30), 60);
  assert.equal(p2.hp, 40);
  ctx.hit(it, p2, 30);
  assert.equal(p2.alive, false);
  assert.equal(it.kills, 1);
  assert.deepEqual(ctx.scores(), [[it.id, 1]]);
  assert.deepEqual(ctx.respawns.map((r) => [r.id, r.at]), [[p2.id, 2000]]);
  ctx.advance(1900);
  assert.equal(p2.alive, false);
  ctx.advance(200);
  assert.equal(p2.alive, true);
  assert.equal(p2.hp, 100);
  assert.deepEqual(ctx.revived.map((r) => r.id), [p2.id]);
  assert.deepEqual(ctx.notes, [`${p2.name} is back`]);
  assert.equal(ctx.loadouts.length, 5, 'a respawn gets the loadout again');
  assert.deepEqual(ctx.hud(), { top: [[it.id, 1]] });
  ctx.eliminate(p3, it, { w: 'pickaxe' });
  ctx.eliminate(p4, it, { w: 'pickaxe' });
  assert.deepEqual(ctx.result, { id: it.id, reason: 'elims' });
  assert.equal(ctx.elims.length, 3);
  // a time limit ends any game: the top score wins
  const timed = new FakeCtx({ game: { key: 't', teamGame: true }, players: 4, rules: { win: 'time', timeLimit: 180 } });
  timed.start();
  timed.addScore(2, 5);
  timed.addScore(1, 3);
  timed.advance(179900);
  assert.equal(timed.result, null);
  timed.advance(100);
  assert.deepEqual(timed.result, { team: 2, reason: 'time' });
  // without a game: core respawn rules (lives count down) and environmental damage
  const core = new FakeCtx({ players: 2, rules: { respawn: 3, lives: 2 } });
  core.start();
  const [c1] = core.players();
  core.damage(c1, 150, { c: 'lava' });
  assert.equal(c1.alive, true, 'shield first');
  core.damage(c1, 60, { ignoreShield: true });
  assert.equal(c1.alive, false);
  assert.equal(c1.lives, 1);
  core.advance(3000);
  assert.equal(c1.alive, true);
  core.eliminate(c1, null);
  assert.equal(c1.lives, 0);
  core.advance(5000);
  assert.equal(c1.alive, false, 'out of lives');
});

// ------------------------------------------------------------------ client stubs (importable in Node too)
test('client plugin points: game plugins, Discover, grade, bench, tree species, layer textures', async () => {
  const { GAME_PLUGINS } = await import('../public/js/game/plugins.js');
  assert.deepEqual(GAME_PLUGINS.map((P) => P.name), ['PartyBridge', 'ModeClient', 'MapClient', 'BuildClient']);
  const game = {};
  for (const P of GAME_PLUGINS) assert.equal(new P(game).game, game);
  const { openDiscover, openCreator } = await import('../public/js/ui/discover.js');
  assert.equal(openDiscover({}, { isLeader: true, current: {}, onPick() {}, onSuggest() {} }), null);
  assert.equal(openCreator({}, { initial: {}, onPlay() {}, onSave() {} }), null);
  const { applyGrade } = await import('../public/js/gfx/grade.js');
  assert.equal(applyGrade({}), undefined);
  const { runBench } = await import('../public/js/bench.js');
  assert.equal(typeof runBench, 'function');
  const { treeGeometry } = await import('../public/js/world/models.js');
  const count = (g) => g.trunk.attributes.position.count + g.leaves.attributes.position.count;
  assert.equal(count(treeGeometry('pine')), count(treeGeometry(0)));
  assert.equal(count(treeGeometry('palm', 2)), count(treeGeometry(2)));
  assert.equal(count(treeGeometry('birch')), count(treeGeometry(1)));
  assert.equal(count(treeGeometry('nope')), count(treeGeometry(1)));
  const { layerTexture } = await import('../public/js/gfx/texgen.js');
  for (const k of [...SURFACES, ...LOOKS, ...Object.keys(LOOK_ALIASES), 'unknown']) {
    const img = layerTexture(k, 32);
    assert.ok(img.size === 32 && img.color.length === 32 * 32 * 4 && img.height.length === 32 * 32, k);
  }
  assert.equal(layerTexture('grass', 32, true).size, 16, 'low halves the size');
});
