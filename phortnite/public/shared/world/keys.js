// Names the world data uses (see the contract at the top of shared/worldgen.js). The order of
// each list is part of the data format: grids store indexes into BIOMES and SURFACES, and the
// renderer's texture arrays follow SURFACES and LOOKS. Lists may only grow at their end.

/** Biome of a terrain cell (data.biome grid value = index). */
export const BIOMES = ['ocean', 'beach', 'meadow', 'forest', 'farm', 'city', 'snow', 'desert', 'mesa', 'jungle', 'swamp', 'volcano'];

/** Ground surface of a terrain cell (data.surface grid value = index; texture-array order). */
export const SURFACES = ['grass', 'dirt', 'sand', 'rock', 'snow', 'ice', 'redsand', 'strata', 'mud', 'junglefloor', 'ash', 'lava', 'asphalt', 'cobble', 'field', 'wheat'];

/** Tree and plant species (tree objects carry species; their legacy type is SPECIES_TYPE[species]). */
export const SPECIES = ['pine', 'oak', 'palm', 'birch', 'snowpine', 'cactus', 'jungle', 'swamp', 'dead', 'bush'];

/** Legacy tree type (0 pine, 1 oak, 2 palm) for every species: the closest of today's three trees. */
export const SPECIES_TYPE = {
  pine: 0, oak: 1, palm: 2, birch: 1, snowpine: 0, cactus: 2, jungle: 2, swamp: 1, dead: 1, bush: 1,
};

/** Building looks (part.look; texture-array order). */
export const LOOKS = [
  'siding', 'brick', 'metalwall', 'roof', 'floor', 'trim', 'foundation', 'glass', 'stucco', 'adobe',
  'logs', 'planks', 'corrugated', 'rooftile', 'shingle', 'sandstone', 'concrete', 'panel', 'ice', 'castle',
];

/** Older part looks that are not LOOKS keys, and the LOOKS key that stands in for them. */
export const LOOK_ALIASES = { slab: 'concrete' };

/** Launch pad kinds (data.pads[].kind). */
export const PADS = ['launch', 'geyser', 'mushroom'];

/** Loot tiers of places, loot spots and chests. */
export const TIERS = ['hot', 'normal', 'quiet'];

/** Footstep sound kind for each surface (the kinds Sfx.step knows: grass, dirt, sand, stone, snow, wood, metal). */
export const STEP_SOUND = {
  grass: 'grass', dirt: 'dirt', sand: 'sand', rock: 'stone', snow: 'snow', ice: 'stone', redsand: 'sand', strata: 'stone',
  mud: 'dirt', junglefloor: 'grass', ash: 'dirt', lava: 'stone', asphalt: 'stone', cobble: 'stone', field: 'dirt', wheat: 'grass',
};
