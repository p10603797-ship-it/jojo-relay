// Room plugin for party chat (stage 3): the 'chat' message, in the lobby and in matches (bus,
// match, end screen), in every room (P2P host, Node server, solo). See shared/plugins/index.js for
// the plugin interface and shared/chatFilter.js for what a line may hold.
//
//   client -> room    {t:'chat', text}    free text: the room cleans it (cleanChat: bad words ★,
//                                         personal info [hidden], at most MAX_CHAT characters)
//                     {t:'chat', q}       quick chat: QUICK_CHAT[q]
//                     {t:'chat', text|q, env}   an observer (the admin watching): env, the signed
//                                         {cmd: 'say', args: {code, text}} his page made for this line
//   room -> everyone  {t:'chat', id, name, text, ts, q?, admin?, env?}   players AND observers
//       id    the speaker's room player id (an observer: its negative id)
//       name  the player's current roster name (an observer: 'Admin')
//       text  as the room cleaned it (quick chat: QUICK_CHAT[q], and q is echoed)
//       ts    room.wall() (see Clocks)
//       admin true only on an observer's line: set by the room, never taken from what was sent
//       env   an observer's line only: its signature, passed on as it came (a plain object, at most
//             ENV_MAX characters of JSON). The room doesn't check it (it has no keys): every page
//             does (js/admin/commands.js adminLineOk) before it shows the 🛡 ADMIN tag, because the
//             room runs on the host's page and a modded one could set admin: true on anything.
//   room -> sender    {t:'chatno', why}   'slow' (rate limit; at most one a second), 'empty' (nothing
//                                         left after cleaning, or not a quick chat index). A long
//                                         line is never refused: it is cut at MAX_CHAT.
//
// Limits per speaker (a player record, or an observer): a token bucket (BURST lines, one more every
// REFILL_MS) and at most PER_MIN lines in any 60 s; the same text again within DUP_MS is dropped
// without a word (it still uses its token). Bots never chat (a connection only speaks as its own
// player), nor does a player held away for a rejoin.
// The limits are checked BEFORE a line is cleaned: cleanChat costs well under a millisecond on
// ordinary text, but a crafted line (lots of 1-2 letter words) costs it a few, and a modded page
// can send hundreds of lines a second (the transports' flood guard allows 400). A speaker with no
// token left is told 'slow' and its line is never read, and every line that does get cleaned takes
// a token, repeats included (else one costly line sent again and again would be cleaned for free).
// Only a line with nothing in it is free: cleanChat gives '' only from its cheap first step.
//
// Clocks: the limits and ts run on room.wall(), a clock that never pauses. room.now() stops on a
// P2P host for the admin's ⏸ pause (and while the host's page is hidden), which is exactly when
// the party and the admin want to talk: on the room clock the bucket would never refill, and two
// lines would share one ts (pages tell lines apart by code|ts|id|text).
//
// History: the last HISTORY lines of this party (for its whole life, never cleared, also across
// matches). The welcome carries the last WELCOME_LINES as chat: [lines], so joiners and rejoiners
// see the recent chat (an observer's welcome too: the admin who starts watching sees it).
//
// Observers (the admin watching, see shared/room.js): the Room hands their messages to
// observerMessage first; a {t:'chat'} from an observer goes through the same cleaning and limits
// and goes out as name 'Admin', admin: true. Moderation is open: everyone sees the admin's lines.
import { cleanChat, quickText } from '../chatFilter.js';

export const HISTORY = 30;
export const WELCOME_LINES = 20;
export const BURST = 4;
export const REFILL_MS = 1500;
export const PER_MIN = 20;
export const DUP_MS = 5000;
const NO_MS = 1000; // at most one 'chatno slow' a second per speaker
export const ENV_MAX = 2000; // an observer line's signature (env), as JSON, at most

/** An observer line's signature as the room keeps it: a plain copy, or null (none, or junk). */
function envOf(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  try {
    const json = JSON.stringify(env);
    return json.length <= ENV_MAX ? JSON.parse(json) : null;
  } catch (e) { return null; }
}

// speaker (player record / observer record) -> { tokens, t, times, last, lastT, noT }
const limits = new WeakMap();

/** This speaker's limits, the bucket refilled and the minute's lines pruned up to now. */
function limitsOf(who, now) {
  let L = limits.get(who);
  if (!L) limits.set(who, (L = { tokens: BURST, t: now, times: [], last: '', lastT: -1e12, noT: -1e12 }));
  L.tokens = Math.min(BURST, L.tokens + Math.max(0, now - L.t) / REFILL_MS);
  L.t = now;
  while (L.times.length && now - L.times[0] >= 60000) L.times.shift();
  return L;
}

/** A plain copy of a line (local transports hand the very object to the page: history stays ours). */
const copy = (line) => (line.env ? { ...line, env: JSON.parse(JSON.stringify(line.env)) } : { ...line });

/** A line from a player (who = its record) or an observer (who = its observer record, admin). */
function post(room, conn, who, m, admin) {
  const now = room.wall();
  const L = limitsOf(who, now);
  const quick = m.q !== undefined && m.q !== null;
  // not a quick chat index, or no text at all: nothing to read (free)
  if (quick ? !quickText(m.q) : typeof m.text !== 'string' || !m.text.trim()) { room.send(conn, { t: 'chatno', why: 'empty' }); return; }
  // out of tokens: turned away unread (never cleaned)
  if (L.tokens < 1 || L.times.length >= PER_MIN) {
    if (now - L.noT >= NO_MS) { L.noT = now; room.send(conn, { t: 'chatno', why: 'slow' }); }
    return;
  }
  const text = quick ? quickText(m.q) : cleanChat(m.text).text;
  if (!text) { room.send(conn, { t: 'chatno', why: 'empty' }); return; } // only cleanChat's cheap first step empties a line
  L.tokens -= 1; // cleaned: it costs a token, even if it turns out to be a repeat
  if (text === L.last && now - L.lastT < DUP_MS) return;
  L.times.push(now);
  L.last = text;
  L.lastT = now;
  const line = { id: who.id, name: admin ? 'Admin' : who.name, text, ts: now };
  if (quick) line.q = m.q;
  if (admin) {
    line.admin = true;
    const env = envOf(m.env);
    if (env) line.env = env;
  }
  const H = room.chatLines;
  H.push(line);
  if (H.length > HISTORY) H.splice(0, H.length - HISTORY);
  room.broadcast({ t: 'chat', ...copy(line) });
}

export const chat = {
  name: 'chat',

  init(room) {
    room.chatLines = []; // this party's last HISTORY lines
  },

  welcome(room) {
    return { chat: room.chatLines.slice(-WELCOME_LINES).map(copy) };
  },

  /** The admin talking in the party it watches. */
  observerMessage(room, ob, msg) {
    if (!msg || msg.t !== 'chat') return undefined;
    post(room, ob.conn, ob, msg, true);
    return true;
  },

  handlers: {
    chat(c, m) {
      const p = this.players.get(c.pid);
      if (!p || p.bot || p.away) return;
      post(this, c.conn, p, m, false);
    },
  },
};
