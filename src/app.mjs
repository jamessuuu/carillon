// src/app.mjs
//
// DOM wiring for the carillon instrument. Captures keydown/keyup timing
// on the typing area, turns it into sound descriptors via
// src/mapping.mjs, plays them via src/audio.mjs, and — the part this
// page was missing entirely — DRAWS the mapping while it happens.
//
// The scope is the product. Ten horizontal lines are the ten
// quantization targets of the selected scale; every note lands exactly
// on one of them. That is the load-bearing musical claim ("there is no
// rhythm that produces a wrong-sounding note sequence") turned into
// something a visitor can watch instead of a sentence they have to
// take on faith. Backspaces plot in a separate register below the
// lowest line, because mapBackspace really does put them a full octave
// under the scale root.
//
// No network access of any kind lives in this file.
//
// Mute-first: the AudioContext is created only inside the "Start sound"
// click handler, so audio never starts without a real user gesture.
// "Stop" suspends the context at any time; typing keeps working as an
// ordinary text area regardless of sound state, and the scope keeps
// drawing, because the mapping is not the audio.

import {
  DEFAULT_FIRST_INTERVAL_MS,
  SCALES,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_DWELL_MS,
  MAX_DWELL_MS,
  mapKeyEvent,
  intervalToDegree,
  freqForDegree,
  dwellToVelocity,
  dwellToBrightness,
  lerp,
  clamp,
} from './mapping.mjs';
import { AudioUnavailableError, createEngine, resumeEngine, suspendEngine, playNote } from './audio.mjs';

const typingArea = document.getElementById('typingArea');
const startBtn = document.getElementById('startSound');
const stopBtn = document.getElementById('stopSound');
const scaleSel = document.getElementById('scaleSel');
const clearBtn = document.getElementById('clearBtn');
const plot = document.getElementById('plot');
const scopeAxis = document.getElementById('scopeAxis');
const statusEl = document.getElementById('soundStatus');
const statNotes = document.getElementById('statNotes');
const statBackspaces = document.getElementById('statBackspaces');
const statAvg = document.getElementById('statAvg');
const traceState = document.getElementById('traceState');
const traceLabel = document.getElementById('traceLabel');

const ro = {
  interval: document.getElementById('roInterval'),
  note: document.getElementById('roNote'),
  freq: document.getElementById('roFreq'),
  dwell: document.getElementById('roDwell'),
  cutoff: document.getElementById('roCutoff'),
  bar: document.getElementById('roBar'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The lowpass sweep the audio layer applies to brightness. Mirrored here
// only so the readout can show the visitor the cutoff their key press
// just produced; audio.mjs remains the thing that actually applies it.
const CUTOFF_LO = 900;
const CUTOFF_HI = 4200;

const WINDOW = 110; // notes kept on screen before the oldest scrolls off
const CORRECTION_Y = 7; // % from the bottom of the field
const DEGREE_LO_Y = 24;
const DEGREE_HI_Y = 94;

let engine = null;
let soundOn = false;
let lastEventAt = null;
const keyDownAt = new Map();

// Every event keeps its two RAW measurements. The descriptor is derived,
// never stored as the source of truth, so switching key re-quantizes the
// whole trace onto the new grid — which is itself the clearest possible
// demonstration of what quantization is doing.
let events = [];
let isDemo = true;

/* ------------------------------------------------------------------ */
/* note naming                                                         */
/* ------------------------------------------------------------------ */

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

function noteName(freq) {
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function hueForDegree(t) {
  return 28 + (190 - 28) * t;
}
function colorForDegree(t) {
  return `hsl(${hueForDegree(t).toFixed(0)}, 78%, 62%)`;
}

function degreeY(index, count) {
  if (count <= 1) return DEGREE_LO_Y;
  return DEGREE_LO_Y + (index / (count - 1)) * (DEGREE_HI_Y - DEGREE_LO_Y);
}

/* ------------------------------------------------------------------ */
/* the scope: axis + gridlines                                         */
/* ------------------------------------------------------------------ */

let contour = null;

function buildScope() {
  const scaleKey = scaleSel.value;
  const scale = SCALES[scaleKey] ?? SCALES.majorPent;
  const n = scale.degrees.length;

  plot.replaceChildren();
  scopeAxis.replaceChildren();

  for (let i = 0; i < n; i++) {
    const y = degreeY(i, n);

    const line = document.createElement('div');
    line.className = 'grid-line';
    line.style.bottom = `${y}%`;
    plot.appendChild(line);

    // Label every other degree: ten stacked labels in 232px is a smear,
    // and the lines carry the structure regardless of whether each one
    // is named.
    if (i % 2 === 0 || i === n - 1) {
      const tick = document.createElement('span');
      tick.className = 'axis-tick';
      tick.style.bottom = `${y}%`;
      tick.textContent = noteName(freqForDegree(scaleKey, i));
      scopeAxis.appendChild(tick);
    }
  }

  const cline = document.createElement('div');
  cline.className = 'grid-line is-correction';
  cline.style.bottom = `${CORRECTION_Y}%`;
  plot.appendChild(cline);

  const ctick = document.createElement('span');
  ctick.className = 'axis-tick is-correction';
  ctick.style.bottom = `${CORRECTION_Y}%`;
  ctick.textContent = noteName(scale.root / 2);
  scopeAxis.appendChild(ctick);

  contour = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  contour.setAttribute('class', 'scope-contour');
  contour.setAttribute('preserveAspectRatio', 'none');
  contour.setAttribute('viewBox', '0 0 100 100');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  contour.appendChild(poly);
  plot.appendChild(contour);

  plot.setAttribute(
    'aria-label',
    `Pitch over time. ${n} horizontal lines are the ${n} quantization targets of ` +
      `${scaleSel.options[scaleSel.selectedIndex].text}; every note lands on one of them. ` +
      `Corrections plot below, an octave under the root.`,
  );
}

/* ------------------------------------------------------------------ */
/* the scope: notes                                                    */
/* ------------------------------------------------------------------ */

function xPercent(i, total) {
  const slots = Math.max(total, 24);
  const denom = Math.max(slots - 1, 1);
  return 2 + (i / denom) * 96;
}

function renderTrace({ animateLast = false } = {}) {
  const scaleKey = scaleSel.value;
  const scale = SCALES[scaleKey] ?? SCALES.majorPent;
  const n = scale.degrees.length;

  for (const el of plot.querySelectorAll('.note')) el.remove();

  const visible = events.slice(-WINDOW);
  const points = [];

  visible.forEach((ev, i) => {
    const d = mapKeyEvent({ ...ev, scaleKey });
    const x = xPercent(i, visible.length);

    let y;
    let color;
    if (d.kind === 'backspace') {
      y = CORRECTION_Y;
      color = 'hsl(0 100% 71%)';
    } else {
      const degreeIndex = Math.round(intervalToDegree(ev.intervalMs, scaleKey));
      y = degreeY(degreeIndex, n);
      color = colorForDegree(d.degreeT ?? 0.5);
      points.push(`${x.toFixed(2)},${(100 - y).toFixed(2)}`);
    }

    const dot = document.createElement('div');
    dot.className = d.kind === 'backspace' ? 'note is-correction' : 'note';
    dot.style.left = `${x}%`;
    dot.style.bottom = `${y}%`;
    dot.style.setProperty('--note-c', color);
    // Dwell is the second, independent signal: it scales the dot and its
    // opacity, so a firm press is visibly a bigger, brighter mark.
    const v = d.velocity ?? 0.6;
    dot.style.transform = `scale(${(0.62 + v * 0.72).toFixed(3)})`;
    dot.style.opacity = (0.5 + v * 0.5).toFixed(3);
    if (animateLast && i === visible.length - 1 && !reducedMotion) {
      dot.classList.add('note-pop');
    }
    plot.appendChild(dot);
  });

  if (contour) {
    contour.querySelector('polyline').setAttribute('points', points.join(' '));
  }
}

/* ------------------------------------------------------------------ */
/* readout + counters                                                  */
/* ------------------------------------------------------------------ */

function updateReadout(ev) {
  placeMarkers(ev);
  if (!ev) {
    ro.interval.textContent = '—';
    ro.note.textContent = '—';
    ro.freq.textContent = '—';
    ro.dwell.textContent = '—';
    ro.cutoff.textContent = '—';
    ro.bar.style.width = '0%';
    return;
  }
  const scaleKey = scaleSel.value;
  const d = mapKeyEvent({ ...ev, scaleKey });
  ro.interval.textContent = Math.round(ev.intervalMs);
  ro.dwell.textContent = Math.round(ev.dwellMs);
  ro.freq.textContent = d.freq.toFixed(1);
  ro.note.textContent = d.kind === 'backspace' ? `${noteName(d.freq)} · correction` : noteName(d.freq);
  const brightness = d.kind === 'backspace' ? d.brightness : dwellToBrightness(ev.dwellMs);
  ro.cutoff.textContent = Math.round(lerp(CUTOFF_LO, CUTOFF_HI, brightness));
  ro.bar.style.width = `${Math.round((d.velocity ?? 0) * 100)}%`;
}

function updateStats() {
  const notes = events.filter((e) => e.type !== 'backspace').length;
  const backspaces = events.filter((e) => e.type === 'backspace').length;
  statNotes.textContent = String(notes);
  statBackspaces.textContent = String(backspaces);
  const intervals = events.slice(1).map((e) => e.intervalMs);
  statAvg.textContent = intervals.length
    ? (intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(0)
    : '–';
}

function setTraceMode(live) {
  isDemo = !live;
  traceState.dataset.live = String(live);
  traceLabel.textContent = live
    ? 'live — your rhythm'
    : 'demo trace — a recorded rhythm, real mapping';
}

/* ------------------------------------------------------------------ */
/* the demo trace                                                      */
/* ------------------------------------------------------------------ */

// A recorded typing rhythm: [inter-key interval ms, dwell ms], with the
// word-boundary pauses and the two corrections a real sentence contains.
// These are measurements fed to the same mapKeyEvent() a live keystroke
// goes through — the plot on arrival is not a decorative squiggle, it is
// this mapping's actual output for this rhythm.
const DEMO_RHYTHM = [
  // opening burst — familiar word, fast fingers, high register
  [260, 78], [96, 62], [64, 48], [88, 55], [58, 44], [104, 60], [72, 51],
  // a thinking pause, then the sentence resumes mid-register
  [742, 132], [148, 82], [112, 64], [126, 69], [166, 74], [108, 57],
  // second pause, longer — bottom of the range
  [868, 148], [138, 66], [88, 49], [176, 91], [120, 63], [96, 54],
  // a correction: two backspaces, an octave under the root
  [232, 120], ['bs', 44], ['bs', 38],
  // recovering, mid-tempo
  [404, 96], [124, 68], [104, 59], [158, 79], [86, 47], [132, 65],
  // final fast run to the top of the scale, then a long settling pause
  [62, 46], [50, 40], [68, 52], [46, 38], [58, 44],
  [690, 168], [204, 112], [90, 50],
];

function loadDemoTrace() {
  events = DEMO_RHYTHM.map(([interval, dwell]) => ({
    type: interval === 'bs' ? 'backspace' : 'char',
    intervalMs: interval === 'bs' ? 118 : interval,
    dwellMs: dwell,
  }));
  setTraceMode(false);
  renderTrace();
  updateStats();
  updateReadout(events[events.length - 1]);
}

/* ------------------------------------------------------------------ */
/* the two mapping figures                                             */
/* ------------------------------------------------------------------ */

// Drawn from the exported functions themselves. If intervalToDegree or
// dwellToVelocity changes, these figures change with it; they cannot
// drift into describing a mapping the code does not implement.
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Figure geometry. The figures deliberately reuse the scope's own parts —
// the same dark well, the same gridlines, the same axis ticks, the same
// warm-to-cool degree ramp — so they read as two more instrument panels
// rather than two diagrams in cards. Each also carries a live marker
// showing where the last (or currently probed) keystroke sits on that
// mapping, which is what stops them from merely restating the scope: the
// scope shows the instances, the figures show the function, and the marker
// ties one to the other.
const FIG_LO_Y = 12;
const FIG_HI_Y = 92;

function figY(t) {
  return FIG_LO_Y + t * (FIG_HI_Y - FIG_LO_Y);
}

function logT(ms) {
  const c = clamp(ms, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const lo = Math.log(MIN_INTERVAL_MS);
  const hi = Math.log(MAX_INTERVAL_MS);
  return (Math.log(c) - lo) / (hi - lo);
}

function xLabel(field, text, leftPct, align) {
  const el = document.createElement('span');
  el.className = 'fig-xlabel';
  el.textContent = text;
  el.style.left = `${leftPct}%`;
  if (align === 'end') el.style.transform = 'translateX(-100%)';
  else if (align === 'mid') el.style.transform = 'translateX(-50%)';
  field.appendChild(el);
}

// ---- figure 1: interval -> pitch ------------------------------------

const figInterval = {
  field: document.getElementById('figIntervalField'),
  axis: document.getElementById('figIntervalAxis'),
  marker: null,
  dot: null,
};

function drawIntervalFigure() {
  const { field, axis } = figInterval;
  if (!field || !axis) return;
  const scaleKey = scaleSel.value;
  const scale = SCALES[scaleKey] ?? SCALES.majorPent;
  const n = scale.degrees.length;

  field.replaceChildren();
  axis.replaceChildren();

  for (let i = 0; i < n; i++) {
    const y = figY(i / (n - 1));
    const line = document.createElement('div');
    line.className = 'grid-line';
    line.style.bottom = `${y}%`;
    field.appendChild(line);

    if (i % 3 === 0 || i === n - 1) {
      const tick = document.createElement('span');
      tick.className = 'axis-tick';
      tick.style.bottom = `${y}%`;
      tick.textContent = noteName(freqForDegree(scaleKey, i));
      axis.appendChild(tick);
    }
  }

  // The staircase, one coloured run per degree, in the same hue ramp the
  // notes use. Even step widths on a log x-axis are the visible answer to
  // "why log": each note gets an equal share of perceived tempo, instead
  // of ordinary typing being crushed into one band.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'fig-svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');

  const STEPS = 400;
  let runStart = 0;
  let runDegree = Math.round(intervalToDegree(MIN_INTERVAL_MS, scaleKey));
  const emit = (x0, x1, degree) => {
    const y = 100 - figY(degree / (n - 1));
    const seg = document.createElementNS(SVG_NS, 'line');
    seg.setAttribute('class', 'fig-step');
    seg.setAttribute('x1', x0.toFixed(2));
    seg.setAttribute('x2', x1.toFixed(2));
    seg.setAttribute('y1', y.toFixed(2));
    seg.setAttribute('y2', y.toFixed(2));
    seg.setAttribute('stroke', colorForDegree(degree / (n - 1)));
    seg.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(seg);
  };

  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const ms = Math.exp(
      Math.log(MIN_INTERVAL_MS) + t * (Math.log(MAX_INTERVAL_MS) - Math.log(MIN_INTERVAL_MS)),
    );
    const degree = Math.round(intervalToDegree(ms, scaleKey));
    if (degree !== runDegree || i === STEPS) {
      emit(runStart * 100, t * 100, runDegree);
      const riser = document.createElementNS(SVG_NS, 'line');
      riser.setAttribute('class', 'fig-riser');
      riser.setAttribute('x1', (t * 100).toFixed(2));
      riser.setAttribute('x2', (t * 100).toFixed(2));
      riser.setAttribute('y1', (100 - figY(runDegree / (n - 1))).toFixed(2));
      riser.setAttribute('y2', (100 - figY(degree / (n - 1))).toFixed(2));
      riser.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(riser);
      runStart = t;
      runDegree = degree;
    }
  }
  field.appendChild(svg);

  const marker = document.createElement('div');
  marker.className = 'fig-marker';
  field.appendChild(marker);
  figInterval.marker = marker;

  const dot = document.createElement('div');
  dot.className = 'fig-dot';
  field.appendChild(dot);
  figInterval.dot = dot;

  xLabel(field, `${MIN_INTERVAL_MS}ms`, 1, 'start');
  xLabel(field, 'log', 50, 'mid');
  xLabel(field, `${MAX_INTERVAL_MS}ms`, 99, 'end');
}

// ---- figure 2: dwell -> gain + cutoff -------------------------------

const figDwell = {
  field: document.getElementById('figDwellField'),
  axis: document.getElementById('figDwellAxis'),
  marker: null,
  dot: null,
};

function drawDwellFigure() {
  const { field, axis } = figDwell;
  if (!field || !axis) return;

  field.replaceChildren();
  axis.replaceChildren();

  for (const [t, label] of [[0, 'min'], [0.5, ''], [1, 'max']]) {
    const y = figY(t);
    const line = document.createElement('div');
    line.className = 'grid-line';
    line.style.bottom = `${y}%`;
    field.appendChild(line);
    if (label) {
      const tick = document.createElement('span');
      tick.className = 'axis-tick';
      tick.style.bottom = `${y}%`;
      tick.textContent = label;
      axis.appendChild(tick);
    }
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'fig-svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');

  const STEPS = 80;
  const gain = [];
  const cut = [];
  for (let i = 0; i <= STEPS; i++) {
    const ms = MIN_DWELL_MS + (i / STEPS) * (MAX_DWELL_MS - MIN_DWELL_MS);
    const x = (i / STEPS) * 100;
    // Gain starts at 0.35, not 0: even the lightest tap is audible. The
    // figure shows that offset rather than a line through the origin.
    gain.push(`${x.toFixed(2)},${(100 - figY(dwellToVelocity(ms))).toFixed(2)}`);
    cut.push(`${x.toFixed(2)},${(100 - figY(dwellToBrightness(ms))).toFixed(2)}`);
  }

  const fill = document.createElementNS(SVG_NS, 'polygon');
  fill.setAttribute('class', 'fig-fill');
  fill.setAttribute('points', `0,${100 - figY(0)} ${cut.join(' ')} 100,${100 - figY(0)}`);
  svg.appendChild(fill);

  for (const [pts, cls] of [[cut, 'fig-ramp fig-ramp--cut'], [gain, 'fig-ramp fig-ramp--gain']]) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('class', cls);
    line.setAttribute('points', pts.join(' '));
    svg.appendChild(line);
  }
  field.appendChild(svg);

  const marker = document.createElement('div');
  marker.className = 'fig-marker';
  field.appendChild(marker);
  figDwell.marker = marker;

  const dot = document.createElement('div');
  dot.className = 'fig-dot';
  dot.style.setProperty('--note-c', 'var(--signal)');
  field.appendChild(dot);
  figDwell.dot = dot;

  xLabel(field, `${MIN_DWELL_MS}ms`, 1, 'start');
  xLabel(field, 'gain / cutoff', 50, 'mid');
  xLabel(field, `${MAX_DWELL_MS}ms`, 99, 'end');
}

// ---- the live markers -----------------------------------------------

function placeMarkers(ev) {
  const scaleKey = scaleSel.value;
  const scale = SCALES[scaleKey] ?? SCALES.majorPent;
  const n = scale.degrees.length;

  if (figInterval.marker && figInterval.dot) {
    if (!ev) {
      figInterval.marker.style.opacity = '0';
      figInterval.dot.style.opacity = '0';
    } else {
      const t = logT(ev.intervalMs);
      const degree = Math.round(intervalToDegree(ev.intervalMs, scaleKey));
      figInterval.marker.style.opacity = '1';
      figInterval.dot.style.opacity = '1';
      figInterval.marker.style.left = `${(t * 100).toFixed(2)}%`;
      figInterval.dot.style.left = `${(t * 100).toFixed(2)}%`;
      figInterval.dot.style.bottom = `${figY(degree / (n - 1)).toFixed(2)}%`;
      figInterval.dot.style.setProperty('--note-c', colorForDegree(degree / (n - 1)));
    }
  }

  if (figDwell.marker && figDwell.dot) {
    if (!ev) {
      figDwell.marker.style.opacity = '0';
      figDwell.dot.style.opacity = '0';
    } else {
      const t = (clamp(ev.dwellMs, MIN_DWELL_MS, MAX_DWELL_MS) - MIN_DWELL_MS) /
        (MAX_DWELL_MS - MIN_DWELL_MS);
      figDwell.marker.style.opacity = '1';
      figDwell.dot.style.opacity = '1';
      figDwell.marker.style.left = `${(t * 100).toFixed(2)}%`;
      figDwell.dot.style.left = `${(t * 100).toFixed(2)}%`;
      figDwell.dot.style.bottom = `${figY(dwellToVelocity(ev.dwellMs)).toFixed(2)}%`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* sound                                                               */
/* ------------------------------------------------------------------ */

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
  setStatus('Sound is on. Type in the box.');
}

async function stopSound() {
  soundOn = false;
  if (engine) await suspendEngine(engine);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Sound is off. Typing works either way.');
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

function handleKeyEvent(type, now, downAt) {
  // The first real keystroke replaces the demo trace: a visitor's own
  // rhythm should never be mixed into a recording they did not make.
  if (isDemo) {
    events = [];
    lastEventAt = null;
    setTraceMode(true);
  }

  const intervalMs = lastEventAt === null ? DEFAULT_FIRST_INTERVAL_MS : now - lastEventAt;
  const dwellMs = downAt === undefined ? 60 : now - downAt;
  lastEventAt = now;

  const ev = { type, intervalMs, dwellMs };
  events.push(ev);

  if (soundOn && engine) {
    playNote(engine, mapKeyEvent({ ...ev, scaleKey: scaleSel.value }), engine.ctx.currentTime);
  }

  renderTrace({ animateLast: true });
  updateReadout(ev);
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

startBtn.addEventListener('click', () => { startSound(); });
stopBtn.addEventListener('click', () => { stopSound(); });

// Changing key re-quantizes the whole trace onto the new grid, live. The
// raw intervals never move; only which line each one snaps to does, which
// is exactly what quantization means.
scaleSel.addEventListener('change', () => {
  buildScope();
  renderTrace();
  drawIntervalFigure();
  updateReadout(probed ?? events[events.length - 1]);
});

clearBtn.addEventListener('click', () => {
  typingArea.value = '';
  typingArea.focus();
  events = [];
  lastEventAt = null;
  keyDownAt.clear();
  setTraceMode(true);
  renderTrace();
  updateStats();
  updateReadout(null);
});

/* ------------------------------------------------------------------ */
/* the page auditing its own network activity                          */
/* ------------------------------------------------------------------ */

// carillon's one product claim is that this page makes no network requests
// after it loads. The page used to ASSERT that in a paragraph and invite
// you to open devtools yourself. It can do better: the Performance API
// already holds the complete list of resources this document fetched, so
// the page can enumerate its own network activity and show you the count.
//
// This is a measurement, not a promise, and it needs no network access to
// take — which is the whole point. verify.mjs proves the SOURCE contains
// nothing request-shaped; this proves the RUNNING page fetched nothing.
const BOOT_MARK = performance.now();

function auditNetwork() {
  const entries = performance.getEntriesByType('resource');
  const sinceLoad = entries.filter((e) => e.startTime > BOOT_MARK);
  const chip = document.getElementById('netChip');
  const list = document.getElementById('netList');

  if (chip) chip.textContent = String(sinceLoad.length);

  if (list) {
    const origin = window.location.origin;
    const thirdParty = entries.filter((e) => !e.name.startsWith(origin)).length;
    const rows = entries
      .map((e) => {
        const name = e.name.startsWith(origin) ? e.name.slice(origin.length) : e.name;
        const kb = e.transferSize ? ` · ${(e.transferSize / 1024).toFixed(1)} kB` : '';
        return `  ${name || '/'}${kb}`;
      })
      .sort();

    const lines = [
      "$ performance.getEntriesByType('resource')",
      ...(rows.length ? rows : ['  (none)']),
      '',
      `${entries.length} file(s) fetched while loading, ${sinceLoad.length} request(s) since.`,
      `third-party origins: ${thirdParty}`,
    ];
    list.textContent = lines.join('\n');
  }
}

/* ------------------------------------------------------------------ */
/* the pointer probe                                                   */
/* ------------------------------------------------------------------ */

let probed = null;

function probeNote(index) {
  const visible = events.slice(-WINDOW);
  const ev = index === null ? null : visible[index];
  probed = ev ?? null;
  for (const el of plot.querySelectorAll('.note.is-probed')) el.classList.remove('is-probed');
  if (ev) {
    const dot = plot.querySelectorAll('.note')[index];
    if (dot) dot.classList.add('is-probed');
    updateReadout(ev);
  } else {
    updateReadout(events[events.length - 1] ?? null);
  }
}

plot.addEventListener('pointerover', (e) => {
  const note = e.target.closest('.note');
  if (!note) return;
  const index = [...plot.querySelectorAll('.note')].indexOf(note);
  if (index >= 0) probeNote(index);
});
plot.addEventListener('pointerleave', () => probeNote(null));

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

buildScope();
drawIntervalFigure();
drawDwellFigure();
loadDemoTrace();

// Measured once the load is genuinely finished, so a resource still in
// flight cannot be missed and counted as zero.
window.addEventListener('load', () => setTimeout(auditNetwork, 400));
