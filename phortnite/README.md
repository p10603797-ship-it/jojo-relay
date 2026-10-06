# PHORTNITE

A 3D battle royale that runs in the browser — made for iPad (touch controls) and computers
(keyboard/mouse or a game controller), with multiplayer for friends, straight from a website.

Drop out of a flying bus, loot weapons, harvest materials, build walls/floors/ramps and be the
last one standing to win a **Phictory Royale**.

## Play on the website (no computer needed)

Phortnite is a plain static website, so it runs straight from **GitHub Pages**:

**https://p10603797-ship-it.github.io/jojo-relay/**

The website is published from the **`gh-pages`** branch, which holds a copy of the `public/`
folder at its root. To update the website, copy `phortnite/public/` onto the `gh-pages` branch
and push; GitHub rebuilds the site within a minute or two.

* **Play Solo**: you against up to 30 bots. Everything runs on your iPad.
* **Play with Friends**: one player taps **Host a party** and gets a 4-letter code plus a QR
  code. Everyone else taps **Play with Friends**, types the code (or scans the QR code with the
  iPad camera) and joins. While waiting you can warm up on the island. The host picks the mode
  (*Everyone for themselves* or *Friends team up vs bots*, with no friendly fire and the whole
  squad winning together), plus the number of bots and starting materials, then hits
  **Start match**.

Parties are peer-to-peer: the match runs on the **host's** device and the others connect to it
directly over WebRTC (the free [PeerJS](https://peerjs.com) service only introduces the devices
to each other, and relays traffic if a direct link isn't possible). The host must keep the game
open; if they leave, the party ends. It works best when everyone is on the same Wi-Fi, but
friends elsewhere can join too.

Tip for iPad: in Safari tap *Share → Add to Home Screen* and launch Phortnite from the home
screen for a true full-screen game.

## Run your own server (optional)

You can also run Phortnite on a computer, for example to play on a Wi-Fi with no internet. You
need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd phortnite
npm install
npm start
```

The server prints something like:

```
  On this computer:      http://localhost:8080/
  On your Wi-Fi (iPads):  http://192.168.1.23:8080/
```

plus a QR code. Open the Wi-Fi address on every iPad / laptop on the same network (or scan the
QR code with the iPad camera). In this mode the server runs the matches, so nobody has to host:
**Play with Friends** lists the parties on the server (parties from your own Wi-Fi are marked
*SAME WI-FI*), or join one by typing its 4-letter code. The server serves the 3D and physics
libraries itself, so it needs no internet.

If Windows asks about the firewall the first time, allow Node.js on *private* networks,
otherwise the iPads can't reach the server.

`PORT=3000 npm start` changes the port. `npm test` runs the game-logic tests.

## What's in it

* **Real 3D world** — a 640 m procedurally generated island (always the same island, like the
  real thing) with six named towns, ~46 enterable houses, a container yard, a mountain, beaches,
  dirt roads, ~650 trees, rocks, cars, crates, barrels and loot chests.
* **Textures** — every texture (grass, sand, rock, dirt, planks, brick, metal, siding, roof
  shingles, concrete, bark, leaves) is painted procedurally at load time with matching normal
  maps, blended on the terrain with a custom splat shader. Stylised sky with clouds, image-based
  lighting, a depth-coloured ocean with foam, wind-animated grass and real-time shadows.
* **Physics** ([Rapier](https://rapier.rs), WASM) — character controller with slopes/steps,
  skydiving + glider, swimming, fall damage, ragdolls on elimination, tumbling debris when
  structures break, falling trees, explosions that push barrels and rubble around.
* **Shooting** — every bullet is a projectile with its own speed and gravity drop (aim high with
  the sniper!), spread/bloom, first-shot accuracy, per-gun recoil that recovers after you stop
  firing, damage falloff, headshots, shotgun pellets, rockets with splash damage, bullet holes,
  tracers, impact effects per material.
* **Weapons** — assault rifle, burst rifle, SMG, pump and tactical shotguns, bolt sniper, pistol,
  rocket launcher in five rarities, each with its own fire rate, reload time and kick, plus
  bandages, med kits and shield potions.
* **Health & shield** — everyone drops in with 100 health and 100 shield; every elimination
  gives the winner of the fight 50 back (health first, then shield, up to 200).
* **Aim help (Settings)** — *Aim assist* for touch and controllers (aim slows near enemies, gently
  follows them while aiming, and snaps a little when you aim down sights), and *Auto-shoot*,
  which fires for you while your crosshair is on an enemy. Both are on by default.
* **Characters** — smooth, fully skinned humans with faces, hands, clothes and a different hair
  style and look for each of the eight skins; full animation set and ragdolls.
* **Building** — walls, floors and ramps on a 4 m grid in wood/brick/metal; pieces grow in
  health while building, can be shot down, and anything left floating collapses.
* **Battle royale** — the bus, a shrinking storm with six phases, floor loot + chests, kill feed,
  spectating, victory screen.
* **Bots that play like people** — they only see what is in front of them (a view cone, a sight
  range and line of sight, and it takes a moment to notice someone far away), hear gunshots,
  footsteps and building, remember where they last saw you, react and aim like humans (they
  miss), and have personalities: rushers, campers, builders, snipers and loot goblins who land,
  loot, rotate with the storm, build when shot, box up to heal, push weak enemies and
  third-party fights.
* **Performance** — instancing and merged geometry keep draw calls low, the render resolution
  adapts on the fly to hold the display's refresh rate (60 fps on iPad, 120/144 Hz monitors on
  desktop), and there are Low → Ultra presets in Settings (Auto picks Medium on iPad).

## Controls

| | iPad / touch | Keyboard & mouse |
|---|---|---|
| Move | left thumb anywhere on the left half | `WASD`, `Shift` sprint |
| Look / aim | drag on the right half | mouse |
| Shoot / aim down sights | red ✛ buttons / ◎ | left / right mouse |
| Jump / crouch | ⤒ / ⤓ | `Space` / `Ctrl` (hold) or `V` |
| Weapons | tap the hotbar | `1`–`5`, wheel, `F` pickaxe |
| Build | ⚒ then Wall / Floor / Ramp, fire to place | `Q` wall, `Z` floor, `C` ramp, `B` toggle |
| Material | Mat | `G` or right mouse while building |
| Reload / interact | ⟳ / yellow button | `R` / `E` |
| Map / menu | tap minimap / ☰ | `M` / `Esc` |

Game controllers (via the Gamepad API) work too.

## How it fits together

```
server.js                 optional HTTP + WebSocket server (serves the site, hosts parties)
public/index.html         the website / HUD markup (libraries load from the jsDelivr CDN)
public/shared/            code shared by browser and server
  constants.js            weapons, items, storm, player tuning
  worldgen.js             deterministic island generator (same ids everywhere)
  buildgrid.js            build grid, structural support, collapse
  room.js                 authoritative match logic (runs on the server, or in the browser
                          for solo games and on the host's device for website parties)
public/js/                the game client (three.js + Rapier)
public/js/net/p2p.js      website parties over WebRTC (PeerJS)
```

The match logic (`room.js`, on the server or the party host's device) is authoritative for health, damage, eliminations, loot, chests, builds, destruction
and the storm; each device simulates its own player (and the party leader simulates the bots)
and sends 20 updates a second, so it feels instant on a home network. If GitHub Pages is
ever pointed at a source branch instead of `gh-pages`, the `index.html` at the repository root
forwards visitors to the game in `phortnite/public/`.

Phortnite is a fan-made parody game and is not affiliated with or endorsed by Epic Games.
