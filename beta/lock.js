/* Phortnite lock screen: opens the encrypted game with a password.
 *
 * Made by tools/lock.mjs (see "Publishing the locked website" in the README). The game's code is
 * in game.lock, encrypted with AES-256-GCM under a random game key. lock.json holds "key slots":
 * that game key encrypted once per password, with a key made from the password by
 * PBKDF2-SHA256 (600,000 rounds). This script:
 *   1. downloads lock.json and the archive straight away (while you type),
 *   2. turns the typed password into a key (once) and tries it on every slot,
 *   3. decrypts (and un-gzips) the archive into the game's modules,
 *   4. gives every module a blob: URL, adds an import map ('@phortnite/js/main.js' -> blob:…,
 *      plus the libraries from the CDN) and starts js/main.js.
 * There are no secrets in this file, and the password and keys are never logged or sent anywhere.
 * "Remember on this device" keeps the password in localStorage ('phortnite.pass:<folder>', one per
 * folder: the main site and /beta/ share an origin) to unlock without asking next time; if it
 * stops working (Philip turned it off) it is forgotten.
 * Three wrong passwords in a row ban the device (see "the ban" below); Philip's unban code (made by
 * `lock.mjs unban-code`; lock.json only has a PBKDF2 verifier of it) lifts the ban.
 * Face ID / Touch ID (see "Face ID" below) is the other way in: after the right password the page
 * offers it, and from then on the device's own passkey for this website opens the game key. No face
 * (or anything about one) ever reaches this script; the device checks the face itself.
 *
 * Plain ES2017 (no ?. ?? ... in objects, or catch without a binding): even an old browser must
 * at least get to show a message.
 */
(function () {
  'use strict';
  // (the same expression as STORE_EXPR in tools/lock.mjs, which reads it in the page's <head>)
  var STORE = 'phortnite.pass:' + location.pathname.replace(/[^/]*$/, '');
  // this folder's Face ID record (FACE_EXPR there), and "Not now" / "this device can't" for it
  var FACE = 'phortnite.face:' + location.pathname.replace(/[^/]*$/, '');
  var NOFACE = 'phortnite.noface:' + location.pathname.replace(/[^/]*$/, '');
  // the passkey's user id for this folder, kept: setting Face ID up again replaces the old passkey
  // (same website + same user id) instead of piling up 'Phortnite' passkeys in the Passwords app
  var FACEUSER = 'phortnite.faceuser:' + location.pathname.replace(/[^/]*$/, '');
  var PREFIX = '@phortnite/';
  // Does the browser itself do import maps? (Safari before 16.4 doesn't: es-module-shims runs the
  // game there.) Read before es-module-shims can swap in its own HTMLScriptElement.supports, and
  // never trust that one: it says yes to 'importmap' (it is an unnamed arrow, the browser's is "supports").
  var nativeSupports = window.HTMLScriptElement && HTMLScriptElement.supports;
  var $ = function (id) { return document.getElementById(id); };
  var root = $('lockscreen'), card = $('ls-card'), input = $('ls-pass'), go = $('ls-go');
  var remember = $('ls-remember'), msg = $('ls-msg'), retry = $('ls-retry');
  var unbanOpen = $('ls-unban-open'), code = $('ls-code'), unbanGo = $('ls-unban-go'), umsg = $('ls-umsg');
  var faceGo = $('ls-face-go'), faceLabel = $('ls-face-label'), faceForget = $('ls-face-forget');
  var offerText = $('ls-offer-text'), faceOn = $('ls-face-on'), faceNo = $('ls-face-no');
  if (!root || !card) return;

  var meta = null;      // Promise of lock.json
  var archive = null;   // Promise of { kind, file, bytes }
  var busy = false;
  var last = null;      // the password of the last attempt (memory only), for TRY AGAIN
  var reloaded = false; // the archive was fetched again past the cache once already
  var broken = false;   // the last download failed (the next try starts a new one)
  var gen = 0;          // which download is the current one
  var useGz = typeof DecompressionStream === 'function' && typeof Blob === 'function' && !!Blob.prototype.stream;
  var checking = false; // an unban code is being checked
  var unbanTimer = 0;
  var face = null;      // this folder's Face ID record (only where the browser does WebAuthn)
  var faceFailed = false; // Face ID didn't work on this page (its passkey may have been deleted)
  var offer = null;     // the Face ID offer on screen: { m, doc, K, slot, salt, id, busy }

  // ------------------------------------------------------------------ helpers
  // (test/lock.test.mjs runs everything from here to "end of helpers" in Node: only plain functions
  // of their arguments, localStorage, document.cookie and crypto)

  var STRIKES = 3;                 // wrong passwords in a row that ban the device
  var UNBAN_TRIES = 3;             // wrong unban codes in a row that lock the unban box...
  var UNBAN_WAIT = 3600000;        // ...for an hour
  var BAN = 'phortnite.ban';       // localStorage key (tools/lock.mjs BAN_KEY, which the page's <head> reads)
  var COOKIE = 'phortnite_ban';    // the cookie (BAN_COOKIE there)
  var CHARS = /^[A-HJ-NP-Z2-9]+$/; // the password alphabet (ALPHABET there): no 0/O, 1/I

  function normalize(p) {
    return String(p || '').toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]+/g, '');
  }

  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** What one store holds, "S.T.U", as { strikes, tries, until } (anything else counts as 0). */
  function parseBan(s) {
    var a = String(s || '').split('.');
    var n = function (i) { var v = parseInt(a[i], 10); return v > 0 ? v : 0; };
    return { strikes: n(0), tries: n(1), until: n(2) };
  }

  function formatBan(b) { return b.strikes + '.' + b.tries + '.' + b.until; }

  /** Two stores together: the highest of each number (so clearing one store lifts nothing). */
  function mergeBan(a, b) {
    return { strikes: Math.max(a.strikes, b.strikes), tries: Math.max(a.tries, b.tries), until: Math.max(a.until, b.until) };
  }

  function isBanned(b) { return b.strikes >= STRIKES; }

  /** The site's top folder (the cookie's path): the main site and its beta/ copy are one site. */
  function siteFolder(pathname) { return pathname.replace(/[^/]*$/, '').replace(/\/beta\/$/, '/'); }

  /** localStorage and the cookie together: both answer at once (the page's <head> reads them too). */
  function readSync() {
    var b = parseBan('');
    try { b = mergeBan(b, parseBan(localStorage.getItem(BAN))); } catch (e) { /* storage blocked */ }
    try {
      var m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([\\d.]+)').exec(document.cookie);
      if (m) b = mergeBan(b, parseBan(m[1]));
    } catch (e) { /* no cookies */ }
    return b;
  }

  /** Is `code` Philip's unban code? PBKDF2-SHA256 with the verifier's salt and rounds (lock.mjs makeUnban). */
  async function unbanOk(u, code) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalize(code)), 'PBKDF2', false, ['deriveBits']);
    var got = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(u.salt), iterations: u.iter }, base, 256));
    var want = unb64(u.hash), diff = got.length ^ want.length;
    for (var i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] | 0); // (every byte, wherever they differ)
    return diff === 0;
  }

  /** The record to go on from: what the stores say `now`, so that a reset made meanwhile in another tab
   *  (the right password, Philip's code) counts. Where nothing written is kept at all (storage
   *  blocked: `keeps` false), this page's own count `mine` too, so 3 wrong passwords still ban this page. */
  function current(now, mine, keeps) { return keeps ? now : mergeBan(mine, now); }

  /** The unban box locked for longer than UNBAN_WAIT from `now`? The clock was put back since: an hour from now, then. */
  function clampLock(b, now) {
    return b.until - now > UNBAN_WAIT ? { strikes: b.strikes, tries: b.tries, until: now + UNBAN_WAIT } : b;
  }

  /** What IndexedDB keeps when `b` is written over its `old` record. Strikes only go back to 0 all at
   *  once (the right password, Philip's code: a delete), so never below IndexedDB's own: it may have
   *  answered too late for this page to know them. (Tries and the lock-out are written as they are:
   *  locking starts the tries again, and a clock put back shortens the lock-out.) */
  function idbRecord(b, old) { return { strikes: Math.max(b.strikes, old.strikes), tries: b.tries, until: b.until }; }

  // Face ID (see "Face ID" below for how the page uses these)

  var FACE_INFO = 'phortnite face unlock v1'; // HKDF "info": what the passkey's secret is turned into a key for

  function b64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  /** base64url (no padding): how WebAuthn writes credential ids */
  function b64url(u8) { return b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

  function unb64url(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return unb64(s);
  }

  /** The key slot numbered n in lock.json (or the slots file), or null: that password was turned off. */
  function findSlot(m, n) {
    var list = (m && m.slots) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].n === n) return list[i];
    return null;
  }

  /** What the Face ID copy of the game key is bound to: Face ID, the passkey (its credential id) and
   *  the very key slot of the password typed when it was set up (its number, IV and wrapped key). A
   *  slot that was turned off is gone, and one written anew (`new --force`: a new game key) no longer
   *  matches, so the copy doesn't open any more: Face ID never outlives the password it came with. */
  function faceAad(n, id, slot) {
    return new TextEncoder().encode('phortnite-faceid:' + n + ':' + id + ':' + slot.iv + ':' + slot.wk);
  }

  /** HKDF-SHA256(the secret the passkey releases after Face ID, the record's salt, FACE_INFO) -> an AES-256-GCM key. */
  async function faceKey(secret, salt, use) {
    var base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode(FACE_INFO) },
      base, { name: 'AES-GCM', length: 256 }, false, [use]);
  }

  /** The Face ID record: the game key K encrypted (AES-256-GCM, a fresh IV) with the key made from
   *  the passkey's secret. `salt` is the PRF input the secret came from; id the passkey's id
   *  (base64url); slot the key slot the typed password opened; rp the website's host name. */
  async function faceWrap(secret, salt, K, slot, id, rp) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var wk = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: faceAad(slot.n, id, slot) }, await faceKey(secret, salt, 'encrypt'), K);
    return { v: 1, id: id, salt: b64(salt), iv: b64(iv), wk: b64(new Uint8Array(wk)), n: slot.n, rp: rp };
  }

  /** K from a Face ID record, the passkey's secret and the record's key slot as lock.json has it now;
   *  null when they don't fit (another secret, another slot or passkey, a new game key). */
  async function faceUnwrap(secret, rec, slot) {
    try {
      var key = await faceKey(secret, unb64(rec.salt), 'decrypt');
      var K = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: faceAad(rec.n, rec.id, slot) }, key, unb64(rec.wk));
      return K.byteLength === 32 ? new Uint8Array(K) : null;
    } catch (e) { return null; }
  }

  /** A Face ID record as localStorage keeps it (JSON), or null for anything else. */
  function parseFace(s) {
    var r = null;
    try { r = JSON.parse(s); } catch (e) { return null; }
    var str = function (v) { return typeof v === 'string' && v.length > 0 && v.length < 4096; };
    return r && r.v === 1 && str(r.id) && str(r.salt) && str(r.iv) && str(r.wk) && str(r.rp) && Number.isInteger(r.n) ? r : null;
  }

  /** The secret a passkey released (the PRF extension's first result), or null. */
  function prfFirst(cred) {
    var ext = null;
    try { ext = cred && typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : null; } catch (e) { ext = null; }
    var r = ext && ext.prf && ext.prf.results, f = r && r.first;
    if (!f) return null;
    var u8 = f instanceof ArrayBuffer ? new Uint8Array(f) : ArrayBuffer.isView(f) ? new Uint8Array(f.buffer, f.byteOffset, f.byteLength) : null;
    return u8 && u8.length >= 16 ? u8 : null;
  }

  /** Did the passkey just made say it can give a secret later (PRF on, but no result at once)? */
  function prfEnabled(cred) {
    try { var ext = cred.getClientExtensionResults(); return !!(ext && ext.prf && ext.prf.enabled === true); } catch (e) { return false; }
  }

  /** Does this device say it can do Face ID / Touch ID with the PRF extension? (P: PublicKeyCredential)
   *  Never fails; no answer within 3 s is a no. A device can still turn out not to (the offer says so then). */
  function faceAvailable(P) {
    return new Promise(function (resolve) {
      var t = 0, over = false;
      var done = function (v) { if (!over) { over = true; clearTimeout(t); resolve(v); } };
      t = setTimeout(function () { done(false); }, 3000);
      try {
        if (!P || typeof P.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') { done(false); return; }
        Promise.resolve(P.isUserVerifyingPlatformAuthenticatorAvailable()).then(function (uv) {
          if (uv !== true) { done(false); return; }
          if (typeof P.getClientCapabilities !== 'function') { done(true); return; }
          return Promise.resolve(P.getClientCapabilities()).then(function (c) { done(!(c && c['extension:prf'] === false)); }, function () { done(true); });
        }).then(null, function () { done(false); });
      } catch (e) { done(false); }
    });
  }

  // ------------------------------------------------------------------ end of helpers

  // ------------------------------------------------------------------ screen

  /** ask | working (ask, with UNLOCK busy) | scanning (ask, with the Face ID button busy) | wait |
   *  error (TRY AGAIN) | fatal | banned | offer (Face ID next time?) */
  function state(s, text) {
    var working = s === 'working', scanning = s === 'scanning';
    root.setAttribute('data-state', working || scanning ? 'ask' : s);
    msg.textContent = text || '';
    msg.classList.remove('ls-ok');
    go.disabled = faceGo.disabled = working || scanning;
    input.readOnly = working || scanning; // (not disabled: that would drop the iPad keyboard mid-try)
    go.textContent = working ? 'Unlocking…' : 'UNLOCK';
    faceLabel.textContent = scanning ? 'Unlocking…' : 'UNLOCK WITH FACE ID';
  }

  function focusBox(el) {
    // a keyboard pops up only on a tap on touch screens; on a computer type straight away
    if (!('ontouchstart' in window)) { try { el.focus(); el.select(); } catch (e) { /* fine */ } }
    // on an iPad the keyboard is still up after a wrong try: select the text so typing replaces it
    else if (document.activeElement === el && el.value) {
      try { el.setSelectionRange(0, el.value.length); } catch (e) { /* fine */ }
    }
  }

  function ask(text) {
    state('ask', text);
    focusBox(input);
  }

  /** What is left after `n` wrong passwords in a row. */
  function triesLeft(n) {
    var left = STRIKES - n;
    return left === 1 ? '1 try left. One more wrong password bans this device.' : left + ' tries left';
  }

  function nativeImportMaps() {
    var f = nativeSupports || (window.HTMLScriptElement && HTMLScriptElement.supports);
    try { return !!(f && f.name === 'supports' && f.call(HTMLScriptElement, 'importmap')); } catch (e) { return false; }
  }

  function shake() {
    card.classList.remove('ls-shake');
    void card.offsetWidth; // restart the animation
    card.classList.add('ls-shake');
  }

  function hide() {
    try { input.blur(); } catch (e) { /* fine */ }
    root.classList.add('ls-gone');
    setTimeout(function () { root.style.display = 'none'; }, 400);
  }

  function unhide() {
    root.style.display = '';
    root.classList.remove('ls-gone');
  }

  // ------------------------------------------------------------------ storage (never throws)

  function stored() { try { return localStorage.getItem(STORE) || ''; } catch (e) { return ''; } }
  function store(p) { try { localStorage.setItem(STORE, p); } catch (e) { /* private mode */ } }
  function forget() { try { localStorage.removeItem(STORE); } catch (e) { /* private mode */ } }

  function readFace() { try { return parseFace(localStorage.getItem(FACE)); } catch (e) { return null; } }
  /** Keep a Face ID record; true when it was really kept (read back). */
  function saveFace(rec) {
    try { localStorage.setItem(FACE, JSON.stringify(rec)); return !!parseFace(localStorage.getItem(FACE)); } catch (e) { return false; }
  }
  function dropFace() { try { localStorage.removeItem(FACE); } catch (e) { /* private mode */ } }
  /** Tell the device a passkey of ours opens nothing any more, so it can delete it (Safari 26+,
   *  Chrome 132+; elsewhere it just stays in the Passwords app). */
  function unknownPasskey(rp, id) {
    try {
      if (id && window.PublicKeyCredential && typeof PublicKeyCredential.signalUnknownCredential === 'function') {
        PublicKeyCredential.signalUnknownCredential({ rpId: rp, credentialId: id }).then(null, function () { /* fine */ });
      }
    } catch (e) { /* fine */ }
  }
  /** This folder's passkey user id (16 random bytes, made once). */
  function faceUser() {
    try {
      var u = localStorage.getItem(FACEUSER);
      if (u && /^[A-Za-z0-9_-]{22}$/.test(u)) return unb64url(u);
      var id = random(16);
      localStorage.setItem(FACEUSER, b64url(id));
      return id;
    } catch (e) { return random(16); }
  }
  /** 'later' (Not now), 'unsupported' (this device can't), or '' */
  function noFace() { try { return localStorage.getItem(NOFACE) || ''; } catch (e) { return 'blocked'; } }
  function setNoFace(why) { try { localStorage.setItem(NOFACE, why); } catch (e) { /* private mode */ } }

  /** Every remembered password on this website (main site and beta/ each keep their own). */
  function forgetAll() {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('phortnite.pass:') === 0) localStorage.removeItem(k);
      }
    } catch (e) { /* private mode */ }
  }

  // ------------------------------------------------------------------ the ban
  // Philip: "if you get the password wrong 3 times in a row it permanently bans you". No website
  // can tell one iPad from another (identical school iPads would all be banned together), so the
  // ban lives in this device's own storage, in three places so that clearing one doesn't lift it:
  // localStorage, a cookie and IndexedDB. Each holds "S.T.U": S wrong passwords in a row (STRIKES =
  // banned), T wrong unban codes in a row, U when the unban box opens again (ms; 0 = open). The
  // highest of each number wins, and every change goes to all three (which also puts back one that
  // was cleared). It is for the whole website: one localStorage/IndexedDB key for the origin, and
  // the cookie on the site's top folder, so the main site and beta/ share it. Clearing all of the
  // website's data (or a private window) starts afresh: nothing on a website can prevent that.

  var IDB = 'phortnite-lock'; // IndexedDB database: object store 'kv', the record under 'ban'
  var SITE = siteFolder(location.pathname);
  var ban = parseBan('');     // this page's copy of the record (each strike or unban try reads the stores again)
  var keeps = false;          // the stores keep a record (one was read, or one written read back)
  var lastWrong = '';         // the last wrong password (memory only): Go again with it is not another strike
  var lastCode = '';          // the same for a wrong unban code

  /** One IndexedDB request in its own transaction; done(its result), or done() when IndexedDB is
   *  missing, blocked or fails. Never throws. */
  function idb(mode, request, done) {
    var over = false;
    var end = function (v) { if (!over) { over = true; if (done) done(v); } };
    try {
      var req = indexedDB.open(IDB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onerror = req.onblocked = function () { end(); };
      req.onsuccess = function () {
        var db = req.result;
        try {
          var tx = db.transaction('kv', mode), r = request(tx.objectStore('kv'));
          tx.oncomplete = function () { db.close(); end(r.result); };
          tx.onerror = tx.onabort = function () { db.close(); end(); };
        } catch (e) { db.close(); end(); }
      };
    } catch (e) { end(); }
    // (some Safari versions' IndexedDB never answers at all: go on without it)
    setTimeout(end, 1500);
  }

  /** Write b into all three stores (all zeros: remove it from all three). */
  function saveBan(b) {
    var clear = !b.strikes && !b.tries && !b.until, v = formatBan(b), w = parseBan(v);
    try { if (clear) localStorage.removeItem(BAN); else localStorage.setItem(BAN, v); } catch (e) { /* private mode */ }
    try {
      // ~10 years (Safari keeps a script's cookie a week at most: every visit writes it again)
      document.cookie = COOKIE + '=' + (clear ? '' : v) + '; Max-Age=' + (clear ? 0 : 315360000) + '; Path=' + SITE
        + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) { /* no cookies */ }
    if (!clear && formatBan(readSync()) === v) keeps = true;
    idb('readwrite', function (s) {
      if (clear) return s.delete('ban');
      var r = s.get('ban');
      r.onsuccess = function () { s.put(formatBan(idbRecord(w, parseBan(r.result))), 'ban'); };
      return r;
    });
  }

  /** What the three stores say now (IndexedDB has up to 1.5 s to answer). Never fails. */
  function readAll() {
    return new Promise(function (done) {
      idb('readonly', function (s) { return s.get('ban'); }, function (v) { done(mergeBan(parseBan(v), readSync())); });
    });
  }

  /** Go on from the record the stores hold now (see current()). */
  function useStores(now) {
    if (now.strikes || now.tries || now.until) keeps = true;
    ban = current(now, ban, keeps);
  }

  /** An unban lock-out longer than UNBAN_WAIT (the clock was put back): an hour from now, everywhere. */
  function fixClock() {
    var b = clampLock(ban, Date.now());
    if (b !== ban) { ban = b; saveBan(ban); }
  }

  /** The ban screen. Writes the ban into every store again (one may have been cleared), except on the
   *  page's first look (`first`): IndexedDB, not read yet, may know more, and `checked` writes it all then. */
  function banned(first) {
    busy = false;
    last = null;
    lastWrong = '';
    if (!first) saveBan(ban);
    forgetAll();
    input.value = '';
    try { input.blur(); } catch (e) { /* fine */ }
    unhide();
    state('banned');
    root.classList.remove('ls-unbanning');
  }

  /** The unban box as it is now: locked for UNBAN_WAIT after UNBAN_TRIES wrong codes in a row. */
  function unbanBox(text) {
    fixClock();
    var left = ban.until - Date.now();
    var locked = left > 0;
    code.readOnly = unbanGo.disabled = locked || checking;
    unbanGo.textContent = checking ? 'Checking…' : 'UNBAN';
    var mins = Math.ceil(left / 60000);
    umsg.textContent = text || (locked ? 'Too many wrong codes. Unbanning is locked for ' + mins + (mins === 1 ? ' more minute.' : ' more minutes.') : '');
    clearTimeout(unbanTimer);
    if (locked) unbanTimer = setTimeout(function () { unbanBox(''); }, Math.min(left + 250, 60000));
  }

  /** The ban is lifted (Philip's code here, or in another tab): a password can be typed again. */
  function unbanned() {
    ban = parseBan('');
    lastWrong = lastCode = '';
    saveBan(ban);
    code.value = '';
    unbanBox(''); // (an open box, should the device be banned again)
    root.classList.remove('ls-unbanning');
    document.documentElement.classList.remove('ls-banned');
    download(false); // (a banned device fetched only lock.json)
    ask('Unbanned. Type a password.');
    msg.classList.add('ls-ok');
  }

  function wrongCode(tries) {
    var left = UNBAN_TRIES - tries;
    return 'Wrong code — ' + left + (left === 1 ? ' try left' : ' tries left');
  }

  async function tryUnban() {
    if (checking) return;
    // what the stores say now, not this page's copy: Philip's code may have been typed in another tab
    checking = true;
    useStores(await readAll());
    checking = false;
    if (!isBanned(ban)) { unbanned(); return; }
    fixClock();
    if (ban.until > Date.now()) { unbanBox(''); return; }
    var c = normalize(code.value);
    if (!c) { unbanBox('Type the unban code'); return; }
    // (not a try: an unban code is never shorter or longer, or other letters)
    if (c.length !== 10 || !CHARS.test(c)) { unbanBox('Unban codes are 10 letters and numbers'); shake(); return; }
    // the same wrong code again (a double tap): it was checked already, so not another try
    if (c === lastCode) { unbanBox(wrongCode(ban.tries)); shake(); return; }
    checking = true;
    unbanBox('');
    var ok = null;
    try {
      var m = await meta;
      if (m.unban) ok = await unbanOk(m.unban, c);
    } catch (e) { ok = null; }
    checking = false;
    if (ok === null) { getMeta(); unbanBox('Couldn’t check the code. Check the Wi-Fi, then try again.'); return; }
    if (ok) { unbanned(); return; }
    lastCode = c;
    ban.tries++;
    var text, locked = ban.tries >= UNBAN_TRIES;
    if (locked) {
      ban.tries = 0;
      ban.until = Date.now() + UNBAN_WAIT;
      text = 'Wrong code 3 times. Unbanning is locked for an hour.';
    } else {
      text = wrongCode(ban.tries);
    }
    saveBan(ban);
    unbanBox(text);
    shake();
    // locked: put the iPad keyboard away (it would cover the message, over a box that takes no typing)
    if (locked) { try { code.blur(); } catch (e) { /* fine */ } } else focusBox(code);
  }

  // ------------------------------------------------------------------ download

  function failure(kind, cause) {
    var e = new Error(kind + (cause && cause.message ? ': ' + cause.message : ''));
    e.kind = kind;
    return e;
  }

  function fetchOk(url, cache) {
    return fetch(url, { cache: cache }).then(function (r) {
      if (!r.ok) throw failure('net', new Error(url + ' ' + r.status));
      return r;
    }, function (e) { throw failure('net', e); });
  }

  /** lock.json (again). A banned device needs only this (for Philip's unban code). */
  function getMeta() {
    meta = fetchOk('lock.json?t=' + Date.now(), 'no-store').then(function (r) {
      return r.json().catch(function (e) { throw failure('corrupt', e); });
    });
    // "Philip: unban" only where this build has an unban code (nobody may be waiting on meta yet:
    // the second function keeps "unhandled rejection" noise out of the console)
    meta.then(function (m) {
      if (m && m.unban && m.unban.hash) root.setAttribute('data-unban', ''); else root.removeAttribute('data-unban');
    }, function () {});
    return meta;
  }

  /** Start (or restart) both downloads; `fresh` goes past the browser's cache. */
  function download(fresh) {
    var g = ++gen;
    broken = false;
    archive = getMeta().then(function (m) {
      var kind = useGz ? 'gz' : 'raw', file = m.files && m.files[kind];
      if (!file) throw failure('corrupt');
      // the IV changes with every build, so ?v= never mixes builds up in a cache
      return fetchOk(file.path + '?v=' + encodeURIComponent(file.iv.slice(0, 16)), fresh ? 'reload' : 'no-cache')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (bytes) { return { kind: kind, file: file, bytes: bytes }; });
    });
    archive.catch(function () { if (g === gen) broken = true; });
  }

  // ------------------------------------------------------------------ crypto

  var enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  /** The game key from whichever slot this password opens, { raw, n, slot }, or null. One PBKDF2 for
   *  all slots. (The raw key stays in memory only: Face ID, when it is turned on, keeps a copy
   *  encrypted with the passkey's secret.) */
  async function unwrap(m, password) {
    var subtle = crypto.subtle;
    var base = await subtle.importKey('raw', enc.encode(normalize(password)), 'PBKDF2', false, ['deriveKey']);
    var kek = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(m.salt), iterations: m.iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    for (var i = 0; i < m.slots.length; i++) {
      var s = m.slots[i], raw = null;
      try {
        raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv), additionalData: enc.encode('phortnite-slot:' + s.n) }, kek, unb64(s.wk));
      } catch (e) { raw = null; } // not this slot
      if (raw && raw.byteLength === 32) return { raw: new Uint8Array(raw), n: s.n, slot: s };
    }
    return null;
  }

  function gameKey(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); }

  function gunzip(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  /** The decrypted archive: { version, main, files: { 'js/main.js': source, … } }. */
  async function open(key) {
    var a = await archive, plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(a.file.iv), additionalData: enc.encode('phortnite-archive:' + a.kind) }, key, a.bytes);
    } catch (e) { throw failure('corrupt', e); }
    if (a.kind === 'gz') {
      try { plain = await gunzip(plain); } catch (e) { useGz = false; throw failure('corrupt', e); }
    }
    var doc;
    try { doc = JSON.parse(new TextDecoder().decode(plain)); } catch (e) { throw failure('corrupt', e); }
    if (!doc || !doc.files || typeof doc.files[doc.main || 'js/main.js'] !== 'string') throw failure('corrupt');
    return doc;
  }

  // ------------------------------------------------------------------ start the game

  function start(m, doc) {
    var urls = {}, imports = Object.assign({}, m.imports || {});
    Object.keys(doc.files).forEach(function (p) {
      urls[p] = URL.createObjectURL(new Blob([doc.files[p]], { type: 'text/javascript' }));
      imports[PREFIX + p] = urls[p];
    });
    // a module's own URL is a blob: here; textures.js asks for texgen.js's one for its worker
    window.__phortniteModuleURL = function (p) { return urls[p]; };
    var map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({ imports: imports });
    document.head.appendChild(map);
    // A module script that imports the game. It goes in <head>, like the map: on browsers without
    // import maps es-module-shims (loaded by index.html) runs the game itself, and it only notices
    // scripts added to <head> (its MutationObserver watches document and <head>, not <body>, and it
    // skips a script that is the very last thing in the page). The browser's own attempt there
    // stops at the unknown '@phortnite/' name before running anything.
    var s = document.createElement('script');
    s.type = 'module';
    s.textContent = 'import ' + JSON.stringify(PREFIX + (doc.main || 'js/main.js')) + ';';
    // That failed attempt may fire "error" on the script (WebKit) while es-module-shims is still
    // starting the game, so a failure only counts where the browser does import maps itself.
    if (nativeImportMaps()) s.onerror = function (e) { failed(failure('boot', e && e.error)); };
    document.head.appendChild(s);
    hide();
  }

  // ------------------------------------------------------------------ unlock

  function failed(e) {
    busy = false;
    unhide();
    var kind = e && e.kind;
    if (kind === 'net') state('error', 'Couldn’t download the game. Check the Wi-Fi, then try again.');
    else if (kind === 'corrupt') state('error', 'The game download was damaged. Try again.');
    else if (kind === 'boot') state('error', 'The game couldn’t start. Try again.');
    else state('error', 'Something went wrong. Try again.');
    root.setAttribute('data-error', kind || 'other');
  }

  async function unlock(password, auto) {
    if (busy) return;
    busy = true;
    last = { password: password, auto: auto };
    if (auto) state('wait'); else state('working');
    if (broken) download(true); // (offline when the page opened? try again now)
    try {
      // never a try before IndexedDB has had its say on this page
      await checked;
      // the stores again, read while the password is checked: it opens nothing on a device banned
      // meanwhile (another tab), and a strike counts on from what they say, not from this page's copy
      // (the right password in another tab may have reset them)
      var now = readAll();
      var m = await meta;
      var got = await unwrap(m, password);
      useStores(await now);
      if (isBanned(ban)) { banned(); return; }
      if (!got) {
        busy = false;
        last = null;
        // (a remembered password that was turned off is not a strike: nobody typed it)
        if (auto) { forget(); ask('That password was turned off — ask Philip for a new one'); return; }
        // a wrong password, really tried against the slots: a strike (a network error, or something
        // that is not a password at all, never gets this far)
        ban.strikes++;
        lastWrong = normalize(password);
        saveBan(ban);
        if (isBanned(ban)) { banned(); return; }
        ask('Wrong password — ' + triesLeft(ban.strikes));
        shake();
        // the last try: on an iPad put the keyboard away, so the whole warning (and UNLOCK) can be
        // seen, and the last try takes a deliberate tap
        if (ban.strikes === STRIKES - 1 && 'ontouchstart' in window) {
          input.value = '';
          try { input.blur(); } catch (e) { /* fine */ }
        }
        return;
      }
      // the right password: remember it (or forget an old one) as the box says. With Face ID on
      // this device the box isn't there: the face takes the place of a remembered password.
      if (!face && (auto || remember.checked)) store(normalize(password)); else forget();
      await opened(m, got, function (m2) { return unwrap(m2, password); }, !auto);
    } catch (e) {
      failed(e);
    }
  }

  /** The game key is known (the right password, or Face ID): no strikes any more, decrypt the game and
   *  start it. `again(m)` gets the key again from a fresh lock.json (for a second download); `typed`:
   *  a password was typed just now, so Face ID may be offered first. */
  async function opened(m, got, again, typed) {
    // no strikes any more, in any store (whatever this page knew)
    lastWrong = '';
    ban = parseBan('');
    saveBan(ban);
    var doc;
    try {
      doc = await open(await gameKey(got.raw));
    } catch (e) {
      if (e.kind !== 'corrupt' || reloaded) throw e;
      // an old copy in a cache, or a half download: once more, straight from the website
      reloaded = true;
      download(true);
      m = await meta;
      got = await again(m);
      if (!got) throw failure('corrupt');
      doc = await open(await gameKey(got.raw));
    }
    busy = false;
    last = null;
    meta = archive = null; // (the encrypted copy is not needed any more)
    // (Face ID didn't work on this page, then the right password: its passkey may be gone, so offer
    // to set it up again; NOT NOW keeps the old setup)
    if (typed && await offerFace(m, doc, got, !!face && faceFailed)) return;
    start(m, doc);
  }

  // ------------------------------------------------------------------ Face ID
  // Philip: "choose to use a password or Face ID". The website never sees a face, and keeps no
  // pictures to compare with (they would be public, and a photo could fool them). The iPad does it:
  // after the right password the page makes a passkey for this website on the device (WebAuthn),
  // which only opens after Face ID (or Touch ID, or the device's passcode) has said yes, and then
  // gives the page a secret of its own (the PRF extension; iPadOS / iOS 18 and newer). A copy of the
  // game key, encrypted with that secret (faceWrap), is the Face ID record in localStorage
  // ('phortnite.face:<folder>'); it is bound to the key slot of the password typed then, so turning
  // that password off (or new passwords for everyone) turns this Face ID off too. Face ID takes the
  // place of "Remember on this device" (a remembered password would unlock without asking for the
  // face). Failed or cancelled scans are never strikes. A ban hides Face ID but keeps the record:
  // the face belongs to the device's owner, and Philip's unban code brings it back.

  var webauthn = false;
  try {
    webauthn = typeof PublicKeyCredential === 'function' && !!navigator.credentials
      && typeof navigator.credentials.get === 'function' && typeof navigator.credentials.create === 'function';
  } catch (e) { webauthn = false; }

  function random(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  /** Show (rec) or hide (null) the Face ID button for this folder. */
  function setFace(rec) {
    face = rec;
    if (rec) { root.setAttribute('data-face', ''); return; }
    root.removeAttribute('data-face');
    document.documentElement.classList.remove('ls-faceid');
  }

  /** The Face ID record can't open the game any more: it goes, and the password box says why. */
  function lostFace(text) {
    var rec = face;
    dropFace();
    setFace(null);
    if (rec) unknownPasskey(rec.rp, rec.id);
    busy = false;
    ask(text);
  }

  /** Ask the passkey `id` for its secret (Face ID first). Called from a tap: Safari asks for the face only then. */
  function faceGet(id, salt, rp) {
    return navigator.credentials.get({ publicKey: {
      challenge: random(32), rpId: rp, allowCredentials: [{ type: 'public-key', id: unb64url(id) }],
      userVerification: 'required', timeout: 60000, extensions: { prf: { eval: { first: salt } } },
    } });
  }

  /** UNLOCK WITH FACE ID (in the tap itself, before anything that waits). */
  function faceUnlock() {
    if (busy || !face) return;
    var rec = face, req;
    // banned meanwhile (another tab)? localStorage and the cookie say so at once; IndexedDB is asked after the scan
    var now = mergeBan(ban, readSync());
    if (isBanned(now)) { ban = now; banned(); return; }
    busy = true;
    last = null;
    state('scanning');
    try { req = faceGet(rec.id, unb64(rec.salt), rec.rp); } catch (e) { req = Promise.reject(e); }
    if (broken) download(true);
    faceOpen(rec, req);
  }

  async function faceOpen(rec, req) {
    var secret = null, err = null;
    try { secret = prfFirst(await req); } catch (e) { err = e || new Error('failed'); }
    try {
      // like a password: never before IndexedDB has had its say, and nothing opens on a banned device
      await checked;
      useStores(await readAll());
      if (isBanned(ban)) { banned(); return; }
      // cancelled, or not the right face: not a strike, and Face ID stays on
      if (err) { busy = false; faceFailed = true; ask('Face ID didn’t work — try again or type a password.'); return; }
      var m = await meta;
      var slot = findSlot(m, rec.n);
      if (!slot) { lostFace('That password was turned off — ask Philip for a new one'); return; }
      // no secret (the browser left it out), or it doesn't open the copy (a new game key: new passwords for everyone)
      var raw = secret ? await faceUnwrap(secret, rec, slot) : null;
      secret = null;
      if (!raw) { lostFace('Face ID needs setting up again — type a password'); return; }
      var got = { raw: raw, n: rec.n, slot: slot };
      await opened(m, got, function (m2) { return findSlot(m2, rec.n) ? got : null; }, false);
    } catch (e) {
      failed(e);
    }
  }

  // The offer, after the right typed password: TURN ON FACE ID or NOT NOW, before the game starts.
  var OFFER = {
    ask: ['Scan your face instead of typing the password. (Touch ID works too.)', 'TURN ON FACE ID'],
    finish: ['One more scan to finish', 'SCAN TO FINISH'],
    retry: ['Face ID didn’t turn on. Try again?', 'TRY AGAIN'],
    again: ['Face ID didn’t work just now. Set it up again?', 'SET UP AGAIN'],
    unsupported: ['This device can’t use Face ID for Phortnite — keep using your password.', 'OK'],
  };

  function offerUi(phase) {
    root.setAttribute('data-offer', phase);
    offerText.textContent = OFFER[phase][0];
    faceOn.textContent = OFFER[phase][1];
    faceOn.disabled = faceNo.disabled = false;
  }

  /** Offer Face ID (true: the offer is up, and starts the game itself), or not (false). */
  async function offerFace(m, doc, got, again) {
    // only once per folder: not with Face ID already on (unless it just failed), after Not now, or where it can't work
    if (!webauthn || (face && !again) || noFace()) return false;
    var can = false;
    try { can = await capable; } catch (e) { can = false; }
    if (!can) return false;
    offer = { m: m, doc: doc, K: got.raw, slot: got.slot, salt: null, id: '', busy: false, again: !!again };
    try { input.blur(); } catch (e) { /* fine */ } // (the iPad keyboard would cover the offer)
    state('offer');
    offerUi(again ? 'again' : 'ask');
    return true;
  }

  /** Leave the offer and start the game. */
  function letsGo() {
    var o = offer;
    if (!o) return;
    offer = null;
    o.K = null;
    root.removeAttribute('data-offer');
    start(o.m, o.doc);
  }

  function cantFace(o) {
    setNoFace('unsupported');
    if (o.id) unknownPasskey(location.hostname, o.id); // (made, but it can't open anything)
    o.busy = false;
    offerUi('unsupported');
  }

  /** TURN ON FACE ID / SCAN TO FINISH / TRY AGAIN / OK (in the tap itself: Safari asks for the face only then). */
  function faceTap() {
    var o = offer, req;
    if (!o || o.busy) return;
    if (root.getAttribute('data-offer') === 'unsupported') { letsGo(); return; }
    o.busy = true;
    try {
      // the passkey is made already (no secret came with it): one more scan reads it
      if (o.id) req = faceGet(o.id, o.salt, location.hostname);
      else {
        o.salt = random(32);
        req = navigator.credentials.create({ publicKey: {
          rp: { id: location.hostname, name: 'Phortnite' },
          user: { id: faceUser(), name: 'Phortnite', displayName: 'Phortnite' },
          challenge: random(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
          timeout: 60000, extensions: { prf: { eval: { first: o.salt } } },
        } });
      }
    } catch (e) { req = Promise.reject(e); }
    faceOn.disabled = faceNo.disabled = true;
    faceOn.textContent = 'Scanning…';
    req.then(function (cred) { return faceMade(o, cred); }).then(null, function (e) {
      if (offer !== o) return;
      o.busy = false;
      // this website or device can't make passkeys at all; anything else (cancelled, not the right face): try again?
      if (e && (e.name === 'NotSupportedError' || e.name === 'SecurityError')) cantFace(o); else offerUi('retry');
    });
  }

  async function faceMade(o, cred) {
    if (offer !== o) return;
    var secret = prfFirst(cred);
    if (!o.id) {
      o.id = b64url(new Uint8Array(cred.rawId));
      // some devices give the secret only when the passkey is used, not when it is made
      if (!secret && prfEnabled(cred)) { o.busy = false; offerUi('finish'); return; }
    }
    if (!secret) { cantFace(o); return; }
    var rec = null;
    try { rec = await faceWrap(secret, o.salt, o.K, o.slot, o.id, location.hostname); } catch (e) { rec = null; }
    secret = null;
    if (!rec) { cantFace(o); return; } // (no HKDF in this browser)
    // Face ID instead of a remembered password from now on
    if (saveFace(rec)) { forget(); setFace(rec); }
    letsGo();
  }

  // ------------------------------------------------------------------ go

  if (!window.crypto || !crypto.subtle || typeof TextEncoder !== 'function' || typeof fetch !== 'function'
    || typeof Blob !== 'function' || !window.URL || !URL.createObjectURL) {
    var insecure = window.isSecureContext === false || (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
    root.setAttribute('data-state', 'fatal');
    msg.textContent = insecure
      ? 'This page isn’t secure, so the game can’t be unlocked here. Open its https:// address.'
      : 'This browser is too old to unlock the game. Update iPadOS / Safari, or try Chrome.';
    return;
  }

  // Banned? localStorage and the cookie say so at once (the page's <head> already shows the ban
  // screen then: html.ls-banned); IndexedDB answers a moment later. Until it has, nothing is
  // unlocked and no remembered password is tried (the screen stays on "Unlocking…" meanwhile).
  useStores(readSync());
  // Face ID on for this folder: its button, and no remembered password (that would skip the face)
  try { if (localStorage.getItem(FACE) && !readFace()) dropFace(); } catch (e) { /* (only a broken record goes) */ }
  setFace(webauthn ? readFace() : null);
  if (face) forget();
  // can this device do Face ID? (asked now, so the offer after the right password doesn't wait)
  var capable = webauthn && !noFace() ? faceAvailable(PublicKeyCredential) : Promise.resolve(false);
  var saved = stored();
  if (isBanned(ban)) { getMeta(); banned(true); } else download(false);
  var checked = readAll().then(function (now) { useStores(mergeBan(ban, now)); });

  card.onsubmit = function (e) {
    if (e) e.preventDefault();
    // (Enter in the unban box submits the form too)
    if (root.getAttribute('data-state') === 'banned') { tryUnban(); return false; }
    if (busy || offer) return false;
    var p = normalize(input.value);
    if (!p) { ask('Type your password'); return false; }
    // only a real password counts towards the ban: these never reach the key slots
    if (p.length !== 8) { ask('Passwords are 8 letters and numbers'); shake(); return false; }
    if (!CHARS.test(p)) { ask('Passwords never have 0, O, 1 or I. Check what you typed.'); shake(); return false; }
    // the same wrong password again (a double tap, Go pressed twice): it was checked already, so not another strike
    if (p === lastWrong) { ask('Wrong password — ' + triesLeft(ban.strikes)); shake(); return false; }
    unlock(p, false);
    return false;
  };
  retry.onclick = function () {
    if (busy) return;
    var kind = root.getAttribute('data-error');
    if (kind === 'boot') { location.reload(); return; }
    reloaded = false;
    download(true);
    if (last) unlock(last.password, last.auto); else ask('');
  };
  // typing clears a message, but not the warning of how many tries are left (that matters most now)
  input.addEventListener('input', function () {
    if (root.getAttribute('data-state') !== 'ask') return;
    msg.textContent = ban.strikes ? triesLeft(ban.strikes) : '';
    msg.classList.remove('ls-ok');
  });
  unbanOpen.onclick = function () {
    root.classList.add('ls-unbanning');
    ban = mergeBan(ban, readSync());
    unbanBox('');
    if (!code.readOnly) { try { code.focus(); } catch (e) { /* fine */ } }
  };
  unbanGo.onclick = function () { tryUnban(); };
  faceGo.onclick = function () { faceUnlock(); };
  faceOn.onclick = function () { faceTap(); };
  faceNo.onclick = function () {
    if (!offer || offer.busy) return;
    // not asked again on this device: the password still works (after 'set up again', the old setup stays)
    if (!offer.again) setNoFace('later');
    letsGo();
  };
  faceForget.onclick = function () {
    if (busy || !face) return;
    var rec = face;
    dropFace();
    setFace(null);
    unknownPasskey(rec.rp, rec.id);
    ask('Face ID is off on this device. Its passkey can be deleted in the Passwords app (or Settings › Passwords).');
    msg.classList.add('ls-ok');
  };
  code.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tryUnban(); } });
  // typing on an iPad: the Face ID button steps aside so the keyboard doesn't cover UNLOCK. It comes
  // back a moment after the box loses focus: tapping UNLOCK takes the focus first, and the button
  // must not jump down under the finger before the tap lands
  if ('ontouchstart' in window) {
    var typing = 0;
    input.addEventListener('focus', function () { clearTimeout(typing); root.classList.add('ls-typing'); });
    input.addEventListener('blur', function () {
      clearTimeout(typing);
      typing = setTimeout(function () { root.classList.remove('ls-typing'); }, 400);
    });
  }
  code.addEventListener('input', function () { if (!checking && !code.readOnly) umsg.textContent = ''; });

  if (!isBanned(ban) && !saved) ask(ban.strikes ? triesLeft(ban.strikes) : '');
  checked.then(function () {
    if (isBanned(ban)) {
      if (root.getAttribute('data-state') !== 'banned') banned(); else saveBan(ban);
      return;
    }
    if (ban.strikes || ban.tries || ban.until) saveBan(ban); // (puts back a store that was cleared)
    if (saved) unlock(saved, true);
    else if (!busy && root.getAttribute('data-state') === 'ask' && !msg.textContent && ban.strikes) msg.textContent = triesLeft(ban.strikes);
  });
})();
