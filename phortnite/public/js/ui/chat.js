// The party chat on screen (app.chat, made in main.js): the chat drawer (the lobby and matches
// alike), the lobby's 💬 CHAT button badge, the HUD's 💬 button and the small fading feed in a
// match. The lines themselves live in a ChatLog (js/chat/chatLog.js, DOM-free); the party's Game
// hands them over through its ChatClient plugin (js/game/chatClient.js). The room's chat plugin
// (shared/plugins/chat.js) cleans and rate-limits every line; this page cleans them again before
// showing them (shared/chatFilter.js), and always draws them with textContent, never as markup.
//
// API (the admin's page side, js/admin/client.js, relies on exactly this):
//   lines()                 copies of the newest 100 lines this page has seen this page load (all
//                           parties): {id, name, text, ts, q?, admin?, code, at, sys?}
//   onLine(fn) -> off       fn(line, game) for every chat line the page receives (its own too; a
//                           welcome's history is kept but never announced as new)
//   setMute(until, reason)  the admin's mute: until = ms epoch (0 or past clears); kept in
//                           localStorage ('phortnite.chatMute'); the drawer says "🔇 The admin
//                           muted your chat until HH:MM" (+ the reason) meanwhile, and its quick
//                           chat and input step aside (the list keeps their room: still readable)
//   muted()                 {until, reason} | null
//   notice(text)            a system line in this party's list ('🛡 The admin looked at this chat')
//   open() / close() / isOpen() / toggle()
//   send(text) / quick(q)   false when muted, Chat is Off (or Quick chat only for free text),
//                           rate-limited here, or there is no party connection
// Moderation is open: the drawer always says that the admin (Philip) can read chats, and how to
// tell his lines: only they have the 🛡 ADMIN tag (an element of its own, in the drawer and the
// feed alike; a player's name can't hold the 🛡 or read "Admin": shared/chatFilter.js playerName).
// The admin's lines are signed: watching a party, his page sends each line with a signed {cmd:
// 'say', args: {code, text}} (app.admin.sayEnvelope), and this page shows the 🛡 ADMIN tag only
// when that signature checks out against admin.json (js/admin/commands.js adminLineOk). The room
// runs on the host's page, so its admin: true alone proves nothing: a claim that fails shows as
// 'Player' (and can be hidden or reported like anyone's). Lines stay in the order they came: one
// that claims to be the admin's waits for its check, and the lines after it wait for it.
//
// The Chat setting (menu.js, settings.chat): 'on' (default) | 'quick' (only QUICK_CHAT can be
// sent; other players' free text shows as "💬 (message hidden: quick chat only)") | 'off' (no
// CHAT button, feed or badge, nothing shown; lines() still keeps them for the admin's chat log).
// Keyboard: Enter opens the chat (T too on the lobby stage: in a match T dances), Enter sends,
// Escape closes; keys pressed in the drawer never reach the game (their release does, so a key
// held while tapping a chip is let go). Touches outside the drawer still play the game (and put
// the iPad's keyboard away), which keeps running while the chat is open.
import { SKINS } from '../../shared/constants.js';
import { QUICK_CHAT, MAX_CHAT, cleanChat, quickText } from '../../shared/chatFilter.js';
import { ChatLog, Limiter, chatMode, lineView, sendBlock, muteText, cleanCode } from '../chat/chatLog.js';
import { adminLineOk } from '../admin/commands.js';
import { importPublic } from '../admin/keys.js';

const SAFETY = 'Chat with your party. Be kind! 🛡 The admin (Philip) can read chats to keep everyone safe. Never share your real name, address, school or phone number.';
// how to tell the real admin (a player's name can't look like his: js/chat/chatLog.js playerName)
const SAFETY_TRUST = 'The real admin always has the 🛡 ADMIN tag, and never asks for them.';
// a short drawer (a phone on its side, the keyboard up): both points in two lines, never cut off,
// and (tight, not tiny) the tag in a third
const SAFETY_SHORT = '🛡 Philip (the admin) can read chats. Never share your name, address, school or phone.';
const TRUST_SHORT = 'Only the real admin has the 🛡 ADMIN tag.';
const FEED_MAX = 4; // lines in the in-match feed
const FEED_MS = 8000; // a feed line fades after this long
const STATUS_MS = 4500; // a short hint ('Slow down a little!') stays this long
// a report is published, not delivered: UP_TOPIC is not retained, so only an admin page that is
// open right now hears it (js/admin/client.js report). Never promise more than that.
const REPORTED = 'Sent to the admin. Thanks for keeping it fun! Philip gets it if he is online right now. If someone is mean, hide them and tell a grown-up.';
const REPORTED_MS = 9000;
const NAME_COLORS = ['#7cf2ff', '#ffd23f', '#8dff97', '#ff9ad5', '#ffb86b', '#c9a6ff', '#7fd6ff', '#ffe86b'];
const ADMIN_COLOR = '#8fd3ff';
const BLOCKED = {
  off: 'Chat is off. Turn it on in ⚙ Settings.',
  quickonly: 'Quick chat only is on: tap a quick message (change it in ⚙ Settings).',
  offline: 'You are not connected to a party right now.',
};

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/** text with its masked parts (★★★, [hidden]) in their own dim spans: textContent only. */
function fillText(node, text) {
  for (const part of String(text).split(/(\[hidden\]|★+)/)) {
    if (!part) continue;
    if (part === '[hidden]' || part[0] === '★') el('i', 'ch-mask', node).textContent = part;
    else node.appendChild(document.createTextNode(part));
  }
}

export class Chat {
  constructor(app) {
    this.app = app;
    this.log = new ChatLog({ storage: safeStorage() });
    this.limiter = new Limiter();
    this.mode = chatMode(app.settings);
    this.opened = false;
    this.game = null; // the Game whose party the drawer shows
    this.code = 'SOLO';
    this.status = null; // { text, kind, until }
    this.rows = new WeakMap(); // drawer row -> its stored line
    this.reported = new WeakSet();
    this.inQ = Promise.resolve(); // lines waiting for an admin signature check (and those after it)
    this.inWait = 0;
    this.outQ = Promise.resolve(); // the admin's own lines, signed one after the other
    this.pubP = null; // Promise<admin.json's sign.pub CryptoKey | null>
    this.build();
    this.bind();
    this.applySettings();
    this.muteTimer = 0;
    this.armMute();
  }

  // ------------------------------------------------------------------ API
  lines() { return this.log.lines(); }

  onLine(fn) { return this.log.onLine(fn); }

  muted() { return this.log.muted(); }

  setMute(until, reason = '') {
    this.log.setMute(until, reason);
    this.armMute();
    this.renderControls();
    this.renderHint();
  }

  notice(text) {
    const line = this.log.notice(text, this.code);
    if (!line) return;
    this.log.count(line, { open: this.opened, mode: this.mode });
    if (this.opened) this.appendRow(line);
    this.feedLine(line, false);
    this.badges();
  }

  isOpen() { return this.opened; }

  toggle() { if (this.opened) this.close(); else this.open(); }

  /** Open the drawer. opts.focus: put the cursor in the input (a key opened it; else desktop only). */
  open(opts = {}) {
    const app = this.app;
    if (this.mode === 'off') { this.say(BLOCKED.off); return false; }
    if (this.opened) { if (opts.focus) this.focus(); return true; }
    this.opened = true;
    document.body.classList.add('chat-open');
    this.root.classList.remove('hidden');
    this.clearFeed();
    this.renderAll();
    this.log.markRead();
    this.badges();
    this.place();
    // (the pointer is free to tap; main.js doesn't pause for this: the game keeps running)
    if (app.input && !app.input.touchMode) app.input.exitLock();
    if (opts.focus || (app.input && !app.input.touchMode)) this.focus();
    this.moveToasts();
    return true;
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.hideMenu();
    if (document.activeElement === this.el.input) this.el.input.blur();
    this.root.classList.add('hidden');
    document.body.classList.remove('chat-open');
    this.moveToasts();
  }

  /** Send a free-text line (cleaned here first: masked words never leave this page). */
  send(text) {
    const c = cleanChat(String(text ?? '').slice(0, MAX_CHAT * 4));
    if (!c.text) return false;
    const why = this.block(false);
    if (why) { this.blocked(why); return false; }
    const r = this.limiter.take(c.text, Date.now());
    if (r !== 'ok') { this.setStatus(r === 'dup' ? 'You just said that 🙂' : 'Slow down a little!', 'slow'); return false; }
    this.post({ t: 'chat', text: c.text }, c.text);
    if (c.masked) {
      this.setStatus(/\[hidden\]/.test(c.text) ? '🛡 Links, emails, phone numbers and @names are hidden to keep you safe.' : '★ Some words were hidden. Keep it kind!', 'info');
    }
    return true;
  }

  /** Send quick chat line q (QUICK_CHAT index). */
  quick(q) {
    const i = Number(q);
    if (!Number.isInteger(i) || i < 0 || i >= QUICK_CHAT.length) return false;
    const why = this.block(true);
    if (why) { this.blocked(why); return false; }
    const r = this.limiter.take(quickText(i), Date.now());
    if (r !== 'ok') { this.setStatus(r === 'dup' ? 'You just said that 🙂' : 'Slow down a little!', 'slow'); return false; }
    this.post({ t: 'chat', q: i }, quickText(i));
    return true;
  }

  /**
   * Send a line to the party. The admin watching signs his (app.admin.sayEnvelope: every page checks
   * it before showing the 🛡 ADMIN tag), one after the other so they keep their order.
   */
  post(msg, text) {
    const app = this.app, g = app.game;
    const admin = app.admin;
    if (!g.observer || !admin || typeof admin.sayEnvelope !== 'function') { g.send(msg); return; }
    this.outQ = this.outQ.then(() => admin.sayEnvelope(g.code, text)).then((env) => {
      if (app.game === g && !g.disposed) g.send({ ...msg, env });
    }, (e) => {
      console.error('chat: could not sign', e);
      this.setStatus('Couldn\'t send that. Try again.', 'bad');
    });
  }

  // ------------------------------------------------------------------ from the Game (ChatClient)
  /** A welcome or 'resumed': this party's newest lines (kept, not announced as new). */
  joined(game, list) {
    if (game !== this.app.game) return;
    const lines = list.slice(-30);
    this.inOrder(game, lines, (ok) => {
      this.game = game;
      this.code = cleanCode(game.code);
      for (const raw of lines) this.log.add(raw, { code: this.code, history: true, game, adminOk: ok.has(raw) });
      if (this.opened) this.renderAll();
      else { this.renderControls(); this.renderHint(); }
      this.place();
    });
  }

  receive(game, m) {
    if (game !== this.app.game) return;
    this.inOrder(game, [m], (ok) => this.take(game, m, ok.has(m)));
  }

  /**
   * fn(ok) once the lines in `list` that claim to be the admin's are checked (ok: the Set of those
   * whose signature checks out), in the order the lines came. At once when nothing claims to be his
   * and nothing is waiting (the usual case). Dropped when the page has moved on to another Game.
   */
  inOrder(game, list, fn) {
    const claims = list.filter((m) => m && typeof m === 'object' && m.admin === true);
    if (!claims.length && !this.inWait) { fn(new Set()); return; }
    this.inWait++;
    const checks = Promise.all(claims.map((m) => this.adminOk(game, m).then((ok) => (ok ? m : null), () => null)));
    this.inQ = this.inQ.then(() => checks).then((oks) => {
      if (game === this.app.game && !game.disposed) fn(new Set(oks.filter(Boolean)));
    }).catch((e) => console.error('chat', e)).finally(() => { this.inWait--; });
  }

  /** Is this line, which says it is the admin's, signed by him for this party and this text? */
  async adminOk(game, m) {
    if (!m.env || !(Number(m.id) < 0)) return false;
    const pub = await this.signPub();
    if (!pub) return false;
    const text = Number.isInteger(m.q) && quickText(m.q) ? quickText(m.q) : cleanChat(typeof m.text === 'string' ? m.text.slice(0, MAX_CHAT * 4) : '').text;
    return adminLineOk(pub, m.env, String(game.code || ''), text);
  }

  /** admin.json's signing key (the one every page checks the admin's commands with), or null. */
  signPub() {
    const ac = this.app.adminClient;
    if (ac && ac.pubs && ac.pubs.signPub) return Promise.resolve(ac.pubs.signPub);
    if (!this.pubP) {
      this.pubP = Promise.resolve(this.app.adminCfgPromise || null)
        .then((cfg) => (cfg ? importPublic(cfg) : null)).then((p) => (p && p.signPub) || null).catch(() => null);
    }
    return this.pubP;
  }

  /** A room line, checked (adminOk: the admin's signature checks out on it). */
  take(game, m, adminOk) {
    if (game !== this.app.game) return;
    if (this.game !== game) { this.game = game; this.code = cleanCode(game.code); }
    const line = this.log.add(m, { code: this.code, game, adminOk });
    if (!line) return;
    const mine = this.mine(line);
    this.log.count(line, { open: this.opened, mode: this.mode, mine });
    if (this.opened) this.appendRow(line);
    this.feedLine(line, mine);
    this.badges();
  }

  /** {t: 'chatno', why}: the room dropped my line. */
  refused(game, m) {
    if (game !== this.app.game) return;
    if (m && m.why === 'slow') this.setStatus('Slow down a little!', 'slow');
  }

  rosterChanged(game) { if (game === this.app.game && this.opened) this.renderTip(); }

  phaseChanged(game, phase) {
    if (game !== this.app.game) return;
    // the bus is leaving: eyes on the game (the admin watching keeps the drawer)
    if (phase === 'bus' && this.opened && !game.observer) this.close();
    if (phase === 'lobby') this.clearFeed();
    this.place();
  }

  /** The Game is going away (a party change): the next one's welcome brings its party's lines. */
  left(game) {
    if (this.game !== game) return;
    this.game = null;
    this.clearFeed();
    this.hideMenu();
  }

  /** The Chat setting changed (menu.js), or at start. */
  applySettings() {
    this.mode = chatMode(this.app.settings);
    document.body.classList.toggle('chat-off', this.mode === 'off');
    if (this.mode === 'off') { this.close(); this.clearFeed(); this.log.markRead(); }
    if (this.opened) this.renderAll();
    else this.renderControls();
    this.badges();
  }

  // ------------------------------------------------------------------ DOM
  build() {
    let root = document.getElementById('chat');
    if (!root) { root = el('div', '', document.body); root.id = 'chat'; }
    root.className = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Party chat');
    root.textContent = '';
    this.root = root;
    const head = el('div', 'ch-head', root);
    el('b', 'ch-title', head).textContent = 'PARTY CHAT';
    const code = el('span', 'ch-code', head);
    const x = el('button', 'ch-x', head);
    x.type = 'button';
    x.setAttribute('aria-label', 'Close chat');
    x.textContent = '✕';
    // the safety note: the full words (+ how to tell the real admin); a short drawer (tight /
    // tiny: chat.css) shows the title in it, the short form, and (tight) the short trust line
    const safe = el('p', 'ch-safe', root);
    el('b', 'ch-stitle', safe).textContent = 'PARTY CHAT ';
    el('span', 'ch-sfull', safe).textContent = `${SAFETY} ${SAFETY_TRUST}`;
    el('span', 'ch-sshort', safe).textContent = SAFETY_SHORT;
    el('span', 'ch-strust', safe).textContent = ` ${TRUST_SHORT}`;
    const list = el('div', 'ch-list', root);
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    const hint = el('div', 'ch-hint', root);
    hint.setAttribute('aria-live', 'polite');
    const quick = el('div', 'ch-quick', root);
    QUICK_CHAT.forEach((t, i) => {
      const b = el('button', 'ch-chip', quick);
      b.type = 'button';
      b.dataset.q = String(i);
      b.textContent = t;
    });
    const form = el('form', 'ch-form', root);
    form.setAttribute('autocomplete', 'off');
    const input = el('input', 'ch-in', form);
    Object.assign(input, { type: 'text', maxLength: MAX_CHAT, autocomplete: 'off', spellcheck: true });
    input.setAttribute('enterkeyhint', 'send');
    input.setAttribute('autocapitalize', 'sentences');
    input.setAttribute('aria-label', 'Message to your party');
    const sendBtn = el('button', 'ch-send', form);
    sendBtn.type = 'submit';
    sendBtn.textContent = 'SEND';
    const menu = el('div', 'ch-menu hidden', root);
    menu.setAttribute('role', 'menu');
    // the HUD's 💬 button and the in-match feed (index.html has them; made here if not)
    const hud = document.getElementById('hud') || document.body;
    let btn = document.getElementById('chatbtn');
    if (!btn) { btn = el('button', 'hudbtn', hud); btn.id = 'chatbtn'; }
    btn.classList.add('hudbtn');
    btn.setAttribute('aria-label', 'Party chat');
    btn.textContent = '';
    el('span', 'cb-ico', btn).textContent = '💬';
    const bn = el('b', 'cb-n hidden', btn);
    let feed = document.getElementById('chatfeed');
    if (!feed) { feed = el('div', '', hud); feed.id = 'chatfeed'; }
    feed.setAttribute('aria-hidden', 'true');
    this.el = { code, x, list, hint, quick, form, input, send: sendBtn, menu, btn, btnN: bn, feed, safe };
  }

  bind() {
    const app = this.app, E = this.el;
    // nothing in the drawer reaches the stage, the touch controls or the game's keys
    for (const ev of ['pointerdown', 'touchstart', 'mousedown', 'wheel']) this.root.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (!this.el.menu.classList.contains('hidden')) this.hideMenu(); else this.close(); }
    });
    // (keyups go on to the game: a key let go over a quick chip or SEND is let go there too, or it
    // would stay held and the player would run on. Input ignores the text input's own keys.)
    E.x.addEventListener('click', () => { this.sfx(); this.close(); });
    E.form.addEventListener('submit', (e) => { e.preventDefault(); this.sendInput(); });
    E.quick.addEventListener('click', (e) => {
      const b = e.target.closest('.ch-chip');
      if (!b) return;
      this.sfx();
      this.quick(+b.dataset.q);
    });
    E.list.addEventListener('click', (e) => {
      const row = e.target.closest('.ch-line');
      const line = row && this.rows.get(row);
      if (line && !line.sys && !line.admin && !this.mine(line)) { this.sfx(); this.lineMenu(line); }
    });
    // (held keys don't stay held while the input has the keyboard: its keyup never reaches the game)
    E.input.addEventListener('focus', () => {
      const inp = app.input;
      if (inp && inp.down) { inp.down.clear(); inp.mouseL = inp.mouseR = false; }
      setTimeout(() => this.fit(), 300);
    });
    E.input.addEventListener('blur', () => this.root.classList.remove('typing'));
    E.input.addEventListener('focus', () => this.root.classList.add('typing'));
    E.btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    E.btn.addEventListener('click', (e) => { e.stopPropagation(); this.sfx(); this.toggle(); });
    // touch: a touch on the game outside the drawer (the joystick, FIRE, the island…) puts the
    // iPad's keyboard away; the drawer stays open and the same touch still plays. (Capture phase:
    // the touch buttons stop their pointerdown and the zones preventDefault it, so no mousedown
    // ever moves the focus by itself.)
    document.addEventListener('pointerdown', (e) => {
      if (this.opened && document.activeElement === E.input && !this.root.contains(e.target) && !E.btn.contains(e.target)) E.input.blur();
    }, true);
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => { if (this.opened) { this.place(); this.moveToasts(); } });
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', () => this.fit());
      vv.addEventListener('scroll', () => this.fit());
    }
    // a sheet (settings, locker, invite, the admin's panel…) takes over: the drawer steps aside
    const modal = document.getElementById('modal');
    if (modal && typeof MutationObserver === 'function') {
      new MutationObserver(() => { if (this.opened && !modal.classList.contains('hidden')) this.close(); }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    }
    // the warm-up chip (↩ LOBBY) comes, goes or folds: the drawer moves under it (place)
    const wu = document.getElementById('lobbypanel');
    if (wu && typeof MutationObserver === 'function') {
      new MutationObserver(() => { if (this.opened) this.place(); }).observe(wu, { attributes: true, attributeFilter: ['class'] });
    }
    // desktop, in a match: a click on the island goes back to playing (the admin watching: the ✕)
    const canvas = document.getElementById('game');
    if (canvas) canvas.addEventListener('click', () => { if (this.opened && !app.stageOn && app.input && !app.input.touchMode && !(app.game && app.game.observer)) this.close(); });
  }

  sfx() { const s = this.app.sfx; if (s && s.ui) s.ui(); }

  /** Enter opens the chat (T too on the lobby stage). Not while typing elsewhere or with a modal up. */
  onKey(e) {
    // (keys typed in the drawer stop there; this is the rest of the page)
    if (e.key === 'Escape' && this.opened) { e.preventDefault(); this.close(); return; }
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || (t && t.isContentEditable)) return;
    const app = this.app;
    if (!app.game || this.mode === 'off' || (app.ui && app.ui.modalOpen && app.ui.modalOpen())) return;
    if (!(e.key === 'Enter' || (e.code === 'KeyT' && app.stageOn))) return;
    e.preventDefault(); // (and the key never types itself into the input)
    this.open({ focus: true });
  }

  focus() {
    const i = this.el.input;
    if (i && !i.disabled && !this.el.form.classList.contains('hidden')) { try { i.focus({ preventScroll: true }); } catch (e) { i.focus(); } }
  }

  sendInput() {
    const E = this.el, app = this.app;
    const text = E.input.value;
    // (the admin watching has no match to go back to: his drawer stays open for the next line)
    const desktopPlay = !app.stageOn && app.input && !app.input.touchMode && !(app.game && app.game.observer);
    if (!text.trim()) {
      // Enter on an empty line: back to the game (desktop, in a match)
      if (desktopPlay) { this.close(); app.resume(); }
      return;
    }
    if (!this.send(text)) return;
    E.input.value = '';
    // desktop, in a match: Enter sends and goes back to playing
    if (desktopPlay) { this.close(); app.resume(); }
  }

  // ------------------------------------------------------------------ drawing
  /** Why a line can't go now ('' = it can). */
  block(quick) {
    return sendBlock({ mode: this.mode, muted: this.log.muted(), connected: this.connected(), quick });
  }

  blocked(why) {
    if (why === 'muted') { this.renderHint(); this.renderControls(); if (!this.opened) this.say(muteText(this.log.muted())); return; }
    this.setStatus(BLOCKED[why] || '', 'bad');
  }

  /** Connected to a party (a party of one counts: its room runs on this page). */
  connected() {
    const g = this.app.game;
    return !!g && !g.disposed && !!g.net && g.net.kind !== 'none' && !!g.myId;
  }

  mine(line) {
    const g = this.game || this.app.game;
    return !!g && !line.sys && line.id === g.myId && line.code === cleanCode(g.code);
  }

  /** On my own in this party (not the admin watching it). */
  alone() {
    const g = this.app.game;
    if (!g || g.observer) return false;
    let n = 0;
    for (const p of g.roster.values()) if (!p.bot) n++;
    return n <= 1;
  }

  color(line) {
    if (line.admin) return ADMIN_COLOR;
    const g = this.game || this.app.game;
    const row = g && g.roster && line.code === cleanCode(g.code) ? g.roster.get(line.id) : null;
    const skin = row && SKINS[row.skin];
    return skin ? skin.accent : NAME_COLORS[Math.abs(line.id | 0) % NAME_COLORS.length];
  }

  view(line) {
    return lineView(line, { mode: this.mode, mine: this.mine(line), hidden: !line.sys && this.log.isHidden(line.code, line.id) });
  }

  /** One drawer row (null: the line doesn't show). */
  row(line) {
    const v = this.view(line);
    if (!v) return null;
    const mine = this.mine(line);
    // (k-*: a plain 'hidden' class would hide the row: style.css .hidden)
    const d = el('div', `ch-line k-${v.kind}${mine ? ' me' : ''}`);
    this.rows.set(d, line);
    if (v.kind === 'sys') { d.textContent = v.text; return d; }
    const nm = el('b', 'ch-name', d);
    nm.textContent = line.name;
    nm.style.color = this.color(line);
    d.appendChild(document.createTextNode(' '));
    if (v.kind === 'admin') {
      el('span', 'ch-tag', d).textContent = '🛡 ADMIN';
      d.appendChild(document.createTextNode(' '));
    }
    const tx = el('span', 'ch-text', d);
    fillText(tx, v.text);
    if (!mine && !line.admin) d.setAttribute('role', 'button');
    return d;
  }

  renderAll() {
    const list = this.el.list;
    list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of this.log.party(this.code)) {
      const r = this.row(l);
      if (r) frag.appendChild(r);
    }
    list.appendChild(frag);
    this.renderTip();
    list.scrollTop = list.scrollHeight;
    const g = this.app.game;
    this.el.code.textContent = g && this.app.partyKind && this.app.partyKind() !== 'solo' && g.code ? `CODE ${g.code}` : '';
    this.renderControls();
    this.renderHint();
  }

  appendRow(line) {
    if (line.code !== this.code) return;
    const list = this.el.list;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const r = this.row(line);
    if (!r) return;
    list.appendChild(r);
    while (list.children.length > 100) list.firstChild.remove();
    if (near || this.mine(line)) list.scrollTop = list.scrollHeight;
  }

  /** On my own in the party: "Invite friends to chat with them" at the top of the list. */
  renderTip() {
    const list = this.el.list;
    let tip = list.querySelector(':scope > .k-tip');
    const want = this.alone();
    if (!want) { if (tip) tip.remove(); return; }
    if (!tip) {
      tip = el('div', 'ch-line k-tip');
      tip.textContent = 'Invite friends to chat with them 👋';
    }
    if (list.firstChild !== tip) list.prepend(tip);
  }

  renderControls() {
    const E = this.el;
    const muted = !!this.log.muted();
    const on = this.connected();
    E.form.classList.toggle('hidden', this.mode === 'quick');
    E.input.disabled = muted || !on;
    E.send.disabled = muted || !on;
    // (muted: the hint above says until when and why; the chips and the input step aside, chat.css)
    E.input.placeholder = muted ? '🔇 Muted' : on ? 'Say something nice…' : 'Not in a party';
    for (const b of E.quick.children) b.disabled = muted || !on;
    this.root.classList.toggle('muted', muted);
  }

  renderHint() {
    const m = this.log.muted();
    const s = this.status && this.status.until > Date.now() ? this.status : null;
    let text = '', kind = '';
    if (m) { text = muteText(m); kind = 'mute'; }
    else if (s) { text = s.text; kind = s.kind; }
    else if (this.mode === 'quick') { text = 'Quick chat only (change it in ⚙ Settings)'; kind = 'info'; }
    const h = this.el.hint;
    if (h.textContent !== text) h.textContent = text;
    h.className = `ch-hint ${kind}`;
  }

  /** A short hint in the drawer (or a toast / the HUD notice while it is closed), for ms. */
  setStatus(text, kind = 'info', ms = STATUS_MS) {
    if (!text) return;
    this.status = { text, kind, until: Date.now() + ms };
    this.renderHint();
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.renderHint(), ms + 50);
    if (!this.opened) this.say(text);
  }

  /** Tell the player outside the drawer: a toast in the lobby, the HUD notice in a match. */
  say(text) {
    if (!text) return;
    const app = this.app;
    if (!app.stageOn && app.hud && app.hud.notice) { app.hud.notice(text, false, 3); return; }
    if (app.lobby && app.lobby.toast) {
      const d = document.createElement('div');
      d.textContent = text;
      app.lobby.toast(d.innerHTML, { ms: 3500 });
    }
  }

  badges() {
    const n = this.mode === 'off' ? 0 : this.log.unread;
    const t = n > 9 ? '9+' : String(n);
    for (const b of [this.el.btnN, document.querySelector('#lobby .lb-chatn')]) {
      if (!b) continue;
      b.classList.toggle('hidden', !n);
      if (b.textContent !== t) b.textContent = n ? t : '';
    }
  }

  // ------------------------------------------------------------------ tap a line: hide / report
  lineMenu(line) {
    const m = this.el.menu;
    m.textContent = '';
    const hidden = this.log.isHidden(line.code, line.id);
    const head = el('div', 'ch-mhead', m);
    head.textContent = line.name;
    head.style.color = this.color(line);
    const add = (cls, text, fn) => {
      const b = el('button', `ch-mbtn ${cls}`, m);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = text;
      b.addEventListener('click', () => { this.sfx(); fn(); });
    };
    add('hide', hidden ? `👀 Show messages from ${line.name}` : `🙈 Hide messages from ${line.name}`, () => {
      this.log.hide(line.code, line.id, !hidden);
      this.hideMenu();
      this.renderAll();
      this.setStatus(hidden ? `Showing ${line.name}'s messages again.` : `${line.name}'s messages are hidden in this party.`, 'info');
    });
    add('report', '🚩 Report to admin', () => this.report(line));
    add('cancel', 'Cancel', () => this.hideMenu());
    m.classList.remove('hidden');
  }

  hideMenu() { this.el.menu.classList.add('hidden'); this.el.menu.textContent = ''; }

  /** Send the line (and up to 10 lines before it) to the admin (js/admin/client.js report()). */
  async report(line) {
    this.hideMenu();
    if (this.reported.has(line)) { this.setStatus(REPORTED, 'ok', REPORTED_MS); return; }
    const before = this.log.party(line.code).filter((l) => !l.sys);
    const i = before.indexOf(line);
    const context = before.slice(Math.max(0, i - 10), Math.max(0, i)).map((l) => ({ ...l }));
    const ac = this.app.adminClient;
    let ok = false;
    try { ok = !!(ac && typeof ac.report === 'function' && await ac.report({ ...line }, context)); } catch (e) { ok = false; }
    if (ok) this.reported.add(line);
    if (ok) this.setStatus(REPORTED, 'ok', REPORTED_MS);
    else this.setStatus('Couldn\'t reach the admin right now', 'bad');
  }

  // ------------------------------------------------------------------ the in-match feed
  feedLine(line, mine) {
    const app = this.app;
    if (this.mode === 'off' || this.opened || app.stageOn || line.code !== this.code) return;
    const v = lineView(line, { mode: this.mode, mine, hidden: !line.sys && this.log.isHidden(line.code, line.id) });
    if (!v || v.kind === 'hidden') return;
    const feed = this.el.feed;
    const d = el('div', `cf-line k-${v.kind}`, feed);
    const clip = el('div', 'cf-clip', d); // (the line clamp: two lines at most, one on a phone)
    if (v.kind !== 'sys') {
      const nm = el('b', 'cf-name', clip);
      nm.textContent = line.name;
      nm.style.color = this.color(line);
      clip.appendChild(document.createTextNode(' '));
      // the admin: the same 🛡 ADMIN tag as in the drawer, an element no player's name can make
      if (v.kind === 'admin') {
        el('span', 'ch-tag cf-tag', clip).textContent = '🛡 ADMIN';
        clip.appendChild(document.createTextNode(' '));
      }
    }
    fillText(el('span', 'cf-text', clip), v.text);
    while (feed.children.length > FEED_MAX) feed.firstChild.remove();
    // never taller than its box (clear of the touch buttons above it): the oldest go first
    while (feed.children.length > 1 && feed.scrollHeight > feed.clientHeight + 1) feed.firstChild.remove();
    setTimeout(() => d.remove(), FEED_MS + 1200);
  }

  clearFeed() { if (this.el && this.el.feed) this.el.feed.textContent = ''; }

  // ------------------------------------------------------------------ where the drawer goes
  /** The drawer's box on screen (lobby.placeToasts keeps the toasts clear of it), or null. */
  rect() {
    if (!this.opened) return null;
    const r = this.root.getBoundingClientRect();
    return r.width ? r : null;
  }

  /**
   * Lobby: over the party rail, above the EMOTE / WARM UP / CHAT row, never over the mode card or
   * PLAY; beside or under Philip's news when it sits under the top bar. Match: the left side under
   * the ☰ / 💬 buttons and the warm-up chip (its ↩ LOBBY stays tappable), above the health bars
   * (the admin watching: above the watching bar). A phone on its side has little height: the
   * drawer is wider and goes down to the bottom, and the warm-up chip steps aside while it is open
   * (chat.css). With no room under the news it goes over it ('over': above the banner and the
   * toasts). Then the iPad's keyboard (fit).
   */
  place() {
    if (!this.opened) return;
    const app = this.app, st = this.root.style, H = innerHeight, W = innerWidth;
    const lobby = !!app.stageOn;
    const short = H < 500;
    this.root.classList.toggle('lobby', lobby);
    this.root.classList.toggle('match', !lobby);
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? r : null; };
    let left = 16, top = 86, bottom = 14, width = Math.min(short ? 480 : 420, W - 32), over = false;
    const MIN_H = short ? 280 : 330;
    if (lobby) {
      const rail = box('#lobby .lb-rail'), bl = box('#lobby .lb-bl'), br = box('#lobby .lb-br');
      if (rail) { left = rail.left; top = rail.top; }
      if (bl) bottom = H - bl.top + 10;
      // (a short screen, a phone on its side: over that row too, the drawer has its own ✕)
      if (bl && H - top - bottom < MIN_H) bottom = H - bl.bottom;
      // landscape: the mode card + PLAY are beside the drawer, not under it
      if (br && br.top < H - bottom) width = Math.min(width, br.left - 16 - left);
      const ann = document.body.classList.contains('announce-low') ? box('#announce') : null;
      if (ann && ann.left < left + width && ann.bottom > top) {
        if (ann.left - 12 - left >= 340) width = ann.left - 12 - left;
        else if (H - (ann.bottom + 8) - bottom >= MIN_H) top = ann.bottom + 8;
        else over = true;
      }
    } else {
      const menu = box('#menubtn'), bars = box('#bars'), watch = box('#adminwatch');
      left = menu ? menu.left : 10;
      top = (menu ? menu.bottom : 56) + 8;
      width = short ? Math.min(440, Math.round(W * 0.52)) : Math.min(380, Math.round(W * 0.42));
      const wu = !short && document.querySelector('#lobbypanel.show') ? box('#lobbypanel') : null;
      if (wu && wu.left < left + width) top = Math.max(top, wu.bottom + 8);
      bottom = 12;
      if (bars && !short) bottom = Math.max(bottom, H - bars.top + 10);
      if (watch) bottom = Math.max(bottom, H - watch.top + 10);
      // (a phone's centred hotbar stays tappable)
      const hb = box('#hotbar');
      if (hb && hb.left < left + width && hb.top < H - bottom) bottom = Math.max(bottom, H - hb.top + 8);
      const ann = box('#announce');
      if (ann && ann.left < left + width && ann.bottom > top - 8) {
        if (H - (ann.bottom + 8) - bottom >= MIN_H) top = ann.bottom + 8;
        else over = true;
      }
    }
    this.root.classList.toggle('over', over);
    this.base = { left, top, bottom, width: Math.max(260, width) };
    st.left = `${Math.round(left)}px`;
    st.width = `${Math.round(this.base.width)}px`;
    this.fit();
  }

  /** The on-screen keyboard (visualViewport): the drawer stays inside what is still visible. */
  fit() {
    if (!this.opened || !this.base) return;
    const vv = window.visualViewport, H = innerHeight;
    const list = this.el.list;
    // (reading the newest lines when the keyboard comes up: still reading them after)
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    let top = this.base.top, bottom = this.base.bottom;
    let kb = 0;
    if (vv) {
      kb = Math.max(0, H - (vv.height + vv.offsetTop));
      top = Math.max(top, vv.offsetTop + 8);
      bottom = Math.max(bottom, kb + 8);
      // (a short view: the drawer may go up to the top of what's visible)
      if (H - top - bottom < 200 && kb > 0) top = Math.max(vv.offsetTop + 8, Math.min(top, H - bottom - 200));
    }
    const st = this.root.style;
    st.top = `${Math.round(top)}px`;
    st.bottom = `${Math.round(bottom)}px`;
    const h = H - top - bottom;
    this.root.classList.toggle('kb', kb > 80);
    // (the full layout's fixed parts take ~330 px: below 440 the list would be a line or two, so
    // go tight; tiny is a phone with its keyboard up)
    this.root.classList.toggle('tight', h < 440);
    this.root.classList.toggle('tiny', h < 230);
    if (atEnd) list.scrollTop = list.scrollHeight;
  }

  /** The toasts' column (and the admin's chips and cards in it) moves right of an open drawer. */
  moveToasts() {
    const lb = this.app.lobby;
    if (lb && lb.placeToasts) { try { lb.placeToasts(); } catch (e) { /* not drawn yet */ } }
  }

  /** The mute ends by itself at its time (the input comes back). */
  armMute() {
    clearTimeout(this.muteTimer);
    const m = this.log.muted();
    if (!m) return;
    const ms = Math.min(2 ** 31 - 1, m.until - Date.now() + 50);
    this.muteTimer = setTimeout(() => { this.log.muted(); this.renderControls(); this.renderHint(); this.armMute(); }, Math.max(50, ms));
  }
}
