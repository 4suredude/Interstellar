/* Build the single-file distribution: interstellar.html
   Inlines sim.js and client.js into index.html so the game is ONE file —
   nothing to sit beside it, nothing to fail loading. node dev/build.js */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = name => {
  const src = fs.readFileSync(path.join(ROOT, name), 'utf8')
    .replace(/<\/script/gi, '<\\/script');   // keep inline HTML parsing safe
  return '<script>\n/* ==== inlined ' + name + ' ==== */\n' + src + '\n</script>';
};

const out = html
  .replace(/<script src="sim\.js"[^>]*><\/script>/, () => inline('sim.js'))
  .replace(/<script src="client\.js"[^>]*><\/script>/, () => inline('client.js'));

if (out.includes('src="sim.js"') || out.includes('src="client.js"')) {
  console.error('build failed: script tags not replaced');
  process.exit(1);
}
fs.writeFileSync(path.join(ROOT, 'interstellar.html'), out);
console.log('built interstellar.html (' + (out.length / 1024 | 0) + ' KB) — one file, runs anywhere');
