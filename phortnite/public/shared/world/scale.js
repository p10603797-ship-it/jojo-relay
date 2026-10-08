// How big the island is and how far the bus and the drop reach. constants.js re-exports MAP and
// BUS, and PLAYER's skydive / glide fields come from DROP.
export const MAP = {
  seed: 20261003,                     // one hand-tuned island, like the real thing
  size: 640,                          // metres, terrain spans [-320, 320]
  res: 160,                           // terrain cells per side (4 m cells)
  islandRadius: 268,
  waterY: 0,
};

export const BUS = { height: 135, speed: 30, length: 680, forceDrop: 0.84 };

export const DROP = {
  skydiveFall: 34,                    // m/s down while skydiving (skydiveDive when diving)
  skydiveDive: 50,
  skydiveSpeed: 22,                   // m/s sideways
  glideFall: 8,
  glideSpeed: 15,
  glideHeight: 55,                    // glider deploys automatically this far above ground
};
