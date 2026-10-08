// The building kit: blueprints in 4 m modules (footprints line up with the 4 m player build grid)
// that emit today's 'part' objects (axis-aligned boxes, boxes tilted about a local x / z axis, and
// 6-point triangular prisms), so destruction, colliders, batching and destroyed ids work as before.
//
// emitBuilding(W, arch, opts) builds one archetype at opts { x, z, rot (0-3, quarter turns), base
// (terrain pad height), region, tier, rng } and returns its record in data.houses. Local frame:
// origin at the footprint centre, +z is the front (doors), ly = 0 is the floor-0 level.
//
// Every storey is reachable: stairs are ramps with rise:run 2:3 or 4:5 (34 or 39 degrees, at most
// 45), every door is at least 2.35 m tall. Each record lists its stairs, doors and storey levels
// so tests (and bots) can check them:
//   stairs: [[x0, z0, y0, x1, z1, y1, width], ...]  walking surface centreline, world coords
//   doors: [[x, z, y, nx, nz, height, width], ...]  threshold centre, outward normal
//   levels: [y, ...]  storey floor heights (levels[0] = floor 0)
//
// Deterministic: literal angles and 90 degree rotations only (no sin / cos / atan2).
import { ENV } from '../constants.js';

export const FH = 3.2;      // storey height of houses
export const WT = 0.25;     // wall thickness

// literal angles (radians) and their sines / cosines
const A30 = 0.5235987755982988, S30 = 0.5, C30 = 0.8660254037844386, T30 = 0.5773502691896257;
const A60 = 1.0471975511965976, S60 = 0.8660254037844386, C60 = 0.5, T60 = 1.7320508075688772;
const A45 = 0.7853981633974483, S45 = 0.7071067811865476;
// stairs: rise:run 2:3 (33.7 degrees) or 4:5 (38.7 degrees)
const STAIR = {
  23: { ang: 0.5880026035475675, sin: 0.5547001962252291, cos: 0.8320502943378437, run: 1.5 },
  45: { ang: 0.6747409422235527, sin: 0.6246950475544243, cos: 0.7808688094430304, run: 1.25 },
  30: { ang: A30, sin: S30, cos: C30, run: 1.7320508075688772 },
};
const YAWS = [0, 1.5707963267948966, 3.141592653589793, 4.71238898038469];
// |sin|, |cos| of every tilt angle the kit uses (so bounds need no trigonometry)
const TRIG = new Map([
  [A30, [S30, C30]], [A60, [S60, C60]], [A45, [S45, S45]],
  [STAIR[23].ang, [STAIR[23].sin, STAIR[23].cos]], [STAIR[45].ang, [STAIR[45].sin, STAIR[45].cos]],
  [0.25, [0.24740395925452294, 0.9689124217106447]], [0.2, [0.19866933079506122, 0.9800665778412416]],
]);

// wall material sets
export const STYLE = {
  wood: { look: 'siding', mat: 'wood', hp: 160 },
  brick: { look: 'brick', mat: 'stone', hp: 230 },
  metal: { look: 'metalwall', mat: 'metal', hp: 320 },
  corrugated: { look: 'corrugated', mat: 'metal', hp: 280 },
  stucco: { look: 'stucco', mat: 'stone', hp: 210 },
  adobe: { look: 'adobe', mat: 'stone', hp: 210 },
  logs: { look: 'logs', mat: 'wood', hp: 190 },
  planks: { look: 'planks', mat: 'wood', hp: 150 },
  concrete: { look: 'concrete', mat: 'stone', hp: 280 },
  panel: { look: 'panel', mat: 'stone', hp: 260 },
  sandstone: { look: 'sandstone', mat: 'stone', hp: 260 },
  castle: { look: 'castle', mat: 'stone', hp: 420 },
  ice: { look: 'ice', mat: 'stone', hp: 240 },
};
const GLASS = { look: 'glass', mat: 'metal', hp: 45 };

/**
 * One building being emitted: local -> world transform plus part helpers.
 * W: the world being built { objects, lootSpots, chests, add(o) }.
 */
class Builder {
  constructor(W, h) {
    this.W = W;
    this.h = h;
    this.rot = h.rot;
    this.y0 = h.y;
    this.stairs = [];
    this.doors = [];
    this.levels = [h.y];
    this.loot = [];     // [lx, lz, ly]
    this.chestSpots = []; // [lx, lz, ly, yawLocalIndex]
    this.keepout = [];    // local rects [x0, z0, x1, z1] on floor 0 where no door may open (stair feet)
    this.minX = Infinity; this.maxX = -Infinity; this.minZ = Infinity; this.maxZ = -Infinity; this.top = h.y;
  }

  /** local (lx, lz) -> world [x, z] */
  w(lx, lz) {
    const h = this.h;
    switch (this.rot) {
      case 1: return [h.x + lz, h.z - lx];
      case 2: return [h.x - lx, h.z - lz];
      case 3: return [h.x - lz, h.z + lx];
      default: return [h.x + lx, h.z + lz];
    }
  }

  /** local direction -> world direction */
  dir(nx, nz) {
    switch (this.rot) {
      case 1: return [nz, -nx];
      case 2: return [-nx, -nz];
      case 3: return [-nz, nx];
      default: return [nx, nz];
    }
  }

  grow(x, z, y) {
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z; if (z > this.maxZ) this.maxZ = z;
    if (y > this.top) this.top = y;
  }

  /** An axis-aligned (or tilted about a local axis) box part; ly is relative to floor 0. */
  box(st, lx, ly, lz, hx, hy, hz, tilt, extra) {
    const h = this.h;
    const [x, z] = this.w(lx, lz);
    const swap = this.rot % 2 === 1;
    const o = {
      kind: 'part', house: h.id, look: st.look, mat: st.mat, hp: st.hp, shape: 'box', paint: h.paint,
      x, y: this.y0 + ly, z, hx: swap ? hz : hx, hy, hz: swap ? hx : hz,
    };
    if (tilt) {
      let ax, ang;
      if (tilt[0] === 'x') {
        ax = this.rot % 2 ? 'z' : 'x';
        ang = this.rot === 0 || this.rot === 3 ? tilt[1] : -tilt[1];
      } else {
        ax = this.rot % 2 ? 'x' : 'z';
        ang = this.rot === 0 || this.rot === 1 ? tilt[1] : -tilt[1];
      }
      o.ax = ax; o.ang = ang;
    }
    if (extra) Object.assign(o, extra);
    if (tilt) {
      // exact world bounds of the tilted box
      const sc = TRIG.get(Math.abs(tilt[1]));
      if (!sc) throw new Error(`tilt angle ${tilt[1]} has no TRIG entry`);
      const [sn, cs] = sc;
      let ex, ey, ez;
      if (o.ax === 'x') { ex = o.hx; ey = o.hy * cs + o.hz * sn; ez = o.hz * cs + o.hy * sn; } else { ex = o.hx * cs + o.hy * sn; ey = o.hy * cs + o.hx * sn; ez = o.hz; }
      o.bb = [o.x - ex, o.y - ey, o.z - ez, o.x + ex, o.y + ey, o.z + ez];
      this.grow(o.x - ex, o.z - ez, o.y + ey);
      this.grow(o.x + ex, o.z + ez, o.y + ey);
    } else {
      this.grow(o.x - o.hx, o.z - o.hz, o.y + o.hy);
      this.grow(o.x + o.hx, o.z + o.hz, o.y + o.hy);
    }
    return this.W.add(o);
  }

  /** A box given by its local min / max corners (y relative to floor 0). */
  span(st, x0, y0, z0, x1, y1, z1, extra) {
    return this.box(st, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, null, extra);
  }

  /** A triangular prism from 6 local points [lx, ly, lz] (two triangles a b c / d e f). */
  prism(st, pts, extra) {
    const h = this.h;
    const out = [];
    let cx = 0, cy = 0, cz = 0;
    for (const [lx, ly, lz] of pts) {
      const [x, z] = this.w(lx, lz);
      const y = this.y0 + ly;
      out.push(x, y, z);
      cx += x; cy += y; cz += z;
      this.grow(x, z, y);
    }
    const o = { kind: 'part', house: h.id, look: st.look, mat: st.mat, hp: st.hp, shape: 'prism', pts: out, x: cx / 6, y: cy / 6, z: cz / 6, paint: h.paint };
    if (extra) Object.assign(o, extra);
    return this.W.add(o);
  }

  /** A ramp whose walking surface rises from (lx0, ly0, lz0) to (lx1, ly1, lz1) along local x or z. */
  ramp(st, lx0, ly0, lz0, lx1, ly1, lz1, width, ratio = 23, extra) {
    const S = STAIR[ratio];
    const t = 0.1; // half thickness
    const alongX = Math.abs(lx1 - lx0) > Math.abs(lz1 - lz0);
    const run = alongX ? lx1 - lx0 : lz1 - lz0;
    const rise = ly1 - ly0;
    const len = Math.sqrt(run * run + rise * rise);
    const sgn = run > 0 ? 1 : -1;
    const mx = (lx0 + lx1) / 2, my = (ly0 + ly1) / 2, mz = (lz0 + lz1) / 2;
    // centre of the box = surface centre minus the half thickness along the surface normal
    if (alongX) {
      // rising toward +x: rotate about z by +ang (toward -x: -ang); normal (-sin * sgn, cos)
      this.box(st, mx + t * S.sin * sgn, my - t * S.cos, mz, len / 2, t, width / 2, ['z', S.ang * sgn], extra);
    } else {
      // rising toward +z: rotate about x by -ang (a +x rotation lifts -z)
      this.box(st, mx, my - t * S.cos, mz + t * S.sin * sgn, width / 2, t, len / 2, ['x', -S.ang * sgn], extra);
    }
    const [x0, z0] = this.w(lx0, lz0), [x1, z1] = this.w(lx1, lz1);
    this.stairs.push([x0, z0, this.y0 + ly0, x1, z1, this.y0 + ly1, width]);
    if (ly0 < 0.5) {
      const hw = width / 2 + 0.4;
      this.keepout.push(alongX ? [Math.min(lx0, lx1) - 0.6, lz0 - hw, Math.max(lx0, lx1) + 0.6, lz0 + hw] : [lx0 - hw, Math.min(lz0, lz1) - 0.6, lx0 + hw, Math.max(lz0, lz1) + 0.6]);
    }
  }

  /** Would a door bay (local span along its wall) open onto a stair foot? */
  doorBlocked(alongX, fixed, c0, c1, nrm) {
    // the 1.2 m deep strip inside the door
    const inX = alongX ? [c0, c1] : nrm[0] > 0 ? [fixed - 1.4, fixed] : [fixed, fixed + 1.4];
    const inZ = alongX ? (nrm[1] > 0 ? [fixed - 1.4, fixed] : [fixed, fixed + 1.4]) : [c0, c1];
    for (const k of this.keepout) if (inX[0] < k[2] && inX[1] > k[0] && inZ[0] < k[3] && inZ[1] > k[1]) return true;
    return false;
  }

  /** Record a door (local threshold centre, local outward normal, opening height / width). */
  door(lx, lz, ly, nx, nz, height, width) {
    const [x, z] = this.w(lx, lz), [dx, dz] = this.dir(nx, nz);
    this.doors.push([x, z, this.y0 + ly, dx, dz, height, width]);
  }

  level(ly) { this.levels.push(this.y0 + ly); }
  lootAt(lx, lz, ly) { this.loot.push([lx, lz, ly]); }
  chestAt(lx, lz, ly, face) { this.chestSpots.push([lx, lz, ly, face]); }
}

// ------------------------------------------------------------------ generic pieces
/** The foundation: an indestructible slab from below the terrain up to floor 0. */
function foundation(B, hw, hd, st = { look: 'foundation', mat: 'stone', hp: 0 }) {
  const drop = B.h.y - B.h.base + 1.2;
  B.box(st, 0, -drop / 2, 0, hw + 0.15, drop / 2, hd + 0.15);
}

/**
 * A wall along one side of a w x d footprint at storey level ly (height fh), from a bay pattern:
 *   S solid, W window, D door, G glass window, F storefront glass, B big door, O open, H half wall.
 * side: 0 front (+z), 1 back (-z), 2 right (+x), 3 left (-x). Bays are 2 m (front / back) or
 * (d - 2 WT) / (d / 2) (sides). Consecutive solid bays merge into one part (up to 4 m).
 */
function wall(B, side, w, d, ly, fh, pattern, st, opts = {}) {
  const alongX = side < 2;
  const len = alongX ? w : d - 2 * WT;
  const n = pattern.length;
  const b = len / n;
  const fixed = alongX ? (side === 0 ? d / 2 - WT / 2 : -(d / 2 - WT / 2)) : (side === 2 ? w / 2 - WT / 2 : -(w / 2 - WT / 2));
  const nrm = side === 0 ? [0, 1] : side === 1 ? [0, -1] : side === 2 ? [1, 0] : [-1, 0];
  const glass = opts.glass || GLASS;
  const seg = (c0, c1, y0, y1, s = st, thick = WT) => {
    const c = (c0 + c1) / 2, hl = (c1 - c0) / 2;
    if (alongX) B.box(s, c, ly + (y0 + y1) / 2, fixed, hl, (y1 - y0) / 2, thick / 2);
    else B.box(s, fixed, ly + (y0 + y1) / 2, c, thick / 2, (y1 - y0) / 2, hl);
  };
  const sill = 0.95, head = 2.15, doorH = opts.doorH || 2.4;
  let i = 0;
  while (i < n) {
    const ch = pattern[i];
    const c0 = -len / 2 + b * i;
    if (ch === 'S') {
      let j = i + 1;
      while (j < n && pattern[j] === 'S' && (j - i + 1) * b <= 4.01) j++;
      seg(c0, -len / 2 + b * j, 0, fh);
      i = j;
      continue;
    }
    const c1 = c0 + b;
    const cm = (c0 + c1) / 2;
    if ((ch === 'D' || ch === 'B') && ly < 0.5 && B.doorBlocked(alongX, fixed, c0, c1, nrm)) {
      seg(c0, c1, 0, sill); seg(c0, c1, head, fh);
      i++;
      continue;
    }
    if (ch === 'W') { seg(c0, c1, 0, sill); seg(c0, c1, head, fh); } else if (ch === 'G') {
      seg(c0, c1, 0, sill); seg(c0, c1, head, fh); seg(c0, c1, sill, head, glass, 0.08);
    } else if (ch === 'F') {
      seg(c0, c1, 0, 0.35); seg(c0, c1, 2.75, fh); seg(c0, c1, 0.35, 2.75, glass, 0.08);
    } else if (ch === 'D' || ch === 'B') {
      const hgt = ch === 'B' ? Math.min(fh - 0.3, 3.6) : doorH;
      if (hgt < fh - 0.05) seg(c0, c1, hgt, fh);
      if (ly < 0.5 || opts.doorsAll) {
        const [lx, lz] = alongX ? [cm, fixed] : [fixed, cm];
        B.door(lx, lz, ly, nrm[0], nrm[1], hgt, b);
      }
    } else if (ch === 'H') {
      seg(c0, c1, 0, 1.1);
    }
    i++;
  }
}

/** Four corner trims (posts) of a storey. */
function trims(B, w, d, ly, fh, st) {
  const t = { look: 'trim', mat: st.mat, hp: 90 };
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box(t, sx * (w / 2), ly + fh / 2, sz * (d / 2), 0.2, fh / 2, 0.2);
}

/** A floor slab covering the inner footprint at level ly (top), minus up to one rectangular hole. */
function slab(B, x0, z0, x1, z1, ly, hole, st = { look: 'floor', mat: 'wood', hp: 200 }) {
  const t = 0.13;
  if (!hole) { B.span(st, x0, ly - 2 * t, z0, x1, ly, z1); return; }
  const [hx0, hz0, hx1, hz1] = hole;
  // strips: z < hz0, z > hz1 (full width), then x < hx0 and x > hx1 between
  if (hz0 > z0 + 0.05) B.span(st, x0, ly - 2 * t, z0, x1, ly, hz0);
  if (hz1 < z1 - 0.05) B.span(st, x0, ly - 2 * t, hz1, x1, ly, z1);
  if (hx0 > x0 + 0.05) B.span(st, x0, ly - 2 * t, Math.max(z0, hz0), hx0, ly, Math.min(z1, hz1));
  if (hx1 < x1 - 0.05) B.span(st, hx1, ly - 2 * t, Math.max(z0, hz0), x1, ly, Math.min(z1, hz1));
}

/**
 * Interior stairs for a box building (w x d) with `floors` storeys of height fh.
 * Two floors: one ramp along the back wall. More: a switchback along the back (two strips).
 * Returns the hole rectangle for every storey f >= 1: holes[f] = [x0, z0, x1, z1] (local).
 */
function interiorStairs(B, w, d, floors, fh, st) {
  const holes = [];
  if (floors < 2) return holes;
  const run = fh * STAIR[23].run;
  const sw = 1.7;               // stair width
  const zA = -d / 2 + WT + 0.1, zB = zA + sw + 0.1;  // strip A (back), strip B in front of it
  const xin = -w / 2 + WT;
  const switchback = floors > 2 && w - 2 * WT >= run + 3.4;
  const xa = switchback ? xin + 1.6 : xin + 0.2;   // low end of the first ramp
  for (let f = 1; f < floors; f++) {
    const yA = (f - 1) * fh, yB = f * fh;
    const strip = switchback ? (f - 1) % 2 : 0;
    const zc = strip === 0 ? zA + sw / 2 : zB + sw / 2;
    if (strip === 0) B.ramp(st, xa, yA, zc, xa + run, yB, zc, sw);
    else B.ramp(st, xa + run, yA, zc, xa, yB, zc, sw);
    const hz0 = strip === 0 ? zA - 0.1 : zB, hz1 = strip === 0 ? zA + sw + 0.05 : zB + sw + 0.05;
    holes[f] = [xa - 0.05, hz0, xa + run + 0.25, hz1];
  }
  return holes;
}

/** Gable roof (ridge along local x) over a w x d box whose walls end at ly; returns ridge height. */
function gableRoof(B, w, d, ly, roofSt, wallSt, steep = false, oh = 0.5) {
  const A = steep ? A60 : A30, S = steep ? S60 : S30, C = steep ? C60 : C30, T = steep ? T60 : T30;
  const run = d / 2 + oh;
  const rise = run * T;
  const ridgeY = ly + (d / 2) * T;
  const len = run / C;
  for (const sgn of [1, -1]) {
    const cz = sgn * run / 2;
    const cy = ridgeY - rise / 2;
    B.box(roofSt, 0, cy + C * 0.11, cz + sgn * S * 0.11, w / 2 + oh, 0.11, len / 2, ['x', sgn * A]);
  }
  for (const sx of [1, -1]) {
    const x = sx * (w / 2 - WT / 2);
    const a = d / 2;
    B.prism(wallSt, [
      [x - WT / 2, ly, -a], [x - WT / 2, ly, a], [x - WT / 2, ridgeY, 0],
      [x + WT / 2, ly, -a], [x + WT / 2, ly, a], [x + WT / 2, ridgeY, 0],
    ]);
  }
  // attic ceiling so the roof reads as solid from below
  B.box({ look: 'concrete', mat: 'wood', hp: 160 }, 0, ly + 0.06, 0, w / 2 - WT, 0.06, d / 2 - WT);
  return ridgeY;
}

/** Flat roof with a parapet. */
function flatRoof(B, w, d, ly, st, parapet = 0.6) {
  B.box({ look: 'concrete', mat: st.mat === 'metal' ? 'metal' : 'stone', hp: 240 }, 0, ly + 0.15, 0, w / 2 + 0.2, 0.15, d / 2 + 0.2);
  if (parapet > 0) {
    const t = { look: 'trim', mat: st.mat, hp: 80 };
    B.box(t, 0, ly + 0.3 + parapet / 2, d / 2 + 0.05, w / 2 + 0.2, parapet / 2, 0.15);
    B.box(t, 0, ly + 0.3 + parapet / 2, -d / 2 - 0.05, w / 2 + 0.2, parapet / 2, 0.15);
    B.box(t, w / 2 + 0.05, ly + 0.3 + parapet / 2, 0, 0.15, parapet / 2, d / 2 - 0.1);
    B.box(t, -w / 2 - 0.05, ly + 0.3 + parapet / 2, 0, 0.15, parapet / 2, d / 2 - 0.1);
  }
  return ly + 0.3 + parapet;
}

/** Random bay pattern for one side: windows and solids, an optional door bay in the middle. */
function pattern(rng, n, { door = -1, win = 0.55, kind = 'W', edgeWin = 0.3 } = {}) {
  let s = '';
  for (let i = 0; i < n; i++) {
    if (i === door) s += 'D';
    else if (i > 0 && i < n - 1 && rng() < win) s += kind;
    else if (n <= 4 && rng() < edgeWin) s += kind;
    else s += 'S';
  }
  return s;
}

/** Loot anchors of a box building: per storey, away from the walls and the stair strip. */
function boxLoot(B, w, d, floors, fh, density) {
  const zBack = -d / 2 + WT + 3.9; // in front of the stair strips
  for (let f = 0; f < floors; f++) {
    const ly = f * fh;
    B.lootAt(w / 4, d / 4 - 0.3, ly);
    if (density > 1 || (density > 0.5 && f === 0)) B.lootAt(-w / 4, Math.max(zBack, d / 4 - 1), ly);
  }
}

/** A box building: walls per storey, trims, interior stairs, slabs, a roof. Most archetypes use it. */
function boxBuilding(B, o) {
  const { w, d, floors, st, rng } = o;
  const fh = o.fh || FH;
  foundation(B, w / 2, d / 2);
  const holes = interiorStairs(B, w, d, floors, fh, o.stairSt || { look: 'floor', mat: 'wood', hp: 160 });
  for (let f = 0; f < floors; f++) {
    const ly = f * fh;
    const nb = w / 2, ns = d / 2;
    for (let side = 0; side < 4; side++) {
      const n = side < 2 ? nb : ns;
      const p = o.pattern ? o.pattern(side, f, n) : pattern(rng, n, { door: side === 0 && f === 0 ? Math.floor(n / 2) : -1, win: o.win ?? 0.55, kind: o.winKind || 'W' });
      wall(B, side, w, d, ly, fh, p, (o.stAt && o.stAt(f)) || st, o.wallOpts);
    }
    if (o.trims !== false) trims(B, w, d, ly, fh, st);
    if (f > 0) {
      slab(B, -w / 2 + WT, -d / 2 + WT, w / 2 - WT, d / 2 - WT, ly, holes[f], o.floorSt);
      B.level(ly);
    }
  }
  const top = floors * fh;
  let roofTop;
  if (o.roof === 'gable' || o.roof === 'steep') roofTop = gableRoof(B, w, d, top, o.roofSt || { look: 'roof', mat: 'wood', hp: 140 }, st, o.roof === 'steep');
  else if (o.roof === 'none') roofTop = top;
  else roofTop = flatRoof(B, w, d, top, st, o.parapet ?? 0.6);
  boxLoot(B, w, d, floors, fh, o.lootDensity ?? 1);
  // chests: ground floor back-right corner by default (the stairs live back-left), upper floor front-right
  const cf = floors > 1 && rng() < 0.5 ? floors - 1 : 0;
  if (cf) B.chestAt(w / 2 - 1.1, d / 2 - 1.2, cf * fh, 2);
  else B.chestAt(w / 2 - 1.1, -d / 2 + 1.0, 0, 0);
  return { top, roofTop };
}

// ------------------------------------------------------------------ archetypes
// Each returns { w, d } (the footprint, including porches / awnings) via FOOTPRINTS and builds into B.
// opts.v: a variant number (0..), opts.rng: the generator's random stream.

function house(B, o) {
  const { rng } = o;
  const w = o.w, d = o.d;
  const floors = o.floors;
  const st = o.st || (rng() < 0.65 ? STYLE.wood : STYLE.brick);
  const roof = o.roof || (floors === 1 && rng() < 0.7 ? 'gable' : rng() < 0.5 ? 'gable' : 'flat');
  B.h.style = st === STYLE.brick ? 'brick' : st === STYLE.metal ? 'metal' : 'wood';
  B.h.roof = roof === 'flat' ? 'flat' : 'gable';
  boxBuilding(B, { w, d, floors, st, rng, roof, roofSt: o.roofSt });
}

function apartment(B, o) {
  const { rng } = o;
  const st = o.st || [STYLE.brick, STYLE.stucco, STYLE.concrete][Math.floor(rng() * 3)];
  B.h.style = 'brick'; B.h.roof = 'flat';
  boxBuilding(B, { w: o.w, d: o.d, floors: o.floors, st, rng, roof: 'flat', win: 0.75, lootDensity: o.tier === 'hot' ? 2 : 1, floorSt: { look: 'concrete', mat: 'stone', hp: 260 } });
}

function shop(B, o) {
  const { rng, w } = o;
  const d = o.d - 2; // the awning sticks out 2 m in front
  const st = o.st || [STYLE.brick, STYLE.stucco, STYLE.panel, STYLE.wood][Math.floor(rng() * 4)];
  B.h.style = st === STYLE.wood ? 'wood' : 'brick'; B.h.roof = 'flat';
  // shift the box back by 1 m so the footprint (with the awning) stays centred
  const sh = -1;
  const saveW = B.w.bind(B);
  B.w = (lx, lz) => saveW(lx, lz + sh);
  const floors = o.floors;
  boxBuilding(B, {
    w, d, floors, st, rng, roof: 'flat',
    pattern: (side, f, n) => {
      if (side === 0 && f === 0) {
        // storefront: glass, a door in the middle
        let s = '';
        for (let i = 0; i < n; i++) s += i === Math.floor(n / 2) ? 'D' : i === 0 || i === n - 1 ? 'S' : 'F';
        return s;
      }
      if (side === 1 && f === 0) return pattern(rng, n, { door: 1, win: 0.2 });
      return pattern(rng, n, { win: 0.5 });
    },
  });
  // awning over the shop front + the sign above it
  const tint = o.tint ?? SIGN_TINTS[Math.floor(rng() * SIGN_TINTS.length)];
  B.box({ look: 'panel', mat: 'wood', hp: 60 }, 0, 2.95, d / 2 + 0.95, w / 2 - 0.4, 0.06, 1.0, ['x', 0.25], { tint });
  B.box({ look: 'panel', mat: 'wood', hp: 70 }, 0, FH + 0.15 + (floors > 1 ? 0 : 0.45), d / 2 + 0.12, Math.min(w / 2 - 1, 4.5), 0.42, 0.06, null, { tint: 0xf4efe2, sign: o.sign || 'SHOP' });
  B.w = saveW;
}
const SIGN_TINTS = [0xd8433a, 0x2f7de1, 0x3fa34d, 0xf0b429, 0x9b51e0, 0xff7a1a, 0x18b7b0];

function skyscraper(B, o) {
  const { rng } = o;
  const w = o.w, d = o.d, floors = o.floors;
  const fh = 3.6;
  const st = o.st || [STYLE.concrete, STYLE.panel, STYLE.brick][Math.floor(rng() * 3)];
  const glassTint = [0x7fb6d9, 0x6fc3c9, 0x8aa6d8, 0x9fd0e8][Math.floor(rng() * 4)];
  const glass = { look: 'glass', mat: 'metal', hp: 45 };
  B.h.style = 'brick'; B.h.roof = 'flat';
  foundation(B, w / 2, d / 2);
  const holes = interiorStairs(B, w, d, floors, fh, { look: 'concrete', mat: 'stone', hp: 220 });
  const band = { look: st.look, mat: st.mat, hp: st.hp };
  for (let f = 0; f < floors; f++) {
    const ly = f * fh;
    if (f === 0) {
      // lobby: storefront glass all round, doors on every side (the stair feet turn some into walls)
      const nb = w / 4;
      for (let side = 0; side < 4; side++) {
        let s = '';
        for (let i = 0; i < nb; i++) s += i === Math.floor(nb / 2) ? 'D' : i === 0 || i === nb - 1 ? 'S' : 'F';
        wall4(B, side, w, d, ly, fh, s, st, glass, glassTint);
      }
    } else {
      // curtain wall: a spandrel band, glass panes 8 m wide, a header band
      for (let side = 0; side < 4; side++) curtain(B, side, w, d, ly, fh, band, glass, glassTint);
      slab(B, -w / 2 + WT, -d / 2 + WT, w / 2 - WT, d / 2 - WT, ly, holes[f], { look: 'concrete', mat: 'stone', hp: 260 });
      B.level(ly);
    }
    B.lootAt(w / 4, d / 4 - 0.3, ly);
    if (o.tier === 'hot' || f % 2 === 0) B.lootAt(-w / 4, d / 5, ly);
  }
  const top = floors * fh;
  // corner columns, full height
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box({ look: st.look, mat: 'stone', hp: 0 }, sx * (w / 2 - 0.05), top / 2, sz * (d / 2 - 0.05), 0.35, top / 2, 0.35);
  B.chestAt(w / 2 - 1.2, -d / 2 + 4.6, 0, 0);
  if (floors >= 4) B.chestAt(w / 2 - 1.2, d / 2 - 1.3, (floors - 1) * fh, 2);
  if (floors >= 6) B.chestAt(-w / 2 + 1.3, d / 2 - 1.3, 3 * fh, 2);
  flatRoof(B, w, d, top, st, 1.0);
  // a rooftop water tank and an antenna for the skyline
  B.box({ look: 'metalwall', mat: 'metal', hp: 200 }, w / 4, top + 1.8, -d / 4, 1.2, 1.5, 1.2);
  B.box({ look: 'trim', mat: 'metal', hp: 80 }, -w / 4, top + 4.5, d / 4, 0.12, 4.2, 0.12);
}

/** Wall with 4 m bays (lobbies, warehouses): S solid, F storefront, D door, B big door, W window. */
function wall4(B, side, w, d, ly, fh, pat, st, glass, glassTint) {
  const alongX = side < 2;
  const len = alongX ? w : d - 2 * WT;
  const n = pat.length, b = len / n;
  const fixed = alongX ? (side === 0 ? d / 2 - WT / 2 : -(d / 2 - WT / 2)) : (side === 2 ? w / 2 - WT / 2 : -(w / 2 - WT / 2));
  const nrm = side === 0 ? [0, 1] : side === 1 ? [0, -1] : side === 2 ? [1, 0] : [-1, 0];
  const seg = (c0, c1, y0, y1, s = st, thick = WT, extra) => {
    const c = (c0 + c1) / 2, hl = (c1 - c0) / 2;
    if (alongX) B.box(s, c, ly + (y0 + y1) / 2, fixed, hl, (y1 - y0) / 2, thick / 2, null, extra);
    else B.box(s, fixed, ly + (y0 + y1) / 2, c, thick / 2, (y1 - y0) / 2, hl, null, extra);
  };
  for (let i = 0; i < n; i++) {
    const c0 = -len / 2 + b * i, c1 = c0 + b, cm = (c0 + c1) / 2;
    let ch = pat[i];
    if ((ch === 'D' || ch === 'B') && ly < 0.5 && B.doorBlocked(alongX, fixed, c0, c1, nrm)) ch = 'S';
    if (ch === 'S') seg(c0, c1, 0, fh);
    else if (ch === 'F') { seg(c0, c1, 0, 0.35); seg(c0, c1, 2.75, fh); seg(c0, c1, 0.35, 2.75, glass, 0.08, glassTint ? { tint: glassTint } : null); } else if (ch === 'W') { seg(c0, c1, 0, 1.6); seg(c0, c1, fh - 1.2, fh); } else if (ch === 'D' || ch === 'B') {
      const hgt = ch === 'B' ? Math.min(fh - 0.4, 4.2) : 2.5;
      const dw = ch === 'B' ? b - 0.4 : 2.0;
      // jambs either side of the opening, header above
      if (b - dw > 0.2) { seg(c0, cm - dw / 2, 0, fh); seg(cm + dw / 2, c1, 0, fh); }
      seg(cm - dw / 2, cm + dw / 2, hgt, fh);
      if (ly < 0.5) {
        const [lx, lz] = alongX ? [cm, fixed] : [fixed, cm];
        B.door(lx, lz, ly, nrm[0], nrm[1], hgt, dw);
      }
    }
  }
}

/** A skyscraper storey side: spandrel band (0..0.9), glass panes up to 3.1, header band. */
function curtain(B, side, w, d, ly, fh, band, glass, glassTint) {
  const alongX = side < 2;
  const len = alongX ? w : d - 2 * WT;
  const fixed = alongX ? (side === 0 ? d / 2 - WT / 2 : -(d / 2 - WT / 2)) : (side === 2 ? w / 2 - WT / 2 : -(w / 2 - WT / 2));
  const seg = (c0, c1, y0, y1, s, thick, extra) => {
    const c = (c0 + c1) / 2, hl = (c1 - c0) / 2;
    if (alongX) B.box(s, c, ly + (y0 + y1) / 2, fixed, hl, (y1 - y0) / 2, thick / 2, null, extra);
    else B.box(s, fixed, ly + (y0 + y1) / 2, c, thick / 2, (y1 - y0) / 2, hl, null, extra);
  };
  seg(-len / 2, len / 2, 0, 0.9, band, WT);
  seg(-len / 2, len / 2, 3.1, fh, band, WT);
  const panes = Math.max(1, Math.round(len / 8));
  const pw = len / panes;
  for (let i = 0; i < panes; i++) seg(-len / 2 + pw * i + 0.05, -len / 2 + pw * (i + 1) - 0.05, 0.9, 3.1, glass, 0.1, { tint: glassTint });
}

function gasStation(B, o) {
  const { rng } = o;
  // footprint 20 x 12: the shop (8 x 12) on the left, the pump canopy (12 x 12) on the right
  B.h.style = 'brick'; B.h.roof = 'flat';
  const shopX = -6;
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx + shopX, lz);
  const st = STYLE.stucco;
  boxBuilding(B, {
    w: 8, d: 12, floors: 1, st, rng, roof: 'flat',
    pattern: (side, f, n) => (side === 0 ? 'SFDS' : side === 2 ? 'SDSSS'.slice(0, n) : 'S'.repeat(n)),
  });
  B.w = save;
  // canopy on four pillars
  const c = { look: 'panel', mat: 'metal', hp: 160 };
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box({ look: 'trim', mat: 'metal', hp: 160 }, 4 + sx * 4.6, 2.5, sz * 4.6, 0.25, 2.5, 0.25);
  B.box(c, 4, 5.25, 0, 5.8, 0.25, 5.8, null, { tint: o.tint ?? 0xe23b2e });
  B.box({ look: 'trim', mat: 'metal', hp: 120 }, 4, 5.65, 0, 5.9, 0.15, 5.9, null, { tint: 0xf4efe2 });
  B.h.pumps = [B.w(4, -2), B.w(4, 2)];
  B.lootAt(4, 0, 0);
}

function warehouse(B, o) {
  const { rng, w, d } = o;
  const fh = 6;
  const st = o.st || (rng() < 0.5 ? STYLE.corrugated : STYLE.metal);
  B.h.style = 'metal'; B.h.roof = 'flat';
  foundation(B, w / 2, d / 2, { look: 'foundation', mat: 'stone', hp: 0 });
  const nb = w / 4, ns = d / 4;
  for (let side = 0; side < 4; side++) {
    const n = side < 2 ? nb : ns;
    let s = '';
    for (let i = 0; i < n; i++) {
      if (side === 0 && (i === 1 || i === n - 2)) s += 'B';
      else if (side === 1 && i === Math.floor(n / 2)) s += 'D';
      else if (side >= 2 && i === Math.floor(n / 2)) s += 'D';
      else s += i % 2 ? 'W' : 'S';
    }
    wall4(B, side, w, d, 0, fh, s, st, GLASS, null);
  }
  trims(B, w, d, 0, fh, st);
  // mezzanine along the back with a ramp up from the left
  const mz0 = -d / 2 + WT, mz1 = -d / 2 + WT + 3.6, my = 3.2;
  const run = my * STAIR[23].run;
  const rx0 = -w / 2 + WT + 0.4;
  B.span({ look: 'floor', mat: 'metal', hp: 220 }, rx0 + run + 0.3, my - 0.26, mz0, w / 2 - WT, my, mz1);
  B.ramp({ look: 'floor', mat: 'metal', hp: 180 }, rx0, 0, mz0 + 0.95, rx0 + run, my, mz0 + 0.95, 1.7);
  B.span({ look: 'trim', mat: 'metal', hp: 80 }, rx0 + run + 0.3, my, mz1 - 0.1, w / 2 - WT, my + 1.0, mz1);
  B.level(my);
  flatRoof(B, w, d, fh, st, 0.3);
  B.lootAt(w / 4, d / 4, 0); B.lootAt(-w / 4, d / 5, 0); B.lootAt(w / 4, mz0 + 1.8, my);
  if (o.tier === 'hot') B.lootAt(0, 0, 0);
  B.chestAt(w / 2 - 1.2, d / 2 - 1.3, 0, 2);
  if (o.tier === 'hot') B.chestAt(w / 2 - 1.4, mz0 + 1.4, my, 0);
}

function barn(B, o) {
  const w = 12, d = 16, fh = 3.6;
  const st = { look: 'planks', mat: 'wood', hp: 170 };
  B.h.style = 'wood'; B.h.roof = 'gable';
  foundation(B, w / 2, d / 2);
  const red = { tint: o.tint ?? 0xb23a2c };
  // hayloft over the back half (z < 0), a ramp up along the left wall from the front half
  const run = fh * STAIR[23].run;
  B.ramp({ look: 'floor', mat: 'wood', hp: 150 }, -w / 2 + WT + 1.0, 0, run + 0.1, -w / 2 + WT + 1.0, fh, 0.1, 1.7);
  for (let side = 0; side < 4; side++) wallTinted(B, side, w, d, 0, fh, side < 2 ? 'SSBBSS' : 'SWSSWSSS', st, red);
  for (let side = 0; side < 4; side++) wallTinted(B, side, w, d, fh, 2.4, side === 0 ? 'SSWWSS' : side === 1 ? 'SSSSSS' : 'SSSSSSSS', st, red);
  trims(B, w, d, 0, fh + 2.4, st);
  B.span({ look: 'floor', mat: 'wood', hp: 200 }, -w / 2 + WT, fh - 0.26, -d / 2 + WT, w / 2 - WT, fh, 0.1);
  B.span({ look: 'planks', mat: 'wood', hp: 100 }, -w / 2 + WT + 2.0, fh, -0.02, w / 2 - WT, fh + 1.0, 0.1);
  B.level(fh);
  // gambrel roof: steep lower slopes, shallow upper slopes (ridge along z)
  const top = fh + 2.4;
  const rs = { look: 'shingle', mat: 'wood', hp: 140 };
  const lw = 2.2;                       // lower slope run
  const yB = top + lw * T60, uw = w / 2 - lw, yC = yB + uw * T30;
  for (const sx of [1, -1]) {
    B.box(rs, sx * (w / 2 - lw / 2), (top + yB) / 2, 0, lw / C60 / 2 + 0.1, 0.11, d / 2 + 0.4, ['z', -sx * A60]);
    B.box(rs, sx * (uw / 2), (yB + yC) / 2, 0, uw / C30 / 2 + 0.15, 0.11, d / 2 + 0.4, ['z', -sx * A30]);
  }
  for (const sz of [1, -1]) {
    const z = sz * (d / 2 - WT / 2), a = z - WT / 2, b = z + WT / 2;
    const tri = (p, q, r) => B.prism(st, [[p[0], p[1], a], [q[0], q[1], a], [r[0], r[1], a], [p[0], p[1], b], [q[0], q[1], b], [r[0], r[1], b]], red);
    tri([-w / 2, top], [w / 2, top], [0, yC]);
    tri([-w / 2, top], [-uw, yB], [0, yC]);
    tri([w / 2, top], [uw, yB], [0, yC]);
  }
  B.box({ look: 'concrete', mat: 'wood', hp: 160 }, 0, top + 0.06, 0, w / 2 - WT, 0.06, d / 2 - WT);
  B.lootAt(2.5, 3, 0); B.lootAt(2, -d / 2 + 2.5, fh);
  B.chestAt(w / 2 - 1.1, -d / 2 + 1.1, fh, 0);
}

/** wall() with a tint on every part (barns, castles). */
function wallTinted(B, side, w, d, ly, fh, pat, st, extra) {
  const save = B.box.bind(B);
  B.box = (s, a, b2, c, e, f, g, tilt, ex) => save(s, a, b2, c, e, f, g, tilt, ex || (s === st ? extra : undefined));
  wall(B, side, w, d, ly, fh, pat, st);
  B.box = save;
}

/** Octagon-ish round wall (4 straight walls + 4 corner wedges) of half size s, from ly to ly + hgt. */
function octWalls(B, s, c, ly, hgt, st, door, extra) {
  // straight walls on the 4 sides, spanning [-(s - c), s - c]
  for (let side = 0; side < 4; side++) {
    const alongX = side < 2;
    const fixed = side === 0 ? s - WT / 2 : side === 1 ? -(s - WT / 2) : side === 2 ? s - WT / 2 : -(s - WT / 2);
    const hl = s - c;
    if (door && side === 0) {
      // door in the middle (2 m wide, 2.45 m tall)
      const seg = (c0, c1, y0, y1) => B.box(st, (c0 + c1) / 2, ly + (y0 + y1) / 2, fixed, (c1 - c0) / 2, (y1 - y0) / 2, WT / 2, null, extra);
      seg(-hl, -1, 0, hgt); seg(1, hl, 0, hgt); seg(-1, 1, 2.45, hgt);
      B.door(0, fixed, ly, 0, 1, 2.45, 2);
    } else if (alongX) B.box(st, 0, ly + hgt / 2, fixed, hl, hgt / 2, WT / 2, null, extra);
    else B.box(st, fixed, ly + hgt / 2, 0, WT / 2, hgt / 2, hl, null, extra);
  }
  // corner wedges: right triangles (s - c, s), (s, s - c), (s - c, s - c)
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const a = [sx * (s - c), sz * s], b = [sx * s, sz * (s - c)], m = [sx * (s - c), sz * (s - c)];
    B.prism(st, [[a[0], ly, a[1]], [b[0], ly, b[1]], [m[0], ly, m[1]], [a[0], ly + hgt, a[1]], [b[0], ly + hgt, b[1]], [m[0], ly + hgt, m[1]]], extra);
  }
}

/** Four-sided pyramid cap (4 prisms) over a square of half size s at ly. */
function pyramidCap(B, s, ly, hgt, st, extra) {
  const apex = [0, ly + hgt, 0];
  for (const [ax, az, bx, bz] of [[-s, s, s, s], [s, s, s, -s], [s, -s, -s, -s], [-s, -s, -s, s]]) {
    // a thin triangular prism: base edge (a, b) and the apex, 0.2 m thick inward
    const ix = -Math.sign(ax + bx) * 0.2, iz = -Math.sign(az + bz) * 0.2;
    B.prism(st, [[ax, ly, az], [bx, ly, bz], apex, [ax + ix, ly, az + iz], [bx + ix, ly, bz + iz], [apex[0], apex[1] - 0.25, apex[2]]], extra);
  }
}

function silo(B, o) {
  const st = { look: 'metalwall', mat: 'metal', hp: 300 };
  B.h.style = 'metal'; B.h.roof = 'flat';
  foundation(B, 4, 4);
  octWalls(B, 4, 1.4, 0, 12, st, true, { tint: o.tint ?? 0xc9ced4 });
  B.box({ look: 'concrete', mat: 'metal', hp: 200 }, 0, 12.1, 0, 3.9, 0.1, 3.9);
  pyramidCap(B, 4, 12.2, 2.6, { look: 'metalwall', mat: 'metal', hp: 160 }, { tint: 0xb24a3a });
  B.lootAt(0, -1, 0);
  B.chestAt(1.4, -2.2, 0, 0);
}

function windmill(B, o) {
  const { rng } = o;
  const st = { look: 'planks', mat: 'wood', hp: 170 };
  B.h.style = 'wood'; B.h.roof = 'gable';
  // a two-storey 8 x 8 tower with a spiral stair, tapered cap, and sails on the front
  const w = 8, d = 8;
  boxBuilding(B, { w, d, floors: 2, st, rng, roof: 'steep', roofSt: { look: 'shingle', mat: 'wood', hp: 140 } });
  const hubY = 2 * FH + 2.6;
  B.box({ look: 'trim', mat: 'wood', hp: 120 }, 0, hubY, d / 2 + 0.6, 0.5, 0.5, 0.6);
  const sail = { look: 'planks', mat: 'wood', hp: 70 };
  B.box(sail, 0, hubY, d / 2 + 1.0, 7, 0.55, 0.06, ['z', A45], { tint: 0xe8e0cf });
  B.box(sail, 0, hubY, d / 2 + 1.0, 7, 0.55, 0.06, ['z', -A45], { tint: 0xe8e0cf });
  void S45;
}

function cabin(B, o) {
  const { rng } = o;
  const w = o.w, d = o.d - 2; // a 2 m porch at the front
  B.h.style = 'wood'; B.h.roof = 'gable';
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx, lz - 1);
  boxBuilding(B, { w, d, floors: o.floors || 1, st: STYLE.logs, rng, roof: o.steep ? 'steep' : 'gable', roofSt: { look: 'shingle', mat: 'wood', hp: 140 }, win: 0.4 });
  // porch deck + posts + porch roof
  const pz = d / 2 + 1;
  B.span({ look: 'planks', mat: 'wood', hp: 120 }, -w / 2, -0.3, d / 2, w / 2, 0, d / 2 + 2);
  for (const sx of [1, -1]) B.box({ look: 'logs', mat: 'wood', hp: 90 }, sx * (w / 2 - 0.3), 1.3, pz + 0.75, 0.15, 1.3, 0.15);
  B.box({ look: 'shingle', mat: 'wood', hp: 80 }, 0, 2.75, pz, w / 2, 0.08, 1.1, ['x', 0.2]);
  B.w = save;
}

function aframe(B, o) {
  // the ski lodge: a big A-frame (12 x 16) with a loft; knee walls 2.6 m, roof at 60 degrees
  const w = 12, d = 16;
  const st = STYLE.logs;
  B.h.style = 'wood'; B.h.roof = 'gable';
  foundation(B, w / 2, d / 2);
  const roof = { look: 'shingle', mat: 'wood', hp: 160 };
  const knee = 2.6;
  const ridge = knee + (w / 2) * T60;
  // loft over the back half, a ramp up the middle
  const rr = FH * STAIR[23].run;
  B.ramp({ look: 'floor', mat: 'wood', hp: 150 }, 0, 0, -1 + rr, 0, FH, -1, 1.7);
  // walls up to the knee: long sides plain, gable ends with a door / windows
  wall(B, 2, w, d, 0, knee, 'SWSSSSWS', st);
  wall(B, 3, w, d, 0, knee, 'SWSSSSWS', st);
  wall(B, 0, w, d, 0, knee, 'SWWDWS', st);
  wall(B, 1, w, d, 0, knee, 'SSWWSS', st);
  trims(B, w, d, 0, knee, st);
  // the two big roof slopes (ridge along z)
  const run = w / 2 + 0.5;
  const y0 = knee - 0.5 * T60;
  for (const sx of [1, -1]) {
    B.box(roof, sx * run / 2, (y0 + ridge) / 2 + C60 * 0.12, 0, run / C60 / 2, 0.12, d / 2 + 0.5, ['z', -sx * A60]);
  }
  // gable triangles above the walls
  for (const side of [0, 1]) {
    const z = side === 0 ? d / 2 - WT / 2 : -(d / 2 - WT / 2);
    B.prism(st, [[-w / 2, knee, z - WT / 2], [w / 2, knee, z - WT / 2], [0, ridge, z - WT / 2], [-w / 2, knee, z + WT / 2], [w / 2, knee, z + WT / 2], [0, ridge, z + WT / 2]]);
  }
  const lw = w / 2 - (FH + 1.9 - knee) / T60;  // half width of the loft with head room
  B.span({ look: 'floor', mat: 'wood', hp: 200 }, -lw, FH - 0.26, -d / 2 + WT, lw, FH, -1);
  B.level(FH);
  B.lootAt(-2.5, 3.5, 0); B.lootAt(2.5, 4, 0); B.lootAt(-1.8, -d / 2 + 2.5, FH);
  B.chestAt(1.9, -d / 2 + 1.3, FH, 0);
}

function adobe(B, o) {
  const { rng } = o;
  B.h.style = 'brick'; B.h.roof = 'flat';
  boxBuilding(B, { w: o.w, d: o.d, floors: o.floors || 1, st: STYLE.adobe, rng, roof: 'flat', parapet: 0.45, win: 0.4 });
  // vigas: roof beams poking out of the front wall
  const top = (o.floors || 1) * FH;
  for (let i = 0; i < o.w / 2 - 1; i++) B.box({ look: 'logs', mat: 'wood', hp: 40 }, -o.w / 2 + 1.5 + i * 2, top - 0.35, o.d / 2 + 0.3, 0.12, 0.12, 0.4);
}

function saloon(B, o) {
  const { rng } = o;
  const w = 12, d = 14;
  const dd = 12; // the box; a 2 m porch out front
  B.h.style = 'wood'; B.h.roof = 'flat';
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx, lz - 1);
  boxBuilding(B, {
    w, d: dd, floors: 2, st: STYLE.planks, rng, roof: 'flat', parapet: 0.3,
    pattern: (side, f, n) => (side === 0 ? (f === 0 ? 'SWWDWS' : 'SWDDWS') : pattern(rng, n, { win: 0.4 })),
  });
  // false front above the roof with the sign
  B.box({ look: 'planks', mat: 'wood', hp: 120 }, 0, 2 * FH + 1.4, dd / 2 - WT / 2, w / 2, 1.4, WT / 2);
  B.box({ look: 'panel', mat: 'wood', hp: 60 }, 0, 2 * FH + 1.3, dd / 2 + 0.05, 4, 0.6, 0.06, null, { tint: 0xf2d27a, sign: o.sign || 'SALOON' });
  // porch with a balcony on top (reached through the upstairs doors)
  B.span({ look: 'planks', mat: 'wood', hp: 120 }, -w / 2, -0.3, dd / 2, w / 2, 0, dd / 2 + 2);
  for (const sx of [1, -1, 0.33, -0.33]) B.box({ look: 'trim', mat: 'wood', hp: 80 }, sx * (w / 2 - 0.3), FH / 2, dd / 2 + 1.75, 0.13, FH / 2, 0.13);
  B.span({ look: 'planks', mat: 'wood', hp: 120 }, -w / 2, FH - 0.2, dd / 2, w / 2, FH, dd / 2 + 2);
  B.span({ look: 'trim', mat: 'wood', hp: 60 }, -w / 2, FH, dd / 2 + 1.85, w / 2, FH + 1.0, dd / 2 + 2);
  B.w = save;
}

function motel(B, o) {
  const { rng } = o;
  const w = o.w || 24, d = 8;
  B.h.style = 'brick'; B.h.roof = 'flat';
  foundation(B, w / 2, d / 2);
  const st = STYLE.stucco;
  const rooms = w / 8;
  let front = '';
  for (let r = 0; r < rooms; r++) front += 'SDWS';
  wall(B, 0, w, d, 0, FH, front, st);
  wall(B, 1, w, d, 0, FH, pattern(rng, w / 2, { win: 0.3 }), st);
  wall(B, 2, w, d, 0, FH, 'SWSS', st);
  wall(B, 3, w, d, 0, FH, 'SSWS', st);
  trims(B, w, d, 0, FH, st);
  // partitions between rooms
  for (let r = 1; r < rooms; r++) B.box(st, -w / 2 + r * 8, FH / 2, 0, WT / 2, FH / 2, d / 2 - WT);
  flatRoof(B, w, d, FH, st, 0.4);
  for (let r = 0; r < rooms; r++) B.lootAt(-w / 2 + r * 8 + 5.5, -1, 0);
  B.chestAt(-w / 2 + 6.5, -d / 2 + 1.0, 0, 0);
  if (rooms > 2) B.chestAt(w / 2 - 1.5, -d / 2 + 1.0, 0, 0);
  // the sign pole
  B.box({ look: 'trim', mat: 'metal', hp: 120 }, w / 2 + 0.6, 3.5, d / 2 - 1, 0.15, 3.5, 0.15);
  B.box({ look: 'panel', mat: 'metal', hp: 60 }, w / 2 + 0.6, 6.2, d / 2 - 1, 0.12, 0.9, 1.8, null, { tint: 0xff4f9a, sign: 'MOTEL' });
}

/**
 * A square tower (s x s, s = 8 or 10) with a spiral stair: ramp k runs along side k % 4, so each
 * floor has head room over the ramp that arrives at it. Used by the lighthouse, castle towers,
 * clock tower and watchtowers. walls(f, ly) builds the walls of storey f (or none: open).
 */
function spiralTower(B, s, storeys, fh, walls, slabSt, stairSt) {
  const inner = s / 2 - WT;
  const sw = 1.6;
  const run = fh * STAIR[45].run;    // 4 m for 3.2 m storeys
  const free = 2 * inner - 2 * sw;    // room for a run between the corner landings
  const ratio = run <= free + 0.01 ? 45 : 45;
  for (let f = 1; f < storeys; f++) {
    const yA = (f - 1) * fh, yB = f * fh;
    const k = (f - 1) % 4;
    const a = -inner + sw, b = a + run;   // run along the side, after the first corner landing
    let hole;
    if (k === 0) { B.ramp(stairSt, a, yA, -inner + sw / 2, b, yB, -inner + sw / 2, sw, ratio); hole = [a - 0.05, -inner, b + 0.2, -inner + sw + 0.05]; } else if (k === 1) { B.ramp(stairSt, inner - sw / 2, yA, a, inner - sw / 2, yB, b, sw, ratio); hole = [inner - sw - 0.05, a - 0.05, inner, b + 0.2]; } else if (k === 2) { B.ramp(stairSt, -a, yA, inner - sw / 2, -b, yB, inner - sw / 2, sw, ratio); hole = [-b - 0.2, inner - sw - 0.05, -a + 0.05, inner]; } else { B.ramp(stairSt, -inner + sw / 2, yA, -a, -inner + sw / 2, yB, -b, sw, ratio); hole = [-inner, -b - 0.2, -inner + sw + 0.05, -a + 0.05]; }
    slab(B, -inner, -inner, inner, inner, yB, hole, slabSt);
    B.level(yB);
  }
  for (let f = 0; f < storeys; f++) if (walls) walls(f, f * fh);
}

function lighthouse(B, o) {
  // a striped 8 x 8 tower: 4 storeys with a spiral stair, an open gallery on top, the lantern above
  const s = 8, storeys = 4;
  B.h.style = 'brick'; B.h.roof = 'flat';
  foundation(B, s / 2, s / 2);
  const st = { look: 'stucco', mat: 'stone', hp: 300 };
  const bands = [0xf4f1ea, 0xd2332b];
  spiralTower(B, s, storeys + 1, FH, (f, ly) => {
    if (f >= storeys) return;
    const tint = { tint: bands[f % 2] };
    for (let side = 0; side < 4; side++) wallTinted(B, side, s, s, ly, FH, f === 0 && side === 0 ? 'SDSS' : f > 0 && side === (f % 4) ? 'SWSS' : 'SSSS', st, tint);
  }, { look: 'concrete', mat: 'stone', hp: 260 }, { look: 'concrete', mat: 'stone', hp: 220 });
  const top = storeys * FH;
  // gallery railing on the wall tops, the lantern room (glass) and its cap
  for (const [x0, z0, x1, z1] of [[-s / 2, s / 2 - 0.15, s / 2, s / 2], [-s / 2, -s / 2, s / 2, -s / 2 + 0.15], [s / 2 - 0.15, -s / 2, s / 2, s / 2], [-s / 2, -s / 2, -s / 2 + 0.15, s / 2]]) {
    B.span({ look: 'trim', mat: 'metal', hp: 80 }, x0, top, z0, x1, top + 1.0, z1);
  }
  B.span({ look: 'glass', mat: 'metal', hp: 45 }, -1.9, top, -1.9, 1.9, top + 2.8, 1.9, { tint: 0xfff2a8, glow: 1 });
  pyramidCap(B, 2.4, top + 2.8, 2.2, { look: 'metalwall', mat: 'metal', hp: 160 }, { tint: 0xd2332b });
  for (let f = 0; f < storeys; f++) B.lootAt(0.6, 0.6, f * FH);
  B.lootAt(2.6, 2.6, top);
  B.chestAt(1.1, 1.3, (storeys - 1) * FH, 2);
}

function watchtower(B, o) {
  // an open 8 x 8 platform tower on posts, two spiral ramps up to a roofed lookout at 6.4 m
  const s = 8;
  B.h.style = 'wood'; B.h.roof = 'flat';
  const post = { look: 'logs', mat: 'wood', hp: 220 };
  const deck = { look: 'planks', mat: 'wood', hp: 160 };
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box(post, sx * (s / 2 - 0.2), 4.4, sz * (s / 2 - 0.2), 0.2, 4.4 + 1.2, 0.2);
  spiralTower(B, s, 3, FH, null, deck, deck);
  // railings on the lookout, a roof
  const top = 2 * FH;
  for (const [x0, z0, x1, z1] of [[-s / 2, s / 2 - 0.12, s / 2, s / 2], [-s / 2, -s / 2, s / 2, -s / 2 + 0.12], [s / 2 - 0.12, -s / 2, s / 2, s / 2], [-s / 2, -s / 2, -s / 2 + 0.12, s / 2]]) {
    B.span({ look: 'planks', mat: 'wood', hp: 70 }, x0, top, z0, x1, top + 1.0, z1);
  }
  B.box({ look: 'shingle', mat: 'wood', hp: 120 }, 0, top + 3.0, 0, s / 2 + 0.4, 0.12, s / 2 + 0.4);
  B.lootAt(0.8, 0.8, top);
  B.chestAt(1.5, 1.5, top, 2);
  B.h.open = true;
}

function clocktower(B, o) {
  const s = 10, storeys = 5;
  B.h.style = 'brick'; B.h.roof = 'flat';
  foundation(B, s / 2, s / 2);
  const st = STYLE.brick;
  spiralTower(B, s, storeys, FH, (f, ly) => {
    for (let side = 0; side < 4; side++) wall(B, side, s, s, ly, FH, f === 0 && (side === 0 || side === 3) ? 'SSDSS' : f === storeys - 1 ? 'SWSWS' : 'SSWSS', st);
    trims(B, s, s, ly, FH, st);
  }, { look: 'floor', mat: 'wood', hp: 200 }, { look: 'floor', mat: 'wood', hp: 160 });
  const top = storeys * FH;
  flatRoof(B, s, s, top, st, 0.8);
  // clock faces and a spire
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    B.box({ look: 'panel', mat: 'stone', hp: 0 }, nx * (s / 2 + 0.08), top - 1.7, nz * (s / 2 + 0.08), nx ? 0.06 : 1.6, 1.4, nz ? 0.06 : 1.6, null, { tint: 0xf6f0dc, sign: 'CLOCK' });
  }
  pyramidCap(B, s / 2, top + 1.1, 6, { look: 'rooftile', mat: 'stone', hp: 200 }, { tint: 0x3e5574 });
  for (let f = 0; f < storeys; f++) B.lootAt(1.2, 1.0, f * FH);
  B.chestAt(1.6, 1.8, (storeys - 1) * FH, 2);
  B.chestAt(2.2, 1.2, 0, 1);
}

function castle(B, o) {
  // curtain walls (S x S), four corner towers, a gate, a wall walk and a two-storey keep
  const S = o.w;
  const ice = o.ice;
  const st = ice ? STYLE.ice : STYLE.castle;
  const tower = 8;
  B.h.style = 'brick'; B.h.roof = 'flat';
  const hw = S / 2;
  const wallH = 6.4, wt = 1.6;
  const run = S - 2 * tower;
  const merlon = { look: st.look, mat: 'stone', hp: 120 };
  // the wall walk: a ramp in the courtyard against the back wall
  const rr = wallH * STAIR[23].run;
  B.ramp({ look: st.look, mat: 'stone', hp: 0 }, -rr / 2, 0, -hw + wt + 1.05, rr / 2, wallH, -hw + wt + 1.05, 2.0);
  B.level(wallH);
  for (const side of [0, 1, 2, 3]) {
    const alongX = side < 2;
    const sg = side === 0 || side === 2 ? 1 : -1;
    const fixed = sg * (hw - wt / 2);
    const seg = (c0, c1, y0, y1, s2 = st, f = fixed, t = wt) => {
      if (alongX) B.box(s2, (c0 + c1) / 2, (y0 + y1) / 2, f, (c1 - c0) / 2, (y1 - y0) / 2, t / 2);
      else B.box(s2, f, (y0 + y1) / 2, (c0 + c1) / 2, t / 2, (y1 - y0) / 2, (c1 - c0) / 2);
    };
    const c0 = -run / 2, c1 = run / 2;
    if (side === 0) {
      seg(c0, -2.5, 0, wallH); seg(2.5, c1, 0, wallH); seg(-2.5, 2.5, 4.2, wallH);
      B.door(0, fixed, 0, 0, 1, 4.2, 5);
    } else {
      for (let c = c0; c < c1 - 0.01; c += 4) seg(c, Math.min(c1, c + 4), 0, wallH);
    }
    // merlons on the outer edge of the wall top
    for (let c = c0 + 0.8; c < c1 - 0.8; c += 3) seg(c, c + 1.4, wallH, wallH + 1.0, merlon, sg * (hw - 0.25), 0.5);
  }
  // corner towers: 3 storeys with a spiral stair, the door toward the courtyard (along x)
  const tst = { look: st.look, mat: 'stone', hp: 360 };
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const cx = sx * (hw - tower / 2), cz = sz * (hw - tower / 2);
    const save = B.w.bind(B);
    B.w = (lx, lz) => save(lx + cx, lz + cz);
    const doorSide = sx > 0 ? 3 : 2;
    spiralTower(B, tower, 3, FH, (f, ly) => {
      for (let side = 0; side < 4; side++) wall(B, side, tower, tower, ly, FH, f === 0 && side === doorSide ? 'SDSS' : f === 2 ? 'SWWS' : 'SSWS', tst);
    }, { look: 'floor', mat: 'wood', hp: 200 }, { look: 'floor', mat: 'wood', hp: 160 });
    B.span({ look: st.look, mat: 'stone', hp: 0 }, -tower / 2 - 0.3, 3 * FH, -tower / 2 - 0.3, tower / 2 + 0.3, 3 * FH + 0.3, tower / 2 + 0.3);
    for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) B.box(merlon, a * (tower / 2 + 0.05), 3 * FH + 0.8, b * (tower / 2 + 0.05), a ? 0.25 : 1.2, 0.5, b ? 0.25 : 1.2);
    B.box({ look: 'panel', mat: 'wood', hp: 30 }, 0, 3 * FH + 3.6, 0.7, 0.05, 0.5, 0.7, null, { tint: ice ? 0x7fd3ff : 0xd2332b });
    B.box({ look: 'trim', mat: 'wood', hp: 30 }, 0, 3 * FH + 2.4, 0, 0.06, 2.1, 0.06);
    B.lootAt(0.5, 0.5, 2 * FH);
    B.w = save;
  }
  // the keep: two storeys in the middle
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx, lz - 2);
  boxBuilding(B, { w: 12, d: 12, floors: 2, st: tst, rng: o.rng, roof: 'flat', parapet: 1.0, win: 0.35, floorSt: { look: 'floor', mat: 'wood', hp: 220 } });
  B.w = save;
  B.lootAt(-hw + 12, hw - 6, 0); B.lootAt(hw - 12, hw - 6, 0); B.lootAt(0, hw - 4, 0);
  B.chestAt(-hw + wt + 2, hw - wt - 4, 0, 1);
}

function temple(B, o) {
  // a stepped pyramid: three indestructible tiers with ramps up the front, a shrine on top
  const core = { look: 'sandstone', mat: 'stone', hp: 0 };
  const mossy = { tint: 0x9aa486 };
  B.h.style = 'brick'; B.h.roof = 'flat';
  const tiers = [[14, 2.4], [9, 4.8], [4, 7.2]];   // half size, top height; centred at z = -2
  for (const [hs, top] of tiers) B.box(core, 0, (top - 0.6) / 2, -2, hs, (top + 0.6) / 2, hs, null, mossy);
  // ramps up the front of each tier (2.4 m rise, 3.6 m run)
  const rr = 2.4 * STAIR[23].run;
  tiers.forEach(([hs, top], t) => {
    const zf = -2 + hs;
    B.ramp({ look: 'sandstone', mat: 'stone', hp: 0 }, 0, top - 2.4, zf + rr, 0, top, zf, 3.0);
    B.level(top);
  });
  // the shrine on top: 8 x 8 walls with a door, a chest inside
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx, lz - 2);
  const sst = { look: 'sandstone', mat: 'stone', hp: 260 };
  const saveY = B.y0;
  B.y0 = saveY + 7.2;
  for (let side = 0; side < 4; side++) wall(B, side, 8, 8, 0, 3.4, side === 0 ? 'SDDS' : 'SWWS', sst);
  B.span({ look: 'sandstone', mat: 'stone', hp: 200 }, -4.3, 3.4, -4.3, 4.3, 3.8, 4.3);
  pyramidCap(B, 4.3, 3.8, 2.4, { look: 'sandstone', mat: 'stone', hp: 180 }, { tint: 0x3fa34d });
  B.lootAt(-1.8, 1.2, 0);
  B.chestAt(1.6, -2.6, 0, 0);
  B.y0 = saveY;
  B.w = save;
  // loot on the terraces and at the foot
  B.lootAt(-11.5, 0, 2.4); B.lootAt(11.5, -10, 2.4); B.lootAt(-6.5, -8, 4.8); B.lootAt(10, 14, 0);
  B.h.open = true;
}

function pirateShip(B, o) {
  // hull along local z (bow at +z), deck at 2.8 m above the water, a raised stern deck
  B.h.style = 'wood'; B.h.roof = 'flat';
  const keel = { look: 'planks', mat: 'wood', hp: 0 };
  const hull = { look: 'planks', mat: 'wood', hp: 180 };
  const dark = { tint: 0x5a3a22 };
  const L = 24, hw = 4;
  const deckY = 0; // floor 0 = the main deck
  const bottom = -(B.h.y - B.h.base) - 1.2;
  // keel / hull core (indestructible) below the deck
  B.span(keel, -hw + 0.5, bottom, -L / 2 + 1, hw - 0.5, deckY - 0.3, L / 2 - 4, dark);
  // deck
  B.span({ look: 'planks', mat: 'wood', hp: 0 }, -hw, deckY - 0.3, -L / 2, hw, deckY, L / 2 - 4);
  // hull sides (bulwarks) above the deck, destructible, in 4 m pieces
  for (const sx of [1, -1]) {
    for (let z = -L / 2; z < L / 2 - 4 - 0.01; z += 4) B.span(hull, sx * hw - 0.15, bottom + 1, z, sx * hw + 0.15, deckY + 1.1, z + 4, dark);
  }
  B.span(hull, -hw, bottom + 1, -L / 2 - 0.3, hw, deckY + 1.1, -L / 2, dark);
  // bow: two prisms closing the front to a point
  for (const sx of [1, -1]) {
    B.prism(hull, [[sx * hw, bottom + 1, L / 2 - 4], [0, bottom + 1, L / 2 + 2], [0, bottom + 1, L / 2 - 4], [sx * hw, deckY + 1.1, L / 2 - 4], [0, deckY + 1.1, L / 2 + 2], [0, deckY + 1.1, L / 2 - 4]], dark);
  }
  // stern castle (raised deck at 3.2 m) with a ramp
  const rr = FH * STAIR[23].run;
  B.span({ look: 'planks', mat: 'wood', hp: 200 }, -hw, FH - 0.26, -L / 2, hw, FH, -L / 2 + 5);
  B.span(hull, -hw, 0, -L / 2 + 4.85, -1.2, FH, -L / 2 + 5, dark);
  B.span(hull, 1.2, 0, -L / 2 + 4.85, hw, FH, -L / 2 + 5, dark);
  B.ramp({ look: 'planks', mat: 'wood', hp: 150 }, 2.6, 0, -L / 2 + 5 + rr, 2.6, FH, -L / 2 + 5, 1.6);
  B.level(FH);
  // masts and sails
  for (const [z, hgt] of [[3, 14], [-5, 12]]) {
    B.box({ look: 'logs', mat: 'wood', hp: 200 }, 0, hgt / 2, z, 0.25, hgt / 2, 0.25);
    B.box({ look: 'panel', mat: 'wood', hp: 50 }, 0, hgt * 0.62, z + 0.4, 3.2, hgt * 0.22, 0.05, null, { tint: 0xeee6d2 });
  }
  B.box({ look: 'panel', mat: 'wood', hp: 30 }, 0, 14.5, 3, 0.05, 0.5, 0.8, null, { tint: 0x141414 });
  B.lootAt(-2, 6, 0); B.lootAt(2, -2, 0); B.lootAt(0, -L / 2 + 2.5, FH);
  B.chestAt(-2.6, -L / 2 + 1.2, FH, 0);
  B.h.open = true;
}

function pier(B, o) {
  // a plank deck on posts, running along local z from the shore (-z) out over the water (+z)
  const len = o.d, wd = o.w;
  B.h.style = 'wood'; B.h.roof = 'flat';
  const deck = { look: 'planks', mat: 'wood', hp: 0 };
  B.span(deck, -wd / 2, -0.25, -len / 2, wd / 2, 0, len / 2);
  const post = { look: 'logs', mat: 'wood', hp: 0 };
  const depth = B.h.y + 3;
  for (let z = -len / 2 + 2; z <= len / 2 - 1; z += 6) {
    for (const sx of [1, -1]) B.box(post, sx * (wd / 2 - 0.2), -depth / 2, z, 0.18, depth / 2, 0.18);
  }
  // railings (destructible)
  for (const sx of [1, -1]) B.span({ look: 'planks', mat: 'wood', hp: 50 }, sx * (wd / 2) - 0.1, 0, -len / 2 + 4, sx * (wd / 2) + 0.1, 1.0, len / 2);
  B.lootAt(0, len / 2 - 3, 0);
  B.h.open = true;
}

function bridge(B, o) {
  // deck along local z (length d, width w), indestructible deck and piers, destructible railings
  const len = o.d, wd = o.w;
  B.h.style = 'metal'; B.h.roof = 'flat';
  const deck = { look: 'concrete', mat: 'stone', hp: 0 };
  B.span(deck, -wd / 2, -0.6, -len / 2, wd / 2, 0, len / 2);
  const depth = B.h.y + 4;
  for (let z = -len / 2 + 6; z <= len / 2 - 6; z += 12) B.box(deck, 0, -depth / 2, z, wd / 2 - 1, depth / 2, 0.6);
  for (const sx of [1, -1]) {
    for (let z = -len / 2; z < len / 2 - 0.01; z += 8) B.span({ look: 'metalwall', mat: 'metal', hp: 120 }, sx * wd / 2 - 0.12, 0, z, sx * wd / 2 + 0.12, 1.1, Math.min(len / 2, z + 8), { tint: 0xb83b2e });
  }
  B.h.open = true;
}

function stadium(B, o) {
  // four stands of bleachers (30 degree slopes you can run up) around a pitch; open corners
  const W = o.w, D = o.d; // 64 x 48
  B.h.style = 'brick'; B.h.roof = 'flat';
  const back = { look: 'concrete', mat: 'stone', hp: 0 };
  const depth = 8, rise = depth * T30;
  const colors = [0x2f7de1, 0xd8433a, 0xf0b429, 0x3fa34d];
  for (const side of [0, 1, 2, 3]) {
    const alongX = side < 2;
    const len = alongX ? W - 2 * depth - 4 : D - 2 * depth - 4;
    const out = alongX ? D / 2 : W / 2;
    const sg = side === 0 || side === 2 ? 1 : -1;
    const seats = { look: 'panel', mat: 'stone', hp: 0 };
    // the sloped stand: the walking surface rises outward from the pitch to the back wall
    if (alongX) {
      B.ramp(seats, 0, 0, sg * (out - depth - 0.5), 0, rise, sg * (out - 0.5), len, 30, { tint: colors[side] });
      B.box(back, 0, (rise + 1.2) / 2, sg * (out - 0.25), len / 2, (rise + 1.2) / 2, 0.25);
    } else {
      B.ramp(seats, sg * (out - depth - 0.5), 0, 0, sg * (out - 0.5), rise, 0, len, 30, { tint: colors[side] });
      B.box(back, sg * (out - 0.25), (rise + 1.2) / 2, 0, 0.25, (rise + 1.2) / 2, len / 2);
    }
  }
  B.level(rise);
  // goals
  for (const sx of [1, -1]) {
    const gx = sx * (W / 2 - depth - 3);
    B.box({ look: 'trim', mat: 'metal', hp: 0 }, gx, 1.2, -3, 0.1, 1.2, 0.1);
    B.box({ look: 'trim', mat: 'metal', hp: 0 }, gx, 1.2, 3, 0.1, 1.2, 0.1);
    B.box({ look: 'trim', mat: 'metal', hp: 0 }, gx, 2.45, 0, 0.1, 0.1, 3.1);
  }
  // scoreboard over the back stand
  B.box({ look: 'panel', mat: 'metal', hp: 0 }, 0, rise + 5.2, -D / 2 + 0.3, 8, 2.5, 0.3, null, { tint: 0x1a2633, sign: 'PHUN STADIUM' });
  for (const sx of [-5, 5]) B.box({ look: 'trim', mat: 'metal', hp: 0 }, sx, rise + 1.4, -D / 2 + 0.3, 0.3, 1.4, 0.3);
  B.lootAt(0, 0, 0); B.lootAt(-12, 6, 0); B.lootAt(12, -6, 0);
  B.chestAt(0, 4, 0, 0);
  B.h.open = true;
}

function stiltHouse(B, o) {
  // a house raised 2.4 m on posts (swamps, beaches) with a porch and a ramp up to it
  const { rng } = o;
  const w = o.w, d = o.d - 4;   // the house box; 4 m in front for the porch and the ramp lane
  const lift = 2.4;
  B.h.style = 'wood'; B.h.roof = 'gable';
  const st = o.st || STYLE.planks;
  const post = { look: 'logs', mat: 'wood', hp: 0 };
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx, lz - 2);
  const depth = lift + (B.h.y - B.h.base) + 1;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, -1]]) B.box(post, sx * (w / 2 - 0.3), lift - depth / 2, sz * (d / 2 - 0.3), 0.2, depth / 2, 0.2);
  // ramp along x in the lane in front of the porch, then a landing deck
  const laneZ = d / 2 + 1.6 + 0.95, rr = lift * STAIR[23].run;
  const rx0 = -w / 2 + 0.3;
  B.ramp({ look: 'planks', mat: 'wood', hp: 120 }, rx0, 0, laneZ, rx0 + rr, lift, laneZ, 1.8);
  B.span({ look: 'planks', mat: 'wood', hp: 0 }, rx0 + rr, lift - 0.26, d / 2 + 1.6, w / 2, lift, d / 2 + 3.5);
  B.box(post, w / 2 - 0.3, lift - depth / 2, d / 2 + 3.2, 0.2, depth / 2, 0.2);
  const saveY = B.y0;
  B.y0 = saveY + lift;
  B.level(0);
  for (let side = 0; side < 4; side++) {
    const n = side < 2 ? w / 2 : d / 2;
    wall(B, side, w, d, 0, FH, pattern(rng, n, { door: side === 0 ? Math.floor(n / 2) : -1, win: 0.5 }), st, { doorsAll: true });
  }
  trims(B, w, d, 0, FH, st);
  B.span({ look: 'planks', mat: 'wood', hp: 0 }, -w / 2, -0.26, -d / 2, w / 2, 0, d / 2 + 1.6);
  gableRoof(B, w, d, FH, { look: 'shingle', mat: 'wood', hp: 140 }, st);
  B.lootAt(w / 4, 0, 0); B.lootAt(-w / 4, -d / 4, 0);
  B.chestAt(w / 2 - 1.1, -d / 2 + 1.0, 0, 0);
  B.y0 = saveY;
  B.w = save;
  // the porch door is not a ground-level door
  B.doors = B.doors.filter((dd) => dd[2] < saveY + 0.5);
  B.h.open = true;
}

function treehouse(B, o) {
  // a cabin on a platform 6.4 m up, reached by two ramps around the posts (jungle)
  const s = 8;
  B.h.style = 'wood'; B.h.roof = 'gable';
  const post = { look: 'logs', mat: 'wood', hp: 260 };
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box(post, sx * (s / 2 - 0.25), 3.0, sz * (s / 2 - 0.25), 0.25, 4.2, 0.25);
  spiralTower(B, s, 3, FH, null, { look: 'planks', mat: 'wood', hp: 200 }, { look: 'planks', mat: 'wood', hp: 150 });
  // the cabin on top covers the platform except the arrival strip (ramp 2 arrives along side 1 = +x)
  const top = 2 * FH;
  const cw = 5.2, cd = 5.2;
  const save = B.w.bind(B);
  B.w = (lx, lz) => save(lx - 1.2, lz + 1.2);
  const saveY = B.y0;
  B.y0 = saveY + top;
  for (let side = 0; side < 4; side++) wall(B, side, cw, cd, 0, 2.8, side === 3 ? 'SWS' : side === 1 ? 'SDS' : 'SWS', STYLE.planks, { doorsAll: true });
  gableRoof(B, cw, cd, 2.8, { look: 'shingle', mat: 'wood', hp: 120 }, STYLE.planks, true);
  B.lootAt(0.8, 0, 0);
  B.chestAt(1.2, 1.4, 0, 2);
  B.y0 = saveY;
  B.w = save;
  B.doors = B.doors.filter((d) => d[2] < saveY + 0.5); // upper doors are not ground doors
  B.h.open = true;
}

function lair(B, o) {
  // a villain's modern villa: concrete and glass, two storeys, flat roof
  const { rng } = o;
  B.h.style = 'brick'; B.h.roof = 'flat';
  const glassTint = 0x2c3e50;
  boxBuilding(B, {
    w: o.w, d: o.d, floors: 2, st: STYLE.concrete, rng, roof: 'flat', parapet: 0.3, lootDensity: 2,
    pattern: (side, f, n) => (side === 0 ? (f === 0 ? 'SFFDFS'.slice(0, n) : 'GGGGGG'.slice(0, n)) : pattern(rng, n, { win: 0.6, kind: 'G' })),
    wallOpts: { glass: { look: 'glass', mat: 'metal', hp: 45 } },
  });
  B.box({ look: 'panel', mat: 'stone', hp: 0 }, 0, 2 * FH + 0.6, o.d / 2 + 0.06, 3, 0.4, 0.05, null, { tint: 0xd2332b, sign: 'LAIR' });
  void glassTint;
}

function shed(B, o) {
  const { rng } = o;
  B.h.style = 'metal'; B.h.roof = 'flat';
  boxBuilding(B, { w: o.w, d: o.d, floors: 1, st: o.st || STYLE.corrugated, rng, roof: 'flat', parapet: 0, win: 0.3 });
}

function mall(B, o) {
  // Retail Rumble's big store: 24 x 16, two storeys, storefronts all along the front
  const { rng } = o;
  B.h.style = 'brick'; B.h.roof = 'flat';
  boxBuilding(B, {
    w: o.w, d: o.d, floors: 2, st: STYLE.panel, rng, roof: 'flat', parapet: 0.9, lootDensity: 2,
    pattern: (side, f, n) => {
      if (side === 0 && f === 0) { let s = ''; for (let i = 0; i < n; i++) s += i === 2 || i === n - 3 ? 'D' : i === 0 || i === n - 1 ? 'S' : 'F'; return s; }
      if (side === 0) return 'S' + 'G'.repeat(n - 2) + 'S';
      if (side === 1 && f === 0) return pattern(rng, n, { door: Math.floor(n / 2), win: 0.1 });
      return pattern(rng, n, { win: 0.25 });
    },
  });
  B.box({ look: 'panel', mat: 'stone', hp: 80 }, 0, 2 * FH + 1.0, o.d / 2 + 0.1, 6, 0.7, 0.06, null, { tint: 0xff4f9a, sign: 'RETAIL RUMBLE' });
  B.chestAt(-o.w / 2 + 1.2, o.d / 2 - 1.3, 0, 2);
}

function shack(B, o) {
  const { rng } = o;
  B.h.style = 'wood'; B.h.roof = 'flat';
  const tint = [0x7fd3ff, 0xffd23f, 0xff8fb1, 0x8fe38f][Math.floor(rng() * 4)];
  const save = B.box.bind(B);
  B.box = (s, a, b2, c, e, f, g, tilt, ex) => save(s, a, b2, c, e, f, g, tilt, ex || (s.look === 'planks' ? { tint } : undefined));
  boxBuilding(B, { w: o.w, d: o.d, floors: 1, st: STYLE.planks, rng, roof: 'gable', roofSt: { look: 'rooftile', mat: 'wood', hp: 120 }, win: 0.6 });
  B.box = save;
}

function mineEntrance(B, o) {
  // a timber-framed tunnel mouth into the hillside, with a cart track inside
  B.h.style = 'wood'; B.h.roof = 'flat';
  const rock = { look: 'castle', mat: 'stone', hp: 0 };
  const tint = { tint: 0x5b4a44 };
  B.span(rock, -6, 0, -6, -2, 6, 6, tint);
  B.span(rock, 2, 0, -6, 6, 6, 6, tint);
  B.span(rock, -6, 4, -6, 6, 6, 6, tint);
  B.span(rock, -6, 0, -6, 6, 4, -5, tint);
  const beam = { look: 'logs', mat: 'wood', hp: 120 };
  for (const z of [5.6, 2, -2]) {
    B.box(beam, -1.8, 1.9, z, 0.2, 1.9, 0.2);
    B.box(beam, 1.8, 1.9, z, 0.2, 1.9, 0.2);
    B.box(beam, 0, 3.85, z, 2, 0.15, 0.2);
  }
  B.door(0, 6, 0, 0, 1, 3.7, 3.6);
  B.lootAt(0, -2.5, 0);
  B.chestAt(0.6, -4.2, 0, 0);
}

function radioTower(B, o) {
  // a 30 m lattice mast on a concrete pad with a blinking light (not climbable)
  B.h.style = 'metal'; B.h.roof = 'flat';
  const leg = { look: 'metalwall', mat: 'metal', hp: 0 };
  const brace = { look: 'trim', mat: 'metal', hp: 140 };
  const red = { tint: 0xc8372b }, white = { tint: 0xf0f0f0 };
  B.span({ look: 'concrete', mat: 'stone', hp: 0 }, -3, -0.6, -3, 3, 0.2, 3);
  const H = 30;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.box(leg, sx * 1.4, H / 2, sz * 1.4, 0.14, H / 2, 0.14, null, red);
  for (let y = 3; y < H; y += 5) {
    const t = (y / 5) % 2 ? red : white;
    B.box(brace, 0, y, 1.4, 1.4, 0.08, 0.08, null, t);
    B.box(brace, 0, y, -1.4, 1.4, 0.08, 0.08, null, t);
    B.box(brace, 1.4, y, 0, 0.08, 0.08, 1.4, null, t);
    B.box(brace, -1.4, y, 0, 0.08, 0.08, 1.4, null, t);
  }
  B.box({ look: 'glass', mat: 'metal', hp: 30 }, 0, H + 0.6, 0, 0.35, 0.35, 0.35, null, { tint: 0xff3020, glow: 1 });
  B.lootAt(2.6, 0, 0.2);
  B.h.open = true;
}

/** Archetype table: footprint (w x d in metres, multiples of 4) and builder. */
export const ARCHETYPES = {
  house: { fn: house, size: (r) => [[8, 8], [12, 8], [8, 12], [12, 12]][Math.floor(r() * 4)], floors: (r) => (r() < 0.35 ? 2 : 1) },
  apartment: { fn: apartment, size: (r) => [[12, 12], [16, 12]][Math.floor(r() * 2)], floors: (r) => 3 + (r() < 0.4 ? 1 : 0) },
  shop: { fn: shop, size: (r) => [[12, 12], [16, 12], [8, 12]][Math.floor(r() * 3)], floors: (r) => (r() < 0.4 ? 2 : 1) },
  skyscraper: { fn: skyscraper, size: () => [16, 16], floors: (r) => 5 + Math.floor(r() * 4) },
  gas: { fn: gasStation, size: () => [20, 12], floors: () => 1 },
  warehouse: { fn: warehouse, size: (r) => [[24, 16], [20, 16], [16, 12]][Math.floor(r() * 3)], floors: () => 1 },
  barn: { fn: barn, size: () => [12, 16], floors: () => 2 },
  silo: { fn: silo, size: () => [8, 8], floors: () => 1 },
  windmill: { fn: windmill, size: () => [8, 8], floors: () => 2 },
  cabin: { fn: cabin, size: (r) => [[8, 10], [12, 10], [8, 14]][Math.floor(r() * 3)], floors: (r) => (r() < 0.3 ? 2 : 1) },
  lodge: { fn: aframe, size: () => [12, 16], floors: () => 2 },
  adobe: { fn: adobe, size: (r) => [[8, 8], [12, 8], [8, 12]][Math.floor(r() * 3)], floors: (r) => (r() < 0.3 ? 2 : 1) },
  saloon: { fn: saloon, size: () => [12, 14], floors: () => 2 },
  motel: { fn: motel, size: (r) => [[24, 8], [32, 8]][Math.floor(r() * 2)], floors: () => 1 },
  lighthouse: { fn: lighthouse, size: () => [10, 10], floors: () => 4 },
  ship: { fn: pirateShip, size: () => [10, 28], floors: () => 2 },
  temple: { fn: temple, size: () => [28, 32], floors: () => 4 },
  castle: { fn: castle, size: () => [40, 40], floors: () => 3 },
  icecastle: { fn: (B, o) => castle(B, { ...o, ice: true }), size: () => [32, 32], floors: () => 3 },
  watchtower: { fn: watchtower, size: () => [8, 8], floors: () => 3 },
  clocktower: { fn: clocktower, size: () => [12, 12], floors: () => 5 },
  pier: { fn: pier, size: () => [4, 24], floors: () => 1 },
  bridge: { fn: bridge, size: () => [8, 40], floors: () => 1 },
  stadium: { fn: stadium, size: () => [64, 48], floors: () => 1 },
  stilt: { fn: stiltHouse, size: (r) => [[8, 12], [12, 12]][Math.floor(r() * 2)], floors: () => 1 },
  treehouse: { fn: treehouse, size: () => [8, 8], floors: () => 3 },
  lair: { fn: lair, size: () => [16, 12], floors: () => 2 },
  shed: { fn: shed, size: (r) => [[8, 8], [12, 8]][Math.floor(r() * 2)], floors: () => 1 },
  mall: { fn: mall, size: () => [24, 16], floors: () => 2 },
  shack: { fn: shack, size: () => [8, 8], floors: () => 1 },
  mine: { fn: mineEntrance, size: () => [12, 12], floors: () => 1 },
  radio: { fn: radioTower, size: () => [8, 8], floors: () => 1 },
};

/** Archetypes whose base is a deck over water or sand rather than a terrain pad. */
export const WATER_OK = new Set(['pier', 'bridge', 'ship']);

const TIER_CHEST = { hot: 1, normal: 0.6, quiet: 0.38 };
const TIER_LOOT = { hot: 1, normal: 0.75, quiet: 0.55 };

/**
 * Emit one building. opts: { x, z, rot, base, w, d, floors, region, tier, rng, paint?, ...archetype opts }.
 * Pushes parts into W.objects and candidate loot / chests into W.lootCand / W.chestCand; returns
 * the house record.
 */
export function emitBuilding(W, arch, opts) {
  const A = ARCHETYPES[arch];
  const { rng } = opts;
  const rot = opts.rot | 0;
  const w = opts.w, d = opts.d;
  const hx = (rot % 2 ? d : w) / 2, hz = (rot % 2 ? w : d) / 2;
  const h = {
    id: W.houses.length, x: opts.x, z: opts.z, y: opts.base + (opts.lift ?? 0.25), base: opts.base, rot, w, d, hx, hz,
    floors: opts.floors, style: 'wood', roof: 'flat', paint: opts.paint ?? Math.floor(rng() * 4), poi: opts.region ?? -1,
    archetype: arch, region: opts.region ?? -1, tier: opts.tier || 'normal',
  };
  W.houses.push(h);
  const B = new Builder(W, h);
  A.fn(B, { ...opts, rng, w, d, tier: h.tier });
  h.top = B.top;
  h.stairs = B.stairs;
  h.doors = B.doors;
  h.levels = B.levels;
  h.bounds = [B.minX, B.minZ, B.maxX, B.maxZ];
  // loot and chests, thinned by tier
  const pl = TIER_LOOT[h.tier] ?? 0.75, pc = TIER_CHEST[h.tier] ?? 0.6;
  B.loot.forEach(([lx, lz, ly], i) => {
    if (i > 0 && rng() > pl) return;
    const [x, z] = B.w(lx, lz);
    W.lootCand.push({ x, y: B.y0 + ly + 0.05, z, tier: h.tier, house: h.id });
  });
  B.chestSpots.forEach(([lx, lz, ly, face], i) => {
    if (rng() > pc && !(i === 0 && h.tier === 'hot')) return;
    const [x, z] = B.w(lx, lz);
    W.chestCand.push({ x, y: B.y0 + ly + 0.02, z, yaw: YAWS[(face + rot) % 4], tier: h.tier, house: h.id });
  });
  return h;
}

export { YAWS, ENV };
