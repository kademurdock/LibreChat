// test/utilcore.nodetest.mjs - tests for env, dyn, automate, params, wav, loudness and segment.
// Run from api/server/kadeVoiceChanger:
//   node --test "engine/test/*.nodetest.mjs"   (Node 24)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { follow, rmsEnv, envCoef, envToDb } from '../core/env.js'
import { compress, compressBuf, limitBuf, gate, gateBuf, float32AtOrBelow } from '../core/dyn.js'
import { curve, at, isAutomated } from '../core/automate.js'
import {
  resolveParams, resolveValue, speakValue, speakRange, validateModuleShape, ParamError, findBlockedWord, defaultParams,
} from '../core/params.js'
import { encodeWav, decodeWav, wavInfo } from '../core/wav.js'
import {
  lufs, lufsDetail, normalizeLufs, truePeakDb, truePeakSig, interSamplePeaks, kWeightingCoefs,
} from '../core/loudness.js'
import { findPhrases, findSyllables } from '../core/segment.js'
import { makeRng } from '../core/rng.js'
import { pink } from '../core/noise.js'
import { synthVoice, sine, loadWav } from './fixtures.mjs'
import { assertSane, timeIt, rmsDb } from './measure.mjs'

const db = (g) => 20 * Math.log10(Math.max(1e-12, Math.abs(g)))
const peakOf = (s, a = 0, b = s.length) => {
  let m = 0
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(s[i]))
  return m
}
const rmsOf = (s, a = 0, b = s.length) => {
  let e = 0
  for (let i = a; i < b; i++) e += s[i] * s[i]
  return Math.sqrt(e / Math.max(1, b - a))
}
function noiseSig(n, seed, amp = 1) {
  const r = makeRng(seed)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = (r.next() * 2 - 1) * amp
  return s
}
function sineSig(sr, seconds, hz, amp, phase = 0) {
  const n = Math.round(sr * seconds)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + phase)
  return s
}

// ---------------------------------------------------------------- env
describe('env', () => {
  test('follow: attack and release reach 63 percent at their time constants', () => {
    const sr = 48000
    const s = new Float32Array(sr)
    s.fill(1, 0, sr / 2)
    const e = follow(s, sr, 10, 100)
    const a = Math.round(0.01 * sr) - 1
    assert.ok(Math.abs(e[a] - (1 - Math.exp(-1))) < 0.01, 'attack ' + e[a])
    const r = sr / 2 + Math.round(0.1 * sr) - 1
    assert.ok(Math.abs(e[r] - Math.exp(-1)) < 0.01, 'release ' + e[r])
    const inst = follow(s, sr, 0, 0)
    assert.equal(inst[0], 1)
    assert.equal(inst[sr / 2], 0)
    assert.equal(envCoef(0, sr), 0)
  })

  test('follow ignores NaN and Infinity, empty input is fine', () => {
    const s = new Float32Array([0.5, NaN, Infinity, -Infinity, 0.25])
    const e = follow(s, 48000, 0, 1)
    for (const v of e) assert.ok(Number.isFinite(v))
    assert.equal(follow(new Float32Array(0), 48000, 1, 1).length, 0)
  })

  test('rmsEnv is centred, exact against brute force, and survives its resync', () => {
    const sr = 48000
    const n = 100000
    const s = noiseSig(n, 3)
    for (let i = 40000; i < 60000; i++) s[i] *= 4
    const w = 20
    const e = rmsEnv(s, sr, w)
    const W = Math.round((w * sr) / 1000)
    const back = Math.floor((W - 1) / 2)
    for (const i of [0, 5, 479, 32767, 32768, 32769, 50000, 65536, 70001, n - 1]) {
      const lo = Math.max(0, i - back)
      const hi = Math.min(n - 1, i + (W - 1 - back))
      let acc = 0
      for (let k = lo; k <= hi; k++) acc += s[k] * s[k]
      const want = Math.sqrt(acc / (hi - lo + 1))
      assert.ok(Math.abs(e[i] - want) < 1e-5 * Math.max(1, want), 'index ' + i)
    }
    // a sine reads amplitude / sqrt 2
    const sn = sineSig(sr, 0.5, 440, 0.8)
    const es = rmsEnv(sn, sr, 50)
    assert.ok(Math.abs(es[12000] - 0.8 / Math.SQRT2) < 0.005)
    // centred: a burst's envelope is symmetric around the burst
    const b = new Float32Array(4800)
    b.fill(1, 2000, 2800)
    const eb = rmsEnv(b, sr, 10)
    // window of 480: 239 samples behind the centre, 240 ahead
    assert.ok(Math.abs(eb[1900] - eb[2898]) < 1e-6)
    assert.ok(eb[1900] > 0)
    const d = envToDb(new Float32Array([1, 0.1, 0]))
    assert.deepEqual(Array.from(d).map((v) => Math.round(v)), [0, -20, -200])
  })
})

// ---------------------------------------------------------------- compressor
describe('compress', () => {
  test('steady level lands on threshold + over / ratio', () => {
    const sr = 48000
    const s = sineSig(sr, 1, 1000, 0.5) // -6 dBFS peak
    compress(s, sr, { thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 50 })
    const pk = db(peakOf(s, sr / 2, sr))
    assert.ok(Math.abs(pk - (-20 + 14 / 4)) < 1, 'peak ' + pk)
    const lim = sineSig(sr, 1, 1000, 0.5)
    compress(lim, sr, { thresholdDb: -20, ratio: Infinity, kneeDb: 0, attackMs: 1, releaseMs: 50 })
    assert.ok(Math.abs(db(peakOf(lim, sr / 2, sr)) + 20) < 1)
  })

  test('below threshold nothing changes; makeup is exact', () => {
    const sr = 48000
    const s = sineSig(sr, 0.2, 300, 0.02) // -34 dBFS
    const ref = new Float32Array(s)
    compress(s, sr, { thresholdDb: -20, ratio: 4 })
    assert.deepEqual(s, ref)
    compress(s, sr, { thresholdDb: -20, ratio: 4, makeupDb: 6.0206 })
    for (let i = 0; i < s.length; i += 97) assert.ok(Math.abs(s[i] - 2 * ref[i]) < 1e-5)
  })

  test('soft knee formula at the threshold, attack and release timing', () => {
    const sr = 48000
    const T = -20
    const dc = new Float32Array(sr / 2).fill(Math.pow(10, T / 20))
    const gr = new Float32Array(dc.length)
    compress(dc, sr, { thresholdDb: T, ratio: 4, kneeDb: 6, attackMs: 1, releaseMs: 10, grOut: gr })
    const want = (1 / 4 - 1) * (3 * 3) / (2 * 6) // -0.5625 dB
    assert.ok(Math.abs(gr[gr.length - 1] - want) < 1e-3, 'knee ' + gr[gr.length - 1])
    // attack: DC step to 0.5 against threshold -20, ratio infinite, knee 0
    const n = sr
    const st = new Float32Array(n)
    st.fill(0.5, 0, n / 2)
    const g2 = new Float32Array(n)
    compress(st, sr, { thresholdDb: -20, ratio: Infinity, kneeDb: 0, attackMs: 10, releaseMs: 100, grOut: g2 })
    const full = 20 * Math.log10(0.5) + 20
    const atA = -g2[Math.round(0.01 * sr) - 1]
    assert.ok(Math.abs(atA - full * (1 - Math.exp(-1))) < 0.2, 'attack ' + atA)
    const atR = -g2[n / 2 + Math.round(0.1 * sr) - 1]
    assert.ok(Math.abs(atR - full * Math.exp(-1)) < 0.2, 'release ' + atR)
  })

  test('linked stereo keeps the image, NaN is cleaned, empty is fine', () => {
    const sr = 48000
    const L = sineSig(sr, 0.5, 200, 0.9)
    const R = sineSig(sr, 0.5, 200, 0.1)
    const L0 = new Float32Array(L)
    const R0 = new Float32Array(R)
    compressBuf({ sr, ch: [L, R] }, { thresholdDb: -24, ratio: 6 })
    for (let i = 100; i < L.length; i += 211) {
      if (Math.abs(L0[i]) > 0.05) assert.ok(Math.abs(L[i] / L0[i] - R[i] / R0[i]) < 1e-4)
    }
    const bad = new Float32Array([NaN, 0.5, Infinity, -0.7])
    compress(bad, sr, { thresholdDb: -10, ratio: 3 })
    for (const v of bad) assert.ok(Number.isFinite(v))
    assert.equal(compress(new Float32Array(0), sr, {}).length, 0)
  })
})

// ---------------------------------------------------------------- limiter
describe('limitBuf', () => {
  test('no sample above the ceiling, sample mode and true-peak mode, channel-linked', () => {
    const sr = 48000
    for (const truePeak of [false, true]) {
      for (const ceilingDb of [-1, -0.1, -6]) {
        const n = sr
        const L = noiseSig(n, 11, 1)
        const R = noiseSig(n, 12, 0.5)
        // loud bursts up to +12 dB
        for (let k = 0; k < 20; k++) {
          const at0 = 1000 + k * 2300
          for (let i = 0; i < 300; i++) {
            L[at0 + i] *= 4
            R[at0 + i] *= 3
          }
        }
        L[0] = 3.9 // a peak on the very first sample
        const L0 = new Float32Array(L)
        const R0 = new Float32Array(R)
        limitBuf({ sr, ch: [L, R] }, { ceilingDb, truePeak })
        const c = Math.pow(10, ceilingDb / 20)
        assert.ok(peakOf(L) <= c && peakOf(R) <= c, 'ceiling ' + ceilingDb + ' tp ' + truePeak)
        for (let i = 0; i < n; i += 37) {
          if (Math.abs(L0[i]) > 0.01 && Math.abs(R0[i]) > 0.01 && Math.abs(L[i]) < c * 0.999 && Math.abs(R[i]) < c * 0.999) {
            assert.ok(Math.abs(L[i] / L0[i] - R[i] / R0[i]) < 1e-4, 'linked at ' + i)
          }
        }
      }
    }
  })

  test('material under the ceiling passes untouched', () => {
    const sr = 48000
    const s = sineSig(sr, 0.5, 440, 0.5)
    const ref = new Float32Array(s)
    limitBuf({ sr, ch: [s] }, { ceilingDb: -1 })
    assert.deepEqual(s, ref)
  })

  test('gain ramps smoothly over the lookahead and recovers with the release', () => {
    const sr = 48000
    const n = 9600
    const s = new Float32Array(n).fill(0.5)
    const p = 4800
    for (let i = p; i < p + 10; i++) s[i] = 2
    limitBuf({ sr, ch: [s] }, { ceilingDb: -6.0206, lookaheadMs: 5, releaseMs: 20, truePeak: false })
    const g = Array.from(s, (v, i) => (i >= p && i < p + 10 ? v / 2 : v / 0.5))
    const L = 240
    assert.ok(Math.abs(g[p - L - 2] - 1) < 1e-6, 'starts falling no earlier than the lookahead')
    assert.ok(g[p] <= 0.25 + 1e-6)
    let maxStep = 0
    for (let i = 1; i < n; i++) if (!(i >= p && i <= p + 10)) maxStep = Math.max(maxStep, Math.abs(g[i] - g[i - 1]))
    assert.ok(maxStep < 3 / L, 'steps ' + maxStep)
    // falls monotonically, rises monotonically
    for (let i = p - L; i < p; i++) assert.ok(g[i] <= g[i - 1] + 1e-7)
    for (let i = p + 11; i < n; i++) assert.ok(g[i] >= g[i - 1] - 1e-7)
    assert.ok(g[n - 1] > 0.99, 'recovered')
  })

  test('true-peak mode catches inter-sample overs', () => {
    const sr = 48000
    // a quarter-rate sine at 45 degrees: samples at 0.71 of the true peak
    const s = sineSig(sr, 0.5, sr / 4, 1.2, Math.PI / 4)
    assert.ok(peakOf(s) < 0.86)
    assert.ok(truePeakDb(s) > 1.4)
    const a = new Float32Array(s)
    limitBuf({ sr, ch: [a] }, { ceilingDb: -1, truePeak: false })
    assert.ok(truePeakDb(a) > 1, 'sample mode leaves the over')
    const b2 = new Float32Array(s)
    limitBuf({ sr, ch: [b2] }, { ceilingDb: -1 })
    assert.ok(truePeakDb(b2) <= -0.9, 'true-peak mode fixes it: ' + truePeakDb(b2))
  })

  test('edge cases: empty, silence, NaN, mono click', () => {
    const sr = 48000
    limitBuf({ sr, ch: [new Float32Array(0)] })
    const z = new Float32Array(100)
    limitBuf({ sr, ch: [z] })
    assert.ok(z.every((v) => v === 0))
    const bad = new Float32Array([NaN, 5, -Infinity, 0.1])
    limitBuf({ sr, ch: [bad] })
    assertSane({ sr, ch: [bad] }, { maxPeak: 0.9 })
    assert.ok(float32AtOrBelow(0.1) <= 0.1)
    assert.ok(Math.fround(float32AtOrBelow(0.1)) === float32AtOrBelow(0.1))
  })

  test('speed: 30 s of stereo', () => {
    const sr = 48000
    const L = noiseSig(sr * 30, 5, 1.5)
    const R = noiseSig(sr * 30, 6, 1.5)
    const ms = timeIt(() => limitBuf({ sr, ch: [L, R] }, { ceilingDb: -1 }))
    assert.ok(ms < 2500, 'limiter ' + ms + ' ms')
  })
})

// ---------------------------------------------------------------- gate
describe('gate', () => {
  function bursts(sr) {
    // tone 0.3 s, quiet noise 0.3 s, repeated
    const n = sr * 2
    const s = noiseSig(n, 9, 0.001) // -60 dB noise
    for (let k = 0; k < 4; k++) {
      const a = Math.round(k * 0.6 * sr)
      for (let i = 0; i < 0.3 * sr; i++) s[a + i] += 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr)
    }
    return s
  }
  test('closes to the floor between words and leaves words alone', () => {
    const sr = 48000
    const s = bursts(sr)
    const ref = new Float32Array(s)
    gate(s, sr, { thresholdDb: -40, floorDb: -30, attackMs: 1, releaseMs: 20, holdMs: 20 })
    // middle of a tone
    const a = Math.round(0.1 * sr)
    assert.ok(Math.abs(rmsOf(s, a, a + 4800) / rmsOf(ref, a, a + 4800) - 1) < 1e-3)
    // late in a gap (tones at 0-0.3 s and 0.6-0.9 s): attenuated by the floor
    const g0 = Math.round(0.48 * sr)
    const ratio = db(rmsOf(s, g0, g0 + 4800) / rmsOf(ref, g0, g0 + 4800))
    assert.ok(Math.abs(ratio + 30) < 1, 'gap ' + ratio)
  })

  test('hold rides over short dips; hysteresis stops chatter', () => {
    const sr = 48000
    const n = sr
    const mk = () => {
      const s = sineSig(sr, 1, 300, 0.3)
      for (let i = 24000; i < 24000 + 0.08 * sr; i++) s[i] = 0 // 80 ms dip
      return s
    }
    const held = mk()
    gate(held, sr, { thresholdDb: -30, holdMs: 150, releaseMs: 5 })
    const after = 24000 + 0.08 * sr
    const ref = mk()
    assert.ok(Math.abs(rmsOf(held, after, after + 480) / rmsOf(ref, after, after + 480) - 1) < 0.01)
    const unheld = mk()
    gate(unheld, sr, { thresholdDb: -30, holdMs: 0, releaseMs: 5, attackMs: 5 })
    assert.ok(rmsOf(unheld, after, after + 480) < 0.9 * rmsOf(ref, after, after + 480))
    // a level wandering 2 dB either side of the threshold opens once and stays open
    const w = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const lvl = Math.pow(10, (-30 + 2 * Math.sin((2 * Math.PI * 3 * i) / sr)) / 20)
      w[i] = lvl * Math.sin((2 * Math.PI * 500 * i) / sr)
    }
    const wr = new Float32Array(w)
    gate(w, sr, { thresholdDb: -30, hysteresisDb: 6, holdMs: 0, releaseMs: 10 })
    const first = Math.round(0.1 * sr)
    assert.ok(Math.abs(rmsOf(w, first, n) / rmsOf(wr, first, n) - 1) < 1e-3)
  })

  test('linked stereo, empty and NaN', () => {
    const sr = 48000
    const L = bursts(sr)
    const R = new Float32Array(L.length)
    gateBuf({ sr, ch: [L, R] }, { thresholdDb: -40 })
    assert.ok(R.every((v) => v === 0))
    assert.equal(gate(new Float32Array(0), sr, {}).length, 0)
    const bad = new Float32Array([NaN, 1, Infinity])
    gate(bad, sr, {})
    for (const v of bad) assert.ok(Number.isFinite(v))
  })

  test('speed: compressor and gate, 1 s', () => {
    const sr = 48000
    const s = synthVoice(sr, 1).ch[0]
    const c = timeIt(() => compress(new Float32Array(s), sr, { thresholdDb: -30, ratio: 4 }), 3)
    const g = timeIt(() => gate(new Float32Array(s), sr, { thresholdDb: -40 }), 3)
    assert.ok(c < 30 && g < 30, 'compress ' + c + ' gate ' + g)
  })
})

// ---------------------------------------------------------------- automate
describe('automate', () => {
  const sr = 1000
  test('constants, sweeps and shapes', () => {
    assert.deepEqual(Array.from(curve(3, 4, sr)), [3, 3, 3, 3])
    assert.equal(curve(1, 0, sr).length, 0)
    const lin = curve({ from: 0, to: 10 }, 11, sr)
    assert.equal(lin[0], 0)
    assert.equal(lin[10], 10)
    assert.ok(Math.abs(lin[5] - 5) < 1e-6)
    const ex = curve({ from: 100, to: 400, shape: 'exp' }, 1001, sr)
    assert.ok(Math.abs(ex[500] - 200) < 0.5, 'geometric middle ' + ex[500])
    assert.ok(Math.abs(ex[1000] - 400) < 1e-3)
    const ez = curve({ from: 0, to: 1, shape: 'exp' }, 101, sr)
    for (let i = 1; i < ez.length; i++) assert.ok(ez[i] >= ez[i - 1])
    assert.ok(ez[50] < 0.2)
    const sn = curve({ from: 2, to: 4, shape: 'sine' }, 1001, sr)
    assert.ok(Math.abs(sn[500] - 3) < 1e-3)
    assert.ok(sn[100] < 2.1)
    const win = curve({ from: 0, to: 1, startSec: 0.2, endSec: 0.4 }, 600, sr)
    assert.equal(win[100], 0)
    assert.ok(Math.abs(win[300] - 0.5) < 1e-6)
    assert.equal(win[500], 1)
  })

  test('breakpoints: glide, hold, unsorted, step and per-point shapes', () => {
    const c = curve([[1, 10], [0, 0], [2, 10, 'step'], [3, 0, 'sine']], 4000, sr)
    assert.equal(c[0], 0)
    assert.ok(Math.abs(c[500] - 5) < 1e-6)
    assert.equal(c[1500], 10)
    assert.ok(Math.abs(c[2500] - 5) < 1e-3)
    assert.equal(c[3999], 0)
    const before = curve([[0.5, 7], [1, 9]], 300, sr)
    assert.equal(before[0], 7)
    const bad = curve([[0, NaN], ['x', 3], [1, 2]], 1000, sr)
    for (const v of bad) assert.ok(Number.isFinite(v))
  })

  test('functions, arrays, and at() agreeing with curve()', () => {
    const f = curve((t) => t * 2, 1000, sr)
    assert.ok(Math.abs(f[500] - 1) < 1e-6)
    const thrower = curve(() => { throw new Error('x') }, 10, sr)
    assert.ok(thrower.every((v) => v === 0))
    const arr = curve([0, 10], 11, sr)
    assert.ok(Math.abs(arr[5] - 5) < 1e-6)
    const specs = [5, { from: 1, to: 8, shape: 'exp' }, [[0, 1], [0.5, 3], [1, -2, 'sine']], (t) => Math.sin(t)]
    for (const s of specs) {
      const c = curve(s, 1000, sr)
      for (const i of [0, 123, 499, 777]) assert.ok(Math.abs(at(s, i / sr, 1) - c[i]) < 0.02, JSON.stringify(s) + ' ' + i)
    }
    assert.equal(isAutomated(3), false)
    assert.equal(isAutomated({ from: 1, to: 2 }), true)
  })
})

// ---------------------------------------------------------------- params
const GOOD = {
  id: 'pitch.voice',
  name: 'Pitch and timbre',
  family: 'pitch',
  about: 'Moves your voice up or down. Timbre makes the person sound bigger or smaller.',
  params: [
    { id: 'semitones', name: 'Pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones', rand: [-8, 8] },
    { id: 'amount', name: 'Amount', type: 'number', min: 0, max: 1, step: 0.1, def: 0.5, unit: 'x' },
    { id: 'mode', name: 'Method', type: 'choice', def: 'auto', options: [{ v: 'auto', name: 'Automatic' }, { v: 'smooth', name: 'Smooth' }] },
    { id: 'keepBreath', name: 'Keep breath', type: 'bool', def: true },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent' },
    { id: 'voices', name: 'Voices', type: 'number', min: 1, max: 8, def: 3, unit: 'count', noun: 'voice' },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process: (b) => b,
}

describe('params', () => {
  test('resolveParams fills, clamps, snaps and validates', () => {
    const d = defaultParams(GOOD)
    assert.deepEqual(d, { semitones: 0, amount: 0.5, mode: 'auto', keepBreath: true, mix: 100, voices: 3 })
    const problems = []
    const r = resolveParams(GOOD, { semitones: 30.2, amount: 0.33, mode: 'SMOOTH', keepBreath: 'off', mix: '40.4', voices: 2.6, extra: 1 }, { problems })
    assert.equal(r.semitones, 24)
    assert.equal(r.amount, 0.3)
    assert.equal(r.mode, 'smooth')
    assert.equal(r.keepBreath, false)
    assert.equal(r.mix, 40)
    assert.equal(r.voices, 3)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /no setting called "extra"/)
    assert.equal(resolveParams(GOOD, { semitones: -3.3 }).semitones, -3.5)
    const p2 = []
    const r2 = resolveParams(GOOD, { mode: 'robot', semitones: 'loud', keepBreath: 'maybe' }, { problems: p2 })
    assert.equal(r2.mode, 'auto')
    assert.equal(r2.semitones, 0)
    assert.equal(r2.keepBreath, true)
    assert.equal(p2.length, 3)
    assert.match(p2.join(' '), /The choices are: Automatic, Smooth/)
    assert.throws(() => resolveParams(GOOD, { mode: 'robot' }, { strict: true }), (e) => e instanceof ParamError && /robot/.test(e.message))
    assert.equal(resolveValue(GOOD.params[0], 1e9), 24)
    assert.equal(resolveParams(GOOD, { semitones: NaN }).semitones, 0)
  })

  test('speakValue says every unit in plain words', () => {
    const P = (unit, extra = {}) => ({ id: 'x', name: 'Thing', type: 'number', min: -1e6, max: 1e6, unit, ...extra })
    const cases = [
      [P('semitones'), 3, 'up 3 semitones'],
      [P('semitones'), -2, 'down 2 semitones'],
      [P('semitones'), 1, 'up 1 semitone'],
      [P('semitones'), 0, 'no change'],
      [P('semitones'), 1.5, 'up 1.5 semitones'],
      [P('cents'), -20, 'down 20 cents'],
      [P('percent'), 40, '40 percent'],
      [P('percent'), -40, 'minus 40 percent'],
      [P('percent', { words: { neg: 'left', pos: 'right', zero: 'center' } }), -40, '40 percent left'],
      [P('percent', { words: { neg: 'left', pos: 'right', zero: 'center' } }), 0, 'center'],
      [P('ms'), 250, '250 milliseconds'],
      [P('ms'), 1, '1 millisecond'],
      [P('ms'), 1200, '1.2 seconds'],
      [P('ms'), 1000, '1 second'],
      [P('seconds'), 1.2, '1.2 seconds'],
      [P('seconds'), 1, '1 second'],
      [P('seconds'), 0.25, '250 milliseconds'],
      [P('db'), -6, 'minus 6 decibels'],
      [P('db'), 3, 'plus 3 decibels'],
      [P('db'), 1, 'plus 1 decibel'],
      [P('db'), 0, '0 decibels'],
      [P('x'), 1.5, '1.5 times'],
      [P('x'), 1, 'no change'],
      [P('hz'), 440, '440 hertz'],
      [P('hz'), 2500, '2.5 kilohertz'],
      [P('hz'), 1000, '1 kilohertz'],
      [P('hz'), 0.5, '0.5 hertz'],
      [P('bits'), 8, '8 bits'],
      [P('bits'), 1, '1 bit'],
      [P('degrees', { id: 'angle', name: 'Direction' }), 90, '90 degrees right'],
      [P('degrees', { id: 'angle', name: 'Direction' }), -45, '45 degrees left'],
      [P('degrees', { id: 'angle', name: 'Direction' }), 0, 'straight ahead'],
      [P('degrees', { id: 'angle', name: 'Direction' }), 180, 'behind'],
      [P('degrees', { id: 'angle', name: 'Direction' }), 270, '90 degrees left'],
      [P('degrees', { id: 'height', name: 'Height' }), 30, '30 degrees up'],
      [P('degrees', { id: 'height', name: 'Height' }), -10, '10 degrees down'],
      [P('degrees', { id: 'phase', name: 'Phase' }), 90, '90 degrees'],
      [P('meters'), 3, '3 meters'],
      [P('meters'), 1, '1 meter'],
      [P('bpm'), 120, '120 beats per minute'],
      [P('count'), 3, '3'],
      [P('count', { noun: 'voice' }), 3, '3 voices'],
      [P('count', { noun: ['copy', 'copies'] }), 1, '1 copy'],
      [P('steps'), 16, '16 steps'],
      [P('steps'), 1, '1 step'],
      [P('semitones', { step: 0.5 }), 2.5, 'up 2.5 semitones'],
      [P('percent'), 33.333, '33.33 percent'],
    ]
    for (const [p, v, want] of cases) assert.equal(speakValue(p, v), want, p.unit + ' ' + v)
    assert.equal(speakValue(GOOD.params[3], true), 'on')
    assert.equal(speakValue(GOOD.params[3], false), 'off')
    assert.equal(speakValue(GOOD.params[2], 'smooth'), 'Smooth')
    assert.equal(speakValue(GOOD.params[0]), 'no change')
    assert.equal(speakValue(GOOD.params[0], -0), 'no change')
    assert.equal(speakRange(GOOD.params[0]), 'from down 24 semitones to up 24 semitones')
    assert.equal(speakRange(GOOD.params[2]), 'Automatic, Smooth')
  })

  test('validateModuleShape passes a good module and names every problem in a bad one', () => {
    assert.deepEqual(validateModuleShape(GOOD), [])
    const bad = {
      id: 'Pitch.Voice',
      family: 'echo',
      name: 'Robot like a Dalek',
      about: '',
      stereo: 'both',
      cost: 9,
      warps: 'no',
      params: [
        { id: 'a', name: 'A', type: 'number', min: 0, max: 10, def: 20, unit: 'furlongs' },
        { id: 'a', name: 'Again', type: 'number', min: 5, max: 1, def: 1, unit: 'db' },
        { id: 'c', name: '', type: 'choice', def: 'z', options: [{ v: 'x', name: 'X' }, { v: 'x', name: '' }] },
        { id: 'd', name: 'D', type: 'bool', def: 'yes' },
        { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 1, def: 1, unit: 'percent' },
        { id: 'e', name: 'E', type: 'slider' },
        { id: 'f', name: 'F', type: 'number', min: 0, max: 10, step: 2, def: 3, unit: 'db', rand: [5, 20] },
      ],
      tail: () => { throw new Error('boom') },
      live: { create: 1, latency: () => -1 },
    }
    const probs = validateModuleShape(bad)
    const all = probs.join('\n')
    for (const want of [
      /id must look like family\.name/, /spoken name is missing|Dalek/i, /looks like a brand/, /about sentence is missing/,
      /stereo must be keep, make or mono/, /process must be a function/, /cost must be a whole number/, /warps must be true or false/,
      /default of 20, outside 0 to 10/, /unit "furlongs"/, /repeats the id "a"/, /min 5 not below max 1/, /needs a spoken name/,
      /repeats the option value "x"/, /default "z" that is not one of its options/, /default must be true or false/,
      /is a mix and must be percent from 0 to 100/, /type "slider"/, /not on its step of 2/, /rand runs outside min and max/,
      /tail threw an error/, /live\.create must be a function/, /live\.latency must return samples/,
    ]) assert.match(all, want)
    assert.equal(validateModuleShape(null).length, 1)
    assert.equal(findBlockedWord('Rotating speaker'), null)
    assert.equal(findBlockedWord('Like a Leslie'), 'Leslie')
    assert.equal(findBlockedWord('auto-tune hard'), 'auto-tune')
    assert.equal(findBlockedWord('Pitch correction, hard'), null)
  })
})

// ---------------------------------------------------------------- wav
describe('wav', () => {
  test('16-bit round trip, deterministic dither, silent silence', () => {
    const sr = 44100
    const L = sineSig(sr, 0.3, 440, 0.7)
    const R = noiseSig(L.length, 4, 0.5)
    const b = { sr, ch: [L, R] }
    const w1 = encodeWav(b)
    const w2 = encodeWav(b)
    assert.deepEqual(w1, w2)
    const d = decodeWav(w1)
    assert.equal(d.sr, sr)
    assert.equal(d.ch.length, 2)
    assert.equal(d.ch[0].length, L.length)
    let maxErr = 0
    for (let i = 0; i < L.length; i++) maxErr = Math.max(maxErr, Math.abs(d.ch[0][i] - L[i]), Math.abs(d.ch[1][i] - R[i]))
    assert.ok(maxErr <= 1.5 / 32768, 'error ' + maxErr * 32768 + ' LSB')
    const z = decodeWav(encodeWav({ sr, ch: [new Float32Array(1000)] }))
    assert.ok(z.ch[0].every((v) => v === 0))
    assert.equal(wavInfo(w1).bits, 16)
    assert.equal(wavInfo(w1).channels, 2)
    // TPDF dither keeps a sub-LSB level on average
    const tiny = new Float32Array(200000).fill(0.3 / 32768)
    const dt = decodeWav(encodeWav({ sr, ch: [tiny] })).ch[0]
    let mean = 0
    for (const v of dt) mean += v
    mean = (mean / dt.length) * 32768
    assert.ok(Math.abs(mean - 0.3) < 0.02, 'mean ' + mean + ' LSB')
    const nod = decodeWav(encodeWav({ sr, ch: [tiny] }, 16, { dither: false })).ch[0]
    assert.ok(nod.every((v) => v === 0), 'without dither it rounds away')
  })

  test('24-bit, 8-bit and float, clipping and NaN', () => {
    const sr = 48000
    const s = noiseSig(5001, 8, 0.9)
    s[0] = 1.5
    s[1] = -2
    s[2] = NaN
    const b = { sr, ch: [s] }
    const d24 = decodeWav(encodeWav(b, 24)).ch[0]
    assert.ok(Math.abs(d24[0] - 8388607 / 8388608) < 1e-9)
    assert.equal(d24[1], -1)
    assert.equal(d24[2], 0)
    for (let i = 3; i < s.length; i++) assert.ok(Math.abs(d24[i] - s[i]) <= 0.5 / 8388608 + 1e-9)
    const w24 = encodeWav(b, 24)
    assert.equal(w24.length, 44 + 5001 * 3 + 1, 'odd data gets a pad byte')
    const f = encodeWav(b, 32)
    const df = decodeWav(f).ch[0]
    for (let i = 3; i < s.length; i++) assert.equal(df[i], s[i])
    assert.equal(df[0], 1.5)
    assert.equal(df[2], 0)
    assert.equal(wavInfo(f).format, 'float')
    const d8 = decodeWav(encodeWav(b, 8)).ch[0]
    for (let i = 3; i < s.length; i++) assert.ok(Math.abs(d8[i] - s[i]) <= 1.5 / 128)
    assert.throws(() => encodeWav(b, 12), /8, 16, 24 or 32 bits/)
    assert.equal(decodeWav(encodeWav({ sr, ch: [new Float32Array(0)] })).ch[0].length, 0)
  })

  function riff(chunks) {
    let len = 4
    for (const c of chunks) len += 8 + c.body.length + (c.body.length & 1)
    const u8 = new Uint8Array(8 + len)
    const dv = new DataView(u8.buffer)
    u8.set([82, 73, 70, 70], 0)
    dv.setUint32(4, len, true)
    u8.set([87, 65, 86, 69], 8)
    let o = 12
    for (const c of chunks) {
      for (let i = 0; i < 4; i++) u8[o + i] = c.id.charCodeAt(i)
      dv.setUint32(o + 4, c.size !== undefined ? c.size : c.body.length, true)
      u8.set(c.body, o + 8)
      o += 8 + c.body.length + (c.body.length & 1)
    }
    return u8
  }
  function fmtBody(format, nch, sr, bits, blockAlign, extra) {
    const u8 = new Uint8Array(extra ? 40 : 16)
    const dv = new DataView(u8.buffer)
    dv.setUint16(0, format, true)
    dv.setUint16(2, nch, true)
    dv.setUint32(4, sr, true)
    dv.setUint32(8, sr * blockAlign, true)
    dv.setUint16(12, blockAlign, true)
    dv.setUint16(14, bits, true)
    if (extra) {
      dv.setUint16(16, 22, true)
      dv.setUint16(18, extra.valid, true)
      dv.setUint32(20, 0, true)
      dv.setUint16(24, extra.sub, true)
      u8.set([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 26)
    }
    return u8
  }

  test('extensible, odd unknown chunks, float64, G.711, unfilled sizes', () => {
    // extensible 24-bit in a 32-bit container, an odd LIST chunk first
    const data = new Uint8Array(8)
    const dv = new DataView(data.buffer)
    dv.setInt32(0, 0x40000000, true) // +0.5
    dv.setInt32(4, -0x40000000, true) // -0.5
    const u8 = riff([
      { id: 'LIST', body: new Uint8Array([1, 2, 3]) },
      { id: 'fmt ', body: fmtBody(0xfffe, 1, 32000, 32, 4, { valid: 24, sub: 1 }) },
      { id: 'junk', body: new Uint8Array(5) },
      { id: 'data', body: data },
    ])
    const d = decodeWav(u8)
    assert.equal(d.sr, 32000)
    assert.deepEqual(Array.from(d.ch[0]), [0.5, -0.5])
    // float64
    const f64 = new Uint8Array(16)
    new DataView(f64.buffer).setFloat64(0, 0.25, true)
    new DataView(f64.buffer).setFloat64(8, NaN, true)
    const d64 = decodeWav(riff([{ id: 'fmt ', body: fmtBody(3, 1, 8000, 64, 8) }, { id: 'data', body: f64 }]))
    assert.deepEqual(Array.from(d64.ch[0]), [0.25, 0])
    // G.711
    const g = new Uint8Array([0xff, 0x7f, 0x00, 0x80])
    const mu = decodeWav(riff([{ id: 'fmt ', body: fmtBody(7, 1, 8000, 8, 1) }, { id: 'data', body: g }])).ch[0]
    assert.equal(mu[0], 0)
    assert.equal(mu[1], 0)
    assert.equal(mu[2], -32124 / 32768)
    assert.equal(mu[3], 32124 / 32768)
    const al = decodeWav(riff([{ id: 'fmt ', body: fmtBody(6, 1, 8000, 8, 1) }, { id: 'data', body: new Uint8Array([0xd5, 0x55, 0xaa, 0x2a]) }])).ch[0]
    assert.equal(al[0], 8 / 32768)
    assert.equal(al[1], -8 / 32768)
    assert.equal(al[2], 32256 / 32768)
    assert.equal(al[3], -32256 / 32768)
    // a recorder that wrote 0xFFFFFFFF for the data size
    const pcm = new Uint8Array([0, 0x40, 0, 0xc0])
    const ff = riff([{ id: 'fmt ', body: fmtBody(1, 1, 16000, 16, 2) }, { id: 'data', body: pcm, size: 0xffffffff }])
    assert.deepEqual(Array.from(decodeWav(ff).ch[0]), [0.5, -0.5])
    // a cut-off file: size says more than is there
    const cutFull = riff([{ id: 'fmt ', body: fmtBody(1, 1, 16000, 16, 2) }, { id: 'data', body: new Uint8Array([0, 0x40, 0]), size: 1000 }])
    const cut = cutFull.subarray(0, cutFull.length - 1) // no pad byte in a cut-off file
    assert.deepEqual(Array.from(decodeWav(cut).ch[0]), [0.5])
    // 8-bit unsigned
    const u8b = decodeWav(riff([{ id: 'fmt ', body: fmtBody(1, 1, 8000, 8, 1) }, { id: 'data', body: new Uint8Array([128, 192, 0]) }])).ch[0]
    assert.deepEqual(Array.from(u8b), [0, 0.5, -1])
    // ArrayBuffer and a view with an offset both work
    const w = encodeWav({ sr: 8000, ch: [new Float32Array([0.5, -0.5])] }, 24)
    assert.equal(decodeWav(w.buffer).ch[0][0], 0.5)
    const big = new Uint8Array(w.length + 3)
    big.set(w, 3)
    assert.equal(decodeWav(big.subarray(3)).ch[0][1], -0.5)
  })

  test('multichannel folds to stereo; errors are plain sentences', () => {
    const n = 4
    const body = new Uint8Array(n * 6 * 2)
    const dv = new DataView(body.buffer)
    for (let i = 0; i < n; i++) for (let c = 0; c < 6; c++) dv.setInt16((i * 6 + c) * 2, c === 2 ? 16384 : c === 3 ? 32000 : 0, true)
    const six = riff([{ id: 'fmt ', body: fmtBody(1, 6, 48000, 16, 12) }, { id: 'data', body }])
    const d = decodeWav(six)
    assert.equal(d.ch.length, 2)
    assert.ok(Math.abs(d.ch[0][0] - 0.5 * Math.SQRT1_2) < 1e-6, 'centre to both, LFE dropped')
    assert.equal(decodeWav(six, { keepChannels: true }).ch.length, 6)
    assert.throws(() => decodeWav(new Uint8Array(10)), /too short/)
    assert.throws(() => decodeWav(new TextEncoder().encode('hello there, not a wav file')), /not a WAV file/)
    const mp3 = riff([{ id: 'fmt ', body: fmtBody(0x55, 1, 44100, 0, 1) }, { id: 'data', body: new Uint8Array(4) }])
    assert.throws(() => decodeWav(mp3), /compressed format \(code 85\)/)
    assert.throws(() => decodeWav(riff([{ id: 'data', body: new Uint8Array(4) }])), /no format chunk/)
    assert.throws(() => decodeWav(riff([{ id: 'fmt ', body: fmtBody(1, 1, 8000, 16, 2) }])), /no sound data/)
  })

  test('fixtures loadWav now reads through core/wav.js; speed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-wav-'))
    try {
      const sr = 48000
      const L = sineSig(sr, 30, 220, 0.5)
      const R = sineSig(sr, 30, 330, 0.5)
      let bytes
      const encMs = timeIt(() => (bytes = encodeWav({ sr, ch: [L, R] })))
      const p = join(dir, 'a.wav')
      writeFileSync(p, bytes)
      let back
      const decMs = timeIt(() => (back = decodeWav(bytes)))
      const viaFixture = loadWav(p)
      assert.deepEqual(viaFixture.ch[0].subarray(0, 1000), back.ch[0].subarray(0, 1000))
      assert.ok(encMs < 1500 && decMs < 800, 'encode ' + encMs + ' decode ' + decMs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- loudness
describe('loudness', () => {
  test('K-weighting at 48 kHz matches the BS.1770 table', () => {
    const { shelf, hp } = kWeightingCoefs(48000)
    const want = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585]
    const got = [shelf.b0, shelf.b1, shelf.b2, shelf.a1, shelf.a2]
    for (let i = 0; i < 5; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-8)
    assert.ok(Math.abs(hp.a1 - -1.99004745483398) < 1e-8)
    assert.ok(Math.abs(hp.a2 - 0.99007225036621) < 1e-8)
  })

  test('a full-scale 997 Hz sine reads -3.01 LUFS at every rate', () => {
    for (const sr of [8000, 16000, 22050, 44100, 48000, 96000]) {
      const s = sineSig(sr, 3, 997, 1)
      const L = lufs({ sr, ch: [s] })
      assert.ok(Math.abs(L + 3.01) < 0.06, sr + ': ' + L)
    }
  })

  function stereoTone(sr, parts) {
    let n = 0
    for (const [sec] of parts) n += Math.round(sec * sr)
    const s = new Float32Array(n)
    let o = 0
    let ph = 0
    for (const [sec, dbfs] of parts) {
      const a = Math.pow(10, dbfs / 20)
      const m = Math.round(sec * sr)
      for (let i = 0; i < m; i++) {
        s[o + i] = a * Math.sin(ph)
        ph += (2 * Math.PI * 1000) / sr
      }
      o += m
    }
    return { sr, ch: [s, new Float32Array(s)] }
  }

  test('EBU Tech 3341 cases 1 to 5 (gating)', () => {
    const sr = 48000
    const cases = [
      [[[20, -23]], -23],
      [[[20, -33]], -33],
      [[[10, -36], [60, -23], [10, -36]], -23],
      [[[10, -72], [10, -36], [60, -23], [10, -36], [10, -72]], -23],
      [[[20, -26], [20.1, -20], [20, -26]], -23],
    ]
    for (const [parts, want] of cases) {
      const L = lufs(stereoTone(sr, parts))
      assert.ok(Math.abs(L - want) < 0.1, JSON.stringify(parts) + ' -> ' + L)
    }
  })

  test('silence, short clips, normalizeLufs', () => {
    const sr = 48000
    assert.equal(lufs({ sr, ch: [new Float32Array(sr)] }), -200)
    assert.equal(lufs({ sr, ch: [new Float32Array(0)] }), -200)
    const short = sineSig(sr, 0.2, 997, 1)
    assert.ok(Math.abs(lufs({ sr, ch: [short] }) + 3.01) < 0.1)
    const det = lufsDetail({ sr, ch: [sineSig(sr, 2, 997, 0.5)] })
    assert.equal(det.blocks, 17)
    assert.ok(det.momentaryMax > det.integrated - 0.1)
    const v = synthVoice(sr, 4)
    normalizeLufs(v, -16)
    assert.ok(Math.abs(lufs(v) + 16) < 0.05)
    const quiet = { sr, ch: [sineSig(sr, 1, 500, 1e-5)] }
    const before = new Float32Array(quiet.ch[0])
    normalizeLufs(quiet, -16)
    assert.deepEqual(quiet.ch[0], before, 'nothing above the gate: left alone')
    const capped = synthVoice(sr, 2)
    for (let i = 0; i < capped.ch[0].length; i++) capped.ch[0][i] *= 0.01
    const L0 = lufs(capped)
    normalizeLufs(capped, -16, { maxGainDb: 10 })
    assert.ok(Math.abs(lufs(capped) - (L0 + 10)) < 0.05)
  })

  test('true peak: catches inter-sample overs, never invents them, skipping is exact', () => {
    const sr = 48000
    const q = sineSig(sr, 0.2, sr / 4, 1, Math.PI / 4)
    assert.ok(Math.abs(truePeakDb(q)) < 0.1, 'quarter-rate sine ' + truePeakDb(q))
    const low = sineSig(sr, 0.2, 100, 0.5)
    assert.ok(Math.abs(truePeakDb(low) - db(0.5)) < 0.01)
    for (const f of [0.05, 0.13, 0.27, 0.38]) {
      const s = sineSig(sr, 0.1, f * sr, 0.5, 0.3)
      // fade the ends: a hard start really does overshoot when reconstructed
      for (let i = 0; i < 480; i++) {
        const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / 480)
        s[i] *= w
        s[s.length - 1 - i] *= w
      }
      const tp = truePeakDb(s)
      assert.ok(tp < db(0.5) + 0.02 && tp > db(0.5) - 0.5, f + ': ' + tp)
    }
    // skipping must not change the answer: compare with a full interpolation
    const v = synthVoice(sr, 2).ch[0]
    const full = interSamplePeaks(v, -1)
    let m = 0
    for (const x of full) m = Math.max(m, x)
    assert.ok(Math.abs(truePeakSig(v) - m) < 1e-6 * m)
    assert.equal(truePeakDb(new Float32Array(10)), -200)
    assert.equal(truePeakDb({ sr, ch: [new Float32Array(0)] }), -200)
  })

  test('speed: 30 s of stereo speech', () => {
    const sr = 48000
    const v = synthVoice(sr, 30)
    const b = { sr, ch: [v.ch[0], new Float32Array(v.ch[0])] }
    const lm = timeIt(() => lufs(b), 2)
    const tm = timeIt(() => truePeakDb(b), 2)
    assert.ok(lm < 400 && tm < 600, 'lufs ' + lm + ' truePeak ' + tm)
  })
})

// ---------------------------------------------------------------- segment
function truthPhrases(meta) {
  const tp = []
  for (const s of meta.segments) {
    const last = tp[tp.length - 1]
    if (last && s.start - last.end < 0.05) last.end = s.end
    else tp.push({ start: s.start, end: s.end })
  }
  return tp
}

function checkPhrases(found, meta, sr, n, label, mustSplit = 0.21, mustNotSplit = 0.15, slack = 0.08) {
  const tp = truthPhrases(meta)
  // well formed
  for (let k = 0; k < found.length; k++) {
    assert.ok(found[k].start >= 0 && found[k].end <= n && found[k].end > found[k].start, label)
    if (k) assert.ok(found[k].start >= found[k - 1].end, label + ' overlap')
  }
  // every long pause is found, no pause is invented inside speech
  for (let k = 1; k < tp.length; k++) {
    const g0 = tp[k - 1].end
    const g1 = tp[k].start
    const split = found.some((p, j) => j > 0 && found[j - 1].end / sr <= g1 + 0.03 && p.start / sr >= g0 - 0.03)
    if (g1 - g0 >= mustSplit) assert.ok(split, label + ' missed pause at ' + g0.toFixed(2))
    if (g1 - g0 < mustNotSplit) assert.ok(!split, label + ' split a short pause at ' + g0.toFixed(2))
  }
  for (let j = 1; j < found.length; j++) {
    const a = found[j - 1].end / sr
    const b = found[j].start / sr
    const inGap = tp.some((p, k) => k > 0 && a >= tp[k - 1].end - slack && b <= tp[k].start + slack)
    assert.ok(inGap, label + ' pause found inside speech at ' + a.toFixed(2))
  }
  // speech is covered
  for (const p of tp) {
    const mid = ((p.start + p.end) / 2) * sr
    assert.ok(found.some((f) => f.start <= mid && f.end >= mid), label + ' speech not covered at ' + p.start.toFixed(2))
  }
}

describe('segment', () => {
  test('findPhrases finds the pauses of synthetic speech at several rates and levels', () => {
    for (const sr of [48000, 16000, 8000]) {
      for (const seed of [1, 2, 3, 4]) {
        const v = synthVoice(sr, 8, { seed })
        const s = v.ch[0]
        checkPhrases(findPhrases(s, sr), v.meta, sr, s.length, sr + '/' + seed)
        // 40 dB quieter: same answer
        const q = s.map((x) => x * 0.01)
        checkPhrases(findPhrases(q, sr), v.meta, sr, s.length, sr + '/' + seed + ' quiet')
      }
    }
  })

  test('findPhrases with room noise under the voice', () => {
    const sr = 48000
    for (const seed of [5, 6, 7]) {
      const v = synthVoice(sr, 8, { seed })
      const s = v.ch[0]
      const nz = pink(s.length, makeRng(seed))
      const level = Math.pow(10, (rmsDb(s) - 30) / 20) / 0.2
      for (let i = 0; i < s.length; i++) s[i] += nz[i] * level
      // noise masks the soft ends of words and a faint h, so pauses read a little longer
      checkPhrases(findPhrases(s, sr), v.meta, sr, s.length, 'noisy ' + seed, 0.21, 0.12, 0.15)
    }
  })

  test('findPhrases edge cases: silence, a click, a steady tone, a short blip', () => {
    const sr = 48000
    assert.deepEqual(findPhrases(new Float32Array(sr), sr), [])
    assert.deepEqual(findPhrases(new Float32Array(0), sr), [])
    const click = new Float32Array(sr)
    click[20000] = 1
    assert.deepEqual(findPhrases(click, sr), [])
    const tone = sineSig(sr, 2, 300, 0.3)
    const t = findPhrases(tone, sr)
    assert.equal(t.length, 1)
    assert.ok(t[0].start < 0.03 * sr && t[0].end > 1.97 * sr)
    // two words with a 50 ms blip alone in the pause between them
    const s = new Float32Array(sr * 3)
    s.set(sineSig(sr, 0.8, 200, 0.4), 0)
    s.set(sineSig(sr, 0.05, 200, 0.4), Math.round(1.4 * sr))
    s.set(sineSig(sr, 0.8, 200, 0.4), 2 * sr)
    const w = findPhrases(s, sr)
    assert.equal(w.length, 2)
    const nb = findPhrases(s, sr, { minPhraseMs: 20 })
    assert.equal(nb.length, 3)
    // an absolute floor
    assert.equal(findPhrases(s.map((x) => x * 0.001), sr, { floorDb: -40 }).length, 0)
  })

  test('findSyllables finds one nucleus per vowel', () => {
    for (const sr of [48000, 16000]) {
      for (const seed of [1, 2, 3]) {
        const v = synthVoice(sr, 8, { seed })
        const s = v.ch[0]
        const vowels = v.meta.segments.filter((g) => g.kind === 'vowel')
        const syl = findSyllables(s, sr)
        assert.ok(Math.abs(syl.length - vowels.length) <= Math.ceil(vowels.length * 0.15), sr + '/' + seed + ': ' + syl.length + ' vs ' + vowels.length)
        let inside = 0
        for (let k = 0; k < syl.length; k++) {
          const x = syl[k]
          assert.ok(x.start <= x.peak && x.peak < x.end)
          if (k) assert.ok(x.start >= syl[k - 1].end)
          const t = x.peak / sr
          if (vowels.some((g) => t >= g.start && t <= g.end)) inside++
        }
        assert.ok(inside >= 0.9 * syl.length)
      }
    }
    assert.deepEqual(findSyllables(new Float32Array(1000), 48000), [])
  })

  const REAL_DIR = 'F:/Kade ai info/Fish talking listen (Oct 16)/'
  const realFiles = existsSync(REAL_DIR) ? readdirSync(REAL_DIR).filter((f) => f.toLowerCase().endsWith('.wav')).slice(0, 4) : []
  test('real speech recordings', { skip: realFiles.length ? false : 'speech folder not on this machine' }, () => {
    for (const f of realFiles) {
      const b = loadWav(REAL_DIR + f)
      const s = b.ch.length > 1 ? b.ch[0].map((x, i) => (x + b.ch[1][i]) / 2) : b.ch[0]
      const dur = s.length / b.sr
      const ph = findPhrases(s, b.sr)
      assert.ok(ph.length >= Math.max(2, Math.floor(dur / 8)), f + ' phrases ' + ph.length)
      const cover = ph.reduce((a, p) => a + p.end - p.start, 0) / b.sr
      assert.ok(cover / dur > 0.5 && cover / dur < 0.98, f + ' cover ' + cover / dur)
      const quiet = findPhrases(s.map((x) => x * 0.02), b.sr)
      assert.equal(quiet.length, ph.length, f + ' quiet copy')
      const syl = findSyllables(s, b.sr, { phrases: ph })
      const rate = syl.length / cover
      assert.ok(rate > 2.5 && rate < 7.5, f + ' syllables per second ' + rate)
    }
  })

  test('speed: 30 s of speech', () => {
    const sr = 48000
    const s = synthVoice(sr, 30).ch[0]
    const pm = timeIt(() => findPhrases(s, sr), 2)
    const sm = timeIt(() => findSyllables(s, sr), 2)
    assert.ok(pm < 300 && sm < 500, 'phrases ' + pm + ' syllables ' + sm)
  })
})
