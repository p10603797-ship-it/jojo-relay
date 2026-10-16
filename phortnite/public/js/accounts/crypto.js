// DOM-free crypto for player accounts, built on WebCrypto (globalThis.crypto.subtle — the browser
// and Node 22 both have it). test/accounts.test.mjs exercises every function here.
//   - a password is protected with PBKDF2-SHA256 (>= 150 000 rounds, random salt); only the hash is
//     ever stored, never the password itself.
//   - "Move my account" turns a profile into a short transfer code: the JSON encrypted with AES-GCM
//     under a key derived from a PIN the player sets. The code carries nowhere by itself — the
//     player types it (or scans the QR) on the other device, with the PIN, to bring the account over.
//   - a per-profile signing identity (an HMAC secret) is generated and held for a LATER admin stage
//     to sign commands with. Nothing destructive is signed now (see sign() — stage 2 uses this).
// Nothing in here is ever logged: not passwords, not PINs, not hashes, not keys.

const PW_ROUNDS = 150000; // password hashing cost
const PIN_ROUNDS = 200000; // transfer-code key derivation cost
// round counts read back from storage or from a transfer code are only trusted within these bounds:
// a crafted code with a billion rounds would freeze the iPad that imports or signs into it
export const MIN_ROUNDS = 100000;
export const MAX_ROUNDS = 2000000;
const sane = (n) => Number.isInteger(n) && n >= MIN_ROUNDS && n <= MAX_ROUNDS;
const TRANSFER_TAG = 'PHA1'; // transfer-code format marker (Phortnite Account v1)

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function rand(n) { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; }

// base64 / base64url over raw bytes (small payloads; chunked so fromCharCode never overflows)
function b64(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(String(str));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (str) => unb64(String(str).replace(/-/g, '+').replace(/_/g, '/'));

/** Constant-time-ish compare of two byte arrays (one is the stored hash). */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2Bits(password, salt, iterations, bits = 256) {
  const base = await subtle().importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, bits));
}

async function pbkdf2AesKey(password, salt, iterations, usage) {
  const base = await subtle().importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, usage);
}

// ------------------------------------------------------------------ passwords

/** Hash a password for storage: { v, salt, iter, hash }. The password is never kept. */
export async function hashPassword(password, rounds = PW_ROUNDS) {
  const salt = rand(16);
  const hash = await pbkdf2Bits(password, salt, rounds);
  return { v: 1, salt: b64(salt), iter: rounds, hash: b64(hash) };
}

/** True when password matches the stored record (false for anything malformed — never throws). */
export async function verifyPassword(password, rec) {
  try {
    if (!rec || typeof rec !== 'object' || !rec.salt || !rec.hash || !sane(rec.iter)) return false;
    const got = await pbkdf2Bits(password, unb64(rec.salt), rec.iter);
    return sameBytes(got, unb64(rec.hash));
  } catch (e) { return false; }
}

// ------------------------------------------------------------------ account transfer (Move my account)

/**
 * Encrypt a profile object into a transfer code under a short PIN. AES-GCM's tag means a wrong PIN
 * or a tampered code fails to decrypt (no profile leaks). Returns a 'PHA1.<base64url>' string.
 */
export async function encryptTransfer(obj, pin) {
  const salt = rand(16), iv = rand(12);
  const key = await pbkdf2AesKey(pin, salt, PIN_ROUNDS, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const payload = { v: 1, iter: PIN_ROUNDS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  return `${TRANSFER_TAG}.${b64url(enc.encode(JSON.stringify(payload)))}`;
}

/**
 * Decrypt a transfer code with the PIN -> the original object. Throws on a bad code, the wrong PIN,
 * or a tampered code (the caller shows a friendly "check the PIN" message). The thrown error carries
 * .bad = 'format' | 'pin' so the UI can tell a typo'd code from a wrong PIN.
 */
export async function decryptTransfer(code, pin) {
  let payload;
  try {
    const m = String(code).trim().match(new RegExp(`^${TRANSFER_TAG}\\.([A-Za-z0-9_-]+)$`));
    if (!m) throw new Error('bad');
    payload = JSON.parse(dec.decode(unb64url(m[1])));
    if (!payload || !payload.salt || !payload.iv || !payload.ct || !sane(payload.iter)) throw new Error('bad');
  } catch (e) {
    throw Object.assign(new Error("That code doesn't look right. Check you typed it all."), { bad: 'format' });
  }
  try {
    const key = await pbkdf2AesKey(pin, unb64(payload.salt), payload.iter, ['decrypt']);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, key, unb64(payload.ct));
    return JSON.parse(dec.decode(plain));
  } catch (e) {
    throw Object.assign(new Error('Wrong PIN — try again.'), { bad: 'pin' });
  }
}

// ------------------------------------------------------------------ signing identity (stage 2 uses this)

/**
 * Generate a per-profile signing identity: an HMAC-SHA256 secret held in the profile. A LATER admin
 * stage signs admin commands with it (Philip's panel). Nothing destructive is signed in stage 1 —
 * this only reserves the key so accounts made now already carry one.
 */
export async function makeSigningIdentity() {
  return { alg: 'HMAC-SHA256', created: Date.now(), key: b64(rand(32)) };
}

/** HMAC-SHA256(message) under a signing identity -> base64url. Harmless helper for stage 2. */
export async function sign(message, identity) {
  if (!identity || !identity.key) return '';
  const key = await subtle().importKey('raw', unb64(identity.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await subtle().sign('HMAC', key, enc.encode(String(message)));
  return b64url(new Uint8Array(mac));
}

/** A stored password record that is safe to keep (from this device or a transfer code), else null. */
export function cleanPwRecord(rec) {
  try {
    if (!rec || typeof rec !== 'object' || !sane(rec.iter)) return null;
    const salt = unb64(rec.salt), hash = unb64(rec.hash);
    if (salt.length < 8 || salt.length > 64 || hash.length !== 32) return null;
    return { v: 1, salt: b64(salt), iter: rec.iter, hash: b64(hash) };
  } catch (e) { return null; }
}

export const _internal = { b64, unb64, b64url, unb64url, rand };
