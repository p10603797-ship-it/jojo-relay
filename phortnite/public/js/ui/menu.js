// Menus and modal dialogs.
import { SKINS } from '../../shared/constants.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Ui {
  constructor(app) {
    this.app = app;
    this.modalEl = $('#modal');
    this.modalBody = $('.modal-body', this.modalEl);
    this.onModalClose = null;
    $('.modal-x', this.modalEl).addEventListener('click', () => this.closeModal());
    this.modalEl.addEventListener('pointerdown', (e) => { if (e.target === this.modalEl) this.closeModal(); });

    // in-game buttons
    $('#menubtn').addEventListener('click', () => this.pauseModal());
    // the end screen (js/ui/endscreen.js)
    $('.es-again').addEventListener('click', () => {
      const g = this.app.game;
      if (!g) return;
      this.app.sfx.ui();
      if (g.phase !== 'lobby') this.app.playAgainPending = true;
      g.playAgain();
    });
    $('.es-spec').addEventListener('click', () => {
      this.app.sfx.ui();
      this.app.hud.elim({ spectating: true, sub: 'Spectating — tap fire / click to switch player', leave: true, again: this.app.game && this.app.game.solo });
      this.app.resume();
    });
    $('.es-leave').addEventListener('click', () => { this.app.sfx.ui(); this.app.backToLobby(); });
    for (const el of [$('#elimscreen'), $('#menubtn')]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  setSkin(i) {
    const app = this.app;
    const st = app.settings;
    st.skin = (i + SKINS.length) % SKINS.length;
    app.saveSettings();
    // friends see it at once (skins change in the lobby only)
    const g = app.game;
    if (g && g.phase === 'lobby') g.send({ t: 'look', skin: st.skin });
  }

  /** Rename yourself (tap your nameplate or your party card). */
  renameModal() {
    const app = this.app;
    const st = app.settings;
    this.modal(`<h2>YOUR NAME</h2>
      <div class="rn-row"><input id="rn-name" maxlength="16" autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(st.name)}"></div>
      <div class="sheet-btns"><button class="btn yellow big rn-ok">SAVE</button></div>`, (b) => {
      const input = $('#rn-name', b);
      const save = () => {
        const n = input.value.replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16);
        if (n) {
          st.name = n;
          app.saveSettings();
          if (app.game) app.game.send({ t: 'look', name: n });
        }
        this.closeModal();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      $('.rn-ok', b).addEventListener('click', save);
      input.focus();
      input.select();
    });
  }

  /** Your level and totals (the level chip). */
  profileModal() {
    const pr = this.app.profile;
    if (!pr) return;
    const L = pr.levelInfo(), d = pr.data;
    this.modal(`<h2>LEVEL ${L.level}</h2>
      <div class="rs-bar big"><i style="width:${Math.round(L.frac * 100)}%"></i></div>
      <p class="mem-sub">${L.xp} / ${L.need} XP to level ${L.level + 1}</p>
      <div class="rs-tiles">${[[d.matches, 'Matches'], [d.wins, 'Wins'], [d.elims, 'Elims'], [d.total, 'Total XP']].map(([n, l]) => `<div class="rs-tile"><b>${n}</b><span>${l}</span></div>`).join('')}</div>
      <p class="mem-sub">Earn XP with eliminations (50 each), a top 10 finish, damage, and 300 for every Phictory Royale.</p>`);
  }

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
    const html = `<h2>LOCKER</h2><p class="mem-sub">Pick a look: your friends see it in the lobby right away.</p><div class="skins">${SKINS.map((s, i) => `<button data-i="${i}" class="${i === st.skin ? 'sel' : ''}" style="background:linear-gradient(160deg, ${s.outfit}, ${s.pants}); box-shadow: inset 0 -6px 0 ${s.accent}">${esc(s.name)}</button>`).join('')}</div>`;
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
      <div class="setting"><span>Build immediately (touch: one tap places a piece)</span><input id="s-tap" type="checkbox" ${st.tapBuild ? 'checked' : ''}></div>
      <div class="setting"><span>Touch button size</span><input id="s-tbs" type="range" min="0.8" max="1.3" step="0.05" value="${st.tbScale}"></div>
      <div class="setting"><span>Touch button opacity</span><input id="s-tba" type="range" min="0.3" max="1" step="0.05" value="${st.tbAlpha}"></div>
      <div class="setting"><span>Music volume</span><input id="s-music" type="range" min="0" max="1" step="0.05" value="${st.music}"></div>
      <div class="setting"><span>Default bot difficulty</span><select id="s-bot">${['easy', 'normal', 'hard', 'mixed'].map((x) => `<option ${x === st.botLevel ? 'selected' : ''} value="${x}">${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
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
      bind('#s-tap', 'tapBuild', Boolean);
      const tb = () => {
        // the touch layout reads these (--tb-scale / --tb-alpha)
        this.app.applyTouchVars();
        if (this.app.input.applySettings) this.app.input.applySettings(st);
      };
      bind('#s-tbs', 'tbScale', Number, tb);
      bind('#s-tba', 'tbAlpha', Number, tb);
      bind('#s-music', 'music', Number, () => this.app.music && this.app.music.setVolume(st.music));
      bind('#s-bot', 'botLevel', String, () => this.app.tweakBots());
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
        <tr><td>Build</td><td>⚒, then tap Wall / Ramp / Floor / Cone: one tap places a piece (hold it and turn or walk to keep building). "Mat" switches material. No build buttons in Zero Build modes.</td></tr>
        <tr><td>Edit</td><td>Look at your (or a teammate's) wall or floor and tap the yellow ✎ EDIT button, then DOOR / WINDOW / ARCH / HALF (or HOLE on floors). Tap the same one again, or RESET, to close it up.</td></tr>
        <tr><td>Weapons & heals</td><td>Tap the slots at the bottom. Hold fire to use heals.</td></tr>
        <tr><td>Map / dance</td><td>Tap the minimap / 💃</td></tr>
      </table>
      <h3>Keyboard & mouse</h3>
      <table>
        <tr><td>Move / jump / sprint</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · <kbd>Space</kbd> · <kbd>Shift</kbd></td></tr>
        <tr><td>Crouch</td><td><kbd>Ctrl</kbd> (hold) or <kbd>X</kbd> (toggle)</td></tr>
        <tr><td>Shoot / aim</td><td>Left mouse / right mouse</td></tr>
        <tr><td>Weapons</td><td><kbd>1</kbd>–<kbd>5</kbd>, mouse wheel, <kbd>F</kbd> pickaxe</td></tr>
        <tr><td>Build wall / floor / ramp / cone</td><td><kbd>Q</kbd> / <kbd>Z</kbd> / <kbd>C</kbd> / <kbd>V</kbd> (<kbd>B</kbd> toggles build mode)</td></tr>
        <tr><td>Edit</td><td><kbd>G</kbd> while looking at your (or a teammate's) piece, then <kbd>1</kbd>–<kbd>5</kbd> (door, window, arch, half, reset)</td></tr>
        <tr><td>Change material</td><td><kbd>G</kbd> (when no piece of yours is under the crosshair) or right mouse while building</td></tr>
        <tr><td>Reload / interact</td><td><kbd>R</kbd> / <kbd>E</kbd></td></tr>
        <tr><td>Map / menu / dance</td><td><kbd>M</kbd> / <kbd>Esc</kbd> / <kbd>T</kbd></td></tr>
      </table>
      <h3>Controllers</h3>
      <p>Bluetooth game controllers work too: sticks move & look, triggers aim & shoot, A jump, B crouch, X reload / interact, Y build mode, bumpers change weapon. D-pad up / down / left / right builds a wall / floor / ramp / cone; R3 (or LT in build mode) changes material. Hold B to edit: the D-pad picks the edit and Y resets it.</p>
      <h3>Playing with friends</h3>
      <p>Play with friends anywhere: tap <b>+ INVITE</b> in the lobby and send the 4-letter party code, the QR code or the link (SHARE / COPY LINK). Friends tap <b>JOIN A FRIEND</b> and type the code, or just open the link. The party leader (♛) picks the mode with <b>CHANGE</b> and presses <b>PLAY</b>; everyone else taps <b>READY</b>. After a match everybody comes back to the lobby together. On the website the party runs on the host's device, so the host should keep the game open; if the Wi-Fi blips you get back into the same match within a minute.</p>`;
    this.modal(html, null, onClose);
  }

  // ------------------------------------------------------------------ pause
  pauseModal() {
    const app = this.app;
    const g = app.game;
    if (!g || app.stageOn) return;
    app.input.exitLock();
    const solo = g.net.kind === 'solo';
    const live = g.phase === 'bus' || g.phase === 'match';
    // solo: the match really stops while this is open
    if (solo && live) app.pauseSolo();
    const canEnd = g.leader === g.myId && g.phase !== 'lobby' && !solo;
    const html = `<h2>PAUSED</h2>
      <p style="opacity:.75;font-size:14px">${solo ? (live ? 'The match is paused.' : 'Warm-up') : `Party code <b style="color:#ffd23f;letter-spacing:3px">${esc(g.code)}</b> — the match keeps running for your friends.`}</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
        <button class="btn yellow p-resume">RESUME</button>
        <button class="btn p-settings">SETTINGS</button>
        <button class="btn p-help">HOW TO PLAY</button>
        ${solo && live ? '<button class="btn p-restart">RESTART MATCH</button>' : ''}
        ${canEnd ? '<button class="btn p-end">END MATCH FOR EVERYONE</button>' : ''}
        <button class="btn p-lobby">${solo && live ? 'QUIT TO LOBBY' : 'BACK TO LOBBY'}</button>
        ${solo ? '' : '<button class="btn p-leave">LEAVE PARTY</button>'}
      </div>`;
    const done = () => { if (app.paused) app.unpause(); };
    const resume = () => { this.closeModal(); app.resume(); };
    this.modal(html, (b) => {
      $('.p-resume', b).addEventListener('click', resume);
      $('.p-settings', b).addEventListener('click', () => { this.onModalClose = null; this.settingsModal(() => this.pauseModal()); });
      $('.p-help', b).addEventListener('click', () => { this.onModalClose = null; this.helpModal(() => this.pauseModal()); });
      const rs = $('.p-restart', b);
      if (rs) rs.addEventListener('click', () => { this.closeModal(); app.playAgainPending = true; g.playAgain(); app.resume(); });
      const end = $('.p-end', b);
      if (end) end.addEventListener('click', () => { g.send({ t: 'end' }); resume(); });
      $('.p-lobby', b).addEventListener('click', () => { this.closeModal(); app.backToLobby(); });
      const lv = $('.p-leave', b);
      if (lv) lv.addEventListener('click', () => { this.closeModal(); app.leaveParty(); });
    }, done);
  }
}
