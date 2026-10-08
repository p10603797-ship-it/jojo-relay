// Party plugin (shared/plugins/party.js) on the shared Room: the same code runs in solo, on the Node
// server and on a P2P host, so these Room-level tests cover all three. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from './helpers/roomharness.mjs';
import { HOLD_MS, COUNTDOWN_MS } from '../public/shared/plugins/party.js';
import { SKINS } from '../public/shared/constants.js';

// a party member whose page can rejoin (hello.resume is '' on a first join)
const RES = { resume: '' };

test('party: ready toggles in the lobby only and resets when the party is back in the lobby', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  assert.equal(b.p.ready, false);
  H.send(b, { t: 'ready', on: true });
  assert.equal(b.p.ready, true);
  assert.equal(H.last(a, 'roster').players.find((p) => p.id === b.pid).ready, true, 'friends see the tick');
  H.send(b, { t: 'ready', on: false });
  assert.equal(b.p.ready, false);
  H.send(b, { t: 'ready', on: true });
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  assert.equal(H.room.phase, 'bus');
  H.send(b, { t: 'ready', on: false });
  assert.equal(b.p.ready, true, 'no ready changes during a match');
  H.send(a, { t: 'end' });
  assert.equal(H.room.phase, 'lobby');
  assert.equal(b.p.ready, false, 'reset on lobby');
  assert.equal(H.last(a, 'lobby').players.find((p) => p.id === b.pid).ready, false);
  assert.deepEqual(H.errors, []);
});

test('party: look cleans and clamps junk input; skins change only in the lobby', () => {
  const H = makeRoom();
  const a = H.join('Ann', { ...RES, lvl: 12 }), b = H.join('Ben', RES);
  assert.equal(a.p.lvl, 12, 'hello.lvl');
  assert.equal(H.last(a, 'welcome').players.find((p) => p.id === a.pid).lvl, 12, 'the welcome roster has the level');
  const junk = [
    { name: '<b>Zoë</b>&"\'\u0001 is the very best player', skin: 99, lvl: 1e9 },
    { name: 42, skin: -5, lvl: -3 },
    { name: '   ', skin: 'x', lvl: NaN },
    { name: null, skin: 2.6, lvl: '7' },
    { skin: { toString: () => '3' } },
  ];
  const seen = [];
  for (const m of junk) {
    H.advance(150); // look is rate limited to one per 100 ms
    H.send(a, { t: 'look', ...m });
    const p = a.p;
    seen.push([p.name, p.skin, p.lvl]);
    assert.ok(typeof p.name === 'string' && p.name.length >= 1 && p.name.length <= 16 && !/[<>&"'\u0000-\u001f]/.test(p.name), p.name);
    assert.ok(Number.isInteger(p.skin) && p.skin >= 0 && p.skin < SKINS.length, String(p.skin));
    assert.ok(Number.isInteger(p.lvl) && p.lvl >= 1 && p.lvl <= 999, String(p.lvl));
  }
  assert.deepEqual(seen[0], ['bZoë/b is the ve', SKINS.length - 1, 999]);
  assert.deepEqual(seen[1], ['bZoë/b is the ve', 0, 1], 'a non-string name is ignored, numbers clamp');
  assert.deepEqual(seen[2], ['Player', 0, 1], 'a blank name becomes Player, junk numbers are ignored');
  assert.deepEqual(seen[3], ['Player', 3, 1], 'the skin rounds');
  assert.equal(H.last(b, 'roster').players.find((p) => p.id === a.pid).skin, 3, 'friends see the new skin');
  // the skin is locked during the match, the name is not
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  H.advance(150);
  H.send(a, { t: 'look', name: 'Annie', skin: 5 });
  assert.equal(a.p.skin, 3);
  assert.equal(a.p.name, 'Annie');
  // flooding: a second look within 100 ms is dropped
  H.send(a, { t: 'look', name: 'Spam' });
  assert.equal(a.p.name, 'Annie');
  assert.deepEqual(H.errors, []);
});

test('party: kick is leader-only and never yourself; the target gets kicked and leaves the roster', () => {
  const kicked = [];
  const H = makeRoom();
  H.room.onKick = (cid) => kicked.push(cid);
  const a = H.join('Ann', RES), b = H.join('Ben', RES), c = H.join('Cat', RES);
  assert.equal(H.room.leader, a.pid);
  H.send(b, { t: 'kick', id: c.pid });
  assert.ok(H.room.players.has(c.pid), 'a member cannot kick');
  H.send(a, { t: 'kick', id: a.pid });
  assert.ok(H.room.players.has(a.pid), 'self-kick is ignored');
  H.send(a, { t: 'kick', id: 999 });
  H.send(a, { t: 'kick', id: c.pid });
  assert.equal(H.room.players.has(c.pid), false);
  assert.equal(H.last(c, 'kicked').t, 'kicked');
  assert.ok(H.last(c, 'kicked').msg);
  assert.deepEqual(kicked, [c.id], 'the transport hears about it (server detaches the socket, P2P closes the channel)');
  assert.equal(H.room.conns.has(c.id), false);
  assert.ok(!H.last(a, 'roster').players.some((p) => p.id === c.pid), 'gone from the roster');
  // kicked during a match: eliminated at once, never held for a rejoin
  const d = H.join('Dan', RES);
  H.send(a, { t: 'start', bots: 2, mats: 0 });
  H.send(a, { t: 'kick', id: d.pid });
  assert.equal(H.room.players.has(d.pid), false);
  const e = H.msgs(a, 'elim').find((m) => m.v === d.pid);
  assert.ok(e && e.c === 'left');
  // bots can't be kicked
  const bot = H.bots()[0];
  H.send(a, { t: 'kick', id: bot.id });
  assert.ok(H.room.players.has(bot.id));
  assert.deepEqual(H.errors, []);
});

test('party: promote hands the crown to a connected member', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(b, { t: 'promote', id: b.pid });
  assert.equal(H.room.leader, a.pid, 'members cannot promote');
  H.send(a, { t: 'promote', id: b.pid });
  assert.equal(H.room.leader, b.pid);
  assert.equal(H.last(a, 'roster').leader, b.pid);
  assert.match(H.last(a, 'note').msg, /Ben is the party leader/);
  H.send(a, { t: 'promote', id: a.pid });
  assert.equal(H.room.leader, b.pid, 'the old leader has no say any more');
  assert.deepEqual(H.errors, []);
});

test('party: PLAY counts down 3 s, then the bus leaves (3000±60 ms); cancel stops it', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(b, { t: 'start', cd: 1 });
  assert.equal(H.msgs(a, 'countdown').length, 0, 'members cannot start');
  const t0 = H.now();
  H.send(a, { t: 'start', cd: 1, bots: 0, mats: 0 });
  const cd = H.last(b, 'countdown');
  assert.equal(cd.s, 3);
  assert.equal(cd.ms, COUNTDOWN_MS);
  assert.equal(H.room.phase, 'lobby');
  H.send(a, { t: 'start', cd: 1 });
  assert.equal(H.msgs(b, 'countdown').length, 1, 'a second PLAY does not restart it');
  // a late joiner sees how much is left
  H.advance(1000);
  const c = H.join('Cat', RES);
  assert.ok(Math.abs(H.last(c, 'welcome').party.cd - 2000) <= 50);
  let busAt = -1;
  for (let i = 0; i < 300 && busAt < 0; i++) {
    H.advance(10);
    if (H.room.phase === 'bus') busAt = H.now() - t0;
  }
  assert.ok(Math.abs(busAt - 3000) <= 60, `bus at ${busAt} ms`);
  for (const x of [a, b, c]) assert.equal(H.msgs(x, 'start').length, 1);
  // back to the lobby: cancel
  H.send(a, { t: 'end' });
  H.send(a, { t: 'start', cd: 1, bots: 0 });
  H.advance(1500);
  H.send(b, { t: 'cancel' });
  assert.equal(H.last(a, 'countdown').s, 3, 'members cannot cancel');
  H.send(a, { t: 'cancel' });
  assert.equal(H.last(b, 'countdown').s, 0);
  H.advance(5000);
  assert.equal(H.room.phase, 'lobby');
  // the leader leaving mid-countdown stops it
  H.send(a, { t: 'start', cd: 1, bots: 0 });
  H.leave(a);
  H.advance(3500);
  assert.equal(H.room.phase, 'lobby');
  assert.equal(H.last(b, 'countdown').s, 0);
  // an immediate start (PLAY AGAIN, older pages) still starts at once
  H.send(b, { t: 'start', bots: 0, mats: 0 });
  assert.equal(H.room.phase, 'bus');
  assert.deepEqual(H.errors, []);
});

test('party: a second suggestion within 3 s is dropped; suggestions reach the leader only', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES), c = H.join('Cat', RES);
  H.send(b, { t: 'suggest', id: 'gun-game' });
  assert.deepEqual(H.last(a, 'suggest'), { t: 'suggest', id: 'gun-game', from: b.pid });
  assert.equal(H.msgs(c, 'suggest').length, 0);
  H.advance(2900);
  H.send(b, { t: 'suggest', id: 'infection' });
  assert.equal(H.msgs(a, 'suggest').length, 1, 'dropped within 3 s');
  H.send(c, { t: 'suggest', id: 'duos' });
  assert.equal(H.msgs(a, 'suggest').length, 2, 'per player');
  H.advance(200);
  H.send(b, { t: 'suggest', id: 'infection' });
  assert.equal(H.msgs(a, 'suggest').length, 3);
  for (const bad of [{ id: '<script>' }, { id: 5 }, { id: 'x'.repeat(60) }, {}]) { H.advance(3100); H.send(c, { t: 'suggest', ...bad }); }
  assert.equal(H.msgs(a, 'suggest').length, 3, 'junk ids are ignored');
  H.send(a, { t: 'suggest', id: 'duos' });
  assert.equal(H.msgs(a, 'suggest').length, 3, 'the leader does not suggest to themselves');
  assert.deepEqual(H.errors, []);
});

test('party: map marks reach teammates only (everyone in the lobby), at most 4 per second', () => {
  const H = makeRoom({ settings: { mode: 'squad' } });
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(a, { t: 'mark', x: 10.04, z: -20 });
  assert.deepEqual(H.last(b, 'mark'), { t: 'mark', id: a.pid, x: 10, z: -20 }, 'lobby: everyone');
  H.send(a, { t: 'start', bots: 3, mats: 0, mode: 'squad' });
  H.advance(1000);
  H.clear(a); H.clear(b);
  H.send(a, { t: 'mark', x: 1e9, z: 'nope' });
  assert.equal(H.msgs(b, 'mark').length, 0, 'junk is ignored');
  for (let i = 0; i < 6; i++) H.send(a, { t: 'mark', x: i, z: i });
  assert.equal(H.msgs(b, 'mark').length, 4, '4 per second');
  H.advance(1001);
  H.send(a, { t: 'mark', clear: true });
  assert.deepEqual(H.last(b, 'mark'), { t: 'mark', id: a.pid, clear: 1 });
  assert.ok(H.msgs(a, 'mark').length >= 1, 'the sender gets it too');
  // free-for-all: nobody else is on your team
  const H2 = makeRoom();
  const c = H2.join('Cat', RES), d = H2.join('Dan', RES);
  H2.send(c, { t: 'start', bots: 0, mats: 0 });
  H2.send(c, { t: 'mark', x: 5, z: 5 });
  assert.equal(H2.msgs(d, 'mark').length, 0);
  assert.equal(H2.msgs(c, 'mark').length, 1);
  assert.deepEqual([...H.errors, ...H2.errors], []);
});

test('party: a dropped player rejoins within 60 s with the same id, health and team', () => {
  const H = makeRoom({ settings: { mode: 'squad' } });
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  const token = H.last(b, 'welcome').resume;
  assert.match(token, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(H.last(a, 'welcome').resume, token);
  H.send(a, { t: 'start', bots: 3, mats: 0, mode: 'squad' });
  H.send(a, { t: 'drop' });
  H.send(b, { t: 'drop' });
  H.send(b, { t: 'u', s: [0, 30, 0, 0, 0, 0, 0, 0, 0, 'pickaxe', 0] }); // in the storm eye
  H.advance(500);
  const bot = H.bots()[0];
  H.room.applyDamage(b.p, 130, bot, { w: 'ar' });
  const pid = b.pid, team = b.p.team;
  const hp = b.p.hp, sh = b.p.sh;
  assert.ok(hp < 100 && sh === 0);
  H.leave(b);
  assert.ok(H.room.players.has(pid), 'held');
  assert.equal(H.room.players.get(pid).alive, true);
  const row = H.last(a, 'roster').players.find((p) => p.id === pid);
  assert.equal(row.away, 1, 'friends see who is away');
  assert.match(H.last(a, 'note').msg, /Ben lost connection/);
  H.advance(30000);
  // back on a new connection, with the page's game still running
  const b2 = H.join('Ben', { resume: token, keep: true });
  assert.equal(b2.ok, true);
  const r = H.last(b2, 'resumed');
  assert.ok(r, 'the page keeps its game: resumed, not a fresh welcome');
  assert.equal(H.last(b2, 'welcome'), null);
  assert.equal(r.you, pid);
  assert.equal(r.resumed, true);
  assert.deepEqual([r.me.hp, r.me.sh, r.me.alive], [Math.ceil(hp), 0, true]);
  const p = H.room.players.get(pid);
  assert.deepEqual([p.hp, p.sh, p.team, p.alive, p.away], [hp, sh, team, true, 0]);
  assert.equal(H.room.conns.get(b2.id).pid, pid);
  assert.equal(H.last(a, 'roster').players.find((x) => x.id === pid).away, 0);
  assert.match(H.last(a, 'note').msg, /Ben is back/);
  // the rejoined player plays on: hits and moves count
  H.send(b2, { t: 'u', s: [5, 20, 5, 0, 0, 0, 0, 0, 0, 'ar', 0] });
  assert.equal(p.x, 5);
  // a reloaded page (no game any more) gets a normal welcome with resumed + where it was
  H.leave(b2);
  H.advance(1000);
  const b3 = H.join('Ben', { resume: token });
  const w = H.last(b3, 'welcome');
  assert.ok(w && w.resumed && w.you === pid && w.me.alive === true && w.me.x === 5);
  assert.deepEqual(H.errors, []);
});

test('party: after 60 s away the player is eliminated with "left"; the empty room is flagged', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  const token = H.last(b, 'welcome').resume;
  H.send(a, { t: 'start', bots: 3, mats: 0 });
  H.leave(b);
  H.advance(HOLD_MS - 1000);
  assert.ok(H.room.players.has(b.pid));
  H.advance(1300);
  assert.equal(H.room.players.has(b.pid), false);
  const e = H.msgs(a, 'elim').find((m) => m.v === b.pid);
  assert.ok(e && e.c === 'left' && e.k === 0);
  assert.ok(!H.last(a, 'roster').players.some((p) => p.id === b.pid));
  // too late: the token joins as a new player (a spectator until the next round)
  const b2 = H.join('Ben', { resume: token });
  assert.notEqual(b2.pid, b.pid);
  assert.equal(H.last(b2, 'welcome').resumed, undefined);
  // the leader drops too: the leader role moves to the one still here; when nobody is left the room is empty
  H.leave(a);
  assert.equal(H.room.leader, b2.pid);
  H.leave(b2);
  H.advance(HOLD_MS + 500);
  assert.equal(H.room.humans().length, 0);
  assert.equal(H.room.empty, true);
  assert.deepEqual(H.errors, []);
});

test('party: the leader drops mid-match: a friend leads and gets the bots; held players leave at the lobby', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES), c = H.join('Cat', RES);
  H.send(a, { t: 'start', bots: 4, mats: 0 });
  assert.ok(H.bots().every((p) => p.owner === a.pid));
  H.leave(a);
  assert.equal(H.room.leader, b.pid);
  assert.ok(H.bots().every((p) => p.owner === b.pid), 'bots move at once');
  assert.deepEqual(H.last(b, 'bots').own.length, 4);
  H.leave(c);
  H.send(b, { t: 'end' });
  assert.equal(H.room.phase, 'lobby');
  assert.deepEqual(H.last(b, 'lobby').players.map((p) => p.id), [b.pid], 'away players left the party');
  assert.equal(H.room.empty, false);
  assert.deepEqual(H.errors, []);
});

test('party: players without rejoin support (older pages, tests) leave the classic way', () => {
  const H = makeRoom();
  const a = H.join('Ann'), b = H.join('Ben');
  H.send(a, { t: 'start', bots: 2, mats: 0 });
  H.leave(b);
  assert.equal(H.room.players.has(b.pid), false);
  assert.ok(H.msgs(a, 'elim').some((m) => m.v === b.pid && m.c === 'left'));
  // and a full P2P party (8) counts held players
  const P = makeRoom({ maxHumans: 2 });
  const x = P.join('X', RES), y = P.join('Y', RES);
  P.send(x, { t: 'start', bots: 0, mats: 0 });
  const tok = P.last(y, 'welcome').resume;
  P.leave(y);
  assert.equal(P.join('Z', RES).ok, false, 'the held spot is kept');
  assert.equal(P.join('Y', { resume: tok, keep: true }).ok, true, 'and the owner gets it back');
  assert.deepEqual([...H.errors, ...P.errors], []);
});

test('party: a second connection with the token takes over the first (a socket that never noticed the drop)', () => {
  const kicked = [];
  const H = makeRoom();
  H.room.onKick = (cid) => kicked.push(cid);
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  const tok = H.last(b, 'welcome').resume;
  const b2 = H.join('Ben', { resume: tok, keep: true });
  assert.equal(H.last(b2, 'resumed').you, b.pid);
  assert.deepEqual(kicked, [b.id]);
  assert.equal(H.room.conns.has(b.id), false);
  assert.equal([...H.room.conns.values()].filter((r) => r.pid === b.pid).length, 1);
  assert.deepEqual(H.errors, []);
});

test('party: the lobby picks modes before the mode engine has its own handler', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  H.send(b, { t: 'mode', id: 'duos' });
  assert.equal(H.msgs(a, 'settings').length, 0, 'leader only');
  H.send(a, { t: 'mode', id: 'nope' });
  assert.equal(H.msgs(a, 'settings').length, 0);
  H.send(a, { t: 'mode', id: 'squadbots' });
  const s = H.last(b, 'settings').settings;
  assert.equal(s.modeId, 'squadbots');
  assert.equal(s.info.name, 'Friends vs Bots');
  assert.equal(s.rules.teams, 'humans');
  assert.equal(s.mode, 'squad');
  H.send(a, { t: 'mode', custom: { teams: 2, gravity: 0.35 }, name: 'Moon <Duos>' });
  assert.equal(H.room.settings.info.name, 'Moon Duos');
  assert.equal(H.room.settings.rules.gravity, 0.35);
  assert.deepEqual(H.errors, []);
});
