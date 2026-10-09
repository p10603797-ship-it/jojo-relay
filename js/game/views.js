// Visual managers used by the game session: floor loot, storm wall, battle bus.
import * as THREE from 'three';
import { RARITY, WEAPONS, HEALS, MAP } from '../../shared/constants.js';
import { itemModel, itemMaterial } from '../combat/weaponModels.js';
import { busGeometry } from '../world/models.js';

const VIEW_DIST = 75;
const SHADOW_DIST = 20;
const GRID = 16;
const SHARED = new WeakMap(); // scene -> the loot meshes (kept across game sessions)
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Floor loot: one InstancedMesh per item model (kind + rarity) and one beam mesh per rarity, for
 * the items within 75 m (only those within 20 m cast shadows). A 16 m grid answers nearest() and
 * forNear() without walking every item. The API (items, set, add, remove, clear, nearest, update)
 * is the old one.
 */
export class LootView {
  constructor(scene) {
    this.scene = scene;
    this.items = new Map();
    this.grid = new Map();     // cell key -> Set of items
    this.time = 0;
    // the meshes outlive a game session: the next LootView on the same scene reuses them
    let sh = SHARED.get(scene);
    if (!sh) {
      const beamGeo = new THREE.CylinderGeometry(0.05, 0.32, 2.6, 10, 1, true);
      beamGeo.translate(0, 1.3, 0);
      const beamMats = RARITY.map((r) => new THREE.MeshBasicMaterial({
        color: new THREE.Color(r.color), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      sh = { beamGeo, beamMats, models: new Map(), beams: null };
      SHARED.set(scene, sh);
      sh.beams = beamMats.map((m) => this.makeMesh(beamGeo, m, 16, false));
    }
    this.beamGeo = sh.beamGeo;
    this.beamMats = sh.beamMats;
    this.models = sh.models;   // model key -> { mesh, cap, n, shadow }
    this.beams = sh.beams;
    this.beamN = new Int32Array(RARITY.length);
    this.shown = [];           // items within view distance, the ones within 20 m first
    this.tick = 0;
  }

  makeMesh(geo, mat, cap, shadow) {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(mesh);
    return mesh;
  }

  cellKey(x, z) { return Math.floor(x / GRID) * 100003 + Math.floor(z / GRID); }

  clear() {
    this.items.clear();
    this.grid.clear();
    this.shown.length = 0;
    for (const g of this.models.values()) { g.mesh.count = 0; g.mesh.visible = false; }
    for (const b of this.beams) { b.count = 0; b.visible = false; }
  }

  set(list) {
    this.clear();
    for (const l of list) this.add(l);
    this.tick = 0;
  }

  add(l) {
    if (this.items.has(l.id)) return;
    const isW = !!WEAPONS[l.item.k];
    const rar = isW ? l.item.r | 0 : HEALS[l.item.k] ? HEALS[l.item.k].rarity : -1;
    const it = { id: l.id, item: l.item, x: l.x, y: l.y, z: l.z, phase: Math.random() * 6, key: `${l.item.k}|${l.item.r | 0}`, scale: isW ? 1.25 : 1.6, tilt: isW ? 0.25 : 0, beam: rar, cell: this.cellKey(l.x, l.z) };
    this.items.set(l.id, it);
    let set = this.grid.get(it.cell);
    if (!set) this.grid.set(it.cell, (set = new Set()));
    set.add(it);
    this.tick = 0;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return null;
    this.items.delete(id);
    const set = this.grid.get(it.cell);
    if (set) set.delete(it);
    const i = this.shown.indexOf(it);
    if (i >= 0) this.shown.splice(i, 1);
    return it;
  }

  /** Call fn(item) for every item within r metres (horizontally) of (x, z). */
  forNear(x, z, r, fn) {
    const c0 = Math.floor((x - r) / GRID), c1 = Math.floor((x + r) / GRID);
    const d0 = Math.floor((z - r) / GRID), d1 = Math.floor((z + r) / GRID);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const set = this.grid.get(cx * 100003 + cz);
        if (!set) continue;
        for (const it of set) {
          const dx = it.x - x, dz = it.z - z;
          if (dx * dx + dz * dz <= r * r) fn(it);
        }
      }
    }
  }

  nearest(pos, maxDist, filter) {
    let best = null, bd = maxDist * maxDist;
    const c0 = Math.floor((pos.x - maxDist) / GRID), c1 = Math.floor((pos.x + maxDist) / GRID);
    const d0 = Math.floor((pos.z - maxDist) / GRID), d1 = Math.floor((pos.z + maxDist) / GRID);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const set = this.grid.get(cx * 100003 + cz);
        if (!set) continue;
        for (const it of set) {
          const dx = it.x - pos.x, dy = it.y - pos.y, dz = it.z - pos.z;
          if (dy > 1.8 || dy < -1.8) continue;
          const d = dx * dx + dz * dz + dy * dy * 0.5;
          if (d < bd && (!filter || filter(it))) { bd = d; best = it; }
        }
      }
    }
    return best;
  }

  group(key, it) {
    let g = this.models.get(key);
    if (!g) {
      const m = itemModel(it.item.k, it.item.r | 0);
      g = { mesh: this.makeMesh(m.geo, itemMaterial(), 8, true), cap: 8, n: 0, shadow: 0 };
      const gg = g;
      g.mesh.onBeforeShadow = () => { gg.mesh.count = gg.shadow; };
      g.mesh.onAfterShadow = () => { gg.mesh.count = gg.n; };
      this.models.set(key, g);
    }
    if (g.n >= g.cap) {
      // grow: a new mesh with twice the room
      const old = g.mesh;
      g.cap *= 2;
      g.mesh = this.makeMesh(old.geometry, old.material, g.cap, true);
      g.mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      const gg = g;
      g.mesh.onBeforeShadow = () => { gg.mesh.count = gg.shadow; };
      g.mesh.onAfterShadow = () => { gg.mesh.count = gg.n; };
      this.scene.remove(old);
      old.dispose();
    }
    return g;
  }

  update(dt, camPos) {
    this.time += dt;
    this.tick -= dt;
    if (this.tick <= 0) {
      // who is in view: everything within 75 m, nearest (shadow casters) first
      this.tick = 0.4;
      const shown = this.shown;
      shown.length = 0;
      const near = [];
      this.forNear(camPos.x, camPos.z, VIEW_DIST, (it) => {
        const dx = it.x - camPos.x, dz = it.z - camPos.z;
        it.near = dx * dx + dz * dz < SHADOW_DIST * SHADOW_DIST;
        (it.near ? near : shown).push(it);
      });
      if (near.length) shown.unshift(...near);
    }
    for (const g of this.models.values()) { g.n = 0; g.shadow = 0; }
    this.beamN.fill(0);
    const pulse = 0.28 + Math.sin(this.time * 3) * 0.06;
    for (const m of this.beamMats) m.opacity = pulse;
    for (let i = 0; i < this.shown.length; i++) {
      const it = this.shown[i];
      const g = this.group(it.key, it);
      const t = this.time + it.phase;
      _q.setFromEuler(_e.set(0, t * 1.1, it.tilt));
      _m.compose(_p.set(it.x, it.y + 0.42 + Math.sin(t * 2.2) * 0.07, it.z), _q, _s.setScalar(it.scale));
      g.mesh.setMatrixAt(g.n++, _m);
      if (it.near) g.shadow = g.n;
      if (it.beam >= 0) {
        const r = Math.min(it.beam, this.beams.length - 1);
        let b = this.beams[r];
        if (this.beamN[r] >= b.instanceMatrix.count) {
          const nb = this.makeMesh(this.beamGeo, this.beamMats[r], b.instanceMatrix.count * 2, false);
          nb.instanceMatrix.array.set(b.instanceMatrix.array);
          this.scene.remove(b);
          b.dispose();
          this.beams[r] = b = nb;
        }
        _m.makeTranslation(it.x, it.y, it.z);
        b.setMatrixAt(this.beamN[r]++, _m);
      }
    }
    for (const g of this.models.values()) {
      g.mesh.count = g.n;
      g.mesh.visible = g.n > 0;
      if (g.n) g.mesh.instanceMatrix.needsUpdate = true;
    }
    for (let r = 0; r < this.beams.length; r++) {
      const b = this.beams[r];
      b.count = this.beamN[r];
      b.visible = b.count > 0;
      if (b.count) b.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    SHARED.delete(this.scene);
    for (const g of this.models.values()) { this.scene.remove(g.mesh); g.mesh.dispose(); }
    for (const b of this.beams) { this.scene.remove(b); b.dispose(); }
    this.beamGeo.dispose();
    for (const m of this.beamMats) m.dispose();
    this.models.clear();
  }
}

export class StormView {
  constructor(scene, noiseTex) {
    this.state = null;
    this.vis = { cx: 0, cz: 0, r: 330 };
    // a smooth wall on the big island: more sides when the map (and so the circle) is large
    const geo = new THREE.CylinderGeometry(1, 1, 1, MAP.size > 700 ? 192 : 96, 1, true);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uNoise: { value: noiseTex } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vW;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform sampler2D uNoise;
        varying vec2 vUv;
        varying vec3 vW;
        void main() {
          float n = texture2D(uNoise, vec2(vUv.x * 9.0 + uTime * 0.012, vW.y * 0.008 - uTime * 0.035)).r;
          float n2 = texture2D(uNoise, vec2(vUv.x * 27.0 - uTime * 0.02, vW.y * 0.025 + uTime * 0.05)).g;
          float f = n * 0.7 + n2 * 0.5;
          vec3 col = mix(vec3(0.3, 0.06, 0.6), vec3(0.85, 0.52, 1.0), smoothstep(0.45, 1.1, f));
          float a = 0.34 + smoothstep(0.5, 1.0, f) * 0.36;
          // tall near the player, a faint haze on the horizon
          float cd = length(vW.xz - cameraPosition.xz);
          float top = mix(240.0, 90.0, smoothstep(60.0, 320.0, cd));
          a *= 1.0 - smoothstep(top * 0.4, top, vW.y - cameraPosition.y * 0.5);
          a *= mix(1.0, 0.16, smoothstep(70.0, 300.0, cd));
          gl_FragColor = vec4(col, a);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
    this.mesh.position.y = -40;
    scene.add(this.mesh);
  }

  set(arr) {
    if (!arr) { this.state = null; return; }
    const first = !this.state;
    this.state = {
      cx: arr[0], cz: arr[1], r: arr[2], ncx: arr[3], ncz: arr[4], nr: arr[5], secs: arr[6], shrinking: arr[7] === 1, done: arr[7] === 2, phase: arr[8], dps: arr[9],
    };
    if (first) Object.assign(this.vis, { cx: arr[0], cz: arr[1], r: arr[2] });
  }

  clear() { this.state = null; this.mesh.visible = false; }

  /** Metres outside the safe circle (negative = inside). */
  outside(x, z) {
    if (!this.state) return -1;
    return Math.hypot(x - this.vis.cx, z - this.vis.cz) - this.vis.r;
  }

  /** The Game is going away: the wall's GPU buffers and shader go with it (the noise texture is shared). */
  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }

  update(dt) {
    this.mat.uniforms.uTime.value += dt;
    const s = this.state;
    if (!s) { this.mesh.visible = false; return; }
    const k = Math.min(1, dt * 4);
    this.vis.cx += (s.cx - this.vis.cx) * k;
    this.vis.cz += (s.cz - this.vis.cz) * k;
    this.vis.r += (s.r - this.vis.r) * k;
    this.mesh.visible = true;
    this.mesh.position.set(this.vis.cx, -40, this.vis.cz);
    this.mesh.scale.set(Math.max(0.5, this.vis.r), 520, Math.max(0.5, this.vis.r));
  }
}

export class BusView {
  constructor(scene) {
    this.mesh = new THREE.Mesh(busGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }));
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.path = null;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this._pred = new THREE.Vector3();
    this.t = 0;
  }

  start(bus) {
    this.path = bus;
    this.t0 = performance.now() - (bus.el || 0) * 1000;
    this.mesh.visible = true;
    const dx = bus.bx - bus.ax, dz = bus.bz - bus.az;
    this.mesh.rotation.y = Math.atan2(dx, dz);
    this.update(0);
  }

  stop() { this.path = null; this.mesh.visible = false; }

  /** The Game is going away: every BusView builds its own bus geometry and material. */
  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /** Position predicted from the path (server snapshots only correct drift). */
  predicted(out) {
    const b = this.path;
    const len = Math.hypot(b.bx - b.ax, b.bz - b.az);
    const t = Math.min(1, ((performance.now() - this.t0) / 1000) * b.speed / len);
    return out.set(b.ax + (b.bx - b.ax) * t, b.y, b.az + (b.bz - b.az) * t);
  }

  correct(arr) {
    if (!this.path) return;
    this.target.set(arr[0], arr[1], arr[2]);
    const p = this.predicted(this._pred);
    // shift our clock if we drifted more than a few metres
    const err = p.distanceTo(this.target);
    if (err > 6) {
      const b = this.path;
      const len = Math.hypot(b.bx - b.ax, b.bz - b.az);
      const tt = Math.hypot(arr[0] - b.ax, arr[2] - b.az) / len;
      this.t0 = performance.now() - (tt * len / b.speed) * 1000;
    }
  }

  update(dt) {
    if (!this.path) return;
    this.t += dt;
    this.predicted(this.pos);
    this.mesh.position.set(this.pos.x, this.pos.y - 2 + Math.sin(this.t * 1.3) * 0.4, this.pos.z);
    this.mesh.rotation.z = Math.sin(this.t * 0.9) * 0.04;
  }
}
