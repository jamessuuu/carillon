# carillon

A keystroke-rhythm sonifier. You type in a text area, and the rhythm of your
typing (the gaps between keys, how long you hold each one down, backspaces)
gets turned into sound in real time, in your browser, with the Web Audio API.

Nothing you type is uploaded. There is no backend. The page makes no network
requests after it loads, and that claim is checked mechanically, not just
stated: see `verify.mjs` below.

## How it works

Two real, independent signals drive the sound:

- **Inter-key interval** (time since your last keystroke) sets pitch. Short
  interval, fast typing, high pitch. Long interval, a pause, low pitch. The
  interval is log-mapped before it picks a note, because typing speed is
  roughly log-normally distributed, and a straight linear map would crush
  normal typing into a narrow pitch band and let one long pause swing across
  the whole range.
- **Key dwell time** (how long you held a key down) sets loudness and
  brightness (a lowpass filter cutoff). A firmer or longer press reads as
  louder and brighter.

Every pitch is quantized to a fixed 2-octave scale (C major pentatonic, A
minor pentatonic, or D dorian, picked from the dropdown). That quantization
is the one decision doing the most work: it guarantees any two notes are
consonant with each other no matter what your typing rhythm looks like. There
is no rhythm that produces a wrong-sounding sequence.

Note release time also scales with the interval, so a fast burst of typing
overlaps into a legato run and slow, deliberate typing produces separated,
plucked notes. Backspace gets its own voice: a downward chirp plus a short
burst of filtered noise, a full octave below anything a forward keystroke can
reach, so a correction always sounds distinct from typing.

The pure mapping logic lives in `src/mapping.mjs`, with no DOM and no Web
Audio in it, specifically so it can be tested headlessly (see `tests/`). The
Web Audio synthesis is `src/audio.mjs`. The DOM wiring is `src/app.mjs`.

## Privacy, mechanically enforced

The page is mute-first: it is fully usable, and clearly labeled as sound-off,
before you click "Start sound." That click is the only place an
`AudioContext` gets created, so no sound ever starts without a real user
gesture. A visible "Stop sound" button suspends it at any time.

`verify.mjs` scans the shipped site (`index.html` plus everything under
`src/`) and fails with a non-zero exit code if it finds any of:

- a call to `fetch(`, `XMLHttpRequest`, or `navigator.sendBeacon`
- a `src=` or `href=` pointing at an `http(s)` URL
- a `<script src>` loaded from a CDN host
- an analytics- or telemetry-shaped identifier (`gtag(`, `dataLayer.push`,
  known vendor domains and library calls)

`tests/verify.test.mjs` proves every one of those rules actually fires,
against a dedicated fixture per rule under `tests/fixtures/verify/`, plus a
clean fixture that passes all of them, plus the real project itself.

## How to run

Open [`index.html`](index.html) directly in a browser for a live demo, or
serve the folder locally if your browser blocks module scripts over
`file://`:

```
python -m http.server 8000
```

then visit `http://localhost:8000/`.

## Development

No dependencies to install. From this directory:

```
npm test
```

This runs the test suite (`node --test`) and then `verify.mjs` against the
real project. As of this writing that is 37 tests, all passing: 20 covering
the pure rhythm-to-sound mapping in `src/mapping.mjs`, and 17 covering
`verify.mjs` itself (its scan logic as a library, its CLI exit code, and that
every fixture actually trips its intended rule).

## Limitations

- The musical mapping was tuned by ear against one person's typing, on one
  keyboard. It has not been tested across a range of keyboards, browsers, or
  typing styles, and there is no claim here that it sounds equally good for
  everyone.
- This does not attempt to identify who is typing, and makes no claim about
  keystroke rhythm being a reliable way to recognize a person. It is an
  instrument, not a biometric.
- Backspace is sonified once per key press and release, even if the browser's
  own key-repeat deletes several characters while the key is held. The sound
  tracks key events, not the exact number of characters removed.
- Timing is read with `performance.now()` inside the browser's own event
  loop, which is not a hard real-time clock. Under heavy load on the page or
  the machine, timing can jitter by a few milliseconds. This has not been a
  problem in testing, but it is not guaranteed.
- No mobile/touch input handling: this is built and tested for a physical
  keyboard. On-screen keyboards don't produce the same keydown/keyup timing
  and have not been tested.
- Tested manually against Chromium (via an automated browser driver) serving
  the folder over a local static server. It has not been tested against
  Firefox or Safari, or from a plain double-clicked `file://` page, where
  browsers commonly refuse to load ES module scripts due to CORS
  restrictions on the `file:` scheme, which is why the "How to run" section
  above recommends a local server.

## Deployment

`vercel.json` sets `"outputDirectory": "."` &mdash; the whole repository,
not a subfolder &mdash; because two things need to be reachable at once: the
app itself (`index.html` plus `src/`, at the deployed root, unchanged) and a
separate landing page (`site/index.html`, at `/site`) that describes the
project and links back to the app. Vercel cannot hold a comment inside
`vercel.json` (a non-standard key like `"_comment"` makes the whole file
invalid), so the reasoning lives here instead:

- `/` &rarr; `index.html`, the real, working app. Nothing about it moved.
- `/site` &rarr; `site/index.html`, the landing page, in the same
  proofpage-derived template as this project's siblings.
- `/README.md` stays reachable too, because the app's own privacy section
  links to it (`<a href="README.md">`), and that link would otherwise break.
- Everything else in the repo (`src/`, `verify.mjs`, `tests/`, `LICENSE`,
  `package.json`) is also served as plain static files under this setting.
  None of it is sensitive; it is all source a stranger is meant to be able
  to read, in keeping with what `verify.mjs` already proves about the app.

The Content-Security-Policy in `vercel.json` is one policy shared by every
path, and it is looser than the other two projects' `default-src 'none'`:
it adds `script-src 'self'`, because the real app (unlike its landing page)
loads `<script type="module" src="src/app.mjs">`, a same-origin script the
page cannot run without permission to execute it. The landing page itself
still ships zero `<script>` tags; the wider policy exists for the app, not
because the landing page needed it.

## License

MIT. See `LICENSE`.
