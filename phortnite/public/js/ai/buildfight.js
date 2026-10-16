// Bot build fights: a queue of pieces placed one after another like a player's hands would,
// 0.15-0.3 s apart (skill), never faster than one every 0.1 s:
//   wall    - a wall toward whoever is shooting at us
//   ramp    - a wall and a ramp, run up it, again: pushing a target that is higher up
//   nineties- builders: wall, ramp, turn 90°, jump, again: climbing for height in a close fight
//   box     - four walls and a roof (a cone when the game has the cone piece), then heal inside
// Placement goes through Bot.placeAt (the camera angles pick the grid slot) and Game.tryPlaceBuild,
// so pieces are networked and paid for exactly like a player's. The rules decide whether bots
// build at all (rules.build 'off': never; 'infinite': materials don't run out).
import { parseKey } from '../../shared/buildgrid.js';
import { buildRule } from './goals.js';

const QUARTER = Math.PI / 2;
const MIN_GAP = 0.1;

let _cone = null;
/** Does this build of the game have the cone (roof) piece? */
export function hasCone() {
  if (_cone === null) {
    try { _cone = !!parseKey('c0,0,0'); } catch (e) { _cone = false; }
  }
  return _cone;
}

// step: [type, yaw offset (quarter turns), pitch, seconds to walk forward after it, jump]
const WALL = [['w', 0, 0, 0, false]];
const RAMP_PUSH = [['w', 0, 0, 0, false], ['r', 0, 0, 0.35, false], ['w', 0, 0, 0, false], ['r', 0, 0, 0.35, true]];
const NINETIES = [
  ['w', 0, 0, 0, false], ['r', 0, 0, 0.3, true],
  ['w', 1, 0, 0, false], ['r', 1, 0, 0.3, true],
  ['w', 2, 0, 0, false], ['r', 2, 0, 0.3, true],
];
const BOX = [['w', 0, 0, 0, false], ['w', 1, 0, 0, false], ['w', 2, 0, 0, false], ['w', 3, 0, 0, false], ['roof', 0, 0.7, 0, false]];

export class BuildFight {
  constructor(bot) {
    this.bot = bot;
    this.q = null;       // the pattern being built
    this.i = 0;
    this.kind = '';
    this.yaw = 0;
    this.t = 0;          // until the next piece
    this.walkT = 0;      // walking forward (up a ramp) for this long
    this.jump = false;
    this.placed = 0;     // pieces of this pattern that went down
    this.total = 0;      // pieces this bot ever placed
    this.lastT = -99;    // when the last pattern started (game time)
  }

  get busy() { return !!this.q; }

  clear() { this.q = null; this.walkT = 0; this.jump = false; }

  /** Seconds between two pieces for this bot (skill; easy bots are slow). */
  gap() {
    const b = this.bot.brain;
    const t = (0.3 - 0.15 * b.skill) * (b.easy ? 1.6 : 1);
    return Math.max(MIN_GAP, t * (0.85 + Math.random() * 0.3));
  }

  /** Can we build right now (rules, materials, hands free)? */
  can() {
    const bot = this.bot;
    if (buildRule(bot.game) === 'off' || bot.game.phase !== 'match') return false;
    if (!bot.alive || bot.inBus || bot.healT >= 0 || !bot.canAct()) return false;
    return bot.autoMat();
  }

  /** Start a pattern facing yaw (unless one is running). */
  start(kind, yaw) {
    if (this.q || !this.can()) return false;
    this.q = kind === 'ramp' ? RAMP_PUSH : kind === 'nineties' ? NINETIES : kind === 'box' ? BOX : WALL;
    this.kind = kind;
    this.yaw = yaw;
    this.i = 0;
    this.placed = 0;
    this.t = Math.min(0.12, this.gap() * 0.5); // the first piece goes down fast (a reflex)
    this.walkT = 0;
    this.lastT = this.bot.time;
    return true;
  }

  /** Every frame while busy: place the next piece when it is due. Movement intent in walkT / jump. */
  update(dt) {
    if (!this.q) return;
    this.jump = false;
    if (this.walkT > 0) this.walkT -= dt;
    if ((this.t -= dt) > 0) return;
    if (this.i >= this.q.length || !this.can()) { this.clear(); return; }
    const [type, turn, pitch, walk, jump] = this.q[this.i++];
    const yaw = this.yaw + turn * QUARTER;
    let ok = false;
    if (type === 'roof') {
      ok = hasCone() && this.bot.placeAt('c', yaw, pitch);
      if (!ok) ok = this.bot.placeAt('f', yaw, pitch);
    } else ok = this.bot.placeAt(type, yaw, pitch);
    if (ok) { this.placed++; this.total++; }
    this.walkT = walk;
    this.jump = jump && ok;
    this.t = this.gap();
    if (this.i >= this.q.length) this.t = Math.max(this.t, walk);
  }
}
