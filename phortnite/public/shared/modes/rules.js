// Mode rules: the schema every game mode is made of. Shared by the Room (Node server, P2P host,
// solo) and the client, so it must stay free of DOM / Node specific APIs.
//
// FROZEN AND APPEND-ONLY: mode codes (shared/modes/code.js) store the INDEX of each option, so an
// option list may only grow at its end, and fields may only be added after the last one.
//
// A rules object is a plain object with every RULE_FIELDS key. RULE_DEFAULTS is today's Battle
// Royale. normalizeRules() turns anything (a mode's deltas, a custom mode from a friend, junk) into
// a valid rules object.

/** @typedef {{ key: string, options: ReadonlyArray<any>, def: any }} RuleField */

const field = (key, options, def = options[0]) => Object.freeze({ key, options: Object.freeze(options), def });

/** Area: the whole island, its centre, a random place, one named place or one biome. */
export const AREA_RE = /^(full|center|random|poi:[\w' -]{1,32}|biome:[a-z]{2,12})$/;

/** @type {ReadonlyArray<RuleField>} the order is part of the mode-code format */
export const RULE_FIELDS = Object.freeze([
  field('teams', [1, 2, 3, 4, 'two', 'humans'], 1), // players per team; 'two' = two big teams; 'humans' = all humans vs bots
  field('bots', [0, 1, 3, 5, 7, 9, 11, 15, 19, 23, 27, 31], 19),
  field('maxPlayers', [32, 24, 16, 8, 4, 2]),
  field('botSkill', ['normal', 'easy', 'hard', 'mixed']),
  field('spawn', ['bus', 'sky', 'ground']),
  field('respawn', [0, 3, 5, 8, 12]), // seconds; 0 = no respawn
  field('lives', [1, 2, 3, 5, 0]), // 0 = unlimited
  field('respawnKeep', [false, true]), // keep your loot when you respawn
  field('win', ['last', 'elims', 'teamelims', 'time', 'gungame', 'infection', 'koth', 'juggernaut', 'lava', 'hideseek']), // a key of GAMES
  field('target', [0, 5, 10, 15, 20, 30, 50, 100]), // score to win (0 = none)
  field('timeLimit', [0, 180, 300, 420, 600, 900]), // seconds (0 = none)
  field('rounds', [1, 3, 5]),
  field('storm', ['classic', 'fast', 'slow', 'none', 'final', 'zonewars']),
  Object.freeze({ key: 'area', options: Object.freeze(['full', 'center', 'random']), def: 'full', special: true }), // or 'poi:<name>' / 'biome:<key>' (AREA_RE)
  field('loot', ['all', 'ars', 'smgs', 'shotguns', 'snipers', 'pistols', 'rockets', 'explosive', 'pickaxe']),
  field('rarity', ['normal', 'boosted', 'legendary', 'common']),
  field('floorLoot', [true, false]),
  field('chests', [true, false]),
  field('heals', ['normal', 'extra', 'none']),
  field('loadout', ['none', 'pool', 'buildfight', 'zonewars', 'pickaxe']),
  field('ammo', ['normal', 'infinite']),
  field('build', ['on', 'off', 'infinite']),
  field('mats', [0, 100, 200, 500, 999]), // start materials of each kind
  field('harvest', [1, 2, 3, 0]), // harvesting yield multiplier
  field('hp', [100, 50]),
  field('shield', [100, 50, 0]), // start shield
  field('siphon', [50, 0, 25, 100]),
  field('gravity', [1, 0.5, 0.35, 1.5]),
  field('speed', [1, 1.25, 1.5, 0.8]),
  field('jump', [1, 1.5, 2]),
  field('dmg', [1, 0.5, 1.5, 2]),
  field('oneShot', [false, true]),
  field('headOnly', [false, true]),
  field('bigHead', [false, true]),
  field('fallDamage', [true, false]),
  field('mystery', [false, true]),
  field('pvp', [true, false]),
]);

const FIELD = Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f]));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Today's Battle Royale: every field at its default. */
export const RULE_DEFAULTS = Object.freeze(Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f.def])));

/** The two modes from before rules existed: room settings {mode: 'ffa' | 'squad'}. */
export const LEGACY_MODES = Object.freeze({
  ffa: Object.freeze({}),
  squad: Object.freeze({ teams: 'humans' }),
});

/** The option nearest to a number (ties go to the option listed first), or undefined if none is a number. */
function snap(options, v) {
  let best, bd = Infinity;
  for (const o of options) {
    if (typeof o !== 'number') continue;
    const d = Math.abs(o - v);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function cleanValue(f, v) {
  if (f.key === 'area') return typeof v === 'string' && AREA_RE.test(v) ? v : f.def;
  const i = f.options.indexOf(v);
  if (i >= 0) return f.options[i]; // the option itself (so -0 comes back as 0)
  if (typeof v === 'number' && Number.isFinite(v)) {
    const s = snap(f.options, v);
    if (s !== undefined) return s;
  }
  return f.def;
}

function knownGame(games, k) {
  if (Array.isArray(games)) return games.includes(k);
  if (games instanceof Set) return games.has(k);
  return typeof games === 'object' && hasOwn(games, k);
}

/**
 * A fresh, valid rules object from anything (pure and idempotent):
 * - unknown keys are dropped, missing keys get their default;
 * - a value that is not one of its field's options falls back to the default, except that
 *   numbers snap to the nearest numeric option;
 * - area must match AREA_RE;
 * - opts.games (the keys of GAMES, as an array, a Set or an object): a win that is not one of
 *   them becomes 'last';
 * - consistency: respawn 0 means lives 1; elims / teamelims / koth with target 0 get 15 / 50 / 100;
 *   time, infection and hideseek with timeLimit 0 get 300; teams 'humans' needs at least 1 bot.
 * @param {any} input
 * @param {{ games?: string[] | Set<string> | object }} [opts]
 */
export function normalizeRules(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const r = {};
  for (const f of RULE_FIELDS) r[f.key] = hasOwn(src, f.key) ? cleanValue(f, src[f.key]) : f.def;
  if (opts && opts.games && r.win !== 'last' && !knownGame(opts.games, r.win)) r.win = 'last';
  if (r.respawn === 0) r.lives = 1;
  if (r.target === 0) {
    if (r.win === 'elims') r.target = 15;
    else if (r.win === 'teamelims') r.target = 50;
    else if (r.win === 'koth') r.target = 100;
  }
  // these are won by lasting the clock: they always have one
  if ((r.win === 'time' || r.win === 'infection' || r.win === 'hideseek') && r.timeLimit === 0) r.timeLimit = 300;
  if (r.teams === 'humans' && r.bots < 1) r.bots = 1;
  return r;
}

/** Rules of a room settings object: settings.rules, or the legacy {mode: 'ffa' | 'squad'}. */
export function rulesFromSettings(settings, opts) {
  const s = settings && typeof settings === 'object' ? settings : {};
  if (s.rules && typeof s.rules === 'object') return normalizeRules(s.rules, opts);
  return normalizeRules(typeof s.mode === 'string' && hasOwn(LEGACY_MODES, s.mode) ? LEGACY_MODES[s.mode] : {}, opts);
}

/**
 * A stable string for a set of rules: one base-36 digit per field (its option index, in
 * RULE_FIELDS order), then '|' and the area. Equal rules give equal fingerprints.
 */
export function rulesFingerprint(rules) {
  const r = normalizeRules(rules);
  let s = '';
  for (const f of RULE_FIELDS) {
    if (f.key === 'area') continue;
    s += f.options.indexOf(r[f.key]).toString(36);
  }
  return `${s}|${r.area}`;
}

/** The RULE_FIELDS entry for a key (or undefined). */
export function ruleField(key) { return typeof key === 'string' && hasOwn(FIELD, key) ? FIELD[key] : undefined; }
