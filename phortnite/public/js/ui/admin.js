// The admin panel (Philip only): the lobby's 🛡 ADMIN button opens it (app.adminPanel.open, wired
// in js/ui/adminLogin.js). Three tabs:
//   PLAYERS   everyone online, from their sealed player cards (js/admin/session.js), live. Tap a
//             player for what the admin can do: SPECTATE their match (js/ui/adminWatch.js), MESSAGE,
//             RENAME, GIVE XP, RESET STATS, RELOAD, KICK, BAN, 💬 CHAT LOG (their game's chat lines,
//             in a sheet), 🔇 MUTE CHAT / 🔈 UNMUTE CHAT; on a party host's page also END MATCH and
//             PAUSE / RESUME (during a match) or SET MODE (in the party's lobby): the room runs on
//             that page. A row whose card came with two different keys is marked: someone is faking
//             that player (commands still reach only the real page).
//   EVERYONE  the banner (with how long it stays), maintenance on / off, a message or a reload
//             for everyone.
//   CHAT      party chat moderation (stage 3): 🚩 REPORTS (the reported line, the lines before it)
//             and every party's live chat, as its host's game sends it in (newest party first).
//             Tap a line: its speaker (matched to a card by party code and name) can be muted for
//             10 min / 1 hour / 1 day, unmuted, messaged, or their chat log fetched. The tab's badge
//             counts new reports. Uploads are only "as that page reported them": one that wasn't
//             sealed by the page it names is marked ⚠. Every text here is escaped.
// Every command is signed with the admin key on this iPad and every player is told on screen what
// the admin did. Commands are live: a page that is offline at that moment never gets one, so the
// panel says "sent", never "done". Asking twice (confirm) happens right in the panel: it never
// closes under you. iPad first: 56 px buttons, works from 1180×820 down to a phone held sideways.
import { MODES } from '../../shared/modes/index.js';
import { MAX_XP } from '../admin/commands.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TICK_MS = 2000; // 'online for' times and the EVERYONE tab's state, while the panel is open
const BANNER_TIMES = [[5, '5 MIN'], [30, '30 MIN'], [120, '2 HOURS'], [0, 'UNTIL CLEARED']];
const XP_PICKS = [100, 500, 1000, 5000];
const MUTE_PICKS = [[10, '10 MIN'], [60, '1 HOUR'], [1440, '1 DAY']];
const PARTY_SHOWN = 40; // a party's newest lines shown (SHOW ALL: every line kept)
const lineKey = (code, l) => `${code}|${l.ts}|${l.id}|${l.text}`;
const CATS = { br: 'Battle Royale', team: 'Team', party: 'Party games', mutators: 'Mutators', builders: 'Builders', practice: 'Practice', places: 'Places' };

/** '12 min', '2 h 5 min', 'just now' */
function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

function clock(t) {
  if (!(t > 0)) return '';
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}

/** The short summary chips of a player card. */
function metaHtml(p, now) {
  const chips = [];
  chips.push(`Lv ${p.level | 0}`);
  chips.push(p.account === 'guest' ? 'Guest' : p.account ? 'Account' : 'Choosing a profile');
  chips.push(p.phase === 'match' ? '🎮 In a match' : '🏠 Lobby');
  const pt = p.party;
  if (pt && pt.kind === 'host') chips.push(`👑 Hosting ${esc(pt.code)} · ${pt.size}`);
  else if (pt && pt.kind === 'member') chips.push(`🎉 Party ${esc(pt.code)} · ${pt.size}`);
  else if (pt && pt.kind === 'watch') chips.push(`👁 Watching ${esc(pt.code)}`);
  else chips.push('👤 No party');
  if (p.mode) chips.push(`Mode: ${esc(p.mode)}`);
  if (p.v) chips.push(`v${esc(p.v)}`);
  if (p.since) chips.push(`online ${ago(now - p.since)}`);
  if (p.muted > now) chips.push(`🔇 Chat muted until ${esc(clock(p.muted))}`);
  return chips.map((c) => `<span>${c}</span>`).join('');
}

export class AdminPanel {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.tab = 'players';
    this.sel = ''; // the player whose actions are open
    this.form = ''; // the action form open under them ('message', 'rename', …)
    this.actsKey = '';
    this.banMins = 30;
    this.off = null;
    this.timer = 0;
    // CHAT tab
    this.offChats = null;
    this.chatSel = ''; // the line whose actions are open
    this.chatForm = ''; // 'msg' while its message box is open
    this.chatWhy = ''; // the mute reason being typed
    this.chatAll = new Set(); // parties showing every line
    this.ctxOpen = new Set(); // reports whose earlier lines are open
    this.chatLines = new Map(); // row key -> { code, line } (the last render)
    this.chatDirty = false;
    this.sheetEl = null;
  }

  get session() { return this.app.admin; }

  /** 🛡 ADMIN: the panel (tab: 'players' | 'everyone' | 'chat'). */
  open(tab = this.tab) {
    const app = this.app, s = this.session;
    if (!s) return;
    this.tab = ['everyone', 'chat'].includes(tab) ? tab : 'players';
    const html = `<div class="adm-panel">
      <div class="adm-head"><h2>🛡 ADMIN</h2><p class="adm-open-note">Every command is signed with the admin key, and players always see what the admin did.</p></div>
      <div class="adm-tabs" role="tablist">
        <button class="adm-tab" data-tab="players" role="tab">👥 PLAYERS <b class="adm-count"></b></button>
        <button class="adm-tab" data-tab="everyone" role="tab">📢 EVERYONE</button>
        <button class="adm-tab" data-tab="chat" role="tab">💬 CHAT <b class="adm-count adm-rbadge hidden"></b></button>
      </div>
      <div class="adm-pane adm-players">
        <p class="adm-totals"></p>
        <ul class="adm-list"></ul>
      </div>
      <div class="adm-pane adm-everyone"></div>
      <div class="adm-pane adm-chat"></div>
      <div class="adm-status" aria-live="polite"></div>
    </div>`;
    // ("🚩 New chat report" toasts would sit over the tabs: the CHAT tab's badge says it now)
    for (const t of document.querySelectorAll('#toasts > .toast.adm-report')) t.remove();
    app.ui.modal(html, (b) => {
      this.root = $('.adm-panel', b);
      app.ui.modalEl.classList.add('adm-wide');
      // (Philip's news banner sits above dialogs: not over the panel's tabs)
      document.body.classList.add('adm-panel-open');
      for (const t of b.querySelectorAll('.adm-tab')) t.addEventListener('click', () => { this.ui(); this.show(t.dataset.tab); });
      this.everyone();
      this.chatPane();
      this.show(this.tab);
      this.renderPlayers();
      this.off = s.onPlayers(() => { this.renderPlayers(); if (this.tab === 'chat') this.renderChat(); });
      this.offChats = s.onChats ? s.onChats(() => this.renderChat()) : null;
      this.badge();
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }, () => this.closed());
  }

  /** The panel went away (closed, or another modal took its place). */
  closed() {
    if (this.off) this.off();
    this.off = null;
    if (this.offChats) this.offChats();
    this.offChats = null;
    this.sheetEl = null;
    clearInterval(this.timer);
    this.timer = 0;
    this.root = null;
    this.actsKey = '';
    this.app.ui.modalEl.classList.remove('adm-wide');
    document.body.classList.remove('adm-panel-open');
  }

  /** Still on screen? (Another modal may have replaced it without closing it.) */
  live() {
    if (this.root && this.root.isConnected && this.session) return true;
    if (this.root) this.closed();
    return false;
  }

  ui() { if (this.app.sfx) this.app.sfx.ui(); }

  show(tab) {
    this.tab = tab;
    for (const t of this.root.querySelectorAll('.adm-tab')) {
      const on = t.dataset.tab === tab;
      t.classList.toggle('sel', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    $('.adm-players', this.root).classList.toggle('hidden', tab !== 'players');
    $('.adm-everyone', this.root).classList.toggle('hidden', tab !== 'everyone');
    $('.adm-chat', this.root).classList.toggle('hidden', tab !== 'chat');
    if (tab === 'everyone') this.stateNow();
    if (tab === 'chat') this.renderChat();
  }

  tick() {
    if (!this.live()) return;
    this.renderPlayers();
    this.stateNow();
    this.badge();
  }

  /** What happened, under the panel: ok true (sent), false (not sent), or a plain note. */
  status(text, ok = true) {
    if (!this.root) return;
    const el = $('.adm-status', this.root);
    el.className = `adm-status ${ok ? 'ok' : 'bad'}`;
    el.textContent = text;
    clearTimeout(this.statusT);
    this.statusT = setTimeout(() => { if (el.isConnected) { el.textContent = ''; el.className = 'adm-status'; } }, 9000);
  }

  // ------------------------------------------------------------------ PLAYERS
  renderPlayers() {
    if (!this.live()) return;
    const s = this.session, now = Date.now();
    const list = s.players();
    const t = s.totals();
    $('.adm-count', this.root).textContent = String(t.total);
    const missing = t.total - t.cards;
    $('.adm-totals', this.root).innerHTML = `<b>${t.total}</b> playing now · <b>${t.inMatch}</b> in a match · <b>${t.inLobby}</b> in the lobby · <b>${t.parties}</b> ${t.parties === 1 ? 'party' : 'parties'}`
      + (missing > 0 ? `<small>${missing} without a player card yet (still connecting, or an older version of the game)</small>` : '');
    const ul = $('.adm-list', this.root);
    const rows = new Map([...ul.children].map((li) => [li.dataset.id, li]));
    const seen = new Set();
    let prev = null;
    for (const p of list) {
      seen.add(p.id);
      let li = rows.get(p.id);
      if (!li) {
        li = document.createElement('li');
        li.className = 'adm-row';
        li.dataset.id = p.id;
        li.innerHTML = '<button class="adm-rowhead"><span class="adm-nm"></span><span class="adm-meta"></span><span class="adm-chev">▾</span></button><div class="adm-acts hidden"></div>';
        $('.adm-rowhead', li).addEventListener('click', () => this.pick(li.dataset.id));
      }
      // (keep the list in the session's order: the admin first, then by name)
      if (prev ? prev.nextSibling !== li : ul.firstChild !== li) ul.insertBefore(li, prev ? prev.nextSibling : ul.firstChild);
      prev = li;
      $('.adm-nm', li).innerHTML = `${esc(p.name)}${p.me ? ' <small>(you)</small>' : ''}${p.admin && !p.me ? ' <small>🛡</small>' : ''}`;
      $('.adm-meta', li).innerHTML = metaHtml(p, now)
        + (p.suspect ? '<span class="adm-warn">⚠ Someone may be faking this card: your commands only reach the real player</span>' : '');
      li.classList.toggle('sel', p.id === this.sel);
      if (p.id === this.sel) this.actions(li, p);
    }
    for (const [id, li] of rows) if (!seen.has(id)) li.remove();
    if (this.sel && !seen.has(this.sel)) {
      this.sel = '';
      this.form = '';
      this.actsKey = '';
      this.status('That player left.', false);
    }
  }

  pick(id) {
    this.ui();
    if (this.sel === id) { this.sel = ''; this.form = ''; } else { this.sel = id; this.form = ''; }
    this.actsKey = '';
    for (const li of this.root.querySelectorAll('.adm-row')) {
      const on = li.dataset.id === this.sel;
      li.classList.toggle('sel', on);
      if (!on) { const a = $('.adm-acts', li); a.classList.add('hidden'); a.innerHTML = ''; }
    }
    this.renderPlayers();
    const li = this.sel && this.root.querySelector(`.adm-row[data-id="${this.sel}"]`);
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }

  /** The selected player's buttons (rebuilt only when what they can do changed: a form keeps its text). */
  actions(li, p) {
    const box = $('.adm-acts', li);
    const pt = p.party;
    const watch = !p.me && pt && pt.code && pt.kind !== 'watch';
    const host = pt && pt.kind === 'host';
    const live = p.phase === 'match';
    const muted = p.muted > Date.now();
    const key = `${p.id}|${p.me}|${watch ? pt.code : ''}|${host}|${p.phase}|${p.name}|${this.form}|${muted}`;
    if (key === this.actsKey && !box.classList.contains('hidden')) return;
    this.actsKey = key;
    box.classList.remove('hidden');
    const btn = (act, label, cls = '') => `<button class="btn adm-act ${cls}" data-act="${act}">${label}</button>`;
    box.innerHTML = `<div class="adm-grid">
        ${watch ? btn('spectate', `👁 SPECTATE${p.phase === 'match' ? '' : ' PARTY'}`, 'blue') : ''}
        ${btn('message', '📣 MESSAGE')}
        ${btn('rename', '✎ RENAME')}
        ${btn('grant', '🎁 GIVE XP')}
        ${btn('resetStats', '↺ RESET STATS')}
        ${btn('reload', '🔄 RELOAD')}
        ${p.me ? '' : btn('kick', '🚪 KICK')}
        ${p.me ? '' : btn('ban', '🚫 BAN', 'danger')}
      </div>
      <div class="adm-sub">💬 PARTY CHAT${muted ? ` · 🔇 MUTED UNTIL ${esc(clock(p.muted))}` : ''}</div>
      <div class="adm-grid">
        ${btn('chatlog', '💬 CHAT LOG')}
        ${btn('mute', '🔇 MUTE CHAT')}
        ${muted ? btn('unmute', '🔈 UNMUTE CHAT') : ''}
      </div>
      ${host ? `<div class="adm-sub">👑 PARTY ${esc(pt.code)} RUNS ON THIS PAGE${live ? ' · IN A MATCH' : ' · IN ITS LOBBY'}</div>
      <div class="adm-grid">
        ${live ? `${btn('end', '⏹ END MATCH')}${btn('pause', '⏸ PAUSE')}${btn('resume', '▶ RESUME')}` : btn('mode', '🎮 SET MODE')}
      </div>` : ''}
      <div class="adm-form"></div>`;
    for (const b of box.querySelectorAll('.adm-act')) {
      b.classList.toggle('on', b.dataset.act === this.form);
      b.addEventListener('click', () => { this.ui(); this.act(b.dataset.act, p); });
    }
    if (this.form) this.formFor(box, p);
  }

  /** A player's button: some send at once, the rest open a small form (text, or "are you sure?"). */
  act(what, p) {
    if (what === 'spectate') { this.spectate(p); return; }
    if (what === 'chatlog') { this.chatLog(p); return; }
    if (what === 'unmute') { this.send('unmute', {}, p, 'an unmute (chat)'); return; }
    if (what === 'pause' || what === 'resume') {
      this.send('pause', { on: what === 'pause' }, p, what === 'pause' ? 'pause their match' : 'resume their match');
      return;
    }
    this.form = this.form === what ? '' : what;
    this.actsKey = '';
    this.renderPlayers();
  }

  /** The open form under the selected player's buttons. */
  formFor(box, p) {
    const f = $('.adm-form', box);
    const name = esc(p.name);
    // a host's page runs the party: removing them ends it for everyone in it
    const hostNote = p.party && p.party.kind === 'host' && p.party.code
      ? ` This ends party ${esc(p.party.code)} for everyone in it (they're told the admin removed the host).` : '';
    const sure = (text, label, cls = 'yellow') => `<p class="adm-q">${text}</p><div class="adm-btns2"><button class="btn ${cls} adm-yes">${label}</button><button class="btn adm-no">CANCEL</button></div>`;
    switch (this.form) {
      case 'message':
        f.innerHTML = `<textarea class="adm-in" maxlength="300" rows="2" placeholder="Message for ${name}"></textarea>
          <div class="adm-btns2"><button class="btn yellow adm-yes">📣 SEND</button><button class="btn adm-no">CANCEL</button></div>`;
        break;
      case 'rename':
        f.innerHTML = `<input class="adm-in" maxlength="16" value="${name}" autocomplete="off" autocorrect="off" spellcheck="false">
          <p class="adm-hint">They see "The admin changed your name". A signed-in account keeps the new name.</p>
          <div class="adm-btns2"><button class="btn yellow adm-yes">✎ RENAME</button><button class="btn adm-no">CANCEL</button></div>`;
        break;
      case 'grant':
        f.innerHTML = `<div class="adm-picks">${XP_PICKS.map((x) => `<button class="btn adm-xp" data-xp="${x}">+${x} XP</button>`).join('')}</div>
          <div class="adm-inrow"><input class="adm-in" type="number" inputmode="numeric" min="1" max="${MAX_XP}" placeholder="Other amount"><button class="btn yellow adm-yes">🎁 GIVE</button></div>`;
        break;
      case 'resetStats':
        f.innerHTML = sure(`Reset ${name}'s level, XP, wins and eliminations to zero?`, '↺ YES, RESET', 'danger');
        break;
      case 'mute':
        f.innerHTML = `<input class="adm-in" maxlength="120" placeholder="Why? (optional, they see it)">
          <div class="adm-picks adm-picks3">${MUTE_PICKS.map(([m, l]) => `<button class="btn adm-mute" data-min="${m}">🔇 ${l}</button>`).join('')}</div>
          <p class="adm-hint">They see "🔇 The admin muted your chat" (and why). They can still play and read the chat.</p>`;
        break;
      case 'reload':
        f.innerHTML = sure(`Reload ${name}'s game? (They see "Updating the game…".)`, '🔄 RELOAD');
        break;
      case 'kick':
        f.innerHTML = `<input class="adm-in" maxlength="120" placeholder="Why? (optional, they see it)">
          ${sure(`Take ${name} out of their party or match, back to the lobby?${hostNote}`, '🚪 KICK', 'danger')}`;
        break;
      case 'ban':
        f.innerHTML = `<input class="adm-in" maxlength="120" placeholder="Why? (optional, they see it)">
          ${sure(`Ban ${name}'s iPad? It shows the ban screen until Philip's unban code is typed in.${hostNote}`, '🚫 BAN', 'danger')}`;
        break;
      case 'end':
        f.innerHTML = sure(`End the match for everyone in party ${esc(p.party && p.party.code)}? Everyone goes back to the lobby.`, '⏹ END MATCH', 'danger');
        break;
      case 'mode': {
        const groups = new Map();
        for (const m of MODES) {
          const k = CATS[m.cat] || 'More';
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(m);
        }
        const opts = [...groups].map(([k, ms]) => `<optgroup label="${esc(k)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(`${m.emoji || ''} ${m.name}`.trim())}</option>`).join('')}</optgroup>`).join('');
        f.innerHTML = `<div class="adm-inrow"><select class="adm-in">${opts}</select><button class="btn yellow adm-yes">🎮 SET MODE</button></div>
          <p class="adm-hint">Only in the party's lobby (not during a match).</p>`;
        break;
      }
      default: f.innerHTML = ''; return;
    }
    const input = $('.adm-in', f);
    const no = $('.adm-no', f);
    if (no) no.addEventListener('click', () => { this.ui(); this.act(this.form, p); });
    for (const b of f.querySelectorAll('.adm-xp')) b.addEventListener('click', () => { this.ui(); this.grant(p, +b.dataset.xp); });
    for (const b of f.querySelectorAll('.adm-mute')) {
      b.addEventListener('click', () => {
        this.ui();
        this.mute(p, +b.dataset.min, input ? input.value.trim() : '');
        this.form = '';
        this.actsKey = '';
        this.renderPlayers();
      });
    }
    const yes = $('.adm-yes', f);
    const go = () => {
      this.ui();
      const v = input ? input.value.trim() : '';
      switch (this.form) {
        case 'message': if (!v) { input.focus(); return; } this.send('message', { text: v }, p, 'a message'); break;
        case 'rename': if (!v) { input.focus(); return; } this.send('rename', { name: v }, p, `a new name (${v})`); break;
        case 'grant': this.grant(p, Math.floor(+v)); return;
        case 'resetStats': this.send('resetStats', {}, p, 'a stats reset'); break;
        case 'reload': this.send('reload', {}, p, 'a reload'); break;
        case 'kick': this.send('kick', { reason: v }, p, 'a kick'); break;
        case 'ban': this.send('ban', { reason: v }, p, 'a ban'); break;
        case 'end': this.send('end', {}, p, 'END MATCH'); break;
        case 'mode': this.send('mode', { modeId: input.value }, p, 'a new mode'); break;
        default: return;
      }
      this.form = '';
      this.actsKey = '';
      this.renderPlayers();
    };
    if (yes) yes.addEventListener('click', go);
    if (input && input.tagName === 'INPUT') input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    if (input && (this.form === 'message' || this.form === 'rename')) setTimeout(() => { try { input.focus(); } catch (e) { /* fine */ } }, 30);
    // (the form opens under the buttons: low in the list or on a phone it would be out of sight)
    requestAnimationFrame(() => { try { if (f.isConnected) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* fine */ } });
  }

  grant(p, xp) {
    if (!(xp >= 1 && xp <= MAX_XP)) { this.status(`Give between 1 and ${MAX_XP} XP.`, false); return; }
    this.send('grant', { xp }, p, `${xp} XP`);
    this.form = '';
    this.actsKey = '';
    this.renderPlayers();
  }

  /** Sign and send a command to one player's page; the status line says what went out. */
  async send(cmd, args, p, what) {
    const s = this.session;
    if (!s) return;
    let env = null, err = '';
    try { env = await s.send(cmd, args, p.id); } catch (e) { env = null; err = (e && e.message) || ''; }
    if (env) this.status(`✓ Sent ${what} to ${p.name}. (If their iPad is offline right now it won't get it.)`);
    else this.status(err ? `✕ ${err}` : '✕ Not sent: the admin channel is offline right now. Try again in a moment.', false);
  }

  async spectate(p) {
    const w = this.app.adminWatch, code = p.party && p.party.code;
    if (!w || !code) return;
    this.status(`👁 Joining party ${code} to watch…`);
    if (await w.start(code)) return; // (the panel closed: the island is on screen)
    this.status(`✕ Couldn't watch party ${code}.`, false);
  }

  // ------------------------------------------------------------------ CHAT
  /** The CHAT tab's badge: new reports. */
  badge() {
    if (!this.root || !this.session || !this.session.unseenReports) return;
    const n = this.session.unseenReports();
    const b = $('.adm-rbadge', this.root);
    b.classList.toggle('hidden', !n);
    b.textContent = n ? `🚩 ${n}` : '';
  }

  /** The CHAT pane's taps, once (its content is drawn again and again: delegated). */
  chatPane() {
    const pane = $('.adm-chat', this.root);
    pane.addEventListener('click', (e) => {
      const row = e.target.closest('.adm-clb');
      if (row && pane.contains(row)) {
        this.ui();
        const k = row.parentNode.dataset.k;
        this.chatSel = this.chatSel === k ? '' : k;
        this.chatForm = '';
        this.renderChat(true);
        return;
      }
      const b = e.target.closest('.adm-la');
      if (b && pane.contains(b)) { this.ui(); this.lineAct(b.dataset.act, b); return; }
      const more = e.target.closest('.adm-more');
      if (more) {
        this.ui();
        const c = more.dataset.code;
        if (this.chatAll.has(c)) this.chatAll.delete(c); else this.chatAll.add(c);
        this.renderChat(true);
        return;
      }
      const sum = e.target.closest('summary');
      if (sum && sum.parentNode.dataset.n) {
        const n = sum.parentNode.dataset.n;
        if (sum.parentNode.open) this.ctxOpen.delete(n); else this.ctxOpen.add(n);
      }
    });
    pane.addEventListener('input', (e) => { if (e.target.classList.contains('adm-lwhy')) this.chatWhy = e.target.value; });
    pane.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('adm-lmsg') && !e.shiftKey) { e.preventDefault(); this.lineAct('msgsend'); }
    });
    // (drawn again once the admin stops typing: a redraw never eats what he types)
    pane.addEventListener('focusout', () => { setTimeout(() => { if (this.chatDirty) this.renderChat(); }, 0); });
  }

  /** The player card a chat line's speaker has (party code + name), or null. */
  speaker(code, l) {
    if (!l || l.sys || l.admin || !this.session) return null;
    return this.session.players().find((c) => c.party && c.party.code === code && c.name === l.name) || null;
  }

  /** The CHAT tab, drawn from the session's chats() and reports(). force: even while typing. */
  renderChat(force = false) {
    if (!this.live()) return;
    this.badge();
    const pane = $('.adm-chat', this.root);
    if (this.tab !== 'chat') { this.chatDirty = true; return; }
    const a = document.activeElement;
    if (!force && a && pane.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) { this.chatDirty = true; return; }
    if (this.drawing) return;
    this.drawing = true;
    try {
      const s = this.session;
      s.seenReports(); // (the admin is looking at them)
      this.badge();
      this.chatDirty = false;
      const body = this.app.ui.modalBody;
      const top = body ? body.scrollTop : 0;
      // each party's box: where it was scrolled (at the bottom: stays at the newest line)
      const boxes = new Map([...pane.querySelectorAll('.adm-cbox')].map((b) => [b.dataset.code, { top: b.scrollTop, end: b.scrollTop + b.clientHeight >= b.scrollHeight - 8 }]));
      const lines = new Map();
      const row = (key, l, code) => {
        lines.set(key, { code, line: l });
        const sel = key === this.chatSel;
        const cls = l.sys ? ' sys' : l.admin ? ' admin' : '';
        const who = l.sys ? '' : l.admin ? '<b class="adm-cn adm-cadmin">🛡 ADMIN</b>' : `<b class="adm-cn">${esc(l.name)}</b>`;
        const warn = l.ok === false ? '<i class="adm-unv" title="Not checked: this did not come from the party host\'s own game">⚠</i> ' : '';
        return `<li class="adm-cl${cls}${sel ? ' sel' : ''}" data-k="${esc(key)}"><button class="adm-clb"${l.sys || l.admin ? ' disabled' : ''}>`
          + `<span class="adm-ct">${esc(clock(l.at || l.got))}</span>${who}<span class="adm-cx">${warn}${esc(l.text)}</span></button>`
          + `${sel && !l.sys && !l.admin ? this.lineActs(code, l) : ''}</li>`;
      };
      const reps = s.reports();
      const chats = s.chats();
      const repHtml = (r) => {
        const ctx = r.context.length ? `<details class="adm-ctx" data-n="${r.n}"${this.ctxOpen.has(String(r.n)) ? ' open' : ''}><summary>${r.context.length} line${r.context.length === 1 ? '' : 's'} before it</summary>`
          + `<ul class="adm-clist">${r.context.map((l, i) => row(`rc:${r.n}:${i}`, l, r.code)).join('')}</ul></details>` : '';
        return `<div class="adm-rep"><p class="adm-rhead">🚩 <b>${esc(r.name || 'A player')}</b> reported <b>${esc(r.line.admin ? 'Admin' : r.line.name)}</b>`
          + ` · ${r.code === 'SOLO' ? 'not in a party' : `party ${esc(r.code)}`} · ${esc(clock(r.at))}</p>`
          + `${r.ok ? '' : '<p class="adm-warn">⚠ Not checked: this report may not have come from that player\'s own game.</p>'}`
          + `${r.reason ? `<p class="adm-rwhy">“${esc(r.reason)}”</p>` : ''}<ul class="adm-clist">${row(`r:${r.n}`, r.line, r.code)}</ul>${ctx}</div>`;
      };
      const partyHtml = (p) => {
        const all = this.chatAll.has(p.code);
        const shown = all ? p.lines : p.lines.slice(-PARTY_SHOWN);
        // (a line open in it: the box grows, its buttons never hide in a scroll box of their own)
        const open = this.chatSel.startsWith(`p:${p.code}|`);
        return `<div class="adm-party"><p class="adm-phead"><b>🎉 ${esc(p.code)}</b><span>${p.host ? `host <b>${esc(p.host)}</b>` : 'host not online'}</span>`
          + `<span>${p.count} line${p.count === 1 ? '' : 's'} · last at ${esc(clock(p.last))}</span></p>`
          + `${p.ok ? '' : '<p class="adm-warn">⚠ Not checked: these lines may not have come from the party host\'s own game.</p>'}`
          + `${p.count > PARTY_SHOWN ? `<button class="btn adm-more" data-code="${esc(p.code)}">${all ? `SHOW THE LAST ${PARTY_SHOWN}` : `SHOW ALL ${p.count} LINES`}</button>` : ''}`
          + `<ul class="adm-clist adm-cbox${open ? ' open' : ''}" data-code="${esc(p.code)}">${shown.map((l) => row(`p:${lineKey(p.code, l)}`, l, p.code)).join('')}</ul></div>`;
      };
      pane.innerHTML = `<p class="adm-chatnote">Party chats as each party host's game sends them in (parties with 2 or more people, while you're in admin mode). Players see in their chat that the admin can read it. Tap a line for what you can do.</p>
        <section class="adm-sec adm-reports"><h3>🚩 REPORTS</h3>${reps.length ? reps.map(repHtml).join('')
          : '<p class="adm-now">No reports. When a player taps 🚩 Report to admin on a chat line, it shows up here.</p>'}</section>
        <section class="adm-sec adm-chats"><h3>🎉 PARTY CHATS</h3>${chats.length ? chats.map(partyHtml).join('')
          : '<p class="adm-now">No party chat yet. New lines show up here as players chat in parties of 2 or more.</p>'}</section>`;
      this.chatLines = lines;
      if (this.chatSel && !lines.has(this.chatSel)) { this.chatSel = ''; this.chatForm = ''; }
      for (const b of pane.querySelectorAll('.adm-cbox')) {
        const was = boxes.get(b.dataset.code);
        b.scrollTop = !was || was.end ? b.scrollHeight : was.top;
      }
      if (body) body.scrollTop = top;
      const msg = $('.adm-lmsg', pane);
      if (msg && force) setTimeout(() => { try { msg.focus(); } catch (e) { /* fine */ } }, 30);
    } finally { this.drawing = false; }
  }

  /** The open line's buttons: for its speaker's card (matched by party code + name). */
  lineActs(code, l) {
    const c = this.speaker(code, l);
    if (!c) return `<div class="adm-lacts"><p class="adm-hint">${esc(l.name)} isn't online in ${code === 'SOLO' ? 'a party' : `party ${esc(code)}`} with a player card right now (they left, or changed their name).</p></div>`;
    if (c.me) return '<div class="adm-lacts"><p class="adm-hint">That\'s you.</p></div>';
    const muted = c.muted > Date.now();
    const b = (act, label, extra = '', cls = '') => `<button class="btn adm-la ${cls}" data-act="${act}"${extra}>${label}</button>`;
    return `<div class="adm-lacts" data-id="${esc(c.id)}">
      <p class="adm-lwho"><b>${esc(c.name)}</b> · Lv ${c.level | 0}${c.party && c.party.code ? ` · ${c.party.kind === 'host' ? '👑 hosting' : '🎉 in'} ${esc(c.party.code)}` : ''}${muted ? ` · 🔇 muted until ${esc(clock(c.muted))}` : ''}</p>
      <input class="adm-in adm-lwhy" maxlength="120" placeholder="Why? (optional, they see it)" value="${esc(this.chatWhy)}">
      <div class="adm-grid">
        ${MUTE_PICKS.map(([m, lb]) => b('mute', `🔇 MUTE ${lb}`, ` data-min="${m}"`)).join('')}
        ${muted ? b('unmute', '🔈 UNMUTE') : ''}
        ${b('msg', '✉ MESSAGE', '', this.chatForm === 'msg' ? 'on' : '')}
        ${b('log', '💬 CHAT LOG')}
      </div>
      ${this.chatForm === 'msg' ? `<div class="adm-form"><textarea class="adm-in adm-lmsg" maxlength="300" rows="2" placeholder="Message for ${esc(c.name)}"></textarea>
        <div class="adm-btns2">${b('msgsend', '✉ SEND', '', 'yellow')}${b('msgno', 'CANCEL')}</div></div>` : ''}
    </div>`;
  }

  /** A button under an open chat line. */
  lineAct(act, btn = null) {
    const sel = this.chatLines.get(this.chatSel);
    const c = sel && this.speaker(sel.code, sel.line);
    if (!c) { this.status('That player is not online with a card right now.', false); return; }
    const pane = $('.adm-chat', this.root);
    switch (act) {
      case 'mute': this.mute(c, +btn.dataset.min, this.chatWhy.trim()); this.chatWhy = ''; break;
      case 'unmute': this.send('unmute', {}, c, 'an unmute (chat)'); break;
      case 'log': this.chatLog(c); return;
      case 'msg': this.chatForm = this.chatForm === 'msg' ? '' : 'msg'; break;
      case 'msgno': this.chatForm = ''; break;
      case 'msgsend': {
        const box = $('.adm-lmsg', pane);
        const text = box ? box.value.trim() : '';
        if (!text) { if (box) box.focus(); return; }
        this.send('message', { text }, c, 'a message');
        this.chatForm = '';
        break;
      }
      default: return;
    }
    this.renderChat(true);
  }

  /** Mute a player's chat for `minutes` (they're told, with the reason). */
  mute(p, minutes, reason = '') {
    const label = (MUTE_PICKS.find(([m]) => m === minutes) || [0, `${minutes} MIN`])[1].toLowerCase();
    this.send('mute', { minutes, reason }, p, `a chat mute (${label})`);
  }

  /** 💬 CHAT LOG: ask the player's game for its chat lines, shown in a sheet over the panel. */
  async chatLog(p) {
    const s = this.session;
    if (!s || !s.requestLog) return;
    if (!p.pk) { this.status("✕ Not sent: that player's game is an older version (it needs a reload).", false); return; }
    const el = this.sheet(`💬 CHAT LOG · ${p.name}`,
      `<p class="adm-now">Asking ${esc(p.name)}'s game for its chat… They see "🛡 The admin looked at this chat".</p>`);
    const log = await s.requestLog(p.id);
    if (this.sheetEl !== el || !el.isConnected) return;
    const body = $('.adm-sbody', el);
    if (!log) {
      body.innerHTML = `<p class="adm-now">✕ No answer from ${esc(p.name)}'s game. It may be offline right now, or on an older version.</p>`;
      return;
    }
    const lines = log.lines;
    let html = `<p class="adm-hint">${lines.length ? `The ${lines.length} chat line${lines.length === 1 ? '' : 's'} ${esc(p.name)}'s game has seen since it was opened (newest last)` : `${esc(p.name)}'s game hasn't seen any chat since it was opened`}. They were told you looked.</p>`;
    let code = null;
    for (const l of lines) {
      const c = l.code || 'SOLO';
      if (c !== code) {
        if (code !== null) html += '</ul>';
        code = c;
        html += `<h4 class="adm-lgh">${c === 'SOLO' ? '👤 On their own' : `🎉 Party ${esc(c)}`}</h4><ul class="adm-clist">`;
      }
      const who = l.sys ? '' : l.admin ? '<b class="adm-cn adm-cadmin">🛡 ADMIN</b>' : `<b class="adm-cn">${esc(l.name)}</b>`;
      html += `<li class="adm-cl${l.sys ? ' sys' : l.admin ? ' admin' : ''}"><div class="adm-clb"><span class="adm-ct">${esc(clock(l.at))}</span>${who}<span class="adm-cx">${esc(l.text)}</span></div></li>`;
    }
    if (code !== null) html += '</ul>';
    body.innerHTML = html;
  }

  /** A sheet over the panel (its own CLOSE): title is text, html trusted markup with escaped values. */
  sheet(title, html) {
    this.closeSheet();
    const el = document.createElement('div');
    el.className = 'adm-sheet';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="adm-shead"><h3></h3><button class="btn adm-shx">✕ CLOSE</button></div><div class="adm-sbody">${html}</div>`;
    $('h3', el).textContent = title;
    $('.adm-shx', el).addEventListener('click', () => { this.ui(); this.closeSheet(); });
    this.root.appendChild(el);
    this.sheetEl = el;
    return el;
  }

  closeSheet() {
    if (this.sheetEl) this.sheetEl.remove();
    this.sheetEl = null;
  }

  // ------------------------------------------------------------------ EVERYONE
  everyone() {
    const pane = $('.adm-everyone', this.root);
    pane.innerHTML = `<section class="adm-sec">
        <h3>📢 BANNER</h3>
        <p class="adm-now adm-bnow"></p>
        <textarea class="adm-btext" maxlength="200" rows="2" placeholder="News for everyone (shows in the lobby and in matches)"></textarea>
        <p class="adm-hint">Anyone can read a banner, like a message for everyone (messages to one player are sealed). UNTIL CLEARED lasts a week at most.</p>
        <div class="adm-seg">${BANNER_TIMES.map(([m, l]) => `<button class="btn adm-bmin" data-min="${m}">${l}</button>`).join('')}</div>
        <div class="adm-btns2"><button class="btn yellow adm-bshow">📢 SHOW BANNER</button><button class="btn adm-bclear">CLEAR BANNER</button></div>
      </section>
      <section class="adm-sec">
        <h3>🛠 MAINTENANCE</h3>
        <p class="adm-now adm-mnow"></p>
        <input class="adm-mtext" maxlength="300" placeholder="What are you working on? (optional)">
        <div class="adm-btns2"><button class="btn danger adm-mon">🛠 MAINTENANCE ON</button><button class="btn adm-moff">MAINTENANCE OFF</button></div>
        <p class="adm-hint">Everyone else leaves their match and sees "🛠 Philip is working on the game" until you turn it off (it turns itself off after 12 hours).</p>
      </section>
      <section class="adm-sec">
        <h3>📣 MESSAGE EVERYONE</h3>
        <div class="adm-inrow"><input class="adm-alltext" maxlength="300" placeholder="A message for everyone online"><button class="btn yellow adm-allsend">📣 SEND</button></div>
      </section>
      <section class="adm-sec">
        <h3>🔄 RELOAD EVERYONE</h3>
        <div class="adm-rall"><button class="btn adm-rallgo">🔄 RELOAD EVERYONE</button></div>
        <p class="adm-hint">Everyone's game reloads with the newest version ("Updating the game…").</p>
      </section>
      <section class="adm-sec adm-me">
        <button class="btn adm-signout">ADMIN SIGN OUT</button>
      </section>`;
    const seg = () => { for (const b of pane.querySelectorAll('.adm-bmin')) b.classList.toggle('on', +b.dataset.min === this.banMins); };
    for (const b of pane.querySelectorAll('.adm-bmin')) b.addEventListener('click', () => { this.ui(); this.banMins = +b.dataset.min; seg(); });
    seg();
    const btext = $('.adm-btext', pane), mtext = $('.adm-mtext', pane), alltext = $('.adm-alltext', pane);
    $('.adm-bshow', pane).addEventListener('click', async () => {
      this.ui();
      const text = btext.value.trim();
      if (!text) { btext.focus(); return; }
      const env = await this.state('banner', { text, minutes: this.banMins });
      if (env) { btext.value = ''; this.status(`✓ Banner sent to everyone${this.banMins ? ` for ${BANNER_TIMES.find(([m]) => m === this.banMins)[1].toLowerCase()}` : ' until you clear it'}.`); }
    });
    $('.adm-bclear', pane).addEventListener('click', async () => {
      this.ui();
      if (await this.state('banner', { text: '' })) this.status('✓ Banner cleared for everyone.');
    });
    $('.adm-mon', pane).addEventListener('click', async () => {
      this.ui();
      if (await this.state('maintenance', { on: true, text: mtext.value.trim() })) this.status('✓ Maintenance is ON: everyone else sees the maintenance screen.');
    });
    $('.adm-moff', pane).addEventListener('click', async () => {
      this.ui();
      if (await this.state('maintenance', { on: false })) this.status('✓ Maintenance is OFF: the game is back for everyone.');
    });
    const sendAll = async () => {
      this.ui();
      const text = alltext.value.trim();
      if (!text) { alltext.focus(); return; }
      let env = null;
      try { env = await this.session.send('message', { text }, '*'); } catch (e) { env = null; }
      if (env) { alltext.value = ''; this.status('✓ Message sent to everyone online.'); } else this.status('✕ Not sent: the admin channel is offline right now.', false);
    };
    $('.adm-allsend', pane).addEventListener('click', sendAll);
    alltext.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAll(); });
    // RELOAD EVERYONE asks first, right here
    const rall = $('.adm-rall', pane);
    const reloadAsk = () => {
      rall.innerHTML = '<p class="adm-q">Reload everyone\'s game now? Matches being played end.</p><div class="adm-btns2"><button class="btn danger adm-yes">🔄 YES, RELOAD EVERYONE</button><button class="btn adm-no">CANCEL</button></div>';
      $('.adm-yes', rall).addEventListener('click', async () => {
        this.ui();
        let env = null;
        try { env = await this.session.send('reload', {}, '*'); } catch (e) { env = null; }
        this.status(env ? '✓ Reload sent to everyone online.' : '✕ Not sent: the admin channel is offline right now.', !!env);
        reloadReset();
      });
      $('.adm-no', rall).addEventListener('click', () => { this.ui(); reloadReset(); });
    };
    const reloadReset = () => {
      rall.innerHTML = '<button class="btn adm-rallgo">🔄 RELOAD EVERYONE</button>';
      $('.adm-rallgo', rall).addEventListener('click', () => { this.ui(); reloadAsk(); });
    };
    reloadReset();
    $('.adm-signout', pane).addEventListener('click', async () => {
      this.ui();
      this.app.ui.closeModal(true);
      if (this.app.adminLogin) await this.app.adminLogin.signOut();
    });
  }

  async state(kind, payload) {
    let env = null;
    try { env = await this.session.sendState(kind, payload); } catch (e) { env = null; }
    if (!env) this.status('✕ Not sent: the admin channel is offline right now. Try again in a moment.', false);
    setTimeout(() => this.stateNow(), 600);
    return env;
  }

  /** The banner and maintenance as this page has them (they come back from the broker). */
  stateNow() {
    if (!this.live()) return;
    const st = this.session.state();
    const b = st.banner, m = st.maintenance;
    const bn = $('.adm-bnow', this.root), mn = $('.adm-mnow', this.root);
    if (!bn || !mn) return;
    bn.innerHTML = b ? `Showing now: “${esc(b.text)}” ${b.until ? `until ${esc(clock(b.until))}` : 'until you clear it'}` : 'No banner right now.';
    mn.innerHTML = m ? `<b class="adm-onnow">ON</b>${m.text ? ` “${esc(m.text)}”` : ''} — turns itself off at ${esc(clock(m.until))}` : 'Maintenance is off: everyone can play.';
  }
}
