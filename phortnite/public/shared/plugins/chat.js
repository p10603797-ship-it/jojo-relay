// Room plugin for party chat (stage 3): the 'chat' message, in the lobby and in matches (bus,
// match, end screen), in every room (P2P host, Node server, solo). See shared/plugins/index.js for
// the plugin interface and shared/chatFilter.js for what a line may hold.
//
//   client -> room    {t:'chat', text}    free text: the room cleans it (cleanChat: bad words ★,
//                                         personal info [hidden], at most MAX_CHAT characters)
//                     {t:'chat', q}       quick chat: QUICK_CHAT[q]
//   room -> everyone  {t:'chat', id, name, text, ts, q?, admin?}   players AND observers
//       id    the speaker's room player id (an observer: its negative id)
//       name  the player's current roster name (an observer: 'Admin')
//       text  as the room cleaned it (quick chat: QUICK_CHAT[q], and q is echoed)
//       ts    room.now()
//       admin true only on an observer's line: set by the room, never taken from what was sent
//   room -> sender    {t:'chatno', why}   'slow' (rate limit; at most one a second), 'empty' (nothing
//                                         left after cleaning, or not a quick chat index). A long
//                                         line is never refused: it is cut at MAX_CHAT.
//
// Limits per speaker (a player record, or an observer): a token bucket (BURST lines, one more every
// REFILL_MS) and at most PER_MIN lines in any 60 s; the same text again within DUP_MS is dropped
// without a word. Bots never chat (a connection only speaks as its own player), nor does a player
// held away for a rejoin.
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

// speaker (player record / observer record) -> { tokens, t, times, last, lastT, noT }
const limits = new WeakMap();

/** May this speaker say text now? '' yes, 'dup' (drop quietly) or 'slow'. Takes a token when yes. */
function allow(who, text, now) {
  let L = limits.get(who);
  if (!L) limits.set(who, (L = { tokens: BURST, t: now, times: [], last: '', lastT: -1e12, noT: -1e12 }));
  if (text === L.last && now - L.lastT < DUP_MS) return 'dup';
  L.tokens = Math.min(BURST, L.tokens + Math.max(0, now - L.t) / REFILL_MS);
  L.t = now;
  while (L.times.length && now - L.times[0] >= 60000) L.times.shift();
  if (L.tokens < 1 || L.times.length >= PER_MIN) return 'slow';
  L.tokens -= 1;
  L.times.push(now);
  L.last = text;
  L.lastT = now;
  return '';
}

/** A plain copy of a line (local transports hand the very object to the page: history stays ours). */
const copy = (line) => ({ ...line });

/** A line from a player (who = its record) or an observer (who = its observer record, admin). */
function post(room, conn, who, m, admin) {
  let text = '', q;
  if (m.q !== undefined && m.q !== null) {
    text = quickText(m.q);
    if (text) q = m.q;
  } else if (typeof m.text === 'string') text = cleanChat(m.text).text;
  if (!text) { room.send(conn, { t: 'chatno', why: 'empty' }); return; }
  const now = room.now();
  const why = allow(who, text, now);
  if (why === 'dup') return;
  if (why) {
    const L = limits.get(who);
    if (now - L.noT >= NO_MS) { L.noT = now; room.send(conn, { t: 'chatno', why }); }
    return;
  }
  const line = { id: who.id, name: admin ? 'Admin' : who.name, text, ts: now };
  if (q !== undefined) line.q = q;
  if (admin) line.admin = true;
  const H = room.chatLines;
  H.push(line);
  if (H.length > HISTORY) H.splice(0, H.length - HISTORY);
  room.broadcast({ t: 'chat', ...line });
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
