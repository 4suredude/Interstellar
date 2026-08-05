# Continuum Redux

A modern, from-scratch tribute to **SubSpace / Continuum** — the classic top-down
inertial space combat game — rebuilt for the browser with neon rendering,
particle effects, synthesized audio, and AI pilots to fight.

![Combat](assets/combat.png)

## Play

No build step, no dependencies. Either:

- open `index.html` directly in any modern browser, or
- serve the folder (`npx serve .` or `python3 -m http.server`) and visit it.

Press **Enter**, pick a ship, and you're in the zone.

![Ship select](assets/select.png)

## What's faithful to SubSpace

- **Inertial flight** — no friction, no brakes. Thrust and rotation only; momentum is the game.
- **Energy warfare** — one bar is your shields *and* your ammo. Firing costs energy,
  getting hit drains it, and when a hit lands with nothing left, you explode.
- **Leveled weapons** — L1–L3 bullets (color-coded), bombs with splash, knockback,
  proximity fuses, wall bounces, and self-damage (your own bombs hurt — tradition).
- **Greens** — anonymous prize boxes scattered through the zone: gun/bomb upgrades,
  MultiFire, bouncing bullets, repels, bursts, rockets, energy/recharge/thrust boosts.
- **Repel / Burst / Rocket** specials, ricocheting ships, the corner radar with the
  whole map, green kill-feed chat, bounty, and full loadout reset on death.
- **Four classic hulls** — Warbird (heavy shots), Javelin (bomber), Spider (bullet
  hose), Terrier (interceptor) — each with distinct stats and silhouettes.

## What's modernized

- Neon vector renderer: glow sprites, additive particles, shockwaves, screen shake,
  parallax starfield and nebulae, damage vignette, prerendered tile map.
- Synthesized WebAudio SFX (no assets) with distance attenuation.
- 10 AI pilots with target leading, wall avoidance, dodging, fleeing, repel/burst
  usage, and prize hunting — the zone fights on its own (watch the attract mode
  behind the title screen).
- Fixed-timestep simulation, resolution-independent HiDPI canvas, live leaderboard,
  local best-score persistence.

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
| `P` / `Esc` | Pause |
| `M` | Mute · `F` Fullscreen |

## Development

The whole game is `game.js` (plain ES2017, no framework) plus a one-page shell.
A headless smoke test drives the real game code under Node with a stubbed DOM,
simulates 90 seconds of combat, and asserts the world stays sane:

```sh
node dev/smoke.js
```

The simulation is deterministic-timestep and fully decoupled from rendering and
input, so a future multiplayer netcode layer can drive the same entity state.

## Roadmap ideas

- Mines, decoys, portals, and thors
- Team frequencies, flag and powerball (soccer) modes
- Real multiplayer via WebSocket zones
- Gamepad and touch controls
