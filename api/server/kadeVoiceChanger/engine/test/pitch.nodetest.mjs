// test/pitch.nodetest.mjs - the pitch family (modules/pitch/*.js).
//
// What it checks:
// 1. Shape: every module passes core/params.js validateModuleShape, ids and
//    files agree, and every module is pitch.<file name>.
// 2. Robustness (CONTRACT section 4): 0-length input, pure silence, a single
//    click, stereo input, 8 kHz and 96 kHz, every number param at its min,
//    default and max, every choice option, and 30 s of speech: no NaN, no
//    Infinity, no exception, peak under 8, the right length (unless the
//    module warps) and the right channel count for its stereo mode.
// 3. Prove it (MODULES_PLAN section 1): pitch and formant ratios measured
//    with the independent rulers of test/measure.mjs (autocorrelation pitch,
//    cepstral envelope shift), durations, correction landing on scale notes,
//    hard snap against natural correction, vibrato rate and depth, cracks,
//    melody notes, harmony intervals and width, octaves, undertones, gases.
// 4. Real speech (24 kHz recordings of a real voice) when the files exist,
//    and synthetic speech at 48 kHz (test/fixtures.mjs synthVoice).
// 5. Speed per second of 48 kHz audio at default settings, against generous
//    bounds (other builders share the CPU); the numbers are printed as test
//    diagnostics.
//
// Run: node --test engine/test/pitch.nodetest.mjs (Node 24).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { synthVoice, impulse, silence } from './fixtures.mjs'
import { assertSane, medianF0, f0Track, timeIt, formantShiftSemitones, stereoCorrelation, rmsDb } from './measure.mjs'
import { resolveParams, validateModuleShape } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'

const DIR = fileURLToPath(new URL('../modules/pitch/', import.meta.url))
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort()
const MODS = {}
for (const f of FILES) {
  const m = (await import(pathToFileURL(join(DIR, f)).href)).default
  MODS[m.id] = m
}
const EXPECTED = [
  'pitch.voice', 'pitch.speed', 'pitch.tempo', 'pitch.vibrato', 'pitch.wobble', 'pitch.glide', 'pitch.flatten',
  'pitch.correct', 'pitch.harmony', 'pitch.octaver', 'pitch.subharmonic', 'pitch.jitter', 'pitch.arp', 'pitch.helium',
]

const SPEECH = [
  'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav',
  'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav',
]

function ctxOf(seed = 1) {
  const notes = []
  return { sr: 48000, rng: makeRng(seed), progress() {}, cancelled: () => false, note: (s) => notes.push(s), notes }
}

function copyBuf(b) {
  return { sr: b.sr, ch: b.ch.map((c) => Float32Array.from(c)) }
}

function run(id, input, p = {}, seed = 1) {
  const m = MODS[id]
  const rp = resolveParams(m, p, { strict: true })
  const c = ctxOf(seed)
  c.sr = input.sr
  return m.process(copyBuf(input), rp, c)
}

// p: the params the output was made with (defaults when left out), so the
// length can be judged as input + tail, the contract's rule
function checkOut(m, input, out, label, p = {}) {
  const info = assertSane(out)
  const nin = input.ch[0].length
  if (m.stereo === 'make') assert.equal(out.ch.length, 2, label + ': must be stereo')
  else if (m.stereo === 'mono') assert.equal(out.ch.length, 1, label + ': must be mono')
  else assert.equal(out.ch.length, input.ch.length, label + ': channel count must be kept')
  if (!m.warps) {
    const rp = resolveParams(m, p, { strict: true })
    const tail = typeof m.tail === 'function' ? Number(m.tail(rp, input.sr)) || 0 : 0
    assert.ok(tail >= 0 && tail < 30, label + ': tail ' + tail)
    assert.equal(info.length, nin + Math.round(tail * input.sr), label + ': length must be input + tail')
  }
  assert.equal(out.sr, input.sr, label + ': sample rate kept')
  return info
}

/** A sustained, vowel-like harmonic tone; f0 may be a function of seconds. */
function sustained(sr, seconds, f0 = 150, opts = {}) {
  const n = Math.round(sr * seconds)
  const x = new Float32Array(n)
  const f0fn = typeof f0 === 'function' ? f0 : () => f0
  const F = opts.formants || [700, 1220, 2600, 3400]
  const B = [110, 130, 180, 250]
  const amp = (hz) => {
    let a = 0.08
    for (let k = 0; k < F.length; k++) {
      const d = (hz - F[k]) / B[k]
      a += 1 / (1 + d * d)
    }
    return a / Math.sqrt(1 + hz / 300)
  }
  const rng = makeRng(opts.seed || 'sustained')
  let ph = 0
  let jit = 1
  const fade = Math.round(0.02 * sr)
  for (let i = 0; i < n; i++) {
    const f = f0fn(i / sr) * jit
    ph += (2 * Math.PI * f) / sr
    if (ph > 2 * Math.PI) {
      ph -= 2 * Math.PI
      jit = 1 + 0.002 * (rng.next() * 2 - 1)
    }
    let s = 0
    const K = Math.min(40, Math.floor((0.45 * sr) / f))
    for (let k = 1; k <= K; k++) s += amp(k * f) * Math.sin(k * ph)
    let g = 1
    if (i < fade) g = i / fade
    else if (i > n - fade) g = (n - i) / fade
    x[i] = 0.12 * s * g
  }
  return { sr, ch: [x] }
}

function loadSpeech(i, seconds = 6) {
  const path = SPEECH[i]
  if (!existsSync(path)) return null
  try {
    const b = decodeWav(new Uint8Array(readFileSync(path)))
    const n = Math.min(b.ch[0].length, Math.round(seconds * b.sr))
    return { sr: b.sr, ch: [b.ch[0].slice(0, n)] }
  } catch {
    return null
  }
}

/** Cents of each voiced frame relative to A 440, and the frames' f0. */
function centsTrack(buf, opts) {
  const tr = f0Track(buf, buf.sr, { hopMs: 5, ...(opts || {}) })
  const out = []
  for (let i = 0; i < tr.f0.length; i++) if (tr.f0[i] > 0) out.push({ i, hz: tr.f0[i], c: 1200 * Math.log2(tr.f0[i] / 440) })
  return out
}

function devFromGrid(cents, steps, key = 0) {
  // distance in cents to the nearest note of the scale
  const rel = (((cents / 100 + 9 - key) % 12) + 12) % 12 // semitones above the key note
  let best = Infinity
  for (const s of steps) for (const o of [-12, 0, 12]) best = Math.min(best, Math.abs(rel - (s + o)))
  return best * 100
}

/** Median absolute deviation from the median, scaled to match a deviation. */
function mad(a) {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  const med = s[s.length >> 1]
  const d = a.map((v) => Math.abs(v - med)).sort((x, y) => x - y)
  return 1.4826 * d[d.length >> 1]
}

function std(a) {
  if (!a.length) return 0
  let m = 0
  for (const v of a) m += v
  m /= a.length
  let s = 0
  for (const v of a) s += (v - m) * (v - m)
  return Math.sqrt(s / a.length)
}

/** Narrow-band energy (dB) around hz by direct correlation, Hann-windowed. */
function toneDb(sig, sr, hz, from = 0, to = sig.length) {
  let re = 0
  let im = 0
  let w2 = 0
  const n = to - from
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
    const v = sig[from + i] * w
    const ph = (2 * Math.PI * hz * (from + i)) / sr
    re += v * Math.cos(ph)
    im -= v * Math.sin(ph)
    w2 += w
  }
  const a = Math.sqrt(re * re + im * im) / (w2 || 1)
  return 20 * Math.log10(a + 1e-12)
}

const V48 = synthVoice(48000, 4, { f0: 140, seed: 3 })

// ---------------------------------------------------------------- shape

describe('pitch family shape', () => {
  test('every planned module exists, ids match files', () => {
    for (const id of EXPECTED) assert.ok(MODS[id], id + ' is missing')
    for (const f of FILES) {
      const id = 'pitch.' + f.replace(/\.js$/, '')
      assert.ok(MODS[id], f + ' must export ' + id)
      assert.equal(MODS[id].family, 'pitch')
    }
  })
  for (const id of EXPECTED) {
    test(id + ' passes validateModuleShape', () => {
      const problems = validateModuleShape(MODS[id])
      assert.deepEqual(problems, [])
      const m = MODS[id]
      assert.ok(m.params.length >= 1 && m.params.length <= 8, 'one to eight params')
      assert.equal(m.live, undefined, 'no live version this round')
    })
  }
})

// ---------------------------------------------------------------- robustness

describe('pitch family robustness', () => {
  const short = synthVoice(48000, 0.8, { f0: 160, seed: 7 })
  const stereoIn = (() => {
    const a = synthVoice(48000, 1, { f0: 130, seed: 11 }).ch[0]
    const b = synthVoice(48000, 1, { f0: 130, seed: 11 }).ch[0]
    for (let i = 0; i < b.length; i++) b[i] = 0.7 * b[i] + 0.02 * Math.sin(i * 0.01)
    return { sr: 48000, ch: [a, b] }
  })()
  for (const id of EXPECTED) {
    test(id + ': empty, silence, click, stereo, odd rates', () => {
      const m = MODS[id]
      const z = run(id, { sr: 48000, ch: [new Float32Array(0)] })
      assertSane(z)
      assert.equal(z.ch[0].length, 0)
      checkOut(m, silence(48000, 1), run(id, silence(48000, 1)), 'silence')
      checkOut(m, impulse(48000, 0.5, 0.2), run(id, impulse(48000, 0.5, 0.2)), 'click')
      checkOut(m, { sr: 48000, ch: [Float32Array.of(0.5)] }, run(id, { sr: 48000, ch: [Float32Array.of(0.5)] }), 'one sample')
      checkOut(m, stereoIn, run(id, stereoIn), 'stereo')
      const v8 = synthVoice(8000, 1, { f0: 150, seed: 2 })
      checkOut(m, v8, run(id, v8), '8 kHz')
      const v96 = synthVoice(96000, 0.6, { f0: 150, seed: 2 })
      checkOut(m, v96, run(id, v96), '96 kHz')
      // NaN and Infinity in the input are treated as silence
      const bad = copyBuf(short)
      bad.ch[0][100] = NaN
      bad.ch[0][200] = Infinity
      checkOut(m, bad, run(id, bad), 'non-finite input')
    })
    test(id + ': every param at min, default and max, every choice', () => {
      const m = MODS[id]
      for (const prm of m.params) {
        const vals = prm.type === 'number' ? [prm.min, prm.def, prm.max] : prm.type === 'bool' ? [true, false] : prm.options.map((o) => o.v)
        for (const v of vals) checkOut(m, short, run(id, short, { [prm.id]: v }), prm.id + '=' + v, { [prm.id]: v })
      }
      const lo = {}
      const hi = {}
      for (const prm of m.params) {
        if (prm.type !== 'number') continue
        lo[prm.id] = prm.min
        hi[prm.id] = prm.max
      }
      checkOut(m, short, run(id, short, lo), 'all min', lo)
      checkOut(m, short, run(id, short, hi), 'all max', hi)
    })
    test(id + ': deterministic', () => {
      const a = run(id, short, {}, 5)
      const b = run(id, short, {}, 5)
      assert.equal(a.ch.length, b.ch.length)
      for (let c = 0; c < a.ch.length; c++) assert.deepEqual(a.ch[c], b.ch[c])
    })
  }
  test('30 seconds of speech through every module at defaults', () => {
    const long = synthVoice(48000, 30, { f0: 150, seed: 21 })
    for (const id of EXPECTED) checkOut(MODS[id], long, run(id, long), id + ' 30 s')
  })
})

// ---------------------------------------------------------------- prove it

describe('pitch.voice', () => {
  test('moves pitch by the semitones asked, keeps the formants', () => {
    const f0In = medianF0(V48, 48000)
    const up = run('pitch.voice', V48, { semitones: 7 })
    const ratio = medianF0(up, 48000) / f0In
    assert.ok(Math.abs(ratio / Math.pow(2, 7 / 12) - 1) < 0.03, 'pitch ratio ' + ratio)
    assert.ok(Math.abs(formantShiftSemitones(V48, up, 48000)) < 1.2, 'formants stay')
    const down = run('pitch.voice', V48, { semitones: -12 })
    const r2 = medianF0(down, 48000, { minHz: 50 }) / f0In
    assert.ok(Math.abs(r2 / 0.5 - 1) < 0.04, 'octave down ratio ' + r2)
  })
  test('timbre moves the formants and not the pitch', () => {
    const f0In = medianF0(V48, 48000)
    const t = run('pitch.voice', V48, { formant: 4 })
    const st = formantShiftSemitones(V48, t, 48000)
    assert.ok(Math.abs(st - 4) < 1.3, 'formant shift ' + st)
    assert.ok(Math.abs(medianF0(t, 48000) / f0In - 1) < 0.03)
  })
  test('the smooth method shifts too', () => {
    const f0In = medianF0(V48, 48000)
    const up = run('pitch.voice', V48, { semitones: 5, mode: 'fast' })
    const ratio = medianF0(up, 48000) / f0In
    assert.ok(Math.abs(ratio / Math.pow(2, 5 / 12) - 1) < 0.03, 'ratio ' + ratio)
  })
  test('defaults change nothing (it is the macro stage)', () => {
    const o = run('pitch.voice', V48)
    assert.deepEqual(o.ch[0], V48.ch[0])
  })
})

describe('pitch.speed and pitch.tempo', () => {
  test('tape speed 2 halves the length and doubles the pitch', () => {
    const o = run('pitch.speed', V48, { speed: 2 })
    assert.ok(Math.abs(o.ch[0].length / V48.ch[0].length - 0.5) < 0.01)
    const r = medianF0(o, 48000) / medianF0(V48, 48000)
    assert.ok(Math.abs(r - 2) < 0.06, 'ratio ' + r)
  })
  test('tape speed 0.5 with motor wobble is about twice as long and an octave down', () => {
    const o = run('pitch.speed', V48, { speed: 0.5, wobble: 60 })
    const lr = o.ch[0].length / V48.ch[0].length
    assert.ok(Math.abs(lr - 2) < 0.1, 'length ratio ' + lr)
    const r = medianF0(o, 48000, { minHz: 40 }) / medianF0(V48, 48000)
    assert.ok(Math.abs(r - 0.5) < 0.04, 'ratio ' + r)
  })
  test('tempo 0.5 doubles the length and keeps the pitch', () => {
    const o = run('pitch.tempo', V48, { tempo: 0.5 })
    assert.ok(Math.abs(o.ch[0].length / V48.ch[0].length - 2) < 0.01)
    const r = medianF0(o, 48000) / medianF0(V48, 48000)
    assert.ok(Math.abs(r - 1) < 0.03, 'ratio ' + r)
  })
  test('tempo 2 halves the length', () => {
    const o = run('pitch.tempo', V48, { tempo: 2 })
    assert.ok(Math.abs(o.ch[0].length / V48.ch[0].length - 0.5) < 0.01)
  })
})

describe('pitch.vibrato and pitch.wobble', () => {
  const tone = sustained(48000, 3, 150)
  test('vibrato swings the pitch at its rate and depth', () => {
    const o = run('pitch.vibrato', tone, { rate: 6, depth: 100, delay: 0, throb: 0 })
    const ct = centsTrack(o).filter((f) => f.i * 0.005 > 0.3 && f.i * 0.005 < 2.7)
    const cs = ct.map((f) => f.c)
    const sd = std(cs)
    // a sine of 100 cents peak has a deviation of about 71 cents
    assert.ok(sd > 45 && sd < 100, 'deviation ' + sd)
    let m = 0
    for (const v of cs) m += v
    m /= cs.length
    let zc = 0
    for (let i = 1; i < cs.length; i++) if (cs[i - 1] - m < 0 !== cs[i] - m < 0) zc++
    const rate = zc / 2 / (cs.length * 0.005)
    assert.ok(Math.abs(rate - 6) < 1.2, 'rate ' + rate)
    const sdIn = std(centsTrack(tone).map((f) => f.c))
    assert.ok(sdIn < 10, 'input steady ' + sdIn)
  })
  test('vibrato waits for its onset delay', () => {
    const o = run('pitch.vibrato', tone, { rate: 6, depth: 100, delay: 1500, throb: 0 })
    const early = centsTrack(o).filter((f) => f.i * 0.005 > 0.1 && f.i * 0.005 < 1.3).map((f) => f.c)
    const late = centsTrack(o).filter((f) => f.i * 0.005 > 1.8 && f.i * 0.005 < 2.8).map((f) => f.c)
    assert.ok(std(early) < 12, 'steady before the delay ' + std(early))
    assert.ok(std(late) > 40, 'wavering after ' + std(late))
  })
  test('wobble wanders the pitch', () => {
    const o = run('pitch.wobble', tone, { depth: 150, speed: 2 })
    const sd = std(centsTrack(o).filter((f) => f.i * 0.005 > 0.2 && f.i * 0.005 < 2.8).map((f) => f.c))
    assert.ok(sd > 30, 'deviation ' + sd)
  })
})

describe('pitch.glide and pitch.flatten', () => {
  test('glide goes from the start pitch to the end pitch', () => {
    const tone = sustained(48000, 3, 150)
    const o = run('pitch.glide', tone, { from: 0, to: 12, curve: 'straight', timbre: 0 })
    const ct = centsTrack(o)
    const base = 1200 * Math.log2(150 / 440)
    const first = ct.filter((f) => f.i * 0.005 > 0.05 && f.i * 0.005 < 0.25).map((f) => f.c - base)
    const last = ct.filter((f) => f.i * 0.005 > 2.75 && f.i * 0.005 < 2.95).map((f) => f.c - base)
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]
    assert.ok(Math.abs(med(first) - 50) < 80, 'start ' + med(first))
    assert.ok(Math.abs(med(last) - 1150) < 80, 'end ' + med(last))
  })
  test('monotone flattens a melodic voice onto one note', () => {
    const melodic = synthVoice(48000, 3, { f0: (t) => 140 * Math.pow(2, 0.4 * Math.sin(2 * Math.PI * 0.7 * t)), seed: 4 })
    const sdIn = mad(centsTrack(melodic).map((f) => f.c))
    const o = run('pitch.flatten', melodic)
    const sdOut = mad(centsTrack(o).map((f) => f.c))
    assert.ok(sdIn > 150, 'input moves ' + sdIn)
    assert.ok(sdOut < 25, 'output flat ' + sdOut)
  })
  test('monotone at a set pitch sits on that pitch', () => {
    const o = run('pitch.flatten', V48, { target: 'set', hz: 220 })
    const f = medianF0(o, 48000)
    assert.ok(Math.abs(f / 220 - 1) < 0.02, 'f0 ' + f)
  })
  test('keep intonation leaves some melody', () => {
    const melodic = synthVoice(48000, 3, { f0: (t) => 140 * Math.pow(2, 0.4 * Math.sin(2 * Math.PI * 0.7 * t)), seed: 4 })
    const sdIn = mad(centsTrack(melodic).map((f) => f.c))
    const o = run('pitch.flatten', melodic, { keep: 50 })
    const sdOut = mad(centsTrack(o).map((f) => f.c))
    assert.ok(Math.abs(sdOut / sdIn - 0.5) < 0.15, 'kept ratio ' + sdOut / sdIn)
  })
})

describe('pitch.correct', () => {
  const glide = sustained(48000, 3, (t) => 150 * Math.pow(2, t / 3)) // one octave, slowly
  const MAJOR = [0, 2, 4, 5, 7, 9, 11]
  const CHROM = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  test('hard snap (retune 0) puts every frame on a note, in steps', () => {
    const o = run('pitch.correct', glide, { speed: 0 })
    const ct = centsTrack(o).filter((f) => f.i * 0.005 > 0.05 && f.i * 0.005 < 2.95)
    const near = ct.filter((f) => devFromGrid(f.c, CHROM) < 12).length / ct.length
    const ctIn = centsTrack(glide).filter((f) => f.i * 0.005 > 0.05 && f.i * 0.005 < 2.95)
    const nearIn = ctIn.filter((f) => devFromGrid(f.c, CHROM) < 12).length / ctIn.length
    assert.ok(near > 0.85, 'on notes ' + near)
    assert.ok(nearIn < 0.4, 'input glides ' + nearIn)
    // a staircase: about 12 distinct notes, each held
    const notes = new Set(ct.map((f) => Math.round(f.c / 100)))
    assert.ok(notes.size >= 11 && notes.size <= 14, 'notes ' + notes.size)
  })
  test('a major scale in a key uses only that scale', () => {
    const o = run('pitch.correct', glide, { key: 'D', scale: 'major', speed: 0 })
    const ct = centsTrack(o).filter((f) => f.i * 0.005 > 0.05 && f.i * 0.005 < 2.95)
    const onScale = ct.filter((f) => devFromGrid(f.c, MAJOR, 2) < 15).length / ct.length
    assert.ok(onScale > 0.85, 'on D major ' + onScale)
  })
  test('natural correction (80 ms) pulls an off note into tune but keeps vibrato', () => {
    // A3 sung 30 cents sharp with a gentle vibrato
    const sharp = sustained(48000, 3, (t) => 220 * Math.pow(2, (30 + 15 * Math.sin(2 * Math.PI * 5.5 * t)) / 1200))
    const hard = centsTrack(run('pitch.correct', sharp, { speed: 0 })).filter((f) => f.i * 0.005 > 0.5 && f.i * 0.005 < 2.8)
    const nat = centsTrack(run('pitch.correct', sharp, { speed: 80 })).filter((f) => f.i * 0.005 > 0.5 && f.i * 0.005 < 2.8)
    const inp = centsTrack(sharp).filter((f) => f.i * 0.005 > 0.5 && f.i * 0.005 < 2.8)
    const mean = (a) => a.reduce((s, f) => s + f.c, 0) / a.length
    const a3 = 1200 * Math.log2(220 / 440)
    assert.ok(Math.abs(mean(inp) - a3 - 30) < 8, 'input sharp')
    assert.ok(Math.abs(mean(hard) - a3) < 6, 'hard in tune ' + (mean(hard) - a3))
    assert.ok(Math.abs(mean(nat) - a3) < 12, 'natural in tune ' + (mean(nat) - a3))
    const sdH = std(hard.map((f) => f.c))
    const sdN = std(nat.map((f) => f.c))
    assert.ok(sdH < 6, 'hard is dead flat ' + sdH)
    assert.ok(sdN > sdH + 4, 'natural keeps some vibrato ' + sdN)
  })
  test('works on synthetic speech at 48 kHz', () => {
    const o = run('pitch.correct', V48, { speed: 0 })
    const ct = centsTrack(o)
    const near = ct.filter((f) => devFromGrid(f.c, CHROM) < 15).length / ct.length
    assert.ok(near > 0.75, 'on notes ' + near)
  })
})

describe('pitch.harmony', () => {
  const tone = sustained(48000, 2, 150)
  test('adds voices at the chord intervals, spread in stereo', () => {
    const o = run('pitch.harmony', tone, { chord: 'major', spread: 100 })
    assert.equal(o.ch.length, 2)
    const mid = new Float32Array(o.ch[0].length)
    for (let i = 0; i < mid.length; i++) mid[i] = 0.5 * (o.ch[0][i] + o.ch[1][i])
    const a = 48000 * 0.3
    const b = 48000 * 1.7
    for (const hz of [150 * Math.pow(2, 4 / 12), 150 * Math.pow(2, 7 / 12)]) {
      const dIn = toneDb(tone.ch[0], 48000, hz, a, b)
      const dOut = toneDb(mid, 48000, hz, a, b)
      assert.ok(dOut - dIn > 15, 'energy at ' + hz.toFixed(1) + ' Hz rose by ' + (dOut - dIn).toFixed(1))
    }
    assert.ok(stereoCorrelation(o) < 0.9, 'wide ' + stereoCorrelation(o))
  })
  test('mix 0 is the lead alone, mix 100 the harmony alone', () => {
    const o = run('pitch.harmony', tone, { mix: 0 })
    assert.deepEqual(o.ch[0], tone.ch[0])
    assert.deepEqual(o.ch[1], tone.ch[0])
    const w = run('pitch.harmony', tone, { chord: 'fifth-up', mix: 100, voices: 1 })
    const r = medianF0(w, 48000) / 150
    assert.ok(Math.abs(r - Math.pow(2, 7 / 12)) < 0.04, 'harmony only ' + r)
  })
  test('singers are separate people: each has its own timing and tuning', () => {
    // two singers on the same part, one hard left and one hard right: their
    // syllable envelopes are offset in time, and they are not copies
    const o = run('pitch.harmony', V48, { chord: 'unison', voices: 2, mix: 100, timing: 60, spread: 100 })
    const env = (s) => {
      const hop = 240 // 5 ms
      const e = new Float64Array(Math.floor(s.length / hop))
      for (let k = 0; k < e.length; k++) {
        let a = 0
        for (let i = k * hop; i < (k + 1) * hop; i++) a += s[i] * s[i]
        e[k] = Math.sqrt(a / hop)
      }
      return e
    }
    const eL = env(o.ch[0])
    const eR = env(o.ch[1])
    let best = -Infinity
    let bestLag = 0
    for (let lag = -20; lag <= 20; lag++) {
      let s = 0
      for (let k = 30; k < eL.length - 30; k++) s += eL[k] * eR[k + lag]
      if (s > best) {
        best = s
        bestLag = lag
      }
    }
    assert.ok(Math.abs(bestLag) >= 2, 'timing offset ' + bestLag * 5 + ' ms')
    assert.ok(stereoCorrelation(o) < 0.8, 'not copies ' + stereoCorrelation(o))
  })
  test('the late singers finish: the output runs on by the tail', () => {
    const m = MODS['pitch.harmony']
    for (const timing of [25, 80]) {
      const p = { chord: 'major', voices: 3, timing, mix: 100 }
      const o = run('pitch.harmony', tone, p)
      const tail = m.tail(resolveParams(m, p, { strict: true }), 48000)
      assert.ok(tail >= timing / 1000, 'tail ' + tail + ' covers the timing spread')
      const n = tone.ch[0].length
      assert.equal(o.ch[0].length, n + Math.round(tail * 48000))
      // the tone runs to the very end, so a late singer is still sounding
      // after the take ends
      let e = 0
      for (let i = n; i < o.ch[0].length; i++) e += o.ch[0][i] * o.ch[0][i] + o.ch[1][i] * o.ch[1][i]
      assert.ok(e > 0, 'something after the end at timing ' + timing)
      // and the very last samples have died away (nobody is cut off)
      const last = o.ch[0].length - 1
      assert.ok(Math.abs(o.ch[0][last]) < 1e-6 && Math.abs(o.ch[1][last]) < 1e-6, 'silent last sample')
    }
    // no timing spread or no singers: no tail
    assert.equal(m.tail(resolveParams(m, { timing: 0 }, { strict: true }), 48000), 0)
    assert.equal(m.tail(resolveParams(m, { mix: 0 }, { strict: true }), 48000), 0)
  })
})

describe('pitch.octaver and pitch.subharmonic', () => {
  const tone = sustained(48000, 2, 160)
  test('octave down and up land an octave away', () => {
    const d = run('pitch.octaver', tone, { down1: 100, dry: 0, timbre: 0 })
    const a = 48000 * 0.3
    const b = 48000 * 1.7
    const sub = toneDb(d.ch[0], 48000, 80, a, b) - toneDb(tone.ch[0], 48000, 80, a, b)
    assert.ok(sub > 25, 'energy at 80 Hz ' + sub)
    const u = run('pitch.octaver', tone, { up1: 100, dry: 0, down1: 0 })
    const r = medianF0(u, 48000) / 160
    assert.ok(Math.abs(r - 2) < 0.06, 'up ratio ' + r)
  })
  test('undertone puts energy at half the pitch', () => {
    const o = run('pitch.subharmonic', tone, { sub: 80, rough: 0, fry: 0, grit: 0 })
    const a = 48000 * 0.3
    const b = 48000 * 1.7
    for (const hz of [80, 240]) {
      const rise = toneDb(o.ch[0], 48000, hz, a, b) - toneDb(tone.ch[0], 48000, hz, a, b)
      assert.ok(rise > 15, hz + ' Hz rose by ' + rise.toFixed(1))
    }
  })
  test('creak drops the voice toward the fry register', () => {
    const o = run('pitch.subharmonic', V48, { sub: 0, rough: 0, fry: 100, grit: 0 })
    const f = medianF0(o, 48000, { minHz: 35 })
    assert.ok(f < 0.7 * medianF0(V48, 48000), 'fry pitch ' + f)
  })
  test('roughness makes the pitch irregular', () => {
    const steady = std(centsTrack(tone).map((f) => f.c))
    const o = run('pitch.subharmonic', tone, { sub: 0, rough: 100, fry: 0, grit: 0 })
    const rough = std(centsTrack(o).map((f) => f.c))
    assert.ok(rough > steady + 8, 'rough ' + rough + ' vs ' + steady)
  })
})

describe('pitch.jitter', () => {
  const tone = sustained(48000, 4, 150)
  test('cracks jump the voice up by about their size', () => {
    const o = run('pitch.jitter', tone, { rate: 2, size: 7, direction: 'up', tremble: 0, jitter: 0 })
    const ct = centsTrack(o)
    const base = 1200 * Math.log2(150 / 440)
    const up = ct.filter((f) => f.c - base > 400).length / ct.length
    const down = ct.filter((f) => f.c - base < -400).length / ct.length
    assert.ok(up > 0.08 && up < 0.6, 'time in cracks ' + up)
    assert.ok(down < 0.02, 'no down cracks ' + down)
    const od = run('pitch.jitter', tone, { rate: 2, size: 7, direction: 'down', tremble: 0, jitter: 0 })
    const ctd = centsTrack(od, { minHz: 50 })
    assert.ok(ctd.filter((f) => f.c - base < -400).length / ctd.length > 0.08, 'down cracks')
  })
  test('tremble and shakiness unsettle the pitch', () => {
    const o = run('pitch.jitter', tone, { rate: 0, tremble: 100, jitter: 40 })
    const sd = std(centsTrack(o).map((f) => f.c))
    assert.ok(sd > 15, 'deviation ' + sd)
  })
})

describe('pitch.arp', () => {
  test('sings on the notes of the chosen chord, several of them', () => {
    const tone = sustained(48000, 3, 200)
    const o = run('pitch.arp', tone, { key: 'A', notes: 'major', rate: 4, glide: 0, restart: false })
    const ct = centsTrack(o).filter((f) => f.i * 0.005 > 0.05 && f.i * 0.005 < 2.95)
    const onChord = ct.filter((f) => devFromGrid(f.c, [0, 4, 7], 9) < 25).length / ct.length
    assert.ok(onChord > 0.8, 'on A major ' + onChord)
    const notes = new Set(ct.map((f) => Math.round(f.c / 100)))
    assert.ok(notes.size >= 3, 'distinct notes ' + notes.size)
  })
  test('works on speech near the speaker pitch', () => {
    const o = run('pitch.arp', V48)
    const f = medianF0(o, 48000)
    const fin = medianF0(V48, 48000)
    assert.ok(f > fin * 0.6 && f < fin * 1.8, 'melody near the voice ' + f)
  })
})

describe('pitch.helium', () => {
  test('helium raises the formants and keeps the note', () => {
    const o = run('pitch.helium', V48)
    const st = formantShiftSemitones(V48, o, 48000)
    const want = 12 * Math.log2(1.6) * 0.85
    assert.ok(Math.abs(st - want) < 1.6, 'formant ' + st + ' want ' + want)
    assert.ok(Math.abs(medianF0(o, 48000) / medianF0(V48, 48000) - 1) < 0.03)
  })
  test('heavy gas lowers the formants and keeps the note', () => {
    const o = run('pitch.helium', V48, { gas: 'heavy' })
    const st = formantShiftSemitones(V48, o, 48000)
    assert.ok(st < -7, 'formant ' + st)
    assert.ok(Math.abs(medianF0(o, 48000) / medianF0(V48, 48000) - 1) < 0.03)
  })
})

// ---------------------------------------------------------------- real speech

describe('real speech', () => {
  const sp = loadSpeech(0)
  const sp2 = loadSpeech(1)
  test('every module at defaults on a real voice', { skip: !sp && 'speech file missing' }, () => {
    for (const id of EXPECTED) checkOut(MODS[id], sp, run(id, sp), id + ' real speech')
  })
  test('pitch.voice keeps its ratios on a real voice', { skip: !sp2 && 'speech file missing' }, () => {
    const f0In = medianF0(sp2, sp2.sr)
    const up = run('pitch.voice', sp2, { semitones: 5 })
    const r = medianF0(up, sp2.sr) / f0In
    assert.ok(Math.abs(r / Math.pow(2, 5 / 12) - 1) < 0.04, 'ratio ' + r)
  })
  test('pitch.correct snaps a real voice onto notes', { skip: !sp && 'speech file missing' }, () => {
    const o = run('pitch.correct', sp, { speed: 0 })
    const ct = centsTrack(o)
    const near = ct.filter((f) => devFromGrid(f.c, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) < 15).length / ct.length
    const ctIn = centsTrack(sp)
    const nearIn = ctIn.filter((f) => devFromGrid(f.c, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) < 15).length / ctIn.length
    // speech changes note every few tens of milliseconds, and the ruler's 40 ms
    // window blurs those steps, so a real voice reads lower than a held tone
    assert.ok(near > 0.6 && near > nearIn + 0.25, 'on notes ' + near + ' vs input ' + nearIn)
  })
  test('pitch.helium on a real voice moves the formants up', { skip: !sp && 'speech file missing' }, () => {
    const o = run('pitch.helium', sp)
    const st = formantShiftSemitones(sp, o, sp.sr)
    assert.ok(st > 4, 'formant ' + st)
    assert.ok(rmsDb(o) > rmsDb(sp) - 6, 'level kept')
  })
})

// ---------------------------------------------------------------- speed

describe('speed', () => {
  test('milliseconds per second of 48 kHz mono at defaults', (t) => {
    const x = synthVoice(48000, 10, { f0: 150, seed: 9 })
    const lines = []
    for (const id of EXPECTED) {
      const m = MODS[id]
      const ms = timeIt(() => run(id, x), 1) / 10
      lines.push(id + ' ' + ms.toFixed(1) + ' ms/s (cost ' + m.cost + ')')
      const bound = m.cost <= 2 ? 60 : m.cost <= 4 ? 300 : 1200
      assert.ok(ms < bound, id + ' took ' + ms.toFixed(1) + ' ms per second, bound ' + bound)
    }
    t.diagnostic(lines.join('; '))
  })
})
