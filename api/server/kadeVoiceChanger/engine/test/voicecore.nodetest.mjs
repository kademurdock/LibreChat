// test/voicecore.nodetest.mjs - tests for the voice core: resampling and
// varispeed, pitch tracking, envelopes and linear prediction, the phase
// vocoder, and the PSOLA voice shifter (core/resample.js, pitch.js,
// envelope.js, pv.js, voice.js).
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test "engine/test/*.nodetest.mjs"
//
// Real speech: two 24 kHz clips (a woman and a man) from
// "F:/Kade ai info/Fish talking listen (Oct 16)/" are used when present;
// those tests skip when the files are missing.
//
// Pitch is judged with test/measure.mjs, which has its own FFT and its own
// autocorrelation tracker, so a bug in core/pitch.js cannot hide itself.
// For real speech the ruler is run per 10 ms frame and the shifted pitch is
// compared frame by frame with the original pitch times the ratio; its search
// range is bounded around the expected pitch so its own octave slips do not
// count as the engine's.
//
// Listening dump: set VC_DUMP=1 to write WAVs of the shifts to the
// scratchpad's voice-dump folder (through core/wav.js; skipped without it).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { resample, resampleTo, varispeed, varispeedWithMap } from '../core/resample.js'
import {
  trackPitch, f0At, noteOf, hzOf, medianPitch, snapToScale, noteName, parseNote, SCALES,
} from '../core/pitch.js'
import { cepstralEnvelope, lpc, lpcEnvelope, warpEnvelope, lpcResidual, lpcSynthesize } from '../core/envelope.js'
import { stretch, pvShift, findOnsets } from '../core/pv.js'
import { shiftVoice, retuneVoice, pitchMarks, shiftVoiceBuf, retuneVoiceBuf } from '../core/voice.js'
import { FFT } from '../core/fft.js'
import { hann } from '../core/window.js'
import { makeRng } from '../core/rng.js'
import { synthVoice, impulse, sine, noiseBuf, loadWav } from './fixtures.mjs'
import {
  assertSane, medianF0, f0Track, rmsDb, timeIt, formantShiftSemitones,
} from './measure.mjs'

// ---------------------------------------------------------------- material

const SPEECH_DIR = 'F:/Kade ai info/Fish talking listen (Oct 16)/'
const WOMAN_FILE = SPEECH_DIR + '02 Crisp Quartz, today.wav'
const MAN_FILE = SPEECH_DIR + '06 Molasses Dusk, today.wav'
const CLIP_SECONDS = 6

function clip(path) {
  try {
    if (!existsSync(path)) return null
    const b = loadWav(path)
    const n = Math.min(b.ch[0].length, Math.round(CLIP_SECONDS * b.sr))
    return { sr: b.sr, ch: [b.ch[0].slice(0, n)] }
  } catch {
    return null
  }
}
const WOMAN = clip(WOMAN_FILE)
const MAN = clip(MAN_FILE)
const NO_SPEECH = !WOMAN || !MAN ? 'speech clips not found' : false

// ---------------------------------------------------------------- listening dump

const DUMP_DIR = fileURLToPath(new URL('../../../../../../../voice-dump/', import.meta.url))
let wavMod = null
if (process.env.VC_DUMP) {
  try {
    if (existsSync(fileURLToPath(new URL('../core/wav.js', import.meta.url)))) wavMod = await import('../core/wav.js')
  } catch {
    wavMod = null
  }
}
function dump(name, sig, sr) {
  if (!wavMod || typeof wavMod.encodeWav !== 'function') return
  try {
    mkdirSync(DUMP_DIR, { recursive: true })
    writeFileSync(join(DUMP_DIR, name + '.wav'), wavMod.encodeWav({ sr, ch: [sig] }, 16))
  } catch {
    // a listening dump must never fail a test
  }
}

// ---------------------------------------------------------------- helpers

function maxAbsDiff(a, b, from = 0, to = Math.min(a.length, b.length)) {
  let m = 0
  for (let i = from; i < to; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

function maxJump(s) {
  let m = 0
  for (let i = 1; i < s.length; i++) {
    const d = Math.abs(s[i] - s[i - 1])
    if (d > m) m = d
  }
  return m
}

function peakAbs(s, from = 0, to = s.length) {
  let m = 0
  for (let i = from; i < to; i++) {
    const v = Math.abs(s[i])
    if (v > m) m = v
  }
  return m
}

// Lock-in amplitude of frequency hz between sample indices.
function toneAmp(sig, sr, hz, from = 0, to = sig.length) {
  let c = 0
  let s = 0
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * hz * i) / sr
    c += sig[i] * Math.cos(w)
    s += sig[i] * Math.sin(w)
  }
  return (2 * Math.sqrt(c * c + s * s)) / (to - from)
}

function sineSig(sr, seconds, hz, amp = 0.5) {
  return sine(sr, seconds, hz, amp).ch[0]
}

function median(a) {
  if (!a.length) return 0
  const s = Float64Array.from(a).sort()
  const m = s.length >> 1
  return s.length & 1 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

// Median pitch by the ruler, searching only around the expected pitch.
function pitchNear(sig, sr, expected) {
  return medianF0(sig, sr, { minHz: Math.max(25, expected * 0.6), maxHz: Math.min(sr * 0.2, expected * 1.8) })
}

// The ruler's frame track of an input, kept for comparisons with its shifts.
const REFS = new WeakMap()
function refOf(x, sr) {
  let r = REFS.get(x)
  if (!r) {
    const med = medianF0(x, sr, { minHz: 50, maxHz: 1000 })
    r = { med, a: f0Track(x, sr, { hopMs: 10, minHz: Math.max(40, med * 0.4), maxHz: med * 2.4 }) }
    REFS.set(x, r)
  }
  return r
}

/**
 * Frame-by-frame pitch ratio of y against x times `ratio`, judged by the
 * independent ruler on frames where it is confident about x.
 */
function frameRatios(x, y, sr, ratio) {
  const { med, a } = refOf(x, sr)
  const c = f0Track(y, sr, { hopMs: 10, minHz: Math.max(25, med * ratio * 0.45), maxHz: Math.min(sr * 0.2, med * ratio * 2.4) })
  const r = []
  let good = 0
  for (let i = 0; i < Math.min(a.f0.length, c.f0.length); i++) {
    if (!(a.f0[i] > 0 && c.f0[i] > 0 && a.conf[i] > 0.8)) continue
    const q = c.f0[i] / (a.f0[i] * ratio)
    r.push(q)
    if (Math.abs(q - 1) < 0.05) good++
  }
  return { median: median(r), good: r.length ? good / r.length : 0, n: r.length }
}

// Best lag (ms) aligning the 5 ms RMS envelopes of x and y, within +-50 ms.
function envelopeLagMs(x, y, sr) {
  const hop = Math.round(0.005 * sr)
  const nf = Math.floor(Math.min(x.length, y.length) / hop)
  const ex = new Float64Array(nf)
  const ey = new Float64Array(nf)
  for (let f = 0; f < nf; f++) {
    let a = 0
    let b = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      a += x[i] * x[i]
      b += y[i] * y[i]
    }
    ex[f] = Math.sqrt(a / hop)
    ey[f] = Math.sqrt(b / hop)
  }
  let best = -Infinity
  let lag = 0
  for (let l = -10; l <= 10; l++) {
    let s = 0
    for (let f = 10; f < nf - 10; f++) s += ex[f] * ey[f + l]
    if (s > best) {
      best = s
      lag = l
    }
  }
  return lag * 5
}

// ---------------------------------------------------------------- resample

describe('resample', () => {
  test('output length is round(len * ratio), and resampleTo matches rates', () => {
    const x = new Float32Array(10001)
    for (const r of [0.5, 1 / 3, 0.91875, 1.0884, 2, 3.7]) assert.equal(resample(x, r).length, Math.round(10001 * r))
    assert.equal(resampleTo(x, 48000, 44100).length, Math.round((10001 * 44100) / 48000))
    assert.equal(resampleTo(x, 16000, 48000).length, 30003)
    const same = resampleTo(x, 24000, 24000)
    assert.equal(same.length, x.length)
    assert.notEqual(same, x)
  })

  test('a 1 kHz sine converts 48 kHz to 44.1 kHz with error under 1e-3', () => {
    const x = sineSig(48000, 1, 1000)
    const y = resampleTo(x, 48000, 44100)
    let e = 0
    for (let i = 200; i < y.length - 200; i++) e = Math.max(e, Math.abs(y[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100)))
    assert.ok(e < 1e-3, 'error ' + e)
  })

  test('downsampling rejects aliases and keeps the passband flat', () => {
    const al = resampleTo(sineSig(48000, 1, 20000), 48000, 16000)
    assert.ok(20 * Math.log10(peakAbs(al, 300, al.length - 300) / 0.5) < -60, 'a 20 kHz tone must not alias into 16 kHz')
    for (const hz of [100, 1000, 3000, 6000, 6600]) {
      const y = resampleTo(sineSig(48000, 0.5, hz), 48000, 16000)
      const db = 20 * Math.log10(toneAmp(y, 16000, hz, 500, y.length - 500) / 0.5)
      assert.ok(Math.abs(db) < 0.1, hz + ' Hz reads ' + db.toFixed(3) + ' dB')
    }
    // speed-ups of a stretch: ratio 1/2.5
    const y = resample(sineSig(48000, 0.5, 15000), 1 / 2.5)
    assert.ok(20 * Math.log10(peakAbs(y, 200, y.length - 200) / 0.5) < -60)
  })

  test('upsampling rejects images', () => {
    const y = resampleTo(sineSig(16000, 1, 7000), 16000, 48000)
    const image = 20 * Math.log10(toneAmp(y, 48000, 9000, 2000, y.length - 2000) / 0.5)
    const kept = 20 * Math.log10(toneAmp(y, 48000, 7000, 2000, y.length - 2000) / 0.5)
    assert.ok(image < -60, 'image at ' + image.toFixed(1) + ' dB')
    assert.ok(kept > -1.5, 'tone at ' + kept.toFixed(2) + ' dB')
  })

  test('DC, silence, empty input, non-finite samples and bad ratios', () => {
    const dc = new Float32Array(4000).fill(0.5)
    const y = resample(dc, 1.37)
    for (let i = 200; i < y.length - 200; i++) assert.ok(Math.abs(y[i] - 0.5) < 1e-4)
    assert.equal(resample(new Float32Array(0), 2).length, 0)
    assert.equal(peakAbs(resample(new Float32Array(1000), 0.7)), 0)
    const bad = sineSig(48000, 0.1, 440)
    bad[100] = NaN
    bad[200] = Infinity
    assert.ok(resample(bad, 0.8).every(Number.isFinite))
    assert.throws(() => resample(dc, 0), /positive/)
    assert.throws(() => resample(dc, NaN), /positive/)
    assert.throws(() => resampleTo(dc, 48000, -1), /positive/)
  })

  test('speed: 10 s at 48 kHz', () => {
    const x = sineSig(48000, 10, 440)
    const a = timeIt(() => resampleTo(x, 48000, 44100))
    const b = timeIt(() => resampleTo(x, 48000, 16000))
    const c = timeIt(() => resample(x, 1 / 1.26))
    assert.ok(a < 400 && b < 400 && c < 400, `${a.toFixed(0)} ${b.toFixed(0)} ${c.toFixed(0)} ms`)
  })
})

// ---------------------------------------------------------------- varispeed

describe('varispeed', () => {
  const sr = 48000
  const x = sineSig(sr, 1, 1000)

  test('speed 1 copies, 2 doubles the pitch and halves the length, 0.5 the reverse', () => {
    const y1 = varispeed(x, 1, sr)
    assert.equal(y1.length, x.length)
    assert.ok(maxAbsDiff(y1, x, 100, x.length - 100) < 1e-4)
    const y2 = varispeed(x, 2, sr)
    assert.ok(Math.abs(y2.length - x.length / 2) <= 2)
    assert.ok(Math.abs(toneAmp(y2, sr, 2000, 500, y2.length - 500) - 0.5) < 0.01)
    const y5 = varispeed(x, 0.5, sr)
    assert.ok(Math.abs(y5.length - 2 * x.length) <= 2)
    assert.ok(Math.abs(toneAmp(y5, sr, 500, 500, y5.length - 500) - 0.5) < 0.01)
  })

  test('speed-ups are anti-aliased up to 4x', () => {
    const hf = sineSig(sr, 1, 15000)
    for (const s of [2, 3, 4]) {
      const y = varispeed(hf, s, sr)
      assert.ok(20 * Math.log10(peakAbs(y, 500, y.length - 500) / 0.5) < -60, 'speed ' + s)
    }
  })

  test('a tape stop to zero ends cleanly and backwards playback reverses', () => {
    const ts = varispeed(x, (t) => (t < 0.5 ? 1 : Math.max(0, 1 - (t - 0.5) / 0.5)), sr)
    assertSane({ sr, ch: [ts] })
    assert.ok(ts.length > 0.95 * sr && ts.length < 1.4 * sr, 'length ' + ts.length)
    assert.ok(Math.abs(ts[ts.length - 1]) < 1e-6, 'a stopped head is silent')
    assert.ok(maxJump(ts.subarray(ts.length - 4800)) < 0.2)
    const rev = varispeed(x, -1, sr, { start: 'end' })
    let e = 0
    for (let i = 100; i < rev.length - 100; i++) e = Math.max(e, Math.abs(rev[i] - x[x.length - i]))
    assert.ok(e < 1e-4)
    assert.equal(varispeed(x, 0, sr).length, 0)
  })

  test('input clock, per-sample speed arrays, fixed length and the read-position map', () => {
    const sp = new Float32Array(30000).fill(1.5)
    const ya = varispeed(x, sp, sr)
    const yc = varispeed(x, 1.5, sr)
    assert.ok(maxAbsDiff(ya, yc, 0, Math.min(ya.length, yc.length)) < 1e-6)
    const yl = varispeed(x, 0.25, sr, { length: 1000 })
    assert.equal(yl.length, 1000)
    const m = varispeedWithMap(x, (t) => 1 + 0.5 * t, sr, { clock: 'in' })
    assert.ok(m.map.length >= Math.ceil(m.out.length / m.mapStep))
    for (let q = 1; q < m.map.length; q++) assert.ok(m.map[q] > m.map[q - 1])
    assert.equal(m.map[0], 0)
    assert.ok(m.map[m.map.length - 1] >= x.length - 1)
    // at input clock the speed is 1 at the start and 1.5 at the end of the input
    assert.ok(m.out.length > x.length / 1.5 && m.out.length < x.length)
  })

  test('speed: 10 s with a wobbling speed', () => {
    const big = sineSig(sr, 10, 440)
    const ms = timeIt(() => varispeed(big, (t) => 1 + 0.3 * Math.sin(2 * Math.PI * 0.5 * t), sr))
    assert.ok(ms < 600, ms.toFixed(0) + ' ms')
  })
})

// ---------------------------------------------------------------- pitch

function compareToTruth(v, tr) {
  const m = v.meta
  let agree = 0
  let tot = 0
  let gross = 0
  let voiced = 0
  const errs = []
  for (let h = 0; h < m.f0.length; h++) {
    const est = f0At(tr, h * m.hop)
    const truth = m.f0[h]
    tot++
    if (truth > 0 === est > 0) agree++
    if (truth > 0 && est > 0) {
      voiced++
      const e = Math.abs(est / truth - 1)
      errs.push(e)
      if (e > 0.2) gross++
    }
  }
  return { vuv: agree / tot, gross, voiced, medErr: median(errs) }
}

describe('pitch', () => {
  test('synthetic voices at every rate: median within 2 percent, no gross errors, voicing agrees', () => {
    const cases = [[48000, 140], [48000, 220], [44100, 110], [16000, 180], [8000, 140], [96000, 120], [24000, 300], [48000, 600], [48000, 70]]
    for (const [sr, f0] of cases) {
      const v = synthVoice(sr, 3, { f0 })
      const tr = trackPitch(v.ch[0], sr)
      const c = compareToTruth(v, tr)
      const med = medianPitch(tr)
      assert.ok(Math.abs(med / f0 - 1) < 0.02, `${sr}/${f0}: median ${med.toFixed(1)}`)
      assert.ok(c.gross <= 0.02 * c.voiced, `${sr}/${f0}: ${c.gross} gross errors of ${c.voiced}`)
      assert.ok(c.vuv > 0.88, `${sr}/${f0}: voicing agrees on ${(100 * c.vuv).toFixed(1)}%`)
      assert.ok(c.medErr < 0.01, `${sr}/${f0}: median error ${(100 * c.medErr).toFixed(2)}%`)
      assert.equal(tr.f0.length, Math.floor((v.ch[0].length - 1) / tr.hop) + 1)
      assert.ok(tr.conf.every((q) => q >= 0 && q <= 1))
    }
  })

  test('a glide from 100 to 400 Hz is followed', () => {
    const v = synthVoice(48000, 2, { f0: (t) => 100 * Math.pow(2, t) })
    const c = compareToTruth(v, trackPitch(v.ch[0], 48000))
    assert.equal(c.gross, 0)
    assert.ok(c.medErr < 0.01)
  })

  test('silence, white noise, a pure tone and a whistle above the range', () => {
    const s = trackPitch(new Float32Array(48000), 48000)
    assert.ok(s.f0.every((v) => v === 0))
    const empty = trackPitch(new Float32Array(0), 48000)
    assert.equal(empty.f0.length, 0)
    const wn = trackPitch(noiseBuf(48000, 2, 'white', 3).ch[0], 48000)
    let vv = 0
    for (const v of wn.f0) if (v > 0) vv++
    assert.ok(vv < 0.05 * wn.f0.length, vv + ' voiced noise frames')
    const tone = trackPitch(sineSig(48000, 1, 200), 48000)
    assert.ok(Math.abs(medianPitch(tone) / 200 - 1) < 0.005)
    const whistle = trackPitch(sineSig(48000, 1, 1500), 48000)
    assert.ok(whistle.aboveShare > 0.8, 'whistle aboveShare ' + whistle.aboveShare)
    const voice = trackPitch(synthVoice(48000, 2, { f0: 220 }).ch[0], 48000)
    assert.ok(voice.aboveShare < 0.05)
    const short = trackPitch(new Float32Array([0.1, -0.1, 0.2]), 48000)
    assert.ok(short.f0.every(Number.isFinite))
    const nan = sineSig(48000, 0.5, 150)
    nan[1000] = NaN
    assert.ok(trackPitch(nan, 48000).f0.every(Number.isFinite))
  })

  test('helpers: f0At, noteOf, hzOf, scales and note names', () => {
    const tr = { hop: 100, f0: Float32Array.from([0, 100, 200, 0, 300]) }
    assert.equal(f0At(tr, 100), 100)
    assert.equal(f0At(tr, 150), 150)
    assert.equal(f0At(tr, 20), 0)
    assert.equal(f0At(tr, 80), 100)
    assert.equal(f0At(tr, -50), 0)
    assert.equal(f0At(tr, 1e9), 300)
    assert.equal(f0At(null, 5), 0)
    assert.equal(noteOf(440), 69)
    assert.ok(Math.abs(noteOf(261.6256) - 60) < 1e-4)
    assert.equal(noteOf(0), -Infinity)
    assert.equal(hzOf(69), 440)
    assert.equal(hzOf(-Infinity), 0)
    assert.ok(Math.abs(hzOf(noteOf(123.4)) - 123.4) < 1e-9)
    assert.equal(snapToScale(61, 'major', 0), 60)
    assert.equal(snapToScale(61.6, 'major', 0), 62)
    assert.equal(snapToScale(66, 'minor-pentatonic', 'A'), 67)
    assert.equal(snapToScale(70.4, 'chromatic'), 70)
    assert.ok(SCALES.major.length === 7 && SCALES.blues.length === 6)
    assert.equal(noteName(69), 'A4')
    assert.equal(noteName(61), 'C#4')
    assert.equal(parseNote('A4'), 69)
    assert.equal(parseNote('Bb2'), 46)
    assert.ok(Number.isNaN(parseNote('xyz')))
  })

  test('real speech agrees with an independent tracker', { skip: NO_SPEECH }, () => {
    for (const b of [WOMAN, MAN]) {
      const x = b.ch[0]
      const tr = trackPitch(x, b.sr)
      const ref = f0Track(x, b.sr, { hopMs: 5 })
      const L = Math.round(Math.max(0.04, 2.5 / 60) * b.sr)
      let both = 0
      let agree = 0
      for (let i = 0; i < ref.f0.length; i++) {
        const me = f0At(tr, i * ref.hop + L / 2)
        if (me > 0 && ref.f0[i] > 0 && ref.conf[i] > 0.8) {
          both++
          if (Math.abs(me / ref.f0[i] - 1) < 0.05) agree++
        }
      }
      assert.ok(both > 300)
      assert.ok(agree / both > 0.93, 'agreement ' + (agree / both).toFixed(3))
      assert.ok(Math.abs(medianPitch(tr) / medianF0(x, b.sr) - 1) < 0.03)
    }
  })

  test('speed: 30 s of 48 kHz speech', () => {
    const v = synthVoice(48000, 30, { f0: 130 })
    const ms = timeIt(() => trackPitch(v.ch[0], 48000))
    assert.ok(ms < 1000, ms.toFixed(0) + ' ms')
  })
})

// ---------------------------------------------------------------- envelope

describe('envelope', () => {
  test('lpc recovers a known resonator and its envelope peaks there', () => {
    // x[n] = e[n] + 2 r cos(w) x[n-1] - r^2 x[n-2]
    const sr = 16000
    const r = 0.97
    const w = (2 * Math.PI * 1000) / sr
    const a1 = -2 * r * Math.cos(w)
    const a2 = r * r
    const rng = makeRng('lpc')
    const n = 8192
    const x = new Float64Array(n)
    for (let i = 0; i < n; i++) x[i] = rng.gauss() - a1 * (i > 0 ? x[i - 1] : 0) - a2 * (i > 1 ? x[i - 2] : 0)
    const res = lpc(x, 2)
    assert.ok(Math.abs(res.a[1] - a1) < 0.02 && Math.abs(res.a[2] - a2) < 0.02, `${res.a[1]} ${res.a[2]}`)
    assert.equal(res.a[0], 1)
    assert.ok(res.err > 0 && Math.abs(res.err / n - 1) < 0.1, 'error power ' + res.err / n)
    const env = lpcEnvelope(res.a, res.err, 513)
    let pk = 0
    for (let k = 1; k < 513; k++) if (env[k] > env[pk]) pk = k
    assert.ok(Math.abs((pk * sr) / 1024 - 1000) < 40, 'peak at ' + (pk * sr) / 1024)
    // the same envelope by direct evaluation for a non power-of-two size
    const env2 = lpcEnvelope(res.a, res.err, 300)
    let pk2 = 0
    for (let k = 1; k < 300; k++) if (env2[k] > env2[pk2]) pk2 = k
    assert.ok(Math.abs((pk2 * sr) / 598 - 1000) < 40)
    // scale: the model matches the frame's own spectrum on average (dB)
    const N = 8192
    const fft = new FFT(N)
    const re = new Float64Array(N / 2 + 1)
    const im = new Float64Array(N / 2 + 1)
    fft.realForward(x, re, im)
    const envN = lpcEnvelope(res.a, res.err, N / 2 + 1)
    let d = 0
    let cnt = 0
    for (let k = 20; k < N / 2; k += 7) {
      d += 20 * Math.log10(Math.hypot(re[k], im[k]) / envN[k])
      cnt++
    }
    assert.ok(Math.abs(d / cnt) < 4, 'mean level difference ' + (d / cnt).toFixed(2) + ' dB')
  })

  test('lpc edge cases are stable: silence, non-finite samples, a pure tone, high orders', () => {
    const z = lpc(new Float32Array(400), 12)
    assert.equal(z.err, 0)
    assert.ok(z.a.every((v, i) => (i === 0 ? v === 1 : v === 0)))
    const bad = new Float32Array(400)
    for (let i = 0; i < 400; i++) bad[i] = Math.sin(i * 0.3)
    bad[10] = NaN
    const b = lpc(bad, 10, { window: 'hann' })
    assert.ok(b.a.every(Number.isFinite) && Number.isFinite(b.err))
    for (const order of [2, 16, 48]) {
      const t = lpc(sineSig(16000, 0.05, 440), order)
      assert.ok(t.k.every((k) => Math.abs(k) < 1), 'reflection coefficients inside the unit circle')
      assert.ok(t.a.every(Number.isFinite))
    }
    assert.equal(lpc(new Float32Array(0), 4).err, 0)
  })

  test('the residual and the all-pole synthesis invert each other', () => {
    const v = synthVoice(16000, 0.3, { f0: 150 }).ch[0]
    const { a } = lpc(v, 18, { window: 'hann' })
    const e = lpcResidual(v, a)
    const y = lpcSynthesize(e, a)
    assert.ok(maxAbsDiff(y, v) < 1e-4)
    // block-wise synthesis with carried state gives the same result
    const st = new Float64Array(18)
    const y1 = lpcSynthesize(e.subarray(0, 2000), a, 1, st)
    const y2 = lpcSynthesize(e.subarray(2000), a, 1, st)
    assert.ok(maxAbsDiff(y1, y.subarray(0, 2000)) < 1e-6 && maxAbsDiff(y2, y.subarray(2000)) < 1e-4)
  })

  test('cepstral envelope: flat stays flat, harmonic ripple goes, formants stay; true envelope rides the peaks', () => {
    const flat = new Float64Array(1025).fill(2)
    const ef = cepstralEnvelope(flat, 40)
    assert.ok(ef instanceof Float32Array && ef.length === 1025)
    for (let k = 0; k < 1025; k++) assert.ok(Math.abs(ef[k] / 2 - 1) < 1e-3)
    // a synthetic /a/ frame (formants 768, 1333 Hz) at 130 Hz
    const sr = 48000
    const v = synthVoice(sr, 2, { f0: 130, vowels: ['a'], fricatives: false })
    const seg = v.meta.segments.find((s) => s.kind === 'vowel' && s.end - s.start > 0.2)
    const N = 2048
    const fft = new FFT(N)
    const w = hann(N)
    const c = Math.round((seg.start + 0.12) * sr)
    const fr = new Float64Array(N)
    for (let i = 0; i < N; i++) fr[i] = v.ch[0][c - N / 2 + i] * w[i]
    const re = new Float64Array(N / 2 + 1)
    const im = new Float64Array(N / 2 + 1)
    fft.realForward(fr, re, im)
    const mag = new Float64Array(N / 2 + 1)
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k], im[k])
    const order = Math.round(0.0016 * sr)
    const e = cepstralEnvelope(mag, order)
    // the true envelope at Roebel's order for riding harmonic peaks, sr / (2 f0)
    const te = cepstralEnvelope(mag, Math.round(sr / (2 * 130)), { trueEnvelope: true })
    const db = (x) => 20 * Math.log10(x)
    // smooth: no harmonic ripple (adjacent bins change little in the 200..3000 Hz band)
    let worst = 0
    for (let k = 10; k < 128; k++) worst = Math.max(worst, Math.abs(db(e[k + 1]) - db(e[k])))
    assert.ok(worst < 1.5, 'ripple ' + worst.toFixed(2) + ' dB per bin')
    // the envelope's peak in 400..1600 Hz is near the first formants
    let pk = 17
    for (let k = 17; k < 68; k++) if (e[k] > e[pk]) pk = k
    const pkHz = (pk * sr) / N
    assert.ok(pkHz > 550 && pkHz < 1450, 'envelope peak at ' + pkHz.toFixed(0) + ' Hz')
    // the true envelope lies on or above the plain one and near the harmonic peaks
    let above = 0
    let near = 0
    let peaks = 0
    for (let k = 3; k < 70; k++) {
      if (te[k] >= e[k] * 0.999) above++
      if (mag[k] > mag[k - 1] && mag[k] > mag[k + 1] && db(mag[k]) > db(te[k]) - 20) {
        peaks++
        if (Math.abs(db(mag[k]) - db(te[k])) < 3) near++
      }
    }
    assert.ok(above > 60)
    assert.ok(peaks > 5 && near / peaks > 0.6, `${near} of ${peaks} harmonic peaks within 3 dB`)
    assert.ok(cepstralEnvelope(new Float32Array(9), 3).every(Number.isFinite))
    assert.ok(cepstralEnvelope(new Float32Array(300).fill(1), 20).every((x) => Math.abs(x - 1) < 1e-3))
    assert.ok(cepstralEnvelope(new Float32Array(1025), 20).every((x) => x === 0))
  })

  test('warpEnvelope moves a peak by the ratio', () => {
    const env = new Float32Array(1025)
    for (let k = 0; k < 1025; k++) env[k] = Math.exp(-((k - 200) * (k - 200)) / 200)
    const up = warpEnvelope(env, 1.25)
    let pk = 0
    for (let k = 0; k < 1025; k++) if (up[k] > up[pk]) pk = k
    assert.equal(pk, 250)
    const down = warpEnvelope(env, 0.5)
    let pd = 0
    for (let k = 0; k < 1025; k++) if (down[k] > down[pd]) pd = k
    assert.equal(pd, 100)
  })
})

// ---------------------------------------------------------------- pv

describe('pv', () => {
  const sr = 48000
  const voice = synthVoice(sr, 3, { f0: 130 }).ch[0]
  const f0in = medianF0(voice, sr)

  test('stretch keeps pitch and level, and lengths are exact', () => {
    for (const f of [0.5, 1.5, 2, 4]) {
      const y = stretch(voice, sr, f)
      assert.equal(y.length, Math.round(voice.length * f))
      assertSane({ sr, ch: [y] })
      assert.ok(Math.abs(medianF0(y, sr) / f0in - 1) < 0.01, 'factor ' + f)
      assert.ok(Math.abs(rmsDb(y) - rmsDb(voice)) < 1.5, 'factor ' + f + ' level')
    }
    const t = sineSig(sr, 1, 440)
    const y = stretch(t, sr, 2)
    assert.ok(Math.abs(toneAmp(y, sr, 440, 4800, y.length - 4800) - 0.5) < 0.02)
    assert.equal(stretch(voice, sr, 1).length, voice.length)
    assert.equal(stretch(new Float32Array(0), sr, 2).length, 0)
  })

  test('stretch keeps clicks sharp', () => {
    const n = sr * 2
    const nz = noiseBuf(sr, 2, 'white', 5).ch[0]
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.001 * nz[i]
    const at = [0.2, 0.5, 0.8, 1.1, 1.4, 1.7]
    for (const t of at) {
      const c = Math.round(t * sr)
      for (let k = 0; k < 240; k++) x[c + k] += 0.8 * Math.exp(-k / 30) * nz[(k * 7) % n]
    }
    assert.equal(findOnsets(x, sr).length, at.length)
    for (const f of [2, 4]) {
      const y = stretch(x, sr, f)
      // the six loudest separated peaks, and how much of the energy around each sits within 4 ms
      const used = new Uint8Array(y.length)
      const w30 = Math.round(0.03 * sr)
      for (let c = 0; c < at.length; c++) {
        let pk = -1
        let pv = 0
        for (let i = w30; i < y.length - w30; i++) if (!used[i] && Math.abs(y[i]) > pv) {
          pv = Math.abs(y[i])
          pk = i
        }
        let e4 = 0
        let e30 = 0
        for (let i = pk - w30; i < pk + w30; i++) {
          const v = y[i] * y[i]
          e30 += v
          if (Math.abs(i - pk) < 0.004 * sr) e4 += v
          used[i] = 1
        }
        assert.ok(e4 / e30 > 0.8, `factor ${f}: click ${c} keeps ${(100 * e4 / e30).toFixed(0)}% within 4 ms`)
      }
    }
  })

  test('stretch with a factor that changes over time', () => {
    const y = stretch(voice, sr, (t) => (t < 1.5 ? 1.5 : 0.75))
    const want = 1.5 * sr * 1.5 + (voice.length / sr - 1.5) * sr * 0.75
    assert.ok(Math.abs(y.length - want) < 0.02 * want, `${y.length} vs ${want}`)
    assert.ok(Math.abs(medianF0(y, sr) / f0in - 1) < 0.015)
  })

  test('pvShift moves pitch, keeps the length, and keeps or moves formants', () => {
    for (const st of [-12, -5, 5, 12]) {
      const r = Math.pow(2, st / 12)
      const y = pvShift(voice, sr, r)
      assert.equal(y.length, voice.length)
      assertSane({ sr, ch: [y] })
      assert.ok(Math.abs(pitchNear(y, sr, f0in * r) / (f0in * r) - 1) < 0.02, 'st ' + st)
    }
    const no = pvShift(voice, sr, Math.pow(2, 5 / 12), { keepFormants: false })
    assert.ok(formantShiftSemitones(voice, no, sr) > 3.5, 'without keepFormants the formants move with the pitch')
    const fm = pvShift(voice, sr, 1, { formantRatio: Math.pow(2, 4 / 12) })
    assert.ok(Math.abs(formantShiftSemitones(voice, fm, sr) - 4) < 0.8)
    assert.ok(Math.abs(medianF0(fm, sr) / f0in - 1) < 0.01)
    assert.equal(pvShift(new Float32Array(0), sr, 2).length, 0)
  })

  test('pvShift keeps the formants of real speech', { skip: NO_SPEECH }, () => {
    for (const b of [WOMAN, MAN]) {
      for (const st of [-12, 12]) {
        const y = pvShift(b.ch[0], b.sr, Math.pow(2, st / 12))
        assert.ok(Math.abs(formantShiftSemitones(b.ch[0], y, b.sr)) < 1, 'st ' + st)
        const fr = frameRatios(b.ch[0], y, b.sr, Math.pow(2, st / 12))
        assert.ok(Math.abs(fr.median - 1) < 0.03, 'st ' + st + ' pitch ' + fr.median.toFixed(3))
      }
    }
  })

  test('pvShift with a ratio that changes over time', () => {
    const y = pvShift(voice, sr, (t) => Math.pow(2, (t < 1.5 ? -5 : 5) / 12))
    assert.equal(y.length, voice.length)
    const a = f0Track(voice, sr, { hopMs: 10 })
    const c = f0Track(y, sr, { hopMs: 10, minHz: 50 })
    const L = Math.round(Math.max(0.04, 2.5 / 60) * sr)
    let ok = 0
    let n = 0
    for (let i = 0; i < a.f0.length; i++) {
      if (!(a.f0[i] > 0 && c.f0[i] > 0)) continue
      const t = (i * a.hop + L / 2) / sr
      if (Math.abs(t - 1.5) < 0.1) continue
      n++
      if (Math.abs(c.f0[i] / (a.f0[i] * Math.pow(2, (t < 1.5 ? -5 : 5) / 12)) - 1) < 0.04) ok++
    }
    assert.ok(ok / n > 0.9, `${ok} of ${n} frames`)
  })

  test('speed: 10 s of 48 kHz', () => {
    const big = synthVoice(sr, 10, { f0: 130 }).ch[0]
    const a = timeIt(() => stretch(big, sr, 1.5))
    const b = timeIt(() => pvShift(big, sr, Math.pow(2, 5 / 12)))
    assert.ok(a < 1500 && b < 1500, `stretch ${a.toFixed(0)} ms, pvShift ${b.toFixed(0)} ms`)
  })
})

// ---------------------------------------------------------------- voice

const SHIFTS = [-12, -5, 5, 12, 24]

describe('voice', () => {
  const sr = 48000
  const male = synthVoice(sr, 4, { f0: 120 })
  const female = synthVoice(sr, 4, { f0: 210 })

  test('synthetic voices: pitch ratios within 3 percent from -12 to +24, exact length, no clicks, level kept', () => {
    for (const [name, v] of [['male', male], ['female', female]]) {
      const x = v.ch[0]
      const f0in = pitchNear(x, sr, name === 'male' ? 120 : 210)
      const jumpIn = maxJump(x)
      for (const st of SHIFTS) {
        const info = {}
        const y = shiftVoice(x, sr, { semitones: st, info })
        dump(`synth-${name}_st${st > 0 ? '+' : ''}${st}`, y, sr)
        assert.equal(info.method, 'psola')
        assert.equal(y.length, x.length)
        assertSane({ sr, ch: [y] })
        const r = pitchNear(y, sr, f0in * Math.pow(2, st / 12)) / f0in / Math.pow(2, st / 12)
        assert.ok(Math.abs(r - 1) < 0.03, `${name} ${st}: ratio off by ${((r - 1) * 100).toFixed(2)}%`)
        assert.ok(maxJump(y) < 2 * jumpIn, `${name} ${st}: largest step ${maxJump(y).toFixed(3)} vs ${jumpIn.toFixed(3)}`)
        assert.ok(Math.abs(rmsDb(y) - rmsDb(x)) < 3, `${name} ${st}: level`)
        assert.ok(Math.abs(envelopeLagMs(x, y, sr)) <= 5, `${name} ${st}: timing`)
      }
    }
  })

  test('real speech: pitch ratios within 3 percent from -12 to +24, timing, clicks and level', { skip: NO_SPEECH }, () => {
    for (const [name, b] of [['woman', WOMAN], ['man', MAN]]) {
      const x = b.ch[0]
      const track = trackPitch(x, b.sr)
      const jumpIn = maxJump(x)
      for (const st of SHIFTS) {
        const y = shiftVoice(x, b.sr, { semitones: st, track })
        dump(`${name}_st${st > 0 ? '+' : ''}${st}`, y, b.sr)
        assert.equal(y.length, x.length)
        assertSane({ sr: b.sr, ch: [y] })
        const fr = frameRatios(x, y, b.sr, Math.pow(2, st / 12))
        assert.ok(fr.n > 200, `${name} ${st}: ${fr.n} frames`)
        assert.ok(Math.abs(fr.median - 1) < 0.03, `${name} ${st}: ratio ${fr.median.toFixed(3)}`)
        assert.ok(fr.good > 0.8, `${name} ${st}: ${(100 * fr.good).toFixed(1)}% of frames within 5%`)
        assert.ok(maxJump(y) < 2 * jumpIn, `${name} ${st}: largest step ${maxJump(y).toFixed(3)} vs ${jumpIn.toFixed(3)}`)
        assert.ok(Math.abs(rmsDb(y) - rmsDb(x)) < 3, `${name} ${st}: level ${(rmsDb(y) - rmsDb(x)).toFixed(1)} dB`)
        assert.ok(Math.abs(envelopeLagMs(x, y, b.sr)) <= 5, `${name} ${st}: timing`)
      }
    }
  })

  test('timbre moves without the pitch', () => {
    const cases = [['male', male.ch[0], sr], ['female', female.ch[0], sr]]
    if (!NO_SPEECH) cases.push(['woman', WOMAN.ch[0], WOMAN.sr], ['man', MAN.ch[0], MAN.sr])
    for (const [name, x, rate] of cases) {
      for (const fm of [-4, 4]) {
        const y = shiftVoice(x, rate, { formant: fm })
        dump(`${name}_fm${fm > 0 ? '+' : ''}${fm}`, y, rate)
        const est = formantShiftSemitones(x, y, rate)
        assert.ok(fm > 0 ? est > 2.8 && est < 5.2 : est < -2.8 && est > -5.2, `${name} formant ${fm}: measured ${est.toFixed(2)}`)
        const fr = frameRatios(x, y, rate, 1)
        assert.ok(Math.abs(fr.median - 1) < 0.03, `${name} formant ${fm}: pitch ratio ${fr.median.toFixed(3)}`)
        assert.ok(Math.abs(rmsDb(y) - rmsDb(x)) < 3)
        assert.equal(y.length, x.length)
      }
    }
    // the big ones stay sane and still move the right way
    for (const fm of [-12, 12]) {
      const y = shiftVoice(male.ch[0], sr, { formant: fm, semitones: -fm / 2 })
      assertSane({ sr, ch: [y] })
      const est = formantShiftSemitones(male.ch[0], y, sr)
      assert.ok(fm > 0 ? est > 8 : est < -8, 'formant ' + fm + ': ' + est.toFixed(2))
    }
  })

  test('consonant bursts are played once: never doubled or dropped by a timbre change', () => {
    const n = sr * 4
    const nz = noiseBuf(sr, 4, 'white', 9).ch[0]
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.002 * nz[i]
    const at = []
    for (let t = 0.15; t < 3.9; t += 0.137) at.push(t)
    for (const t of at) {
      const c = Math.round(t * sr)
      for (let k = 0; k < 360; k++) x[c + k] += 0.6 * Math.exp(-k / 60) * nz[(k * 13 + c) % n]
    }
    const bursts = (y) => {
      const W = Math.round(0.002 * sr)
      const nf = Math.floor(y.length / W)
      const e = new Float64Array(nf)
      let mx = 0
      for (let f = 0; f < nf; f++) {
        let s = 0
        for (let i = f * W; i < (f + 1) * W; i++) s += y[i] * y[i]
        e[f] = s
        if (s > mx) mx = s
      }
      const on = []
      let hot = false
      for (let f = 0; f < nf; f++) {
        const h = e[f] > mx * 0.01
        if (h && !hot) on.push((f * W) / sr)
        hot = h
      }
      return on
    }
    assert.equal(bursts(x).length, at.length)
    for (const [fm, maxDoubled] of [[4, 0], [-4, 0], [8, 3], [-8, 0], [12, 3], [-12, 0]]) {
      const ob = bursts(shiftVoice(x, sr, { formant: fm }))
      let found = 0
      let doubled = 0
      for (const t of at) {
        const m = ob.filter((b) => Math.abs(b - t) < 0.025).length
        if (m >= 1) found++
        if (m > 1) doubled += m - 1
      }
      assert.equal(found, at.length, `formant ${fm}: ${at.length - found} bursts lost`)
      assert.ok(doubled <= maxDoubled, `formant ${fm}: ${doubled} bursts doubled`)
    }
  })

  test('glides and vibrato from functions of time', () => {
    const x = male.ch[0]
    const ys = shiftVoice(x, sr, { semitones: (t) => -6 + 3 * t })
    const a = f0Track(x, sr, { hopMs: 10 })
    const c = f0Track(ys, sr, { hopMs: 10, minHz: 40 })
    const L = Math.round(Math.max(0.04, 2.5 / 60) * sr)
    let ok = 0
    let n = 0
    for (let i = 0; i < a.f0.length; i++) {
      if (!(a.f0[i] > 0 && c.f0[i] > 0)) continue
      n++
      const t = (i * a.hop + L / 2) / sr
      if (Math.abs(c.f0[i] / (a.f0[i] * Math.pow(2, (-6 + 3 * t) / 12)) - 1) < 0.05) ok++
    }
    assert.ok(ok / n > 0.9, `${ok} of ${n} glide frames`)
    // vibrato: 5.5 Hz, plus or minus 1 semitone, shows up as pitch spread
    const yv = shiftVoice(x, sr, { semitones: (t) => Math.sin(2 * Math.PI * 5.5 * t) })
    const cv = f0Track(yv, sr, { hopMs: 5 })
    const lr = []
    const av = f0Track(x, sr, { hopMs: 5 })
    for (let i = 0; i < cv.f0.length; i++) if (cv.f0[i] > 0 && av.f0[i] > 0) lr.push(12 * Math.log2(cv.f0[i] / av.f0[i]))
    lr.sort((p, q) => p - q)
    const spread = lr[Math.floor(lr.length * 0.9)] - lr[Math.floor(lr.length * 0.1)]
    assert.ok(spread > 1 && spread < 2.6, 'vibrato spread ' + spread.toFixed(2) + ' semitones')
    // a timbre glide: formants low early, high late
    const yf = shiftVoice(x, sr, { formant: (t) => -6 + 3 * t })
    const early = formantShiftSemitones(x.subarray(0, sr * 1.5), yf.subarray(0, sr * 1.5), sr)
    const late = formantShiftSemitones(x.subarray(sr * 2.5), yf.subarray(sr * 2.5), sr)
    assert.ok(early < -2.5 && late > 2.5, `early ${early.toFixed(2)}, late ${late.toFixed(2)}`)
    assert.equal(yf.length, x.length)
  })

  test('retuneVoice: a monotone robot, snapping to a scale, and a target called once per cycle in order', () => {
    const x = male.ch[0]
    const yr = retuneVoice(x, sr, { targetFn: () => 150 })
    dump('synth-male_monotone-150', yr, sr)
    const tr = f0Track(yr, sr, { hopMs: 10 })
    let m = 0
    let n = 0
    for (const f of tr.f0) if (f > 0) {
      n++
      if (Math.abs(f / 150 - 1) < 0.03) m++
    }
    assert.ok(m / n > 0.9, `${m} of ${n} frames at 150 Hz`)
    const glide = synthVoice(sr, 3, { f0: (t) => 120 * Math.pow(2, t / 3) }).ch[0]
    const yc = retuneVoice(glide, sr, { targetFn: (t, f0) => hzOf(snapToScale(noteOf(f0), 'major', 0)) })
    dump('synth-glide_c-major', yc, sr)
    const cents = []
    for (const f of f0Track(yc, sr, { hopMs: 10 }).f0) if (f > 0) cents.push(100 * Math.abs(noteOf(f) - snapToScale(noteOf(f), 'major', 0)))
    assert.ok(median(cents) < 10, 'median ' + median(cents).toFixed(1) + ' cents off the scale')
    let calls = 0
    let last = -1
    let ordered = true
    const info = {}
    retuneVoice(x, sr, {
      info,
      targetFn: (t, f0) => {
        calls++
        if (t < last) ordered = false
        last = t
        return f0 > 0 ? 0 : 0
      },
    })
    assert.ok(ordered)
    assert.equal(calls, info.voicedGrains)
    // no target function: the voice comes back untouched
    assert.ok(maxAbsDiff(retuneVoice(x, sr, {}), x) === 0)
  })

  test('quality fast, and the vocoder for whistles and other material without speech', () => {
    const x = female.ch[0]
    const f0in = medianF0(x, sr)
    for (const st of [-12, -5, 5, 12]) {
      const info = {}
      const y = shiftVoice(x, sr, { semitones: st, quality: 'fast', info })
      assert.equal(info.method, 'pv')
      assert.equal(y.length, x.length)
      assert.ok(Math.abs(pitchNear(y, sr, f0in * Math.pow(2, st / 12)) / (f0in * Math.pow(2, st / 12)) - 1) < 0.03, 'fast ' + st)
    }
    const info = {}
    const w = shiftVoice(sineSig(sr, 1.5, 1500), sr, { semitones: 5, info })
    assert.equal(info.method, 'pv')
    assert.ok(Math.abs(medianF0(w, sr, { minHz: 500, maxHz: 4000 }) / 2002 - 1) < 0.01)
    // a timbre change leaves a whistle's pitch alone
    const wi = {}
    const wt = shiftVoice(sineSig(sr, 1.5, 1500), sr, { formant: 4, info: wi })
    assert.equal(wi.method, 'pv')
    assert.ok(Math.abs(medianF0(wt, sr, { minHz: 500, maxHz: 4000 }) / 1500 - 1) < 0.01)
    const noise = noiseBuf(sr, 1, 'pink', 2).ch[0]
    const ni = {}
    const yn = shiftVoice(noise, sr, { semitones: 7, info: ni })
    assert.equal(ni.method, 'pv')
    assertSane({ sr, ch: [yn] })
  })

  test('edge cases: empty, silence, a click, three samples, non-finite input, loud input, extreme settings', () => {
    assert.equal(shiftVoice(new Float32Array(0), sr, { semitones: 3 }).length, 0)
    assert.equal(shiftVoice(null, sr, { semitones: 3 }).length, 0)
    assert.equal(peakAbs(shiftVoice(new Float32Array(sr), sr, { semitones: 5, formant: 2 })), 0)
    const click = shiftVoice(impulse(sr, 0.5, 0.2).ch[0], sr, { semitones: 5, formant: 3 })
    assertSane({ sr, ch: [click] })
    assert.ok(peakAbs(click) > 0.05, 'the click is still there')
    const tiny = shiftVoice(new Float32Array([0.1, -0.2, 0.3]), sr, { semitones: 12 })
    assert.equal(tiny.length, 3)
    assert.ok(tiny.every(Number.isFinite))
    const bad = male.ch[0].slice(0, sr)
    bad[100] = NaN
    bad[2000] = -Infinity
    assert.ok(shiftVoice(bad, sr, { semitones: 3 }).every(Number.isFinite))
    const loud = Float32Array.from(male.ch[0].subarray(0, sr), (v) => 4 * v)
    for (const o of [
      { semitones: 36, formant: 24 },
      { semitones: -36, formant: -24 },
      { semitones: 24, formant: -12 },
      { semitones: -24, formant: 12 },
      { semitones: () => NaN, formant: () => Infinity },
      { semitones: NaN, formant: 'x' },
    ]) {
      const y = shiftVoice(loud, sr, o)
      assert.equal(y.length, loud.length)
      assertSane({ sr, ch: [y] })
    }
    const ys = shiftVoice(male.ch[0], sr, { semitones: 0, formant: 0 })
    assert.ok(maxAbsDiff(ys, male.ch[0]) === 0, 'no change asked, no change made')
    assert.notEqual(ys, male.ch[0])
    // a broken sample rate never throws or makes NaN
    const part = male.ch[0].subarray(0, 9600)
    for (const badRate of [0, NaN, -1, Infinity, undefined]) {
      assert.ok(shiftVoice(part, badRate, { semitones: 5 }).every(Number.isFinite))
      assert.ok(trackPitch(part, badRate).f0.every(Number.isFinite))
      assert.ok(stretch(part, badRate, 1.5).every(Number.isFinite))
      assert.ok(pvShift(part, badRate, 1.3).every(Number.isFinite))
    }
    // every sample rate the engine supports
    for (const rate of [8000, 16000, 22050, 44100, 96000]) {
      const v = synthVoice(rate, 1.5, { f0: 140 }).ch[0]
      const y = shiftVoice(v, rate, { semitones: 7, formant: 2 })
      assertSane({ sr: rate, ch: [y] })
      assert.ok(Math.abs(medianF0(y, rate) / (medianF0(v, rate) * Math.pow(2, 7 / 12)) - 1) < 0.03, 'rate ' + rate)
    }
  })

  test('deterministic, and a precomputed track gives the same result faster', () => {
    const x = female.ch[0]
    const a = shiftVoice(x, sr, { semitones: 4, formant: -2 })
    const b = shiftVoice(x, sr, { semitones: 4, formant: -2 })
    assert.ok(maxAbsDiff(a, b) === 0)
    const track = trackPitch(x, sr)
    const c = shiftVoice(x, sr, { semitones: 4, formant: -2, track })
    assert.ok(maxAbsDiff(a, c) === 0)
    const slow = timeIt(() => shiftVoice(x, sr, { semitones: 4 }), 2)
    const quick = timeIt(() => shiftVoice(x, sr, { semitones: 4, track }), 2)
    assert.ok(quick < slow, `${quick.toFixed(0)} ms with a track vs ${slow.toFixed(0)} ms without`)
    // a track that does not belong to this signal is ignored, not trusted
    const wrong = trackPitch(x.subarray(0, 1000), sr)
    assert.ok(maxAbsDiff(shiftVoice(x, sr, { semitones: 4, formant: -2, track: wrong }), a) === 0)
  })

  test('stereo buffers stay coherent', () => {
    const L = male.ch[0]
    const R = Float32Array.from(L, (v) => 0.5 * v)
    const out = shiftVoiceBuf({ sr, ch: [L, R] }, { semitones: -5, formant: 2 })
    assert.equal(out.ch.length, 2)
    assert.equal(out.sr, sr)
    let e = 0
    for (let i = 0; i < L.length; i++) e = Math.max(e, Math.abs(out.ch[1][i] - 0.5 * out.ch[0][i]))
    assert.ok(e < 1e-5, 'one plan drives both channels')
    const rt = retuneVoiceBuf({ sr, ch: [L, R] }, { targetFn: () => 100 })
    assert.equal(rt.ch.length, 2)
    assertSane(rt)
    assert.equal(shiftVoiceBuf({ sr, ch: [new Float32Array(0)] }, { semitones: 2 }).ch[0].length, 0)
  })

  test('pitch marks: one per glottal cycle', () => {
    const v = synthVoice(sr, 3, { f0: 140 })
    const x = v.ch[0]
    const mk = pitchMarks(x, sr, trackPitch(x, sr))
    assert.ok(mk.pos[0] <= 0 && mk.pos[mk.count - 1] >= x.length - 1)
    for (let i = 1; i < mk.count; i++) assert.ok(mk.pos[i] > mk.pos[i - 1])
    let ok = 0
    let n = 0
    for (let i = 1; i < mk.count; i++) {
      if (!(mk.voiced[i] && mk.voiced[i - 1])) continue
      const h = Math.round(mk.pos[i] / v.meta.hop)
      const truth = v.meta.f0[Math.min(h, v.meta.f0.length - 1)]
      if (!(truth > 0)) continue
      n++
      if (Math.abs((mk.pos[i] - mk.pos[i - 1]) / (sr / truth) - 1) < 0.05) ok++
    }
    assert.ok(n > 250 && ok / n > 0.95, `${ok} of ${n} cycles`)
  })

  test('speed: 10 s of 48 kHz in well under 1.5 s', () => {
    const big = synthVoice(sr, 10, { f0: 130 }).ch[0]
    const a = timeIt(() => shiftVoice(big, sr, { semitones: 5, formant: 3 }))
    const b = timeIt(() => shiftVoice(big, sr, { semitones: -12 }))
    const c = timeIt(() => shiftVoice(big, sr, { semitones: (t) => 3 * Math.sin(t), formant: (t) => -2 + t * 0.4 }))
    const d = timeIt(() => retuneVoice(big, sr, { targetFn: () => 110 }))
    assert.ok(a < 1500 && b < 1500 && c < 1500 && d < 1500, `${a.toFixed(0)} ${b.toFixed(0)} ${c.toFixed(0)} ${d.toFixed(0)} ms`)
  })
})

// Engine fix, Oct 22 2026: targetFn(t, f0, smoothF0).
describe('voice: the retune target gets a smoothed f0 to pick notes from', () => {
  const cents = (a, b) => 1200 * Math.log2(a / b)
  function collect(x, sr, buf = false) {
    const raw = []
    const smooth = []
    const ts = []
    const fn = (t, f0, s) => {
      ts.push(t)
      raw.push(f0)
      smooth.push(s)
      return 0
    }
    if (buf) retuneVoiceBuf({ sr, ch: [x, x] }, { targetFn: fn })
    else retuneVoice(x, sr, { targetFn: fn })
    return { raw, smooth, ts }
  }
  function steadiness(c) {
    // median cycle-to-cycle step in cents, and how often the nearest note changes
    const step = (a) => {
      const d = []
      for (let i = 1; i < a.length; i++) if (c.ts[i] - c.ts[i - 1] < 0.02) d.push(Math.abs(cents(a[i], a[i - 1])))
      return median(d)
    }
    const flips = (a) => {
      let f = 0
      for (let i = 1; i < a.length; i++) if (c.ts[i] - c.ts[i - 1] < 0.02 && Math.round(noteOf(a[i])) !== Math.round(noteOf(a[i - 1]))) f++
      return f
    }
    return { rawStep: step(c.raw), smoothStep: step(c.smooth), rawFlips: flips(c.raw), smoothFlips: flips(c.smooth) }
  }

  test('a third argument, finite and positive on every voiced cycle, far steadier than the cycle f0', () => {
    const sr = 48000
    const v = synthVoice(sr, 3, { f0: (t) => 130 + 25 * Math.sin(1.3 * t), jitter: 0.02, seed: 21 })
    const c = collect(v.ch[0], sr)
    assert.ok(c.raw.length > 200, c.raw.length + ' cycles')
    for (let i = 0; i < c.raw.length; i++) assert.ok(c.smooth[i] > 20 && c.smooth[i] < 4000, 'smoothF0 ' + c.smooth[i])
    const s = steadiness(c)
    assert.ok(s.smoothStep < 0.5 * s.rawStep, `cycle-to-cycle steps: smooth ${s.smoothStep.toFixed(1)} cents, raw ${s.rawStep.toFixed(1)} cents`)
    // it follows the voice's true pitch
    const hop = v.meta.hop
    const errs = []
    for (let i = 0; i < c.ts.length; i++) {
      const truth = v.meta.f0[Math.min(Math.round((c.ts[i] * sr) / hop), v.meta.f0.length - 1)]
      if (truth > 0) errs.push(Math.abs(cents(c.smooth[i], truth)))
    }
    assert.ok(median(errs) < 25, `smoothF0 is ${median(errs).toFixed(1)} cents from the true pitch (median)`)
    // the buffer form passes the same values
    const cb = collect(v.ch[0], sr, true)
    assert.deepEqual(cb.smooth, c.smooth)
    assert.deepEqual(cb.raw, c.raw)
  })

  test('on real speech, notes picked from smoothF0 flicker far less than from the cycle f0', { skip: NO_SPEECH }, () => {
    for (const b of [WOMAN, MAN]) {
      const c = collect(b.ch[0], b.sr)
      const s = steadiness(c)
      assert.ok(s.smoothFlips < 0.5 * s.rawFlips, `note changes: smooth ${s.smoothFlips}, raw ${s.rawFlips} over ${c.raw.length} cycles`)
      assert.ok(s.smoothStep < 0.5 * s.rawStep, `steps: smooth ${s.smoothStep.toFixed(1)}, raw ${s.rawStep.toFixed(1)} cents`)
    }
  })

  test('the second argument is still the cycle f0: a relative target equals shiftVoice exactly', () => {
    const sr = 48000
    const x = synthVoice(sr, 2, { f0: 150, jitter: 0.02, seed: 22 }).ch[0]
    const a = retuneVoice(x, sr, { targetFn: (t, f0) => f0 * Math.pow(2, 3 / 12) })
    const b = shiftVoice(x, sr, { semitones: 3 })
    assert.equal(maxAbsDiff(a, b), 0)
    // a target that ignores the new argument gives the same sound as before it existed
    const two = retuneVoice(x, sr, { targetFn: (t, f0) => f0 * 0.9 })
    const three = retuneVoice(x, sr, { targetFn: (t, f0, s) => (s > 0 ? f0 * 0.9 : 0) })
    assert.equal(maxAbsDiff(two, three), 0)
  })

  test('a hard snap decided on smoothF0 lands on its notes', () => {
    const sr = 48000
    const glide = synthVoice(sr, 3, { f0: (t) => 120 * Math.pow(2, t / 3), jitter: 0.02, seed: 23 }).ch[0]
    const y = retuneVoice(glide, sr, { targetFn: (t, f0, s) => hzOf(snapToScale(noteOf(s), 'major', 0)) })
    const off = []
    for (const f of f0Track(y, sr, { hopMs: 10 }).f0) if (f > 0) off.push(100 * Math.abs(noteOf(f) - snapToScale(noteOf(f), 'major', 0)))
    assert.ok(median(off) < 10, 'median ' + median(off).toFixed(1) + ' cents off the scale')
  })
})
