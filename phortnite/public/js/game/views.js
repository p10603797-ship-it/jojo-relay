// Visual managers used by the game session: floor loot, storm wall, battle bus.
import * as THREE from 'three';
import { RARITY, WEAPONS, HEALS } from '../../shared/constants.js';
import { itemModel, itemMaterial } from '../combat/weaponModels.js';
import { busGeometry } from '../world/models.js';

const VIEW_DIST = 75;

export class LootView {
  constructor(scene) {
    this.scene = scene;
    this.items = new Map();
    this.time = 0;
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.32, 2.6, 10, 1, true);
    beamGeo.translate(0, 1.3, 0);
    this.beamGeo = beamGeo;
    this.beamMats = RARITY.map((r) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(r.color), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.tick = 0;
  }

  clear() {
    for (const it of this.items.values()) this.hide(it);
    this.items.clear();
  }

  set(list) {
    this.clear();
    for (const l of list) this.add(l);
  }

  add(l) {
    if (this.items.has(l.id)) return;
    this.items.set(l.id, { id: l.id, item: l.item, x: l.x, y: l.y, z: l.z, mesh: null, beam: null, phase: Math.random() * 6, shown: false });
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return null;
    this.hide(it);
    this.items.delete(id);
    return it;
  }

  show(it) {
    if (!it.mesh) {
      const m = itemModel(it.item.k, it.item.r | 0);
      it.mesh = new THREE.Mesh(m.geo, itemMaterial());
      it.mesh.castShadow = true;
      const isW = !!WEAPONS[it.item.k];
      const scale = isW ? 1.25 : 1.6;
      it.mesh.scale.setScalar(scale);
      if (isW || HEALS[it.item.k]) {
        const r = isW ? it.item.r | 0 : HEALS[it.item.k].rarity;
        it.beam = new THREE.Mesh(this.beamGeo, this.beamMats[r]);
        it.beam.position.set(it.x, it.y, it.z);
      }
    }
    this.scene.add(it.mesh);
    if (it.beam) this.scene.add(it.beam);
    it.shown = true;
  }

  hide(it) {
    if (!it.shown) return;
    this.scene.remove(it.mesh);
    if (it.beam) this.scene.remove(it.beam);
    it.shown = false;
  }

  nearest(pos, maxDist, filter) {
    let best = null, bd = maxDist * maxDist;
    for (const it of this.items.values()) {
      const dx = it.x - pos.x, dy = it.y - pos.y, dz = it.z - pos.z;
      if (dy > 1.8 || dy < -1.8) continue;
      const d = dx * dx + dz * dz + dy * dy * 0.5;
      if (d < bd && (!filter || filter(it))) { bd = d; best = it; }
    }
    return best;
  }

  update(dt, camPos) {
    this.time += dt;
    this.tick -= dt;
    const check = this.tick <= 0;
    if (check) this.tick = 0.4;
    for (const it of this.items.values()) {
      if (check) {
        const dx = it.x - camPos.x, dz = it.z - camPos.z;
        const near = dx * dx + dz * dz < VIEW_DIST * VIEW_DIST;
        if (near && !it.shown) this.show(it);
        else if (!near && it.shown) this.hide(it);
      }
      if (!it.shown) continue;
      const t = this.time + it.phase;
      it.mesh.position.set(it.x, it.y + 0.42 + Math.sin(t * 2.2) * 0.07, it.z);
      it.mesh.rotation.set(0, t * 1.1, WEAPONS[it.item.k] ? 0.25 : 0);
      if (it.beam) it.beam.material.opacity = 0.28 + Math.sin(this.time * 3) * 0.06;
    }
  }
}

export class StormView {
  constructor(scene, noiseTex) {
    this.state = null;
    this.vis = { cx: 0, cz: 0, r: 330 };
    const geo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
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
          vec3 col = mix(vec3(0.32, 0.08, 0.62), vec3(0.88, 0.58, 1.0), smoothstep(0.45, 1.1, f));
          float a = 0.3 + smoothstep(0.5, 1.0, f) * 0.35;
          a *= smoothstep(420.0, 160.0, vW.y);
          float cd = length(vW.xz - cameraPosition.xz);
          a *= mix(1.0, 0.35, smoothstep(120.0, 420.0, cd));
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
    const p = this.predicted(new THREE.Vector3());
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
