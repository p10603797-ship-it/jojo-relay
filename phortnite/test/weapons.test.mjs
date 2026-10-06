// Gun handling: fire rates, bursts, reloads, camera recoil and the room accepting every gun.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { WEAPONS, WEAPON_KEYS, WEAPON_WEIGHTS, AMMO, weaponDamage, PROTOCOL } from '../public/shared/constants.js';
import { Room } from '../public/shared/room.js';
import { Recoil } from '../public/js/combat/recoil.js';

// the browser maps the bare 'rapier' import with an import map; do the same here so the real
// Combatant weapon code can run headless
register('data:text/javascript,' + encodeURIComponent(
  "export async function resolve(s, c, n) { return n(s === 'rapier' ? '@dimforge/rapier3d-compat' : s, c); }",
), import.meta.url);
const { Combatant } = await import('../public/js/actors/combatant.js');

const DT = 1 / 60;
const GUNS = WEAPON_KEYS;

/** A Combatant without a body or a game: just enough state for act() / fire(). */
function shooter(k, { bot = false, m } = {}) {
  const shots = [];
  const reloads = [];
  const c = Object.create(Combatant.prototype);
  Object.assign(c, {
    game: {
      spawnShot: (a, cur, w, origin, dirs) => shots.push({ t: a.time, k: cur.k, pellets: dirs.length / 3 }),
      onReload: (a) => reloads.push(a.time), onDryFire() {}, onSwing() {}, shotSeq: 0,
    },
    mover: { pos: { x: 0, y: 0, z: 0 }, mode: 'ground', grounded: true, crouch: false },
    id: 1, isBot: bot, alive: true, inBus: false, yaw: 0, pitch: 0,
    inv: { slots: [{ k: 'pickaxe', r: 0 }, { k, r: 2, m: m ?? WEAPONS[k].mag }, { k: 'ar', r: 0, m: 30 }, null, null, null], ammo: {}, mats: {}, sel: 1 },
    cool: 0, burstLeft: 0, burstT: 0, burstItem: null, bloom: 0, reloadT: -1, healT: -1, swingT: -1, lastShot: -10,
    time: 0, buildMode: false, ads: false, speed: 0, flags: 0, dancing: false, infinite: true,
  });
  for (const a of Object.keys(AMMO)) c.inv.ammo[a] = 0;
  return { c, shots, reloads };
}
const aim = { ox: 0, oy: 1.5, oz: 0, dx: 0, dy: 0, dz: -1, tx: 0, ty: 1.5, tz: -30 };
const ctl = (o = {}) => ({ fire: false, firePressed: false, ads: false, reload: false, ...o });
function run(c, secs, ctlAt) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) c.act(DT, ctlAt(i), aim);
}

test('every gun is complete and the room can carry it', () => {
  for (const k of GUNS) {
    const w = WEAPONS[k];
    assert.ok(w && !w.melee, k);
    for (const f of ['name', 'short', 'ammo', 'mag', 'rate', 'reload', 'speed', 'recoil', 'recover', 'recoverDelay', 'kick']) assert.ok(w[f] !== undefined, `${k}.${f}`);
    assert.ok(AMMO[w.ammo], `${k} ammo`);
    assert.equal(w.dmg.length, 5);
    assert.ok(w.rarities.every((r) => r >= 0 && r <= 4));
    assert.ok((w.pellets || 1) <= 10, 'the room relays at most 10 pellet directions');
    assert.ok(w.kick > 0 && w.kick <= 1);
    if (w.burst) assert.ok((w.burst - 1) * w.burstGap < 1 / w.rate, `${k} burst fits in its cycle`);
    assert.ok(WEAPON_WEIGHTS[k] > 0, `${k} drops as loot`);
  }
  for (const k of Object.keys(WEAPON_WEIGHTS)) assert.ok(GUNS.includes(k));
  // clearly different guns: no two share a fire rate or a reload time
  assert.equal(new Set(GUNS.map((k) => WEAPONS[k].rate)).size, GUNS.length);
  assert.equal(new Set(GUNS.map((k) => WEAPONS[k].reload)).size, GUNS.length);
  assert.ok(WEAPONS.smg.rate >= 2 * WEAPONS.ar.rate, 'the SMG shoots much faster than the AR');
  // the tactical trades damage per pellet for rate and magazine size
  assert.ok(weaponDamage('tactical', 2, 3, false) < weaponDamage('shotgun', 2, 3, false));
  assert.ok(WEAPONS.tactical.rate > WEAPONS.shotgun.rate && WEAPONS.tactical.mag > WEAPONS.shotgun.mag);
});

test('the room relays, scores and accepts the new guns', () => {
  let t = 1000;
  const room = new Room({ code: 'TEST', now: () => t });
  const inbox = {};
  const join = (id, name) => { inbox[id] = []; room.join({ id, send: (m) => inbox[id].push(m) }, { name, v: PROTOCOL }); return [...room.players.values()].find((p) => p.name === name); };
  const a = join('a', 'Ann');
  const b = join('b', 'Ben');
  room.message('a', { t: 'u', s: [1, 2, 3, 0, 0, 0, 0, 0, 1, 'burst:3', 0] });
  assert.equal(a.w, 'burst:3');
  room.message('a', { t: 'u', s: [1, 2, 3, 0, 0, 0, 0, 0, 1, 'tactical:1', 0] });
  assert.equal(a.w, 'tactical:1');
  room.message('a', { t: 'start', bots: 0, mats: 0 });
  room.message('a', { t: 'drop' });
  room.message('b', { t: 'drop' });
  const dirs = Array.from({ length: 10 }, () => [0, 0, -1]).flat();
  room.message('a', { t: 'sh', id: a.id, w: 'tactical', r: 1, o: [0, 1, 0], d: dirs });
  const sh = inbox.b.find((m) => m.t === 'sh');
  assert.ok(sh && sh.w === 'tactical' && sh.d.length === 30, 'all 10 pellets relayed');
  const hp = b.hp + b.sh;
  room.message('a', { t: 'hit', tg: b.id, w: 'burst', r: 2, d: 20, n: 1, nh: 0 });
  assert.equal(hp - (b.hp + b.sh), WEAPONS.burst.dmg[2]);
});

test('held fire keeps each gun at its own rate (exact at 60 fps)', () => {
  for (const k of ['smg', 'ar', 'pistol', 'tactical']) {
    const { c, shots } = shooter(k);
    const w = WEAPONS[k];
    // semi-autos fire when the trigger is pressed (auto-shoot presses it every frame)
    run(c, 3, () => ctl({ fire: true, firePressed: true }));
    const inMag = shots.filter((s) => s.t <= (w.mag - 1) / w.rate + 1e-6).length;
    // rounds fired in the first second of a fresh magazine
    const first = shots.filter((s) => s.t < 1 - 1e-9).length;
    assert.ok(Math.abs(first - Math.min(w.mag, Math.ceil(w.rate))) <= 1, `${k}: ${first} shots in 1 s at ${w.rate}/s`);
    assert.ok(inMag >= Math.min(w.mag, Math.floor(3 * w.rate)) - 1, `${k} keeps its cadence`);
  }
});

test('a semi-auto fires once per press for players, every ready frame for bots', () => {
  const { c, shots } = shooter('pistol');
  run(c, 1, (i) => ctl({ fire: true, firePressed: i === 0 }));
  assert.equal(shots.length, 1, 'holding the trigger fires a pistol once');
  const bot = shooter('pistol', { bot: true });
  run(bot.c, 1, () => ctl({ fire: true }));
  assert.equal(bot.shots.length, 6);
});

test('one pull of the burst rifle fires three rounds 0.07 s apart', () => {
  const { c, shots } = shooter('burst');
  run(c, 1, (i) => ctl({ fire: i === 0, firePressed: i === 0 }));
  assert.equal(shots.length, 3);
  const gaps = [shots[1].t - shots[0].t, shots[2].t - shots[1].t];
  for (const g of gaps) assert.ok(g > 0.06 && g < 0.09, `gap ${g}`);
  assert.equal(c.inv.slots[1].m, WEAPONS.burst.mag - 3);
  // holding: bursts at ~1.7/s
  const held = shooter('burst');
  run(held.c, 2, () => ctl({ fire: true }));
  const starts = held.shots.filter((s, i) => i === 0 || s.t - held.shots[i - 1].t > 0.2).length;
  assert.ok(starts >= 3 && starts <= 4, `${starts} bursts in 2 s`);
  assert.equal(held.shots.length % 3, 0);
  // bots and auto-shoot only hold fire + firePressed
  const bot = shooter('burst', { bot: true });
  run(bot.c, 1, () => ctl({ fire: true, firePressed: true }));
  assert.equal(bot.shots.length, 6);
});

test('a burst stops at an empty magazine or a weapon switch', () => {
  const { c, shots, reloads } = shooter('burst', { m: 2 });
  c.infinite = false;
  c.inv.ammo.medium = 30;
  run(c, 0.5, (i) => ctl({ fire: i === 0, firePressed: i === 0 }));
  assert.equal(shots.length, 2);
  assert.equal(reloads.length, 1, 'empty magazine starts the reload');
  const s2 = shooter('burst');
  s2.c.act(DT, ctl({ fire: true, firePressed: true }), aim);
  s2.c.select(2);
  run(s2.c, 0.5, () => ctl());
  assert.equal(s2.shots.length, 1);
});

test('reload takes each gun its own time', () => {
  for (const k of GUNS) {
    const { c, reloads } = shooter(k, { m: 0 });
    const w = WEAPONS[k];
    c.act(DT, ctl({ reload: true }), aim);
    assert.equal(reloads.length, 1);
    let t = 0;
    while (c.reloadT >= 0 && t < 10) { c.act(DT, ctl(), aim); t += DT; }
    assert.ok(Math.abs(t - w.reload) < 2 * DT, `${k} reload ${t.toFixed(2)} s vs ${w.reload}`);
    assert.equal(c.inv.slots[1].m, w.mag);
  }
});

// ------------------------------------------------------------------ camera recoil
function spray(k, secs, { mult = 1, pull = 0, after = 0 } = {}) {
  const w = WEAPONS[k];
  const r = new Recoil();
  let pitch = 0, yaw = 0, cool = 0, burstLeft = 0, burstT = 0, maxYaw = 0, peak = 0, rnd = 0.37;
  const rand = () => (rnd = (rnd * 9301 + 49297) % 233280 / 233280);
  const n = Math.round((secs + after) / DT);
  let atRelease = 0;
  for (let i = 0; i < n; i++) {
    const firing = i * DT < secs;
    cool = Math.max(-DT, cool - DT);
    const lp = firing ? -pull * DT : 0;
    pitch += lp;
    r.look(lp, 0);
    r.recover(DT);
    pitch += r.dp; yaw += r.dy;
    const kick = () => { r.kick(w, mult, rand); pitch += r.dp; yaw += r.dy; };
    if (burstLeft > 0) { burstT -= DT; if (burstT <= 0) { burstLeft--; burstT += w.burstGap; kick(); } }
    if (firing && cool <= 0 && burstLeft <= 0) { cool += 1 / w.rate; if (w.burst) { burstLeft = w.burst - 1; burstT = w.burstGap; } kick(); }
    if (i === Math.round(secs / DT) - 1) atRelease = pitch;
    peak = Math.max(peak, pitch);
    maxYaw = Math.max(maxYaw, Math.abs(yaw));
  }
  return { pitch, yaw, atRelease, peak, maxYaw };
}

test('AR spray climbs, levels off, and a slight pull-down keeps it on a body at 20 m', () => {
  const one = spray('ar', 1);
  assert.ok(one.atRelease > 0.025 && one.atRelease < 0.06, `1 s climb ${one.atRelease}`);
  const full = spray('ar', 30 / 5.5);
  assert.ok(full.atRelease < WEAPONS.ar.recoilMax * 1.1, `a whole magazine levels off (${full.atRelease.toFixed(3)})`);
  // ADS + crouch (0.75 * 0.8) lowers the climb in proportion
  const steady = spray('ar', 1, { mult: 0.6 });
  assert.ok(Math.abs(steady.atRelease / one.atRelease - 0.6) < 0.08, `ADS+crouch ${(steady.atRelease / one.atRelease).toFixed(2)}x`);
  // ADS, pulling down ~1.2 deg/s: aim stays within the body (0.7 m above / 1.2 m below the chest)
  const held = spray('ar', 30 / 5.5, { mult: 0.75, pull: 0.02 });
  const h = Math.tan(held.atRelease) * 20;
  assert.ok(h < 0.7 && h > -1.2, `aim ${h.toFixed(2)} m from the chest`);
  assert.ok(Math.tan(held.maxYaw) * 20 < 0.37, 'sideways drift stays on the body');
});

test('recoil recovers after firing stops, at each gun\'s pace', () => {
  for (const k of GUNS) {
    const r = new Recoil();
    r.kick(WEAPONS[k], 1, () => 0.5);
    const p0 = r.p;
    let t = 0;
    while (r.p > p0 * 0.1) { r.recover(DT); t += DT; }
    assert.ok(t >= 0.25 && t <= 0.62, `${k} single shot back in ${t.toFixed(2)} s`);
  }
  const ar = spray('ar', 1, { after: 0.5 });
  assert.ok(ar.pitch < ar.atRelease * 0.2, 'AR back near the start 0.5 s after release');
  const smg = spray('smg', 1, { after: 0.5 });
  assert.ok(smg.pitch < smg.atRelease * 0.1);
});

test('pulling down against the kick is not undone by recovery', () => {
  const r = new Recoil();
  for (let i = 0; i < 5; i++) r.kick(WEAPONS.ar, 1, () => 0.5);
  const owed = r.p;
  r.look(-owed * 0.6, 0); // player pulled down most of it
  let total = 0;
  for (let i = 0; i < 120; i++) { r.recover(DT); total += r.dp; }
  assert.ok(Math.abs(total + owed * 0.4) < 1e-3, 'only the rest is returned');
  // looking further up is kept: recovery still returns just the recoil
  const r2 = new Recoil();
  r2.kick(WEAPONS.pistol, 1, () => 0.5);
  const o2 = r2.p;
  r2.look(0.2, 0);
  let t2 = 0;
  for (let i = 0; i < 120; i++) { r2.recover(DT); t2 += r2.dp; }
  assert.ok(Math.abs(t2 + o2) < 1e-6);
});

test('every gun kicks differently: SMG jitters sideways, pump/sniper/rocket kick hard', () => {
  const v = (k) => WEAPONS[k].recoil;
  for (const k of ['shotgun', 'sniper', 'rocket', 'tactical']) assert.ok(v(k) > 2 * v('pistol'), k);
  assert.ok(v('smg') < v('ar') && WEAPONS.smg.recoilSide > v('smg'), 'SMG: small but jittery');
  const smg = spray('smg', 1);
  assert.ok(smg.maxYaw < 0.02, 'jitter stays centred');
  const burst = spray('burst', 1);
  assert.ok(burst.peak < spray('ar', 1).peak, 'burst kicks less than a spraying AR');
});
