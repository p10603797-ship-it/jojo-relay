// The lobby stage: your squad on a glowing podium on a floating island, in a scene of its own.
// While it is showing, main.js renders this scene INSTEAD of the island, so the lobby costs a
// fraction of a match (about 15 draw calls; budget 40 calls and 80k triangles).
//
// Up to 4 party members stand on a shallow arc (x = 0, -1.6, +1.6, -3.1): you in the centre, the
// leader next to you. Each is a Character holding a pickaxe that idles, looks around, twirls the
// pickaxe and flosses on 'emote'. DOM nameplates (name, level, crown, READY) follow their heads;
// tapping one is handled by the lobby UI (data-id). More than 4 humans show a '+N' chip.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ANIM, SKINS } from '../../shared/constants.js';
import { Character } from '../actors/character.js';
import { createSky } from '../gfx/sky.js';
import { busGeometry } from '../world/models.js';

const SLOT_X = [0, -1.6, 1.6, -3.1];
const PODIUM_R = 4.5, PODIUM_H = 0.5;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _v = new THREE.Vector3();
const _c = new THREE.Color();

// one random generator for the scenery, so the island looks the same every time
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function paint(g, hex, jitter = 0, rnd = Math.random) {
  _c.set(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 - jitter / 2 + rnd() * jitter;
    a[i * 3] = _c.r * k; a[i * 3 + 1] = _c.g * k; a[i * 3 + 2] = _c.b * k;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  return g;
}

/** Non-indexed, position + normal + color only (so everything merges into one draw call). */
function prep(g) {
  const out = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'color') out.deleteAttribute(k);
  out.computeVertexNormals();
  return out;
}

/** A low-poly floating island: grassy top, rocky underside, trees and rocks (one geometry). */
function islandGeometry(r, seed, opts = {}) {
  const rnd = rng(seed);
  const parts = [];
  const top = new THREE.CylinderGeometry(r, r * 0.92, r * 0.16, 14, 1);
  const tp = top.attributes.position;
  for (let i = 0; i < tp.count; i++) if (tp.getY(i) > 0) tp.setY(i, tp.getY(i) + (rnd() - 0.5) * r * 0.03);
  parts.push(paint(top, opts.grass || 0x56b84a, 0.18, rnd));
  const under = new THREE.ConeGeometry(r * 0.92, r * 1.25, 12, 3);
  under.rotateX(Math.PI);
  under.translate(0, -r * 0.08 - r * 0.625, 0);
  const up = under.attributes.position;
  for (let i = 0; i < up.count; i++) {
    const y = up.getY(i);
    if (y > -r * 1.3) { up.setX(i, up.getX(i) * (0.85 + rnd() * 0.3)); up.setZ(i, up.getZ(i) * (0.85 + rnd() * 0.3)); }
  }
  parts.push(paint(under, 0x8a6a52, 0.3, rnd));
  const dirt = new THREE.CylinderGeometry(r * 0.93, r * 0.9, r * 0.1, 14, 1);
  dirt.translate(0, -r * 0.11, 0);
  parts.push(paint(dirt, 0x6b4a33, 0.15, rnd));
  const trees = opts.trees ?? Math.round(r * 0.9);
  for (let i = 0; i < trees; i++) {
    const a = rnd() * Math.PI * 2;
    const d = r * (0.45 + rnd() * 0.45);
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    // keep the front of the big island (the podium and the camera) clear: trees only along the back
    if (opts.clearFront && z > -r * 0.5) continue;
    const s = (0.7 + rnd() * 0.8) * (opts.treeScale || 1);
    const trunk = new THREE.CylinderGeometry(0.18 * s, 0.26 * s, 1.6 * s, 5);
    trunk.translate(x, r * 0.08 + 0.8 * s, z);
    parts.push(paint(trunk, 0x6b4a2b, 0.2, rnd));
    const pine = rnd() < 0.5;
    if (pine) {
      for (let k = 0; k < 2; k++) {
        const cone = new THREE.ConeGeometry((1.3 - k * 0.35) * s, (2.0 - k * 0.3) * s, 7);
        cone.translate(x, r * 0.08 + (2.0 + k * 1.1) * s, z);
        parts.push(paint(cone, k ? 0x3f9a45 : 0x2f7d3a, 0.2, rnd));
      }
    } else {
      const blob = new THREE.IcosahedronGeometry(1.25 * s, 0);
      blob.translate(x, r * 0.08 + 2.4 * s, z);
      parts.push(paint(blob, 0x58b04a, 0.25, rnd));
    }
  }
  const rocks = Math.round(r * 0.4);
  for (let i = 0; i < rocks; i++) {
    const a = rnd() * Math.PI * 2, d = r * (0.6 + rnd() * 0.35);
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    if (opts.clearFront && z > -r * 0.25) continue;
    const rock = new THREE.DodecahedronGeometry(0.4 + rnd() * 0.7, 0);
    rock.scale(1, 0.7, 1);
    rock.translate(x, r * 0.08 + 0.15, z);
    parts.push(paint(rock, 0x9a9aa8, 0.25, rnd));
  }
  return mergeGeometries(parts.map(prep), false);
}

/** A soft round shadow texture (for the blob shadows under the characters). */
function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The podium's glowing top: rings and a soft centre glow. */
function podiumTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, '#4b3fb8');
  gr.addColorStop(0.6, '#2c2380');
  gr.addColorStop(0.93, '#1e1658');
  gr.addColorStop(1, '#6fe6ff');
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(140, 220, 255, 0.22)';
  g.lineWidth = 2;
  for (const r of [46, 84, 114]) { g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
  // a soft spotlight pool in the middle
  const sp = g.createRadialGradient(128, 128, 0, 128, 128, 70);
  sp.addColorStop(0, 'rgba(190, 210, 255, 0.35)');
  sp.addColorStop(1, 'rgba(190, 210, 255, 0)');
  g.fillStyle = sp;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class LobbyStage {
  constructor(app) {
    this.app = app;
    this.visible = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 2000);
    this.time = 0;
    this.members = new Map(); // id -> { c: Character, slot, x, z, ... }
    this.order = [];
    this.extra = 0;
    this.celebrating = null;
    this.camDist = 5;
    this.camX = 0;
    this.camY = 1.5;
    this.build();
    // nameplates (DOM) above the stage canvas, below the lobby UI
    this.plates = document.createElement('div');
    this.plates.id = 'stageplates';
    this.plates.className = 'hidden';
    document.body.appendChild(this.plates);
    this.more = document.createElement('div');
    this.more.className = 'plate more hidden';
    this.plates.appendChild(this.more);
  }

  build() {
    const S = this.scene;
    const app = this.app;
    if (app.scene && app.scene.environment) {
      S.environment = app.scene.environment;
      S.environmentIntensity = 0.5;
    }
    try {
      this.sky = createSky(app.T.noise.map, 900);
    } catch (e) {
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 16, 8), new THREE.MeshBasicMaterial({ color: 0x6fb4f0, side: THREE.BackSide, fog: false }));
    }
    S.add(this.sky);
    S.add(new THREE.HemisphereLight(0xcfe6ff, 0x5b4a7a, 1.5));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.4);
    key.position.set(4, 8, 7);
    S.add(key);
    const rim = new THREE.DirectionalLight(0x8fd8ff, 1.8);
    rim.position.set(-5, 5, -8);
    S.add(rim);
    // floating islands: the big one under the podium and a few far away (one draw call)
    const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
    const parts = [];
    const main = islandGeometry(9, 7, { clearFront: true, trees: 30, treeScale: 0.7, grass: 0x4aa83e });
    main.translate(0, -PODIUM_H - 9 * 0.08 + 0.02, -3.2);
    parts.push(main);
    const far = [[-48, -6, -90, 12, 11], [62, -16, -130, 18, 23], [-130, -34, -230, 28, 31], [150, 4, -280, 22, 41], [10, 26, -420, 30, 53], [-260, 12, -380, 26, 61]];
    for (const [x, y, z, r, seed] of far) {
      const g = islandGeometry(r, seed);
      g.translate(x, y, z);
      parts.push(g);
    }
    this.islands = new THREE.Mesh(mergeGeometries(parts, false), islandMat);
    this.islands.matrixAutoUpdate = false;
    this.islands.updateMatrix();
    S.add(this.islands);
    // podium: base, glowing top, emissive rim
    const base = new THREE.Mesh(new THREE.CylinderGeometry(PODIUM_R, PODIUM_R + 0.35, PODIUM_H, 48), new THREE.MeshStandardMaterial({ color: 0x2b2370, roughness: 0.45, metalness: 0.3 }));
    base.position.y = -PODIUM_H / 2;
    S.add(base);
    const top = new THREE.Mesh(new THREE.CircleGeometry(PODIUM_R - 0.05, 48), new THREE.MeshBasicMaterial({ map: podiumTexture() }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.005;
    S.add(top);
    this.rimMat = new THREE.MeshBasicMaterial({ color: 0x7cf2ff, toneMapped: false });
    const rimMesh = new THREE.Mesh(new THREE.TorusGeometry(PODIUM_R, 0.07, 6, 72), this.rimMat);
    rimMesh.rotation.x = Math.PI / 2;
    rimMesh.position.y = 0.01;
    S.add(rimMesh);
    // blob shadows under the characters (one instanced draw call)
    this.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }), 4);
    this.blobs.count = 0;
    this.blobs.frustumCulled = false;
    S.add(this.blobs);
    // the battle bus floats past every ~20 s
    try {
      this.bus = new THREE.Mesh(busGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }));
      this.bus.visible = false;
      S.add(this.bus);
    } catch (e) { this.bus = null; }
    this.busT = 6; // the first pass comes soon after boot
  }

  show(on) {
    if (this.visible === on) return;
    this.visible = on;
    this.plates.classList.toggle('hidden', !on);
    if (on) this.resize();
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Party members on the stage. list: [{id, name, skin, lvl, ready, leader, me, away, color}] in
   * slot order (you first, then the leader, then the rest); extra = humans not shown (+N chip).
   */
  setParty(list, extra = 0) {
    const keep = new Set();
    list = list.slice(0, SLOT_X.length);
    list.forEach((p, i) => {
      keep.add(p.id);
      let m = this.members.get(p.id);
      if (m && m.skin !== p.skin) { this.removeMember(p.id); m = null; }
      if (!m) {
        m = this.addMember(p);
        m.drop = 1; // new arrivals drop onto the podium
        this.punch = 0.6; // and the camera pushes in a little
      }
      m.slot = i;
      m.info = p;
      const x = SLOT_X[i], z = -0.12 * x * x;
      m.tx = x; m.tz = z;
      if (m.x === undefined) { m.x = x; m.z = z; }
      this.updatePlate(m);
    });
    for (const id of [...this.members.keys()]) if (!keep.has(id)) this.removeMember(id);
    this.order = list.map((p) => p.id);
    this.extra = extra;
    this.more.classList.toggle('hidden', !(extra > 0));
    if (extra > 0) this.more.textContent = `+${extra}`;
  }

  addMember(p) {
    const c = new Character(SKINS[p.skin] ? p.skin : 0, '');
    c.setWeapon('pickaxe', 0);
    c.mesh.castShadow = false;
    this.scene.add(c.group);
    const plate = document.createElement('div');
    plate.className = 'plate';
    plate.dataset.id = String(p.id);
    plate.innerHTML = '<div class="pl-top"><span class="pl-crown">♛</span><span class="pl-lvl"></span></div><div class="pl-name"></div><div class="pl-ready"></div><i class="pl-bar"></i>';
    this.plates.appendChild(plate);
    const m = {
      id: p.id, skin: p.skin, c, plate, key: '', px: -1e4, py: -1e4,
      yaw: 0, yawT: 0, lookT: 1 + Math.random() * 3, twirlT: 4 + Math.random() * 6, emoteT: 0, drop: 0,
      el: {
        crown: plate.querySelector('.pl-crown'), lvl: plate.querySelector('.pl-lvl'), name: plate.querySelector('.pl-name'),
        ready: plate.querySelector('.pl-ready'), bar: plate.querySelector('.pl-bar'),
      },
    };
    this.members.set(p.id, m);
    return m;
  }

  removeMember(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.scene.remove(m.c.group);
    m.c.dispose();
    m.plate.remove();
    this.members.delete(id);
  }

  updatePlate(m) {
    const p = m.info;
    const key = `${p.name}|${p.lvl}|${p.leader}|${p.ready}|${p.me}|${p.away}|${p.color}|${p.inMatch}`;
    if (key === m.key) return;
    m.key = key;
    m.el.name.textContent = p.name;
    m.el.lvl.textContent = p.lvl > 1 ? `LV ${p.lvl}` : 'LV 1';
    m.el.crown.style.display = p.leader ? '' : 'none';
    m.el.ready.textContent = p.away ? 'RECONNECTING…' : p.inMatch ? 'IN MATCH' : p.leader ? 'LEADER' : p.ready ? '✓ READY' : '…';
    m.el.ready.className = `pl-ready${p.ready || p.leader ? ' ok' : ''}${p.away || p.inMatch ? ' away' : ''}`;
    m.el.bar.style.background = p.color || '#3ea4ff';
    m.plate.classList.toggle('me', !!p.me);
  }

  /** A party member's emote (the floss) for a few seconds. */
  emote(id) {
    const m = this.members.get(id);
    if (m) m.emoteT = 4.5;
  }

  /** Victory: these ids dance under '#1 PHICTORY ROYALE' (null ends it). */
  celebrate(ids) {
    this.celebrating = ids ? new Set(ids) : null;
    this.plates.classList.toggle('celebrate', !!ids);
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    if (this.sky.material.uniforms && this.sky.material.uniforms.uTime) this.sky.material.uniforms.uTime.value = t;
    this.rimMat.color.setHSL(0.52 + Math.sin(t * 0.8) * 0.04, 1, 0.62 + Math.sin(t * 2.2) * 0.08);
    // camera: frame the people on the stage (closer for one, wider for four; portrait backs off)
    const n = Math.max(1, this.order.length);
    let minX = 0, maxX = 0;
    for (const id of this.order) { const m = this.members.get(id); if (m) { minX = Math.min(minX, m.tx); maxX = Math.max(maxX, m.tx); } }
    const portrait = innerWidth < innerHeight;
    const span = maxX - minX + 1.4;
    const aspect = innerWidth / innerHeight;
    const tanH = Math.tan((25 * Math.PI) / 180) * aspect; // half the horizontal field of view
    // the lobby UI covers the left rail and the bottom right: people fill ~55% of the width
    let dist = Math.max(n === 1 ? 4.6 : 5.4, (span / 2) / (tanH * 0.55));
    if (portrait) dist = Math.max(dist * 1.15, (span / 2) / (tanH * 0.85));
    this.punch = Math.max(0, (this.punch || 0) - dt);
    dist -= Math.sin(Math.min(1, this.punch / 0.6) * Math.PI) * 0.25;
    const k = 1 - Math.exp(-dt * 2.5);
    this.camDist += (dist - this.camDist) * k;
    // shift the view so the squad sits right of centre on landscape screens (the party rail is left)
    const shift = portrait ? 0 : -tanH * this.camDist * 0.12;
    const cx = (minX + maxX) / 2 + shift;
    this.camX += (cx - this.camX) * k;
    // portrait: the squad sits lower, under the party list
    const cy = portrait ? 2.15 : 1.05;
    this.camY += (cy - this.camY) * k;
    const sway = Math.sin(t * 0.15) * 0.25;
    const cam = this.camera;
    cam.position.set(this.camX + sway, this.camY + 0.55 + this.camDist * 0.09, this.camDist);
    cam.lookAt(this.camX + sway * 0.6, this.camY, -0.4);
    // characters
    let blobs = 0;
    const W = innerWidth, H = innerHeight;
    for (const id of this.order) {
      const m = this.members.get(id);
      if (!m) continue;
      const celebrate = this.celebrating;
      const show = !celebrate || celebrate.has(id);
      if (show !== m.shown) {
        m.shown = show;
        m.c.setVisible(show);
        m.plate.style.display = show ? '' : 'none';
      }
      if (!show) continue;
      m.x += (m.tx - m.x) * k * 2;
      m.z += (m.tz - m.z) * k * 2;
      let y = 0;
      if (m.drop > 0) {
        m.drop = Math.max(0, m.drop - dt * 2.2);
        const f = 1 - m.drop;
        y = (1 - f * f) * 2.5; // falls in from above
      }
      // look around now and then; face the camera most of the time
      m.lookT -= dt;
      if (m.lookT <= 0) {
        m.lookT = 2 + Math.random() * 4;
        m.yawT = Math.random() < 0.45 ? 0 : (Math.random() - 0.5) * 1.1;
      }
      const face = Math.atan2(cam.position.x - m.x, cam.position.z - m.z);
      m.yaw += (m.yawT - m.yaw) * Math.min(1, dt * 2.5);
      m.c.group.position.set(m.x, y, m.z);
      m.c.group.rotation.y = face + m.yaw;
      m.twirlT -= dt;
      if (m.twirlT <= 0) { m.twirlT = 6 + Math.random() * 8; if (!m.emoteT && m.c.swing <= 0) m.c.playSwing(); }
      if (m.emoteT > 0) m.emoteT -= dt;
      const dance = celebrate || m.emoteT > 0;
      m.c.update(dt, {
        anim: dance ? ANIM.DANCE : ANIM.IDLE, speed: 0, moveAngle: 0, pitch: 0.06 + Math.sin(t * 0.6 + m.id) * 0.06,
        ads: false, gun: false, building: false, healing: false, reload: -1,
      });
      if (blobs < 4) {
        _m4.makeTranslation(m.x, 0.012, m.z);
        this.blobs.setMatrixAt(blobs++, _m4);
      }
      // nameplate over the head
      _v.set(m.x, y + 2.18, m.z).project(cam);
      const px = Math.round((_v.x * 0.5 + 0.5) * W), py = Math.round((-_v.y * 0.5 + 0.5) * H);
      if (px !== m.px || py !== m.py) {
        m.px = px; m.py = py;
        m.plate.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -100%)`;
      }
    }
    this.blobs.count = blobs;
    this.blobs.instanceMatrix.needsUpdate = true;
    if (this.extra > 0) {
      _v.set(3.1, 1.3, -1.15).project(cam);
      this.more.style.transform = `translate3d(${Math.round((_v.x * 0.5 + 0.5) * W)}px, ${Math.round((-_v.y * 0.5 + 0.5) * H)}px, 0) translate(-50%, -50%)`;
    }
    // the bus floats past behind the island
    if (this.bus) {
      this.busT -= dt;
      if (this.busT <= 0 && !this.bus.visible) { this.bus.visible = true; this.busX = -170; this.busT = 0; }
      if (this.bus.visible) {
        this.busX += dt * 14;
        this.bus.position.set(this.busX, 26 + Math.sin(t * 1.3) * 0.6, -95);
        this.bus.rotation.set(0, Math.PI / 2, Math.sin(t * 0.9) * 0.04);
        if (this.busX > 170) { this.bus.visible = false; this.busT = 8 + Math.random() * 6; }
      }
    }
  }

  render(renderer) {
    renderer.render(this.scene, this.camera);
  }

  /** Screen rectangle of a member's character (tests and the rename tap target). */
  memberIds() { return [...this.order]; }
}

const _m4 = new THREE.Matrix4();
