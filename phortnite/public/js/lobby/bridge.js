// Game plugin for the party: lobby stage visibility, match stats, end screens, skin changes.
// See js/game/plugins.js for the hook interface.
//   - input is blanked while the stage shows (taps on the lobby never move or shoot)
//   - phases: lobby -> the stage (with the results card after a match), bus / match -> the island,
//     a win -> the winners dance on the stage under '#1 PHICTORY ROYALE'
//   - collects MatchStats from room messages; the death card shows who got you and your numbers
//   - roster changes rebuild remote players whose skin changed (Locker changes in the lobby)
//   - party messages: countdown, kicked, suggest, emote, partyend, rejoin ('resumed') and the
//     transport's '_net' events
// (no three.js / Rapier imports here: game plugins load in Node too, for the contract tests)
import { MatchStats } from '../game/matchStats.js';
import { rulesFromSettings, normalizeRules } from '../../shared/modes/rules.js';
import { cleanRow } from '../game/roster.js';

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
  if (m && !m.id && m.reason === 'survived') return !!(g.me && g.me.alive); // Floor is Lava: everyone still standing
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
        // Discover, the creator and lobby sheets (a member card, the locker) never stay over the bus
        app.lobby.closeSheets();
        if (app.ui && app.ui.modalOpen && app.ui.modalOpen()) app.ui.closeModal();
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
    const shared = !m.id && m.reason === 'survived';
    for (const p of g.roster.values()) if (!p.bot && (p.id === m.id || (m.team && p.team === m.team) || (shared && p.alive !== false))) ids.push(p.id);
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
        this.syncCountdown(m);
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
      const c = new old.constructor(row.skin, '', {}); // a Character, like the one it replaces
      c.group.position.copy(old.group.position);
      c.group.rotation.copy(old.group.rotation);
      c.setVisible(old.visible);
      g.scene.remove(old.group);
      old.dispose();
      g.scene.add(c.group);
      me.char = c;
    }
  }

  /**
   * Back on a new connection with the game still running (a Wi-Fi blip): catch up on what was
   * missed. Like a reload's welcome (Game.on_welcome) the match's own rules (a mystery mutator may
   * have changed them), teams, roles and mode state count, then the mode's looks and loadouts are
   * applied again to me and the bots this page runs.
   */
  resumed(m) {
    const g = this.game, app = this.app;
    // the match started (or I respawned) while I was away: this game is in the wrong place (the
    // lobby, or my death card), so rebuild it from the room's state, the same way a full welcome
    // does ('fresh'): its onPhase revives me in the bus or at my spot (revive)
    const s0 = m.me, me0 = g.me;
    const liveNow = m.phase === 'bus' || m.phase === 'match';
    const missedStart = liveNow && (g.phase === 'lobby' || g.phase === 'ended');
    const missedRespawn = liveNow && !!me0 && !!s0 && s0.alive && !me0.alive;
    if ((missedStart || missedRespawn) && typeof app.onNet === 'function') {
      app.onNet(g, { t: '_net', state: 'fresh', msg: { ...m, t: 'welcome' } });
      return;
    }
    g.leader = m.leader;
    g.code = m.code;
    if (m.settings) g.settingsState = m.settings;
    if (m.rules || m.settings) {
      try { g.rules = m.rules ? normalizeRules(m.rules) : rulesFromSettings(m.settings); } catch (e) { /* keep */ }
    }
    g.partyInfo = m.party && typeof m.party === 'object' ? m.party : g.partyInfo;
    // a countdown that started, or ended (s:0 missed), while I was away
    this.syncCountdown(m);
    const live = m.phase !== 'lobby';
    if (Array.isArray(m.teams) && typeof g.setTeams === 'function') g.setTeams(m.teams);
    if (m.area !== undefined) g.area = m.area && live && g.rules.area !== 'full' ? m.area : null;
    const ids = new Set();
    for (const p0 of m.players || []) {
      const p = cleanRow(p0);
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
    // roles given or taken while we were away (a survivor turned zombie, a new Juggernaut) go
    // through the usual 'role' handling (looks, team, 'YOU'RE A ZOMBIE!'); the mode state as 'ms'
    const myRole = g.roleOf ? g.roleOf(g.myId) : null;
    this.catchUpRoles(m.roles);
    if (m.ms && typeof m.ms === 'object') g.onMessage({ ...m.ms, t: 'ms' });
    else g.modeState = {};
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
        // the room's loadout for me: where the mode hands out every gun (nothing to loot) it is
        // exactly what I should hold; elsewhere only a new role (zombie claws) replaces my loot
        const roleNow = g.roleOf ? g.roleOf(g.myId) : null;
        const noLoot = g.rules.floorLoot === false && g.rules.chests === false;
        if (live && s.lo && typeof g.giveLoadout === 'function' && (noLoot || roleNow !== myRole)) g.giveLoadout(me, s.lo);
      }
    }
    if (live && typeof g.applyMode === 'function') {
      if (me && me.alive) g.applyMode(me);
      for (const b of g.bots ? g.bots.values() : []) g.applyMode(b);
    }
    app.onWelcome(g, m);
    app.lobby.render();
    app.lobby.toast('Back in the game! 💪');
  }

  /** The lobby's 3-2-1 as the room has it now (welcome / resumed party.cd): shown, or cleared. */
  syncCountdown(m) {
    const cd = m.party && typeof m.party === 'object' ? m.party.cd : 0;
    if (cd > 0 && m.phase === 'lobby') this.app.lobby.countdown({ s: Math.ceil(cd / 1000), ms: cd });
    else this.app.lobby.countdown(null);
  }

  /** Roles as the room has them now ([[id, role]]): every change goes through Game's 'role' handling. */
  catchUpRoles(list) {
    const g = this.game;
    if (!g.roles) return;
    const now = new Map();
    for (const e of Array.isArray(list) ? list : []) if (Array.isArray(e) && e[1]) now.set(e[0], e[1]);
    for (const id of [...g.roles.keys()]) if (!now.has(id)) g.onMessage({ t: 'role', id, role: null });
    for (const [id, role] of now) if (g.roles.get(id) !== role) g.onMessage({ t: 'role', id, role });
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
    // the mode's loadout when it has one (the room keeps it), else the start materials
    if (s.lo && typeof g.giveLoadout === 'function') g.giveLoadout(me, s.lo);
    else me.resetInventory({ slots: [], ammo: {}, mats: { wood: mats, stone: mats, metal: mats } });
    if (typeof g.applyMode === 'function') g.applyMode(me);
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
