// The warm-up chip (#lobbypanel). Hud.lobby(state) forwards here. The party lives on the lobby
// stage now (js/ui/lobby.js); while warming up on the island this compact chip in the top left
// shows the party and a BACK TO LOBBY button, well clear of the touch fire buttons.
const $ = (s, r = document) => r.querySelector(s);

export class LobbyPanel {
  constructor(hud) {
    this.hud = hud;
    this.el = hud.el.lobby;
    this.el.innerHTML = '<span class="wu-title">WARM-UP</span><span class="wu-info"></span><button class="wu-back">↩ LOBBY</button>';
    this.info = $('.wu-info', this.el);
    this.key = '';
    this.onBack = null; // main.js: back to the stage
    $('.wu-back', this.el).addEventListener('click', (e) => { e.stopPropagation(); if (this.onBack) this.onBack(); });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /**
   * state: null hides it; otherwise { solo, code, players (roster rows), leader, you, settings, share }.
   */
  show(state) {
    const L = this.el;
    if (!state) { L.classList.remove('show'); return; }
    L.classList.add('show');
    const humans = state.players.filter((p) => !p.bot).length;
    const text = state.solo ? 'Unlimited ammo & mats' : `${state.code} · ${humans} in party`;
    if (text !== this.key) { this.key = text; this.info.textContent = text; }
  }
}
