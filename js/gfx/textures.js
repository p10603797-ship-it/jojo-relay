// Wrap procedural texture data into three.js textures (colour + normal maps), and the two texture
// arrays the big map draws with: every ground surface (terrain splat, roads) and every building
// look (one material for all buildings).
//
// The arrays start out flat (each layer its average colour, so nothing is black) and a worker paints
// the real layers in the background with texgen.js, the ones the world uses first. Boot never
// waits for them: the lobby shows while the island's textures fill in.
import * as THREE from 'three';
import * as G from './texgen.js';
import { SURFACES, LOOKS, LOOK_ALIASES } from '../../shared/world/keys.js';

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

// ------------------------------------------------------------------ texture arrays
/** Surface layers: SURFACES in order, then extras. 'asphalt' on the terrain has no lane lines; road ribbons use 'asphaltLines'. */
export const SURFACE_LAYERS = [...SURFACES, 'asphaltLines'];
const SURFACE_GEN = { asphalt: 'asphaltPlain', asphaltLines: 'asphalt' };
/** Looks that share a texture with another look (the same generator): one array layer for both. */
const LOOK_SAME = { trim: 'concrete', foundation: 'concrete', ...LOOK_ALIASES };
/** Look layers: every LOOKS key that has a texture of its own. */
export const LOOK_LAYERS = LOOKS.filter((k) => !Object.prototype.hasOwnProperty.call(LOOK_SAME, k));
const LOOK_INDEX = new Map(LOOK_LAYERS.map((k, i) => [k, i]));
const SURFACE_INDEX = new Map(SURFACE_LAYERS.map((k, i) => [k, i]));

/** Array layer of a look key (aliases and unknown looks fall back to concrete). */
export function lookLayer(key) {
  const k = Object.prototype.hasOwnProperty.call(LOOK_SAME, key) ? LOOK_SAME[key] : key;
  const i = LOOK_INDEX.get(k);
  return i === undefined ? LOOK_INDEX.get('concrete') : i;
}

/** Array layer of a surface key (unknown keys fall back to grass). */
export function surfaceLayer(key) {
  const i = SURFACE_INDEX.get(key);
  return i === undefined ? 0 : i;
}

/** Normal-map strength per layer key (like the old per-texture strengths). */
const STRENGTH = {
  grass: 2.2, sand: 2.0, rock: 4.0, dirt: 3.0, snow: 1.6, ice: 2.0, redsand: 2.0, strata: 4.0, mud: 2.4, junglefloor: 2.6,
  ash: 2.6, lava: 3.0, asphalt: 1.4, asphaltLines: 1.4, cobble: 4.0, field: 2.6, wheat: 2.4, glass: 1.0,
};

// The worker: texgen.js has no imports, so a module worker built from a blob can import it by URL.
const WORKER_SRC = (url) => `
import * as G from '${url}';
function pack(img, key, nsize, strength) {
  const { size, color, height } = img;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < height.length; i++) { const h = height[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  const k = hi > lo ? 255 / (hi - lo) : 0;
  const rgba = new Uint8Array(size * size * 4);
  rgba.set(color);
  const em = img.emissive;
  for (let i = 0; i < height.length; i++) rgba[i * 4 + 3] = em ? em[i] : (height[i] - lo) * k;
  // normals at nsize (a box-filtered copy of the full-size normals)
  const f = size / nsize, nrm = new Uint8Array(nsize * nsize * 4);
  const hs = strength * (hi > lo ? 1 : 0);
  for (let y = 0; y < nsize; y++) for (let x = 0; x < nsize; x++) {
    let sx = 0, sy = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const px = x * f + i, py = y * f + j;
      const xl = (px - 1 + size) % size, xr = (px + 1) % size, yu = (py - 1 + size) % size, yd = (py + 1) % size;
      sx += height[py * size + xr] - height[py * size + xl];
      sy += height[yd * size + px] - height[yu * size + px];
    }
    const dx = -sx / (f * f) * hs, dy = -sy / (f * f) * hs;
    const l = Math.sqrt(dx * dx + dy * dy + 1);
    const o = (y * nsize + x) * 4;
    nrm[o] = (dx / l * 0.5 + 0.5) * 255; nrm[o + 1] = (dy / l * 0.5 + 0.5) * 255; nrm[o + 2] = (1 / l * 0.5 + 0.5) * 255; nrm[o + 3] = 255;
  }
  return { rgba, nrm };
}
self.onmessage = (e) => {
  const { id, gen, size, nsize, strength } = e.data;
  const img = G.layerTexture(gen, size);
  const { rgba, nrm } = pack(img, gen, nsize, strength);
  self.postMessage({ id, size: img.size, nsize, rgba, nrm }, [rgba.buffer, nrm.buffer]);
};
`;

/** Pack a generated image like the worker does (main-thread fallback). */
function packMain(img, nsize, strength) {
  const { size, color, height } = img;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < height.length; i++) { const h = height[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  const k = hi > lo ? 255 / (hi - lo) : 0;
  const rgba = new Uint8Array(size * size * 4);
  rgba.set(color);
  for (let i = 0; i < height.length; i++) rgba[i * 4 + 3] = img.emissive ? img.emissive[i] : (height[i] - lo) * k;
  const full = normalFromHeight(img, strength);
  const f = size / nsize, nrm = new Uint8Array(nsize * nsize * 4);
  for (let y = 0; y < nsize; y++) {
    for (let x = 0; x < nsize; x++) {
      const s = ((y * f) * size + x * f) * 4, o = (y * nsize + x) * 4;
      nrm[o] = full[s]; nrm[o + 1] = full[s + 1]; nrm[o + 2] = full[s + 2]; nrm[o + 3] = 255;
    }
  }
  return { rgba, nrm };
}

/** Fill bytes [o, o + len) with one RGBA colour (doubling copies: fast for big layers). */
function fillLayer(a, o, len, r, g, b, al) {
  a[o] = r; a[o + 1] = g; a[o + 2] = b; a[o + 3] = al;
  for (let n = 4; n < len; n *= 2) a.copyWithin(o + n, o, o + Math.min(n, len - n));
}

function arrayTexture(data, size, depth, srgb) {
  const t = new THREE.DataArrayTexture(data, size, size, depth);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * One texture array pair (albedo + height in alpha, and normals at half or a quarter of the size)
 * for a list of layer keys. Layers start as their average colour; paint(layer, rgba, nrm) fills one in.
 */
class LayerArray {
  constructor(keys, size, gens, normalShift = 1) {
    this.keys = keys;
    this.size = size;
    this.nsize = Math.max(16, size >> normalShift);
    this.gens = gens;
    const n = keys.length;
    this.albedo = arrayTexture(new Uint8Array(size * size * 4 * n), size, n, true);
    this.normal = arrayTexture(new Uint8Array(this.nsize * this.nsize * 4 * n), this.nsize, n, false);
    this.done = new Uint8Array(n);
    this.dirty = false;
    // flat start: each layer's average colour from a tiny copy (a few ms for every layer)
    const A = this.albedo.image.data, N = this.normal.image.data;
    const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    this.avg = [];        // each layer's average colour (linear), e.g. for far-away proxies
    for (let l = 0; l < n; l++) {
      const tiny = G.layerTexture(gens[l], 16);
      let r = 0, g = 0, b = 0;
      const px = 16 * 16;
      for (let i = 0; i < px; i++) { r += tiny.color[i * 4]; g += tiny.color[i * 4 + 1]; b += tiny.color[i * 4 + 2]; }
      r /= px; g /= px; b /= px;
      this.avg.push([lin(r), lin(g), lin(b)]);
      fillLayer(A, l * size * size * 4, size * size * 4, r, g, b, keys[l] === 'lava' ? 200 : 128);
      fillLayer(N, l * this.nsize * this.nsize * 4, this.nsize * this.nsize * 4, 128, 128, 255, 255);
    }
  }

  paint(layer, rgba, nrm) {
    const S = this.size * this.size * 4, NS = this.nsize * this.nsize * 4;
    if (rgba.length !== S || nrm.length !== NS || !this.albedo.image.data) return;
    this.albedo.image.data.set(rgba, layer * S);
    this.normal.image.data.set(nrm, layer * NS);
    this.albedo.addLayerUpdate(layer);
    this.normal.addLayerUpdate(layer);
    this.done[layer] = 1;
    this.dirty = true;
  }

  /** Upload painted layers (call at most a few times a second). */
  flush() {
    if (!this.dirty) return false;
    this.dirty = false;
    this.albedo.needsUpdate = true;
    this.normal.needsUpdate = true;
    return true;
  }

  get complete() { return this.done.every((d) => d === 1); }

  /**
   * Every layer is painted and on the GPU: drop the JS copies of the pixels (about 20 MB per
   * array at Medium). Only when the renderer reports both textures uploaded at their current
   * version; nothing paints or re-uploads them after that.
   */
  release(renderer) {
    if (this.released || !this.complete || this.dirty || !renderer || !renderer.properties) return false;
    for (const t of [this.albedo, this.normal]) {
      const p = renderer.properties.get(t);
      if (!p || p.__version !== t.version) return false;
    }
    this.albedo.image.data = null;
    this.normal.image.data = null;
    this.released = true;
    return true;
  }
}

/**
 * The surface and look texture arrays, painted in the background.
 *   layers.surfaces / layers.looks: LayerArray { albedo, normal, keys }
 *   layers.request(kind, keys): paint these layers first (the ones the world uses)
 */
export class TextureLayers {
  constructor(lowMem, renderer = null) {
    this.renderer = renderer;
    const S = lowMem ? 256 : 512;
    // normals at a quarter of the albedo's size: the bumps are broad, and it keeps Medium under 80 MB
    this.surfaces = new LayerArray(SURFACE_LAYERS, S, SURFACE_LAYERS.map((k) => SURFACE_GEN[k] || k), 2);
    this.looks = new LayerArray(LOOK_LAYERS, S, LOOK_LAYERS, 2);
    this.queue = [];
    this.busy = 0;
    this.worker = null;
    this.lastFlush = 0;
    this.listeners = [];
    try {
      const url = new URL('./texgen.js', import.meta.url).href;
      const blob = new Blob([WORKER_SRC(url)], { type: 'text/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
      this.worker.onmessage = (e) => this.received(e.data);
      this.worker.onerror = () => this.workerFailed();
    } catch (e) {
      this.worker = null;
    }
  }

  /** Paint these layers (keys of kind 'surfaces' | 'looks') before the others. */
  request(kind, keys) {
    const A = this[kind];
    for (const k of keys) {
      const l = A.keys.indexOf(k);
      if (l >= 0 && !A.done[l] && !this.queue.some((q) => q.A === A && q.l === l)) this.queue.push({ A, l });
    }
    this.pump();
  }

  /** Paint everything still flat (after the requested layers). */
  requestAll() {
    this.request('surfaces', this.surfaces.keys);
    this.request('looks', this.looks.keys);
  }

  pump() {
    while (this.busy < 2 && this.queue.length) {
      const job = this.queue.shift();
      if (job.A.done[job.l]) continue;
      this.busy++;
      const id = this.jobs = (this.jobs || 0) + 1;
      (this.pendingJobs || (this.pendingJobs = new Map())).set(id, job);
      const msg = { id, gen: job.A.gens[job.l], size: job.A.size, nsize: job.A.nsize, strength: STRENGTH[job.A.keys[job.l]] || 3 };
      if (this.worker) {
        try { this.worker.postMessage(msg); continue; } catch (e) { this.worker = null; }
      }
      // no worker: paint on the main thread between frames
      setTimeout(() => {
        const img = G.layerTexture(msg.gen, msg.size);
        const { rgba, nrm } = packMain(img, msg.nsize, msg.strength);
        this.received({ id, rgba, nrm });
      }, 16);
    }
  }

  /** The worker could not start (old browser, blocked module): paint on the main thread instead. */
  workerFailed() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    if (this.pendingJobs) {
      for (const job of this.pendingJobs.values()) this.queue.unshift(job);
      this.pendingJobs.clear();
    }
    this.busy = 0;
    this.pump();
  }

  received(d) {
    const job = this.pendingJobs.get(d.id);
    if (!job) return;
    this.pendingJobs.delete(d.id);
    this.busy--;
    if (d.rgba) job.A.paint(job.l, d.rgba instanceof Uint8Array ? d.rgba : new Uint8Array(d.rgba), d.nrm instanceof Uint8Array ? d.nrm : new Uint8Array(d.nrm));
    this.pump();
    // upload on our own clock (the world may not be drawn while the lobby is up)
    const last = !this.queue.length && !this.busy;
    if (last) this.flush(true);
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = 0; this.flush(true); }, 400);
  }

  /** Upload what has been painted (throttled to 4 times a second unless forced). */
  flush(force = false) {
    const now = performance.now();
    if (!force && now - this.lastFlush < 250) return;
    this.lastFlush = now;
    const a = this.surfaces.flush(), b = this.looks.flush();
    // upload now rather than at the next frame that happens to draw the island
    if (this.renderer && this.renderer.initTexture) {
      try {
        if (a) { this.renderer.initTexture(this.surfaces.albedo); this.renderer.initTexture(this.surfaces.normal); }
        if (b) { this.renderer.initTexture(this.looks.albedo); this.renderer.initTexture(this.looks.normal); }
      } catch (e) { /* the next render uploads them */ }
    }
    if (a || b) for (const fn of this.listeners) fn();
    // all painted and uploaded: the pixel copies in JS are not needed any more
    if (!this.queue.length && !this.busy && this.renderer) {
      this.surfaces.release(this.renderer);
      this.looks.release(this.renderer);
    }
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

/** Generate every texture the game uses. onProgress(0..1). */
export async function buildTextures(renderer, onProgress = () => {}, lowMem = false) {
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const S = lowMem ? 256 : 512;
  const jobs = [
    ['woodBuild', () => pair(G.planks(S, 21, { frame: 0.075, base: 0xc58a4f }), 3.5)],
    ['brickBuild', () => pair(G.brick(S, 22, { frame: 0.075, base: 0xa7a39c }), 4.0)],
    ['metalBuild', () => pair(G.metal(S, 23, { frame: 0.075, base: 0x9aa8b5 }), 3.0)],
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
    onProgress((i + 1) / (jobs.length + 1));
    await nextFrame();
  }
  T.layers = new TextureLayers(lowMem, renderer);
  onProgress(1);
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
