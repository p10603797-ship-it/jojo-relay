// XP and levels for the active player. Historically this owned the single-profile save in
// localStorage ('phortnite.profile'); now an account's stats (js/accounts/store.js) drive it and
// this is a thin wrapper over that stats object. The XP/level maths live in js/accounts/stats.js.
//   XP: 50 per elimination, a placement bonus (top 10), damage / 10, 300 for a win.
//   Level n -> n + 1 needs 600 + 60 n XP.
import { defaultStats, sanitizeStats, levelInfo as infoFor, applyAward, xpForLevel, matchXp } from './accounts/stats.js';

const KEY = 'phortnite.profile';

export { xpForLevel, matchXp }; // kept for older imports

export class Profile {
  /**
   * stats : the account's stats object (mutated in place). onSave: persists it after a match.
   * With no stats passed it falls back to the old standalone localStorage save, so a Profile still
   * works on its own (and migration can read the legacy save).
   */
  constructor(stats, onSave) {
    if (stats && typeof stats === 'object') {
      this.data = stats;
      this._onSave = typeof onSave === 'function' ? onSave : null;
    } else {
      this.data = defaultStats();
      this._onSave = null;
      try {
        const d = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (d && typeof d === 'object') this.data = sanitizeStats(d);
      } catch (e) { /* private mode or junk: start fresh */ }
    }
  }

  get level() { return this.data.level; }

  save() {
    if (this._onSave) { this._onSave(); return; }
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* private mode */ }
  }

  levelInfo() { return infoFor(this.data); }

  /**
   * Add a match. Returns { gained, lines, from, to, steps, levelUp } (steps are the XP bar stops to
   * animate). The richer stats (wins, deaths, best place, streak, playtime, per-mode) update too.
   */
  award(r) {
    const res = applyAward(this.data, r);
    this.save();
    return res;
  }
}
