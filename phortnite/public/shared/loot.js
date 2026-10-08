// Loot: what lies on the floor, what chests give and the loadouts modes hand out. Shared by the
// Room and the client, so it must stay free of DOM / Node specific APIs.
//
// The initial floor loot is SEEDED: the Room sends {lootSeed, lootN} in 'start' and every client
// rolls the same list with rollInitialLoot(world, seed, rules, area). That keeps the start message
// small (today's per-item list was 21.7 KB on the 640 m island). Determinism: only mulberry32 and
// + - * / Math.floor / Math.round (no Math.random), so Node and every browser agree to the bit.
import {
  WEAPONS, WEAPON_WEIGHTS, RARITY_WEIGHTS, AMMO, HEALS, MAT_KEYS, clampRarity, own,
} from './constants.js';
import { mulberry32 } from './rng.js';

/** rules.loot: which guns turn up (null = every gun). */
export const LOOT_POOLS = Object.freeze({
  all: null,
  ars: ['ar', 'burst'],
  smgs: ['smg'],
  shotguns: ['shotgun', 'tactical'],
  snipers: ['sniper'],
  pistols: ['pistol'],
  rockets: ['rocket'],
  explosive: ['rocket'],
  pickaxe: [],
});

const r2 = (v) => Math.round(v * 100) / 100;
const HEAL_KEYS = Object.keys(HEALS);
const AMMO_KEYS = Object.keys(AMMO);

/** Index picked from weights with rnd() in [0, 1). */
export function pickWeighted(weights, rnd) {
  let total = 0;
  for (const w of weights) total += w;
  let x = rnd() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

// per pool: gun keys + weights, the ammo kinds they use + weights (cached, plain arrays)
const POOL_CACHE = new Map();
function poolInfo(pool) {
  const name = own(LOOT_POOLS, pool) ? pool : 'all';
  let info = POOL_CACHE.get(name);
  if (info) return info;
  const keys = (LOOT_POOLS[name] || Object.keys(WEAPON_WEIGHTS)).filter((k) => own(WEAPON_WEIGHTS, k));
  const ammoKeys = name === 'all' ? AMMO_KEYS : [...new Set(keys.map((k) => WEAPONS[k].ammo))];
  const ammoW = name === 'all' ? [30, 30, 12, 22, 6] : ammoKeys.map(() => 1);
  info = { name, keys, weights: keys.map((k) => WEAPON_WEIGHTS[k]), ammoKeys, ammoW };
  POOL_CACHE.set(name, info);
  return info;
}

/** The gun keys of a pool (rules.loot). */
export function poolKeys(pool) { return poolInfo(pool).keys; }

/**
 * A gun from the pool: {k, r, m}, or null when the pool has no guns (pickaxe only).
 * rarityMode (rules.rarity): 'normal' rolls RARITY_WEIGHTS, 'boosted' adds 1, 'legendary' is always
 * the best the gun comes in, 'common' always the lowest. boost: chests +1, hot spots sometimes +1.
 */
export function rollWeapon(rng, pool = 'all', rarityMode = 'normal', boost = 0) {
  const P = poolInfo(pool);
  if (!P.keys.length) return null;
  const k = P.keys[pickWeighted(P.weights, rng)];
  let r;
  if (rarityMode === 'legendary') r = 4;
  else if (rarityMode === 'common') r = 0;
  else r = Math.min(4, pickWeighted(RARITY_WEIGHTS, rng) + boost + (rarityMode === 'boosted' ? 1 : 0));
  r = clampRarity(k, r);
  return { k, r, m: WEAPONS[k].mag };
}

/** A heal item (rules.heals 'none' = never: null). weights follow today's floor / chest tables. */
function rollHeal(rng, weights) {
  const k = HEAL_KEYS[pickWeighted(weights, rng)];
  return { k, n: HEALS[k].give };
}

/** Does a loot spot / chest at (x, z) belong to the play area (its radius + 30 m)? */
export function inArea(area, x, z) {
  if (!area) return true;
  const dx = x - area.x, dz = z - area.z, R = area.r + 30;
  return dx * dx + dz * dz <= R * R;
}

/**
 * The match's floor loot: [{id, item, x, y, z}] with ids 1..n, the same on the Room and every
 * client for the same (world, seed, rules, area). rules: loot, rarity, floorLoot, heals.
 */
export function rollInitialLoot(world, seed, rules, area) {
  const out = [];
  if (!rules || rules.floorLoot === false) return out;
  const rng = mulberry32((seed >>> 0) ^ 0x51ed270b);
  const P = poolInfo(rules.loot);
  const noGuns = !P.keys.length;
  const heals = rules.heals || 'normal';
  // share of the four kinds of floor loot (gun+ammo, heal, ammo, mats), like today's 56/18/16/10
  const healW = heals === 'none' ? 0 : heals === 'extra' ? 36 : 18;
  const gunW = noGuns ? 0 : 56;
  const ammoW = noGuns ? 0 : 16;
  const kinds = [gunW, healW, ammoW, 10 + (noGuns ? 20 : 0)];
  let id = 1;
  const add = (item, x, y, z) => { out.push({ id: id++, item, x: r2(x), y: r2(y), z: r2(z) }); };
  for (const s of world.lootSpots) {
    // the Room and the clients make exactly the same draws in the same order (same area, rules)
    const roll = rng(), j1 = rng(), j2 = rng(), j3 = rng(), j4 = rng(), hot = rng();
    if (!inArea(area, s.x, s.z)) continue;
    const jx = (j1 - 0.5) * 1.2, jz = (j2 - 0.5) * 1.2;
    const kind = pickWeighted(kinds, () => roll);
    if (kind === 0) {
      const boost = s.tier === 'hot' && hot < 0.25 ? 1 : 0;
      const w = rollWeapon(rng, rules.loot, rules.rarity, boost);
      add(w, s.x + jx, s.y, s.z + jz);
      const am = WEAPONS[w.k].ammo;
      add({ k: am, n: AMMO[am].pickup }, s.x + (j3 - 0.5) * 1.2, s.y, s.z + (j4 - 0.5) * 1.2);
    } else if (kind === 1) {
      add(rollHeal(rng, [30, 10, 30, 14]), s.x + jx, s.y, s.z + jz);
    } else if (kind === 2) {
      const k = P.ammoKeys[pickWeighted(P.ammoW, rng)];
      add({ k, n: AMMO[k].pickup }, s.x + jx, s.y, s.z + jz);
    } else {
      add({ k: MAT_KEYS[pickWeighted([5, 3, 2], rng)], n: 30 }, s.x + jx, s.y, s.z + jz);
    }
  }
  return out;
}

/** What a chest gives (rng: the Room's): a gun (+1 rarity) with ammo, then a heal or wood. */
export function rollChest(rng, rules, tier = 'normal') {
  const items = [];
  const boost = 1 + (tier === 'hot' && rng() < 0.25 ? 1 : 0);
  const w = rollWeapon(rng, rules.loot, rules.rarity, boost);
  if (w) {
    items.push(w);
    const am = WEAPONS[w.k].ammo;
    items.push({ k: am, n: AMMO[am].pickup });
  } else {
    items.push({ k: MAT_KEYS[pickWeighted([5, 3, 2], rng)], n: 50 });
  }
  const healChance = rules.heals === 'none' ? 0 : rules.heals === 'extra' ? 0.9 : 0.6;
  if (rng() < healChance) items.push(rollHeal(rng, [25, 12, 30, 18]));
  else items.push({ k: 'wood', n: 30 });
  if (rules.heals === 'extra' && rng() < 0.5) items.push(rollHeal(rng, [25, 12, 30, 18]));
  return items;
}

// ------------------------------------------------------------------ loadouts
const gun = (k, r) => ({ k, r: clampRarity(k, r), m: WEAPONS[k].mag });
const AMMO_PACKS = 4; // a loadout gun comes with this many ammo pickups

/**
 * The fixed loadouts (rules.loadout), as {slots, ammo, heals}; makeLoadout turns one into a Loadout
 * with the mode's materials. 'pool' is rolled per player (one epic gun from rules.loot).
 */
export const LOADOUTS = Object.freeze({
  buildfight: { slots: [gun('shotgun', 4), gun('ar', 4), { k: 'shield_b', n: 2 }] },
  zonewars: { slots: [gun('ar', 3), gun('shotgun', 3), gun('smg', 2), { k: 'shield_b', n: 2 }] },
  pickaxe: { slots: [] },
});

/**
 * A player's loadout under these rules, or null when the mode gives none (rules.loadout 'none'
 * with no start materials): {slots: [{k, r, m} | {k, n}] (at most 5), ammo, mats, infAmmo?}.
 * rng is only used by 'pool'.
 */
export function makeLoadout(rules, rng = Math.random) {
  const mats = rules.mats | 0;
  const lo = { slots: [], ammo: {}, mats: { wood: mats, stone: mats, metal: mats } };
  const kind = rules.loadout;
  if (kind === 'pool') {
    const w = rollWeapon(rng, rules.loot === 'pickaxe' ? 'all' : rules.loot, 'normal', 0);
    if (w) lo.slots.push(gun(w.k, rules.rarity === 'legendary' ? 4 : 3));
  } else if (own(LOADOUTS, kind)) {
    for (const s of LOADOUTS[kind].slots) lo.slots.push({ ...s });
  } else if (!mats) return null;
  for (const s of lo.slots) {
    if (!own(WEAPONS, s.k)) continue;
    const am = WEAPONS[s.k].ammo;
    lo.ammo[am] = (lo.ammo[am] | 0) + AMMO[am].pickup * AMMO_PACKS;
  }
  if (rules.ammo === 'infinite') lo.infAmmo = true;
  return lo;
}

/** A loadout from anywhere (a party game) made safe for the wire: known items, clamped numbers. */
export function cleanLoadout(lo) {
  if (!lo || typeof lo !== 'object') return null;
  const out = { slots: [], ammo: {}, mats: { wood: 0, stone: 0, metal: 0 } };
  const slots = Array.isArray(lo.slots) ? lo.slots : [];
  for (const s of slots.slice(0, 5)) {
    if (!s || typeof s.k !== 'string') { out.slots.push(null); continue; }
    if (s.k === 'pickaxe') continue; // slot 0 always holds the pickaxe
    if (own(WEAPONS, s.k)) {
      const r = clampRarity(s.k, s.r | 0);
      out.slots.push({ k: s.k, r, m: Math.max(0, Math.min(WEAPONS[s.k].mag, s.m === undefined ? WEAPONS[s.k].mag : s.m | 0)) });
    } else if (own(HEALS, s.k)) {
      out.slots.push({ k: s.k, n: Math.max(1, Math.min(HEALS[s.k].stack, s.n | 0 || 1)) });
    } else out.slots.push(null); // unknown item: an empty slot (the others keep their place)
  }
  while (out.slots.length && !out.slots[out.slots.length - 1]) out.slots.pop();
  if (lo.ammo && typeof lo.ammo === 'object') {
    for (const k of AMMO_KEYS) if (own(lo.ammo, k)) out.ammo[k] = Math.max(0, Math.min(999, lo.ammo[k] | 0));
  }
  if (lo.mats && typeof lo.mats === 'object') {
    for (const k of MAT_KEYS) out.mats[k] = Math.max(0, Math.min(999, lo.mats[k] | 0));
  }
  if (lo.infAmmo) out.infAmmo = true;
  return out;
}
