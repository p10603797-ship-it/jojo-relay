// Phortnite bootstrap: renderer, assets, world, menus, main loop, dynamic resolution.
import * as THREE from 'three';
import { SKINS, VERSION } from '../shared/constants.js';
import { getWorld } from '../shared/room.js';
import { Physics } from './physics.js';
import { buildTextures, spriteTextures } from './gfx/textures.js';
import { World } from './world/world.js';
import { Builds } from './world/builds.js';
import { Effects } from './gfx/effects.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { Hud } from './ui/hud.js';
import { Ui } from './ui/menu.js';
import { Character } from './actors/character.js';
import { Game } from './game/game.js';
import { WsNet, LocalNet } from './net/net.js';

const TIPS = [
  'Tip: build a wall the moment someone starts shooting at you.',
  'Tip: headshots deal extra damage — look for the yellow numbers.',
  'Tip: sniper bullets drop over distance. Aim a little high on far targets.',
  'Tip: golden chests always hold better loot. Listen for their shimmer!',
  'Tip: ramps + walls = height. Height wins fights.',
  'Tip: the storm hurts more every circle. Keep an eye on the timer.',
  'Tip: shield potions only top up to their cap — big shields go to 100.',
  'Tip: crouching while standing still makes your shots more accurate.',
];

const PRESETS = {
  low: { maxDpr: 1, shadows: false, shadowSize: 0, grass: 0, drawDist: 380, particles: 0.5, lights: false, aa: false },
  medium: { maxDpr: 1.35, shadows: true, shadowSize: 1024, grass: 64, drawDist: 520, particles: 0.8, lights: true, aa: true },
  high: { maxDpr: 1.75, shadows: true, shadowSize: 2048, grass: 96, drawDist: 720, particles: 1, lights: true, aa: true },
  ultra: { maxDpr: 2, shadows: true, shadowSize: 4096, grass: 128, drawDist: 900, particles: 1, lights: true, aa: true },
};

const DEFAULTS = {
  name: '', skin: 0, quality: 'auto', sens: 1, touchSens: 1, invertY: false, fov: 80, volume: 0.8,
  showFps: false, shake: true, forceTouch: false,
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('phortnite.settings') || '{}'); } catch (e) { s = {}; }
  const out = { ...DEFAULTS, ...s };
  if (!out.name) out.name = `Player${Math.floor(100 + Math.random() * 900)}`;
  return out;
}

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.settings = loadSettings();
    this.isTouch = navigator.maxTouchPoints > 1 && (matchMedia('(pointer: coarse)').matches || /iPad|iPhone|Android|Macintosh/.test(navigator.userAgent));
    this.game = null;
    this.shareHtml = '';
    this.frames = [];
    this.resScale = 1;
    this.slowT = 0;
    this.goodT = 0;
    this.fpsT = 0;
    this.fpsN = 0;
    this.fps = 0;
    this.menuT = 0;
  }

  saveSettings() {
    try { localStorage.setItem('phortnite.settings', JSON.stringify(this.settings)); } catch (e) { /* private mode */ }
  }

  quality() {
    let q = this.settings.quality;
    if (q === 'auto') q = this.isTouch ? 'medium' : 'high';
    return { name: q, ...PRESETS[q] };
  }

  progress(frac, text) {
    if (this.bootT0 === undefined) this.bootT0 = performance.now();
    if (text && text !== this.lastProgText) { console.log(`[boot] ${Math.round(performance.now() - this.bootT0)}ms ${text}`); this.lastProgText = text; }
    $('.load-fill').style.width = `${Math.round(frac * 100)}%`;
    if (text) $('.load-text').textContent = text;
  }

  async boot() {
    $('.load-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    const q = this.quality();
    this.q = q;
    const canvas = $('#game');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: q.aa, powerPreference: 'high-performance', stencil: false });
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;
    this.applyPixelRatio();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      $('#loading').style.display = 'flex';
      $('.load-text').textContent = 'Graphics were reset by the device — tap to reload';
      $('#loading').addEventListener('click', () => location.reload());
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.1, q.drawDist + 400);
    this.progress(0.05, 'Starting physics…');
    this.physics = await Physics.create();
    this.progress(0.1, 'Painting textures…');
    this.T = await buildTextures(renderer, (f) => this.progress(0.1 + f * 0.5, 'Painting textures…'), q.name === 'low');
    this.sprites = spriteTextures();
    this.progress(0.62, 'Raising the island…');
    await new Promise((r) => setTimeout(r, 0));
    const data = getWorld();
    this.progress(0.7, 'Planting trees & building houses…');
    await new Promise((r) => setTimeout(r, 0));
    this.world = new World({ scene: this.scene, physics: this.physics, T: this.T, data, quality: q, renderer });
    this.progress(0.86, 'Getting ready…');
    this.builds = new Builds(this.scene, this.physics, this.T, data, null);
    this.fx = new Effects(this.scene, this.physics, this.sprites, this.builds.mats, q);
    this.builds.fx = this.fx;
    this.input = new Input(canvas, $('#touch'), this.settings);
    this.input.forceTouch = this.settings.forceTouch;
    if (this.isTouch || this.settings.forceTouch) this.input.setTouchMode(true);
    this.input.onLockChange = (locked) => {
      if (!locked && this.game && this.game.wantsPause() && !this.input.touchMode && !this.ui.modalOpen()) this.ui.pauseModal();
    };
    this.sfx = new Sfx(this.settings);
    this.hud = new Hud(this.world);
    this.hud.onSlot = (i) => {
      const me = this.game && this.game.me;
      if (me && me.alive && (i === 0 || me.inv.slots[i])) me.select(i);
    };
    this.ui = new Ui(this);
    this.physics.step(1 / 60);

    // menu scene: your character on the mountain top looking over the island
    this.setupMenuScene(data);
    this.progress(0.93, 'Compiling shaders…');
    await new Promise((r) => setTimeout(r, 0));
    try { renderer.compile(this.scene, this.camera); } catch (e) { /* optional */ }
    this.progress(1, 'Ready!');
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.sfx.ctx) this.sfx.ctx.suspend();
      else if (!document.hidden && this.sfx.ctx) this.sfx.ctx.resume();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.game && this.input.touchMode && !this.ui.modalOpen()) this.ui.pauseModal();
    });
    // click on the canvas resumes pointer lock on desktop
    $('#game').addEventListener('click', () => { if (this.game && !this.input.touchMode && !this.input.locked && !this.ui.modalOpen()) this.input.requestLock(); });
    $('#loading').style.display = 'none';
    this.ui.showMenu(true);
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    window.__phortnite = this;
  }

  setupMenuScene(data) {
    const m = data.mountain;
    let best = { x: m.x, z: m.z, h: -1 };
    for (let i = 0; i < 300; i++) {
      const x = m.x + (Math.random() - 0.5) * 70, z = m.z + (Math.random() - 0.5) * 70;
      const h = data.heightAt(x, z);
      if (h > best.h) best = { x, z, h };
    }
    // step slightly toward the island centre so the view opens up
    const dl = Math.hypot(best.x, best.z) || 1;
    const dir = new THREE.Vector3(-best.x / dl, 0, -best.z / dl);
    const px = best.x + dir.x * 3, pz = best.z + dir.z * 3;
    this.menuPos = new THREE.Vector3(px, data.heightAt(px, pz), pz);
    this.menuDir = dir;
    this.setMenuSkin(this.settings.skin);
  }

  setMenuSkin(skin) {
    if (!this.scene || !this.menuPos) return;
    if (this.menuChar) { this.scene.remove(this.menuChar.group); this.menuChar.dispose(); }
    const c = new Character(skin, '');
    c.setWeapon('pickaxe', 0);
    c.group.position.copy(this.menuPos);
    // face the camera (camera sits on the far side, looking toward the island)
    c.group.rotation.y = Math.atan2(-this.menuDir.x, -this.menuDir.z);
    this.scene.add(c.group);
    this.menuChar = c;
    c.setVisible(!this.game);
  }

  updateMenu(dt) {
    this.menuT += dt;
    const c = this.menuChar;
    if (c) {
      c.update(dt, { anim: 0, speed: 0, pitch: 0.1 + Math.sin(this.menuT * 0.7) * 0.05, gun: false });
      if (Math.sin(this.menuT * 0.5) > 0.985 && c.swing <= 0) c.playSwing();
    }
    const p = this.menuPos, d = this.menuDir;
    const side = new THREE.Vector3(-d.z, 0, d.x);
    const sway = Math.sin(this.menuT * 0.15) * 0.6;
    const portrait = innerWidth < innerHeight;
    const cam = this.camera;
    // the character stands at p looking back at us; the island spreads out behind them
    cam.position.set(p.x - d.x * 4.6 + side.x * sway, p.y + 2.1, p.z - d.z * 4.6 + side.z * sway);
    const off = portrait ? 0 : 1.7;
    const look = new THREE.Vector3(p.x - side.x * off + d.x * 3, p.y + 0.9, p.z - side.z * off + d.z * 3);
    cam.lookAt(look);
    if (Math.abs(cam.fov - 55) > 0.1) { cam.fov = 55; cam.updateProjectionMatrix(); }
  }

  onResize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.applyPixelRatio();
  }

  applyPixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.maxDpr);
    this.renderer.setPixelRatio(Math.max(0.5, dpr * this.resScale));
  }

  applyQuality() {
    const q = this.quality();
    const prevShadows = this.q.shadows;
    this.q = q;
    Object.assign(this.world.quality, q);
    Object.assign(this.fx.quality, q);
    this.renderer.shadowMap.enabled = q.shadows;
    this.world.configureShadows(q);
    if (prevShadows !== q.shadows) this.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
    this.world.setGrass(q.grass);
    this.scene.fog.far = q.drawDist;
    this.camera.far = q.drawDist + 400;
    this.camera.updateProjectionMatrix();
    this.resScale = 1;
    this.applyPixelRatio();
  }

  // ------------------------------------------------------------------ sessions
  hello() {
    return { name: this.settings.name || 'Player', skin: this.settings.skin };
  }

  async playSolo() {
    if (this.game) return;
    const net = new LocalNet(this.hello());
    this.beginGame(net, true);
    await net.connect();
  }

  async connectServer() {
    if (this.serverNet && this.serverNet.open) return this.serverNet;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`;
    const net = new WsNet(url);
    await net.connect();
    this.serverNet = net;
    net.onClose = () => {
      this.serverNet = null;
      if (this.game && this.game.net === net) {
        this.leaveGame();
        this.ui.alert('Lost connection to the Phortnite server.');
      }
    };
    return net;
  }

  startOnlineGame(net, code) {
    this.beginGame(net, false);
    if (code) net.send({ t: 'join', code: String(code).trim().toUpperCase(), hello: this.hello() });
    else net.send({ t: 'create', hello: this.hello() });
    // surface join errors that arrive before the welcome
    const off = net.onMessage((m) => {
      if (m.t === 'welcome') off();
      if (m.t === 'err' && this.game && !this.game.me) {
        off();
        this.leaveGame();
        this.ui.alert(m.msg);
      }
    });
  }

  beginGame(net, solo) {
    this.ui.closeModal();
    this.ui.showMenu(false);
    if (this.menuChar) this.menuChar.setVisible(false);
    this.game = new Game(this, net, { solo, name: this.settings.name, skin: this.settings.skin });
    document.body.classList.add('ingame');
    this.resume();
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { this.wake = l; }).catch(() => {});
  }

  resume() {
    if (!this.input.touchMode) this.input.requestLock();
  }

  leaveGame() {
    if (!this.game) return;
    const g = this.game;
    this.game = null;
    if (g.net === this.serverNet) this.serverNet = null;
    g.dispose();
    this.input.exitLock();
    document.body.classList.remove('ingame');
    this.ui.showMenu(true);
    if (this.menuChar) this.menuChar.setVisible(true);
    if (this.wake) { this.wake.release().catch(() => {}); this.wake = null; }
  }

  // ------------------------------------------------------------------ loop
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(raw, 0.05);
    let focus;
    if (this.game) {
      // debug/test hook: run extra simulation steps per rendered frame
      for (let i = 1; i < (this.simSteps || 1); i++) this.game.update(1 / 60);
      this.game.update(this.simSteps ? 1 / 60 : dt);
      const me = this.game.me;
      focus = me && me.alive && !me.inBus ? me.pos : this.camera.position;
    } else {
      this.input.update();
      this.updateMenu(dt);
      focus = this.menuPos;
    }
    this.world.update(dt, this.camera, focus);
    this.fx.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.perf(raw, dt);
  }

  /** Track frame times and adapt the render resolution to hold the refresh rate. */
  perf(raw, dt) {
    const f = this.frames;
    f.push(raw * 1000);
    if (f.length > 90) f.shift();
    this.fpsN++;
    this.fpsT += raw;
    if (this.fpsT >= 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsT);
      this.fpsN = 0;
      this.fpsT = 0;
      if (this.settings.showFps) this.hud.fps(`${this.fps} FPS · ${Math.round(this.resScale * 100)}% res`);
    }
    if (f.length < 60 || document.hidden) return;
    const sorted = f.slice().sort((a, b) => a - b);
    const refresh = Math.max(4, sorted[Math.floor(sorted.length * 0.1)]);
    let slow = 0;
    for (let i = f.length - 30; i < f.length; i++) if (f[i] > refresh * 1.45 && f[i] < 250) slow++;
    if (slow >= 4) {
      this.slowT += dt;
      this.goodT = 0;
      if (this.slowT > 0.6 && this.resScale > 0.55) {
        this.resScale = Math.max(0.55, this.resScale - 0.08);
        this.applyPixelRatio();
        this.slowT = 0;
        this.frames.length = 0;
      }
    } else {
      this.slowT = 0;
      this.goodT += dt;
      if (this.goodT > 6 && this.resScale < 1) {
        this.resScale = Math.min(1, this.resScale + 0.05);
        this.applyPixelRatio();
        this.goodT = 0;
      }
    }
  }
}

const app = new App();
app.boot().catch((e) => {
  console.error(e);
  $('.load-text').textContent = `Could not start: ${e.message || e}. Try a newer browser (Safari 16+, Chrome, Edge, Firefox).`;
});
console.log(`PHORTNITE v${VERSION}`);
