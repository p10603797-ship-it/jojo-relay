// The admin panel (Philip only): the lobby's 🛡 ADMIN button opens it (app.adminPanel.open, wired
// in js/ui/adminLogin.js). Four tabs:
//   PLAYERS   everyone online, from their sealed player cards (js/admin/session.js), live; under
//             them 📴 OFFLINE: every account that isn't online right now (offlineAccounts below:
//             never a guest, never twice), last seen first, 40 at a time; a search box finds a
//             name in both. Tap an offline name: the same sheet as ACCOUNTS (BAN with a reason, ✓
//             REMOVE BAN). Tap a live player for what the admin can do: SPECTATE their match
//             (js/ui/adminWatch.js), MESSAGE, RENAME, GIVE XP, RESET STATS, RELOAD, KICK, BAN (a
//             signed-in player's ACCOUNT goes on the ban list too, the same as ACCOUNTS → BAN; a guest: only that iPad), 💬 CHAT LOG (their game's chat lines,
//             in a sheet), 🔇 MUTE CHAT / 🔈 UNMUTE CHAT; on a party host's page also END MATCH and
//             PAUSE / RESUME (during a match) or SET MODE (in the party's lobby): the room runs on
//             that page. A row whose card came with two different keys is marked: someone is faking
//             that player (commands still reach only the real page).
//   EVERYONE  the banner (with how long it stays), maintenance on / off, a message or a reload
//             for everyone.
//   CHAT      party chat moderation (stage 3): 🚩 REPORTS (the reported line, the lines before it)
//             and every party's live chat, as its host's game sends it in (newest party first).
//             Tap a line: its speaker (matched to a card by party code and the room's player id the
//             line carries, never by name: names repeat, can be copied, and a line's went through
//             the chat filter; two cards claiming one id: nothing is done) can be muted for
//             10 min / 1 hour / 1 day, unmuted, messaged, or their chat log fetched. The tab's badge
//             counts new reports. Uploads are only "as that page reported them": one that wasn't
//             sealed by the page it names is marked ⚠. Every text here is escaped.
//   ACCOUNTS  everyone who made an account (never guests), newest first, from the account registry
//             (js/accounts/registry.js, js/admin/session.js accounts()); a NEW badge counts the ones
//             made since the tab was last opened, and a search box finds a name. Each row: the name
//             as a big button, and 🟢 online / 🚫 banned / ⚠ suspect, when it was made and last seen,
//             level and wins. Tap a name: a sheet with 🚫 BAN (an optional reason, then "are you
//             sure?"): the account (and its iPad) goes on the signed ban list, so it is banned at once
//             when online, else the next time it opens Phortnite; ✓ REMOVE BAN takes it off (a ban that
//             hasn't happened yet never does; an iPad already banned then needs the unban code typed
//             on it: REMOVE BAN first, the code after, or the game bans it again); online:
//             ✉ MESSAGE and 👢 KICK too. The admin's own accounts (on this iPad) can't be banned here.
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
const ACCTS_SHOWN = 100; // account rows drawn at first (SHOW MORE: the next ones; search finds any)
const OFF_SHOWN = 40; // PLAYERS → OFFLINE rows drawn at first (SHOW MORE: the next ones)
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

/** 'just now', '5 min ago', '3 h ago', '2 days ago' */
function since(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * An account row's small details (every value escaped or a number). brief: an OFFLINE row in
 * PLAYERS (banned, suspect, last seen, level, wins: its name says "(you)" for one on this iPad).
 */
function acctChips(a, now, brief = false) {
  const c = [];
  if (a.isNew && !brief) c.push('<span class="adm-anew">NEW</span>');
  if (a.online) c.push('<span class="adm-aon">🟢 online</span>');
  if (a.banned) c.push('<span class="adm-aban">🚫 banned</span>');
  if (a.suspect) c.push('<span class="adm-warn">⚠ suspect</span>');
  if (a.mine && !brief) c.push('<span>📱 this iPad</span>');
  if (a.gone) c.push('<span>not on the relay any more</span>');
  if (a.created && !brief) c.push(`<span>made ${since(now - a.created)}</span>`);
  if (a.seen && !a.online) c.push(`<span>seen ${since(now - a.seen)}</span>`);
  if (!a.gone) c.push(`<span>Lv ${a.level | 0}</span>`, `<span>🏆 ${a.wins | 0} win${a.wins === 1 ? '' : 's'}</span>`);
  return c.join('');
}

/** Does a name have the search box's text in it? (Case doesn't matter; an empty box: every name.) */
export function nameHas(name, q) {
  const f = String(q ?? '').trim().toLowerCase();
  return !f || String(name ?? '').toLowerCase().includes(f);
}

/**
 * PLAYERS → 📴 OFFLINE: the accounts (session accounts()) that aren't online right now, last seen
 * first (then newest made, then by name). Never one that is online (a.online, or a live card in
 * `players` carries its rid: it stays in the live rows only, never listed twice), never a gone one
 * (banned, its entry no longer on the relay: ACCOUNTS still has it), and never a guest (guests have
 * no account). q: the search box. DOM-free (test/adminplayers.test.mjs).
 */
export function offlineAccounts(accounts, players = [], q = '') {
  const live = new Set((players || []).map((p) => p && p.rid).filter(Boolean));
  return (accounts || []).filter((a) => a && a.rid && !a.online && !a.gone && !live.has(a.rid) && nameHas(a.name, q))
    .sort((a, b) => ((b.seen || 0) - (a.seen || 0)) || ((b.created || 0) - (a.created || 0))
      || String(a.name).localeCompare(String(b.name)) || String(a.rid).localeCompare(String(b.rid)));
}

function clock(t) {
  if (!(t > 0)) return '';
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}

/** The short summary chips of a player card (onList: its account is on the ban list). */
function metaHtml(p, now, onList = false) {
  const chips = [];
  if (onList) chips.push('🚫 On your ban list');
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
    this.plFind = ''; // the PLAYERS search box (live rows and OFFLINE)
    this.offShow = OFF_SHOWN;
    this.offKey = ''; // the totals line + OFFLINE as last drawn (drawn again only when it changed)
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
    // ACCOUNTS tab
    this.offAccts = null;
    this.acctFind = ''; // the search box
    this.acctShow = ACCTS_SHOWN;
    this.acctKey = ''; // the list as last drawn (drawn again only when it changed)
    this.acctSel = ''; // the account whose sheet is open
    this.acctForm = ''; // its open form: 'ban' | 'msg' | 'kick'
    this.acctNote = null; // { text, ok }: what the last action did, in the sheet
  }

  get session() { return this.app.admin; }

  /** 🛡 ADMIN: the panel (tab: 'players' | 'everyone' | 'chat' | 'accounts'). */
  open(tab = this.tab) {
    const app = this.app, s = this.session;
    if (!s) return;
    this.tab = ['everyone', 'chat', 'accounts'].includes(tab) ? tab : 'players';
    const html = `<div class="adm-panel">
      <div class="adm-head"><h2>🛡 ADMIN</h2><p class="adm-open-note">Every command is signed with the admin key, and players always see what the admin did.</p></div>
      <div class="adm-tabs" role="tablist">
        <button class="adm-tab" data-tab="players" role="tab" aria-label="Players">👥<span class="adm-tw"> PLAYERS</span> <b class="adm-count adm-pcount"></b></button>
        <button class="adm-tab" data-tab="everyone" role="tab" aria-label="Everyone">📢<span class="adm-tw"> EVERYONE</span></button>
        <button class="adm-tab" data-tab="chat" role="tab" aria-label="Chat">💬<span class="adm-tw"> CHAT</span> <b class="adm-count adm-rbadge hidden"></b></button>
        <button class="adm-tab" data-tab="accounts" role="tab" aria-label="Accounts">📇<span class="adm-tw"> ACCOUNTS</span> <b class="adm-count adm-nbadge hidden"></b></button>
      </div>
      <div class="adm-pane adm-players">
        <div class="adm-afindrow adm-pfindrow"><input class="adm-pfind" type="search" maxlength="16" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="🔍 Find a player" aria-label="Find a player"></div>
        <p class="adm-totals"></p>
        <ul class="adm-list"></ul>
        <p class="adm-pnone hidden"></p>
        <section class="adm-off">
          <h3 class="adm-offhead"></h3>
          <ul class="adm-olist"></ul>
          <p class="adm-hint adm-onote">Offline: everyone who has an account (once they've opened Phortnite 2.5 or newer). Tap a name to ban — it happens the next time they open the game.</p>
        </section>
      </div>
      <div class="adm-pane adm-everyone"></div>
      <div class="adm-pane adm-chat"></div>
      <div class="adm-pane adm-accts">
        <div class="adm-afindrow"><input class="adm-afind" type="search" maxlength="16" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="🔍 Find a name" aria-label="Find a name"></div>
        <p class="adm-atotals"></p>
        <ul class="adm-alist"></ul>
        <p class="adm-hint adm-anote">Everyone who made an account shows up here (guests never do): players are told when they make one. Tap a name to ban it, even while they're offline. Names live on the free public relay, sealed so only you can read them; if the relay forgets them, each one comes back the next time that player opens Phortnite.</p>
      </div>
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
      this.acctPane();
      this.playersPane();
      this.show(this.tab);
      this.renderPlayers();
      this.off = s.onPlayers(() => { this.renderPlayers(); if (this.tab === 'chat') this.renderChat(); });
      this.offChats = s.onChats ? s.onChats(() => this.renderChat()) : null;
      this.offAccts = s.onAccounts ? s.onAccounts(() => { this.renderAccounts(); this.renderOffline(); }) : null;
      this.badge();
      this.acctBadge();
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }, () => this.closed());
  }

  /** The panel went away (closed, or another modal took its place). */
  closed() {
    if (this.off) this.off();
    this.off = null;
    if (this.offChats) this.offChats();
    this.offChats = null;
    if (this.offAccts) this.offAccts();
    this.offAccts = null;
    this.acctKey = '';
    this.offKey = '';
    this.acctSel = '';
    this.acctForm = '';
    this.acctNote = null;
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

  /**
   * A name tapped after a search: the search box lets go (an iPad tap on a button leaves the focus
   * where it was), so its keyboard doesn't stay up over a sheet's or a row's buttons, and what is
   * typed next never goes into the hidden box behind them.
   */
  dropFind() {
    try {
      const f = document.activeElement;
      if (f && f.matches && f.matches('.adm-pfind, .adm-afind')) f.blur();
    } catch (e) { /* fine */ }
  }

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
    $('.adm-accts', this.root).classList.toggle('hidden', tab !== 'accounts');
    if (tab === 'players') { this.offKey = ''; this.renderPlayers(); }
    if (tab === 'everyone') this.stateNow();
    if (tab === 'chat') this.renderChat();
    if (tab === 'accounts') {
      // (opened now: the NEW badge goes; the rows made since it was last opened stay marked NEW)
      if (this.session.seenAccounts) this.session.seenAccounts({ fresh: true });
      this.acctKey = '';
      this.renderAccounts();
    }
    this.acctBadge();
  }

  tick() {
    if (!this.live()) return;
    this.renderPlayers();
    this.stateNow();
    this.badge();
    this.renderAccounts();
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
  /** The PLAYERS pane's search box and OFFLINE taps, once (OFFLINE rows come and go: delegated). */
  playersPane() {
    const pane = $('.adm-players', this.root);
    const find = $('.adm-pfind', pane);
    find.value = this.plFind;
    find.addEventListener('input', () => {
      this.plFind = find.value;
      this.offShow = OFF_SHOWN;
      this.renderPlayers();
      this.findTop(pane, '.adm-totals');
    });
    find.addEventListener('keydown', (e) => { if (e.key === 'Enter') find.blur(); });
    $('.adm-off', pane).addEventListener('click', (e) => {
      const name = e.target.closest('.adm-oname');
      if (name) { this.ui(); this.acctSheet(name.parentNode.dataset.rid); return; }
      if (e.target.closest('.adm-omore')) { this.ui(); this.offShow += OFF_SHOWN; this.renderOffline(); }
    });
  }

  /**
   * Typed in a search box while scrolled down: the top of the results (its totals line) comes back
   * just under the sticky box, never left mid-list with the first matches hidden above it (only
   * ever scrolls up: typing at the top moves nothing).
   */
  findTop(pane, totals) {
    const body = pane.closest('.modal-body'), bar = $('.adm-afindrow', pane), tot = $(totals, pane);
    if (!body || !bar || !tot) return;
    const d = tot.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
    if (d < 0) body.scrollTop += d;
  }

  /**
   * fn() redraws PLAYERS rows: the row at the top of the screen (just under the search box) stays
   * where it was, so live rows coming and going, or an OFFLINE row added above it, never slide a
   * different name under the admin's finger (Safari has no scroll anchoring). Only while scrolled.
   */
  keepPlace(fn) {
    const pane = $('.adm-players', this.root), body = pane.closest('.modal-body');
    if (!body || !body.scrollTop || this.tab !== 'players') { fn(); return; }
    const top = $('.adm-pfindrow', pane).getBoundingClientRect().bottom;
    let el = null, y = 0;
    for (const li of pane.querySelectorAll('.adm-row, .adm-orow')) {
      const r = li.getBoundingClientRect();
      if (r.bottom > top) { el = li; y = r.top; break; }
    }
    fn();
    const d = el && el.isConnected ? el.getBoundingClientRect().top - y : 0;
    if (d) body.scrollTop += d;
  }

  /** The live rows (the search box's matches), then the totals line and OFFLINE (drawOffline). */
  renderPlayers() {
    if (!this.live()) return;
    this.keepPlace(() => this.drawPlayers());
  }

  drawPlayers() {
    const s = this.session, now = Date.now();
    const all = s.players();
    const list = all.filter((p) => nameHas(p.name, this.plFind));
    const banned = new Set(s.bans ? s.bans().map((b) => b.r) : []);
    $('.adm-pcount', this.root).textContent = String(s.totals().total);
    const q = this.plFind.trim(), none = $('.adm-pnone', this.root);
    none.classList.toggle('hidden', !!list.length || !q);
    none.textContent = list.length || !q ? '' : `No one playing now has “${q}” in their name.`;
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
      $('.adm-meta', li).innerHTML = metaHtml(p, now, !!p.rid && banned.has(p.rid))
        + (p.suspect ? '<span class="adm-warn">⚠ Someone may be faking this card: your commands only reach the real player</span>' : '');
      li.classList.toggle('sel', p.id === this.sel);
      if (p.id === this.sel) this.actions(li, p);
    }
    for (const [id, li] of rows) if (!seen.has(id)) li.remove();
    if (this.sel && !seen.has(this.sel)) {
      // (still online, but the search box hides them: their row just closes)
      if (!all.some((p) => p.id === this.sel)) this.status('That player left.', false);
      this.sel = '';
      this.form = '';
      this.actsKey = '';
    }
    this.drawOffline();
  }

  /** OFFLINE again (the accounts changed, SHOW MORE), the row on screen kept in place. */
  renderOffline() {
    if (!this.live() || this.tab !== 'players') return;
    this.keepPlace(() => this.drawOffline());
  }

  /**
   * The totals line and 📴 OFFLINE (offlineAccounts: everyone with an account who isn't online, last
   * seen first). The search box, a live form and the open account sheet are never touched, so
   * nothing takes the focus or what is typed. The rows are kept by rid, like the live ones: a clock
   * tick only rewrites a row's small details ("seen 5 min ago"), never its name button, so a tap
   * never lands on a button drawn anew mid-tap (or, the rows shifting, on someone else's).
   */
  drawOffline() {
    if (this.tab !== 'players') return;
    const s = this.session, now = Date.now(), t = s.totals();
    const missing = t.total - t.cards;
    const accts = s.accounts ? s.accounts() : null;
    const off = accts ? offlineAccounts(accts, s.players()) : [];
    const totals = `<b>${t.total}</b> playing now · <b>${t.inMatch}</b> in a match · <b>${t.inLobby}</b> in the lobby · <b>${t.parties}</b> ${t.parties === 1 ? 'party' : 'parties'}`
      + (accts ? ` · <b>${off.length}</b> offline` : '')
      + (missing > 0 ? `<small>${missing} without a player card yet (still connecting, or an older version of the game)</small>` : '');
    let head = '', empty = '', shown = [], more = 0;
    if (accts) {
      const q = this.plFind.trim();
      const list = q ? off.filter((a) => nameHas(a.name, q)) : off;
      const st = s.accountStats ? s.accountStats() : { waiting: 0 };
      head = `📴 OFFLINE · ${q ? `${list.length} of ${off.length}` : off.length}${st.waiting && off.length ? `<small>${st.waiting} more being read…</small>` : ''}`;
      if (!off.length) empty = st.waiting ? 'Reading the accounts…' : 'No offline accounts yet. Everyone who makes an account shows up here, even when they\'re not playing.';
      else if (!list.length) empty = `No offline account has “${q}” in its name.`;
      else { shown = list.slice(0, this.offShow); more = list.length - shown.length; }
    }
    const pane = $('.adm-players', this.root);
    const key = `${totals}|${head}|${!!accts}`;
    if (key !== this.offKey) {
      this.offKey = key;
      $('.adm-totals', pane).innerHTML = totals;
      $('.adm-off', pane).classList.toggle('hidden', !accts);
      $('.adm-offhead', pane).innerHTML = head;
    }
    const ul = $('.adm-olist', pane);
    let note = $('.adm-aempty', ul), moreLi = $('.adm-amorerow', ul);
    if (empty) { // (nothing to list: that one line, as text)
      for (const li of [...ul.children]) if (li !== note) li.remove();
      if (!note) { note = document.createElement('li'); note.className = 'adm-aempty'; ul.appendChild(note); }
      if (note.textContent !== empty) note.textContent = empty;
      return;
    }
    if (note) note.remove();
    const rows = new Map([...ul.children].filter((li) => li.dataset.rid).map((li) => [li.dataset.rid, li]));
    const keep = new Set();
    let prev = null;
    for (const a of shown) {
      keep.add(a.rid);
      let li = rows.get(a.rid);
      if (!li) {
        li = document.createElement('li');
        li.dataset.rid = a.rid;
        const b = document.createElement('button'), meta = document.createElement('div');
        b.className = 'adm-oname';
        meta.className = 'adm-ameta';
        li.appendChild(b);
        li.appendChild(meta);
      }
      if (prev ? prev.nextSibling !== li : ul.firstChild !== li) ul.insertBefore(li, prev ? prev.nextSibling : ul.firstChild);
      prev = li;
      const cls = `adm-orow${a.banned ? ' banned' : ''}${a.suspect ? ' suspect' : ''}`;
      if (li.className !== cls) li.className = cls;
      const nm = `${esc(a.name)}${a.mine ? ' <small>(you)</small>' : ''}`, chips = acctChips(a, now, true);
      if (li.dataset.nm !== nm) { li.dataset.nm = nm; $('.adm-oname', li).innerHTML = nm; }
      if (li.dataset.chips !== chips) { li.dataset.chips = chips; $('.adm-ameta', li).innerHTML = chips; }
    }
    for (const [rid, li] of rows) if (!keep.has(rid)) li.remove();
    if (!more) { if (moreLi) moreLi.remove(); return; }
    if (!moreLi) {
      moreLi = document.createElement('li');
      moreLi.className = 'adm-amorerow';
      const b = document.createElement('button');
      b.className = 'btn adm-omore';
      moreLi.appendChild(b);
    }
    if (ul.lastChild !== moreLi) ul.appendChild(moreLi);
    const label = `SHOW ${Math.min(OFF_SHOWN, more)} MORE (${more} not shown)`, mb = $('.adm-omore', moreLi);
    if (mb.textContent !== label) mb.textContent = label;
  }

  pick(id) {
    this.ui();
    this.dropFind();
    if (this.sel === id) { this.sel = ''; this.form = ''; } else { this.sel = id; this.form = ''; }
    this.actsKey = '';
    for (const li of this.root.querySelectorAll('.adm-row')) {
      const on = li.dataset.id === this.sel;
      li.classList.toggle('sel', on);
      if (!on) { const a = $('.adm-acts', li); a.classList.add('hidden'); a.innerHTML = ''; }
    }
    this.renderPlayers();
    const li = this.sel && this.root.querySelector(`.adm-row[data-id="${this.sel}"]`);
    if (li) this.reveal(li);
  }

  /**
   * A live row or its form into sight, never behind the sticky search box (scrollIntoView knows
   * nothing about it, and Chrome ignores scroll-margin for 'nearest'): its bottom up into view, but
   * never its top above the box's bottom edge (taller than the room left: its top shows).
   */
  reveal(el, smooth = false) {
    const pane = $('.adm-players', this.root), body = pane && pane.closest('.modal-body'), bar = pane && $('.adm-pfindrow', pane);
    if (!body || !bar || !el.isConnected) return;
    const b = body.getBoundingClientRect(), r = el.getBoundingClientRect();
    const top = b.top + bar.offsetHeight + 8; // (the box's bottom edge, once it sticks)
    const d = Math.min(r.bottom > b.bottom ? r.bottom - b.bottom : 0, r.top - top);
    if (!d) return;
    try { body.scrollBy({ top: d, behavior: smooth ? 'smooth' : 'auto' }); } catch (e) { body.scrollTop += d; }
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
      case 'ban': {
        const acct = this.banTarget(p);
        f.innerHTML = `<input class="adm-in" maxlength="120" placeholder="Why? (optional, they see it)">
          ${sure(acct ? `Ban ${name}'s iPad and their account <b>${esc(acct.name)}</b>? It goes on your ban list: every iPad with that account shows the ban screen, now or the next time it opens Phortnite, until you tap ✓ REMOVE BAN (📇 ACCOUNTS) and then type your unban code in on it.${hostNote}`
            : `Ban ${name}'s iPad? It shows the ban screen until Philip's unban code is typed in. (${p.account === 'guest' ? 'A guest: only this iPad.' : 'Only this iPad: no account of theirs can go on your ban list from here.'})${hostNote}`, '🚫 BAN', 'danger')}`;
        break;
      }
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
        case 'ban': this.banPlayer(p, v); break;
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
    requestAnimationFrame(() => { if (this.root) this.reveal(f, true); });
  }

  /**
   * PLAYERS → 🚫 BAN: the account a player is signed in to (its rid proven by their card, js/admin/
   * session.js), when it can go on the ban list: { rid, did, name } | null (a guest, the admin's own,
   * a card someone may be faking, an older game without a rid).
   */
  banTarget(p) {
    const s = this.session;
    if (!s || !s.banAccount || !p || p.me || p.suspect || !p.rid) return null;
    const row = s.accounts ? s.accounts().find((a) => a.rid === p.rid) : null;
    if (row && row.mine) return null;
    return { rid: p.rid, did: row ? row.did : '', name: row ? row.name : p.name };
  }

  /**
   * PLAYERS → 🚫 BAN: a signed-in player's account goes on the ban list (banAccount sends their page
   * the live ban too), like ACCOUNTS → BAN, so both buttons do the same; a guest's iPad gets the
   * live ban only. When the list can't take it (full), the live ban still goes and the status says why.
   */
  async banPlayer(p, reason) {
    const s = this.session, acct = this.banTarget(p);
    if (!acct) { this.send('ban', { reason }, p, 'a ban'); return; }
    let r = null, err = '';
    try { r = await s.banAccount(acct.rid, { did: acct.did, reason, name: acct.name }); } catch (e) { err = (e && e.message) || ''; }
    if (r) {
      this.status(`✓ Sent a ban to ${p.name}, and their account ${acct.name} is on your ban list: every iPad with it is banned, now or the next time it opens Phortnite.`);
      this.toast(`🚫 <b>${esc(acct.name)}</b> is banned.`);
    } else if (err) {
      const res = await this.send('ban', { reason }, p, 'a ban');
      this.status(`${res.text} The account couldn't go on the ban list: ${err}`, res.ok);
    } else this.status('✕ Not sent: the admin channel is offline right now. Try again in a moment.', false);
  }

  grant(p, xp) {
    if (!(xp >= 1 && xp <= MAX_XP)) { this.status(`Give between 1 and ${MAX_XP} XP.`, false); return; }
    this.send('grant', { xp }, p, `${xp} XP`);
    this.form = '';
    this.actsKey = '';
    this.renderPlayers();
  }

  /** Sign and send a command to one player's page; the status line says what went out. -> { ok, text } */
  async send(cmd, args, p, what) {
    const s = this.session;
    if (!s) return { ok: false, text: '' };
    let env = null, err = '';
    try { env = await s.send(cmd, args, p.id); } catch (e) { env = null; err = (e && e.message) || ''; }
    const text = env ? `✓ Sent ${what} to ${p.name}. (If their iPad is offline right now it won't get it.)`
      : err ? `✕ ${err}` : '✕ Not sent: the admin channel is offline right now. Try again in a moment.';
    this.status(text, !!env);
    return { ok: !!env, text };
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
    const n = this.session.unseenReports() | 0;
    const b = $('.adm-rbadge', this.root);
    b.classList.toggle('hidden', !n);
    // (the word goes with the tab's word on a narrow screen: the red badge alone says it)
    b.innerHTML = n ? `<span class="adm-tw">🚩 </span>${n > 99 ? '99+' : n}` : '';
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

  /**
   * Who said chat line l in party `code`: the card whose party.pid is the room player id the line
   * carries. -> { card } | { many: [card] } (more than one card claims it: someone fakes one, so the
   * panel acts on none) | null. Never by name: two kids can have the same one ('Guest'), a bully
   * can copy someone's, and a line's name went through the chat filter (★, [hidden]).
   */
  speaker(code, l) {
    if (!l || l.sys || l.admin || !this.session || !(l.id > 0) || !/^[A-Z]{4}$/.test(code)) return null;
    const hits = this.session.players().filter((c) => c.party && c.party.code === code && c.party.pid === l.id);
    return hits.length === 1 ? { card: hits[0] } : hits.length ? { many: hits } : null;
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
          : '<p class="adm-now">No reports. When a player taps 🚩 Report to admin on a chat line while you\'re in admin mode, it shows up here (one made while this page is closed is lost: nothing keeps reports).</p>'}</section>
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

  /** The open line's buttons: for its speaker's card (matched by party code + room player id). */
  lineActs(code, l) {
    const s = this.speaker(code, l);
    if (s && s.many) return `<div class="adm-lacts"><p class="adm-hint">⚠ ${s.many.length} player cards in party ${esc(code)} say they are the one who said this (an old card from a reload that hasn't gone yet, or someone faking one), so nothing can be done from here right now. Try again in a minute, or look for ${esc(l.name)} in PLAYERS.</p></div>`;
    const c = s && s.card;
    if (!c) return `<div class="adm-lacts"><p class="adm-hint">${esc(l.name)} isn't online in ${code === 'SOLO' ? 'a party' : `party ${esc(code)}`} with a player card right now (they left that party).</p></div>`;
    if (c.me) return '<div class="adm-lacts"><p class="adm-hint">That\'s you.</p></div>';
    const muted = c.muted > Date.now();
    const b = (act, label, extra = '', cls = '') => `<button class="btn adm-la ${cls}" data-act="${act}"${extra}>${label}</button>`;
    return `<div class="adm-lacts" data-id="${esc(c.id)}">
      <p class="adm-lwho"><b>${esc(c.name)}</b>${c.name !== l.name ? ` (in chat: ${esc(l.name)})` : ''} · Lv ${c.level | 0}${c.party && c.party.code ? ` · ${c.party.kind === 'host' ? '👑 hosting' : '🎉 in'} ${esc(c.party.code)}` : ''}${muted ? ` · 🔇 muted until ${esc(clock(c.muted))}` : ''}</p>
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
    const s = sel && this.speaker(sel.code, sel.line), c = s && s.card;
    if (!c) { this.status(s && s.many ? '✕ More than one player card claims that line: use PLAYERS.' : 'That player is not online with a card right now.', false); return; }
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
    this.acctSel = '';
    this.acctForm = '';
    this.acctNote = null;
    this.sheetKey = '';
  }

  // ------------------------------------------------------------------ ACCOUNTS
  /** The ACCOUNTS tab's badge: accounts made since the tab was last opened. */
  acctBadge() {
    if (!this.root || !this.session || !this.session.newAccounts) return;
    const n = this.tab === 'accounts' ? 0 : this.session.newAccounts() | 0;
    const b = $('.adm-nbadge', this.root);
    b.classList.toggle('hidden', !n);
    // (the word goes with the tab's word on a narrow screen: the yellow badge alone says it)
    b.innerHTML = n ? `<span class="adm-tw">NEW </span>${n > 99 ? '99+' : n}` : '';
  }

  /** The ACCOUNTS pane's search box and taps, once (the list is drawn again and again: delegated). */
  acctPane() {
    const pane = $('.adm-accts', this.root);
    const find = $('.adm-afind', pane);
    find.value = this.acctFind;
    find.addEventListener('input', () => { this.acctFind = find.value; this.acctShow = ACCTS_SHOWN; this.renderAccounts(); this.findTop(pane, '.adm-atotals'); });
    find.addEventListener('keydown', (e) => { if (e.key === 'Enter') find.blur(); });
    pane.addEventListener('click', (e) => {
      const name = e.target.closest('.adm-aname');
      if (name && pane.contains(name)) { this.ui(); this.acctSheet(name.parentNode.dataset.rid); return; }
      if (e.target.closest('.adm-amore')) { this.ui(); this.acctShow += ACCTS_SHOWN; this.renderAccounts(); }
    });
  }

  /** The ACCOUNTS list, from the session's accounts() (drawn again only when what it shows changed). */
  renderAccounts() {
    if (!this.live() || !this.session.accounts) return;
    this.acctBadge();
    if (this.sheetEl && this.acctSel) this.drawAcctSheet();
    if (this.tab !== 'accounts') return;
    const s = this.session, now = Date.now();
    s.seenAccounts({ fresh: false }); // (looking at it: nothing is "new since last time" for the badge)
    const all = s.accounts();
    const q = this.acctFind.trim().toLowerCase();
    const list = q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all;
    const st = s.accountStats ? s.accountStats() : { waiting: 0 };
    const online = all.filter((a) => a.online).length, banned = all.filter((a) => a.banned).length;
    let totals = all.length ? `<b>${all.length}</b> account${all.length === 1 ? '' : 's'} · <b>${online}</b> online now · <b>${banned}</b> banned` : '';
    if (st.waiting) totals += `<small>${st.waiting} more being read…</small>`;
    let html;
    if (!all.length) html = `<li class="adm-aempty">${st.waiting ? 'Reading the accounts…' : 'No accounts yet. When someone makes an account it shows up here.'}</li>`;
    else if (!list.length) html = `<li class="adm-aempty">No account name has “${esc(q)}” in it.</li>`;
    else {
      const shown = list.slice(0, this.acctShow);
      html = shown.map((a) => `<li class="adm-arow${a.banned ? ' banned' : ''}${a.suspect ? ' suspect' : ''}" data-rid="${esc(a.rid)}">`
        + `<button class="adm-aname">${esc(a.name)}</button><div class="adm-ameta">${acctChips(a, now)}</div></li>`).join('')
        + (list.length > shown.length ? `<li class="adm-amorerow"><button class="btn adm-amore">SHOW ${Math.min(ACCTS_SHOWN, list.length - shown.length)} MORE (${list.length - shown.length} not shown)</button></li>` : '');
    }
    const key = totals + html;
    if (key === this.acctKey) return;
    this.acctKey = key;
    const pane = $('.adm-accts', this.root);
    $('.adm-atotals', pane).innerHTML = totals;
    $('.adm-alist', pane).innerHTML = html;
  }

  /** Tap a name: its sheet (over the panel, its own CLOSE). */
  acctSheet(rid) {
    const s = this.session;
    const a = s && s.accounts().find((x) => x.rid === rid);
    if (!a) return;
    this.dropFind();
    const el = this.sheet(a.name, '<div class="adm-acard"></div>');
    this.acctSel = rid;
    el.classList.add('adm-asheet');
    el.dataset.rid = rid;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-aact]');
      if (b && el.contains(b) && !b.disabled) { this.ui(); this.acctAct(b.dataset.aact); }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      if (this.acctForm === 'ban') this.acctAct('banyes');
      else if (this.acctForm === 'kick') this.acctAct('kickyes');
    });
    this.drawAcctSheet(true);
  }

  /** The open account sheet, drawn from accounts() (not while the admin types in it, unless force). */
  drawAcctSheet(force = false) {
    const el = this.sheetEl, s = this.session;
    if (!el || !el.isConnected || el.dataset.rid !== this.acctSel || !s) return;
    const body = $('.adm-acard', el);
    const act = document.activeElement;
    if (!force && act && body.contains(act) && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA')) return;
    const a = s.accounts().find((x) => x.rid === this.acctSel);
    if (!a) {
      body.innerHTML = '<p class="adm-now">This account isn\'t listed any more: its entry was deleted from the relay (the account was deleted on its iPad).</p>';
      return;
    }
    const card = a.online ? s.players().find((c) => c.rid === a.rid && !c.me) : null;
    const now = Date.now(), name = esc(a.name);
    $('h3', el).textContent = `📇 ${a.name}`;
    const b = (act2, label, cls = '') => `<button class="btn adm-aact ${cls}${this.acctForm === act2 ? ' on' : ''}" data-aact="${act2}">${label}</button>`;
    const bits = [];
    if (!a.gone) bits.push(`${a.matches | 0} match${a.matches === 1 ? '' : 'es'}`, `${a.kills | 0} elimination${a.kills === 1 ? '' : 's'}`);
    if (a.v) bits.push(`game v${esc(a.v)}`);
    if (a.did) bits.push(`iPad ${esc(a.did.slice(0, 4))}…`);
    let html = `<div class="adm-ameta adm-adet">${acctChips(a, now)}</div>${bits.length ? `<p class="adm-hint">${bits.join(' · ')}</p>` : ''}`;
    if (a.suspect) html += '<p class="adm-warn">⚠ Someone put a made-up entry for this account on the public relay. It was ignored: what you see here came from the account\'s own iPad.</p>';
    if (a.banned) html += `<p class="adm-now adm-abanned">🚫 On your ban list${a.bannedAt ? ` since ${since(now - a.bannedAt)}` : ''}${a.reason ? `: “${esc(a.reason)}”` : '.'}</p>`;
    if (this.acctNote) html += `<p class="adm-ares ${this.acctNote.ok === null ? '' : this.acctNote.ok ? 'ok' : 'bad'}"></p>`;
    if (a.mine) html += '<p class="adm-now">📱 This account is on this iPad (yours), so it can\'t be banned from here.</p>';
    else {
      html += `<div class="adm-aacts">${card ? b('msg', '✉ MESSAGE') + b('kick', '👢 KICK') : ''}${a.banned ? b('unban', '✓ REMOVE BAN', 'yellow') : b('ban', '🚫 BAN', 'danger')}</div>`;
      if (a.banned) {
        html += '<p class="adm-hint">To let them play again: ① tap ✓ REMOVE BAN here first, ② then, if their iPad already shows the ban screen, type your unban code in on it. '
          + 'The code alone doesn\'t last while they\'re on this list: Phortnite bans that iPad again as soon as it opens. '
          + '(REMOVE BAN stops a ban that hasn\'t happened yet, almost always: an older ban list someone puts back on the relay can still reach an iPad that hasn\'t opened Phortnite since.)</p>';
      }
      else if (!card) html += '<p class="adm-hint">Not online right now: a ban happens the next time they open Phortnite.</p>';
      const sure = (text, label) => `<p class="adm-q">${text}</p><div class="adm-btns2"><button class="btn danger" data-aact="${label[0]}">${label[1]}</button><button class="btn" data-aact="no">CANCEL</button></div>`;
      if (this.acctForm === 'ban') {
        html += `<div class="adm-form"><input class="adm-in adm-areason" maxlength="120" placeholder="Why? (optional${card ? ', they see it' : ''})">`
          + sure(`Ban <b>${name}</b>? ${card ? 'Their iPad shows the ban screen right now' : 'Their iPad shows the ban screen the next time they open Phortnite'}, and stays banned until you tap ✓ REMOVE BAN here and then type your unban code in on it.`, ['banyes', '🚫 YES, BAN'])
          + '</div>';
      } else if (this.acctForm === 'kick' && card) {
        html += `<div class="adm-form"><input class="adm-in adm-areason" maxlength="120" placeholder="Why? (optional, they see it)">${sure(`Take <b>${name}</b> out of their party or match, back to the lobby?`, ['kickyes', '👢 KICK'])}</div>`;
      } else if (this.acctForm === 'msg' && card) {
        html += `<div class="adm-form"><textarea class="adm-in adm-amsg" maxlength="300" rows="2" placeholder="Message for ${name}"></textarea>`
          + `<div class="adm-btns2"><button class="btn yellow" data-aact="msgsend">✉ SEND</button><button class="btn" data-aact="no">CANCEL</button></div></div>`;
      }
    }
    // (the same as on screen: left alone; else drawn again with what was typed kept)
    const key = `${html}|${this.acctNote ? this.acctNote.text : ''}`;
    if (!force && key === this.sheetKey) return;
    this.sheetKey = key;
    const typed = {};
    if (this.drawnForm === this.acctForm) for (const i of body.querySelectorAll('.adm-areason, .adm-amsg')) typed[i.className] = i.value;
    this.drawnForm = this.acctForm;
    body.innerHTML = html;
    for (const i of body.querySelectorAll('.adm-areason, .adm-amsg')) if (typed[i.className]) i.value = typed[i.className];
    const note = $('.adm-ares', body);
    if (note) note.textContent = this.acctNote.text;
    // (like the PLAYERS forms: only a message box takes the focus, never an optional reason, so no
    // keyboard comes up over the question and its buttons; the form is scrolled into sight)
    const msg = $('.adm-amsg', body), form = $('.adm-form', body);
    if (msg && force) setTimeout(() => { try { if (msg.isConnected) msg.focus(); } catch (e) { /* fine */ } }, 30);
    if (form && force) requestAnimationFrame(() => { try { if (form.isConnected) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* fine */ } });
  }

  /** A button in the account sheet. */
  async acctAct(act) {
    const s = this.session, el = this.sheetEl;
    if (!s || !el) return;
    const a = s.accounts().find((x) => x.rid === this.acctSel);
    if (!a) return;
    const card = s.players().find((c) => c.rid === a.rid && !c.me) || null;
    const val = (sel) => { const i = $(sel, el); return i ? i.value.trim() : ''; };
    switch (act) {
      case 'ban': case 'msg': case 'kick':
        this.acctForm = this.acctForm === act ? '' : act;
        this.acctNote = null;
        break;
      case 'no': this.acctForm = ''; break;
      case 'banyes': {
        if (this.acctBusy) return;
        this.acctBusy = true;
        const reason = val('.adm-areason');
        let r = null, err = '';
        try { r = await s.banAccount(a.rid, { did: a.did, reason, name: a.name }); } catch (e) { err = (e && e.message) || ''; } finally { this.acctBusy = false; }
        if (r) {
          const text = r.online ? `${a.name} is banned.` : `${a.name} will be banned the next time they open Phortnite.`;
          this.acctForm = '';
          this.acctNote = { text: `✓ ${text}`, ok: true };
          this.status(`✓ ${text}`);
          this.toast(r.online ? `🚫 <b>${esc(a.name)}</b> is banned.` : `🚫 <b>${esc(a.name)}</b> will be banned the next time they open Phortnite.`);
        } else this.acctNote = { text: err ? `✕ ${err}` : '✕ Not sent: the admin channel is offline right now. Try again in a moment.', ok: false };
        break;
      }
      case 'unban': {
        if (this.acctBusy) return;
        this.acctBusy = true;
        const already = !!a.bannedLive; // (the ban reached their page online: that iPad IS banned)
        let env = null, err = '';
        try { env = await s.unbanAccount(a.rid); } catch (e) { err = (e && e.message) || ''; } finally { this.acctBusy = false; }
        if (env && already) {
          const text = `${a.name} is off your ban list, but their iPad is already banned: type your unban code in on it to let them back in.`;
          this.acctNote = { text, ok: null };
          this.status(text);
          this.toast(`<b>${esc(a.name)}</b> is off your ban list, but their iPad is already banned: type your unban code in on it.`);
        } else if (env) {
          const text = `${a.name} is off your ban list: they won't be banned when they next open Phortnite. (If their iPad already shows the ban screen, type your unban code in on it.)`;
          this.acctNote = { text: `✓ ${text}`, ok: true };
          this.status(`✓ ${text}`);
          this.toast(`✓ <b>${esc(a.name)}</b> is off your ban list. (If their iPad already shows the ban screen, type your unban code in on it.)`);
        } else this.acctNote = { text: err ? `✕ ${err}` : '✕ Not sent: the admin channel is offline right now. Try again in a moment.', ok: false };
        break;
      }
      case 'msgsend': {
        const text = val('.adm-amsg');
        if (!card) { this.acctNote = { text: `✕ ${a.name} isn't online right now.`, ok: false }; break; }
        if (!text) { const i = $('.adm-amsg', el); if (i) i.focus(); return; }
        const r = await this.send('message', { text }, card, 'a message');
        this.acctNote = r;
        if (r.ok) this.acctForm = '';
        break;
      }
      case 'kickyes': {
        if (!card) { this.acctNote = { text: `✕ ${a.name} isn't online right now.`, ok: false }; break; }
        const r = await this.send('kick', { reason: val('.adm-areason') }, card, 'a kick');
        this.acctNote = r;
        if (r.ok) this.acctForm = '';
        break;
      }
      default: return;
    }
    this.drawAcctSheet(true);
  }

  /** A short toast over the panel (the lobby's): html is trusted markup with escaped values. */
  toast(html) {
    const lobby = this.app.lobby;
    try { if (lobby && lobby.toast) lobby.toast(html, { ms: 5000 }); } catch (e) { /* the sheet says it too */ }
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
