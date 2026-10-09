// The curated mode catalogue (Discover screen): entries shaped like CORE_MODES in
// shared/modes/index.js. An entry whose id is already a core mode is dropped there.
//
// rules are deltas from RULE_DEFAULTS (shared/modes/rules.js) and must already be normalized
// (each value one of its field's options, consistent: respawn needs lives, scores need targets).
// requires: the GAMES key (rules.win) a mode needs; Discover hides the mode while that game is
// missing from GAMES (see modeAvailable).
//
import { ruleField } from './rules.js';

// Categories: 'br' Battle Royale, 'team' Team Up, 'party' Party Games, 'mutators' Crazy Mutators,
// 'builders' Builders, 'practice' Practice, 'places' Places.

/** Team Rumble style: two big teams, sky drops, respawn in 5 s with your loot, first team to N. */
const RUMBLE = { teams: 'two', spawn: 'sky', respawn: 5, lives: 0, respawnKeep: true, win: 'teamelims', storm: 'slow', rarity: 'boosted', bots: 15 };
/** Respawn arena: ground spawns, back in 3 s, unlimited lives. */
const ARENA = { spawn: 'ground', respawn: 3, lives: 0 };
/** Build fights: start on the ground with a loadout and 500 of each material in a moving zone. */
const BUILDFIGHT = { spawn: 'ground', loadout: 'buildfight', mats: 500, storm: 'zonewars', area: 'random' };

export const CATALOG = [
  // ------------------------------------------------------------------ Battle Royale
  {
    id: 'trios', name: 'Trios', emoji: '🔺', color: '#ff8a00', cat: 'br', players: '1-16', tags: ['Battle Royale', 'Trios'],
    desc: 'Battle Royale in teams of three. Bots fill the empty spots.',
    rules: { teams: 3 },
  },
  {
    id: 'squads', name: 'Squads', emoji: '🛡️', color: '#3ea4ff', cat: 'br', players: '1-16', tags: ['Battle Royale', 'Squads'],
    desc: 'Battle Royale in teams of four. Stick together!',
    rules: { teams: 4 },
  },
  {
    id: 'zb-solo', name: 'Zero Build Solo', emoji: '🚫', color: '#2fd6c3', cat: 'br', players: '1-16', tags: ['Battle Royale', 'No Build'],
    desc: 'No building at all: just loot, sneak and shoot. Extra heals help you stay in the fight.',
    rules: { build: 'off', heals: 'extra' },
  },
  {
    id: 'zb-duos', name: 'Zero Build Duos', emoji: '🙅', color: '#28b5a6', cat: 'br', players: '1-16', tags: ['Duos', 'No Build'],
    desc: 'Zero Build with a buddy. Use cover, not walls!',
    rules: { teams: 2, build: 'off', heals: 'extra' },
  },
  {
    id: 'zb-squads', name: 'Zero Build Squads', emoji: '🧱', color: '#1f8f84', cat: 'br', players: '1-16', tags: ['Squads', 'No Build'],
    desc: 'Four friends, no building, lots of heals.',
    rules: { teams: 4, build: 'off', heals: 'extra' },
  },
  {
    id: 'builder-pro', name: 'Builder Pro', emoji: '🏗️', color: '#d8995a', cat: 'br', players: '1-16', tags: ['Battle Royale', '500 Mats'],
    desc: 'Start with 500 of every material and harvest twice as fast. Build huge!',
    rules: { mats: 500, harvest: 2 },
  },
  {
    id: 'big-battle', name: 'Big Battle 32', emoji: '🌍', color: '#ff4d4d', cat: 'br', players: '1-16', tags: ['Battle Royale', '32 Players'],
    desc: 'The biggest match: 32 players fight for the crown.',
    rules: { maxPlayers: 32, bots: 31 },
  },
  {
    id: 'rapid', name: 'Rapid Royale', emoji: '⚡', color: '#ffd23f', cat: 'br', players: '1-16', tags: ['Battle Royale', 'Fast Storm'],
    desc: 'A quick game in the middle of the island with a fast storm and better loot.',
    rules: { storm: 'fast', area: 'center', rarity: 'boosted' },
  },
  {
    id: 'golden', name: 'Golden Royale', emoji: '🏆', color: '#ffb22e', cat: 'br', players: '1-16', tags: ['Battle Royale', 'Legendary Loot'],
    desc: 'Every gun on the island is legendary gold!',
    rules: { rarity: 'legendary' },
  },
  {
    id: 'late-game', name: 'Late Game', emoji: '🌀', color: '#bd52ff', cat: 'br', players: '1-16', tags: ['Final Circle', 'Loadout'],
    desc: 'Skip straight to the last circles: sky drop with a gun and 500 materials.',
    rules: { storm: 'final', loadout: 'pool', mats: 500, spawn: 'sky' },
  },
  {
    id: 'bootcamp', name: 'Bot Bootcamp', emoji: '🐣', color: '#8fe36b', cat: 'br', players: '1-16', tags: ['Easy Bots', 'Slow Storm'],
    desc: 'Gentle bots, a slow storm and extra heals. Perfect for learning!',
    rules: { botSkill: 'easy', storm: 'slow', heals: 'extra' },
  },
  {
    id: 'sweaty-bots', name: 'Sweaty Bots', emoji: '😤', color: '#c2185b', cat: 'br', players: '1-16', tags: ['Hard Bots'],
    desc: 'The bots are good now. Really good. Can you still win?',
    rules: { botSkill: 'hard', bots: 23 },
  },

  // ------------------------------------------------------------------ Team Up
  {
    id: 'team-rumble', name: 'Team Rumble', emoji: '⚔️', color: '#ff4d4d', cat: 'team', players: '1-16', requires: 'teamelims',
    tags: ['2 Teams', 'Respawn', 'First to 50'],
    desc: 'Two big teams, respawn in 5 seconds and keep your loot. First team to 50 eliminations wins!',
    rules: { ...RUMBLE, target: 50 },
  },
  {
    id: 'zb-rumble', name: 'Zero Build Rumble', emoji: '🤜', color: '#e53935', cat: 'team', players: '1-16', requires: 'teamelims',
    tags: ['2 Teams', 'No Build', 'Respawn'],
    desc: 'Team Rumble without building. Run, hide behind cover and shoot!',
    rules: { ...RUMBLE, target: 50, build: 'off' },
  },
  {
    id: 'duos-rumble', name: 'Duos Rumble', emoji: '👊', color: '#ff7043', cat: 'team', players: '1-16', requires: 'teamelims',
    tags: ['Duos', 'Respawn', 'First to 30'],
    desc: 'Lots of little teams of two. First pair to 30 eliminations wins.',
    rules: { ...RUMBLE, teams: 2, target: 30 },
  },
  {
    id: 'squads-rumble', name: 'Squads Rumble', emoji: '🦺', color: '#5c6bc0', cat: 'team', players: '1-16', requires: 'teamelims',
    tags: ['Squads', 'Respawn', 'First to 50'],
    desc: 'Four teams of four with respawns. First squad to 50 wins!',
    rules: { ...RUMBLE, teams: 4, target: 50 },
  },
  {
    id: 'ffa-frenzy', name: 'Free-for-All Frenzy', emoji: '🔥', color: '#ff6f00', cat: 'team', players: '1-16', requires: 'elims',
    tags: ['Solo', 'Respawn', 'First to 15'],
    desc: 'Everyone against everyone, respawn in 3 seconds. First to 15 eliminations wins!',
    rules: { ...ARENA, win: 'elims', target: 15, timeLimit: 600, loadout: 'pool' },
  },
  {
    id: 'trios-showdown', name: 'Trios Showdown', emoji: '⏱️', color: '#26a69a', cat: 'team', players: '1-16', requires: 'time',
    tags: ['Trios', 'Respawn', '7 Minutes'],
    desc: 'Teams of three, respawns on. The team with the most eliminations after 7 minutes wins.',
    rules: { ...ARENA, teams: 3, win: 'time', timeLimit: 420, storm: 'none', area: 'center', loadout: 'pool' },
  },

  // ------------------------------------------------------------------ Party Games
  {
    id: 'gun-game', name: 'Gun Game', emoji: '🔫', color: '#ff3d8b', cat: 'party', players: '1-16', requires: 'gungame',
    tags: ['Gun Ladder', 'Respawn'],
    desc: 'Every elimination gives you the next gun: rocket, sniper, pump … all the way to the pickaxe. A pickaxe elimination wins!',
    rules: { win: 'gungame', ...ARENA, storm: 'none', area: 'center', timeLimit: 600, floorLoot: false, chests: false, ammo: 'infinite', mats: 100, bots: 11 },
  },
  {
    id: 'infection', name: 'Infection', emoji: '🧟', color: '#5ad13a', cat: 'party', players: '1-16', requires: 'infection',
    tags: ['Zombies', 'Survive 5 min'],
    desc: 'A few players start as green zombies with pickaxes. Every survivor they get becomes a zombie too. Survive for 5 minutes!',
    rules: { win: 'infection', teams: 'two', ...ARENA, storm: 'none', area: 'center', timeLimit: 300, loadout: 'pool', bots: 11 },
  },
  {
    id: 'koth', name: 'King of the Hill', emoji: '👑', color: '#ffd23f', cat: 'party', players: '1-16', requires: 'koth',
    tags: ['2 Teams', 'Hold the Hill'],
    desc: 'Stand in the glowing hill to score. Only one team inside? It scores! First to 100 wins. The hill moves every 75 seconds.',
    rules: { win: 'koth', target: 100, teams: 'two', spawn: 'ground', respawn: 5, lives: 0, storm: 'none', area: 'center', timeLimit: 600, loadout: 'pool', bots: 11 },
  },
  {
    id: 'juggernaut', name: 'Juggernaut', emoji: '🦾', color: '#d32f2f', cat: 'party', players: '1-16', requires: 'juggernaut',
    tags: ['Big Boss', 'Respawn'],
    desc: 'One player is the huge, tough Juggernaut with a gold rocket launcher. Take them down to become the Juggernaut! 100 points wins.',
    rules: { win: 'juggernaut', target: 100, ...ARENA, storm: 'none', area: 'center', timeLimit: 600, loadout: 'pool', bots: 9 },
  },
  {
    id: 'floor-is-lava', name: 'Floor is Lava', emoji: '🌋', color: '#ff5722', cat: 'party', players: '1-16', requires: 'lava',
    tags: ['Rising Lava', 'Build Up'],
    desc: 'The lava keeps rising! Build up, climb hills and be the last one standing.',
    rules: { win: 'lava', spawn: 'ground', storm: 'none', mats: 500, harvest: 2, timeLimit: 300, area: 'center', bots: 11 },
  },
  {
    id: 'one-shot', name: 'One Shot', emoji: '🎯', color: '#7e57c2', cat: 'party', players: '1-16', tags: ['Snipers only', 'Low Gravity', '50 HP'],
    desc: 'Snipers only, floaty low gravity and just 50 health. One good shot wins the fight!',
    rules: { loot: 'snipers', gravity: 0.35, hp: 50, shield: 0 },
  },
  {
    id: 'pickaxe-party', name: 'Pickaxe Party', emoji: '⛏️', color: '#a1887f', cat: 'party', players: '1-16', tags: ['Pickaxes only'],
    desc: 'No guns, no loot: only pickaxes in a small, fast circle. Bonk!',
    rules: { loot: 'pickaxe', loadout: 'pickaxe', floorLoot: false, chests: false, spawn: 'ground', storm: 'fast', area: 'center', bots: 11 },
  },
  {
    id: 'rocket-rumble', name: 'Rocket Rumble', emoji: '🚀', color: '#9ccc3c', cat: 'party', players: '1-16', requires: 'elims',
    tags: ['Rockets only', 'Infinite Ammo', 'Respawn'],
    desc: 'Rocket launchers with infinite ammo for everyone. First to 15 eliminations wins!',
    rules: { loot: 'rockets', ammo: 'infinite', ...ARENA, win: 'elims', target: 15, loadout: 'pool', storm: 'slow' },
  },
  {
    id: 'sniper-showdown', name: 'Sniper Showdown', emoji: '🔭', color: '#4fc3f7', cat: 'party', players: '1-16', requires: 'elims',
    tags: ['Snipers only', 'Respawn', 'First to 10'],
    desc: 'Snipers with infinite ammo and respawns. First to 10 eliminations wins.',
    rules: { loot: 'snipers', ammo: 'infinite', ...ARENA, win: 'elims', target: 10, loadout: 'pool', storm: 'none', timeLimit: 600 },
  },
  {
    id: 'shotgun-shuffle', name: 'Shotgun Shuffle', emoji: '💥', color: '#ff5c8a', cat: 'party', players: '1-16', tags: ['Shotguns only', 'Fast Storm'],
    desc: 'Pumps and tactical shotguns only, in a quick close-up circle.',
    rules: { loot: 'shotguns', storm: 'fast', area: 'center' },
  },
  {
    id: 'pistol-pals', name: 'Pistol Pals', emoji: '🤠', color: '#64b5f6', cat: 'party', players: '1-16', tags: ['Duos', 'Pistols only'],
    desc: 'Teams of two with pistols only. Yee-haw!',
    rules: { loot: 'pistols', teams: 2 },
  },
  {
    id: 'smg-spray', name: 'SMG Spray', emoji: '🌪️', color: '#26c6da', cat: 'party', players: '1-16', tags: ['SMGs only', 'Extra Heals'],
    desc: 'Rapid SMGs only, extra heals and better loot. Spray away!',
    rules: { loot: 'smgs', heals: 'extra', rarity: 'boosted' },
  },
  {
    id: 'boom-town', name: 'Boom Town', emoji: '💣', color: '#ff7a5c', cat: 'party', players: '1-16', tags: ['Explosives', 'Respawn', '3 Lives'],
    desc: 'Only things that go boom, and you get three lives.',
    rules: { loot: 'explosive', ...ARENA, lives: 3, rarity: 'boosted' },
  },

  // ------------------------------------------------------------------ Crazy Mutators
  {
    id: 'moon', name: 'Moon Mode', emoji: '🌙', color: '#90a4ae', cat: 'mutators', players: '1-16', tags: ['Low Gravity', 'High Jump'],
    desc: 'Low gravity and big floaty jumps. Bullets drop less too!',
    rules: { gravity: 0.35, jump: 1.5 },
  },
  {
    id: 'big-head', name: 'Big Head Mode', emoji: '🎃', color: '#ffb74d', cat: 'mutators', players: '1-16', tags: ['Big Heads'],
    desc: 'Everyone has a giant head. Easier headshots, funnier faces!',
    rules: { bigHead: true },
  },
  {
    id: 'speed-demons', name: 'Speed Demons', emoji: '🏎️', color: '#f44336', cat: 'mutators', players: '1-16', tags: ['Super Speed'],
    desc: 'Everyone runs one and a half times faster. Zoom!',
    rules: { speed: 1.5 },
  },
  {
    id: 'tank-battle', name: 'Tank Battle', emoji: '🪖', color: '#6d8f3a', cat: 'mutators', players: '1-16', tags: ['Half Damage'],
    desc: 'Everyone is twice as tough. Long, epic fights!',
    rules: { dmg: 0.5 },
  },
  {
    id: 'glass-cannon', name: 'Glass Cannon', emoji: '🔮', color: '#e040fb', cat: 'mutators', players: '1-16', tags: ['Double Damage'],
    desc: 'Every gun does double damage. Be quick or be gone!',
    rules: { dmg: 2 },
  },
  {
    id: 'vampire', name: 'Vampire', emoji: '🧛', color: '#8e24aa', cat: 'mutators', players: '1-16', tags: ['Big Siphon', 'No Heals'],
    desc: 'No heals anywhere. The only way to heal is to eliminate someone (+100)!',
    rules: { siphon: 100, heals: 'none' },
  },
  {
    id: 'headhunters', name: 'Headhunters', emoji: '🤯', color: '#ffca28', cat: 'mutators', players: '1-16', tags: ['Headshots Only'],
    desc: 'Only headshots do damage. Aim high!',
    rules: { headOnly: true },
  },
  {
    id: 'bouncy', name: 'Bouncy Castle', emoji: '🦘', color: '#ff80ab', cat: 'mutators', players: '1-16', tags: ['High Jump', 'No Fall Damage'],
    desc: 'Super jumps and no fall damage. Boing boing!',
    rules: { jump: 2, fallDamage: false },
  },
  {
    id: 'mystery', name: 'Mystery Mutators', emoji: '❓', color: '#7c4dff', cat: 'mutators', players: '1-16', tags: ['Mystery Mutators'],
    desc: 'Every minute something crazy changes: low gravity, big heads, super speed …',
    rules: { mystery: true },
  },
  {
    id: 'one-hit', name: 'One Hit Wonder', emoji: '☝️', color: '#ef5350', cat: 'mutators', players: '1-16', tags: ['One Shot'],
    desc: 'Any hit eliminates. Shields will not save you now!',
    rules: { oneShot: true },
  },
  {
    id: 'slow-mo', name: 'Slow Motion', emoji: '🐢', color: '#4db6ac', cat: 'mutators', players: '1-16', tags: ['Slow Motion', 'Low Gravity'],
    desc: 'Everything moves in slow motion, like in the movies.',
    rules: { speed: 0.8, gravity: 0.5 },
  },
  {
    id: 'heavy', name: 'Super Heavy', emoji: '🪨', color: '#795548', cat: 'mutators', players: '1-16', tags: ['Heavy Gravity'],
    desc: 'Gravity is extra strong. Jumps are short, falls are fast!',
    rules: { gravity: 1.5 },
  },

  // ------------------------------------------------------------------ Builders
  {
    id: 'build-battle', name: 'Build Battle 1v1', emoji: '🥊', color: '#3949ab', cat: 'builders', players: '1-2', tags: ['1v1', 'Best of 5'],
    desc: 'One against one with a pump, an AR and 500 materials. Best of five rounds!',
    rules: { ...BUILDFIGHT, maxPlayers: 2, bots: 1, rounds: 5 },
  },
  {
    id: 'box-fight', name: 'Box Fight 2v2', emoji: '📦', color: '#5e35b1', cat: 'builders', players: '1-4', tags: ['2v2', 'Best of 3'],
    desc: 'Two teams of two box up and fight it out. Best of three rounds.',
    rules: { ...BUILDFIGHT, teams: 2, maxPlayers: 4, bots: 3, rounds: 3 },
  },
  {
    id: 'zone-wars', name: 'Zone Wars', emoji: '🌀', color: '#7b1fa2', cat: 'builders', players: '1-8', tags: ['Moving Zone', 'Best of 3'],
    desc: 'Fast moving storm circles: build and rotate to stay inside. Best of three.',
    rules: { storm: 'zonewars', loadout: 'zonewars', rounds: 3, spawn: 'ground', mats: 500, area: 'random', maxPlayers: 8, bots: 7 },
  },
  {
    id: 'infinite-build', name: 'Infinite Build Royale', emoji: '♾️', color: '#29b6f6', cat: 'builders', players: '1-16', tags: ['Infinite Build'],
    desc: 'Battle Royale with endless materials. Build the biggest fort ever!',
    rules: { build: 'infinite' },
  },
  {
    id: 'harvest-heroes', name: 'Harvest Heroes', emoji: '🪓', color: '#8d6e63', cat: 'builders', players: '1-16', tags: ['Triple Harvest', '200 Mats'],
    desc: 'Start with 200 of each material and harvest three times as fast.',
    rules: { mats: 200, harvest: 3, heals: 'extra' },
  },

  // ------------------------------------------------------------------ Practice
  {
    id: 'target-practice', name: 'Target Practice', emoji: '🎳', color: '#66bb6a', cat: 'practice', players: '1-16', requires: 'elims',
    tags: ['Easy Bots', 'Respawn', 'Infinite Ammo'],
    desc: 'Practise your aim on easy bots. You come back after 3 seconds; 30 eliminations wins.',
    rules: { botSkill: 'easy', ...ARENA, win: 'elims', target: 30, storm: 'none', timeLimit: 600, loadout: 'pool', ammo: 'infinite' },
  },
  {
    id: 'build-practice', name: 'Build Practice', emoji: '🧰', color: '#42a5f5', cat: 'practice', players: '1-16', tags: ['No Damage', 'Infinite Build'],
    desc: 'No storm, no damage and infinite materials: practise ramps, walls and boxes with friends.',
    rules: { pvp: false, bots: 0, ...ARENA, storm: 'none', build: 'infinite', loadout: 'buildfight' },
  },
  {
    id: 'aim-trainer', name: 'Aim Trainer', emoji: '🏹', color: '#9ccc65', cat: 'practice', players: '1-16', tags: ['Easy Bots', 'Big Heads'],
    desc: 'Lots of easy bots with big heads and extra heals. Practise those headshots!',
    rules: { botSkill: 'easy', bots: 27, bigHead: true, heals: 'extra', storm: 'slow' },
  },

  // ------------------------------------------------------------------ Places
  {
    id: 'volcano-zone-wars', name: 'Volcano Zone Wars', emoji: '🌋', color: '#e64a19', cat: 'places', players: '1-8', tags: ['Volcano', 'Moving Zone'],
    desc: 'Zone Wars on the smoking volcano. Do not fall in the lava!',
    rules: { storm: 'zonewars', loadout: 'zonewars', rounds: 3, spawn: 'ground', mats: 500, area: 'biome:volcano', maxPlayers: 8, bots: 7 },
  },
  {
    id: 'city-rumble', name: 'City Rumble', emoji: '🏙️', color: '#607d8b', cat: 'places', players: '1-16', requires: 'teamelims',
    tags: ['Tilty Towers', '2 Teams', 'Respawn'],
    desc: 'Team Rumble between the skyscrapers of Tilty Towers. First team to 30!',
    rules: { ...RUMBLE, target: 30, area: 'poi:Tilty Towers' },
  },
  {
    id: 'snowball-snipers', name: 'Snowball Snipers', emoji: '❄️', color: '#81d4fa', cat: 'places', players: '1-16', tags: ['Snow', 'Snipers only'],
    desc: 'Snipers only on the snowy mountains. Find a high peak!',
    rules: { area: 'biome:snow', loot: 'snipers', spawn: 'sky' },
  },
  {
    id: 'desert-duos', name: 'Desert Duos', emoji: '🌵', color: '#e0a35a', cat: 'places', players: '1-16', tags: ['Desert', 'Duos'],
    desc: 'Duos among the cactuses and red mesas of the desert.',
    rules: { teams: 2, area: 'biome:desert' },
  },
  {
    id: 'jungle-rumble', name: 'Jungle Rumble', emoji: '🌴', color: '#2e7d32', cat: 'places', players: '1-16', requires: 'teamelims',
    tags: ['Jungle', '2 Teams', 'Respawn'],
    desc: 'Two teams fight through the jungle and the swamp. First to 30!',
    rules: { ...RUMBLE, target: 30, area: 'biome:jungle' },
  },
  {
    id: 'castle-siege', name: 'Castle Siege', emoji: '🏰', color: '#9e9e9e', cat: 'places', players: '1-16', requires: 'koth',
    tags: ['Castle Phortress', 'Hold the Hill'],
    desc: 'King of the Hill at Castle Phortress. Storm the walls and hold the courtyard!',
    rules: { win: 'koth', target: 100, teams: 'two', spawn: 'ground', respawn: 5, lives: 0, storm: 'none', area: 'poi:Castle Phortress', timeLimit: 600, loadout: 'pool', bots: 11 },
  },
  {
    id: 'farm-frenzy', name: 'Farm Frenzy', emoji: '🚜', color: '#c0ca33', cat: 'places', players: '1-16', requires: 'elims',
    tags: ['Farm', 'Respawn', 'First to 15'],
    desc: 'Everyone for themselves in the wheat fields and barns. First to 15!',
    rules: { ...ARENA, win: 'elims', target: 15, timeLimit: 600, loadout: 'pool', area: 'biome:farm' },
  },
  {
    id: 'pirate-party', name: 'Pirate Gun Game', emoji: '🏴‍☠️', color: '#6d4c41', cat: 'places', players: '1-16', requires: 'gungame',
    tags: ['Pirate Cove', 'Gun Ladder'],
    desc: 'Gun Game around the pirate ship at Pirate Cove. Arr!',
    rules: { win: 'gungame', ...ARENA, storm: 'none', area: 'poi:Pirate Cove', timeLimit: 600, floorLoot: false, chests: false, ammo: 'infinite', mats: 100, bots: 9 },
  },
];

// Hide & Seek joins the Party Games as soon as 'hideseek' is a win option in rules.js
// (option lists are append-only, so it is added at the end there).
if (ruleField('win').options.includes('hideseek')) {
  CATALOG.splice(CATALOG.findIndex((m) => m.id === 'one-shot'), 0, {
    id: 'hide-and-seek', name: 'Hide & Seek', emoji: '🙈', color: '#ff9a1c', cat: 'party', players: '2-16', requires: 'hideseek',
    tags: ['Seekers', 'Hide!'],
    desc: 'The seekers count to 30 while everyone hides. One tap of a seeker\'s pickaxe finds you, and then you seek too!',
    rules: { win: 'hideseek', teams: 'two', ...ARENA, storm: 'none', timeLimit: 300, area: 'center', loadout: 'pickaxe', floorLoot: false, chests: false, build: 'off', bots: 7 },
  });
}

/** Can this mode be played with these games (GAMES, or an array of its keys)? */
export function modeAvailable(mode, games) {
  if (!mode || !mode.requires) return true;
  if (Array.isArray(games)) return games.includes(mode.requires);
  return !!games && Object.prototype.hasOwnProperty.call(games, mode.requires);
}
