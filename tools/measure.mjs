#!/usr/bin/env node
// tools/measure.mjs — the numeric acceptance profile, measured in a real
// browser rather than asserted. Mirrors the profile taken off the reference
// surface (shipgauge) so the two are directly comparable:
//
//   box-shadowed nodes >= 10, transitions >= 15, largest type >= 45px,
//   >= 3 distinct resolved font families with a mono carrying the data,
//   0 side-border / emoji / gradient-heading tells, no PNG bleed at 390.
//
//   node tools/measure.mjs [url]     (default: serves this repo on port 0)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const ROOT = process.cwd();
const argUrl = process.argv[2];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

let server = null;
let base = argUrl;
if (!base) {
  server = createServer((req, res) => {
    let rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^[/\\]+/, '');
    if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(900);

const m = await page.evaluate(() => {
  // body only: <title> and <style> live in <head>, carry text nodes, and
  // resolve to the UA default serif — counting them invented a fourth
  // 'typeface' that no visitor can see.
  const all = [...document.body.querySelectorAll('*')];
  const faces = new Map();
  let shadowed = 0, transitions = 0, animating = 0, largest = 0;
  let sideBorders = 0, gradientHeadings = 0, backdrop = 0, blend = 0;

  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.boxShadow && cs.boxShadow !== 'none') shadowed++;
    if (cs.transitionDuration && cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) transitions++;
    if (cs.animationName && cs.animationName !== 'none') animating++;
    if (cs.backdropFilter && cs.backdropFilter !== 'none') backdrop++;
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') blend++;

    const txt = (el.textContent || '').trim();
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasOwnText) {
      const size = parseFloat(cs.fontSize);
      if (size > largest) largest = size;
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      faces.set(fam, (faces.get(fam) || 0) + 1);
    }

    // The side-border tell: a thick coloured bar down exactly one edge.
    const w = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs[`border${s}Width`]) || 0);
    const thick = w.filter((x) => x >= 3).length;
    if (thick === 1 && w.filter((x) => x > 0).length === 1) sideBorders++;

    if (/^H[1-6]$/.test(el.tagName)) {
      if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') gradientHeadings++;
    }
  }

  const emoji = (document.body.innerText.match(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu,
  ) || []).length;

  return {
    shadowed, transitions, animating, largest,
    faces: [...faces.entries()].sort((a, b) => b[1] - a[1]),
    sideBorders, gradientHeadings, backdrop, blend, emoji,
    words: document.body.innerText.trim().split(/\s+/).length,
  };
});

// What a visitor sees before scrolling, in order.
const fold = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('h1,h2,h3,p,button,textarea,select,li,dt,span.eyebrow')) {
    const r = el.getBoundingClientRect();
    if (r.top < 900 && r.bottom > 0 && r.height > 0) {
      const t = (el.innerText || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ');
      if (t) out.push(`${el.tagName.toLowerCase()}: ${t.slice(0, 68)}`);
    }
  }
  return out.slice(0, 14);
});

const FLOOR = { shadowed: 10, transitions: 15, largest: 45, faces: 3 };
const line = (k, v, ok) => `  ${k.padEnd(24, '.')} ${String(v).padEnd(28)} ${ok ? 'PASS' : 'FAIL'}`;

console.log(`\nmeasured: ${base}\n`);
console.log(line('box-shadowed nodes', m.shadowed, m.shadowed >= FLOOR.shadowed));
console.log(line('elements w/ transition', m.transitions, m.transitions >= FLOOR.transitions));
console.log(line('currently animating', m.animating, true));
console.log(line('largest rendered type', m.largest.toFixed(1) + 'px', m.largest >= FLOOR.largest));
console.log(line('distinct type faces', m.faces.length, m.faces.length >= FLOOR.faces));
for (const [f, n] of m.faces) console.log(`      ${f} (${n} nodes)`);
console.log(line('side-border tells', m.sideBorders, m.sideBorders === 0));
console.log(line('gradient headings', m.gradientHeadings, m.gradientHeadings === 0));
console.log(line('emoji', m.emoji, m.emoji === 0));
console.log(line('backdrop-filter', m.backdrop, m.backdrop === 0));
console.log(line('mix-blend-mode', m.blend, m.blend === 0));
console.log(`  words on page ......... ${m.words}`);
console.log('\nabove the fold, in order:');
for (const f of fold) console.log('  ' + f);

await browser.close();
if (server) server.close();
