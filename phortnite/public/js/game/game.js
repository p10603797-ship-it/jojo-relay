// A game session: one connection to a room (solo or LAN). Owns the local player, bots,
// remote players, loot, storm, bus, combat resolution and the third-person camera.
import * as THREE from 'three';
import {
  WEAPONS, HEALS, PLAYER, ANIM, SEND_HZ, SKINS, BUILD, MAT_KEYS, weaponDamage, itemKind,
} from '../../shared/constants.js';
import { LocalPlayer } from '../actors/localPlayer.js';
import { Bot } from '../actors/bot.js';
import { RemotePlayer } from '../actors/remote.js';
import { forwardFromAngles } from '../actors/combatant.js';
import { Ballistics, raySphere, rayCapsule } from '../combat/ballistics.js';
import { LootView, StormView, BusView } from './views.js';
import { RAY_SOLID } from '../physics.js';
import { lootLabel } from '../ui/hud.js';

const WARMUP = {
  slots: [{ k: 'ar', r: 2, m: 30 }, { k: 'shotgun', r: 2, m: 5 }, { k: 'smg', r: 2, m: 30 }, { k: 'sniper', r: 3, m: 1 }, { k: 'rocket', r: 3, m: 1 }],
  ammo: {}, mats: { wood: 999, stone: 999, metal: 999 },
};

// Auto-shoot (a setting): farthest (m from the gun) an enemy may be for each gun to fire on its
// own, so a shotgun doesn't waste shells on someone across the map. Bullet drop is checked too.
const AUTO_RANGE = { ar: 220, smg: 90, pistol: 90, shotgun: 30, sniper: 250, rocket: 90 };
// closest: a point-blank rocket would level the player's own walls and floor
const AUTO_MIN = { rocket: 12 };
const AUTO_ACQUIRE = 0.06; // s the crosshair must rest on an enemy before firing (like a human reaction)
const AUTO_GRACE = 0.1; // s to keep firing when tracking slips off the target for a moment
const GRAVITY = 9.81;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _f = new THREE.Vector3();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Aim assist (a setting, touch + controller only): angles in rad, rates in rad/s.
const AA = {
  range: 120, rangeScoped: 200, // m: farthest enemy that is assisted (a scoped sniper reaches further, weakly)
  bubble: 1.12, // m around the chest (body radius 0.37 + margin) where the look slows down
  coneMin: 0.02, coneMax: 0.16, // that bubble as an angle: ~1.2° far away .. ~9° up close
  pullCone: 1.5, // tracking reaches this many bubbles out
  slowAds: 0.55, slowHip: 0.65, // look sensitivity at the bubble's centre
  pull: 0.18, // ~10°/s toward the chest while aiming down sights (half when hip firing)
  follow: 0.5, // share of the target's angular motion the view follows
  chest: 0.15, // m around the chest point with no pull, so it never feels locked on
  snapCone: 0.157, snapRange: 80, snapTime: 0.12, // ADS snap: within ~9°, 80 m, takes 0.12 s
  swipeLo: 0.6, swipeHi: 3, // look input: full assist below, none above (half as much when swiping away)
  losEvery: 0.2, losRays: 3, // re-check line of sight 5x a second per target, at most 3 checks a frame
};
const aaWrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
const aaClamp = (v, m) => (v > m ? m : v < -m ? -m : v);

export class Game {
  constructor(app, net, opts) {
    this.app = app;
    this.net = net;
    this.opts = opts;
    this.scene = app.scene;
    this.camera = app.camera;
    this.physics = app.physics;
    this.world = app.world;
    this.builds = app.builds;
    this.fx = app.fx;
    this.sfx = app.sfx;
    this.input = app.input;
    this.hud = app.hud;
    this.settings = app.settings;
    this.myId = 0;
    this.me = null;
    this.leader = 0;
    this.phase = 'lobby';
    this.roster = new Map();
    this.remotes = new Map();
    this.bots = new Map();
    this.loot = new LootView(this.scene);
    this.storm = new StormView(this.scene, app.T.noise.map);
    this.bus = new BusView(this.scene);
    this.ballistics = new Ballistics(this.physics, this.fx, {
      targets: () => this.hitboxes,
      onHit: (b, h) => this.onBulletHit(b, h),
      onExpire: (b) => this.resolvePellet(b),
    });
    const rg = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8);
    rg.rotateX(Math.PI / 2);
    this.ballistics.setScene(this.scene, rg, new THREE.MeshStandardMaterial({ color: 0x9fd25a, emissive: 0x334411, roughness: 0.4 }));
    this.hitboxes = [];
    this.pendingShots = new Map();
    this.pendingBuilds = new Map();
    this.sendT = 0;
    this.time = 0;
    this.shakeK = 0;
    this.camDist = 3.2;
    this.camRight = 0.62;
    this.curFov = this.settings.fov;
    this.spectateId = 0;
    this.specYaw = 0;
    this.specPitch = -0.2;
    this.settingsState = { bots: 8, mats: 0 };
    this.kills = 0;
    this.aliveCount = 1;
    this.hurtK = 0;
    this.code = '';
    this.solo = !!opts.solo;
    this.autoRestart = false;
    this.lastPoi = '';
    this.aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1, tx: 0, ty: 0, tz: 0, target: 0 };
    this.autoOn = 0;
    this.autoOff = 0;
    this.autoLock = false;
    this.autoItem = null;
    this.autoCtl = {};
    this.unsub = net.onMessage((m) => this.onMessage(m));
    this.disposed = false;
  }

  // ------------------------------------------------------------------ helpers
  actors() {
    const out = [];
    if (this.me) out.push(this.me);
    for (const b of this.bots.values()) out.push(b);
    for (const r of this.remotes.values()) out.push(r);
    return out;
  }

  actorById(id) {
    if (this.me && id === this.me.id) return this.me;
    return this.bots.get(id) || this.remotes.get(id) || null;
  }

  nameOf(id) {
    const r = this.roster.get(id);
    return r ? r.name : id === 0 ? 'The Storm' : '???';
  }

  /** Characters further than this are not animated or drawn (they'd be fogged out anyway). */
  isFar(pos) {
    const c = this.camera.position;
    const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
    const lim = Math.min(260, this.settings.drawDistLimit || 260);
    return dx * dx + dy * dy + dz * dz > lim * lim;
  }

  isMine(id) { return (this.me && id === this.me.id) || this.bots.has(id); }

  teamOf(id) {
    const r = this.roster.get(id);
    return r && r.team !== undefined ? r.team : id;
  }

  /** Teammates (squad mode) can't hurt each other and see each other's names. */
  friendly(a, b) { return a !== b && this.phase !== 'lobby' && this.teamOf(a) === this.teamOf(b); }

  send(msg) { this.net.send(msg); }

  shake(k) { this.shakeK = Math.min(1.2, this.shakeK + k); }

  // ------------------------------------------------------------------ network
  onMessage(m) {
    if (this.disposed) return;
    const name = { 'b+': 'bAdd', 'b-': 'bDel', 'l+': 'lAdd', 'l-': 'lDel' }[m.t] || m.t;
    const h = this[`on_${name}`];
    if (h) {
      try { h.call(this, m); } catch (e) { console.error('message', m.t, e); }
    }
  }

  on_welcome(m) {
    this.myId = m.you;
    this.leader = m.leader;
    this.phase = m.phase;
    this.code = m.code;
    this.solo = m.solo;
    this.settingsState = m.settings;
    if (m.checksum !== this.world.data.checksum) console.warn('World checksum mismatch — client and server versions differ');
    for (const p of m.players) this.roster.set(p.id, p);
    const info = this.roster.get(m.you) || { name: this.opts.name, skin: this.opts.skin };
    this.me = new LocalPlayer(this, m.you, info.name, info.skin);
    this.world.restoreAll();
    for (const id of m.destroyed) this.world.destroyObject(id, null, true);
    this.builds.clear();
    for (const b of m.builds) this.builds.add(b);
    this.loot.set(m.loot);
    for (const c of m.chests) this.world.setChestOpen(c, true);
    for (const p of m.players) if (p.id !== m.you) this.ensureRemote(p);
    if (m.phase === 'lobby') {
      this.spawnWarmup();
    } else {
      this.me.alive = false;
      this.me.mover.setEnabled(false);
      this.me.mover.mode = 'dead';
      this.me.char.setVisible(false);
      if (m.bus) this.bus.start(m.bus);
      this.hud.elim({ spectating: true, sub: 'A match is in progress — you will join the next round. Spectating…', leave: true });
    }
    this.hud.show(true);
    this.updateLobby();
    this.input.enabled = true;
  }

  ensureRemote(p) {
    if (p.id === this.myId || this.bots.has(p.id)) return null;
    let r = this.remotes.get(p.id);
    if (!r) {
      r = new RemotePlayer(this, p);
      this.remotes.set(p.id, r);
      r.setNameVisible(this.phase === 'lobby' || !p.bot);
      if (p.alive === false && this.phase !== 'lobby') { r.dead = true; r.alive = false; r.char.setVisible(false); }
    }
    return r;
  }

  on_roster(m) {
    this.leader = m.leader;
    const ids = new Set(m.players.map((p) => p.id));
    for (const p of m.players) {
      this.roster.set(p.id, { ...(this.roster.get(p.id) || {}), ...p });
      this.ensureRemote(p);
    }
    for (const id of [...this.roster.keys()]) {
      if (!ids.has(id)) {
        this.roster.delete(id);
        const r = this.remotes.get(id);
        if (r) { r.dispose(); this.remotes.delete(id); }
      }
    }
    this.updateLobby();
  }

  on_note(m) { this.hud.notice(m.msg, !!m.storm); }

  on_settings(m) {
    this.settingsState = m.settings;
    this.updateLobby();
  }

  on_err(m) {
    if (this.me) this.app.ui.alert(m.msg || 'Something went wrong');
  }

  resetWorld() {
    this.world.restoreAll();
    this.builds.clear();
    this.fx.clear();
    this.ballistics.clear();
    this.pendingShots.clear();
    this.pendingBuilds.clear();
  }

  on_start(m) {
    this.phase = 'bus';
    this.leader = m.leader;
    this.settingsState = m.settings;
    this.resetWorld();
    this.loot.set(m.loot);
    for (const b of this.bots.values()) b.dispose();
    this.bots.clear();
    const ids = new Set(m.players.map((p) => p.id));
    for (const [id, r] of this.remotes) {
      if (!ids.has(id)) { r.dispose(); this.remotes.delete(id); }
    }
    this.roster.clear();
    for (const p of m.players) this.roster.set(p.id, p);
    for (const p of m.players) {
      if (p.id !== this.myId) {
        const r = this.ensureRemote(p);
        if (r) { r.revive(); r.buf.length = 0; r.hasState = false; r.setNameVisible(!p.bot && p.team === this.teamOf(this.myId)); }
      }
    }
    const me = this.me;
    me.char.endRagdoll();
    me.alive = true;
    me.hp = PLAYER.maxHp;
    me.sh = 0;
    me.infinite = false;
    const mats = this.settingsState.mats | 0;
    me.resetInventory({ slots: [], ammo: {}, mats: { wood: mats, stone: mats, metal: mats } });
    me.inBus = true;
    me.mover.mode = 'bus';
    me.mover.setEnabled(false);
    me.char.setVisible(false);
    this.input.resetToggles();
    this.bus.start(m.bus);
    this.storm.clear();
    this.kills = 0;
    this.spectateId = 0;
    this.lastElim = null;
    this.hud.elim(null);
    this.hud.lobby(null);
    this.hud.big('THE BUS IS LEAVING!<small>Jump out when you\'re over a good spot</small>');
    this.sfx.ui('bus');
    document.body.classList.remove('dead');
  }

  on_bots(m) {
    const own = new Set(m.own);
    for (const id of own) {
      if (this.bots.has(id)) continue;
      const info = this.roster.get(id) || { id, name: 'Bot', skin: 0, bot: true };
      const bot = new Bot(this, info);
      const r = this.remotes.get(id);
      const last = r && r.latest();
      if (r) { r.dispose(); this.remotes.delete(id); }
      if (this.phase === 'bus' && (!last || last.a === ANIM.BUS)) {
        bot.inBus = true;
        bot.mover.mode = 'bus';
        bot.mover.setEnabled(false);
        bot.char.setVisible(false);
        const b = this.bus.path;
        const len = b ? Math.hypot(b.bx - b.ax, b.bz - b.az) / b.speed : 20;
        bot.brain.dropAt = len * (0.12 + Math.random() * 0.68);
      } else if (last) {
        bot.mover.teleport(last.x, last.y, last.z);
        bot.mover.mode = last.a === ANIM.SKYDIVE ? 'skydive' : last.a === ANIM.GLIDE ? 'glide' : 'air';
        bot.hp = r.hp;
        bot.sh = r.sh;
        if (last.a === ANIM.DEAD || info.alive === false) { bot.alive = false; bot.char.setVisible(false); bot.mover.setEnabled(false); bot.mover.mode = 'dead'; }
      }
      this.bots.set(id, bot);
    }
    for (const [id, bot] of this.bots) {
      if (own.has(id)) continue;
      const info = this.roster.get(id);
      bot.dispose();
      this.bots.delete(id);
      if (info) this.ensureRemote(info);
    }
  }

  on_lobby(m) {
    this.phase = 'lobby';
    this.leader = m.leader;
    this.settingsState = m.settings;
    for (const b of this.bots.values()) b.dispose();
    this.bots.clear();
    this.roster.clear();
    for (const p of m.players) this.roster.set(p.id, p);
    for (const [id, r] of this.remotes) {
      if (!this.roster.has(id) || r.isBot) { r.dispose(); this.remotes.delete(id); } else { r.revive(); r.setNameVisible(true); }
    }
    for (const p of m.players) if (p.id !== this.myId) this.ensureRemote(p);
    this.resetWorld();
    this.loot.clear();
    this.storm.clear();
    this.bus.stop();
    this.spawnWarmup();
    this.hud.elim(null);
    this.spectateId = 0;
    this.lastElim = null;
    document.body.classList.remove('dead', 'inbus');
    this.updateLobby();
    if (this.autoRestart) {
      this.autoRestart = false;
      this.send({ t: 'start', bots: this.settingsState.bots, mats: this.settingsState.mats, mode: this.settingsState.mode });
    }
  }

  spawnWarmup() {
    const sp = this.world.data.spawns[Math.floor(Math.random() * this.world.data.spawns.length)] || { x: 0, z: 0 };
    const me = this.me;
    me.inBus = false;
    me.respawn(sp.x, this.world.data.heightAt(sp.x, sp.z) + 0.3, sp.z);
    me.mover.mode = 'ground';
    me.infinite = true;
    me.resetInventory(WARMUP);
    me.select(1);
    me.yaw = Math.random() * Math.PI * 2;
    me.pitch = -0.05;
    this.input.resetToggles();
  }

  on_s(m) {
    if (m.phase !== this.phase && m.phase === 'match' && this.phase === 'bus') this.phase = 'match';
    if (this.phase !== 'bus' && this.phase !== 'lobby') this.bus.stop();
    const now = performance.now();
    for (const row of m.p) {
      const id = row[0];
      if (this.me && id === this.myId) {
        this.me.hp = row[9];
        this.me.sh = row[10];
        continue;
      }
      const bot = this.bots.get(id);
      if (bot) { bot.hp = row[9]; bot.sh = row[10]; continue; }
      let r = this.remotes.get(id);
      if (!r) {
        const info = this.roster.get(id);
        if (!info) continue;
        r = this.ensureRemote(info);
        if (!r) continue;
      }
      r.push(row, now);
    }
    this.storm.set(m.st);
    if (m.bus) this.bus.correct(m.bus);
    this.aliveCount = m.alive;
  }

  on_sh(m) {
    const shooter = this.remotes.get(m.id);
    const w = WEAPONS[m.w];
    if (!w || !Array.isArray(m.o) || !Array.isArray(m.d)) return;
    const muzzle = shooter ? shooter.char.muzzleWorld(_v) : _v.set(m.o[0], m.o[1], m.o[2]);
    for (let i = 0; i + 2 < m.d.length; i += 3) {
      this.ballistics.fire({
        ox: m.o[0], oy: m.o[1], oz: m.o[2], dx: m.d[i], dy: m.d[i + 1], dz: m.d[i + 2], speed: w.speed, grav: w.grav,
        owner: m.id, team: this.phase === 'lobby' ? m.id : this.teamOf(m.id), w: m.w, r: m.r, auth: false, rocket: w.projectile === 'rocket', visX: muzzle.x, visY: muzzle.y, visZ: muzzle.z,
      });
    }
    _f.set(m.d[0], m.d[1], m.d[2]);
    this.fx.muzzle(muzzle, _f, m.w === 'shotgun' || m.w === 'sniper' || m.w === 'rocket', false);
    this.sfx.shot(m.w, muzzle, false);
    if (shooter) shooter.char.kick(0.6);
  }

  on_sw(m) {
    const r = this.remotes.get(m.id);
    if (r) r.char.playSwing();
  }

  on_dmg(m) {
    const t = this.actorById(m.tg);
    if (!t) return;
    t.hp = m.hp;
    t.sh = m.sh;
    if (this.me && m.tg === this.me.id) {
      this.hurtK = Math.min(1, this.hurtK + (m.c === 'storm' ? 0.25 : 0.45));
      if (m.c !== 'storm' && m.c !== 'fall') {
        const a = this.actorById(m.a);
        if (a) {
          const dx = a.pos.x - this.me.pos.x, dz = a.pos.z - this.me.pos.z;
          const yaw = this.me.yaw;
          const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
          this.hud.hitDirection(Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz));
        }
      }
      if (m.shd && m.sh === 0) this.sfx.shieldBreak(); else this.sfx.hurt();
    }
    if (t instanceof Bot) t.brain.lastHp = Math.max(t.brain.lastHp, 0);
  }

  on_elim(m) {
    const victim = this.actorById(m.v);
    const killer = m.k ? this.actorById(m.k) : null;
    const rv = this.roster.get(m.v);
    if (rv) rv.alive = false;
    const rk = this.roster.get(m.k);
    if (rk) rk.kills = (rk.kills || 0) + 1;
    const vName = esc(this.nameOf(m.v)), kName = esc(this.nameOf(m.k));
    const meV = m.v === this.myId, meK = m.k === this.myId;
    let line;
    if (m.c === 'storm') line = `<span class="${meV ? 'me' : ''}">${vName}</span> was lost in the storm`;
    else if (m.c === 'fall') line = `<span class="${meV ? 'me' : ''}">${vName}</span> fell too far`;
    else if (m.c === 'left') line = `${vName} left the match`;
    else line = `<span class="${meK ? 'me' : ''}">${kName}</span> ${m.hs ? '🎯' : '✖'} <span class="${meV ? 'me' : ''}">${vName}</span>`;
    this.hud.killfeed(line);
    // knock the body away from the killer
    const impulse = { x: 0, y: 2, z: 0 };
    if (victim && killer && killer !== victim) {
      _v.subVectors(victim.pos, killer.pos).setY(0).normalize().multiplyScalar(m.c === 'boom' ? 12 : 6);
      impulse.x = _v.x; impulse.z = _v.z; impulse.y = m.c === 'boom' ? 8 : 2.5;
    }
    if (meK && !meV) {
      this.kills++;
      this.hud.big(`ELIMINATED<small>${vName}</small>`);
      this.hud.hitmarker(false, true);
      this.sfx.hitmarker(false, false, true);
    }
    if (victim) {
      const pos = victim.pos.clone();
      if (victim === this.me) {
        this.onMyDeath(m, killer);
        this.me.die(impulse);
      } else if (victim instanceof Bot) {
        if (this.phase === 'match' || this.phase === 'bus') this.dropAll(victim);
        victim.die(impulse);
      } else {
        victim.die(impulse);
      }
      setTimeout(() => {
        if (this.disposed || victim.alive) return;
        const p = victim.char.ragdoll ? victim.char.ragdollPosition(_v3) : pos;
        this.fx.digitize(p.x, p.y - 0.5, p.z);
        victim.char.setVisible(false);
        victim.char.endRagdoll();
      }, 3200);
    }
    if (this.spectateId === m.v) this.spectateId = m.k && m.k !== m.v ? m.k : 0;
  }

  onMyDeath(m, killer) {
    if (this.phase === 'match' || this.phase === 'bus') this.dropAll(this.me);
    this.sfx.ui('elim');
    this.input.resetToggles();
    document.body.classList.add('dead');
    this.spectateId = killer && killer !== this.me ? killer.id : 0;
    this.specYaw = this.me.yaw;
    const how = m.c === 'storm' ? 'The storm got you' : m.c === 'fall' ? 'You fell too far' : killer ? `Eliminated by ${this.nameOf(m.k)}` : 'Eliminated';
    this.lastElim = {
      place: m.place, title: 'ELIMINATED', sub: `${how} · ${this.kills} elimination${this.kills === 1 ? '' : 's'}`,
      again: this.solo, spectate: true, leave: true,
    };
    this.hud.elim(this.lastElim);
    this.input.exitLock();
  }

  /** Should losing the mouse pointer open the pause menu? */
  wantsPause() { return !!(this.me && this.me.alive && this.phase !== 'ended'); }

  dropAll(actor) {
    const items = actor.allItems();
    if (items.length) this.send({ t: 'dropi', id: actor.id, items, x: actor.pos.x, y: actor.pos.y, z: actor.pos.z });
  }

  on_bAdd(m) {
    const pend = this.pendingBuilds.get(m.k);
    const mine = !!pend && pend.id === m.by;
    if (pend && !mine) {
      const a = this.actorById(pend.id);
      if (a && a.inv && !a.infinite) a.addMats(pend.m, BUILD.cost);
    }
    const p = this.builds.add(m);
    this.pendingBuilds.delete(m.k);
    if (p && !mine) this.sfx.build(p.pos, false);
  }

  on_bDel(m) {
    for (const k of m.k) {
      const p = this.builds.remove(k, true);
      if (p) this.sfx.breakSound(p.pos, p.m);
    }
    // unsupported pieces tumble down one after another
    (m.c || []).forEach((k, i) => {
      const p = this.builds.remove(k, false);
      if (!p) return;
      setTimeout(() => {
        if (this.disposed) return;
        this.builds.shatter(p, { x: 0, y: -2, z: 0 });
        if (i < 4) this.sfx.breakSound(p.pos, p.m);
      }, 80 + Math.min(i, 30) * 45 + Math.random() * 60);
    });
  }

  on_bh(m) { this.builds.setHp(m.k, m.hp, m.max); }

  on_bno(m) {
    const pend = this.pendingBuilds.get(m.k);
    if (!pend) return;
    this.pendingBuilds.delete(m.k);
    this.builds.remove(m.k, false);
    const a = this.actorById(pend.id);
    if (a && a.inv && !a.infinite) a.addMats(pend.m, BUILD.cost);
  }

  on_ox(m) {
    const killer = this.actorById(m.by);
    let dir = null;
    const o = this.world.data.objects[m.o];
    if (!o) return;
    if (killer) dir = _v.set(o.x - killer.pos.x, 0, o.z - killer.pos.z).normalize();
    this.world.destroyObject(m.o, dir);
    this.fx.decals.removeKey(`o${m.o}`);
    if (o.kind === 'tree') {
      for (let i = 0; i < 4; i++) this.fx.dust(o.x, o.y + 3 + i, o.z, 1.2, [0.35, 0.6, 0.25]);
    } else if (o.kind === 'rock') {
      this.fx.shatter('stone', o.x, o.y + o.s * 0.5, o.z, o.s, o.s * 0.6, o.s, 0, 2, 0, 10);
    } else if (o.shape === 'prism') {
      this.fx.shatter(o.mat, o.x, o.y, o.z, 1.5, 1, 1.5, 0, 1, 0, 8);
    } else {
      this.fx.shatter(o.mat, o.x, o.y, o.z, o.hx || 1, o.hy || 1, o.hz || 1, 0, 1, 0, Math.min(10, 4 + Math.round((o.hx + o.hy + o.hz) * 1.2)));
    }
    this.sfx.breakSound(_v2.set(o.x, o.y, o.z), o.mat);
  }

  on_lAdd(m) {
    for (const l of m.items) this.loot.add(l);
  }

  on_lDel(m) {
    const it = this.loot.remove(m.l);
    if (it) this.fx.sparkle(it.x, it.y + 0.3, it.z, [1, 1, 1], 6);
    for (const a of this.actors()) if (a.pendingPick) a.pendingPick.delete(m.l);
  }

  on_got(m) {
    const a = this.actorById(m.id);
    if (!a || !a.addItem) return;
    a.pendingPick.delete(m.l);
    const kind = itemKind(m.item.k);
    if (!m.swap && (kind === 'weapon' || kind === 'heal') && !a.canAutoPick(m.item)) {
      // an automatic pickup that no longer fits: put it straight back instead of swapping
      this.send({ t: 'dropi', id: a.id, items: [{ ...m.item, near: true }], x: a.pos.x, y: a.pos.y, z: a.pos.z });
      return;
    }
    const drops = a.addItem(m.item);
    if (drops.length) this.send({ t: 'dropi', id: a.id, items: drops.map((d) => ({ ...d, near: true })), x: a.pos.x, y: a.pos.y, z: a.pos.z });
    if (a === this.me) this.sfx.pickup();
  }

  on_gotno(m) {
    const a = this.actorById(m.id ?? this.myId);
    if (a && a.pendingPick) a.pendingPick.delete(m.l);
  }

  on_chest(m) {
    const c = this.world.data.chests[m.c];
    if (!c) return;
    this.world.setChestOpen(m.c, true);
    this.fx.sparkle(c.x, c.y + 0.5, c.z, [1, 0.85, 0.3], 30);
    this.sfx.chest(_v.set(c.x, c.y, c.z));
  }

  on_boom(m) {
    this.explosionFx(m.x, m.y, m.z, WEAPONS[m.w]?.splash || 5);
  }

  on_win(m) {
    this.phase = 'ended';
    const meWon = m.id === this.myId || (!m.bot && m.team !== undefined && m.team === this.teamOf(this.myId));
    this.input.exitLock();
    if (!meWon && this.me && !this.me.alive && this.lastElim) {
      // keep showing how we went out; just add who won
      this.hud.elim({ ...this.lastElim, spectate: false, sub: `${this.lastElim.sub} — ${m.name ? `${m.name} wins!` : 'match over'}` });
    } else if (meWon) {
      this.sfx.ui('victory');
      if (this.me.alive) this.me.dancing = true;
      this.hud.elim({ win: true, place: 1, title: 'PHICTORY ROYALE!', sub: `${this.kills} elimination${this.kills === 1 ? '' : 's'} — back to the island in a few seconds`, again: this.solo, leave: true });
    } else if (this.me && this.me.alive) {
      this.hud.elim({ title: m.early ? 'MATCH OVER' : 'GG!', sub: m.name ? `${m.name} wins!` : 'Nobody survived', again: this.solo, leave: true });
    } else {
      this.hud.elim({ title: m.name ? `${m.name.toUpperCase()} WINS` : 'MATCH OVER', sub: 'Returning to the island…', again: this.solo, leave: true });
    }
  }

  on_forcedrop(m) {
    for (const id of m.ids) {
      if (this.me && id === this.myId && this.me.inBus) this.dropFromBus(this.me);
      const b = this.bots.get(id);
      if (b && b.inBus) this.dropFromBus(b);
    }
  }

  // ------------------------------------------------------------------ actions used by actors
  dropFromBus(a) {
    if (!a.inBus) return;
    a.inBus = false;
    const p = this.bus.path ? this.bus.predicted(_v) : a.pos;
    a.mover.setEnabled(true);
    a.mover.teleport(p.x, p.y - 4, p.z);
    a.mover.mode = 'skydive';
    a.mover.vel.set(0, -5, 0);
    a.char.setVisible(true);
    this.send({ t: 'drop', id: a.id });
    if (a === this.me) {
      this.sfx.ui('glider');
      this.input.crouchToggle = false;
      document.body.classList.remove('inbus');
    }
  }

  reportFall(a, dmg) {
    if (this.phase !== 'match' && this.phase !== 'bus') return;
    this.send({ t: 'fall', id: a.id, d: Math.round(dmg) });
  }

  reportHeal(a, k) {
    this.send({ t: 'heal', id: a.id, k });
    if (a === this.me) this.sfx.heal(!!HEALS[k].sh);
  }

  onHealStart() {}

  onSwing(a) {
    this.send({ t: 'sw', id: a.id });
    if (a === this.me) this.sfx.whoosh(true);
  }

  onDryFire(a) { if (a === this.me) this.sfx.ui('error'); }

  onReload(a) { this.sfx.reload(a === this.me); }

  onStep(a) {
    let surf = 'grass';
    const gi = a.mover && a.mover.groundInfo;
    if (gi && gi.mat) surf = gi.mat === 'stone' ? 'stone' : gi.mat;
    else surf = this.world.surfaceAt(a.pos.x, a.pos.z);
    this.sfx.step(a.pos, surf, a === this.me);
    if (surf === 'sand' && Math.random() < 0.5) this.fx.dust(a.pos.x, a.pos.y, a.pos.z, 0.4, [0.9, 0.84, 0.66]);
  }

  onLanded(a, speed) {
    if (speed > 8) this.fx.dust(a.pos.x, a.pos.y, a.pos.z, Math.min(2, speed / 12), [0.75, 0.7, 0.6]);
  }

  onJump() {}

  botPick(bot, l) {
    const kind = itemKind(l.item.k);
    if ((kind === 'weapon' || kind === 'heal') && this.slotPickPending(bot)) return;
    this.pick(bot, l);
  }

  pick(a, l, swap = false) {
    if (a.pendingPick.has(l.id)) return;
    a.pendingPick.add(l.id);
    this.send({ t: 'pick', id: a.id, l: l.id, swap });
  }

  /** Is a weapon/heal pickup already on its way to this actor? */
  slotPickPending(a) {
    for (const id of a.pendingPick) {
      const it = this.loot.items.get(id);
      const kind = it ? itemKind(it.item.k) : 'weapon';
      if (kind === 'weapon' || kind === 'heal') return true;
    }
    return false;
  }

  openChest(a, i) {
    if (this.world.chestOpen.has(i)) return;
    this.send({ t: 'chest', id: a.id, c: i });
  }

  nearestChest(pos, maxDist) {
    let best = null, bd = maxDist * maxDist;
    this.world.data.chests.forEach((c, i) => {
      if (this.world.chestOpen.has(i)) return;
      const dx = c.x - pos.x, dy = c.y - pos.y, dz = c.z - pos.z;
      const d = dx * dx + dz * dz + dy * dy * 2;
      if (d < bd) { bd = d; best = { i, x: c.x, y: c.y, z: c.z, dist: Math.sqrt(d) }; }
    });
    return best;
  }

  nearestTree(pos, r) {
    let best = null, bd = r * r;
    for (const o of this.world.data.objects) {
      if (o.kind !== 'tree') continue;
      const dx = o.x - pos.x, dz = o.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd && this.world.isAlive(o.id)) { bd = d; best = o.id; }
    }
    return best;
  }

  tryPlaceBuild(a) {
    const onRamp = a.mover.groundInfo && a.mover.groundInfo.kind === 'build' ? this.builds.pieces.get(a.mover.groundInfo.key) : null;
    const t = this.builds.target(a.buildType, a.pos, a.yaw, a.pitch, onRamp);
    if (!t.free || !t.supported) return false;
    if (!a.autoMat()) { if (a === this.me) this.sfx.ui('error'); return false; }
    const mat = a.buildMat;
    const p = this.builds.add({ k: t.k, m: mat, d: t.d, by: a.id }, true);
    if (!p) return false;
    a.spendBuild();
    this.pendingBuilds.set(t.k, { id: a.id, m: mat });
    this.send({ t: 'b', id: a.id, k: t.k, m: mat, d: t.d });
    this.sfx.build(p.pos, a === this.me);
    return true;
  }

  // ------------------------------------------------------------------ combat
  spawnShot(a, cur, w, origin, dirs, shot) {
    const muzzle = a.char.muzzleWorld(_v3);
    // keep the visual start inside the shot line if the gun is clipping into a wall
    const pellets = dirs.length / 3;
    this.pendingShots.set(shot, { owner: a.id, w: cur.k, r: cur.r | 0, left: pellets, hits: new Map() });
    for (let i = 0; i < dirs.length; i += 3) {
      this.ballistics.fire({
        ox: origin.x, oy: origin.y, oz: origin.z, dx: dirs[i], dy: dirs[i + 1], dz: dirs[i + 2], speed: w.speed, grav: w.grav,
        owner: a.id, team: this.phase === 'lobby' ? a.id : this.teamOf(a.id), w: cur.k, r: cur.r | 0, auth: true, rocket: w.projectile === 'rocket', shot,
        visX: muzzle.x, visY: muzzle.y, visZ: muzzle.z,
      });
    }
    _f.set(dirs[0], dirs[1], dirs[2]);
    this.fx.muzzle(muzzle, _f, cur.k === 'shotgun' || cur.k === 'sniper' || cur.k === 'rocket', a === this.me);
    this.sfx.shot(cur.k, muzzle, a === this.me);
    a.char.kick(0.7);
    const r3 = (x) => Math.round(x * 1000) / 1000;
    this.send({
      t: 'sh', id: a.id, w: cur.k, r: cur.r | 0,
      o: [r3(origin.x), r3(origin.y), r3(origin.z)], d: dirs.map(r3),
    });
  }

  onBulletHit(b, hit) {
    if (b.rocket) {
      this.explode(b, hit.x, hit.y, hit.z);
      this.resolvePellet(b);
      return;
    }
    if (hit.kind === 'player') {
      const t = this.actorById(hit.id);
      this.fx.hitPlayer(hit.x, hit.y, hit.z, t && t.sh > 0, hit.head);
      if (b.auth) {
        const ps = this.pendingShots.get(b.shot);
        if (ps) {
          let e = ps.hits.get(hit.id);
          if (!e) ps.hits.set(hit.id, (e = { n: 0, nh: 0, dist: hit.travel, x: hit.x, y: hit.y, z: hit.z }));
          if (hit.head) e.nh++; else e.n++;
        }
      }
    } else if (hit.kind === 'world') {
      const info = hit.info;
      let mat = info && info.mat;
      if (!mat || (info && info.kind === 'terrain')) mat = this.world.surfaceAt(hit.x, hit.z);
      this.fx.impact(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, mat, b.w === 'sniper' ? 1.6 : b.w === 'shotgun' ? 0.5 : 1);
      if (!info || info.kind !== 'barrel') {
        const key = info && info.kind === 'build' ? info.key : info && info.kind === 'obj' ? `o${info.id}` : null;
        this.fx.decals.add(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, b.w === 'sniper' ? 0.22 : 0.14, key);
      }
      if (Math.random() < 0.5) this.sfx.impact(_v.set(hit.x, hit.y, hit.z), mat);
      if (info && info.kind === 'barrel') {
        const body = this.world.barrels[info.i].body;
        const k = b.w === 'sniper' ? 3 : b.w === 'shotgun' ? 0.6 : 1.2;
        body.applyImpulseAtPoint({ x: hit.dx * k * 8, y: hit.dy * k * 8 + 2, z: hit.dz * k * 8 }, { x: hit.x, y: hit.y, z: hit.z }, true);
      }
      const w = WEAPONS[b.w];
      if (b.auth && w && info) {
        const dmg = weaponDamage(b.w, b.r, hit.travel, false) * (w.struct || 1);
        if (info.kind === 'build') {
          this.send({ t: 'bd', id: b.owner, k: info.key, d: Math.round(dmg) });
          if (b.owner === this.myId) this.hud.damageNumber(_v.set(hit.x, hit.y, hit.z), dmg, 'build');
        } else if (info.kind === 'obj' && this.world.isAlive(info.id) && this.world.data.objects[info.id].hp > 0) {
          this.send({ t: 'od', id: b.owner, o: info.id, d: Math.round(dmg) });
          if (b.owner === this.myId) this.hud.damageNumber(_v.set(hit.x, hit.y, hit.z), dmg, 'build');
        }
      }
    } else if (hit.kind === 'water') {
      this.fx.water(hit.x, hit.z);
    }
    this.resolvePellet(b);
  }

  resolvePellet(b) {
    if (!b.auth) return;
    const ps = this.pendingShots.get(b.shot);
    if (ps) ps.left--;
  }

  /** Send the hits gathered this frame (pellets that land later are sent when they land). */
  flushShots() {
    for (const [shot, ps] of this.pendingShots) {
      if (ps.hits.size) this.sendHits(ps);
      if (ps.left <= 0) this.pendingShots.delete(shot);
    }
  }

  sendHits(ps) {
    for (const [tg, e] of ps.hits) {
      this.send({ t: 'hit', id: ps.owner, tg, w: ps.w, r: ps.r, d: Math.round(e.dist), n: e.n, nh: e.nh, x: e.x, y: e.y, z: e.z });
      if (ps.owner === this.myId) {
        const t = this.actorById(tg);
        const dmg = e.n * weaponDamage(ps.w, ps.r, e.dist, false) + e.nh * weaponDamage(ps.w, ps.r, e.dist, true);
        const shield = t && t.sh > 0;
        const live = this.phase === 'match' || this.phase === 'bus';
        this.hud.damageNumber(_v.set(e.x, e.y + 0.3, e.z), live ? dmg : dmg, e.nh ? 'head' : shield ? 'shield' : '');
        this.hud.hitmarker(e.nh > 0, false);
        this.sfx.hitmarker(e.nh > 0, shield, false);
      }
    }
    ps.hits.clear();
  }

  explode(b, x, y, z) {
    // other players' rockets are shown when their authoritative 'boom' arrives
    if (!b.auth) return;
    const w = WEAPONS[b.w];
    this.explosionFx(x, y, z, w ? w.splash : 5);
    this.send({ t: 'boom', id: b.owner, w: b.w, r: b.r, x, y, z });
  }

  explosionFx(x, y, z, radius) {
    this.fx.explosion(x, y, z, radius);
    this.fx.decals.add(x, y + 0.05, z, 0, 1, 0, radius * 0.7, null);
    this.sfx.explosion(_v.set(x, y, z));
    const cam = this.camera.position;
    const d = Math.hypot(cam.x - x, cam.y - y, cam.z - z);
    this.shake(Math.max(0, 1.2 - d / 40));
    // push dynamic bodies
    // radial blast: impulse = mass * velocity change, falling off with distance
    const blast = (body, reach, speed) => {
      const t = body.translation();
      const dx = t.x - x, dy = t.y - y, dz = t.z - z;
      const dd = Math.hypot(dx, dy, dz);
      if (dd >= reach) return;
      const f = (1 - dd / reach) * speed * body.mass();
      const l = Math.max(0.3, dd);
      body.applyImpulse({ x: (dx / l) * f, y: (Math.max(0, dy) / l) * f + f * 0.6, z: (dz / l) * f }, true);
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * f * 0.3, y: (Math.random() - 0.5) * f * 0.3, z: (Math.random() - 0.5) * f * 0.3 }, true);
    };
    for (const bar of this.world.barrels) blast(bar.body, radius * 2.2, 11);
    for (const pool of Object.values(this.fx.debris.pools)) {
      for (const it of pool.items) if (it) blast(it.body, radius * 2, 9);
    }
  }

  meleeHit(a, aim) {
    const w = WEAPONS.pickaxe;
    const o = a.shoulder(_v);
    let dx = aim.tx - o.x, dy = aim.ty - o.y, dz = aim.tz - o.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // fall back to the view direction when the camera target is behind us
    if (dx * aim.dx + dy * aim.dy + dz * aim.dz < 0.3) { dx = aim.dx; dy = aim.dy; dz = aim.dz; }
    const range = w.range;
    let best = null;
    const myTeam = this.phase === 'lobby' ? a.id : this.teamOf(a.id);
    for (const t of this.hitboxes) {
      if (t.id === a.id || t.team === myTeam) continue;
      const th = raySphere(o.x, o.y, o.z, dx, dy, dz, t.head[0], t.head[1], t.head[2], t.head[3] + 0.15);
      const tb = rayCapsule(o.x, o.y, o.z, dx, dy, dz, t.body[0], t.body[1], t.body[2], t.body[3], t.body[4], t.body[5], t.body[6] + 0.15);
      const d = th >= 0 ? (tb >= 0 ? Math.min(th, tb) : th) : tb;
      if (d >= 0 && d <= range && (!best || d < best.d)) best = { d, id: t.id };
    }
    const h = this.physics.raycast(o.x, o.y, o.z, dx, dy, dz, range, RAY_SOLID);
    if (best && (!h || best.d < h.dist)) {
      const px = o.x + dx * best.d, py = o.y + dy * best.d, pz = o.z + dz * best.d;
      const t = this.actorById(best.id);
      this.fx.hitPlayer(px, py, pz, t && t.sh > 0, false);
      this.send({ t: 'hit', id: a.id, tg: best.id, w: 'pickaxe', r: 0, d: 1, n: 1, nh: 0, x: px, y: py, z: pz });
      if (a === this.me) {
        this.hud.damageNumber(_v2.set(px, py + 0.3, pz), w.dmg[0], t && t.sh > 0 ? 'shield' : '');
        this.hud.hitmarker(false, false);
        this.sfx.hitmarker(false, false, false);
      }
      this.sfx.pickaxe(_v2.set(px, py, pz), 'wood', a === this.me);
      return;
    }
    if (!h) return;
    const info = h.info;
    let mat = info && info.mat;
    if (!mat || info.kind === 'terrain') mat = this.world.surfaceAt(h.x, h.z);
    this.fx.impact(h.x, h.y, h.z, h.nx, h.ny, h.nz, mat, 1.4);
    this.sfx.pickaxe(_v2.set(h.x, h.y, h.z), mat, a === this.me);
    const sdmg = w.dmg[0] * w.struct;
    if (info && info.kind === 'build') {
      this.send({ t: 'bd', id: a.id, k: info.key, d: sdmg });
      if (a === this.me) this.hud.damageNumber(_v2.set(h.x, h.y, h.z), sdmg, 'build');
    } else if (info && info.kind === 'obj') {
      const o2 = this.world.data.objects[info.id];
      if (o2 && o2.hp > 0 && this.world.isAlive(info.id)) {
        this.send({ t: 'od', id: a.id, o: info.id, d: sdmg });
        const y = a.harvestYield(info);
        if (y && !a.infinite) {
          a.addMats(y[0], y[1]);
          if (a === this.me) this.hud.damageNumber(_v2.set(h.x, h.y + 0.4, h.z), `+${y[1]}`, 'mat');
        }
      }
    } else if (info && info.kind === 'barrel') {
      this.world.barrels[info.i].body.applyImpulseAtPoint({ x: dx * 25, y: 6, z: dz * 25 }, { x: h.x, y: h.y, z: h.z }, true);
    }
  }

  // ------------------------------------------------------------------ aiming + camera
  computeAim() {
    const cam = this.camera;
    const o = cam.position;
    const f = forwardFromAngles(this.me.yaw, this.me.pitch, _f);
    const minD = o.distanceTo(_v.set(this.me.pos.x, this.me.pos.y + 1.4, this.me.pos.z)) + 0.4;
    let best = 1500;
    let target = 0; // enemy under the crosshair (nothing solid in front of it, and drawn on screen)
    let feet = 0;
    let h = this.physics.raycast(o.x + f.x * minD, o.y + f.y * minD, o.z + f.z * minD, f.x, f.y, f.z, 1500, RAY_SOLID);
    if (h) best = h.dist + minD;
    const myTeam = this.phase === 'lobby' ? this.me.id : this.teamOf(this.me.id);
    for (const t of this.hitboxes) {
      if (t.id === this.me.id || t.team === myTeam) continue;
      const th = raySphere(o.x, o.y, o.z, f.x, f.y, f.z, t.head[0], t.head[1], t.head[2], t.head[3]);
      const tb = rayCapsule(o.x, o.y, o.z, f.x, f.y, f.z, t.body[0], t.body[1], t.body[2], t.body[3], t.body[4], t.body[5], t.body[6]);
      // an enemy too far away to be drawn still stops the ray but is never a target
      if (th > minD && th < best) { best = th; target = t.far ? 0 : t.id; feet = t.body[1] - t.body[6]; }
      if (tb > minD && tb < best) { best = tb; target = t.far ? 0 : t.id; feet = t.body[1] - t.body[6]; }
    }
    const a = this.aim;
    a.target = target;
    a.targetFeet = feet;
    a.ox = o.x; a.oy = o.y; a.oz = o.z;
    a.dx = f.x; a.dy = f.y; a.dz = f.z;
    a.tx = o.x + f.x * best; a.ty = o.y + f.y * best; a.tz = o.z + f.z * best;
    a.dist = best;
    return a;
  }

  updateCamera(dt) {
    const me = this.me;
    const cam = this.camera;
    const st = this.settings;
    let pivot, yaw, pitch, dist, right = 0, up = 0.25, zoom = 1, scope = false, hideMe = false;
    if (me.inBus && this.bus.path) {
      pivot = _v.copy(this.bus.pos).add(_v2.set(0, 3, 0));
      yaw = me.yaw; pitch = Math.max(-0.9, Math.min(0.35, me.pitch));
      dist = 26;
      hideMe = true;
    } else if (me.alive) {
      pivot = _v.set(me.pos.x, me.pos.y + (me.mover.crouch ? 1.15 : 1.58), me.pos.z);
      yaw = me.yaw; pitch = me.pitch;
      const m = me.mode;
      if (m === 'skydive' || m === 'glide') { dist = 6; up = 0.8; right = 0; }
      else if (me.buildMode) { dist = 3.8; right = 0.75; up = 0.35; }
      else { dist = 3.5; right = 0.72; up = 0.3; }
      const cur = me.current();
      const w = cur && WEAPONS[cur.k];
      if (me.ads && w && !w.melee) {
        zoom = w.zoom || 1.3;
        dist = 2.2; right = 0.86; up = 0.25;
        if (w.scope) { scope = true; hideMe = true; dist = 0.4; right = 0.2; }
      }
    } else {
      let t = this.spectateId ? this.actorById(this.spectateId) : null;
      if (!t || !t.alive) {
        const alive = this.actors().filter((a) => a.alive && a !== me && a.mode !== 'bus');
        t = alive.find((a) => this.friendly(a.id, me.id)) || alive[0] || null;
        this.spectateId = t ? t.id : 0;
      }
      const s = this.input.s;
      this.specYaw += s.lookX;
      this.specPitch = Math.max(-1.2, Math.min(0.6, this.specPitch + s.lookY));
      yaw = this.specYaw; pitch = this.specPitch;
      if (t) pivot = _v.set(t.pos.x, t.pos.y + 1.6, t.pos.z);
      else { const p = me.char.ragdoll ? me.char.ragdollPosition(_v3) : me.pos; pivot = _v.set(p.x, p.y + 1.6, p.z); }
      dist = 5;
      right = 0;
    }
    this.hud.scope(scope);
    const k = Math.min(1, dt * 14);
    this.camDist += (dist - this.camDist) * k;
    this.camRight += (right - this.camRight) * k;
    const f = forwardFromAngles(yaw, pitch, _f);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const bx = pivot.x + rx * this.camRight, by = pivot.y + up, bz = pivot.z + rz * this.camRight;
    // pull the camera in front of walls
    let d = this.camDist;
    const lx = bx - pivot.x, ly = by - pivot.y, lz = bz - pivot.z;
    const ll = Math.hypot(lx, ly, lz);
    let sx = bx, sy = by, sz = bz;
    if (ll > 0.01) {
      const h0 = this.physics.raycast(pivot.x, pivot.y, pivot.z, lx / ll, ly / ll, lz / ll, ll + 0.2, RAY_SOLID);
      if (h0) { const kk = Math.max(0, h0.dist - 0.2) / ll; sx = pivot.x + lx * kk; sy = pivot.y + ly * kk; sz = pivot.z + lz * kk; }
    }
    const h = this.physics.raycast(sx, sy, sz, -f.x, -f.y, -f.z, d + 0.3, RAY_SOLID);
    if (h) d = Math.max(0.2, h.dist - 0.3);
    cam.position.set(sx - f.x * d, sy - f.y * d, sz - f.z * d);
    if (cam.position.y < 0.3 && this.world.data.heightAt(cam.position.x, cam.position.z) < 0) cam.position.y = Math.max(cam.position.y, 0.3);
    // shake
    if (this.shakeK > 0.001) {
      const s = this.shakeK * this.shakeK * 0.25 * (st.shake ? 1 : 0);
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
      this.shakeK = Math.max(0, this.shakeK - dt * 3);
    }
    cam.lookAt(cam.position.x + f.x, cam.position.y + f.y, cam.position.z + f.z);
    const targetFov = 2 * Math.atan(Math.tan((st.fov * Math.PI) / 360) / zoom) * 180 / Math.PI;
    this.curFov += (targetFov - this.curFov) * Math.min(1, dt * 16);
    if (Math.abs(cam.fov - this.curFov) > 0.01) {
      cam.fov = this.curFov;
      cam.updateProjectionMatrix();
    }
    const tooClose = me.alive && cam.position.distanceTo(_v2.set(me.pos.x, me.pos.y + 1.2, me.pos.z)) < 1.15;
    if (me.alive || me.inBus) me.char.setVisible(!hideMe && !tooClose && !me.inBus);
    this.sfx.setListener(cam.position, yaw);
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    if (!this.me) return;
    this.time += dt;
    const s = this.input.update();
    const me = this.me;
    if (s.map) this.hud.toggleFullMap();

    // hitboxes for this frame (positions from last frame are fine at 60 fps)
    this.hitboxes.length = 0;
    for (const a of this.actors()) {
      if (!a.alive || a.inBus || a.mode === 'bus' || a.mode === 'dead') continue;
      if (a.hasState === false) continue;
      const hb = a.hitbox();
      hb.team = this.phase === 'lobby' ? a.id : this.teamOf(a.id);
      hb.far = this.isFar(a.pos);
      this.hitboxes.push(hb);
    }

    // local player
    document.body.classList.toggle('inbus', !!me.inBus);
    if (me.inBus) {
      me.yaw += s.lookX;
      me.pitch = Math.max(-0.9, Math.min(0.35, me.pitch + s.lookY));
      if (s.jump && this.phase === 'bus') this.dropFromBus(me);
      this.hud.bus(this.input.touchMode ? 'Tap <b>JUMP</b> to drop!' : 'Press <b>SPACE</b> to jump out!');
      me.mover.pos.copy(this.bus.pos);
    } else {
      this.hud.bus('');
    }
    if (me.alive && !me.inBus) {
      this.aimAssist(dt, s);
      me.control(dt, s);
      me.move(dt, s);
    } else if (!me.alive) {
      // spectator: tap fire to cycle
      if (s.firePressed) this.cycleSpectate();
    }
    this.updateCamera(dt);
    if (me.alive && !me.inBus) {
      const aim = this.computeAim();
      me.act(dt, this.autoShoot(dt, s, aim), aim);
      me.animate(dt);
    } else {
      this.autoOn = 0;
      this.autoLock = false;
      if (me.char.ragdoll) me.char.update(dt, {});
    }

    // owned bots
    for (const b of this.bots.values()) {
      if (b.inBus) {
        if (this.bus.path) {
          b.mover.pos.copy(this.bus.pos);
          const el = (performance.now() - this.bus.t0) / 1000;
          if (el > b.brain.dropAt) this.dropFromBus(b);
        }
        continue;
      }
      if (b.alive) b.update(dt);
      else if (b.char.ragdoll) b.char.update(dt, {});
    }
    // remote players
    const now = performance.now();
    for (const r of this.remotes.values()) r.update(dt, now);

    this.physics.step(dt);
    this.ballistics.update(dt);
    this.flushShots();
    this.builds.update(dt);

    // build ghost
    if (me.alive && me.buildMode && !me.inBus && me.canAct()) {
      const onRamp = me.mover.groundInfo && me.mover.groundInfo.kind === 'build' ? this.builds.pieces.get(me.mover.groundInfo.key) : null;
      const t = this.builds.target(me.buildType, me.pos, me.yaw, me.pitch, onRamp);
      const ok = t.free && t.supported && (me.canBuild() || me.inv.mats.wood + me.inv.mats.stone + me.inv.mats.metal >= BUILD.cost);
      this.builds.showGhost(t.free ? t : null, ok);
    } else this.builds.showGhost(null);

    this.loot.update(dt, this.camera.position);
    this.storm.update(dt);
    this.bus.update(dt);

    this.interactions(s);
    this.network(dt);
    this.updateHud(dt);
  }

  /**
   * Auto-shoot setting: while the crosshair rests on an enemy (and nothing solid is in the way)
   * the current gun fires by itself. Returns the controls to act on this frame.
   */
  autoShoot(dt, s, aim) {
    const me = this.me;
    const cur = me.current();
    const k = cur && cur.k;
    const w = k && Object.prototype.hasOwnProperty.call(WEAPONS, k) ? WEAPONS[k] : null;
    // only a gun in hand that can shoot, while the player is playing (no menu open): never
    // builds, heals or the pickaxe, nor an empty gun, nor during a reload
    const loaded = !!w && !w.melee && (cur.m > 0 || me.freeAmmo() || (me.inv.ammo[w.ammo] | 0) > 0);
    const ready = !!(this.settings.autoFire && this.input.enabled && loaded && !me.buildMode && me.canAct()
      && me.reloadT < 0
      // a sniper only fires on its own while scoped in: unscoped shots at range almost always miss
      && (!w.scope || !!s.ads)
      // a newly picked-up gun waits for its own lock
      && cur === this.autoItem);
    this.autoItem = cur;
    const onTarget = ready && !!aim.target && this.autoShotLands(me, w, k, aim);
    if (!ready || (aim.target && !onTarget)) { this.autoOn = 0; this.autoOff = 0; }
    else if (onTarget) { this.autoOn += dt; this.autoOff = 0; }
    else {
      // the crosshair slipped off the target for a moment while tracking it
      this.autoOff += dt;
      if (this.autoOff > AUTO_GRACE) this.autoOn = 0;
    }
    this.autoLock = ready && this.autoOn >= AUTO_ACQUIRE;
    if (!this.autoLock) return s;
    // fire as if the trigger were pressed (even if it is held, e.g. dragging the touch fire
    // button to aim); semi-auto guns shoot as fast as they can cycle
    const c = Object.assign(this.autoCtl, s);
    c.fire = true;
    // in the grace (crosshair slipped off) only an automatic keeps spraying: a semi-auto or rocket
    // never starts a new shot at whatever is under the crosshair now
    c.firePressed = !!aim.target || !!s.firePressed;
    return c;
  }

  /** Would a shot from the gun reach the enemy under the crosshair? */
  autoShotLands(me, w, k, aim) {
    const o = me.shoulder(_v3);
    const dx = aim.tx - o.x, dy = aim.ty - o.y, dz = aim.tz - o.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > (AUTO_RANGE[k] || 100) || len < (AUTO_MIN[k] || 0)) return false;
    // bullet drop: the shot must still come down on the target, not in the ground in front of it
    // (a shallow trajectory that dips below the feet lands many metres short, even for a rocket:
    // only a few cm of slack keep its blast within reach)
    const drop = w.grav ? 0.5 * GRAVITY * w.grav * (len / w.speed) ** 2 : 0;
    if (w.grav && aim.ty - drop < aim.targetFeet + (w.splash ? -0.1 : 0.1)) return false;
    // bullets leave from the shoulder (below the camera) and fall on the way: trace their real
    // path in a few straight pieces so we never fire into cover the camera can see over
    const n = drop > 0.02 ? 4 : 1;
    const end = Math.max(0, 1 - 0.1 / len); // enemies aren't solid, so stop just short of the aim point
    let px = o.x, py = o.y, pz = o.z;
    for (let i = 1; i <= n; i++) {
      const f = (end * i) / n;
      const qx = o.x + dx * f, qy = o.y + dy * f - drop * f * f, qz = o.z + dz * f;
      const sx = qx - px, sy = qy - py, sz = qz - pz, sl = Math.hypot(sx, sy, sz);
      const hit = sl > 1e-4 && this.physics.raycast(px, py, pz, sx / sl, sy / sl, sz / sl, sl, RAY_SOLID);
      // a rocket that bursts on cover right next to the enemy still catches them in the blast
      if (hit) return !!w.splash && Math.hypot(hit.x - aim.tx, hit.y - (aim.targetFeet + 0.92), hit.z - aim.tz) < w.splash * 0.5;
      px = qx; py = qy; pz = qz;
    }
    return true;
  }

  // ------------------------------------------------------------------ aim assist
  /**
   * Aim assist setting, for thumbs (touch, controller) and never a mouse, like console/mobile
   * shooters: the look slows down over a visible enemy; while aiming down sights or firing the
   * view follows the target and drifts toward its chest; and starting to aim down sights swings
   * the crosshair onto a nearby enemy. Runs before control() and adjusts the look input / angles.
   */
  aimAssist(dt, s) {
    const me = this.me;
    const A = this.aa || (this.aa = {
      prevAds: false, id: 0, yawT: 0, pitchT: 0, err: 0, slow: 1, snapId: 0, snapT: 0, rays: 0, vis: new Map(),
    });
    const adsEdge = !!s.ads && !A.prevAds;
    A.prevAds = !!s.ads;
    A.slow = 1;
    const inp = this.input;
    const cur = me.current();
    const w = cur && Object.prototype.hasOwnProperty.call(WEAPONS, cur.k) ? WEAPONS[cur.k] : null;
    if (!this.settings.aimAssist || !inp.enabled || !(inp.touchMode || inp.lookDev === 'pad')
      || !w || w.melee || me.buildMode || !me.canAct()) {
      A.id = 0; A.snapT = 0;
      return;
    }
    const ads = !!s.ads;
    const scoped = ads && !!w.scope;
    // The crosshair ray runs along the view direction through the camera's shoulder point (see
    // updateCamera; use the offsets it is easing toward), so solve the view angles that put that
    // ray through each enemy's chest: yaw turns a little extra for the sideways offset.
    const camR = ads ? (w.scope ? 0.2 : 0.86) : 0.72;
    const px = me.pos.x, pz = me.pos.z;
    const py = me.pos.y + (me.mover.crouch ? 1.15 : 1.58) + (ads ? 0.25 : 0.3);
    const cp = Math.cos(me.pitch);
    const range = scoped ? AA.rangeScoped : AA.range;
    const myTeam = this.phase === 'lobby' ? me.id : this.teamOf(me.id);
    A.rays = AA.losRays;
    // best target in reach (any visible part) and the snap target (visible chest), as plain numbers
    let id = 0, score = AA.pullCone, eY = 0, eP = 0, err = 0, cone = 1, dead = 0, yawT = 0, pitchT = 0, chest = false;
    let snapId = 0, snapErr = AA.snapCone, sY = 0, sP = 0, sYawT = 0, sPitchT = 0, snapLive = false;
    for (const t of this.hitboxes) {
      if (t.id === me.id || t.team === myTeam || t.far) continue;
      const b = t.body;
      const cx = b[3], cy = b[4] - 0.18, cz = b[5];
      const dx = cx - px, dy = cy - py, dz = cz - pz;
      const r2 = dx * dx + dz * dz;
      if (r2 < 2.25 || r2 + dy * dy > range * range) continue;
      const dist = Math.sqrt(r2 + dy * dy);
      const ty = Math.atan2(-dx, -dz) + Math.asin(camR / Math.sqrt(r2));
      const tp = Math.atan2(dy, Math.sqrt(r2 - camR * camR));
      const ey = aaWrap(ty - me.yaw), ep = tp - me.pitch;
      const e = Math.hypot(ey * cp, ep);
      // the bubble: body plus a margin, as an angle (wider up close)
      const c = Math.min(AA.coneMax, Math.max(AA.coneMin, Math.atan(AA.bubble / dist)));
      const inSnap = e < AA.snapCone && dist < AA.snapRange;
      const snapping = A.snapT > 0 && t.id === A.snapId;
      if (e > c * AA.pullCone && !inSnap && !snapping) continue;
      // only enemies the camera can see (cached; also kept fresh inside the snap cone for the next ADS)
      const vis = this.aaVisible(t, cx, cy, cz);
      if (!vis) continue;
      const sc = (e / c) * (t.id === A.id ? 0.7 : 1); // stay with the current target when several are close
      if (sc < score) {
        score = sc; id = t.id; eY = ey; eP = ep; err = e; cone = c; yawT = ty; pitchT = tp;
        dead = Math.atan(AA.chest / dist); chest = (vis & 1) !== 0;
      }
      if (!(vis & 1)) continue; // swings and pulls only go to a chest that can be seen
      if (snapping) { snapLive = true; sY = ey; sP = ep; sYawT = ty; sPitchT = tp; }
      else if (adsEdge && inSnap && e < snapErr) { snapErr = e; snapId = t.id; sY = ey; sP = ep; sYawT = ty; sPitchT = tp; }
    }
    // how fast the player is turning (rad/s): the assist backs off while they swipe
    const inRate = Math.hypot(s.lookX, s.lookY) / Math.max(dt, 1e-3);

    // ADS snap: ease onto the chest so it lands at the end of the window (re-aimed every frame,
    // so a moving target is still met); a real swipe or letting go of ADS cancels it
    if (adsEdge && snapId) { A.snapId = snapId; A.snapT = AA.snapTime; snapLive = true; }
    if (A.snapT > 0) {
      if (!ads || !snapLive || inRate > AA.swipeHi) A.snapT = 0;
      else {
        const k = Math.min(1, dt / A.snapT);
        me.yaw += sY * k;
        me.pitch += sP * k;
        A.snapT -= dt;
        A.id = A.snapId; A.yawT = sYawT; A.pitchT = sPitchT; A.err = 0;
        return;
      }
    }
    if (!id) { A.id = 0; A.err = 0; return; }

    // friction: the look slows down over the enemy so a swipe doesn't overshoot
    const inside = 1 - err / cone;
    if (inside > 0) {
      A.slow = 1 - (1 - (ads ? AA.slowAds : AA.slowHip)) * Math.min(1, inside * 1.5);
      s.lookX *= A.slow;
      s.lookY *= A.slow;
    }
    // tracking while aiming down sights or firing, fading out as the player swipes (sooner when
    // swiping away from the target, so it never fights a deliberate turn)
    if (chest && (ads || s.fire || this.autoLock)) {
      const away = s.lookX * eY * cp * cp + s.lookY * eP < 0;
      const lo = away ? AA.swipeLo * 0.5 : AA.swipeLo, hi = away ? AA.swipeHi * 0.5 : AA.swipeHi;
      const str = (ads ? 1 : 0.5) * (scoped ? 0.5 : 1) * Math.max(0, Math.min(1, 1 - (inRate - lo) / (hi - lo)));
      // full strength over the inner half of the reach, fading to nothing at its edge
      const near = Math.max(0, Math.min(1, 2 - (2 * err) / (cone * AA.pullCone)));
      if (str > 0 && near > 0) {
        // rotational assist: turn with part of the target's motion across the view (its strafing and ours)
        if (A.id === id) {
          const f = AA.follow * str * near;
          me.yaw += aaClamp(aaWrap(yawT - A.yawT), 0.05) * f;
          me.pitch += aaClamp(pitchT - A.pitchT, 0.05) * f;
        }
        // and a gentle, capped pull toward the chest (none on the chest itself)
        const over = err - dead;
        if (over > 0) {
          const step = Math.min(over, AA.pull * str * near * dt);
          me.yaw += (eY / err) * step;
          me.pitch += (eP / err) * step;
        }
      }
    }
    A.id = id; A.yawT = yawT; A.pitchT = pitchT; A.err = err;
  }

  /** Can the camera see an enemy's chest (1) or head (2)? Cached per enemy, re-checked a few times a second. */
  aaVisible(t, cx, cy, cz) {
    const A = this.aa;
    let e = A.vis.get(t.id);
    if (!e) {
      if (A.vis.size > 64) A.vis.clear();
      e = { at: -1, bits: 0 };
      A.vis.set(t.id, e);
    }
    const age = e.at < 0 ? 1e9 : this.time - e.at;
    // out of checks this frame: an answer up to a second old will do, anything older counts as hidden
    if (age < AA.losEvery || A.rays <= 0) return age < 1 ? e.bits : 0;
    A.rays--;
    e.at = this.time;
    e.bits = this.aaClear(cx, cy, cz) ? 1 : this.aaClear(t.head[0], t.head[1], t.head[2]) ? 2 : 0;
    return e.bits;
  }

  /** Nothing solid between the camera and a point (stopping a little short of it). */
  aaClear(x, y, z) {
    const o = this.camera.position;
    const dx = x - o.x, dy = y - o.y, dz = z - o.z;
    const l = Math.hypot(dx, dy, dz);
    return l < 0.5 || !this.physics.raycast(o.x, o.y, o.z, dx / l, dy / l, dz / l, l - 0.4, RAY_SOLID);
  }

  cycleSpectate() {
    const list = this.actors().filter((a) => a.alive && a !== this.me && a.mode !== 'bus');
    if (!list.length) return;
    const i = list.findIndex((a) => a.id === this.spectateId);
    this.spectateId = list[(i + 1) % list.length].id;
  }

  interactions(s) {
    const me = this.me;
    if (!me.alive || me.inBus || !me.canAct()) { this.hud.prompt(''); this.input.setInteractLabel(''); return; }
    // auto pickup
    let slotBusy = this.slotPickPending(me);
    for (const it of this.loot.items.values()) {
      const dx = it.x - me.pos.x, dz = it.z - me.pos.z, dy = it.y - me.pos.y;
      if (dx * dx + dz * dz >= 1.7 * 1.7 || Math.abs(dy) >= 1.6 || !me.canAutoPick(it.item)) continue;
      const kind = itemKind(it.item.k);
      if (kind === 'weapon' || kind === 'heal') {
        if (slotBusy) continue;
        slotBusy = true;
      }
      this.pick(me, it);
    }
    const chest = this.nearestChest(me.pos, 2.8);
    const l = chest ? null : this.loot.nearest(me.pos, 2.6, (it) => !me.pendingPick.has(it.id));
    const touch = this.input.touchMode;
    let text = '', label = '';
    if (chest) { text = `${touch ? '' : '<kbd>E</kbd>'}Open Chest`; label = 'Open'; }
    else if (l) {
      const kind = itemKind(l.item.k);
      const swap = (kind === 'weapon' || kind === 'heal') && !me.canAutoPick(l.item) && me.freeSlot() < 0;
      text = `${touch ? '' : '<kbd>E</kbd>'}${swap ? 'Swap for ' : 'Pick up '}${lootLabel(l.item)}`;
      label = swap ? 'Swap' : 'Pick up';
    }
    this.hud.prompt(text);
    this.input.setInteractLabel(label);
    if (s.interact) {
      if (chest) this.openChest(me, chest.i);
      else if (l) this.pick(me, l, true);
    }
    // chest shimmer
    const nc = this.nearestChest(me.pos, 18);
    if (nc && Math.random() < 0.15) this.fx.sparkle(nc.x, nc.y + 0.6, nc.z, [1, 0.85, 0.35], 1);
    if (nc) this.sfx.chestHum(_v.set(nc.x, nc.y, nc.z), 1 - nc.dist / 18);
  }

  network(dt) {
    this.sendT -= dt;
    if (this.sendT > 0) return;
    this.sendT = 1 / SEND_HZ;
    const me = this.me;
    if (me.alive && !me.inBus) this.send({ t: 'u', s: me.stateArray() });
    if (this.bots.size) {
      const b = [];
      for (const bot of this.bots.values()) if (bot.alive && !bot.inBus) b.push([bot.id, ...bot.stateArray()]);
      if (b.length) this.send({ t: 'ub', b });
    }
  }

  updateHud(dt) {
    const me = this.me;
    const hud = this.hud;
    hud.bars(me.hp, me.sh);
    // crosshair size from current spread
    const cur = me.current();
    const w = cur && WEAPONS[cur.k];
    let mode = 'none';
    let spreadPx = 0;
    if (me.alive && !me.inBus && me.canAct()) {
      if (me.buildMode) mode = 'pick';
      else if (w && !w.melee) {
        mode = me.ads && w.scope ? 'none' : 'gun';
        const h = window.innerHeight;
        spreadPx = (Math.tan(me.spread(w)) / Math.tan((this.camera.fov * Math.PI) / 360)) * (h / 2);
      } else mode = 'pick';
    }
    hud.crosshair(spreadPx, mode, this.autoLock && mode !== 'pick');
    // heal / reload progress
    if (me.healT >= 0 && cur && HEALS[cur.k]) hud.progress(me.healT / HEALS[cur.k].time, `Using ${HEALS[cur.k].name}`);
    else if (me.reloadT >= 0 && w) hud.progress(me.reloadT / w.reload, 'Reloading');
    else hud.progress(-1);
    // storm
    const st = this.storm.state;
    let stormText = '–:––', shrinking = false;
    if (st) {
      const m = Math.floor(st.secs / 60), sec = st.secs % 60;
      stormText = st.done ? 'FINAL' : `${m}:${String(sec).padStart(2, '0')}`;
      shrinking = st.shrinking;
    } else if (this.phase === 'lobby') stormText = 'WARM-UP';
    const alive = this.phase === 'lobby' ? [...this.roster.values()].filter((p) => !p.bot).length : this.aliveCount;
    hud.stats(stormText, shrinking, alive, this.kills);
    const out = me.alive && !me.inBus ? this.storm.outside(me.pos.x, me.pos.z) : -1;
    hud.stormTint(out > 0 ? 1 : out > -15 ? 0.15 : 0);
    if (out > 0 && Math.random() < 0.5) this.fx.stormWisp(me.pos.x, me.pos.y, me.pos.z);
    this.sfx.setStorm(out > -20 && st ? Math.min(1, (out + 20) / 25) : 0);
    this.sfx.setWind(me.alive && (me.mode === 'skydive' || me.mode === 'glide') ? (me.mode === 'skydive' ? 1 : 0.5) : 0);
    this.hurtK = Math.max(0, this.hurtK - dt * 1.2);
    const lowHp = me.alive && me.hp < 30 ? 0.25 + Math.sin(this.time * 4) * 0.1 : 0;
    hud.hurt(Math.max(this.hurtK, lowHp));
    // map
    const extras = {};
    if (this.phase === 'bus' && this.bus.path) { extras.bus = this.bus.path; extras.busPos = this.bus.pos; }
    if (this.phase !== 'lobby') {
      const dots = [];
      for (const r of this.remotes.values()) if (r.alive && !r.isBot && this.friendly(r.id, this.myId)) dots.push({ x: r.pos.x, z: r.pos.z, c: '#4fd2ff' });
      if (dots.length) extras.dots = dots;
    }
    const mp = me.inBus ? this.bus.pos : me.alive ? me.pos : (this.actorById(this.spectateId) || me).pos;
    hud.minimap(dt, { x: mp.x, z: mp.z, yaw: me.alive || me.inBus ? me.yaw : this.specYaw }, st && { ...st, ...this.storm.vis }, extras);
    // location name
    let poi = '';
    for (const p of this.world.data.pois) {
      if (Math.hypot(p.x - mp.x, p.z - mp.z) < 55) { poi = p.name; break; }
    }
    hud.poi(poi);
    if (poi && poi !== this.lastPoi && me.alive && !me.inBus && this.phase !== 'lobby') hud.notice(poi.toUpperCase(), false, 2.5);
    this.lastPoi = poi;
    hud.updateNumbers(dt, this.camera, window.innerWidth, window.innerHeight);
    hud.update(dt);
    if (!this.solo) hud.net(this.net.rtt ? `${Math.round(this.net.rtt)} ms` : '');
    if (this.phase === 'lobby') this.updateLobby(true);
  }

  updateLobby(throttle = false) {
    if (throttle) {
      this.lobbyT = (this.lobbyT || 0) - 1;
      if (this.lobbyT > 0) return;
      this.lobbyT = 30;
    }
    if (this.phase !== 'lobby') { this.hud.lobby(null); return; }
    this.hud.lobby({
      solo: this.solo, code: this.code, players: [...this.roster.values()], leader: this.leader, you: this.myId,
      settings: this.settingsState, share: this.app.shareHtml || '',
    });
  }

  startMatch(bots, mats, mode) {
    this.send({ t: 'start', bots, mats, mode: mode || this.settingsState.mode });
  }

  playAgain() {
    if (this.phase === 'lobby') this.startMatch(this.settingsState.bots, this.settingsState.mats);
    else { this.autoRestart = true; this.send({ t: 'end' }); }
  }

  dispose() {
    this.disposed = true;
    this.unsub();
    this.net.close();
    if (this.me) this.me.dispose();
    for (const b of this.bots.values()) b.dispose();
    for (const r of this.remotes.values()) r.dispose();
    this.bots.clear();
    this.remotes.clear();
    this.loot.clear();
    this.scene.remove(this.storm.mesh);
    this.scene.remove(this.bus.mesh);
    this.resetWorld();
    this.builds.showGhost(null);
    this.hud.elim(null);
    this.hud.lobby(null);
    this.hud.show(false);
    this.input.enabled = false;
    this.sfx.setStorm(0);
    this.sfx.setWind(0);
    document.body.classList.remove('dead', 'inbus', 'building');
  }
}
