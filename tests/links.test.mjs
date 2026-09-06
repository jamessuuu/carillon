import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, classifyRef, extractRefs, isIgnored, readIgnoreList, scanSite } from '../check-links.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CHECK_SCRIPT = join(PROJECT_ROOT, 'check-links.mjs');

// carillon deploys its repo root trimmed by .vercelignore. A link that only
// resolves in the repo tree (the 2026-09-06 sweep found href="README.md"
// answering 404 live) is a dead link for every visitor. The deploy surface
// is modelled from .vercelignore, so what the checker calls "deployed" is
// what the live site serves.

test('the real site has zero deployed-link violations', () => {
  const violations = scanSite(SITE);
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
});

test('the app page links the README by its GitHub URL on the default branch, not by a repo path', () => {
  const html = readFileSync(join(PROJECT_ROOT, 'index.html'), 'utf8');
  const hrefs = extractRefs(html).filter((r) => r.attr === 'href').map((r) => r.value);
  assert.ok(hrefs.includes('https://github.com/jamessuuu/carillon/blob/main/README.md'));
  assert.ok(!hrefs.includes('README.md'));
});

test('README.md is excluded from the deploy surface, so a bare README.md href would be flagged not-deployed', () => {
  const ignore = readIgnoreList(join(PROJECT_ROOT, '.vercelignore'));
  assert.ok(isIgnored('README.md', ignore), '.vercelignore must list README.md');
  assert.ok(isIgnored('check-links.mjs', ignore), '.vercelignore must list check-links.mjs');
  assert.ok(!isIgnored('index.html', ignore));
  assert.ok(!isIgnored('src/app.mjs', ignore));
  assert.ok(!isIgnored('site/index.html', ignore));
});

test('the landing page may climb to the app page: ../index.html from site/ stays inside the deployed root', () => {
  const html = readFileSync(join(PROJECT_ROOT, 'site', 'index.html'), 'utf8');
  const hrefs = extractRefs(html).filter((r) => r.attr === 'href').map((r) => r.value);
  assert.ok(hrefs.includes('../index.html'));
  // and scanSite accepted it above: the output directory is the repo root.
});

test('extractRefs sees href/src/poster on any tag, decodes entities, and skips comments, script and style bodies', () => {
  const html = `
    <!-- <a href="../commented-out.md">not a link</a> -->
    <a href="a.html?x=1&amp;y=2">a</a>
    <img src='b.png'>
    <script type="module" src="src/app.mjs"></script>
    <script>const s = '<a href="../inside-script.md">';</script>
    <style>.x { background: url("../inside-style.png"); }</style>
  `;
  assert.deepEqual(extractRefs(html), [
    { tag: 'a', attr: 'href', value: 'a.html?x=1&y=2' },
    { tag: 'img', attr: 'src', value: 'b.png' },
    { tag: 'script', attr: 'src', value: 'src/app.mjs' },
  ]);
});

test('classifyRef separates fragments and non-http schemes (skip) from external URLs and local paths', () => {
  assert.equal(classifyRef('#top'), 'skip');
  assert.equal(classifyRef('data:,'), 'skip');
  assert.equal(classifyRef('mailto:x@y.z'), 'skip');
  assert.equal(classifyRef('https://agentjames.vercel.app'), 'external');
  assert.equal(classifyRef('README.md'), 'local');
  assert.equal(classifyRef('../index.html'), 'local');
});

function makeSyntheticSite() {
  const root = mkdtempSync(join(tmpdir(), 'carillon-links-'));
  mkdirSync(join(root, 'site'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# in the tree, kept off the deploy');
  writeFileSync(join(root, 'ok.html'), '<p>ok</p>');
  writeFileSync(join(root, 'tests', 'fixture.html'), '<a href="../nowhere.md">a page that is not deployed at all</a>');
  writeFileSync(join(root, '.vercelignore'), 'tests/\nREADME.md\n');
  writeFileSync(
    join(root, 'index.html'),
    [
      '<a href="README.md">not deployed</a>',
      '<a href="../outside.md">escapes</a>',
      '<a href="nope.html">missing</a>',
      '<a href="ok">clean-url ok</a>',
      '<a href="site">dir index ok</a>',
      '<a href="#top">fragment</a>',
      '<a href="https://example.com/anything">external, out of scope</a>',
      '<a href="https://github.com/jamessuuu/carillon/blob/main/does-not-exist.md">gh missing</a>',
      '<a href="https://github.com/jamessuuu/carillon/blob/not-the-default/README.md">gh wrong branch</a>',
      '<a href="https://github.com/jamessuuu/carillon/blob/main/README.md">gh ok</a>',
    ].join('\n'),
  );
  writeFileSync(join(root, 'site', 'index.html'), '<a href="../index.html">up to the app: inside the root, fine</a>');
  return root;
}

test('the rules bite on a synthetic site, and vercelignored pages are not scanned', () => {
  const root = makeSyntheticSite();
  try {
    const site = { ...SITE, repoRoot: root, outputDir: '.', build: null, ignoreFile: '.vercelignore' };
    const violations = scanSite(site);
    const byValue = Object.fromEntries(violations.map((v) => [v.value, v.rule]));
    assert.equal(byValue['README.md'], 'not-deployed');
    assert.equal(byValue['../outside.md'], 'escapes-output');
    assert.equal(byValue['nope.html'], 'missing-in-output');
    assert.equal(byValue['https://github.com/jamessuuu/carillon/blob/main/does-not-exist.md'], 'github-path');
    assert.equal(byValue['https://github.com/jamessuuu/carillon/blob/not-the-default/README.md'], 'github-path');
    assert.equal(violations.length, 5, JSON.stringify(violations, null, 2));
    assert.ok(violations.every((v) => v.page === 'index.html'), 'tests/fixture.html is vercelignored and must not be scanned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: check-links.mjs exits 0 on the real site and prints an OK line', () => {
  const result = spawnSync(process.execPath, [CHECK_SCRIPT], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-links: OK/);
});
