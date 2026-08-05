/* =========================================================================
   CONTINUUM REDUX — a modern tribute to SubSpace / Continuum
   Top-down inertial space combat: energy warfare, greens, repels, bursts.
   Single-file engine: fixed-timestep sim, canvas neon renderer, WebAudio SFX.
   ========================================================================= */
(function () {
  'use strict';
  const GLOBAL = typeof window !== 'undefined' ? window : globalThis;

  // ---------------------------------------------------------------- constants
  const TAU = Math.PI * 2;
  const TILE = 16;
  const MAPS = 192;                 // map is MAPS x MAPS tiles
  const WORLD = TILE * MAPS;        // 3072 px square
  const STEP = 1 / 60;
  const BOT_COUNT = 10;
  const PRIZE_CAP = 30;

  // ---------------------------------------------------------------- utilities
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a === undefined ? Math.random() : a + Math.random() * (b - a);
  const irand = n => (Math.random() * n) | 0;
  const pick = arr => arr[irand(arr.length)];
  const hyp = Math.hypot;
  function angleNorm(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  const dist2 = (a, b) => hyp(a.x - b.x, a.y - b.y);

  // ---------------------------------------------------------------- ship data
  const SHIP_ORDER = ['warbird', 'javelin', 'spider', 'terrier'];
  const SHIP_TYPES = {
    warbird: {
      label: 'Warbird', hue: 192,
      desc: 'The classic duelist. Heavy single shots — one clean hit swings a fight.',
      maxEnergy: 1500, recharge: 105, thrust: 235, maxSpeed: 350, turn: 3.4,
      radius: 11, bounce: 0.6,
      gunLevel: 2, gunDelay: 0.55, gunCost: 150, gunSpeed: 680, gunDmgMul: 1.15,
      bombLevel: 1, bombDelay: 2.4, bombCost: 400, bombSpeed: 300,
      shape: [[1.35, 0], [-0.75, 1.0], [-0.35, 0], [-0.75, -1.0]],
    },
    javelin: {
      label: 'Javelin', hue: 18,
      desc: 'Bomber. Splash artillery with bouncing bombs that clear whole corridors.',
      maxEnergy: 1700, recharge: 95, thrust: 200, maxSpeed: 310, turn: 3.0,
      radius: 12, bounce: 0.5,
      gunLevel: 1, gunDelay: 0.6, gunCost: 120, gunSpeed: 600, gunDmgMul: 0.9,
      bombLevel: 2, bombDelay: 1.8, bombCost: 450, bombSpeed: 340,
      shape: [[1.15, 0], [0.1, 0.55], [-0.95, 0.9], [-0.5, 0], [-0.95, -0.9], [0.1, -0.55]],
    },
    spider: {
      label: 'Spider', hue: 130,
      desc: 'Bullet hose. Weak pellets, relentless rate of fire, monster recharge.',
      maxEnergy: 1400, recharge: 135, thrust: 215, maxSpeed: 330, turn: 3.6,
      radius: 11, bounce: 0.55,
      gunLevel: 1, gunDelay: 0.16, gunCost: 45, gunSpeed: 620, gunDmgMul: 0.5,
      bombLevel: 1, bombDelay: 3.0, bombCost: 500, bombSpeed: 300,
      shape: [[1.05, 0], [0.2, 0.9], [-1.0, 0.62], [-0.55, 0], [-1.0, -0.62], [0.2, -0.9]],
    },
    terrier: {
      label: 'Terrier', hue: 282,
      desc: 'Interceptor. Fastest hull in the zone — hit, run, and never stop moving.',
      maxEnergy: 1250, recharge: 120, thrust: 285, maxSpeed: 410, turn: 4.3,
      radius: 10, bounce: 0.65,
      gunLevel: 1, gunDelay: 0.3, gunCost: 80, gunSpeed: 640, gunDmgMul: 0.75,
      bombLevel: 1, bombDelay: 2.6, bombCost: 420, bombSpeed: 320,
      shape: [[1.25, 0], [-0.4, 0.65], [-1.05, 0.28], [-1.05, -0.28], [-0.4, -0.65]],
    },
  };

  const BOT_NAMES = ['Vexx', 'PH03N1X', 'Kansir', 'Mirage', 'Rekker', 'Slyce',
    'Nova-9', 'Duelist', 'Torch', 'Ekko', 'Blitz', 'Warpig', 'Sable', 'Quark'];
  const BOT_HUES = [8, 35, 55, 110, 150, 210, 240, 262, 300, 330, 20, 90, 180, 315];

  // greens — unmarked in the world, revealed on pickup, just like SubSpace
  const PRIZE_TYPES = [
    { n: 'Full Charge', w: 3, f: s => { s.energy = s.maxEnergy; } },
    { n: 'Energy Upgrade', w: 2, ok: s => s.maxEnergy < s.t.maxEnergy * 1.5, f: s => { s.maxEnergy += 70; s.energy += 70; } },
    { n: 'Recharge Rate', w: 2, ok: s => s.recharge < s.t.recharge * 2, f: s => { s.recharge *= 1.09; } },
    { n: 'Gun Upgrade', w: 2, ok: s => s.gunLevel < 3, f: s => { s.gunLevel++; } },
    { n: 'Bomb Upgrade', w: 2, ok: s => s.bombLevel < 3, f: s => { s.bombLevel++; } },
    { n: 'MultiFire', w: 1, ok: s => !s.multi, f: s => { s.multi = true; s.multiOn = true; } },
    { n: 'Bouncing Bullets', w: 1, ok: s => !s.bounceBullets, f: s => { s.bounceBullets = true; } },
    { n: 'Repel', w: 2, ok: s => s.repels < 3, f: s => { s.repels++; } },
    { n: 'Burst', w: 2, ok: s => s.bursts < 3, f: s => { s.bursts++; } },
    { n: 'Rocket', w: 1, ok: s => s.rockets < 2, f: s => { s.rockets++; } },
    { n: 'Thruster', w: 2, ok: s => s.thrust < s.t.thrust * 1.5, f: s => { s.thrust *= 1.06; } },
    { n: 'Top Speed', w: 2, ok: s => s.maxSpeed < s.t.maxSpeed * 1.5, f: s => { s.maxSpeed *= 1.05; } },
  ];

  // ---------------------------------------------------------------- game state
  const G = {
    state: 'boot',            // title | select | play
    paused: false, muted: false,
    time: 0, prizeT: 0, beepT: 0,
    map: null, mapBig: null, radarC: null,
    ships: [], bullets: [], bombs: [], prizes: [], parts: [], waves: [], msgs: [],
    cam: { x: WORLD / 2, y: WORLD / 2 }, shake: 0,
    player: null, sel: 0, best: 0, deathBy: '',
    demoT: 0, demoShip: null,
    hitFlash: 0,
  };
  const keys = Object.create(null);

  let canvas = null, ctx = null, vw = 1280, vh = 720, dpr = 1;
  let vignette = null;

  // ---------------------------------------------------------------- map
  function tileSolid(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= MAPS || ty >= MAPS) return true;
    return G.map[ty * MAPS + tx] !== 0;
  }
  function solidAtPx(x, y) { return tileSolid((x / TILE) | 0, (y / TILE) | 0); }
  function rectSolid(x, y, w, h) {
    const x0 = (x / TILE) | 0, y0 = (y / TILE) | 0;
    const x1 = ((x + w) / TILE) | 0, y1 = ((y + h) / TILE) | 0;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        if (tileSolid(tx, ty)) return true;
    return false;
  }
  function losClear(x1, y1, x2, y2) {
    const d = hyp(x2 - x1, y2 - y1), n = Math.max(1, (d / 12) | 0);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (solidAtPx(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
    }
    return true;
  }

  function genMap() {
    const m = new Uint8Array(MAPS * MAPS);
    const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < MAPS && y < MAPS) m[y * MAPS + x] = v; };
    const fillRect = (x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, v); };

    // border shell
    fillRect(0, 0, MAPS, 2, 1); fillRect(0, MAPS - 2, MAPS, 2, 1);
    fillRect(0, 0, 2, MAPS, 1); fillRect(MAPS - 2, 0, 2, MAPS, 1);

    // scattered structures
    for (let i = 0; i < 60; i++) {
      const cx = 8 + irand(MAPS - 16), cy = 8 + irand(MAPS - 16);
      switch (irand(5)) {
        case 0: { // solid block
          fillRect(cx, cy, 2 + irand(5), 2 + irand(5), 1);
          break;
        }
        case 1: { // hollow room with gaps
          const w = 8 + irand(7), h = 8 + irand(7);
          fillRect(cx, cy, w, 1, 1); fillRect(cx, cy + h - 1, w, 1, 1);
          fillRect(cx, cy, 1, h, 1); fillRect(cx + w - 1, cy, 1, h, 1);
          fillRect(cx + 2 + irand(Math.max(1, w - 5)), cy, 2, 1, 0);           // top gap
          fillRect(cx, cy + 2 + irand(Math.max(1, h - 5)), 1, 2, 0);           // left gap
          break;
        }
        case 2: { // cross
          const l = 3 + irand(4);
          fillRect(cx - l, cy, l * 2 + 1, 1, 1); fillRect(cx, cy - l, 1, l * 2 + 1, 1);
          break;
        }
        case 3: { // diagonal stair
          const len = 5 + irand(6), dir = Math.random() < 0.5 ? 1 : -1;
          for (let k = 0; k < len; k++) { set(cx + k, cy + k * dir, 1); set(cx + k + 1, cy + k * dir, 1); }
          break;
        }
        case 4: { // pillar cluster
          for (let k = 0; k < 4 + irand(4); k++)
            fillRect(cx + irand(9) - 4, cy + irand(9) - 4, 1 + irand(2), 1 + irand(2), 1);
          break;
        }
      }
    }

    // central arena: carve clear disc, then ring wall with four gates
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

    // breathing room around outer spawn ring
    for (let i = 0; i < 8; i++) {
      const ang = i / 8 * TAU + 0.4;
      const sx = Math.round(C + Math.cos(ang) * MAPS * 0.36);
      const sy = Math.round(C + Math.sin(ang) * MAPS * 0.36);
      for (let ty = -4; ty <= 4; ty++)
        for (let tx = -4; tx <= 4; tx++)
          if (tx * tx + ty * ty <= 18) set(sx + tx, sy + ty, 0);
    }
    // re-assert border (arena carve can't reach it, but structures logic keeps it clean)
    fillRect(0, 0, MAPS, 2, 1); fillRect(0, MAPS - 2, MAPS, 2, 1);
    fillRect(0, 0, 2, MAPS, 1); fillRect(MAPS - 2, 0, 2, MAPS, 1);
    G.map = m;
  }

  function prerenderMap() {
    const doc = GLOBAL.document;
    const big = doc.createElement('canvas');
    big.width = WORLD; big.height = WORLD;
    const c = big.getContext('2d');
    for (let ty = 0; ty < MAPS; ty++) {
      for (let tx = 0; tx < MAPS; tx++) {
        if (!tileSolid(tx, ty)) continue;
        const x = tx * TILE, y = ty * TILE;
        c.fillStyle = '#111a30';
        c.fillRect(x, y, TILE, TILE);
        c.fillStyle = '#0b1122';
        c.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
        c.strokeStyle = 'rgba(96,150,240,0.9)';
        c.lineWidth = 1.5;
        c.beginPath();
        if (!tileSolid(tx, ty - 1)) { c.moveTo(x, y + 0.75); c.lineTo(x + TILE, y + 0.75); }
        if (!tileSolid(tx, ty + 1)) { c.moveTo(x, y + TILE - 0.75); c.lineTo(x + TILE, y + TILE - 0.75); }
        if (!tileSolid(tx - 1, ty)) { c.moveTo(x + 0.75, y); c.lineTo(x + 0.75, y + TILE); }
        if (!tileSolid(tx + 1, ty)) { c.moveTo(x + TILE - 0.75, y); c.lineTo(x + TILE - 0.75, y + TILE); }
        c.stroke();
      }
    }
    G.mapBig = big;

    const rc = doc.createElement('canvas');
    rc.width = MAPS; rc.height = MAPS;
    const r = rc.getContext('2d');
    r.fillStyle = '#41639f';
    for (let ty = 0; ty < MAPS; ty++)
      for (let tx = 0; tx < MAPS; tx++)
        if (tileSolid(tx, ty)) r.fillRect(tx, ty, 1, 1);
    G.radarC = rc;
  }

  function randClearPoint() {
    for (let i = 0; i < 200; i++) {
      const tx = 4 + irand(MAPS - 8), ty = 4 + irand(MAPS - 8);
      let ok = true;
      for (let j = -1; j <= 1 && ok; j++)
        for (let k = -1; k <= 1 && ok; k++)
          if (tileSolid(tx + k, ty + j)) ok = false;
      if (ok) return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    }
    return { x: WORLD / 2, y: WORLD / 2 };
  }
  function findSpawn(self) {
    let best = null, bestD = -1;
    for (let i = 0; i < 40; i++) {
      const p = randClearPoint();
      let nearest = 1e9;
      for (const o of G.ships) {
        if (o === self || o.dead) continue;
        nearest = Math.min(nearest, hyp(o.x - p.x, o.y - p.y));
      }
      if (nearest > 420) return p;
      if (nearest > bestD) { bestD = nearest; best = p; }
    }
    return best || { x: WORLD / 2, y: WORLD / 2 };
  }

  // ---------------------------------------------------------------- audio
  const SFX = { ctx: null };
  function audioInit() {
    if (SFX.ctx || !GLOBAL.AudioContext && !GLOBAL.webkitAudioContext) return;
    try {
      const AC = GLOBAL.AudioContext || GLOBAL.webkitAudioContext;
      SFX.ctx = new AC();
      SFX.master = SFX.ctx.createGain();
      SFX.master.gain.value = 0.5;
      SFX.master.connect(SFX.ctx.destination);
      const len = SFX.ctx.sampleRate | 0;
      SFX.noise = SFX.ctx.createBuffer(1, len, SFX.ctx.sampleRate);
      const d = SFX.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { SFX.ctx = null; }
  }
  function tone(type, f0, f1, t, vol, delay) {
    if (!SFX.ctx || G.muted) return;
    const a = SFX.ctx, now = a.currentTime + (delay || 0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, now);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + t);
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t);
    o.connect(g); g.connect(SFX.master);
    o.start(now); o.stop(now + t + 0.02);
  }
  function noiseHit(t, vol, f0, f1) {
    if (!SFX.ctx || G.muted) return;
    const a = SFX.ctx, now = a.currentTime;
    const src = a.createBufferSource(); src.buffer = SFX.noise; src.loop = true;
    const flt = a.createBiquadFilter(); flt.type = 'lowpass';
    flt.frequency.setValueAtTime(f0, now);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), now + t);
    const g = a.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t);
    src.connect(flt); flt.connect(g); g.connect(SFX.master);
    src.start(now); src.stop(now + t + 0.02);
  }
  function worldVol(x, y, base) {
    const ref = G.player && !G.player.dead ? G.player : G.cam;
    const d = hyp(x - ref.x, y - ref.y);
    return d > 950 ? 0 : base * (1 - d / 950);
  }
  const sndShoot = (x, y, lvl) => { const v = worldVol(x, y, 0.16); if (v > 0.01) tone('square', 700 + lvl * 220, 240, 0.09, v); };
  const sndBomb = (x, y) => { const v = worldVol(x, y, 0.22); if (v > 0.01) tone('sawtooth', 210, 70, 0.25, v); };
  const sndBoom = (x, y, big) => {
    const v = worldVol(x, y, big ? 0.6 : 0.35); if (v < 0.01) return;
    noiseHit(big ? 0.7 : 0.4, v, big ? 2400 : 1600, 60);
    tone('sine', big ? 120 : 90, 30, big ? 0.5 : 0.3, v * 0.8);
  };
  const sndBounce = (x, y) => { const v = worldVol(x, y, 0.1); if (v > 0.01) tone('triangle', 320, 180, 0.05, v); };
  const sndPrize = () => { tone('sine', 660, 660, 0.09, 0.18); tone('sine', 990, 990, 0.12, 0.18, 0.08); };
  const sndRepel = (x, y) => { const v = worldVol(x, y, 0.3); if (v > 0.01) noiseHit(0.35, v, 300, 3800); };
  const sndRocket = () => noiseHit(1.6, 0.22, 900, 300);
  const sndBeep = () => tone('square', 880, 880, 0.06, 0.1);

  // ---------------------------------------------------------------- messages
  function say(text, color) {
    G.msgs.push({ text, color: color || '#8f8', t: 0 });
    if (G.msgs.length > 40) G.msgs.shift();
  }

  // ---------------------------------------------------------------- ships
  function applyLoadoutDefaults(s) {
    const t = s.t;
    s.maxEnergy = t.maxEnergy; s.recharge = t.recharge;
    s.thrust = t.thrust; s.maxSpeed = t.maxSpeed;
    s.gunLevel = t.gunLevel; s.bombLevel = t.bombLevel;
    s.multi = false; s.multiOn = false; s.bounceBullets = false;
    s.repels = 1; s.bursts = 1; s.rockets = 0;
    s.bounty = 0;
  }
  function makeShip(typeKey, isBot, name, hue) {
    const t = SHIP_TYPES[typeKey];
    const s = {
      type: typeKey, t, bot: isBot, name, hue: hue == null ? t.hue : hue,
      x: WORLD / 2, y: WORLD / 2, vx: 0, vy: 0, angle: rand(0, TAU),
      energy: t.maxEnergy,
      gunCd: 0, bombCd: 0, repelCd: 0, burstCd: 0, rocketT: 0,
      dead: false, respawn: 0, safe: 0, flash: 0,
      kills: 0, deaths: 0, score: 0,
      ctl: { turn: 0, thrust: 0, gun: false, bomb: false },
      ai: { target: null, mode: 'roam', think: rand(0, 0.2), wp: null, err: 0, dodge: 0, dodgeAngle: 0, avoid: 0, wantRepel: false },
    };
    applyLoadoutDefaults(s);
    return s;
  }
  function spawnShip(s) {
    const p = findSpawn(s);
    s.x = p.x; s.y = p.y; s.vx = 0; s.vy = 0;
    s.angle = rand(0, TAU);
    s.energy = s.maxEnergy;
    s.dead = false; s.safe = 2.5; s.flash = 0;
    s.gunCd = 0; s.bombCd = 0; s.repelCd = 0; s.burstCd = 0; s.rocketT = 0;
    // small spawn kit, so freshly-warped ships aren't totally naked
    for (let i = 0; i < 2; i++) applyPrize(s, true);
  }

  function weightedPrize(s) {
    const usable = PRIZE_TYPES.filter(p => !p.ok || p.ok(s));
    const total = usable.reduce((a, p) => a + p.w, 0);
    let roll = Math.random() * total;
    for (const p of usable) { roll -= p.w; if (roll <= 0) return p; }
    return PRIZE_TYPES[0];
  }
  function applyPrize(s, silent) {
    const p = weightedPrize(s);
    p.f(s);
    s.energy = Math.min(s.energy, s.maxEnergy);
    s.bounty++;
    if (!silent && s === G.player) say('Green: ' + p.n, '#ff6');
  }

  // ---------------------------------------------------------------- weapons
  function bulletDamage(s) { return (150 + 150 * s.gunLevel) * s.t.gunDmgMul; }

  function fireGun(s) {
    if (s.gunCd > 0 || s.dead) return;
    const multi = s.multi && s.multiOn;
    const cost = s.t.gunCost * (multi ? 1.8 : 1);
    if (s.energy <= cost) return;
    const nx = s.x + Math.cos(s.angle) * (s.t.radius + 6);
    const ny = s.y + Math.sin(s.angle) * (s.t.radius + 6);
    if (solidAtPx(nx, ny)) return;
    s.energy -= cost; s.gunCd = s.t.gunDelay; s.safe = 0;
    const spread = multi ? [-0.18, 0, 0.18] : [0];
    for (const off of spread) {
      const a = s.angle + off;
      G.bullets.push({
        x: nx, y: ny,
        vx: s.vx + Math.cos(a) * s.t.gunSpeed,
        vy: s.vy + Math.sin(a) * s.t.gunSpeed,
        life: 1.45, dmg: bulletDamage(s), level: s.gunLevel,
        bounces: s.bounceBullets ? 2 : 0, owner: s,
      });
    }
    sndShoot(s.x, s.y, s.gunLevel);
  }

  function fireBomb(s) {
    if (s.bombCd > 0 || s.dead) return;
    if (s.energy <= s.t.bombCost) return;
    const nx = s.x + Math.cos(s.angle) * (s.t.radius + 8);
    const ny = s.y + Math.sin(s.angle) * (s.t.radius + 8);
    s.energy -= s.t.bombCost; s.bombCd = s.t.bombDelay; s.safe = 0;
    G.bombs.push({
      x: nx, y: ny,
      vx: s.vx + Math.cos(s.angle) * s.t.bombSpeed,
      vy: s.vy + Math.sin(s.angle) * s.t.bombSpeed,
      life: 3.4, level: s.bombLevel, bounces: s.bombLevel, owner: s,
    });
    sndBomb(s.x, s.y);
  }

  function doRepel(s) {
    if (s.repels <= 0 || s.repelCd > 0 || s.dead) return;
    s.repels--; s.repelCd = 0.8; s.safe = 0;
    const R = 230;
    for (const o of G.ships) {
      if (o === s || o.dead) continue;
      const d = dist2(s, o);
      if (d < R) {
        const k = (1 - d / R) * 640, inv = 1 / Math.max(1, d);
        o.vx += (o.x - s.x) * inv * k;
        o.vy += (o.y - s.y) * inv * k;
      }
    }
    const push = b => {
      const d = hyp(b.x - s.x, b.y - s.y);
      if (b.owner !== s && d < R) {
        const sp = hyp(b.vx, b.vy) * 1.1, inv = 1 / Math.max(1, d);
        b.vx = (b.x - s.x) * inv * sp;
        b.vy = (b.y - s.y) * inv * sp;
      }
    };
    G.bullets.forEach(push); G.bombs.forEach(push);
    G.waves.push({ x: s.x, y: s.y, r: 10, maxR: R, t: 0, dur: 0.35, hue: 200 });
    sndRepel(s.x, s.y);
  }

  function doBurst(s) {
    if (s.bursts <= 0 || s.burstCd > 0 || s.dead) return;
    s.bursts--; s.burstCd = 1; s.safe = 0;
    for (let i = 0; i < 20; i++) {
      const a = i / 20 * TAU;
      G.bullets.push({
        x: s.x + Math.cos(a) * (s.t.radius + 4),
        y: s.y + Math.sin(a) * (s.t.radius + 4),
        vx: s.vx * 0.3 + Math.cos(a) * 500,
        vy: s.vy * 0.3 + Math.sin(a) * 500,
        life: 1.3, dmg: 240, level: 2, bounces: 3, owner: s,
      });
    }
    G.waves.push({ x: s.x, y: s.y, r: 6, maxR: 90, t: 0, dur: 0.25, hue: s.hue });
    sndBoom(s.x, s.y, false);
  }

  function fireRocket(s) {
    if (s.rockets <= 0 || s.rocketT > 0 || s.dead) return;
    s.rockets--; s.rocketT = 1.7; s.safe = 0;
    if (s === G.player) sndRocket();
  }

  // ---------------------------------------------------------------- damage
  function spark(x, y, hue, n, speed) {
    for (let i = 0; i < n; i++) {
      if (G.parts.length > 700) return;
      const a = rand(0, TAU), sp = rand(0.2, 1) * speed;
      G.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.25, 0.7), max: 0.7, hue, kind: 'spark',
      });
    }
  }
  function puff(x, y, hue, n, speed, size) {
    for (let i = 0; i < n; i++) {
      if (G.parts.length > 700) return;
      const a = rand(0, TAU), sp = rand(0.1, 1) * speed;
      G.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.4, 1), max: 1, hue, kind: 'puff', size: size * rand(0.6, 1.4),
      });
    }
  }

  function damageShip(v, dmg, att) {
    if (v.dead || v.safe > 0) return;
    v.energy -= dmg;
    v.flash = 0.12;
    spark(v.x, v.y, v.hue, 6, 220);
    if (v === G.player) {
      G.shake = Math.min(16, G.shake + dmg / 55);
      G.hitFlash = Math.min(0.5, G.hitFlash + dmg / 1600);
    }
    if (v.energy < 0) killShip(v, att);
  }

  function killShip(v, att) {
    v.dead = true; v.respawn = 3; v.deaths++;
    boomFX(v.x, v.y, 90, v.hue, true);
    const drops = 2 + irand(2);
    for (let i = 0; i < drops; i++) {
      if (G.prizes.length >= PRIZE_CAP + 8) break;
      const p = { x: v.x + rand(-30, 30), y: v.y + rand(-30, 30), ttl: 40, phase: rand(0, TAU) };
      if (!solidAtPx(p.x, p.y)) G.prizes.push(p);
    }
    if (att && att !== v) {
      att.kills++; att.score += 10 + v.bounty; att.bounty += 4;
      say(v.name + ' killed by: ' + att.name + ' (' + v.bounty + ')', '#8f8');
    } else {
      say(v.name + ' self-destructed', '#f88');
    }
    if (v === G.player) {
      G.deathBy = att && att !== v ? att.name : 'their own bomb';
      G.best = Math.max(G.best, v.score);
      saveBest();
    }
    if (att === G.player && att !== v) { G.best = Math.max(G.best, att.score); saveBest(); }
    applyLoadoutDefaults(v);
  }

  function boomFX(x, y, r, hue, big) {
    spark(x, y, hue, big ? 26 : 12, big ? 380 : 260);
    puff(x, y, 25, big ? 14 : 6, 120, big ? 26 : 14);
    G.waves.push({ x, y, r: 8, maxR: r * 1.5, t: 0, dur: 0.45, hue: 30 });
    if (G.player) {
      const d = hyp(x - G.player.x, y - G.player.y);
      if (d < 700) G.shake = Math.min(18, G.shake + (big ? 12 : 6) * (1 - d / 700));
    }
    sndBoom(x, y, big);
  }

  function explode(x, y, level, owner) {
    const R = 70 + 28 * level, base = 500 + 220 * level;
    boomFX(x, y, R, 25, level >= 2);
    for (const s of G.ships) {
      if (s.dead) continue;
      const d = hyp(s.x - x, s.y - y);
      if (d < R + s.t.radius) {
        const fall = 1 - clamp(d / R, 0, 1) * 0.85;
        let dmg = base * fall;
        if (s === owner) dmg *= 0.55;          // SubSpace tradition: your own bombs hurt
        const inv = 1 / Math.max(1, d);
        s.vx += (s.x - x) * inv * fall * 380;
        s.vy += (s.y - y) * inv * fall * 380;
        damageShip(s, dmg, owner);
      }
    }
  }

  // ---------------------------------------------------------------- AI
  function aiThink(s) {
    const a = s.ai;
    let best = null, bd = 1e9;
    for (const o of G.ships) {
      if (o === s || o.dead) continue;
      const d = dist2(s, o);
      if (d < 1150 && d < bd) { bd = d; best = o; }
    }
    a.target = best;
    a.err = (Math.random() - 0.5) * 0.14;
    if (best && s.energy < s.maxEnergy * 0.3 && bd < 560) a.mode = 'flee';
    else if (best) a.mode = 'fight';
    else a.mode = 'roam';

    let danger = null, dd = 1e9;
    for (const b of G.bombs) {
      if (b.owner === s) continue;
      const d = hyp(b.x - s.x, b.y - s.y);
      if (d < 300 && d < dd) { dd = d; danger = b; }
    }
    if (!danger) for (const b of G.bullets) {
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

  function updateAI(s, dt) {
    const a = s.ai, c = s.ctl;
    c.gun = false; c.bomb = false;
    a.think -= dt;
    if (a.think <= 0) { a.think = 0.13 + Math.random() * 0.09; aiThink(s); }
    if (a.wantRepel) { a.wantRepel = false; doRepel(s); }

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
          s.energy > s.t.bombCost + 350 && losClear(s.x, s.y, t.x, t.y)) c.bomb = true;
      if (d < 170 && s.bursts > 0 && s.burstCd <= 0) doBurst(s);
      if (s.rockets > 0 && d > 700 && s.energy > s.maxEnergy * 0.7 && Math.random() < 0.003) fireRocket(s);
    } else if (a.mode === 'flee' && t) {
      desired = Math.atan2(s.y - t.y, s.x - t.x); th = 1;
      if (dist2(s, t) < 240 && s.repels > 0 && s.repelCd <= 0) doRepel(s);
      if (s.rockets > 0 && s.rocketT <= 0) fireRocket(s);
    } else {
      if (!a.wp || hyp(a.wp.x - s.x, a.wp.y - s.y) < 90) {
        let pz = null, pd = 800;
        for (const p of G.prizes) {
          const d = hyp(p.x - s.x, p.y - s.y);
          if (d < pd) { pd = d; pz = p; }
        }
        a.wp = pz ? { x: pz.x, y: pz.y } : randClearPoint();
      }
      desired = Math.atan2(a.wp.y - s.y, a.wp.x - s.x); th = 0.85;
    }

    // wall avoidance: probe ahead, steer toward the open side
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
    if (solidAtPx(s.x + ca * 70, s.y + sa * 70) || solidAtPx(s.x + ca * 40, s.y + sa * 40)) {
      const L = solidAtPx(s.x + Math.cos(s.angle - 0.9) * 70, s.y + Math.sin(s.angle - 0.9) * 70);
      const R = solidAtPx(s.x + Math.cos(s.angle + 0.9) * 70, s.y + Math.sin(s.angle + 0.9) * 70);
      if (!a.avoid) a.avoid = Math.random() < 0.5 ? 1 : -1;
      desired = s.angle + (L && !R ? 1.6 : R && !L ? -1.6 : a.avoid * 2.2);
      th = Math.min(th, 0.15);
    } else a.avoid = 0;

    c.turn = clamp(angleNorm(desired - s.angle) * 4, -1, 1);
    c.thrust = th;
  }

  // ---------------------------------------------------------------- ship update
  function updateShip(s, dt) {
    if (s.dead) {
      s.respawn -= dt;
      if (s.respawn <= 0) spawnShip(s);
      return;
    }
    if (s.bot) updateAI(s, dt);
    const c = s.ctl;

    s.angle += c.turn * s.t.turn * dt;

    let th = c.thrust;
    let maxSp = s.maxSpeed;
    let power = s.thrust;
    if (s.rocketT > 0) {
      s.rocketT -= dt;
      th = 1; maxSp *= 1.9; power *= 2.6;
      if (G.parts.length < 700) {
        G.parts.push({
          x: s.x - Math.cos(s.angle) * s.t.radius, y: s.y - Math.sin(s.angle) * s.t.radius,
          vx: -Math.cos(s.angle) * 180 + rand(-40, 40), vy: -Math.sin(s.angle) * 180 + rand(-40, 40),
          life: 0.5, max: 0.5, hue: 30, kind: 'puff', size: 10,
        });
      }
    }
    if (th !== 0) {
      const p = power * (th > 0 ? th : th * 0.6);
      s.vx += Math.cos(s.angle) * p * dt;
      s.vy += Math.sin(s.angle) * p * dt;
      if (th > 0 && G.parts.length < 700 && Math.random() < 0.65) {
        G.parts.push({
          x: s.x - Math.cos(s.angle) * s.t.radius, y: s.y - Math.sin(s.angle) * s.t.radius,
          vx: s.vx * 0.2 - Math.cos(s.angle) * 140 + rand(-30, 30),
          vy: s.vy * 0.2 - Math.sin(s.angle) * 140 + rand(-30, 30),
          life: 0.35, max: 0.35, hue: s.hue, kind: 'spark',
        });
      }
    }
    // soft speed cap — repels and bomb knockback can exceed it briefly
    const sp = hyp(s.vx, s.vy);
    if (sp > maxSp) {
      const k = Math.max(maxSp / sp, 1 - 2.5 * dt);
      s.vx *= k; s.vy *= k;
    }

    // axis-separated wall collision with bounce (SubSpace ships ricochet)
    const r = s.t.radius;
    const nx = s.x + s.vx * dt;
    if (rectSolid(nx - r, s.y - r, r * 2, r * 2)) {
      if (Math.abs(s.vx) > 120) sndBounce(s.x, s.y);
      s.vx *= -s.t.bounce;
    } else s.x = nx;
    const ny = s.y + s.vy * dt;
    if (rectSolid(s.x - r, ny - r, r * 2, r * 2)) {
      if (Math.abs(s.vy) > 120) sndBounce(s.x, s.y);
      s.vy *= -s.t.bounce;
    } else s.y = ny;
    s.x = clamp(s.x, TILE * 2 + r, WORLD - TILE * 2 - r);
    s.y = clamp(s.y, TILE * 2 + r, WORLD - TILE * 2 - r);

    s.energy = Math.min(s.maxEnergy, s.energy + s.recharge * dt);
    s.gunCd -= dt; s.bombCd -= dt; s.repelCd -= dt; s.burstCd -= dt;
    if (s.safe > 0) s.safe -= dt;
    if (s.flash > 0) s.flash -= dt;

    if (c.gun) fireGun(s);
    if (c.bomb) fireBomb(s);

    // greens
    for (let i = G.prizes.length - 1; i >= 0; i--) {
      const p = G.prizes[i];
      if (hyp(p.x - s.x, p.y - s.y) < s.t.radius + 11) {
        G.prizes.splice(i, 1);
        applyPrize(s, false);
        if (s === G.player) sndPrize();
        spark(p.x, p.y, 130, 8, 160);
      }
    }
  }

  // ---------------------------------------------------------------- projectiles
  function updateBullets(dt) {
    for (let i = G.bullets.length - 1; i >= 0; i--) {
      const b = G.bullets[i];
      b.life -= dt;
      if (b.life <= 0) { G.bullets.splice(i, 1); continue; }
      let dead = false;
      const h = dt / 2;
      for (let step = 0; step < 2 && !dead; step++) {
        const bx = b.x + b.vx * h;
        if (solidAtPx(bx, b.y)) {
          if (b.bounces > 0) { b.bounces--; b.vx = -b.vx; sndBounce(b.x, b.y); }
          else { spark(b.x, b.y, 45, 4, 150); dead = true; break; }
        } else b.x = bx;
        const by = b.y + b.vy * h;
        if (solidAtPx(b.x, by)) {
          if (b.bounces > 0) { b.bounces--; b.vy = -b.vy; sndBounce(b.x, b.y); }
          else { spark(b.x, b.y, 45, 4, 150); dead = true; break; }
        } else b.y = by;
        for (const s of G.ships) {
          if (s.dead || s === b.owner) continue;
          if (hyp(s.x - b.x, s.y - b.y) < s.t.radius + 3) {
            damageShip(s, b.dmg, b.owner);
            dead = true; break;
          }
        }
      }
      if (dead) G.bullets.splice(i, 1);
    }
  }

  function updateBombs(dt) {
    for (let i = G.bombs.length - 1; i >= 0; i--) {
      const b = G.bombs[i];
      b.life -= dt;
      if (b.life <= 0) { spark(b.x, b.y, 300, 5, 120); G.bombs.splice(i, 1); continue; }
      let boom = false;
      const h = dt / 2;
      for (let step = 0; step < 2 && !boom; step++) {
        const bx = b.x + b.vx * h;
        if (solidAtPx(bx, b.y)) {
          if (b.bounces > 0) { b.bounces--; b.vx = -b.vx; sndBounce(b.x, b.y); }
          else boom = true;
        } else b.x = bx;
        if (boom) break;
        const by = b.y + b.vy * h;
        if (solidAtPx(b.x, by)) {
          if (b.bounces > 0) { b.bounces--; b.vy = -b.vy; sndBounce(b.x, b.y); }
          else boom = true;
        } else b.y = by;
        if (boom) break;
        const prox = 22 + 8 * b.level;
        for (const s of G.ships) {
          if (s.dead || s === b.owner) continue;
          if (hyp(s.x - b.x, s.y - b.y) < s.t.radius + prox) { boom = true; break; }
        }
      }
      if (G.parts.length < 700 && Math.random() < 0.5) {
        G.parts.push({
          x: b.x, y: b.y, vx: rand(-25, 25), vy: rand(-25, 25),
          life: 0.3, max: 0.3, hue: 300, kind: 'spark',
        });
      }
      if (boom) {
        G.bombs.splice(i, 1);
        explode(b.x, b.y, b.level, b.owner);
      }
    }
  }

  // ---------------------------------------------------------------- world update
  function update(dt) {
    G.time += dt;
    if (G.state === 'play' && G.paused) return;

    G.prizeT -= dt;
    if (G.prizeT <= 0) {
      G.prizeT = 1.4;
      if (G.prizes.length < PRIZE_CAP) {
        const p = randClearPoint();
        G.prizes.push({ x: p.x, y: p.y, ttl: 60, phase: rand(0, TAU) });
      }
    }
    for (let i = G.prizes.length - 1; i >= 0; i--) {
      G.prizes[i].ttl -= dt;
      if (G.prizes[i].ttl <= 0) G.prizes.splice(i, 1);
    }

    for (const s of G.ships) updateShip(s, dt);
    updateBullets(dt);
    updateBombs(dt);

    for (let i = G.parts.length - 1; i >= 0; i--) {
      const p = G.parts[i];
      p.life -= dt;
      if (p.life <= 0) { G.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 2.2 * dt; p.vy *= 1 - 2.2 * dt;
    }
    for (let i = G.waves.length - 1; i >= 0; i--) {
      const w = G.waves[i];
      w.t += dt;
      if (w.t >= w.dur) G.waves.splice(i, 1);
    }
    for (let i = G.msgs.length - 1; i >= 0; i--) {
      G.msgs[i].t += dt;
      if (G.msgs[i].t > 9) G.msgs.splice(i, 1);
    }

    // camera
    let target = null;
    if (G.player && G.state === 'play') target = G.player;
    else {
      G.demoT -= dt;
      if (!G.demoShip || G.demoShip.dead || G.demoT <= 0) {
        const live = G.ships.filter(s => !s.dead);
        if (live.length) { G.demoShip = pick(live); G.demoT = 7; }
      }
      target = G.demoShip;
    }
    if (target) {
      const tx = clamp(target.x + target.vx * 0.25, Math.min(vw / 2, WORLD / 2), Math.max(WORLD - vw / 2, WORLD / 2));
      const ty = clamp(target.y + target.vy * 0.25, Math.min(vh / 2, WORLD / 2), Math.max(WORLD - vh / 2, WORLD / 2));
      const k = Math.min(1, dt * 5);
      G.cam.x += (tx - G.cam.x) * k;
      G.cam.y += (ty - G.cam.y) * k;
    }
    G.shake = Math.max(0, G.shake - 40 * dt);
    G.hitFlash = Math.max(0, G.hitFlash - 1.6 * dt);

    // low energy warning
    if (G.player && !G.player.dead && G.player.energy < G.player.maxEnergy * 0.25) {
      G.beepT -= dt;
      if (G.beepT <= 0) { G.beepT = 0.55; sndBeep(); }
    }
  }

  // ---------------------------------------------------------------- glow cache
  const glowCache = new Map();
  function glowSprite(hue) {
    const key = Math.round(hue / 12) * 12;
    let c = glowCache.get(key);
    if (c) return c;
    const doc = GLOBAL.document;
    c = doc.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'hsla(' + key + ',100%,70%,0.9)');
    grad.addColorStop(0.4, 'hsla(' + key + ',100%,60%,0.35)');
    grad.addColorStop(1, 'hsla(' + key + ',100%,50%,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(key, c);
    return c;
  }
  function drawGlow(x, y, size, hue, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(glowSprite(hue), x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- starfield
  const stars = [];
  const nebulae = [];
  function initBackdrop() {
    stars.length = 0;
    const layers = [[150, 0.22, 1], [90, 0.45, 1.6], [50, 0.75, 2.3]];
    for (const [n, z, size] of layers)
      for (let i = 0; i < n; i++)
        stars.push({ x: rand(0, 4000), y: rand(0, 4000), z, size: size * rand(0.6, 1.3), tw: rand(0, TAU) });
    nebulae.length = 0;
    const doc = GLOBAL.document;
    const hues = [205, 275, 320, 185, 250];
    for (let i = 0; i < 5; i++) {
      const c = doc.createElement('canvas');
      c.width = 256; c.height = 256;
      const g = c.getContext('2d');
      const hue = hues[i % hues.length];
      const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
      grad.addColorStop(0, 'hsla(' + hue + ',80%,55%,0.55)');
      grad.addColorStop(0.6, 'hsla(' + hue + ',80%,45%,0.18)');
      grad.addColorStop(1, 'hsla(' + hue + ',80%,40%,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
      nebulae.push({ c, x: rand(0, WORLD), y: rand(0, WORLD), r: rand(340, 640), a: rand(0.06, 0.12) });
    }
  }

  function drawBackdrop() {
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, vw, vh);
    ctx.globalCompositeOperation = 'lighter';
    for (const nb of nebulae) {
      const px = nb.x - G.cam.x * 0.14, py = nb.y - G.cam.y * 0.14;
      const wx = ((px % (vw + 900)) + vw + 900) % (vw + 900) - 450;
      const wy = ((py % (vh + 900)) + vh + 900) % (vh + 900) - 450;
      ctx.globalAlpha = nb.a;
      ctx.drawImage(nb.c, wx - nb.r, wy - nb.r, nb.r * 2, nb.r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const st of stars) {
      const sx = ((st.x - G.cam.x * st.z) % (vw + 100) + vw + 100) % (vw + 100) - 50;
      const sy = ((st.y - G.cam.y * st.z) % (vh + 100) + vh + 100) % (vh + 100) - 50;
      const tw = 0.55 + 0.45 * Math.sin(G.time * 1.7 + st.tw);
      ctx.fillStyle = 'rgba(190,210,255,' + (0.35 + 0.5 * st.z * tw).toFixed(3) + ')';
      ctx.fillRect(sx, sy, st.size, st.size);
    }
  }

  // ---------------------------------------------------------------- rendering
  function shipColor(s, l, a) { return 'hsla(' + s.hue + ',95%,' + l + '%,' + (a == null ? 1 : a) + ')'; }

  function drawShip(s) {
    if (s.dead) return;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(0, 0, 54, s.hue, 0.3);
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(s.angle);
    const r = s.t.radius * 1.35;
    ctx.beginPath();
    const sh = s.t.shape;
    ctx.moveTo(sh[0][0] * r, sh[0][1] * r);
    for (let i = 1; i < sh.length; i++) ctx.lineTo(sh[i][0] * r, sh[i][1] * r);
    ctx.closePath();
    ctx.fillStyle = shipColor(s, 16, 0.95);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = s.flash > 0 ? '#fff' : shipColor(s, 65);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(r * 0.25, 0, 2.2, 0, TAU);
    ctx.fill();
    if (s.ctl.thrust > 0 || s.rocketT > 0) {
      const fl = (s.rocketT > 0 ? 2 : 1) * (0.8 + Math.random() * 0.5);
      ctx.beginPath();
      ctx.moveTo(-r * 0.75, r * 0.3);
      ctx.lineTo(-r * (0.9 + fl * 0.8), 0);
      ctx.lineTo(-r * 0.75, -r * 0.3);
      ctx.closePath();
      ctx.fillStyle = 'hsla(' + (s.rocketT > 0 ? 20 : 32) + ',100%,62%,0.9)';
      ctx.fill();
    }
    ctx.restore();

    if (s.safe > 0) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.t.radius + 8, 0, TAU);
      ctx.strokeStyle = 'rgba(120,220,255,' + (0.35 + 0.3 * Math.sin(G.time * 10)).toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // nameplate + energy sliver
    ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = s === G.player ? 'rgba(160,240,255,0.9)' : 'rgba(200,210,235,0.6)';
    ctx.fillText(s.name, s.x, s.y + s.t.radius + 20);
    const frac = clamp(s.energy / s.maxEnergy, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(s.x - 14, s.y + s.t.radius + 24, 28, 3);
    ctx.fillStyle = frac > 0.5 ? 'rgba(90,230,170,0.8)' : frac > 0.25 ? 'rgba(250,210,80,0.85)' : 'rgba(250,90,80,0.9)';
    ctx.fillRect(s.x - 14, s.y + s.t.radius + 24, 28 * frac, 3);
  }

  const BULLET_HUES = { 1: 46, 2: 18, 3: 205 };
  function drawWorld() {
    ctx.save();
    const shx = (Math.random() - 0.5) * G.shake, shy = (Math.random() - 0.5) * G.shake;
    ctx.translate(Math.round(vw / 2 - G.cam.x + shx), Math.round(vh / 2 - G.cam.y + shy));

    ctx.drawImage(G.mapBig, 0, 0);

    // greens — anonymous rotating diamonds, classic style
    for (const p of G.prizes) {
      const pulse = 0.75 + 0.25 * Math.sin(G.time * 4 + p.phase);
      const fade = p.ttl < 4 ? p.ttl / 4 : 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(0, 0, 34 * pulse, 130, 0.5 * fade);
      ctx.globalCompositeOperation = 'source-over';
      ctx.rotate(G.time * 1.5 + p.phase);
      ctx.strokeStyle = 'rgba(90,255,130,' + (0.9 * fade).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.strokeRect(-6 * pulse, -6 * pulse, 12 * pulse, 12 * pulse);
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const b of G.bullets) {
      const hue = BULLET_HUES[b.level] || 46;
      drawGlow(b.x, b.y, 18, hue, 0.9);
      ctx.fillStyle = 'hsla(' + hue + ',100%,80%,1)';
      ctx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
    }
    for (const b of G.bombs) {
      const pulse = 1 + 0.3 * Math.sin(G.time * 18);
      drawGlow(b.x, b.y, (26 + b.level * 8) * pulse, 300, 0.95);
      ctx.fillStyle = 'hsla(310,100%,82%,1)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3 + b.level, 0, TAU);
      ctx.fill();
    }
    for (const p of G.parts) {
      const f = clamp(p.life / p.max, 0, 1);
      if (p.kind === 'spark') {
        ctx.strokeStyle = 'hsla(' + p.hue + ',100%,68%,' + (f * 0.9).toFixed(3) + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else {
        drawGlow(p.x, p.y, (p.size || 12) * (2 - f), p.hue, f * 0.5);
      }
    }
    for (const w of G.waves) {
      const f = w.t / w.dur;
      ctx.strokeStyle = 'hsla(' + w.hue + ',100%,65%,' + ((1 - f) * 0.8).toFixed(3) + ')';
      ctx.lineWidth = 3 * (1 - f) + 1;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r + (w.maxR - w.r) * f, 0, TAU);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    for (const s of G.ships) drawShip(s);
    ctx.restore();
  }

  // ---------------------------------------------------------------- HUD
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function txt(str, x, y, size, color, align, weight) {
    ctx.font = (weight || 600) + ' ' + size + 'px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function drawHUD() {
    const p = G.player;
    if (!p) return;

    // energy bar
    const bw = Math.min(360, vw - 40), bx = vw / 2 - bw / 2, by = 16;
    const frac = clamp(p.energy / p.maxEnergy, 0, 1);
    ctx.fillStyle = 'rgba(6,12,24,0.7)';
    rr(bx - 4, by - 4, bw + 8, 24, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(bx, by, bw, 16);
    const barColor = frac > 0.5 ? 'rgba(70,220,255,0.9)'
      : frac > 0.25 ? 'rgba(250,210,80,0.95)'
      : 'rgba(255,80,70,' + (0.7 + 0.3 * Math.sin(G.time * 12)).toFixed(3) + ')';
    ctx.fillStyle = barColor;
    ctx.fillRect(bx, by, bw * frac, 16);
    txt(String(Math.max(0, p.energy | 0)), vw / 2, by + 13, 12, '#dff', 'center', 700);

    // top-left: pilot panel
    ctx.fillStyle = 'rgba(6,12,24,0.6)';
    rr(12, 12, 190, 86, 8); ctx.fill();
    txt(p.name + '  ·  ' + p.t.label, 22, 32, 13, shipColor(p, 70), 'left', 700);
    txt('Score ' + p.score, 22, 50, 12, '#cde');
    txt('Bounty ' + p.bounty, 110, 50, 12, '#fd8');
    txt('K ' + p.kills + '   D ' + p.deaths, 22, 68, 12, '#9ab');
    txt('Best ' + G.best, 22, 86, 11, '#678');

    // bottom-center: loadout
    const items = [
      '[GUN L' + p.gunLevel + (p.multi ? (p.multiOn ? ' ·MF' : ' ·mf') : '') + (p.bounceBullets ? ' ·B' : '') + ']',
      '[BOMB L' + p.bombLevel + ']',
      '[E REPEL ×' + p.repels + ']',
      '[Q BURST ×' + p.bursts + ']',
      '[R ROCKET ×' + p.rockets + ']',
    ];
    txt(items.join('   '), vw / 2, vh - 16, 12, 'rgba(160,190,230,0.85)', 'center', 700);

    // leaderboard top-right
    const board = G.ships.slice().sort((a, b) => b.score - a.score).slice(0, 6);
    const lw = 180, lx = vw - lw - 12;
    ctx.fillStyle = 'rgba(6,12,24,0.6)';
    rr(lx, 12, lw, 24 + board.length * 17, 8); ctx.fill();
    txt('ZONE STANDINGS', lx + 10, 29, 10, '#68a', 'left', 700);
    board.forEach((s, i) => {
      const y = 46 + i * 17;
      const me = s === G.player;
      txt((i + 1) + '. ' + s.name, lx + 10, y, 11, me ? '#8ef' : '#bcd', 'left', me ? 700 : 500);
      txt(String(s.score), lx + lw - 10, y, 11, me ? '#8ef' : '#89a', 'right');
    });

    drawRadar();
    drawMessages();

    if (p.dead) {
      ctx.fillStyle = 'rgba(4,6,13,0.55)';
      ctx.fillRect(0, 0, vw, vh);
      txt('WARPED OUT', vw / 2, vh / 2 - 40, 42, '#f66', 'center', 800);
      txt('destroyed by ' + G.deathBy, vw / 2, vh / 2 - 6, 16, '#dbc', 'center');
      txt('loadout reset — respawn in ' + Math.max(0, p.respawn).toFixed(1), vw / 2, vh / 2 + 24, 14, '#9ab', 'center');
    }

    if (G.hitFlash > 0 && vignette) {
      ctx.globalAlpha = G.hitFlash;
      ctx.fillStyle = 'rgba(255,40,30,0.35)';
      ctx.fillRect(0, 0, vw, vh);
      ctx.globalAlpha = 1;
    }
  }

  function drawRadar() {
    const R = 168, rx = vw - R - 12, ry = vh - R - 12;
    ctx.fillStyle = 'rgba(4,9,18,0.8)';
    rr(rx - 4, ry - 4, R + 8, R + 8, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(70,120,200,0.5)';
    ctx.lineWidth = 1;
    rr(rx - 4, ry - 4, R + 8, R + 8, 8); ctx.stroke();
    ctx.drawImage(G.radarC, rx, ry, R, R);
    const k = R / WORLD;
    // sweep
    const swa = G.time * 1.2 % TAU;
    ctx.strokeStyle = 'rgba(90,200,160,0.25)';
    ctx.beginPath();
    ctx.moveTo(rx + R / 2, ry + R / 2);
    ctx.lineTo(rx + R / 2 + Math.cos(swa) * R / 2, ry + R / 2 + Math.sin(swa) * R / 2);
    ctx.stroke();
    for (const p of G.prizes) {
      ctx.fillStyle = 'rgba(90,255,130,0.8)';
      ctx.fillRect(rx + p.x * k - 1, ry + p.y * k - 1, 2, 2);
    }
    for (const s of G.ships) {
      if (s.dead) continue;
      if (s === G.player) {
        ctx.fillStyle = (G.time * 4 | 0) % 2 ? '#fff' : '#8ef';
        ctx.fillRect(rx + s.x * k - 2, ry + s.y * k - 2, 4, 4);
      } else {
        ctx.fillStyle = 'rgba(255,120,90,0.9)';
        ctx.fillRect(rx + s.x * k - 1.5, ry + s.y * k - 1.5, 3, 3);
      }
    }
    // viewport
    ctx.strokeStyle = 'rgba(140,180,240,0.35)';
    ctx.strokeRect(rx + (G.cam.x - vw / 2) * k, ry + (G.cam.y - vh / 2) * k, vw * k, vh * k);
  }

  function drawMessages() {
    const max = 8;
    const start = Math.max(0, G.msgs.length - max);
    let y = vh - 40;
    for (let i = G.msgs.length - 1; i >= start; i--) {
      const m = G.msgs[i];
      const a = m.t > 7 ? clamp(1 - (m.t - 7) / 2, 0, 1) : 1;
      ctx.globalAlpha = a;
      txt(m.text, 14, y, 13, m.color, 'left', 600);
      ctx.globalAlpha = 1;
      y -= 18;
    }
  }

  // ---------------------------------------------------------------- overlays
  function drawTitle() {
    ctx.fillStyle = 'rgba(4,6,13,0.45)';
    ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.shadowColor = 'rgba(80,180,255,0.9)';
    ctx.shadowBlur = 30;
    txt('CONTINUUM', vw / 2, vh / 2 - 60, 76, '#bfe6ff', 'center', 800);
    ctx.shadowColor = 'rgba(255,120,60,0.9)';
    txt('R E D U X', vw / 2, vh / 2 - 10, 30, '#ffb27a', 'center', 700);
    ctx.restore();
    txt('a modern tribute to SubSpace / Continuum', vw / 2, vh / 2 + 24, 14, '#8aa', 'center');
    const blink = Math.sin(G.time * 4) > -0.3;
    if (blink) txt('PRESS ENTER TO FLY', vw / 2, vh / 2 + 78, 20, '#cff', 'center', 700);
    txt('best score  ' + G.best, vw / 2, vh / 2 + 108, 13, '#678', 'center');
    txt('M mute  ·  F fullscreen', vw / 2, vh - 24, 12, '#567', 'center');
  }

  function statBar(x, y, w, label, frac, hue) {
    txt(label, x, y + 8, 10, '#89a');
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + 62, y, w - 62, 8);
    ctx.fillStyle = 'hsla(' + hue + ',90%,60%,0.9)';
    ctx.fillRect(x + 62, y, (w - 62) * clamp(frac, 0.05, 1), 8);
  }

  function drawSelect() {
    ctx.fillStyle = 'rgba(4,6,13,0.72)';
    ctx.fillRect(0, 0, vw, vh);
    txt('CHOOSE YOUR SHIP', vw / 2, 84, 30, '#bfe6ff', 'center', 800);
    txt('◄ ► select   ·   ENTER launch   ·   ESC back', vw / 2, 112, 13, '#789', 'center');

    const cw = Math.min(240, (vw - 80) / 4), ch = 320;
    const totalW = cw * 4 + 3 * 16;
    const startX = vw / 2 - totalW / 2, cy = vh / 2 - ch / 2 + 30;

    SHIP_ORDER.forEach((key, i) => {
      const t = SHIP_TYPES[key];
      const x = startX + i * (cw + 16);
      const seld = i === G.sel;
      ctx.fillStyle = seld ? 'rgba(14,26,52,0.92)' : 'rgba(8,14,28,0.85)';
      rr(x, cy, cw, ch, 10); ctx.fill();
      ctx.strokeStyle = seld ? 'hsla(' + t.hue + ',90%,60%,1)' : 'rgba(70,100,150,0.4)';
      ctx.lineWidth = seld ? 2.5 : 1;
      rr(x, cy, cw, ch, 10); ctx.stroke();

      // rotating ship glyph
      ctx.save();
      ctx.translate(x + cw / 2, cy + 64);
      if (seld) { ctx.globalCompositeOperation = 'lighter'; drawGlow(0, 0, 90, t.hue, 0.4); ctx.globalCompositeOperation = 'source-over'; }
      ctx.rotate(G.time * (seld ? 1.2 : 0.4));
      const r = t.radius * 2.4;
      ctx.beginPath();
      ctx.moveTo(t.shape[0][0] * r, t.shape[0][1] * r);
      for (let j = 1; j < t.shape.length; j++) ctx.lineTo(t.shape[j][0] * r, t.shape[j][1] * r);
      ctx.closePath();
      ctx.fillStyle = 'hsla(' + t.hue + ',80%,16%,0.95)';
      ctx.fill();
      ctx.strokeStyle = 'hsla(' + t.hue + ',95%,62%,1)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      txt(t.label, x + cw / 2, cy + 132, 20, 'hsla(' + t.hue + ',90%,68%,1)', 'center', 700);

      // description, word-wrapped
      ctx.textAlign = 'center';
      ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#9ab';
      const words = t.desc.split(' ');
      let line = '', ly = cy + 152;
      for (const w of words) {
        if ((line + w).length > 30) { ctx.fillText(line, x + cw / 2, ly); ly += 14; line = w + ' '; }
        else line += w + ' ';
      }
      ctx.fillText(line.trim(), x + cw / 2, ly);

      const sx = x + 16, sw = cw - 32;
      statBar(sx, cy + 208, sw, 'ENERGY', t.maxEnergy / 1700, t.hue);
      statBar(sx, cy + 224, sw, 'RECHRG', t.recharge / 135, t.hue);
      statBar(sx, cy + 240, sw, 'SPEED', t.maxSpeed / 410, t.hue);
      statBar(sx, cy + 256, sw, 'AGILITY', t.turn / 4.3, t.hue);
      statBar(sx, cy + 272, sw, 'GUNS', (t.gunDmgMul / t.gunDelay) / 3.2, t.hue);
      statBar(sx, cy + 288, sw, 'BOMBS', (t.bombLevel / t.bombDelay) / 1.15, t.hue);
    });
  }

  function drawPause() {
    ctx.fillStyle = 'rgba(4,6,13,0.7)';
    ctx.fillRect(0, 0, vw, vh);
    txt('PAUSED', vw / 2, vh / 2 - 110, 40, '#bfe6ff', 'center', 800);
    const lines = [
      'W / ↑            thrust',
      'S / ↓            reverse thrust',
      'A D / ← →      rotate',
      'SPACE / CTRL   guns',
      'SHIFT / B      bomb',
      'E              repel        Q   burst',
      'R              rocket       X   toggle multifire',
      'M              mute         F   fullscreen',
      '',
      'ENTER resume    ·    BACKSPACE abandon to title',
    ];
    let y = vh / 2 - 60;
    for (const l of lines) { txt(l, vw / 2 - 150, y, 14, '#abc', 'left', 500); y += 24; }
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackdrop();
    drawWorld();
    if (vignette) ctx.drawImage(vignette, 0, 0, vw, vh);
    if (G.state === 'title') drawTitle();
    else if (G.state === 'select') drawSelect();
    else if (G.state === 'play') {
      drawHUD();
      if (G.paused) drawPause();
    }
  }

  // ---------------------------------------------------------------- persistence
  function loadBest() {
    try { G.best = parseInt(GLOBAL.localStorage.getItem('continuum-redux-best') || '0', 10) || 0; }
    catch (e) { G.best = 0; }
  }
  function saveBest() {
    try { GLOBAL.localStorage.setItem('continuum-redux-best', String(G.best)); } catch (e) { }
  }

  // ---------------------------------------------------------------- flow
  function initWorld() {
    genMap();
    prerenderMap();
    initBackdrop();
    G.ships.length = 0; G.bullets.length = 0; G.bombs.length = 0;
    G.prizes.length = 0; G.parts.length = 0; G.waves.length = 0;
    const names = BOT_NAMES.slice();
    for (let i = 0; i < BOT_COUNT; i++) {
      const name = names.splice(irand(names.length), 1)[0];
      const s = makeShip(pick(SHIP_ORDER), true, name, BOT_HUES[i % BOT_HUES.length]);
      G.ships.push(s);
      spawnShip(s);
    }
    // seed some greens so the zone isn't empty at first
    for (let i = 0; i < 14; i++) {
      const p = randClearPoint();
      G.prizes.push({ x: p.x, y: p.y, ttl: 60, phase: rand(0, TAU) });
    }
  }

  function startGame(shipKey) {
    if (G.player) leaveToTitle();
    const s = makeShip(shipKey || SHIP_ORDER[G.sel], false, 'You', 190);
    G.player = s;
    G.ships.push(s);
    spawnShip(s);
    G.state = 'play';
    G.paused = false;
    say('Welcome to Continuum Redux — good luck, pilot.', '#8df');
    say('Collect greens. Guard your energy. Everything costs it.', '#8df');
    return s;
  }

  function leaveToTitle() {
    if (G.player) {
      const i = G.ships.indexOf(G.player);
      if (i >= 0) G.ships.splice(i, 1);
      G.player = null;
    }
    G.state = 'title';
    G.paused = false;
  }

  // ---------------------------------------------------------------- input
  function updatePlayerInput() {
    const p = G.player;
    if (!p || p.dead || G.state !== 'play' || G.paused) return;
    const c = p.ctl;
    c.turn = (keys.ArrowLeft || keys.KeyA ? -1 : 0) + (keys.ArrowRight || keys.KeyD ? 1 : 0);
    c.thrust = keys.ArrowUp || keys.KeyW ? 1 : keys.ArrowDown || keys.KeyS ? -0.55 : 0;
    c.gun = !!(keys.Space || keys.ControlLeft || keys.ControlRight);
    c.bomb = !!(keys.ShiftLeft || keys.ShiftRight || keys.KeyB);
  }

  const HANDLED_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Enter', 'Backspace', 'Escape',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyB', 'KeyE', 'KeyQ', 'KeyR', 'KeyX', 'KeyM', 'KeyP', 'KeyF']);

  function onKeyDown(e) {
    audioInit();
    if (SFX.ctx && SFX.ctx.state === 'suspended') SFX.ctx.resume();
    const code = e.code;
    if (HANDLED_CODES.has(code)) e.preventDefault();
    if (keys[code]) return;
    keys[code] = true;

    if (code === 'KeyM') { G.muted = !G.muted; say(G.muted ? 'Sound muted' : 'Sound on', '#8df'); return; }
    if (code === 'KeyF') {
      try { if (canvas.requestFullscreen) canvas.requestFullscreen(); } catch (err) { }
      return;
    }

    if (G.state === 'title') {
      if (code === 'Enter' || code === 'Space') G.state = 'select';
    } else if (G.state === 'select') {
      if (code === 'ArrowLeft' || code === 'KeyA') G.sel = (G.sel + 3) % 4;
      else if (code === 'ArrowRight' || code === 'KeyD') G.sel = (G.sel + 1) % 4;
      else if (code === 'Enter') startGame(SHIP_ORDER[G.sel]);
      else if (code === 'Escape') G.state = 'title';
    } else if (G.state === 'play') {
      if (code === 'KeyP' || code === 'Escape') { G.paused = !G.paused; return; }
      if (G.paused) {
        if (code === 'Enter') G.paused = false;
        else if (code === 'Backspace') leaveToTitle();
        return;
      }
      const p = G.player;
      if (!p || p.dead) return;
      if (code === 'KeyE') doRepel(p);
      else if (code === 'KeyQ') doBurst(p);
      else if (code === 'KeyR') fireRocket(p);
      else if (code === 'KeyX' && p.multi) {
        p.multiOn = !p.multiOn;
        say('MultiFire ' + (p.multiOn ? 'ON' : 'OFF'), '#8df');
      }
    }
  }
  function onKeyUp(e) { keys[e.code] = false; }

  // ---------------------------------------------------------------- boot
  function resize() {
    vw = GLOBAL.innerWidth || 1280;
    vh = GLOBAL.innerHeight || 720;
    dpr = Math.min(2, GLOBAL.devicePixelRatio || 1);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    const doc = GLOBAL.document;
    vignette = doc.createElement('canvas');
    vignette.width = Math.max(2, vw); vignette.height = Math.max(2, vh);
    const g = vignette.getContext('2d');
    const grad = g.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.42, vw / 2, vh / 2, Math.max(vw, vh) * 0.72);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,10,0.55)');
    g.fillStyle = grad;
    g.fillRect(0, 0, vw, vh);
  }

  let lastT = 0, acc = 0;
  function frame(ts) {
    GLOBAL.requestAnimationFrame(frame);
    const dt = Math.min(0.1, (ts - lastT) / 1000 || 0);
    lastT = ts;
    acc += dt;
    updatePlayerInput();
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    render();
  }

  function boot() {
    canvas = GLOBAL.document.getElementById('game');
    ctx = canvas.getContext('2d');
    loadBest();
    resize();
    initWorld();
    G.state = 'title';
    GLOBAL.addEventListener('resize', resize);
    GLOBAL.addEventListener('keydown', onKeyDown);
    GLOBAL.addEventListener('keyup', onKeyUp);
    GLOBAL.addEventListener('blur', () => { if (G.state === 'play') G.paused = true; });
    canvas.addEventListener('mousedown', () => {
      audioInit();
      if (SFX.ctx && SFX.ctx.state === 'suspended') SFX.ctx.resume();
      if (G.state === 'title') G.state = 'select';
    });
    GLOBAL.requestAnimationFrame(frame);
  }

  // test/debug hooks (used by the headless smoke test)
  GLOBAL.__continuum = { G, boot, startGame, update, render, keys, initWorld, STEP };

  if (GLOBAL.document && GLOBAL.document.getElementById) boot();
})();
