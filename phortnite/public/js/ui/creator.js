// The custom mode creator: big chips on 8 tabs (TEAMS · GOAL · STORM · WHERE · LOOT · BUILD ·
// MUTATORS · BOTS), a live auto name and code, SAVE (localStorage 'phortnite.modes', up to 12),
// SHARE CODE and PLAY. DOM only; styles in css/modes.css. Opened through openCreator() in
// js/ui/discover.js (Discover's CREATE / CUSTOMIZE also open it).
import { RULE_FIELDS, normalizeRules } from '../../shared/modes/rules.js';
import { MAP } from '../../shared/constants.js';
import { encodeRules, decodeRules, describeRules, placeList, prettyCode, areaName } from '../../shared/modes/code.js';
import { GAMES } from '../../shared/modes/games/index.js';
import { BIOMES } from '../../shared/world/keys.js';
import { resolveArea, fullArea } from '../../shared/modes/runtime.js';

const STORE = 'phortnite.modes';
const MAX_SAVED = 12;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ------------------------------------------------------------------ saved modes
/** Saved custom modes, newest first: [{name, code, t}] (codes that no longer decode are skipped). */
export function loadSaved() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) return [];
  return list.filter((m) => m && typeof m.code === 'string' && typeof m.name === 'string' && decodeRules(m.code)).slice(0, MAX_SAVED);
}

function writeSaved(list) {
  try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, MAX_SAVED))); return true; } catch (e) { return false; }
}

/** Save a mode (same code: moved to the front, renamed). Returns the saved list. */
export function saveMode(name, rules) {
  const code = encodeRules(rules);
  const list = loadSaved().filter((m) => m.code !== code);
  list.unshift({ name: String(name || describeRules(rules).name).slice(0, 48), code, t: Date.now() });
  writeSaved(list);
  return loadSaved();
}

export function removeSaved(code) {
  writeSaved(loadSaved().filter((m) => m.code !== code));
  return loadSaved();
}

// ------------------------------------------------------------------ what the chips say
const ON_OFF = { true: 'On', false: 'Off' };
const YES_NO = { true: 'Yes', false: 'No' };
const LABELS = {
  teams: { 1: 'Solo', 2: 'Duos', 3: 'Trios', 4: 'Squads', two: '2 Big Teams', humans: 'Friends vs Bots' },
  win: {
    last: 'Last Standing', elims: 'Most Elims', teamelims: 'Team Elims', time: 'Most Points',
    gungame: '🔫 Gun Game', infection: '🧟 Infection', koth: '👑 King of the Hill', juggernaut: '🦾 Juggernaut', lava: '🌋 Floor is Lava',
    hideseek: '🙈 Hide & Seek',
  },
  target: (v) => String(v),
  timeLimit: (v) => (v ? `${v / 60} min` : 'None'),
  rounds: (v) => (v === 1 ? 'One' : `Best of ${v}`),
  respawn: (v) => (v ? `${v} s` : 'Off'),
  lives: (v) => (v ? String(v) : '∞'),
  respawnKeep: { false: 'Lose it', true: 'Keep it' },
  storm: { classic: 'Classic', fast: 'Fast', slow: 'Slow', none: 'No Storm', final: 'Final Circle', zonewars: 'Zone Wars' },
  spawn: { bus: '🚌 Battle Bus', sky: '🪂 Sky Drop', ground: '🏃 On the Ground' },
  loot: {
    all: 'Everything', ars: 'ARs', smgs: 'SMGs', shotguns: 'Shotguns', snipers: 'Snipers', pistols: 'Pistols', rockets: 'Rockets',
    explosive: 'Explosives', pickaxe: 'Pickaxes',
  },
  rarity: { normal: 'Normal', boosted: 'Better', legendary: '🏆 All Gold', common: 'All Grey' },
  floorLoot: ON_OFF,
  chests: ON_OFF,
  heals: { normal: 'Normal', extra: 'Extra', none: 'None' },
  loadout: { none: 'Nothing', pool: 'A Gun', buildfight: 'Build Fight Kit', zonewars: 'Zone Wars Kit', pickaxe: 'Pickaxe' },
  ammo: { normal: 'Normal', infinite: '∞ Infinite' },
  build: { on: 'On', off: 'Off (Zero Build)', infinite: '∞ Infinite' },
  mats: (v) => String(v),
  harvest: (v) => (v ? `×${v}` : 'None'),
  hp: (v) => String(v),
  shield: (v) => String(v),
  siphon: (v) => (v ? `+${v}` : 'None'),
  gravity: { 1: 'Normal', 0.5: 'Low', 0.35: '🌙 Moon', 1.5: 'Heavy' },
  speed: { 1: 'Normal', 1.25: 'Fast', 1.5: 'Turbo', 0.8: 'Slow-Mo' },
  jump: { 1: 'Normal', 1.5: 'High', 2: 'Super' },
  dmg: { 1: '×1', 0.5: '×½', 1.5: '×1.5', 2: '×2' },
  oneShot: ON_OFF,
  headOnly: ON_OFF,
  bigHead: ON_OFF,
  fallDamage: ON_OFF,
  mystery: ON_OFF,
  pvp: { true: 'Yes', false: 'No (No Damage)' },
  bots: (v) => String(v),
  botSkill: { normal: 'Normal', easy: 'Easy', hard: 'Hard', mixed: 'Mixed' },
  maxPlayers: (v) => String(v),
};

function label(key, v) {
  const L = LABELS[key];
  if (typeof L === 'function') return L(v);
  if (L && own(L, String(v))) return L[String(v)];
  return String(v);
}

/** The tabs: [title, [field key, question, when (rules) => shown]]. */
const TABS = [
  ['TEAMS', [['teams', 'Teams']]],
  ['GOAL', [
    ['win', 'How do you win?'],
    ['target', 'Score to win', (r) => ['elims', 'teamelims', 'koth', 'juggernaut'].includes(r.win)],
    ['timeLimit', 'Time limit'],
    ['respawn', 'Respawn'],
    ['lives', 'Lives', (r) => r.respawn > 0],
    ['respawnKeep', 'Your loot when you respawn', (r) => r.respawn > 0],
    ['rounds', 'Rounds'],
  ]],
  ['STORM', [['storm', 'Storm'], ['spawn', 'How you start']]],
  ['WHERE', [['area', 'Where on the island']]],
  ['LOOT', [
    ['loot', 'Guns'], ['rarity', 'Rarity'], ['loadout', 'Start with'], ['ammo', 'Ammo'], ['heals', 'Heals'],
    ['floorLoot', 'Floor loot'], ['chests', 'Chests'],
  ]],
  ['BUILD', [['build', 'Building'], ['mats', 'Start materials', (r) => r.build === 'on'], ['harvest', 'Harvesting', (r) => r.build === 'on']]],
  ['MUTATORS', [
    ['gravity', 'Gravity'], ['speed', 'Speed'], ['jump', 'Jump'], ['dmg', 'Damage amount'], ['bigHead', 'Big heads'], ['oneShot', 'One shot'],
    ['headOnly', 'Headshots only'], ['mystery', 'Mystery mutators'], ['hp', 'Health'], ['shield', 'Start shield'], ['siphon', 'Siphon'],
    ['fallDamage', 'Fall damage'], ['pvp', 'Players can hurt each other'],
  ]],
  ['BOTS', [['bots', 'Bots'], ['botSkill', 'Bot skill'], ['maxPlayers', 'Max players']]],
];
const FIELD = Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f]));

/** Rule changes that come with picking a way to win (so a new mode plays right straight away). */
export function goalPreset(win) {
  const g = own(GAMES, win) ? GAMES[win] : null;
  const base = g && g.defaults ? { ...g.defaults } : {};
  if (win === 'elims' || win === 'teamelims' || win === 'time') {
    // respawn fights: in the middle of the big island (the whole 1.6 km island is a long walk to
    // the next fight) and on a clock, like the curated rumbles
    const arena = { respawn: 3, lives: 0, spawn: 'ground', timeLimit: 600 };
    if ((MAP.size || 0) > 700) arena.area = 'center';
    Object.assign(base, { ...arena, ...base });
  }
  if (win === 'teamelims' && !base.teams) base.teams = 'two';
  if (win === 'last') Object.assign(base, { respawn: 0 });
  return { ...base, win };
}

/**
 * Picking another way to win: first undo what the old goal's preset set (only the fields the
 * player has not changed since, so their own edits stay), then the new goal's preset. Without it
 * presets pile up: Hide & Seek, then Floor is Lava, would be zero-build pickaxe-only lava.
 */
export function goalChange(rules, win) {
  const defs = normalizeRules({});
  const fresh = normalizeRules(goalPreset(rules.win));
  const undo = {};
  for (const f of RULE_FIELDS) {
    const k = f.key;
    if (k !== 'win' && fresh[k] !== defs[k] && rules[k] === fresh[k]) undo[k] = defs[k];
  }
  return { ...undo, ...goalPreset(win) };
}

/** Last standing with respawn and damage on: unlimited lives could never end. */
const endlessLast = (r) => r.win === 'last' && r.respawn > 0 && r.pvp;

/**
 * Is a biome worth its own WHERE chip? Its circle (resolveArea: the biome's largest patch) must be
 * smaller than the island and mostly that biome: the beach is a thin ring around everything.
 */
function biomeFits(world, b) {
  const a = resolveArea(world, `biome:${b}`);
  if (!(a.r < fullArea().r * 0.85)) return false;
  let land = 0, mine = 0;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
    const x = a.x - a.r + (2 * a.r * (i + 0.5)) / 16, z = a.z - a.r + (2 * a.r * (j + 0.5)) / 16;
    if ((x - a.x) ** 2 + (z - a.z) ** 2 > a.r * a.r || !(world.heightAt(x, z) > 0.5)) continue;
    land++;
    if (world.biomeAt(x, z) === b) mine++;
  }
  return land > 0 && mine / land >= 0.2;
}

// ------------------------------------------------------------------ the sheet
/**
 * opts: initial (rules to start from), name, onPlay({custom, name}) (leader only), onSave(mode),
 * onClose(). Returns {close, el} (null without a DOM).
 */
export function createCreator(app, opts = {}) {
  if (typeof document === 'undefined') return null;
  const world = app && app.world && app.world.data ? app.world.data : null;
  const places = placeList(world);
  let rules = normalizeRules(opts.initial || {});
  let tab = 0;
  const root = document.createElement('div');
  root.id = 'creator';
  root.className = 'mc-sheet';
  root.innerHTML = `
    <div class="mc-top">
      <button class="mc-back" aria-label="Back">‹</button>
      <div class="mc-head"><div class="mc-name"></div><div class="mc-tags"></div></div>
      <button class="mc-x" aria-label="Close">✕</button>
    </div>
    <nav class="mc-tabs">${TABS.map(([t], i) => `<button class="mc-tab" data-i="${i}">${t}</button>`).join('')}</nav>
    <div class="mc-body"></div>
    <div class="mc-foot">
      <button class="dv-btn mc-save">💾 SAVE</button>
      <button class="dv-btn mc-share">🔗 SHARE CODE</button>
      <button class="dv-btn yellow mc-play">▶ PLAY</button>
    </div>
    <div class="mc-codebox hidden">
      <div class="mc-codecard">
        <div class="mc-codetitle">Your mode code</div>
        <div class="mc-code"></div>
        <div class="mc-codehint">Friends tap <b>ENTER CODE</b> in Discover and type it.</div>
        <div class="mc-coderow"><button class="dv-btn mc-copy">COPY</button><button class="dv-btn mc-sharebtn">SHARE</button><button class="dv-btn mc-codeok">OK</button></div>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const body = $('.mc-body');
  const play = $('.mc-play');
  if (!opts.onPlay) play.textContent = '✓ DONE';
  const cache = {};
  const set = (k, v, fn) => { if (cache[k] !== v) { cache[k] = v; fn(v); } };

  function summary() {
    const d = describeRules(rules);
    const code = encodeRules(rules, { places });
    set('name', d.name, (v) => { $('.mc-name').textContent = v; });
    set('tags', d.tags.join('|'), () => { $('.mc-tags').innerHTML = d.tags.map((t) => `<span class="dv-chip">${esc(t)}</span>`).join('') + `<span class="dv-chip code">${esc(prettyCode(code))}</span>`; });
    return { d, code };
  }

  function chip(key, v, i, sel, disabled = false) {
    return `<button class="mc-chip${sel ? ' sel' : ''}" data-k="${key}" data-i="${i}"${disabled ? ' disabled' : ''}>${esc(label(key, v))}</button>`;
  }

  function fieldHtml([key, q, when]) {
    if (when && !when(rules)) return '';
    if (key === 'area') return areaHtml();
    const f = FIELD[key];
    const chips = f.options.map((v, i) => {
      if (key === 'lives' && v === 0 && endlessLast(rules)) return ''; // could never end (normalizeRules makes it 3)
      const off = key === 'win' && v !== 'last' && !own(GAMES, v);
      return chip(key, v, i, rules[key] === v, off);
    }).join('');
    return `<section class="mc-field"><h4>${esc(q)}</h4><div class="mc-chips">${chips}</div></section>`;
  }

  // WHERE: the island map with tappable places, plus chips for the island / middle / random / biomes
  function areaHtml() {
    const base = [['full', 'Whole Island'], ['center', 'The Middle'], ['random', 'Random Spot']];
    let biomes = BIOMES.filter((b) => b !== 'ocean');
    if (world && typeof world.biomeAt === 'function' && world.size) biomes = biomes.filter((b) => biomeFits(world, b));
    const chips = base.map(([v, t]) => `<button class="mc-chip${rules.area === v ? ' sel' : ''}" data-area="${v}">${t}</button>`).join('')
      + biomes.map((b) => `<button class="mc-chip${rules.area === `biome:${b}` ? ' sel' : ''}" data-area="biome:${b}">${esc(areaName(`biome:${b}`).replace(/^the /, ''))}</button>`).join('');
    return `<section class="mc-field mc-where"><h4>Where on the island</h4>
      <div class="mc-mapwrap"><canvas class="mc-map" width="360" height="360"></canvas><div class="mc-dots"></div></div>
      <div class="mc-chips">${chips}</div>
      <div class="mc-areanote"></div></section>`;
  }

  function regions() {
    return world && Array.isArray(world.regions) ? world.regions.filter((g) => g && g.named !== false && typeof g.name === 'string') : [];
  }

  function drawMap() {
    const c = root.querySelector('.mc-map');
    if (!c) return;
    const g = c.getContext('2d');
    const S = c.width;
    g.fillStyle = '#2a6f9f';
    g.fillRect(0, 0, S, S);
    const src = app && app.world && app.world.mapCanvas;
    if (src) g.drawImage(src, 0, 0, S, S);
    if (!world) return;
    const k = S / world.size, half = world.half;
    const toX = (x) => (x + half) * k, toY = (z) => (z + half) * k;
    const a = rules.area;
    g.lineWidth = 3;
    g.strokeStyle = '#ffd23f';
    g.fillStyle = 'rgba(255, 210, 63, 0.18)';
    let ring = null;
    if (a === 'center') ring = [0, 0, 0.35 * (MAP.islandRadius || world.size * 0.4)];
    else if (a.startsWith('poi:')) {
      const reg = regions().find((r) => r.name === a.slice(4));
      if (reg) ring = [reg.x, reg.z, Math.max(90, (reg.r || 48) * 2)];
    }
    if (ring) {
      g.beginPath();
      g.arc(toX(ring[0]), toY(ring[1]), ring[2] * k, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    } else if (a === 'full') {
      g.strokeRect(4, 4, S - 8, S - 8);
    }
    const dots = root.querySelector('.mc-dots');
    // labels that would run into one another are left out (the selected place's always shows,
    // and its name is under the map too); bigger places first
    const px = dots.clientWidth || 360;
    const kept = [];
    const regs = regions();
    const order = regs.slice().sort((p, q) => (a === `poi:${q.name}`) - (a === `poi:${p.name}`) || (q.r || 0) - (p.r || 0));
    const showLabel = new Set();
    const at = (r) => [toX(r.x) / S * px, toY(r.z) / S * px];
    for (const r of order) {
      // the label sits centred 18 px under its dot: it must not cover another dot or a kept label
      const [cx, cy] = at(r);
      const w = r.name.length * 7 + 6, ly = cy + 18;
      const box = [cx - w / 2, ly - 8, cx + w / 2, ly + 8];
      const coversDot = regs.some((o) => { if (o === r) return false; const [ox, oy] = at(o); return Math.abs(ox - cx) < w / 2 + 8 && Math.abs(oy - ly) < 16; });
      if (a === `poi:${r.name}` || (!coversDot && !kept.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]))) {
        kept.push(box);
        showLabel.add(r.name);
      }
    }
    const html = regs.map((r) => {
      const sel = a === `poi:${r.name}`;
      return `<button class="mc-dot${sel ? ' sel' : ''}${showLabel.has(r.name) ? '' : ' nolabel'}" tabindex="0" aria-label="${esc(r.name)}" data-area="poi:${esc(r.name)}" style="left:${(toX(r.x) / S * 100).toFixed(2)}%;top:${(toY(r.z) / S * 100).toFixed(2)}%"><i></i><span>${esc(r.name)}</span></button>`;
    }).join('');
    if (dots.dataset.html !== html) { dots.innerHTML = html; dots.dataset.html = html; }
    const note = root.querySelector('.mc-areanote');
    const missing = a.startsWith('poi:') && !regs.some((r) => r.name === a.slice(4));
    note.textContent = missing ? `${a.slice(4)} is not on this island: the whole island is used.`
      : a === 'random' ? 'A different place every match.' : a.startsWith('poi:') ? `📍 ${a.slice(4)}` : '';
  }

  /** A tap on the map picks the nearest place (within 28 px): 26 places are closer than a finger. */
  function pickOnMap(e) {
    const dots = root.querySelector('.mc-dots');
    if (!dots || !world) return false;
    const b = dots.getBoundingClientRect();
    if (!b.width) return false;
    const s = b.width / world.size;
    let best = null, bd = Infinity;
    for (const r of regions()) {
      const d = Math.hypot(b.left + (r.x + world.half) * s - e.clientX, b.top + (r.z + world.half) * s - e.clientY);
      if (d < bd) { bd = d; best = r; }
    }
    if (!best || bd > 28) return true;
    app && app.sfx && app.sfx.ui && app.sfx.ui();
    update({ area: `poi:${best.name}` });
    return true;
  }

  function render() {
    for (const b of root.querySelectorAll('.mc-tab')) b.classList.toggle('sel', +b.dataset.i === tab);
    body.innerHTML = TABS[tab][1].map(fieldHtml).join('');
    body.scrollTop = 0;
    if (TABS[tab][0] === 'WHERE') drawMap();
    summary();
  }

  function update(change) {
    rules = normalizeRules({ ...rules, ...change });
    const top = body.scrollTop;
    body.innerHTML = TABS[tab][1].map(fieldHtml).join('');
    body.scrollTop = top;
    if (TABS[tab][0] === 'WHERE') drawMap();
    summary();
  }

  function pickChip(key, i) {
    const f = FIELD[key];
    const v = f.options[i];
    if (v === undefined) return;
    const change = { [key]: v };
    if (key === 'win') Object.assign(change, goalChange(rules, v));
    // respawn on: unlimited lives (last standing: 3, or it could never end)
    if (key === 'respawn' && v > 0 && rules.respawn === 0) change.lives = endlessLast({ ...rules, ...change }) ? 3 : 0;
    if (key === 'teams' && v === 'humans' && rules.bots < 5) change.bots = 15;
    update(change);
  }

  root.addEventListener('click', (e) => {
    // the WHERE map: the nearest place to the tap (its dots are drawn, not tapped one by one)
    if (e.target.closest && e.target.closest('.mc-dots') && e.detail !== 0) { if (pickOnMap(e)) return; }
    const t = e.target.closest('button');
    if (!t || !root.contains(t) || t.disabled) return;
    app && app.sfx && app.sfx.ui && app.sfx.ui();
    if (t.classList.contains('mc-tab')) { tab = +t.dataset.i; render(); return; }
    if (t.dataset.k !== undefined) { pickChip(t.dataset.k, +t.dataset.i); return; }
    if (t.dataset.area !== undefined) { update({ area: t.dataset.area }); return; }
    if (t.classList.contains('mc-x') || t.classList.contains('mc-back')) { close(); return; }
    if (t.classList.contains('mc-save')) {
      const { d } = summary();
      saveMode(d.name, rules);
      opts.onSave && opts.onSave({ name: d.name, code: encodeRules(rules), rules: { ...rules } });
      t.textContent = '✓ SAVED';
      setTimeout(() => { t.textContent = '💾 SAVE'; }, 1400);
      return;
    }
    if (t.classList.contains('mc-share')) {
      const { code } = summary();
      $('.mc-code').textContent = prettyCode(code);
      $('.mc-codebox').classList.remove('hidden');
      $('.mc-sharebtn').style.display = navigator.share ? '' : 'none';
      return;
    }
    if (t.classList.contains('mc-copy')) {
      const code = encodeRules(rules, { places });
      try { navigator.clipboard.writeText(code).then(() => { t.textContent = '✓ COPIED'; }, () => {}); } catch (err) { /* no clipboard */ }
      return;
    }
    if (t.classList.contains('mc-sharebtn')) {
      const { d, code } = summary();
      try { navigator.share({ title: d.name, text: `Play my Phortnite mode "${d.name}"! Code: ${code}` }).catch(() => {}); } catch (err) { /* no share sheet */ }
      return;
    }
    if (t.classList.contains('mc-codeok')) { $('.mc-codebox').classList.add('hidden'); return; }
    if (t.classList.contains('mc-play')) {
      const { d } = summary();
      if (opts.onPlay) opts.onPlay({ custom: { ...rules }, name: d.name });
      close();
    }
  });
  root.addEventListener('pointerdown', (e) => e.stopPropagation());

  let closed = false;
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    root.classList.add('closing');
    setTimeout(() => root.remove(), 180);
    opts.onClose && opts.onClose();
  }
  window.addEventListener('keydown', onKey, true);
  (opts.parent || document.body).appendChild(root);
  render();
  return { close, el: root, get rules() { return { ...rules }; }, get name() { return describeRules(rules).name; }, setTab(i) { tab = i; render(); }, pick: pickChip };
}

