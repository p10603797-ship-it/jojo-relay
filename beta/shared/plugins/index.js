// Room plugins: features that hook into the shared Room (solo, Node server and P2P host alike)
// without editing room.js. A Room takes this list when it is created (new Room({ plugins }) can
// override it, e.g. in tests).
//
// Plugin interface (every member is optional; hooks run in list order):
//   name                       for logs
//   init(room)                 at the end of the Room constructor
//   handlers { t: fn(c, m) }   client messages, looked up before the Room's own handlers, called
//                              with this = room (c = { conn, pid, last }); room.baseHandlers holds
//                              the Room's own ones (e.g. room.baseHandlers.start.call(room, c, m))
//   onJoin(room, conn, hello)  after the version check, before the party-full check: return true
//                              or false when the plugin handled the join itself (join returns that),
//                              undefined to let the Room carry on
//   onLeave(room, connRec, player)  the connection is already gone from room.conns; return true
//                              when the plugin handled the leave (the player stays in the room)
//   roster(p)                  extra fields for p's roster row
//   welcome(room, id)          extra fields for the welcome message to player id
//   tick(room, now)            first thing in every room tick (20 Hz)
//   onStart(room)              after the 'start' broadcast (bots are assigned)
//   onLobby(room)              back in the lobby: players are reset, before the 'lobby' broadcast
//   onElim(room, victim, killer, info)  after the 'elim' broadcast and the siphon, before checkWin
//   pieceMsg(b)                extra fields for a build piece message (b+ and welcome builds)
// A hook that throws is logged ('plugin error') and the Room carries on.
import { party } from './party.js';
import { edits } from './edits.js';

export const ROOM_PLUGINS = [party, edits];
