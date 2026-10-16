// Collider streaming: only the parts of the island near someone have physics colliders.
//
// Rapier's step cost grows with every static collider, even disabled ones. The World groups its
// objects into "units" (a building, or the trees / props of a 32 m cell, each one compound
// collider; see World.buildColliders) and the island is cut into 64 m chunks. Every 0.2 s the
// active set becomes every chunk within 96 m of a focus point (the local player, bots simulated
// here, the spectated player, remote players, rockets in flight). Units of newly wanted chunks get
// their collider (at most 600 a frame); chunks nobody wanted for 3 s lose theirs.
// ensureAlong() activates the chunks under a bullet's path at once, so a long shot always hits.
//
// A unit belongs to every chunk its footprint overlaps and keeps its collider while any of them is
// active (a reference count), so a big building never vanishes at a chunk border.
// The streamer knows nothing about Rapier: create(id) / remove(id) do the work (World supplies
// them) and create returns how many colliders it made. Pure logic, tested in Node
// (test/streaming.test.mjs).
export const STREAM = { chunk: 64, radius: 96, keep: 3, interval: 0.2, perFrame: 600 };

export class ColliderStreamer {
  /**
   * @param {object} o
   * @param {number} o.size        map size in metres (the map spans -size/2 .. size/2)
   * @param {(id:number)=>number} o.create   make the object's colliders; returns how many
   * @param {(id:number)=>void} o.remove     drop the object's colliders
   */
  constructor({ size, chunk = STREAM.chunk, radius = STREAM.radius, keep = STREAM.keep, interval = STREAM.interval, perFrame = STREAM.perFrame, create, remove }) {
    this.size = size;
    this.half = size / 2;
    this.chunk = chunk;
    this.radius = radius;
    this.keep = keep;
    this.interval = interval;
    this.perFrame = perFrame;
    this.create = create;
    this.remove = remove;
    this.n = Math.max(1, Math.ceil(size / chunk));
    const count = this.n * this.n;
    this.count = count;
    this.state = new Uint8Array(count);                // 0 off, 1 on, 2 queued (partly on)
    this.wanted = new Float64Array(count).fill(-1e9);   // last time a focus point wanted it
    this.cursor = new Int32Array(count);                // members already counted while queued
    this.queue = [];
    this.now = 0;
    this.timer = 0;
    this.pending = [];          // [id, cx0, cz0, cx1, cz1] before finalize()
    this.start = null;          // chunk c's members: ids[start[c] .. start[c + 1])
    this.ids = null;
    this.ref = null;            // per object: how many active chunks hold it
    this.live = 0;              // objects whose colliders exist (as far as the streamer knows)
    this.made = 0;              // colliders created by the last update / ensureAlong
    this._cand = [];            // scratch: candidate chunks this interval
    this._dist = new Float64Array(count);
    this._byDist = (a, b) => this._dist[a] - this._dist[b];
  }

  /** The chunk index of a point (clamped to the map). */
  chunkAt(x, z) {
    const n = this.n;
    let cx = Math.floor((x + this.half) / this.chunk), cz = Math.floor((z + this.half) / this.chunk);
    if (cx < 0) cx = 0; else if (cx >= n) cx = n - 1;
    if (cz < 0) cz = 0; else if (cz >= n) cz = n - 1;
    return cz * n + cx;
  }

  /** Register a streamed object: its footprint is the square (x, z) +- r. */
  add(id, x, z, r = 0) {
    const n = this.n, k = this.chunk, h = this.half;
    const c = (v) => Math.min(n - 1, Math.max(0, Math.floor((v + h) / k)));
    this.pending.push(id, c(x - r), c(z - r), c(x + r), c(z + r));
  }

  /** Build the chunk member lists (call once after every add). */
  finalize() {
    const P = this.pending;
    const count = this.count, n = this.n;
    const start = new Int32Array(count + 1);
    let maxId = 0;
    for (let i = 0; i < P.length; i += 5) {
      if (P[i] > maxId) maxId = P[i];
      for (let cz = P[i + 2]; cz <= P[i + 4]; cz++) for (let cx = P[i + 1]; cx <= P[i + 3]; cx++) start[cz * n + cx + 1]++;
    }
    for (let c = 0; c < count; c++) start[c + 1] += start[c];
    const ids = new Int32Array(start[count]);
    const fill = start.slice(0, count);
    for (let i = 0; i < P.length; i += 5) {
      for (let cz = P[i + 2]; cz <= P[i + 4]; cz++) for (let cx = P[i + 1]; cx <= P[i + 3]; cx++) ids[fill[cz * n + cx]++] = P[i];
    }
    this.start = start;
    this.ids = ids;
    this.ref = new Uint16Array(maxId + 1);
    this.pending = [];
  }

  /** Members of chunk c (ids). */
  members(c) { return this.ids.subarray(this.start[c], this.start[c + 1]); }

  /** Are the object's colliders wanted (some chunk holding it is active)? */
  isLive(id) { return !!this.ref && id < this.ref.length && this.ref[id] > 0; }

  isActive(c) { return this.state[c] === 1; }

  /** Count one member in (ref 0 -> 1 makes its colliders). Returns colliders made. */
  enter(id) {
    if (this.ref[id]++ === 0) { this.live++; return this.create(id) | 0; }
    return 0;
  }

  leave(id) {
    if (this.ref[id] === 0) return;
    if (--this.ref[id] === 0) { this.live--; this.remove(id); }
  }

  /** Turn chunk c on, at most `budget` new colliders; returns colliders made (Infinity budget = all). */
  activate(c, budget = Infinity) {
    if (this.state[c] === 1) return 0;
    this.state[c] = 2;
    const s = this.start[c], e = this.start[c + 1];
    let made = 0, i = s + this.cursor[c];
    while (i < e && made < budget) made += this.enter(this.ids[i++]);
    this.cursor[c] = i - s;
    if (i >= e) { this.state[c] = 1; this.cursor[c] = 0; }
    return made;
  }

  deactivate(c) {
    if (this.state[c] === 0) return;
    const s = this.start[c];
    const e = this.state[c] === 1 ? this.start[c + 1] : s + this.cursor[c];
    for (let i = s; i < e; i++) this.leave(this.ids[i]);
    this.state[c] = 0;
    this.cursor[c] = 0;
  }

  /**
   * Mark every chunk within `radius` of the points as wanted now; queue the ones that are off,
   * nearest first. pts: flat [x0, z0, x1, z1, ...], npts points.
   */
  want(pts, npts) {
    const n = this.n, k = this.chunk, h = this.half, R = this.radius, R2 = R * R, now = this.now;
    const cand = this._cand;
    cand.length = 0;
    const dist = this._dist;
    for (let p = 0; p < npts; p++) {
      const x = pts[p * 2], z = pts[p * 2 + 1];
      const cx0 = Math.max(0, Math.floor((x - R + h) / k)), cx1 = Math.min(n - 1, Math.floor((x + R + h) / k));
      const cz0 = Math.max(0, Math.floor((z - R + h) / k)), cz1 = Math.min(n - 1, Math.floor((z + R + h) / k));
      for (let cz = cz0; cz <= cz1; cz++) {
        const z0 = -h + cz * k;
        const dz = z < z0 ? z0 - z : z > z0 + k ? z - z0 - k : 0;
        for (let cx = cx0; cx <= cx1; cx++) {
          const x0 = -h + cx * k;
          const dx = x < x0 ? x0 - x : x > x0 + k ? x - x0 - k : 0;
          const d2 = dx * dx + dz * dz;
          if (d2 > R2) continue;
          const c = cz * n + cx;
          if (this.wanted[c] !== now) { this.wanted[c] = now; dist[c] = d2; if (this.state[c] !== 1) cand.push(c); } else if (d2 < dist[c]) dist[c] = d2;
        }
      }
    }
    if (cand.length > 1) cand.sort(this._byDist);
    // nearest wanted chunks first; chunks already queued keep their (partial) progress
    const q = this.queue;
    for (let i = cand.length - 1; i >= 0; i--) {
      const c = cand[i];
      const at = q.indexOf(c);
      if (at >= 0) q.splice(at, 1);
      q.unshift(c);
    }
  }

  /**
   * Advance the clock; every `interval` recompute the wanted set from the focus points, drop
   * chunks unwanted for `keep` seconds, then build queued chunks (at most perFrame colliders).
   */
  update(dt, pts, npts) {
    this.now += dt;
    this.timer -= dt;
    this.made = 0;
    if (!this.start) return 0;
    if (this.timer <= 0) {
      this.timer = this.interval;
      this.want(pts, npts);
      const now = this.now, keep = this.keep;
      for (let c = 0; c < this.count; c++) if (this.state[c] !== 0 && now - this.wanted[c] > keep) this.deactivate(c);
    }
    let budget = this.perFrame;
    const q = this.queue;
    while (q.length && budget > 0) {
      const c = q[0];
      if (this.now - this.wanted[c] > this.keep) { this.deactivate(c); q.shift(); continue; }
      const m = this.activate(c, budget);
      budget -= m;
      this.made += m;
      if (this.state[c] === 1) q.shift();
    }
    return this.made;
  }

  /**
   * Make sure the colliders under the segment (x0, z0) -> (x1, z1) exist right now (bullets,
   * long ray casts). Walks the chunk grid along the segment; every chunk it touches is wanted
   * now and built completely. Returns the colliders made.
   */
  ensureAlong(x0, z0, x1, z1) {
    if (!this.start) return 0;
    const k = this.chunk, h = this.half, n = this.n;
    let made = 0;
    // grid traversal (Amanatides & Woo) in chunk units
    let fx = (x0 + h) / k, fz = (z0 + h) / k;
    const tx = (x1 + h) / k, tz = (z1 + h) / k;
    let cx = Math.floor(fx), cz = Math.floor(fz);
    const ex = Math.floor(tx), ez = Math.floor(tz);
    const dx = tx - fx, dz = tz - fz;
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tdx = sx ? Math.abs(1 / dx) : Infinity, tdz = sz ? Math.abs(1 / dz) : Infinity;
    let tmx = sx > 0 ? (cx + 1 - fx) * tdx : sx < 0 ? (fx - cx) * tdx : Infinity;
    let tmz = sz > 0 ? (cz + 1 - fz) * tdz : sz < 0 ? (fz - cz) * tdz : Infinity;
    made += this.touch(cx, cz);
    for (let guard = 0; guard < 4 * n && (cx !== ex || cz !== ez); guard++) {
      if (tmx < tmz) { if (tmx > 1) break; cx += sx; tmx += tdx; } else { if (tmz > 1) break; cz += sz; tmz += tdz; }
      made += this.touch(cx, cz);
    }
    this.made += made;
    return made;
  }

  /** Want chunk (cx, cz) now and build it completely. Returns the colliders made. */
  touch(cx, cz) {
    const n = this.n;
    if (cx < 0 || cz < 0 || cx >= n || cz >= n) return 0;
    const c = cz * n + cx;
    this.wanted[c] = this.now;
    if (this.state[c] === 1) return 0;
    const made = this.activate(c);
    const at = this.queue.indexOf(c);
    if (at >= 0) this.queue.splice(at, 1);
    return made;
  }

  /** Turn everything off (e.g. before throwing the world away). */
  clear() {
    for (let c = 0; c < this.count; c++) this.deactivate(c);
    this.queue.length = 0;
  }

  stats() {
    let on = 0;
    for (let c = 0; c < this.count; c++) if (this.state[c] === 1) on++;
    return { chunks: this.count, active: on, queued: this.queue.length, live: this.live };
  }
}
