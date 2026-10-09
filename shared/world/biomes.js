// The biome field: every terrain grid point gets its nearest two biome seeds (noise-warped,
// weighted distance), stored as Uint8 grids biome (primary), biome2 (runner-up) and blend
// (weight of the primary biome, 128..255; 255 = pure). Ocean and beach are decided later from the
// heights and the coastline (see classifyCoast).
import { BIOMES, SURFACES } from './keys.js';
import { OCC } from './grid.js';
import { smoothstep } from '../rng.js';
import { coarseField } from './heights.js';

/** BIOMES key -> index. */
export const BI = Object.freeze(Object.fromEntries(BIOMES.map((k, i) => [k, i])));

/** Fill G.biome, G.biome2, G.blend and G.bw (primary weight 0.5..1, Float32) from the layout seeds. */
export function biomeField(G, L) {
  const { N, cell, half, k } = G;
  const n3 = G.n3;
  const seeds = L.seeds.map((s) => ({ b: BI[s.b], x: s.x, z: s.z, iw: 1 / s.w }));
  const S = seeds.length;
  const sb = new Uint8Array(S), sx = new Float64Array(S), sz = new Float64Array(S), siw = new Float64Array(S);
  seeds.forEach((s, i) => { sb[i] = s.b; sx[i] = s.x; sz[i] = s.z; siw[i] = s.iw; });
  const biome = new Uint8Array(N * N), biome2 = new Uint8Array(N * N), blend = new Uint8Array(N * N);
  const bw = new Float32Array(N * N);
  const fw = 0.004 / k, amp = 95 * k, band = 70 * k;
  // the domain warp varies slowly: sample it every 4 grid points (16 m)
  const warpX = coarseField(G, 4, (x, z) => n3.noise(x * fw, z * fw) * amp);
  const warpZ = coarseField(G, 4, (x, z) => n3.noise(x * fw + 50, z * fw - 20) * amp);
  for (let iz = 0; iz < N; iz++) {
    const z = -half + iz * cell;
    for (let ix = 0; ix < N; ix++) {
      const x = -half + ix * cell;
      const wx = x + warpX[iz * N + ix];
      const wz = z + warpZ[iz * N + ix];
      let b1 = 0, d1 = 1e18, b2 = 0, d2 = 1e18;
      for (let s = 0; s < S; s++) {
        const dx = (wx - sx[s]) * siw[s], dz = (wz - sz[s]) * siw[s];
        const d = dx * dx + dz * dz;
        if (d < d1) {
          if (sb[s] !== b1) { d2 = d1; b2 = b1; }
          d1 = d; b1 = sb[s];
        } else if (d < d2 && sb[s] !== b1) { d2 = d; b2 = sb[s]; }
      }
      if (d2 === 1e18) b2 = b1;
      const t = smoothstep(0, band, Math.sqrt(d2) - Math.sqrt(d1));
      const w = 0.5 + 0.5 * t;
      const i = iz * N + ix;
      biome[i] = b1; biome2[i] = b2; bw[i] = w;
      blend[i] = Math.round(w * 255);
    }
  }
  G.biome = biome; G.biome2 = biome2; G.blend = blend; G.bw = bw;
}

/**
 * After the heights are final: sea cells become 'ocean' and the low coastal strip 'beach'
 * (inland water, the river and the lake keep their land biome).
 */
export function classifyCoast(G) {
  const { N, heights, land, biome, biome2, blend } = G;
  const OCEAN = BI.ocean, BEACH = BI.beach;
  for (let i = 0; i < N * N; i++) {
    const h = heights[i], c = land[i];
    if (c < 0.97 && h < -1.2) { biome2[i] = biome[i]; biome[i] = OCEAN; blend[i] = 255; } else if (c < 0.999 && h < 3.4 && !G.inland[i]) {
      biome2[i] = biome[i]; biome[i] = BEACH; blend[i] = 255;
    }
  }
}

// ------------------------------------------------------------------ surfaces
// The surface grid: one SURFACES index per terrain grid point (the dominant ground layer the
// renderer splats and footsteps sound like): snow on the mountain, strata on mesa cliffs, asphalt
// on paved roads, field and wheat on farms, ash and lava on the volcano, mud in the swamp, sand on
// beaches and in the desert, rock on steep slopes everywhere.
export const SI = Object.freeze(Object.fromEntries(SURFACES.map((k, i) => [k, i])));

export function surfaceGrid(G, L, plans, lava) {
  const { N, cell, half, heights, biome, occ, road, inland } = G;
  const surface = new Uint8Array(N * N);
  const n = G.n4;
  const cityCore = new Uint8Array(N * N);
  // fields and plazas paint over the biome
  const paint = (x, z, hx, hz, s) => {
    const ix0 = Math.max(0, Math.ceil((x - hx + half) / cell)), ix1 = Math.min(N - 1, Math.floor((x + hx + half) / cell));
    const iz0 = Math.max(0, Math.ceil((z - hz + half) / cell)), iz1 = Math.min(N - 1, Math.floor((z + hz + half) / cell));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) cityCore[iz * N + ix] = s + 1;
  };
  for (const p of plans) {
    for (const f of p.fields) paint(f.x, f.z, f.hx, f.hz, f.crop === 'wheat' ? SI.wheat : SI.field);
    for (const pz of p.plazas) paint(pz.x, pz.z, pz.hx, pz.hz, SI.cobble);
  }
  const v = L.volcano;
  for (let iz = 0; iz < N; iz++) {
    const z = -half + iz * cell;
    for (let ix = 0; ix < N; ix++) {
      const x = -half + ix * cell;
      const i = iz * N + ix;
      const h = heights[i];
      // near a biome border, patches of the neighbouring biome's ground (blobby noise against the blend weight)
      let b = biome[i];
      const w = G.bw[i];
      if (w < 0.98 && G.biome2[i] !== b && b !== BI.ocean && b !== BI.beach && G.biome2[i] > BI.beach) {
        if (n.noise(x * 0.06 + 7.7, z * 0.06 - 3.1) * 0.5 + 0.5 > 0.35 + (w - 0.5) * 1.3) b = G.biome2[i];
      }
      // slope from the neighbouring grid points (rise per metre)
      const hl = heights[ix > 0 ? i - 1 : i], hr = heights[ix < N - 1 ? i + 1 : i];
      const hu = heights[iz > 0 ? i - N : i], hd = heights[iz < N - 1 ? i + N : i];
      const gx = (hr - hl) / (2 * cell), gz = (hd - hu) / (2 * cell);
      const slope = Math.sqrt(gx * gx + gz * gz);
      let s;
      if (cityCore[i]) s = cityCore[i] - 1;
      else if (road[i] === 2) s = SI.asphalt;
      else if (road[i] === 1) s = SI.dirt;
      else if (b === BI.ocean || b === BI.beach) s = slope > 0.9 ? SI.rock : SI.sand;
      else if (h < 1.0 && inland[i]) s = b === BI.swamp || b === BI.jungle ? SI.mud : b === BI.snow ? SI.rock : SI.sand;
      else {
        const p = n.noise(x * 0.045, z * 0.045);
        switch (b) {
          case BI.snow: s = slope > 0.85 ? SI.rock : p > 0.55 && h < 40 ? SI.ice : SI.snow; break;
          case BI.desert: s = slope > 0.7 ? SI.strata : p > 0.35 ? SI.redsand : SI.sand; break;
          case BI.mesa: s = slope > 0.45 ? SI.strata : p < -0.45 ? SI.sand : SI.redsand; break;
          case BI.jungle: s = slope > 0.8 ? SI.rock : p > 0.45 ? SI.mud : SI.junglefloor; break;
          case BI.swamp: s = p > 0.1 ? SI.mud : SI.junglefloor; break;
          case BI.volcano: {
            const dx = x - v.x, dz = z - v.z;
            const near = dx * dx + dz * dz < (v.r * 0.75) * (v.r * 0.75);
            s = slope > 0.9 ? SI.rock : near || p > 0.2 ? SI.ash : SI.dirt;
            break;
          }
          case BI.farm: s = slope > 0.8 ? SI.rock : p > 0.5 ? SI.dirt : SI.grass; break;
          case BI.city: s = occ[i] === OCC.BUILDING ? SI.cobble : slope > 0.8 ? SI.rock : SI.grass; break;
          case BI.forest: s = slope > 0.8 ? SI.rock : p > 0.3 ? SI.dirt : SI.grass; break;
          default: s = slope > 0.8 ? SI.rock : p > 0.55 ? SI.dirt : SI.grass;
        }
      }
      surface[i] = s;
    }
  }
  // lava discs: painted exactly where lava hurts (the Room's inLava: inside r and below its top)
  for (const l of lava) {
    const R = l.r;
    const top = (Number.isFinite(l.y) ? l.y : Infinity) + 1.2;
    const ix0 = Math.max(0, Math.floor((l.x - R + half) / cell)), ix1 = Math.min(N - 1, Math.ceil((l.x + R + half) / cell));
    const iz0 = Math.max(0, Math.floor((l.z - R + half) / cell)), iz1 = Math.min(N - 1, Math.ceil((l.z + R + half) / cell));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const x = -half + ix * cell, z = -half + iz * cell;
      if ((x - l.x) * (x - l.x) + (z - l.z) * (z - l.z) <= R * R && heights[iz * N + ix] < top) surface[iz * N + ix] = SI.lava;
    }
  }
  return surface;
}
