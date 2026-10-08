// Local XP and levels (localStorage 'phortnite.profile'). Nothing to trust or sync: it is shown on
// your nameplate (hello.lvl / look) and fills up on the results card after every match.
//   XP: 50 per elimination, a placement bonus (top 10), damage / 10, 300 for a win.
//   Level n -> n + 1 needs 600 + 60 n XP.
const KEY = 'phortnite.profile';
const MAX_LEVEL = 999;

export const xpForLevel = (n) => 600 + 60 * n;

/** XP lines for a match result r ({elims, damage, place, won}). */
export function matchXp(r) {
  const lines = [];
  let total = 0;
  const add = (n, label) => { n = Math.round(n); if (n > 0) { total += n; lines.push(`${label} +${n}`); } };
  add((r.elims | 0) * 50, `${r.elims | 0} elim${r.elims === 1 ? '' : 's'}`);
  if (r.won) add(300, 'Victory');
  else if (r.place > 0 && r.place <= 10) add((11 - r.place) * 15, `Top ${r.place <= 5 ? 5 : 10}`);
  add((r.damage || 0) / 10, 'Damage');
  add(25, 'Played');
  return { total, lines };
}

export class Profile {
  constructor() {
    this.data = { v: 1, level: 1, xp: 0, total: 0, matches: 0, wins: 0, elims: 0 };
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && typeof d === 'object') {
        const n = (v, a, b, def) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(a, Math.min(b, Math.floor(v))) : def);
        this.data.level = n(d.level, 1, MAX_LEVEL, 1);
        this.data.xp = n(d.xp, 0, xpForLevel(this.data.level) - 1, 0);
        this.data.total = n(d.total, 0, 1e9, 0);
        this.data.matches = n(d.matches, 0, 1e7, 0);
        this.data.wins = n(d.wins, 0, 1e7, 0);
        this.data.elims = n(d.elims, 0, 1e8, 0);
      }
    } catch (e) { /* private mode or junk: start fresh */ }
  }

  get level() { return this.data.level; }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* private mode */ }
  }

  levelInfo() {
    const d = this.data;
    return { level: d.level, xp: d.xp, need: xpForLevel(d.level), frac: d.level >= MAX_LEVEL ? 1 : d.xp / xpForLevel(d.level) };
  }

  /**
   * Add a match. Returns { gained, lines, from, to, steps } where steps are the XP bar stops to
   * animate: [{ level, frac, levelUp }] (a level up fills the bar, then it starts again).
   */
  award(r) {
    const { total, lines } = matchXp(r);
    const d = this.data;
    const from = this.levelInfo();
    d.matches++;
    if (r.won) d.wins++;
    d.elims += r.elims | 0;
    d.total += total;
    let left = total;
    const steps = [];
    while (left > 0 && d.level < MAX_LEVEL) {
      const need = xpForLevel(d.level) - d.xp;
      if (left >= need) {
        left -= need;
        steps.push({ level: d.level, frac: 1, levelUp: true });
        d.level++;
        d.xp = 0;
      } else {
        d.xp += left;
        left = 0;
        steps.push({ level: d.level, frac: d.xp / xpForLevel(d.level), levelUp: false });
      }
    }
    this.save();
    return { gained: total, lines, from, to: this.levelInfo(), steps, levelUp: steps.some((s) => s.levelUp) };
  }
}
