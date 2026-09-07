#!/usr/bin/env node
// tools/contrast.mjs — WCAG 1.4.3 contrast, measured on the rendered page.
//
// project-gate has no contrast check at all (its a11y coverage is img-alt,
// button-names and target-size), so this dimension went unmeasured on every
// project in the batch. This closes it for carillon.
//
// Two things most contrast tools get wrong, both of which produce confident
// wrong answers here:
//
//  1. They read `background-color` only. carillon's primary button has
//     `background-color: rgba(0,0,0,0)` and gets its amber from a
//     `background-image` gradient. A background-color-only tool walks past
//     the gradient to the page ground and reports 1.19:1 — an invisible CTA
//     that is in fact perfectly legible. So: any ancestor carrying a
//     gradient makes the node UNMEASURABLE, and it is reported as such
//     rather than scored. An unmeasurable node is not a passing node and
//     not a failing one; it is a node a human has to look at.
//
//  2. They ignore alpha. A translucent layer over a dark ground has to be
//     composited before luminance means anything.
//
// Thresholds are WCAG 2.2 SC 1.4.3: 4.5:1 normal text, 3:1 for large text
// (>=24px, or >=18.66px when bold). Luminance is the sRGB formula from the
// spec, not a perceptual space — 1.4.3 is defined in sRGB and substituting
// oklch would change the verdict.
//
//   node tools/contrast.mjs [url]        measure
//   node tools/contrast.mjs --selftest   prove the checker can fail

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const args = process.argv.slice(2);
const selftest = args.includes('--selftest');
const argUrl = args.find((a) => !a.startsWith('--'));
const ROOT = process.cwd();

const PAGE_FN = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own.length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    // Composite the background by walking ancestors. A gradient anywhere in
    // the stack means the effective colour varies across the element and
    // cannot be reduced to one number.
    let bg = null;
    let gradient = false;
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const ncs = getComputedStyle(node);
      if (ncs.backgroundImage && ncs.backgroundImage !== 'none') { gradient = true; break; }
      const c = parse(ncs.backgroundColor);
      if (c && c.a > 0) {
        bg = bg === null ? c : over(bg, c);
        if (bg.a >= 1) break;
      }
      node = node.parentElement;
    }

    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const text = own.map((n) => n.textContent).join(' ').trim().replace(/\s+/g, ' ');

    if (gradient) {
      out.push({ unmeasurable: true, tag: el.tagName.toLowerCase(), size, text: text.slice(0, 54) });
      continue;
    }
    if (!bg) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const eff = fg.a < 1 ? over(fg, bg) : fg;
    const r = ratio(eff, bg);
    out.push({
      unmeasurable: false,
      ratio: Math.round(r * 100) / 100,
      need,
      size,
      weight,
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string' ? el.className : '').split(' ')[0],
      text: text.slice(0, 54),
      pass: r >= need,
    });
  }
  return out;
};

// ---- selftest: a fixture with known-good and known-bad, so a clean run on
// the real page means something. A checker that has never failed is not
// known to be able to.
const FIXTURE = `<!doctype html><meta charset="utf-8"><body style="background:#10131b;margin:0">
  <p id="bad"  style="color:#6d7688;font-size:11px">known bad, about 4.1</p>
  <p id="good" style="color:#eef1f7;font-size:11px">known good, about 14</p>
  <p id="grad" style="background-image:linear-gradient(#f7c85c,#f0b429);color:#2a1c02;font-size:14px">gradient, unmeasurable</p>
  <p id="alpha" style="color:rgba(238,241,247,0.25);font-size:11px">translucent, must fail</p>
</body>`;

const browser = await chromium.launch();

if (selftest) {
  const page = await browser.newPage();
  await page.setContent(FIXTURE);
  const rows = await page.evaluate(PAGE_FN);
  const by = (t) => rows.find((r) => r.text.startsWith(t));
  const bad = by('known bad');
  const good = by('known good');
  const grad = by('gradient');
  const alpha = by('translucent');
  const checks = [
    ['detects a failing pair', bad && !bad.unmeasurable && bad.pass === false && bad.ratio > 3.8 && bad.ratio < 4.4],
    ['detects a passing pair', good && good.pass === true && good.ratio > 12],
    ['refuses to score a gradient', grad && grad.unmeasurable === true],
    // #eef1f7 at full alpha on this ground is ~14:1 and passes easily. At
    // 0.25 alpha it composites to ~2.1:1 and fails. So a checker that
    // ignored alpha would score this node PASS; landing well under 4 is the
    // proof that the compositing actually happened.
    ['composites text alpha', alpha && alpha.pass === false && alpha.ratio < 4],
  ];
  let ok = true;
  for (const [name, res] of checks) {
    console.log(`  ${res ? 'PASS' : 'FAIL'}  ${name}`);
    if (!res) ok = false;
  }
  console.log(ok ? '\nselftest OK — the checker can both pass and fail' : '\nselftest FAILED');
  await browser.close();
  process.exit(ok ? 0 : 1);
}

let server = null;
let base = argUrl;
if (!base) {
  const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };
  server = createServer((req, res) => {
    let rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^[\/\\]+/, '');
    if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
    const f = join(ROOT, rel);
    if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': (TYPES[extname(f)] || 'text/plain') + '; charset=utf-8' });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(1000);
await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
await page.waitForTimeout(200);
const rows = await page.evaluate(PAGE_FN);

const fails = rows.filter((r) => !r.unmeasurable && !r.pass);
const unmeasurable = rows.filter((r) => r.unmeasurable);
const measured = rows.filter((r) => !r.unmeasurable);

console.log(`\nmeasured: ${base}`);
console.log(`${measured.length} text nodes scored, ${unmeasurable.length} on gradients (not scorable)\n`);
if (fails.length === 0) {
  console.log('  no WCAG 1.4.3 failures');
} else {
  for (const f of fails.sort((a, b) => a.ratio - b.ratio)) {
    console.log(
      `  ${String(f.ratio).padStart(5)}:1  need ${f.need}  ${String(Math.round(f.size)).padStart(2)}px  ` +
      `<${f.tag}${f.cls ? '.' + f.cls : ''}>  "${f.text}"`,
    );
  }
}
if (unmeasurable.length) {
  console.log(`\n  on gradients, look by eye (a background-color-only tool would score these WRONG):`);
  for (const u of unmeasurable) console.log(`    <${u.tag}> ${Math.round(u.size)}px  "${u.text}"`);
}
const worst = measured.filter((r) => r.pass).sort((a, b) => a.ratio - b.ratio)[0];
if (worst) console.log(`\n  closest passing: ${worst.ratio}:1 (need ${worst.need}) "${worst.text}"`);
console.log(`\n${fails.length} failure(s)`);

await browser.close();
if (server) server.close();
process.exit(fails.length === 0 ? 0 : 1);
