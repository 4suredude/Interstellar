/* =========================================================================
   VISUAL REGRESSION — assertions a headless sim test cannot make.

   The sim suite runs without a canvas, so it never sees the art. These
   checks bake the real sprites in Chromium and inspect the pixels, which is
   how a silhouette bug hides: capitals were trailing lit grey discs off the
   stern for weeks because nothing looked at the atlas.

     node dev/visual.js
   ========================================================================= */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const Module = require('module');

const GLOBAL_MODULES = execSync('npm root -g', { encoding: 'utf8' }).trim();
Module.globalPaths.push(GLOBAL_MODULES);
const { chromium } = require(path.join(GLOBAL_MODULES, 'playwright'));

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.VIS_PORT || '8802', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function assert(cond, msg) {
  if (cond) return true;
  failures++;
  console.log('FAIL  ' + msg);
  return false;
}
// a block's OK line only prints if the block's own asserts all held
function okIf(since, msg) { if (failures === since) console.log('OK  ' + msg); }

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BOTS: '2' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(1000);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
    await page.waitForFunction('!!window.__interstellar');

    // ---- hull silhouettes: nothing lit may float outside the hull ----
    const spill = await page.evaluate(() => {
      const A = window.__interstellar;
      const out = [];
      for (const kind of Object.keys(A.SIM.CAPITALS)) {
        const spr = A.bake.capitalSprite(kind, 200);
        const cell = spr.cell;
        const g = spr.c.getContext('2d');
        const d = g.getImageData(0, 0, cell, cell).data;
        // The hull is a unit polygon, baked nose-right at scale bakeR*1.5 about
        // the cell centre with no rotation, so a pixel maps straight back into
        // unit space. Test against the POLYGON, not a bounding circle: a
        // wide-winged hull has a large circumscribed radius, and a circular
        // tolerance quietly swallows spill anywhere off the wingtips.
        const t = A.SIM.CAPITALS[kind];
        const scale = Math.min(t.radius, 132) * 1.5;
        const c0 = cell / 2;
        const GROW = 1.07;                           // allowance for the bevel blur
        const inHull = (u, v) => {
          u /= GROW; v /= GROW;
          let inside = false;
          const P = t.shape;
          for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
            const xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1];
            if ((yi > v) !== (yj > v) &&
                u < (xj - xi) * (v - yi) / (yj - yi || 1e-9) + xi) inside = !inside;
          }
          return inside;
        };
        let worst = 0, n = 0;
        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            const a = d[(y * cell + x) * 4 + 3];
            if (a < 48) continue;                    // ignore the soft antialias fringe
            const u = (x - c0) / scale, v = (y - c0) / scale;
            if (!inHull(u, v)) { n++; worst = Math.max(worst, Math.hypot(u, v)); }
          }
        }
        out.push({ kind, stray: n, worst: +worst.toFixed(2), cell });
      }
      return out;
    });
    // Some legitimate art (accent panels, deco plating) sits just outside the
    // base hull polygon, so a nonzero count is normal — it tops out around 180
    // px and never reaches past 0.7 of unit radius. Real spill is an order of
    // magnitude bigger AND lands out past the transom near 1.0+, so the two
    // signals together separate the cases with room to spare.
    let mark = failures;
    for (const s of spill) {
      assert(s.stray < 400 && s.worst < 0.9,
        s.kind + ': ' + s.stray + ' lit pixels outside the hull, reaching ' +
        s.worst + ' of unit radius — sprite bake is spilling past the silhouette');
    }
    okIf(mark, 'capital silhouettes clean: ' +
      spill.map(s => s.kind + ' ' + s.stray + 'px@' + s.worst).join(', '));

    // ---- a capital being drawn cannot be evicted by fighter churn ----
    const evict = await page.evaluate(() => {
      const A = window.__interstellar;
      const before = A.bake.capitalSprite('dreadnought', 96);
      // simulate a hue-diverse zone: far more fighter atlases than the cache
      // holds, while the boss keeps being fetched the way drawCapital does
      for (let i = 0; i < 80; i++) {
        A.bake.shipAtlas('corsair', (i * 7) % 360, 1);
        A.bake.capitalSprite('dreadnought', 96);
      }
      const after = A.bake.capitalSprite('dreadnought', 96);
      return { survived: before === after };
    });
    mark = failures;
    assert(evict.survived,
      'a capital sprite fetched every frame was evicted by fighter atlas churn and re-baked');
    okIf(mark, 'hot capital sprites survive atlas cache churn');

    // ---- the contract board offers three DIFFERENT things to do ----
    const board = await page.evaluate(() => {
      const A = window.__interstellar;
      const dupes = [];
      for (let trial = 0; trial < 60; trial++) {
        A.G.contracts = [];
        A.G.zoneTeam = trial % 2 ? 1 : 0;
        A.contracts.init();
        const kinds = A.G.contracts.map(c => c.k);
        if (new Set(kinds).size !== kinds.length) dupes.push(kinds.join('+'));
      }
      return { dupes, sample: A.G.contracts.map(c => c.k) };
    });
    mark = failures;
    assert(board.dupes.length === 0,
      'contract board handed out duplicates in ' + board.dupes.length +
      '/60 rolls (e.g. ' + board.dupes[0] + ')');
    okIf(mark, 'contract board always offers three distinct objectives');

    // ---- the scenery buffer exists and the frame paints something ----
    const frame = await page.evaluate(() => {
      const A = window.__interstellar;
      A.G.qual = 2; A.G.qualLock = true;
      A.G.pendingMode = 'ffa';
      A.startSolo('corsair');
      A.render();
      const cv = document.getElementById('game');
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
      return { lit, sampled: Math.floor(d.length / (4 * 97)) };
    });
    mark = failures;
    assert(frame.lit > frame.sampled * 0.02,
      'rendered frame is nearly black (' + frame.lit + '/' + frame.sampled + ' lit samples)');
    okIf(mark, 'a rendered frame has a visible scene in it');

    assert(errs.length === 0, 'page errors: ' + errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  if (failures) {
    console.log('\n' + failures + ' VISUAL CHECK(S) FAILED');
    process.exit(1);
  }
  console.log('\nALL VISUAL CHECKS PASSED');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
