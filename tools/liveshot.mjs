// tools/liveshot.mjs — screenshot and exercise the DEPLOYED site. Local
// screenshots do not prove what shipped: production adds a CSP the dev
// server never sends.
//
//   node tools/liveshot.mjs <url>
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: liveshot.mjs <url>'); process.exit(1); }
const OUT = join(process.cwd(), 'docs');
mkdirSync(OUT, { recursive: true });

function pngSize(p) {
  const b = readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const browser = await chromium.launch();

for (const vp of [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
]) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1400);

  const f = join(OUT, `live-${vp.name}.png`);
  await page.screenshot({ path: f });
  const full = join(OUT, `live-${vp.name}-full.png`);
  await page.screenshot({ path: full, fullPage: true });
  const a = pngSize(f); const b = pngSize(full);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(
    `${vp.name}: scrollWidth=${sw} | fold png ${a.w}x${a.h} (=${a.w / 2}css) | FULL png ${b.w}x${b.h} (=${b.w / 2}css)` +
    (b.w / 2 > vp.width ? '  <<< BLED' : ''),
  );
  if (errs.length) console.log('  errors: ' + JSON.stringify(errs));
  await ctx.close();
}

// Exercise it: the demo trace must yield to a real keystroke.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(900);
const before = await page.textContent('#traceLabel');
const demoNotes = await page.$$eval('#plot .note', (n) => n.length);
await page.click('#typingArea');
for (const ch of 'carillon') {
  await page.keyboard.press(ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`);
  await page.waitForTimeout(90);
}
await page.waitForTimeout(400);
const after = await page.textContent('#traceLabel');
const liveNotes = await page.$$eval('#plot .note', (n) => n.length);
const readout = await page.textContent('#roInterval');
console.log(`\ntrace label: "${before.trim()}" -> "${after.trim()}"`);
console.log(`notes: ${demoNotes} (demo) -> ${liveNotes} (after typing 8 keys)`);
console.log(`readout interval now: ${readout}ms`);
await page.screenshot({ path: join(OUT, 'live-typed-1440x900.png') });

// And the reduced-motion contract.
const rm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const rp = await rm.newPage();
await rp.goto(url, { waitUntil: 'load' });
await rp.waitForTimeout(800);
const moving = await rp.evaluate(() =>
  [...document.body.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el);
    const dur = parseFloat(cs.animationDuration) || 0;
    return cs.animationName !== 'none' && dur > 0.01;
  }).length,
);
console.log(`under prefers-reduced-motion: ${moving} element(s) still animating > 10ms`);

await browser.close();
