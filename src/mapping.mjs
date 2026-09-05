// src/mapping.mjs
//
// Pure, DOM-free, Web-Audio-free rhythm -> sound-parameter mapping.
// Every function here takes plain numbers in and returns plain
// numbers/objects out. No side effects, no globals, no audio context.
// That is deliberate: this is the one module tests/mapping.test.mjs can
// exercise headlessly, with no browser involved, so the actual musical
// decisions are provably correct independent of whether Web Audio ever
// makes a sound.
//
// Design notes (why these numbers, not just what they are):
//
// - Pitch comes from the inter-key interval: how long since the last
//   counted key event. SHORT interval -> HIGH pitch (fast typing reads
//   as energetic); LONG interval -> LOW pitch (a pause reads as
//   settling). The mapping is log-scaled first, because human
//   inter-keystroke intervals are roughly log-normally distributed. A
//   linear map would crush ordinary typing speed into a narrow band and
//   let one long pause dominate the whole pitch range.
// - Every pitch is then quantized to a fixed scale (2-octave
//   pentatonic or modal). That quantization is the load-bearing musical
//   decision: it guarantees any two notes are consonant with each other
//   no matter what a given person's raw typing rhythm looks like. There
//   is no rhythm that produces a wrong-sounding note sequence.
// - Loudness and brightness (filter cutoff) come from key dwell time
//   (keydown -> keyup on the same key), a second, independent signal
//   from a second, independent muscle decision (how hard/long you
//   pressed, not how fast you moved to the next key).
// - Note release time scales with the interval too, so fast bursts
//   overlap into legato runs and slow, deliberate typing produces
//   separated, plucked notes. The texture carries the rhythm, not just
//   the pitch sequence.
// - Backspace is mapped separately (mapBackspace) into a register no
//   forward-typed note reaches, so it is always audibly distinct.

export const SCALES = Object.freeze({
  // semitone offsets from root, 2 octaves, quantization targets
  majorPent: Object.freeze({ root: 261.63, degrees: Object.freeze([0, 2, 4, 7, 9, 12, 14, 16, 19, 21]) }), // C4, bright
  minorPent: Object.freeze({ root: 220.00, degrees: Object.freeze([0, 3, 5, 7, 10, 12, 15, 17, 19, 22]) }), // A3, moody
  dorian: Object.freeze({ root: 293.66, degrees: Object.freeze([0, 2, 3, 5, 7, 9, 10, 12, 14, 15]) }), // D4, open/modal
});

export const DEFAULT_SCALE = 'majorPent';

export const MIN_INTERVAL_MS = 40;
export const MAX_INTERVAL_MS = 900;
export const MIN_DWELL_MS = 30;
export const MAX_DWELL_MS = 250;

// Used for the very first keystroke of a session, when there is no
// previous key event to measure an interval against.
export const DEFAULT_FIRST_INTERVAL_MS = 260;

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

function scaleOrDefault(scaleKey) {
  return SCALES[scaleKey] ?? SCALES[DEFAULT_SCALE];
}

export function freqForDegree(scaleKey, degreeIndex) {
  const scale = scaleOrDefault(scaleKey);
  const nDeg = scale.degrees.length;
  const i = clamp(Math.round(degreeIndex), 0, nDeg - 1);
  const semis = scale.degrees[i];
  return scale.root * Math.pow(2, semis / 12);
}

// Inter-key interval (ms) -> scale-degree index (float; caller rounds
// via freqForDegree). Short interval -> high degree, long -> low.
export function intervalToDegree(intervalMs, scaleKey = DEFAULT_SCALE) {
  const scale = scaleOrDefault(scaleKey);
  const nDeg = scale.degrees.length;
  const c = clamp(intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const logMin = Math.log(MIN_INTERVAL_MS);
  const logMax = Math.log(MAX_INTERVAL_MS);
  const t = (Math.log(c) - logMin) / (logMax - logMin); // 0 (short) .. 1 (long)
  return lerp(nDeg - 1, 0, t);
}

// Key dwell time (ms, keydown -> keyup on the same key) -> velocity.
export function dwellToVelocity(dwellMs) {
  const c = clamp(dwellMs, MIN_DWELL_MS, MAX_DWELL_MS);
  const t = (c - MIN_DWELL_MS) / (MAX_DWELL_MS - MIN_DWELL_MS);
  return lerp(0.35, 1.0, t);
}

// Key dwell time (ms) -> brightness (0..1, drives lowpass cutoff).
export function dwellToBrightness(dwellMs) {
  const c = clamp(dwellMs, MIN_DWELL_MS, MAX_DWELL_MS);
  const t = (c - MIN_DWELL_MS) / (MAX_DWELL_MS - MIN_DWELL_MS);
  return lerp(0.0, 1.0, t);
}

// Note release time (seconds), driven by the SAME interval that set the
// pitch: fast typing -> short, overlapping notes; slow typing -> long,
// separated notes.
export function releaseForInterval(intervalMs) {
  return clamp(intervalMs / 1000, 0.15, 0.9);
}

// Backspace gets its own mapping, deliberately outside the pitch
// register any forward-typed note can reach (a full octave below the
// scale root), so a correction is always audibly distinct from typing.
// It gets louder and noisier the faster repeated backspaces arrive, so
// a single deliberate correction sounds different from a frustrated
// hold-to-delete run.
export function mapBackspace(intervalMs, scaleKey = DEFAULT_SCALE) {
  const scale = scaleOrDefault(scaleKey);
  const c = clamp(intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const logMin = Math.log(MIN_INTERVAL_MS);
  const logMax = Math.log(MAX_INTERVAL_MS);
  const t = (Math.log(c) - logMin) / (logMax - logMin); // 0 (fast repeat) .. 1 (slow/single)
  const urgency = 1 - t;
  return {
    kind: 'backspace',
    freq: scale.root / 2,
    velocity: lerp(0.3, 0.9, urgency),
    brightness: lerp(0.1, 0.6, urgency),
    noiseAmount: lerp(0.15, 0.6, urgency),
    releaseSec: lerp(0.5, 0.12, urgency),
  };
}

// Single entry point: turn one captured key event into a full,
// ready-to-play sound descriptor. This is the one function the audio
// layer actually calls; everything above exists to make this function's
// output easy to reason about and test in isolation.
export function mapKeyEvent({ type, intervalMs, dwellMs, scaleKey = DEFAULT_SCALE }) {
  if (type === 'backspace') {
    return mapBackspace(intervalMs, scaleKey);
  }
  const scale = scaleOrDefault(scaleKey);
  const degree = intervalToDegree(intervalMs, scaleKey);
  const degreeT = degree / (scale.degrees.length - 1);
  return {
    kind: 'note',
    freq: freqForDegree(scaleKey, degree),
    degreeT,
    velocity: dwellToVelocity(dwellMs),
    brightness: dwellToBrightness(dwellMs),
    releaseSec: releaseForInterval(intervalMs),
  };
}
