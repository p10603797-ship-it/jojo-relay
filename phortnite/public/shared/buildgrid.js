// Build grid math shared by client and server: keys, corners, structural support.
import { BUILD, MAP } from './constants.js';

const C = BUILD.cell, L = BUILD.level;
// farthest grid cell from the centre a piece may use: 1.25 map sizes out (200 cells on the 640 m island)
const MAX_CELL = Math.ceil((MAP.size * 1.25) / C);

/** Types: 'w' wall (o = 'x' | 'z'), 'f' floor, 'r' ramp (d = 0..3 rising toward +z,+x,-z,-x). */
export function pieceKey(t, cx, cy, cz, o) {
  return t === 'w' ? `w${cx},${cy},${cz},${o}` : `${t}${cx},${cy},${cz}`;
}

export function parseKey(k) {
  if (typeof k !== 'string' || k.length > 40) return null;
  const t = k[0];
  if (t !== 'w' && t !== 'f' && t !== 'r') return null;
  const parts = k.slice(1).split(',');
  const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
  if (![cx, cy, cz].every(Number.isFinite)) return null;
  if (Math.abs(cx) > MAX_CELL || Math.abs(cz) > MAX_CELL || cy < -10 || cy > 60) return null;
  if (t === 'w') {
    const o = parts[3];
    if (o !== 'x' && o !== 'z') return null;
    return { t, cx, cy, cz, o };
  }
  return { t, cx, cy, cz };
}

/** Integer grid corners (gx, gy, gz) of a piece. */
export function corners(p) {
  const { t, cx, cy, cz } = p;
  if (t === 'f') return [[cx, cy, cz], [cx + 1, cy, cz], [cx, cy, cz + 1], [cx + 1, cy, cz + 1]];
  if (t === 'w') {
    if (p.o === 'x') return [[cx, cy, cz], [cx + 1, cy, cz], [cx, cy + 1, cz], [cx + 1, cy + 1, cz]];
    return [[cx, cy, cz], [cx, cy, cz + 1], [cx, cy + 1, cz], [cx, cy + 1, cz + 1]];
  }
  switch (p.d | 0) {
    case 0: return [[cx, cy, cz], [cx + 1, cy, cz], [cx, cy + 1, cz + 1], [cx + 1, cy + 1, cz + 1]];
    case 1: return [[cx, cy, cz], [cx, cy, cz + 1], [cx + 1, cy + 1, cz], [cx + 1, cy + 1, cz + 1]];
    case 2: return [[cx, cy, cz + 1], [cx + 1, cy, cz + 1], [cx, cy + 1, cz], [cx + 1, cy + 1, cz]];
    default: return [[cx + 1, cy, cz], [cx + 1, cy, cz + 1], [cx, cy + 1, cz], [cx, cy + 1, cz + 1]];
  }
}

const ck = (c) => `${c[0]},${c[1]},${c[2]}`;
const ek = (a, b) => { const ka = ck(a), kb = ck(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

/** Edge keys of a piece (pieces sharing an edge are structurally connected). */
export function edges(p) {
  const c = corners(p);
  // corners are listed as [a, b, c, d] where (a,b) is one edge and (c,d) the opposite edge
  return [ek(c[0], c[1]), ek(c[2], c[3]), ek(c[0], c[2]), ek(c[1], c[3])];
}

/** World-space centre + rotation description of a piece (for colliders & rendering). */
export function piecePose(p) {
  const { t, cx, cy, cz } = p;
  if (t === 'f') return { x: cx * C + C / 2, y: cy * L, z: cz * C + C / 2 };
  if (t === 'w') {
    if (p.o === 'x') return { x: cx * C + C / 2, y: cy * L + L / 2, z: cz * C };
    return { x: cx * C, y: cy * L + L / 2, z: cz * C + C / 2 };
  }
  return { x: cx * C + C / 2, y: cy * L + L / 2, z: cz * C + C / 2 };
}

/**
 * Track pieces and answer support questions.
 * heightAt(x,z) gives terrain height; solidNear(x,y,z) says whether a world object supports a point.
 */
export class BuildGrid {
  constructor(heightAt, solidNear) {
    this.heightAt = heightAt;
    this.solidNear = solidNear || (() => false);
    this.pieces = new Map();   // key -> piece
    this.edgeMap = new Map();  // edgeKey -> Set(key)
    this.destroyedObjects = null;
  }

  clear() { this.pieces.clear(); this.edgeMap.clear(); }

  has(k) { return this.pieces.has(k); }
  get(k) { return this.pieces.get(k); }

  add(p) {
    this.pieces.set(p.k, p);
    for (const e of edges(p)) {
      let s = this.edgeMap.get(e);
      if (!s) this.edgeMap.set(e, (s = new Set()));
      s.add(p.k);
    }
  }

  remove(k) {
    const p = this.pieces.get(k);
    if (!p) return null;
    this.pieces.delete(k);
    for (const e of edges(p)) {
      const s = this.edgeMap.get(e);
      if (s) { s.delete(k); if (!s.size) this.edgeMap.delete(e); }
    }
    return p;
  }

  neighbors(p) {
    const out = new Set();
    for (const e of edges(p)) {
      const s = this.edgeMap.get(e);
      if (s) for (const k of s) if (k !== p.k) out.add(k);
    }
    return out;
  }

  grounded(p) {
    const cs = corners(p);
    let minY = Infinity;
    for (const c of cs) minY = Math.min(minY, c[1]);
    for (const c of cs) {
      if (c[1] !== minY) continue;
      const x = c[0] * C, z = c[2] * C, y = c[1] * L;
      if (y <= this.heightAt(x, z) + 0.3) return true;
      if (this.solidNear(x, y, z, this.destroyedObjects)) return true;
    }
    // a piece whose midpoint along the bottom edge is buried also counts
    const pose = piecePose(p);
    if (p.t !== 'w' && pose.y - (p.t === 'r' ? L / 2 : 0) <= this.heightAt(pose.x, pose.z) + 0.2) return true;
    return false;
  }

  /** Would a new piece be supported (grounded or touching an existing piece)? */
  canSupport(p) {
    if (this.grounded(p)) return true;
    for (const e of edges(p)) {
      const s = this.edgeMap.get(e);
      if (s && s.size) return true;
    }
    return false;
  }

  /** After removing pieces, find every piece that no longer connects to the ground. */
  collapseFrom(removedPieces, limit = 3000) {
    const toCheck = new Set();
    for (const p of removedPieces) for (const k of this.neighbors(p)) toCheck.add(k);
    const supported = new Set();
    const doomed = new Set();
    for (const start of toCheck) {
      if (supported.has(start) || doomed.has(start) || !this.pieces.has(start)) continue;
      const seen = new Set([start]);
      const queue = [start];
      let ok = false;
      while (queue.length && seen.size < limit) {
        const k = queue.shift();
        const p = this.pieces.get(k);
        if (!p) continue;
        if (supported.has(k) || this.grounded(p)) { ok = true; break; }
        for (const n of this.neighbors(p)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
      if (seen.size >= limit) ok = true;
      for (const k of seen) (ok ? supported : doomed).add(k);
    }
    return [...doomed];
  }
}
