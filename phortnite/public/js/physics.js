// Thin wrapper around Rapier (WASM physics): world, collision groups, ray casts.
import RAPIER from 'rapier';

export const GROUP = {
  WORLD: 1, BUILD: 2, PLAYER: 4, REMOTE: 8, PROP: 16, DEBRIS: 32, RAGDOLL: 64,
  FOLIAGE: 128, // bushes: bullets hit them, people (and cameras) pass through
};
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

const ALL = 0xffff;
export const RAY_SOLID = groups(ALL, GROUP.WORLD | GROUP.BUILD | GROUP.PROP);
export const RAY_STATIC = groups(ALL, GROUP.WORLD | GROUP.BUILD);
export const MOVE_FILTER = groups(ALL, GROUP.WORLD | GROUP.BUILD | GROUP.PROP | GROUP.REMOTE | GROUP.PLAYER);
/** What bullets hit: everything solid plus foliage. */
export const RAY_SHOT = groups(ALL, GROUP.WORLD | GROUP.BUILD | GROUP.PROP | GROUP.FOLIAGE);

export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -16, z: 0 });
    this.world.integrationParameters.numSolverIterations = 4;
    this.info = new Map(); // collider handle -> info
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    this._hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, collider: null, info: null };
    // Colliders created since the last step are not in Rapier's query tree yet (step() rebuilds
    // it), so ray casts test them one by one: flat [collider, x, y, z, radius, ...] per streamed object.
    this.fresh = [];
    this.streamer = null; // the World's ColliderStreamer (js/world/colliders.js), when streaming
  }

  collider(desc, info, body, member = GROUP.WORLD, filter = ALL) {
    desc.setCollisionGroups(groups(member, filter));
    const c = this.world.createCollider(desc, body);
    if (info) this.info.set(c.handle, info);
    return c;
  }

  /** Colliders just streamed in around (x, y, z) within radius r: ray casts see them before the next step. */
  markFresh(colliders, x, y, z, r) {
    for (let i = 0; i < colliders.length; i++) this.fresh.push(colliders[i], x, y, z, r);
  }

  removeCollider(c) {
    if (!c) return;
    this.info.delete(c.handle);
    try { this.world.removeCollider(c, true); } catch (e) { /* already gone */ }
  }

  removeBody(b) {
    if (!b) return;
    const n = b.numColliders();
    for (let i = 0; i < n; i++) this.info.delete(b.collider(i).handle);
    try { this.world.removeRigidBody(b); } catch (e) { /* already gone */ }
  }

  step(dt) {
    this.world.timestep = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    this.world.step();
    this.fresh.length = 0;
  }

  /** Streamed physics: build the colliders under the segment now (bullets, long ray casts). */
  ensureAlong(x0, z0, x1, z1) {
    return this.streamer ? this.streamer.ensureAlong(x0, z0, x1, z1) : 0;
  }

  /** Colliders that exist right now (streamed ones included). */
  activeColliders() { return this.world.colliders.len(); }

  /**
   * Cast a ray. Returns a shared hit object (copy what you need) or null.
   * dir must be normalised.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, filter = RAY_SOLID, excludeCollider, predicate) {
    const ray = this._ray;
    ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
    ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;
    const h = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filter, excludeCollider, undefined, predicate);
    let toi = h ? h.timeOfImpact : maxDist, col = h ? h.collider : null;
    let nx = h ? h.normal.x : 0, ny = h ? h.normal.y : 0, nz = h ? h.normal.z : 0;
    const F = this.fresh;
    if (F.length) {
      // newly streamed colliders: a bounding-sphere test first, then the collider itself
      const fm = filter & 0xffff, fg = filter >>> 16;
      for (let i = 0; i < F.length; i += 5) {
        const cx = F[i + 1] - ox, cy = F[i + 2] - oy, cz = F[i + 3] - oz, r = F[i + 4];
        const t = cx * dx + cy * dy + cz * dz;
        if (t < -r || t - r > toi) continue;
        if (cx * cx + cy * cy + cz * cz - t * t > r * r) continue;
        const c = F[i];
        if (c === excludeCollider || !c.isValid()) continue;
        const g = c.collisionGroups();
        if (!((g >>> 16) & fm) || !(g & 0xffff & fg)) continue;
        if (predicate && !predicate(c)) continue;
        const ci = c.castRayAndGetNormal(ray, toi, true);
        if (ci && (!col || ci.timeOfImpact < toi)) {
          toi = ci.timeOfImpact; col = c;
          nx = ci.normal.x; ny = ci.normal.y; nz = ci.normal.z;
        }
      }
    }
    if (!col) return null;
    const out = this._hit;
    out.dist = toi;
    out.x = ox + dx * toi;
    out.y = oy + dy * toi;
    out.z = oz + dz * toi;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.collider = col;
    out.info = this.info.get(col.handle) || null;
    return out;
  }
}
