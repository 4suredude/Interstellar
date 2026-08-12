/* =========================================================================
   SCREENSHOTS — drive the real game in Chromium and capture the README art.

   Every shot is a real frame of the real client: no mockups, no compositing.
   Scenes arrange the world, let it run so the fight looks alive, then grab.

     node dev/shots.js            # write assets/*.png
     node dev/shots.js title hunt # only the named shots
     node dev/shots.js --out /tmp # somewhere else
   ========================================================================= */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const GLOBAL_MODULES = execSync('npm root -g', { encoding: 'utf8' }).trim();
Module.globalPaths.push(GLOBAL_MODULES);
const { chromium } = require(path.join(GLOBAL_MODULES, 'playwright'));

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.SHOT_PORT || '8795', 10);
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : path.join(ROOT, 'assets');
const only = argv.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DESKTOP = { width: 1440, height: 810 };
const PHONE = { width: 402, height: 874 };

// Each scene runs in the page with `A` = the client's test hook. `run` is the
// number of seconds of live simulation to let elapse before the grab, so
// engines are lit, bullets are in the air, and the music director has settled.
const SHOTS = [
  {
    name: 'title', view: DESKTOP, run: 2.5,
    setup: `A.G.state = 'title';`,
  },
  {
    name: 'select', view: DESKTOP, run: 0.6,
    setup: `A.G.state = 'select'; A.G.sel = 6;`,
  },
  {
    name: 'combat', view: DESKTOP, run: 3.0,
    setup: `
      A.G.pendingMode = 'ffa';
      const me = A.startSolo('corsair');
      // a real brawl: two rival wings converging on the player
      for (let i = 0; i < 9; i++) {
        const b = A.SIM.makeShip(A.G.W, A.SIM.pick(A.SIM.SHIP_ORDER), 'bot',
                                 A.SIM.pick(A.SIM.BOT_NAMES), null, 1 + (i % 3));
        A.SIM.spawnShip(A.G.W, b);
        const ang = i / 9 * Math.PI * 2;
        b.x = me.x + Math.cos(ang) * (170 + (i % 3) * 55);
        b.y = me.y + Math.sin(ang) * (170 + (i % 3) * 55);
        b.ai.skill = 0.85;
      }
      me.bombLevel = 3; me.gunLevel = 3;
    `,
  },
  {
    name: 'boss', view: DESKTOP, run: 3.0,
    // the dreadnought keeps station-keeping away from us; put the player back
    // on its bow for the grab and let one more frame settle the camera
    pre: `
      const b = window.__shotBoss;
      A.G.player.x = b.x + b.t.radius * 0.95; A.G.player.y = b.y + b.t.radius * 0.55;
      A.G.player.vx = 0; A.G.player.vy = 0; A.G.player.angle = Math.PI;
      A.G.cam.x = (A.G.player.x + b.x) / 2; A.G.cam.y = (A.G.player.y + b.y) / 2;
      for (const w of A.G.W.ships) {
        if (w === A.G.player || w.dead || w.marauder) continue;
        if (Math.hypot(w.x - b.x, w.y - b.y) > 1400) continue;
        w.x = b.x + b.t.radius * (0.8 + Math.random() * 0.7);
        w.y = b.y + b.t.radius * (Math.random() * 1.3 - 0.2);
      }
    `,
    setup: `
      A.G.pendingMode = 'ffa';
      const me = A.startSolo('titan');
      // park the player off a hostile capital's bow, mid-engagement
      const boss = A.G.W.capitals.find(c => c.boss && c.kind === 'dreadnought' && !c.dead)
                || A.G.W.capitals.find(c => c.boss && !c.dead) || A.G.W.capitals[0];
      window.__shotBoss = boss;
      me.x = boss.x + boss.t.radius + 150; me.y = boss.y - 40;
      A.G.cam.x = (me.x + boss.x) / 2; A.G.cam.y = (me.y + boss.y) / 2;
      for (let i = 0; i < 5; i++) {
        const w = A.SIM.makeShip(A.G.W, A.SIM.pick(A.SIM.SHIP_ORDER), 'bot',
                                 A.SIM.pick(A.SIM.BOT_NAMES), null, me.team || 1);
        A.SIM.spawnShip(A.G.W, w);
        w.x = boss.x + boss.t.radius + 190 + i * 40; w.y = boss.y + 90 - i * 45;
        w.ai.skill = 0.9;
      }
    `,
  },
  {
    name: 'contracts', view: DESKTOP, run: 1.2,
    setup: `
      A.G.pendingMode = 'ffa';
      A.startSolo('dagger');
      A.G.boardOpen = true;
    `,
  },
  {
    name: 'upgrades', view: DESKTOP, run: 1.2,
    setup: `
      A.G.pendingMode = 'ffa';
      A.startSolo('vanguard');
      A.G.credits = 8400; A.G.relics = 3;
      A.G.upgOpen = true;
    `,
  },
  {
    name: 'controls', view: DESKTOP, run: 1.0,
    setup: `
      A.G.pendingMode = 'ffa';
      A.startSolo('corsair');
      A.G.paused = true; A.G.ctlOpen = true; A.G.bindSel = 7;
    `,
  },
  {
    name: 'mobile', view: PHONE, run: 2.6, touch: true,
    // the virtual stick and weapon buttons only appear once a finger has
    // landed, so land one — the whole point of this shot is the touch layout
    tap: true,
    pre: `A.G.player.dead = false; A.G.player.energy = A.G.player.maxEnergy;
          A.G.banner = null; A.G.deathBy = '';`,
    setup: `
      A.G.pendingMode = 'ffa';
      const me = A.startSolo('hornet');
      // enough company to make the frame alive, not enough to kill the subject
      for (let i = 0; i < 3; i++) {
        const b = A.SIM.makeShip(A.G.W, A.SIM.pick(A.SIM.SHIP_ORDER), 'bot',
                                 A.SIM.pick(A.SIM.BOT_NAMES), null, 2);
        A.SIM.spawnShip(A.G.W, b);
        b.x = me.x + Math.cos(i * 2.1) * 300; b.y = me.y + Math.sin(i * 2.1) * 300;
        b.ai.skill = 0.45;
      }
    `,
  },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), BOTS: '8' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(1000);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const wanted = SHOTS.filter(s => !only.length || only.includes(s.name));
  try {
    for (const shot of wanted) {
      const ctx = await browser.newContext({
        viewport: shot.view,
        // 1.5x: still crisp on a retina display, but GitHub renders these
        // around 900px wide and a 2x set cost 5.5 MB in the repo
        deviceScaleFactor: 1.5,
        hasTouch: !!shot.touch,
        isMobile: !!shot.touch,
        reducedMotion: 'no-preference',
      });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));
      await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
      await page.waitForFunction('!!window.__interstellar');
      await page.evaluate(`const A = window.__interstellar; A.G.qual = 2; A.G.qualLock = true; ${shot.setup}`);
      // let the world actually run so the frame has life in it
      await sleep(shot.run * 1000);
      if (shot.tap) {
        const box = shot.view;
        await page.touchscreen.tap(box.width * 0.22, box.height * 0.78);
        await sleep(250);
      }
      // capitals are under way, so a subject framed at setup has sailed off
      // by now — re-anchor right before the grab
      if (shot.pre) await page.evaluate(`const A = window.__interstellar; ${shot.pre}`);
      // the opening tutorial lines have said their piece by now; a hero shot
      // wants the fight, not the onboarding text
      await page.evaluate('window.__interstellar.G.msgs.length = 0');
      await sleep(120);
      const file = path.join(OUT, shot.name + '.png');
      await page.screenshot({ path: file });
      const kb = (fs.statSync(file).size / 1024).toFixed(0);
      console.log('  ' + shot.name.padEnd(10) + kb.padStart(5) + ' KB   ' +
        shot.view.width + 'x' + shot.view.height + '@1.5x' +
        (errs.length ? '   PAGE ERRORS: ' + errs.slice(0, 2).join(' | ') : ''));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('\nwrote ' + wanted.length + ' shots to ' + OUT);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
