// Authoritative game room. Transport agnostic: the Node server feeds it WebSocket
// connections, and solo mode runs the very same code inside the browser.
//
// A connection is any object with { id, send(obj), ip }.
import {
  MAP, BUILD, MAT_KEYS, PLAYER, WEAPONS, WEAPON_KEYS, AMMO, HEALS, STORM, BUS, SKINS, BOT_NAMES,
  RARITY_WEIGHTS, clampRarity, weaponDamage, MAX_MATS, PROTOCOL, ANIM,
} from './constants.js';
import { generateWorld } from './worldgen.js';
import { BuildGrid, parseKey } from './buildgrid.js';

let sharedWorld = null;
export function getWorld() {
  if (!sharedWorld) sharedWorld = generateWorld(MAP.seed);
  return sharedWorld;
}

const MAX_HUMANS = 16;
const MAX_TOTAL = 32;
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16) || 'Player';

function pickWeighted(weights, rnd = Math.random) {
  let total = 0;
  for (const w of weights) total += w;
  let x = rnd() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

const WEAPON_WEIGHTS = { ar: 30, smg: 18, shotgun: 24, pistol: 14, sniper: 8, rocket: 6 };

export function rollWeapon(boost = 0) {
  const keys = Object.keys(WEAPON_WEIGHTS);
  const k = keys[pickWeighted(keys.map((x) => WEAPON_WEIGHTS[x]))];
  const r = clampRarity(k, Math.min(4, pickWeighted(RARITY_WEIGHTS) + boost));
  return { k, r, m: WEAPONS[k].mag };
}

export class Room {
  constructor({ code = 'SOLO', name = 'Party', solo = false, now = () => Date.now(), log = () => {} } = {}) {
    this.code = code;
    this.name = name;
    this.solo = solo;
    this.now = now;
    this.log = log;
    this.created = now();
    this.world = getWorld();
    this.destroyed = new Set();
    this.objHp = new Map();
    this.grid = new BuildGrid(this.world.heightAt, this.world.solidNear);
    this.grid.destroyedObjects = this.destroyed;
    this.players = new Map();
    this.conns = new Map();   // connId -> { conn, pid }
    this.nextId = 1;
    this.phase = 'lobby';
    this.phaseEnds = 0;
    this.leader = 0;
    this.settings = { bots: solo ? 19 : 8, mats: 0, mode: 'ffa' };
    this.loot = new Map();
    this.nextLoot = 1;
    this.chestsOpened = new Set();
    this.storm = null;
    this.bus = null;
    this.match = 0;
    this.stormTick = 0;
    this.lastTick = now();
    this.empty = false;
    this.winner = null;
  }

  // ------------------------------------------------------------------ util
  humans() { return [...this.players.values()].filter((p) => !p.bot); }
  alivePlayers() { return [...this.players.values()].filter((p) => p.alive); }

  send(conn, msg) { try { conn.send(msg); } catch (e) { /* ignore */ } }

  broadcast(msg, exceptConnId = null) {
    for (const { conn } of this.conns.values()) {
      if (conn.id !== exceptConnId) this.send(conn, msg);
    }
  }

  connOf(p) {
    const ownerId = p.bot ? p.owner : p.id;
    for (const c of this.conns.values()) if (c.pid === ownerId) return c.conn;
    return null;
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, skin: p.skin, bot: p.bot, alive: p.alive, kills: p.kills, spec: p.spectator, team: p.team,
    }));
  }

  publicInfo(ip) {
    const humans = this.humans();
    return {
      code: this.code, name: this.name, phase: this.phase, players: humans.length,
      max: MAX_HUMANS, sameNet: !!ip && humans.some((p) => p.ip === ip),
    };
  }

  /** Which player may this connection act as? */
  actor(connId, id) {
    const c = this.conns.get(connId);
    if (!c) return null;
    if (id === undefined || id === null || id === c.pid) return this.players.get(c.pid) || null;
    const p = this.players.get(id);
    if (p && p.bot && p.owner === c.pid) return p;
    return null;
  }

  // ------------------------------------------------------------------ connections
  join(conn, hello = {}) {
    if (this.humans().length >= MAX_HUMANS) {
      this.send(conn, { t: 'err', msg: 'This party is full.' });
      return false;
    }
    const id = this.nextId++;
    const p = this.makePlayer(id, cleanName(hello.name), clampN(num(hello.skin) | 0, 0, SKINS.length - 1), false);
    p.ip = conn.ip || '';
    if (this.phase === 'lobby') {
      p.alive = true;
    } else {
      p.alive = false;
      p.spectator = true;
    }
    this.players.set(id, p);
    this.conns.set(conn.id, { conn, pid: id });
    if (!this.leader || !this.players.get(this.leader)) this.leader = id;
    this.send(conn, this.welcome(id));
    this.broadcast({ t: 'roster', players: this.roster(), leader: this.leader }, conn.id);
    this.broadcast({ t: 'note', msg: `${p.name} joined the party` }, conn.id);
    this.log('join', { room: this.code, id, name: p.name });
    return true;
  }

  leave(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    const p = this.players.get(c.pid);
    if (p) {
      if (p.alive && (this.phase === 'match' || this.phase === 'bus')) this.eliminate(p, null, { c: 'left' });
      this.players.delete(p.id);
      this.broadcast({ t: 'note', msg: `${p.name} left` });
    }
    const humans = this.humans();
    if (!humans.length) {
      this.empty = true;
      return;
    }
    if (this.leader === c.pid) this.leader = humans[0].id;
    this.reassignBots();
    this.broadcast({ t: 'roster', players: this.roster(), leader: this.leader });
  }

  makePlayer(id, name, skin, bot) {
    return {
      id, name, skin, bot, owner: 0, alive: false, spectator: false, hp: PLAYER.maxHp, sh: 0, kills: 0, team: id,
      x: 0, y: 60, z: 0, vx: 0, vy: 0, vz: 0, yw: 0, pt: 0, a: ANIM.IDLE, w: 'pickaxe', f: 0,
      inBus: false, ip: '', lastSeen: this.now(),
    };
  }

  reassignBots() {
    const owner = this.players.get(this.leader);
    if (!owner) return;
    const own = [];
    for (const p of this.players.values()) {
      if (p.bot) { p.owner = owner.id; own.push(p.id); }
    }
    const conn = this.connOf(owner);
    if (conn) this.send(conn, { t: 'bots', own });
  }

  welcome(id) {
    return {
      t: 'welcome', v: PROTOCOL, you: id, code: this.code, name: this.name, solo: this.solo,
      checksum: this.world.checksum, phase: this.phase, leader: this.leader, settings: this.settings,
      players: this.roster(),
      builds: [...this.grid.pieces.values()].map((b) => this.pieceMsg(b)),
      destroyed: [...this.destroyed],
      loot: [...this.loot.values()],
      chests: [...this.chestsOpened],
      bus: this.bus ? this.busMsg() : null,
      match: this.match,
    };
  }

  // ------------------------------------------------------------------ messages
  message(connId, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const c = this.conns.get(connId);
    if (!c) return;
    const h = this.handlers[msg.t];
    if (!h) return;
    try {
      h.call(this, c, msg);
    } catch (e) {
      this.log('handler error', { t: msg.t, err: String(e && e.stack || e) });
    }
  }

  get handlers() {
    return HANDLERS;
  }

  // ------------------------------------------------------------------ match flow
  startMatch() {
    if (this.phase !== 'lobby') return;
    this.match++;
    this.phase = 'bus';
    this.winner = null;
    this.resetWorldState();
    // remove stale bots, create new ones
    for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
    const humans = this.humans();
    const botCount = clampN(this.settings.bots | 0, 0, Math.max(0, MAX_TOTAL - humans.length));
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < botCount; i++) {
      const id = this.nextId++;
      const b = this.makePlayer(id, names[i % names.length], Math.floor(Math.random() * SKINS.length), true);
      b.owner = this.leader;
      this.players.set(id, b);
    }
    const squad = this.settings.mode === 'squad';
    for (const p of this.players.values()) {
      p.alive = true;
      p.spectator = false;
      p.hp = PLAYER.maxHp;
      p.sh = 0;
      p.kills = 0;
      p.inBus = true;
      p.a = ANIM.BUS;
      // squad mode: every human on the same team against the bots
      p.team = squad && !p.bot ? 1 : 1000 + p.id;
    }
    // bus path across the island
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const off = (Math.random() - 0.5) * 140;
    const ax = -dx * BUS.length / 2 - dz * off, az = -dz * BUS.length / 2 + dx * off;
    this.bus = { ax, az, bx: ax + dx * BUS.length, bz: az + dz * BUS.length, y: BUS.height, speed: BUS.speed, t0: this.now() };
    // storm
    const busTime = BUS.length / BUS.speed;
    this.storm = { i: 0, cx: 0, cz: 0, r: STORM.startRadius, ncx: 0, ncz: 0, nr: STORM.startRadius, state: 'wait', t0: this.now(), tEnd: 0 };
    this.pickNextCircle();
    this.storm.tEnd = this.now() + (busTime + STORM.phases[0].wait) * 1000;
    this.spawnInitialLoot();
    this.broadcast({
      t: 'start', match: this.match, bus: this.busMsg(), players: this.roster(), leader: this.leader,
      loot: [...this.loot.values()], settings: this.settings,
    });
    this.reassignBots();
    this.log('match start', { room: this.code, players: this.players.size });
  }

  resetWorldState() {
    this.grid.clear();
    this.destroyed.clear();
    this.objHp.clear();
    this.loot.clear();
    this.chestsOpened.clear();
  }

  busMsg() {
    const b = this.bus;
    return { ax: b.ax, az: b.az, bx: b.bx, bz: b.bz, y: b.y, speed: b.speed, el: (this.now() - b.t0) / 1000 };
  }

  busPos() {
    const b = this.bus;
    const t = Math.min(1, ((this.now() - b.t0) / 1000) * b.speed / BUS.length);
    // everyone still on board is pushed out before the bus leaves the island
    return { x: b.ax + (b.bx - b.ax) * t, y: b.y, z: b.az + (b.bz - b.az) * t, done: t >= BUS.forceDrop };
  }

  pickNextCircle() {
    const s = this.storm;
    const ph = STORM.phases[s.i];
    s.nr = s.r * ph.ratio;
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * (s.r - s.nr) * 0.9;
      const x = s.cx + Math.cos(a) * d, z = s.cz + Math.sin(a) * d;
      if (Math.sqrt(x * x + z * z) + s.nr * 0.35 < 215 && this.world.heightAt(x, z) > 1.5) {
        s.ncx = x; s.ncz = z;
        return;
      }
    }
    s.ncx = s.cx * 0.6; s.ncz = s.cz * 0.6;
  }

  stormNow() {
    const s = this.storm;
    if (!s) return null;
    if (s.state !== 'shrink') return { cx: s.cx, cz: s.cz, r: s.r };
    const t = clampN((this.now() - s.t0) / (s.tEnd - s.t0), 0, 1);
    return { cx: s.cx + (s.ncx - s.cx) * t, cz: s.cz + (s.ncz - s.cz) * t, r: s.r + (s.nr - s.r) * t };
  }

  updateStorm() {
    const s = this.storm;
    if (!s || s.state === 'done') return;
    const now = this.now();
    if (now < s.tEnd) return;
    if (s.state === 'wait') {
      s.state = 'shrink';
      s.t0 = now;
      s.tEnd = now + STORM.phases[s.i].shrink * 1000;
      this.broadcast({ t: 'note', msg: 'The storm eye is shrinking!', storm: true });
    } else {
      s.cx = s.ncx; s.cz = s.ncz; s.r = s.nr;
      s.i++;
      if (s.i >= STORM.phases.length) {
        s.state = 'done';
        s.i = STORM.phases.length - 1;
        return;
      }
      s.state = 'wait';
      s.t0 = now;
      s.tEnd = now + STORM.phases[s.i].wait * 1000;
      this.pickNextCircle();
      this.broadcast({ t: 'note', msg: `Storm eye shrinks in ${STORM.phases[s.i].wait} seconds`, storm: true });
    }
  }

  stormMsg() {
    const s = this.storm;
    if (!s) return null;
    const cur = this.stormNow();
    const ph = STORM.phases[Math.min(s.i, STORM.phases.length - 1)];
    return [
      r2(cur.cx), r2(cur.cz), r2(cur.r), r2(s.ncx), r2(s.ncz), r2(s.nr),
      Math.max(0, Math.round((s.tEnd - this.now()) / 1000)), s.state === 'shrink' ? 1 : s.state === 'done' ? 2 : 0, s.i, ph.dps,
    ];
  }

  eliminate(victim, killer, info = {}) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.sh = 0;
    victim.a = ANIM.DEAD;
    if (killer && killer !== victim) killer.kills++;
    const left = this.alivePlayers().length;
    this.broadcast({
      t: 'elim', v: victim.id, k: killer ? killer.id : 0, w: info.w || '', hs: !!info.hs, c: info.c || 'gun',
      place: left + 1, x: r2(victim.x), y: r2(victim.y), z: r2(victim.z),
    });
    this.checkWin();
  }

  checkWin() {
    if (this.phase !== 'match' && this.phase !== 'bus') return;
    const alive = this.alivePlayers();
    const humansAlive = alive.filter((p) => !p.bot).length;
    const teams = new Set(alive.map((p) => p.team));
    if (teams.size <= 1 || humansAlive === 0) {
      let w = teams.size === 1 ? alive.find((p) => !p.bot) || alive[0] : null;
      if (!w && humansAlive === 0 && alive.length > 1) {
        w = alive.slice().sort((a, b) => b.kills - a.kills)[0];
      }
      const squad = w && this.settings.mode === 'squad' && !w.bot && alive.filter((p) => p.team === w.team).length > 1;
      this.phase = 'ended';
      this.winner = w ? w.id : 0;
      this.phaseEnds = this.now() + (humansAlive === 0 && teams.size > 1 ? 7000 : 10000);
      this.broadcast({
        t: 'win', id: this.winner, team: w ? w.team : 0, name: squad ? 'Your squad' : w ? w.name : '', bot: w ? w.bot : false, early: teams.size > 1,
      });
    }
  }

  sameTeam(a, b) { return a !== b && a.team === b.team; }

  returnToLobby() {
    this.phase = 'lobby';
    this.storm = null;
    this.bus = null;
    this.resetWorldState();
    for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
    for (const p of this.players.values()) {
      p.alive = true;
      p.spectator = false;
      p.hp = PLAYER.maxHp;
      p.sh = 0;
      p.inBus = false;
      p.a = ANIM.IDLE;
      p.team = p.id;
    }
    this.broadcast({ t: 'lobby', players: this.roster(), leader: this.leader, settings: this.settings });
  }

  // ------------------------------------------------------------------ damage
  applyDamage(target, amount, attacker, info = {}) {
    if (!target.alive || amount <= 0) return;
    let rest = amount;
    let shieldHit = 0;
    if (!info.ignoreShield && target.sh > 0) {
      shieldHit = Math.min(target.sh, rest);
      target.sh -= shieldHit;
      rest -= shieldHit;
    }
    target.hp = Math.max(0, target.hp - rest);
    this.broadcast({
      t: 'dmg', a: attacker ? attacker.id : 0, tg: target.id, amt: Math.round(amount), hs: !!info.hs,
      shd: shieldHit > 0 ? 1 : 0, hp: Math.ceil(target.hp), sh: Math.ceil(target.sh), c: info.c || 'gun',
      x: info.x, y: info.y, z: info.z,
    });
    if (target.hp <= 0) this.eliminate(target, attacker, info);
  }

  damageAllowed() { return this.phase === 'match' || this.phase === 'bus'; }

  // ------------------------------------------------------------------ builds
  pieceMsg(b) { return { k: b.k, m: b.m, d: b.d | 0, hp: Math.round(this.pieceHp(b)), max: b.max, by: b.by, age: (this.now() - b.born) / 1000 }; }

  pieceHp(b) {
    const now = this.now();
    if (b.t1 < b.growUntil) {
      const until = Math.min(now, b.growUntil);
      b.hp = Math.min(b.max, b.hp + b.rate * (until - b.t1) / 1000);
      b.t1 = until;
    }
    return b.hp;
  }

  damagePiece(k, dmg, attacker) {
    const b = this.grid.get(k);
    if (!b) return;
    const hp = this.pieceHp(b) - dmg;
    b.hp = hp;
    if (hp > 0) {
      if (attacker) {
        const conn = this.connOf(attacker);
        if (conn) this.send(conn, { t: 'bh', k, hp: Math.round(hp), max: b.max });
      }
      return;
    }
    this.destroyPieces([k]);
  }

  destroyPieces(keys) {
    const removed = [];
    for (const k of keys) {
      const p = this.grid.remove(k);
      if (p) removed.push(p);
    }
    if (!removed.length) return;
    const fallen = this.grid.collapseFrom(removed);
    for (const k of fallen) this.grid.remove(k);
    this.broadcast({ t: 'b-', k: removed.map((p) => p.k), c: fallen });
  }

  damageObject(oid, dmg, attacker) {
    const o = this.world.objects[oid];
    if (!o || this.destroyed.has(oid) || !(o.hp > 0)) return;
    const hp = (this.objHp.has(oid) ? this.objHp.get(oid) : o.hp) - dmg;
    if (hp > 0) {
      this.objHp.set(oid, hp);
      return;
    }
    this.objHp.delete(oid);
    this.destroyed.add(oid);
    this.broadcast({ t: 'ox', o: oid, by: attacker ? attacker.id : 0 });
    // pieces leaning on this object may now collapse
    const near = [];
    const pad = 4.5;
    const bx0 = o.x - (o.hx || 3) - pad, bx1 = o.x + (o.hx || 3) + pad;
    const bz0 = o.z - (o.hz || 3) - pad, bz1 = o.z + (o.hz || 3) + pad;
    for (const p of this.grid.pieces.values()) {
      const x = p.cx * BUILD.cell, z = p.cz * BUILD.cell;
      if (x > bx0 && x < bx1 && z > bz0 && z < bz1 && !this.grid.grounded(p)) near.push(p);
    }
    if (near.length) {
      // collapse check: test each nearby piece's connected component directly
      const doomed = new Set();
      for (const p of near) {
        if (doomed.has(p.k) || !this.grid.has(p.k)) continue;
        const seen = new Set([p.k]);
        const q = [p.k];
        let ok = false;
        while (q.length && seen.size < 3000) {
          const k = q.shift();
          const piece = this.grid.get(k);
          if (!piece) continue;
          if (this.grid.grounded(piece)) { ok = true; break; }
          for (const n of this.grid.neighbors(piece)) if (!seen.has(n)) { seen.add(n); q.push(n); }
        }
        if (!ok) for (const k of seen) doomed.add(k);
      }
      if (doomed.size) {
        for (const k of doomed) this.grid.remove(k);
        this.broadcast({ t: 'b-', k: [], c: [...doomed] });
      }
    }
  }

  // ------------------------------------------------------------------ loot
  addLoot(item, x, y, z) {
    const id = this.nextLoot++;
    const l = { id, item, x: r2(x), y: r2(y), z: r2(z) };
    this.loot.set(id, l);
    return l;
  }

  spawnInitialLoot() {
    for (const s of this.world.lootSpots) {
      const roll = Math.random();
      const jitter = () => (Math.random() - 0.5) * 1.2;
      if (roll < 0.56) {
        const w = rollWeapon();
        this.addLoot(w, s.x + jitter(), s.y, s.z + jitter());
        const am = WEAPONS[w.k].ammo;
        this.addLoot({ k: am, n: AMMO[am].pickup }, s.x + jitter(), s.y, s.z + jitter());
      } else if (roll < 0.74) {
        const keys = Object.keys(HEALS);
        const k = keys[pickWeighted([30, 10, 30, 14])];
        this.addLoot({ k, n: HEALS[k].give }, s.x + jitter(), s.y, s.z + jitter());
      } else if (roll < 0.9) {
        const keys = Object.keys(AMMO);
        const k = keys[pickWeighted([30, 30, 12, 22, 6])];
        this.addLoot({ k, n: AMMO[k].pickup }, s.x + jitter(), s.y, s.z + jitter());
      } else {
        const k = MAT_KEYS[pickWeighted([5, 3, 2])];
        this.addLoot({ k, n: 30 }, s.x + jitter(), s.y, s.z + jitter());
      }
    }
  }

  openChest(ci) {
    const c = this.world.chests[ci];
    if (!c || this.chestsOpened.has(ci)) return;
    this.chestsOpened.add(ci);
    const items = [];
    const w = rollWeapon(1);
    items.push(w);
    const am = WEAPONS[w.k].ammo;
    items.push({ k: am, n: AMMO[am].pickup });
    if (Math.random() < 0.6) {
      const keys = Object.keys(HEALS);
      const k = keys[pickWeighted([25, 12, 30, 18])];
      items.push({ k, n: HEALS[k].give });
    } else {
      items.push({ k: 'wood', n: 30 });
    }
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    const spawned = items.map((it, i) => {
      const side = (i - 1) * 0.7;
      return this.addLoot(it, c.x + fx * 1.3 + fz * side, c.y + 0.1, c.z + fz * 1.3 - fx * side);
    });
    this.broadcast({ t: 'chest', c: ci });
    this.broadcast({ t: 'l+', items: spawned });
  }

  // ------------------------------------------------------------------ tick
  tick() {
    const now = this.now();
    this.lastTick = now;

    if (this.phase === 'bus' && this.bus) {
      const bp = this.busPos();
      for (const p of this.players.values()) {
        if (p.inBus) { p.x = bp.x; p.y = bp.y; p.z = bp.z; }
      }
      if (bp.done) {
        const force = [];
        for (const p of this.players.values()) {
          if (p.inBus) { p.inBus = false; force.push(p.id); }
        }
        if (force.length) this.broadcast({ t: 'forcedrop', ids: force, x: bp.x, y: bp.y, z: bp.z });
        this.phase = 'match';
      }
    }

    if (this.phase === 'bus' || this.phase === 'match') {
      this.updateStorm();
      if (now - this.stormTick >= 1000) {
        this.stormTick = now;
        const st = this.stormNow();
        const dps = STORM.phases[Math.min(this.storm.i, STORM.phases.length - 1)].dps;
        for (const p of this.players.values()) {
          if (!p.alive || p.inBus) continue;
          const dx = p.x - st.cx, dz = p.z - st.cz;
          if (dx * dx + dz * dz > st.r * st.r) this.applyDamage(p, dps, null, { c: 'storm', ignoreShield: true });
        }
      }
    }

    if (this.phase === 'ended' && now >= this.phaseEnds) this.returnToLobby();

    const P = [];
    for (const p of this.players.values()) {
      P.push([p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yw), r2(p.pt), p.alive ? (p.inBus ? ANIM.BUS : p.a) : ANIM.DEAD, p.w, p.f,
        Math.ceil(p.hp), Math.ceil(p.sh), r2(p.vx), r2(p.vy), r2(p.vz)]);
    }
    const snap = { t: 's', ts: now, phase: this.phase, p: P };
    if (this.storm) snap.st = this.stormMsg();
    if (this.phase === 'bus' && this.bus) {
      const bp = this.busPos();
      snap.bus = [r2(bp.x), r2(bp.y), r2(bp.z)];
    }
    if (this.phase === 'lobby') snap.alive = this.humans().length;
    else snap.alive = this.alivePlayers().length;
    this.broadcast(snap);
  }
}

// ------------------------------------------------------------------ handlers
function setState(p, s) {
  if (!Array.isArray(s) || s.length < 11) return;
  if (!p.inBus) {
    p.x = clampN(num(s[0], p.x), -400, 400);
    p.y = clampN(num(s[1], p.y), -50, 400);
    p.z = clampN(num(s[2], p.z), -400, 400);
  }
  p.vx = clampN(num(s[3]), -80, 80);
  p.vy = clampN(num(s[4]), -80, 80);
  p.vz = clampN(num(s[5]), -80, 80);
  p.yw = num(s[6]);
  p.pt = clampN(num(s[7]), -2, 2);
  if (p.alive && !p.inBus) p.a = clampN(num(s[8]) | 0, 0, 9);
  p.w = typeof s[9] === 'string' ? s[9].slice(0, 12) : 'pickaxe';
  p.f = num(s[10]) | 0;
  p.lastSeen = Date.now();
}

const HANDLERS = {
  ping(c, m) {
    this.send(c.conn, { t: 'pong', c: m.c, ts: this.now() });
  },

  u(c, m) {
    const p = this.players.get(c.pid);
    if (p && (p.alive || this.phase === 'lobby')) setState(p, m.s);
  },

  ub(c, m) {
    if (!Array.isArray(m.b)) return;
    for (const row of m.b) {
      if (!Array.isArray(row)) continue;
      const p = this.actor(c.conn.id, row[0]);
      if (p && p.bot && p.alive) setState(p, row.slice(1));
    }
  },

  start(c, m) {
    if (c.pid !== this.leader || this.phase !== 'lobby') return;
    if (m.bots !== undefined) this.settings.bots = clampN(num(m.bots) | 0, 0, 30);
    if (m.mats !== undefined) this.settings.mats = clampN(num(m.mats) | 0, 0, MAX_MATS);
    if (m.mode === 'ffa' || m.mode === 'squad') this.settings.mode = m.mode;
    this.startMatch();
  },

  settings(c, m) {
    if (c.pid !== this.leader) return;
    if (m.bots !== undefined) this.settings.bots = clampN(num(m.bots) | 0, 0, 30);
    if (m.mats !== undefined) this.settings.mats = clampN(num(m.mats) | 0, 0, MAX_MATS);
    if (m.mode === 'ffa' || m.mode === 'squad') this.settings.mode = m.mode;
    this.broadcast({ t: 'settings', settings: this.settings });
  },

  end(c) {
    if (c.pid !== this.leader) return;
    if (this.phase === 'match' || this.phase === 'bus' || this.phase === 'ended') this.returnToLobby();
  },

  drop(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.inBus || this.phase !== 'bus') return;
    p.inBus = false;
    const bp = this.busPos();
    p.x = bp.x; p.y = bp.y - 3; p.z = bp.z;
    p.a = ANIM.SKYDIVE;
  },

  sh(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.alive) return;
    this.broadcast({ t: 'sh', id: p.id, w: String(m.w).slice(0, 12), o: m.o, d: m.d, r: m.r | 0 }, c.conn.id);
  },

  sw(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (p && p.alive) this.broadcast({ t: 'sw', id: p.id }, c.conn.id);
  },

  hit(c, m) {
    const a = this.actor(c.conn.id, m.id);
    const tg = this.players.get(m.tg);
    if (!a || !tg || !a.alive || !tg.alive || tg.inBus || a === tg) return;
    if (!this.damageAllowed() || this.sameTeam(a, tg)) return;
    const w = WEAPONS[m.w];
    if (!w) return;
    const r = clampRarity(m.w, num(m.r) | 0);
    const dist = clampN(num(m.d), 0, 2000);
    const pellets = w.pellets || 1;
    const n = clampN(num(m.n, 1) | 0, 0, pellets);
    const nh = clampN(num(m.nh) | 0, 0, pellets - n);
    if (n + nh <= 0) return;
    const dmg = n * weaponDamage(m.w, r, dist, false) + nh * weaponDamage(m.w, r, dist, true);
    this.applyDamage(tg, dmg, a, { w: m.w, hs: nh > 0, x: num(m.x), y: num(m.y), z: num(m.z) });
  },

  boom(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a) return;
    const w = WEAPONS[m.w];
    if (!w || !w.splash) return;
    const r = clampRarity(m.w, num(m.r) | 0);
    const x = num(m.x), y = num(m.y), z = num(m.z);
    this.broadcast({ t: 'boom', id: a.id, x: r2(x), y: r2(y), z: r2(z), w: m.w }, c.conn.id);
    const base = w.dmg[r];
    const R = w.splash;
    if (this.damageAllowed()) {
      for (const p of this.players.values()) {
        if (!p.alive || p.inBus || p === a || this.sameTeam(p, a)) continue;
        const dx = p.x - x, dy = p.y + 0.9 - y, dz = p.z - z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < R) this.applyDamage(p, base * (1 - 0.6 * d / R), a, { w: m.w, c: 'boom' });
      }
    }
    // structures
    const hit = [];
    for (const b of this.grid.pieces.values()) {
      const bx = b.cx * BUILD.cell + BUILD.cell / 2, by = b.cy * BUILD.level + BUILD.level / 2, bz = b.cz * BUILD.cell + BUILD.cell / 2;
      const d = Math.sqrt((bx - x) ** 2 + (by - y) ** 2 + (bz - z) ** 2);
      if (d < R + 2.5) hit.push([b.k, base * w.struct * (1 - 0.5 * Math.max(0, d - 2) / R)]);
    }
    for (const [k, d] of hit) this.damagePiece(k, d, a);
    for (const o of this.world.objects) {
      if (!(o.hp > 0)) continue;
      const dx = o.x - x, dz = o.z - z;
      if (Math.abs(dx) > R + 4 || Math.abs(dz) > R + 4) continue;
      const dy = o.y - y;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < R + 2) this.damageObject(o.id, base * 2.2 * (1 - 0.5 * d / (R + 2)), a);
    }
  },

  fall(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (!p || !p.alive || !this.damageAllowed()) return;
    this.applyDamage(p, clampN(num(m.d), 0, 200), null, { c: 'fall', ignoreShield: true });
  },

  heal(c, m) {
    const p = this.actor(c.conn.id, m.id);
    const h = HEALS[m.k];
    if (!p || !p.alive || !h) return;
    if (h.hp && p.hp < h.cap) p.hp = Math.min(h.cap, p.hp + h.hp);
    if (h.sh && p.sh < h.cap) p.sh = Math.min(h.cap, p.sh + h.sh);
  },

  od(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a) return;
    this.damageObject(num(m.o, -1) | 0, clampN(num(m.d), 0, 600), a);
  },

  b(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !a.alive || a.inBus) return;
    if (this.phase !== 'lobby' && this.phase !== 'match' && this.phase !== 'bus') return;
    const p = parseKey(m.k);
    if (!p || this.grid.has(m.k) || this.grid.pieces.size >= BUILD.maxPieces) {
      this.send(c.conn, { t: 'bno', k: m.k });
      return;
    }
    const mat = MAT_KEYS.includes(m.m) ? m.m : 'wood';
    p.k = m.k;
    p.d = clampN(num(m.d) | 0, 0, 3);
    if (!this.grid.canSupport(p)) {
      this.send(c.conn, { t: 'bno', k: m.k });
      return;
    }
    const spec = BUILD.mats[mat];
    const now = this.now();
    Object.assign(p, {
      m: mat, max: spec.hp, hp: spec.hp * BUILD.startFrac, born: now, t1: now, growUntil: now + spec.grow * 1000,
      rate: spec.hp * (1 - BUILD.startFrac) / spec.grow, by: a.id,
    });
    this.grid.add(p);
    this.broadcast({ t: 'b+', ...this.pieceMsg(p) });
  },

  bd(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a) return;
    this.damagePiece(String(m.k), clampN(num(m.d), 0, 1000), a);
  },

  pick(c, m) {
    const a = this.actor(c.conn.id, m.id);
    const l = this.loot.get(num(m.l) | 0);
    if (!a || !a.alive || !l) {
      this.send(c.conn, { t: 'gotno', l: m.l, id: m.id });
      return;
    }
    const dx = a.x - l.x, dz = a.z - l.z;
    if (dx * dx + dz * dz > 7 * 7) {
      this.send(c.conn, { t: 'gotno', l: m.l, id: m.id });
      return;
    }
    this.loot.delete(l.id);
    this.send(c.conn, { t: 'got', id: a.id, l: l.id, item: l.item, swap: m.swap });
    this.broadcast({ t: 'l-', l: l.id });
  },

  dropi(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !Array.isArray(m.items)) return;
    const out = [];
    for (const it of m.items.slice(0, 12)) {
      if (!it || typeof it.k !== 'string') continue;
      const k = it.k;
      let item = null;
      if (WEAPONS[k] && k !== 'pickaxe') item = { k, r: clampRarity(k, num(it.r) | 0), m: clampN(num(it.m) | 0, 0, WEAPONS[k].mag) };
      else if (AMMO[k]) item = { k, n: clampN(num(it.n) | 0, 1, 999) };
      else if (HEALS[k]) item = { k, n: clampN(num(it.n) | 0, 1, HEALS[k].stack) };
      else if (MAT_KEYS.includes(k)) item = { k, n: clampN(num(it.n) | 0, 1, MAX_MATS) };
      if (!item) continue;
      const ang = out.length * 1.3;
      const rad = it.near ? 0.4 : 0.8 + out.length * 0.15;
      out.push(this.addLoot(item, num(m.x, a.x) + Math.cos(ang) * rad, num(m.y, a.y) + 0.05, num(m.z, a.z) + Math.sin(ang) * rad));
    }
    if (out.length) this.broadcast({ t: 'l+', items: out });
  },

  chest(c, m) {
    const a = this.actor(c.conn.id, m.id);
    if (!a || !a.alive) return;
    const ci = num(m.c, -1) | 0;
    const ch = this.world.chests[ci];
    if (!ch) return;
    const dx = a.x - ch.x, dz = a.z - ch.z;
    if (dx * dx + dz * dz > 6 * 6) return;
    this.openChest(ci);
  },

  emote(c, m) {
    const p = this.actor(c.conn.id, m.id);
    if (p && p.alive) this.broadcast({ t: 'emote', id: p.id, e: num(m.e) | 0 }, c.conn.id);
  },
};
