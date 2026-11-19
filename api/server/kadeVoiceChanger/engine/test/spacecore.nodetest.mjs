// test/spacecore.nodetest.mjs - tests for the space core: convolution, synthetic
// impulse responses and named spaces, the Hilbert pair and frequency shifter,
// and 3D placement around the head.
// Run (from api/server/kadeVoiceChanger):
//   node --test "engine/test/*.nodetest.mjs"   (Node 24)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { convolve, convolveBuf, convolveMany, chooseBlock } from '../core/conv.js'
import { roomIR, namedIR, SPACE_NAMES, SPACES, spaceSpec, estimateRT60, clearIRCache } from '../core/ir.js'
import { analytic, envelope, freqShift, FreqShifter, HilbertPair } from '../core/hilbert.js'
import { place, circlePath, flyByPath, cartesianPath } from '../core/space3d.js'
import { makeRng } from '../core/rng.js'
import { synthVoice, sine, impulse } from './fixtures.mjs'
import { assertSane, medianF0, spectralCentroid, bandEnergyDb, rmsDb, timeIt, cfft } from './measure.mjs'

const SR = 48000

function randomSig(n, seed = 3) {
  const r = makeRng(seed)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = r.next() * 2 - 1
  return s
}

function naiveConv(x, h) {
  const out = new Float64Array(x.length + h.length - 1)
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    if (v === 0) continue
    for (let j = 0; j < h.length; j++) out[i + j] += v * h[j]
  }
  return out
}

function maxAbsDiff(a, b) {
  let m = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

function peakAbs(a) {
  let m = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > m) m = Math.abs(a[i])
  return m
}

function allFinite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
  return true
}

function monoOf(ir) {
  const L = ir.ch[0]
  const R = ir.ch[1] || ir.ch[0]
  const m = new Float32Array(L.length)
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i])
  return m
}

function energyOf(ch) {
  let e = 0
  for (const c of ch) for (let i = 0; i < c.length; i++) e += c[i] * c[i]
  return e
}

// Lock-in phase (lag, radians) and amplitude of hz over [from, to).
function lockIn(sig, sr, hz, from, to) {
  let c = 0
  let s = 0
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * hz * i) / sr
    c += sig[i] * Math.cos(w)
    s += sig[i] * Math.sin(w)
  }
  return { phase: Math.atan2(s, c), amp: (2 * Math.hypot(c, s)) / (to - from) }
}

function energyBetween(sig, sr, t0, t1) {
  const a = Math.max(0, Math.round(t0 * sr))
  const b = Math.min(sig.length, Math.round(t1 * sr))
  let e = 0
  for (let i = a; i < b; i++) e += sig[i] * sig[i]
  return e
}

function xcorrLag(a, b, maxLag) {
  // Lag (samples) by which b is later than a.
  let best = -Infinity
  let lag = 0
  for (let k = -maxLag; k <= maxLag; k++) {
    let s = 0
    for (let i = maxLag; i < a.length - maxLag; i++) s += a[i] * b[i + k]
    if (s > best) {
      best = s
      lag = k
    }
  }
  return lag
}

// ---------------------------------------------------------------- conv.js

describe('conv: convolution', () => {
  test('matches direct convolution across sizes and paths', () => {
    const cases = [
      [1000, 20], // direct path
      [5000, 300], // one partition
      [20000, 9000], // two partitions of 8192
      [3000, 20000], // response longer than the signal
      [30000, 17000], // three partitions
      [1, 5000],
      [5000, 1],
    ]
    for (const [n, m] of cases) {
      const x = randomSig(n, n)
      const h = randomSig(m, m + 1)
      for (let i = 0; i < m; i++) h[i] *= Math.exp(-i / (m * 0.3 + 1))
      const y = convolve(x, h)
      assert.equal(y.length, n + m - 1)
      const ref = naiveConv(x, h)
      const err = maxAbsDiff(y, ref)
      assert.ok(err < 2e-5 * Math.max(1, peakAbs(ref)), `n=${n} m=${m} err=${err}`)
    }
  })

  test('leading and trailing silence in the response is handled exactly', () => {
    const x = randomSig(12000, 9)
    const h = new Float32Array(30000)
    const core = randomSig(5000, 10)
    h.set(core, 17000) // long predelay, long silent end
    const y = convolve(x, h)
    assert.equal(y.length, x.length + h.length - 1)
    const ref = naiveConv(x, h)
    assert.ok(maxAbsDiff(y, ref) < 1e-4)
    // Nothing before the predelay.
    for (let i = 0; i < 17000; i++) assert.equal(y[i], 0)
  })

  test('empty, silent and non-finite inputs', () => {
    assert.equal(convolve(new Float32Array(0), randomSig(100)).length, 0)
    assert.equal(convolve(randomSig(100), new Float32Array(0)).length, 0)
    const z = convolve(new Float32Array(5000), randomSig(3000))
    assert.equal(z.length, 7999)
    assert.ok(z.every((v) => v === 0))
    const x = randomSig(20000)
    x[500] = NaN
    x[900] = Infinity
    const y = convolve(x, randomSig(2000))
    assert.ok(allFinite(y))
    const h = randomSig(2000)
    h[10] = NaN
    assert.ok(allFinite(convolve(randomSig(20000), h)))
  })

  test('convolveMany shares the input transform and matches single runs', () => {
    const x = randomSig(30000, 4)
    const a = randomSig(9000, 5)
    const b = randomSig(4000, 6)
    const [ya, yb] = convolveMany(x, [a, b])
    assert.ok(maxAbsDiff(ya, convolve(x, a)) < 1e-5)
    assert.ok(maxAbsDiff(yb, convolve(x, b)) < 1e-5)
    assert.equal(chooseBlock(10), 64)
    assert.equal(chooseBlock(5000), 8192)
    assert.equal(chooseBlock(1e6), 8192)
  })

  test('convolveBuf channel layouts, mix and tail', () => {
    const x = randomSig(8000, 11)
    const irL = randomSig(3000, 12)
    const irR = randomSig(3000, 13)
    const mono = { sr: SR, ch: [x] }
    const stIR = { sr: SR, ch: [irL, irR] }
    const moIR = { sr: SR, ch: [irL] }
    // Mono in, stereo response: stereo out.
    let o = convolveBuf(mono, stIR, 100)
    assert.equal(o.ch.length, 2)
    assert.equal(o.ch[0].length, 8000 + 3000 - 1)
    assert.ok(maxAbsDiff(o.ch[0], convolve(x, irL)) < 1e-5)
    assert.ok(maxAbsDiff(o.ch[1], convolve(x, irR)) < 1e-5)
    // Stereo in, mono response.
    const x2 = randomSig(8000, 14)
    o = convolveBuf({ sr: SR, ch: [x, x2] }, moIR, 100)
    assert.ok(maxAbsDiff(o.ch[1], convolve(x2, irL)) < 1e-5)
    // Stereo with stereo pairs sides.
    o = convolveBuf({ sr: SR, ch: [x, x2] }, stIR, 100)
    assert.ok(maxAbsDiff(o.ch[1], convolve(x2, irR)) < 1e-5)
    // Mix 0 is the dry signal, aligned, followed by silence.
    o = convolveBuf(mono, stIR, 0)
    for (let i = 0; i < x.length; i++) assert.equal(o.ch[0][i], x[i])
    for (let i = x.length; i < o.ch[0].length; i++) assert.equal(o.ch[0][i], 0)
    // Mix 50 linear is the average of dry and wet.
    o = convolveBuf(mono, stIR, 50)
    const wet = convolve(x, irL)
    let err = 0
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(o.ch[0][i] - 0.5 * (x[i] + wet[i])))
    assert.ok(err < 1e-5)
    // Equal-power law.
    o = convolveBuf(mono, stIR, 50, { law: 'power' })
    assert.ok(Math.abs(o.ch[0][0] - Math.SQRT1_2 * (x[0] + wet[0])) < 1e-5)
    // Tail off keeps the input length.
    o = convolveBuf(mono, stIR, 100, { tail: false })
    assert.equal(o.ch[0].length, x.length)
    // Rate mismatch is a plain error.
    assert.throws(() => convolveBuf(mono, { sr: 44100, ch: [irL] }), /samples per second/)
    // Zero-length input.
    o = convolveBuf({ sr: SR, ch: [new Float32Array(0)] }, stIR, 30)
    assert.equal(o.ch.length, 2)
  })

  test('speed: 4 s stereo response on 30 s of mono input in under 2 s', () => {
    const x = randomSig(30 * SR, 21)
    const ir = namedIR('large-hall', SR, makeRng(2))
    const L = new Float32Array(4 * SR)
    const R = new Float32Array(4 * SR)
    L.set(ir.ch[0].subarray(0, Math.min(ir.ch[0].length, L.length)))
    R.set(ir.ch[1].subarray(0, Math.min(ir.ch[1].length, R.length)))
    // Make sure the whole 4 s is active (no trimming advantage).
    L[L.length - 1] = 1e-3
    R[R.length - 1] = 1e-3
    let out
    const ms = timeIt(() => {
      out = convolveBuf({ sr: SR, ch: [x] }, { sr: SR, ch: [L, R] }, 100)
    }, 1)
    assert.equal(out.ch.length, 2)
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`)
  })
})

// ---------------------------------------------------------------- hilbert.js

describe('hilbert: analytic pair and frequency shifter', () => {
  test('the pair is 90 degrees apart with equal level across the band', () => {
    for (const [sr, freqs] of [
      [48000, [50, 100, 440, 1000, 5000, 12000, 20000, 23500]],
      [8000, [20, 100, 1000, 3000, 3900]],
      [96000, [100, 1000, 10000, 40000]],
    ]) {
      for (const f of freqs) {
        const n = sr * 2
        const x = new Float32Array(n)
        for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * f * i) / sr)
        const { re, im } = analytic(x)
        const a = lockIn(re, sr, f, sr, n)
        const b = lockIn(im, sr, f, sr, n)
        let d = ((b.phase - a.phase) * 180) / Math.PI
        d = ((d + 540) % 360) - 180
        assert.ok(Math.abs(d - 90) < 1.0, `sr=${sr} f=${f} phase diff ${d}`)
        assert.ok(Math.abs(20 * Math.log10(b.amp / a.amp)) < 0.01)
      }
    }
  })

  test('envelope of a tone is flat; the exact method keeps the input as its real part', () => {
    const x = sine(SR, 1, 700, 0.5).ch[0]
    const env = envelope(x)
    let lo = Infinity, hi = 0
    for (let i = 2000; i < env.length; i++) {
      lo = Math.min(lo, env[i])
      hi = Math.max(hi, env[i])
    }
    assert.ok(hi - lo < 0.01 && Math.abs(hi - 0.5) < 0.01)
    const ex = analytic(x, { method: 'fft' })
    assert.ok(maxAbsDiff(ex.re, x) < 1e-5)
    const mid = 20000
    assert.ok(Math.abs(Math.hypot(ex.re[mid], ex.im[mid]) - 0.5) < 0.01)
    assert.equal(analytic(new Float32Array(0), { method: 'fft' }).re.length, 0)
  })

  test('freqShift moves a tone up and down with the other sideband suppressed', () => {
    const x = sine(SR, 1, 1000, 0.5).ch[0]
    for (const hz of [150, -150, 37.5, -400]) {
      const y = freqShift(x, SR, hz)
      assert.equal(y.length, x.length)
      const want = lockIn(y, SR, 1000 + hz, 4800, SR).amp
      const image = lockIn(y, SR, 1000 - hz, 4800, SR).amp
      assert.ok(Math.abs(want - 0.5) < 0.01, `hz=${hz} level ${want}`)
      assert.ok(20 * Math.log10(image / want) < -40, `hz=${hz} image ${image}`)
    }
  })

  test('moving shifts: arrays, functions, and the live shifter match', () => {
    const x = synthVoice(SR, 1).ch[0]
    const arr = new Float32Array(x.length)
    for (let i = 0; i < arr.length; i++) arr[i] = 200 * Math.sin((2 * Math.PI * 0.5 * i) / SR)
    const a = freqShift(x, SR, arr)
    const f = freqShift(x, SR, (t) => 200 * Math.sin(2 * Math.PI * 0.5 * t))
    assertSane({ sr: SR, ch: [a] })
    assertSane({ sr: SR, ch: [f] })
    // The live shifter at a fixed shift equals the offline one, block by block.
    const off = freqShift(x, SR, 55)
    const live = new FreqShifter(SR, 55)
    const out = new Float32Array(x.length)
    for (let i = 0; i < x.length; i += 128) {
      const n = Math.min(128, x.length - i)
      live.process(x.subarray(i, i + n), out.subarray(i, i + n), n)
    }
    assert.ok(maxAbsDiff(out, off) < 1e-5)
    // Zero shift keeps level; NaN input is safe.
    const z = freqShift(x, SR, 0)
    assert.ok(Math.abs(rmsDb(z) - rmsDb(x)) < 0.5)
    const bad = new Float32Array(1000)
    bad[10] = NaN
    assert.ok(allFinite(freqShift(bad, SR, 30)))
    assert.ok(allFinite(freqShift(x, SR, NaN)))
    const h = new HilbertPair()
    h.tick(NaN)
    assert.ok(Number.isFinite(h.re) && Number.isFinite(h.im))
  })

  test('speed: frequency shifting is light', () => {
    const x = randomSig(SR)
    const ms = timeIt(() => freqShift(x, SR, 80), 3)
    assert.ok(ms < 40, `took ${ms.toFixed(1)} ms per second of audio`)
  })
})

// ---------------------------------------------------------------- space3d.js

describe('space3d: placing a voice around the head', () => {
  const noise = randomSig(SR, 31)

  test('a source at +90 degrees is louder and earlier in the right ear', () => {
    const { L, R } = place(noise, SR, { az: 90, el: 0, dist: 1 })
    assert.ok(rmsDb(R) - rmsDb(L) > 4, `ILD ${rmsDb(R) - rmsDb(L)}`)
    const lag = xcorrLag(R, L, 60)
    assert.ok(lag >= 24 && lag <= 36, `left lags right by ${lag} samples`)
    const m = place(noise, SR, { az: -90, el: 0, dist: 1 })
    assert.ok(rmsDb(m.L) - rmsDb(m.R) > 4)
    assert.ok(xcorrLag(m.L, m.R, 60) >= 24)
  })

  test('straight ahead the two ears match', () => {
    const { L, R } = place(noise, SR, { az: 0, el: 0, dist: 2 })
    assert.ok(maxAbsDiff(L, R) < 1e-6)
    const b = place(noise, SR, { az: 180, el: 20, dist: 2 })
    assert.ok(maxAbsDiff(b.L, b.R) < 1e-6)
  })

  test('circling alternates which ear is louder, smoothly', () => {
    const x = randomSig(4 * SR, 32)
    const { L, R } = place(x, SR, circlePath({ period: 2, dist: 1.2 }))
    const w = Math.round(0.1 * SR)
    const ild = []
    const want = []
    for (let s = 0; s + w <= x.length; s += w) {
      ild.push(rmsDb(R.subarray(s, s + w)) - rmsDb(L.subarray(s, s + w)))
      want.push(Math.sin((2 * Math.PI * (s + w / 2)) / SR / 2))
    }
    // Correlate measured level difference with sin(azimuth).
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0
    for (let i = 0; i < ild.length; i++) {
      sa += ild[i]; sb += want[i]; sab += ild[i] * want[i]; saa += ild[i] * ild[i]; sbb += want[i] * want[i]
    }
    const n = ild.length
    const corr = (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb))
    assert.ok(corr > 0.9, `correlation ${corr}`)
    let flips = 0
    for (let i = 1; i < ild.length; i++) if (Math.sign(ild[i]) !== Math.sign(ild[i - 1])) flips++
    assert.ok(flips >= 3 && flips <= 6, `dominance flips ${flips}`)
    // No zipper noise: a low tone circling fast stays clean above 6 kHz.
    const tone = sine(SR, 2, 300, 0.5).ch[0]
    const fast = place(tone, SR, circlePath({ period: 0.5, dist: 1 }))
    const hi = bandEnergyDb(fast.L, SR, 6000, 23000)
    const all = bandEnergyDb(fast.L, SR, 20, 23000)
    assert.ok(hi - all < -60, `high residue ${hi - all} dB`)
  })

  test('doppler: approaching is higher, receding is lower', () => {
    const tone = sine(SR, 4, 500, 0.5).ch[0]
    const v = 20
    const app = place(tone, SR, (t) => ({ az: 0, dist: 80 - v * t })).L
    const rec = place(tone, SR, (t) => ({ az: 0, dist: 5 + v * t })).L
    const fa = medianF0(app.subarray(SR, 3 * SR), SR)
    const fr = medianF0(rec.subarray(SR, 3 * SR), SR)
    assert.ok(Math.abs(fa - 500 * (1 + v / 343)) < 2, `approach ${fa}`)
    assert.ok(Math.abs(fr - 500 * (1 - v / 343)) < 2, `recede ${fr}`)
    const still = place(tone, SR, { az: 30, dist: 10 }).L
    assert.ok(Math.abs(medianF0(still.subarray(SR, 3 * SR), SR) - 500) < 1)
    // A fly-by passes: higher first, lower after.
    const fly = place(tone, SR, flyByPath({ speed: 25, offset: 2, passAt: 2 })).L
    assert.ok(medianF0(fly.subarray(Math.round(0.5 * SR), Math.round(1.5 * SR)), SR) > 510)
    assert.ok(medianF0(fly.subarray(Math.round(2.5 * SR), Math.round(3.5 * SR)), SR) < 490)
  })

  test('elevation moves the pinna notch; behind is duller; far is quieter and darker', () => {
    const x = randomSig(2 * SR, 33)
    const low = place(x, SR, { az: 0, el: -30, dist: 1 }).L
    const high = place(x, SR, { az: 0, el: 40, dist: 1 }).L
    assert.ok(bandEnergyDb(low, SR, 5000, 6500) < bandEnergyDb(high, SR, 5000, 6500) - 3)
    assert.ok(bandEnergyDb(high, SR, 10000, 12500) < bandEnergyDb(low, SR, 10000, 12500) - 3)
    const front = place(x, SR, { az: 0, el: 0, dist: 1 }).L
    const back = place(x, SR, { az: 180, el: 0, dist: 1 }).L
    assert.ok(spectralCentroid(back, SR) < spectralCentroid(front, SR) - 500)
    const near = place(x, SR, { az: 0, dist: 1 }).L
    const far = place(x, SR, { az: 0, dist: 4 }).L
    const dd = rmsDb(near) - rmsDb(far)
    assert.ok(dd > 10 && dd < 14, `4 m is ${dd} dB down`)
    const veryFar = place(x, SR, { az: 0, dist: 100 }).L
    assert.ok(spectralCentroid(veryFar, SR) < spectralCentroid(far, SR) - 1500)
    // Close on one side gives a bigger level difference than far on that side.
    const c = place(x, SR, { az: 90, dist: 0.2 })
    const f = place(x, SR, { az: 90, dist: 3 })
    assert.ok(rmsDb(c.R) - rmsDb(c.L) > rmsDb(f.R) - rmsDb(f.L) + 1)
  })

  test('odd inputs and paths are safe; other rates work; it is fast', () => {
    let o = place(new Float32Array(0), SR, { az: 10 })
    assert.equal(o.L.length, 0)
    o = place(new Float32Array(1000), SR, () => ({ az: NaN, el: 999, dist: -5 }))
    assert.ok(allFinite(o.L) && allFinite(o.R))
    const click = impulse(SR, 0.5, 0.1).ch[0]
    o = place(click, SR, (t) => ({ az: t * 5000, el: Math.sin(t * 90) * 90, dist: t < 0.2 ? 0 : 900 }))
    assertSane({ sr: SR, ch: [o.L, o.R] })
    o = place(click, SR, null)
    assert.ok(allFinite(o.L))
    const bad = randomSig(4800)
    bad[100] = NaN
    o = place(bad, SR, { az: 45 })
    assert.ok(allFinite(o.L) && allFinite(o.R))
    for (const sr of [8000, 16000, 44100, 96000]) {
      const v = synthVoice(sr, 1).ch[0]
      const p = place(v, sr, circlePath({ period: 1 }))
      assertSane({ sr, ch: [p.L, p.R] })
    }
    // Tail option leaves room for the longest delay.
    o = place(click, SR, { az: 0, dist: 50 }, { tail: true })
    assert.ok(o.L.length >= click.length)
    // A cartesian path straight overhead.
    const up = cartesianPath(() => ({ x: 0, y: 0, z: 2 }))(0)
    assert.ok(Math.abs(up.el - 90) < 1e-9 && Math.abs(up.dist - 2) < 1e-9)
    const v = synthVoice(SR, 3).ch[0]
    const ms = timeIt(() => place(v, SR, circlePath({ period: 3 })), 2)
    assert.ok(ms / 3 < 30, `${(ms / 3).toFixed(1)} ms per second of audio`)
  })
})

// Engine fix, Oct 22 2026: the natural rear model (opts.rear = 'natural').
describe('space3d: behind sounds behind (rear model)', () => {
  // energy in a band summed over both ears, dB
  const bothDb = (o, sr, lo, hi) => 10 * Math.log10(Math.pow(10, bandEnergyDb(o.L, sr, lo, hi) / 10) + Math.pow(10, bandEnergyDb(o.R, sr, lo, hi) / 10))
  const pinkish = (sr, seconds, seed) => {
    // white noise through a gentle lowpass: speech-like tilt, energy everywhere
    const x = randomSig(Math.round(sr * seconds), seed)
    let s = 0
    const a = Math.exp((-2 * Math.PI * 1500) / sr)
    for (let i = 0; i < x.length; i++) {
      s = a * s + (1 - a) * x[i]
      x[i] = 0.6 * s + 0.15 * x[i]
    }
    return x
  }

  test('a rear source has at least 3 dB less energy above 2 kHz than the same source in front', () => {
    for (const sr of [48000, 22050]) {
      const x = pinkish(sr, 2, 41)
      const hi = Math.min(20000, 0.45 * sr)
      const front = place(x, sr, { az: 0, el: 0, dist: 1 }, { rear: 'natural' })
      const back = place(x, sr, { az: 180, el: 0, dist: 1 }, { rear: 'natural' })
      const d = bothDb(back, sr, 2000, hi) - bothDb(front, sr, 2000, hi)
      assert.ok(d <= -3, `${sr} Hz: behind is only ${(-d).toFixed(1)} dB duller above 2 kHz`)
      // the 6 to 10 kHz rear dip is deeper still
      const dip = bothDb(back, sr, 6000, Math.min(10000, hi)) - bothDb(front, sr, 6000, Math.min(10000, hi))
      assert.ok(dip < d - 2, `${sr} Hz: 6-10 kHz only ${(-dip).toFixed(1)} dB down`)
      // and the lows are left alone
      const lo = bothDb(back, sr, 100, 1000) - bothDb(front, sr, 100, 1000)
      assert.ok(Math.abs(lo) < 1.5, `${sr} Hz: the lows moved ${lo.toFixed(1)} dB`)
      // diagonal behind (150 degrees) is duller than front too, both sides alike
      const b150 = place(x, sr, { az: 150, el: 0, dist: 1 }, { rear: 'natural' })
      const bm150 = place(x, sr, { az: -150, el: 0, dist: 1 }, { rear: 'natural' })
      assert.ok(bothDb(b150, sr, 2000, hi) < bothDb(front, sr, 2000, hi), '150 degrees is not duller than front')
      assert.ok(Math.abs(bothDb(b150, sr, 2000, hi) - bothDb(bm150, sr, 2000, hi)) < 0.1)
      // the classic model is the one the rear model fixes: behind came out about as bright as ahead
      const cb = place(x, sr, { az: 180, el: 0, dist: 1 })
      const cf = place(x, sr, { az: 0, el: 0, dist: 1 })
      assert.ok(bothDb(cb, sr, 2000, hi) - bothDb(cf, sr, 2000, hi) > d + 2.5)
    }
  })

  test('the rear loss grows smoothly from 90 degrees to 180', () => {
    const x = pinkish(SR, 1, 42)
    const front = bothDb(place(x, SR, { az: 0, dist: 1 }, { rear: 'natural' }), SR, 2000, 20000)
    let prev = Infinity
    const steps = []
    for (const az of [90, 105, 120, 135, 150, 165, 180]) {
      const v = bothDb(place(x, SR, { az, dist: 1 }, { rear: 'natural' }), SR, 2000, 20000) - front
      steps.push(v)
      assert.ok(v < prev + 0.05, `not falling at ${az} degrees: ${steps.map((s) => s.toFixed(1)).join(' ')}`)
      prev = v
    }
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i - 1] - steps[i] < 4, 'a jump of ' + (steps[i - 1] - steps[i]).toFixed(1) + ' dB')
  })

  test('front and side sources are exactly as before, and the default is unchanged', () => {
    const x = pinkish(SR, 0.5, 43)
    for (const az of [0, 20, 45, 70, 90, -30, -90]) {
      for (const el of [0, 25, -20]) {
        const a = place(x, SR, { az, el, dist: 1.5 })
        const b = place(x, SR, { az, el, dist: 1.5 }, { rear: 'natural' })
        assert.equal(maxAbsDiff(a.L, b.L), 0, `az ${az} el ${el} left`)
        assert.equal(maxAbsDiff(a.R, b.R), 0, `az ${az} el ${el} right`)
      }
    }
    // without the option (and with rear: 'classic') nothing changes behind either
    const c0 = place(x, SR, { az: 160, el: 0, dist: 1 })
    const c1 = place(x, SR, { az: 160, el: 0, dist: 1 }, { rear: 'classic' })
    assert.equal(maxAbsDiff(c0.L, c1.L), 0)
  })

  test('a source circling through the back moves smoothly, with no clicks or zipper noise', () => {
    const tone = sine(SR, 2, 300, 0.5).ch[0]
    const fast = place(tone, SR, circlePath({ period: 0.5, dist: 1 }), { rear: 'natural' })
    const hi = bandEnergyDb(fast.L, SR, 6000, 23000)
    const all = bandEnergyDb(fast.L, SR, 20, 23000)
    assert.ok(hi - all < -60, `high residue ${(hi - all).toFixed(1)} dB`)
    // the level in 10 ms windows never jumps while noise goes slowly round
    const x = pinkish(SR, 4, 44)
    const o = place(x, SR, circlePath({ period: 4, dist: 1.2 }), { rear: 'natural' })
    const w = Math.round(0.01 * SR)
    let prevL = null
    let worst = 0
    for (let s = SR / 10; s + w <= x.length; s += w) {
      const l = rmsDb(o.L.subarray(s, s + w))
      if (prevL !== null) worst = Math.max(worst, Math.abs(l - prevL))
      prevL = l
    }
    const ref = place(x, SR, circlePath({ period: 4, dist: 1.2 }))
    let prevR = null
    let worstRef = 0
    for (let s = SR / 10; s + w <= x.length; s += w) {
      const l = rmsDb(ref.L.subarray(s, s + w))
      if (prevR !== null) worstRef = Math.max(worstRef, Math.abs(l - prevR))
      prevR = l
    }
    assert.ok(worst < worstRef + 0.5, `10 ms level steps up to ${worst.toFixed(2)} dB (classic ${worstRef.toFixed(2)})`)
    assertSane({ sr: SR, ch: [o.L, o.R] })
  })

  test('the rear model is safe at every rate and as fast as the classic one', () => {
    for (const sr of [8000, 16000, 44100, 96000]) {
      const v = synthVoice(sr, 1).ch[0]
      const p = place(v, sr, circlePath({ period: 1 }), { rear: 'natural' })
      assertSane({ sr, ch: [p.L, p.R] })
    }
    const v = synthVoice(SR, 3).ch[0]
    const ms = timeIt(() => place(v, SR, circlePath({ period: 3 }), { rear: 'natural' }), 2)
    assert.ok(ms / 3 < 30, `${(ms / 3).toFixed(1)} ms per second of audio`)
  })
})

// ---------------------------------------------------------------- ir.js

const CONTRACT_SPACES = (() => {
  const text = readFileSync(fileURLToPath(new URL('../../CONTRACT.md', import.meta.url)), 'utf8')
  const sec = text.split('## 8.')[1].split('## 9.')[0]
  const body = sec.split('\n').slice(1).join(' ')
  return body
    .split(',')
    .map((s) => s.replace(/\.\s*$/, '').trim())
    .filter((s) => /^[a-z-]+$/.test(s))
})()

const IRS = new Map()
function ir48(name) {
  if (!IRS.has(name)) IRS.set(name, namedIR(name, SR, makeRng(1)))
  return IRS.get(name)
}

describe('ir: synthetic spaces', () => {
  test('every space in the contract is named, in order, with a plain description', () => {
    assert.ok(CONTRACT_SPACES.length >= 50)
    assert.deepEqual(SPACE_NAMES, CONTRACT_SPACES)
    for (const n of SPACE_NAMES) {
      const a = SPACES[n].about
      assert.ok(typeof a === 'string' && a.length > 10 && a.length < 120, n)
    }
    // No two spaces share a spec.
    const seen = new Set()
    for (const n of SPACE_NAMES) {
      const k = JSON.stringify(SPACES[n].spec)
      assert.ok(!seen.has(k), n + ' duplicates another spec')
      seen.add(k)
    }
    assert.throws(() => namedIR('moon-base', SR), /no space called/)
    assert.throws(() => spaceSpec('nowhere'), RangeError)
  })

  test('every named response is stereo, finite, level-matched and deterministic', () => {
    let totalMs = 0
    for (const n of SPACE_NAMES) {
      clearIRCache()
      let ir
      totalMs += timeIt(() => {
        ir = namedIR(n, SR, makeRng(1))
      }, 1)
      IRS.set(n, ir)
      assert.equal(ir.sr, SR)
      assert.equal(ir.ch.length, 2, n)
      assert.equal(ir.ch[0].length, ir.ch[1].length)
      const sec = ir.ch[0].length / SR
      assert.ok(sec >= 0.05 && sec <= 12.5, `${n} is ${sec} s`)
      assert.ok(allFinite(ir.ch[0]) && allFinite(ir.ch[1]), n)
      // Level is matched for speech, so plain energy sits within a sensible range.
      const e = energyOf(ir.ch) / 2
      assert.ok(e > 0.02 && e < 2, `${n} energy ${e}`)
      assert.ok(peakAbs(ir.ch[0]) < 2 && peakAbs(ir.ch[1]) < 2, n)
      // The end is faded to silence.
      assert.ok(Math.abs(ir.ch[0][ir.ch[0].length - 1]) < 1e-3, n)
    }
    // Same seed, same response (fresh builds, not the cache).
    for (const n of ['closet', 'cave', 'forest', 'spring', 'plate', 'tin-can', 'canyon', 'well']) {
      const again = roomIR(SR, SPACES[n].spec, makeRng(1).fork('space:' + n))
      assert.ok(maxAbsDiff(again.ch[0], IRS.get(n).ch[0]) === 0, n + ' not deterministic')
    }
    assert.ok(totalMs < 8000, `building all spaces took ${totalMs.toFixed(0)} ms`)
    // A different seed gives a different (but same-length) response.
    const a = ir48('church')
    const b = namedIR('church', SR, makeRng(2))
    assert.equal(a.ch[0].length, b.ch[0].length)
    assert.ok(maxAbsDiff(a.ch[0], b.ch[0]) > 1e-4)
    // The cache hands out copies.
    const c1 = namedIR('church', SR, makeRng(1))
    c1.ch[0].fill(0)
    const c2 = namedIR('church', SR, makeRng(1))
    assert.ok(peakAbs(c2.ch[0]) > 0)
  })

  test('other sample rates build safely', () => {
    for (const sr of [8000, 16000]) {
      for (const n of SPACE_NAMES) {
        const ir = namedIR(n, sr, makeRng(1))
        assert.ok(allFinite(ir.ch[0]) && allFinite(ir.ch[1]), `${n} at ${sr}`)
        const e = energyOf(ir.ch) / 2
        assert.ok(e > 0.01 && e < 4, `${n} at ${sr} energy ${e}`)
      }
    }
    for (const sr of [44100, 96000]) {
      for (const n of ['cathedral', 'tin-can', 'spring', 'plate', 'canyon', 'well', 'bottle', 'hallway']) {
        const ir = namedIR(n, sr, makeRng(1))
        assert.ok(allFinite(ir.ch[0]) && allFinite(ir.ch[1]), `${n} at ${sr}`)
      }
    }
    clearIRCache()
  })

  test('reverberant spaces decay at their stated rate', () => {
    const list = ['bathroom', 'kitchen', 'living-room', 'classroom', 'stairwell', 'gym', 'pool', 'church', 'cathedral',
      'concert-hall', 'theater', 'arena', 'parking-garage', 'tunnel', 'subway-station', 'cave', 'warehouse', 'factory',
      'hangar', 'small-hall', 'large-hall', 'plate', 'spring', 'metal-tank']
    for (const n of list) {
      const rt = estimateRT60(monoOf(ir48(n)), SR)
      const want = SPACES[n].spec.decay
      assert.ok(rt > want * 0.6 && rt < want * 1.3, `${n}: measured ${rt.toFixed(2)} s for ${want} s`)
    }
    const inf = estimateRT60(monoOf(ir48('infinite')), SR)
    assert.ok(inf > 15, `infinite decays in ${inf} s`)
    assert.ok(ir48('infinite').ch[0].length >= 12 * SR)
    // Size order: the cathedral outlasts the church, which outlasts the bedroom.
    const rt = (n) => estimateRT60(monoOf(ir48(n)), SR)
    assert.ok(rt('cathedral') > rt('church') && rt('church') > rt('bedroom'))
    assert.equal(estimateRT60(new Float32Array(100), SR), 0)
  })

  test('no two spaces sound alike by their decay and colour', () => {
    const feats = {}
    for (const n of SPACE_NAMES) {
      const m = monoOf(ir48(n))
      const edc = new Float64Array(m.length)
      let acc = 0
      for (let i = m.length - 1; i >= 0; i--) {
        acc += m[i] * m[i]
        edc[i] = acc
      }
      const f = []
      for (const ms of [5, 15, 40, 80, 160, 320, 640, 1280, 2560]) {
        const i = Math.round((ms / 1000) * SR)
        f.push(i < m.length ? Math.max(-80, 10 * Math.log10(edc[i] / edc[0] + 1e-12)) : -80)
      }
      const x = new Float32Array(Math.max(m.length, 8192))
      x.set(m)
      const bands = [[100, 200], [200, 400], [400, 800], [800, 1600], [1600, 3200], [3200, 6400], [6400, 12800]]
      const db = bands.map(([a, b]) => bandEnergyDb(x, SR, a, b))
      for (const d of db) f.push(d - db[3])
      feats[n] = f
    }
    let min = Infinity
    let pair = ''
    for (let i = 0; i < SPACE_NAMES.length; i++) {
      for (let j = i + 1; j < SPACE_NAMES.length; j++) {
        const a = feats[SPACE_NAMES[i]]
        const b = feats[SPACE_NAMES[j]]
        let d = 0
        for (let k = 0; k < a.length; k++) d += (a[k] - b[k]) ** 2
        d = Math.sqrt(d / a.length)
        if (d < min) {
          min = d
          pair = SPACE_NAMES[i] + ' and ' + SPACE_NAMES[j]
        }
      }
    }
    assert.ok(min > 1.0, `${pair} are only ${min.toFixed(2)} dB apart`)
  })

  test('canyon: separate echoes, each fainter and darker', () => {
    const m = monoOf(ir48('canyon'))
    const times = [0.31, 0.56, 0.94, 1.42]
    let prevE = Infinity
    let prevC = Infinity
    for (const t of times) {
      const e = energyBetween(m, SR, t - 0.004, t + 0.03)
      const before = energyBetween(m, SR, t - 0.06, t - 0.025) / (0.035 / 0.034)
      assert.ok(10 * Math.log10(e / (before + 1e-20)) > 8, `echo at ${t} s stands out`)
      assert.ok(e < prevE, `echo at ${t} s is fainter`)
      prevE = e
      const seg = m.subarray(Math.round((t - 0.01) * SR), Math.round((t + 0.03) * SR))
      const padded = new Float32Array(8192)
      padded.set(seg)
      const c = spectralCentroid(padded, SR)
      assert.ok(c < prevC, `echo at ${t} s is darker`)
      prevC = c
    }
  })

  test('spring: each echo is a chirp, highs arriving after lows (the drip)', () => {
    const sp = ir48('spring')
    const m = monoOf(sp)
    // Energy-weighted arrival time of two bands over the first trip round the springs.
    function arrival(lo, hi) {
      const seg = new Float32Array(m.subarray(0, Math.round(0.06 * SR)))
      const re = new Float64Array(8192)
      const im = new Float64Array(8192)
      // Band-limit through the spectrum, then measure the envelope centroid.
      re.set(seg.subarray(0, 8192))
      cfft(re, im)
      for (let k = 0; k < 8192; k++) {
        const f = (Math.min(k, 8192 - k) * SR) / 8192
        if (f < lo || f > hi) { re[k] = 0; im[k] = 0 }
      }
      cfft(re, im, true)
      let w = 0, tw = 0
      for (let i = 0; i < seg.length; i++) {
        const p = re[i] * re[i] + im[i] * im[i]
        w += p
        tw += p * i
      }
      return tw / w / SR
    }
    const low = arrival(200, 500)
    const high = arrival(2000, 3500)
    assert.ok(high > low + 0.003, `low ${low * 1000} ms, high ${high * 1000} ms`)
    // It keeps bouncing: energy still present after half a second.
    assert.ok(energyBetween(m, SR, 0.5, 0.7) / energyBetween(m, SR, 0, 30) > 1e-3)
  })

  test('plate: dense and immediate; forest and field: almost no tail', () => {
    const p = monoOf(ir48('plate'))
    const pk = peakAbs(p)
    let busy = 0
    const a = Math.round(0.004 * SR)
    const b = Math.round(0.014 * SR)
    for (let i = a; i < b; i++) if (Math.abs(p[i]) > 1e-3 * pk) busy++
    assert.ok(busy / (b - a) > 0.8, `plate onset density ${busy / (b - a)}`)
    assert.ok(energyBetween(p, SR, 0, 0.01) > 0)
    assert.ok(spectralCentroid(p, SR) > spectralCentroid(monoOf(ir48('cathedral')), SR))
    const forest = monoOf(ir48('forest'))
    const field = monoOf(ir48('field'))
    const late = (m) => energyBetween(m, SR, 0.3, 30) / energyBetween(m, SR, 0, 30)
    assert.ok(late(forest) < 0.05, `forest late ${late(forest)}`)
    assert.ok(late(field) < 0.01, `field late ${late(field)}`)
    // The forest has far more scatter in its first 200 ms than the field.
    const scatter = (m) => energyBetween(m, SR, 0.01, 0.2) / energyBetween(m, SR, 0, 30)
    assert.ok(scatter(forest) > 3 * scatter(field))
  })

  test('small hard spaces ring with strong resonances; muffled spaces lose their highs', () => {
    function peakiness(m) {
      const N = 65536
      const re = new Float64Array(N)
      const im = new Float64Array(N)
      re.set(m.subarray(0, Math.min(m.length, N)))
      cfft(re, im)
      const vals = []
      for (let f = 100; f < 8000; f *= Math.pow(2, 1 / 12)) {
        const k0 = Math.floor(((f * Math.pow(2, -1 / 24)) / SR) * N)
        const k1 = Math.ceil(((f * Math.pow(2, 1 / 24)) / SR) * N)
        let a = 0
        for (let k = k0; k <= k1; k++) a += re[k] * re[k] + im[k] * im[k]
        vals.push(10 * Math.log10(a / (k1 - k0 + 1) + 1e-30))
      }
      vals.sort((x, y) => x - y)
      return vals[vals.length - 1] - vals[vals.length >> 1]
    }
    const smooth = Math.max(...['concert-hall', 'church', 'plate', 'large-hall', 'stadium'].map((n) => peakiness(monoOf(ir48(n)))))
    for (const n of ['tin-can', 'glass-jar', 'bottle', 'oil-drum', 'sewer-pipe', 'phone-booth', 'shower', 'closet', 'car', 'cardboard-box', 'space-suit', 'elevator']) {
      const pk = peakiness(monoOf(ir48(n)))
      assert.ok(pk > smooth + 2.5, `${n} peakiness ${pk.toFixed(1)} vs smooth rooms ${smooth.toFixed(1)}`)
    }
    // The tin can's flutter: its 0.7 ms comb puts peaks at multiples of
    // 1429 Hz, well above the valleys halfway between them.
    const can = monoOf(ir48('tin-can'))
    const N = 65536
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    re.set(can.subarray(0, Math.min(can.length, N)))
    cfft(re, im)
    const pw = (hz) => {
      const k0 = Math.round((hz * 0.985 * N) / SR)
      const k1 = Math.round((hz * 1.015 * N) / SR)
      let a = 0
      for (let k = k0; k <= k1; k++) a += re[k] * re[k] + im[k] * im[k]
      return a / (k1 - k0 + 1)
    }
    const f0 = 1 / 0.0007
    let peaks = 0, valleys = 0
    for (let k = 2; k <= 5; k++) {
      peaks += 10 * Math.log10(pw(k * f0))
      valleys += 10 * Math.log10(pw((k + 0.5) * f0))
    }
    assert.ok((peaks - valleys) / 4 > 6, `comb depth ${((peaks - valleys) / 4).toFixed(1)} dB`)
    for (const n of ['under-blanket', 'inside-a-wall']) {
      const m = monoOf(ir48(n))
      const x = new Float32Array(Math.max(m.length, 8192))
      x.set(m)
      assert.ok(bandEnergyDb(x, SR, 3000, 12000) < bandEnergyDb(x, SR, 200, 1000) - 25, n + ' is muffled')
    }
  })

  test('custom specs: explicit reflections, modes, cuts and shapes', () => {
    const ir = roomIR(SR, { shape: 'room', early: [[20, 0.5, -1], [45, 0.3, 1]], seconds: 0.2, decay: 0.1, tailGain: 0, direct: 1 })
    assert.equal(ir.ch[0].length, Math.round(0.2 * SR))
    // Explicit echoes land where asked, on the asked side.
    const L = ir.ch[0]
    const R = ir.ch[1]
    const at = (ch, ms) => energyBetween(ch, SR, ms / 1000 - 0.002, ms / 1000 + 0.002)
    assert.ok(at(L, 20) > 4 * at(R, 20))
    assert.ok(at(R, 45) > 4 * at(L, 45))
    const unknown = roomIR(SR, { shape: 'spaceship', decay: 0.5, size: 4 }, makeRng(5))
    assert.ok(allFinite(unknown.ch[0]))
    const outdoor = roomIR(SR, { shape: 'outdoor', echoes: [[100, 0.3, 0, 3000, 20]], scatter: { count: 10 }, tailDb: -30 }, makeRng(6))
    assert.ok(allFinite(outdoor.ch[1]))
    const sprung = roomIR(SR, { shape: 'spring', springs: [{ ms: 30, a: 0.6, sections: 20 }], decay: 1 }, makeRng(7))
    assert.ok(allFinite(sprung.ch[0]))
    const boxed = roomIR(8000, { shape: 'box', size: [0.2, 0.2, 0.2], decay: 0.2, modes: 'auto', combs: [[0.6, 0.8, 3000]] }, makeRng(8))
    assert.ok(allFinite(boxed.ch[0]))
    const odd = roomIR(SR, { decay: NaN, size: -3, damping: 9, density: -1, highCut: [500, 48], lowCut: 'x', eq: [{ type: 'peak', freq: 1e6 }] })
    assert.ok(allFinite(odd.ch[0]) && allFinite(odd.ch[1]))
  })

  test('a voice in every space is sane and keeps about its loudness', () => {
    const male = synthVoice(SR, 1.5, { sex: 'male', f0: 120 })
    const female = synthVoice(SR, 1.5, { sex: 'female', f0: 210, seed: 4 })
    for (const v of [male, female]) {
      for (const n of v === male ? SPACE_NAMES : SPACE_NAMES.filter((x, i) => i % 3 === 0)) {
        const out = convolveBuf(v, ir48(n), 100)
        assertSane(out)
        const d = rmsDb(out.ch[0].subarray(0, v.ch[0].length)) - rmsDb(v.ch[0])
        assert.ok(d > -12 && d < 8, `${n} changes level by ${d.toFixed(1)} dB`)
      }
    }
  })
})
