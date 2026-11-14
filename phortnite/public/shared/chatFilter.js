// Party chat text (stage 3): what one chat line may hold. DOM-free, used by the room plugin
// (shared/plugins/chat.js: the room cleans every line it passes on) and by every page that shows a
// line (js/chat: it cleans again on display, so a modded host can't push unfiltered text).
// Idempotent: cleanChat(cleanChat(s).text) gives the same text back (masked false).
//
//   MAX_CHAT           characters (code points) in one line
//   QUICK_CHAT         the quick chat lines; {t:'chat', q} sends QUICK_CHAT[q]
//   cleanChat(text)    -> { text, masked }   ('' when nothing is left)
//   quickText(q)       -> QUICK_CHAT[q], or '' for anything that is not an index
//   adminLike(name)    -> does a name pass itself off as the admin ("Admin", "Adm1n", "mod"…)?
//   playerName(name)   -> a player's name as shown (no 🛡, ≤ 16), '' when adminLike: the room
//                         and every page show 'Player' instead (see "the admin's look" below)
//
// cleanChat, in order:
//   1. strips control characters and the invisible ones (zero-width, bidi overrides, word joiners,
//      BOM, soft hyphen, Hangul fillers, tag characters), tames "Zalgo" stacks of combining marks,
//      collapses whitespace, trims and caps at MAX_CHAT
//   2. personal info -> "[hidden]":
//        - e-mail addresses, also spelled out ("jake at gmail dot com", "jake(at)gmail(dot)com",
//          "jake @ gmail . com", "jake at gmail")
//        - links and domains (http…, www.…, name.com / .net / .org / .io / .co / .uk / .gg / .tv /
//          .ly / .me …, any name.xx/path like goo.gl/abc, "youtube . com", "discord dot gg")
//        - phone-like digit runs: 7+ digits in any script (keycaps too), with up to 3 non-letters
//          between them (spaces, dashes, dots, commas, slashes, brackets, emoji…)
//        - @handles of 3+ characters ("@ jake2014" too), name#1234 tags ("jake # 1234" too)
//        - a username after a messaging / gaming app's name: "snap: jake", "my insta is jake.2014",
//          "add me on discord jake_99" (the app's name stays; after a bare name, only something that
//          looks like a username, a letter plus a digit or _, so "xbox 360" and "roblox is fun" stay)
//      Checked on a lightly normalised copy (fullwidth "ｇｍａｉｌ．ｃｏｍ", "fancy text" letters and the
//      ideographic full stop "。" still make a domain).
//   3. bad words -> one ★ per letter (separators in between are kept: "f.u.c.k" -> "★.★.★.★"),
//      matched on a normalised copy: lowercase, NFKC (fullwidth / math / circled letters), the
//      "fancy text" letters NFKC leaves alone (small capitals ᴀ ʙ ᴄ, negative circled and squared
//      letters, regional indicators), accents dropped, look-alike Cyrillic / Greek / Armenian
//      letters, leetspeak (0→o 1→i or l 3→e 4→a 5→s 6→g 7→t 8→b 9→g @→a $→s !→i |→i or l €→e, and
//      +→t inside a word only: "sushi+" is clean),
//      any letter repeated ("fuuuck"). Whole words only, never raw substrings (the Scunthorpe
//      problem: "class", "assassin", "grass", "shiitake" and "scrap" stay clean):
//        - each word on its own, and a word with symbols inside it put back together ("f.u.c.k",
//          "sh*t", "f🙂uck"); leet symbols at a word's edge also count as punctuation ("shit!"). When
//          a piece of it is a real word (3+ letters), a root must start at a piece ("yes...hit" and
//          "smash-it" stay clean, "what.the.f.u.c.k" doesn't)
//        - a '*' or '#' standing in for one or two letters inside a word ("n*gger", "f**k"; the
//          stars stay: "★*★★★★")
//        - letters spelled out with spaces: "f u c k", "k y s" (runs of 1-2 letter words with a
//          single letter among them; two 2-letter words only for the always-bad roots, so "an al"
//          stays clean but "sh it" doesn't; a word ending in a digit like "m8" is not a letter), and
//          a single letter split off a word ("s hit"; not the s of "it s", "he s")
//        - a few phrases written as separate words ("kill yourself", "blow job", "go die")
//      The list (~170 roots) is a sensible kid-safe set of English swears, slurs, sexual words and
//      self-harm taunts, stored base64 encoded so this file is not a wall of swears. ("kill myself"
//      is NOT masked: the admin must be able to read a child's line like that.) Each root has a mode:
//        (none) the word itself, plus a plural s (es after s, sh, ch, x, z)
//        ~      plus common endings: s es ed er ers ing in y z
//        !      the word itself only
//        ^      any word that starts with it ("slutty", "pissed")
//        *      anywhere in a word ("bullshit", "motherfucker"): only roots no clean word holds
//        +      also when written as separate words
//        ++     only when written as separate words ("go die": "goodie" stays clean)
//      ALLOW holds the clean words a root would catch ("shiitake", "mishit", "rapping", "assess").
//   4. caps at MAX_CHAT again ("[hidden]" can be longer than what it hides)
// masked: true when step 2 or 3 changed anything.
//
// Cost: a few hundredths of a millisecond for an ordinary line, a few milliseconds at worst for a
// crafted one (lots of 1-2 letter words). The room checks its rate limits before it cleans a line
// (plugins/chat.js), so a flood of crafted lines is never cleaned.
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
  'aXQgY3JhcH4gZG91Y2hlXiB3dGYhIHN0ZnUhIGd0Zm8hIG9tZmchIGxtZmFvISByZXRhcmR+IHNwYXp+IHNwYXp6fiBzcGFzdGljIG5pZ2dlcl4rIG5pZ2dhXisgbmlnZ3VoXiBm' +
  'YWcgZmFnZ290XiBmYWdvdF4gZmFnZ2l0XiBkeWtlIHRyYW5ueSB0cmFubmllcyBob21vIGxlc2JvIGNoaW5rIGdvb2sgc3BpYyBraWtlIHdldGJhY2sgY29vbiBwYWtpIGJlYW5l' +
  'ciByYWdoZWFkIHRvd2VsaGVhZCBreXMhIGtpbGx5b3Vyc2VsZisga2lsbHVyc2VsZisga2lsbHlvc2VsZisgcGVkbyBwZWRvcGhpbGVeIHBhZWRvXiB0d2F0IGhvZSB0YXJkIHJl' +
  'dGFydF4gbmlxcV4gbmliYmFeIGt1bnQgY3ZudF4gZmtuISBma2luISBma2luZyEgcGh1a34gcGhhZyBiaW90Y2heIGJleW90Y2heIHNoaWV0fiBhenohIGJ1dHRob2xlXiBjdW1z' +
  'aG90fiBjdW1zbHV0fiBuYWtlZCBzZWNrc34gc2VnZ3N+IG1hc3R1cmJhdF4gZmFwfiBjbGl0fiBjbGl0b3JpcyBvbmx5ZmFucyBuYXppfiBtb2xlc3ReIG5vbmNlIHNoYWcgc2hh' +
  'Z2dlZCEgc2hhZ2dpbmchIGhlaWxoaXRsZXIrIGdvZGllKysgaGFuZ3lvdXJzZWxmKyBoYW5ndXJzZWxmKyBuZWNreW91cnNlbGYrIG5lY2t1cnNlbGYrIHVuYWxpdmV5b3Vyc2Vs' +
  'ZisgdW5hbGl2ZXVyc2VsZisgZHJpbmtibGVhY2gr';

// clean words that start with (or hold) a root: a ^ / * root ("shiitake", "mishit"), or a doubled
// letter that reads as a root's single one ("rapping", "assess", "Shiite")
const ALLOW = ['shiitake', 'shitake', 'shitzu', 'mishit', 'matsushita', 'pissarro', 'wankel', 'rapp', 'assess', 'shiite'];
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
 * collapsed letters, so a word costs a few Map lookups. keys: every key; starts: every start of every
 * key (a word matched from its start whose first two letters start no key is turned away at once;
 * mayMatch); stems: every start of a prefix / contain key (a word's start is looked up only as far
 * as some such key goes on like it).
 */
function makeMatcher() {
  return { exact: new Map(), prefix: new Map(), contain: new Map(), lens: new Set(), stems: new Set(), keys: new Set(), starts: new Set() };
}

function addForm(M, map, form) {
  const r = rle(form);
  if (!map.has(r.s)) map.set(r.s, []);
  map.get(r.s).push(r.n);
  M.keys.add(r.s);
  for (let k = 1; k <= r.s.length; k++) {
    M.starts.add(r.s.slice(0, k));
    if (map !== M.exact) M.stems.add(r.s.slice(0, k));
  }
}

function addRoot(M, root, mode) {
  if (mode === '*') { addForm(M, M.contain, root); M.lens.add(rle(root).s.length); return; }
  if (mode === '^') { addForm(M, M.prefix, root); return; }
  addForm(M, M.exact, root);
  if (mode === '!') return;
  if (mode === '~') { for (const e of ENDINGS) if (e !== 'es' || /(s|sh|ch|x|z)$/.test(root)) addForm(M, M.exact, root + e); return; }
  addForm(M, M.exact, root + 's');
  if (/(s|sh|ch|x|z)$/.test(root)) addForm(M, M.exact, root + 'es');
}

const MAIN = makeMatcher();   // every root
const STRONG = makeMatcher(); // the always-bad (*) roots: safe to look for across two short words
const PHRASE = makeMatcher(); // + roots: checked across 2-3 words
for (const entry of decode(WORDS_B64).split(' ')) {
  const m = /^([a-z]+)([*^~!]?)(\+{0,2})$/.exec(entry);
  if (!m) continue;
  if (m[3] !== '++') addRoot(MAIN, m[1], m[2]);
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
  const r = rle(w);
  if (whole && !M.starts.has(r.s.slice(0, 2))) return false;
  for (const a of ALLOW) if (w.startsWith(a)) return false;
  const ex = M.exact.get(r.s);
  if (ex && ex.some((need) => runsOk(r.n, need, 0))) return true;
  for (let k = 1; k <= r.s.length; k++) {
    const start = r.s.slice(0, k);
    if (!M.stems.has(start)) break; // no prefix / contain key goes on like this
    const pre = M.prefix.get(start);
    if (pre && pre.some((need) => runsOk(r.n, need, 0))) return true;
    if (whole) {
      const c = M.contain.get(start);
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
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '€': 'e' };
const LEET2 = { 1: 'l', '|': 'l' }; // a second reading, tried when the first finds nothing ("s1ut")
// Cyrillic, Greek and Armenian letters that look like Latin ones (а е о р с у х і ѕ ј к м т н в п и /
// α ε ι κ ν ο ρ τ υ χ η / ս օ ց)
const HOMO = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', ԁ: 'd', ӏ: 'l',
  п: 'n', и: 'n', α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', η: 'n', ս: 'u', օ: 'o', ց: 'g',
};
// "fancy text" letters that NFKC leaves alone: small capitals and IPA letters, then the negative
// circled (U+1F150) and negative squared (U+1F170) letters and the regional indicators (U+1F1E6),
// A to Z each
const FOLD = {};
for (const p of ['ᴀa', 'ʙb', 'ᴄc', 'ᴅd', 'ᴇe', 'ꜰf', 'ɢg', 'ʜh', 'ɪi', 'ᴊj', 'ᴋk', 'ʟl', 'ᴍm', 'ɴn', 'ᴏo', 'ᴘp', 'ǫq', 'ʀr', 'ꜱs', 'ᴛt', 'ᴜu', 'ᴠv', 'ᴡw', 'ʏy', 'ᴢz', 'ɑa', 'ɡg', 'ıi', 'ȷj', 'ƒf']) FOLD[p[0]] = p[1];
for (const base of [0x1f150, 0x1f170, 0x1f1e6]) for (let i = 0; i < 26; i++) FOLD[String.fromCodePoint(base + i)] = String.fromCharCode(97 + i);
const MARK_RE = /\p{M}/gu;
const LETTER_RE = /\p{L}/u;
const normCache = new Map();

/** One character's matching form: lowercase, NFKC, fancy letters folded, no accents (may be '' or several letters). */
function norm(ch) {
  let n = normCache.get(ch);
  if (n !== undefined) return n;
  n = FOLD[ch] || ch.normalize('NFKC').normalize('NFD').replace(MARK_RE, '').toLowerCase();
  n = Array.from(n, (x) => FOLD[x] || x).join('');
  if (normCache.size > 4000) normCache.clear();
  normCache.set(ch, n);
  return n;
}

// ------------------------------------------------------------------ step 1: the visible text
const RAW_MAX = MAX_CHAT * 8; // work on at most this much of what was sent
const SPACEY = /[\t\n\v\f\r\u0085]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[­͏ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁩ㅤ﻿ﾠ\u{e0000}-\u{e007f}]/gu;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ZALGO = /(\p{M}{3})\p{M}+/gu;

function trimEnd(cps) {
  let n = cps.length;
  while (n && /\s/.test(cps[n - 1])) n--;
  return n === cps.length ? cps : cps.slice(0, n);
}
const capped = (cps) => (cps.length > MAX_CHAT ? trimEnd(cps.slice(0, MAX_CHAT)) : cps);

// ------------------------------------------------------------------ step 2: personal info
const TLDS = 'com|net|org|io|co|uk|gg|tv|ly|app|dev|xyz|info|biz|us|ca|de|fr|ru|au|eu|nz|ie|link|site|online|live|club|store|shop|tk|ml|cc|ai|ws|edu|gov|me|gl|gd|cn|pw|nl|es|pl|jp|fm|xxx|games';
// spelled-out e-mail and domain separators: "jake at gmail dot com", "(at)", "[dot]", "jake @ gmail . com"
const AT = String.raw`(?:\s*(?:@|[(\[{]\s*at\s*[)\]}])\s*|\s+at\s+)`;
const DOT = String.raw`(?:\.|\s+\.\s+|\s*[(\[{]\s*dot\s*[)\]}]\s*|\s+dot\s+)`;
const SDOT = String.raw`(?:\s*[(\[{]\s*dot\s*[)\]}]\s*|\s+dot\s+)`; // only the spelled kinds
const MAILS = 'gmail|googlemail|hotmail|outlook|yahoo|ymail|icloud|aol|protonmail|proton|btinternet|msn';
const PATH = String.raw`(?:(?:\s*\/\s*|\s+slash\s+)[\p{L}\p{N}_.\-]+)?`; // "youtube dot com slash jake"
// where kids swap usernames: after "snap:" anything, after a bare "snap" only a username-looking word
const APPS = String.raw`snap(?:chat)?|insta(?:gram)?|tik\s?tok|discord|roblox|xbox|psn|twitch|youtube|whats\s?app|kik|telegram|steam|gamertag|username|g?mail|e-?mail`;
const SHORT = 'sc|ig|tt|yt|dc|gt|user|id';
const TOK = String.raw`[\p{L}\p{N}_.]`;
const HANDLE = String.raw`(?=${TOK}*\p{L})(?=${TOK}*[\p{N}_])${TOK}{4,}`; // a letter and a digit or _
// (a rule with a group hides only the group, which always ends the match: "snap: [hidden]")
const PII = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g,                                          // e-mail
  new RegExp(String.raw`[a-z0-9._%+-]+${AT}(?:[a-z0-9-]+${DOT})*[a-z0-9-]+${DOT}(?:${TLDS})\b`, 'g'),   // spelled-out e-mail
  new RegExp(String.raw`[a-z0-9._%+-]{2,}${AT}(?:${MAILS})\b`, 'g'),                                   // jake at gmail
  /(?:https?:\/\/|www\.)\S+/g,                                                                        // links
  new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:[/?#]\\S*)?`, 'g'),                    // domains
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}\/\S*/g,                                                  // any name.xx/… (t.me/, goo.gl/)
  new RegExp(String.raw`\b[a-z0-9-]+(?:\s+\.\s+[a-z0-9-]+)*\s+\.\s+(?:com|net|org)\b${PATH}`, 'gu'),     // youtube . com
  new RegExp(String.raw`\b[a-z0-9-]+(?:${SDOT}[a-z0-9-]+)*${SDOT}(?:com|net|org|gg|io|tv|co|uk|me|ly)\b${PATH}`, 'gu'), // discord dot gg
  /[a-z0-9._%+-]*@[\p{L}\p{N}_.]{3,}/gu,                                                              // @handles (and jake@roblox)
  new RegExp(String.raw`@\s+${HANDLE}`, 'gu'),                                                        // @ jake2014
  new RegExp(String.raw`\b(?:${APPS}|${SHORT})\s*[:=]\s*@?(${TOK}{3,})`, 'gu'),                         // snap: jake
  new RegExp(String.raw`\b(?:${APPS})\s+(?:(?:is|name\s+is|tag\s+is|id\s+is)\s+)?@?(${HANDLE})`, 'gu'), // my insta is jake.2014
  new RegExp(String.raw`\badd\s+me\s+on\s+(?:${APPS}|${SHORT})\s+@?(${TOK}{3,})`, 'gu'),                // add me on snap jake
  /[\p{L}\p{N}_.]{2,}\s*#\s*\d{4}\b/gu,                                                               // name#1234, name # 1234
];
// (phone numbers: phoneSpans. As one regex, "7+ digits with up to 3 non-letters between" costs V8
// over 100 ms to compile for text beyond Latin-1: it unrolls the big Unicode class 18 times.)
const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;
const MARK = /\p{M}/u;

/** Phone-like runs in s: 7+ digits (any script, keycaps too), with at most 3 non-letters between any two. */
function phoneSpans(s, spans) {
  const n = s.length;
  for (let i = 0; i < n;) {
    if (!DIGIT.test(s[i])) { i++; continue; }
    let digits = 1, end = i + 1;
    for (;;) {
      let k = end, gap = 0;
      while (k < n && gap <= 3 && !ALNUM.test(s[k])) { k++; gap++; }
      if (k >= n || gap > 3 || !DIGIT.test(s[k])) break;
      digits++;
      end = k + 1;
    }
    if (digits >= 7) {
      let a = i, b = end;
      if (a > 0 && s[a - 1] === '(') a--; // "+(44) …"
      if (a > 0 && s[a - 1] === '+') a--;
      while (b < n && MARK.test(s[b])) b++; // the last keycap's marks
      if (s[b] === ')') b++;
      spans.push([a, b]);
    }
    i = end;
  }
}

/** One UTF-16 unit per code point: NFKC (fancy letters folded) when it gives one BMP character, else a placeholder. */
function liteCopy(cps) {
  let s = '';
  for (const ch of cps) {
    const n = FOLD[ch] || ch.normalize('NFKC').toLowerCase();
    s += n === '。' ? '.' : n.length === 1 ? n : '￼'; // 。 (and ｡) is a full stop
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
      const end = m.index + m[0].length;
      spans.push([m[1] !== undefined ? end - m[1].length : m.index, end]);
    }
  }
  phoneSpans(s, spans);
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
// d: a digit read as a letter, c2: its second reading (LEET2), e: a letter only inside a word ('+') }
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
      else if (LEET[x]) cur.push({ c: LEET[x], i, k: 'T', d: x >= '0' && x <= '9', c2: LEET2[x], e: x === '+' });
      else if (LETTER_RE.test(x)) cur.push({ c: x, i, k: 'L' });
      else if (/\s/.test(x)) { if (cur.length) chunks.push(cur); cur = []; }
      else cur.push({ c: x, i, k: 'S' });
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const letters = (units) => units.filter((u) => u.k !== 'S');
const word = (units, two) => units.map((u) => (two && u.c2) || u.c).join('');

/** The letters of a piece of a chunk that match, as units to mask (null when clean). */
const badUnits = (M, units, whole = false) => badLetters(M, letters(units), whole);

/** badUnits on the letters alone (symbols already left out). */
function badLetters(M, ls, whole) {
  // '+' is a letter only inside a word ("bi+ch"); at an edge it is punctuation ("sushi+", "+water")
  if (ls.length && (ls[0].e || ls[ls.length - 1].e)) {
    let a = 0, b = ls.length;
    while (a < b && ls[a].e) a++;
    while (b > a && ls[b - 1].e) b--;
    ls = ls.slice(a, b);
  }
  // a number is a number ("455 wood"), not leetspeak
  if (!ls.length || ls.every((u) => u.d)) return null;
  // leet symbols at the edges may just be punctuation ("shit!", "ass1"), or letters ("a55")
  let a = 0, b = ls.length;
  while (a < b && ls[a].k === 'T') a++;
  while (b > a && ls[b - 1].k === 'T') b--;
  const inner = ls.slice(a, b);
  // the first reading of every leet symbol, then the second ("s1ut": 1 as l), never a mix
  for (const two of ls.some((u) => u.c2) ? [false, true] : [false]) {
    if (inner.length && inner.length < ls.length && matchWord(M, word(inner, two), whole)) return inner;
    if (matchWord(M, word(ls, two), whole)) return ls;
  }
  return null;
}

// '*' / '#' standing in for letters: at most STAR_WORDS such words a line (each costs up to 26²
// lookups), each with 1-2 of them, at least 2 letters and at most STAR_LEN characters
const STAR = new Set(['*', '#']);
const STAR_WORDS = 4;
const STAR_LEN = 12;
const ABC = 'abcdefghijklmnopqrstuvwxyz';
let starWords = 0;

/**
 * A chunk with 1-2 '*' between its letters ("n*gger", "f**k"): its letters to mask when some letters
 * in place of the stars make a root, from the word's start (one star: anywhere too, "bull*hit").
 */
function starred(ch) {
  const us = ch.filter((u) => u.k !== 'S' || STAR.has(u.c));
  let a = 0, b = us.length;
  while (a < b && us[a].k !== 'L') a++; // stars and leet symbols at the edges are punctuation
  while (b > a && us[b - 1].k !== 'L') b--;
  const core = us.slice(a, b);
  const at = [];
  core.forEach((u, j) => { if (u.k === 'S') at.push(j); });
  if (!at.length || at.length > 2 || core.length - at.length < 2 || core.length > STAR_LEN || starWords <= 0) return null;
  starWords--;
  const cs = core.map((u) => u.c);
  // fill the stars one after another; from the start, the first two letters must start some root
  const fill = (s, whole) => {
    if (s === at.length) return matchWord(MAIN, cs.join(''), whole);
    for (const c of ABC) {
      cs[at[s]] = c;
      if (whole && at[s] === 1 && c !== cs[0] && !MAIN.starts.has(cs[0] + c)) continue;
      if (fill(s + 1, whole)) return true;
    }
    return false;
  };
  const fixedHead = at[0] > 1 && cs[0] !== cs[1];
  if ((!fixedHead || MAIN.starts.has(cs[0] + cs[1])) && fill(0, true)) return core.filter((u) => u.k !== 'S');
  if (at.length === 1 && fill(0, false)) return core.filter((u) => u.k !== 'S');
  return null;
}

/**
 * Could any word that starts where these letters start (these letters, cut short anywhere) match a
 * root from its start? Only if some key is a start of their collapsed letters, read from each place
 * badLetters may start a word (with or without leet symbols at the edge, either leet reading). A
 * run of spelled-out letters that can't is skipped whole: this keeps a line of 1-letter words cheap.
 */
function mayMatch(M, ls) {
  let t = 0, e = 0;
  while (t < ls.length && ls[t].k === 'T') t++;
  while (e < ls.length && ls[e].e) e++;
  for (const from of [0, e, t]) {
    for (const two of [false, true]) {
      let h = '';
      for (let i = from; i < ls.length; i++) {
        const c = (two && ls[i].c2) || ls[i].c;
        if (h[h.length - 1] === c) continue;
        h += c;
        if (M.keys.has(h)) return true;
        if (!M.starts.has(h)) break;
      }
    }
  }
  return false;
}

// letters spelled out with spaces: a run is looked at over at most SPELL_MAX letters from its start
// (the longest root is 15 letters; this keeps a crafted line of 1-letter words cheap)
const SPELL_MAX = 24;

function maskWords(cps) {
  starWords = STAR_WORDS;
  const chunks = chunksOf(cps);
  const mask = new Set();
  const hit = (units) => { if (units) for (const u of units) mask.add(u.i); return !!units; };
  for (const ch of chunks) {
    // the pieces between symbols, then the whole chunk put back together ("f.u.c.k", "sh*t")
    const starts = [];
    let piece = [], short = true;
    for (let j = 0; j <= ch.length; j++) {
      const u = ch[j];
      if (!u || u.k === 'S') {
        if (piece.length) { hit(badUnits(MAIN, piece)); if (piece.length > 2) short = false; }
        piece = [];
      } else {
        if (!piece.length) starts.push(j);
        piece.push(u);
      }
    }
    if (starts.length < 2) continue;
    // pieces of 1-2 letters: a root anywhere ("b.u.l.l.s.h.i.t"); a real word among them: a root
    // starts at a piece ("yes...hit", "smash-it" stay clean)
    let got = false;
    if (short) got = hit(badUnits(MAIN, ch));
    else for (const j of starts) if ((got = hit(badUnits(MAIN, ch.slice(j), true)))) break;
    if (!got) hit(starred(ch));
  }
  // letters spelled out with spaces: runs of words of 1-2 letters (a word ending in a digit, like
  // "m8" or "b4", is not a spelled-out letter)
  const size = chunks.map((ch) => letters(ch).length);
  const spell = chunks.map((ch, j) => {
    const ls = letters(ch);
    return ls.length && ls[ls.length - 1].d && ls.some((u) => !u.d) ? 0 : size[j];
  });
  for (let a = 0; a < chunks.length; a++) {
    if (spell[a] < 1 || spell[a] > 2) continue;
    let end = a, n = spell[a];
    while (end + 1 < chunks.length && spell[end + 1] >= 1 && spell[end + 1] <= 2 && n + spell[end + 1] <= SPELL_MAX) n += spell[++end];
    if (end === a) continue;
    const ls = letters(chunks.slice(a, end + 1).flat());
    if (!mayMatch(MAIN, ls)) continue; // (STRONG's roots are MAIN's too)
    // the longest match from a on, then carry on after it
    for (let b = end, cut = ls.length; b > a; cut -= size[b--]) {
      const single = spell.slice(a, b + 1).includes(1);
      const M = single || b - a >= 2 ? MAIN : STRONG;
      if (hit(badLetters(M, ls.slice(0, cut), true))) { a = b; break; }
    }
  }
  // a single letter split off a word ("s hit", "b itch"); not the s of "it s", "he s" (an 's)
  for (let a = 0; a < chunks.length; a++) {
    if (size[a] !== 1) continue;
    const its = letters(chunks[a])[0].c === 's' && a > 0 && size[a - 1] >= 2;
    for (const [x, y] of [[a, a + 1], [a - 1, a]]) {
      if (x < 0 || y >= chunks.length || !size[x] || !size[y] || (its && x === a)) continue;
      if (hit(badUnits(MAIN, chunks[x].concat(chunks[y]), true))) break;
    }
  }
  // phrases written as separate words ("kill yourself", "nig ga"): the shortest that matches, and
  // never from a word that is bad on its own (already masked: "n****r lol" keeps its "lol")
  for (let a = 0; a + 1 < chunks.length; a++) {
    if (badUnits(PHRASE, chunks[a], true)) continue;
    for (let b = a + 1; b <= Math.min(chunks.length - 1, a + 2); b++) {
      if (hit(badUnits(PHRASE, chunks.slice(a, b + 1).flat(), true))) { a = b; break; }
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

// ------------------------------------------------------------------ the admin's look (names)
// The admin's look is his alone: a player's name never shows the 🛡 and never reads "Admin" (or
// "Adm1n", "A d m i n", "Moderator", "mod"…). The room uses playerName for every name it takes
// (shared/room.js join, shared/plugins/party.js look: nameplates, the kill feed, party cards and
// chat lines all say 'Player' instead), and every page again for chat lines (js/chat/chatLog.js).
// Only an observer's line (the admin watching, signed: js/ui/chat.js) is named 'Admin' and gets the
// 🛡 ADMIN tag. ("Philip" is not reserved: Philip plays under his own name, and friends may be
// called that too.)
// A name is folded for the check: lowercase, NFKC (fullwidth, small caps…), no accents, look-alike
// Cyrillic / Greek letters, leetspeak; anything else splits words.
const NAME_LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '|': 'i' };
const NAME_HOMO = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', ԁ: 'd', ӏ: 'l',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
};
const RESERVED = /adm[il]n|moderat|staff/; // inside a word: "TheAdmin", "Adm1n" ("Badminton" too: fine)
const RESERVED_START = /^(?:adm[il]n|moderat|staff)/; // spelled across words from a word's start
const BADGE = /[\u{1F6E1}⛨]️?/gu; // 🛡 ⛨: the admin's tag

function nameWords(name) {
  const words = [];
  let cur = '';
  for (const ch of String(name ?? '').slice(0, 256)) {
    for (const x0 of ch.normalize('NFKC').normalize('NFD').replace(MARK_RE, '').toLowerCase()) {
      const x = NAME_HOMO[x0] || NAME_LEET[x0] || x0;
      if (x >= 'a' && x <= 'z') cur += x;
      else if (cur) { words.push(cur); cur = ''; }
    }
  }
  if (cur) words.push(cur);
  return words;
}

/**
 * Does this name pass itself off as the admin? "Admin", "🛡 ADMIN", "Adm1n", "Аdmin" (Cyrillic),
 * "A d m i n", "Ad min", "The Admin", "Moderator", "Staff", and "mod" / "mods" as a word. Not
 * "Chad Miner" (a match must start a word to run across a space), "Model", "Commodore", "Philip".
 */
export function adminLike(name) {
  const w = nameWords(name);
  for (let i = 0; i < w.length; i++) {
    if (w[i] === 'mod' || w[i] === 'mods' || RESERVED.test(w[i])) return true;
    if (i + 1 < w.length && RESERVED_START.test(w.slice(i).join(''))) return true;
  }
  return false;
}

/** A player's name as shown: no 🛡, ≤ max characters; '' when it reads as the admin's (-> 'Player'). */
export function playerName(name, max = 16) {
  const n = String(name ?? '').slice(0, 256).replace(BADGE, '').replace(/️/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return n && !adminLike(n) ? n : '';
}
