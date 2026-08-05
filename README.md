# Continuum Redux

A modern, from-scratch tribute to **SubSpace / Continuum** — the classic top-down
inertial space combat game — rebuilt for the browser with neon rendering, bloom,
particle effects, synthesized audio, the **full 8-ship roster**, and **real
online multiplayer** via a zero-dependency Node server.

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

The netcode is SubSpace-style relay, like the original: each client owns its
ship, the server authoritatively runs bots and prizes and relays state, fire
events, kills, scores, and chat (**Enter** to talk) at 15–20 Hz with
dead-reckoning interpolation for remote ships. Both sides run the same
simulation code (`sim.js`) on the same map seed.

## The full hangar — all 8 classic hulls

![Ship select](assets/select.png)

| Ship | Character |
| --- | --- |
| **Warbird** | The classic duelist — heavy single shots |
| **Javelin** | Bomber with bouncing splash artillery |
| **Spider** | Rapid-fire bullet hose, monster recharge |
| **Leviathan** | Slow dreadnought, colossal energy, L3 bombs |
| **Terrier** | Fastest interceptor in the zone |
| **Weasel** | Tiny assassin — off enemy radar, dim to the eye |
| **Lancaster** | Batwing all-rounder with dependable guns |
| **Shark** | Support hunter with a self-restocking repel rack |

## What's faithful to SubSpace

- **Inertial flight** — no friction, no brakes; ships ricochet off walls.
- **Energy warfare** — one bar is shields *and* ammo; a hit that lands with
  nothing left kills you.
- **Leveled weapons** — L1–L3 color-coded bullets and bombs with splash,
  knockback, proximity fuses, wall bounces, and traditional self-damage.
- **Greens** — anonymous prize boxes: gun/bomb upgrades, MultiFire, bouncing
  bullets, repels, bursts, rockets, energy/recharge/thrust/speed boosts.
- **Repel / Burst / Rocket** specials, corner radar, green kill-feed chat,
  bounty, and full loadout reset on death.

## What's modernized

![Online multiplayer](assets/online.png)

- Neon renderer with **bloom post-processing**, gradient-lit hulls, cockpit
  bubbles, engine flames with white-hot cores, motion trails, debris and
  shockwave explosions, hex spawn shields, glowing bevelled walls, parallax
  starfield with structured nebulae, and screen shake.
- Synthesized WebAudio SFX (no asset files) with distance attenuation.
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
| `R` | Rocket |
| `X` | Toggle MultiFire |
| `Enter` | Chat (online) |
| `P` / `Esc` | Pause / menu |
| `M` | Mute · `F` Fullscreen |

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

- Mines, decoys, portals, and thors
- Team frequencies, flag and powerball (soccer) modes
- Server-side anti-cheat validation (the relay model trusts clients, as the original did)
- Gamepad and touch controls
