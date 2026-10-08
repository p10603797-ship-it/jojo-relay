// Props and decor in and around the places: street lamps, parked cars, benches, fences, hay bales,
// market stalls, containers, gas pumps, signs, tents (kind 'prop': solid, with a box collider) and
// cones, umbrellas, flowers, pumpkins, campfires (kind 'decor': no collider). Barrels are physics
// props (data.barrels).
//
// Prop object: { kind: 'prop', type, mat, hp, x, y, z, hx, hy, hz, yaw?, color?, text? } (y = box centre)
// Decor object: { kind: 'decor', type, x, y, z, s, yaw } (y = ground)
import { OCC, BoxHash } from './grid.js';
import { DIRS16 } from './pois.js';

const YAW = [0, 1.5707963267948966, 3.141592653589793, 4.71238898038469];

// prop sizes (half extents) and materials; y is set from the ground
export const PROP_TYPES = {
  car: { hx: 1.0, hy: 0.75, hz: 2.1, mat: 'metal', hp: 300 },
  container: { hx: 1.25, hy: 1.3, hz: 3.0, mat: 'metal', hp: 450 },
  crate: { hx: 0.6, hy: 0.6, hz: 0.6, mat: 'wood', hp: 70 },
  lamp: { hx: 0.14, hy: 2.7, hz: 0.14, mat: 'metal', hp: 120 },
  bench: { hx: 0.9, hy: 0.42, hz: 0.3, mat: 'wood', hp: 60 },
  fence: { hx: 2.0, hy: 0.55, hz: 0.06, mat: 'wood', hp: 50 },
  hay: { hx: 0.75, hy: 0.7, hz: 0.75, mat: 'wood', hp: 60 },
  stall: { hx: 1.4, hy: 1.25, hz: 0.9, mat: 'wood', hp: 90 },
  fountain: { hx: 2.6, hy: 0.6, hz: 2.6, mat: 'stone', hp: 0 },
  sign: { hx: 1.7, hy: 1.25, hz: 0.12, mat: 'wood', hp: 80 },
  pump: { hx: 0.4, hy: 0.85, hz: 0.3, mat: 'metal', hp: 120 },
  tent: { hx: 1.4, hy: 0.9, hz: 1.7, mat: 'wood', hp: 60 },
  hydrant: { hx: 0.18, hy: 0.4, hz: 0.18, mat: 'metal', hp: 80 },
  dumpster: { hx: 1.0, hy: 0.7, hz: 0.6, mat: 'metal', hp: 200 },
};
export const DECOR_TYPES = ['cone', 'umbrella', 'flowers', 'pumpkin', 'campfire', 'tuft', 'reeds', 'shroom', 'log', 'stump', 'lily', 'shell'];

export function placeProps(G, W, regions, plans, roads, barrels, rng) {
  const houseBoxes = new BoxHash(32);
  for (const h of W.houses) houseBoxes.add({ x0: h.x - h.hx, z0: h.z - h.hz, x1: h.x + h.hx, z1: h.z + h.hz });
  const propBoxes = new BoxHash(16);
  const { N, cell, half } = G;
  const pt = (x, z) => {
    const ix = Math.round((x + half) / cell), iz = Math.round((z + half) / cell);
    return ix < 0 || iz < 0 || ix >= N || iz >= N ? -1 : iz * N + ix;
  };
  /** Free ground for a footprint of half size r (not on paved road unless allowed, not in buildings). */
  const free = (x, z, r, { onRoad = false, margin = 0.6 } = {}) => {
    const i = pt(x, z);
    if (i < 0 || G.heights[i] < 0.8) return false;
    if (!onRoad && G.road[i]) return false;
    if (G.occ[i] === OCC.WATER) return false;
    if (houseBoxes.hits(x - r, z - r, x + r, z + r, margin)) return false;
    if (propBoxes.hits(x - r, z - r, x + r, z + r, 0.3)) return false;
    return true;
  };
  const prop = (type, x, z, yaw = 0, extra) => {
    const T = PROP_TYPES[type];
    const swap = yaw === YAW[1] || yaw === YAW[3];
    const hx = swap ? T.hz : T.hx, hz = swap ? T.hx : T.hz;
    const gy = G.heightAt(x, z);
    const o = { kind: 'prop', type, mat: T.mat, hp: T.hp, x, y: gy + T.hy, z, hx: T.hx, hy: T.hy, hz: T.hz };
    if (yaw) o.yaw = yaw;
    if (extra) Object.assign(o, extra);
    W.add(o);
    propBoxes.add({ x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz });
    return o;
  };
  const decor = (type, x, z, s = 1, yaw = 0) => {
    W.add({ kind: 'decor', type, x, y: G.heightAt(x, z), z, s, yaw });
  };

  // ---------------------------------------------------------------- along streets
  for (const r of roads) {
    if (r.kind !== 'street' || r.region === undefined) continue;
    const g = regions[r.region];
    const [ax, az] = r.pts[0], [bx, bz] = r.pts[r.pts.length - 1];
    const dx = bx - ax, dz = bz - az, L = Math.sqrt(dx * dx + dz * dz);
    if (L < 8) continue;
    const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
    const alongYaw = Math.abs(ux) > 0.5 ? YAW[1] : 0;
    const off = r.w / 2 + 0.9;
    for (let s = 8; s < L - 4; s += 16) {
      for (const sd of [-1, 1]) {
        const x = ax + ux * s + nx * off * sd, z = az + uz * s + nz * off * sd;
        if (free(x, z, 0.3, { onRoad: true, margin: 0.4 })) prop('lamp', x, z);
      }
      // parked cars on the street edge, hydrants, benches
      const roll = rng();
      const sd = rng() < 0.5 ? -1 : 1;
      if (roll < 0.35) {
        const x = ax + ux * (s + 8) + nx * (r.w / 2 - 1.3) * sd, z = az + uz * (s + 8) + nz * (r.w / 2 - 1.3) * sd;
        if (free(x, z, 2.2, { onRoad: true, margin: 0.3 })) prop('car', x, z, alongYaw, { color: Math.floor(rng() * 5) });
      } else if (roll < 0.5) {
        const x = ax + ux * (s + 6) + nx * (off + 0.6) * sd, z = az + uz * (s + 6) + nz * (off + 0.6) * sd;
        if (free(x, z, 1.0, { onRoad: true, margin: 0.3 })) prop('bench', x, z, Math.abs(ux) > 0.5 ? (sd > 0 ? YAW[2] : 0) : (sd > 0 ? YAW[3] : YAW[1]));
      } else if (roll < 0.6 && g.kind === 'city') {
        const x = ax + ux * (s + 4) + nx * (off + 0.3) * sd, z = az + uz * (s + 4) + nz * (off + 0.3) * sd;
        if (free(x, z, 0.3, { onRoad: true, margin: 0.3 })) prop('hydrant', x, z);
      }
    }
  }

  // ---------------------------------------------------------------- per place
  plans.forEach((p, ri) => {
    const g = regions[ri];
    for (const pr of p.props) {
      if (pr.type === 'containers' || pr.type === 'junk') {
        // rows of shipping containers (some stacked), or wrecked cars
        for (let i = 0; i < pr.n; i++) {
          const row = i % 3, col = Math.floor(i / 3);
          const x = pr.x + (col - 1) * 8 + (rng() - 0.5) * 0.4, z = pr.z + (row - 1) * 6;
          if (pr.type === 'junk') {
            if (free(x, z, 2.3)) prop('car', x, z, YAW[Math.floor(rng() * 4)], { color: 5 + Math.floor(rng() * 2), wreck: true });
            continue;
          }
          if (!free(x, z, 3.1)) continue;
          const c = prop('container', x, z, YAW[1], { color: Math.floor(rng() * 4) });
          if (rng() < 0.4) W.add({ ...c, id: undefined, y: c.y + 2.6, color: Math.floor(rng() * 4) });
          if (rng() < 0.5 && free(x, z + 4, 0.5)) barrels.push({ x, y: G.heightAt(x, z + 4) + 0.6, z: z + 4 });
        }
      } else if (pr.type === 'hay') {
        for (let i = 0; i < pr.n; i++) {
          const [dx, dz] = DIRS16[Math.floor(rng() * 16)];
          const x = pr.x + dx * (4 + rng() * 10), z = pr.z + dz * (4 + rng() * 10);
          if (free(x, z, 0.8)) prop('hay', x, z, YAW[Math.floor(rng() * 4)]);
        }
      } else if (pr.type === 'fountain') {
        prop('fountain', pr.x, pr.z);
        for (const [dx, dz, yaw] of [[0, 7, YAW[2]], [0, -7, 0], [7, 0, YAW[3]], [-7, 0, YAW[1]]]) if (free(pr.x + dx, pr.z + dz, 1)) prop('bench', pr.x + dx, pr.z + dz, yaw);
      } else if (pr.type === 'stalls') {
        for (const [dx, dz, yaw] of [[9, 9, YAW[2]], [-9, 9, YAW[2]], [9, -9, 0], [-9, -9, 0]].slice(0, pr.n)) {
          if (free(pr.x + dx, pr.z + dz, 1.5)) prop('stall', pr.x + dx, pr.z + dz, yaw, { color: Math.floor(rng() * 6) });
        }
      } else if (pr.type === 'camp') {
        for (const [dx, dz] of [[0, 0], [4.5, 1], [-1, 4.5]]) if (free(pr.x + dx, pr.z + dz, 1.8)) prop('tent', pr.x + dx, pr.z + dz, YAW[Math.floor(rng() * 4)], { color: Math.floor(rng() * 4) });
        if (free(pr.x + 3, pr.z + 3.5, 0.6)) decor('campfire', pr.x + 3, pr.z + 3.5);
        for (let i = 0; i < 3; i++) if (free(pr.x + 5 + i, pr.z + 6, 0.5)) decor('log', pr.x + 5 + i, pr.z + 6, 1, YAW[i % 4]);
      }
    }
    // fences around the fields; pumpkins on pumpkin fields
    for (const f of p.fields) {
      for (let x = f.x - f.hx + 2; x < f.x + f.hx; x += 4) {
        for (const z of [f.z - f.hz - 0.5, f.z + f.hz + 0.5]) if (rng() < 0.85 && free(x, z, 0.3, { margin: 0.2 })) prop('fence', x, z, 0);
      }
      for (let z = f.z - f.hz + 2; z < f.z + f.hz; z += 4) {
        for (const x of [f.x - f.hx - 0.5, f.x + f.hx + 0.5]) if (rng() < 0.85 && free(x, z, 0.3, { margin: 0.2 })) prop('fence', x, z, YAW[1]);
      }
      if (f.crop === 'pumpkin') {
        for (let i = 0; i < 26; i++) decor('pumpkin', f.x + (rng() - 0.5) * f.hx * 1.8, f.z + (rng() - 0.5) * f.hz * 1.8, 0.7 + rng() * 0.8, rng() * 6.28);
      }
    }
    // a sign with the place's name at the edge of town, by the road in
    if (g.named) {
      const [dx, dz] = DIRS16[(ri * 5) % 16];
      for (let t = 0; t < 8; t++) {
        const [ex, ez] = DIRS16[(ri * 5 + t * 2) % 16];
        const x = g.x + ex * g.r * 0.92, z = g.z + ez * g.r * 0.92;
        if (free(x, z, 1.8)) { prop('sign', x, z, Math.abs(ex) > Math.abs(ez) ? YAW[1] : 0, { text: g.name.toUpperCase() }); break; }
      }
      void dx; void dz;
    }
    // town clutter: crates and dumpsters behind buildings, barrels at farms / depots
    if (g.kind === 'town' || g.kind === 'city' || g.kind === 'farm') {
      for (const h of W.houses) {
        if (h.region !== ri || h.archetype === 'bridge' || h.archetype === 'pier') continue;
        const roll = rng();
        const bx = h.x + (rng() < 0.5 ? -1 : 1) * (h.hx + 1.4), bz = h.z + (rng() < 0.5 ? -1 : 1) * (h.hz + 1.4);
        if (roll < 0.3 && free(bx, bz, 0.7)) prop('crate', bx, bz);
        else if (roll < 0.42 && g.kind === 'city' && free(bx, bz, 1.1)) prop('dumpster', bx, bz, h.hx > h.hz ? 0 : YAW[1]);
        else if (roll < 0.55 && free(bx, bz, 0.5)) barrels.push({ x: bx, y: G.heightAt(bx, bz) + 0.6, z: bz });
      }
    }
    // gas pumps
    for (const h of W.houses) {
      if (h.region !== ri || !h.pumps) continue;
      for (const [x, z] of h.pumps) prop('pump', x, z, h.rot % 2 ? YAW[1] : 0);
    }
    // beach umbrellas and cones
    if (p.piers && (g.recipe === 'beach' || g.recipe === 'cove')) {
      for (let i = 0; i < 14; i++) {
        const [dx, dz] = DIRS16[Math.floor(rng() * 16)];
        const x = g.x + dx * g.r * (0.6 + rng() * 0.8), z = g.z + dz * g.r * (0.6 + rng() * 0.8);
        const y = G.heightAt(x, z);
        if (y > 0.5 && y < 4 && free(x, z, 1.2)) decor('umbrella', x, z, 1, rng() * 6.28);
      }
    }
    if (g.recipe === 'depot' || g.recipe === 'port' || g.recipe === 'mines') {
      for (let i = 0; i < 10; i++) {
        const x = g.x + (rng() - 0.5) * g.r * 1.6, z = g.z + (rng() - 0.5) * g.r * 1.6;
        if (free(x, z, 0.3, { onRoad: true })) decor('cone', x, z, 1, rng() * 6.28);
      }
    }
  });
  // cones at a few road works along the highways
  let n = 0;
  for (const r of roads) {
    if (r.kind !== 'road' || r.bridge || n > 12) continue;
    const m = Math.floor(r.pts.length / 2);
    if (m < 1 || rng() < 0.6) continue;
    const [x, z] = r.pts[m];
    for (let k = -2; k <= 2; k++) decor('cone', x + k * 0.9, z + 1.5, 1, 0);
    n++;
  }
}
