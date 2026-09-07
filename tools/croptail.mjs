// tools/croptail.mjs — screenshot the part of the page BELOW the fold, so the
// lower sections get looked at rather than assumed. A full-page PNG of a long
// page is unreadable when scaled to fit; this clips a real window instead.
//
//   node tools/croptail.mjs <label> <width> <height> <scrollY>
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const ROOT = process.cwd();
const [label = 'tail', w = '1440', h = '900', y = '900'] = process.argv.slice(2);
mkdirSync(join(ROOT, 'docs'), { recursive: true });

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  let rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^[\/\\]+/, '');
  if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
  const f = join(ROOT, rel);
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': (TYPES[extname(f)] || 'text/plain') + '; charset=utf-8' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForTimeout(900);
// Open every disclosure: a section nobody screenshots is a section nobody checks.
await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
await page.evaluate((yy) => window.scrollTo(0, yy), Number(y));
await page.waitForTimeout(500);
const out = join(ROOT, 'docs', `${label}.png`);
await page.screenshot({ path: out });
console.log('wrote ' + out);
await browser.close();
server.close();
