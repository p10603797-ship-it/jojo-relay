// Party / lobby networking regressions (2.0 final review): players removed for good after a rejoin
// hold, a P2P host who can never be kicked, the crown never going to a held player, roster floods,
// floor-loot floods and rejoins whose game is out of date. Room-level (the same Room runs in solo,
// on the Node server and on a P2P host). Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from './helpers/roomharness.mjs';
import { modeSettings, customSettings, LOOT_CAP } from '../public/shared/room.js';
import { HOLD_MS } from '../public/shared/plugins/party.js';

const RES = { resume: '' };

/** Make p a survivor / hider of a two-sided game (the roll may have picked them to hunt). */
function makeSide(R, p, team, hunterRole, other) {
  if (p.role === hunterRole) {
    R.runtime.setRole(p, null);
    R.runtime.setTeam(p, team);
    R.runtime.setArmor(p, 1);
    R.runtime.setTeam(other, 2);
    R.runtime.setRole(other, hunterRole);
  }
}

test('lobby-net: a held infection survivor whose hold runs out stops counting; the zombies win', () => {
  const H = makeRoom({ settings: modeSettings('infection'), drop: ['s'] });
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(a, { t: 'tweak', bots: 3 });
  H.send(a, { t: 'start' });
  H.advance(200);
  const R = H.room, ben = b.p;
  const bots = H.bots();
  makeSide(R, ben, 1, 'zombie', bots[0]);
  H.leave(b);
  assert.ok(ben.away > 0, 'held');
  H.advance(HOLD_MS + 500);
  assert.equal(R.players.has(ben.id), false);
  assert.equal(R.runtime.list.includes(ben), false, 'out of the mode list');
  // everyone else who is still a survivor gets infected
  for (const p of R.runtime.list) if (p.role !== 'zombie' && p.alive) R.eliminate(p, null, { c: 'storm' });
  H.advance(300);
  const win = H.last(a, 'win');
  assert.ok(win, 'the match is over');
  assert.equal(win.team, 2, 'the zombies won');
  assert.deepEqual(H.errors, []);
});

test('lobby-net: a held player killed while waiting to respawn is dropped for good; the last one standing wins', () => {
  const rules = { win: 'last', respawn: 12, lives: 2, storm: 'none', spawn: 'ground', bots: 0 };
  const H = makeRoom({ settings: customSettings(rules, 'Ghost'), drop: ['s'] });
  const a = H.join('Ann', RES), b = H.join('Ben', RES), c = H.join('Cat', RES);
  H.send(a, { t: 'start' });
  H.advance(500);
  const R = H.room, ben = b.p, cat = c.p;
  H.leave(b);
  H.advance(HOLD_MS - 5000);
  R.eliminate(ben, a.p, { w: 'ar' }); // shot standing there, 5 s before the hold runs out
  assert.ok(ben.respawnAt > 0, 'waiting to respawn');
  H.advance(6000);
  assert.equal(R.players.has(ben.id), false);
  assert.equal(R.runtime.list.includes(ben), false);
  const ms = H.last(a, 'ms');
  assert.ok(!ms || !ms.rs || ms.rs[ben.id] === undefined, 'no respawn timer for the dropped player');
  // Cat uses up both lives
  R.eliminate(cat, a.p, { w: 'ar' });
  H.advance(13000);
  assert.equal(cat.alive, true, 'respawned once');
  R.eliminate(cat, a.p, { w: 'ar' });
  H.advance(500);
  const win = H.last(a, 'win');
  assert.ok(win, 'Ann is the last one standing');
  assert.equal(win.id, a.pid);
  assert.equal(win.reason, 'last');
  assert.deepEqual(H.errors, []);
});

test('lobby-net: a hold that runs out in round 1 of a series never comes back as a ghost in round 2', () => {
  const H = makeRoom({ settings: modeSettings('box-fight'), drop: ['s'] });
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(a, { t: 'start' });
  H.advance(500);
  const R = H.room, ben = b.p;
  assert.ok(R.round, 'a best-of series');
  H.leave(b);
  H.advance(HOLD_MS + 500);
  assert.equal(R.runtime.list.includes(ben), false);
  // finish round 1: everyone not on Ann's team is eliminated
  for (const p of R.runtime.list) if (p.team !== a.p.team && p.alive) R.eliminate(p, a.p, { w: 'ar' });
  H.advance(6000);
  assert.ok(H.msgs(a, 'round').some((m) => m.start), 'round 2 started');
  assert.equal(R.runtime.list.includes(ben), false, 'not revived by nextRound');
  assert.ok(!R.runtime.list.some((p) => p.id === ben.id));
  assert.deepEqual(H.errors, []);
});

test('lobby-net: a P2P host can never be kicked (the party runs on their page); the kicker hears why', () => {
  const H = makeRoom();
  const host = H.conn('host');
  H.room.hostConn = 'host';
  H.join('Mia', RES, host);
  const b = H.join('Ben', RES);
  assert.equal(H.last(b, 'welcome').party.host, host.pid, 'everyone knows who hosts');
  H.send(host, { t: 'promote', id: b.pid });
  assert.equal(H.room.leader, b.pid);
  H.send(b, { t: 'kick', id: host.pid });
  assert.ok(H.room.players.has(host.pid), 'still in the party');
  assert.equal(H.last(host, 'kicked'), null);
  assert.match(H.last(b, 'note').msg, /host can't be removed/);
  // a server party (no host connection) kicks as before
  const S = makeRoom();
  const x = S.join('X', RES), y = S.join('Y', RES);
  S.send(x, { t: 'kick', id: y.pid });
  assert.equal(S.room.players.has(y.pid), false);
  assert.equal(S.last(x, 'welcome').party.host, undefined);
  assert.deepEqual([...H.errors, ...S.errors], []);
});

test('lobby-net: the crown never goes to a held player (PLAY works for whoever is here)', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES), c = H.join('Cat', RES);
  H.leave(b); // Ben's iPad locks: held
  assert.ok(b.p.away > 0);
  H.send(a, { t: 'bye' });
  H.leave(a); // Ann leaves on purpose
  assert.equal(H.room.leader, c.pid, 'Cat (here) leads, not Ben (away)');
  H.send(c, { t: 'start', cd: 1 });
  assert.equal(H.last(c, 'countdown').s, 3);
  // a newcomer to a party whose only member is held gets the crown, and keeps it when Ben is back
  const P = makeRoom();
  const x = P.join('X', RES);
  const tok = P.last(x, 'welcome').resume;
  P.leave(x);
  const y = P.join('Y', RES);
  assert.equal(P.room.leader, y.pid);
  P.join('X', { resume: tok, keep: true });
  assert.equal(P.room.leader, y.pid);
  assert.deepEqual([...H.errors, ...P.errors], []);
});

test('lobby-net: a flood of ready toggles sends at most ~10 rosters a second, and the last state wins', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.clear(a);
  for (let i = 0; i < 400; i++) {
    H.send(b, { t: 'ready', on: i % 2 === 0 });
    if (i % 40 === 39) H.advance(100);
  }
  H.advance(1000);
  const rosters = H.msgs(a, 'roster');
  assert.ok(rosters.length <= 25, `${rosters.length} rosters`);
  assert.equal(b.p.ready, false);
  assert.equal(H.last(a, 'roster').players.find((p) => p.id === b.pid).ready, false, 'the last roster has the final state');
  assert.deepEqual(H.errors, []);
});

test('lobby-net: dropped items land where the dropper is, and the floor loot is capped', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES);
  H.send(a, { t: 'u', s: [10, 5, 20, 0, 0, 0, 0, 0, 0, 'pickaxe', 0] });
  H.clear(a);
  H.send(a, { t: 'dropi', items: [{ k: 'ar', r: 1, m: 30 }], x: 9000, y: 1e9, z: -9000 });
  const l = H.last(a, 'l+').items[0];
  assert.ok(Math.hypot(l.x - 10, l.z - 20) < 2 && Math.abs(l.y - 5) < 1, JSON.stringify(l));
  // at most 60 items a second per player
  let n = 0;
  for (let i = 0; i < 20; i++) H.send(a, { t: 'dropi', items: Array.from({ length: 12 }, () => ({ k: 'medium', n: 30 })), x: 10, y: 5, z: 20 });
  n = H.msgs(a, 'l+').reduce((s, m) => s + m.items.length, 0);
  assert.ok(n <= 60, `${n} items in one second`);
  // and never more than LOOT_CAP on the floor
  for (let s = 0; s < 120 && H.room.loot.size < LOOT_CAP; s++) {
    H.advance(1001);
    for (let i = 0; i < 5; i++) H.send(a, { t: 'dropi', items: Array.from({ length: 12 }, () => ({ k: 'medium', n: 30 })), x: 10, y: 5, z: 20 });
  }
  for (let s = 0; s < 5; s++) { H.advance(1001); H.send(a, { t: 'dropi', items: [{ k: 'light', n: 5 }], x: 10, y: 5, z: 20 }); }
  assert.ok(H.room.loot.size <= LOOT_CAP);
  assert.deepEqual(H.errors, []);
});

test('lobby-net: a rejoin whose game is out of date (the match started, or I respawned, while away) gets a full welcome', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  const tok = H.last(b, 'welcome').resume;
  H.leave(b); // Ben's iPad locks in the lobby
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  assert.equal(H.room.phase, 'bus');
  // Ben's page still shows the lobby (match 0, not live)
  const b2 = H.join('Ben', { resume: tok, keep: { match: 0, live: false, alive: true } });
  assert.equal(H.last(b2, 'resumed'), null);
  const w = H.last(b2, 'welcome');
  assert.ok(w && w.resumed && w.phase === 'bus' && w.me.alive && w.me.inBus, 'a full welcome: the page rebuilds into the bus');
  // a page that is up to date keeps its game
  H.leave(b2);
  const b3 = H.join('Ben', { resume: tok, keep: { match: H.room.match, live: true, alive: true } });
  assert.ok(H.last(b3, 'resumed'));
  // dead on the page, alive again in the room (respawned while away): a full welcome
  H.leave(b3);
  const b4 = H.join('Ben', { resume: tok, keep: { match: H.room.match, live: true, alive: false } });
  assert.equal(H.last(b4, 'resumed'), null);
  assert.ok(H.last(b4, 'welcome').resumed);
  // keep: true (older pages) is always 'resumed'
  H.leave(b4);
  const b5 = H.join('Ben', { resume: tok, keep: true });
  assert.ok(H.last(b5, 'resumed'));
  assert.deepEqual(H.errors, []);
});

test('lobby-net: emotes are limited to 4 a second per player', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  for (let i = 0; i < 50; i++) H.send(a, { t: 'emote', e: 1 });
  assert.equal(H.msgs(b, 'emote').length, 1);
  H.advance(300);
  H.send(a, { t: 'emote', e: 2 });
  assert.equal(H.msgs(b, 'emote').length, 2);
  assert.deepEqual(H.errors, []);
});

// ------------------------------------------------------------------ the page side (PartyBridge)
import { PartyBridge } from '../public/js/lobby/bridge.js';
import { normalizeRules } from '../public/shared/modes/rules.js';

/** A page's game, as much of it as PartyBridge.resumed touches; app records onNet and countdowns. */
function pageGame(myId, phase, meAlive) {
  const cds = [], nets = [];
  const g = {
    myId, phase, rules: normalizeRules({}), settingsState: {}, modeState: {}, partyInfo: {},
    roles: new Map(), roster: new Map(), remotes: new Map(), bots: new Map(), teams: new Map(),
    me: { id: myId, alive: meAlive, hp: 100, sh: 100, inBus: false },
    world: { restoreAll() {}, destroyObject() {}, setChestOpen() {} },
    builds: { clear() {}, add() {} }, pendingBuilds: new Set(), loot: { set() {} },
    roleOf() { return null; }, setTeams() {}, onMessage() {}, ensureRemote() {}, onMyDeath() {}, plug() {},
    applyMode() {}, giveLoadout() {},
  };
  g.app = {
    lobby: { render() {}, toast() {}, countdown(m) { cds.push(m); } }, stage: {}, onWelcome() {},
    onNet(game, m) { nets.push(m); },
  };
  return { g, cds, nets };
}

test('lobby-net: a page that missed the start (still in the lobby) or a respawn rebuilds from the resumed state', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  const tok = H.last(b, 'welcome').resume;
  H.leave(b);
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  const m = H.last(H.join('Ben', { resume: tok, keep: true }), 'resumed');
  assert.ok(m && m.phase === 'bus');
  // the page is on the lobby stage: a fresh game from this state ('fresh' -> enterParty -> revive in the bus)
  const lobbyPage = pageGame(b.pid, 'lobby', true);
  new PartyBridge(lobbyPage.g).resumed(m);
  assert.equal(lobbyPage.nets.length, 1);
  assert.equal(lobbyPage.nets[0].state, 'fresh');
  assert.equal(lobbyPage.nets[0].msg.t, 'welcome');
  assert.ok(lobbyPage.nets[0].msg.resumed && lobbyPage.nets[0].msg.me.alive);
  // dead on the death card, alive in the room (respawned while away)
  const deadPage = pageGame(b.pid, 'match', false);
  new PartyBridge(deadPage.g).resumed({ ...m, phase: 'match' });
  assert.equal(deadPage.nets.length, 1);
  // up to date: patched in place, and a countdown missed while away is cleared
  const okPage = pageGame(b.pid, 'bus', true);
  new PartyBridge(okPage.g).resumed(m);
  assert.equal(okPage.nets.length, 0);
  assert.deepEqual(okPage.cds, [null]);
  assert.deepEqual(H.errors, []);
});

test('lobby-net: welcome / resumed show the room\'s countdown, or clear a stale one', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  const tok = H.last(b, 'welcome').resume;
  H.leave(b);
  H.send(a, { t: 'start', cd: 1 });
  H.advance(1000);
  const m = H.last(H.join('Ben', { resume: tok, keep: true }), 'resumed');
  const p = pageGame(b.pid, 'lobby', true);
  new PartyBridge(p.g).resumed(m);
  assert.equal(p.cds.length, 1);
  assert.equal(p.cds[0].s, 2, 'the 3-2-1 goes on where the room is');
  assert.ok(p.cds[0].ms > 1500 && p.cds[0].ms <= 2000);
  // a welcome into a party with no countdown clears whatever the page showed
  const q = pageGame(1, 'lobby', true);
  const pb = new PartyBridge(q.g);
  pb.syncCountdown({ phase: 'lobby', party: { cd: 0 } });
  assert.deepEqual(q.cds, [null]);
  assert.deepEqual(H.errors, []);
});
