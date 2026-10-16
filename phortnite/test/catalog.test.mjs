// Mode catalogue, mode codes and auto names (shared/modes/catalog.js, shared/modes/code.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, modeAvailable } from '../public/shared/modes/catalog.js';
import { CORE_MODES, MODES, findMode, modeRules } from '../public/shared/modes/index.js';
import { RULE_FIELDS, normalizeRules, rulesFingerprint, ruleField, AREA_RE } from '../public/shared/modes/rules.js';
import { GAMES } from '../public/shared/modes/games/index.js';
import { PARTY_GAMES } from '../public/shared/modes/games/party.js';
import {
  encodeRules, decodeRules, describeRules, prettyCode, placeList, PLACE_NAMES, areaName,
} from '../public/shared/modes/code.js';
import { BIOMES } from '../public/shared/world/keys.js';
import { mulberry32 } from '../public/shared/rng.js';
import { getWorld } from '../public/shared/room.js';

const CATS = ['br', 'team', 'party', 'mutators', 'builders', 'practice', 'places'];
const WIN = ruleField('win').options;

test('catalogue: at least 44 curated modes with unique ids, every category filled', () => {
  assert.ok(CATALOG.length >= 44, `${CATALOG.length} curated modes`);
  const ids = new Set(CATALOG.map((m) => m.id));
  assert.equal(ids.size, CATALOG.length, 'unique ids');
  for (const m of CORE_MODES) assert.ok(!ids.has(m.id), `${m.id} is a core mode (it would be dropped)`);
  assert.equal(MODES.length, CORE_MODES.length + CATALOG.length, 'nothing dropped from the registry');
  for (const c of CATS) assert.ok(MODES.filter((m) => m.cat === c).length >= 3, `category ${c}`);
  for (const id of ['trios', 'squads', 'zb-solo', 'zb-duos', 'zb-squads', 'builder-pro', 'big-battle', 'rapid', 'golden', 'late-game',
    'bootcamp', 'team-rumble', 'zb-rumble', 'duos-rumble', 'ffa-frenzy', 'gun-game', 'infection', 'koth', 'juggernaut', 'floor-is-lava',
    'one-shot', 'pickaxe-party', 'rocket-rumble', 'sniper-showdown', 'shotgun-shuffle', 'pistol-pals', 'smg-spray', 'moon', 'big-head',
    'speed-demons', 'tank-battle', 'glass-cannon', 'vampire', 'headhunters', 'bouncy', 'mystery', 'build-battle', 'box-fight', 'zone-wars',
    'target-practice', 'volcano-zone-wars', 'city-rumble', 'snowball-snipers', 'desert-duos', 'jungle-rumble']) {
    assert.ok(findMode(id), `the plan's ${id}`);
  }
});

test('catalogue: entries are well formed and their rules normalize to themselves', () => {
  for (const m of CATALOG) {
    assert.ok(typeof m.name === 'string' && m.name.length >= 3 && m.name.length <= 24, `${m.id} name`);
    assert.ok(typeof m.emoji === 'string' && m.emoji.length > 0 && /^#[0-9a-f]{6}$/i.test(m.color), `${m.id} emoji / colour`);
    assert.ok(CATS.includes(m.cat), `${m.id} cat`);
    assert.ok(typeof m.desc === 'string' && m.desc.length > 10 && typeof m.players === 'string', `${m.id} desc / players`);
    assert.ok(Array.isArray(m.tags) && m.tags.length >= 1 && m.tags.every((t) => typeof t === 'string'), `${m.id} tags`);
    for (const k of Object.keys(m.rules)) assert.ok(ruleField(k), `${m.id}: ${k} is a rule`);
    const r = normalizeRules(m.rules);
    for (const [k, v] of Object.entries(m.rules)) assert.equal(r[k], v, `${m.id}.${k} survives normalizing`);
    assert.deepEqual(normalizeRules(r), r, `${m.id} idempotent`);
    assert.deepEqual(modeRules(m.id), r);
    // a mode with respawn must let you respawn at least once
    if (r.respawn > 0) assert.notEqual(r.lives, 1, `${m.id}: respawn with a single life`);
  }
});

test('catalogue: unique fingerprints (no two modes play the same)', () => {
  const seen = new Map();
  for (const m of MODES) {
    const fp = rulesFingerprint(m.rules);
    assert.ok(!seen.has(fp), `${m.id} plays the same as ${seen.get(fp)}`);
    seen.set(fp, m.id);
  }
});

test('catalogue: every requires key is a known game, and score modes say which game they need', () => {
  for (const m of MODES) {
    const r = normalizeRules(m.rules);
    if (m.requires !== undefined) {
      assert.ok(WIN.includes(m.requires), `${m.id}: requires ${m.requires}`);
      assert.equal(m.requires, r.win, `${m.id}: requires its own win type`);
    } else {
      assert.equal(r.win, 'last', `${m.id}: a ${r.win} mode must say requires`);
    }
  }
  // the party games are all here; a mode whose game is missing hides itself
  for (const k of ['gungame', 'infection', 'koth', 'juggernaut', 'lava']) assert.ok(PARTY_GAMES[k] && GAMES[k], k);
  assert.equal(modeAvailable(findMode('gun-game'), GAMES), true);
  assert.equal(modeAvailable(findMode('team-rumble'), {}), false);
  assert.equal(modeAvailable(findMode('team-rumble'), ['teamelims']), true);
  assert.equal(modeAvailable(findMode('trios'), {}), true);
  for (const m of MODES.filter((x) => x.requires)) assert.equal(modeAvailable(m, GAMES), Object.prototype.hasOwnProperty.call(GAMES, m.requires));
});

test('catalogue: areas are valid (named places and biomes of the big island)', () => {
  for (const m of CATALOG) {
    const a = normalizeRules(m.rules).area;
    assert.ok(AREA_RE.test(a), `${m.id} area ${a}`);
    if (a.startsWith('poi:')) assert.ok(PLACE_NAMES.includes(a.slice(4)), `${m.id}: ${a} has a short code`);
    if (a.startsWith('biome:')) assert.ok(BIOMES.includes(a.slice(6)), `${m.id}: ${a} is a biome`);
  }
  assert.equal(new Set(PLACE_NAMES).size, PLACE_NAMES.length);
  assert.equal(areaName('poi:Tilty Towers'), 'Tilty Towers');
  assert.equal(areaName('biome:snow'), 'the Snow');
  assert.equal(areaName('full'), '');
});

// ------------------------------------------------------------------ codes
const AREAS = [
  'full', 'center', 'random', ...BIOMES.map((b) => `biome:${b}`), ...PLACE_NAMES.map((p) => `poi:${p}`),
  'poi:Gas Station 3', "poi:Granny's Barn", 'poi:x', 'biome:lagoon', 'poi:A-very_long place name 12345',
];

function randomRules(rnd) {
  const r = {};
  for (const f of RULE_FIELDS) {
    if (f.key === 'area') r.area = AREAS[Math.floor(rnd() * AREAS.length)];
    else if (rnd() < 0.55) r[f.key] = f.options[Math.floor(rnd() * f.options.length)];
  }
  return normalizeRules(r);
}

test('codes: every catalogue mode round-trips, and codes are short', () => {
  const lens = [];
  for (const m of MODES) {
    const r = normalizeRules(m.rules);
    const code = encodeRules(m.rules);
    assert.match(code, /^M-[0-9A-HJKMNP-TV-Z]+$/, `${m.id} ${code}`);
    assert.deepEqual(decodeRules(code), r, `${m.id} ${code}`);
    lens.push(code.length - 2);
  }
  lens.sort((a, b) => a - b);
  const median = lens[lens.length >> 1];
  console.log(`  catalogue codes: ${lens[0]}-${lens[lens.length - 1]} characters after M-, median ${median}`);
  assert.ok(median <= 14 && lens[lens.length - 1] <= 20, 'codes stay typeable');
  // spaces, dashes, lower case and look-alike letters are fine
  const code = encodeRules(findMode('team-rumble').rules);
  assert.deepEqual(decodeRules(prettyCode(code).toLowerCase()), modeRules('team-rumble'));
  assert.deepEqual(decodeRules(code.slice(2)), modeRules('team-rumble'), 'without the M-');
  assert.deepEqual(decodeRules(code.replace(/0/g, 'O').replace(/1/g, 'l')), modeRules('team-rumble'), 'O for 0, l for 1');
  assert.deepEqual(decodeRules(encodeRules({})), normalizeRules({}));
});

test('codes: 2000 random rule sets round-trip (including spelled-out places)', () => {
  const rnd = mulberry32(2024);
  for (let i = 0; i < 2000; i++) {
    const r = randomRules(rnd);
    const code = encodeRules(r);
    const back = decodeRules(code);
    assert.deepEqual(back, r, `#${i} ${code}`);
    assert.equal(encodeRules(back), code, 'one code per rule set');
  }
});

test('codes: at least 99% of 1000 single-character corruptions are rejected', () => {
  const rnd = mulberry32(77);
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let rejected = 0, total = 0;
  while (total < 1000) {
    const code = encodeRules(randomRules(rnd));
    const i = Math.floor(rnd() * code.length);
    const ch = ALPHA[Math.floor(rnd() * ALPHA.length)];
    if (ch === code[i]) continue;
    const bad = code.slice(0, i) + ch + code.slice(i + 1);
    total++;
    if (decodeRules(bad) === null) rejected++;
  }
  console.log(`  ${rejected}/${total} corrupted codes rejected`);
  assert.ok(rejected >= 990, `${rejected}/1000`);
  // junk is never a code
  for (const junk of ['', 'M-', 'M-0', 'hello', 'M-UUUU', null, 42, {}, 'M-'.padEnd(300, '7')]) assert.equal(decodeRules(junk), null, String(junk));
  let typos = 0;
  for (let i = 0; i < 500; i++) {
    let s = 'M-';
    const n = 3 + Math.floor(rnd() * 10);
    for (let k = 0; k < n; k++) s += ALPHA[Math.floor(rnd() * 32)];
    if (decodeRules(s)) typos++;
  }
  assert.ok(typos <= 5, `${typos}/500 random strings decode`);
});

test('codes: a world\'s own extra places get numbers after PLACE_NAMES', () => {
  const world = { regions: [
    { name: 'Tilty Towers', named: true }, { name: 'Gas Station', named: false }, { name: 'Bramble Bay', named: true },
  ] };
  const places = placeList(world);
  assert.deepEqual(places.slice(0, PLACE_NAMES.length), [...PLACE_NAMES]);
  assert.deepEqual(places.slice(PLACE_NAMES.length), ['Bramble Bay']);
  const r = normalizeRules({ area: 'poi:Bramble Bay', teams: 2 });
  const short = encodeRules(r, { places });
  assert.ok(short.length < encodeRules(r).length, 'a listed place is shorter than spelled out');
  assert.deepEqual(decodeRules(short, { places }), r);
  assert.deepEqual(decodeRules(encodeRules(r), { places }), r, 'spelled out works everywhere');
  assert.equal(placeList(getWorld()), PLACE_NAMES, 'today\'s island needs nothing extra');
});

// ------------------------------------------------------------------ names
test('names: auto names and tags', () => {
  assert.equal(describeRules({ teams: 2, loot: 'snipers', gravity: 0.35, respawn: 5 }).name, 'Low-Gravity Sniper Duos with Respawn');
  // last standing with respawn can't have unlimited lives (it could never end): 3
  assert.equal(describeRules({ teams: 2, loot: 'snipers', gravity: 0.35, respawn: 5, lives: 0 }).name, 'Low-Gravity Sniper Duos with 3 Lives');
  assert.equal(describeRules({ teams: 2, loot: 'snipers', gravity: 0.35, respawn: 5, lives: 0, win: 'elims' }).name.includes('3 Lives'), false);
  assert.deepEqual(describeRules({ teams: 2, loot: 'snipers', gravity: 0.35, respawn: 5 }).tags, ['Duos', 'Snipers only', 'Low Gravity', 'Respawn']);
  assert.equal(describeRules({}).name, 'Solo');
  assert.equal(describeRules(modeRules('team-rumble')).name, 'Team Rumble');
  assert.equal(describeRules(modeRules('gun-game')).name, 'Gun Game');
  assert.equal(describeRules(modeRules('city-rumble')).name, 'Team Rumble at Tilty Towers');
  assert.equal(describeRules({ teams: 4, build: 'off' }).name, 'Zero-Build Squads');
  assert.equal(describeRules({ teams: 3, respawn: 5, lives: 3, bigHead: true }).name, 'Big-Head Trios with 3 Lives');
  const rnd = mulberry32(5);
  for (let i = 0; i < 300; i++) {
    const d = describeRules(randomRules(rnd));
    assert.ok(d.name.length >= 3 && d.name.length <= 48 && !/undefined|null|NaN|\s{2}/.test(d.name), d.name);
    assert.ok(d.tags.length >= 1 && d.tags.length <= 7 && d.tags.every((t) => typeof t === 'string' && t && !/undefined/.test(t)), d.tags.join());
  }
});
