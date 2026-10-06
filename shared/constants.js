// Shared game rules for Phortnite. Imported by the browser client AND the Node server,
// so this file must stay free of DOM / Node specific APIs.

export const VERSION = '1.1.0';
export const PROTOCOL = 2; // bump whenever old and new builds can't share a party

export const TICK_HZ = 20;            // server snapshot rate
export const SEND_HZ = 20;            // client state upload rate

export const MAP = {
  seed: 20261003,                     // one hand-tuned island, like the real thing
  size: 640,                          // metres, terrain spans [-320, 320]
  res: 160,                           // terrain cells per side (4 m cells)
  islandRadius: 268,
  waterY: 0,
};

export const BUILD = {
  cell: 4,                            // grid cell width (m)
  level: 4,                           // grid level height (m)
  cost: 10,
  maxPieces: 1500,
  mats: {
    wood:  { hp: 150, grow: 2.2, label: 'Wood' },
    stone: { hp: 300, grow: 3.6, label: 'Brick' },
    metal: { hp: 450, grow: 5.0, label: 'Metal' },
  },
  startFrac: 0.12,                    // a piece starts with this fraction of its max hp and grows
};

export const MAT_KEYS = ['wood', 'stone', 'metal'];
export const MAX_MATS = 999;

export const PLAYER = {
  maxHp: 100,
  maxShield: 100,
  startShield: 100,                   // everyone spawns with full shield: 200 effective hp, like the real thing
  siphon: 50,                         // an elimination gives the killer this much back: health first, then shield
  radius: 0.38,
  halfHeight: 0.52,                   // capsule half height (total height = 2*(hh+r) = 1.8)
  eye: 1.55,
  run: 6.2,
  sprint: 8.4,
  crouch: 3.0,
  ads: 3.8,
  jump: 8.4,
  gravity: 24,
  stepHeight: 0.5,
  fallSafe: 19,                       // impact speed below which there is no fall damage
  fallDmgPerMs: 7,
  skydiveFall: 34,
  skydiveDive: 50,
  skydiveSpeed: 22,
  glideFall: 8,
  glideSpeed: 15,
  glideHeight: 55,                    // glider deploys automatically this far above ground
};

export const RARITY = [
  { key: 'common',    name: 'Common',    color: '#b4b8bf' },
  { key: 'uncommon',  name: 'Uncommon',  color: '#5ad13a' },
  { key: 'rare',      name: 'Rare',      color: '#3ea4ff' },
  { key: 'epic',      name: 'Epic',      color: '#bd52ff' },
  { key: 'legendary', name: 'Legendary', color: '#ffb22e' },
];

// speed in m/s, grav = multiplier on 9.81 m/s^2, spread angles in radians (cone half-angle).
// rate = shots (or bursts) per second; burst guns fire `burst` rounds `burstGap` s apart per pull.
// Camera recoil (local player only, see js/combat/recoil.js): recoil = vertical kick per shot (rad),
// recoilSide = random sideways kick, recoilCenter = how hard sideways kicks pull back to centre,
// recoilMax = the climb flattens out near this offset, recover = return rate (1/s) once
// recoverDelay s have passed since the last shot. kick = gun kick on the character (0..1),
// shake = camera shake per shot.
export const WEAPONS = {
  pickaxe: {
    name: 'Harvesting Tool', short: 'Pick', melee: true, dmg: [20, 20, 20, 20, 20], rate: 1.7,
    range: 2.8, struct: 2.5, rarities: [0],
  },
  // steady upward climb you pull down against
  ar: {
    name: 'Assault Rifle', short: 'AR', ammo: 'medium', mag: 30, rate: 5.5, auto: true,
    dmg: [30, 31, 33, 35, 36], head: 1.5, speed: 420, grav: 0.35, pellets: 1,
    spread: 0.028, spreadAds: 0.009, firstShot: true, bloom: 0.006, bloomMax: 0.05,
    recoil: 0.0098, recoilSide: 0.0024, recoilCenter: 0.25, recoilMax: 0.065, recover: 7, recoverDelay: 0.2,
    kick: 0.5, shake: 0.12,
    reload: 2.3, falloff: [60, 170, 0.65], struct: 1, zoom: 1.55, rarities: [0, 1, 2, 3, 4],
  },
  // three quick rounds per pull, small kick per burst that settles before the next one
  burst: {
    name: 'Burst Assault Rifle', short: 'Burst', ammo: 'medium', mag: 24, rate: 1.7, auto: true, burst: 3, burstGap: 0.07,
    dmg: [27, 28, 30, 31, 33], head: 1.5, speed: 430, grav: 0.33, pellets: 1,
    spread: 0.024, spreadAds: 0.006, firstShot: true, bloom: 0.004, bloomMax: 0.035,
    recoil: 0.0072, recoilSide: 0.0026, recoilCenter: 0.3, recoilMax: 0.06, recover: 8, recoverDelay: 0.1,
    kick: 0.45, shake: 0.1,
    reload: 2.6, falloff: [70, 190, 0.65], struct: 1, zoom: 1.6, rarities: [0, 1, 2, 3, 4],
  },
  // very fast, small kick but jittery side to side
  smg: {
    name: 'Rapid SMG', short: 'SMG', ammo: 'light', mag: 30, rate: 12, auto: true,
    dmg: [14, 15, 15, 16, 17], head: 1.75, speed: 360, grav: 0.45, pellets: 1,
    spread: 0.034, spreadAds: 0.021, bloom: 0.004, bloomMax: 0.05,
    recoil: 0.0036, recoilSide: 0.0055, recoilCenter: 0.5, recoilMax: 0.035, recover: 9, recoverDelay: 0.12,
    kick: 0.35, shake: 0.07,
    reload: 1.9, falloff: [18, 70, 0.55], struct: 1, zoom: 1.3, rarities: [0, 1, 2, 3],
  },
  // one big shove per shot
  shotgun: {
    name: 'Pump Shotgun', short: 'Pump', ammo: 'shells', mag: 5, rate: 0.9, auto: false,
    dmg: [8.6, 9.2, 9.8, 10.4, 11], head: 2.0, speed: 280, grav: 0.6, pellets: 10,
    spread: 0.078, spreadAds: 0.062, bloom: 0, bloomMax: 0,
    recoil: 0.05, recoilSide: 0.012, recoilCenter: 0, recoilMax: 0.2, recover: 6, recoverDelay: 0.12,
    kick: 1, shake: 0.45,
    reload: 4.5, falloff: [6, 26, 0.3], struct: 0.9, zoom: 1.25, rarities: [0, 1, 2, 3],
  },
  // faster, bigger mag, weaker pellets
  tactical: {
    name: 'Tactical Shotgun', short: 'Tac', ammo: 'shells', mag: 8, rate: 1.5, auto: false,
    dmg: [6.2, 6.6, 7.0, 7.4, 7.8], head: 1.75, speed: 280, grav: 0.6, pellets: 10,
    spread: 0.085, spreadAds: 0.07, bloom: 0, bloomMax: 0,
    recoil: 0.034, recoilSide: 0.01, recoilCenter: 0, recoilMax: 0.16, recover: 7, recoverDelay: 0.1,
    kick: 0.8, shake: 0.35,
    reload: 5.0, falloff: [5, 22, 0.3], struct: 0.8, zoom: 1.25, rarities: [0, 1, 2, 3],
  },
  sniper: {
    name: 'Bolt Sniper', short: 'Sniper', ammo: 'heavy', mag: 1, rate: 0.5, auto: false,
    dmg: [100, 105, 110, 116, 121], head: 2.5, speed: 320, grav: 1.0, pellets: 1,
    spread: 0.06, spreadAds: 0.0, bloom: 0, bloomMax: 0,
    recoil: 0.065, recoilSide: 0.01, recoilCenter: 0, recoilMax: 0.25, recover: 5.5, recoverDelay: 0.15,
    kick: 1, shake: 0.45,
    reload: 2.8, falloff: null, struct: 1, zoom: 5.2, scope: true, rarities: [2, 3, 4],
  },
  // snappy: a sharp flick up that settles right away
  pistol: {
    name: 'Pistol', short: 'Pistol', ammo: 'light', mag: 16, rate: 6, auto: false,
    dmg: [24, 25, 26, 28, 29], head: 2.0, speed: 330, grav: 0.5, pellets: 1,
    spread: 0.022, spreadAds: 0.012, bloom: 0.012, bloomMax: 0.05,
    recoil: 0.016, recoilSide: 0.004, recoilCenter: 0.3, recoilMax: 0.08, recover: 9, recoverDelay: 0.06,
    kick: 0.55, shake: 0.14,
    reload: 1.3, falloff: [25, 70, 0.6], struct: 1, zoom: 1.3, rarities: [0, 1, 2],
  },
  rocket: {
    name: 'Rocket Launcher', short: 'Rocket', ammo: 'rockets', mag: 1, rate: 0.7, auto: false,
    dmg: [85, 90, 95, 100, 110], head: 1, speed: 58, grav: 0.12, pellets: 1, splash: 5.2,
    spread: 0.01, spreadAds: 0.0, bloom: 0, bloomMax: 0,
    recoil: 0.05, recoilSide: 0.008, recoilCenter: 0, recoilMax: 0.2, recover: 6, recoverDelay: 0.12,
    kick: 1, shake: 0.45,
    reload: 3.4, falloff: null, struct: 4.5, zoom: 1.4, projectile: 'rocket', rarities: [3, 4],
  },
};

export const WEAPON_KEYS = ['ar', 'burst', 'smg', 'shotgun', 'tactical', 'sniper', 'pistol', 'rocket'];

// How often each gun turns up in floor loot and chests (rarity is rolled separately and clamped
// to the gun's `rarities`).
export const WEAPON_WEIGHTS = { ar: 22, burst: 12, smg: 16, shotgun: 16, tactical: 13, pistol: 14, sniper: 8, rocket: 6 };

export const AMMO = {
  light:   { name: 'Light Ammo',  pickup: 30, color: '#9fd4ff' },
  medium:  { name: 'Medium Ammo', pickup: 20, color: '#ffd36b' },
  heavy:   { name: 'Heavy Ammo',  pickup: 6,  color: '#ff7a5c' },
  shells:  { name: 'Shells',      pickup: 8,  color: '#ff5c8a' },
  rockets: { name: 'Rockets',     pickup: 3,  color: '#c8ff5c' },
};
export const AMMO_KEYS = Object.keys(AMMO);
export const MAX_AMMO = 999;

export const HEALS = {
  bandage:  { name: 'Bandages',     hp: 15,  cap: 75,  time: 3.0, stack: 15, give: 5, rarity: 0 },
  medkit:   { name: 'Med Kit',      hp: 100, cap: 100, time: 8.0, stack: 3,  give: 1, rarity: 1 },
  shield_s: { name: 'Small Shield', sh: 25,  cap: 50,  time: 2.0, stack: 6,  give: 3, rarity: 1 },
  shield_b: { name: 'Shield Potion', sh: 50, cap: 100, time: 4.5, stack: 3,  give: 1, rarity: 2 },
};
export const HEAL_KEYS = Object.keys(HEALS);

// Environment object hit points / harvest yields
export const ENV = {
  treeHp: 170,
  rockHp: 320,
  harvest: { wood: 9, stone: 7, metal: 6 },
};

// Storm circles: wait (s), shrink (s), radius ratio of previous circle, damage per second
export const STORM = {
  startRadius: 330,
  phases: [
    { wait: 70, shrink: 45, ratio: 0.58, dps: 1 },
    { wait: 50, shrink: 40, ratio: 0.52, dps: 2 },
    { wait: 40, shrink: 32, ratio: 0.48, dps: 5 },
    { wait: 30, shrink: 26, ratio: 0.42, dps: 8 },
    { wait: 24, shrink: 22, ratio: 0.38, dps: 10 },
    { wait: 18, shrink: 20, ratio: 0.0,  dps: 12 },
  ],
};

export const BUS = { height: 135, speed: 30, length: 680, forceDrop: 0.84 };

export const SKINS = [
  { id: 0, name: 'Phantom',    outfit: '#2b2f45', accent: '#7cf2ff', pants: '#1c1f2e', skin: '#e9b48a', hair: '#141414', shoes: '#f1f1f1' },
  { id: 1, name: 'Phlame',     outfit: '#e2402c', accent: '#ffd23f', pants: '#2b2b2b', skin: '#c88a62', hair: '#ff7b1c', shoes: '#ffd23f' },
  { id: 2, name: 'Phrost',     outfit: '#7fd3ff', accent: '#ffffff', pants: '#3364b8', skin: '#f2c6a2', hair: '#e8f6ff', shoes: '#2c4f93' },
  { id: 3, name: 'Phorest',    outfit: '#3f8f3a', accent: '#c6e05a', pants: '#5a4630', skin: '#8d5a3b', hair: '#2d1d10', shoes: '#3a2b1c' },
  { id: 4, name: 'Phlamingo',  outfit: '#ff6fb1', accent: '#fff36b', pants: '#ffffff', skin: '#ffd1b0', hair: '#ff3d8b', shoes: '#ff6fb1' },
  { id: 5, name: 'Pharaoh',    outfit: '#f2c94c', accent: '#2a5dd6', pants: '#f7f0d8', skin: '#a56a43', hair: '#111111', shoes: '#b88a2b' },
  { id: 6, name: 'Phunky',     outfit: '#8a4dff', accent: '#3dffb4', pants: '#24164a', skin: '#e0a379', hair: '#3dffb4', shoes: '#ffffff' },
  { id: 7, name: 'Phoenix',    outfit: '#ff8a00', accent: '#ff2e2e', pants: '#40160a', skin: '#d9976b', hair: '#ffcf33', shoes: '#ff2e2e' },
];

export const BOT_NAMES = [
  'Bananarama', 'Captain Crunchy', 'Noob Saibot', 'Pixel Pete', 'Sir Builds-a-lot', 'Turbo Turtle',
  'Lag Monster', 'Cranky Kong', 'DJ Pickaxe', 'Moonwalker', 'Sneaky Pete', 'Glitch', 'Bush Camper',
  'Ramp Rusher', 'Loot Goblin', 'Sweaty Steve', 'Default Dan', 'No Scope Nancy', 'Llamalord', 'Ping 999',
  'Wobbly Wizard', 'Chug Jugger', 'Box Fighter', 'Storm Chaser',
];

// Loot tables -------------------------------------------------------------
export const RARITY_WEIGHTS = [42, 30, 17, 8, 3];

export function clampRarity(key, r) {
  const list = own(WEAPONS, key) ? WEAPONS[key].rarities : [0];
  if (list.includes(r)) return r;
  let best = list[0];
  for (const x of list) if (Math.abs(x - r) < Math.abs(best - r)) best = x;
  return best;
}

export function weaponDamage(key, rarity, dist, head) {
  if (!own(WEAPONS, key)) return 0;
  const w = WEAPONS[key];
  let d = w.dmg[Math.max(0, Math.min(w.dmg.length - 1, rarity | 0))];
  if (head && w.head) d *= w.head;
  if (w.falloff && dist > w.falloff[0]) {
    const [a, b, min] = w.falloff;
    const t = Math.min(1, (dist - a) / (b - a));
    d *= 1 + (min - 1) * t;
  }
  return d;
}

/** Own-property lookup so keys like "constructor" never match a table. */
export const own = (table, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(table, k);

export function itemName(item) {
  if (!item) return '';
  if (own(WEAPONS, item.k)) return `${RARITY[Math.max(0, Math.min(4, item.r | 0))].name} ${WEAPONS[item.k].name}`;
  if (own(HEALS, item.k)) return HEALS[item.k].name;
  if (own(AMMO, item.k)) return AMMO[item.k].name;
  if (MAT_KEYS.includes(item.k)) return BUILD.mats[item.k].label;
  return String(item.k);
}

export function itemKind(k) {
  if (own(WEAPONS, k)) return 'weapon';
  if (own(HEALS, k)) return 'heal';
  if (own(AMMO, k)) return 'ammo';
  if (MAT_KEYS.includes(k)) return 'mat';
  return 'unknown';
}

// Animation state codes sent over the network
export const ANIM = {
  IDLE: 0, RUN: 1, SPRINT: 2, CROUCH: 3, CROUCH_WALK: 4, AIR: 5, SKYDIVE: 6, GLIDE: 7, BUS: 8, DEAD: 9, DANCE: 10,
};

// Bit flags sent with player state
export const FLAG = {
  ADS: 1, FIRING: 2, RELOAD: 4, BUILD: 8, HEAL: 16, SWING: 32,
};
