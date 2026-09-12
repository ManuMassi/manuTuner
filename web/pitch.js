/*
 * Pitch detection for the web tuner -- a direct port of PitchDetector.swift.
 *
 * McLeod Pitch Method (normalised square difference function) with parabolic
 * peak interpolation. In the browser the anti-alias low-pass is done by native
 * BiquadFilterNodes in the audio graph, so only the NSDF stage lives here; the
 * JS Butterworth below exists for the Node test harness and as a fallback.
 *
 * Works as a plain <script> (defines window.Tuner) or via require() in Node.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- notes

  var NOTE_NAMES = ['C', 'C\u266F', 'D', 'D\u266F', 'E', 'F', 'F\u266F', 'G', 'G\u266F', 'A', 'A\u266F', 'B'];

  function noteName(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12]; }
  function noteOctave(midi) { return Math.floor(midi / 12) - 1; }
  function noteLabel(midi) { return noteName(midi) + noteOctave(midi); }
  function freqFromMidi(midi, a4) { return a4 * Math.pow(2, (midi - 69) / 12); }
  function midiFromFreq(f, a4) { return 69 + 12 * Math.log2(f / a4); }
  function centsBetween(f, target) { return 1200 * Math.log2(f / target); }

  // ------------------------------------------------------------- tunings

  var TUNINGS = [
    { id: 'standard', name: 'Standard',       instrument: 'Guitar',  midis: [40, 45, 50, 55, 59, 64] },
    { id: 'dropD',    name: 'Drop D',         instrument: 'Guitar',  midis: [38, 45, 50, 55, 59, 64] },
    { id: 'halfDown', name: 'E\u266D (\u00BD step)',    instrument: 'Guitar',  midis: [39, 44, 49, 54, 58, 63] },
    { id: 'fullDown', name: 'D (whole step)', instrument: 'Guitar',  midis: [38, 43, 48, 53, 57, 62] },
    { id: 'dropC',    name: 'Drop C',         instrument: 'Guitar',  midis: [36, 43, 48, 53, 57, 62] },
    { id: 'openG',    name: 'Open G',         instrument: 'Guitar',  midis: [38, 43, 50, 55, 59, 62] },
    { id: 'openD',    name: 'Open D',         instrument: 'Guitar',  midis: [38, 45, 50, 54, 57, 62] },
    { id: 'dadgad',   name: 'DADGAD',         instrument: 'Guitar',  midis: [38, 45, 50, 55, 57, 62] },
    { id: 'bass4',    name: 'Standard',       instrument: 'Bass',    midis: [28, 33, 38, 43] },
    { id: 'bass5',    name: '5-string',       instrument: 'Bass',    midis: [23, 28, 33, 38, 43] },
    { id: 'ukulele',  name: 'Standard',       instrument: 'Ukulele', midis: [67, 60, 64, 69] }
  ];

  var IN_TUNE_CENTS = 3.0;

  /* Picks which string the player means, with hysteresis so the readout does
     not flicker between neighbours while bending in. */
  function StringMatcher() {
    this.holdRange = 400;
    this.switchMargin = 60;
    this.framesToSwitch = 3;
    this.index = null;
    this._candidate = null;
    this._frames = 0;
  }

  StringMatcher.prototype.reset = function () {
    this.index = null;
    this._candidate = null;
    this._frames = 0;
  };

  StringMatcher.prototype.update = function (midiValue, midis) {
    var distances = midis.map(function (m) { return Math.abs(midiValue - m) * 100; });
    var best = 0;
    for (var i = 1; i < distances.length; i++) {
      if (distances[i] < distances[best]) best = i;
    }

    if (this.index === null || this.index >= distances.length) {
      this.index = best;
      this._candidate = null;
      this._frames = 0;
      return best;
    }

    var current = this.index;
    if (best === current) {
      this._candidate = null;
      this._frames = 0;
      return current;
    }

    var stillPlausible = distances[current] <= this.holdRange;
    var clearlyCloser = distances[best] < distances[current] - this.switchMargin;
    if (stillPlausible && !clearlyCloser) {
      this._candidate = null;
      this._frames = 0;
      return current;
    }

    if (this._candidate === best) this._frames++;
    else { this._candidate = best; this._frames = 1; }

    if (this._frames >= this.framesToSwitch) {
      this.index = best;
      this._candidate = null;
      this._frames = 0;
      return best;
    }
    return current;
  };

  // ------------------------------------------------------ low-pass (Node)

  function Biquad(cutoff, sampleRate, q) {
    var w = 2 * Math.PI * Math.min(cutoff, sampleRate * 0.49) / sampleRate;
    var cosW = Math.cos(w);
    var alpha = Math.sin(w) / (2 * q);
    var a0 = 1 + alpha;
    this.b0 = (1 - cosW) / 2 / a0;
    this.b1 = (1 - cosW) / a0;
    this.b2 = this.b0;
    this.a1 = -2 * cosW / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  Biquad.prototype.process = function (x) {
    var y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  };

  /* Butterworth pole Qs for order 6 -- the same values the browser graph uses. */
  var BUTTERWORTH_Q = [0.51763809, 0.70710678, 1.93185165];

  function ButterworthLowPass(cutoff, sampleRate) {
    this.sections = BUTTERWORTH_Q.map(function (q) {
      return new Biquad(cutoff, sampleRate, q);
    });
  }

  ButterworthLowPass.prototype.process = function (x) {
    var y = x;
    for (var i = 0; i < this.sections.length; i++) y = this.sections[i].process(y);
    return y;
  };

  // --------------------------------------------------------- MPM detector

  function NSDFDetector(workRate, windowSize, opts) {
    opts = opts || {};
    this.workRate = workRate;
    this.n = windowSize || 2048;
    this.minFrequency = opts.minFrequency || 28;
    this.maxFrequency = opts.maxFrequency || 1500;
    this.peakThreshold = opts.peakThreshold || 0.9;
    this.minClarity = opts.minClarity || 0.55;
    this.noiseFloor = opts.noiseFloor || 0.001;

    this.maxLag = Math.min(this.n >> 1, Math.floor(workRate / this.minFrequency));
    this.minLag = Math.max(2, Math.floor(workRate / this.maxFrequency));

    this.buf = new Float32Array(this.n);
    this.sq = new Float32Array(this.n);
    this.nsdf = new Float32Array(this.maxLag + 2);
  }

  /**
   * @param {Float32Array} samples exactly `n` samples at `workRate`.
   * @returns {{frequency:number, clarity:number, rms:number}} frequency 0 if none.
   */
  NSDFDetector.prototype.detect = function (samples) {
    var n = this.n, w = this.buf, sq = this.sq, nsdf = this.nsdf;
    var i, tau;

    var mean = 0;
    for (i = 0; i < n; i++) mean += samples[i];
    mean /= n;

    var power = 0;
    for (i = 0; i < n; i++) {
      var v = samples[i] - mean;
      w[i] = v;
      var s = v * v;
      sq[i] = s;
      power += s;
    }

    var rms = Math.sqrt(power / n);
    if (!(rms > this.noiseFloor) || !isFinite(rms)) {
      return { frequency: 0, clarity: 0, rms: isFinite(rms) ? rms : 0 };
    }

    nsdf[0] = 1;
    var m = 2 * power;
    var maxLag = this.maxLag;
    for (tau = 1; tau <= maxLag; tau++) {
      m -= sq[n - tau] + sq[tau - 1];
      var r = 0;
      var limit = n - tau;
      for (i = 0; i < limit; i++) r += w[i] * w[i + tau];
      nsdf[tau] = m > 1e-9 ? (2 * r / m) : 0;
    }
    nsdf[maxLag + 1] = 0;

    var peak = this._pickPeak();
    if (!peak) return { frequency: 0, clarity: 0, rms: rms };
    return { frequency: this.workRate / peak.lag, clarity: peak.value, rms: rms };
  };

  /* Maximum of each positive region, then the EARLIEST region reaching
     peakThreshold x globalMax. That rule is what stops a strong second
     harmonic from reading as an octave up. */
  NSDFDetector.prototype._pickPeak = function () {
    var nsdf = this.nsdf, maxLag = this.maxLag;
    var lags = [], vals = [];
    var i = 1;

    while (i <= maxLag && nsdf[i] > 0) i++;          // leave the tau=0 lobe

    while (i <= maxLag) {
      while (i <= maxLag && nsdf[i] <= 0) i++;
      if (i > maxLag) break;
      var lag = i, val = nsdf[i];
      while (i <= maxLag && nsdf[i] > 0) {
        if (nsdf[i] > val) { val = nsdf[i]; lag = i; }
        i++;
      }
      if (lag >= this.minLag) { lags.push(lag); vals.push(val); }
    }

    if (!vals.length) return null;
    var globalMax = Math.max.apply(null, vals);
    if (!(globalMax >= this.minClarity)) return null;

    var threshold = this.peakThreshold * globalMax;
    for (var k = 0; k < vals.length; k++) {
      if (vals[k] >= threshold) return this._interpolate(lags[k]);
    }
    return null;
  };

  NSDFDetector.prototype._interpolate = function (lag) {
    var nsdf = this.nsdf;
    if (lag < 1 || lag + 1 > this.maxLag) {
      return { lag: lag, value: Math.min(1, Math.max(0, nsdf[lag])) };
    }
    var y0 = nsdf[lag - 1], y1 = nsdf[lag], y2 = nsdf[lag + 1];
    var denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) <= 1e-9) {
      return { lag: lag, value: Math.min(1, Math.max(0, y1)) };
    }
    var shift = 0.5 * (y0 - y2) / denom;
    shift = Math.min(1, Math.max(-1, shift));
    var value = y1 - 0.25 * (y0 - y2) * shift;
    return { lag: lag + shift, value: Math.min(1, Math.max(0, value)) };
  };

  var api = {
    NOTE_NAMES: NOTE_NAMES,
    noteName: noteName,
    noteOctave: noteOctave,
    noteLabel: noteLabel,
    freqFromMidi: freqFromMidi,
    midiFromFreq: midiFromFreq,
    centsBetween: centsBetween,
    TUNINGS: TUNINGS,
    IN_TUNE_CENTS: IN_TUNE_CENTS,
    BUTTERWORTH_Q: BUTTERWORTH_Q,
    StringMatcher: StringMatcher,
    Biquad: Biquad,
    ButterworthLowPass: ButterworthLowPass,
    NSDFDetector: NSDFDetector
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Tuner = api;
})(typeof self !== 'undefined' ? self : this);
