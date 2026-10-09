// What the current game mode wants from a bot (the rules come from the room: game.rules, the play
// area game.area, roles game.roleOf(id), the mode's own state game.modeState.g; see
// shared/modes/rules.js and the party games in shared/modes/games/).
//   battle royale: roam inside the area / storm and loot, as always
//   koth: hold the hill            infection: zombies chase the nearest survivor, survivors group up
//   hide & seek: seekers wait out the head start (eyes closed), then search like people: after
//     hiders they have seen or heard (the bot's own perception, Bot.perceive / hear), otherwise
//     through the likely hiding places (houses, bushes); hiders pick a hiding place of their own
//     (a house, a bush) away from the seekers and the other hiders, and stay put, crouched
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
  const g = bot.game;
  const r = g.roleOf ? g.roleOf(bot.id) : null;
  if (r) return r === 'zombie' || r === 'seeker';
  // no role (yet): Infection and Hide & Seek put the hunters on team 2. The room now sends the
  // first roles right after 'start'; this covers the moment in between (and old rooms).
  const k = modeKey(g);
  return (k === 'infection' || k === 'hideseek') && typeof g.teamOf === 'function' && g.teamOf(bot.id) === 2;
}

/**
 * A bot whose weapon is the pickaxe and who should go and use it: the hunters, the last rung of
 * Gun Game (and its kit-less moments), and Pickaxe Party (the loot pool has no guns). Without this
 * such bots wander off to 'find a gun' that does not exist and never fight.
 */
export function meleeOnly(bot) {
  if (isHunter(bot)) return true;
  const g = bot.game, r = g.rules;
  if (!r || passive(g) || g.phase === 'lobby' || bot.hasGun()) return false;
  if (modeKey(g) === 'hideseek') return false; // hiders hide
  return modeKey(g) === 'gungame' || r.loot === 'pickaxe';
}

/**
 * Hide & Seek: seconds left of the hiders' head start (ms.g.hs), 0 once the seekers are out (or in
 * any other mode). Before the room's first mode state arrives it counts as on.
 */
export function headStart(game) {
  if (modeKey(game) !== 'hideseek' || game.phase === 'lobby') return 0;
  const g = gstate(game);
  if (!g || typeof g.hs !== 'number') return 1;
  return g.hs > 0 ? g.hs : 0;
}

/** A seeker during the head start: eyes closed, standing still (the human seeker is blindfolded too). */
export const seekerWaits = (bot) => isHunter(bot) && headStart(bot.game) > 0;

/** A Hide & Seek hider. */
export const hider = (bot) => modeKey(bot.game) === 'hideseek' && !isHunter(bot);

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
    case 'gungame': return meleeOnly(bot) ? 25 : 0;
    case 'koth': {
      const h = hillOf(g);
      if (!h) return 0;
      const dx = a.pos.x - h.x, dz = a.pos.z - h.z;
      return dx * dx + dz * dz < (h.r + 4) * (h.r + 4) ? 25 : 0;
    }
    default: return meleeOnly(bot) ? 25 : 0; // (Pickaxe Party: commit to a target)
  }
}

const _list = [];
/** Drop the scratch list's actors (a finished Game must not stay reachable through it). */
export function forgetActors() { _list.length = 0; }
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
    case 'hideseek':
      if (isHunter(bot)) {
        // eyes closed while they hide: stay right here (and remember where we counted)
        if (headStart(g) > 0) {
          out.x = p.x; out.y = p.y; out.z = p.z;
          bot.brain.countX = p.x; bot.brain.countZ = p.z;
          return 'wait';
        }
        return seekGoal(bot, out);
      }
      return hideGoal(bot, out);
    case 'infection': {
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
  // respawn deathmatches (Team Rumble, FFA arenas): the fight is the point, so head roughly for
  // the nearest enemy when they are a long way off (on the 1.6 km island roaming bots rarely met:
  // 0 eliminations in Team Rumble's first 160 s)
  if (deathmatch(g)) {
    const t = nearest(bot, enemies(bot));
    if (t) {
      const dx = t.pos.x - p.x, dz = t.pos.z - p.z;
      if (dx * dx + dz * dz > 70 * 70) {
        const a = (bot.id * 2.39996) % (Math.PI * 2);
        out.x = t.pos.x + Math.cos(a) * 18; out.z = t.pos.z + Math.sin(a) * 18;
        out.y = g.world.data.heightAt(out.x, out.z);
        return 'hunt';
      }
    }
  }
  return '';
}

// ------------------------------------------------------------------ hide & seek
const _spots = new WeakMap(); // world data -> Map(area key -> hiding places)
const _searched = new WeakMap(); // game -> Map(hiding place -> time a seeker of this device looked there)
const SPOT_GAP = 4;           // m: hiding places closer than this count as one
const ROOM_GAP = 9;           // m: in one building, on one floor (one look round the room does)
const SEARCHED_S = 90;        // s before a seeker looks in the same place again
const FOUND_R = 4;            // m: at a last-seen spot with nobody in sight, they've moved on

/**
 * Places worth hiding in (and so worth searching) inside the play area: house floors (the indoor
 * loot spots of buildings with doors) and bushes. [{x, y, z, bush}] (bush: its scale, 0 indoors),
 * worked out once per world and area.
 */
export function hidingSpots(game, nav = null) {
  const data = game.world.data;
  const a = game.area || { x: 0, z: 0, r: data.islandRadius || (data.size || 640) * 0.42 };
  let m = _spots.get(data);
  if (!m) _spots.set(data, (m = new Map()));
  // (worked out again once the nav graph is ready: it knows which buildings can be walked into)
  const key = `${a.x}|${a.z}|${a.r}|${nav && nav.ready ? 1 : 0}`;
  let list = m.get(key);
  if (list) return list;
  const raw = [];
  for (const s of data.lootSpots || []) {
    if (s.ground || !inArea(game, s.x, s.z, 3)) continue;
    const room = nav && nav.ready ? nav.roomAt(s.x, s.z) : null;
    if (nav && nav.ready && !room) continue; // a building we can walk into
    raw.push({ x: s.x, y: s.y, z: s.z, bush: 0, room });
  }
  if (typeof data.objectsNear === 'function') {
    data.objectsNear(a.x, a.z, a.r, (o) => {
      if (o.kind === 'tree' && o.species === 'bush' && inArea(game, o.x, o.z, 3) && data.heightAt(o.x, o.z) > 1.2) raw.push({ x: o.x, y: o.y, z: o.z, bush: o.s || 1 });
      return false;
    });
  }
  list = [];
  const same = (q, s) => {
    const d2 = (q.x - s.x) ** 2 + (q.z - s.z) ** 2;
    if (q.room && q.room === s.room && Math.abs(q.y - s.y) < 2) return d2 < ROOM_GAP * ROOM_GAP;
    return d2 + (q.y - s.y) ** 2 < SPOT_GAP * SPOT_GAP;
  };
  for (const s of raw) if (!list.some((q) => same(q, s))) list.push(s);
  for (const s of list) delete s.room;
  if (m.size > 8) m.clear();
  m.set(key, list);
  return list;
}

/** Where the seekers are as far as hider `bot` knows: all of them during the head start (everyone
 * saw where they stood), afterwards the ones it has spotted. Calls fn(x, z). */
function knownSeekers(bot, fn) {
  const g = bot.game;
  if (headStart(g) > 0) {
    const each = (a) => { if (a && a !== bot && a.alive && bot.isEnemy(a)) fn(a.pos.x, a.pos.z); };
    if (g.me) each(g.me);
    for (const b of g.bots.values()) each(b);
    for (const r of g.remotes.values()) each(r);
    return;
  }
  for (const r of bot.brain.recs.values()) if (r.spotted && bot.time - r.seenT < bot.brain.memory) fn(r.x, r.z);
}

/** A hider's hiding place (kept for the rest of this life unless a seeker finds it). */
function hideGoal(bot, out) {
  const b = bot.brain;
  if (!b.hideSpot) b.hideSpot = pickHide(bot);
  const h = b.hideSpot;
  if (!h) return '';
  out.x = h.x; out.y = h.y; out.z = h.z;
  return 'hide';
}

/**
 * Choose where to hide: a house or a bush in reach (about what a head start's run covers), well
 * away from the seekers, not where another hider already is, and not one a seeker found us in.
 */
function pickHide(bot) {
  const g = bot.game, b = bot.brain, p = bot.pos;
  const spots = hidingSpots(g, bot.nav);
  if (!spots.length) return null;
  let sx = 0, sz = 0, n = 0;
  const seen = [];
  knownSeekers(bot, (x, z) => { sx += x; sz += z; n++; seen.push(x, z); });
  // where the other hiders went (spread out, don't pile into one house)
  const taken = [];
  const other = (a) => { const h = a !== bot && a.brain && a.brain.hideSpot; if (h) taken.push(h); };
  for (const a of g.bots.values()) other(a);
  let best = null, bs = Infinity;
  for (const s of spots) {
    if (b.badHide && b.badHide.has(s)) continue;
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d > 200) continue;
    let score = d * 0.6 + Math.random() * 45;
    for (let i = 0; i < seen.length; i += 2) {
      const ds = Math.hypot(s.x - seen[i], s.z - seen[i + 1]);
      if (ds < 70) score += (70 - ds) * 3;
    }
    for (const h of taken) if (Math.abs(h.x - s.x) < 10 && Math.abs(h.z - s.z) < 10) score += 60;
    if (score < bs) { bs = score; best = s; }
  }
  if (!best) return null;
  if (!best.bush) return { x: best.x, y: best.y, z: best.z, ref: best };
  // a bush: crouch on its far side from the seekers
  let ax = best.x - (n ? sx / n : p.x), az = best.z - (n ? sz / n : p.z);
  const l = Math.hypot(ax, az) || 1;
  ax /= l; az /= l;
  const off = 0.9 + 0.7 * best.bush;
  const o = { x: best.x + ax * off, z: best.z + az * off };
  const nav = bot.nav;
  if (nav && nav.ready) { const q = nav.nearestOpen(o.x, o.z, 3, o); if (!q) return { x: best.x, y: best.y, z: best.z, ref: best }; }
  return { x: o.x, y: g.world.data.heightAt(o.x, o.z), z: o.z, ref: best };
}

/** A hider spotted by a seeker close by: that place is no good any more (a new one after running). */
export function hideFound(bot) {
  const b = bot.brain;
  if (!b.hideSpot) return;
  if (b.hideSpot.ref) (b.badHide || (b.badHide = new Set())).add(b.hideSpot.ref);
  b.hideSpot = null;
  b.goalT = 0; // (a new goal as soon as we stop running, not back to the old place)
}

/**
 * A seeker after the head start: after someone it has seen (the last place it saw them) or heard,
 * else on to the next likely hiding place nobody searched lately, looking around at each.
 */
function seekGoal(bot, out) {
  const b = bot.brain, p = bot.pos, now = bot.time;
  let best = null, bs = Infinity;
  for (const r of b.recs.values()) {
    const a = r.actor;
    if (!a || !a.alive || !bot.isEnemy(a)) continue;
    let x, z, y, age;
    if (r.spotted && now - r.seenT < b.memory) { x = r.x; y = r.y; z = r.z; age = now - r.seenT; }
    else if (now - r.heardT < 6) { x = r.hx; y = r.hy; z = r.hz; age = now - r.heardT + 3; }
    else continue;
    const d = Math.hypot(x - p.x, z - p.z);
    // got there and nobody in sight: they have moved on
    if (d < FOUND_R && !r.vis && age > 1) { r.spotted = false; r.heardT = -99; continue; }
    const sc = d + age * 4;
    if (sc < bs) { bs = sc; best = r; out.x = x; out.y = y; out.z = z; }
  }
  if (best) return 'hunt';
  // a sound with no face (steps round a corner): go and look
  if (now - b.noiseT < 5 && Math.hypot(b.noiseX - p.x, b.noiseZ - p.z) > FOUND_R) {
    out.x = b.noiseX; out.y = b.noiseY; out.z = b.noiseZ;
    return 'hunt';
  }
  // searching: look around a moment at each place, then the next
  const cur = b.seekSpot, pt = b.seekPt;
  if (cur && pt && now < b.seekUntil) {
    const d = Math.hypot(pt.x - p.x, pt.z - p.z);
    if (d < (cur.bush ? 2 : FOUND_R) && Math.abs(pt.y - p.y) < 3) {
      if (!b.seekLook) b.seekLook = now + 1 + Math.random() * 2;
      if (now < b.seekLook) { out.x = p.x; out.y = p.y; out.z = p.z; return 'search'; }
    } else { out.x = pt.x; out.y = pt.y; out.z = pt.z; return 'search'; }
  }
  if (cur) searchedOf(bot).set(cur, now);
  const next = pickSearch(bot);
  b.seekSpot = next; b.seekLook = 0; b.seekUntil = now + 30;
  if (!next) { b.seekPt = null; return ''; }
  // a bush is searched from behind: round to its far side (where someone would crouch)
  const q = b.seekPt || (b.seekPt = { x: 0, y: 0, z: 0 });
  q.x = next.x; q.y = next.y; q.z = next.z;
  if (next.bush) {
    let ax = next.x - p.x, az = next.z - p.z;
    const l = Math.hypot(ax, az) || 1;
    ax /= l; az /= l;
    const off = 1 + 0.7 * next.bush;
    q.x = next.x + ax * off; q.z = next.z + az * off;
    const nav = bot.nav;
    if (nav && nav.ready && !nav.nearestOpen(q.x, q.z, 3, q)) { q.x = next.x; q.z = next.z; }
    q.y = bot.game.world.data.heightAt(q.x, q.z);
  }
  out.x = q.x; out.y = q.y; out.z = q.z;
  return 'search';
}

/**
 * Places the seekers this device runs have looked in lately (shared, like kids calling out 'not
 * in the barn!'), and when. Also brain.searched.
 */
function searchedOf(bot) {
  const g = bot.game;
  let m = _searched.get(g);
  if (!m) _searched.set(g, (m = new Map()));
  bot.brain.searched = m;
  return m;
}

/**
 * The next place to look: near, not searched lately, away from where the other seekers look, and
 * not right where we counted (they ran off from there while our eyes were shut).
 */
function pickSearch(bot) {
  const g = bot.game, b = bot.brain, p = bot.pos, now = bot.time;
  const cx = Number.isFinite(b.countX) ? b.countX : null, cz = b.countZ;
  const spots = hidingSpots(g, bot.nav);
  const done = searchedOf(bot);
  const others = [];
  for (const a of g.bots.values()) if (a !== bot && a.brain && a.brain.seekSpot) others.push(a.brain.seekSpot);
  let best = null, bs = Infinity;
  for (const s of spots) {
    const t = done.get(s);
    if (t !== undefined && Math.abs(now - t) < SEARCHED_S) continue;
    let score = Math.hypot(s.x - p.x, s.z - p.z) + Math.random() * 40;
    for (const o of others) if (Math.abs(o.x - s.x) < 25 && Math.abs(o.z - s.z) < 25) score += 50;
    if (cx !== null) { const dc = Math.hypot(s.x - cx, s.z - cz); if (dc < 60) score += (60 - dc) * 2; }
    if (score < bs) { bs = score; best = s; }
  }
  if (done.size > 600) done.clear();
  return best;
}

/** A respawn mode won by eliminations (or the most of them when time runs out). */
export function deathmatch(game) {
  const r = game.rules;
  return !!r && r.respawn > 0 && r.pvp !== false && (r.win === 'elims' || r.win === 'teamelims' || r.win === 'time' || r.win === 'gungame');
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
