// The Game plugin API: how a game (a win type, rules.win) plugs into the Room. Documentation only;
// shared/modes/runtime.js (ModeRuntime) implements ctx for the Room, test/helpers/fakectx.mjs
// (FakeCtx) implements it for tests. Games live in shared/modes/games/ (core.js: last, elims,
// teamelims, time; party.js: gungame, infection, koth, juggernaut, lava) and are collected in
// GAMES (shared/modes/games/index.js), keyed by their rules.win value.
//
// Everything runs inside the shared Room, so a game behaves the same in solo, on the Node
// server and in a P2P party. Games must be deterministic given ctx.rng() and ctx.now(): no
// Math.random, no Date.now, no DOM.
//
// Call order:
// - setup runs after teams and spawns are assigned and before the 'start' broadcast.
// - onKill runs after the elimination bookkeeping. A game may call ctx.respawn itself; otherwise
//   the core respawn rules apply.
// - checkWin runs after every kill and at 10 Hz.
// - A time limit (rules.timeLimit) ends any game, and the top score wins.
//
// How the Room plays it (shared/modes/runtime.js, shared/room.js):
// - Messages: setRole -> {t:'role', id, role}; giveLoadout -> {t:'lo', id, lo} to the device that
//   plays p (at setup they go into start.lo); setTeam -> a roster broadcast, and {t:'teams'} when
//   the team is new; hud(ctx) -> ms.g in {t:'ms', sc, goal, tl, g, rs} (at most 4 Hz, when changed).
// - An elimination with info.c 'left' (the player left the match) is never respawned.
// - lastTeamStanding (games/core.js) counts players waiting to respawn as still in, and a match that
//   only ever had one team never ends by it.
// - When every human is out (and none respawns) the Room ends a 'last' result as 'humans-out'
//   (win.id 0) instead of naming a bot.

/**
 * A game. Every hook is optional.
 * @typedef {object} Game
 * @property {string} key                 the rules.win value that selects it
 * @property {string} label               display name ('Gun Game')
 * @property {boolean|((rules: object) => boolean)} [teamGame]   scores are kept per team (score keys are
 *   team ids), not per player; a function of the rules decides per match (core 'time')
 * @property {object} [defaults]           rule deltas the game wants (applied under the mode's own rules)
 * @property {(ctx: Ctx) => void} [setup]  after teams and spawns are assigned, before the 'start' broadcast
 * @property {(ctx: Ctx, dt: number) => void} [tick]   10 Hz (dt in seconds)
 * @property {(ctx: Ctx, victim: Player, killer: Player|null, info: KillInfo) => void} [onKill]
 *   after the elimination bookkeeping; may call ctx.respawn(victim, …) itself, otherwise the core
 *   respawn rules (rules.respawn / rules.lives) apply
 * @property {(ctx: Ctx, attacker: Player|null, target: Player, info: HitInfo) => boolean} [allowDamage]
 *   false cancels the hit
 * @property {(ctx: Ctx, attacker: Player|null, target: Player, amount: number, info: HitInfo) => number} [scaleDamage]
 *   the damage to apply (after rules.dmg, target armor and oneShot)
 * @property {(ctx: Ctx, p: Player) => void} [onRespawn]   after p is back in the match
 * @property {(ctx: Ctx, p: Player) => (Loadout|null)} [loadout]   p's loadout at the start and on every respawn (null: the mode's usual one)
 * @property {(ctx: Ctx) => (WinResult|null)} [checkWin]   after every kill and at 10 Hz; non-null ends the match
 * @property {(ctx: Ctx) => object} [hud]  small JSON (at most 300 bytes) sent to clients as ms.g
 */

/**
 * What a game sees of the match.
 * @typedef {object} Ctx
 * @property {object} rules               normalized rules (shared/modes/rules.js)
 * @property {() => number} now           match clock in ms
 * @property {() => number} [endTime]     when the time limit runs out on the now() clock (ms, after a
 *   bus ride), 0 = no limit; known from the first tick (the Room sets it after setup)
 * @property {() => number} rng           deterministic random in [0, 1), seeded per match
 * @property {() => Player[]} players     everyone in the match, bots included
 * @property {() => Player[]} alive
 * @property {() => Player[]} humans
 * @property {() => Team[]} teams         [{id, name, color}]
 * @property {(key: number|string, n?: number) => void} addScore   n defaults to 1; key is a player id (or a team id when teamGame)
 * @property {(key: number|string) => number} score
 * @property {() => Array<[number|string, number]>} scores   [[key, n]], best first
 * @property {(p: Player, role: string|null) => void} setRole   broadcast as {t:'role', id, role}; null clears it
 * @property {(p: Player) => (string|null)} roleOf
 * @property {(p: Player, k: number) => void} setArmor   damage taken is multiplied by k (1 = normal)
 * @property {(p: Player, id: number) => void} setTeam
 * @property {(p: Player, lo: Loadout) => void} giveLoadout   replaces p's inventory now ({t:'lo', id, lo})
 * @property {(p: Player, delaySec: number, opts?: { keepLoot?: boolean }) => void} respawn
 *   bring an eliminated p back after delaySec ({t:'respawn', …}); keepLoot skips the loadout
 * @property {(p: Player, killer: Player|null, info?: KillInfo) => void} eliminate
 * @property {(p: Player, amount: number, info?: { c?: string, ignoreShield?: boolean }) => void} damage
 *   environmental damage with no attacker (lava, hazards); eliminates at 0 hp
 * @property {(result: WinResult) => void} end   ends the match now
 * @property {(msg: string) => void} note   a notice for everyone
 * @property {{ x: number, z: number, r: number }} area   the play area (rules.area resolved on this world)
 * @property {object} world   the world data (shared/worldgen.js contract)
 * @property {object} state   scratch space for the game, reset every match
 */

/**
 * A player record as the Room keeps it (read freely; change it through ctx).
 * @typedef {object} Player
 * @property {number} id
 * @property {string} name
 * @property {boolean} bot
 * @property {number} team
 * @property {boolean} alive
 * @property {number} hp
 * @property {number} sh
 * @property {number} kills
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {string|null} role
 * @property {number} armor   damage multiplier (1 = normal)
 * @property {number} lives   lives left (rules.lives 0 = unlimited)
 */

/**
 * @typedef {object} Loadout
 * @property {Array<{ k: string, r: number, m?: number }>} slots   at most 5 (weapon key, rarity 0-4, rounds in the magazine)
 * @property {Object<string, number>} ammo   {light: 60, …}
 * @property {{ wood: number, stone: number, metal: number }} mats
 * @property {boolean} [infAmmo]
 */

/** @typedef {{ team?: number, id?: number, reason: string }} WinResult  who won and why ('last', 'elims', 'time', …) */
/** @typedef {{ id: number, name: string, color: string }} Team */
/** @typedef {{ w?: string, c?: string, hs?: boolean }} KillInfo  weapon, cause ('gun', 'boom', 'storm', 'fall', 'left', …), headshot */
/** @typedef {{ w?: string, c?: string, hs?: boolean, x?: number, y?: number, z?: number }} HitInfo */

export {};
