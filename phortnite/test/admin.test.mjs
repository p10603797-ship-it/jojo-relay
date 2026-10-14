// Philip's admin (public/js/admin/, tools/admin.mjs): the admin key file and its password, signed
// commands (and everything a page refuses: other keys, tampering, replays, stale or misdirected
// commands), the player cards sealed to the admin, the command channel on the live player count's
// broker connection, the party commands on a host's room, and the ban written in exactly the lock
// screen's format. Keys are made in memory (or a temp folder) with the smallest round count
// allowed (100,000), so this stays quick; the real file uses 600,000.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, importPublic, unlockAdmin, keysMatch, signCommand, verifyCommand, sealToAdmin, openSealed, createAdminConfig,
  canonical, randomNonce, normalizeAdminPassword, ADMIN_ALPHABET, ADMIN_PASSWORD_LENGTH, MIN_ITER, MAX_ITER, newBoxKey, importBoxPub,
  SEAL_CARD, SEAL_PAGE,
} from '../public/js/admin/keys.js';
import {
  CMD_TOPIC, STATE_PREFIX, STATE_TOPICS, CommandGate, makeEnvelope, cleanArgs, stateActive, cleanCard, makeObserverCheck, partyNote,
  MAX_AGE, MAINT_MAX_MS, STATE_MAX_MS,
} from '../public/js/admin/commands.js';
import * as ban from '../public/js/admin/ban.js';
import { STRIKES as LOCK_STRIKES, BAN_KEY as LOCK_BAN_KEY, BAN_COOKIE as LOCK_BAN_COOKIE, HEAD_SCRIPT } from '../tools/lock.mjs';
import { generateAdminPassword, groupPassword } from '../tools/admin.mjs';
import { AdminClient } from '../public/js/admin/client.js';
import { AdminSession } from '../public/js/admin/session.js';
import { Presence, PRESENCE_PREFIX, parse as parsePresence } from '../public/js/net/presence.js';
import { Mqtt } from '../public/js/net/mqtt.js';
import { useBrokers } from '../public/js/net/relay.js';
import { startBroker } from './helpers/minibroker.mjs';
import { makeRoom } from './helpers/roomharness.mjs';
import { defaultStats, addXp, xpForLevel } from '../public/js/accounts/stats.js';
import { P2PHost, P2PClient, usePeer } from '../public/js/net/p2p.js';
import { AdminNotes } from '../public/js/admin/notes.js';
import { PROTOCOL } from '../public/shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'admin.mjs');
const LOADER = path.join(ROOT, 'tools', 'lockscreen', 'lock.js');
const ITER = MIN_ITER;
const PASSWORD = 'TEST-ADMN-23XY'; // made up for the tests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, what = '') => {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(`timed out ${what}`); await sleep(10); }
};
const FAST = { refreshMs: 600, perPlayerMs: 0, staleMin: 1500, minGapMs: 0, hideMs: 150, tickMs: 50, settleMs: 150, notifyMs: 20, backoffMs: 50, maxBackoffMs: 400, connectMs: 2000 };

// one admin key for most tests (made once), and a second one that is NOT the admin's
const shared = (async () => {
  const cfg = loadConfig(await createAdminConfig(PASSWORD, { iter: ITER }));
  const keys = await unlockAdmin(cfg, PASSWORD);
  const pubs = await importPublic(cfg);
  const other = loadConfig(await createAdminConfig('OTHR-KEYS-2345', { iter: ITER }));
  return { cfg, keys, pubs, otherKeys: await unlockAdmin(other, 'OTHR-KEYS-2345'), otherPubs: await importPublic(other) };
})();

const body = (o = {}) => ({ v: 1, cmd: 'message', args: { text: 'hi' }, to: '*', ts: Date.now(), n: randomNonce(), ...o });

// ------------------------------------------------------------------ the key file + the CLI

test('admin CLI: new prints the password once and never writes it; check says yes for it, no for another; no overwrite without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phortnite-admin-'));
  try {
    const out = path.join(dir, 'admin.json');
    const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, PHORTNITE_ADMIN: '', ...env } });
    const r = run(['new', '--out', out, '--iter', String(ITER)]);
    assert.equal(r.status, 0, r.stderr);
    const shown = r.stdout.match(/\b[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\b/g);
    assert.equal(shown.length, 1, 'printed exactly once');
    const pw = normalizeAdminPassword(shown[0]);
    assert.equal(pw.length, ADMIN_PASSWORD_LENGTH);
    for (const c of pw) assert.ok(ADMIN_ALPHABET.includes(c));
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(!text.includes(pw) && !text.includes(shown[0]), 'the password is not in the file');
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc).sort(), ['box', 'enc', 'sign', 'v']);
    assert.equal(doc.enc.kdf, 'PBKDF2-SHA256');
    assert.equal(doc.enc.iter, ITER);
    assert.ok(loadConfig(doc), 'a valid admin.json');
    // check: right (any case, spaces / dashes), wrong, missing
    assert.equal(run(['check', '--in', out], { PHORTNITE_ADMIN: shown[0].toLowerCase().replace(/-/g, ' ') }).status, 0);
    assert.equal(run(['check', '--in', out], { PHORTNITE_ADMIN: 'AAAABBBBCCCC' }).status, 1);
    assert.notEqual(run(['check', '--in', out]).status, 0, 'no password given');
    // never replaced by accident; --force makes a new key (the old password stops working)
    const again = run(['new', '--out', out, '--iter', String(ITER)]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.equal(fs.readFileSync(out, 'utf8'), text);
    const forced = run(['new', '--out', out, '--iter', String(ITER), '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.notEqual(JSON.parse(fs.readFileSync(out, 'utf8')).sign.pub, doc.sign.pub);
    assert.equal(run(['check', '--in', out], { PHORTNITE_ADMIN: pw }).status, 1, 'the old password no longer unlocks it');
    // the password is never a command-line argument; weak round counts are refused
    assert.match(run(['new', '--out', out, '--password', 'x']).stderr, /PHORTNITE_ADMIN/);
    assert.notEqual(run(['new', '--out', path.join(dir, 'b.json'), '--iter', '1000']).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin password: 12 characters from the easy-to-read alphabet, from crypto random numbers', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const p = generateAdminPassword();
    assert.match(p, /^[A-HJ-NP-Z2-9]{12}$/);
    for (const c of p) seen.add(c);
  }
  assert.equal(seen.size, ADMIN_ALPHABET.length);
  assert.equal(groupPassword('ABCDEFGHJKLM'), 'ABCD-EFGH-JKLM');
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /randomInt\(ADMIN_ALPHABET\.length\)/);
  assert.doesNotMatch(src, /Math\.random/);
});

test('admin keys: the right password unlocks non-extractable keys; a wrong one, junk files and huge round counts do not', async () => {
  const { cfg, keys, pubs, otherKeys } = await shared;
  assert.ok(keys && keys.sign && keys.box);
  assert.equal(keys.sign.extractable, false, 'the signing key can never be read back');
  assert.equal(keys.box.extractable, false);
  assert.ok(await unlockAdmin(cfg, 'test admn 23xy'), 'any case, spaces for dashes');
  assert.equal(await unlockAdmin(cfg, 'TEST-ADMN-23XZ'), null);
  assert.equal(await unlockAdmin(cfg, ''), null);
  assert.equal(await keysMatch(cfg, keys), true);
  assert.equal(await keysMatch(pubs, otherKeys), false, 'another key pair is not the admin');
  // junk and bounds (a crafted file can't freeze the iPad with a billion rounds)
  for (const bad of [null, '', 'nope', '[]', { v: 2 }, { ...cfg, enc: { ...cfg.enc, iter: MAX_ITER + 1 } }, { ...cfg, enc: { ...cfg.enc, iter: MIN_ITER - 1 } },
    { ...cfg, enc: { ...cfg.enc, kdf: 'MD5' } }, { ...cfg, sign: { pub: 'not base64!' } }, { ...cfg, enc: { ...cfg.enc, iv: 'AAAA' } }]) {
    assert.equal(loadConfig(typeof bad === 'string' ? bad : JSON.stringify(bad)), null, JSON.stringify(bad));
  }
  const t0 = Date.now();
  assert.equal(await unlockAdmin({ ...cfg, enc: { ...cfg.enc, iter: 1e9 } }, PASSWORD), null);
  assert.ok(Date.now() - t0 < 1000, 'refused before any work');
  // a file whose public key is someone else's opens nothing (the pair must match)
  const swapped = loadConfig({ ...JSON.parse(JSON.stringify(cfg)), box: { pub: loadConfig(await createAdminConfig('ZZZZ-ZZZZ-ZZZZ', { iter: ITER })).box.pub } });
  assert.equal(await unlockAdmin(swapped, PASSWORD), null, 'a box key that is not the pair of the encrypted one');
});

// ------------------------------------------------------------------ signatures

test('commands: signed by the admin verify; another key, a changed body or a changed signature do not', async () => {
  const { keys, pubs, otherKeys } = await shared;
  const env = await signCommand(keys.sign, body({ args: { text: 'hi', z: { b: 1, a: 2 } } }));
  assert.equal(await verifyCommand(pubs.signPub, env), true);
  assert.equal(canonical({ ...env, args: { z: { a: 2, b: 1 }, text: 'hi' } }), canonical(env), 'key order does not matter');
  assert.equal(await verifyCommand(pubs.signPub, await signCommand(otherKeys.sign, body())), false, 'signed by another key');
  for (const change of [{ cmd: 'ban' }, { args: { text: 'ho' } }, { to: 'abc123' }, { ts: env.ts + 1 }, { n: randomNonce() }, { v: 2 }]) {
    assert.equal(await verifyCommand(pubs.signPub, { ...env, ...change }), false, JSON.stringify(change));
  }
  const sig = Buffer.from(env.sig, 'base64');
  sig[10] ^= 1;
  assert.equal(await verifyCommand(pubs.signPub, { ...env, sig: sig.toString('base64') }), false, 'a changed signature');
  for (const s of ['', 'AAAA', 'x'.repeat(300), null]) assert.equal(await verifyCommand(pubs.signPub, { ...env, sig: s }), false);
  assert.equal(await verifyCommand(pubs.signPub, null), false);
  // a '__proto__' key slipped into the args (JSON makes it a real key): the signature covers it too
  const plain = await signCommand(keys.sign, body({ args: { text: 'hi' } }));
  const smuggled = JSON.parse(JSON.stringify(plain).replace('"args":{', '"args":{"__proto__":{"evil":1},'));
  assert.deepEqual(Object.keys(smuggled.args), ['__proto__', 'text']);
  assert.equal(await verifyCommand(pubs.signPub, smuggled), false, 'extra data riding along under a valid signature');
  const signedWith = await signCommand(keys.sign, smuggled);
  assert.equal(await verifyCommand(pubs.signPub, JSON.parse(JSON.stringify(signedWith))), true, 'signed with it: still checks out');
});

test('command gate: only fresh, new, well-aimed, signed commands get through; one page\'s args are sealed to its own key', async () => {
  const { keys, pubs, otherKeys } = await shared;
  let now = 1.8e12;
  const page = await newBoxKey(), faker = await newBoxKey();
  const gate = new CommandGate({ signPub: pubs.signPub, pageKey: page.priv, now: () => now });
  const me = 'abc123def456';
  const mk = (cmd, args, to = me, ts = now, k = keys.sign, pagePub = page.pub) => makeEnvelope(k, cmd, args, to, ts, { pagePub });
  const msg = await mk('message', { text: 'hello' });
  // for one page: nothing private in the clear (names, messages and reasons are sealed to its key)
  assert.deepEqual(Object.keys(msg.args), ['x']);
  assert.ok(!JSON.stringify(msg).includes('hello'));
  assert.deepEqual(await openSealed(page.priv, msg.args.x, SEAL_PAGE), { cmd: 'message', to: me, text: 'hello' });
  assert.equal(await openSealed(page.priv, msg.args.x), null, 'not as a card');
  const r = await gate.live(msg, me);
  assert.equal(r.ok, true);
  assert.deepEqual(r.env.args, { text: 'hello' });
  assert.equal(r.raw, msg, 'the envelope as signed, for the party to check');
  assert.deepEqual((await gate.live(await mk('grant', { xp: 500 }), me)).env.args, { xp: 500 });
  // sealed to another key (the admin acted on a card someone faked for this page): does nothing
  assert.equal((await gate.live(await mk('ban', { reason: 'x' }, me, now, keys.sign, faker.pub), me)).why, 'card');
  // a page whose own key isn't made yet: refused too; one page always needs its key to be sent to
  assert.equal((await new CommandGate({ signPub: pubs.signPub, now: () => now }).live(await mk('message', { text: 'x' }), me)).why, 'card');
  await assert.rejects(makeEnvelope(keys.sign, 'message', { text: 'x' }, me, now), /no key/);
  // party commands: the party code (and pause on / the mode) stay readable for the party; the rest is sealed
  const kick = await mk('kick', { reason: 'Mia was mean', code: 'ABCD' });
  assert.deepEqual(Object.keys(kick.args).sort(), ['code', 'x']);
  assert.ok(!JSON.stringify(kick).includes('Mia'));
  assert.deepEqual((await gate.live(kick, me)).env.args, { reason: 'Mia was mean', code: 'ABCD' });
  assert.deepEqual(Object.keys((await mk('pause', { on: true, code: 'ABCD' })).args).sort(), ['code', 'on', 'x']);
  assert.deepEqual(Object.keys((await mk('mode', { modeId: 'solo', code: 'ABCD' })).args).sort(), ['code', 'modeId', 'x']);
  // replayed
  assert.equal((await gate.live(msg, me)).why, 'replay');
  // stale (or from the future), either way past 2 minutes
  assert.equal((await gate.live(await mk('message', { text: 'old' }, me, now - MAX_AGE - 1), me)).why, 'stale');
  assert.equal((await gate.live(await mk('message', { text: 'later' }, me, now + MAX_AGE + 1), me)).why, 'stale');
  assert.equal((await gate.live(await mk('message', { text: 'edge' }, me, now - MAX_AGE + 5), me)).ok, true);
  // aimed at someone else; '*' only for reload / message (a slip can't ban everyone)
  assert.equal((await gate.live(await mk('message', { text: 'x' }, 'someoneelse1'), me)).why, 'to');
  const all = await mk('message', { text: 'all' }, '*');
  assert.deepEqual(all.args, { text: 'all' }, "for everyone: in the clear (it's public anyway), no key needed");
  assert.equal((await gate.live(all, me)).ok, true);
  assert.equal((await gate.live(await mk('reload', {}, '*'), me)).ok, true);
  for (const cmd of ['ban', 'kick', 'rename', 'grant', 'resetStats', 'end', 'pause', 'mode']) {
    const args = { rename: { name: 'X' }, grant: { xp: 1 }, pause: { on: true }, mode: { modeId: 'solo' } }[cmd] || {};
    assert.equal((await gate.live(await mk(cmd, args, '*'), me)).why, 'to', `${cmd} to everyone`);
  }
  // another key; a state message on the live topic; unknown commands; junk
  assert.equal((await gate.live(await mk('message', { text: 'x' }, me, now, otherKeys.sign), me)).why, 'sig');
  assert.equal((await gate.live(await mk('banner', { text: 'x' }, '*'), me)).why, 'cmd');
  assert.equal((await gate.live({ ...(await mk('message', { text: 'x' })), cmd: 'format' }, me)).why, 'cmd');
  for (const junk of [null, 'x', [], { v: 1 }, { ...msg, n: 'short' }, { ...msg, to: 'UPPER' }, { ...msg, n: randomNonce(), args: { text: 'no seal' } }]) assert.equal((await gate.live(junk, me)).ok, false);
  // args are checked and clamped before anything happens
  await assert.rejects(mk('grant', { xp: 100001 }));
  assert.equal(cleanArgs('grant', { xp: -5 }), null);
  assert.equal(cleanArgs('rename', { name: ' <> ' }), null, 'nothing left of the name');
  assert.equal(cleanArgs('rename', { name: '  Mia<script> ' }).name, 'Miascript');
  assert.equal(cleanArgs('message', { text: 'x'.repeat(900) }).text.length, 300);
  assert.equal(cleanArgs('mode', { modeId: '../x' }), null);
  assert.deepEqual(cleanArgs('end', { code: 'abcd' }), {}, 'not a party code');

  // a flood of junk can't keep the device busy checking signatures (rate 2 per bucket here, one waiting)
  const busy = new CommandGate({ signPub: pubs.signPub, pageKey: page.priv, now: () => now, rate: 2, queue: 1 });
  const junk = (i, to = '*') => makeEnvelope(otherKeys.sign, 'message', { text: `f${i}` }, to, now, { pagePub: page.pub });
  const j0 = await junk(0);
  assert.equal((await busy.live(j0, me)).why, 'sig');
  assert.equal((await busy.live(j0, me)).why, 'sig', 'the same junk again: refused without another check');
  assert.equal((await busy.live(await junk(1), me)).why, 'sig');
  // the '*' budget is spent: the next check waits; a newer one pushes it out (the newest first)
  const [j2, j3] = [await junk(2), await junk(3)];
  const w2 = busy.live(j2, me), w3 = busy.live(j3, me);
  assert.equal((await w2).why, 'busy');
  // junk sent to everyone never starves a command aimed at this page: it has its own budget
  assert.equal((await busy.live(await mk('message', { text: 'real' }), me)).ok, true);
  // the one waiting is checked once there is room again
  now += 11000;
  assert.equal((await w3).why, 'sig');
  assert.equal((await busy.live(await mk('reload', {}, '*'), me)).ok, true, 'the budget comes back');
  assert.equal(new CommandGate({ signPub: pubs.signPub }).budgets.all.rate, 1000, 'well above what one client can send through a public broker');
});

test('state messages: only on their own topic, signed; banner and maintenance run out by themselves', async () => {
  const { keys, pubs, otherKeys } = await shared;
  const now = 1.8e12;
  const gate = new CommandGate({ signPub: pubs.signPub, now: () => now });
  const banner = await makeEnvelope(keys.sign, 'banner', { text: 'Hi all', id: 'b1', until: now + 60000 }, '*', now - 3 * 3600000);
  const r = await gate.state(banner, 'banner');
  assert.equal(r.ok, true, 'a retained state may be hours old');
  assert.equal((await gate.state(banner, 'banner')).ok, true, 'and heard again after a reconnect');
  assert.equal((await gate.state(banner, 'maintenance')).ok, false, 'on the wrong topic');
  assert.equal((await gate.state(await makeEnvelope(otherKeys.sign, 'banner', { text: 'fake' }, '*', now), 'banner')).ok, false);
  assert.equal((await gate.state(await makeEnvelope(keys.sign, 'message', { text: 'x' }, '*', now), 'banner')).ok, false);
  assert.equal((await gate.state(await makeEnvelope(keys.sign, 'banner', { text: 'x' }, 'abc123', now), 'banner')).ok, false, "a state is for '*'");
  assert.equal(stateActive('banner', r.env.args, now), true);
  assert.equal(stateActive('banner', r.env.args, now + 60001), false, 'past its until');
  assert.equal(stateActive('banner', { text: 'forever', id: 'x', until: 0 }, now + 6 * 86400000, now), true, 'until cleared');
  assert.equal(stateActive('banner', { text: 'forever', id: 'x', until: 0 }, now + STATE_MAX_MS + 1, now), false, "but a week at most: a replayed old one runs out");
  assert.equal(stateActive('banner', { text: 'far', id: 'x', until: 8e15 }, now + STATE_MAX_MS + 1, now), false);
  assert.equal(MAINT_MAX_MS, STATE_MAX_MS);
  assert.deepEqual(STATE_TOPICS, [STATE_PREFIX + 'banner', STATE_PREFIX + 'maintenance'], 'two exact topics, no wildcard');
  assert.equal(stateActive('banner', { text: '', id: '', until: 0 }, now), false, 'cleared');
  const m = cleanArgs('maintenance', { on: true, text: 'Back soon', until: now + 3600000 });
  assert.equal(stateActive('maintenance', m, now, now), true);
  assert.equal(stateActive('maintenance', m, now + 3600001, now), false);
  assert.equal(stateActive('maintenance', { ...m, until: now + MAINT_MAX_MS + 1 }, now, now), false, 'never longer than a week from its signing');
  assert.equal(stateActive('maintenance', { ...m, on: false }, now, now), false);
});

// ------------------------------------------------------------------ sealed cards

test('sealed cards: only the admin key opens them, a changed one opens to nothing, and a full card is well under 1 KB', async () => {
  const { keys, pubs, otherKeys } = await shared;
  const card = {
    id: 'abc123def456', name: 'Mia'.padEnd(16, 'x'), level: 999, account: 'a1b2c3d4', mode: 'Battle Royale Squads with Bots'.padEnd(40, '!'),
    phase: 'match', party: { code: 'ABCD', kind: 'member', size: 8 }, v: '2.3.0', since: Date.now(), admin: false, pk: (await newBoxKey()).raw,
  };
  const s = await sealToAdmin(pubs.boxPub, card);
  assert.deepEqual(await openSealed(keys.box, s), card);
  assert.equal(await openSealed(otherKeys.box, s), null, 'another key');
  const ct = Buffer.from(s.ct, 'base64');
  ct[3] ^= 1;
  assert.equal(await openSealed(keys.box, { ...s, ct: ct.toString('base64') }), null, 'tampered');
  assert.equal(await openSealed(keys.box, { ...s, e: (await sealToAdmin(pubs.boxPub, card)).e }), null, 'another seal\'s key');
  for (const junk of [null, {}, { e: 'x', iv: 'y', ct: 'z' }]) assert.equal(await openSealed(keys.box, junk), null);
  assert.equal(await openSealed(keys.box, s, SEAL_PAGE), null, "a card can't pass for a command's args");
  assert.equal(await openSealed(keys.box, await sealToAdmin(pubs.boxPub, card, SEAL_PAGE)), null, 'nor the other way round');
  // a page's own key: its public half goes in the card, the admin seals to it
  const page = await newBoxKey();
  assert.equal(page.priv.extractable, false);
  assert.match(page.raw, /^[A-Za-z0-9+/]{87}=$/);
  assert.deepEqual(await openSealed(page.priv, await sealToAdmin(await importBoxPub(page.raw), { n: 1 }, SEAL_PAGE), SEAL_PAGE), { n: 1 });
  for (const junk of ['', 'AAAA', 'x'.repeat(88), null]) assert.equal(await importBoxPub(junk), null);
  const msg = JSON.stringify({ a: s, s: 'm', t: Math.floor(Date.now() / 1000) });
  assert.ok(msg.length < 1024, `${msg.length} bytes`);
  assert.ok(!msg.includes('Mia') && !msg.includes('ABCD'), 'no name or party code in plain text');
  assert.notEqual((await sealToAdmin(pubs.boxPub, card)).ct, s.ct, 'every seal is different');
  // what the panel shows: only known fields, trimmed
  assert.deepEqual(cleanCard({ ...card, extra: 'x', name: '<i>Bob</i>' }), { ...card, name: 'iBob/i' });
  assert.equal(cleanCard({ ...card, id: 'NOT VALID' }), null);
  assert.equal(cleanCard({ ...card, pk: 'not a key' }).pk, null);
});

test('presence: messages with and without a sealed card both count; junk cards are dropped, not the player', () => {
  assert.deepEqual(parsePresence('{"s":"l","t":5}'), { s: 'l', t: 5 });
  const a = { e: 'QUJD', iv: 'aXY=', ct: 'Y3Q=' };
  assert.deepEqual(parsePresence(JSON.stringify({ s: 'm', t: 5, a })), { s: 'm', t: 5, a });
  assert.deepEqual(parsePresence(JSON.stringify({ s: 'l', t: 5, a: { e: 'x'.repeat(500), iv: '', ct: '' } })), { s: 'l', t: 5 });
  assert.deepEqual(parsePresence(JSON.stringify({ s: 'l', t: 5, a: 'nope', name: 'Mia' })), { s: 'l', t: 5 }, 'nothing else is kept');
  assert.equal(parsePresence(JSON.stringify({ t: 5, a })), null);
});

// ------------------------------------------------------------------ the channel, end to end

/** A stand-in for the App: enough for AdminClient / AdminSession (no DOM). */
function fakeApp(presence, name, extra = {}) {
  const app = {
    presence, settings: { name }, profile: { level: 7, data: defaultStats(), save() {} }, partyKind: () => 'solo', game: null,
    activeAccount: { id: 'p_0123456789abcdef', name }, admin: null, toasts: [],
    announce: { setAdmin(b) { app.banner = b; } },
    lobby: { toast(html) { app.toasts.push(html); }, render() {} },
    ...extra,
  };
  return app;
}

/** An AdminClient whose on-screen parts are recorded instead of drawn. */
function quietClient(app, cfg, pubs) {
  const c = new AdminClient(app, cfg, pubs);
  app.adminClient = c;
  c.ran$ = [];
  c.run = (env) => c.ran$.push(env);
  c.maintenance = (m) => { c.maint$ = m; };
  c.chip = () => {};
  c.overlay = () => {};
  return c;
}

async function poker(b) {
  const m = new Mqtt({ url: b.url });
  await m.connect(3000);
  return m;
}

test('admin channel: cards reach only the admin; commands reach only the page they name; replays, forgeries and stale ones are ignored', async () => {
  const { cfg, keys, pubs, otherKeys } = await shared;
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const pa = new Presence({ ...FAST }), pb = new Presence({ ...FAST }), pc = new Presence({ ...FAST });
  const A = fakeApp(pa, 'Philip'), B = fakeApp(pb, 'Mia'), C = fakeApp(pc, 'Sam', { activeAccount: { id: 'guest', guest: true } });
  const ca = quietClient(A, cfg, pubs), cb = quietClient(B, cfg, pubs), cc = quietClient(C, cfg, pubs);
  let session = null;
  const x = await poker(b);
  // someone listening to everything on the public broker
  const heard = [];
  await x.subscribe('#', (text, topic) => heard.push(`${topic} ${text}`));
  try {
    for (const c of [ca, cb, cc]) c.start();
    for (const p of [pa, pb, pc]) p.start();
    await until(() => [pa, pb, pc].every((p) => p.online && p.counts.total === 3), 6000, 'all online');
    A.admin = session = new AdminSession(A, { cfg, pubs, keys });
    await until(() => session.players().length === 3, 6000, 'three cards');
    const byName = Object.fromEntries(session.players().map((p) => [p.name, p]));
    assert.equal(byName.Philip.me, true);
    assert.equal(byName.Mia.id, pb.id);
    assert.equal(byName.Mia.level, 7);
    assert.equal(byName.Mia.account, '01234567');
    assert.equal(byName.Sam.account, 'guest');
    assert.deepEqual(byName.Mia.party, { code: '', kind: 'solo', size: 1 });
    assert.equal(byName.Mia.pk, cb.pageKey.raw, "her page's own key rides in her card");
    assert.notEqual(byName.Mia.pk, byName.Sam.pk);
    assert.equal(session.totals().total, 3);
    // the broker only ever holds ciphertext: no names
    for (const [t, v] of b.retained) if (t.startsWith(PRESENCE_PREFIX)) {
      const s = v.toString();
      assert.ok(!/Mia|Sam|Philip/.test(s), s);
      assert.deepEqual(Object.keys(JSON.parse(s)).sort(), ['a', 's', 't']);
    }
    // a page that is not the admin can't open the cards
    assert.equal(await openSealed(otherKeys.box, pb.peers.get(pa.id).a), null);
    // a card change (a new name) reaches the admin within a couple of seconds
    let seen = 0;
    const off = session.onPlayers(() => seen++);
    B.settings.name = 'Mia2';
    await until(() => session.players().some((p) => p.name === 'Mia2'), 6000, 'renamed card');
    off();
    assert.ok(seen >= 1);

    // a command for Mia: only Mia's page acts on it
    const env = await session.send('message', { text: 'Hi Mia' }, pb.id);
    assert.ok(env);
    await until(() => cb.ran$.length === 1, 3000, 'Mia got it');
    assert.equal(cb.ran$[0].args.text, 'Hi Mia');
    await session.send('rename', { name: 'Bea' }, pb.id);
    await until(() => cb.ran$.length === 2, 3000, 'renamed');
    assert.equal(cb.ran$[1].args.name, 'Bea');
    await sleep(150);
    assert.equal(cc.ran$.length, 0, 'Sam did not');
    assert.equal(ca.ran$.length, 0);
    // the broker never saw the message or the new name in the clear (sealed to Mia's page)
    assert.ok(heard.some((h) => h.startsWith(CMD_TOPIC)), 'the listener heard the commands');
    assert.ok(!heard.some((h) => /Hi Mia|Bea|Mia2|Philip|Sam/.test(h)), heard.find((h) => /Hi Mia|Bea|Mia2|Philip|Sam/.test(h)));
    // replayed by someone on the broker: ignored
    x.publish(CMD_TOPIC, JSON.stringify(env));
    // signed with another key, stale, or changed: ignored
    const pagePub = await importBoxPub(byName.Mia.pk);
    x.publish(CMD_TOPIC, JSON.stringify(await makeEnvelope(otherKeys.sign, 'message', { text: 'fake' }, pb.id, Date.now(), { pagePub })));
    x.publish(CMD_TOPIC, JSON.stringify(await makeEnvelope(keys.sign, 'message', { text: 'old' }, pb.id, Date.now() - 3 * 60000, { pagePub })));
    x.publish(CMD_TOPIC, JSON.stringify({ ...(await makeEnvelope(keys.sign, 'message', { text: 'real' }, pb.id, Date.now(), { pagePub })), args: { text: 'changed' } }));
    x.publish(CMD_TOPIC, 'junk');
    await sleep(300);
    assert.equal(cb.ran$.length, 2, 'nothing else ran');
    // everyone ('*'): every other page; the admin's own page skips its own broadcast…
    await session.send('message', { text: 'Hi all' }, '*');
    await until(() => cb.ran$.length === 3 && cc.ran$.length === 1, 3000, 'everyone');
    await sleep(150);
    assert.equal(ca.ran$.length, 0, 'not the admin page that sent it');
    // …but obeys one aimed at it by id (testing on his own iPad)
    await session.send('grant', { xp: 50 }, pa.id);
    await until(() => ca.ran$.length === 1, 3000, 'aimed at the admin page');
  } finally {
    if (session) session.close();
    for (const c of [ca, cb, cc]) c.stop();
    for (const p of [pa, pb, pc]) p.stop();
    x.close();
    useBrokers(null);
    await b.stop();
  }
});

test('faked cards: a card someone seals for another page is marked, its page takes its topic back, and commands aimed at it do nothing there', async () => {
  const { cfg, keys, pubs } = await shared;
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const pa = new Presence({ ...FAST, minGapMs: 1500 }), pb = new Presence({ ...FAST, minGapMs: 1500 });
  const A = fakeApp(pa, 'Philip'), B = fakeApp(pb, 'Mia');
  const ca = quietClient(A, cfg, pubs), cb = quietClient(B, cfg, pubs);
  let session = null;
  const x = await poker(b);
  try {
    ca.start(); cb.start(); pa.start(); pb.start();
    await until(() => pa.online && pb.online && pa.counts.total === 2, 6000, 'online');
    A.admin = session = new AdminSession(A, { cfg, pubs, keys });
    await until(() => session.players().some((p) => p.name === 'Mia'), 6000, "Mia's card");
    const real = session.players().find((p) => p.name === 'Mia');
    // anyone can seal a card to the admin's PUBLIC key, with Mia's (public) id and their own page key
    const faker = await newBoxKey();
    const fake = { id: pb.id, name: 'BadWordsGuy', level: 1, account: 'guest', mode: '', phase: 'lobby', party: null, v: '9.9.9', since: Date.now(), pk: faker.raw };
    const topic = PRESENCE_PREFIX + pb.id;
    const forged = JSON.stringify({ s: 'l', t: Math.floor(Date.now() / 1000), a: await sealToAdmin(pubs.boxPub, fake) });
    pb.say(); // (so her answer waits its minimum gap: long enough to see what the admin's panel makes of the fake)
    x.publish(topic, forged, { retain: true });
    await until(() => b.retained.has(topic) && b.retained.get(topic).toString() === forged, 3000, 'the fake on her topic');
    // Mia's page hears someone else on its topic and says its own message again
    await until(() => pb.said.includes(b.retained.get(topic).toString()), 4000, 'Mia took her topic back');
    // the admin's panel marks that id: its cards came with two keys
    await until(() => session.players().some((p) => p.id === pb.id && p.suspect), 4000, 'marked');
    await until(() => session.players().some((p) => p.id === pb.id && p.name === 'Mia'), 4000, 'her own card again');
    // a ban the admin aimed at the faked card (sealed to the faker's key) does nothing on Mia's page
    const ban = await makeEnvelope(keys.sign, 'ban', { reason: 'language' }, pb.id, Date.now(), { pagePub: faker.pub });
    assert.equal((await cb.gate.live(ban, pb.id)).why, 'card');
    x.publish(CMD_TOPIC, JSON.stringify(await makeEnvelope(keys.sign, 'kick', {}, pb.id, Date.now(), { pagePub: faker.pub })));
    await sleep(300);
    assert.deepEqual(cb.ran$, []);
    // aimed at her real card: it works
    assert.equal(real.pk, cb.pageKey.raw);
    await session.send('message', { text: 'ok' }, pb.id);
    await until(() => cb.ran$.length === 1, 3000, 'the real card');
  } finally {
    if (session) session.close();
    for (const c of [ca, cb]) c.stop();
    for (const p of [pa, pb]) p.stop();
    x.close();
    useBrokers(null);
    await b.stop();
  }
});

test('faked cards: one that its page put right at once still marks the row (the card before the current one is opened too)', async () => {
  const { cfg, keys, pubs } = await shared;
  const real = await newBoxKey(), faker = await newBoxKey();
  const card = (name, pk) => ({ id: 'victim000001', name, level: 1, account: 'guest', mode: '', phase: 'lobby', party: null, v: '2', since: 1, pk });
  const now = await sealToAdmin(pubs.boxPub, card('Mia', real.raw)), prev = await sealToAdmin(pubs.boxPub, card('BadWordsGuy', faker.raw));
  let list = [{ id: 'victim000001', s: 'l', a: now, prev: null, at: Date.now() }];
  const presence = { id: 'admin0000001', counts: { total: 2, inMatch: 0, inLobby: 2 }, onCards: () => () => {}, cards: () => list };
  const session = new AdminSession({ presence, adminClient: null }, { cfg, pubs, keys });
  try {
    await until(() => session.players().length === 1, 3000, 'the card');
    assert.equal(session.players()[0].suspect, false, 'one card, one key: nothing to see');
    // a re-seal by the same page (same key) is not suspicious
    list = [{ ...list[0], a: await sealToAdmin(pubs.boxPub, card('Mia', real.raw)), prev: now }];
    await session.refresh();
    assert.equal(session.players()[0].suspect, false);
    // a fake that was there only for a moment
    list = [{ ...list[0], a: now, prev }];
    await session.refresh();
    assert.equal(session.players()[0].name, 'Mia');
    assert.equal(session.players()[0].suspect, true);
  } finally {
    session.close();
  }
});

test('admin states: the banner reaches pages online and pages that open later, goes when cleared, and an old one replayed never comes back', async () => {
  const { cfg, keys, pubs, otherKeys } = await shared;
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const pa = new Presence({ ...FAST }), pb = new Presence({ ...FAST });
  const A = fakeApp(pa, 'Philip'), B = fakeApp(pb, 'Mia');
  const ca = quietClient(A, cfg, pubs), cb = quietClient(B, cfg, pubs);
  let pc = null, cc = null;
  const x = await poker(b);
  const session = new AdminSession(A, { cfg, pubs, keys });
  A.admin = session;
  try {
    ca.start(); cb.start();
    pa.start(); pb.start();
    await until(() => pa.online && pb.online, 6000);
    const first = await session.sendState('banner', { text: 'Pizza party at 5!', minutes: 30 });
    assert.ok(first);
    await until(() => B.banner && B.banner.text === 'Pizza party at 5!', 3000, 'banner on Mia\'s page');
    assert.ok(B.banner.until > Date.now() + 29 * 60000 && B.banner.until <= Date.now() + 30 * 60000);
    assert.equal(A.banner.text, 'Pizza party at 5!', 'the admin sees it too');
    assert.deepEqual(session.state().banner, { text: 'Pizza party at 5!', id: first.args.id, until: first.args.until });
    // a page opened later gets it from the broker (retained)
    pc = new Presence({ ...FAST });
    const C = fakeApp(pc, 'Sam');
    cc = quietClient(C, cfg, pubs);
    cc.start();
    pc.start();
    await until(() => C.banner && C.banner.text === 'Pizza party at 5!', 3000, 'banner for a newcomer');
    // maintenance on: every page hears it
    await session.sendState('maintenance', { on: true, text: 'New map coming', hours: 2 });
    await until(() => cb.maint$ && cb.maint$.text === 'New map coming' && cc.maint$, 3000, 'maintenance');
    // cleared
    await sleep(5);
    await session.sendState('banner', { text: '' });
    await until(() => B.banner === null && C.banner === null, 3000, 'banner cleared');
    await session.sendState('maintenance', { on: false });
    await until(() => cb.maint$ === null, 3000, 'maintenance off');
    // someone replays the old banner (signed, but older than the one in force): nothing changes
    x.publish(STATE_PREFIX + 'banner', JSON.stringify(first), { retain: true });
    x.publish(STATE_PREFIX + 'banner', JSON.stringify(await makeEnvelope(otherKeys.sign, 'banner', { text: 'FAKE', id: 'f' }, '*')), { retain: true });
    x.publish(STATE_PREFIX + 'maintenance', '', { retain: true }); // an empty retained message: no state
    await sleep(300);
    assert.equal(B.banner, null);
    assert.equal(cb.stateNow().maintenance, null);
  } finally {
    session.close();
    for (const c of [ca, cb, cc]) if (c) c.stop();
    for (const p of [pa, pb, pc]) if (p) p.stop();
    x.close();
    useBrokers(null);
    await b.stop();
  }
});

/** A Map-backed localStorage / sessionStorage stand-in. */
function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test("replayed old states: a device never goes back to an older one (after a reload too), and the admin's page puts his newest back on the broker", async () => {
  const { cfg, keys, pubs } = await shared;
  const b = await startBroker();
  useBrokers([{ url: b.url }]);
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = memStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  const pa = new Presence({ ...FAST }), pb = new Presence({ ...FAST });
  const A = fakeApp(pa, 'Philip'), B = fakeApp(pb, 'Mia');
  const ca = quietClient(A, cfg, pubs), cb = quietClient(B, cfg, pubs);
  const session = new AdminSession(A, { cfg, pubs, keys });
  A.admin = session;
  let pc = null, cc = null;
  const x = await poker(b);
  try {
    ca.start(); cb.start(); pa.start(); pb.start();
    await until(() => pa.online && pb.online, 6000);
    const on = await session.sendState('maintenance', { on: true, text: 'fixing', hours: 2 });
    await until(() => cb.maint$ && cb.maint$.text === 'fixing', 3000, 'maintenance on');
    await sleep(5);
    const off = await session.sendState('maintenance', { on: false });
    await until(() => cb.maint$ === null, 3000, 'maintenance off');
    assert.deepEqual(JSON.parse(store.getItem('phortnite.adminState')).maintenance, { ts: off.ts, n: off.n }, 'the newest one this device took, kept');
    // a reloaded page on this device (same localStorage) never takes the older 'on' again
    const fresh = quietClient(fakeApp({ id: 'reloaded0001' }, 'Mia'), cfg, pubs);
    await fresh.onState(JSON.stringify(on), STATE_PREFIX + 'maintenance');
    assert.equal(fresh.stateNow().maintenance, null);
    // someone puts the old 'on' back on the broker (retained): the admin's page answers with his newest
    x.publish(STATE_PREFIX + 'maintenance', JSON.stringify(on), { retain: true });
    await until(() => b.retained.get(STATE_PREFIX + 'maintenance').toString() === JSON.stringify(off), 3000, 'the newest one back');
    // so a page that opens later (another device) gets 'off'
    pc = new Presence({ ...FAST });
    const C = fakeApp(pc, 'Sam');
    store.m.clear(); // (another device: nothing remembered)
    cc = quietClient(C, cfg, pubs);
    cc.start();
    pc.start();
    await until(() => cc.states.maintenance, 3000, 'a state for the newcomer');
    assert.equal(cc.states.maintenance.n, off.n);
    assert.equal(cc.stateNow().maintenance, null);
  } finally {
    session.close();
    for (const c of [ca, cb, cc]) if (c) c.stop();
    for (const p of [pa, pb, pc]) if (p) p.stop();
    x.close();
    useBrokers(null);
    await b.stop();
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
});

test("a command for everyone signed before the page started (a replayed 'reload everyone') is ignored; a reloaded tab remembers the ones it ran", async () => {
  const { cfg, keys, pubs } = await shared;
  const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: memStorage(), configurable: true, writable: true });
  try {
    const reload = await makeEnvelope(keys.sign, 'reload', {}, '*', Date.now() - 5000);
    const c1 = quietClient(fakeApp({ id: 'page00000001' }, 'Mia'), cfg, pubs);
    c1.since = Date.now() - 10000; // (this page started before it was sent)
    await c1.onCmd(JSON.stringify(reload));
    assert.equal(c1.ran$.length, 1, 'carried out once');
    // the page reloads: a new client (new presence id) hears the same reload replayed
    const c2 = quietClient(fakeApp({ id: 'page00000002' }, 'Mia'), cfg, pubs);
    await c2.onCmd(JSON.stringify(reload));
    assert.equal(c2.ran$.length, 0, 'signed before this page started');
    c2.since = 0; // (even with a clock that is off: this tab ran that one already)
    await c2.onCmd(JSON.stringify(reload));
    assert.equal(c2.ran$.length, 0);
    const msg = await makeEnvelope(keys.sign, 'message', { text: 'new' }, '*');
    await c2.onCmd(JSON.stringify(msg));
    assert.equal(c2.ran$.length, 1, 'a new one still works');
  } finally {
    if (had) Object.defineProperty(globalThis, 'sessionStorage', had); else delete globalThis.sessionStorage;
  }
});

// ------------------------------------------------------------------ party commands on the host's room

test("party commands: the host's room ends, pauses and changes the mode; members check the admin really said so, for their party", async () => {
  const { cfg, keys, pubs, otherKeys } = await shared;
  const H = makeRoom();
  const host = H.join('Host');
  const mem = H.join('Mia');
  const CODE = H.room.code;
  let paused = false;
  const net = { room: H.room, kind: 'p2p-host', pause() { paused = true; }, clock: { get paused() { return paused; }, resume() { paused = false; return 1500; } } };
  const hostGame = { net, roster: new Map(), settingsState: H.room.settings, phase: 'lobby', code: CODE };
  const hostApp = fakeApp({ id: 'hostpage0001' }, 'Host', { game: hostGame, partyKind: () => 'p2p-host', unpause() { hostApp.paused = false; } });
  const hc = new AdminClient(hostApp, cfg, pubs);
  hostApp.adminClient = hc;
  hc.chip = () => {};
  hc.pageKey = await newBoxKey();
  hc.gate.pageKey = hc.pageKey.priv;
  const memGame = { disposed: false, code: CODE };
  const memApp = fakeApp({ id: 'mempage00001' }, 'Mia', { game: memGame, partyKind: () => 'p2p', unpause() { memApp.paused = false; } });
  const mc = new AdminClient(memApp, cfg, pubs);
  memApp.adminClient = mc;
  mc.chip = () => {};
  // what the admin's panel sends to the host's page: sealed to its key, the party code from its card
  const cmd = (name, args = {}, code = CODE, k = keys.sign) => makeEnvelope(k, name, { ...args, code }, 'hostpage0001', Date.now(), { pagePub: hc.pageKey.pub });
  const run = async (env) => {
    const r = await hc.gate.live(env, 'hostpage0001');
    assert.ok(r.ok, r.why);
    hc.run(r.env, r.raw);
  };
  const toRoomNotes = async () => {
    for (const m of mem.inbox.splice(0)) if (m.t === 'admin') await mc.onRoomMessage(m, memGame);
  };
  try {
    // SET MODE (lobby): the room's own settings path; the member hears it was the admin
    const mode = await cmd('mode', { modeId: 'zb-solo' });
    await run(mode);
    assert.equal(H.room.settings.modeId, 'zb-solo');
    assert.ok(H.last(mem, 'settings'), 'everyone got the new settings');
    assert.deepEqual(H.last(mem, 'admin').env, mode, 'the party hears the envelope as signed');
    await toRoomNotes();
    assert.match(memApp.toasts.pop(), /The admin changed the mode/);
    assert.match(hostApp.toasts.pop(), /The admin changed the mode/);
    assert.equal(H.room.pickMode('no-such-mode'), false);
    // a host can't make one up: a note signed with another key (or changed) is not shown
    const fake = await cmd('end', {}, CODE, otherKeys.sign);
    await mc.onRoomMessage({ t: 'admin', env: fake }, memGame);
    await mc.onRoomMessage({ t: 'admin', env: { ...mode, n: randomNonce(), args: { ...mode.args, modeId: 'solo' } } }, memGame);
    // nor pass on one the admin meant for another party (all commands cross the public broker)
    const elsewhere = await makeEnvelope(keys.sign, 'pause', { on: true, code: 'ZZZZ' }, 'otherhost000', Date.now(), { pagePub: (await newBoxKey()).pub });
    await mc.onRoomMessage({ t: 'admin', env: elsewhere }, memGame);
    assert.equal(memApp.adminPaused, undefined);
    assert.equal(memApp.toasts.length, 0);
    assert.equal(await partyNote(pubs.signPub, elsewhere, CODE), null);
    assert.deepEqual(await partyNote(pubs.signPub, elsewhere, 'ZZZZ'), { on: true, code: 'ZZZZ' }, "(that party's members do see it)");
    // and the host's page only runs one for its own party
    await run(await cmd('mode', { modeId: 'solo' }, 'ZZZZ'));
    assert.equal(H.room.settings.modeId, 'zb-solo', 'aimed at another party: ignored');
    // a match: PAUSE stops the host's room clock and freezes everyone; RESUME starts it again
    H.send(host, { t: 'start' });
    assert.notEqual(H.room.phase, 'lobby');
    hostGame.phase = H.room.phase;
    await run(await cmd('pause', { on: true }));
    assert.equal(paused, true);
    assert.equal(hostApp.paused, true);
    assert.equal(hostApp.adminPaused, true);
    await toRoomNotes();
    assert.equal(memApp.adminPaused, true, 'the member waits too');
    assert.match(memApp.toasts.pop(), /paused the match/);
    await run(await cmd('pause', { on: false }));
    assert.equal(paused, false);
    assert.equal(hostApp.adminPaused, false);
    await toRoomNotes();
    assert.equal(memApp.adminPaused, false);
    // END: everyone back to the lobby
    await run(await cmd('end'));
    assert.equal(H.room.phase, 'lobby');
    assert.ok(H.last(mem, 'lobby'));
    await toRoomNotes();
    assert.match(memApp.toasts.pop(), /The admin ended the match/);
    // the admin removes the host: the party hears it first (else only "Host's party ended")
    const kick = await cmd('kick', { reason: 'Mean words' });
    const r = await hc.gate.live(kick, 'hostpage0001');
    hc.tellParty(r.raw);
    assert.ok(!JSON.stringify(H.last(mem, 'admin')).includes('Mean words'), 'the reason stays sealed');
    await toRoomNotes();
    assert.match(memApp.toasts.pop(), /removed the host/);
    // a member's page has no room: party commands sent to it do nothing
    const before = memApp.toasts.length;
    mc.partyCmd({ cmd: 'end', n: randomNonce(), args: { code: CODE } });
    assert.equal(memApp.toasts.length, before);
    assert.deepEqual(H.errors, []);
  } finally {
    hc.stop();
    mc.stop();
  }
});

test('admin XP and stats: GIVE XP rolls levels over like match XP; RESET STATS starts again', () => {
  const s = defaultStats();
  assert.equal(addXp(s, 100), 0);
  assert.equal(s.xp, 100);
  const up = addXp(s, xpForLevel(1) + xpForLevel(2));
  assert.equal(up, 2);
  assert.equal(s.level, 3);
  assert.equal(s.xp, 100);
  assert.equal(s.total, 100 + xpForLevel(1) + xpForLevel(2));
  assert.equal(s.matches, 0, 'not a match');
  assert.equal(addXp(s, -50), 0);
  assert.equal(s.total, 100 + xpForLevel(1) + xpForLevel(2));
});

test('observer hellos (stage E): a party host lets in only an admin-signed observe for its own code', async () => {
  const { keys, pubs, otherKeys } = await shared;
  const check = makeObserverCheck(pubs.signPub);
  const ok = await makeEnvelope(keys.sign, 'observe', { code: 'ABCD' }, '*');
  assert.equal(await check(ok, 'WXYZ'), false, 'another party');
  assert.equal(await check(ok, 'ABCD'), true);
  assert.equal(await check(ok, 'ABCD'), false, 'each signed hello lets one connection in: one copied off the relay is worth nothing');
  assert.equal(await check(await makeEnvelope(keys.sign, 'observe', { code: 'ABCD' }, '*'), 'ABCD'), true, 'a freshly signed one (a rejoin)');
  assert.equal(await check(await makeEnvelope(otherKeys.sign, 'observe', { code: 'ABCD' }, '*'), 'ABCD'), false);
  assert.equal(await check(await makeEnvelope(keys.sign, 'observe', { code: 'ABCD' }, '*', Date.now() - MAX_AGE - 1000), 'ABCD'), false);
  assert.equal(await check({ name: 'Admin' }, 'ABCD'), false);
  const many = makeObserverCheck(pubs.signPub, { once: false });
  assert.equal(await many(ok, 'ABCD'), true);
  assert.equal(await many(ok, 'ABCD'), true);
});

// ------------------------------------------------------------------ the ban, in the lock screen's format

/** lock.js's own helpers (between "helpers" and "end of helpers"), run here with stand-ins. */
function lockHelpers({ storage = {}, cookie = '' } = {}) {
  const part = /\/\/ -+ helpers\n[\s\S]*?\/\/ -+ end of helpers/.exec(fs.readFileSync(LOADER, 'utf8'))[0];
  const localStorage = { getItem: (k) => (k in storage ? storage[k] : null) };
  return new Function('localStorage', 'document', 'crypto', `'use strict';\n${part}\nreturn { STRIKES, BAN, COOKIE, BANBY, parseBan, formatBan, isBanned, readSync, siteFolder, banBy, banLine };`)(localStorage, { cookie }, globalThis.crypto);
}

/** A small in-memory IndexedDB (open / transaction / get / put / delete), async like the real one. */
function fakeIndexedDB() {
  const dbs = new Map();
  return {
    dbs,
    open(name) {
      const req = {};
      setTimeout(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) { db = new Map(); dbs.set(name, db); }
        req.result = {
          close() {},
          createObjectStore(s) { db.set(s, new Map()); },
          transaction(storeName) {
            const data = db.get(storeName);
            if (!data) throw new Error('NotFoundError');
            const tx = {};
            let pending = 0;
            const job = (fn) => {
              pending++;
              const r = {};
              setTimeout(() => {
                r.result = fn();
                if (r.onsuccess) r.onsuccess();
                if (--pending === 0) setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              }, 0);
              return r;
            };
            tx.objectStore = () => ({ get: (k) => job(() => data.get(k)), put: (v, k) => job(() => { data.set(k, v); return k; }), delete: (k) => job(() => { data.delete(k); }) });
            return tx;
          },
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

test("admin ban: written into all three of the lock screen's stores, in its format: lock.js and the page's <head> read it as banned", async () => {
  // the same names and threshold as the lock screen and tools/lock.mjs
  const L = lockHelpers();
  assert.equal(ban.STRIKES, L.STRIKES);
  assert.equal(ban.STRIKES, LOCK_STRIKES);
  assert.equal(ban.BAN_KEY, L.BAN);
  assert.equal(ban.BAN_KEY, LOCK_BAN_KEY);
  assert.equal(ban.BAN_COOKIE, L.COOKIE);
  assert.equal(ban.BAN_COOKIE, LOCK_BAN_COOKIE);
  assert.match(fs.readFileSync(LOADER, 'utf8'), /var IDB = 'phortnite-lock'; \/\/ IndexedDB database: object store 'kv', the record under 'ban'/);
  assert.equal(ban.BAN_IDB, 'phortnite-lock');
  for (const p of ['/', '/jojo-relay/', '/jojo-relay/index.html', '/jojo-relay/beta/', '/jojo-relay/beta/index.html']) assert.equal(ban.siteFolder(p), L.siteFolder(p), p);
  for (const s of ['', '3.0.0', '1.2.99999', 'x.y', '7']) assert.deepEqual(ban.parseBan(s), L.parseBan(s), s);

  // a device with one wrong password and a running unban lock-out: the ban keeps the lock-out
  const storage = new Map([[ban.BAN_KEY, '1.0.0']]);
  const cookies = [];
  const idb = fakeIndexedDB();
  const env = {
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    document: { get cookie() { return 'other=1; phortnite_ban=0.2.99999999999999'; }, set cookie(v) { cookies.push(v); } },
    location: { protocol: 'https:', pathname: '/jojo-relay/beta/index.html' },
    indexedDB: idb,
  };
  const b = await ban.writeBan(env, { reason: 'Mean words in chat' });
  assert.deepEqual(b, { strikes: ban.STRIKES, tries: 2, until: 99999999999999 });
  // who banned it: the lock screen's ban screen says the admin did, and why (not "too many wrong passwords")
  assert.equal(ban.BAN_BY, L.BANBY);
  const by = lockHelpers({ storage: { [ban.BAN_BY]: storage.get(ban.BAN_BY) } });
  assert.deepEqual(by.banBy(), { reason: 'Mean words in chat' });
  assert.match(by.banLine(by.banBy()), /^The admin banned this device \(“Mean words in chat”\)\. Ask Philip/);
  assert.equal(L.banBy(), null);
  assert.match(L.banLine(L.banBy()), /Too many wrong passwords/, 'three wrong passwords: the lock\'s own words');
  assert.deepEqual(ban.readBanBy(env), { by: 'admin', reason: 'Mean words in chat' }, "the game's own ban screen (no lock) shows the reason too");
  assert.match(fs.readFileSync(LOADER, 'utf8'), /if \(clear\) localStorage\.removeItem\(BANBY\)/, "Philip's unban code lifts the note with the ban");
  // localStorage + cookie: what lock.js's readSync and the <head> check read
  const written = storage.get(ban.BAN_KEY);
  assert.equal(cookies.length, 1);
  const [pair, ...attrs] = cookies[0].split('; ');
  assert.equal(pair, `phortnite_ban=${written}`);
  assert.ok(attrs.includes('Path=/jojo-relay/'), 'on the site\'s top folder (beta/ too)');
  assert.ok(attrs.includes('Secure') && attrs.includes('SameSite=Lax') && attrs.some((a) => /^Max-Age=\d{9}$/.test(a)));
  const fromLocal = lockHelpers({ storage: { [ban.BAN_KEY]: written } });
  assert.equal(fromLocal.isBanned(fromLocal.readSync()), true, 'lock.js: banned (localStorage)');
  const fromCookie = lockHelpers({ cookie: `a=b; ${pair}` });
  assert.equal(fromCookie.isBanned(fromCookie.readSync()), true, 'lock.js: banned (cookie)');
  // the page's first-frame check in the locked index.html
  const head = (storageObj, cookie) => {
    const classes = new Set();
    const ls = { getItem: (k) => (k in storageObj ? storageObj[k] : null) };
    const doc = { cookie, documentElement: { classList: { add: (c) => classes.add(c) } } };
    new Function('localStorage', 'document', 'location', 'PublicKeyCredential', /^<script>([\s\S]*)<\/script>$/.exec(HEAD_SCRIPT)[1])(ls, doc, { pathname: '/jojo-relay/' }, undefined);
    return [...classes];
  };
  assert.deepEqual(head({ [ban.BAN_KEY]: written }, ''), ['ls-banned']);
  assert.deepEqual(head({}, pair), ['ls-banned']);
  // IndexedDB: lock.js's database, store and key
  const rec = idb.dbs.get('phortnite-lock').get('kv').get('ban');
  assert.equal(L.isBanned(L.parseBan(rec)), true, 'lock.js: banned (IndexedDB)');
  assert.equal(rec, written);
  // and our own reading of the stores agrees (the dev build's ban overlay)
  assert.equal(ban.isBanned(await ban.readBan(env)), true);
  assert.equal(ban.isBanned(ban.readBanSync({ localStorage: null, document: { cookie: '' } })), false);
  // with storage blocked the ban still lands where it can (and never throws)
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  const b2 = await ban.writeBan({ localStorage: throwing, document: { cookie: '', set cookie(v) { throw new Error('no'); } }, location: { protocol: 'http:', pathname: '/' }, indexedDB: null });
  assert.equal(ban.isBanned(b2), true);
  assert.equal(ban.banCookie('3.0.0', { protocol: 'http:', pathname: '/x/y.html' }), 'phortnite_ban=3.0.0; Max-Age=315360000; Path=/x/; SameSite=Lax');
});

// ------------------------------------------------------------------ stage E: the admin watching a party

test('room observers: a verified observer is not a player (no roster row, not counted, never spawns, no team) but hears the match; everyone is told; unverified ones are refused', async () => {
  const { keys } = await shared;
  const H = makeRoom({ maxHumans: 2 });
  const a = H.join('Ann'), b = H.join('Ben');
  const env = await makeEnvelope(keys.sign, 'observe', { code: 'TEST' }, '*');
  const hello = { name: 'Admin', skin: 0, v: PROTOCOL, observer: env };
  // the Node server's path (no verified flag) and a transport that said no: refused
  const n1 = H.conn();
  assert.equal(H.room.join(n1, hello), false);
  assert.match(H.last(n1, 'err').msg, /Only the admin/);
  const n2 = H.conn();
  assert.equal(H.room.join(n2, hello, { observer: false }), false);
  assert.equal(H.room.observers.size, 0);
  // verified: in, although the party is full (2 of 2)
  const ob = H.conn();
  assert.equal(H.room.join(ob, hello, { observer: true }), true);
  const w = H.last(ob, 'welcome');
  assert.equal(w.observer, true);
  assert.ok(w.you < 0, 'a negative id: never a player id');
  assert.equal(w.obs, 1);
  assert.deepEqual(w.players.map((p) => p.name).sort(), ['Ann', 'Ben'], 'not in the roster');
  assert.equal(H.room.humans().length, 2, 'not counted toward the party size');
  assert.equal(H.room.publicInfo('').players, 2);
  assert.deepEqual(H.last(a, 'obs'), { t: 'obs', n: 1 }, 'the party hears the admin is watching');
  assert.deepEqual(H.last(b, 'obs'), { t: 'obs', n: 1 });
  assert.equal(H.msgs(a, 'note').some((m) => /Admin/.test(m.msg)), false, 'no "joined the party" note: not a player');
  // the full party still turns a player away
  const c = H.join('Cat');
  assert.equal(c.ok, false);
  // a match: the observer never spawns and is on no team, but gets the start, snapshots and events
  H.send(a, { t: 'start', bots: 0 });
  const st = H.last(ob, 'start');
  assert.ok(st, 'the observer hears the start');
  assert.deepEqual(st.players.map((p) => p.name).sort(), ['Ann', 'Ben']);
  assert.ok(!(st.teams || []).some((t) => (t.members || []).includes(w.you)));
  for (const lo of st.lo || []) assert.ok(!lo[1].includes(w.you), 'no loadout');
  if (st.spawns) assert.ok(!(String(w.you) in st.spawns));
  H.advance(500);
  const snap = H.last(ob, 's');
  assert.ok(snap, 'snapshots');
  assert.ok(!snap.p.some((row) => row[0] === w.you), 'never in a snapshot');
  assert.ok(![...H.room.players.keys()].includes(w.you));
  // an observer can't touch the match: start, end, moves, hits, builds, chat… all ignored; ping answered
  const phase = H.room.phase;
  for (const m of [{ t: 'end' }, { t: 'start' }, { t: 'u', s: [0, 50, 0, 0, 0, 0, 0, 0, 0, 'ar', 0] }, { t: 'hit', id: w.you, tg: a.pid, w: 'ar', d: 5, n: 1 }, { t: 'kick', id: b.pid }, { t: 'b', k: '1,1,1,w', m: 'wood' }]) H.send(ob, m);
  assert.equal(H.room.phase, phase);
  assert.equal(H.room.humans().length, 2);
  H.send(ob, { t: 'ping', c: 42 });
  assert.equal(H.last(ob, 'pong').c, 42);
  // a newcomer's welcome says someone is watching (a reload mid-match too)
  const H2 = makeRoom();
  H2.join('Dan');
  const ob2 = H2.conn();
  H2.room.join(ob2, hello, { observer: true });
  const e = H2.join('Eve');
  assert.equal(H2.last(e, 'welcome').obs, 1);
  // at most MAX_OBSERVERS (2)
  const o3 = H2.conn(), o4 = H2.conn();
  assert.equal(H2.room.join(o3, hello, { observer: true }), true);
  assert.equal(H2.room.join(o4, hello, { observer: true }), false);
  // the observer leaves: everyone hears nobody is watching
  H.leave(ob);
  assert.deepEqual(H.last(a, 'obs'), { t: 'obs', n: 0 });
  assert.equal(H.room.observers.size, 0);
  assert.equal(H.room.humans().length, 2, 'the players are untouched');
  assert.deepEqual(H.errors, []);
  assert.deepEqual(H2.errors, []);
});

test('room observers: whom the observer watches reaches the device running the bots', async () => {
  const { keys } = await shared;
  const H = makeRoom();
  const a = H.join('Ann');
  const ob = H.conn();
  H.room.join(ob, { name: 'Admin', v: PROTOCOL, observer: await makeEnvelope(keys.sign, 'observe', { code: 'TEST' }, '*') }, { observer: true });
  const you = H.last(ob, 'welcome').you;
  H.send(a, { t: 'start', bots: 3 });
  const bot = H.bots()[0];
  H.send(ob, { t: 'watch', id: bot.id });
  assert.deepEqual(H.last(a, 'watch'), { t: 'watch', from: you, id: bot.id });
  H.send(ob, { t: 'watch', id: a.pid }); // a human: nothing for the bots' device to keep
  assert.deepEqual(H.last(a, 'watch'), { t: 'watch', from: you, id: 0 });
  H.send(ob, { t: 'watch', id: bot.id });
  H.leave(ob);
  assert.deepEqual(H.last(a, 'watch'), { t: 'watch', from: you, id: 0 }, 'gone: watches nobody');
  assert.deepEqual(H.errors, []);
});

// P2P links in memory (WebRTC does not run here): the same stand-in for PeerJS as test/party.test.mjs
const PEERS = new Map();
let anonPeer = 0;
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
    this.id = id || `anon${++anonPeer}`;
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
const p2pHello = (name, extra = {}) => ({ name, skin: 1, v: PROTOCOL, resume: '', ...extra });
function inbox(net) {
  const box = [];
  net.onMessage((m) => box.push(m));
  box.last = (t) => { for (let i = box.length - 1; i >= 0; i--) if (box[i].t === t) return box[i]; return null; };
  return box;
}

test("P2P observer: the host's page lets the admin watch only with a hello the admin signed for its party", async () => {
  const { keys, pubs, otherKeys } = await shared;
  usePeer(FakePeer);
  useBrokers([]); // direct links only (relay.test.mjs covers the relay)
  const nets = [];
  const join = async (code, hello) => {
    const c = new P2PClient(code, hello);
    nets.push(c);
    const box = inbox(c);
    await c.connect();
    await until(() => box.last('welcome') || box.last('err'), 4000, 'an answer');
    return box;
  };
  const host = new P2PHost(p2pHello('Host'), { verifyObserver: makeObserverCheck(pubs.signPub) });
  const plain = new P2PHost(p2pHello('Old'));
  try {
    const hb = inbox(host);
    await host.connect();
    await until(() => hb.last('welcome'));
    const mia = await join(host.code, p2pHello('Mia'));
    assert.ok(mia.last('welcome'));
    // the admin, signed for this party: in as an observer
    const adminHello = p2pHello('Admin', { observer: await makeEnvelope(keys.sign, 'observe', { code: host.code }, '*') });
    const obs = await join(host.code, adminHello);
    const w = obs.last('welcome');
    assert.equal(w && w.observer, true);
    assert.equal(host.room.humans().length, 2, 'Host and Mia: the admin is not a player');
    assert.equal(host.room.observers.size, 1);
    await until(() => mia.last('obs'));
    assert.deepEqual(mia.last('obs'), { t: 'obs', n: 1 }, "Mia's page shows 'Admin is watching'");
    await until(() => hb.last('obs'));
    // it hears the match like a spectator
    host.send({ t: 'start', bots: 0 });
    await until(() => obs.last('start') && obs.last('s'), 4000, 'start + snapshots');
    assert.ok(!obs.last('s').p.some((row) => row[0] === w.you));
    // signed for another party, signed with another key, or not signed at all: refused
    const other = await join(host.code, p2pHello('Admin', { observer: await makeEnvelope(keys.sign, 'observe', { code: 'ZZZZ' }, '*') }));
    assert.match(other.last('err').msg, /Only the admin/);
    const forged = await join(host.code, p2pHello('Admin', { observer: await makeEnvelope(otherKeys.sign, 'observe', { code: host.code }, '*') }));
    assert.match(forged.last('err').msg, /Only the admin/);
    const junk = await join(host.code, p2pHello('Admin', { observer: { cmd: 'observe' } }));
    assert.match(junk.last('err').msg, /Only the admin/);
    // the admin's own hello, copied (over the relay it crosses the public broker in the clear): used up
    const copied = await join(host.code, adminHello);
    assert.match(copied.last('err').msg, /Only the admin/);
    assert.equal(host.room.observers.size, 1);
    assert.equal(host.room.humans().length, 2);
    // a host without the admin's key (no admin.json): every observer is refused
    await plain.connect();
    const none = await join(plain.code, p2pHello('Admin', { observer: await makeEnvelope(keys.sign, 'observe', { code: plain.code }, '*') }));
    assert.match(none.last('err').msg, /Only the admin/);
    assert.equal(plain.room.observers.size, 0);
    // the observer's link drops (a Wi-Fi blip): it rejoins with its signed hello and is let in again
    const obsHello = p2pHello('Admin', { observer: await makeEnvelope(keys.sign, 'observe', { code: host.code }, '*') });
    nets[1].rejoin = () => ({ t: 'join', hello: obsHello });
    host.dcById.get([...host.room.observers.keys()][0]).close();
    await until(() => obs.some((m) => m.t === '_net' && m.state === 'reconnecting'), 4000, 'reconnecting');
    await until(() => obs.some((m) => m.t === '_net' && m.state === 'fresh'), 8000, 'a fresh welcome');
    assert.equal(obs.find((m) => m.t === '_net' && m.state === 'fresh').msg.observer, true);
    assert.equal(host.room.observers.size, 1);
    assert.equal(host.room.humans().length, 2);
    // the admin stops watching: Mia's chip goes
    nets[1].close();
    await until(() => mia.last('obs') && mia.last('obs').n === 0, 4000, 'nobody watching');
    assert.equal(host.room.observers.size, 0);
  } finally {
    for (const n of nets) n.close(false);
    host.close();
    plain.close();
    useBrokers(null);
    await sleep(400);
  }
});

test("the 'Admin is watching' chip: on while the room says someone watches, off when they go; never on the admin's own watching page", () => {
  const chips = [];
  const app = { adminClient: { chip: (k, t) => chips.push([k, t]), onRoomMessage() {}, setPaused() {} } };
  const g = { app, observer: false };
  const n = new AdminNotes(g);
  n.onMessage({ t: 'welcome', obs: 1 });
  assert.deepEqual(chips.pop(), ['watch', '👁 Admin is watching']);
  assert.equal(g.watchedBy, 1);
  n.onMessage({ t: 'obs', n: 2 });
  n.onMessage({ t: 'obs', n: 0 });
  assert.deepEqual(chips.pop(), ['watch', null]);
  n.onMessage({ t: 'resumed', obs: 1 });
  assert.deepEqual(chips.pop(), ['watch', '👁 Admin is watching']);
  n.dispose();
  assert.deepEqual(chips.pop(), ['watch', null], 'a party left: the chip goes');
  // the admin's own page (the observer) has its own bar instead
  chips.length = 0;
  const watchCalls = [];
  const og = { app: { ...app, adminWatch: { onMessage: (m) => watchCalls.push(m.t), frame() {}, bar() {} } }, observer: true };
  const on = new AdminNotes(og);
  on.onMessage({ t: 'welcome', obs: 1, observer: true });
  on.onMessage({ t: 'partyend' });
  assert.equal(chips.length, 0);
  assert.deepEqual(watchCalls, ['welcome', 'partyend']);
  // a watching admin's card says so
  assert.deepEqual(cleanCard({ id: 'abc123', name: 'Admin', party: { code: 'ABCD', kind: 'watch', size: 3 } }).party, { code: 'ABCD', kind: 'watch', size: 3 });
});
