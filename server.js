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
const BOTS = parseInt(process.env.BOTS || '14', 10);
const MODE = (process.env.MODE || 'teams').toLowerCase(); // 'teams' | 'core' | 'ffa'
const GOAL = parseInt(process.env.GOAL || (MODE === 'core' ? '20' : '30'), 10);
const ROOT = __dirname;

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// exactly these paths are served — the game client and its assets, nothing
// else in the deploy directory (not server.js, data/, or .git). PNGs under
// assets/ are allowed by prefix+extension.
const SERVE_FILES = new Set([
  '/index.html', '/interstellar.html', '/client.js', '/sim.js', '/favicon.ico',
]);
const servable = p => SERVE_FILES.has(p) || (p.startsWith('/assets/') && p.endsWith('.png') && p.indexOf('/', 8) === 7);
const httpServer = http.createServer((req, res) => {
  // malformed percent-encoding throws synchronously; without this catch a
  // single 18-byte GET (/%) would kill the whole process
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end(); return; }
  if (urlPath.indexOf('\0') !== -1) { res.writeHead(400); res.end(); return; }  // NUL kills fs.readFile
  if (urlPath === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(zoneStatus()));
    return;
  }
  if (urlPath === '/stats') { statsPage(res); return; }
  if (urlPath === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(ladderTop(50)));
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  // only the explicit game-file allow-list is served — the pilot DB, server
  // source, and .git are invisible
  if (!servable(urlPath)) { res.writeHead(404); res.end(); return; }
  const file = path.normalize(path.join(ROOT, urlPath));
  // real path-prefix test, not a string prefix (blocks sibling dirs like Ss.bak)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});
httpServer.maxConnections = 800;
// last-resort backstop: never let one bad packet take the zone down
process.on('uncaughtException', e => { try { log('uncaught: ' + (e && e.stack || e)); } catch (_) { } });

// ---------------------------------------------------------------- websocket
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
function wsEncode(str, opcode) {
  return wsFrame(Buffer.from(str), opcode == null ? 0x1 : opcode);
}

const clients = new Set();
const byClientId = new Map();   // ship id -> client, for O(1) event crediting
let nextClientSeq = 1;

function wsHandle(sock) {
  const cl = {
    sock, buf: Buffer.alloc(0),
    id: 0, name: '', ship: null,       // ship = sim ghost after join
    joined: false, lastSeen: Date.now(), connT: Date.now(),
    fireAt: Object.create(null), msgTok: 6, msgTokT: Date.now(),
    seq: nextClientSeq++,
  };
  clients.add(cl);
  sock.on('data', chunk => {
    // the common case is an empty carry buffer — skip the concat copy
    cl.buf = cl.buf.length ? Buffer.concat([cl.buf, chunk]) : chunk;
    // a socket that buffers a partial frame it never completes must not grow
    // unbounded — the largest legitimate message is well under 64KB
    if (cl.buf.length > 65536) { dropClient(cl); return; }
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
    if (len > 65536) { dropClient(cl); return; }     // 64KB frame cap
    if (op >= 0x8 && len > 125) { dropClient(cl); return; }   // control frames are ≤125B (RFC6455)
    if (!masked) { dropClient(cl); return; }         // clients MUST mask (RFC6455 §5.1)
    let mask = null;
    {
      if (buf.length < off + 4) return;
      mask = buf.slice(off, off + 4); off += 4;
    }
    if (buf.length < off + len) return;
    const payload = buf.slice(off, off + len);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    cl.buf = buf.slice(off + len);
    if (!fin) { dropClient(cl); return; }            // no fragmentation support
    if (op === 0x8) { dropClient(cl); return; }      // close
    if (op === 0x9) { try { cl.sock.write(wsFrame(payload, 0xA)); } catch (e) { } continue; }
    if (op === 0x2) {                                 // binary: high-rate state
      cl.lastSeen = Date.now();
      onBinary(cl, payload);
      continue;
    }
    if (op !== 0x1) continue;                        // ignore pong
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
    cl.lastSeen = Date.now();
    onMessage(cl, msg);
  }
}
// a slow/non-reading client must not queue the whole broadcast stream in the
// server heap — drop anyone whose socket backlog runs away
function overBackpressure(cl) {
  if (cl.sock.writableLength > 1 << 20) { dropClient(cl); return true; }
  return false;
}
function sendTo(cl, obj) {
  if (overBackpressure(cl)) return;
  try { cl.sock.write(wsEncode(JSON.stringify(obj))); } catch (e) { dropClient(cl); }
}
function broadcast(obj, except) {
  const frame = wsEncode(JSON.stringify(obj));
  for (const cl of clients) {
    if (cl === except || !cl.joined) continue;
    if (overBackpressure(cl)) continue;
    try { cl.sock.write(frame); } catch (e) { dropClient(cl); }
  }
}
function broadcastBin(buf) {
  const frame = wsFrame(buf, 0x2);
  for (const cl of clients) {
    if (!cl.joined) continue;
    if (overBackpressure(cl)) continue;
    try { cl.sock.write(frame); } catch (e) { dropClient(cl); }
  }
}

// binary C2S state packet: u8 tag=1, f32 x,y,vx,vy,angle, u8 flags, u8 fracByte
const MAX_REPORT_SPEED = 900;
function onBinary(cl, buf) {
  if (buf.length < 23 || buf[0] !== 1) return;
  const s = cl.ship;
  if (!s) return;
  const x = buf.readFloatLE(1), y = buf.readFloatLE(5);
  const vx = buf.readFloatLE(9), vy = buf.readFloatLE(13);
  const a = buf.readFloatLE(17);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vx) ||
      !Number.isFinite(vy) || !Number.isFinite(a)) return;
  // sanity clamp — the relay trusts clients, but not infinitely
  s.netX = SIM.clamp(x, 0, SIM.WORLD);
  s.netY = SIM.clamp(y, 0, SIM.WORLD);
  s.netVx = SIM.clamp(vx, -MAX_REPORT_SPEED, MAX_REPORT_SPEED);
  s.netVy = SIM.clamp(vy, -MAX_REPORT_SPEED, MAX_REPORT_SPEED);
  s.netA = a; s.netT = 0;
  const flags = buf[21];
  s.dead = !!(flags & 1);
  s.netTh = (flags >> 1) & 1;
  s.netFrac = buf[22] / 255;
}
function dropClient(cl) {
  if (!clients.has(cl)) return;
  clients.delete(cl);
  if (cl.id) byClientId.delete(cl.id);
  try { cl.sock.destroy(); } catch (e) { }
  if (cl.joined && cl.ship) {
    log(cl.name + ' left the zone');
    if (cl.duel) {
      const d = cl.duel;
      endDuel(d, d.a === cl ? d.b : d.a, cl, true);
    }
    challenges.delete(cl.id);
    SIM.removeShip(W, cl.ship);
    broadcast({ t: 'leave', id: cl.id });
    pdbSave();
  }
}

// optional Origin allow-list — set ALLOW_ORIGIN=https://your.site to stop
// arbitrary pages from silently connecting their visitors to the zone
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
httpServer.on('upgrade', (req, sock, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  if (ALLOW_ORIGIN.length) {
    const origin = req.headers.origin || '';
    if (!ALLOW_ORIGIN.includes(origin)) { sock.destroy(); return; }
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  wsHandle(sock);
  // a frame arriving in the same TCP segment as the handshake would be lost
  if (head && head.length) sock.emit('data', head);
});

// ---------------------------------------------------------------- zone
let SEED = (Math.random() * 1e9) | 0;
let MAPSTYLE = (process.env.MAP || 'nexus').toLowerCase();
const TEAMMODE = MODE === 'teams' || MODE === 'core';
// ships keep their type-identity hue; team reads from halo/ring/nameplates
let SIDES = 0; // flips each round so neither team owns a flank
const worldOpts = { spawnPrizes: true, mapStyle: MAPSTYLE, authority: true };
if (TEAMMODE) {
  const C = SIM.WORLD / 2;
  worldOpts.respawnDelay = 2.2;
  worldOpts.spawnPoint = sh => {
    if (!sh.team) return null;
    const side = SIDES ? 3 - sh.team : sh.team;
    return {
      x: (side === 1 ? C - 950 : C + 950) + SIM.rand(-260, 260),
      y: C + SIM.rand(-320, 320),
      angle: side === 1 ? 0 : Math.PI,
    };
  };
}
let W = SIM.createWorld(Object.assign({ seed: SEED }, worldOpts));
const bots = SIM.addBots(W, BOTS);
if (TEAMMODE) {
  bots.forEach((b, i) => {
    b.team = 1 + (i % 2);
    b.ai.skill = 0.62;
  });
}
for (let i = 0; i < 60; i++) {
  const p = SIM.randClearPoint(W);
  SIM.addPrize(W, p.x, p.y);
}
SIM.drainEvents(W);

// ---------------------------------------------------------------- pilot db
const DATA_DIR = path.join(ROOT, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
// null-prototype DB so a pilot named "__proto__"/"constructor" can't reach
// Object.prototype and poison every stat write in the process
let PDB = Object.create(null);
try { PDB = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'))); } catch (e) { PDB = Object.create(null); }
let saveTimer = null;
function pdbSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PLAYERS_FILE, JSON.stringify(PDB));
    } catch (e) { }
  }, 3000);
}
const PDB_CAP = 5000;
function pilot(name) {
  const key = name.toLowerCase();
  let p = PDB[key];
  if (!p) {
    // evict the least-recently-seen pilot when the DB is full — bounds the
    // disk/heap cost of join-spam with random names
    const keys = Object.keys(PDB);
    if (keys.length >= PDB_CAP) {
      let oldest = keys[0];
      for (const k of keys) if ((PDB[k].seen || 0) < (PDB[oldest].seen || 0)) oldest = k;
      delete PDB[oldest];
    }
    p = PDB[key] = { name, elo: 1200, dw: 0, dl: 0, k: 0, d: 0, shots: 0, hits: 0, score: 0, seen: 0 };
  }
  p.seen = Date.now();
  return p;
}
function ladderTop(n) {
  return Object.values(PDB)
    .sort((a, b) => b.elo - a.elo).slice(0, n)
    .map(p => ({
      name: p.name, elo: Math.round(p.elo), dw: p.dw, dl: p.dl, k: p.k, d: p.d,
      acc: p.shots ? Math.round(p.hits / p.shots * 100) : 0, score: p.score,
    }));
}
function zoneStatus() {
  return {
    zone: 'Interstellar', mode: MODE, map: MAPSTYLE, goal: GOAL,
    players: [...clients].filter(c => c.joined).length,
    bots: W.ships.filter(s => s.bot && !s.dormant).length,
  };
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function statsPage(res) {
  const rows = ladderTop(20).map((p, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + esc(p.name) + '</td><td>' + (p.elo | 0) +
    '</td><td>' + (p.dw | 0) + '–' + (p.dl | 0) + '</td><td>' + (p.k | 0) + '/' + (p.d | 0) +
    '</td><td>' + (p.acc | 0) + '%</td><td>' + (p.score | 0) + '</td></tr>').join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end('<!doctype html><title>Interstellar — ladder</title><style>body{background:#05070f;color:#cde;' +
    'font:14px system-ui;padding:40px}table{border-collapse:collapse}td,th{padding:6px 16px;' +
    'border-bottom:1px solid #1a2a4a;text-align:left}th{color:#8fc2ff}h1{color:#c8ecff}</style>' +
    '<h1>INTERSTELLAR — pilot ladder</h1><table><tr><th>#</th><th>pilot</th><th>elo</th>' +
    '<th>duels</th><th>K/D</th><th>acc</th><th>score</th></tr>' + rows + '</table>');
}

// ---------------------------------------------------------------- webhook
const HOOK_URL = process.env.DISCORD_WEBHOOK || '';
function hook(text) {
  if (!HOOK_URL) return;
  try {
    const u = new URL(HOOK_URL);
    const body = JSON.stringify({ content: text });
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => { });
    req.end(body);
  } catch (e) { }
}

// ---------------------------------------------------------------- duels
const challenges = new Map(); // target client id -> {from, ts}
function findClientByName(n) {
  n = n.toLowerCase();
  return [...clients].find(c => c.joined && c.name.toLowerCase() === n);
}
function sysTo(cl, text) { sendTo(cl, { t: 'chat', id: 0, name: 'ZONE', text }); }
function sysAll(text) { broadcast({ t: 'chat', id: 0, name: 'ZONE', text }); log('[zone] ' + text); }
function startDuel(a, b) {
  const C = SIM.WORLD / 2;
  const d = { a, b, ka: 0, kb: 0, target: 5 };
  a.duel = d; b.duel = d;
  sendTo(a, { t: 'duelstart', opp: b.id, oppName: b.name, x: C - 430, y: C, angle: 0, target: 5 });
  sendTo(b, { t: 'duelstart', opp: a.id, oppName: a.name, x: C + 430, y: C, angle: Math.PI, target: 5 });
  sysAll('DUEL: ' + a.name + ' (' + Math.round(a.pilot.elo) + ') vs ' + b.name + ' (' + Math.round(b.pilot.elo) + ') — first to 5, center arena');
}
function endDuel(d, winner, loser, forfeit) {
  winner.pilot.dw++; loser.pilot.dl++;
  const exp = 1 / (1 + Math.pow(10, (loser.pilot.elo - winner.pilot.elo) / 400));
  const delta = Math.max(1, Math.round(32 * (1 - exp)));
  winner.pilot.elo += delta; loser.pilot.elo -= delta;
  if (winner.ship) winner.ship.elo = winner.pilot.elo;
  if (loser.ship) loser.ship.elo = loser.pilot.elo;
  d.a.duel = null; d.b.duel = null;
  const score = d.a === winner ? d.ka + '–' + d.kb : d.kb + '–' + d.ka;
  sendTo(winner, { t: 'duelend', won: 1, delta, elo: Math.round(winner.pilot.elo) });
  sendTo(loser, { t: 'duelend', won: 0, delta, elo: Math.round(loser.pilot.elo) });
  broadcast({ t: 'elo', id: winner.id, elo: Math.round(winner.pilot.elo) });
  broadcast({ t: 'elo', id: loser.id, elo: Math.round(loser.pilot.elo) });
  const line = winner.name + ' defeats ' + loser.name + ' ' + score +
    (forfeit ? ' (forfeit)' : '') + '  [elo ' + Math.round(winner.pilot.elo) + ' +' + delta + ' / ' +
    Math.round(loser.pilot.elo) + ' −' + delta + ']';
  sysAll('DUEL OVER: ' + line);
  hook('⚔️ ' + line);
  pdbSave();
}
function duelOnDeath(victimCl) {
  const d = victimCl.duel;
  if (!d) return;
  if (d.a === victimCl) d.kb++; else d.ka++;
  sendTo(d.a, { t: 'duelscore', mine: d.ka, theirs: d.kb });
  sendTo(d.b, { t: 'duelscore', mine: d.kb, theirs: d.ka });
  sysAll('DUEL: ' + d.a.name + ' ' + d.ka + ' — ' + d.kb + ' ' + d.b.name);
  if (d.ka >= d.target) endDuel(d, d.a, d.b);
  else if (d.kb >= d.target) endDuel(d, d.b, d.a);
}

// ---------------------------------------------------------------- map votes
let mapChangeT = null;
function scheduleMapChange(style) {
  if (mapChangeT) return;
  sysAll('Map changing to ' + style + ' in 5 seconds...');
  mapChangeT = setTimeout(() => { mapChangeT = null; rebuildWorld(style); }, 5000);
}
function rebuildWorld(style) {
  MAPSTYLE = style;
  SEED = (Math.random() * 1e9) | 0;
  const old = W;
  W = SIM.createWorld(Object.assign({ seed: SEED }, worldOpts, { mapStyle: style }));
  for (const s of old.ships) {
    W.ships.push(s);
    W.byId.set(s.id, s);
    W.nextId = Math.max(W.nextId, s.id + 1);
    if (!s.remote && !s.dormant) SIM.spawnShip(W, s);
  }
  for (let i = 0; i < 60; i++) {
    const p = SIM.randClearPoint(W);
    SIM.addPrize(W, p.x, p.y);
  }
  SIM.drainEvents(W);
  for (const cl of clients) cl.vote = null;
  // the fresh world's seeded prizes must travel too, or clients fly through
  // invisible greens until the next natural spawn
  broadcast({ t: 'newmap', seed: SEED, style, prizes: W.prizes.map(p => [p.id, Math.round(p.x), Math.round(p.y)]) });
  sysAll('Warped to a new ' + style + ' sector.');
}
const tk = { 1: 0, 2: 0 };

// world-clock sync: maelstrom rock positions are a closed-form function of
// W.time, so clients periodically re-align to the server's clock
setInterval(() => {
  if (clients.size) broadcast({ t: 'clock', wt: Math.round(W.time * 100) / 100 });
}, 10000);

const rk = new Map();               // per-round kills, for MVP
const corePts = { 1: 0, 2: 0 };
let coreAcc = 0, coreTeam = 0;
function pickTeam() {
  if (!TEAMMODE) return 0;
  let c1 = 0, c2 = 0;
  for (const s of W.ships) {
    if (s.team === 1) c1++; else if (s.team === 2) c2++;
  }
  return c1 <= c2 ? 1 : 2;
}
function endRound(winnerTeam, detail) {
  const top = [...rk.entries()].sort((x, y) => y[1] - x[1])[0];
  const mvp = top ? W.byId.get(top[0]) : null;
  SIDES ^= 1;
  broadcast({
    t: 'round', winner: winnerTeam, flip: SIDES,
    mvp: mvp ? mvp.name : '', mvpK: top ? top[1] : 0,
  });
  const line = (winnerTeam === 1 ? 'BLUE' : 'RED') + ' wins the round ' + detail +
    (mvp ? '  ·  MVP ' + mvp.name + ' (' + top[1] + ')' : '');
  log('Round over — ' + line);
  hook('🏁 ' + line);
  rk.clear();
  tk[1] = 0; tk[2] = 0;
  corePts[1] = 0; corePts[2] = 0; coreAcc = 0; coreTeam = 0;
  pdbSave();
}
function tallyTeamKill(killer, victim) {
  if (!TEAMMODE || !victim || !victim.team || victim.team > 2) return;
  // marauders (team 5) play by no one's rules: their kills feed neither
  // team's tally, and they can never be round MVP
  if (killer && killer.marauder) return;
  if (killer && killer.team && killer.team <= 2 && killer.team !== victim.team) {
    rk.set(killer.id, (rk.get(killer.id) || 0) + 1);
  }
  const winnerTeam = killer && killer.team && killer.team <= 2 && killer.team !== victim.team
    ? killer.team
    : (victim.team === 1 ? 2 : 1);   // suicide feeds the enemy
  tk[winnerTeam]++;
  broadcast({ t: 'tscore', a: tk[1], b: tk[2] });
  // in core mode, rounds are won by holding the core, not by kills
  if (MODE === 'teams' && tk[winnerTeam] >= GOAL) {
    endRound(winnerTeam, tk[1] + '-' + tk[2]);
  }
}
// core control: one team alone inside the central ring accrues points
function coreTick(dt) {
  if (MODE !== 'core') return;
  const C = SIM.WORLD / 2;
  let present = 0;
  for (const s of W.ships) {
    if (s.dead || !s.team || (s.bot && s.dormant)) continue;
    const x = s.remote ? s.netX : s.x, y = s.remote ? s.netY : s.y;
    if (Math.hypot(x - C, y - C) < 340) present |= s.team === 1 ? 1 : 2;
  }
  const solo = present === 1 ? 1 : present === 2 ? 2 : 0;
  if (solo && solo === coreTeam) {
    coreAcc += dt;
    if (coreAcc >= 3) {
      coreAcc = 0;
      corePts[solo]++;
      broadcast({ t: 'core', o: solo, a: corePts[1], b: corePts[2] });
      if (corePts[solo] >= GOAL) endRound(solo, corePts[1] + '-' + corePts[2] + ' core');
    }
  } else {
    if (solo !== coreTeam) broadcast({ t: 'core', o: solo, a: corePts[1], b: corePts[2] });
    coreTeam = solo;
    coreAcc = 0;
  }
}

function roster() {
  return W.ships.map(s => ({
    id: s.id, name: s.name, ship: s.type, hue: s.hue, bot: s.bot ? 1 : 0,
    team: s.team || 0, elo: s.elo || 0,
    kills: s.kills, deaths: s.deaths, score: s.score, dead: s.dead ? 1 : 0,
    x: Math.round(s.x), y: Math.round(s.y),
  }));
}
function scoreMsg(s) {
  return { t: 'score', id: s.id, kills: s.kills, deaths: s.deaths, score: s.score };
}
function sanitizeName(n) {
  n = String(n || '').replace(/[^\w\-\. ]/g, '').trim().slice(0, 14);
  // reserved object keys make treacherous DB keys even with a null-proto map
  if (/^(__proto__|constructor|prototype)$/i.test(n)) n = '';
  return n || 'Pilot' + (100 + ((Math.random() * 900) | 0));
}

let lastMapChange = 0;
function onCommand(cl, line) {
  const parts = line.trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  switch (cmd) {
    case 'duel': {
      const targetName = parts.join(' ');
      if (!targetName) { sysTo(cl, 'usage: /duel <pilot> · then they type /accept'); return; }
      const target = findClientByName(targetName);
      if (!target || target === cl) { sysTo(cl, 'no such pilot: ' + targetName); return; }
      if (cl.duel || target.duel) { sysTo(cl, 'one of you is already in a duel'); return; }
      challenges.set(target.id, { from: cl.id, ts: Date.now() });
      sysTo(target, cl.name + ' (' + Math.round(cl.pilot.elo) + ') challenges you to a duel — type /accept');
      sysTo(cl, 'challenge sent to ' + target.name);
      break;
    }
    case 'accept': {
      const ch = challenges.get(cl.id);
      if (!ch || Date.now() - ch.ts > 60000) { sysTo(cl, 'no pending challenge'); return; }
      challenges.delete(cl.id);
      const from = [...clients].find(c => c.id === ch.from && c.joined);
      if (!from || from.duel || cl.duel) { sysTo(cl, 'challenger unavailable'); return; }
      startDuel(from, cl);
      break;
    }
    case 'stats': {
      const p = cl.pilot;
      sysTo(cl, p.name + ': elo ' + Math.round(p.elo) + ' · duels ' + p.dw + 'W-' + p.dl +
        'L · ' + p.k + 'K/' + p.d + 'D · acc ' + (p.shots ? Math.round(p.hits / p.shots * 100) : 0) +
        '% · score ' + p.score);
      break;
    }
    case 'votemap': {
      const style = (parts[0] || '').toLowerCase();
      if (!['nexus', 'gauntlet', 'rings'].includes(style)) { sysTo(cl, 'maps: /votemap nexus | gauntlet | rings'); return; }
      cl.vote = style;
      const joined = [...clients].filter(c => c.joined);
      const votes = joined.filter(c => c.vote === style).length;
      sysAll(cl.name + ' votes map ' + style + ' (' + votes + '/' + joined.length + ')');
      // needs ≥2 pilots (a lone pilot's 1 > 0.5 must not rebuild the world)
      // and a 5-minute cooldown to blunt repeat/Sybil abuse
      if (joined.length >= 2 && votes > joined.length / 2 &&
          Date.now() - (lastMapChange || 0) > 300000) {
        lastMapChange = Date.now();
        scheduleMapChange(style);
      }
      break;
    }
    case 'help':
      sysTo(cl, 'commands: /duel <pilot> · /accept · /stats · /votemap <style> · // for team chat');
      break;
    default:
      sysTo(cl, 'unknown command — /help');
  }
}

const HAS = Object.prototype.hasOwnProperty;
const hyp2 = (a, b) => a * a + b * b;
const FIRE_GAP = { gun: 110, bomb: 950, burst: 750, repel: 650, blink: 3200, warp: 8000, worm: 1500 };
// per-client token bucket: bounds chat/command/relic/prize/dmg flooding
function msgAllowed(cl) {
  const now = Date.now();
  cl.msgTok = Math.min(8, cl.msgTok + (now - cl.msgTokT) / 250);   // ~4/s, burst 8
  cl.msgTokT = now;
  if (cl.msgTok < 1) return false;
  cl.msgTok -= 1;
  return true;
}
function onMessage(cl, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'join': {
      if (cl.joined) return;
      if (!HAS.call(SIM.SHIP_TYPES, msg.ship)) return;   // reject __proto__ etc.
      cl.name = sanitizeName(msg.name);
      if (findClientByName(cl.name)) cl.name = cl.name.slice(0, 11) + '.' + ((Math.random() * 90 + 10) | 0);
      cl.pilot = pilot(cl.name);
      const team = pickTeam();
      const ghost = SIM.makeShip(W, msg.ship, 'remote', cl.name, null, team);
      const hue = ghost.hue;   // ship-identity color
      ghost.elo = cl.pilot.elo;
      cl.ship = ghost;
      cl.id = ghost.id;
      byClientId.set(cl.id, cl);
      cl.joined = true;
      sendTo(cl, {
        t: 'welcome', id: cl.id, hue, seed: SEED, team, goal: GOAL, mode: MODE,
        style: MAPSTYLE, flip: SIDES, wt: Math.round(W.time * 100) / 100,
        ta: tk[1], tb: tk[2], ca: corePts[1], cb: corePts[2],
        me: { elo: Math.round(cl.pilot.elo), dw: cl.pilot.dw, dl: cl.pilot.dl },
        roster: roster().filter(r => r.id !== cl.id),
        prizes: W.prizes.map(p => [p.id, Math.round(p.x), Math.round(p.y)]),
      });
      broadcast({ t: 'join', p: { id: cl.id, name: cl.name, ship: msg.ship, hue, team, bot: 0, kills: 0, deaths: 0, score: 0, elo: Math.round(cl.pilot.elo) } }, cl);
      log(cl.name + ' joined as ' + msg.ship + (team ? ' [team ' + team + ']' : '') + ' (' + clients.size + ' online)');
      pdbSave();
      break;
    }
    case 'relic': {
      // a pilot salvaged a relic slot: mark it and tell everyone else —
      // but only if the slot was actually available (two claims in the
      // same round trip must not both count) and the claimant is near it
      if (!cl.joined || !cl.ship || !msgAllowed(cl)) return;
      const i = msg.slot | 0;
      const sl = W.relicSlots && W.relicSlots[i];
      if (sl && (sl.taken < 0 || W.time - sl.taken >= 240) &&
          hyp2(cl.ship.netX - sl.x, cl.ship.netY - sl.y) < 300 * 300) {
        sl.taken = W.time;
        broadcast({ t: 'relic-', i }, cl);
      }
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
      if (!s || s.dead || !cl.joined) return;
      // rate + payload validation: the relay trusts clients, but caps abuse.
      // hasOwnProperty lookup so kind:'__proto__' can't sneak past the gate
      const now = Date.now();
      if (typeof msg.kind !== 'string' || !HAS.call(FIRE_GAP, msg.kind)) return;
      const gap = FIRE_GAP[msg.kind];
      if (now - (cl.fireAt[msg.kind] || 0) < gap) { cl.strikes = (cl.strikes || 0) + 1; if (cl.strikes > 120) dropClient(cl); return; }
      cl.fireAt[msg.kind] = now;
      // near the shooter's last reported position — no firing across the map
      const near = (x, y) => Number.isFinite(x) && Number.isFinite(y) &&
        hyp2(x - s.netX, y - s.netY) < 900 * 900;
      // NEVER relay msg itself — build an explicit whitelisted frame per kind
      let relay = null;
      if (msg.kind === 'gun') {
        if (!Array.isArray(msg.shots) || msg.shots.length > 4) return;   // twin cannons + multifire
        if (!(+msg.dmg <= 900) || !(+msg.bounces <= 3)) return;
        const shots = [];
        for (const sh of msg.shots) {
          if (!sh || !near(sh.x, sh.y)) return;
          if (!(Math.abs(+sh.vx) <= 1500) || !(Math.abs(+sh.vy) <= 1500)) return;
          shots.push({ x: +sh.x, y: +sh.y, vx: +sh.vx, vy: +sh.vy });
        }
        relay = { t: 'fire', kind: 'gun', id: cl.id, shots, level: +msg.level | 0, dmg: +msg.dmg, bounces: +msg.bounces | 0 };
        cl.pilot.shots += shots.length;
        SIM.injectGun(W, s, msg);
      } else if (msg.kind === 'bomb') {
        if (!(+msg.level >= 1 && +msg.level <= 3) || !(+msg.bounces <= 5)) return;
        if (!near(msg.x, msg.y) || !(Math.abs(+msg.vx) <= 1300) || !(Math.abs(+msg.vy) <= 1300)) return;
        const prox = (+msg.prox >= 0 && +msg.prox <= 100) ? +msg.prox : 15;
        msg.prox = prox;
        relay = { t: 'fire', kind: 'bomb', id: cl.id, x: +msg.x, y: +msg.y, vx: +msg.vx, vy: +msg.vy, level: +msg.level | 0, bounces: +msg.bounces | 0, prox };
        SIM.injectBomb(W, s, msg);
      } else if (msg.kind === 'burst') {
        if (!near(msg.x, msg.y)) return;
        relay = { t: 'fire', kind: 'burst', id: cl.id, x: +msg.x, y: +msg.y, vx: +msg.vx || 0, vy: +msg.vy || 0, radius: SIM.clamp(+msg.radius || 90, 0, 200) };
        SIM.injectBurst(W, s, msg);
      } else if (msg.kind === 'repel') {
        if (!near(msg.x, msg.y)) return;
        relay = { t: 'fire', kind: 'repel', id: cl.id, x: +msg.x, y: +msg.y };
        SIM.injectRepel(W, s, msg);
      } else {
        // blink / warp are FX-only; whitelist their endpoints too
        relay = { t: 'fire', kind: msg.kind, id: cl.id,
          x0: +msg.x0 || 0, y0: +msg.y0 || 0, x1: +msg.x1 || 0, y1: +msg.y1 || 0, hue: +msg.hue || s.hue };
      }
      broadcast(relay, cl);
      break;
    }
    case 'dmg': {
      // victim reporting a hit taken: accuracy credit + reaper leech credit
      if (!cl.joined) return;
      if (!msgAllowed(cl)) return;
      const amount = Math.min(1500, Math.max(0, +msg.amount || 0));
      const att = W.byId.get(msg.att | 0);
      if (!att || !amount) return;
      // the named attacker must actually be near the victim reporting the hit
      const s = cl.ship;
      if (s && hyp2((att.remote ? att.netX : att.x) - s.netX, (att.remote ? att.netY : att.y) - s.netY) > 1400 * 1400) return;
      const acl = byClientId.get(att.id);
      if (acl) acl.pilot.hits++;
      if (att.t.leech) {
        const heal = Math.round(amount * att.t.leech);
        if (att.bot) att.energy = Math.min(att.maxEnergy, att.energy + heal);
        else if (acl) sendTo(acl, { t: 'leech', amount: heal });
      }
      break;
    }
    case 'death': {
      const s = cl.ship;
      if (!s) return;
      const now = Date.now();
      if (now - (cl.lastDeath || 0) < 800) return;   // death spam guard
      cl.lastDeath = now;
      s.dead = true;
      s.deaths++;
      cl.pilot.d++;
      const killer = W.byId.get(msg.killer);
      const bounty = Math.max(0, Math.min(200, msg.bounty | 0));
      // a claimed killer must be a live ship near where the victim died —
      // this blocks minting kills/score/elo for arbitrary or offline pilots
      // (full prevention needs pilot auth; owner-trusting netcode lets a
      // victim still self-report, so cap per-pilot credit rate too)
      const validKiller = killer && killer !== s && !killer.dead &&
        hyp2((killer.remote ? killer.netX : killer.x) - s.netX,
             (killer.remote ? killer.netY : killer.y) - s.netY) < 1600 * 1600;
      if (validKiller) {
        killer.kills++;
        killer.score += 10 + bounty;
        broadcast(scoreMsg(killer));
        if (!killer.bot) {
          const kcl = byClientId.get(killer.id);
          const kmin = Math.floor(now / 60000);
          if (kcl && kcl.pilot) {
            if (kcl.credMin !== kmin) { kcl.credMin = kmin; kcl.credK = 0; }
            if (kcl.credK < 40) {   // ~40 credited kills/min ceiling per pilot
              kcl.credK++;
              sendTo(kcl, scoreMsg(killer));
              kcl.pilot.k++;
              kcl.pilot.score += 10 + bounty;
            }
          }
        }
      }
      broadcast(scoreMsg(s));
      sendTo(cl, scoreMsg(s));
      broadcast({ t: 'death', id: cl.id, killer: validKiller ? (msg.killer | 0) : 0, bounty }, cl);
      tallyTeamKill(validKiller ? killer : null, s);
      duelOnDeath(cl);
      pdbSave();
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
      if (!cl.joined || !cl.ship) return;
      const i = W.prizes.findIndex(p => p.id === msg.id);
      // must be near the prize you claim — no map-wide prize wipe
      if (i >= 0 && hyp2(W.prizes[i].x - cl.ship.netX, W.prizes[i].y - cl.ship.netY) < 320 * 320) {
        W.prizes.splice(i, 1);
        broadcast({ t: 'prize-', id: msg.id }, cl);
      }
      break;
    }
    case 'chat': {
      if (!cl.joined || !msgAllowed(cl)) return;
      const text = String(msg.text || '').slice(0, 120).replace(/[\x00-\x1f]/g, '');
      if (!text) return;
      if (text.startsWith('/')) { onCommand(cl, text.slice(1)); return; }
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
    coreTick(SIM.STEP);
    accum -= SIM.STEP;
  }
  // drain sim events: bot weapon fire + kills + prizes need relaying
  for (const e of SIM.drainEvents(W)) {
    switch (e.e) {
      case 'gun':
        broadcast({ t: 'fire', kind: 'gun', id: e.id, shots: e.shots, level: e.level, dmg: e.dmg, bounces: e.bounces });
        break;
      case 'bomb':
        // prox must travel with the bomb — clients compute their own damage,
        // so a dropped fuse radius makes bot bombs systematically weak online
        broadcast({ t: 'fire', kind: 'bomb', id: e.id, x: e.x, y: e.y, vx: e.vx, vy: e.vy, level: e.level, bounces: e.bounces, prox: e.prox });
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
        // bots damaged by a player: accuracy credit + reaper leech credit.
        // ONLY when the victim is server-owned — player-vs-player hits are
        // reported by the victim's own client (dmg), and crediting the
        // ghost collision here too doubled leech and accuracy
        const att = W.byId.get(e.att);
        const vic = W.byId.get(e.id);
        if (att && att.remote && vic && !vic.remote) {
          const acl = byClientId.get(att.id);
          if (acl) {
            acl.pilot.hits++;
            if (att.t.leech) sendTo(acl, { t: 'leech', amount: Math.round(e.dmg * att.t.leech) });
          }
        }
        break;
      }
      case 'warp':
        broadcast({ t: 'fire', kind: 'warp', id: e.id, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, hue: e.hue });
        break;
      case 'worm':   // a bot fell through a wormhole
        broadcast({ t: 'fire', kind: 'worm', id: e.id, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, hue: e.hue });
        break;
      case 'capture':
        broadcast({ t: 'terr', qx: e.qx, qy: e.qy, team: e.team });
        sysAll(SIM.FACTIONS[e.team].name + ' captured quadrant ' +
          String.fromCharCode(65 + e.qx) + (e.qy + 1) + '.');
        break;
      case 'raider':   // marauders spawned by the event timeline join as bots
        broadcast({ t: 'join', p: { id: e.id, name: e.name, ship: e.ship, hue: e.hue, team: 5, bot: 1, kills: 0, deaths: 0, score: 0 } });
        break;
      case 'kill': {
        // a bot died in the server sim
        broadcast({ t: 'death', id: e.victim, killer: e.killer, bounty: e.bounty });
        const v = W.byId.get(e.victim), k = W.byId.get(e.killer);
        if (v) broadcast(scoreMsg(v));
        if (k && k !== v) {
          broadcast(scoreMsg(k));
          const kcl = byClientId.get(k.id);
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
  // 30Hz binary snapshot of every ship (bots simulated + players last-reported)
  // format: u8 tag=2, f64 serverMs, u16 count, then 26B/ship:
  //   u32 id, f32 x,y,vx,vy,angle, u8 flags(dead|thrust<<1), u8 energyFrac
  // (id is u32: a long-lived server outgrows 16 bits and a truncated id
  // silently freezes that pilot's ghost for everyone)
  if (stateAccum >= 1 / 30) {
    stateAccum -= 1 / 30;   // carry the remainder: '= 0' made the rate drift
    const n = W.ships.length;
    const buf = Buffer.allocUnsafe(11 + n * 26);   // every byte is written below
    buf.writeUInt8(2, 0);
    buf.writeDoubleLE(Date.now(), 1);
    buf.writeUInt16LE(n, 9);
    let off = 11;
    for (const sh of W.ships) {
      buf.writeUInt32LE(sh.id >>> 0, off);
      buf.writeFloatLE(sh.remote ? sh.netX : sh.x, off + 4);
      buf.writeFloatLE(sh.remote ? sh.netY : sh.y, off + 8);
      buf.writeFloatLE(sh.remote ? sh.netVx : sh.vx, off + 12);
      buf.writeFloatLE(sh.remote ? sh.netVy : sh.vy, off + 16);
      buf.writeFloatLE(sh.remote ? sh.netA : sh.angle, off + 20);
      buf.writeUInt8((sh.dead ? 1 : 0) | ((sh.remote ? sh.netTh : (sh.ctl.thrust > 0 || sh.rocketT > 0 ? 1 : 0)) << 1), off + 24);
      buf.writeUInt8(Math.round(SIM.clamp(sh.remote ? sh.netFrac : sh.energy / sh.maxEnergy, 0, 1) * 255), off + 25);
      off += 26;
    }
    broadcastBin(buf);
  }
  // kick silent clients (only materialize the set when someone is stale)
  const now2 = Date.now(), cutoff = now2 - 15000, connCut = now2 - 12000;
  let stale = null;
  for (const cl of clients) {
    // joined pilots: silent for 15s. Un-joined sockets: never sent a join
    // within 12s of connecting — a handshake-and-hold memory-DoS vector
    if ((cl.joined && cl.lastSeen < cutoff) || (!cl.joined && cl.connT < connCut))
      (stale || (stale = [])).push(cl);
  }
  if (stale) for (const cl of stale) { if (cl.joined) log('kicking silent client ' + cl.name); dropClient(cl); }
}, 15);

// bot backfill: bots make room as humans arrive, return when they leave
setInterval(() => {
  const humans = [...clients].filter(c => c.joined).length;
  const desired = Math.max(TEAMMODE ? 2 : 0, BOTS - humans);
  const botsArr = W.ships.filter(s => s.bot);
  let active = botsArr.filter(b => !b.dormant).length;
  for (const b of botsArr) {
    if (active > desired && !b.dormant) {
      b.dormant = true;
      if (!b.dead) b.dead = true;
      active--;
      log('bot ' + b.name + ' stands down (' + humans + ' pilots online)');
    } else if (active < desired && b.dormant) {
      b.dormant = false;
      SIM.spawnShip(W, b);
      active++;
      log('bot ' + b.name + ' rejoins the fight');
    }
  }
}, 5000);

function log(m) {
  console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
}

httpServer.listen(PORT, () => {
  log('Interstellar zone server on http://localhost:' + PORT + '  (seed ' + SEED + ', ' + BOTS + ' bots, mode ' + MODE + ')');
  log('Players: open the URL and press O for online multiplayer.');
});
