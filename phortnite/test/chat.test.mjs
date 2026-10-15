// Party chat (stage 3): the shared filter (public/shared/chatFilter.js) and the room plugin
// (public/shared/plugins/chat.js) on a real Room through the test harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanChat, quickText, QUICK_CHAT, MAX_CHAT } from '../public/shared/chatFilter.js';
import { chat, HISTORY, WELCOME_LINES, BURST, REFILL_MS, PER_MIN, DUP_MS } from '../public/shared/plugins/chat.js';
import { ROOM_PLUGINS } from '../public/shared/plugins/index.js';
import { PROTOCOL } from '../public/shared/constants.js';
import { makeRoom } from './helpers/roomharness.mjs';

// invisible characters are built from code points (never typed into the source)
const U = (...cps) => String.fromCodePoint(...cps);
const ZWSP = U(0x200b), ZWNJ = U(0x200c), ZWJ = U(0x200d), RLO = U(0x202e), LRE = U(0x202a), WJ = U(0x2060), BOM = U(0xfeff), SHY = U(0xad);
const clean = (s) => cleanChat(s).text;
const cps = (s) => Array.from(s).length;

// ------------------------------------------------------------------ the filter
const BAD = [
  ['fuck you', '★★★★ you'],
  ['FUCK', '★★★★'],
  ['fuuuuuck', '★★★★★★★★'],
  ['f.u.c.k', '★.★.★.★'],
  ['f-u-c-k', '★-★-★-★'],
  ['f_u_c_k this', '★_★_★_★ this'],
  ['f u c k off', '★ ★ ★ ★ off'],
  [`f${ZWSP}u${ZWJ}c${WJ}k`, '★★★★'],
  [`f${SHY}u${ZWNJ}ck`, '★★★★'],
  ['ｆｕｃｋ', '★★★★'],
  [U(0x1d41f, 0x1d42e, 0x1d41c, 0x1d424), '★★★★'], // mathematical bold
  [U(0x24d5, 0x24e4, 0x24d2, 0x24da), '★★★★'], // circled letters
  ['f*ck', '★*★★'],
  ['sh*t', '★★*★'],
  ['sh1t', '★★★★'],
  ['5h1t', '★★★★'],
  ['$hit', '★★★★'],
  ['shit!', '★★★★!'],
  ['SHIIIIT!!', '★★★★★★★!!'],
  ['a55', '★★★'],
  ['@$$', '★★★'],
  ['a$$hole', '★★★★★★★'],
  ['b!tch', '★★★★★'],
  ['b1tch3s', '★★★★★★★'],
  ['ѕhіt', '★★★★'], // Cyrillic look-alikes
  ['fück', '★★★★'],
  ['bullshit', '★★★★★★★★'],
  ['motherfucker', '★★★★★★★★★★★★'],
  ['dumbass', '★★★★★★★'],
  ['u r a cunt', 'u r a ★★★★'],
  ['sh it', '★★ ★★'],
  ['fu ck', '★★ ★★'],
  ['s hit', '★ ★★★'],
  ['k y s', '★ ★ ★'],
  ['kys', '★★★'],
  ['kill yourself', '★★★★ ★★★★★★★★'],
  ['kill your self', '★★★★ ★★★★ ★★★★'],
  ['blow job', '★★★★ ★★★'],
  ['p0rn', '★★★★'],
  ['n1gg3r', '★★★★★★'],
  ['you are a retard', 'you are a ★★★★★★'],
  ['pass the ass', 'pass the ★★★'],
  ['crappy', '★★★★★★'],
  ['wtf', '★★★'],
];

test('chat filter: swears are masked one ★ per letter, through leetspeak, spacing, symbols, zero-width, fullwidth and look-alike letters', () => {
  for (const [input, want] of BAD) {
    const r = cleanChat(input);
    assert.equal(r.text, want, JSON.stringify(input));
    assert.equal(r.masked, true, JSON.stringify(input));
  }
  // a combining accent stays on its (masked) letter
  const acc = clean(`f${U(0x301)}uck`);
  assert.doesNotMatch(acc, /[a-z]/i);
  assert.equal(acc.split('★').length - 1, 4);
  // an emoji in the middle of a word
  assert.equal(clean(`f${U(0x1f642)}uck`), `★${U(0x1f642)}★★★`);
});

const CLEAN = [
  'class', 'assassin', 'grass', 'shiitake', 'scrap', 'Scunthorpe', 'Penistone', 'cocktail', 'cockpit', 'peacock', 'cocky',
  'Dickens', 'therapist', 'grape', 'analysis', 'arsenal', 'spices', 'snigger', 'Niger', 'raccoon', 'Sussex', 'pricked',
  'hello', 'shell', 'button', 'passed', 'mishit', 'title', 'assume', 'bass', 'glass', 'compass', 'pass the ball', 'an al',
  'booby trap', 'cumulative', 'sextant', 'homophone', 'Pakistan', 'skyscraper', 'Matsushita', 'as is', 'is it ok',
  'I have 455 wood', '1v1 me', 'GG ez', 'hi!!!', 'what the hell', 'I got 3 kills', 'score 10 - 7', 'e.g. this', 'wait 5 min',
  'top 10', '1st place', 'version 2.5.0', 'meet at 5.30', 'Nice build, Zoë 🎉', 'ok.', 'lol...', '¿qué tal?', 'Привет', '你好',
];

test('chat filter: the Scunthorpe problem — whole words only, common words stay clean', () => {
  for (const s of CLEAN) {
    const r = cleanChat(s);
    assert.equal(r.text, s, JSON.stringify(s));
    assert.equal(r.masked, false, JSON.stringify(s));
  }
});

test('chat filter: personal info becomes [hidden] (e-mails, links, domains, phone numbers, @handles, tags)', () => {
  const cases = [
    ['email me at bob.smith+x@gmail.com ok', 'email me at [hidden] ok'],
    ['go to https://evil.example/x?y=1 now', 'go to [hidden] now'],
    ['http://1.2.3.4:8080/a', '[hidden]'],
    ['www.roblox.com', '[hidden]'],
    ['join discord.gg/abc123', 'join [hidden]'],
    ['my site is cool-kid.io', 'my site is [hidden]'],
    ['bit.ly/xyz and twitch.tv/me', '[hidden] and [hidden]'],
    ['example.co.uk', '[hidden]'],
    ['t.me/someone', '[hidden]'],
    ['call 555-123-4567', 'call [hidden]'],
    ['my num (555) 123 4567', 'my num [hidden]'],
    ['+44 7700 900123', '[hidden]'],
    ['07700.900.123!', '[hidden]!'],
    ['1 2 3 4 5 6 7', '[hidden]'],
    ['add me @cool_kid99', 'add me [hidden]'],
    ['find me: Zoë#1234', 'find me: [hidden]'],
    ['ｂｏｂ＠ｇｍａｉｌ．ｃｏｍ', '[hidden]'],
    ['gmail．com', '[hidden]'],
  ];
  for (const [input, want] of cases) {
    const r = cleanChat(input);
    assert.equal(r.text, want, JSON.stringify(input));
    assert.equal(r.masked, true, JSON.stringify(input));
  }
  // short handles and numbers stay
  for (const s of ['@ab', 'room 123456', 'I have 100 wood']) assert.equal(clean(s), s);
  // both kinds in one line
  assert.equal(clean('shit, email bob@x.com'), '★★★★, email [hidden]');
});

test('chat filter: control and invisible characters go, whitespace collapses, lines are capped', () => {
  assert.equal(clean(`a${U(0)}b${U(7)}c${U(0x1b)}d${U(0x7f)}e${U(0x9b)}`), 'abcde');
  assert.equal(clean('  hi\n\nthere\t\tyou  '), 'hi there you');
  assert.equal(clean(`a${ZWSP}b${RLO}c${BOM}d${SHY}e${LRE}f${U(0x2066)}g${U(0x3164)}h${U(0xe0041)}i`), 'abcdefghi');
  assert.equal(clean(`hi${U(0x2028)}there${U(0xa0)}${U(0x3000)}you`), 'hi there you');
  // Zalgo: at most 3 combining marks on a letter
  const z = clean(`Z${U(0x300, 0x301, 0x302, 0x303, 0x304, 0x305)}algo`);
  assert.equal(z, `Z${U(0x300, 0x301, 0x302)}algo`);
  // capped at MAX_CHAT code points, never splitting an emoji
  assert.equal(clean('x'.repeat(500)).length, MAX_CHAT);
  const e = clean('😂'.repeat(300));
  assert.equal(cps(e), MAX_CHAT);
  assert.doesNotMatch(e, /[\ud800-\udbff](?![\udc00-\udfff])/);
  // a lone surrogate is dropped
  assert.equal(clean(`a${String.fromCharCode(0xd83d)}b`), 'ab');
  // "[hidden]" can be longer than what it hides: still capped
  const many = clean('a.io '.repeat(30));
  assert.ok(cps(many) <= MAX_CHAT, many);
  // nothing left: ''
  for (const s of ['', '   ', ZWSP + RLO, null, undefined, {}, [], NaN]) assert.deepEqual(cleanChat(s), { text: '', masked: false });
  assert.equal(clean(42), '42');
});

test('chat filter: idempotent (the room cleans, every page cleans again) — a fixed corpus and a seeded fuzz', () => {
  const corpus = [...BAD.map((b) => b[0]), ...CLEAN, 'shiitake.comwww.coa fuckassit7', '#1234#1234itgmailk(5ssk-fuck', 'x.iowww.killgrass', 'a.io '.repeat(40)];
  for (const s of corpus) {
    const once = cleanChat(s);
    const twice = cleanChat(once.text);
    assert.equal(twice.text, once.text, JSON.stringify(s));
    assert.equal(twice.masked, false, JSON.stringify(s));
  }
  const parts = ['fuck', 'f', 'u', 'c', 'k', ' ', '.', '@', 'bob', 'gmail', '.com', '5', '1', '0', 'sh', 'it', 'a', 's', 'ss', '!', '$', '★',
    '[hidden]', 'www.', 'x.io', '555', '-', '(', ')', '#1234', ZWSP, RLO, U(0x301), '🙂', 'ｆ', 'class', 'grass', 'kill', 'yourself', 'é', '\n', 'mishit', 'gg'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 3000; t++) {
    let s = '';
    for (let i = 1 + Math.floor(rnd() * 50); i > 0; i--) s += parts[Math.floor(rnd() * parts.length)];
    const once = cleanChat(s);
    assert.ok(cps(once.text) <= MAX_CHAT);
    const twice = cleanChat(once.text);
    assert.equal(twice.text, once.text, JSON.stringify(s));
    assert.equal(twice.masked, false, JSON.stringify(s));
  }
});

test('chat filter: quick chat', () => {
  assert.equal(QUICK_CHAT.length, 10);
  assert.ok(Object.isFrozen(QUICK_CHAT));
  assert.deepEqual([...QUICK_CHAT], ['Let\'s go!', 'GG!', 'Ready?', 'Nice shot!', 'Help me!', 'One more game?', 'Follow me!', 'Thanks!', '👍', '😂']);
  QUICK_CHAT.forEach((s, q) => {
    assert.equal(quickText(q), s);
    assert.deepEqual(cleanChat(s), { text: s, masked: false }, 'quick lines pass the filter as they are');
  });
  for (const q of [-1, 10, 1.5, '1', null, undefined, NaN, {}]) assert.equal(quickText(q), '');
});

// ------------------------------------------------------------------ the room plugin
const ob = (H) => {
  const c = H.conn();
  c.ok = H.room.join(c, { name: 'Admin', v: PROTOCOL, observer: { sig: 'checked by the transport' } }, { observer: true });
  return c;
};

test('chat plugin: registered after party and edits; a line goes to every player and observer, cleaned, with the room\'s own fields', () => {
  assert.deepEqual(ROOM_PLUGINS.map((p) => p.name), ['party', 'edits', 'chat']);
  assert.ok(ROOM_PLUGINS.includes(chat));
  const H = makeRoom();
  const a = H.join('Ann'), b = H.join('Ben'), o = ob(H);
  assert.ok(a.ok && b.ok && o.ok);
  H.advance(500);
  H.send(a, { t: 'chat', text: '  hi   Ben, fuck this, mail me at ann@x.com  ' });
  const want = { t: 'chat', id: a.pid, name: 'Ann', text: 'hi Ben, ★★★★ this, mail me at [hidden]', ts: H.now() };
  for (const c of [a, b, o]) assert.deepEqual(H.last(c, 'chat'), want);
  // quick chat: the room's text, q echoed
  H.advance(2000);
  H.send(b, { t: 'chat', q: 3 });
  assert.deepEqual(H.last(a, 'chat'), { t: 'chat', id: b.pid, name: 'Ben', text: 'Nice shot!', ts: H.now(), q: 3 });
  // a client can't pick its name, id, time or the admin tag
  H.advance(2000);
  H.send(a, { t: 'chat', text: 'trust me', admin: true, name: 'Admin', id: b.pid, ts: 5, q: undefined });
  assert.deepEqual(H.last(b, 'chat'), { t: 'chat', id: a.pid, name: 'Ann', text: 'trust me', ts: H.now() });
  // the current roster name
  H.send(a, { t: 'look', name: 'Annie' });
  H.advance(2000);
  H.send(a, { t: 'chat', text: 'new name' });
  assert.equal(H.last(b, 'chat').name, 'Annie');
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('chat plugin: empty and odd messages get chatno empty; a long line is cut, never refused', () => {
  const H = makeRoom();
  const a = H.join('Ann'), b = H.join('Ben');
  for (const m of [{ text: '   ' }, { text: ZWSP + RLO }, { text: 5 }, { text: null }, {}, { q: 99 }, { q: -1 }, { q: '1' }, { q: 1.5 }]) {
    H.clear(a);
    H.send(a, { t: 'chat', ...m });
    assert.deepEqual(H.msgs(a, 'chatno'), [{ t: 'chatno', why: 'empty' }], JSON.stringify(m));
  }
  assert.equal(H.msgs(b, 'chat').length, 0);
  H.clear(a);
  H.send(a, { t: 'chat', text: 'y'.repeat(5000) });
  assert.equal(H.last(b, 'chat').text, 'y'.repeat(MAX_CHAT));
  assert.equal(H.msgs(a, 'chatno').length, 0);
});

test('chat plugin: rate limits (burst, refill, 20 a minute), duplicates dropped quietly, chatno slow at most once a second', () => {
  const H = makeRoom();
  const a = H.join('Ann'), b = H.join('Ben');
  const said = () => H.msgs(b, 'chat').filter((m) => m.id === a.pid).length;
  // a burst of BURST, then 'slow'
  for (let i = 0; i < BURST + 3; i++) H.send(a, { t: 'chat', text: `line ${i}` });
  assert.equal(said(), BURST);
  assert.deepEqual(H.msgs(a, 'chatno'), [{ t: 'chatno', why: 'slow' }], 'one chatno for the flood');
  H.advance(1000);
  H.send(a, { t: 'chat', text: 'still too soon?' });
  assert.equal(said(), BURST, 'not a whole token yet');
  assert.equal(H.msgs(a, 'chatno').length, 2, 'a second later: told again');
  H.advance(REFILL_MS - 1000);
  H.send(a, { t: 'chat', text: 'one more' });
  assert.equal(said(), BURST + 1, 'a token every REFILL_MS');
  // the same text again within DUP_MS: dropped without a word, and it costs nothing
  H.advance(REFILL_MS * 4);
  H.clear(a);
  H.send(a, { t: 'chat', text: 'gg' });
  H.send(a, { t: 'chat', text: 'gg' });
  H.send(a, { t: 'chat', q: 1 });
  H.send(a, { t: 'chat', q: 1 });
  assert.deepEqual(H.msgs(b, 'chat').slice(-2).map((m) => m.text), ['gg', 'GG!']);
  assert.equal(H.msgs(a, 'chatno').length, 0);
  H.advance(DUP_MS);
  H.send(a, { t: 'chat', text: 'gg' });
  assert.equal(H.last(b, 'chat').text, 'gg', 'allowed again after DUP_MS');
  // at most PER_MIN lines in any 60 s, even at the refill pace
  const H2 = makeRoom();
  const c = H2.join('Cat'), d = H2.join('Dan');
  let sent = 0;
  for (let i = 0; i < 40 && H2.now() < 1000 + 59000; i++) {
    H2.send(c, { t: 'chat', text: `msg ${i}` });
    sent++;
    H2.advance(REFILL_MS);
  }
  assert.ok(sent > PER_MIN);
  assert.equal(H2.msgs(d, 'chat').length, PER_MIN);
  assert.ok(H2.msgs(c, 'chatno').length >= 1);
  H2.advance(60000);
  H2.send(c, { t: 'chat', text: 'a new minute' });
  assert.equal(H2.last(d, 'chat').text, 'a new minute');
  // limits are per speaker
  H2.send(d, { t: 'chat', text: 'me too' });
  assert.equal(H2.last(c, 'chat').text, 'me too');
});

test('chat plugin: the party keeps its last 30 lines; the welcome (joiners, rejoiners, observers) carries the last 20', () => {
  const H = makeRoom({ clone: false });
  const a = H.join('Ann', { resume: '' }), b = H.join('Ben', { resume: '' });
  for (let i = 0; i < 35; i++) {
    H.send(i % 2 ? b : a, { t: 'chat', text: `line ${i}` });
    H.advance(REFILL_MS * 2);
  }
  assert.equal(H.room.chatLines.length, HISTORY);
  assert.equal(H.room.chatLines[0].text, 'line 5');
  const c = H.join('Cat');
  const w = H.last(c, 'welcome');
  assert.equal(w.chat.length, WELCOME_LINES);
  assert.deepEqual(w.chat.map((l) => l.text), Array.from({ length: 20 }, (_, i) => `line ${i + 15}`));
  assert.deepEqual(Object.keys(w.chat[0]).sort(), ['id', 'name', 'text', 'ts']);
  // what pages get are copies: a page that changes its line object doesn't change the party's history
  w.chat[0].text = 'changed';
  H.last(a, 'chat').text = 'changed too';
  assert.ok(H.room.chatLines.every((l) => /^line \d+$/.test(l.text)));
  // a rejoin after a dropped connection (held by the party plugin) sees it too
  const tok = H.last(b, 'welcome').resume;
  H.leave(b);
  assert.ok(H.player(b.pid).away);
  const b2 = H.join('Ben', { resume: tok });
  const rw = H.last(b2, 'welcome');
  assert.equal(rw.resumed, true);
  assert.equal(rw.chat.length, WELCOME_LINES);
  // the admin who starts watching too
  const o = ob(H);
  assert.equal(H.last(o, 'welcome').chat.length, WELCOME_LINES);
  // across matches: never cleared
  H.send(a, { t: 'start', bots: 0, mats: 0 });
  assert.notEqual(H.room.phase, 'lobby');
  H.send(a, { t: 'end' });
  assert.equal(H.room.phase, 'lobby');
  assert.equal(H.room.chatLines.length, HISTORY);
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('chat plugin: lobby and matches (bus, match, ended); bots never chat; a held-away player can\'t', () => {
  const H = makeRoom({ drop: ['s'] });
  const a = H.join('Ann', { resume: '' }), b = H.join('Ben', { resume: '' });
  H.send(a, { t: 'chat', text: 'in the lobby' });
  assert.equal(H.last(b, 'chat').text, 'in the lobby');
  // the bus, with bots
  H.send(a, { t: 'start', bots: 3, mats: 0 });
  assert.equal(H.room.phase, 'bus');
  H.send(b, { t: 'chat', text: 'on the bus' });
  assert.equal(H.last(a, 'chat').text, 'on the bus');
  // a client speaking "as" its bot speaks as itself
  const bot = H.bots()[0];
  assert.ok(bot && bot.owner === a.pid);
  H.advance(REFILL_MS);
  H.send(a, { t: 'chat', text: 'as a bot', id: bot.id });
  assert.equal(H.last(b, 'chat').id, a.pid);
  H.advance(10000);
  assert.ok(H.msgs(b, 'chat').every((m) => !H.bots().some((x) => x.id === m.id)), 'no line from a bot');
  // a match without the bus, then its end screen
  H.room.returnToLobby();
  H.send(a, { t: 'mode', custom: { bots: 0, spawn: 'ground', storm: 'none' }, name: 'Test' });
  H.send(a, { t: 'start' });
  assert.equal(H.room.phase, 'match');
  H.advance(REFILL_MS);
  H.send(b, { t: 'chat', text: 'in the match' });
  assert.equal(H.last(a, 'chat').text, 'in the match');
  H.send(a, { t: 'hit', tg: b.pid, w: 'sniper', r: 4, d: 10, n: 0, nh: 1 });
  assert.equal(H.room.phase, 'ended');
  H.advance(REFILL_MS);
  H.send(b, { t: 'chat', text: 'gg wp' });
  assert.equal(H.last(a, 'chat').text, 'gg wp', 'eliminated players chat too');
  // held away (the connection dropped): nothing it says gets through
  H.room.returnToLobby();
  H.leave(b);
  const p = H.player(b.pid);
  assert.ok(p && p.away);
  H.clear(a);
  H.send(b, { t: 'chat', text: 'from the old socket' });
  assert.equal(H.msgs(a, 'chat').length, 0);
  // (and a record marked away while a connection is still bound to it)
  H.player(a.pid).away = 1;
  H.send(a, { t: 'chat', text: 'away' });
  assert.equal(H.msgs(a, 'chat').length, 0);
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('chat plugin: solo (a party of one) can post', () => {
  const H = makeRoom({ solo: true, code: 'SOLO' });
  const a = H.join('Ann');
  H.send(a, { t: 'chat', q: 0 });
  assert.deepEqual(H.last(a, 'chat'), { t: 'chat', id: a.pid, name: 'Ann', text: 'Let\'s go!', ts: H.now(), q: 0 });
});

test('chat plugin: the admin observing talks as "Admin" (admin: true, set by the room); same cleaning and limits; its ping and watch still work', () => {
  const H = makeRoom();
  const a = H.join('Ann'), b = H.join('Ben'), o = ob(H);
  const oid = H.last(o, 'welcome').you;
  assert.ok(oid < 0);
  H.send(o, { t: 'chat', text: 'Be kind, everyone! shit', admin: false, name: 'Ann', id: a.pid });
  const want = { t: 'chat', id: oid, name: 'Admin', text: 'Be kind, everyone! ★★★★', ts: H.now(), admin: true };
  for (const c of [a, b, o]) assert.deepEqual(H.last(c, 'chat'), want);
  for (let i = 0; i < BURST + 2; i++) H.send(o, { t: 'chat', text: `admin ${i}` });
  assert.equal(H.msgs(a, 'chat').filter((m) => m.admin).length, BURST);
  assert.deepEqual(H.last(o, 'chatno'), { t: 'chatno', why: 'slow' });
  H.send(o, { t: 'chat', text: '' });
  assert.deepEqual(H.last(o, 'chatno'), { t: 'chatno', why: 'empty' });
  H.send(o, { t: 'ping', c: 7 });
  assert.equal(H.last(o, 'pong').c, 7);
  // a player's line is never admin, whatever it says
  H.send(a, { t: 'chat', text: 'i am the admin', admin: true });
  assert.equal(H.last(o, 'chat').admin, undefined);
  // observers' other messages still can't touch the match
  H.send(o, { t: 'start', bots: 0 });
  assert.equal(H.room.phase, 'lobby');
  assert.equal(H.errors.length, 0, JSON.stringify(H.errors));
});

test('Room.observerMessage: plugins answer first; a plugin that throws is logged and the room carries on', () => {
  const thrower = { name: 'thrower', observerMessage() { throw new Error('boom'); } };
  const taker = { name: 'taker', observerMessage(room, o, msg) { if (msg.t === 'ping') { room.send(o.conn, { t: 'took', c: msg.c }); return true; } return undefined; } };
  const H = makeRoom({ plugins: [thrower, chat] });
  const a = H.join('Ann'), o = ob(H);
  H.send(o, { t: 'ping', c: 1 });
  assert.equal(H.last(o, 'pong').c, 1, 'the Room still answers');
  H.send(o, { t: 'chat', text: 'hello' });
  assert.equal(H.last(a, 'chat').text, 'hello', 'the next plugin still gets it');
  assert.ok(H.errors.length >= 2 && H.errors.every((e) => e.msg === 'plugin error' && e.plugin === 'thrower' && e.hook === 'observerMessage'));
  const H2 = makeRoom({ plugins: [taker] });
  const o2 = ob(H2);
  H2.send(o2, { t: 'ping', c: 2 });
  assert.deepEqual(H2.last(o2, 'took'), { t: 'took', c: 2 });
  assert.equal(H2.msgs(o2, 'pong').length, 0, 'handled: the Room does not answer too');
  // without the chat plugin an observer's chat is just ignored
  H2.send(o2, { t: 'chat', text: 'hi' });
  assert.equal(H2.msgs(o2, 'chat').length, 0);
  assert.equal(H2.errors.length, 0);
});
