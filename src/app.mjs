// src/app.mjs
//
// DOM wiring for the carillon instrument. Captures keydown/keyup timing
// on the typing area, turns it into sound descriptors via
// src/mapping.mjs, and plays them via src/audio.mjs. No network access
// of any kind lives in this file.
//
// Mute-first: the AudioContext is created only inside the "Start sound"
// click handler, so audio never starts without a real user gesture
// (browsers enforce this anyway, but the UI makes it explicit and
// visible). "Stop sound" suspends the context at any time; typing keeps
// working as an ordinary text area regardless of sound state.

import { DEFAULT_FIRST_INTERVAL_MS, mapKeyEvent } from './mapping.mjs';
import { AudioUnavailableError, createEngine, resumeEngine, suspendEngine, playNote } from './audio.mjs';

const typingArea = document.getElementById('typingArea');
const startBtn = document.getElementById('startSound');
const stopBtn = document.getElementById('stopSound');
const scaleSel = document.getElementById('scaleSel');
const clearBtn = document.getElementById('clearBtn');
const timeline = document.getElementById('timeline');
const statusEl = document.getElementById('soundStatus');
const statNotes = document.getElementById('statNotes');
const statBackspaces = document.getElementById('statBackspaces');
const statAvg = document.getElementById('statAvg');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let engine = null;
let soundOn = false;
let lastEventAt = null;
const keyDownAt = new Map();
let events = [];

function setStatus(text, { error = false } = {}) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

// Every way sound can fail to start ends in a sentence the visitor can read,
// naming the actual reason. Before this, a missing Web Audio API threw out of
// the click handler as an unhandled rejection and the status just kept
// saying "Sound is off", which is true but explains nothing.
async function startSound() {
  startBtn.disabled = true;
  try {
    if (!engine) engine = createEngine();
    const state = await resumeEngine(engine);
    if (state !== 'running') {
      startBtn.disabled = false;
      setStatus(
        `Sound did not start: the browser left the audio context "${state}" instead of running it. Click Start sound again.`,
        { error: true },
      );
      return;
    }
  } catch (err) {
    const unavailable = err instanceof AudioUnavailableError;
    if (unavailable) engine = null;
    // No Web Audio API at all is not something another click can fix, so
    // the button stays disabled and the status says why. Anything else
    // (construction refused, resume rejected) may be transient: re-arm.
    startBtn.disabled = unavailable && err.reason === 'no-web-audio';
    const message = unavailable
      ? err.message
      : `Sound could not start: ${err && err.message ? err.message : String(err)}`;
    setStatus(message, { error: true });
    return;
  }
  soundOn = true;
  stopBtn.disabled = false;
  setStatus('Sound is on. Type in the box below.');
}

async function stopSound() {
  soundOn = false;
  if (engine) await suspendEngine(engine);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Sound is off.');
}

function hueForDegree(t) {
  const hue = 28 + (190 - 28) * t;
  return `hsl(${hue}, 70%, 60%)`;
}

function addNoteToTimeline(descriptor) {
  const bar = document.createElement('div');
  bar.className = reducedMotion ? 'note' : 'note pop';
  const heightT = descriptor.kind === 'backspace' ? 0.4 : descriptor.velocity;
  bar.style.height = `${18 + heightT * 72}px`;
  bar.style.background = descriptor.kind === 'backspace' ? '#f87171' : hueForDegree(descriptor.degreeT ?? 0.5);
  timeline.appendChild(bar);
  timeline.scrollLeft = timeline.scrollWidth;
  if (!reducedMotion) {
    requestAnimationFrame(() => bar.classList.remove('pop'));
  }
}

function updateStats() {
  const notes = events.filter((e) => e.kind === 'note').length;
  const backspaces = events.filter((e) => e.kind === 'backspace').length;
  statNotes.textContent = String(notes);
  statBackspaces.textContent = String(backspaces);
  const intervals = events.slice(1).map((e) => e.intervalMs);
  statAvg.textContent = intervals.length
    ? (intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(0)
    : '–';
}

function handleKeyEvent(type, now, downAt) {
  const intervalMs = lastEventAt === null ? DEFAULT_FIRST_INTERVAL_MS : now - lastEventAt;
  const dwellMs = downAt === undefined ? 60 : now - downAt;
  lastEventAt = now;

  const descriptor = mapKeyEvent({ type, intervalMs, dwellMs, scaleKey: scaleSel.value });
  events.push({ ...descriptor, intervalMs, dwellMs });

  if (soundOn && engine) {
    playNote(engine, descriptor, engine.ctx.currentTime);
  }
  addNoteToTimeline(descriptor);
  updateStats();
}

typingArea.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 'Backspace' || e.key.length === 1) {
    keyDownAt.set(e.code, performance.now());
  }
});

typingArea.addEventListener('keyup', (e) => {
  const downAt = keyDownAt.get(e.code);
  keyDownAt.delete(e.code);
  if (downAt === undefined) return;

  if (e.key === 'Backspace') {
    handleKeyEvent('backspace', performance.now(), downAt);
    return;
  }
  if (e.key.length !== 1) return;
  handleKeyEvent('char', performance.now(), downAt);
});

startBtn.addEventListener('click', () => {
  startSound();
});
stopBtn.addEventListener('click', () => {
  stopSound();
});

clearBtn.addEventListener('click', () => {
  typingArea.value = '';
  typingArea.focus();
  events = [];
  lastEventAt = null;
  keyDownAt.clear();
  timeline.innerHTML = '';
  updateStats();
});

updateStats();
