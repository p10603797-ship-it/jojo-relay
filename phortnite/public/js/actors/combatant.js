// Shared logic for actors simulated on this client (the local player and owned bots):
// movement, inventory, weapons (spread/bloom/recoil/reload), healing, harvesting, building.
import * as THREE from 'three';
import {
  PLAYER, WEAPONS, AMMO, HEALS, MAT_KEYS, MAX_MATS, MAX_AMMO, BUILD, ANIM, FLAG, weaponDamage, itemKind, ENV,
} from '../../shared/constants.js';
import { Mover } from './mover.js';
import { Character } from './character.js';
import { GROUP } from '../physics.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();

export function forwardFromAngles(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Random direction inside a cone of half-angle `a` around dir (normalised). */
export function spreadDir(dir, a, out) {
  if (a <= 0) return out.copy(dir);
  const up = Math.abs(dir.y) > 0.95 ? _u.set(1, 0, 0) : _u.set(0, 1, 0);
  const right = _r.crossVectors(dir, up).normalize();
  const up2 = _v2.crossVectors(right, dir).normalize();
  const rr = a * Math.sqrt(Math.random());
  const phi = Math.random() * Math.PI * 2;
  const tx = Math.tan(rr) * Math.cos(phi), ty = Math.tan(rr) * Math.sin(phi);
  return out.copy(dir).addScaledVector(right, tx).addScaledVector(up2, ty).normalize();
}

export class Combatant {
  constructor(game, id, name, skin, isBot) {
    this.game = game;
    this.id = id;
    this.name = name;
    this.skin = skin;
    this.isBot = isBot;
    this.owned = true;
    this.mover = new Mover(game.physics, GROUP.PLAYER);
    this.char = new Character(skin, '', {});
    game.scene.add(this.char.group);
    this.hp = PLAYER.maxHp;
    this.sh = 0;
    this.alive = true;
    this.yaw = 0;
    this.pitch = 0;
    this.inv = { slots: [{ k: 'pickaxe', r: 0 }, null, null, null, null, null], ammo: {}, mats: { wood: 0, stone: 0, metal: 0 }, sel: 0 };
    for (const k of Object.keys(AMMO)) this.inv.ammo[k] = 0;
    this.cool = 0;
    this.bloom = 0;
    this.reloadT = -1;
    this.healT = -1;
    this.swingT = -1;
    this.lastShot = -10;
    this.buildMode = false;
    this.buildType = 'w';
    this.buildMat = 'wood';
    this.buildCool = 0;
    this.anim = ANIM.IDLE;
    this.flags = 0;
    this.ads = false;
    this.speed = 0;
    this.moveAngle = 0;
    this.stepAcc = 0;
    this.time = 0;
    this.inBus = false;
    this.pendingPick = new Set();
    this.lastHurt = -10;
    this.infinite = false; // lobby warm-up: infinite ammo + mats
  }

  get pos() { return this.mover.pos; }
  get mode() { return this.mover.mode; }
  get crouching() { return this.mover.crouch; }
  current() { return this.inv.slots[this.inv.sel]; }

  // ------------------------------------------------------------------ inventory
  resetInventory(loadout = null) {
    this.inv.slots = [{ k: 'pickaxe', r: 0 }, null, null, null, null, null];
    for (const k of Object.keys(this.inv.ammo)) this.inv.ammo[k] = 0;
    this.inv.mats = { wood: 0, stone: 0, metal: 0 };
    this.inv.sel = 0;
    this.reloadT = -1;
    this.healT = -1;
    this.buildMode = false;
    if (loadout) {
      loadout.slots.forEach((s, i) => { this.inv.slots[i + 1] = s ? { ...s } : null; });
      Object.assign(this.inv.ammo, loadout.ammo || {});
      Object.assign(this.inv.mats, loadout.mats || {});
    }
    this.onInventory();
  }

  onInventory() {}

  select(i) {
    if (i < 0 || i > 5) return;
    if (i !== 0 && !this.inv.slots[i]) return;
    if (this.inv.sel !== i) {
      this.reloadT = -1;
      this.healT = -1;
      this.cool = Math.max(this.cool, 0.12);
    }
    this.inv.sel = i;
    this.buildMode = false;
    this.onInventory();
  }

  cycle(dir) {
    let i = this.inv.sel;
    for (let n = 0; n < 6; n++) {
      i = (i + dir + 6) % 6;
      if (i === 0 || this.inv.slots[i]) { this.select(i); return; }
    }
  }

  freeSlot() {
    for (let i = 1; i <= 5; i++) if (!this.inv.slots[i]) return i;
    return -1;
  }

  /** Could this item be picked up without swapping anything? */
  canAutoPick(item) {
    const kind = itemKind(item.k);
    if (kind === 'ammo') return this.inv.ammo[item.k] < MAX_AMMO;
    if (kind === 'mat') return this.inv.mats[item.k] < MAX_MATS;
    if (kind === 'heal') {
      for (let i = 1; i <= 5; i++) {
        const s = this.inv.slots[i];
        if (s && s.k === item.k && s.n < HEALS[item.k].stack) return true;
      }
      return this.freeSlot() > 0;
    }
    if (kind === 'weapon') {
      for (let i = 1; i <= 5; i++) {
        const s = this.inv.slots[i];
        if (s && s.k === item.k && s.r >= item.r) return false; // already have an equal or better one
      }
      return this.freeSlot() > 0;
    }
    return false;
  }

  /** Add an item; returns items that had to be dropped (swaps / overflow). */
  addItem(item) {
    const drops = [];
    const kind = itemKind(item.k);
    if (kind === 'ammo') {
      const room = MAX_AMMO - this.inv.ammo[item.k];
      this.inv.ammo[item.k] += Math.min(room, item.n);
      if (item.n > room) drops.push({ k: item.k, n: item.n - room });
    } else if (kind === 'mat') {
      const room = MAX_MATS - this.inv.mats[item.k];
      this.inv.mats[item.k] += Math.min(room, item.n);
    } else if (kind === 'heal') {
      let left = item.n;
      const stack = HEALS[item.k].stack;
      for (let i = 1; i <= 5 && left > 0; i++) {
        const s = this.inv.slots[i];
        if (s && s.k === item.k && s.n < stack) {
          const add = Math.min(left, stack - s.n);
          s.n += add;
          left -= add;
        }
      }
      if (left > 0) {
        let slot = this.freeSlot();
        if (slot < 0) {
          slot = this.inv.sel > 0 ? this.inv.sel : 1;
          const old = this.inv.slots[slot];
          if (old) drops.push(old);
        }
        this.inv.slots[slot] = { k: item.k, n: Math.min(left, stack) };
        if (left > stack) drops.push({ k: item.k, n: left - stack });
      }
    } else if (kind === 'weapon') {
      let slot = this.freeSlot();
      if (slot < 0) {
        slot = this.inv.sel > 0 ? this.inv.sel : 1;
        const old = this.inv.slots[slot];
        if (old) drops.push(old);
      }
      this.inv.slots[slot] = { k: item.k, r: item.r | 0, m: item.m ?? WEAPONS[item.k].mag };
      if (this.inv.sel === 0 && !this.isBot) this.select(slot);
      if (this.inv.sel === slot) this.reloadT = -1;
    }
    this.onInventory();
    return drops;
  }

  allItems() {
    const out = [];
    for (let i = 1; i <= 5; i++) if (this.inv.slots[i]) out.push({ ...this.inv.slots[i] });
    for (const [k, n] of Object.entries(this.inv.ammo)) if (n > 0) out.push({ k, n });
    for (const [k, n] of Object.entries(this.inv.mats)) if (n > 0) out.push({ k, n: Math.min(n, 999) });
    return out;
  }

  // ------------------------------------------------------------------ geometry
  eyeHeight() { return this.mover.crouch ? 1.1 : PLAYER.eye; }

  shoulder(out) {
    const p = this.pos;
    const ry = this.yaw;
    // right vector for yaw (camera convention: forward = (-sin, 0, -cos))
    const rx = Math.cos(ry), rz = -Math.sin(ry);
    return out.set(p.x + rx * 0.28, p.y + (this.mover.crouch ? 1.05 : 1.45), p.z + rz * 0.28);
  }

  hitbox() {
    const p = this.pos;
    const c = this.mover.crouch;
    return {
      id: this.id,
      head: [p.x, p.y + (c ? 1.27 : 1.7), p.z, 0.22],
      body: [p.x, p.y + 0.35, p.z, p.x, p.y + (c ? 0.95 : 1.32), p.z, 0.37],
    };
  }

  // ------------------------------------------------------------------ movement
  move(dt, ctl) {
    const m = this.mover;
    // world-space wish direction from local input
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = -sy * ctl.my + cy * ctl.mx;
    let wz = -cy * ctl.my - sy * ctl.mx;
    const l = Math.hypot(wx, wz);
    if (l > 1) { wx /= l; wz /= l; }
    const busy = this.healT >= 0;
    const ev = m.step(dt, {
      wx, wz, sprint: ctl.sprint && ctl.my > 0.3 && !this.ads && !busy && this.reloadT < 0, crouch: ctl.crouch, jump: ctl.jump, ads: this.ads || busy, pitch: this.pitch,
    });
    if (ev.landed > PLAYER.fallSafe && this.mode === 'ground') {
      const dmg = (ev.landed - PLAYER.fallSafe) * PLAYER.fallDmgPerMs;
      this.game.reportFall(this, dmg);
    }
    if (ev.landed && this.game.onLanded) this.game.onLanded(this, ev.landed);
    if (ev.splash) this.game.fx.water(this.pos.x, this.pos.z);
    if (ev.jumped && this.game.onJump) this.game.onJump(this);
    const hs = Math.hypot(m.vel.x, m.vel.z);
    this.speed = hs;
    this.moveAngle = hs > 0.3 ? Math.atan2(m.vel.x, m.vel.z) - (this.yaw + Math.PI) : 0;
    while (this.moveAngle > Math.PI) this.moveAngle -= Math.PI * 2;
    while (this.moveAngle < -Math.PI) this.moveAngle += Math.PI * 2;
    // footsteps
    if (m.grounded && hs > 1) {
      this.stepAcc += dt * hs * (m.crouch ? 0.25 : 0.42);
      if (this.stepAcc > 1) {
        this.stepAcc = 0;
        this.game.onStep(this);
      }
    }
    // animation state
    let a = ANIM.IDLE;
    switch (m.mode) {
      case 'skydive': a = ANIM.SKYDIVE; break;
      case 'glide': a = ANIM.GLIDE; break;
      case 'air': a = ANIM.AIR; break;
      case 'swim': a = ANIM.RUN; break;
      default:
        if (m.crouch) a = hs > 0.5 ? ANIM.CROUCH_WALK : ANIM.CROUCH;
        else if (hs > 7) a = ANIM.SPRINT;
        else if (hs > 0.5) a = ANIM.RUN;
    }
    this.anim = a;
  }

  // ------------------------------------------------------------------ weapons
  spread(w) {
    const m = this.mover;
    let s = this.ads ? w.spreadAds : w.spread;
    if (!m.grounded) s *= 2.4;
    else if (this.speed > 1) s *= this.speed > 7 ? 1.9 : 1.45;
    if (m.crouch) s *= 0.75;
    s += this.bloom;
    if (w.firstShot && this.ads && this.time - this.lastShot > 0.45 && this.speed < 1 && m.grounded) s *= 0.05;
    return s;
  }

  freeAmmo() { return this.infinite || !!this.unlimitedAmmo; }

  canAct() { return this.alive && !this.inBus && this.mode !== 'skydive' && this.mode !== 'glide'; }

  /**
   * Weapon / item / build logic. aim = { ox, oy, oz, dx, dy, dz } (view ray) and target point (tx,ty,tz).
   */
  act(dt, ctl, aim) {
    this.time += dt;
    this.cool = Math.max(0, this.cool - dt);
    this.buildCool = Math.max(0, this.buildCool - dt);
    const cur = this.current();
    const w = cur ? WEAPONS[cur.k] : null;
    if (w && !w.melee) this.bloom = Math.max(0, this.bloom - dt * (w.bloomMax ? w.bloomMax * 2.2 : 0.1));
    this.flags = 0;
    if (!this.canAct()) { this.ads = false; this.reloadT = -1; this.healT = -1; return; }

    if (this.buildMode) {
      this.ads = false;
      this.flags |= FLAG.BUILD;
      if (ctl.firePressed || (ctl.fire && this.buildCool <= 0)) {
        this.game.tryPlaceBuild(this);
        this.buildCool = 0.11;
      }
      return;
    }
    this.ads = !!ctl.ads && !!w && !w.melee;
    if (this.ads) this.flags |= FLAG.ADS;

    // reload
    if (this.reloadT >= 0 && w && w.mag) {
      this.reloadT += dt;
      this.flags |= FLAG.RELOAD;
      if (this.reloadT >= w.reload) {
        const need = w.mag - cur.m;
        const have = this.freeAmmo() ? need : Math.min(need, this.inv.ammo[w.ammo]);
        cur.m += have;
        if (!this.freeAmmo()) this.inv.ammo[w.ammo] -= have;
        this.reloadT = -1;
        this.onInventory();
      }
    }
    if (ctl.reload && w && w.mag && cur.m < w.mag && this.reloadT < 0) this.startReload();

    // healing items
    if (cur && HEALS[cur.k]) {
      const h = HEALS[cur.k];
      const useful = (h.hp && this.hp < h.cap) || (h.sh && this.sh < h.cap);
      if (ctl.fire && useful) {
        if (this.healT < 0) { this.healT = 0; this.game.onHealStart(this, cur.k); }
        this.healT += dt;
        this.flags |= FLAG.HEAL;
        if (this.healT >= h.time) {
          this.healT = -1;
          this.game.reportHeal(this, cur.k);
          cur.n -= 1;
          if (cur.n <= 0) { this.inv.slots[this.inv.sel] = null; this.select(0); }
          this.onInventory();
        }
      } else this.healT = -1;
      return;
    }

    if (!w) return;
    if (w.melee) {
      if (ctl.fire && this.cool <= 0) {
        this.cool = 1 / w.rate;
        this.swingT = 0;
        this.char.playSwing();
        this.game.onSwing(this);
      }
      if (this.swingT >= 0) {
        this.swingT += dt;
        if (this.swingT >= 0.16) { this.swingT = -1; this.game.meleeHit(this, aim); }
      }
      if (this.swingT >= 0 || this.cool > 0.2) this.flags |= FLAG.SWING;
      return;
    }

    const want = w.auto ? ctl.fire : ctl.firePressed || (ctl.fire && this.isBot);
    if (want && this.cool <= 0 && this.reloadT < 0) {
      if (cur.m <= 0) {
        if (this.freeAmmo() || this.inv.ammo[w.ammo] > 0) this.startReload();
        else this.game.onDryFire(this);
        this.cool = 0.25;
      } else {
        this.fire(cur, w, aim);
      }
    }
    if (this.time - this.lastShot < 0.12) this.flags |= FLAG.FIRING;
  }

  startReload() {
    const cur = this.current();
    const w = cur && WEAPONS[cur.k];
    if (!w || !w.mag || cur.m >= w.mag) return;
    if (!this.freeAmmo() && this.inv.ammo[w.ammo] <= 0) return;
    this.reloadT = 0;
    this.game.onReload(this);
  }

  fire(cur, w, aim) {
    cur.m--;
    this.cool = 1 / w.rate;
    const spread = this.spread(w);
    this.bloom = Math.min(w.bloomMax || 0, this.bloom + (w.bloom || 0));
    this.lastShot = this.time;
    const origin = this.shoulder(_v);
    const dir = _v2.set(aim.tx - origin.x, aim.ty - origin.y, aim.tz - origin.z);
    if (dir.lengthSq() < 0.01) dir.set(aim.dx, aim.dy, aim.dz);
    dir.normalize();
    // never shoot "backwards" through the player's own body when aiming at something very close
    const fwd = _r.set(aim.dx, aim.dy, aim.dz);
    if (dir.dot(fwd) < 0.2) dir.copy(fwd);
    const dirs = [];
    const pellets = w.pellets || 1;
    const shot = (this.game.shotSeq = (this.game.shotSeq || 0) + 1);
    const d = new THREE.Vector3();
    const base = dir.clone();
    for (let i = 0; i < pellets; i++) {
      spreadDir(base, pellets > 1 ? spread * (0.35 + 0.65 * Math.sqrt((i + 0.5) / pellets)) : spread, d);
      dirs.push(d.x, d.y, d.z);
    }
    this.game.spawnShot(this, cur, w, origin.clone(), dirs, shot);
    if (this.onFired) this.onFired(w);
    if (cur.m <= 0 && (this.freeAmmo() || this.inv.ammo[w.ammo] > 0)) this.startReload();
    this.onInventory();
  }

  harvestYield(info) {
    const mat = info && info.mat;
    if (mat === 'wood') return ['wood', ENV.harvest.wood];
    if (mat === 'stone') return ['stone', ENV.harvest.stone];
    if (mat === 'metal') return ['metal', ENV.harvest.metal];
    return null;
  }

  addMats(k, n) {
    this.inv.mats[k] = Math.min(MAX_MATS, this.inv.mats[k] + n);
    this.onInventory();
  }

  canBuild() {
    return this.infinite || this.inv.mats[this.buildMat] >= BUILD.cost;
  }

  spendBuild() {
    if (!this.infinite) this.inv.mats[this.buildMat] -= BUILD.cost;
    this.onInventory();
  }

  /** Pick a material we can afford, preferring the current one. */
  autoMat() {
    if (this.canBuild()) return true;
    for (const m of MAT_KEYS) {
      if (this.inv.mats[m] >= BUILD.cost) { this.buildMat = m; return true; }
    }
    return false;
  }

  setPoseFromState() {
    const c = this.char;
    c.group.position.copy(this.pos);
    c.group.rotation.y = this.yaw + Math.PI;
  }

  animate(dt) {
    if (this.isBot && this.game.isFar(this.pos) && !this.char.ragdoll) {
      this.char.group.visible = false;
      return;
    }
    if (this.isBot && this.alive) this.char.group.visible = true;
    const cur = this.current();
    const w = cur ? WEAPONS[cur.k] : null;
    this.char.setWeapon(cur && !this.buildMode ? cur.k : null, cur ? cur.r | 0 : 0);
    this.setPoseFromState();
    this.char.update(dt, {
      anim: this.anim, speed: this.speed, moveAngle: this.moveAngle, pitch: this.pitch, ads: this.ads,
      gun: !!(w && !w.melee), building: this.buildMode, healing: this.healT >= 0,
      reload: this.reloadT >= 0 && w ? this.reloadT / w.reload : -1,
    });
  }

  stateArray() {
    const p = this.pos, v = this.mover.vel;
    const cur = this.current();
    let wk = cur ? cur.k : 'pickaxe';
    if (this.buildMode) wk = 'build';
    return [
      Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100,
      Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, Math.round(v.z * 10) / 10,
      Math.round(this.yaw * 1000) / 1000, Math.round(this.pitch * 1000) / 1000, this.anim,
      cur && cur.r ? `${wk}:${cur.r}` : wk, this.flags,
    ];
  }

  die(impulse) {
    this.alive = false;
    this.reloadT = -1;
    this.healT = -1;
    this.buildMode = false;
    this.mover.mode = 'dead';
    this.mover.setEnabled(false);
    this.char.startRagdoll(this.game.physics, impulse);
  }

  respawn(x, y, z) {
    this.alive = true;
    this.hp = PLAYER.maxHp;
    this.sh = 0;
    this.char.endRagdoll();
    this.char.setVisible(true);
    this.mover.setEnabled(true);
    this.mover.mode = 'air';
    this.mover.teleport(x, y, z);
  }

  dispose() {
    this.mover.remove();
    this.char.dispose();
    this.game.scene.remove(this.char.group);
  }
}

export { weaponDamage };
