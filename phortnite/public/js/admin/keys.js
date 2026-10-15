// Philip's admin keys, and the crypto every page uses to check his commands. DOM-free on purpose:
// test/admin.test.mjs runs it in Node, and tools/admin.mjs makes admin.json with it. WebCrypto only
// (globalThis.crypto.subtle: every browser, and Node 22).
//
// admin.json, next to index.html (made by `node tools/admin.mjs new --out public/admin.json`):
//   { v: 1, sign: { pub }, box: { pub }, enc: { kdf: 'PBKDF2-SHA256', iter, salt, iv, ct } }
//   sign.pub  ECDSA P-256 public key (spki, base64): every page checks admin commands with it
//   box.pub   ECDH P-256 public key (spki, base64): every page seals its player card to it, so the
//             public broker only ever carries ciphertext (no names)
//   enc       the two PRIVATE keys ({sign, box}: pkcs8, base64, as JSON), AES-256-GCM encrypted with
//             a key PBKDF2-SHA256 makes from the admin password. Useless without the password.
// The admin password is never stored anywhere (tools/admin.mjs prints it once). Unlocking gives
// non-extractable CryptoKeys: they can sign and open, but nobody (not this page either) can read
// them back out.
//
// API
//   loadConfig(json)                  -> cfg (a clean copy) | null when it isn't a valid admin.json
//   importPublic(cfg)                 -> { signPub, boxPub } CryptoKeys (verify / seal to)
//   unlockAdmin(cfg, password)        -> { sign, box } non-extractable private CryptoKeys | null
//   keysMatch(cfg|pubs, keys)         -> true when the private keys belong to the public ones
//   signCommand(signKey, body)        -> { ...body, sig } (body: { v, cmd, args, to, ts, n })
//   verifyCommand(signPub, env)       -> true | false (never throws)
//   sealToAdmin(boxPub, obj, info, { from }) -> { e, iv, ct } (base64): only the admin can open it
//   openSealed(boxPriv, sealed, info, { max }) -> obj | null
//                                        (info: SEAL_CARD (default), the player cards for the admin,
//                                        SEAL_PAGE, a command's args sealed to one page's own key, or
//                                        SEAL_UP, what a page uploads to the admin: chat lines, a chat
//                                        log, a report (js/admin/commands.js sealUpload). from: seal
//                                        with this page's own key (newBoxKey) instead of a fresh one,
//                                        so e is that page's public key: the admin can tell an upload
//                                        really came from the page whose card he has. max: the
//                                        longest ct accepted, in base64 characters (default 2000))
//   newBoxKey()                       -> { priv, pub, raw } a page's own ECDH key for this page load
//                                        (priv non-extractable; raw: the public key, base64)
//   importBoxPub(raw)                 -> the ECDH public CryptoKey for a raw base64 key | null
//   createAdminConfig(password, opts) -> admin.json's object (tools/admin.mjs, tests)
//   canonical(body), randomNonce(), normalizeAdminPassword(p), ADMIN_ALPHABET, ADMIN_PASSWORD_LENGTH
// Nothing in here is ever logged: not the password, not a key.

export const ADMIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I (like the lock's passwords)
export const ADMIN_PASSWORD_LENGTH = 12;
export const ADMIN_ITER = 600000;
// round counts read from admin.json are only trusted within these bounds: a crafted file with a
// billion rounds would freeze the iPad that tries a password on it
export const MIN_ITER = 100000;
export const MAX_ITER = 2000000;
const ENC_AAD = new TextEncoder().encode('phortnite admin keys v1'); // binds the ciphertext to its job
// HKDF info: what a seal is for (a card for the admin can't pass as a command's args, or back)
export const SEAL_CARD = 'phortnite admin seal v1';
export const SEAL_PAGE = 'phortnite page seal v1';
export const SEAL_UP = 'phortnite admin up v1'; // a page's upload to the admin (never confused with a card)
const EC_SIGN = { name: 'ECDSA', namedCurve: 'P-256' };
const EC_BOX = { name: 'ECDH', namedCurve: 'P-256' };
const SIG_ALG = { name: 'ECDSA', hash: 'SHA-256' };

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function rand(n) { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; }

// base64 over raw bytes (chunked so fromCharCode never overflows)
export function b64(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(String(str));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
/** A base64 string of at most `max` characters that decodes, else null. */
function b64ok(s, max) {
  if (typeof s !== 'string' || !s || s.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try { return unb64(s); } catch (e) { return null; }
}

/** What people type: any case, spaces and dashes ignored (like the lock screen's passwords). */
export function normalizeAdminPassword(p) {
  return String(p || '').toUpperCase().replace(/[\s\-‐-―−]+/g, '');
}

/** 12 random bytes, base64 (a command's nonce). */
export function randomNonce() { return b64(rand(12)); }

// ------------------------------------------------------------------ admin.json

/** admin.json checked and copied (unknown fields dropped), or null. Never throws. */
export function loadConfig(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d || typeof d !== 'object' || d.v !== 1) return null;
    const signPub = d.sign && b64ok(d.sign.pub, 400), boxPub = d.box && b64ok(d.box.pub, 400);
    const e = d.enc;
    if (!signPub || !boxPub || !e || typeof e !== 'object' || e.kdf !== 'PBKDF2-SHA256') return null;
    if (!Number.isInteger(e.iter) || e.iter < MIN_ITER || e.iter > MAX_ITER) return null;
    const salt = b64ok(e.salt, 200), iv = b64ok(e.iv, 40), ct = b64ok(e.ct, 4000);
    if (!salt || salt.length < 16 || !iv || iv.length !== 12 || !ct || ct.length < 32) return null;
    return Object.freeze({
      v: 1, sign: Object.freeze({ pub: d.sign.pub }), box: Object.freeze({ pub: d.box.pub }),
      enc: Object.freeze({ kdf: e.kdf, iter: e.iter, salt: e.salt, iv: e.iv, ct: e.ct }),
    });
  } catch (err) { return null; }
}

/** The public keys every page uses: { signPub (verify), boxPub (seal to) }. Rejects on a bad key. */
export async function importPublic(cfg) {
  const signPub = await subtle().importKey('spki', unb64(cfg.sign.pub), EC_SIGN, true, ['verify']);
  const boxPub = await subtle().importKey('spki', unb64(cfg.box.pub), EC_BOX, true, []);
  return { signPub, boxPub };
}

async function passwordKey(password, salt, iter, usage) {
  const base = await subtle().importKey('raw', enc.encode(normalizeAdminPassword(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, usage);
}

/**
 * The private keys, from admin.json and the admin password: { sign, box } (non-extractable), or
 * null for a wrong password or a broken file. Never throws.
 */
export async function unlockAdmin(cfg, password) {
  try {
    if (!cfg || !normalizeAdminPassword(password)) return null;
    const e = cfg.enc;
    if (!Number.isInteger(e.iter) || e.iter < MIN_ITER || e.iter > MAX_ITER) return null;
    const key = await passwordKey(password, unb64(e.salt), e.iter, ['decrypt']);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: ENC_AAD }, key, unb64(e.ct));
    const inner = JSON.parse(dec.decode(plain));
    // (extractable false: from here on the keys can be used, never read)
    const sign = await subtle().importKey('pkcs8', unb64(inner.sign), EC_SIGN, false, ['sign']);
    const box = await subtle().importKey('pkcs8', unb64(inner.box), EC_BOX, false, ['deriveBits']);
    const keys = { sign, box };
    // the pair of the public keys everyone checks with (a mixed-up admin.json opens nothing)
    return (await keysMatch(cfg, keys)) ? keys : null;
  } catch (err) { return null; }
}

/** Do these private keys belong to cfg's public keys (or { signPub, boxPub })? Never throws. */
export async function keysMatch(cfgOrPubs, keys) {
  try {
    const pubs = cfgOrPubs && cfgOrPubs.signPub ? cfgOrPubs : await importPublic(cfgOrPubs);
    const probe = { v: 1, cmd: 'probe', args: {}, to: '*', ts: 0, n: randomNonce() };
    if (!(await verifyCommand(pubs.signPub, await signCommand(keys.sign, probe)))) return false;
    const n = randomNonce();
    const back = await openSealed(keys.box, await sealToAdmin(pubs.boxPub, { n }));
    return !!back && back.n === n;
  } catch (err) { return false; }
}

/**
 * A new admin.json for `password` (tools/admin.mjs; tests pass a smaller iter): the key pairs are
 * made here, and only the encrypted private keys leave this function.
 */
export async function createAdminConfig(password, { iter = ADMIN_ITER } = {}) {
  if (!normalizeAdminPassword(password)) throw new Error('an admin password is needed');
  if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) throw new Error(`iter must be ${MIN_ITER}..${MAX_ITER}`);
  const s = await subtle().generateKey(EC_SIGN, true, ['sign', 'verify']);
  const x = await subtle().generateKey(EC_BOX, true, ['deriveBits']);
  const inner = enc.encode(JSON.stringify({
    sign: b64(await subtle().exportKey('pkcs8', s.privateKey)),
    box: b64(await subtle().exportKey('pkcs8', x.privateKey)),
  }));
  const salt = rand(16), iv = rand(12);
  const key = await passwordKey(password, salt, iter, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: ENC_AAD }, key, inner));
  inner.fill(0);
  return {
    v: 1,
    sign: { pub: b64(await subtle().exportKey('spki', s.publicKey)) },
    box: { pub: b64(await subtle().exportKey('spki', x.publicKey)) },
    enc: { kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) },
  };
}

// ------------------------------------------------------------------ signed commands

/**
 * Keys sorted at every level: the same object always gives the same text. (A prototype-free copy:
 * a received '__proto__' key stays a key, so the signature covers every key that came in.)
 */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  const out = Object.create(null);
  for (const k of Object.keys(v).sort()) out[k] = sorted(v[k]);
  return out;
}

/** The exact text a command's signature covers: {v, cmd, args, to, ts, n} in that order. */
export function canonical(b) {
  return JSON.stringify({ v: b.v, cmd: b.cmd, args: sorted(b.args === undefined ? {} : b.args), to: b.to, ts: b.ts, n: b.n });
}

/** Sign a command body: the envelope { v, cmd, args, to, ts, n, sig } (sig: base64 P1363 r||s). */
export async function signCommand(signKey, body) {
  const env = { v: body.v, cmd: body.cmd, args: body.args === undefined ? {} : body.args, to: body.to, ts: body.ts, n: body.n };
  const sig = await subtle().sign(SIG_ALG, signKey, enc.encode(canonical(env)));
  return { ...env, sig: b64(new Uint8Array(sig)) };
}

/** Is env signed by the admin key? Only the signature (freshness, nonce and 'to' are commands.js's). */
export async function verifyCommand(signPub, env) {
  try {
    if (!env || typeof env !== 'object') return false;
    const sig = b64ok(env.sig, 200);
    if (!sig || sig.length !== 64) return false;
    return await subtle().verify(SIG_ALG, signPub, sig, enc.encode(canonical(env)));
  } catch (err) { return false; }
}

// ------------------------------------------------------------------ sealed cards

/** AES-256-GCM key for a seal: HKDF-SHA256 over the ECDH secret, salted with the ephemeral key. */
async function sealKey(secret, ephemeralRaw, usage, info) {
  const ikm = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ephemeralRaw, info: enc.encode(info) }, ikm, { name: 'AES-GCM', length: 256 }, false, usage);
}

/**
 * Seal obj so that only the holder of boxPub's private key can read it (the admin's box key, or a
 * page's own key: info SEAL_PAGE): a fresh ECDH P-256 key pair per seal, its secret through
 * HKDF-SHA256 into AES-256-GCM. { e, iv, ct } in base64.
 * from: a page's own key ({ priv, raw }: newBoxKey) to seal with instead of a fresh pair (a page's
 * uploads, SEAL_UP). e is then that page's public key, and only that page (or the admin) can make
 * a seal that opens with it: the admin checks e against the key in the page's card. (The same AES
 * key for all of that page's seals, each with its own random 96-bit iv: a few hundred per page
 * load at most.)
 */
export async function sealToAdmin(boxPub, obj, info = SEAL_CARD, { from = null } = {}) {
  let raw, priv;
  if (from && from.priv && typeof from.raw === 'string') {
    raw = unb64(from.raw);
    priv = from.priv;
  } else {
    const eph = await subtle().generateKey(EC_BOX, true, ['deriveBits']);
    raw = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
    priv = eph.privateKey;
  }
  const secret = await subtle().deriveBits({ name: 'ECDH', public: boxPub }, priv, 256);
  const key = await sealKey(secret, raw, ['encrypt'], info);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { e: b64(raw), iv: b64(iv), ct: b64(ct) };
}

/**
 * Open a seal with its private key: the object, or null (not for this key or job, tampered, or a
 * ct longer than max base64 characters: 2000 fits a card or a command's args; an upload passes more).
 */
export async function openSealed(boxPriv, sealed, info = SEAL_CARD, { max = 2000 } = {}) {
  try {
    if (!boxPriv || !sealed || typeof sealed !== 'object') return null;
    const raw = b64ok(sealed.e, 120), iv = b64ok(sealed.iv, 24), ct = b64ok(sealed.ct, max);
    if (!raw || raw.length !== 65 || !iv || iv.length !== 12 || !ct) return null;
    const pub = await subtle().importKey('raw', raw, EC_BOX, false, []);
    const secret = await subtle().deriveBits({ name: 'ECDH', public: pub }, boxPriv, 256);
    const key = await sealKey(secret, raw, ['decrypt'], info);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(dec.decode(plain));
  } catch (err) { return null; }
}

/**
 * This page's own ECDH key (one per page load, like the presence id): its public half rides in the
 * page's sealed card, so only the admin learns it; he seals the private parts of a command for
 * this page to it (names, texts, reasons), and only this page can open them.
 */
export async function newBoxKey() {
  const k = await subtle().generateKey(EC_BOX, false, ['deriveBits']);
  return { priv: k.privateKey, pub: k.publicKey, raw: b64(new Uint8Array(await subtle().exportKey('raw', k.publicKey))) };
}

/** A page's public key from its card (raw, base64), or null when it isn't one. Never throws. */
export async function importBoxPub(raw) {
  try {
    const bytes = b64ok(raw, 120);
    if (!bytes || bytes.length !== 65) return null;
    return await subtle().importKey('raw', bytes, EC_BOX, true, []);
  } catch (err) { return null; }
}
