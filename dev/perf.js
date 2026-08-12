/* =========================================================================
   PERF HARNESS — measure before optimizing.

   Boots the real client in Chromium, drives it into representative scenes,
   and times the actual update()/render() paths plus a CPU profile so the
   expensive functions name themselves instead of being guessed at.

     node dev/perf.js              # all scenes
     node dev/perf.js --profile    # + per-function self time
     node dev/perf.js --json out   # write raw numbers for A/B comparison
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// playwright lives in the global prefix, not in this zero-dependency repo
const GLOBAL_MODULES = require('child_process')
  .execSync('npm root -g', { encoding: 'utf8' }).trim();
Module.globalPaths.push(GLOBAL_MODULES);
const { chromium } = require(path.join(GLOBAL_MODULES, 'playwright'));

const PORT = parseInt(process.env.PERF_PORT || '8781', 10);
const WANT_PROFILE = process.argv.includes('--profile');
const jsonIdx = process.argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null;
const ROOT = path.join(__dirname, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// scenes: each returns a short label after arranging the world
const SCENES = [
  {
    key: 'frontier',
    what: 'open space — the common case, drifting the endless map',
    setup: `
      A.G.qualLock = true;
      A.newSoloWorld(20260812);   // pinned: same world every run, so A/B means something
      A.G.pendingMode = 'ffa';
      A.startSolo('corsair');
      A.G.player.x = A.SIM.WORLD * 0.5; A.G.player.y = A.SIM.WORLD * 0.5;
    `,
  },
  {
    key: 'brawl',
    what: '14 ships in one screen, particles saturated',
    setup: `
      A.G.qualLock = true;
      A.newSoloWorld(20260812);   // pinned: same world every run, so A/B means something
      A.G.pendingMode = 'ffa';
      A.startSolo('corsair');
      const W = A.G.W, p = A.G.player;
      for (let i = 0; i < 14; i++) {
        const b = A.SIM.makeShip(W, A.SIM.pick(A.SIM.SHIP_ORDER), 'bot', 'perf' + i, null, 1 + (i % 4));
        A.SIM.spawnShip(W, b);
        b.x = p.x + Math.cos(i) * 420; b.y = p.y + Math.sin(i) * 420;
        b.ai.skill = 0.8;
      }
      // saturate the particle pool the way a real firefight does
      for (let i = 0; i < 60; i++) A.SIM.updateWorld(W, A.STEP);
    `,
  },
  {
    key: 'capital',
    what: 'parked under a carrier — the heaviest single sprite',
    setup: `
      A.G.qualLock = true;
      A.newSoloWorld(20260812);   // pinned: same world every run, so A/B means something
      A.G.pendingMode = 'ffa';
      A.startSolo('corsair');
      const W = A.G.W, c = W.capitals[0];
      A.G.player.x = c.x + 260; A.G.player.y = c.y;
      A.G.cam.x = A.G.player.x; A.G.cam.y = A.G.player.y;
    `,
  },
];

function startServer() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BOTS: '6' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => { });
  p.stderr.on('data', d => process.stderr.write('[server] ' + d));
  return p;
}

async function run() {
  const server = startServer();
  await sleep(900);
  const browser = await chromium.launch({
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      // Canvas2D defers rasterization, so timing draw calls in a loop measures
      // command recording, not pixels. Unthrottling the compositor instead
      // lets real presented frame rate be the metric — that one cannot lie.
      '--disable-gpu-vsync', '--disable-frame-rate-limit',
    ],
  });
  const results = {};
  try {
    for (const scene of SCENES) {
      for (const view of [{ w: 1600, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'mobile' }]) {
        const page = await browser.newPage({ viewport: { width: view.w, height: view.h } });
        const errs = [];
        page.on('pageerror', e => errs.push(String(e)));
        await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
        await page.waitForFunction('!!window.__interstellar');
        await page.evaluate(`const A = window.__interstellar; ${scene.setup}`);
        await sleep(250);

        const cdp = WANT_PROFILE ? await page.context().newCDPSession(page) : null;
        if (cdp) {
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
          await cdp.send('Profiler.start');
        }

        const timings = await page.evaluate(async () => {
          const A = window.__interstellar;
          // let the real rAF loop run and time the frames it actually presents
          const measure = ms => new Promise(res => {
            const gaps = [];
            let prev = performance.now(), t0 = prev;
            const tick = now => {
              gaps.push(now - prev); prev = now;
              if (now - t0 < ms) requestAnimationFrame(tick);
              else res(gaps.slice(4));           // drop warm-up frames
            };
            requestAnimationFrame(tick);
          });
          await measure(500);                    // settle
          const gaps = await measure(3000);
          gaps.sort((a, b) => a - b);
          const at = q => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))];
          const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
          return {
            frame: mean, fps: 1000 / mean, p50: at(0.5), p95: at(0.95),
            frames: gaps.length,
            ships: A.G.W.ships.length, parts: A.G.parts.length,
            bullets: A.G.W.bullets.length, qual: A.G.qual,
          };
        });

        let hot = null;
        if (cdp) {
          const { profile } = await cdp.send('Profiler.stop');
          hot = topFunctions(profile, 12);
        }

        const tag = scene.key + '/' + view.tag;
        results[tag] = { timings, hot, what: scene.what };
        report(tag, scene.what, timings, hot, errs);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
    console.log('\nwrote ' + JSON_OUT);
  }
  return results;
}

// fold a CDP profile into self-time per function
function topFunctions(profile, n) {
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const self = new Map();
  const total = profile.samples.length || 1;
  for (const id of profile.samples) {
    const node = byId.get(id);
    if (!node) continue;
    const f = node.callFrame;
    const name = (f.functionName || '(anonymous)') +
      (f.url ? ' ' + f.url.replace(/^.*\//, '') + ':' + (f.lineNumber + 1) : '');
    self.set(name, (self.get(name) || 0) + 1);
  }
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, hits]) => ({ name, pct: +(hits * 100 / total).toFixed(1) }));
}

function report(tag, what, t, hot, errs) {
  console.log('\n=== ' + tag + ' — ' + what);
  console.log('  ' + t.fps.toFixed(1) + ' fps   frame ' + t.frame.toFixed(2) +
    ' ms   p50 ' + t.p50.toFixed(2) + '   p95 ' + t.p95.toFixed(2) +
    '   (' + t.frames + ' frames)');
  console.log('  world: ' + t.ships + ' ships, ' + t.bullets + ' bullets, ' + t.parts + ' particles, qual ' + t.qual);
  if (errs.length) console.log('  PAGE ERRORS: ' + errs.slice(0, 3).join(' | '));
  if (hot) for (const h of hot) console.log('    ' + String(h.pct).padStart(5) + '%  ' + h.name);
}

run().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
