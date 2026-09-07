import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCALES,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_DWELL_MS,
  MAX_DWELL_MS,
  dwellToVelocity,
} from '../src/mapping.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// The page states the mapping's real bounds. A hand-typed copy of a fact
// drifts — this project's own README proved it, claiming "37 tests" while
// the suite ran 59. tools/provenance.mjs writes these spans from the
// modules; these tests are what make a drifted copy a red build instead of
// a slow embarrassment nobody notices.

function span(key) {
  const m = html.match(new RegExp(`<span data-prov="${key}"[^>]*>([^<]*)</span>`));
  assert.ok(m, `index.html has no <span data-prov="${key}">`);
  return m[1];
}

test('every provenance span on the page matches src/mapping.mjs', () => {
  assert.equal(span('interval-range'), `${MIN_INTERVAL_MS}–${MAX_INTERVAL_MS}`);
  assert.equal(span('dwell-range'), `${MIN_DWELL_MS}–${MAX_DWELL_MS}`);
  assert.equal(span('degrees'), String(SCALES.majorPent.degrees.length));
  assert.equal(span('scales'), String(Object.keys(SCALES).length));
  assert.equal(
    span('velocity-range'),
    `${dwellToVelocity(MIN_DWELL_MS).toFixed(2)}–${dwellToVelocity(MAX_DWELL_MS).toFixed(2)}`,
  );
});

test('the lowpass sweep on the page is the one src/audio.mjs actually applies', () => {
  const audio = readFileSync(join(ROOT, 'src', 'audio.mjs'), 'utf8');
  const m = audio.match(/filter\.frequency\.value\s*=\s*lerp\(\s*(\d+)\s*,\s*(\d+)\s*,/);
  assert.ok(m, 'src/audio.mjs no longer has a readable lowpass sweep');
  assert.equal(span('cutoff-range'), `${m[1]}–${m[2]}`);
});

test('every scale offers the same number of quantization targets the page claims', () => {
  const claimed = Number(span('degrees'));
  for (const [name, scale] of Object.entries(SCALES)) {
    assert.equal(scale.degrees.length, claimed, `scale "${name}" has ${scale.degrees.length} degrees`);
  }
});

test('the scale <select> offers exactly the scales SCALES defines', () => {
  const values = [...html.matchAll(/<option value="([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values.sort(), Object.keys(SCALES).sort());
});
