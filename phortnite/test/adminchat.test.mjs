// Party chat moderation (stage 3, js/admin/): the admin's mute / unmute / chatlog commands (one page
// only, sealed to it), what a page does with them (the player is always told), the uploads pages
// seal to the admin on UP_TOPIC (a chat log, a report, the live party chat from the host's page
// only, batched), and the admin's side: opening uploads within a budget, junk dropped, capped
// memory, and an upload counted as a page's own only when that page's key sealed it.
// No broker here: a tiny in-memory stand-in for the presence connection (listen / publish / cards)
// carries real sealed messages between real AdminClient / AdminSession objects. Keys are made with
// the smallest round count allowed, like test/admin.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig, importPublic, unlockAdmin, createAdminConfig, openSealed, sealToAdmin, newBoxKey, importBoxPub, MIN_ITER,
  SEAL_UP, SEAL_CARD,
} from '../public/js/admin/keys.js';
import {
  CMD_TOPIC, LIVE_CMDS, ALL_OK, MAX_MUTE_MIN, CommandGate, Budget, makeEnvelope, cleanArgs, cleanUpload, cleanChatLine, sealUpload,
  upShape, UP_TOPIC, UP_MAX, UP_LINES, UP_CONTEXT, adminLineOk,
} from '../public/js/admin/commands.js';
import { AdminClient, FEED_MS } from '../public/js/admin/client.js';
import {
  AdminSession, UP_RATE, UP_RATE_MS, UP_KEY_RATE, ODD_RATE, UP_CLEAN_MS, UP_WORK_MS, PARTY_LINES, PARTIES, REPORTS, LOG_WAIT_MS,
} from '../public/js/admin/session.js';
import { AdminPanel } from '../public/js/ui/admin.js';
import { defaultStats } from '../public/js/accounts/stats.js';
import { MAX_CHAT } from '../public/shared/chatFilter.js';

const PASSWORD = 'TEST-CHAT-23XY'; // made up for the tests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, what = '') => {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(`timed out ${what}`); await sleep(10); }
};

const shared = (async () => {
  const cfg = loadConfig(await createAdminConfig(PASSWORD, { iter: MIN_ITER }));
  const other = loadConfig(await createAdminConfig('OTHR-CHAT-2345', { iter: MIN_ITER }));
  return {
    cfg, keys: await unlockAdmin(cfg, PASSWORD), pubs: await importPublic(cfg),
    otherKeys: await unlockAdmin(other, 'OTHR-CHAT-2345'), otherPubs: await importPublic(other),
  };
})();

/**
 * An in-memory stand-in for the public broker as js/net/presence.js shows it to the admin code:
 * every page gets { id, listen, publish, setExtra, cards, onCards }. Delivery is async (like a
 * network), and everything published is logged (what someone listening on the broker would see).
 */
function fakeBroker() {
  const subs = [];
  const cards = new Map();
  const cardFns = [];
  const log = [];
  return {
    log,
    page(id) {
      const p = {
        id, online: true, counts: { total: 1, inMatch: 0, inLobby: 1 },
        listen(topic, fn) {
          const s = { topic, fn };
          subs.push(s);
          return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
        },
        publish(topic, text) {
          if (!p.online) return false;
          log.push({ topic, text, from: id });
          for (const s of [...subs]) if (s.topic === topic) setTimeout(() => s.fn(text, topic, false), 1);
          return true;
        },
        setExtra(f) {
          if (!f || !f.a) return;
          const prev = cards.get(id);
          cards.set(id, { a: f.a, prev: prev ? prev.a : null });
          for (const fn of cardFns) fn();
        },
        cards() { return [...cards].filter(([k]) => k !== id).map(([k, v]) => ({ id: k, s: 'l', a: v.a, prev: v.prev, at: Date.now() })); },
        onCards(fn) { cardFns.push(fn); return () => {}; },
      };
      return p;
    },
  };
}

/** app.chat as js/ui/chat.js has it (the API the admin code relies on), recording what it is asked. */
function fakeChat(lines = []) {
  const fns = new Set();
  const c = {
    list: lines, mutes: [], notices: [], opened: false, mute: null,
    lines() { return c.list.map((l) => ({ ...l })); },
    onLine(fn) { fns.add(fn); return () => fns.delete(fn); },
    emit(line, game) { c.list.push(line); for (const fn of [...fns]) fn({ ...line }, game); },
    setMute(until, reason = '') { c.mutes.push({ until, reason }); c.mute = until > Date.now() ? { until, reason } : null; },
    muted() { return c.mute && c.mute.until > Date.now() ? { ...c.mute } : null; },
    notice(t) { c.notices.push(t); },
    isOpen() { return c.opened; },
    open() { c.opened = true; return true; },
    close() { c.opened = false; },
  };
  return c;
}

/** A stand-in for the App: enough for AdminClient / AdminSession (no DOM). */
function fakeApp(presence, name, extra = {}) {
  const app = {
    presence, settings: { name }, profile: { level: 7, data: defaultStats(), save() {} }, partyKind: () => 'solo', game: null,
    activeAccount: { id: 'p_0123456789abcdef', name }, admin: null, toasts: [],
    announce: { setAdmin() {} },
    lobby: { toast(html) { app.toasts.push(html); }, render() {} },
    ...extra,
  };
  return app;
}

/** A page's AdminClient (real commands, nothing drawn), started, its card sealed. */
async function page(broker, id, name, cfg, pubs, extra = {}) {
  const app = fakeApp(broker.page(id), name, extra);
  const c = new AdminClient(app, cfg, pubs);
  app.adminClient = c;
  c.chip = () => {};
  c.overlay = () => {};
  c.maintenance = () => {};
  c.start();
  await c.keyReady;
  await c.refreshCard();
  return { app, client: c };
}

/** A party as a Game shows it: kind 'p2p-host' | 'p2p' | 'solo', humans in the roster, observers in the room; myId: this page's room id. */
function fakeGame(kind, code, humans = 2, observers = 0, myId = 1) {
  const roster = new Map();
  for (let i = 1; i <= humans; i++) roster.set(i, { id: i, name: `P${i}`, bot: false });
  roster.set(99, { id: 99, name: 'Bot', bot: true });
  const room = kind === 'p2p-host' ? { code, observers: new Map([...Array(observers)].map((_, i) => [`o${i}`, {}])) } : null;
  return { code, myId, phase: 'lobby', observer: false, roster, settingsState: {}, net: { kind, room } };
}

const line = (i, extra = {}) => ({ id: 1, name: 'Mia', text: `hello ${i}`, ts: 1000 + i, code: 'ABCD', at: Date.now(), ...extra });

// ------------------------------------------------------------------ the commands

test('chat commands: mute / unmute / chatlog are live commands for one page only, their args clamped and sealed to that page', async () => {
  const { keys, pubs } = await shared;
  for (const c of ['mute', 'unmute', 'chatlog']) {
    assert.ok(LIVE_CMDS.includes(c), c);
    assert.ok(!ALL_OK.includes(c), `${c} never goes to everyone`);
  }
  assert.equal(MAX_MUTE_MIN, 10080, 'a week at most');
  // mute: 1..10080 whole minutes, a reason of at most 120 characters
  assert.deepEqual(cleanArgs('mute', { minutes: 60, reason: '  be kind  ' }), { minutes: 60, reason: 'be kind' });
  assert.deepEqual(cleanArgs('mute', { minutes: 1 }), { minutes: 1, reason: '' });
  assert.deepEqual(cleanArgs('mute', { minutes: 10080 }), { minutes: 10080, reason: '' });
  assert.deepEqual(cleanArgs('mute', { minutes: 90.7 }), { minutes: 90, reason: '' });
  for (const minutes of [0, 0.5, -10, 10081, 1e9, NaN, Infinity, '10', null, undefined]) assert.equal(cleanArgs('mute', { minutes }), null, String(minutes));
  assert.equal(cleanArgs('mute', { minutes: 10, reason: 'x'.repeat(500) }).reason.length, 120);
  assert.equal(cleanArgs('mute', { minutes: 10, reason: 'a\u0000b\u001fc' }).reason, 'abc');
  assert.deepEqual(cleanArgs('unmute', { minutes: 5, junk: 1 }), {});
  assert.deepEqual(cleanArgs('chatlog', { x: 'y' }), {});

  // sealed per page: nothing in the clear, only that page's key opens it
  const now = 1.8e12;
  const me = 'abc123def456';
  const pg = await newBoxKey(), faker = await newBoxKey();
  const gate = new CommandGate({ signPub: pubs.signPub, pageKey: pg.priv, now: () => now });
  const mute = await makeEnvelope(keys.sign, 'mute', { minutes: 60, reason: 'said a bad word' }, me, now, { pagePub: pg.pub });
  assert.deepEqual(Object.keys(mute.args), ['x']);
  // (texts with a space or a quote: base64 never has those, so a random ciphertext can't match by chance)
  assert.ok(!JSON.stringify(mute).includes('bad word') && !JSON.stringify(mute).includes('"minutes"'), 'minutes and reason are sealed');
  assert.deepEqual((await gate.live(mute, me)).env.args, { minutes: 60, reason: 'said a bad word' });
  assert.deepEqual((await gate.live(await makeEnvelope(keys.sign, 'unmute', {}, me, now, { pagePub: pg.pub }), me)).env.args, {});
  assert.deepEqual((await gate.live(await makeEnvelope(keys.sign, 'chatlog', {}, me, now, { pagePub: pg.pub }), me)).env.args, {});
  assert.equal((await gate.live(await makeEnvelope(keys.sign, 'mute', { minutes: 5 }, me, now, { pagePub: faker.pub }), me)).why, 'card', 'sealed to another page');
  await assert.rejects(makeEnvelope(keys.sign, 'mute', { minutes: 0 }, me, now, { pagePub: pg.pub }), /bad args/);
  await assert.rejects(makeEnvelope(keys.sign, 'chatlog', {}, me, now), /no key/);
  // never '*': a page refuses it, and the admin's session won't sign one
  for (const [cmd, args] of [['mute', { minutes: 5 }], ['unmute', {}], ['chatlog', {}]]) {
    assert.equal((await gate.live(await makeEnvelope(keys.sign, cmd, args, '*', now), me)).why, 'to', `${cmd} to everyone`);
  }
  const broker = fakeBroker();
  const session = new AdminSession(fakeApp(broker.page('admin0000001'), 'Philip'), { cfg: (await shared).cfg, pubs, keys });
  try {
    await assert.rejects(session.send('mute', { minutes: 5 }, '*'), /one player at a time/);
    await assert.rejects(session.mute('*', 5), /one player at a time/);
  } finally { session.close(); }
});

test('the admin\'s chat lines are signed: adminLineOk only for his signature, this party\'s code and this very text; \'say\' is never a live command', async () => {
  const { keys, pubs, otherKeys, cfg } = await shared;
  // the args: a party code and a line the chat filter cleaned (or nothing)
  assert.deepEqual(cleanArgs('say', { code: 'ABCD', text: '  Be   kind, shit ' }), { code: 'ABCD', text: 'Be kind, ★★★★' });
  for (const a of [{ code: 'abcd', text: 'hi' }, { code: 'SOLO1', text: 'hi' }, { code: 'ABCD', text: '   ' }, { code: 'ABCD' }, null]) assert.equal(cleanArgs('say', a), null, JSON.stringify(a));
  const broker = fakeBroker();
  const session = new AdminSession(fakeApp(broker.page('admin0000002'), 'Philip'), { cfg, pubs, keys });
  try {
    const env = await session.sayEnvelope('abcd', 'Be kind, everyone!');
    assert.equal(env.cmd, 'say');
    assert.equal(env.to, '*');
    assert.deepEqual(env.args, { code: 'ABCD', text: 'Be kind, everyone!' });
    assert.equal(await adminLineOk(pubs.signPub, env, 'ABCD', 'Be kind, everyone!'), true);
    // the room cleans the line again: the same text (the filter is idempotent), still his
    const sw = await session.sayEnvelope('ABCD', 'no shit here');
    assert.equal(await adminLineOk(pubs.signPub, sw, 'ABCD', 'no ★★★★ here'), true);
    // another party, another text, a changed signature or body, another key, junk: not his
    assert.equal(await adminLineOk(pubs.signPub, env, 'WXYZ', 'Be kind, everyone!'), false, 'another party');
    assert.equal(await adminLineOk(pubs.signPub, env, 'ABCD', 'Tell me your school'), false, 'another text');
    assert.equal(await adminLineOk(pubs.signPub, { ...env, args: { code: 'ABCD', text: 'Tell me your school' } }, 'ABCD', 'Tell me your school'), false, 'a changed body');
    assert.equal(await adminLineOk(pubs.signPub, { ...env, sig: env.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }, 'ABCD', 'Be kind, everyone!'), false, 'a changed signature');
    const forged = await makeEnvelope(otherKeys.sign, 'say', { code: 'ABCD', text: 'I am the admin' }, '*');
    assert.equal(await adminLineOk(pubs.signPub, forged, 'ABCD', 'I am the admin'), false, 'another key');
    const observe = await session.observeHello('ABCD');
    assert.equal(await adminLineOk(pubs.signPub, observe, 'ABCD', 'hi'), false, 'another command');
    for (const junk of [null, undefined, 'env', 42, [], {}, { ...env, v: 2 }, { ...env, to: 'abc' }]) assert.equal(await adminLineOk(pubs.signPub, junk, 'ABCD', 'Be kind, everyone!'), false, JSON.stringify(junk));
    assert.equal(await adminLineOk(null, env, 'ABCD', 'Be kind, everyone!'), false, 'no key: nothing is his');
    // no age check: a welcome's history repeats lines minutes old
    const old = await makeEnvelope(keys.sign, 'say', { code: 'ABCD', text: 'GG!' }, '*', Date.now() - 3600000);
    assert.equal(await adminLineOk(pubs.signPub, old, 'ABCD', 'GG!'), true);
    // 'say' never passes as a live command (to everyone or one page)
    assert.ok(!LIVE_CMDS.includes('say'));
    const gate = new CommandGate({ signPub: pubs.signPub });
    assert.equal((await gate.live(env, 'abc123def456')).why, 'cmd');
  } finally { session.close(); }
});

// ------------------------------------------------------------------ the page side, end to end

test('page side: mute, unmute and chatlog reach only the page they name; the player is told; the log opens only with the admin key (SEAL_UP)', async () => {
  const { cfg, keys, pubs, otherKeys } = await shared;
  const broker = fakeBroker();
  const chat = fakeChat([line(1), line(2, { name: 'Sam', id: 2 }), { id: 0, name: '', text: 'Sam joined', ts: 0, code: 'ABCD', at: Date.now(), sys: true }]);
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs, { chat });
  const samChat = fakeChat();
  const sam = await page(broker, 'sampage00001', 'Sam', cfg, pubs, { chat: samChat });
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  try {
    await until(() => session.players().length === 3, 3000, 'cards');
    // mute for an hour, with a reason: app.chat.setMute(now + 60 min, reason), and a card on screen
    const t0 = Date.now();
    assert.ok(await session.mute('miapage00001', 60, 'be kind'));
    await until(() => chat.mutes.length === 1, 3000, 'muted');
    assert.ok(Math.abs(chat.mutes[0].until - (t0 + 3600000)) < 3000, `until ${chat.mutes[0].until - t0}`);
    assert.equal(chat.mutes[0].reason, 'be kind');
    assert.match(mia.app.toasts.at(-1), /🔇 The admin muted your chat for <b>1 hour<\/b>/);
    assert.match(mia.app.toasts.at(-1), /be kind/);
    assert.equal(samChat.mutes.length, 0, 'not Sam');
    // the admin's panel sees who is muted (the card says until when)
    await mia.client.refreshCard();
    await until(() => (session.players().find((p) => p.id === 'miapage00001') || {}).muted === chat.mutes[0].until, 3000, 'muted on the card');
    // nothing private crossed the broker in the clear
    // (texts with a space or a quote: base64 never has those, so a random ciphertext can't match by chance)
    assert.ok(!broker.log.some((m) => /be kind|"Mia"|hello /.test(m.text)), 'sealed');
    // a day and 10 minutes say so too
    await session.mute('miapage00001', 1440);
    await until(() => chat.mutes.length === 2, 3000);
    assert.match(mia.app.toasts.at(-1), /for <b>1 day<\/b>/);
    // unmute
    await session.unmute('miapage00001');
    await until(() => chat.mutes.length === 3, 3000, 'unmuted');
    assert.equal(chat.mutes[2].until, 0);
    assert.match(mia.app.toasts.at(-1), /🔈 The admin unmuted your chat/);

    // the chat log: the page's lines, sealed to the admin; the player sees the admin looked
    const log = await session.requestLog('miapage00001');
    assert.ok(log, 'an answer');
    assert.equal(log.id, 'miapage00001');
    assert.equal(log.name, 'Mia');
    assert.deepEqual(log.lines.map((l) => l.text), ['hello 1', 'hello 2', 'Sam joined']);
    assert.equal(log.lines[2].sys, true);
    assert.equal(log.lines[1].name, 'Sam');
    assert.deepEqual(chat.notices, ['🛡 The admin looked at this chat'], 'open moderation: in the chat list');
    assert.match(mia.app.toasts.at(-1), /The admin looked at your chat log/, 'and a toast: the chat was not open');
    assert.deepEqual(samChat.notices, []);
    // what crossed the broker: one sealed upload, only the admin's box key opens it, and only as an upload
    const up = broker.log.filter((m) => m.topic === UP_TOPIC);
    assert.equal(up.length, 1);
    assert.equal(up[0].from, 'miapage00001');
    assert.ok(!/hello |"Mia"|"Sam"|"text"/.test(up[0].text), 'no chat text in the clear');
    const sealed = JSON.parse(up[0].text);
    assert.ok(upShape(sealed));
    assert.equal(sealed.e, mia.client.pageKey.raw, "sealed with Mia's own page key (the admin can tell it's hers)");
    const opened = await openSealed(keys.box, sealed, SEAL_UP, { max: UP_MAX });
    assert.equal(opened.k, 'log');
    assert.equal(opened.from, 'miapage00001');
    assert.equal(opened.lines.length, 3);
    assert.equal(await openSealed(keys.box, sealed, SEAL_CARD, { max: UP_MAX }), null, "an upload can't pass for a card");
    assert.equal(await openSealed(otherKeys.box, sealed, SEAL_UP, { max: UP_MAX }), null, 'another key');
    // while the chat is open the list's notice is enough
    chat.opened = true;
    const toasts = mia.app.toasts.length;
    assert.ok(await session.requestLog('miapage00001'));
    assert.equal(mia.app.toasts.length, toasts);
    assert.equal(chat.notices.length, 2);
  } finally {
    session.close();
    for (const p of [mia, sam, adm]) p.client.stop();
  }
});

test('requestLog: only the asked page\'s own sealed answer counts; no answer gives null after the wait', async () => {
  const { cfg, keys, pubs } = await shared;
  assert.equal(LOG_WAIT_MS, 10000);
  const broker = fakeBroker();
  const chat = fakeChat([line(1)]);
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs, { chat });
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  const x = broker.page('snoop0000001'); // someone on the public broker
  try {
    await until(() => session.players().some((p) => p.id === 'miapage00001'), 3000, 'card');
    // someone who sees the chatlog command go by races a made-up answer in (an ephemeral key, Mia's id)
    const forged = [];
    x.listen(CMD_TOPIC, async (text) => {
      const env = JSON.parse(text);
      if (env.cmd !== 'chatlog') return;
      const fake = await sealUpload(pubs.boxPub, { k: 'log', re: env.n, from: 'miapage00001', code: 'ABCD', v: '2.5.0', lines: [line(1, { text: 'MADE UP' })] });
      forged.push(env.n);
      x.publish(UP_TOPIC, fake);
    });
    // Mia's page answers a little later than the forger
    const real = mia.client.chatlog.bind(mia.client);
    mia.client.chatlog = async (n) => { await sleep(80); return real(n); };
    const log = await session.requestLog('miapage00001');
    assert.equal(forged.length, 1, 'the forger answered first');
    assert.deepEqual(log.lines.map((l) => l.text), ['hello 1'], 'only the real one');
    // no answer: null once the wait is over
    mia.client.chatlog = async () => false;
    const t0 = Date.now();
    assert.equal(await session.requestLog('miapage00001', 300), null);
    assert.ok(Date.now() - t0 >= 280);
    // nobody with that id (no card, no key): null at once
    assert.equal(await session.requestLog('nobody000001', 300), null);
    // offline: nothing sent, null
    adm.app.presence.online = false;
    assert.equal(await session.requestLog('miapage00001', 300), null);
  } finally {
    session.close();
    mia.client.stop();
    adm.client.stop();
  }
});

test('report: a player\'s 🚩 reaches the admin\'s reports with up to 10 lines before it; the admin is told; false when offline', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs, { chat: fakeChat() });
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  try {
    await until(() => session.players().some((p) => p.id === 'miapage00001'), 3000, 'card');
    let changed = 0;
    const off = session.onChats(() => changed++);
    const ctx = [...Array(14)].map((_, i) => line(i, { name: 'Sam', id: 2 }));
    const bad = line(20, { name: 'Sam', id: 2, text: 'you are ★★★★' });
    assert.equal(await mia.client.report(bad, ctx, 'he is mean'), true);
    await until(() => session.reports().length === 1, 3000, 'report');
    const r = session.reports()[0];
    assert.equal(r.name, 'Mia', 'who reported it');
    assert.equal(r.ok, true, "sealed with Mia's own page key");
    assert.equal(r.code, 'ABCD');
    assert.equal(r.line.text, 'you are ★★★★');
    assert.equal(r.line.name, 'Sam');
    assert.equal(r.reason, 'he is mean');
    assert.equal(r.context.length, UP_CONTEXT);
    assert.equal(r.context.at(-1).text, 'hello 13', 'the lines right before it');
    assert.equal(session.unseenReports(), 1);
    assert.ok(changed >= 1);
    assert.match(adm.app.toasts.at(-1), /🚩 New chat report from <b>Mia<\/b>/);
    session.seenReports();
    assert.equal(session.unseenReports(), 0);
    // the same report again: once
    assert.equal(await mia.client.report(bad, ctx), true);
    await sleep(60);
    assert.equal(session.reports().length, 1);
    // a page can't flood the admin: 5 reports a minute
    let sent = 0;
    for (let i = 0; i < 8; i++) if (await mia.client.report(line(30 + i), [])) sent++;
    assert.equal(sent, 3, '5 a minute, 2 already used');
    // offline: false (the chat says "Couldn't reach the admin right now")
    mia.client.upTimes.report = [];
    mia.app.presence.online = false;
    assert.equal(await mia.client.report(line(50), []), false);
    off();
  } finally {
    session.close();
    mia.client.stop();
    adm.client.stop();
  }
});

// ------------------------------------------------------------------ uploads: size, junk, budget, caps

test('uploads: a sealed upload stays under UP_MAX (oldest lines left out); junk never gets through cleanUpload', async () => {
  const { keys, pubs } = await shared;
  const me = await newBoxKey();
  // 100 long lines of emoji (4 bytes each in UTF-8): far more than UP_MAX
  const big = [...Array(100)].map((_, i) => line(i, { text: `${i} ${'😀'.repeat(55)}` }));
  const text = await sealUpload(pubs.boxPub, { k: 'log', re: 'AAAAAAAAAAAAAAAA', from: 'miapage00001', code: 'ABCD', v: '2.5.0', lines: big }, { from: me });
  assert.ok(text.length <= UP_MAX, `${text.length}`);
  assert.ok(text.length > UP_MAX * 0.8, 'it fills the room it has');
  const sealed = JSON.parse(text);
  assert.equal(sealed.e, me.raw);
  const o = cleanUpload(await openSealed(keys.box, sealed, SEAL_UP, { max: UP_MAX }));
  assert.ok(o.lines.length < 100 && o.lines.length > 20, `${o.lines.length} lines`);
  assert.equal(o.lines.at(-1).text, big.at(-1).text, 'the newest line is kept');
  assert.equal(o.lines[0].text, big[100 - o.lines.length].text, 'the oldest are left out');
  // a report keeps its line and trims its context
  const rep = await sealUpload(pubs.boxPub, { k: 'report', from: 'miapage00001', code: 'ABCD', line: big[99], context: big.slice(0, 99) });
  const ro = cleanUpload(await openSealed(keys.box, JSON.parse(rep), SEAL_UP, { max: UP_MAX }));
  assert.equal(ro.line.text, big[99].text);
  assert.equal(ro.context.length, UP_CONTEXT);
  // more than UP_LINES: the newest UP_LINES
  const many = [...Array(150)].map((_, i) => line(i));
  const mo = cleanUpload(await openSealed(keys.box, JSON.parse(await sealUpload(pubs.boxPub, { k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: many })), SEAL_UP, { max: UP_MAX }));
  assert.equal(mo.lines.length, UP_LINES);
  assert.equal(mo.lines[0].text, 'hello 50');

  // cleanUpload / cleanChatLine: junk and caps
  for (const junk of [null, 'x', [], {}, { k: 'chat' }, { k: 'nope', from: 'abc' }, { k: 'chat', from: 'NOT VALID', code: 'ABCD', lines: [line(1)] },
    { k: 'chat', from: 'abc', code: 'SOLO', lines: [line(1)] }, { k: 'chat', from: 'abc', code: 'ABCD', lines: [] }, { k: 'chat', from: 'abc', code: 'ABCD', lines: 'x' },
    { k: 'log', from: 'abc', re: 'short' }, { k: 'report', from: 'abc', line: null }, { k: 'report', from: 'abc', line: { text: '' } },
    { k: 'report', from: 'abc', line: { text: 'note', sys: true } }]) {
    assert.equal(cleanUpload(junk), null, JSON.stringify(junk));
  }
  const l = cleanChatLine({ id: 3.7, name: '<b>Mia</b>'.repeat(5), text: `call me 555 123 4567 ${'x'.repeat(400)}`, ts: 5, admin: true, q: 99, extra: 'drop me', at: 'x' });
  assert.equal(l.id, 3);
  assert.ok(l.name.length <= 16);
  assert.ok(l.text.length <= MAX_CHAT);
  assert.match(l.text, /\[hidden\]/, 'cleaned again: a modded page cannot push personal info past the admin\'s filter either');
  assert.equal(l.admin, undefined, "admin only for an observer's (negative) id");
  assert.equal(l.q, undefined);
  assert.equal(l.extra, undefined);
  assert.equal(l.at, undefined);
  assert.deepEqual(cleanChatLine({ id: -5, name: 'Whoever', text: 'hi', ts: 1, admin: true }), { id: -5, name: 'Admin', text: 'hi', ts: 1, admin: true });
  assert.equal(cleanChatLine({ id: 1, name: 'Mia', text: 'anything', ts: 1, q: 1 }).text, 'GG!', 'a quick line shows its own text');
  assert.equal(cleanChatLine({ text: '​​' }), null);
});

test('admin side: uploads are opened within a budget, junk is dropped without breaking anything, replays cost nothing', async () => {
  const { cfg, keys, pubs, otherPubs } = await shared;
  assert.equal(UP_RATE, 30);
  assert.equal(UP_RATE_MS, 10000);
  assert.deepEqual([UP_KEY_RATE, ODD_RATE], [10, 5]);
  const broker = fakeBroker();
  const session = new AdminSession(fakeApp(broker.page('admin0000001'), 'Philip'), { cfg, pubs, keys });
  // (everything here is sealed with a key no card has: the small lane, made roomy for the junk checks)
  session.upOdd = new Budget({ rate: 1000, ms: 1000 });
  try {
    const chatUp = (i, code = 'ABCD') => sealUpload(pubs.boxPub, { k: 'chat', from: 'hostpage0001', code, v: '2.5.0', lines: [line(i, { code })] });
    // junk: never throws, never kept
    const junk = ['', 'x', '{', 'null', '[]', '{}', JSON.stringify({ e: 1, iv: 2, ct: 3 }), 'x'.repeat(UP_MAX + 1),
      JSON.stringify(await sealToAdmin(pubs.boxPub, { k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [line(1)] })), // a card's seal, not an upload
      JSON.stringify(await sealToAdmin(otherPubs.boxPub, { k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [line(1)] }, SEAL_UP)), // sealed to another admin key
      JSON.stringify(await sealToAdmin(pubs.boxPub, { k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [{ text: 5 }] }, SEAL_UP)),
      JSON.stringify(await sealToAdmin(pubs.boxPub, 'just a string', SEAL_UP))];
    for (const j of junk) assert.equal(await session.onUpload(j), null, j.slice(0, 60));
    assert.deepEqual(session.chats(), []);
    assert.deepEqual(session.reports(), []);
    // a good one, then the very same one replayed: once
    const good = await chatUp(1);
    assert.ok(await session.onUpload(good));
    assert.equal(await session.onUpload(good), null, 'a replay is not opened again');
    assert.equal(session.chats()[0].lines.length, 1);
    assert.equal(session.chats()[0].ok, false, "no card for that page: not checked");

    // the budget: 3 opens per 400 ms here (one waiting): the rest of a flood waits or is dropped
    session.upOdd = new Budget({ rate: 3, ms: 400, queue: 1 });
    const flood = await Promise.all([...Array(6)].map((_, i) => chatUp(10 + i)));
    const t0 = Date.now();
    const results = flood.map((t) => session.onUpload(t));
    await sleep(50);
    assert.equal(session.chats()[0].lines.length, 1 + 3, 'three opened at once');
    const done = await Promise.all(results);
    assert.ok(Date.now() - t0 >= 350, 'the one waiting got its turn later');
    assert.equal(done.filter(Boolean).length, 4, 'three now, the newest waiting one later, two pushed out');
    assert.equal(session.chats()[0].lines.at(-1).text, 'hello 15', 'the newest got through');
  } finally { session.close(); }
});

test('admin side: chats() and reports() dedupe and cap (500 lines a party, 30 parties, 50 reports), unchecked ones never pushing checked ones out; checked only when the page that sealed it has that card', async () => {
  const { cfg, keys, pubs } = await shared;
  assert.deepEqual([PARTY_LINES, PARTIES, REPORTS], [500, 30, 50]);
  const broker = fakeBroker();
  const host = await page(broker, 'hostpage0001', 'Hana', cfg, pubs, { game: fakeGame('p2p-host', 'ABCD'), partyKind: () => 'p2p-host' });
  host.app.chat = fakeChat(); // (no live feed from this one here: its lines are sent by hand)
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs);
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  // (no budgets here: only what is kept)
  session.upBudget = new Budget({ rate: 100000, ms: 1000 });
  session.upOdd = new Budget({ rate: 100000, ms: 1000 });
  session.upKeyMax = Infinity;
  session.upWork.card.max = session.upWork.odd.max = Infinity;
  try {
    await until(() => session.players().some((p) => p.id === 'hostpage0001') && session.players().some((p) => p.id === 'miapage00001'), 3000, 'cards');
    const up = (payload, from = host.client.pageKey) => sealUpload(pubs.boxPub, { v: '2.5.0', ...payload }, { from }).then((t) => session.onUpload(t));
    // the host's own page, its card says it hosts ABCD: checked, and named
    await up({ k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [line(1), line(2)] });
    let c = session.chats();
    assert.equal(c.length, 1);
    assert.equal(c[0].code, 'ABCD');
    assert.equal(c[0].host, 'Hana');
    assert.equal(c[0].ok, true);
    assert.deepEqual(c[0].lines.map((l) => [l.text, l.ok]), [['hello 1', true], ['hello 2', true]]);
    assert.ok(c[0].lines[0].got > 0);
    // the same lines again (an overlapping batch): once
    await up({ k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [line(2), line(3)] });
    assert.deepEqual(session.chats()[0].lines.map((l) => l.text), ['hello 1', 'hello 2', 'hello 3']);
    // someone else claims to be the host (a fresh key, the host's id): kept but marked, and it can't take the party over
    await up({ k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [line(4, { text: 'FAKE' })] }, null);
    c = session.chats()[0];
    assert.equal(c.lines.at(-1).text, 'FAKE');
    assert.equal(c.lines.at(-1).ok, false);
    assert.equal(c.ok, true, 'the party stays the real host\'s');
    // a party ABCD isn't hosted by the page that sent it: not checked
    await up({ k: 'chat', from: 'hostpage0001', code: 'WXYZ', lines: [line(1, { code: 'WXYZ' })] });
    assert.equal(session.chats().find((p) => p.code === 'WXYZ').ok, false);
    // 500 lines a party at most (the oldest go)
    for (let b = 0; b < 6; b++) await up({ k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [...Array(100)].map((_, i) => line(1000 + b * 100 + i)) });
    c = session.chats().find((p) => p.code === 'ABCD');
    assert.equal(c.count, PARTY_LINES);
    assert.equal(c.lines.at(-1).text, 'hello 1599');
    assert.equal(session.chats(40)[0].lines.length, 40, 'the newest 40 when asked');
    assert.ok(c.lines.every((l) => l.ok), "the unchecked 'FAKE' line went first");
    // made-up lines can't push the real host's out of a full party: theirs go first
    await up({ k: 'chat', from: 'hostpage0001', code: 'ABCD', lines: [...Array(100)].map((_, i) => line(5000 + i, { text: `junk ${i}` })) }, null);
    c = session.chats().find((p) => p.code === 'ABCD');
    assert.equal(c.count, PARTY_LINES);
    assert.ok(c.lines.every((l) => l.ok), 'all 500 real lines kept');
    assert.equal(c.lines.at(-1).text, 'hello 1599');
    // 30 parties at most: the quietest goes, an unchecked one before any checked one
    // (these name parties the host's card doesn't host: unchecked)
    for (let i = 0; i < 35; i++) {
      const code = String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26), 81, 81);
      await up({ k: 'chat', from: 'hostpage0001', code, lines: [line(i, { code })] });
    }
    assert.equal(session.chats().length, PARTIES);
    assert.equal(session.chats()[0].code, 'BIQQ', 'newest party first');
    const codes = session.chats().map((p) => p.code);
    assert.ok(codes.includes('ABCD') && session.chats().find((p) => p.code === 'ABCD').ok, 'the checked party stays');
    for (const gone of ['WXYZ', 'AAQQ', 'AFQQ']) assert.ok(!codes.includes(gone), `${gone}: the quietest unchecked went`);
    assert.ok(codes.includes('AGQQ'));
    // every party kept checked: an unchecked newcomer is dropped, never a checked party
    for (const p of session.parties.values()) p.ok = true;
    await up({ k: 'chat', from: 'hostpage0001', code: 'ZZQQ', lines: [line(1, { code: 'ZZQQ' })] }, null);
    assert.ok(!session.chats().some((p) => p.code === 'ZZQQ'));
    assert.equal(session.chats().length, PARTIES);
    // reports: a checked one from Mia, then 60 made up (a fresh key, claiming to be the host):
    // they push each other out, never hers
    await up({ k: 'report', from: 'miapage00001', code: 'ABCD', line: line(1, { text: 'the real one' }), context: [] }, mia.client.pageKey);
    for (let i = 0; i < 60; i++) await up({ k: 'report', from: 'hostpage0001', code: 'ABCD', line: line(i), context: [] }, null);
    let reps = session.reports();
    assert.equal(reps.length, REPORTS);
    assert.ok(reps.some((r) => r.line.text === 'the real one' && r.ok && r.name === 'Mia'), 'the checked report stays');
    assert.equal(reps.filter((r) => !r.ok).length, REPORTS - 1);
    // newest 50; one page's own flood pushes out its own reports (the unchecked first), not Mia's;
    // the same one twice only once (a made-up copy sent first doesn't keep the real one out)
    for (let i = 0; i < 60; i++) await up({ k: 'report', from: 'hostpage0001', code: 'ABCD', line: line(i), context: [] });
    await up({ k: 'report', from: 'hostpage0001', code: 'ABCD', line: line(59), context: [] });
    reps = session.reports();
    assert.equal(reps.length, REPORTS);
    assert.ok(reps.every((r) => r.ok), 'only checked ones left');
    assert.ok(reps.some((r) => r.line.text === 'the real one'), "Mia's report survived the host page's flood");
    assert.equal(reps.filter((r) => r.from === 'hostpage0001').length, REPORTS - 1);
    assert.equal(reps[0].line.text, 'hello 59', 'newest first');
    assert.equal(reps[0].ok, true);
    assert.equal(reps[0].name, 'Hana');
    // copies: the panel can't change what the session keeps
    reps[0].line.text = 'changed';
    session.chats()[0].lines[0].text = 'changed';
    assert.equal(session.reports()[0].line.text, 'hello 59');
    assert.notEqual(session.chats()[0].lines[0].text, 'changed');
    // closing forgets it all
    session.close();
    assert.deepEqual(session.chats(), []);
  } finally {
    session.close();
    host.client.stop();
    mia.client.stop();
    adm.client.stop();
  }
});

// ------------------------------------------------------------------ the live party chat (host only)

test('live party chat: only the host\'s page sends it, batched (at most one upload per 3 s), nothing without new lines, nothing from a member page, solo or a host alone', async () => {
  const { cfg, keys, pubs } = await shared;
  assert.equal(FEED_MS, 3000);
  const broker = fakeBroker();
  const hostGame = fakeGame('p2p-host', 'ABCD', 2);
  const hostChat = fakeChat();
  const host = await page(broker, 'hostpage0001', 'Hana', cfg, pubs, { game: hostGame, chat: hostChat, partyKind: () => 'p2p-host' });
  const memGame = fakeGame('p2p', 'ABCD', 2);
  const memChat = fakeChat();
  const mem = await page(broker, 'mempage00001', 'Mia', cfg, pubs, { game: memGame, chat: memChat, partyKind: () => 'p2p' });
  const ups = () => broker.log.filter((m) => m.topic === UP_TOPIC);
  const opened = async (m) => cleanUpload(await openSealed(keys.box, JSON.parse(m.text), SEAL_UP, { max: UP_MAX }));
  try {
    // a line said in the party: both pages hear it; only the host's page sends it, a moment later
    const say = (i, extra) => { const l = line(i, extra); hostChat.emit(l, hostGame); memChat.emit(l, memGame); };
    say(1);
    await until(() => ups().length === 1, 2000, 'first batch');
    const t1 = Date.now();
    assert.equal(ups()[0].from, 'hostpage0001');
    let u = await opened(ups()[0]);
    assert.equal(u.k, 'chat');
    assert.equal(u.code, 'ABCD');
    assert.deepEqual(u.lines.map((l) => l.text), ['hello 1']);
    // a burst right after: waits for the 3 s, then goes in one upload
    say(2);
    say(3);
    hostChat.emit({ id: 0, name: '', text: 'Sam joined', ts: 0, code: 'ABCD', at: Date.now(), sys: true }, hostGame); // (not a chat line)
    await sleep(1500);
    assert.equal(ups().length, 1, 'not before 3 s');
    await until(() => ups().length === 2, 4000, 'second batch');
    assert.ok(Date.now() - t1 >= 2800, `${Date.now() - t1} ms`);
    u = await opened(ups()[1]);
    assert.deepEqual(u.lines.map((l) => l.text), ['hello 2', 'hello 3'], 'batched, no system notes');
    // nothing new: nothing sent
    await sleep(3300);
    assert.equal(ups().length, 2, 'no new lines, no upload');
    assert.equal(host.client.feeds.get('ABCD').timer, 0);
    assert.ok(!ups().some((m) => m.from === 'mempage00001'), 'never from a member page');

    // the host alone (nobody else in the party): nothing; the admin watching counts as someone
    host.client.feedMs = 200;
    hostGame.roster.delete(2);
    hostChat.emit(line(10), hostGame);
    await sleep(800);
    assert.equal(ups().length, 2, 'a host on their own');
    hostGame.net.room.observers.set('o1', {});
    hostChat.emit(line(11, { id: -1, name: 'Admin', admin: true }), hostGame);
    await until(() => ups().length === 3, 2000, 'with the admin watching');
    assert.equal((await opened(ups()[2])).lines[0].admin, true);
    // solo (a party of one on this page): nothing
    const soloGame = fakeGame('solo', 'SOLO', 1);
    host.app.game = soloGame;
    hostChat.emit(line(12, { code: 'SOLO' }), soloGame);
    await sleep(600);
    assert.equal(ups().length, 3, 'solo');
    // a line from a game that is not this page's current one (a party it left): nothing
    host.app.game = hostGame;
    hostChat.emit(line(13), fakeGame('p2p-host', 'WXYZ', 3));
    await sleep(600);
    assert.equal(ups().length, 3, 'an old party');
    // offline: kept and sent once back online (a few tries)
    host.app.presence.online = false;
    hostChat.emit(line(14), hostGame);
    await sleep(500);
    host.app.presence.online = true;
    await until(() => ups().length === 4, 3000, 'after the blip');
    assert.deepEqual((await opened(ups()[3])).lines.map((l) => l.text), ['hello 14']);
  } finally {
    host.client.stop();
    mem.client.stop();
  }
});

test('page side without app.chat (an older wiring): mute, unmute and chatlog never throw', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs);
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  try {
    await until(() => session.players().some((p) => p.id === 'miapage00001'), 3000, 'card');
    assert.equal(mia.app.chat, undefined);
    await session.mute('miapage00001', 10, 'x');
    await until(() => mia.app.toasts.some((t) => /muted your chat for <b>10 minutes<\/b>/.test(t)), 3000, 'told');
    await session.unmute('miapage00001');
    await until(() => mia.app.toasts.some((t) => /unmuted/.test(t)), 3000, 'told');
    const log = await session.requestLog('miapage00001');
    assert.deepEqual(log.lines, [], 'an empty log');
    assert.equal(await mia.client.report(null), false);
    assert.equal(await mia.client.report(line(1)), true);
  } finally {
    session.close();
    mia.client.stop();
    adm.client.stop();
  }
});

test('a page key seal: e is that page\'s key and opens only for the admin; importBoxPub matches it', async () => {
  const { keys, pubs } = await shared;
  const me = await newBoxKey();
  const a = await sealToAdmin(pubs.boxPub, { n: 1 }, SEAL_UP, { from: me });
  const b = await sealToAdmin(pubs.boxPub, { n: 2 }, SEAL_UP, { from: me });
  assert.equal(a.e, me.raw);
  assert.equal(b.e, me.raw);
  assert.notEqual(a.iv, b.iv, 'a fresh iv every time');
  assert.deepEqual(await openSealed(keys.box, a, SEAL_UP), { n: 1 });
  assert.deepEqual(await openSealed(keys.box, b, SEAL_UP), { n: 2 });
  assert.ok(await importBoxPub(a.e));
  // the default stays a fresh key per seal
  assert.notEqual((await sealToAdmin(pubs.boxPub, { n: 1 }, SEAL_UP)).e, me.raw);
  // a long ct opens only when the caller allows it
  const long = await sealToAdmin(pubs.boxPub, { t: 'x'.repeat(5000) }, SEAL_UP);
  assert.equal(await openSealed(keys.box, long, SEAL_UP), null, 'over the default 2000');
  assert.equal((await openSealed(keys.box, long, SEAL_UP, { max: UP_MAX })).t.length, 5000);
});

// ------------------------------------------------------------------ uploads under attack (anyone can publish on UP_TOPIC)

test('a flood of made-up uploads (random keys, no crypto) can\'t keep a carded page\'s report or chat log out', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs, { chat: fakeChat([line(1)]) });
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  const x = broker.page('snoop0000001'); // someone with a script on the public broker
  const rnd = (n) => [...Array(n)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[Math.floor(Math.random() * 64)]).join('');
  const junk = (n) => { for (let i = 0; i < n; i++) x.publish(UP_TOPIC, JSON.stringify({ e: rnd(88), iv: rnd(16), ct: rnd(40) })); };
  try {
    await until(() => session.players().some((p) => p.id === 'miapage00001'), 3000, 'card');
    // junk before, during and after: it all goes to the small lane, Mia's key to the main one
    junk(200);
    await sleep(20);
    assert.equal(await mia.client.report(line(2, { name: 'Sam', id: 2, text: 'you are mean' }), [line(1)]), true);
    junk(200);
    await until(() => session.reports().length === 1, 3000, "Mia's report, through the flood");
    assert.equal(session.reports()[0].ok, true);
    assert.equal(session.reports()[0].name, 'Mia');
    const asked = session.requestLog('miapage00001', 3000);
    junk(200);
    const log = await asked;
    assert.ok(log, 'the chat log answer got through too');
    assert.deepEqual(log.lines.map((l) => l.text), ['hello 1']);
    assert.ok(session.upOdd.t.length <= ODD_RATE, 'the junk only ever had the small lane');
    assert.ok(session.upBudget.t.length <= 3, 'the main lane: only Mia\'s');
    assert.deepEqual(session.chats(), []);
  } finally {
    session.close();
    mia.client.stop();
    adm.client.stop();
  }
});

test('a card\'s key gets at most UP_KEY_RATE turns per window in the main lane (copied off the broker, it can\'t fill it); the rest go to the small lane', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  const mia = await page(broker, 'miapage00001', 'Mia', cfg, pubs);
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  try {
    await until(() => session.players().some((p) => p.id === 'miapage00001'), 3000, 'card');
    const pk = session.players().find((p) => p.id === 'miapage00001').pk;
    const rnd = () => Math.random().toString(36).slice(2).padEnd(16, 'x').slice(0, 16);
    // junk carrying Mia's key (it is in the clear in each of her uploads)
    for (let i = 0; i < 40; i++) session.onUpload(JSON.stringify({ e: pk, iv: rnd(), ct: `${rnd()}${rnd()}` }));
    await sleep(30);
    assert.equal(session.upBudget.t.length, UP_KEY_RATE, 'the main lane: UP_KEY_RATE of them');
    assert.equal(session.upOdd.t.length, ODD_RATE, 'the rest: the small lane');
    assert.equal(session.upKeys.get(pk).length, UP_KEY_RATE);
  } finally {
    session.close();
    mia.client.stop();
    adm.client.stop();
  }
});

test('cleaning uploads is capped in time: UP_CLEAN_MS per upload (the newest lines first), UP_WORK_MS of each window per lane', async () => {
  const { cfg, keys, pubs } = await shared;
  assert.ok(UP_CLEAN_MS <= 200 && UP_WORK_MS <= UP_RATE_MS / 5, 'a flood of slow lines leaves the iPad free most of the time');
  // cleanUpload with a deadline: the newest UP_CONTEXT lines always, then the next newest until
  // then, in order (a clock that moves 1 ms per look); a report keeps its line and its whole context
  let t = 0;
  const lines = [...Array(60)].map((_, i) => line(i));
  const o = cleanUpload({ k: 'log', from: 'miapage00001', re: 'AAAAAAAAAAAAAAAA', code: 'ABCD', lines }, { until: 20, now: () => t++ });
  assert.deepEqual(o.lines.map((l) => l.text), lines.slice(-(UP_CONTEXT + 20)).map((l) => l.text));
  t = 100;
  const r = cleanUpload({ k: 'report', from: 'miapage00001', code: 'ABCD', line: line(50), context: lines }, { until: 10, now: () => t++ });
  assert.equal(r.line.text, 'hello 50');
  assert.deepEqual(r.context.map((l) => l.text), lines.slice(-UP_CONTEXT).map((l) => l.text), 'a slow first look never cuts a report\'s context');
  // the session: a clock that moves 1 ms per look, so each 60-line upload "takes" 51 ms (the
  // first UP_CONTEXT lines aren't timed)
  const broker = fakeBroker();
  const session = new AdminSession(fakeApp(broker.page('admin0000001'), 'Philip'), { cfg, pubs, keys });
  try {
    session.upOdd = new Budget({ rate: 1000, ms: 1000 });
    let clock = 0;
    session.workNow = () => ++clock;
    session.upWork.odd.max = 200;
    const slow = [...Array(60)].map((_, i) => line(i, { text: 'a b c d e f g h i j k l m n o p q r s t u v w x y z' }));
    const ups = await Promise.all([...Array(10)].map((_, i) => sealUpload(pubs.boxPub, { k: 'chat', from: 'hostpage0001', code: 'ABCD', v: '2.5.0', lines: slow.map((l) => ({ ...l, ts: l.ts + i * 100 })) })));
    const done = [];
    for (const u of ups) done.push(await session.onUpload(u));
    assert.equal(done.filter(Boolean).length, 4, '51 + 51 + 51 + 51: the 4th starts under 200 ms, the rest wait for the next window');
    assert.ok(done.slice(0, 4).every(Boolean) && done.slice(4).every((d) => d === null));
    // the next window: room again
    clock += UP_RATE_MS;
    assert.ok(await session.onUpload(await sealUpload(pubs.boxPub, { k: 'chat', from: 'hostpage0001', code: 'ABCD', v: '2.5.0', lines: [line(9999)] })));
    // the main lane has its own time: the small one being used up doesn't touch it
    assert.equal(session.upWork.card.ms, 0);
  } finally { session.close(); }
});

// ------------------------------------------------------------------ who said it (the CHAT tab's actions)

test('the CHAT tab finds a line\'s speaker by the room player id in the cards (never by name); two cards claiming one id: nobody', async () => {
  const { cfg, keys, pubs } = await shared;
  const broker = fakeBroker();
  // two kids called 'Bea' in party ABCD (the bully copied the name), and one whose name the filter masks
  const bea = await page(broker, 'beapage00001', 'Bea', cfg, pubs, { game: fakeGame('p2p', 'ABCD', 3, 0, 2), partyKind: () => 'p2p' });
  const bully = await page(broker, 'aaabully0001', 'Bea', cfg, pubs, { game: fakeGame('p2p', 'ABCD', 3, 0, 3), partyKind: () => 'p2p' });
  const rude = await page(broker, 'rudepage0001', 'Shithead', cfg, pubs, { game: fakeGame('p2p-host', 'ABCD', 3, 0, 1), partyKind: () => 'p2p-host' });
  const adm = await page(broker, 'admin0000001', 'Philip', cfg, pubs);
  const session = adm.app.admin = new AdminSession(adm.app, { cfg, pubs, keys });
  const panel = new AdminPanel(adm.app);
  try {
    await until(() => session.players().length === 4, 3000, 'cards');
    // the card carries the page's room id (not for a page on its own, nor the admin watching)
    assert.equal(session.players().find((p) => p.id === 'aaabully0001').party.pid, 3);
    assert.equal(session.players().find((p) => p.me).party.pid, undefined, 'solo: no pid');
    const watch = fakeGame('p2p', 'ABCD', 3, 0, -1);
    watch.observer = true;
    adm.app.game = watch;
    adm.app.partyKind = () => 'p2p';
    assert.deepEqual(adm.client.card().party, { code: 'ABCD', kind: 'watch', size: 3 });
    // each line goes to its own speaker, whatever the name says
    const said = (id, name) => cleanChatLine({ id, name, text: 'hi', ts: 5 });
    assert.equal(panel.speaker('ABCD', said(3, 'Bea')).card.id, 'aaabully0001', "the bully's line: the bully");
    assert.equal(panel.speaker('ABCD', said(2, 'Bea')).card.id, 'beapage00001', "Bea's line: Bea");
    const masked = said(1, 'Shithead');
    assert.notEqual(masked.name, 'Shithead', 'the chat filter masked the name');
    assert.equal(panel.speaker('ABCD', masked).card.id, 'rudepage0001', 'a masked name still finds its card');
    // no such id, another party, the admin's own line, a note: nobody
    assert.equal(panel.speaker('ABCD', said(7, 'Bea')), null);
    assert.equal(panel.speaker('WXYZ', said(2, 'Bea')), null);
    assert.equal(panel.speaker('SOLO', said(2, 'Bea')), null);
    assert.equal(panel.speaker('ABCD', cleanChatLine({ id: -1, name: 'Admin', text: 'hi', ts: 5, admin: true })), null);
    // someone makes a card claiming Bea's id in the same party: two claims, the panel acts on neither
    const fake = await page(broker, 'fakepage0001', 'Bea', cfg, pubs, { game: fakeGame('p2p', 'ABCD', 3, 0, 2), partyKind: () => 'p2p' });
    await until(() => session.players().some((p) => p.id === 'fakepage0001'), 3000, 'the fake card');
    const s = panel.speaker('ABCD', said(2, 'Bea'));
    assert.equal(s.card, undefined);
    assert.equal(s.many.length, 2);
    // what the open line shows: no buttons for an unclear speaker; the right card's for a clear one
    const unclear = panel.lineActs('ABCD', said(2, 'Bea'));
    assert.match(unclear, /nothing can be done from here/);
    assert.ok(!unclear.includes('data-act'), 'no MUTE / MESSAGE / CHAT LOG');
    assert.match(panel.lineActs('ABCD', said(3, 'Bea')), /data-id="aaabully0001"/);
    assert.match(panel.lineActs('ABCD', masked), /<b>Shithead<\/b> \(in chat: ★+\)/, "the card's name, and the name the chat showed");
    fake.client.stop();
    // a second page claiming to host ABCD: that party's chat is no longer checked
    const fakeHost = await page(broker, 'fakehost0001', 'Hana', cfg, pubs, { game: fakeGame('p2p-host', 'ABCD', 3, 0, 1), partyKind: () => 'p2p-host' });
    await until(() => session.players().some((p) => p.id === 'fakehost0001'), 3000, 'the fake host card');
    const u = await session.onUpload(await sealUpload(pubs.boxPub, { k: 'chat', from: 'rudepage0001', code: 'ABCD', v: '2.5.0', lines: [line(1)] }, { from: rude.client.pageKey }));
    assert.equal(u.ok, true, 'sealed by the page it names');
    assert.equal(session.chats()[0].ok, false, 'but two cards say they host ABCD');
    fakeHost.client.stop();
  } finally {
    session.close();
    for (const p of [bea, bully, rude, adm]) p.client.stop();
  }
});
