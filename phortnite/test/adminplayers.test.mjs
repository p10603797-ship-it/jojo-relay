// The admin panel's PLAYERS tab (js/ui/admin.js): under the live player rows, 📴 OFFLINE lists every
// account that isn't online right now (offlineAccounts): last seen first, never one that is online
// (it stays in the live rows only), never a gone one (banned, its entry no longer on the relay), never
// a guest (no account), and the search box (nameHas) finds a name in it. DOM-free: the panel's
// helpers, then its OFFLINE rows drawn on a small stand-in for the DOM (kept by account: a clock
// tick never draws a name button anew). The session's side, "seen" after going offline:
// test/registry.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { offlineAccounts, nameHas, AdminPanel } from '../public/js/ui/admin.js';

const H = 3600000;
const now = Date.now();
/** An accounts() row (js/admin/session.js), offline unless said. */
const acct = (rid, name, seenAgoH, extra = {}) => ({
  rid, name, created: now - 100 * H, seen: now - seenAgoH * H, level: 3, wins: 1, matches: 4, kills: 2, did: '', v: '2.5.1',
  online: false, banned: false, suspect: false, isNew: false, gone: false, mine: false, reason: '', bannedAt: 0, bannedLive: false, ...extra,
});
const rid = (c) => c.repeat(16);

test('OFFLINE: every account not online, last seen first (then newest made, then by name)', () => {
  const list = [
    acct(rid('a'), 'Ruby', 5),
    acct(rid('b'), 'Zoe', 1),
    acct(rid('c'), 'Max', 0, { online: true }),
    acct(rid('d'), 'Lily', 30),
    acct(rid('e'), 'Noah', 5, { created: now - 2 * H }), // seen as long ago as Ruby, made later
    acct(rid('f'), 'Ava', 5), // seen and made with Ruby: by name
  ];
  const off = offlineAccounts(list, []);
  assert.deepEqual(off.map((a) => a.name), ['Zoe', 'Noah', 'Ava', 'Ruby', 'Lily']);
  assert.ok(!off.some((a) => a.name === 'Max'), 'Max is online: not under OFFLINE');
  assert.equal(list.length, 6, 'the list given is left as it was');
  assert.equal(list[0].name, 'Ruby');
  // an unknown "seen" (0) goes last
  assert.deepEqual(offlineAccounts([acct(rid('a'), 'Old', 0, { seen: 0 }), acct(rid('b'), 'New', 2)]).map((a) => a.name), ['New', 'Old']);
});

test('OFFLINE: an online player who has an account is never listed twice (their live card carries the rid)', () => {
  const list = [acct(rid('a'), 'Ruby', 1), acct(rid('b'), 'Max', 2), acct(rid('c'), 'Zoe', 3)];
  // the live cards: Max (his card proves his account), a guest (no rid), the admin's own page
  const players = [
    { id: 'page00000001', name: 'Max', rid: rid('b') },
    { id: 'page00000002', name: 'Guest' },
    { id: 'page00000003', name: 'Philip', me: true, rid: rid('9') },
  ];
  assert.deepEqual(offlineAccounts(list, players).map((a) => a.name), ['Ruby', 'Zoe'], 'Max (online) only in the live rows');
  // Max leaves: back under OFFLINE
  assert.deepEqual(offlineAccounts(list, players.slice(1)).map((a) => a.name), ['Ruby', 'Max', 'Zoe']);
  // a guest is never listed: guests have no account, so no row (and a card without a rid hides nobody)
  assert.ok(!offlineAccounts(list, players).some((a) => a.name === 'Guest'));
  assert.equal(offlineAccounts(list, [{ id: 'x', name: 'Ruby' }]).length, 3, 'a live card named Ruby, without her rid, is not her');
});

test('OFFLINE: gone accounts (banned, entry no longer on the relay) are left out; banned, suspect and the admin\'s own stay in', () => {
  const list = [
    acct(rid('a'), 'Ruby', 1, { banned: true, reason: 'mean' }),
    acct(rid('b'), 'Unknown account', 0, { seen: 0, gone: true, banned: true }),
    acct(rid('c'), 'Zoe', 2, { suspect: true }),
    acct(rid('d'), 'Philip2', 3, { mine: true }),
  ];
  const off = offlineAccounts(list, []);
  assert.deepEqual(off.map((a) => a.name), ['Ruby', 'Zoe', 'Philip2']);
  assert.equal(off[0].banned, true);
  assert.equal(off[1].suspect, true);
  assert.equal(off[2].mine, true);
  // junk never breaks it
  assert.deepEqual(offlineAccounts(null, null), []);
  assert.deepEqual(offlineAccounts([null, { name: 'no rid' }, acct(rid('e'), 'Leo', 1)], [null]).map((a) => a.name), ['Leo']);
});

test('the PLAYERS search box: part of a name, any case, spaces around it ignored; empty finds everyone', () => {
  assert.equal(nameHas('Ruby', 'ru'), true);
  assert.equal(nameHas('Ruby', 'RU'), true);
  assert.equal(nameHas('ruby', ' Ub '), true);
  assert.equal(nameHas('Ruby', 'max'), false);
  assert.equal(nameHas('Ruby', ''), true);
  assert.equal(nameHas('Ruby', '   '), true);
  assert.equal(nameHas('Ruby', undefined), true);
  assert.equal(nameHas(undefined, 'x'), false);
  const list = [acct(rid('a'), 'Ruby', 1), acct(rid('b'), 'Bruno', 2), acct(rid('c'), 'Zoe', 3), acct(rid('d'), 'Max', 0, { online: true })];
  assert.deepEqual(offlineAccounts(list, [], 'ru').map((a) => a.name), ['Ruby', 'Bruno'], '"ru": Ruby and Bruno, last seen first');
  assert.deepEqual(offlineAccounts(list, [], 'RUBY').map((a) => a.name), ['Ruby']);
  assert.deepEqual(offlineAccounts(list, [], 'max').map((a) => a.name), [], 'Max is online: the search never brings him under OFFLINE');
  assert.deepEqual(offlineAccounts(list, [], 'q'), []);
});

// ------------------------------------------------------------------ the OFFLINE rows on screen
/** Just enough DOM for AdminPanel.renderOffline (no browser here): classes, data-, children, writes counted. */
class El {
  constructor(tag, cls = '') { this.tagName = tag.toUpperCase(); this.className = cls; this.children = []; this.parentNode = null; this.dataset = {}; this.html = ''; this.text = ''; this.writes = 0; }
  get classList() {
    const has = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const set = (s) => { this.className = [...s].join(' '); };
    return {
      contains: (c) => has().has(c),
      toggle: (c, on) => { const s = has(); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); set(s); },
      add: (c) => { const s = has(); s.add(c); set(s); },
      remove: (c) => { const s = has(); s.delete(c); set(s); },
    };
  }
  get isConnected() { return true; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.remove();
    this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, c);
    c.parentNode = this;
    return c;
  }
  remove() { const p = this.parentNode; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.html = String(v); this.text = ''; this.writes++; }
  get innerHTML() { return this.html; }
  set textContent(v) { this.innerHTML = ''; this.text = String(v); }
  get textContent() { return this.text || this.html.replace(/<[^>]*>/g, ''); }
  querySelectorAll(sel) {
    const c = sel.slice(1), out = [];
    const walk = (e) => { for (const k of e.children) { if (k.classList.contains(c)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest() { return null; } // (no scrolling box here)
}

/** The PLAYERS pane as js/ui/admin.js draws it, a stub session, and a clock the test moves. */
function offlinePanel(accts, players = []) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document'), realNow = Date.now;
  Object.defineProperty(globalThis, 'document', { value: { createElement: (t) => new El(t), activeElement: null }, configurable: true, writable: true });
  const clock = { t: realNow() };
  Date.now = () => clock.t;
  const root = new El('div', 'adm-panel'), pane = root.appendChild(new El('div', 'adm-pane adm-players'));
  for (const c of ['adm-afindrow adm-pfindrow', 'adm-totals', 'adm-list', 'adm-pnone hidden']) pane.appendChild(new El('div', c));
  const off = pane.appendChild(new El('section', 'adm-off'));
  off.appendChild(new El('h3', 'adm-offhead'));
  const ul = off.appendChild(new El('ul', 'adm-olist'));
  const s = { accts, players, waiting: 0 };
  const session = {
    totals: () => ({ total: 1 + s.players.length, cards: 1 + s.players.length, inMatch: 0, inLobby: 1 + s.players.length, parties: 0 }),
    accounts: () => s.accts.map((a) => ({ ...a, online: s.players.some((p) => p.rid === a.rid) })),
    players: () => s.players.map((p) => ({ ...p })),
    accountStats: () => ({ waiting: s.waiting }),
  };
  const panel = new AdminPanel({ admin: session, ui: {} });
  panel.root = root;
  panel.tab = 'players';
  const rows = () => ul.children.filter((li) => li.dataset.rid);
  const restore = () => { Date.now = realNow; if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document; };
  return { panel, s, clock, ul, pane, rows, buttons: () => new Map(rows().map((li) => [li.dataset.rid, li.querySelector('.adm-oname')])), restore };
}

test('OFFLINE on screen: rows kept by account, so a clock tick rewrites only a row\'s "seen" details, never its name button (a tap never lands on a button drawn anew, or on someone else\'s)', () => {
  const t0 = Date.now();
  const hex = (i) => i.toString(16).padStart(16, '0');
  // 45 accounts seen between 1 s and ~52 min ago (a normal evening: their "seen N min ago" change all the time)
  const accts = [...Array(45)].map((_, i) => acct(hex(i + 1), `Kid${i}`, 0, { seen: t0 - 1000 - i * 70000 }));
  const P = offlinePanel(accts);
  try {
    P.clock.t = t0;
    P.panel.renderOffline();
    assert.equal(P.rows().length, 40, 'the first 40');
    assert.equal(P.ul.lastChild.querySelector('.adm-omore').textContent, 'SHOW 5 MORE (5 not shown)');
    assert.match(P.pane.querySelector('.adm-totals').innerHTML, /<b>45<\/b> offline/);
    assert.equal(P.pane.querySelector('.adm-offhead').innerHTML, '📴 OFFLINE · 45');
    assert.equal(P.ul.writes, 0, 'the list itself is never written over');
    const first = P.buttons();
    for (const [r, b] of first) {
      assert.equal(b.parentNode.dataset.rid, r);
      assert.equal(b.innerHTML, accts.find((a) => a.rid === r).name, 'each button names its own account');
    }
    const meta = P.rows().map((li) => li.querySelector('.adm-ameta'));
    // two minutes of 2 s ticks, nothing changing but the clock
    for (let i = 0; i < 60; i++) { P.clock.t += 2000; P.panel.renderOffline(); }
    const after = P.buttons();
    assert.deepEqual([...after.keys()], [...first.keys()], 'the same rows, in the same order');
    for (const [r, b] of after) {
      assert.equal(b, first.get(r), 'the same button node');
      assert.equal(b.writes, 1, 'its name never written again');
    }
    assert.ok(meta.some((m) => m.writes > 1), 'the "seen" details do move on');
    assert.equal(P.ul.writes, 0);
    // someone leaves the game (seen just now): one new row at the top; the rest keep their buttons
    P.s.accts = [...accts, acct(hex(99), 'Zed', 0, { seen: P.clock.t })];
    P.panel.renderOffline();
    assert.equal(P.rows()[0].querySelector('.adm-oname').innerHTML, 'Zed');
    assert.equal(P.rows().length, 40);
    for (const li of P.rows().slice(1)) assert.equal(li.querySelector('.adm-oname'), first.get(li.dataset.rid));
    assert.equal(P.ul.lastChild.querySelector('.adm-omore').textContent, 'SHOW 6 MORE (6 not shown)', 'SHOW MORE stays last');
    // Kid3 opens the game: only his row goes (he is in the live rows now)
    P.s.players = [{ id: 'page00000003', name: 'Kid3', rid: hex(4) }];
    P.panel.renderOffline();
    assert.ok(!P.rows().some((li) => li.dataset.rid === hex(4)));
    assert.equal(P.rows().at(-1).querySelector('.adm-oname').innerHTML, 'Kid39', 'back from SHOW MORE (drawn anew: it had gone)');
    for (const li of P.rows().slice(1, -1)) assert.equal(li.querySelector('.adm-oname'), first.get(li.dataset.rid));
    // the search box: the matching rows stay the same nodes; no match: one line instead; cleared: back
    P.panel.plFind = 'kid1';
    P.panel.renderOffline();
    assert.deepEqual(P.rows().map((li) => li.querySelector('.adm-oname').innerHTML), ['Kid1', 'Kid10', 'Kid11', 'Kid12', 'Kid13', 'Kid14', 'Kid15', 'Kid16', 'Kid17', 'Kid18', 'Kid19']);
    for (const li of P.rows()) assert.equal(li.querySelector('.adm-oname'), first.get(li.dataset.rid));
    assert.equal(P.ul.querySelector('.adm-omore'), null);
    P.panel.plFind = 'qqq';
    P.panel.renderOffline();
    assert.equal(P.rows().length, 0);
    assert.equal(P.ul.children.length, 1);
    assert.equal(P.ul.firstChild.textContent, 'No offline account has “qqq” in its name.');
    P.panel.plFind = '';
    P.panel.renderOffline();
    assert.equal(P.rows().length, 40);
    assert.equal(P.ul.querySelector('.adm-aempty'), null);
    // a ban: that row's look and details change, its button stays
    const row = P.rows()[2], btn = row.querySelector('.adm-oname');
    P.s.accts = P.s.accts.map((a) => (a.rid === row.dataset.rid ? { ...a, banned: true } : a));
    P.panel.renderOffline();
    assert.equal(row.className, 'adm-orow banned');
    assert.match(row.querySelector('.adm-ameta').innerHTML, /🚫 banned/);
    assert.equal(P.rows()[2], row);
    assert.equal(row.querySelector('.adm-oname'), btn);
  } finally { P.restore(); }
});

test('OFFLINE on screen: "Reading the accounts…" while they come in, then the empty line, then rows', () => {
  const P = offlinePanel([]);
  try {
    P.s.waiting = 3;
    P.panel.renderOffline();
    assert.equal(P.ul.firstChild.textContent, 'Reading the accounts…');
    P.s.waiting = 0;
    P.panel.renderOffline();
    assert.equal(P.ul.children.length, 1);
    assert.equal(P.ul.firstChild.textContent, "No offline accounts yet. Everyone who makes an account shows up here, even when they're not playing.");
    P.s.accts = [acct(rid('a'), 'Ruby', 1, { mine: true })];
    P.panel.renderOffline();
    assert.equal(P.ul.children.length, 1);
    assert.equal(P.rows()[0].querySelector('.adm-oname').innerHTML, 'Ruby <small>(you)</small>');
  } finally { P.restore(); }
});
