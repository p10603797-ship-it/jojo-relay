// The party chat's store and its small decisions, DOM-free (the tests run it in Node). The chat UI
// (js/ui/chat.js, app.chat) keeps one ChatLog for the whole page load.
//   new ChatLog({ storage, now, max })   storage: localStorage (or a fake), now: () => ms epoch
//   .add(raw, { code, history, game, adminOk })   a room line {id, name, text, ts, q?, admin?} ->
//                                        the stored line (cleaned again), or null (junk, or already
//                                        seen). history: from a welcome, kept but never announced as
//                                        new. adminOk: the answer of the admin signature check on a
//                                        line that claims to be his (js/ui/chat.js always passes it)
//   .notice(text, code)                  a system line (sys: true) for that party's list
//   .lines()                             copies of the newest `max` (100) lines, all parties
//   .party(code)                         this party's lines (the drawer's list)
//   .onLine(fn) -> off                   fn(line, game) for every new room line (not history,
//                                        not system notices)
//   .setMute(until, reason) / .muted()   the admin's mute, kept in localStorage
//                                        ('phortnite.chatMute': {until, reason}); 0 or past clears
//   .hide(code, id, on) / .isHidden(code, id)   "Hide messages from NAME" (this party, this visit)
//   .unread / .count(line, ctx) / .markRead()   the CHAT button's badge
// Lines are {id, name, text, ts, q?, admin?, code, at, sys?}: id = the room's player id (an
// observer, i.e. the admin, has a negative one), ts = the room's clock, at = this page's Date.now()
// when it arrived, code = the party code ('SOLO' in a party of one).
// Pure helpers: chatMode(settings), cleanLine(), lineKey(), lineView() (what a line shows as under
// each Chat setting), sendBlock() (why a line can't be sent), Limiter (the room's rate limit, kept
// here too), muteText(), adminLike(name) / playerName(name) (the admin's look is his alone).
// Every line is cleaned again here with shared/chatFilter.js (text AND name): a modded host page
// can't push unfiltered text into this page.
// The admin's look is his alone: a player's name never shows the 🛡 and never reads "Admin" (or
// "Adm1n", "A d m i n", "Moderator", "mod"…): it shows as 'Player' (the room renames such players
// too: shared/chatFilter.js playerName). Only an observer's line (the admin watching: a negative id,
// admin: true) that carries his signature is named 'Admin' and gets the 🛡 ADMIN tag: the party's
// room runs on the host's page, so the room's admin: true alone proves nothing (a modded host page
// could set it on any line). js/ui/chat.js checks the signature (js/admin/commands.js adminLineOk)
// and passes the answer as adminOk; a claim that fails shows as 'Player'. ("Philip" is not
// reserved: Philip plays under his own name, and friends may be called that too.) The room's other
// messages (notes, alerts) still trust the host's page; the admin's own party commands are signed.
import { cleanChat, quickText, QUICK_CHAT, MAX_CHAT, adminLike, playerName } from '../../shared/chatFilter.js';

export const MAX_LINES = 100;
export const MUTE_KEY = 'phortnite.chatMute';
export const CHAT_MODES = ['on', 'quick', 'off'];
export const HIDDEN_QUICK = '💬 (message hidden: quick chat only)';
export const HIDDEN_SENDER = 'hidden';
const MAX_MUTE_MS = 10080 * 60000 + 86400000; // a week (the admin's longest mute) and a day of slack
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

/** The Chat setting: 'on' (default) | 'quick' (quick chat only) | 'off'. */
export function chatMode(settings) {
  const m = settings && settings.chat;
  return CHAT_MODES.includes(m) ? m : 'on';
}

/** A party code as a line keeps it: 4 letters (or 'SOLO'). */
export function cleanCode(code) {
  const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c || 'SOLO';
}

const isQuick = (q) => Number.isInteger(q) && q >= 0 && q < QUICK_CHAT.length;

// ------------------------------------------------------------------ the admin's look
// adminLike / playerName live in shared/chatFilter.js (the room uses them for every name it takes);
// re-exported here for the chat UI and the rename sheet (js/ui/menu.js).
export { adminLike, playerName };

/**
 * A room line as this page keeps it, or null. The text is cleaned again (a quick line shows this
 * page's own QUICK_CHAT text for its index), the name too; admin only for an observer's id, and
 * only when adminOk (the caller checked the admin's signature on it: js/ui/chat.js). A player's
 * name that looks like the admin's shows as 'Player' (playerName), and so does a failed claim.
 */
export function cleanLine(m, code = 'SOLO', at = Date.now(), adminOk = true) {
  if (!m || typeof m !== 'object') return null;
  const id = Number.isFinite(m.id) ? Math.trunc(m.id) : 0;
  const ts = Number.isFinite(m.ts) ? m.ts : 0;
  const quick = isQuick(m.q);
  const text = quick ? quickText(m.q) : cleanChat(typeof m.text === 'string' ? m.text.slice(0, MAX_CHAT * 4) : '').text;
  if (!text) return null;
  const admin = m.admin === true && id < 0 && adminOk === true;
  const name = admin ? 'Admin' : playerName(cleanChat(typeof m.name === 'string' ? m.name.slice(0, 64) : '').text) || 'Player';
  const line = { id, name, text, ts, code: cleanCode(code), at };
  if (quick) line.q = m.q;
  if (admin) line.admin = true;
  return line;
}

/** The same line seen twice (a welcome's history after a rejoin): party + room time + sender + text. */
export function lineKey(l) { return `${l.code}|${l.ts}|${l.id}|${l.text}`; }

/**
 * What a line shows as here, or null (not shown at all: chat is Off). ctx: { mode, mine (my own
 * line), hidden (its sender is hidden in this party) }.
 *   kind 'sys'        a system line (dimmed)
 *   kind 'admin'      the admin's line (the 🛡 ADMIN tag); never hidden
 *   kind 'hidden'     a sender this player hid ("hidden")
 *   kind 'quickonly'  Quick chat only: someone's free text ("💬 (message hidden: quick chat only)")
 *   kind 'text'       the line's text (a quick line: this page's QUICK_CHAT text)
 */
export function lineView(line, { mode = 'on', mine = false, hidden = false } = {}) {
  if (!line || mode === 'off') return null;
  if (line.sys) return { kind: 'sys', text: line.text };
  const quick = isQuick(line.q);
  const text = quick ? quickText(line.q) : line.text;
  if (line.admin) return { kind: 'admin', text };
  if (mine) return { kind: 'text', text };
  if (hidden) return { kind: 'hidden', text: HIDDEN_SENDER };
  if (mode === 'quick' && !quick) return { kind: 'quickonly', text: HIDDEN_QUICK };
  return { kind: 'text', text };
}

/**
 * Why this page can't send a line now ('' = it can): 'off' (Chat is Off), 'quickonly' (free text
 * with Quick chat only), 'muted' (the admin muted this chat), 'offline' (no party connection).
 */
export function sendBlock({ mode = 'on', muted = null, connected = true, quick = false } = {}) {
  if (mode === 'off') return 'off';
  if (muted) return 'muted';
  if (!connected) return 'offline';
  if (mode === 'quick' && !quick) return 'quickonly';
  return '';
}

/** "🔇 The admin muted your chat until 14:05" (a weekday first when it isn't today) + the reason. */
export function muteText(m, now = Date.now()) {
  if (!m || !(m.until > now)) return '';
  const d = new Date(m.until);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const when = new Date(now).toDateString() === d.toDateString() ? hhmm : `${DAYS[d.getDay()]} ${hhmm}`;
  return `🔇 The admin muted your chat until ${when}${m.reason ? ` (${m.reason})` : ''}`;
}

/**
 * The room's rate limit, kept on this page too, so a line it would drop is never sent: a token
 * bucket (burst 4, one more every 1.5 s), at most 20 lines a minute, and the same text again
 * within 5 s is dropped. take(text, now) -> 'ok' (sent: counted) | 'slow' | 'dup'.
 */
export class Limiter {
  constructor({ burst = 4, refillMs = 1500, perMin = 20, dupMs = 5000 } = {}) {
    Object.assign(this, { burst, refillMs, perMin, dupMs });
    this.tokens = burst;
    this.t = null;
    this.recent = [];
    this.lastText = '';
    this.lastAt = -Infinity;
  }

  check(text, now) {
    if (text && text === this.lastText && now - this.lastAt < this.dupMs) return 'dup';
    const tokens = this.t === null ? this.tokens : Math.min(this.burst, this.tokens + (now - this.t) / this.refillMs);
    if (tokens < 1) return 'slow';
    if (this.recent.filter((x) => now - x < 60000).length >= this.perMin) return 'slow';
    return 'ok';
  }

  take(text, now) {
    const r = this.check(text, now);
    if (r !== 'ok') return r;
    this.tokens = (this.t === null ? this.tokens : Math.min(this.burst, this.tokens + (now - this.t) / this.refillMs)) - 1;
    this.t = now;
    this.recent = this.recent.filter((x) => now - x < 60000);
    this.recent.push(now);
    this.lastText = text;
    this.lastAt = now;
    return 'ok';
  }
}

/** A system notice's text: our own words, kept short and plain. */
function cleanNotice(text) {
  return String(text ?? '').replace(/[\t\n\r]/g, ' ').replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export class ChatLog {
  constructor({ storage = null, now = () => Date.now(), max = MAX_LINES } = {}) {
    this.storage = storage;
    this.now = now;
    this.max = max;
    this.list = [];
    this.seen = new Map(); // lineKey -> true (the newest 400: a line that comes back is not new)
    this.fns = new Set();
    this.hidden = new Set(); // `${code}|${id}`
    this.unread = 0;
    this.mute = readMute(storage, now());
  }

  /** A line from the room (or a welcome's history). Returns the stored line, or null. */
  add(raw, { code = 'SOLO', history = false, game = null, adminOk = true } = {}) {
    const line = cleanLine(raw, code, this.now(), adminOk);
    if (!line) return null;
    const key = lineKey(line);
    if (this.seen.has(key)) return null;
    this.seen.set(key, true);
    if (this.seen.size > 400) this.seen.delete(this.seen.keys().next().value);
    this.push(line);
    if (!history) {
      for (const fn of [...this.fns]) {
        try { fn({ ...line }, game); } catch (e) { console.error('chat listener', e); }
      }
    }
    return line;
  }

  /** A system line in party `code`'s list (e.g. '🛡 The admin looked at this chat'). */
  notice(text, code = 'SOLO') {
    const t = cleanNotice(text);
    if (!t) return null;
    const line = { id: 0, name: '', text: t, ts: 0, code: cleanCode(code), at: this.now(), sys: true };
    this.push(line);
    return line;
  }

  push(line) {
    this.list.push(line);
    while (this.list.length > this.max) this.list.shift();
  }

  /** Copies of the newest lines, all parties (the admin's chat log reads these). */
  lines() { return this.list.map((l) => ({ ...l })); }

  /** Party `code`'s lines, oldest first (the drawer's list; not copies). */
  party(code) {
    const c = cleanCode(code);
    return this.list.filter((l) => l.code === c);
  }

  onLine(fn) {
    if (typeof fn !== 'function') return () => {};
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  // ------------------------------------------------------------------ the admin's mute
  /** until: ms epoch (0 or a time already past clears it); reason: the admin's words (≤ 120). */
  setMute(until, reason = '') {
    const u = Number(until) || 0;
    const now = this.now();
    if (!(u > now)) {
      this.mute = null;
      try { if (this.storage) this.storage.removeItem(MUTE_KEY); } catch (e) { /* private mode */ }
      return null;
    }
    this.mute = { until: Math.min(u, now + MAX_MUTE_MS), reason: cleanNotice(reason).slice(0, 120) };
    try { if (this.storage) this.storage.setItem(MUTE_KEY, JSON.stringify(this.mute)); } catch (e) { /* private mode: this visit only */ }
    return { ...this.mute };
  }

  /** {until, reason} while muted, else null (a mute whose time is up clears itself). */
  muted() {
    const m = this.mute;
    if (!m) return null;
    if (!(m.until > this.now())) { this.setMute(0); return null; }
    return { ...m };
  }

  // ------------------------------------------------------------------ hide a sender (this party, this visit)
  hide(code, id, on = true) {
    const k = `${cleanCode(code)}|${id | 0}`;
    if (on) this.hidden.add(k); else this.hidden.delete(k);
  }

  isHidden(code, id) { return this.hidden.has(`${cleanCode(code)}|${id | 0}`); }

  // ------------------------------------------------------------------ unread (the CHAT button's badge)
  /**
   * A new line arrived: count it when the chat is closed and the line shows as something to read
   * (not mine, not from a hidden sender, not a line Quick chat only hides, chat not Off).
   * ctx: { open, mode, mine }. Returns the count.
   */
  count(line, { open = false, mode = 'on', mine = false } = {}) {
    if (open || mine || !line) return this.unread;
    const v = lineView(line, { mode, mine, hidden: !line.sys && this.isHidden(line.code, line.id) });
    if (!v || v.kind === 'hidden' || v.kind === 'quickonly') return this.unread;
    this.unread = Math.min(999, this.unread + 1);
    return this.unread;
  }

  markRead() { this.unread = 0; }
}

function readMute(storage, now) {
  try {
    const m = storage ? JSON.parse(storage.getItem(MUTE_KEY) || 'null') : null;
    if (m && typeof m === 'object' && Number.isFinite(m.until) && m.until > now) {
      return { until: Math.min(m.until, now + MAX_MUTE_MS), reason: typeof m.reason === 'string' ? cleanNotice(m.reason).slice(0, 120) : '' };
    }
  } catch (e) { /* none */ }
  return null;
}
