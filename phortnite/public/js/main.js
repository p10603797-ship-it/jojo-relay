// Phortnite bootstrap: renderer, assets, world, the party lobby, main loop, dynamic resolution.
//
// The game opens in a party of one (a LocalNet room in this page) on the lobby stage. While in a
// party there is always exactly one Game; INVITE / JOIN swap the party's connection underneath the
// stage (enterParty), and losing a party drops you back into a party of one with a toast.
import * as THREE from 'three';
import { VERSION, PROTOCOL } from '../shared/constants.js';
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
import { prewarmCharacters } from './actors/character.js';
import { Game } from './game/game.js';
import { LocalNet } from './net/net.js';
import { applyGrade } from './gfx/grade.js';
import { LobbyStage } from './lobby/stage.js';
import { LobbyUi } from './ui/lobby.js';
import { Invite, keepSettings } from './ui/invite.js';
import { Profile } from './profile.js';
import { Music } from './music.js';

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
  low: { maxDpr: 1, shadows: false, shadowSize: 0, grass: 0, drawDist: 450, particles: 0.5, lights: false, aa: false },
  medium: { maxDpr: 1.35, shadows: true, shadowSize: 1024, grass: 64, drawDist: 520, particles: 0.8, lights: true, aa: true },
  high: { maxDpr: 1.75, shadows: true, shadowSize: 2048, grass: 96, drawDist: 720, particles: 1, lights: true, aa: true },
  ultra: { maxDpr: 2, shadows: true, shadowSize: 4096, grass: 128, drawDist: 900, particles: 1, lights: true, aa: true },
};

const DEFAULTS = {
  name: '', skin: 0, quality: 'auto', sens: 1, touchSens: 1, invertY: false, fov: 80, volume: 0.8,
  showFps: false, shake: true, forceTouch: false, autoFire: true, aimAssist: true,
  tapBuild: true, // touch: a tap on Wall / Floor / Ramp / Cone places the piece at once
  tbScale: 1, // touch button size (0.8-1.3)
  tbAlpha: 1, // touch button opacity (0.3-1)
  music: 0.5, // music volume (0-1)
  botLevel: 'normal', // default bot difficulty (a rules.botSkill option)
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('phortnite.settings') || '{}'); } catch (e) { s = {}; }
  const out = { ...DEFAULTS, ...s };
  if (!out.name) out.name = `Player${Math.floor(100 + Math.random() * 900)}`;
  return out;
}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RESUME_KEY = 'phortnite.resume';
const RESUME_MS = 60000; // the room holds a dropped player this long
const REJOIN_MS = 10 * 60000; // the REJOIN chip after a party ended or the connection was lost
// a Game being replaced must not close the connection it hands over to the next one
const NULL_NET = { kind: 'none', rtt: 0, send() {}, close() {}, onMessage() { return () => {}; } };
const inMatch = (g) => !!g && (g.phase === 'bus' || g.phase === 'match');

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
    this.stageOn = false; // the lobby stage is showing (rendered instead of the island)
    this.warming = false; // warm-up on the island from the lobby
    this.paused = false; // solo: the pause menu / an app switch stopped the match
    this.rejoinState = null;
    this.playAgainPending = false;
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
    applyGrade(renderer, q);
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
    this.applyFar();
    this.progress(0.86, 'Getting ready…');
    this.builds = new Builds(this.scene, this.physics, this.T, data, null);
    this.builds.grid.destroyedObjects = this.world.destroyedIds;
    this.fx = new Effects(this.scene, this.physics, this.sprites, this.builds.mats, q);
    this.builds.fx = this.fx;
    this.input = new Input(canvas, $('#touch'), this.settings);
    this.input.forceTouch = this.settings.forceTouch;
    if (this.isTouch || this.settings.forceTouch) this.input.setTouchMode(true);
    this.input.onLockChange = (locked) => {
      if (!locked && this.game && !this.stageOn && this.game.wantsPause() && !this.input.touchMode && !this.ui.modalOpen()) this.ui.pauseModal();
    };
    this.sfx = new Sfx(this.settings);
    this.hud = new Hud(this.world);
    this.hud.onSlot = (i) => {
      const me = this.game && this.game.me;
      if (me && me.alive && (i === 0 || me.inv.slots[i])) me.select(i);
    };
    this.ui = new Ui(this);
    this.physics.step(1 / 60);

    // the lobby: your party on a stage of its own, the lobby screen, invites, XP and music
    prewarmCharacters(); // build every skin's meshes in the background while the lobby is idle
    this.profile = new Profile();
    this.music = new Music(this.sfx, this.settings);
    this.stage = new LobbyStage(this);
    this.lobby = new LobbyUi(this);
    this.invite = new Invite(this);
    this.hud.lobbyPanel.onBack = () => this.warmUp(false);
    this.applyTouchVars();
    this.progress(0.93, 'Compiling shaders…');
    await new Promise((r) => setTimeout(r, 0));
    try { renderer.compile(this.scene, this.camera); } catch (e) { /* optional */ }
    try { renderer.compile(this.stage.scene, this.stage.camera); } catch (e) { /* optional */ }
    this.progress(1, 'Ready!');
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('pagehide', (e) => {
      if (e.persisted) return;
      // closing (or reloading) in the lobby: leave at once; mid-match a reload gets back in
      const g = this.game;
      if (g && g.phase === 'lobby' && g.net.kind !== 'solo') { g.net.send({ t: 'bye' }); this.saveResume(true); } else this.saveResume();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.game && !this.stageOn && this.input.touchMode && !this.ui.modalOpen()) this.ui.pauseModal();
    });
    // click on the canvas resumes pointer lock on desktop (never on the lobby stage)
    $('#game').addEventListener('click', () => { if (this.game && !this.stageOn && !this.input.touchMode && !this.input.locked && !this.ui.modalOpen()) this.input.requestLock(); });
    $('#loading').style.display = 'none';
    // a party of one; then an invite link (#join=CODE) or a party to get back into after a reload
    const back = this.loadResume(); // (read before the party of one clears it)
    this.enterParty(new LocalNet(this.hello()));
    this.showStage(true);
    const jm = /join=([A-Za-z]{4})/.exec(location.hash || '');
    if (jm) {
      history.replaceState(null, '', location.pathname + location.search);
      this.invite.join(jm[1].toUpperCase(), { fromLink: true, resume: back && back.code === jm[1].toUpperCase() ? back.token : undefined });
    } else if (back && (back.kind === 'server' || back.kind === 'p2p')) {
      this.invite.join(back.code, { kind: back.kind, resume: back.token, quiet: true });
    }
    setInterval(() => this.saveResume(), 5000);
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    window.__phortnite = this;
    // ?bench: the benchmark (js/bench.js) takes over from here
    if (new URLSearchParams(location.search).has('bench')) {
      import('./bench.js').then((m) => m.runBench && m.runBench(this)).catch((e) => console.error('bench', e));
    }
  }

  onResize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    if (this.stage) this.stage.resize();
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
    this.applyFar(true);
    this.resScale = 1;
    this.applyPixelRatio();
  }

  /**
   * Camera far plane: world.farFor(quality, camera) when the world has it (the view distance can
   * change with the camera, e.g. fog that reaches further from high up), else draw distance + 400 m.
   */
  applyFar(force = false) {
    const cam = this.camera;
    const far = this.world.farFor ? this.world.farFor(this.q, cam) : this.q.drawDist + 400;
    if (!force && Math.abs(far - cam.far) < 0.5) return;
    cam.far = far;
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ sessions
  /** What this page tells a party when it joins. extra: { resume, keep } to get back in. */
  hello(extra = {}) {
    return {
      name: this.settings.name || 'Player', skin: this.settings.skin, v: PROTOCOL,
      tier: this.isTouch ? 'ipad' : 'desktop', lvl: this.profile ? this.profile.level : 1,
      resume: '', // this page can rejoin after a dropped connection
      ...extra,
    };
  }

  /** 'solo' (party of one) | 'p2p-host' | 'p2p' | 'server'. */
  partyKind() { return (this.game && this.game.net && this.game.net.kind) || 'solo'; }

  wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`;
  }

  /**
   * Make net the party: one new Game on it, replacing the old one (the stage stays up, so INVITE
   * and JOIN swap the connection underneath). opts.replay: messages that arrived before (the
   * welcome); opts.off: their listener, removed once the Game listens itself.
   */
  enterParty(net, opts = {}) {
    const old = this.game;
    if (old) {
      if (old.net === net) old.net = NULL_NET;
      old.dispose();
    }
    this.paused = false;
    this.playAgainPending = false;
    // no stale 'Mia left' / 'THE BUS IS LEAVING!' from the last session
    if (this.hud.reset) this.hud.reset();
    else {
      const el = this.hud.el;
      this.hud.noticeTimer = 0;
      if (el.notice) el.notice.classList.remove('show');
      if (el.big) { el.big.classList.remove('show'); el.big.innerHTML = ''; }
    }
    this.shareHtml = '';
    // a 3-2-1 from the party we are leaving would lock PLAY in the next one (before the replay:
    // a joiner's welcome may start the new party's countdown)
    if (this.lobby) this.lobby.resetCountdown();
    const game = new Game(this, net, { solo: net.kind === 'solo', name: this.settings.name, skin: this.settings.skin });
    this.game = game;
    document.body.classList.add('ingame');
    document.body.classList.remove('ended', 'dead', 'inbus');
    if (opts.off) opts.off();
    // (a handler may swap the party again while replaying, e.g. a version mismatch)
    if (opts.replay) for (const m of opts.replay) { if (game.disposed) break; game.onMessage(m); }
    if (game.disposed) return this.game;
    if (net.kind !== 'solo') net.onClose = (msg) => this.onPartyLost(net, msg);
    if (net.kind === 'solo') {
      this.saveResume(true);
      net.connect();
    }
    this.updateWake();
    if (this.lobby) this.lobby.render();
    return game;
  }

  /** A party of one again (after leaving, a kick, or a lost party), keeping the mode you had picked. */
  soloParty() {
    const g = this.game;
    const keep = g && g.settingsState && g.settingsState.modeId ? keepSettings(g.settingsState) : null;
    this.enterParty(new LocalNet(this.hello(), { settings: keep }));
    if (!this.warming) this.showStage(true);
  }

  /** The party's welcome (or 'resumed'): remember how to get back in. */
  onWelcome(g, m) {
    const net = g.net;
    if (m.t === 'welcome' && m.leader === m.you && m.phase === 'lobby' && this.settings.botLevel && this.settings.botLevel !== 'normal') this.tweakBots();
    if (!net || net.kind === 'solo' || !m.resume) return;
    this.resumeInfo = { kind: net.kind, code: m.code, token: m.resume, name: m.name || '' };
    this.saveResume();
    if (net.kind === 'server' || net.kind === 'p2p') {
      const code = m.code, token = m.resume;
      // keep: which match / phase this page's game is in and whether I am alive there, so the room
      // sends a full welcome (a rebuilt game) when the match started or I respawned while away
      net.rejoin = () => {
        const cur = this.game && this.game.net === net ? this.game : null;
        const keep = cur ? { match: cur.match | 0, live: cur.phase !== 'lobby', alive: !!(cur.me && cur.me.alive) } : true;
        return { t: 'join', code, hello: this.hello({ resume: token, keep }) };
      };
    }
    if (this.rejoinState && this.rejoinState.code === m.code) this.rejoinState = null;
  }

  /** The default bot difficulty setting, for a party this page leads (the mode engine's 'tweak'). */
  tweakBots() {
    const g = this.game;
    if (g && g.leader === g.myId && g.phase === 'lobby' && this.settings.botLevel) g.send({ t: 'tweak', botSkill: this.settings.botLevel });
  }

  /** Touch button size / opacity settings as CSS variables (the touch layout reads them). */
  applyTouchVars() {
    const r = document.documentElement.style;
    r.setProperty('--tb-scale', String(this.settings.tbScale ?? 1));
    r.setProperty('--tb-alpha', String(this.settings.tbAlpha ?? 1));
  }

  saveResume(clear = false) {
    try {
      const g = this.game;
      if (clear || !g || g.net.kind === 'solo' || !this.resumeInfo || this.resumeInfo.code !== g.code) {
        if (clear) sessionStorage.removeItem(RESUME_KEY);
        return;
      }
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...this.resumeInfo, t: Date.now() }));
    } catch (e) { /* private mode */ }
  }

  loadResume() {
    try {
      const r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
      if (r && typeof r.code === 'string' && /^[A-Z]{4}$/.test(r.code) && typeof r.token === 'string' && Date.now() - r.t < RESUME_MS) return r;
    } catch (e) { /* none */ }
    return null;
  }

  rejoinInfo() {
    const r = this.rejoinState;
    if (!r || Date.now() > r.until) return null;
    if (this.game && this.partyKind() !== 'solo' && this.game.code === r.code) return null;
    return r;
  }

  setRejoin(kind, code, host) {
    if (!code || !/^[A-Z]{4}$/.test(code)) return;
    this.rejoinState = { kind, code, until: Date.now() + REJOIN_MS, label: `↩ REJOIN ${host ? `${host.toUpperCase()}'S PARTY` : code}` };
  }

  rejoin() {
    const r = this.rejoinInfo();
    if (!r) return;
    const back = this.loadResume();
    this.invite.join(r.code, { kind: r.kind === 'server' ? 'server' : 'p2p', fromLink: true, resume: back && back.code === r.code ? back.token : undefined });
  }

  /** The party's host (a P2P party names its host even after the crown moved), else its leader. */
  hostName(g) {
    const host = g && g.partyInfo && g.partyInfo.host;
    const row = g && (g.roster.get(host) || g.roster.get(g.leader));
    return row ? row.name : '';
  }

  /**
   * Run fn after the message being handled now (never swap the Game inside one of its own
   * handlers: the old one would keep handling the message, and the new one would see it too).
   * Skipped if the party changed in the meantime.
   */
  later(g, fn) {
    setTimeout(() => { if (this.game === g && !g.disposed) fn(); }, 0);
  }

  /** The connection gave up (after trying to get back in). */
  onPartyLost(net, msg) {
    const g = this.game;
    if (!g || g.net !== net) return;
    this.later(g, () => {
      const code = g.code, kind = net.kind, host = this.hostName(g);
      this.soloParty();
      this.lobby.netStatus('');
      if (kind === 'p2p') this.lobby.toast(`${esc(host || 'The host')}'s party ended`, { kind: 'bad', ms: 6000 });
      else this.lobby.toast(msg && msg.msg ? esc(msg.msg) : 'Lost connection to the party', { kind: 'bad', ms: 6000 });
      this.setRejoin(kind, code, kind === 'p2p' ? host : '');
      this.lobby.render();
    });
  }

  onKicked(g, m) {
    if (g !== this.game) return;
    this.later(g, () => {
      this.saveResume(true);
      this.soloParty();
      this.lobby.toast(esc(m.msg || 'You were removed from the party.'), { kind: 'bad', ms: 6000 });
    });
  }

  /** The P2P host closed the party. */
  onPartyEnd(g, m) {
    if (g !== this.game) return;
    this.later(g, () => {
      const code = g.code, host = this.hostName(g);
      this.saveResume(true);
      this.soloParty();
      this.lobby.toast(esc(m.msg || `${host || 'The host'}'s party ended`), { kind: 'bad', ms: 6000 });
      this.setRejoin('p2p', code, host);
      this.lobby.render();
    });
  }

  /** Transport events ('_net'): the status pill, and starting over when the party let us go. */
  onNet(g, m) {
    if (g !== this.game) return;
    const kind = g.net.kind;
    if (m.state === 'reconnecting') this.lobby.netStatus('Connection lost — getting you back in…');
    else if (m.state === 'stall') this.lobby.netStatus(kind === 'p2p' ? 'Waiting for the host…' : 'Waiting for the server…');
    else if (m.state === 'online' || m.state === 'lost') this.lobby.netStatus('');
    else if (m.state === 'fresh' && m.msg) {
      // back, but the party had let us go (a drop in the lobby, or away too long): a new Game
      // with this welcome; keep what arrives until it takes over
      const net = g.net, w = m.msg, buf = [];
      const off = net.onMessage((x) => { if (x.t !== '_net') buf.push(x); });
      this.lobby.netStatus('');
      this.later(g, () => {
        this.enterParty(net, { replay: [w, ...buf], off });
        // still in the match (it started, or I respawned, while I was away): revive() says 'Back in the game!'
        if (w.resumed && w.me && w.me.alive && w.phase !== 'lobby') return;
        this.lobby.toast(w.phase === 'lobby' ? 'Reconnected! 👍' : 'You were away too long: watching until the next match.', { ms: 5000 });
      });
      setTimeout(off, 1000); // in case the party changed meanwhile
    }
  }

  /** LEAVE PARTY: back to a party of one. */
  leaveParty() {
    if (this.partyKind() === 'solo') return;
    const host = this.partyKind() === 'p2p-host';
    this.saveResume(true);
    this.soloParty();
    this.lobby.toast(host ? 'You closed your party.' : 'You left the party.');
  }

  /** Test / harness hook (and older call sites): be in a party of one, warming up on the island. */
  async playSolo() {
    if (this.partyKind() !== 'solo') this.soloParty();
    for (let i = 0; i < 200 && !(this.game && this.game.me); i++) await new Promise((r) => setTimeout(r, 10));
    if (this.game && this.game.phase === 'lobby') this.warmUp(true);
  }

  /** Kept for older call sites: leaving = back to a party of one. */
  leaveGame() { if (this.partyKind() === 'solo') this.backToLobby(); else this.leaveParty(); }

  // ------------------------------------------------------------------ lobby actions
  /** The stage instead of the island (the lobby), or the island (match, warm-up, spectating). */
  showStage(on) {
    if (!this.stage) return;
    this.stageOn = on;
    // the match goes on behind the stage (BACK TO LOBBY): its sounds don't
    if (this.sfx && this.sfx.setGame) this.sfx.setGame(on ? 0 : 1);
    this.stage.show(on);
    this.lobby.show(on);
    if (this.music) this.music.lobby(on);
    if (on) this.input.exitLock();
    else this.resume();
    this.updateWake();
  }

  /** The leader's PLAY: 3, 2, 1 for everyone, then the bus. */
  play() {
    const g = this.game;
    if (!g || g.phase !== 'lobby' || g.leader !== g.myId) return;
    g.send({ t: 'start', cd: 1 });
  }

  /** WARM UP: today's warm-up island, with a BACK TO LOBBY chip. */
  warmUp(on) {
    const g = this.game;
    if (on) {
      if (!g || g.phase !== 'lobby' || !g.me) return;
      this.warming = true;
      if (!g.me.alive) g.spawnWarmup();
      // no banners, notices or kill counts from the last match on the warm-up island
      if (this.hud.reset) this.hud.reset();
      g.kills = 0;
      this.showStage(false);
      this.lobby.toast('Warm-up! Unlimited ammo and materials. Tap <b>↩ LOBBY</b> to go back.', { ms: 4000 });
    } else {
      this.warming = false;
      this.showStage(true);
    }
  }

  /** BACK TO LOBBY from the death card: wait with friends on the stage (the match goes on). */
  backToLobby() {
    const g = this.game;
    if (!g) return;
    // solo: nobody to wait for, so end the match
    if (g.solo && g.phase !== 'lobby') g.send({ t: 'end' });
    this.showStage(true);
  }

  /** SPECTATE from the lobby banner: watch the match on the island. */
  spectate() {
    const g = this.game;
    if (!g || !inMatch(g)) return;
    this.showStage(false);
    if (!g.me || !g.me.alive) {
      this.hud.elim({ spectating: true, sub: 'Spectating — NEXT PLAYER (or fire / click) to switch', leave: true, again: g.solo });
    }
  }

  emote() {
    const g = this.game;
    if (!g || g.phase !== 'lobby') return;
    g.send({ t: 'emote', e: 1 });
    this.stage.emote(g.myId);
  }

  /** Solo pause (pause menu, app switch): the room's clock and this page's simulation stop. */
  pauseSolo() {
    const g = this.game;
    if (!g || g.net.kind !== 'solo' || this.stageOn) return;
    g.net.pause();
    this.paused = true;
  }

  unpause() {
    const g = this.game;
    this.paused = false;
    if (!g || !g.net.resume) return;
    const d = g.net.resume();
    // the bus is predicted from this page's clock: it waited too
    if (d > 0 && g.bus && g.bus.path && typeof g.bus.t0 === 'number') g.bus.t0 += d;
    this.last = performance.now();
  }

  onVisibility() {
    const g = this.game;
    if (document.hidden) {
      if (this.sfx.ctx) this.sfx.ctx.suspend();
      // solo always waits for you; a P2P host's party waits during a match (instead of ending)
      if (g && g.net.pause && (g.net.kind === 'solo' || inMatch(g))) {
        g.net.pause();
        this.hiddenPause = true;
      }
      this.saveResume();
    } else {
      if (this.sfx.ctx) this.sfx.ctx.resume();
      this.last = performance.now();
      if (this.input.resetToggles) this.input.resetToggles();
      if (this.hiddenPause) {
        this.hiddenPause = false;
        if (g && g.net.kind === 'solo' && inMatch(g) && !this.stageOn && !this.ui.modalOpen()) {
          // solo: stay paused until RESUME
          this.paused = true;
          this.ui.pauseModal();
        } else if (!this.paused) this.unpause();
      }
      this.updateWake();
    }
  }

  /** Keep the screen awake in a party with friends or during a match (asked again on every return). */
  updateWake() {
    const g = this.game;
    const want = !document.hidden && !!g && (this.partyKind() !== 'solo' || g.phase !== 'lobby');
    if (want && !this.wake && !this.wakeAsk && navigator.wakeLock) {
      this.wakeAsk = true;
      navigator.wakeLock.request('screen').then((l) => {
        this.wakeAsk = false;
        this.wake = l;
        l.addEventListener('release', () => { if (this.wake === l) this.wake = null; });
      }).catch(() => { this.wakeAsk = false; });
    } else if (!want && this.wake) {
      this.wake.release().catch(() => {});
      this.wake = null;
    }
  }

  resume() {
    if (!this.input.touchMode && !this.stageOn) this.input.requestLock();
  }

  // ------------------------------------------------------------------ loop
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.max(0, Math.min(raw, 0.05)); // never negative (e.g. a timestamp from before a pause)
    const g = this.game;
    const stage = this.stageOn;
    // the lobby on the stage has nothing to simulate; a match goes on behind it (bots owned here)
    const sim = !!g && !this.paused && !(stage && (g.phase === 'lobby' || !g.me));
    if (sim) {
      // debug/test hook: run extra simulation steps per rendered frame
      for (let i = 1; i < (this.simSteps || 1); i++) g.update(1 / 60);
      g.update(this.simSteps ? 1 / 60 : dt);
    } else {
      this.input.update();
      this.hud.update(dt); // notices time out behind the stage too (no stale 'Sam joined' in the next match)
    }
    if (stage) {
      if (sim) {
        const me = g.me;
        this.world.update(dt, this.camera, me && me.alive && !me.inBus ? me.pos : this.camera.position, g);
        this.fx.update(dt);
      }
      this.stage.update(dt);
      this.stage.render(this.renderer);
    } else {
      const me = g && g.me;
      const focus = me && me.alive && !me.inBus ? me.pos : this.camera.position;
      this.world.update(dt, this.camera, focus, g);
      if (this.world.farFor) this.applyFar();
      this.fx.update(dt);
      this.renderer.render(this.scene, this.camera);
    }
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
