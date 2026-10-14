// News from Philip: announce.json next to the page (only whoever runs the website can change it),
// checked when the game starts, every minute and whenever the page comes back on screen.
//   { "message": "...", "id": "...", "version": "2.1.0" }
// A message shows as a banner across the top until it is closed (closed messages stay closed,
// by id). A version newer than this page's shows 'tap to update' in the lobby, which reloads with
// fresh copies of the game's files.
// The admin's banner (a signed state message, js/admin/client.js -> setAdmin) uses the same box, in
// the lobby and in matches, and comes first while it is up; it says it is from the admin, can be
// closed, and goes when the admin clears it or its time is up.
import { VERSION } from '../../shared/constants.js';

const SEEN_KEY = 'phortnite.announceSeen';
const ADMIN_SEEN_KEY = 'phortnite.adminBannerSeen';
const CHECK_MS = 60000;

/** True when version a is newer than b ('2.10.0' > '2.9.1'). */
export function isNewer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * What to show for an announce.json: { update: bool, message: text or '', id }.
 * seen: ids of closed messages; inMatch: no update prompt in the middle of a match.
 */
export function pickBanner(a, { version = VERSION, seen = [], inMatch = false } = {}) {
  const out = { update: false, message: '', id: '' };
  if (!a || typeof a !== 'object') return out;
  out.update = !inMatch && typeof a.version === 'string' && isNewer(a.version, version);
  const msg = typeof a.message === 'string' ? a.message.trim().slice(0, 200) : '';
  const id = typeof a.id === 'string' && a.id ? a.id.slice(0, 80) : msg;
  if (msg && ![].concat(seen).includes(id)) { out.message = msg; out.id = id; }
  return out;
}

/** Reload with fresh copies of the game's files (a plain reload may reuse cached old ones). */
export async function freshReload() {
  try {
    const base = new URL('.', location.href).href;
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
      .filter((u) => u.startsWith(base) && /\.(js|css|json|webmanifest)(\?|$)/.test(u) && !/announce\.json/.test(u));
    urls.push(location.href.split('#')[0]);
    await Promise.race([
      Promise.all(urls.map((u) => fetch(u, { cache: 'reload' }).catch(() => {}))),
      new Promise((r) => setTimeout(r, 6000)),
    ]);
  } catch (e) { /* reload anyway */ }
  location.reload();
}

export class Announce {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('announce');
    this.data = null;
    this.shown = '';
    this.closed = ''; // closed this session (when localStorage can't keep it)
    this.admin = null; // the admin's banner { text, id, until } (setAdmin)
    this.adminClosed = '';
  }

  /** The admin's banner ({ text, id, until: ms or 0 = until cleared }), or null to clear it. */
  setAdmin(b) {
    this.admin = b && b.text ? { text: String(b.text).slice(0, 200), id: String(b.id || b.text).slice(0, 80), until: +b.until || 0 } : null;
    this.render();
    requestAnimationFrame(() => this.place());
  }

  /** The admin's banner while it is up and not closed here, else null. */
  adminBanner() {
    const b = this.admin;
    if (!b || (b.until && Date.now() > b.until)) return null;
    let stored = '';
    try { stored = localStorage.getItem(ADMIN_SEEN_KEY) || ''; } catch (e) { /* private mode */ }
    return b.id === stored || b.id === this.adminClosed ? null : b;
  }

  start() {
    if (!this.el) return;
    this.check();
    setInterval(() => this.check(), CHECK_MS);
    // in and out of matches: the update prompt waits for the lobby
    setInterval(() => { this.render(); this.place(); }, 2000);
    window.addEventListener('resize', () => this.place());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.check(); });
  }

  async check() {
    try {
      const r = await fetch(`announce.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      this.data = await r.json();
    } catch (e) { return; }
    this.render();
  }

  /**
   * In the lobby: in the top bar between its buttons when it fits, else under the bar right of the
   * party cards (and the toasts under it). In a match (and while loading) the stylesheet's spot:
   * the top middle.
   */
  place() {
    const el = this.el, st = el.style;
    st.left = st.top = st.maxWidth = st.width = '';
    let low = false;
    const lobby = document.body.classList.contains('onstage') && !el.classList.contains('hidden');
    const sp = lobby && document.querySelector('#lobby .lb-spacer');
    const chip = lobby && document.querySelector('#lobby .lb-level');
    if (sp && chip) {
      const r = sp.getBoundingClientRect(), c = chip.getBoundingClientRect();
      if (r.width >= 300) {
        st.left = `${r.left + r.width / 2}px`;
        st.maxWidth = `${Math.floor(r.width - 12)}px`;
        st.top = `${Math.max(4, c.top + c.height / 2 - el.offsetHeight / 2)}px`;
      } else {
        const rail = document.querySelector('#lobby .lb-rail');
        const left = (rail ? rail.getBoundingClientRect().right : 0) + 12, right = innerWidth - 12;
        st.left = `${(left + right) / 2}px`;
        st.maxWidth = `${Math.floor(right - left)}px`;
        // (centred on 'left', a fixed box would only get the width right of it: half the room)
        st.width = 'max-content';
        st.top = `${c.bottom + 10}px`;
        // the toasts go under it, however many lines the message takes
        document.body.style.setProperty('--toasts-top', `${Math.round(c.bottom + 10 + el.offsetHeight + 8)}px`);
        low = true;
      }
    }
    document.body.classList.toggle('announce-low', low);
    // where it ends (0: not shown): in a match the admin's chips and cards and the toasts go under it
    const shown = !el.classList.contains('hidden') && el.offsetHeight > 0;
    document.body.style.setProperty('--announce-bottom', `${shown ? Math.round(el.offsetTop + el.offsetHeight) : 0}px`);
  }

  seen() {
    let stored = '';
    try { stored = localStorage.getItem(SEEN_KEY) || ''; } catch (e) { /* private mode */ }
    return [stored, this.closed].filter(Boolean);
  }

  render() {
    const app = this.app;
    const inMatch = !!(app.game && !app.stageOn);
    const b = pickBanner(this.data, { seen: this.seen(), inMatch });
    const ab = this.adminBanner();
    const key = ab ? `admin|${ab.id}|${ab.text}` : `${b.update}|${b.id}`;
    if (key === this.shown) return;
    this.shown = key;
    const el = this.el;
    el.classList.toggle('hidden', !ab && !b.update && !b.message);
    // (placed once it has its new text)
    requestAnimationFrame(() => this.place());
    el.classList.toggle('update', !ab && b.update);
    el.classList.toggle('admin', !!ab);
    el.innerHTML = '';
    if (ab) {
      const t = document.createElement('span');
      t.className = 'an-text';
      const tag = document.createElement('b');
      tag.className = 'an-tag';
      tag.textContent = '🛡 ADMIN';
      t.append(tag, ` ${ab.text}`);
      // (in a match it shows two lines at most: a tap shows all of it, another tap two lines again)
      el.classList.remove('open');
      t.addEventListener('click', () => { el.classList.toggle('open'); this.place(); });
      el.append(t, this.closer(() => {
        this.adminClosed = ab.id;
        try { localStorage.setItem(ADMIN_SEEN_KEY, ab.id); } catch (e) { /* private mode: closed for this visit */ }
        this.render();
      }));
      return;
    }
    if (b.update) {
      const btn = document.createElement('button');
      btn.className = 'an-text';
      btn.textContent = '✨ Philip updated the game! Tap here to get the new version';
      btn.addEventListener('click', () => { btn.textContent = 'Updating…'; freshReload(); });
      el.appendChild(btn);
      return;
    }
    if (!b.message) return;
    const t = document.createElement('span');
    t.className = 'an-text';
    t.textContent = `📢 ${b.message}`;
    el.append(t, this.closer(() => {
      this.closed = b.id;
      try { localStorage.setItem(SEEN_KEY, b.id); } catch (e) { /* private mode: closed for this visit */ }
      this.render();
    }));
  }

  /** The banner's ✕. */
  closer(fn) {
    const x = document.createElement('button');
    x.className = 'an-x';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '✕';
    x.addEventListener('click', fn);
    return x;
  }
}
