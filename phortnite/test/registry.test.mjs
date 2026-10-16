// The account registry and the ban list (js/accounts/registry.js, js/admin/commands.js 'bans',
// js/admin/client.js checkBans, js/admin/session.js accounts / banAccount / unbanAccount): every
// signed-in account (never a guest) keeps one sealed, retained entry on the broker for the admin's
// ACCOUNTS tab; the admin's signed ban list bans a device whose id, or any account kept on it, is
// on it (even one that was offline when he banned it); the admin's page opens entries within a
// budget, caps what it keeps, and keeps only entries (and card rids) whose token proves their rid.
// Also the fixes after review: a forged entry or card can't take over a real account, a moved banned
// account is refused or taken off the friend's iPad (never the iPad banned), ban lists carry hashed
// device ids, a skewed clock doesn't skip the list, the unban order, entries sent seldom, the
// admin's page puts the list back after every connect, every account is told once.
// No real broker for most of it: a small in-memory stand-in for the presence connection (listen
// with '+' filters, retained messages, onConnect, cards) carries real sealed messages between real
// Registry / AdminClient / AdminSession objects. One test runs the real Presence on the test broker
// (test/helpers/minibroker.mjs) to check an entry comes back after the broker forgot it. Keys are
// made with the smallest round count allowed, like test/admin.test.mjs.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  loadConfig, importPublic, unlockAdmin, createAdminConfig, openSealed, sealToAdmin, MIN_ITER, SEAL_ACCT, SEAL_CARD, SEAL_UP,
} from '../public/js/admin/keys.js';
import {
  STATE_PREFIX, STATE_KINDS, STATE_TOPICS, CommandGate, makeEnvelope, cleanArgs, cleanCard, stateActive, BANS_MAX, BANS_TEXT_MAX, CMD_TOPIC,
} from '../public/js/admin/commands.js';
import {
  REG_PREFIX, REG_FILTER, REG_MAX, REG_EVERY_MS, REG_REFRESH_MS, DEVICE_KEY, GONE_KEY, SENT_KEY, RID_RE, TOK_RE, DID_RE, BDID_RE,
  accountIds, cachedIds, deviceId, registration, sealRegistration, regShape, cleanRegistration, Registry, ridOf, tokMatches, banDid,
} from '../public/js/accounts/registry.js';
import { AdminClient, BAN_LIST_REASON, TOLD_KEY } from '../public/js/admin/client.js';
import { AdminSession, ACCT_RATE, ACCTS_MAX, ACCT_MEM_KEY, BANS_KEY, SEEN_SLACK_MS } from '../public/js/admin/session.js';
import { offlineAccounts } from '../public/js/ui/admin.js';
import { AccountStore } from '../public/js/accounts/store.js';
import { defaultStats } from '../public/js/accounts/stats.js';
import { topicMatches } from '../public/js/net/mqtt.js';
import { Presence } from '../public/js/net/presence.js';
import { useBrokers } from '../public/js/net/relay.js';
import { startBroker } from './helpers/minibroker.mjs';

const PASSWORD = 'TEST-ACCT-23XY'; // made up for the tests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, what = '') => {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(`timed out ${what}`); await sleep(10); }
};

// every page and session a test starts is stopped after it (their timers would keep Node running)
const live = [];
afterEach(() => { for (const x of live.splice(0)) { try { x(); } catch (e) { /* stopped already */ } } });

const shared = (async () => {
  const cfg = loadConfig(await createAdminConfig(PASSWORD, { iter: MIN_ITER }));
  const other = loadConfig(await createAdminConfig('OTHR-ACCT-2345', { iter: MIN_ITER }));
  return {
    cfg, keys: await unlockAdmin(cfg, PASSWORD), pubs: await importPublic(cfg),
    otherKeys: await unlockAdmin(other, 'OTHR-ACCT-2345'), otherPubs: await importPublic(other),
  };
})();

/** A Map-backed localStorage stand-in. */
function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** Run with globalThis.localStorage = store (the code under test reads it in places). */
function useStorage(store) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  return () => { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage; };
}

/**
 * The public broker as js/net/presence.js shows it: every page gets { id, connected, listen (with
 * '+' / '#'), publish (retained ones kept; '' deletes), onConnect, setExtra, cards, onCards }.
 * Delivery is async; a page offline neither sends nor hears; back online it hears the retained
 * messages again (a new subscription) and its onConnect runs. log: everything published.
 */
function fakeBroker() {
  const subs = [];
  const retained = new Map();
  const cards = new Map();
  const cardFns = [];
  const log = [];
  const pages = new Map();
  const deliver = (s, text, topic, ret) => setTimeout(() => { if (s.p.online && subs.includes(s)) s.fn(text, topic, ret); }, 1);
  return {
    log,
    retained,
    page(id) {
      const p = {
        id, online: true, connectFns: [], counts: { total: 1, inMatch: 0, inLobby: 1 },
        get connected() { return p.online; },
        listen(filter, fn) {
          const s = { filter, fn, p };
          subs.push(s);
          for (const [t, v] of retained) if (topicMatches(filter, t)) deliver(s, v, t, true);
          return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
        },
        publish(topic, text, opts = {}) {
          if (!p.online) return false;
          log.push({ topic, text, retain: !!opts.retain, from: id });
          if (opts.retain) { if (text) retained.set(topic, text); else retained.delete(topic); }
          for (const s of [...subs]) if (topicMatches(s.filter, topic)) deliver(s, text, topic, false);
          return true;
        },
        onConnect(fn) { p.connectFns.push(fn); return () => { p.connectFns = p.connectFns.filter((f) => f !== fn); }; },
        goOffline() { p.online = false; for (const fn of cardFns) fn(); }, // (it left: its card is gone too)
        goOnline() {
          p.online = true;
          for (const s of subs) if (s.p === p) for (const [t, v] of retained) if (topicMatches(s.filter, t)) deliver(s, v, t, true);
          for (const fn of [...p.connectFns]) fn();
        },
        setExtra(f) {
          if (!f || !f.a) return;
          const prev = cards.get(id);
          cards.set(id, { a: f.a, prev: prev ? prev.a : null });
          for (const fn of cardFns) fn();
        },
        cards() { return [...cards].filter(([k]) => k !== id && pages.get(k).online).map(([k, v]) => ({ id: k, s: 'l', a: v.a, prev: v.prev, at: Date.now() })); },
        onCards(fn) { cardFns.push(fn); return () => {}; },
      };
      pages.set(id, p);
      return p;
    },
  };
}

/** A stand-in for the App: enough for AdminClient / AdminSession (no DOM). */
function fakeApp(presence, name, extra = {}) {
  const app = {
    presence, settings: { name }, profile: { level: 3, data: defaultStats(), save() {} }, partyKind: () => 'solo', game: null,
    activeAccount: null, accounts: null, admin: null, toasts: [],
    announce: { setAdmin() {} },
    lobby: { toast(html) { app.toasts.push(html); }, render() {} },
    ...extra,
  };
  return app;
}

/** A player's page: its own device storage, an account store, a started AdminClient whose ban is recorded. */
async function playerPage(broker, id, cfg, pubs, { store = memStorage(), names = [], active = 0 } = {}) {
  const restore = useStorage(store);
  try {
    const accounts = new AccountStore(store);
    for (const n of names) accounts.create({ name: n, makeActive: false });
    const app = fakeApp(broker.page(id), names[active] || 'Guest', { accounts });
    if (names.length) {
      const acc = accounts.list()[active];
      app.activeAccount = accounts.setActive(acc.id);
    }
    const c = new AdminClient(app, cfg, pubs);
    app.adminClient = c;
    c.chip = () => {};
    c.overlay = () => {};
    c.maintenance = () => {};
    c.bans$ = [];
    c.writeBan = async (env, opts) => { c.bans$.push(opts); };
    c.start();
    live.push(() => c.stop());
    await c.keyReady;
    if (app.activeAccount) await accountIds(app.activeAccount.id);
    await c.refreshCard();
    return { app, client: c, store, accounts };
  } finally { restore(); }
}

const entryFor = async (acc, did = 'abcdefghijkl', extra = {}) => ({ ...registration(acc, { ...(await accountIds(acc.id)), did, now: Date.now() }), ...extra });

// ------------------------------------------------------------------ ids

test('registry ids: tok is SHA-256 of the account id (32 hex), rid SHA-256 of tok (16 hex): the same every time, different per account, and a tok proves its rid', async () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const a = await accountIds('p_0123456789abcdef01');
  assert.match(a.rid, RID_RE);
  assert.match(a.tok, TOK_RE);
  assert.equal(a.tok, sha('phortnite registry tok v1:p_0123456789abcdef01').slice(0, 32));
  assert.equal(a.rid, sha('phortnite registry id v2:' + a.tok).slice(0, 16), 'rid is worked out from tok');
  assert.equal(await ridOf(a.tok), a.rid);
  assert.equal(await tokMatches(a.rid, a.tok), true);
  for (const bad of ['f'.repeat(32), a.tok.toUpperCase(), a.tok.slice(0, 31), null, 42]) assert.equal(await tokMatches(a.rid, bad), false, String(bad));
  assert.equal(await tokMatches('nope', a.tok), false);
  assert.deepEqual(await accountIds('p_0123456789abcdef01'), a, 'deterministic');
  assert.deepEqual(cachedIds('p_0123456789abcdef01'), a, 'and cached once worked out');
  const b = await accountIds('p_0123456789abcdef02');
  assert.notEqual(b.rid, a.rid);
  assert.notEqual(b.tok, a.tok);
  assert.equal(await tokMatches(a.rid, b.tok), false, "another account's token doesn't fit");
  assert.ok(!a.tok.startsWith(a.rid), 'the token is not the id: knowing the topic tells nothing about it');
  // a device id as the public ban list carries it: one-way, 16 hex, never a device id's own shape
  const h = await banDid('abcdefghijkl');
  assert.match(h, BDID_RE);
  assert.equal(h, sha('phortnite ban did v1:abcdefghijkl').slice(0, 16));
  assert.equal(await banDid('abcdefghijkl'), h);
  assert.notEqual(await banDid('abcdefghijkm'), h);
  assert.doesNotMatch(h, DID_RE, "a hashed id can't be copied into a device's storage as its id");
  // an old account (made before the registry) works the same: nothing is stored
  const st = memStorage();
  const old = new AccountStore(st).create({ name: 'Old' });
  assert.match((await accountIds(old.id)).rid, RID_RE);
  assert.equal(st.getItem('phortnite.accounts').includes((await accountIds(old.id)).rid), false, 'nothing new on disk');
});

test('device id: 12 [a-z0-9], made once and kept; private mode gets one for the page load', () => {
  const st = memStorage();
  const d = deviceId(st);
  assert.match(d, DID_RE);
  assert.equal(st.getItem(DEVICE_KEY), d);
  assert.equal(deviceId(st), d, 'the same next time (a reload)');
  assert.notEqual(deviceId(memStorage()), d, 'another device, another id');
  st.setItem(DEVICE_KEY, 'NOT VALID!!');
  assert.match(deviceId(st), DID_RE, 'junk in storage: a new one');
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const p1 = deviceId(blocked);
  assert.match(p1, DID_RE);
  assert.equal(deviceId(blocked), p1, 'private mode: one per page load');
  assert.match(deviceId(null), DID_RE);
});

// ------------------------------------------------------------------ the sealed entry

test('a sealed entry opens only with the admin box key and SEAL_ACCT (never as a card or an upload), and stays under REG_MAX', async () => {
  const { keys, pubs, otherKeys } = await shared;
  const st = new AccountStore(memStorage());
  const acc = st.create({ name: 'Ruby' });
  acc.stats.level = 7; acc.stats.wins = 3; acc.stats.matches = 9; acc.stats.elims = 21;
  const e = await entryFor(acc);
  assert.deepEqual(Object.keys(e).sort(), ['created', 'did', 'k', 'kills', 'level', 'matches', 'name', 'rid', 'seen', 'tok', 'v', 'wins']);
  assert.equal(e.kills, 21);
  assert.equal(e.created, acc.createdAt);
  const text = await sealRegistration(pubs.boxPub, e);
  assert.ok(text.length <= REG_MAX && text.length < 1200, `small: ${text.length}`);
  assert.equal(text.includes('Ruby'), false, 'no name in the clear');
  assert.equal(text.includes(e.tok), false, 'no token in the clear');
  const sealed = JSON.parse(text);
  assert.ok(regShape(sealed));
  assert.deepEqual(await openSealed(keys.box, sealed, SEAL_ACCT, { max: REG_MAX }), e);
  assert.equal(await openSealed(keys.box, sealed, SEAL_CARD), null, 'not as a player card');
  assert.equal(await openSealed(keys.box, sealed, SEAL_UP), null, 'not as an upload');
  assert.equal(await openSealed(otherKeys.box, sealed, SEAL_ACCT), null, 'not with another key');
  // a card sealed with SEAL_CARD does not pass as an entry either
  assert.equal(await openSealed(keys.box, await sealToAdmin(pubs.boxPub, e, SEAL_CARD), SEAL_ACCT), null);
  // caps: a long name is trimmed, numbers clamped, junk refused (and only for its own topic)
  const clean = cleanRegistration({ ...e, name: '<b>' + 'x'.repeat(100), level: 1e9, wins: -5, v: 'y'.repeat(99), extra: 'no' }, e.rid);
  assert.equal(clean.name.length, 16);
  assert.doesNotMatch(clean.name, /[<>]/);
  assert.equal(clean.level, 999);
  assert.equal(clean.wins, 0);
  assert.equal(clean.v.length, 16);
  assert.equal('extra' in clean, false);
  assert.equal('k' in clean, false);
  for (const bad of [null, [], { ...e, k: 'card' }, { ...e, tok: 'short' }, { ...e, did: 'UPPER123456X' }, { ...e, rid: 'zz' }]) assert.equal(cleanRegistration(bad, e.rid), null, JSON.stringify(bad));
  assert.equal(cleanRegistration(e, '0'.repeat(16)), null, 'parked under another account\'s topic: junk');
  assert.equal(regShape({ e: 'x', iv: 'y', ct: 'z'.repeat(REG_MAX + 1) }), false);
  assert.equal(await sealRegistration(pubs.boxPub, { ...e, pad: 'x'.repeat(3000) }), null, 'over REG_MAX: not published');
});

// ------------------------------------------------------------------ the page's side

test('registry: the signed-in account is published retained on its topic; guests and nobody never are', async () => {
  const { keys, pubs } = await shared;
  const broker = fakeBroker();
  const p = broker.page('page00000001');
  const st = new AccountStore(memStorage());
  let acc = null;
  const reg = new Registry({ presence: p, boxPub: pubs.boxPub, account: () => acc, storage: memStorage() });
  assert.equal(await reg.sync({ force: true }), false, 'nobody signed in');
  acc = st.startGuest({ name: 'Visitor' });
  assert.equal(await reg.sync({ force: true }), false, 'a guest');
  assert.equal(await reg.connected(), false);
  assert.equal(broker.log.length, 0, 'nothing published for a guest');
  acc = st.create({ name: 'Ruby' });
  assert.equal(await reg.sync(), true, 'a new account goes out at once');
  const { rid } = await accountIds(acc.id);
  const msg = broker.log.at(-1);
  assert.equal(msg.topic, REG_PREFIX + rid);
  assert.equal(msg.retain, true);
  const opened = cleanRegistration(await openSealed(keys.box, JSON.parse(msg.text), SEAL_ACCT, { max: REG_MAX }), rid);
  assert.equal(opened.name, 'Ruby');
  assert.equal(opened.did, reg.did);
  assert.equal(reg.ridNow(acc.id), rid);
  assert.equal(REG_FILTER, REG_PREFIX + '+');
  reg.stop();
});

test('registry: sent seldom: a new account and a rename at once, stats every REG_EVERY_MS, seen once a day; a reload or a reconnect alone sends nothing; a broker that lost or replaced it gets it back', async () => {
  const { pubs } = await shared;
  const broker = fakeBroker();
  const p = broker.page('page00000002');
  let t = 1e12;
  const storage = memStorage();
  const st = new AccountStore(memStorage());
  let acc = st.create({ name: 'Max' });
  const opts = { presence: p, boxPub: pubs.boxPub, account: () => acc, storage, now: () => t, settleMs: 60 };
  const reg = new Registry(opts);
  const sent = () => broker.log.filter((m) => m.topic.startsWith(REG_PREFIX)).length;
  assert.ok(REG_EVERY_MS >= 3600000 && REG_REFRESH_MS >= REG_EVERY_MS, 'hours, not a minute: no timeline of every match');
  assert.equal(await reg.sync(), true, 'a new account goes out at once');
  assert.equal(await reg.sync(), false, 'nothing changed');
  acc.stats.wins = 1;
  t += 60000;
  assert.equal(await reg.sync(), false, 'a win a minute later waits');
  t += REG_EVERY_MS;
  assert.equal(await reg.sync(), true, 'and rides along REG_EVERY_MS after the last one');
  acc.stats.level = 2;
  t += 5000;
  assert.equal(await reg.sync(), false);
  acc.name = 'Maxi'; // (a rename: the player's own, or the admin's 'rename')
  assert.equal(await reg.sync(), true, 'a rename at once (the level rides along)');
  assert.ok(JSON.parse(storage.getItem(SENT_KEY))[(await accountIds(acc.id)).rid].n === 'Maxi', 'what was sent is kept on the device');
  await sleep(150); // (the check after the first entry: it is on the broker, as sent)
  const n = sent();
  assert.equal(n, 3);
  // a reconnect with the entry still on the broker: nothing (no "playing right now" for every session)
  p.goOffline();
  p.goOnline();
  await sleep(250);
  assert.equal(sent(), n, 'a reconnect alone sends nothing');
  // a reload (a new page, the same device storage): nothing either
  reg.stop();
  const reg2 = new Registry(opts);
  assert.equal(await reg2.sync(), false, 'a reload: already sent from this device');
  await sleep(250);
  assert.equal(sent(), n, 'and its check finds the entry on the broker');
  // 'seen' once a day
  t += REG_REFRESH_MS;
  assert.equal(await reg2.sync(), true, 'a day later: seen again');
  await sleep(150);
  // the broker forgot it: back after the next connect
  const topic = REG_PREFIX + (await accountIds(acc.id)).rid;
  broker.retained.delete(topic);
  p.goOffline();
  p.goOnline();
  await until(() => broker.retained.has(topic), 2000, 'put back after the broker forgot it');
  // someone wiped it or put something else there: it goes back on the next connect (not in a fight: once)
  await sleep(150);
  broker.page('evil00000009').publish(topic, JSON.stringify({ e: 'x', iv: 'y', ct: 'z' }), { retain: true });
  await sleep(150);
  const m2 = sent();
  p.goOffline();
  p.goOnline();
  await until(() => JSON.parse(broker.retained.get(topic)).ct !== 'z', 2000, 'put back after it was replaced');
  await sleep(200);
  assert.equal(sent(), m2 + 1, 'ours, once');
  // switching account: the new one at once
  acc = st.create({ name: 'Zoe' });
  assert.equal(await reg2.sync(), true);
  await sleep(150);
  // offline: nothing sealed or sent; a rename made offline goes on connect
  p.goOffline();
  acc.name = 'Zoey';
  assert.equal(await reg2.sync(), false);
  const before = sent();
  p.goOnline();
  await until(() => sent() === before + 1, 2000, 'sent on connect');
  await sleep(200);
  assert.equal(sent(), before + 1, 'once');
  // private mode (storage refuses): it still works, for this page load
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const reg3 = new Registry({ ...opts, storage: blocked });
  acc = st.create({ name: 'Priv' });
  assert.equal(await reg3.sync(), true);
  assert.equal(await reg3.sync(), false, 'remembered in memory');
  reg3.stop();
  reg2.stop();
});

test('registry: an account deleted here deletes its entry (an empty retained message); offline it waits in storage for the next connect', async () => {
  const { pubs } = await shared;
  const broker = fakeBroker();
  const p = broker.page('page00000003');
  const storage = memStorage();
  const st = new AccountStore(storage);
  const a = st.create({ name: 'Ann' }), b = st.create({ name: 'Bob' });
  let acc = a;
  const reg = new Registry({ presence: p, boxPub: pubs.boxPub, account: () => acc, store: st, storage });
  await reg.sync();
  const ra = (await accountIds(a.id)).rid, rb = (await accountIds(b.id)).rid;
  assert.ok(broker.retained.has(REG_PREFIX + ra));
  acc = null;
  st.remove(a.id); // (the account panel's DELETE ACCOUNT)
  await until(() => !broker.retained.has(REG_PREFIX + ra), 2000, 'deleted on the broker');
  assert.deepEqual(broker.log.at(-1), { topic: REG_PREFIX + ra, text: '', retain: true, from: 'page00000003' });
  // offline: the deletion waits (in storage: a reload keeps it) and goes on the next connect
  acc = b;
  p.goOffline();
  acc = null;
  st.remove(b.id);
  await until(() => JSON.parse(storage.getItem(GONE_KEY) || '[]').includes(rb), 2000, 'queued');
  const reloaded = new Registry({ presence: p, boxPub: pubs.boxPub, account: () => null, storage });
  assert.deepEqual(reloaded.pending(), [rb], 'kept across a reload');
  reg.stop();
  p.goOnline();
  await until(() => broker.log.some((m) => m.topic === REG_PREFIX + rb && m.text === '' && m.retain), 2000, 'flushed on connect');
  assert.equal(storage.getItem(GONE_KEY), null, 'nothing waits any more');
  // a late sync never brings a deleted account back
  const reg2 = new Registry({ presence: p, boxPub: pubs.boxPub, account: () => a, storage });
  reg2.gone.add(a.id);
  assert.equal(await reg2.sync({ force: true }), false);
  reg2.stop();
  reloaded.stop();
});

test('registry on the real presence connection: the entry goes out on connect and comes back after the broker forgot it', async () => {
  const { pubs } = await shared;
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const FAST = { refreshMs: 600, perPlayerMs: 0, staleMin: 1500, minGapMs: 0, hideMs: 150, tickMs: 50, settleMs: 150, notifyMs: 20, backoffMs: 50, maxBackoffMs: 400, connectMs: 2000 };
  const pres = new Presence({ ...FAST });
  const acc = new AccountStore(memStorage()).create({ name: 'Ruby' });
  const reg = new Registry({ presence: pres, boxPub: pubs.boxPub, account: () => acc, storage: memStorage(), settleMs: 300 });
  const topic = REG_PREFIX + (await accountIds(acc.id)).rid;
  try {
    pres.start();
    await until(() => b.retained.has(topic), 6000, 'registered on connect');
    b.retained.delete(topic); // (a public broker forgets retained messages when it likes)
    b.kill(); // and the connection drops
    await until(() => b.retained.has(topic), 8000, 'back after the reconnect');
  } finally {
    reg.stop();
    pres.stop();
    useBrokers(null);
    await b.stop();
  }
});

// ------------------------------------------------------------------ the ban list (signed state)

test("ban list: cleanArgs keeps at most 500 well-formed entries, once each; no names or reasons, no raw device ids; it's a state on its own exact topic", async () => {
  assert.ok(STATE_KINDS.includes('bans'));
  assert.ok(STATE_TOPICS.includes(STATE_PREFIX + 'bans'));
  const r = (i) => i.toString(16).padStart(16, '0');
  const h1 = await banDid('abcdefghijkl'), h2 = await banDid('abcdefghijk2'), hz = await banDid('zzzzzzzzzzzz');
  assert.equal(cleanArgs('bans', {}), null, 'no list');
  assert.equal(cleanArgs('bans', { list: 'x' }), null);
  assert.deepEqual(cleanArgs('bans', { list: [] }), { list: [] }, 'an empty list is a list (everyone unbanned)');
  const got = cleanArgs('bans', {
    list: [
      { r: r(1), d: h1 }, { r: r(2) }, { r: r(1), d: hz }, // a duplicate: the first stays
      { r: 'NOTHEX' }, { r: r(3), d: 'BAD' }, null, 'x', [r(4)], { r: 'ABCDEF0123456789' }, { d: h1 },
      { r: r(5), d: 'abcdefghijkl' }, // a raw device id: never on a list (it could be copied)
      { r: r(6), name: 'Ruby', reason: 'mean' }, { r: r(2), d: h2 }, // a later device id for one that had none
    ],
  });
  assert.deepEqual(got, { list: [{ r: r(1), d: h1 }, { r: r(2), d: h2 }, { r: r(6) }] }, 'junk dropped, deduped, names and reasons never kept');
  const big = cleanArgs('bans', { list: [...Array(800)].map((_, i) => ({ r: r(i + 1), d: h1 })) });
  assert.equal(big.list.length, BANS_MAX);
  assert.equal(big.list[0].r, r(1), 'the first 500');
});

test('ban list: never runs out by age, but a page only moves forward (an older one replayed is refused, after a reload too)', async () => {
  const { cfg, keys, pubs } = await shared;
  const now = Date.now();
  const r1 = '1'.repeat(16), r2 = '2'.repeat(16);
  const gate = new CommandGate({ signPub: pubs.signPub });
  const old = await makeEnvelope(keys.sign, 'bans', { list: [{ r: r1 }] }, '*', now - 90 * 86400000);
  const ok = await gate.state(old, 'bans');
  assert.equal(ok.ok, true, 'signed 90 days ago: still a ban list');
  assert.equal(stateActive('bans', ok.env.args, now, old.ts), true, 'never runs out by age');
  assert.equal((await gate.state(old, 'banner')).ok, false, 'only on its own topic');
  const restore = useStorage(memStorage());
  try {
    const broker = fakeBroker();
    const c = new AdminClient(fakeApp(broker.page('page00000010'), 'Mia'), cfg, pubs);
    c.checkBans = async () => false;
    const newer = await makeEnvelope(keys.sign, 'bans', { list: [{ r: r1 }, { r: r2 }] }, '*', now - 1000);
    await c.onState(JSON.stringify(newer), STATE_PREFIX + 'bans');
    assert.equal(c.states.bans.n, newer.n);
    await c.onState(JSON.stringify(old), STATE_PREFIX + 'bans');
    assert.equal(c.states.bans.n, newer.n, 'the older one is refused');
    // a reload (same storage) never takes the older one either
    const c2 = new AdminClient(fakeApp(broker.page('page00000011'), 'Mia'), cfg, pubs);
    c2.checkBans = async () => false;
    await c2.onState(JSON.stringify(old), STATE_PREFIX + 'bans');
    assert.equal(c2.states.bans, null);
    // a big list fits the state's own text cap (a banner's 4000 would refuse it)
    const many = await makeEnvelope(keys.sign, 'bans', { list: [...Array(300)].map((_, i) => ({ r: i.toString(16).padStart(16, '0') })) }, '*', now);
    const text = JSON.stringify(many);
    assert.ok(text.length > 4000 && text.length <= BANS_TEXT_MAX, `${text.length}`);
    await c2.onState(text, STATE_PREFIX + 'bans');
    assert.equal(c2.states.bans.args.list.length, 300);
  } finally { restore(); }
});

/** Publish a signed ban list (retained) from a stand-in admin page on the fake broker. */
const listSender = (broker, keys) => {
  const admin = broker.page('admin0000099');
  return async (list, ts = Date.now()) => admin.publish(STATE_PREFIX + 'bans', JSON.stringify(await makeEnvelope(keys.sign, 'bans', { list }, '*', ts)), { retain: true });
};

test("page side: any account made on this device (not only the signed-in one), or this device's id, on the list bans it once; others are left alone", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const sendList = listSender(broker, keys);
  // device 1: Ruby (signed in) and Leo (another profile on the same iPad)
  const d1 = await playerPage(broker, 'page00000020', cfg, pubs, { names: ['Ruby', 'Leo'], active: 0 });
  // device 2: Max, someone else
  const d2 = await playerPage(broker, 'page00000021', cfg, pubs, { names: ['Max'] });
  const leo = d1.accounts.list().find((p) => p.name === 'Leo');
  const leoRid = (await accountIds(leo.id)).rid;
  try {
    await sendList([{ r: 'f'.repeat(16) }]); // nobody here
    await sleep(200);
    assert.equal(d1.client.bans$.length + d2.client.bans$.length, 0, 'not on the list: nothing happens');
    await sendList([{ r: leoRid }]); // Leo isn't even signed in
    await until(() => d1.client.bans$.length === 1, 3000, 'device 1 banned');
    assert.deepEqual(d1.client.bans$[0], { reason: BAN_LIST_REASON });
    assert.equal(d1.client.banned, true, 'the ban screen ("You\'ve been banned by the admin")');
    await sendList([{ r: leoRid }, { r: 'e'.repeat(16) }]); // the list changes again
    await sleep(200);
    await d1.client.checkBans();
    assert.equal(d1.client.bans$.length, 1, 'once');
    assert.equal(d2.client.bans$.length, 0, 'device 2 is not on it');
    // a raw device id is no entry at all (only the one-way hash ever is): nothing happens
    await sendList([{ r: 'e'.repeat(16), d: d2.client.registry.did }]);
    await sleep(200);
    assert.equal(d2.client.bans$.length, 0, 'a raw device id: not a ban list entry');
    // by (hashed) device id: device 2's iPad itself
    await sendList([{ r: 'e'.repeat(16), d: await banDid(d2.client.registry.did) }]);
    await until(() => d2.client.bans$.length === 1, 3000, 'device 2 banned by its device id');
    // the admin's own page (admin mode) is never banned by the list
    const d4 = await playerPage(broker, 'page00000023', cfg, pubs, { names: ['Phil'] });
    d4.app.admin = { sent: new Set() };
    const philRid = (await accountIds(d4.app.activeAccount.id)).rid;
    await sendList([{ r: philRid }]);
    await sleep(200);
    assert.equal(await d4.client.checkBans(), false);
    assert.equal(d4.client.bans$.length, 0, 'admin mode: never');
    d4.app.admin = null;
    d4.client.adminChanged = AdminClient.prototype.adminChanged; // (applyStates needs no DOM here)
    d4.client.applyStates = () => {};
    d4.client.adminChanged();
    await until(() => d4.client.bans$.length === 1, 3000, 'admin mode off: banned');
    d4.client.stop();
  } finally {
    d1.client.stop();
    d2.client.stop();
  }
});

test("a banned account brought over with a transfer code is refused, or taken off the iPad it was moved to (quietly, the player told): the friend's iPad and own accounts are never banned", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const sendList = listSender(broker, keys);
  // Bad makes a "Move my account" code before the ban
  const bad = await playerPage(broker, 'page00000070', cfg, pubs, { names: ['Bad'] });
  const badAcc = bad.app.activeAccount;
  const code = bad.accounts.exportObject(badAcc.id);
  const badRid = (await accountIds(badAcc.id)).rid;
  // a friend's iPad (Friend and Sis) brings it over while the list doesn't name it yet
  const fr = await playerPage(broker, 'page00000071', cfg, pubs, { names: ['Friend', 'Sis'] });
  try {
    await sendList([{ r: 'f'.repeat(16) }]);
    await until(() => !!fr.client.states.bans, 2000, 'list heard');
    assert.equal(await fr.client.banListReady(10), true);
    assert.equal(await fr.client.accountBanned(badAcc.id), false, 'not banned (yet): it may come over');
    const moved = fr.accounts.importProfile(code);
    assert.equal(moved.id, badAcc.id, 'a moved account keeps its id');
    assert.ok(moved.imported > 0, 'marked as brought over');
    assert.ok(new AccountStore(fr.store).get(moved.id).imported > 0, 'the mark is kept on disk');
    fr.app.activeAccount = fr.accounts.setActive(moved.id);
    // Philip bans Bad (and Bad's own iPad)
    const deletions = () => broker.log.filter((m) => m.topic === REG_PREFIX + badRid && m.text === '').length;
    await sendList([{ r: badRid, d: await banDid(bad.client.registry.did) }]);
    await until(() => bad.client.bans$.length === 1, 3000, "Bad's own iPad banned");
    await until(() => !fr.accounts.get(badAcc.id), 3000, "the moved account taken off the friend's iPad");
    await sleep(200);
    assert.equal(fr.client.bans$.length, 0, "the friend's iPad is NOT banned");
    assert.equal(fr.client.banned, undefined);
    assert.deepEqual(fr.accounts.list().map((p) => p.name).sort(), ['Friend', 'Sis'], 'their own accounts stay');
    assert.equal(fr.app.activeAccount, null, 'signed out of it');
    assert.ok(fr.app.toasts.some((h) => /<b>Bad<\/b> was banned by the admin, so it was taken off this iPad/.test(h)), 'and told');
    assert.equal(deletions(), 0, "its registry entry stays on the broker (the admin's list keeps it)");
    // the code again, now the list names it: the UI asks first and refuses (js/ui/accounts.js)
    assert.equal(await fr.client.accountBanned(badAcc.id), true, 'refused before anything is saved');
    assert.equal(await fr.client.accountBanned(fr.accounts.list()[0].id), false);
    // (brought over anyway, e.g. offline: taken off again at once, still no ban)
    const again = fr.accounts.importProfile(code);
    await until(() => !fr.accounts.get(again.id), 3000, 'taken off again');
    await sleep(100);
    assert.equal(fr.client.bans$.length, 0);
    // a reload of the friend's iPad: nothing to ban
    const fr2 = await playerPage(broker, 'page00000072', cfg, pubs, { store: fr.store, names: [] });
    await until(() => !!fr2.client.states.bans, 2000, 'list heard again');
    await sleep(200);
    assert.equal(fr2.client.bans$.length, 0);
    fr2.client.stop();
    // an account MADE on an iPad (not brought over) still bans that iPad: Bad's own (above)
    assert.deepEqual(bad.client.bans$[0], { reason: BAN_LIST_REASON });
  } finally {
    bad.client.stop();
    fr.client.stop();
  }
});

test("Philip's unban code alone doesn't last while the list names the iPad (it is banned again as it opens); REMOVE BAN first, then the code, does", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const sendList = listSender(broker, keys);
  const kid = await playerPage(broker, 'page00000080', cfg, pubs, { names: ['Kid', 'Sis'] });
  const kidRid = (await accountIds(kid.app.activeAccount.id)).rid;
  await sendList([{ r: kidRid, d: await banDid(kid.client.registry.did) }]);
  await until(() => kid.client.bans$.length === 1, 3000, 'banned');
  kid.client.stop();
  kid.app.presence.goOffline();
  // the unban code (the lock screen clears its ban stores), then the game opens, Sis signed in
  const open = async (id) => {
    const pg = await playerPage(broker, id, cfg, pubs, { store: kid.store, names: [] });
    pg.app.activeAccount = pg.accounts.setActive(pg.accounts.list().find((a) => a.name === 'Sis').id);
    return pg;
  };
  const p2 = await open('page00000081');
  await until(() => p2.client.bans$.length === 1, 3000, 'banned again (the list still names this iPad)');
  p2.client.stop();
  p2.app.presence.goOffline();
  // REMOVE BAN (a newer list without it), then the code: free
  await sendList([], Date.now() + 1);
  const p3 = await open('page00000082');
  try {
    await until(() => p3.client.states.bans && p3.client.states.bans.args.list.length === 0, 3000, 'the newer list');
    await sleep(200);
    assert.equal(p3.client.bans$.length, 0, 'not banned');
  } finally { p3.client.stop(); }
});

test("a ban list is taken even when the iPad's clock is behind (a banner or maintenance signed 'in the future' is not)", async () => {
  const { cfg, keys, pubs } = await shared;
  const DAY = 86400000;
  const gate = new CommandGate({ signPub: pubs.signPub, now: () => Date.now() - DAY });
  const now = Date.now();
  assert.equal((await gate.state(await makeEnvelope(keys.sign, 'bans', { list: [{ r: 'a'.repeat(16) }] }, '*', now), 'bans')).ok, true, 'a day behind: the list is still taken');
  assert.equal((await gate.state(await makeEnvelope(keys.sign, 'banner', { text: 'hi', id: 'b1', until: 0 }, '*', now), 'banner')).why, 'future');
  assert.equal((await gate.state(await makeEnvelope(keys.sign, 'maintenance', { on: true, until: now + 3600000 }, '*', now), 'maintenance')).why, 'future');
  const broker = fakeBroker();
  const sendList = listSender(broker, keys);
  const d = await playerPage(broker, 'page00000085', cfg, pubs, { names: ['Late'] });
  d.client.gate.now = () => Date.now() - DAY; // (its date set back a day)
  try {
    await sendList([{ r: (await accountIds(d.app.activeAccount.id)).rid }]);
    await until(() => d.client.bans$.length === 1, 3000, 'banned all the same');
  } finally { d.client.stop(); }
});

test('the card carries the signed-in account\'s rid and its token (not a guest\'s); cleanCard keeps only well-formed ones', async () => {
  const { cfg, pubs } = await shared;
  const broker = fakeBroker();
  const d = await playerPage(broker, 'page00000030', cfg, pubs, { names: ['Ruby'] });
  try {
    const card = d.client.card();
    const ids = await accountIds(d.app.activeAccount.id);
    assert.equal(card.rid, ids.rid);
    assert.equal(card.tok, ids.tok, 'the token proves the rid (sealed to the admin like the rest of the card)');
    assert.equal(card.account.length, 8, 'the card still carries only 8 characters of the account id');
    assert.equal(cleanCard(card).rid, card.rid);
    assert.equal(cleanCard(card).tok, card.tok);
    d.app.activeAccount = d.accounts.startGuest({ name: 'G' });
    assert.equal(d.client.card().rid, null, 'a guest: no rid');
    assert.equal(d.client.card().tok, null);
    assert.equal('rid' in cleanCard({ ...card, rid: 'nope' }), false);
    assert.equal('tok' in cleanCard({ ...card, rid: 'nope' }), false, 'no token without a rid');
    assert.equal('rid' in cleanCard({ ...card, rid: null }), false);
    assert.equal('tok' in cleanCard({ ...card, tok: 'x' }), false);
  } finally { d.client.stop(); }
});

// ------------------------------------------------------------------ the admin's side

/** The admin's page: an AdminClient + AdminSession on the fake broker, its own storage. */
async function adminPage(broker, cfg, pubs, keys, store = memStorage()) {
  const restore = useStorage(store);
  const p = broker.page('admin0000001');
  const app = fakeApp(p, 'Philip', { accounts: new AccountStore(store) });
  const client = new AdminClient(app, cfg, pubs);
  app.adminClient = client;
  client.chip = () => {};
  client.overlay = () => {};
  client.maintenance = () => {};
  client.start();
  const session = new AdminSession(app, { cfg, pubs, keys });
  app.admin = session;
  live.push(() => { app.admin.close(); client.stop(); }, restore);
  return { app, client, session, store, restore, p };
}

test('admin accounts(): entries opened (newest made first), deduped, deleted by an empty message; online and banned flags; junk ignored', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  // Ruby made an account and closed the game; then the admin opens his page (retained entries)
  const ruby = await playerPage(broker, 'page00000040', cfg, pubs, { names: ['Ruby'] });
  await until(() => broker.retained.size === 1, 2000, 'Ruby registered');
  ruby.client.stop();
  ruby.app.presence.goOffline();
  const guest = await playerPage(broker, 'page00000041', cfg, pubs, {}); // a guest page: never listed
  guest.app.activeAccount = guest.accounts.startGuest({ name: 'Visitor' });
  const A = await adminPage(broker, cfg, pubs, keys);
  try {
    await until(() => A.session.accounts().length === 1, 3000, 'Ruby listed');
    let [r] = A.session.accounts();
    assert.equal(r.name, 'Ruby');
    assert.equal(r.rid, (await accountIds(ruby.app.activeAccount.id)).rid);
    assert.equal(r.did, ruby.client.registry.did);
    assert.equal(r.online, false);
    assert.equal(r.banned, false);
    assert.equal(r.suspect, false);
    assert.equal(r.isNew, true, 'made since the ACCOUNTS tab was last opened (never)');
    assert.equal(A.session.newAccounts(), 1);
    A.session.seenAccounts({ fresh: true });
    assert.equal(A.session.newAccounts(), 0, 'the badge goes once the tab is open');
    assert.equal(A.session.accounts()[0].isNew, true, 'the row stays NEW while it is');
    // Max makes an account and stays online: newest first, online (his card has the rid)
    const max = await playerPage(broker, 'page00000042', cfg, pubs, { names: ['Max'] });
    await until(() => A.session.accounts().length === 2, 3000, 'Max listed');
    await A.session.refresh();
    await until(() => A.session.accounts()[0].name === 'Max' && A.session.accounts()[0].online, 3000, 'Max online, first');
    assert.equal(A.session.accounts()[1].name, 'Ruby');
    // the same entry again opens nothing; a newer one for the same account replaces it (one row)
    max.app.activeAccount.stats.wins = 4;
    await max.client.registry.sync({ force: true });
    await until(() => A.session.accounts().find((a) => a.name === 'Max').wins === 4, 3000, 'updated');
    assert.equal(A.session.accounts().length, 2, 'deduped');
    // junk on the registry's topics: ignored, counted
    const before = { ...A.session.accountStats().dropped };
    const x = broker.page('junk00000001');
    x.publish(REG_PREFIX + 'not-a-rid', '{}', { retain: true });
    x.publish(REG_PREFIX + 'a'.repeat(16), 'not json', { retain: true });
    x.publish(REG_PREFIX + 'b'.repeat(16), JSON.stringify({ e: 'x', iv: 'y', ct: 'z' }), { retain: true });
    x.publish(REG_PREFIX + 'c'.repeat(16), 'x'.repeat(REG_MAX + 1), { retain: true });
    x.publish(REG_PREFIX + 'd'.repeat(16), await sealRegistration(pubs.boxPub, { k: 'acct', rid: 'd'.repeat(16) }), { retain: true });
    await sleep(300);
    const after = A.session.accountStats().dropped;
    assert.ok(after.junk >= before.junk + 2 && after.big === before.big + 1 && after.bad >= before.bad + 2, JSON.stringify(after));
    assert.equal(A.session.accounts().length, 2, 'junk never listed');
    // Max deletes his account on his iPad: the entry goes
    max.app.activeAccount = null;
    max.accounts.remove(max.accounts.list()[0].id);
    await until(() => A.session.accounts().length === 1, 3000, 'deleted');
    // banned: the flag (and a banned account whose entry is gone stays listed, from memory)
    const rubyRid = r.rid;
    const res = await A.session.banAccount(rubyRid, { did: r.did, reason: 'mean in chat', name: 'Ruby' });
    assert.ok(res && res.env);
    assert.equal(res.online, 0, 'offline: banned the next time she opens Phortnite');
    await until(() => A.session.accounts()[0].banned, 2000, 'banned flag');
    broker.page('junk00000002').publish(REG_PREFIX + rubyRid, '', { retain: true }); // someone wipes her entry
    await sleep(100);
    [r] = A.session.accounts();
    assert.equal(r.gone, true);
    assert.equal(r.banned, true);
    assert.equal(r.name, 'Ruby', 'from the admin page\'s own memory');
    assert.equal(r.reason, 'mean in chat');
    max.client.stop();
  } finally {
    A.session.close();
    A.client.stop();
    guest.client.stop();
    A.restore();
  }
});

test("admin accounts(): an account that goes offline is 'seen' then (its entry says it once a day only; a stale card: a little after it was last heard), remembered on the admin's iPad: PLAYERS → OFFLINE has it first", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  // Max makes an account first, Ruby a moment later (her entry's 'seen' is the newer one); Ruby
  // closes the game before the admin opens his page, Max plays on
  const max = await playerPage(broker, 'page000000a0', cfg, pubs, { names: ['Max'] });
  const maxRid = (await accountIds(max.app.activeAccount.id)).rid;
  await until(() => broker.retained.has(REG_PREFIX + maxRid), 3000, 'Max registered');
  await sleep(30);
  const ruby = await playerPage(broker, 'page000000a1', cfg, pubs, { names: ['Ruby'] });
  const rubyRid = (await accountIds(ruby.app.activeAccount.id)).rid;
  await until(() => broker.retained.has(REG_PREFIX + rubyRid), 3000, 'Ruby registered');
  ruby.client.stop();
  ruby.app.presence.goOffline();
  const A = await adminPage(broker, cfg, pubs, keys);
  const row = (rid, s = A.session) => s.accounts().find((a) => a.rid === rid);
  try {
    await until(() => A.session.accounts().length === 2, 3000, 'both listed');
    await until(async () => { await A.session.refresh(); return row(maxRid).online; }, 3000, 'Max online');
    const entry = row(maxRid).seen;
    assert.ok(row(rubyRid).seen > entry, "Ruby's entry is the newer one");
    assert.deepEqual(offlineAccounts(A.session.accounts(), A.session.players()).map((a) => a.name), ['Ruby'], 'Max is online: only in the live rows');
    await sleep(40);
    // Max closes the game: OFFLINE, seen when he went (not his entry's day-old 'seen')
    max.client.stop();
    const t0 = Date.now();
    max.app.presence.goOffline();
    await until(async () => { await A.session.refresh(); return !row(maxRid).online; }, 3000, 'Max offline');
    const heard = row(maxRid).seen;
    assert.ok(heard >= t0 && heard <= Date.now(), `seen when he went (${heard - t0} ms)`);
    assert.equal(row(rubyRid).seen < heard, true);
    assert.deepEqual(offlineAccounts(A.session.accounts(), A.session.players()).map((a) => a.name), ['Max', 'Ruby'], 'Max left last: first');
    // kept on the admin's iPad: after a reload of his page, Max is still seen then
    A.session.saveMem();
    assert.equal(JSON.parse(A.store.getItem(ACCT_MEM_KEY))[maxRid].on, heard);
    A.session.close();
    const s2 = new AdminSession(A.app, { cfg, pubs, keys });
    A.app.admin = s2;
    live.push(() => s2.close());
    await until(() => s2.accounts().length === 2, 3000, 'listed again');
    assert.equal(row(maxRid, s2).seen, heard);
    assert.deepEqual(offlineAccounts(s2.accounts(), s2.players()).map((a) => a.name), ['Max', 'Ruby']);
    // an entry newer than that (he played again on another iPad): the entry's 'seen' wins
    await sleep(5);
    broker.page('page000000a2').publish(REG_PREFIX + maxRid, await sealRegistration(pubs.boxPub, await entryFor(max.app.activeAccount, max.client.registry.did)), { retain: true });
    await until(() => row(maxRid, s2).seen > heard, 3000, "his new entry's seen");
    assert.equal(row(maxRid, s2).name, 'Max');
    // a card that went stale (no goodbye: the iPad slept) was last heard long ago: seen a little after that
    const card = s2.players().find((p) => p.rid === maxRid);
    assert.equal(card, undefined, 'Max is offline');
    const long = Date.now() - 3600000;
    s2.onAt.set(maxRid, long);
    await s2.refresh();
    await until(() => s2.mem[maxRid].on === long + SEEN_SLACK_MS, 3000, 'seen a little after it was last heard');
  } finally {
    A.session.close();
    A.client.stop();
    A.restore();
  }
});

test("admin accounts(): someone who left while the admin's iPad slept is 'seen' a little after they were last heard before it, never 'just now' (the real presence moves every card's 'at' on after a freeze)", async () => {
  const { cfg, keys, pubs } = await shared;
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const FAST = { refreshMs: 600, perPlayerMs: 0, staleMin: 1500, minGapMs: 0, hideMs: 150, tickMs: 50, settleMs: 150, notifyMs: 20, backoffMs: 50, maxBackoffMs: 400, connectMs: 2000 };
  const pr = new Presence({ ...FAST }), pa = new Presence({ ...FAST });
  const realNow = Date.now;
  try {
    // Ruby plays; the admin's page sees her card
    const ruby = await playerPage({ page: () => pr }, 'unused', cfg, pubs, { names: ['Ruby'] });
    const rubyRid = (await accountIds(ruby.app.activeAccount.id)).rid;
    pr.start();
    const A = await adminPage({ page: () => pa }, cfg, pubs, keys);
    pa.start();
    const s = A.session;
    await until(async () => { await s.refresh(); return s.onAt.has(rubyRid); }, 8000, 'Ruby online on the admin page');
    const before = pa.peers.get(pr.id).heard;
    assert.ok(before > 0);
    // the admin's iPad sleeps (locked): its timers stop and it hears nothing; Ruby closes the game meanwhile
    clearInterval(pa.ticker);
    clearInterval(s.timer);
    clearInterval(pa.m.timer);
    const heard = pa.heard;
    pa.heard = () => {};
    ruby.client.stop();
    pr.stop();
    await sleep(50);
    Date.now = () => realNow() + 3600000; // an hour later, it wakes: the overdue timers run first
    pa.heard = heard;
    pa.ticker = setInterval(() => pa.tick(), pa.o.tickMs);
    s.timer = setInterval(() => s.refresh(), 5000);
    pa.tick();
    assert.ok(Date.now() - pa.peers.get(pr.id).at < 60000, "presence forgives the freeze: Ruby's 'at' reads about now");
    assert.equal(pa.peers.get(pr.id).heard, before, 'but not when she was really last heard');
    await s.refresh();
    assert.equal(s.onAt.get(rubyRid), before);
    // then the dead connection goes: the reconnect's snapshot has no Ruby
    b.drop((c) => c.id === pa.m.id);
    await until(() => !pa.peers.has(pr.id), 8000, 'Ruby gone on the admin page');
    await until(async () => { await s.refresh(); return !!(s.mem[rubyRid] && s.mem[rubyRid].on); }, 8000, 'her went-offline time');
    assert.equal(s.mem[rubyRid].on, before + SEEN_SLACK_MS, 'seen SEEN_SLACK_MS after she was last heard, at most');
    const row = s.accounts().find((a) => a.rid === rubyRid);
    assert.ok(Date.now() - row.seen > 55 * 60000, `OFFLINE says about an hour ago, not "just now" (${Math.round((Date.now() - row.seen) / 60000)} min)`);
  } finally {
    Date.now = realNow;
    pr.stop();
    pa.stop();
    useBrokers(null);
    await b.stop();
  }
});

test("admin accounts(): an entry's 'seen' from an iPad whose clock is set ahead counts as when the admin's page got it, at most: never pinned to the top of OFFLINE, never over the admin's own went-offline time", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const st = new AccountStore(memStorage());
  const ruby = st.create({ name: 'Ruby' }), leo = st.create({ name: 'Leo' });
  const rubyRid = (await accountIds(ruby.id)).rid, leoRid = (await accountIds(leo.id)).rid;
  const put = async (acc, seen) => broker.page('page000000b9').publish(REG_PREFIX + (await accountIds(acc.id)).rid, await sealRegistration(pubs.boxPub, await entryFor(acc, 'abcdefghijkl', { seen })), { retain: true });
  await put(ruby, Date.now() - 10000); // left 10 s ago
  await put(leo, Date.now() + 365 * 86400000); // his iPad's date is a year ahead
  const t0 = Date.now();
  const A = await adminPage(broker, cfg, pubs, keys);
  const row = (rid) => A.session.accounts().find((a) => a.rid === rid);
  await until(() => A.session.accounts().length === 2, 3000, 'both listed');
  assert.ok(row(leoRid).seen >= t0 && row(leoRid).seen <= Date.now(), 'not in the future: when this page got his entry');
  assert.ok(row(rubyRid).seen < t0, "Ruby's own (earlier) 'seen' stays");
  // the admin's page then sees Ruby, and Leo, go offline: those times show, and the newest is first
  await sleep(10);
  const t1 = Date.now();
  A.session.memo(leoRid, { on: t1 });
  A.session.memo(rubyRid, { on: t1 + 5 });
  assert.equal(row(leoRid).seen, t1);
  assert.deepEqual(offlineAccounts(A.session.accounts(), A.session.players()).map((a) => a.name), ['Ruby', 'Leo']);
});

test("admin accounts(): an entry must prove its topic (its tok hashes to the rid): a made-up one for a real account is dropped, before or after the admin's first look, and never renames the row or moves its iPad", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  // Ruby makes an account; a griefer listening on the registry overwrites every new entry at once
  // with a made-up one for the same rid (anyone can seal to the admin's public key)
  const evil = broker.page('evil00000001');
  const forged = new Set();
  let racing = true;
  evil.listen(REG_FILTER, async (text, topic) => {
    if (!racing || !text || forged.has(text)) return;
    const rid = topic.slice(REG_PREFIX.length);
    const fake = { k: 'acct', rid, tok: 'f'.repeat(32), did: 'evildevice01', name: 'MeanKid', created: Date.now(), seen: Date.now(), level: 99, wins: 999, matches: 1, kills: 1, v: 'x' };
    const t = await sealRegistration(pubs.boxPub, fake);
    forged.add(t);
    evil.publish(topic, t, { retain: true });
  });
  const ruby = await playerPage(broker, 'page00000050', cfg, pubs, { names: ['Ruby'] });
  const acc = ruby.app.activeAccount;
  const { rid, tok } = await accountIds(acc.id);
  await until(() => forged.has(broker.retained.get(REG_PREFIX + rid)), 3000, 'the forgery is what the broker keeps');
  // Philip opens his panel later, on an iPad that never saw Ruby (a new one, or storage cleared)
  const store = memStorage();
  const A = await adminPage(broker, cfg, pubs, keys, store);
  try {
    await until(() => A.session.accountStats().dropped.bad >= 1, 3000, 'the forgery dropped');
    await sleep(200);
    assert.equal(A.session.accounts().length, 0, 'never listed: not even once as "MeanKid"');
    // Ruby comes back (a broker that lost her entry gets it back, as here): listed as herself
    racing = false;
    await ruby.client.registry.sync({ force: true });
    await until(() => A.session.accounts().length === 1, 3000, 'Ruby listed');
    let [r] = A.session.accounts();
    assert.equal(r.name, 'Ruby');
    assert.equal(r.did, ruby.client.registry.did);
    assert.equal(r.suspect, false);
    await until(() => (JSON.parse(store.getItem(ACCT_MEM_KEY) || '{}')[rid] || {}).tok === tok, 2000, 'remembered');
    // a made-up entry after the admin's first look: dropped, the row stays Ruby's (marked: someone tried)
    racing = true;
    const bad0 = A.session.accountStats().dropped.bad;
    await ruby.client.registry.sync({ force: true }); // (the griefer overwrites it again at once)
    await until(() => A.session.accountStats().dropped.bad > bad0, 3000, 'dropped again');
    await until(() => A.session.accounts()[0].suspect, 3000, 'marked');
    [r] = A.session.accounts();
    assert.equal(r.name, 'Ruby', 'never the newcomer\'s name');
    assert.equal(r.wins, 0, 'or stats');
    assert.equal(r.did, ruby.client.registry.did, 'or iPad');
    // banning that row bans Ruby's account with Ruby's own iPad, never the griefer's made-up one
    const res = await A.session.banAccount(rid, { did: r.did, name: r.name });
    assert.deepEqual(res.env.args.list, [{ r: rid, d: await banDid(ruby.client.registry.did) }]);
    // the admin's memory lost Ruby (a flood of made-up accounts pushed her out, or a new iPad):
    // a forgery under her rid still can't take the row over (the tok proves it, not the memory)
    delete A.session.mem[rid];
    A.session.accts.delete(rid);
    const bad1 = A.session.accountStats().dropped.bad;
    evil.publish(REG_PREFIX + rid, await sealRegistration(pubs.boxPub, { k: 'acct', rid, tok: 'e'.repeat(32), did: 'evildevice02', name: 'Other', created: 1, seen: 1, level: 1, wins: 0, matches: 0, kills: 0, v: '' }), { retain: true });
    await until(() => A.session.accountStats().dropped.bad > bad1, 3000, 'dropped');
    assert.equal(A.session.accounts().find((a) => a.rid === rid && !a.gone), undefined, 'not listed as "Other"');
    // a reload of the admin's page with only a forgery on the broker: Ruby from memory, marked
    A.session.memo(rid, { tok, name: 'Ruby', created: acc.createdAt, did: ruby.client.registry.did });
    A.session.saveMem();
    A.session.close();
    const s2 = new AdminSession(A.app, { cfg, pubs, keys });
    A.app.admin = s2;
    await until(() => s2.accounts().length === 1 && !s2.accounts()[0].gone, 3000, 'listed again (not only as a banned one from memory)');
    assert.equal(s2.accounts()[0].name, 'Ruby', 'the name its own iPad sent');
    assert.equal(s2.accounts()[0].suspect, true);
    assert.equal(s2.accounts()[0].did, ruby.client.registry.did);
    s2.close();
  } finally {
    racing = false;
    A.session.close();
    A.client.stop();
    ruby.client.stop();
    A.restore();
  }
});

/** Seal a page's card again now (its first seal may still be on its way) until it carries `has`. */
const resealed = (client, has) => until(async () => {
  if (client.sealing) return false;
  client.cardKey = '';
  await client.refreshCard();
  return client.cardKey.includes(has);
}, 3000, 'card sealed again');

test("a card's rid counts only when its token proves it: a made-up card naming someone else's account doesn't make it online or get its MESSAGE / KICK / live ban", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  // Ruby: made an account, then closed the game
  const ruby = await playerPage(broker, 'page00000090', cfg, pubs, { names: ['Ruby'] });
  const { rid } = await accountIds(ruby.app.activeAccount.id);
  await until(() => broker.retained.has(REG_PREFIX + rid), 3000, 'Ruby registered');
  ruby.client.stop();
  ruby.app.presence.goOffline();
  // two made-up cards that name Ruby's rid: a wrong token, and none
  const fakes = [];
  for (const [id, tok] of [['evil00000003', 'f'.repeat(32)], ['evil00000004', undefined]]) {
    const ev = await playerPage(broker, id, cfg, pubs, { names: ['Aaa'] });
    const real = ev.client.card.bind(ev.client);
    ev.client.card = () => ({ ...real(), rid, tok });
    await resealed(ev.client, rid);
    fakes.push(ev);
  }
  const A = await adminPage(broker, cfg, pubs, keys);
  try {
    await until(() => A.session.accounts().length >= 1, 3000, 'Ruby listed');
    await A.session.refresh();
    await until(() => A.session.players().filter((p) => p.id.startsWith('evil')).length === 2, 3000, 'the cards opened');
    assert.ok(A.session.players().every((p) => !p.rid || p.me), "no rid kept from a card that can't prove it");
    assert.ok(A.session.players().every((p) => !('tok' in p)), 'and no token shown');
    assert.equal(A.session.accounts().find((a) => a.rid === rid).online, false, 'Ruby is not online');
    const cmds = () => broker.log.filter((m) => m.topic === CMD_TOPIC).length;
    const c0 = cmds();
    const res = await A.session.banAccount(rid, { name: 'Ruby' });
    assert.equal(res.online, 0, 'no live ban to an impostor');
    assert.equal(cmds(), c0, 'nothing sent to them');
    // Ruby's real card (her token proves her rid): online
    const back = await playerPage(broker, 'page00000091', cfg, pubs, { store: ruby.store, names: [] });
    back.client.checkBans = async () => false; // (she is on the list now: not what this checks)
    back.app.activeAccount = back.accounts.setActive(back.accounts.list()[0].id);
    await resealed(back.client, rid);
    await A.session.refresh();
    await until(() => A.session.accounts().find((a) => a.rid === rid).online, 3000, 'her own card: online');
    back.client.stop();
  } finally {
    for (const f of fakes) f.client.stop();
    A.session.close();
    A.client.stop();
    A.restore();
  }
});

test('admin accounts(): opened at most ACCT_RATE a second, and at most ACCTS_MAX kept or waiting (the rest dropped and counted)', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const pub = broker.page('lots00000001');
  const N = ACCT_RATE * 2 + 10;
  const st = new AccountStore(memStorage());
  for (let i = 0; i < N; i++) {
    const acc = st.create({ name: `P${i}` });
    const { rid } = await accountIds(acc.id);
    pub.publish(REG_PREFIX + rid, await sealRegistration(pubs.boxPub, await entryFor(acc)), { retain: true });
  }
  const A = await adminPage(broker, cfg, pubs, keys);
  try {
    await sleep(400);
    const first = A.session.accounts().length;
    assert.ok(first > 0 && first <= ACCT_RATE, `the first second: ${first} opened`);
    await until(() => A.session.accounts().length === N, 6000, 'all of them, over a few seconds');
    // a flood: what doesn't fit is dropped (and counted), never kept
    const s = A.session;
    const t0 = s.accts.size;
    for (let i = 0; i < ACCTS_MAX + 20; i++) s.onRegistration('{"junk":1}', REG_PREFIX + (i + 1e6).toString(16).padStart(16, '0'));
    assert.ok(s.accts.size + s.acctWait.size <= ACCTS_MAX, `${s.accts.size} + ${s.acctWait.size}`);
    assert.ok(t0 === N && s.accountStats().dropped.full >= 20, JSON.stringify(s.accountStats()));
  } finally {
    A.session.close();
    A.client.stop();
    A.restore();
  }
});

test('banAccount / unbanAccount: the signed list carries ids only (names and reasons stay on the admin\'s page); an online page is banned at once; REMOVE BAN stops a pending one', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const store = memStorage();
  const A = await adminPage(broker, cfg, pubs, keys, store);
  // Zed: made an account, then closed the game
  const zed = await playerPage(broker, 'page00000060', cfg, pubs, { names: ['Zed'] });
  const zedRid = (await accountIds(zed.app.activeAccount.id)).rid, zedDid = zed.client.registry.did;
  await until(() => broker.retained.has(REG_PREFIX + zedRid), 3000, 'Zed registered');
  zed.client.stop();
  zed.app.presence.goOffline();
  // Max: online
  const max = await playerPage(broker, 'page00000061', cfg, pubs, { names: ['Max'] });
  const maxRid = (await accountIds(max.app.activeAccount.id)).rid;
  try {
    await until(() => A.session.accounts().length === 2, 3000, 'both listed');
    await A.session.refresh();
    await until(() => A.session.accounts().find((a) => a.rid === maxRid).online, 3000, 'Max online');
    // ban Max (online): the list + the live ban at once
    const res = await A.session.banAccount(maxRid, { reason: 'Being mean', name: 'Max' });
    assert.equal(res.online, 1);
    assert.equal(res.sent, 1);
    const pubd = broker.log.filter((m) => m.topic === STATE_PREFIX + 'bans');
    const env = JSON.parse(pubd.at(-1).text);
    assert.equal(pubd.at(-1).retain, true);
    assert.deepEqual(env.args, { list: [{ r: maxRid, d: await banDid(max.client.registry.did) }] }, 'the account and its iPad (its id hashed one way)');
    assert.doesNotMatch(pubd.at(-1).text, /Max|Being mean/, 'no name or reason on the broker');
    assert.equal(pubd.at(-1).text.includes(max.client.registry.did), false, "no iPad's id in the clear either");
    const live = broker.log.filter((m) => m.topic === CMD_TOPIC).map((m) => JSON.parse(m.text));
    assert.ok(live.some((e) => e.cmd === 'ban' && e.to === max.app.presence.id), 'the live ban to his page');
    assert.doesNotMatch(JSON.stringify(live), /Being mean/, 'its reason sealed to his page');
    await until(() => max.client.bans$.length === 1, 3000, 'Max banned at once');
    await sleep(300);
    assert.equal(max.client.bans$.length, 1, 'once (the live ban and the list together)');
    assert.deepEqual(max.client.bans$[0], { reason: 'Being mean' }, 'the live ban went first: his screen shows the reason');
    const mem = JSON.parse(store.getItem(ACCT_MEM_KEY));
    assert.equal(mem[maxRid].reason, 'Being mean');
    assert.equal(mem[maxRid].name, 'Max');
    assert.ok(mem[maxRid].at > 0);
    assert.ok(mem[maxRid].live > 0, 'the ban reached his page: REMOVE BAN will say his iPad is banned already');
    await until(() => A.session.accounts().find((a) => a.rid === maxRid).bannedLive, 2000, 'bannedLive');
    assert.ok(store.getItem(BANS_KEY).includes(maxRid) && !store.getItem(BANS_KEY).includes('Max'), 'its own newest list kept (ids only)');
    // ban Zed (offline): only the list; then REMOVE BAN before he comes back: never banned
    const rz = await A.session.banAccount(zedRid, { did: zedDid, reason: 'x', name: 'Zed' });
    assert.equal(rz.online, 0);
    assert.deepEqual(A.session.bans().map((b) => b.r).sort(), [maxRid, zedRid].sort());
    assert.equal(A.session.bans().find((b) => b.r === zedRid).d, await banDid(zedDid));
    assert.equal(A.session.accounts().find((a) => a.rid === zedRid).bannedLive, false, 'offline: not banned yet');
    assert.equal(A.session.accounts().find((a) => a.rid === zedRid).did, zedDid, 'the panel shows the real (sealed) one');
    const un = await A.session.unbanAccount(zedRid);
    assert.deepEqual(un.args.list.map((b) => b.r), [maxRid]);
    assert.ok(un.ts > rz.env.ts, 'each list newer than the last');
    assert.equal(JSON.parse(store.getItem(ACCT_MEM_KEY))[zedRid].reason, undefined, 'the reason goes with the ban');
    const back = await playerPage(broker, 'page00000062', cfg, pubs, { store: zed.store, names: [] });
    back.app.activeAccount = back.accounts.setActive(back.accounts.list()[0].id);
    await until(() => back.client.states.bans && back.client.states.bans.n === un.n, 3000, 'Zed hears the newest list');
    await sleep(200);
    assert.equal(back.client.bans$.length, 0, 'Zed is not banned');
    // ban Zed for real while he is away: he is banned the moment he opens Phortnite again
    back.client.stop();
    back.app.presence.goOffline();
    await A.session.banAccount(zedRid, { did: zedDid, name: 'Zed' });
    const again = await playerPage(broker, 'page00000063', cfg, pubs, { store: zed.store, names: [] });
    await until(() => again.client.bans$.length === 1, 3000, 'banned on opening');
    again.client.stop();
    // the admin's own accounts can't be banned from his page
    const mine = A.app.accounts.create({ name: 'Philip' });
    const myRid = (await accountIds(mine.id)).rid;
    A.session.localRids();
    await assert.rejects(A.session.banAccount(myRid), /on this iPad/);
    await assert.rejects(A.session.banAccount('nope'), /not an account/);
  } finally {
    A.session.close();
    A.client.stop();
    max.client.stop();
    A.restore();
  }
});

test("the admin's page puts its newest ban list back after a reconnect when the broker forgot it, someone wiped it while he was away, or spoiled a copy", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const A = await adminPage(broker, cfg, pubs, keys);
  const topic = STATE_PREFIX + 'bans';
  try {
    const res = await A.session.banAccount('a'.repeat(16), { name: 'Old' });
    await until(() => A.client.states.bans && A.client.states.bans.n === res.env.n, 2000, 'echo');
    // the broker forgot it, and the page reconnects (no reload: it still has the list in memory)
    broker.retained.delete(topic);
    A.p.goOffline();
    A.p.goOnline();
    await until(() => broker.retained.has(topic), 6000, 'put back');
    assert.equal(JSON.parse(broker.retained.get(topic)).n, res.env.n);
    // someone wipes it while the admin's page is away (an iPad app switch drops the connection)
    A.p.goOffline();
    broker.page('junk00000003').publish(topic, '', { retain: true });
    A.p.goOnline();
    await until(() => broker.retained.has(topic), 6000, 'put back after a wipe');
    assert.equal(JSON.parse(broker.retained.get(topic)).n, res.env.n);
    // a spoiled copy with the same nonce (its list changed: no game would take it) goes back too
    await sleep(200);
    const spoiled = { ...JSON.parse(broker.retained.get(topic)) };
    spoiled.args = { list: [] };
    A.client.republished.bans = 0;
    broker.page('junk00000004').publish(topic, JSON.stringify(spoiled), { retain: true });
    await until(() => JSON.parse(broker.retained.get(topic)).args.list.length === 1, 6000, 'the real one back');
    // and when nothing is wrong: a reconnect leaves it alone
    await sleep(300);
    const n = broker.log.filter((m) => m.topic === topic).length;
    A.p.goOffline();
    A.p.goOnline();
    await sleep(4500);
    assert.equal(broker.log.filter((m) => m.topic === topic).length, n, 'nothing to put back');
  } finally {
    A.session.close();
    A.client.stop();
    A.restore();
  }
});

test("device ids are never on the relay in the clear: a lifted iPad can't be banned again through someone else's account by copying its id", async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const A = await adminPage(broker, cfg, pubs, keys);
  const vic = await playerPage(broker, 'page00000095', cfg, pubs, { names: ['Vic'] });
  const vicRid = (await accountIds(vic.app.activeAccount.id)).rid, vicDid = vic.client.registry.did;
  try {
    await until(() => A.session.accounts().some((a) => a.rid === vicRid), 3000, 'Vic listed');
    const res = await A.session.banAccount(vicRid, { did: vicDid, name: 'Vic' });
    const text = broker.retained.get(STATE_PREFIX + 'bans');
    assert.equal(text.includes(vicDid), false, 'only a one-way hash of the iPad id');
    const d = res.env.args.list[0].d;
    assert.match(d, BDID_RE);
    // a spy copies what it read into its own storage as its device id: not a device id, a fresh one is made
    const spyStore = memStorage();
    spyStore.setItem(DEVICE_KEY, d);
    const spyDid = deviceId(spyStore);
    assert.notEqual(spyDid, d);
    assert.notEqual(await banDid(spyDid), d, "so its own ban never names Vic's iPad");
  } finally {
    vic.client.stop();
    A.session.close();
    A.client.stop();
    A.restore();
  }
});

test('every account is told once on this device that the admin keeps a list of accounts (never a guest, never in admin mode, not one the create screen told)', async () => {
  const { cfg, pubs } = await shared;
  const broker = fakeBroker();
  const d = await playerPage(broker, 'page00000096', cfg, pubs, { names: ['Ruby', 'Leo', 'New'] });
  const told = () => d.app.toasts.filter((h) => /keeps a list of accounts/.test(h)).length;
  const restore = useStorage(d.store); // (who was told is kept in the device's localStorage)
  try {
    d.client.tellRegistry();
    d.client.tellRegistry();
    assert.equal(told(), 1, 'once');
    assert.match(d.app.toasts.find((h) => /keeps a list of accounts/.test(h)), /<b>Ruby<\/b>.*ban an account even while it's offline.*whole iPad/);
    const [, leo, nu] = d.accounts.list();
    d.app.activeAccount = d.accounts.setActive(leo.id);
    d.client.accountChanged();
    assert.equal(told(), 2, "another account on the same iPad: told too (a sibling didn't see Ruby's)");
    d.client.markTold(nu.id); // (made on the create screen, which said so)
    d.app.activeAccount = d.accounts.setActive(nu.id);
    assert.equal(d.client.tellRegistry(), false);
    d.app.activeAccount = d.accounts.startGuest({ name: 'G' });
    assert.equal(d.client.tellRegistry(), false, 'a guest: never');
    d.app.activeAccount = d.accounts.setActive(d.accounts.list()[0].id);
    d.app.admin = { sent: new Set() };
    d.client.told.delete(d.app.activeAccount.id);
    assert.equal(d.client.tellRegistry(), false, 'admin mode: never');
    d.app.admin = null;
    // a reload keeps who was told (TOLD_KEY on the device)
    assert.ok(JSON.parse(d.store.getItem(TOLD_KEY)).includes(leo.id));
    const d2 = await playerPage(broker, 'page00000097', cfg, pubs, { store: d.store, names: [] });
    d2.app.activeAccount = d2.accounts.setActive(leo.id);
    assert.equal(d2.client.tellRegistry(), false, 'not again after a reload');
    d2.client.stop();
  } finally {
    d.client.stop();
    restore();
  }
});
