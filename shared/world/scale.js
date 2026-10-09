// How big the island is and how far the bus and the drop reach. constants.js re-exports MAP and
// BUS, and PLAYER's skydive / glide fields come from DROP.
//
// The 1.6 km biome island (world version 2). generateWorld(seed, { size: 1200 }) builds a smaller
// copy of the same island (the integration fallback); to ship that one, set MAP to
// { size: 1200, res: 300, islandRadius: 480 } and re-pin the checksum in test/world.test.mjs.
export const MAP = {
  seed: 20261008,                     // one hand-tuned island, like the real thing
  size: 1600,                         // metres, terrain spans [-800, 800]
  res: 400,                           // terrain cells per side (4 m cells, N = 401 grid points)
  islandRadius: 640,                  // the coast wanders about 20 % around this
  waterY: 0,                          // the sea, the river and the lake all sit at y = 0
};

// The bus crosses 1.5 km in about 36 s and pushes everyone out at 90 % of the way.
export const BUS = { height: 230, speed: 42, length: 1500, forceDrop: 0.9 };

// With these numbers (and mover.js's skydive / glide easing) a drop from the bus reaches about
// 420 m sideways from the bus line over low ground and 400 m over ground at 20 m
// (test/world.test.mjs simulates it). The plan's first numbers (fall 26, sideways 30, glide 7 / 17
// from 70 m) only reach about 333 m, so the skydive is a bit floatier and the glide flatter.
export const DROP = {
  skydiveFall: 24,                    // m/s down while skydiving (skydiveDive when diving)
  skydiveDive: 50,
  skydiveSpeed: 34,                   // m/s sideways
  glideFall: 6.5,
  glideSpeed: 19,
  glideHeight: 80,                    // glider deploys automatically this far above ground
};
