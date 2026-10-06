// DOM heads-up display. Writes only when values change to keep layout work tiny.
import * as THREE from 'three';
import { WEAPONS, HEALS, RARITY, SKINS, MAT_KEYS, AMMO, itemName } from '../../shared/constants.js';

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
    this.mapCtx = this.el.map.getContext('2d');
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
    this.mapT = 0;
    this.initSiphon();
    this.el.map.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleFullMap(); });
    this.el.fullmap.addEventListener('pointerdown', () => this.toggleFullMap(false));
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

  // ------------------------------------------------------------------ maps
  drawMap(ctx, size, cx, cz, span, me, storm, extras) {
    const world = this.world;
    const d = world.data;
    const src = world.mapCanvas;
    const k = src.width / d.size;          // map px per metre
    const s = size / span;                 // screen px per metre
    ctx.save();
    ctx.fillStyle = '#2a6f9f';
    ctx.fillRect(0, 0, size, size);
    const sx = (cx - span / 2 + d.half) * k, sy = (cz - span / 2 + d.half) * k;
    ctx.drawImage(src, sx, sy, span * k, span * k, 0, 0, size, size);
    const toX = (x) => (x - cx) * s + size / 2, toY = (z) => (z - cz) * s + size / 2;
    if (storm) {
      ctx.fillStyle = 'rgba(120, 40, 220, 0.4)';
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.arc(toX(storm.cx), toY(storm.cz), storm.r * s, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(toX(storm.ncx), toY(storm.ncz), storm.nr * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (extras.bus) {
      const b = extras.bus;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(toX(b.ax), toY(b.az));
      ctx.lineTo(toX(b.bx), toY(b.bz));
      ctx.stroke();
      ctx.setLineDash([]);
      if (extras.busPos) {
        ctx.fillStyle = '#2f8cff';
        ctx.beginPath();
        ctx.arc(toX(extras.busPos.x), toY(extras.busPos.z), 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (extras.names) {
      ctx.font = `${Math.max(11, size / 50)}px "Luckiest Guy", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = '#fff';
      for (const p of d.pois) {
        ctx.strokeText(p.name.toUpperCase(), toX(p.x), toY(p.z));
        ctx.fillText(p.name.toUpperCase(), toX(p.x), toY(p.z));
      }
    }
    if (extras.dots) {
      for (const dot of extras.dots) {
        ctx.fillStyle = dot.c;
        ctx.beginPath();
        ctx.arc(toX(dot.x), toY(dot.z), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (me) {
      ctx.translate(toX(me.x), toY(me.z));
      ctx.rotate(-me.yaw);
      ctx.fillStyle = '#ffd23f';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 7);
      ctx.lineTo(0, 3);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  minimap(dt, me, storm, extras) {
    this.mapT -= dt;
    if (this.mapT > 0) return;
    this.mapT = 1 / 15;
    const c = this.el.map;
    this.drawMap(this.mapCtx, c.width, me.x, me.z, 230, me, storm, extras);
    if (!this.el.fullmap.classList.contains('hidden')) {
      const fc = this.el.fullmap.querySelector('canvas');
      this.drawMap(fc.getContext('2d'), fc.width, 0, 0, this.world.data.size, me, storm, { ...extras, names: true });
    }
  }

  toggleFullMap(on) {
    const fm = this.el.fullmap;
    const show = on ?? fm.classList.contains('hidden');
    fm.classList.toggle('hidden', !show);
  }

  // ------------------------------------------------------------------ lobby + end screens
  lobby(state) {
    const L = this.el.lobby;
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

  elim(opts) {
    const E = this.el.elim;
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

export function lootLabel(item) {
  const r = item.r | 0;
  const cls = item.k in WEAPONS ? `r${r}` : '';
  const qty = item.n && !(item.k in WEAPONS) ? ` ×${item.n}` : '';
  return `<span class="${cls}">${itemName(item)}</span>${qty}`;
}

export { AMMO };
