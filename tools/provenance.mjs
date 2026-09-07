#!/usr/bin/env node
// tools/provenance.mjs — compute the page's own numbers from the real artifacts
// and write them INTO index.html, at author time, never at run time.
//
// Why this exists: carillon's page states the mapping's bounds (40..900ms
// interval, 30..250ms dwell), the quantization target count, the filter sweep,
// and the size of the suite that checks all of it. Every one of those is a fact
// that lives in a source file, and a hand-typed copy of a fact drifts. The
// README already proved it: it claimed "37 tests" while the suite ran 59.
//
// So the numbers are READ from src/mapping.mjs and src/audio.mjs, and from an
// actual `node --test` run, then substituted into marked spans in index.html.
// tests/provenance.test.mjs then asserts the page and the modules still agree,
// which is what makes staleness a test failure instead of a slow embarrassment.
//
//   node tools/provenance.mjs           rewrite index.html + docs/provenance.json
//   node tools/provenance.mjs --check   fail if either is out of date
//
// A page that fetched this at run time could deploy green and render empty; a
// page that has it baked in cannot.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  SCALES,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_DWELL_MS,
  MAX_DWELL_MS,
  dwellToVelocity,
} from '../src/mapping.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const check = process.argv.includes('--check');

// The lowpass sweep is audio.mjs's, not mapping.mjs's: read it out of the
// source rather than restating it, so a change to the timbre updates the page.
function readCutoffSweep() {
  const audio = readFileSync(join(ROOT, 'src', 'audio.mjs'), 'utf8');
  const m = audio.match(/filter\.frequency\.value\s*=\s*lerp\(\s*(\d+)\s*,\s*(\d+)\s*,/);
  if (!m) throw new Error('provenance: could not read the lowpass sweep out of src/audio.mjs');
  return { lo: Number(m[1]), hi: Number(m[2]) };
}

function readDetune() {
  const audio = readFileSync(join(ROOT, 'src', 'audio.mjs'), 'utf8');
  const m = audio.match(/Math\.pow\(2,\s*(\d+)\s*\/\s*1200\)/);
  if (!m) throw new Error('provenance: could not read the chorus detune out of src/audio.mjs');
  return Number(m[1]);
}

function runSuite() {
  // The exact glob package.json's `npm test` uses. `--test tests/` is NOT
  // equivalent: it resolves the directory as a single test and fails.
  //
  // CARILLON_PROVENANCE_CHILD marks this spawned suite as already being
  // inside a provenance run. tests/provenance.test.mjs skips its own
  // `--check` case when it sees the flag, which is what stops
  // check -> suite -> check -> suite from recursing forever. It is skipped
  // rather than removed so the reported test TOTAL is identical either
  // way, and the count this script writes stays stable.
  const res = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CARILLON_PROVENANCE_CHILD: '1' },
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const total = Number((out.match(/^. tests (\d+)/m) || [])[1]);
  const pass = Number((out.match(/^. pass (\d+)/m) || [])[1]);
  const fail = Number((out.match(/^. fail (\d+)/m) || [])[1]);
  if (!Number.isFinite(total) || !Number.isFinite(pass)) {
    throw new Error('provenance: could not parse the test summary\n' + out.slice(-800));
  }
  return { total, pass, fail };
}

function runVerify() {
  const res = spawnSync(process.execPath, ['verify.mjs', '.'], { cwd: ROOT, encoding: 'utf8' });
  return { ok: res.status === 0, line: (res.stdout || '').trim() };
}

const cutoff = readCutoffSweep();
const suite = runSuite();
const verify = runVerify();
const degrees = SCALES.majorPent.degrees.length;

// Every scale must present the same number of quantization targets, or the
// page's single "N targets" claim would be true of only one of them.
for (const [name, scale] of Object.entries(SCALES)) {
  if (scale.degrees.length !== degrees) {
    throw new Error(`provenance: scale "${name}" has ${scale.degrees.length} degrees, expected ${degrees}`);
  }
}

const facts = {
  generatedFrom: ['src/mapping.mjs', 'src/audio.mjs', 'tests/', 'verify.mjs'],
  intervalMinMs: MIN_INTERVAL_MS,
  intervalMaxMs: MAX_INTERVAL_MS,
  dwellMinMs: MIN_DWELL_MS,
  dwellMaxMs: MAX_DWELL_MS,
  scaleCount: Object.keys(SCALES).length,
  degrees,
  velocityMin: Number(dwellToVelocity(MIN_DWELL_MS).toFixed(2)),
  velocityMax: Number(dwellToVelocity(MAX_DWELL_MS).toFixed(2)),
  cutoffLoHz: cutoff.lo,
  cutoffHiHz: cutoff.hi,
  detuneCents: readDetune(),
  tests: suite.total,
  testsPass: suite.pass,
  testsFail: suite.fail,
  verifyOk: verify.ok,
  verifyLine: verify.line,
};

// The page's marked spans. Key -> the exact text that belongs inside
// <span data-prov="key">…</span>.
const SPANS = {
  'interval-range': `${facts.intervalMinMs}–${facts.intervalMaxMs}`,
  'dwell-range': `${facts.dwellMinMs}–${facts.dwellMaxMs}`,
  degrees: String(facts.degrees),
  scales: String(facts.scaleCount),
  'cutoff-range': `${facts.cutoffLoHz}–${facts.cutoffHiHz}`,
  detune: String(facts.detuneCents),
  tests: String(facts.tests),
  'velocity-range': `${facts.velocityMin.toFixed(2)}–${facts.velocityMax.toFixed(2)}`,
};

const indexPath = join(ROOT, 'index.html');
const before = readFileSync(indexPath, 'utf8');
let after = before;
const missing = [];

for (const [key, value] of Object.entries(SPANS)) {
  const re = new RegExp(`(<span data-prov="${key}"[^>]*>)([^<]*)(</span>)`, 'g');
  if (!re.test(after)) {
    missing.push(key);
    continue;
  }
  after = after.replace(
    new RegExp(`(<span data-prov="${key}"[^>]*>)([^<]*)(</span>)`, 'g'),
    (_m, open, _old, close) => open + value + close,
  );
}

if (missing.length > 0) {
  console.error('provenance: index.html has no span for: ' + missing.join(', '));
  process.exit(1);
}

mkdirSync(join(ROOT, 'docs'), { recursive: true });
const jsonPath = join(ROOT, 'docs', 'provenance.json');
const json = JSON.stringify(facts, null, 2) + '\n';
let jsonBefore = '';
try {
  jsonBefore = readFileSync(jsonPath, 'utf8');
} catch {
  jsonBefore = '';
}

if (check) {
  const stale = [];
  if (after !== before) stale.push('index.html');
  if (json !== jsonBefore) stale.push('docs/provenance.json');
  if (!facts.verifyOk) stale.push('verify.mjs is FAILING');
  if (facts.testsFail > 0) stale.push(`${facts.testsFail} test(s) failing`);
  if (stale.length > 0) {
    console.error('provenance: OUT OF DATE — ' + stale.join(', ') + '. Run `node tools/provenance.mjs`.');
    process.exit(1);
  }
  console.log(`provenance: OK — index.html matches src/ (${facts.tests} tests, verify clean)`);
} else {
  writeFileSync(indexPath, after);
  writeFileSync(jsonPath, json);
  console.log(
    `provenance: wrote ${Object.keys(SPANS).length} spans into index.html ` +
      `(${facts.tests} tests, ${facts.degrees} degrees, ${facts.intervalMinMs}-${facts.intervalMaxMs}ms, verify ${facts.verifyOk ? 'clean' : 'FAILING'})`,
  );
}
