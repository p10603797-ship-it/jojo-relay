// DOM heads-up display. Writes only when values change to keep layout work tiny.
// The warm-up panel, the end screen and the maps live in their own modules (lobbyPanel.js,
// endscreen.js, mapview.js); Hud.lobby / elim / drawMap / minimap / toggleFullMap forward to them.
import * as THREE from 'three';
import { WEAPONS, HEALS, RARITY, MAT_KEYS, AMMO, itemName } from '../../shared/constants.js';
import { LobbyPanel } from './lobbyPanel.js';
import { EndScreen } from './endscreen.js';
import { MapView } from './mapview.js';

const $ = (s, r = document) => r.querySelector(s);
const _v = new THREE.Vector3();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// damage numbers: a hit this close (m) and this soon (s) after a live number adds to its total
const STACK_DIST = 1.2, STACK_TIME = 0.7;
const NUM_LIFE = 0.9; // s a number stays up after its last hit
const dnSize = (dmg) => Math.round(Math.max(24, Math.min(52, 22 + dmg * 0.28)));

/** Name + rarity of what the interact prompt offers (for the touch interact button). */
function promptInfo(html) {
  const r = /class="r(\d)"/.exec(html);
  const text = html.replace(/<kbd>.*?<\/kbd>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (/^Open Chest/.test(text)) return { name: 'Chest', r: 5 };
  return { name: text.replace(/^(Pick up|Swap for|Open)\s+/, ''), r: r ? +r[1] : -1 };
}

const SHIELD_SVG = '<svg viewBox="0 0 48 56" aria-hidden="true"><path d="M24 2 L44 9 V26 C44 40 35 49 24 54 C13 49 4 40 4 26 V9 Z" fill="#43b5ff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>'
  + '<path d="M24 4 L20 17 L28 24 L19 33 L25 41 L22 53" fill="none" stroke="#0b1c3a" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>'
  + '<path d="M28 24 L38 20 M19 33 L9 30" fill="none" stroke="#0b1c3a" stroke-width="2.5" stroke-linecap="round"/></svg>';

// Elimination siphon "+50" beside the health / shield bars (kept here so the feature is self-contained).
// Each popup spans its bar's row of #bars (2 bars + 6px gap), so it stays centred at any bar height.
const SIPHON_CSS = `
#bars .siphon { position: absolute; left: calc(100% + 10px); height: calc(50% - 3px); display: flex; align-items: center; font-family: var(--font-title); font-size: 24px; line-height: 1; text-shadow: 0 0 2px #000, 0 0 4px rgba(0, 0, 0, 0.8), 0 2px 0 rgba(0, 0, 0, 0.6); white-space: nowrap; pointer-events: none; opacity: 0; }
#bars .siphon.sh { top: 0; color: #7fd6ff; }
#bars .siphon.hp { bottom: 0; color: #6df06a; }
#bars .siphon.show { animation: siphonpop 1.7s ease-out forwards; }
#bars .bar.shield { --glow: rgba(127, 214, 255, 0.95); }
#bars .bar.health { --glow: rgba(109, 240, 106, 0.95); }
#bars .bar.glow::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 12px 3px var(--glow); background: rgba(255, 255, 255, 0.35); pointer-events: none; animation: siphonglow 0.8s ease-out forwards; }
/* phones: the centred hotbar starts right after the bars, so pop over the bar's end with a heavier outline */
@media (max-width: 900px) { #bars .siphon { left: auto; right: 10px; font-size: 20px; text-shadow: 0 0 2px #000, 0 0 2px #000, 0 0 3px #000, 0 1px 1px #000; } }
@keyframes siphonpop { 0% { opacity: 0; transform: translateX(-10px) scale(1.6); } 12% { opacity: 1; transform: none; } 70% { opacity: 1; transform: translateY(-5px); } 100% { opacity: 0; transform: translateY(-14px); } }
@keyframes siphonglow { 0% { opacity: 1; } 100% { opacity: 0; } }
`;

const ICON = {
  pickaxe: '⛏', ar: 'AR', burst: 'BURST', smg: 'SMG', shotgun: 'PUMP', tactical: 'TAC', sniper: 'SNIPER', pistol: 'PISTOL', rocket: 'ROCKET',
  bandage: '🩹', medkit: '✚', shield_s: 'MINI', shield_b: 'BIG<br>SHIELD',
};

export class Hud {
  constructor(world) {
    this.world = world;
    this.root = $('#hud');
    this.el = {
      hpFill: $('.bar.health .fill'), hpNum: $('.bar.health .num'), shFill: $('.bar.shield .fill'), shNum: $('.bar.shield .num'),
      mats: Object.fromEntries(MAT_KEYS.map((m) => [m, $(`.mat[data-m=${m}]`)])),
      ammoMag: $('#ammo .mag'), ammoRes: $('#ammo .res'), ammoName: $('#ammo .wname'),
      hotbar: $('#hotbar'), cross: $('#crosshair'), hit: $('#hitmarker'), dmg: $('#dmgnums'), kf: $('#killfeed'),
      notice: $('#notice'), big: $('#bigmsg'), hurt: $('#hurt'), hitdirs: $('#hitdirs'), storm: $('#stormtint'), scope: $('#scope'),
      stStorm: $('#st-storm'), stStormT: $('#st-storm span'), stAlive: $('#st-alive span'), stKills: $('#st-kills span'),
      map: $('#minimap'), prompt: $('#prompt'), progress: $('#progress'), progFg: $('#progress .fg'), progText: $('#progress span'),
      bus: $('#busprompt'), fps: $('#fps'), net: $('#netinfo'), poi: $('#poi'), buildbar: $('#buildbar'),
      lobby: $('#lobbypanel'), elim: $('#elimscreen'), fullmap: $('#fullmap'),
    };
    this.cache = {};
    this.slots = [];
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.innerHTML = `<span class="k">${i === 0 ? 'F' : i}</span><span class="ic"></span><span class="n"></span>`;
      s.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.onSlot && this.onSlot(i); });
      this.el.hotbar.appendChild(s);
      this.slots.push(s);
    }
    this.nums = [];
    for (let i = 0; i < 40; i++) {
      const d = document.createElement('div');
      d.className = 'dn';
      d.style.display = 'none';
      this.el.dmg.appendChild(d);
      this.nums.push({ el: d, t: 0, life: 0, pos: new THREE.Vector3(), active: false, dx: 0, ox: 0, oy: 0, total: 0, stack: false, hitT: 0, pop: 1, size: 0 });
    }
    this.noticeTimer = 0;
    this.promptInfo = null;
    this.onEditChip = null;
    this.initSiphon();
    this.initFeel();
    this.mapView = new MapView(this, world);
    this.lobbyPanel = new LobbyPanel(this);
    this.endscreen = new EndScreen(this);
  }

  set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  show(on) { this.root.classList.toggle('hidden', !on); }

  bars(hp, sh) {
    this.set('hp', Math.ceil(hp), (v) => { this.el.hpFill.style.width = `${v}%`; this.el.hpNum.textContent = v; });
    this.set('sh', Math.ceil(sh), (v) => { this.el.shFill.style.width = `${v}%`; this.el.shNum.textContent = v; });
  }

  initSiphon() {
    if (!document.getElementById('siphon-css')) {
      const st = document.createElement('style');
      st.id = 'siphon-css';
      st.textContent = SIPHON_CSS;
      document.head.appendChild(st);
    }
    const bars = $('#bars');
    const mk = (cls) => { const d = document.createElement('div'); d.className = `siphon ${cls}`; bars.appendChild(d); return d; };
    this.el.sipSh = mk('sh');
    this.el.sipHp = mk('hp');
  }

  /** DOM for build 2.0 + hit feedback (index.html stays as it is): cone in the build bar, kill ring, shield-break icon, elimination banner, edit chips. */
  initFeel() {
    const mk = (tag, id, cls, html, parent) => {
      let e = id ? document.getElementById(id) : null;
      if (!e) {
        e = document.createElement(tag);
        if (id) e.id = id;
        if (cls) e.className = cls;
        if (html) e.innerHTML = html;
        parent.appendChild(e);
      }
      return e;
    };
    const bb = this.el.buildbar;
    if (bb && !bb.querySelector('[data-t=c]')) mk('div', null, 'bp', '<b>▲</b><span>Cone</span><kbd>V</kbd>', bb).dataset.t = 'c';
    if (this.el.hit && !this.el.hit.querySelector('.ring')) mk('b', null, 'ring', '', this.el.hit);
    this.el.shBreak = mk('div', 'shieldbreak', '', SHIELD_SVG, this.root);
    this.el.elimBanner = mk('div', 'elimbanner', '', '<div class="eb-streak"></div><div class="eb-main"><span class="eb-x">✖</span> ELIMINATED <b></b></div><div class="eb-count"></div>', this.root);
    this.el.editChips = mk('div', 'editchips', '', '', this.root);
    // one-shot banners end their animation and lose .show: otherwise, when #hud shows again (after
    // an end card or the lobby stage) the browser restarts the animation and old banners replay
    for (const e of [this.el.big, this.el.elimBanner, this.el.shBreak, this.el.hit, this.el.sipHp, this.el.sipSh]) {
      if (e) e.addEventListener('animationend', (ev) => { if (ev.target === e) e.classList.remove('show'); });
    }
  }

  /** Elimination siphon: a short "+N" beside each bar that grew (green health, blue shield). */
  siphon(dh, ds) {
    this.siphonPop(this.el.sipHp, this.el.hpFill.parentNode, dh);
    this.siphonPop(this.el.sipSh, this.el.shFill.parentNode, ds);
  }

  siphonPop(el, bar, n) {
    if (!(n > 0)) return;
    // several kills in one go (a rocket, quick shots): add up while the popup is still showing
    const now = performance.now();
    el.sum = (now - (el.popT || -1e9) < 1700 ? el.sum || 0 : 0) + n;
    el.popT = now;
    el.textContent = `+${el.sum}`;
    el.classList.remove('show');
    bar.classList.remove('glow');
    void el.offsetWidth; // restart the animations (only on a kill, so the forced layout is fine)
    el.classList.add('show');
    bar.classList.add('glow');
  }

  inventory(p) {
    const inv = p.inv;
    for (const m of MAT_KEYS) {
      // (the warm-up's infinite flag, or a mode with infinite building: Playground, Infinite Build)
      this.set(`mat${m}`, p.infinite || p.infMats ? '∞' : inv.mats[m], (v) => { this.el.mats[m].lastChild.textContent = v; });
      this.set(`matsel${m}`, p.buildMode && p.buildMat === m, (v) => this.el.mats[m].classList.toggle('sel', v));
    }
    for (let i = 0; i < 6; i++) {
      const s = inv.slots[i];
      const key = s ? `${s.k}|${s.r || 0}|${s.n || ''}|${s.m ?? ''}|${inv.sel === i && !p.buildMode}` : `empty|${inv.sel === i}`;
      this.set(`slot${i}`, key, () => {
        const el = this.slots[i];
        el.className = `slot${inv.sel === i && !p.buildMode ? ' sel' : ''}${s && (WEAPONS[s.k] && s.k !== 'pickaxe' || HEALS[s.k]) ? ` r${WEAPONS[s.k] ? s.r | 0 : HEALS[s.k].rarity}` : ''}`;
        el.children[1].innerHTML = s ? ICON[s.k] || (WEAPONS[s.k] ? WEAPONS[s.k].short.toUpperCase() : esc(s.k)) : '';
        el.children[2].textContent = s ? (HEALS[s.k] ? s.n : WEAPONS[s.k] && WEAPONS[s.k].mag ? s.m : '') : '';
      });
    }
    const cur = inv.slots[inv.sel];
    const w = cur && WEAPONS[cur.k];
    let mag = '', res = '', name = '';
    if (p.buildMode) { name = 'BUILD'; }
    else if (w && w.mag) { mag = cur.m; res = p.freeAmmo() ? '∞' : inv.ammo[w.ammo]; name = `${RARITY[cur.r | 0].name} ${w.name}`; }
    else if (cur && HEALS[cur.k]) { mag = cur.n; name = HEALS[cur.k].name; }
    else if (cur) name = w ? w.name : '';
    this.set('ammo', `${mag}|${res}|${name}`, () => {
      this.el.ammoMag.textContent = mag === '' ? '' : mag;
      this.el.ammoRes.textContent = res === '' ? '' : `/ ${res}`;
      this.el.ammoName.textContent = name;
    });
  }

  buildBar(p) {
    document.body.classList.toggle('building', !!p.buildMode);
    this.set('bt', p.buildMode ? p.buildType : '', (t) => {
      for (const b of this.el.buildbar.children) b.classList.toggle('sel', b.dataset.t === t);
    });
  }

  crosshair(spreadPx, mode, lock = false) {
    this.set('chm', mode, (m) => {
      this.el.cross.classList.toggle('pick', m === 'pick');
      this.el.cross.classList.toggle('hide', m === 'none');
    });
    // auto-shoot has locked on to an enemy
    this.set('chl', lock, (v) => {
      this.el.cross.classList.toggle('lock', v);
      this.el.scope.classList.toggle('lock', v);
    });
    const s = Math.round(Math.min(80, spreadPx));
    this.set('chs', s, (v) => this.el.cross.style.setProperty('--s', `${v + 5}px`));
  }

  /** Hit confirm: 4 lines; yellow for a headshot; a kill is a red X with an expanding ring. */
  hitmarker(head, kill) {
    const h = this.el.hit;
    h.classList.remove('show', 'head', 'kill');
    void h.offsetWidth; // restart the animation (once per hit, never per frame)
    if (head) h.classList.add('head');
    if (kill) h.classList.add('kill');
    h.classList.add('show');
  }

  /** Someone's shield just broke from my hit: a cracked-shield icon pops by the crosshair. */
  shieldBreak() {
    const e = this.el.shBreak;
    if (!e) return;
    e.classList.remove('show');
    void e.offsetWidth;
    e.classList.add('show');
  }

  /**
   * A damage number at a world position. Player hits (kind '', 'shield', 'head') close to a live
   * number stack into its running total, which pops; a small number for the single hit flies off.
   * kind 'build' / 'mat' are plain one-off numbers.
   */
  damageNumber(pos, amount, kind = '') {
    const stackable = typeof amount === 'number' && kind !== 'build' && kind !== 'mat';
    if (stackable) {
      let best = null, bd = STACK_DIST * STACK_DIST;
      for (const n of this.nums) {
        if (!n.active || !n.stack || n.hitT > STACK_TIME) continue;
        const d = n.pos.distanceToSquared(pos);
        if (d <= bd) { bd = d; best = n; }
      }
      if (best) {
        best.total += amount;
        best.hitT = 0;
        best.t = 0;
        best.pop = 0;
        this.numStyle(best, kind, best.total);
        this.spawnNumber(pos, amount, kind, false); // the single hit flies off to the side
        return;
      }
    }
    this.spawnNumber(pos, amount, kind, stackable);
  }

  spawnNumber(pos, amount, kind, stack) {
    let n = null;
    for (const x of this.nums) if (!x.active) { n = x; break; }
    if (!n) { n = this.nums[0]; for (const x of this.nums) if (!x.stack && x.t > n.t) n = x; }
    n.active = true;
    n.stack = stack;
    n.t = 0;
    n.hitT = 0;
    n.pop = 0;
    n.small = !stack && typeof amount === 'number' && kind !== 'build' && kind !== 'mat';
    n.life = stack ? NUM_LIFE : n.small ? 0.55 : kind === 'mat' ? 0.9 : 0.85;
    n.pos.copy(pos);
    const side = Math.random() < 0.5 ? -1 : 1;
    n.dx = stack ? 0 : side * (60 + Math.random() * 50);
    n.ox = stack ? (Math.random() - 0.5) * 16 : side * 26;
    n.oy = stack ? -10 : (Math.random() - 0.5) * 20;
    n.total = typeof amount === 'number' ? amount : 0;
    if (typeof amount === 'number' && kind !== 'mat') this.numStyle(n, kind, amount);
    // (a '+N' material number clears the size: forget the cached one, or the next damage number
    // on this element keeps the stylesheet's size)
    else { n.el.className = `dn ${kind}`; n.el.textContent = amount; n.el.style.fontSize = ''; n.size = 0; }
    n.el.style.display = 'block';
  }

  numStyle(n, kind, value) {
    const cls = `dn ${kind}${n.small ? ' small' : ''}${n.stack ? ' total' : ''}`;
    if (n.el.className !== cls) n.el.className = cls;
    n.el.textContent = Math.round(value);
    const size = n.small ? 20 : kind === 'build' ? 22 : dnSize(value);
    if (size !== n.size) { n.size = size; n.el.style.fontSize = `${size}px`; }
  }

  updateNumbers(dt, camera, w, h) {
    for (const n of this.nums) {
      if (!n.active) continue;
      n.t += dt;
      n.hitT += dt;
      n.pop += dt;
      if (n.t > n.life) { n.active = false; n.stack = false; n.el.style.display = 'none'; continue; }
      _v.copy(n.pos).project(camera);
      if (_v.z > 1) { n.el.style.opacity = 0; continue; }
      const rise = n.stack ? 22 : 50;
      const x = (_v.x * 0.5 + 0.5) * w + n.ox + n.dx * n.t;
      const y = (-_v.y * 0.5 + 0.5) * h + n.oy - rise * n.t - 20;
      const k = n.t / n.life;
      // pop: 1.6 -> 1 over 0.15 s on every hit
      const sc = n.pop < 0.15 ? 1.6 - (n.pop / 0.15) * 0.6 : 1;
      n.el.style.transform = `translate(${x | 0}px, ${y | 0}px) translate(-50%, -50%) scale(${sc.toFixed(3)})`;
      n.el.style.opacity = k > 0.6 ? ((1 - k) / 0.4).toFixed(3) : 1;
    }
  }

  /** Bottom-centre banner for my elimination: 'ELIMINATED <name>', my count, and a streak (DOUBLE…). */
  elimBanner(name, count, streak = '') {
    const e = this.el.elimBanner;
    if (!e) return;
    e.children[0].textContent = streak || '';
    e.children[1].lastChild.textContent = String(name || '').toUpperCase();
    e.children[2].textContent = `${count} ELIMINATION${count === 1 ? '' : 'S'}`;
    e.classList.toggle('streak', !!streak);
    e.classList.remove('show');
    void e.offsetWidth;
    e.classList.add('show');
  }

  /** The edit choices (labels in pick order) or null to close. hints: show the 1-5 keys. */
  editChips(labels, hints = false) {
    const e = this.el.editChips;
    if (!e) return;
    if (!labels) { e.classList.remove('show'); return; }
    e.textContent = '';
    labels.forEach((label, i) => {
      const b = document.createElement('button');
      b.className = `chip hudbtn${label === 'RESET' ? ' reset' : ''}`;
      b.innerHTML = `${hints ? `<kbd>${i + 1}</kbd>` : ''}${label}`;
      b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (this.onEditChip) this.onEditChip(i); });
      e.appendChild(b);
    });
    e.classList.add('show');
  }

  /** Clear transient messages for a new session, without replaying their animations. */
  reset() {
    const el = this.el;
    el.notice.classList.remove('show', 'storm');
    el.notice.textContent = '';
    this.noticeTimer = 0;
    el.big.classList.remove('show');
    el.big.innerHTML = '';
    el.kf.textContent = '';
    if (el.hitdirs) el.hitdirs.textContent = '';
    for (const n of this.nums) { n.active = false; n.stack = false; n.el.style.display = 'none'; }
    el.hit.classList.remove('show', 'head', 'kill');
    if (el.shBreak) el.shBreak.classList.remove('show');
    if (el.elimBanner) el.elimBanner.classList.remove('show');
    this.editChips(null);
    if (el.prompt) { el.prompt.classList.remove('show'); el.prompt.innerHTML = ''; }
    this.cache.prompt = '';
    this.promptInfo = null;
  }

  killfeed(html) {
    const d = document.createElement('div');
    d.className = /class="me"/.test(html) ? 'kf mine' : 'kf';
    d.innerHTML = html;
    this.el.kf.appendChild(d);
    while (this.el.kf.children.length > 5) this.el.kf.firstChild.remove();
    setTimeout(() => d.remove(), 6500);
  }

  notice(text, storm = false, time = 4) {
    this.el.notice.textContent = text;
    this.el.notice.classList.toggle('storm', storm);
    this.el.notice.classList.add('show');
    this.noticeTimer = time;
  }

  big(html) {
    // my eliminations have their own banner now (elimBanner, from js/world/buildClient.js)
    if (/^ELIMINATED<small>/.test(html)) return;
    const b = this.el.big;
    b.innerHTML = html;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  hurt(k) { this.el.hurt.style.opacity = Math.min(1, k); }

  hitDirection(angle) {
    const d = document.createElement('div');
    d.className = 'hitdir';
    d.style.transform = `rotate(${angle}rad)`;
    this.el.hitdirs.appendChild(d);
    setTimeout(() => d.remove(), 1300);
  }

  stormTint(k) { this.set('storm', Math.round(k * 20) / 20, (v) => { this.el.storm.style.opacity = v; }); }
  scope(on) { this.set('scope', on, (v) => this.el.scope.classList.toggle('on', v)); }

  stats(stormText, shrinking, alive, kills) {
    this.set('stt', stormText, (v) => { this.el.stStormT.textContent = v; });
    this.set('sts', shrinking, (v) => this.el.stStorm.classList.toggle('shrink', v));
    this.set('sta', alive, (v) => { this.el.stAlive.textContent = v; });
    this.set('stk', kills, (v) => { this.el.stKills.textContent = v; });
  }

  prompt(html) {
    this.set('prompt', html || '', (v) => {
      this.el.prompt.innerHTML = v;
      this.el.prompt.classList.toggle('show', !!v);
      this.promptInfo = v ? promptInfo(v) : null;
    });
  }

  progress(frac, label) {
    if (frac < 0) { this.set('prog', -1, () => this.el.progress.classList.remove('show')); return; }
    this.set('prog', Math.round(frac * 50), () => {
      this.el.progress.classList.add('show');
      this.el.progFg.style.strokeDashoffset = `${94.25 * (1 - frac)}`;
    });
    this.set('progl', label, (v) => { this.el.progText.textContent = v; });
  }

  bus(text) {
    this.set('bus', text || '', (v) => {
      this.el.bus.innerHTML = v;
      this.el.bus.classList.toggle('show', !!v);
    });
  }

  fps(text) { this.set('fps', text, (v) => { this.el.fps.textContent = v; }); }
  net(text) { this.set('net', text, (v) => { this.el.net.textContent = v; }); }
  poi(text) { this.set('poi', text, (v) => { this.el.poi.textContent = v; }); }

  update(dt) {
    if (this.noticeTimer > 0) {
      this.noticeTimer -= dt;
      if (this.noticeTimer <= 0) this.el.notice.classList.remove('show');
    }
  }

  // ------------------------------------------------------------------ maps (js/ui/mapview.js)
  drawMap(ctx, size, cx, cz, span, me, storm, extras) { this.mapView.drawMap(ctx, size, cx, cz, span, me, storm, extras); }

  minimap(dt, me, storm, extras) { this.mapView.minimap(dt, me, storm, extras); }

  toggleFullMap(on) { this.mapView.toggleFullMap(on); }

  // ------------------------------------------------------------------ lobby + end screens (lobbyPanel.js, endscreen.js)
  lobby(state) { this.lobbyPanel.show(state); }

  elim(opts) { this.endscreen.show(opts); }
}

export function lootLabel(item) {
  const r = item.r | 0;
  const cls = item.k in WEAPONS ? `r${r}` : '';
  const qty = item.n && !(item.k in WEAPONS) ? ` ×${item.n}` : '';
  return `<span class="${cls}">${itemName(item)}</span>${qty}`;
}

export { AMMO };
