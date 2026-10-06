// Menus and modal dialogs.
import { SKINS } from '../../shared/constants.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Ui {
  constructor(app) {
    this.app = app;
    this.menu = $('#menu');
    this.modalEl = $('#modal');
    this.modalBody = $('.modal-body', this.modalEl);
    this.onModalClose = null;
    $('.modal-x', this.modalEl).addEventListener('click', () => this.closeModal());
    this.modalEl.addEventListener('pointerdown', (e) => { if (e.target === this.modalEl) this.closeModal(); });

    const st = app.settings;
    const name = $('#name');
    name.value = st.name;
    name.addEventListener('input', () => { st.name = name.value.slice(0, 16); app.saveSettings(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    $('#btn-solo').addEventListener('click', () => { app.sfx.ui(); app.playSolo(); });
    $('#btn-friends').addEventListener('click', () => { app.sfx.ui(); this.friendsModal(); });
    $('#btn-locker').addEventListener('click', () => { app.sfx.ui(); this.lockerModal(); });
    $('#btn-settings').addEventListener('click', () => { app.sfx.ui(); this.settingsModal(); });
    $('#btn-help').addEventListener('click', () => { app.sfx.ui(); this.helpModal(); });
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#skin-prev').addEventListener('click', () => this.setSkin(st.skin - 1));
    $('#skin-next').addEventListener('click', () => this.setSkin(st.skin + 1));
    this.setSkin(st.skin);

    // in-game buttons
    $('#menubtn').addEventListener('click', () => this.pauseModal());
    $('.es-again').addEventListener('click', () => { this.app.game && this.app.game.playAgain(); });
    $('.es-spec').addEventListener('click', () => {
      this.app.hud.elim({ spectating: true, sub: 'Spectating — tap fire / click to switch player', leave: true, again: this.app.game && this.app.game.solo });
      this.app.resume();
    });
    $('.es-leave').addEventListener('click', () => this.app.leaveGame());
    const lp = $('#lobbypanel');
    $('.lp-min', lp).addEventListener('click', () => lp.classList.toggle('min'));
    const bots = $('.lp-bots', lp), botsv = $('.lp-botsv', lp), mats = $('.lp-mats', lp), mode = $('.lp-mode', lp);
    mode.addEventListener('change', () => this.app.game && this.app.game.send({ t: 'settings', mode: mode.value }));
    bots.addEventListener('input', () => { botsv.textContent = bots.value; });
    bots.addEventListener('change', () => this.app.game && this.app.game.send({ t: 'settings', bots: +bots.value }));
    mats.addEventListener('change', () => this.app.game && this.app.game.send({ t: 'settings', mats: +mats.value }));
    $('.lp-start', lp).addEventListener('click', () => {
      this.app.sfx.ui();
      this.app.game && this.app.game.startMatch(+bots.value, +mats.value, mode.value);
    });
    for (const el of [lp, $('#elimscreen'), $('#menubtn')]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  setSkin(i) {
    const st = this.app.settings;
    st.skin = (i + SKINS.length) % SKINS.length;
    this.app.saveSettings();
    $('#skin-name').textContent = SKINS[st.skin].name.toUpperCase();
    this.app.setMenuSkin(st.skin);
  }

  showMenu(on) { this.menu.classList.toggle('hidden', !on); }

  modal(html, onMount, onClose) {
    if (this.app.game) this.app.input.enabled = false;
    this.modalBody.innerHTML = html;
    this.modalEl.classList.remove('hidden');
    this.onModalClose = onClose || null;
    if (onMount) onMount(this.modalBody);
  }

  closeModal() {
    if (this.modalEl.classList.contains('hidden')) return;
    this.modalEl.classList.add('hidden');
    if (this.app.game && this.app.game.me) this.app.input.enabled = true;
    const cb = this.onModalClose;
    this.onModalClose = null;
    if (cb) cb();
  }

  modalOpen() { return !this.modalEl.classList.contains('hidden'); }

  alert(msg) {
    this.modal(`<h2>Heads up</h2><p>${esc(msg)}</p><button class="btn yellow ok">OK</button>`, (b) => {
      $('.ok', b).addEventListener('click', () => this.closeModal());
    });
  }

  toggleFullscreen() {
    const d = document, el = d.documentElement;
    const fs = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (fs) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } catch (e) {
      this.alert('Full screen is not available here. On iPad, tap Share → "Add to Home Screen" and open Phortnite from the home screen for full screen.');
    }
  }

  // ------------------------------------------------------------------ locker
  lockerModal() {
    const st = this.app.settings;
    const html = `<h2>LOCKER</h2><div class="skins">${SKINS.map((s, i) => `<button data-i="${i}" class="${i === st.skin ? 'sel' : ''}" style="background:linear-gradient(160deg, ${s.outfit}, ${s.pants}); box-shadow: inset 0 -6px 0 ${s.accent}">${esc(s.name)}</button>`).join('')}</div>`;
    this.modal(html, (b) => {
      b.querySelectorAll('.skins button').forEach((btn) => btn.addEventListener('click', () => {
        this.setSkin(+btn.dataset.i);
        b.querySelectorAll('.skins button').forEach((x) => x.classList.toggle('sel', x === btn));
      }));
    });
  }

  // ------------------------------------------------------------------ settings
  settingsModal(onClose) {
    const st = this.app.settings;
    const q = ['auto', 'low', 'medium', 'high', 'ultra'];
    const html = `<h2>SETTINGS</h2>
      <div class="setting"><span>Graphics quality</span><select id="s-q">${q.map((x) => `<option ${x === st.quality ? 'selected' : ''} value="${x}">${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
      <div class="setting"><span>Mouse / controller sensitivity</span><input id="s-sens" type="range" min="0.2" max="3" step="0.05" value="${st.sens}"></div>
      <div class="setting"><span>Touch look sensitivity</span><input id="s-tsens" type="range" min="0.3" max="3" step="0.05" value="${st.touchSens}"></div>
      <div class="setting"><span>Field of view</span><input id="s-fov" type="range" min="65" max="100" step="1" value="${st.fov}"></div>
      <div class="setting"><span>Volume</span><input id="s-vol" type="range" min="0" max="1" step="0.05" value="${st.volume}"></div>
      <div class="setting"><span>Auto-shoot when the crosshair is on an enemy</span><input id="s-auto" type="checkbox" ${st.autoFire ? 'checked' : ''}></div>
      <div class="setting"><span>Aim assist (touch &amp; controller)</span><input id="s-aa" type="checkbox" ${st.aimAssist ? 'checked' : ''}></div>
      <div class="setting"><span>Invert look up/down</span><input id="s-inv" type="checkbox" ${st.invertY ? 'checked' : ''}></div>
      <div class="setting"><span>Camera shake</span><input id="s-shake" type="checkbox" ${st.shake ? 'checked' : ''}></div>
      <div class="setting"><span>Show FPS counter</span><input id="s-fps" type="checkbox" ${st.showFps ? 'checked' : ''}></div>
      <div class="setting"><span>Always use touch controls</span><input id="s-touch" type="checkbox" ${st.forceTouch ? 'checked' : ''}></div>
      <p style="font-size:13px;opacity:.7">"Auto" picks Medium on iPad and High on computers, then the game lowers its resolution on the fly to hold a steady frame rate.</p>`;
    this.modal(html, (b) => {
      const bind = (id, key, conv, after) => {
        const el = $(id, b);
        el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
          st[key] = el.type === 'checkbox' ? el.checked : conv(el.value);
          this.app.saveSettings();
          after && after();
        });
      };
      bind('#s-q', 'quality', String, () => this.app.applyQuality());
      bind('#s-sens', 'sens', Number);
      bind('#s-tsens', 'touchSens', Number);
      bind('#s-fov', 'fov', Number);
      bind('#s-vol', 'volume', Number, () => this.app.sfx.setVolume(st.volume));
      bind('#s-auto', 'autoFire', Boolean);
      bind('#s-aa', 'aimAssist', Boolean);
      bind('#s-inv', 'invertY', Boolean);
      bind('#s-shake', 'shake', Boolean);
      bind('#s-fps', 'showFps', Boolean, () => this.app.hud.fps(''));
      bind('#s-touch', 'forceTouch', Boolean, () => { this.app.input.forceTouch = st.forceTouch; this.app.input.setTouchMode(st.forceTouch || this.app.isTouch); });
    }, onClose);
  }

  helpModal(onClose) {
    const html = `<h2>HOW TO PLAY</h2>
      <p>Drop from the flying bus, grab weapons from the floor and golden chests, harvest materials with your pickaxe and build walls, floors and ramps to out-play everyone. Stay inside the storm circle — the last player standing wins a <b>Phictory Royale</b>!</p>
      <h3>iPad / touch</h3>
      <table>
        <tr><td>Move</td><td>Left thumb anywhere on the left side (push to the edge to sprint)</td></tr>
        <tr><td>Look / aim</td><td>Drag anywhere on the right side (the big fire button aims too)</td></tr>
        <tr><td>Shoot</td><td>Red ✛ buttons (right and left) — or let <b>auto-shoot</b> fire for you: when your crosshair turns red over an enemy your gun fires by itself (snipers while scoped in). Switch it on or off in Settings.</td></tr>
        <tr><td>Jump / crouch</td><td>⤒ and ⤓</td></tr>
        <tr><td>Aim down sights</td><td>◎ (toggle)</td></tr>
        <tr><td>Aim assist</td><td>Aiming slows down over enemies and helps you stay on them while you aim or shoot; tap ◎ near an enemy and your aim swings onto them. Touch and controllers only — switch it off in Settings.</td></tr>
        <tr><td>Build</td><td>⚒ then Wall / Floor / Ramp, fire places it, "Mat" switches material</td></tr>
        <tr><td>Weapons & heals</td><td>Tap the slots at the bottom. Hold fire to use heals.</td></tr>
        <tr><td>Map / dance</td><td>Tap the minimap / 💃</td></tr>
      </table>
      <h3>Keyboard & mouse</h3>
      <table>
        <tr><td>Move / jump / sprint</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · <kbd>Space</kbd> · <kbd>Shift</kbd></td></tr>
        <tr><td>Crouch</td><td><kbd>Ctrl</kbd> (hold) or <kbd>V</kbd> (toggle)</td></tr>
        <tr><td>Shoot / aim</td><td>Left mouse / right mouse</td></tr>
        <tr><td>Weapons</td><td><kbd>1</kbd>–<kbd>5</kbd>, mouse wheel, <kbd>F</kbd> pickaxe</td></tr>
        <tr><td>Build wall / floor / ramp</td><td><kbd>Q</kbd> / <kbd>Z</kbd> / <kbd>C</kbd> (<kbd>B</kbd> toggles build mode)</td></tr>
        <tr><td>Change material</td><td><kbd>G</kbd> or right mouse while building</td></tr>
        <tr><td>Reload / interact</td><td><kbd>R</kbd> / <kbd>E</kbd></td></tr>
        <tr><td>Map / menu / dance</td><td><kbd>M</kbd> / <kbd>Esc</kbd> / <kbd>T</kbd></td></tr>
      </table>
      <h3>Controllers</h3>
      <p>Bluetooth game controllers work too: sticks move & look, triggers aim & shoot, A jump, B crouch, X reload/interact, Y build, D-pad picks wall/floor/ramp/material.</p>
      <h3>Playing with friends</h3>
      <p>Everyone opens the Phortnite website and taps <b>Play with Friends</b>. One player hosts a party; the others join with the 4-letter party code it shows (or scan its QR code with the iPad camera). The host picks how many bots to add and starts the match — and must keep the game open, because the match runs on the host's device.</p>`;
    this.modal(html, null, onClose);
  }

  // ------------------------------------------------------------------ multiplayer
  async friendsModal() {
    const app = this.app;
    if (!document.documentElement.dataset.server) {
      // the website (no Phortnite server behind it): parties are hosted peer-to-peer
      this.p2pModal();
      return;
    }
    this.modal('<h2>PLAY WITH FRIENDS</h2><p>Connecting to the Phortnite server…</p>');
    let net;
    try {
      net = await app.connectServer();
    } catch (e) {
      // no Phortnite server behind this page (e.g. the GitHub Pages website): play peer-to-peer
      this.p2pModal();
      return;
    }
    let info = null;
    try { info = await (await fetch('api/info', { cache: 'no-store' })).json(); } catch (e) { /* hosted without info */ }
    const lan = info && info.lan && info.lan[0];
    const here = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? lan : location.href.split('#')[0].split('?')[0];
    const shareUrl = here || location.href;
    app.shareHtml = `Friends open <code>${esc(shareUrl)}</code> → Play with Friends`;
    const render = (rooms) => {
      const list = rooms.length ? rooms.map((r) => `<li><span class="nm">${esc(r.name)}</span>${r.sameNet ? '<span class="badge">SAME WI-FI</span>' : ''}<span class="meta">${r.players}/${r.max} · ${r.phase === 'lobby' ? 'in lobby' : 'match running'} · ${esc(r.code)}</span><button class="btn small yellow" data-code="${esc(r.code)}">JOIN</button></li>`).join('')
        : '<li><span class="meta">No parties yet — create one and your friends will see it here.</span></li>';
      this.modalBody.querySelector('.mp-list').innerHTML = list;
      this.modalBody.querySelectorAll('.mp-list button').forEach((b) => b.addEventListener('click', () => this.join(net, b.dataset.code)));
    };
    this.modal(`<h2>PLAY WITH FRIENDS</h2>
      <h3>Parties on this server</h3>
      <ul class="mp-list"></ul>
      <div class="mp-row">
        <button class="btn yellow mp-create">CREATE PARTY</button>
        <input class="mp-code" maxlength="4" placeholder="CODE" autocomplete="off">
        <button class="btn blue mp-join">JOIN CODE</button>
        <button class="btn small mp-refresh">↻</button>
      </div>
      <div class="share"><img alt="QR code" src="api/qr.svg?u=${encodeURIComponent(shareUrl)}"><div>Everyone on the same Wi-Fi: open<br><code>${esc(shareUrl)}</code><br>or scan this code with the iPad camera, then tap <b>Play with Friends</b>.</div></div>`, (b) => {
      $('.mp-create', b).addEventListener('click', () => this.join(net, null));
      $('.mp-join', b).addEventListener('click', () => this.join(net, $('.mp-code', b).value));
      $('.mp-code', b).addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(net, e.target.value); });
      $('.mp-refresh', b).addEventListener('click', () => net.send({ t: 'list' }));
      const img = $('.share img', b);
      img.addEventListener('error', () => { img.style.display = 'none'; });
    }, () => { if (!app.game) net.close(); });
    const off = net.onMessage((m) => {
      if (m.t === 'rooms') render(m.rooms);
      if (m.t === 'err' && !app.game) this.alert(m.msg);
    });
    this.roomsOff = off;
    net.send({ t: 'list' });
    clearInterval(this.listTimer);
    this.listTimer = setInterval(() => { if (this.modalOpen() && !app.game) net.send({ t: 'list' }); else clearInterval(this.listTimer); }, 3000);
  }

  /** Parties without a server: one device hosts, friends join with the code. */
  p2pModal(prefill = '') {
    const app = this.app;
    this.modal(`<h2>PLAY WITH FRIENDS</h2>
      <p>One player hosts a party on their iPad or computer, then everyone else joins with the 4-letter party code. Works best when you're all on the same Wi-Fi. The host's device runs the match, so the host should keep the game open.</p>
      <div class="mp-row"><button class="btn big yellow p2p-host" style="width:auto">HOST A PARTY</button></div>
      <h3>Join a friend's party</h3>
      <div class="mp-row">
        <input class="mp-code" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" value="${esc(prefill)}">
        <button class="btn blue p2p-join">JOIN</button>
      </div>`, (b) => {
      const go = () => {
        const code = $('.mp-code', b).value.trim().toUpperCase();
        if (!/^[A-Z]{4}$/.test(code)) { this.alert('Party codes are 4 letters, like ABCD.'); return; }
        this.onModalClose = null;
        this.modalEl.classList.add('hidden');
        app.startP2PJoin(code);
      };
      $('.p2p-host', b).addEventListener('click', () => {
        this.onModalClose = null;
        this.modalEl.classList.add('hidden');
        app.startP2PHost();
      });
      $('.p2p-join', b).addEventListener('click', go);
      $('.mp-code', b).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
  }

  join(net, code) {
    const app = this.app;
    if (code !== null && !/^[a-z]{4}$/i.test(String(code).trim())) { this.alert('Party codes are 4 letters, like ABCD.'); return; }
    clearInterval(this.listTimer);
    this.onModalClose = null;
    this.modalEl.classList.add('hidden');
    app.startOnlineGame(net, code);
  }

  // ------------------------------------------------------------------ pause
  pauseModal() {
    const app = this.app;
    const g = app.game;
    if (!g) return;
    app.input.exitLock();
    const canEnd = g.leader === g.myId && g.phase !== 'lobby' && !g.solo;
    const html = `<h2>PAUSED</h2>
      <p style="opacity:.75;font-size:14px">${g.solo ? 'Solo match' : `Party code <b style="color:#ffd23f;letter-spacing:3px">${esc(g.code)}</b>`} — the game keeps running in the background.</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
        <button class="btn yellow p-resume">RESUME</button>
        <button class="btn p-settings">SETTINGS</button>
        <button class="btn p-help">HOW TO PLAY</button>
        ${g.solo && g.phase !== 'lobby' ? '<button class="btn p-restart">RESTART MATCH</button>' : ''}
        ${canEnd ? '<button class="btn p-end">END MATCH FOR EVERYONE</button>' : ''}
        <button class="btn p-leave">LEAVE GAME</button>
      </div>`;
    const resume = () => { this.closeModal(); app.resume(); };
    this.modal(html, (b) => {
      $('.p-resume', b).addEventListener('click', resume);
      $('.p-settings', b).addEventListener('click', () => this.settingsModal(() => this.pauseModal()));
      $('.p-help', b).addEventListener('click', () => this.helpModal(() => this.pauseModal()));
      const rs = $('.p-restart', b);
      if (rs) rs.addEventListener('click', () => { this.closeModal(); g.playAgain(); app.resume(); });
      const end = $('.p-end', b);
      if (end) end.addEventListener('click', () => { g.send({ t: 'end' }); resume(); });
      $('.p-leave', b).addEventListener('click', () => { this.closeModal(); app.leaveGame(); });
    });
  }
}
