// The hand-made layout of the biome island, in metres on the 1.6 km map (x east, z south, so
// north is -z). layoutFor(size) scales it for a smaller map (the 1200 m fallback).
//
// BIOME_SEEDS: each land biome grows around its seeds (noise-warped nearest-two field, w scales
// the seed's reach). FEATURES: the snow massif, the volcano, the river, Splashy Lake. PLACES: the
// 26 named places; LANDMARKS: smaller unnamed spots (gas stations, campsites, radio towers, ...).
// Place fields: name, biome (a BIOMES key), kind ('city' | 'town' | 'farm' | 'outpost' |
// 'landmark'), x / z hint, r (radius), tier (a TIERS key), recipe (the layout in pois.js).

export const BIOME_SEEDS = [
  { b: 'city', x: -20, z: 70, w: 1.08 },
  { b: 'snow', x: -70, z: -480, w: 1.25 },
  { b: 'snow', x: -330, z: -380, w: 0.95 },
  { b: 'forest', x: 310, z: -400, w: 1.0 },
  { b: 'forest', x: -500, z: -150, w: 0.92 },
  { b: 'meadow', x: 190, z: -190, w: 0.82 },
  { b: 'meadow', x: -240, z: -210, w: 0.8 },
  { b: 'meadow', x: 250, z: 80, w: 0.72 },
  { b: 'desert', x: 480, z: -70, w: 1.02 },
  { b: 'mesa', x: 420, z: 270, w: 0.98 },
  { b: 'jungle', x: 170, z: 470, w: 1.0 },
  { b: 'swamp', x: -130, z: 430, w: 0.86 },
  { b: 'volcano', x: -420, z: 330, w: 1.08 },
  { b: 'farm', x: -470, z: 80, w: 1.0 },
  { b: 'farm', x: -240, z: 160, w: 0.82 },
];

export const FEATURES = {
  // the snow massif: a ridged dome peaking near 170 m
  peak: { x: -80, z: -470, r: 270, h: 128 },
  // the volcano: a 105 m cone with a 38 m crater (lava pool on its floor)
  volcano: { x: -410, z: 345, r: 215, h: 105, crater: 38, depth: 50 },
  // the river: from the snow foothills down to a delta on the south coast, carved below sea level
  river: {
    pts: [[-30, -330], [30, -250], [100, -150], [140, -50], [132, 60], [160, 180], [205, 300], [238, 420], [252, 540], [262, 700]],
    w0: 12, w1: 30, bed: -2.5,
  },
  // Splashy Lake, with an island in the middle
  lake: { x: -215, z: -25, r: 62, bed: -3, island: 15 },
};

export const PLACES = [
  { name: 'Tilty Towers', biome: 'city', kind: 'city', x: -20, z: -10, r: 88, tier: 'hot', recipe: 'downtown' },
  { name: 'Retail Rumble', biome: 'city', kind: 'town', x: -30, z: 175, r: 72, tier: 'hot', recipe: 'mall' },
  { name: 'Frosty Peak', biome: 'snow', kind: 'outpost', x: -175, z: -420, r: 42, tier: 'normal', recipe: 'ski' },
  { name: 'Chilly Chalets', biome: 'snow', kind: 'town', x: -335, z: -330, r: 62, tier: 'normal', recipe: 'chalets' },
  { name: 'Polar Palace', biome: 'snow', kind: 'outpost', x: 95, z: -515, r: 48, tier: 'normal', recipe: 'icecastle' },
  { name: 'Dusty Depot', biome: 'desert', kind: 'town', x: 400, z: -50, r: 62, tier: 'hot', recipe: 'depot' },
  { name: 'Mesa Mayhem', biome: 'mesa', kind: 'town', x: 445, z: 225, r: 62, tier: 'normal', recipe: 'western' },
  { name: 'Phunny Palms', biome: 'desert', kind: 'town', x: 520, z: -215, r: 55, tier: 'normal', recipe: 'oasis' },
  { name: 'Cactus Canyon', biome: 'mesa', kind: 'outpost', x: 330, z: 355, r: 48, tier: 'normal', recipe: 'canyon' },
  { name: 'Slurpy Swamp', biome: 'swamp', kind: 'town', x: -135, z: 430, r: 60, tier: 'normal', recipe: 'swamp' },
  { name: 'Temple of Phun', biome: 'jungle', kind: 'outpost', x: 140, z: 480, r: 50, tier: 'hot', recipe: 'temple' },
  { name: 'Treetop Town', biome: 'jungle', kind: 'town', x: 55, z: 340, r: 58, tier: 'normal', recipe: 'treehouses' },
  { name: 'Lava Lair', biome: 'volcano', kind: 'outpost', x: -345, z: 270, r: 42, tier: 'hot', recipe: 'lair' },
  { name: 'Magma Mines', biome: 'volcano', kind: 'town', x: -505, z: 335, r: 52, tier: 'normal', recipe: 'mines' },
  { name: 'Phunny Farm', biome: 'farm', kind: 'farm', x: -455, z: 60, r: 70, tier: 'normal', recipe: 'farm' },
  { name: 'Pumpkin Patch', biome: 'farm', kind: 'farm', x: -265, z: 175, r: 55, tier: 'quiet', recipe: 'pumpkins' },
  { name: 'Mossy Mill', biome: 'forest', kind: 'town', x: -470, z: -160, r: 58, tier: 'normal', recipe: 'mill' },
  { name: 'Pinewood Plaza', biome: 'forest', kind: 'town', x: 270, z: -335, r: 64, tier: 'normal', recipe: 'plaza' },
  { name: 'Castle Phortress', biome: 'meadow', kind: 'outpost', x: -240, z: -205, r: 52, tier: 'hot', recipe: 'castle' },
  { name: 'Breezy Bluffs', biome: 'meadow', kind: 'town', x: 175, z: -215, r: 58, tier: 'quiet', recipe: 'bluffs' },
  { name: 'Sunny Shacks', biome: 'beach', kind: 'town', x: 560, z: 110, r: 52, tier: 'quiet', recipe: 'beach' },
  { name: 'Pirate Cove', biome: 'beach', kind: 'outpost', x: -15, z: 585, r: 48, tier: 'normal', recipe: 'pirate' },
  { name: 'Lighthouse Point', biome: 'beach', kind: 'outpost', x: -515, z: -310, r: 40, tier: 'quiet', recipe: 'lighthouse' },
  { name: 'Rusty Yard', biome: 'beach', kind: 'town', x: 440, z: -425, r: 58, tier: 'normal', recipe: 'port' },
  { name: 'Splashy Lake', biome: 'meadow', kind: 'outpost', x: -215, z: -25, r: 62, tier: 'quiet', recipe: 'lake' },
  { name: 'Crater Cove', biome: 'volcano', kind: 'town', x: -330, z: 520, r: 50, tier: 'quiet', recipe: 'cove' },
];

export const LANDMARKS = [
  { name: 'Gas Station', x: -195, z: 80, r: 22, recipe: 'gas' },
  { name: 'Gas Station', x: 270, z: -125, r: 22, recipe: 'gas' },
  { name: 'Gas Station', x: 105, z: 255, r: 22, recipe: 'gas' },
  { name: 'Gas Station', x: -340, z: -95, r: 22, recipe: 'gas' },
  { name: 'Snowy Campsite', x: -445, z: -430, r: 22, recipe: 'camp' },
  { name: 'Forest Campsite', x: 420, z: -255, r: 22, recipe: 'camp' },
  { name: 'Swamp Campsite', x: -250, z: 500, r: 22, recipe: 'camp' },
  { name: 'Desert Campsite', x: 575, z: -30, r: 22, recipe: 'camp' },
  { name: 'Radio Tower', x: 5, z: -390, r: 18, recipe: 'radio' },
  { name: 'Radio Tower', x: 480, z: 385, r: 18, recipe: 'radio' },
  { name: 'Radio Tower', x: -565, z: -30, r: 18, recipe: 'radio' },
  { name: 'Phun Stadium', x: 265, z: 90, r: 36, recipe: 'stadium' },
  { name: 'Roadside Motel', x: 305, z: 205, r: 26, recipe: 'motel' },
  { name: 'Volcano Lookout', x: -270, z: 395, r: 18, recipe: 'lookout' },
  { name: 'Junkyard', x: -110, z: -135, r: 26, recipe: 'junkyard' },
];

/** Roads that must exist (besides the spanning tree): mostly bridges over the river. */
export const LINKS = [
  ['Tilty Towers', 'Phun Stadium'], ['Breezy Bluffs', 'Junkyard'], ['Treetop Town', 'Cactus Canyon'],
  ['Retail Rumble', 'Roadside Motel'], ['Pinewood Plaza', 'Polar Palace'],
];

/** The layout for a map of this size (scaled copies; the 1.6 km layout when size is 1600). */
export function layoutFor(size) {
  const k = size / 1600;
  const sk = Math.sqrt(k);
  const P = (p) => ({ ...p, x: p.x * k, z: p.z * k });
  const f = FEATURES;
  return {
    k,
    seeds: BIOME_SEEDS.map(P),
    peak: { x: f.peak.x * k, z: f.peak.z * k, r: f.peak.r * k, h: f.peak.h * sk },
    volcano: { ...f.volcano, x: f.volcano.x * k, z: f.volcano.z * k, r: f.volcano.r * k, h: f.volcano.h * sk, crater: f.volcano.crater * (0.5 + 0.5 * k) },
    river: { ...f.river, pts: f.river.pts.map(([x, z]) => [x * k, z * k]) },
    lake: { ...f.lake, x: f.lake.x * k, z: f.lake.z * k, r: f.lake.r * (0.5 + 0.5 * k), island: f.lake.island },
    places: PLACES.map((p) => ({ ...P(p), r: p.r * (0.55 + 0.45 * k) })),
    landmarks: LANDMARKS.map((p) => ({ ...P(p), r: p.r * (0.7 + 0.3 * k) })),
    links: LINKS,
  };
}
