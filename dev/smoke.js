/* Headless smoke test for Interstellar.
   1) Runs the shared sim (sim.js) directly under Node: 90s of bot combat.
   2) Runs the real client (client.js) against a stubbed DOM/canvas.
   3) Boots the real server (server.js) and drives two WebSocket clients
      through join/state/fire/chat to prove the relay works end to end.
   Usage: node dev/smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); throw new Error(msg); }
}
function finiteShip(s) {
  return Number.isFinite(s.x) && Number.isFinite(s.y) &&
    Number.isFinite(s.vx) && Number.isFinite(s.vy) &&
    Number.isFinite(s.angle) && Number.isFinite(s.energy);
}

// ============================================================ 1) sim test
const SIM = require(path.join(ROOT, 'sim.js'));
{
  const W = SIM.createWorld({ seed: 42, spawnPrizes: true });
  // sparse tile field: rim solid, arena open, structure exists
  assert(SIM.tileSolid(W, 0, 0) && SIM.tileSolid(W, SIM.MAPS - 1, SIM.MAPS - 1), 'world rim is solid');
  assert(!SIM.tileSolid(W, (SIM.MAPS / 2) | 0, (SIM.MAPS / 2) | 0), 'arena interior is open');
  assert(W.tiles.size > 100, 'sparse map has structure chunks');
  // deterministic map from seed (signature over the core region)
  const mapSig = w => {
    let h = 0;
    const C = (SIM.MAPS / 2) | 0;
    for (let y = C - 520; y < C + 520; y += 13)
      for (let x = C - 520; x < C + 520; x += 13) h = (h * 31 + (SIM.tileSolid(w, x, y) ? 1 : 0)) | 0;
    return h;
  };
  const W2 = SIM.createWorld({ seed: 42 });
  assert(mapSig(W) === mapSig(W2) && W.bases[0].x === W2.bases[0].x, 'same seed -> same map');
  const W3 = SIM.createWorld({ seed: 43 });
  assert(W.bases[0].x !== W3.bases[0].x, 'different seed -> different map');

  SIM.addBots(W, 10);
  assert(W.ships.length === 10, 'ten bots spawned');
  assert(Object.keys(SIM.SHIP_TYPES).length === 12, '8 fleet + 4 NOVA hulls exist');
  for (const key of ['corsair', 'meteor', 'hornet', 'titan', 'comet', 'dagger', 'paladin', 'warden',
    'vanguard', 'aegis', 'reaper', 'phantom'])
    assert(SIM.SHIP_TYPES[key], 'ship type ' + key + ' exists');

  // NOVA mechanics
  {
    const Wm = SIM.createWorld({ seed: 7, spawnPrizes: false });
    const van = SIM.makeShip(Wm, 'vanguard', 'local', 'Van', 45);
    assert(van.multi, 'vanguard ships factory multifire');

    const aeg = SIM.makeShip(Wm, 'aegis', 'local', 'Aeg', 215);
    const wb = SIM.makeShip(Wm, 'corsair', 'local', 'Wb', 190);
    aeg.x = wb.x = 500; aeg.y = wb.y = 500;
    const e0 = aeg.energy;
    SIM.damageShip(Wm, aeg, 1000, wb);
    assert(Math.abs((e0 - aeg.energy) - 720) < 1, 'aegis armor reduces damage to 72% (took ' + (e0 - aeg.energy) + ')');

    const rea = SIM.makeShip(Wm, 'reaper', 'local', 'Rea', 275);
    rea.energy = 500;
    SIM.damageShip(Wm, wb, 1000, rea);
    assert(Math.abs(rea.energy - 800) < 1, 'reaper leeches 30% of damage dealt (has ' + rea.energy + ')');

    const pha = SIM.makeShip(Wm, 'phantom', 'local', 'Pha', 320);
    const sp = SIM.randClearPoint(Wm);
    pha.x = sp.x; pha.y = sp.y; pha.angle = 0; pha.energy = 1200;
    // find a heading with a clear landing zone
    let blinked = false;
    for (let a = 0; a < 12 && !blinked; a++) {
      pha.angle = a / 12 * Math.PI * 2;
      pha.blinkCd = 0;
      blinked = SIM.doBlink(Wm, pha);
    }
    assert(blinked, 'phantom blink teleports');
    const evs = SIM.drainEvents(Wm);
    assert(evs.some(e => e.e === 'blink'), 'blink event emitted');
    assert(evs.some(e => e.e === 'hit' && typeof e.att === 'number'), 'hit events carry attacker id');
  }

  // team mechanics: friendly fire off, streaks, spawn control
  {
    const Wt = SIM.createWorld({
      seed: 9, spawnPrizes: false, respawnDelay: 1.4, safeTime: 0,
      spawnPoint: sh => sh.team === 1 ? { x: 600, y: 600, angle: 0 } : { x: 2400, y: 600, angle: Math.PI },
    });
    const a1 = SIM.makeShip(Wt, 'corsair', 'local', 'A1', 200, 1);
    const a2 = SIM.makeShip(Wt, 'corsair', 'local', 'A2', 210, 1);
    const b1 = SIM.makeShip(Wt, 'corsair', 'local', 'B1', 10, 2);
    SIM.spawnShip(Wt, a1); SIM.spawnShip(Wt, b1);
    assert(Math.hypot(a1.x - 600, a1.y - 600) < 340, 'team spawn anchors respected (' + (a1.x | 0) + ',' + (a1.y | 0) + ')');
    assert(a1.angle === 0 && b1.angle === Math.PI, 'spawn facing angles applied');
    a2.x = a1.x; a2.y = a1.y; a2.safe = 0; a1.safe = 0; b1.safe = 0;
    const e1 = a2.energy;
    SIM.damageShip(Wt, a2, 500, a1);
    assert(a2.energy === e1, 'no friendly fire between teammates');
    SIM.damageShip(Wt, b1, 500, a1);
    assert(b1.energy < b1.maxEnergy, 'enemies still take damage');
    b1.energy = 1;
    SIM.damageShip(Wt, b1, 500, a1);
    assert(b1.dead && a1.streak === 1, 'kill streak increments');
    assert(b1.respawn === 1.4, 'respawnDelay option honored');
    const kev = SIM.drainEvents(Wt).find(e => e.e === 'kill');
    assert(kev && kev.kTeam === 1 && kev.vTeam === 2 && kev.kStreak === 1, 'kill event carries teams + streak');
    // teammate bullets pass through
    Wt.bullets.push({ x: a2.x, y: a2.y, vx: 0, vy: 0, life: 1, dmg: 500, level: 1, bounces: 0, owner: a1 });
    const e2 = a2.energy;
    SIM.updateWorld(Wt, SIM.STEP);
    assert(a2.energy >= e2 - 1, 'teammate bullets pass through harmlessly');
    console.log('OK  teams: FF off, streaks, anchored spawns all behave');
  }

  // the maelstrom: danger zone, storm rock, wormholes
  {
    const Wd = SIM.createWorld({ seed: 99 });
    assert(Wd.danger && Wd.danger.r > 0, 'danger zone generated');
    assert(Wd.rocks.length === 22 && Wd.wormholes.length === 11, 'rocks, storm gates, and faction gates exist');
    const q0 = SIM.rockAt(Wd, Wd.rocks[0], 0), q5 = SIM.rockAt(Wd, Wd.rocks[0], 5);
    assert(Math.hypot(q5.x - q0.x, q5.y - q0.y) > 30, 'storm rock flies');
    const Wd2 = SIM.createWorld({ seed: 99 });
    assert(Wd2.danger.x === Wd.danger.x && Wd2.wormholes[2].dx === Wd.wormholes[2].dx,
      'maelstrom deterministic from seed');
    // rock collision damages a hull
    const rs = SIM.makeShip(Wd, 'corsair', 'local', 'RockTest');
    SIM.spawnShip(Wd, rs);
    const q = SIM.rockAt(Wd, Wd.rocks[0], Wd.time + SIM.STEP);
    rs.x = q.x; rs.y = q.y; rs.vx = 0; rs.vy = 0; rs.safe = 0; rs.rockT = 0; rs.energy = 1000;
    SIM.updateWorld(Wd, SIM.STEP);
    assert(rs.energy < 1000, 'storm rock damages hulls');
    // wormhole warps a hull to its destination in the storm
    const wh = Wd.wormholes[0];
    rs.dead = false; rs.x = wh.x; rs.y = wh.y; rs.vx = 0; rs.vy = 0;
    rs.rockT = 99; rs.wormT = 0; rs.safe = 0; rs.energy = 1000;
    SIM.updateWorld(Wd, SIM.STEP);
    assert(Math.hypot(rs.x - wh.dx, rs.y - wh.dy) < 60, 'wormhole warps ships');
    assert(Math.hypot(wh.dx - Wd.danger.x, wh.dy - Wd.danger.y) < Wd.danger.r, 'gate opens into the storm');
    console.log('OK  maelstrom: storm rock flies + damages, wormholes warp, deterministic');
  }

  // territory, relics, wings, events
  {
    const Wt = SIM.createWorld({ seed: 77 });
    Wt.opts.authority = true;
    assert(Wt.deadZone && Wt.relicSlots.length === 14, 'dead zone + relic slots generated');
    assert(SIM.terrOwner(Wt, (SIM.FACTIONS[1].qx + 0.5) * SIM.QUADPX, (SIM.FACTIONS[1].qy + 0.5) * SIM.QUADPX) === 1,
      'faction home starts owned');
    // capture: three team-2 ships parked in a neutral frontier quadrant
    const capQ = { qx: 1, qy: 2 };
    const caps = [];
    for (let i = 0; i < 3; i++) {
      const s = SIM.makeShip(Wt, 'corsair', 'bot', 'C' + i, null, 2);
      SIM.spawnShip(Wt, s);
      caps.push(s);
    }
    let capEv = null;
    for (let i = 0; i < 50 * 60 && !capEv; i++) {
      for (const s of caps) {
        s.dead = false; s.energy = s.maxEnergy;
        s.x = (capQ.qx + 0.5) * SIM.QUADPX; s.y = (capQ.qy + 0.5) * SIM.QUADPX;
        s.vx = 0; s.vy = 0;
      }
      SIM.updateWorld(Wt, SIM.STEP);
      for (const e of SIM.drainEvents(Wt)) if (e.e === 'capture') capEv = e;
    }
    assert(capEv && capEv.team === 2, 'presence captures a frontier quadrant');
    assert(SIM.terrOwner(Wt, (capQ.qx + 0.5) * SIM.QUADPX, (capQ.qy + 0.5) * SIM.QUADPX) === 2, 'ownership recorded');
    // relic pickup by a local human with the upgrade economy
    const hu = SIM.makeShip(Wt, 'comet', 'local', 'Salvager');
    SIM.spawnShip(Wt, hu);
    hu.noGreens = true;
    const sl = Wt.relicSlots[0];
    hu.x = sl.x; hu.y = sl.y; hu.vx = 0; hu.vy = 0; hu.dead = false;
    SIM.updateWorld(Wt, SIM.STEP);
    const relEv = SIM.drainEvents(Wt).find(e => e.e === 'relic');
    assert(relEv && sl.taken >= 0, 'relic salvaged and slot marked');
    // wing escort: a wingmate with no target closes on its leader
    const wing = caps[0];
    wing.ai.escort = hu.id;
    wing.team = 0; hu.team = 0;    // nobody to fight
    hu.x = SIM.WORLD / 2 + 4000; hu.y = SIM.WORLD / 2; hu.dead = false;
    wing.x = hu.x - 3000; wing.y = hu.y; wing.dead = false; wing.energy = wing.maxEnergy;
    const d0 = Math.hypot(wing.x - hu.x, wing.y - hu.y);
    for (let i = 0; i < 14 * 60; i++) {
      hu.x = SIM.WORLD / 2 + 4000; hu.y = SIM.WORLD / 2; hu.vx = 0; hu.vy = 0; hu.dead = false;
      wing.energy = wing.maxEnergy; wing.dead = false;
      SIM.updateWorld(Wt, SIM.STEP);
    }
    SIM.drainEvents(Wt);
    const d1 = Math.hypot(wing.x - hu.x, wing.y - hu.y);
    assert(d1 < d0 * 0.5, 'wingmate forms on its leader (' + Math.round(d0) + ' -> ' + Math.round(d1) + ')');
    // event timeline: all three types occur, deterministically
    const seen = new Set();
    for (let idx = 0; idx < 60; idx++) {
      for (let p = 14; p < 70; p += 3) {
        Wt.time = idx * 115 + p;
        const E = SIM.evActive(Wt);
        if (E) { seen.add(E.type); break; }
      }
    }
    assert(seen.has('shower') && seen.has('marauders') && seen.has('nova'), 'all event types occur: ' + [...seen]);
    // marauders spawn from the raid timeline on an authority world
    let found = null;
    for (let idx = 0; idx < 60 && !found; idx++) {
      Wt.time = idx * 115 + 30;
      const E = SIM.evActive(Wt);
      if (E && E.type === 'marauders') { SIM.updateWorld(Wt, SIM.STEP); found = Wt.ships.find(s => s.marauder); }
    }
    assert(found && found.team === 5, 'marauder raid spawns hostile-to-all raiders');
    // derelict caches: dense, salvageable, and they fire a pickup event
    assert(Wt.caches && Wt.caches.length > 100, 'derelict caches populate the frontier');
    const scav = SIM.makeShip(Wt, 'comet', 'local', 'Scav');
    SIM.spawnShip(Wt, scav);
    scav.noGreens = true;
    const cache0 = Wt.caches[0];
    scav.x = cache0.x; scav.y = cache0.y; scav.vx = 0; scav.vy = 0; scav.dead = false;
    SIM.updateWorld(Wt, SIM.STEP);
    assert(SIM.drainEvents(Wt).some(e => e.e === 'cache'), 'flying over a derelict cache salvages it');
    // the Dead Zone keeps a standing pirate presence
    assert(SIM.seedDeadZone(Wt, 4).every(m => m.marauder && m.team === 5), 'dead zone seeds marauders');
    console.log('OK  war economy: capture, relics, caches, wing escort, events, marauders');
  }

  // bomb identity: ricochet is a HULL TRAIT, and the fuse is generous
  {
    const Wb = SIM.createWorld({ seed: 21 });
    const mk = type => {
      const s = SIM.makeShip(Wb, type, 'bot', type);
      SIM.spawnShip(Wb, s);
      // spawn rolls two random greens — pin the loadout so the comparison
      // measures the formula, not the dice
      SIM.applyLoadoutDefaults(s);
      s.energy = s.maxEnergy; s.bombCd = 0;
      const before = Wb.bombs.length;
      SIM.fireBomb(Wb, s);
      assert(Wb.bombs.length === before + 1, type + ' fired a bomb');
      return Wb.bombs[Wb.bombs.length - 1];
    };
    const pal = mk('paladin'), cor = mk('corsair'), tit = mk('titan');
    assert(pal.bounces === 3, 'the Paladin alone ricochets its bombs (' + pal.bounces + ')');
    assert(cor.bounces === 0 && tit.bounces === 0, 'other hulls detonate on the wall they hit');
    assert(cor.prox >= 35, 'base proximity fuse is generous (' + cor.prox + ')');
    assert(tit.prox > cor.prox, 'heavier bombs carry a wider fuse');
    SIM.drainEvents(Wb);
    console.log('OK  bombs: ricochet is a hull trait, fuse radius is forgiving');
  }

  // map styles: deterministic per seed, distinct per style
  {
    const wN = SIM.createWorld({ seed: 5, mapStyle: 'nexus' });
    const wG = SIM.createWorld({ seed: 5, mapStyle: 'gauntlet' });
    const wR = SIM.createWorld({ seed: 5, mapStyle: 'rings' });
    const wR2 = SIM.createWorld({ seed: 5, mapStyle: 'rings' });
    const coreSig = w => {
      let h = 0;
      const C = (SIM.MAPS / 2) | 0;
      for (let y = C - 500; y < C + 500; y += 11)
        for (let x = C - 500; x < C + 500; x += 11) h = (h * 31 + (SIM.tileSolid(w, x, y) ? 1 : 0)) | 0;
      return h;
    };
    assert(coreSig(wN) !== coreSig(wG), 'gauntlet differs from nexus');
    assert(coreSig(wN) !== coreSig(wR), 'rings differs from nexus');
    assert(coreSig(wR) === coreSig(wR2), 'same style+seed -> identical map');
  }

  // support roles: warden aura + comet warp beacon
  {
    const Ws = SIM.createWorld({ seed: 11, spawnPrizes: false });
    const war = SIM.makeShip(Ws, 'warden', 'local', 'War', 165, 1);
    const ally = SIM.makeShip(Ws, 'corsair', 'local', 'Ally', 200, 1);
    const sp = SIM.randClearPoint(Ws);
    war.x = sp.x; war.y = sp.y;
    ally.x = sp.x + 60; ally.y = sp.y;
    ally.energy = 100;
    for (let i = 0; i < 60; i++) SIM.updateWorld(Ws, SIM.STEP);
    const withAura = ally.energy - 100;
    ally.energy = 100; war.x = sp.x + 3000 > SIM.WORLD ? 100 : sp.x + 2000; war.y = 100;
    for (let i = 0; i < 60; i++) SIM.updateWorld(Ws, SIM.STEP);
    const without = ally.energy - 100;
    assert(withAura > without * 1.2, 'warden aura boosts recharge (' + withAura.toFixed(0) + ' vs ' + without.toFixed(0) + ')');

    const comet = SIM.makeShip(Ws, 'comet', 'local', 'Com', 210, 1);
    const cp = SIM.randClearPoint(Ws);
    comet.x = cp.x; comet.y = cp.y;
    ally.x = cp.x > SIM.WORLD / 2 ? cp.x - 1500 : cp.x + 1500; ally.y = cp.y;
    ally.energy = 1000; ally.warpCd = 0;
    const warped = SIM.warpToBeacon(Ws, ally);
    assert(warped && Math.hypot(ally.x - comet.x, ally.y - comet.y) < 350, 'comet warp beacon teleports allies');
    assert(SIM.drainEvents(Ws).some(e => e.e === 'warp'), 'warp event emitted');
  }

  // combat feel: universal ricochet, twin cannons, bouncing bombs, prox fuses, strafe
  {
    const Wc = SIM.createWorld({ seed: 21, spawnPrizes: false });
    const cs = SIM.makeShip(Wc, 'corsair', 'local', 'C', 200, 0);
    const sp = SIM.randClearPoint(Wc);
    cs.x = sp.x; cs.y = sp.y; cs.gunCd = 0;
    SIM.fireGun(Wc, cs);
    assert(Wc.bullets.length === 1 && Wc.bullets[0].bounces === 2, 'all bullets ricochet by default');

    const co = SIM.makeShip(Wc, 'comet', 'local', 'T', 282, 0);
    co.x = sp.x; co.y = sp.y; co.gunCd = 0;
    const before = Wc.bullets.length;
    SIM.fireGun(Wc, co);
    assert(Wc.bullets.length - before === 2, 'comet fires twin parallel streams');

    const pa = SIM.makeShip(Wc, 'paladin', 'local', 'P', 210, 0);
    pa.x = sp.x; pa.y = sp.y; pa.bombCd = 0;
    SIM.fireBomb(Wc, pa);
    assert(Wc.bombs[0].bounces === 3, 'paladin bombs ricochet (hull trait, not universal)');
    assert(Wc.bombs[0].prox === 30 + 9, 'base fuse is forgiving');

    const me2 = SIM.makeShip(Wc, 'meteor', 'local', 'M', 18, 0);
    me2.x = sp.x; me2.y = sp.y; me2.bombCd = 0;
    SIM.fireBomb(Wc, me2);
    assert(Wc.bombs[1].prox === 30 + 18 + 28, 'meteor factory prox fuse widens detonation');
    assert(Wc.bombs[1].bounces === 0, 'the bomber does NOT ricochet — that is the Paladin\'s trade');
    assert(SIM.PRIZE_TYPES.some(p => p.n === 'Proximity Fuse'), 'proximity is a green');
    assert(SIM.SHIP_TYPES.hornet.radarStealth, 'hornet is a sensor ghost');

    // strafe thrusters produce lateral velocity (clean world — no crossfire)
    const Ws2 = SIM.createWorld({ seed: 22, spawnPrizes: false });
    const sf = SIM.makeShip(Ws2, 'corsair', 'local', 'S', 200, 0);
    const sp2 = SIM.randClearPoint(Ws2);
    sf.x = sp2.x; sf.y = sp2.y; sf.angle = 0; sf.vx = 0; sf.vy = 0;
    sf.ctl.strafe = 1;
    for (let i = 0; i < 30; i++) SIM.updateWorld(Ws2, SIM.STEP);
    assert(sf.vy > 40 && Math.abs(sf.vx) < 20, 'strafe pushes sideways (vy=' + sf.vy.toFixed(0) + ')');
    sf.ctl.strafe = 0;

    // coast damping: hands-off, a Dagger settles fast, a Titan drifts on.
    // Run it from the arena center — guaranteed clear runway, no wall bounces.
    const dg = SIM.makeShip(Ws2, 'dagger', 'local', 'D', 55, 0);
    const tn = SIM.makeShip(Ws2, 'titan', 'local', 'T', 355, 0);
    for (const sh of [dg, tn]) { sh.x = SIM.WORLD / 2 - 120; sh.y = SIM.WORLD / 2; sh.vx = 150; sh.vy = 0; sh.safe = 99; }
    sf.safe = 99; sf.vx = 0; sf.vy = 0; sf.x = SIM.WORLD / 2; sf.y = SIM.WORLD / 2 - 200;
    for (let i = 0; i < 60; i++) SIM.updateWorld(Ws2, SIM.STEP);   // 1s hands-off
    assert(dg.vx > 0 && tn.vx > 0 && dg.vx < 105 && tn.vx > 125 && dg.vx < tn.vx * 0.75,
      'agile hulls settle, heavies drift (dagger ' + dg.vx.toFixed(0) + ' vs titan ' + tn.vx.toFixed(0) + ')');
    assert(SIM.SHIP_TYPES.dagger.damp > SIM.SHIP_TYPES.titan.damp, 'damp values per hull');
  }

  // ghost interpolation with a jitter buffer
  {
    let fake = 100;
    const Wg = SIM.createWorld({ seed: 3, spawnPrizes: false, ghostInterp: true, now: () => fake });
    const g = SIM.makeShip(Wg, 'corsair', 'remote', 'G', 200, 0);
    g.snaps = [
      { rt: 99.80, x: 1000, y: 1000, vx: 100, vy: 0, a: 0, th: 1, frac: 1, dead: false },
      { rt: 99.90, x: 1010, y: 1000, vx: 100, vy: 0, a: 0, th: 1, frac: 1, dead: false },
      { rt: 100.00, x: 1020, y: 1000, vx: 100, vy: 0, a: 0, th: 1, frac: 1, dead: false },
    ];
    SIM.updateWorld(Wg, SIM.STEP);   // render time = 99.9 -> exactly snap 2
    assert(Math.abs(g.x - 1010) < 3, 'ghost interpolates through the jitter buffer (x=' + g.x.toFixed(1) + ')');
    fake = 100.3;                    // beyond the buffer -> capped extrapolation
    SIM.updateWorld(Wg, SIM.STEP);
    assert(g.x > 1020 && g.x <= 1020 + 100 * 0.15 + 1, 'extrapolation is capped (x=' + g.x.toFixed(1) + ')');
  }

  const me = SIM.makeShip(W, 'corsair', 'local', 'Tester', 190);
  SIM.spawnShip(W, me);
  SIM.drainEvents(W);

  let sawGun = false, sawBomb = false, sawKill = false;
  for (let i = 0; i < 90 * 60; i++) {
    if (!me.dead) {
      me.ctl.thrust = 1;
      me.ctl.gun = true;
      me.ctl.turn = (i % 240) < 120 ? 0.4 : -0.4;
    }
    SIM.updateWorld(W, SIM.STEP);
    for (const e of SIM.drainEvents(W)) {
      if (e.e === 'gun') sawGun = true;
      if (e.e === 'bomb') sawBomb = true;
      if (e.e === 'kill') sawKill = true;
    }
    for (const s of W.ships) assert(finiteShip(s), 'ship finite: ' + s.name);
  }
  assert(sawGun && sawBomb && sawKill, 'combat happened (gun=' + sawGun + ' bomb=' + sawBomb + ' kill=' + sawKill + ')');
  assert(W.prizes.length > 0, 'greens exist');
  const deaths = W.ships.reduce((a, s) => a + s.deaths, 0);
  assert(deaths > 0, 'deaths occurred: ' + deaths);

  // remote ghost mechanics
  const ghost = SIM.makeShip(W, 'dagger', 'remote', 'Ghost', 60);
  ghost.netX = 500; ghost.netY = 500; ghost.netVx = 0; ghost.netVy = 0; ghost.netFrac = 1;
  ghost.x = 400; ghost.y = 400;
  for (let i = 0; i < 120; i++) SIM.updateWorld(W, SIM.STEP);
  assert(Math.abs(ghost.x - 500) < 20 && Math.abs(ghost.y - 500) < 20, 'ghost converges to net state');
  const e0 = ghost.energy;
  SIM.damageShip(W, ghost, 99999, me);
  assert(!ghost.dead, 'remote ghosts are never killed locally');
  console.log('OK  sim: ' + deaths + ' deaths in 90s, ghosts behave');
}

// ============================================================ 2) client test
{
  function makeCtx(owner) {
    const target = {};
    const proxy = new Proxy(target, {
      get(t, p) {
        if (p === 'canvas') return owner;
        if (!(p in t)) t[p] = (...args) => proxy;
        return t[p];
      },
      set() { return true; },
    });
    return proxy;
  }
  function makeCanvas() {
    const c = {
      width: 300, height: 150, style: {},
      addEventListener() { },
      getContext() { return c._ctx || (c._ctx = makeCtx(c)); },
    };
    return c;
  }
  const mainCanvas = makeCanvas();
  const g = {
    SIM,
    document: {
      getElementById: () => mainCanvas,
      createElement: () => makeCanvas(),
      addEventListener() { },
    },
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    addEventListener() { },
    setInterval: () => 0,
    localStorage: {
      _s: {}, getItem(k) { return this._s[k] || null; },
      setItem(k, v) { this._s[k] = String(v); },
    },
    location: { search: '', protocol: 'file:', host: '' },
  };
  g.window = g; g.self = g; g.globalThis = g;
  const code = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  // run client.js with our fake globals in scope
  new Function('window', 'self', 'document', 'localStorage', 'requestAnimationFrame',
    'addEventListener', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'setInterval', 'location',
    'with(window){' + code + '}')(
    g, g, g.document, g.localStorage, g.requestAnimationFrame,
    g.addEventListener, g.innerWidth, g.innerHeight, g.devicePixelRatio, g.setInterval, g.location);

  const api = g.__interstellar;
  assert(api, 'client exported hooks');
  const { G, startSolo, update, render, STEP } = api;
  assert(G.state === 'title', 'client boots to title');
  assert(G.W.ships.length >= 34, 'the zone is populated (' + G.W.ships.length + ' ships)');
  assert(G.W.ships.some(s => s.ai && s.ai.patrolQ != null), 'patrols work the frontier quadrants');
  assert(G.W.ships.some(s => s.marauder), 'the dead zone holds a standing pirate presence');
  for (let i = 0; i < 240; i++) update(STEP);
  render();

  const p = startSolo('titan');
  assert(G.state === 'play' && !p.remote && p.type === 'titan', 'solo game started in a titan');
  api.keys.KeyW = true; api.keys.Space = true;
  let sawMsg = false;
  for (let i = 0; i < 30 * 60; i++) {
    if (!p.dead) { p.ctl.thrust = 1; p.ctl.gun = true; p.ctl.turn = 0.3; }
    update(STEP);
    if (i % 30 === 0) render();
    if (G.msgs.length > 0) sawMsg = true;
    for (const s of G.W.ships) assert(finiteShip(s), 'client ship finite: ' + s.name);
  }
  assert(sawMsg, 'client message feed active');

  // fake a server welcome to exercise the online path (no real socket)
  G.net = { readyState: 1, send() { }, close() { } };
  G.online = true; G.name = 'Tester'; G.pendingShip = 'hornet';
  api.handleNet({
    t: 'welcome', id: 501, hue: 8, seed: 777,
    roster: [{ id: 400, name: 'RemoteBot', ship: 'warden', hue: 100, bot: 1, kills: 0, deaths: 0, score: 0, x: 1000, y: 1000 }],
    prizes: [[9, 800, 800]],
  });
  assert(G.player && G.player.id === 501, 'online welcome created player');
  assert(G.W.byId.get(400) && G.W.byId.get(400).remote, 'roster ghost created');
  assert(G.W.prizes.length === 1 && G.W.prizes[0].id === 9, 'server prizes imported');
  api.handleNet({ t: 'states', s: [[400, 900, 900, 10, 0, 1.5, 0, 0.8, 1]] });
  api.handleNet({ t: 'fire', kind: 'gun', id: 400, shots: [{ x: 900, y: 900, vx: 300, vy: 0 }], level: 2, dmg: 300, bounces: 0 });
  assert(G.W.bullets.length === 1, 'remote fire injected a bullet');
  api.handleNet({ t: 'chat', id: 400, name: 'RemoteBot', text: 'gl hf' });
  for (let i = 0; i < 60; i++) update(STEP);

  // duel mode: 1v1 vs the Ace, first to 5, teams set, match object live
  G.pendingMode = 'duel';
  const dp = api.startSolo('corsair');
  assert(G.match && G.match.mode === 'duel' && G.match.target === 5, 'duel match created');
  assert(G.W.ships.length === 2 && dp.team === 1, 'duel is 1v1 with teams');
  const ace = G.W.ships.find(s => s.name === 'Ace');
  assert(ace && ace.team === 2 && ace.ai.skill > 0.9, 'the Ace is high-skill on team 2');
  for (let i = 0; i < 20 * 60; i++) {
    if (!dp.dead) { dp.ctl.thrust = 0.6; dp.ctl.gun = true; }
    update(STEP);
  }
  assert(G.match.a + G.match.b > 0 || !G.match.over, 'duel runs (score ' + G.match.a + '-' + G.match.b + ')');
  // force match end and rematch path (revive the ace first if mid-respawn)
  const cm = G.match; cm.over = false; cm.a = 4; cm.b = 0;
  if (ace.dead) { ace.respawn = 0; update(STEP); }
  ace.energy = 1; ace.safe = 0;
  SIM.damageShip(G.W, ace, 99999, dp);
  update(STEP);
  assert(G.match.over, 'duel match ends at target');

  // squad mode: 3v3
  G.pendingMode = 'squad';
  const sp2 = api.startSolo('hornet');
  assert(G.match && G.match.mode === 'squad' && G.match.target === 15, 'squad match created');
  assert(G.W.ships.length === 6, 'squad battle is 3v3');
  assert(G.W.ships.filter(s => s.team === 1).length === 3 &&
    G.W.ships.filter(s => s.team === 2).length === 3, 'teams balanced 3-3');
  // give the squads up to 90 simulated seconds, but stop at the first kill —
  // dodging AI can occasionally stalemate a shorter window
  let sawTeamKill = false;
  for (let i = 0; i < 90 * 60 && !sawTeamKill; i++) {
    if (!sp2.dead) { sp2.ctl.thrust = 0.5; sp2.ctl.gun = true; sp2.ctl.turn = (i % 300) < 150 ? 0.3 : -0.3; }
    update(STEP);
    if (G.match.a + G.match.b > 0) sawTeamKill = true;
  }
  assert(sawTeamKill, 'squad battle produced team kills (' + G.match.a + '-' + G.match.b + ')');
  for (const s of G.W.ships) assert(finiteShip(s), 'squad ship finite: ' + s.name);

  // squad ships keep their type-identity hues; team is a relation, not a paint job
  for (const s of G.W.ships) {
    assert(s.hue === api.SIM.SHIP_TYPES[s.type].hue, 'ship keeps type hue: ' + s.name);
  }

  // the zone: persistent world you drop into and out of
  api.G.pendingMode = 'ffa';
  const zp = api.startSolo('corsair');
  assert(G.match === null && G.W.opts.zoneWorld, 'zone mode has no match clock');
  const zoneRef = G.W;
  const zoneScores = G.W.ships.filter(s => s.bot).reduce((a, s) => a + s.kills, 0);
  for (let i = 0; i < 120; i++) update(STEP);
  // leave and re-enter: same world, same bots, history intact
  api.G.state = 'play';
  const leave = api.G;
  // simulate leaving via the exposed flow
  (function () { const i2 = G.W.ships.indexOf(zp); if (i2 >= 0) G.W.ships.splice(i2, 1); })();
  api.G.player = null; api.G.state = 'title';
  api.G.pendingMode = 'ffa';
  api.startSolo('meteor');
  assert(G.W === zoneRef, 'the zone persists across visits — same living world');
  console.log('OK  client: solo, duel, squad, zone, and simulated online paths all run clean');
}

// ============================================================ 3) server test
(async () => {
  const PORT = 8667;
  // fresh pilot database so elo assertions are deterministic
  try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch (e) { }
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), BOTS: '4' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const cleanup = () => { try { srv.kill(); } catch (e) { } };
  process.on('exit', cleanup);

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        if (srvLog.includes('zone server on')) return res();
        if (Date.now() - t0 > 5000) return rej(new Error('server did not start: ' + srvLog));
        setTimeout(poll, 50);
      })();
    });

    // static file serving + zone endpoints
    const html = await fetch('http://localhost:' + PORT + '/').then(r => r.text());
    assert(html.includes('client.js'), 'server serves index.html');
    const simSrc = await fetch('http://localhost:' + PORT + '/sim.js').then(r => r.text());
    assert(simSrc.includes('INTERSTELLAR'), 'server serves sim.js');

    // two real WebSocket clients (Node's built-in WebSocket)
    function client(name, ship) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:' + PORT);
        ws.binaryType = 'arraybuffer';
        const c = { ws, name, msgs: [], bins: [], welcome: null };
        ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, ship }));
        ws.onmessage = m => {
          if (typeof m.data !== 'string') { c.bins.push(new DataView(m.data)); return; }
          const msg = JSON.parse(m.data);
          c.msgs.push(msg);
          if (msg.t === 'welcome') { c.welcome = msg; resolve(c); }
        };
        ws.onerror = () => reject(new Error('ws error for ' + name));
        setTimeout(() => reject(new Error('welcome timeout for ' + name)), 4000);
      });
    }
    function mkStateBuf(x, y, vx, vy, a, dead, th, frac) {
      const b = new ArrayBuffer(23), dv = new DataView(b);
      dv.setUint8(0, 1);
      dv.setFloat32(1, x, true); dv.setFloat32(5, y, true);
      dv.setFloat32(9, vx, true); dv.setFloat32(13, vy, true);
      dv.setFloat32(17, a, true);
      dv.setUint8(21, (dead ? 1 : 0) | (th << 1));
      dv.setUint8(22, Math.round(frac * 255));
      return b;
    }
    function findInStates(c, id) {
      for (let i = c.bins.length - 1; i >= 0; i--) {
        const dv = c.bins[i];
        if (dv.getUint8(0) !== 2) continue;
        const count = dv.getUint16(9, true);
        let off = 11;
        for (let k = 0; k < count && off + 26 <= dv.byteLength; k++, off += 26) {
          if (dv.getUint32(off, true) === id) {
            return { x: dv.getFloat32(off + 4, true), y: dv.getFloat32(off + 8, true) };
          }
        }
      }
      return null;
    }

    const A = await client('Alice', 'corsair');
    assert(A.welcome.id > 0 && Number.isFinite(A.welcome.seed), 'A got welcome with id+seed');
    assert(A.welcome.roster.length === 4, 'A sees 4 bots in roster');
    assert(A.welcome.team === 1 || A.welcome.team === 2, 'teams mode assigns Alice a team');
    assert(A.welcome.goal > 0 && A.welcome.me && A.welcome.me.elo === 1200, 'welcome carries goal + fresh elo');
    const B = await client('Bob', 'warden');
    assert(B.welcome.team === (A.welcome.team === 1 ? 2 : 1), 'Bob balanced onto the other team');
    const bId = B.welcome.id;

    const status = await fetch('http://localhost:' + PORT + '/status').then(r => r.json());
    assert(status.players === 2 && status.mode === 'teams', '/status reports 2 pilots in teams mode');

    // binary state relay: B reports a position, A sees it in a binary snapshot
    B.ws.send(mkStateBuf(1234, 2345, 10, 0, 1, 0, 1, 0.9));
    await new Promise(r => setTimeout(r, 400));
    const seen = findInStates(A, bId);
    assert(seen && Math.abs(seen.x - 1234) < 2 && Math.abs(seen.y - 2345) < 2,
      'A sees Bob via 30Hz binary snapshots (' + (seen ? seen.x : 'none') + ')');
    assert(A.bins.length > 3, 'binary snapshots stream continuously');

    // fire relay + rate validation: 3 instant shots -> only the first relays
    const gunMsg = JSON.stringify({ t: 'fire', kind: 'gun', shots: [{ x: 1234, y: 2345, vx: 500, vy: 0 }], level: 1, dmg: 300, bounces: 0 });
    B.ws.send(gunMsg); B.ws.send(gunMsg); B.ws.send(gunMsg);
    await new Promise(r => setTimeout(r, 300));
    const relayed = A.msgs.filter(m => m.t === 'fire' && m.kind === 'gun' && m.id === bId).length;
    assert(relayed === 1, 'fire-rate validation: 3 rapid shots relayed as ' + relayed);

    // public chat reaches the other team; team chat does not
    A.ws.send(JSON.stringify({ t: 'chat', text: 'hello zone' }));
    A.ws.send(JSON.stringify({ t: 'chat', text: 'secret plan', tc: 1 }));
    await new Promise(r => setTimeout(r, 300));
    assert(B.msgs.some(m => m.t === 'chat' && m.text === 'hello zone'), 'public chat relayed');
    assert(!B.msgs.some(m => m.t === 'chat' && m.text === 'secret plan'), 'team chat stays private');

    // death + score relay — the killer must be NEAR the victim (anti-forgery),
    // so Alice reports a position beside Bob (1234,2345) before the kill
    A.ws.send(mkStateBuf(1260, 2360, 0, 0, 0, 0, 1, 1));
    await new Promise(r => setTimeout(r, 150));
    B.ws.send(JSON.stringify({ t: 'death', killer: A.welcome.id, bounty: 5 }));
    await new Promise(r => setTimeout(r, 300));
    assert(A.msgs.some(m => m.t === 'death' && m.id === bId), 'A saw Bob\'s death');
    assert(A.msgs.some(m => m.t === 'score' && m.id === A.welcome.id && m.score >= 15), 'Alice got kill credit');

    // anti-forgery: a kill claimed for a FAR-AWAY pilot is not credited
    const cScore = (A.msgs.filter(m => m.t === 'score' && m.id === A.welcome.id).pop() || {}).score || 0;
    A.ws.send(mkStateBuf(40000, 40000, 0, 0, 0, 0, 1, 1));   // Alice flies far off
    await new Promise(r => setTimeout(r, 150));
    B.ws.send(JSON.stringify({ t: 'death', killer: A.welcome.id, bounty: 200 }));
    await new Promise(r => setTimeout(r, 300));
    const cScore2 = (A.msgs.filter(m => m.t === 'score' && m.id === A.welcome.id).pop() || {}).score || 0;
    assert(cScore2 === cScore, 'forged kill for a distant pilot is rejected (' + cScore + ' -> ' + cScore2 + ')');
    assert(A.msgs.some(m => m.t === 'prize+'), 'death dropped greens');

    // ---- duel ladder: challenge, accept, first to 5, elo updates
    A.ws.send(JSON.stringify({ t: 'chat', text: '/duel Bob' }));
    await new Promise(r => setTimeout(r, 300));
    assert(B.msgs.some(m => m.t === 'chat' && m.id === 0 && /challenges you/.test(m.text)), 'Bob received the challenge');
    B.ws.send(JSON.stringify({ t: 'chat', text: '/accept' }));
    await new Promise(r => setTimeout(r, 300));
    assert(A.msgs.some(m => m.t === 'duelstart') && B.msgs.some(m => m.t === 'duelstart'), 'duel started for both');
    for (let i = 0; i < 5; i++) {
      B.ws.send(JSON.stringify({ t: 'death', killer: A.welcome.id, bounty: 0 }));
      await new Promise(r => setTimeout(r, 900));   // respect the death spam guard
    }
    const aEnd = A.msgs.find(m => m.t === 'duelend');
    const bEnd = B.msgs.find(m => m.t === 'duelend');
    assert(aEnd && aEnd.won === 1 && aEnd.elo > 1200, 'Alice won the duel and gained elo (' + (aEnd && aEnd.elo) + ')');
    assert(bEnd && bEnd.won === 0 && bEnd.elo < 1200, 'Bob lost elo');
    assert(A.msgs.some(m => m.t === 'duelscore'), 'duel score updates flowed');
    assert(A.msgs.some(m => m.t === 'elo' && m.id === A.welcome.id), 'elo broadcast for badges');
    const ladder = await fetch('http://localhost:' + PORT + '/api/stats').then(r => r.json());
    assert(ladder.some(p => p.name === 'Alice' && p.elo > 1200), '/api/stats ladder shows Alice\'s rating');
    const statsHtml = await fetch('http://localhost:' + PORT + '/stats').then(r => r.text());
    assert(statsHtml.includes('pilot ladder'), '/stats page renders');

    // ---- map voting: majority of 2 triggers a rebuild
    A.ws.send(JSON.stringify({ t: 'chat', text: '/votemap rings' }));
    B.ws.send(JSON.stringify({ t: 'chat', text: '/votemap rings' }));
    await new Promise(r => setTimeout(r, 6200));
    assert(A.msgs.some(m => m.t === 'newmap' && m.style === 'rings'), 'map vote rebuilt the world as rings');

    // leave relay
    B.ws.close();
    await new Promise(r => setTimeout(r, 400));
    assert(A.msgs.some(m => m.t === 'leave' && m.id === bId), 'A saw Bob leave');

    A.ws.close();

    // un-joined socket lifetime: a pilot sitting on the ship-select screen
    // holds an open, un-joined socket and sends keepalives — it must survive.
    // Only a SILENT handshake-and-hold may be reaped. (Runs last: the wait
    // would starve the joined clients above, which send no keepalives.)
    {
      const sel = new WebSocket('ws://localhost:' + PORT);
      let selClosed = false;
      const quiet = new WebSocket('ws://localhost:' + PORT);
      let quietClosed = false;
      sel.onclose = () => { selClosed = true; };
      quiet.onclose = () => { quietClosed = true; };
      await new Promise(r => { sel.onopen = r; });
      await new Promise(r => { quiet.onopen = r; });
      const ka = setInterval(() => { if (sel.readyState === 1) sel.send(JSON.stringify({ t: 'ka' })); }, 3000);
      await new Promise(r => setTimeout(r, 14000));   // past the 12s idle cut
      clearInterval(ka);
      assert(!selClosed, 'ship-select socket with keepalives survives (not reaped)');
      assert(quietClosed, 'silent handshake-and-hold socket is reaped');
      try { sel.close(); quiet.close(); } catch (e) { }
    }
    console.log('OK  server: binary netcode, validation, team chat, duels, ladder, map votes all work');
  } finally {
    cleanup();
  }

  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : '\n' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
