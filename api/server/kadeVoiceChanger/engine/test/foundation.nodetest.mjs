// test/foundation.nodetest.mjs - tests for the shared DSP core and the test helpers.
// Run: node --test engine/test/   (Node 24)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as B from '../core/buf.js'
import { makeRng } from '../core/rng.js'
import { FFT, rfft, irfft } from '../core/fft.js'
import { hann, sqrtHann, hamming, blackman, kaiser } from '../core/window.js'
import { spectralProcess, stftFrames, istftFrames } from '../core/stft.js'
import { Biquad, filterChain, OnePole, SVF, rbjCoefs } from '../core/biquad.js'
import { DelayLine } from '../core/delay.js'
import { LFO } from '../core/lfo.js'
import { white, pink, brown, velvet, crackle, burstEnvelope } from '../core/noise.js'
import * as S from '../core/shape.js'
import { synthVoice, impulse, silence, sine, chirp, noiseBuf, loadWav, localDecodeWav } from './fixtures.mjs'
import {
  assertSane, medianF0, spectralCentroid, bandEnergyDb, stereoCorrelation, rmsDb,
  lengthSeconds, timeIt, formantShiftEstimate, formantShiftSemitones,
} from './measure.mjs'

const CORE_DIR = fileURLToPath(new URL('../core/', import.meta.url))

function maxAbsDiff(a, b, from = 0, to = a.length) {
  let m = 0
  for (let i = from; i < to; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

function randomSig(n, seed = 7) {
  const r = makeRng(seed)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = r.next() * 2 - 1
  return s
}

// Lock-in amplitude of frequency hz over the last `cycles` whole periods.
function toneAmp(sig, sr, hz, cycles = 20) {
  const N = Math.min(sig.length, Math.round((cycles * sr) / hz))
  const p = (sr / hz) * Math.floor((N * hz) / sr)
  const n = Math.max(8, Math.round(p))
  const s0 = sig.length - n
  let c = 0
  let s = 0
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * hz * (s0 + i)) / sr
    c += sig[s0 + i] * Math.cos(w)
    s += sig[s0 + i] * Math.sin(w)
  }
  return (2 * Math.sqrt(c * c + s * s)) / n
}

// ---------------------------------------------------------------- rng
describe('rng', () => {
  test('same seed gives the same stream, different seeds differ', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    const c = makeRng(43)
    let same = true
    let diff = 0
    for (let i = 0; i < 1000; i++) {
      const x = a.next()
      if (x !== b.next()) same = false
      if (x !== c.next()) diff++
    }
    assert.ok(same)
    assert.ok(diff > 990)
    assert.equal(makeRng('giant-in-a-cave').next(), makeRng('giant-in-a-cave').next())
    assert.notEqual(makeRng('a').next(), makeRng('b').next())
    assert.notEqual(makeRng(1).next(), makeRng(1.5).next())
  })

  test('fork depends only on seed and label', () => {
    const a = makeRng(9)
    const b = makeRng(9)
    for (let i = 0; i < 37; i++) b.next()
    const fa = a.fork('stage-2')
    const fb = b.fork('stage-2')
    for (let i = 0; i < 100; i++) assert.equal(fa.next(), fb.next())
    assert.notEqual(a.fork('x').next(), a.fork('y').next())
  })

  test('ranges and distributions', () => {
    const r = makeRng('dist')
    let sum = 0
    let sq = 0
    const N = 200000
    let lo = 1
    let hi = 0
    for (let i = 0; i < N; i++) {
      const u = r.next()
      if (u < lo) lo = u
      if (u > hi) hi = u
      const g = r.gauss()
      sum += g
      sq += g * g
    }
    assert.ok(lo >= 0 && hi < 1)
    assert.ok(Math.abs(sum / N) < 0.01)
    assert.ok(Math.abs(sq / N - 1) < 0.02)
    for (let i = 0; i < 1000; i++) {
      const k = r.int(7)
      assert.ok(Number.isInteger(k) && k >= 0 && k < 7)
      const x = r.range(-3, 5)
      assert.ok(x >= -3 && x < 5)
    }
    assert.ok(['a', 'b', 'c'].includes(r.pick(['a', 'b', 'c'])))
    assert.equal(r.pick([]), undefined)
    assert.equal(r.int(0), 0)
  })

  test('core never calls Math.random', () => {
    for (const f of readdirSync(CORE_DIR)) {
      if (!f.endsWith('.js')) continue
      const src = readFileSync(join(CORE_DIR, f), 'utf8')
      assert.ok(!/Math\.random\s*\(/.test(src), f + ' calls Math.random')
    }
  })
})

// ---------------------------------------------------------------- fft
describe('fft', () => {
  test('complex round trip is exact at 16, 4096 and 32768', () => {
    for (const n of [16, 4096, 32768]) {
      const f = new FFT(n)
      const re0 = Float64Array.from(randomSig(n, n))
      const im0 = Float64Array.from(randomSig(n, n + 1))
      const re = Float64Array.from(re0)
      const im = Float64Array.from(im0)
      f.forward(re, im)
      f.inverse(re, im)
      assert.ok(maxAbsDiff(re, re0) < 1e-5, 'n=' + n)
      assert.ok(maxAbsDiff(im, im0) < 1e-5, 'n=' + n)
    }
  })

  test('known spectra: impulse, cosine, sine, against a direct DFT', () => {
    const n = 64
    const f = new FFT(n)
    let re = new Float64Array(n)
    let im = new Float64Array(n)
    re[0] = 1
    f.forward(re, im)
    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(re[k] - 1) < 1e-12 && Math.abs(im[k]) < 1e-12)
    }
    const k0 = 5
    re = new Float64Array(n)
    im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / n) + 0.5 * Math.sin((2 * Math.PI * 9 * i) / n)
    const x = Float64Array.from(re)
    f.forward(re, im)
    assert.ok(Math.abs(re[k0] - n / 2) < 1e-9)
    assert.ok(Math.abs(im[9] + n / 4) < 1e-9)
    // direct DFT comparison
    for (let k = 0; k < n; k++) {
      let dr = 0
      let di = 0
      for (let i = 0; i < n; i++) {
        dr += x[i] * Math.cos((2 * Math.PI * k * i) / n)
        di -= x[i] * Math.sin((2 * Math.PI * k * i) / n)
      }
      assert.ok(Math.abs(dr - re[k]) < 1e-9 && Math.abs(di - im[k]) < 1e-9)
    }
  })

  test('rfft matches the complex transform and irfft inverts it', () => {
    for (const n of [16, 1024, 4096]) {
      const f = new FFT(n)
      const x = randomSig(n, 3 * n)
      const { re, im } = rfft(f, x)
      assert.equal(re.length, n / 2 + 1)
      const cr = Float64Array.from(x)
      const ci = new Float64Array(n)
      f.forward(cr, ci)
      assert.ok(maxAbsDiff(re, cr, 0, n / 2 + 1) < 1e-9)
      assert.ok(maxAbsDiff(im, ci, 0, n / 2 + 1) < 1e-9)
      const y = irfft(f, re, im)
      assert.ok(y instanceof Float32Array && y.length === n)
      assert.ok(maxAbsDiff(y, x) < 1e-5)
    }
    // shorter input is zero padded
    const f = new FFT(32)
    const { re } = rfft(f, new Float32Array([1, 1]))
    assert.ok(Math.abs(re[0] - 2) < 1e-12)
    assert.throws(() => new FFT(1000), /power of two/)
  })

  test('speed: 2048-point real forward plus inverse', () => {
    const f = new FFT(2048)
    const x = randomSig(2048)
    const re = new Float64Array(1025)
    const im = new Float64Array(1025)
    const out = new Float64Array(2048)
    const ms = timeIt(() => {
      for (let i = 0; i < 1000; i++) {
        f.realForward(x, re, im)
        f.realInverse(re, im, out)
      }
    }, 3)
    assert.ok(ms < 400, 'took ' + ms + ' ms for 1000 pairs')
  })
})

// ---------------------------------------------------------------- windows
describe('windows', () => {
  test('periodic Hann overlaps to a constant; sqrtHann squared is Hann', () => {
    const n = 512
    const w = hann(n)
    for (let i = 0; i < n / 2; i++) assert.ok(Math.abs(w[i] + w[i + n / 2] - 1) < 1e-12)
    const s = sqrtHann(n)
    for (let i = 0; i < n; i++) assert.ok(Math.abs(s[i] * s[i] - w[i]) < 1e-12)
    const hs = hann(9, true)
    assert.ok(Math.abs(hs[0]) < 1e-12 && Math.abs(hs[8]) < 1e-12 && Math.abs(hs[4] - 1) < 1e-12)
    assert.ok(Math.abs(hamming(9, true)[0] - 0.08) < 1e-12)
    assert.ok(Math.abs(blackman(64)[0] - 128 / 18608) < 1e-12)
    const k = kaiser(65, 8)
    assert.ok(Math.abs(k[32] - 1) < 1e-12 && Math.abs(k[0] - k[64]) < 1e-12 && k[0] < 0.01)
  })
})

// ---------------------------------------------------------------- stft
describe('stft', () => {
  test('a no-op callback returns the input, edges included', () => {
    const x = randomSig(48000 + 123, 11)
    const cases = [
      { size: 2048, hop: 512 },
      { size: 2048 },
      { size: 1024, hop: 512, window: 'sqrthann' },
      { size: 512, hop: 128, window: 'blackman' },
      { size: 1024, hop: 300, window: 'hamming' },
      { size: 256, hop: 256, window: 'rect' },
    ]
    for (const o of cases) {
      let frames = 0
      const y = spectralProcess(x, o, (re, im, f, info) => {
        assert.equal(re.length, (o.size >> 1) + 1)
        assert.equal(f, frames)
        assert.equal(info.size, o.size)
        frames++
      })
      assert.equal(y.length, x.length)
      assert.ok(maxAbsDiff(y, x) < 1e-4, JSON.stringify(o) + ' err ' + maxAbsDiff(y, x))
      assert.ok(Math.abs(y[0] - x[0]) < 1e-4 && Math.abs(y[x.length - 1] - x[x.length - 1]) < 1e-4)
      assert.ok(frames > 0)
    }
  })

  test('short, empty and silent signals', () => {
    const x = randomSig(100, 5)
    assert.ok(maxAbsDiff(spectralProcess(x, { size: 2048 }, () => {}), x) < 1e-4)
    assert.equal(spectralProcess(new Float32Array(0), {}, () => {}).length, 0)
    const z = spectralProcess(new Float32Array(5000), {}, () => {})
    assert.ok(z.every((v) => v === 0))
  })

  test('zeroing every bin gives silence; callback edits are heard', () => {
    const x = B.fade(sine(48000, 1, 1000, 0.5), 0.05, 0.05).ch[0]
    const y = spectralProcess(x, { size: 1024 }, (re, im) => {
      re.fill(0)
      im.fill(0)
    })
    assert.ok(B.peak(y) < 1e-9)
    // keep only bins below 500 Hz: the 1 kHz tone should vanish
    const z = spectralProcess(x, { size: 1024 }, (re, im) => {
      for (let k = 11; k < re.length; k++) {
        re[k] = 0
        im[k] = 0
      }
    })
    assert.ok(rmsDb(z) < -60)
  })

  test('stftFrames and istftFrames round trip', () => {
    const x = randomSig(20000, 2)
    const o = { size: 1024, hop: 256 }
    const fr = stftFrames(x, o)
    assert.equal(fr.layout.frames, fr.length)
    const y = istftFrames(fr, o, x.length)
    assert.ok(maxAbsDiff(y, x) < 1e-4)
  })

  test('speed: one second at 48 kHz, size 2048, hop 512', () => {
    const x = randomSig(48000)
    spectralProcess(x, {}, () => {})
    const ms = timeIt(() => spectralProcess(x, {}, () => {}), 3)
    assert.ok(ms < 150, 'took ' + ms + ' ms')
  })
})

// ---------------------------------------------------------------- biquad
// Analytic magnitude of the RBJ analog prototypes at the bilinear-warped
// frequency, which is exactly what the digital filter must produce.
function analyticDb(type, sr, f0, q, gainDb, f) {
  const W = Math.tan((Math.PI * f) / sr) / Math.tan((Math.PI * f0) / sr)
  const A = Math.pow(10, gainDb / 40)
  // complex helpers on s = jW: polynomial a*s^2 + b*s + c
  const poly = (a, b, c) => [c - a * W * W, b * W]
  const mag = (p) => Math.hypot(p[0], p[1])
  let num, den
  switch (type) {
    case 'lowpass': num = poly(0, 0, 1); den = poly(1, 1 / q, 1); break
    case 'highpass': num = poly(1, 0, 0); den = poly(1, 1 / q, 1); break
    case 'bandpass': num = poly(0, 1 / q, 0); den = poly(1, 1 / q, 1); break
    case 'notch': num = poly(1, 0, 1); den = poly(1, 1 / q, 1); break
    case 'allpass': num = poly(1, -1 / q, 1); den = poly(1, 1 / q, 1); break
    case 'peak': num = poly(1, A / q, 1); den = poly(1, 1 / (A * q), 1); break
    case 'lowshelf': {
      const n = poly(1, Math.sqrt(A) / q, A)
      num = [A * n[0], A * n[1]]
      den = poly(A, Math.sqrt(A) / q, 1)
      break
    }
    case 'highshelf': {
      const n = poly(A, Math.sqrt(A) / q, 1)
      num = [A * n[0], A * n[1]]
      den = poly(1, Math.sqrt(A) / q, A)
      break
    }
  }
  return 20 * Math.log10(mag(num) / mag(den))
}

describe('biquad', () => {
  const specs = [
    ['lowpass', 1000, 0.707, 0],
    ['highpass', 500, 2, 0],
    ['bandpass', 1500, 4, 0],
    ['notch', 2000, 1, 0],
    ['allpass', 800, 0.9, 0],
    ['peak', 1200, 1.5, 9],
    ['peak', 300, 3, -12],
    ['lowshelf', 250, 0.707, 6],
    ['highshelf', 4000, 0.707, -8],
  ]

  test('sine responses match the analytic magnitude within 0.5 dB', () => {
    for (const sr of [48000, 16000]) {
      for (const [type, f0, q, g] of specs) {
        for (const ratio of [0.25, 0.5, 1, 2, 3.5]) {
          const f = f0 * ratio
          if (f > sr * 0.45) continue
          if (type === 'notch' && ratio === 1) continue
          const want = analyticDb(type, sr, f0, q, g, f)
          const bq = new Biquad(type, sr, f0, q, g)
          assert.ok(Math.abs(bq.magnitudeDb(f) - want) < 0.01, type + ' formula at ' + f)
          const x = sine(sr, 0.6, f, 1).ch[0]
          bq.run(x)
          const got = 20 * Math.log10(toneAmp(x, sr, f))
          assert.ok(Math.abs(got - want) < 0.5, `${type} ${f0} Hz at ${f} Hz, sr ${sr}: got ${got.toFixed(2)} want ${want.toFixed(2)}`)
        }
      }
    }
    // spot checks with known numbers
    assert.ok(Math.abs(new Biquad('lowpass', 48000, 1000).magnitudeDb(1000) + 3.01) < 0.05)
    assert.ok(Math.abs(new Biquad('peak', 48000, 1000, 1, 6).magnitudeDb(1000) - 6) < 1e-6)
    assert.ok(Math.abs(new Biquad('bandpass', 48000, 1000, 5).magnitudeDb(1000)) < 1e-6)
    assert.ok(new Biquad('notch', 48000, 1000, 2).magnitudeDb(1000) < -100)
  })

  test('tick equals run; filterChain; set keeps state; reset', () => {
    const x = randomSig(2000)
    const a = new Biquad('peak', 44100, 700, 2, 5)
    const b = new Biquad('peak', 44100, 700, 2, 5)
    const y = Float32Array.from(x)
    a.run(y)
    for (let i = 0; i < x.length; i++) assert.ok(Math.abs(b.tick(x[i]) - y[i]) < 1e-6)
    const z = Float32Array.from(x)
    filterChain(z, 44100, [{ type: 'peak', freq: 700, q: 2, gain: 5 }])
    assert.ok(maxAbsDiff(z, y) < 1e-6)
    assert.throws(() => new Biquad('wobble', 48000, 100), /Unknown filter type/)
    const c = rbjCoefs('lp', 48000, 1e9)
    assert.ok(Object.values(c).every(Number.isFinite))
  })

  test('silent tails decay to exact zero (no denormals)', () => {
    const bq = new Biquad('lowpass', 48000, 60, 0.707)
    const x = impulse(48000, 3).ch[0]
    bq.run(x)
    assert.equal(x[x.length - 1], 0)
    assert.equal(bq.y1, 0)
  })

  test('non-finite input does not poison the filter', () => {
    const bq = new Biquad('lowpass', 48000, 1000)
    const x = new Float32Array(100)
    x[10] = NaN
    bq.run(x)
    const y = new Float32Array(100).fill(0.5)
    bq.run(y)
    assert.ok(y.every(Number.isFinite))
  })

  test('one-pole is -3 dB at its cutoff', () => {
    for (const mode of ['lp', 'hp']) {
      const x = sine(48000, 0.5, 2000, 1).ch[0]
      new OnePole(48000, 2000, mode).run(x)
      const db = 20 * Math.log10(toneAmp(x, 48000, 2000))
      assert.ok(Math.abs(db + 3.01) < 0.1, mode + ' ' + db)
    }
  })

  test('SVF responses and stability under per-sample modulation', () => {
    const sr = 48000
    const x = sine(sr, 0.5, 3000, 1).ch[0]
    new SVF(sr).run(x, 3000, 0.7071, 'lp')
    assert.ok(Math.abs(20 * Math.log10(toneAmp(x, sr, 3000)) + 3.01) < 0.1)
    const xn = sine(sr, 0.5, 3000, 1).ch[0]
    new SVF(sr).run(xn, 3000, 1, 'notch')
    assert.ok(toneAmp(xn, sr, 3000) < 0.01)

    const r = makeRng('svf')
    const svf = new SVF(sr)
    const n = sr * 2
    let mx = 0
    for (let i = 0; i < n; i++) {
      const freq = r.next() < 0.5 ? 20 + r.next() * 30 : 15000 + r.next() * 9000
      const q = 0.1 + r.next() * 40
      const o = svf.tick(r.next() * 2 - 1, freq, q)
      for (const v of [o.lp, o.bp, o.hp, o.notch]) {
        assert.ok(Number.isFinite(v))
        if (Math.abs(v) > mx) mx = Math.abs(v)
      }
    }
    assert.ok(mx < 100, 'peak ' + mx)
    // audio-rate sine sweep of the cutoff with high resonance
    const lfo = new LFO(sr, { rate: 400 })
    const s2 = new SVF(sr)
    const y = noiseBuf(sr, 1).ch[0]
    const fr = new Float32Array(y.length)
    for (let i = 0; i < y.length; i++) fr[i] = 2000 * Math.pow(8, lfo.next())
    s2.run(y, fr, 25, 'bp')
    assertSane({ sr, ch: [y] }, { maxPeak: 60 })
  })

  test('speed: biquad and SVF over one second at 48 kHz', () => {
    const x = randomSig(48000)
    const bq = new Biquad('peak', 48000, 1000, 1, 3)
    const ms = timeIt(() => bq.run(x), 5)
    assert.ok(ms < 10, 'biquad ' + ms)
    const svf = new SVF(48000)
    const ms2 = timeIt(() => svf.run(x, 1000, 2, 'lp'), 5)
    assert.ok(ms2 < 25, 'svf ' + ms2)
  })
})

// ---------------------------------------------------------------- delay
describe('delay', () => {
  test('integer delay is exact, fractional reads are smooth', () => {
    const d = new DelayLine(1000)
    assert.ok(d.maxDelay >= 1000)
    const x = randomSig(3000)
    for (let i = 0; i < x.length; i++) {
      d.write(x[i])
      if (i >= 700) assert.equal(d.read(700), x[i - 700])
      if (i >= 1) assert.equal(d.read(0), x[i])
    }
    // fractional: a slow sine delayed by 10.37 samples
    const sr = 48000
    const hz = 500
    const dl = new DelayLine(64)
    let errC = 0
    let errL = 0
    for (let i = 0; i < 2000; i++) {
      dl.write(Math.sin((2 * Math.PI * hz * i) / sr))
      if (i > 100) {
        const want = Math.sin((2 * Math.PI * hz * (i - 10.37)) / sr)
        errC = Math.max(errC, Math.abs(dl.read(10.37) - want))
        errL = Math.max(errL, Math.abs(dl.readLinear(10.37) - want))
      }
    }
    assert.ok(errC < 2e-5, 'cubic ' + errC)
    assert.ok(errL < 2e-3, 'linear ' + errL)
    assert.ok(errC < errL)
    assert.ok(Number.isFinite(dl.read(-5)) && Number.isFinite(dl.read(1e9)) && Number.isFinite(dl.read(NaN)))
    assert.equal(dl.tap(3), dl.read(3))
    dl.clear()
    assert.equal(dl.read(5), 0)
  })
})

// ---------------------------------------------------------------- lfo
describe('lfo', () => {
  test('shapes stay in range and keep their period', () => {
    const sr = 1000
    for (const shape of ['sine', 'triangle', 'square', 'saw', 'ramp', 'random', 'smooth']) {
      const l = new LFO(sr, { shape, rate: 2, rng: makeRng(shape) })
      let lo = 9
      let hi = -9
      let maxStep = 0
      let prev = l.peek()
      for (let i = 0; i < 5000; i++) {
        const v = l.next()
        if (v < lo) lo = v
        if (v > hi) hi = v
        if (i) maxStep = Math.max(maxStep, Math.abs(v - prev))
        prev = v
      }
      assert.ok(lo >= -1 && hi <= 1, shape)
      if (shape === 'smooth') assert.ok(maxStep < 0.02, 'smooth step ' + maxStep)
    }
    const s = new LFO(sr, { rate: 10 })
    const vals = Array.from({ length: 200 }, () => s.next())
    assert.ok(Math.abs(vals[0]) < 1e-12 && Math.abs(vals[25] - 1) < 1e-9 && Math.abs(vals[100]) < 1e-9)
    const sq = new LFO(sr, { shape: 'square', rate: 10 })
    const sv = Array.from({ length: 100 }, () => sq.next())
    assert.equal(sv.filter((v) => v > 0).length, 50)
    const tri = new LFO(sr, { shape: 'triangle', rate: 10, phase: 0.25 })
    assert.ok(Math.abs(tri.next() - 1) < 1e-12)
  })

  test('random is stepped once per cycle and deterministic', () => {
    const a = new LFO(100, { shape: 'random', rate: 1, rng: makeRng(5) })
    const b = new LFO(100, { shape: 'random', rate: 1, rng: makeRng(5) })
    const va = Array.from({ length: 1000 }, () => a.next())
    const vb = Array.from({ length: 1000 }, () => b.next())
    assert.deepEqual(va, vb)
    let changes = 0
    for (let i = 1; i < va.length; i++) if (va[i] !== va[i - 1]) changes++
    assert.ok(changes >= 9 && changes <= 10)
  })
})

// ---------------------------------------------------------------- noise
function octaveDensities(sig, sr, f0, nOct) {
  const out = []
  for (let k = 0; k < nOct; k++) {
    const lo = f0 * Math.pow(2, k)
    const hi = lo * 2
    // band energy minus 10log10(bandwidth) = spectral density in dB per Hz
    out.push(bandEnergyDb(sig, sr, lo, hi) - 10 * Math.log10(hi - lo))
  }
  return out
}

function slopePerOctave(d) {
  const n = d.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sx += i; sy += d[i]; sxx += i * i; sxy += i * d[i]
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx)
}

describe('noise', () => {
  const sr = 48000

  test('white is uniform in -1..1', () => {
    const w = white(100000, makeRng(1))
    assert.ok(B.peak(w) <= 1)
    assert.ok(Math.abs(B.rms(w) - 1 / Math.sqrt(3)) < 0.01)
  })

  test('pink falls about 3 dB per octave', () => {
    const p = pink(sr * 8, makeRng('pink'))
    const s = slopePerOctave(octaveDensities(p, sr, 50, 8))
    assert.ok(s < -2.5 && s > -3.5, 'slope ' + s.toFixed(2))
    assert.ok(Math.abs(B.rms(p) - 0.2) < 0.03, 'rms ' + B.rms(p))
  })

  test('brown falls about 6 dB per octave above its corner', () => {
    const b = brown(sr * 8, makeRng('brown'))
    const s = slopePerOctave(octaveDensities(b, sr, 200, 6))
    assert.ok(s < -5 && s > -7, 'slope ' + s.toFixed(2))
    assert.ok(Math.abs(B.rms(b) - 0.2) < 0.06, 'rms ' + B.rms(b))
  })

  test('velvet has one signed impulse per grid period', () => {
    const v = velvet(sr, sr, 2000, makeRng(3))
    let count = 0
    for (const x of v) if (x !== 0) {
      count++
      assert.ok(x === 1 || x === -1)
    }
    assert.ok(Math.abs(count - 2000) <= 1)
  })

  test('crackle and burst envelopes are sane and seeded', () => {
    const c = crackle(sr * 4, sr, 30, makeRng(8))
    assertSane({ sr, ch: [c] }, { maxPeak: 4 })
    let events = 0
    for (let i = 1; i < c.length; i++) if (c[i] !== 0 && c[i - 1] === 0) events++
    assert.ok(events > 60 && events < 200, 'events ' + events)
    assert.deepEqual(crackle(1000, sr, 50, makeRng(8)), crackle(1000, sr, 50, makeRng(8)))
    assert.equal(crackle(0, sr, 30, makeRng(1)).length, 0)
    const e = burstEnvelope(sr * 5, sr, { rate: 2 }, makeRng(2))
    assert.ok(B.peak(e) <= 1 && B.peak(e) > 0.2)
    for (const v of e) assert.ok(v >= 0)
    const e2 = burstEnvelope(sr, sr, { events: [0.5], attackMs: 10, holdMs: 10, releaseMs: 10 })
    assert.ok(e2[Math.round(0.515 * sr)] === 1 && e2[Math.round(0.4 * sr)] === 0)
  })
})

// ---------------------------------------------------------------- shape
describe('shape', () => {
  test('G.711 companders invert and hit known values', () => {
    assert.ok(Math.abs(S.muLaw(1) - 1) < 1e-12)
    assert.ok(Math.abs(S.muLaw(0.5) - Math.log(128.5) / Math.log(256)) < 1e-12)
    assert.ok(Math.abs(S.aLaw(1) - 1) < 1e-12)
    // A-law branches meet at |x| = 1/A
    const A = 87.6
    assert.ok(Math.abs(S.aLaw(1 / A - 1e-12) - S.aLaw(1 / A + 1e-12)) < 1e-9)
    for (let x = -1; x <= 1; x += 0.0137) {
      assert.ok(Math.abs(S.muLawInv(S.muLaw(x)) - x) < 1e-9)
      assert.ok(Math.abs(S.aLawInv(S.aLaw(x)) - x) < 1e-9)
      assert.ok(Math.sign(S.muLaw(x)) === Math.sign(x) || x === 0)
    }
    assert.equal(S.muLaw(NaN), 0)
    assert.equal(S.aLawInv(Infinity), 0)
  })

  test('crush is a symmetric mid-tread quantiser', () => {
    assert.equal(S.crush(0.01, 4), 0)
    assert.equal(S.crush(-0.3, 4), -S.crush(0.3, 4))
    const levels = new Set()
    for (let x = -1; x <= 1; x += 0.001) levels.add(S.crush(x, 3))
    assert.equal(levels.size, 9) // -1 .. 1 in steps of 0.25
    assert.equal(S.crush(5, 8), 1)
    assert.equal(S.crush(NaN, 8), 0)
    assert.ok(Math.abs(S.crush(0.123456, 24) - 0.123456) < 1e-6)
  })

  test('other shapers', () => {
    for (let x = -10; x <= 10; x += 0.01) {
      const f = S.fold(x, 0.5)
      assert.ok(f >= -0.5 - 1e-12 && f <= 0.5 + 1e-12)
      assert.ok(Number.isFinite(S.tube(x, 0.3)) && Number.isFinite(S.softClip(x, 4)) && Number.isFinite(S.diode(x, 1)))
      assert.ok(Math.abs(S.tanhFast(x) - Math.tanh(x)) < 2e-3)
      assert.ok(Math.abs(S.hardClip(x, 0.7)) <= 0.7)
    }
    assert.ok(Math.abs(S.fold(0.3, 0.5) - 0.3) < 1e-12)
    assert.ok(Math.abs(S.fold(0.7, 0.5) - 0.3) < 1e-12)
    assert.ok(Math.abs(S.softClip(1, 3) - 1) < 1e-12)
    assert.ok(Math.abs(S.softClip(0.5, 1e-6) - 0.5) < 1e-9)
    assert.equal(S.rectify(-0.4, 1), 0.4)
    assert.equal(S.rectify(-0.4, -1), 0)
    assert.equal(S.rectify(-0.4, 0), -0.4)
    assert.ok(Math.abs((S.tube(1e-6, 0.4) - S.tube(0, 0.4)) / 1e-6 - 1) < 1e-4)
    assert.equal(S.tube(0, 0.4), 0)
    const th = 0.7
    assert.ok(Math.abs(S.chebyshev(Math.cos(th), 3) - Math.cos(3 * th)) < 1e-12)
    assert.equal(S.fold(Infinity, 1), 0)
    const sig = Float32Array.from([0.5, -2, 3])
    S.shapeSig(sig, S.hardClip, 1)
    assert.deepEqual(Array.from(sig), [0.5, -1, 1])
  })
})

// ---------------------------------------------------------------- buf
describe('buf', () => {
  test('construction, copies, channels, slices', () => {
    const b = B.makeBuf(48000, 2, 480)
    assert.equal(b.ch.length, 2)
    assert.equal(B.bufLen(b), 480)
    b.ch[0][0] = 1
    const c = B.cloneBuf(b)
    c.ch[0][0] = 2
    assert.equal(b.ch[0][0], 1)
    const m = B.toMono(b)
    assert.equal(m.ch.length, 1)
    assert.equal(m.ch[0][0], 0.5)
    const st = B.toStereo(B.makeBuf(8000, 1, 10))
    assert.equal(st.ch.length, 2)
    assert.notEqual(st.ch[0], st.ch[1])
    const sl = B.sliceBuf(B.makeBuf(1000, 1, 1000), 0.25, 0.5)
    assert.equal(B.bufLen(sl), 250)
    assert.equal(B.bufLen(B.sliceBuf(b, 5, 2)), 0)
    assert.equal(B.bufLen(B.padBuf(b, 0.01)), 960)
    assert.equal(B.bufLen(B.makeBuf(48000, 1, 0)), 0)
  })

  test('mixing, levels, sanitize, fade, mapChannels', () => {
    const d = B.makeBuf(100, 2, 10)
    const s = { sr: 100, ch: [new Float32Array(5).fill(1)] }
    B.mixInto(d, s, 0.5, 7)
    assert.deepEqual(Array.from(d.ch[1]), [0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5])
    B.mixInto(d, s, 1, -3)
    assert.equal(d.ch[0][0], 1)
    assert.equal(d.ch[0][2], 0)
    assert.equal(B.peak(d), 1)
    assert.ok(Math.abs(B.rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-12)
    assert.ok(Math.abs(B.dbToGain(-6) - 0.501187) < 1e-5)
    assert.ok(Math.abs(B.gainToDb(0.5) + 6.0206) < 1e-3)
    assert.equal(B.gainToDb(0), -200)
    const bad = { sr: 1, ch: [Float32Array.from([NaN, 1, Infinity, -Infinity, 1e-40])] }
    assert.equal(B.sanitize(bad), 3)
    assert.deepEqual(Array.from(bad.ch[0]), [0, 1, 0, 0, 0])
    const f = { sr: 100, ch: [new Float32Array(100).fill(1)] }
    B.fade(f, 0.1, 0.1)
    assert.ok(f.ch[0][0] < 0.05 && f.ch[0][99] < 0.05 && f.ch[0][50] === 1)
    const mc = B.mapChannels(B.makeBuf(10, 2, 4), (x, i) => x.fill(i + 1))
    assert.deepEqual(Array.from(mc.ch[1]), [2, 2, 2, 2])
  })
})

// ---------------------------------------------------------------- fixtures and measures
describe('fixtures and measures', () => {
  test('synthVoice pitch is what was asked (independent autocorrelation)', () => {
    for (const [sr, f0] of [[48000, 140], [48000, 220], [44100, 110], [16000, 180], [8000, 140], [96000, 120]]) {
      const v = synthVoice(sr, 2.5, { f0, seed: f0 + sr })
      assertSane(v, { maxPeak: 1 })
      assert.equal(v.ch[0].length, Math.round(2.5 * sr))
      const m = medianF0(v.ch[0], sr)
      assert.ok(Math.abs(m / f0 - 1) < 0.03, `sr ${sr} f0 ${f0}: measured ${m.toFixed(1)}`)
      let vo = 0
      for (const x of v.meta.voiced) vo += x
      const frac = vo / v.meta.voiced.length
      assert.ok(frac > 0.4 && frac < 0.95, 'voiced fraction ' + frac)
    }
  })

  test('synthVoice glide matches its own ground truth', () => {
    const sr = 48000
    const v = synthVoice(sr, 3, { f0: (t) => 100 + 40 * t })
    const truth = Array.from(v.meta.f0).filter((x) => x > 0).sort((a, b) => a - b)
    const tm = truth[truth.length >> 1]
    const m = medianF0(v.ch[0], sr)
    assert.ok(Math.abs(m / tm - 1) < 0.03, `measured ${m} truth ${tm}`)
  })

  test('synthVoice is deterministic and has speech-like structure', () => {
    const a = synthVoice(16000, 1.5, { seed: 4 })
    const b = synthVoice(16000, 1.5, { seed: 4 })
    const c = synthVoice(16000, 1.5, { seed: 5 })
    assert.deepEqual(a.ch[0], b.ch[0])
    assert.notDeepEqual(a.ch[0], c.ch[0])
    const v = synthVoice(48000, 3, {})
    assert.ok(v.meta.segments.some((s) => s.kind === 'fric'))
    // fricatives put energy up high; a version without them has much less
    const nf = synthVoice(48000, 3, { fricatives: false })
    assert.ok(bandEnergyDb(v.ch[0], 48000, 4000, 8000) > bandEnergyDb(nf.ch[0], 48000, 4000, 8000) + 3)
    assert.ok(spectralCentroid(v.ch[0], 48000) > 300)
    assert.equal(synthVoice(48000, 0, {}).ch[0].length, 0)
  })

  test('formantShiftEstimate tells +4 semitones from 0', () => {
    const sr = 48000
    const base = synthVoice(sr, 3, { f0: 140, seed: 1 })
    const up = synthVoice(sr, 3, { f0: 140, seed: 2, formantScale: Math.pow(2, 4 / 12) })
    const down = synthVoice(sr, 3, { f0: 140, seed: 3, formantScale: Math.pow(2, -4 / 12) })
    const pitchOnly = synthVoice(sr, 3, { f0: 185, seed: 4, sex: 'male' })
    const su = formantShiftSemitones(base, up, sr)
    const sd = formantShiftSemitones(base, down, sr)
    const sp = formantShiftSemitones(base, pitchOnly, sr)
    assert.ok(su > 2.5 && su < 5.5, 'up ' + su)
    assert.ok(sd < -2.5 && sd > -5.5, 'down ' + sd)
    assert.ok(Math.abs(sp) < 1, 'pitch only ' + sp)
    assert.ok(Math.abs(formantShiftEstimate(base.ch[0], base.ch[0], sr) - 1) < 1e-9)
  })

  test('simple fixtures', () => {
    const i = impulse(48000, 0.1, 0.01)
    assert.equal(i.ch[0][480], 1)
    assert.equal(B.peak(i), 1)
    assert.equal(B.peak(silence(8000, 1, 2)), 0)
    assert.equal(silence(8000, 1, 2).ch.length, 2)
    const s = sine(48000, 1, 1000, 1)
    assert.ok(Math.abs(rmsDb(s) + 3.01) < 0.01)
    assert.ok(Math.abs(spectralCentroid(s, 48000) - 1000) < 15)
    assert.ok(Math.abs(bandEnergyDb(s.ch[0], 48000, 900, 1100) + 3.01) < 0.1)
    const ch = chirp(48000, 1, 100, 10000)
    assertSane(ch, { maxPeak: 0.5 })
    assert.ok(bandEnergyDb(ch.ch[0], 48000, 100, 10000) > -10)
    const nb = noiseBuf(48000, 0.5, 'pink', 3, 2)
    assert.equal(nb.ch.length, 2)
    assert.ok(Math.abs(stereoCorrelation(nb)) < 0.1)
    assert.equal(stereoCorrelation({ sr: 1, ch: [nb.ch[0], nb.ch[0]] }), 1)
    assert.ok(Math.abs(stereoCorrelation({ sr: 1, ch: [nb.ch[0], nb.ch[0].map((v) => -v)] }) + 1) < 1e-9)
    assert.equal(lengthSeconds(nb), 0.5)
    assert.throws(() => assertSane({ sr: 1, ch: [Float32Array.from([NaN])] }))
    assert.throws(() => assertSane({ sr: 1, ch: [new Float32Array(2), new Float32Array(3)] }))
    assert.throws(() => assertSane({ sr: 1, ch: [Float32Array.from([9])] }))
  })

  test('loadWav reads 16-bit, 24-bit and float files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-wav-'))
    try {
      const sr = 22050
      const vals = [0, 0.5, -0.5, 0.25, -1]
      const mk = (bits, fmt) => {
        const nch = 2
        const bps = bits / 8
        const data = vals.length * nch * bps
        const u8 = new Uint8Array(44 + data)
        const dv = new DataView(u8.buffer)
        const wr = (o, s) => { for (let k = 0; k < 4; k++) u8[o + k] = s.charCodeAt(k) }
        wr(0, 'RIFF'); dv.setUint32(4, 36 + data, true); wr(8, 'WAVE')
        wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, fmt, true); dv.setUint16(22, nch, true)
        dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * bps, true); dv.setUint16(32, nch * bps, true); dv.setUint16(34, bits, true)
        wr(36, 'data'); dv.setUint32(40, data, true)
        let p = 44
        for (const v of vals) {
          for (let c = 0; c < nch; c++) {
            const x = c ? -v : v
            if (fmt === 3) dv.setFloat32(p, x, true)
            else if (bits === 16) dv.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true)
            else {
              const q = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388608)))
              u8[p] = q & 255; u8[p + 1] = (q >> 8) & 255; u8[p + 2] = (q >> 16) & 255
            }
            p += bps
          }
        }
        return u8
      }
      for (const [bits, fmt] of [[16, 1], [24, 1], [32, 3]]) {
        const path = join(dir, `t${bits}.wav`)
        writeFileSync(path, mk(bits, fmt))
        const b = loadWav(path)
        assert.equal(b.sr, sr)
        assert.equal(b.ch.length, 2)
        for (let k = 0; k < vals.length; k++) {
          assert.ok(Math.abs(b.ch[0][k] - vals[k]) < 1e-4, `${bits} bit L ${k}`)
          assert.ok(Math.abs(b.ch[1][k] + vals[k]) < 1e-4, `${bits} bit R ${k}`)
        }
        const l = localDecodeWav(mk(bits, fmt))
        assert.equal(l.ch[0].length, vals.length)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('speed: synthVoice and medianF0 over 3 seconds at 48 kHz', () => {
    let v
    const t1 = timeIt(() => { v = synthVoice(48000, 3, {}) })
    const t2 = timeIt(() => medianF0(v.ch[0], 48000))
    assert.ok(t1 < 1500, 'synthVoice ' + t1)
    assert.ok(t2 < 1500, 'medianF0 ' + t2)
  })
})

// ---------------------------------------------------------------- engine fixes, Oct 22 2026

describe('core fixes: allocation-free Biquad.set, rng state copies, LFO reset', () => {
  test('Biquad.set writes the cookbook coefficients into the filter without building an object', () => {
    const types = ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'lowshelf', 'highshelf', 'allpass']
    const b = new Biquad('lowpass', 48000, 1000)
    for (const t of types) {
      for (const [f, q, g] of [[50, 0.5, -12], [1000, 0.707, 0], [9000, 4, 9], [23000, 30, 3]]) {
        b.set(t, f, q, g)
        const c = rbjCoefs(t, 48000, f, q, g)
        for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) assert.equal(b[k], c[k], t + ' ' + f + ' Hz ' + k)
      }
    }
    // undefined keeps the old value, exactly as before
    b.set('peak', 2000, 2, 6)
    b.set(undefined, 3000)
    const c = rbjCoefs('peak', 48000, 3000, 2, 6)
    assert.equal(b.b0, c.b0)
    assert.equal(b.a2, c.a2)
    // the live rule: set() must not allocate. Its source calls no helper that
    // returns a new object, and builds no object or array itself.
    const src = Biquad.prototype.set.toString()
    assert.ok(!/rbjCoefs\s*\(/.test(src), 'Biquad.set still calls rbjCoefs, which returns a new object')
    assert.ok(!/\bnew\s|\{\s*b0|\[\s*[^\]\s]/.test(src.replace(/^[^{]*\{/, '')), 'Biquad.set builds an object')
    // rbjCoefs stays exported and still hands back its own object
    const r1 = rbjCoefs('lowpass', 48000, 500)
    const r2 = rbjCoefs('lowpass', 48000, 500)
    assert.notEqual(r1, r2)
    assert.equal(r1.b0, r2.b0)
  })

  test('rng clone, getState and setState copy the generator exactly', () => {
    const r = makeRng('state')
    for (let i = 0; i < 37; i++) r.next()
    r.gauss() // leaves a spare normal behind
    const c = r.clone()
    for (let i = 0; i < 500; i++) {
      assert.equal(c.gauss(), r.gauss())
      assert.equal(c.next(), r.next())
    }
    assert.equal(c.fork('x').next(), r.fork('x').next(), 'a clone keeps the seed, so fork matches')
    const st = new Float64Array(6)
    r.getState(st)
    const a = [r.next(), r.next(), r.gauss()]
    r.setState(st)
    assert.deepEqual([r.next(), r.next(), r.gauss()], a)
    const other = makeRng(99)
    other.setState(st)
    assert.equal(other.next(), a[0])
  })

  test('a reset LFO replays exactly like a fresh one, for every shape', () => {
    const sr = 48000
    for (const shape of ['sine', 'triangle', 'square', 'saw', 'ramp', 'random', 'smooth']) {
      for (const phase of [0, 0.3]) {
        const opts = () => ({ shape, rate: 7, phase, rng: makeRng('lfo-reset') })
        const a = new LFO(sr, opts())
        const first = new Float64Array(20000)
        for (let i = 0; i < first.length; i++) first[i] = a.next()
        a.reset(phase)
        for (let i = 0; i < first.length; i++) {
          const v = a.next()
          if (v !== first[i]) assert.fail(shape + ' (phase ' + phase + ') after reset differs at sample ' + i + ': ' + v + ' vs ' + first[i])
        }
        // and again: a second reset is just as exact
        a.reset(phase)
        const f = new LFO(sr, opts())
        for (let i = 0; i < 5000; i++) assert.equal(a.next(), f.next())
      }
    }
  })

  test('LFO: a fresh one is unchanged, reset keeps the rate, and an rng without clone still works', () => {
    // the values a fresh random LFO draws are the same as before the fix
    const r = makeRng(5)
    const expectA = r.next() * 2 - 1
    const l = new LFO(100, { shape: 'random', rate: 1, rng: makeRng(5) })
    assert.equal(l.next(), expectA)
    // reset keeps a changed rate
    const s = new LFO(1000, { shape: 'saw', rate: 1 })
    s.setRate(10)
    s.reset()
    let wraps = 0
    let prev = s.next()
    for (let i = 0; i < 1000; i++) {
      const v = s.next()
      if (v > prev) wraps++
      prev = v
    }
    assert.ok(wraps >= 9 && wraps <= 10, 'rate kept after reset: ' + wraps + ' cycles')
    // a bare { next } source: no clone, so reset only rewinds the phase, and nothing throws
    let k = 0
    const bare = { next: () => ((k++ * 0.37) % 1) }
    const b = new LFO(100, { shape: 'smooth', rate: 5, rng: bare })
    for (let i = 0; i < 100; i++) b.next()
    b.reset()
    assert.equal(b.phase, 0)
    for (let i = 0; i < 100; i++) assert.ok(Math.abs(b.next()) <= 1)
  })

  test('LFO.reset allocates no new generator: it reuses the copies made at construction', () => {
    const l = new LFO(48000, { shape: 'random', rate: 50, rng: makeRng(2) })
    for (let i = 0; i < 10000; i++) l.next()
    l.reset()
    const r1 = l.rng
    for (let i = 0; i < 10000; i++) l.next()
    l.reset()
    assert.equal(l.rng, r1, 'the same replay copy every time')
  })
})
