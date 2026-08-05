/* Headless smoke test for Continuum Redux.
   Runs the real game code under Node with a stubbed DOM/canvas, simulates
   ~90 seconds of combat, and asserts the world stays sane (no NaNs, bots
   fight, bullets fly, deaths/respawns and prizes work).
   Usage: node dev/smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- fake DOM ------------------------------------------------------------
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
    addEventListener() {},
    getContext() { return c._ctx || (c._ctx = makeCtx(c)); },
  };
  return c;
}

const listeners = {};
const fakeDoc = {
  getElementById: () => mainCanvas,
  createElement: () => makeCanvas(),
  addEventListener() {},
  body: {},
};
const mainCanvas = makeCanvas();

global.window = global;
global.document = fakeDoc;
global.innerWidth = 1280;
global.innerHeight = 720;
global.devicePixelRatio = 1;
global.requestAnimationFrame = () => 0; // never fires; we drive updates manually
global.addEventListener = (ev, fn) => { listeners[ev] = fn; };
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] || null; },
  setItem(k, v) { this._s[k] = String(v); },
};
// no AudioContext on purpose — audio must degrade gracefully

// ---- load the game -------------------------------------------------------
const code = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
new Function(code)();

const api = global.__continuum;
if (!api) throw new Error('game did not export __continuum test hooks');
const { G, startGame, update, render, keys, STEP } = api;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); }
}
function finiteShip(s) {
  return Number.isFinite(s.x) && Number.isFinite(s.y) &&
    Number.isFinite(s.vx) && Number.isFinite(s.vy) &&
    Number.isFinite(s.angle) && Number.isFinite(s.energy);
}

// ---- scenario ------------------------------------------------------------
assert(G.state === 'title', 'boots to title, got ' + G.state);
assert(G.ships.length === 10, 'ten bots spawned, got ' + G.ships.length);
assert(G.map && G.map.length === 192 * 192, 'map generated');

// attract mode runs (bots-only sim + render with stub ctx)
for (let i = 0; i < 300; i++) update(STEP);
render();

const player = startGame('warbird');
assert(G.state === 'play', 'entered play state');
assert(G.ships.includes(player), 'player joined the zone');

// hold thrust + fire for a while, then let AI-driven chaos run
keys.KeyW = true;
keys.Space = true;
let sawBullets = false, sawBombs = false, sawParts = false;
let totalDeaths = 0;
const simSeconds = 90;
for (let i = 0; i < simSeconds * 60; i++) {
  // emulate the per-frame input sampling the rAF loop does
  const c = player.ctl;
  if (!player.dead && !G.paused) {
    c.thrust = keys.KeyW ? 1 : 0;
    c.gun = !!keys.Space;
    c.turn = (i % 240) < 120 ? 0.4 : -0.4;
  }
  update(STEP);
  if (i % 60 === 0) render();
  if (G.bullets.length > 0) sawBullets = true;
  if (G.bombs.length > 0) sawBombs = true;
  if (G.parts.length > 0) sawParts = true;
  for (const s of G.ships) assert(finiteShip(s), 'ship state finite for ' + s.name + ' at t=' + (i / 60).toFixed(1));
  for (const b of G.bullets) assert(Number.isFinite(b.x) && Number.isFinite(b.y), 'bullet finite');
  for (const b of G.bombs) assert(Number.isFinite(b.x) && Number.isFinite(b.y), 'bomb finite');
}
totalDeaths = G.ships.reduce((a, s) => a + s.deaths, 0);

assert(sawBullets, 'bullets were fired during the sim');
assert(sawBombs, 'bombs were fired during the sim');
assert(sawParts, 'particles were emitted');
assert(totalDeaths > 0, 'at least one kill happened in ' + simSeconds + 's of combat');
assert(G.prizes.length > 0, 'greens exist in the world');
assert(G.msgs.length > 0, 'kill feed has messages');

// every ship stays inside the world and off walls
for (const s of G.ships) {
  if (s.dead) continue;
  assert(s.x > 0 && s.x < 3072 && s.y > 0 && s.y < 3072, s.name + ' inside world bounds');
}

// death/respawn cycle sanity: force-kill the player, wait, expect respawn
if (!player.dead) {
  player.energy = -1;
  player.safe = 0;
  // trip damage path via a fake hit
  const killer = G.ships.find(s => s !== player && !s.dead) || player;
  player.energy = 10;
  const dmg = 99999;
  // use exported update loop after direct energy drop
  player.energy -= dmg;
  // simulate the kill through the real path: bullet impact
}
player.safe = 0;
if (!player.dead) {
  // spawn a synthetic bullet on top of the player from the first bot
  const bot = G.ships.find(s => s.bot && !s.dead);
  G.bullets.push({ x: player.x, y: player.y, vx: 0, vy: 0, life: 1, dmg: 99999, level: 3, bounces: 0, owner: bot });
  update(STEP);
}
assert(player.dead, 'player dies to overwhelming damage');
for (let i = 0; i < 4 * 60; i++) update(STEP);
assert(!player.dead, 'player respawned after timer');
assert(player.energy > 0 && finiteShip(player), 'respawned player is sane');

// pause blocks simulation
G.paused = true;
const fx = player.x, fy = player.y, t0 = G.ships.map(s => s.x + s.y).join(',');
for (let i = 0; i < 60; i++) update(STEP);
assert(G.ships.map(s => s.x + s.y).join(',') === t0, 'pause freezes the world');
G.paused = false;

// leaderboard data sane
for (const s of G.ships) {
  assert(Number.isFinite(s.score) && s.score >= 0, 'score sane for ' + s.name);
  assert(s.kills >= 0 && s.deaths >= 0, 'k/d sane for ' + s.name);
}

console.log('OK  — smoke test passed');
console.log('     deaths in ' + simSeconds + 's of combat: ' + totalDeaths);
console.log('     live entities: ships=' + G.ships.length + ' bullets=' + G.bullets.length +
  ' bombs=' + G.bombs.length + ' greens=' + G.prizes.length + ' particles=' + G.parts.length);
console.log('     kill feed tail: ' + G.msgs.slice(-3).map(m => JSON.stringify(m.text)).join(' | '));
