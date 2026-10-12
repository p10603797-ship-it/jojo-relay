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
 *
 * Plain ES2017 (no ?. ?? ... in objects, or catch without a binding): even an old browser must
 * at least get to show a message.
 */
(function () {
  'use strict';
  // (the same expression as STORE_EXPR in tools/lock.mjs, which reads it in the page's <head>)
  var STORE = 'phortnite.pass:' + location.pathname.replace(/[^/]*$/, '');
  var PREFIX = '@phortnite/';
  // Does the browser itself do import maps? (Safari before 16.4 doesn't: es-module-shims runs the
  // game there.) Read before es-module-shims can swap in its own HTMLScriptElement.supports, and
  // never trust that one: it says yes to 'importmap' (it is an unnamed arrow, the browser's is "supports").
  var nativeSupports = window.HTMLScriptElement && HTMLScriptElement.supports;
  var $ = function (id) { return document.getElementById(id); };
  var root = $('lockscreen'), card = $('ls-card'), input = $('ls-pass'), go = $('ls-go');
  var remember = $('ls-remember'), msg = $('ls-msg'), retry = $('ls-retry');
  if (!root || !card) return;

  var meta = null;      // Promise of lock.json
  var archive = null;   // Promise of { kind, file, bytes }
  var busy = false;
  var last = null;      // the password of the last attempt (memory only), for TRY AGAIN
  var reloaded = false; // the archive was fetched again past the cache once already
  var broken = false;   // the last download failed (the next try starts a new one)
  var gen = 0;          // which download is the current one
  var useGz = typeof DecompressionStream === 'function' && typeof Blob === 'function' && !!Blob.prototype.stream;

  // ------------------------------------------------------------------ screen

  /** ask | working (ask, with the button busy) | wait | error (TRY AGAIN) | fatal */
  function state(s, text) {
    var working = s === 'working';
    root.setAttribute('data-state', working ? 'ask' : s);
    msg.textContent = text || '';
    go.disabled = working;
    input.readOnly = working; // (not disabled: that would drop the iPad keyboard mid-try)
    go.textContent = working ? 'Unlocking…' : 'UNLOCK';
  }

  function ask(text) {
    state('ask', text);
    // a keyboard pops up only on a tap on touch screens; on a computer type straight away
    if (!('ontouchstart' in window)) { try { input.focus(); input.select(); } catch (e) { /* fine */ } }
    // on an iPad the keyboard is still up after a wrong try: select the text so typing replaces it
    else if (document.activeElement === input && input.value) {
      try { input.setSelectionRange(0, input.value.length); } catch (e) { /* fine */ }
    }
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

  /** Start (or restart) both downloads; `fresh` goes past the browser's cache. */
  function download(fresh) {
    var g = ++gen;
    broken = false;
    meta = fetchOk('lock.json?t=' + Date.now(), 'no-store').then(function (r) {
      return r.json().catch(function (e) { throw failure('corrupt', e); });
    });
    archive = meta.then(function (m) {
      var kind = useGz ? 'gz' : 'raw', file = m.files && m.files[kind];
      if (!file) throw failure('corrupt');
      // the IV changes with every build, so ?v= never mixes builds up in a cache
      return fetchOk(file.path + '?v=' + encodeURIComponent(file.iv.slice(0, 16)), fresh ? 'reload' : 'no-cache')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (bytes) { return { kind: kind, file: file, bytes: bytes }; });
    });
    // nobody may be waiting yet: keep "unhandled rejection" noise out of the console
    meta.catch(function () {});
    archive.catch(function () { if (g === gen) broken = true; });
  }

  // ------------------------------------------------------------------ crypto

  var enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function normalize(p) {
    return String(p || '').toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]+/g, '');
  }

  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** The game key from whichever slot this password opens, or null. One PBKDF2 for all slots. */
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
      if (raw && raw.byteLength === 32) return subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    }
    return null;
  }

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
      var m = await meta;
      var key = await unwrap(m, password);
      if (!key) {
        busy = false;
        last = null;
        if (auto) { forget(); ask('That password was turned off — ask Philip for a new one'); return; }
        ask('Wrong password — try again');
        shake();
        return;
      }
      // the right password: remember it (or forget an old one) as the box says
      if (auto || remember.checked) store(normalize(password)); else forget();
      var doc;
      try {
        doc = await open(key);
      } catch (e) {
        if (e.kind !== 'corrupt' || reloaded) throw e;
        // an old copy in a cache, or a half download: once more, straight from the website
        reloaded = true;
        download(true);
        m = await meta;
        key = await unwrap(m, password);
        if (!key) throw failure('corrupt');
        doc = await open(key);
      }
      busy = false;
      last = null;
      meta = archive = null; // (the encrypted copy is not needed any more)
      start(m, doc);
    } catch (e) {
      failed(e);
    }
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

  download(false);

  card.onsubmit = function (e) {
    if (e) e.preventDefault();
    if (busy) return false;
    var p = normalize(input.value);
    if (!p) { ask('Type your password'); return false; }
    if (p.length !== 8) { ask('Passwords are 8 letters and numbers'); shake(); return false; }
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
  input.addEventListener('input', function () { if (root.getAttribute('data-state') === 'ask') msg.textContent = ''; });

  var saved = stored();
  if (saved) unlock(saved, true);
  else ask('');
})();
