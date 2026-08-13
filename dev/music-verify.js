/* =========================================================================
   MUSIC VERIFY — render the score offline and measure what ears would hear.

   The smoke suite can prove the scheduler doesn't throw; it cannot prove the
   music is CONTINUOUS. This renders a full arrangement arc (calm → build →
   drop → break → calm) through an OfflineAudioContext and analyzes the
   samples: no dropout windows, no clipping, energy that actually rises into
   the drop. It also writes the excerpt as a WAV so a human can listen.

     node dev/music-verify.js [--out dir]
   ========================================================================= */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const GM = execSync('npm root -g', { encoding: 'utf8' }).trim();
Module.globalPaths.push(GM);
const { chromium } = require(path.join(GM, 'playwright'));

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.MUSV_PORT || '8812', 10);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(ROOT, 'dev');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('OK  ' + msg); return; }
  failures++;
  console.log('FAIL  ' + msg);
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BOTS: '0' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(900);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  // the game must build its audio graph on our OFFLINE context
  await page.addInitScript(() => {
    window.__off = null;
    window.AudioContext = function () {
      if (!window.__off) window.__off = new OfflineAudioContext(2, 44100 * 62, 44100);
      return window.__off;
    };
  });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
  await page.waitForFunction('!!window.__interstellar');

  const res = await page.evaluate(async () => {
    const A = window.__interstellar;
    A.audio.init();                    // SFX.ctx = the offline context
    A.audio.musicInit();               // buses, compressor, delay
    const SD = A.audio.STEP16;
    const MUS = A.MUS;

    // drive a full arc: 8 bars calm, then heat=1 (build+drop), then heat=0
    // at bar 34 so the drop exhales into break and back to calm
    const steps = Math.floor(58 / SD);
    const marks = [];                  // section transitions, in seconds
    let lastSec = MUS.sec;
    for (let i = 0; i < steps; i++) {
      const t = 1 + i * SD;
      const bar = Math.floor(i / 16);
      MUS.heat = bar >= 6 && bar < 30 ? 1 : 0;
      MUS.colorWant = bar >= 20 ? 1 : 0.2;      // sweep the tint mid-drop
      A.audio.step(i, t);
      if (MUS.sec !== lastSec) { marks.push({ sec: MUS.sec, t }); lastSec = MUS.sec; }
    }
    const buf = await window.__off.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const N = buf.length, W = 4410;    // 100ms windows
    const rms = [];
    let peak = 0;
    for (let w = 0; w + W <= N; w += W) {
      let e = 0;
      for (let i = w; i < w + W; i++) {
        const v = (L[i] + R[i]) / 2;
        e += v * v;
        const a = Math.abs(L[i]), b = Math.abs(R[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      rms.push(Math.sqrt(e / W));
    }
    const db = v => v > 0 ? 20 * Math.log10(v) : -120;
    // band-split with one-pole IIRs: "the drop hits harder" lives in the
    // LOW band (kick + offbeat bass) and the HIGH band (hats + open saws),
    // not in flat RMS — sustained pads dominate flat RMS and mislead
    const kLo = 1 - Math.exp(-2 * Math.PI * 150 / 44100);
    const kHi = 1 - Math.exp(-2 * Math.PI * 2000 / 44100);
    let lo = 0, hi = 0;
    const rmsLo = [], rmsHi = [];
    for (let w = 0; w + W <= N; w += W) {
      let eLo = 0, eHi = 0;
      for (let i = w; i < w + W; i++) {
        const v = (L[i] + R[i]) / 2;
        lo += kLo * (v - lo);
        hi += kHi * (v - hi);
        eLo += lo * lo;
        const h = v - hi;
        eHi += h * h;
      }
      rmsLo.push(Math.sqrt(eLo / W));
      rmsHi.push(Math.sqrt(eHi / W));
    }
    const avgB = (arr, a, b) => {
      let s2 = 0, n = 0;
      for (let i = Math.floor(a / 0.1); i < Math.floor(b / 0.1); i++) { s2 += arr[i]; n++; }
      return s2 / n;
    };
    // energy by phase
    const avg = (a, b) => {
      let s = 0, n = 0;
      for (let i = Math.floor(a / 0.1); i < Math.floor(b / 0.1); i++) { s += rms[i]; n++; }
      return s / n;
    };
    // dropouts are judged on the GROOVE span (build start → break start):
    // a breakdown is supposed to breathe, and the ear integrates ~200ms, so
    // a dropout = two consecutive quiet 100ms windows, not one
    const grooveStart = marks.length ? marks[0].t : 10;
    const grooveEnd = (marks.find(m => m.sec === 'break') || { t: 53 }).t;
    let minWin = 1e9, minAt = 0, dropouts = 0;
    const dips = [];
    for (let i = Math.floor(grooveStart / 0.1); i < Math.floor(grooveEnd / 0.1) - 1; i++) {
      if (rms[i] < minWin) { minWin = rms[i]; minAt = i * 0.1; }
      if (i + 2 < Math.floor(grooveEnd / 0.1) &&
          db(rms[i]) < -44 && db(rms[i + 1]) < -44 && db(rms[i + 2]) < -44) dropouts++;
      dips.push([i * 0.1, rms[i]]);
    }
    dips.sort((a, b) => a[1] - b[1]);
    const worst = dips.slice(0, 6).map(d => ({ t: +d[0].toFixed(1), db: +db(d[1]).toFixed(1) }));
    // 1-second RMS trace so the arrangement's shape is visible in a terminal
    const trace = [];
    for (let sec2 = 0; sec2 < 58; sec2++) trace.push(+db(avg(sec2, sec2 + 1)).toFixed(0));
    // seam continuity: RMS just before vs just after each section change
    const seams = marks.map(m => {
      const i = Math.floor(m.t / 0.1);
      const pre = avg(Math.max(0, m.t - 1.2), m.t);
      const post = avg(m.t, m.t + 1.2);
      return { sec: m.sec, t: +m.t.toFixed(1), preDb: +db(pre).toFixed(1), postDb: +db(post).toFixed(1) };
    });

    // write the excerpt as 16-bit WAV so humans can judge the vibe
    const pcm = new DataView(new ArrayBuffer(44 + N * 4));
    const wr = (o, s2) => { for (let i = 0; i < s2.length; i++) pcm.setUint8(o + i, s2.charCodeAt(i)); };
    wr(0, 'RIFF'); pcm.setUint32(4, 36 + N * 4, true); wr(8, 'WAVEfmt ');
    pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 2, true);
    pcm.setUint32(24, 44100, true); pcm.setUint32(28, 44100 * 4, true);
    pcm.setUint16(32, 4, true); pcm.setUint16(34, 16, true);
    wr(36, 'data'); pcm.setUint32(40, N * 4, true);
    for (let i = 0; i < N; i++) {
      pcm.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, L[i] * 32767)), true);
      pcm.setInt16(46 + i * 4, Math.max(-32768, Math.min(32767, R[i] * 32767)), true);
    }
    let bin = '';
    const bytes = new Uint8Array(pcm.buffer);
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return {
      wav: btoa(bin),
      peak: +peak.toFixed(3),
      minWinDb: +db(minWin).toFixed(1), minAt: +minAt.toFixed(1), dropouts,
      calmDb: +db(avg(2, 8)).toFixed(1),
      buildDb: +db(avg(20, 26)).toFixed(1),
      dropDb: +db(avg(30, 44)).toFixed(1),
      calmLo: +db(avgB(rmsLo, 2, 8)).toFixed(1), dropLo: +db(avgB(rmsLo, 30, 44)).toFixed(1),
      calmHi: +db(avgB(rmsHi, 2, 8)).toFixed(1), dropHi: +db(avgB(rmsHi, 30, 44)).toFixed(1),
      seams, worst, trace,
    };
  });

  await browser.close();
  server.kill();

  fs.mkdirSync(OUT, { recursive: true });
  const wavPath = path.join(OUT, 'music-excerpt.wav');
  fs.writeFileSync(wavPath, Buffer.from(res.wav, 'base64'));
  console.log('\nwrote ' + wavPath + ' (' + (fs.statSync(wavPath).size / 1e6).toFixed(1) + ' MB, 62s)');
  console.log('sections hit: ' + res.seams.map(s => s.sec + '@' + s.t + 's').join(' → '));
  console.log('rms/sec: ' + res.trace.join(' '));
  console.log('worst windows: ' + res.worst.map(w => w.t + 's ' + w.db + 'dB').join(' · '));
  console.log('levels: calm ' + res.calmDb + ' dB · build ' + res.buildDb + ' dB · drop ' + res.dropDb + ' dB');
  console.log('peak sample ' + res.peak + ' · quietest 100ms window ' + res.minWinDb + ' dB at ' + res.minAt + 's');
  for (const s of res.seams)
    console.log('  seam → ' + s.sec.padEnd(6) + ' at ' + s.t + 's: ' + s.preDb + ' dB → ' + s.postDb + ' dB');

  assert(res.peak < 1.0, 'no clipping (peak ' + res.peak + ')');
  assert(res.dropouts === 0, 'the music never stops in the groove: ' + res.dropouts + ' spans of 300ms below -44 dB (quietest 100ms: ' + res.minWinDb + ' dB at ' + res.minAt + 's — sidechain troughs are expected)');
  console.log('bands: low calm ' + res.calmLo + ' → drop ' + res.dropLo +
    ' dB · high calm ' + res.calmHi + ' → drop ' + res.dropHi + ' dB');
  assert(res.dropLo > res.calmLo + 4, 'the drop floor hits: low band +' + (res.dropLo - res.calmLo).toFixed(1) + ' dB over calm (need +4)');
  assert(res.dropHi > res.calmHi - 1, 'the drop keeps its air: high band ' + (res.dropHi - res.calmHi).toFixed(1) + ' dB vs calm (must not be duller than -1)');
  let seamOk = true;
  for (const s of res.seams)
    if (Math.abs(s.postDb - s.preDb) > 12 && s.sec !== 'drop') seamOk = false;
  assert(seamOk, 'section seams stay within 12 dB (no cut-outs at transitions)');
  assert(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  if (failures) { console.log('\n' + failures + ' MUSIC CHECK(S) FAILED'); process.exit(1); }
  console.log('\nALL MUSIC CHECKS PASSED');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
