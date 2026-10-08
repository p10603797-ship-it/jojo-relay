// Mode codes: any set of rules as a short code friends can type, share or scan (M-4K2P9XQ7).
// Shared by the Room and the client, so it stays free of DOM / Node specific APIs.
//
// Format: 'M-' + Crockford base32 data + 2 checksum characters.
// The data is a bit stream, packed 5 bits per character (zero padded), that lists only the rules
// that differ from RULE_DEFAULTS, in RULE_FIELDS order. For each one:
//   gamma(gap)   gap = field index - previous listed field index (>= 1), Elias gamma coded
//   gamma(k)     the option: k >= 1 (the default's own index is skipped, so k never needs 0)
// Elias gamma codes are self-delimiting and independent of how many options a field has, so the
// append-only option lists of shared/modes/rules.js can grow without breaking old codes.
// area: 1 center, 2 random, 3+ biome index (BIOMES), 20+ place index (PLACE_NAMES or the list
// passed as opts.places); AREA_LITERAL (19) is followed by the area spelled out (any other
// 'poi:<name>' / 'biome:<key>' that AREA_RE allows), so every valid rules object has a code.
// The checksum is a position-weighted sum of the characters modulo 1021 (a prime), so any
// single changed character and any swap of two neighbours is always caught.
import { RULE_FIELDS, RULE_DEFAULTS, normalizeRules, AREA_RE } from './rules.js';
import { BIOMES } from '../world/keys.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VALUE = (() => {
  const v = Object.create(null);
  for (let i = 0; i < 32; i++) v[ALPHABET[i]] = i;
  // Crockford: easily confused letters read as the digit they look like
  v.O = 0; v.I = 1; v.L = 1;
  return v;
})();
const SALT = 0x1a7; // format version 1 (a future format changes the salt, so old decoders refuse it)
const MOD = 1021;
const AREA_BIOME = 3, AREA_LITERAL = 19, AREA_PLACE = 20;

/**
 * Named places a code can refer to by number. APPEND-ONLY (codes store the index): today's
 * island first, then the big island's places. Places of a world that are not listed here still
 * work: placeList(world) appends them, and codes spell out anything else.
 */
export const PLACE_NAMES = Object.freeze([
  // the 640 m island
  'Pinewood Plaza', 'Breezy Bluffs', 'Rusty Yard', 'Sunny Shacks', 'Mossy Mill', 'Crater Cove', 'Hilltop Haven',
  // the big biome island
  'Tilty Towers', 'Retail Rumble', 'Frosty Peak', 'Chilly Chalets', 'Polar Palace', 'Dusty Depot', 'Mesa Mayhem',
  'Phunny Palms', 'Cactus Canyon', 'Slurpy Swamp', 'Temple of Phun', 'Treetop Town', 'Lava Lair', 'Magma Mines',
  'Phunny Farm', 'Pumpkin Patch', 'Castle Phortress', 'Pirate Cove', 'Lighthouse Point', 'Splashy Lake',
]);

/** PLACE_NAMES followed by the world's own named places that are not in it (same order on every device). */
export function placeList(world) {
  const regions = world && Array.isArray(world.regions) ? world.regions : [];
  const extra = [];
  for (const r of regions) {
    if (!r || typeof r.name !== 'string' || !r.named) continue;
    if (!PLACE_NAMES.includes(r.name) && !extra.includes(r.name) && AREA_RE.test(`poi:${r.name}`)) extra.push(r.name);
  }
  return extra.length ? PLACE_NAMES.concat(extra) : PLACE_NAMES;
}

// ------------------------------------------------------------------ bits
function gamma(bits, n) {
  let len = 0;
  for (let x = n; x > 1; x >>>= 1) len++;
  for (let i = 0; i < len; i++) bits.push(0);
  for (let i = len; i >= 0; i--) bits.push((n >>> i) & 1);
}

function readGamma(st) {
  let zeros = 0;
  while (st.i < st.bits.length && st.bits[st.i] === 0) { zeros++; st.i++; }
  if (st.i >= st.bits.length || zeros > 24) return 0; // the end (zero padding) or junk
  let n = 0;
  for (let k = 0; k <= zeros; k++) {
    if (st.i >= st.bits.length) return -1;
    n = n * 2 + st.bits[st.i++];
  }
  return n;
}

function writeBits(bits, v, n) { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); }

function readBits(st, n) {
  if (st.i + n > st.bits.length) return -1;
  let v = 0;
  for (let k = 0; k < n; k++) v = v * 2 + st.bits[st.i++];
  return v;
}

function checksum(vals) {
  let h = (SALT + vals.length * 37) % MOD;
  for (let i = 0; i < vals.length; i++) h = (h + (i + 1) * (vals[i] + 1)) % MOD;
  return h;
}

// ------------------------------------------------------------------ area
function areaCode(area, places) {
  if (area === 'center') return 1;
  if (area === 'random') return 2;
  if (area.startsWith('biome:')) {
    const i = BIOMES.indexOf(area.slice(6));
    if (i >= 0 && AREA_BIOME + i < AREA_LITERAL) return AREA_BIOME + i;
  } else if (area.startsWith('poi:')) {
    const i = places.indexOf(area.slice(4));
    if (i >= 0) return AREA_PLACE + i;
  }
  return AREA_LITERAL;
}

function areaFrom(k, st, places) {
  if (k === 1) return 'center';
  if (k === 2) return 'random';
  if (k >= AREA_BIOME && k < AREA_LITERAL) return BIOMES[k - AREA_BIOME] ? `biome:${BIOMES[k - AREA_BIOME]}` : null;
  if (k >= AREA_PLACE) return places[k - AREA_PLACE] !== undefined ? `poi:${places[k - AREA_PLACE]}` : null;
  // AREA_LITERAL: kind bit, length, 7-bit characters
  const kind = readBits(st, 1);
  const len = readGamma(st);
  if (kind < 0 || len < 1 || len > 40) return null;
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = readBits(st, 7);
    if (c < 32) return null;
    s += String.fromCharCode(c);
  }
  const area = `${kind ? 'biome' : 'poi'}:${s}`;
  return AREA_RE.test(area) ? area : null;
}

// ------------------------------------------------------------------ codes
/**
 * The code for a set of rules (normalized first). opts.places: the place list the area index
 * refers to (default PLACE_NAMES; pass placeList(world) for a world's own extra places).
 * @returns {string} 'M-' + data + checksum
 */
export function encodeRules(input, { places = PLACE_NAMES } = {}) {
  const r = normalizeRules(input);
  const bits = [];
  let prev = -1;
  RULE_FIELDS.forEach((f, i) => {
    const v = r[f.key];
    let k;
    if (f.key === 'area') {
      if (v === f.def) return;
      k = areaCode(v, places);
    } else {
      const idx = f.options.indexOf(v), d = f.options.indexOf(f.def);
      if (idx === d) return;
      k = idx < d ? idx + 1 : idx;
    }
    gamma(bits, i - prev);
    gamma(bits, k);
    prev = i;
    if (k === AREA_LITERAL) {
      const biome = v.startsWith('biome:');
      const s = v.slice(biome ? 6 : 4);
      writeBits(bits, biome ? 1 : 0, 1);
      gamma(bits, s.length);
      for (let c = 0; c < s.length; c++) writeBits(bits, s.charCodeAt(c) & 127, 7);
    }
  });
  while (bits.length % 5 || !bits.length) bits.push(0);
  const vals = [];
  for (let i = 0; i < bits.length; i += 5) vals.push(bits[i] * 16 + bits[i + 1] * 8 + bits[i + 2] * 4 + bits[i + 3] * 2 + bits[i + 4]);
  const h = checksum(vals);
  let s = 'M-';
  for (const v of vals) s += ALPHABET[v];
  return s + ALPHABET[h >> 5] + ALPHABET[h & 31];
}

/** Character values of a code body (null when a character is not Crockford base32). */
function values(body) {
  const out = [];
  for (const ch of body) {
    const v = VALUE[ch];
    if (v === undefined) return null;
    out.push(v);
  }
  return out;
}

function decodeBody(body, places) {
  const all = values(body);
  if (!all || all.length < 3) return null;
  const vals = all.slice(0, -2);
  const h = all[all.length - 2] * 32 + all[all.length - 1];
  if (checksum(vals) !== h) return null;
  const st = { bits: [], i: 0 };
  for (const v of vals) writeBits(st.bits, v, 5);
  const r = { ...RULE_DEFAULTS };
  let fi = -1;
  for (;;) {
    const gap = readGamma(st);
    if (gap === 0) break; // the zero padding at the end
    const k = readGamma(st);
    if (gap < 0 || k <= 0) return null;
    fi += gap;
    const f = RULE_FIELDS[fi];
    if (!f) return null;
    if (f.key === 'area') {
      const a = areaFrom(k, st, places);
      if (!a) return null;
      r.area = a;
    } else {
      const d = f.options.indexOf(f.def);
      const idx = k <= d ? k - 1 : k;
      if (idx >= f.options.length) return null;
      r[f.key] = f.options[idx];
    }
  }
  // anything after the last field must be padding
  for (let i = st.i; i < st.bits.length; i++) if (st.bits[i]) return null;
  return normalizeRules(r);
}

/**
 * The rules of a code (normalized), or null when it is not a valid code. Spaces, dashes and
 * lower case are fine; O reads as 0 and I / L as 1. opts.places as for encodeRules.
 */
export function decodeRules(code, { places = PLACE_NAMES } = {}) {
  if (typeof code !== 'string' || code.length > 200) return null;
  const s = code.toUpperCase().replace(/[\s\-_.]/g, '');
  if (!s) return null;
  // codes start with M ('M-' when written out); a code typed without it still works
  if (s[0] === 'M') {
    const r = decodeBody(s.slice(1), places);
    if (r) return r;
  }
  return decodeBody(s, places);
}

/** A code written for people: 'M-' and the characters in groups of four. */
export function prettyCode(code) {
  const body = String(code || '').toUpperCase().replace(/^M-?/, '').replace(/[^0-9A-Z]/g, '');
  return `M-${body.replace(/(.{4})(?=.)/g, '$1 ')}`;
}

// ------------------------------------------------------------------ names
const TEAM_NOUN = { 1: 'Solo', 2: 'Duos', 3: 'Trios', 4: 'Squads', two: 'Team', humans: 'Friends vs Bots' };
const TEAM_TAG = { 1: 'Solo', 2: 'Duos', 3: 'Trios', 4: 'Squads', two: '2 Teams', humans: 'Squad vs Bots' };
const GAME_NAME = {
  gungame: 'Gun Game', infection: 'Infection', koth: 'King of the Hill', juggernaut: 'Juggernaut', lava: 'Floor is Lava',
};
const LOOT_ADJ = {
  ars: 'AR', smgs: 'SMG', shotguns: 'Shotgun', snipers: 'Sniper', pistols: 'Pistol', rockets: 'Rocket', explosive: 'Boom', pickaxe: 'Pickaxe',
};
const LOOT_TAG = {
  ars: 'ARs only', smgs: 'SMGs only', shotguns: 'Shotguns only', snipers: 'Snipers only', pistols: 'Pistols only',
  rockets: 'Rockets only', explosive: 'Explosives', pickaxe: 'Pickaxes only',
};
const STORM_TAG = { fast: 'Fast Storm', slow: 'Slow Storm', none: 'No Storm', final: 'Final Circle', zonewars: 'Zone Wars' };
// games where coming back is part of the game (no 'with Respawn' in the name)
const RESPAWN_GAMES = new Set(['elims', 'teamelims', 'time', 'gungame', 'infection', 'koth', 'juggernaut']);

function titleCase(s) { return s.replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()); }

/** Where a rules area is, in words ('Tilty Towers', 'the Volcano'), or '' for the whole island. */
export function areaName(area) {
  if (typeof area !== 'string' || area === 'full') return '';
  if (area === 'center') return 'the Middle';
  if (area === 'random') return 'a Random Spot';
  if (area.startsWith('poi:')) return area.slice(4);
  if (area.startsWith('biome:')) return `the ${titleCase(area.slice(6))}`;
  return '';
}

/** Mutator words, most striking first: [adjective for the name, tag chip]. */
function mutators(r) {
  const out = [];
  if (r.gravity < 1) out.push(['Low-Gravity', 'Low Gravity']);
  else if (r.gravity > 1) out.push(['Heavy', 'Heavy Gravity']);
  if (r.bigHead) out.push(['Big-Head', 'Big Heads']);
  if (r.oneShot) out.push(['One-Shot', 'One Shot']);
  if (r.mystery) out.push(['Mystery', 'Mystery Mutators']);
  if (r.headOnly) out.push(['Headshot', 'Headshots Only']);
  if (r.speed > 1) out.push([r.speed >= 1.5 ? 'Turbo' : 'Speedy', 'Super Speed']);
  else if (r.speed < 1) out.push(['Slow-Mo', 'Slow Motion']);
  if (r.jump > 1) out.push([r.jump >= 2 ? 'Bouncy' : 'Springy', 'High Jump']);
  if (r.dmg >= 2) out.push(['Glass-Cannon', 'Double Damage']);
  else if (r.dmg > 1) out.push(['Spicy', 'Extra Damage']);
  else if (r.dmg < 1) out.push(['Tanky', 'Half Damage']);
  if (!r.pvp) out.push(['Peaceful', 'No Damage']);
  if (r.build === 'off') out.push(['Zero-Build', 'No Build']);
  if (r.rarity === 'legendary') out.push(['Golden', 'Legendary Loot']);
  if (r.siphon >= 100) out.push(['Vampire', 'Big Siphon']);
  if (r.heals === 'none') out.push(['No-Heal', 'No Heals']);
  if (r.hp < 100 && r.shield === 0) out.push(['Fragile', '50 HP']);
  if (r.storm === 'final') out.push(['Late-Game', 'Final Circle']);
  if (r.storm === 'fast' && r.win === 'last') out.push(['Rapid', 'Fast Storm']);
  if (r.build === 'infinite') out.push(['Infinite-Build', 'Infinite Build']);
  else if (r.build === 'on' && (r.mats >= 200 || r.harvest > 1) && r.loadout !== 'buildfight' && r.storm !== 'zonewars') {
    out.push(['Builder', r.mats >= 200 ? `${r.mats} Mats` : 'Fast Harvest']);
  }
  if (r.botSkill === 'easy') out.push(['Easy-Bot', 'Easy Bots']);
  else if (r.botSkill === 'hard') out.push(['Sweaty', 'Hard Bots']);
  if (r.rarity === 'boosted' && r.win === 'last') out.push(['Loot-Boosted', 'Better Loot']);
  return out;
}

/** The main word of a mode: its game, or what kind of fight it is. */
function nounOf(r) {
  const team = TEAM_NOUN[r.teams];
  const solo = r.teams === 1 || r.teams === 'two';
  const game = GAME_NAME[r.win];
  if (game) return solo ? game : `${team} ${game}`;
  if (r.win === 'teamelims') return r.teams === 1 ? 'Rumble' : `${team} Rumble`;
  if (r.win === 'elims') return r.teams === 1 ? 'Frenzy' : `${team} Frenzy`;
  if (r.win === 'time') return r.teams === 1 ? 'Showdown' : `${team} Showdown`;
  if (r.loadout === 'buildfight' && r.maxPlayers <= 4) return r.maxPlayers <= 2 ? '1v1 Build Battle' : r.teams === 2 ? 'Box Fight' : 'Build Battle';
  if (r.storm === 'zonewars') return solo ? 'Zone Wars' : `${team} Zone Wars`;
  if (r.teams === 'two') return 'Team Battle';
  if (r.maxPlayers >= 32 && r.bots >= 31 && r.teams === 1) return 'Big Battle';
  return team;
}

/**
 * A mode's auto name and tag chips: e.g. {teams 2, loot snipers, gravity 0.35, respawn 5} gives
 * 'Low-Gravity Sniper Duos with Respawn' and ['Duos', 'Snipers only', 'Low Gravity', 'Respawn'].
 * @returns {{ name: string, tags: string[] }}
 */
export function describeRules(input) {
  const r = normalizeRules(input);
  const muts = mutators(r);
  const where = areaName(r.area);
  const noun = nounOf(r);
  const loot = r.loot !== 'all' ? LOOT_ADJ[r.loot] : '';
  const respawn = r.respawn > 0 && !RESPAWN_GAMES.has(r.win) ? (r.lives > 1 ? ` with ${r.lives} Lives` : ' with Respawn') : '';
  const place = r.area.startsWith('poi:') ? ` at ${where}` : r.area.startsWith('biome:') ? ` in ${where}` : '';
  // the longest name that still fits on a tile: drop the place, then mutators, then the respawn note
  let name = '';
  for (const [nm, withRespawn, withPlace] of [[2, 1, 1], [2, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]]) {
    const words = muts.slice(0, nm).map((m) => m[0]);
    if (loot) words.push(loot);
    words.push(noun);
    name = words.join(' ') + (withRespawn ? respawn : '') + (withPlace ? place : '');
    if (name.length <= 44) break;
  }

  const game = GAME_NAME[r.win];
  const tags = [TEAM_TAG[r.teams]];
  if (game) tags.push(game);
  else if (r.win === 'elims') tags.push(`First to ${r.target}`);
  else if (r.win === 'teamelims') tags.push(`Team to ${r.target}`);
  else if (r.win === 'time') tags.push('Most points');
  if (r.loot !== 'all') tags.push(LOOT_TAG[r.loot]);
  for (const m of muts) if (!tags.includes(m[1])) tags.push(m[1]);
  if (r.respawn > 0) tags.push(r.lives > 1 ? `${r.lives} Lives` : 'Respawn');
  if (STORM_TAG[r.storm] && !tags.includes(STORM_TAG[r.storm])) tags.push(STORM_TAG[r.storm]);
  if (r.rounds > 1) tags.push(`Best of ${r.rounds}`);
  if (where) tags.push(r.area === 'random' ? 'Random Spot' : where.replace(/^the /, ''));
  return { name, tags: tags.slice(0, 7) };
}
