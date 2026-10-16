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
  // (bot counts snap to the rules' options: 0, 1, 3, 5, …)
  H.send(a, { t: 'start', bots: 5, mats: 0 });
  assert.equal(H.bots().length, 5);
  assert.ok(H.bots().every((p) => p.owner === a.pid));
  H.leave(a);
  assert.equal(H.room.leader, b.pid);
  assert.ok(H.bots().every((p) => p.owner === b.pid), 'bots move at once');
  assert.deepEqual(H.last(b, 'bots').own.length, 5);
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

test('party: the leader picks modes in the lobby (the Room\'s own mode handler)', () => {
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

// ------------------------------------------------------------------ P2P transport (fake PeerJS)
// WebRTC does not work in this sandbox, so the P2P host / client logic runs over an in-memory
// stand-in for PeerJS: peers by id, data channels that deliver strings asynchronously.
import { P2PHost, P2PClient, usePeer, P2P_MAX_HUMANS } from '../public/js/net/p2p.js';
import { useBrokers } from '../public/js/net/relay.js';
useBrokers([]); // these tests are about the direct links (relay.test.mjs covers the relay)
import { PROTOCOL } from '../public/shared/constants.js';

const PEERS = new Map();
let anon = 0;
class FakeChannel {
  constructor() { this.h = {}; this.open = false; this.other = null; }
  on(ev, fn) { (this.h[ev] || (this.h[ev] = [])).push(fn); }
  fire(ev, a) { for (const fn of this.h[ev] || []) fn(a); }
  send(s) { if (!this.open) return; const o = this.other; setImmediate(() => { if (o.open) o.fire('data', s); }); }
  close() { if (!this.open) return; this.open = false; this.other.open = false; setImmediate(() => { this.fire('close'); this.other.fire('close'); }); }
}
class FakePeer {
  constructor(id, opts) {
    if (typeof id === 'object') { opts = id; id = null; }
    this.id = id || `anon${++anon}`;
    this.h = {};
    this.dcs = new Set();
    setImmediate(() => {
      if (PEERS.has(this.id)) { this.fire('error', { type: 'unavailable-id', message: 'taken' }); return; }
      PEERS.set(this.id, this);
      this.fire('open');
    });
  }
  on(ev, fn) { (this.h[ev] || (this.h[ev] = [])).push(fn); }
  once(ev, fn) { const w = (a) => { this.h[ev] = this.h[ev].filter((x) => x !== w); fn(a); }; this.on(ev, w); }
  fire(ev, a) { for (const fn of [...(this.h[ev] || [])]) fn(a); }
  connect(id) {
    const a = new FakeChannel(), b = new FakeChannel();
    a.other = b; b.other = a;
    this.dcs.add(a);
    setImmediate(() => {
      const target = PEERS.get(id);
      if (!target) { this.fire('error', { type: 'peer-unavailable' }); return; }
      target.dcs.add(b);
      a.open = b.open = true;
      target.fire('connection', b);
      setImmediate(() => { b.fire('open'); a.fire('open'); });
    });
    return a;
  }
  reconnect() {}
  destroy() { if (PEERS.get(this.id) === this) PEERS.delete(this.id); for (const dc of this.dcs) dc.close(); }
}
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};
const hello = (name, extra = {}) => ({ name, skin: 1, v: PROTOCOL, resume: '', ...extra });
function inbox(net) { const box = []; net.onMessage((m) => box.push(m)); box.last = (t) => { for (let i = box.length - 1; i >= 0; i--) if (box[i].t === t) return box[i]; return null; }; return box; }

test('P2P: the host keeps its mode and code, caps the party at 8, kicks close the link, a dropped friend rejoins', async () => {
  usePeer(FakePeer);
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    const host = new P2PHost(hello('Mia'), { settings: { modeId: 'duos', rules: { teams: 2, nope: 1 }, bots: 2, junk: { x: 1 } } });
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome'));
    assert.match(host.code, /^[A-Z]{4}$/);
    assert.equal(store.get('phortnite.hostCode'), host.code, 'the code is kept for next time');
    assert.equal(host.room.maxHumans, P2P_MAX_HUMANS);
    assert.equal(P2P_MAX_HUMANS, 8);
    assert.deepEqual([host.room.settings.modeId, host.room.settings.rules.teams, host.room.settings.junk, host.room.settings.rules.nope], ['duos', 2, undefined, undefined]);
    // friends join
    const ben = new P2PClient(host.code, hello('Ben'));
    const bb = inbox(ben);
    await ben.connect();
    await until(() => bb.last('welcome'));
    const cat = new P2PClient(host.code, hello('Cat'));
    const cb = inbox(cat);
    await cat.connect();
    await until(() => cb.last('welcome'));
    assert.equal(host.room.humans().length, 3);
    // kick Cat: she hears it, then the link closes (~300 ms)
    let catLost = null;
    cat.onClose = (m) => { catLost = m || true; };
    host.send({ t: 'kick', id: cb.last('welcome').you });
    await until(() => cb.last('kicked'));
    assert.equal(cat.rejoin, null, 'nothing to come back to');
    await until(() => catLost, 3000);
    assert.equal(host.room.humans().length, 2);
    // a match; Ben's link drops; he gets back in as the same player with the game still running
    const w = bb.last('welcome');
    ben.rejoin = () => ({ t: 'join', hello: hello('Ben', { resume: w.resume, keep: true }) });
    host.send({ t: 'start', bots: 0, mats: 0 });
    await until(() => bb.last('start'));
    for (const dc of [...PEERS.get(`phortnite-v1-${host.code}`).dcs]) if (dc.open) { dc.close(); break; } // the network blips
    await until(() => bb.some((m) => m.t === '_net' && m.state === 'reconnecting'));
    assert.equal(host.room.players.get(w.you).away > 0, true, 'held for a rejoin');
    await until(() => bb.last('resumed'), 6000);
    assert.equal(bb.last('resumed').you, w.you);
    assert.ok(bb.some((m) => m.t === '_net' && m.state === 'online'));
    assert.equal(host.room.players.get(w.you).away, 0);
    // the host pauses (page hidden mid-match): the friend notices the silence, then the host is back
    ben.stallMs = 300;
    host.pause();
    await until(() => bb.filter((m) => m.t === '_net' && m.state === 'stall').length === 1, 3000);
    const paused = host.room.now();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(host.room.now(), paused, 'the room clock stands still');
    host.resume();
    await until(() => bb.filter((m) => m.t === '_net' && m.state === 'online').length >= 2, 3000);
    // the host closes the party: friends hear it (no 45 s wait)
    host.close();
    await until(() => bb.last('partyend'));
    assert.match(bb.last('partyend').msg, /Mia's party ended/);
    assert.equal(ben.rejoin, null);
    ben.close();
    // the next party from this device gets the same code back
    const again = new P2PHost(hello('Mia'));
    await again.connect();
    assert.equal(again.code, store.get('phortnite.hostCode'));
    again.close();
  } finally {
    delete globalThis.localStorage;
    await new Promise((r) => setTimeout(r, 400));
  }
});

test('P2P: a party of 8 turns the 9th friend away', async () => {
  usePeer(FakePeer);
  const host = new P2PHost(hello('Host'));
  await host.connect();
  const nets = [];
  for (let i = 0; i < 8; i++) {
    const c = new P2PClient(host.code, hello(`F${i}`));
    const box = inbox(c);
    await c.connect();
    await until(() => box.last('welcome') || box.last('err'));
    nets.push([c, box]);
  }
  assert.equal(nets.filter(([, b]) => b.last('welcome')).length, 7);
  assert.match(nets[7][1].last('err').msg, /full/);
  host.close();
  for (const [c] of nets) c.close(false);
  await new Promise((r) => setTimeout(r, 400));
});

test('party: a Wi-Fi blip in the lobby keeps your spot (and the crown comes back to you if nobody took it); bye leaves at once', () => {
  const H = makeRoom();
  const a = H.join('Ann', RES), b = H.join('Ben', RES);
  const tokA = H.last(a, 'welcome').resume;
  H.leave(a);
  assert.ok(H.room.players.has(a.pid), 'held in the lobby');
  assert.equal(H.room.leader, b.pid, 'Ben leads while Ann is away');
  assert.equal(H.last(b, 'roster').players.find((p) => p.id === a.pid).away, 1);
  H.advance(5000);
  const a2 = H.join('Ann', { resume: tokA, keep: true });
  assert.equal(H.last(a2, 'resumed').you, a.pid);
  assert.equal(H.last(a2, 'resumed').phase, 'lobby');
  // on purpose: no hold
  H.send(b, { t: 'bye' });
  H.leave(b);
  assert.equal(H.room.players.has(b.pid), false);
  assert.equal(H.room.leader, a.pid);
  // never back: gone after 60 s, and the room empties
  H.leave(a2);
  H.advance(HOLD_MS + 500);
  assert.equal(H.room.players.size, 0);
  assert.equal(H.room.empty, true);
  assert.deepEqual(H.errors, []);
});
