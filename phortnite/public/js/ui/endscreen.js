// The end screen (#elimscreen): the death card, spectating, victory, match over, and between the
// rounds of a best-of-N series the round card (who took the round, the series score, the next
// round's countdown). Hud.elim(opts) forwards here; the party bridge adds who got you (enrich) right
// after. The buttons are wired up in js/ui/menu.js: PLAY AGAIN (.es-again, solo), SPECTATE
// (.es-spec), BACK TO LOBBY (.es-leave).
import { SKINS, WEAPONS } from '../../shared/constants.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class EndScreen {
  constructor(hud) {
    this.hud = hud;
    this.el = hud.el.elim;
    this.el.innerHTML = `
      <div class="es-card">
        <div class="es-place"></div>
        <div class="es-title"></div>
        <div class="es-sub"></div>
        <div class="es-series hidden"></div>
        <div class="es-next hidden"></div>
        <div class="es-killer hidden"></div>
        <div class="es-tiles hidden"></div>
        <div class="es-btns">
          <button class="btn es-leave yellow">BACK TO LOBBY</button>
          <button class="btn es-spec">SPECTATE</button>
          <button class="btn es-again blue">PLAY AGAIN</button>
        </div>
      </div>`;
    this.opts = null;
    this.nextAt = 0; // performance.now() when the next round starts (the round card counts down to it)
    this.nextTimer = 0;
  }

  /**
   * opts: null hides it; otherwise { place, title, sub, win, spectating, again, spectate, leave,
   * death?, round?, series?, next? } (again / spectate / leave show those buttons; leave is BACK TO
   * LOBBY). series: the best-of-N score [{name, color, wins, mine}]; round: this is the round card
   * (between rounds); next: seconds until the next round (counted down here). { respawn: true } is
   * a mode's respawn countdown: nothing here (the mode HUD draws it).
   */
  show(opts) {
    const E = this.el;
    if (opts && opts.respawn) opts = null;
    // the same death card shown again (e.g. 'Mia wins!' added at the end) keeps its details
    const prev = this.opts;
    if (opts && !opts.death && prev && prev.death && !opts.spectating && opts.title === prev.title && opts.place === prev.place) opts = { ...opts, death: prev.death };
    this.opts = opts || null;
    document.body.classList.toggle('endcard', !!opts && !opts.spectating);
    // (the round card has no place to hide: a round banner may show with it, see lobby.css)
    document.body.classList.toggle('roundcard', !!opts && !!opts.round);
    // a new round card starts its countdown (the same card shown again keeps counting)
    if (opts && Number.isFinite(opts.next) && !(prev && Number.isFinite(prev.next) && prev.title === opts.title)) this.nextAt = performance.now() + opts.next * 1000;
    this.tickNext();
    if (!opts) { E.classList.add('hidden'); return; }
    E.classList.remove('hidden', 'win', 'spectating', 'round');
    if (opts.win) E.classList.add('win');
    if (opts.spectating) E.classList.add('spectating');
    if (opts.round) E.classList.add('round');
    $('.es-place', E).textContent = opts.place ? `#${opts.place}` : '';
    $('.es-title', E).textContent = opts.title || '';
    $('.es-sub', E).textContent = opts.sub || '';
    const ser = $('.es-series', E);
    const rows = Array.isArray(opts.series) && opts.series.length ? opts.series : null;
    ser.classList.toggle('hidden', !rows);
    if (rows) ser.innerHTML = seriesHtml(rows, opts.best);
    $('.es-again', E).style.display = opts.again ? '' : 'none';
    $('.es-spec', E).style.display = opts.spectate ? '' : 'none';
    $('.es-leave', E).style.display = opts.leave ? '' : 'none';
    const k = $('.es-killer', E), t = $('.es-tiles', E);
    const d = opts.death || null;
    k.classList.toggle('hidden', !(d && d.killer) || !!opts.spectating);
    t.classList.toggle('hidden', !(d && d.stats) || !!opts.spectating);
    if (d && d.killer) k.innerHTML = killerHtml(d.killer);
    if (d && d.stats) t.innerHTML = tilesHtml(d.stats);
  }

  /** The round card's 'Next round in 3…' line, kept up to date while it shows. */
  tickNext() {
    const o = this.opts, nx = $('.es-next', this.el);
    const on = !!o && Number.isFinite(o.next);
    nx.classList.toggle('hidden', !on);
    if (!on) { clearInterval(this.nextTimer); this.nextTimer = 0; return; }
    const left = Math.ceil((this.nextAt - performance.now()) / 1000);
    nx.textContent = left > 0 ? `Next round in ${left}…` : 'Next round starting…';
    if (!this.nextTimer) this.nextTimer = setInterval(() => this.tickNext(), 250);
  }

  /** Add the death details (killer, stats) to the card on screen, if it is still the death card. */
  enrich(death) {
    if (!this.opts || this.opts.win || this.opts.spectating || this.opts.round) return;
    this.show({ ...this.opts, death });
  }

  get current() { return this.opts; }
}

function killerHtml(k) {
  const skin = SKINS[k.skin] || SKINS[0];
  const w = k.w && Object.prototype.hasOwnProperty.call(WEAPONS, k.w) ? WEAPONS[k.w].name : k.how || '';
  const bar = (v, cls) => `<div class="kb ${cls}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i><span>${Math.ceil(v)}</span></div>`;
  return `<i class="ek-skin" style="background:${skin.outfit};box-shadow:inset 0 -7px 0 ${skin.accent}"></i>
    <div class="ek-main"><div class="ek-by">ELIMINATED BY</div><div class="ek-name">${esc(k.name)}${k.bot ? ' <small>BOT</small>' : ''}</div>
    <div class="ek-meta">${w ? `<span>🔫 ${esc(w)}</span>` : ''}${k.dist !== undefined ? `<span>📏 ${Math.round(k.dist)} m</span>` : ''}${k.hs ? '<span>🎯 Headshot</span>' : ''}</div></div>
    ${k.hp !== undefined ? `<div class="ek-bars">${bar(k.sh || 0, 'sh')}${bar(k.hp, 'hp')}</div>` : ''}`;
}

/** Best-of-N score chips: 'BLUE 1 – 0 RED' for two sides, a row of chips for more. */
function seriesHtml(rows, best) {
  const chip = (r) => `<span class="es-team${r.mine ? ' mine' : ''}" style="--tc:${esc(r.color)}"><i></i><em>${esc(r.name)}</em><b>${r.wins | 0}</b></span>`;
  const need = best > 1 ? Math.ceil(best / 2) : 0;
  const head = need ? `<div class="es-best">BEST OF ${best | 0} · FIRST TO ${need}</div>` : '';
  return `${head}<div class="es-chips">${rows.slice(0, 6).map(chip).join(rows.length === 2 ? '<span class="es-vs">–</span>' : '')}</div>`;
}

function tilesHtml(s) {
  const tile = (n, l) => `<div class="es-tile"><b>${esc(n)}</b><span>${esc(l)}</span></div>`;
  const mins = Math.floor(s.alive / 60), secs = String(Math.floor(s.alive % 60)).padStart(2, '0');
  return tile(s.elims, 'Elims') + tile(s.damage, 'Damage') + tile(`${mins}:${secs}`, 'Time alive') + tile(s.builds, 'Builds');
}
