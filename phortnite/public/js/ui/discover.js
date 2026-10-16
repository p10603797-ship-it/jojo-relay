// The Discover screen (pick a mode) and the custom mode creator. DOM only; css/modes.css.
//
// Discover is a full-screen sheet: search, a Featured hero tile that changes every day, then
// rows of mode tiles (My Modes with CREATE / ENTER CODE / SURPRISE ME and saved modes, Battle
// Royale, Team Up, Party Games, Crazy Mutators, Builders, Practice, Places). A tile opens a detail
// sheet with PICK (party leader) or SUGGEST (members). Modes whose game is missing from GAMES are
// hidden. The lobby (js/ui/lobby.js) opens it from the mode card's CHANGE button.
import { MODES, findMode } from '../../shared/modes/index.js';
import { modeAvailable } from '../../shared/modes/catalog.js';
import { normalizeRules, rulesFingerprint } from '../../shared/modes/rules.js';
import { encodeRules, decodeRules, describeRules, placeList, prettyCode } from '../../shared/modes/code.js';
import { GAMES } from '../../shared/modes/games/index.js';
import { createCreator, loadSaved, saveMode, removeSaved } from './creator.js';

export { loadSaved, saveMode, removeSaved };

const ROWS = [
  ['br', 'Battle Royale'], ['team', 'Team Up'], ['party', 'Party Games'], ['mutators', 'Crazy Mutators'],
  ['builders', 'Builders'], ['practice', 'Practice'], ['places', 'Places'],
];
/** The hero tile cycles through these, one per day. */
const FEATURED = ['team-rumble', 'gun-game', 'infection', 'koth', 'juggernaut', 'floor-is-lava', 'moon', 'big-head', 'box-fight', 'city-rumble', 'one-shot', 'mystery'];
/** Tiles with a NEW badge. */
const NEW_IDS = new Set(['team-rumble', 'gun-game', 'infection', 'koth', 'juggernaut', 'floor-is-lava', 'mystery', 'box-fight', 'zone-wars', 'city-rumble', 'castle-siege', 'pirate-party']);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A darker shade of a #rrggbb colour (for the tile gradients). */
function shade(hex, k) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return '#333355';
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

/** The modes that can be played right now (their game is in GAMES). */
export function availableModes() {
  return MODES.filter((m) => modeAvailable(m, GAMES));
}

/** Today's featured mode. */
export function featuredMode(day = Math.floor(Date.now() / 86400000)) {
  const list = FEATURED.map(findMode).filter((m) => m && modeAvailable(m, GAMES));
  return list.length ? list[((day % list.length) + list.length) % list.length] : availableModes()[0];
}

function badges(m, rules) {
  const out = [];
  if (NEW_IDS.has(m.id)) out.push('<b class="new">NEW</b>');
  if (rules.teams !== 1) out.push('<b>TEAMS</b>');
  if (rules.respawn > 0) out.push('<b>RESPAWN</b>');
  if (rules.build === 'off') out.push('<b>NO BUILD</b>');
  return out.slice(0, 2).join('');
}

function tileHtml(key, m, rules, cur) {
  return `<button class="dv-tile${cur ? ' cur' : ''}" data-key="${esc(key)}" style="--c1:${m.color};--c2:${shade(m.color, 0.45)}">`
    + `<span class="dv-emoji">${m.emoji}</span><span class="dv-badges">${badges(m, rules)}</span>`
    + `<span class="dv-name">${esc(m.name)}</span>${cur ? '<span class="dv-cur">SELECTED</span>' : ''}</button>`;
}

function actionTile(key, emoji, name, color) {
  return `<button class="dv-tile dv-action" data-key="${key}" style="--c1:${color};--c2:${shade(color, 0.45)}"><span class="dv-emoji">${emoji}</span><span class="dv-name">${name}</span></button>`;
}

/** Search score for a mode (lower is better; -1 = no match). */
function score(m, q, rules) {
  const name = m.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.split(/[\s-]+/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (m.id.includes(q)) return 3;
  const tags = [...(m.tags || []), ...describeRules(rules).tags].join(' ').toLowerCase();
  if (tags.includes(q)) return 4;
  if (String(m.desc || '').toLowerCase().includes(q)) return 5;
  return -1;
}

/**
 * Open the Discover sheet. Returns a handle with close(), or null when the screen is not
 * available (callers then show their own fallback list of MODES).
 * @param {object} app
 * @param {{ isLeader: boolean, current: object, onPick: (pick: { id: string } | { custom: object, name: string }) => void,
 *   onSuggest: (id: string) => void, onClose?: () => void }} opts   current = the room settings
 * @returns {{ close: () => void } | null}
 */
export function openDiscover(app, opts = {}) {
  if (typeof document === 'undefined') return null;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  document.getElementById('discover')?.remove();
  const isLeader = opts.isLeader !== false;
  const current = opts.current && typeof opts.current === 'object' ? opts.current : null;
  const world = app && app.world && app.world.data ? app.world.data : null;
  const places = placeList(world);
  const avail = availableModes();
  const rulesOf = new Map(avail.map((m) => [m.id, normalizeRules(m.rules)]));
  const curId = current && !current.custom ? current.modeId || null : null;
  const curFp = current && current.rules ? rulesFingerprint(current.rules) : null;
  // tiles that are not registry modes: saved, typed codes, the current custom mode
  const extra = new Map();
  let saved = loadSaved();
  let disabledInput = false;

  const root = document.createElement('div');
  root.id = 'discover';
  root.className = 'dv-sheet';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Discover modes');

  function myRow() {
    let html = actionTile('act:create', '🛠️', 'CREATE', '#2f8cff') + actionTile('act:code', '🔢', 'ENTER CODE', '#6a3df0') + actionTile('act:surprise', '🎲', 'SURPRISE ME', '#ff8a00');
    extra.clear();
    let nowCode = '';
    if (current && current.custom && current.rules) {
      const r = normalizeRules(current.rules);
      nowCode = encodeRules(r);
      const name = (current.info && current.info.name) || describeRules(r).name;
      extra.set('now', { name, rules: r, emoji: '⭐', color: '#ffd23f', desc: 'The custom mode your party is set to.', custom: true });
      html += tileHtml('x:now', { id: '', name, emoji: '⭐', color: '#ffd23f' }, r, true);
    }
    saved.forEach((s, i) => {
      const r = decodeRules(s.code);
      if (!r || s.code === nowCode) return;
      const key = `s${i}`;
      extra.set(key, { name: s.name, rules: r, emoji: '💾', color: '#26a69a', desc: 'One of your saved modes.', custom: true, code: s.code });
      html += tileHtml(`x:${key}`, { id: '', name: s.name, emoji: '💾', color: '#26a69a' }, r, false);
    });
    return html;
  }

  const hero = featuredMode();
  const heroRules = rulesOf.get(hero.id);
  root.innerHTML = `
    <div class="dv-top">
      <div class="dv-title">DISCOVER</div>
      <label class="dv-search"><span aria-hidden="true">🔍</span><input type="search" placeholder="Search ${avail.length} modes" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>
      <button class="dv-x" aria-label="Close">✕</button>
    </div>
    <div class="dv-scroll">
      <button class="dv-hero" data-key="id:${esc(hero.id)}" style="--c1:${hero.color};--c2:${shade(hero.color, 0.4)}">
        <span class="dv-hero-emoji">${hero.emoji}</span>
        <span class="dv-hero-text"><small>⭐ FEATURED TODAY</small><b>${esc(hero.name)}</b><span class="dv-hero-desc">${esc(hero.desc)}</span>
        <span class="dv-badges">${badges(hero, heroRules)}</span></span>
      </button>
      <section class="dv-row" data-row="mine"><h3>My Modes</h3><div class="dv-strip">${myRow()}</div></section>
      ${ROWS.map(([cat, title]) => {
        const list = avail.filter((m) => m.cat === cat);
        if (!list.length) return '';
        return `<section class="dv-row" data-row="${cat}"><h3>${title} <small>${list.length}</small></h3><div class="dv-strip">${
          list.map((m) => tileHtml(`id:${m.id}`, m, rulesOf.get(m.id), m.id === curId || (!curId && curFp && rulesFingerprint(m.rules) === curFp))).join('')}</div></section>`;
      }).join('')}
      <section class="dv-results"><h3>Results</h3><div class="dv-grid"></div><p class="dv-none">No modes found. Try CREATE to make your own!</p></section>
    </div>
    <div class="dv-detail hidden" role="dialog"><div class="dv-card"></div></div>
    <div class="dv-codesheet hidden" role="dialog"><div class="dv-card">
      <h2>ENTER A MODE CODE</h2>
      <input class="dv-codein" maxlength="40" placeholder="M-XXXX XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false">
      <div class="dv-codeprev">Codes look like <b>M-J8GY MKN6 D7KH</b>. Ask a friend for theirs!</div>
      <div class="dv-btnrow"><button class="dv-btn dv-codeback">BACK</button><button class="dv-btn yellow dv-codego" disabled>OPEN</button></div>
    </div></div>`;
  const $ = (s) => root.querySelector(s);
  const scroll = $('.dv-scroll');
  const input = $('.dv-search input');
  const detail = $('.dv-detail');
  const codesheet = $('.dv-codesheet');
  const codeIn = $('.dv-codein');

  // ------------------------------------------------------------------ detail sheet
  let shown = null; // {key, mode, rules, custom, code}
  function entryOf(key) {
    if (key.startsWith('id:')) {
      const m = findMode(key.slice(3));
      return m ? { key, mode: m, rules: rulesOf.get(m.id) || normalizeRules(m.rules), custom: false } : null;
    }
    if (key.startsWith('x:')) {
      const x = extra.get(key.slice(2));
      return x ? { key, mode: { id: '', players: '1-16', tags: [], ...x }, rules: x.rules, custom: true, code: x.code } : null;
    }
    return null;
  }

  function showDetail(e, title = '') {
    if (!e) return;
    shown = e;
    const m = e.mode;
    const d = describeRules(e.rules);
    const chips = [...new Set([...(m.tags || []), ...d.tags])].slice(0, 9);
    const code = e.code || encodeRules(e.rules, { places });
    const area = e.rules.area;
    const missing = world && area.startsWith('poi:') && !(world.regions || []).some((r) => r.name === area.slice(4));
    const canPick = isLeader && !!opts.onPick;
    const canSuggest = !isLeader && !!opts.onSuggest && !e.custom;
    const isCur = (curId && m.id === curId) || (!curId && curFp && rulesFingerprint(e.rules) === curFp);
    $('.dv-detail .dv-card').innerHTML = `
      ${title ? `<div class="dv-surprise">${title}</div>` : ''}
      <div class="dv-dhead" style="--c1:${m.color};--c2:${shade(m.color, 0.45)}"><span class="dv-emoji">${m.emoji}</span>
        <div><h2>${esc(m.name)}</h2><small>${esc(m.players || '1-16')} players${isCur ? ' · <b>SELECTED</b>' : ''}</small></div></div>
      <p class="dv-desc">${esc(m.desc || d.name)}</p>
      <div class="dv-chips">${chips.map((c) => `<span class="dv-chip">${esc(c)}</span>`).join('')}</div>
      ${missing ? `<p class="dv-note">${esc(area.slice(4))} is on the new island; here it plays on the whole island.</p>` : ''}
      <button class="dv-codeline" data-code="${esc(code)}">Mode code <b>${esc(prettyCode(code))}</b> <span>tap to copy</span></button>
      <div class="dv-btnrow">
        <button class="dv-btn dv-back">BACK</button>
        <button class="dv-btn dv-custom">🛠️ CUSTOMIZE</button>
        ${e.code ? '<button class="dv-btn dv-del">🗑 DELETE</button>' : e.custom ? '<button class="dv-btn dv-savex">💾 SAVE</button>' : ''}
        ${canPick ? '<button class="dv-btn yellow dv-pick">✓ PICK</button>' : ''}
        ${canSuggest ? '<button class="dv-btn yellow dv-suggest">👍 SUGGEST</button>' : ''}
      </div>
      ${!isLeader && !canSuggest ? '<p class="dv-note">Only the party leader can pick a mode. Share the code with them!</p>' : ''}`;
    detail.classList.remove('hidden');
  }

  function hideDetail() { detail.classList.add('hidden'); shown = null; }

  function pick(e) {
    if (!e || !opts.onPick) return;
    if (e.custom) opts.onPick({ custom: { ...e.rules }, name: e.mode.name });
    else opts.onPick({ id: e.mode.id });
    close();
  }

  function refreshMine() {
    saved = loadSaved();
    $('[data-row="mine"] .dv-strip').innerHTML = myRow();
  }

  function openCreatorFrom(initial, name) {
    const leader = isLeader && !!opts.onPick;
    if (child && child.close) child.close();
    child = createCreator(app, {
      initial, name, parent: root,
      onPlay: leader ? (p) => { opts.onPick(p); close(); } : null,
      onSave: () => refreshMine(),
      onClose: () => { if (!closed) refreshMine(); },
    });
    return child;
  }

  // ------------------------------------------------------------------ code sheet
  function codeTyped() {
    const r = decodeRules(codeIn.value, { places });
    $('.dv-codego').disabled = !r;
    $('.dv-codeprev').innerHTML = r
      ? `✓ <b>${esc(describeRules(r).name)}</b><br>${describeRules(r).tags.map((t) => `<span class="dv-chip">${esc(t)}</span>`).join('')}`
      : codeIn.value.trim().length > 3 ? '✗ That code does not work. Check the letters!' : 'Codes look like <b>M-J8GY MKN6 D7KH</b>. Ask a friend for theirs!';
    return r;
  }

  // ------------------------------------------------------------------ search
  function search(q) {
    const s = q.trim().toLowerCase();
    root.classList.toggle('searching', !!s);
    if (!s) return [];
    const hits = [];
    for (const m of avail) {
      const sc = score(m, s, rulesOf.get(m.id));
      if (sc >= 0) hits.push([sc, m]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    $('.dv-grid').innerHTML = hits.map(([, m]) => tileHtml(`id:${m.id}`, m, rulesOf.get(m.id), m.id === curId)).join('');
    $('.dv-none').style.display = hits.length ? 'none' : '';
    scroll.scrollTop = 0;
    return hits.map(([, m]) => m.id);
  }
  let searchRaf = 0;
  input.addEventListener('input', () => {
    if (searchRaf) return;
    searchRaf = requestAnimationFrame(() => { searchRaf = 0; search(input.value); });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = root.querySelector('.dv-grid .dv-tile');
    input.blur();
    if (first) showDetail(entryOf(first.dataset.key));
  });

  // ------------------------------------------------------------------ taps
  root.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t || !root.contains(t) || t.closest('#creator')) return;
    if (app && app.sfx && app.sfx.ui) app.sfx.ui();
    const key = t.dataset.key;
    if (key === 'act:create') { openCreatorFrom({}); return; }
    if (key === 'act:code') { codesheet.classList.remove('hidden'); codeIn.value = ''; codeTyped(); setTimeout(() => codeIn.focus(), 50); return; }
    if (key === 'act:surprise') {
      const pool = avail.filter((m) => m.id !== curId);
      const m = pool[Math.floor(Math.random() * pool.length)];
      if (m) showDetail(entryOf(`id:${m.id}`), '🎲 SURPRISE!');
      return;
    }
    if (key) { showDetail(entryOf(key)); return; }
    if (t.classList.contains('dv-x')) { close(); return; }
    if (t.classList.contains('dv-back')) { hideDetail(); return; }
    if (t.classList.contains('dv-pick')) { pick(shown); return; }
    if (t.classList.contains('dv-suggest')) {
      if (shown && shown.mode.id) opts.onSuggest(shown.mode.id);
      t.textContent = '✓ SENT TO THE LEADER';
      t.disabled = true;
      setTimeout(() => close(), 900);
      return;
    }
    if (t.classList.contains('dv-custom')) { if (shown) openCreatorFrom(shown.rules, shown.mode.name); return; }
    if (t.classList.contains('dv-savex')) {
      if (shown) { saveMode(shown.mode.name, shown.rules); refreshMine(); t.textContent = '✓ SAVED'; t.disabled = true; }
      return;
    }
    if (t.classList.contains('dv-del')) { if (shown && shown.code) { removeSaved(shown.code); refreshMine(); hideDetail(); } return; }
    if (t.classList.contains('dv-codeline')) {
      try { navigator.clipboard.writeText(t.dataset.code).then(() => { t.querySelector('span').textContent = '✓ copied'; }, () => {}); } catch (e) { /* no clipboard */ }
      return;
    }
    if (t.classList.contains('dv-codeback')) { codesheet.classList.add('hidden'); return; }
    if (t.classList.contains('dv-codego')) {
      const r = codeTyped();
      if (!r) return;
      codesheet.classList.add('hidden');
      extra.set('typed', { name: describeRules(r).name, rules: r, emoji: '🔢', color: '#6a3df0', desc: 'A mode from a code.', custom: true });
      showDetail(entryOf('x:typed'));
    }
  });
  codeIn.addEventListener('input', codeTyped);
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('.dv-codego').click(); });
  detail.addEventListener('click', (e) => { if (e.target === detail) hideDetail(); });
  codesheet.addEventListener('click', (e) => { if (e.target === codesheet) codesheet.classList.add('hidden'); });
  // the game and the touch controls underneath must not see these touches
  root.addEventListener('pointerdown', (e) => e.stopPropagation());

  let closed = false;
  let child = null; // the creator opened from here (closed with this sheet)
  function onKey(e) {
    if (e.key !== 'Escape' || root.querySelector('#creator')) return;
    e.stopPropagation();
    if (!codesheet.classList.contains('hidden')) codesheet.classList.add('hidden');
    else if (shown) hideDetail();
    else close();
  }
  /** auto = true: closed for the player (a match is starting); true when a creator saved their edits. */
  function close(auto = false) {
    if (closed) return false;
    closed = true;
    let kept = false;
    if (child) { try { kept = !!child.close(auto === true); } catch (e) { /* already gone */ } child = null; }
    window.removeEventListener('keydown', onKey, true);
    if (searchRaf) cancelAnimationFrame(searchRaf);
    root.classList.add('closing');
    setTimeout(() => root.remove(), 180);
    if (disabledInput && app.input && !app.input.enabled && app.game && app.game.me) app.input.enabled = true;
    if (opts.onClose) opts.onClose();
    return kept;
  }
  window.addEventListener('keydown', onKey, true);
  if (app && app.input && app.input.enabled) { app.input.enabled = false; disabledInput = true; }
  if (app && app.input && app.input.exitLock) app.input.exitLock();
  document.body.appendChild(root);
  return {
    close,
    el: root,
    get open() { return !closed; },
    search: (q) => { input.value = q; return search(q); },
    show: (id) => showDetail(entryOf(`id:${id}`)),
    creator: (initial) => openCreatorFrom(initial || {}),
    openMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
  };
}

/**
 * Open the custom mode creator. Returns a handle with close(), or null when it is not available.
 * @param {object} app
 * @param {{ initial?: object, onPlay: (pick: { custom: object, name: string }) => void, onSave?: (mode: object) => void }} opts
 *   initial = rules to start from
 * @returns {{ close: () => void } | null}
 */
export function openCreator(app, opts = {}) {
  if (typeof document === 'undefined') return null;
  return createCreator(app, opts);
}
