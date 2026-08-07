# Interstellar

**Interstellar** is a top-down space combat game for the browser — inertial
flight, energy warfare, and zone chat, built from scratch with no engine and
no dependencies: sprite-shaded ships with bloom and particles, synthesized
audio, a **12-ship hangar** (the 8 fleet hulls plus the NOVA class), and
**real online multiplayer** via a zero-dependency Node server.

![Combat](assets/combat.png)

The game is built around **dueling and squad dogfights**: fast kill-trade
loops, hit-confirm feedback on every landed shot, kill streaks and
multikill callouts, and matches short enough to always want one more.

## Game modes

| Mode | What it is |
| --- | --- |
| **Duel** (`1` on the title screen) | You vs **the Ace** — a high-skill AI duelist. First to 5. Respawns are near-instant, facing each other across the central arena. Your lifetime W–L record is kept. |
| **Squad Battle** (`2` or `Enter`) | 3v3 team dogfight vs bots — blue vs red, no friendly fire, anchored team spawns, wingmen that hunt with you. First to 15. Every ship keeps its own identity color — team reads from the blue/red halo ring, nameplates, and radar. |
| **The Zone** (`3`) | Drop into the persistent living world — no match, no clock. The zone fights on while you're at the title screen and remembers everything when you return. |
| **Hold the Core** (`4`) | 3v3 objective mode: hold the glowing center ring **alone** for 3 seconds to score a point. First to 20. Forces the fight into one shared arena. |
| **Online** (`O`) | Real multiplayer with rounds, MVPs, side swaps, an **Elo duel ladder**, and persistent pilot stats. `MODE=teams` (default), `MODE=core`, or `MODE=ffa`. |

The feel layer runs in every mode: a hit-confirm tick each time your shot
lands, a kill-confirm jingle, **DOUBLE KILL / TRIPLE KILL / KILLING FRENZY**
banners, streak callouts in the feed ("X is on a rampage!"), a killcam that
follows your killer while you wait to respawn, and victory / defeat fanfares
with instant rematch on Enter.

## The competitive spine (online)

- **Your callsign is your identity.** The server persists every pilot's Elo,
  duel record, kills/deaths, accuracy, and score in `data/players.json` —
  shown on the connect screen, in `/stats` chat, and on the web ladder at
  `http://server:8666/stats`.
- **Duel ladder**: type `/duel <name>` in chat; they type `/accept`. Both of
  you warp to the center arena, first to 5 (any death counts). The zone
  watches the score line by line, and the result — with Elo changes — is
  announced to everyone. Disconnecting forfeits.
- **Elo badges** on nameplates: ☆ at 1275, ★ at 1400, ★★ at 1600.
- **Rounds**: when a team hits the goal, the round ends with an MVP callout,
  sides swap, and scores reset. Optional Discord announcements via
  `DISCORD_WEBHOOK=<url>`.
- **Map votes**: `/votemap nexus | gauntlet | rings` — a majority vote warps
  the whole zone to a fresh sector of that style, mid-session.
- **Squad tools**: `//` team chat, the **Warden aura** (allied ships near a
  Warden recharge 35% faster), and the **Comet warp beacon** — press `T` to
  jump to your team's Comet across the map. Allies can see stealthed
  Daggers; enemies can't.

## Netcode

Built for PvP: **30 Hz binary snapshots** both directions (a 24-byte ship
state instead of JSON), a **jitter buffer** that renders remote ships ~100 ms
in the past and interpolates between timestamped snapshots — with capped
extrapolation on packet loss, so ships glide instead of teleporting — plus
server-side sanity validation (position/speed clamps, per-weapon fire-rate
caps, damage caps, death-spam guards). Bots **back-fill**: they stand down
as humans join and rejoin as the zone empties.

## Play solo (no install)

Open `index.html` in any modern browser, pick a mode and a ship, and fly.

## Play online (multiplayer)

```sh
node server.js            # one command, zero npm dependencies
```

Everyone opens `http://<host>:8666` and presses **O — Online multiplayer**
(the connect screen shows live zone status first). Pick a callsign — it's
your persistent identity — and a ship, and you're in, auto-balanced onto
blue or red. Configuration is all environment variables:

```sh
PORT=9000 BOTS=6 GOAL=50 MODE=teams|core|ffa MAP=nexus|gauntlet|rings \
DISCORD_WEBHOOK=https://discord.com/api/webhooks/... node server.js
```

A different server can be targeted with `?server=host:port` in the URL. The
architecture is an owner-trusting relay: each client owns its ship, the
server authoritatively runs bots, prizes, rounds, duels, and the ladder,
and both sides run the same simulation code (`sim.js`) on the same map seed.

## The hangar — 8 fleet hulls + the NOVA class

![Ship select](assets/select.png)

| Ship | Character |
| --- | --- |
| **Corsair** | The duelist — heavy single shots |
| **Meteor** | Bomber with factory proximity-fused splash artillery |
| **Hornet** | Rapid-fire bullet hose — a sensor ghost that never paints on radar |
| **Titan** | Slow dreadnought, colossal energy, L3 bombs |
| **Comet** | Fastest interceptor in the zone, twin linked cannons |
| **Dagger** | Tiny assassin — off enemy radar, dim to the eye |
| **Paladin** | Broad-winged all-rounder whose bombs ricochet down corridors |
| **Warden** | Support hunter with a self-restocking repel rack |

A new generation of hulls joins the fleet — each with a mechanic all its own:

| NOVA ship | New mechanic |
| --- | --- |
| **Vanguard** | Ships factory MultiFire from spawn — a wall of lead |
| **Aegis** | Composite plating absorbs 28% of all incoming damage |
| **Reaper** | Leeches 30% of the damage it deals back as energy |
| **Phantom** | Blink drive: `R` teleports 240m forward — straight through walls |

## The combat system

- **Inertial flight with authority** — momentum rules mid-fight, but each
  hull has coast damping: hands off the keys and a Dagger settles crisply
  while a Titan drifts on. Precision when you want it, physics when you don't.
- **Energy warfare** — one bar is shields *and* ammo; a hit that lands with
  nothing left kills you.
- **Leveled weapons** — L1–L3 color-coded bullets and bombs with splash and
  knockback; **every bullet ricochets off walls**, bombs detonate on contact
  with a tight fuse, and **Proximity Fuse greens** widen the detonation
  radius — and your own bombs hurt you.
- **Greens** — anonymous prize boxes: gun/bomb upgrades, MultiFire, proximity
  fuses, repels, bursts, rockets, energy/recharge/thrust/speed boosts.
- **Repel / Burst / Rocket** specials, corner radar, green kill-feed chat,
  bounty, and full loadout reset on death — dying costs you everything you
  collected, which is exactly why it matters.

## The look

![Online multiplayer](assets/online.png)

- Ships are **solid, metallic, shaded craft** rendered through **36-frame
  rotation sprite atlases with fixed top-left lighting** — a crisp
  pre-rendered-sprite feel with baked lighting and rotation snap, drawn
  procedurally with hull plates, team-color accents, panel seams, engine
  nozzles, and cockpit glass with specular glints.
- Maps are **solid chunky bevelled tiles** with per-tile tonal variation and
  rock speckle, edged with a faint energized rim — steel and stone, not
  wireframe.
- Bullets and bombs wear their **level colors** (L1 red-orange, L2 yellow,
  L3 blue); space is near-black with a whisper of nebula.
- On top of that, the modern layer: subtle bloom post-processing, engine
  flames with white-hot cores, motion trails, debris and shockwave
  explosions, muzzle flashes, hex spawn shields, blink warp effects, and
  screen shake.
- **All audio is synthesized live — zero asset files.** Sound effects (guns,
  bombs, explosions, repels, blinks, bounces, low-energy warnings) are
  WebAudio-generated with distance attenuation, and the soundtrack is
  **generative space electronica**: slow detuned minor pads, a sub-bass
  pulse, a dotted-eighth delayed arpeggio, soft four-on-the-floor kick and
  offbeat hats, and rare high sparkles, sequenced live at 96 BPM. Toggle it
  with `N` (remembered between sessions), mute everything with `M`.
- AI pilots with target leading, wall avoidance, dodging, fleeing, repel/burst
  usage, and prize hunting — the zone fights on with or without you (watch the
  attract mode behind the title screen).
- Fixed-timestep simulation decoupled from rendering, HiDPI canvas, live
  leaderboard, persistent best score and callsign.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Thrust |
| `S` / `↓` | Reverse thrust (near-full power) |
| `←` `→` | Rotate |
| `A` / `D` | Strafe left / right |
| `Space` / `Ctrl` | Guns — all bullets ricochet off walls |
| `Tab` / `Shift` | Bomb |
| `E` | Repel |
| `Q` | Burst |
| `R` | Rocket (Blink on the Phantom) |
| `T` | Warp to your team's Comet |
| `Enter` | Chat (online) — `/duel` `/accept` `/stats` `/votemap` `/help`, `//` for team |
| `P` / `Esc` | Pause / menu |
| `M` | Mute all · `N` Music on/off · `F` Fullscreen |

## Architecture

| File | Role |
| --- | --- |
| `sim.js` | Shared simulation core (UMD): map gen, ships, weapons, AI, damage. No DOM. Runs in browser and Node. |
| `client.js` | Renderer, input, menus, audio, netcode client. |
| `server.js` | Zero-dependency zone server: static hosting + hand-rolled RFC 6455 WebSocket endpoint + authoritative bots/prizes + relay. |
| `dev/smoke.js` | Headless test: 90 s sim combat, stub-DOM client run, and a real server with two WebSocket clients exercising the whole protocol. |

```sh
node dev/smoke.js         # run all three test layers
```

## Roadmap ideas

- Mines, decoys, and portals
- Flag capture and ball-game modes
- Squad tags and squad-vs-squad ladders
- Account authentication (callsigns are currently honor-system identity)
- Gamepad and touch controls
