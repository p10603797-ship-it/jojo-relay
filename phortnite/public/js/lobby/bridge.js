// Game plugin for the party: lobby stage visibility, match stats, end screens, skin changes.
// See js/game/plugins.js for the hook interface.
//   - input is blanked while the stage shows (taps on the lobby never move or shoot)
//   - phases: lobby -> the stage (with the results card after a match), bus / match -> the island,
//     a win -> the winners dance on the stage under '#1 PHICTORY ROYALE'
//   - collects MatchStats from room messages; the death card shows who got you and your numbers
//   - roster changes rebuild remote players whose skin changed (Locker changes in the lobby)
//   - party messages: countdown, kicked, suggest, emote, partyend, rejoin ('resumed') and the
//     transport's '_net' events
import { MatchStats } from '../game/matchStats.js';
import { Character } from '../actors/character.js';
import { rulesFromSettings } from '../../shared/modes/rules.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Blank this frame's input in place (no allocation). */
function blank(s) {
  for (const k in s) {
    const v = s[k];
    if (typeof v === 'number') s[k] = k === 'slot' ? -1 : 0;
    else if (typeof v === 'boolean') s[k] = false;
    else if (typeof v === 'string') s[k] = null;
  }
}

function meWon(g, m) {
  return !!m && !!m.id && (m.id === g.myId || (!m.bot && m.team !== undefined && m.team !== 0 && m.team === g.teamOf(g.myId)));
}

export class PartyBridge {
  constructor(game) {
    this.game = game;
    this.app = game.app;
    this.stats = new MatchStats();
    this.bannerT = 0;
    this.winTimer = 0;
    game.partyInfo = { max: 16, cd: 0 };
  }

  get on() { return !!(this.app && this.app.lobby && this.app.stage); }

  filterInput(s) {
    if (this.app.stageOn) blank(s);
  }

  onPhase(phase, m) {
    if (!this.on) return;
    const app = this.app, g = this.game;
    clearTimeout(this.winTimer);
    if (phase === 'lobby') {
      app.stage.celebrate(null);
      app.lobby.victory(false);
      document.body.classList.remove('ended');
      if (m && m.t === 'lobby') {
        if (app.playAgainPending) {
          // solo PLAY AGAIN: the next match starts at once, no stop on the stage
          app.playAgainPending = false;
          this.stats.done();
        } else {
          app.warming = false;
          app.showStage(true);
          this.results();
        }
      } else if (!app.warming) app.showStage(true);
    } else if (phase === 'bus' || phase === 'match') {
      document.body.classList.remove('ended');
      if (m && m.t === 'start') {
        this.stats.start(g, m);
        app.lobby.hideResults();
        app.lobby.countdown(null);
        app.warming = false;
        app.showStage(false);
      } else if (m && m.t === 'welcome') {
        // joined, or came back after a reload, while a match runs
        if (m.resumed && m.me && m.me.alive) { this.revive(m); app.showStage(false); } else app.showStage(true);
      }
    } else if (phase === 'ended') {
      document.body.classList.add('ended');
      if (meWon(g, m)) {
        if (app.music) app.music.fanfare();
        // a moment of the win on the island, then the winners dance on the podium
        this.winTimer = setTimeout(() => this.celebrate(m), 2200);
      }
    }
    app.updateWake();
    app.lobby.render();
  }

  celebrate(m) {
    const g = this.game, app = this.app;
    if (g.disposed || g.phase !== 'ended') return;
    const ids = [];
    for (const p of g.roster.values()) if (!p.bot && (p.id === m.id || (m.team !== undefined && p.team === m.team))) ids.push(p.id);
    if (!ids.includes(g.myId)) ids.push(g.myId);
    app.showStage(true);
    app.stage.celebrate(ids);
    app.lobby.victory(true);
  }

  /** Back in the lobby after a match: the results card and the XP. */
  results() {
    const g = this.game, app = this.app;
    const r = this.stats.results(g);
    this.stats.done();
    if (!r) return;
    let xp = null;
    if (app.profile) {
      const before = app.profile.level;
      xp = app.profile.award(r);
      if (app.profile.level !== before) g.send({ t: 'look', lvl: app.profile.level });
    }
    app.lobby.showResults(r, xp);
  }

  onMessage(m) {
    if (!this.on) return;
    const g = this.game, app = this.app;
    this.stats.onMessage(g, m);
    switch (m.t) {
      case 'welcome':
        g.partyInfo = m.party && typeof m.party === 'object' ? m.party : { max: 16, cd: 0 };
        app.onWelcome(g, m);
        if (g.partyInfo.cd > 0 && m.phase === 'lobby') app.lobby.countdown({ s: Math.ceil(g.partyInfo.cd / 1000), ms: g.partyInfo.cd });
        break;
      case 'resumed':
        this.resumed(m);
        break;
      case 'roster':
        this.roster();
        app.lobby.render();
        break;
      case 'settings':
      case 'bots':
        app.lobby.render();
        break;
      case 'countdown':
        app.lobby.countdown(m);
        if (m.s && app.music) app.music.drumroll((m.ms || 3000) / 1000);
        break;
      case 'kicked':
        app.onKicked(g, m);
        break;
      case 'partyend':
        app.onPartyEnd(g, m);
        break;
      case 'suggest':
        if (g.leader === g.myId) app.lobby.suggest(m);
        break;
      case 'emote':
        if (g.phase === 'lobby') app.stage.emote(m.id);
        break;
      case 'note':
        if (app.stageOn && !m.storm && m.msg) app.lobby.toast(esc(m.msg), { ms: 3500 });
        break;
      case '_net':
        app.onNet(g, m);
        break;
      default:
    }
  }

  /** New names and skins from the roster: rebuild those players' models (and mine, in the lobby). */
  roster() {
    const g = this.game;
    for (const [id, row] of g.roster) {
      if (id === g.myId) continue;
      const r = g.remotes.get(id);
      if (!r || r.isBot) continue;
      if (typeof row.skin === 'number' && row.skin !== r.skin && r.setSkin) r.setSkin(row.skin);
      if (typeof row.name === 'string' && row.name !== r.name && r.setName) r.setName(row.name);
    }
    const me = g.me, row = g.roster.get(g.myId);
    if (me && row && g.phase === 'lobby' && typeof row.skin === 'number' && row.skin !== me.char.skin && !me.char.ragdoll) {
      const old = me.char;
      const c = new Character(row.skin, '', {});
      c.group.position.copy(old.group.position);
      c.group.rotation.copy(old.group.rotation);
      c.setVisible(old.visible);
      g.scene.remove(old.group);
      old.dispose();
      g.scene.add(c.group);
      me.char = c;
    }
  }

  /** Back on a new connection with the game still running: catch up on what was missed. */
  resumed(m) {
    const g = this.game, app = this.app;
    g.leader = m.leader;
    g.code = m.code;
    if (m.settings) {
      g.settingsState = m.settings;
      try { g.rules = rulesFromSettings(m.settings); } catch (e) { /* keep */ }
    }
    g.partyInfo = m.party && typeof m.party === 'object' ? m.party : g.partyInfo;
    const ids = new Set();
    for (const p of m.players || []) {
      ids.add(p.id);
      g.roster.set(p.id, { ...(g.roster.get(p.id) || {}), ...p });
      if (p.id !== g.myId) g.ensureRemote(p);
    }
    for (const [id, r] of [...g.remotes]) if (!ids.has(id)) { r.dispose(); g.remotes.delete(id); }
    for (const id of [...g.roster.keys()]) if (!ids.has(id)) g.roster.delete(id);
    // the world as the room has it now
    g.world.restoreAll();
    for (const id of m.destroyed || []) g.world.destroyObject(id, null, true);
    g.builds.clear();
    g.pendingBuilds.clear();
    for (const b of m.builds || []) g.builds.add(b);
    if (m.loot) g.loot.set(m.loot);
    for (const c of m.chests || []) g.world.setChestOpen(c, true);
    if (m.phase === 'match' && g.phase === 'bus') {
      g.phase = 'match';
      g.plug('onPhase', 'match', m);
    } else if (m.phase === 'ended' && g.phase !== 'ended') g.phase = 'ended';
    const me = g.me, s = m.me;
    if (me && s) {
      if (me.alive && !s.alive) {
        // eliminated while away
        g.onMyDeath({ t: 'elim', v: g.myId, k: 0, c: 'gun', w: '', place: (g.aliveCount || 0) + 1, x: s.x, y: s.y, z: s.z }, null);
        me.die({ x: 0, y: 2, z: 0 });
      } else if (me.alive) {
        me.hp = s.hp;
        me.sh = s.sh;
        // the bus left while we were away
        if (me.inBus && !s.inBus) g.onMessage({ t: 'forcedrop', ids: [g.myId], x: s.x, y: s.y, z: s.z });
      }
    }
    app.onWelcome(g, m);
    app.lobby.render();
    app.lobby.toast('Back in the game! 💪');
  }

  /** Back after a reload while still alive in the match (the welcome made us a spectator). */
  revive(m) {
    const g = this.game, me = g.me, s = m.me;
    if (!me) return;
    g.hud.elim(null);
    document.body.classList.remove('dead');
    const mats = (g.settingsState && g.settingsState.mats) | 0;
    if (s.inBus && g.phase === 'bus') {
      me.alive = true;
      me.inBus = true;
      me.mover.mode = 'bus';
      me.mover.setEnabled(false);
      me.char.setVisible(false);
    } else {
      me.respawn(s.x, s.y + 0.3, s.z);
      me.inBus = false;
    }
    me.hp = s.hp;
    me.sh = s.sh;
    me.infinite = false;
    me.resetInventory({ slots: [], ammo: {}, mats: { wood: mats, stone: mats, metal: mats } });
    g.spectateId = 0;
    this.app.lobby.toast('Back in the game! 💪');
  }

  onMyDeath(m) {
    if (!this.on) return;
    const g = this.game;
    const stats = this.stats.snapshot(g);
    let killer = null;
    if (m.k && m.k !== g.myId) {
      const row = g.roster.get(m.k) || {};
      const a = g.actorById(m.k);
      let dist;
      if (a && Number.isFinite(m.x)) dist = Math.hypot(a.pos.x - m.x, a.pos.y - m.y, a.pos.z - m.z);
      killer = { name: g.nameOf(m.k), skin: row.skin | 0, bot: !!row.bot, w: m.w, hs: !!m.hs, dist, hp: a ? a.hp : undefined, sh: a ? a.sh : undefined };
    }
    const es = g.hud.endscreen;
    if (es && es.enrich) es.enrich({ killer, stats });
  }

  update(dt) {
    if (!this.on || !this.app.stageOn) return;
    this.bannerT -= dt;
    if (this.bannerT <= 0) { this.bannerT = 0.5; this.app.lobby.banner(); }
  }

  dispose() {
    clearTimeout(this.winTimer);
  }
}
