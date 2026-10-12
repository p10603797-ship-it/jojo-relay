// News from Philip: announce.json next to the page (only whoever runs the website can change it),
// checked when the game starts, every minute and whenever the page comes back on screen.
//   { "message": "...", "id": "...", "version": "2.1.0" }
// A message shows as a banner across the top until it is closed (closed messages stay closed,
// by id). A version newer than this page's shows 'tap to update' in the lobby, which reloads with
// fresh copies of the game's files.
import { VERSION } from '../../shared/constants.js';

const SEEN_KEY = 'phortnite.announceSeen';
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
    const key = `${b.update}|${b.id}`;
    if (key === this.shown) return;
    this.shown = key;
    const el = this.el;
    el.classList.toggle('hidden', !b.update && !b.message);
    // (placed once it has its new text)
    requestAnimationFrame(() => this.place());
    el.classList.toggle('update', b.update);
    el.innerHTML = '';
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
    const x = document.createElement('button');
    x.className = 'an-x';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '✕';
    x.addEventListener('click', () => {
      this.closed = b.id;
      try { localStorage.setItem(SEEN_KEY, b.id); } catch (e) { /* private mode: closed for this visit */ }
      this.render();
    });
    el.append(t, x);
  }
}
