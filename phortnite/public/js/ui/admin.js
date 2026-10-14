// The admin panel (Philip only): the lobby's 🛡 ADMIN button opens it (app.adminPanel.open, wired
// in js/ui/adminLogin.js). Two tabs:
//   PLAYERS   everyone online, from their sealed player cards (js/admin/session.js), live. Tap a
//             player for what the admin can do: SPECTATE their match (js/ui/adminWatch.js), MESSAGE,
//             RENAME, GIVE XP, RESET STATS, RELOAD, KICK, BAN; on a party host's page also END
//             MATCH and PAUSE / RESUME (during a match) or SET MODE (in the party's lobby): the room
//             runs on that page. A row whose card came with two different keys is marked: someone
//             is faking that player (commands still reach only the real page).
//   EVERYONE  the banner (with how long it stays), maintenance on / off, a message or a reload
//             for everyone.
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
  }

  get session() { return this.app.admin; }

  /** 🛡 ADMIN: the panel (tab: 'players' | 'everyone'). */
  open(tab = this.tab) {
    const app = this.app, s = this.session;
    if (!s) return;
    this.tab = tab === 'everyone' ? 'everyone' : 'players';
    const html = `<div class="adm-panel">
      <div class="adm-head"><h2>🛡 ADMIN</h2><p class="adm-open-note">Every command is signed with the admin key, and players always see what the admin did.</p></div>
      <div class="adm-tabs" role="tablist">
        <button class="adm-tab" data-tab="players" role="tab">👥 PLAYERS <b class="adm-count"></b></button>
        <button class="adm-tab" data-tab="everyone" role="tab">📢 EVERYONE</button>
      </div>
      <div class="adm-pane adm-players">
        <p class="adm-totals"></p>
        <ul class="adm-list"></ul>
      </div>
      <div class="adm-pane adm-everyone"></div>
      <div class="adm-status" aria-live="polite"></div>
    </div>`;
    app.ui.modal(html, (b) => {
      this.root = $('.adm-panel', b);
      app.ui.modalEl.classList.add('adm-wide');
      // (Philip's news banner sits above dialogs: not over the panel's tabs)
      document.body.classList.add('adm-panel-open');
      for (const t of b.querySelectorAll('.adm-tab')) t.addEventListener('click', () => { this.ui(); this.show(t.dataset.tab); });
      this.everyone();
      this.show(this.tab);
      this.renderPlayers();
      this.off = s.onPlayers(() => this.renderPlayers());
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }, () => this.closed());
  }

  /** The panel went away (closed, or another modal took its place). */
  closed() {
    if (this.off) this.off();
    this.off = null;
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
    if (tab === 'everyone') this.stateNow();
  }

  tick() {
    if (!this.live()) return;
    this.renderPlayers();
    this.stateNow();
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
    const key = `${p.id}|${p.me}|${watch ? pt.code : ''}|${host}|${p.phase}|${p.name}|${this.form}`;
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
