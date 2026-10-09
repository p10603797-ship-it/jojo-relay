// Room plugin for build edits (door, window, arch, half wall, floor hole): the 'be' message.
// See shared/plugins/index.js for the plugin interface.
//
//   client -> room  { t: 'be', id, k, e }   id = the editing actor (you or a bot you own), k = piece key,
//                                           e = the tile mask to keep (an EDIT_PRESETS value)
//   room -> all     { t: 'be', k, e }       accepted: everyone applies it
//   room -> sender  { t: 'be', k, e }       refused: the piece's real mask, so an optimistic edit snaps back
//
// Build piece messages (b+ and the welcome's builds) carry e when a piece is edited, so late joiners
// see the same doors and windows. Support and collapse stay edge-based: an edit never drops a piece.
import { editInReach, editAllowed, editOf, EDIT_FULL } from '../buildgrid.js';

// (reach: editInReach, EDIT_RANGE m from the actor's chest to the piece's centre, the same rule the
// client checks before it offers EDIT)
const COOLDOWN = 100; // ms between two edits by the same actor (the client waits 0.16 s: network jitter room)
const lastEdit = new WeakMap(); // player record -> room time of its last accepted edit

/** May actor a (a room player record) edit piece b? Its builder, or a teammate during a match. */
function sameSide(room, a, b) {
  if (a.id === b.by) return true;
  if (room.phase === 'lobby') return false; // warm-up: everyone builds for themselves
  const owner = room.players.get(b.by);
  return !!owner && owner.team === a.team;
}

function refuse(room, c, b) {
  if (b && EDIT_FULL[b.t] !== undefined) room.send(c.conn, { t: 'be', k: b.k, e: editOf(b) });
}

export const edits = {
  name: 'edits',

  handlers: {
    be(c, m) {
      const room = this;
      const b = typeof m.k === 'string' ? room.grid.get(m.k) : null;
      const a = room.actor(c.conn.id, m.id);
      if (!b || !a || !a.alive || a.inBus || !(room.phase === 'lobby' || room.phase === 'match' || room.phase === 'bus')) { refuse(room, c, b); return; }
      if (!editAllowed(b.t, m.e) || !sameSide(room, a, b)) { refuse(room, c, b); return; }
      // Zero Build: no edits either (the warm-up lobby always builds)
      if (room.phase !== 'lobby' && room.rules && room.rules.build === 'off') { refuse(room, c, b); return; }
      if (!editInReach(b, a.x, a.y, a.z)) { refuse(room, c, b); return; }
      const now = room.now();
      const last = lastEdit.get(a);
      if (last !== undefined && now - last < COOLDOWN) { refuse(room, c, b); return; }
      lastEdit.set(a, now);
      if (m.e === EDIT_FULL[b.t]) delete b.e; else b.e = m.e;
      room.broadcast({ t: 'be', k: b.k, e: m.e });
    },
  },

  /** b+ and welcome builds replay edits. */
  pieceMsg(b) {
    return b.e !== undefined ? { e: b.e } : null;
  },
};
