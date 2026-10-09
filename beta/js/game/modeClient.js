// Game plugin for game modes: mode banner, mode HUD, respawn overlay, role looks, KOTH hill.
// See js/game/plugins.js for the hook interface. Reads what the mode engine provides:
// game.rules, game.settingsState.info, game.teams (id -> {name, color}), game.roleOf(id), and the
// room's messages: ms {sc, goal, tl (seconds left), g (the game's hud JSON), rs {pid: secs}},
// role {id, role}, lo {id, lo}, respawn {id, …}, mut {rules}.
// Everything visual is created lazily, so a plain Battle Royale costs nothing extra.
import * as THREE from 'three';
import { GAMES } from '../../shared/modes/games/index.js';
import { GUN_LADDER, HILL_MOVE_MS } from '../../shared/modes/games/party.js';
import { MODES, findMode } from '../../shared/modes/index.js';
import { rulesFingerprint } from '../../shared/modes/rules.js';
import { describeRules } from '../../shared/modes/code.js';
import { WEAPONS } from '../../shared/constants.js';
import { ModeHud, HillView, LavaView, TEAM_LOOK, clock } from './modeViews.js';

const LOOK_EVERY = 0.25; // s between checks that every character wears the right look
const HUD_EVERY = 0.1; // s between mode HUD refreshes (writes are cached on top of that)
const BIG_HEAD = 2.2; // matches the Big Head hitbox (combatant.js / remote.js)
/** Games that dress players up, and the looks they use. */
const ROLE_GAMES = { infection: ['zombie'], juggernaut: ['jugg'], hideseek: ['seeker'] };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const _p = new THREE.Vector3();

/** What you have to do, in one line, for the mode banner. */
export function objective(r) {
  switch (r.win) {
    case 'elims': return `First to ${r.target} eliminations wins!`;
    case 'teamelims': return `First team to ${r.target} eliminations wins!`;
    case 'time': return `Most eliminations in ${clock(r.timeLimit || 300)} wins!`;
    case 'gungame': return 'An elimination with every gun. A pickaxe elimination wins!';
    case 'infection': return `Zombies infect survivors. Survive ${clock(r.timeLimit || 300)}!`;
    case 'koth': return `Stand in the glowing hill. First to ${r.target || 100} wins!`;
    case 'juggernaut': return `Take down the Juggernaut to become it. ${r.target || 100} points wins!`;
    case 'lava': return 'The floor is lava! Climb high and build up!';
    case 'hideseek': return `Hide from the seekers for ${clock(r.timeLimit || 300)}!`;
    default: return r.teams === 1 ? 'Be the last one standing!' : 'Be the last team standing!';
  }
}

function isTeamGame(win) {
  if (own(GAMES, win) && GAMES[win].teamGame !== undefined) return !!GAMES[win].teamGame;
  return win === 'teamelims' || win === 'koth';
}

export class ModeClient {
  constructor(game) {
    this.game = game;
    this.view = null; // ModeHud, made at the first match
    this.hill = null;
    this.lava = null;
    this.active = false;
    this.ms = null;
    this.msAt = 0;
    this.deadAt = 0;
    this.lookT = 0;
    this.hudT = 0;
    this.busTimer = 0;
    this.cls = {};
    this.seaY = null;
    this.hillY = { x: NaN, z: NaN, y: 0 };
    this.sea = undefined; // world / water setSeaLevel (map-engine), looked up once
    this.koth = null; // game.mapExtras.koth while there is a hill
    this.warmed = false;
    this.blind = false; // Hide & Seek: the local seeker's head start (input blanked, eyes closed)
  }

  get rules() { return this.game.rules || {}; }

  // ------------------------------------------------------------------ hooks
  onMessage(m) {
    switch (m.t) {
      case 'ms': this.setMs(m); break;
      case 'welcome':
        if (m.ms) this.setMs(m.ms);
        if (m.roles) this.loadRoles(m.roles);
        break;
      case 'role': this.onRole(m); break;
      case 'respawn':
        if (m.id === this.game.myId) this.deadAt = 0;
        this.lookT = 0;
        break;
      case 'lo': if (m.id === this.game.myId) this.onMyLoadout(m.lo); break;
      case 'mut': this.lookT = 0; this.applyClasses(); break;
      default: break;
    }
  }

  onPhase(phase, m) {
    if (phase === 'lobby') { this.stop(); return; }
    if (phase === 'bus' || phase === 'match') {
      if (!this.active) this.start(phase, m);
      return;
    }
    if (phase === 'ended') {
      this.deadAt = 0;
      if (this.view) { this.view.respawn(-1); this.view.pointTo(null); }
    }
  }

  /** Hide & Seek: a seeker waits, eyes closed, while the others hide. */
  filterInput(s) {
    if (!this.blind) return;
    for (const k in s) {
      if (typeof s[k] === 'number') s[k] = 0;
      else if (typeof s[k] === 'boolean') s[k] = false;
    }
  }

  onMyDeath() {
    if (this.active) this.deadAt = performance.now();
  }

  update(dt) {
    if (!this.active) return;
    this.lookT -= dt;
    if (this.lookT <= 0) { this.lookT = LOOK_EVERY; this.reconcile(); }
    const g = this.ms && this.ms.g;
    // King of the Hill: the ring and beam, and the minimap ring
    const h = g && g.hill;
    if (h && Number.isFinite(h.x) && Number.isFinite(h.z)) {
      if (!this.hill) this.hill = new HillView(this.game.scene);
      const color = this.hillColor(h);
      this.hill.set(h, this.groundY(h.x, h.z), color);
      this.hill.update(dt, !!h.ct);
      this.mapHill(h, color);
    } else {
      if (this.hill) this.hill.set(null);
      this.mapHill(null);
    }
    // Floor is Lava: the water turns to lava and rises (or a lava sheet when the water can't)
    const lv = g && typeof g.lava === 'number' ? g.lava : null;
    this.setLava(lv, dt);
  }

  hud(dt) {
    if (!this.active || !this.view) return;
    this.pointToHill();
    this.hudT -= dt;
    if (this.hudT > 0) return;
    this.hudT = HUD_EVERY;
    this.renderHud();
  }

  dispose() {
    this.stop();
    if (this.view) { this.view.dispose(); this.view = null; }
    if (this.hill) { this.hill.dispose(); this.hill = null; }
    if (this.lava) { this.lava.dispose(); this.lava = null; }
  }

  // ------------------------------------------------------------------ match start / end
  start(phase, m) {
    this.active = true;
    if (!(m && m.t === 'welcome' && m.ms)) this.ms = null;
    this.deadAt = 0;
    this.lookT = 0;
    this.hudT = 0;
    if (!this.view && typeof document !== 'undefined') this.view = new ModeHud();
    this.applyClasses();
    this.banner(phase);
    const roles = ROLE_GAMES[this.rules.win];
    if (roles) setTimeout(() => this.prewarmLooks(roles), 0);
  }

  /** Compile the role look shaders now (at the start) rather than when the first zombie shows up. */
  prewarmLooks(roles) {
    const g = this.game, app = g.app, me = g.me;
    if (this.warmed || !this.active || !app || !app.renderer || !me || !me.char || !me.char.setRoleLook) return;
    this.warmed = true;
    const c = me.char, prev = c.roleLook, vis = c.group.visible;
    c.group.visible = true;
    try {
      for (const role of roles) { c.setRoleLook(role); app.renderer.compile(g.scene, g.camera); }
    } catch (e) { /* only a warm-up */ }
    c.setRoleLook(prev);
    c.group.visible = vis;
  }

  stop() {
    const was = this.active;
    this.active = false;
    this.ms = null;
    this.deadAt = 0;
    clearTimeout(this.busTimer);
    if (typeof document !== 'undefined') this.applyClasses();
    this.blind = false;
    if (this.view) {
      this.view.blindfold(-1);
      this.view.show(false);
      this.view.teammates(null);
      this.view.respawn(-1);
      this.view.pointTo(null);
    }
    if (this.hill) this.hill.set(null);
    this.mapHill(null);
    this.setLava(null, 0);
    if (was) this.resetLooks();
  }

  banner(phase) {
    const g = this.game;
    const r = this.rules;
    const st = g.settingsState || {};
    // the room's mode; without one (older rooms), the registry mode that plays the same
    let mode = st.modeId ? findMode(st.modeId) : null;
    if (!mode && !(st.info && st.info.name)) {
      const fp = rulesFingerprint(r);
      mode = MODES.find((x) => rulesFingerprint(x.rules) === fp) || null;
    }
    const name = (st.info && st.info.name) || (mode && mode.name) || describeRules(r).name;
    const emoji = (st.info && st.info.emoji) || (mode && mode.emoji) || '';
    if (g.hud && g.hud.big) g.hud.big(`${emoji ? `${emoji} ` : ''}${esc(name.toUpperCase())}<small>${esc(objective(r))}</small>`);
    clearTimeout(this.busTimer);
    if (phase === 'bus') {
      // then the usual bus call-out, once the banner has had its moment
      this.busTimer = setTimeout(() => {
        if (this.active && g.phase === 'bus' && g.me && g.me.inBus && !g.disposed) g.hud.big('THE BUS IS LEAVING!<small>Jump out when you\'re over a good spot</small>');
      }, 2300);
    }
  }

  /** Body classes the stylesheet uses to hide what a mode does not have (build buttons, storm pill). */
  applyClasses() {
    const r = this.rules, on = this.active;
    const want = {
      'mode-nobuild': on && r.build === 'off',
      'mode-nostorm': on && r.storm === 'none',
      'mode-respawn': on && r.respawn > 0,
      'mode-score': on && r.win !== 'last',
    };
    for (const k in want) {
      if (this.cls[k] === want[k]) continue;
      this.cls[k] = want[k];
      document.body.classList.toggle(k, want[k]);
    }
  }

  // ------------------------------------------------------------------ messages
  /** Keep the latest mode state; a message may carry only the fields that changed. */
  setMs(m) {
    if (!this.ms) this.ms = {};
    for (const k in m) if (k !== 't') this.ms[k] = m[k];
    this.msAt = performance.now();
    this.hudT = 0;
  }

  loadRoles(roles) {
    const g = this.game;
    if (!g.roles) return;
    const list = Array.isArray(roles) ? roles : Object.entries(roles);
    for (const [id, role] of list) if (role) g.roles.set(+id, role);
  }

  onRole(m) {
    const g = this.game;
    if (g.roles) { if (m.role) g.roles.set(m.id, m.role); else g.roles.delete(m.id); }
    // the infected change team (2): keep the local roster in step so friendly fire is right
    if (this.rules.win === 'infection' && m.role === 'zombie') { const row = g.roster && g.roster.get(m.id); if (row) row.team = 2; }
    const a = g.actorById && g.actorById(m.id);
    if (a && a.char && a.char.setRoleLook) a.char.setRoleLook(this.active ? m.role || null : null);
    if (m.id === g.myId && this.active && g.hud) {
      if (m.role === 'zombie') g.hud.big('🧟 YOU\'RE A ZOMBIE!<small>Get the survivors with your pickaxe</small>');
      else if (m.role === 'jugg') g.hud.big('🦾 YOU\'RE THE JUGGERNAUT!<small>Everyone is coming for you</small>');
    }
  }

  /** A new loadout mid-match (gun game rung, Juggernaut kit): hold the new gun. */
  onMyLoadout(lo) {
    const me = this.game.me;
    if (!me || !lo || !Array.isArray(lo.slots) || !me.inv) return;
    if (lo.slots.length && me.inv.slots[1] && me.select) me.select(1);
    else if (!lo.slots.length && me.select) me.select(0);
    if (this.rules.win === 'gungame' && this.game.hud) {
      const k = lo.slots.length ? lo.slots[0].k : 'pickaxe';
      this.game.hud.notice(k === 'pickaxe' ? '⛏ LAST RUNG: PICKAXE! ⛏' : `⬆ NEXT GUN: ${(WEAPONS[k] || { name: k }).name.toUpperCase()}`, false, 2.5);
    }
  }

  // ------------------------------------------------------------------ looks
  /** Every character wears its role look, big head (Big Head mode) and team-coloured name tag. */
  reconcile() {
    const g = this.game, r = this.rules;
    if (!g.actors) return;
    const big = r.bigHead ? BIG_HEAD : 1;
    const team = r.teams !== 1 && g.teamOf ? g.teamOf(g.myId) : null;
    const tagColor = team !== null ? this.teamColor(team) : null;
    for (const a of g.actors()) {
      const c = a.char;
      if (!c || !c.setRoleLook) continue;
      const role = g.roleOf ? g.roleOf(a.id) : null;
      if (c.roleLook !== role) c.setRoleLook(role);
      if (c.headScale !== big) c.setHeadScale(big);
      if (tagColor && a !== g.me && c.tag && c.tag.visible && g.teamOf(a.id) === team) c.setTagColor(tagColor);
    }
    this.applyClasses();
  }

  resetLooks() {
    const g = this.game;
    if (!g.actors) return;
    for (const a of g.actors()) {
      const c = a.char;
      if (!c || !c.setRoleLook) continue;
      c.setRoleLook(null);
      c.setHeadScale(1);
      if (c.tag && a !== g.me) c.setTagColor(a.isBot ? '#ffd27a' : '#ffffff');
    }
  }

  // ------------------------------------------------------------------ teams
  teamLook(id) {
    const t = this.game.teams && this.game.teams.get ? this.game.teams.get(id) : null;
    if (t && t.color) return t;
    const n = Number(id) || 0;
    const i = (n > 999 ? n : Math.max(0, n - 1)) % TEAM_LOOK.length;
    return { id, name: TEAM_LOOK[i][0], color: TEAM_LOOK[i][1] };
  }

  teamColor(id) { return this.teamLook(id).color; }

  hillColor(h) {
    if (h.ct) return '#ffffff';
    return h.owner ? this.teamColor(h.owner) : '#ffd23f';
  }

  groundY(x, z) {
    const c = this.hillY;
    if (c.x !== x || c.z !== z) {
      const d = this.game.world && this.game.world.data;
      c.x = x; c.z = z;
      c.y = d && d.heightAt ? d.heightAt(x, z) : 0;
    }
    return c.y;
  }

  mapHill(h, color) {
    const ex = this.game.mapExtras;
    if (!ex) return;
    if (!h) {
      if (ex.koth) delete ex.koth;
      this.koth = null;
      return;
    }
    if (!this.koth) this.koth = { rings: [{ x: 0, z: 0, r: 9, c: '#fff' }], pins: [{ x: 0, z: 0, c: '#fff', label: 'HILL' }] };
    const ring = this.koth.rings[0], pin = this.koth.pins[0];
    ring.x = pin.x = h.x;
    ring.z = pin.z = h.z;
    ring.r = Math.max(6, h.r || 9);
    ring.c = pin.c = color;
    ex.koth = this.koth;
  }

  setLava(level, dt) {
    if (level === null && this.seaY === null && !(this.lava && this.lava.mesh.visible)) return;
    const g = this.game;
    if (this.sea === undefined) {
      const w = g.world, water = w && w.water;
      this.sea = w && typeof w.setSeaLevel === 'function' ? w.setSeaLevel.bind(w)
        : water && typeof water.setSeaLevel === 'function' ? water.setSeaLevel.bind(water) : null;
    }
    const sea = this.sea;
    if (sea) {
      // map-engine's water can rise and glow itself
      const y = level === null ? null : Math.round(level * 20) / 20;
      if (y === this.seaY) return;
      this.seaY = y;
      sea(y === null ? 0 : y, y === null ? 'water' : 'lava');
      return;
    }
    if (level === null) { if (this.lava) this.lava.update(dt, null); return; }
    if (!this.lava) this.lava = new LavaView(g.scene, ((g.world && g.world.data && g.world.data.size) || 640) * 1.6);
    this.lava.update(dt, level);
  }

  // ------------------------------------------------------------------ HUD
  /** Seconds left of a time sent in ms (counted down locally between messages). */
  left(secs) {
    if (typeof secs !== 'number') return null;
    const s = secs > 7200 ? secs / 1000 : secs; // a value in ms
    return s - (performance.now() - this.msAt) / 1000;
  }

  renderHud() {
    const g = this.game, r = this.rules, v = this.view, ms = this.ms;
    const gh = (ms && ms.g) || {};
    const sc = ms && Array.isArray(ms.sc) ? ms.sc : [];
    const goal = (ms && ms.goal) || r.target || 0;
    const me = g.me;
    const myId = g.myId;
    const win = r.win;
    const inPlay = g.phase === 'bus' || g.phase === 'match' || g.phase === 'ended';
    v.show(inPlay && (win !== 'last' || r.timeLimit > 0));
    const tl = ms ? this.left(ms.tl) : null;
    v.clockText(tl !== null && r.timeLimit > 0 ? clock(tl) : '');

    // scores: two teams as a bar, otherwise the top 3 (teams or players) with your place
    let bar = null, rows = null, meText = '';
    const teamGame = isTeamGame(win);
    if (win !== 'last' && win !== 'infection' && win !== 'lava') {
      if (teamGame) {
        const ids = this.teamIds(sc);
        const myTeam = g.teamOf ? g.teamOf(myId) : myId;
        const scoreOf = (id) => { const e = sc.find((x) => x[0] === id); return e ? e[1] : 0; };
        if (ids.length === 2) {
          bar = ids.map((id) => ({ ...this.teamLook(id), score: scoreOf(id), mine: id === myTeam }));
        } else {
          const ranked = ids.map((id) => [id, scoreOf(id)]).sort((p, q) => q[1] - p[1]);
          rows = ranked.slice(0, 3).map(([id, n]) => ({ name: this.teamLook(id).name, score: n, color: this.teamColor(id), me: id === myTeam }));
          const i = ranked.findIndex((e) => e[0] === myTeam);
          if (i >= 3) meText = `YOUR TEAM <b>#${i + 1}</b> · ${ranked[i][1]}`;
        }
      } else {
        rows = sc.slice(0, 3).map(([id, n]) => ({
          name: id === myId ? 'You' : g.nameOf ? g.nameOf(id) : String(id), score: n, color: this.teamColor(g.teamOf ? g.teamOf(id) : id), me: id === myId,
        }));
        const i = sc.findIndex((e) => e[0] === myId);
        if (i < 0 || i >= 3) meText = `YOU <b>${i < 0 ? '—' : `#${i + 1}`}</b> · ${i < 0 ? 0 : sc[i][1]}`;
      }
    }
    v.bar(bar && bar[0], bar && bar[1], goal);
    v.top(rows, meText);

    // the game's own line
    let line = '', cls = '';
    let lv = -1;
    if (win === 'gungame') {
      lv = 0;
      if (Array.isArray(gh.lv)) for (let i = 0; i + 1 < gh.lv.length; i += 2) if (gh.lv[i] === myId) lv = gh.lv[i + 1];
      lv = Math.max(0, Math.min(GUN_LADDER.length - 1, lv | 0));
    } else if (win === 'infection') {
      const zombie = g.roleOf && g.roleOf(myId) === 'zombie';
      line = `🧑 <b>${gh.s ?? '–'}</b> SURVIVORS · 🧟 <b>${gh.z ?? '–'}</b> ZOMBIES<br><small>${zombie ? 'You are a ZOMBIE: get them!' : 'Stay alive!'}</small>`;
      cls = zombie ? 'zombie' : '';
    } else if (win === 'koth' && gh.hill) {
      const h = gh.hill;
      const who = h.ct ? 'CONTESTED!' : h.owner ? `${esc(this.teamLook(h.owner).name.toUpperCase())} holds it` : 'Nobody there';
      const moves = clock((h.prog || 0) * (HILL_MOVE_MS / 1000) - (performance.now() - this.msAt) / 1000);
      let dist = '';
      if (me && me.alive && me.pos) {
        const d = Math.hypot(me.pos.x - h.x, me.pos.z - h.z);
        dist = d <= (h.r || 9) ? ' · <b>YOU\'RE IN!</b>' : ` · ${Math.round(d)} m away`;
      }
      line = `<span class="mh-crown" style="color:${this.hillColor(h)}">👑</span> HILL: ${who}<br><small>moves in ${moves}${dist}</small>`;
      cls = h.ct ? 'contested' : '';
    } else if (win === 'juggernaut') {
      const j = gh.j | 0;
      const score = (sc.find((e) => e[0] === j) || [0, 0])[1];
      line = j === myId ? `🦾 <b>YOU</b> are the Juggernaut! · ${score}/${goal || 100}`
        : j ? `🦾 <b>${esc(g.nameOf ? g.nameOf(j) : j)}</b> is the Juggernaut · ${score}/${goal || 100}` : '🦾 Picking a new Juggernaut…';
      cls = j === myId ? 'jugg' : '';
    } else if (win === 'hideseek') {
      const seeker = g.roleOf && g.roleOf(myId) === 'seeker';
      const hs = (gh.hs | 0) > 0 ? Math.max(0, Math.ceil(gh.hs - (performance.now() - this.msAt) / 1000)) : 0;
      line = `🙈 <b>${gh.h ?? '–'}</b> HIDING · 👀 <b>${gh.s ?? '–'}</b> SEEKING<br><small>${hs > 0 ? `Seekers come out in ${hs}…` : seeker ? 'Find them! One tap is enough.' : 'Stay hidden!'}</small>`;
      cls = seeker ? 'seeker' : '';
      this.blind = seeker && hs > 0 && !!(me && me.alive);
      if (this.view) this.view.blindfold(this.blind ? hs : -1);
    } else if (win === 'lava' && typeof gh.lava === 'number') {
      const above = me && me.alive && me.pos ? me.pos.y - gh.lava : null;
      line = `🌋 LAVA <b>${gh.lava.toFixed(1)} m</b>${above !== null ? `<br><small>${above < 0.2 ? 'YOU\'RE IN THE LAVA! CLIMB!' : `you are ${above.toFixed(1)} m above it`}</small>` : ''}`;
      cls = above !== null && above < 2.5 ? 'danger' : '';
    }
    if (win !== 'hideseek' && this.blind) { this.blind = false; v.blindfold(-1); }
    v.ladder(GUN_LADDER, lv);
    v.line(line, cls);

    // teammates (team modes)
    let mates = null;
    if (r.teams !== 1 && g.roster && g.teamOf && g.phase !== 'lobby') {
      const myTeam = g.teamOf(myId);
      mates = [];
      const rs = ms && ms.rs;
      for (const p of g.roster.values()) {
        if (p.id === myId || p.spec || g.teamOf(p.id) !== myTeam) continue;
        const a = g.actorById ? g.actorById(p.id) : null;
        const alive = a ? !!a.alive : p.alive !== false;
        const wait = rs && rs[p.id] !== undefined ? this.left(rs[p.id]) : null;
        mates.push({
          name: p.name, hp: alive && a ? a.hp : 0, sh: alive && a ? a.sh : 0, alive, color: this.teamColor(myTeam),
          note: !alive && wait !== null && wait > 0 ? `${Math.ceil(wait)}s` : '',
        });
      }
    }
    v.teammates(mates);

    // respawn countdown while I'm down
    let left = -1, total = r.respawn || 3;
    if (me && !me.alive && g.phase !== 'ended' && g.phase !== 'lobby') {
      const rs = ms && ms.rs;
      if (rs && rs[myId] !== undefined) {
        left = Math.max(0, this.left(rs[myId]));
        total = Math.max(total, left);
      } else if (this.deadAt && r.respawn > 0 && r.lives === 0) {
        left = Math.max(0, r.respawn - (performance.now() - this.deadAt) / 1000);
      }
    }
    const sub = g.roleOf && g.roleOf(myId) === 'zombie' ? 'You come back as a zombie!' : r.spawn === 'sky' ? 'You\'ll drop in from the sky' : 'Get ready!';
    v.respawn(left, total, sub);
  }

  /** Team ids to show: the room's teams, else whoever has scored, plus mine. */
  teamIds(sc) {
    const g = this.game;
    const ids = [];
    if (g.teams && g.teams.size) for (const id of g.teams.keys()) ids.push(id);
    for (const [id] of sc) if (!ids.includes(id)) ids.push(id);
    const mine = g.teamOf ? g.teamOf(g.myId) : null;
    if (mine !== null && !ids.includes(mine) && ids.length < 2) ids.push(mine);
    return ids;
  }

  /** An arrow at the screen edge toward the hill while it is off screen. */
  pointToHill() {
    const v = this.view, g = this.game;
    const h = this.ms && this.ms.g && this.ms.g.hill;
    const me = g.me;
    if (!h || !me || !me.alive || me.inBus || !g.camera || typeof innerWidth === 'undefined') { v.pointTo(null); return; }
    _p.set(h.x, this.groundY(h.x, h.z) + 2, h.z).project(g.camera);
    const behind = _p.z > 1;
    if (!behind && Math.abs(_p.x) < 0.88 && Math.abs(_p.y) < 0.82) { v.pointTo(null); return; }
    let nx = _p.x, ny = _p.y;
    if (behind) { nx = -nx; ny = -ny; }
    if (Math.abs(nx) < 1e-3 && Math.abs(ny) < 1e-3) ny = -1;
    const ang = Math.atan2(-ny, nx); // screen space: y down
    const W = innerWidth, H = innerHeight;
    const rx = W / 2 - 70, ry = H / 2 - 90;
    const d = Math.hypot(me.pos.x - h.x, me.pos.z - h.z);
    v.pointTo(W / 2 + Math.cos(ang) * rx, H / 2 + Math.sin(ang) * ry, ang, d);
  }
}
