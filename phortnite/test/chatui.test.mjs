// Party chat on the page (stage 3): the DOM-free parts of the chat UI. The store
// (public/js/chat/chatLog.js: caps, copies, onLine, history, the admin's mute kept in localStorage,
// hide, unread), what a line shows as under each Chat setting (On / Quick chat only / Off), why a
// line can't be sent, the page's own rate limit, and the ChatClient game plugin's routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatLog, Limiter, MAX_LINES, MUTE_KEY, HIDDEN_QUICK, HIDDEN_SENDER, chatMode, cleanLine, cleanCode, lineKey, lineView, sendBlock, muteText,
} from '../public/js/chat/chatLog.js';
import { QUICK_CHAT } from '../public/shared/chatFilter.js';
import { ChatClient } from '../public/js/game/chatClient.js';

/** A localStorage stand-in. */
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}

/** A ChatLog on a clock the test moves. */
function makeLog(opts = {}) {
  const clock = { t: Date.UTC(2026, 9, 15, 12, 0, 0) };
  const log = new ChatLog({ storage: opts.storage || fakeStorage(), now: () => clock.t, max: opts.max });
  return { log, clock };
}

test('chat ui: chatMode defaults to On; codes are normalised', () => {
  assert.equal(chatMode({}), 'on');
  assert.equal(chatMode(null), 'on');
  assert.equal(chatMode({ chat: 'quick' }), 'quick');
  assert.equal(chatMode({ chat: 'off' }), 'off');
  assert.equal(chatMode({ chat: 'loud' }), 'on');
  assert.equal(cleanCode('abcd'), 'ABCD');
  assert.equal(cleanCode(''), 'SOLO');
  assert.equal(cleanCode(null), 'SOLO');
  assert.equal(cleanCode('<b>x</b>'), 'BXB');
});

test('chat ui: every line is cleaned again here (text and name), admin only for an observer id', () => {
  const l = cleanLine({ id: 3, name: 'Mia', text: 'hi  ​there fuck, call me 555 123 4567', ts: 10 }, 'abcd', 99);
  assert.equal(l.code, 'ABCD');
  assert.equal(l.at, 99);
  assert.equal(l.id, 3);
  assert.equal(l.ts, 10);
  assert.ok(!/fuck/i.test(l.text) && /★★★★/.test(l.text), `bad word masked: ${l.text}`);
  assert.ok(/\[hidden\]/.test(l.text) && !/555/.test(l.text), `phone hidden: ${l.text}`);
  assert.ok(!/​/.test(l.text));
  // a modded host's name / text get the same treatment
  const n = cleanLine({ id: 4, name: 'shithead', text: 'visit evil.com now', ts: 11 }, 'ABCD', 1);
  assert.ok(!/shit/i.test(n.name), n.name);
  assert.ok(/\[hidden\]/.test(n.text) && !/evil\.com/.test(n.text), n.text);
  // admin: only an observer's (negative) id, and always named Admin
  assert.equal(cleanLine({ id: 5, name: 'Philip', text: 'hi', admin: true, ts: 1 }, 'ABCD').admin, undefined);
  const a = cleanLine({ id: -1, name: 'Whoever', text: 'Be kind!', admin: true, ts: 1 }, 'ABCD');
  assert.equal(a.admin, true);
  assert.equal(a.name, 'Admin');
  // quick chat: this page's own text for the index (whatever text came with it)
  const q = cleanLine({ id: 2, name: 'Al', q: 1, text: 'something else', ts: 2 }, 'ABCD');
  assert.equal(q.text, QUICK_CHAT[1]);
  assert.equal(q.q, 1);
  assert.equal(cleanLine({ id: 2, name: 'Al', q: 99, text: 'GG', ts: 2 }, 'ABCD').q, undefined, 'a bad index is plain text');
  // junk
  for (const bad of [null, 'chat', 42, { id: 1, text: '' }, { id: 1, text: '   ' }, { id: 1, text: 7 }, { id: 1, q: 'x' }]) assert.equal(cleanLine(bad, 'ABCD'), null, JSON.stringify(bad));
  assert.equal(cleanLine({ id: 1, text: 'hi' }, 'ABCD').name, 'Player', 'a missing name');
  assert.equal(cleanLine({ id: 'x', text: 'hi', ts: 'y' }, 'ABCD').id, 0);
  assert.ok(cleanLine({ id: 1, text: 'x'.repeat(5000) }, 'ABCD').text.length <= 120, 'capped');
});

test('chat ui: the store keeps the newest 100 lines (all parties); lines() hands out copies', () => {
  const { log } = makeLog();
  assert.equal(MAX_LINES, 100);
  for (let i = 0; i < 130; i++) log.add({ id: 1 + (i % 3), name: `P${i % 3}`, text: `line ${i}`, ts: i }, { code: i < 65 ? 'AAAA' : 'BBBB' });
  const all = log.lines();
  assert.equal(all.length, 100);
  assert.equal(all[0].text, 'line 30');
  assert.equal(all[99].text, 'line 129');
  assert.deepEqual(Object.keys(all[99]).sort(), ['at', 'code', 'id', 'name', 'text', 'ts']);
  all[99].text = 'changed';
  all.pop();
  assert.equal(log.lines().length, 100, 'a copy');
  assert.equal(log.lines()[99].text, 'line 129', 'the stored line is untouched');
  assert.equal(log.party('aaaa').length, 35);
  assert.equal(log.party('BBBB').length, 65);
  assert.equal(log.party('CCCC').length, 0);
  // a smaller cap (the max option)
  const small = makeLog({ max: 3 }).log;
  for (let i = 0; i < 5; i++) small.add({ id: 1, text: `t${i}`, ts: i }, { code: 'AAAA' });
  assert.deepEqual(small.lines().map((l) => l.text), ['t2', 't3', 't4']);
});

test('chat ui: onLine hears every new room line once; a welcome history is kept, never re-fired', () => {
  const { log } = makeLog();
  const heard = [];
  const game = { code: 'ABCD' };
  const off = log.onLine((line, g) => heard.push([line.text, g]));
  const hist = [{ id: 1, name: 'Mia', text: 'old one', ts: 1 }, { id: 2, name: 'Sam', text: 'old two', ts: 2 }];
  for (const h of hist) log.add(h, { code: 'ABCD', history: true, game });
  assert.equal(heard.length, 0, 'history is not news');
  assert.equal(log.party('ABCD').length, 2);
  log.add({ id: 1, name: 'Mia', text: 'new', ts: 3 }, { code: 'ABCD', game });
  assert.deepEqual(heard, [['new', game]]);
  // the same lines again (a rejoin's welcome, a duplicate delivery): nothing new
  for (const h of hist) assert.equal(log.add(h, { code: 'ABCD', history: true }), null);
  assert.equal(log.add({ id: 1, name: 'Mia', text: 'new', ts: 3 }, { code: 'ABCD' }), null);
  assert.equal(heard.length, 1);
  assert.equal(log.party('ABCD').length, 3);
  // the same text later is a new line
  assert.ok(log.add({ id: 1, name: 'Mia', text: 'new', ts: 9000 }, { code: 'ABCD' }));
  assert.equal(heard.length, 2);
  // a listener gets a copy; a throwing one doesn't stop the others
  const bad = log.onLine(() => { throw new Error('boom'); });
  let copy = null;
  log.onLine((l) => { copy = l; l.text = 'mutated'; });
  const orig = console.error;
  console.error = () => {};
  try { log.add({ id: 2, name: 'Sam', text: 'after', ts: 9001 }, { code: 'ABCD' }); } finally { console.error = orig; }
  assert.equal(copy.text, 'mutated');
  assert.equal(log.party('ABCD').at(-1).text, 'after');
  assert.equal(heard.length, 3);
  off();
  bad();
  log.add({ id: 2, name: 'Sam', text: 'quiet', ts: 9002 }, { code: 'ABCD' });
  assert.equal(heard.length, 3, 'off() stops it');
  assert.equal(typeof log.onLine('nope'), 'function');
  assert.equal(lineKey({ code: 'ABCD', ts: 3, id: 1, text: 'new' }), 'ABCD|3|1|new');
});

test('chat ui: notices are system lines in the party list (kept for the chat log, not announced)', () => {
  const { log } = makeLog();
  let n = 0;
  log.onLine(() => n++);
  const a = log.notice('🛡 The admin looked at this chat', 'abcd');
  const b = log.notice('🛡 The admin looked at this chat', 'ABCD');
  assert.ok(a && b && a !== b, 'the same notice twice is two lines');
  assert.equal(a.sys, true);
  assert.equal(a.code, 'ABCD');
  assert.equal(n, 0);
  assert.equal(log.party('ABCD').length, 2);
  assert.equal(log.lines()[0].sys, true);
  assert.equal(log.notice('   '), null);
  assert.equal(log.notice('a\u0000b\nc').text, 'ab c');
});

test('chat ui: the admin\'s mute is kept in localStorage and ends by itself', () => {
  const storage = fakeStorage();
  const { log, clock } = makeLog({ storage });
  assert.equal(log.muted(), null);
  const until = clock.t + 10 * 60000;
  log.setMute(until, 'Be nice to Sam');
  assert.deepEqual(log.muted(), { until, reason: 'Be nice to Sam' });
  assert.deepEqual(JSON.parse(storage.getItem(MUTE_KEY)), { until, reason: 'Be nice to Sam' });
  // muted() hands out a copy
  log.muted().until = 0;
  assert.equal(log.muted().until, until);
  // a reload: the next page load reads it back
  const again = new ChatLog({ storage, now: () => clock.t });
  assert.deepEqual(again.muted(), { until, reason: 'Be nice to Sam' });
  // its time is up: cleared, from storage too
  clock.t = until + 1;
  assert.equal(log.muted(), null);
  assert.equal(storage.getItem(MUTE_KEY), null);
  // unmute: 0, or a time already past
  log.setMute(clock.t + 60000, '');
  assert.ok(log.muted());
  log.setMute(0);
  assert.equal(log.muted(), null);
  assert.equal(storage.getItem(MUTE_KEY), null);
  log.setMute(clock.t - 1, 'old');
  assert.equal(log.muted(), null);
  // the reason is plain and short; an absurd time is held to a week (and a day)
  log.setMute(clock.t + 3600000, `${'x'.repeat(300)}\u0000`);
  assert.equal(log.muted().reason.length, 120);
  log.setMute(clock.t + 365 * 86400000);
  assert.ok(log.muted().until <= clock.t + 8 * 86400000);
  // junk in storage is ignored; an expired one too
  for (const raw of ['nope', '{"until":"soon"}', JSON.stringify({ until: clock.t - 5 }), '[]']) {
    assert.equal(new ChatLog({ storage: fakeStorage({ [MUTE_KEY]: raw }), now: () => clock.t }).muted(), null, raw);
  }
  // no storage at all (private mode): this visit only
  const bare = new ChatLog({ storage: null, now: () => clock.t });
  bare.setMute(clock.t + 60000, 'x');
  assert.ok(bare.muted());
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const priv = new ChatLog({ storage: broken, now: () => clock.t });
  priv.setMute(clock.t + 60000, 'x');
  assert.ok(priv.muted());
  priv.setMute(0);
  assert.equal(priv.muted(), null);
});

test('chat ui: the mute text says until when (and why)', () => {
  const now = new Date(2026, 9, 15, 9, 30).getTime();
  assert.equal(muteText({ until: new Date(2026, 9, 15, 14, 5).getTime(), reason: '' }, now), '🔇 The admin muted your chat until 14:05');
  assert.equal(muteText({ until: new Date(2026, 9, 15, 9, 40).getTime(), reason: 'Be kind' }, now), '🔇 The admin muted your chat until 09:40 (Be kind)');
  const tomorrow = new Date(2026, 9, 16, 8, 0);
  assert.equal(muteText({ until: tomorrow.getTime(), reason: '' }, now), `🔇 The admin muted your chat until ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][tomorrow.getDay()]} 08:00`);
  assert.equal(muteText(null, now), '');
  assert.equal(muteText({ until: now - 1 }, now), '');
});

test('chat ui: what a line shows as under On / Quick chat only / Off', () => {
  const text = { id: 2, name: 'Sam', text: 'hello there', ts: 1, code: 'ABCD' };
  const quick = { id: 2, name: 'Sam', text: 'GG!', q: 1, ts: 2, code: 'ABCD' };
  const admin = { id: -1, name: 'Admin', text: 'Be kind!', admin: true, ts: 3, code: 'ABCD' };
  const sys = { id: 0, name: '', text: '🛡 The admin looked at this chat', ts: 0, code: 'ABCD', sys: true };
  // On: everything as it is
  assert.deepEqual(lineView(text), { kind: 'text', text: 'hello there' });
  assert.deepEqual(lineView(quick), { kind: 'text', text: QUICK_CHAT[1] });
  assert.deepEqual(lineView(admin), { kind: 'admin', text: 'Be kind!' });
  assert.deepEqual(lineView(sys), { kind: 'sys', text: sys.text });
  // Quick chat only: other players' free text is hidden; quick, admin and system lines show
  assert.deepEqual(lineView(text, { mode: 'quick' }), { kind: 'quickonly', text: HIDDEN_QUICK });
  assert.equal(HIDDEN_QUICK, '💬 (message hidden: quick chat only)');
  assert.deepEqual(lineView(quick, { mode: 'quick' }), { kind: 'text', text: QUICK_CHAT[1] });
  assert.deepEqual(lineView(admin, { mode: 'quick' }), { kind: 'admin', text: 'Be kind!' });
  assert.deepEqual(lineView(sys, { mode: 'quick' }), { kind: 'sys', text: sys.text });
  assert.deepEqual(lineView(text, { mode: 'quick', mine: true }), { kind: 'text', text: 'hello there' }, 'my own line');
  // Off: nothing shows
  for (const l of [text, quick, admin, sys]) assert.equal(lineView(l, { mode: 'off' }), null);
  // a hidden sender: 'hidden' (never the admin, never my own)
  assert.deepEqual(lineView(text, { hidden: true }), { kind: 'hidden', text: HIDDEN_SENDER });
  assert.deepEqual(lineView(quick, { hidden: true, mode: 'quick' }), { kind: 'hidden', text: HIDDEN_SENDER });
  assert.equal(lineView(admin, { hidden: true }).kind, 'admin');
  assert.equal(lineView(text, { hidden: true, mine: true }).kind, 'text');
  assert.equal(lineView(null), null);
});

test('chat ui: hide a sender for this party only', () => {
  const { log } = makeLog();
  log.hide('abcd', 2);
  assert.equal(log.isHidden('ABCD', 2), true);
  assert.equal(log.isHidden('ABCD', 3), false);
  assert.equal(log.isHidden('WXYZ', 2), false, 'another party');
  log.hide('ABCD', 2, false);
  assert.equal(log.isHidden('ABCD', 2), false);
});

test('chat ui: why a line can\'t be sent', () => {
  assert.equal(sendBlock({}), '');
  assert.equal(sendBlock({ mode: 'off' }), 'off');
  assert.equal(sendBlock({ mode: 'quick', quick: false }), 'quickonly');
  assert.equal(sendBlock({ mode: 'quick', quick: true }), '');
  assert.equal(sendBlock({ muted: { until: 1 } }), 'muted');
  assert.equal(sendBlock({ muted: { until: 1 }, quick: true }), 'muted', 'quick chat too');
  assert.equal(sendBlock({ connected: false }), 'offline');
  assert.equal(sendBlock({ mode: 'off', muted: { until: 1 }, connected: false }), 'off');
});

test('chat ui: the unread badge counts what there is to read while the chat is closed', () => {
  const { log } = makeLog();
  const add = (o) => log.add({ name: 'Sam', ts: Math.random(), ...o }, { code: 'ABCD' });
  const a = add({ id: 2, text: 'hi' });
  assert.equal(log.count(a, { open: false }), 1);
  assert.equal(log.count(add({ id: 2, text: 'there' }), { open: true }), 1, 'open: read as it comes');
  assert.equal(log.count(add({ id: 1, text: 'mine' }), { mine: true }), 1, 'my own lines');
  assert.equal(log.count(add({ id: 3, text: 'free text' }), { mode: 'quick' }), 1, 'hidden by Quick chat only');
  assert.equal(log.count(add({ id: 3, q: 0 }), { mode: 'quick' }), 2, 'a quick line shows');
  assert.equal(log.count(add({ id: -1, text: 'from the admin', admin: true }), { mode: 'quick' }), 3);
  assert.equal(log.count(add({ id: 4, text: 'x' }), { mode: 'off' }), 3, 'Off');
  log.hide('ABCD', 5);
  assert.equal(log.count(add({ id: 5, text: 'hidden sender' }), {}), 3);
  assert.equal(log.count(log.notice('🛡 The admin looked at this chat', 'ABCD'), {}), 4, 'a notice counts');
  assert.equal(log.count(null, {}), 4);
  log.markRead();
  assert.equal(log.unread, 0);
  for (let i = 0; i < 1200; i++) log.count({ id: 9, text: 'x', code: 'ABCD' }, {});
  assert.equal(log.unread, 999, 'capped');
});

test('chat ui: the page\'s own rate limit matches the room\'s', () => {
  const lim = new Limiter();
  let t = 1000;
  assert.equal(lim.take('a', t), 'ok');
  assert.equal(lim.take('b', t), 'ok');
  assert.equal(lim.take('c', t), 'ok');
  assert.equal(lim.take('d', t), 'ok');
  assert.equal(lim.check('e', t), 'slow', 'a burst of 4');
  assert.equal(lim.take('e', t + 1400), 'slow');
  assert.equal(lim.take('e', t + 1500), 'ok', 'one more every 1.5 s');
  assert.equal(lim.take('f', t + 1600), 'slow');
  // the same text again within 5 s is dropped (later it is fine)
  const d = new Limiter();
  assert.equal(d.take('GG!', 0), 'ok');
  assert.equal(d.take('GG!', 4000), 'dup');
  assert.equal(d.take('GG!', 5001), 'ok');
  // at most 20 a minute, however slowly the bucket fills
  const m = new Limiter();
  t = 0;
  let sent = 0;
  for (let i = 0; i < 40; i++, t += 1500) if (m.take(`line ${i}`, t) === 'ok') sent++;
  assert.equal(sent, 20, 'within the first minute');
  assert.equal(m.take('late', 61000), 'ok', 'a minute later there is room again');
});

test('chat ui: the ChatClient game plugin hands the party\'s chat to app.chat', () => {
  const calls = [];
  const chat = {
    receive: (g, m) => calls.push(['receive', m.text]),
    refused: (g, m) => calls.push(['refused', m.why]),
    joined: (g, list) => calls.push(['joined', list.length]),
    rosterChanged: () => calls.push(['roster']),
    phaseChanged: (g, ph) => calls.push(['phase', ph]),
    left: () => calls.push(['left']),
  };
  const game = { app: { chat } };
  const p = new ChatClient(game);
  assert.equal(p.game, game);
  p.onMessage({ t: 'welcome', chat: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] });
  p.onMessage({ t: 'resumed' });
  p.onMessage({ t: 'chat', id: 1, text: 'hi' });
  p.onMessage({ t: 'chatno', why: 'slow' });
  p.onMessage({ t: 'roster' });
  p.onMessage({ t: 's' });
  p.onPhase('bus');
  p.dispose();
  assert.deepEqual(calls, [['joined', 2], ['joined', 0], ['receive', 'hi'], ['refused', 'slow'], ['roster'], ['phase', 'bus'], ['left']]);
  // no app (the contract tests, Node): nothing happens, nothing throws
  const bare = new ChatClient({});
  bare.onMessage({ t: 'chat', text: 'x' });
  bare.onPhase('lobby');
  bare.dispose();
});
