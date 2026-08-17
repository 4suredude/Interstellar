/* =========================================================================
   MOBILE AUDIT — how much of the FIGHT does the HUD cover?

   "Nothing overflows the screen" is not the same as "you can see the
   fight". This renders one frame twice — world only, then world + HUD —
   diffs the pixels to get the HUD's true occlusion mask, and reports what
   fraction of the combat ring around your ship is blind, per octant.

   In a top-down game the camera centres your ship, so an octant that is
   heavily occluded is a direction you cannot see enemies coming from.

     node dev/mobile-audit.js
   ========================================================================= */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const Module = require('module');

const GM = execSync('npm root -g', { encoding: 'utf8' }).trim();
Module.globalPaths.push(GM);
const { chromium } = require(path.join(GM, 'playwright'));

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.AUDIT_PORT || '8818', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEWS = [
  { tag: 'landscape', w: 874, h: 402 },
  { tag: 'portrait', w: 402, h: 874 },
  { tag: 'landscape-small', w: 740, h: 360 },
];

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  OK   ' + msg); return; }
  failures++;
  console.log('  FAIL ' + msg);
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BOTS: '4' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(900);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const out = {};
  try {
    for (const v of VIEWS) {
      const ctx0 = await browser.newContext({
        viewport: { width: v.w, height: v.h }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
      });
      const page = await ctx0.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));
      await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
      await page.waitForFunction('!!window.__interstellar');
      await page.evaluate(`
        const A = window.__interstellar;
        A.G.qual = 2; A.G.qualLock = true;
        A.G.pendingMode = 'ffa';
        const me = A.startSolo('hornet');
        me.energy = me.maxEnergy;
        // a boss in range so the hull bar is on screen — worst realistic case
        const b = A.G.W.capitals.find(c => c.boss && !c.dead);
        if (b) { me.x = b.x + 900; me.y = b.y; }
      `);
      await page.touchscreen.tap(v.w * 0.2, v.h * 0.7);     // arm the touch UI
      await sleep(1400);

      const measure = () => page.evaluate(() => {
        const A = window.__interstellar;
        const cv = document.getElementById('game');
        const g = cv.getContext('2d');
        const dpr = cv.width / cv.clientWidth;
        const W = cv.width, H = cv.height;
        // render the frame in two halves and diff: what the HUD paints over
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        A.phases.backdrop();
        A.phases.world();
        const before = g.getImageData(0, 0, W, H).data;
        A.phases.hud();
        const after = g.getImageData(0, 0, W, H).data;

        const cx = W / 2, cy = H / 2;
        // the combat ring: near enough to matter, inside the viewport
        const rIn = 90 * dpr, rOut = Math.min(W, H) * 0.5;
        let ringTot = 0, ringHid = 0, allTot = 0, allHid = 0;
        const oct = Array.from({ length: 8 }, () => ({ t: 0, h: 0 }));
        for (let y = 0; y < H; y += 2) {
          for (let x = 0; x < W; x += 2) {
            const i = (y * W + x) * 4;
            const d = Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) +
                      Math.abs(after[i + 2] - before[i + 2]);
            const hid = d > 24;
            allTot++; if (hid) allHid++;
            const dx = x - cx, dy = y - cy, rr = Math.hypot(dx, dy);
            if (rr < rIn || rr > rOut) continue;
            ringTot++; if (hid) ringHid++;
            let a = Math.atan2(dy, dx) + Math.PI / 8;        // octant 0 = east
            if (a < 0) a += Math.PI * 2;
            const oi = Math.floor(a / (Math.PI / 4)) % 8;
            oct[oi].t++; if (hid) oct[oi].h++;
          }
        }
        // paint the occlusion mask so a human can SEE what is blocking
        const mask = document.createElement('canvas');
        mask.width = W; mask.height = H;
        const mg = mask.getContext('2d');
        const img = mg.createImageData(W, H);
        for (let i = 0; i < W * H; i++) {
          const j = i * 4;
          const d = Math.abs(after[j] - before[j]) + Math.abs(after[j + 1] - before[j + 1]) +
                    Math.abs(after[j + 2] - before[j + 2]);
          const on = d > 24;
          img.data[j] = on ? 255 : 12; img.data[j + 1] = on ? 40 : 12;
          img.data[j + 2] = on ? 40 : 12; img.data[j + 3] = 255;
        }
        mg.putImageData(img, 0, 0);
        // overlay the combat ring so the geometry is unmistakable
        mg.strokeStyle = '#0ff'; mg.lineWidth = 2;
        mg.beginPath(); mg.arc(cx, cy, rIn, 0, Math.PI * 2); mg.stroke();
        mg.beginPath(); mg.arc(cx, cy, rOut, 0, Math.PI * 2); mg.stroke();

        const names = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
        return {
          mask: mask.toDataURL('image/png'),
          screenPct: +(allHid / allTot * 100).toFixed(1),
          ringPct: +(ringHid / ringTot * 100).toFixed(1),
          oct: oct.map((o, i) => ({ dir: names[i], pct: +(o.h / Math.max(1, o.t) * 100).toFixed(0) })),
          vw: cv.clientWidth, vh: cv.clientHeight,
        };
      });

      // STEADY STATE: what you stare at for minutes at a time
      await page.evaluate('window.__interstellar.G.banner = null; window.__interstellar.G.msgs.length = 0;');
      const quiet = await measure();
      // WORST CASE: a full-width announcement over a boss engagement
      await page.evaluate(`
        const A = window.__interstellar;
        A.banner('ENTERING THE DEAD ZONE · A4', 'no law reaches this far', 9);
      `);
      await sleep(120);
      const busy = await measure();
      const res = quiet;
      out[v.tag] = { quiet, busy };
      if (process.env.AUDIT_MASK) {
        const fs2 = require('fs'), pp = require('path');
        fs2.writeFileSync(pp.join(process.env.AUDIT_MASK, 'mask-' + v.tag + '.png'),
          Buffer.from(quiet.mask.split(',')[1], 'base64'));
        fs2.writeFileSync(pp.join(process.env.AUDIT_MASK, 'mask-' + v.tag + '-busy.png'),
          Buffer.from(busy.mask.split(',')[1], 'base64'));
      }
      delete quiet.mask; delete busy.mask;
      const wq = quiet.oct.slice().sort((a, b) => b.pct - a.pct)[0];
      const wb = busy.oct.slice().sort((a, b) => b.pct - a.pct)[0];
      console.log('\n=== ' + v.tag + '  ' + res.vw + 'x' + res.vh);
      console.log('  steady : screen ' + quiet.screenPct + '%  ring ' + quiet.ringPct + '%  |  ' +
        quiet.oct.map(o => o.dir + ' ' + o.pct).join(' '));
      console.log('  + banner: screen ' + busy.screenPct + '%  ring ' + busy.ringPct + '%  |  ' +
        busy.oct.map(o => o.dir + ' ' + o.pct).join(' '));
      // Steady state is what you fly in; a banner is a 2-3s announcement, so
      // it gets a looser bar — but it must never wall off a direction.
      assert(quiet.ringPct < 12, 'steady combat ring clear (' + quiet.ringPct + '% hidden, want < 12%)');
      assert(wq.pct < 20, 'no blind direction at rest (worst ' + wq.dir + ' ' + wq.pct + '%, want < 20%)');
      assert(busy.ringPct < 20, 'ring survives an announcement (' + busy.ringPct + '%, want < 20%)');
      assert(wb.pct < 45, 'announcement never walls a direction (worst ' + wb.dir + ' ' + wb.pct + '%, want < 45%)');
      assert(errs.length === 0, 'no page errors');
      await ctx0.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (failures) { console.log('\n' + failures + ' MOBILE CHECK(S) FAILED'); process.exit(1); }
  console.log('\nALL MOBILE CHECKS PASSED');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
