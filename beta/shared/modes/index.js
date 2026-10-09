// The mode registry: every playable mode, core modes first, then the curated catalogue.
//
// Entry: {
//   id: string (unique, used in {t:'mode', id}), name, emoji, color: '#rrggbb',
//   cat: 'br' | 'team' | 'party' | 'mutators' | 'builders' | 'practice' | 'places',
//   desc: one sentence, players: short tile text such as '1-16' or '2-4',
//   tags: string[] (chips such as 'Duos', 'No Build', 'Respawn'),
//   requires?: a GAMES key the mode needs (the mode is hidden while that game is missing),
//   rules: deltas from RULE_DEFAULTS (shared/modes/rules.js)
// }
import { normalizeRules } from './rules.js';
import { CATALOG } from './catalog.js';

export const CORE_MODES = [
  {
    id: 'solo', name: 'Solo', emoji: '👑', color: '#ffd23f', cat: 'br',
    desc: 'Drop from the bus, loot, build and be the last one standing.', players: '1-16', tags: ['Battle Royale', 'Bots'],
    rules: {},
  },
  {
    id: 'squadbots', name: 'Friends vs Bots', emoji: '🤝', color: '#3ea4ff', cat: 'team',
    desc: 'Everyone in the party on one team against a crowd of bots.', players: '2-16', tags: ['Team Up', 'Bots'],
    rules: { teams: 'humans', bots: 15 },
  },
  {
    id: 'duos', name: 'Duos', emoji: '👯', color: '#5ad13a', cat: 'br',
    desc: 'Battle Royale in teams of two. Bots fill the empty spots.', players: '1-16', tags: ['Battle Royale', 'Duos'],
    rules: { teams: 2 },
  },
  {
    id: 'playground', name: 'Playground', emoji: '🛝', color: '#bd52ff', cat: 'practice',
    desc: 'No storm, no damage: build, explore and try every gun with infinite materials and ammo.', players: '1-16', tags: ['Creative', 'Respawn', 'No Storm'],
    rules: {
      spawn: 'ground', respawn: 3, lives: 0, storm: 'none', build: 'infinite', ammo: 'infinite', pvp: false, bots: 0,
      loadout: 'pool', rarity: 'legendary',
    },
  },
];

/** Core modes, then catalogue modes (a catalogue entry whose id is already taken is dropped). */
export const MODES = (() => {
  const out = [...CORE_MODES];
  const ids = new Set(out.map((m) => m.id));
  for (const m of CATALOG) {
    if (!m || typeof m.id !== 'string' || ids.has(m.id)) continue;
    ids.add(m.id);
    out.push(m);
  }
  return out;
})();

const BY_ID = new Map(MODES.map((m) => [m.id, m]));

/** The mode entry with this id, or null. */
export function findMode(id) { return BY_ID.get(id) || null; }

/** The full, normalized rules of a mode (opts as for normalizeRules), or null for an unknown id. */
export function modeRules(id, opts) {
  const m = findMode(id);
  return m ? normalizeRules(m.rules, opts) : null;
}

/** What the lobby shows about a mode: room settings.info. */
export function modeInfo(entry) {
  return { name: entry.name, emoji: entry.emoji, color: entry.color, desc: entry.desc, tags: [...(entry.tags || [])] };
}

const TEAM_TAG = { 2: 'Duos', 3: 'Trios', 4: 'Squads', two: 'Two Teams', humans: 'Friends vs Bots' };
const WIN_TAG = { elims: 'Elim Race', teamelims: 'Team Elims', time: 'Timed', gungame: 'Gun Game', infection: 'Infection', koth: 'King of the Hill', juggernaut: 'Juggernaut', lava: 'Floor is Lava' };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A few short chips describing a set of (normalized) rules, e.g. ['Duos', 'No Build', 'Respawn']. */
export function modeTags(r) {
  const tags = [];
  if (has(TEAM_TAG, r.teams)) tags.push(TEAM_TAG[r.teams]);
  if (has(WIN_TAG, r.win)) tags.push(WIN_TAG[r.win]);
  if (r.build === 'off') tags.push('No Build');
  else if (r.build === 'infinite') tags.push('Infinite Build');
  if (r.respawn > 0) tags.push('Respawn');
  if (r.storm === 'none') tags.push('No Storm');
  if (r.gravity < 1) tags.push('Low Gravity');
  if (r.oneShot) tags.push('One Shot');
  if (r.bigHead) tags.push('Big Heads');
  if (!r.pvp) tags.push('No Damage');
  if (r.rounds > 1) tags.push(`Best of ${r.rounds}`);
  return tags.slice(0, 5);
}
