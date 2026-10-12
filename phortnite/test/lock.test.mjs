// The locked website (tools/lock.mjs): passwords, key slots, the encrypted build and the loader.
// Slots here use 1,000 PBKDF2 rounds so the tests are quick; real ones use 600,000.
// Every password in this file is made up for the tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { parse as lexModule, init as lexInit } from 'es-module-lexer';
import {
  ALPHABET, ITERATIONS, PREFIX, PUBLIC_DIR, ROOT, LockError, normalize, isValidPassword, generatePassword, generatePasswords,
  makeSlots, newSlots, unlockSlots, addSlots, removeSlot, buildLocked as buildLockedStrict, openArchive, rewriteModule, ready, lockIndexHtml,
  collectModules, STORE_EXPR,
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
  // the only places the password goes: PBKDF2, and localStorage when "Remember" is ticked
  assert.match(code, /localStorage\.setItem\(STORE, p\)/);
  // one remembered password per folder of the site (/ and /beta/ share an origin), the same key
  // the page's <head> checks for its first frame
  assert.ok(code.includes(`var STORE = ${STORE_EXPR};`), 'STORE is STORE_EXPR');
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
