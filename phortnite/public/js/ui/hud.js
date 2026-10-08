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
      this.nums.push({ el: d, t: 0, life: 0, pos: new THREE.Vector3(), active: false, dx: 0 });
    }
    this.noticeTimer = 0;
    this.initSiphon();
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
      this.set(`mat${m}`, p.infinite ? '∞' : inv.mats[m], (v) => { this.el.mats[m].lastChild.textContent = v; });
      this.set(`matsel${m}`, p.buildMode && p.buildMat === m, (v) => this.el.mats[m].classList.toggle('sel', v));
    }
    for (let i = 0; i < 6; i++) {
      const s = inv.slots[i];
      const key = s ? `${s.k}|${s.r || 0}|${s.n || ''}|${s.m ?? ''}|${inv.sel === i && !p.buildMode}` : `empty|${inv.sel === i}`;
      this.set(`slot${i}`, key, () => {
        const el = this.slots[i];
        el.className = `slot${inv.sel === i && !p.buildMode ? ' sel' : ''}${s && (WEAPONS[s.k] && s.k !== 'pickaxe' || HEALS[s.k]) ? ` r${WEAPONS[s.k] ? s.r | 0 : HEALS[s.k].rarity}` : ''}`;
        el.children[1].innerHTML = s ? ICON[s.k] || (WEAPONS[s.k] ? WEAPONS[s.k].short.toUpperCase() : s.k) : '';
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

  hitmarker(head, kill) {
    const h = this.el.hit;
    h.classList.remove('show', 'head', 'kill');
    void h.offsetWidth;
    if (head) h.classList.add('head');
    if (kill) h.classList.add('kill');
    h.classList.add('show');
  }

  damageNumber(pos, amount, kind = '') {
    const n = this.nums.find((x) => !x.active) || this.nums[0];
    n.active = true;
    n.t = 0;
    n.life = kind === 'mat' ? 0.9 : 0.85;
    n.pos.copy(pos);
    n.dx = (Math.random() - 0.5) * 60;
    n.ox = (Math.random() - 0.5) * 50;
    n.oy = (Math.random() - 0.5) * 30;
    n.el.className = `dn ${kind}`;
    n.el.textContent = kind === 'mat' ? amount : Math.round(amount);
    n.el.style.display = 'block';
  }

  updateNumbers(dt, camera, w, h) {
    for (const n of this.nums) {
      if (!n.active) continue;
      n.t += dt;
      if (n.t > n.life) { n.active = false; n.el.style.display = 'none'; continue; }
      _v.copy(n.pos).project(camera);
      if (_v.z > 1) { n.el.style.opacity = 0; continue; }
      const x = (_v.x * 0.5 + 0.5) * w + n.ox + n.dx * n.t;
      const y = (-_v.y * 0.5 + 0.5) * h + n.oy - 50 * n.t - 20;
      const k = n.t / n.life;
      const sc = n.t < 0.1 ? 1.5 - n.t * 5 : 1;
      n.el.style.transform = `translate(${x | 0}px, ${y | 0}px) translate(-50%, -50%) scale(${sc})`;
      n.el.style.opacity = k > 0.6 ? (1 - k) / 0.4 : 1;
    }
  }

  killfeed(html) {
    const d = document.createElement('div');
    d.className = 'kf';
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
