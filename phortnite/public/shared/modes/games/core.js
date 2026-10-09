// Core games: last (last team standing), elims, teamelims, time. See shared/modes/api.js.
// In free for all every player is their own team, so 'last team standing' is 'last one standing'.
// A player counts as still in the game while alive or waiting to respawn.

const inGame = (p) => p.alive || p.respawnAt > 0;

/**
 * {team, reason} once at most one team is still in the game ({reason} alone if nobody is). A match
 * that only ever had one team (Playground on your own, friends with no bots) never ends this way.
 */
export function lastTeamStanding(ctx, reason = 'last') {
  let team = null, first = null, teams = 1;
  for (const p of ctx.players()) {
    if (first === null) first = p.team;
    else if (p.team !== first) teams = 2;
    if (!inGame(p)) continue;
    if (team === null) team = p.team;
    else if (p.team !== team) return null;
  }
  if (teams < 2) return null;
  return team === null ? { reason } : { team, reason };
}

const scorer = (key) => (ctx, victim, killer) => {
  if (killer && killer !== victim && killer.team !== victim.team) ctx.addScore(key(killer));
};

/** First to rules.target: per player (team = false) or per team. */
function race(teamGame, reason) {
  return (ctx) => {
    const top = ctx.scores()[0];
    if (top && ctx.rules.target > 0 && top[1] >= ctx.rules.target) return teamGame ? { team: top[0], reason } : { id: top[0], reason };
    // nobody left to race against
    return lastTeamStanding(ctx);
  };
}

export const CORE_GAMES = {
  last: {
    key: 'last', label: 'Battle Royale',
    checkWin: (ctx) => lastTeamStanding(ctx),
  },
  elims: {
    key: 'elims', label: 'Elimination Race',
    onKill: scorer((k) => k.id),
    checkWin: race(false, 'elims'),
  },
  teamelims: {
    key: 'teamelims', label: 'Team Elimination Race', teamGame: true,
    onKill: scorer((k) => k.team),
    checkWin: race(true, 'teamelims'),
  },
  time: {
    key: 'time', label: 'Most Elims Wins',
    // scores per team when there are teams (the time limit picks the top score)
    teamGame: (rules) => rules.teams !== 1,
    onKill(ctx, victim, killer) {
      if (!killer || killer === victim || killer.team === victim.team) return;
      ctx.addScore(ctx.rules.teams !== 1 ? killer.team : killer.id);
    },
    checkWin: (ctx) => lastTeamStanding(ctx),
  },
};
