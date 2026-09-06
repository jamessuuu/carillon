// src/audio.mjs
//
// Web Audio synthesis layer. Consumes the plain descriptor objects
// produced by src/mapping.mjs and turns them into sound. This module
// touches only the Web Audio API — no network access, no storage, no
// globals beyond a single AudioContext created on demand.
//
// Timbre choices: two slightly detuned triangle oscillators (a cheap,
// standard chorus trick) through a lowpass filter and a short envelope,
// plus a quiet feedback-delay send for room tone. This avoids the
// harsh, toy-like sound of a bare square/sine beep-per-key. Backspace
// uses a separate voice (a short downward sawtooth chirp plus filtered
// noise) so a correction is timbrally, not just tonally, distinct.

import { clamp, lerp } from './mapping.mjs';

// The two names a Web Audio constructor has ever shipped under, in order of
// preference: unprefixed (Safari 14.1+, every Chromium, Firefox) before the
// legacy WebKit prefix (Safari 6 to 14.0). An engine that ships Web Audio at
// all exposes one of these. An engine that ships none of it (Playwright's
// WebKit build for Windows, found by the 2026-09-06 sweep: no AudioContext,
// no webkitAudioContext, no OfflineAudioContext, no AudioNode, nothing)
// exposes neither, and that case used to fall straight into
// `new undefined()`: an unhandled "undefined is not a constructor" and a UI
// that just kept saying "Sound is off".
export const AUDIO_CONTEXT_NAMES = Object.freeze(['AudioContext', 'webkitAudioContext']);

// Pure lookup. Takes the global object as an argument instead of reaching
// for `window`, so tests can hand it a Chromium-shaped, an old-Safari-shaped,
// or a no-Web-Audio-shaped object and prove which branch each one takes
// without a browser. Returns the constructor and the name it was found
// under, or nulls when the global has no usable Web Audio constructor.
export function resolveAudioContextCtor(global = globalThis) {
  for (const name of AUDIO_CONTEXT_NAMES) {
    const candidate = global == null ? undefined : global[name];
    if (typeof candidate === 'function') return { ctor: candidate, name };
  }
  return { ctor: null, name: null };
}

// Thrown by createEngine when no context can be made. `reason` is a stable
// machine-readable code the UI keys on; `message` is already written for a
// visitor, and names the actual cause rather than a generic "audio error".
//   no-web-audio      the engine has no AudioContext under either name
//   construct-failed  a constructor exists but `new` threw (cause attached)
export class AudioUnavailableError extends Error {
  constructor(reason, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AudioUnavailableError';
    this.reason = reason;
  }
}

export function createEngine(global = globalThis) {
  const { ctor: AudioCtx, name } = resolveAudioContextCtor(global);
  if (!AudioCtx) {
    throw new AudioUnavailableError(
      'no-web-audio',
      'This browser has no Web Audio API: neither AudioContext nor ' +
        'webkitAudioContext exists here, so there is nothing to make sound with. ' +
        'Typing still works, silently.',
    );
  }

  let ctx;
  try {
    ctx = new AudioCtx();
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    throw new AudioUnavailableError(
      'construct-failed',
      `The browser refused to create an audio context (new ${name}() failed: ${why}). ` +
        'Typing still works, silently.',
      err,
    );
  }

  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);

  // Lightweight feedback-delay "room" send instead of full convolution
  // reverb — cheap, and enough to stop the instrument sounding dry.
  const delayNode = ctx.createDelay(1.0);
  delayNode.delayTime.value = 0.18;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.25;
  const delaySend = ctx.createGain();
  delaySend.gain.value = 0.16;
  delayNode.connect(feedback);
  feedback.connect(delayNode);
  delayNode.connect(master);
  delaySend.connect(delayNode);

  return { ctx, master, delaySend };
}

// Resolves to the context's state after the resume attempt. Browsers create
// contexts suspended until a user gesture, and a resume() that the browser
// declines can either reject or quietly leave the state where it was; the
// caller gets the state back so it can say so instead of claiming sound is on.
export async function resumeEngine(engine) {
  if (engine.ctx.state === 'suspended') await engine.ctx.resume();
  return engine.ctx.state;
}

export async function suspendEngine(engine) {
  if (engine.ctx.state === 'running') await engine.ctx.suspend();
}

export async function closeEngine(engine) {
  if (engine.ctx.state !== 'closed') await engine.ctx.close();
}

export function playNote(engine, descriptor, when) {
  if (descriptor.kind === 'backspace') {
    playBackspace(engine, descriptor, when);
    return;
  }
  playForwardNote(engine, descriptor, when);
}

function playForwardNote(engine, descriptor, t0) {
  const { ctx, master, delaySend } = engine;

  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  osc1.type = 'triangle';
  osc2.type = 'triangle';
  osc1.frequency.value = descriptor.freq;
  osc2.frequency.value = descriptor.freq * Math.pow(2, 7 / 1200); // +7 cents, chorus-ish

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lerp(900, 4200, descriptor.brightness);
  filter.Q.value = 0.7;

  const env = ctx.createGain();
  env.gain.value = 0;

  const noteGain = ctx.createGain();
  noteGain.gain.value = clamp(descriptor.velocity, 0.1, 1) * 0.5;

  osc1.connect(filter);
  osc2.connect(filter);
  filter.connect(env);
  env.connect(noteGain);
  noteGain.connect(master);
  noteGain.connect(delaySend);

  const attack = 0.006;
  const decayTo = 0.35;
  const release = clamp(descriptor.releaseSec, 0.15, 0.9);

  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(1, t0 + attack);
  env.gain.linearRampToValueAtTime(decayTo, t0 + attack + 0.07);
  env.gain.setTargetAtTime(0, t0 + attack + 0.07, release / 3);

  osc1.start(t0);
  osc2.start(t0);
  osc1.stop(t0 + attack + 0.07 + release);
  osc2.stop(t0 + attack + 0.07 + release);
}

function playBackspace(engine, descriptor, t0) {
  const { ctx, master, delaySend } = engine;

  // A short downward chirp (the "un-typing" gesture) plus a burst of
  // filtered noise, scaled by descriptor.noiseAmount, so a correction
  // never sounds like a forward-typed note.
  const release = clamp(descriptor.releaseSec, 0.1, 0.6);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(descriptor.freq * 1.5, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, descriptor.freq * 0.6), t0 + release);

  const oscGain = ctx.createGain();
  oscGain.gain.value = 0;
  const attack = 0.003;
  oscGain.gain.setValueAtTime(0, t0);
  oscGain.gain.linearRampToValueAtTime(descriptor.velocity * 0.4, t0 + attack);
  oscGain.gain.setTargetAtTime(0, t0 + attack, release / 3);

  osc.connect(oscGain);
  oscGain.connect(master);
  osc.start(t0);
  osc.stop(t0 + attack + release + 0.05);

  const noiseDur = 0.08;
  const noiseBuffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * noiseDur)), ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = lerp(400, 1800, descriptor.brightness);
  noiseFilter.Q.value = 0.9;

  const noiseGain = ctx.createGain();
  noiseGain.gain.value = descriptor.noiseAmount * 0.4;

  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(master);
  noiseGain.connect(delaySend);

  noise.start(t0);
  noise.stop(t0 + noiseDur);
}
