// The player-account store: every profile on THIS device, kept in localStorage. No backend, nothing
// to sign up for — siblings/friends sharing an iPad each get their own profile, saved on the iPad.
// Everything is wrapped so private mode / blocked storage degrades to guest play (the store simply
// holds nothing and never persists). test/accounts.test.mjs drives it with an in-memory storage.
//
// On disk (key 'phortnite.accounts'):
//   { v, active: <id|null>, profiles: [ account, ... ] }
// An account:
//   { id, schema, name, skin, createdAt, isAdmin, pw, passkey, sign, stats, cosmetics }
//     pw       : a PBKDF2 record from crypto.hashPassword, or null (no password)
//     passkey  : { id, salt } for a Face ID / Touch ID platform passkey (PRF), or null
//     sign     : the signing identity (crypto.makeSigningIdentity) — stage 2 signs admin commands
//     isAdmin  : NOT settable from normal UI; a later stage unlocks it with Philip's credential
//   stats is a stats.js object. A GUEST profile is the same shape with guest:true and is NEVER
//   written to disk (its progress lasts only for the session).
//     imported : when it was brought over with a transfer code (ms), or 0 (made on this device)
// onChange(fn) -> off: fn(what, account, info) after 'create', 'import' or 'remove' (the account
// registry, js/accounts/registry.js, deletes a removed account's entry, unless info.quiet; the
// admin's ban list is checked again for a new one, js/admin/client.js).
// A transfer code ("Move my account") carries the account's id and createdAt, so the moved account
// is the SAME account (the same registry id: the admin's ACCOUNTS tab follows it to the new iPad);
// the id is only kept when it is well-formed and not already on this device. A banned account
// can't be brought over (js/ui/accounts.js asks the ban list first), and one the ban list catches
// later on an iPad it was moved to is taken off that iPad quietly instead of banning the iPad
// (remove(id, { quiet: true }), js/admin/client.js checkBans): the 'imported' mark tells them apart.
import { defaultStats, sanitizeStats } from './stats.js';
import { cleanPwRecord } from './crypto.js';

const KEY = 'phortnite.accounts';
const ACCOUNT_SCHEMA = 1; // bump to migrate account records
const LEGACY_PROFILE = 'phortnite.profile'; // the old single-profile XP save (migrated once)
const LEGACY_SETTINGS = 'phortnite.settings';
const MIGRATED = 'phortnite.accountsMigrated';

const randId = () => {
  try {
    const a = new Uint8Array(9); globalThis.crypto.getRandomValues(a);
    return 'p_' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return 'p_' + Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16); }
};

const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16);
const ID_RE = /^p_[0-9a-f]{6,40}$/; // randId's ids (a transfer code's id is only kept like this)

/** Cosmetics as a small flat map (id -> true/number/short text): nothing else is ever kept. */
function cleanCosmetics(c) {
  const out = {};
  if (!c || typeof c !== 'object' || Array.isArray(c)) return out;
  let n = 0;
  for (const k of Object.keys(c)) {
    if (n >= 200) break;
    const v = c[k];
    if (k.length > 40) continue;
    if (typeof v === 'boolean' || Number.isFinite(v) || (typeof v === 'string' && v.length <= 40)) { out[k] = v; n++; }
  }
  return out;
}

/** Coerce one account record read off disk into a valid shape (unknown fields dropped). */
function sanitizeAccount(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string') return null;
  return {
    id: a.id,
    schema: Number.isFinite(a.schema) ? a.schema : ACCOUNT_SCHEMA,
    name: cleanName(a.name) || 'Player',
    skin: Number.isFinite(a.skin) ? Math.max(0, Math.floor(a.skin)) : 0,
    createdAt: Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
    isAdmin: a.isAdmin === true, // kept if present; never set from normal UI
    pw: cleanPwRecord(a.pw),
    passkey: a.passkey && typeof a.passkey === 'object' && a.passkey.id ? { id: String(a.passkey.id), salt: a.passkey.salt ? String(a.passkey.salt) : '' } : null,
    sign: a.sign && typeof a.sign === 'object' && a.sign.key ? a.sign : null,
    stats: sanitizeStats(a.stats),
    cosmetics: cleanCosmetics(a.cosmetics),
    imported: Number.isFinite(a.imported) && a.imported > 0 ? Math.floor(a.imported) : 0,
  };
}

export class AccountStore {
  /** storage: a Web-Storage-like object (getItem/setItem/removeItem). Defaults to localStorage. */
  constructor(storage) {
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.data = { v: 1, active: null, profiles: [] };
    this.guest = null; // the current session-only profile, if any (never persisted)
    // Which protected profile has been unlocked THIS session (its password / Face ID entered). Kept
    // only in memory: a reload starts locked again, so a protected profile is never "active" from
    // disk alone. Nothing to do with the device site-lock — this is per-profile, inside the game.
    this._unlocked = null;
    this._fns = [];
    this._read();
  }

  /** fn(what, account, info) after 'create' | 'import' | 'remove' (info.quiet). Returns a function that stops it. */
  onChange(fn) {
    this._fns.push(fn);
    return () => { this._fns = this._fns.filter((f) => f !== fn); };
  }

  _emit(what, acc, info = {}) {
    for (const fn of [...this._fns]) {
      try { fn(what, acc, info); } catch (e) { /* a listener's problem never breaks the store */ }
    }
  }

  // ---------------------------------------------------------------- storage (never throws)
  _raw(k) { try { return this.storage ? this.storage.getItem(k) : null; } catch (e) { return null; } }
  _put(k, v) { try { if (this.storage) this.storage.setItem(k, v); } catch (e) { /* private mode */ } }
  _del(k) { try { if (this.storage) this.storage.removeItem(k); } catch (e) { /* private mode */ } }

  _read() {
    let d = null;
    try { d = JSON.parse(this._raw(KEY) || 'null'); } catch (e) { d = null; }
    if (d && typeof d === 'object' && Array.isArray(d.profiles)) {
      const profiles = d.profiles.map(sanitizeAccount).filter(Boolean);
      const active = typeof d.active === 'string' && profiles.some((p) => p.id === d.active) ? d.active : null;
      this.data = { v: 1, active, profiles };
    }
    this._migrateLegacy();
  }

  /** Persist the real profiles (the guest is intentionally left out). */
  save() {
    this._put(KEY, JSON.stringify({ v: 1, active: this.data.active, profiles: this.data.profiles }));
  }

  // ---------------------------------------------------------------- legacy migration (runs once)
  _migrateLegacy() {
    if (this._raw(MIGRATED) || this.data.profiles.length) { if (!this._raw(MIGRATED)) this._put(MIGRATED, '1'); return; }
    let legacy = null, settings = null;
    try { legacy = JSON.parse(this._raw(LEGACY_PROFILE) || 'null'); } catch (e) { legacy = null; }
    try { settings = JSON.parse(this._raw(LEGACY_SETTINGS) || 'null'); } catch (e) { settings = null; }
    // only bother if the player had made some progress before accounts existed
    if (legacy && typeof legacy === 'object') {
      const acc = this._newAccount({ name: (settings && settings.name) || 'Player', skin: (settings && settings.skin) | 0 });
      acc.stats = sanitizeStats(legacy);
      this.data.profiles.push(acc);
      // not made active: the "Who's playing?" screen shows it as a card to pick (keeps the old progress)
      this.save();
    }
    this._put(MIGRATED, '1');
  }

  // ---------------------------------------------------------------- reads
  /** Lightweight cards for the "Who's playing?" screen. */
  list() {
    return this.data.profiles.map((p) => ({
      id: p.id, name: p.name, skin: p.skin, level: p.stats.level,
      protected: !!(p.pw || p.passkey), hasPassword: !!p.pw, hasPasskey: !!p.passkey, isAdmin: p.isAdmin,
    }));
  }

  get(id) { return this.data.profiles.find((p) => p.id === id) || null; }

  /** The active account object (a real profile or the session guest), or null when nobody is signed in. */
  active() {
    if (this.guest && this.data.active === this.guest.id) return this.guest;
    const acc = this.get(this.data.active);
    if (!acc) return null;
    // A protected profile loaded from disk is NOT "active" until it's been unlocked this session
    // (its password / Face ID entered). So saveSettings, the account panel and anything else that
    // reads active() can never touch a locked profile before the player proves it's theirs.
    if ((acc.pw || acc.passkey) && this._unlocked !== acc.id) return null;
    return acc;
  }

  /**
   * The profile chosen on disk, even when it's still locked behind its password — the sign-in gate
   * needs to know WHICH profile to ask for. Guest or nobody chosen -> null.
   */
  selected() {
    const id = this.data.active;
    if (!id || (this.guest && id === this.guest.id)) return null;
    return this.get(id);
  }

  isProtected(id) { const p = this.get(id); return !!(p && (p.pw || p.passkey)); }

  // ---------------------------------------------------------------- writes
  _newAccount({ name, skin }) {
    return {
      id: randId(), schema: ACCOUNT_SCHEMA, name: cleanName(name) || 'Player', skin: skin | 0,
      createdAt: Date.now(), isAdmin: false, pw: null, passkey: null, sign: null,
      stats: defaultStats(), cosmetics: {}, imported: 0,
    };
  }

  /**
   * Create and persist a new account. opts: { name, skin, pw, passkey, sign, makeActive }.
   * pw/passkey/sign are built by the UI (crypto.js) and passed in; isAdmin is never accepted here.
   */
  create(opts = {}) {
    const acc = this._newAccount(opts);
    if (opts.pw && typeof opts.pw === 'object') acc.pw = opts.pw;
    if (opts.passkey && typeof opts.passkey === 'object') acc.passkey = { id: String(opts.passkey.id), salt: opts.passkey.salt ? String(opts.passkey.salt) : '' };
    if (opts.sign && typeof opts.sign === 'object') acc.sign = opts.sign;
    this.data.profiles.push(acc);
    // just created it (and set any password) -> unlocked for this session, so active() returns it
    if (opts.makeActive !== false) { this.guest = null; this.data.active = acc.id; this._unlocked = acc.id; }
    this.save();
    this._emit('create', acc);
    return acc;
  }

  /** Shallow-merge a patch into an account (name/skin/pw/passkey/stats/cosmetics). isAdmin ignored. */
  update(id, patch = {}) {
    const acc = this.get(id);
    if (!acc) return null;
    if (patch.name !== undefined) acc.name = cleanName(patch.name) || acc.name;
    if (patch.skin !== undefined && Number.isFinite(patch.skin)) acc.skin = Math.max(0, Math.floor(patch.skin));
    if (patch.pw !== undefined) acc.pw = patch.pw && patch.pw.salt ? patch.pw : null;
    if (patch.passkey !== undefined) acc.passkey = patch.passkey && patch.passkey.id ? { id: String(patch.passkey.id), salt: patch.passkey.salt ? String(patch.passkey.salt) : '' } : null;
    if (patch.sign !== undefined && patch.sign && patch.sign.key) acc.sign = patch.sign;
    if (patch.cosmetics && typeof patch.cosmetics === 'object') acc.cosmetics = patch.cosmetics;
    if (patch.stats && typeof patch.stats === 'object') acc.stats = sanitizeStats(patch.stats);
    this.save();
    return acc;
  }

  /**
   * Delete an account and its data from this device. quiet: its registry entry stays on the broker
   * (a banned account taken off a device it was moved to: the admin's list keeps it).
   */
  remove(id, { quiet = false } = {}) {
    const i = this.data.profiles.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const [acc] = this.data.profiles.splice(i, 1);
    if (this.data.active === id) this.data.active = null;
    if (this._unlocked === id) this._unlocked = null;
    this.save();
    this._emit('remove', acc, { quiet: !!quiet });
    return true;
  }

  /** Sign in to a real account. Picking / signing in unlocks it for this session. */
  setActive(id) {
    if (id === null) { this.data.active = null; this._unlocked = null; this.save(); return null; }
    const acc = this.get(id);
    if (!acc) return null;
    this.guest = null;
    this.data.active = id;
    this._unlocked = id;
    this.save();
    return acc;
  }

  /** Sign out (nobody active). The guest, if any, is dropped; the session unlock is forgotten. */
  signOut() { this.guest = null; this.data.active = null; this._unlocked = null; this.save(); }

  /**
   * Start a GUEST session: a temporary profile whose stats are NOT kept beyond the session. It is
   * held in memory and marked active, but never written to disk.
   */
  startGuest({ name, skin } = {}) {
    this.guest = { id: 'guest', schema: ACCOUNT_SCHEMA, guest: true, name: cleanName(name) || 'Guest', skin: skin | 0, createdAt: Date.now(), isAdmin: false, pw: null, passkey: null, sign: null, stats: defaultStats(), cosmetics: {} };
    this.data.active = 'guest';
    this._put(KEY, JSON.stringify({ v: 1, active: null, profiles: this.data.profiles })); // disk never shows the guest active
    return this.guest;
  }

  /** Persist the given account's current state (no-op for the guest). */
  persist(acc) { if (acc && !acc.guest) this.save(); }

  /** Import a profile object brought over by a transfer code. Returns the new account. */
  importProfile(obj) {
    const acc = this._newAccount({ name: (obj && obj.name) || 'Player', skin: (obj && obj.skin) | 0 });
    acc.imported = Date.now();
    if (obj && typeof obj === 'object') {
      // the same account, moved: its id (when well-formed and not on this device already) and age
      if (typeof obj.id === 'string' && ID_RE.test(obj.id) && !this.get(obj.id)) acc.id = obj.id;
      if (Number.isFinite(obj.createdAt) && obj.createdAt > 0 && obj.createdAt <= Date.now()) acc.createdAt = Math.floor(obj.createdAt);
      acc.stats = sanitizeStats(obj.stats);
      acc.cosmetics = cleanCosmetics(obj.cosmetics);
      // the password protection comes with the account (only a well-formed record: a crafted code
      // can't plant a billion-round hash that freezes the iPad at sign-in)
      acc.pw = cleanPwRecord(obj.pw);
      // a passkey is bound to the OLD device, so it never transfers (the player can add Face ID here);
      // neither does the signing identity: a code guarded by a short PIN is no place for a key
    }
    this.data.profiles.push(acc);
    this.save();
    this._emit('import', acc);
    return acc;
  }

  /** The object a transfer code carries (no passkey — that stays on the old device). */
  exportObject(id) {
    const a = this.get(id);
    if (!a) return null;
    return { v: 1, id: a.id, createdAt: a.createdAt, name: a.name, skin: a.skin, stats: a.stats, cosmetics: a.cosmetics, pw: a.pw || undefined };
  }
}

export const _internal = { KEY, sanitizeAccount, cleanName };
