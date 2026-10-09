// Game plugin for building and match feel (js/game/plugins.js has the hook interface):
// - build edits: the 'be' message, the EDIT button / G / hold B, one-tap presets (door, window,
//   arch, half wall, floor hole, reset) and the edit target outline
// - the touch HUD context (Input.setContext: what the fire button says, which buttons show) and the
//   interact button's item name + rarity colour
// - hit feedback that needs messages: enemy shield broken, elimination banner with streaks
// - sounds driven by game state: jump, land, storm siren, bus engine, low-health heartbeat, and the
//   listener's pitch for positional audio
import * as THREE from 'three';
import { WEAPONS, HEALS, BUILD } from '../../shared/constants.js';
import { EDIT_PRESETS, EDIT_FULL, editOf, floorHoleFor, editInReach, parseKey } from '../../shared/buildgrid.js';
// (no physics.js import: game plugins must load in Node for the contract tests; physics.raycast's
// default filter is the solid world + builds + props)

const EDIT_REACH = 4.5; // m from the player to the piece under the crosshair
// the room's edit reach (editInReach) less this much: your position reaches it a snapshot late
const EDIT_SLACK = 0.5;
const EDIT_GAP = 0.16; // s between two edits (the room allows one per 0.15 s)
const STREAK_GAP = 8; // s between eliminations that still count as a streak
const STREAK = ['', '', 'DOUBLE ELIM!', 'TRIPLE ELIM!', 'QUAD ELIM!', 'MEGA ELIM!'];
// edit choices: [preset, label]; the number keys / d-pad pick them in this order
export const EDIT_CHOICES = {
  w: [['door', 'DOOR'], ['window', 'WINDOW'], ['arch', 'ARCH'], ['half', 'HALF'], ['reset', 'RESET']],
  f: [['hole', 'HOLE'], ['reset', 'RESET']],
};
// gamepad d-pad while editing (s.build from Input.pollGamepad): up, right, down, left = choice 1-4
const PAD_PICK = { w: 0, c: 1, f: 2, r: 3 };

const _q = new THREE.Quaternion();

export class BuildClient {
  constructor(game) {
    this.game = game;
    this.target = null; // {k, x, y, z}: your (or a teammate's) wall / floor under the crosshair
    this.editing = null; // {k, t, x, z}: the piece whose edit choices are open
    this.editTs = new Map(); // actor id -> time of its last edit (you and the bots you run: one each)
    this.streak = 0;
    this.lastElimT = -99;
    this.heartT = 0;
    this.time = 0;
    this.lastPrompt = null;
    this.outline = null;
    game.buildClient = this;
    const hud = game.hud;
    if (hud) hud.onEditChip = (i) => this.pick(i);
  }

  // ------------------------------------------------------------------ messages
  onMessage(m) {
    const g = this.game;
    switch (m.t) {
      case 'be': {
        const p = g.builds.pieces.get(m.k);
        if (p && g.builds.setEdit(m.k, m.e) && p.by !== g.myId) g.sfx.edit?.(p.pos, false);
        break;
      }
      case 'dmg':
        // my shot broke an enemy's shield: crack icon, glass sound, blue shards
        if (m.a && m.a === g.myId && m.tg !== g.myId && m.shd && m.sh === 0 && m.c !== 'storm') {
          const t = g.actorById(m.tg);
          const x = Number.isFinite(m.x) ? m.x : t ? t.pos.x : 0;
          const y = Number.isFinite(m.y) ? m.y : t ? t.pos.y + 1.2 : 0;
          const z = Number.isFinite(m.z) ? m.z : t ? t.pos.z : 0;
          g.hud.shieldBreak?.();
          g.sfx.shieldCrack?.();
          g.fx.shards?.(x, y, z);
        }
        break;
      case 'elim':
        if (m.k && m.k === g.myId && m.v !== g.myId) {
          this.streak = this.time - this.lastElimT <= STREAK_GAP ? this.streak + 1 : 1;
          this.lastElimT = this.time;
          const label = STREAK[Math.min(this.streak, STREAK.length - 1)];
          g.hud.elimBanner?.(g.nameOf(m.v), g.kills, label);
          g.sfx.elimStinger?.(this.streak);
        }
        break;
      case 'note':
        if (m.storm) g.sfx.siren?.(/shrinking/i.test(m.msg || ''));
        break;
      default:
    }
  }

  onPhase(phase) {
    if (phase !== 'match' && phase !== 'bus') this.closeEdit();
    if (phase === 'bus' || phase === 'lobby') { this.streak = 0; this.lastElimT = -99; this.editTs.clear(); }
  }

  onMyDeath() { this.closeEdit(); }

  onJump(a) { if (a === this.game.me) this.game.sfx.jump?.(); }

  onLanded(a, speed) { if (a === this.game.me && speed > 3) this.game.sfx.land?.(speed); }

  // ------------------------------------------------------------------ edits
  /** Your (or a teammate's) wall or floor under the crosshair within reach, or null. */
  findTarget() {
    const g = this.game, me = g.me;
    // Zero Build has no edits, except in the lobby warm-up (where everyone builds: game.js
    // tryPlaceBuild and the room's edits plugin allow it there too)
    if (!me || !me.alive || me.inBus || !me.canAct() || (g.rules?.build === 'off' && g.phase !== 'lobby')) return null;
    const cam = g.camera;
    _q.copy(cam.quaternion);
    // camera forward = (0, 0, -1) rotated by its quaternion
    const fx = -2 * (_q.x * _q.z + _q.w * _q.y), fy = -2 * (_q.y * _q.z - _q.w * _q.x), fz = -(1 - 2 * (_q.x * _q.x + _q.y * _q.y));
    const o = cam.position;
    const h = g.physics.raycast(o.x, o.y, o.z, fx, fy, fz, 14);
    if (!h || !h.info || h.info.kind !== 'build') return null;
    const dx = h.x - me.pos.x, dy = h.y - (me.pos.y + 1), dz = h.z - me.pos.z;
    if (dx * dx + dy * dy + dz * dz > EDIT_REACH * EDIT_REACH) return null;
    const p = g.builds.pieces.get(h.info.key);
    if (!p || p.pending || EDIT_FULL[p.t] === undefined) return null;
    // only where the room will take the edit (its reach is to the piece's centre, not the hit point)
    if (!this.inReach(p.k, me)) return null;
    if (p.by !== me.id && !(g.phase !== 'lobby' && g.friendly(p.by, me.id))) return null;
    const t = this.target && this.target.k === p.k ? this.target : {};
    t.k = p.k; t.t = p.t; t.x = h.x; t.y = h.y; t.z = h.z;
    return t;
  }

  /** Would the room take an edit of piece k from actor a where a stands now? */
  inReach(k, a) {
    const pc = parseKey(k);
    return !!pc && !!a && editInReach(pc, a.pos.x, a.pos.y, a.pos.z, EDIT_SLACK);
  }

  openEdit(t) {
    this.editing = { k: t.k, t: t.t, x: t.x, z: t.z };
    const hint = !this.game.input.touchMode;
    this.game.hud.editChips?.(EDIT_CHOICES[t.t].map((c) => c[1]), hint);
    this.game.sfx.ui?.('click');
    this.showOutline(true);
  }

  closeEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.game.hud.editChips?.(null);
    this.showOutline(false);
  }

  /** Apply edit choice i (0-based) to the open piece. */
  pick(i) {
    const g = this.game, ed = this.editing;
    if (!ed) return;
    const p = g.builds.pieces.get(ed.k);
    const choice = EDIT_CHOICES[ed.t] && EDIT_CHOICES[ed.t][i];
    if (!p || !choice || !g.me || !g.me.alive) { this.closeEdit(); return; }
    if (this.time - this.lastEdit(g.me) < EDIT_GAP) return; // your own last edit (not a bot's)
    // walked out of reach with the choices still open: no edit the room would put back
    if (!this.inReach(ed.k, g.me)) { this.closeEdit(); return; }
    let e = choice[0] === 'hole' ? floorHoleFor(p, ed.x, ed.z) : EDIT_PRESETS[p.t][choice[0]];
    // the same edit again puts the piece back (tap DOOR twice: door shut)
    if (editOf(p) === e) e = EDIT_FULL[p.t];
    this.closeEdit();
    if (this.editPiece(g.me, p.k, e)) g.sfx.edit?.(p.pos, true);
  }

  /**
   * Edit a piece as actor a (you or a bot you own): applied here at once, confirmed or put back by
   * the room. Bots can call game.buildClient.editPiece(bot, key, mask) too.
   */
  editPiece(a, k, e) {
    const g = this.game;
    const p = g.builds.pieces.get(k);
    if (!p || !a || editOf(p) === e) return false;
    // the room takes one edit per 0.15 s from each actor: never send it one it would refuse
    if (this.time - this.lastEdit(a) < EDIT_GAP) return false;
    this.editTs.set(a.id, this.time);
    g.builds.setEdit(k, e);
    g.send({ t: 'be', id: a.id, k, e });
    return true;
  }

  /** When actor a last edited (-Infinity: never). */
  lastEdit(a) {
    const t = a ? this.editTs.get(a.id) : undefined;
    return t === undefined ? -Infinity : t;
  }

  filterInput(s) {
    const g = this.game, me = g.me;
    if (!me) return;
    if (this.editing) {
      // the number keys (1-5) and the d-pad pick an edit; Y (build toggle) resets
      const ch = EDIT_CHOICES[this.editing.t];
      let i = -1;
      if (s.slot >= 1 && s.slot <= ch.length) i = s.slot - 1;
      else if (s.slot >= 1 && s.slot <= 5 && this.editing.t === 'f' && s.slot === 5) i = ch.length - 1;
      if (s.build && this.game.input.lookDev === 'pad' && PAD_PICK[s.build] !== undefined) {
        i = Math.min(PAD_PICK[s.build], ch.length - 1);
        s.build = null;
      }
      if (s.buildToggle && this.game.input.lookDev === 'pad') { i = ch.length - 1; s.buildToggle = false; }
      if (s.slot >= 1) s.slot = -1;
      if (i >= 0) { this.pick(i); s.matCycle = false; return; }
      if (s.edit) { this.closeEdit(); s.matCycle = false; return; }
      if (s.firePressed || s.buildToggle || s.build) this.closeEdit();
      return;
    }
    if (!s.edit) return;
    const t = this.target || this.findTarget();
    if (!t) return; // nothing to edit: G keeps changing material
    s.matCycle = false;
    this.openEdit(t);
  }

  // ------------------------------------------------------------------ outline of the piece being edited
  showOutline(on) {
    const g = this.game;
    if (!on) { if (this.outline) this.outline.visible = false; return; }
    const p = this.editing && g.builds.pieces.get(this.editing.k);
    if (!p) return;
    if (!this.outline) {
      const C = BUILD.cell, L = BUILD.level;
      const mat = new THREE.LineBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.95, depthTest: false });
      this.outlineGeo = {
        w: new THREE.EdgesGeometry(new THREE.BoxGeometry(C + 0.08, L + 0.08, 0.3)),
        f: new THREE.EdgesGeometry(new THREE.BoxGeometry(C + 0.08, 0.3, C + 0.08)),
      };
      this.outline = new THREE.LineSegments(this.outlineGeo.w, mat);
      this.outline.renderOrder = 31;
      g.scene.add(this.outline);
    }
    this.outline.geometry = this.outlineGeo[p.t] || this.outlineGeo.w;
    this.outline.position.copy(p.pos);
    this.outline.quaternion.copy(p.quat);
    this.outline.visible = true;
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    const g = this.game, me = g.me;
    this.time += dt;
    if (!me) return;
    this.target = this.findTarget();
    if (this.editing) {
      const p = g.builds.pieces.get(this.editing.k);
      const far = !p || !me.alive || me.inBus || !this.inReach(this.editing.k, me);
      if (far) this.closeEdit();
      else if (this.target && this.target.k !== this.editing.k) {
        // looking at another of your pieces: the open choices move to it
        this.closeEdit();
        this.openEdit(this.target);
      } else if (this.target) { this.editing.x = this.target.x; this.editing.z = this.target.z; }
    }
    // listener pitch for positional sound (the yaw comes with Game.updateCamera's setListener)
    const q = g.camera.quaternion;
    const fy = -2 * (q.y * q.z - q.w * q.x);
    g.sfx.setListenerPitch?.(Math.asin(Math.max(-1, Math.min(1, fy))));
    // bus engine while riding; heartbeat when low
    g.sfx.setBus?.(me.inBus && g.phase === 'bus' ? 1 : 0);
    if (me.alive && !me.inBus && me.hp < 30 && g.phase !== 'lobby') {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        g.sfx.heartbeat?.(1 - me.hp / 30);
        this.heartT = 0.55 + (me.hp / 30) * 0.4;
      }
    } else this.heartT = 0;
  }

  hud() {
    const g = this.game, me = g.me, inp = g.input;
    if (!me) return;
    let ctx = 'gun', full = false;
    if (me.inBus) ctx = 'bus';
    else if (!me.alive) ctx = 'dead';
    else if (me.mode === 'skydive' || me.mode === 'glide') ctx = 'sky';
    else if (me.buildMode) ctx = 'build';
    else {
      const cur = me.current();
      const w = cur && WEAPONS[cur.k];
      if (cur && HEALS[cur.k]) ctx = 'heal';
      else if (!w || w.melee) ctx = 'melee';
      else full = !!w.mag && cur.m >= w.mag;
    }
    inp.setContext?.(ctx, full, !!this.target, !!this.editing);
    // the interact button names what it picks up, in its rarity colour
    const info = g.hud.promptInfo;
    if (info !== this.lastPrompt) {
      this.lastPrompt = info;
      inp.setInteractItem?.(info ? info.name : '', info ? info.r : -1);
    }
  }

  dispose() {
    this.closeEdit();
    const g = this.game;
    if (g.hud && g.hud.onEditChip) g.hud.onEditChip = null;
    g.input.setContext?.('');
    g.input.setInteractItem?.('', -1);
    g.sfx.setBus?.(0);
    if (this.outline) {
      g.scene.remove(this.outline);
      this.outline.material.dispose();
      for (const geo of Object.values(this.outlineGeo)) geo.dispose();
      this.outline = null;
    }
    if (g.buildClient === this) g.buildClient = null;
  }
}
