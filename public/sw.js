/* Sideload portal service worker.
 * Caches only the static shell so the portal opens offline. It never caches the
 * generated manifest.plist or any .ipa (those must always hit the network and be
 * fetched fresh over HTTPS by iOS itself). Scope: /sideload/.
 */
'use strict';

var CACHE = 'sideload-shell-v1';
var SHELL = [
  './',
  './app.webmanifest',
  './icon-180.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () {})
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Never intercept the manifest generator, .ipa downloads, or cross-origin traffic.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/manifest.plist') !== -1) return;
  if (/\.ipa($|\?)/i.test(url.pathname)) return;

  // Only manage the portal's own shell paths.
  if (url.pathname.indexOf('/sideload') !== 0) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return resp;
      }).catch(function () {
        return caches.match('./');
      });
    })
  );
});
