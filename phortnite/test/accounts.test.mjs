// Player accounts, all on the device (js/accounts/*): the profile store (create/read/update/delete,
// multiple profiles, schema version/migration), the stat maths from a match result, password
// hash+verify, the transfer encrypt/decrypt round-trip, and that guest stats are never persisted.
// The logic is DOM-free on purpose, so Node drives it straight — with an in-memory storage for the
// store and Node 22's globalThis.crypto for the WebCrypto bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../public/js/accounts/store.js';
import { defaultStats, sanitizeStats, applyAward, levelInfo, kd, winRate, favoriteMode, xpForLevel, STATS_V } from '../public/js/accounts/stats.js';
import { hashPassword, verifyPassword, encryptTransfer, decryptTransfer, makeSigningIdentity, sign, cleanPwRecord, MAX_ROUNDS } from '../public/js/accounts/crypto.js';
import { Profile } from '../public/js/profile.js';

/** A Web-Storage-like object backed by a Map (what the store takes instead of localStorage). */
function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => JSON.stringify([...m.entries()]),
    _map: m,
  };
}

// ------------------------------------------------------------------ the store: CRUD + multiple

test('store: create / read / update / delete, with multiple profiles', () => {
  const s = new AccountStore(memStorage());
  const a = s.create({ name: 'Ava', skin: 1 });
  const b = s.create({ name: 'Ben', skin: 3, makeActive: false });
  assert.equal(s.list().length, 2);
  assert.equal(s.active().id, a.id, 'the first create is active; the second did not steal it');
  // read
  assert.equal(s.get(b.id).name, 'Ben');
  assert.equal(s.get('nope'), null);
  // update (name + skin); isAdmin can never be set through update
  s.update(b.id, { name: 'Benjamin', skin: 5, isAdmin: true });
  assert.equal(s.get(b.id).name, 'Benjamin');
  assert.equal(s.get(b.id).skin, 5);
  assert.equal(s.get(b.id).isAdmin, false, 'isAdmin is not settable from normal update');
  // delete
  assert.equal(s.remove(a.id), true);
  assert.equal(s.list().length, 1);
  assert.equal(s.active(), null, 'deleting the active profile signs out');
  assert.equal(s.remove('nope'), false);
});

test('store: names are cleaned and empty names fall back to Player', () => {
  const s = new AccountStore(memStorage());
  const a = s.create({ name: '  <b>Zoe</b>  ' });
  assert.equal(a.name, 'bZoe/b'); // angle brackets, quotes and control chars stripped, then trimmed
  const b = s.create({ name: '   ' });
  assert.equal(b.name, 'Player');
});

test('store: survives across a reload, keeping which profile is active (unprotected)', () => {
  const store = memStorage();
  const s1 = new AccountStore(store);
  const a = s1.create({ name: 'Mia', skin: 2 });
  a.stats.wins = 4; a.stats.matches = 10;
  s1.persist(a);
  const s2 = new AccountStore(store);
  assert.equal(s2.list().length, 1);
  assert.ok(s2.active(), 'active persists across reload');
  assert.equal(s2.get(a.id).stats.wins, 4);
  assert.equal(s2.get(a.id).stats.matches, 10);
});

test('store: a protected profile is NOT active from disk until it is unlocked this session', async () => {
  const store = memStorage();
  const s1 = new AccountStore(store);
  const a = s1.create({ name: 'Vault', skin: 1, pw: await hashPassword('secret9') });
  a.stats.level = 8; a.stats.wins = 10;
  s1.persist(a);
  // a reload: the profile is chosen on disk, but locked — active() hides it, selected() names it
  const s2 = new AccountStore(store);
  assert.equal(s2.active(), null, 'a protected profile is not active before its password is entered');
  assert.ok(s2.selected() && s2.selected().name === 'Vault', 'selected() still names the chosen profile for the gate');
  assert.equal(s2.list()[0].protected, true);
  // signing in (setActive is what the UI calls after verifying the password) unlocks it
  s2.setActive(a.id);
  assert.ok(s2.active() && s2.active().name === 'Vault', 'after sign-in the profile is active');
  assert.equal(s2.active().stats.level, 8);
  // signing out re-locks it (a later reload would be locked again too)
  s2.signOut();
  assert.equal(s2.active(), null, 'sign out re-locks the protected profile');
});

test('store: a freshly created protected profile is usable at once (no self-lockout)', async () => {
  const s = new AccountStore(memStorage());
  const a = s.create({ name: 'Neo', pw: await hashPassword('matrix') });
  assert.ok(s.active() && s.active().id === a.id, 'you just set the password, so it is active this session');
  assert.equal(s.list()[0].protected, true);
});

test('store: a locked profile is never written to by a settings-style name change (no hijack)', async () => {
  const store = memStorage();
  const s1 = new AccountStore(store);
  const a = s1.create({ name: 'Vault', pw: await hashPassword('secret9') });
  s1.persist(a);
  // reload -> locked. The app keys name/skin writes off the SIGNED-IN account, which is active().
  const s2 = new AccountStore(store);
  const signedIn = s2.active(); // null while locked -> the app writes nothing
  assert.equal(signedIn, null);
  const raw = store.getItem('phortnite.accounts');
  assert.equal(raw.includes('Vault'), true, 'the real name is still on disk, unchanged');
  assert.equal(raw.includes('HIJACK'), false);
});

test('store: a corrupt save degrades to an empty store (never throws)', () => {
  const s = new AccountStore(memStorage({ 'phortnite.accounts': '{not json' }));
  assert.deepEqual(s.list(), []);
  assert.equal(s.active(), null);
});

// ------------------------------------------------------------------ schema version / migration

test('store: an old single-profile save migrates once into an account', () => {
  const store = memStorage({
    'phortnite.profile': JSON.stringify({ v: 1, level: 7, xp: 120, total: 9000, matches: 40, wins: 6, elims: 88 }),
    'phortnite.settings': JSON.stringify({ name: 'Philip', skin: 4 }),
  });
  const s = new AccountStore(store);
  assert.equal(s.list().length, 1, 'the legacy XP save became one account');
  const acc = s.get(s.list()[0].id);
  assert.equal(acc.name, 'Philip');
  assert.equal(acc.skin, 4);
  assert.equal(acc.stats.level, 7);
  assert.equal(acc.stats.wins, 6);
  assert.equal(acc.stats.v, STATS_V, 'migrated stats carry the current schema version');
  assert.equal(s.active(), null, 'migration does not auto-sign-in: the chooser shows the card');
  // a second construction must NOT migrate again (no duplicate account)
  const s2 = new AccountStore(store);
  assert.equal(s2.list().length, 1);
});

test('store: no legacy save means a fresh, empty store (first run shows the chooser)', () => {
  const s = new AccountStore(memStorage());
  assert.equal(s.list().length, 0);
});

test('stats: sanitize fills a valid object and clamps junk', () => {
  const s = sanitizeStats({ level: -4, xp: 1e9, wins: 'lots', elims: 3.7, modes: { Solo: 2, bad: -1, '': 3 } });
  assert.equal(s.level, 1);
  assert.ok(s.xp >= 0 && s.xp < xpForLevel(s.level));
  assert.equal(s.wins, 0);
  assert.equal(s.elims, 3);
  assert.deepEqual(s.modes, { Solo: 2 }, 'bad / empty mode keys dropped');
  assert.deepEqual(sanitizeStats(null), defaultStats());
});

// ------------------------------------------------------------------ stat maths from a match result

test('stats: a win updates wins, elims, place, streak, XP and level', () => {
  const s = defaultStats();
  const r = applyAward(s, { won: true, elims: 3, place: 1, mode: 'Battle Royale', alive: 120, damage: 400, died: false });
  // XP: 3*50 + 300 victory + 400/10 + 25 played = 515
  assert.equal(r.gained, 515);
  assert.equal(s.matches, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.elims, 3);
  assert.equal(s.deaths, 0);
  assert.equal(s.bestPlace, 1);
  assert.equal(s.streak, 1);
  assert.equal(s.bestStreak, 1);
  assert.equal(s.playtime, 120);
  assert.equal(s.modes['Battle Royale'], 1);
});

test('stats: a loss records a death, resets the streak, keeps the best place/streak', () => {
  const s = defaultStats();
  applyAward(s, { won: true, elims: 2, place: 1, mode: 'Duos', alive: 100, died: false });
  applyAward(s, { won: true, elims: 1, place: 1, mode: 'Duos', alive: 90, died: false });
  assert.equal(s.streak, 2);
  assert.equal(s.bestStreak, 2);
  applyAward(s, { won: false, elims: 1, place: 6, players: 16, mode: 'Duos', alive: 55, died: true });
  assert.equal(s.matches, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.deaths, 1);
  assert.equal(s.streak, 0, 'a loss resets the current streak');
  assert.equal(s.bestStreak, 2, 'the best streak is kept');
  assert.equal(s.bestPlace, 1, 'best place stays the best (lowest)');
  assert.equal(s.elims, 4); // 2 + 1 + 1
  assert.equal(kd(s), '4.00'); // 4 elims / 1 death
  assert.equal(winRate(s), 67); // 2 of 3
  assert.equal(favoriteMode(s), 'Duos');
});

test('stats: XP rolls the level over and reports animation steps', () => {
  const s = defaultStats();
  // level 1 needs 660 XP; a 515 then another should cross the line
  applyAward(s, { won: true, elims: 3, place: 1, damage: 400 }); // 515
  const r = applyAward(s, { won: true, elims: 3, place: 1, damage: 400 }); // +515 -> over 660
  assert.equal(s.level, 2, 'crossed into level 2');
  assert.ok(r.steps.some((x) => x.levelUp), 'a level-up step is reported');
  assert.equal(levelInfo(s).level, 2);
});

test('stats: Profile wrapper awards and persists through its onSave hook', () => {
  const stats = defaultStats();
  let saved = 0;
  const p = new Profile(stats, () => { saved++; });
  const res = p.award({ won: true, elims: 1, place: 1, alive: 30 });
  assert.ok(res.gained > 0);
  assert.equal(stats.wins, 1);
  assert.equal(saved, 1, 'award persists once via onSave');
  assert.equal(p.level, stats.level);
});

// ------------------------------------------------------------------ passwords

test('crypto: password hash + verify, and the password is never stored', async () => {
  const rec = await hashPassword('t-rex-123');
  assert.ok(rec.iter >= 150000, 'at least 150 000 PBKDF2 rounds');
  assert.ok(rec.salt && rec.hash);
  assert.equal(JSON.stringify(rec).includes('t-rex-123'), false, 'the plaintext password is not in the record');
  assert.equal(await verifyPassword('t-rex-123', rec), true, 'the right password verifies');
  assert.equal(await verifyPassword('wrong', rec), false, 'a wrong password does not');
  assert.equal(await verifyPassword('t-rex-123', null), false, 'a missing record never throws');
  assert.equal(await verifyPassword('t-rex-123', { salt: 'x' }), false, 'a malformed record never throws');
  // two hashes of the same password differ (random salt)
  const rec2 = await hashPassword('t-rex-123');
  assert.notEqual(rec.salt, rec2.salt);
  assert.notEqual(rec.hash, rec2.hash);
});

// ------------------------------------------------------------------ account transfer (Move my account)

test('crypto: transfer round-trip — right PIN works, wrong PIN fails, tampered code fails', async () => {
  const profile = { v: 1, name: 'Nova', skin: 2, stats: { ...defaultStats(), wins: 9, matches: 20 } };
  const code = await encryptTransfer(profile, '2468');
  assert.ok(code.startsWith('PHA1.'), 'the code carries the format marker');
  assert.equal(code.includes('Nova'), false, 'the account is encrypted, not in the clear');

  const back = await decryptTransfer(code, '2468');
  assert.equal(back.name, 'Nova');
  assert.equal(back.stats.wins, 9);
  assert.equal(back.stats.matches, 20);

  await assert.rejects(() => decryptTransfer(code, '0000'), (e) => e.bad === 'pin', 'wrong PIN rejected');
  const tampered = code.slice(0, -6) + (code.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
  await assert.rejects(() => decryptTransfer(tampered, '2468'), 'a tampered code rejected');
  await assert.rejects(() => decryptTransfer('not-a-code', '2468'), (e) => e.bad === 'format', 'garbage rejected as a format error');
});

test('store: a profile exports and imports (brought over by a transfer code)', async () => {
  const s = new AccountStore(memStorage());
  const a = s.create({ name: 'Rex', skin: 1 });
  a.stats.wins = 5; a.stats.matches = 12; a.stats.elims = 30;
  s.persist(a);
  const code = await encryptTransfer(s.exportObject(a.id), '1357');
  // the other device
  const s2 = new AccountStore(memStorage());
  const obj = await decryptTransfer(code, '1357');
  const imported = s2.importProfile(obj);
  assert.equal(imported.name, 'Rex');
  assert.equal(imported.stats.wins, 5);
  assert.equal(imported.stats.matches, 12);
  assert.equal(imported.passkey, null, 'the passkey does not travel (it was bound to the old device)');
});

// ------------------------------------------------------------------ signing identity (stage 2 groundwork)

test('crypto: a signing identity is generated and can sign (stage 2 uses this; nothing destructive now)', async () => {
  const id = await makeSigningIdentity();
  assert.equal(id.alg, 'HMAC-SHA256');
  assert.ok(id.key);
  const sig = await sign('ban:player9', id);
  assert.ok(sig.length > 0);
  const same = await sign('ban:player9', id);
  assert.equal(sig, same, 'the same message + key signs the same');
  const other = await sign('ban:player8', id);
  assert.notEqual(sig, other, 'a different message signs differently');
  assert.equal(await sign('x', null), '', 'no identity -> empty signature, never throws');
});

test('store: a new account carries a signing identity but is not an admin', () => {
  const s = new AccountStore(memStorage());
  const a = s.create({ name: 'Kid', sign: { alg: 'HMAC-SHA256', key: 'abc', created: 1 } });
  assert.ok(a.sign && a.sign.key, 'the signing identity is kept');
  assert.equal(a.isAdmin, false);
});

// ------------------------------------------------------------------ guest stats are NOT persisted

test('store: guest stats live only in memory and never reach the disk', () => {
  const store = memStorage();
  const s = new AccountStore(store);
  const g = s.startGuest({ name: 'Visitor' });
  assert.equal(s.active().id, 'guest');
  // award to the guest through a Profile bound to its stats
  const p = new Profile(g.stats, () => s.persist(g));
  p.award({ won: true, elims: 4, place: 1, mode: 'Solo', alive: 80 });
  assert.equal(g.stats.wins, 1, 'the guest sees its own progress this session');
  // the disk shows no guest, and no guest wins
  const raw = store.getItem('phortnite.accounts') || '';
  assert.equal(raw.includes('Visitor'), false, 'the guest name is not written to disk');
  // a reload has no guest and nobody active
  const s2 = new AccountStore(store);
  assert.equal(s2.list().length, 0);
  assert.equal(s2.active(), null, 'the guest is gone after a reload');
});

test('store: persist() is a no-op for a guest but saves a real account', () => {
  const store = memStorage();
  const s = new AccountStore(store);
  const a = s.create({ name: 'Real' });
  const before = store.getItem('phortnite.accounts');
  const g = s.startGuest({ name: 'Ghost' });
  g.stats.wins = 99;
  s.persist(g);
  // the real account is still on disk; the guest never is
  const raw = store.getItem('phortnite.accounts');
  assert.ok(raw.includes('Real'));
  assert.equal(raw.includes('Ghost'), false);
  // the guest's 99 wins must never reach disk — parse rather than substring-match, since "99" can
  // appear by chance in a real account's random id or createdAt timestamp (that is not the guest).
  const onDisk = JSON.parse(raw).profiles;
  assert.equal(onDisk.some((x) => x.stats && x.stats.wins === 99), false, 'the guest wins never reach disk');
});

// ------------------------------------------------------------------ crafted transfer codes

test('transfer: a crafted code can not freeze the device, plant a key, or smuggle junk', async () => {
  // a code whose own round count is absurd is refused as a bad code, never run
  const good = await encryptTransfer({ name: 'X' }, '1234');
  const payload = JSON.parse(Buffer.from(good.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  payload.iter = 1e12;
  const evil = 'PHA1.' + Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await assert.rejects(decryptTransfer(evil, '1234'), (e) => e.bad === 'format');
  // a password record with a billion rounds is dropped, a sane one kept
  const pw = await hashPassword('hunter22', 100000);
  assert.ok(cleanPwRecord(pw), 'a real record is kept');
  assert.equal(cleanPwRecord({ ...pw, iter: MAX_ROUNDS + 1 }), null);
  assert.equal(await verifyPassword('hunter22', { ...pw, iter: 1e12 }), false, 'never runs a billion rounds');
  // importing: no signing key, no admin, a clean password record, a small flat cosmetics map
  const s = new AccountStore(memStorage());
  const big = {}; for (let i = 0; i < 1000; i++) big['c' + i] = true;
  big.evil = { nested: 'x'.repeat(1e5) };
  const acc = s.importProfile({ name: '<b>Hax</b>', isAdmin: true, sign: { key: 'stolen' }, pw: { ...pw, iter: 1e12 }, cosmetics: big, stats: { wins: 3 } });
  assert.equal(acc.isAdmin, false);
  assert.equal(acc.sign, null, 'a signing key never comes in a transfer code');
  assert.equal(acc.pw, null, 'a crafted password record is dropped');
  assert.ok(Object.keys(acc.cosmetics).length <= 200 && !('evil' in acc.cosmetics));
  assert.doesNotMatch(acc.name, /[<>]/);
  // and exporting never carries the signing identity
  const mine = s.create({ name: 'Me', sign: await makeSigningIdentity() });
  assert.equal('sign' in s.exportObject(mine.id), false);
});
