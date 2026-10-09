// Touch HUD layout sweep: the rectangles of every visible touch button and HUD block on 8 iPad /
// phone viewports, in each game state (warm-up, build, edit, match, bus, sky, dead, and a team mode
// with the mode HUD, teammates panel and a notice: King of the Hill). Reports
// overlapping pairs and anything off screen; expects none.
//
//   node tools/layout-sweep.mjs [url] [--shots dir] [--json out.json] [--scale 1.3] [--only 1180x820,844x390]
// The page must be served (npm start). Rendering is switched off while measuring (the DOM is all
// that matters), so it runs fast even on a busy machine. Needs Playwright
// (PLAYWRIGHT=/path/to/playwright/index.mjs, default: the global install).
import fs from 'fs';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const URL = args.find((a) => /^https?:/.test(a)) || process.env.URL || 'http://localhost:8317/';
const SHOTS = opt('--shots');
const JSON_OUT = opt('--json');
const SCALE = Number(opt('--scale')) || 1;
const PW = process.env.PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const ONLY = opt('--only'); // e.g. --only 1180x820,844x390
const VPS = [[1024, 768], [1080, 810], [1133, 744], [1180, 820], [1194, 834], [1366, 1024], [844, 390], [932, 430], [667, 375]]
  .filter(([w, h]) => !ONLY || ONLY.split(',').includes(`${w}x${h}`));
const HUD = ['#bars', '#hotbar', '#ammo', '#mats', '#minimap', '#stats', '#poi', '#killfeed', '#menubtn', '#buildbar', '#lobbypanel', '#busprompt', '#editchips', '#prompt', '#modehud', '.mh-mates', '#notice'];
const t00 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t00) / 1000).toFixed(0)}s`, ...a);

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.addInitScript((sc) => {
  localStorage.setItem('phortnite.settings', JSON.stringify({ name: 'JoJo', skin: 2, quality: 'low', forceTouch: true, autoFire: false, shake: false, tbScale: sc }));
}, SCALE);
const ev = (fn, arg) => p.evaluate(fn, arg);
/** Let the game run n frames (rendering is off, so these are quick). */
const frames = async (n) => {
  await ev((k) => new Promise((res) => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
};
const rects = () => ev((HUD) => {
  const out = {};
  const r = (el) => {
    const bb = el.getBoundingClientRect();
    let vis = bb.width > 0 && bb.height > 0;
    for (let e = el; e && vis; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) vis = false;
    }
    return { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height), vis };
  };
  document.querySelectorAll('#touch .tbtn').forEach((el) => { out[`btn:${el.className.split(' ')[1].replace('tb-', '')}`] = r(el); });
  for (const s of HUD) { const el = document.querySelector(s); if (el && (s !== '#killfeed' || el.children.length)) out[s] = r(el); }
  return out;
}, HUD);
// HUD blocks other packages are replacing (lobby-party turns the warm-up panel into a compact chip):
// their overlaps are listed separately and don't fail the sweep
const FOREIGN = new Set((process.env.FOREIGN ?? '#lobbypanel').split(',').filter(Boolean));
const problems = (R0, W, H) => {
  const ks = Object.keys(R0).filter((k) => R0[k].vis && !FOREIGN.has(k));
  const res = [];
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      const a = R0[ks[i]], c = R0[ks[j]];
      // round buttons: compare circles (their boxes may touch at the corners)
      if (ks[i].startsWith('btn:') && ks[j].startsWith('btn:') && Math.abs(a.w - a.h) < 2 && Math.abs(c.w - c.h) < 2) {
        const d = Math.hypot(a.x + a.w / 2 - c.x - c.w / 2, a.y + a.h / 2 - c.y - c.h / 2);
        if (d < (a.w + c.w) / 2 - 1) res.push(`${ks[i]} x ${ks[j]} (circles ${Math.round((a.w + c.w) / 2 - d)}px)`);
        continue;
      }
      const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x), oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
      if (ox > 1 && oy > 1) res.push(`${ks[i]} x ${ks[j]} (${ox}x${oy})`);
    }
  }
  for (const k of ks) { const a = R0[k]; if (a.x < 0 || a.y < 0 || a.x + a.w > W || a.y + a.h > H) res.push(`${k} OFFSCREEN ${a.x},${a.y} ${a.w}x${a.h}`); }
  return res;
};

await p.goto(URL, { timeout: 300000 });
await p.waitForFunction(() => window.__phortnite && window.__phortnite.ui, null, { timeout: 300000, polling: 200 });
await ev(() => {
  const app = window.__phortnite;
  app.renderer.realRender = app.renderer.render;
  app.renderer.render = () => {}; // DOM only
  app.playSolo();
});
await p.waitForFunction(() => { const g = window.__phortnite.game; return g && g.me && g.phase === 'lobby' && g.me.alive; }, null, { timeout: 120000, polling: 100 });
await ev(() => {
  window.__phortnite.input.setTouchMode(true);
  // a wall to edit right in front and a gun on the ground: the EDIT and pick-up buttons show too
  window.__sweep = {
    setup(build) {
      const g = window.__phortnite.game, me = g.me;
      me.yaw = 0; me.pitch = 0;
      me.buildMode = !!build; me.buildType = 'w';
      me.onInventory();
      const t = g.builds.target('w', me.pos, 0, 0, null);
      if (t.free) g.builds.add({ k: t.k, m: 'wood', by: me.id });
      g.loot.add({ id: 99001, item: { k: 'ar', r: 3, m: 30 }, x: me.pos.x + 0.6, y: me.pos.y + 0.05, z: me.pos.z + 0.6 });
    },
  };
});
const out = {};
const states = {
  warmup: async () => { await ev(() => window.__sweep.setup(false)); await frames(4); },
  build: async () => { await ev(() => window.__sweep.setup(true)); await frames(4); },
  edit: async () => { await ev(() => { window.__sweep.setup(false); }); await frames(3); await ev(() => { const g = window.__phortnite.game; const bc = g.buildClient; const t = bc.target || bc.findTarget(); if (t) bc.openEdit(t); }); await frames(3); },
};
let total = 0;
const foreign = (R0) => {
  const res = [];
  for (const f of FOREIGN) {
    const a = R0[f];
    if (!a || !a.vis) continue;
    for (const [k, c] of Object.entries(R0)) {
      if (k === f || !c.vis) continue;
      const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x), oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
      if (ox > 1 && oy > 1) res.push(`${f} x ${k} (${ox}x${oy})`);
    }
  }
  return res;
};
const run = async (key, W, H, st) => {
  const R0 = await rects();
  const pr = problems(R0, W, H);
  out[key] = out[key] || {};
  out[key][st] = { rects: R0, problems: pr, foreign: foreign(R0) };
  total += pr.length;
  log(key, st, pr.length ? pr : 'ok');
  if (SHOTS) {
    await ev(() => { const r = window.__phortnite.renderer; r.render = r.realRender; });
    await frames(2);
    await p.screenshot({ path: `${SHOTS}/lay-${key}-${st}.png`, timeout: 240000 });
    await ev(() => { window.__phortnite.renderer.render = () => {}; });
  }
};
for (const [w, h] of VPS) {
  await p.setViewportSize({ width: w, height: h });
  await frames(2);
  for (const [st, fn] of Object.entries(states)) { await fn(); await run(`${w}x${h}`, w, h, st); }
  await ev(() => window.__phortnite.game.buildClient.closeEdit());
}
// a match: bus, skydive, on the ground with a loadout, dead
await ev(() => { const g = window.__phortnite.game; g.me.buildMode = false; g.me.onInventory(); g.startMatch(4, 0); });
await p.waitForFunction(() => window.__phortnite.game.phase === 'bus', null, { timeout: 60000 });
const matchStates = {
  bus: async () => { await frames(4); },
  sky: async () => { await ev(() => { const g = window.__phortnite.game; if (g.me.inBus) g.dropFromBus(g.me); g.me.mover.mode = 'skydive'; }); await frames(3); },
  match: async () => {
    await ev(() => {
      const g = window.__phortnite.game, me = g.me, d = g.world.data;
      if (me.inBus) g.dropFromBus(me);
      const sp = d.spawns[0];
      me.mover.teleport(sp.x, d.heightAt(sp.x, sp.z) + 0.2, sp.z); me.mover.mode = 'ground';
      me.resetInventory({ slots: [{ k: 'ar', r: 3, m: 20 }, { k: 'shotgun', r: 2, m: 5 }, { k: 'smg', r: 1, m: 30 }, { k: 'medkit', n: 2 }, { k: 'shield_s', n: 3 }], ammo: { medium: 120, light: 200, shells: 20, heavy: 6 }, mats: { wood: 240, stone: 90, metal: 30 } });
      me.select(1);
      g.hud.killfeed('<span class="me">JoJo</span> ✖ Ramp Rusher');
      g.hud.killfeed('Noob Saibot 🎯 Captain Crunch');
      window.__sweep.setup(false);
    });
    await frames(4);
  },
  dead: async () => { await ev(() => { const g = window.__phortnite.game; g.on_elim({ t: 'elim', v: g.myId, k: 0, c: 'storm', place: 5 }); }); await frames(3); },
};
for (const [w, h] of VPS) {
  await p.setViewportSize({ width: w, height: h });
  await ev(() => { const g = window.__phortnite.game, me = g.me; if (!me.alive) { me.alive = true; me.respawn(me.pos.x, me.pos.y + 0.5, me.pos.z); document.body.classList.remove('dead'); g.hud.elim(null); } me.inBus = false; });
  // the bus state needs the player back on the bus
  await ev(() => { const g = window.__phortnite.game, me = g.me; me.inBus = true; me.mover.mode = 'bus'; me.mover.setEnabled(false); me.char.setVisible(false); });
  for (const [st, fn] of Object.entries(matchStates)) { await fn(); await run(`${w}x${h}`, w, h, st); }
}
// a team mode with the mode HUD (score bar, hill line, teammates panel) and a notice: King of the Hill
await ev(() => { const g = window.__phortnite.game; g.send({ t: 'end' }); });
await p.waitForFunction(() => window.__phortnite.game.phase === 'lobby', null, { timeout: 60000 });
await ev(() => { const g = window.__phortnite.game; g.send({ t: 'mode', id: 'koth' }); g.send({ t: 'tweak', bots: 7 }); g.send({ t: 'start' }); });
await p.waitForFunction(() => window.__phortnite.game.phase === 'match', null, { timeout: 60000 });
await frames(10);
const modeStates = {
  mode: async () => {
    await ev(() => {
      const g = window.__phortnite.game, me = g.me;
      if (!me.alive) { me.alive = true; me.respawn(me.pos.x, me.pos.y + 0.5, me.pos.z); document.body.classList.remove('dead'); g.hud.elim(null); }
      me.resetInventory({ slots: [{ k: 'ar', r: 3, m: 20 }, { k: 'shotgun', r: 2, m: 5 }], ammo: { medium: 120, shells: 20 }, mats: { wood: 240, stone: 90, metal: 30 } });
      me.select(1);
      g.hud.killfeed('<span class="me">JoJo</span> ✖ Ramp Rusher');
      g.hud.killfeed('Noob Saibot 🎯 Captain Crunch');
      g.hud.notice('Sweaty Steve, Loot Goblin are seeking! Hide!', false, 30);
    });
    await frames(12);
  },
};
for (const [w, h] of VPS) {
  await p.setViewportSize({ width: w, height: h });
  for (const [st, fn] of Object.entries(modeStates)) { await fn(); await run(`${w}x${h}`, w, h, st); }
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ url: URL, scale: SCALE, total, errs, out }, null, 1));
log(`done: ${total} problem(s) across ${VPS.length} viewports x ${Object.keys(states).length + Object.keys(matchStates).length + Object.keys(modeStates).length} states; page errors: ${errs.length}`);
for (const e of errs) log('page error', e);
await b.close();
process.exit(total || errs.length ? 1 : 0);
