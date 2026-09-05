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

export function createEngine() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();

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

export async function resumeEngine(engine) {
  if (engine.ctx.state === 'suspended') await engine.ctx.resume();
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
