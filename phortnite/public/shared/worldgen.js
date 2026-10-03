// Deterministic island generator. Produces plain data only (no rendering) so both the
// browser and the server agree on object ids, loot spots and chest positions.
import { MAP, ENV } from './constants.js';
import { mulberry32, Perlin, smoothstep, lerp, clamp } from './rng.js';

export const POI_NAMES = [
  'Pinewood Plaza', 'Breezy Bluffs', 'Rusty Yard', 'Sunny Shacks', 'Mossy Mill', 'Crater Cove', 'Hilltop Haven',
];

const FH = 3.2;      // storey height
const WT = 0.25;     // wall thickness
const COS30 = 0.8660254037844386;
const SIN30 = 0.5;
const TAN30 = 0.5773502691896257;

export function generateWorld(seed = MAP.seed) {
  const rand = mulberry32(seed);
  const noise = new Perlin(seed);
  const noise2 = new Perlin(seed + 101);
  const { size, res, islandRadius: R } = MAP;
  const half = size / 2;
  const cell = size / res;
  const N = res + 1;
  const heights = new Float32Array(N * N);

  const mx = (rand() - 0.5) * 150;
  const mz = (rand() - 0.5) * 150;

  function baseHeight(x, z) {
    const warp = noise2.fbm(x * 0.0045, z * 0.0045, 3);
    const dist = Math.sqrt(x * x + z * z) / (R * (1 + 0.22 * warp));
    const land = smoothstep(1.06, 0.7, dist);
    let hn = noise.fbm(x * 0.0052, z * 0.0052, 4) * 0.5 + 0.5;
    hn = hn * hn * 1.5;
    const hills = hn * 24;
    const mdx = x - mx, mdz = z - mz;
    const md = Math.sqrt(mdx * mdx + mdz * mdz) / 105;
    let mountain = 0;
    if (md < 1) {
      const k = 1 - md * md;
      mountain = k * k * 50 + noise.ridged(x * 0.02, z * 0.02, 3) * 12 * k;
    }
    const detail = noise2.noise(x * 0.035, z * 0.035) * 1.1;
    const hLand = 2.8 + hills + mountain + detail;
    return -16 + (hLand + 16) * land;
  }

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      heights[iz * N + ix] = baseHeight(-half + ix * cell, -half + iz * cell);
    }
  }

  // Same triangulation as Rapier's heightfield (split along the u+v=1 diagonal).
  function heightAt(x, z) {
    const fx = (x + half) / cell, fz = (z + half) / cell;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0) ix = 0; else if (ix > res - 1) ix = res - 1;
    if (iz < 0) iz = 0; else if (iz > res - 1) iz = res - 1;
    const u = clamp(fx - ix, 0, 1), v = clamp(fz - iz, 0, 1);
    const i = iz * N + ix;
    const h00 = heights[i], h10 = heights[i + 1], h01 = heights[i + N], h11 = heights[i + N + 1];
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  function roughness(x, z, r) {
    let mn = Infinity, mxh = -Infinity;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const h = heightAt(x + a * r, z + b * r);
        if (h < mn) mn = h;
        if (h > mxh) mxh = h;
      }
    }
    return { min: mn, max: mxh, range: mxh - mn };
  }

  // ---------------------------------------------------------------- POIs
  const pois = [];
  for (let tries = 0; tries < 600 && pois.length < POI_NAMES.length; tries++) {
    const x = (rand() - 0.5) * 430, z = (rand() - 0.5) * 430;
    if (x * x + z * z > 205 * 205) continue;
    const h = heightAt(x, z);
    if (h < 4 || h > 30) continue;
    if (roughness(x, z, 20).range > 7.5) continue;
    const dmx = x - mx, dmz = z - mz;
    if (dmx * dmx + dmz * dmz < 75 * 75) continue;
    let ok = true;
    for (const p of pois) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < 118 * 118) { ok = false; break; }
    }
    if (!ok) continue;
    pois.push({ name: POI_NAMES[pois.length], x, z, y: h, r: 48, type: pois.length === 2 ? 'yard' : 'town' });
  }

  // ---------------------------------------------------------------- houses
  const houses = [];
  const flatZones = []; // {x, z, hx, hz, y, inner, outer}

  function overlapsHouse(x, z, hx, hz, margin) {
    for (const h of houses) {
      if (Math.abs(h.x - x) < h.hx + hx + margin && Math.abs(h.z - z) < h.hz + hz + margin) return true;
    }
    return false;
  }

  function tryHouse(x, z, opts = {}) {
    const w = opts.w ?? 8 + 2 * Math.floor(rand() * 3);
    const d = opts.d ?? 8 + 2 * Math.floor(rand() * 2);
    const rot = opts.rot ?? Math.floor(rand() * 4);
    const hx = (rot % 2 ? d : w) / 2, hz = (rot % 2 ? w : d) / 2;
    if (x * x + z * z > 235 * 235) return null;
    if (overlapsHouse(x, z, hx, hz, 5)) return null;
    const r = roughness(x, z, Math.max(hx, hz));
    if (r.min < 2.4 || r.range > 7) return null;
    const dmx = x - mx, dmz = z - mz;
    if (dmx * dmx + dmz * dmz < 60 * 60 && !opts.force) return null;
    const baseY = (r.min + r.max) / 2;
    const floors = opts.floors ?? (rand() < 0.35 ? 2 : 1);
    const styles = ['wood', 'wood', 'brick'];
    const style = opts.style ?? styles[Math.floor(rand() * styles.length)];
    const roof = opts.roof ?? (floors === 1 && rand() < 0.7 ? 'gable' : 'flat');
    const house = {
      id: houses.length, x, z, y: baseY + 0.25, base: baseY, rot, w, d, hx, hz, floors, style, roof,
      paint: Math.floor(rand() * 4), poi: opts.poi ?? -1,
    };
    houses.push(house);
    flatZones.push({ x, z, hx, hz, y: baseY, inner: 2.5, outer: 9 });
    return house;
  }

  pois.forEach((poi, pi) => {
    if (poi.type === 'yard') {
      tryHouse(poi.x, poi.z, { w: 16, d: 12, floors: 1, style: 'metal', roof: 'flat', poi: pi, force: true });
      flatZones.push({ x: poi.x, z: poi.z, hx: 30, hz: 30, y: poi.y, inner: 0, outer: 18 });
      return;
    }
    const want = 4 + Math.floor(rand() * 4);
    let placed = 0;
    for (let t = 0; t < 60 && placed < want; t++) {
      const x = poi.x + (rand() - 0.5) * 84, z = poi.z + (rand() - 0.5) * 84;
      if (tryHouse(x, z, { poi: pi })) placed++;
    }
  });
  for (let t = 0; t < 160 && houses.length < 46; t++) {
    const x = (rand() - 0.5) * 460, z = (rand() - 0.5) * 460;
    let far = true;
    for (const p of pois) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < 75 * 75) { far = false; break; }
    }
    if (far) tryHouse(x, z, { floors: rand() < 0.2 ? 2 : 1 });
  }

  // Flatten terrain under houses: each grid point blends toward the closest zone only.
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = -half + ix * cell, z = -half + iz * cell;
      let best = 0, bestY = 0;
      for (const fz of flatZones) {
        const dx = Math.max(Math.abs(x - fz.x) - fz.hx, 0);
        const dz = Math.max(Math.abs(z - fz.z) - fz.hz, 0);
        if (dx > fz.outer || dz > fz.outer) continue;
        const dd = Math.sqrt(dx * dx + dz * dz);
        const f = dd <= fz.inner ? 1 : smoothstep(fz.outer, fz.inner, dd);
        if (f > best) { best = f; bestY = fz.y; }
      }
      if (best > 0) {
        const i = iz * N + ix;
        heights[i] = lerp(heights[i], bestY - 0.05, best);
      }
    }
  }

  // ---------------------------------------------------------------- objects
  const objects = [];
  const chests = [];
  const lootSpots = [];
  const barrels = [];

  const add = (o) => { o.id = objects.length; objects.push(o); return o; };

  // House parts --------------------------------------------------------
  for (const h of houses) buildHouse(h);

  function toWorld(h, lx, lz) {
    switch (h.rot) {
      case 1: return [h.x + lz, h.z - lx];
      case 2: return [h.x - lx, h.z - lz];
      case 3: return [h.x - lz, h.z + lx];
      default: return [h.x + lx, h.z + lz];
    }
  }

  function part(h, look, mat, hp, lx, ly, lz, lhx, lhy, lhz, tilt) {
    const [x, z] = toWorld(h, lx, lz);
    const swap = h.rot % 2 === 1;
    const o = {
      kind: 'part', house: h.id, look, mat, hp, shape: 'box', paint: h.paint,
      x, y: ly, z, hx: swap ? lhz : lhx, hy: lhy, hz: swap ? lhx : lhz,
    };
    if (tilt) {
      // tilt = { axis: 'x' | 'z' (local), ang }
      let ax, ang;
      if (tilt.axis === 'x') {
        ax = h.rot % 2 ? 'z' : 'x';
        ang = h.rot === 0 || h.rot === 3 ? tilt.ang : -tilt.ang;
      } else {
        ax = h.rot % 2 ? 'x' : 'z';
        ang = h.rot === 0 || h.rot === 1 ? tilt.ang : -tilt.ang;
      }
      o.ax = ax; o.ang = ang;
    }
    return add(o);
  }

  function prism(h, look, mat, hp, localPts) {
    const pts = [];
    for (const [lx, ly, lz] of localPts) {
      const [x, z] = toWorld(h, lx, lz);
      pts.push(x, ly, z);
    }
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < pts.length; i += 3) { cx += pts[i]; cy += pts[i + 1]; cz += pts[i + 2]; }
    const n = pts.length / 3;
    return add({ kind: 'part', house: h.id, look, mat, hp, shape: 'prism', pts, x: cx / n, y: cy / n, z: cz / n, paint: h.paint });
  }

  function buildHouse(h) {
    const { w, d, floors, style } = h;
    const wallLook = style === 'brick' ? 'brick' : style === 'metal' ? 'metalwall' : 'siding';
    const wallMat = style === 'brick' ? 'stone' : style === 'metal' ? 'metal' : 'wood';
    const wallHp = style === 'brick' ? 230 : style === 'metal' ? 320 : 160;
    const y0 = h.y;
    // foundation slab (indestructible)
    part(h, 'foundation', 'stone', 0, 0, y0 - 0.75, 0, w / 2 + 0.15, 0.75, d / 2 + 0.15);

    const sides = [
      { axis: 'x', len: w, fixed: d / 2 - WT / 2, sign: 1 },   // front (+z)
      { axis: 'x', len: w, fixed: -(d / 2 - WT / 2), sign: -1 }, // back
      { axis: 'z', len: d - 2 * WT, fixed: w / 2 - WT / 2, sign: 1 },   // right
      { axis: 'z', len: d - 2 * WT, fixed: -(w / 2 - WT / 2), sign: -1 }, // left
    ];

    for (let f = 0; f < floors; f++) {
      const fy = y0 + f * FH;
      sides.forEach((s, si) => {
        const bays = Math.max(1, Math.round(s.len / 2.6));
        const b = s.len / bays;
        const doorBay = si === 0 && f === 0 ? Math.floor(bays / 2) : -1;
        const bigDoor = style === 'metal' && si === 0 && f === 0;
        for (let i = 0; i < bays; i++) {
          const c = -s.len / 2 + b * (i + 0.5);
          let type = 'solid';
          if (i === doorBay) type = 'door';
          else if (bigDoor && Math.abs(i - doorBay) === 1) type = 'door';
          else if (i > 0 && i < bays - 1 && rand() < 0.55) type = 'window';
          else if (bays <= 3 && rand() < 0.3) type = 'window';
          const seg = (yA, yB) => {
            const cy = (yA + yB) / 2, hy = (yB - yA) / 2;
            if (s.axis === 'x') part(h, wallLook, wallMat, wallHp, c, cy, s.fixed, b / 2, hy, WT / 2);
            else part(h, wallLook, wallMat, wallHp, s.fixed, cy, c, WT / 2, hy, b / 2);
          };
          if (type === 'solid') seg(fy, fy + FH);
          else if (type === 'window') { seg(fy, fy + 1.0); seg(fy + 2.15, fy + FH); }
          else seg(fy + (bigDoor ? 2.9 : 2.35), fy + FH);
        }
      });
      // corner trims
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        part(h, 'trim', wallMat, 90, sx * (w / 2), fy + FH / 2, sz * (d / 2), 0.2, FH / 2, 0.2);
      }
      if (f > 0) {
        // upper floor slab with a stairwell hole along the back-left
        const holeX1 = -w / 2 + WT + 5.4;
        const zh = -d / 2 + WT + 1.9;
        part(h, 'floor', 'wood', 200, 0, fy - 0.13, (zh + d / 2) / 2, w / 2, 0.13, (d / 2 - zh) / 2);
        part(h, 'floor', 'wood', 200, (holeX1 + w / 2) / 2, fy - 0.13, (zh - d / 2) / 2, (w / 2 - holeX1) / 2, 0.13, (zh + d / 2) / 2);
        // stair ramp
        const run = 5.0, x0 = -w / 2 + WT + 0.2;
        const ang = Math.atan2(FH, run);
        const len = Math.sqrt(run * run + FH * FH);
        part(h, 'floor', 'wood', 160, x0 + run / 2, fy - FH / 2 - 0.05, -d / 2 + WT + 0.9, len / 2, 0.1, 0.85, { axis: 'z', ang });
      }
    }

    const top = y0 + floors * FH;
    if (h.roof === 'gable') {
      const oh = 0.55;
      const run = d / 2 + oh;
      const rise = run * TAN30;
      const ridgeY = top + (d / 2) * TAN30;
      const len = run / COS30;
      for (const sgn of [1, -1]) {
        const cz = sgn * run / 2;
        const cy = ridgeY - rise / 2;
        // offset outward along the slab normal by half its thickness
        const nyo = COS30 * 0.11, nzo = sgn * SIN30 * 0.11;
        part(h, 'roof', 'wood', 140, 0, cy + nyo, cz + nzo, w / 2 + oh, 0.11, len / 2, { axis: 'x', ang: sgn * Math.PI / 6 });
      }
      for (const sx of [1, -1]) {
        const x = sx * (w / 2 - WT / 2);
        const a = d / 2;
        prism(h, wallLook, wallMat, wallHp, [
          [x - WT / 2, top, -a], [x - WT / 2, top, a], [x - WT / 2, ridgeY, 0],
          [x + WT / 2, top, -a], [x + WT / 2, top, a], [x + WT / 2, ridgeY, 0],
        ]);
      }
      // attic ceiling so the roof reads as solid from below
      part(h, 'slab', 'wood', 160, 0, top + 0.06, 0, w / 2 - WT, 0.06, d / 2 - WT);
    } else {
      part(h, 'slab', wallMat === 'metal' ? 'metal' : 'stone', 240, 0, top + 0.15, 0, w / 2 + 0.2, 0.15, d / 2 + 0.2);
      for (const [sx, sz, along] of [[0, 1, 'x'], [0, -1, 'x'], [1, 0, 'z'], [-1, 0, 'z']]) {
        if (along === 'x') part(h, 'trim', wallMat, 80, 0, top + 0.6, sz * (d / 2 + 0.05), w / 2 + 0.2, 0.3, 0.15);
        else part(h, 'trim', wallMat, 80, sx * (w / 2 + 0.05), top + 0.6, 0, 0.15, 0.3, d / 2 + 0.05);
      }
    }

    // loot spots + chest inside
    const inner = (lx, lz, fy) => { const [x, z] = toWorld(h, lx, lz); return { x, y: fy + 0.05, z }; };
    lootSpots.push(inner((rand() - 0.5) * (w - 3), (rand() * 0.5) * (d / 2 - 1.5), y0));
    if (rand() < 0.6) lootSpots.push(inner((rand() - 0.5) * (w - 3), (rand() - 0.2) * (d / 2 - 1.5), y0));
    if (floors > 1) lootSpots.push(inner(w / 4, d / 4, y0 + FH));
    if (rand() < 0.75 || style === 'metal') {
      const cf = floors > 1 && rand() < 0.5 ? 1 : 0;
      // ground floor: back-right corner (the stair ramp lives back-left); upper floor: front-right
      const p = cf ? inner(w / 2 - 1.0, d / 2 - 1.0, y0 + FH) : inner(w / 2 - 1.0, -d / 2 + 0.9, y0);
      // chest faces into the house (model front is local +z)
      const faceLocal = cf ? Math.PI : 0;
      chests.push({ x: p.x, y: p.y, z: p.z, yaw: faceLocal + h.rot * Math.PI / 2 });
    }
  }

  // Shipping containers + props in the yard ----------------------------
  const yard = pois.find((p) => p.type === 'yard');
  const containerColors = 4;
  if (yard) {
    for (let row = -2; row <= 2; row++) {
      if (row === 0) continue;
      for (let i = -2; i <= 2; i++) {
        if (rand() < 0.25) continue;
        const along = Math.abs(row) === 2;
        const x = yard.x + (along ? i * 7.2 : row * 9) + (rand() - 0.5) * 0.4;
        const z = yard.z + (along ? row * 9 : i * 6.2) + (rand() - 0.5) * 0.4;
        if (Math.abs(x - yard.x) < 10 && Math.abs(z - yard.z) < 8) continue;
        const gy = heightAt(x, z);
        const hx = along ? 3.0 : 1.25, hz = along ? 1.25 : 3.0;
        const stack = rand() < 0.4 ? 2 : 1;
        for (let s = 0; s < stack; s++) {
          add({ kind: 'prop', type: 'container', mat: 'metal', hp: 450, x, y: gy - 0.1 + 1.3 + s * 2.6, z, hx, hy: 1.3, hz, color: Math.floor(rand() * containerColors) });
        }
        if (rand() < 0.5) barrels.push({ x: x + (along ? 0 : 2.4), y: gy + 0.6, z: z + (along ? 2.4 : 0) });
      }
    }
    for (let i = 0; i < 4; i++) {
      lootSpots.push({ x: yard.x + (rand() - 0.5) * 50, y: 0, z: yard.z + (rand() - 0.5) * 50, ground: true });
    }
    chests.push({ x: yard.x + 12, y: heightAt(yard.x + 12, yard.z - 12), z: yard.z - 12, yaw: 0 });
  }

  // Cars and crates near town houses
  for (const h of houses) {
    if (h.style === 'metal') continue;
    if (rand() < 0.45) {
      const side = rand() < 0.5 ? 1 : -1;
      const x = h.x + side * (h.hx + 3.2), z = h.z + (rand() - 0.5) * h.hz;
      if (!overlapsHouse(x, z, 2.2, 2.2, 0.5) && heightAt(x, z) > 1.5) {
        add({ kind: 'prop', type: 'car', mat: 'metal', hp: 300, x, y: heightAt(x, z) + 0.75, z, yaw: rand() * Math.PI * 2, hx: 1.0, hy: 0.75, hz: 2.1, color: Math.floor(rand() * 5) });
      }
    }
    if (rand() < 0.6) {
      const x = h.x + (rand() < 0.5 ? -1 : 1) * (h.hx + 1.2), z = h.z + (rand() < 0.5 ? -1 : 1) * (h.hz + 1.2);
      if (!overlapsHouse(x, z, 0.6, 0.6, 0.3)) {
        add({ kind: 'prop', type: 'crate', mat: 'wood', hp: 70, x, y: heightAt(x, z) + 0.6, z, hx: 0.6, hy: 0.6, hz: 0.6 });
      }
    }
    if (rand() < 0.5) barrels.push({ x: h.x + h.hx + 1.0, y: heightAt(h.x + h.hx + 1.0, h.z - h.hz - 1.0) + 0.6, z: h.z - h.hz - 1.0 });
  }

  // Trees --------------------------------------------------------------
  const nearHouse = (x, z, m) => overlapsHouse(x, z, 0, 0, m);
  const nearTown = (x, z, r) => {
    for (const p of pois) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  const TS = 8.5;
  for (let gz = -half; gz < half; gz += TS) {
    for (let gx = -half; gx < half; gx += TS) {
      const x = gx + rand() * TS, z = gz + rand() * TS;
      const r = rand(), s = rand(), t = rand(), yawR = rand();
      const forest = noise2.fbm(x * 0.009 + 40, z * 0.009 - 13, 3);
      if (forest < -0.12 + r * 0.35) continue;
      const hgt = heightAt(x, z);
      if (hgt < 2.2) continue;
      const sl = Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)) + Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2));
      if (sl > 3.6) continue;
      if (nearHouse(x, z, 4.5)) continue;
      if (nearTown(x, z, 26)) continue;
      const type = hgt < 4.2 ? 2 : hgt > 26 ? 0 : (t < 0.55 ? 1 : 0);
      const scale = 0.8 + s * 0.6;
      add({ kind: 'tree', type, mat: 'wood', hp: Math.round(ENV.treeHp * scale), x, y: hgt, z, s: scale, yaw: yawR * Math.PI * 2 });
    }
  }

  // Rocks --------------------------------------------------------------
  const RS = 19;
  for (let gz = -half; gz < half; gz += RS) {
    for (let gx = -half; gx < half; gx += RS) {
      const x = gx + rand() * RS, z = gz + rand() * RS;
      const r = rand(), s = rand(), t = rand(), yawR = rand();
      const hgt = heightAt(x, z);
      if (hgt < 0.5) continue;
      const rocky = noise.fbm(x * 0.012 - 31, z * 0.012 + 77, 2) + (hgt > 25 ? 0.4 : 0);
      if (rocky < 0.12 + r * 0.25) continue;
      if (nearHouse(x, z, 3)) continue;
      if (nearTown(x, z, 22)) continue;
      const scale = 0.9 + s * s * 2.6;
      add({ kind: 'rock', type: Math.floor(t * 3), mat: 'stone', hp: Math.round(ENV.rockHp * (0.6 + scale * 0.25)), x, y: hgt - 0.25 * scale, z, s: scale, yaw: yawR * Math.PI * 2 });
    }
  }

  // Outdoor chests & loot -----------------------------------------------
  for (let t = 0; t < 400 && chests.length < houses.length + 14; t++) {
    const x = (rand() - 0.5) * 440, z = (rand() - 0.5) * 440;
    const hgt = heightAt(x, z);
    if (hgt < 2.5 || nearHouse(x, z, 3)) continue;
    chests.push({ x, y: hgt, z, yaw: rand() * Math.PI * 2 });
  }
  for (let t = 0; t < 600 && lootSpots.length < 170; t++) {
    const x = (rand() - 0.5) * 460, z = (rand() - 0.5) * 460;
    const hgt = heightAt(x, z);
    if (hgt < 1.5 || nearHouse(x, z, 2)) continue;
    lootSpots.push({ x, y: hgt, z, ground: true });
  }
  for (const s of lootSpots) if (s.ground) s.y = heightAt(s.x, s.z);

  // Warm-up spawn spots around the most central POI
  const center = pois.slice().sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z))[0] || { x: 0, z: 0 };
  const spawns = [];
  for (let t = 0; t < 400 && spawns.length < 24; t++) {
    const x = center.x + (rand() - 0.5) * 70, z = center.z + (rand() - 0.5) * 70;
    if (nearHouse(x, z, 2)) continue;
    const hgt = heightAt(x, z);
    if (hgt < 2) continue;
    spawns.push({ x, z });
  }

  // Spatial hash of solid parts for build support checks
  const solids = [];
  for (const o of objects) {
    if (o.kind === 'part' || (o.kind === 'prop' && o.type === 'container')) {
      if (o.shape === 'prism') {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < o.pts.length; i += 3) {
          x0 = Math.min(x0, o.pts[i]); x1 = Math.max(x1, o.pts[i]);
          y0 = Math.min(y0, o.pts[i + 1]); y1 = Math.max(y1, o.pts[i + 1]);
          z0 = Math.min(z0, o.pts[i + 2]); z1 = Math.max(z1, o.pts[i + 2]);
        }
        solids.push({ id: o.id, x0, y0, z0, x1, y1, z1 });
      } else if (o.ax) {
        const r = Math.max(o.hx, o.hy, o.hz);
        solids.push({ id: o.id, x0: o.x - r, y0: o.y - r * 0.6, z0: o.z - r, x1: o.x + r, y1: o.y + r * 0.6, z1: o.z + r });
      } else {
        solids.push({ id: o.id, x0: o.x - o.hx, y0: o.y - o.hy, z0: o.z - o.hz, x1: o.x + o.hx, y1: o.y + o.hy, z1: o.z + o.hz });
      }
    } else if (o.kind === 'rock') {
      const r = o.s * 1.1;
      solids.push({ id: o.id, x0: o.x - r, y0: o.y - r, z0: o.z - r, x1: o.x + r, y1: o.y + r, z1: o.z + r });
    }
  }
  const HASH = 16;
  const solidHash = new Map();
  for (const s of solids) {
    for (let gx = Math.floor(s.x0 / HASH); gx <= Math.floor(s.x1 / HASH); gx++) {
      for (let gz = Math.floor(s.z0 / HASH); gz <= Math.floor(s.z1 / HASH); gz++) {
        const k = gx * 1000 + gz;
        let list = solidHash.get(k);
        if (!list) solidHash.set(k, (list = []));
        list.push(s);
      }
    }
  }
  /** Is the point (x,y,z) touching an intact solid world object? */
  function solidNear(x, y, z, destroyed, pad = 0.35) {
    const list = solidHash.get(Math.floor(x / HASH) * 1000 + Math.floor(z / HASH));
    if (!list) return false;
    for (const s of list) {
      if (destroyed && destroyed.has(s.id)) continue;
      if (x >= s.x0 - pad && x <= s.x1 + pad && y >= s.y0 - pad && y <= s.y1 + pad && z >= s.z0 - pad && z <= s.z1 + pad) return true;
    }
    return false;
  }

  let checksum = objects.length * 7919 + chests.length * 31 + lootSpots.length;
  for (const o of objects) checksum = (checksum + Math.floor(o.x * 10) * 13 + Math.floor(o.z * 10) * 17) % 1000000007;

  return {
    seed, size, res, cell, half, N, heights, heightAt,
    pois, houses, objects, chests, lootSpots, barrels, spawns, solidNear,
    mountain: { x: mx, z: mz }, checksum,
  };
}
