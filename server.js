#!/usr/bin/env node
/* =========================================================================
   INTERSTELLAR — zone server
   Zero-dependency Node server: static file host + hand-rolled RFC 6455
   WebSocket endpoint on ONE port, running the shared sim for the bots.

   Netcode is an owner-trusting relay: each client owns its own ship
   (position, energy, death) and the server relays state, fire events,
   kills, chat and scores. The server authoritatively runs bots + prizes.

     node server.js            # port 8666, 8 bots
     PORT=9000 BOTS=4 node server.js

   Then open http://localhost:8666 and press O — Online multiplayer.
   ========================================================================= */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SIM = require('./sim.js');

const PORT = parseInt(process.env.PORT || process.argv[2] || '8666', 10);
const BOTS = parseInt(process.env.BOTS || '8', 10);
const MODE = (process.env.MODE || 'teams').toLowerCase(); // 'teams' | 'ffa'
const GOAL = parseInt(process.env.GOAL || '30', 10);      // team kills to win a round
const ROOT = __dirname;

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- websocket
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsEncode(str, opcode) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | (opcode == null ? 0x1 : opcode);
  return Buffer.concat([header, payload]);
}

const clients = new Set();
let nextClientSeq = 1;

function wsHandle(sock) {
  const cl = {
    sock, buf: Buffer.alloc(0),
    id: 0, name: '', ship: null,       // ship = sim ghost after join
    joined: false, lastSeen: Date.now(),
    seq: nextClientSeq++,
  };
  clients.add(cl);
  sock.on('data', chunk => {
    cl.buf = Buffer.concat([cl.buf, chunk]);
    try { wsDrain(cl); } catch (e) { dropClient(cl); }
  });
  sock.on('error', () => dropClient(cl));
  sock.on('close', () => dropClient(cl));
}
function wsDrain(cl) {
  for (;;) {
    const buf = cl.buf;
    if (buf.length < 2) return;
    const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
    const masked = buf[1] & 0x80;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    if (len > 1 << 20) { dropClient(cl); return; }   // 1MB sanity cap
    let mask = null;
    if (masked) {
      if (buf.length < off + 4) return;
      mask = buf.slice(off, off + 4); off += 4;
    }
    if (buf.length < off + len) return;
    const payload = buf.slice(off, off + len);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    cl.buf = buf.slice(off + len);
    if (!fin) { dropClient(cl); return; }            // no fragmentation support
    if (op === 0x8) { dropClient(cl); return; }      // close
    if (op === 0x9) { try { cl.sock.write(wsEncode(payload.toString(), 0xA)); } catch (e) { } continue; }
    if (op !== 0x1) continue;                        // ignore binary/pong
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
    cl.lastSeen = Date.now();
    onMessage(cl, msg);
  }
}
function sendTo(cl, obj) {
  try { cl.sock.write(wsEncode(JSON.stringify(obj))); } catch (e) { dropClient(cl); }
}
function broadcast(obj, except) {
  const frame = wsEncode(JSON.stringify(obj));
  for (const cl of clients) {
    if (cl === except || !cl.joined) continue;
    try { cl.sock.write(frame); } catch (e) { dropClient(cl); }
  }
}
function dropClient(cl) {
  if (!clients.has(cl)) return;
  clients.delete(cl);
  try { cl.sock.destroy(); } catch (e) { }
  if (cl.joined && cl.ship) {
    log(cl.name + ' left the zone');
    SIM.removeShip(W, cl.ship);
    broadcast({ t: 'leave', id: cl.id });
  }
}

httpServer.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  wsHandle(sock);
});

// ---------------------------------------------------------------- zone
const SEED = (Math.random() * 1e9) | 0;
const TEAM_HUES = { 1: [200, 212, 190, 224], 2: [10, 24, 0, 34] };
const worldOpts = { seed: SEED, spawnPrizes: true };
if (MODE === 'teams') {
  const C = SIM.WORLD / 2;
  worldOpts.respawnDelay = 2.2;
  worldOpts.spawnPoint = sh => sh.team ? {
    x: (sh.team === 1 ? C - 950 : C + 950) + SIM.rand(-260, 260),
    y: C + SIM.rand(-320, 320),
    angle: sh.team === 1 ? 0 : Math.PI,
  } : null;
}
const W = SIM.createWorld(worldOpts);
const bots = SIM.addBots(W, BOTS);
if (MODE === 'teams') {
  bots.forEach((b, i) => {
    b.team = 1 + (i % 2);
    b.hue = TEAM_HUES[b.team][(i >> 1) % TEAM_HUES[b.team].length];
    b.ai.skill = 0.62;
  });
}
for (let i = 0; i < 14; i++) {
  const p = SIM.randClearPoint(W);
  SIM.addPrize(W, p.x, p.y);
}
SIM.drainEvents(W);
const HUE_POOL = [190, 8, 35, 55, 110, 150, 210, 240, 262, 300, 330, 20, 90, 180, 315];
let hueIdx = 0;
const teamHueIdx = { 1: 0, 2: 0 };
const tk = { 1: 0, 2: 0 };

function pickTeam() {
  if (MODE !== 'teams') return 0;
  let c1 = 0, c2 = 0;
  for (const s of W.ships) {
    if (s.team === 1) c1++; else if (s.team === 2) c2++;
  }
  return c1 <= c2 ? 1 : 2;
}
function tallyTeamKill(killer, victim) {
  if (MODE !== 'teams' || !victim || !victim.team) return;
  const winnerTeam = killer && killer.team && killer.team !== victim.team
    ? killer.team
    : (victim.team === 1 ? 2 : 1);   // suicide feeds the enemy
  tk[winnerTeam]++;
  broadcast({ t: 'tscore', a: tk[1], b: tk[2] });
  if (tk[winnerTeam] >= GOAL) {
    broadcast({ t: 'match', winner: winnerTeam });
    log('Round over — team ' + (winnerTeam === 1 ? 'BLUE' : 'RED') + ' wins ' + tk[1] + '-' + tk[2]);
    tk[1] = 0; tk[2] = 0;
  }
}

function roster() {
  return W.ships.map(s => ({
    id: s.id, name: s.name, ship: s.type, hue: s.hue, bot: s.bot ? 1 : 0,
    team: s.team || 0,
    kills: s.kills, deaths: s.deaths, score: s.score, dead: s.dead ? 1 : 0,
    x: Math.round(s.x), y: Math.round(s.y),
  }));
}
function scoreMsg(s) {
  return { t: 'score', id: s.id, kills: s.kills, deaths: s.deaths, score: s.score };
}
function sanitizeName(n) {
  n = String(n || '').replace(/[^\w\-\. ]/g, '').trim().slice(0, 14);
  return n || 'Pilot' + (100 + ((Math.random() * 900) | 0));
}

function onMessage(cl, msg) {
  switch (msg.t) {
    case 'join': {
      if (cl.joined) return;
      if (!SIM.SHIP_TYPES[msg.ship]) return;
      cl.name = sanitizeName(msg.name);
      const team = pickTeam();
      const hue = team
        ? TEAM_HUES[team][teamHueIdx[team]++ % TEAM_HUES[team].length]
        : HUE_POOL[hueIdx++ % HUE_POOL.length];
      const ghost = SIM.makeShip(W, msg.ship, 'remote', cl.name, hue, team);
      cl.ship = ghost;
      cl.id = ghost.id;
      cl.joined = true;
      sendTo(cl, {
        t: 'welcome', id: cl.id, hue, seed: SEED, team, goal: GOAL, ta: tk[1], tb: tk[2],
        roster: roster().filter(r => r.id !== cl.id),
        prizes: W.prizes.map(p => [p.id, Math.round(p.x), Math.round(p.y)]),
      });
      broadcast({ t: 'join', p: { id: cl.id, name: cl.name, ship: msg.ship, hue, team, bot: 0, kills: 0, deaths: 0, score: 0 } }, cl);
      log(cl.name + ' joined as ' + msg.ship + (team ? ' [team ' + team + ']' : '') + ' (' + clients.size + ' online)');
      break;
    }
    case 's': {
      const s = cl.ship;
      if (!s) return;
      s.netX = +msg.x || 0; s.netY = +msg.y || 0;
      s.netVx = +msg.vx || 0; s.netVy = +msg.vy || 0;
      s.netA = +msg.a || 0; s.netT = 0;
      s.dead = !!msg.d;
      s.netFrac = SIM.clamp(+msg.f || 0, 0, 1);
      s.netTh = msg.th ? 1 : 0;
      break;
    }
    case 'fire': {
      const s = cl.ship;
      if (!s || s.dead) return;
      // relay to everyone else, and mirror into the server sim so bots react
      const relay = Object.assign({}, msg, { id: cl.id });
      broadcast(relay, cl);
      if (msg.kind === 'gun' && Array.isArray(msg.shots) && msg.shots.length <= 3) SIM.injectGun(W, s, msg);
      else if (msg.kind === 'bomb') SIM.injectBomb(W, s, msg);
      else if (msg.kind === 'burst') SIM.injectBurst(W, s, msg);
      else if (msg.kind === 'repel') SIM.injectRepel(W, s, msg);
      // 'blink' is FX-only: ghost position catches up via state reports
      break;
    }
    case 'leech': {
      // a victim crediting a reaper for stolen energy
      const target = W.byId.get(msg.to | 0);
      const amount = Math.min(600, Math.max(0, +msg.amount || 0));
      if (!target || !target.t.leech || !amount) return;
      if (target.bot) {
        target.energy = Math.min(target.maxEnergy, target.energy + amount);
      } else {
        const tcl = [...clients].find(c => c.id === target.id);
        if (tcl) sendTo(tcl, { t: 'leech', amount });
      }
      break;
    }
    case 'death': {
      const s = cl.ship;
      if (!s) return;
      s.dead = true;
      s.deaths++;
      const killer = W.byId.get(msg.killer);
      const bounty = Math.max(0, msg.bounty | 0);
      if (killer && killer !== s) {
        killer.kills++;
        killer.score += 10 + bounty;
        broadcast(scoreMsg(killer));
        if (!killer.bot) {
          const kcl = [...clients].find(c => c.id === killer.id);
          if (kcl) sendTo(kcl, scoreMsg(killer));
        }
      }
      broadcast(scoreMsg(s));
      sendTo(cl, scoreMsg(s));
      broadcast({ t: 'death', id: cl.id, killer: msg.killer | 0, bounty }, cl);
      tallyTeamKill(killer, s);
      log(s.name + ' killed by ' + (killer ? killer.name : '???'));
      // drop greens at the wreck
      const drops = 2 + ((Math.random() * 2) | 0);
      for (let i = 0; i < drops; i++) {
        const px = s.netX + (Math.random() * 60 - 30), py = s.netY + (Math.random() * 60 - 30);
        if (!SIM.solidAtPx(W, px, py)) {
          const pr = SIM.addPrize(W, px, py);
          broadcast({ t: 'prize+', id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y) });
        }
      }
      break;
    }
    case 'prize': {
      const i = W.prizes.findIndex(p => p.id === msg.id);
      if (i >= 0) {
        W.prizes.splice(i, 1);
        broadcast({ t: 'prize-', id: msg.id }, cl);
      }
      break;
    }
    case 'chat': {
      if (!cl.joined) return;
      const text = String(msg.text || '').slice(0, 120).replace(/[\x00-\x1f]/g, '');
      if (!text) return;
      const tc = msg.tc && cl.ship && cl.ship.team ? 1 : 0;
      const out = { t: 'chat', id: cl.id, name: cl.name, text, tc };
      if (tc) {
        for (const other of clients) {
          if (other === cl || !other.joined || !other.ship) continue;
          if (other.ship.team === cl.ship.team) sendTo(other, out);
        }
      } else broadcast(out, cl);
      log((tc ? '[T' + cl.ship.team + '] ' : '') + '<' + cl.name + '> ' + text);
      break;
    }
    case 'ka':
      break;
  }
}

// ---------------------------------------------------------------- game loop
let last = Date.now(), accum = 0, stateAccum = 0;
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  accum += dt;
  stateAccum += dt;
  while (accum >= SIM.STEP) {
    SIM.updateWorld(W, SIM.STEP);
    accum -= SIM.STEP;
  }
  // drain sim events: bot weapon fire + kills + prizes need relaying
  for (const e of SIM.drainEvents(W)) {
    switch (e.e) {
      case 'gun':
        broadcast({ t: 'fire', kind: 'gun', id: e.id, shots: e.shots, level: e.level, dmg: e.dmg, bounces: e.bounces });
        break;
      case 'bomb':
        broadcast({ t: 'fire', kind: 'bomb', id: e.id, x: e.x, y: e.y, vx: e.vx, vy: e.vy, level: e.level, bounces: e.bounces });
        break;
      case 'burst':
        broadcast({ t: 'fire', kind: 'burst', id: e.id, x: e.x, y: e.y, vx: e.vx, vy: e.vy, radius: e.radius });
        break;
      case 'repel':
        broadcast({ t: 'fire', kind: 'repel', id: e.id, x: e.x, y: e.y });
        break;
      case 'blink':
        broadcast({ t: 'fire', kind: 'blink', id: e.id, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, hue: e.hue });
        break;
      case 'hit': {
        // bots damaged by a remote reaper: credit the stolen energy back
        const att = W.byId.get(e.att);
        if (att && att.remote && att.t.leech) {
          const acl = [...clients].find(c => c.id === att.id);
          if (acl) sendTo(acl, { t: 'leech', amount: Math.round(e.dmg * att.t.leech) });
        }
        break;
      }
      case 'kill': {
        // a bot died in the server sim
        broadcast({ t: 'death', id: e.victim, killer: e.killer, bounty: e.bounty });
        const v = W.byId.get(e.victim), k = W.byId.get(e.killer);
        if (v) broadcast(scoreMsg(v));
        if (k && k !== v) {
          broadcast(scoreMsg(k));
          const kcl = [...clients].find(c => c.id === k.id);
          if (kcl) sendTo(kcl, scoreMsg(k));
        }
        tallyTeamKill(k, v);
        log((v ? v.name : '?') + ' killed by ' + (k ? k.name : '???') + ' [bots]');
        break;
      }
      case 'prizeSpawn':
        broadcast({ t: 'prize+', id: e.prize, x: Math.round(e.x), y: Math.round(e.y) });
        break;
      case 'prizeGone':
        broadcast({ t: 'prize-', id: e.prize });
        break;
      case 'take':
        broadcast({ t: 'prize-', id: e.prize });
        break;
    }
  }
  // 15Hz snapshot of every ship (bots simulated + players last-reported)
  if (stateAccum >= 1 / 15) {
    stateAccum = 0;
    const s = W.ships.map(sh => [
      sh.id,
      Math.round((sh.remote ? sh.netX : sh.x) * 10) / 10,
      Math.round((sh.remote ? sh.netY : sh.y) * 10) / 10,
      Math.round(sh.remote ? sh.netVx : sh.vx),
      Math.round(sh.remote ? sh.netVy : sh.vy),
      Math.round((sh.remote ? sh.netA : sh.angle) * 100) / 100,
      sh.dead ? 1 : 0,
      Math.round(SIM.clamp(sh.remote ? sh.netFrac : sh.energy / sh.maxEnergy, 0, 1) * 100) / 100,
      sh.remote ? sh.netTh : (sh.ctl.thrust > 0 || sh.rocketT > 0 ? 1 : 0),
    ]);
    broadcast({ t: 'states', s });
  }
  // kick silent clients
  const cutoff = Date.now() - 15000;
  for (const cl of [...clients]) {
    if (cl.joined && cl.lastSeen < cutoff) { log('kicking silent client ' + cl.name); dropClient(cl); }
  }
}, 15);

function log(m) {
  console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
}

httpServer.listen(PORT, () => {
  log('Interstellar zone server on http://localhost:' + PORT + '  (seed ' + SEED + ', ' + BOTS + ' bots, mode ' + MODE + ')');
  log('Players: open the URL and press O for online multiplayer.');
});
