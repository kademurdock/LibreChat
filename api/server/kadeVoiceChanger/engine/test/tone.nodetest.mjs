// test/tone.nodetest.mjs - the tone family: EQ, filters, dynamics, cleanup.
//
// What is checked:
// 1. Shape: every module passes core/params.js validateModuleShape, the
//    cleanup tools stay out of "Surprise me", and the eleven modules that
//    must run live have a live version.
// 2. Robustness (CONTRACT section 4): empty input, silence, a single click,
//    stereo speech, 30 s of speech, every param at min, default and max and
//    every choice, at 8, 22.05, 44.1 and 96 kHz: no NaN, no Infinity, no
//    exception, peak under 8, length and channel count kept.
// 3. Live: every live module renders sample-identical output to the offline
//    render (gate shifted by its reported latency) whatever the block size,
//    with outs aliasing ins or not; parameter changes mid-stream never click.
// 4. Prove it (MODULES_PLAN section 10): EQ responses within 1 dB of the
//    cookbook (core/biquad.js is the reference, not the module's own code),
//    tilt see-saws around its pivot, filters cut where they should and sweeps
//    move at their rate, character shapes colour in the right direction and
//    keep the volume, the compressor follows its static curve (its automatic
//    and manual makeup together stay within 24 dB, a word after a long pause
//    jumps at most about 15 dB, hot settings never distort), the broadcast
//    processor is denser and level independent, the de-esser cuts s sounds
//    without touching vowels or the air band, the gate silences pauses,
//    noise reduction lowers the floor by more than 6 dB without musical
//    noise, hum removal takes out 50 and 60 Hz families, click removal
//    removes clicks and leaves clean speech alone, loudness hits its target.
// 5. Speed per second of 48 kHz mono audio, against generous bounds (other
//    builders share the CPU); the numbers are printed as diagnostics.
//
// Run with Node 24: node --test engine/test/tone.nodetest.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { synthVoice, impulse, silence, sine, noiseBuf } from './fixtures.mjs'
import { assertSane, bandEnergyDb, rmsDb, spectralCentroid, timeIt, cfft } from './measure.mjs'
import { resolveParams, validateModuleShape, speakValue } from '../core/params.js'
import { cloneBuf } from '../core/buf.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'
import { lufs } from '../core/loudness.js'
import { Biquad } from '../core/biquad.js'

const IDS = ['eq', 'tilt', 'filter', 'character', 'compress', 'broadcast', 'deess', 'gate', 'denoise', 'dehum', 'declick', 'loudness', 'gain', 'mono']
const LIVE = ['eq', 'tilt', 'filter', 'character', 'compress', 'broadcast', 'deess', 'gate', 'gain', 'mono', 'dehum']
const CLEANUP = ['eq', 'compress', 'deess', 'gate', 'denoise', 'dehum', 'declick', 'loudness', 'gain', 'mono']
const M = {}
for (const id of IDS) M[id] = (await import('../modules/tone/' + id + '.js')).default

const SPEECH_DIR = 'F:/Kade ai info/Fish talking listen (Oct 16)/'
const SPEECH_FILES = ['02 Crisp Quartz, today.wav', '06 Molasses Dusk, today.wav']
function loadSpeech(i) {
  const path = SPEECH_DIR + SPEECH_FILES[i]
  if (!existsSync(path)) return null
  try {
    return decodeWav(new Uint8Array(readFileSync(path)))
  } catch {
    return null
  }
}
const REAL = [loadSpeech(0), loadSpeech(1)].filter(Boolean)

function ctx(seed = 1, sr = 48000) {
  return { sr, rng: makeRng(seed), progress() {}, cancelled: () => false, note() {} }
}

function run(mod, buf, p = {}, seed = 1) {
  return mod.process(cloneBuf(buf), resolveParams(mod, p), ctx(seed, buf.sr))
}

function mono(sig, sr) {
  return { sr, ch: [sig] }
}

function voice(sr = 48000, seconds = 2, opts = {}) {
  const v = synthVoice(sr, seconds, { seed: 7, ...opts })
  return { sr, ch: [v.ch[0]], meta: v.meta }
}

function stereoVoice(sr = 48000, seconds = 2) {
  const a = synthVoice(sr, seconds, { seed: 11, f0: 120 }).ch[0]
  const b = synthVoice(sr, seconds, { seed: 12, f0: 190 }).ch[0]
  const R = new Float32Array(a.length)
  for (let i = 0; i < R.length; i++) R[i] = 0.6 * a[i] + 0.4 * b[i]
  return { sr, ch: [new Float32Array(a), R] }
}

function runLive(mod, buf, p = {}, { blocks = [128], alias = true, seed = 1, changes = [] } = {}) {
  const inst = mod.live.create(buf.sr, resolveParams(mod, p), makeRng(seed))
  const n = buf.ch[0].length
  const src = buf.ch.map((c) => new Float32Array(c))
  const out = alias ? src : buf.ch.map(() => new Float32Array(n))
  let i = 0
  let bi = 0
  while (i < n) {
    const m = Math.min(blocks[bi++ % blocks.length], n - i)
    for (const c of changes) if (c.at >= i && c.at < i + m) inst.set(resolveParams(mod, c.p))
    const ins = src.map((c) => c.subarray(i, i + m))
    const outs = alias ? ins : out.map((c) => c.subarray(i, i + m))
    inst.process(ins, outs, m)
    i += m
  }
  return { sr: buf.sr, ch: out }
}

/** Largest difference after fitting one constant gain from b to a (for loudness-matched renders). */
function maxDiffScaled(a, b) {
  let ab = 0
  let bb = 0
  let pk = 0
  for (let c = 0; c < a.ch.length; c++) {
    for (let i = 0; i < a.ch[c].length; i++) {
      ab += a.ch[c][i] * b.ch[c][i]
      bb += b.ch[c][i] * b.ch[c][i]
      pk = Math.max(pk, Math.abs(a.ch[c][i]))
    }
  }
  const k = bb > 0 ? ab / bb : 1
  let m = 0
  for (let c = 0; c < a.ch.length; c++) for (let i = 0; i < a.ch[c].length; i++) m = Math.max(m, Math.abs(a.ch[c][i] - k * b.ch[c][i]))
  return pk > 0 ? m / pk : m
}

function maxDiff(a, b, shift = 0) {
  let m = 0
  for (let c = 0; c < a.ch.length; c++) {
    const x = a.ch[c]
    const y = b.ch[c]
    for (let i = 0; i + shift < y.length && i < x.length; i++) {
      const d = Math.abs(x[i] - y[i + shift])
      if (d > m) m = d
    }
  }
  return m
}

/** Magnitude response (dB) of a module at the given frequencies, from its impulse response. */
function responseDb(mod, p, sr, freqs, N = 32768) {
  const imp = new Float32Array(N)
  imp[0] = 1
  const out = mod.process({ sr, ch: [imp] }, resolveParams(mod, p), ctx(1, sr)).ch[0]
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let i = 0; i < N; i++) re[i] = out[i]
  cfft(re, im)
  return freqs.map((f) => {
    const k = Math.round((f * N) / sr)
    return 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-30)
  })
}

/** Goertzel power of a whole signal at one frequency (normalised). */
function tonePow(x, f, sr) {
  const w = (2 * Math.PI * f) / sr
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length)
}

/** Per-frame mean square of a band (Hz lo..hi), 4th-order Butterworth band edges. */
function bandFrames(x, sr, lo, hi, hop) {
  const y = new Float32Array(x)
  if (lo > 0) {
    new Biquad('highpass', sr, lo, 0.7071).run(y)
    new Biquad('highpass', sr, lo, 0.7071).run(y)
  }
  if (hi < sr / 2) {
    new Biquad('lowpass', sr, hi, 0.7071).run(y)
    new Biquad('lowpass', sr, hi, 0.7071).run(y)
  }
  const nf = Math.floor(y.length / hop)
  const o = new Float64Array(nf)
  for (let f = 0; f < nf; f++) {
    let e = 0
    for (let i = 0; i < hop; i++) e += y[f * hop + i] * y[f * hop + i]
    o[f] = e / hop
  }
  return o
}

const dB = (v) => 10 * Math.log10(v + 1e-30)
const median = (a) => {
  const s = Array.from(a).sort((p, q) => p - q)
  return s.length ? s[s.length >> 1] : 0
}
const pct = (a, q) => {
  const s = Array.from(a).sort((p, r) => p - r)
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0
}

function addNoise(sig, levelDb, seed, color = 'white') {
  const n = sig.length
  const nz = noiseBuf(48000, n / 48000, color, seed).ch[0]
  let e = 0
  for (let i = 0; i < n; i++) e += nz[i] * nz[i]
  const g = Math.pow(10, levelDb / 20) / Math.sqrt(e / n)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = sig[i] + nz[i] * g
  return out
}

// shared fixtures
const V48 = voice(48000, 2)
const ST48 = stereoVoice(48000, 2)
const LONG = voice(48000, 30, { f0: 150 })

// ---------------------------------------------------------------- 1. shape

describe('tone modules: shape', () => {
  for (const id of IDS) {
    test(id + ' passes the module shape check', () => {
      const m = M[id]
      assert.deepEqual(validateModuleShape(m), [])
      assert.equal(m.id, 'tone.' + id)
      assert.equal(m.family, 'tone')
      assert.equal(m.warps, false)
      for (const p of m.params) assert.equal(typeof speakValue(p, p.def), 'string')
    })
  }
  test('cleanup tools stay out of Surprise me', () => {
    for (const id of CLEANUP) assert.equal(M[id].surprise, false, id)
  })
  test('the eleven live modules have live versions, the others do not', () => {
    for (const id of IDS) {
      const has = !!M[id].live
      assert.equal(has, LIVE.includes(id), id)
      if (has) {
        assert.equal(typeof M[id].live.create, 'function')
        const lat = M[id].live.latency(resolveParams(M[id], {}), 48000)
        assert.ok(Number.isInteger(lat) && lat >= 0 && lat < 480, id + ' latency ' + lat)
      }
    }
  })
})

// ---------------------------------------------------------------- 2. robustness

function paramSets(mod) {
  const sets = [{}]
  const lo = {}
  const hi = {}
  for (const p of mod.params) {
    if (p.type === 'number') {
      lo[p.id] = p.min
      hi[p.id] = p.max
    } else if (p.type === 'bool') {
      lo[p.id] = false
      hi[p.id] = true
    }
  }
  sets.push(lo, hi)
  for (const p of mod.params) {
    if (p.type === 'choice') for (const o of p.options) sets.push({ [p.id]: o.v })
    if (p.type === 'choice') for (const o of p.options) sets.push({ ...hi, [p.id]: o.v })
  }
  return sets
}

describe('tone modules: robustness', () => {
  const click = impulse(48000, 1, 0.5, 1)
  const empty = { sr: 48000, ch: [new Float32Array(0)] }
  const emptyStereo = { sr: 48000, ch: [new Float32Array(0), new Float32Array(0)] }
  for (const id of IDS) {
    test(id + ': empty, silence, click, stereo speech, every setting', () => {
      const m = M[id]
      for (const b of [empty, emptyStereo]) {
        const o = run(m, b)
        assert.equal(o.ch.length, b.ch.length)
        assert.equal(o.ch[0].length, 0)
      }
      for (const b of [silence(48000, 1), click, silence(48000, 0.5, 2)]) {
        const o = run(m, b)
        assertSane(o)
        assert.equal(o.ch.length, b.ch.length)
        assert.equal(o.ch[0].length, b.ch[0].length)
      }
      const short = { sr: 48000, ch: [V48.ch[0].slice(0, 9600)] }
      const shortSt = { sr: 48000, ch: ST48.ch.map((c) => c.slice(0, 24000)) }
      for (const p of paramSets(m)) {
        for (const b of [short, shortSt]) {
          const o = run(m, b, p)
          assertSane(o)
          assert.equal(o.ch.length, b.ch.length, id + ' ' + JSON.stringify(p))
          assert.equal(o.ch[0].length, b.ch[0].length)
        }
      }
      const o2 = run(m, { sr: 48000, ch: [new Float32Array(37).fill(0.5)] })
      assertSane(o2)
    })
    test(id + ': 30 s of speech at defaults', () => {
      const o = run(M[id], LONG)
      assertSane(o)
      assert.equal(o.ch[0].length, LONG.ch[0].length)
    })
    test(id + ': 8, 22.05, 44.1 and 96 kHz', () => {
      for (const sr of [8000, 22050, 44100, 96000]) {
        const v = voice(sr, 1)
        const o = run(M[id], v)
        assertSane(o)
        assert.equal(o.ch[0].length, v.ch[0].length)
        if (M[id].live) {
          const lv = runLive(M[id], v, {}, { blocks: [128, 333] })
          assertSane(lv)
        }
      }
    })
    test(id + ': deterministic', () => {
      const a = run(M[id], ST48, {}, 5)
      const b = run(M[id], ST48, {}, 5)
      assert.equal(maxDiff(a, b), 0)
    })
  }
})

// ---------------------------------------------------------------- 3. live

describe('tone modules: live', () => {
  const exact = {
    eq: { band3Gain: 6, band3Freq: 1200, band5Type: 'notch', band5Freq: 4000 },
    tilt: { amount: -5, slope: 'steep' },
    filter: { type: 'bandpass', sweep: 'lfo', rate: 1.3, resonance: 60 },
    character: { shape: 'phone' },
    deess: { threshold: -36 },
    gain: { db: -7, invert: true },
    mono: { mode: 'swap' },
    dehum: { mains: '60' },
  }
  // tilt and character match the take's loudness offline (one constant
  // gain live cannot know ahead), so for them the shape is compared after
  // fitting that gain
  const scaled = { tilt: true, character: true }
  for (const id of Object.keys(exact)) {
    test(id + ': live equals offline for any block size, aliased or not', () => {
      // (the live loudness match of tilt and character makes its first move
      // after 100 ms, at the start of the block that completes that window,
      // so for them the first 4096 samples are compared)
      const head = (x) => (scaled[id] ? { sr: x.sr, ch: x.ch.map((c) => c.slice(0, 4096)) } : x)
      for (const b of [V48, ST48]) {
        const off = head(run(M[id], b, exact[id], 3))
        for (const blocks of [[128], [480], [37, 128, 500, 1]]) {
          for (const alias of [true, false]) {
            const lv = head(runLive(M[id], b, exact[id], { blocks, alias, seed: 3 }))
            const d = scaled[id] ? maxDiffScaled(off, lv) : maxDiff(off, lv)
            assert.ok(d <= 1e-5, id + ' blocks ' + blocks + ' alias ' + alias + ' diff ' + d)
          }
        }
      }
    })
  }
  test('every live module gives the same samples whatever the block size (defaults, adaptive parts included)', () => {
    const v4 = voice(48000, 4, { f0: 150 })
    const hum = { sr: 48000, ch: [v4.ch[0].map((x, i) => x + 0.02 * Math.sin((2 * Math.PI * 50 * i) / 48000))] }
    for (const id of LIVE) {
      for (const b of [id === 'dehum' ? hum : v4, ST48]) {
        const a = runLive(M[id], b, {}, { blocks: [128] })
        for (const blocks of [[480], [37, 1000, 3]]) {
          const c = runLive(M[id], b, {}, { blocks })
          assert.ok(maxDiff(a, c) <= 1e-6, id + ' ' + blocks + ' diff ' + maxDiff(a, c))
        }
      }
    }
  })
  test('character without steady volume: live equals offline exactly', () => {
    const p = { shape: 'nasal', steady: false }
    const off = run(M.character, ST48, p)
    const lv = runLive(M.character, ST48, p, { blocks: [480, 7] })
    assert.ok(maxDiff(off, lv) <= 1e-6)
  })
  test('filter: drift and envelope sweeps also match live with the same seed', () => {
    for (const sweep of ['drift', 'envup', 'envdown']) {
      const p = { sweep, rate: 2, range: 80 }
      const off = run(M.filter, V48, p, 9)
      const lv = runLive(M.filter, V48, p, { blocks: [128, 77], seed: 9 })
      assert.ok(maxDiff(off, lv) <= 1e-6, sweep)
    }
  })
  test('gate: live equals offline delayed by the reported latency', () => {
    const p = { auto: false, threshold: -40 }
    const b = { sr: 48000, ch: [addNoise(V48.ch[0], -60, 4)] }
    const lat = M.gate.live.latency(resolveParams(M.gate, p), 48000)
    assert.ok(lat > 0)
    const off = run(M.gate, b, p)
    const lv = runLive(M.gate, b, p, { blocks: [128, 480, 19] })
    assert.ok(maxDiff(off, lv, lat) <= 1e-6, 'diff ' + maxDiff(off, lv, lat))
  })
  test('compress: live equals offline delayed by the reported latency, any block size, aliased or not', () => {
    // the backstop limiter's lookahead is the only delay; the hot setting makes it work
    for (const p of [{ threshold: -30, ratio: 6, mix: 70 }, { threshold: 0, ratio: 1, makeup: 24 }]) {
      const lat = M.compress.live.latency(resolveParams(M.compress, p), 48000)
      assert.ok(lat > 0 && lat < 480, 'latency ' + lat)
      for (const b of [V48, ST48]) {
        const off = run(M.compress, b, p, 3)
        for (const blocks of [[128], [480], [37, 128, 500, 1]]) {
          for (const alias of [true, false]) {
            const lv = runLive(M.compress, b, p, { blocks, alias, seed: 3 })
            const d = maxDiff(off, lv, lat)
            assert.ok(d <= 1e-5, 'blocks ' + blocks + ' alias ' + alias + ' diff ' + d)
          }
        }
      }
    }
  })
  test('broadcast: live settles to the offline sound (same level, peaks held)', () => {
    const b = voice(48000, 8, { f0: 130 })
    const off = run(M.broadcast, b)
    const lv = runLive(M.broadcast, b, {}, { blocks: [480] })
    const lat = M.broadcast.live.latency(resolveParams(M.broadcast, {}), 48000)
    const tail = (x, s) => ({ sr: 48000, ch: [x.ch[0].slice(4 * 48000 + s)] })
    assert.ok(Math.abs(lufs(tail(off, 0)) - lufs(tail(lv, lat))) < 1.5, lufs(tail(off, 0)) + ' vs ' + lufs(tail(lv, lat)))
    let pk = 0
    for (const v of lv.ch[0]) pk = Math.max(pk, Math.abs(v))
    assert.ok(pk <= Math.pow(10, -1 / 20) + 1e-6)
  })
  test('dehum: live finds 50 Hz hum on its own', () => {
    const n = 48000 * 4
    const x = new Float32Array(n)
    const v = voice(48000, 4).ch[0]
    for (let i = 0; i < n; i++) x[i] = v[i] + 0.03 * Math.sin((2 * Math.PI * 50 * i) / 48000) + 0.015 * Math.sin((2 * Math.PI * 150 * i) / 48000)
    const lv = runLive(M.dehum, mono(x, 48000), {}, { blocks: [480] })
    const lastIn = x.slice(2 * 48000)
    const lastOut = lv.ch[0].slice(2 * 48000)
    assert.ok(dB(tonePow(lastIn, 50, 48000)) - dB(tonePow(lastOut, 50, 48000)) > 20)
  })
  test('parameter changes mid-stream never click', () => {
    const tone = sine(48000, 1.2, 220, 0.3)
    const changes = {
      eq: [{ band2Gain: 12, band2Freq: 220, band6Gain: -12 }, { band2Type: 'notch', band2Freq: 300 }],
      tilt: [{ amount: -12 }, { amount: 12, slope: 'steep' }],
      filter: [{ freq: 300 }, { type: 'highpass', freq: 150 }],
      character: [{ shape: 'phone' }, { shape: 'boomy', amount: 50 }],
      compress: [{ threshold: -50, ratio: 20 }, { makeup: 12 }],
      broadcast: [{ density: 100 }, { style: 'late' }],
      deess: [{ freq: 3000, threshold: -40 }],
      gate: [{ reduce: 80 }, { auto: false, threshold: -20 }],
      gain: [{ db: 12 }, { invert: true }],
      mono: [{ mode: 'left' }],
      dehum: [{ mains: '50' }, { harmonics: 30, width: 8 }],
    }
    for (const id of LIVE) {
      const b = id === 'mono' ? { sr: 48000, ch: [tone.ch[0], new Float32Array(tone.ch[0].length)] } : tone
      const seq = changes[id].map((p, k) => ({ at: 19200 + k * 9600, p }))
      const lv = runLive(M[id], b, {}, { blocks: [128], changes: seq })
      assertSane(lv)
      const y = lv.ch[0]
      const stepMax = (a, z) => {
        let m = 0
        for (let i = a + 1; i < z; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1]))
        return m
      }
      for (const c of seq) {
        const before = stepMax(c.at - 4800, c.at - 64)
        const after = stepMax(c.at + 4800, c.at + 9000)
        const during = stepMax(c.at - 64, c.at + 2400)
        assert.ok(during <= 1.6 * Math.max(before, after) + 2e-3, id + ' ' + JSON.stringify(c.p) + ' step ' + during.toFixed(4) + ' vs ' + before.toFixed(4) + '/' + after.toFixed(4))
      }
    }
  })
})

// ---------------------------------------------------------------- 4. prove it

describe('tone.eq', () => {
  const sr = 48000
  const qOf = (s) => 0.25 * Math.pow(2, (6 * s) / 100)
  const freqs = [30, 60, 100, 200, 400, 700, 1000, 1500, 2500, 4000, 6000, 9000, 13000, 17000]
  test('response matches the cookbook within 1 dB (custom bands)', () => {
    const p = {
      band1Type: 'lowshelf', band1Freq: 120, band1Gain: 6, band1Q: 25,
      band2Type: 'bell', band2Freq: 500, band2Gain: -9, band2Q: 50,
      band3Type: 'bell', band3Freq: 1500, band3Gain: 7.5, band3Q: 20,
      band4Type: 'notch', band4Freq: 3000, band4Q: 60,
      band5Type: 'highcut', band5Freq: 12000, band5Q: 25,
      band6Type: 'off', output: 0,
    }
    const ref = [
      new Biquad('lowshelf', sr, 120, qOf(25), 6),
      new Biquad('peak', sr, 500, qOf(50), -9),
      new Biquad('peak', sr, 1500, qOf(20), 7.5),
      new Biquad('notch', sr, 3000, qOf(60)),
      new Biquad('lowpass', sr, 12000, qOf(25)),
    ]
    const meas = responseDb(M.eq, p, sr, freqs)
    freqs.forEach((f, i) => {
      if (Math.abs(f - 3000) < 400) return // the notch bottom is too deep to compare in dB
      const want = ref.reduce((s, b) => s + b.magnitudeDb(f), 0)
      assert.ok(Math.abs(meas[i] - want) < 1, f + ' Hz: ' + meas[i].toFixed(2) + ' vs ' + want.toFixed(2))
    })
  })
  test('the default voice polish: low cut, less mud, presence, air', () => {
    const [d30, d250, d3k, d15k, d1k] = responseDb(M.eq, {}, sr, [30, 250, 3000, 15000, 1000])
    assert.ok(d30 < -12, 'low cut ' + d30)
    assert.ok(d250 < -1 && d250 > -3, 'mud ' + d250)
    assert.ok(d3k > 1 && d3k < 3.5, 'presence ' + d3k)
    assert.ok(d15k > 2 && d15k < 4.5, 'air ' + d15k)
    assert.ok(Math.abs(d1k) < 1, 'middle ' + d1k)
  })
  test('flat settings are a straight wire, output volume is exact', () => {
    const flat = { band1Type: 'off', band2Gain: 0, band4Gain: 0, band6Gain: 0 }
    const o = run(M.eq, V48, flat)
    assert.ok(maxDiff(o, V48) < 1e-6)
    const o2 = run(M.eq, V48, { ...flat, output: -6 })
    assert.ok(Math.abs(rmsDb(o2) - rmsDb(V48) + 6) < 0.01)
  })
  test('bands above what 8 kHz can carry do nothing strange', () => {
    const v = voice(8000, 1)
    const o = run(M.eq, v, { band6Type: 'highshelf', band6Freq: 15000, band6Gain: 24 })
    assertSane(o)
    assert.ok(Math.abs(rmsDb(o) - rmsDb(run(M.eq, v, { band6Gain: 0 }))) < 0.5)
  })
})

describe('tone.tilt', () => {
  test('see-saws around the pivot', () => {
    // the overall level is matched afterwards, so the shape is read
    // relative to the pivot
    for (const slope of ['gentle', 'steep']) {
      const [lo, piv, hi] = responseDb(M.tilt, { amount: 6, pivot: 1000, slope }, 48000, [30, 1000, 18000])
      assert.ok(lo - piv < -4.5 && lo - piv > -6.6, slope + ' lows ' + (lo - piv))
      assert.ok(hi - piv > 4.5 && hi - piv < 6.6, slope + ' highs ' + (hi - piv))
    }
    const [lo2, piv2, hi2] = responseDb(M.tilt, { amount: -8 }, 48000, [30, 900, 18000])
    assert.ok(lo2 - piv2 > 5 && hi2 - piv2 < -5, 'darker ' + lo2 + ' ' + hi2)
  })
  test('brightens or darkens speech while the loudness stays put', () => {
    for (const b of [V48, ...REAL]) {
      const o = run(M.tilt, b)
      assert.ok(spectralCentroid(o.ch[0], b.sr) > spectralCentroid(b.ch[0], b.sr) * 1.05)
      assert.ok(Math.abs(lufs(o) - lufs(b)) < 0.1)
      const d = run(M.tilt, b, { amount: -10 })
      assert.ok(spectralCentroid(d.ch[0], b.sr) < spectralCentroid(b.ch[0], b.sr) * 0.8)
      assert.ok(Math.abs(lufs(d) - lufs(b)) < 0.1)
    }
  })
  test('live matches the loudness as you talk', () => {
    const v6 = voice(48000, 6, { f0: 150 })
    const tail = (x) => ({ sr: x.sr, ch: x.ch.map((c) => c.slice(3 * x.sr)) })
    for (const b of [v6, ...REAL]) {
      for (const amount of [-12, -6, 6, 12]) {
        const lv = runLive(M.tilt, b, { amount }, { blocks: [480] })
        const d = lufs(tail(lv)) - lufs(tail(b))
        assert.ok(Math.abs(d) < 1, amount + ': ' + d.toFixed(2))
      }
    }
  })
})

describe('tone.filter', () => {
  const sr = 48000
  test('low pass, high pass, band pass and notch cut where they should', () => {
    const [a200, a1k, a4k] = responseDb(M.filter, { type: 'lowpass', freq: 1000, resonance: 0 }, sr, [200, 1000, 4000])
    assert.ok(a200 > -1.5 && a4k < a200 - 40, 'low pass ' + a200 + ' ' + a4k)
    assert.ok(a1k < -2 && a1k > -9, 'cutoff ' + a1k)
    const [h200, h4k] = responseDb(M.filter, { type: 'highpass', freq: 1000, resonance: 0 }, sr, [200, 4000])
    assert.ok(h4k > -1.5 && h200 < h4k - 40, 'high pass ' + h200 + ' ' + h4k)
    const [b250, b1k, b4k] = responseDb(M.filter, { type: 'bandpass', freq: 1000, resonance: 50, slope: 'gentle' }, sr, [250, 1000, 4000])
    assert.ok(Math.abs(b1k) < 0.5 && b250 < -10 && b4k < -10, 'band pass ' + b250 + ' ' + b1k + ' ' + b4k)
    const [n500, n1k, n2k] = responseDb(M.filter, { type: 'notch', freq: 1000, resonance: 40 }, sr, [500, 1000, 2000])
    assert.ok(n1k < -30 && n500 > -3 && n2k > -3, 'notch ' + n500 + ' ' + n1k + ' ' + n2k)
  })
  test('resonance makes a peak at the cutoff', () => {
    const [soft] = responseDb(M.filter, { type: 'lowpass', freq: 1000, resonance: 0, slope: 'gentle' }, sr, [1000])
    const [res] = responseDb(M.filter, { type: 'lowpass', freq: 1000, resonance: 80, slope: 'gentle' }, sr, [1000])
    assert.ok(res > soft + 15, soft + ' -> ' + res)
  })
  test('a slow sweep moves the sound at its rate', () => {
    const nz = noiseBuf(sr, 6, 'white', 3, 1, 0.2)
    const o = run(M.filter, nz, { type: 'bandpass', freq: 1000, resonance: 60, sweep: 'lfo', rate: 0.5, range: 80, slope: 'gentle' })
    // centroid every 50 ms, then the strongest period in its autocorrelation
    const hop = 2400
    const cs = []
    for (let i = 0; i + 4096 <= o.ch[0].length; i += hop) cs.push(spectralCentroid(o.ch[0].subarray(i, i + 4096), sr))
    const mu = cs.reduce((s, v) => s + v, 0) / cs.length
    const d = cs.map((v) => v - mu)
    let best = 0
    let bestLag = 0
    for (let lag = 10; lag < 70; lag++) {
      let s = 0
      for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag]
      if (s > best) {
        best = s
        bestLag = lag
      }
    }
    const period = (bestLag * hop) / sr
    assert.ok(Math.abs(period - 2) < 0.25, 'period ' + period)
  })
  test('opens as you talk: brighter on loud parts than when still', () => {
    const still = run(M.filter, V48, { freq: 500 })
    const env = run(M.filter, V48, { freq: 500, sweep: 'envup', range: 80 })
    assert.ok(spectralCentroid(env.ch[0], sr) > spectralCentroid(still.ch[0], sr) * 1.4)
  })
  test('mix 0 is the dry voice', () => {
    assert.ok(maxDiff(run(M.filter, V48, { mix: 0 }), V48) < 1e-6)
  })
})

describe('tone.character', () => {
  const sr = 48000
  const nz = noiseBuf(sr, 4, 'pink', 8, 1, 0.1)
  const bands = (b) => ({ lo: bandEnergyDb(b.ch[0], sr, 60, 200), mid: bandEnergyDb(b.ch[0], sr, 800, 1500), hi: bandEnergyDb(b.ch[0], sr, 6000, 12000) })
  const ref = bands(nz)
  const rel = (b) => {
    const x = bands(b)
    return { lo: x.lo - x.mid - (ref.lo - ref.mid), hi: x.hi - x.mid - (ref.hi - ref.mid) }
  }
  test('each colour moves the spectrum the right way', () => {
    const phone = rel(run(M.character, nz, { shape: 'phone', steady: false }))
    assert.ok(phone.lo < -20 && phone.hi < -20, 'telephone ' + JSON.stringify(phone))
    const muff = rel(run(M.character, nz, { shape: 'muffled' }))
    assert.ok(muff.hi < -25, 'muffled ' + JSON.stringify(muff))
    const bright = rel(run(M.character, nz, { shape: 'bright' }))
    assert.ok(bright.hi > 4, 'bright ' + JSON.stringify(bright))
    const boomy = rel(run(M.character, nz, { shape: 'boomy' }))
    assert.ok(boomy.lo > 6, 'boomy ' + JSON.stringify(boomy))
    const thin = rel(run(M.character, nz, { shape: 'thin' }))
    assert.ok(thin.lo < -12, 'thin ' + JSON.stringify(thin))
    const dark = rel(run(M.character, nz, { shape: 'dark' }))
    assert.ok(dark.hi < -8, 'dark ' + JSON.stringify(dark))
    const radio = rel(run(M.character, nz, { shape: 'radio' }))
    assert.ok(radio.hi > 1, 'radio ' + JSON.stringify(radio))
  })
  test('keep the volume steady holds the loudness of every colour', () => {
    for (const b of [V48, ...REAL]) {
      for (const o0 of M.character.params[0].options) {
        const o = run(M.character, b, { shape: o0.v })
        assert.ok(Math.abs(lufs(o) - lufs(b)) < 0.1, o0.v + ' ' + (lufs(o) - lufs(b)).toFixed(2))
      }
    }
    // live has no look ahead: it starts from an estimate and matches as you talk
    const v6 = voice(48000, 6, { f0: 150 })
    const tail = (x) => ({ sr: x.sr, ch: x.ch.map((c) => c.slice(3 * x.sr)) })
    for (const o0 of M.character.params[0].options) {
      const lv = runLive(M.character, v6, { shape: o0.v }, { blocks: [480] })
      const d = lufs(tail(lv)) - lufs(tail(v6))
      assert.ok(Math.abs(d) < 1.5, 'live ' + o0.v + ' ' + d.toFixed(2))
    }
  })
  test('strength 0 is flat, half strength is in between', () => {
    assert.ok(maxDiff(run(M.character, V48, { shape: 'boomy', amount: 0 }), V48) < 1e-6)
    const full = rel(run(M.character, nz, { shape: 'boomy', amount: 100, steady: false })).lo
    const half = rel(run(M.character, nz, { shape: 'boomy', amount: 50, steady: false })).lo
    assert.ok(half > 0.3 * full && half < 0.7 * full, half + ' of ' + full)
  })
})

describe('tone.compress', () => {
  const sr = 48000
  test('follows its static curve on a steady tone', () => {
    const s = sine(sr, 1.5, 1000, 0.5)
    const o = run(M.compress, s, { threshold: -24, ratio: 4, knee: 0, autoMakeup: false, makeup: 0, attack: 5, release: 100 })
    const tail = o.ch[0].subarray(sr, Math.round(1.5 * sr))
    const lvl = rmsDb(tail)
    const inLvl = 20 * Math.log10(0.5) - 3.0103
    const want = inLvl - (1 - 1 / 4) * (inLvl + 24)
    assert.ok(Math.abs(lvl - want) < 0.7, lvl.toFixed(2) + ' vs ' + want.toFixed(2))
    const below = run(M.compress, sine(sr, 1, 1000, 0.01), { threshold: -24, knee: 0, autoMakeup: false })
    assert.ok(Math.abs(rmsDb(below.ch[0].subarray(sr / 2)) - rmsDb(sine(sr, 1, 1000, 0.01).ch[0].subarray(sr / 2))) < 0.05)
  })
  test('evens out speech: smaller spread between loud and quiet parts', () => {
    const spread = (x) => {
      const fr = bandFrames(x, sr, 0, sr / 2, 1440)
      const mx = Math.max(...fr)
      const act = Array.from(fr).filter((v) => v > mx * 1e-3).map(dB)
      const mu = act.reduce((s, v) => s + v, 0) / act.length
      return Math.sqrt(act.reduce((s, v) => s + (v - mu) * (v - mu), 0) / act.length)
    }
    const o = run(M.compress, V48, { threshold: -30, ratio: 4 })
    assert.ok(spread(o.ch[0]) < spread(V48.ch[0]) - 1, spread(V48.ch[0]).toFixed(2) + ' -> ' + spread(o.ch[0]).toFixed(2))
  })
  test('automatic makeup keeps the loud parts about as loud', () => {
    const o = run(M.compress, V48)
    assert.ok(Math.abs(lufs(o) - lufs(V48)) < 4, (lufs(o) - lufs(V48)).toFixed(2))
  })
  test('mix 0 is the dry voice; stereo is linked', () => {
    assert.ok(maxDiff(run(M.compress, V48, { mix: 0 }), V48) < 1e-6)
    const dual = { sr, ch: [new Float32Array(V48.ch[0]), new Float32Array(V48.ch[0])] }
    const o = run(M.compress, dual, { threshold: -40, ratio: 10 })
    assert.ok(maxDiff({ sr, ch: [o.ch[0]] }, { sr, ch: [o.ch[1]] }) === 0)
  })
  // fix round: automatic makeup used to stack on the manual makeup without limit
  const HOT = { threshold: -51, ratio: 15.75, attack: 76, release: 780, knee: 19.5, makeup: 18 }
  const gainOnQuietTone = (p) => {
    // a steady tone far under the threshold gets no reduction, so its gain is the makeup
    const s = sine(sr, 1, 500, 0.0003) // about -73 dB, under every threshold and knee

    const o = run(M.compress, s, p)
    return rmsDb(o.ch[0].subarray(sr / 2)) - rmsDb(s.ch[0].subarray(sr / 2))
  }
  test('automatic and manual makeup add up, but never past 24 dB', () => {
    // defaults: automatic 6 dB (3:1 from -24 dB, given back at -15 dB) plus a 6 dB trim
    const both = gainOnQuietTone({ makeup: 6 })
    assert.ok(Math.abs(both - 12) < 0.1, 'defaults plus 6 dB: ' + both.toFixed(2))
    const trim = gainOnQuietTone({ makeup: -6 })
    assert.ok(Math.abs(trim - 0) < 0.1, 'defaults minus 6 dB: ' + trim.toFixed(2))
    // the integrator's setting asked for about 34 dB automatic plus 18 dB manual
    const hot = gainOnQuietTone(HOT)
    assert.ok(Math.abs(hot - 24) < 0.1, 'hot setting: ' + hot.toFixed(2))
    const most = gainOnQuietTone({ threshold: -60, ratio: 20, knee: 0, makeup: 24 })
    assert.ok(Math.abs(most - 24) < 0.1, 'every knob at its far end: ' + most.toFixed(2))
    const manual = gainOnQuietTone({ autoMakeup: false, makeup: 24 })
    assert.ok(Math.abs(manual - 24) < 0.1, 'manual 24 dB alone: ' + manual.toFixed(2))
  })
  const sane = (label, input, o, maxLift) => {
    let pk = 0
    for (const c of o.ch) for (const v of c) pk = Math.max(pk, Math.abs(v))
    // the backstop ceiling is +6 dBFS (2.0), well under the 4.0 soft ceiling of every stage
    assert.ok(pk <= 2 + 1e-6, label + ': peak ' + pk.toFixed(3))
    // no flat tops: no run of 4 equal samples above half the peak
    let run4 = 0
    const x = o.ch[0]
    for (let i = 1; i < x.length; i++) {
      run4 = x[i] === x[i - 1] && Math.abs(x[i]) > 0.5 * pk ? run4 + 1 : 0
      assert.ok(run4 < 3, label + ': flat top at sample ' + i)
    }
    const lift = lufs(o) - lufs(input)
    assert.ok(lift < maxLift && lift > -16, label + ': loudness change ' + lift.toFixed(2) + ' dB')
  }
  test('the integrator setting on speech: no distortion, no 20 dB jump in level', () => {
    const takes = [...REAL, V48]
    for (const t of takes) {
      sane('hot ' + t.sr, t, run(M.compress, t, HOT), 6)
      sane('far ends ' + t.sr, t, run(M.compress, t, { threshold: -60, ratio: 20, attack: 100, release: 1000, knee: 0, makeup: 24 }), 6)
      // makeup used as a plain 24 dB boost: the backstop holds it clean
      sane('boost ' + t.sr, t, run(M.compress, t, { threshold: 0, ratio: 1, makeup: 24 }), 25)
    }
  })
  test('a word after a long pause punches by at most about 15 dB, whatever the attack', () => {
    // 3 s of quiet room noise, then a hard cut straight into a sustained
    // vowel-like tone (ten harmonics of 140 Hz)
    const pre = 3 * sr
    const take = (peakLin) => {
      const len = Math.round(1.5 * sr)
      const x = new Float32Array(pre + len)
      const nz = noiseBuf(sr, 3, 'white', 5).ch[0]
      for (let i = 0; i < pre; i++) x[i] = nz[i] * 0.0003
      let vr = 0
      for (let i = 0; i < len; i++) {
        let v = 0
        for (let k = 1; k <= 10; k++) v += Math.sin((2 * Math.PI * 140 * k * i) / sr) / k
        x[pre + i] = v
        vr = Math.max(vr, Math.abs(v))
      }
      for (let i = 0; i < len; i++) x[pre + i] *= peakLin / vr
      return mono(x, sr)
    }
    // at -20 dBFS the backstop never acts, so this measures the catch alone
    // (without it the first 25 ms came out 22 to 28 dB over the settled level)
    const quiet = take(0.1)
    for (const attack of [30, 50, 100]) {
      const o = run(M.compress, quiet, { threshold: -60, ratio: 10, attack, release: 300 })
      const y = o.ch[0]
      const lvl = (a, z) => rmsDb(y.subarray(pre + Math.round(a * sr), pre + Math.round(z * sr)))
      const jump = lvl(0.003, 0.025) - lvl(0.8, 1.4)
      assert.ok(jump < 17, 'attack ' + attack + ': the first 25 ms are ' + jump.toFixed(1) + ' dB over the settled level')
      sane('long pause, attack ' + attack, quiet, o, 12)
    }
    // a hot take: catch and backstop together keep it clean
    const hot = take(0.6)
    for (const attack of [50, 100]) sane('hot long pause, attack ' + attack, hot, run(M.compress, hot, { threshold: -40, ratio: 10, attack, release: 300 }), 12)
  })
})

describe('tone.broadcast', () => {
  const sr = 48000
  const v = voice(sr, 8, { f0: 125 })
  const plr = (b) => {
    let pk = 0
    for (const c of b.ch) for (const x of c) pk = Math.max(pk, Math.abs(x))
    return 20 * Math.log10(pk) - lufs(b)
  }
  const scaled = (b, db) => ({ sr: b.sr, ch: b.ch.map((c) => c.map((x) => x * Math.pow(10, db / 20))) })
  test('denser and louder: peak-to-loudness ratio drops, peaks held at -1 dBFS', () => {
    const o = run(M.broadcast, v)
    assert.ok(plr(o) < plr(v) - 2, plr(v).toFixed(1) + ' -> ' + plr(o).toFixed(1))
    let pk = 0
    for (const x of o.ch[0]) pk = Math.max(pk, Math.abs(x))
    assert.ok(pk <= Math.pow(10, -1 / 20) + 1e-6, 'peak ' + pk)
    assert.ok(lufs(o) > -16, 'loudness ' + lufs(o))
  })
  test('works the same on a quiet take and a hot take', () => {
    const q = run(M.broadcast, scaled(v, -15))
    const h = run(M.broadcast, scaled(v, 6))
    assert.ok(Math.abs(lufs(q) - lufs(h)) < 1.5, lufs(q).toFixed(2) + ' vs ' + lufs(h).toFixed(2))
  })
  test('density turns it up from a light polish to a squeeze', () => {
    const lo = run(M.broadcast, v, { density: 0 })
    const hi = run(M.broadcast, v, { density: 100 })
    assert.ok(lufs(hi) > lufs(lo) + 2, lufs(lo).toFixed(1) + ' -> ' + lufs(hi).toFixed(1))
    assert.ok(plr(hi) < plr(lo) - 2)
  })
  test('every station sound renders, and real speech gets denser', () => {
    for (const style of ['announcer', 'talk', 'news', 'late', 'sports', 'podcast']) assertSane(run(M.broadcast, V48, { style }))
    for (const b of REAL) {
      const o = run(M.broadcast, b)
      assert.ok(plr(o) < plr(b) - 3, plr(b).toFixed(1) + ' -> ' + plr(o).toFixed(1))
    }
  })
})

describe('tone.deess', () => {
  function sibStats(x, out, sr, sibRatio = 0.5) {
    const hop = Math.round(0.01 * sr)
    const all = bandFrames(x, sr, 0, sr / 2, hop)
    const inHi = bandFrames(x, sr, 4500, Math.min(11500, 0.45 * sr), hop)
    const outHi = bandFrames(out, sr, 4500, Math.min(11500, 0.45 * sr), hop)
    const inLo = bandFrames(x, sr, 0, 3000, hop)
    const outLo = bandFrames(out, sr, 0, 3000, hop)
    const mx = Math.max(...all)
    const sib = []
    const vowelLo = []
    const cut = []
    for (let i = 0; i < all.length; i++) {
      if (all[i] < mx * 1e-4) continue
      const r = inHi[i] / all[i]
      const c = dB(inHi[i]) - dB(outHi[i])
      cut.push(c)
      if (r > sibRatio) sib.push(c)
      if (r < 0.05) vowelLo.push(Math.abs(dB(inLo[i]) - dB(outLo[i])))
    }
    return { sib, vowelLo, cut }
  }
  test('harsh s sounds are cut, soft ones barely, vowels untouched, never past the range', () => {
    const v = voice(48000, 12, { f0: 180 })
    // the synthetic voice's "s" is soft (about 34 dB under its loudest
    // frames); a +12 dB shelf above 4.5 kHz makes a harsh, hissy version
    const harsh = new Float32Array(v.ch[0])
    new Biquad('highshelf', 48000, 4500, 0.7071, 12).run(harsh)
    const soft = sibStats(v.ch[0], run(M.deess, v).ch[0], 48000, 0.3)
    const hard = sibStats(harsh, run(M.deess, mono(harsh, 48000)).ch[0], 48000, 0.3)
    assert.ok(soft.sib.length > 20 && hard.sib.length > 20)
    assert.ok(median(soft.sib) < 2.5, 'soft s cut ' + median(soft.sib))
    assert.ok(median(hard.sib) > 4, 'harsh s cut ' + median(hard.sib))
    assert.ok(median(hard.sib) > median(soft.sib) + 2)
    assert.ok(pct(hard.vowelLo, 0.9) < 0.5, 'vowels ' + pct(hard.vowelLo, 0.9))
    assert.ok(Math.max(...hard.cut) < 8 + 1, 'max ' + Math.max(...hard.cut))
  })
  test('real speech: gentle cut on s sounds, vowels untouched, the air above stays', () => {
    for (const b of REAL) {
      const o = run(M.deess, b)
      const s = sibStats(b.ch[0], o.ch[0], b.sr)
      assert.ok(median(s.sib) > 1.5, 'sibilant cut ' + median(s.sib))
      assert.ok(pct(s.vowelLo, 0.9) < 0.3, 'vowels ' + pct(s.vowelLo, 0.9))
      const air = (x) => bandFrames(x, b.sr, 10000, 11800, Math.round(0.01 * b.sr))
      const ai = air(b.ch[0])
      const ao = air(o.ch[0])
      let ei = 0
      let eo = 0
      for (let i = 0; i < ai.length; i++) {
        ei += ai[i]
        eo += ao[i]
      }
      assert.ok(dB(ei) - dB(eo) < 1.5, 'air cut ' + (dB(ei) - dB(eo)))
    }
  })
  test('hear what is removed is exactly the difference', () => {
    const o = run(M.deess, V48, { threshold: -40 })
    const r = run(M.deess, V48, { threshold: -40, listen: true })
    let m = 0
    for (let i = 0; i < o.ch[0].length; i++) m = Math.max(m, Math.abs(o.ch[0][i] + r.ch[0][i] - V48.ch[0][i]))
    assert.ok(m < 1e-5, 'difference ' + m)
    assert.ok(rmsDb(r) > -80, 'something was removed')
  })
})

describe('tone.gate', () => {
  const sr = 48000
  // four short phrases with 0.6 s pauses between them, hiss under everything
  const gaps = []
  const parts = []
  let len = 0
  for (let k = 0; k < 4; k++) {
    const ph = synthVoice(sr, 1.2, { seed: 50 + k, f0: 140 }).ch[0]
    parts.push(ph)
    len += ph.length
    const g = Math.round(0.6 * sr)
    gaps.push([len, len + g])
    parts.push(new Float32Array(g))
    len += g
  }
  const clean = new Float32Array(len)
  let off = 0
  for (const ph of parts) {
    clean.set(ph, off)
    off += ph.length
  }
  const noisy = addNoise(clean, -60, 21)
  function regions(out) {
    // pauses: the middle of each gap (hold and closing time legitimately keep
    // its first 200 ms open); words: frames with real speech energy
    let ip = 0
    let ep = 0
    for (const [a, b] of gaps) {
      for (let i = a + Math.round(0.2 * sr); i < b - Math.round(0.05 * sr); i++) {
        ip += noisy[i] * noisy[i]
        ep += out[i] * out[i]
      }
    }
    let is = 0
    let es = 0
    for (let s0 = 0; s0 + 480 <= len; s0 += 480) {
      let e = 0
      for (let i = s0; i < s0 + 480; i++) e += clean[i] * clean[i]
      if (e / 480 < 1e-3) continue
      for (let i = s0; i < s0 + 480; i++) {
        is += noisy[i] * noisy[i]
        es += out[i] * out[i]
      }
    }
    return { pauseDrop: dB(ip) - dB(ep), speechChange: dB(es) - dB(is) }
  }
  test('silences the pauses and leaves the words (automatic level)', () => {
    const r = regions(run(M.gate, mono(noisy, sr)).ch[0])
    assert.ok(r.pauseDrop > 30, 'pauses ' + r.pauseDrop)
    assert.ok(Math.abs(r.speechChange) < 1, 'speech ' + r.speechChange)
  })
  test('by hand too, and gentle settings leave room tone', () => {
    const r = regions(run(M.gate, mono(noisy, sr), { auto: false, threshold: -45 }).ch[0])
    assert.ok(r.pauseDrop > 30 && Math.abs(r.speechChange) < 1, JSON.stringify(r))
    const g = regions(run(M.gate, mono(noisy, sr), { reduce: 12 }).ch[0])
    assert.ok(g.pauseDrop > 11 && g.pauseDrop < 13, 'gentle ' + g.pauseDrop)
  })
  test('opens before a word starts: the first milliseconds of each phrase are kept', () => {
    const out = run(M.gate, mono(noisy, sr)).ch[0]
    for (const [, b] of gaps.slice(0, 3)) {
      let a = 0
      let o = 0
      // each phrase starts talking 60 ms in
      for (let i = b + Math.round(0.06 * sr); i < b + Math.round(0.09 * sr); i++) {
        a += noisy[i] * noisy[i]
        o += out[i] * out[i]
      }
      assert.ok(dB(a) - dB(o) < 1, 'onset cut ' + (dB(a) - dB(o)))
    }
  })
})

describe('tone.denoise', () => {
  const sr = 48000
  const v = voice(sr, 6, { f0: 160 })
  const clean = v.ch[0]
  function spikiness(x, mask) {
    // mean over bins of the std over time of the log periodogram (dB);
    // musical noise raises it, a plain quieter hiss does not
    const N = 1024
    const nb = N / 2 + 1
    const k0 = Math.round((500 * N) / sr)
    const k1 = Math.round((8000 * N) / sr)
    const sum = new Float64Array(nb)
    const sum2 = new Float64Array(nb)
    let cnt = 0
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let s = 0; s + N < x.length; s += N) {
      if (!mask(s, s + N)) continue
      for (let i = 0; i < N; i++) {
        re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N))
        im[i] = 0
      }
      cfft(re, im)
      for (let k = k0; k <= k1; k++) {
        const d = dB(re[k] * re[k] + im[k] * im[k])
        sum[k] += d
        sum2[k] += d * d
      }
      cnt++
    }
    let acc = 0
    for (let k = k0; k <= k1; k++) {
      const mu = sum[k] / cnt
      acc += Math.sqrt(Math.max(0, sum2[k] / cnt - mu * mu))
    }
    return { std: acc / (k1 - k0 + 1), frames: cnt }
  }
  function judge(cleanSig, noisy, out) {
    const pause = (s, t) => {
      let e = 0
      for (let i = s; i < t; i++) e += cleanSig[i] * cleanSig[i]
      return e / (t - s) < 1e-10
    }
    let a = 0
    let b = 0
    for (let s = 0; s + 480 <= cleanSig.length; s += 480) {
      if (!pause(s, s + 480)) continue
      for (let i = s; i < s + 480; i++) {
        a += noisy[i] * noisy[i]
        b += out[i] * out[i]
      }
    }
    return { drop: dB(a) - dB(b), spikIn: spikiness(noisy, pause), spikOut: spikiness(out, pause) }
  }
  test('lowers the noise floor by more than 6 dB without musical noise', () => {
    for (const [color, lvl] of [['white', -45], ['pink', -40]]) {
      const noisy = addNoise(clean, lvl, 31, color)
      const out = run(M.denoise, mono(noisy, sr)).ch[0]
      const j = judge(clean, noisy, out)
      assert.ok(j.spikIn.frames > 10)
      assert.ok(j.drop > 10, color + ' drop ' + j.drop.toFixed(1))
      assert.ok(j.spikOut.std < j.spikIn.std + 0.5, color + ' spikiness ' + j.spikIn.std.toFixed(2) + ' -> ' + j.spikOut.std.toFixed(2))
    }
  })
  test('keeps the words: speech error falls when the noise is strong', () => {
    const noisy = addNoise(clean, -32, 33)
    const out = run(M.denoise, mono(noisy, sr)).ch[0]
    let es = 0
    let ei = 0
    let eo = 0
    for (let i = 0; i < clean.length; i++) {
      if (Math.abs(clean[i]) < 0.02) continue
      es += clean[i] * clean[i]
      ei += (noisy[i] - clean[i]) ** 2
      eo += (out[i] - clean[i]) ** 2
    }
    assert.ok(dB(es / eo) > dB(es / ei) + 2, 'speech SNR ' + dB(es / ei).toFixed(1) + ' -> ' + dB(es / eo).toFixed(1))
  })
  test('every way of learning the noise works, and listen is the exact remainder', () => {
    const noisy = addNoise(clean, -45, 35)
    for (const learn of ['quiet', 'stretch', 'start', 'follow']) {
      const j = judge(clean, noisy, run(M.denoise, mono(noisy, sr), { learn }).ch[0])
      assert.ok(j.drop > 8, learn + ' drop ' + j.drop.toFixed(1))
    }
    const o = run(M.denoise, mono(noisy, sr)).ch[0]
    const r = run(M.denoise, mono(noisy, sr), { listen: true }).ch[0]
    let m = 0
    for (let i = 0; i < noisy.length; i++) m = Math.max(m, Math.abs(o[i] + r[i] - noisy[i]))
    assert.ok(m < 1e-4, 'remainder ' + m)
  })
  test('real speech in noise: floor drops, speech kept', () => {
    for (const b of REAL) {
      const n = b.ch[0].length
      const nz = noiseBuf(b.sr, n / b.sr, 'white', 41).ch[0]
      const noisy = new Float32Array(n)
      for (let i = 0; i < n; i++) noisy[i] = b.ch[0][i] + 0.003 * nz[i]
      const out = run(M.denoise, mono(noisy, b.sr)).ch[0]
      const j = judge(b.ch[0], noisy, out)
      assert.ok(j.drop > 10, 'drop ' + j.drop)
      assert.ok(j.spikOut.std < j.spikIn.std + 0.5)
      assert.ok(Math.abs(lufs(mono(out, b.sr)) - lufs(b)) < 1, 'loudness kept')
    }
  })
  test('stereo is linked: identical channels stay identical', () => {
    const noisy = addNoise(clean, -45, 37)
    const o = run(M.denoise, { sr, ch: [new Float32Array(noisy), new Float32Array(noisy)] })
    assert.equal(maxDiff({ sr, ch: [o.ch[0]] }, { sr, ch: [o.ch[1]] }), 0)
  })
})

describe('tone.dehum', () => {
  const sr = 48000
  const v = voice(sr, 6, { f0: 170 }).ch[0]
  function withHum(f0, amp) {
    const x = new Float32Array(v.length)
    for (let i = 0; i < v.length; i++) {
      let h = 0
      for (let k = 1; k <= 5; k++) h += (amp / k) * Math.sin((2 * Math.PI * f0 * k * i) / sr + k)
      x[i] = v[i] + h
    }
    return x
  }
  test('removes 60 Hz hum and its harmonics, voice band untouched', () => {
    const x = withHum(60, 0.03)
    const o = run(M.dehum, mono(x, sr), { mains: '60' }).ch[0]
    for (let k = 1; k <= 5; k++) {
      const cut = dB(tonePow(x, 60 * k, sr)) - dB(tonePow(o, 60 * k, sr))
      assert.ok(cut > 25, 60 * k + ' Hz cut ' + cut.toFixed(1))
    }
    const vb = bandEnergyDb(o, sr, 300, 3000) - bandEnergyDb(x, sr, 300, 3000)
    assert.ok(Math.abs(vb) < 0.5, 'voice band ' + vb)
  })
  test('finds the hum by itself, even a little off 50 Hz', () => {
    const x = withHum(49.8, 0.03)
    const o = run(M.dehum, mono(x, sr)).ch[0]
    for (let k = 1; k <= 3; k++) {
      const cut = dB(tonePow(x, 49.8 * k, sr)) - dB(tonePow(o, 49.8 * k, sr))
      assert.ok(cut > 20, 49.8 * k + ' Hz cut ' + cut.toFixed(1))
    }
  })
  test('says so when there is no hum', () => {
    const notes = []
    M.dehum.process(cloneBuf(voice(sr, 3)), resolveParams(M.dehum, {}), { ...ctx(), note: (s) => notes.push(s) })
    assert.ok(notes.length === 1 && /60 hertz/.test(notes[0]))
  })
})

describe('tone.declick', () => {
  function clicky(clean, sr, seed, count = 30) {
    const r = makeRng(seed)
    const x = new Float32Array(clean)
    const pos = []
    const n = clean.length
    for (let k = 0; k < count; k++) {
      const at = Math.floor(r.range(0.2, n / sr - 0.2) * sr)
      const amp = r.range(0.15, 0.4) * (r.next() < 0.5 ? -1 : 1)
      if (k % 2 === 0) x[at] += amp
      else {
        const L = Math.round(0.0008 * sr)
        for (let i = 0; i < L; i++) x[at + i] += amp * Math.exp(-i / (L / 3)) * Math.cos(i * 1.7)
      }
      pos.push(at)
    }
    return { x, pos }
  }
  function improvement(clean, dirty, out, pos, sr) {
    const w = Math.round(0.003 * sr)
    return pos.map((at) => {
      let a = 0
      let b = 0
      for (let i = at - w; i < at + w; i++) {
        a += (dirty[i] - clean[i]) ** 2
        b += (out[i] - clean[i]) ** 2
      }
      return dB(a) - dB(b)
    })
  }
  test('removes clicks from speech and leaves clean speech alone (synthetic)', () => {
    const sr = 48000
    const clean = voice(sr, 6, { f0: 120 }).ch[0]
    const { x, pos } = clicky(clean, sr, 'c1')
    const out = run(M.declick, mono(x, sr)).ch[0]
    const imp = improvement(clean, x, out, pos, sr)
    assert.ok(median(imp) > 12, 'median improvement ' + median(imp).toFixed(1))
    const untouched = run(M.declick, mono(clean, sr)).ch[0]
    let e = 0
    let d = 0
    for (let i = 0; i < clean.length; i++) {
      e += clean[i] * clean[i]
      d += (untouched[i] - clean[i]) ** 2
    }
    assert.ok(dB(e) - dB(d) > 40, 'clean speech changed by ' + (dB(e) - dB(d)).toFixed(1) + ' dB below signal')
  })
  test('real speech: clicks out, words kept', () => {
    for (const b of REAL) {
      const { x, pos } = clicky(b.ch[0], b.sr, 'c2', 40)
      const out = run(M.declick, mono(x, b.sr)).ch[0]
      const imp = improvement(b.ch[0], x, out, pos, b.sr)
      assert.ok(median(imp) > 10, 'median improvement ' + median(imp).toFixed(1))
      const un = run(M.declick, mono(b.ch[0], b.sr)).ch[0]
      let e = 0
      let d = 0
      for (let i = 0; i < un.length; i++) {
        e += b.ch[0][i] ** 2
        d += (un[i] - b.ch[0][i]) ** 2
      }
      assert.ok(dB(e) - dB(d) > 25, 'clean real speech changed by ' + (dB(e) - dB(d)).toFixed(1))
    }
  })
  test('hear what is removed plays the clicks', () => {
    const sr = 48000
    const clean = voice(sr, 2).ch[0]
    const { x } = clicky(clean, sr, 'c3', 6)
    const r = run(M.declick, mono(x, sr), { listen: true }).ch[0]
    const o = run(M.declick, mono(x, sr)).ch[0]
    let m = 0
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(o[i] + r[i] - x[i]))
    assert.ok(m < 1e-5)
    assert.ok(rmsDb(r) > -70)
  })
})

describe('tone.loudness', () => {
  test('hits the target and keeps the ceiling', () => {
    for (const [target, ceiling] of [[-16, -1], [-23, -2], [-10, -1]]) {
      for (const b of [V48, ST48]) {
        const o = run(M.loudness, b, { target, ceiling })
        assert.ok(Math.abs(lufs(o) - target) < 0.6, target + ' got ' + lufs(o).toFixed(2))
        let pk = 0
        for (const c of o.ch) for (const x of c) pk = Math.max(pk, Math.abs(x))
        assert.ok(20 * Math.log10(pk) <= ceiling + 0.01, 'peak ' + 20 * Math.log10(pk))
      }
    }
  })
})

describe('tone.gain and tone.mono', () => {
  test('volume is exact, polarity flips', () => {
    const o = run(M.gain, V48, { db: -6 })
    for (let i = 0; i < 1000; i++) assert.ok(Math.abs(o.ch[0][i] - V48.ch[0][i] * Math.pow(10, -6 / 20)) < 1e-7)
    const f = run(M.gain, V48, { invert: true })
    for (let i = 0; i < 1000; i++) assert.equal(f.ch[0][i], -V48.ch[0][i])
    assert.ok(maxDiff(run(M.gain, V48), V48) === 0)
  })
  test('mono, one side, swap', () => {
    const L = ST48.ch[0]
    const R = ST48.ch[1]
    const mix = run(M.mono, ST48)
    for (let i = 0; i < 2000; i += 7) {
      assert.ok(Math.abs(mix.ch[0][i] - 0.5 * (L[i] + R[i])) < 1e-7)
      assert.equal(mix.ch[0][i], mix.ch[1][i])
    }
    const left = run(M.mono, ST48, { mode: 'left' })
    const sw = run(M.mono, ST48, { mode: 'swap' })
    for (let i = 0; i < 2000; i += 7) {
      assert.equal(left.ch[1][i], L[i])
      assert.equal(sw.ch[0][i], R[i])
      assert.equal(sw.ch[1][i], L[i])
    }
    assert.ok(maxDiff(run(M.mono, V48, { mode: 'swap' }), V48) === 0)
  })
})

// ---------------------------------------------------------------- 5. speed

describe('tone modules: speed', () => {
  const v10 = voice(48000, 10, { f0: 140 })
  const bound = { 1: 60, 2: 120, 3: 300 }
  for (const id of IDS) {
    test(id + ' speed per second of 48 kHz mono', (t) => {
      const m = M[id]
      const ms = timeIt(() => run(m, v10), 2) / 10
      let liveMs = null
      if (m.live) liveMs = timeIt(() => runLive(m, v10, {}, { blocks: [128] }), 2) / 10
      t.diagnostic(id + ': ' + ms.toFixed(2) + ' ms per second offline' + (liveMs !== null ? ', ' + liveMs.toFixed(2) + ' ms live (128-sample blocks)' : ''))
      assert.ok(ms < bound[m.cost], id + ' took ' + ms.toFixed(1) + ' ms per second')
      if (liveMs !== null) assert.ok(liveMs < bound[m.cost], id + ' live took ' + liveMs.toFixed(1))
    })
  }
})
