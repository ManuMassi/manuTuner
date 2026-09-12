# manuTuner

A small, fast guitar tuner that runs in the browser. No dependencies, no build
step, no network access, no analytics. Audio is analysed on your device and
never recorded or sent anywhere.

Two files do the whole job: `web/index.html` and `web/pitch.js`.

## What it does

- **Auto string detection** — play any string and it works out which one you
  mean, with hysteresis so the readout doesn't flip between neighbouring
  strings while you're turning the peg.
- **Chromatic mode** — nearest semitone across the full range, for capos, bass,
  ukulele, or anything else.
- **Tunings** — Standard, Drop D, E♭, D, Drop C, Open G, Open D, DADGAD,
  4- and 5-string bass, ukulele.
- **Adjustable reference** — A4 from 432 to 446 Hz.
- **String lock** — tap a string to pin the tuner to it; tap again for auto.
- Green needle, and a haptic buzz where supported, inside ±3 cents.
- **Light, dark or automatic** theme, chosen from the masthead. Automatic
  follows the operating system.
- **Works on desktop as well as phones** — the full-bleed phone layout becomes
  a centred faceplate card at 700px and up, with keyboard control:
  <kbd>Space</kbd> starts and stops, <kbd>1</kbd>–<kbd>6</kbd> lock a string
  (numbered the way guitarists count them, so 6 is the low E).

Settings — mode, tuning, reference and theme — persist in `localStorage`. The
screen is kept awake while tuning via the Wake Lock API where supported.

## Running it

The microphone requires a **secure context**, so opening the file directly
with `file://` will not work. Serve it over localhost:

```
python3 -m http.server 8765 --directory web
```

Then open <http://localhost:8765>. For phone use, any HTTPS host will do.

`web/icon.png` is the home-screen icon (`apple-touch-icon`) and
`web/favicon.png` the tab icon, which also appears as the mark in the masthead.

## How the pitch detection works

`web/pitch.js` is the whole engine:

1. **6th-order Butterworth low-pass**, then decimation to ~12 kHz. This kills
   aliasing, cuts the autocorrelation cost 4x, and strips the upper partials
   that cause octave errors on wound strings. In the browser this runs as three
   native `BiquadFilterNode`s in the Web Audio graph, so the filter keeps
   correct continuous state and JavaScript only ever sees decimated samples.
   (The JS Butterworth in `pitch.js` exists for the Node test harness.)
2. **McLeod Pitch Method** — the normalised square difference function over
   lags 1…428, then McLeod peak picking: take the maximum of each positive
   region and accept the *earliest* one reaching 90% of the best. That
   "first peak above k·max" rule is what stops a strong second harmonic from
   reading as an octave-up error, which is the failure mode that makes naive
   autocorrelation tuners unusable on a low E.
3. **Parabolic interpolation** around the winning peak for sub-sample precision.
4. A median-of-5 filter then an EMA in the log-frequency domain, so the needle
   is steady without feeling laggy.

Direct time-domain autocorrelation is used rather than an FFT: with a
2048-sample window at 12 kHz there are only ~430 lags to evaluate, so the dot
products are already competitive with a forward/inverse FFT pair — and there is
no transform scaling to get subtly wrong.

`getUserMedia` is opened with `echoCancellation`, `noiseSuppression` and
`autoGainControl` all **off**. Without that the browser quietly reshapes the
signal and accuracy suffers.

`pitch.js` is deliberately pure ASCII (accidentals are `\u` escapes) so it
cannot be mangled by a server that omits a charset.

## Measured performance

Against synthetic plucked-string signals — harmonic stacks with weak
fundamentals, per-partial decay, string inharmonicity and noise:

| | |
|---|---|
| Mean absolute error | 1.24 cents |
| Accuracy, clean harmonic signal | ±0.08 cents |
| Octave errors across 37 semitones (E2–E5) | 0 |
| Auto string detection, all six strings 35 c flat | 6/6 |
| False detections on silence | 0 |
| Per analysis frame | 504 µs (~1.2% of one core at 23 Hz) |
| Update rate | 23 Hz |

The residual ~1.2 cents is the inharmonicity deliberately injected into the test
signal — real string stiffness sharpens the upper partials — not detector error.

## Layout

| File | |
|---|---|
| `web/pitch.js` | note maths, tunings, string matcher, MPM/NSDF detection |
| `web/index.html` | audio graph, smoothing, and the interface |
| `web/icon.png` | 512px home-screen icon |
| `web/favicon.png` | 128px tab icon, also the masthead mark |
| `.claude/launch.json` | local dev server config |
