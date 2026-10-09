// The ?bench page: main.js imports this module after boot when the URL has ?bench, and calls
// runBench(app). A fixed 60 s flight measures how the device copes with the island:
//   bus     10 s  the bus crossing the island at full height (the far view)
//   drop     8 s  skydiving down into the biggest town
//   city    14 s  street level among 24 running characters; shadows off, grass off and 75 %
//                 resolution for 3 s each after the first 5 s
//   forest  14 s  walking through the densest trees
//   beach   14 s  along the shore
// Then it shows the average and 95th-percentile frame time, FPS, draw calls and triangles of
// each part on screen (and in window.__benchResult for scripts).
const SEGMENTS = [
  { key: 'bus', label: 'Bus flight', t0: 0, t1: 10 },
  { key: 'drop', label: 'Skydive', t0: 10, t1: 18 },
  { key: 'city', label: 'Town + 24 players', t0: 18, t1: 23 },
  { key: 'city-noshadow', label: '  · no shadows', t0: 23, t1: 26, toggle: 'shadows' },
  { key: 'city-nograss', label: '  · no grass', t0: 26, t1: 29, toggle: 'grass' },
  { key: 'city-res75', label: '  · 75% resolution', t0: 29, t1: 32, toggle: 'res' },
  { key: 'forest', label: 'Forest', t0: 32, t1: 46 },
  { key: 'beach', label: 'Beach', t0: 46, t1: 60 },
];
const TOTAL = 60;
const WARM = 0.5; // seconds skipped at the start of each part (shader compiles after a toggle)

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

/** Places on this island the flight visits. */
function places(world) {
  const d = world.data;
  const regs = d.regions || d.pois || [];
  // the biggest town: a city if there is one, else the place with the most houses
  let city = regs.find((r) => r.kind === 'city');
  if (!city) {
    let best = -1;
    for (const r of regs) {
      let n = 0;
      for (const h of d.houses) if ((h.x - r.x) ** 2 + (h.z - r.z) ** 2 < (r.r || 60) ** 2) n++;
      if (n > best) { best = n; city = r; }
    }
  }
  city = city || { x: 0, z: 0, r: 60 };
  // a clear street spot near the town centre
  let street = { x: city.x, z: city.z };
  for (let k = 0; k < 64; k++) {
    const a = k * 0.83, rr = 6 + (k % 8) * 3;
    const x = city.x + Math.cos(a) * rr, z = city.z + Math.sin(a) * rr, y = d.heightAt(x, z);
    if (!d.solidNear || (!d.solidNear(x, y + 1, z, null, 2.5) && !d.solidNear(x, y + 3, z, null, 2.5))) { street = { x, z }; break; }
  }
  // the densest 32 m patch of trees
  const cells = new Map();
  for (const o of d.objects) {
    if (o.kind !== 'tree') continue;
    const k = `${Math.floor(o.x / 32)},${Math.floor(o.z / 32)}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  let fk = '0,0', fn = 0;
  for (const [k, v] of cells) if (v > fn) { fn = v; fk = k; }
  const [fx, fz] = fk.split(',').map(Number);
  const forest = { x: fx * 32 + 16, z: fz * 32 + 16 };
  // a beach: walk out from the centre until the ground is just above the sea
  let beach = { x: d.size * 0.35, z: 0, dx: 0, dz: 1 };
  for (let a = 0; a < 6.28; a += 0.4) {
    let found = false;
    for (let r = d.size * 0.15; r < d.size * 0.5; r += 4) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r, y = d.heightAt(x, z);
      if (y > 0.4 && y < 2.2 && d.heightAt(x + Math.cos(a) * 12, z + Math.sin(a) * 12) < 0) {
        beach = { x, z, dx: -Math.sin(a), dz: Math.cos(a) };
        found = true;
        break;
      }
    }
    if (found) break;
  }
  return { city, street, forest, beach };
}

export async function runBench(app) {
  if (!app || !app.world || !app.renderer) return null;
  const world = app.world, renderer = app.renderer, camera = app.camera, scene = app.scene;
  const d = world.data;
  const THREE = await import('three');
  // the finished look: wait for the texture layers (at most 30 s)
  const L = app.T && app.T.layers;
  for (let i = 0; i < 300 && L && !(L.surfaces.complete && L.looks.complete); i++) await new Promise((r) => setTimeout(r, 100));
  const P = places(world);
  let BUSH = 135;
  try { BUSH = (await import('../shared/constants.js')).BUS.height; } catch (e) { /* default */ }

  // 24 running characters around the street spot
  const chars = [];
  try {
    const { Character } = await import('./actors/character.js');
    const { SKINS } = await import('../shared/constants.js');
    for (let i = 0; i < 24; i++) {
      const c = new Character(i % SKINS.length, '');
      c.setWeapon(['ar', 'shotgun', 'smg', 'pickaxe'][i % 4], i % 5);
      scene.add(c.group);
      chars.push({ c, a: (i / 24) * Math.PI * 2, r: 8 + (i % 4) * 4, sp: 0.18 + (i % 3) * 0.06 });
    }
  } catch (e) { console.warn('bench: no characters', e); }

  // take over the frame loop
  app.frame = () => {};
  document.body.classList.add('benching');
  const box = document.createElement('div');
  box.className = 'bench';
  box.innerHTML = '<div class="bench-title">BENCHMARK</div><div class="bench-sub">Hands off for 60 seconds…</div><div class="bench-bar"><i></i></div>';
  document.body.appendChild(box);
  const bar = box.querySelector('i'), sub = box.querySelector('.bench-sub');

  const focus = new THREE.Vector3();
  const look = new THREE.Vector3();
  const samples = SEGMENTS.map(() => ({ ms: [], calls: 0, tris: 0, n: 0 }));
  const shadowsWere = renderer.shadowMap.enabled, sunCast = world.sun ? world.sun.castShadow : false;
  const pr0 = renderer.getPixelRatio();
  let toggled = null;
  const setToggle = (t) => {
    if (t === toggled) return;
    // undo the old one
    if (toggled === 'shadows') { renderer.shadowMap.enabled = shadowsWere; if (world.sun) world.sun.castShadow = sunCast; }
    if (toggled === 'grass' && world.grass) world.grass.visible = true;
    if (toggled === 'res') renderer.setPixelRatio(pr0);
    toggled = t;
    if (t === 'shadows') { renderer.shadowMap.enabled = false; if (world.sun) world.sun.castShadow = false; }
    if (t === 'grass' && world.grass) world.grass.visible = false;
    if (t === 'res') renderer.setPixelRatio(pr0 * 0.75);
  };

  const pathAt = (t) => {
    const H = (x, z) => Math.max(d.heightAt(x, z), 0);
    const R = d.size * 0.42;
    const c = P.city, st = P.street;
    if (t < 10) {
      const k = t / 10;
      const x = lerp(-R, R * 0.5, k), z = c.z - 140;
      camera.position.set(x, BUSH, z);
      look.set(x + 60, BUSH - 32, z + 40);
    } else if (t < 18) {
      const k = ease((t - 10) / 8);
      const x0 = R * 0.5, z0 = c.z - 140;
      camera.position.set(lerp(x0, st.x - 40, k), lerp(BUSH, H(st.x, st.z) + 45, k), lerp(z0, st.z - 30, k));
      look.set(st.x, H(st.x, st.z), st.z);
    } else if (t < 32) {
      const a = (t - 18) * 0.35;
      const x = st.x + Math.cos(a) * 3, z = st.z + Math.sin(a) * 3;
      camera.position.set(x, H(x, z) + 2.8, z);
      look.set(st.x + Math.cos(a + 1.4) * 30, H(st.x, st.z) + 2, st.z + Math.sin(a + 1.4) * 30);
    } else if (t < 46) {
      const k = (t - 32) / 14;
      const x = P.forest.x - 30 + k * 60, z = P.forest.z + Math.sin(k * 6) * 6;
      camera.position.set(x, H(x, z) + 2.6, z);
      look.set(x + 20, H(x, z) + 2, z + Math.sin(k * 6 + 1) * 8);
    } else {
      const k = (t - 46) / 14, b = P.beach;
      const x = b.x + b.dx * (k - 0.5) * 120, z = b.z + b.dz * (k - 0.5) * 120;
      camera.position.set(x, H(x, z) + 2.6, z);
      look.set(x + b.dx * 30 - b.dz * 8, H(x, z) + 1.5, z + b.dz * 30 + b.dx * 8);
    }
    camera.lookAt(look);
    focus.set(camera.position.x, d.heightAt(camera.position.x, camera.position.z), camera.position.z);
  };

  if (Math.abs(camera.fov - 80) > 0.1) { camera.fov = 80; camera.updateProjectionMatrix(); }
  const t0 = performance.now();
  let last = t0;
  await new Promise((resolve) => {
    const step = (now) => {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.1, (now - last) / 1000);
      const frameMs = now - last;
      last = now;
      if (t >= TOTAL) { resolve(); return; }
      requestAnimationFrame(step);
      const si = SEGMENTS.findIndex((s) => t >= s.t0 && t < s.t1);
      const seg = SEGMENTS[si];
      setToggle(seg && seg.toggle ? seg.toggle : null);
      pathAt(t);
      for (const ch of chars) {
        ch.a += ch.sp * dt;
        const x = P.street.x + Math.cos(ch.a) * ch.r, z = P.street.z + Math.sin(ch.a) * ch.r;
        ch.c.group.position.set(x, d.heightAt(x, z), z);
        ch.c.group.rotation.y = -ch.a;
        ch.c.update(dt, { anim: 1, speed: 6, pitch: 0, gun: true });
      }
      world.update(dt, camera, focus, null);
      if (world.farFor && app.applyFar) app.applyFar();
      if (app.fx) app.fx.update(dt);
      renderer.render(scene, camera);
      if (seg && t - seg.t0 > WARM) {
        const s = samples[si];
        s.ms.push(frameMs);
        s.calls += renderer.info.render.calls;
        s.tris += renderer.info.render.triangles;
        s.n++;
      }
      bar.style.width = `${Math.min(100, (t / TOTAL) * 100)}%`;
      if (seg) sub.textContent = `${seg.label.trim()} · ${Math.ceil(TOTAL - t)} s`;
    };
    requestAnimationFrame(step);
  });
  setToggle(null);
  for (const ch of chars) { scene.remove(ch.c.group); ch.c.dispose(); }

  // results
  const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const all = [];
  const rows = SEGMENTS.map((s, i) => {
    const m = samples[i];
    all.push(...m.ms);
    const a = avg(m.ms);
    return { key: s.key, label: s.label, avgMs: +a.toFixed(1), p95Ms: +pct(m.ms, 0.95).toFixed(1), fps: a ? Math.round(1000 / a) : 0, calls: m.n ? Math.round(m.calls / m.n) : 0, tris: m.n ? Math.round(m.tris / m.n) : 0, frames: m.n };
  });
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { /* hidden */ }
  const ta = avg(all);
  const result = {
    done: true, quality: app.q && app.q.name, dpr: window.devicePixelRatio, size: `${innerWidth}x${innerHeight}`, gpu,
    total: { avgMs: +ta.toFixed(1), p95Ms: +pct(all, 0.95).toFixed(1), fps: ta ? Math.round(1000 / ta) : 0 }, segments: rows,
  };
  window.__benchResult = result;
  console.log('[bench]', JSON.stringify(result));
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  box.classList.add('done');
  box.innerHTML = `<div class="bench-title">BENCHMARK RESULTS</div>
    <div class="bench-sub">${result.total.fps} FPS average · ${result.total.avgMs} ms (95%: ${result.total.p95Ms} ms) · ${result.quality || ''} · ${result.size} @${result.dpr}x</div>
    <table><tr><th></th><th>avg ms</th><th>95% ms</th><th>FPS</th><th>calls</th><th>triangles</th></tr>
    ${rows.map((r) => `<tr><td>${r.label.replace(/^ +/, '&nbsp;&nbsp;')}</td><td>${r.avgMs}</td><td>${r.p95Ms}</td><td>${r.fps}</td><td>${r.calls}</td><td>${fmt(r.tris)}</td></tr>`).join('')}
    </table>
    <div class="bench-gpu">${gpu ? String(gpu).replace(/[<>&]/g, '') : ''}</div>
    <div class="bench-btns"><button type="button" data-a="again">RUN AGAIN</button><button type="button" data-a="back">PLAY</button></div>`;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'again') { box.remove(); runBench(app); return; }
    box.remove();
    document.body.classList.remove('benching');
    delete app.frame;
    app.last = performance.now();
    requestAnimationFrame((t) => app.frame(t));
    const u = new URL(location.href);
    u.searchParams.delete('bench');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  });
  return result;
}
