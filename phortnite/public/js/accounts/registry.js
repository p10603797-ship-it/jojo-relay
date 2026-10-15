// The account registry: every page tells the admin (Philip) which ACCOUNT is playing on it, so his
// panel's ACCOUNTS tab lists everyone who ever made one, and he can tap a name to ban it, even
// while that player is offline (the ban list: js/admin/commands.js 'bans', js/admin/client.js).
// Guests are never registered. Open, like all moderation: the create-account screen says "Your
// account name is sent to the admin (Philip) so he can keep Phortnite fair.", and every account
// that was made before this is told once (js/admin/client.js tellRegistry). DOM-free on purpose:
// test/registry.test.mjs runs it in Node with a stand-in for the presence connection.
//
// No backend: the registry lives on the same free public MQTT brokers as the live player count
// (js/net/presence.js), as ONE RETAINED message per account:
//   topic   REG_PREFIX + rid                     'phortnite/admin/v1/acct/<16 hex>'
//   payload sealToAdmin(boxPub, entry, SEAL_ACCT) (js/admin/keys.js): only the admin can open it, so
//           the broker and everyone else see ciphertext, never a name
//   entry   { k: 'acct', rid, tok, did, name, created, seen, level, wins, matches, kills, v }
// tok and rid are DERIVED from the account's local id (js/accounts/store.js), so old accounts work
// and nothing new is stored; rid is worked out FROM tok:
//   tok = the first 32 hex of SHA-256('phortnite registry tok v1:' + account id)  (sealed inside)
//   rid = the first 16 hex of SHA-256('phortnite registry id v2:'  + tok)         (the topic)
// The full account id never leaves this device in the clear (the sealed player card carries 8 of
// its characters; a "Move my account" code carries it encrypted under its PIN), and tok only ever
// travels sealed to the admin (in the entry and in the player card), so nobody else can work out
// an account's tok. Every rid is public (it is a topic name), but the admin's page checks that each
// entry's tok hashes to the rid of the topic it came on (tokMatches) and drops the ones that don't:
// only a device that has the account (or the admin) can write that account's entry, so a made-up
// entry can never rename a real account or point its row at another iPad (js/admin/session.js; the
// first tok it saw for a rid is still remembered as a second check). The player card's rid is
// checked the same way. Anyone on the relay can still DELETE an entry, or put back an older entry
// of the same account (its name and stats as they were): its iPad puts it right on its next connect.
// did is this DEVICE's id: 12 random [a-z0-9] kept in localStorage 'phortnite.device' (made once;
// private mode: one per page load), so a ban can name the iPad too, not only the account. It is
// sealed in the entry; the public ban list only ever carries banDid(did), a one-way hash of it, so
// nobody can read an iPad's id off the relay and copy it into their own storage.
//
// When an entry goes out (as seldom as works: every publish on a fixed topic says "this account is
// playing right now" to anyone listening on the public broker): the first time this device sees the
// account (a new account, a sign-in of one it never sent, a moved one), right after a rename (the
// player's own or the admin's), a stats change at most once per REG_EVERY_MS, and a refresh of
// 'seen' once per REG_REFRESH_MS. What was sent last for each account is kept in localStorage
// SENT_KEY (name, stats, when, a hash of the text), so a reload or a reconnect alone sends nothing.
// A broker that forgot the entry gets it back without a timeline: the page listens to its own
// account's topic (a subscription is invisible to others), and after each connect (or a switch of
// account) it waits REG_SETTLE_MS for the retained copy; missing, junk, or not the text this device
// sent last (someone wiped or replaced it) -> it goes out again. An account deleted on this device
// (AccountStore.remove) has its entry deleted from the broker (an empty retained message); offline,
// its rid waits in localStorage GONE_KEY and goes out on the next connect. (A banned account taken
// off a device it was moved to is removed quietly: its entry stays for the admin's list.)
//
// API
//   REG_PREFIX, REG_FILTER, REG_MAX, REG_EVERY_MS, REG_REFRESH_MS, REG_SETTLE_MS, DEVICE_KEY, GONE_KEY,
//   SENT_KEY, RID_RE, TOK_RE, DID_RE, BDID_RE
//   accountIds(id)                -> Promise<{ rid, tok }> (cached per id)
//   cachedIds(id)                 -> { rid, tok } once accountIds(id) has answered, else null
//   ridOf(tok)                    -> Promise<rid> the rid a tok belongs to
//   tokMatches(rid, tok)          -> Promise<bool> is tok that rid's token? (a well-formed one)
//   banDid(did)                   -> Promise<16 hex> a device id as the public ban list carries it
//   deviceId(storage)             -> this device's did
//   registration(acc, ids)        -> the entry for an account ({ rid, tok, did, now, version })
//   sealRegistration(boxPub, entry) -> the text to publish (<= REG_MAX) | null
//   regShape(x)                   -> is it a sealed entry's shape ({e, iv, ct}, capped)?
//   cleanRegistration(obj, rid)   -> an opened entry, cleaned, for that topic's rid | null (its tok
//                                    still to be checked with tokMatches)
//   new Registry({ presence, boxPub, account, store, storage, now, everyMs, refreshMs, settleMs, version })
//     .sync({ force })            publish the active account's entry when due -> Promise<bool>
//     .connected()                the presence connection is (back) up: pending deletions, then a
//                                 check that the broker still has this account's entry
//     .removed(accountId)         its entry deleted from the broker (or queued while offline)
//     .ridNow(accountId) / .idsNow(accountId)   its rid / { rid, tok } when already worked out, else null
//     .did, .stop()
import { sealToAdmin, SEAL_ACCT } from '../admin/keys.js';
import { VERSION } from '../../shared/constants.js';

export const REG_PREFIX = 'phortnite/admin/v1/acct/';
export const REG_FILTER = `${REG_PREFIX}+`;
export const REG_MAX = 2000; // a sealed entry's published text, at most (an entry is ~600)
export const REG_EVERY_MS = 6 * 3600000; // stats changes: one entry every 6 hours at most
export const REG_REFRESH_MS = 24 * 3600000; // 'seen' again once a day while playing
export const REG_SETTLE_MS = 2000; // after a connect: the broker's retained copy of our entry by then, or it goes again
export const DEVICE_KEY = 'phortnite.device';
export const GONE_KEY = 'phortnite.registryGone'; // deletions waiting for a connection
export const SENT_KEY = 'phortnite.registrySent'; // { rid: { n, s, at, h } }: what this device sent last per account
const GONE_MAX = 50;
const SENT_MAX = 20;
export const RID_RE = /^[0-9a-f]{16}$/;
export const TOK_RE = /^[0-9a-f]{32}$/;
export const DID_RE = /^[a-z0-9]{12}$/;
export const BDID_RE = /^[0-9a-f]{16}$/; // a device id on the public ban list (banDid: one-way)
const ID_INFO = 'phortnite registry id v2:'; // (v2: worked out from tok, so an entry proves its topic)
const TOK_INFO = 'phortnite registry tok v1:';
const BAN_DID_INFO = 'phortnite ban did v1:';
const DID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const utf8 = new TextEncoder();

const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16);
const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const int = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : lo);

async function sha256hex(text) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const idCache = new Map(); // account id -> Promise<{rid, tok}>
const idDone = new Map(); // account id -> {rid, tok}

/** The rid (the topic) that a tok belongs to. */
export async function ridOf(tok) {
  return (await sha256hex(ID_INFO + tok)).slice(0, 16);
}

/** Is tok the token of rid? (Only a device that has the account, or the admin, can know it.) Never throws. */
export async function tokMatches(rid, tok) {
  try {
    return typeof rid === 'string' && RID_RE.test(rid) && typeof tok === 'string' && TOK_RE.test(tok) && (await ridOf(tok)) === rid;
  } catch (e) { return false; }
}

/**
 * A device id as the public ban list carries it: 16 hex of a one-way hash (64 bits: nobody can make
 * up a did that hashes the same), so an iPad's real id is never readable on the relay.
 */
export async function banDid(did) {
  return (await sha256hex(BAN_DID_INFO + did)).slice(0, 16);
}

/** An account's token (sealed inside) and registry id (the topic, worked out from the token), from its local id. */
export function accountIds(id) {
  id = String(id);
  let p = idCache.get(id);
  if (!p) {
    p = sha256hex(TOK_INFO + id).then(async (b) => {
      const tok = b.slice(0, 32);
      const ids = { rid: await ridOf(tok), tok };
      idDone.set(id, ids);
      return ids;
    });
    if (idCache.size > 500) { idCache.clear(); idDone.clear(); } // (ids of a device: a handful)
    idCache.set(id, p);
  }
  return p;
}

/** { rid, tok } for an id accountIds() already worked out, else null (and it starts on it). */
export function cachedIds(id) {
  const d = idDone.get(String(id));
  if (d) return d;
  accountIds(id).catch(() => {});
  return null;
}

/** 12 random characters from [a-z0-9] (crypto random, no bias). */
export function newDeviceId() {
  let s = '';
  while (s.length < 12) {
    const a = new Uint8Array(16);
    globalThis.crypto.getRandomValues(a);
    for (const b of a) if (b < 252 && s.length < 12) s += DID_CHARS[b % 36];
  }
  return s;
}

let pageDid = null; // private mode: one per page load
/** This device's id, made once and kept in storage (DEVICE_KEY). Never throws. */
export function deviceId(storage) {
  try {
    const v = storage ? storage.getItem(DEVICE_KEY) : null;
    if (typeof v === 'string' && DID_RE.test(v)) return v;
  } catch (e) { /* private mode */ }
  const did = newDeviceId();
  try {
    if (storage) {
      storage.setItem(DEVICE_KEY, did);
      if (storage.getItem(DEVICE_KEY) === did) return did;
    }
  } catch (e) { /* private mode */ }
  if (!pageDid) pageDid = did;
  return pageDid;
}

/** The registry entry for account acc (a real one: the caller never passes a guest). */
export function registration(acc, { rid, tok, did, now = Date.now(), version = VERSION }) {
  const s = (acc && acc.stats) || {};
  return {
    k: 'acct', rid, tok, did,
    name: cleanName(acc.name) || 'Player',
    created: int(acc.createdAt, 0, 8.64e15),
    seen: Math.floor(now),
    level: int(s.level, 1, 999), wins: int(s.wins, 0, 1e8), matches: int(s.matches, 0, 1e8), kills: int(s.elims, 0, 1e9),
    v: String(version).slice(0, 16),
  };
}

/** Seal an entry for the admin (SEAL_ACCT): the text to publish, or null when over max. */
export async function sealRegistration(boxPub, entry, max = REG_MAX) {
  const text = JSON.stringify(await sealToAdmin(boxPub, entry, SEAL_ACCT));
  return text.length <= max ? text : null;
}

/** A sealed entry's shape ({e, iv, ct}: js/admin/keys.js), size-capped. */
export function regShape(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.e === 'string' && x.e.length <= 120
    && typeof x.iv === 'string' && x.iv.length <= 24 && typeof x.ct === 'string' && x.ct.length <= REG_MAX;
}

/**
 * An opened entry (anyone can seal something to the admin's public key: trust nothing in it),
 * cleaned: only for the rid of the topic it came on (a copy parked under another account's topic
 * is junk), with a well-formed tok and did. null when it isn't one. Never throws. Its tok still has
 * to prove the rid (tokMatches: async, so the admin's page does it, js/admin/session.js).
 */
export function cleanRegistration(o, rid) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.k !== 'acct') return null;
  if (typeof o.rid !== 'string' || !RID_RE.test(o.rid) || (rid !== undefined && o.rid !== rid)) return null;
  if (typeof o.tok !== 'string' || !TOK_RE.test(o.tok) || typeof o.did !== 'string' || !DID_RE.test(o.did)) return null;
  return {
    rid: o.rid, tok: o.tok, did: o.did,
    name: cleanName(o.name) || 'Player',
    created: int(o.created, 0, 8.64e15), seen: int(o.seen, 0, 8.64e15),
    level: int(o.level, 1, 999), wins: int(o.wins, 0, 1e8), matches: int(o.matches, 0, 1e8), kills: int(o.kills, 0, 1e9),
    v: cleanText(o.v, 16),
  };
}

function localStore() { try { return globalThis.localStorage || null; } catch (e) { return null; } }

export class Registry {
  /**
   * presence: js/net/presence.js (publish, listen, onConnect, connected); boxPub: the admin's box key;
   * account() -> the signed-in account (app.activeAccount) or null; store: the AccountStore
   * (its 'remove' events delete entries); storage: localStorage (did, what was sent, pending deletions).
   */
  constructor({ presence = null, boxPub = null, account = () => null, store = null, storage = localStore(), now = () => Date.now(), everyMs = REG_EVERY_MS, refreshMs = REG_REFRESH_MS, settleMs = REG_SETTLE_MS, version = VERSION } = {}) {
    this.presence = presence;
    this.boxPub = boxPub;
    this.account = account;
    this.storage = storage;
    this.now = now;
    this.everyMs = everyMs;
    this.refreshMs = refreshMs;
    this.settleMs = settleMs;
    this.version = version;
    this.did = deviceId(storage);
    this.sentMem = null; // SENT_KEY when storage can't keep it (private mode): this page load only
    this.watch = null; // { rid, off }: this account's own topic, listened to
    this.heard = null; // { rid, text }: what the broker handed over on it since the last connect
    this.checkTimer = 0;
    this.gone = new Set(); // account ids deleted here this page load (a late sync never brings them back)
    this.busy = false;
    this.again = false;
    this.stopped = false;
    this.offConnect = presence && typeof presence.onConnect === 'function' ? presence.onConnect(() => this.connected()) : null;
    // (a quiet removal, js/admin/client.js: a banned account taken off a device it was moved to,
    // its entry stays on the broker for the admin's list)
    this.offStore = store && typeof store.onChange === 'function'
      ? store.onChange((what, acc, info) => {
        if (what !== 'remove' || !acc) return;
        if (info && info.quiet) this.gone.add(acc.id); else this.removed(acc.id);
      }) : null;
  }

  /** Is the presence connection up? (A stand-in without the getter: assume so; publish says.) */
  online() {
    const p = this.presence;
    return !!p && (typeof p.connected === 'boolean' ? p.connected : true);
  }

  ridNow(id) {
    const ids = this.idsNow(id);
    return ids ? ids.rid : null;
  }

  idsNow(id) { return id ? cachedIds(id) : null; }

  /** A real account this page may register (never a guest, nor one deleted here). */
  realAccount() {
    const acc = this.account();
    return acc && !acc.guest && typeof acc.id === 'string' && acc.id && acc.id !== 'guest' && !this.gone.has(acc.id) ? acc : null;
  }

  /**
   * Publish the active account's entry when it is due (see the top). force: now, whatever changed
   * (the broker lost it). Resolves true when one went out. Never throws.
   */
  async sync({ force = false } = {}) {
    if (this.stopped) return false;
    if (this.busy) { this.again = true; this.againForce = this.againForce || force; return false; }
    this.busy = true;
    try {
      const acc = this.realAccount();
      if (!acc) { this.unwatch(); return false; } // (signed out, or a guest: no topic to watch)
      if (!this.boxPub) return false;
      const ids = await accountIds(acc.id);
      this.watchTopic(ids.rid);
      if (!this.online()) return false;
      const s = acc.stats || {};
      const name = cleanName(acc.name) || 'Player';
      const stats = `${s.level}|${s.wins}|${s.matches}|${s.elims}`;
      const t = this.now(), rec = this.sentFor(ids.rid);
      const age = rec ? t - rec.at : 0;
      // (a clock set back since: as good as never sent)
      const due = force || !rec || rec.n !== name || age < 0 || age >= this.refreshMs || (stats !== rec.s && age >= this.everyMs);
      if (!due) return false;
      const text = await sealRegistration(this.boxPub, registration(acc, { ...ids, did: this.did, now: t, version: this.version }));
      const h = text ? await textHash(text) : '';
      // (deleted, signed out or switched meanwhile: not this one)
      if (!text || this.stopped || this.gone.has(acc.id) || this.account() !== acc) return false;
      if (!this.presence.publish(REG_PREFIX + ids.rid, text, { retain: true })) return false;
      this.saveSent(ids.rid, { n: name, s: stats, at: t, h });
      return true;
    } catch (e) {
      return false;
    } finally {
      this.busy = false;
      if (this.again && !this.stopped) {
        const f = this.againForce;
        this.again = false;
        this.againForce = false;
        this.sync({ force: f });
      }
    }
  }

  /** Listen to the signed-in account's own topic (its retained copy: is our entry still there?). */
  watchTopic(rid) {
    const p = this.presence;
    if (this.stopped || (this.watch && this.watch.rid === rid) || !p || typeof p.listen !== 'function') return;
    this.unwatch();
    const topic = REG_PREFIX + rid;
    this.heard = null;
    this.watch = { rid, off: p.listen(topic, (text, tp) => { if (tp === topic && this.watch && this.watch.rid === rid) this.heard = { rid, text: typeof text === 'string' ? text : '' }; }) };
    if (this.online()) this.armCheck();
  }

  unwatch() {
    if (this.watch && typeof this.watch.off === 'function') this.watch.off();
    this.watch = null;
    this.heard = null;
  }

  armCheck() {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => { this.checkTimer = 0; this.check(); }, this.settleMs);
  }

  /**
   * A moment after a connect (or a switch of account): did the broker hand back the entry this
   * device sent last? Missing, junk or another text -> it goes out again. -> Promise<bool> (sent)
   */
  async check() {
    try {
      const acc = this.realAccount();
      if (this.stopped || !acc || !this.online()) return false;
      const { rid } = await accountIds(acc.id);
      if (!this.watch || this.watch.rid !== rid) return false; // (another account by now: its own check comes)
      const rec = this.sentFor(rid), heard = this.heard && this.heard.rid === rid ? this.heard.text : '';
      if (rec && heard && rec.h && (await textHash(heard)) === rec.h) return false; // (still there, as sent)
      return await this.sync({ force: true });
    } catch (e) { return false; }
  }

  /** The presence connection is (back) up: deletions that waited go first; is our entry still there? */
  async connected() {
    this.heard = null; // (this connection's retained copy comes in a moment)
    await this.flushGone();
    if (this.watch) this.armCheck();
    return this.sync(); // (due anyway: a rename or stats from while offline, or a first entry)
  }

  /** Account `id` was deleted on this device: its entry goes from the broker (now, or on the next connect). */
  async removed(id) {
    if (!id || id === 'guest') return false;
    this.gone.add(id);
    let rid;
    try { ({ rid } = await accountIds(id)); } catch (e) { return false; }
    this.dropSent(rid);
    if (this.watch && this.watch.rid === rid) this.unwatch();
    if (this.online() && this.presence.publish(REG_PREFIX + rid, '', { retain: true })) return true;
    const list = this.pending().filter((r) => r !== rid);
    list.push(rid);
    this.savePending(list.slice(-GONE_MAX));
    return false;
  }

  /** Deletions waiting in storage, sent now (the ones that still can't go stay). */
  async flushGone() {
    const list = this.pending();
    if (!list.length) return 0;
    const left = [];
    let sent = 0;
    for (const rid of list) {
      if (this.online() && this.presence.publish(REG_PREFIX + rid, '', { retain: true })) sent++;
      else left.push(rid);
    }
    this.savePending(left);
    return sent;
  }

  pending() {
    try {
      const v = JSON.parse((this.storage && this.storage.getItem(GONE_KEY)) || '[]');
      return Array.isArray(v) ? v.filter((r) => typeof r === 'string' && RID_RE.test(r)).slice(-GONE_MAX) : [];
    } catch (e) { return []; }
  }

  savePending(list) {
    try {
      if (!this.storage) return;
      if (list.length) this.storage.setItem(GONE_KEY, JSON.stringify(list));
      else this.storage.removeItem(GONE_KEY);
    } catch (e) { /* private mode: this page load only */ }
  }

  /** What this device sent last, per account (SENT_KEY), cleaned. */
  sentAll() {
    if (this.sentMem) return this.sentMem;
    let d = null;
    try { d = JSON.parse((this.storage && this.storage.getItem(SENT_KEY)) || 'null'); } catch (e) { d = null; }
    const out = {};
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const rid of Object.keys(d).slice(0, SENT_MAX * 2)) {
        const r = d[rid];
        if (!RID_RE.test(rid) || !r || typeof r !== 'object' || !Number.isFinite(r.at)) continue;
        out[rid] = { n: cleanName(r.n), s: typeof r.s === 'string' ? r.s.slice(0, 80) : '', at: r.at, h: typeof r.h === 'string' ? r.h.slice(0, 16) : '' };
      }
    }
    return out;
  }

  sentFor(rid) { return this.sentAll()[rid] || null; }

  saveSent(rid, rec) {
    const all = { ...this.sentAll(), [rid]: rec };
    const ids = Object.keys(all);
    if (ids.length > SENT_MAX) {
      ids.sort((a, b) => all[a].at - all[b].at);
      for (const id of ids.slice(0, ids.length - SENT_MAX)) delete all[id];
    }
    this.writeSent(all);
  }

  dropSent(rid) {
    const all = this.sentAll();
    if (!all[rid]) return;
    delete all[rid];
    this.writeSent(all);
  }

  writeSent(all) {
    if (!this.sentMem) {
      try {
        if (this.storage) {
          const text = JSON.stringify(all);
          this.storage.setItem(SENT_KEY, text);
          if (this.storage.getItem(SENT_KEY) === text) return;
        }
      } catch (e) { /* private mode */ }
    }
    this.sentMem = all; // (private mode: this page load only)
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.checkTimer);
    this.unwatch();
    if (this.offConnect) this.offConnect();
    if (this.offStore) this.offStore();
    this.offConnect = this.offStore = null;
  }
}

/** A published entry's fingerprint (is the broker's copy the one this device sent?). */
async function textHash(text) { return (await sha256hex(String(text))).slice(0, 16); }
