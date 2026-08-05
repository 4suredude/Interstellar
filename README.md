# Interstellar

**Interstellar** is a top-down space combat game for the browser — inertial
flight, energy warfare, and zone chat, built from scratch with no engine and
no dependencies: sprite-shaded ships with bloom and particles, synthesized
audio, a **12-ship hangar** (the 8 fleet hulls plus the NOVA class), and
**real online multiplayer** via a zero-dependency Node server.

![Combat](assets/combat.png)

## Play solo (no install)

Open `index.html` in any modern browser. Press **Enter**, pick a ship, and
you're in a zone against 10 AI pilots.

## Play online (multiplayer)

```sh
node server.js            # one command, zero npm dependencies
```

Everyone opens `http://<host>:8666` and presses **O — Online multiplayer**.
Pick a callsign and a ship, and you're all in the same zone together with the
server's bots. `PORT=9000 BOTS=4 node server.js` to customize. A different
server can be targeted with `?server=host:port` in the URL.

The netcode is an owner-trusting relay: each client owns its ship, the
server authoritatively runs bots and prizes and relays state, fire events,
kills, scores, and chat (**Enter** to talk) at 15–20 Hz with dead-reckoning
interpolation for remote ships. Both sides run the same simulation code
(`sim.js`) on the same map seed.

## The hangar — 8 fleet hulls + the NOVA class

![Ship select](assets/select.png)

| Ship | Character |
| --- | --- |
| **Corsair** | The duelist — heavy single shots |
| **Meteor** | Bomber with bouncing splash artillery |
| **Hornet** | Rapid-fire bullet hose, monster recharge |
| **Titan** | Slow dreadnought, colossal energy, L3 bombs |
| **Comet** | Fastest interceptor in the zone |
| **Dagger** | Tiny assassin — off enemy radar, dim to the eye |
| **Paladin** | Broad-winged all-rounder with dependable guns |
| **Warden** | Support hunter with a self-restocking repel rack |

A new generation of hulls joins the fleet — each with a mechanic all its own:

| NOVA ship | New mechanic |
| --- | --- |
| **Vanguard** | Ships factory MultiFire + ricochet rounds from spawn |
| **Aegis** | Composite plating absorbs 28% of all incoming damage |
| **Reaper** | Leeches 30% of the damage it deals back as energy |
| **Phantom** | Blink drive: `R` teleports 240m forward — straight through walls |

## The combat system

- **Inertial flight** — no friction, no brakes; ships ricochet off walls.
- **Energy warfare** — one bar is shields *and* ammo; a hit that lands with
  nothing left kills you.
- **Leveled weapons** — L1–L3 color-coded bullets and bombs with splash,
  knockback, proximity fuses, wall bounces — and your own bombs hurt you.
- **Greens** — anonymous prize boxes: gun/bomb upgrades, MultiFire, bouncing
  bullets, repels, bursts, rockets, energy/recharge/thrust/speed boosts.
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
| `S` / `↓` | Reverse thrust |
| `A` `D` / `←` `→` | Rotate |
| `Space` / `Ctrl` | Guns |
| `Shift` / `B` | Bomb |
| `E` | Repel |
| `Q` | Burst |
| `R` | Rocket (Blink on the Phantom) |
| `X` | Toggle MultiFire |
| `Enter` | Chat (online) |
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
- Teams, flag capture, and ball-game modes
- Server-side anti-cheat validation (the relay model trusts clients)
- Gamepad and touch controls
