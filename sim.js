/* =========================================================================
   INTERSTELLAR — shared simulation core
   Runs identically in the browser (window.SIM) and Node (module.exports).
   No DOM, no audio, no rendering — pure world state + events.

   Netcode model (owner-trusting relay):
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
  // ENDLESS-scale space: a GRID x GRID lattice of QUADRANTS, each a full
  // classic-zone sector (1024 tiles / 16384px). At 7x7 that's 49 sectors,
  // 115km corner to corner — the tile field is stored SPARSELY (space is
  // ~99.5% empty, so only chunks containing built structure exist in
  // memory), which makes world size nearly free. The center quadrant is
  // the contested core; the four corners belong to the squads.
  const QUAD = 1024;
  const GRID = 7;
  const MAPS = QUAD * GRID;
  const WORLD = TILE * MAPS;
  const QUADPX = TILE * QUAD;
  const TCH = 64;                        // tiles per sparse-store chunk edge
  const TCHROW = Math.ceil(MAPS / TCH);  // chunks per row (key stride)
  const STEP = 1 / 60;
  const PRIZE_CAP = 220;

  // the four squads that anchor the corner quadrants
  const FACTIONS = {
    1: { name: 'CRIMSON PACT', hue: 358, qx: 0, qy: 0 },
    2: { name: 'COBALT COMBINE', hue: 215, qx: GRID - 1, qy: 0 },
    3: { name: 'EMBER SYNDICATE', hue: 28, qx: 0, qy: GRID - 1 },
    4: { name: 'VIOLET DOMINION', hue: 278, qx: GRID - 1, qy: GRID - 1 },
  };

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const rand = (a, b) => a === undefined ? Math.random() : a + Math.random() * (b - a);
  const irand = n => (Math.random() * n) | 0;
  const pick = arr => arr[irand(arr.length)];
  // 2-arg hypot without Math.hypot's overflow-safe scaling — ~5x faster in
  // the collision loops, and our operands never exceed the world size
  const hyp = (a, b) => Math.sqrt(a * a + b * b);
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
  // The Interstellar fleet. Visual fields (shape/accent/deco/cockpit/
  // engines) are unit-space polygons scaled by radius at draw time, nose +x.
  const SHIP_ORDER = ['corsair', 'meteor', 'hornet', 'titan', 'comet', 'dagger', 'paladin', 'warden',
    'vanguard', 'aegis', 'reaper', 'phantom'];
  const SHIP_TYPES = {
    corsair: {
      label: 'Corsair', damp: 0.28, hue: 192,
      desc: 'The duelist. Heavy single shots — one clean hit swings a fight.',
      maxEnergy: 1500, recharge: 105, thrust: 235, maxSpeed: 350, turn: 3.4,
      radius: 11, bounce: 0.6,
      gunLevel: 2, gunDelay: 0.55, gunCost: 150, gunSpeed: 680, gunDmgMul: 1.15,
      bombLevel: 1, bombDelay: 2.4, bombCost: 400, bombSpeed: 300,
      shape: [[1.35, 0], [-0.55, 0.95], [-0.3, 0], [-0.55, -0.95]],
      accent: [[1.0, 0], [-0.2, 0.38], [-0.05, 0], [-0.2, -0.38]],
      deco: [[[0.25, 0.42], [-0.42, 0.8]], [[0.25, -0.42], [-0.42, -0.8]]],
      cockpit: [0.38, 0, 0.2, 0.13], engines: [[-0.4, 0]],
    },
    meteor: {
      label: 'Meteor', damp: 0.22, hue: 18, proxStart: 1,
      desc: 'Bomber. Factory proximity fuses — its splash artillery detonates near hulls.',
      maxEnergy: 1700, recharge: 95, thrust: 200, maxSpeed: 310, turn: 3.0,
      radius: 12, bounce: 0.5,
      gunLevel: 1, gunDelay: 0.6, gunCost: 120, gunSpeed: 600, gunDmgMul: 0.9,
      bombLevel: 2, bombDelay: 1.8, bombCost: 450, bombSpeed: 340,
      shape: [[1.15, 0], [0.15, 0.5], [-0.4, 1.0], [-0.75, 0.55], [-0.6, 0], [-0.75, -0.55], [-0.4, -1.0], [0.15, -0.5]],
      accent: [[0.85, 0], [0.1, 0.3], [-0.3, 0], [0.1, -0.3]],
      deco: [[[0.1, 0.5], [-0.35, 0.9]], [[0.1, -0.5], [-0.35, -0.9]]],
      cockpit: [0.32, 0, 0.19, 0.13], engines: [[-0.62, 0.3], [-0.62, -0.3]],
    },
    hornet: {
      label: 'Hornet', damp: 0.3, hue: 130, radarStealth: true,
      desc: 'Bullet hose. Relentless fire, monster recharge — and it ghosts off enemy radar.',
      maxEnergy: 1400, recharge: 135, thrust: 215, maxSpeed: 330, turn: 3.6,
      radius: 11, bounce: 0.55,
      gunLevel: 1, gunDelay: 0.16, gunCost: 45, gunSpeed: 620, gunDmgMul: 0.5,
      bombLevel: 1, bombDelay: 3.0, bombCost: 500, bombSpeed: 300,
      shape: [[1.0, 0], [0.35, 0.55], [0.05, 1.0], [-0.7, 0.75], [-0.5, 0], [-0.7, -0.75], [0.05, -1.0], [0.35, -0.55]],
      accent: [[0.65, 0], [0.1, 0.35], [-0.25, 0], [0.1, -0.35]],
      deco: [[[0.3, 0.55], [-0.1, 0.95]], [[0.3, -0.55], [-0.1, -0.95]], [[-0.2, 0.7], [-0.6, 0.72]], [[-0.2, -0.7], [-0.6, -0.72]]],
      cockpit: [0.3, 0, 0.17, 0.14], engines: [[-0.55, 0.36], [-0.55, -0.36]],
    },
    titan: {
      label: 'Titan', damp: 0.12, hue: 355,
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
    comet: {
      label: 'Comet', damp: 0.45, hue: 282, dualGuns: true, dualShotMul: 0.62,
      desc: 'Interceptor. Twin linked cannons, fastest hull in the zone — hit and run.',
      maxEnergy: 1250, recharge: 120, thrust: 285, maxSpeed: 410, turn: 4.3,
      radius: 10, bounce: 0.65,
      gunLevel: 1, gunDelay: 0.3, gunCost: 80, gunSpeed: 640, gunDmgMul: 0.75,
      bombLevel: 1, bombDelay: 2.6, bombCost: 420, bombSpeed: 320,
      shape: [[1.25, 0], [-0.15, 0.55], [-0.85, 0.78], [-0.6, 0.18], [-0.6, -0.18], [-0.85, -0.78], [-0.15, -0.55]],
      accent: [[0.95, 0], [0.05, 0.3], [0.2, 0], [0.05, -0.3]],
      deco: [[[-0.05, 0.5], [-0.75, 0.72]], [[-0.05, -0.5], [-0.75, -0.72]]],
      cockpit: [0.32, 0, 0.18, 0.11], engines: [[-0.55, 0]],
    },
    dagger: {
      label: 'Dagger', damp: 0.5, hue: 55,
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
    paladin: {
      label: 'Paladin', damp: 0.25, hue: 210, bombBounce: 3,
      desc: 'The all-rounder. Dependable guns and bombs that ricochet down corridors.',
      maxEnergy: 1600, recharge: 115, thrust: 225, maxSpeed: 340, turn: 3.2,
      radius: 12, bounce: 0.55,
      gunLevel: 2, gunDelay: 0.42, gunCost: 110, gunSpeed: 640, gunDmgMul: 1.0,
      bombLevel: 1, bombDelay: 2.2, bombCost: 430, bombSpeed: 310,
      shape: [[1.0, 0], [0.3, 0.35], [0.5, 0.9], [-0.6, 0.85], [-0.85, 0.3], [-0.85, -0.3], [-0.6, -0.85], [0.5, -0.9], [0.3, -0.35]],
      accent: [[0.75, 0], [0.15, 0.28], [-0.2, 0], [0.15, -0.28]],
      deco: [[[0.4, 0.6], [-0.5, 0.6]], [[0.4, -0.6], [-0.5, -0.6]]],
      cockpit: [0.28, 0, 0.19, 0.15], engines: [[-0.75, 0]],
    },
    warden: {
      label: 'Warden', damp: 0.28, hue: 165,
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
    // ---- NOVA class: the new generation ----
    vanguard: {
      label: 'Vanguard', damp: 0.28, hue: 45, cls: 'nova',
      desc: 'Nova-class gunship. Ships factory MultiFire — a wall of lead from spawn.',
      maxEnergy: 1450, recharge: 110, thrust: 240, maxSpeed: 345, turn: 3.5,
      radius: 11, bounce: 0.6, startMulti: true,
      gunLevel: 2, gunDelay: 0.4, gunCost: 130, gunSpeed: 640, gunDmgMul: 0.95,
      bombLevel: 1, bombDelay: 2.4, bombCost: 430, bombSpeed: 310,
      shape: [[1.3, 0], [0.35, 0.3], [0.0, 0.95], [-0.55, 0.75], [-0.35, 0.25], [-0.85, 0.45], [-0.7, 0], [-0.85, -0.45], [-0.35, -0.25], [-0.55, -0.75], [0.0, -0.95], [0.35, -0.3]],
      accent: [[1.0, 0], [0.2, 0.18], [-0.3, 0], [0.2, -0.18]],
      deco: [[[0.1, 0.6], [-0.4, 0.62]], [[0.1, -0.6], [-0.4, -0.62]]],
      cockpit: [0.35, 0, 0.18, 0.11], engines: [[-0.75, 0.18], [-0.75, -0.18]],
    },
    aegis: {
      label: 'Aegis', damp: 0.15, hue: 215, cls: 'nova',
      desc: 'Nova-class bastion. Composite plating shrugs off a quarter of all damage.',
      maxEnergy: 1900, recharge: 100, thrust: 190, maxSpeed: 300, turn: 2.8,
      radius: 13, bounce: 0.45, armor: 0.72, repelStart: 2,
      gunLevel: 1, gunDelay: 0.5, gunCost: 120, gunSpeed: 600, gunDmgMul: 0.9,
      bombLevel: 2, bombDelay: 2.4, bombCost: 470, bombSpeed: 300,
      shape: [[0.95, 0], [0.55, 0.75], [-0.35, 1.0], [-0.95, 0.6], [-0.95, -0.6], [-0.35, -1.0], [0.55, -0.75]],
      accent: [[0.85, 0], [0.3, 0.5], [0.1, 0], [0.3, -0.5]],
      deco: [[[-0.15, 0.8], [-0.8, 0.5]], [[-0.15, -0.8], [-0.8, -0.5]]],
      cockpit: [0.2, 0, 0.22, 0.17], engines: [[-0.85, 0.3], [-0.85, -0.3]],
    },
    reaper: {
      label: 'Reaper', damp: 0.3, hue: 275, cls: 'nova',
      desc: 'Nova-class leech. Every hit you land feeds stolen energy back to your banks.',
      maxEnergy: 1350, recharge: 85, thrust: 235, maxSpeed: 355, turn: 3.7,
      radius: 11, bounce: 0.6, leech: 0.3,
      gunLevel: 2, gunDelay: 0.5, gunCost: 140, gunSpeed: 650, gunDmgMul: 1.0,
      bombLevel: 1, bombDelay: 2.6, bombCost: 450, bombSpeed: 310,
      shape: [[1.25, 0], [0.15, 0.35], [-0.2, 1.05], [-0.75, 0.8], [-0.45, 0.25], [-0.7, 0], [-0.45, -0.25], [-0.75, -0.8], [-0.2, -1.05], [0.15, -0.35]],
      accent: [[0.9, 0], [0.05, 0.22], [-0.35, 0], [0.05, -0.22]],
      deco: [[[0.0, 0.5], [-0.55, 0.85]], [[0.0, -0.5], [-0.55, -0.85]]],
      cockpit: [0.3, 0, 0.16, 0.11], engines: [[-0.55, 0]],
    },
    phantom: {
      label: 'Phantom', damp: 0.5, hue: 320, cls: 'nova',
      desc: 'Nova-class blink-fighter. R warps you 240m forward — straight through walls.',
      maxEnergy: 1200, recharge: 125, thrust: 260, maxSpeed: 390, turn: 4.4,
      radius: 10, bounce: 0.65, blink: true,
      gunLevel: 1, gunDelay: 0.26, gunCost: 70, gunSpeed: 660, gunDmgMul: 0.7,
      bombLevel: 1, bombDelay: 3.0, bombCost: 500, bombSpeed: 320,
      shape: [[1.2, 0], [0.5, 0.22], [-0.1, 0.85], [-0.8, 0.6], [-0.5, 0.18], [-0.5, -0.18], [-0.8, -0.6], [-0.1, -0.85], [0.5, -0.22]],
      accent: [[0.95, 0], [0.3, 0.15], [-0.1, 0], [0.3, -0.15]],
      deco: [[[0.2, 0.4], [-0.55, 0.55]], [[0.2, -0.4], [-0.55, -0.55]]],
      cockpit: [0.4, 0, 0.15, 0.09], engines: [[-0.6, 0.35], [-0.6, -0.35]],
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
    { n: 'Proximity Fuse', w: 2, ok: s => s.proxPlus < 2, f: s => { s.proxPlus++; } },
    { n: 'Repel', w: 2, ok: s => s.repels < (s.t.repelCap || 3), f: s => { s.repels++; } },
    { n: 'Burst', w: 2, ok: s => s.bursts < 3, f: s => { s.bursts++; } },
    { n: 'Rocket', w: 1, ok: s => s.rockets < 2, f: s => { s.rockets++; } },
    { n: 'Thruster', w: 2, ok: s => s.thrust < s.t.thrust * 1.5, f: s => { s.thrust *= 1.06; } },
    { n: 'Top Speed', w: 2, ok: s => s.maxSpeed < s.t.maxSpeed * 1.5, f: s => { s.maxSpeed *= 1.05; } },
  ];

  // ------------------------------------------------------------ map
  // sparse tile field: the world rim is a formula, empty space costs
  // nothing, and only chunks something was built in are allocated
  function tileSolid(W, tx, ty) {
    if (tx < 2 || ty < 2 || tx >= MAPS - 2 || ty >= MAPS - 2) return true;
    const ch = W.tiles.get(((tx / TCH) | 0) * TCHROW + ((ty / TCH) | 0));
    return ch ? ch[(ty % TCH) * TCH + (tx % TCH)] !== 0 : false;
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
    const style = W.opts.mapStyle || 'nexus';
    W.tiles = new Map();
    const set = (x, y, v) => {
      if (x < 2 || y < 2 || x >= MAPS - 2 || y >= MAPS - 2) return;
      const k = ((x / TCH) | 0) * TCHROW + ((y / TCH) | 0);
      let ch = W.tiles.get(k);
      if (!ch) {
        if (!v) return;                  // clearing empty space is free
        ch = new Uint8Array(TCH * TCH);
        W.tiles.set(k, ch);
      }
      ch[(y % TCH) * TCH + (x % TCH)] = v;
    };
    const fillRect = (x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, v); };

    // The sector is OPEN SPACE. What structure exists was BUILT — or broke
    // apart out here. The architecture has logic: a citadel at the heart of
    // the sector, a ring of guard stations on the approaches to the core, a
    // few frontier depots deep in the black, asteroid belts where rubble
    // actually belongs, and the odd drifting derelict as a landmark.
    const MC = MAPS / 2;
    const clearings = [
      { x: MC, y: MC, r: 30 },            // arena + its approaches
      { x: MC - 60, y: MC, r: 26 },       // west staging field (blue flank)
      { x: MC + 60, y: MC, r: 26 },       // east staging field (red flank)
      { x: MC, y: MC - 62, r: 20 },       // north field
      { x: MC, y: MC + 62, r: 20 },       // south field
    ];
    const inClearing = (x, y, margin) =>
      clearings.some(cl => hyp(x - cl.x, y - cl.y) < cl.r + (margin || 0));

    const bases = [];
    const nearBase = (x, y, m) => bases.some(b => hyp(x - b.x, y - b.y) < b.r + (m || 0));
    // wallRect: rectangle wall with centered gates on every side — the
    // symmetric, gated look of something DESIGNED
    const wallRect = (x0, y0, x1, y1, g) => {
      const mx = (x0 + x1) >> 1, my = (y0 + y1) >> 1;
      for (let x = x0; x <= x1; x++)
        if (Math.abs(x - mx) > g) { set(x, y0, 1); set(x, y1, 1); }
      for (let y = y0; y <= y1; y++)
        if (Math.abs(y - my) > g) { set(x0, y, 1); set(x1, y, 1); }
    };
    const stampBase = (bx, by, kind) => {
      bx = Math.round(bx); by = Math.round(by);
      if (kind === 0) {
        // FORT: concentric walled compound — gates on all four approaches,
        // corner bastions, a command block at the heart
        const h = 11 + rn(4);
        wallRect(bx - h, by - h, bx + h, by + h, 2);
        wallRect(bx - h + 5, by - h + 5, bx + h - 5, by + h - 5, 2);
        fillRect(bx - 1, by - 1, 3, 3, 1);
        for (const [ux, uy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
          fillRect(bx + ux * h - 1, by + uy * h - 1, 3, 3, 1);
        bases.push({ x: bx, y: by, r: h + 3 });
      } else if (kind === 1) {
        // STATION: cross-armed dock — a hollow core, four flight corridors,
        // docking bays with mouths open to space at each arm's end
        const L = 9 + rn(4);
        fillRect(bx - 2, by - 2, 5, 5, 1);
        fillRect(bx - 1, by - 1, 3, 3, 0);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let k = 3; k <= L + 1; k++) {
            set(bx + dx * k + dy * 2, by + dy * k + dx * 2, 1);
            set(bx + dx * k - dy * 2, by + dy * k - dx * 2, 1);
          }
          const px = bx + dx * (L + 3), py = by + dy * (L + 3);
          fillRect(px - 2, py - 2, 5, 5, 1);
          fillRect(px - 1, py - 1, 3, 3, 0);
          if (dx === 1) fillRect(px + 2, py - 1, 1, 3, 0);
          else if (dx === -1) fillRect(px - 2, py - 1, 1, 3, 0);
          else if (dy === 1) fillRect(px - 1, py + 2, 3, 1, 0);
          else fillRect(px - 1, py - 2, 3, 1, 0);
        }
        bases.push({ x: bx, y: by, r: L + 6 });
      } else {
        // YARD: hangar rows behind a gated perimeter — a shipyard, its
        // berths lined up with mechanical regularity
        const w = 12 + rn(4), hh = 8 + rn(3);
        wallRect(bx - w, by - hh, bx + w, by + hh, 3);
        for (const ry of [by - 4, by + 4])
          for (let x = bx - w + 3; x <= bx + w - 3; x++)
            if (Math.abs(x - bx) > 2) set(x, ry, 1);
        bases.push({ x: bx, y: by, r: Math.max(w, hh) + 3 });
      }
    };

    // guard stations ring the core at the approach radius — you pass them
    // on every run into the arena
    const nGuard = style === 'rings' ? 4 : 6;
    for (let i = 0; i < nGuard; i++) {
      const ang = i / nGuard * TAU + rng() * 0.5;
      const rad = QUAD * (0.2 + rng() * 0.08);
      stampBase(MC + Math.cos(ang) * rad, MC + Math.sin(ang) * rad, rn(3));
    }
    // frontier depots: most quadrants get a destination of their own, so
    // however far you roam there's somewhere to dock and something to raid
    for (let qy = 0; qy < GRID; qy++) {
      for (let qx = 0; qx < GRID; qx++) {
        const isCore = qx === (GRID >> 1) && qy === (GRID >> 1);
        const isFaction = Object.values(FACTIONS).some(F => F.qx === qx && F.qy === qy);
        if (isCore || isFaction || rng() < 0.25) continue;
        const bx = qx * QUAD + (QUAD >> 1) + rn(QUAD >> 1) - (QUAD >> 2);
        const by = qy * QUAD + (QUAD >> 1) + rn(QUAD >> 1) - (QUAD >> 2);
        stampBase(bx, by, rn(3));
        if (rng() < 0.3) stampBase(bx + 90 + rn(120), by + rn(160) - 80, rn(3));  // twin outpost
      }
    }

    // FACTION FORTRESSES: each squad's home sits at the heart of its corner
    // quadrant — triple-walled, gated on the axis toward the core, with the
    // mothership anchored in the keep
    W.motherships = {};
    for (const team of [1, 2, 3, 4]) {
      const F = FACTIONS[team];
      const bx = F.qx * QUAD + (QUAD >> 1), by = F.qy * QUAD + (QUAD >> 1);
      wallRect(bx - 26, by - 26, bx + 26, by + 26, 4);
      wallRect(bx - 17, by - 17, bx + 17, by + 17, 5);
      for (const [ux, uy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        fillRect(bx + ux * 26 - 2, by + uy * 26 - 2, 5, 5, 1);
        fillRect(bx + ux * 17 - 1, by + uy * 17 - 1, 3, 3, 1);
      }
      bases.push({ x: bx, y: by, r: 30 });
      W.motherships[team] = { team, x: (bx + 0.5) * TILE, y: (by + 0.5) * TILE };
    }

    // asteroid belts: rubble lives in BANDS around the sector, not
    // sprinkled everywhere — navigable arcs with real gaps
    const nBelt = style === 'rings' ? 4 : style === 'gauntlet' ? 6 : 8;
    for (let b = 0; b < nBelt; b++) {
      const a0 = rng() * TAU, span = 0.6 + rng() * 1.0;
      const rad = MAPS * (0.16 + rng() * 0.3);
      const wob = 5 + rn(8);
      const steps = Math.round(rad * span);
      for (let i = 0; i < steps; i++) {
        if (rng() < 0.62) continue;
        const ang = a0 + (i / steps) * span;
        const rr = rad + (rng() - 0.5) * wob * 2;
        const x = Math.round(MC + Math.cos(ang) * rr), y = Math.round(MC + Math.sin(ang) * rr);
        if (x < 6 || y < 6 || x > MAPS - 6 || y > MAPS - 6) continue;
        if (inClearing(x, y, 4) || nearBase(x, y, 8)) continue;
        fillRect(x, y, 1 + rn(3), 1 + rn(3), 1);
      }
    }

    // derelicts: lone broken hulls drifting in the deep — landmarks, cover,
    // and proof that people flew out here once
    for (let i = 0; i < 240; i++) {
      const x = 30 + rn(MAPS - 60), y = 30 + rn(MAPS - 60);
      if (inClearing(x, y, 10) || nearBase(x, y, 16) || hyp(x - MC, y - MC) < 60) continue;
      const w = 4 + rn(5), h = 3 + rn(4);
      fillRect(x, y, w, 1, 1); fillRect(x, y + h, w, 1, 1);
      fillRect(x, y, 1, h, 1);
      if (rng() < 0.6) fillRect(x + w - 1, y, 1, h, 1);
      fillRect(x + 1 + rn(Math.max(1, w - 2)), y, 2, 1, 0);   // hull breach
    }

    const C = MAPS / 2, AR = 21;
    const drawRing = (radius, gates, gateHalf) => {
      const steps = Math.max(720, radius * 40);
      for (let a = 0; a < steps; a++) {
        const ang = a / steps * TAU;
        const gate = gates.some(g => Math.abs(angleNorm(ang - g * TAU)) < gateHalf);
        if (!gate) {
          set(Math.round(C + Math.cos(ang) * radius), Math.round(C + Math.sin(ang) * radius), 1);
          set(Math.round(C + Math.cos(ang) * (radius + 1)), Math.round(C + Math.sin(ang) * (radius + 1)), 1);
        }
      }
    };
    // carve the battlegrounds clean (structures that leaned in get trimmed),
    // then the arena interior. Carving per-clearing keeps generation fast
    // even at a million tiles — a whole-map scan against every clearing
    // would take seconds.
    for (const cl of clearings.concat([{ x: C, y: C, r: AR - 1 }])) {
      const x0 = Math.max(2, Math.floor(cl.x - cl.r)), x1 = Math.min(MAPS - 2, Math.ceil(cl.x + cl.r) + 1);
      const y0 = Math.max(2, Math.floor(cl.y - cl.r)), y1 = Math.min(MAPS - 2, Math.ceil(cl.y + cl.r) + 1);
      for (let ty = y0; ty < y1; ty++)
        for (let tx = x0; tx < x1; tx++)
          if (hyp(tx - cl.x, ty - cl.y) < cl.r) set(tx, ty, 0);
    }
    drawRing(AR, [0, 0.25, 0.5, 0.75], 0.11);
    if (style === 'rings') {
      // concentric battle rings around the core
      drawRing(45, [0.125, 0.375, 0.625, 0.875], 0.05);
      drawRing(70, [0, 0.166, 0.333, 0.5, 0.666, 0.833], 0.035);
    }
    if (style === 'gauntlet') {
      // long broken corridor walls channel the core's fights into lanes
      const Q0 = (GRID >> 1) * QUAD;   // the core quadrant's origin
      for (let i = 0; i < 14; i++) {
        const horiz = rng() < 0.5;
        const len = 40 + rn(80);
        const px = Q0 + 10 + rn(QUAD - 20 - (horiz ? len : 0));
        const py = Q0 + 10 + rn(QUAD - 20 - (horiz ? 0 : len));
        let gapAt = 6 + rn(8);
        for (let k = 0; k < len; k++) {
          if (k === gapAt) { k += 3; gapAt = k + 8 + rn(8); continue; }
          const x = horiz ? px + k : px, y = horiz ? py : py + k;
          if (hyp(x - C, y - C) < AR + 4) continue;   // keep the arena clean
          if (inClearing(x, y, 0)) continue;          // and the open fields
          set(x, y, 1);
          set(horiz ? x : x + 1, horiz ? y + 1 : y, 1);
        }
      }
    }
    // bases in world px — prize caches spawn around them, giving every
    // installation a reason to be visited (and fought over)
    W.bases = bases.map(b => ({ x: (b.x + 0.5) * TILE, y: (b.y + 0.5) * TILE, r: b.r * TILE }));
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
  // A clear point in the mid-sector disc around the arena — the hotspot where
  // the population concentrates. The frontier beyond is for roaming, prize
  // runs, and long chases, not for respawn commutes.
  function midSectorPoint(W) {
    // hotspot radius is capped in absolute terms: however vast the sector,
    // the population concentrates in a fightable core and the rest is
    // frontier — that's what makes a distant contact worth chasing
    const HOT = Math.min(MAPS * 0.3, 190);
    for (let i = 0; i < 60; i++) {
      const a = rand(0, TAU), rr = Math.sqrt(rand()) * HOT;
      const tx = (MAPS / 2 + Math.cos(a) * rr) | 0, ty = (MAPS / 2 + Math.sin(a) * rr) | 0;
      let ok = true;
      for (let j = -1; j <= 1 && ok; j++)
        for (let k = -1; k <= 1 && ok; k++)
          if (tileSolid(W, tx + k, ty + j)) ok = false;
      if (ok) return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    }
    return randClearPoint(W);
  }
  function findSpawn(W, self) {
    let best = null, bestD = -1;
    for (let i = 0; i < 40; i++) {
      const p = midSectorPoint(W);
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
    genDanger(W);
    return W;
  }
  const ev = (W, e) => { W.events.push(e); };

  // ------------------------------------------------------------ the maelstrom
  // A danger zone in the frontier: a swirling storm of rock that tears
  // hulls on contact, seeded with wormholes that swallow the unwary and
  // spit them out inside it. Rock paths are CLOSED-FORM functions of world
  // time (epicycles around the storm's eye), so every client computes
  // identical positions from the shared seed — no netcode required.
  function genDanger(W) {
    const rng = W.rng;
    let cx = WORLD / 2 + WORLD * 0.3, cy = WORLD / 2;
    for (let i = 0; i < 60; i++) {
      const a = rng() * TAU, rad = WORLD * (0.28 + rng() * 0.1);
      const x = WORLD / 2 + Math.cos(a) * rad, y = WORLD / 2 + Math.sin(a) * rad;
      if (x < 3200 || y < 3200 || x > WORLD - 3200 || y > WORLD - 3200) continue;
      if ((W.bases || []).some(b => hyp(x - b.x, y - b.y) < b.r + 2800)) continue;
      cx = x; cy = y; break;
    }
    const R = 2300;
    W.danger = { x: cx, y: cy, r: R };
    W.rocks = [];
    for (let i = 0; i < 22; i++) {
      const r1 = 150 + rng() * (R - 400);
      W.rocks.push({
        r1,
        w1: (0.07 + rng() * 0.2) * (rng() < 0.5 ? -1 : 1) * (1.35 - (r1 / R) * 0.7),
        p1: rng() * TAU,
        a2: 40 + rng() * 150, w2: 0.3 + rng() * 1.1, p2: rng() * TAU,
        rad: 15 + rng() * 20, spin: (rng() - 0.5) * 2, shape: (rng() * 1e9) | 0,
      });
    }
    // three gates in normal space open INTO the storm; a fourth at the
    // storm's rim leads back toward the citadel — the way home
    W.wormholes = [];
    for (let i = 0; i < 6; i++) {
      let x = WORLD / 2 + 2000 + i * 900, y = WORLD / 2 + 2000;
      for (let t = 0; t < 40; t++) {
        const a = rng() * TAU, rad = WORLD * (0.14 + rng() * 0.3);
        const px = WORLD / 2 + Math.cos(a) * rad, py = WORLD / 2 + Math.sin(a) * rad;
        if (px < 900 || py < 900 || px > WORLD - 900 || py > WORLD - 900) continue;
        if (hyp(px - cx, py - cy) < R + 900) continue;
        if ((W.bases || []).some(b => hyp(px - b.x, py - b.y) < b.r + 600)) continue;
        if (rectSolid(W, px - 70, py - 70, 140, 140)) continue;
        x = px; y = py; break;
      }
      const da = rng() * TAU, dr = rng() * R * 0.45;
      W.wormholes.push({ x, y, dx: cx + Math.cos(da) * dr, dy: cy + Math.sin(da) * dr });
    }
    const ea = rng() * TAU;
    W.wormholes.push({
      x: cx + Math.cos(ea) * R * 0.9, y: cy + Math.sin(ea) * R * 0.9,
      dx: WORLD / 2 + Math.cos(ea) * 950, dy: WORLD / 2 + Math.sin(ea) * 950,
    });
    // faction gates: a jump from each squad's fortress door straight to the
    // core's rim — territory means a safe rear base WITH a lane to the war
    for (const team of [1, 2, 3, 4]) {
      const ms = W.motherships && W.motherships[team];
      if (!ms) continue;
      const ddx = WORLD / 2 - ms.x, ddy = WORLD / 2 - ms.y;
      const L = hyp(ddx, ddy) || 1;
      W.wormholes.push({
        x: ms.x + (ddx / L) * 560, y: ms.y + (ddy / L) * 560, r: 90, gate: team,
        dx: WORLD / 2 - (ddx / L) * 2800, dy: WORLD / 2 - (ddy / L) * 2800,
      });
    }

    // THE DEAD ZONE: one edge quadrant belongs to nobody and never will —
    // marauder country, relic-rich, no law
    const dzc = [[GRID >> 1, 0], [0, GRID >> 1], [GRID - 1, GRID >> 1], [GRID >> 1, GRID - 1]];
    const dqx = (cx / QUADPX) | 0, dqy = (cy / QUADPX) | 0;
    let dz = dzc[(rng() * 4) | 0];
    if (dz[0] === dqx && dz[1] === dqy) dz = dzc.find(c => c[0] !== dqx || c[1] !== dqy);
    W.deadZone = { qx: dz[0], qy: dz[1] };
    terrInit(W);

    // RELIC SLOTS: rare tech needed for top-tier upgrades, cached only in
    // dangerous places — the storm's heart, the dead zone, rival fortress
    // quadrants, and the belts. Deterministic positions; slots respawn 240s
    // after being salvaged.
    W.relicSlots = [];
    for (let i = 0; i < 14; i++) {
      const r = rng();
      let x, y;
      if (r < 0.3) {                       // the maelstrom's interior
        const a = rng() * TAU, rr = Math.sqrt(rng()) * R * 0.7;
        x = cx + Math.cos(a) * rr; y = cy + Math.sin(a) * rr;
      } else if (r < 0.55) {               // the dead zone
        x = (W.deadZone.qx + 0.15 + rng() * 0.7) * QUADPX;
        y = (W.deadZone.qy + 0.15 + rng() * 0.7) * QUADPX;
      } else if (r < 0.8) {                // a rival fortress quadrant
        const F = FACTIONS[1 + ((rng() * 4) | 0)];
        x = (F.qx + 0.12 + rng() * 0.76) * QUADPX;
        y = (F.qy + 0.12 + rng() * 0.76) * QUADPX;
      } else {                             // out along a belt band
        const a = rng() * TAU, rr = WORLD * (0.16 + rng() * 0.3);
        x = WORLD / 2 + Math.cos(a) * rr; y = WORLD / 2 + Math.sin(a) * rr;
      }
      x = clamp(x, 800, WORLD - 800); y = clamp(y, 800, WORLD - 800);
      // seeded: every peer must place this relic at the exact same point
      const p = findClearNear(W, x, y, rng) || { x, y };
      W.relicSlots.push({ x: p.x, y: p.y, taken: -999 });
    }

    // DERELICT CACHES: salvage worth credits, strewn across the whole map so
    // the deep frontier always has something to find. Common, quick, and
    // respawning — this is what makes a long burn pay for itself.
    W.caches = [];
    for (let i = 0; i < 200; i++) {
      const cx2 = 500 + rng() * (WORLD - 1000), cy2 = 500 + rng() * (WORLD - 1000);
      const p = findClearNear(W, cx2, cy2, rng);
      if (p) W.caches.push({ x: p.x, y: p.y, taken: -999 });
    }
  }
  // ------------------------------------------------------------ territory
  const quadOf = (x, y) => ({
    qx: clamp((x / QUADPX) | 0, 0, GRID - 1),
    qy: clamp((y / QUADPX) | 0, 0, GRID - 1),
  });
  const qKey = (qx, qy) => qy * GRID + qx;
  function terrOwner(W, x, y) {
    // inlined quadrant math — this runs per teamed ship per step
    if (!W.terr) return 0;
    const qx = clamp((x / QUADPX) | 0, 0, GRID - 1), qy = clamp((y / QUADPX) | 0, 0, GRID - 1);
    const t = W.terr[qy * GRID + qx];
    return t ? t.own : 0;
  }
  function terrInit(W) {
    W.terr = {};
    for (const team of [1, 2, 3, 4]) {
      const F = FACTIONS[team];
      W.terr[qKey(F.qx, F.qy)] = { own: team, home: team, p: {} };
    }
  }
  // presence converts quadrants: sole majority for 45 accumulated seconds
  // flips a frontier quadrant. Homes never fall, the core is forever
  // contested, and no law reaches the dead zone.
  function terrTick(W, tick) {
    const MID = GRID >> 1;
    const pres = {};
    for (const s of W.ships) {
      if (s.dead || !s.team || s.team > 4) continue;
      const q = quadOf(s.x, s.y);
      const k = qKey(q.qx, q.qy);
      const row = pres[k] || (pres[k] = {});
      row[s.team] = (row[s.team] || 0) + 1;
    }
    // capture progress erodes in ABSENCE too — 44s of pressure must not sit
    // frozen forever in an empty quadrant waiting for one ship to finish it
    for (const k in W.terr) {
      if (pres[k]) continue;
      const T = W.terr[k];
      for (const tm in T.p) {
        T.p[tm] = Math.max(0, T.p[tm] - tick * 0.5);
        if (!T.p[tm]) delete T.p[tm];
      }
    }
    for (const k in pres) {
      const kn = +k, qx = kn % GRID, qy = (kn / GRID) | 0;
      if (qx === MID && qy === MID) continue;
      if (W.deadZone && W.deadZone.qx === qx && W.deadZone.qy === qy) continue;
      const T = W.terr[kn] || (W.terr[kn] = { own: 0, p: {} });
      if (T.home) continue;
      let top = 0, topN = 0, second = 0;
      for (const tm in pres[k]) {
        const n = pres[k][tm];
        if (n > topN) { second = topN; topN = n; top = +tm; }
        else if (n > second) second = n;
      }
      if (top && topN > second) {
        if (top === T.own) { T.p = {}; continue; }
        T.p[top] = (T.p[top] || 0) + tick;
        if (T.p[top] >= 45) {
          const prev = T.own;
          T.own = top; T.p = {};
          ev(W, { e: 'capture', qx, qy, team: top, prev });
        }
      } else {
        for (const tm in T.p) T.p[tm] = Math.max(0, T.p[tm] - tick * 0.5);
      }
    }
  }

  // ------------------------------------------------------------ events
  // Generated events on a DETERMINISTIC timeline (a pure function of seed
  // and world time, like the storm rocks) — every client computes the same
  // asteroid shower, marauder raid, or stellar collapse at the same moment.
  const EV_PERIOD = 70, EV_LEAD = 18;
  function evRnd(W, idx, n) {
    // murmur3 finalizer: consecutive indices must decorrelate fully
    let h = (((W.opts.seed | 0) >>> 0) + Math.imul(idx + 1, 0x9E3779B1) + Math.imul(n + 1, 0x85EBCA77)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function evActive(W) {
    if (!W.danger) return null;
    const idx = Math.floor(W.time / EV_PERIOD);
    const r0 = evRnd(W, idx, 0);
    const start = idx * EV_PERIOD + 12 + r0 * 18;
    const type = r0 < 0.4 ? 'shower' : r0 < 0.75 ? 'marauders' : 'nova';
    const dur = type === 'shower' ? 45 : type === 'marauders' ? 55 : EV_LEAD + 6;
    if (W.time < start || W.time > start + dur) return null;
    let qx, qy;
    if (evRnd(W, idx, 1) < 0.35 && W.deadZone) { qx = W.deadZone.qx; qy = W.deadZone.qy; }
    else {
      qx = (evRnd(W, idx, 2) * GRID) | 0;
      qy = (evRnd(W, idx, 3) * GRID) | 0;
      for (const t in FACTIONS) {
        const F = FACTIONS[t];
        if (F.qx === qx && F.qy === qy) { qx = GRID >> 1; qy = (qy + 1) % GRID; break; }
      }
    }
    const x = (qx + 0.3 + evRnd(W, idx, 4) * 0.4) * QUADPX;
    const y = (qy + 0.3 + evRnd(W, idx, 5) * 0.4) * QUADPX;
    return { idx, type, start, end: start + dur, t: W.time - start, qx, qy, x, y };
  }
  // shower rocks streak across the event zone on straight closed-form paths
  function showerRockAt(W, E, i) {
    const r = a => evRnd(W, E.idx, 10 + i * 5 + a);
    const ang = r(0) * TAU, sp = 460 + r(1) * 380;
    const off = (r(2) - 0.5) * QUADPX * 0.85;
    const px = Math.cos(ang), py = Math.sin(ang);
    const span = QUADPX * 1.25;
    const prog = ((E.t * sp + r(3) * span) % span) - span / 2;
    return {
      x: E.x + px * prog - py * off, y: E.y + py * prog + px * off,
      vx: px * sp, vy: py * sp, rad: 12 + r(4) * 14, shape: (r(2) * 1e9) | 0, spin: (r(3) - 0.5) * 3,
    };
  }

  // pirates: hostile to every squad, worth a bounty, and they do not despawn
  function spawnMarauder(W, x, y, spread) {
    const m = makeShip(W, pick(['dagger', 'reaper', 'comet']), 'bot', 'Marauder', null, 5);
    m.marauder = true;
    m.ai.skill = 0.8;
    m.bounty = 60;                   // their heads are worth credits
    spawnShip(W, m);
    const r = spread || 500;
    const p = findClearNear(W, x + rand(-r, r), y + rand(-r, r)) || { x, y };
    m.x = p.x; m.y = p.y;
    ev(W, { e: 'raider', id: m.id, name: m.name, ship: m.type, hue: m.hue, x: m.x, y: m.y });
    return m;
  }
  // the Dead Zone is never safe: a standing pirate presence lives there
  function seedDeadZone(W, n) {
    if (!W.deadZone) return [];
    const cx = (W.deadZone.qx + 0.5) * QUADPX, cy = (W.deadZone.qy + 0.5) * QUADPX;
    const out = [];
    for (let i = 0; i < n; i++) {
      const m = spawnMarauder(W, cx, cy, QUADPX * 0.35);
      m.ai.patrolQ = W.deadZone.qy * GRID + W.deadZone.qx;
      out.push(m);
    }
    return out;
  }

  function rockAt(W, rk, t) {
    const a1 = rk.p1 + rk.w1 * t, a2 = rk.p2 + rk.w2 * t;
    return {
      x: W.danger.x + Math.cos(a1) * rk.r1 + Math.cos(a2) * rk.a2,
      y: W.danger.y + Math.sin(a1) * rk.r1 + Math.sin(a2) * rk.a2,
      vx: -Math.sin(a1) * rk.r1 * rk.w1 - Math.sin(a2) * rk.a2 * rk.w2,
      vy: Math.cos(a1) * rk.r1 * rk.w1 + Math.cos(a2) * rk.a2 * rk.w2,
    };
  }

  // ------------------------------------------------------------ ships
  function applyLoadoutDefaults(s) {
    const t = s.t;
    s.maxEnergy = t.maxEnergy; s.recharge = t.recharge;
    s.thrust = t.thrust; s.maxSpeed = t.maxSpeed;
    s.gunLevel = t.gunLevel; s.bombLevel = t.bombLevel;
    s.multi = !!t.startMulti; s.multiOn = !!t.startMulti;
    s.proxPlus = t.proxStart || 0;
    s.repels = t.repelStart || 1; s.bursts = 1; s.rockets = 0;
    s.bounty = 0;
  }
  function makeShip(W, typeKey, kind, name, hue, team) {
    // kind: 'local' | 'bot' | 'remote'; team 0 = free-for-all
    const t = SHIP_TYPES[typeKey];
    const s = {
      id: W.nextId++,
      type: typeKey, t, name,
      bot: kind === 'bot', remote: kind === 'remote',
      team: team || 0, streak: 0,
      hue: hue == null ? t.hue : hue,
      x: WORLD / 2, y: WORLD / 2, vx: 0, vy: 0, angle: rand(0, TAU),
      energy: t.maxEnergy,
      gunCd: 0, bombCd: 0, repelCd: 0, burstCd: 0, rocketT: 0, regenT: 0, blinkCd: 0, warpCd: 0,
      dormant: false,
      dead: false, respawn: 0, safe: 0, flash: 0,
      rockT: 0, wormT: 0, novaT: 0,   // hazard grace timers
      kills: 0, deaths: 0, score: 0,
      ctl: { turn: 0, thrust: 0, strafe: 0, gun: false, bomb: false },
      ai: { target: null, mode: 'roam', think: rand(0, 0.2), wp: null, err: 0, dodge: 0, dodgeAngle: 0, avoid: 0, wantRepel: false, skill: 0.5, patrolQ: null, escort: 0 },
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
  // rngf: pass W.rng when the RESULT must be identical on every peer (world
  // generation). Unseeded Math.random is fine for gameplay-time placement.
  function findClearNear(W, x, y, rngf) {
    for (let rad = 0; rad < 320; rad += 26) {
      for (let k = 0; k < 8; k++) {
        const a = (rngf ? rngf() : Math.random()) * TAU;
        const px = clamp(x + Math.cos(a) * rad, TILE * 3, WORLD - TILE * 3);
        const py = clamp(y + Math.sin(a) * rad, TILE * 3, WORLD - TILE * 3);
        if (!rectSolid(W, px - 20, py - 20, 40, 40)) return { x: px, y: py };
      }
    }
    return null;
  }
  function spawnShip(W, s) {
    let p = null, ang = null;
    if (W.opts.spawnPoint) {
      const sp = W.opts.spawnPoint(s);
      if (sp) {
        p = findClearNear(W, sp.x, sp.y);
        if (p && sp.angle != null) ang = sp.angle;
      }
    }
    if (!p) p = findSpawn(W, s);
    s.x = p.x; s.y = p.y; s.vx = 0; s.vy = 0;
    s.angle = ang == null ? rand(0, TAU) : ang;
    s.energy = s.maxEnergy;
    s.dead = false; s.flash = 0;
    s.safe = W.opts.safeTime == null ? 2.5 : W.opts.safeTime;
    s.gunCd = 0; s.bombCd = 0; s.repelCd = 0; s.burstCd = 0; s.rocketT = 0;
    for (let i = 0; i < 2; i++) applyPrize(W, s, true);
    ev(W, { e: 'spawn', id: s.id, x: s.x, y: s.y });
  }
  function addBots(W, n) {
    const names = BOT_NAMES.slice();
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = names.length ? names.splice(irand(names.length), 1)[0] : 'Bot' + i;
      const s = makeShip(W, pick(SHIP_ORDER), 'bot', name);   // ship-identity hue
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
    // upgrade-economy ships (the MMO layer) don't power up from greens —
    // they salvage them for credits instead; the pickup event still fires
    if (s.noGreens) {
      s.energy = s.maxEnergy;
      if (!silent) ev(W, { e: 'green', id: s.id, name: 'Salvage', credit: 1 });
      return 'Salvage';
    }
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
    const shots = [];
    const push = (off, side) => {
      const a = s.angle + off;
      // side offsets shift the muzzle perpendicular to the nose (twin cannons)
      const px = nx + Math.cos(s.angle + Math.PI / 2) * side;
      const py = ny + Math.sin(s.angle + Math.PI / 2) * side;
      shots.push({
        x: px, y: py,
        vx: s.vx + Math.cos(a) * s.t.gunSpeed,
        vy: s.vy + Math.sin(a) * s.t.gunSpeed,
      });
    };
    if (s.t.dualGuns) {
      const w = s.t.radius * 0.45;
      push(0, -w); push(0, w);
    } else push(0, 0);
    if (multi) { push(-0.18, 0); push(0.18, 0); }
    return shots;
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
    // all bullets ricochet — walls are part of your aim
    const dmg = bulletDamage(s) * (s.t.dualShotMul || 1);
    const bounces = 2;
    spawnBullets(W, s, shots, s.gunLevel, dmg, bounces);
    ev(W, { e: 'gun', id: s.id, x: s.x, y: s.y, level: s.gunLevel, dmg, bounces, shots });
    return true;
  }
  const fin = v => Number.isFinite(v);
  function injectGun(W, owner, msg) {
    if (!Array.isArray(msg.shots)) return;
    for (const s of msg.shots) if (!s || !fin(s.x) || !fin(s.y) || !fin(s.vx) || !fin(s.vy)) return;
    const dmg = clamp(+msg.dmg || 0, 0, 900);   // negative dmg would HEAL targets
    spawnBullets(W, owner, msg.shots, msg.level, dmg, clamp(+msg.bounces || 0, 0, 3));
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
      life: 3.4, level: s.bombLevel,
      // ricocheting bombs are a HULL SPECIALTY, not standard issue — every
      // other ship's bomb detonates on the wall it hits
      bounces: s.t.bombBounce || 0,
      // a bomb you can't quite land is no fun: the fuse ring is generous
      // enough that a near miss still counts, and greens widen it a lot
      prox: 30 + 9 * s.bombLevel + 28 * s.proxPlus,
      owner: s,
    };
    W.bombs.push(b);
    ev(W, { e: 'bomb', id: s.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, level: b.level, bounces: b.bounces, prox: b.prox });
    return true;
  }
  function injectBomb(W, owner, msg) {
    if (!fin(msg.x) || !fin(msg.y) || !fin(msg.vx) || !fin(msg.vy)) return;
    W.bombs.push({
      x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy,
      life: 3.4, level: clamp(+msg.level || 1, 1, 3), bounces: clamp(+msg.bounces || 0, 0, 5),
      prox: clamp(+msg.prox || 30, 0, 160), owner,
    });
  }

  function repelAt(W, s, x, y) {
    const R = 300;   // repels are a huge factor — make them felt
    for (const o of W.ships) {
      if (o === s || o.dead) continue;
      const d = hyp(o.x - x, o.y - y);
      if (d < R) {
        const k = (1 - d / R) * 820, inv = 1 / Math.max(1, d);
        o.vx += (o.x - x) * inv * k;
        o.vy += (o.y - y) * inv * k;
      }
    }
    const push = b => {
      const d = hyp(b.x - x, b.y - y);
      if (b.owner !== s && d < 300) {
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
  function injectRepel(W, owner, msg) { if (fin(msg.x) && fin(msg.y)) repelAt(W, owner, msg.x, msg.y); }

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
    if (!fin(msg.x) || !fin(msg.y)) return;
    spawnBullets(W, owner, burstShots(msg.x, msg.y, +msg.vx || 0, +msg.vy || 0, clamp(+msg.radius || 90, 0, 200)), 2, 240, 3);
  }

  function fireRocket(W, s) {
    if (s.rockets <= 0 || s.rocketT > 0 || s.dead) return false;
    s.rockets--; s.rocketT = 1.7; s.safe = 0;
    ev(W, { e: 'rocket', id: s.id });
    return true;
  }

  function warpToBeacon(W, s) {
    // squad play: jump to your team's Comet, wherever the fight is
    if (s.dead || s.warpCd > 0 || s.energy <= 450 || !s.team) return false;
    let best = null, bd = 1e9;
    for (const o of W.ships) {
      if (o === s || o.dead || o.team !== s.team || o.type !== 'comet') continue;
      const d = dist2(s, o);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best || bd < 500) return false;
    const p = findClearNear(W, best.x + rand(-90, 90), best.y + rand(-90, 90));
    if (!p) return false;
    s.energy -= 450; s.warpCd = 18; s.safe = 0;
    const x0 = s.x, y0 = s.y;
    s.x = p.x; s.y = p.y;
    s.vx = best.vx; s.vy = best.vy;
    ev(W, { e: 'warp', id: s.id, x0, y0, x1: s.x, y1: s.y, hue: s.hue });
    return true;
  }

  function doBlink(W, s) {
    if (!s.t.blink || s.blinkCd > 0 || s.dead) return false;
    if (s.energy <= 350) return false;
    const r = s.t.radius;
    const nx = s.x + Math.cos(s.angle) * 240;
    const ny = s.y + Math.sin(s.angle) * 240;
    if (nx < TILE * 2 + r || ny < TILE * 2 + r || nx > WORLD - TILE * 2 - r || ny > WORLD - TILE * 2 - r) return false;
    if (rectSolid(W, nx - r, ny - r, r * 2, r * 2)) return false;
    s.energy -= 350; s.blinkCd = 5; s.safe = 0;
    const x0 = s.x, y0 = s.y;
    s.x = nx; s.y = ny;
    ev(W, { e: 'blink', id: s.id, x0, y0, x1: nx, y1: ny, hue: s.hue });
    return true;
  }

  // ------------------------------------------------------------ damage
  function damageShip(W, v, dmg, att) {
    if (v.dead || v.safe > 0) return;
    if (att && att !== v && v.team && att.team === v.team) return; // no friendly fire
    if (v.t.armor) dmg *= v.t.armor;
    ev(W, { e: 'hit', x: v.x, y: v.y, hue: v.hue, id: v.id, dmg, att: att ? att.id : 0 });
    if (v.remote) return; // their owner computes real damage
    v.energy -= dmg;
    v.flash = 0.12;
    // reaper leech: local attackers are credited here; remote attackers are
    // credited over the wire via the 'hit' event -> leech message
    if (att && att !== v && !att.dead && !att.remote && att.t.leech) {
      att.energy = Math.min(att.maxEnergy, att.energy + dmg * att.t.leech);
    }
    if (v.energy < 0) killShip(W, v, att);
  }
  function killShip(W, v, att) {
    v.dead = true; v.respawn = W.opts.respawnDelay || 3; v.deaths++;
    v.streak = 0;
    const bounty = v.bounty;
    if (att && att !== v) { att.kills++; att.score += 10 + bounty; att.bounty += 4; att.streak++; }
    ev(W, {
      e: 'kill', victim: v.id, killer: att ? att.id : 0,
      vName: v.name, kName: att ? att.name : '', bounty,
      x: v.x, y: v.y, hue: v.hue,
      vTeam: v.team, kTeam: att ? att.team : 0,
      kStreak: att && att !== v ? att.streak : 0,
    });
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
      if (s !== owner && owner && s.team && s.team === owner.team) continue; // bombs spare teammates
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
    const skill = a.skill == null ? 0.5 : a.skill;
    let best = null, bd = 1e9;
    for (const o of W.ships) {
      if (o === s || o.dead) continue;
      if (s.team && o.team === s.team) continue;          // never hunt teammates
      let range = s.team ? 2200 : 1400;                    // squads seek the fight
      if (o.t.stealth) range *= 0.45;
      const d = dist2(s, o);
      if (d < range && d < bd) { bd = d; best = o; }
    }
    a.target = best;
    a.err = (Math.random() - 0.5) * 0.2 * (1.2 - skill);
    if (best && s.energy < s.maxEnergy * (0.34 - skill * 0.18) && bd < 560) a.mode = 'flee';
    else if (best) a.mode = 'fight';
    else a.mode = 'roam';

    let danger = null, dd = 1e9;
    for (const b of W.bombs) {
      if (b.owner === s || (s.team && b.owner && b.owner.team === s.team)) continue;
      const d = hyp(b.x - s.x, b.y - s.y);
      if (d < 300 && d < dd) { dd = d; danger = b; }
    }
    if (!danger) for (const b of W.bullets) {
      if (b.owner === s || (s.team && b.owner && b.owner.team === s.team)) continue;
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
    if (a.think <= 0) {
      const skill = a.skill == null ? 0.5 : a.skill;
      a.think = 0.08 + (1 - skill) * 0.12 + Math.random() * 0.06;
      aiThink(W, s);
    }
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
      if (s.t.blink && s.blinkCd <= 0 && s.energy > 600 &&
          Math.abs(angleNorm(desired - s.angle)) < 0.4) doBlink(W, s);
      if (s.rockets > 0 && s.rocketT <= 0) fireRocket(W, s);
    } else {
      // wingmates: no target means form on the leader, not wander off
      const ldr = a.escort ? W.byId.get(a.escort) : null;
      if (ldr && !ldr.dead) {
        const dl = hyp(ldr.x - s.x, ldr.y - s.y);
        if (dl > 340) {
          a.wp = { x: ldr.x + rand(-170, 170), y: ldr.y + rand(-170, 170) };
        } else if (dl < 120) {
          a.wp = null;
          desired = s.angle; th = 0;
          c.turn = clamp(angleNorm(ldr.angle - s.angle) * 3, -1, 1);
          c.thrust = 0;
          return;
        }
      }
      if (!a.wp || hyp(a.wp.x - s.x, a.wp.y - s.y) < 90) {
        let pz = null, pd = 800;
        for (const p of W.prizes) {
          const d = hyp(p.x - s.x, p.y - s.y);
          if (d < pd) { pd = d; pz = p; }
        }
        // no green in reach. Patrol pilots work their assigned quadrant so
        // the frontier is inhabited instead of empty; everyone else drifts
        // back toward the mid-sector hotspot or wanders locally — never a
        // blind trek across 100km of nothing
        if (pz) a.wp = { x: pz.x, y: pz.y };
        else if (a.patrolQ != null) {
          const px2 = (a.patrolQ % GRID + 0.12 + Math.random() * 0.76) * QUADPX;
          const py2 = (((a.patrolQ / GRID) | 0) + 0.12 + Math.random() * 0.76) * QUADPX;
          a.wp = solidAtPx(W, px2, py2) ? midSectorPoint(W) : { x: px2, y: py2 };
        } else if (Math.random() < 0.6) a.wp = midSectorPoint(W);
        else {
          const a2 = rand(0, TAU), rr2 = rand(1200, 4200);
          const nx = clamp(s.x + Math.cos(a2) * rr2, TILE * 4, WORLD - TILE * 4);
          const ny = clamp(s.y + Math.sin(a2) * rr2, TILE * 4, WORLD - TILE * 4);
          a.wp = solidAtPx(W, nx, ny) ? midSectorPoint(W) : { x: nx, y: ny };
        }
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
      if (!s.remote && !s.dormant) {
        s.respawn -= dt;
        if (s.respawn <= 0) spawnShip(W, s);
      }
      return;
    }
    if (s.remote) {
      if (W.opts.ghostInterp && s.snaps && s.snaps.length) {
        // jitter-buffered interpolation: render ~100ms in the past, lerping
        // between timestamped snapshots; extrapolate briefly on packet loss
        const snaps = s.snaps;
        const tt = (W.opts.now ? W.opts.now() : 0) - 0.1;
        while (snaps.length > 2 && snaps[1].rt <= tt) snaps.shift();
        const last = snaps[snaps.length - 1];
        if (snaps.length >= 2 && tt <= last.rt) {
          const p0 = snaps[0], p1 = snaps[1];
          const span = Math.max(1e-4, p1.rt - p0.rt);
          const f = clamp((tt - p0.rt) / span, 0, 1);
          s.x = p0.x + (p1.x - p0.x) * f;
          s.y = p0.y + (p1.y - p0.y) * f;
          s.angle = p0.a + angleNorm(p1.a - p0.a) * f;
        } else {
          const ex = clamp(tt - last.rt, 0, 0.15);
          s.x = last.x + last.vx * ex;
          s.y = last.y + last.vy * ex;
          s.angle = last.a;
        }
        s.vx = last.vx; s.vy = last.vy;
        s.ctl.thrust = last.th;
        s.energy = last.frac * s.maxEnergy;
      } else {
        // dead reckoning fallback (used by the server's ghost view)
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
      }
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
      // real backthrust: reversing is a fighting move, not a suggestion
      const p = power * (th > 0 ? th : th * 0.85);
      s.vx += Math.cos(s.angle) * p * dt;
      s.vy += Math.sin(s.angle) * p * dt;
    }
    // lateral strafe thrusters: full omnidirectional control
    if (c.strafe) {
      const sp2 = power * 0.75 * clamp(c.strafe, -1, 1);
      s.vx += Math.cos(s.angle + Math.PI / 2) * sp2 * dt;
      s.vy += Math.sin(s.angle + Math.PI / 2) * sp2 * dt;
    }
    // coast damping: hands-off means the ship settles instead of drifting
    // forever — agile hulls (Dagger, Comet, Phantom) stop crisply, heavies
    // (Titan, Aegis) keep their momentum. Inertia still rules mid-fight.
    if (th === 0 && !c.strafe && s.rocketT <= 0) {
      const kd = 1 - (s.t.damp == null ? 0.25 : s.t.damp) * dt;
      s.vx *= kd; s.vy *= kd;
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

    // warden aura: allied wardens nearby boost recharge; the mothership's
    // shadow rearms its squad far faster still
    let rech = s.recharge;
    if (s.team) {
      const ms = W.motherships && W.motherships[s.team];
      if (ms && hyp(ms.x - s.x, ms.y - s.y) < 700) rech *= 2.4;
      else if (terrOwner(W, s.x, s.y) === s.team) rech *= 1.3;  // held ground favors its holders
      for (const o of (W._wardens || [])) {
        if (o === s || o.team !== s.team) continue;
        if (hyp(o.x - s.x, o.y - s.y) < 170) { rech *= 1.35; break; }
      }
    }
    s.energy = Math.min(s.maxEnergy, s.energy + rech * dt);
    s.gunCd -= dt; s.bombCd -= dt; s.repelCd -= dt; s.burstCd -= dt; s.blinkCd -= dt; s.warpCd -= dt;
    if (s.safe > 0) s.safe -= dt;
    if (s.flash > 0) s.flash -= dt;

    // warden repel rack regen
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
          if (s.team && b.owner && s.team === b.owner.team) continue; // pass through teammates
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
        for (const s of W.ships) {
          if (s.dead || s === b.owner) continue;
          if (s.team && b.owner && s.team === b.owner.team) continue;
          if (hyp(s.x - b.x, s.y - b.y) < s.t.radius + (b.prox || 15)) { boom = true; break; }
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
          // a third of the greens cache around installations — bases are
          // supply depots, worth flying to and worth fighting over — and a
          // share falls inside the maelstrom: the best loot sits in the storm
          // in an endless world, loot follows the population: bases,
          // the maelstrom, and the contested mid-sector get most of it —
          // the rest scatters for the far roamers to stumble on
          let p = null;
          const roll = Math.random();
          if (W.bases && W.bases.length && roll < 0.35) {
            const b = W.bases[irand(W.bases.length)];
            p = findClearNear(W, b.x + rand(-0.6, 0.6) * b.r, b.y + rand(-0.6, 0.6) * b.r);
          } else if (W.danger && roll < 0.5) {
            const a = rand(0, TAU), rr = Math.sqrt(rand()) * W.danger.r * 0.85;
            p = findClearNear(W, W.danger.x + Math.cos(a) * rr, W.danger.y + Math.sin(a) * rr);
          } else if (roll < 0.78) {
            p = midSectorPoint(W);
          }
          if (!p) p = randClearPoint(W);
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
    // territorial war: presence flips quadrants (authority world only —
    // online clients apply the server's capture broadcasts instead)
    if (W.terr && W.opts.authority) {
      W.terrT = (W.terrT || 0) + dt;
      if (W.terrT >= 1) { terrTick(W, W.terrT); W.terrT = 0; }
    }

    // generated events: showers, raids, stellar collapse — all computed
    // from the shared deterministic timeline
    const EVT = W.evt = evActive(W);
    if (EVT) {
      if (EVT.type === 'shower') {
        for (const s of W.ships) {
          if (s.dead || s.remote || s.rockT > 0) continue;
          if (Math.abs(s.x - EVT.x) > QUADPX * 0.8 || Math.abs(s.y - EVT.y) > QUADPX * 0.8) continue;
          for (let i = 0; i < 12; i++) {
            const q = showerRockAt(W, EVT, i);
            const d = hyp(s.x - q.x, s.y - q.y);
            if (d < q.rad + s.t.radius) {
              const rel = hyp(s.vx - q.vx, s.vy - q.vy);
              const inv = 1 / Math.max(1, d);
              s.vx += (s.x - q.x) * inv * (160 + rel * 0.35);
              s.vy += (s.y - q.y) * inv * (160 + rel * 0.35);
              s.rockT = 0.7;
              ev(W, { e: 'rockhit', id: s.id, x: q.x, y: q.y, rel });
              damageShip(W, s, 120 + rel * 0.4, null);
              break;
            }
          }
        }
      } else if (EVT.type === 'nova') {
        const bt = EVT.t - EV_LEAD;          // time since detonation
        if (bt > 0) {
          const R2 = (bt / 6) * 3200;        // expanding front
          for (const s of W.ships) {
            if (s.dead || s.remote) continue;
            if (s.novaT > 0) continue;       // grace timer decays in the hazard loop
            const d = hyp(s.x - EVT.x, s.y - EVT.y);
            if (Math.abs(d - R2) < 170) {
              const inv = 1 / Math.max(1, d);
              s.vx += (s.x - EVT.x) * inv * 520;
              s.vy += (s.y - EVT.y) * inv * 520;
              s.novaT = 1.2;
              ev(W, { e: 'novahit', id: s.id, x: s.x, y: s.y });
              damageShip(W, s, 480 * (1 - bt / 12), null);
            }
          }
        }
      } else if (EVT.type === 'marauders') {
        // the authority spawns the raiders; everyone else sees them as bots.
        // Survivors are NOT cleaned up — they prowl until somebody collects.
        if (W.opts.authority && W.evtSpawned !== EVT.idx) {
          W.evtSpawned = EVT.idx;
          const prowling = W.ships.filter(s => s.marauder && !s.dead).length;
          for (let i = 0; i < 3 && prowling + i < 10; i++) spawnMarauder(W, EVT.x, EVT.y);
        }
      }
    }

    // relic + cache salvage: local human pilots only — bots have no use for
    // tech, and only the upgrade economy spends credits
    if (W.relicSlots) {
      for (const s of W.ships) {
        if (s.dead || s.remote || s.bot || !s.noGreens) continue;
        for (let i = 0; i < W.relicSlots.length; i++) {
          const sl = W.relicSlots[i];
          if (W.time - sl.taken < 240 && sl.taken > -1) continue;
          if (hyp(s.x - sl.x, s.y - sl.y) < 30 + s.t.radius) {
            sl.taken = W.time;
            ev(W, { e: 'relic', id: s.id, slot: i, x: sl.x, y: sl.y });
          }
        }
        // caches are dense, so only scan the ones that could be in reach
        if (W.caches) {
          for (let i = 0; i < W.caches.length; i++) {
            const ch = W.caches[i];
            if (W.time - ch.taken < 90 && ch.taken > -1) continue;
            if (Math.abs(s.x - ch.x) > 60 || Math.abs(s.y - ch.y) > 60) continue;
            if (hyp(s.x - ch.x, s.y - ch.y) < 34 + s.t.radius) {
              ch.taken = W.time;
              ev(W, { e: 'cache', id: s.id, slot: i, x: ch.x, y: ch.y });
            }
          }
        }
      }
    }

    // the maelstrom: storm rock tears local hulls; wormholes swallow anyone
    // who strays too close (remote ghosts are handled by their own owner)
    if (W.danger) {
      for (const s of W.ships) {
        if (s.dead || s.remote) continue;
        if (s.rockT > 0) s.rockT -= dt;
        if (s.wormT > 0) s.wormT -= dt;
        if (s.novaT > 0) s.novaT -= dt;   // decays ALWAYS, not only mid-nova —
                                          // stale grace must not shield the next collapse
        if (s.rockT <= 0 && hyp(s.x - W.danger.x, s.y - W.danger.y) < W.danger.r + 250) {
          for (const rk of W.rocks) {
            const q = rockAt(W, rk, W.time);
            const d = hyp(s.x - q.x, s.y - q.y);
            if (d < rk.rad + s.t.radius) {
              const rel = hyp(s.vx - q.vx, s.vy - q.vy);
              const inv = 1 / Math.max(1, d);
              s.vx += (s.x - q.x) * inv * (180 + rel * 0.4);
              s.vy += (s.y - q.y) * inv * (180 + rel * 0.4);
              s.rockT = 0.7;
              ev(W, { e: 'rockhit', id: s.id, x: q.x, y: q.y, rel });
              damageShip(W, s, 140 + rel * 0.45, null);
              break;
            }
          }
        }
        if (s.wormT <= 0) {
          for (const wh of W.wormholes) {
            if (hyp(s.x - wh.x, s.y - wh.y) < (wh.r || 58)) {
              ev(W, { e: 'worm', id: s.id, x0: s.x, y0: s.y, x1: wh.dx, y1: wh.dy, hue: s.hue });
              s.x = wh.dx; s.y = wh.dy;
              s.wormT = 4;
              s.rockT = Math.max(s.rockT, 1.5);   // a breath before the storm bites
              s.safe = Math.max(s.safe, 1.2);
              break;
            }
          }
        }
      }
    }
    // per-step warden roster: keeps the aura check O(ships), not O(ships^2)
    const wl = W._wardens || (W._wardens = []);
    wl.length = 0;
    for (const o of W.ships) if (!o.dead && o.team && o.type === 'warden') wl.push(o);
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
    TAU, TILE, MAPS, WORLD, STEP, PRIZE_CAP, QUAD, QUADPX, GRID, FACTIONS,
    SHIP_ORDER, SHIP_TYPES, PRIZE_TYPES, BOT_NAMES, HUES,
    clamp, rand, irand, pick, angleNorm, mulberry32,
    tileSolid, solidAtPx, rectSolid, losClear, randClearPoint, findSpawn, findClearNear, rockAt,
    quadOf, terrOwner, evActive, showerRockAt, EV_LEAD, spawnMarauder, seedDeadZone,
    createWorld, makeShip, removeShip, spawnShip, addBots,
    applyLoadoutDefaults, applyPrize, addPrize, removePrizeById,
    fireGun, fireBomb, doRepel, doBurst, fireRocket, doBlink, warpToBeacon,
    injectGun, injectBomb, injectRepel, injectBurst,
    damageShip, killShip, explode,
    updateWorld, drainEvents,
  };
});
