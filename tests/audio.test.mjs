import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_CONTEXT_NAMES,
  AudioUnavailableError,
  createEngine,
  resolveAudioContextCtor,
  resumeEngine,
} from '../src/audio.mjs';

// Minimal stand-in for a Web Audio context: enough surface for createEngine
// to wire its master gain and delay send, plus a record of what was called.
// Every node is the same shape because createEngine only ever connects them.
function makeFakeContextClass(log) {
  const node = () => ({
    gain: { value: 0 },
    delayTime: { value: 0 },
    connect(target) {
      log.push(['connect', target === log.destination ? 'destination' : 'node']);
    },
  });
  return class FakeAudioContext {
    constructor() {
      log.push(['construct']);
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.destination = {};
      log.destination = this.destination;
    }
    createGain() { log.push(['createGain']); return node(); }
    createDelay(max) { log.push(['createDelay', max]); return node(); }
    async resume() { log.push(['resume']); this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
  };
}

// The three shapes of global object a visitor's browser can present.
const chromiumShaped = () => ({ AudioContext: makeFakeContextClass([]) });
const oldSafariShaped = () => ({ webkitAudioContext: makeFakeContextClass([]) });
// Exactly what Playwright's WebKit build for Windows exposed in the
// 2026-09-06 sweep (probed on the live site and on about:blank): the
// <audio> element family only, no Web Audio at all. These are functions, so a
// lookup that merely checked "is there anything audio-ish on window" would be
// fooled; the lookup has to ask for the two constructor names specifically.
const webkitForWindowsShaped = () => ({
  HTMLAudioElement: function HTMLAudioElement() {},
  Audio: function Audio() {},
  AudioTrack: function AudioTrack() {},
  AudioTrackConfiguration: function AudioTrackConfiguration() {},
  AudioTrackList: function AudioTrackList() {},
});

test('the lookup tries the unprefixed name first, then the legacy webkit prefix', () => {
  assert.deepEqual([...AUDIO_CONTEXT_NAMES], ['AudioContext', 'webkitAudioContext']);
});

test('Chromium-shaped global: resolves the unprefixed AudioContext', () => {
  const g = chromiumShaped();
  const { ctor, name } = resolveAudioContextCtor(g);
  assert.equal(ctor, g.AudioContext);
  assert.equal(name, 'AudioContext');
});

test('old-Safari-shaped global (webkitAudioContext only): resolves the prefixed constructor', () => {
  const g = oldSafariShaped();
  const { ctor, name } = resolveAudioContextCtor(g);
  assert.equal(ctor, g.webkitAudioContext);
  assert.equal(name, 'webkitAudioContext');
});

test('when both names exist, the unprefixed one wins', () => {
  const unprefixed = makeFakeContextClass([]);
  const prefixed = makeFakeContextClass([]);
  const { ctor, name } = resolveAudioContextCtor({ AudioContext: unprefixed, webkitAudioContext: prefixed });
  assert.equal(ctor, unprefixed);
  assert.equal(name, 'AudioContext');
});

test('WebKit-for-Windows-shaped global (no Web Audio at all): resolves to nothing, without throwing', () => {
  const { ctor, name } = resolveAudioContextCtor(webkitForWindowsShaped());
  assert.equal(ctor, null);
  assert.equal(name, null);
});

test('a non-function under either name is not a constructor and is skipped', () => {
  assert.equal(resolveAudioContextCtor({ AudioContext: undefined }).ctor, null);
  assert.equal(resolveAudioContextCtor({ AudioContext: 'AudioContext' }).ctor, null);
  assert.equal(resolveAudioContextCtor({ webkitAudioContext: {} }).ctor, null);
  assert.equal(resolveAudioContextCtor(null).ctor, null);
  assert.equal(resolveAudioContextCtor(undefined).ctor, null);
});

test('createEngine on a Chromium-shaped global constructs exactly one context and wires master -> destination', () => {
  const log = [];
  const g = { AudioContext: makeFakeContextClass(log) };
  const engine = createEngine(g);
  assert.ok(engine.ctx instanceof g.AudioContext);
  assert.ok(engine.master);
  assert.ok(engine.delaySend);
  assert.equal(log.filter((e) => e[0] === 'construct').length, 1);
  assert.ok(log.some((e) => e[0] === 'connect' && e[1] === 'destination'), 'master gain must reach the destination');
  assert.ok(log.some((e) => e[0] === 'createDelay'), 'the room send must be built');
});

test('createEngine on an old-Safari-shaped global uses webkitAudioContext', () => {
  const log = [];
  const g = { webkitAudioContext: makeFakeContextClass(log) };
  const engine = createEngine(g);
  assert.ok(engine.ctx instanceof g.webkitAudioContext);
  assert.equal(log.filter((e) => e[0] === 'construct').length, 1);
});

test('createEngine on a WebKit-for-Windows-shaped global throws AudioUnavailableError(no-web-audio) naming both missing names', () => {
  assert.throws(
    () => createEngine(webkitForWindowsShaped()),
    (err) => {
      assert.ok(err instanceof AudioUnavailableError);
      assert.equal(err.name, 'AudioUnavailableError');
      assert.equal(err.reason, 'no-web-audio');
      assert.match(err.message, /AudioContext/);
      assert.match(err.message, /webkitAudioContext/);
      assert.match(err.message, /Typing still works/);
      return true;
    },
  );
});

test('createEngine never evaluates `new undefined()`: the failure is typed, not a TypeError', () => {
  // This is the exact crash the sweep caught: "undefined is not a constructor
  // (evaluating 'new AudioCtx()')". The only acceptable error now is ours.
  let caught;
  try {
    createEngine({});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected createEngine to throw');
  assert.ok(caught instanceof AudioUnavailableError);
  assert.ok(!(caught instanceof TypeError), 'must not be the raw engine TypeError');
  assert.doesNotMatch(caught.message, /is not a constructor/);
});

test('createEngine wraps a constructor that throws as AudioUnavailableError(construct-failed) with the cause attached', () => {
  class RefusingContext {
    constructor() {
      throw new Error('NotAllowedError: audio hardware unavailable');
    }
  }
  assert.throws(
    () => createEngine({ AudioContext: RefusingContext }),
    (err) => {
      assert.ok(err instanceof AudioUnavailableError);
      assert.equal(err.reason, 'construct-failed');
      assert.match(err.message, /new AudioContext\(\) failed/);
      assert.match(err.message, /audio hardware unavailable/);
      assert.ok(err.cause instanceof Error);
      return true;
    },
  );
});

test('resumeEngine resumes a suspended context and reports the resulting state', async () => {
  const log = [];
  const engine = createEngine({ AudioContext: makeFakeContextClass(log) });
  assert.equal(engine.ctx.state, 'suspended');
  const state = await resumeEngine(engine);
  assert.equal(state, 'running');
  assert.equal(log.filter((e) => e[0] === 'resume').length, 1);
});

test('resumeEngine does not call resume() on a context that is already running', async () => {
  const log = [];
  const engine = createEngine({ AudioContext: makeFakeContextClass(log) });
  engine.ctx.state = 'running';
  const state = await resumeEngine(engine);
  assert.equal(state, 'running');
  assert.equal(log.filter((e) => e[0] === 'resume').length, 0);
});

test('resumeEngine reports honestly when the browser leaves the context suspended', async () => {
  class StubbornContext extends makeFakeContextClass([]) {
    async resume() {
      /* the browser declined; state stays suspended */
    }
  }
  const engine = createEngine({ AudioContext: StubbornContext });
  const state = await resumeEngine(engine);
  assert.equal(state, 'suspended');
});
