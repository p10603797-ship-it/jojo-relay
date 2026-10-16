// Draws the island as a PNG for reviewing the map: biome colours with hillshade, water, roads and
// bridges, the river, building footprints, pads, lava, and every place name with its tier.
//   node tools/mapviz.mjs [out.png] [--size 1200] [--px 2048] [--seed N]
// Pure Node (zlib for the PNG), no browser needed.
import fs from 'fs';
import zlib from 'zlib';
import { generateWorld } from '../public/shared/worldgen.js';
import { MAP } from '../public/shared/constants.js';
import { BIOMES } from '../public/shared/world/keys.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const out = args.find((a) => a.endsWith('.png')) || 'mapviz.png';
const PX = +opt('--px', 2048);
const size = +opt('--size', MAP.size);
const seed = +opt('--seed', MAP.seed);

const t0 = performance.now();
const w = generateWorld(seed, { size });
const genMs = performance.now() - t0;

const BIOME_RGB = {
  ocean: [40, 110, 170], beach: [232, 214, 158], meadow: [128, 190, 84], forest: [52, 122, 62], farm: [196, 186, 98],
  city: [150, 150, 160], snow: [238, 244, 250], desert: [226, 182, 118], mesa: [196, 110, 70], jungle: [36, 112, 52],
  swamp: [84, 104, 64], volcano: [74, 64, 62],
};
const SURF_RGB = {
  grass: null, dirt: [140, 108, 76], sand: [228, 208, 150], rock: [128, 124, 120], snow: [244, 248, 252], ice: [190, 225, 245],
  redsand: [206, 120, 76], strata: [176, 96, 64], mud: [92, 80, 58], junglefloor: null, ash: [60, 56, 56], lava: [255, 96, 20],
  asphalt: [70, 72, 78], cobble: [150, 140, 128], field: [150, 112, 72], wheat: [226, 196, 96],
};
const SURFACES = w.surfaceKeys || null;

const img = new Uint8Array(PX * PX * 3);
const put = (x, y, r, g, b, a = 1) => {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= PX || y >= PX) return;
  const i = (y * PX + x) * 3;
  img[i] = img[i] * (1 - a) + r * a; img[i + 1] = img[i + 1] * (1 - a) + g * a; img[i + 2] = img[i + 2] * (1 - a) + b * a;
};
const toPx = (x) => (x + w.half) / w.size * PX;

// terrain
for (let py = 0; py < PX; py++) {
  for (let px = 0; px < PX; px++) {
    const x = -w.half + (px + 0.5) / PX * w.size, z = -w.half + (py + 0.5) / PX * w.size;
    const h = w.heightAt(x, z);
    let c;
    if (h < 0) {
      const t = Math.min(1, -h / 12);
      c = [70 - 40 * t, 175 - 75 * t, 205 - 45 * t];
    } else {
      const bk = w.biomeAt(x, z);
      c = (BIOME_RGB[bk] || [255, 0, 255]).slice();
      const sk = w.surfaceKeyAt ? w.surfaceKeyAt(x, z) : null;
      const sc = sk && SURF_RGB[sk];
      if (sc) c = [c[0] * 0.25 + sc[0] * 0.75, c[1] * 0.25 + sc[1] * 0.75, c[2] * 0.25 + sc[2] * 0.75];
      const dx = w.heightAt(x + 2, z) - w.heightAt(x - 2, z), dz = w.heightAt(x, z + 2) - w.heightAt(x, z - 2);
      const lit = Math.max(0.45, Math.min(1.4, 1 - (dx + dz) * 0.09)) * (0.86 + Math.min(0.3, h / 300));
      c = c.map((v) => v * lit);
    }
    const i = (py * PX + px) * 3;
    img[i] = Math.max(0, Math.min(255, c[0])); img[i + 1] = Math.max(0, Math.min(255, c[1])); img[i + 2] = Math.max(0, Math.min(255, c[2]));
  }
}

// polylines
function line(pts, rgb, widthPx, alpha = 1) {
  for (let s = 0; s < pts.length - 1; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const x0 = toPx(ax), y0 = toPx(az), x1 = toPx(bx), y1 = toPx(bz);
    const L = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
    for (let t = 0; t <= L; t += 0.5) {
      const x = x0 + (x1 - x0) * t / L, y = y0 + (y1 - y0) * t / L;
      const r = widthPx / 2;
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) if (ox * ox + oy * oy <= r * r + 0.5) put(x + ox, y + oy, ...rgb, alpha);
    }
  }
}
const mpp = PX / w.size;
for (const r of w.rivers || []) {
  // the river's centre line, drawn only where it runs through the island
  for (let i = 0; i < r.pts.length - 1; i++) {
    const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
    if (w.heightAt((ax + bx) / 2, (az + bz) / 2) < -3) continue;
    line([r.pts[i], r.pts[i + 1]], [60, 150, 210], Math.max(2, r.w * 0.6 * mpp), 0.5);
  }
}
for (const r of w.roads || []) {
  const pts = r.pts.map((p) => [p[0], p[1]]);
  const col = r.bridge ? [140, 90, 50] : r.kind === 'dirt' ? [170, 130, 90] : [60, 60, 66];
  line(pts, col, Math.max(2, r.w * mpp), 0.95);
  if (!r.bridge && r.kind !== 'dirt' && r.w > 6) line(pts, [240, 220, 120], 1, 0.7);
}
// footprints
for (const h of w.houses) {
  const x0 = toPx(h.x - h.hx), x1 = toPx(h.x + h.hx), y0 = toPx(h.z - h.hz), y1 = toPx(h.z + h.hz);
  const col = h.archetype === 'bridge' ? [120, 80, 40] : [250, 250, 250];
  for (let y = Math.floor(y0); y <= y1; y++) for (let x = Math.floor(x0); x <= x1; x++) {
    const edge = x - x0 < 1 || x1 - x < 1 || y - y0 < 1 || y1 - y < 1;
    put(x, y, ...(edge ? [30, 30, 30] : col), edge ? 0.9 : 0.85);
  }
}
// trees (tiny dots), pads, lava
for (const o of w.objects) {
  if (o.kind === 'tree') put(toPx(o.x), toPx(o.z), 20, 60, 25, 0.55);
}
for (const l of w.lava || []) {
  const r = l.r * mpp;
  for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) if (ox * ox + oy * oy <= r * r) put(toPx(l.x) + ox, toPx(l.z) + oy, 255, 110, 20, 0.8);
}
const PADC = { launch: [80, 160, 255], geyser: [240, 240, 255], mushroom: [255, 60, 200] };
for (const p of w.pads || []) {
  const c = PADC[p.kind] || [255, 0, 255];
  for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) if (ox * ox + oy * oy <= 16) put(toPx(p.x) + ox, toPx(p.z) + oy, ...(ox * ox + oy * oy > 9 ? [0, 0, 0] : c));
}

// text: a 5 x 7 bitmap font
const FONT = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001110011010110011100011000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111', ' ': '00000000000000000000000000000000000',
  "'": '00100001000000000000000000000000000', '-': '00000000000000011111000000000000000', '#': '01010111110101011111010100000000000',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11110000010000101110000010000111110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100', '.': '00000000000000000000000000110001100', ':': '00000011000110000000011000110000000',
  '/': '00001000010001000100010001000010000', '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000',
  ',': '00000000000000000000001100010001000', '%': '11001110010001000100010001001110011',
};
function text(str, cx, cy, scale, rgb, shadow = true) {
  str = String(str).toUpperCase();
  const wpx = str.length * 6 * scale;
  let x = cx - wpx / 2;
  for (const ch of str) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r * 5 + c] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        if (shadow) for (const [ox, oy] of [[1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]]) put(x + c * scale + sx + ox * Math.max(1, scale / 2), cy + r * scale + sy + oy * Math.max(1, scale / 2), 0, 0, 0, 0.8);
      }
    }
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r * 5 + c] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(x + c * scale + sx, cy + r * scale + sy, ...rgb);
    }
    x += 6 * scale;
  }
}
const TIER_RGB = { hot: [255, 200, 60], normal: [255, 255, 255], quiet: [170, 220, 255] };
const sc = Math.max(1, Math.round(PX / 1024));
for (const g of w.regions) {
  const x = toPx(g.x), y = toPx(g.z);
  const ring = g.r * mpp;
  for (let a = 0; a < 360; a += 1) put(x + Math.cos(a / 57.3) * ring, y + Math.sin(a / 57.3) * ring, ...(g.named ? [255, 255, 255] : [200, 200, 200]), g.named ? 0.5 : 0.3);
  if (g.named) {
    text(g.name, x, y - 9 * sc, 2 * sc, TIER_RGB[g.tier] || [255, 0, 255]);
    text(g.tier, x, y + 9 * sc, sc, TIER_RGB[g.tier] || [255, 0, 255]);
  } else text(g.name, x, y - 4 * sc, sc, [230, 230, 230]);
}
// legend
const counts = {};
for (const o of w.objects) counts[o.kind] = (counts[o.kind] || 0) + 1;
const info = [
  `PHORTNITE ISLAND V${w.version}  ${w.size} M  SEED ${w.seed}  GEN ${genMs.toFixed(0)} MS`,
  `BUILDINGS ${w.houses.length}  PARTS ${counts.part || 0}  TREES ${counts.tree || 0}  ROCKS ${counts.rock || 0}  PROPS ${counts.prop || 0}  DECOR ${counts.decor || 0}`,
  `CHESTS ${w.chests.length}  LOOT ${w.lootSpots.length}  PADS ${(w.pads || []).length}  ROADS ${(w.roads || []).length}  REGIONS ${w.regions.length}  CHECKSUM ${w.checksum}`,
];
info.forEach((s, i) => { for (let y = 0; y < 10 * sc; y++) for (let x = 0; x < PX; x++) put(x, (6 + i * 11) * sc + y - 2, 0, 0, 0, 0.35); text(s, PX / 2, (6 + i * 11) * sc, sc, [255, 255, 255], false); });

// PNG
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((PX * 3 + 1) * PX);
for (let y = 0; y < PX; y++) {
  raw[y * (PX * 3 + 1)] = 0;
  Buffer.from(img.buffer, y * PX * 3, PX * 3).copy(raw, y * (PX * 3 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(PX, 0); ihdr.writeUInt32BE(PX, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${PX} px, world ${w.size} m generated in ${genMs.toFixed(0)} ms`, JSON.stringify(counts));
const land = {};
let landN = 0;
for (let i = 0; i < w.N * w.N; i++) if (w.heights[i] > 0) { landN++; const b = BIOMES[w.biome ? w.biome[i] : 2]; land[b] = (land[b] || 0) + 1; }
console.log('land km2', (landN * w.cell * w.cell / 1e6).toFixed(2), 'biome % of land', Object.fromEntries(Object.entries(land).map(([k, v]) => [k, +(100 * v / landN).toFixed(1)])));
