// The admin's signed command channel: what a command looks like, which ones a page accepts, and
// the player card each page seals for the admin. DOM-free (test/admin.test.mjs runs it in Node);
// js/admin/client.js carries the commands out on every page, js/admin/session.js sends them.
//
// Transport: the live player count's broker connection (js/net/presence.js listen / publish):
//   CMD_TOPIC                   'phortnite/admin/v1/cmd'           live commands (not retained)
//   STATE_PREFIX + 'banner'     'phortnite/admin/v1/state/banner'   retained: the admin's banner
//   STATE_PREFIX + 'maintenance'                                    retained: maintenance on/off
//   UP_TOPIC                    'phortnite/admin/v1/up'            uploads from pages (not retained)
// (pages subscribe to those two exact topics, never a wildcard: junk parked under made-up state
// topics never reaches an iPad; only the admin's page subscribes to UP_TOPIC)
// Envelope (js/admin/keys.js signs it): { v: 1, cmd, args, to, ts, n, sig }
//   to   a page's presence id (random per page load), or '*' (only for ALL_OK commands)
//   ts   ms since 1970 when it was signed; n 12 random bytes (base64), never used twice
//   args for '*': in the clear (a message or reload for everyone is public by nature). For one
//        page: { x: sealed, ...PUBLIC_ARGS } where x holds { cmd, to, ...args } sealed (SEAL_PAGE) to
//        that page's own key (the 'pk' in its sealed card). So names, messages and reasons never
//        cross the public broker in the clear, and a command the admin aims at a FAKED card for
//        some page (anyone can seal a card to the admin) is sealed to the faker's key: the real
//        page can't open it and does nothing. PUBLIC_ARGS: what the party also checks (the party
//        code, pause on/off, the mode) when the host's page passes a party command on.
// A page accepts a live command only when: the signature checks out with admin.json's sign.pub,
// |now - ts| <= 2 min, the nonce is new to it (last ~500 kept), `to` is its own id or '*', and
// (for its id) the sealed args open with its own key.
// State messages (retained) may be older: they carry their own 'until' (a banner at most a week
// from its signing too), and a page only ever moves forward (js/admin/client.js keeps the newest it
// accepted, across reloads).
//
// Party chat moderation (stage 3), always open: the player is told every time.
//   mute {minutes 1..MAX_MUTE_MIN, reason}   that page's chat is muted ("🔇 The admin muted your chat")
//   unmute {}                                and unmuted again
//   chatlog {}                               that page uploads its chat lines (the last 100 it saw this
//                                            page load) to the admin, and says so in its chat list
// (one page only, never '*': like every command for one page their args are sealed to that page.)
// Uploads: what pages send the admin, on UP_TOPIC: sealToAdmin(boxPub, payload, SEAL_UP), sealed
// with the page's own key (js/admin/keys.js `from`) so the admin can tell which page it really
// came from (e = the pk in that page's card); anyone can still seal SOMETHING to the admin's public
// key, so the admin's panel says whose page reported it and never trusts more than that.
//   payload { k, from: presence id, code: party code | 'SOLO', v: VERSION, ... }
//     k 'chat'    { lines }           new lines of the party this page hosts (the host's page only,
//                                     at most one upload per 3 s)
//     k 'log'     { re, lines }       the answer to a chatlog command (re: its nonce)
//     k 'report'  { line, context, reason? }  a player reported a line (context: up to 10 before it)
//   a line: { id, name, text, ts, q?, admin?, sys?, code?, at? } (js/chat/chatLog.js), cleaned again
//   on the admin's side (shared/chatFilter.js) and capped; a sealed upload is at most UP_MAX
//   characters (the oldest lines are left out to fit).
//
// API
//   CMD_TOPIC, STATE_PREFIX, STATE_TOPICS, STATE_KINDS, LIVE_CMDS, PARTY_CMDS, ALL_OK, MAX_AGE
//   cleanArgs(cmd, args)                 -> the args a page acts on (clamped, trimmed) | null
//   makeEnvelope(signKey, cmd, args, to, now, { pagePub }) -> a signed envelope (throws on bad args;
//                                           pagePub: the page's own public key, needed for one page)
//   new CommandGate({ signPub, pageKey, now, maxAge, lru, rate, rateMs, queue })
//     .live(env, myId)   -> Promise<{ ok, why, env, raw }>: a live command for this page? (env.args:
//                           the opened, clean args; raw: the envelope as it came, signature intact)
//     .state(env, kind)  -> Promise<{ ok, why, env }>: a signed state message for that topic?
//     .seen(n)           -> was this nonce accepted here already?
//   partyNote(signPub, env, code, now)   -> the public args of a party command passed on by the
//                                           host's page for party `code`, signed by the admin | null
//   stateActive(kind, args, now, ts)     -> is a banner / maintenance state in force right now?
//   cleanCard(obj)                       -> the player card fields the admin's panel shows | null
//   makeObserverCheck(signPub, opts)     -> async (env, code) => bool (stage E: a party host
//                                           checks an observer's signed 'observe' hello with it)
//   UP_TOPIC, UP_MAX, UP_LINES, UP_CONTEXT, UP_KINDS, MAX_MUTE_MIN
//   sealUpload(boxPub, payload, { from }) -> the text to publish on UP_TOPIC (<= UP_MAX) | null
//   upShape(obj)                          -> is it a sealed upload's shape ({e, iv, ct}, capped)?
//   cleanUpload(obj)                      -> an opened upload's fields, cleaned and capped | null
//   cleanChatLine(obj)                    -> one chat line, cleaned and capped | null
import { signCommand, verifyCommand, randomNonce, sealToAdmin, openSealed, SEAL_PAGE, SEAL_UP } from './keys.js';
import { cleanChat, quickText, QUICK_CHAT, MAX_CHAT } from '../../shared/chatFilter.js';

export const CMD_TOPIC = 'phortnite/admin/v1/cmd';
export const STATE_PREFIX = 'phortnite/admin/v1/state/';
export const STATE_KINDS = Object.freeze(['banner', 'maintenance']);
export const STATE_TOPICS = Object.freeze(STATE_KINDS.map((k) => STATE_PREFIX + k));
/** Commands sent live on CMD_TOPIC (every page; party ones only on the party host's page). */
export const LIVE_CMDS = Object.freeze(['reload', 'message', 'kick', 'ban', 'rename', 'grant', 'resetStats', 'end', 'pause', 'mode', 'mute', 'unmute', 'chatlog']);
/** Commands for a party host's page (the room runs there). */
export const PARTY_CMDS = Object.freeze(['end', 'pause', 'mode']);
/** Commands that may go to everyone at once ('*'). The rest name one page: a slip can't ban everyone. */
export const ALL_OK = Object.freeze(['reload', 'message']);
export const MAX_AGE = 120000; // a live command older (or further in the future) than this: ignored
export const MAX_XP = 100000;
export const MAX_MUTE_MIN = 10080; // the longest chat mute: a week
/**
 * Longest a maintenance state or a banner ("until cleared" too) can last from when it was signed:
 * a recorded old one that someone replays on the broker runs out by itself.
 */
export const STATE_MAX_MS = 7 * 86400000;
export const MAINT_MAX_MS = STATE_MAX_MS;
/** What stays in the clear in a command for one page (the party checks it): the rest is sealed. */
export const PUBLIC_ARGS = Object.freeze({ end: ['code'], pause: ['code', 'on'], mode: ['code', 'modeId'], kick: ['code'], ban: ['code'] });
const NONCE_RE = /^[A-Za-z0-9+/]{16}$/; // 12 bytes in base64
const ID_RE = /^[a-z0-9]{1,24}$/; // a presence id (js/net/presence.js)

const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '');
/** A name the way the account store keeps them (js/accounts/store.js cleanName). */
export const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16);
const int = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : null);
const CODE_RE = /^[A-Z]{4}$/;
/** { code } when args name a party (its 4-letter code), else nothing. */
const partyCode = (a) => (typeof a.code === 'string' && CODE_RE.test(a.code) ? { code: a.code } : {});

/** The args a page acts on for cmd (clamped and trimmed), or null when they make no sense. */
export function cleanArgs(cmd, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  switch (cmd) {
    case 'reload': case 'resetStats': case 'unmute': case 'chatlog': return {};
    case 'end': return partyCode(a);
    case 'kick': return { reason: cleanText(a.reason, 120), ...partyCode(a) };
    case 'ban': return { reason: cleanText(a.reason, 120), ...partyCode(a) };
    case 'message': { const text = cleanText(a.text, 300); return text ? { text } : null; }
    case 'rename': { const name = cleanName(a.name); return name ? { name } : null; }
    case 'grant': { const xp = int(a.xp, 0, MAX_XP); return xp === null || a.xp < 0 || a.xp > MAX_XP ? null : { xp }; }
    case 'pause': return typeof a.on === 'boolean' ? { on: a.on, ...partyCode(a) } : null;
    case 'mute': {
      const m = typeof a.minutes === 'number' ? a.minutes : NaN;
      if (!(m >= 1 && m <= MAX_MUTE_MIN)) return null; // (NaN too)
      return { minutes: Math.floor(m), reason: cleanText(a.reason, 120) };
    }
    case 'mode': { const modeId = cleanText(a.modeId, 40); return /^[a-z0-9_-]+$/i.test(modeId) ? { modeId, ...partyCode(a) } : null; }
    case 'banner': {
      const until = int(a.until, 0, 8.64e15);
      return { text: cleanText(a.text, 200), id: cleanText(a.id, 80), until: until || 0 };
    }
    case 'maintenance': {
      if (typeof a.on !== 'boolean') return null;
      return { on: a.on, text: cleanText(a.text, 300), until: int(a.until, 0, 8.64e15) || 0 };
    }
    case 'observe': return typeof a.code === 'string' && CODE_RE.test(a.code) ? { code: a.code } : null;
    default: return null;
  }
}

/**
 * Sign a command for `to` ('*' or a presence id): the envelope to publish. A live command for one
 * page needs that page's own public key (opts.pagePub, a CryptoKey from its card): its args are
 * sealed to it (see the top).
 */
export async function makeEnvelope(signKey, cmd, args = {}, to = '*', now = Date.now(), { pagePub = null } = {}) {
  const clean = cleanArgs(cmd, args);
  if (!clean) throw new Error(`bad args for ${cmd}`);
  to = String(to);
  let signed = clean;
  if (to !== '*' && LIVE_CMDS.includes(cmd)) {
    if (!pagePub) throw new Error("no key for that player's page (an older version of the game?)");
    signed = {};
    for (const k of PUBLIC_ARGS[cmd] || []) if (clean[k] !== undefined) signed[k] = clean[k];
    signed.x = await sealToAdmin(pagePub, { cmd, to, ...clean }, SEAL_PAGE);
  }
  return signCommand(signKey, { v: 1, cmd, args: signed, to, ts: Math.floor(now), n: randomNonce() });
}

/** Is a banner / maintenance state (its clean args, signed at ts) in force at `now`? */
export function stateActive(kind, args, now = Date.now(), ts = now) {
  if (!args) return false;
  // (a banner "until cleared" too: never longer than STATE_MAX_MS from its signing)
  if (kind === 'banner') return !!args.text && now < Math.min(args.until || Infinity, ts + STATE_MAX_MS);
  if (kind === 'maintenance') return !!args.on && now < args.until && args.until - ts <= STATE_MAX_MS;
  return false;
}

/** The newest `size` keys (a Set that forgets the oldest). */
export class Lru {
  constructor(size = 500) { this.size = size; this.set = new Set(); }
  has(k) { return this.set.has(k); }
  add(k) {
    this.set.delete(k);
    this.set.add(k);
    if (this.set.size > this.size) this.set.delete(this.set.values().next().value);
  }
}

/** A seal's shape ({e, iv, ct}: js/admin/keys.js), size-capped. */
function sealedShape(x) {
  return !!x && typeof x === 'object' && typeof x.e === 'string' && x.e.length <= 120 && typeof x.iv === 'string'
    && x.iv.length <= 24 && typeof x.ct === 'string' && x.ct.length <= 2000;
}

/**
 * Signature checks allowed: `rate` per `ms`. Past that a check waits for room (the newest first, at
 * most `queue` waiting; an older one pushed out gets false) instead of being dropped, so a real
 * command that arrives during a flood of junk is still checked once there is room.
 */
export class Budget {
  constructor({ rate = 1000, ms = 10000, queue = 16, now = () => Date.now() } = {}) {
    this.rate = rate;
    this.ms = ms;
    this.queue = queue;
    this.now = now;
    this.t = []; // when the last checks ran
    this.q = []; // waiting: resolve functions, oldest first
    this.timer = 0;
  }

  take() {
    const t = this.now();
    while (this.t.length && t - this.t[0] > this.ms) this.t.shift();
    if (this.t.length >= this.rate) return false;
    this.t.push(t);
    return true;
  }

  /** Promise<true> when a check may run (now, or once there is room), <false> when pushed out. */
  slot() {
    if (!this.q.length && this.take()) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.q.push(resolve);
      if (this.q.length > this.queue) this.q.shift()(false);
      this.drain();
    });
  }

  drain() {
    if (this.timer) return;
    const wait = this.t.length ? this.t[0] + this.ms - this.now() + 5 : 0;
    this.timer = setTimeout(() => {
      this.timer = 0;
      while (this.q.length && this.take()) this.q.pop()(true);
      if (this.q.length) this.drain();
    }, Math.max(50, Math.min(this.ms, wait)));
  }
}

/** The shape every envelope must have before its signature is even checked (cheap). */
function shaped(env) {
  return !!env && typeof env === 'object' && !Array.isArray(env) && env.v === 1 && typeof env.cmd === 'string'
    && typeof env.to === 'string' && (env.to === '*' || ID_RE.test(env.to)) && Number.isFinite(env.ts)
    && typeof env.n === 'string' && NONCE_RE.test(env.n) && typeof env.sig === 'string';
}

/**
 * Which signed commands this page accepts. Everything cheap is checked before the signature, and
 * signature checks are rate limited: a flood of junk on the public broker can't keep the iPad
 * busy. Commands for this page, commands for everyone and state messages each have their own
 * budget (junk sent to '*' can't starve a command aimed at this page), well above what one client
 * can send through a public broker, and a check over budget waits for room instead of being dropped.
 * pageKey: this page's own private key (js/admin/keys.js newBoxKey): it opens the sealed args of a
 * command for this page (set it once it exists: until then such commands are refused).
 */
export class CommandGate {
  constructor({ signPub, pageKey = null, now = () => Date.now(), maxAge = MAX_AGE, lru = 500, rate = 1000, rateMs = 10000, queue = 16 } = {}) {
    this.signPub = signPub;
    this.pageKey = pageKey;
    this.now = now;
    this.maxAge = maxAge;
    this.nonces = new Lru(lru);
    this.bad = new Lru(300); // signatures already found false (a replayed piece of junk costs nothing)
    const b = () => new Budget({ rate, ms: rateMs, queue, now });
    this.budgets = { me: b(), all: b(), state: b() };
  }

  seen(n) { return this.nonces.has(n); }

  /** Check env's signature within `bucket`'s budget: '' when it is the admin's, else why not. */
  async check(env, bucket) {
    if (this.bad.has(env.sig)) return 'sig';
    if (!(await this.budgets[bucket].slot())) return 'busy';
    if (await verifyCommand(this.signPub, env)) return '';
    this.bad.add(env.sig);
    return 'sig';
  }

  /** A live command (CMD_TOPIC) for the page whose presence id is myId? */
  async live(env, myId) {
    if (!shaped(env)) return { ok: false, why: 'shape' };
    if (!LIVE_CMDS.includes(env.cmd)) return { ok: false, why: 'cmd' };
    if (env.to !== '*' && env.to !== myId) return { ok: false, why: 'to' };
    if (env.to === '*' && !ALL_OK.includes(env.cmd)) return { ok: false, why: 'to' };
    if (Math.abs(this.now() - env.ts) > this.maxAge) return { ok: false, why: 'stale' };
    if (this.nonces.has(env.n)) return { ok: false, why: 'replay' };
    const all = env.to === '*';
    let args = all ? cleanArgs(env.cmd, env.args) : null;
    if (all ? !args : !(env.args && typeof env.args === 'object' && sealedShape(env.args.x))) return { ok: false, why: 'args' };
    const why = await this.check(env, all ? 'all' : 'me');
    if (why) return { ok: false, why };
    // (checked again: the same command may have come in twice while the signature was checked)
    if (this.nonces.has(env.n)) return { ok: false, why: 'replay' };
    this.nonces.add(env.n);
    if (!all) {
      // sealed to this page's own key: one aimed at a faked card for this page (another key) opens to nothing
      const inner = await openSealed(this.pageKey, env.args.x, SEAL_PAGE);
      if (!inner || typeof inner !== 'object' || inner.cmd !== env.cmd || inner.to !== env.to) return { ok: false, why: 'card' };
      args = cleanArgs(env.cmd, inner);
      if (!args) return { ok: false, why: 'args' };
    }
    return { ok: true, env: { ...env, args }, raw: env };
  }

  /** A retained state message on STATE_PREFIX + kind? (Its age is judged by its 'until'.) */
  async state(env, kind) {
    if (!shaped(env)) return { ok: false, why: 'shape' };
    if (!STATE_KINDS.includes(kind) || env.cmd !== kind || env.to !== '*') return { ok: false, why: 'cmd' };
    // (a state signed more than 2 min in the future: a wrong clock somewhere, not a real state)
    if (env.ts - this.now() > this.maxAge) return { ok: false, why: 'future' };
    const args = cleanArgs(kind, env.args);
    if (!args) return { ok: false, why: 'args' };
    const why = await this.check(env, 'state');
    if (why) return { ok: false, why };
    return { ok: true, env: { ...env, args } };
  }
}

/**
 * A party command the host's page passed on to its party ({t: 'admin', env}: the admin's signed
 * envelope, as it came): its public args when the admin signed it, at most maxAge ago, for party
 * `code` (a host can't pass on one meant for another party), else null. Never throws.
 */
export async function partyNote(signPub, env, code, now = Date.now(), maxAge = MAX_AGE) {
  try {
    if (!shaped(env) || env.to === '*' || !['end', 'pause', 'mode', 'kick', 'ban'].includes(env.cmd)) return null;
    if (Math.abs(now - env.ts) > maxAge) return null;
    const a = cleanArgs(env.cmd, env.args);
    if (!a || !a.code || a.code !== code) return null;
    return (await verifyCommand(signPub, env)) ? a : null;
  } catch (e) { return null; }
}

/**
 * The player card a page seals for the admin (js/admin/client.js makes it, js/admin/session.js
 * reads it): only these fields, trimmed. null when it isn't a card.
 */
export function cleanCard(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
  const p = c.party && typeof c.party === 'object' ? c.party : null;
  const kind = p && ['solo', 'host', 'member', 'watch'].includes(p.kind) ? p.kind : null; // watch: the admin observing
  return {
    id: c.id,
    name: cleanName(c.name) || 'Player',
    level: int(c.level, 1, 999) || 1,
    account: typeof c.account === 'string' ? cleanText(c.account, 16) : null, // short id, 'guest', or null (still choosing)
    mode: cleanText(c.mode, 40),
    phase: c.phase === 'match' ? 'match' : 'lobby',
    party: kind ? { code: typeof p.code === 'string' && /^[A-Z]{4}$/.test(p.code) ? p.code : '', kind, size: int(p.size, 1, 64) || 1 } : null,
    v: cleanText(c.v, 16),
    since: int(c.since, 0, 8.64e15) || 0,
    admin: c.admin === true, // that page is in admin mode
    // that page's own public key (raw P-256, base64): the admin seals its commands' args to it
    pk: typeof c.pk === 'string' && /^[A-Za-z0-9+/]{87}=$/.test(c.pk) ? c.pk : null,
    // that page's chat is muted until then (ms since 1970; only while it is)
    ...(int(c.muted, 1, 8.64e15) ? { muted: int(c.muted, 1, 8.64e15) } : {}),
  };
}

/**
 * Stage E: a party host checks an observer's hello with this. env is an envelope
 * {cmd: 'observe', args: {code}, to: '*'} signed by the admin (AdminSession.observeHello) for
 * that party code, at most maxAge old. Async: P2PHost awaits it before the room sees the hello
 * (Room.join is synchronous). once (the default): each envelope lets one connection in, so one
 * copied off the relay (its hellos cross the public broker in the clear) is worth nothing once the
 * admin has used it; the admin signs a new one for every join and rejoin (js/ui/adminWatch.js).
 */
export function makeObserverCheck(signPub, { now = () => Date.now(), maxAge = MAX_AGE, once = true } = {}) {
  const used = new Lru(200);
  return async (env, code) => {
    if (!shaped(env) || env.cmd !== 'observe' || env.to !== '*') return false;
    const args = cleanArgs('observe', env.args);
    if (!args || args.code !== code || Math.abs(now() - env.ts) > maxAge || (once && used.has(env.n))) return false;
    if (!(await verifyCommand(signPub, env))) return false;
    if (once && used.has(env.n)) return false;
    used.add(env.n);
    return true;
  };
}

// ------------------------------------------------------------------ uploads (party chat moderation)
export const UP_TOPIC = 'phortnite/admin/v1/up';
/**
 * A sealed upload's published text, at most (the oldest lines are left out to fit). The same size
 * as the relay's messages (js/net/relay.js BATCH), which all three public brokers are known to
 * carry: a broker that refuses a bigger message would drop the page's whole presence connection.
 * (100 chat lines of everyday length fit: about 90 bytes each.)
 */
export const UP_MAX = 16000;
export const UP_LINES = 100; // lines in a chat log or a live batch
export const UP_CONTEXT = 10; // lines before a reported one
export const UP_KINDS = Object.freeze(['chat', 'log', 'report']);
const SEAL_WRAP = 160; // the sealed JSON around its ct: {"e":"<88>","iv":"<16>","ct":""} and slack
const LINE_CODE_RE = /^([A-Z]{4}|SOLO)$/;
const utf8 = new TextEncoder();

/** One chat line from an upload, cleaned again and capped (a page could send anything), or null. */
export function cleanChatLine(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const sys = l.sys === true;
  const q = !sys && Number.isInteger(l.q) && l.q >= 0 && l.q < QUICK_CHAT.length ? l.q : null;
  const text = q !== null ? quickText(q) : cleanChat(typeof l.text === 'string' ? l.text.slice(0, MAX_CHAT * 4) : '').text;
  if (!text) return null;
  const id = Number.isFinite(l.id) ? Math.max(-1e6, Math.min(1e6, Math.trunc(l.id))) : 0;
  const admin = !sys && l.admin === true && id < 0; // (an observer's line: the admin's own)
  const name = sys ? '' : admin ? 'Admin' : cleanChat(typeof l.name === 'string' ? l.name.slice(0, 64) : '').text.slice(0, 16) || 'Player';
  const out = { id, name, text, ts: Number.isFinite(l.ts) ? Math.max(0, Math.min(8.64e15, l.ts)) : 0 };
  if (q !== null) out.q = q;
  if (admin) out.admin = true;
  if (sys) out.sys = true;
  if (typeof l.code === 'string' && LINE_CODE_RE.test(l.code)) out.code = l.code;
  const at = int(l.at, 1, 8.64e15);
  if (at) out.at = at;
  return out;
}

/** Is x a sealed upload ({e, iv, ct}) of a size worth opening? */
export function upShape(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.e === 'string' && x.e.length <= 120
    && typeof x.iv === 'string' && x.iv.length <= 24 && typeof x.ct === 'string' && x.ct.length <= UP_MAX;
}

/**
 * An opened upload (see the top), cleaned: { k, from, code, v, ... } with lines / re / line,
 * context, reason; null when it isn't one. Never throws.
 */
export function cleanUpload(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !UP_KINDS.includes(o.k)) return null;
  if (typeof o.from !== 'string' || !ID_RE.test(o.from)) return null;
  const code = typeof o.code === 'string' && LINE_CODE_RE.test(o.code) ? o.code : '';
  const base = { k: o.k, from: o.from, code, v: cleanText(o.v, 16) };
  const list = (a, n) => (Array.isArray(a) ? a.slice(-n).map(cleanChatLine).filter(Boolean) : []);
  if (o.k === 'chat') {
    // (a live party: its 4-letter code, never 'SOLO' (no O or I in a real code); its players' lines, no system notes)
    if (!CODE_RE.test(code) || code === 'SOLO') return null;
    const lines = list(o.lines, UP_LINES).filter((l) => !l.sys).map((l) => ({ ...l, code }));
    return lines.length ? { ...base, lines } : null;
  }
  if (o.k === 'log') {
    if (typeof o.re !== 'string' || !NONCE_RE.test(o.re)) return null;
    return { ...base, re: o.re, lines: list(o.lines, UP_LINES) };
  }
  const line = cleanChatLine(o.line);
  if (!line || line.sys) return null;
  return { ...base, line: { ...line, code: line.code || code || 'SOLO' }, context: list(o.context, UP_CONTEXT), reason: cleanText(o.reason, 120) };
}

/**
 * Seal an upload for the admin (SEAL_UP; from: this page's own key, js/admin/keys.js): the text to
 * publish on UP_TOPIC, at most max characters: the oldest lines (a report: the oldest context
 * lines) are left out until it fits. null when it can't be made to fit.
 */
export async function sealUpload(boxPub, payload, { from = null, max = UP_MAX } = {}) {
  const p = { ...payload };
  const key = p.k === 'report' ? 'context' : 'lines';
  const list = Array.isArray(p[key]) ? p[key].slice(-(p.k === 'report' ? UP_CONTEXT : UP_LINES)) : [];
  // what the plain text may weigh: base64 of (text + the 16-byte tag), inside the sealed JSON
  const room = Math.floor(((max - SEAL_WRAP) * 3) / 4) - 16;
  const bytes = (v) => utf8.encode(JSON.stringify(v)).length;
  p[key] = [];
  let total = bytes(p);
  const sizes = list.map((l) => bytes(l) + 1);
  for (const n of sizes) total += n;
  let i = 0;
  while (i < list.length && total > room) total -= sizes[i++];
  p[key] = list.slice(i);
  for (let tries = 0; tries < 8; tries++) {
    const text = JSON.stringify(await sealToAdmin(boxPub, p, SEAL_UP, { from }));
    if (text.length <= max) return text;
    if (!p[key].length) return null;
    p[key] = p[key].slice(Math.max(1, p[key].length >> 3));
  }
  return null;
}
