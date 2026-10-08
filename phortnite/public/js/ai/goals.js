// What the current game mode wants from a bot (the rules come from the room: game.rules, the play
// area game.area, roles game.roleOf(id), the mode's own state game.modeState.g; see
// shared/modes/rules.js and the party games in shared/modes/games/).
//   battle royale: roam inside the area / storm and loot, as always
//   koth: hold the hill            infection: zombies chase the nearest survivor, survivors group up
//   juggernaut: hunt the Juggernaut  gun game: no looting (the ladder gives the guns)
//   floor is lava: climb away from the lava (or build up)    pvp off (Playground): wander, harvest, build
//   team modes: tag along with the nearest human teammate when there's nothing else to do
// Everything here is cheap and allocation-free on the hot paths (decide runs ~4 times a second).

/** The game mode's key ('br' unless the rules name a party game). */
export function modeKey(game) {
  const w = game.rules && game.rules.win;
  switch (w) {
    case 'koth': case 'infection': case 'gungame': case 'juggernaut': case 'lava': case 'hideseek': return w;
    default: return 'br';
  }
}

/** Players can't hurt each other (Playground). */
export const passive = (game) => !!game.rules && game.rules.pvp === false;

/** Building rule: 'on' | 'off' | 'infinite'. */
export const buildRule = (game) => (game.rules && game.rules.build) || 'on';

/** May this bot pick things up at all? (Gun game gives the guns; zombies only have their claws.) */
export function wantsLoot(bot) {
  const g = bot.game, k = modeKey(g);
  if (k === 'gungame') return false;
  if ((k === 'infection' || k === 'hideseek') && isHunter(bot)) return false;
  return true;
}

/** The infected / seekers: they hunt with their pickaxe. */
export function isHunter(bot) {
  const r = bot.game.roleOf ? bot.game.roleOf(bot.id) : null;
  return r === 'zombie' || r === 'seeker';
}

/** The play area {x, z, r} (null: the whole island). */
export const areaOf = (game) => game.area || null;

/** Is (x, z) inside the play area (with a margin)? */
export function inArea(game, x, z, margin = 0) {
  const a = game.area;
  if (!a) return true;
  const dx = x - a.x, dz = z - a.z, r = Math.max(5, a.r - margin);
  return dx * dx + dz * dz <= r * r;
}

/** The mode's live state from the room (ms.g: the game's hud(ctx) answer). */
const gstate = (game) => (game.modeState && game.modeState.g) || null;

/** King of the hill: {x, z, r} of the hill, or null. */
export function hillOf(game) {
  const g = gstate(game);
  return g && g.hill && Number.isFinite(g.hill.x) ? g.hill : null;
}

/** Floor is lava: the lava's height now, or null. */
export function lavaLevel(game) {
  const g = gstate(game);
  return g && Number.isFinite(g.lava) ? g.lava : null;
}

/** Juggernaut: the Juggernaut's id (0: none). */
export function juggId(game) {
  const g = gstate(game);
  if (g && g.j) return g.j | 0;
  if (game.roles) for (const [id, role] of game.roles) if (role === 'jugg') return id;
  return 0;
}

/**
 * How much more a bot wants to shoot at this enemy because of the mode (added to its target
 * score): the Juggernaut is everyone's target; zombies want survivors; in King of the Hill whoever
 * stands on the hill.
 */
export function targetBonus(bot, a) {
  const g = bot.game;
  switch (modeKey(g)) {
    case 'juggernaut': return a.id === juggId(g) ? 45 : 0;
    case 'infection': case 'hideseek': return isHunter(bot) ? 25 : 0;
    case 'koth': {
      const h = hillOf(g);
      if (!h) return 0;
      const dx = a.pos.x - h.x, dz = a.pos.z - h.z;
      return dx * dx + dz * dz < (h.r + 4) * (h.r + 4) ? 25 : 0;
    }
    default: return 0;
  }
}

const _list = [];
/** Living actors on the other side (as this bot sees teams), nearest first is not guaranteed. */
function enemies(bot) {
  _list.length = 0;
  const g = bot.game;
  if (g.me && g.me.alive && bot.isEnemy(g.me)) _list.push(g.me);
  for (const b of g.bots.values()) if (b !== bot && bot.isEnemy(b)) _list.push(b);
  for (const r of g.remotes.values()) if (bot.isEnemy(r)) _list.push(r);
  return _list;
}

function nearest(bot, list) {
  let best = null, bd = Infinity;
  for (const a of list) {
    const dx = a.pos.x - bot.pos.x, dz = a.pos.z - bot.pos.z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

/**
 * The mode's goal for an idle bot: sets out {x, y, z} and returns a destination kind
 * ('hill', 'hunt', 'group', 'high', 'follow'), or '' when the mode has nothing special.
 */
export function modeGoal(bot, out) {
  const g = bot.game, p = bot.pos;
  switch (modeKey(g)) {
    case 'koth': {
      const h = hillOf(g);
      if (!h) break;
      // somewhere on the hill, not all on the centre
      const a = (bot.id * 2.39996) % (Math.PI * 2), r = h.r * 0.45;
      out.x = h.x + Math.cos(a) * r; out.z = h.z + Math.sin(a) * r;
      out.y = g.world.data.heightAt(out.x, out.z);
      return 'hill';
    }
    case 'infection': case 'hideseek': {
      if (isHunter(bot)) {
        // the infected know roughly where the nearest survivor is
        const t = nearest(bot, enemies(bot));
        if (!t) break;
        out.x = t.pos.x; out.y = t.pos.y; out.z = t.pos.z;
        return 'hunt';
      }
      // survivors stick together: toward the middle of the other survivors
      let n = 0, sx = 0, sz = 0;
      const each = (a) => {
        if (a === bot || !a.alive || a.inBus || bot.isEnemy(a) || !g.friendly(a.id, bot.id)) return;
        sx += a.pos.x; sz += a.pos.z; n++;
      };
      if (g.me) each(g.me);
      for (const b of g.bots.values()) each(b);
      for (const r of g.remotes.values()) each(r);
      if (!n) break;
      sx /= n; sz /= n;
      if ((sx - p.x) ** 2 + (sz - p.z) ** 2 < 100) break;
      out.x = sx; out.z = sz; out.y = g.world.data.heightAt(sx, sz);
      return 'group';
    }
    case 'juggernaut': {
      const id = juggId(g);
      if (!id || id === bot.id) break;
      const j = g.actorById(id);
      if (!j || !j.alive) break;
      out.x = j.pos.x; out.y = j.pos.y; out.z = j.pos.z;
      return 'hunt';
    }
    case 'lava': {
      const lava = lavaLevel(g);
      const nav = bot.nav;
      if (lava === null || !nav || !nav.ready) break;
      // climb while the lava is within 8 m of our feet; the highest open ground in the area
      if (p.y - lava > 8) break;
      const a = g.area || { x: 0, z: 0, r: (g.world.data.islandRadius || g.world.data.size * 0.42) };
      const spots = nav.highSpots(a.x, a.z, a.r, 8);
      let best = null, bd = Infinity;
      for (const s of spots) {
        if (s.y < lava + 3) continue;
        const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2 - s.y * 40;
        if (d < bd) { bd = d; best = s; }
      }
      if (!best) break;
      out.x = best.x; out.y = best.y; out.z = best.z;
      return 'high';
    }
    default: break;
  }
  // team modes: tag along with a human teammate who is a little way off
  const mate = humanMate(bot);
  if (mate) {
    const dx = mate.pos.x - p.x, dz = mate.pos.z - p.z, d2 = dx * dx + dz * dz;
    if (d2 > 8 * 8 && d2 < 60 * 60) {
      out.x = mate.pos.x - dx * (6 / Math.sqrt(d2)); out.z = mate.pos.z - dz * (6 / Math.sqrt(d2)); out.y = mate.pos.y;
      return 'follow';
    }
  }
  return '';
}

/** The nearest human teammate within 25 m (60 m to catch up with), or null. */
export function humanMate(bot) {
  const g = bot.game;
  let best = null, bd = 60 * 60;
  const each = (a) => {
    if (!a || !a.alive || a.inBus || a.isBot || !g.friendly(a.id, bot.id)) return;
    const dx = a.pos.x - bot.pos.x, dz = a.pos.z - bot.pos.z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = a; }
  };
  if (g.me && g.me.id !== bot.id) each(g.me);
  for (const r of g.remotes.values()) each(r);
  return best;
}

/** Floor is lava: is the lava close under our feet (build up, get out)? */
export function lavaClose(bot) {
  const lava = lavaLevel(bot.game);
  return lava !== null && bot.pos.y - lava < 2.5;
}

/** A random open point inside the area (or the storm's next circle, or around us). out {x, y, z}. */
export function roamPoint(bot, out) {
  const g = bot.game, data = g.world.data, st = g.storm && g.storm.state, a = g.area;
  const nav = bot.nav;
  const IR = data.islandRadius || (data.size || 640) * 0.42;
  for (let tries = 0; tries < 12; tries++) {
    let x, z;
    if (st) {
      const r = st.nr * Math.sqrt(Math.random()) * 0.85, an = Math.random() * Math.PI * 2;
      x = st.ncx + Math.cos(an) * r; z = st.ncz + Math.sin(an) * r;
    } else if (a) {
      const r = a.r * Math.sqrt(Math.random()) * 0.85, an = Math.random() * Math.PI * 2;
      x = a.x + Math.cos(an) * r; z = a.z + Math.sin(an) * r;
    } else {
      const span = Math.min(160, IR * 0.5);
      x = bot.pos.x + (Math.random() - 0.5) * span * 2;
      z = bot.pos.z + (Math.random() - 0.5) * span * 2;
    }
    if (Math.hypot(x, z) > IR || data.heightAt(x, z) < 1.2) continue;
    if (nav && nav.ready) {
      const o = nav.nearestOpen(x, z, 12, out);
      if (!o) continue;
      x = o.x; z = o.z;
    }
    out.x = x; out.z = z; out.y = data.heightAt(x, z);
    return true;
  }
  return false;
}
