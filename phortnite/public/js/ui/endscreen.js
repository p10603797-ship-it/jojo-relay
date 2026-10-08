// The end screen (#elimscreen): eliminated, spectating, victory, match over. Hud.elim(opts)
// forwards here. The buttons (PLAY AGAIN, SPECTATE, LEAVE) are wired up in js/ui/menu.js.
const $ = (s, r = document) => r.querySelector(s);

export class EndScreen {
  constructor(hud) {
    this.hud = hud;
    this.el = hud.el.elim;
  }

  /**
   * opts: null hides it; otherwise { place, title, sub, win, spectating, again, spectate, leave }
   * (again / spectate / leave show those buttons).
   */
  show(opts) {
    const E = this.el;
    if (!opts) { E.classList.add('hidden'); return; }
    E.classList.remove('hidden', 'win', 'spectating');
    if (opts.win) E.classList.add('win');
    if (opts.spectating) E.classList.add('spectating');
    $('.es-place', E).textContent = opts.place ? `#${opts.place}` : '';
    $('.es-title', E).textContent = opts.title || '';
    $('.es-sub', E).textContent = opts.sub || '';
    $('.es-again', E).style.display = opts.again ? '' : 'none';
    $('.es-spec', E).style.display = opts.spectate ? '' : 'none';
    $('.es-leave', E).style.display = opts.leave ? '' : 'none';
  }
}
