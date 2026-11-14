// Deterministic island generator. Produces plain data only (no rendering) so both the
// browser and the server agree on object ids, loot spots and chest positions.
// The pipeline lives in shared/world/ (index.js runs it; see its stage list).
//
// Determinism: decisions may only use + - * / floor sqrt and rng.js (mulberry32, Perlin), so
// Node and every browser build the same island; the checksum is compared between them.
//
// ================================================================== THE WORLD CONTRACT
// generateWorld(seed = MAP.seed, { size }?) returns plain data that the Room, the renderer, bots
// and modes read. Names (biomes, surfaces, species, looks, pads, tiers) come from
// shared/world/keys.js; sizes from shared/world/scale.js (MAP). { size: 1200 } builds the smaller
// copy of the island (the integration fallback).
//
// Terrain
//   seed, version (2 = the 1.6 km biome island), size (m), res (cells per side), cell (m),
//   half (= size/2), N (= res + 1 grid points per side), heights: Float32Array(N*N), row-major
//   (index iz*N + ix, point (-half + ix*cell, -half + iz*cell)); heightAt(x, z): the triangulated
//   height (the same triangles as the physics heightfield); islandRadius
//   biome, biome2: Uint8Array(N*N) of BIOMES indexes laid out like heights (primary biome and the
//     runner-up); blend: Uint8Array(N*N), the primary biome's weight 128..255 (255 = pure)
//   surface: Uint8Array(N*N) of SURFACES indexes (the dominant ground layer)
//   biomeAt(x, z) -> BIOMES key; surfaceKeyAt(x, z) -> SURFACES key (nearest grid point)
//   roadMask: Uint8Array(N*N): 0 none, 1 dirt road, 2 paved (asphalt) road or street
// Places
//   regions: [{ id, name, x, z, y, r, biome, kind, tier, named, recipe }]: the 26 named places
//     (named true, first) and about 15 landmarks (named false); id = index; kind: 'city' | 'town' |
//     'farm' | 'outpost' | 'landmark'; tier: a TIERS key; recipe: the layout ('downtown', 'gas', ...)
//   regionAt(x, z): the smallest region whose circle holds the point (named first), or null
//   pois: [{ name, x, z, y, r, type }] (regions[i] is pois[i]; type = kind)
//   spawnPoints: [{ x, y, z, region }]: open ground for spawns (respawn, sky / ground drops):
//     at least 8 around every named place (region = its id), plus a 48 m scatter over the whole
//     island (region -1); y = ground height
//   spawns: [{ x, z }]: warm-up spots around the most central place
//   mountain: { x, z }: the snowy peak (the menu camera looks from there)
// Objects (index = id; destroyed ids are shared over the network)
//   objects: [{ id, kind, x, y, z, mat, hp, … }]; hp 0 = indestructible; mat: wood | stone | metal
//     kind 'part' (buildings): house, look (a LOOKS key, or a LOOK_ALIASES key), paint, shape 'box'
//       (hx, hy, hz half sizes; ax / ang: tilted about the world x or z axis by ang radians) or
//       'prism' (pts: 6 points = two triangles a b c / d e f); tilted boxes also carry bb, their
//       exact world bounds [x0, y0, z0, x1, y1, z1]; optional tint (0xRRGGBB colour to use instead
//       of the look's default), sign (text on a panel), glow (1 = emissive: lantern, beacon)
//     kind 'prop': type (props.js PROP_TYPES: car, container, crate, lamp, bench, fence, hay,
//       stall, fountain, sign, pump, tent, hydrant, dumpster), hx, hy, hz (box collider half
//       sizes, y = box centre), yaw (0 or a quarter turn), color?, text? (sign), wreck?
//     kind 'decor' (no collider, not solid): type (props.js DECOR_TYPES), s (scale), yaw; y = ground
//     kind 'tree': type (legacy 0 pine, 1 oak, 2 palm), species (a SPECIES key), s (scale), yaw
//     kind 'rock': type 0-2, s, yaw (tint them by biomeAt(x, z))
//   objectsNear(x, z, r, fn): calls fn(o) for every object whose centre is within r metres of
//     (x, z) (a 32 m hash, cell by cell); fn returning true stops the walk (objectsNear then
//     returns true)
//   chunks: the 64 m chunk index { size, nx, nz, x0, z0, start, ids, of(x, z), forEach(c, fn) }
//     (ids of chunk c = cz*nx + cx are ids[start[c] .. start[c+1]))
//   solidNear(x, y, z, destroyed?, pad?): is the point touching an intact solid object (parts,
//     props, rocks)?
//   houses: [{ id, x, z, y, base, rot, w, d, hx, hz, floors, style, roof, paint, poi, archetype,
//     region, tier, top, levels, stairs, doors, bounds, open? }]: one per building; archetype a
//     key of ARCHETYPES (shared/world/buildings.js: house, apartment, shop, skyscraper, gas,
//     warehouse, barn, silo, windmill, cabin, lodge, adobe, saloon, motel, lighthouse, ship, temple,
//     castle, icecastle, watchtower, clocktower, pier, bridge, stadium, stilt, treehouse, lair,
//     shed, mall, shack, mine, radio); region = a regions id or -1; y = floor-0 height;
//     levels: storey floor heights; stairs: [[x0, z0, y0, x1, z1, y1, width]] ramp centrelines
//     (walking surface, at most 45 degrees); doors: [[x, z, y, nx, nz, height, width]] ground doors
//     (threshold, outward normal, at least 2.35 m tall); top: highest point; bounds: [x0, z0, x1,
//     z1] of its parts; open: true for structures without doors (towers, piers, bridges, ship,
//     temple, stadium, stilt houses); pumps: [[x, z], ...] at gas stations
// Loot
//   chests: [{ x, y, z, yaw, tier }]; lootSpots: [{ x, y, z, ground?, tier }] (tier: a TIERS key:
//     hot places have about one chest per building and floor loot on every storey)
//   barrels: [{ x, y, z }] (physics props)
// Features
//   roads: [{ kind: 'road' | 'dirt' | 'street', w, bridge, pts: [[x, z, y], ...], from?, to?,
//     region?, house? }]: centrelines with the road surface height; bridge pieces are straight
//     (2 points, y = deck height) and house = the bridge building's id
//   rivers: [{ pts: [[x, z], ...], w0, w1, w, bed }]; lakes: [{ x, z, r, y, island: { x, z, r } }]
//     (all water is the y = 0 plane; beds are carved below it)
//   pads: [{ id, kind (a PADS key), x, y, z, region, power, roof? }]: launch pads, geysers, bounce
//     mushrooms (y = the surface they stand on)
//   lava: [{ x, z, r, y }]: lava discs (the crater pool and two flank pools) at height y
// checksum: compared between the Room and every client (welcome.checksum); covers objects, loot,
//   places, roads, pads, lava and the height / biome / surface grids
export { generateWorld, WORLD_VERSION } from './world/index.js';
export const POI_NAMES = ['Tilty Towers', 'Retail Rumble', 'Frosty Peak', 'Chilly Chalets', 'Polar Palace', 'Dusty Depot', 'Mesa Mayhem',
  'Phunny Palms', 'Cactus Canyon', 'Slurpy Swamp', 'Temple of Phun', 'Treetop Town', 'Lava Lair', 'Magma Mines', 'Phunny Farm',
  'Pumpkin Patch', 'Mossy Mill', 'Pinewood Plaza', 'Castle Phortress', 'Breezy Bluffs', 'Sunny Shacks', 'Pirate Cove',
  'Lighthouse Point', 'Rusty Yard', 'Splashy Lake', 'Crater Cove'];
