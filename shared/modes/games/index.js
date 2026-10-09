// Every game, keyed by its rules.win value (the Game plugin API is in shared/modes/api.js).
import { CORE_GAMES } from './core.js';
import { PARTY_GAMES } from './party.js';

export const GAMES = { ...CORE_GAMES, ...PARTY_GAMES };
