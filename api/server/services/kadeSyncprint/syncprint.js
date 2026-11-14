/*
 * syncprint.js
 *
 * Finds where a film is, from a few seconds of its sound.
 *
 * A server makes a small fingerprint of a film's soundtrack once. A phone
 * records a few seconds of what the television is playing, and this library
 * says which moment of the film that is, so that description lines can be
 * spoken at the right time. No film audio is stored or sent: only the
 * positions of the strongest spectral peaks (time and frequency).
 *
 * One file, no dependencies, plain old JavaScript (ES5 plus typed arrays):
 * it runs in Node, in a bare iOS JavaScriptCore context (interpreter only),
 * in Android JavaScript engines and in browsers. It uses no console, timers,
 * Buffer, TextEncoder, atob, require, import, BigInt or Promises.
 * Nothing throws across the public API: bad input gives null or an object
 * with an error field.
 *
 * Method: landmark hashing in the style of Wang (Shazam, 2003) and Dan
 * Ellis's audfprint. See README.md for the API and the binary format.
 */
(function (root) {
  'use strict';

  var VERSION = '1.1.0';
  var FORMAT_VERSION = 1;
  var MAGIC = [0x53, 0x59, 0x50, 0x52]; // "SYPR"
  var HEADER_BYTES = 48;
  var EPS_POWER = 1e-9; // added before the logarithm; digital silence stays flat
  var MAX_CLIP_SEC = 600;
  var MAX_WINDOW_SEC = 60; // the search near an expected position never looks further than this
  var GAIN_KEEP = 8; // the tracker keeps this many room-level readings

  // ------------------------------------------------------------------
  // Parameters. Every value here was chosen by measurement on the tuning
  // half of the bench; see RESULTS.md.
  // ------------------------------------------------------------------
  var DEFAULTS = {
    sampleRate: 8000, // input must be 8 kHz mono
    fftSize: 512, // 64 ms window
    hop: 256, // 32 ms between frames, 31.25 frames a second
    binLo: 19, // lowest frequency bin used (about 300 Hz)
    binHi: 218, // highest frequency bin used (about 3400 Hz)
    normFrames: 24, // each bin is compared with its own average over this many frames each side
    levelFrames: 16, // one loudness value is stored for every 16 frames

    // peak picking for the film (the reference)
    spread: 30, // width in bins of the masking bump a peak leaves behind
    decay: 0.9, // how fast that bump fades, per frame
    floor: 0.0, // a peak must stand this far above its bin's average (natural log units)
    maxPerFrame: 5,

    // peak picking for the clip (the query); the same as the film by default
    qSpread: 30,
    qDecay: 0.9,
    qFloor: 0.0,
    qMaxPerFrame: 5,
    qBackward: 1, // 1: prune backwards in time as for the film

    // pairing peaks into landmarks
    fanout: 5, // film: each peak is paired with up to this many later peaks
    qFanout: 0, // clip: 0 means every later peak in the target zone
    dtMin: 1, // target zone: 1 to dtMax frames later
    dtMax: 32,
    dfMax: 31, // target zone: within this many bins up or down

    // deciding
    minClipSec: 1.5,
    clampLo: 2.0, // clip-map values are limited to -clampLo .. +clampHi (natural log units)
    clampHi: 4.0,
    candidates: 60, // how many vote winners are checked against the clip's spectrum
    wide: 1, // 1: when landmarks give nothing convincing, run the wide pass
    wideBelow: 12.0, // "convincing" is a score at or above this
    wideFloor: 2.0, // the clip's spectrum points that vote in the wide pass stand this far above average
    wideSigma: 3.0, // an offset is checked when its votes stand this many deviations above chance
    wideCandidates: 100,
    seedVotes: 2, // a time offset needs this many votes in one bin to be checked
    minVotes: 2, // votes needed (three neighbouring bins summed)
    minScore: 7.0, // score needed when nothing is known about the position
    nearMinScore: 5.0, // score needed at a position near the expected one
    minPeaks: 24, // film peaks needed under the clip for a score to count
    ambiguousRatio: 0.7, // a second place this close to the winner makes the answer ambiguous
    fullScore: 20.0, // score at which confidence reaches 1
    windowSec: 3.0, // how near the expected time counts as near
    quietDropDb: 25, // the film is "quiet" when this far below its usual loud level
    silenceDb: 10 // a missed clip this far below the film's expected loudness, as heard in this room, is "silence"
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  var hasOwn = Object.prototype.hasOwnProperty;

  function isNum(x) {
    return typeof x === 'number' && x === x && x !== Infinity && x !== -Infinity;
  }

  function isInt(x, lo, hi) {
    return isNum(x) && x === Math.floor(x) && x >= lo && x <= hi;
  }

  function isSamples(x) {
    return (x instanceof Float32Array) || (x instanceof Int16Array) || (x instanceof Float64Array);
  }

  // Copies base, then takes every key of base that over has as a finite number.
  // Reads only the keys it knows, and never lets a strange object throw.
  function copyParams(base, over) {
    var out = {};
    var k, v;
    for (k in base) {
      if (hasOwn.call(base, k)) out[k] = base[k];
    }
    if (over && typeof over === 'object') {
      for (k in base) {
        if (!hasOwn.call(base, k)) continue;
        try {
          if (!hasOwn.call(over, k)) continue;
          v = over[k];
        } catch (e) {
          continue;
        }
        if (isNum(v)) out[k] = v;
      }
    }
    return out;
  }

  // TypedArray.prototype.fill arrived with ES2015; fall back to a loop where it is missing.
  function zeroFill(a, n) {
    if (typeof a.fill === 'function') {
      a.fill(0, 0, n);
      return;
    }
    for (var i = 0; i < n; i++) a[i] = 0;
  }

  function isPow2(n) {
    return n > 0 && (n & (n - 1)) === 0;
  }

  // Checks a parameter set. Returns '' when fine, or what is wrong.
  function paramProblem(p) {
    if (p.sampleRate !== 8000) return 'sampleRate must be 8000';
    if (!isPow2(p.fftSize) || p.fftSize < 128 || p.fftSize > 4096) return 'fftSize';
    if (p.hop !== Math.floor(p.hop) || p.hop < 16 || p.hop > p.fftSize) return 'hop';
    if (p.binLo !== Math.floor(p.binLo) || p.binHi !== Math.floor(p.binHi)) return 'bins';
    if (p.binLo < 2 || p.binHi > p.fftSize / 2 - 2 || p.binHi - p.binLo < 7) return 'bins';
    if (p.binHi - p.binLo + 1 > 1024) return 'bins';
    if (p.normFrames !== Math.floor(p.normFrames) || p.normFrames < 1 || p.normFrames > 255) return 'normFrames';
    if (p.levelFrames !== Math.floor(p.levelFrames) || p.levelFrames < 1 || p.levelFrames > 255) return 'levelFrames';
    if (p.maxPerFrame !== Math.floor(p.maxPerFrame) || p.maxPerFrame < 1 || p.maxPerFrame > 64) return 'maxPerFrame';
    if (p.fanout !== Math.floor(p.fanout) || p.fanout < 1 || p.fanout > 64) return 'fanout';
    if (p.dtMin !== Math.floor(p.dtMin) || p.dtMax !== Math.floor(p.dtMax) || p.dtMin < 1 || p.dtMax < p.dtMin || p.dtMax > 255) return 'dt';
    if (p.dfMax !== Math.floor(p.dfMax) || p.dfMax < 1 || p.dfMax > 255) return 'dfMax';
    if (!(p.spread >= 1 && p.spread <= 255)) return 'spread';
    if (!(p.decay > 0.5 && p.decay < 1)) return 'decay';
    if (!(p.floor >= 0 && p.floor < 50)) return 'floor';
    var hashes = (p.binHi - p.binLo + 1) * (2 * p.dfMax + 1) * (p.dtMax - p.dtMin + 1);
    if (hashes > 16777216) return 'hash space too large';
    return '';
  }

  // Checks a whole configuration: the print settings above, then the clip side
  // and the decision settings, which are not stored in a print.
  function configProblem(p) {
    var bad = paramProblem(p);
    if (bad) return bad;
    if (!(p.qSpread >= 1 && p.qSpread <= 255)) return 'qSpread';
    if (!(p.qDecay > 0.5 && p.qDecay < 1)) return 'qDecay';
    if (!(p.qFloor >= 0 && p.qFloor < 50)) return 'qFloor';
    if (!isInt(p.qMaxPerFrame, 1, 64)) return 'qMaxPerFrame';
    if (!isInt(p.qFanout, 0, 1024)) return 'qFanout';
    if (!(p.clampLo > 0 && p.clampHi > 0)) return 'clamp';
    if (!isInt(p.candidates, 1, 100000) || !isInt(p.wideCandidates, 1, 100000)) return 'candidates';
    if (!isInt(p.seedVotes, 1, 1000000) || !(p.minVotes >= 0)) return 'votes';
    if (!(p.wideFloor >= 0 && p.wideSigma >= 0)) return 'wide';
    if (!(p.minClipSec > 0 && p.minClipSec <= MAX_CLIP_SEC)) return 'minClipSec';
    if (!isInt(p.minPeaks, 1, 1000000)) return 'minPeaks';
    if (!(p.ambiguousRatio > 0)) return 'ambiguousRatio';
    if (!(p.fullScore > p.minScore && p.fullScore > p.nearMinScore)) return 'fullScore';
    if (!(p.windowSec > 0 && p.windowSec <= MAX_WINDOW_SEC)) return 'windowSec';
    if (!(p.quietDropDb >= 0 && p.silenceDb >= 0)) return 'quiet';
    return '';
  }

  // ------------------------------------------------------------------
  // FFT: real input of N samples, through a complex transform of N/2 points.
  // Radix 4, written flat so that an interpreter runs it quickly.
  // ------------------------------------------------------------------
  var fftPlans = {};

  function getPlan(N) {
    if (fftPlans[N]) return fftPlans[N];
    var M = N >> 1;
    var logM = 0;
    while ((1 << logM) < M) logM++;
    var rev = new Uint16Array(M);
    var i, b, r;
    for (i = 0; i < M; i++) {
      r = 0;
      for (b = 0; b < logM; b++) {
        if (i & (1 << b)) r |= 1 << (logM - 1 - b);
      }
      rev[i] = r;
    }
    var cosT = new Float64Array(M);
    var sinT = new Float64Array(M);
    for (i = 0; i < M; i++) {
      cosT[i] = Math.cos(2 * Math.PI * i / M);
      sinT[i] = -Math.sin(2 * Math.PI * i / M);
    }
    // Hann window, periodic form: w[n] = 0.5 - 0.5 cos(2 pi n / N)
    var win = new Float64Array(N);
    var win16 = new Float64Array(N); // the same, for 16-bit input (divides by 32768)
    for (i = 0; i < N; i++) {
      win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
      win16[i] = win[i] / 32768;
    }
    var pc = new Float64Array(M + 1);
    var ps = new Float64Array(M + 1);
    for (i = 0; i <= M; i++) {
      pc[i] = Math.cos(2 * Math.PI * i / N);
      ps[i] = -Math.sin(2 * Math.PI * i / N);
    }
    var plan = {
      N: N, M: M, odd: logM & 1, rev: rev, cosT: cosT, sinT: sinT,
      win: win, win16: win16, pc: pc, ps: ps,
      re: new Float64Array(M), im: new Float64Array(M)
    };
    fftPlans[N] = plan;
    return plan;
  }

  function fftCore(plan) {
    var re = plan.re, im = plan.im, M = plan.M, cosT = plan.cosT, sinT = plan.sinT;
    var i, j, i1, i2, i3, h, block, stride, q;
    var ar, ai, xr, xi, t1r, t1i, t2r, t2i, t3r, t3i;
    var s0r, s0i, s1r, s1i, s2r, s2i, s3r, s3i;
    var w1r, w1i, w2r, w2i, w3r, w3i;
    h = 1;
    if (plan.odd) {
      for (i = 0; i < M; i += 2) {
        ar = re[i]; ai = im[i]; xr = re[i + 1]; xi = im[i + 1];
        re[i] = ar + xr; im[i] = ai + xi;
        re[i + 1] = ar - xr; im[i + 1] = ai - xi;
      }
      h = 2;
    }
    while (h < M) {
      block = h << 2;
      stride = M / block;
      // j = 0: all three twiddle factors are 1
      for (i = 0; i < M; i += block) {
        i1 = i + h; i2 = i1 + h; i3 = i2 + h;
        ar = re[i]; ai = im[i];
        t1r = re[i1]; t1i = im[i1];
        t2r = re[i2]; t2i = im[i2];
        t3r = re[i3]; t3i = im[i3];
        s0r = ar + t1r; s0i = ai + t1i; s1r = ar - t1r; s1i = ai - t1i;
        s2r = t2r + t3r; s2i = t2i + t3i; s3r = t2r - t3r; s3i = t2i - t3i;
        re[i] = s0r + s2r; im[i] = s0i + s2i;
        re[i2] = s0r - s2r; im[i2] = s0i - s2i;
        re[i1] = s1r + s3i; im[i1] = s1i - s3r;
        re[i3] = s1r - s3i; im[i3] = s1i + s3r;
      }
      for (j = 1; j < h; j++) {
        q = j * stride;
        w2r = cosT[q]; w2i = sinT[q];
        w1r = cosT[2 * q]; w1i = sinT[2 * q];
        w3r = cosT[3 * q]; w3i = sinT[3 * q];
        for (i = j; i < M; i += block) {
          i1 = i + h; i2 = i1 + h; i3 = i2 + h;
          ar = re[i]; ai = im[i];
          xr = re[i1]; xi = im[i1];
          t1r = xr * w1r - xi * w1i; t1i = xr * w1i + xi * w1r;
          xr = re[i2]; xi = im[i2];
          t2r = xr * w2r - xi * w2i; t2i = xr * w2i + xi * w2r;
          xr = re[i3]; xi = im[i3];
          t3r = xr * w3r - xi * w3i; t3i = xr * w3i + xi * w3r;
          s0r = ar + t1r; s0i = ai + t1i; s1r = ar - t1r; s1i = ai - t1i;
          s2r = t2r + t3r; s2i = t2i + t3i; s3r = t2r - t3r; s3i = t2i - t3i;
          re[i] = s0r + s2r; im[i] = s0i + s2i;
          re[i2] = s0r - s2r; im[i2] = s0i - s2i;
          re[i1] = s1r + s3i; im[i1] = s1i - s3r;
          re[i3] = s1r - s3i; im[i3] = s1i + s3r;
        }
      }
      h = block;
    }
  }

  // Power spectrum of one frame, for bins lo to hi inclusive, written to out[0..hi-lo].
  // Power is |sum over n of w[n] x[n] exp(-2 pi i k n / N)| squared, with x in -1..1.
  function framePower(plan, samples, off, is16, lo, hi, out) {
    var re = plan.re, im = plan.im, rev = plan.rev, M = plan.M;
    var win = is16 ? plan.win16 : plan.win;
    var i, n, r, k;
    for (i = 0, n = off; i < M; i++, n += 2) {
      r = rev[i];
      re[r] = samples[n] * win[i + i];
      im[r] = samples[n + 1] * win[i + i + 1];
    }
    fftCore(plan);
    var pc = plan.pc, ps = plan.ps;
    var ar, ai, br, bi, er, ei, pr, pi, wr, wi, xr, xi, p;
    for (k = lo; k <= hi; k++) {
      ar = re[k]; ai = im[k]; br = re[M - k]; bi = im[M - k];
      er = ar + br; ei = ai - bi;
      pr = ai + bi; pi = br - ar;
      wr = pc[k]; wi = ps[k];
      xr = er + wr * pr - wi * pi;
      xi = ei + wr * pi + wi * pr;
      p = (xr * xr + xi * xi) * 0.25;
      out[k - lo] = p < 1e30 ? p : 0; // also turns NaN into 0
    }
  }

  // ------------------------------------------------------------------
  // The peak picker. Rows of log power go in one frame at a time; the
  // strongest spectral peaks come out.
  // ------------------------------------------------------------------
  function Picker(cfg, query) {
    var nb = cfg.binHi - cfg.binLo + 1;
    var width = nb + 2; // one guard bin each side
    this.nb = nb;
    this.width = width;
    this.W = cfg.normFrames;
    this.ringN = 2 * this.W + 1;
    this.ring = new Float32Array(this.ringN * width);
    this.sum = new Float64Array(width);
    this.norm = new Float64Array(width);
    this.nIn = 0;
    this.spread = query ? cfg.qSpread : cfg.spread;
    this.decay = query ? cfg.qDecay : cfg.decay;
    this.floor = query ? cfg.qFloor : cfg.floor;
    this.maxPer = query ? cfg.qMaxPerFrame : cfg.maxPerFrame;
    this.backward = query ? (cfg.qBackward ? 1 : 0) : 1;
    var R = Math.min(width, Math.ceil(3 * this.spread));
    this.R = R;
    this.G = new Float64Array(R + 1);
    var i;
    for (i = 0; i <= R; i++) this.G[i] = Math.exp(-0.5 * (i / this.spread) * (i / this.spread));
    this.thr = new Float64Array(width);
    for (i = 0; i < width; i++) this.thr[i] = this.floor;
    this.candK = new Int32Array(width);
    this.candV = new Float64Array(width);
    this.keep = null; // set to a Float32Array to keep every normalised row (clips only)
    this.clampLo = cfg.clampLo;
    this.clampHi = cfg.clampHi;
    this.keepSum = 0;
    this.keepSq = 0;
    this.cap = 1024;
    this.pt = new Uint32Array(this.cap);
    this.pf = new Uint16Array(this.cap);
    this.pv = new Float32Array(this.cap);
    this.np = 0;
  }

  Picker.prototype.grow = function () {
    var cap = this.cap * 2;
    var pt = new Uint32Array(cap), pf = new Uint16Array(cap), pv = new Float32Array(cap);
    pt.set(this.pt); pf.set(this.pf); pv.set(this.pv);
    this.pt = pt; this.pf = pf; this.pv = pv; this.cap = cap;
  };

  // row: log power for bins binLo-1 .. binHi+1 (width values)
  Picker.prototype.push = function (row) {
    var width = this.width, ringN = this.ringN, ring = this.ring, sum = this.sum;
    var r = this.nIn;
    var slot = (r % ringN) * width;
    var k;
    if (r >= ringN) {
      for (k = 0; k < width; k++) sum[k] -= ring[slot + k];
    }
    for (k = 0; k < width; k++) {
      ring[slot + k] = row[k];
      sum[k] += ring[slot + k];
    }
    this.nIn = r + 1;
    var c = r - this.W;
    if (c >= 0) this.emit(c, r - (c - this.W > 0 ? c - this.W : 0) + 1);
  };

  // Frame c is ready: subtract each bin's local average, then pick peaks.
  Picker.prototype.emit = function (c, count) {
    var width = this.width, nb = this.nb, ring = this.ring, sum = this.sum, norm = this.norm;
    var thr = this.thr, candK = this.candK, candV = this.candV;
    var slot = (c % this.ringN) * width;
    var inv = 1 / count;
    var k, v, nc = 0;
    for (k = 0; k < width; k++) norm[k] = ring[slot + k] - sum[k] * inv;
    var keep = this.keep;
    if (keep !== null) {
      var kb = c * nb - 1, cl = -this.clampLo, ch = this.clampHi, ks = 0, kq = 0;
      for (k = 1; k <= nb; k++) {
        v = norm[k];
        if (v < cl) v = cl; else if (v > ch) v = ch;
        keep[kb + k] = v;
        ks += v; kq += v * v;
      }
      this.keepSum += ks; this.keepSq += kq;
    }
    for (k = 1; k <= nb; k++) {
      v = norm[k];
      if (v > thr[k] && v > norm[k - 1] && v >= norm[k + 1]) {
        candK[nc] = k; candV[nc] = v; nc++;
      }
    }
    var taken = 0, tries = nc, best, bv, i, m, lo, hi, tv, d;
    var G = this.G, R = this.R, maxPer = this.maxPer;
    var first = this.np;
    while (taken < maxPer && tries > 0) {
      tries--;
      best = -1; bv = -1e300;
      for (i = 0; i < nc; i++) {
        if (candV[i] > bv) { bv = candV[i]; best = i; }
      }
      if (best < 0) break;
      k = candK[best];
      candV[best] = -1e300;
      if (!(bv > thr[k])) continue; // masked by a stronger peak in this frame
      if (this.np >= this.cap) this.grow();
      this.pt[this.np] = c; this.pf[this.np] = k - 1; this.pv[this.np] = bv;
      this.np++;
      taken++;
      lo = k - R; if (lo < 0) lo = 0;
      hi = k + R; if (hi > width - 1) hi = width - 1;
      for (m = lo; m <= hi; m++) {
        d = m - k; if (d < 0) d = -d;
        tv = bv * G[d];
        if (tv > thr[m]) thr[m] = tv;
      }
    }
    // keep this frame's peaks in rising bin order
    var pf = this.pf, pv = this.pv, a, bq, fq, vq;
    for (a = first + 1; a < this.np; a++) {
      fq = pf[a]; vq = pv[a]; bq = a - 1;
      while (bq >= first && pf[bq] > fq) { pf[bq + 1] = pf[bq]; pv[bq + 1] = pv[bq]; bq--; }
      pf[bq + 1] = fq; pv[bq + 1] = vq;
    }
    var dec = this.decay, fl = this.floor;
    for (k = 0; k < width; k++) {
      tv = thr[k] * dec;
      thr[k] = tv < fl ? fl : tv;
    }
  };

  // No more rows: finish the last frames, then prune backwards in time.
  // Returns { n, t, f } with t the frame and f the bin (counted from binLo).
  Picker.prototype.finish = function () {
    var r = this.nIn - 1, W = this.W, width = this.width, ring = this.ring, sum = this.sum;
    var c, k, slot, lo;
    for (c = (r - W + 1 > 0 ? r - W + 1 : 0); c <= r; c++) {
      if (c - W - 1 >= 0) {
        slot = ((c - W - 1) % this.ringN) * width;
        for (k = 0; k < width; k++) sum[k] -= ring[slot + k];
      }
      lo = c - W > 0 ? c - W : 0;
      this.emit(c, r - lo + 1);
    }
    var np = this.np, pt = this.pt, pf = this.pf, pv = this.pv;
    if (this.backward && np > 0) {
      var thr = this.thr, G = this.G, R = this.R, dec = this.decay, fl = this.floor;
      for (k = 0; k < width; k++) thr[k] = fl;
      var keep = new Uint8Array(np);
      var p = np - 1, s, i, best, bv, m, hi, lo2, tv, d, kk, done;
      for (c = this.nIn - 1; c >= 0; c--) {
        if (p >= 0 && pt[p] === c) {
          s = p;
          while (s > 0 && pt[s - 1] === c) s--;
          // strongest first
          done = 0;
          while (done < p - s + 1) {
            best = -1; bv = -1e300;
            for (i = s; i <= p; i++) {
              if (keep[i] === 0 && pv[i] > bv) { bv = pv[i]; best = i; }
            }
            if (best < 0) break;
            done++;
            kk = pf[best] + 1;
            if (bv >= thr[kk]) {
              keep[best] = 1;
              lo2 = kk - R; if (lo2 < 0) lo2 = 0;
              hi = kk + R; if (hi > width - 1) hi = width - 1;
              for (m = lo2; m <= hi; m++) {
                d = m - kk; if (d < 0) d = -d;
                tv = bv * G[d];
                if (tv > thr[m]) thr[m] = tv;
              }
            } else {
              keep[best] = 2; // dropped
            }
          }
          p = s - 1;
        }
        for (k = 0; k < width; k++) {
          tv = thr[k] * dec;
          thr[k] = tv < fl ? fl : tv;
        }
      }
      var n2 = 0;
      for (i = 0; i < np; i++) {
        if (keep[i] === 1) { pt[n2] = pt[i]; pf[n2] = pf[i]; n2++; }
      }
      np = n2;
    }
    return { n: np, t: pt.subarray(0, np), f: pf.subarray(0, np) };
  };

  // ------------------------------------------------------------------
  // From samples (or ready-made magnitudes) to peaks
  // ------------------------------------------------------------------
  function frameCount(nSamples, cfg) {
    if (nSamples < cfg.fftSize) return 0;
    return Math.floor((nSamples - cfg.fftSize) / cfg.hop) + 1;
  }

  // Runs the whole analysis. Returns { frames, peaks: {n,t,f}, levels }.
  // mags, when given, is a spectrogram made elsewhere: frames rows of fftSize/2+1 values.
  function analyse(cfg, samples, query, mags, magFrames, magPower) {
    var N = cfg.fftSize, hop = cfg.hop, lo = cfg.binLo - 1, hi = cfg.binHi + 1;
    var width = hi - lo + 1;
    var frames = mags ? magFrames : frameCount(samples.length, cfg);
    var picker = new Picker(cfg, query);
    var nb = cfg.binHi - cfg.binLo + 1;
    if (query) picker.keep = new Float32Array(frames * nb);
    var row = new Float64Array(width);
    var plan = mags ? null : getPlan(N);
    var is16 = !mags && (samples instanceof Int16Array);
    var LF = cfg.levelFrames;
    var levels = new Uint8Array(Math.ceil(frames / LF));
    var acc = 0, accN = 0, li = 0;
    var bins = N / 2 + 1;
    var j, k, p, e, base, db;
    for (j = 0; j < frames; j++) {
      if (mags) {
        base = j * bins + lo;
        if (magPower) {
          for (k = 0; k < width; k++) { p = mags[base + k]; row[k] = (p >= 0 && p < 1e30) ? p : 0; }
        } else {
          for (k = 0; k < width; k++) { p = mags[base + k]; row[k] = (p >= 0 && p < 1e15) ? p * p : 0; }
        }
      } else {
        framePower(plan, samples, j * hop, is16, lo, hi, row);
      }
      e = 0;
      for (k = 1; k < width - 1; k++) e += row[k];
      for (k = 0; k < width; k++) row[k] = Math.log(row[k] + EPS_POWER);
      picker.push(row);
      acc += e; accN++;
      if (accN === LF || j === frames - 1) {
        db = 10 * Math.log(acc / (accN * (width - 2)) + 1e-12) / Math.LN10;
        db = Math.round((db + 100) * 2);
        levels[li++] = db < 0 ? 0 : (db > 255 ? 255 : db);
        acc = 0; accN = 0;
      }
    }
    var peaks = picker.finish();
    var out = { frames: frames, peaks: peaks, levels: levels, map: null, mapMean: 0, mapStd: 1 };
    if (query && frames > 0) {
      // the clip's map: every bin of every frame, as far above or below its local average
      var cells = frames * nb, mean = picker.keepSum / cells;
      var vr = picker.keepSq / cells - mean * mean;
      out.map = picker.keep;
      out.mapMean = mean;
      out.mapStd = vr > 1e-12 ? Math.sqrt(vr) : 1;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Prints
  // ------------------------------------------------------------------
  function printParams(cfg) {
    return {
      sampleRate: cfg.sampleRate, fftSize: cfg.fftSize, hop: cfg.hop,
      binLo: cfg.binLo, binHi: cfg.binHi, normFrames: cfg.normFrames,
      levelFrames: cfg.levelFrames, spread: cfg.spread, decay: cfg.decay,
      floor: cfg.floor, maxPerFrame: cfg.maxPerFrame, fanout: cfg.fanout,
      dtMin: cfg.dtMin, dtMax: cfg.dtMax, dfMax: cfg.dfMax
    };
  }

  // Is this object a well-formed print? Returns '' or the problem.
  function printProblem(pr) {
    if (!pr || typeof pr !== 'object') return 'not a print';
    if (pr.formatVersion !== FORMAT_VERSION) return 'format version';
    var p = pr.params;
    if (!p || typeof p !== 'object') return 'params';
    var need = ['sampleRate', 'fftSize', 'hop', 'binLo', 'binHi', 'normFrames', 'levelFrames', 'spread', 'decay', 'floor', 'maxPerFrame', 'fanout', 'dtMin', 'dtMax', 'dfMax'];
    var i;
    for (i = 0; i < need.length; i++) {
      if (!isNum(p[need[i]])) return 'params.' + need[i];
    }
    var bad = paramProblem(p);
    if (bad) return bad;
    if (!isNum(pr.durationSamples) || pr.durationSamples < 0 || pr.durationSamples > 4294967295 || pr.durationSamples !== Math.floor(pr.durationSamples)) return 'durationSamples';
    if (!isNum(pr.frames) || pr.frames < 0 || pr.frames !== Math.floor(pr.frames) || pr.frames > 4294967295) return 'frames';
    if (pr.frames !== frameCount(pr.durationSamples, p)) return 'frames do not fit the duration';
    if (!(pr.peakFrame instanceof Uint32Array) || !(pr.peakBin instanceof Uint16Array)) return 'peak arrays';
    if (!isNum(pr.count) || pr.count !== pr.peakFrame.length || pr.count !== pr.peakBin.length) return 'count';
    if (!(pr.levels instanceof Uint8Array) || pr.levels.length !== Math.ceil(pr.frames / p.levelFrames)) return 'levels';
    var nb = p.binHi - p.binLo + 1;
    var pt = pr.peakFrame, pf = pr.peakBin, n = pr.count, t, f, lt = -1, lf = -1, run = 0;
    for (i = 0; i < n; i++) {
      t = pt[i]; f = pf[i];
      if (t >= pr.frames || f >= nb) return 'peak out of range';
      if (t < lt) return 'peaks out of order';
      if (t === lt) {
        if (f <= lf) return 'peaks out of order';
        run++;
        if (run > p.maxPerFrame) return 'too many peaks in a frame';
      } else {
        run = 1;
      }
      lt = t; lf = f;
    }
    return '';
  }

  function makePrint(cfg, nSamples, res) {
    var n = res.peaks.n;
    var pt = new Uint32Array(n), pf = new Uint16Array(n);
    pt.set(res.peaks.t); pf.set(res.peaks.f);
    return {
      formatVersion: FORMAT_VERSION,
      params: printParams(cfg),
      durationSamples: nSamples,
      durationSec: nSamples / cfg.sampleRate,
      frames: res.frames,
      count: n,
      peakFrame: pt,
      peakBin: pf,
      levels: res.levels
    };
  }

  // Walks every landmark of a peak list. mode 0 counts into a1[h + 1];
  // mode 2 writes each landmark's hash to a1 and its anchor frame to a2.
  function pairAll(pt, pf, np, p, fan, mode, a1, a2) {
    var dtMin = p.dtMin, dtMax = p.dtMax, dfMax = p.dfMax;
    var DF = 2 * dfMax + 1, DT = dtMax - dtMin + 1;
    var i, j, t1, f1, dt, df, h, n, total = 0;
    for (i = 0; i < np; i++) {
      t1 = pt[i]; f1 = pf[i]; n = 0;
      for (j = i + 1; j < np; j++) {
        dt = pt[j] - t1;
        if (dt > dtMax) break;
        if (dt < dtMin) continue;
        df = pf[j] - f1;
        if (df > dfMax || df < -dfMax) continue;
        h = (f1 * DF + df + dfMax) * DT + dt - dtMin;
        if (mode === 0) a1[h + 1]++;
        else { a1[total] = h; a2[total] = t1; }
        total++;
        if (fan > 0 && ++n >= fan) break;
      }
    }
    return total;
  }

  // The film's hash index: for every landmark hash, the anchor frames where the
  // film has it, in rising order. One pass pairs the peaks and keeps each
  // landmark's hash; a second, cheap pass files the anchor frames by hash (a
  // counting sort). The same landmarks as pairAll, made in about half the time.
  function buildIndex(pt, pf, np, p) {
    var fan = p.fanout, dtMin = p.dtMin, dtMax = p.dtMax, dfMax = p.dfMax;
    var DF = 2 * dfMax + 1, DT = dtMax - dtMin + 1;
    var H = (p.binHi - p.binLo + 1) * DF * DT;
    var starts = new Uint32Array(H + 1);
    var lh = new Uint32Array(np * fan > 0 ? np * fan : 1); // each landmark's hash, in anchor order
    var lc = new Uint8Array(np > 0 ? np : 1); // landmarks per anchor (fanout is at most 64)
    var i, j, t1, f1, dt, df, h, n, total = 0;
    for (i = 0; i < np; i++) {
      t1 = pt[i]; f1 = pf[i]; n = 0;
      for (j = i + 1; j < np; j++) {
        dt = pt[j] - t1;
        if (dt > dtMax) break;
        if (dt < dtMin) continue;
        df = pf[j] - f1;
        if (df > dfMax || df < -dfMax) continue;
        h = (f1 * DF + df + dfMax) * DT + dt - dtMin;
        lh[total++] = h;
        starts[h + 1]++;
        if (++n >= fan) break;
      }
      lc[i] = n;
    }
    for (h = 0; h < H; h++) starts[h + 1] += starts[h];
    var cursor = new Uint32Array(H);
    cursor.set(starts.subarray(0, H));
    var times = new Uint32Array(total);
    var L = 0, c;
    for (i = 0; i < np; i++) {
      t1 = pt[i];
      for (c = lc[i]; c > 0; c--) times[cursor[lh[L++]]++] = t1;
    }
    return { H: H, starts: starts, times: times, total: total };
  }

  function crc32(bytes, n) {
    var table = crc32.table;
    var i, c, k;
    if (!table) {
      table = new Int32Array(256);
      for (i = 0; i < 256; i++) {
        c = i;
        for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
      }
      crc32.table = table;
    }
    c = -1;
    for (i = 0; i < n; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function put16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
  function put32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
  function get16(b, o) { return b[o] | (b[o + 1] << 8); }
  function get32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function encodePrint(pr) {
    if (printProblem(pr)) return null;
    var p = pr.params;
    var nb = p.binHi - p.binLo + 1;
    var wide = nb > 256 ? 2 : 1;
    var size = HEADER_BYTES + pr.frames + pr.count * wide + pr.levels.length + 4;
    var b = new Uint8Array(size);
    b[0] = MAGIC[0]; b[1] = MAGIC[1]; b[2] = MAGIC[2]; b[3] = MAGIC[3];
    b[4] = FORMAT_VERSION;
    b[5] = HEADER_BYTES;
    put16(b, 6, 0);
    put32(b, 8, p.sampleRate);
    put16(b, 12, p.fftSize);
    put16(b, 14, p.hop);
    put16(b, 16, p.binLo);
    put16(b, 18, p.binHi);
    b[20] = p.normFrames;
    b[21] = p.maxPerFrame;
    b[22] = p.fanout;
    b[23] = p.dtMin;
    b[24] = p.dtMax;
    b[25] = p.dfMax;
    b[26] = p.levelFrames;
    b[27] = Math.round(p.spread);
    put16(b, 28, Math.round(p.decay * 10000));
    put16(b, 30, Math.round(p.floor * 1000));
    put32(b, 32, pr.durationSamples);
    put32(b, 36, pr.frames);
    put32(b, 40, pr.count);
    put32(b, 44, pr.levels.length);
    var o = HEADER_BYTES, i = 0, t, c, pt = pr.peakFrame, pf = pr.peakBin, n = pr.count, at;
    for (t = 0; t < pr.frames; t++) {
      at = o++;
      c = 0;
      while (i < n && pt[i] === t) {
        if (wide === 1) b[o++] = pf[i];
        else { put16(b, o, pf[i]); o += 2; }
        i++; c++;
      }
      b[at] = c;
    }
    b.set(pr.levels, o);
    o += pr.levels.length;
    put32(b, o, crc32(b, o));
    return b;
  }

  function decodePrint(bytes) {
    if (!(bytes instanceof Uint8Array)) return null;
    var len = bytes.length;
    if (len < HEADER_BYTES + 4) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) return null;
    if (bytes[4] !== FORMAT_VERSION || bytes[5] !== HEADER_BYTES) return null;
    if (get16(bytes, 6) !== 0) return null;
    if (get32(bytes, len - 4) !== crc32(bytes, len - 4)) return null;
    var p = {
      sampleRate: get32(bytes, 8), fftSize: get16(bytes, 12), hop: get16(bytes, 14),
      binLo: get16(bytes, 16), binHi: get16(bytes, 18), normFrames: bytes[20],
      levelFrames: bytes[26], spread: bytes[27], decay: get16(bytes, 28) / 10000,
      floor: get16(bytes, 30) / 1000, maxPerFrame: bytes[21], fanout: bytes[22],
      dtMin: bytes[23], dtMax: bytes[24], dfMax: bytes[25]
    };
    if (paramProblem(p)) return null;
    var durationSamples = get32(bytes, 32), frames = get32(bytes, 36), count = get32(bytes, 40), nLevels = get32(bytes, 44);
    if (frames !== frameCount(durationSamples, p)) return null;
    if (nLevels !== Math.ceil(frames / p.levelFrames)) return null;
    var nb = p.binHi - p.binLo + 1;
    var wide = nb > 256 ? 2 : 1;
    // exact size check before any allocation, so that garbage cannot ask for huge arrays
    if (HEADER_BYTES + frames + count * wide + nLevels + 4 !== len) return null;
    var pt = new Uint32Array(count), pf = new Uint16Array(count);
    var o = HEADER_BYTES, end = len - 4 - nLevels, i = 0, t, c, k, f, last;
    for (t = 0; t < frames; t++) {
      if (o >= end) return null;
      c = bytes[o++];
      if (c > p.maxPerFrame || i + c > count || o + c * wide > end) return null;
      last = -1;
      for (k = 0; k < c; k++) {
        if (wide === 1) f = bytes[o++];
        else { f = get16(bytes, o); o += 2; }
        if (f >= nb || f <= last) return null;
        last = f;
        pt[i] = t; pf[i] = f; i++;
      }
    }
    if (i !== count || o !== end) return null;
    var levels = new Uint8Array(nLevels);
    levels.set(bytes.subarray(end, end + nLevels));
    return {
      formatVersion: FORMAT_VERSION,
      params: p,
      durationSamples: durationSamples,
      durationSec: durationSamples / p.sampleRate,
      frames: frames,
      count: count,
      peakFrame: pt,
      peakBin: pf,
      levels: levels
    };
  }

  // ------------------------------------------------------------------
  // The matcher
  // ------------------------------------------------------------------
  function fail(reason, clipSec) {
    return {
      found: false, filmSec: null, score: 0, votes: 0, runnerUp: 0, confidence: 0,
      ambiguous: false, reason: reason, clipSec: clipSec || 0, level: null, gainDb: null
    };
  }

  // A stored loudness value (half decibels above -100) in decibels.
  function levelDb(v) {
    return v / 2 - 100;
  }

  // The clip's loudness: its loudest half second, in decibels.
  function clipLevel(res) {
    var lv = res.levels, n = lv.length, m = 0, i;
    for (i = 0; i < n; i++) {
      if (lv[i] > m) m = lv[i];
    }
    return levelDb(m);
  }

  function Matcher(pr, cfg) {
    var p = pr.params;
    this.cfg = cfg;
    this.frames = pr.frames;
    this.durationSec = pr.durationSamples / p.sampleRate;
    this.secPerFrame = p.hop / p.sampleRate;
    this.perLevel = p.levelFrames * p.hop / p.sampleRate;
    this.nb = p.binHi - p.binLo + 1;
    this.rt = pr.peakFrame;
    this.rf = pr.peakBin;
    this.np = pr.count;
    this.levels = pr.levels;
    var frames = pr.frames, np = pr.count, rt = pr.peakFrame;
    // where each frame's peaks start
    var fs = new Uint32Array(frames + 1);
    var i, t;
    for (i = 0; i < np; i++) fs[rt[i] + 1]++;
    for (t = 0; t < frames; t++) fs[t + 1] += fs[t];
    this.fs = fs;
    // the hash index: for every hash, the anchor frames where the film has it
    var index = buildIndex(rt, pr.peakBin, np, p);
    this.H = index.H;
    this.starts = index.starts;
    this.times = index.times;
    this.landmarks = index.total;
    this.votes = null;
    this.cand = new Int32Array(16384);
    this.hist = new Int32Array(256);
    // for the wide pass: the film's peak frames, bin by bin
    var nbins = this.nb, rfb = pr.peakBin;
    var bs = new Uint32Array(nbins + 1);
    for (i = 0; i < np; i++) bs[rfb[i] + 1]++;
    for (i = 0; i < nbins; i++) bs[i + 1] += bs[i];
    var bcur = new Uint32Array(nbins);
    bcur.set(bs.subarray(0, nbins));
    var bt = new Uint32Array(np);
    for (i = 0; i < np; i++) bt[bcur[rfb[i]]++] = rt[i];
    this.binStart = bs;
    this.binTimes = bt;
    this.wt = new Uint16Array(8192);
    this.wf = new Uint16Array(8192);
    // the film's usual loud level (the 80th percentile of its loudness values), for
    // telling quiet passages apart; the values are whole numbers 0..255, so count them
    var lv = pr.levels, n = lv.length, hist = new Uint32Array(256), want, acc = 0;
    for (i = 0; i < n; i++) hist[lv[i]]++;
    this.loudLevel = 0;
    if (n) {
      want = Math.floor((n - 1) * 0.8);
      for (i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc > want) { this.loudLevel = i; break; }
      }
    }
    this.loudDb = levelDb(this.loudLevel);
  }

  // Is the film quiet (compared with its own loud level) for the whole of this stretch?
  Matcher.prototype.quietAt = function (filmSec, clipSec) {
    var cfg = this.cfg, lv = this.levels, n = lv.length;
    if (!n) return true;
    var perLevel = this.perLevel;
    var a = Math.floor(filmSec / perLevel), b = Math.floor((filmSec + clipSec) / perLevel);
    if (b < 0 || a >= n) return true; // outside the film
    if (a < 0) a = 0;
    if (b > n - 1) b = n - 1;
    var limit = this.loudLevel - 2 * cfg.quietDropDb, i;
    for (i = a; i <= b; i++) {
      if (lv[i] > limit) return false;
    }
    return true;
  };

  // The film's own loudness over a stretch: its loudest half second there, in
  // decibels, counting the half seconds that lie wholly inside the stretch (or,
  // for a very short stretch, the ones it touches). Null outside the film.
  Matcher.prototype.levelAt = function (filmSec, clipSec) {
    var lv = this.levels, n = lv.length, per = this.perLevel;
    if (!n || !isNum(filmSec) || !isNum(clipSec)) return null;
    var a = Math.ceil(filmSec / per), b = Math.floor((filmSec + clipSec) / per) - 1;
    if (b < a) {
      a = Math.floor(filmSec / per);
      b = Math.floor((filmSec + clipSec) / per);
    }
    if (a < 0) a = 0;
    if (b > n - 1) b = n - 1;
    if (b < a) return null;
    var m = 0, i;
    for (i = a; i <= b; i++) {
      if (lv[i] > m) m = lv[i];
    }
    return levelDb(m);
  };

  // How strongly does the clip's spectrum stand out at the places where the film
  // has peaks, when clip frame 0 is film frame d? Each film peak under the clip
  // reads one value from the clip's map; the sum is scaled so that a clip that has
  // nothing to do with the film scores about 0 with a spread of about 1.
  // Returns the score, or -1000 when too few film peaks lie under the clip.
  Matcher.prototype.score = function (res, d) {
    var frames = this.frames, fs = this.fs, rf = this.rf, rt = this.rt, nb = this.nb;
    var qFrames = res.frames, map = res.map;
    var lo = d > 0 ? d : 0, hi = d + qFrames < frames ? d + qFrames : frames;
    if (hi <= lo) return -1000;
    var a = fs[lo], e = fs[hi], n = e - a, sum = 0;
    if (n < this.cfg.minPeaks) return -1000;
    for (; a < e; a++) sum += map[(rt[a] - d) * nb + rf[a]];
    return (sum - n * res.mapMean) / (res.mapStd * Math.sqrt(n));
  };

  // Adds candidate offset d to a list, refining it to the best of d-1, d, d+1.
  Matcher.prototype.consider = function (res, d, votes, near, list) {
    var s0 = this.score(res, d), sm = this.score(res, d - 1), sp = this.score(res, d + 1);
    var best = d, z = s0, left = sm, right = sp;
    if (sm > z) { best = d - 1; z = sm; left = this.score(res, d - 2); right = s0; }
    if (sp > z) { best = d + 1; z = sp; left = s0; right = this.score(res, d + 2); }
    if (z <= -1000) return;
    // a parabola through the three scores gives the part of a frame
    var shift = 0, den = left - 2 * z + right;
    if (left > -1000 && right > -1000 && den < 0) {
      shift = 0.5 * (left - right) / den;
      if (shift > 0.5) shift = 0.5; else if (shift < -0.5) shift = -0.5;
    }
    var i, c;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (c.d - best <= 2 && best - c.d <= 2) {
        if (votes > c.votes) c.votes = votes;
        if (near) c.near = true;
        if (z > c.z) { c.z = z; c.d = best; c.shift = shift; }
        return;
      }
    }
    list.push({ d: best, shift: shift, votes: votes, z: z, near: near, ok: false });
  };

  // From the offsets that gathered votes, takes about K of the best (three
  // neighbouring bins summed) and checks each against the clip's spectrum.
  // cand lists the offsets that reached minV votes in one bin. When cand is
  // null (the list overflowed, or the wide pass), every offset in votes[1 ..
  // size - 2] is looked at instead.
  Matcher.prototype.harvest = function (res, votes, size, cand, nc, K, minV, minS, off, list) {
    var hist = this.hist, i, d, v, s;
    var TOP = 255, hiD = size - 2;
    zeroFill(hist, TOP + 1);
    if (cand !== null) {
      for (i = 0; i < nc; i++) {
        d = cand[i];
        v = votes[d];
        if (votes[d - 1] > v || votes[d + 1] > v) { cand[i] = -1; continue; } // not the top of its bump
        s = votes[d - 1] + v + votes[d + 1];
        hist[s > TOP ? TOP : s]++;
      }
    } else {
      for (d = 1; d <= hiD; d++) {
        v = votes[d];
        if (v < minV || votes[d - 1] > v || votes[d + 1] > v) continue;
        s = votes[d - 1] + v + votes[d + 1];
        hist[s > TOP ? TOP : s]++;
      }
    }
    var cut = TOP, total = hist[TOP];
    while (cut > minS && total + hist[cut - 1] <= K) { cut--; total += hist[cut]; }
    if (cand !== null) {
      for (i = 0; i < nc; i++) {
        d = cand[i];
        if (d < 0) continue;
        s = votes[d - 1] + votes[d] + votes[d + 1];
        if (s < cut) continue;
        this.consider(res, d - off, s, false, list);
      }
    } else {
      for (d = 1; d <= hiD; d++) {
        v = votes[d];
        if (v < minV || votes[d - 1] > v || votes[d + 1] > v) continue;
        s = votes[d - 1] + v + votes[d + 1];
        if (s < cut) continue;
        this.consider(res, d - off, s, false, list);
      }
    }
  };

  Matcher.prototype.run = function (res, clipSec, opts) {
    var cfg = this.cfg;
    var qn = res.peaks.n, qt = res.peaks.t, qf = res.peaks.f, qFrames = res.frames;
    var frames = this.frames;
    var out = fail('no match', clipSec);
    var o = opts && typeof opts === 'object' ? opts : null;
    var expectSec = (o && isNum(o.expectSec)) ? o.expectSec : null;
    var windowSec = (o && isNum(o.windowSec) && o.windowSec > 0) ? o.windowSec : cfg.windowSec;
    if (windowSec > MAX_WINDOW_SEC) windowSec = MAX_WINDOW_SEC;
    var gainDb = (o && isNum(o.gainDb)) ? o.gainDb : null;
    out.level = clipLevel(res);
    if (expectSec !== null) out.expectQuiet = this.quietAt(expectSec, clipSec);
    out.peaks = qn;
    out.hashes = 0;
    if (qn < 4 || res.map === null) { out.reason = 'silence'; return out; }

    // 1. vote: every landmark of the clip that the film also has says
    //    "the clip starts at film frame (film anchor - clip anchor)"
    var size = frames + qFrames + 3;
    var votes = this.votes;
    if (!votes || votes.length < size) { votes = new Uint32Array(size); this.votes = votes; }
    else zeroFill(votes, size);
    var starts = this.starts, times = this.times, cand = this.cand, capC = cand.length;
    var dtMin = cfg.dtMin, dtMax = cfg.dtMax, dfMax = cfg.dfMax, fan = cfg.qFanout;
    var DF = 2 * dfMax + 1, DT = dtMax - dtMin + 1;
    var off = qFrames + 1, seed = cfg.seedVotes;
    var i, j, t1, f1, dt, df, h, n, a, e, d, c, nc = 0, hashes = 0;
    for (i = 0; i < qn; i++) {
      t1 = qt[i]; f1 = qf[i]; n = 0;
      for (j = i + 1; j < qn; j++) {
        dt = qt[j] - t1;
        if (dt > dtMax) break;
        if (dt < dtMin) continue;
        df = qf[j] - f1;
        if (df > dfMax || df < -dfMax) continue;
        h = (f1 * DF + df + dfMax) * DT + dt - dtMin;
        hashes++;
        for (a = starts[h], e = starts[h + 1]; a < e; a++) {
          d = times[a] - t1 + off;
          c = votes[d] + 1;
          votes[d] = c;
          if (c === seed) {
            if (nc < capC) cand[nc++] = d;
            else nc = capC + 1; // overflowed: harvest looks at every offset instead
          }
        }
        if (fan > 0 && ++n >= fan) break;
      }
    }
    out.hashes = hashes;

    // 2. the best offsets by votes, each checked against the clip's spectrum
    var list = [], k, z;
    if (nc > capC) this.harvest(res, votes, size, null, 0, cfg.candidates, seed, cfg.minVotes, off, list);
    else this.harvest(res, votes, size, cand, nc, cfg.candidates, seed, cfg.minVotes, off, list);

    // 3. with an expected position: try every offset near it, votes or no votes.
    //    Only offsets where the clip overlaps the film are scored.
    var nearLo = 0, nearHi = -1;
    if (expectSec !== null) {
      var ex = expectSec / this.secPerFrame, w = windowSec / this.secPerFrame;
      nearLo = Math.floor(ex - w); nearHi = Math.ceil(ex + w);
      var scanLo = nearLo > 1 - qFrames ? nearLo : 1 - qFrames, scanHi = nearHi < frames - 1 ? nearHi : frames - 1;
      var bestD = scanLo, bestZ = -1000, secondD = scanLo, secondZ = -1000;
      for (d = scanLo; d <= scanHi; d++) {
        z = this.score(res, d);
        if (z > bestZ) {
          if (d - bestD > 3) { secondZ = bestZ; secondD = bestD; }
          bestZ = z; bestD = d;
        } else if (z > secondZ && d - bestD > 3) { secondZ = z; secondD = d; }
      }
      if (bestZ > -1000) this.consider(res, bestD, 0, true, list);
      if (secondZ > -1000) this.consider(res, secondD, 0, true, list);
    }

    // 4. the wide pass, when nothing so far is convincing: every strong point of
    //    the clip's spectrum votes with every film peak in the same bin
    var topZ = -1000;
    for (k = 0; k < list.length; k++) { if (list[k].z > topZ) topZ = list[k].z; }
    if (cfg.wide > 0 && topZ < cfg.wideBelow) {
      var map = res.map, nb = this.nb, bs = this.binStart, bt = this.binTimes;
      var wfl = cfg.wideFloor, base, f, t, v, nw = 0, sumVotes = 0, e4;
      var wt = this.wt, wf = this.wf, capW = wt.length;
      for (t = 0; t < qFrames && nw < capW; t++) {
        base = t * nb;
        for (f = 0; f < nb; f++) {
          v = map[base + f];
          if (v < wfl) continue;
          if (f > 0 && map[base + f - 1] > v) continue;
          if (f < nb - 1 && map[base + f + 1] >= v) continue;
          if (t > 0 && map[base - nb + f] > v) continue;
          if (t < qFrames - 1 && map[base + nb + f] >= v) continue;
          if (nw >= capW) break;
          wt[nw] = t; wf[nw] = f; nw++;
          sumVotes += bs[f + 1] - bs[f];
        }
      }
      out.widePeaks = nw;
      // a bin is worth checking when it stands well above the level chance alone gives
      var lam = sumVotes / size;
      var seedW = Math.ceil(lam + cfg.wideSigma * Math.sqrt(lam)) + 1;
      if (seedW < 3) seedW = 3;
      zeroFill(votes, size);
      // the plain count, four at a time: this loop is most of the wide pass, and an
      // interpreter (a phone's JavaScriptCore has no JIT) runs it twice as fast this way
      for (i = 0; i < nw; i++) {
        k = off - wt[i]; f1 = wf[i];
        a = bs[f1]; e = bs[f1 + 1]; e4 = e - 3;
        for (; a < e4; a += 4) {
          votes[bt[a] + k]++; votes[bt[a + 1] + k]++; votes[bt[a + 2] + k]++; votes[bt[a + 3] + k]++;
        }
        for (; a < e; a++) votes[bt[a] + k]++;
      }
      this.harvest(res, votes, size, null, 0, cfg.wideCandidates, seedW, seedW, off, list);
    }
    if (expectSec !== null) {
      for (k = 0; k < list.length; k++) {
        if (list[k].d >= nearLo && list[k].d <= nearHi) list[k].near = true;
      }
    }
    if (list.length === 0) return this.quiet(out, expectSec, clipSec, gainDb);

    // 5. decide
    for (k = 0; k < list.length; k++) {
      c = list[k];
      c.ok = (c.votes >= cfg.minVotes && c.z >= cfg.minScore) || (c.near && c.z >= cfg.nearMinScore);
    }
    list.sort(function (x, y) { return y.z - x.z || y.votes - x.votes || x.d - y.d; });
    var best = list[0], second = list.length > 1 ? list[1] : null;
    // a near candidate that is about as good as the winner takes its place
    if (expectSec !== null && !best.near) {
      for (k = 1; k < list.length; k++) {
        if (list[k].near && list[k].ok && list[k].z >= cfg.ambiguousRatio * best.z) {
          second = best; best = list[k];
          break;
        }
      }
    }
    if (second === best) second = list.length > 1 ? list[1] : null;
    if (opts && opts.debug) out.candidates = list;
    out.votes = best.votes;
    out.score = best.z;
    out.runnerUp = second ? second.z : 0;
    out.filmSec = (best.d + best.shift) * this.secPerFrame;
    if (!best.ok) { out.filmSec = null; return this.quiet(out, expectSec, clipSec, gainDb); }
    var rival = false;
    for (k = 0; k < list.length; k++) {
      if (list[k] !== best && list[k].ok && list[k].z >= cfg.ambiguousRatio * best.z) {
        if (!(best.near && !list[k].near)) rival = true;
        out.ambiguous = true;
      }
    }
    if (rival) { out.reason = 'ambiguous'; out.filmSec = null; return this.quiet(out, expectSec, clipSec, gainDb); }
    var floorScore = best.near ? cfg.nearMinScore : cfg.minScore;
    var conf = 0.5 + 0.5 * (best.z - floorScore) / (cfg.fullScore - floorScore);
    if (out.ambiguous && conf > 0.6) conf = 0.6;
    out.confidence = conf < 0 ? 0 : (conf > 1 ? 1 : conf);
    out.found = true;
    out.reason = 'ok';
    // how loud this film sounds in this room: the clip's loudness against the
    // film's own at the same place (not measured over a quiet passage)
    var fl = this.levelAt(out.filmSec, clipSec);
    if (fl !== null && fl >= this.loudDb - cfg.quietDropDb) out.gainDb = out.level - fl;
    return out;
  };

  // A clip that was not found: was it silence? It is when it is far quieter than
  // this film sounds in this room (gainDb, the tracker's reading) at the expected
  // place, or than the film's usual loud level when no place is expected.
  Matcher.prototype.quiet = function (out, expectSec, clipSec, gainDb) {
    if (gainDb === null || out.level === null) return out;
    var ref = expectSec !== null ? this.levelAt(expectSec, clipSec) : this.loudDb;
    if (ref !== null && out.level < ref + gainDb - this.cfg.silenceDb) out.reason = 'silence';
    return out;
  };

  // ------------------------------------------------------------------
  // The tracker: a state machine fed with match results and clock times
  // ------------------------------------------------------------------
  var TRACKER_DEFAULTS = {
    lockConfidence: 0.75, // one match this sure is enough to lock
    jumpConfidence: 0.9, // one match this sure may move a locked tracker far
    smallSec: 0.25, // a disagreement up to this is smoothed in
    agreeSec: 0.35, // two matches agree when this close
    slewPerSec: 0.1, // smoothing speed: at most this many seconds per second
    pendingMaxAgeSec: 60, // a lone weak match waits this long for a second one
    holdAfterMisses: 2, // misses in a row before holding
    lostAfterMisses: 6, // misses in a row before lost
    maxCoastSec: 90, // locked needs a fix at least this often
    quietCoastSec: 150, // ... or this often when the film itself is quiet
    searchClipSec: 8,
    searchWaitSec: 0,
    lockedClipSec: 6,
    lockedWaitMinSec: 20,
    lockedWaitMaxSec: 30,
    recheckClipSec: 8, // after a miss or a doubtful match while locked
    holdClipSec: 8,
    holdWaitSec: 1,
    lostClipSec: 10,
    lostWaitSec: 6,
    windowSec: 3
  };

  function Tracker(opts) {
    this.o = copyParams(TRACKER_DEFAULTS, opts);
    this.reset();
  }

  Tracker.prototype.reset = function () {
    this.status = 'searching';
    this.hasEst = false;
    this.aFilm = 0; this.aMono = 0; // film time aFilm at clock time aMono
    this.corr = 0; this.corrMono = 0; // smoothing still to be applied, and since when
    this.lastFixMono = null;
    this.lastListenEnd = null;
    this.misses = 0;
    this.quietSinceFix = false; // a miss since the last fix was excused by a quiet film passage
    this.pending = null;
    this.fixes = 0;
    this.jumpCount = 0;
    this.justJumped = false;
    this.lastJumpSec = 0;
    this.lastBackJumpMono = null;
    this.lastBackJumpFilmSec = null;
    this.hurried = false;
    this.gains = []; // how loud the film sounds in this room, from the last few accepted matches
  };

  // The room level: the middle of the last few readings, or null before the first.
  Tracker.prototype.gain = function () {
    var g = this.gains, n = g.length, s = [], i, j, v;
    if (!n) return null;
    for (i = 0; i < n; i++) {
      v = g[i];
      for (j = s.length; j > 0 && s[j - 1] > v; j--) s[j] = s[j - 1];
      s[j] = v;
    }
    return n & 1 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };

  Tracker.prototype.est = function (t) {
    var applied = 0, c = this.corr;
    if (c !== 0 && t > this.corrMono) {
      applied = (t - this.corrMono) * this.o.slewPerSec;
      if (c > 0) { if (applied > c) applied = c; }
      else { if (applied > -c) applied = -c; applied = -applied; }
    }
    return this.aFilm + (t - this.aMono) + applied;
  };

  Tracker.prototype.setAnchor = function (film, mono, now, smooth) {
    var prev = this.hasEst ? this.est(now) : null;
    if (smooth && prev !== null) {
      // keep the present estimate and let the difference slew in
      this.aFilm = prev; this.aMono = now;
      this.corr = (film + (now - mono)) - prev;
      this.corrMono = now;
    } else {
      this.aFilm = film; this.aMono = mono; this.corr = 0; this.corrMono = now;
      if (prev !== null) {
        var delta = (film + (now - mono)) - prev;
        if (delta > this.o.smallSec || delta < -this.o.smallSec) {
          this.jumpCount++;
          this.justJumped = true;
          this.lastJumpSec = delta;
          if (delta < 0) {
            this.lastBackJumpMono = now;
            this.lastBackJumpFilmSec = film + (now - mono);
          }
        }
      }
    }
    this.hasEst = true;
    this.status = 'locked';
    this.misses = 0;
    this.quietSinceFix = false;
    this.pending = null;
    this.lastFixMono = mono;
    this.fixes++;
  };

  Tracker.prototype.onMatch = function (result, clipStartMono, nowMono) {
    if (!isNum(clipStartMono)) return this.status;
    if (!result || typeof result !== 'object' || result.found !== true || !isNum(result.filmSec)) {
      return this.onMiss(clipStartMono, result && isNum(result.clipSec) ? result.clipSec : 0, result);
    }
    var o = this.o;
    var clipSec = isNum(result.clipSec) ? result.clipSec : 0;
    var now = isNum(nowMono) ? nowMono : clipStartMono + clipSec;
    if (now < clipStartMono) now = clipStartMono;
    this.lastListenEnd = clipStartMono + clipSec;
    this.hurried = false;
    var film = result.filmSec, conf = isNum(result.confidence) ? result.confidence : 0;
    var pend = this.pending;
    if (pend && clipStartMono - pend.mono > o.pendingMaxAgeSec) { pend = null; this.pending = null; }
    var agreesPending = pend !== null && Math.abs(film - (pend.film + (clipStartMono - pend.mono))) <= o.agreeSec;
    var e = this.hasEst ? film - this.est(clipStartMono) : null;
    var small = e !== null && e <= o.smallSec && e >= -o.smallSec;
    var took = false;
    if (this.status === 'locked') {
      if (small) { this.setAnchor(film, clipStartMono, now, true); took = true; }
      else if (conf >= o.jumpConfidence || agreesPending) { this.setAnchor(film, clipStartMono, now, false); took = true; }
      else {
        // one weaker match says the film is elsewhere: stop describing until a second opinion
        this.pending = { film: film, mono: clipStartMono };
        this.status = 'holding';
      }
    } else {
      if (small && this.status === 'holding') { this.setAnchor(film, clipStartMono, now, true); took = true; }
      else if (conf >= o.lockConfidence || agreesPending) { this.setAnchor(film, clipStartMono, now, false); took = true; }
      else this.pending = { film: film, mono: clipStartMono };
    }
    if (took && isNum(result.gainDb)) {
      this.gains.push(result.gainDb);
      if (this.gains.length > GAIN_KEEP) this.gains.shift();
    }
    return this.status;
  };

  Tracker.prototype.onMiss = function (clipStartMono, clipSec, info) {
    if (!isNum(clipStartMono)) return this.status;
    var o = this.o;
    this.lastListenEnd = clipStartMono + (isNum(clipSec) ? clipSec : 0);
    this.hurried = false;
    // a miss during a passage where the film itself is nearly silent proves nothing
    var excused = this.status === 'locked' && info && info.expectQuiet === true &&
      this.lastFixMono !== null && clipStartMono - this.lastFixMono <= o.quietCoastSec;
    if (excused) {
      this.quietSinceFix = true;
      return this.status;
    }
    this.misses++;
    if (this.status === 'locked' && this.misses >= o.holdAfterMisses) this.status = 'holding';
    if (this.status === 'holding' && this.misses >= o.lostAfterMisses) this.status = 'lost';
    return this.status;
  };

  // The status as it stands at clock time now. A lock goes stale without fixes:
  // after maxCoastSec, or quietCoastSec when the film has been quiet since the last fix.
  Tracker.prototype.statusAt = function (now) {
    if (this.status === 'locked' && this.lastFixMono !== null) {
      var since = now - this.lastFixMono;
      if (since > this.o.quietCoastSec || (since > this.o.maxCoastSec && !this.quietSinceFix)) return 'holding';
    }
    return this.status;
  };

  Tracker.prototype.state = function (nowMono) {
    var now = isNum(nowMono) ? nowMono : 0;
    var st = this.statusAt(now);
    var jumped = this.justJumped;
    this.justJumped = false;
    return {
      status: st,
      filmSec: (this.hasEst && (st === 'locked' || st === 'holding')) ? this.est(now) : null,
      sinceLastFixSec: this.lastFixMono === null ? null : now - this.lastFixMono,
      justJumped: jumped,
      jumpCount: this.jumpCount,
      lastJumpSec: this.lastJumpSec,
      lastBackJumpMono: this.lastBackJumpMono,
      lastBackJumpFilmSec: this.lastBackJumpFilmSec,
      misses: this.misses,
      doubt: this.pending !== null
    };
  };

  Tracker.prototype.nextListen = function (nowMono) {
    var o = this.o, now = isNum(nowMono) ? nowMono : 0;
    var st = this.statusAt(now);
    var since = this.lastListenEnd === null ? 1e9 : now - this.lastListenEnd;
    var wait, clip;
    if (st === 'searching') {
      wait = o.searchWaitSec; clip = o.searchClipSec;
      if (this.misses >= 3) clip = o.lostClipSec; // nothing yet: try longer clips
    } else if (st === 'locked') {
      if (this.misses > 0 || this.pending !== null) { wait = 0; clip = o.recheckClipSec; }
      else {
        // spread the checks between the two limits, without a random source
        var span = o.lockedWaitMaxSec - o.lockedWaitMinSec;
        wait = o.lockedWaitMinSec + (span > 0 ? ((this.fixes * 7) % 11) / 10 * span : 0);
        clip = o.lockedClipSec;
      }
    } else if (st === 'holding') {
      wait = o.holdWaitSec; clip = o.holdClipSec;
    } else {
      wait = o.lostWaitSec; clip = o.lostClipSec;
    }
    wait = this.hurried ? 0 : wait - since;
    return { waitSec: wait > 0 ? wait : 0, clipSec: clip };
  };

  // What to tell the matcher, for a clip starting at this clock time: where the
  // film should be (while locked or holding), and how loud it sounds in this room
  // (once a match has been accepted), so that the matcher can tell a pause.
  Tracker.prototype.expect = function (clipStartMono) {
    var out = {}, g = this.gain();
    if (g !== null) out.gainDb = g;
    if (!this.hasEst || !isNum(clipStartMono)) return out;
    var st = this.statusAt(clipStartMono);
    if (st !== 'locked' && st !== 'holding') return out;
    out.expectSec = this.est(clipStartMono);
    out.windowSec = this.o.windowSec;
    return out;
  };

  Tracker.prototype.hurry = function () {
    this.hurried = true;
  };

  // ------------------------------------------------------------------
  // The cue planner: a pure function
  // ------------------------------------------------------------------
  function planCues(cues, state, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var idle = isNum(o.idleWaitSec) && o.idleWaitSec > 0 ? o.idleWaitSec : 1;
    var maxWait = isNum(o.maxWaitSec) && o.maxWaitSec > 0 ? o.maxWaitSec : 5;
    if (!cues || typeof cues.length !== 'number') return { action: 'wait', waitSec: idle, reason: 'no cues', error: 'cues must be an array' };
    if (!state || state.status !== 'locked' || !isNum(state.filmSec)) return { action: 'wait', waitSec: idle, reason: 'not locked' };
    if (isNum(o.busySec) && o.busySec > 0) return { action: 'wait', waitSec: o.busySec < maxWait ? o.busySec : maxWait, reason: 'speaking' };
    var spc = isNum(o.secPerChar) && o.secPerChar > 0 ? o.secPerChar : 0.065;
    var lead = isNum(o.leadSec) && o.leadSec >= 0 ? o.leadSec : 0;
    var tol = isNum(o.toleranceSec) && o.toleranceSec >= 0 ? o.toleranceSec : 0.5;
    var spoken = o.spoken && typeof o.spoken === 'object' ? o.spoken : null;
    if (spoken !== null && Array.isArray(spoken)) {
      // a plain list of the ids already spoken: the same as { id: true, ... }
      var set = {}, s;
      for (s = 0; s < spoken.length; s++) {
        if (typeof spoken[s] === 'string' || typeof spoken[s] === 'number') set[spoken[s]] = true;
      }
      spoken = set;
    }
    var backMono = isNum(state.lastBackJumpMono) ? state.lastBackJumpMono : null;
    var backFilm = isNum(state.lastBackJumpFilmSec) ? state.lastBackJumpFilmSec : null;
    var f = state.filmSec;
    var best = null, bestShort = false, bestDur = 0, bestImp = 0, next = null;
    var i, c, rec, left, full, shortDur, useShort, dur, imp, id;
    for (i = 0; i < cues.length; i++) {
      c = cues[i];
      if (!c || typeof c !== 'object' || !isNum(c.startSec) || !isNum(c.endSec) || c.endSec < c.startSec) continue;
      if (typeof c.text !== 'string' || c.text.length === 0) continue;
      id = c.id;
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      if (spoken !== null && Object.prototype.hasOwnProperty.call(spoken, id)) {
        rec = spoken[id];
        // spoken already, unless the film has since gone back to before that moment
        if (!(rec && backMono !== null && isNum(rec.monoSec) && isNum(rec.filmSec) && backMono >= rec.monoSec && backFilm < rec.filmSec)) continue;
      }
      if (f < c.startSec) {
        if (next === null || c.startSec < next.startSec) next = c;
        continue;
      }
      left = c.endSec - f + tol;
      if (left < 0) continue; // the window has passed
      full = lead + c.text.length * spc;
      shortDur = (typeof c.shortText === 'string' && c.shortText.length > 0) ? lead + c.shortText.length * spc : -1;
      if (full <= left) { useShort = false; dur = full; }
      else if (shortDur >= 0 && shortDur <= left) { useShort = true; dur = shortDur; }
      else continue; // neither fits in what is left of the window
      imp = isNum(c.importance) ? c.importance : 0;
      if (best === null || imp > bestImp || (imp === bestImp && c.startSec < best.startSec)) {
        best = c; bestShort = useShort; bestDur = dur; bestImp = imp;
      }
    }
    if (best !== null) {
      return { action: 'speak', id: best.id, text: bestShort ? best.shortText : best.text, short: bestShort, estSec: bestDur, waitSec: 0, reason: 'window open' };
    }
    if (next !== null) {
      var w = next.startSec - f;
      return { action: 'wait', waitSec: w < maxWait ? w : maxWait, nextId: next.id, reason: 'next cue' };
    }
    return { action: 'wait', waitSec: maxWait, reason: 'no cue due' };
  }

  // ------------------------------------------------------------------
  // The public API, made for one parameter set
  // ------------------------------------------------------------------
  function make(overrides) {
    var cfg = copyParams(DEFAULTS, overrides);
    var problem = configProblem(cfg);

    function fingerprint(samples) {
      try {
        if (problem || !isSamples(samples)) return null;
        // less than one analysis frame (64 ms) cannot make a print worth keeping
        if (samples.length < cfg.fftSize || samples.length > 4294967295) return null;
        return makePrint(cfg, samples.length, analyse(cfg, samples, false, null, 0, false));
      } catch (e) {
        return null;
      }
    }

    function landmarks(pr) {
      try {
        if (printProblem(pr)) return null;
        var p = pr.params;
        var H = (p.binHi - p.binLo + 1) * (2 * p.dfMax + 1) * (p.dtMax - p.dtMin + 1);
        var counts = new Uint32Array(H + 1);
        var total = pairAll(pr.peakFrame, pr.peakBin, pr.count, p, p.fanout, 0, counts, null);
        var hashes = new Uint32Array(total), times = new Uint32Array(total);
        pairAll(pr.peakFrame, pr.peakBin, pr.count, p, p.fanout, 2, hashes, times);
        return { count: total, hashes: hashes, times: times, secPerFrame: p.hop / p.sampleRate };
      } catch (e) {
        return null;
      }
    }

    function spectrogram(samples) {
      try {
        if (problem || !isSamples(samples)) return null;
        var N = cfg.fftSize, bins = N / 2 + 1, frames = frameCount(samples.length, cfg);
        var plan = getPlan(N), mags = new Float32Array(frames * bins), row = new Float64Array(bins);
        var is16 = samples instanceof Int16Array, j, k;
        for (j = 0; j < frames; j++) {
          framePower(plan, samples, j * cfg.hop, is16, 1, bins - 2, row);
          for (k = 1; k < bins - 1; k++) mags[j * bins + k] = Math.sqrt(row[k - 1]);
        }
        return { mags: mags, frames: frames, bins: bins };
      } catch (e) {
        return null;
      }
    }

    function createMatcher(pr) {
      try {
        if (problem || printProblem(pr)) return null;
        // the print says how it was made; the clip must be analysed the same way
        var mcfg = copyParams(cfg, pr.params);
        if (paramProblem(mcfg)) return null;
        var m = new Matcher(pr, mcfg);
        return {
          durationSec: m.durationSec,
          landmarks: m.landmarks,
          peaks: m.np,
          match: function (samples, opts) {
            try {
              if (!isSamples(samples)) return fail('bad input', 0);
              var clipSec = samples.length / mcfg.sampleRate;
              if (clipSec < mcfg.minClipSec) return fail('too short', clipSec);
              if (clipSec > MAX_CLIP_SEC) return fail('too long', clipSec);
              return m.run(analyse(mcfg, samples, true, null, 0, false), clipSec, opts);
            } catch (e) {
              var r = fail('error', 0);
              r.error = String(e && e.message ? e.message : e);
              return r;
            }
          },
          matchSpectrogram: function (mags, frames, opts) {
            try {
              var bins = mcfg.fftSize / 2 + 1;
              if (!(mags instanceof Float32Array) && !(mags instanceof Float64Array)) return fail('bad input', 0);
              if (!isNum(frames) || frames !== Math.floor(frames) || frames < 1 || mags.length < frames * bins) return fail('bad input', 0);
              var clipSec = ((frames - 1) * mcfg.hop + mcfg.fftSize) / mcfg.sampleRate;
              if (clipSec < mcfg.minClipSec) return fail('too short', clipSec);
              if (clipSec > MAX_CLIP_SEC) return fail('too long', clipSec);
              return m.run(analyse(mcfg, null, true, mags, frames, !!(opts && opts.power)), clipSec, opts);
            } catch (e) {
              var r = fail('error', 0);
              r.error = String(e && e.message ? e.message : e);
              return r;
            }
          },
          quietAt: function (filmSec, clipSec) {
            try {
              if (!isNum(filmSec)) return false;
              return m.quietAt(filmSec, isNum(clipSec) && clipSec > 0 ? clipSec : 0);
            } catch (e) {
              return false;
            }
          }
        };
      } catch (e) {
        return null;
      }
    }

    function createTracker(opts) {
      var t;
      try {
        t = new Tracker(opts);
      } catch (e) {
        t = new Tracker(null);
      }
      return {
        onMatch: function (result, clipStartMono, nowMono) {
          try { return t.onMatch(result, clipStartMono, nowMono); } catch (e) { return t.status; }
        },
        onMiss: function (clipStartMono, clipSec, info) {
          try { return t.onMiss(clipStartMono, clipSec, info); } catch (e) { return t.status; }
        },
        state: function (nowMono) {
          try { return t.state(nowMono); } catch (e) { return { status: 'searching', filmSec: null, sinceLastFixSec: null, justJumped: false, error: 'state failed' }; }
        },
        nextListen: function (nowMono) {
          try { return t.nextListen(nowMono); } catch (e) { return { waitSec: 1, clipSec: 8 }; }
        },
        expect: function (clipStartMono) {
          try { return t.expect(clipStartMono); } catch (e) { return {}; }
        },
        hurry: function () { t.hurry(); },
        reset: function () { t.reset(); }
      };
    }

    var api = {
      VERSION: VERSION,
      FORMAT_VERSION: FORMAT_VERSION,
      PARAMS: copyParams(cfg, null),
      error: problem || null,
      fingerprint: fingerprint,
      landmarks: landmarks,
      spectrogram: spectrogram,
      encode: function (pr) { try { return encodePrint(pr); } catch (e) { return null; } },
      decode: function (bytes) {
        try {
          if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
          return decodePrint(bytes);
        } catch (e) {
          return null;
        }
      },
      createMatcher: createMatcher,
      createTracker: createTracker,
      planCues: function (cues, state, opts) {
        try { return planCues(cues, state, opts); } catch (e) { return { action: 'wait', waitSec: 1, reason: 'error', error: String(e && e.message ? e.message : e) }; }
      },
      configure: function (over) {
        try {
          return make(copyParams(cfg, over));
        } catch (e) {
          return make(copyParams(cfg, null));
        }
      }
    };
    return api;
  }

  var SyncPrint = make(null);
  if (typeof module !== 'undefined' && module && typeof module.exports !== 'undefined') {
    module.exports = SyncPrint;
  } else {
    root.SyncPrint = SyncPrint;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
