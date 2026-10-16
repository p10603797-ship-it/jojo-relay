// Player profiles/accounts, all on this device — no backend, nothing to sign up for, private. This
// is the UI over the lobby modal (js/ui/menu.js): the "Who's playing?" screen, creating an account
// (with an optional password and/or Face ID / Touch ID), signing in, the STATS card, switching /
// signing out / renaming / deleting, and "Move my account" (an encrypted transfer code + QR).
// The store (js/accounts/store.js) and the maths (js/accounts/stats.js, js/accounts/crypto.js) are
// DOM-free and tested in Node; this file is the glue and the copy (kid-friendly, big tap targets).
// Where the website has an admin (admin.json), an account's name and stats go to the admin's
// ACCOUNTS list (js/accounts/registry.js, sealed so only he can read them): the create-account
// screen says so right under the name box, the account panel says what the admin sees and that a
// ban locks the whole iPad, and every other account is told once in the lobby (js/admin/client.js
// tellRegistry). A banned account can't be brought over with a transfer code (the ban list is
// asked first: "This account was banned by the admin").
import { SKINS } from '../../shared/constants.js';
import { hashPassword, verifyPassword, encryptTransfer, decryptTransfer, makeSigningIdentity } from '../accounts/crypto.js';
import { kd, winRate, favoriteMode, playtimeLabel } from '../accounts/stats.js';
import { playerName } from '../../shared/chatFilter.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rand(n) { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; }

export class AccountsUi {
  constructor(app) {
    this.app = app;
    this.faceReady = null; // cached: does this device offer Face ID / Touch ID?
  }

  // ---------------------------------------------------------------- boot gate
  /**
   * At boot: sign in the saved profile when it needs no password, otherwise show a gate. An
   * unprotected active profile is one tap (reload keeps you signed in); a protected one asks again.
   */
  gateIfNeeded() {
    // selected() is the profile chosen on disk, even when it's still locked — active() would hide a
    // protected one until it's unlocked, and here we need to know whom to ask.
    const acc = this.app.accounts.selected();
    if (!acc) { this.whoScreen({ gate: true }); return; }
    if (acc.pw || acc.passkey) { this.signIn(acc, { gate: true }); return; } // protected: ask first
    this.app.setActiveProfile(acc); // unprotected: one tap, straight in
  }

  // ---------------------------------------------------------------- Who's playing?
  whoScreen({ gate = false } = {}) {
    const app = this.app;
    const cards = app.accounts.list();
    const cardHtml = cards.map((p) => {
      const skin = SKINS[p.skin] || SKINS[0];
      const lock = p.hasPasskey ? '<span class="who-lock" title="Face ID / Touch ID">😊</span>' : p.hasPassword ? '<span class="who-lock" title="Password">🔒</span>' : '';
      return `<button class="who-card" data-id="${esc(p.id)}">
        <i class="who-ava" style="background:${skin.outfit};box-shadow:inset 0 -8px 0 ${skin.accent}"></i>
        <span class="who-name">${esc(p.name)}${p.isAdmin ? ' <b class="who-admin">ADMIN</b>' : ''}</span>
        <span class="who-lv">Level ${p.level | 0}</span>${lock}</button>`;
    }).join('');
    const html = `<div class="acc">
      <h2>WHO'S PLAYING?</h2>
      <p class="acc-sub">Pick your profile. It's saved on this iPad.</p>
      <div class="who-grid">${cardHtml}
        <button class="who-card who-new" data-act="create"><i class="who-ava who-plus">+</i><span class="who-name">CREATE ACCOUNT</span><span class="who-lv">New profile</span></button>
      </div>
      <button class="lb-btn acc-guest" data-act="guest">👋 PLAY AS GUEST</button>
      <p class="acc-note">Guest play isn't saved — your wins and level only last this time.</p>
      <button class="acc-link acc-import" data-act="import">I have an account code…</button>
      <div class="acc-adminrow" data-back="who" data-gate="${gate ? 1 : 0}"></div>
    </div>`;
    app.ui.modal(html, (b) => {
      b.querySelectorAll('.who-card[data-id]').forEach((c) => c.addEventListener('click', () => { app.sfx.ui(); this.pick(c.dataset.id); }));
      $('.who-new', b).addEventListener('click', () => { app.sfx.ui(); this.createScreen(); });
      $('.acc-guest', b).addEventListener('click', () => { app.sfx.ui(); this.playGuest(); });
      $('.acc-import', b).addEventListener('click', () => { app.sfx.ui(); this.transferImport(); });
      // where the website has an admin (admin.json): that it does, and the way into admin mode
      if (app.adminLogin) app.adminLogin.bits($('.acc-adminrow', b));
    }, null, { locked: gate });
  }

  /** A profile card was tapped: straight in, or ask for its password / Face ID first. */
  pick(id) {
    const acc = this.app.accounts.get(id);
    if (!acc) return this.whoScreen({ gate: true });
    if (acc.pw || acc.passkey) return this.signIn(acc, { gate: true });
    this.app.accounts.setActive(id);
    this.app.setActiveProfile(acc);
    this.app.ui.closeModal(true);
    this.app.lobby.toast(`Welcome back, <b>${esc(acc.name)}</b>! 👋`);
  }

  playGuest() {
    const app = this.app;
    const g = app.accounts.startGuest({ name: app.settings.name && app.settings.name !== 'Guest' ? app.settings.name : 'Guest', skin: app.settings.skin | 0 });
    app.setActiveProfile(g);
    app.ui.closeModal(true);
    app.lobby.toast('Playing as <b>Guest</b> — this round only. Create an account to keep your wins!', { ms: 5000 });
  }

  // ---------------------------------------------------------------- create account
  /**
   * Does this website have an admin (account names go to him)? admin.json still loading: wait a
   * moment for it; no answer by then says yes (better told than not).
   */
  adminTold() {
    const app = this.app;
    if (app.adminCfg) return Promise.resolve(true);
    if (!app.adminCfgPromise) return Promise.resolve(false);
    return Promise.race([
      Promise.resolve(app.adminCfgPromise).then((c) => !!c, () => false),
      new Promise((r) => setTimeout(() => r(true), 2000)),
    ]);
  }

  async createScreen() {
    const app = this;
    const face = await this.checkFace();
    const told = await this.adminTold();
    const skin = this.app.settings.skin | 0;
    const html = `<div class="acc">
      <h2>CREATE ACCOUNT</h2>
      <p class="acc-sub">Choose a username. It's saved on this iPad — no email, no sign-up.</p>
      <div class="rn-row"><input id="acc-name" maxlength="16" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Your username"></div>
      ${told ? '<p class="acc-note acc-regnote">🛡 Your account name is sent to the admin (Philip) so he can keep Phortnite fair.</p>' : ''}
      <div class="acc-locks">
        <div class="acc-lockhead">Lock it so it's just yours? <small>(optional)</small></div>
        <label class="acc-opt"><input type="checkbox" id="acc-usepw"><span>🔒 Password</span></label>
        <div class="rn-row acc-pwrow hidden"><input id="acc-pw" type="password" maxlength="64" autocomplete="new-password" placeholder="Pick a password"></div>
        ${face ? '<label class="acc-opt"><input type="checkbox" id="acc-useface"><span>😊 Use Face ID / Touch ID</span></label>' : '<p class="acc-note">Face ID / Touch ID isn\'t available on this device — a password works everywhere.</p>'}
      </div>
      <p class="acc-note">No lock is fine too — then it's just one tap to play.</p>
      <div class="sheet-btns"><button class="btn yellow big acc-create">CREATE &amp; PLAY</button><button class="btn big acc-back">BACK</button></div>
      <div class="acc-err" aria-live="polite"></div>
    </div>`;
    this.app.ui.modal(html, (b) => {
      const name = $('#acc-name', b), err = $('.acc-err', b);
      const usepw = $('#acc-usepw', b), pwrow = $('.acc-pwrow', b), pw = $('#acc-pw', b);
      const useface = face ? $('#acc-useface', b) : null;
      usepw.addEventListener('change', () => { pwrow.classList.toggle('hidden', !usepw.checked); if (usepw.checked) pw.focus(); });
      const create = async () => {
        const nm = name.value.replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16);
        if (!nm) { err.textContent = 'Type a username first.'; name.focus(); return; }
        // (the 🛡 and names like "Admin" are the admin's alone: parties would show 'Player')
        if (!playerName(nm)) { err.textContent = 'That name is only for the admin (Philip). Pick another one!'; name.focus(); return; }
        if (usepw.checked && pw.value.length < 3) { err.textContent = 'Make the password at least 3 characters.'; pw.focus(); return; }
        const btn = $('.acc-create', b);
        btn.disabled = true; btn.textContent = 'Creating…'; err.textContent = '';
        try {
          // a guest turning their session into a real account keeps the wins they just earned
          const prev = this.app.accounts.active();
          const carryStats = prev && prev.guest ? prev.stats : null;
          const opts = { name: nm, skin, sign: await makeSigningIdentity() };
          if (usepw.checked) opts.pw = await hashPassword(pw.value);
          if (useface && useface.checked) {
            const pk = await this.makePasskey(nm).catch(() => null);
            if (pk) opts.passkey = pk;
            else this.app.lobby.toast("Face ID didn't finish — your account is saved, add it later from the ⚙ profile.", { kind: 'bad', ms: 6000 });
          }
          const acc = this.app.accounts.create(opts);
          if (carryStats) this.app.accounts.update(acc.id, { stats: carryStats });
          // (the note above told them: no "New: the admin keeps a list of accounts" toast for this one)
          if (told && this.app.adminClient && this.app.adminClient.markTold) this.app.adminClient.markTold(acc.id);
          this.app.setActiveProfile(acc);
          this.app.ui.closeModal(true);
          this.app.lobby.toast(`Account <b>${esc(nm)}</b> created — saved on this iPad. 🎉`, { ms: 5000 });
        } catch (e) {
          btn.disabled = false; btn.textContent = 'CREATE & PLAY';
          err.textContent = 'Could not create the account. Try again.';
        }
      };
      $('.acc-create', b).addEventListener('click', create);
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !usepw.checked) create(); });
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
      $('.acc-back', b).addEventListener('click', () => this.whoScreen({ gate: this.app.ui.modalLocked }));
      setTimeout(() => { try { name.focus(); } catch (e) { /* ok */ } }, 50);
    }, null, { locked: this.app.ui.modalLocked });
  }

  // ---------------------------------------------------------------- sign in (protected profile)
  signIn(acc, { gate = false } = {}) {
    const skin = SKINS[acc.skin] || SKINS[0];
    const html = `<div class="acc">
      <h2 class="mem-h"><i style="background:${skin.outfit};box-shadow:inset 0 -6px 0 ${skin.accent}"></i>${esc(acc.name)}</h2>
      <p class="acc-sub">Signing in to your profile.</p>
      ${acc.passkey ? '<button class="btn yellow big acc-face">😊 UNLOCK WITH FACE ID / TOUCH ID</button>' : ''}
      ${acc.pw ? `<div class="rn-row"><input id="acc-signpw" type="password" maxlength="64" autocomplete="current-password" placeholder="Password"></div><div class="sheet-btns"><button class="btn ${acc.passkey ? '' : 'yellow '}big acc-signgo">SIGN IN</button></div>` : ''}
      <button class="acc-link acc-other" data-act="other">Use a different profile</button>
      <div class="acc-err" aria-live="polite"></div>
    </div>`;
    const done = () => {
      this.app.accounts.setActive(acc.id);
      this.app.setActiveProfile(acc);
      this.app.ui.closeModal(true);
      this.app.lobby.toast(`Welcome back, <b>${esc(acc.name)}</b>! 👋`);
    };
    this.app.ui.modal(html, (b) => {
      const err = $('.acc-err', b);
      const faceBtn = $('.acc-face', b);
      if (faceBtn) faceBtn.addEventListener('click', async () => {
        faceBtn.disabled = true; faceBtn.textContent = 'Scanning…'; err.textContent = '';
        const ok = await this.getPasskey(acc.passkey).catch(() => false);
        if (ok) done();
        else { faceBtn.disabled = false; faceBtn.textContent = '😊 UNLOCK WITH FACE ID / TOUCH ID'; err.textContent = 'That didn\'t work — try again, or use your password.'; }
      });
      const pwInput = $('#acc-signpw', b), go = $('.acc-signgo', b);
      if (go) {
        const submit = async () => {
          go.disabled = true; err.textContent = '';
          const ok = await verifyPassword(pwInput.value, acc.pw);
          if (ok) done();
          else { go.disabled = false; err.textContent = 'Wrong password — give it another go.'; this.shake(b); pwInput.focus(); pwInput.select(); }
        };
        go.addEventListener('click', submit);
        pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        setTimeout(() => { try { pwInput.focus(); } catch (e) { /* ok */ } }, 50);
      }
      $('.acc-other', b).addEventListener('click', () => this.whoScreen({ gate }));
    }, null, { locked: gate });
  }

  shake(b) {
    const card = b.closest('.modal-card') || b;
    card.classList.remove('acc-shake'); void card.offsetWidth; card.classList.add('acc-shake');
  }

  // ---------------------------------------------------------------- the account / STATS panel
  panel() {
    const app = this.app;
    const acc = app.accounts.active();
    if (!acc) { this.whoScreen({ gate: true }); return; }
    const s = acc.stats;
    const L = app.profile ? app.profile.levelInfo() : { level: s.level, xp: s.xp, need: 600, frac: 0 };
    const fav = favoriteMode(s);
    const tiles = [
      [s.wins, 'Wins'], [kd(s), 'K / D'], [s.matches, 'Matches'],
      [s.bestPlace ? `#${s.bestPlace}` : '—', 'Best place'], [`${winRate(s)}%`, 'Win rate'], [s.elims, 'Elims'],
    ];
    const extra = [
      [s.bestStreak, 'Best streak'], [playtimeLabel(s.playtime), 'Time played'], [s.total, 'Total XP'],
    ];
    const guestBadge = acc.guest ? '<span class="acc-badge">GUEST · not saved</span>' : acc.isAdmin ? '<span class="acc-badge admin">ADMIN</span>' : '<span class="acc-badge saved">saved on this iPad</span>';
    const html = `<div class="acc">
      <h2 class="acc-title">${esc(acc.name)} ${guestBadge}</h2>
      <div class="acc-levelline"><span class="acc-lvl">LEVEL ${L.level}</span><span class="acc-xp">${L.xp} / ${L.need} XP</span></div>
      <div class="rs-bar big"><i style="width:${Math.round(L.frac * 100)}%"></i></div>
      <div class="rs-tiles acc-tiles">${tiles.map(([n, l]) => `<div class="rs-tile"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('')}</div>
      <div class="rs-tiles acc-tiles">${extra.map(([n, l]) => `<div class="rs-tile"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('')}</div>
      ${fav ? `<p class="acc-fav">⭐ Favourite mode: <b>${esc(fav)}</b></p>` : ''}
      <div class="acc-manage">
        <button class="btn acc-switch">🔄 SWITCH PROFILE</button>
        <button class="btn acc-rename">✎ RENAME</button>
        ${acc.guest ? '<button class="btn yellow acc-keep">💾 SAVE AS ACCOUNT</button>' : '<button class="btn acc-move">📦 MOVE MY ACCOUNT</button>'}
        <button class="btn acc-signout">🚪 SIGN OUT</button>
        ${acc.guest ? '' : '<button class="btn acc-delete danger">🗑 DELETE ACCOUNT</button>'}
      </div>
      <p class="acc-note">Everything here is saved only on this iPad.${app.adminCfg && !acc.guest ? ' The admin (Philip) can see this account\'s name, level and wins and when it last played (even when you\'re offline), so he can keep Phortnite fair, and he can ban it. A ban locks this whole iPad, every profile on it.' : ''}</p>
      <div class="acc-adminrow" data-back="panel"></div>
    </div>`;
    app.ui.modal(html, (b) => {
      if (app.adminLogin) app.adminLogin.bits($('.acc-adminrow', b));
      $('.acc-switch', b).addEventListener('click', () => { app.sfx.ui(); this.whoScreen({ gate: false }); });
      $('.acc-rename', b).addEventListener('click', () => { app.sfx.ui(); app.ui.closeModal(true); app.ui.renameModal(); });
      $('.acc-signout', b).addEventListener('click', () => { app.sfx.ui(); app.signOut(); });
      const move = $('.acc-move', b); if (move) move.addEventListener('click', () => { app.sfx.ui(); this.transferExport(acc); });
      const keep = $('.acc-keep', b); if (keep) keep.addEventListener('click', () => { app.sfx.ui(); this.createScreen(); });
      const del = $('.acc-delete', b); if (del) del.addEventListener('click', () => { app.sfx.ui(); this.confirmDelete(acc); });
    });
  }

  confirmDelete(acc) {
    const html = `<div class="acc"><h2>DELETE ${esc(acc.name)}?</h2>
      <p class="acc-sub">This wipes this profile and all its wins from this iPad. It can't be undone.</p>
      <div class="sheet-btns"><button class="btn danger big acc-yes">DELETE FOREVER</button><button class="btn yellow big acc-no">KEEP IT</button></div></div>`;
    this.app.ui.modal(html, (b) => {
      $('.acc-yes', b).addEventListener('click', () => {
        this.app.accounts.remove(acc.id);
        this.app.signOut();
        this.app.lobby.toast('Profile deleted.');
      });
      $('.acc-no', b).addEventListener('click', () => this.panel());
    });
  }

  // ---------------------------------------------------------------- transfer: move my account
  async transferExport(acc) {
    const html = `<div class="acc"><h2>MOVE MY ACCOUNT</h2>
      <p class="acc-sub">Set a short PIN, then type the code (or scan the QR) on the other iPad. Your account stays private — nothing is sent anywhere.</p>
      <div class="rn-row"><input id="acc-pin" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="A PIN you'll remember (e.g. 1234)"></div>
      <div class="sheet-btns"><button class="btn yellow big acc-makecode">MAKE MY CODE</button><button class="btn big acc-back">BACK</button></div>
      <div class="acc-code hidden"></div><div class="acc-err" aria-live="polite"></div></div>`;
    this.app.ui.modal(html, (b) => {
      const pin = $('#acc-pin', b), err = $('.acc-err', b), out = $('.acc-code', b);
      const make = async () => {
        if (pin.value.length < 4) { err.textContent = 'Make the PIN at least 4 characters.'; pin.focus(); return; }
        const btn = $('.acc-makecode', b); btn.disabled = true; btn.textContent = 'Making…'; err.textContent = '';
        try {
          const obj = this.app.accounts.exportObject(acc.id);
          const code = await encryptTransfer(obj, pin.value);
          out.innerHTML = `<div class="acc-codehead">On the other iPad: tap <b>"I have an account code"</b>, type this code and your PIN.</div>
            <div class="acc-codebox" aria-label="Your account code">${esc(code)}</div>
            <div class="acc-btns"><button class="btn acc-copy">🔗 COPY CODE</button></div>
            <div class="acc-qr"><img alt="QR code for the account code"></div>`;
          out.classList.remove('hidden');
          btn.disabled = false; btn.textContent = 'MAKE MY CODE';
          $('.acc-copy', b).addEventListener('click', () => {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(() => this.app.lobby.toast('Code copied!'), () => {});
            else this.app.lobby.toast('Press and hold the code to copy it');
          });
          try { const { qrDataUrl } = await import('../net/p2p.js'); const src = await qrDataUrl(code); const img = $('.acc-qr img', b); if (src && img) img.src = src; else $('.acc-qr', b).classList.add('none'); } catch (e) { $('.acc-qr', b).classList.add('none'); }
        } catch (e) { btn.disabled = false; btn.textContent = 'MAKE MY CODE'; err.textContent = 'Could not make a code. Try again.'; }
      };
      $('.acc-makecode', b).addEventListener('click', make);
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
      $('.acc-back', b).addEventListener('click', () => this.panel());
    });
  }

  transferImport() {
    const gate = this.app.ui.modalLocked;
    const html = `<div class="acc"><h2>I HAVE A CODE</h2>
      <p class="acc-sub">Paste the account code from your other iPad and type the same PIN.</p>
      <div class="rn-row"><textarea id="acc-incode" rows="3" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Paste the code (starts with PHA1.)"></textarea></div>
      <div class="rn-row"><input id="acc-inpin" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="Your PIN"></div>
      <div class="sheet-btns"><button class="btn yellow big acc-import-go">BRING IT OVER</button><button class="btn big acc-back">BACK</button></div>
      <div class="acc-err" aria-live="polite"></div></div>`;
    this.app.ui.modal(html, (b) => {
      const code = $('#acc-incode', b), pin = $('#acc-inpin', b), err = $('.acc-err', b);
      const go = async () => {
        err.textContent = '';
        const btn = $('.acc-import-go', b); btn.disabled = true; btn.textContent = 'Bringing it over…';
        try {
          const obj = await decryptTransfer(code.value.trim(), pin.value);
          // a banned account can't be brought over (refused before anything is saved; the ban list
          // comes a moment after the game connects: waited for, briefly)
          const ac = this.app.adminClient;
          if (obj && obj.id && ac && ac.accountBanned) {
            if (ac.banListReady) await ac.banListReady(2000);
            if (await ac.accountBanned(obj.id)) throw new Error("🛡 This account was banned by the admin (Philip), so it can't be brought over to this iPad.");
          }
          const acc = this.app.accounts.importProfile(obj);
          this.app.accounts.setActive(acc.id);
          this.app.setActiveProfile(acc);
          this.app.ui.closeModal(true);
          this.app.lobby.toast(`Brought <b>${esc(acc.name)}</b> over — saved on this iPad. 🎉`, { ms: 5000 });
        } catch (e) {
          btn.disabled = false; btn.textContent = 'BRING IT OVER';
          err.textContent = e && e.message ? e.message : "That didn't work — check the code and PIN.";
          this.shake(b);
        }
      };
      $('.acc-import-go', b).addEventListener('click', go);
      $('.acc-back', b).addEventListener('click', () => this.whoScreen({ gate }));
    }, null, { locked: gate });
  }

  // ---------------------------------------------------------------- Face ID / Touch ID (platform passkey + PRF)
  /** Does this device offer a platform authenticator with the PRF extension? Cached; never throws. */
  checkFace() {
    if (this.faceReady !== null) return Promise.resolve(this.faceReady);
    return new Promise((resolve) => {
      const P = globalThis.PublicKeyCredential;
      const done = (v) => { this.faceReady = v; resolve(v); };
      let t = setTimeout(() => done(false), 3000);
      const ok = (v) => { clearTimeout(t); done(v); };
      try {
        if (!window.isSecureContext || !P || !navigator.credentials || typeof navigator.credentials.create !== 'function' || typeof P.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') { ok(false); return; }
        Promise.resolve(P.isUserVerifyingPlatformAuthenticatorAvailable()).then((uv) => {
          if (uv !== true) { ok(false); return; }
          if (typeof P.getClientCapabilities !== 'function') { ok(true); return; }
          Promise.resolve(P.getClientCapabilities()).then((c) => ok(!(c && c['extension:prf'] === false)), () => ok(true));
        }, () => ok(false));
      } catch (e) { ok(false); }
    });
  }

  /** Make a platform passkey for a new account. Resolves { id, salt } (base64url), or rejects. */
  async makePasskey(name) {
    const salt = rand(32);
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: 'Phortnite' },
        user: { id: rand(16), name: `phortnite:${name}`, displayName: name },
        challenge: rand(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 60000, extensions: { prf: { eval: { first: salt } } },
      },
    });
    if (!cred || !cred.rawId) throw new Error('no passkey');
    return { id: this.b64url(new Uint8Array(cred.rawId)), salt: this.b64url(salt) };
  }

  /** Prove the player with their account's passkey (userVerification required). Resolves true/false. */
  async getPasskey(pk) {
    if (!pk || !pk.id) return false;
    try {
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: rand(32), rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: this.unb64url(pk.id) }],
          userVerification: 'required', timeout: 60000,
          extensions: pk.salt ? { prf: { eval: { first: this.unb64url(pk.salt) } } } : undefined,
        },
      });
      return !!(cred && cred.rawId);
    } catch (e) { return false; }
  }

  b64url(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  unb64url(str) { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
}
