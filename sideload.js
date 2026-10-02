/**
 * @file sideload.js
 * Self-hosted over-the-air (OTA) app-install portal, mounted under `/sideload/`.
 *
 * This is deliberately decoupled from the game relay: it adds a few plain HTTP
 * routes and shares nothing with the WebSocket code. {@link handleSideloadRequest}
 * claims every `/sideload*` path and returns `true` when it has answered the
 * request, so relay.js needs only a single guard line to mount it.
 *
 * What it provides:
 *   GET /sideload/                 -> the iPad-first portal UI (static shell)
 *   GET /sideload/app.webmanifest  -> PWA manifest (add-to-home-screen)
 *   GET /sideload/sw.js            -> offline-shell service worker
 *   GET /sideload/icon-180.png     -> home-screen / apple-touch icon
 *   GET /sideload/icon-512.png     -> maskable icon
 *   GET /sideload/manifest.plist   -> an Apple OTA install manifest, generated
 *                                     from query params (ipa, bundle, version,
 *                                     title, icon)
 *
 * The portal uses Apple's documented `itms-services://?action=download-manifest`
 * flow. It streamlines *distribution* of apps the operator is authorised to
 * install (ad-hoc / enterprise / developer-signed builds). It performs no
 * code-signing and bypasses none: iOS still refuses any `.ipa` that is not
 * properly signed for the target device. The server never fetches the `.ipa`
 * or icon URLs — it only embeds them in the manifest that iOS downloads — so the
 * manifest route is a pure template renderer with no SSRF surface.
 *
 * Runtime dependencies: Node >= 18 builtins only.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Portal build version, surfaced in logs/UI. @type {string} */
export const SIDELOAD_VERSION = '1.0.0';

/** Absolute path to the bundled static assets. */
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

/** In-memory asset cache: published path -> { body: Buffer, type: string }. */
const assetCache = new Map();

/** Static asset table: route path -> { file, type, immutable }. */
const ASSETS = {
  '/sideload/': { file: 'sideload.html', type: 'text/html; charset=utf-8' },
  '/sideload/index.html': { file: 'sideload.html', type: 'text/html; charset=utf-8' },
  '/sideload/app.webmanifest': { file: 'app.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/sideload/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', sw: true },
  '/sideload/icon-180.png': { file: 'icon-180.png', type: 'image/png', immutable: true },
  '/sideload/icon-512.png': { file: 'icon-512.png', type: 'image/png', immutable: true }
};

/**
 * Read a bundled asset, caching it in memory after the first hit.
 * @param {string} file Basename inside public/.
 * @param {string} type Content-Type to associate.
 * @returns {{ body: Buffer, type: string } | null}
 */
function readAsset(file, type) {
  if (assetCache.has(file)) return assetCache.get(file);
  try {
    const body = fs.readFileSync(PUBLIC_DIR + file);
    const entry = { body, type };
    assetCache.set(file, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Escape a string for safe inclusion in XML text/attribute content.
 * @param {unknown} raw
 * @returns {string}
 */
function xmlEscape(raw) {
  return String(raw == null ? '' : raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Is this an `https://` URL? iOS requires HTTPS for both the manifest and the
 * assets it references.
 * @param {unknown} u
 * @returns {boolean}
 */
function isHttpsUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!/^https:\/\/\S+$/i.test(s)) return false;
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}

/**
 * Trim, strip control characters and cap the length of an untrusted query value.
 * @param {string|null} raw
 * @param {number} max
 * @returns {string}
 */
function field(raw, max) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * Build an Apple OTA install manifest (`manifest.plist`).
 * @param {{ ipa: string, bundle?: string, version?: string, title?: string, icon?: string }} app
 * @returns {string} The plist XML.
 */
export function buildManifestPlist(app) {
  const assets = [
    '        <dict>',
    '          <key>kind</key><string>software-package</string>',
    `          <key>url</key><string>${xmlEscape(app.ipa)}</string>`,
    '        </dict>'
  ];
  if (app.icon && isHttpsUrl(app.icon)) {
    assets.push(
      '        <dict>',
      '          <key>kind</key><string>display-image</string>',
      `          <key>url</key><string>${xmlEscape(app.icon)}</string>`,
      '        </dict>',
      '        <dict>',
      '          <key>kind</key><string>full-size-image</string>',
      `          <key>url</key><string>${xmlEscape(app.icon)}</string>`,
      '        </dict>'
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
${assets.join('\n')}
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${xmlEscape(app.bundle || 'com.example.app')}</string>
        <key>bundle-version</key><string>${xmlEscape(app.version || '1.0')}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${xmlEscape(app.title || 'App')}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

/**
 * Write a response, honouring HEAD and applying shared hardening headers.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string|Buffer} body
 * @param {Record<string,string>} [extra]
 * @returns {true} Always true, so callers can `return send(...)`.
 */
function send(req, res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, Object.assign({
    'content-type': type,
    'content-length': buf.length,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  }, extra));
  res.end(req.method === 'HEAD' ? undefined : buf);
  return true;
}

/** Content-Security-Policy for the portal HTML. Permits inline CSS/JS and remote app icons. */
const PORTAL_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

/**
 * Handle a `/sideload*` HTTP request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when the request was for the sideload portal and has
 *   been answered; false when the caller should keep routing it.
 */
export function handleSideloadRequest(req, res) {
  const raw = req.url || '/';
  const path = raw.split('?')[0];
  if (path !== '/sideload' && path.indexOf('/sideload/') !== 0) return false;

  // Canonicalise the bare prefix so the service-worker scope ('/sideload/') holds.
  if (path === '/sideload') {
    res.writeHead(308, { location: '/sideload/', 'content-length': 0 });
    res.end();
    return true;
  }

  // Generated OTA manifest.
  if (path === '/sideload/manifest.plist') {
    let params;
    try { params = new URL(raw, 'http://localhost').searchParams; }
    catch { params = new URLSearchParams(); }
    const ipa = field(params.get('ipa'), 2000);
    if (!isHttpsUrl(ipa)) {
      return send(req, res, 400, 'application/json; charset=utf-8',
        JSON.stringify({ ok: false, error: 'query param "ipa" must be an https:// URL to a signed .ipa' }),
        { 'cache-control': 'no-store' });
    }
    const plist = buildManifestPlist({
      ipa,
      bundle: field(params.get('bundle'), 155),
      version: field(params.get('version'), 40),
      title: field(params.get('title'), 120),
      icon: field(params.get('icon'), 2000)
    });
    return send(req, res, 200, 'text/xml; charset=utf-8', plist, {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
  }

  // Static assets.
  const spec = ASSETS[path];
  if (spec) {
    const asset = readAsset(spec.file, spec.type);
    if (!asset) return send(req, res, 404, 'text/plain; charset=utf-8', 'asset missing');
    const headers = {};
    if (spec.immutable) headers['cache-control'] = 'public, max-age=604800';
    else headers['cache-control'] = 'no-cache';
    if (spec.sw) headers['service-worker-allowed'] = '/sideload/';
    if (spec.type.startsWith('text/html')) headers['content-security-policy'] = PORTAL_CSP;
    return send(req, res, 200, asset.type, asset.body, headers);
  }

  // Anything else under /sideload is ours to 404.
  return send(req, res, 404, 'application/json; charset=utf-8',
    JSON.stringify({ ok: false, error: 'not found' }));
}
