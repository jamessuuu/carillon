// tools/contrast-gradients.mjs — score the nodes tools/contrast.mjs refuses to.
//
// A gradient background has no single colour, so a general checker correctly
// declines to score text on one. But "unmeasurable" is not "fine": it just
// moves the question. This answers it the only honest way — by flattening
// each gradient to its WORST stop (the one closest in luminance to the text)
// and measuring that. If the worst case passes, every point of the gradient
// passes.
//
// The two gradients on carillon:
//   .rig            linear-gradient(180deg, --sub-2 0%, --sub-1 42%)
//                   worst for light text = the LIGHTEST stop, --sub-2
//   button.primary  linear-gradient(180deg, #f7c85c, #f0b429) with #2a1c02 text
//                   worst for dark text = the DARKEST stop, #f0b429
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const ROOT = process.cwd();
const argUrl = process.argv[2];

let server = null;
let base = argUrl;
if (!base) {
  const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript' };
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(900);

// Replace each gradient with its worst-case stop, as a flat colour.
await page.addStyleTag({
  content: `
    .rig { background-image: none !important; background-color: #161a24 !important; }
    button.primary { background-image: none !important; background-color: #f0b429 !important; }
  `,
});
await page.waitForTimeout(200);

const rows = await page.evaluate(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own.length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r0 = el.getBoundingClientRect();
    if (!r0.width || !r0.height) continue;

    let bg = null, gradient = false, node = el;
    while (node && node !== document.documentElement.parentNode) {
      const ncs = getComputedStyle(node);
      if (ncs.backgroundImage && ncs.backgroundImage !== 'none') { gradient = true; break; }
      const c = parse(ncs.backgroundColor);
      if (c && c.a > 0) { bg = bg === null ? c : over(bg, c); if (bg.a >= 1) break; }
      node = node.parentElement;
    }
    if (gradient || !bg) continue;
    const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const fg = parse(cs.color); if (!fg) continue;
    const eff = fg.a < 1 ? over(fg, bg) : fg;
    const rr = ratio(eff, bg);
    out.push({
      ratio: Math.round(rr * 100) / 100, need, size,
      tag: el.tagName.toLowerCase(),
      text: own.map((n) => n.textContent).join(' ').trim().replace(/\s+/g, ' ').slice(0, 46),
      pass: rr >= need,
    });
  }
  return out;
});

const TARGETS = ['demo trace', 'key', 'Start sound', 'notes', 'corrections', 'avg', 'Sound is off', '34', '2', '175', 'The instrument'];
const shown = rows.filter((r) => TARGETS.some((t) => r.text.startsWith(t)));
console.log('\nformerly-unmeasurable nodes, scored against their WORST gradient stop:\n');
for (const r of shown.sort((a, b) => a.ratio - b.ratio)) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${String(r.ratio).padStart(6)}:1  need ${r.need}  ${String(Math.round(r.size)).padStart(2)}px  <${r.tag}>  "${r.text}"`);
}
const fails = shown.filter((r) => !r.pass);
console.log(`\n${fails.length} failure(s) among the gradient-backed nodes`);
await browser.close();
if (server) server.close();
process.exit(fails.length === 0 ? 0 : 1);
