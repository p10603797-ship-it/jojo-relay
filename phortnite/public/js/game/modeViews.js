// What game modes put on screen (js/game/modeClient.js drives these):
// - ModeHud: #modehud under #stats (team score bar, FFA top 3, gun-game ladder, infection
//   counters, hill / juggernaut / lava lines, time left), the teammates panel (top left), the
//   'Respawning in 3…' overlay and the off-screen hill arrow. Every DOM write is cached, so
//   nothing is written while nothing changes.
// - HillView: the King of the Hill ring: an open cylinder and a tall additive beam in the owner's
//   colour (2 draw calls).
// - LavaView: a lava sheet for Floor is Lava, used only when the water has no setSeaLevel().
import * as THREE from 'three';
import { WEAPONS } from '../../shared/constants.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Team looks when the room sent none (mode-engine's TEAM_COLORS order). */
export const TEAM_LOOK = [
  ['Blue', '#3ea4ff'], ['Red', '#ff4d4d'], ['Green', '#5ad13a'], ['Yellow', '#ffd23f'],
  ['Purple', '#bd52ff'], ['Orange', '#ff8a00'], ['Pink', '#ff6fb1'], ['Teal', '#2fd6c3'],
];

/** Short labels for the gun-game ladder icons. */
const LADDER_ICON = { rocket: '🚀', sniper: '🔭', shotgun: 'PUMP', tactical: 'TAC', ar: 'AR', burst: 'BRST', smg: 'SMG', pistol: '🔫', pickaxe: '⛏' };

export function clock(secs) {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag, cls, parent, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

export class ModeHud {
  constructor() {
    this.cache = Object.create(null);
    const hud = document.getElementById('hud') || document.body;
    const stats = document.getElementById('stats');
    this.root = el('div', 'mh hidden');
    this.root.id = 'modehud';
    if (stats && stats.parentNode) stats.parentNode.insertBefore(this.root, stats.nextSibling);
    else hud.appendChild(this.root);
    this.root.innerHTML = `
      <div class="mh-clock"><b class="ico">⏱</b><span></span></div>
      <div class="mh-bar"><div class="mh-t a"><i></i><span></span><b></b></div><div class="mh-goal"></div><div class="mh-t b"><b></b><span></span><i></i></div></div>
      <ol class="mh-top"></ol>
      <div class="mh-me"></div>
      <div class="mh-ladder"></div>
      <div class="mh-line"></div>`;
    const q = (s) => this.root.querySelector(s);
    this.el = {
      clock: q('.mh-clock'), clockT: q('.mh-clock span'), bar: q('.mh-bar'), goal: q('.mh-goal'),
      ta: q('.mh-t.a'), tb: q('.mh-t.b'), top: q('.mh-top'), me: q('.mh-me'), ladder: q('.mh-ladder'), line: q('.mh-line'),
    };
    this.mates = el('div', 'mh-mates hidden', hud);
    this.mates.id = 'mteam';
    this.resp = el('div', 'mh-respawn hidden', hud, '<div class="mh-rring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" class="bg"/><circle cx="18" cy="18" r="16" class="fg"/></svg><b></b></div><div class="mh-rtext">RESPAWNING</div><div class="mh-rsub"></div>');
    this.resp.id = 'respawn';
    this.respB = this.resp.querySelector('b');
    this.respFg = this.resp.querySelector('.fg');
    this.respSub = this.resp.querySelector('.mh-rsub');
    this.blind = el('div', 'mh-blind hidden', hud, '<div>🙈</div><b></b><span>The others are hiding… no peeking!</span>');
    this.blindB = this.blind.querySelector('b');
    this.arrow = el('div', 'mh-arrow hidden', hud, '<i>➤</i><span></span>');
    this.arrow.id = 'hillarrow';
    this.arrowI = this.arrow.querySelector('i');
    this.arrowT = this.arrow.querySelector('span');
  }

  set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  show(on) { this.set('show', !!on, (v) => this.root.classList.toggle('hidden', !v)); }

  part(name, on) { this.set(`p:${name}`, !!on, (v) => this.el[name].classList.toggle('on', v)); }

  clockText(text) {
    this.part('clock', !!text);
    if (text) this.set('clock', text, (v) => { this.el.clockT.textContent = v; });
  }

  /** Two-team score bar: a / b = {name, color, score, mine}; goal 0 = no target. */
  bar(a, b, goal) {
    this.part('bar', !!a);
    if (!a) return;
    const side = (key, t, node) => {
      const k = goal > 0 ? Math.min(1, t.score / goal) : 0;
      this.set(`${key}`, `${t.name}|${t.color}|${t.score}|${t.mine}|${Math.round(k * 100)}`, () => {
        node.style.setProperty('--tc', t.color);
        node.classList.toggle('mine', !!t.mine);
        node.querySelector('i').style.width = `${Math.round(k * 100)}%`;
        node.querySelector('span').textContent = t.name.toUpperCase();
        node.querySelector('b').textContent = t.score;
      });
    };
    side('ba', a, this.el.ta);
    side('bb', b, this.el.tb);
    this.set('goal', goal > 0 ? String(goal) : 'VS', (v) => { this.el.goal.textContent = v; });
  }

  /** Top rows [{name, score, color, me}] and the 'you' line ('' hides it). */
  top(rows, meText) {
    this.part('top', rows && rows.length);
    if (rows && rows.length) {
      const key = rows.map((r) => `${r.name}|${r.score}|${r.color}|${r.me ? 1 : 0}`).join(';');
      this.set('top', key, () => {
        this.el.top.innerHTML = rows.map((r, i) => `<li class="${r.me ? 'me' : ''}"><em>${i + 1}</em><i style="background:${esc(r.color)}"></i><span>${esc(r.name)}</span><b>${Math.round(+r.score || 0)}</b></li>`).join('');
      });
    }
    this.part('me', !!meText);
    if (meText) this.set('me', meText, (v) => { this.el.me.innerHTML = v; });
  }

  /** Gun-game ladder: rung index of the local player (-1 hides). */
  ladder(rungs, lv) {
    this.part('ladder', lv >= 0);
    if (lv < 0) return;
    this.set('ladder', lv, () => {
      this.el.ladder.innerHTML = rungs.map((k, i) => `<span class="${i < lv ? 'done' : i === lv ? 'cur' : ''}">${LADDER_ICON[k] || esc(k)}</span>`).join('')
        + `<em>${lv + 1}/${rungs.length} · ${esc(rungs[lv] === 'pickaxe' ? 'PICKAXE: WIN IT!' : (WEAPONS[rungs[lv]] || {}).name || rungs[lv])}</em>`;
    });
  }

  /** One status line (hill, infection, juggernaut, lava); cls styles it. */
  line(html, cls = '') {
    this.part('line', !!html);
    if (!html) return;
    this.set('line', html, (v) => { this.el.line.innerHTML = v; });
    this.set('linec', cls, (v) => { this.el.line.className = `mh-line on ${v}`; });
  }

  /** Teammates panel: rows [{name, hp, sh, alive, color, note}], or null to hide. */
  teammates(rows) {
    const on = !!(rows && rows.length);
    this.set('mates', on, (v) => this.mates.classList.toggle('hidden', !v));
    if (!on) return;
    const shown = rows.slice(0, 4);
    const key = shown.map((r) => `${r.name}|${Math.ceil(r.hp)}|${Math.ceil(r.sh)}|${r.alive ? 1 : 0}|${r.color}|${r.note || ''}`).join(';') + `|${rows.length}`;
    this.set('matesHtml', key, () => {
      this.mates.innerHTML = shown.map((r) => `<div class="mh-mate${r.alive ? '' : ' dead'}" style="--tc:${r.color}"><span>${esc(r.name)}${r.note ? ` <small>${esc(r.note)}</small>` : ''}</span>`
        + `<i class="sh" style="transform:scaleX(${(Math.max(0, Math.min(100, r.sh)) / 100).toFixed(2)})"></i><i class="hp" style="transform:scaleX(${(Math.max(0, Math.min(100, r.hp)) / 100).toFixed(2)})"></i></div>`).join('')
        + (rows.length > shown.length ? `<div class="mh-more">+${rows.length - shown.length} more</div>` : '');
    });
  }

  /** The respawn overlay: seconds left (< 0 hides), the whole wait, a line under it. */
  respawn(left, total = 3, sub = '') {
    const on = left >= 0;
    this.set('resp', on, (v) => { this.resp.classList.toggle('hidden', !v); document.body.classList.toggle('respawning', v); });
    if (!on) return;
    this.set('respN', Math.ceil(left), (v) => { this.respB.textContent = v > 0 ? v : 'GO!'; });
    this.set('respK', Math.round((left / Math.max(0.1, total)) * 40), (k) => { this.respFg.style.strokeDashoffset = `${(100.5 * (1 - k / 40)).toFixed(1)}`; });
    this.set('respS', sub, (v) => { this.respSub.textContent = v; });
  }

  /** Hide & Seek: the seeker's closed eyes with the seconds left (< 0 hides). */
  blindfold(secs) {
    const on = secs >= 0;
    this.set('blind', on, (v) => this.blind.classList.toggle('hidden', !v));
    if (on) this.set('blindN', secs, (v) => { this.blindB.textContent = v; });
  }

  /** Off-screen arrow: screen x, y (px), angle (rad, 0 = right), metres away; x null hides. Runs every frame: no allocations unless something moved. */
  pointTo(x, y, ang, metres) {
    const on = x !== null;
    this.set('arrow', on, (v) => this.arrow.classList.toggle('hidden', !v));
    if (!on) return;
    const px = Math.round(x), py = Math.round(y), pa = Math.round(ang * 30), m = Math.round(metres);
    if (px !== this.ax || py !== this.ay) {
      this.ax = px; this.ay = py;
      this.arrow.style.transform = `translate(${px}px, ${py}px)`;
    }
    if (pa !== this.aa) {
      this.aa = pa;
      this.arrowI.style.transform = `rotate(${(pa / 30).toFixed(3)}rad)`;
    }
    if (m !== this.am) {
      this.am = m;
      this.arrowT.textContent = `${m} m`;
    }
  }

  dispose() {
    this.root.remove();
    this.mates.remove();
    this.resp.remove();
    this.blind.remove();
    this.arrow.remove();
  }
}

// ------------------------------------------------------------------ 3D
/** A vertical alpha ramp (opaque at the bottom) for the hill wall and beam. */
function rampTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 64);
  // alphaMap reads the green channel: an opaque grey ramp, black (clear) at the top
  gr.addColorStop(0, '#000');
  gr.addColorStop(0.65, '#737373');
  gr.addColorStop(1, '#fff');
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class HillView {
  constructor(scene) {
    this.scene = scene;
    this.ramp = rampTexture();
    this.group = new THREE.Group();
    this.group.visible = false;
    this.wallMat = new THREE.MeshBasicMaterial({
      color: 0xffd23f, alphaMap: this.ramp, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: true,
    });
    this.wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 3, 48, 1, true), this.wallMat);
    this.wall.position.y = 1.2;
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd23f, alphaMap: this.ramp, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.6, 90, 12, 1, true), this.beamMat);
    this.beam.position.y = 44;
    for (const m of [this.wall, this.beam]) { m.renderOrder = 5; m.castShadow = false; m.receiveShadow = false; this.group.add(m); }
    scene.add(this.group);
    this.color = new THREE.Color();
    this.cx = NaN; this.cz = NaN; this.cr = NaN; this.cc = '';
    this.t = 0;
  }

  /** Place the hill (x, z, ground y, radius) in a colour; null hides it. */
  set(h, y, color) {
    if (!h) { this.group.visible = false; this.cx = NaN; return; }
    this.group.visible = true;
    // numbers and the (shared) colour string: nothing is allocated while the hill stays put
    if (h.x === this.cx && h.z === this.cz && h.r === this.cr && color === this.cc) return;
    this.cx = h.x; this.cz = h.z; this.cr = h.r; this.cc = color;
    this.group.position.set(h.x, y, h.z);
    this.wall.scale.set(h.r, 1, h.r);
    this.color.set(color);
    this.wallMat.color.copy(this.color);
    this.beamMat.color.copy(this.color);
  }

  update(dt, contested) {
    if (!this.group.visible) return;
    this.t += dt;
    const pulse = contested ? 0.35 + 0.3 * Math.abs(Math.sin(this.t * 6)) : 0.5 + 0.08 * Math.sin(this.t * 2);
    this.wallMat.opacity = pulse;
    this.beamMat.opacity = pulse * 0.9;
  }

  dispose() {
    this.scene.remove(this.group);
    this.wall.geometry.dispose();
    this.beam.geometry.dispose();
    this.wallMat.dispose();
    this.beamMat.dispose();
    this.ramp.dispose();
  }
}

export class LavaView {
  constructor(scene, size) {
    this.scene = scene;
    this.mat = new THREE.MeshBasicMaterial({ color: 0xff5014, fog: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.y = -2;
    this.t = 0;
    this.c1 = new THREE.Color(0xff3c0a);
    this.c2 = new THREE.Color(0xffa020);
  }

  update(dt, level) {
    if (level === null) { this.mesh.visible = false; return; }
    // ease the small 4 Hz steps, jump to a new level (the first one)
    if (!this.mesh.visible || Math.abs(level - this.y) > 3) this.y = level;
    else this.y += (level - this.y) * Math.min(1, dt * 2);
    this.mesh.visible = true;
    this.mesh.position.y = this.y;
    this.t += dt;
    this.mat.color.copy(this.c1).lerp(this.c2, 0.5 + 0.5 * Math.sin(this.t * 1.7));
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
