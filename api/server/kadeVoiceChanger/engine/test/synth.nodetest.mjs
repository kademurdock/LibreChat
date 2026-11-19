// test/synth.nodetest.mjs - the synth family: ring modulator, fast flutter,
// frequency wobble, frequency shifter, resonator bank, sympathetic strings
// and grain cloud.
//
// What it proves, per module:
// - shape: validateModuleShape finds nothing wrong (names, params, live);
// - robustness (CONTRACT section 4): 0-length mono and stereo input, pure
//   silence (which must stay silent), a single click, a synthetic voice and
//   a stereo pair, with every number param at min, default and max and every
//   choice option: finite, peak under 8, the take plus the declared tail
//   in length, and the right channel count;
// - tails: the resonator, strings, spiral feedback and grains run on after
//   the take instead of being cut off (the last 10 ms of real speech at
//   least 60 dB under the peak), a struck object rings through its tail, a
//   capped spiral fades out, and a buzzing string obeys its ring time after
//   the take while the take itself is unchanged;
// - that it does what its name says, measured with the independent rulers
//   in test/measure.mjs: ring modulation makes sum and difference sidebands
//   and removes the original; flutter keeps the original and adds
//   sidebands at its speed; the wobble swings the measured pitch and, at
//   zero depth, is the input exactly and in time; the shifter moves a tone
//   by hertz with one sideband only and its spiral feedback dies away; the
//   resonator rings at its tuned mode frequencies at any sample rate, wood
//   dies fast and a singing bowl sings on; the strings are in tune to
//   within 0.3 percent at 48, 44.1 and 22.05 kHz (fractional delay tuning);
//   grains transpose by their pitch and spread in stereo;
// - loudness: each effect at its defaults stays within a few decibels of the
//   voice it was given, on the real 24 kHz speech file when it is present;
// - live versions (ringmod, am, fm, freqshift, resonator): block-by-block
//   output matches offline over the take (exactly where the core is shared
//   and causal), the resonator gives the same output at any block size,
//   in-place processing (outs aliasing ins) works, odd block sizes work,
//   and set() mid-stream with every control moved stays finite;
// - speed: milliseconds per second of 48 kHz mono, against generous bounds
//   (reported with t.diagnostic).
//
// Run: node --test engine/test/synth.nodetest.mjs (Node 24).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { synthVoice, impulse, silence, sine } from './fixtures.mjs'
import { assertSane, medianF0, f0Track, rmsDb, timeIt, bandEnergyDb, cfft, stereoCorrelation, spectralCentroid } from './measure.mjs'
import { resolveParams, validateModuleShape } from '../core/params.js'
import { decodeWav } from '../core/wav.js'
import { makeRng } from '../core/rng.js'
import { cloneBuf } from '../core/buf.js'

import ringmod from '../modules/synth/ringmod.js'
import am from '../modules/synth/am.js'
import fm from '../modules/synth/fm.js'
import freqshift from '../modules/synth/freqshift.js'
import resonator from '../modules/synth/resonator.js'
import strings, { stringFreqs, ringStrings } from '../modules/synth/strings.js'
import granular from '../modules/synth/granular.js'

const MODULES = [ringmod, am, fm, freqshift, resonator, strings, granular]
const LIVE = [ringmod, am, fm, freqshift, resonator]
const SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'
const SPEECH2 = 'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav'

function makeCtx(sr, seed = 'synth-test', extra = {}) {
  const notes = []
  return {
    sr,
    rng: makeRng(seed),
    progress() {},
    cancelled() {
      return false
    },
    note(s) {
      notes.push(s)
    },
    notes,
    side: null,
    ...extra,
  }
}

function run(mod, buf, p = {}, ctx) {
  const rp = resolveParams(mod, p, { strict: true })
  return mod.process(cloneBuf(buf), rp, ctx || makeCtx(buf.sr))
}

/** Samples a module adds after the take (its declared tail). */
function tailSamples(mod, p, sr) {
  return Math.round(mod.tail(resolveParams(mod, p), sr) * sr)
}

/** The output is the take plus the declared tail, in the right channels. */
function expectShape(mod, input, out, p = {}) {
  const n = input.ch[0].length
  const want = n ? n + tailSamples(mod, p, input.sr) : 0
  for (const c of out.ch) assert.equal(c.length, want, mod.id + ' with ' + JSON.stringify(p) + ': length ' + c.length + ', expected take + tail ' + want)
  if (mod.stereo === 'make') assert.equal(out.ch.length, 2, mod.id + ': should be stereo')
  else if (mod.stereo === 'keep') assert.equal(out.ch.length, input.ch.length, mod.id + ': channel count changed')
  else assert.equal(out.ch.length, 1)
}

/** The first n samples of every channel (the span of the take itself). */
function span(b, n) {
  return { sr: b.sr, ch: b.ch.map((c) => c.subarray(0, n)) }
}

/** Peak (dB) of the whole output against the rms (dB) of its last 10 ms. */
function endDrop(b) {
  let pk = 0
  for (const c of b.ch) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]))
  const m = Math.round(0.01 * b.sr)
  let e = 0
  for (const c of b.ch) for (let i = c.length - m; i < c.length; i++) e += c[i] * c[i]
  const r = Math.sqrt(e / (m * b.ch.length))
  return 20 * Math.log10(pk + 1e-30) - 20 * Math.log10(r + 1e-30)
}

function stereoVoice(sr, seconds) {
  const a = synthVoice(sr, seconds, { f0: 130, seed: 3 })
  const b = synthVoice(sr, seconds, { f0: 210, seed: 4 })
  return { sr, ch: [a.ch[0], b.ch[0]] }
}

let speechCache
function speech() {
  if (speechCache !== undefined) return speechCache
  speechCache = existsSync(SPEECH) ? decodeWav(new Uint8Array(readFileSync(SPEECH))) : null
  return speechCache
}

/** Peak frequency (Hz, parabolic) of sig between lo and hi, with a long FFT. */
function peakHz(sig, sr, lo, hi, N = 1 << 17) {
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const m = Math.min(N, sig.length)
  for (let i = 0; i < m; i++) re[i] = sig[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / m))
  cfft(re, im)
  const k0 = Math.max(1, Math.floor((lo * N) / sr))
  const k1 = Math.min(N / 2 - 2, Math.ceil((hi * N) / sr))
  let best = k0
  let bm = -1
  for (let k = k0; k <= k1; k++) {
    const mag = re[k] * re[k] + im[k] * im[k]
    if (mag > bm) {
      bm = mag
      best = k
    }
  }
  const a = Math.log(re[best - 1] ** 2 + im[best - 1] ** 2 + 1e-30)
  const b = Math.log(bm + 1e-30)
  const c = Math.log(re[best + 1] ** 2 + im[best + 1] ** 2 + 1e-30)
  const den = a - 2 * b + c
  const off = den < 0 ? (0.5 * (a - c)) / den : 0
  return ((best + off) * sr) / N
}

/**
 * Time (s) for the energy decay curve (Schroeder backward integration,
 * which smooths over beating) to fall dropDb below its start.
 */
function fallTime(sig, sr, dropDb = 30) {
  const n = sig.length
  const edc = new Float64Array(n + 1)
  for (let i = n - 1; i >= 0; i--) edc[i] = edc[i + 1] + sig[i] * sig[i]
  const lim = edc[0] * Math.pow(10, -dropDb / 10)
  for (let i = 0; i < n; i++) if (edc[i] < lim) return i / sr
  return n / sr
}

/** Level (dB) of the strongest long-FFT bin within +-1.5 Hz of f, over sig[from..from+N). */
function levelAt(sig, sr, f, from = 0, N = 1 << 17) {
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const m = Math.min(N, sig.length - from)
  for (let i = 0; i < m; i++) re[i] = sig[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / m))
  cfft(re, im)
  let best = 0
  const k0 = Math.max(1, Math.floor(((f - 1.5) * N) / sr))
  const k1 = Math.ceil(((f + 1.5) * N) / sr)
  for (let k = k0; k <= k1; k++) best = Math.max(best, re[k] * re[k] + im[k] * im[k])
  return 10 * Math.log10(best + 1e-30)
}

// ---------------------------------------------------------------- shape and robustness

describe('synth family: shape and robustness', () => {
  for (const mod of MODULES) {
    test(mod.id + ' passes the module shape check', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'synth')
      assert.ok(mod.params.length >= 2 && mod.params.length <= 8, 'two to eight params')
      const t = mod.tail(resolveParams(mod, null), 48000)
      assert.ok(Number.isFinite(t) && t >= 0)
      if (LIVE.includes(mod)) assert.ok(mod.live && typeof mod.live.create === 'function', mod.id + ' should have live')
    })

    test(mod.id + ' handles empty, silent and click input', () => {
      for (const nch of [1, 2]) {
        const empty = { sr: 48000, ch: Array.from({ length: nch }, () => new Float32Array(0)) }
        const out = run(mod, empty)
        assert.ok(out && Array.isArray(out.ch))
        for (const c of out.ch) assert.equal(c.length, 0)
        const quiet = silence(48000, 0.5, nch)
        const qo = run(mod, quiet)
        expectShape(mod, quiet, qo)
        const s = assertSane(qo)
        assert.ok(s.peak < 1e-9, mod.id + ': silence in should stay silent, peak ' + s.peak)
      }
      const click = impulse(48000, 0.6, 0.1)
      const co = run(mod, click)
      expectShape(mod, click, co)
      assertSane(co)
    })

    test(mod.id + ' survives every setting at min, default and max, and every choice', () => {
      const voice = synthVoice(48000, 0.8, { f0: 150, seed: 11 })
      const click = impulse(48000, 0.4, 0.05)
      const cases = [{}]
      for (const prm of mod.params) {
        if (prm.type === 'number') {
          cases.push({ [prm.id]: prm.min }, { [prm.id]: prm.max })
        } else if (prm.type === 'choice') {
          for (const o of prm.options) cases.push({ [prm.id]: o.v })
        } else if (prm.type === 'bool') cases.push({ [prm.id]: !prm.def })
      }
      // everything at once at both ends
      const lo = {}
      const hi = {}
      for (const prm of mod.params) if (prm.type === 'number') {
        lo[prm.id] = prm.min
        hi[prm.id] = prm.max
      }
      cases.push(lo, hi)
      for (const p of cases) {
        for (const input of [voice, click]) {
          const out = run(mod, input, p)
          expectShape(mod, input, out, p)
          try {
            assertSane(out)
          } catch (e) {
            throw new Error(mod.id + ' with ' + JSON.stringify(p) + ': ' + e.message)
          }
        }
      }
    })

    test(mod.id + ' works on a stereo take and at 8, 22.05 and 96 kHz', () => {
      const st = stereoVoice(48000, 1)
      const out = run(mod, st)
      expectShape(mod, st, out)
      assertSane(out)
      for (const sr of [8000, 22050, 96000]) {
        const v = synthVoice(sr, 0.7, { f0: 140, seed: 5 })
        const o = run(mod, v)
        expectShape(mod, v, o)
        assertSane(o)
      }
    })

    test(mod.id + ' is deterministic for a seed', () => {
      const v = synthVoice(48000, 0.6, { f0: 160, seed: 9 })
      const a = run(mod, v, {}, makeCtx(48000, 'same'))
      const b = run(mod, v, {}, makeCtx(48000, 'same'))
      for (let c = 0; c < a.ch.length; c++) assert.deepEqual(a.ch[c], b.ch[c])
    })
  }
})

// ---------------------------------------------------------------- loudness and speed

describe('synth family: loudness and speed', () => {
  test('defaults stay near the voice level (synthetic voice, 48 kHz)', () => {
    const v = synthVoice(48000, 3, { f0: 140, seed: 21 })
    const ref = rmsDb(v)
    for (const mod of MODULES) {
      const out = run(mod, v)
      const d = rmsDb(span(out, v.ch[0].length)) - ref
      assert.ok(Math.abs(d) < 4.5, mod.id + ' changed the level by ' + d.toFixed(2) + ' dB')
    }
  })

  test('defaults on real speech at 24 kHz', (t) => {
    const sp = speech()
    if (!sp) {
      t.skip('speech file missing')
      return
    }
    const ref = rmsDb(sp)
    for (const mod of MODULES) {
      const out = run(mod, sp)
      expectShape(mod, sp, out)
      assertSane(out)
      const d = rmsDb(span(out, sp.ch[0].length)) - ref
      t.diagnostic(mod.id + ' level change on speech: ' + d.toFixed(2) + ' dB')
      assert.ok(Math.abs(d) < 4.5, mod.id + ' changed the speech level by ' + d.toFixed(2) + ' dB')
    }
    if (existsSync(SPEECH2)) {
      const sp2 = decodeWav(new Uint8Array(readFileSync(SPEECH2)))
      for (const mod of MODULES) assertSane(run(mod, sp2))
    }
  })

  test('speed per second of 48 kHz mono audio', (t) => {
    const v = synthVoice(48000, 6, { f0: 140, seed: 22 })
    const secs = 6
    for (const mod of MODULES) {
      run(mod, v) // warm up
      const ms = timeIt(() => run(mod, v), 2) / secs
      t.diagnostic(mod.id + ': ' + ms.toFixed(2) + ' ms per second of audio (cost ' + mod.cost + ')')
      // contract: cost 1-2 under 20 ms, cost 5 under 400; generous because the CPU is shared
      const bound = mod.cost <= 2 ? 60 : 200
      assert.ok(ms < bound, mod.id + ' took ' + ms.toFixed(1) + ' ms per second')
    }
  })
})

// ---------------------------------------------------------------- does what it says

describe('synth.ringmod', () => {
  test('a sine carrier makes sum and difference sidebands and removes the original', () => {
    const s = sine(48000, 1, 1000, 0.5)
    const out = run(ringmod, s, { freq: 300, shape: 'sine', mix: 100 })
    const lowSide = bandEnergyDb(out, 48000, 650, 750)
    const highSide = bandEnergyDb(out, 48000, 1250, 1350)
    const orig = bandEnergyDb(out, 48000, 950, 1050)
    assert.ok(lowSide > orig + 30 && highSide > orig + 30, 'sidebands ' + lowSide.toFixed(1) + ' ' + highSide.toFixed(1) + ' original ' + orig.toFixed(1))
    assert.ok(Math.abs(lowSide - highSide) < 1.5, 'sidebands should be equal')
    assert.ok(Math.abs(rmsDb(out) - rmsDb(s)) < 1, 'level kept')
  })

  test('the other sound becomes the carrier; without one it falls back and says so', () => {
    const s = sine(48000, 1, 1000, 0.5)
    const side = sine(48000, 1, 200, 0.3)
    const ctx = makeCtx(48000, 'x', { side })
    const out = run(ringmod, s, { shape: 'side', mix: 100 }, ctx)
    assert.ok(bandEnergyDb(out, 48000, 780, 820) > bandEnergyDb(out, 48000, 980, 1020) + 30)
    assert.ok(bandEnergyDb(out, 48000, 1180, 1220) > bandEnergyDb(out, 48000, 980, 1020) + 30)
    assert.equal(ctx.notes.length, 0)
    const ctx2 = makeCtx(48000, 'x')
    const out2 = run(ringmod, s, { shape: 'side', freq: 300, mix: 100 }, ctx2)
    assert.equal(ctx2.notes.length, 1)
    assert.ok(bandEnergyDb(out2, 48000, 680, 720) > bandEnergyDb(out2, 48000, 980, 1020) + 30)
  })

  test('square carrier adds the third-harmonic sidebands', () => {
    const s = sine(48000, 1, 2000, 0.5)
    const out = run(ringmod, s, { freq: 200, shape: 'square', mix: 100 })
    // 2000 +- 600 from the carrier's third harmonic
    assert.ok(bandEnergyDb(out, 48000, 2580, 2620) > bandEnergyDb(out, 48000, 2380, 2420) + 20)
  })
})

describe('synth.am', () => {
  test('keeps the original and adds sidebands at the flutter speed', () => {
    const s = sine(48000, 1, 1000, 0.5)
    const out = run(am, s, { rate: 100, depth: 100, shape: 'sine', jitter: 0, mix: 100 })
    const c = bandEnergyDb(out, 48000, 980, 1020)
    const lo = bandEnergyDb(out, 48000, 880, 920)
    const hi = bandEnergyDb(out, 48000, 1080, 1120)
    assert.ok(lo > c - 9 && lo < c - 3, 'lower sideband ' + (lo - c).toFixed(1) + ' dB from the carrier')
    assert.ok(hi > c - 9 && hi < c - 3, 'upper sideband ' + (hi - c).toFixed(1) + ' dB')
    assert.ok(bandEnergyDb(out, 48000, 780, 820) < c - 30, 'no second sideband for a sine flutter')
  })

  test('the envelope repeats at the flutter speed', () => {
    const s = sine(48000, 2, 700, 0.5)
    const out = run(am, s, { rate: 12, depth: 100, shape: 'pulse', jitter: 0 })
    const hop = 48 // 1 ms frames
    const env = []
    for (let i = 0; i + hop <= out.ch[0].length; i += hop) {
      let e = 0
      for (let k = 0; k < hop; k++) e += out.ch[0][i + k] ** 2
      env.push(Math.sqrt(e / hop))
    }
    const mean = env.reduce((a, b) => a + b, 0) / env.length
    let best = 0
    let bl = 0
    for (let lag = 40; lag < 200; lag++) {
      let acc = 0
      for (let i = 0; i + lag < env.length; i++) acc += (env[i] - mean) * (env[i + lag] - mean)
      if (acc > best) {
        best = acc
        bl = lag
      }
    }
    assert.ok(Math.abs(bl - 1000 / 12) < 3, 'period ' + bl + ' ms, expected 83')
  })
})

describe('synth.fm', () => {
  test('zero depth is the input, exactly and in time', () => {
    const v = synthVoice(48000, 1, { f0: 150, seed: 2 })
    const out = run(fm, v, { depth: 0 })
    let md = 0
    for (let i = 0; i < v.ch[0].length; i++) md = Math.max(md, Math.abs(out.ch[0][i] - v.ch[0][i]))
    assert.ok(md < 1e-6, 'max difference ' + md)
  })

  test('slow wobble swings the measured pitch; fast wobble makes sidebands', () => {
    const s = sine(48000, 2, 400, 0.5)
    const out = run(fm, s, { rate: 4, depth: 4, shape: 'sine' })
    // expected swing: 1 +- 2 pi * 4 * 0.002 = +-5 percent
    const tr = f0Track(out, 48000, { minHz: 200, maxHz: 800, hopMs: 5 })
    const v = Array.from(tr.f0).filter((x) => x > 0)
    const hi = Math.max(...v)
    const lo = Math.min(...v)
    assert.ok(hi / lo > 1.07 && hi / lo < 1.14, 'pitch swing ratio ' + (hi / lo).toFixed(3))
    const s2 = sine(48000, 1, 1000, 0.5)
    const o2 = run(fm, s2, { rate: 60, depth: 1, shape: 'sine' })
    const c = bandEnergyDb(o2, 48000, 990, 1010)
    assert.ok(bandEnergyDb(o2, 48000, 930, 950) > c - 20, 'lower FM sideband')
    assert.ok(bandEnergyDb(o2, 48000, 1050, 1070) > c - 20, 'upper FM sideband')
  })

  test('the musical cap keeps the read point moving forward at any setting', () => {
    const s = sine(48000, 1, 300, 0.5)
    const out = run(fm, s, { rate: 300, depth: 15, shape: 'watery', randomness: 100 })
    assertSane(out)
    assert.ok(Math.abs(rmsDb(out) - rmsDb(s)) < 3)
  })
})

describe('synth.freqshift', () => {
  test('moves a tone by hertz with one sideband only', () => {
    const s = sine(48000, 1, 1000, 0.5)
    const up = run(freqshift, s, { shift: 200, mix: 100 })
    const u = bandEnergyDb(up, 48000, 1180, 1220)
    assert.ok(u > bandEnergyDb(up, 48000, 780, 820) + 30, 'no mirror sideband')
    assert.ok(u > bandEnergyDb(up, 48000, 980, 1020) + 30, 'original removed')
    const down = run(freqshift, s, { shift: -300, mix: 100 })
    const d = bandEnergyDb(down, 48000, 680, 720)
    assert.ok(d > bandEnergyDb(down, 48000, 1280, 1320) + 30)
    assert.ok(Math.abs(rmsDb(up) - rmsDb(s)) < 0.5, 'level kept')
  })

  test('shifts harmonics by the same hertz (they stop being harmonic)', () => {
    const sr = 48000
    const n = sr
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / sr) + 0.3 * Math.sin((2 * Math.PI * 400 * i) / sr)
    const out = run(freqshift, { sr, ch: [x] }, { shift: 50, mix: 100 })
    assert.ok(Math.abs(peakHz(out.ch[0], sr, 220, 280) - 250) < 1)
    assert.ok(Math.abs(peakHz(out.ch[0], sr, 420, 480) - 450) < 1)
  })

  test('spiral feedback rings on after the input and dies away', () => {
    const p = { shift: 30, feedback: 80, time: 100 }
    const tail = freqshift.tail(resolveParams(freqshift, p), 48000)
    assert.ok(tail > 1 && tail < 13)
    const click = impulse(48000, 4, 0.05)
    const out = run(freqshift, click, p)
    assertSane(out)
    const a = rmsDb(out.ch[0].subarray(0, 24000))
    const mid = rmsDb(out.ch[0].subarray(24000, 48000))
    const b = rmsDb(out.ch[0].subarray(3.5 * 48000))
    assert.ok(mid > -120, 'echoes continue after the click')
    assert.ok(b < a - 20, 'echoes die away: first ' + a.toFixed(1) + ' last ' + b.toFixed(1))
  })
})

describe('synth.resonator', () => {
  test('rings at its tuned frequencies, at any sample rate and pitch', () => {
    for (const sr of [48000, 22050]) {
      const click = impulse(sr, 3, 0.01)
      const out = run(resonator, click, { object: 'glass', mix: 100, strike: 0 })
      const f = peakHz(out.ch[0], sr, 300, 3000)
      assert.ok(Math.abs(f / 784 - 1) < 0.005, 'glass rings at ' + f.toFixed(1) + ' Hz at ' + sr)
      const up = run(resonator, click, { object: 'glass', mix: 100, strike: 0, pitch: 12 })
      const f2 = peakHz(up.ch[0], sr, 1000, 2500)
      assert.ok(Math.abs(f2 / 1568 - 1) < 0.005, 'up an octave rings at ' + f2.toFixed(1))
    }
  })

  test('a church bell has its hum, prime, minor-third tierce and nominal', () => {
    const sr = 48000
    const out = run(resonator, impulse(sr, 4, 0.01), { object: 'bell', mix: 100, strike: 0 })
    for (const r of [0.5, 1, 1.183, 2]) {
      const f = 220 * r
      const p = peakHz(out.ch[0], sr, f * 0.97, f * 1.03)
      assert.ok(Math.abs(p / f - 1) < 0.004, 'bell partial ' + r + ' at ' + p.toFixed(1) + ' Hz')
      const on = levelAt(out.ch[0], sr, f)
      const off = levelAt(out.ch[0], sr, f * 1.07)
      assert.ok(on > off + 15, 'partial ' + r + ' stands out by ' + (on - off).toFixed(1) + ' dB')
    }
  })

  test('each mode decays at its own rate: low tines ring on, high ones fade first', () => {
    // music box: no doublets; fundamental T60 2.5 s, the 6.267 mode 0.3 of that
    const sr = 48000
    const out = run(resonator, impulse(sr, 2, 0.01), { object: 'music-box', mix: 100, strike: 0 }).ch[0]
    const N = 1 << 13
    for (const [f, t60] of [[523.25, 2.5], [523.25 * 6.267, 0.75]]) {
      const a = levelAt(out, sr, f, Math.round(0.2 * sr), N)
      const b = levelAt(out, sr, f, Math.round(0.7 * sr), N)
      const want = (60 * 0.5) / t60
      const got = a - b
      assert.ok(Math.abs(got - want) < want * 0.2 + 1, 'mode at ' + f.toFixed(0) + ' Hz fell ' + got.toFixed(1) + ' dB in 0.5 s, expected ' + want.toFixed(1))
    }
  })

  test('each object decays like itself: wood dies fast, a singing bowl sings on', () => {
    const sr = 24000
    const click = impulse(sr, 8, 0.01)
    const wood = fallTime(run(resonator, click, { object: 'wood-box', mix: 100, strike: 0 }).ch[0], sr)
    const bowl = fallTime(run(resonator, click, { object: 'singing-bowl', mix: 100, strike: 0 }).ch[0], sr)
    const longer = fallTime(run(resonator, click, { object: 'wood-box', mix: 100, strike: 0, decay: 3 }).ch[0], sr)
    assert.ok(wood < 0.35, 'wood falls 30 dB in ' + wood.toFixed(2) + ' s')
    assert.ok(bowl > 2.5, 'bowl falls 30 dB in ' + bowl.toFixed(2) + ' s')
    assert.ok(longer > wood * 2.2, 'ring length stretches the decay')
  })

  test('strike on words makes the ringing follow the onsets', () => {
    const v = synthVoice(48000, 2, { f0: 140, seed: 8 })
    const a = run(resonator, v, { object: 'wood-bars', strike: 0, mix: 100 })
    const b = run(resonator, v, { object: 'wood-bars', strike: 100, mix: 100 })
    assertSane(a)
    assertSane(b)
    // both level matched to the voice (over the take)
    const n = v.ch[0].length
    assert.ok(Math.abs(rmsDb(span(a, n)) - rmsDb(v)) < 0.5 && Math.abs(rmsDb(span(b, n)) - rmsDb(v)) < 0.5)
    let diff = 0
    for (let i = 0; i < a.ch[0].length; i++) diff += (a.ch[0][i] - b.ch[0][i]) ** 2
    assert.ok(diff > 1, 'strike changes the sound')
  })
})

describe('synth.strings', () => {
  for (const sr of [48000, 44100, 22050]) {
    test('every string is in tune at ' + sr + ' Hz (fractional delay)', () => {
      const p = resolveParams(strings, { mix: 100, pluck: 0 })
      const freqs = stringFreqs(p)
      const out = run(strings, impulse(sr, 3, 0.01), p)
      for (const f of freqs) {
        const got = peakHz(out.ch[0], sr, f * 0.985, f * 1.015)
        assert.ok(Math.abs(got / f - 1) < 0.003, 'string ' + f.toFixed(2) + ' rings at ' + got.toFixed(2) + ' at ' + sr)
      }
    })
  }

  test('other keys, registers and chords tune too', () => {
    const sr = 48000
    for (const p0 of [{ key: 'F#', register: 'low', chord: 'minor' }, { key: 'Bb', register: 'high', chord: 'drone' }]) {
      const p = resolveParams(strings, { ...p0, mix: 100, pluck: 0 })
      const out = run(strings, impulse(sr, 3, 0.01), p)
      const f = stringFreqs(p)[1]
      const got = peakHz(out.ch[0], sr, f * 0.985, f * 1.015)
      assert.ok(Math.abs(got / f - 1) < 0.003, JSON.stringify(p0) + ' ' + f.toFixed(2) + ' vs ' + got.toFixed(2))
    }
  })

  test('ring time sets the decay; bridge buzz brightens', () => {
    const sr = 24000
    const click = impulse(sr, 6, 0.01)
    const short = fallTime(run(strings, click, { mix: 100, pluck: 0, decay: 0.5 }).ch[0], sr)
    const long = fallTime(run(strings, click, { mix: 100, pluck: 0, decay: 4 }).ch[0], sr)
    assert.ok(short < 0.5 && long > 1.2, 'decays ' + short.toFixed(2) + ' and ' + long.toFixed(2))
    const v = synthVoice(sr, 2, { f0: 140, seed: 6 })
    const plain = run(strings, v, { mix: 100, pluck: 100, buzz: 0 })
    const buzzy = run(strings, v, { mix: 100, pluck: 100, buzz: 100 })
    assert.ok(spectralCentroid(buzzy, sr) > spectralCentroid(plain, sr) * 1.1, 'buzz adds brightness')
  })

  test('a buzzing string can never run away (energy ceiling), on long takes and many seeds', () => {
    // Before the ceiling, this exact setting on the real speech take with
    // seed 3 grew to 1e37 (parametric pumping by the moving bridge).
    const takes = []
    const sp = speech()
    if (sp) takes.push(sp)
    takes.push(synthVoice(24000, 8, { f0: 120, seed: 41 }))
    for (const take of takes) {
      for (const seed of [1, 2, 3, 4]) {
        for (const p of [
          { chord: 'drone', key: 'D', buzz: 70, pluck: 70, brightness: 70 },
          { chord: 'fifths', register: 'low', buzz: 100, pluck: 100, brightness: 100, decay: 12 },
        ]) {
          const out = run(strings, take, p, makeCtx(take.sr, seed))
          const s = assertSane(out)
          assert.ok(s.peak < 3, 'peak ' + s.peak + ' with ' + JSON.stringify(p) + ' seed ' + seed)
        }
      }
    }
  })

  test('words pluck the strings: rings after each phrase ends', () => {
    const sr = 24000
    const v = synthVoice(sr, 3, { f0: 140, seed: 7 })
    const dry = rmsDb(v.ch[0].subarray(Math.round(2.96 * sr)))
    const out = run(strings, v, { mix: 100, pluck: 100 })
    const after = rmsDb(out.ch[0].subarray(Math.round(2.96 * sr), 3 * sr))
    assert.ok(after > dry + 20, 'strings still ringing at the end: ' + after.toFixed(1) + ' vs ' + dry.toFixed(1))
  })
})

describe('synth.granular', () => {
  test('grains transpose by their pitch', () => {
    const v = synthVoice(48000, 3, { f0: 140, seed: 12, fricatives: false })
    const out = run(granular, v, { pitch: 12, spread: 0, scatter: 0, reverse: 0, grain: 60, density: 60, width: 0 })
    const f = medianF0(out, 48000, { minHz: 100, maxHz: 600 })
    assert.ok(Math.abs(f / 280 - 1) < 0.06, 'median pitch ' + f.toFixed(1))
  })

  test('stereo spread decorrelates the sides; zero spread is centred', () => {
    const v = synthVoice(48000, 2, { f0: 150, seed: 13 })
    const narrow = run(granular, v, { width: 0, mix: 100 })
    const wide = run(granular, v, { width: 100, spread: 200, mix: 100 })
    assert.ok(stereoCorrelation(narrow) > 0.999)
    assert.ok(stereoCorrelation(wide) < 0.8, 'wide correlation ' + stereoCorrelation(wide).toFixed(3))
  })
})

// ---------------------------------------------------------------- tails

describe('synth family: rings and spirals run on after the take', () => {
  test('the take plus the tail, at the far ends of every tail', () => {
    const v = synthVoice(48000, 1, { f0: 150, seed: 51 })
    const cases = [
      [resonator, {}],
      [resonator, { decay: 4 }],
      [resonator, { object: 'singing-bowl', decay: 4 }],
      [resonator, { object: 'wood-box', decay: 0.1 }],
      [strings, {}],
      [strings, { decay: 12 }],
      [strings, { decay: 0.2, buzz: 100 }],
      [freqshift, { feedback: 80 }],
      [freqshift, { feedback: 95 }],
      [freqshift, { feedback: 95, time: 1 }],
      [granular, { grain: 500 }],
      [granular, { grain: 10 }],
    ]
    for (const [mod, p] of cases) {
      const out = run(mod, v, p)
      expectShape(mod, v, out, p)
      assertSane(out)
    }
  })

  test('nothing is cut off at the end of real speech (last 10 ms at least 60 dB under the peak)', (t) => {
    // the integrator's repro: Crisp Quartz ends 150 ms after its last word;
    // before the fix the last 10 ms sat 37, 27 and 23 dB under the peak
    const sp = speech()
    const take = sp || synthVoice(48000, 3, { f0: 140, seed: 52 })
    if (!sp) t.diagnostic('speech file missing, using a synthetic voice')
    for (const [mod, p] of [
      [resonator, {}],
      [resonator, { object: 'glass' }],
      [strings, {}],
      [strings, { chord: 'drone', key: 'D', buzz: 70, pluck: 70, brightness: 70, mix: 55 }],
      [freqshift, { feedback: 80 }],
      [granular, { grain: 300 }],
    ]) {
      const out = run(mod, take, p)
      expectShape(mod, take, out, p)
      const d = endDrop(out)
      t.diagnostic(mod.id + ' ' + JSON.stringify(p) + ': last 10 ms is ' + d.toFixed(1) + ' dB under the peak')
      assert.ok(d >= 60, mod.id + ' ' + JSON.stringify(p) + ': last 10 ms only ' + d.toFixed(1) + ' dB under the peak')
    }
  })

  test('a struck object really rings through its tail', () => {
    const sr = 24000
    const click = impulse(sr, 0.5, 0.1)
    for (const object of ['glass', 'bell', 'wood-box']) {
      const p = { object, mix: 100, strike: 0 }
      const out = run(resonator, click, p).ch[0]
      const n = Math.round(0.5 * sr)
      const tl = out.length - n
      assert.equal(tl, tailSamples(resonator, p, sr))
      const head = rmsDb(out.subarray(n, n + Math.round(0.05 * tl)))
      const late = rmsDb(out.subarray(n + Math.round(0.5 * tl), n + Math.round(0.6 * tl)))
      // a 60 dB ring time: halfway through the tail is about 30 dB down
      assert.ok(late > head - 50 && late < head - 15, object + ': halfway through the tail ' + (late - head).toFixed(1) + ' dB from its start')
      assert.ok(endDrop({ sr, ch: [out] }) >= 60, object + ' ends on a step')
    }
  })

  test('a capped spiral fades out instead of stopping', () => {
    const sr = 24000
    const p = { shift: 30, feedback: 95, time: 300 }
    const out = run(freqshift, impulse(sr, 1, 0.05), p).ch[0]
    const tl = out.length - sr
    assert.equal(tl, 12 * sr, 'capped at 12 s')
    const first = rmsDb(out.subarray(sr, 2 * sr))
    const before = rmsDb(out.subarray(sr + 6 * sr, sr + 7 * sr))
    assert.ok(before > first - 40, 'still spiralling 6 s after the take: ' + (before - first).toFixed(1) + ' dB')
    assert.ok(endDrop({ sr, ch: [out] }) >= 60, 'the spiral fades to nothing')
  })

  test('a buzzing string obeys the ring time after the take, and inside the take nothing changes', () => {
    const sr = 24000
    const v = synthVoice(sr, 2, { f0: 140, seed: 6 })
    const x = v.ch[0]
    const n = x.length
    const W = Math.round(0.02 * sr)
    const rmsAt = (s, i) => {
      let e = 0
      for (let k = 0; k < W; k++) e += s[i + k] * s[i + k]
      return Math.sqrt(e / W) + 1e-30
    }
    for (const buzz of [25, 50, 75]) {
      const p = resolveParams(strings, { mix: 100, pluck: 50, buzz, decay: 3, chord: 'drone' })
      const take = ringStrings(x, sr, p, makeRng(1), n)
      const long = ringStrings(x, sr, p, makeRng(1), n + 12 * sr)
      let md = 0
      for (let i = 0; i < n; i++) md = Math.max(md, Math.abs(take[i] - long[i]))
      assert.equal(md, 0, 'buzz ' + buzz + ': the take itself changed by ' + md)
      // 60 dB under the loudest 20 ms of the take's last half second
      let ref = 0
      for (let i = n - Math.round(0.5 * sr); i < n; i += W) ref = Math.max(ref, rmsAt(long, i))
      let last = 0
      for (let i = n; i + W < long.length; i += W) if (rmsAt(long, i) > ref * 1e-3) last = (i + W - n) / sr
      const tl = strings.tail(p, sr)
      // before the governor, buzz 50 rang on for 6.2 s at a 3 s ring time
      assert.ok(last <= tl, 'buzz ' + buzz + ': rang ' + last.toFixed(2) + ' s after the take, tail is ' + tl.toFixed(2) + ' s')
      assert.ok(last > 0.7 * 3, 'buzz ' + buzz + ': still rings most of the ring time (' + last.toFixed(2) + ' s)')
    }
  })
})

// ---------------------------------------------------------------- live

function liveRun(mod, buf, p, seed, block = 128, inPlace = false) {
  const rp = resolveParams(mod, p)
  const inst = mod.live.create(buf.sr, rp, makeRng(seed))
  const n = buf.ch[0].length
  const nch = buf.ch.length
  const outs = buf.ch.map(() => new Float32Array(n))
  const src = buf.ch.map((c) => new Float32Array(c))
  for (let off = 0; off < n; off += block) {
    const len = Math.min(block, n - off)
    const ins = src.map((c) => c.subarray(off, off + len))
    const os = inPlace ? ins : outs.map((c) => c.subarray(off, off + len))
    inst.process(ins, os, len)
  }
  return { sr: buf.sr, ch: inPlace ? src : outs, nch, inst }
}

describe('synth family: live', () => {
  test('ringmod, am and freqshift live match offline sample for sample', () => {
    const v = synthVoice(48000, 1.5, { f0: 150, seed: 31 })
    const settings = [
      [ringmod, { freq: 70, shape: 'square', wobbleDepth: 5, wobbleRate: 2 }],
      [am, { rate: 40, shape: 'bubbly', jitter: 60 }],
      [freqshift, { shift: -120, feedback: 40, time: 60, drift: 20 }],
    ]
    for (const [mod, p] of settings) {
      // offline also runs on into its tail; live covers the take itself
      const off = run(mod, v, p, makeCtx(48000, 'live-seed'))
      const n = v.ch[0].length
      for (const block of [128, 480, 37]) {
        const lv = liveRun(mod, v, p, 'live-seed', block)
        let md = 0
        for (let i = 0; i < n; i++) md = Math.max(md, Math.abs(lv.ch[0][i] - off.ch[0][i]))
        assert.ok(md < 1e-4, mod.id + ' live differs from offline by ' + md + ' (block ' + block + ')')
      }
      const ip = liveRun(mod, v, p, 'live-seed', 128, true)
      let md = 0
      for (let i = 0; i < n; i++) md = Math.max(md, Math.abs(ip.ch[0][i] - off.ch[0][i]))
      assert.ok(md < 1e-4, mod.id + ' in-place live differs by ' + md)
    }
  })

  test('fm live is the offline sound delayed by its latency', () => {
    const v = synthVoice(48000, 1, { f0: 150, seed: 32 })
    const rp = resolveParams(fm, { depth: 0 })
    const L = fm.live.latency(rp, 48000)
    const lv = liveRun(fm, v, { depth: 0 }, 's')
    let md = 0
    for (let i = 0; i + L < v.ch[0].length; i++) md = Math.max(md, Math.abs(lv.ch[0][i + L] - v.ch[0][i]))
    assert.ok(md < 1e-6, 'depth 0 live is a pure delay of ' + L + ' samples, off by ' + md)
    const off = run(fm, v, {})
    const lv2 = liveRun(fm, v, {}, 's')
    assert.ok(Math.abs(rmsDb(lv2) - rmsDb(off)) < 1)
  })

  test('resonator live gives the same output at any block size (blocks over 256 samples once read stale ringing)', () => {
    const v = synthVoice(48000, 1, { f0: 140, seed: 34 })
    for (const object of ['bell', 'strings-major']) {
      const p = { object }
      const a = liveRun(resonator, v, p, 's', 128)
      for (const block of [480, 1024, 37]) {
        const b = liveRun(resonator, v, p, 's', block)
        let md = 0
        for (let i = 0; i < a.ch[0].length; i++) md = Math.max(md, Math.abs(a.ch[0][i] - b.ch[0][i]))
        assert.ok(md < 1e-6, object + ': blocks of 128 and ' + block + ' differ by ' + md)
      }
    }
  })

  test('resonator live converges to the offline level', () => {
    const v = synthVoice(48000, 4, { f0: 140, seed: 33 })
    for (const object of ['bell', 'strings-major', 'wood-box']) {
      const p = { object, mix: 100 }
      const off = run(resonator, v, p)
      const lv = liveRun(resonator, v, p, 's')
      const a = rmsDb(off.ch[0].subarray(2 * 48000, 4 * 48000))
      const b = rmsDb(lv.ch[0].subarray(2 * 48000, 4 * 48000))
      assert.ok(Math.abs(a - b) < 3, object + ': live ' + b.toFixed(1) + ' dB vs offline ' + a.toFixed(1) + ' dB')
    }
  })

  test('every live module: stereo, odd blocks, set() mid-stream with every control moved', () => {
    const st = stereoVoice(48000, 1.2)
    for (const mod of LIVE) {
      const def = resolveParams(mod, null)
      assert.ok(Number.isFinite(mod.live.latency(def, 48000)))
      const inst = mod.live.create(48000, def, makeRng('mid'))
      const n = st.ch[0].length
      const outs = [new Float32Array(n), new Float32Array(n)]
      let off = 0
      let k = 0
      const sizes = [128, 480, 1, 7, 256, 333]
      while (off < n) {
        const len = Math.min(sizes[k % sizes.length], n - off)
        if (k === 20) {
          // move everything: numbers to max, choices to their last option
          const q = {}
          for (const prm of mod.params) {
            if (prm.type === 'number') q[prm.id] = prm.max
            else if (prm.type === 'choice') q[prm.id] = prm.options[prm.options.length - 1].v
          }
          inst.set(resolveParams(mod, q))
        }
        if (k === 60) inst.set(resolveParams(mod, null))
        inst.process(
          st.ch.map((c) => c.subarray(off, off + len)),
          outs.map((c) => c.subarray(off, off + len)),
          len,
        )
        off += len
        k++
      }
      assertSane({ sr: 48000, ch: outs })
      inst.reset()
      // mono in, mono out
      const mono = [new Float32Array(st.ch[0].subarray(0, 4800))]
      inst.process(mono, mono, 4800)
      assertSane({ sr: 48000, ch: mono })
    }
  })
})
