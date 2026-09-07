#!/usr/bin/env node
// tools/shoot.mjs — serve the repo on an ephemeral port and screenshot the app
// page at the two judged viewports. The port is chosen by the OS (port 0), never
// a fixed number: a fixed Playwright/dev port has twice caused a project to run
// its whole suite against a DIFFERENT project's site.
//
//   node tools/shoot.mjs <label>        e.g. `node tools/shoot.mjs before`
//
// Writes docs/<label>-1440x900.png and docs/<label>-390x844.png, then prints the
// real decoded PNG pixel width of each file — not scrollWidth, which reads clean
// even when an ambient gradient has bled the page sideways.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const ROOT = process.cwd();
const label = process.argv[2] || 'shot';
const OUT = join(ROOT, 'docs');
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = normalize(urlPath).replace(/^[/\\]+/, '');
  if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + rel);
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

// PNG width/height live at bytes 16..23 of the IHDR chunk. Reading them back
// off disk is the only way to know how wide the rendered page ACTUALLY was.
function pngSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log('serving on ' + base);

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));

  const foldPath = join(OUT, `${label}-${vp.name}.png`);
  await page.screenshot({ path: foldPath });
  const fullPath = join(OUT, `${label}-${vp.name}-full.png`);
  await page.screenshot({ path: fullPath, fullPage: true });

  const fold = pngSize(foldPath);
  const full = pngSize(fullPath);
  const dpr = 2;
  console.log(
    `${vp.name}: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} ` +
    `scrollHeight=${metrics.scrollHeight} | fold png ${fold.w}x${fold.h} (=${fold.w / dpr}css) ` +
    `| FULL png ${full.w}x${full.h} (=${full.w / dpr}css)` +
    (full.w / dpr > vp.width ? '  <<< PAGE BLED WIDER THAN VIEWPORT' : '')
  );
  if (errors.length) console.log('  page errors: ' + JSON.stringify(errors));
  await ctx.close();
}
await browser.close();
server.close();
