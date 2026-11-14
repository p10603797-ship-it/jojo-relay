// The locked website (tools/lock.mjs): passwords, key slots, the encrypted build and the loader.
// Slots here use 1,000 PBKDF2 rounds so the tests are quick; real ones use 600,000.
// Every password in this file is made up for the tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { webcrypto, pbkdf2Sync, hkdfSync, createDecipheriv } from 'node:crypto';
import { parse as lexModule, init as lexInit } from 'es-module-lexer';
import {
  ALPHABET, ITERATIONS, PREFIX, PUBLIC_DIR, ROOT, LockError, normalize, isValidPassword, generatePassword, generatePasswords,
  makeSlots, newSlots, unlockSlots, addSlots, removeSlot, buildLocked as buildLockedStrict, openArchive, rewriteModule, ready, lockIndexHtml,
  collectModules, STORE_EXPR, FACE_EXPR, HEAD_SCRIPT, STRIKES, BAN_KEY, BAN_COOKIE, UNBAN_LENGTH, generateUnbanCode, makeUnban, checkUnban,
  setUnban, checkStrength,
} from '../tools/lock.mjs';

const ITER = 1000;
const TOOL = path.join(ROOT, 'tools', 'lock.mjs');
const LOADER = path.join(ROOT, 'tools', 'lockscreen', 'lock.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `phortnite-lock-${name}-`));
const randomKey = () => webcrypto.getRandomValues(new Uint8Array(32));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const hex = (u8) => Buffer.from(u8).toString('hex');
const cli = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, PHORTNITE_PASSWORD: '', ...env } });
// the slots here have only ITER rounds: test builds must say so (a real build refuses them)
const buildLocked = (o) => buildLockedStrict({ allowWeak: true, ...o });

/**
 * lock.js's own helpers (the part between "helpers" and "end of helpers"), run here in Node with a
 * stand-in localStorage and document.cookie: the very code the browser runs.
 */
function loaderHelpers({ storage = {}, cookie = '', storageThrows = false } = {}) {
  const part = /\/\/ -+ helpers\n[\s\S]*?\/\/ -+ end of helpers/.exec(fs.readFileSync(LOADER, 'utf8'))[0];
  const localStorage = { getItem: (k) => { if (storageThrows) throw new Error('SecurityError'); return k in storage ? storage[k] : null; } };
  const document = { cookie };
  return new Function('localStorage', 'document', 'crypto', `'use strict';\n${part}\nreturn { STRIKES, UNBAN_TRIES, UNBAN_WAIT, BAN, COOKIE, CHARS, normalize, parseBan, formatBan, mergeBan, isBanned, siteFolder, readSync, unbanOk, current, clampLock, idbRecord,
    FACE_INFO, b64, b64url, unb64url, findSlot, faceAad, faceWrap, faceUnwrap, parseFace, prfFirst, prfEnabled, faceAvailable };`)(localStorage, document, webcrypto);
}

/** The page's <head> check (HEAD_SCRIPT) run with the same stand-ins: the classes it puts on <html>.
 *  `webauthn`: the browser has PublicKeyCredential. */
function headClasses({ storage = {}, cookie = '', storageThrows = false, pathname = '/jojo-relay/', webauthn = false } = {}) {
  const classes = new Set();
  const localStorage = { getItem: (k) => { if (storageThrows) throw new Error('SecurityError'); return k in storage ? storage[k] : null; } };
  const document = { cookie, documentElement: { classList: { add: (c) => classes.add(c) } } };
  const body = /^<script>([\s\S]*)<\/script>$/.exec(HEAD_SCRIPT)[1];
  new Function('localStorage', 'document', 'location', 'PublicKeyCredential', body)(localStorage, document, { pathname }, webauthn ? function PublicKeyCredential() {} : undefined);
  return [...classes];
}

function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r)); else out.push(r);
  }
  return out;
}

// one set of made-up passwords and a build shared by the build tests
const PASSWORDS = ['TESTAB23', 'TESTCD45', 'TESTEF67'];
const K0 = randomKey();
const shared = makeSlots(K0, PASSWORDS, { iter: ITER });

test('lock: passwords are 8 characters from the easy-to-read alphabet, 2+ letters and 2+ digits, from crypto random numbers', () => {
  assert.equal(ALPHABET.length, 32);
  for (const c of '0O1I') assert.ok(!ALPHABET.includes(c), `${c} is too easy to mix up`);
  const seen = new Set();
  const list = generatePasswords(3000);
  assert.equal(new Set(list).size, 3000, 'no repeats in a batch');
  for (const p of list) {
    assert.ok(isValidPassword(p), p);
    assert.match(p, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.ok(p.replace(/[^A-Z]/g, '').length >= 2 && p.replace(/[^0-9]/g, '').length >= 2, p);
    for (const c of p) seen.add(c);
  }
  assert.equal(seen.size, ALPHABET.length, 'every character turns up');
  assert.ok(isValidPassword(generatePassword()));
  for (const bad of ['ABCDEFGH', '2345678A', 'ABCD234O', 'ABCD2341', 'abcd2345', 'ABC2345', 'ABCD23456']) assert.equal(isValidPassword(bad), false, bad);
  // the system's secure random numbers, never Math.random
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /randomInt\(ALPHABET\.length\)/);
  assert.doesNotMatch(src, /Math\.random/);
  // what people type: any case, spaces and dashes are ignored
  assert.equal(normalize(' ab cd-23\u201345 '), 'ABCD2345');
  assert.equal(normalize('abcd 2345'), normalize('ABCD-2345'));
  assert.equal(ITERATIONS, 600000);
});

test('lock: every password opens the game key, a wrong one does not, and the slots hold no secrets', async () => {
  const { doc, passwords } = await shared;
  assert.deepEqual(passwords.map((p) => p.n), [1, 2, 3]);
  assert.equal(doc.iter, ITER);
  assert.equal(Buffer.from(doc.salt, 'base64').length, 16);
  for (const [i, p] of PASSWORDS.entries()) {
    const got = await unlockSlots(doc, p);
    assert.ok(got, p);
    assert.equal(got.n, i + 1);
    assert.deepEqual(got.K, K0);
  }
  assert.deepEqual((await unlockSlots(doc, 'test-ab 23')).K, K0, 'typed in lowercase with a dash');
  assert.equal(await unlockSlots(doc, 'TESTAB24'), null);
  assert.equal(await unlockSlots(doc, ''), null);
  const text = JSON.stringify(doc);
  for (const s of [...PASSWORDS, b64(K0), hex(K0)]) assert.ok(!text.includes(s), 'no password or key in the slots');
  assert.equal(new Set(doc.slots.map((s) => s.iv)).size, 3, 'every slot has its own IV');
  // a slot can't be moved to another number (its number is bound into the encryption)
  const moved = { ...doc, slots: [{ ...doc.slots[0], n: 9 }] };
  assert.equal(await unlockSlots(moved, PASSWORDS[0]), null);
});

test('lock: new, add and remove keep the other passwords working', async () => {
  const { doc, passwords, K } = await newSlots({ count: 3, iter: ITER });
  assert.equal(passwords.length, 3);
  for (const { password } of passwords) assert.ok(isValidPassword(password));
  const [p1, p2, p3] = passwords.map((p) => p.password);
  const added = await addSlots(doc, p2, 2);
  assert.deepEqual(added.doc.slots.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(added.passwords.map((p) => p.n), [4, 5]);
  assert.equal(added.doc.salt, doc.salt, 'same salt: one PBKDF2 per try on the iPad');
  for (const p of [p1, p2, p3, ...added.passwords.map((x) => x.password)]) assert.deepEqual((await unlockSlots(added.doc, p)).K, K, p);
  await assert.rejects(addSlots(doc, 'TESTXX99', 1), LockError, 'adding needs a working password');
  await assert.rejects(addSlots(doc, '', 1), LockError);
  assert.equal(doc.slots.length, 3, 'add does not change the original');

  const removed = removeSlot(added.doc, 2);
  assert.deepEqual(removed.slots.map((s) => s.n), [1, 3, 4, 5]);
  assert.equal(await unlockSlots(removed, p2), null, 'the removed password is off');
  for (const p of [p1, p3]) assert.deepEqual((await unlockSlots(removed, p)).K, K);
  const again = await addSlots(removed, p1, 1);
  assert.deepEqual(again.passwords.map((p) => p.n), [6], 'slot numbers are never reused');
  // ... not even the highest one, once it was removed: a number on Philip's list means one password
  const top = removeSlot(again.doc, 6);
  assert.deepEqual(top.slots.map((s) => s.n), [1, 3, 4, 5]);
  const after = await addSlots(top, p3, 2);
  assert.deepEqual(after.passwords.map((p) => p.n), [7, 8]);
  assert.equal(after.doc.next, 9);
  assert.deepEqual((await addSlots(removeSlot(removeSlot(after.doc, 8), 7), p1, 1)).passwords.map((p) => p.n), [9]);
  // an older slots file without the mark carries on after its highest slot
  const { next, ...old } = removed;
  assert.equal(next, 6);
  assert.deepEqual((await addSlots(old, p1, 1)).passwords.map((p) => p.n), [6]);
  assert.throws(() => removeSlot(removed, 2), LockError);
  assert.throws(() => removeSlot({ ...removed, slots: removed.slots.slice(0, 1) }, 1), LockError, 'never the last one');
});

test('lock: the module rewriter turns relative imports into @phortnite/ paths and refuses what it cannot lock', async () => {
  await ready();
  const known = new Set(['js/main.js', 'js/a/b.js', 'shared/c.js']);
  const src = [
    "import * as THREE from 'three';",
    "import { B } from './a/b.js';",
    'import { C } from "../shared/c.js";',
    "export { D } from './a/b.js';",
    "export * from '../shared/c.js';",
    "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
    "const q = () => import('./a/b.js');",
    'const r = () => import(`../shared/c.js`);',
    "const peer = () => import('https://cdn.jsdelivr.net/npm/x@1/+esm');",
    "// import('./not-a-module.js') in a comment",
    "const s = \"import('./not/a/string.js')\";",
  ].join('\n');
  const errors = [];
  const out = rewriteModule('js/main.js', src, known, errors);
  assert.deepEqual(errors, []);
  assert.match(out, /from '@phortnite\/js\/a\/b\.js'/);
  assert.match(out, /from "@phortnite\/shared\/c\.js"/);
  assert.match(out, /export \{ D \} from '@phortnite\/js\/a\/b\.js'/);
  assert.match(out, /export \* from '@phortnite\/shared\/c\.js'/);
  assert.match(out, /import\('@phortnite\/js\/a\/b\.js'\)/);
  assert.match(out, /import\('@phortnite\/shared\/c\.js'\)/);
  assert.match(out, /from 'three'/);
  assert.match(out, /'three\/addons\/controls\/OrbitControls\.js'/);
  assert.match(out, /import\('https:\/\/cdn\.jsdelivr\.net\/npm\/x@1\/\+esm'\)/);
  assert.match(out, /\/\/ import\('\.\/not-a-module\.js'\)/, 'comments untouched');
  assert.match(out, /"import\('\.\/not\/a\/string\.js'\)"/, 'strings untouched');

  const bad = (file, code) => { const e = []; rewriteModule(file, code, known, e); return e; };
  assert.equal(bad('js/main.js', "import x from './missing.js';").length, 1, 'a missing module');
  assert.equal(bad('js/main.js', "import x from '../../outside.js';").length, 1, 'outside public/js and public/shared');
  assert.equal(bad('js/main.js', "import x from '/js/a/b.js';").length, 1, 'root-relative');
  assert.equal(bad('js/main.js', 'const u = new URL("./x.png", import.meta.url);').length, 1, 'import.meta');
  assert.equal(bad('js/main.js', 'const m = import(name);').length, 1, 'a computed import()');
  assert.equal(bad('js/main.js', 'const m = import(`./a/${n}.js`);').length, 1, 'a template import()');
  assert.equal(bad('js/main.js', 'import x from "./a\\u002fb.js";').length, 1, 'escapes');
  assert.equal(bad('js/main.js', 'import {').length, 1, 'syntax error');
});

test('lock: the build has no plaintext game code and no secrets; the archive holds every module with every import resolved', async () => {
  const { doc } = await shared;
  const out = tmp('build');
  const r = await buildLocked({ slots: doc, password: 'testcd-45', outDir: out });
  assert.equal(r.slot, 2);
  const files = walkFiles(out).sort();
  // no plaintext modules: only lock.js is a script, and js/ and shared/ are not there at all
  assert.deepEqual(files.filter((f) => /\.(m?js|cjs)$/.test(f)), ['lock.js']);
  assert.ok(!files.some((f) => /^(js|shared)\//.test(f)));
  for (const f of ['index.html', 'lock.js', 'lock.json', 'game.lock', 'game.raw.lock', 'announce.json', 'manifest.webmanifest', 'css/style.css', 'icons/icon.svg', '.nojekyll']) assert.ok(files.includes(f), f);
  // distinctive lines of the game's code appear in no published file
  const sample = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.length > 45 && !/^(\/\/|\*|\/\*)/.test(l)).filter((l, i) => i % 7 === 0).slice(0, 25);
  const needles = [...sample('js/main.js'), ...sample('shared/room.js'), 'class App', 'export function generateWorld'];
  assert.ok(needles.length > 30);
  for (const f of files) {
    const body = fs.readFileSync(path.join(out, f));
    const text = body.toString('utf8');
    for (const n of needles) assert.ok(!text.includes(n), `${f} contains game code: ${n}`);
    for (const s of [...PASSWORDS, b64(K0), hex(K0)]) assert.ok(!text.includes(s) && !body.toString('latin1').includes(s), `${f} contains a secret`);
  }
  // lock.json: only public things
  const lock = JSON.parse(fs.readFileSync(path.join(out, 'lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock).sort(), ['built', 'files', 'imports', 'iter', 'kdf', 'main', 'salt', 'slots', 'v', 'version'].sort());
  assert.deepEqual(lock.built, [...new Set(files.map((f) => f.split('/')[0]))].sort(), 'built: the top-level names it wrote');
  assert.equal(lock.version, r.version);
  assert.deepEqual(lock.slots, doc.slots.map(({ n, iv, wk }) => ({ n, iv, wk })));
  assert.deepEqual(Object.keys(lock.imports).sort(), ['rapier', 'three', 'three/addons/']);
  // the locked page: no import map or main.js of its own, the lock screen and lock.js instead
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /type="importmap"|type="module"|js\/main\.js/);
  assert.match(html, /<script src="lock\.js\?h=[0-9a-f]+"><\/script>/);
  assert.match(html, /id="lockscreen"/);
  assert.match(html, /This game is locked/);
  assert.match(html, /Ask Philip for a password\./);
  assert.match(html, /autocapitalize="characters"/);
  assert.match(html, /es-module-shims/);
  assert.match(html, /<div id="loading">/);
  assert.ok(html.includes(`localStorage.getItem(${STORE_EXPR})`), 'the first-frame check reads the same key as lock.js');
  assert.equal(fs.readFileSync(path.join(out, 'lock.js'), 'utf8'), fs.readFileSync(LOADER, 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'announce.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'announce.json'), 'utf8')), 'announce.json stays plaintext');

  // decrypt like lock.js does: both archives hold the same modules
  const gz = await openArchive(out, K0, 'gz');
  const raw = await openArchive(out, K0, 'raw');
  assert.deepEqual(gz, raw);
  assert.equal(gz.version, r.version);
  assert.equal(gz.main, 'js/main.js');
  const all = walkFiles(PUBLIC_DIR).filter((f) => /^(js|shared)\//.test(f)).sort();
  assert.deepEqual(Object.keys(gz.files).sort(), all, 'every module under public/js and public/shared');
  // walk the import graph from js/main.js: nothing relative is left, every @phortnite/ target exists
  await lexInit();
  const reached = new Set(), todo = ['js/main.js'];
  let bareOk = 0;
  while (todo.length) {
    const f = todo.pop();
    if (reached.has(f)) continue;
    reached.add(f);
    const [imps] = lexModule(gz.files[f], f);
    for (const im of imps) {
      if (im.type === 'import-meta') { assert.equal(f, 'js/gfx/textures.js'); continue; }
      const s = im.specifier;
      if (typeof s !== 'string') { assert.equal(f, 'js/net/p2p.js', `${f}: computed import`); continue; }
      assert.ok(!s.startsWith('.') && !s.startsWith('/'), `${f}: '${s}' left relative`);
      if (s.startsWith(PREFIX)) {
        const t = s.slice(PREFIX.length);
        assert.ok(t in gz.files, `${f}: ${s} is not in the archive`);
        todo.push(t);
      } else {
        assert.ok(/^(three|rapier)(\/|$)|^https:\/\//.test(s), `${f}: unexpected '${s}'`);
        bareOk++;
      }
    }
  }
  assert.ok(bareOk > 0);
  for (const f of ['js/bench.js', 'js/net/p2p.js', 'shared/room.js', 'js/actors/character.js']) assert.ok(reached.has(f), `${f} is reachable`);
  assert.equal(gz.files['js/gfx/texgen.js'], fs.readFileSync(path.join(PUBLIC_DIR, 'js/gfx/texgen.js'), 'utf8'), 'texgen.js has no imports');
  assert.match(gz.files['js/gfx/textures.js'], /__phortniteModuleURL\?\.\('js\/gfx\/texgen\.js'\)/, 'the worker seam');
  // a wrong key opens nothing
  await assert.rejects(openArchive(out, randomKey(), 'gz'));
  fs.rmSync(out, { recursive: true, force: true });
});

test('lock: every build encrypts with fresh IVs; the slots (passwords) stay the same', async () => {
  const { doc } = await shared;
  const a = tmp('a'), b = tmp('b');
  await buildLocked({ slots: doc, password: PASSWORDS[0], outDir: a });
  await buildLocked({ slots: doc, password: PASSWORDS[2], outDir: b });
  const la = JSON.parse(fs.readFileSync(path.join(a, 'lock.json'), 'utf8'));
  const lb = JSON.parse(fs.readFileSync(path.join(b, 'lock.json'), 'utf8'));
  const ivs = [la.files.gz.iv, la.files.raw.iv, lb.files.gz.iv, lb.files.raw.iv];
  assert.equal(new Set(ivs).size, 4, 'four encryptions, four IVs');
  for (const iv of ivs) assert.equal(Buffer.from(iv, 'base64').length, 12);
  for (const f of ['game.lock', 'game.raw.lock']) assert.notDeepEqual(fs.readFileSync(path.join(a, f)), fs.readFileSync(path.join(b, f)));
  assert.deepEqual(la.slots, lb.slots);
  assert.deepEqual(await openArchive(a, K0), await openArchive(b, K0));
  // building again into the same folder replaces the earlier build
  await buildLocked({ slots: doc, password: PASSWORDS[1], outDir: a });
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(a, 'lock.json'), 'utf8')).files.gz.iv, la.files.gz.iv);
  // ... but never a folder with other things in it, or public/ itself
  const other = tmp('other');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'mine');
  await assert.rejects(buildLocked({ slots: doc, password: PASSWORDS[0], outDir: other }), LockError);
  assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
  // a gh-pages checkout with an earlier build in it, plus .git and beta/: refused, untouched
  const pages = tmp('pages');
  await buildLocked({ slots: doc, password: PASSWORDS[0], outDir: pages });
  fs.mkdirSync(path.join(pages, '.git'));
  fs.mkdirSync(path.join(pages, 'beta'));
  await assert.rejects(buildLocked({ slots: doc, password: PASSWORDS[0], outDir: pages }), /\.git, beta|beta, \.git/);
  assert.ok(fs.existsSync(path.join(pages, '.git')) && fs.existsSync(path.join(pages, 'lock.json')));
  fs.rmSync(pages, { recursive: true, force: true });
  await assert.rejects(buildLocked({ slots: doc, password: PASSWORDS[0], outDir: path.join(PUBLIC_DIR, 'locked') }), LockError);
  await assert.rejects(buildLocked({ slots: doc, password: PASSWORDS[0], outDir: ROOT }), LockError);
  for (const d of [a, b, other]) fs.rmSync(d, { recursive: true, force: true });
});

test('lock: the build refuses a wrong or missing password, and weak (test) slots unless told', async () => {
  const { doc } = await shared;
  const dir = tmp('wrong'), out = path.join(dir, 'site');
  await assert.rejects(buildLocked({ slots: doc, password: 'TESTZZ99', outDir: out }), /does not open any of the key slots/);
  await assert.rejects(buildLocked({ slots: doc, password: '', outDir: out }), /PHORTNITE_PASSWORD/);
  // 1,000 rounds would make the public lock.json cheap to guess at: never without allowWeak
  await assert.rejects(buildLockedStrict({ slots: doc, password: PASSWORDS[0], outDir: out }), /PBKDF2 rounds.*--allow-weak/);
  assert.ok(!fs.existsSync(out), 'nothing written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: a failed build leaves the earlier one alone; stray dotfiles and removed files are handled', async () => {
  const { doc } = await shared;
  const dir = tmp('pub');
  const pub = path.join(dir, 'public'), out = path.join(dir, 'site');
  fs.cpSync(PUBLIC_DIR, pub, { recursive: true, filter: (src) => !src.includes(`${path.sep}vendor`) });
  // a macOS .DS_Store / editor file next to the modules is skipped (and never published)
  fs.writeFileSync(path.join(pub, 'js', '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(pub, 'shared', '.room.js.swp'), 'junk');
  assert.ok(!('js/.DS_Store' in await collectModules(pub)));
  fs.writeFileSync(path.join(pub, 'robots.txt'), 'User-agent: *\n');
  await buildLocked({ slots: doc, password: PASSWORDS[0], outDir: out, publicDir: pub });
  assert.ok(fs.existsSync(path.join(out, 'robots.txt')));
  assert.ok(!walkFiles(out).some((f) => /DS_Store|\.swp$/.test(f)));
  // a file removed from public/ since: the next build still knows the old one was its own
  fs.rmSync(path.join(pub, 'robots.txt'));
  await buildLocked({ slots: doc, password: PASSWORDS[0], outDir: out, publicDir: pub });
  assert.ok(!fs.existsSync(path.join(out, 'robots.txt')));
  const good = fs.readFileSync(path.join(out, 'lock.json'), 'utf8');
  // a build that fails its checks (a plaintext script outside js/) leaves the earlier one as it was
  fs.writeFileSync(path.join(pub, 'sw.js'), 'self.onfetch = null;');
  await assert.rejects(buildLocked({ slots: doc, password: PASSWORDS[0], outDir: out, publicDir: pub }), /sw\.js.*plaintext/);
  assert.equal(fs.readFileSync(path.join(out, 'lock.json'), 'utf8'), good);
  assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, 'game.lock')));
  fs.rmSync(path.join(pub, 'sw.js'));
  await buildLocked({ slots: doc, password: PASSWORDS[0], outDir: out, publicDir: pub });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: the command line (new / list / add / remove / build), passwords only from PHORTNITE_PASSWORD', async () => {
  const dir = tmp('cli');
  const slots = path.join(dir, 'slots.json');
  // fewer rounds than 600,000 only when asked for in so many words (never from the environment)
  const weak = cli(['new', '--count', '10', '--slots', slots, '--iter', String(ITER)]);
  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /--allow-weak/);
  assert.ok(!fs.existsSync(slots));
  const strong = path.join(dir, 'strong.json');
  assert.equal(cli(['new', '--count', '1', '--slots', strong], { PHORTNITE_LOCK_ITER: '1' }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(strong, 'utf8')).iter, ITERATIONS, 'PHORTNITE_LOCK_ITER is ignored');
  const made = cli(['new', '--count', '10', '--slots', slots, '--iter', String(ITER), '--allow-weak']);
  assert.equal(made.status, 0, made.stderr);
  const pw = [...made.stdout.matchAll(/^\s+(\d+)\s+([A-Z0-9]{8})$/gm)].map((m) => ({ n: Number(m[1]), p: m[2] }));
  assert.deepEqual(pw.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const { p } of pw) assert.ok(isValidPassword(p), p);
  const saved = fs.readFileSync(slots, 'utf8');
  for (const { p } of pw) assert.ok(!saved.includes(p), 'no password in the slots file');
  assert.equal(JSON.parse(saved).iter, ITER);
  // a second `new` would replace every password: only with --force
  const again = cli(['new', '--slots', slots, '--iter', String(ITER), '--allow-weak']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--force/);
  assert.equal(fs.readFileSync(slots, 'utf8'), saved);
  assert.match(cli(['list', '--slots', slots]).stdout, /10 slots: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10/);
  // never on the command line
  const leak = cli(['build', '--slots', slots, '--out', path.join(dir, 'x'), '--password', pw[0].p]);
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /PHORTNITE_PASSWORD/);
  // add needs a working password (and, on weak test slots, --allow-weak)
  assert.equal(cli(['add', '--count', '2', '--slots', slots, '--allow-weak'], { PHORTNITE_PASSWORD: 'TESTZZ99' }).status, 1);
  assert.match(cli(['add', '--count', '2', '--slots', slots], { PHORTNITE_PASSWORD: pw[4].p }).stderr, /--allow-weak/);
  const add = cli(['add', '--count', '2', '--slots', slots, '--allow-weak'], { PHORTNITE_PASSWORD: pw[4].p });
  assert.equal(add.status, 0, add.stderr);
  const more = [...add.stdout.matchAll(/^\s+(\d+)\s+([A-Z0-9]{8})$/gm)].map((m) => ({ n: Number(m[1]), p: m[2] }));
  assert.deepEqual(more.map((x) => x.n), [11, 12]);
  const rm = cli(['remove', '--slot', '3', '--slots', slots]);
  assert.equal(rm.status, 0, rm.stderr);
  assert.match(rm.stdout, /new --force/, 'says how to shut a password out completely');
  assert.match(cli(['list', '--slots', slots]).stdout, /11 slots: 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12/);
  assert.equal(cli(['remove', '--slot', '3', '--slots', slots]).status, 1, 'already gone');
  // the highest number removed and a new password added: it gets a new number, not 12 again
  assert.equal(cli(['remove', '--slot', '12', '--slots', slots]).status, 0);
  const add13 = cli(['add', '--count', '1', '--slots', slots, '--allow-weak'], { PHORTNITE_PASSWORD: pw[0].p });
  assert.match(add13.stdout, /^\s+13\s+[A-Z0-9]{8}$/m);
  assert.match(cli(['list', '--slots', slots]).stdout, /11 slots: 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13/);
  // build: the removed password is refused, any other one works
  const out = path.join(dir, 'site');
  const refused = cli(['build', '--slots', slots, '--out', out, '--allow-weak'], { PHORTNITE_PASSWORD: pw[2].p });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not open/);
  assert.equal(cli(['build', '--slots', slots, '--out', out, '--allow-weak']).status, 1, 'no password at all');
  const weakBuild = cli(['build', '--slots', slots, '--out', out], { PHORTNITE_PASSWORD: pw[0].p });
  assert.equal(weakBuild.status, 1, 'weak slots are never built into a site by mistake');
  assert.match(weakBuild.stderr, /--allow-weak/);
  assert.ok(!fs.existsSync(out));
  const built = cli(['build', '--slots', slots, '--out', out, '--allow-weak'], { PHORTNITE_PASSWORD: more[0].p.toLowerCase() });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /unlocked with slot 11/);
  for (const { p } of [...pw, ...more]) assert.ok(!built.stdout.includes(p) && !built.stderr.includes(p), 'the build never prints a password');
  const doc = JSON.parse(fs.readFileSync(slots, 'utf8'));
  const key = (await unlockSlots(doc, pw[0].p)).K;
  assert.ok(Object.keys((await openArchive(out, key)).files).length > 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: index.html must have exactly the import map and main.js the lock replaces', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const { html: locked, imports } = lockIndexHtml(html);
  assert.equal(imports.three, 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js');
  assert.match(locked, /<script src="lock\.js"><\/script>/);
  assert.ok(locked.includes(`localStorage.getItem(${STORE_EXPR})`));
  assert.ok(locked.includes(HEAD_SCRIPT), 'the first-frame ban / remembered-password check');
  assert.throws(() => lockIndexHtml(html.replace('<script type="module" src="js/main.js"></script>', '')), LockError);
  assert.throws(() => lockIndexHtml(html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '')), LockError);
});

test('lock: lock.js is plain ES2017 and never logs, sends or stores more than it should', () => {
  const src = fs.readFileSync(LOADER, 'utf8');
  execFileSync(process.execPath, ['--check', LOADER]);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const bare = code.replace(/'(?:[^'\\\n]|\\.)*'/g, "''"); // (without its strings)
  assert.doesNotMatch(bare, /\?\.|\?\?|catch\s*\{|\.\.\.|\bimport\s*\(|\bclass\s|\|\|=|&&=/, 'nothing newer than ES2017');
  assert.doesNotMatch(code, /console\.|XMLHttpRequest|sendBeacon|WebSocket|Math\.random/);
  // the only places the password goes: PBKDF2, and localStorage when "Remember" is ticked; the
  // only other things stored are the ban record, the Face ID record (the game key encrypted with the
  // passkey's secret: faceWrap), the passkey's random user id (so a new setup replaces the old
  // passkey) and "Not now" for Face ID (never the password or an unban code)
  assert.match(code, /localStorage\.setItem\(STORE, p\)/);
  assert.deepEqual([...code.matchAll(/localStorage\.setItem\(([^)]*)\)/g)].map((m) => m[1]), ['STORE, p', 'FACE, JSON.stringify(rec', 'FACEUSER, b64url(id', 'NOFACE, why', 'BAN, v']);
  assert.match(code, /var id = random\(16\);\s*localStorage\.setItem\(FACEUSER, b64url\(id\)\);/, 'the user id is random bytes, nothing about the player');
  assert.match(code, /localStorage\.setItem\(FACE, JSON\.stringify\(rec\)\)/);
  assert.equal([...code.matchAll(/saveFace\((\w+)\)/g)].map((m) => m[1]).join(), 'rec,rec', 'one place keeps a record: the one faceWrap made');
  assert.match(code, /rec = await faceWrap\(secret, o\.salt, o\.K, o\.slot, o\.id, location\.hostname\)/);
  assert.deepEqual([...code.matchAll(/setNoFace\('(\w+)'\)/g)].map((m) => m[1]).sort(), ['later', 'unsupported']);
  assert.deepEqual([...code.matchAll(/document\.cookie = (\w+)/g)].map((m) => m[1]), ['COOKIE']);
  assert.deepEqual([...code.matchAll(/\.put\((.*), 'ban'\)/g)].map((m) => m[1]), ['formatBan(idbRecord(w, parseBan(r.result)))']);
  assert.match(code, /'; Max-Age=' \+ \(clear \? 0 : 315360000\) \+ '; Path=' \+ SITE\s*\+ '; SameSite=Lax' \+ \(location\.protocol === 'https:' \? '; Secure' : ''\)/);
  // one strike per real wrong password (in one place), the messages Philip asked for
  assert.equal(code.match(/ban\.strikes\+\+/g).length, 1);
  assert.match(code, /'1 try left\. One more wrong password bans this device\.'/);
  assert.match(code, /'Wrong password — ' \+ triesLeft/);
  assert.match(code, /'Unbanned\. Type a password\.'/);
  assert.match(code, /'Wrong code 3 times\. Unbanning is locked for an hour\.'/);
  const markup = fs.readFileSync(path.join(ROOT, 'tools', 'lockscreen', 'lock.html'), 'utf8');
  for (const s of ['id="ls-unban-open"', '>Philip: unban<', 'id="ls-code"', 'id="ls-unban-go"', '>UNBAN<', 'id="ls-umsg"', '🚫</span> Banned',
    'Too many wrong passwords. This device can’t open Phortnite any more.']) assert.ok(markup.includes(s), s);
  // one remembered password per folder of the site (/ and /beta/ share an origin), the same key
  // the page's <head> checks for its first frame
  assert.ok(code.includes(`var STORE = ${STORE_EXPR};`), 'STORE is STORE_EXPR');
  assert.ok(code.includes(`var FACE = ${FACE_EXPR};`), 'FACE is FACE_EXPR');
  assert.equal(new Function('location', `return ${FACE_EXPR};`)({ pathname: '/jojo-relay/beta/index.html' }), 'phortnite.face:/jojo-relay/beta/');
  const storeFor = new Function('location', `return ${STORE_EXPR};`);
  assert.equal(storeFor({ pathname: '/jojo-relay/' }), 'phortnite.pass:/jojo-relay/');
  assert.equal(storeFor({ pathname: '/jojo-relay/index.html' }), 'phortnite.pass:/jojo-relay/');
  assert.equal(storeFor({ pathname: '/jojo-relay/beta/' }), 'phortnite.pass:/jojo-relay/beta/');
  // the game's script goes in <head>, where es-module-shims (iPadOS < 16.4) sees it
  assert.match(code, /document\.head\.appendChild\(s\)/);
  assert.doesNotMatch(code, /document\.body\.appendChild/);
  assert.match(code, /if \(nativeImportMaps\(\)\) s\.onerror/);
  assert.match(code, /iterations: m\.iter/);
  assert.match(code, /'phortnite-slot:' \+ s\.n/);
  assert.match(code, /'phortnite-archive:' \+ a\.kind/);
  assert.match(code, /DecompressionStream/);
  assert.match(code, /That password was turned off — ask Philip for a new one/);
  assert.match(code, /Wrong password/);
  // lock.js and lock.mjs agree on what a password looks like once typed
  const norm = new Function(`${/function normalize\(p\) \{[\s\S]*?\n {2}\}/.exec(src)[0]}; return normalize;`)();
  for (const s of ['ab cd-23\u201345', ' TESTAB23 ', 'test\u00a0ab23', 'TEST--AB23', 'ab\u2212cd\u201023 45']) assert.equal(norm(s), normalize(s), s);
});

test('lock: unban codes are 10 characters from the password alphabet, from crypto random numbers; only a PBKDF2 verifier is kept', async () => {
  assert.equal(UNBAN_LENGTH, 10);
  const list = Array.from({ length: 3000 }, () => generateUnbanCode());
  assert.equal(new Set(list).size, 3000, 'no repeats');
  const seen = new Set();
  for (const c of list) {
    assert.match(c, /^[A-HJ-NP-Z2-9]{10}$/);
    for (const ch of c) seen.add(ch);
  }
  assert.equal(seen.size, ALPHABET.length, 'every character turns up');
  // the system's secure random numbers (crypto.randomInt), never Math.random
  assert.match(/export function generateUnbanCode\(\) \{[\s\S]*?\n\}/.exec(fs.readFileSync(TOOL, 'utf8'))[0], /randomInt\(ALPHABET\.length\)/);

  const code = generateUnbanCode();
  const u = await makeUnban(code);
  assert.deepEqual(Object.keys(u).sort(), ['hash', 'iter', 'salt']);
  assert.equal(u.iter, ITERATIONS);
  assert.equal(Buffer.from(u.salt, 'base64').length, 16);
  assert.equal(Buffer.from(u.hash, 'base64').length, 32);
  // = PBKDF2-HMAC-SHA256(code, salt, 600,000 rounds, 256 bits), worked out independently here
  assert.equal(u.hash, pbkdf2Sync(code, Buffer.from(u.salt, 'base64'), ITERATIONS, 32, 'sha256').toString('base64'));
  assert.ok(!JSON.stringify(u).includes(code), 'no code in the verifier');
  assert.equal(await checkUnban(u, code), true);
  assert.equal(await checkUnban(u, `${code.slice(0, 5).toLowerCase()} - ${code.slice(5).toLowerCase()}`), true, 'typed in lowercase with a dash');
  assert.equal(await checkUnban(u, code.slice(0, 9) + (code[9] === 'A' ? 'B' : 'A')), false);
  assert.equal(await checkUnban(u, ''), false);
  const again = await makeUnban(code, { iter: ITER });
  assert.notEqual(again.salt, u.salt, 'a fresh salt every time');
  // a weak (test) verifier is never built into a site by mistake
  assert.throws(() => checkStrength({ iter: ITERATIONS, unban: again }, false), /unban code uses only 1000 PBKDF2 rounds/);
  checkStrength({ iter: ITERATIONS, unban: u }, false);
  // the slots document gets the verifier (and a broken one is refused)
  const { doc } = await shared;
  const set = await setUnban(doc, { iter: ITER });
  assert.deepEqual(set.doc.slots, doc.slots, 'the key slots stay as they are');
  assert.equal(await checkUnban(set.doc.unban, set.code), true);
  assert.equal(doc.unban, undefined, 'setUnban does not change the original');
  await assert.rejects(unlockSlots({ ...doc, unban: { salt: 'x' } }, PASSWORDS[0]), LockError);
});

test('lock: lock.js checks an unban code with the same PBKDF2 as lock.mjs (its own code, run in Node)', async () => {
  const h = loaderHelpers();
  const code = generateUnbanCode();
  const u = await makeUnban(code); // (the real 600,000 rounds, as on the website)
  assert.equal(await h.unbanOk(u, code), true);
  assert.equal(await h.unbanOk(u, `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`), true);
  assert.equal(await h.unbanOk(u, code.split('').reverse().join('')), code === code.split('').reverse().join(''));
  const w = await makeUnban(code, { iter: ITER });
  assert.equal(await h.unbanOk(w, code), true, 'the rounds come from the verifier');
  assert.equal(await h.unbanOk(w, 'TESTAB2345'), code === 'TESTAB2345');
  const flipped = Buffer.from(w.hash, 'base64');
  flipped[31] ^= 1;
  assert.equal(await h.unbanOk({ ...w, hash: flipped.toString('base64') }, code), false, 'one bit off');
  assert.equal(await h.unbanOk({ ...w, hash: flipped.subarray(0, 16).toString('base64') }, code), false, 'a short hash');
  assert.equal(await h.unbanOk({ ...w, hash: '' }, code), false);
  // the same alphabet, limit and storage names on both sides
  assert.equal(h.STRIKES, STRIKES);
  assert.equal(h.STRIKES, 3);
  assert.equal(h.BAN, BAN_KEY);
  assert.equal(h.COOKIE, BAN_COOKIE);
  assert.equal(h.UNBAN_TRIES, 3);
  assert.equal(h.UNBAN_WAIT, 3600000);
  for (const c of ALPHABET) assert.ok(h.CHARS.test(c), c);
  for (const c of '0O1I!a ') assert.ok(!h.CHARS.test(c), c);
  for (const s of ['ab cd-23\u201345', ' TESTAB23 ', 'TEST--AB23']) assert.equal(h.normalize(s), normalize(s), s);
});

test('lock: the ban record: the highest of the three stores wins, and the page <head> and lock.js agree on "banned"', () => {
  const h = loaderHelpers();
  assert.deepEqual(h.parseBan('2.1.1700000000000'), { strikes: 2, tries: 1, until: 1700000000000 });
  for (const junk of [null, undefined, '', 'banned', '-3.-1.x', '.']) assert.deepEqual(h.parseBan(junk), { strikes: 0, tries: 0, until: 0 }, String(junk));
  assert.equal(h.formatBan(h.parseBan('3.0.1700000000000')), '3.0.1700000000000');
  assert.deepEqual(h.mergeBan(h.parseBan('1.2.0'), h.parseBan('3.0.5')), { strikes: 3, tries: 2, until: 5 });
  assert.equal(h.isBanned(h.parseBan('2.0.0')), false);
  assert.equal(h.isBanned(h.parseBan('3.0.0')), true);
  // the cookie's path: the site's top folder, the same for the main site and its beta/
  const site = { '/jojo-relay/': '/jojo-relay/', '/jojo-relay/index.html': '/jojo-relay/', '/jojo-relay/beta/': '/jojo-relay/', '/jojo-relay/beta/index.html': '/jojo-relay/', '/': '/', '/beta/': '/', '/a/beta/': '/a/', '/betamax/': '/betamax/' };
  for (const [p, want] of Object.entries(site)) assert.equal(h.siteFolder(p), want, p);

  // localStorage and the cookie together; the <head> check says the same before lock.js runs
  const pass = { 'phortnite.pass:/jojo-relay/': 'TESTAB23' };
  const cases = [
    [{}, false, []],
    [{ storage: pass }, false, ['ls-auto']],
    [{ storage: { 'phortnite.ban': '2.0.0', ...pass } }, false, ['ls-auto']],
    [{ storage: { 'phortnite.ban': '3.0.0', ...pass } }, true, ['ls-banned']], // (never "Unlocking…")
    [{ storage: { 'phortnite.ban': '3' } }, true, ['ls-banned']],
    [{ cookie: 'phortnite_ban=3.0.0' }, true, ['ls-banned']],
    [{ cookie: 'a=1; phortnite_ban=4.2.17; b=2', storage: pass }, true, ['ls-banned']],
    [{ cookie: 'phortnite_ban=2.0.0', storage: { 'phortnite.ban': '1.0.0' } }, false, []],
    [{ cookie: 'xphortnite_ban=3.0.0' }, false, []],
    [{ cookie: 'phortnite_ban=3.0.0', storageThrows: true }, true, ['ls-banned']],
    [{ storage: { 'phortnite.ban': 'junk' }, cookie: 'phortnite_ban=' }, false, []],
  ];
  for (const [env, banned, classes] of cases) {
    const got = loaderHelpers(env).readSync();
    assert.equal(h.isBanned(got), banned, JSON.stringify(env));
    assert.deepEqual(headClasses(env), classes, JSON.stringify(env));
  }
  assert.deepEqual(loaderHelpers({ storage: { 'phortnite.ban': '1.2.300' }, cookie: 'phortnite_ban=2.0.100' }).readSync(), { strikes: 2, tries: 2, until: 300 });
  // Face ID set up (and WebAuthn there): its button from the first frame, never "Unlocking…" (the
  // face comes first); a ban still wins; another folder's record, or no WebAuthn, changes nothing
  const face = { 'phortnite.face:/jojo-relay/': '{"v":1}' };
  const faceCases = [
    [{ storage: face, webauthn: true }, ['ls-faceid']],
    [{ storage: { ...face, ...pass }, webauthn: true }, ['ls-faceid']],
    [{ storage: { ...face, ...pass } }, ['ls-auto']],
    [{ storage: face }, []],
    [{ storage: { ...face, 'phortnite.ban': '3.0.0' }, webauthn: true }, ['ls-banned']],
    [{ storage: face, cookie: 'phortnite_ban=3.0.0', webauthn: true }, ['ls-banned']],
    [{ storage: { 'phortnite.face:/jojo-relay/beta/': '{"v":1}', ...pass }, webauthn: true }, ['ls-auto']],
    [{ storage: face, webauthn: true, pathname: '/jojo-relay/index.html' }, ['ls-faceid']],
    [{ storage: face, webauthn: true, storageThrows: true }, []],
  ];
  for (const [env, classes] of faceCases) assert.deepEqual(headClasses(env), classes, JSON.stringify(env));
});

test('lock: unban-code prints the code once and keeps only its verifier; the build copies that into lock.json, and the code is nowhere in the site', async () => {
  const dir = tmp('unban');
  const slots = path.join(dir, 'slots.json');
  const none = cli(['unban-code', '--slots', slots]);
  assert.equal(none.status, 1, 'the key slots come first');
  assert.match(none.stderr, /can't read the slots file/);
  const made = cli(['new', '--count', '2', '--slots', slots, '--iter', String(ITER), '--allow-weak']);
  assert.equal(made.status, 0, made.stderr);
  const pw = [...made.stdout.matchAll(/^\s+\d+\s+([A-Z0-9]{8})$/gm)].map((m) => m[1]);
  assert.match(cli(['list', '--slots', slots]).stdout, /No unban code yet/);
  const weak = cli(['unban-code', '--slots', slots, '--iter', String(ITER)]);
  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /--allow-weak/);

  const r = cli(['unban-code', '--slots', slots]);
  assert.equal(r.status, 0, r.stderr);
  const codes = [...r.stdout.matchAll(/^\s+([A-Z0-9]{10})$/gm)].map((m) => m[1]);
  assert.equal(codes.length, 1, 'printed once');
  const code = codes[0];
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.match(r.stdout, /shown only this once/);
  assert.match(r.stdout, /Philip: unban/);
  const text = fs.readFileSync(slots, 'utf8');
  for (const v of [code, code.toLowerCase(), `${code.slice(0, 5)}-${code.slice(5)}`]) assert.ok(!text.includes(v), 'no code in the slots file');
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc.unban).sort(), ['hash', 'iter', 'salt']);
  assert.equal(doc.unban.iter, ITERATIONS);
  assert.equal(Buffer.from(doc.unban.salt, 'base64').length, 16);
  assert.equal(await checkUnban(doc.unban, code), true);
  assert.equal(await loaderHelpers().unbanOk(doc.unban, code.toLowerCase()), true, 'lock.js takes it');
  for (const p of pw) assert.ok(await unlockSlots(doc, p), 'the passwords still work');
  assert.match(cli(['list', '--slots', slots]).stdout, /An unban code is set/);
  // add and remove keep it
  assert.equal(cli(['add', '--count', '1', '--slots', slots, '--allow-weak'], { PHORTNITE_PASSWORD: pw[0] }).status, 0);
  assert.equal(cli(['remove', '--slot', '2', '--slots', slots]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(slots, 'utf8')).unban, doc.unban);

  // the build: the verifier in lock.json, the code in no file at all
  const out = path.join(dir, 'site');
  const built = cli(['build', '--slots', slots, '--out', out, '--allow-weak'], { PHORTNITE_PASSWORD: pw[0] });
  assert.equal(built.status, 0, built.stderr);
  assert.ok(!built.stdout.includes(code) && !built.stderr.includes(code));
  const lock = JSON.parse(fs.readFileSync(path.join(out, 'lock.json'), 'utf8'));
  assert.deepEqual(lock.unban, doc.unban);
  const files = walkFiles(out);
  assert.ok(files.length > 10);
  for (const f of files) {
    const body = fs.readFileSync(path.join(out, f));
    for (const v of [code, code.toLowerCase(), `${code.slice(0, 5)}-${code.slice(5)}`]) {
      assert.ok(!body.toString('utf8').includes(v) && !body.toString('latin1').includes(v), `${f} contains the unban code`);
    }
  }

  // a new code replaces the old one
  const r2 = cli(['unban-code', '--slots', slots]);
  assert.equal(r2.status, 0, r2.stderr);
  const code2 = /^\s+([A-Z0-9]{10})$/m.exec(r2.stdout)[1];
  assert.match(r2.stdout, /earlier unban code no longer does/);
  const doc2 = JSON.parse(fs.readFileSync(slots, 'utf8'));
  assert.equal(await checkUnban(doc2.unban, code2), true);
  assert.equal(await checkUnban(doc2.unban, code), code === code2);
  // starting over (new --force) keeps the unban code: it has nothing to do with the game key
  const restart = cli(['new', '--count', '1', '--slots', slots, '--iter', String(ITER), '--allow-weak', '--force']);
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /unban code stays the same/);
  assert.deepEqual(JSON.parse(fs.readFileSync(slots, 'utf8')).unban, doc2.unban);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: a strike counts on from the stores (not a page left open), the same wrong password or code is not counted twice, IndexedDB keeps its strikes', () => {
  const h = loaderHelpers();
  const b = (s) => h.parseBan(s);
  // wrong, wrong in this tab, the RIGHT password in another (the stores are cleared), wrong here: strike 1
  assert.deepEqual(h.current(b(''), b('2.0.0'), true), b(''), 'the stores, not the stale page');
  assert.deepEqual(h.current(b('1.0.0'), b('2.1.0'), true), b('1.0.0'));
  // storage blocked (nothing kept): this page counts by itself, so 3 wrong passwords still ban it
  assert.deepEqual(h.current(b(''), b('2.0.0'), false), b('2.0.0'));
  assert.deepEqual(h.current(b('1.2.0'), b('2.0.0'), false), b('2.2.0'));
  // an unban lock-out ends at most an hour from now (a clock put back since can't make it longer)
  const now = 1800000000000;
  assert.deepEqual(h.clampLock(b(`3.0.${now + 24 * 3600000}`), now), b(`3.0.${now + 3600000}`));
  for (const s of [`3.0.${now + 3600000}`, `3.0.${now + 60000}`, `3.2.${now - 5}`, '3.1.0', '2.0.0']) {
    const x = b(s);
    assert.equal(h.clampLock(x, now), x, s);
  }
  // IndexedDB never loses strikes it had (it may have answered too late for the page to know them);
  // tries and the lock-out are written as they are (locking starts the tries again)
  assert.deepEqual(h.idbRecord(b('1.0.0'), b('3.0.0')), b('3.0.0'));
  assert.deepEqual(h.idbRecord(b('2.0.0'), b('1.0.0')), b('2.0.0'));
  assert.deepEqual(h.idbRecord(b(`3.0.${now}`), b('3.2.0')), b(`3.0.${now}`));
  assert.deepEqual(h.idbRecord(b('3.0.5'), b('3.0.99')), b('3.0.5'));

  const code = fs.readFileSync(LOADER, 'utf8');
  const unlockFn = /async function unlock\(password, auto\) \{[\s\S]*?\n {2}\}\n/.exec(code)[0];
  // the stores are read again for every try (while the password is checked) and the strike counts on from them
  assert.match(unlockFn, /await checked;\s*(?:\/\/.*\n\s*)*var now = readAll\(\);[\s\S]*useStores\(await now\);\s*if \(isBanned\(ban\)\) \{ banned\(\); return; \}/);
  assert.ok(unlockFn.indexOf('useStores(await now)') < unlockFn.indexOf('ban.strikes++'));
  assert.doesNotMatch(code, /mergeBan\(ban, readSync\(\)\);\s*ban\.(strikes|tries)\+\+/, 'never the higher of the page and the stores');
  assert.match(unlockFn, /ban\.strikes\+\+;\s*lastWrong = normalize\(password\);/);
  // the right password (or Face ID) clears every store, whatever the page knew: both go on in opened()
  const openedFn = /async function opened\(m, got, again, typed\) \{[\s\S]*?\n {2}\}\n/.exec(code)[0];
  assert.match(openedFn, /^[^{]*\{\s*(?:\/\/.*\n\s*)*lastWrong = '';\s*ban = parseBan\(''\);\s*saveBan\(ban\);/);
  assert.match(unlockFn, /await opened\(m, got, function \(m2\) \{ return unwrap\(m2, password\); \}, !auto && !m\.closed\);/);
  assert.ok(unlockFn.indexOf('ban.strikes++') < unlockFn.indexOf('await opened('));
  // Go again with the same wrong password (a double tap): the same message, no new check, no strike
  const submit = /card\.onsubmit = function \(e\) \{[\s\S]*?\n {2}\};/.exec(code)[0];
  assert.match(submit, /if \(p === lastWrong\) \{ ask\('Wrong password — ' \+ triesLeft\(ban\.strikes\)\); shake\(\); return false; \}\s*unlock\(p, false\);/);
  // the same for unban codes, and an unban try reads the stores first (Philip may have unbanned in another tab)
  const unbanFn = /async function tryUnban\(\) \{[\s\S]*?\n {2}\}\n/.exec(code)[0];
  assert.match(unbanFn, /useStores\(await readAll\(\)\);[\s\S]*if \(!isBanned\(ban\)\) \{ unbanned\(\); return; \}/);
  assert.ok(unbanFn.indexOf('if (c === lastCode)') > 0 && unbanFn.indexOf('if (c === lastCode)') < unbanFn.indexOf('unbanOk('));
  assert.match(unbanFn, /lastCode = c;\s*ban\.tries\+\+;/);
  assert.ok(unbanFn.indexOf('fixClock()') < unbanFn.indexOf('if (ban.until > Date.now())'), 'a lock-out from a clock put back is cut to an hour first');
  // the page's first look at a banned device writes nothing before IndexedDB has answered
  assert.match(code, /if \(isBanned\(ban\)\) \{ getMeta\(\); banned\(true\); \}/);
  assert.match(code, /function banned\(first\) \{[\s\S]*?if \(!first\) saveBan\(ban\);/);
});

test('lock: Face ID keeps the game key encrypted with the passkey\'s secret (HKDF-SHA256 + AES-256-GCM), bound to Face ID, the passkey and the key slot (lock.js\'s own code, run in Node)', async () => {
  const h = loaderHelpers();
  const { doc } = await shared;
  const rnd = (n) => webcrypto.getRandomValues(new Uint8Array(n));
  const slot = h.findSlot(doc, 2);
  assert.deepEqual(slot, doc.slots[1]);
  assert.equal(h.findSlot(doc, 9), null);
  assert.equal(h.findSlot(null, 1), null);
  const secret = rnd(32), salt = rnd(32), id = h.b64url(rnd(16));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  const rec = await h.faceWrap(secret, salt, K0, slot, id, 'p10603797-ship-it.github.io');
  assert.deepEqual(Object.keys(rec).sort(), ['id', 'iv', 'n', 'rp', 'salt', 'v', 'wk']);
  assert.equal(rec.v, 1);
  assert.equal(rec.n, 2);
  assert.equal(rec.id, id);
  assert.equal(rec.rp, 'p10603797-ship-it.github.io');
  assert.equal(rec.salt, b64(salt));
  assert.equal(Buffer.from(rec.iv, 'base64').length, 12);
  assert.equal(Buffer.from(rec.wk, 'base64').length, 32 + 16, 'the key and its GCM tag');
  // neither the game key nor the passkey's secret is in it (in any spelling)
  const text = JSON.stringify(rec);
  for (const v of [K0, secret]) for (const t of [b64(v), hex(v), h.b64url(v)]) assert.ok(!text.includes(t), 'no secret in the record');
  // the right secret, slot and passkey: the game key (also after a trip through localStorage)
  assert.deepEqual(await h.faceUnwrap(secret, rec, slot), K0);
  assert.deepEqual(await h.faceUnwrap(secret, h.parseFace(JSON.stringify(rec)), slot), K0);
  // anything else: nothing
  const other = secret.slice();
  other[31] ^= 1;
  assert.equal(await h.faceUnwrap(other, rec, slot), null, 'a wrong secret (another passkey, another face)');
  assert.equal(await h.faceUnwrap(rnd(32), rec, slot), null);
  assert.equal(await h.faceUnwrap(secret, { ...rec, n: 3 }, slot), null, 'another slot number');
  assert.equal(await h.faceUnwrap(secret, { ...rec, n: 3 }, doc.slots[2]), null, "another password's slot");
  assert.equal(await h.faceUnwrap(secret, rec, doc.slots[2]), null);
  assert.equal(await h.faceUnwrap(secret, { ...rec, id: h.b64url(rnd(16)) }, slot), null, 'another credential id');
  assert.equal(await h.faceUnwrap(secret, { ...rec, salt: b64(rnd(32)) }, slot), null, 'another PRF salt');
  const wk = Buffer.from(rec.wk, 'base64');
  wk[3] ^= 1;
  assert.equal(await h.faceUnwrap(secret, { ...rec, wk: wk.toString('base64') }, slot), null, 'changed');
  assert.equal(await h.faceUnwrap(secret, { ...rec, iv: 'not base64!' }, slot), null);
  // the password turned off: no slot (lock.js: "That password was turned off"); new passwords for
  // everyone (`new --force` numbers them from 1 again): slot 2 is another one now ("set up again")
  assert.equal(h.findSlot(removeSlot(doc, 2), 2), null);
  const fresh = (await makeSlots(randomKey(), PASSWORDS, { iter: ITER })).doc;
  assert.equal(await h.faceUnwrap(secret, rec, h.findSlot(fresh, 2)), null);
  // other passwords added or turned off leave this one's slot (and so Face ID) as it was
  const after = removeSlot((await addSlots(doc, PASSWORDS[0], 1)).doc, 3);
  assert.deepEqual(await h.faceUnwrap(secret, rec, h.findSlot(after, 2)), K0);
  // a fresh IV every time
  assert.notEqual((await h.faceWrap(secret, salt, K0, slot, id, 'x')).iv, rec.iv);
  // the format, worked out independently with Node's own HKDF and AES-GCM:
  // HKDF-SHA256(secret, salt, 'phortnite face unlock v1') -> AES-256-GCM, additional data
  // 'phortnite-faceid:<n>:<credential id>:<slot iv>:<slot wk>'
  assert.equal(h.FACE_INFO, 'phortnite face unlock v1');
  const key = Buffer.from(hkdfSync('sha256', secret, salt, 'phortnite face unlock v1', 32));
  const ct = Buffer.from(rec.wk, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
  d.setAAD(Buffer.from(`phortnite-faceid:2:${id}:${slot.iv}:${slot.wk}`));
  d.setAuthTag(ct.subarray(ct.length - 16));
  assert.deepEqual(new Uint8Array(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])), K0);
  // base64url (credential ids) both ways, the same as Node's
  for (const n of [0, 1, 2, 3, 16, 33, 64]) {
    const u = rnd(n);
    assert.equal(h.b64url(u), Buffer.from(u).toString('base64url'));
    assert.deepEqual(h.unb64url(h.b64url(u)), u);
  }
  // what localStorage holds is checked before it is used
  assert.deepEqual(h.parseFace(JSON.stringify(rec)), rec);
  for (const bad of [null, '', 'x', '{}', '[]', 'null', '"x"', JSON.stringify({ ...rec, v: 2 }), JSON.stringify({ ...rec, n: '2' }), JSON.stringify({ ...rec, n: 2.5 }),
    JSON.stringify({ ...rec, id: '' }), JSON.stringify({ ...rec, wk: 5 }), JSON.stringify({ ...rec, rp: undefined })]) assert.equal(h.parseFace(bad), null, String(bad));
});

test('lock: Face ID reads the passkey\'s secret from the PRF extension, and is offered only where the device says it can', async (t) => {
  const h = loaderHelpers();
  const cred = (ext) => ({ getClientExtensionResults: () => ext });
  const s32 = webcrypto.getRandomValues(new Uint8Array(32));
  assert.deepEqual(h.prfFirst(cred({ prf: { results: { first: s32.buffer } } })), s32, 'an ArrayBuffer (the browsers)');
  assert.deepEqual(h.prfFirst(cred({ prf: { enabled: true, results: { first: s32 } } })), s32, 'a view');
  for (const c of [cred({ prf: { enabled: true } }), cred({ prf: {} }), cred({}), cred(null), null, {}, cred({ prf: { results: { first: new ArrayBuffer(0) } } }),
    { getClientExtensionResults() { throw new Error('x'); } }]) assert.equal(h.prfFirst(c), null);
  // "One more scan to finish": PRF is on, but the secret comes only when the passkey is used
  assert.equal(h.prfEnabled(cred({ prf: { enabled: true } })), true);
  for (const c of [cred({ prf: { enabled: false } }), cred({ prf: {} }), cred({}), {}, null]) assert.equal(h.prfEnabled(c), false);
  // the offer: a platform authenticator with user verification (Face ID / Touch ID), and not a
  // device that says it has no PRF; asking never fails
  const P = (uv, caps) => {
    const answer = (v) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
    const p = { isUserVerifyingPlatformAuthenticatorAvailable: () => answer(uv) };
    if (caps !== undefined) p.getClientCapabilities = () => answer(caps);
    return p;
  };
  const cases = [
    [undefined, false], [{}, false], [P(false), false], [P(true), true], [P(true, { 'extension:prf': true }), true], [P(true, {}), true],
    [P(true, { 'extension:prf': false }), false], [P(false, { 'extension:prf': true }), false], [P(new Error('x')), false], [P(true, new Error('x')), true],
    [{ isUserVerifyingPlatformAuthenticatorAvailable() { throw new Error('x'); } }, false], [P('yes'), false],
  ];
  for (const [p, want] of cases) assert.equal(await h.faceAvailable(p), want, JSON.stringify(p && Object.keys(p)));
  // no answer at all: no, after 3 s
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = h.faceAvailable({ isUserVerifyingPlatformAuthenticatorAvailable: () => new Promise(() => {}) });
  t.mock.timers.tick(3000);
  assert.equal(await pending, false);
  t.mock.timers.reset();
});

test('lock: Face ID in lock.js: asked for only from a tap, never a strike, never on a banned device; the offer and the lock screen say what Philip asked for', () => {
  const code = fs.readFileSync(LOADER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const fn = (name) => new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`).exec(code)[0];
  // the WebAuthn calls: one get (faceGet) and one create, both made in the tap itself (Safari asks
  // for the face only from a tap: nothing awaited before them), never on load
  assert.equal(code.match(/navigator\.credentials\.get\(/g).length, 1);
  assert.equal(code.match(/navigator\.credentials\.create\(/g).length, 1);
  assert.match(fn('faceGet'), /userVerification: 'required'/);
  assert.match(fn('faceGet'), /allowCredentials: \[\{ type: 'public-key', id: unb64url\(id\) \}\]/);
  assert.match(fn('faceGet'), /extensions: \{ prf: \{ eval: \{ first: salt \} \} \}/);
  assert.deepEqual([...code.matchAll(/\bfaceGet\((.*?)\);/g)].map((m) => m[1]), ['rec.id, unb64(rec.salt), rec.rp', 'o.id, o.salt, location.hostname']);
  for (const name of ['faceUnlock', 'faceTap']) {
    const f = fn(name);
    assert.doesNotMatch(f, /\bawait\b|^async/, `${name} waits for nothing before asking`);
    assert.ok(!/\.then\(/.test(f.slice(0, f.indexOf('faceGet('))), name);
  }
  assert.equal([...code.matchAll(/\bfaceUnlock\(\)/g)].length, 2, 'only the button calls it (and its own definition)');
  assert.match(code, /faceGo\.onclick = function \(\) \{ faceUnlock\(\); \};/);
  assert.match(code, /faceOn\.onclick = function \(\) \{ faceTap\(\); \};/);
  const tap = fn('faceTap');
  for (const s of ["rp: { id: location.hostname, name: 'Phortnite' }", "user: { id: faceUser(), name: 'Phortnite', displayName: 'Phortnite' }", 'challenge: random(32)',
    "pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }]",
    "authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' }",
    'timeout: 60000, extensions: { prf: { eval: { first: o.salt } } }', 'o.salt = random(32);']) assert.ok(tap.includes(s), s);
  assert.match(code, /function random\(n\) \{ return crypto\.getRandomValues\(new Uint8Array\(n\)\); \}/);
  // a banned device: never Face ID (checked before the scan, and again, with IndexedDB, after it)
  assert.match(fn('faceUnlock'), /if \(busy \|\| !face\) return;[\s\S]*if \(isBanned\(now\)\) \{ ban = now; banned\(\); return; \}[\s\S]*faceGet\(/);
  const faceOpen = fn('faceOpen');
  assert.match(faceOpen, /await checked;\s*useStores\(await readAll\(\)\);\s*if \(isBanned\(ban\)\) \{ banned\(\); return; \}/);
  assert.ok(faceOpen.indexOf('banned()') < faceOpen.indexOf('await meta'));
  // a failed or cancelled scan: a message, Face ID stays on, not a strike (strikes++ is only for passwords)
  assert.match(faceOpen, /if \(err\) \{ busy = false; faceFailed = true; ask\('Face ID didn’t work — try again or type a password\.'\); return; \}/);
  assert.doesNotMatch(faceOpen, /strikes|saveBan|dropFace/);
  assert.match(faceOpen, /if \(!slot\) \{ lostFace\('That password was turned off — ask Philip for a new one'\); return; \}/);
  assert.match(faceOpen, /if \(!raw\) \{ lostFace\('Face ID needs setting up again — type a password'\); return; \}/);
  assert.match(faceOpen, /await opened\(m, got, /, 'the same way on as a password');
  assert.match(fn('lostFace'), /dropFace\(\);\s*setFace\(null\);\s*if \(rec\) unknownPasskey\(rec\.rp, rec\.id\);/);
  // a ban keeps the Face ID record (the unban brings it back); the ban screen has no Face ID button
  assert.doesNotMatch(fn('banned'), /Face|face/);
  // the offer: only after a typed password (not a remembered one, not Face ID), once per folder
  // (after Face ID failed on this page, the right password offers to set it up again: its passkey may be gone)
  assert.match(fn('opened'), /if \(typed && await offerFace\(m, doc, got, !!face && faceFailed\)\) return;\s*start\(m, doc\);/);
  assert.match(fn('offerFace'), /if \(!webauthn \|\| \(face && !again\) \|\| noFace\(\)\) return false;/);
  assert.match(fn('offerFace'), /offerUi\(again \? 'again' : 'ask'\);/);
  // NOT NOW: never asked again — except after 'set up again', where the old setup simply stays
  assert.match(code, /faceNo\.onclick = function \(\) \{[\s\S]*?if \(!offer\.again\) setNoFace\('later'\);[\s\S]*?letsGo\(\);/);
  // one passkey per folder: its user id is kept, so setting Face ID up again replaces the old passkey
  assert.match(fn('faceTap'), /user: \{ id: faceUser\(\), name: 'Phortnite', displayName: 'Phortnite' \}/);
  assert.match(fn('faceUser'), /localStorage\.setItem\(FACEUSER, b64url\(id\)\);/);
  // passkeys that open nothing any more are reported to the device (it may delete them), never the one in use
  assert.match(code, /faceForget\.onclick = function \(\) \{[\s\S]*?unknownPasskey\(rec\.rp, rec\.id\);/);
  assert.match(fn('cantFace'), /if \(o\.id\) unknownPasskey\(location\.hostname, o\.id\);/);
  assert.doesNotMatch(faceOpen, /unknownPasskey/, 'a failed scan never gives the passkey up');
  // typing on a touch screen: the Face ID button steps aside so the keyboard doesn't cover UNLOCK
  assert.match(code, /if \('ontouchstart' in window\) \{[\s\S]*?input\.addEventListener\('focus', function \(\) \{ clearTimeout\(typing\); root\.classList\.add\('ls-typing'\); \}\);/);
  // (and it comes back only a moment after the box loses focus, so a tap on UNLOCK lands where it was aimed)
  assert.match(code, /typing = setTimeout\(function \(\) \{ root\.classList\.remove\('ls-typing'\); \}, 400\);/);
  assert.match(fn('cantFace'), /setNoFace\('unsupported'\);/);
  // Face ID on: the remembered password goes (it would skip the face), and none is kept while it is on
  assert.match(fn('faceMade'), /if \(saveFace\(rec\)\) \{ forget\(\); setFace\(rec\); \}\s*letsGo\(\);/);
  assert.match(fn('unlock'), /if \(!face && \(auto \|\| remember\.checked\)\) store\(normalize\(password\)\); else forget\(\);/);
  assert.match(code, /setFace\(webauthn \? readFace\(\) : null\);\s*if \(face\) forget\(\);/);
  for (const s of ["'Scan your face instead of typing the password. (Touch ID works too.)'", "'TURN ON FACE ID'", "'One more scan to finish'",
    "'This device can’t use Face ID for Phortnite — keep using your password.'", 'Passwords app (or Settings › Passwords)']) assert.ok(code.includes(s), s);
  const markup = fs.readFileSync(path.join(ROOT, 'tools', 'lockscreen', 'lock.html'), 'utf8');
  for (const s of ['id="ls-face-go"', 'UNLOCK WITH FACE ID', 'or type a password', 'id="ls-face-forget"', '>Forget Face ID on this device<', '🙂</span> Use Face ID next time?',
    'id="ls-face-on"', '>TURN ON FACE ID<', 'id="ls-face-no"', '>NOT NOW<', 'id="ls-offer-text"']) assert.ok(markup.includes(s), s);
  // big enough to tap on an iPad: the Face ID buttons are .ls-go (60 px), NOT NOW 56 px, the text buttons 44 px
  const css = fs.readFileSync(path.join(ROOT, 'tools', 'lockscreen', 'lock.css'), 'utf8');
  assert.match(markup, /id="ls-face-go" class="btn yellow ls-go"/);
  assert.match(markup, /id="ls-face-on" class="btn yellow ls-go"/);
  assert.match(css, /\.ls-face-no \{[^}]*min-height: 56px/);
  assert.match(css, /\.ls-link \{[^}]*min-height: 44px/);
  assert.match(markup, /id="ls-face-forget" class="ls-link /);
  // the classes the page's <head> puts on <html> are styled only as html.<class>: a bare rule for one
  // (say .ls-faceid { display: none }) would hide the whole page; and no element of the lock screen has one
  const headCls = [...HEAD_SCRIPT.matchAll(/c\.add\('([\w-]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(headCls, ['ls-auto', 'ls-banned', 'ls-faceid']);
  const allCss = css + fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'style.css'), 'utf8');
  for (const c of headCls) {
    const uses = [...allCss.matchAll(new RegExp(`(\\S*)\\.${c}(?![\\w-])`, 'g'))];
    assert.ok(uses.length > 0, c);
    for (const m of uses) assert.equal(m[1], 'html', `.${c} only as html.${c}`);
    assert.ok(!new RegExp(`class="[^"]*\\b${c}\\b`).test(markup), c);
  }
});

test('lock: closed — its own key and ONE code for Philip, the unban code kept; the build says closed; lock.js never strikes or forgets while closed', async () => {
  const dir = tmp('closed');
  const file = path.join(dir, 'closed.json');
  // never over the normal slots file, never over an earlier closed file without --force
  const over = cli(['closed', '--slots', path.join(ROOT, 'lock', 'slots.json'), '--iter', String(ITER), '--allow-weak']);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /never over lock\/slots\.json/);
  const r = cli(['closed', '--slots', file, '--text', 'Back on Friday!\nSee you', '--iter', String(ITER), '--allow-weak']);
  assert.equal(r.status, 0, r.stderr);
  const codes = [...r.stdout.matchAll(/^\s+([A-Z0-9]{8})$/gm)].map((m) => m[1]);
  assert.equal(codes.length, 1, 'one code, printed once');
  const code = codes[0];
  assert.ok(isValidPassword(code));
  assert.match(r.stdout, /shown only this once/);
  const again = cli(['closed', '--slots', file, '--iter', String(ITER), '--allow-weak']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--force/);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(code), 'no code in the file');
  const doc = JSON.parse(text);
  assert.equal(doc.slots.length, 1);
  assert.deepEqual(doc.closed, { text: 'Back on Friday! See you' });
  const normal = JSON.parse(fs.readFileSync(path.join(ROOT, 'lock', 'slots.json'), 'utf8'));
  if (normal.unban) assert.deepEqual(doc.unban, normal.unban, 'the unban code stays the same');
  assert.ok(await unlockSlots(doc, code), 'the code opens it');
  assert.equal(await unlockSlots(doc, PASSWORDS[0]), null);
  // the build: lock.json says closed (with the message), and only the code builds it
  const out = path.join(dir, 'site');
  const built = cli(['build', '--slots', file, '--out', out, '--allow-weak'], { PHORTNITE_PASSWORD: code });
  assert.equal(built.status, 0, built.stderr);
  const lock = JSON.parse(fs.readFileSync(path.join(out, 'lock.json'), 'utf8'));
  assert.deepEqual(lock.closed, { text: 'Back on Friday! See you' });
  assert.equal(lock.slots.length, 1);
  for (const f of walkFiles(out)) assert.ok(!fs.readFileSync(path.join(out, f)).toString('latin1').includes(code), `${f} contains the code`);
  // a normal build has no "closed"
  const site2 = path.join(dir, 'open');
  await buildLocked({ slots: await shared.then((s) => s.doc), password: PASSWORDS[1], outDir: site2 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(site2, 'lock.json'), 'utf8')).closed, undefined);

  // lock.js: while closed a wrong password is not a strike, a remembered password is not forgotten,
  // Face ID is not dropped, Philip's code is not remembered and offers no Face ID
  const js = fs.readFileSync(LOADER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const fn = (name) => new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`).exec(js)[0];
  const unlock = fn('unlock');
  const closedPart = /if \(!got && m\.closed\) \{[\s\S]*?\n {6}\}/.exec(unlock)[0];
  assert.ok(unlock.indexOf(closedPart) < unlock.indexOf('ban.strikes++'), 'closed is handled before any strike');
  assert.ok(unlock.indexOf('if (isBanned(ban)) { banned(); return; }') < unlock.indexOf(closedPart), 'a banned device stays banned');
  assert.doesNotMatch(closedPart, /strikes|saveBan|forget\(|store\(|dropFace|lostFace/);
  assert.match(unlock, /if \(!m\.closed\) \{ if \(!face && \(auto \|\| remember\.checked\)\) store\(normalize\(password\)\); else forget\(\); \}/);
  assert.match(unlock, /await opened\(m, got, function \(m2\) \{ return unwrap\(m2, password\); \}, !auto && !m\.closed\);/);
  const faceOpen = fn('faceOpen');
  assert.ok(faceOpen.indexOf('if (m.closed)') > 0 && faceOpen.indexOf('if (m.closed)') < faceOpen.indexOf('lostFace('), 'Face ID is kept while closed');
  assert.doesNotMatch(fn('closeUp'), /dropFace|forget\(|saveBan|strikes\+\+/);
  assert.match(js, /if \(m && m\.closed\) closeUp\(m\.closed\);/);
  const markup = fs.readFileSync(path.join(ROOT, 'tools', 'lockscreen', 'lock.html'), 'utf8');
  assert.ok(markup.includes('id="ls-closed"') && markup.includes('Closed for now'));
  fs.rmSync(dir, { recursive: true, force: true });
});
