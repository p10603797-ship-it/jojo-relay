// Pure, DOM-free stat + XP maths for player accounts (test/accounts.test.mjs covers it).
// Lives apart from profile.js so it imports nothing from the browser: the account store and the
// Profile both build on these functions, and Node can exercise the win/elims/place/streak maths.
//   XP: 50 per elimination, a placement bonus (top 10), damage / 10, 300 for a win (matchXp).
//   Level n -> n + 1 needs 600 + 60 n XP.

export const MAX_LEVEL = 999;
export const STATS_V = 2; // bump when the stats shape changes so old saves migrate

export const xpForLevel = (n) => 600 + 60 * n;

/** XP lines for a match result r ({elims, damage, place, won, players}). */
export function matchXp(r) {
  const lines = [];
  let total = 0;
  const add = (n, label) => { n = Math.round(n); if (n > 0) { total += n; lines.push(`${label} +${n}`); } };
  add((r.elims | 0) * 50, `${r.elims | 0} elim${(r.elims | 0) === 1 ? '' : 's'}`);
  if (r.won) add(300, 'Victory');
  // placement: better than most of the lobby (in a big match a top 10 counts)
  else if (r.place > 0 && r.place <= 10 && (!r.players || r.place <= Math.ceil(r.players / 2))) add((11 - r.place) * 15, `Placed #${r.place}`);
  add((r.damage || 0) / 10, 'Damage');
  add(25, 'Played');
  return { total, lines };
}

/** A brand-new stats object (one per account). Kept flat so the level chip reads it directly. */
export function defaultStats() {
  return {
    v: STATS_V,
    level: 1, xp: 0, total: 0, // total = lifetime XP
    matches: 0, wins: 0, elims: 0, deaths: 0,
    bestPlace: 0, // 0 = no match yet; else the best (lowest) finishing place
    playtime: 0, // seconds spent alive, summed
    modes: {}, // mode name -> times played
    streak: 0, bestStreak: 0, // current win streak and the longest ever
  };
}

const clampInt = (v, lo, hi, def) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : def);

/** Coerce anything read off disk into a valid stats object (old saves migrate forward here). */
export function sanitizeStats(d) {
  const s = defaultStats();
  if (!d || typeof d !== 'object') return s;
  s.level = clampInt(d.level, 1, MAX_LEVEL, 1);
  s.xp = clampInt(d.xp, 0, xpForLevel(s.level) - 1, 0);
  s.total = clampInt(d.total, 0, 1e12, 0);
  s.matches = clampInt(d.matches, 0, 1e8, 0);
  s.wins = clampInt(d.wins, 0, 1e8, 0);
  s.elims = clampInt(d.elims, 0, 1e9, 0);
  s.deaths = clampInt(d.deaths, 0, 1e9, 0);
  s.bestPlace = clampInt(d.bestPlace, 0, 1e6, 0);
  s.playtime = clampInt(d.playtime, 0, 1e10, 0);
  s.streak = clampInt(d.streak, 0, 1e7, 0);
  s.bestStreak = clampInt(d.bestStreak, 0, 1e7, 0);
  if (d.modes && typeof d.modes === 'object') {
    for (const k of Object.keys(d.modes)) {
      const n = clampInt(d.modes[k], 0, 1e8, 0);
      const name = typeof k === 'string' ? k.trim().slice(0, 40) : '';
      if (n > 0 && name) s.modes[name] = n;
    }
  }
  return s;
}

/** { level, xp, need, frac } for the XP bar. */
export function levelInfo(s) {
  return { level: s.level, xp: s.xp, need: xpForLevel(s.level), frac: s.level >= MAX_LEVEL ? 1 : s.xp / xpForLevel(s.level) };
}

/**
 * Record one match into the stats object (mutated in place) and return the XP animation result
 * { gained, lines, from, to, steps, levelUp } for the results card.
 *   r: { elims, damage, place, players, won, mode, alive, died }
 * steps are the XP bar stops to animate: [{ level, frac, levelUp }] (a level up fills the bar,
 * then it starts again). A win bumps the streak; any other finish resets it.
 */
export function applyAward(s, r) {
  const { total, lines } = matchXp(r);
  const from = levelInfo(s);
  s.matches++;
  if (r.won) { s.wins++; s.streak++; if (s.streak > s.bestStreak) s.bestStreak = s.streak; }
  else s.streak = 0;
  s.elims += r.elims | 0;
  if (r.died) s.deaths++;
  const place = r.won ? 1 : (r.place | 0);
  if (place > 0 && (s.bestPlace === 0 || place < s.bestPlace)) s.bestPlace = place;
  if (r.alive > 0) s.playtime += Math.round(r.alive);
  if (r.mode && typeof r.mode === 'string') { const k = r.mode.slice(0, 40); s.modes[k] = (s.modes[k] | 0) + 1; }
  s.total += total;
  // the XP bar: fill it, rolling over on each level up
  let left = total;
  const steps = [];
  while (left > 0 && s.level < MAX_LEVEL) {
    const need = xpForLevel(s.level) - s.xp;
    if (left >= need) {
      left -= need;
      steps.push({ level: s.level, frac: 1, levelUp: true });
      s.level++;
      s.xp = 0;
    } else {
      s.xp += left;
      left = 0;
      steps.push({ level: s.level, frac: s.xp / xpForLevel(s.level), levelUp: false });
    }
  }
  return { gained: total, lines, from, to: levelInfo(s), steps, levelUp: steps.some((x) => x.levelUp) };
}

/**
 * Add XP outside a match (the admin's GIVE XP, js/admin/client.js): it counts towards the level and
 * total like match XP, rolling over levels, but no match, win or streak. Returns the levels gained.
 */
export function addXp(s, n) {
  let left = Math.max(0, Math.min(1e7, Math.floor(Number(n) || 0)));
  const from = s.level;
  s.total += left;
  while (left > 0 && s.level < MAX_LEVEL) {
    const need = xpForLevel(s.level) - s.xp;
    if (left >= need) { left -= need; s.level++; s.xp = 0; } else { s.xp += left; left = 0; }
  }
  return s.level - from;
}

// ------------------------------------------------------------------ derived numbers (the STATS card)

/** Kills / deaths, shown to 2 decimals; a death-free run shows the kill count itself. */
export function kd(s) {
  if (!s.deaths) return (s.elims || 0).toFixed(s.elims ? 2 : 0);
  return (s.elims / s.deaths).toFixed(2);
}

/** Win rate as a 0-100 integer percent. */
export function winRate(s) {
  if (!s.matches) return 0;
  return Math.round((s.wins / s.matches) * 100);
}

/** The most-played mode's name, or '' when nothing has been played. */
export function favoriteMode(s) {
  let best = '', n = 0;
  for (const k of Object.keys(s.modes || {})) if (s.modes[k] > n) { n = s.modes[k]; best = k; }
  return best;
}

/** 'h m' / 'm s' label for the playtime seconds. */
export function playtimeLabel(secs) {
  secs = Math.max(0, secs | 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
