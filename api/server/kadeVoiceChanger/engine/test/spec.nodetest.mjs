// test/spec.nodetest.mjs - the spectral family (modules/spec/*.js), proved by measurement.
//
// What it checks:
// 1. Shape: every module passes core/params.js validateModuleShape, its id
//    matches its file, and the two modules that take "the other sound"
//    declare side: true and offer the value 'side'.
// 2. Robustness (CONTRACT section 4): 0-length input, pure silence, a single
//    click, every number param at min, default and max, every choice and
//    switch, stereo in, 8 kHz and 96 kHz, and 30 s of real speech: no NaN, no
//    Infinity, no exceptions, peak under 8, lengths as declared (input plus
//    tail; times the stretch for the extreme stretch). Same seed, same output.
// 3. "Prove it" (MODULES_PLAN section 2), each with an independent ruler from
//    test/measure.mjs or this file: the robot is periodic at its buzz pitch;
//    the whisper loses its harmonics but keeps its vowels; freeze holds a
//    sound after it has stopped; shift, stretch and mirror move a sine to the
//    exact frequency the formula says; crystal leaves a sparse ringing
//    spectrum; the gate keeps or removes the strongest partial; the comb
//    concentrates noise on its teeth; the codec removes the high bands; the
//    glitchy call silences about the asked share of packets; the extreme
//    stretch lengthens by its factor at the same level; morph keeps the words
//    (a simplified STOI intelligibility score, Taal et al. 2011) while
//    sounding like its carrier, uses the other sound when given and notes the
//    fallback when not; blend runs from the voice to the other sound.
// 4. Live versions (spec.robot, spec.whisper): latency under 15 ms at 48 kHz,
//    the same output whatever the block size, outputs that alias inputs,
//    stereo, and the same proofs as offline.
// 5. Speed per second of 48 kHz audio against generous bounds (other builders
//    share the CPU); the numbers are printed as test diagnostics.
//
// Run: node --test engine/test/spec.nodetest.mjs (Node 24).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { synthVoice, sine, impulse, silence, noiseBuf } from './fixtures.mjs'
import { assertSane, medianF0, rmsDb, bandEnergyDb, timeIt, cfft, formantShiftSemitones } from './measure.mjs'
import { decodeWav } from '../core/wav.js'
import { makeRng } from '../core/rng.js'
import { resolveParams, validateModuleShape } from '../core/params.js'

const IDS = ['robot', 'whisper', 'freeze', 'blur', 'shift', 'stretch', 'invert', 'crystal', 'thin', 'comb', 'codec', 'dropout', 'paul', 'morph', 'blend']
const MODS = {}
for (const id of IDS) MODS[id] = (await import('../modules/spec/' + id + '.js')).default

const SPEECH = [
  'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav',
  'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav',
]
function loadSpeech(i) {
  try {
    if (!existsSync(SPEECH[i])) return null
    return decodeWav(new Uint8Array(readFileSync(SPEECH[i])))
  } catch {
    return null
  }
}

function ctxFor(sr, seed = 1, extra = {}) {
  const notes = []
  return {
    sr,
    rng: makeRng(seed),
    progress() {},
    cancelled: () => false,
    note: (m) => notes.push(m),
    notes,
    ...extra,
  }
}

function copyBuf(b) {
  return { sr: b.sr, ch: b.ch.map((c) => new Float32Array(c)) }
}

function run(id, buf, p = {}, ctx) {
  const mod = MODS[id]
  return mod.process(copyBuf(buf), resolveParams(mod, p), ctx || ctxFor(buf.sr))
}

function expectedLen(id, inLen, sr, p) {
  const mod = MODS[id]
  const rp = resolveParams(mod, p)
  if (id === 'paul') return Math.min(Math.round(inLen * rp.factor), Math.round(180 * sr))
  return inLen + Math.round(mod.tail(rp, sr) * sr)
}

function slice(sig, sr, a, b) {
  return sig.subarray(Math.round(a * sr), Math.round(b * sr))
}

/** Frequency of the strongest bin of a 32768-point Hann FFT taken from the middle. */
function peakHz(s, sr) {
  const N = Math.min(32768, 1 << Math.floor(Math.log2(Math.max(64, s.length))))
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const off = Math.max(0, Math.floor((s.length - N) / 2))
  for (let i = 0; i < N; i++) re[i] = (s[off + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
  cfft(re, im)
  let b = 1
  let bm = 0
  for (let k = 1; k < N / 2; k++) {
    const m = re[k] * re[k] + im[k] * im[k]
    if (m > bm) {
      bm = m
      b = k
    }
  }
  // parabolic refinement on the log magnitude
  const lm = (k) => Math.log(re[k] * re[k] + im[k] * im[k] + 1e-30)
  const a = lm(b - 1)
  const c = lm(b + 1)
  const d = lm(b)
  const den = a - 2 * d + c
  const off2 = den < 0 ? (0.5 * (a - c)) / den : 0
  return ((b + off2) * sr) / N
}

/** Long-term power spectrum (Hann, N points, 50 % overlap) of a signal. */
function powerSpectrum(s, N = 8192) {
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const ps = new Float64Array(N / 2 + 1)
  for (let s0 = 0; s0 + N <= s.length; s0 += N / 2) {
    for (let i = 0; i < N; i++) {
      re[i] = s[s0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
      im[i] = 0
    }
    cfft(re, im)
    for (let k = 0; k <= N / 2; k++) ps[k] += re[k] * re[k] + im[k] * im[k]
  }
  return ps
}

/** dB ratio of power near multiples of f0 to power halfway between them (harmonicity). */
function harmonicContrastDb(s, sr, f0, count = 12) {
  const N = 8192
  const ps = powerSpectrum(s, N)
  const bin = sr / N
  let on = 0
  let off = 0
  for (let h = 1; h <= count; h++) {
    const kOn = Math.round((h * f0) / bin)
    const kOff = Math.round(((h + 0.5) * f0) / bin)
    for (let d = -1; d <= 1; d++) {
      on += ps[kOn + d] || 0
      off += ps[kOff + d] || 0
    }
  }
  return 10 * Math.log10((on + 1e-30) / (off + 1e-30))
}

// ---------- a simplified STOI (Taal, Hendriks, Heusdens, Jensen 2011) ----------
// One-third-octave band envelopes (15 bands from 150 Hz), 25.6 ms frames at
// half overlap, silent clean frames removed, 30-frame segments, processed
// envelopes normalised and clipped at -15 dB SDR, correlation averaged.
function monoOf(x) {
  if (x instanceof Float32Array) return x
  if (x.ch.length === 1) return x.ch[0]
  const n = x.ch[0].length
  const m = new Float32Array(n)
  for (const c of x.ch) for (let i = 0; i < n; i++) m[i] += c[i] / x.ch.length
  return m
}
function bandEnvelopes(sig, sr) {
  let N = 1
  while (N < 0.0256 * sr) N <<= 1
  const hop = N >> 1
  const nf = Math.max(0, Math.floor((sig.length - N) / hop) + 1)
  const env = []
  for (let b = 0; b < 15; b++) env.push(new Float64Array(nf))
  const en = new Float64Array(nf)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let f = 0; f < nf; f++) {
    let e = 0
    for (let i = 0; i < N; i++) {
      re[i] = sig[f * hop + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N))
      im[i] = 0
      e += re[i] * re[i]
    }
    en[f] = e
    cfft(re, im)
    for (let b = 0; b < 15; b++) {
      const fc = 150 * Math.pow(2, b / 3)
      const k0 = Math.ceil((fc * Math.pow(2, -1 / 6) * N) / sr)
      const k1 = Math.floor((fc * Math.pow(2, 1 / 6) * N) / sr)
      let s = 0
      for (let k = k0; k <= k1 && k < N / 2; k++) s += re[k] * re[k] + im[k] * im[k]
      env[b][f] = Math.sqrt(s)
    }
  }
  return { env, en, nf }
}
function stoi(clean, proc, sr) {
  const a = bandEnvelopes(monoOf(clean), sr)
  const b = bandEnvelopes(monoOf(proc), sr)
  const nf = Math.min(a.nf, b.nf)
  let mx = 0
  for (let f = 0; f < nf; f++) mx = Math.max(mx, a.en[f])
  const keep = []
  for (let f = 0; f < nf; f++) if (a.en[f] > mx * 1e-4) keep.push(f)
  const J = 30
  const clip = 1 + Math.pow(10, 15 / 20)
  let tot = 0
  let cnt = 0
  const x = new Float64Array(J)
  const y = new Float64Array(J)
  for (let s = 0; s + J <= keep.length; s += 2) {
    for (let bd = 0; bd < 15; bd++) {
      let ex = 0
      let ey = 0
      for (let j = 0; j < J; j++) {
        x[j] = a.env[bd][keep[s + j]]
        y[j] = b.env[bd][keep[s + j]]
        ex += x[j] * x[j]
        ey += y[j] * y[j]
      }
      const g = ey > 0 ? Math.sqrt(ex / ey) : 0
      let mxv = 0
      let myv = 0
      for (let j = 0; j < J; j++) {
        y[j] = Math.min(y[j] * g, x[j] * clip)
        mxv += x[j]
        myv += y[j]
      }
      mxv /= J
      myv /= J
      let sxy = 0
      let sxx = 0
      let syy = 0
      for (let j = 0; j < J; j++) {
        const p = x[j] - mxv
        const q = y[j] - myv
        sxy += p * q
        sxx += p * p
        syy += q * q
      }
      if (sxx > 0 && syy > 0) {
        tot += sxy / Math.sqrt(sxx * syy)
        cnt++
      }
    }
  }
  return cnt ? tot / cnt : 0
}

const SR = 48000
const VOICE = synthVoice(SR, 3, { f0: 140, seed: 3 })
const VOICE1 = synthVoice(SR, 1.2, { f0: 160, seed: 4 })

// ======================================================================= shape

describe('spectral family: shape', () => {
  for (const id of IDS) {
    test(id + ' passes the module shape check', () => {
      const m = MODS[id]
      assert.deepEqual(validateModuleShape(m), [])
      assert.equal(m.id, 'spec.' + id)
      assert.equal(m.family, 'spec')
      assert.ok(m.params.length >= 2 && m.params.length <= 8, 'two to eight params')
    })
  }
  test('morph and blend take the other sound', () => {
    for (const id of ['morph', 'blend']) {
      const m = MODS[id]
      assert.equal(m.side, true)
      const src = m.params[0]
      assert.equal(src.type, 'choice')
      const opt = src.options.find((o) => o.v === 'side')
      assert.ok(opt, id + ' offers side')
      assert.equal(opt.name, 'The other sound')
      assert.equal(m.stereo, 'make')
    }
  })
  test('live versions exist for robot and whisper only where promised', () => {
    assert.ok(MODS.robot.live && MODS.whisper.live)
  })
})

// ======================================================================= robustness

describe('spectral family: robustness', () => {
  for (const id of IDS) {
    const mod = MODS[id]
    const outCh = (n) => (mod.stereo === 'make' ? 2 : mod.stereo === 'mono' ? 1 : n)

    test(id + ': empty, silence and a click', () => {
      for (const nch of [1, 2]) {
        const empty = { sr: SR, ch: Array.from({ length: nch }, () => new Float32Array(0)) }
        const o = run(id, empty)
        assert.equal(o.ch.length, outCh(nch))
        // an empty take comes back as just the tail (silence), or empty
        for (const c of o.ch) assert.equal(c.length, id === 'paul' ? 0 : expectedLen(id, 0, SR, {}))
        assertSane(o)
      }
      const sil = run(id, silence(SR, 0.5))
      const s = assertSane(sil)
      assert.ok(s.peak < 1e-3, 'silence stays silent, peak ' + s.peak)
      assert.equal(sil.ch[0].length, expectedLen(id, Math.round(0.5 * SR), SR, {}))
      const clk = run(id, impulse(SR, 0.5, 0.2))
      assertSane(clk)
      const tiny = run(id, { sr: SR, ch: [Float32Array.from([0.5, -0.5, 0.25])] })
      assertSane(tiny)
    })

    test(id + ': every setting at its ends, every choice', () => {
      const sets = [{}]
      const lo = {}
      const hi = {}
      for (const p of mod.params) {
        if (p.type === 'number') {
          lo[p.id] = p.min
          hi[p.id] = p.max
        }
      }
      if (id === 'paul') {
        hi.factor = 4 // the max stretch is covered below on a short take
      }
      sets.push(lo, hi)
      for (const p of mod.params) {
        if (p.type === 'choice') for (const o of p.options) sets.push({ [p.id]: o.v })
        if (p.type === 'bool') sets.push({ [p.id]: !p.def })
      }
      for (const ps of sets) {
        const o = run(id, VOICE1, ps)
        const s = assertSane(o)
        assert.equal(o.ch[0].length, expectedLen(id, VOICE1.ch[0].length, SR, ps), JSON.stringify(ps))
        assert.equal(o.ch.length, outCh(1))
        assert.ok(s.peak < 8, JSON.stringify(ps))
      }
      if (id === 'paul') {
        const short = { sr: SR, ch: [VOICE1.ch[0].subarray(0, SR / 4)] }
        const o = run(id, short, { factor: 50, window: 0.68 })
        assertSane(o)
        assert.equal(o.ch[0].length, Math.round((SR / 4) * 50))
      }
    })

    test(id + ': stereo in, other rates, same seed same sound', () => {
      const st = { sr: SR, ch: [new Float32Array(VOICE1.ch[0]), new Float32Array(VOICE1.ch[0]).reverse()] }
      const o = run(id, st)
      assertSane(o)
      assert.equal(o.ch.length, 2)
      for (const rate of [8000, 96000]) {
        const v = synthVoice(rate, 0.6, { f0: 130 })
        const r = run(id, v)
        assertSane(r)
        assert.equal(r.ch[0].length, expectedLen(id, v.ch[0].length, rate, {}))
      }
      const a = run(id, VOICE1, {}, ctxFor(SR, 7))
      const b = run(id, VOICE1, {}, ctxFor(SR, 7))
      assert.deepEqual(a.ch[0], b.ch[0])
    })
  }

  test('30 seconds of real speech through every module', (t) => {
    const sp = loadSpeech(0)
    if (!sp) {
      t.skip('speech file missing')
      return
    }
    const n = 30 * sp.sr
    const long = new Float32Array(n)
    for (let i = 0; i < n; i++) long[i] = sp.ch[0][i % sp.ch[0].length]
    const buf = { sr: sp.sr, ch: [long] }
    for (const id of IDS) {
      const ctx = ctxFor(sp.sr)
      const o = run(id, buf, {}, ctx)
      const s = assertSane(o)
      assert.ok(s.peak < 8, id)
      assert.equal(o.ch[0].length, expectedLen(id, n, sp.sr, {}), id)
      if (id === 'paul') assert.ok(ctx.notes.length >= 1, 'the three-minute cap is reported')
    }
  })
})

// ======================================================================= proofs

describe('spectral family: does what its name says', () => {
  test('robot: output is periodic at the buzz pitch, not the voice pitch', () => {
    for (const buzz of [110, 200]) {
      for (const frame of ['small', 'medium', 'large']) {
        const o = run('robot', VOICE, { pitch: buzz, frame })
        const f = medianF0(o.ch[0], SR)
        assert.ok(Math.abs(f - buzz) / buzz < 0.03, 'buzz ' + buzz + ' ' + frame + ' measured ' + f.toFixed(1))
      }
    }
    // level matched to the input
    const o = run('robot', VOICE)
    assert.ok(Math.abs(rmsDb(o) - rmsDb(VOICE)) < 1, 'robot level')
  })

  // Engine fix, Oct 22 2026: zero-phase pulses gave a 24 dB crest factor, so the
  // final limiter took about 8 dB off every robot chain. The dispersion keeps it
  // within 4 dB of the input's own crest factor at every setting.
  test("robot: crest factor within 4 dB of the input's, at every setting, with the spectrum kept", async () => {
    const crest = (s) => {
      let pk = 0
      let e = 0
      for (let i = 0; i < s.length; i++) {
        const v = Math.abs(s[i])
        if (v > pk) pk = v
        e += s[i] * s[i]
      }
      return 20 * Math.log10(pk / Math.sqrt(e / s.length))
    }
    const takes = [VOICE]
    const real = loadSpeech(0)
    if (real) takes.push({ sr: real.sr, ch: [real.ch[0].slice(0, Math.min(real.ch[0].length, 10 * real.sr))] })
    const settings = [{}, { pitch: 40, frame: 'small' }, { pitch: 60 }, { pitch: 190 }, { pitch: 400 }, { smooth: 0 }, { smooth: 100 }, { frame: 'small' }, { frame: 'large' }]
    for (const take of takes) {
      const cIn = crest(take.ch[0])
      for (const p of settings) {
        const o = run('robot', take, p)
        const c = crest(o.ch[0])
        assert.ok(c < cIn + 4, `${take.sr} Hz take, ${JSON.stringify(p)}: crest ${c.toFixed(1)} dB against the input's ${cIn.toFixed(1)} dB`)
        assert.ok(Math.abs(rmsDb(o.ch[0]) - rmsDb(take.ch[0])) < 1, 'level kept for ' + JSON.stringify(p))
      }
    }
    // the dispersion is an allpass: flat magnitude, so the robot's spectrum,
    // buzz pitch and level are untouched; only the timing inside each period moves
    const { dispersionFir } = await import('../modules/spec/robot.js')
    const D = 0.7 * (SR / 110)
    const fir = dispersionFir([VOICE.ch[0]], D)
    const n = 1 << Math.ceil(Math.log2(fir.h.length * 2))
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < fir.h.length; i++) re[i] = fir.h[i]
    cfft(re, im)
    let worst = 0
    for (let k = Math.ceil((50 / SR) * n); k < (0.45 * n); k++) worst = Math.max(worst, Math.abs(10 * Math.log10(re[k] * re[k] + im[k] * im[k])))
    assert.ok(worst < 0.5, 'the dispersion filter is not flat: ' + worst.toFixed(2) + ' dB')
    // and it really spreads: the group delay (relative to the centre) runs from
    // about -D/2 at the bottom of the voice's spectrum to about +D/2 at the top
    const gd = (k) => {
      let dp = Math.atan2(im[k + 1], re[k + 1]) - Math.atan2(im[k], re[k])
      dp -= 2 * Math.PI * Math.round(dp / (2 * Math.PI))
      return -dp / ((2 * Math.PI) / n) - fir.centre
    }
    const at = (hz) => {
      const k = Math.round((hz / SR) * n)
      let s = 0
      for (let j = -2; j <= 2; j++) s += gd(k + j)
      return s / 5
    }
    const g60 = at(60)
    const g10k = at(10000)
    assert.ok(g60 < -0.35 * D && g60 > -0.65 * D, 'group delay at 60 Hz ' + g60.toFixed(0) + ' samples for a span of ' + D.toFixed(0))
    assert.ok(g10k > 0.35 * D && g10k < 0.65 * D, 'group delay at 10 kHz ' + g10k.toFixed(0) + ' samples for a span of ' + D.toFixed(0))
    assert.equal(dispersionFir([new Float32Array(4800)], D), null, 'silence needs no filter')
    // a stereo take keeps one phase response on both sides
    const st = { sr: SR, ch: [VOICE.ch[0], VOICE.ch[0]] }
    const so = run('robot', st)
    let d = 0
    for (let i = 0; i < so.ch[0].length; i++) d = Math.max(d, Math.abs(so.ch[0][i] - so.ch[1][i]))
    assert.ok(d < 1e-6, 'left and right differ by ' + d)
  })

  test('whisper: harmonics gone, vowels kept', () => {
    const v = synthVoice(SR, 3, { f0: 150, seed: 5, intonation: 0, jitter: 0, breathiness: 0.02 })
    const o = run('whisper', v)
    const hIn = harmonicContrastDb(v.ch[0], SR, 150)
    const hOut = harmonicContrastDb(o.ch[0], SR, 150)
    assert.ok(hIn > 15, 'the test voice is clearly harmonic: ' + hIn.toFixed(1))
    assert.ok(hOut < 3, 'whisper has no harmonics left: ' + hOut.toFixed(1) + ' dB')
    const shift = formantShiftSemitones(v.ch[0], o.ch[0], SR)
    assert.ok(Math.abs(shift) < 1.5, 'formants stay put: ' + shift.toFixed(2) + ' semitones')
    assert.ok(Math.abs(rmsDb(o) - rmsDb(v)) < 1.5, 'whisper level')
    // half whisper keeps some harmonics
    const half = run('whisper', v, { amount: 50 })
    const hHalf = harmonicContrastDb(half.ch[0], SR, 150)
    assert.ok(hHalf > hOut + 3 && hHalf < hIn, 'half whisper sits between: ' + hHalf.toFixed(1))
  })

  test('freeze: a sound keeps ringing after it stops', () => {
    const n = Math.round(2.5 * SR)
    const x = new Float32Array(n)
    for (let i = 0; i < SR; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR)
    const o = run('freeze', { sr: SR, ch: [x] }, { when: 'steady', interval: 3000, hold: 1500, blend: 100 })
    const after = slice(o.ch[0], SR, 1.15, 1.4)
    assert.ok(rmsDb(after) > -25, 'frozen sound present after the input stopped: ' + rmsDb(after).toFixed(1))
    assert.ok(Math.abs(peakHz(after, SR) - 440) < 3, 'and it is the same note')
    const late = slice(o.ch[0], SR, 1.75, 2.4)
    assert.ok(rmsDb(late) < -60, 'and it lets go after the hold: ' + rmsDb(late).toFixed(1))
    // in speech, held syllables make the output ring through the pauses
    const sp = run('freeze', VOICE)
    assert.ok(sp.ch[0].length === VOICE.ch[0].length + Math.round(0.9 * SR))
  })

  test('blur: a lingering haze after each sound, none at amount 0', () => {
    const n = Math.round(2 * SR)
    const x = new Float32Array(n)
    for (let i = 0; i < 0.5 * SR; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / SR) * Math.min(1, i / 480)
    const o = run('blur', { sr: SR, ch: [x] }, { time: 1500, amount: 100 })
    const tail = slice(o.ch[0], SR, 0.7, 0.9)
    assert.ok(rmsDb(tail) > -40, 'haze after the tone: ' + rmsDb(tail).toFixed(1))
    const dry = run('blur', { sr: SR, ch: [x] }, { amount: 0 })
    assert.ok(rmsDb(slice(dry.ch[0], SR, 0.7, 0.9)) < -80, 'no haze at amount 0')
    let err = 0
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(dry.ch[0][i] - x[i]))
    assert.ok(err < 1e-4, 'amount 0 leaves the sound alone, error ' + err)
  })

  test('shift: every frequency moves by the same hertz', () => {
    for (const [f, hz] of [[1000, 250], [1000, -300], [440, 700]]) {
      for (const sr of [48000, 22050]) {
        const o = run('shift', sine(sr, 2, f, 0.5), { hz })
        const got = peakHz(o.ch[0], sr)
        assert.ok(Math.abs(got - (f + hz)) < 12, f + ' + ' + hz + ' at ' + sr + ' gave ' + got.toFixed(1))
        assert.ok(Math.abs(rmsDb(o) - rmsDb(sine(sr, 2, f, 0.5))) < 0.5, 'shift keeps the level')
      }
    }
    // harmonics stop being harmonic: 200 and 400 move to 450 and 650
    const two = new Float32Array(SR * 2)
    for (let i = 0; i < two.length; i++) two[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 400 * i) / SR)
    const o = run('shift', { sr: SR, ch: [two] }, { hz: 250 })
    const ps = powerSpectrum(o.ch[0])
    const at = (hz) => ps[Math.round((hz * 8192) / SR)]
    assert.ok(at(450) > 100 * at(400) && at(650) > 100 * at(800), 'partials at 450 and 650 Hz')
  })

  test('stretch: partials land on the power law, formants kept when asked', () => {
    for (const [f, a] of [[600, 1.3], [2000, 0.7], [1200, 1.5]]) {
      const o = run('stretch', sine(SR, 2, f, 0.5), { factor: a, formants: false })
      const want = 150 * Math.pow(f / 150, a)
      const got = peakHz(o.ch[0], SR)
      assert.ok(Math.abs(got - want) / want < 0.01, f + ' at ' + a + ': want ' + want.toFixed(1) + ' got ' + got.toFixed(1))
    }
    // the formant ruler needs dense partials; real speech gives it the most to hold on to
    const sp = loadSpeech(1)
    const ref = sp ? { sr: sp.sr, ch: [sp.ch[0].subarray(0, 8 * sp.sr)] } : VOICE
    const o = run('stretch', ref)
    const sh = formantShiftSemitones(ref.ch[0], o.ch[0], ref.sr)
    assert.ok(Math.abs(sh) < (sp ? 1 : 2), 'vowels kept: ' + sh.toFixed(2))
    const off = run('stretch', ref, { formants: false })
    const shOff = formantShiftSemitones(ref.ch[0], off.ch[0], ref.sr)
    assert.ok(shOff > sh + 2, 'without it the vowels move up: ' + shOff.toFixed(2))
    assert.ok(Math.abs(rmsDb(o) - rmsDb(ref)) < 3, 'stretch level')
  })

  test('invert: f becomes 2c - f', () => {
    for (const [f, c] of [[500, 1650], [300, 1000], [2500, 1650]]) {
      const o = run('invert', sine(SR, 2, f, 0.5), { hz: c })
      const got = peakHz(o.ch[0], SR)
      assert.ok(Math.abs(got - (2 * c - f)) < 8, f + ' around ' + c + ' gave ' + got.toFixed(1))
    }
    // and speech becomes hard to follow (that is the point of a scrambler)
    const sp = loadSpeech(0)
    if (sp) {
      const s6 = { sr: sp.sr, ch: [sp.ch[0].subarray(0, 8 * sp.sr)] }
      const o = run('invert', s6)
      assert.ok(stoi(s6, o, sp.sr) < 0.55, 'inverted speech is scrambled')
    }
  })

  test('crystal: a sparse ringing spectrum', () => {
    const v = VOICE
    const o = run('crystal', v, { peaks: 6, sparkle: 0 })
    // count bins within 30 dB of the frame peak, in 2048-point frames
    const count = (s) => {
      const N = 2048
      let tot = 0
      let frames = 0
      const re = new Float64Array(N)
      const im = new Float64Array(N)
      for (let s0 = SR / 2; s0 + N <= SR * 2.5; s0 += N) {
        for (let i = 0; i < N; i++) {
          re[i] = s[s0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
          im[i] = 0
        }
        cfft(re, im)
        let mx = 0
        for (let k = 1; k < N / 2; k++) mx = Math.max(mx, re[k] * re[k] + im[k] * im[k])
        for (let k = 1; k < N / 2; k++) if (re[k] * re[k] + im[k] * im[k] > mx * 1e-3) tot++
        frames++
      }
      return tot / frames
    }
    const cin = count(v.ch[0])
    const cout = count(o.ch[0])
    assert.ok(cout < cin * 0.6, 'fewer active bins: ' + cin.toFixed(0) + ' to ' + cout.toFixed(0))
    // rings after the input stops
    const n = Math.round(2 * SR)
    const x = new Float32Array(n)
    for (let i = 0; i < 0.5 * SR; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 660 * i) / SR)
    const r = run('crystal', { sr: SR, ch: [x] }, { sustain: 2000, sparkle: 0 })
    const after = slice(r.ch[0], SR, 0.7, 1.0)
    assert.ok(rmsDb(after) > -30, 'still ringing: ' + rmsDb(after).toFixed(1))
    assert.ok(Math.abs(peakHz(after, SR) - 660) < 3, 'at the same note')
    const sp = run('crystal', { sr: SR, ch: [x] }, { sustain: 2000, sparkle: 100 })
    const ps = powerSpectrum(slice(sp.ch[0], SR, 0.6, 1.2), 8192)
    const k = (hz) => ps[Math.round((hz * 8192) / SR)]
    assert.ok(k(1320) > 50 * k(1000), 'sparkle adds the octave above')
  })

  test('thin: keeps the loud partial or only the quiet rest', () => {
    const n = 2 * SR
    const tone = sine(SR, 2, 700, 0.4).ch[0]
    const nz = noiseBuf(SR, 2, 'white', 9, 1, 0.02).ch[0]
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = tone[i] + nz[i]
    const toneDb = (s) => bandEnergyDb(s, SR, 680, 720)
    const noiseDb = (s) => bandEnergyDb(s, SR, 2000, 10000)
    const loud = run('thin', { sr: SR, ch: [x] }, { keep: 'loud', threshold: -30 })
    const quiet = run('thin', { sr: SR, ch: [x] }, { keep: 'quiet', threshold: -30 })
    assert.ok(noiseDb(loud.ch[0]) < noiseDb(x) - 15, 'loud mode drops the noise')
    assert.ok(Math.abs(toneDb(loud.ch[0]) - toneDb(x)) < 1.5, 'loud mode keeps the tone')
    assert.ok(toneDb(quiet.ch[0]) < toneDb(x) - 20, 'quiet mode removes the tone')
    assert.ok(Math.abs(noiseDb(quiet.ch[0]) - noiseDb(x)) < 3, 'quiet mode keeps the noise')
  })

  test('comb: noise is pulled onto the teeth of the chord', () => {
    const nz = noiseBuf(SR, 3, 'pink', 4)
    const o = run('comb', nz, { base: 200, chord: 'one', ring: 0, sharpness: 70 })
    assert.ok(harmonicContrastDb(o.ch[0], SR, 200, 15) > 12, 'comb teeth on 200 Hz harmonics')
    assert.ok(Math.abs(harmonicContrastDb(nz.ch[0], SR, 200, 15)) < 3, 'plain noise has none')
    const r = run('comb', VOICE, { base: 220, chord: 'one', ring: 100 })
    assert.ok(harmonicContrastDb(r.ch[0], SR, 220, 15) > 12, 'ring mode sings the 220 Hz chord')
  })

  test('codec: high bands go, more of them at lower bitrates', () => {
    const v = { sr: SR, ch: [noiseBuf(SR, 2, 'pink', 2, 1, 1).ch[0]] }
    const hiIn = bandEnergyDb(v.ch[0], SR, 7500, 12000)
    const at12 = run('codec', v, { bitrate: 12, warble: 0 })
    const at64 = run('codec', v, { bitrate: 64, warble: 0 })
    assert.ok(bandEnergyDb(at12.ch[0], SR, 7500, 12000) < hiIn - 40, '12 kbps cuts above 6 kHz')
    assert.ok(bandEnergyDb(at64.ch[0], SR, 7500, 12000) > hiIn - 6, '64 kbps keeps them')
    const lowIn = bandEnergyDb(v.ch[0], SR, 300, 3000)
    assert.ok(Math.abs(bandEnergyDb(at12.ch[0], SR, 300, 3000) - lowIn) < 4, 'the speech band stays')
  })

  test('dropout: about the asked share of packets goes missing', () => {
    const x = sine(SR, 20, 300, 0.4)
    const pk = Math.round(0.02 * SR)
    const share = (o) => {
      let lost = 0
      let tot = 0
      for (let s0 = 0; s0 + pk <= o.ch[0].length; s0 += pk) {
        let e = 0
        for (let i = s0 + 200; i < s0 + pk - 200; i++) e += o.ch[0][i] * o.ch[0][i]
        if (e / (pk - 400) < 1e-6) lost++
        tot++
      }
      return lost / tot
    }
    for (const loss of [10, 30]) {
      const o = run('dropout', x, { loss, conceal: 'silence', burst: 60 })
      const got = share(o)
      assert.ok(Math.abs(got - loss / 100) < 0.08, 'loss ' + loss + ' measured ' + (got * 100).toFixed(1))
    }
    const rb = run('dropout', x, { loss: 30, conceal: 'robot' })
    assert.ok(share(rb) < 0.05, 'robot buzz fills the gaps')
    const rp = run('dropout', x, { loss: 30, conceal: 'repeat', burst: 40 })
    assert.ok(share(rp) < 0.05, 'repeats fill the gaps')
    const none = run('dropout', x, { loss: 0 })
    assert.deepEqual(none.ch[0], x.ch[0])
  })

  test('paul: as many times longer as asked, same level, smooth', () => {
    const o = run('paul', VOICE, { factor: 6 })
    assert.equal(o.ch[0].length, VOICE.ch[0].length * 6)
    // level over the stretched speech (skip the fade-in and fade-out)
    const mid = slice(o.ch[0], SR, 2, 16)
    const midIn = slice(VOICE.ch[0], SR, 2 / 6, 16 / 6)
    assert.ok(Math.abs(rmsDb(mid) - rmsDb(midIn)) < 3, 'level kept: ' + rmsDb(mid).toFixed(1) + ' vs ' + rmsDb(midIn).toFixed(1))
    // no gaps: every 100 ms block of the middle carries sound
    let quietBlocks = 0
    for (let t = 2; t < 16; t += 0.1) if (rmsDb(slice(o.ch[0], SR, t, t + 0.1)) < rmsDb(mid) - 25) quietBlocks++
    assert.ok(quietBlocks < 8, 'a continuous cloud, quiet blocks ' + quietBlocks)
  })

  test('morph: words stay clear while the sound changes', (t) => {
    const sp = loadSpeech(0)
    const buf = sp ? { sr: sp.sr, ch: [sp.ch[0].subarray(0, 8 * sp.sr)] } : VOICE
    const sr = buf.sr
    for (const carrier of ['wind', 'fire', 'organ', 'bells', 'ocean', 'crowd']) {
      const o = run('morph', buf, { carrier, background: -60 })
      assertSane(o)
      const s = stoi(buf, o, sr)
      t.diagnostic('morph ' + carrier + ' intelligibility (simplified STOI) ' + s.toFixed(3))
      assert.ok(s > 0.62, carrier + ' keeps the words: ' + s.toFixed(3))
    }
    // the whisperizer is the reference for "clearly intelligible noise speech"
    const w = run('whisper', buf)
    t.diagnostic('whisper intelligibility ' + stoi(buf, w, sr).toFixed(3))
  })

  test('morph: built from the other sound when given, notes the fallback when not', () => {
    const v = VOICE
    const n = v.ch[0].length
    // the other sound: a steady 1 kHz tone
    const tone = sine(SR, n / SR, 1000, 0.3)
    const withSide = run('morph', v, { carrier: 'side', background: -60 }, ctxFor(SR, 1, { side: tone }))
    const share = (o) => bandEnergyDb(o.ch[0], SR, 950, 1050) - rmsDb(o.ch[0])
    assert.ok(share(withSide) > -6, 'most of the sound sits on the tone: ' + share(withSide).toFixed(1))
    const ctx = ctxFor(SR, 1)
    const noSide = run('morph', v, { carrier: 'side' }, ctx)
    assertSane(noSide)
    assert.equal(ctx.notes.length, 1)
    assert.ok(/wind/.test(ctx.notes[0]))
    assert.ok(share(noSide) < share(withSide) - 10, 'the fallback is not the tone')
    // a short other sound is looped, a stereo one stays stereo
    const shortSt = { sr: 24000, ch: [sine(24000, 0.7, 500, 0.3).ch[0], sine(24000, 0.7, 700, 0.3).ch[0]] }
    const o = run('morph', v, { carrier: 'side', background: -60 }, ctxFor(SR, 1, { side: shortSt }))
    assertSane(o)
    assert.equal(o.ch[0].length, n)
    assert.ok(bandEnergyDb(o.ch[0], SR, 480, 520) > bandEnergyDb(o.ch[0], SR, 680, 720) + 10, 'left follows the left of the other sound')
    assert.ok(bandEnergyDb(o.ch[1], SR, 680, 720) > bandEnergyDb(o.ch[1], SR, 480, 520) + 10, 'right follows the right')
    // background keeps the plain sound under the words
    const bg = run('morph', v, { carrier: 'side', background: 0 }, ctxFor(SR, 1, { side: tone }))
    const pause = (o) => {
      let best = Infinity
      for (let t0 = 0.3; t0 < 2.6; t0 += 0.05) best = Math.min(best, rmsDb(slice(o.ch[0], SR, t0, t0 + 0.05)))
      return best
    }
    assert.ok(pause(bg) > pause(withSide) + 10, 'background fills the pauses')
  })

  test('blend: from the voice at 0 to the other sound at 100', () => {
    const v = VOICE
    const n = v.ch[0].length
    const tone = sine(SR, n / SR, 1000, 0.3)
    const zero = run('blend', v, { blend: 0 }, ctxFor(SR, 1, { side: tone }))
    let err = 0
    let ref = 0
    for (let i = 0; i < n; i++) {
      err += (zero.ch[0][i] - v.ch[0][i]) ** 2
      ref += v.ch[0][i] ** 2
    }
    assert.ok(10 * Math.log10(err / ref) < -40, 'blend 0 is the voice')
    const share = (o) => bandEnergyDb(o.ch[0], SR, 950, 1050) - rmsDb(o.ch[0])
    const full = run('blend', v, { blend: 100, envelope: 'both' }, ctxFor(SR, 1, { side: tone }))
    assert.ok(share(full) > -1.5, 'blend 100 from both is the other sound: ' + share(full).toFixed(2))
    const half = run('blend', v, { blend: 50 }, ctxFor(SR, 1, { side: tone }))
    const sh = share(half)
    assert.ok(sh > share(zero) + 3 && sh < share(full), 'half sits between: ' + sh.toFixed(1))
    // with the voice's envelope, the result keeps the voice's timing (silent in pauses)
    const corr = (a, b) => {
      const ea = []
      const eb = []
      for (let t0 = 0; t0 + 0.02 < n / SR; t0 += 0.02) {
        ea.push(rmsDb(slice(a, SR, t0, t0 + 0.02)))
        eb.push(rmsDb(slice(b, SR, t0, t0 + 0.02)))
      }
      const ma = ea.reduce((x, y) => x + Math.max(y, -90), 0) / ea.length
      const mb = eb.reduce((x, y) => x + Math.max(y, -90), 0) / eb.length
      let sab = 0
      let saa = 0
      let sbb = 0
      for (let i = 0; i < ea.length; i++) {
        const x = Math.max(ea[i], -90) - ma
        const y = Math.max(eb[i], -90) - mb
        sab += x * y
        saa += x * x
        sbb += y * y
      }
      return sab / Math.sqrt(saa * sbb)
    }
    assert.ok(corr(v.ch[0], half.ch[0]) > 0.8, 'follows the voice in time')
    const ctx = ctxFor(SR, 1)
    run('blend', v, {}, ctx)
    assert.equal(ctx.notes.length, 1, 'fallback noted')
  })
})

// ======================================================================= live

describe('spectral family: live versions', () => {
  for (const id of ['robot', 'whisper']) {
    const mod = MODS[id]
    const make = (sr, p = {}, seed = 3) => mod.live.create(sr, resolveParams(mod, p), makeRng(seed))
    const stream = (inst, chans, block) => {
      const n = chans[0].length
      const outs = chans.map(() => new Float32Array(n))
      for (let s0 = 0; s0 < n; s0 += block) {
        const m = Math.min(block, n - s0)
        inst.process(chans.map((c) => c.subarray(s0, s0 + m)), outs.map((c) => c.subarray(s0, s0 + m)), m)
      }
      return outs
    }

    test(id + ' live: latency under 15 ms', () => {
      for (const sr of [44100, 48000, 96000, 16000]) {
        const L = mod.live.latency(resolveParams(mod, {}), sr)
        assert.ok(L / sr < 0.015, sr + ': ' + L)
      }
      assert.equal(mod.live.latency(resolveParams(mod, {}), 48000), 512)
    })

    test(id + ' live: block size does not matter, outputs may alias inputs', () => {
      const x = VOICE.ch[0]
      const a = stream(make(SR), [x], 128)[0]
      const b = stream(make(SR), [x], 480)[0]
      const c = stream(make(SR), [x], 37)[0]
      assert.deepEqual(a, b)
      assert.deepEqual(a, c)
      const alias = new Float32Array(x)
      const inst = make(SR)
      for (let s0 = 0; s0 < alias.length; s0 += 128) {
        const v = alias.subarray(s0, Math.min(alias.length, s0 + 128))
        inst.process([v], [v], v.length)
      }
      assert.deepEqual(alias, a)
      assertSane({ sr: SR, ch: [a] })
    })

    test(id + ' live: stereo, settings changes and reset', () => {
      const inst = make(SR)
      const L = new Float32Array(VOICE.ch[0])
      const R = new Float32Array(VOICE.ch[0]).reverse()
      const outs = stream(inst, [L, R], 128)
      assertSane({ sr: SR, ch: outs })
      assert.ok(rmsDb(outs[1]) > -40)
      const p2 = resolveParams(mod, id === 'robot' ? { pitch: 300, mix: 50, smooth: 0 } : { amount: 30, brightness: 100 })
      inst.set(p2)
      const more = stream(inst, [L, R], 128)
      assertSane({ sr: SR, ch: more })
      inst.reset()
      const z = new Float32Array(4096)
      const q = stream(inst, [z, z], 128)
      assert.ok(Math.max(...q[0].map(Math.abs)) === 0, 'reset clears the state')
    })
  }

  test('robot live: periodic at the buzz pitch, near the offline level', () => {
    const inst = MODS.robot.live.create(SR, resolveParams(MODS.robot, { pitch: 130 }), makeRng(1))
    const x = synthVoice(SR, 4, { f0: 180, seed: 8 }).ch[0]
    const out = new Float32Array(x.length)
    for (let s0 = 0; s0 < x.length; s0 += 128) inst.process([x.subarray(s0, s0 + 128)], [out.subarray(s0, s0 + 128)], Math.min(128, x.length - s0))
    const f = medianF0(out, SR)
    assert.ok(Math.abs(f - 130) < 4, 'live buzz at ' + f.toFixed(1))
    const tail = out.subarray(SR * 2)
    assert.ok(Math.abs(rmsDb(tail) - rmsDb(x.subarray(SR * 2))) < 3, 'live level')
  })

  test('whisper live: harmonics gone', () => {
    const v = synthVoice(SR, 3, { f0: 150, seed: 5, intonation: 0, jitter: 0, breathiness: 0.02 }).ch[0]
    const inst = MODS.whisper.live.create(SR, resolveParams(MODS.whisper, {}), makeRng(1))
    const out = new Float32Array(v.length)
    for (let s0 = 0; s0 < v.length; s0 += 480) inst.process([v.subarray(s0, s0 + 480)], [out.subarray(s0, s0 + 480)], Math.min(480, v.length - s0))
    assert.ok(harmonicContrastDb(out, SR, 150) < 3, 'live whisper has no harmonics')
    assert.ok(Math.abs(rmsDb(out) - rmsDb(v)) < 2, 'live whisper level')
  })

  test('live speed: far faster than real time', (t) => {
    for (const id of ['robot', 'whisper']) {
      const inst = MODS[id].live.create(SR, resolveParams(MODS[id], {}), makeRng(1))
      const x = VOICE.ch[0]
      const out = new Float32Array(x.length)
      const ms = timeIt(() => {
        for (let s0 = 0; s0 < x.length; s0 += 128) inst.process([x.subarray(s0, s0 + 128)], [out.subarray(s0, s0 + 128)], Math.min(128, x.length - s0))
      })
      const perSec = ms / (x.length / SR)
      t.diagnostic(id + ' live: ' + perSec.toFixed(1) + ' ms per second of 48 kHz mono')
      assert.ok(perSec < 150, id + ' live ' + perSec.toFixed(1))
    }
  })
})

// ======================================================================= speed

describe('spectral family: speed', () => {
  test('milliseconds per second of 48 kHz mono speech', (t) => {
    const v = synthVoice(SR, 10, { f0: 150, seed: 11 })
    const rows = []
    for (const id of IDS) {
      const mod = MODS[id]
      const ms = timeIt(() => run(id, v), 2)
      const per = ms / 10
      rows.push(id + ' ' + per.toFixed(1))
      const bound = mod.cost <= 2 ? 60 : mod.cost <= 4 ? 400 : 1200
      assert.ok(per < bound, id + ' took ' + per.toFixed(1) + ' ms per second (cost ' + mod.cost + ')')
    }
    t.diagnostic(rows.join(', '))
  })
})
