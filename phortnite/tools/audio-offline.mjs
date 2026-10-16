// Offline loudness / direction check of the game's procedural sounds (public/js/audio.js).
// Renders each sound through the real Sfx graph (make-up gain, compressor, limiter, HRTF panner)
// on an OfflineAudioContext in headless Chromium and checks the mix targets:
//   - your own AR: -20 +-3 dB RMS (loudest 300 ms window), peak <= -1 dBFS
//   - the body-hit tick is at least as loud as your own gunshot (loudest 50 ms window)
//   - an enemy footstep 15 m away is within 15 dB of your own AR
//   - the same footstep in front vs behind: spectral centroid differs by more than 30%
//   - breaking an enemy's shield is ~3 dB over your own gunshot
// No server needed: the page and audio.js are served straight from public/ by Playwright.
//
//   node tools/audio-offline.mjs [--json out.json]
// Needs Playwright (PLAYWRIGHT=/path/to/playwright/index.mjs, default: the global install).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PW = process.env.PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.route('http://phortnite.test/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>audio</title>' });
  const f = path.join(ROOT, path.normalize(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(f) });
});
await page.goto('http://phortnite.test/');

const res = await page.evaluate(async () => {
  const { Sfx } = await import('/js/audio.js');
  const SR = 44100;
  const db = (x) => +(10 * Math.log10(x + 1e-12)).toFixed(1);
  // in-place radix-2 FFT (re, im of length n = 2^k)
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  // sounds start LEAD s into the render: the compressor and limiter have settled by then, like in a
  // running game (a sound at t = 0 meets them in their start-up state and measures ~8 dB too quiet)
  const LEAD = 0.4;
  /** Render fn(sfx) through the real Sfx graph; listener at the origin facing -z (yaw 0). */
  async function render(fn, secs = 1.2) {
    const s = new Sfx({ volume: 0.8, music: 0.5 });
    const off = new OfflineAudioContext(2, Math.round(SR * (secs + LEAD)), SR);
    const orig = window.AudioContext;
    window.AudioContext = function () { return off; };
    s.init();
    window.AudioContext = orig;
    s.ok = () => true;
    s.setListener({ x: 0, y: 0, z: 0 }, 0);
    s.setListenerPitch(0);
    off.suspend(LEAD).then(() => { fn(s); off.resume(); });
    const buf = await off.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let pk = 0, sl = 0, sr = 0;
    const m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) {
      m[i] = (L[i] * L[i] + R[i] * R[i]) / 2;
      sl += L[i] * L[i]; sr += R[i] * R[i];
      pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    }
    const win = (w) => {
      const n = Math.round(SR * w);
      let best = 0, acc = 0;
      for (let i = 0; i < m.length; i++) { acc += m[i]; if (i >= n) acc -= m[i - n]; if (i >= n - 1) best = Math.max(best, acc / n); }
      return best;
    };
    // spectral centroid of the mono mix over 8192 samples from the sound's onset
    const N = 8192, re = new Float64Array(N), im = new Float64Array(N);
    let on = Math.round(SR * LEAD);
    while (on < L.length && Math.abs(L[on]) + Math.abs(R[on]) < pk * 0.02) on++;
    for (let i = 0; i < N && on + i < L.length; i++) re[i] = (L[on + i] + R[on + i]) * 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    let num = 0, den = 0;
    for (let k = 1; k < N / 2; k++) { const mag = Math.hypot(re[k], im[k]); num += mag * k * SR / N; den += mag; }
    return { rmsDb: db(win(0.3)), shortDb: db(win(0.05)), peak: +pk.toFixed(3), peakDb: db(pk * pk), L: db(sl / L.length), R: db(sr / R.length), centroid: Math.round(num / (den || 1)) };
  }
  const P = (x, z) => ({ x, y: 0, z });
  const out = {};
  out.ownAR = await render((s) => s.shot('ar', null, true));
  out.ownPump = await render((s) => s.shot('shotgun', null, true));
  out.ownSniper = await render((s) => s.shot('sniper', null, true), 1.5);
  out.ownARburst5 = await render((s) => { for (let i = 0; i < 5; i++) { s.shot('ar', null, true); } }); // worst case: 5 at once
  out.hitBody = await render((s) => s.hitmarker(false, false, false), 0.5);
  out.hitShield = await render((s) => s.hitmarker(false, true, false), 0.5);
  out.hitHead = await render((s) => s.hitmarker(true, false, false), 0.5);
  out.hitKill = await render((s) => s.hitmarker(false, false, true), 0.8);
  out.shieldCrack = await render((s) => s.shieldCrack(), 0.8);
  out.enemyAR_15m_front = await render((s) => s.shot('ar', P(0, -15), false));
  out.enemyAR_15m_behind = await render((s) => s.shot('ar', P(0, 15), false));
  out.enemyAR_15m_right = await render((s) => s.shot('ar', P(15, 0), false));
  out.enemyAR_60m = await render((s) => s.shot('ar', P(0, -60), false));
  out.enemyAR_150m = await render((s) => s.shot('ar', P(0, -150), false), 1.5);
  out.enemyAR_280m = await render((s) => s.shot('ar', P(0, -280), false), 2);
  out.ownStep = await render((s) => s.step(null, 'grass', true), 0.4);
  out.enemyStep_5m = await render((s) => s.step(P(0, -5), 'grass', false), 0.4);
  out.enemyStep_15m_front = await render((s) => s.step(P(0, -15), 'grass', false), 0.4);
  out.enemyStep_15m_behind = await render((s) => s.step(P(0, 15), 'grass', false), 0.4);
  out.enemyStep_15m_left = await render((s) => s.step(P(-15, 0), 'grass', false), 0.4);
  out.enemyStep_30m = await render((s) => s.step(P(0, -30), 'grass', false), 0.4);
  out.enemyStep_44m = await render((s) => s.step(P(0, -44), 'grass', false), 0.4);
  for (const surf of ['wood', 'metal', 'sand', 'stone', 'snow']) out[`enemyStep_15m_${surf}`] = await render((s) => s.step(P(0, -15), surf, false), 0.4);
  out.jump = await render((s) => s.jump(), 0.4);
  out.land = await render((s) => s.land(15), 0.5);
  out.equipRifle = await render((s) => s.equip('ar'), 0.5);
  out.equipPump = await render((s) => s.equip('shotgun'), 0.5);
  out.buildOn = await render((s) => s.buildMode(true), 0.4);
  out.matSwitch = await render((s) => s.matSwitch('metal'), 0.4);
  out.siren = await render((s) => s.siren(true), 2.2);
  out.busHorn = await render((s) => s.ui('bus'), 1);
  out.heartbeat = await render((s) => s.heartbeat(0.8), 0.6);
  out.lowAmmo = await render((s) => s.lowAmmo(2), 0.3);
  out.elimStinger3 = await render((s) => s.elimStinger(3), 1.5);
  out.explosion_20m = await render((s) => s.explosion(P(0, -20)), 2);
  // 40 sounds at once: the voice cap keeps 28 and the limiter keeps the peak
  out.voiceFlood = await render((s) => { for (let i = 0; i < 40; i++) s.step(P(Math.sin(i) * 10, Math.cos(i) * 10), 'grass', false); s.shot('ar', null, true); return s; });
  {
    const s = new Sfx({ volume: 0.8 });
    const off = new OfflineAudioContext(2, SR, SR);
    const orig = window.AudioContext;
    window.AudioContext = function () { return off; };
    s.init();
    window.AudioContext = orig;
    s.ok = () => true;
    s.setListener({ x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 40; i++) s.step(P(Math.sin(i) * 10, Math.cos(i) * 10), 'grass', false);
    out.voicesAfter40 = s.voices.length;
  }
  return out;
});
await browser.close();

const r = res;
const checks = [
  ['own AR at -20 +-3 dB RMS', Math.abs(r.ownAR.rmsDb + 20) <= 3, `${r.ownAR.rmsDb} dB`],
  ['own AR peak <= -1 dBFS', r.ownAR.peakDb <= -1, `${r.ownAR.peakDb} dBFS`],
  ['5 ARs at once: peak <= -1 dBFS (limiter)', r.ownARburst5.peakDb <= -1, `${r.ownARburst5.peakDb} dBFS`],
  ['body hit tick >= own AR (50 ms window)', r.hitBody.shortDb >= r.ownAR.shortDb, `${r.hitBody.shortDb} vs ${r.ownAR.shortDb} dB`],
  ['enemy step 15 m within 15 dB of own AR', r.ownAR.rmsDb - r.enemyStep_15m_front.rmsDb <= 15, `${r.enemyStep_15m_front.rmsDb} vs ${r.ownAR.rmsDb} dB`],
  ['step front vs behind: centroid gap > 30%', r.enemyStep_15m_front.centroid > 1.3 * r.enemyStep_15m_behind.centroid, `${r.enemyStep_15m_front.centroid} vs ${r.enemyStep_15m_behind.centroid} Hz (${Math.round((r.enemyStep_15m_front.centroid / r.enemyStep_15m_behind.centroid - 1) * 100)}%)`],
  ['shield crack ~ +3 dB over own AR (+1..+6)', r.shieldCrack.shortDb - r.ownAR.shortDb >= 1 && r.shieldCrack.shortDb - r.ownAR.shortDb <= 6, `${(r.shieldCrack.shortDb - r.ownAR.shortDb).toFixed(1)} dB`],
  ['enemy step at 44 m still audible (> -60 dB)', r.enemyStep_44m.rmsDb > -60, `${r.enemyStep_44m.rmsDb} dB`],
  ['at most 28 voices', r.voicesAfter40 <= 28, `${r.voicesAfter40}`],
];
for (const [k, v] of Object.entries(r)) if (typeof v === 'object') console.log(k.padEnd(24), JSON.stringify(v));
console.log('voicesAfter40'.padEnd(24), r.voicesAfter40);
let bad = 0;
for (const [name, ok, val] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${val}`); if (!ok) bad++; }
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ results: r, checks: checks.map(([name, ok, val]) => ({ name, ok, val })) }, null, 1));
process.exit(bad ? 1 : 0);
