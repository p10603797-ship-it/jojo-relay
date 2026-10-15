// Party chat text (stage 3): what one chat line may hold. DOM-free, used by the room plugin
// (shared/plugins/chat.js: the room cleans every line it passes on) and by every page that shows a
// line (js/chat: it cleans again on display, so a modded host can't push unfiltered text).
// Idempotent: cleanChat(cleanChat(s).text) gives the same text back (masked false).
//
//   MAX_CHAT           characters (code points) in one line
//   QUICK_CHAT         the quick chat lines; {t:'chat', q} sends QUICK_CHAT[q]
//   cleanChat(text)    -> { text, masked }   ('' when nothing is left)
//   quickText(q)       -> QUICK_CHAT[q], or '' for anything that is not an index
//
// cleanChat, in order:
//   1. strips control characters and the invisible ones (zero-width, bidi overrides, word joiners,
//      BOM, soft hyphen, Hangul fillers, tag characters), tames "Zalgo" stacks of combining marks,
//      collapses whitespace, trims and caps at MAX_CHAT
//   2. personal info -> "[hidden]": e-mail addresses, links and domains (http…, www.…, name.com /
//      .net / .org / .io / .co / .uk / .gg / .tv / .ly …), phone-like digit runs (7+ digits, with
//      spaces, dashes, dots or brackets between), @handles of 3+ characters, name#1234 tags. Checked
//      on a lightly normalised copy (fullwidth "ｇｍａｉｌ．ｃｏｍ" is still a domain).
//   3. bad words -> one ★ per letter (separators in between are kept: "f.u.c.k" -> "★.★.★.★"),
//      matched on a normalised copy: lowercase, NFKC (fullwidth / math / circled letters), accents
//      dropped, look-alike Cyrillic / Greek letters, leetspeak (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s
//      !→i), any letter repeated ("fuuuck"). Whole words only, never raw substrings (the
//      Scunthorpe problem: "class", "assassin", "grass", "shiitake" and "scrap" stay clean):
//        - each word on its own, and a word with symbols inside it put back together ("f.u.c.k",
//          "sh*t", "f🙂uck"); leet symbols at a word's edge also count as punctuation ("shit!")
//        - letters spelled out with spaces: "f u c k", "k y s" (runs of 1-2 letter words with a
//          single letter among them; two 2-letter words only for the always-bad roots, so "an al"
//          stays clean but "sh it" doesn't), and a single letter split off a word ("s hit")
//        - a few phrases written as separate words ("kill yourself", "blow job")
//      The list (~130 roots) is a sensible kid-safe set of English swears, slurs and sexual words,
//      stored base64 encoded so this file is not a wall of swears. Each root has a mode:
//        (none) the word itself, plus a plural s (es after s, sh, ch, x, z)
//        ~      plus common endings: s es ed er ers ing in y z
//        !      the word itself only
//        ^      any word that starts with it ("slutty", "pissed")
//        *      anywhere in a word ("bullshit", "motherfucker"): only roots no clean word holds
//        +      also when written as separate words
//      ALLOW holds the clean words a ^ or * root would catch ("shiitake", "mishit").
//   4. caps at MAX_CHAT again ("[hidden]" can be longer than what it hides)
// masked: true when step 2 or 3 changed anything.
//
// This is a filter for a kids' game chat, not a guarantee: the room also rate-limits, the admin can
// read chats and mute, and players can hide and report anyone (see js/chat and js/admin).

export const MAX_CHAT = 120;
export const QUICK_CHAT = Object.freeze(['Let\'s go!', 'GG!', 'Ready?', 'Nice shot!', 'Help me!', 'One more game?', 'Follow me!', 'Thanks!', '👍', '😂']);

/** The quick chat line for index q, or ''. */
export function quickText(q) {
  return typeof q === 'number' && Number.isInteger(q) && q >= 0 && q < QUICK_CHAT.length ? QUICK_CHAT[q] : '';
}

// ------------------------------------------------------------------ the word list
const WORDS_B64 =
  'ZnVjayogZnZjayogcGh1Y2sqIGZ1a34gZnVxfiBmY2teIGZjdWteIHNoaXQqIHNodCEgc2h5dH4gYml0Y2gqIGJpYXRjaCogYnRjaH4gY3VudF4gYXNzIGFzc2heIGFzc2hvbF4g' +
  'YXNzd2lwZV4gYXNzaGF0XiBhc3NjbG93bl4gZHVtYmFzc14gamFja2Fzc14gZmF0YXNzIGJhZGFzcyBzbWFydGFzcyBraXNzYXNzIGxhcmRhc3MgYXJzZSBhcnNlaG9sXiBhcnNl' +
  'd2lwZV4gZGljayBkaWNraGVhZF4gZGlja2ZhY2VeIGRpY2t3YWReIGRjayEgY29jayBjb2Nrc3Vja14gY29ja2hlYWQgcGVuaXMgdmFnaW5hIHB1c3N5IHB1c3NpZXMgdGl0cyB0' +
  'aXR0eSB0aXR0aWVzIGJvb2IgYm9vYmllcyBjdW0hIGN1bW1pbmchIGppenp+IGRpbGRvXiBwb3JuXiBzZXh+IHNleHRpbmcgaG9ybnkgbnVkZSBtaWxmIGhlbnRhaSBib25lciBv' +
  'cmdhc21eIGJsb3dqb2JeKyBoYW5kam9iXisgcmltam9iXisgYW5hbCEgYW51cyByYXBlIHJhcGVkIHJhcGluZyByYXBpc3Qgd2hvcmVeIHNsdXReIHNrYW5rXiB0aG90IHNsYWcg' +
  'd2Fua14gdG9zc2VyIGJlbGxlbmReIGtub2JoZWFkXiBtaW5nZSBib2xsb2NrXiBidWdnZXJ+IHBpc3NeIGJhc3RhcmReIHByaWNrIGRhbW5+IGdvZGRhbW5eIGRhbW1pdCBkYW1u' +
  'aXQgY3JhcH4gZG91Y2hlXiB3dGYhIHN0ZnUhIGd0Zm8hIG9tZmchIGxtZmFvISByZXRhcmR+IHNwYXp+IHNwYXp6fiBzcGFzdGljIG5pZ2dlcl4gbmlnZ2FeIG5pZ2d1aF4gZmFn' +
  'IGZhZ2dvdF4gZmFnb3ReIGZhZ2dpdF4gZHlrZSB0cmFubnkgdHJhbm5pZXMgaG9tbyBsZXNibyBjaGluayBnb29rIHNwaWMga2lrZSB3ZXRiYWNrIGNvb24gcGFraSBiZWFuZXIg' +
  'cmFnaGVhZCB0b3dlbGhlYWQga3lzISBraWxseW91cnNlbGYrIGtpbGx1cnNlbGYrIGtpbGx5b3NlbGYrIHBlZG8gcGVkb3BoaWxlXiBwYWVkb14=';

// clean words that start with (or hold) a ^ / * root
const ALLOW = ['shiitake', 'shitake', 'shitzu', 'mishit', 'matsushita', 'pissarro', 'wankel'];
const ENDINGS = ['s', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y', 'z'];

function decode(b64) {
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('latin1'); // (very old Node)
}

/** Run-length form of a word: 'fuuck' -> { s: 'fuck', n: [1, 2, 1, 1] }. */
function rle(w) {
  let s = '';
  const n = [];
  for (const ch of w) {
    if (s && s[s.length - 1] === ch) n[n.length - 1]++;
    else { s += ch; n.push(1); }
  }
  return { s, n };
}

/**
 * A matcher over roots: a word matches a root when it has the root's letters in order, each run of a
 * letter at least as long as the root's ("fuuuck" is "fuck", but "as" is not "ass"). Indexed by the
 * collapsed letters, so a word costs a few Map lookups.
 */
function makeMatcher() {
  return { exact: new Map(), prefix: new Map(), contain: new Map(), lens: new Set() };
}

function addForm(map, form) {
  const r = rle(form);
  if (!map.has(r.s)) map.set(r.s, []);
  map.get(r.s).push(r.n);
}

function addRoot(M, root, mode) {
  if (mode === '*') { addForm(M.contain, root); M.lens.add(rle(root).s.length); return; }
  if (mode === '^') { addForm(M.prefix, root); return; }
  addForm(M.exact, root);
  if (mode === '!') return;
  if (mode === '~') { for (const e of ENDINGS) if (e !== 'es' || /(s|sh|ch|x|z)$/.test(root)) addForm(M.exact, root + e); return; }
  addForm(M.exact, root + 's');
  if (/(s|sh|ch|x|z)$/.test(root)) addForm(M.exact, root + 'es');
}

const MAIN = makeMatcher();   // every root
const STRONG = makeMatcher(); // the always-bad (*) roots: safe to look for across two short words
const PHRASE = makeMatcher(); // + roots: checked across 2-3 words
for (const entry of decode(WORDS_B64).split(' ')) {
  const m = /^([a-z]+)([*^~!]?)(\+?)$/.exec(entry);
  if (!m) continue;
  addRoot(MAIN, m[1], m[2]);
  if (m[2] === '*') addRoot(STRONG, m[1], '^');
  if (m[3]) addRoot(PHRASE, m[1], m[2]);
}

const runsOk = (have, need, at) => {
  for (let i = 0; i < need.length; i++) if (have[at + i] < need[i]) return false;
  return true;
};

/** Does word w (normalised letters) match a root? whole: contain roots must start the word too. */
function matchWord(M, w, whole = false) {
  if (!w) return false;
  for (const a of ALLOW) if (w.startsWith(a)) return false;
  const r = rle(w);
  const ex = M.exact.get(r.s);
  if (ex && ex.some((need) => runsOk(r.n, need, 0))) return true;
  for (let k = 1; k <= r.s.length; k++) {
    const pre = M.prefix.get(r.s.slice(0, k));
    if (pre && pre.some((need) => runsOk(r.n, need, 0))) return true;
    if (whole) {
      const c = M.contain.get(r.s.slice(0, k));
      if (c && c.some((need) => runsOk(r.n, need, 0))) return true;
    }
  }
  if (!whole) {
    for (let i = 0; i < r.s.length; i++) {
      for (const L of M.lens) {
        if (i + L > r.s.length) continue;
        const c = M.contain.get(r.s.slice(i, i + L));
        if (c && c.some((need) => runsOk(r.n, need, i))) return true;
      }
    }
  }
  return false;
}

// ------------------------------------------------------------------ normalising
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
// Cyrillic and Greek letters that look like Latin ones (а е о р с у х і ѕ ј к м т н в / α ε ι κ ν ο ρ τ υ χ)
const HOMO = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', ԁ: 'd', ӏ: 'l',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
};
const MARK_RE = /\p{M}/gu;
const LETTER_RE = /\p{L}/u;
const normCache = new Map();

/** One character's matching form: lowercase, NFKC, no accents (may be '' or several letters). */
function norm(ch) {
  let n = normCache.get(ch);
  if (n !== undefined) return n;
  n = ch.normalize('NFKC').normalize('NFD').replace(MARK_RE, '').toLowerCase();
  if (normCache.size > 4000) normCache.clear();
  normCache.set(ch, n);
  return n;
}

// ------------------------------------------------------------------ step 1: the visible text
const RAW_MAX = MAX_CHAT * 8; // work on at most this much of what was sent
const SPACEY = /[\t\n\v\f\r\u0085]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ZALGO = /(\p{M}{3})\p{M}+/gu;

function trimEnd(cps) {
  let n = cps.length;
  while (n && /\s/.test(cps[n - 1])) n--;
  return n === cps.length ? cps : cps.slice(0, n);
}
const capped = (cps) => (cps.length > MAX_CHAT ? trimEnd(cps.slice(0, MAX_CHAT)) : cps);

// ------------------------------------------------------------------ step 2: personal info
const TLDS = 'com|net|org|io|co|uk|gg|tv|ly|app|dev|xyz|info|biz|us|ca|de|fr|ru|au|eu|nz|ie|link|site|online|live|club|store|shop|tk|ml|cc|ai|ws|edu|gov';
const PII = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g,               // e-mail
  /(?:https?:\/\/|www\.)\S+/g,                                             // links
  new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:[/?#]\\S*)?`, 'g'), // domains
  /\b[a-z0-9-]+\.me\/\S*/g,                                                // t.me/…
  /@[\p{L}\p{N}_.]{3,}/gu,                                                 // @handles
  /[\p{L}\p{N}_.]{2,}#\d{4}\b/gu,                                          // name#1234
  /\+?\(?\d(?:[\s().-]{0,3}\d){6,}\)?/g,                                   // phone-like: 7+ digits
];

/** One UTF-16 unit per code point: NFKC when it gives one BMP character, else a placeholder. */
function liteCopy(cps) {
  let s = '';
  for (const ch of cps) {
    const n = ch.normalize('NFKC').toLowerCase();
    s += n.length === 1 ? n : '\ufffc';
  }
  return s;
}

function hidePersonal(cps) {
  const s = liteCopy(cps);
  const spans = [];
  for (const re of PII) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(s));) {
      if (!m[0].length) { re.lastIndex++; continue; }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  if (!spans.length) return { cps, masked: false };
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (let i = 0; i < spans.length; i++) {
    let [a, b] = spans[i];
    while (i + 1 < spans.length && spans[i + 1][0] <= b) b = Math.max(b, spans[++i][1]);
    if (a < at) a = at;
    for (let k = at; k < a; k++) out.push(cps[k]);
    out.push(...'[hidden]');
    at = b;
  }
  for (let k = at; k < cps.length; k++) out.push(cps[k]);
  return { cps: out, masked: true };
}

// ------------------------------------------------------------------ step 3: bad words
// a unit: one normalised character { c, i (code point index), k: 'L' letter | 'T' leet letter | 'S' symbol,
// d: a digit read as a letter }
function chunksOf(cps) {
  const chunks = [];
  let cur = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (/\s/.test(ch)) { if (cur.length) chunks.push(cur); cur = []; continue; }
    const n = norm(ch);
    for (const x0 of n) {
      const x = HOMO[x0] || x0;
      if (x >= 'a' && x <= 'z') cur.push({ c: x, i, k: 'L' });
      else if (LEET[x]) cur.push({ c: LEET[x], i, k: 'T', d: x >= '0' && x <= '9' });
      else if (LETTER_RE.test(x)) cur.push({ c: x, i, k: 'L' });
      else if (/\s/.test(x)) { if (cur.length) chunks.push(cur); cur = []; }
      else cur.push({ c: x, i, k: 'S' });
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const letters = (units) => units.filter((u) => u.k !== 'S');
const word = (units) => units.map((u) => u.c).join('');

/** The letters of a piece of a chunk that match, as units to mask (null when clean). */
function badUnits(M, units, whole = false) {
  const ls = letters(units);
  // a number is a number ("455 wood"), not leetspeak
  if (!ls.length || ls.every((u) => u.d)) return null;
  // leet symbols at the edges may just be punctuation ("shit!", "ass1"), or letters ("a55")
  let a = 0, b = ls.length;
  while (a < b && ls[a].k === 'T') a++;
  while (b > a && ls[b - 1].k === 'T') b--;
  const inner = ls.slice(a, b);
  if (inner.length && inner.length < ls.length && matchWord(M, word(inner), whole)) return inner;
  return matchWord(M, word(ls), whole) ? ls : null;
}

function maskWords(cps) {
  const chunks = chunksOf(cps);
  const mask = new Set();
  const hit = (units) => { if (units) for (const u of units) mask.add(u.i); return !!units; };
  for (const ch of chunks) {
    // the pieces between symbols, then the whole chunk put back together ("f.u.c.k", "sh*t")
    let piece = [], pieces = 0;
    for (const u of [...ch, { k: 'S' }]) {
      if (u.k === 'S') { if (piece.length) { pieces++; hit(badUnits(MAIN, piece)); } piece = []; } else piece.push(u);
    }
    if (pieces > 1) hit(badUnits(MAIN, ch));
  }
  // letters spelled out with spaces: runs of words of 1-2 letters
  const size = chunks.map((ch) => letters(ch).length);
  for (let a = 0; a < chunks.length; a++) {
    if (size[a] < 1 || size[a] > 2) continue;
    let end = a;
    while (end + 1 < chunks.length && size[end + 1] >= 1 && size[end + 1] <= 2) end++;
    if (end === a) continue;
    // the longest match from a on, then carry on after it
    for (let b = end; b > a; b--) {
      const run = chunks.slice(a, b + 1);
      const single = size.slice(a, b + 1).includes(1);
      const M = single || b - a >= 2 ? MAIN : STRONG;
      if (hit(badUnits(M, run.flat(), true))) { a = b; break; }
    }
  }
  // a single letter split off a word ("s hit", "b itch")
  for (let a = 0; a < chunks.length; a++) {
    if (size[a] !== 1) continue;
    for (const [x, y] of [[a, a + 1], [a - 1, a]]) {
      if (x < 0 || y >= chunks.length || !size[x] || !size[y]) continue;
      if (hit(badUnits(MAIN, chunks[x].concat(chunks[y]), true))) break;
    }
  }
  // phrases written as separate words ("kill yourself")
  for (let a = 0; a + 1 < chunks.length; a++) {
    for (let b = Math.min(chunks.length - 1, a + 2); b > a; b--) {
      if (hit(badUnits(PHRASE, chunks.slice(a, b + 1).flat(), true))) break;
    }
  }
  if (!mask.size) return { cps, masked: false };
  return { cps: cps.map((c, i) => (mask.has(i) ? '★' : c)), masked: true };
}

// ------------------------------------------------------------------ cleanChat
/** A chat line as the room passes it on (and pages show it): { text, masked }. */
export function cleanChat(input) {
  let s = typeof input === 'string' ? input : typeof input === 'number' && Number.isFinite(input) ? String(input) : '';
  if (s.length > RAW_MAX) s = s.slice(0, RAW_MAX);
  s = s.replace(LONE, '').replace(SPACEY, ' ').replace(CONTROL, '').replace(INVISIBLE, '').replace(ZALGO, '$1').replace(/\s+/g, ' ').trim();
  if (!s) return { text: '', masked: false };
  let cps = capped(Array.from(s));
  let masked = false;
  // A mask can make a new match next to it ("[hidden]" and ★ end a word, so "x.io" right before a
  // hidden link becomes a domain), and "[hidden]" can be longer than what it hides (cap, look
  // again): passes until nothing changes, so cleaning the result again finds nothing to do.
  for (let pass = 0; pass < 12; pass++) {
    const p = hidePersonal(cps);
    const w = maskWords(p.cps);
    const cut = capped(w.cps);
    masked = masked || p.masked || w.masked;
    const changed = p.masked || w.masked || cut.length !== w.cps.length;
    cps = cut;
    if (!changed) break;
  }
  const text = cps.join('').trim();
  return { text, masked };
}
