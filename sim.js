/* =========================================================================
   CONTINUUM REDUX — shared simulation core
   Runs identically in the browser (window.SIM) and Node (module.exports).
   No DOM, no audio, no rendering — pure world state + events.

   Netcode model (SubSpace-style relay):
   - Each peer fully simulates its LOCAL ships (the player on a client,
     the bots on the server). Remote ships are "ghosts": position-driven
     from network state, never damaged locally, but targetable/collidable.
   - Weapons fire emits events; peers inject remote fire into their world.
   - Damage and death are computed by the victim's owner, then reported.
   ========================================================================= */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const TILE = 16;
  const MAPS = 192;
  const WORLD = TILE * MAPS;
  const STEP = 1 / 60;
  const PRIZE_CAP = 30;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const rand = (a, b) => a === undefined ? Math.random() : a + Math.random() * (b - a);
  const irand = n => (Math.random() * n) | 0;
  const pick = arr => arr[irand(arr.length)];
  const hyp = Math.hypot;
  function angleNorm(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  const dist2 = (a, b) => hyp(a.x - b.x, a.y - b.y);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------ ship types
  // Full classic SubSpace roster. Visual fields (shape/accent/deco/cockpit/
  // engines) are unit-space polygons scaled by radius at draw time, nose +x.
  const SHIP_ORDER = ['warbird', 'javelin', 'spider', 'leviathan', 'terrier', 'weasel', 'lancaster', 'shark'];
  const SHIP_TYPES = {
    warbird: {
      label: 'Warbird', hue: 192,
      desc: 'The classic duelist. Heavy single shots — one clean hit swings a fight.',
      maxEnergy: 1500, recharge: 105, thrust: 235, maxSpeed: 350, turn: 3.4,
      radius: 11, bounce: 0.6,
      gunLevel: 2, gunDelay: 0.55, gunCost: 150, gunSpeed: 680, gunDmgMul: 1.15,
      bombLevel: 1, bombDelay: 2.4, bombCost: 400, bombSpeed: 300,
      shape: [[1.35, 0], [-0.55, 0.95], [-0.3, 0], [-0.55, -0.95]],
      accent: [[1.0, 0], [-0.2, 0.38], [-0.05, 0], [-0.2, -0.38]],
      deco: [[[0.25, 0.42], [-0.42, 0.8]], [[0.25, -0.42], [-0.42, -0.8]]],
      cockpit: [0.38, 0, 0.2, 0.13], engines: [[-0.4, 0]],
    },
    javelin: {
      label: 'Javelin', hue: 18,
      desc: 'Bomber. Splash artillery with bouncing bombs that clear whole corridors.',
      maxEnergy: 1700, recharge: 95, thrust: 200, maxSpeed: 310, turn: 3.0,
      radius: 12, bounce: 0.5,
      gunLevel: 1, gunDelay: 0.6, gunCost: 120, gunSpeed: 600, gunDmgMul: 0.9,
      bombLevel: 2, bombDelay: 1.8, bombCost: 450, bombSpeed: 340,
      shape: [[1.15, 0], [0.15, 0.5], [-0.4, 1.0], [-0.75, 0.55], [-0.6, 0], [-0.75, -0.55], [-0.4, -1.0], [0.15, -0.5]],
      accent: [[0.85, 0], [0.1, 0.3], [-0.3, 0], [0.1, -0.3]],
      deco: [[[0.1, 0.5], [-0.35, 0.9]], [[0.1, -0.5], [-0.35, -0.9]]],
      cockpit: [0.32, 0, 0.19, 0.13], engines: [[-0.62, 0.3], [-0.62, -0.3]],
    },
    spider: {
      label: 'Spider', hue: 130,
      desc: 'Bullet hose. Weak pellets, relentless rate of fire, monster recharge.',
      maxEnergy: 1400, recharge: 135, thrust: 215, maxSpeed: 330, turn: 3.6,
      radius: 11, bounce: 0.55,
      gunLevel: 1, gunDelay: 0.16, gunCost: 45, gunSpeed: 620, gunDmgMul: 0.5,
      bombLevel: 1, bombDelay: 3.0, bombCost: 500, bombSpeed: 300,
      shape: [[1.0, 0], [0.35, 0.55], [0.05, 1.0], [-0.7, 0.75], [-0.5, 0], [-0.7, -0.75], [0.05, -1.0], [0.35, -0.55]],
      accent: [[0.65, 0], [0.1, 0.35], [-0.25, 0], [0.1, -0.35]],
      deco: [[[0.3, 0.55], [-0.1, 0.95]], [[0.3, -0.55], [-0.1, -0.95]], [[-0.2, 0.7], [-0.6, 0.72]], [[-0.2, -0.7], [-0.6, -0.72]]],
      cockpit: [0.3, 0, 0.17, 0.14], engines: [[-0.55, 0.36], [-0.55, -0.36]],
    },
    leviathan: {
      label: 'Leviathan', hue: 355,
      desc: 'The dreadnought. Glacial, colossal energy, level-3 bombs that erase rooms.',
      maxEnergy: 2600, recharge: 70, thrust: 125, maxSpeed: 240, turn: 2.1,
      radius: 15, bounce: 0.4,
      gunLevel: 2, gunDelay: 0.8, gunCost: 180, gunSpeed: 560, gunDmgMul: 1.3,
      bombLevel: 3, bombDelay: 3.2, bombCost: 600, bombSpeed: 260,
      shape: [[1.05, 0], [0.55, 0.7], [-0.45, 0.95], [-1.0, 0.5], [-1.0, -0.5], [-0.45, -0.95], [0.55, -0.7]],
      accent: [[1.0, 0], [0.45, 0.4], [0.2, 0], [0.45, -0.4]],
      deco: [[[0.3, 0.72], [-0.7, 0.72]], [[0.3, -0.72], [-0.7, -0.72]], [[-0.2, 0.45], [-0.2, -0.45]]],
      cockpit: [0.35, 0, 0.24, 0.19], engines: [[-0.92, 0.28], [-0.92, -0.28]],
    },
    terrier: {
      label: 'Terrier', hue: 282,
      desc: 'Interceptor. Fastest hull in the zone — hit, run, and never stop moving.',
      maxEnergy: 1250, recharge: 120, thrust: 285, maxSpeed: 410, turn: 4.3,
      radius: 10, bounce: 0.65,
      gunLevel: 1, gunDelay: 0.3, gunCost: 80, gunSpeed: 640, gunDmgMul: 0.75,
      bombLevel: 1, bombDelay: 2.6, bombCost: 420, bombSpeed: 320,
      shape: [[1.25, 0], [-0.15, 0.55], [-0.85, 0.78], [-0.6, 0.18], [-0.6, -0.18], [-0.85, -0.78], [-0.15, -0.55]],
      accent: [[0.95, 0], [0.05, 0.3], [0.2, 0], [0.05, -0.3]],
      deco: [[[-0.05, 0.5], [-0.75, 0.72]], [[-0.05, -0.5], [-0.75, -0.72]]],
      cockpit: [0.32, 0, 0.18, 0.11], engines: [[-0.55, 0]],
    },
    weasel: {
      label: 'Weasel', hue: 55,
      desc: 'Assassin. Tiny, half-invisible, off enemy radar. Fragile as glass.',
      maxEnergy: 1000, recharge: 130, thrust: 300, maxSpeed: 430, turn: 4.8,
      radius: 8, bounce: 0.7, stealth: true,
      gunLevel: 1, gunDelay: 0.22, gunCost: 60, gunSpeed: 660, gunDmgMul: 0.6,
      bombLevel: 1, bombDelay: 3.0, bombCost: 500, bombSpeed: 320,
      shape: [[1.15, 0], [-0.35, 0.55], [-0.9, 0], [-0.35, -0.55]],
      accent: [[0.8, 0], [-0.15, 0.25], [-0.4, 0], [-0.15, -0.25]],
      deco: [[[0.1, 0.28], [-0.55, 0.28]], [[0.1, -0.28], [-0.55, -0.28]]],
      cockpit: [0.25, 0, 0.15, 0.1], engines: [[-0.55, 0]],
    },
    lancaster: {
      label: 'Lancaster', hue: 210,
      desc: 'The all-rounder. Batwing hull, dependable guns, no bad matchups.',
      maxEnergy: 1600, recharge: 115, thrust: 225, maxSpeed: 340, turn: 3.2,
      radius: 12, bounce: 0.55,
      gunLevel: 2, gunDelay: 0.42, gunCost: 110, gunSpeed: 640, gunDmgMul: 1.0,
      bombLevel: 1, bombDelay: 2.2, bombCost: 430, bombSpeed: 310,
      shape: [[1.0, 0], [0.3, 0.35], [0.5, 0.9], [-0.6, 0.85], [-0.85, 0.3], [-0.85, -0.3], [-0.6, -0.85], [0.5, -0.9], [0.3, -0.35]],
      accent: [[0.75, 0], [0.15, 0.28], [-0.2, 0], [0.15, -0.28]],
      deco: [[[0.4, 0.6], [-0.5, 0.6]], [[0.4, -0.6], [-0.5, -0.6]]],
      cockpit: [0.28, 0, 0.19, 0.15], engines: [[-0.75, 0]],
    },
    shark: {
      label: 'Shark', hue: 165,
      desc: 'Support hunter. Carries a rack of self-restocking repels and mean bombs.',
      maxEnergy: 1450, recharge: 110, thrust: 240, maxSpeed: 345, turn: 3.5,
      radius: 11, bounce: 0.6, repelStart: 3, repelCap: 4, repelRegen: 18,
      gunLevel: 1, gunDelay: 0.5, gunCost: 100, gunSpeed: 620, gunDmgMul: 0.7,
      bombLevel: 2, bombDelay: 2.0, bombCost: 440, bombSpeed: 330,
      shape: [[1.2, 0], [0.2, 0.4], [-0.5, 0.9], [-0.35, 0.15], [-0.9, 0.35], [-0.7, 0], [-0.9, -0.35], [-0.35, -0.15], [-0.5, -0.9], [0.2, -0.4]],
      accent: [[0.9, 0], [0.05, 0.25], [-0.25, 0], [0.05, -0.25]],
      deco: [[[0.15, 0.38], [-0.4, 0.75]], [[0.15, -0.38], [-0.4, -0.75]]],
      cockpit: [0.3, 0, 0.17, 0.12], engines: [[-0.68, 0]],
    },
  };

  const BOT_NAMES = ['Vexx', 'PH03N1X', 'Kansir', 'Mirage', 'Rekker', 'Slyce',
    'Nova-9', 'Duelist', 'Torch', 'Ekko', 'Blitz', 'Warpig', 'Sable', 'Quark'];
  const HUES = [8, 35, 55, 110, 150, 210, 240, 262, 300, 330, 20, 90, 180, 315];

  const PRIZE_TYPES = [
    { n: 'Full Charge', w: 3, f: s => { s.energy = s.maxEnergy; } },
    { n: 'Energy Upgrade', w: 2, ok: s => s.maxEnergy < s.t.maxEnergy * 1.5, f: s => { s.maxEnergy += 70; s.energy += 70; } },
    { n: 'Recharge Rate', w: 2, ok: s => s.recharge < s.t.recharge * 2, f: s => { s.recharge *= 1.09; } },
    { n: 'Gun Upgrade', w: 2, ok: s => s.gunLevel < 3, f: s => { s.gunLevel++; } },
    { n: 'Bomb Upgrade', w: 2, ok: s => s.bombLevel < 3, f: s => { s.bombLevel++; } },
    { n: 'MultiFire', w: 1, ok: s => !s.multi, f: s => { s.multi = true; s.multiOn = true; } },
    { n: 'Bouncing Bullets', w: 1, ok: s => !s.bounceBullets, f: s => { s.bounceBullets = true; } },
    { n: 'Repel', w: 2, ok: s => s.repels < (s.t.repelCap || 3), f: s => { s.repels++; } },
    { n: 'Burst', w: 2, ok: s => s.bursts < 3, f: s => { s.bursts++; } },
    { n: 'Rocket', w: 1, ok: s => s.rockets < 2, f: s => { s.rockets++; } },
    { n: 'Thruster', w: 2, ok: s => s.thrust < s.t.thrust * 1.5, f: s => { s.thrust *= 1.06; } },
    { n: 'Top Speed', w: 2, ok: s => s.maxSpeed < s.t.maxSpeed * 1.5, f: s => { s.maxSpeed *= 1.05; } },
  ];

  // ------------------------------------------------------------ map
  function tileSolid(W, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= MAPS || ty >= MAPS) return true;
    return W.map[ty * MAPS + tx] !== 0;
  }
  function solidAtPx(W, x, y) { return tileSolid(W, (x / TILE) | 0, (y / TILE) | 0); }
  function rectSolid(W, x, y, w, h) {
    const x0 = (x / TILE) | 0, y0 = (y / TILE) | 0;
    const x1 = ((x + w) / TILE) | 0, y1 = ((y + h) / TILE) | 0;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        if (tileSolid(W, tx, ty)) return true;
    return false;
  }
  function losClear(W, x1, y1, x2, y2) {
    const d = hyp(x2 - x1, y2 - y1), n = Math.max(1, (d / 12) | 0);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (solidAtPx(W, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
    }
    return true;
  }

  function genMap(W) {
    const rng = W.rng;
    const rn = n => (rng() * n) | 0;
    const m = new Uint8Array(MAPS * MAPS);
    const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < MAPS && y < MAPS) m[y * MAPS + x] = v; };
    const fillRect = (x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, v); };

    fillRect(0, 0, MAPS, 2, 1); fillRect(0, MAPS - 2, MAPS, 2, 1);
    fillRect(0, 0, 2, MAPS, 1); fillRect(MAPS - 2, 0, 2, MAPS, 1);

    for (let i = 0; i < 60; i++) {
      const cx = 8 + rn(MAPS - 16), cy = 8 + rn(MAPS - 16);
      switch (rn(5)) {
        case 0: fillRect(cx, cy, 2 + rn(5), 2 + rn(5), 1); break;
        case 1: {
          const w = 8 + rn(7), h = 8 + rn(7);
          fillRect(cx, cy, w, 1, 1); fillRect(cx, cy + h - 1, w, 1, 1);
          fillRect(cx, cy, 1, h, 1); fillRect(cx + w - 1, cy, 1, h, 1);
          fillRect(cx + 2 + rn(Math.max(1, w - 5)), cy, 2, 1, 0);
          fillRect(cx, cy + 2 + rn(Math.max(1, h - 5)), 1, 2, 0);
          break;
        }
        case 2: {
          const l = 3 + rn(4);
          fillRect(cx - l, cy, l * 2 + 1, 1, 1); fillRect(cx, cy - l, 1, l * 2 + 1, 1);
          break;
        }
        case 3: {
          const len = 5 + rn(6), dir = rng() < 0.5 ? 1 : -1;
          for (let k = 0; k < len; k++) { set(cx + k, cy + k * dir, 1); set(cx + k + 1, cy + k * dir, 1); }
          break;
        }
        case 4:
          for (let k = 0; k < 4 + rn(4); k++)
            fillRect(cx + rn(9) - 4, cy + rn(9) - 4, 1 + rn(2), 1 + rn(2), 1);
          break;
      }
    }

    const C = MAPS / 2, AR = 21;
    for (let ty = 0; ty < MAPS; ty++)
      for (let tx = 0; tx < MAPS; tx++)
        if (hyp(tx - C, ty - C) < AR - 1) set(tx, ty, 0);
    for (let a = 0; a < 720; a++) {
      const ang = a / 720 * TAU;
      const gate = [0, 0.25, 0.5, 0.75].some(g => Math.abs(angleNorm(ang - g * TAU)) < 0.11);
      if (!gate) {
        set(Math.round(C + Math.cos(ang) * AR), Math.round(C + Math.sin(ang) * AR), 1);
        set(Math.round(C + Math.cos(ang) * (AR + 1)), Math.round(C + Math.sin(ang) * (AR + 1)), 1);
      }
    }
    for (let i = 0; i < 8; i++) {
      const ang = i / 8 * TAU + 0.4;
      const sx = Math.round(C + Math.cos(ang) * MAPS * 0.36);
      const sy = Math.round(C + Math.sin(ang) * MAPS * 0.36);
      for (let ty = -4; ty <= 4; ty++)
        for (let tx = -4; tx <= 4; tx++)
          if (tx * tx + ty * ty <= 18) set(sx + tx, sy + ty, 0);
    }
    fillRect(0, 0, MAPS, 2, 1); fillRect(0, MAPS - 2, MAPS, 2, 1);
    fillRect(0, 0, 2, MAPS, 1); fillRect(MAPS - 2, 0, 2, MAPS, 1);
    W.map = m;
  }

  function randClearPoint(W) {
    for (let i = 0; i < 200; i++) {
      const tx = 4 + irand(MAPS - 8), ty = 4 + irand(MAPS - 8);
      let ok = true;
      for (let j = -1; j <= 1 && ok; j++)
        for (let k = -1; k <= 1 && ok; k++)
          if (tileSolid(W, tx + k, ty + j)) ok = false;
      if (ok) return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    }
    return { x: WORLD / 2, y: WORLD / 2 };
  }
  function findSpawn(W, self) {
    let best = null, bestD = -1;
    for (let i = 0; i < 40; i++) {
      const p = randClearPoint(W);
      let nearest = 1e9;
      for (const o of W.ships) {
        if (o === self || o.dead) continue;
        nearest = Math.min(nearest, hyp(o.x - p.x, o.y - p.y));
      }
      if (nearest > 420) return p;
      if (nearest > bestD) { bestD = nearest; best = p; }
    }
    return best || { x: WORLD / 2, y: WORLD / 2 };
  }

  // ------------------------------------------------------------ world
  function createWorld(opts) {
    opts = opts || {};
    const W = {
      opts,
      rng: mulberry32(opts.seed == null ? 1337 : opts.seed),
      time: 0, prizeT: 0,
      map: null,
      ships: [], bullets: [], bombs: [], prizes: [],
      events: [],
      byId: new Map(),
      nextId: 1, nextPrizeId: 1,
    };
    genMap(W);
    return W;
  }
  const ev = (W, e) => { W.events.push(e); };

  // ------------------------------------------------------------ ships
  function applyLoadoutDefaults(s) {
    const t = s.t;
    s.maxEnergy = t.maxEnergy; s.recharge = t.recharge;
    s.thrust = t.thrust; s.maxSpeed = t.maxSpeed;
    s.gunLevel = t.gunLevel; s.bombLevel = t.bombLevel;
    s.multi = false; s.multiOn = false; s.bounceBullets = false;
    s.repels = t.repelStart || 1; s.bursts = 1; s.rockets = 0;
    s.bounty = 0;
  }
  function makeShip(W, typeKey, kind, name, hue) {
    // kind: 'local' | 'bot' | 'remote'
    const t = SHIP_TYPES[typeKey];
    const s = {
      id: W.nextId++,
      type: typeKey, t, name,
      bot: kind === 'bot', remote: kind === 'remote',
      hue: hue == null ? t.hue : hue,
      x: WORLD / 2, y: WORLD / 2, vx: 0, vy: 0, angle: rand(0, TAU),
      energy: t.maxEnergy,
      gunCd: 0, bombCd: 0, repelCd: 0, burstCd: 0, rocketT: 0, regenT: 0,
      dead: false, respawn: 0, safe: 0, flash: 0,
      kills: 0, deaths: 0, score: 0,
      ctl: { turn: 0, thrust: 0, gun: false, bomb: false },
      ai: { target: null, mode: 'roam', think: rand(0, 0.2), wp: null, err: 0, dodge: 0, dodgeAngle: 0, avoid: 0, wantRepel: false },
      // ghost interpolation
      netX: 0, netY: 0, netVx: 0, netVy: 0, netA: 0, netT: 0, netTh: 0, netFrac: 1,
    };
    applyLoadoutDefaults(s);
    W.ships.push(s);
    W.byId.set(s.id, s);
    return s;
  }
  function removeShip(W, s) {
    const i = W.ships.indexOf(s);
    if (i >= 0) W.ships.splice(i, 1);
    W.byId.delete(s.id);
  }
  function spawnShip(W, s) {
    const p = findSpawn(W, s);
    s.x = p.x; s.y = p.y; s.vx = 0; s.vy = 0;
    s.angle = rand(0, TAU);
    s.energy = s.maxEnergy;
    s.dead = false; s.safe = 2.5; s.flash = 0;
    s.gunCd = 0; s.bombCd = 0; s.repelCd = 0; s.burstCd = 0; s.rocketT = 0;
    for (let i = 0; i < 2; i++) applyPrize(W, s, true);
    ev(W, { e: 'spawn', id: s.id, x: s.x, y: s.y });
  }
  function addBots(W, n) {
    const names = BOT_NAMES.slice();
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = names.length ? names.splice(irand(names.length), 1)[0] : 'Bot' + i;
      const s = makeShip(W, pick(SHIP_ORDER), 'bot', name, HUES[i % HUES.length]);
      spawnShip(W, s);
      out.push(s);
    }
    return out;
  }

  function weightedPrize(s) {
    const usable = PRIZE_TYPES.filter(p => !p.ok || p.ok(s));
    const total = usable.reduce((a, p) => a + p.w, 0);
    let roll = Math.random() * total;
    for (const p of usable) { roll -= p.w; if (roll <= 0) return p; }
    return PRIZE_TYPES[0];
  }
  function applyPrize(W, s, silent) {
    const p = weightedPrize(s);
    p.f(s);
    s.energy = Math.min(s.energy, s.maxEnergy);
    s.bounty++;
    if (!silent) ev(W, { e: 'green', id: s.id, name: p.n });
    return p.n;
  }
  function addPrize(W, x, y, id) {
    const p = { id: id == null ? W.nextPrizeId++ : id, x, y, ttl: 60, phase: rand(0, TAU) };
    W.prizes.push(p);
    return p;
  }
  function removePrizeById(W, id) {
    const i = W.prizes.findIndex(p => p.id === id);
    if (i >= 0) W.prizes.splice(i, 1);
  }

  // ------------------------------------------------------------ weapons
  function bulletDamage(s) { return (150 + 150 * s.gunLevel) * s.t.gunDmgMul; }

  function gunShots(s) {
    const multi = s.multi && s.multiOn;
    const nx = s.x + Math.cos(s.angle) * (s.t.radius + 6);
    const ny = s.y + Math.sin(s.angle) * (s.t.radius + 6);
    const spread = multi ? [-0.18, 0, 0.18] : [0];
    return spread.map(off => {
      const a = s.angle + off;
      return {
        x: nx, y: ny,
        vx: s.vx + Math.cos(a) * s.t.gunSpeed,
        vy: s.vy + Math.sin(a) * s.t.gunSpeed,
      };
    });
  }
  function spawnBullets(W, owner, shots, level, dmg, bounces) {
    for (const sh of shots) {
      W.bullets.push({
        x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy,
        life: 1.45, dmg, level, bounces, owner,
      });
    }
  }
  function fireGun(W, s) {
    if (s.gunCd > 0 || s.dead) return false;
    const multi = s.multi && s.multiOn;
    const cost = s.t.gunCost * (multi ? 1.8 : 1);
    if (s.energy <= cost) return false;
    const shots = gunShots(s);
    if (solidAtPx(W, shots[0].x, shots[0].y)) return false;
    s.energy -= cost; s.gunCd = s.t.gunDelay; s.safe = 0;
    const dmg = bulletDamage(s), bounces = s.bounceBullets ? 2 : 0;
    spawnBullets(W, s, shots, s.gunLevel, dmg, bounces);
    ev(W, { e: 'gun', id: s.id, x: s.x, y: s.y, level: s.gunLevel, dmg, bounces, shots });
    return true;
  }
  function injectGun(W, owner, msg) {
    spawnBullets(W, owner, msg.shots, msg.level, msg.dmg, msg.bounces);
  }

  function fireBomb(W, s) {
    if (s.bombCd > 0 || s.dead) return false;
    if (s.energy <= s.t.bombCost) return false;
    const nx = s.x + Math.cos(s.angle) * (s.t.radius + 8);
    const ny = s.y + Math.sin(s.angle) * (s.t.radius + 8);
    s.energy -= s.t.bombCost; s.bombCd = s.t.bombDelay; s.safe = 0;
    const b = {
      x: nx, y: ny,
      vx: s.vx + Math.cos(s.angle) * s.t.bombSpeed,
      vy: s.vy + Math.sin(s.angle) * s.t.bombSpeed,
      life: 3.4, level: s.bombLevel, bounces: s.bombLevel, owner: s,
    };
    W.bombs.push(b);
    ev(W, { e: 'bomb', id: s.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, level: b.level, bounces: b.bounces });
    return true;
  }
  function injectBomb(W, owner, msg) {
    W.bombs.push({
      x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy,
      life: 3.4, level: msg.level, bounces: msg.bounces, owner,
    });
  }

  function repelAt(W, s, x, y) {
    const R = 230;
    for (const o of W.ships) {
      if (o === s || o.dead) continue;
      const d = hyp(o.x - x, o.y - y);
      if (d < R) {
        const k = (1 - d / R) * 640, inv = 1 / Math.max(1, d);
        o.vx += (o.x - x) * inv * k;
        o.vy += (o.y - y) * inv * k;
      }
    }
    const push = b => {
      const d = hyp(b.x - x, b.y - y);
      if (b.owner !== s && d < R) {
        const sp = hyp(b.vx, b.vy) * 1.1, inv = 1 / Math.max(1, d);
        b.vx = (b.x - x) * inv * sp;
        b.vy = (b.y - y) * inv * sp;
      }
    };
    W.bullets.forEach(push); W.bombs.forEach(push);
  }
  function doRepel(W, s) {
    if (s.repels <= 0 || s.repelCd > 0 || s.dead) return false;
    s.repels--; s.repelCd = 0.8; s.safe = 0;
    repelAt(W, s, s.x, s.y);
    ev(W, { e: 'repel', id: s.id, x: s.x, y: s.y });
    return true;
  }
  function injectRepel(W, owner, msg) { repelAt(W, owner, msg.x, msg.y); }

  function burstShots(x, y, vx, vy, radius) {
    const shots = [];
    for (let i = 0; i < 20; i++) {
      const a = i / 20 * TAU;
      shots.push({
        x: x + Math.cos(a) * (radius + 4),
        y: y + Math.sin(a) * (radius + 4),
        vx: vx * 0.3 + Math.cos(a) * 500,
        vy: vy * 0.3 + Math.sin(a) * 500,
      });
    }
    return shots;
  }
  function doBurst(W, s) {
    if (s.bursts <= 0 || s.burstCd > 0 || s.dead) return false;
    s.bursts--; s.burstCd = 1; s.safe = 0;
    spawnBullets(W, s, burstShots(s.x, s.y, s.vx, s.vy, s.t.radius), 2, 240, 3);
    ev(W, { e: 'burst', id: s.id, x: s.x, y: s.y, vx: s.vx, vy: s.vy, radius: s.t.radius });
    return true;
  }
  function injectBurst(W, owner, msg) {
    spawnBullets(W, owner, burstShots(msg.x, msg.y, msg.vx, msg.vy, msg.radius), 2, 240, 3);
  }

  function fireRocket(W, s) {
    if (s.rockets <= 0 || s.rocketT > 0 || s.dead) return false;
    s.rockets--; s.rocketT = 1.7; s.safe = 0;
    ev(W, { e: 'rocket', id: s.id });
    return true;
  }

  // ------------------------------------------------------------ damage
  function damageShip(W, v, dmg, att) {
    if (v.dead || v.safe > 0) return;
    ev(W, { e: 'hit', x: v.x, y: v.y, hue: v.hue, id: v.id, dmg });
    if (v.remote) return; // their owner computes real damage
    v.energy -= dmg;
    v.flash = 0.12;
    if (v.energy < 0) killShip(W, v, att);
  }
  function killShip(W, v, att) {
    v.dead = true; v.respawn = 3; v.deaths++;
    const bounty = v.bounty;
    ev(W, {
      e: 'kill', victim: v.id, killer: att ? att.id : 0,
      vName: v.name, kName: att ? att.name : '', bounty,
      x: v.x, y: v.y, hue: v.hue,
    });
    if (att && att !== v) { att.kills++; att.score += 10 + bounty; att.bounty += 4; }
    // local/bot worlds drop greens at the wreck; online, the server does this
    if (W.opts.spawnPrizes) {
      const drops = 2 + irand(2);
      for (let i = 0; i < drops; i++) {
        if (W.prizes.length >= PRIZE_CAP + 8) break;
        const px = v.x + rand(-30, 30), py = v.y + rand(-30, 30);
        if (!solidAtPx(W, px, py)) addPrize(W, px, py);
      }
    }
    applyLoadoutDefaults(v);
  }
  function explode(W, x, y, level, owner) {
    const R = 70 + 28 * level, base = 500 + 220 * level;
    ev(W, { e: 'boom', x, y, level });
    for (const s of W.ships) {
      if (s.dead) continue;
      const d = hyp(s.x - x, s.y - y);
      if (d < R + s.t.radius) {
        const fall = 1 - clamp(d / R, 0, 1) * 0.85;
        let dmg = base * fall;
        if (s === owner) dmg *= 0.55;
        if (!s.remote) {
          const inv = 1 / Math.max(1, d);
          s.vx += (s.x - x) * inv * fall * 380;
          s.vy += (s.y - y) * inv * fall * 380;
        }
        damageShip(W, s, dmg, owner);
      }
    }
  }

  // ------------------------------------------------------------ AI
  function aiThink(W, s) {
    const a = s.ai;
    let best = null, bd = 1e9;
    for (const o of W.ships) {
      if (o === s || o.dead) continue;
      let range = 1150;
      if (o.t.stealth) range *= 0.45;
      const d = dist2(s, o);
      if (d < range && d < bd) { bd = d; best = o; }
    }
    a.target = best;
    a.err = (Math.random() - 0.5) * 0.14;
    if (best && s.energy < s.maxEnergy * 0.3 && bd < 560) a.mode = 'flee';
    else if (best) a.mode = 'fight';
    else a.mode = 'roam';

    let danger = null, dd = 1e9;
    for (const b of W.bombs) {
      if (b.owner === s) continue;
      const d = hyp(b.x - s.x, b.y - s.y);
      if (d < 300 && d < dd) { dd = d; danger = b; }
    }
    if (!danger) for (const b of W.bullets) {
      if (b.owner === s) continue;
      const d = hyp(b.x - s.x, b.y - s.y);
      if (d < 160 && d < dd) { dd = d; danger = b; }
    }
    if (danger) {
      a.dodge = 0.35;
      a.dodgeAngle = Math.atan2(danger.vy, danger.vx) + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
      if (s.repels > 0 && s.repelCd <= 0 && dd < 150) a.wantRepel = true;
    }
  }

  function updateAI(W, s, dt) {
    const a = s.ai, c = s.ctl;
    c.gun = false; c.bomb = false;
    a.think -= dt;
    if (a.think <= 0) { a.think = 0.13 + Math.random() * 0.09; aiThink(W, s); }
    if (a.wantRepel) { a.wantRepel = false; doRepel(W, s); }

    const t = a.target && !a.target.dead ? a.target : null;
    let desired = s.angle, th = 0;

    if (a.dodge > 0) {
      a.dodge -= dt;
      desired = a.dodgeAngle; th = 1;
    } else if (a.mode === 'fight' && t) {
      const dx = t.x - s.x, dy = t.y - s.y, d = hyp(dx, dy) || 1;
      const tt = d / (s.t.gunSpeed + 150);
      const aim = Math.atan2(dy + t.vy * tt, dx + t.vx * tt) + a.err;
      desired = aim;
      th = d > 340 ? 1 : d < 180 ? -0.6 : 0.25;
      const diff = Math.abs(angleNorm(aim - s.angle));
      if (diff < 0.14 && d < 640 && s.energy > s.maxEnergy * 0.3) c.gun = true;
      if (s.bombCd <= 0 && diff < 0.09 && d > 230 && d < 800 &&
          s.energy > s.t.bombCost + 350 && losClear(W, s.x, s.y, t.x, t.y)) c.bomb = true;
      if (d < 170 && s.bursts > 0 && s.burstCd <= 0) doBurst(W, s);
      if (s.rockets > 0 && d > 700 && s.energy > s.maxEnergy * 0.7 && Math.random() < 0.003) fireRocket(W, s);
    } else if (a.mode === 'flee' && t) {
      desired = Math.atan2(s.y - t.y, s.x - t.x); th = 1;
      if (dist2(s, t) < 240 && s.repels > 0 && s.repelCd <= 0) doRepel(W, s);
      if (s.rockets > 0 && s.rocketT <= 0) fireRocket(W, s);
    } else {
      if (!a.wp || hyp(a.wp.x - s.x, a.wp.y - s.y) < 90) {
        let pz = null, pd = 800;
        for (const p of W.prizes) {
          const d = hyp(p.x - s.x, p.y - s.y);
          if (d < pd) { pd = d; pz = p; }
        }
        a.wp = pz ? { x: pz.x, y: pz.y } : randClearPoint(W);
      }
      desired = Math.atan2(a.wp.y - s.y, a.wp.x - s.x); th = 0.85;
    }

    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
    if (solidAtPx(W, s.x + ca * 70, s.y + sa * 70) || solidAtPx(W, s.x + ca * 40, s.y + sa * 40)) {
      const L = solidAtPx(W, s.x + Math.cos(s.angle - 0.9) * 70, s.y + Math.sin(s.angle - 0.9) * 70);
      const R = solidAtPx(W, s.x + Math.cos(s.angle + 0.9) * 70, s.y + Math.sin(s.angle + 0.9) * 70);
      if (!a.avoid) a.avoid = Math.random() < 0.5 ? 1 : -1;
      desired = s.angle + (L && !R ? 1.6 : R && !L ? -1.6 : a.avoid * 2.2);
      th = Math.min(th, 0.15);
    } else a.avoid = 0;

    c.turn = clamp(angleNorm(desired - s.angle) * 4, -1, 1);
    c.thrust = th;
  }

  // ------------------------------------------------------------ ship update
  function updateShip(W, s, dt) {
    if (s.dead) {
      if (!s.remote) {
        s.respawn -= dt;
        if (s.respawn <= 0) spawnShip(W, s);
      }
      return;
    }
    if (s.remote) {
      // ghost: chase last network state with dead reckoning
      s.netT += dt;
      const tx = s.netX + s.netVx * s.netT;
      const ty = s.netY + s.netVy * s.netT;
      const k = Math.min(1, dt * 10);
      s.x += (tx - s.x) * k;
      s.y += (ty - s.y) * k;
      s.vx = s.netVx; s.vy = s.netVy;
      s.angle += angleNorm(s.netA - s.angle) * Math.min(1, dt * 12);
      s.ctl.thrust = s.netTh;
      s.energy = s.netFrac * s.maxEnergy;
      if (s.flash > 0) s.flash -= dt;
      if (s.safe > 0) s.safe -= dt;
      return;
    }
    if (s.bot) updateAI(W, s, dt);
    const c = s.ctl;

    s.angle += c.turn * s.t.turn * dt;

    let th = c.thrust;
    let maxSp = s.maxSpeed;
    let power = s.thrust;
    if (s.rocketT > 0) {
      s.rocketT -= dt;
      th = 1; maxSp *= 1.9; power *= 2.6;
    }
    if (th !== 0) {
      const p = power * (th > 0 ? th : th * 0.6);
      s.vx += Math.cos(s.angle) * p * dt;
      s.vy += Math.sin(s.angle) * p * dt;
    }
    const sp = hyp(s.vx, s.vy);
    if (sp > maxSp) {
      const k = Math.max(maxSp / sp, 1 - 2.5 * dt);
      s.vx *= k; s.vy *= k;
    }

    const r = s.t.radius;
    const nx = s.x + s.vx * dt;
    if (rectSolid(W, nx - r, s.y - r, r * 2, r * 2)) {
      if (Math.abs(s.vx) > 120) ev(W, { e: 'shipBounce', x: s.x, y: s.y });
      s.vx *= -s.t.bounce;
    } else s.x = nx;
    const ny = s.y + s.vy * dt;
    if (rectSolid(W, s.x - r, ny - r, r * 2, r * 2)) {
      if (Math.abs(s.vy) > 120) ev(W, { e: 'shipBounce', x: s.x, y: s.y });
      s.vy *= -s.t.bounce;
    } else s.y = ny;
    s.x = clamp(s.x, TILE * 2 + r, WORLD - TILE * 2 - r);
    s.y = clamp(s.y, TILE * 2 + r, WORLD - TILE * 2 - r);

    s.energy = Math.min(s.maxEnergy, s.energy + s.recharge * dt);
    s.gunCd -= dt; s.bombCd -= dt; s.repelCd -= dt; s.burstCd -= dt;
    if (s.safe > 0) s.safe -= dt;
    if (s.flash > 0) s.flash -= dt;

    // shark repel rack regen
    if (s.t.repelRegen) {
      s.regenT += dt;
      if (s.regenT >= s.t.repelRegen) {
        s.regenT = 0;
        if (s.repels < (s.t.repelCap || 3)) {
          s.repels++;
          ev(W, { e: 'restock', id: s.id });
        }
      }
    }

    if (c.gun) fireGun(W, s);
    if (c.bomb) fireBomb(W, s);

    // greens: each peer only handles pickups for ships it owns
    for (let i = W.prizes.length - 1; i >= 0; i--) {
      const p = W.prizes[i];
      if (hyp(p.x - s.x, p.y - s.y) < s.t.radius + 11) {
        W.prizes.splice(i, 1);
        ev(W, { e: 'take', id: s.id, prize: p.id, x: p.x, y: p.y });
        applyPrize(W, s, false);
      }
    }
  }

  // ------------------------------------------------------------ projectiles
  function updateBullets(W, dt) {
    for (let i = W.bullets.length - 1; i >= 0; i--) {
      const b = W.bullets[i];
      b.life -= dt;
      if (b.life <= 0) { W.bullets.splice(i, 1); continue; }
      let dead = false;
      const h = dt / 2;
      for (let step = 0; step < 2 && !dead; step++) {
        const bx = b.x + b.vx * h;
        if (solidAtPx(W, bx, b.y)) {
          if (b.bounces > 0) { b.bounces--; b.vx = -b.vx; }
          else { ev(W, { e: 'bhit', x: b.x, y: b.y }); dead = true; break; }
        } else b.x = bx;
        const by = b.y + b.vy * h;
        if (solidAtPx(W, b.x, by)) {
          if (b.bounces > 0) { b.bounces--; b.vy = -b.vy; }
          else { ev(W, { e: 'bhit', x: b.x, y: b.y }); dead = true; break; }
        } else b.y = by;
        for (const s of W.ships) {
          if (s.dead || s === b.owner) continue;
          if (hyp(s.x - b.x, s.y - b.y) < s.t.radius + 3) {
            damageShip(W, s, b.dmg, b.owner);
            dead = true; break;
          }
        }
      }
      if (dead) W.bullets.splice(i, 1);
    }
  }

  function updateBombs(W, dt) {
    for (let i = W.bombs.length - 1; i >= 0; i--) {
      const b = W.bombs[i];
      b.life -= dt;
      if (b.life <= 0) { W.bombs.splice(i, 1); continue; }
      let boom = false;
      const h = dt / 2;
      for (let step = 0; step < 2 && !boom; step++) {
        const bx = b.x + b.vx * h;
        if (solidAtPx(W, bx, b.y)) {
          if (b.bounces > 0) { b.bounces--; b.vx = -b.vx; }
          else boom = true;
        } else b.x = bx;
        if (boom) break;
        const by = b.y + b.vy * h;
        if (solidAtPx(W, b.x, by)) {
          if (b.bounces > 0) { b.bounces--; b.vy = -b.vy; }
          else boom = true;
        } else b.y = by;
        if (boom) break;
        const prox = 22 + 8 * b.level;
        for (const s of W.ships) {
          if (s.dead || s === b.owner) continue;
          if (hyp(s.x - b.x, s.y - b.y) < s.t.radius + prox) { boom = true; break; }
        }
      }
      if (boom) {
        W.bombs.splice(i, 1);
        explode(W, b.x, b.y, b.level, b.owner);
      }
    }
  }

  // ------------------------------------------------------------ tick
  function updateWorld(W, dt) {
    W.time += dt;
    if (W.opts.spawnPrizes) {
      W.prizeT -= dt;
      if (W.prizeT <= 0) {
        W.prizeT = 1.4;
        if (W.prizes.length < PRIZE_CAP) {
          const p = randClearPoint(W);
          const pr = addPrize(W, p.x, p.y);
          ev(W, { e: 'prizeSpawn', prize: pr.id, x: pr.x, y: pr.y });
        }
      }
      for (let i = W.prizes.length - 1; i >= 0; i--) {
        W.prizes[i].ttl -= dt;
        if (W.prizes[i].ttl <= 0) {
          ev(W, { e: 'prizeGone', prize: W.prizes[i].id });
          W.prizes.splice(i, 1);
        }
      }
    }
    for (const s of W.ships) updateShip(W, s, dt);
    updateBullets(W, dt);
    updateBombs(W, dt);
  }
  function drainEvents(W) {
    const out = W.events;
    W.events = [];
    return out;
  }

  return {
    TAU, TILE, MAPS, WORLD, STEP, PRIZE_CAP,
    SHIP_ORDER, SHIP_TYPES, PRIZE_TYPES, BOT_NAMES, HUES,
    clamp, rand, irand, pick, angleNorm, mulberry32,
    tileSolid, solidAtPx, rectSolid, losClear, randClearPoint, findSpawn,
    createWorld, makeShip, removeShip, spawnShip, addBots,
    applyLoadoutDefaults, applyPrize, addPrize, removePrizeById,
    fireGun, fireBomb, doRepel, doBurst, fireRocket,
    injectGun, injectBomb, injectRepel, injectBurst,
    damageShip, killShip, explode,
    updateWorld, drainEvents,
  };
});
