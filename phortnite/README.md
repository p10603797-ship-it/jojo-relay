# PHORTNITE

A 3D battle royale that runs in the browser — made for iPad (touch controls) and computers
(keyboard/mouse or a game controller), with multiplayer for friends, straight from a website.

Drop out of a flying bus, loot weapons, harvest materials, build walls/floors/ramps and be the
last one standing to win a **Phictory Royale**.

## Play on the website (no computer needed)

Phortnite is a plain static website, so it runs straight from **GitHub Pages**:

**https://p10603797-ship-it.github.io/jojo-relay/**

The website is **locked**: it asks for a password before the game opens (ask Philip for one).
It is published from the **`gh-pages`** branch, which holds a *locked build* of the `public/`
folder at its root (see [Publishing the locked website](#publishing-the-locked-website)); GitHub
rebuilds the site within a minute or two of a push.

The game opens in the **lobby**: your character on a glowing podium, with your party around you.

* **PLAY** starts a match right away (you against bots). **CHANGE** on the mode card picks the
  game mode; **WARM UP** lets you practise on the island with unlimited ammo and materials.
* **Play with friends anywhere**: tap a **+ INVITE** slot. Your lobby becomes a party with a
  4-letter code, a QR code, **SHARE** (AirDrop, Messages…) and **COPY LINK**. Friends tap
  **JOIN A FRIEND** and type the code, scan the QR code, or simply open the link. They appear
  next to you on the podium with their name, level and a ✓ when they are **READY**.
* The **party leader** (♛) picks the mode and presses **PLAY**; everyone sees 3-2-1 and drops in
  together. Members can **suggest** a mode ("Mia wants Gun Game"). Tap a friend's name to make
  them leader or remove them from the party; tap your own name to rename yourself.
* After you are eliminated, **BACK TO LOBBY** lets you wait for your friends on the podium (the
  match goes on; **SPECTATE** to watch). When the match ends everyone comes back together and
  sees the results card: places, eliminations, damage, the MVP and the XP you earned.
* If the Wi-Fi blips you get back into the same match within a minute. If the host's iPad goes
  to sleep or switches apps, the match pauses and friends see *Waiting for the host…*. Solo
  matches pause too when you switch apps.

Parties are peer-to-peer: the match runs on the **host's** device and the others connect to it
directly over WebRTC (the free [PeerJS](https://peerjs.com) service only introduces the devices
to each other, and relays traffic if a direct link isn't possible). Up to 8 players fit in a
website party. The host keeps the same party code across reloads, so friends can **REJOIN**.

The lobby shows how many people are playing Phortnite right now (tap it to see how many are in
a match). It is counted through the same free public relay: each open game says "here, in the
lobby" or "here, in a match" under a random id that changes on every load. Where the website has
an admin (see [Admin](#admin)), each game also sends a small *player card* (name, level, lobby or
match, party) that is encrypted so that only the admin can read it; the relay and everyone else
only ever see scrambled data.

Tip for iPad: in Safari tap *Share → Add to Home Screen* and launch Phortnite from the home
screen for a true full-screen game.

## Party chat

Chat with your party in the lobby and in matches:

* **In the lobby** tap **💬 CHAT** (next to EMOTE / WARM UP; a red badge counts new messages).
  The chat opens on the left, over the stage, and never covers PLAY or the mode card. **In a
  match** tap **💬** next to ☰ (or ☰ → 💬 PARTY CHAT); the game keeps running while it is open.
  The last few lines also float bottom left for a few seconds, clear of the touch buttons. On a
  keyboard, `Enter` opens the chat (`T` too in the lobby), `Enter` sends and `Esc` closes it.
* **Quick chat**: one tap on *Let's go!*, *GG!*, *Ready?*, *Nice shot!*, *Help me!*, *One more
  game?*, *Follow me!*, *Thanks!*, 👍 or 😂.
* **Kept kid-safe**: bad words turn into ★★★, and links, e-mail addresses, phone numbers and
  @names into *[hidden]*, on your own iPad before a line is sent, again in the party's room and
  again on every iPad that shows it. Nobody can flood the chat (a few lines at a time, at most 20
  a minute). Tap someone's message to **hide** their messages (this party, until you reload) or
  **🚩 report** it to the admin.
* **Open moderation**: the chat always says so at the top: *🛡 The admin (Philip) can read chats
  to keep everyone safe. Never share your real name, address, school or phone number.* The admin
  can see party chats, look at a player's chat log (their chat then says *🛡 The admin looked at
  this chat*), mute someone's chat for a while (they see *🔇 The admin muted your chat until …*
  and can still play), and talk in a party while spectating it (his lines are tagged
  **🛡 ADMIN**). See [Admin](#admin).
* **Settings → Chat**: *On* (default), *Quick chat only* (you send only quick chat, and other
  players' typed messages show as *💬 (message hidden: quick chat only)*), or *Off* (no chat
  button, no messages).
* **Private on the relay**: chat travels inside the party's own link. Direct links between iPads
  are always encrypted (WebRTC); when the party has to go through the free public relay (Wi-Fi
  that blocks direct links), every link is now end-to-end encrypted too (a fresh ECDH P-256 key
  pair per link, AES-GCM-256), so people listening on the public relay can't read chat, names or
  the match. (It stops eavesdroppers, not someone actively pretending to be the host on the
  relay; see `public/js/net/relay.js`.) Pages from before 2.5.0 can't join a 2.5.0 party:
  everyone should reload.

## Publishing the locked website

On the website the game's code is **encrypted**: anyone can download the files, but they are
useless without one of Philip's passwords. The page shows a lock screen; the right password
unlocks the code on the device and the game starts (tick *Remember on this device* to type it
only once). The server on your own computer (`npm start`) is not locked.

* A password is 8 letters and numbers, without 0/O and 1/I so it is easy to read. Small letters,
  spaces and dashes don't matter when typing it.
* `lock/slots.json` holds one *key slot* per password: the game's key, encrypted with that
  password (PBKDF2-SHA256, 600,000 rounds). It contains no passwords, so it is committed.
  **Passwords are never committed or saved anywhere**: they are printed once, when they are
  made. Write them down with their numbers (so you know which one to turn off later).

```bash
cd phortnite
npm install                                  # once (the build needs es-module-lexer)

node tools/lock.mjs new --count 10           # once: 10 new passwords, printed only this one time

# every update: build the locked site (it asks for any one working password), then publish it
node tools/lock.mjs build --out ~/phortnite-locked
```

The password is typed when the tool asks for it (it isn't shown), or comes from the
`PHORTNITE_PASSWORD` environment variable in scripts; it is never a command-line argument, which
would end up in the shell history. Every build encrypts afresh, but the passwords stay the same
as long as `lock/slots.json` does. (The build refuses key slots with fewer than 600,000 rounds:
those are made only by the tests, with `--iter … --allow-weak`.)

**Publishing.** The `gh-pages` branch must hold *only* locked builds: one plain-text copy of the
game anywhere on it (an old `js/` or `shared/` folder, or the old `beta/` copy) and the game opens
without a password. So replace the whole branch, keeping only what the build wrote:

```bash
git worktree add /tmp/pages gh-pages          # from the repository root
cd /tmp/pages
git rm -r -q .                                # everything: old js/, shared/ and beta/ too
cp -R ~/phortnite-locked/. .                  # the locked build (with its .nojekyll)
# beta/ stays deleted. To keep a beta, lock it too, from the same lock/slots.json:
#   node tools/lock.mjs build --out ~/phortnite-locked-beta   (in the beta's source checkout)
#   mkdir beta && cp -R ~/phortnite-locked-beta/. beta/
git add -A && git commit -m "Publish the locked build" && git push origin gh-pages
cd - && git worktree remove /tmp/pages
```

About 10 minutes later (GitHub Pages caches), check that `…/jojo-relay/js/main.js`,
`…/jojo-relay/shared/room.js` and `…/jojo-relay/beta/js/main.js` answer *404*.

**The repository must not give the game away.** The lock only keeps the game private while no
plain-text copy of it is public. This repository is public: `phortnite/public/` on every branch,
and every earlier commit of `gh-pages`, can be read on GitHub, and file-proxy sites even run it
straight from there, no password needed. Either make the repository private (GitHub Pages from a
private repository needs a paid GitHub plan), or move the source to a new private repository and
publish only locked builds from a separate public repository whose history has only ever held
locked builds. Until then the lock keeps out people who only open the website.

```bash
node tools/lock.mjs list                     # the slot numbers in use
node tools/lock.mjs add --count 2            # 2 more passwords (needs a working one); new numbers
node tools/lock.mjs remove --slot 3          # turn password 3 off…
node tools/lock.mjs build --out ~/phortnite-locked   # …from the next published build on
```

A turned-off password stops working on devices that remembered it too (they ask again: *That
password was turned off — ask Philip for a new one*). It is a soft off-switch: the game's key
stays the same, and the old key slot is still in the git history, so someone who has that
password and knows how could still decrypt later builds. If a password reached someone who must
be shut out completely, run `node tools/lock.mjs new --count 10 --force` instead (a new key and
new passwords for everyone), hand out the new passwords and publish. The same command starts over
if every password is lost. A number is never given to a second password, even after the
highest one is removed.

*Remember on this device* keeps the password in the browser (one per site folder, so the main
site and `beta/` remember separately). On an iPad it lasts while the game keeps being opened:
Safari forgets a site's saved data after about a week of not visiting it, and a Home Screen icon
has its own storage, so the password is asked for again then. That is not a turned-off password.

**Three wrong passwords in a row ban the device** from the whole site (`beta/` too). Only a typed
password that was really checked counts (not a too-short one, a lost connection, a turned-off
remembered one or the same wrong one again), and the right password starts the count again. No
website can recognise one particular iPad, so the ban is kept in the device's own browser storage,
in three places so that clearing one doesn't lift it. Clearing Safari's website data, a private
window, a new Home Screen icon (it has its own storage) or another browser app all give new tries,
and with Safari set to block all cookies nothing is kept at all (no website can prevent that); like
a remembered password, the ban is forgotten after about a week without a visit. Deleting the site's
data on the iPad (Settings › (Apps ›) Safari › Advanced › Website Data) lifts a ban straight away,
even while the unban box is locked. Or run `node tools/lock.mjs unban-code` once (it prints the code
once; `lock/slots.json` keeps only a check for it) and publish a build; then tap the small *Philip:
unban* on the banned device and type the code (the box shows dots). Three wrong codes lock that box
for an hour. Running `unban-code` again (and publishing) replaces the code: do that if someone saw
it.

**Face ID.** Players can choose between typing a password and Face ID (or Touch ID). Right after
the right password is typed, the lock screen asks *Use Face ID next time?*; **TURN ON FACE ID**
makes a passkey for the website on the device (it shows up in the Passwords app, or Settings ›
Passwords, as *Phortnite*), and from then on the lock screen has a big **UNLOCK WITH FACE ID**
button above the password box (typing a password still works, and still counts towards the ban).
No face data exists anywhere: the website never sees a face and keeps no pictures to compare
with. Apple's Face ID checks the face inside the device, and only after a match does the device's
passkey release a secret to the page (the WebAuthn *PRF* extension). That secret unlocks a copy of
the game's key kept in the browser's storage on that device only (nothing is sent anywhere, and
nothing secret is in the repository or the website). If Face ID doesn't recognise you, the device
may ask for its passcode instead; a failed or cancelled scan is never a wrong try. It needs Safari
on iPadOS / iOS 18 or newer (or another browser with passkeys and PRF): older devices don't get the
offer, or say once that they can't use it (a *Phortnite* passkey they made then can be deleted in
the Passwords app). Face ID takes the place of *Remember on this device*
(the remembered password is forgotten when Face ID is turned on). *NOT NOW* is remembered on the
device, and *Forget Face ID on this device* turns it off (newer Safari and Chrome then delete the
passkey themselves; otherwise delete it in the Passwords app, listed under the website
p10603797-ship-it.github.io as *Phortnite*). Setting Face ID up again replaces the old passkey
instead of adding another, and if Face ID stops working (say its passkey was deleted), typing the
password offers to set it up again. Like a remembered password, Safari may clear the Face ID
setup after about a week without playing; the next typed password offers it again. Face ID is tied to the password typed when it was turned on: turning that
password off (`remove`) also turns off Face ID set up with it (*That password was turned off*), and
new passwords for everyone (`new --force`) need Face ID set up again. Clearing the website's data
removes the Face ID setup. A ban hides Face ID; the unban brings it back.

## Admin

Philip (the admin) can see who's online and moderate the game, from any iPad, with the admin
password. Players are told this on the *Who's playing?* screen, and moderation is never secret:
every time the admin does something to a player, that player sees it on screen ("The admin removed
you from the match.", "📣 Message from the admin: …", "🚫 You've been banned by the admin"…). On
the locked website a banned device's ban screen says the admin banned it (and why), not "too many
wrong passwords".

* **Getting in.** Tap the small **Admin** button on the *Who's playing?* screen (or in the account
  panel under the level chip) and type the admin password. Tick *Remember admin on this iPad* to
  skip the password next time on that iPad (for 30 days); **ADMIN SIGN OUT** (same place) turns it
  off again. Only tick it on Philip's own iPad: while the keys are remembered, any page on the same
  website address could use them (never read them), so keep no other GitHub Pages projects on the
  `p10603797-ship-it` account, or give Phortnite its own domain or account. A
  wrong password just says so (it never bans the device). In admin mode the lobby's top bar has a
  **🛡 ADMIN** button. Making an *account* an admin is not a thing: only the password gives the powers.
* **🛡 ADMIN → PLAYERS** (everyone online, live, with their name, level, guest or account, lobby
  or match, party code and size, host or member, mode, game version and how long they've been
  online; tap a player for the buttons): **spectate** their match, send a **message**, **kick**
  someone back to their own lobby, **ban** a device (it gets the lock screen's ban screen, and
  Philip's unban code lifts it like any other ban), **rename** them, **give XP** (up to 100,000),
  **reset stats**, or **reload** their game. For a party host: **end the match** (everyone back to the lobby) or **pause / resume** it
  during a match, or **set the mode** in the party's lobby; everyone in that party sees that the
  admin did it (kicking or banning a host ends their party, and the others are told why). A row
  marked ⚠ means someone is faking that player's card: commands still reach only the real player.
* **🛡 ADMIN → EVERYONE**: a **banner** across the top of every game (in the lobby and in matches)
  for 5 minutes, 30 minutes, 2 hours or until cleared (a week at most); **maintenance mode** ("🛠 Philip is working
  on the game": everyone is taken out of their match and PLAY waits until it is off); a **message
  for everyone**; **reload everyone**. The panel says a command was *sent*: a game that is offline
  at that moment doesn't get it.
* **Spectating** a match joins that party as an *observer*: not a player (no spot in the party, no
  character, nobody can hit it), just the spectator camera with ◀ ▶ to switch who you watch and
  LEAVE. Everyone in that party sees **👁 Admin is watching** for as long as the admin is there. The
  host's game lets an observer in only with a hello signed by the admin key for that party, and
  each signed hello only once (the admin's game signs a new one for every join), so nobody else
  can watch unseen. (Parties on the `npm start` server can't be watched.) The **💬** button on the
  spectating bar opens that party's chat: the admin can talk there, and everyone sees his lines
  tagged **🛡 ADMIN**.
* **🛡 ADMIN → CHAT** (chat moderation, open like everything else: the chat drawer always says
  that the admin can read chats). **🚩 Reports**: when a player taps a chat line and *Report to
  admin*, the line and up to 10 lines before it show up here (the tab's red badge counts new ones,
  and the admin's screen says "🚩 New chat report"). **Party chats**: every party's chat, live, as
  its host's game sends it in (only parties with 2 or more people, newest party first, the last
  500 lines each; the admin's page keeps them in memory only, a reload forgets them). Tap a line
  for what to do about who said it: **🔇 mute** their chat for 10 minutes, 1 hour or 1 day (with
  an optional reason; they see "🔇 The admin muted your chat for 1 hour" and can still play and
  read the chat), **🔈 unmute**, **✉ message** them, or fetch their **💬 chat log**. The PLAYERS
  buttons have **💬 CHAT LOG**, **🔇 MUTE CHAT** and **🔈 UNMUTE CHAT** too. A chat log is the
  last 100 lines that player's game has seen since it was opened (all parties), shown in a sheet;
  their chat says "🛡 The admin looked at this chat". Chats, reports and logs are sealed to the
  admin's key on the relay; anyone *could* seal something to his public key, so the panel marks ⚠
  whatever wasn't sealed by the game it claims to come from (each game seals its uploads with its
  own key, the one in its player card).

How it works: `public/admin.json` holds two public keys and the matching private keys *encrypted*
with the admin password (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM), so it is safe to publish.
Every admin command is **signed** with the admin's private key (ECDSA P-256) and travels through the
same free public relay as the player count; every game checks the signature against the public key
in `admin.json` (and that the command is less than 2 minutes old, never seen before, and meant for
it) before doing anything, so nobody else can send one. Player cards are sealed to the admin's
other key (ECDH P-256 + AES-256-GCM), so only an unlocked admin can read names; each card also
carries that game's own one-visit key, and what the admin sends to one player (a message, a new
name, a reason) is sealed to it, so the relay never sees it in the clear and a faked card can't
steer a command onto someone else. A banner and a message for *everyone* are not secret (anyone
on the relay can read them). The password is **never stored** anywhere: on the iPad it turns into
keys the page can use but never read back. Without an `admin.json` all of this is simply absent.

What the relay can still do (it is public): drop or delay messages, so a command can fail to
arrive (the panel only says *sent*); and someone who recorded one of the admin's *own* signed
banners or maintenance messages can put it back on the relay after Philip changed it. A game that
already saw the newer one never goes back (it remembers), and while Philip's admin page is open it
puts his newest one back at once; otherwise a game opened later can show that old banner (a week
at most) or maintenance (until the time it was set for, 12 hours unless chosen otherwise).

```bash
node tools/admin.mjs new --out public/admin.json     # a new admin key; the password is printed ONCE
PHORTNITE_ADMIN=…  node tools/admin.mjs check --in public/admin.json   # does this password work?
```

Write the password down when it is printed: it is not saved anywhere and can't be recovered. Then
publish the website (the locked build copies `admin.json` as it is). To **change the admin
password or key** (it was seen, or lost), run `node tools/admin.mjs new --out public/admin.json
--force` and publish: from then on only the new password works, every game obeys only the new key,
and iPads that remembered the old admin forget it.

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
**+ INVITE** opens a party on the server (its link and QR code use the Wi-Fi address), and
**JOIN A FRIEND** lists the parties on the server (parties from your own Wi-Fi are marked
*SAME WI-FI*) or joins one by its 4-letter code. Up to 16 players fit in a server party. The
server serves the 3D and physics libraries itself, so it needs no internet.

If Windows asks about the firewall the first time, allow Node.js on *private* networks,
otherwise the iPads can't reach the server.

`PORT=3000 npm start` changes the port. `npm test` runs the game-logic tests.

Each network (IP address) can have at most 8 parties open, create 10 parties a minute and hold
64 connections (`MAX_ROOMS_PER_IP`, `MAX_CREATES_PER_MIN`, `MAX_CONNS_PER_IP` change these). On a
plain Wi-Fi every iPad has its own address, so these never get in the way. Behind a reverse proxy
on another machine (or a hosting service), every player seems to come from the proxy's address:
set `TRUST_PROXY=1` there so the server uses the `X-Forwarded-For` address instead (by default it
only trusts a proxy on the same machine; `TRUST_PROXY=0` never trusts it).

## What's in it

* **Real 3D world** — a 1.6 km procedurally generated island (always the same island, like the
  real thing) with 11 biomes (snowy mountains, desert, striped mesas, jungle, swamp, a volcano
  with a lava lake, a city, farms, forest, meadow, beaches), 26 named places and 15 landmarks,
  285 enterable buildings of 32 types, roads and bridges, a river and a lake, launch pads,
  geysers and bounce mushrooms, ~6,000 trees, props, and 290 chests. Terrain LOD, vegetation
  rings, batched buildings and collider streaming keep it fast on an iPad; the map and full map
  show every place, and a tap drops a marker for your team.
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
* **Building** — walls, floors, ramps and cones (roofs) on a 4 m grid in wood/brick/metal; one
  tap places a piece on touch (hold and turn to keep building); edits: door, window, arch, half
  wall and floor holes. Pieces grow in health while building, can be shot down, and anything
  left floating collapses.
* **Game modes** — about 60 curated modes in **Discover** (Battle Royale solo to squads, Zero
  Build, Team Rumble, Gun Game, Infection, King of the Hill, Juggernaut, Floor is Lava, Hide &
  Seek, Box Fight, Zone Wars, crazy mutators like Moon gravity and Big Heads, Playground, …),
  plus a **creator** for your own rules with a shareable mode code. The rules run in the shared
  room, so every mode works the same solo, on the server and in website parties.
* **Party chat** — type or tap quick chat in the lobby and in matches, with a kid-safe filter,
  hide / report, and open moderation by the admin (see [Party chat](#party-chat)).
* **Lobby & parties** — a Fortnite-style lobby with your squad on a podium (its own little scene,
  far cheaper to draw than the island), ready-up, leader crown, kick / make leader, live skin
  changes, a 3-2-1 countdown, one invite flow for the website and the server (code, QR, share
  sheet, link), mode suggestions, back-to-lobby, a death card that shows who got you, a
  *#1 PHICTORY ROYALE* celebration with the winners dancing, results with XP and levels, rejoin
  after a dropped connection, and synthesized lobby music.
* **Battle royale** — the bus, a shrinking storm (eight phases on the big island), floor loot +
  chests, kill feed, spectating, victory screen.
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
| Jump / crouch | ⤒ / ⤓ | `Space` / `Ctrl` (hold) or `X` |
| Weapons | tap the hotbar | `1`–`5`, wheel, `F` pickaxe |
| Build | ⚒ then tap Wall / Ramp / Floor / Cone | `Q` wall, `Z` floor, `C` ramp, `V` cone, `B` toggle |
| Edit your piece | ✎ EDIT, then DOOR / WINDOW / ARCH / HALF / RESET | `G`, then `1`–`5` |
| Material | Mat | `G` (nothing to edit) or right mouse while building |
| Reload / interact | ⟳ / yellow button | `R` / `E` |
| Map / menu | tap minimap / ☰ | `M` / `Esc` |
| Party chat | 💬 CHAT in the lobby, 💬 next to ☰ in a match | `Enter` (`T` in the lobby), `Esc` closes |
| Back to the lobby | ☰ → BACK TO LOBBY (or ↩ LOBBY while warming up) | `Esc` → BACK TO LOBBY |

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
  modes/                  the mode rules, the catalogue, mode codes and the games (gun game,
                          infection, king of the hill, …) the room plays
  world/                  the 1.6 km island generator (biomes, places, buildings, roads)
public/js/                the game client (three.js + Rapier)
public/js/net/p2p.js      website parties over WebRTC (PeerJS)
public/shared/plugins/party.js  party rules in the room: ready, kick, promote, countdown, rejoin
public/shared/plugins/chat.js   party chat in the room (rate limits, history); shared/chatFilter.js
                          the kid-safe filter every line goes through
public/js/ui/chat.js      the chat drawer, the 💬 buttons and the in-match feed (app.chat);
                          js/chat/chatLog.js its store; js/game/chatClient.js its game plugin
public/js/net/relay.js    the encrypted relay fallback over public MQTT brokers (net/mqtt.js)
public/js/lobby/          the lobby stage (3D) and the bridge between a match and the lobby
public/js/ui/lobby.js     the lobby screen; ui/invite.js invites and joining; ui/endscreen.js
tools/lock.mjs            builds the locked (encrypted) website; tools/lockscreen/ is its lock
                          screen and loader (lock.js); lock/slots.json the password key slots
```

### Checking a website (P2P) party on real iPads

WebRTC can't be tested in the automated sandbox, so before publishing try this with two iPads
(or an iPad and a laptop) on the website build:

1. iPad A: open the site, tap **+ INVITE**. A 4-letter code and QR code appear.
2. iPad B: scan the QR code with the camera (or open the link): it lands in A's lobby next to A.
3. B taps **READY**, A sees the ✓. B changes skin in the Locker; A sees it at once.
4. A taps **PLAY**: both see 3-2-1 and the bus. Turn B's Wi-Fi off for 10 s and on again: B gets
   *Connection lost — getting you back in…* and continues the same match.
5. A switches to another app for 20 s mid-match: B sees *Waiting for the host…*; when A comes
   back the match continues where it was (the storm did not move on).
6. A taps a friend's name → **KICK**: B is back in a party of one with a message.
7. A reloads the page and taps **+ INVITE** again: the party code is the same, B can **REJOIN**.

The match logic (`room.js`, on the server or the party host's device) is authoritative for health, damage, eliminations, loot, chests, builds, destruction
and the storm; each device simulates its own player (and the party leader simulates the bots)
and sends 20 updates a second, so it feels instant on a home network. If GitHub Pages is
ever pointed at a source branch instead of `gh-pages`, the `index.html` at the repository root
forwards visitors to the game in `phortnite/public/`.

Phortnite is a fan-made parody game and is not affiliated with or endorsed by Epic Games.
