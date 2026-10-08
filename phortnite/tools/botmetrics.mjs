#!/usr/bin/env node
// Bot behaviour metrics: plays solo matches in headless Chromium (SwiftShader, quality low, no
// drawing, several game steps per frame) and measures what the bots do against the targets of the
// bots-ai work package:
//
//   stuck       bot-time spent stuck (wanting to move, < 2 m in 10 s)            < 2 %
//   pieces      build pieces placed by bots in a match                           >= 120
//   shotgun     share of bot shots fired at targets under 10 m from a shotgun    >= 30 %
//   heals       heals per bot alive 2 minutes after the bus                      >= 1
//   alive60     bots still alive 60 s after the last one landed                  >= 55 %
//   regions     places landed in (5 of 6 on the 640 m island, 15 on the big one)
//   botMs       Bot.update time per game frame (the perf run, 30 bots)           <= 2.5 ms
//   hitRatio    easy hit rate / hard hit rate (the skill runs)                   <= 0.6
//   errors      page errors                                                      0
//
//   node tools/botmetrics.mjs [--runs 3] [--bots 19] [--minutes 6] [--steps 4] [--mode <id>]
//        [--skill normal|easy|hard|mixed] [--perf 30] [--skills] [--cost] [--park follow|center|sea]
//        [--overlay <public dir>] [--url <http://...>] [--out <file.json>] [--log]
//
// --cost repeats the audit's bot-cost measurement (scratchpad audit/tech/botcost.mjs): 0, 10 and
// 30 bots dropped from the bus with the player, 40 s to land, then the mean Game.update +
// World.update time over 600 frames (the 'today: 4.36 ms with 30 bots' number).
//
// The player is a ghost observer (bots ignore it and it can't be hurt): with --park follow (the
// default) it hovers near a bot and switches to another every 25 s, like a spectator, so the bots
// near it run the full simulation and the rest the far one; 'center' hovers over the island centre;
// 'sea' parks it out at sea (every bot far away). The room clock and the bus run on simulation time,
// so a slow machine slows the match down instead of skipping it. --overlay serves public/ files
// from another checkout first (e.g. a new world or the mode engine) to measure against them.
// Times from SwiftShader are CPU-bound: compare runs on the same machine, not across machines.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const RUNS = +opt('runs', 1);
const BOTS = +opt('bots', 19);
const MINUTES = +opt('minutes', 6);
const STEPS = +opt('steps', 4);
const MODE = opt('mode', null);
const SKILL = opt('skill', null);
const PERF = opt('perf', null);
const SKILLS = !!opt('skills', false);
const COST = !!opt('cost', false);
const PARK = opt('park', 'follow');
const OVERLAY = opt('overlay', null);
const URL0 = opt('url', null);
const OUT = opt('out', null);
const LOG = !!opt('log', false);

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

// ------------------------------------------------------------------ in-page instrumentation
// Runs in the page once the solo game is in its warm-up. Exposes window.__M.
function pageSetup(cfg) {
  const app = window.__phortnite, g = app.game;
  app.renderer.render = () => {}; // CPU-only simulation
  const M = (window.__M = {
    cfg, t0: -1, busT: -1, matchT: -1, elims: [], shots: 0, nearShots: 0, nearShotgun: 0, nearSec: 0, nearSgSec: 0, hits: 0, hitsBy: {}, shotsBy: {},
    pieces: 0, piecesFar: 0, piecesBy: {}, heals: {}, chests: 0, picks: 0, land: {}, landT: {}, samples: 0, stuckSamples: 0,
    hist: {}, modeHist: {}, farSamples: 0, botSamples: 0, alive120: null, alive60: null, frames: 0, botMs: 0, botMax: 0,
    updMs: 0, perBot: 0, errors: 0, followId: 0, followT: 0, farHits: 0, skills: {}, regionsUsed: [], navStats: null,
    shotgunHeld: 0, timeline: [], nearBy: {},
  });
  const isBot = (id) => g.bots.has(id);
  const simT = () => g.time - M.t0;
  // the observer: alive, unhurt, ignored by bots, out of everyone's way
  const room = g.net.room;
  const Bot = () => { const b = [...g.bots.values()][0]; return b && b.constructor; };
  M.patchBots = () => {
    const B = Bot();
    if (!B || B.__metrics) return;
    B.__metrics = true;
    const isEnemy = B.prototype.isEnemy;
    B.prototype.isEnemy = function (a) { return a !== g.me && isEnemy.call(this, a); };
    const upd = B.prototype.update;
    B.prototype.update = function (dt) {
      const t = performance.now();
      upd.call(this, dt);
      const ms = performance.now() - t;
      if (g.phase === 'match') { M.botMs += ms; M.perBot++; if (ms > M.botMax) M.botMax = ms; }
    };
  };
  const oUpd = g.update.bind(g);
  g.update = (dt) => {
    if (room) {
      const pl = room.players.get(g.me.id);
      if (pl && pl.alive) { pl.hp = 100; pl.sh = 100; }
    }
    if (g.me.alive && !g.me.inBus && M.t0 >= 0) M.park();
    const t = performance.now();
    const r = oUpd(dt);
    if (g.phase === 'match') { M.frames++; M.updMs += performance.now() - t; }
    return r;
  };
  // the observer stays out of the bullets' way (bots don't shoot it, nobody else should hit it)
  const oHit = g.onBulletHit.bind(g);
  g.onBulletHit = (b, h) => { if (h.kind === 'player' && h.id === g.myId) return; return oHit(b, h); };
  M.park = () => {
    const me = g.me;
    let x = 0, z = 0, y = 0;
    const data = g.world.data;
    if (cfg.park === 'sea') { const R = (data.islandRadius || data.size * 0.42) + 120; x = R; z = R * 0.3; y = -1.1; } else if (cfg.park === 'center') {
      x = 0; z = 0; y = data.heightAt(0, 0) + 60;
    } else {
      // follow a living bot (a new one every 25 s): hover 25 m behind and above it
      let f = g.bots.get(M.followId);
      if (!f || !f.alive || g.time - M.followT > 25) {
        const alive = [...g.bots.values()].filter((b) => b.alive && !b.inBus && b.mode !== 'skydive' && b.mode !== 'glide');
        f = alive.length ? alive[(Math.random() * alive.length) | 0] : null;
        M.followId = f ? f.id : 0; M.followT = g.time;
      }
      if (f) { x = f.pos.x + 18; z = f.pos.z + 18; y = Math.max(f.pos.y, data.heightAt(x, z)) + 25; } else { y = data.heightAt(0, 0) + 60; }
    }
    me.mover.teleport(x, y, z);
    me.mover.vel.set(0, 0, 0);
    me.mover.mode = 'air';
    me.char.setVisible(false);
  };
  // simulation time for the room and the bus
  if (room) {
    const base = room.now(), gt = g.time;
    room.now = () => base + (g.time - gt) * 1000;
  }
  let busT = 0;
  const oStart = g.bus.start.bind(g.bus);
  g.bus.start = (bus) => { busT = g.time - (bus.el || 0); M.busT = g.time; return oStart(bus); };
  const oUpd2 = g.update;
  g.update = (dt) => { if (g.bus.path) g.bus.t0 = performance.now() - (g.time - busT) * 1000; return oUpd2(dt); };
  // counters
  const oShot = g.spawnShot.bind(g);
  g.spawnShot = (a, cur, w, o, d, s) => {
    if (isBot(a.id)) {
      M.shots++;
      M.shotsBy[a.id] = (M.shotsBy[a.id] || 0) + 1;
      const t = a.brain && a.brain.target;
      if (t && Math.hypot(t.pos.x - a.pos.x, t.pos.z - a.pos.z) < 10) {
        M.nearShots++;
        // also weighted by trigger time (an SMG fires a dozen bullets in the time a pump fires one)
        const sec = 1 / Math.max(0.1, (w.rate || 1) * (w.burst || 1));
        M.nearSec += sec;
        if ((w.pellets || 1) > 1) { M.nearShotgun++; M.nearSgSec += sec; }
        else M.nearBy[a.hasShotgun && a.hasShotgun() ? `${cur.k}+sg` : cur.k] = (M.nearBy[a.hasShotgun && a.hasShotgun() ? `${cur.k}+sg` : cur.k] || 0) + 1;
      }
    }
    return oShot(a, cur, w, o, d, s);
  };
  const oDmg = g.on_dmg;
  g.on_dmg = function (m) {
    const a = g.bots.get(m.a);
    if (a && m.c !== 'storm' && m.c !== 'fall' && m.tg !== m.a) {
      if (a.far) M.farHits++;
      else { M.hits++; M.hitsBy[m.a] = (M.hitsBy[m.a] || 0) + 1; }
    }
    return oDmg.call(this, m);
  };
  if (g.on_win) { const oW = g.on_win; g.on_win = function (m) { M.win = { id: m.id, team: m.team, reason: m.reason, name: m.name, t: +simT().toFixed(0) }; return oW.call(this, m); }; }
  const oElim = g.on_elim;
  g.on_elim = function (m) {
    const V = g.bots.get(m.v), K = g.bots.get(m.k);
    M.elims.push({
      t: +simT().toFixed(1), v: m.v, k: m.k, c: m.c, bv: isBot(m.v), far: !!(V || {}).far, kfar: !!(K || {}).far,
      d: V && K ? Math.round(Math.hypot(V.pos.x - K.pos.x, V.pos.z - K.pos.z)) : -1,
      vItems: V && V.itemCount ? V.itemCount() : -1, kItems: K && K.itemCount ? K.itemCount() : -1,
      since: M.landT[m.v] !== undefined ? +(simT() - M.landT[m.v]).toFixed(0) : -1,
      w: K && K.current() ? K.current().k : '',
    });
    return oElim.call(this, m);
  };
  const oBuild = g.tryPlaceBuild.bind(g);
  g.tryPlaceBuild = (a) => { const r = oBuild(a); if (r && isBot(a.id)) { M.pieces++; if (a.far) M.piecesFar++; M.piecesBy[a.id] = (M.piecesBy[a.id] || 0) + 1; } return r; };
  const oHeal = g.reportHeal.bind(g);
  g.reportHeal = (a, k) => { if (isBot(a.id)) M.heals[a.id] = (M.heals[a.id] || 0) + 1; return oHeal(a, k); };
  const oChest = g.openChest.bind(g);
  g.openChest = (a, i) => { if (isBot(a.id) && !g.world.chestOpen.has(i)) M.chests++; return oChest(a, i); };
  const oGot = g.on_got;
  g.on_got = function (m) { if (isBot(m.id)) M.picks++; return oGot.call(this, m); };
  // modes: respawns, and what the mode's state says (scores, the hill, the lava, ...)
  M.respawns = 0; M.onHill = 0; M.hillSamples = 0; M.lavaGap = []; M.zombies = [];
  if (g.on_respawn) { const oR = g.on_respawn; g.on_respawn = function (m) { if (isBot(m.id)) M.respawns++; return oR.call(this, m); }; }
  const regionOf = (x, z) => {
    const d = g.world.data;
    if (typeof d.regionAt === 'function') { const r = d.regionAt(x, z); return r ? r.name : ''; }
    let best = '', bd = Infinity;
    for (const r of d.regions || d.pois || []) { const dd = Math.hypot(r.x - x, r.z - z); if (dd < (r.r || 55) * 1.3 && dd < bd) { bd = dd; best = r.name; } }
    return best;
  };
  // once a simulated second: stuck, landings, alive counts
  M.sample = () => {
    if (M.t0 < 0) return;
    const t = simT();
    for (const b of g.bots.values()) {
      if (!b.alive || b.inBus) continue;
      const m = b.mode;
      const h = (M.hist[b.id] = M.hist[b.id] || []);
      if (m === 'skydive' || m === 'glide') { h.length = 0; continue; }
      if (!M.land[b.id]) { M.land[b.id] = regionOf(b.pos.x, b.pos.z) || '(open)'; M.landT[b.id] = t; }
      const bm = b.brain.mode;
      const moving = (bm === 'travel' || bm === 'investigate' || bm === 'flee') && b.brain.moving;
      h.push([b.pos.x, b.pos.z, moving ? 1 : 0]);
      if (h.length > 11) h.shift();
      M.botSamples++;
      if (b.far) M.farSamples++;
      if (h.length === 11 && h.every((s) => s[2])) {
        const d = Math.hypot(h[10][0] - h[0][0], h[10][1] - h[0][1]);
        if (d < 2) {
          M.stuckSamples++;
          const key = `${b.far ? 'far:' : ''}${bm}/${b.brain.destKind || '-'}/${b.follow && b.follow.routed ? 'route' : 'direct'}`;
          (M.stuckBy || (M.stuckBy = {}))[key] = ((M.stuckBy || {})[key] || 0) + 1;
          if (cfg.log && M.stuckSamples % 10 === 1) {
            const f = b.follow;
            console.log('stuck', b.name, key, b.pos.x.toFixed(1), b.pos.y.toFixed(1), b.pos.z.toFixed(1), 'dest', b.brain.dest.x.toFixed(0), b.brain.dest.y.toFixed(0), b.brain.dest.z.toFixed(0),
              'wp', f ? `${f.i}/${f.pts ? f.pts.length / 4 : 0} t ${f.tx.toFixed(0)},${f.tz.toFixed(0)} stuckN ${f.stuckN} stall ${f.progT.toFixed(1)}` : '', 'mode', b.mode, 'spd', b.speed.toFixed(1));
          }
        }
      }
      M.samples++;
      M.modeHist[b.far ? `far:${bm}` : bm] = (M.modeHist[b.far ? `far:${bm}` : bm] || 0) + 1;
      if (b.hasShotgun && b.hasShotgun()) M.shotgunHeld++;
    }
    // alive 60 s after the last landing, and who is alive 2 minutes in (for heals)
    const landed = Object.keys(M.landT).length;
    let alive = 0;
    for (const b of g.bots.values()) if (b.alive) alive++;
    if (M.alive120 === null && t >= 120) M.alive120 = [...g.bots.values()].filter((b) => b.alive).map((b) => b.id);
    const lastLand = landed ? Math.max(...Object.values(M.landT)) : -1;
    const everyone = landed >= [...g.bots.values()].filter((b) => b.alive || M.landT[b.id] !== undefined).length;
    if (M.alive60 === null && everyone && lastLand >= 0 && t >= lastLand + 60) M.alive60 = { t: +t.toFixed(0), lastLand: +lastLand.toFixed(1), alive, of: g.bots.size };
    if (Math.floor(t) % 15 === 0) M.timeline.push([Math.floor(t), alive, M.pieces, M.shots, M.elims.length]);
    const gs = g.modeState && g.modeState.g;
    if (gs && gs.hill) {
      for (const b of g.bots.values()) {
        if (!b.alive) continue;
        M.hillSamples++;
        if (Math.hypot(b.pos.x - gs.hill.x, b.pos.z - gs.hill.z) < gs.hill.r) M.onHill++;
      }
    }
    if (gs && Number.isFinite(gs.lava)) {
      let lo = Infinity;
      for (const b of g.bots.values()) if (b.alive) lo = Math.min(lo, b.pos.y - gs.lava);
      if (lo < Infinity) M.lavaGap.push(+lo.toFixed(1));
    }
    if (g.roles && g.roles.size) M.zombies.push([...g.roles.values()].filter((r) => r === 'zombie').length);
  };
  M.summary = () => {
    const nav = [...g.bots.values()][0]?.nav;
    const heals120 = M.alive120 ? M.alive120.map((id) => M.heals[id] || 0) : [];
    const ids = [...g.bots.values()].map((b) => b.id);
    const skillOf = {};
    for (const b of g.bots.values()) skillOf[b.id] = { skill: +b.brain.skill.toFixed(2), easy: !!b.brain.easy, persona: b.brain.persona.key };
    return {
      size: g.world.data.size, bots: g.bots.size, simSeconds: +simT().toFixed(0), phase: g.phase, alive: [...g.bots.values()].filter((b) => b.alive).length,
      stuckPct: +(100 * M.stuckSamples / Math.max(1, M.samples)).toFixed(2),
      pieces: M.pieces, piecesFar: M.piecesFar, piecesBots: Object.keys(M.piecesBy).length,
      shots: M.shots, nearShots: M.nearShots, nearShotgun: M.nearShotgun, nearSec: +M.nearSec.toFixed(2), nearSgSec: +M.nearSgSec.toFixed(2), shotgunNearPct: +(100 * M.nearShotgun / Math.max(1, M.nearShots)).toFixed(1), shotgunNearTimePct: +(100 * M.nearSgSec / Math.max(1e-6, M.nearSec)).toFixed(1),
      shotgunHeldPct: +(100 * M.shotgunHeld / Math.max(1, M.samples)).toFixed(1), nearBy: M.nearBy,
      heals: Object.values(M.heals).reduce((s, x) => s + x, 0),
      alive120: heals120.length, healsPerSurvivor: heals120.length ? +(heals120.reduce((s, x) => s + x, 0) / heals120.length).toFixed(2) : null,
      survivorsHealed: heals120.filter((x) => x > 0).length,
      alive60: M.alive60, alive60Pct: M.alive60 ? +(100 * M.alive60.alive / M.alive60.of).toFixed(1) : null,
      regions: [...new Set(Object.values(M.land))].filter((r) => r !== '(open)').length, landings: M.land,
      chests: M.chests, picks: M.picks, hits: M.hits, farHits: M.farHits, hitRate: +(M.hits / Math.max(1, M.shots)).toFixed(3),
      elims: M.elims.length, elimTimes: M.elims.map((e) => e.t), elimList: M.elims, byCause: M.elims.reduce((o, e) => { o[e.c || 'shot'] = (o[e.c || 'shot'] || 0) + 1; return o; }, {}),
      farElims: M.elims.filter((e) => e.far).length,
      farPct: +(100 * M.farSamples / Math.max(1, M.botSamples)).toFixed(1),
      botMsPerFrame: +(M.botMs / Math.max(1, M.frames)).toFixed(3), botMaxMs: +M.botMax.toFixed(2), updMsPerFrame: +(M.updMs / Math.max(1, M.frames)).toFixed(2),
      frames: M.frames,
      modes: M.modeHist, stuckBy: M.stuckBy || {},
      mats: [...g.bots.values()].filter((b) => b.alive).map((b) => b.totalMats()),
      survivors: [...g.bots.values()].filter((b) => b.alive).map((b) => ({
        id: b.id, hp: Math.round(b.hp), sh: Math.round(b.sh), far: !!b.far, mode: b.brain.mode, heals: M.heals[b.id] || 0,
        inv: b.inv.slots.slice(1).map((x) => (x ? `${x.k}${x.n ? `x${x.n}` : ''}` : '-')).join(' '),
      })),
      nav: nav ? { buildMs: +nav.buildMs.toFixed(1), queries: nav.stats.queries, cacheHits: nav.stats.hits, avgMs: +(nav.stats.ms / Math.max(1, nav.stats.queries)).toFixed(3), maxMs: +nav.stats.maxMs.toFixed(2), fails: nav.stats.fails, flows: nav.stats.flows, flowMs: +nav.stats.flowMs.toFixed(1), padsOn: nav.padsOn, kb: Math.round(nav.bytes() / 1024) } : null,
      hitsBy: M.hitsBy, shotsBy: M.shotsBy, skillOf, ids, timeline: M.timeline,
      mode: g.rules ? { win: g.rules.win, build: g.rules.build, pvp: g.rules.pvp, botSkill: g.rules.botSkill, teams: g.rules.teams, modeId: g.settingsState && g.settingsState.modeId } : null,
      modeState: g.modeState ? { sc: g.modeState.sc, g: g.modeState.g, tl: g.modeState.tl } : null,
      respawns: M.respawns, onHillPct: M.hillSamples ? +(100 * M.onHill / M.hillSamples).toFixed(1) : null,
      lavaGapMin: M.lavaGap.length ? Math.min(...M.lavaGap) : null, zombies: M.zombies.length ? M.zombies.filter((_, i) => i % 15 === 0) : null,
      winner: M.win || null,
    };
  };
}

// ------------------------------------------------------------------ one match
async function runMatch(browser, url, cfg) {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  const errors = [], offline = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
  // web fonts from the internet can't load in a sandbox: not a page error
  page.on('requestfailed', (r) => { if (!/^http:\/\/127\.0\.0\.1/.test(r.url())) offline.push(r.url()); });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      if (/Failed to load resource/.test(m.text()) && offline.length) return;
      errors.push(`[console.error] ${m.text()}`);
    } else if (cfg.log && m.type() === 'log') console.log('  [page]', m.text());
  });
  await page.addInitScript(() => {
    try { localStorage.setItem('phortnite.settings', JSON.stringify({ name: 'Observer', skin: 1, quality: 'low', autoFire: false, music: 0 })); } catch (e) { /* private */ }
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__phortnite && window.__phortnite.world, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const app = window.__phortnite;
    const g = app.game;
    if (!(g && g.me && g.phase === 'lobby') && typeof app.playSolo === 'function') await app.playSolo();
  });
  await page.waitForFunction(() => { const g = window.__phortnite.game; return g && g.me && g.phase === 'lobby'; }, null, { timeout: 120000 });
  await page.evaluate(pageSetup, cfg);
  // the mode and the bots' difficulty (rooms with the mode engine), then the match
  await page.evaluate((cfg) => {
    const g = window.__phortnite.game;
    if (cfg.mode) g.send({ t: 'mode', id: cfg.mode });
    g.send({ t: 'tweak', bots: cfg.bots, ...(cfg.skill ? { botSkill: cfg.skill } : {}) });
    window.__phortnite.simSteps = cfg.steps;
  }, cfg);
  await page.waitForTimeout(300);
  await page.evaluate((cfg) => window.__phortnite.game.startMatch(cfg.bots, 0), cfg);
  await page.waitForFunction((n) => { const g = window.__phortnite.game; return (g.phase === 'bus' || g.phase === 'match') && g.bots.size >= Math.min(n, 1); }, cfg.bots, { timeout: 120000 });
  await page.evaluate((cfg) => {
    const g = window.__phortnite.game, M = window.__M;
    M.patchBots();
    // no mode engine to roll the bots' skills from the difficulty: give every bot a skill from the
    // asked level ourselves (the room may still have taken rules.botSkill, which the brains read)
    const room = g.net && g.net.room;
    const rolled = room && [...room.players.values()].some((p) => p.bot && p.skill !== undefined);
    if (cfg.skill && !rolled) {
      if (g.rules) g.rules.botSkill = cfg.skill;
      let i = 0;
      for (const b of g.bots.values()) {
        const lvl = cfg.skill === 'mixed' ? ['easy', 'normal', 'hard'][i++ % 3] : cfg.skill;
        const s = lvl === 'easy' ? 0.15 + Math.random() * 0.3 : lvl === 'hard' ? 0.6 + Math.random() * 0.35 : b.brain.skill;
        b.configure(s);
      }
    }
    if (g.me.inBus) g.dropFromBus(g.me);
    M.t0 = g.time;
  }, cfg);
  const t0 = Date.now();
  let lastLog = -99;
  for (;;) {
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => {
      const g = window.__phortnite.game, M = window.__M;
      // sample once per simulated second (catch up if the page ran ahead)
      const t = g.time - M.t0;
      while ((M.lastS ?? -1) + 1 <= t) { M.lastS = (M.lastS ?? -1) + 1; M.sample(); }
      let alive = 0;
      for (const b of g.bots.values()) if (b.alive) alive++;
      return { t, phase: g.phase, alive, pieces: M.pieces, shots: M.shots, elims: M.elims.length };
    });
    if (s.t - lastLog >= 30) {
      lastLog = s.t;
      console.log(`  t=${s.t.toFixed(0)}s ${s.phase} alive ${s.alive} pieces ${s.pieces} shots ${s.shots} elims ${s.elims} (${((Date.now() - t0) / 1000).toFixed(0)} s real)`);
    }
    if (s.t > cfg.minutes * 60 || (s.phase !== 'match' && s.phase !== 'bus') || s.alive <= (cfg.perf ? 0 : 1)) break;
    if (Date.now() - t0 > cfg.timeoutMin * 60000) { console.log('  (real-time limit reached)'); break; }
  }
  const sum = await page.evaluate(() => window.__M.summary());
  sum.errors = errors.length;
  sum.errorList = errors.slice(0, 8);
  sum.offline = [...new Set(offline)].slice(0, 4);
  sum.realSeconds = Math.round((Date.now() - t0) / 1000);
  await page.close();
  return sum;
}

// ------------------------------------------------------------------ the audit's cost measurement
async function runCost(browser, url) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => {
    try { localStorage.setItem('phortnite.settings', JSON.stringify({ name: 'Cost', skin: 1, quality: 'low', autoFire: false, music: 0 })); } catch (e) { /* private */ }
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__phortnite && window.__phortnite.world, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const app = window.__phortnite, g = app.game;
    if (!(g && g.me && g.phase === 'lobby') && typeof app.playSolo === 'function') await app.playSolo();
  });
  await page.waitForFunction(() => { const g = window.__phortnite.game; return g && g.me && g.phase === 'lobby'; }, null, { timeout: 120000 });
  await page.evaluate(() => { window.__phortnite.renderer.render = () => {}; });
  const out = {};
  for (const n of [0, 10, 30]) {
    await page.evaluate((nn) => { const g = window.__phortnite.game; g.send({ t: 'tweak', bots: nn }); g.startMatch(nn, 0); }, n);
    await page.waitForFunction(() => window.__phortnite.game.phase === 'bus', null, { timeout: 60000 });
    await page.evaluate(() => { const g = window.__phortnite.game; g.dropFromBus(g.me); for (const bt of g.bots.values()) g.dropFromBus(bt); });
    await page.evaluate(() => { const g = window.__phortnite.game; for (let i = 0; i < 40 * 60; i++) g.update(1 / 60); });
    const r = await page.evaluate(() => {
      const g = window.__phortnite.game, a = window.__phortnite;
      const t0 = performance.now();
      for (let i = 0; i < 600; i++) { g.update(1 / 60); a.world.update(1 / 60, a.camera, g.me.pos, g); }
      const ms = (performance.now() - t0) / 600;
      const far = [...g.bots.values()].filter((x) => x.far).length;
      return { msPerFrame: +ms.toFixed(2), bots: g.bots.size, alive: [...g.bots.values()].filter((x) => x.alive).length, far };
    });
    out[n] = r;
    console.log(`  cost ${n} bots: ${JSON.stringify(r)}`);
    await page.evaluate(() => { window.__phortnite.game.send({ t: 'end' }); });
    await page.waitForFunction(() => window.__phortnite.game.phase === 'lobby', null, { timeout: 60000 });
  }
  out.errors = errors;
  await page.close();
  return out;
}

// ------------------------------------------------------------------ targets
function verdict(runs, perf, skills, big) {
  const avg = (k) => runs.reduce((s, r) => s + (r[k] ?? 0), 0) / Math.max(1, runs.length);
  const out = {};
  if (runs.length) {
    out.stuckPct = [+avg('stuckPct').toFixed(2), '< 2', avg('stuckPct') < 2];
    out.pieces = [+avg('pieces').toFixed(0), '>= 120', avg('pieces') >= 120];
    // pooled over the runs (a run with a handful of close shots would swing an average)
    const sum = (k) => runs.reduce((s, r) => s + (r[k] ?? 0), 0);
    const pooled = (100 * sum('nearShotgun')) / Math.max(1, sum('nearShots'));
    out.shotgunNearPct = [+pooled.toFixed(1), `>= 30 (bullets; ${sum('nearShots')} shots under 10 m)`, pooled >= 30];
    const pt = (100 * sum('nearSgSec')) / Math.max(1e-6, sum('nearSec'));
    out.shotgunNearTimePct = [+pt.toFixed(1), '>= 30 (trigger time)', pt >= 30];
    const h = runs.filter((r) => r.healsPerSurvivor !== null);
    const hv = h.reduce((s, r) => s + r.healsPerSurvivor, 0) / Math.max(1, h.length);
    out.healsPerSurvivor = [+hv.toFixed(2), '>= 1', hv >= 1];
    const a = runs.filter((r) => r.alive60Pct !== null);
    const av = a.reduce((s, r) => s + r.alive60Pct, 0) / Math.max(1, a.length);
    out.alive60Pct = [+av.toFixed(1), '>= 55', av >= 55];
    const need = big ? 15 : 5;
    out.regions = [+avg('regions').toFixed(1), `>= ${need}`, avg('regions') >= need];
    out.errors = [runs.reduce((s, r) => s + r.errors, 0), '0', runs.every((r) => r.errors === 0)];
  }
  if (perf) out.botMsPerFrame30 = [perf.botMsPerFrame, '<= 2.5 (desktop; SwiftShader + shared CPU here)', perf.botMsPerFrame <= 2.5];
  if (skills) out.hitRatio = [skills.ratio, '<= 0.6', skills.ratio <= 0.6];
  return out;
}


async function main() {
  const { chromium } = await loadPlaywright();
  let server = null, url = URL0;
  if (!url) { server = await startServer(); url = `http://127.0.0.1:${server.address().port}/`; }
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const base = { bots: BOTS, minutes: MINUTES, steps: STEPS, mode: MODE, skill: SKILL, park: PARK, log: LOG, perf: false, timeoutMin: 60 };
  const report = { url, overlay: OVERLAY, runs: [], perf: null, skills: null, cost: null };
  try {
    if (COST) {
      console.log('cost: the audit\'s measurement (0 / 10 / 30 bots dropped with the player)');
      report.cost = await runCost(browser, url);
    }
    for (let i = 0; i < RUNS; i++) {
      console.log(`match ${i + 1}/${RUNS}: ${BOTS} bots, ${MINUTES} min${MODE ? `, mode ${MODE}` : ''}${SKILL ? `, ${SKILL} bots` : ''}, park ${PARK}`);
      const r = await runMatch(browser, url, base);
      report.runs.push(r);
      console.log(`  -> stuck ${r.stuckPct}%, pieces ${r.pieces}, shotgun<10m ${r.shotgunNearPct}% (time ${r.shotgunNearTimePct}%), heals/survivor ${r.healsPerSurvivor}, alive60 ${r.alive60Pct}%, regions ${r.regions}, far ${r.farPct}%, bot ${r.botMsPerFrame} ms/frame, errors ${r.errors}`);
      if (r.errors) console.log(r.errorList.join('\n'));
    }
    if (PERF) {
      const n = +PERF === 1 || PERF === true ? 30 : +PERF;
      console.log(`perf: ${n} bots, 3 min, park ${PARK}`);
      const r = await runMatch(browser, url, { ...base, bots: n, minutes: 3, perf: true });
      report.perf = r;
      console.log(`  -> bot ${r.botMsPerFrame} ms/frame (max ${r.botMaxMs} ms one bot), whole update ${r.updMsPerFrame} ms, far ${r.farPct}%, errors ${r.errors}`);
    }
    if (SKILLS) {
      const res = {};
      for (const lvl of ['easy', 'hard']) {
        console.log(`skills: ${lvl} bots`);
        const r = await runMatch(browser, url, { ...base, skill: lvl, minutes: Math.min(MINUTES, 4) });
        res[lvl] = { shots: r.shots, hits: r.hits, hitRate: r.hitRate, errors: r.errors };
        console.log(`  -> ${r.hits} hits / ${r.shots} shots = ${r.hitRate}`);
      }
      res.ratio = +(res.easy.hitRate / Math.max(1e-6, res.hard.hitRate)).toFixed(3);
      report.skills = res;
    }
  } finally {
    await browser.close();
    if (server) server.close();
  }
  const big = report.runs.some((r) => r.size > 1000);
  report.verdict = verdict(report.runs, report.perf, report.skills, big);
  if (report.cost && report.cost[30]) report.verdict.cost30 = [report.cost[30].msPerFrame, '<= 2.5 (desktop; audit before: 4.36)', report.cost[30].msPerFrame <= 2.5];
  console.log('VERDICT', JSON.stringify(report.verdict, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
