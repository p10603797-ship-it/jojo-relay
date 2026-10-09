// Your numbers from one match, collected from the room's messages by the party bridge: damage and
// hits you dealt, eliminations, chests opened next to you, pieces you built, time alive, your
// place, and everyone's eliminations for the results card (top 8, MVP).
import { modeView } from '../ui/lobby.js';

export class MatchStats {
  constructor() {
    this.reset();
    this.active = false;
  }

  reset() {
    this.damage = 0;
    this.hits = 0;
    this.elims = 0;
    this.chests = 0;
    this.builds = 0;
    this.place = 0;
    this.t0 = 0;
    this.tDeath = -1;
    this.tEnd = -1;
    this.won = false;
    this.ended = false;
    this.killer = null;
    this.people = new Map(); // id -> { name, bot, kills, place }
    this.mvpId = 0;
    this.mode = '';
    this.myTeam = null;
  }

  /** A match began ('start'). */
  start(game, m) {
    this.reset();
    this.active = true;
    this.t0 = game.time;
    this.mode = modeView(game.settingsState).name;
    for (const p of game.roster.values()) this.person(p.id, p);
  }

  person(id, row) {
    let e = this.people.get(id);
    if (!e) this.people.set(id, (e = { id, name: '???', bot: false, kills: 0, place: 0 }));
    if (row) { e.name = row.name; e.bot = !!row.bot; }
    return e;
  }

  onMessage(game, m) {
    if (!this.active) return;
    const me = game.myId;
    switch (m.t) {
      case 'dmg':
        if (m.a === me && m.tg !== me && m.c !== 'storm' && m.c !== 'fall' && !game.friendly(m.tg, me)) {
          this.damage += m.amt | 0;
          this.hits++;
        }
        break;
      case 'elim': {
        const v = this.person(m.v, game.roster.get(m.v));
        v.place = m.place | 0;
        if (m.k && m.k !== m.v) {
          this.person(m.k, game.roster.get(m.k)).kills++;
          if (m.k === me) this.elims++;
        }
        if (m.v === me) {
          this.place = m.place | 0;
          if (this.tDeath < 0) this.tDeath = game.time;
        }
        break;
      }
      case 'respawn':
        if (m.id === me) this.tDeath = -1; // respawn modes: still alive at the end
        break;
      case 'b+':
        if (m.by === me) this.builds++;
        break;
      case 'chest': {
        // the room does not say who opened it: count chests that open right next to you
        const c = game.world.data.chests[m.c];
        const p = game.me && game.me.pos;
        if (c && p && game.me.alive) {
          const dx = c.x - p.x, dz = c.z - p.z;
          if (dx * dx + dz * dz < 4.5 * 4.5) this.chests++;
        }
        break;
      }
      case 'roster':
        for (const p of m.players || []) this.person(p.id, p);
        break;
      case 'win': {
        this.ended = true;
        this.tEnd = game.time;
        const myTeam = game.teamOf(me);
        this.won = !!(m.id && (m.id === me || (!m.bot && m.team !== undefined && m.team !== 0 && m.team === myTeam)));
        // Floor is Lava's clock ran out: everyone still standing survived it together
        if (!m.id && m.reason === 'survived' && game.me && game.me.alive) this.won = true;
        if (this.won) this.place = 1;
        if (!m.id && m.reason === 'survived') for (const [id, r] of game.roster) if (r.alive !== false) this.person(id, r).place = 1;
        if (m.id) this.person(m.id, game.roster.get(m.id)).place = 1;
        // still standing at the end = the winners' place
        for (const [id, r] of game.roster) {
          const e = this.person(id, r);
          if (!e.place && r.alive !== false && m.team !== undefined && r.team === m.team) e.place = 1;
        }
        if (typeof m.mvp === 'number') this.mvpId = m.mvp;
        else if (m.mvp && typeof m.mvp === 'object' && typeof m.mvp.id === 'number') this.mvpId = m.mvp.id;
        break;
      }
      default:
    }
  }

  /** Numbers for the death card. */
  snapshot(game) {
    const end = this.tDeath >= 0 ? this.tDeath : this.tEnd >= 0 ? this.tEnd : game.time;
    return { elims: this.elims, damage: Math.round(this.damage), hits: this.hits, builds: this.builds, chests: this.chests, alive: Math.max(0, end - this.t0) };
  }

  /** The results card after the match (null if no match was played since the last one). */
  results(game) {
    if (!this.active) return null;
    const s = this.snapshot(game);
    const me = game.myId;
    const list = [...this.people.values()];
    // people still standing at the end (no place yet) outlived everyone placed: they come first
    const top = list.slice().sort((a, b) => (a.place || 0) - (b.place || 0) || b.kills - a.kills).slice(0, 8)
      .map((p) => ({ name: p.name, bot: p.bot, kills: p.kills, place: p.place, me: p.id === me }));
    let mvp = this.mvpId ? this.people.get(this.mvpId) : null;
    if (!mvp) for (const p of list) if (p.kills > 0 && (!mvp || p.kills > mvp.kills)) mvp = p;
    const place = this.place || (this.ended ? 1 : 0);
    const n = list.length;
    let title = 'GOOD GAME';
    if (this.won) title = 'PHICTORY ROYALE!';
    else if (place > 0 && place <= 3 && n > 3) title = 'TOP 3!';
    else if (place > 0 && place <= 5 && n > 6) title = 'TOP 5!';
    else if (place > 0 && place <= 10 && n > 12) title = 'TOP 10!';
    return {
      ...s, mode: this.mode, place, players: n, won: this.won, title, top,
      mvp: mvp ? { name: mvp.name, kills: mvp.kills, me: mvp.id === me } : null,
    };
  }

  /** The results were shown: forget the match. */
  done() { this.active = false; }
}
