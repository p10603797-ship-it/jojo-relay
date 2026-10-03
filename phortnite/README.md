# PHORTNITE

A 3D battle royale that runs in the browser — made for iPad (touch controls) and computers
(keyboard/mouse or a game controller), with multiplayer for friends on the same Wi-Fi.

Drop out of a flying bus, loot weapons, harvest materials, build walls/floors/ramps and be the
last one standing to win a **Phictory Royale**.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer on one computer.

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
QR code with the iPad camera).

* **Play Solo** — you against up to 30 bots. Runs entirely in the browser.
* **Play with Friends** — create a party, everyone else taps it in the list (parties from your
  own Wi-Fi are marked *SAME WI-FI*) or types its 4-letter code. While waiting you can warm up
  on the island. The party leader picks the mode — *Everyone for themselves* or *Friends team up
  vs bots* (no friendly fire, the whole squad wins together) — plus the number of bots and
  starting materials, then hits **Start match**.

Tip for iPad: in Safari tap *Share → Add to Home Screen* and launch Phortnite from the home
screen for a true full-screen game.

If Windows asks about the firewall the first time, allow Node.js on *private* networks,
otherwise the iPads can't reach the server.

`PORT=3000 npm start` changes the port. `npm test` runs the game-logic tests.

Solo mode needs no server at all: `npm run build:static` copies the libraries into
`public/vendor/`, after which the `public/` folder can be put on any static web host.

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
  the sniper!), spread/bloom, first-shot accuracy, recoil, damage falloff, headshots, shotgun
  pellets, rockets with splash damage, bullet holes, tracers, impact effects per material.
* **Weapons** — assault rifle, SMG, pump shotgun, bolt sniper, pistol, rocket launcher in five
  rarities, plus bandages, med kits and shield potions.
* **Building** — walls, floors and ramps on a 4 m grid in wood/brick/metal; pieces grow in
  health while building, can be shot down, and anything left floating collapses.
* **Battle royale** — the bus, a shrinking storm with six phases, floor loot + chests, kill feed,
  spectating, victory screen.
* **Bots** that loot, fight with lead and human-like aim, throw up walls when shot, heal and flee
  the storm.
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
server.js                 HTTP + WebSocket server (serves the site, hosts parties)
public/index.html         the website / HUD markup
public/shared/            code shared by browser and server
  constants.js            weapons, items, storm, player tuning
  worldgen.js             deterministic island generator (same ids everywhere)
  buildgrid.js            build grid, structural support, collapse
  room.js                 authoritative match logic (also runs in-browser for solo)
public/js/                the game client (three.js + Rapier)
```

The server is authoritative for health, damage, eliminations, loot, chests, builds, destruction
and the storm; each device simulates its own player (and the party leader simulates the bots)
and sends 20 updates a second, so it feels instant on a home network.

Phortnite is a fan-made parody game and is not affiliated with or endorsed by Epic Games.
