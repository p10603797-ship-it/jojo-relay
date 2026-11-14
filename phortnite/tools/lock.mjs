#!/usr/bin/env node
// The locked website: the published game only opens with a password.
//
// The repository and the website are public, so a password check in JavaScript alone would not
// keep anyone out (they could read or skip it). Instead the game's code is ENCRYPTED: every module
// under public/js and public/shared goes into one archive, encrypted with AES-256-GCM under a random
// 256-bit content key K. K itself is stored once per password ("key slots"): each password is
// stretched with PBKDF2-HMAC-SHA256 (600,000 rounds, one shared random salt) into a key that
// encrypts K. The page (lock.js) asks for a password, unwraps K with it, decrypts the archive and
// runs the game from blob: URLs through an import map. No password and no key is ever written to
// the repository or the website; lock/slots.json only holds the wrapped copies of K.
// Face ID / Touch ID needs nothing from this tool: lock.js keeps a copy of K on the device itself,
// encrypted with a secret from the device's passkey and bound to the key slot of the password typed
// when it was set up (so `remove` and `new --force` turn it off with that password).
//
//   node tools/lock.mjs new --count 10 [--slots lock/slots.json] [--force]
//       a new key and salt, N new random passwords printed ONCE (write them down)
//   node tools/lock.mjs build --out <dir> [--slots ...]                  (needs a password)
//       the locked website in <dir> (any one working password unlocks the key for the build)
//   node tools/lock.mjs add --count 2 [--slots ...]                       (needs a password)
//       more passwords for the same key
//   node tools/lock.mjs remove --slot 3 [--slots ...]
//       turn one password off (takes effect once the next build is published; Face ID set up with
//       that password stops working too). This is a soft
//       revoke: the game key stays the same, and the old slot is still in git history, so someone
//       who has that password and knows how could still open later builds. To shut a password out
//       completely, start over with `new --force` (a new key and new passwords for everyone).
//   node tools/lock.mjs list [--slots ...]
//       the slot numbers in use
//   node tools/lock.mjs unban-code [--slots ...]
//       Philip's unban code, printed ONCE. Three wrong passwords in a row ban a device (lock.js keeps
//       that in the device's own storage); on the ban screen this code lifts it. slots.json (and so
//       lock.json) only gets a PBKDF2 verifier of it. Works from the next published build on.
//   node tools/lock.mjs closed [--text "message"] [--slots lock/closed.json] [--force]
//       CLOSE the game for everyone: a separate slots file (default lock/closed.json) with its own new
//       game key and ONE new code for Philip (printed ONCE), his unban code's verifier copied from
//       lock/slots.json, and "closed": { text }. Publish `build --slots lock/closed.json` (with that
//       code in PHORTNITE_PASSWORD): the lock screen says "Closed for now" with the message, and only
//       the code opens it. The usual passwords can't (another key), but a wrong one is not a strike
//       there, and remembered passwords and Face ID are kept, so OPENING again is just publishing a
//       normal build (`build` with lock/slots.json): everyone's passwords, remembered devices and
//       Face ID work again as before.
//
// The password comes from the PHORTNITE_PASSWORD environment variable (or is typed, hidden, when
// run in a terminal), never from the command line (that would land in the shell history).
// Fewer PBKDF2 rounds than 600,000 are for tests only: `new --iter N` and `build`/`add` on such
// slots all refuse unless --allow-weak is given too (so a real site can't get weak slots by mistake).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomInt, webcrypto, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { init as lexerReady, parse as lexModule } from 'es-module-lexer';
/** es-module-lexer is WebAssembly: await this once before rewriteModule (collectModules does). */
export const ready = () => lexerReady();

const subtle = webcrypto.subtle;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DEFAULT_SLOTS = path.join(ROOT, 'lock', 'slots.json');
/** the lock screen: loader script, its stylesheet and markup (copied into the locked index.html) */
export const SCREEN_DIR = path.join(HERE, 'lockscreen');

export const ITERATIONS = 600000;
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read and type
export const PASSWORD_LENGTH = 8;
export const UNBAN_LENGTH = 10;
/** wrong passwords in a row that ban a device (lock.js: STRIKES) */
export const STRIKES = 3;
/** where a device keeps its wrong-password count / ban (lock.js: BAN, COOKIE; IndexedDB too) */
export const BAN_KEY = 'phortnite.ban';
export const BAN_COOKIE = 'phortnite_ban';
export const PREFIX = '@phortnite/';
export const ARCHIVES = { gz: 'game.lock', raw: 'game.raw.lock' };
/** directories of public/ whose modules are encrypted (and never copied as plaintext) */
const MODULE_DIRS = ['js', 'shared'];
/** server-only local copies of the libraries (npm start); never part of the website */
const SKIP_DIRS = ['vendor'];

// import.meta is meaningless in a blob: module. The only use allowed is the texture worker's
// fallback in textures.js, which asks the loader (globalThis.__phortniteModuleURL) first.
const IMPORT_META_OK = { 'js/gfx/textures.js': 1 };
// import(expression) can't be rewritten. Allowed only where the expression is a fixed absolute URL.
const DYNAMIC_EXPR_OK = { 'js/net/p2p.js': ['PEERJS_URL'] };

export class LockError extends Error {}

const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));
const randomBytes = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const slotAad = (n) => enc.encode(`phortnite-slot:${n}`);
const archiveAad = (kind) => enc.encode(`phortnite-archive:${kind}`);

// ------------------------------------------------------------------ passwords

/** The form a password is checked in: capitals, no spaces or dashes ("abcd-2345" = "ABCD2345"). */
export function normalize(p) {
  return String(p == null ? '' : p).toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]+/g, '');
}

/** 8 characters from ALPHABET with at least 2 letters and 2 digits. */
export function isValidPassword(p) {
  if (typeof p !== 'string' || p.length !== PASSWORD_LENGTH) return false;
  let letters = 0, digits = 0;
  for (const c of p) {
    if (!ALPHABET.includes(c)) return false;
    if (c >= '0' && c <= '9') digits++; else letters++;
  }
  return letters >= 2 && digits >= 2;
}

/** A random password (crypto.randomInt: the system's secure random numbers; rejection keeps it uniform). */
export function generatePassword() {
  for (;;) {
    let p = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++) p += ALPHABET[randomInt(ALPHABET.length)];
    if (isValidPassword(p)) return p;
  }
}

export function generatePasswords(count) {
  const out = new Set();
  while (out.size < count) out.add(generatePassword());
  return [...out];
}

// ------------------------------------------------------------------ key slots

/** PBKDF2-HMAC-SHA256(normalize(password), salt, iter) -> an AES-256-GCM key (the same as lock.js). */
export async function deriveKek(password, salt, iter) {
  const base = await subtle.importKey('raw', enc.encode(normalize(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapSlot(kek, K, n) {
  const iv = randomBytes(12);
  const wk = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: slotAad(n) }, kek, K));
  return { n, iv: b64(iv), wk: b64(wk) };
}

const isUnban = (u) => !!u && typeof u.salt === 'string' && Number.isInteger(u.iter) && u.iter >= 1 && typeof u.hash === 'string';
const isClosed = (c) => !!c && typeof c === 'object' && !Array.isArray(c) && (c.text === undefined || typeof c.text === 'string');
export const CLOSED_FILE = path.join(ROOT, 'lock', 'closed.json');
export const CLOSED_TEXT_MAX = 300;

function checkSlotsDoc(doc) {
  if (!doc || doc.v !== 1 || typeof doc.salt !== 'string' || !Number.isInteger(doc.iter) || doc.iter < 1 || !Array.isArray(doc.slots)
    || (doc.next !== undefined && !Number.isInteger(doc.next)) || (doc.unban !== undefined && !isUnban(doc.unban))
    || (doc.closed !== undefined && !isClosed(doc.closed))
    || doc.slots.some((s) => !s || !Number.isInteger(s.n) || typeof s.iv !== 'string' || typeof s.wk !== 'string')) {
    throw new LockError('the slots file is not a Phortnite key slots file (v 1)');
  }
  return doc;
}

/**
 * The number the next new password gets: one past every number ever handed out. `next` is a
 * high-water mark that `remove` never lowers, so a number on Philip's written list always means
 * the same password (even after the highest one was removed).
 */
const nextSlot = (doc) => Math.max(Number.isInteger(doc.next) ? doc.next : 1, doc.slots.reduce((m, s) => Math.max(m, s.n), 0) + 1);

/** Each password gets a slot; returns the slots document (no secrets in it). */
export async function makeSlots(K, passwords, { iter = ITERATIONS, salt = randomBytes(16), first = 1 } = {}) {
  const doc = {
    about: 'Key slots for the locked Phortnite website (tools/lock.mjs). Each slot is the game key encrypted with one password; no password or key is stored here.',
    v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), next: first, slots: [],
  };
  const passwordsOut = [];
  let n = first;
  for (const p of passwords) {
    const kek = await deriveKek(p, salt, iter);
    doc.slots.push(await wrapSlot(kek, K, n));
    passwordsOut.push({ n, password: normalize(p) });
    n++;
  }
  doc.next = n;
  return { doc, passwords: passwordsOut };
}

/** A new key, salt and `count` new passwords. */
export async function newSlots({ count = 10, iter = ITERATIONS } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new LockError('--count must be 1..100');
  const K = randomBytes(32);
  const { doc, passwords } = await makeSlots(K, generatePasswords(count), { iter });
  return { doc, passwords, K };
}

/** The content key K from any slot this password opens, or null. One PBKDF2 for all slots. */
export async function unlockSlots(doc, password) {
  checkSlotsDoc(doc);
  const kek = await deriveKek(password, unb64(doc.salt), doc.iter);
  for (const s of doc.slots) {
    try {
      const K = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv), additionalData: slotAad(s.n) }, kek, unb64(s.wk)));
      if (K.length === 32) return { K, n: s.n };
    } catch (e) { /* not this slot */ }
  }
  return null;
}

async function requireKey(doc, password) {
  if (!password) throw new LockError('set PHORTNITE_PASSWORD to one of the current passwords (it is needed to read the game key)');
  const got = await unlockSlots(doc, password);
  if (!got) throw new LockError('that password does not open any of the key slots (wrong, or turned off)');
  return got;
}

/** `count` more passwords for the same key (new slot numbers, never one used before). */
export async function addSlots(doc, password, count) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new LockError('--count must be 1..100');
  const { K } = await requireKey(doc, password);
  const salt = unb64(doc.salt);
  const first = nextSlot(doc);
  const passwords = generatePasswords(count);
  const out = { ...doc, slots: [...doc.slots] };
  const shown = [];
  let n = first;
  for (const p of passwords) {
    out.slots.push(await wrapSlot(await deriveKek(p, salt, doc.iter), K, n));
    shown.push({ n, password: p });
    n++;
  }
  out.next = n;
  return { doc: out, passwords: shown };
}

/** Turn one password off: its slot goes (the last one can't, or nobody could build again). */
export function removeSlot(doc, n) {
  checkSlotsDoc(doc);
  if (!doc.slots.some((s) => s.n === n)) throw new LockError(`there is no slot ${n} (slots: ${doc.slots.map((s) => s.n).join(', ') || 'none'})`);
  if (doc.slots.length === 1) throw new LockError('that is the last password; make a new set with `new --force` instead');
  // (keep the high-water mark: the removed number is never handed out again)
  return { ...doc, next: nextSlot(doc), slots: doc.slots.filter((s) => s.n !== n) };
}

export function readSlots(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new LockError(`can't read the slots file ${file}: ${e.message}`); }
  return checkSlotsDoc(doc);
}

export function writeSlots(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// ------------------------------------------------------------------ Philip's unban code

/** A random unban code: UNBAN_LENGTH characters from ALPHABET (crypto.randomInt, like the passwords). */
export function generateUnbanCode() {
  let c = '';
  for (let i = 0; i < UNBAN_LENGTH; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

/** PBKDF2-HMAC-SHA256(normalize(code), salt, iter), 256 bits (lock.js's unbanOk computes the same). */
async function unbanHash(code, salt, iter) {
  const base = await subtle.importKey('raw', enc.encode(normalize(code)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256));
}

/** The public verifier of an unban code, { salt, iter, hash }: the website can check a code with it. */
export async function makeUnban(code, { iter = ITERATIONS, salt = randomBytes(16) } = {}) {
  return { salt: b64(salt), iter, hash: b64(await unbanHash(code, salt, iter)) };
}

/** Does `code` match the verifier? */
export async function checkUnban(unban, code) {
  const want = unb64(unban.hash), got = await unbanHash(code, unb64(unban.salt), unban.iter);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The slots for a CLOSED website: a new game key and one new code (for Philip), marked closed with
 * `text` (Philip's message on the lock screen; '' = lock.js's own). `unban`: the unban code's
 * verifier to keep (from the normal slots file). Returns { doc, code } (the code: show it once).
 */
export async function closedSlots({ text = '', unban, iter = ITERATIONS } = {}) {
  const { doc, passwords } = await newSlots({ count: 1, iter });
  doc.about = 'Key slots for the CLOSED Phortnite website (tools/lock.mjs closed): its own game key, opened only by Philip\'s code. No password or key is stored here.';
  doc.closed = { text: String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CLOSED_TEXT_MAX) };
  if (unban) doc.unban = unban;
  return { doc, code: passwords[0].password };
}

/** A new unban code for the slots document (replacing any earlier one): { doc, code }. */
export async function setUnban(doc, { iter = ITERATIONS } = {}) {
  checkSlotsDoc(doc);
  const code = generateUnbanCode();
  return { doc: { ...doc, unban: await makeUnban(code, { iter }) }, code };
}

// ------------------------------------------------------------------ modules

const isAbsoluteUrl = (s) => /^[a-z][a-z0-9+.-]*:/i.test(s);
const isRelative = (s) => s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..';

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/**
 * One module with every relative specifier turned into '@phortnite/<path from the site root>'.
 * `known` is the set of module paths ('js/main.js', …). Problems go into `errors`.
 */
export function rewriteModule(file, src, known, errors) {
  let imports;
  try { [imports] = lexModule(src, file); } catch (e) { errors.push(`${file}: can't parse (${e.message})`); return src; }
  const edits = [];
  let metas = 0;
  for (const im of imports) {
    if (im.type === 'import-meta') { metas++; continue; }
    const where = `${file}:${src.slice(0, im.start).split('\n').length}`;
    const raw = src.slice(im.start, im.end);
    if (im.type === 'dynamic' && (im.specifier === undefined || im.glob)) {
      if (!(DYNAMIC_EXPR_OK[file] || []).includes(raw.trim())) {
        errors.push(`${where}: import(${raw}) is computed, so it can't be locked; use a string literal (or allow a fixed absolute URL in DYNAMIC_EXPR_OK)`);
      }
      continue;
    }
    const spec = im.specifier;
    if (typeof spec !== 'string') { errors.push(`${where}: unexpected ${im.type} import`); continue; }
    if (isAbsoluteUrl(spec)) continue; // https://cdn…, data:, blob:
    if (spec.startsWith('/')) { errors.push(`${where}: '${spec}' is relative to the web server's root, which the locked site can't know`); continue; }
    if (!isRelative(spec)) continue; // bare: 'three', 'three/addons/…', 'rapier' (the import map)
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (target.startsWith('../') || !known.has(target)) { errors.push(`${where}: '${spec}' -> ${target} is not a module under public/js or public/shared`); continue; }
    if (!/^[\w./-]+$/.test(target)) { errors.push(`${where}: '${target}' has characters the import map can't take`); continue; }
    // static: start..end is the text between the quotes; dynamic: the whole string literal
    if (im.type === 'dynamic') {
      const q = raw[0];
      if (!(q === "'" || q === '"' || q === '`') || raw[raw.length - 1] !== q || raw.slice(1, -1) !== spec) { errors.push(`${where}: can't rewrite import(${raw})`); continue; }
      edits.push([im.start, im.end, `'${PREFIX}${target}'`]);
    } else {
      if (raw !== spec) { errors.push(`${where}: the specifier ${raw} uses escapes; write it plainly`); continue; }
      edits.push([im.start, im.end, `${PREFIX}${target}`]);
    }
  }
  const allowed = IMPORT_META_OK[file] || 0;
  if (metas > allowed) errors.push(`${file}: uses import.meta, which has no meaning in a locked (blob:) module`);
  if (allowed && metas && !src.includes('__phortniteModuleURL')) errors.push(`${file}: import.meta without the globalThis.__phortniteModuleURL seam`);
  let out = src;
  for (const [a, b, s] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + s + out.slice(b);
  return out;
}

/** Every module under public/js and public/shared, rewritten: { 'js/main.js': source, … }. */
export async function collectModules(publicDir = PUBLIC_DIR) {
  await lexerReady();
  const errors = [];
  const paths = [];
  for (const d of MODULE_DIRS) {
    for (const r of walk(publicDir, d)) {
      if (r.split('/').some((p) => p.startsWith('.'))) continue; // .DS_Store, editor swap files: never published
      if (r.endsWith('.js')) paths.push(r);
      else errors.push(`${r}: lock.mjs only knows how to lock .js modules here`);
    }
  }
  const known = new Set(paths);
  const files = {};
  for (const p of paths) files[p] = rewriteModule(p, fs.readFileSync(path.join(publicDir, p), 'utf8'), known, errors);
  // every '@phortnite/' import must land in the archive, and nothing relative may be left
  for (const [p, s] of Object.entries(files)) {
    for (const im of lexModule(s, p)[0]) {
      const spec = im.specifier;
      if (typeof spec !== 'string') continue;
      if (spec.startsWith(PREFIX) && !known.has(spec.slice(PREFIX.length))) errors.push(`${p}: ${spec} is not in the archive`);
      if (isRelative(spec)) errors.push(`${p}: '${spec}' was left relative`);
    }
  }
  if (!files['js/main.js']) errors.push('public/js/main.js is missing');
  if (errors.length) throw new LockError(`can't lock the modules:\n  ${errors.join('\n  ')}`);
  return files;
}

// ------------------------------------------------------------------ the locked site

export function readVersion(publicDir = PUBLIC_DIR) {
  const m = /export const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(publicDir, 'shared', 'constants.js'), 'utf8'));
  if (!m) throw new LockError("can't find VERSION in public/shared/constants.js");
  return m[1];
}

const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

/**
 * Where a page remembers its password (localStorage key; lock.js uses the very same expression).
 * One per folder of the website: the main site and /beta/ share an origin, and one of them must
 * never forget ("turned off") a password the other one still takes.
 */
export const STORE_EXPR = "'phortnite.pass:' + location.pathname.replace(/[^/]*$/, '')";

/**
 * Where a page keeps its Face ID record (lock.js: FACE), one per folder like the password. The
 * record is the game key encrypted with a secret that only this device's passkey for the website
 * gives out, after Face ID / Touch ID: no face data, no password. (lock.js, "Face ID", has the rest.)
 */
export const FACE_EXPR = "'phortnite.face:' + location.pathname.replace(/[^/]*$/, '')";

/**
 * The page's first-frame check, in its <head>: a banned device (localStorage or the cookie say
 * STRIKES or more, the way lock.js's readSync reads them) shows the ban screen from the first
 * frame (html.ls-banned), never the prompt or "Unlocking…"; otherwise Face ID set up (where the
 * browser has WebAuthn) shows its button (html.ls-faceid), or a remembered password shows
 * "Unlocking…" (html.ls-auto). (IndexedDB can only answer later: lock.js asks it.)
 */
export const HEAD_SCRIPT = '<script>(function (c) { var b = false, m;'
  + ` try { b = parseInt(localStorage.getItem('${BAN_KEY}'), 10) >= ${STRIKES}; } catch (e) {}`
  + ` try { m = /(?:^|;\\s*)${BAN_COOKIE}=(\\d+)/.exec(document.cookie); b = b || (!!m && +m[1] >= ${STRIKES}); } catch (e) {}`
  + ` if (b) c.add('ls-banned'); else try { if (typeof PublicKeyCredential === 'function' && localStorage.getItem(${FACE_EXPR})) c.add('ls-faceid');`
  + ` else if (localStorage.getItem(${STORE_EXPR})) c.add('ls-auto'); } catch (e) {}`
  + ' })(document.documentElement.classList);</script>';

/** index.html without its import map and main.js, with the lock screen and lock.js instead. */
export function lockIndexHtml(html, { loaderHash = '' } = {}) {
  const maps = [...html.matchAll(/[ \t]*<script type="importmap">([\s\S]*?)<\/script>[ \t]*\n?/g)];
  if (maps.length !== 1) throw new LockError(`index.html: expected exactly one <script type="importmap">, found ${maps.length}`);
  let imports;
  try { imports = JSON.parse(maps[0][1]).imports; } catch (e) { throw new LockError(`index.html: the import map is not JSON (${e.message})`); }
  if (!imports || typeof imports !== 'object') throw new LockError('index.html: the import map has no "imports"');
  if (Object.keys(imports).some((k) => k.startsWith(PREFIX))) throw new LockError(`index.html: the import map already uses ${PREFIX}`);
  const main = '<script type="module" src="js/main.js"></script>';
  if (html.split(main).length !== 2) throw new LockError(`index.html: expected exactly one ${main}`);
  const css = fs.readFileSync(path.join(SCREEN_DIR, 'lock.css'), 'utf8').replace(/^\n+|\s+$/g, '');
  const markup = fs.readFileSync(path.join(SCREEN_DIR, 'lock.html'), 'utf8').trim();
  // banned: the ban screen from the first frame; a remembered password: "Unlocking…", never the prompt
  const head = `  <!-- the lock screen (tools/lock.mjs): the game is encrypted; lock.js opens it with a password -->\n`
    + `  ${HEAD_SCRIPT}\n`
    + `  <style>\n${css}\n  </style>\n`;
  // (replacer functions: the inserted text is taken literally, '$' and all)
  let out = html.replace(maps[0][0], () => '');
  if (!out.includes('</head>')) throw new LockError('index.html: no </head>');
  out = out.replace('</head>', () => `${head}</head>`);
  out = out.replace(main, () => `${markup}\n  <script src="lock.js${loaderHash ? `?h=${loaderHash}` : ''}"></script>`);
  if (/<script[^>]*type="module"/.test(out) || /<script type="importmap">/.test(out)) throw new LockError('index.html: a module script or import map is left');
  return { html: out, imports };
}

/** The top-level names an earlier build wrote (its lock.json lists them), or []. */
function earlierBuild(out) {
  try {
    const built = JSON.parse(fs.readFileSync(path.join(out, 'lock.json'), 'utf8')).built;
    return Array.isArray(built) ? built.filter((b) => typeof b === 'string' && b && !/[\\/]|^\.\.?$|^\.git$/.test(b)) : [];
  } catch (e) { return []; }
}

/** Checks --out and empties it. Call only once everything that can fail has been checked. */
function prepareOut(outDir, publicDir, names) {
  const out = path.resolve(outDir), pub = path.resolve(publicDir);
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  if (inside(out, pub) || inside(pub, out)) throw new LockError(`--out ${out} must be outside ${pub}`);
  if (fs.existsSync(out)) {
    // only an empty folder or an earlier locked build (nothing else in it) is replaced: never, say,
    // a gh-pages checkout with its .git and beta/ folder. "Ours" = what this build writes, plus
    // what the earlier build says it wrote (a file since removed from public/ is still ours).
    const items = fs.readdirSync(out);
    const ours = new Set([...names, ...earlierBuild(out)]);
    const other = items.filter((i) => !ours.has(i));
    if (items.length && (!items.includes('lock.json') || other.length)) {
      throw new LockError(`--out ${out} must be an empty folder or an earlier locked build${other.length ? ` (it has ${other.slice(0, 5).join(', ')})` : ''}`);
    }
    for (const i of items) fs.rmSync(path.join(out, i), { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true });
  return out;
}

async function aesGcm(K, data, kind) {
  const iv = randomBytes(12);
  const key = await subtle.importKey('raw', K, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: archiveAad(kind) }, key, data));
  return { iv, ct };
}

/** Slots with fewer PBKDF2 rounds than ITERATIONS are for tests only. */
export function checkStrength(doc, allowWeak) {
  if (doc.iter < ITERATIONS && !allowWeak) {
    throw new LockError(`these key slots use only ${doc.iter} PBKDF2 rounds (the website needs ${ITERATIONS}), so they are for tests only; `
      + 'make real ones with `new --force`, or pass --allow-weak for a test build');
  }
  // (the unban code's verifier is public in lock.json too: as hard to guess at as the passwords)
  if (doc.unban && doc.unban.iter < ITERATIONS && !allowWeak) {
    throw new LockError(`the unban code uses only ${doc.unban.iter} PBKDF2 rounds (the website needs ${ITERATIONS}), so it is for tests only; `
      + 'make a real one with `unban-code`, or pass --allow-weak for a test build');
  }
}

/**
 * The locked website in outDir. `password` (any working one) opens K from the slots, so the same
 * passwords keep working build after build. Returns a summary (no secrets).
 * `allowWeak`: accept slots with fewer than 600,000 PBKDF2 rounds (tests only).
 */
export async function buildLocked({ slots, password, outDir, publicDir = PUBLIC_DIR, allowWeak = false }) {
  if (!outDir) throw new LockError('--out <dir> is required');
  checkSlotsDoc(slots);
  checkStrength(slots, allowWeak);
  const { K, n } = await requireKey(slots, password);
  const version = readVersion(publicDir);
  const files = await collectModules(publicDir);
  const loader = fs.readFileSync(path.join(SCREEN_DIR, 'lock.js'), 'utf8');
  const { html, imports } = lockIndexHtml(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), { loaderHash: shortHash(loader) });

  const archive = enc.encode(JSON.stringify({ v: 1, version, main: 'js/main.js', files }));
  const gz = zlib.gzipSync(archive, { level: 9 });
  // a fresh random IV for every encryption (never one IV twice with the same K)
  const egz = await aesGcm(K, gz, 'gz');
  let eraw;
  do eraw = await aesGcm(K, archive, 'raw'); while (Buffer.compare(eraw.iv, egz.iv) === 0);

  // everything else public/ has is copied as it is: check it all before touching --out
  const copy = [];
  for (const r of walk(publicDir)) {
    const top = r.split('/')[0];
    if (MODULE_DIRS.includes(top) || SKIP_DIRS.includes(top) || r === 'index.html' || r.split('/').some((p) => p.startsWith('.'))) continue;
    if (/\.(m?js|cjs)$/.test(r)) throw new LockError(`public/${r}: a script outside js/ and shared/ would be published as plaintext; move it or teach lock.mjs about it`);
    copy.push(r);
  }
  // .nojekyll: GitHub Pages serves the files as they are (no Jekyll run)
  const written = ['index.html', 'lock.js', 'lock.json', ARCHIVES.gz, ARCHIVES.raw, '.nojekyll'];
  const built = [...new Set([...copy.map((r) => r.split('/')[0]), ...written])].sort();

  const lock = {
    v: 1, version, kdf: 'PBKDF2-SHA256', iter: slots.iter, salt: slots.salt,
    slots: slots.slots.map((s) => ({ n: s.n, iv: s.iv, wk: s.wk })),
    imports, main: 'js/main.js',
    files: { gz: { path: ARCHIVES.gz, iv: b64(egz.iv) }, raw: { path: ARCHIVES.raw, iv: b64(eraw.iv) } },
    built, // (the names this build writes at the top of --out: the next build may replace them)
  };
  // Philip's unban code: only its verifier (lock.js hides "Philip: unban" without one)
  if (slots.unban) lock.unban = { salt: slots.unban.salt, iter: slots.unban.iter, hash: slots.unban.hash };
  // closed (`closed` slots): lock.js says so, takes only Philip's code, and never strikes
  if (slots.closed) lock.closed = { text: String(slots.closed.text || '').slice(0, CLOSED_TEXT_MAX) };

  const out = prepareOut(outDir, publicDir, built);
  const copied = [];
  for (const r of copy) {
    fs.mkdirSync(path.join(out, path.dirname(r)), { recursive: true });
    fs.copyFileSync(path.join(publicDir, r), path.join(out, r));
    copied.push(r);
  }
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'lock.js'), loader);
  fs.writeFileSync(path.join(out, 'lock.json'), `${JSON.stringify(lock, null, 1)}\n`);
  fs.writeFileSync(path.join(out, ARCHIVES.gz), egz.ct);
  fs.writeFileSync(path.join(out, ARCHIVES.raw), eraw.ct);
  return {
    outDir: out, version, slot: n, slots: slots.slots.length, modules: Object.keys(files).length,
    bytes: { source: archive.length, gz: egz.ct.length, raw: eraw.ct.length }, copied,
  };
}

/** Decrypt a locked build's archive with K (tests and checks): { v, version, main, files }. */
export async function openArchive(outDir, K, kind = 'gz') {
  const lock = JSON.parse(fs.readFileSync(path.join(outDir, 'lock.json'), 'utf8'));
  const f = lock.files[kind];
  const key = await subtle.importKey('raw', K, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv), additionalData: archiveAad(kind) }, key, fs.readFileSync(path.join(outDir, f.path))));
  return JSON.parse(Buffer.from(kind === 'gz' ? zlib.gunzipSync(plain) : plain).toString('utf8'));
}

// ------------------------------------------------------------------ command line

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new LockError(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'force' || k === 'help' || k === 'allow-weak') { opts[k] = true; continue; }
    if (k === 'password' || k.startsWith('password=')) throw new LockError('give the password in PHORTNITE_PASSWORD, never on the command line');
    if (!['count', 'slots', 'out', 'slot', 'iter', 'text'].includes(k)) throw new LockError(`unknown option ${a}`);
    if (i + 1 >= rest.length) throw new LockError(`${a} needs a value`);
    opts[k] = rest[++i];
  }
  return { cmd, opts };
}

const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new LockError(`${name} must be a whole number`);
  return n;
};

const USAGE = `usage:
  node tools/lock.mjs new --count 10 [--slots lock/slots.json] [--force]
  node tools/lock.mjs build --out <dir> [--slots lock/slots.json]   (password: PHORTNITE_PASSWORD, or typed)
  node tools/lock.mjs add --count 2 [--slots lock/slots.json]        (password: PHORTNITE_PASSWORD, or typed)
  node tools/lock.mjs remove --slot 3 [--slots lock/slots.json]
  node tools/lock.mjs list [--slots lock/slots.json]
  node tools/lock.mjs unban-code [--slots lock/slots.json]
  node tools/lock.mjs closed [--text "message"] [--slots lock/closed.json] [--force]   (close the game: one code for Philip)
tests only: new/unban-code --iter <rounds below ${ITERATIONS}> --allow-weak; build/add --allow-weak take such slots`;

function printPasswords(list, log) {
  log('');
  log('  Passwords (shown only this once: write them down, they are not saved anywhere):');
  log('');
  for (const { n, password } of list) log(`    ${String(n).padStart(3)}   ${password}`);
  log('');
}

/** --iter: fewer rounds than ITERATIONS only when asked for in so many words (--allow-weak). */
function iterOption(opts, log) {
  const iter = opts.iter ? int(opts.iter, '--iter') : ITERATIONS;
  if (iter < 1) throw new LockError('--iter must be at least 1');
  if (iter < ITERATIONS && !opts['allow-weak']) throw new LockError(`--iter below ${ITERATIONS} is for tests only (add --allow-weak if that is what this is)`);
  if (iter < ITERATIONS) log(`  (testing only: ${iter} PBKDF2 rounds instead of ${ITERATIONS})`);
  return iter;
}

/** Type the password in a terminal without showing it (when PHORTNITE_PASSWORD is not set). */
function askPassword(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve('');
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let s = '';
    const done = (value) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(s);
        if (ch === '\u0003') return done(''); // Ctrl-C
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  const { cmd, opts } = parseArgs(argv);
  if (!cmd || opts.help || cmd === 'help') { log(USAGE); return 0; }
  const slotsFile = path.resolve(opts.slots || (cmd === 'closed' ? CLOSED_FILE : DEFAULT_SLOTS));
  // (asked for only once the slots file has been read and checked)
  const getPassword = async () => env.PHORTNITE_PASSWORD || askPassword('Phortnite password (not shown): ');
  if (cmd === 'new') {
    if (fs.existsSync(slotsFile) && !opts.force) {
      throw new LockError(`${slotsFile} exists: a new set replaces every password. Use add/remove, or --force to start over`);
    }
    const iter = iterOption(opts, log);
    // Philip's unban code has nothing to do with the game key: starting over keeps it
    let unban;
    try { unban = fs.existsSync(slotsFile) ? readSlots(slotsFile).unban : undefined; } catch (e) { /* a broken file: nothing to keep */ }
    const { doc, passwords } = await newSlots({ count: int(opts.count ?? 10, '--count'), iter });
    if (unban) doc.unban = unban;
    writeSlots(slotsFile, doc);
    printPasswords(passwords, log);
    log(`  ${passwords.length} key slots written to ${slotsFile} (no passwords in it).${unban ? ' The unban code stays the same.' : ''}`);
    return 0;
  }
  if (cmd === 'closed') {
    if (path.resolve(slotsFile) === path.resolve(DEFAULT_SLOTS)) throw new LockError('closed slots go in their own file (default lock/closed.json), never over lock/slots.json');
    if (fs.existsSync(slotsFile) && !opts.force) throw new LockError(`${slotsFile} exists: --force makes a new closed key and code (the old code stops working)`);
    const iter = iterOption(opts, log);
    // the unban code stays Philip's: its verifier comes from the normal slots file (if it has one)
    let unban;
    try { unban = fs.existsSync(DEFAULT_SLOTS) ? readSlots(DEFAULT_SLOTS).unban : undefined; } catch (e) { /* none to keep */ }
    const { doc, code } = await closedSlots({ text: opts.text || '', unban, iter });
    writeSlots(slotsFile, doc);
    log('');
    log('  Philip\'s code for the CLOSED game (shown only this once: write it down, it is not saved anywhere):');
    log('');
    log(`    ${code}`);
    log('');
    log(`  Written to ${slotsFile}.${unban ? ' The unban code stays the same.' : ''}`);
    log(`  Close the website: PHORTNITE_PASSWORD=<that code> node tools/lock.mjs build --slots ${path.relative(process.cwd(), slotsFile) || slotsFile} --out <dir>, then publish it.`);
    log('  Open it again: publish a normal build (lock/slots.json) — everyone\'s passwords work as before.');
    return 0;
  }
  if (cmd === 'add') {
    const doc = readSlots(slotsFile);
    checkStrength(doc, opts['allow-weak']);
    const count = int(opts.count ?? 1, '--count');
    const { doc: next, passwords } = await addSlots(doc, await getPassword(), count);
    writeSlots(slotsFile, next);
    printPasswords(passwords, log);
    log(`  ${slotsFile} now has ${next.slots.length} slots. Publish a new build for them to work.`);
    return 0;
  }
  if (cmd === 'remove') {
    if (opts.slot === undefined) throw new LockError('--slot <number> is required');
    const next = removeSlot(readSlots(slotsFile), int(opts.slot, '--slot'));
    writeSlots(slotsFile, next);
    log(`  Slot ${opts.slot} removed; ${next.slots.length} left (${next.slots.map((s) => s.n).join(', ')}). The lock screen stops taking it once a new build is published.`);
    log('  (The game key stays the same. If that password reached someone who must be shut out completely,');
    log('  run `new --force` instead: a new key, and new passwords for everyone.)');
    return 0;
  }
  if (cmd === 'list') {
    const doc = readSlots(slotsFile);
    log(`  ${doc.slots.length} slots: ${doc.slots.map((s) => s.n).join(', ')}  (PBKDF2-SHA256, ${doc.iter} rounds)`);
    log(doc.unban ? '  An unban code is set.' : '  No unban code yet (`unban-code` makes one).');
    return 0;
  }
  if (cmd === 'unban-code') {
    const doc = readSlots(slotsFile); // (it is kept next to the key slots: make those first, with `new`)
    const { doc: next, code } = await setUnban(doc, { iter: iterOption(opts, log) });
    writeSlots(slotsFile, next);
    log('');
    log('  Unban code (shown only this once: write it down, it is not saved anywhere):');
    log('');
    log(`    ${code}`);
    log('');
    log('  On a banned device tap "Philip: unban" and type it. It works once a new build is published'
      + `${doc.unban ? ', and from then on the earlier unban code no longer does' : ''}.`);
    log(`  ${slotsFile} holds only a check for it (PBKDF2-SHA256), not the code.`);
    return 0;
  }
  if (cmd === 'build') {
    const slots = readSlots(slotsFile);
    checkStrength(slots, opts['allow-weak']); // (before asking for a password)
    if (slots.iter < ITERATIONS) console.warn(`  WARNING: test build: these key slots use only ${slots.iter} PBKDF2 rounds; never publish it.`);
    if (!opts.out) throw new LockError('--out <dir> is required');
    const r = await buildLocked({ slots, password: await getPassword(), outDir: opts.out, allowWeak: !!opts['allow-weak'] });
    log(`  Locked v${r.version}: ${r.modules} modules, ${r.slots} passwords (unlocked with slot ${r.slot}).`);
    log(`  Archive ${(r.bytes.gz / 1024).toFixed(0)} KB (gzip) / ${(r.bytes.raw / 1024).toFixed(0)} KB (plain), ${r.copied.length} other files.`);
    log(`  Written to ${r.outDir}`);
    return 0;
  }
  throw new LockError(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`lock: ${e instanceof LockError ? e.message : e.stack || e}`);
    process.exitCode = 1;
  });
}
