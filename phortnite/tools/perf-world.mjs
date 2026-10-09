#!/usr/bin/env node
// World performance harness: boots the game in headless Chromium (SwiftShader), freezes the frame
// loop and measures named viewpoints, then checks the worst view against perf-budgets.json.
//
//   node tools/perf-world.mjs [--quality low|medium|high] [--views bus,overhead,city,...]
//                             [--fight] [--stress] [--overlay <public dir>] [--shots <dir>]
//                             [--out <file.json>] [--size 1024x640] [--label name]
//
// Per viewpoint it records:
//   calls / tris          renderer.info for one frame (shadow pass included)
//   mainCalls / mainTris  the same frame without the shadow pass (shadow casters skipped)
//   colliders             active Rapier colliders
//   physMs / updMs        median physics.step and world.update times (the desktop proxy)
//   heapMB / texMB        JS heap after a garbage collection over CDP (heapRawMB: before it) and an
//                         estimate of GPU texture memory
// Viewpoints (each only when the world has it): bus (bus height above the island), overhead,
// city (the densest town), one per biome centre, forest (the densest trees), peak, beach, and
// with --fight a match with 23 bots fast-forwarded until they have landed.
//
// --stress serves tools/stress.html instead (the synthetic 1.6 km world: today's island tiled
// 2.5 x 2.5); --overlay serves public/ files from another checkout first (e.g. a new world
// generator) so the engine can be measured against it before the merge.
// The numbers from SwiftShader are CPU-rendered: calls and triangles carry over to an iPad,
// milliseconds only compare runs on the same machine.
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const QUALITY = opt('quality', 'medium');
const VIEWS = opt('views', 'all');
const FIGHT = !!opt('fight', false);
const STRESS = !!opt('stress', false);
const OVERLAY = opt('overlay', null);
const SHOTS = opt('shots', null);
const OUT = opt('out', null);
const LABEL = opt('label', STRESS ? 'stress' : OVERLAY ? 'overlay' : 'today');
const [VW, VH] = String(opt('size', '1024x640')).split('x').map(Number);
const BUDGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'perf-budgets.json'), 'utf8'));

async function loadPlaywright() {
  const tries = ['playwright', process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) {
    try { return await import(t); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found (npm i -D playwright, or set PLAYWRIGHT=/path/to/playwright/index.mjs)');
}

// ------------------------------------------------------------------ static server (like server.js)
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

function resolve(urlPath) {
  const p = decodeURIComponent(urlPath.split('?')[0]);
  if (VENDOR[p]) return path.join(ROOT, VENDOR[p]);
  if (p.startsWith('/vendor/addons/')) return path.join(ROOT, 'node_modules/three/examples/jsm', p.slice(15));
  if (p.startsWith('/tools/')) return path.join(ROOT, p);
  const rel = p.endsWith('/') ? `${p}index.html` : p;
  if (OVERLAY) {
    const o = path.join(path.resolve(OVERLAY), rel);
    if (fs.existsSync(o)) return o;
  }
  return path.join(ROOT, 'public', rel);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const abs = resolve(req.url);
    if (!abs.startsWith(ROOT) && !(OVERLAY && abs.startsWith(path.resolve(OVERLAY)))) { res.writeHead(403); res.end(); return; }
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

// ------------------------------------------------------------------ in-page measuring code
// Runs in the page. Freezes the frame loop and exposes window.__perf.
function pageSetup() {
  const app = window.__phortnite || window.__stress;
  if (!app) throw new Error('no app');
  if (app.frame && !app.__frozen) { app.__frozen = true; app.frame = () => {}; }
  const THREE = app.THREE;
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const texBytes = () => {
    const seen = new Set();
    let bytes = 0;
    const bpp = (t) => {
      const T = THREE;
      const per = t.type === T.HalfFloatType ? 2 : t.type === T.FloatType ? 4 : 1;
      const ch = t.format === T.RedFormat ? 1 : t.format === T.RGFormat ? 2 : 4;
      return per * ch;
    };
    const add = (t) => {
      if (!t || !t.isTexture || seen.has(t)) return;
      seen.add(t);
      const img = t.image || {};
      const w = img.width || 0, h = img.height || 0, d = img.depth || 1;
      if (!w || !h) return;
      bytes += w * h * d * bpp(t) * (t.generateMipmaps && t.minFilter !== T.LinearFilter && t.minFilter !== T.NearestFilter ? 4 / 3 : 1);
    };
    const T = THREE;
    app.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const k in m) if (m[k] && m[k].isTexture) add(m[k]);
        if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) add(v); }
        if (m.userData && m.userData.textures) for (const t of m.userData.textures) add(t);
      }
    });
    if (app.T) for (const v of Object.values(app.T)) { if (v && v.isTexture) add(v); else if (v) { add(v.map); add(v.normal); } }
    if (app.scene.environment) add(app.scene.environment);
    return bytes;
  };
  const world = app.world;
  const cam = app.camera;
  const renderer = app.renderer;
  const P = {
    info() {
      const d = world.data;
      return {
        size: d.size, version: d.version || 1, objects: d.objects.length, regions: (d.regions || d.pois).length,
        colliders: app.physics.world.colliders.len(), quality: app.q && app.q.name,
      };
    },
    /** Named viewpoints from the world data: { name: { x, y, z, yaw, pitch, fx, fz } }. */
    views() {
      const d = world.data;
      const h = (x, z) => d.heightAt(x, z);
      const out = {};
      const R = (d.islandRadius || (d.size * 0.42));
      const BUSH = (app.BUS && app.BUS.height) || (d.size > 1000 ? 230 : 135);
      const toC = (x, z) => Math.atan2(-x, -z); // yaw looking at the island centre
      out.bus = { x: -R * 0.8, y: BUSH, z: -R * 0.15, yaw: toC(-R * 0.8, -R * 0.15), pitch: -0.3 };
      out.overhead = { x: 0, y: Math.max(300, d.size * 0.22), z: R * 0.25, yaw: Math.PI, pitch: -1.1 };
      // the densest town: the region (or poi) with the most houses within its radius
      const regs = d.regions || d.pois;
      let best = null, bestN = -1;
      for (const r of regs) {
        let n = 0;
        for (const hs of d.houses) if ((hs.x - r.x) ** 2 + (hs.z - r.z) ** 2 < (r.r || 60) ** 2) n++;
        if (n > bestN) { bestN = n; best = r; }
      }
      if (best) {
        // a street-level spot in the open (not inside a building) looking at the town centre
        let pick = null;
        for (let k = 0; k < 48 && !pick; k++) {
          const a = 0.7 + k * 0.9, dd = Math.max(12, (best.r || 50) * (0.3 + (k % 4) * 0.12));
          const x = best.x + Math.cos(a) * dd, z = best.z + Math.sin(a) * dd;
          const y = h(x, z);
          if (y < 0.5) continue;
          if (d.solidNear && (d.solidNear(x, y + 1, z, null, 1.5) || d.solidNear(x, y + 3, z, null, 1.5))) continue;
          pick = { x, z, y };
        }
        if (pick) out.city = { x: pick.x, y: pick.y + 3, z: pick.z, yaw: Math.atan2(best.x - pick.x, best.z - pick.z), pitch: -0.08, name: best.name };
      }
      // biome centres (version 2 grids): the grid point nearest the centroid of each biome's cells
      if (d.biome && d.N) {
        const { N, cell, half } = d;
        const sx = {}, sz = {}, n = {};
        for (let iz = 0; iz < N; iz += 2) {
          for (let ix = 0; ix < N; ix += 2) {
            const b = d.biome[iz * N + ix];
            sx[b] = (sx[b] || 0) + ix; sz[b] = (sz[b] || 0) + iz; n[b] = (n[b] || 0) + 1;
          }
        }
        const names = app.BIOMES || [];
        for (const k of Object.keys(n)) {
          const b = +k;
          const name = names[b] || `b${b}`;
          if (name === 'ocean' || n[b] < 20) continue;
          const cx = sx[b] / n[b], cz = sz[b] / n[b];
          let bx = 0, bz = 0, bd = Infinity;
          for (let iz = 0; iz < N; iz += 2) {
            for (let ix = 0; ix < N; ix += 2) {
              if (d.biome[iz * N + ix] !== b) continue;
              const dd = (ix - cx) ** 2 + (iz - cz) ** 2;
              if (dd < bd) { bd = dd; bx = ix; bz = iz; }
            }
          }
          const x = -half + bx * cell, z = -half + bz * cell;
          out[`biome-${name}`] = { x, y: Math.max(0, h(x, z)) + 3, z, yaw: toC(x, z), pitch: -0.1 };
        }
      }
      // the densest 32 m patch of trees
      const cells = new Map();
      for (const o of d.objects) {
        if (o.kind !== 'tree') continue;
        const k = `${Math.floor(o.x / 32)},${Math.floor(o.z / 32)}`;
        cells.set(k, (cells.get(k) || 0) + 1);
      }
      let fk = null, fn = 0;
      for (const [k, v] of cells) if (v > fn) { fn = v; fk = k; }
      if (fk) {
        const [cx, cz] = fk.split(',').map(Number);
        const x = cx * 32 + 16, z = cz * 32 + 16;
        out.forest = { x, y: h(x, z) + 3, z, yaw: 0.6, pitch: -0.05 };
      }
      if (d.mountain) {
        let top = { x: d.mountain.x, z: d.mountain.z, y: -1 };
        for (let i = 0; i < 400; i++) {
          const x = d.mountain.x + ((i % 20) - 10) * 5, z = d.mountain.z + (Math.floor(i / 20) - 10) * 5;
          const y = h(x, z);
          if (y > top.y) top = { x, z, y };
        }
        out.peak = { x: top.x, y: top.y + 3, z: top.z, yaw: toC(top.x, top.z), pitch: -0.12 };
      }
      // a beach: the first land point (height 0.5..2 m) going out from the centre toward +x
      for (let r = 0; r < d.size / 2; r += 4) {
        const y = h(r, 0);
        if (r > 50 && y > 0.3 && y < 2) { out.beach = { x: r - 6, y: y + 3, z: 0, yaw: -Math.PI / 2, pitch: -0.1 }; }
      }
      return out;
    },
    place(v) {
      cam.position.set(v.x, v.y, v.z);
      cam.rotation.set(0, 0, 0, 'YXZ');
      cam.rotation.order = 'YXZ';
      cam.rotation.y = v.yaw + Math.PI;
      cam.rotation.x = v.pitch;
      cam.fov = 80;
      cam.aspect = innerWidth / innerHeight;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    },
    settle(v, frames = 140) {
      const focus = new THREE.Vector3(v.x, world.data.heightAt(v.x, v.z), v.z);
      if (v.y - focus.y < 6) focus.copy(cam.position);
      for (let i = 0; i < frames; i++) {
        world.update(1 / 30, cam, focus, app.game || null);
        if (world.farFor && app.applyFar) app.applyFar(true);
        app.physics.step(1 / 60);
      }
      return focus;
    },
    measure(v) {
      P.place(v);
      const focus = P.settle(v);
      renderer.info.autoReset = true;
      for (let i = 0; i < 3; i++) renderer.render(app.scene, cam);
      renderer.render(app.scene, cam);
      const all = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
      const auto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.render(app.scene, cam);
      const main = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
      renderer.shadowMap.autoUpdate = auto;
      const upd = [], phys = [];
      for (let i = 0; i < 24; i++) {
        let t = performance.now();
        world.update(1 / 60, cam, focus, app.game || null);
        upd.push(performance.now() - t);
        t = performance.now();
        app.physics.step(1 / 60);
        phys.push(performance.now() - t);
      }
      const t0 = performance.now();
      renderer.render(app.scene, cam);
      const renderMs = performance.now() - t0;
      return {
        calls: all.calls, tris: all.tris, mainCalls: main.calls, mainTris: main.tris,
        shadowCalls: all.calls - main.calls, shadowTris: all.tris - main.tris,
        colliders: app.physics.world.colliders.len(),
        updMs: +median(upd).toFixed(3), physMs: +median(phys).toFixed(3), renderMs: +renderMs.toFixed(1),
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null,
        texMB: +(texBytes() / 1e6).toFixed(1),
        far: +cam.far.toFixed(0), fogFar: app.scene.fog ? +app.scene.fog.far.toFixed(0) : null,
      };
    },
  };
  window.__perf = P;
  return P.info();
}

// ------------------------------------------------------------------ main
const t00 = Date.now();
let progressT = 0;
/** Log the fight's progress every 30 s; false = keep waiting. */
function fightProgress(st) {
  if (Date.now() - progressT > 30000) { progressT = Date.now(); log('fight: progress', JSON.stringify(st)); }
  return false;
}
const log = (...a) => console.log(`+${((Date.now() - t00) / 1000).toFixed(0)}s`, ...a);
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
});
const result = { label: LABEL, quality: QUALITY, size: `${VW}x${VH}`, when: new Date().toISOString(), views: {}, errors: [] };
try {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  const page = await ctx.newPage();
  // heapMB is the live heap: a garbage collection (over CDP, from outside the page) first, so the
  // boot's leftovers (the world build, texture painting) don't count; heapRawMB is the number before
  const cdp = await ctx.newCDPSession(page);
  const liveHeap = async (r) => {
    try {
      r.heapRawMB = r.heapMB;
      await cdp.send('HeapProfiler.collectGarbage');
      r.heapMB = await page.evaluate(() => (performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null));
    } catch (e) { /* keep the raw number */ }
    return r;
  };
  await page.addInitScript((q) => {
    try { localStorage.setItem('phortnite.settings', JSON.stringify({ name: 'Perf', skin: 1, quality: q })); } catch (e) { /* ignore */ }
  }, QUALITY);
  page.on('pageerror', (e) => { result.errors.push(e.message); log('PAGEERROR', e.message); });
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    if (/favicon|fonts\.g|net::ERR/.test(t)) return;
    result.errors.push(`console.${m.type()}: ${t.slice(0, 400)}`);
    log(`CONSOLE.${m.type().toUpperCase()}`, t.slice(0, 600));
  });
  const t0 = Date.now();
  await page.goto(`${base}/${STRESS ? `tools/stress.html?quality=${QUALITY}` : ''}`);
  await page.waitForFunction(() => (window.__phortnite && window.__phortnite.world && window.__phortnite.renderer) || (window.__stress && window.__stress.ready), null, { timeout: 600000 });
  result.bootMs = Date.now() - t0;
  // the app object does not export THREE / BUS / BIOMES: import them in the page
  await page.evaluate(async () => {
    const app = window.__phortnite || window.__stress;
    app.THREE = await import('three');
    try { app.BUS = (await import('/shared/constants.js')).BUS; } catch (e) { /* stress page */ }
    try { app.BIOMES = (await import('/shared/world/keys.js')).BIOMES; } catch (e) { /* none */ }
  });
  // the texture arrays fill in the background: measure (and shoot) the finished look
  const tTex = Date.now();
  await page.waitForFunction(() => {
    const app = window.__phortnite || window.__stress;
    const L = app.T && app.T.layers;
    return !L || (L.surfaces.complete && L.looks.complete && !L.busy);
  }, null, { timeout: 300000, polling: 250 });
  result.texturesMs = Date.now() - tTex + result.bootMs;
  result.world = await page.evaluate(pageSetup);
  log('booted', result.bootMs, 'ms; textures done', result.texturesMs, 'ms', JSON.stringify(result.world));
  const all = await page.evaluate(() => window.__perf.views());
  const want = VIEWS === 'all' ? Object.keys(all) : String(VIEWS).split(',');
  for (const name of want) {
    if (!all[name]) { log('no view', name); continue; }
    const r = await liveHeap(await page.evaluate((v) => window.__perf.measure(v), all[name]));
    result.views[name] = r;
    log(name.padEnd(16), `calls ${r.calls} (main ${r.mainCalls})`, `tris ${(r.tris / 1000).toFixed(0)}k (main ${(r.mainTris / 1000).toFixed(0)}k)`,
      `colliders ${r.colliders}`, `upd ${r.updMs}ms`, `phys ${r.physMs}ms`, `heap ${r.heapMB}MB`, `tex ${r.texMB}MB`, `far ${r.far}`);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.addStyleTag({ content: 'body > *:not(#game) { visibility: hidden !important; }' });
      await page.screenshot({ path: path.join(SHOTS, `${LABEL}-${QUALITY}-${name}.png`), timeout: 180000 });
    }
  }
  if (FIGHT && !STRESS) {
    log('fight: starting a match with 23 bots');
    const r = await page.evaluate(async () => {
      const app = window.__phortnite;
      if (!app.game && app.playSolo) await app.playSolo();
      const g = app.game;
      if (!g) return { error: 'no game' };
      return { ok: true };
    });
    if (r.ok) {
      // fast-forward without rendering until most bots have landed (the frame loop stays frozen)
      await page.evaluate(() => {
        const app = window.__phortnite;
        const g = app.game;
        g.startMatch(23);
        app.__ff = { t: 0, done: false, err: null };
        const tick = () => {
          if (app.__ff.done) return;
          try {
            for (let i = 0; i < 30; i++) g.update(1 / 60);
            app.__ff.t += 0.5;
            const me = g.me;
            const focus = me && me.alive && !me.inBus ? me.pos : app.camera.position;
            app.world.update(0.5, app.camera, focus, g);
          } catch (e) { app.__ff.err = String((e && e.stack) || e); return; }
          setTimeout(tick, 0);
        };
        setTimeout(tick, 200);
      });
      // until most bots have landed and a minute of the match has gone by (progress every 30 s;
      // a thrown error or a match that ended first stops the wait)
      const deadline = Date.now() + 1200000;
      for (;;) {
        // a page that stops answering for 30 s: pause it and print where its main thread is
        const answer = page.evaluate(() => {
          const app = window.__phortnite, g = app.game;
          let up = 0;
          if (g) for (const a of g.actors()) if (a.alive && !a.inBus && a.mover && a.mover.mode === 'ground') up++;
          if (g && g.phase === 'match' && up >= 12 && !app.__ff.landed) app.__ff.landed = app.__ff.t;
          const ok = !!(app.__ff.landed && app.__ff.t - app.__ff.landed >= 60);
          return { ok, t: app.__ff.t, phase: g && g.phase, up, err: app.__ff.err, landed: app.__ff.landed || 0 };
        });
        let st = await Promise.race([answer, new Promise((res) => setTimeout(() => res(null), 30000))]);
        if (!st) {
          await cdp.send('Debugger.enable');
          const where = new Promise((res) => cdp.once('Debugger.paused', (e) => res(e.callFrames.slice(0, 16)
            .map((f) => `${f.functionName || '?'}@${f.url.split('/').slice(-2).join('/')}:${f.location.lineNumber + 1}`).join(' <- '))));
          await cdp.send('Debugger.pause');
          const stack = await Promise.race([where, new Promise((res) => setTimeout(() => res('(no pause: the main thread is blocked outside JS)'), 15000))]);
          log('fight: the page stopped answering:', stack);
          result.errors.push(`fight: page hung: ${stack}`);
          await cdp.send('Debugger.resume').catch(() => {});
          st = await Promise.race([answer, new Promise((res) => setTimeout(() => res(null), 30000))]);
          if (!st) break;
        }
        if (st.ok) break;
        if (st.err || (st.phase !== 'match' && st.phase !== 'bus') || Date.now() > deadline) {
          log('fight: stopped early', JSON.stringify(st));
          result.errors.push(`fight: ${st.err || 'phase ' + st.phase}`);
          break;
        }
        if (!fightProgress(st)) await page.waitForTimeout(2000);
      }
      await page.evaluate(() => { const app = window.__phortnite; app.__ff.done = true; });
      await page.waitForTimeout(500);
      await page.evaluate(pageSetup);
      const res = await page.evaluate(() => {
        const app = window.__phortnite;
        const g = app.game;
        // the camera over the biggest group of fighters
        const acts = g.actors().filter((a) => a.alive && !a.inBus);
        let best = null, bn = -1;
        for (const a of acts) {
          let n = 0;
          for (const b of acts) if ((a.pos.x - b.pos.x) ** 2 + (a.pos.z - b.pos.z) ** 2 < 60 * 60) n++;
          if (n > bn) { bn = n; best = a; }
        }
        const v = { x: best.pos.x - 10, y: best.pos.y + 4, z: best.pos.z - 10, yaw: Math.atan2(-10, -10) + Math.PI, pitch: -0.12 };
        const m = window.__perf.measure(v);
        m.nearby = bn;
        m.actors = acts.length;
        m.simSeconds = app.__ff.t;
        m.bots = g.bots.size;
        return m;
      });
      result.views.fight24 = await liveHeap(res);
      log('fight24'.padEnd(16), JSON.stringify(res));
      if (SHOTS) {
        try { await page.screenshot({ path: path.join(SHOTS, `${LABEL}-${QUALITY}-fight24.png`), timeout: 120000 }); } catch (e) { log('no fight screenshot:', e.message.split('\n')[0]); }
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

// ------------------------------------------------------------------ budgets
const B = BUDGETS[QUALITY] || BUDGETS.medium;
const worst = {};
for (const v of Object.values(result.views)) {
  for (const k of ['calls', 'tris', 'colliders', 'updMs', 'physMs', 'heapMB', 'texMB']) worst[k] = Math.max(worst[k] || 0, v[k] || 0);
}
result.worst = worst;
const checks = [
  ['calls', worst.calls, B.calls], ['tris', worst.tris, B.tris], ['colliders', worst.colliders, B.colliders],
  ['world.update ms', worst.updMs, B.worldUpdateMs], ['physics ms', worst.physMs, B.physicsMs],
  ['heap MB', worst.heapMB, B.heapMB], ['texture MB', worst.texMB, B.textureMB],
];
result.budget = {};
for (const [k, v, lim] of checks) {
  if (lim === undefined || v === undefined) continue;
  const ok = v <= lim;
  result.budget[k] = { worst: v, limit: lim, ok };
  log(`${ok ? 'PASS' : 'OVER'} ${k}: worst ${v} / budget ${lim}`);
}
if (result.errors.length) log(`${result.errors.length} page errors`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
