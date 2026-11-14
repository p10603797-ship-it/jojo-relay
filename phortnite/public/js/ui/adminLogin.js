// The way into admin mode (Philip only), in the lobby modal (js/ui/menu.js): the small "Admin"
// button on the "Who's playing?" screen and in the account panel opens the admin password box. The
// right password opens admin.json's keys (js/admin/keys.js) for this page, and "Remember admin on
// this iPad" keeps them (as keys that can't be read back out) for next time. A wrong password is
// just a friendly no and a one-second wait: never a device ban. In admin mode the lobby's top bar
// has a 🛡 ADMIN button (the panel: app.adminPanel, js/ui/admin.js; a small list of who's online
// if the panel is missing). The account isAdmin flag plays no part: only the keys give admin powers.
// The password is never logged, kept or sent anywhere.
import { unlockAdmin } from '../admin/keys.js';
import { AdminSession } from '../admin/session.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRONG_WAIT_MS = 1000;

export class AdminLoginUi {
  constructor(app, cfg, pubs) {
    this.app = app;
    this.cfg = cfg;
    this.pubs = pubs;
  }

  /**
   * Fill a '.acc-adminrow' placeholder (js/ui/accounts.js) with the note everyone sees and the small
   * Admin button. data-back: 'who' (data-gate '1' for the locked gate) or 'panel': where BACK goes.
   */
  bits(row) {
    if (!row || row.dataset.filled) return;
    row.dataset.filled = '1';
    const note = `<p class="acc-note adm-note">🛡 Philip (the admin) can see who's online, every account's name, level and wins, and moderate the game.</p>`;
    // "Who's playing?": the note goes right under the title (on a phone the bottom is out of sight)
    const sub = row.dataset.back === 'who' && row.parentNode && row.parentNode.querySelector('.acc-sub');
    if (sub) sub.insertAdjacentHTML('afterend', note.replace('adm-note', 'adm-note adm-note-top'));
    row.innerHTML = `${sub ? '' : note}<button class="acc-link adm-open">${this.app.admin ? '🛡 Admin mode is on' : 'Admin'}</button>`;
    $('.adm-open', row).addEventListener('click', () => {
      if (this.app.sfx) this.app.sfx.ui();
      this.open(this.backFor(row));
    });
  }

  backFor(row) {
    const ui = this.app.accountsUi;
    if (row.dataset.back === 'panel') return () => ui.panel();
    const gate = row.dataset.gate === '1';
    return () => ui.whoScreen({ gate });
  }

  /** The admin password box (or, in admin mode, its status and ADMIN SIGN OUT). back: where to go after. */
  open(back = null) {
    const app = this.app;
    const locked = app.ui.modalLocked;
    const done = () => { if (back) back(); else app.ui.closeModal(true); };
    if (app.admin) { this.status(done, locked); return; }
    const html = `<div class="acc adm-login">
      <h2>🛡 ADMIN</h2>
      <p class="acc-sub">For Philip only. Admin mode can see who's online and every account's name, level and wins, and moderate the game — and players are always told when the admin does something.</p>
      <div class="rn-row"><input id="adm-pw" type="password" maxlength="40" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="Admin password"></div>
      <label class="acc-opt"><input type="checkbox" id="adm-remember"><span>Remember admin on this iPad</span></label>
      <div class="sheet-btns"><button class="btn yellow big adm-go">UNLOCK</button><button class="btn big adm-back">BACK</button></div>
      <div class="acc-err" aria-live="polite"></div>
    </div>`;
    app.ui.modal(html, (b) => {
      this.shown(true);
      const input = $('#adm-pw', b), err = $('.acc-err', b), go = $('.adm-go', b), remember = $('#adm-remember', b);
      let busy = false;
      const submit = async () => {
        if (busy) return;
        if (!input.value.trim()) { err.textContent = 'Type the admin password.'; input.focus(); return; }
        busy = true;
        go.disabled = true; go.textContent = 'Checking…'; err.textContent = '';
        const keys = await unlockAdmin(this.cfg, input.value);
        if (!keys) {
          // not the admin password: a moment's wait, then another go (nothing is counted or banned)
          await sleep(WRONG_WAIT_MS);
          busy = false;
          go.disabled = false; go.textContent = 'UNLOCK';
          err.textContent = "That's not the admin password.";
          if (app.accountsUi && app.accountsUi.shake) app.accountsUi.shake(b);
          input.focus();
          input.select();
          return;
        }
        input.value = '';
        const session = new AdminSession(app, { cfg: this.cfg, pubs: this.pubs, keys });
        if (remember.checked) { try { await session.remember(true); } catch (e) { /* this visit only */ } }
        this.enter(session);
        done();
      };
      go.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      $('.adm-back', b).addEventListener('click', () => { if (!busy) done(); });
      setTimeout(() => { try { input.focus(); } catch (e) { /* fine */ } }, 50);
    }, () => this.shown(false), { locked });
  }

  /** While the password box or the status is up, Philip's news banner keeps off it (a phone's short screen). */
  shown(on) {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('adm-login-open', on);
    // (the modal may be swapped for another without closing: look again in a moment)
    clearInterval(this.shownT);
    if (on) this.shownT = setInterval(() => { if (!document.querySelector('#modal:not(.hidden) .adm-login')) this.shown(false); }, 500);
  }

  /** Admin mode is on: where it stands, remember it here or not, ADMIN SIGN OUT. */
  status(done, locked) {
    const app = this.app, s = app.admin;
    const html = `<div class="acc adm-login">
      <h2>🛡 ADMIN MODE IS ON</h2>
      <p class="acc-sub">This iPad can moderate Phortnite. Every command is signed with the admin key, and players always see what the admin did.</p>
      <label class="acc-opt"><input type="checkbox" id="adm-remember" ${s.remembered ? 'checked' : ''}><span>Remember admin on this iPad</span></label>
      <div class="sheet-btns">${locked ? '' : '<button class="btn yellow big adm-panel">🛡 ADMIN PANEL</button>'}<button class="btn big danger adm-signout">ADMIN SIGN OUT</button><button class="btn big adm-back">BACK</button></div>
    </div>`;
    app.ui.modal(html, (b) => {
      this.shown(true);
      const remember = $('#adm-remember', b);
      remember.addEventListener('change', () => { if (app.admin) app.admin.remember(remember.checked).catch(() => {}); });
      const panel = $('.adm-panel', b);
      if (panel) panel.addEventListener('click', () => { app.ui.closeModal(true); this.openPanel(); });
      $('.adm-signout', b).addEventListener('click', async () => { await this.signOut(); done(); });
      $('.adm-back', b).addEventListener('click', done);
    }, () => this.shown(false), { locked });
  }

  /** Admin mode on for this page with this session (unlocked now, or remembered keys at boot). */
  enter(session, { quiet = false } = {}) {
    const app = this.app;
    if (app.admin && app.admin !== session) app.admin.close();
    app.admin = session;
    this.topButton();
    if (app.adminClient) app.adminClient.adminChanged();
    if (!quiet && app.lobby) app.lobby.toast('🛡 <b>Admin mode on.</b> Players always see it when you moderate.', { ms: 5000 });
  }

  /** Admin mode off here; remembered keys are forgotten too. */
  async signOut() {
    const app = this.app, s = app.admin;
    if (!s) return;
    app.admin = null;
    try { await s.signOut(); } catch (e) { /* gone anyway */ }
    this.topButton();
    if (app.adminClient) app.adminClient.adminChanged();
    if (app.lobby) app.lobby.toast('Admin signed out on this iPad.');
  }

  /** The 🛡 ADMIN button in the lobby's top bar, shown in admin mode only. */
  topButton() {
    const lobby = this.app.lobby;
    if (lobby && lobby.adminButton) lobby.adminButton(!!this.app.admin);
  }

  /** 🛡 ADMIN: the admin panel (js/ui/admin.js sets app.adminPanel), or the short list until it exists. */
  openPanel() {
    const app = this.app;
    if (!app.admin) return;
    if (app.adminPanel && typeof app.adminPanel.open === 'function') { app.adminPanel.open(); return; }
    this.basicPanel();
  }

  /** Who's online (from their sealed cards) and ADMIN SIGN OUT. */
  basicPanel() {
    const app = this.app, s = app.admin;
    if (!s) return;
    let off = null;
    const render = (b) => {
      // (another modal took its place: stop following the list)
      if (!$('.adm-basic', b)) { if (off) off(); return; }
      const t = s.totals(), list = s.players();
      const rows = list.slice(0, 40).map((p) => `<li><b>${esc(p.name)}</b>${p.me ? ' <small>(you)</small>' : ''} · Lv ${p.level | 0} · ${p.account === 'guest' ? 'guest' : p.account ? 'account' : 'choosing'} · ${p.phase === 'match' ? 'in a match' : 'lobby'}${p.party && p.party.code ? ` · party ${esc(p.party.code)} (${p.party.size}, ${esc(p.party.kind)})` : ''}</li>`).join('');
      $('.adm-totals', b).textContent = `${t.total} playing now · ${t.inMatch} in a match · ${t.inLobby} in the lobby`;
      $('.adm-plist', b).innerHTML = rows || '<li>Nobody else is online right now.</li>';
    };
    const html = `<div class="acc adm-basic">
      <h2>🛡 ADMIN</h2>
      <p class="acc-sub adm-totals"></p>
      <ul class="adm-plist"></ul>
      <div class="sheet-btns"><button class="btn big danger adm-signout">ADMIN SIGN OUT</button></div>
      <p class="acc-note">Every command is signed with the admin key. Players are always told what the admin did.</p>
    </div>`;
    app.ui.modal(html, (b) => {
      render(b);
      off = s.onPlayers(() => render(b));
      $('.adm-signout', b).addEventListener('click', async () => { app.ui.closeModal(true); await this.signOut(); });
    }, () => { if (off) off(); });
  }
}
