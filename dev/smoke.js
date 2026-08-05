/* Headless smoke test for Continuum Redux.
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
  assert(W.map.length === SIM.MAPS * SIM.MAPS, 'map generated');
  // deterministic map from seed
  const W2 = SIM.createWorld({ seed: 42 });
  assert(Buffer.from(W.map).equals(Buffer.from(W2.map)), 'same seed -> same map');
  const W3 = SIM.createWorld({ seed: 43 });
  assert(!Buffer.from(W.map).equals(Buffer.from(W3.map)), 'different seed -> different map');

  SIM.addBots(W, 10);
  assert(W.ships.length === 10, 'ten bots spawned');
  assert(Object.keys(SIM.SHIP_TYPES).length === 12, '8 classic + 4 REDUX hulls exist');
  for (const key of ['warbird', 'javelin', 'spider', 'leviathan', 'terrier', 'weasel', 'lancaster', 'shark',
    'vanguard', 'aegis', 'reaper', 'phantom'])
    assert(SIM.SHIP_TYPES[key], 'ship type ' + key + ' exists');

  // REDUX mechanics
  {
    const Wm = SIM.createWorld({ seed: 7, spawnPrizes: false });
    const van = SIM.makeShip(Wm, 'vanguard', 'local', 'Van', 45);
    assert(van.multi && van.bounceBullets, 'vanguard ships factory multifire + ricochet');

    const aeg = SIM.makeShip(Wm, 'aegis', 'local', 'Aeg', 215);
    const wb = SIM.makeShip(Wm, 'warbird', 'local', 'Wb', 190);
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

  const me = SIM.makeShip(W, 'warbird', 'local', 'Tester', 190);
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
  const ghost = SIM.makeShip(W, 'weasel', 'remote', 'Ghost', 60);
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

  const api = g.__continuum;
  assert(api, 'client exported hooks');
  const { G, startSolo, update, render, STEP } = api;
  assert(G.state === 'title', 'client boots to title');
  assert(G.W.ships.length === 10, 'attract-mode bots exist');
  for (let i = 0; i < 240; i++) update(STEP);
  render();

  const p = startSolo('leviathan');
  assert(G.state === 'play' && !p.remote && p.type === 'leviathan', 'solo game started in a leviathan');
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
  G.online = true; G.name = 'Tester'; G.pendingShip = 'spider';
  api.handleNet({
    t: 'welcome', id: 501, hue: 8, seed: 777,
    roster: [{ id: 400, name: 'RemoteBot', ship: 'shark', hue: 100, bot: 1, kills: 0, deaths: 0, score: 0, x: 1000, y: 1000 }],
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
  console.log('OK  client: solo + simulated online path both run clean');
}

// ============================================================ 3) server test
(async () => {
  const PORT = 8667;
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

    // static file serving
    const html = await fetch('http://localhost:' + PORT + '/').then(r => r.text());
    assert(html.includes('client.js'), 'server serves index.html');
    const simSrc = await fetch('http://localhost:' + PORT + '/sim.js').then(r => r.text());
    assert(simSrc.includes('CONTINUUM REDUX'), 'server serves sim.js');

    // two real WebSocket clients (Node's built-in WebSocket)
    function client(name, ship) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:' + PORT);
        const c = { ws, name, msgs: [], welcome: null };
        ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, ship }));
        ws.onmessage = m => {
          const msg = JSON.parse(m.data);
          c.msgs.push(msg);
          if (msg.t === 'welcome') { c.welcome = msg; resolve(c); }
        };
        ws.onerror = e => reject(new Error('ws error for ' + name));
        setTimeout(() => reject(new Error('welcome timeout for ' + name)), 4000);
      });
    }
    const A = await client('Alice', 'warbird');
    assert(A.welcome.id > 0 && Number.isFinite(A.welcome.seed), 'A got welcome with id+seed');
    assert(A.welcome.roster.length === 4, 'A sees 4 bots in roster');
    const B = await client('Bob', 'shark');
    assert(B.welcome.roster.some(r => r.name === 'Alice'), 'B sees Alice in roster');

    // A should be told about B joining
    await new Promise(r => setTimeout(r, 300));
    assert(A.msgs.some(m => m.t === 'join' && m.p && m.p.name === 'Bob'), 'A received join(Bob)');

    // state relay: B reports a position, A should see it in a states broadcast
    B.ws.send(JSON.stringify({ t: 's', x: 1234, y: 2345, vx: 10, vy: 0, a: 1, d: 0, f: 0.9, th: 1 }));
    await new Promise(r => setTimeout(r, 400));
    const bId = B.welcome.id;
    assert(A.msgs.some(m => m.t === 'states' && m.s.some(row => row[0] === bId && Math.abs(row[1] - 1234) < 2)),
      'A sees Bob position via states broadcast');
    assert(A.msgs.some(m => m.t === 'states'), 'bot states are broadcast');

    // fire relay
    B.ws.send(JSON.stringify({ t: 'fire', kind: 'gun', shots: [{ x: 1234, y: 2345, vx: 500, vy: 0 }], level: 1, dmg: 300, bounces: 0 }));
    await new Promise(r => setTimeout(r, 300));
    assert(A.msgs.some(m => m.t === 'fire' && m.kind === 'gun' && m.id === bId), 'A received Bob\'s gunfire');

    // chat relay
    A.ws.send(JSON.stringify({ t: 'chat', text: 'hello zone' }));
    await new Promise(r => setTimeout(r, 300));
    assert(B.msgs.some(m => m.t === 'chat' && m.text === 'hello zone' && m.name === 'Alice'), 'B received Alice\'s chat');

    // death + score relay
    B.ws.send(JSON.stringify({ t: 'death', killer: A.welcome.id, bounty: 5 }));
    await new Promise(r => setTimeout(r, 300));
    assert(A.msgs.some(m => m.t === 'death' && m.id === bId), 'A saw Bob\'s death');
    assert(A.msgs.some(m => m.t === 'score' && m.id === A.welcome.id && m.score >= 15), 'Alice got kill credit (10+bounty)');
    assert(A.msgs.some(m => m.t === 'prize+'), 'death dropped greens');

    // leave relay
    B.ws.close();
    await new Promise(r => setTimeout(r, 400));
    assert(A.msgs.some(m => m.t === 'leave' && m.id === bId), 'A saw Bob leave');

    A.ws.close();
    console.log('OK  server: join/state/fire/chat/death/leave all relay correctly');
  } finally {
    cleanup();
  }

  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : '\n' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
