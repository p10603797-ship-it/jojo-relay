// Thin wrapper around Rapier (WASM physics): world, collision groups, ray casts.
import RAPIER from 'rapier';

export const GROUP = {
  WORLD: 1, BUILD: 2, PLAYER: 4, REMOTE: 8, PROP: 16, DEBRIS: 32, RAGDOLL: 64,
};
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

const ALL = 0xffff;
export const RAY_SOLID = groups(ALL, GROUP.WORLD | GROUP.BUILD | GROUP.PROP);
export const RAY_STATIC = groups(ALL, GROUP.WORLD | GROUP.BUILD);
export const MOVE_FILTER = groups(ALL, GROUP.WORLD | GROUP.BUILD | GROUP.PROP | GROUP.REMOTE | GROUP.PLAYER);

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
  }

  collider(desc, info, body, member = GROUP.WORLD, filter = ALL) {
    desc.setCollisionGroups(groups(member, filter));
    const c = this.world.createCollider(desc, body);
    if (info) this.info.set(c.handle, info);
    return c;
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
  }

  /**
   * Cast a ray. Returns a shared hit object (copy what you need) or null.
   * dir must be normalised.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, filter = RAY_SOLID, excludeCollider, predicate) {
    const ray = this._ray;
    ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
    ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;
    const h = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filter, excludeCollider, undefined, predicate);
    if (!h) return null;
    const out = this._hit;
    out.dist = h.timeOfImpact;
    out.x = ox + dx * h.timeOfImpact;
    out.y = oy + dy * h.timeOfImpact;
    out.z = oz + dz * h.timeOfImpact;
    out.nx = h.normal.x; out.ny = h.normal.y; out.nz = h.normal.z;
    out.collider = h.collider;
    out.info = this.info.get(h.collider.handle) || null;
    return out;
  }
}
