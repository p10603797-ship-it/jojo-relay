// The warm-up / party panel (#lobbypanel). Hud.lobby(state) forwards here. Its controls (bots,
// mode, materials, START) are wired up in js/ui/menu.js.
import { SKINS } from '../../shared/constants.js';

const $ = (s, r = document) => r.querySelector(s);

export class LobbyPanel {
  constructor(hud) {
    this.hud = hud;
    this.el = hud.el.lobby;
  }

  /**
   * state: null hides it; otherwise { solo, code, players (roster rows), leader, you, settings, share (html) }.
   */
  show(state) {
    const L = this.el;
    if (!state) { L.classList.remove('show'); return; }
    L.classList.add('show');
    $('.lp-code', L).textContent = state.solo ? 'SOLO' : state.code;
    $('.lp-title', L).textContent = state.solo ? 'WARM-UP' : 'PARTY';
    $('.lp-hint', L).textContent = state.solo
      ? 'Practice on the island with unlimited ammo & materials. Start the match when ready!'
      : 'Warm up on the island (no damage) while friends join with the party code from Play with Friends.';
    const ul = $('.lp-players', L);
    ul.innerHTML = '';
    for (const p of state.players) {
      if (p.bot) continue;
      const li = document.createElement('li');
      const skin = SKINS[p.skin] || SKINS[0];
      li.innerHTML = `<i style="background:${skin.outfit}"></i><span></span>${p.id === state.leader ? '<span class="crown">♛ LEADER</span>' : ''}`;
      li.children[1].textContent = p.name + (p.id === state.you ? ' (you)' : '');
      ul.appendChild(li);
    }
    const isLeader = state.leader === state.you;
    $('.lp-leader', L).style.display = isLeader ? 'block' : 'none';
    $('.lp-wait', L).style.display = isLeader ? 'none' : 'block';
    const bots = $('.lp-bots', L), botsv = $('.lp-botsv', L), mats = $('.lp-mats', L), mode = $('.lp-mode', L);
    if (document.activeElement !== mode) mode.value = state.settings.mode || 'ffa';
    mode.closest('label').style.display = state.solo ? 'none' : '';
    if (document.activeElement !== bots) { bots.value = state.settings.bots; botsv.textContent = state.settings.bots; }
    if (document.activeElement !== mats) mats.value = String(state.settings.mats);
    $('.lp-share', L).innerHTML = state.share || '';
  }
}
