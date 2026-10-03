// Wrap procedural texture data into three.js textures (colour + normal maps).
import * as THREE from 'three';
import * as G from './texgen.js';

function normalFromHeight(img, strength) {
  const { size, height } = img;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yu = ((y - 1 + size) % size) * size, yd = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size, xr = (x + 1) % size;
      const dx = (height[yc + xr] - height[yc + xl]) * strength;
      const dy = (height[yd + x] - height[yu + x]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      const i = (yc + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

let maxAniso = 4;

export function dataTexture(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function pair(img, normalStrength) {
  return {
    map: dataTexture(img.color, img.size, true),
    normal: dataTexture(normalFromHeight(img, normalStrength), img.size, false),
  };
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/** Generate every texture the game uses. onProgress(0..1). */
export async function buildTextures(renderer, onProgress = () => {}, lowMem = false) {
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const S = lowMem ? 256 : 512;
  const jobs = [
    ['grass', () => pair(G.grass(S), 2.2)],
    ['sand', () => pair(G.sand(S), 2.0)],
    ['rock', () => pair(G.rock(S), 4.0)],
    ['dirt', () => pair(G.dirt(S), 3.0)],
    ['planks', () => pair(G.planks(S, 5), 3.0)],
    ['woodBuild', () => pair(G.planks(S, 21, { frame: 0.075, base: 0xc58a4f }), 3.5)],
    ['brick', () => pair(G.brick(S, 6), 4.0)],
    ['brickBuild', () => pair(G.brick(S, 22, { frame: 0.075, base: 0xa7a39c }), 4.0)],
    ['metal', () => pair(G.metal(S, 7), 3.0)],
    ['metalBuild', () => pair(G.metal(S, 23, { frame: 0.075, base: 0x9aa8b5 }), 3.0)],
    ['siding', () => pair(G.siding(S), 3.0)],
    ['shingles', () => pair(G.shingles(S), 3.0)],
    ['concrete', () => pair(G.concrete(S), 2.0)],
    ['bark', () => pair(G.bark(256), 3.0)],
    ['foliage', () => pair(G.foliage(256), 3.0)],
    ['noise', () => {
      const img = G.noiseTile(256, 13, 4, 5);
      return { map: dataTexture(img.color, 256, false), normal: dataTexture(normalFromHeight(img, 6), 256, false) };
    }],
  ];
  const T = {};
  for (let i = 0; i < jobs.length; i++) {
    const [name, fn] = jobs[i];
    T[name] = fn();
    onProgress((i + 1) / jobs.length);
    await nextFrame();
  }
  return T;
}

/** Small canvas-made sprites for particles & UI-ish effects. */
export function spriteTextures() {
  const mk = (size, draw) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const soft = mk(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
  const smoke = mk(128, (g, s) => {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * s * 0.22;
      const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
      const rad = s * (0.12 + Math.random() * 0.16);
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, s, s);
    }
  });
  const hole = mk(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(10,8,6,1)');
    grd.addColorStop(0.25, 'rgba(20,16,12,0.95)');
    grd.addColorStop(0.45, 'rgba(40,32,24,0.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
  return { soft, smoke, hole };
}
