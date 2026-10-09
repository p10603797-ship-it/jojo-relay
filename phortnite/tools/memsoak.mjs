#!/usr/bin/env node
// Memory soak: several matches in a row in headless Chromium, each followed by the lobby, a warm-up
// and a party "rejoin" (a new connection and Game, as after LEAVE PARTY / INVITE / a lost party),
// with the memory recorded at every checkpoint:
//
//   rendererMB / rendererPrivMB   the page's renderer process: RSS and private (not shared) memory
//   gpuMB                         the GPU process RSS (SwiftShader draws there)
//   heapMB / extMB                live JS heap after a garbage collection / ArrayBuffer backing stores
//   wasmMB                        WebAssembly memory (Rapier)
//   geo / tex / progs             renderer.info.memory geometries, textures and renderer.info.programs
//   glBufMB / glTexMB / glRbMB    live WebGL buffers / textures / renderbuffers (a WebGL wrapper)
//   up                            what was uploaded to the GPU since the last checkpoint
//   colliders / bodies / joints   Rapier world counts
//   three.*                       live three.js geometries, textures, materials, attributes, objects
//                                 (after GC), the uploaded ones no scene uses ("orphans"), and the
//                                 uploaded geometries / textures / programs by kind (diffed at the end)
//   canvas                        live <canvas> elements with a 2D context and their pixels
//   audio                         AudioContexts and live AudioNodes
//   dom / listeners / ws          DOM nodes, JS event listeners, WebSockets made / still open
//
//   node tools/memsoak.mjs [--matches 3] [--bots 23] [--match-secs 150] [--lobby-secs 15]
//        [--warmup-secs 10] [--no-rejoin] [--quality medium] [--size 1024x768] [--render-every 20]
//        [--res 0.5] [--every 75] [--mode <catalog id>] [--touch] [--out file.json] [--label name]
//        [--url http://host:port/] [--party-cycles N] [--public <dir>] [--no-track]
//        [--channel chromium|shell] [--verbose] [--slice 30] [--sync turn|raf]
//
//   --public <dir>      serve another checkout's public/ folder (e.g. the code before a fix)
//   --url <server>      use a running server instead of the built-in static one; with a Node server
//                       (npm start), --party-cycles N then hosts and leaves a server party N times
//
// The game runs on a simulated clock (60 steps per simulated second, the solo room ticking at
// 20 Hz of it) and draws every --render-every-th step at --res of the page's pixel ratio, with a
// gl.finish() after each draw so the page never queues GPU work faster than SwiftShader runs it.
// The player is an invulnerable observer that drops from the bus and is moved next to a bot every
// 20 s, so terrain, buildings, vegetation and colliders stream and fights are seen up close. A
// match ends by itself or after --match-secs (BACK TO LOBBY). Expect about 6 minutes of wall time
// per 150 s match on a 4-core machine.
//
// Browser: full Chromium in the new headless mode (Playwright's 'chromium' channel). Playwright's
// default old headless shell lets the renderer and browser processes balloon by GBs once the GPU
// process falls behind (SwiftShader shader compiles, a slow frame): with nothing changed in the
// game, the integration's 23-bot fast-forward reads ~1.1-1.4 GB of renderer RSS there and ~0.4 GB
// in full Chromium. --channel shell is only there to show that.
//
// The summary compares the lobby after the first full cycle (m1-rejoin) with the last one, and
// checks the deltas against a tolerance (first-use caches may still fill in a little); the exit
// code is 1 when a check fails or the page had errors.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const MATCHES = +opt('matches', 3);
const BOTS = +opt('bots', 23);
const MATCH_SECS = +opt('match-secs', 150);
const LOBBY_SECS = +opt('lobby-secs', 15);
const WARMUP_SECS = +opt('warmup-secs', 10);
const REJOIN = !args.includes('--no-rejoin');
const QUALITY = opt('quality', 'medium');
const [VW, VH] = String(opt('size', '1024x768')).split('x').map(Number);
const RENDER_EVERY = Math.max(1, +opt('render-every', 20));
const RES = +opt('res', 0.5);
const MODE = opt('mode', null);
const TOUCH = !!opt('touch', false);
const URL_ARG = opt('url', null);
const OUT = opt('out', null);
const LABEL = opt('label', 'soak');
const TRACK = !args.includes('--no-track');
const EVERY = +opt('every', 75);
const PARTY_CYCLES = +opt('party-cycles', 0); // with --url of a Node server: host / leave a server party this many times
const PUBLIC = path.resolve(opt('public', path.join(ROOT, 'public'))); // e.g. an older checkout's public/ to compare
const VERBOSE = !!opt('verbose', false);
const RAF = opt('sync', 'turn') === 'raf';
const SLICE = +opt('slice', 30);

async function loadPlaywright() {
  const tries = ['playwright', process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) {
    try { return await import(t); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found (npm i -D playwright, or set PLAYWRIGHT=/path/to/playwright/index.mjs)');
}

// ------------------------------------------------------------------ static server (like perf-world)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};
const VENDOR = {
  '/vendor/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three.core.js': 'node_modules/three/build/three.core.js',
  '/vendor/rapier.mjs': 'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs',
  '/vendor/es-module-shims.js': 'node_modules/es-module-shims/dist/es-module-shims.js',
};
const CDN = [
  ['https://cdn.jsdelivr.net/npm/es-module-shims@2.8.4/dist/es-module-shims.js', '/vendor/es-module-shims.js'],
  ['https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js', '/vendor/three.module.js'],
  ['https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/', '/vendor/addons/'],
  ['https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs', '/vendor/rapier.mjs'],
];
function resolveFile(urlPath) {
  const p = decodeURIComponent(urlPath.split('?')[0]);
  if (VENDOR[p]) return path.join(ROOT, VENDOR[p]);
  if (p.startsWith('/vendor/addons/')) return path.join(ROOT, 'node_modules/three/examples/jsm', p.slice(15));
  return path.join(PUBLIC, p.endsWith('/') ? `${p}index.html` : p);
}
function startServer() {
  const server = http.createServer((req, res) => {
    const abs = path.normalize(resolveFile(req.url));
    if (!abs.startsWith(ROOT) && !abs.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    fs.readFile(abs, (err, raw) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(abs);
      if (ext === '.html') {
        let s = raw.toString('utf8');
        for (const [a, b] of CDN) s = s.split(a).join(b);
        raw = Buffer.from(s);
      }
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(raw);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ------------------------------------------------------------------ process memory (Linux)
/** RSS / private MB of this Node process's Chromium renderer and GPU processes (the largest of each). */
function procMem() {
  const out = { rendererMB: -1, rendererPrivMB: -1, gpuMB: -1 };
  let rows;
  try {
    rows = execSync('ps -eo pid=,ppid=,rss=,args=', { encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] } : null;
    }).filter(Boolean);
  } catch (e) { return out; }
  // only descendants of this process (another Chromium on the machine does not count)
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; }
  }
  for (const r of rows) {
    if (!mine.has(r.pid)) continue;
    const mb = Math.round(r.rss / 1024);
    if (/--type=renderer/.test(r.args) && !/--extension-process/.test(r.args)) {
      if (mb > out.rendererMB) {
        out.rendererMB = mb;
        try {
          const s = fs.readFileSync(`/proc/${r.pid}/smaps_rollup`, 'utf8');
          const kb = (k) => +((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s) || [0, 0])[1]);
          out.rendererPrivMB = Math.round((kb('Private_Clean') + kb('Private_Dirty')) / 1024);
        } catch (e) { /* not Linux */ }
      }
    } else if (/--type=gpu-process/.test(r.args)) out.gpuMB = Math.max(out.gpuMB, mb);
  }
  return out;
}

// ------------------------------------------------------------------ in-page instrumentation
// Installed before any page script runs.
function instrument(track) {
  const M = window.__mem = {
    gl: { buffers: 0, bufBytes: 0, textures: 0, texBytes: 0, programs: 0, fbos: 0, rbos: 0, rbBytes: 0, vaos: 0 },
    up: { tex: 0, texBytes: 0, canvasTex: 0, buf: 0, bufBytes: 0, programs: 0 }, // since the last probe
    canvases: [], canvasMade: 0,
    audio: { contexts: 0, made: {}, refs: [] },
    wasm: [],
    three: { made: {}, live: {}, disposed: {}, refs: { geometry: [], texture: [], material: [] } },
  };
  // ---- WebGL: live objects and their bytes
  const BPP = {
    0x8058: 4, 0x8C43: 4, 0x1908: 4, 0x1907: 4, 0x8051: 4, 0x8C41: 4, 0x8229: 1, 0x1903: 1, 0x822B: 2, 0x881A: 8, 0x8814: 16,
    0x822E: 4, 0x822D: 2, 0x822F: 4, 0x8230: 8, 0x81A6: 4, 0x81A5: 2, 0x88F0: 4, 0x8CAC: 4, 0x8CAD: 8, 0x1909: 1, 0x190A: 2,
    0x8C3A: 4, 0x8D62: 2, 0x8056: 2, 0x8057: 2, 0x8D48: 1,
  };
  const bppOf = (f) => BPP[f] || 4;
  const sizes = new WeakMap(); // GL object -> bytes (textures: per face)
  const st = (gl) => gl.__ms || (gl.__ms = { buf: {}, unit: 0, tex: {}, rb: null });
  const patch = (P) => {
    if (!P) return;
    const wrap = (name, fn) => { const o = P[name]; if (typeof o === 'function') P[name] = function (...a) { return fn.call(this, o, a); }; };
    wrap('createBuffer', function (o, a) { M.gl.buffers++; return o.apply(this, a); });
    wrap('deleteBuffer', function (o, a) {
      const b = a[0];
      if (b && sizes.has(b) && !b.__del) { b.__del = 1; M.gl.buffers--; M.gl.bufBytes -= sizes.get(b); }
      else if (b && !b.__del) { b.__del = 1; M.gl.buffers--; }
      return o.apply(this, a);
    });
    wrap('bindBuffer', function (o, a) { st(this).buf[a[0]] = a[1]; return o.apply(this, a); });
    wrap('bufferData', function (o, a) {
      const b = st(this).buf[a[0]];
      const n = typeof a[1] === 'number' ? a[1] : (a[1] ? a[1].byteLength : 0);
      if (b) { M.gl.bufBytes += n - (sizes.get(b) || 0); sizes.set(b, n); }
      M.up.buf++; M.up.bufBytes += n;
      return o.apply(this, a);
    });
    wrap('bufferSubData', function (o, a) { M.up.buf++; M.up.bufBytes += a[2] ? a[2].byteLength || 0 : 0; return o.apply(this, a); });
    wrap('createTexture', function (o, a) { M.gl.textures++; return o.apply(this, a); });
    wrap('deleteTexture', function (o, a) {
      const t = a[0];
      if (t && !t.__del) { t.__del = 1; M.gl.textures--; const s = sizes.get(t); if (s) M.gl.texBytes -= s.total; }
      return o.apply(this, a);
    });
    wrap('activeTexture', function (o, a) { st(this).unit = a[0]; return o.apply(this, a); });
    wrap('bindTexture', function (o, a) { const s = st(this); (s.tex[s.unit] || (s.tex[s.unit] = {}))[a[0]] = a[1]; return o.apply(this, a); });
    const bound = (gl, target) => {
      const s = st(gl);
      const t = target >= 0x8515 && target <= 0x851A ? 0x8513 : target;
      return s.tex[s.unit] && s.tex[s.unit][t];
    };
    const setTex = (gl, target, face, bytes) => {
      const t = bound(gl, target);
      if (!t) return;
      let s = sizes.get(t);
      if (!s) sizes.set(t, (s = { total: 0, faces: {} }));
      const old = s.faces[face] || 0;
      s.faces[face] = bytes;
      s.total += bytes - old;
      M.gl.texBytes += bytes - old;
    };
    const srcDims = (src) => (src ? [src.videoWidth || src.naturalWidth || src.width || 0, src.videoHeight || src.naturalHeight || src.height || 0] : [0, 0]);
    const isCanvas = (src) => src && ((typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas));
    wrap('texImage2D', function (o, a) {
      let w, h, src = null;
      if (a.length === 6) { src = a[5]; [w, h] = srcDims(src); } else { w = a[3]; h = a[4]; }
      if ((a[1] | 0) === 0) setTex(this, a[0], a[0], w * h * bppOf(a[2]));
      M.up.tex++; M.up.texBytes += w * h * 4;
      if (isCanvas(src)) M.up.canvasTex++;
      return o.apply(this, a);
    });
    wrap('texSubImage2D', function (o, a) {
      const src = a.length === 7 ? a[6] : null;
      const [w, h] = src ? srcDims(src) : [a[4], a[5]];
      M.up.tex++; M.up.texBytes += (w | 0) * (h | 0) * 4;
      if (isCanvas(src)) M.up.canvasTex++;
      return o.apply(this, a);
    });
    wrap('texImage3D', function (o, a) {
      if ((a[1] | 0) === 0) setTex(this, a[0], a[0], a[3] * a[4] * a[5] * bppOf(a[2]));
      M.up.tex++; M.up.texBytes += a[3] * a[4] * a[5] * 4;
      return o.apply(this, a);
    });
    wrap('texSubImage3D', function (o, a) { M.up.tex++; M.up.texBytes += (a[5] | 0) * (a[6] | 0) * (a[7] | 0) * 4; return o.apply(this, a); });
    wrap('texStorage2D', function (o, a) {
      const faces = a[0] === 0x8513 ? 6 : 1;
      setTex(this, a[0], a[0], a[3] * a[4] * bppOf(a[2]) * faces * (a[1] > 1 ? 4 / 3 : 1));
      return o.apply(this, a);
    });
    wrap('texStorage3D', function (o, a) {
      setTex(this, a[0], a[0], a[3] * a[4] * a[5] * bppOf(a[2]) * (a[1] > 1 ? 4 / 3 : 1));
      return o.apply(this, a);
    });
    wrap('generateMipmap', function (o, a) {
      const t = bound(this, a[0]);
      const s = t && sizes.get(t);
      if (s && !s.mip) { s.mip = 1; const add = s.total / 3; s.total += add; M.gl.texBytes += add; }
      return o.apply(this, a);
    });
    wrap('createProgram', function (o, a) { M.gl.programs++; M.up.programs++; return o.apply(this, a); });
    wrap('deleteProgram', function (o, a) { if (a[0] && !a[0].__del) { a[0].__del = 1; M.gl.programs--; } return o.apply(this, a); });
    wrap('createFramebuffer', function (o, a) { M.gl.fbos++; return o.apply(this, a); });
    wrap('deleteFramebuffer', function (o, a) { if (a[0] && !a[0].__del) { a[0].__del = 1; M.gl.fbos--; } return o.apply(this, a); });
    wrap('createRenderbuffer', function (o, a) { M.gl.rbos++; return o.apply(this, a); });
    wrap('bindRenderbuffer', function (o, a) { st(this).rb = a[1]; return o.apply(this, a); });
    const rbStore = (gl, bytes) => {
      const rb = st(gl).rb;
      if (!rb) return;
      M.gl.rbBytes += bytes - (sizes.get(rb) || 0);
      sizes.set(rb, bytes);
    };
    wrap('renderbufferStorage', function (o, a) { rbStore(this, a[2] * a[3] * bppOf(a[1])); return o.apply(this, a); });
    wrap('renderbufferStorageMultisample', function (o, a) { rbStore(this, a[3] * a[4] * bppOf(a[2]) * Math.max(1, a[1])); return o.apply(this, a); });
    wrap('deleteRenderbuffer', function (o, a) {
      const rb = a[0];
      if (rb && !rb.__del) { rb.__del = 1; M.gl.rbos--; M.gl.rbBytes -= sizes.get(rb) || 0; }
      return o.apply(this, a);
    });
    wrap('createVertexArray', function (o, a) { M.gl.vaos++; return o.apply(this, a); });
    wrap('deleteVertexArray', function (o, a) { if (a[0] && !a[0].__del) { a[0].__del = 1; M.gl.vaos--; } return o.apply(this, a); });
  };
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  // ---- canvases (the backing store exists once a context is made)
  const ce = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...r) {
    const e = ce.call(this, tag, ...r);
    if (typeof tag === 'string' && tag.toLowerCase() === 'canvas') { M.canvasMade++; M.canvases.push(new WeakRef(e)); }
    return e;
  };
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...r) {
    const c = gc.call(this, type, ...r);
    if (c && !this.__ctx) this.__ctx = type;
    return c;
  };

  // ---- audio: contexts and nodes (a node connected into the graph stays alive)
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const Wrapped = class extends AC { constructor(...a) { super(...a); M.audio.contexts++; } };
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
    const BP = (window.BaseAudioContext || AC).prototype;
    for (const k of Object.getOwnPropertyNames(BP)) {
      if (!/^create/.test(k) || k === 'createPeriodicWave' || k === 'createBuffer') continue;
      const d = Object.getOwnPropertyDescriptor(BP, k);
      if (!d || typeof d.value !== 'function') continue;
      const o = d.value;
      BP[k] = function (...a) {
        const n = o.apply(this, a);
        M.audio.made[k] = (M.audio.made[k] || 0) + 1;
        if (!(this instanceof OfflineAudioContext)) M.audio.refs.push(new WeakRef(n));
        return n;
      };
    }
  }

  // ---- WebSockets (server parties): made and still open
  M.ws = { made: 0, open: 0 };
  const WS = window.WebSocket;
  if (WS) {
    window.WebSocket = class extends WS {
      constructor(...a) {
        super(...a);
        M.ws.made++;
        let counted = false;
        this.addEventListener('open', () => { if (!counted) { counted = true; M.ws.open++; } });
        this.addEventListener('close', () => { if (counted) { counted = false; M.ws.open--; } });
      }
    };
  }

  // ---- WebAssembly memories (Rapier)
  const keepMem = (res) => {
    try {
      const inst = res && (res.instance || res);
      if (inst && inst.exports) for (const v of Object.values(inst.exports)) if (v instanceof WebAssembly.Memory) M.wasm.push(v);
    } catch (e) { /* ignore */ }
    return res;
  };
  const wi = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...a) { return wi.apply(this, a).then(keepMem); };
  if (WebAssembly.instantiateStreaming) {
    const wis = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = function (...a) { return wis.apply(this, a).then(keepMem); };
  }

  // ---- three.js objects: every one gets its id through Object.defineProperty in its constructor
  if (track) {
    const T = M.three;
    for (const k of ['geometry', 'attribute', 'texture', 'material', 'object3d']) { T.made[k] = 0; T.live[k] = 0; T.disposed[k] = 0; }
    const reg = new FinalizationRegistry((k) => { T.live[k]--; });
    const odp = Object.defineProperty;
    Object.defineProperty = function (o, k, d) {
      if (k === 'id' && o && d && typeof d.value === 'number' && typeof o === 'object') {
        const kind = o.isBufferGeometry ? 'geometry' : o.isBufferAttribute ? 'attribute' : o.isTexture ? 'texture'
          : o.isMaterial ? 'material' : o.isObject3D ? 'object3d' : null;
        if (kind) {
          T.made[kind]++; T.live[kind]++;
          reg.register(o, kind);
          if (T.refs[kind]) T.refs[kind].push(new WeakRef(o));
        }
      }
      return odp(o, k, d);
    };
  }
}

// Runs in the page once the app is up: dispose counters, the simulated clock and the probe.
async function pageSetup(opts) {
  const app = window.__phortnite;
  const M = window.__mem;
  const THREE = await import('three');
  app.THREE = THREE;
  for (const [k, C] of [['geometry', THREE.BufferGeometry], ['texture', THREE.Texture], ['material', THREE.Material]]) {
    const o = C.prototype.dispose;
    C.prototype.dispose = function (...a) { M.three.disposed[k] = (M.three.disposed[k] || 0) + 1; return o.apply(this, a); };
  }
  // ---- the simulated clock: performance.now() is game time, the solo room ticks at 20 Hz of it
  const realNow = performance.now.bind(performance);
  let simT = realNow();
  const t0 = simT;
  let nextTick = simT;
  performance.now = () => simT;
  app.frame = () => {}; // the page's own loop stops at its next frame; this driver draws instead
  const S = window.__soak = { simSecs: () => (simT - t0) / 1000, draws: 0, steps: 0 };
  const step = (draw) => {
    simT += 1000 / 60;
    const g = app.game;
    const net = g && g.net;
    if (net && net.kind === 'solo' && net.room) {
      if (net.timer) { clearInterval(net.timer); net.timer = null; nextTick = simT; }
      if (!net.paused) while (simT >= nextTick) { net.room.tick(); nextTick += 50; }
      else nextTick = simT;
      if (net.flush) net.flush();
    }
    // App.frame, on a fixed 1/60 s step
    const dt = 1 / 60;
    const stage = app.stageOn;
    const sim = !!g && !app.paused && !(stage && (g.phase === 'lobby' || !g.me));
    if (sim) g.update(dt);
    else { app.input.update(); app.hud.update(dt); }
    if (stage) {
      if (sim) {
        const me = g.me;
        app.world.update(dt, app.camera, me && me.alive && !me.inBus ? me.pos : app.camera.position, g);
        app.fx.update(dt);
      }
      app.stage.update(dt);
      if (draw) { app.stage.render(app.renderer); S.draws++; }
    } else {
      const me = g && g.me;
      const focus = me && me.alive && !me.inBus ? me.pos : app.camera.position;
      app.world.update(dt, app.camera, focus, g);
      if (app.world.farFor) app.applyFar();
      app.fx.update(dt);
      if (draw) { app.renderer.render(app.scene, app.camera); S.draws++; }
    }
    S.steps++;
  };
  // A draw is followed by gl.finish(), so this page never queues GPU work faster than SwiftShader
  // runs it (without that the renderer's command buffers grow by GBs: not a game leak). Headless
  // Chromium runs requestAnimationFrame at a few frames a second, so the loop yields with a
  // message (MessageChannel) instead; --sync raf waits for an animation frame per draw instead.
  const mc = new MessageChannel();
  const waiting = [];
  mc.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  const nextTurn = () => new Promise((r) => { waiting.push(r); mc.port2.postMessage(0); });
  const nextFrame = () => new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 1000);
  });
  /** Run `secs` of game time: `every` steps of 1/60 s, then one draw. */
  S.run = async (secs, every, raf) => {
    const n = Math.round(secs * 60);
    const gl = app.renderer.getContext();
    for (let i = 0; i < n; i += every) {
      for (let k = 0; k < every && i + k < n; k++) step(k === every - 1 || i + k === n - 1);
      gl.finish();
      if (S.hook) { try { S.hook(); } catch (e) { S.hookErr = String(e && e.stack || e); } }
      await (raf ? nextFrame() : nextTurn());
    }
  };

  // ---- the probe
  const scenes = () => [app.scene, app.stage && app.stage.scene].filter(Boolean);
  const listens = (o) => !!(o && o._listeners && o._listeners.dispose && o._listeners.dispose.length);
  const texOf = (m, out) => {
    for (const k in m) { const v = m[k]; if (v && v.isTexture) out.add(v); }
    if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) out.add(v); else if (Array.isArray(v)) for (const x of v) if (x && x.isTexture) out.add(x); }
  };
  const sigG = (g) => `${g.type}${g.name ? `:${g.name}` : ''} v${g.attributes.position ? g.attributes.position.count : 0} [${Object.keys(g.attributes).join(',')}]`;
  const sigT = (t) => { const i = t.image || {}; return `${t.constructor.name}${t.name ? `:${t.name}` : ''} ${i.width || 0}x${i.height || 0}${i.depth ? `x${i.depth}` : ''}`; };
  const sigM = (m) => `${m.type}${m.name ? `:${m.name}` : ''}`;
  const top = (map, n = 6) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v}x ${k}`);
  window.__probe = () => {
    const r = app.renderer;
    const g = app.game;
    const out = {
      sim: +S.simSecs().toFixed(1), phase: g ? g.phase : '-', stage: !!app.stageOn,
      geo: r.info.memory.geometries, tex: r.info.memory.textures, progs: r.info.programs ? r.info.programs.length : 0,
      glBuffers: M.gl.buffers, glBufMB: +(M.gl.bufBytes / 1e6).toFixed(1), glTextures: M.gl.textures, glTexMB: +(M.gl.texBytes / 1e6).toFixed(1),
      glRbMB: +(M.gl.rbBytes / 1e6).toFixed(1), glPrograms: M.gl.programs, glFbos: M.gl.fbos, glVaos: M.gl.vaos,
      up: { ...M.up, texMB: +(M.up.texBytes / 1e6).toFixed(1), bufMB: +(M.up.bufBytes / 1e6).toFixed(1) },
      draws: S.draws,
    };
    out.up.texBytes = undefined; out.up.bufBytes = undefined;
    for (const k of Object.keys(M.up)) M.up[k] = 0;
    S.draws = 0;
    // physics
    const w = app.physics.world;
    out.colliders = w.colliders.len();
    out.bodies = w.bodies.len();
    out.joints = w.impulseJoints && w.impulseJoints.len ? w.impulseJoints.len() : -1;
    out.wasmMB = +(M.wasm.reduce((s, m) => s + m.buffer.byteLength, 0) / 1e6).toFixed(1);
    // scenes
    const sg = new Set(), sm = new Set(), stx = new Set();
    let objs = 0;
    for (const sc of scenes()) {
      sc.traverse((o) => {
        objs++;
        if (o.geometry) sg.add(o.geometry);
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) { sm.add(m); texOf(m, stx); }
        if (o.isSprite && o.material && o.material.map) stx.add(o.material.map);
      });
      if (sc.background && sc.background.isTexture) stx.add(sc.background);
      if (sc.environment) stx.add(sc.environment);
    }
    out.sceneObjects = objs;
    out.progNames = {};
    for (const pr of r.info.programs || []) out.progNames[pr.name] = (out.progNames[pr.name] || 0) + 1;
    out.sceneGeo = sg.size;
    // three.js objects alive (after the GC the caller runs first)
    const T = M.three;
    if (T.refs.geometry) {
      out.three = { live: { ...T.live }, made: { ...T.made }, disposed: { ...T.disposed } };
      const orphG = new Map(), orphT = new Map(), orphM = new Map(), allG = new Map(), allT = new Map();
      let geoBytes = 0, texCpu = 0, uploadedG = 0, uploadedT = 0, orphanG = 0, orphanT = 0;
      const seenArr = new Set();
      for (const kind of ['geometry', 'texture', 'material']) {
        const keep = [];
        for (const ref of T.refs[kind]) {
          const o = ref.deref();
          if (!o) continue;
          keep.push(ref);
          if (kind === 'geometry') {
            for (const a of Object.values(o.attributes)) { const arr = a.array || (a.data && a.data.array); if (arr && !seenArr.has(arr.buffer)) { seenArr.add(arr.buffer); geoBytes += arr.byteLength; } }
            if (o.index && o.index.array && !seenArr.has(o.index.array.buffer)) { seenArr.add(o.index.array.buffer); geoBytes += o.index.array.byteLength; }
            if (listens(o)) { uploadedG++; const sk = sigG(o); allG.set(sk, (allG.get(sk) || 0) + 1); if (!sg.has(o)) { orphanG++; const k = sigG(o); orphG.set(k, (orphG.get(k) || 0) + 1); } }
          } else if (kind === 'texture') {
            const data = o.image && o.image.data;
            if (data && data.buffer && !seenArr.has(data.buffer)) { seenArr.add(data.buffer); texCpu += data.byteLength; }
            if (listens(o)) { uploadedT++; const sk = sigT(o); allT.set(sk, (allT.get(sk) || 0) + 1); if (!stx.has(o)) { orphanT++; const k = sigT(o); orphT.set(k, (orphT.get(k) || 0) + 1); } }
          } else if (listens(o) && !sm.has(o)) { const k = sigM(o); orphM.set(k, (orphM.get(k) || 0) + 1); }
        }
        T.refs[kind] = keep;
      }
      out.three.geoMB = +(geoBytes / 1e6).toFixed(1);
      out.three.texCpuMB = +(texCpu / 1e6).toFixed(1); // DataTexture pixels kept in JS
      out.three.uploadedGeo = uploadedG;
      out.three.orphanGeo = orphanG;
      out.three.uploadedTex = uploadedT;
      out.three.orphanTex = orphanT;
      out.three.topOrphanGeo = top(orphG);
      out.three.topOrphanTex = top(orphT);
      out.three.topOrphanMat = top(orphM, 4);
      // every uploaded geometry / texture by kind, and the shader programs: diff two checkpoints
      out.three.geoSigs = Object.fromEntries(allG);
      out.three.texSigs = Object.fromEntries(allT);
    }
    // canvases with a backing store
    const cv = new Set();
    M.canvases = M.canvases.filter((r2) => { const c = r2.deref(); if (c) cv.add(c); return !!c; });
    for (const c of document.querySelectorAll('canvas')) cv.add(c);
    let n2d = 0, px = 0, inDom = 0;
    const big = new Map();
    for (const c of cv) {
      if (!c.__ctx) continue;
      n2d++;
      px += c.width * c.height;
      if (c.isConnected) inDom++;
      const k = `${c.__ctx} ${c.width}x${c.height}${c.id ? `#${c.id}` : ''}`;
      big.set(k, (big.get(k) || 0) + 1);
    }
    out.canvas = { live: cv.size, withCtx: n2d, inDom, MB: +(px * 4 / 1e6).toFixed(1), made: M.canvasMade, top: top(big, 5) };
    // audio
    M.audio.refs = M.audio.refs.filter((r2) => !!r2.deref());
    out.audio = { contexts: M.audio.contexts, liveNodes: M.audio.refs.length, made: Object.values(M.audio.made).reduce((a, b) => a + b, 0) };
    // the game
    out.domNodes = document.getElementsByTagName('*').length;
    out.ws = { ...M.ws };
    if (g) {
      out.game = {
        bots: g.bots.size, remotes: g.remotes.size, loot: g.loot.items.size,
        builds: app.builds.pieces ? app.builds.pieces.size : undefined,
        alive: g.actors().filter((a) => a.alive).length,
      };
    }
    return out;
  };
  return { ok: true };
}

// ------------------------------------------------------------------ main
const t00 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t00) / 1000).toFixed(0)}s`, ...a);
let server = null;
let base = URL_ARG;
if (!base) {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}/`;
}
const { chromium } = await loadPlaywright();
// Full Chromium in the new headless mode: the old headless shell (Playwright's default) lets the
// renderer and browser processes balloon by GBs within seconds once the GPU process falls behind
// (SwiftShader shader compiles), with the game's own frame loop too; that is not the game's memory.
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'];
const CHANNEL = opt('channel', 'chromium');
let browser;
try {
  browser = await chromium.launch({ channel: CHANNEL === 'shell' ? undefined : CHANNEL, args: LAUNCH_ARGS });
} catch (e) {
  console.log(`no ${CHANNEL} browser (${e.message.split('\n')[0]}); using the headless shell: renderer numbers are not reliable`);
  browser = await chromium.launch({ args: LAUNCH_ARGS });
}
const result = {
  label: LABEL, when: new Date().toISOString(), quality: QUALITY, size: `${VW}x${VH}`, matches: MATCHES, bots: BOTS,
  matchSecs: MATCH_SECS, renderEvery: RENDER_EVERY, mode: MODE, touch: TOUCH, rejoin: REJOIN, checkpoints: [], errors: [],
};
const save = () => { if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); };
try {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, hasTouch: TOUCH });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.addInitScript((s) => {
    try { localStorage.setItem('phortnite.settings', JSON.stringify(s)); } catch (e) { /* ignore */ }
  }, { name: 'Soak', skin: 1, quality: QUALITY, forceTouch: TOUCH, shake: false, music: 0.5 });
  await ctx.addInitScript(instrument, TRACK);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { result.errors.push(e.message); log('PAGEERROR', e.message); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon|fonts\.g|net::ERR|Failed to load resource/.test(t)) return;
    result.errors.push(`console.error: ${t.slice(0, 300)}`);
    log('CONSOLE.ERROR', t.slice(0, 300));
  });
  page.on('crash', () => { result.errors.push('renderer crashed'); log('RENDERER CRASHED'); });
  const cdp = await ctx.newCDPSession(page);
  await page.goto(base);
  await page.waitForFunction(() => { const a = window.__phortnite; return a && a.game && a.game.me && a.stageOn; }, null, { timeout: 300000 });
  // the texture arrays fill in the background: wait for them, so boot work is not counted as growth
  await page.waitForFunction(() => {
    const L = window.__phortnite.T && window.__phortnite.T.layers;
    return !L || (L.surfaces.complete && L.looks.complete && !L.busy);
  }, null, { timeout: 300000, polling: 500 });
  // a key press unlocks the game's audio (it waits for the first tap / key, like iPad Safari)
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.up('ShiftLeft');
  log('booted', await page.evaluate(() => { const s = window.__phortnite.sfx; return s.ctx ? `audio ${s.ctx.state}` : 'no audio'; }));
  await page.evaluate(pageSetup, {});
  // SwiftShader draws on the CPU: a lower drawing-buffer resolution (the CSS layout, the HUD and
  // the textures stay the same) keeps it from falling minutes behind
  await page.evaluate((r) => { const app = window.__phortnite; app.resScale = r; app.applyPixelRatio(); }, RES);

  const run = async (secs) => {
    // long runs in slices, so the page never blocks an evaluate for minutes
    for (let left = secs; left > 0; left -= SLICE) {
      const w0 = Date.now();
      await page.evaluate(([s, e, r]) => window.__soak.run(s, e, r), [Math.min(SLICE, left), RENDER_EVERY, RAF]);
      if (VERBOSE) {
        const st = await page.evaluate(() => ({ t: window.__soak.simSecs().toFixed(0), ph: window.__phortnite.game.phase, err: window.__soak.hookErr }));
        log(`  sim ${st.t}s ${st.ph} (${((Date.now() - w0) / 1000).toFixed(1)} s wall)`, JSON.stringify(procMem()), st.err || '');
      }
    }
  };
  const checkpoint = async (name) => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const p = await page.evaluate(() => window.__probe());
    const h = await cdp.send('Runtime.getHeapUsage');
    let dc = null;
    try { dc = await cdp.send('Memory.getDOMCounters'); } catch (e) { /* older Chromium */ }
    const row = {
      name, ...procMem(),
      heapMB: +(h.usedSize / 1e6).toFixed(1), extMB: h.backingStorageSize !== undefined ? +(h.backingStorageSize / 1e6).toFixed(1) : undefined,
      listeners: dc ? dc.jsEventListeners : undefined, ...p,
    };
    result.checkpoints.push(row);
    log(`${name.padEnd(18)} rend ${row.rendererMB}/${row.rendererPrivMB} gpu ${row.gpuMB} heap ${row.heapMB} ext ${row.extMB} wasm ${row.wasmMB}`
      + ` | geo ${row.geo} tex ${row.tex} progs ${row.progs} glBuf ${row.glBuffers}/${row.glBufMB}MB glTex ${row.glTextures}/${row.glTexMB}MB`
      + ` | col ${row.colliders} bod ${row.bodies} | 3js g${row.three ? row.three.live.geometry : '-'} t${row.three ? row.three.live.texture : '-'}`
      + ` m${row.three ? row.three.live.material : '-'} o${row.three ? row.three.live.object3d : '-'} orphG ${row.three ? row.three.orphanGeo : '-'}`
      + ` | canvas ${row.canvas.withCtx}/${row.canvas.MB}MB audio ${row.audio.liveNodes} dom ${row.domNodes} lis ${row.listeners}`
      + ` | ${row.phase}${row.game ? ` alive ${row.game.alive}` : ''}`);
    save();
    return row;
  };

  await run(5);
  await checkpoint('lobby-boot');
  for (let mi = 1; mi <= MATCHES; mi++) {
    // the lobby: mode and bots, then PLAY
    await page.evaluate(([mode, bots]) => {
      const g = window.__phortnite.game;
      if (mode) g.send({ t: 'mode', id: mode });
      g.send({ t: 'tweak', bots });
    }, [MODE, BOTS]);
    await run(1);
    await page.evaluate(() => {
      const app = window.__phortnite, g = app.game;
      g.send({ t: 'start' });
      // the player: an invulnerable observer that drops at once and visits the fights
      const room = g.net.room, me = g.myId;
      if (room && !room.__soakGod) {
        room.__soakGod = true;
        const ad = room.applyDamage.bind(room);
        room.applyDamage = (p, ...a) => (p && p.id === me ? undefined : ad(p, ...a));
      }
      let lastHop = 0;
      window.__soak.hook = () => {
        const gg = app.game;
        if (!gg || !gg.me) return;
        if (app.stageOn && gg.phase !== 'lobby') app.showStage(false);
        if (gg.me.inBus && gg.phase === 'bus' && window.__soak.simSecs() > 0) gg.dropFromBus(gg.me);
        const t = window.__soak.simSecs();
        if (gg.phase === 'match' && gg.me.alive && !gg.me.inBus && t - lastHop > 20) {
          lastHop = t;
          const bots = gg.actors().filter((a) => a !== gg.me && a.alive && !a.inBus && a.pos);
          if (bots.length) {
            const b = bots[Math.floor(Math.random() * bots.length)];
            gg.me.mover.teleport(b.pos.x + 6, b.pos.y + 3, b.pos.z + 6);
            gg.me.mover.mode = 'air';
          }
        }
      };
    });
    const t0 = await page.evaluate(() => window.__soak.simSecs());
    let next = EVERY, ended = false;
    for (let el = 0; el < MATCH_SECS;) {
      const chunk = Math.min(30, MATCH_SECS - el);
      await run(chunk);
      el += chunk;
      const ph = await page.evaluate(() => window.__phortnite.game.phase);
      if (ph === 'lobby' || ph === 'ended') { ended = true; break; }
      if (el >= next) { await checkpoint(`m${mi}-${el}s`); next += EVERY; }
    }
    const simIn = (await page.evaluate(() => window.__soak.simSecs())) - t0;
    await checkpoint(`m${mi}-end`);
    // BACK TO LOBBY (solo: ends the match), or wait for the room to send everyone back
    await page.evaluate((e) => {
      const app = window.__phortnite;
      window.__soak.hook = null;
      if (!e) app.backToLobby();
    }, ended);
    for (let i = 0; i < 20; i++) {
      await run(1);
      if (await page.evaluate(() => window.__phortnite.game.phase === 'lobby')) break;
    }
    await page.evaluate(() => { const app = window.__phortnite; if (!app.stageOn) app.showStage(true); });
    await run(LOBBY_SECS);
    log(`match ${mi}: ${simIn.toFixed(0)} s of game time${ended ? ' (ended by itself)' : ''}`);
    await checkpoint(`m${mi}-lobby`);
    if (WARMUP_SECS > 0) {
      await page.evaluate(() => window.__phortnite.warmUp(true));
      await run(WARMUP_SECS);
      await page.evaluate(() => window.__phortnite.warmUp(false));
      await run(3);
    }
    if (REJOIN) {
      // a new party connection (leave / rejoin, a lost party, INVITE): the old Game is disposed
      await page.evaluate(() => window.__phortnite.soloParty());
      await run(LOBBY_SECS);
      await checkpoint(`m${mi}-rejoin`);
    }
  }
  if (PARTY_CYCLES > 0) {
    const server = await page.evaluate(() => !!document.documentElement.dataset.server);
    if (!server) log('--party-cycles needs --url of a Node server (npm start): skipped');
    for (let i = 1; server && i <= PARTY_CYCLES; i++) {
      // INVITE opens a server party (a new WebSocket and Game), LEAVE PARTY goes back to a party of one
      const code = await page.evaluate(async () => { const app = window.__phortnite; await app.invite.host(); return app.game.code; });
      await run(5);
      await page.evaluate(() => { const app = window.__phortnite; app.ui.closeModal && app.ui.closeModal(); app.leaveParty(); });
      await run(5);
      // (toasts and their listeners go after a few seconds of real time)
      if (i === 1 || i === PARTY_CYCLES) { await page.waitForTimeout(7000); await checkpoint(`party-${i}`); }
      else log(`party ${i}: ${code}`);
    }
  }
} catch (e) {
  result.errors.push(`soak: ${e.message}`);
  log('FAILED', e.stack || e.message);
} finally {
  await browser.close();
  if (server) server.close();
}

// ------------------------------------------------------------------ summary
const C = result.checkpoints;
const lob = C.filter((c) => /-lobby$|-rejoin$/.test(c.name));
const a = lob.find((c) => c.name === 'm1-rejoin') || lob[0];
const b = lob[lob.length - 1];
if (a && b && a !== b) {
  const keys = ['rendererMB', 'rendererPrivMB', 'gpuMB', 'heapMB', 'extMB', 'wasmMB', 'geo', 'tex', 'progs', 'glBuffers', 'glBufMB', 'glTextures', 'glTexMB', 'colliders', 'bodies', 'domNodes', 'listeners'];
  const d = {};
  for (const k of keys) d[k] = [a[k], b[k], typeof a[k] === 'number' && typeof b[k] === 'number' ? +(b[k] - a[k]).toFixed(1) : null];
  if (a.three && b.three) {
    for (const k of ['geometry', 'texture', 'material', 'attribute', 'object3d']) d[`three.${k}`] = [a.three.live[k], b.three.live[k], b.three.live[k] - a.three.live[k]];
    d['three.orphanGeo'] = [a.three.orphanGeo, b.three.orphanGeo, b.three.orphanGeo - a.three.orphanGeo];
  }
  d['canvas.withCtx'] = [a.canvas.withCtx, b.canvas.withCtx, b.canvas.withCtx - a.canvas.withCtx];
  d['audio.liveNodes'] = [a.audio.liveNodes, b.audio.liveNodes, b.audio.liveNodes - a.audio.liveNodes];
  // what kinds of geometries / textures / programs were added or dropped between the two
  const diff = (x = {}, y = {}) => {
    const out = [];
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const n = (y[k] || 0) - (x[k] || 0); if (n) out.push(`${n > 0 ? '+' : ''}${n} ${k}`); }
    return out.sort((p, q) => Math.abs(parseInt(q, 10)) - Math.abs(parseInt(p, 10))).slice(0, 12);
  };
  const kinds = {
    geometries: diff(a.three && a.three.geoSigs, b.three && b.three.geoSigs),
    textures: diff(a.three && a.three.texSigs, b.three && b.three.texSigs),
    programs: diff(a.progNames, b.progNames),
  };
  result.summary = { from: a.name, to: b.name, delta: d, kinds };
  log(`growth ${a.name} -> ${b.name}:`);
  for (const [k, [x, y, z]] of Object.entries(d)) log(`  ${k.padEnd(18)} ${String(x).padStart(8)} -> ${String(y).padStart(8)}  (${z >= 0 ? '+' : ''}${z})`);
  for (const [k, v] of Object.entries(kinds)) if (v.length) log(`  ${k} changed: ${v.join(' | ')}`);
}
// Flat within these tolerances from the first lobby after a full cycle to the last one: first-use
// caches (a skin's LOD meshes, a loot model, Rapier's high-water mark) may still fill in a little.
const TOLERANCE = {
  rendererMB: 30, gpuMB: 40, heapMB: 8, wasmMB: 6, glBufMB: 4, glTexMB: 1, progs: 2,
  'three.geometry': 30, 'three.material': 8, 'three.texture': 3, 'three.orphanGeo': 8,
  'canvas.withCtx': 1, domNodes: 20, listeners: 5, 'audio.liveNodes': 40,
};
const checks = [];
if (result.summary) {
  for (const [k, lim] of Object.entries(TOLERANCE)) {
    const row = result.summary.delta[k];
    if (!row || row[2] === null || row[2] === undefined) continue;
    checks.push({ what: k, delta: row[2], limit: lim, ok: row[2] <= lim });
  }
}
const p1 = C.find((c) => c.name === 'party-1'), pN = [...C].reverse().find((c) => /^party-/.test(c.name));
if (p1 && pN && p1 !== pN) {
  for (const [k, lim] of [['rendererMB', 15], ['heapMB', 3], ['domNodes', 10], ['listeners', 3]]) checks.push({ what: `party ${k}`, delta: +(pN[k] - p1[k]).toFixed(1), limit: lim, ok: pN[k] - p1[k] <= lim });
  checks.push({ what: 'party: sockets left open', delta: pN.ws.open, limit: 0, ok: pN.ws.open === 0 });
}
result.checks = checks;
for (const c of checks) log(`${c.ok ? 'PASS' : 'FAIL'} ${c.what}: ${c.delta >= 0 ? '+' : ''}${c.delta} (tolerance ${c.limit})`);
const peak = C.reduce((m, c) => Math.max(m, c.rendererMB || 0), 0);
result.peakRendererMB = peak;
log(`peak renderer RSS ${peak} MB; ${result.errors.length} errors`);
save();
if (result.errors.length || checks.some((c) => !c.ok)) process.exitCode = 1;
