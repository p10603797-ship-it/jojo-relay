// The lobby screen over the stage (iPad first: every tap target is at least 56 px).
//   top bar      PLAY tab, level chip, locker, help, settings, full screen
//   left rail    party cards (crown, READY, level), '+' INVITE slots, JOIN A FRIEND, REJOIN, LEAVE
//   bottom right the mode card with CHANGE (Discover), PLAY for the leader / READY for members
//   bottom left  EMOTE, WARM UP
// plus the 3-2-1 countdown, the 'match in progress' banner, the victory overlay, the results card,
// toasts and the connection status pill. Everything is rendered from the Game's party state when
// it changes (no per-frame work here; the stage moves the nameplates).
import { SKINS } from '../../shared/constants.js';
import { MODES, findMode, modeInfo } from '../../shared/modes/index.js';
import { rulesFromSettings } from '../../shared/modes/rules.js';
import { openDiscover } from './discover.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TEAM_COLORS = ['#3ea4ff', '#ff4d4d', '#5ad13a', '#ffd23f', '#bd52ff', '#ff8a00', '#2fe0c8', '#ff6fb1'];
const TEAM_TAG = { 1: 'Solo', 2: 'Duos', 3: 'Trios', 4: 'Squads', two: '2 Teams', humans: 'Friends vs Bots' };
const CAT_NAMES = { br: 'Battle Royale', team: 'Team Up', party: 'Party Games', mutators: 'Crazy Mutators', builders: 'Builders', practice: 'Practice', places: 'Places' };

/** What the mode card shows for room settings: {name, emoji, color, desc, tags (≤ 3 chips)}. */
export function modeView(settings) {
  const s = settings || {};
  let info = s.info && typeof s.info === 'object' ? s.info : null;
  if (!info) {
    const e = findMode(s.modeId) || findMode(s.mode === 'squad' ? 'squadbots' : 'solo');
    info = e ? modeInfo(e) : { name: 'Battle Royale', emoji: '👑', color: '#ffd23f', desc: '', tags: [] };
  }
  let r;
  try { r = rulesFromSettings(s); } catch (e) { r = { teams: 1, build: 'on', respawn: 0, bots: 19 }; }
  const tags = [TEAM_TAG[r.teams] || 'Solo'];
  if (r.build === 'off') tags.push('No Build'); else if (r.build === 'infinite') tags.push('Infinite Build');
  if (r.respawn > 0) tags.push('Respawn');
  const bots = s.modeId || s.rules ? r.bots : s.bots ?? r.bots;
  if (tags.length < 3 && bots > 0) tags.push(`${bots} bot${bots === 1 ? '' : 's'}`);
  const name = info.name || 'Battle Royale';
  return { name, emoji: info.emoji || '🎮', color: info.color || '#ffd23f', desc: info.desc || '', tags: tags.filter((t) => t !== name).slice(0, 3) };
}

/**
 * Lobby team colour for each human (in join order), from the rules: teams of N fill in join order,
 * 'two' splits the party, 'humans' is one team; free-for-all uses each skin's colour.
 */
export function teamColors(humans, settings) {
  let r;
  try { r = rulesFromSettings(settings || {}); } catch (e) { r = { teams: 1 }; }
  const out = new Map();
  const n = humans.length;
  humans.forEach((p, i) => {
    let c;
    if (r.teams === 'humans') c = TEAM_COLORS[0];
    else if (r.teams === 'two') c = TEAM_COLORS[i < Math.ceil(n / 2) ? 0 : 1];
    else if (typeof r.teams === 'number' && r.teams > 1) c = TEAM_COLORS[Math.floor(i / r.teams) % TEAM_COLORS.length];
    else c = (SKINS[p.skin] || SKINS[0]).accent;
    out.set(p.id, c);
  });
  return out;
}

export class LobbyUi {
  constructor(app) {
    this.app = app;
    this.root = $('#lobby');
    this.root.innerHTML = `
      <div class="lb-top">
        <div class="lb-logo">PHORTNITE</div>
        <button class="lb-tab sel">PLAY</button>
        <div class="lb-spacer"></div>
        <div class="lb-level" title="Your level"><b class="lb-lv">1</b><div class="lb-xp"><i></i></div></div>
        <button class="lb-icon lb-locker" aria-label="Locker">👕</button>
        <button class="lb-icon lb-help" aria-label="How to play">?</button>
        <button class="lb-icon lb-gear" aria-label="Settings">⚙</button>
        <button class="lb-icon lb-fs" aria-label="Full screen">⛶</button>
      </div>
      <div class="lb-rail">
        <div class="lb-phead"><span class="lb-ptitle">PARTY</span><span class="lb-code"></span></div>
        <div class="lb-cards"></div>
        <button class="lb-btn lb-join">JOIN A FRIEND</button>
        <button class="lb-btn lb-rejoin hidden"></button>
        <button class="lb-btn lb-leave hidden">LEAVE PARTY</button>
      </div>
      <div class="lb-bl">
        <button class="lb-btn lb-emote">💃 EMOTE</button>
        <button class="lb-btn lb-warm">🏝️ WARM UP</button>
      </div>
      <div class="lb-br">
        <div class="lb-mode">
          <div class="lb-memoji"></div>
          <div class="lb-mtxt"><div class="lb-mname"></div><div class="lb-mtags"></div></div>
          <button class="lb-change">CHANGE</button>
        </div>
        <button class="lb-play">PLAY</button>
        <div class="lb-psub"></div>
      </div>
      <div class="lb-banner hidden"><span class="lb-btext"></span><button class="lb-spec">SPECTATE</button></div>
      <div class="lb-count hidden"><div class="lb-cnum"></div><div class="lb-csub">Get ready to drop!</div><button class="lb-cancel">CANCEL</button></div>
      <div class="lb-victory hidden"><div class="lb-v1">#1</div><div class="lb-v2">PHICTORY ROYALE</div><div class="lb-confetti"></div></div>
      <div class="lb-results hidden"></div>`;
    this.el = {};
    for (const k of ['code', 'cards', 'join', 'rejoin', 'leave', 'memoji', 'mname', 'mtags', 'mode', 'change', 'play', 'psub', 'banner', 'btext', 'spec',
      'count', 'cnum', 'cancel', 'victory', 'results', 'lv', 'xp', 'emote', 'warm', 'ptitle']) this.el[k] = $(`.lb-${k}`, this.root);
    this.el.xp = $('.lb-xp i', this.root);
    this.cache = {};
    const confetti = $('.lb-confetti', this.root);
    const colors = ['#ffd23f', '#ff4d4d', '#3ea4ff', '#5ad13a', '#bd52ff', '#ff8a00', '#ffffff'];
    for (let i = 0; i < 36; i++) {
      const d = document.createElement('i');
      d.style.cssText = `left:${(i * 2.83) % 100}%;background:${colors[i % colors.length]};animation-delay:${((i * 0.37) % 2.4).toFixed(2)}s;animation-duration:${(2.6 + (i % 5) * 0.35).toFixed(2)}s`;
      confetti.appendChild(d);
    }
    this.toasts = $('#toasts');
    this.status = $('#netstatus');
    // portrait: the EMOTE / WARM UP row sits above the mode card + PLAY, whatever their height
    const br = $('.lb-br', this.root);
    if (br && typeof ResizeObserver === 'function') {
      new ResizeObserver(() => this.root.style.setProperty('--brh', `${Math.ceil(br.offsetHeight)}px`)).observe(br);
    }
    this.bind();
  }

  bind() {
    const app = this.app;
    const on = (el, fn) => el.addEventListener('click', (e) => { e.stopPropagation(); app.sfx.ui(); fn(e); });
    on($('.lb-locker', this.root), () => app.ui.lockerModal());
    on($('.lb-help', this.root), () => app.ui.helpModal());
    on($('.lb-gear', this.root), () => app.ui.settingsModal());
    on($('.lb-fs', this.root), () => app.ui.toggleFullscreen());
    on(this.el.join, () => app.invite.openJoin());
    on(this.el.rejoin, () => app.rejoin());
    on(this.el.leave, () => app.leaveParty());
    on(this.el.emote, () => app.emote());
    on(this.el.warm, () => app.warmUp(true));
    on(this.el.change, () => this.changeMode());
    on(this.el.mode, () => this.changeMode());
    on(this.el.play, () => this.play());
    on(this.el.cancel, () => app.game && app.game.send({ t: 'cancel' }));
    on(this.el.spec, () => app.spectate());
    on($('.lb-level', this.root), () => app.ui.profileModal && app.ui.profileModal());
    this.el.cards.addEventListener('click', (e) => {
      const card = e.target.closest('[data-act]');
      if (!card) return;
      app.sfx.ui();
      if (card.dataset.act === 'invite') app.invite.openInvite();
      else this.memberTap(+card.dataset.id);
    });
    // nameplates on the stage: your own renames you, others give the leader kick / promote
    app.stage.plates.addEventListener('click', (e) => {
      const plate = e.target.closest('.plate[data-id]');
      if (plate) { app.sfx.ui(); this.memberTap(+plate.dataset.id); }
    });
    for (const el of [this.root, app.stage.plates, this.toasts, this.status]) {
      el.addEventListener('pointerdown', (e) => { if (e.target !== el || el === this.root) e.stopPropagation(); });
    }
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('onstage', on);
    if (on) this.render();
  }

  get visible() { return !this.root.classList.contains('hidden'); }

  /** The game's party state: humans (join order), me, leader, settings, extra party info. */
  state() {
    const g = this.app.game;
    if (!g) return null;
    const humans = [...g.roster.values()].filter((p) => !p.bot).sort((a, b) => a.id - b.id);
    return {
      g, humans, me: g.myId, leader: g.leader, isLeader: g.leader === g.myId, settings: g.settingsState || {},
      phase: g.phase, kind: this.app.partyKind(), code: g.code, max: (g.partyInfo && g.partyInfo.max) || 16,
    };
  }

  set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  /** Refresh everything from the game (cheap: only changed parts touch the DOM). */
  render() {
    const S = this.state();
    if (!S) return;
    const app = this.app;
    const colors = teamColors(S.humans, S.settings);
    // stage: you first, then the leader, then the rest in join order
    const order = S.humans.slice().sort((a, b) => (b.id === S.me) - (a.id === S.me) || (b.id === S.leader) - (a.id === S.leader) || a.id - b.id);
    const inMatch = S.phase !== 'lobby';
    if (inMatch) this.closeSheets();
    app.stage.setParty(order.slice(0, 4).map((p) => ({
      id: p.id, name: p.name, skin: p.skin, lvl: p.lvl || 1, ready: !!p.ready, leader: p.id === S.leader, me: p.id === S.me,
      away: !!p.away, color: colors.get(p.id), inMatch: inMatch && p.id !== S.me && !p.away && p.alive !== false && !p.spec,
    })), Math.max(0, order.length - 4));
    // party title + code
    const solo = S.kind === 'solo';
    this.set('code', solo ? '' : S.code, (v) => { this.el.code.textContent = v ? `CODE ${v}` : ''; });
    this.set('ptitle', solo ? 'PARTY' : `PARTY ${S.humans.length}/${S.max}`, (v) => { this.el.ptitle.textContent = v; });
    // cards
    const cards = order.map((p) => {
      const skin = SKINS[p.skin] || SKINS[0];
      const tag = p.away ? '<span class="lc-st away">…</span>' : p.id === S.leader ? '<span class="lc-st crown">♛</span>' : p.ready ? '<span class="lc-st ok">✓</span>' : '<span class="lc-st">…</span>';
      return `<button class="lc${p.id === S.me ? ' me' : ''}" data-act="member" data-id="${p.id | 0}"><i style="background:${skin.outfit};box-shadow:inset 0 -6px 0 ${skin.accent}"></i><span class="lc-name">${esc(p.name)}${p.id === S.me ? ' <small>(you)</small>' : ''}</span><span class="lc-lv">${(p.lvl | 0) || 1}</span>${tag}</button>`;
    });
    const free = Math.max(0, Math.min(S.max, 4) - order.length);
    for (let i = 0; i < free; i++) cards.push('<button class="lc invite" data-act="invite"><b>+</b><span class="lc-name">INVITE</span></button>');
    this.set('cards', cards.join(''), (v) => { this.el.cards.innerHTML = v; });
    this.set('leave', solo, (v) => this.el.leave.classList.toggle('hidden', v));
    const rj = app.rejoinInfo();
    this.set('rejoin', rj ? rj.label : '', (v) => { this.el.rejoin.classList.toggle('hidden', !v); this.el.rejoin.textContent = v; });
    // mode card
    const mv = modeView(S.settings);
    this.set('mode', `${mv.emoji}|${mv.name}|${mv.tags.join('·')}|${mv.color}`, () => {
      this.el.memoji.textContent = mv.emoji;
      this.el.mname.textContent = mv.name;
      this.el.mname.classList.toggle('long', mv.name.length > 14);
      this.el.mtags.innerHTML = mv.tags.map((t) => `<span>${esc(t)}</span>`).join('');
      this.el.mode.style.setProperty('--mc', mv.color);
    });
    this.set('change', S.isLeader ? 'CHANGE' : 'SUGGEST', (v) => { this.el.change.textContent = v; });
    // PLAY / READY
    const others = S.humans.filter((p) => p.id !== S.leader && !p.away);
    const ready = others.filter((p) => p.ready).length;
    const meRow = S.humans.find((p) => p.id === S.me);
    const counting = !!this.cdEnds;
    let play, sub = '', cls = '';
    if (inMatch) { play = 'IN MATCH'; cls = 'off'; sub = ''; }
    else if (S.isLeader) {
      play = counting ? 'STARTING…' : 'PLAY';
      cls = counting ? 'off' : '';
      if (others.length && ready < others.length && !counting) sub = `${ready + 1}/${others.length + 1} ready – start anyway?`;
      else if (others.length && !counting) sub = 'Everyone is ready!';
    } else {
      const r = !!(meRow && meRow.ready);
      play = r ? '✓ READY' : 'READY UP';
      cls = r ? 'ready' : 'member';
      sub = counting ? '' : `Waiting for ${esc((S.humans.find((p) => p.id === S.leader) || {}).name || 'the leader')} to start…`;
    }
    this.set('play', `${play}|${cls}`, () => { this.el.play.textContent = play; this.el.play.className = `lb-play ${cls}`; });
    this.set('psub', sub, (v) => { this.el.psub.textContent = v; });
    this.set('warm', inMatch ? 'off' : 'on', (v) => { this.el.warm.disabled = v === 'off'; this.el.emote.disabled = v === 'off'; });
    // level chip
    const pr = app.profile;
    if (pr) {
      const L = pr.levelInfo();
      this.set('lv', L.level, (v) => { this.el.lv.textContent = v; });
      this.set('xp', Math.round(L.frac * 100), (v) => { this.el.xp.style.width = `${v}%`; });
    }
    this.banner();
  }

  /** 'Match in progress · 7 left · SPECTATE' while the stage shows during a match. */
  banner() {
    const g = this.app.game;
    const on = !!(g && this.visible && (g.phase === 'bus' || g.phase === 'match'));
    const text = on ? `⚔️ Match in progress · ${g.aliveCount || 0} left` : '';
    this.set('banner', text, (v) => { this.el.banner.classList.toggle('hidden', !v); this.el.btext.textContent = v; });
  }

  play() {
    const S = this.state();
    if (!S || S.phase !== 'lobby') return;
    if (S.isLeader) {
      if (this.cdEnds) return;
      this.app.play();
    } else {
      const meRow = S.humans.find((p) => p.id === S.me);
      S.g.send({ t: 'ready', on: !(meRow && meRow.ready) });
    }
  }

  /** Forget any countdown without rendering (a party switch: the next Game is not up yet). */
  resetCountdown() {
    clearInterval(this.cdTimer);
    this.cdEnds = 0;
    this.el.count.classList.add('hidden');
  }

  /** Discover / the creator (and its sheets) step aside: a match is starting or running. */
  closeSheets() {
    if (this.discover && this.discover.open) { try { this.discover.close(); } catch (e) { /* gone */ } }
    this.discover = null;
  }

  /** {t:'countdown', s, ms}: big 3-2-1 over the stage; s 0 clears it. */
  countdown(m) {
    clearInterval(this.cdTimer);
    if (!m || !m.s) {
      this.cdEnds = 0;
      this.el.count.classList.add('hidden');
      this.render();
      return;
    }
    // everyone sees the 3-2-1 (a member browsing Discover would miss the bus)
    this.closeSheets();
    this.cdEnds = performance.now() + (m.ms || m.s * 1000);
    const S = this.state();
    this.el.cancel.classList.toggle('hidden', !(S && S.isLeader));
    this.el.count.classList.remove('hidden');
    let last = -1;
    const tick = () => {
      const left = this.cdEnds - performance.now();
      const n = Math.max(1, Math.ceil(left / 1000));
      if (left <= 0) {
        this.el.cnum.textContent = 'GO!';
        // a 'start' (or the s:0 cancel) that never came: never lock PLAY until a reload
        const g = this.app.game;
        if (left < -2500 && (!g || g.phase === 'lobby')) this.countdown(null);
        return;
      }
      if (n !== last) {
        last = n;
        this.el.cnum.textContent = n;
        this.el.cnum.classList.remove('pop');
        void this.el.cnum.offsetWidth;
        this.el.cnum.classList.add('pop');
        this.app.sfx.ui('click');
        if (this.app.music) this.app.music.tick(n);
      }
    };
    tick();
    this.cdTimer = setInterval(tick, 100);
    this.render();
  }

  /** The leader gets 'Mia wants Gun Game' with PICK. */
  suggest(m) {
    const g = this.app.game;
    if (!g) return;
    const who = g.nameOf(m.from);
    const mode = findMode(m.id);
    const name = mode ? `${mode.emoji} ${mode.name}` : m.id;
    this.toast(`<b>${esc(who)}</b> wants <b>${esc(name)}</b>`, {
      action: 'PICK', ms: 8000,
      onAction: () => { if (this.app.game) this.app.game.send({ t: 'mode', id: m.id }); },
    });
  }

  /** A short message at the top; opts {action, onAction, ms, kind}. */
  toast(html, opts = {}) {
    const d = document.createElement('div');
    d.className = `toast ${opts.kind || ''}`;
    d.innerHTML = `<span>${html}</span>`;
    if (opts.action) {
      const b = document.createElement('button');
      b.textContent = opts.action;
      b.addEventListener('click', (e) => { e.stopPropagation(); d.remove(); opts.onAction && opts.onAction(); });
      d.appendChild(b);
    }
    d.addEventListener('click', () => d.remove());
    this.toasts.appendChild(d);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    setTimeout(() => d.remove(), opts.ms || 4500);
    return d;
  }

  /** The connection pill: text, or '' to hide. */
  netStatus(text) {
    this.set('net', text || '', (v) => {
      this.status.classList.toggle('hidden', !v);
      this.status.innerHTML = v ? `<i class="spin"></i><span>${esc(v)}</span>` : '';
    });
  }

  /** Victory: '#1 PHICTORY ROYALE' with confetti over the dancing winners. */
  victory(on) {
    this.el.victory.classList.toggle('hidden', !on);
    // the moment belongs to the winners: the lobby panels step aside
    this.root.classList.toggle('celebrate', !!on);
  }

  memberTap(id) {
    const S = this.state();
    if (!S) return;
    const app = this.app;
    const p = S.humans.find((x) => x.id === id);
    if (!p) return;
    if (id === S.me) { app.ui.renameModal(); return; }
    const skin = SKINS[p.skin] || SKINS[0];
    const lead = S.isLeader && S.phase === 'lobby' && !p.away;
    // a P2P party runs on its host's page: the host can be made leader again, never kicked
    const host = !!(S.g.partyInfo && S.g.partyInfo.host && p.id === S.g.partyInfo.host);
    app.ui.modal(`<h2 class="mem-h"><i style="background:${skin.outfit}"></i>${esc(p.name)}</h2>
      <p class="mem-sub">Level ${(p.lvl | 0) || 1} · ${esc(skin.name)}${p.id === S.leader ? ' · ♛ Party leader' : ''}${host ? ' · 🏠 Host' : ''}${p.ready ? ' · ✓ Ready' : ''}</p>
      <div class="sheet-btns">
        ${lead ? `<button class="btn yellow big m-promote">♛ MAKE LEADER</button>${host ? '' : '<button class="btn big m-kick">KICK FROM PARTY</button>'}` : ''}
        <button class="btn blue big m-close">OK</button>
      </div>`, (b) => {
      const pr = $('.m-promote', b), k = $('.m-kick', b);
      if (pr) pr.addEventListener('click', () => { app.ui.closeModal(); app.game && app.game.send({ t: 'promote', id }); });
      if (k) k.addEventListener('click', () => { app.ui.closeModal(); app.game && app.game.send({ t: 'kick', id }); });
      $('.m-close', b).addEventListener('click', () => app.ui.closeModal());
    });
  }

  /** CHANGE: the Discover screen (mode-catalog), or a simple list of every mode until it exists. */
  changeMode() {
    const S = this.state();
    if (!S || S.phase !== 'lobby' || this.cdEnds) return;
    const g = S.g;
    const onPick = (pick) => {
      if (!pick || !this.app.game) return;
      if (pick.id) this.app.game.send({ t: 'mode', id: pick.id });
      else if (pick.custom) this.app.game.send({ t: 'mode', custom: pick.custom, name: pick.name });
    };
    const onSuggest = (id) => { if (this.app.game) { this.app.game.send({ t: 'suggest', id }); this.toast('Suggested to the party leader 👍'); } };
    let h = null;
    this.closeSheets();
    try { h = openDiscover(this.app, { isLeader: S.isLeader, current: g.settingsState, onPick, onSuggest }); } catch (e) { console.error('discover', e); h = null; }
    this.discover = h;
    if (h) return;
    this.modeSheet(S.isLeader, onPick, onSuggest);
  }

  modeSheet(isLeader, onPick, onSuggest) {
    const app = this.app;
    const cur = (app.game && app.game.settingsState && app.game.settingsState.modeId) || '';
    const groups = new Map();
    for (const m of MODES) {
      if (!groups.has(m.cat)) groups.set(m.cat, []);
      groups.get(m.cat).push(m);
    }
    let html = `<h2>${isLeader ? 'PICK A MODE' : 'SUGGEST A MODE'}</h2>`;
    if (!isLeader) html += '<p class="mem-sub">The party leader picks the mode. Tap one to suggest it.</p>';
    for (const [cat, list] of groups) {
      html += `<h3>${esc(CAT_NAMES[cat] || cat)}</h3><div class="mode-tiles">${list.map((m) => `<button class="mtile${m.id === cur ? ' sel' : ''}" data-id="${esc(m.id)}" style="--mc:${esc(m.color)}"><b>${esc(m.emoji)}</b><span class="mt-name">${esc(m.name)}</span><span class="mt-desc">${esc(m.desc)}</span></button>`).join('')}</div>`;
    }
    app.ui.modal(html, (b) => {
      b.querySelectorAll('.mtile').forEach((t) => t.addEventListener('click', () => {
        app.sfx.ui();
        app.ui.closeModal();
        if (isLeader) onPick({ id: t.dataset.id }); else onSuggest(t.dataset.id);
      }));
    });
  }

  /**
   * After a match: place, stats, XP, MVP and the top 8. r = MatchStats.results(); xp = profile award.
   */
  showResults(r, xp) {
    if (!r) return;
    const tile = (n, l) => `<div class="rs-tile"><b>${esc(n)}</b><span>${esc(l)}</span></div>`;
    const mins = Math.floor(r.alive / 60), secs = String(Math.floor(r.alive % 60)).padStart(2, '0');
    // no placings (the leader ended the match, a timed mode): the list is just who did what
    const placed = r.top.some((x) => x.place);
    const top = r.top.slice(0, 8).map((x) => `<li class="${x.me ? 'me' : ''}${placed ? '' : ' np'}">${placed ? `<b>${x.place ? `#${x.place | 0}` : ''}</b>` : ''}<span>${esc(x.name)}${x.bot ? ' <small>bot</small>' : ''}</span><em>${x.kills | 0} ✖</em></li>`).join('');
    const xpHtml = xp ? `<div class="rs-xp"><div class="rs-xpline"><span>+${xp.gained} XP</span><span class="rs-lvl">LEVEL ${xp.from.level}</span></div><div class="rs-bar"><i style="width:${Math.round(xp.from.frac * 100)}%"></i></div><div class="rs-xpwhy">${xp.lines.map((l) => esc(l)).join(' · ')}</div></div>` : '';
    this.el.results.innerHTML = `<div class="rs-card">
      <div class="rs-head"><span class="rs-mode">${esc(r.mode)}</span><button class="rs-x" aria-label="Close">✕</button></div>
      <div class="rs-main">${r.place ? `<div class="rs-place ${r.won ? 'win' : ''}">#${r.place | 0}</div>` : '<div class="rs-place none">🎮</div>'}<div class="rs-title">${esc(r.title)}</div></div>
      <div class="rs-tiles">${tile(r.elims, 'Elims')}${tile(r.damage, 'Damage')}${tile(`${mins}:${secs}`, 'Time alive')}${tile(r.builds, 'Builds')}${tile(r.chests, 'Chests')}${tile(r.hits, 'Hits')}</div>
      ${xpHtml}
      ${r.mvp ? `<div class="rs-mvp">⭐ MVP: <b>${esc(r.mvp.name)}</b> · ${r.mvp.kills | 0} elim${(r.mvp.kills | 0) === 1 ? '' : 's'}</div>` : ''}
      ${top ? `<ol class="rs-top">${top}</ol>` : ''}
      <button class="lb-btn rs-ok">OK</button>
    </div>`;
    this.el.results.classList.remove('hidden');
    const close = () => this.el.results.classList.add('hidden');
    $('.rs-x', this.el.results).addEventListener('click', close);
    $('.rs-ok', this.el.results).addEventListener('click', close);
    this.el.results.addEventListener('click', (e) => { if (e.target === this.el.results) close(); }, { once: true });
    // the XP bar fills up (and rolls over on a level up)
    if (xp) {
      const bar = $('.rs-bar i', this.el.results), lvl = $('.rs-lvl', this.el.results);
      const steps = xp.steps; // [{level, frac}] to animate through
      let i = 0;
      const next = () => {
        if (i >= steps.length || this.el.results.classList.contains('hidden')) return;
        const s = steps[i++];
        bar.style.transition = 'width 0.9s cubic-bezier(.2,.8,.2,1)';
        bar.style.width = `${Math.round(s.frac * 100)}%`;
        setTimeout(() => {
          if (s.levelUp) {
            lvl.textContent = `LEVEL ${s.level + 1}`;
            lvl.classList.add('up');
            this.app.sfx.ui('victory');
            bar.style.transition = 'none';
            bar.style.width = '0%';
            void bar.offsetWidth;
          }
          next();
        }, 950);
      };
      setTimeout(next, 400);
    }
    this.render();
  }

  hideResults() { this.el.results.classList.add('hidden'); }
}
