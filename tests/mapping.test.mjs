import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  lerp,
  freqForDegree,
  intervalToDegree,
  dwellToVelocity,
  dwellToBrightness,
  releaseForInterval,
  mapBackspace,
  mapKeyEvent,
  SCALES,
  DEFAULT_SCALE,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_DWELL_MS,
  MAX_DWELL_MS,
} from '../src/mapping.mjs';

test('clamp bounds a value into [lo, hi]', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
});

test('lerp interpolates linearly', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
});

test('freqForDegree returns the scale root at degree 0', () => {
  assert.equal(freqForDegree('majorPent', 0), SCALES.majorPent.root);
  assert.equal(freqForDegree('minorPent', 0), SCALES.minorPent.root);
  assert.equal(freqForDegree('dorian', 0), SCALES.dorian.root);
});

test('freqForDegree clamps out-of-range degree indices to the ends of the scale', () => {
  const nDeg = SCALES.majorPent.degrees.length;
  assert.equal(freqForDegree('majorPent', -5), freqForDegree('majorPent', 0));
  assert.equal(freqForDegree('majorPent', nDeg + 5), freqForDegree('majorPent', nDeg - 1));
});

test('freqForDegree falls back to the default scale for an unknown key', () => {
  assert.equal(freqForDegree('not-a-scale', 0), freqForDegree(DEFAULT_SCALE, 0));
});

test('intervalToDegree: the shortest interval maps to the top of the scale', () => {
  const nDeg = SCALES.majorPent.degrees.length;
  const d = intervalToDegree(MIN_INTERVAL_MS, 'majorPent');
  assert.ok(Math.abs(d - (nDeg - 1)) < 1e-9, `expected ~${nDeg - 1}, got ${d}`);
});

test('intervalToDegree: the longest interval maps to the bottom of the scale', () => {
  const d = intervalToDegree(MAX_INTERVAL_MS, 'majorPent');
  assert.ok(Math.abs(d - 0) < 1e-9, `expected ~0, got ${d}`);
});

test('intervalToDegree is monotonically non-increasing as the interval grows', () => {
  const samples = [40, 80, 160, 320, 640, 900];
  const degrees = samples.map((ms) => intervalToDegree(ms, 'majorPent'));
  for (let i = 1; i < degrees.length; i++) {
    assert.ok(degrees[i] <= degrees[i - 1] + 1e-9, `degree rose from ${degrees[i - 1]} to ${degrees[i]}`);
  }
});

test('intervalToDegree clamps below MIN and above MAX to the same value as the boundary', () => {
  assert.equal(intervalToDegree(1, 'majorPent'), intervalToDegree(MIN_INTERVAL_MS, 'majorPent'));
  assert.equal(intervalToDegree(5000, 'majorPent'), intervalToDegree(MAX_INTERVAL_MS, 'majorPent'));
});

test('dwellToVelocity increases monotonically with dwell time and stays in [0.35, 1]', () => {
  const short = dwellToVelocity(MIN_DWELL_MS);
  const mid = dwellToVelocity((MIN_DWELL_MS + MAX_DWELL_MS) / 2);
  const long = dwellToVelocity(MAX_DWELL_MS);
  assert.ok(short < mid && mid < long);
  assert.ok(short >= 0.35 && long <= 1.0);
});

test('dwellToVelocity clamps outside [MIN_DWELL_MS, MAX_DWELL_MS]', () => {
  assert.equal(dwellToVelocity(0), dwellToVelocity(MIN_DWELL_MS));
  assert.equal(dwellToVelocity(10000), dwellToVelocity(MAX_DWELL_MS));
});

test('dwellToBrightness increases monotonically with dwell time and stays in [0, 1]', () => {
  const short = dwellToBrightness(MIN_DWELL_MS);
  const long = dwellToBrightness(MAX_DWELL_MS);
  assert.ok(short < long);
  assert.ok(short >= 0 && long <= 1);
});

test('releaseForInterval clamps into [0.15, 0.9] seconds', () => {
  assert.equal(releaseForInterval(1), 0.15);
  assert.equal(releaseForInterval(5000), 0.9);
  assert.equal(releaseForInterval(500), 0.5);
});

test('mapBackspace stays a full octave below the scale root, regardless of speed', () => {
  const fast = mapBackspace(MIN_INTERVAL_MS, 'majorPent');
  const slow = mapBackspace(MAX_INTERVAL_MS, 'majorPent');
  assert.equal(fast.freq, SCALES.majorPent.root / 2);
  assert.equal(slow.freq, SCALES.majorPent.root / 2);
  assert.ok(fast.freq < SCALES.majorPent.root);
  assert.equal(fast.kind, 'backspace');
});

test('mapBackspace gets louder and noisier the faster repeated backspaces arrive', () => {
  const fast = mapBackspace(MIN_INTERVAL_MS, 'majorPent'); // rapid hold-to-delete
  const slow = mapBackspace(MAX_INTERVAL_MS, 'majorPent'); // one deliberate correction
  assert.ok(fast.velocity > slow.velocity, 'fast backspace should be louder than slow');
  assert.ok(fast.noiseAmount > slow.noiseAmount, 'fast backspace should be noisier than slow');
  assert.ok(fast.releaseSec < slow.releaseSec, 'fast backspace should be shorter than slow');
});

test('mapKeyEvent(char) matches the individual mapping functions it composes', () => {
  const intervalMs = 200;
  const dwellMs = 100;
  const d = mapKeyEvent({ type: 'char', intervalMs, dwellMs, scaleKey: 'majorPent' });
  assert.equal(d.kind, 'note');
  assert.equal(d.velocity, dwellToVelocity(dwellMs));
  assert.equal(d.brightness, dwellToBrightness(dwellMs));
  assert.equal(d.releaseSec, releaseForInterval(intervalMs));
  assert.equal(d.freq, freqForDegree('majorPent', intervalToDegree(intervalMs, 'majorPent')));
  assert.ok(d.degreeT >= 0 && d.degreeT <= 1);
});

test('mapKeyEvent(backspace) delegates to mapBackspace', () => {
  const d = mapKeyEvent({ type: 'backspace', intervalMs: 100, dwellMs: 80, scaleKey: 'majorPent' });
  const expected = mapBackspace(100, 'majorPent');
  assert.deepEqual(d, expected);
});

test('a backspace is never in the pitch register a forward keystroke can reach', () => {
  const d = mapKeyEvent({ type: 'backspace', intervalMs: 100, dwellMs: 80, scaleKey: 'majorPent' });
  const lowestNoteFreq = freqForDegree('majorPent', 0);
  assert.ok(d.freq < lowestNoteFreq, `backspace freq ${d.freq} should be below lowest note ${lowestNoteFreq}`);
});

test('mapKeyEvent defaults to the default scale when scaleKey is omitted', () => {
  const withDefault = mapKeyEvent({ type: 'char', intervalMs: 150, dwellMs: 90 });
  const explicit = mapKeyEvent({ type: 'char', intervalMs: 150, dwellMs: 90, scaleKey: DEFAULT_SCALE });
  assert.deepEqual(withDefault, explicit);
});

test('every scale starts at its documented root frequency', () => {
  for (const key of Object.keys(SCALES)) {
    assert.equal(freqForDegree(key, 0), SCALES[key].root);
  }
});
