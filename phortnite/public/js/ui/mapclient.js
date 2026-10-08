// Game plugin for the map: squad markers (full-map taps, pins + 3D beams), floating place names
// over the island while in the bus or skydiving, launch pads / geysers / mushrooms for the
// people simulated on this device, and the bigger minimap while skydiving.
// See js/game/plugins.js for the hook interface.
//
// Markers: a tap on the full map sends {t:'mark', x, z} (or {t:'mark', clear:1}); the party plugin
// relays {t:'mark', id, x, z} / {t:'mark', id, clear} to teammates (and back to us). Our own
// marker shows at once, before the relay comes back (and in solo, where nothing relays it).
import * as THREE from 'three';
import { PAD_KICK } from '../world/traversal.js';

// physics.js RAY_STATIC (the world and builds); not imported, so this plugin loads in Node too
// (physics.js pulls in the Rapier module, which only the browser's import map knows)
const RAY_STATIC = ((0xffff << 16) | 1 | 2) >>> 0;

const MARK_COLORS = ['#4fd2ff', '#ff6aa0', '#7cff6a', '#c08cff', '#ff9a3c', '#ffffff'];
const MY_MARK = '#ffd23f';
const MAX_MARKS = 16;
const LABEL_MIN_HEIGHT = 60;   // metres above the ground before the place names show

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export class MapClient {
  constructor(game) {
    this.game = game;
    this.marks = new Map();   // player id -> { x, z }
    this.cool = new Map();    // actor -> time of its last launch
    this.time = 0;
    this.ready = false;
    this.labelK = 0;          // label opacity (eased)
    this.dirty = true;
    this.markVersion = 1;     // bumped when the markers change (the map pins follow)
    this.pinsDirty = 0;
  }

  /** Built on first use (the game's world, hud and scene exist by then). */
  init() {
    const g = this.game;
    if (this.ready || !g || !g.world || !g.scene) return this.ready;
    this.ready = true;
    this.view = g.hud && g.hud.mapView;
    if (this.view) this.view.onMark = (x, z) => this.sendMark(x, z);
    this.buildBeams();
    this.buildLabels();
    return true;
  }

  // ------------------------------------------------------------------ markers
  sendMark(x, z) {
    const g = this.game;
    if (x === null || x === undefined) {
      g.send({ t: 'mark', clear: 1 });
      this.marks.delete(g.myId);
    } else {
      const r = (v) => Math.round(v * 10) / 10;
      g.send({ t: 'mark', x: r(x), z: r(z) });
      this.marks.set(g.myId, { x, z });
      if (g.sfx && g.sfx.ui) g.sfx.ui('click');
    }
    this.dirty = true;
    this.markVersion++;
  }

  onMessage(m) {
    if (m.t === 'mark') {
      if (m.clear) this.marks.delete(m.id);
      else if (Number.isFinite(m.x) && Number.isFinite(m.z)) this.marks.set(m.id, { x: m.x, z: m.z });
      this.dirty = true;
      this.markVersion++;
    } else if (m.t === 'welcome' || m.t === 'start' || m.t === 'lobby') {
      this.marks.clear();
      this.dirty = true;
      this.markVersion++;
    }
  }

  onPhase(phase) {
    if (phase === 'lobby') { this.marks.clear(); this.dirty = true; this.markVersion++; }
  }

  colorOf(id) {
    if (id === this.game.myId) return MY_MARK;
    return MARK_COLORS[Math.abs(id | 0) % MARK_COLORS.length];
  }

  buildBeams() {
    const g = this.game;
    const geo = new THREE.CylinderGeometry(0.55, 0.9, 1, 10, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_MARKS);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKS * 3), 3);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 50;
    mesh.name = 'mark-beams';
    g.scene.add(mesh);
    this.beams = mesh;
  }

  updateBeams() {
    const g = this.game, d = g.world.data;
    // drop the marks of people who left
    if (g.roster && g.roster.size) for (const id of this.marks.keys()) if (id !== g.myId && !g.roster.has(id)) { this.marks.delete(id); this.markVersion++; }
    let n = 0;
    for (const [id, mk] of this.marks) {
      if (n >= MAX_MARKS) break;
      const y = Math.max(d.heightAt(mk.x, mk.z), 0);
      _m.makeScale(1, 140, 1).setPosition(mk.x, y, mk.z);
      this.beams.setMatrixAt(n, _m);
      this.beams.setColorAt(n, _c.set(this.colorOf(id)));
      n++;
    }
    this.beams.count = n;
    this.beams.instanceMatrix.needsUpdate = true;
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ place names in 3D
  /** One billboard mesh for every named place: a text atlas, constant size on screen. */
  buildLabels() {
    const g = this.game, d = g.world.data;
    const regs = (d.regions || d.pois || []).filter((r) => r.named !== false);
    if (!regs.length || typeof document === 'undefined') return;
    const W = 1024, ROW = 72, FS = 50;
    const c = document.createElement('canvas');
    c.width = W; c.height = 1024;
    const x2 = c.getContext('2d');
    x2.font = `${FS}px "Luckiest Guy", "Russo One", sans-serif`;
    x2.textBaseline = 'middle';
    x2.lineJoin = 'round';
    const items = [];
    let px = 0, py = 0;
    for (const r of regs) {
      const text = r.name.toUpperCase();
      const w = Math.ceil(x2.measureText(text).width) + 24;
      if (px + w > W) { px = 0; py += ROW; }
      if (py + ROW > c.height) break;
      const hot = r.tier === 'hot';
      x2.lineWidth = 10;
      x2.strokeStyle = 'rgba(10, 8, 30, 0.85)';
      x2.fillStyle = hot ? '#ffd23f' : '#ffffff';
      x2.strokeText(text, px + 12, py + ROW / 2);
      x2.fillText(text, px + 12, py + ROW / 2);
      items.push({ r, u0: px / W, v0: py / c.height, u1: (px + w) / W, v1: (py + ROW) / c.height, w, h: ROW, hot });
      px += w;
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const n = items.length;
    const pos = new Float32Array(n * 12), corner = new Float32Array(n * 8), uv = new Float32Array(n * 8), idx = [];
    items.forEach((it, i) => {
      const y = Math.max(it.r.y ?? d.heightAt(it.r.x, it.r.z), 0) + 45;
      const k = it.hot ? 0.62 : 0.46;  // label height on screen = ROW * k px
      const hw = it.w * k / 2, hh = it.h * k / 2;
      const cs = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      const us = [[it.u0, it.v1], [it.u1, it.v1], [it.u1, it.v0], [it.u0, it.v0]];
      for (let j = 0; j < 4; j++) {
        pos.set([it.r.x, y, it.r.z], (i * 4 + j) * 3);
        corner.set(cs[j], (i * 4 + j) * 2);
        uv.set(us[j], (i * 4 + j) * 2);
      }
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const uniforms = { tMap: { value: tex }, uPx: { value: new THREE.Vector2(1 / 512, 1 / 512) }, uOpacity: { value: 0 }, uFar: { value: 1000 } };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec2 aCorner;
        uniform vec2 uPx;
        uniform float uFar;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          if (clip.w <= 0.1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }
          // nearer places read bigger; the ones lost in the haze fade away (no pile-up on the horizon)
          float d = clip.w;
          float size = mix(1.25, 0.7, smoothstep(120.0, uFar * 0.8, d));
          vFade = 1.0 - smoothstep(uFar * 0.55, uFar * 0.9, d);
          clip.xy += aCorner * size * uPx * clip.w;
          gl_Position = clip;
          vUv = uv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tMap;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          vec4 t = texture2D(tMap, vUv);
          gl_FragColor = vec4(t.rgb, t.a * uOpacity * vFade);
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 60;
    mesh.visible = false;
    mesh.name = 'place-names';
    g.scene.add(mesh);
    this.labels = mesh;
    this.labelU = uniforms;
  }

  updateLabels(dt) {
    const g = this.game, me = g.me;
    if (!this.labels || !me) return;
    let show = false;
    if (me.inBus) show = true;
    else if (me.alive && (me.mode === 'skydive' || me.mode === 'glide')) {
      const ground = Math.max(g.world.data.heightAt(me.pos.x, me.pos.z), 0);
      show = me.pos.y - ground > LABEL_MIN_HEIGHT;
    }
    this.labelK += ((show ? 1 : 0) - this.labelK) * Math.min(1, dt * 4);
    this.labels.visible = this.labelK > 0.02;
    if (!this.labels.visible) return;
    this.labelU.uOpacity.value = this.labelK;
    this.labelU.uFar.value = g.world.fogFar || 1000;
    const r = g.app && g.app.renderer;
    if (r) {
      r.getDrawingBufferSize(_v);
      const pr = r.getPixelRatio();
      this.labelU.uPx.value.set((2 * pr) / Math.max(1, _v.x), (2 * pr) / Math.max(1, _v.y));
    }
  }

  // ------------------------------------------------------------------ launch pads
  /** Throw me and the bots simulated here when they step on a pad; glide down afterwards. */
  updatePads(dt) {
    const g = this.game;
    const T = g.world.traversal;
    if (g.me) this.padActor(g.me, T);
    if (g.bots) for (const b of g.bots.values()) this.padActor(b, T);
    void dt;
  }

  padActor(a, T) {
    if (!a || !a.alive || a.inBus || !a.mover) return;
    const mv = a.mover;
    const mode = mv.mode;
    if (mode === 'bus' || mode === 'dead') return;
    // after a launch: open the glider once well clear of the ground (soft landing, no fall damage)
    if (mv.launched && mode === 'air' && mv.vel.y < -1) {
      const h = this.game.physics.raycast(a.pos.x, a.pos.y + 0.2, a.pos.z, 0, -1, 0, 60, RAY_STATIC);
      if (!h || h.dist > 5) mv.mode = 'glide';
    }
    if (!T || !T.pads.length || mode === 'skydive' || mode === 'glide') return;
    const p = T.padAt(a.pos.x, a.pos.y, a.pos.z);
    if (!p) return;
    const last = this.cool.get(a) || -9;
    if (this.time - last < 1.2) return;
    this.cool.set(a, this.time);
    const kick = PAD_KICK[p.kind];
    const power = p.power || 1;
    let fx = -Math.sin(a.yaw || 0), fz = -Math.cos(a.yaw || 0);
    if (p.kind === 'mushroom') {
      // a bounce keeps the way you were going
      const sp = Math.hypot(mv.vel.x, mv.vel.z);
      if (sp > 0.5) { fx = mv.vel.x / sp; fz = mv.vel.z / sp; }
    }
    if (mv.launch) mv.launch(fx * kick.fwd * power, kick.up * power, fz * kick.fwd * power);
    else { mv.vel.set(fx * kick.fwd * power, kick.up * power, fz * kick.fwd * power); mv.mode = 'air'; mv.launched = true; }
    const g = this.game;
    if (g.fx && g.fx.dust) g.fx.dust(p.x, p.y + 0.3, p.z, 1.6, p.kind === 'geyser' ? [0.92, 0.96, 1] : [0.8, 0.85, 1]);
    if (g.sfx && g.sfx.whoosh) g.sfx.whoosh(a === g.me);
  }

  // ------------------------------------------------------------------ hooks
  update(dt) {
    if (!this.init()) return;
    this.time += dt;
    this.updatePads(dt);
    this.updateLabels(dt);
    if (this.dirty) { this.dirty = false; this.updateBeams(); }
  }

  hud() {
    if (!this.init()) return;
    const g = this.game, me = g.me;
    const view = this.view;
    if (view) {
      view.skydive = !!me && (me.inBus || (me.alive && (me.mode === 'skydive' || me.mode === 'glide')));
      view.myMark = this.marks.get(g.myId) || null;
    }
    const ex = g.mapExtras;
    if (!ex) return;
    // squad markers as big pins (rebuilt only when they change)
    if (this.pinsDirty !== this.markVersion) {
      this.pinsDirty = this.markVersion;
      if (this.marks.size) {
        const pins = [];
        for (const [id, mk] of this.marks) {
          const p = g.roster && g.roster.get(id);
          pins.push({ x: mk.x, z: mk.z, c: this.colorOf(id), big: true, label: id === g.myId ? 'YOU' : p && p.name ? String(p.name).slice(0, 10) : '' });
        }
        ex.marks = { pins };
      } else delete ex.marks;
    }
    // teammates (people and bots on your team) as outlined dots, reusing the same objects
    const team = this.team || (this.team = { dots: [] });
    const dots = team.dots;
    let n = 0;
    if (g.phase !== 'lobby' && g.friendly && g.actors) {
      for (const a of g.actors()) {
        if (a === me || !a.alive || a.inBus || !a.pos) continue;
        if (!g.friendly(a.id, g.myId)) continue;
        const d = dots[n] || (dots[n] = { x: 0, z: 0, c: '#4fd2ff', r: 4.5 });
        d.x = a.pos.x; d.z = a.pos.z;
        n++;
      }
    }
    dots.length = n;
    if (n) ex.team = team; else if (ex.team) delete ex.team;
  }

  dispose() {
    const g = this.game;
    if (this.beams) { g.scene.remove(this.beams); this.beams.geometry.dispose(); this.beams.material.dispose(); this.beams.dispose(); }
    if (this.labels) { g.scene.remove(this.labels); this.labels.geometry.dispose(); this.labels.material.uniforms.tMap.value.dispose(); this.labels.material.dispose(); }
    if (this.view) { this.view.onMark = null; this.view.skydive = false; this.view.myMark = null; }
    if (g && g.mapExtras) { delete g.mapExtras.marks; delete g.mapExtras.team; }
    this.ready = false;
  }
}
