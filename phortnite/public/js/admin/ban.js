// The admin's ban: written into the lock screen's OWN ban stores (tools/lockscreen/lock.js, "the
// ban"), in exactly its format, so that after the reload the lock screen shows its ban screen and
// Philip's unban code lifts it like any other ban. Three places, so clearing one lifts nothing:
//   localStorage 'phortnite.ban'                         "S.T.U" (strikes, unban tries, unban lock-out ms)
//   cookie       'phortnite_ban' on the site's top folder  the same text (lock.js siteFolder)
//   IndexedDB    'phortnite-lock' v1, store 'kv', key 'ban' the same text
// S >= STRIKES is banned. Each number is merged as the highest of what the stores hold (lock.js
// mergeBan), so a ban never lowers an unban lock-out already running.
// Next to it, localStorage 'phortnite.banby' says who banned the device ({by: 'admin', reason, t}),
// so the lock screen's ban screen tells the truth: "The admin banned this device" (with the reason),
// not "Too many wrong passwords". lock.js reads it (BANBY there) and removes it with the ban when
// Philip's unban code lifts it.
// On a build without the lock (npm start, a dev copy) nothing reads the stores at boot, so the game
// itself shows a ban overlay when they say banned (js/admin/client.js).
//
// The constants and parse/format rules mirror lock.js and tools/lock.mjs (STRIKES, BAN_KEY,
// BAN_COOKIE); test/admin.test.mjs checks both sides agree. Every function takes its browser
// objects in `env` (defaults: the real ones) so Node can run them with stand-ins.

export const STRIKES = 3;
export const BAN_KEY = 'phortnite.ban';
export const BAN_COOKIE = 'phortnite_ban';
export const BAN_IDB = 'phortnite-lock';
export const BAN_BY = 'phortnite.banby';
const COOKIE_AGE = 315360000; // ~10 years, like lock.js

/** One store's "S.T.U" as { strikes, tries, until } (anything else counts as 0). */
export function parseBan(s) {
  const a = String(s || '').split('.');
  const n = (i) => { const v = parseInt(a[i], 10); return v > 0 ? v : 0; };
  return { strikes: n(0), tries: n(1), until: n(2) };
}

export function formatBan(b) { return `${b.strikes}.${b.tries}.${b.until}`; }

export function mergeBan(a, b) {
  return { strikes: Math.max(a.strikes, b.strikes), tries: Math.max(a.tries, b.tries), until: Math.max(a.until, b.until) };
}

export function isBanned(b) { return b.strikes >= STRIKES; }

/** The site's top folder (the cookie's path): the main site and its beta/ copy are one site. */
export function siteFolder(pathname) { return String(pathname || '/').replace(/[^/]*$/, '').replace(/\/beta\/$/, '/'); }

function defaults(env = {}) {
  const g = globalThis;
  return {
    localStorage: 'localStorage' in env ? env.localStorage : (() => { try { return g.localStorage; } catch (e) { return null; } })(),
    document: 'document' in env ? env.document : g.document,
    location: 'location' in env ? env.location : g.location,
    indexedDB: 'indexedDB' in env ? env.indexedDB : g.indexedDB,
  };
}

/** localStorage and the cookie together (they answer at once). */
export function readBanSync(env) {
  const e = defaults(env);
  let b = parseBan('');
  try { if (e.localStorage) b = mergeBan(b, parseBan(e.localStorage.getItem(BAN_KEY))); } catch (err) { /* storage blocked */ }
  try {
    const m = new RegExp(`(?:^|;\\s*)${BAN_COOKIE}=([\\d.]+)`).exec(e.document ? e.document.cookie : '');
    if (m) b = mergeBan(b, parseBan(m[1]));
  } catch (err) { /* no cookies */ }
  return b;
}

/** One IndexedDB request (lock.js's database and store); done(result) or done() if it fails. */
function idb(e, mode, request) {
  return new Promise((resolve) => {
    let over = false;
    const end = (v) => { if (!over) { over = true; resolve(v); } };
    try {
      if (!e.indexedDB) { end(); return; }
      const req = e.indexedDB.open(BAN_IDB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = req.onblocked = () => end();
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('kv', mode), r = request(tx.objectStore('kv'));
          tx.oncomplete = () => { db.close(); end(r.result); };
          tx.onerror = tx.onabort = () => { db.close(); end(); };
        } catch (err) { db.close(); end(); }
      };
    } catch (err) { end(); }
    // (some Safari versions' IndexedDB never answers: go on without it, like lock.js)
    setTimeout(end, 1500);
  });
}

/** What all three stores say now. */
export async function readBan(env) {
  const e = defaults(env);
  const v = await idb(e, 'readonly', (s) => s.get('ban'));
  return mergeBan(parseBan(v), readBanSync(e));
}

/** The record a ban writes over `old`: banned, keeping any unban tries / lock-out already there. */
export function banRecord(old) { return mergeBan(old || parseBan(''), { strikes: STRIKES, tries: 0, until: 0 }); }

/** The cookie text a ban sets (lock.js saveBan's, for the same value). */
export function banCookie(value, loc) {
  const https = !!loc && loc.protocol === 'https:';
  return `${BAN_COOKIE}=${value}; Max-Age=${COOKIE_AGE}; Path=${siteFolder(loc ? loc.pathname : '/')}; SameSite=Lax${https ? '; Secure' : ''}`;
}

/** Who banned this device ({ by: 'admin', reason }), or null (wrong passwords, or nobody). */
export function readBanBy(env) {
  const e = defaults(env);
  try {
    const v = JSON.parse((e.localStorage && e.localStorage.getItem(BAN_BY)) || 'null');
    return v && v.by === 'admin' ? { by: 'admin', reason: typeof v.reason === 'string' ? v.reason.slice(0, 120) : '' } : null;
  } catch (err) { return null; }
}

/**
 * Ban this device: all three stores say banned, and who did it (the admin, with his reason).
 * Resolves to the record written once IndexedDB has it.
 */
export async function writeBan(env, { reason = '' } = {}) {
  const e = defaults(env);
  const b = banRecord(readBanSync(e));
  const v = formatBan(b);
  try { if (e.localStorage) e.localStorage.setItem(BAN_BY, JSON.stringify({ by: 'admin', reason: String(reason || '').slice(0, 120), t: Date.now() })); } catch (err) { /* private mode */ }
  try { if (e.localStorage) e.localStorage.setItem(BAN_KEY, v); } catch (err) { /* private mode */ }
  try { if (e.document) e.document.cookie = banCookie(v, e.location); } catch (err) { /* no cookies */ }
  // (like lock.js: never fewer strikes than IndexedDB's own record)
  await idb(e, 'readwrite', (s) => {
    const r = s.get('ban');
    r.onsuccess = () => s.put(formatBan(banRecord(mergeBan(b, parseBan(r.result)))), 'ban');
    return r;
  });
  return b;
}

/** Is this page running inside the locked website (lock.js started it)? */
export function underLock() {
  return typeof globalThis.__phortniteModuleURL === 'function';
}
