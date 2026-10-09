// Game plugins: client features that hook into a Game session without editing game.js. The Game
// creates one of each (new P(game)) at the end of its constructor and drops them in dispose().
//
// Hook interface (every method is optional; hooks run in list order):
//   onMessage(m)          every room message, after the Game's own handler (also types the Game
//                         does not know)
//   filterInput(s)        the input state of this frame, right after input.update(); may change or
//                         blank it (e.g. while a menu covers the game)
//   update(dt)            at the end of every Game.update
//   hud(dt)               at the end of every Game.updateHud
//   onPhase(phase, m)     the phase changed: 'lobby' | 'bus' | 'match' | 'ended' (m = the message
//                         that changed it: welcome, start, s, lobby or win)
//   onMyDeath(m)          the local player was eliminated (m = the 'elim' message)
//   onJump(a)             an actor simulated here jumped
//   onLanded(a, speed)    an actor simulated here landed (impact speed in m/s)
//   dispose()             the Game is going away
// A hook that throws is logged and the game carries on.
import { PartyBridge } from '../lobby/bridge.js';
import { ModeClient } from './modeClient.js';
import { MapClient } from '../ui/mapclient.js';
import { BuildClient } from '../world/buildClient.js';

export const GAME_PLUGINS = [PartyBridge, ModeClient, MapClient, BuildClient];
