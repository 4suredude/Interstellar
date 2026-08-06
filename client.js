/* =========================================================================
   INTERSTELLAR — browser client
   Rendering (sprites + bloom), input, menus, audio, and the relay
   netcode client. All world simulation lives in sim.js (shared with the
   server); this file owns everything the player sees and hears.
   ========================================================================= */
(function () {
  'use strict';
  const GLOBAL = typeof window !== 'undefined' ? window : globalThis;
  const SIM = GLOBAL.SIM;
  const { TAU, TILE, MAPS, WORLD, STEP, SHIP_ORDER, SHIP_TYPES, clamp, rand, angleNorm } = SIM;
  const hyp = Math.hypot;
  const irand = n => (Math.random() * n) | 0;

  // ---------------------------------------------------------------- state
  const G = {
    state: 'boot',      // title | select | nameentry | connecting | error | play
    online: false,
    paused: false, muted: false,
    time: 0, beepT: 0,
    W: null,            // sim world
    player: null,
    parts: [], waves: [], msgs: [],
    cam: { x: WORLD / 2, y: WORLD / 2 }, shake: 0, hitFlash: 0,
    sel: 0, best: 0, deathBy: '',
    mode: 'ffa', pendingMode: 'squad', match: null,
    banner: null, lastKillT: -99, combo: 0, duelW: 0, duelL: 0,
    demoT: 0, demoShip: null,
    mapBig: null, radarC: null,
    // net
    net: null, netErr: '', myId: 0, name: '', nameStr: '', stateTick: 0, kaTimer: 0,
    chatOpen: false, chatStr: '',
    zoneStatus: null, zoneMode: '', sideFlip: 0, duel: null, myElo: 0,
    lastKillerId: 0, coreOwner: 0,
    shoot: null, shootT: 6,
  };
  const keys = Object.create(null);
  let canvas = null, ctx = null, vw = 1280, vh = 720, dpr = 1;
  let vignette = null, bloomC = null, bloomCtx = null, filterOK = false;

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
  const sndChat = () => tone('sine', 520, 520, 0.05, 0.08);
  const sndBlink = (x, y) => {
    const v = worldVol(x, y, 0.28); if (v < 0.01) return;
    tone('sine', 300, 1400, 0.12, v);
    tone('sine', 1400, 250, 0.18, v * 0.7, 0.1);
  };
  // combat-feel confirms — these are what make landing shots feel good
  const sndHitTick = () => tone('sine', 1350, 1000, 0.045, 0.14);
  const sndKill = () => { tone('square', 520, 780, 0.07, 0.2); tone('square', 780, 1180, 0.11, 0.2, 0.07); };
  const sndWin = () => { [440, 554, 659, 880].forEach((f, i) => tone('sine', f, f, 0.35, 0.2, i * 0.13)); };
  const sndLose = () => { [330, 311, 233].forEach((f, i) => tone('sine', f, f * 0.97, 0.4, 0.18, i * 0.18)); };

  // ---------------------------------------------------------------- music
  // Generative space electronica, synthesized live — no audio files.
  // A 16-bar loop: slow minor pads, a sub bass, a delayed arpeggio,
  // soft four-on-the-floor kick and offbeat hats, and rare high sparkles.
  const MUS = { on: true, step: 0, nextT: 0 };
  const MUS_BPM = 96, MUS_STEP = 60 / MUS_BPM / 4; // 16th notes
  // i — VI — III — VII in A minor, voiced low and wide
  const MUS_CHORDS = [
    [57, 60, 64, 69],   // Am
    [53, 57, 60, 65],   // F
    [48, 55, 60, 64],   // C
    [55, 59, 62, 67],   // G
  ];
  const MUS_ARP_PAT = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1];
  const midiF = m => 440 * Math.pow(2, (m - 69) / 12);

  function musicInit() {
    if (!SFX.ctx || SFX.musBus) return;
    const a = SFX.ctx;
    SFX.musBus = a.createGain();
    SFX.musBus.gain.value = 0.3;
    SFX.musBus.connect(SFX.master);
    // dotted-8th feedback delay for the arp — the classic space echo
    const d = a.createDelay(1);
    d.delayTime.value = MUS_STEP * 3;
    const fb = a.createGain(); fb.gain.value = 0.35;
    const wet = a.createGain(); wet.gain.value = 0.45;
    d.connect(fb); fb.connect(d);
    d.connect(wet); wet.connect(SFX.musBus);
    SFX.musDelay = d;
  }
  function musNote(t, freq, dur, vol, type, lp, echo) {
    const a = SFX.ctx;
    const o = a.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head = o;
    if (lp) {
      const f = a.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = lp;
      o.connect(f); head = f;
    }
    head.connect(g);
    g.connect(SFX.musBus);
    if (echo && SFX.musDelay) g.connect(SFX.musDelay);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function musPad(t, chord, dur) {
    const a = SFX.ctx;
    // deep root drone
    musNote(t, midiF(chord[0] - 24), dur, 0.09, 'sine', 0, false);
    // two detuned saws per chord tone, slow bloom
    for (const m of chord.slice(0, 3)) {
      for (const det of [0.9965, 1.0035]) {
        const o = a.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = midiF(m) * det;
        const f = a.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(320, t);
        f.frequency.linearRampToValueAtTime(750, t + dur * 0.5);
        f.frequency.linearRampToValueAtTime(320, t + dur);
        const g = a.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.035, t + 1.6);
        g.gain.setValueAtTime(0.035, t + dur - 1.8);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(f); f.connect(g); g.connect(SFX.musBus);
        o.start(t); o.stop(t + dur + 0.1);
      }
    }
  }
  function musKick(t) {
    const a = SFX.ctx;
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(115, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    const g = a.createGain();
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(SFX.musBus);
    o.start(t); o.stop(t + 0.2);
  }
  function musHat(t, vol) {
    const a = SFX.ctx;
    const src = a.createBufferSource();
    src.buffer = SFX.noise;
    src.loop = true;
    const f = a.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7000;
    const g = a.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(f); f.connect(g); g.connect(SFX.musBus);
    src.start(t); src.stop(t + 0.08);
  }
  function musScheduleStep(step, t) {
    const chord = MUS_CHORDS[(step >> 6) & 3];   // chord change every 4 bars
    const s16 = step & 15;
    if ((step & 63) === 0) musPad(t, chord, 64 * MUS_STEP + 0.5);
    if (s16 === 0 || s16 === 10) musNote(t, midiF(chord[0] - 12), 0.5, 0.4, 'triangle', 320, false);
    if ((step & 3) === 0) musKick(t);
    if ((step & 3) === 2) musHat(t, 0.045);
    if (MUS_ARP_PAT[s16]) {
      const tone = chord[((step * 7) >> 2) % chord.length] + 12 * (1 + ((step >> 3) & 1));
      musNote(t, midiF(tone), 0.26, 0.13 + Math.random() * 0.04, 'square', 1900, true);
    }
    if (Math.random() < 0.018) {
      musNote(t, midiF(84 + [0, 3, 7, 10][irand(4)]), 1.8, 0.05, 'sine', 0, true);
    }
  }
  function musicTick() {
    if (!SFX.ctx || !MUS.on || G.muted || SFX.ctx.state !== 'running') return;
    musicInit();
    const now = SFX.ctx.currentTime;
    if (MUS.nextT < now - 0.5) MUS.nextT = now + 0.06;  // resync after tab sleep
    const ahead = now + 0.35;
    while (MUS.nextT < ahead) {
      musScheduleStep(MUS.step, MUS.nextT);
      MUS.step = (MUS.step + 1) & 511;
      MUS.nextT += MUS_STEP;
    }
  }

  // ---------------------------------------------------------------- messages
  function say(text, color) {
    G.msgs.push({ text, color: color || '#8f8', t: 0 });
    if (G.msgs.length > 40) G.msgs.shift();
  }
  function banner(main, sub, dur) {
    G.banner = { main, sub: sub || '', t: 0, dur: dur || 2.6 };
  }

  // ---------------------------------------------------------------- match logic
  function myTeam() { return G.player ? G.player.team : 0; }
  function matchScoreKill(e) {
    const m = G.match;
    if (!m || m.over || m.online || !e.vTeam) return;
    if (m.mode === 'core') return;   // core rounds are won by holding the ring
    if (e.kTeam && e.kTeam !== e.vTeam) { if (e.kTeam === 1) m.a++; else m.b++; }
    else { if (e.vTeam === 1) m.b++; else m.a++; }   // suicide feeds the enemy
    checkMatchEnd();
  }
  function checkMatchEnd() {
    const m = G.match;
    if (!m || m.over || (m.a < m.target && m.b < m.target)) return;
    m.over = true;
    const winTeam = m.a >= m.target ? 1 : 2;
    const won = winTeam === myTeam();
    banner(won ? 'VICTORY' : 'DEFEAT', 'ENTER — rematch  ·  BACKSPACE — hangar', 30);
    if (won) sndWin(); else sndLose();
    if (m.mode === 'duel') {
      if (won) G.duelW++; else G.duelL++;
      try { GLOBAL.localStorage.setItem('interstellar-duels', G.duelW + ',' + G.duelL); } catch (err) { }
    }
  }

  // ---------------------------------------------------------------- fx
  function spark(x, y, hue, n, speed) {
    for (let i = 0; i < n; i++) {
      if (G.parts.length > 800) return;
      const a = rand(0, TAU), sp = rand(0.2, 1) * speed;
      G.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.25, 0.7), max: 0.7, hue, kind: 'spark' });
    }
  }
  function puff(x, y, hue, n, speed, size) {
    for (let i = 0; i < n; i++) {
      if (G.parts.length > 800) return;
      const a = rand(0, TAU), sp = rand(0.1, 1) * speed;
      G.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.4, 1), max: 1, hue, kind: 'puff', size: size * rand(0.6, 1.4) });
    }
  }
  function debris(x, y, hue, n) {
    for (let i = 0; i < n; i++) {
      if (G.parts.length > 800) return;
      const a = rand(0, TAU), sp = rand(60, 320);
      G.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.5, 1.2), max: 1.2, hue, kind: 'debris',
        rot: rand(0, TAU), rotV: rand(-8, 8), size: rand(2.5, 6),
      });
    }
  }
  function flash(x, y, size, hue) {
    G.parts.push({ x, y, vx: 0, vy: 0, life: 0.09, max: 0.09, hue, kind: 'flash', size });
  }
  function blinkFX(x0, y0, x1, y1, hue) {
    G.waves.push({ x: x0, y: y0, r: 4, maxR: 55, t: 0, dur: 0.3, hue });
    G.waves.push({ x: x1, y: y1, r: 30, maxR: 6, t: 0, dur: 0.3, hue });
    puff(x0, y0, hue, 8, 90, 10);
    puff(x1, y1, hue, 8, 90, 10);
    // streak of afterimages along the jump
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      G.parts.push({
        x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t,
        vx: 0, vy: 0, life: 0.25 + t * 0.1, max: 0.35, hue, kind: 'flash', size: 26,
      });
    }
    sndBlink(x1, y1);
  }

  function boomFX(x, y, r, hue, big) {
    spark(x, y, hue, big ? 24 : 12, big ? 380 : 260);
    puff(x, y, 25, big ? 12 : 6, 120, big ? 26 : 14);
    debris(x, y, hue, big ? 10 : 5);
    flash(x, y, big ? 130 : 70, 40);
    G.waves.push({ x, y, r: 8, maxR: r * 1.5, t: 0, dur: 0.45, hue: 30 });
    G.waves.push({ x, y, r: 4, maxR: r * 0.9, t: 0, dur: 0.3, hue: 55 });
    if (G.player) {
      const d = hyp(x - G.player.x, y - G.player.y);
      if (d < 700) G.shake = Math.min(18, G.shake + (big ? 12 : 6) * (1 - d / 700));
    }
    sndBoom(x, y, big);
  }

  // ---------------------------------------------------------------- sim events -> fx/sfx/net
  function handleEvents(events) {
    const W = G.W;
    for (const e of events) {
      const mine = G.player && e.id === G.player.id;
      switch (e.e) {
        case 'gun':
          sndShoot(e.x, e.y, e.level);
          flash(e.shots[0].x, e.shots[0].y, 26, 50);
          if (mine && G.online) netSend({ t: 'fire', kind: 'gun', shots: e.shots, level: e.level, dmg: e.dmg, bounces: e.bounces });
          break;
        case 'bomb':
          sndBomb(e.x, e.y);
          flash(e.x, e.y, 30, BOMB_HUES[e.level] || 4);
          if (mine && G.online) netSend({ t: 'fire', kind: 'bomb', x: e.x, y: e.y, vx: e.vx, vy: e.vy, level: e.level, bounces: e.bounces, prox: e.prox });
          break;
        case 'blink': {
          blinkFX(e.x0, e.y0, e.x1, e.y1, e.hue);
          if (mine && G.online) netSend({ t: 'fire', kind: 'blink', x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, hue: e.hue });
          break;
        }
        case 'warp': {
          blinkFX(e.x0, e.y0, e.x1, e.y1, e.hue);
          if (mine) say('Warped to your Comet', '#8df');
          if (mine && G.online) netSend({ t: 'fire', kind: 'warp', x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, hue: e.hue });
          break;
        }
        case 'burst': {
          G.waves.push({ x: e.x, y: e.y, r: 6, maxR: 90, t: 0, dur: 0.25, hue: 60 });
          sndBoom(e.x, e.y, false);
          if (mine && G.online) netSend({ t: 'fire', kind: 'burst', x: e.x, y: e.y, vx: e.vx, vy: e.vy, radius: e.radius });
          break;
        }
        case 'repel':
          G.waves.push({ x: e.x, y: e.y, r: 10, maxR: 230, t: 0, dur: 0.35, hue: 200 });
          sndRepel(e.x, e.y);
          if (mine && G.online) netSend({ t: 'fire', kind: 'repel', x: e.x, y: e.y });
          break;
        case 'rocket':
          if (mine) sndRocket();
          break;
        case 'hit': {
          spark(e.x, e.y, e.hue, 6, 220);
          if (G.player && e.att === G.player.id && e.id !== G.player.id) sndHitTick();
          if (mine) {
            G.shake = Math.min(16, G.shake + e.dmg / 55);
            G.hitFlash = Math.min(0.5, G.hitFlash + e.dmg / 1600);
            // report the hit: server credits attacker accuracy + reaper leech
            if (G.online) {
              const att = W.byId.get(e.att);
              if (att && att.remote) netSend({ t: 'dmg', att: e.att, amount: Math.round(e.dmg) });
            }
          }
          break;
        }
        case 'bhit':
          spark(e.x, e.y, 45, 4, 150);
          break;
        case 'shipBounce':
          sndBounce(e.x, e.y);
          break;
        case 'boom':
          boomFX(e.x, e.y, 70 + 28 * e.level, 25, e.level >= 2);
          break;
        case 'kill': {
          boomFX(e.x, e.y, 95, e.hue, true);
          if (e.kName && e.killer !== e.victim) say(e.vName + ' killed by: ' + e.kName + ' (' + e.bounty + ')', '#8f8');
          else say(e.vName + ' self-destructed', '#f88');
          // streak callouts keep the room aware of who's dangerous
          if (e.kStreak === 3) say(e.kName + ' is heating up (3)', '#fb6');
          else if (e.kStreak === 5) say(e.kName + ' is on a rampage! (5)', '#f96');
          else if (e.kStreak >= 8 && (e.kStreak - 8) % 3 === 0) say(e.kName + ' is UNSTOPPABLE (' + e.kStreak + ')', '#f66');
          if (G.player && e.victim === G.player.id) {
            G.deathBy = e.kName && e.killer !== e.victim ? e.kName : 'their own bomb';
            G.lastKillerId = e.killer;
            G.combo = 0;
            G.best = Math.max(G.best, G.player.score);
            saveBest();
            if (G.online) netSend({ t: 'death', killer: e.killer, bounty: e.bounty });
          }
          if (G.player && e.killer === G.player.id && e.victim !== e.killer) {
            sndKill();
            if (G.time - G.lastKillT < 4.5) G.combo++; else G.combo = 1;
            G.lastKillT = G.time;
            if (G.combo === 2) banner('DOUBLE KILL', '');
            else if (G.combo === 3) banner('TRIPLE KILL', '');
            else if (G.combo >= 4) banner('KILLING FRENZY', G.combo + ' in a row');
            G.best = Math.max(G.best, G.player.score);
            saveBest();
          }
          matchScoreKill(e);
          break;
        }
        case 'green':
          if (mine) { say('Green: ' + e.name, '#ff6'); sndPrize(); }
          break;
        case 'take':
          spark(e.x, e.y, 130, 8, 160);
          if (mine && G.online) netSend({ t: 'prize', id: e.prize });
          break;
        case 'restock':
          if (mine) say('Repel rack restocked', '#8df');
          break;
      }
    }
  }

  // ---------------------------------------------------------------- netcode
  function serverURL() {
    try {
      const q = new URLSearchParams(GLOBAL.location.search).get('server');
      if (q) return q.startsWith('ws') ? q : 'ws://' + q;
      if (GLOBAL.location.protocol.startsWith('http')) {
        return (GLOBAL.location.protocol === 'https:' ? 'wss://' : 'ws://') + GLOBAL.location.host;
      }
    } catch (e) { }
    return 'ws://localhost:8666';
  }
  function netSend(obj) {
    if (G.net && G.net.readyState === 1) G.net.send(JSON.stringify(obj));
  }
  const nowSec = () => (GLOBAL.performance ? GLOBAL.performance.now() : Date.now()) / 1000;
  function fetchZoneStatus() {
    G.zoneStatus = null;
    try {
      const url = serverURL().replace(/^ws/, 'http') + '/status';
      GLOBAL.fetch(url).then(r => r.json())
        .then(j => { G.zoneStatus = j; })
        .catch(() => { G.zoneStatus = { err: 1 }; });
    } catch (e) { G.zoneStatus = { err: 1 }; }
  }
  function netConnect() {
    G.state = 'connecting';
    G.netErr = '';
    let ws;
    try { ws = new GLOBAL.WebSocket(serverURL()); }
    catch (e) { G.netErr = String(e.message || e); G.state = 'error'; return; }
    ws.binaryType = 'arraybuffer';
    G.net = ws;
    ws.onopen = () => {
      G.state = 'select';
      G.online = true;
    };
    ws.onerror = () => { };
    ws.onclose = () => {
      if (G.state === 'connecting') { G.netErr = 'Could not reach ' + serverURL(); G.state = 'error'; }
      else if (G.online) {
        G.online = false; G.net = null;
        if (G.state === 'play') { say('DISCONNECTED from server', '#f66'); }
        leaveToTitle();
      }
    };
    ws.onmessage = m => {
      if (typeof m.data !== 'string') { handleBinary(m.data); return; }
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      handleNet(msg);
    };
  }
  // binary S2C states: u8 tag=2, f64 serverMs, u16 count, 24B/ship
  function handleBinary(data) {
    const W = G.W;
    if (!W) return;
    const dv = new DataView(data);
    if (dv.byteLength < 11 || dv.getUint8(0) !== 2) return;
    const count = dv.getUint16(9, true);
    const rt = nowSec();
    let off = 11;
    for (let i = 0; i < count && off + 24 <= dv.byteLength; i++, off += 24) {
      const id = dv.getUint16(off, true);
      const s = W.byId.get(id);
      if (!s || !s.remote) continue;
      const x = dv.getFloat32(off + 2, true), y = dv.getFloat32(off + 6, true);
      const vx = dv.getFloat32(off + 10, true), vy = dv.getFloat32(off + 14, true);
      const a = dv.getFloat32(off + 18, true);
      const flags = dv.getUint8(off + 22);
      const frac = dv.getUint8(off + 23) / 255;
      const dead = !!(flags & 1), th = (flags >> 1) & 1;
      if (s.dead && !dead) { s.snaps = []; s.safe = 2; s.x = x; s.y = y; }
      s.dead = dead;
      s.netX = x; s.netY = y; s.netVx = vx; s.netVy = vy; s.netA = a; s.netT = 0;
      if (!s.snaps) s.snaps = [];
      s.snaps.push({ rt, x, y, vx, vy, a, th, frac, dead });
      if (s.snaps.length > 24) s.snaps.shift();
    }
  }
  // binary C2S state: u8 tag=1, f32 x,y,vx,vy,angle, u8 flags, u8 frac
  const stateBuf = typeof ArrayBuffer !== 'undefined' ? new ArrayBuffer(23) : null;
  function sendStateBin() {
    const p = G.player;
    if (!p || !stateBuf || !G.net || G.net.readyState !== 1) return;
    const dv = new DataView(stateBuf);
    dv.setUint8(0, 1);
    dv.setFloat32(1, p.x, true);
    dv.setFloat32(5, p.y, true);
    dv.setFloat32(9, p.vx, true);
    dv.setFloat32(13, p.vy, true);
    dv.setFloat32(17, p.angle, true);
    dv.setUint8(21, (p.dead ? 1 : 0) | ((p.ctl.thrust > 0 || p.rocketT > 0 ? 1 : 0) << 1));
    dv.setUint8(22, Math.round(clamp(p.energy / p.maxEnergy, 0, 1) * 255));
    try { G.net.send(stateBuf); } catch (e) { }
  }
  function rosterAdd(r) {
    const W = G.W;
    if (W.byId.get(r.id)) return;
    const s = SIM.makeShip(W, r.ship, 'remote', r.name, r.hue, r.team || 0);
    // server owns the id space online
    W.byId.delete(s.id);
    s.id = r.id;
    W.byId.set(s.id, s);
    W.nextId = Math.max(W.nextId, r.id + 1);
    s.kills = r.kills || 0; s.deaths = r.deaths || 0; s.score = r.score || 0;
    s.elo = r.elo || 0;
    s.dead = !!r.dead;
    s.x = s.netX = r.x || WORLD / 2;
    s.y = s.netY = r.y || WORLD / 2;
  }
  function handleNet(msg) {
    const W = G.W;
    switch (msg.t) {
      case 'welcome': {
        G.myId = msg.id;
        const team = msg.team || 0;
        G.zoneMode = msg.mode || 'teams';
        G.sideFlip = msg.flip || 0;
        G.myElo = msg.me ? msg.me.elo : 0;
        // rebuild world from the server's seed so maps match
        const opts = {
          seed: msg.seed, spawnPrizes: false, mapStyle: msg.style || 'nexus',
          ghostInterp: true, now: nowSec,
        };
        if (team) {
          const C = WORLD / 2;
          opts.respawnDelay = 2.2;
          opts.spawnPoint = sh => {
            if (!sh.team) return null;
            const side = G.sideFlip ? 3 - sh.team : sh.team;
            return {
              x: (side === 1 ? C - 950 : C + 950) + SIM.rand(-260, 260),
              y: C + SIM.rand(-320, 320),
              angle: side === 1 ? 0 : Math.PI,
            };
          };
        }
        G.W = SIM.createWorld(opts);
        prerenderMap();
        for (const r of msg.roster) rosterAdd(r);
        for (const p of msg.prizes) SIM.addPrize(G.W, p[1], p[2], p[0]);
        // now create OUR ship with the server-issued id
        const me = SIM.makeShip(G.W, G.pendingShip, 'local', G.name, msg.hue, team);
        me.elo = G.myElo;
        G.W.byId.delete(me.id);
        me.id = msg.id;
        G.W.byId.set(me.id, me);
        G.W.nextId = Math.max(G.W.nextId, msg.id + 1);
        SIM.spawnShip(G.W, me);
        G.player = me;
        SIM.drainEvents(G.W);
        G.mode = team ? 'online-teams' : 'online-ffa';
        const isCore = G.zoneMode === 'core';
        G.match = team ? {
          mode: isCore ? 'core' : 'online', online: true, target: msg.goal || 30,
          a: (isCore ? msg.ca : msg.ta) || 0, b: (isCore ? msg.cb : msg.tb) || 0, over: false,
        } : null;
        G.state = 'play';
        say('Connected — welcome to the zone, ' + G.name + ' (elo ' + G.myElo + ').', '#8df');
        if (team) say('You fly for ' + (team === 1 ? 'BLUE' : 'RED') + ' — ' +
          (isCore ? 'hold the core ring to score, first to ' : 'first to ') + (msg.goal || 30) +
          '. Chat: // team · /duel <name> · /help', team === 1 ? '#8cf' : '#f98');
        say('ENTER to chat. Fly dangerous.', '#8df');
        break;
      }
      case 'join':
        rosterAdd(msg.p);
        say(msg.p.name + ' entered the zone', '#8df');
        break;
      case 'leave': {
        const s = W && W.byId.get(msg.id);
        if (s) { SIM.removeShip(W, s); say(s.name + ' left the zone', '#89a'); }
        break;
      }
      case 'states':
        if (!W) break;
        for (const st of msg.s) {
          const s = W.byId.get(st[0]);
          if (!s || !s.remote) continue;
          s.netX = st[1]; s.netY = st[2]; s.netVx = st[3]; s.netVy = st[4];
          s.netA = st[5]; s.netT = 0;
          const wasDead = s.dead;
          s.dead = !!st[6];
          if (wasDead && !s.dead) { s.safe = 2; s.x = s.netX; s.y = s.netY; }
          s.netFrac = st[7]; s.netTh = st[8];
        }
        break;
      case 'fire': {
        const o = W && W.byId.get(msg.id);
        if (!o) break;
        if (msg.kind === 'gun') { SIM.injectGun(W, o, msg); sndShoot(o.x, o.y, msg.level); }
        else if (msg.kind === 'bomb') { SIM.injectBomb(W, o, msg); sndBomb(msg.x, msg.y); }
        else if (msg.kind === 'burst') { SIM.injectBurst(W, o, msg); G.waves.push({ x: msg.x, y: msg.y, r: 6, maxR: 90, t: 0, dur: 0.25, hue: 60 }); }
        else if (msg.kind === 'repel') { SIM.injectRepel(W, o, msg); G.waves.push({ x: msg.x, y: msg.y, r: 10, maxR: 230, t: 0, dur: 0.35, hue: 200 }); sndRepel(msg.x, msg.y); }
        else if (msg.kind === 'blink') { blinkFX(msg.x0, msg.y0, msg.x1, msg.y1, msg.hue || o.hue); }
        else if (msg.kind === 'warp') { blinkFX(msg.x0, msg.y0, msg.x1, msg.y1, msg.hue || o.hue); }
        break;
      }
      case 'leech': {
        if (G.player && !G.player.dead) {
          const amt = Math.min(600, Math.max(0, +msg.amount || 0));
          G.player.energy = Math.min(G.player.maxEnergy, G.player.energy + amt);
          spark(G.player.x, G.player.y, 275, 4, 120);
        }
        break;
      }
      case 'death': {
        const v = W && W.byId.get(msg.id);
        const k = W && W.byId.get(msg.killer);
        if (v) {
          v.dead = true;
          boomFX(v.x, v.y, 95, v.hue, true);
          if (k && msg.killer !== msg.id) say(v.name + ' killed by: ' + (k ? k.name : '?') + ' (' + msg.bounty + ')', '#8f8');
          else say(v.name + ' self-destructed', '#f88');
        }
        break;
      }
      case 'score': {
        const s = W && W.byId.get(msg.id);
        if (s) { s.kills = msg.kills; s.deaths = msg.deaths; s.score = msg.score; }
        if (G.player && msg.id === G.player.id) {
          G.best = Math.max(G.best, msg.score);
        }
        break;
      }
      case 'prize+':
        if (W) SIM.addPrize(W, msg.x, msg.y, msg.id);
        break;
      case 'prize-':
        if (W) SIM.removePrizeById(W, msg.id);
        break;
      case 'chat': {
        if (msg.id === 0) { say('» ' + msg.text, '#fd8'); sndChat(); break; }
        say((msg.tc ? 'T· ' : '') + msg.name + '> ' + msg.text, msg.tc ? '#8fd4a8' : '#9cf');
        sndChat();
        break;
      }
      case 'tscore': {
        if (G.match && G.match.online && G.match.mode !== 'core') { G.match.a = msg.a; G.match.b = msg.b; }
        break;
      }
      case 'core': {
        G.coreOwner = msg.o || 0;
        if (G.match && G.match.online && G.match.mode === 'core') { G.match.a = msg.a; G.match.b = msg.b; }
        break;
      }
      case 'round': {
        const won = msg.winner === myTeam();
        banner(won ? 'ROUND WON' : 'ROUND LOST',
          'MVP: ' + (msg.mvp || '—') + ' (' + (msg.mvpK || 0) + ')  ·  sides swap', 6);
        if (won) sndWin(); else sndLose();
        G.sideFlip = msg.flip || 0;
        if (G.match && G.match.online) { G.match.a = 0; G.match.b = 0; }
        G.coreOwner = 0;
        break;
      }
      case 'duelstart': {
        const p = G.player;
        if (p) {
          p.x = msg.x; p.y = msg.y; p.vx = 0; p.vy = 0;
          p.angle = msg.angle;
          p.energy = p.maxEnergy;
          p.safe = 1.5;
          if (p.dead) { p.dead = false; }
        }
        G.duel = { opp: msg.opp, name: msg.oppName, a: 0, b: 0, target: msg.target, mine: 0, theirs: 0 };
        banner('DUEL vs ' + msg.oppName, 'first to ' + msg.target + ' — center arena', 3.5);
        break;
      }
      case 'duelscore': {
        if (G.duel) { G.duel.mine = msg.mine; G.duel.theirs = msg.theirs; }
        break;
      }
      case 'duelend': {
        banner(msg.won ? 'DUEL VICTORY' : 'DUEL LOST',
          'elo ' + msg.elo + ' (' + (msg.won ? '+' : '−') + msg.delta + ')', 5);
        if (msg.won) sndWin(); else sndLose();
        if (G.player) G.player.elo = msg.elo;
        G.myElo = msg.elo;
        G.duel = null;
        break;
      }
      case 'elo': {
        const s = W && W.byId.get(msg.id);
        if (s) s.elo = msg.elo;
        break;
      }
      case 'newmap': {
        if (!W) break;
        const oldShips = W.ships.slice();
        const opts = Object.assign({}, W.opts, { seed: msg.seed, mapStyle: msg.style });
        G.W = SIM.createWorld(opts);
        for (const s of oldShips) {
          G.W.ships.push(s);
          G.W.byId.set(s.id, s);
          G.W.nextId = Math.max(G.W.nextId, s.id + 1);
          s.snaps = [];
        }
        prerenderMap();
        if (G.player) SIM.spawnShip(G.W, G.player);
        SIM.drainEvents(G.W);
        say('Warped to a new ' + msg.style + ' sector', '#fd8');
        break;
      }
    }
  }

  // ---------------------------------------------------------------- world setup
  function newSoloWorld() {
    G.W = SIM.createWorld({ seed: (Math.random() * 1e9) | 0, spawnPrizes: true });
    prerenderMap();
    SIM.addBots(G.W, 10);
    for (let i = 0; i < 14; i++) {
      const p = SIM.randClearPoint(G.W);
      SIM.addPrize(G.W, p.x, p.y);
    }
    SIM.drainEvents(G.W);
  }

  function prerenderMap() {
    const W = G.W;
    const doc = GLOBAL.document;
    const big = doc.createElement('canvas');
    big.width = WORLD; big.height = WORLD;
    const c = big.getContext('2d');
    // Solid, chunky, bevelled tiles — the original's maps were rock and
    // steel, not wireframes. Deterministic per-tile hash varies the tone.
    const hash = (x, y) => {
      let h = (x * 374761393 + y * 668265263) | 0;
      h = (h ^ (h >> 13)) * 1274126177 | 0;
      return ((h ^ (h >> 16)) >>> 0) / 4294967296;
    };
    // outer glow bleed: the collidable layer announces itself against space.
    // ONE path + ONE shadowed fill — per-tile shadow fills hang Firefox.
    c.save();
    c.shadowColor = 'rgba(90,145,255,0.55)';
    c.shadowBlur = 11;
    c.fillStyle = '#161e34';
    c.beginPath();
    for (let ty = 0; ty < MAPS; ty++)
      for (let tx = 0; tx < MAPS; tx++)
        if (SIM.tileSolid(W, tx, ty)) c.rect(tx * TILE, ty * TILE, TILE, TILE);
    c.fill();
    c.restore();
    for (let ty = 0; ty < MAPS; ty++) {
      for (let tx = 0; tx < MAPS; tx++) {
        if (!SIM.tileSolid(W, tx, ty)) continue;
        const x = tx * TILE, y = ty * TILE;
        const h0 = hash(tx, ty);
        const lit = 20 + h0 * 7;                       // per-tile tonal variation
        const hue = 222 + (hash(tx + 7, ty + 3) - 0.5) * 14;
        c.fillStyle = 'hsl(' + hue + ',26%,' + lit + '%)';
        c.fillRect(x, y, TILE, TILE);
        // classic bevel: light top/left, dark bottom/right
        const openU = !SIM.tileSolid(W, tx, ty - 1), openD = !SIM.tileSolid(W, tx, ty + 1);
        const openL = !SIM.tileSolid(W, tx - 1, ty), openR = !SIM.tileSolid(W, tx + 1, ty);
        c.fillStyle = 'hsla(' + hue + ',30%,' + (lit + 22) + '%,' + (openU ? 0.9 : 0.25) + ')';
        c.fillRect(x, y, TILE, 2);
        c.fillStyle = 'hsla(' + hue + ',30%,' + (lit + 18) + '%,' + (openL ? 0.8 : 0.2) + ')';
        c.fillRect(x, y, 2, TILE);
        c.fillStyle = 'rgba(2,4,10,' + (openD ? 0.75 : 0.3) + ')';
        c.fillRect(x, y + TILE - 2, TILE, 2);
        c.fillStyle = 'rgba(2,4,10,' + (openR ? 0.65 : 0.25) + ')';
        c.fillRect(x + TILE - 2, y, 2, TILE);
        // speckled rock texture
        for (let k = 0; k < 4; k++) {
          const sx = x + 2 + hash(tx * 5 + k, ty * 9 + k) * (TILE - 5);
          const sy = y + 2 + hash(tx * 11 + k, ty * 3 + k) * (TILE - 5);
          c.fillStyle = hash(tx + k, ty - k) > 0.5 ? 'rgba(0,0,8,0.28)' : 'rgba(160,190,255,0.08)';
          c.fillRect(sx, sy, 1.6, 1.6);
        }
        // thin energized rim only where the wall faces open space
        c.strokeStyle = 'rgba(140,185,255,0.6)';
        c.lineWidth = 1;
        c.beginPath();
        if (openU) { c.moveTo(x, y + 0.5); c.lineTo(x + TILE, y + 0.5); }
        if (openD) { c.moveTo(x, y + TILE - 0.5); c.lineTo(x + TILE, y + TILE - 0.5); }
        if (openL) { c.moveTo(x + 0.5, y); c.lineTo(x + 0.5, y + TILE); }
        if (openR) { c.moveTo(x + TILE - 0.5, y); c.lineTo(x + TILE - 0.5, y + TILE); }
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
        if (SIM.tileSolid(W, tx, ty)) r.fillRect(tx, ty, 1, 1);
    G.radarC = rc;
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    G.time += dt;
    if (G.state === 'play' && G.paused && !G.online) return; // no pausing the zone online
    const W = G.W;
    if (!W) return;

    SIM.updateWorld(W, dt);
    handleEvents(SIM.drainEvents(W));

    // thrust exhaust for every live thrusting ship
    for (const s of W.ships) {
      if (s.dead || G.parts.length > 780) continue;
      const th = s.remote ? s.netTh : (s.ctl.thrust > 0 || s.rocketT > 0 ? 1 : 0);
      if (th && Math.random() < 0.7) {
        const rk = s.rocketT > 0;
        for (const en of s.t.engines) {
          const ex = s.x + (en[0] * Math.cos(s.angle) - en[1] * Math.sin(s.angle)) * s.t.radius * 1.35;
          const ey = s.y + (en[0] * Math.sin(s.angle) + en[1] * Math.cos(s.angle)) * s.t.radius * 1.35;
          G.parts.push({
            x: ex, y: ey,
            vx: s.vx * 0.2 - Math.cos(s.angle) * (rk ? 220 : 140) + rand(-30, 30),
            vy: s.vy * 0.2 - Math.sin(s.angle) * (rk ? 220 : 140) + rand(-30, 30),
            life: rk ? 0.5 : 0.3, max: rk ? 0.5 : 0.3,
            hue: rk ? 20 : 32, kind: 'puff', size: rk ? 10 : 6,
          });
        }
      }
      // motion trail sampling
      if (!s.trail) s.trail = [];
      s.trailT = (s.trailT || 0) + dt;
      if (s.trailT > 0.03) {
        s.trailT = 0;
        s.trail.push({ x: s.x, y: s.y, a: 1 });
        if (s.trail.length > 9) s.trail.shift();
      }
      for (const tp of s.trail) tp.a -= dt * 3.2;
    }

    for (let i = G.parts.length - 1; i >= 0; i--) {
      const p = G.parts[i];
      p.life -= dt;
      if (p.life <= 0) { G.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 2.2 * dt; p.vy *= 1 - 2.2 * dt;
      if (p.rotV) p.rot += p.rotV * dt;
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

    // solo core-mode scoring
    if (G.match && G.match.mode === 'core' && !G.match.online && !G.match.over) {
      const m = G.match, C = WORLD / 2;
      let present = 0;
      for (const s of W.ships) {
        if (s.dead || !s.team) continue;
        if (hyp(s.x - C, s.y - C) < 340) present |= s.team === 1 ? 1 : 2;
      }
      const solo = present === 1 ? 1 : present === 2 ? 2 : 0;
      if (solo && solo === G.coreOwner) {
        m.coreAcc = (m.coreAcc || 0) + dt;
        if (m.coreAcc >= 3) {
          m.coreAcc = 0;
          if (solo === 1) m.a++; else m.b++;
          if (solo === myTeam()) sndPrize();
          checkMatchEnd();
        }
      } else {
        G.coreOwner = solo;
        m.coreAcc = 0;
      }
    }

    // camera: follow the player; killcam while dead; roam in attract mode
    let target = null;
    if (G.player && G.state === 'play' && !G.player.dead) target = G.player;
    else if (G.player && G.state === 'play' && G.player.dead) {
      const killer = W.byId.get(G.lastKillerId);
      target = killer && !killer.dead ? killer : G.player;
    }
    else {
      G.demoT -= dt;
      if (!G.demoShip || G.demoShip.dead || G.demoT <= 0) {
        const live = W.ships.filter(s => !s.dead);
        if (live.length) { G.demoShip = live[irand(live.length)]; G.demoT = 7; }
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
    if (G.banner) {
      G.banner.t += dt;
      if (G.banner.t > G.banner.dur) G.banner = null;
    }
    // shooting stars streak by every so often
    if (G.shoot) {
      G.shoot.x += G.shoot.vx * dt;
      G.shoot.y += G.shoot.vy * dt;
      G.shoot.life -= dt;
      if (G.shoot.life <= 0) G.shoot = null;
    } else {
      G.shootT -= dt;
      if (G.shootT <= 0) {
        G.shootT = rand(8, 22);
        const dir = Math.random() < 0.5 ? 1 : -1;
        G.shoot = {
          x: dir > 0 ? -30 : vw + 30, y: rand(0, vh * 0.6),
          vx: dir * rand(500, 800), vy: rand(120, 320), life: 0.9,
        };
      }
    }

    if (G.player && !G.player.dead && G.player.energy < G.player.maxEnergy * 0.25) {
      G.beepT -= dt;
      if (G.beepT <= 0) { G.beepT = 0.55; sndBeep(); }
    }

    // net upkeep: 30Hz binary state reports
    if (G.online && G.state === 'play' && G.player) {
      G.stateTick++;
      if (G.stateTick >= 2) { G.stateTick = 0; sendStateBin(); }
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

  // ---------------------------------------------------------------- backdrop
  // Deep space with places in it: planets, a black hole, a distant galaxy,
  // flare stars, dust, nebulae — all parallax layers, all lit from the same
  // top-left as the ships, so flying feels like actually traveling.
  const stars = [];
  const nebulae = [];
  const bgObjs = [];
  const dust = [];

  function makePlanet(rad, hue, style, rng) {
    const doc = GLOBAL.document;
    const pad = Math.ceil(rad * (style === 'ringed' ? 1.9 : 1.4));
    const c = doc.createElement('canvas');
    c.width = c.height = pad * 2;
    const g = c.getContext('2d');
    const cx = pad, cy = pad;
    const ring = front => {
      if (style !== 'ringed') return;
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.45);
      g.scale(1, 0.32);
      g.beginPath();
      g.rect(-pad * 3, front ? 0 : -pad * 3, pad * 6, pad * 3);
      g.clip();
      for (let i = 0; i < 3; i++) {
        const rr = rad * (1.35 + i * 0.16);
        g.beginPath();
        g.arc(0, 0, rr, 0, TAU);
        g.strokeStyle = 'hsla(' + (hue + 22) + ',32%,' + (58 - i * 9) + '%,' + (0.55 - i * 0.13).toFixed(2) + ')';
        g.lineWidth = rad * (0.11 - i * 0.02);
        g.stroke();
      }
      g.restore();
    };
    ring(false);                                     // ring passes behind the limb
    // atmosphere halo
    const ag = g.createRadialGradient(cx, cy, rad * 0.82, cx, cy, rad * 1.28);
    ag.addColorStop(0, 'hsla(' + hue + ',70%,62%,0)');
    ag.addColorStop(0.7, 'hsla(' + hue + ',70%,62%,0.26)');
    ag.addColorStop(1, 'hsla(' + hue + ',70%,62%,0)');
    g.fillStyle = ag;
    g.beginPath(); g.arc(cx, cy, rad * 1.28, 0, TAU); g.fill();
    // body
    g.save();
    g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.clip();
    g.fillStyle = 'hsl(' + hue + ',45%,40%)';
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    if (style === 'rock') {
      for (let i = 0; i < 46; i++) {
        const px = cx + (rng() * 2 - 1) * rad, py = cy + (rng() * 2 - 1) * rad;
        const pr = rad * (0.05 + rng() * 0.2);
        g.fillStyle = 'hsla(' + (hue + rng() * 40 - 20) + ',36%,' + (26 + rng() * 36) + '%,0.55)';
        g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill();
      }
    } else {
      // banded gas giant
      let y = -rad;
      while (y < rad) {
        const bh = rad * (0.05 + rng() * 0.12);
        g.fillStyle = 'hsla(' + (hue + rng() * 30 - 15) + ',52%,' + (34 + rng() * 30) + '%,0.5)';
        g.fillRect(cx - rad, cy + y, rad * 2, bh);
        y += bh + rad * rng() * 0.06;
      }
    }
    // spherical shading, sun from the top-left like everything else
    const sg = g.createRadialGradient(cx - rad * 0.45, cy - rad * 0.45, rad * 0.1, cx, cy, rad * 1.02);
    sg.addColorStop(0, 'rgba(255,255,255,0.28)');
    sg.addColorStop(0.5, 'rgba(0,0,0,0)');
    sg.addColorStop(0.82, 'rgba(3,5,14,0.55)');
    sg.addColorStop(1, 'rgba(1,2,8,0.96)');
    g.fillStyle = sg;
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    g.restore();
    ring(true);                                      // ring passes in front
    return c;
  }

  function makeBlackHole(size) {
    const doc = GLOBAL.document;
    const c = doc.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d');
    const cx = size, cy = size;
    // accretion disk
    g.save();
    g.translate(cx, cy);
    g.rotate(-0.5);
    g.scale(1, 0.3);
    const dg = g.createRadialGradient(0, 0, size * 0.28, 0, 0, size * 0.95);
    dg.addColorStop(0, 'rgba(255,242,225,0.95)');
    dg.addColorStop(0.25, 'rgba(255,180,95,0.75)');
    dg.addColorStop(0.6, 'rgba(210,90,50,0.32)');
    dg.addColorStop(1, 'rgba(130,45,70,0)');
    g.fillStyle = dg;
    g.beginPath(); g.arc(0, 0, size * 0.95, 0, TAU); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(0, 0, size * 0.27, 0, TAU); g.fill();
    g.restore();
    // photon ring + lensed light
    g.strokeStyle = 'rgba(255,232,205,0.9)';
    g.lineWidth = Math.max(1.5, size * 0.018);
    g.beginPath(); g.arc(cx, cy, size * 0.3, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,200,140,0.3)';
    g.lineWidth = size * 0.05;
    g.beginPath(); g.arc(cx, cy, size * 0.335, 0, TAU); g.stroke();
    // event horizon
    const eh = g.createRadialGradient(cx, cy, size * 0.05, cx, cy, size * 0.29);
    eh.addColorStop(0, '#000');
    eh.addColorStop(0.88, '#000');
    eh.addColorStop(1, 'rgba(45,65,130,0.55)');
    g.fillStyle = eh;
    g.beginPath(); g.arc(cx, cy, size * 0.29, 0, TAU); g.fill();
    return c;
  }

  function makeGalaxy(size, rng) {
    const doc = GLOBAL.document;
    const c = doc.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d');
    const cx = size, cy = size;
    g.save();
    g.translate(cx, cy);
    g.rotate(0.6);
    // core glow
    const cg = g.createRadialGradient(0, 0, 1, 0, 0, size * 0.32);
    cg.addColorStop(0, 'rgba(255,235,215,0.85)');
    cg.addColorStop(0.5, 'rgba(230,190,255,0.3)');
    cg.addColorStop(1, 'rgba(200,170,255,0)');
    g.fillStyle = cg;
    g.beginPath(); g.arc(0, 0, size * 0.32, 0, TAU); g.fill();
    // two spiral arms of stars
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < 240; i++) {
        const th = i / 240 * 3.6 + arm * Math.PI;
        const rr = size * 0.06 * Math.exp(0.62 * (i / 240) * 3.6) * 0.42;
        if (rr > size * 0.95) break;
        const jx = (rng() * 2 - 1) * size * 0.05, jy = (rng() * 2 - 1) * size * 0.05;
        const px = Math.cos(th) * rr + jx, py = Math.sin(th) * rr * 0.62 + jy;
        const a = (1 - rr / size) * (0.25 + rng() * 0.5);
        g.fillStyle = rng() < 0.12
          ? 'rgba(255,205,230,' + a.toFixed(3) + ')'
          : 'rgba(210,225,255,' + a.toFixed(3) + ')';
        g.fillRect(px, py, rng() < 0.2 ? 2 : 1, 1);
      }
    }
    g.restore();
    return c;
  }

  function makeFlareStar(size, tint) {
    const doc = GLOBAL.document;
    const c = doc.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d');
    const cx = size, cy = size;
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.25, 'rgba(' + tint + ',0.8)');
    core.addColorStop(1, 'rgba(' + tint + ',0)');
    g.fillStyle = core;
    g.fillRect(0, 0, size * 2, size * 2);
    // diffraction spikes
    for (const rot of [0, Math.PI / 2]) {
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      const sp = g.createLinearGradient(-size, 0, size, 0);
      sp.addColorStop(0, 'rgba(' + tint + ',0)');
      sp.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      sp.addColorStop(1, 'rgba(' + tint + ',0)');
      g.fillStyle = sp;
      g.fillRect(-size, -Math.max(1, size * 0.02), size * 2, Math.max(2, size * 0.04));
      g.restore();
    }
    return c;
  }

  // atmospheric perspective: distance = smaller, dimmer, softer, cooler
  function hazify(c, blurPx, tintA) {
    const doc = GLOBAL.document;
    const o = doc.createElement('canvas');
    o.width = c.width; o.height = c.height;
    const g = o.getContext('2d');
    try { g.filter = 'blur(' + blurPx + 'px)'; } catch (e) { }
    g.drawImage(c, 0, 0);
    g.filter = 'none';
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(12,18,40,' + tintA + ')';
    g.fillRect(0, 0, o.width, o.height);
    return o;
  }

  function initBackdrop() {
    const doc = GLOBAL.document;
    stars.length = 0;
    const layers = [[170, 0.22, 1], [100, 0.45, 1.6], [55, 0.75, 2.3]];
    const tints = ['190,210,255', '255,240,220', '170,225,255', '255,205,225'];
    for (const [n, z, size] of layers)
      for (let i = 0; i < n; i++)
        stars.push({
          x: rand(0, 4000), y: rand(0, 4000), z, size: size * rand(0.6, 1.3),
          tw: rand(0, TAU), tint: tints[irand(tints.length)],
        });
    dust.length = 0;
    for (let i = 0; i < 260; i++)
      dust.push({ x: rand(0, 4000), y: rand(0, 4000), a: rand(0.15, 0.5) });
    nebulae.length = 0;
    const hues = [205, 275, 320, 185, 250, 160];
    for (let i = 0; i < 6; i++) {
      const c = doc.createElement('canvas');
      c.width = 512; c.height = 512;
      const g = c.getContext('2d');
      const hue = hues[i % hues.length];
      for (let b = 0; b < 7; b++) {
        const bx = 256 + rand(-110, 110), by = 256 + rand(-110, 110);
        const br = rand(60, 180);
        const bh = hue + rand(-25, 25);
        const grad = g.createRadialGradient(bx, by, 4, bx, by, br);
        grad.addColorStop(0, 'hsla(' + bh + ',85%,60%,' + rand(0.10, 0.22).toFixed(3) + ')');
        grad.addColorStop(1, 'hsla(' + bh + ',85%,45%,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 512, 512);
      }
      nebulae.push({ c, x: rand(0, WORLD), y: rand(0, WORLD), r: rand(380, 700), a: rand(0.35, 0.6) });
    }
    // deep-space set pieces
    bgObjs.length = 0;
    const rng = SIM.mulberry32((Math.random() * 1e9) | 0);
    const planetHues = [rand(10, 40), rand(170, 220), rand(270, 330)];
    bgObjs.push({ c: hazify(makePlanet(88, planetHues[0], 'ringed', rng), 1.6, 0.4), x: rand(0, WORLD), y: rand(0, WORLD), z: 0.07, a: 0.55, add: false });
    bgObjs.push({ c: hazify(makePlanet(66, planetHues[1], 'gas', rng), 1.6, 0.42), x: rand(0, WORLD), y: rand(0, WORLD), z: 0.055, a: 0.5, add: false });
    bgObjs.push({ c: hazify(makePlanet(42, planetHues[2], 'rock', rng), 1.4, 0.45), x: rand(0, WORLD), y: rand(0, WORLD), z: 0.045, a: 0.45, add: false });
    bgObjs.push({ c: hazify(makeBlackHole(120), 1, 0.22), x: rand(0, WORLD), y: rand(0, WORLD), z: 0.06, a: 0.65, add: true, rotV: 0.02 });
    bgObjs.push({ c: makeGalaxy(190, rng), x: rand(0, WORLD), y: rand(0, WORLD), z: 0.05, a: 0.7, add: true });
    const flareTints = ['200,220,255', '255,230,200', '255,210,225'];
    for (let i = 0; i < 8; i++) {
      bgObjs.push({
        c: makeFlareStar(rand(18, 44), flareTints[irand(flareTints.length)]),
        x: rand(0, WORLD), y: rand(0, WORLD), z: rand(0.07, 0.12), a: rand(0.5, 0.9), add: true, tw: rand(0, TAU),
      });
    }
  }

  function drawBackdrop() {
    // near-black space, like the original — the nebulae are a whisper, not a wash
    const sky = ctx.createRadialGradient(vw / 2, vh / 2, 0, vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
    sky.addColorStop(0, '#070a14');
    sky.addColorStop(1, '#020308');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, vw, vh);
    // farthest layer: unresolved star dust
    ctx.fillStyle = 'rgba(200,215,255,0.5)';
    for (const d of dust) {
      const sx = ((d.x - G.cam.x * 0.045) % (vw + 40) + vw + 40) % (vw + 40) - 20;
      const sy = ((d.y - G.cam.y * 0.045) % (vh + 40) + vh + 40) % (vh + 40) - 20;
      ctx.globalAlpha = d.a;
      ctx.fillRect(sx, sy, 1, 1);
    }
    ctx.globalAlpha = 1;
    // set pieces: galaxy, planets, black hole, flare stars (parallax-wrapped)
    for (const o of bgObjs) {
      const w = o.c.width, h = o.c.height;
      const sx = ((o.x - G.cam.x * o.z) % (vw + w) + vw + w) % (vw + w) - w;
      const sy = ((o.y - G.cam.y * o.z) % (vh + h) + vh + h) % (vh + h) - h;
      ctx.globalCompositeOperation = o.add ? 'lighter' : 'source-over';
      ctx.globalAlpha = o.a * (o.tw == null ? 1 : 0.7 + 0.3 * Math.sin(G.time * 1.3 + o.tw));
      if (o.rotV) {
        ctx.save();
        ctx.translate(sx + w / 2, sy + h / 2);
        ctx.rotate(G.time * o.rotV);
        ctx.drawImage(o.c, -w / 2, -h / 2);
        ctx.restore();
      } else {
        ctx.drawImage(o.c, sx, sy);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    for (const nb of nebulae) {
      const px = nb.x - G.cam.x * 0.14, py = nb.y - G.cam.y * 0.14;
      const wx = ((px % (vw + 1100)) + vw + 1100) % (vw + 1100) - 550;
      const wy = ((py % (vh + 1100)) + vh + 1100) % (vh + 1100) - 550;
      ctx.globalAlpha = nb.a * 0.5;
      ctx.drawImage(nb.c, wx - nb.r, wy - nb.r, nb.r * 2, nb.r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // occasional shooting star
    if (G.shoot) {
      const s = G.shoot;
      const f = clamp(s.life / 0.9, 0, 1);
      ctx.strokeStyle = 'rgba(220,235,255,' + (f * 0.85).toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.12, s.y - s.vy * 0.12);
      ctx.stroke();
    }
    for (const st of stars) {
      const sx = ((st.x - G.cam.x * st.z) % (vw + 100) + vw + 100) % (vw + 100) - 50;
      const sy = ((st.y - G.cam.y * st.z) % (vh + 100) + vh + 100) % (vh + 100) - 50;
      const tw = 0.55 + 0.45 * Math.sin(G.time * 1.7 + st.tw);
      ctx.fillStyle = 'rgba(' + st.tint + ',' + (0.3 + 0.55 * st.z * tw).toFixed(3) + ')';
      ctx.fillRect(sx, sy, st.size, st.size);
    }
  }

  // ---------------------------------------------------------------- ship art
  // Realistically lit sprites, baked entirely in code: every rotation frame
  // renders a HEIGHTMAP (rounded fuselage, raised deck, cockpit dome,
  // recessed nozzles, seam grooves) and an ALBEDO map (grey hull metal with
  // panel tonal variation, team-color stripes, glass, nav lights), then a
  // per-pixel pass derives surface normals from the heights and applies
  // directional lighting — diffuse + specular + rim + dark silhouette edge.
  // The result reads like pre-rendered 3D models, with zero image assets.
  const ROT_FRAMES = 36;
  const atlasCache = new Map();

  function tracePolyOn(g, pts, r) {
    g.beginPath();
    g.moveTo(pts[0][0] * r, pts[0][1] * r);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] * r, pts[i][1] * r);
    g.closePath();
  }
  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  }
  function insetPoly(pts, k) {
    const [cx, cy] = centroid(pts);
    return pts.map(p => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);
  }
  function strHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const gray = v => {
    const c = Math.max(0, Math.min(255, Math.round(v * 255)));
    return 'rgb(' + c + ',' + c + ',' + c + ')';
  };

  // symmetric greeble layout derived from the hull — the "bits"
  function greebles(t) {
    let top = t.shape[0], bot = t.shape[0], nose = t.shape[0];
    for (const p of t.shape) {
      if (p[1] > top[1]) top = p;
      if (p[1] < bot[1]) bot = p;
      if (p[0] > nose[0]) nose = p;
    }
    return {
      top, bot, nose,
      spine: [[0.5, 0.05], [0.15, 0.07], [-0.55, 0.06], [-0.68, 0], [-0.55, -0.06], [0.15, -0.07], [0.5, -0.05]],
      hard: [[top[0] * 0.62, top[1] * 0.62], [bot[0] * 0.62, bot[1] * 0.62]],
    };
  }

  function paintHeight(g, t, r, ang, cs) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cs, cs);
    g.save();
    g.translate(cs / 2, cs / 2);
    g.rotate(ang);
    const cx = t.cockpit ? t.cockpit[0] * r * 0.5 : 0;
    const gb = greebles(t);
    g.globalCompositeOperation = 'lighten';
    // fuselage volume: tallest near the cockpit, sloping to thin wing edges
    tracePolyOn(g, t.shape, r);
    const fg = g.createRadialGradient(cx, 0, r * 0.1, cx, 0, r * 1.35);
    fg.addColorStop(0, gray(0.58));
    fg.addColorStop(1, gray(0.28));
    g.fillStyle = fg;
    g.fill();
    // raised deck
    tracePolyOn(g, insetPoly(t.shape, 0.62), r);
    const dg = g.createRadialGradient(cx, 0, r * 0.08, cx, 0, r);
    dg.addColorStop(0, gray(0.75));
    dg.addColorStop(1, gray(0.5));
    g.fillStyle = dg;
    g.fill();
    if (t.accent) {
      tracePolyOn(g, t.accent, r);
      g.fillStyle = gray(0.82);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // greebles ride on top, clipped so the silhouette never changes
    g.save();
    tracePolyOn(g, t.shape, r);
    g.clip();
    g.globalCompositeOperation = 'lighten';
    // spine ridge
    tracePolyOn(g, gb.spine, r);
    g.fillStyle = gray(0.86);
    g.fill();
    // wing hardpoints
    for (const hp of gb.hard) {
      g.fillStyle = gray(0.78);
      g.fillRect(hp[0] * r - r * 0.09, hp[1] * r - r * 0.06, r * 0.18, r * 0.12);
    }
    // twin nose barrels
    g.fillStyle = gray(0.7);
    g.fillRect(r * 0.5, -r * 0.12, r * 0.6, r * 0.045);
    g.fillRect(r * 0.5, r * 0.075, r * 0.6, r * 0.045);
    g.globalCompositeOperation = 'source-over';
    // engine vents: grooves beside each nozzle
    g.fillStyle = gray(0.3);
    for (const en of t.engines) {
      g.fillRect(en[0] * r + r * 0.1, en[1] * r - r * 0.14, r * 0.22, r * 0.035);
      g.fillRect(en[0] * r + r * 0.1, en[1] * r + r * 0.1, r * 0.22, r * 0.035);
    }
    g.restore();
    // seam grooves carve into the hull so they catch the light
    if (t.deco) {
      g.strokeStyle = gray(0.32);
      g.lineWidth = Math.max(1.5, r * 0.045);
      g.beginPath();
      for (const line of t.deco) {
        g.moveTo(line[0][0] * r, line[0][1] * r);
        for (let i = 1; i < line.length; i++) g.lineTo(line[i][0] * r, line[i][1] * r);
      }
      g.stroke();
    }
    // cockpit dome
    if (t.cockpit) {
      const [px, py, rx, ry] = t.cockpit;
      const cg = g.createRadialGradient(px * r, py * r, 0.5, px * r, py * r, Math.max(rx, ry) * r * 1.3);
      cg.addColorStop(0, gray(0.98));
      cg.addColorStop(1, gray(0.62));
      g.fillStyle = cg;
      g.beginPath();
      g.ellipse(px * r, py * r, rx * r, ry * r, 0, 0, TAU);
      g.fill();
      // antenna nub behind the canopy
      g.beginPath();
      g.arc((px - rx * 1.9) * r, py * r, r * 0.035, 0, TAU);
      g.fillStyle = gray(0.95);
      g.fill();
    }
    // recessed engine nozzles
    for (const en of t.engines) {
      g.beginPath();
      g.arc(en[0] * r, en[1] * r, r * 0.16, 0, TAU);
      g.fillStyle = gray(0.14);
      g.fill();
    }
    g.restore();
  }

  function paintAlbedo(g, t, hue, r, ang, cs) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cs, cs);
    g.save();
    g.translate(cs / 2, cs / 2);
    g.rotate(ang);
    // hull: bold hue identity like the old zone sprites, cleanly saturated
    const gb = greebles(t);
    tracePolyOn(g, t.shape, r);
    g.fillStyle = 'hsl(' + hue + ',38%,55%)';
    g.fill();
    // structured symmetric panel plating — designed, not noisy
    g.save();
    tracePolyOn(g, t.shape, r);
    g.clip();
    const rng = SIM.mulberry32(strHash(t.label));
    for (let i = 0; i < 4; i++) {
      const px = (rng() * 1.6 - 0.9) * r;
      const py = (0.12 + rng() * 0.75) * r;
      const pw = (0.3 + rng() * 0.55) * r, ph = (0.18 + rng() * 0.4) * r;
      const lit = 50 + rng() * 12;
      g.fillStyle = 'hsla(' + hue + ',34%,' + lit + '%,0.9)';
      g.fillRect(px, py, pw, ph);              // starboard panel
      g.fillRect(px, -py - ph, pw, ph);        // mirrored port panel
    }
    // greeble albedo: spine, hardpoints, barrels, vents
    tracePolyOn(g, gb.spine, r);
    g.fillStyle = 'hsla(' + hue + ',26%,68%,0.95)';
    g.fill();
    g.fillStyle = 'hsla(' + hue + ',20%,42%,0.95)';
    for (const hp of gb.hard) g.fillRect(hp[0] * r - r * 0.09, hp[1] * r - r * 0.06, r * 0.18, r * 0.12);
    g.fillStyle = '#262b34';
    g.fillRect(r * 0.5, -r * 0.12, r * 0.6, r * 0.045);
    g.fillRect(r * 0.5, r * 0.075, r * 0.6, r * 0.045);
    g.fillStyle = 'rgba(16,20,28,0.9)';
    for (const en of t.engines) {
      g.fillRect(en[0] * r + r * 0.1, en[1] * r - r * 0.14, r * 0.22, r * 0.035);
      g.fillRect(en[0] * r + r * 0.1, en[1] * r + r * 0.1, r * 0.22, r * 0.035);
    }
    g.restore();
    // deck + accent
    tracePolyOn(g, insetPoly(t.shape, 0.62), r);
    g.fillStyle = 'hsla(' + hue + ',30%,63%,0.95)';
    g.fill();
    if (t.accent) {
      tracePolyOn(g, t.accent, r);
      g.fillStyle = 'hsl(' + hue + ',88%,50%)';
      g.fill();
    }
    // seams
    if (t.deco) {
      g.strokeStyle = 'rgba(18,22,32,0.85)';
      g.lineWidth = Math.max(1.5, r * 0.045);
      g.beginPath();
      for (const line of t.deco) {
        g.moveTo(line[0][0] * r, line[0][1] * r);
        for (let i = 1; i < line.length; i++) g.lineTo(line[i][0] * r, line[i][1] * r);
      }
      g.stroke();
    }
    // cockpit glass (the lighting pass turns the dome into a glint)
    if (t.cockpit) {
      const [px, py, rx, ry] = t.cockpit;
      g.fillStyle = '#16304e';
      g.beginPath();
      g.ellipse(px * r, py * r, rx * r, ry * r, 0, 0, TAU);
      g.fill();
    }
    // nozzles
    for (const en of t.engines) {
      g.beginPath();
      g.arc(en[0] * r, en[1] * r, r * 0.16, 0, TAU);
      g.fillStyle = '#14161c';
      g.fill();
    }
    // nav lights: port red, starboard green
    let maxY = t.shape[0], minY = t.shape[0];
    for (const p of t.shape) { if (p[1] > maxY[1]) maxY = p; if (p[1] < minY[1]) minY = p; }
    g.fillStyle = '#ff5348';
    g.beginPath(); g.arc(minY[0] * r * 0.94, minY[1] * r * 0.94, Math.max(1, r * 0.05), 0, TAU); g.fill();
    g.fillStyle = '#4dff7a';
    g.beginPath(); g.arc(maxY[0] * r * 0.94, maxY[1] * r * 0.94, Math.max(1, r * 0.05), 0, TAU); g.fill();
    g.restore();
  }

  // fixed screen-space light from the top-left, slightly overhead
  const LX = -0.55, LY = -0.55, LZ = 0.628;
  const HLEN = Math.hypot(LX, LY, LZ + 1);
  const HX = LX / HLEN, HY = LY / HLEN, HZ = (LZ + 1) / HLEN;
  function lightCompose(fctx, hImg, aImg, cs) {
    const out = fctx.createImageData(cs, cs);
    const hd = hImg.data, ad = aImg.data, od = out.data;
    const HS = 3.1;
    for (let y = 1; y < cs - 1; y++) {
      for (let x = 1; x < cs - 1; x++) {
        const i = (y * cs + x) * 4;
        const a = ad[i + 3];
        if (!a) continue;
        // silhouette edge: crisp dark outline
        if (!ad[i - 1] || !ad[i + 7] || !ad[i - cs * 4 + 3] || !ad[i + cs * 4 + 3]) {
          od[i] = 8; od[i + 1] = 10; od[i + 2] = 16; od[i + 3] = a;
          continue;
        }
        let nx = (hd[i - 4] - hd[i + 4]) / 255 * HS;
        let ny = (hd[i - cs * 4] - hd[i + cs * 4]) / 255 * HS;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv; ny *= inv;
        const nz = inv;
        let diff = nx * LX + ny * LY + nz * LZ;
        if (diff < 0) diff = 0;
        let spec = nx * HX + ny * HY + nz * HZ;
        spec = spec < 0 ? 0 : Math.pow(spec, 30) * 185;
        const rim = Math.pow(1 - nz, 1.8) * 46;
        const lum = 0.26 + 0.98 * diff;
        od[i] = Math.min(255, ad[i] * lum + spec + rim * 0.35);
        od[i + 1] = Math.min(255, ad[i + 1] * lum + spec + rim * 0.6);
        od[i + 2] = Math.min(255, ad[i + 2] * lum + spec * 1.06 + rim);
        od[i + 3] = a;
      }
    }
    fctx.putImageData(out, 0, 0);
  }

  function shipAtlas(typeKey, hue, scaleMul) {
    scaleMul = scaleMul || 1;
    const key = typeKey + ':' + Math.round(hue) + ':' + scaleMul;
    let cached = atlasCache.get(key);
    if (cached) return cached;
    const t = SHIP_TYPES[typeKey];
    const r0 = t.radius * 1.5 * scaleMul;
    const cell = Math.ceil(r0 * 2 * 1.4) + 12;
    const SS = scaleMul > 1.5 ? 2 : 3;  // heavier supersample where sprites are small
    const cs = cell * SS;
    const r = r0 * SS;
    const doc = GLOBAL.document;
    const mk = () => { const c = doc.createElement('canvas'); c.width = c.height = cs; return c; };
    const hC = mk(), aC = mk(), fC = mk(), sC = mk();
    const hctx = hC.getContext('2d'), actx2 = aC.getContext('2d');
    const fctx = fC.getContext('2d'), sctx = sC.getContext('2d');
    const atlas = doc.createElement('canvas');
    atlas.width = cell * ROT_FRAMES; atlas.height = cell;
    const g = atlas.getContext('2d');
    for (let f = 0; f < ROT_FRAMES; f++) {
      const ang = f / ROT_FRAMES * TAU;
      paintHeight(hctx, t, r, ang, cs);
      // soften the heightmap so edges become bevels for the normal pass
      try {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, cs, cs);
        sctx.drawImage(hC, 0, 0);
        hctx.setTransform(1, 0, 0, 1, 0, 0);
        hctx.clearRect(0, 0, cs, cs);
        hctx.filter = 'blur(' + Math.max(0.8, SS * 0.6) + 'px)';   // tight bevels: sharp, not mushy
        hctx.drawImage(sC, 0, 0);
        hctx.filter = 'none';
      } catch (e) { }
      paintAlbedo(actx2, t, hue, r, ang, cs);
      lightCompose(fctx, hctx.getImageData(0, 0, cs, cs), actx2.getImageData(0, 0, cs, cs), cs);
      g.drawImage(fC, 0, 0, cs, cs, f * cell, 0, cell, cell);
    }
    cached = { c: atlas, cell };
    atlasCache.set(key, cached);
    return cached;
  }

  function drawShip(s) {
    if (s.dead) return;
    const isMe = s === G.player;
    const isAlly = s.team && G.player && G.player.team && s.team === G.player.team;
    const stealthy = s.t.stealth && !isMe && !isAlly;
    const alpha = stealthy ? 0.35 : 1;
    const r = s.t.radius * 1.5;

    // motion trail (subtle)
    if (s.trail && !stealthy) {
      ctx.globalCompositeOperation = 'lighter';
      for (const tp of s.trail) {
        if (tp.a <= 0) continue;
        drawGlow(tp.x, tp.y, 13, s.hue, tp.a * 0.1);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // rotation quantized to 36 frames, like the original's sprites
    const frame = ((Math.round(s.angle / TAU * ROT_FRAMES) % ROT_FRAMES) + ROT_FRAMES) % ROT_FRAMES;
    const qa = frame / ROT_FRAMES * TAU;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(s.x, s.y);
    // faint team-color halo so ships read against the void (kept subtle —
    // the sprite's own lighting carries the look now)
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(0, 0, 50, s.hue, stealthy ? 0.06 : 0.14);
    ctx.globalCompositeOperation = 'source-over';

    // engine flames under the hull, aligned to the quantized frame
    const th = s.remote ? s.netTh : (s.ctl.thrust > 0 || s.rocketT > 0 ? 1 : 0);
    if (th) {
      ctx.save();
      ctx.rotate(qa);
      const rk = s.rocketT > 0;
      const fl = (rk ? 1.9 : 1) * (0.75 + Math.random() * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      for (const en of s.t.engines) {
        const ex = en[0] * r, eyy = en[1] * r;
        ctx.beginPath();
        ctx.moveTo(ex, eyy + r * 0.18);
        ctx.lineTo(ex - r * fl, eyy);
        ctx.lineTo(ex, eyy - r * 0.18);
        ctx.closePath();
        ctx.fillStyle = 'hsla(' + (rk ? 14 : 28) + ',100%,58%,0.85)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(ex, eyy + r * 0.09);
        ctx.lineTo(ex - r * fl * 0.55, eyy);
        ctx.lineTo(ex, eyy - r * 0.09);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,250,235,0.9)';
        ctx.fill();
        drawGlow(ex - r * 0.3, eyy, 24 * fl, rk ? 14 : 32, 0.6);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    const atlas = shipAtlas(s.type, s.hue);
    ctx.drawImage(atlas.c, frame * atlas.cell, 0, atlas.cell, atlas.cell,
      -atlas.cell / 2, -atlas.cell / 2, atlas.cell, atlas.cell);
    if (s.flash > 0) {
      // brighten the sprite on hit
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.85;
      ctx.drawImage(atlas.c, frame * atlas.cell, 0, atlas.cell, atlas.cell,
        -atlas.cell / 2, -atlas.cell / 2, atlas.cell, atlas.cell);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
    }
    ctx.restore();

    if (s.safe > 0) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(G.time * 1.4);
      const R = s.t.radius + 9;
      ctx.strokeStyle = 'rgba(120,220,255,' + (0.35 + 0.3 * Math.sin(G.time * 10)).toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      // hex shield
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = i / 6 * TAU;
        const px = Math.cos(a) * R, py = Math.sin(a) * R;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (!stealthy || isMe) {
      ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = isMe ? 'rgba(160,240,255,0.9)'
        : isAlly ? 'rgba(140,190,255,0.85)'
        : s.team && G.player && G.player.team ? 'rgba(255,150,130,0.85)'
        : 'rgba(200,210,235,0.6)';
      const badge = s.elo >= 1600 ? '★★ ' : s.elo >= 1400 ? '★ ' : s.elo >= 1275 ? '☆ ' : '';
      ctx.fillText(badge + s.name, s.x, s.y + s.t.radius + 20);
      const frac = clamp(s.energy / s.maxEnergy, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(s.x - 14, s.y + s.t.radius + 24, 28, 3);
      ctx.fillStyle = frac > 0.5 ? 'rgba(90,230,170,0.8)' : frac > 0.25 ? 'rgba(250,210,80,0.85)' : 'rgba(250,90,80,0.9)';
      ctx.fillRect(s.x - 14, s.y + s.t.radius + 24, 28 * frac, 3);
    }
  }

  // ---------------------------------------------------------------- world render
  // weapon level colors: L1 red-orange, L2 yellow, L3 blue
  const BULLET_HUES = { 1: 18, 2: 52, 3: 205 };
  const BOMB_HUES = { 1: 4, 2: 52, 3: 210 };
  function drawWorld() {
    const W = G.W;
    ctx.save();
    const shx = (Math.random() - 0.5) * G.shake, shy = (Math.random() - 0.5) * G.shake;
    ctx.translate(Math.round(vw / 2 - G.cam.x + shx), Math.round(vh / 2 - G.cam.y + shy));

    ctx.drawImage(G.mapBig, 0, 0);

    // core objective ring
    if (G.match && G.match.mode === 'core') {
      const C = WORLD / 2;
      const own = G.coreOwner;
      const hue = own === 1 ? 210 : own === 2 ? 8 : 50;
      const pulse = 0.5 + 0.25 * Math.sin(G.time * (own ? 6 : 2));
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'hsla(' + hue + ',90%,60%,' + pulse.toFixed(3) + ')';
      ctx.lineWidth = own ? 5 : 3;
      ctx.beginPath();
      ctx.arc(C, C, 340, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'hsla(' + hue + ',90%,70%,0.25)';
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(C, C, 340, 0, TAU);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    for (const p of W.prizes) {
      const pulse = 0.75 + 0.25 * Math.sin(G.time * 4 + p.phase);
      const fade = p.ttl < 4 && !G.online ? p.ttl / 4 : 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(0, 0, 36 * pulse, 130, 0.55 * fade);
      ctx.globalCompositeOperation = 'source-over';
      ctx.rotate(G.time * 1.5 + p.phase);
      ctx.strokeStyle = 'rgba(90,255,130,' + (0.9 * fade).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.strokeRect(-6 * pulse, -6 * pulse, 12 * pulse, 12 * pulse);
      ctx.strokeStyle = 'rgba(200,255,210,' + (0.55 * fade).toFixed(3) + ')';
      ctx.strokeRect(-3 * pulse, -3 * pulse, 6 * pulse, 6 * pulse);
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const b of W.bullets) {
      const hue = BULLET_HUES[b.level] || 46;
      // streak
      ctx.strokeStyle = 'hsla(' + hue + ',100%,72%,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.022, b.y - b.vy * 0.022);
      ctx.stroke();
      drawGlow(b.x, b.y, 20, hue, 0.9);
      ctx.fillStyle = 'hsla(' + hue + ',100%,85%,1)';
      ctx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
    }
    for (const b of W.bombs) {
      // original bombs: pulsing fireballs colored by level
      const hue = BOMB_HUES[b.level] || 4;
      const pulse = 1 + 0.3 * Math.sin(G.time * 18);
      drawGlow(b.x, b.y, (28 + b.level * 8) * pulse, hue, 0.95);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(G.time * 10);
      ctx.strokeStyle = 'hsla(' + hue + ',100%,72%,0.8)';
      ctx.lineWidth = 1.5;
      const br = 5 + b.level * 1.5;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = i / 4 * TAU;
        ctx.moveTo(Math.cos(a) * br * 0.5, Math.sin(a) * br * 0.5);
        ctx.lineTo(Math.cos(a) * br, Math.sin(a) * br);
      }
      ctx.stroke();
      const core = ctx.createRadialGradient(0, 0, 0.5, 0, 0, 3.5 + b.level);
      core.addColorStop(0, '#fff8e8');
      core.addColorStop(1, 'hsla(' + hue + ',100%,60%,0.95)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, 3 + b.level, 0, TAU);
      ctx.fill();
      ctx.restore();
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
      } else if (p.kind === 'debris') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = 'hsla(' + p.hue + ',70%,55%,' + (f * 0.85).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(p.size, 0);
        ctx.lineTo(-p.size * 0.6, p.size * 0.7);
        ctx.lineTo(-p.size * 0.6, -p.size * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (p.kind === 'flash') {
        drawGlow(p.x, p.y, p.size * (2 - f), p.hue, f);
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

    for (const s of W.ships) drawShip(s);
    ctx.restore();
  }

  function applyBloom() {
    if (!bloomC) return;
    // pure downscale->upscale bloom: bilinear filtering supplies the soft
    // spread. No per-frame ctx.filter blur — that path is CPU-rasterized
    // and tanks the framerate on Firefox.
    const bw = bloomC.width, bh = bloomC.height;
    bloomCtx.clearRect(0, 0, bw, bh);
    bloomCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, bw, bh);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.24;
    ctx.drawImage(bloomC, 0, 0, bw, bh, 0, 0, vw, vh);
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
  function panel(x, y, w, h) {
    ctx.fillStyle = 'rgba(6,12,26,0.72)';
    rr(x, y, w, h, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(80,140,230,0.35)';
    ctx.lineWidth = 1;
    rr(x, y, w, h, 8); ctx.stroke();
  }
  function txt(str, x, y, size, color, align, weight) {
    ctx.font = (weight || 600) + ' ' + size + 'px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function shipColor(s, l, a) { return 'hsla(' + s.hue + ',95%,' + l + '%,' + (a == null ? 1 : a) + ')'; }

  function drawHUD() {
    const p = G.player;
    if (!p) return;

    // energy bar with segment ticks + glow cap
    const bw = Math.min(380, vw - 40), bx = vw / 2 - bw / 2, by = 16;
    const frac = clamp(p.energy / p.maxEnergy, 0, 1);
    panel(bx - 5, by - 5, bw + 10, 27);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(bx, by, bw, 17);
    const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    if (frac > 0.5) { bg.addColorStop(0, 'rgba(60,190,255,0.95)'); bg.addColorStop(1, 'rgba(120,255,230,0.95)'); }
    else if (frac > 0.25) { bg.addColorStop(0, 'rgba(255,180,60,0.95)'); bg.addColorStop(1, 'rgba(255,230,110,0.95)'); }
    else {
      const fl = 0.7 + 0.3 * Math.sin(G.time * 12);
      bg.addColorStop(0, 'rgba(255,70,60,' + fl.toFixed(3) + ')');
      bg.addColorStop(1, 'rgba(255,130,90,' + fl.toFixed(3) + ')');
    }
    ctx.fillStyle = bg;
    ctx.fillRect(bx, by, bw * frac, 17);
    ctx.fillStyle = 'rgba(4,8,18,0.55)';
    for (let i = 1; i < 10; i++) ctx.fillRect(bx + bw * i / 10 - 0.5, by, 1, 17);
    if (frac > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(bx + bw * frac, by + 8, 26, frac > 0.5 ? 190 : frac > 0.25 ? 45 : 5, 0.7);
      ctx.globalCompositeOperation = 'source-over';
    }
    txt(String(Math.max(0, p.energy | 0)), vw / 2, by + 13, 12, '#eaffff', 'center', 700);

    // match score bar (duel / squad / core / online teams)
    if (G.duel) {
      const d = G.duel;
      const mw = 250, mx = vw / 2 - mw / 2, my = by + 30;
      panel(mx, my, mw, 24);
      txt('YOU', mx + 12, my + 16, 10, '#8fc2ff', 'left', 700);
      txt(d.name.toUpperCase(), mx + mw - 12, my + 16, 10, '#ff9d8a', 'right', 700);
      txt(d.mine + '  —  ' + d.theirs, mx + mw / 2, my + 17, 14, '#ffe9b8', 'center', 800);
      txt('DUEL · first to ' + d.target, vw / 2, my + 38, 10, '#fd8', 'center');
    } else if (G.match) {
      const m = G.match;
      const mine = myTeam() === 2 ? m.b : m.a;
      const theirs = myTeam() === 2 ? m.a : m.b;
      const mw = 230, mx = vw / 2 - mw / 2, my = by + 30;
      panel(mx, my, mw, 24);
      const labelL = m.mode === 'duel' ? 'YOU' : 'ALLIES';
      const labelR = m.mode === 'duel' ? 'ACE' : 'ENEMY';
      txt(labelL, mx + 12, my + 16, 10, '#8fc2ff', 'left', 700);
      txt(labelR, mx + mw - 12, my + 16, 10, '#ff9d8a', 'right', 700);
      txt(mine + '  —  ' + theirs, mx + mw / 2, my + 17, 14, '#eaffff', 'center', 800);
      const coreNote = m.mode === 'core'
        ? (G.coreOwner ? (G.coreOwner === myTeam() ? 'CORE: yours' : 'CORE: contested by enemy') : 'CORE: open')
        : '';
      txt((m.mode === 'core' ? coreNote + ' · ' : '') + 'first to ' + m.target, vw / 2, my + 38, 10,
        m.mode === 'core' && G.coreOwner ? (G.coreOwner === myTeam() ? '#8fc2ff' : '#ff9d8a') : '#678', 'center');
    }

    // center banner: countdowns, multikills, victory
    if (G.banner) {
      const b = G.banner;
      const a = b.t < 0.25 ? b.t / 0.25 : b.t > b.dur - 0.5 ? Math.max(0, (b.dur - b.t) / 0.5) : 1;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.shadowColor = 'rgba(255,200,90,0.8)';
      ctx.shadowBlur = 26;
      txt(b.main, vw / 2, vh * 0.3, 44, '#ffe9b8', 'center', 800);
      ctx.restore();
      if (b.sub) txt(b.sub, vw / 2, vh * 0.3 + 34, 15, '#cdb', 'center', 600);
      ctx.globalAlpha = 1;
    }

    // pilot panel
    panel(12, 12, 196, 90);
    txt(p.name + '  ·  ' + p.t.label, 22, 32, 13, shipColor(p, 70), 'left', 700);
    txt('Score ' + p.score, 22, 51, 12, '#cde');
    txt('Bounty ' + p.bounty, 116, 51, 12, '#fd8');
    txt('K ' + p.kills + '   D ' + p.deaths, 22, 69, 12, '#9ab');
    txt((G.online ? 'ONLINE · ' : 'SOLO · ') + 'Best ' + G.best, 22, 87, 11, G.online ? '#6fa' : '#678');

    // loadout
    const items = [
      'GUN L' + p.gunLevel + (p.multi ? ' MF' : ''),
      'BOMB L' + p.bombLevel + (p.proxPlus ? ' PX' + p.proxPlus : ''),
      'E ×' + p.repels,
      'Q ×' + p.bursts,
      p.t.blink ? (p.blinkCd > 0 ? 'R BLINK ' + p.blinkCd.toFixed(1) : 'R BLINK ✓') : 'R ×' + p.rockets,
    ];
    const iw = 86, totW = items.length * iw + (items.length - 1) * 6;
    let ix = vw / 2 - totW / 2;
    for (const it of items) {
      panel(ix, vh - 34, iw, 22);
      txt(it, ix + iw / 2, vh - 19, 11, 'rgba(170,200,240,0.9)', 'center', 700);
      ix += iw + 6;
    }

    // leaderboard
    const board = G.W.ships.slice().sort((a, b) => b.score - a.score).slice(0, 6);
    const lw = 184, lx = vw - lw - 12;
    panel(lx, 12, lw, 26 + board.length * 17);
    txt('ZONE STANDINGS', lx + 10, 29, 10, '#68a', 'left', 700);
    board.forEach((s, i) => {
      const y = 47 + i * 17;
      const me = s === G.player;
      txt((i + 1) + '. ' + s.name, lx + 10, y, 11, me ? '#8ef' : '#bcd', 'left', me ? 700 : 500);
      txt(String(s.score), lx + lw - 10, y, 11, me ? '#8ef' : '#89a', 'right');
    });

    drawRadar();
    drawMessages();

    // chat input
    if (G.chatOpen) {
      panel(10, vh - 62, Math.min(520, vw - 20), 26);
      txt('say> ' + G.chatStr + ((G.time * 3 | 0) % 2 ? '_' : ''), 20, vh - 44, 13, '#cfe', 'left', 600);
    }

    if (p.dead) {
      ctx.fillStyle = 'rgba(4,6,13,0.55)';
      ctx.fillRect(0, 0, vw, vh);
      txt('WARPED OUT', vw / 2, vh / 2 - 40, 42, '#f66', 'center', 800);
      txt('destroyed by ' + G.deathBy, vw / 2, vh / 2 - 6, 16, '#dbc', 'center');
      txt('loadout reset — respawn in ' + Math.max(0, p.respawn).toFixed(1), vw / 2, vh / 2 + 24, 14, '#9ab', 'center');
    }

    if (G.hitFlash > 0) {
      ctx.globalAlpha = G.hitFlash;
      ctx.fillStyle = 'rgba(255,40,30,0.35)';
      ctx.fillRect(0, 0, vw, vh);
      ctx.globalAlpha = 1;
    }
  }

  function drawRadar() {
    const R = 172, rx = vw - R - 12, ry = vh - R - 12;
    panel(rx - 5, ry - 5, R + 10, R + 10);
    ctx.drawImage(G.radarC, rx, ry, R, R);
    ctx.strokeStyle = 'rgba(70,120,200,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + R / 2, ry); ctx.lineTo(rx + R / 2, ry + R);
    ctx.moveTo(rx, ry + R / 2); ctx.lineTo(rx + R, ry + R / 2);
    ctx.stroke();
    const k = R / WORLD;
    const swa = G.time * 1.2 % TAU;
    ctx.strokeStyle = 'rgba(90,200,160,0.25)';
    ctx.beginPath();
    ctx.moveTo(rx + R / 2, ry + R / 2);
    ctx.lineTo(rx + R / 2 + Math.cos(swa) * R / 2, ry + R / 2 + Math.sin(swa) * R / 2);
    ctx.stroke();
    for (const p of G.W.prizes) {
      ctx.fillStyle = 'rgba(90,255,130,0.8)';
      ctx.fillRect(rx + p.x * k - 1, ry + p.y * k - 1, 2, 2);
    }
    for (const s of G.W.ships) {
      if (s.dead) continue;
      if (s === G.player) {
        ctx.fillStyle = (G.time * 4 | 0) % 2 ? '#fff' : '#8ef';
        ctx.fillRect(rx + s.x * k - 2, ry + s.y * k - 2, 4, 4);
      } else {
        const ally = s.team && G.player && G.player.team && s.team === G.player.team;
        if ((s.t.stealth || s.t.radarStealth) && !ally) continue; // ghosts don't paint on radar
        ctx.fillStyle = ally ? 'rgba(120,180,255,0.95)' : 'rgba(255,120,90,0.9)';
        ctx.fillRect(rx + s.x * k - 1.5, ry + s.y * k - 1.5, 3, 3);
      }
    }
    ctx.strokeStyle = 'rgba(140,180,240,0.35)';
    ctx.strokeRect(rx + (G.cam.x - vw / 2) * k, ry + (G.cam.y - vh / 2) * k, vw * k, vh * k);
  }

  function drawMessages() {
    const max = 8;
    const start = Math.max(0, G.msgs.length - max);
    let y = vh - (G.chatOpen ? 76 : 44);
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
    ctx.shadowBlur = 34;
    txt('INTERSTELLAR', vw / 2, vh / 2 - 70, 72, '#c8ecff', 'center', 800);
    ctx.shadowColor = 'rgba(255,180,80,0.8)';
    txt('T O P - D O W N   S P A C E   C O M B A T', vw / 2, vh / 2 - 26, 16, '#ffd9a0', 'center', 700);
    ctx.restore();
    const blink = Math.sin(G.time * 4) > -0.3;
    if (blink) txt('ENTER — SQUAD BATTLE  3v3', vw / 2, vh / 2 + 62, 20, '#cff', 'center', 700);
    txt('1 duel the Ace   ·   2 squad battle   ·   3 free-for-all   ·   4 hold the core', vw / 2, vh / 2 + 92, 14, '#9bc', 'center', 600);
    txt('O — online multiplayer', vw / 2, vh / 2 + 118, 16, '#8fd4a8', 'center', 700);
    txt('best score ' + G.best + '   ·   duel record ' + G.duelW + 'W – ' + G.duelL + 'L', vw / 2, vh / 2 + 146, 13, '#678', 'center');
    txt('M mute  ·  N music  ·  F fullscreen', vw / 2, vh - 24, 12, '#567', 'center');
  }

  function statBar(x, y, w, label, frac, hue) {
    txt(label, x, y + 8, 10, '#89a');
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + 66, y, w - 66, 8);
    ctx.fillStyle = 'hsla(' + hue + ',90%,60%,0.9)';
    ctx.fillRect(x + 66, y, (w - 66) * clamp(frac, 0.05, 1), 8);
  }

  function drawSelect() {
    ctx.fillStyle = 'rgba(4,6,13,0.78)';
    ctx.fillRect(0, 0, vw, vh);
    txt('CHOOSE YOUR SHIP', vw / 2, 72, 30, '#c8ecff', 'center', 800);
    const modeLabel = G.online ? 'ONLINE ZONE'
      : G.pendingMode === 'duel' ? 'DUEL — you vs the Ace, first to 5'
      : G.pendingMode === 'squad' ? 'SQUAD BATTLE — 3v3, first to 15'
      : G.pendingMode === 'core' ? 'HOLD THE CORE — 3v3, first to 20'
      : 'FREE-FOR-ALL SANDBOX';
    txt(modeLabel, vw / 2, 96, 13, '#fd8', 'center', 700);
    txt('◄ ► select   ·   ENTER launch   ·   ESC back', vw / 2, 116, 12, '#789', 'center');

    const n = SHIP_ORDER.length;
    const cy = vh / 2 - 40;

    // carousel: selected ship large in center, neighbours receding
    for (let off = -2; off <= 2; off++) {
      const i = ((G.sel + off) % n + n) % n;
      const t = SHIP_TYPES[SHIP_ORDER[i]];
      const x = vw / 2 + off * Math.min(220, vw / 5.2);
      const focus = off === 0;
      const scale = focus ? 3.6 : 1.7 - Math.abs(off) * 0.25;
      ctx.save();
      ctx.translate(x, cy);
      ctx.globalAlpha = focus ? 1 : 0.35;
      if (focus) {
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(0, 0, 190, t.hue, 0.18);
        ctx.globalCompositeOperation = 'source-over';
      }
      const ang = focus ? G.time * 0.9 : -0.5;
      const at = shipAtlas(SHIP_ORDER[i], t.hue, focus ? 2.8 : 1.4);
      const fr = ((Math.round(ang / TAU * ROT_FRAMES) % ROT_FRAMES) + ROT_FRAMES) % ROT_FRAMES;
      ctx.drawImage(at.c, fr * at.cell, 0, at.cell, at.cell, -at.cell / 2, -at.cell / 2, at.cell, at.cell);
      ctx.restore();
    }

    const t = SHIP_TYPES[SHIP_ORDER[G.sel]];
    const isNova = t.cls === 'nova';
    txt(isNova ? 'NOVA CLASS — NEW GENERATION' : 'FLEET CLASS', vw / 2, cy + 88, 11,
      isNova ? '#fd8' : '#68a', 'center', 700);
    txt(t.label.toUpperCase(), vw / 2, cy + 116, 30, 'hsla(' + t.hue + ',90%,68%,1)', 'center', 800);
    txt((G.sel + 1) + ' / ' + n, vw / 2, cy + 136, 12, '#678', 'center');
    txt(t.desc, vw / 2, cy + 160, 14, '#abc', 'center', 500);

    // stat panel
    const sw = Math.min(560, vw - 60), sx = vw / 2 - sw / 2, sy = cy + 180;
    panel(sx, sy, sw, 66);
    const col = (sw - 40) / 3;
    statBar(sx + 20, sy + 14, col - 20, 'ENERGY', t.maxEnergy / 2600, t.hue);
    statBar(sx + 20, sy + 32, col - 20, 'RECHRG', t.recharge / 135, t.hue);
    statBar(sx + 20 + col, sy + 14, col - 20, 'SPEED', t.maxSpeed / 430, t.hue);
    statBar(sx + 20 + col, sy + 32, col - 20, 'AGILITY', t.turn / 4.8, t.hue);
    statBar(sx + 20 + col * 2, sy + 14, col - 20, 'GUNS', (t.gunDmgMul / t.gunDelay) / 3.2, t.hue);
    statBar(sx + 20 + col * 2, sy + 32, col - 20, 'BOMBS', (t.bombLevel / t.bombDelay) / 1.15, t.hue);
    const traits = [];
    if (t.stealth) traits.push('STEALTH: invisible to radar, dim to eyes');
    if (t.radarStealth) traits.push('SENSOR GHOST: never paints on enemy radar');
    if (t.dualGuns) traits.push('TWIN CANNONS: dual parallel bullet streams');
    if (t.bombBounce) traits.push('BOUNCING BOMBS: +' + t.bombBounce + ' wall ricochets');
    if (t.proxStart) traits.push('FACTORY PROXIMITY FUSES');
    if (t.repelRegen) traits.push('REPEL RACK: restocks every ' + t.repelRegen + 's');
    if (t.startMulti) traits.push('FACTORY MULTIFIRE');
    if (t.armor) traits.push('PLATING: takes ' + Math.round((1 - t.armor) * 100) + '% less damage');
    if (t.leech) traits.push('LEECH: steals ' + Math.round(t.leech * 100) + '% of damage dealt as energy');
    if (t.blink) traits.push('BLINK DRIVE: R teleports 240m forward, through walls');
    if (traits.length) txt(traits.join('  ·  '), vw / 2, sy + 56, 11, '#fd8', 'center', 600);
  }

  function drawNameEntry() {
    ctx.fillStyle = 'rgba(4,6,13,0.78)';
    ctx.fillRect(0, 0, vw, vh);
    txt('PILOT CALLSIGN', vw / 2, vh / 2 - 70, 30, '#c8ecff', 'center', 800);
    panel(vw / 2 - 160, vh / 2 - 30, 320, 44);
    txt(G.nameStr + ((G.time * 3 | 0) % 2 ? '_' : ''), vw / 2, vh / 2 - 1, 20, '#cff', 'center', 700);
    txt('ENTER — connect to ' + serverURL(), vw / 2, vh / 2 + 50, 14, '#8fd4a8', 'center');
    const zs = G.zoneStatus;
    if (zs && !zs.err) {
      txt('zone online — ' + zs.players + ' pilot' + (zs.players === 1 ? '' : 's') + ' · ' +
        zs.bots + ' bots · mode ' + zs.mode + ' · map ' + zs.map, vw / 2, vh / 2 + 76, 13, '#8fc2ff', 'center', 600);
    } else if (zs && zs.err) {
      txt('zone status unavailable — connecting may still work', vw / 2, vh / 2 + 76, 12, '#a86', 'center');
    }
    txt('your callsign is your identity: elo, duel record, and stats persist on the server', vw / 2, vh / 2 + 100, 11, '#678', 'center');
    txt('ESC — back', vw / 2, vh / 2 + 124, 12, '#678', 'center');
  }
  function drawConnecting() {
    ctx.fillStyle = 'rgba(4,6,13,0.78)';
    ctx.fillRect(0, 0, vw, vh);
    const dots = '...'.slice(0, 1 + ((G.time * 2 | 0) % 3));
    txt('CONNECTING' + dots, vw / 2, vh / 2 - 10, 28, '#c8ecff', 'center', 800);
    txt(serverURL(), vw / 2, vh / 2 + 24, 14, '#789', 'center');
  }
  function drawError() {
    ctx.fillStyle = 'rgba(4,6,13,0.82)';
    ctx.fillRect(0, 0, vw, vh);
    txt('CONNECTION FAILED', vw / 2, vh / 2 - 40, 30, '#f66', 'center', 800);
    txt(G.netErr || 'Could not reach the zone server.', vw / 2, vh / 2, 14, '#dbc', 'center');
    txt('Run:  node server.js   (then open http://localhost:8666)', vw / 2, vh / 2 + 30, 13, '#9ab', 'center');
    txt('R — retry   ·   ESC — back to title', vw / 2, vh / 2 + 64, 14, '#8fd4a8', 'center');
  }

  function drawPause() {
    ctx.fillStyle = 'rgba(4,6,13,0.7)';
    ctx.fillRect(0, 0, vw, vh);
    txt(G.online ? 'MENU  (the zone keeps fighting)' : 'PAUSED', vw / 2, vh / 2 - 120, 34, '#c8ecff', 'center', 800);
    const lines = [
      '← →            rotate',
      'W / ↑            thrust        S / ↓   reverse',
      'A / D            strafe left / right',
      'SPACE / CTRL   guns (bullets always ricochet)',
      'TAB / SHIFT    bomb',
      'E repel   Q burst   R rocket/blink   T warp-to-Comet',
      'ENTER          chat · /duel <name> · /votemap · /stats',
      'M mute         N music        F fullscreen',
      '',
      'P resume    ·    BACKSPACE abandon to title',
    ];
    let y = vh / 2 - 70;
    for (const l of lines) { txt(l, vw / 2 - 160, y, 14, '#abc', 'left', 500); y += 24; }
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackdrop();
    // depth haze: everything behind this line is scenery, not gameplay
    ctx.fillStyle = 'rgba(3,5,12,0.22)';
    ctx.fillRect(0, 0, vw, vh);
    if (G.W && G.mapBig) drawWorld();
    applyBloom();
    if (vignette) ctx.drawImage(vignette, 0, 0, vw, vh);
    if (G.state === 'title') drawTitle();
    else if (G.state === 'select') drawSelect();
    else if (G.state === 'nameentry') drawNameEntry();
    else if (G.state === 'connecting') drawConnecting();
    else if (G.state === 'error') drawError();
    else if (G.state === 'play') {
      drawHUD();
      if (G.paused) drawPause();
    }
  }

  // ---------------------------------------------------------------- persistence
  function loadBest() {
    try { G.best = parseInt(GLOBAL.localStorage.getItem('interstellar-best') || '0', 10) || 0; } catch (e) { G.best = 0; }
    try {
      const d = (GLOBAL.localStorage.getItem('interstellar-duels') || '0,0').split(',');
      G.duelW = parseInt(d[0], 10) || 0;
      G.duelL = parseInt(d[1], 10) || 0;
    } catch (e) { G.duelW = 0; G.duelL = 0; }
  }
  function saveBest() {
    try { GLOBAL.localStorage.setItem('interstellar-best', String(G.best)); } catch (e) { }
  }
  function loadName() {
    try { return GLOBAL.localStorage.getItem('interstellar-name') || ''; } catch (e) { return ''; }
  }
  function saveName(n) {
    try { GLOBAL.localStorage.setItem('interstellar-name', n); } catch (e) { }
  }

  // ---------------------------------------------------------------- flow
  const TEAM_HUES = { 1: [200, 212, 190, 224], 2: [10, 24, 0, 34] };
  function startSolo(shipKey) {
    const mode = G.pendingMode || 'ffa';
    G.mode = mode;
    G.online = false;
    if (G.net) { try { G.net.close(); } catch (e) { } G.net = null; }
    G.combo = 0; G.lastKillT = -99; G.banner = null;
    const C = WORLD / 2;
    let s;
    if (mode === 'duel') {
      // 1v1 against the Ace: fast respawns facing each other across the arena
      G.W = SIM.createWorld({
        seed: (Math.random() * 1e9) | 0, spawnPrizes: true,
        respawnDelay: 1.4, safeTime: 1.0,
        spawnPoint: sh => sh.team === 1
          ? { x: C - 430, y: C, angle: 0 }
          : { x: C + 430, y: C, angle: Math.PI },
      });
      prerenderMap();
      const ace = SIM.makeShip(G.W, SIM.pick(['corsair', 'paladin', 'reaper', 'comet']), 'bot', 'Ace', TEAM_HUES[2][0], 2);
      ace.ai.skill = 0.92;
      SIM.spawnShip(G.W, ace);
      s = SIM.makeShip(G.W, shipKey, 'local', 'You', TEAM_HUES[1][0], 1);
      SIM.spawnShip(G.W, s);
      G.match = { mode, target: 5, a: 0, b: 0, over: false };
      banner('DUEL — FIRST TO 5', 'the Ace shows no mercy', 3.2);
      say('Duel started. Greens still spawn — control them.', '#8df');
    } else if (mode === 'squad' || mode === 'core') {
      // 3v3 squad dogfight: anchored team spawns on opposite flanks
      G.W = SIM.createWorld({
        seed: (Math.random() * 1e9) | 0, spawnPrizes: true,
        respawnDelay: 2.2, safeTime: 2.0,
        spawnPoint: sh => ({
          x: (sh.team === 1 ? C - 950 : C + 950) + SIM.rand(-260, 260),
          y: C + SIM.rand(-320, 320),
          angle: sh.team === 1 ? 0 : Math.PI,
        }),
      });
      prerenderMap();
      const names = SIM.BOT_NAMES.slice();
      const takeName = () => names.splice((Math.random() * names.length) | 0, 1)[0];
      for (let i = 0; i < 2; i++) {
        const ally = SIM.makeShip(G.W, SIM.pick(SIM.SHIP_ORDER), 'bot', takeName(), TEAM_HUES[1][i + 1], 1);
        ally.ai.skill = 0.62;
        SIM.spawnShip(G.W, ally);
      }
      for (let i = 0; i < 3; i++) {
        const foe = SIM.makeShip(G.W, SIM.pick(SIM.SHIP_ORDER), 'bot', takeName(), TEAM_HUES[2][i], 2);
        foe.ai.skill = 0.62;
        SIM.spawnShip(G.W, foe);
      }
      s = SIM.makeShip(G.W, shipKey, 'local', 'You', TEAM_HUES[1][0], 1);
      SIM.spawnShip(G.W, s);
      if (mode === 'core') {
        G.match = { mode: 'core', target: 20, a: 0, b: 0, over: false, coreAcc: 0 };
        G.coreOwner = 0;
        banner('HOLD THE CORE — FIRST TO 20', 'own the center ring alone to score', 3.6);
        say('Hold the Core: 3 seconds of sole control = 1 point.', '#8df');
      } else {
        G.match = { mode, target: 15, a: 0, b: 0, over: false };
        banner('SQUAD BATTLE — FIRST TO 15', 'your wing is with you', 3.2);
        say('Squad battle: blue vs red. No friendly fire.', '#8df');
      }
    } else {
      G.match = null;
      newSoloWorld();
      s = SIM.makeShip(G.W, shipKey, 'local', 'You', 190);
      SIM.spawnShip(G.W, s);
      say('Welcome to Interstellar — good luck, pilot.', '#8df');
      say('Collect greens. Guard your energy. Everything costs it.', '#8df');
    }
    if (mode !== 'ffa') {
      for (let i = 0; i < 10; i++) {
        const p = SIM.randClearPoint(G.W);
        SIM.addPrize(G.W, p.x, p.y);
      }
    }
    SIM.drainEvents(G.W);
    G.player = s;
    G.state = 'play';
    G.paused = false;
    return s;
  }
  function launchOnline(shipKey) {
    G.pendingShip = shipKey;
    netSend({ t: 'join', name: G.name, ship: shipKey });
    // welcome handler flips to play
  }
  function leaveToTitle() {
    if (G.online || G.net) {
      try { if (G.net) G.net.close(); } catch (e) { }
      G.net = null; G.online = false;
    }
    G.player = null;
    G.chatOpen = false;
    G.match = null;
    G.banner = null;
    newSoloWorld(); // fresh attract-mode zone behind the title
    G.state = 'title';
    G.paused = false;
  }

  // ---------------------------------------------------------------- input
  function updatePlayerInput() {
    const p = G.player;
    if (!p || p.dead || G.state !== 'play' || (G.paused && !G.online) || G.chatOpen) {
      if (p && (G.chatOpen || G.paused)) { p.ctl.turn = 0; p.ctl.thrust = 0; p.ctl.strafe = 0; p.ctl.gun = false; p.ctl.bomb = false; }
      return;
    }
    const c = p.ctl;
    // arrows rotate + thrust (classic); A/D strafe sideways; W/S also thrust
    c.turn = (keys.ArrowLeft ? -1 : 0) + (keys.ArrowRight ? 1 : 0);
    c.thrust = keys.ArrowUp || keys.KeyW ? 1 : keys.ArrowDown || keys.KeyS ? -1 : 0;
    c.strafe = (keys.KeyA ? -1 : 0) + (keys.KeyD ? 1 : 0);
    c.gun = !!(keys.Space || keys.ControlLeft || keys.ControlRight);
    c.bomb = !!(keys.Tab || keys.ShiftLeft || keys.ShiftRight || keys.KeyB);
  }

  const HANDLED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Enter', 'Backspace', 'Escape',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyB', 'KeyE', 'KeyQ', 'KeyR', 'KeyT', 'KeyM', 'KeyN', 'KeyP', 'KeyF', 'KeyO']);

  function onKeyDown(e) {
    audioInit();
    if (SFX.ctx && SFX.ctx.state === 'suspended') SFX.ctx.resume();
    // normalize: any key that MEANS an arrow acts as that arrow everywhere
    const code = e.key && e.key.startsWith('Arrow') ? e.key : e.code;

    // chat capture first
    if (G.chatOpen) {
      e.preventDefault();
      if (code === 'Enter') {
        let text = G.chatStr.trim();
        if (text) {
          const tc = text.startsWith('//') ? 1 : 0;
          if (tc) text = text.slice(2).trim();
          if (text) {
            netSend({ t: 'chat', text: text.slice(0, 120), tc });
            say((tc ? 'T· ' : '') + G.name + '> ' + text, tc ? '#8fd4a8' : '#cfe');
          }
        }
        G.chatOpen = false; G.chatStr = '';
      } else if (code === 'Escape') { G.chatOpen = false; G.chatStr = ''; }
      else if (code === 'Backspace') G.chatStr = G.chatStr.slice(0, -1);
      else if (e.key && e.key.length === 1 && G.chatStr.length < 120) G.chatStr += e.key;
      return;
    }
    if (G.state === 'nameentry') {
      e.preventDefault();
      if (code === 'Enter') {
        G.name = (G.nameStr.trim() || 'Pilot' + (100 + irand(900)));
        saveName(G.name);
        netConnect();
      } else if (code === 'Escape') G.state = 'title';
      else if (code === 'Backspace') G.nameStr = G.nameStr.slice(0, -1);
      else if (e.key && e.key.length === 1 && /[\w\- .]/.test(e.key) && G.nameStr.length < 14) G.nameStr += e.key;
      return;
    }

    if (HANDLED.has(code) || (e.key && e.key.startsWith('Arrow'))) e.preventDefault();
    const held = !!keys[code];
    keys[code] = true;
    // also register by key name — numpad arrows (NumLock off) report
    // code "Numpad4" but key "ArrowLeft", and must still steer
    if (e.key && e.key.length > 1) keys[e.key] = true;
    if (held) return;

    if (code === 'KeyM') { G.muted = !G.muted; say(G.muted ? 'Sound muted' : 'Sound on', '#8df'); return; }
    if (code === 'KeyN') {
      MUS.on = !MUS.on;
      try { GLOBAL.localStorage.setItem('interstellar-music', MUS.on ? '1' : '0'); } catch (err) { }
      say(MUS.on ? 'Music on' : 'Music off', '#8df');
      return;
    }
    if (code === 'KeyF') {
      try { if (canvas.requestFullscreen) canvas.requestFullscreen(); } catch (err) { }
      return;
    }

    if (G.state === 'title') {
      if (code === 'Enter' || code === 'Space') { G.online = false; G.pendingMode = 'squad'; G.state = 'select'; }
      else if (code === 'Digit1') { G.online = false; G.pendingMode = 'duel'; G.state = 'select'; }
      else if (code === 'Digit2') { G.online = false; G.pendingMode = 'squad'; G.state = 'select'; }
      else if (code === 'Digit3') { G.online = false; G.pendingMode = 'ffa'; G.state = 'select'; }
      else if (code === 'Digit4') { G.online = false; G.pendingMode = 'core'; G.state = 'select'; }
      else if (code === 'KeyO') {
        G.nameStr = G.nameStr || loadName();
        fetchZoneStatus();
        G.state = 'nameentry';
      }
    } else if (G.state === 'error') {
      if (code === 'KeyR') netConnect();
      else if (code === 'Escape') G.state = 'title';
    } else if (G.state === 'connecting') {
      if (code === 'Escape') { try { if (G.net) G.net.close(); } catch (err) { } G.net = null; G.state = 'title'; }
    } else if (G.state === 'select') {
      const n = SHIP_ORDER.length;
      if (code === 'ArrowLeft' || code === 'KeyA') G.sel = (G.sel + n - 1) % n;
      else if (code === 'ArrowRight' || code === 'KeyD') G.sel = (G.sel + 1) % n;
      else if (/^Digit[1-9]$/.test(code)) G.sel = Math.min(n - 1, parseInt(code.slice(5), 10) - 1);
      else if (code === 'Digit0') G.sel = Math.min(n - 1, 9);
      else if (code === 'Enter') {
        if (G.online) launchOnline(SHIP_ORDER[G.sel]);
        else startSolo(SHIP_ORDER[G.sel]);
      } else if (code === 'Escape') {
        if (G.net) { try { G.net.close(); } catch (err) { } G.net = null; G.online = false; }
        G.state = 'title';
      }
    } else if (G.state === 'play') {
      if (code === 'KeyP' || (code === 'Escape' && !G.online)) { G.paused = !G.paused; return; }
      if (code === 'Escape' && G.online) { G.paused = !G.paused; return; } // menu overlay; zone keeps running
      if (G.match && G.match.over && !G.online) {
        if (code === 'Enter') { startSolo(G.player ? G.player.type : SHIP_ORDER[G.sel]); return; }
        if (code === 'Backspace') { leaveToTitle(); return; }
      }
      if (G.paused) {
        if (code === 'Backspace') leaveToTitle();
        return;
      }
      if (code === 'Enter' && G.online) { G.chatOpen = true; G.chatStr = ''; return; }
      const p = G.player;
      if (!p || p.dead) return;
      if (code === 'KeyE') SIM.doRepel(G.W, p);
      else if (code === 'KeyQ') SIM.doBurst(G.W, p);
      else if (code === 'KeyR') { if (p.t.blink) SIM.doBlink(G.W, p); else SIM.fireRocket(G.W, p); }
      else if (code === 'KeyT') SIM.warpToBeacon(G.W, p);
    }
  }
  function onKeyUp(e) {
    keys[e.code] = false;
    if (e.key && e.key.length > 1) keys[e.key] = false;
  }
  function releaseAllKeys() {
    for (const k in keys) keys[k] = false;
  }

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
    bloomC = doc.createElement('canvas');
    bloomC.width = Math.max(2, vw >> 2); bloomC.height = Math.max(2, vh >> 2);
    bloomCtx = bloomC.getContext('2d');
    try { filterOK = typeof ctx.filter === 'string'; } catch (e) { filterOK = false; }
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
    initBackdrop();
    newSoloWorld();
    G.state = 'title';
    GLOBAL.addEventListener('resize', resize);
    GLOBAL.addEventListener('keydown', onKeyDown);
    GLOBAL.addEventListener('keyup', onKeyUp);
    GLOBAL.addEventListener('blur', () => {
      releaseAllKeys();   // no stuck thrusters after alt-tab
      if (G.state === 'play' && !G.online) G.paused = true;
    });
    canvas.addEventListener('mousedown', () => {
      audioInit();
      if (SFX.ctx && SFX.ctx.state === 'suspended') SFX.ctx.resume();
      if (G.state === 'title') { G.online = false; G.state = 'select'; }
    });
    // keepalive so the server doesn't drop us when the tab is throttled
    setInterval(() => { if (G.online) netSend({ t: 'ka' }); }, 5000);
    // music sequencer lookahead (starts producing sound once audio unlocks)
    try { MUS.on = GLOBAL.localStorage.getItem('interstellar-music') !== '0'; } catch (e) { }
    setInterval(musicTick, 100);
    GLOBAL.requestAnimationFrame(frame);
  }

  GLOBAL.__interstellar = { G, SIM, boot, startSolo, update, render, keys, handleNet, netConnect, STEP };

  if (GLOBAL.document && GLOBAL.document.getElementById) boot();
})();
