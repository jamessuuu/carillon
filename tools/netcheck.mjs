// tools/netcheck.mjs — cross-check the page's own network self-audit against
// what the browser actually requested. The page claims "N requests since load"
// by reading its Performance timeline; this asserts that claim against
// Playwright's independent view of every request the page issued.
//
//   node tools/netcheck.mjs [url]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const ROOT = process.cwd();
const argUrl = process.argv[2];
let server = null;
let base = argUrl;

if (!base) {
  server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = normalize(raw).replace(/^[\/\\]+/, '');
    if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
    const f = join(ROOT, rel);
    if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) {
      res.writeHead(404); res.end('nf'); return;
    }
    const t = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' }[extname(f)] || 'text/plain';
    res.writeHead(200, { 'content-type': t + '; charset=utf-8' });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
const requests = [];
const cspViolations = [];
page.on('request', (r) => requests.push(r.url()));
page.on('console', (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text());
});
await page.goto(base, { waitUntil: 'load' });
const loadMark = requests.length;
await page.waitForTimeout(1800);

const chip = await page.textContent('#netChip');
const list = await page.textContent('#netList');
const after = requests.length - loadMark;

console.log('page reports "requests since load": ' + chip);
console.log('playwright observed after load:     ' + after);
console.log('\n--- the page\'s own resource list ---\n' + list);
console.log('\n--- every request playwright saw ---');
for (const r of requests) console.log('  ' + r.replace(/^https?:\/\/[^/]+/, ''));
const thirdParty = requests.filter((r) => !r.startsWith(new URL(base).origin));
console.log('\nthird-party origins: ' + thirdParty.length);
console.log('CSP violations: ' + cspViolations.length);
for (const v of cspViolations) console.log('  ' + v);

await browser.close();
if (server) server.close();

const ok = String(after) === String(chip).trim() && thirdParty.length === 0 && cspViolations.length === 0;
console.log('\n' + (ok ? 'OK — the page tells the truth about its own network activity' : 'MISMATCH'));
process.exit(ok ? 0 : 1);
