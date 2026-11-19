// test/synthvoice.nodetest.mjs - tests for the synthvoice family:
// synth.vocoder, synth.lpc, synth.talkbox, synth.crossconv, synth.kazoo and
// synth.formantfilter (engine/modules/synth/).
//
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test engine/test/synthvoice.nodetest.mjs
//
// What is checked:
// 1. Shape: CONTRACT section 4 (validateModuleShape), the side-input choice
//    ("The other sound") on the three modules that take one, live presence.
// 2. Robustness: empty input, silence, a single click, every choice option,
//    every number at its minimum and maximum, stereo, odd sample rates;
//    always finite, peak under 8, same length and channel count; seeded
//    determinism; Math.random never called.
// 3. Prove it: the vocoder's pitch is the carrier's note, not the voice's;
//    its band envelopes follow the voice (an envelope-correlation ruler in
//    the manner of STOI, Taal et al. 2011); the talk box plays the note
//    source (held note, followed voice snapped to the scale, The other sound)
//    while its formants follow the input; the speech chip band-limits like
//    its hardware and keeps or flattens the pitch as asked; the cross
//    synthesis puts the voice into the other sound's spectrum; the kazoo
//    adds buzz without moving the pitch; the vowel filter really makes the
//    vowels it names.
// 4. Live: the live engines equal the offline output shifted by their
//    latency, survive in-place buffers, odd block sizes and parameter changes.
// 5. Speed against generous bounds (other builders share the CPU).
// Real speech (24 kHz, read-only) from "F:/Kade ai info/Fish talking listen
// (Oct 16)/" is used when present; those tests skip without it.
//
// The rulers come from test/measure.mjs (its own FFT and pitch tracker), plus
// two small envelope-correlation measures defined here on that FFT.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { resolveParams, validateModuleShape } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { synthVoice, impulse, silence, noiseBuf, loadWav } from './fixtures.mjs'
import { assertSane, medianF0, f0Track, spectralCentroid, bandEnergyDb, rmsDb, timeIt, cfft } from './measure.mjs'

import vocoder from '../modules/synth/vocoder.js'
import lpc from '../modules/synth/lpc.js'
import talkbox from '../modules/synth/talkbox.js'
import crossconv from '../modules/synth/crossconv.js'
import kazoo from '../modules/synth/kazoo.js'
import formantfilter from '../modules/synth/formantfilter.js'

const MODS = [vocoder, lpc, talkbox, crossconv, kazoo, formantfilter]
const LIVE = [vocoder, talkbox, kazoo, formantfilter]
const SIDE = [vocoder, talkbox, crossconv]
const SPEECH_A = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'
const SPEECH_B = 'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav'
const HAVE_SPEECH = existsSync(SPEECH_A) && existsSync(SPEECH_B)

// ---------------------------------------------------------------- helpers

function copyBuf(b) {
  return { sr: b.sr, ch: b.ch.map((c) => new Float32Array(c)) }
}

function run(mod, input, params = {}, extra = {}) {
  const p = resolveParams(mod, params)
  const notes = []
  const ctx = {
    sr: input.sr,
    rng: makeRng(extra.seed || 'test:' + mod.id),
    progress() {},
    cancelled() {
      return false
    },
    side: extra.side || null,
    note: (s) => notes.push(s),
  }
  const real = Math.random
  Math.random = () => {
    throw new Error(mod.id + ' called Math.random')
  }
  let out
  try {
    out = mod.process(copyBuf(input), p, ctx)
  } finally {
    Math.random = real
  }
  return { out, notes, p }
}

function voice(sr, seconds, opts = {}) {
  const v = synthVoice(sr, seconds, { seed: 'sv', ...opts })
  return { sr: v.sr, ch: v.ch }
}

/** A band-limited sawtooth (additive), as "The other sound". */
function sawBuf(sr, seconds, hz, amp = 0.3) {
  const n = Math.round(sr * seconds)
  const s = new Float32Array(n)
  const K = Math.floor((0.45 * sr) / hz)
  for (let k = 1; k <= K; k++) {
    const w = (2 * Math.PI * hz * k) / sr
    const a = amp / k
    for (let i = 0; i < n; i++) s[i] += a * Math.sin(w * i)
  }
  return { sr, ch: [s] }
}

function sinesBuf(sr, seconds, freqs, amp = 0.2) {
  const n = Math.round(sr * seconds)
  const s = new Float32Array(n)
  for (const f of freqs) {
    const w = (2 * Math.PI * f) / sr
    for (let i = 0; i < n; i++) s[i] += amp * Math.sin(w * i)
  }
  return { sr, ch: [s] }
}

function mono(b) {
  if (b.ch.length === 1) return b.ch[0]
  const n = b.ch[0].length
  const m = new Float32Array(n)
  for (const c of b.ch) for (let i = 0; i < n; i++) m[i] += c[i] / b.ch.length
  return m
}

// One-third-octave band magnitudes per 25.6 ms frame (hop 12.8 ms), 150 Hz to 3.8 kHz.
function thirdOctaveFrames(sig, sr) {
  const N0 = Math.round(0.0256 * sr)
  let N = 2
  while (N < N0) N <<= 1
  const hop = N0 >> 1
  const nf = Math.max(0, Math.floor((sig.length - N0) / hop))
  const nb = 15
  const lo = []
  const hi = []
  for (let q = 0; q < nb; q++) {
    const c = 150 * Math.pow(2, q / 3)
    lo.push(c * Math.pow(2, -1 / 6))
    hi.push(c * Math.pow(2, 1 / 6))
  }
  const w = new Float64Array(N0)
  for (let i = 0; i < N0; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N0)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const rows = []
  const energy = []
  for (let f = 0; f < nf; f++) {
    re.fill(0)
    im.fill(0)
    let e = 0
    for (let i = 0; i < N0; i++) {
      re[i] = sig[f * hop + i] * w[i]
      e += re[i] * re[i]
    }
    cfft(re, im)
    const row = new Float64Array(nb)
    for (let k = 1; k < N / 2; k++) {
      const fr = (k * sr) / N
      for (let q = 0; q < nb; q++) {
        if (fr >= lo[q] && fr < hi[q]) {
          row[q] += re[k] * re[k] + im[k] * im[k]
          break
        }
      }
    }
    for (let q = 0; q < nb; q++) row[q] = Math.sqrt(row[q])
    rows.push(row)
    energy.push(e)
  }
  return { rows, energy }
}

/**
 * Short-time envelope correlation of b against reference a, after STOI (Taal,
 * Hendriks, Heusdens and Jensen 2011): per band, 384 ms segments of band
 * envelopes, correlation averaged. 1 = same envelopes; noise near 0.
 */
function envCorr(a, b, sr) {
  const A = thirdOctaveFrames(a, sr)
  const B = thirdOctaveFrames(b, sr)
  const nf = Math.min(A.rows.length, B.rows.length)
  let mx = 0
  for (let f = 0; f < nf; f++) if (A.energy[f] > mx) mx = A.energy[f]
  const ka = []
  const kb = []
  for (let f = 0; f < nf; f++) {
    if (A.energy[f] > mx * 1e-4) {
      ka.push(A.rows[f])
      kb.push(B.rows[f])
    }
  }
  const L = 30
  const clipK = 1 + Math.pow(10, 15 / 20)
  let tot = 0
  let cnt = 0
  for (let s = 0; s + L <= ka.length; s += 2) {
    for (let q = 0; q < 15; q++) {
      const x = new Float64Array(L)
      const y = new Float64Array(L)
      let ex = 0
      let ey = 0
      for (let t = 0; t < L; t++) {
        x[t] = ka[s + t][q]
        y[t] = kb[s + t][q]
        ex += x[t] * x[t]
        ey += y[t] * y[t]
      }
      const al = Math.sqrt(ex / (ey + 1e-30))
      let mxx = 0
      let myy = 0
      for (let t = 0; t < L; t++) {
        y[t] = Math.min(y[t] * al, x[t] * clipK)
        mxx += x[t] / L
        myy += y[t] / L
      }
      let num = 0
      let d1 = 0
      let d2 = 0
      for (let t = 0; t < L; t++) {
        num += (x[t] - mxx) * (y[t] - myy)
        d1 += (x[t] - mxx) ** 2
        d2 += (y[t] - myy) ** 2
      }
      tot += num / Math.sqrt(d1 * d2 + 1e-30)
      cnt++
    }
  }
  return cnt ? tot / cnt : 0
}

/** Mean per-frame correlation of log band shapes (loudness removed): does b have a's vowels? */
function shapeCorr(a, b, sr) {
  const A = thirdOctaveFrames(a, sr)
  const B = thirdOctaveFrames(b, sr)
  const nf = Math.min(A.rows.length, B.rows.length)
  let mx = 0
  for (let f = 0; f < nf; f++) if (A.energy[f] > mx) mx = A.energy[f]
  let tot = 0
  let cnt = 0
  for (let f = 0; f < nf; f++) {
    if (!(A.energy[f] > mx * 1e-2)) continue
    const x = Array.from(A.rows[f], (v) => Math.log(v + 1e-9))
    const y = Array.from(B.rows[f], (v) => Math.log(v + 1e-9))
    const mxv = x.reduce((s, v) => s + v, 0) / x.length
    const myv = y.reduce((s, v) => s + v, 0) / y.length
    let num = 0
    let d1 = 0
    let d2 = 0
    for (let q = 0; q < x.length; q++) {
      num += (x[q] - mxv) * (y[q] - myv)
      d1 += (x[q] - mxv) ** 2
      d2 += (y[q] - myv) ** 2
    }
    tot += num / Math.sqrt(d1 * d2 + 1e-30)
    cnt++
  }
  return cnt ? tot / cnt : 0
}

function near(actual, expected, rel, what) {
  assert.ok(Math.abs(actual - expected) <= rel * expected, what + ': ' + actual.toFixed(2) + ' is not within ' + (rel * 100).toFixed(0) + ' percent of ' + expected.toFixed(2))
}

/** Interquartile range of the voiced pitch in semitones (robust to the ruler's octave slips). */
function semitoneSpread(track) {
  const v = []
  for (let i = 0; i < track.f0.length; i++) if (track.f0[i] > 0) v.push(12 * Math.log2(track.f0[i]))
  if (v.length < 4) return 0
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length * 0.75)] - v[Math.floor(v.length * 0.25)]
}

// ---------------------------------------------------------------- 1. shape

describe('synthvoice shape', () => {
  for (const mod of MODS) {
    test(mod.id + ' passes the contract shape check', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'synth')
      assert.ok(mod.params.length >= 2)
    })
  }
  for (const mod of SIDE) {
    test(mod.id + ' offers The other sound, after a built-in first choice', () => {
      assert.equal(mod.side, true)
      const choice = mod.params.find((q) => q.type === 'choice' && q.options.some((o) => o.v === 'side'))
      assert.ok(choice, 'no choice offers the other sound')
      const opt = choice.options.find((o) => o.v === 'side')
      assert.equal(opt.name, 'The other sound')
      assert.notEqual(choice.options[0].v, 'side')
    })
  }
  for (const mod of LIVE) {
    test(mod.id + ' has a live version', () => {
      assert.equal(typeof mod.live.create, 'function')
      for (const sr of [8000, 44100, 48000, 96000]) {
        const l = mod.live.latency(resolveParams(mod, {}), sr)
        assert.ok(Number.isInteger(l) && l >= 0 && l < 0.05 * sr, 'latency ' + l)
      }
    })
  }
})

// ---------------------------------------------------------------- 2. robustness

describe('synthvoice robustness', () => {
  const v48 = voice(48000, 0.7, { f0: 150 })
  const v22 = voice(22050, 0.7, { f0: 210, seed: 'sv22' })
  for (const mod of MODS) {
    test(mod.id + ': empty, silence and a click', () => {
      const empty = { sr: 48000, ch: [new Float32Array(0)] }
      const r0 = run(mod, empty)
      assert.equal(r0.out.ch[0].length, 0)
      const quiet = run(mod, silence(48000, 0.5)).out
      const s = assertSane(quiet)
      assert.equal(s.length, 24000)
      assert.ok(s.peak < 1e-3, 'silence came out at peak ' + s.peak)
      const click = run(mod, impulse(48000, 0.5, 0.1)).out
      assertSane(click)
      assert.equal(click.ch[0].length, 24000)
    })
    test(mod.id + ': every choice option', () => {
      for (const q of mod.params) {
        if (q.type !== 'choice') continue
        for (const o of q.options) {
          const src = o.v === 'side' ? sawBuf(48000, 0.7, 220) : null
          const input = q.id === 'key' || q.id === 'scale' ? v22 : v48
          const { out } = run(mod, input, { [q.id]: o.v }, { side: src ? { sr: input.sr, ch: [src.ch[0].subarray(0, input.ch[0].length)] } : null })
          const s = assertSane(out)
          assert.equal(s.length, input.ch[0].length, q.id + '=' + o.v + ' changed the length')
          assert.equal(out.ch.length, 1)
        }
      }
    })
    test(mod.id + ': every number at its minimum, and at its maximum', () => {
      for (const end of ['min', 'max']) {
        const params = {}
        for (const q of mod.params) if (q.type === 'number') params[q.id] = q[end]
        const s = assertSane(run(mod, v48, params).out)
        assert.equal(s.length, v48.ch[0].length)
        for (const q of mod.params) {
          if (q.type !== 'number') continue
          assertSane(run(mod, v22, { [q.id]: q[end] }).out)
        }
      }
    })
    test(mod.id + ': stereo in, stereo out; odd sample rates', () => {
      const st = { sr: 48000, ch: [new Float32Array(v48.ch[0]), new Float32Array(v48.ch[0].map((x, i) => (i > 100 ? v48.ch[0][i - 100] : 0)))] }
      const out = run(mod, st).out
      assertSane(out)
      assert.equal(out.ch.length, 2)
      for (const sr of [8000, 11025, 44100, 96000]) {
        const v = voice(sr, 0.5, { f0: 170 })
        const o = run(mod, v).out
        const s = assertSane(o)
        assert.equal(s.length, v.ch[0].length, 'length at ' + sr)
        assert.ok(rmsDb(o) > -60, mod.id + ' went silent at ' + sr + ' Hz')
      }
    })
    test(mod.id + ': the same seed gives the same sound', () => {
      const a = run(mod, v48, {}, { seed: 7 }).out
      const b = run(mod, v48, {}, { seed: 7 }).out
      assert.deepEqual(a.ch[0], b.ch[0])
    })
  }
  for (const mod of SIDE) {
    test(mod.id + ': without the other sound it falls back and says so', () => {
      const choice = mod.params.find((q) => q.type === 'choice' && q.options.some((o) => o.v === 'side'))
      const r = run(mod, v48, { [choice.id]: 'side' })
      assertSane(r.out)
      assert.ok(rmsDb(r.out) > -40, 'fallback went silent')
      assert.equal(r.notes.length, 1)
      assert.match(r.notes[0], /other sound/)
    })
  }
})

// ---------------------------------------------------------------- 3. prove it

describe('synth.vocoder does what its name says', () => {
  const v = voice(48000, 2.5, { f0: 140 })
  test('its pitch is the carrier note, not the voice', () => {
    const a3 = run(vocoder, v, { chord: 'single', key: 'a', register: 'middle' }).out
    near(medianF0(a3, 48000, { minHz: 50, maxHz: 600 }), 220, 0.03, 'one note on A')
    const c2 = run(vocoder, v, { chord: 'single', key: 'c', register: 'low', carrier: 'square' }).out
    near(medianF0(c2, 48000, { minHz: 40, maxHz: 400 }), 65.41, 0.03, 'one note on low C')
  })
  test('its band envelopes follow the voice', () => {
    const other = voice(48000, 2.5, { f0: 140, seed: 'another talker', vowels: ['o', 'i', 'a', 'u', 'e'] })
    const out = mono(run(vocoder, v).out)
    const mine = envCorr(v.ch[0], out, 48000)
    const theirs = envCorr(other.ch[0], out, 48000)
    assert.ok(mine > 0.5, 'envelope correlation ' + mine.toFixed(3))
    assert.ok(mine > theirs + 0.25, 'own ' + mine.toFixed(3) + ' against another talker ' + theirs.toFixed(3))
  })
  test('The other sound carries its own pitch', () => {
    const side = sawBuf(48000, 2.5, 330)
    const out = run(vocoder, v, { carrier: 'side' }, { side }).out
    near(medianF0(out, 48000, { minHz: 60, maxHz: 800 }), 330, 0.03, 'other sound at 330 Hz')
  })
  test('the real consonants pass through, above the top band', () => {
    // the bands stop at 7.6 kHz; the "s" above that comes only from the pass-through
    const on = run(vocoder, v, { consonants: 100 }).out
    const off = run(vocoder, v, { consonants: 0 }).out
    const eOn = bandEnergyDb(mono(on), 48000, 9000, 16000)
    const eOff = bandEnergyDb(mono(off), 48000, 9000, 16000)
    assert.ok(eOn > eOff + 10, 'consonants on ' + eOn.toFixed(1) + ' dB, off ' + eOff.toFixed(1) + ' dB')
  })
})

describe('synth.talkbox does what its name says', () => {
  const v = voice(48000, 2.5, { f0: 180 })
  test('a held note plays that note whatever the voice does', () => {
    const out = run(talkbox, v, { notes: 'held', key: 'a', register: 'middle' }).out
    near(medianF0(out, 48000, { minHz: 60, maxHz: 500 }), 110, 0.03, 'held A')
  })
  test('follow my voice snaps the voice to the key and scale', () => {
    const g = voice(48000, 2.5, { f0: 196, intonation: 0 })
    near(medianF0(run(talkbox, g).out, 48000, { minHz: 80, maxHz: 600 }), 196, 0.03, 'G in A minor pentatonic')
    const bb = voice(48000, 2.5, { f0: 233.08, intonation: 0 })
    near(medianF0(run(talkbox, bb).out, 48000, { minHz: 80, maxHz: 600 }), 220, 0.03, 'B flat snapped to A')
  })
  test('the instrument says the input vowels', () => {
    const other = voice(48000, 2.5, { f0: 180, seed: 'another talker', vowels: ['u', 'a', 'i', 'o', 'e'] })
    const out = mono(run(talkbox, v, { notes: 'chord' }).out)
    const mine = shapeCorr(v.ch[0], out, 48000)
    const theirs = shapeCorr(other.ch[0], out, 48000)
    assert.ok(mine > 0.55, 'vowel shape correlation ' + mine.toFixed(3))
    assert.ok(mine > theirs + 0.15, 'own ' + mine.toFixed(3) + ' against another talker ' + theirs.toFixed(3))
    const env = envCorr(v.ch[0], out, 48000)
    assert.ok(env > 0.5, 'envelope correlation ' + env.toFixed(3))
  })
  test('The other sound becomes the talking instrument', () => {
    const side = sawBuf(48000, 2.5, 330)
    const out = run(talkbox, v, { instrument: 'side' }, { side }).out
    near(medianF0(out, 48000, { minHz: 60, maxHz: 800 }), 330, 0.03, 'other sound at 330 Hz')
  })
  test('the riff and the chord changes move between notes in time', () => {
    for (const notes of ['riff', 'changes', 'arp']) {
      const out = run(talkbox, voice(48000, 5, { f0: 150, fricatives: false }), { notes, tempo: 120 }).out
      const tr = f0Track(out, 48000, { minHz: 60, maxHz: 900 })
      const seen = new Set()
      for (let i = 0; i < tr.f0.length; i++) if (tr.f0[i] > 0) seen.add(Math.round(12 * Math.log2(tr.f0[i] / 440)))
      assert.ok(seen.size >= 3, notes + ' played only ' + seen.size + ' notes')
    }
  })
})

describe('synth.lpc does what its name says', () => {
  const v = voice(48000, 2.5, { f0: 130 })
  test('the secure phone is a 4 kHz-wide coder', () => {
    const out = mono(run(lpc, v, { chip: 'secure' }).out)
    const inBand = bandEnergyDb(out, 48000, 300, 3400)
    const above = bandEnergyDb(out, 48000, 4500, 20000)
    assert.ok(inBand - above > 30, 'in band ' + inBand.toFixed(1) + ' dB, above 4.5 kHz ' + above.toFixed(1) + ' dB')
  })
  test('the toy keeps the pitch; monotone flattens it', () => {
    const into = voice(48000, 3, { f0: (t) => 120 * Math.pow(2, Math.sin(2 * Math.PI * 0.5 * t) * 0.25) })
    const out = run(lpc, into).out
    const fi = medianF0(into, 48000, { minHz: 60, maxHz: 400 })
    near(medianF0(out, 48000, { minHz: 60, maxHz: 400 }), fi, 0.08, 'toy pitch')
    const spreadIn = semitoneSpread(f0Track(into, 48000, { minHz: 60, maxHz: 400 }))
    const flat = run(lpc, into, { source: 'monotone' }).out
    const spreadFlat = semitoneSpread(f0Track(flat, 48000, { minHz: 60, maxHz: 400 }))
    assert.ok(spreadIn > 1, 'the test voice should glide (' + spreadIn.toFixed(2) + ')')
    assert.ok(spreadFlat < 0.35 * spreadIn, 'monotone spread ' + spreadFlat.toFixed(2) + ' semitones against ' + spreadIn.toFixed(2))
    const up = run(lpc, v, { pitch: 7 }).out
    near(medianF0(up, 48000, { minHz: 60, maxHz: 500 }), 130 * Math.pow(2, 7 / 12), 0.08, 'pitch up a fifth')
  })
  test('the words survive the chip', () => {
    for (const chip of ['toy', 'secure', 'arcade']) {
      const out = mono(run(lpc, v, { chip }).out)
      const c = envCorr(v.ch[0], out, 48000)
      assert.ok(c > 0.5, chip + ' envelope correlation ' + c.toFixed(3))
    }
  })
})

describe('synth.crossconv does what its name says', () => {
  const v = voice(48000, 2.5, { f0: 160 })
  test('at full amount the voice takes the other sound spectrum', () => {
    const freqs = [500, 1250, 3100]
    const side = sinesBuf(48000, 2.5, freqs)
    const out = mono(run(crossconv, v, { source: 'side', amount: 100, smoothing: 0 }, { side }).out)
    const ratio = (sig) => {
      let on = -200
      let off = -200
      const lin = (db) => Math.pow(10, db / 10)
      let eOn = 0
      for (const f of freqs) eOn += lin(bandEnergyDb(sig, 48000, f * 0.95, f * 1.05))
      const eAll = lin(bandEnergyDb(sig, 48000, 300, 4000))
      on = 10 * Math.log10(eOn + 1e-20)
      off = 10 * Math.log10(Math.max(eAll - eOn, 1e-20))
      return on - off
    }
    const rin = ratio(v.ch[0])
    const rout = ratio(out)
    assert.ok(rout > rin + 10, 'energy on the other sound partials: in ' + rin.toFixed(1) + ' dB, out ' + rout.toFixed(1) + ' dB')
    // and it still moves with the voice
    assert.ok(envCorr(v.ch[0], out, 48000) > 0.3)
  })
  test('at zero amount the voice is itself', () => {
    const out = mono(run(crossconv, v, { amount: 0 }).out)
    assert.ok(envCorr(v.ch[0], out, 48000) > 0.95)
    assert.ok(Math.abs(rmsDb(out) - rmsDb(v.ch[0])) < 1.5)
  })
  test('every built-in sound changes the voice and keeps its rhythm', () => {
    const src = crossconv.params.find((q) => q.id === 'source')
    for (const o of src.options) {
      if (o.v === 'side') continue
      const out = mono(run(crossconv, v, { source: o.v }).out)
      const c = envCorr(v.ch[0], out, 48000)
      assert.ok(c > 0.35, o.v + ' envelope correlation ' + c.toFixed(3))
      assert.ok(shapeCorr(v.ch[0], out, 48000) < 0.97, o.v + ' left the voice unchanged')
    }
  })
})

describe('synth.kazoo does what its name says', () => {
  const v = voice(48000, 2.5, { f0: 150 })
  test('it buzzes (more upper harmonics) and keeps the pitch', () => {
    const out = run(kazoo, v).out
    const ci = spectralCentroid(v.ch[0], 48000)
    const co = spectralCentroid(mono(out), 48000)
    assert.ok(co > 1.4 * ci, 'centroid ' + ci.toFixed(0) + ' to ' + co.toFixed(0))
    near(medianF0(out, 48000, { minHz: 60, maxHz: 500 }), medianF0(v, 48000, { minHz: 60, maxHz: 500 }), 0.05, 'kazoo pitch')
    const comb = spectralCentroid(mono(run(kazoo, v, { type: 'comb' }).out), 48000)
    const giant = spectralCentroid(mono(run(kazoo, v, { type: 'giant' }).out), 48000)
    assert.ok(comb > giant * 1.3, 'comb ' + comb.toFixed(0) + ' should be brighter than giant ' + giant.toFixed(0))
    const less = spectralCentroid(mono(run(kazoo, v, { buzz: 0 }).out), 48000)
    assert.ok(co > less, 'more buzz should be brighter')
  })
})

describe('synth.formantfilter does what its name says', () => {
  test('ah then ee: the formants of each vowel stand out', () => {
    const sr = 22050
    const nz = noiseBuf(sr, 4, 'pink', 3)
    const out = mono(run(formantfilter, nz, { pattern: 'ai', rate: 0.5, glide: 0, resonance: 80 }).out)
    const seg = (a, b) => out.subarray(Math.round(a * sr), Math.round(b * sr))
    const ah = seg(0.3, 1.8)
    const ee = seg(2.3, 3.8)
    // "ah": F1 730, F2 1090; "ee": F1 270, F2 2290
    assert.ok(bandEnergyDb(ah, sr, 680, 780) > bandEnergyDb(ah, sr, 400, 480) + 6, 'ah F1')
    assert.ok(bandEnergyDb(ah, sr, 1040, 1140) > bandEnergyDb(ah, sr, 1500, 1650) + 6, 'ah F2')
    assert.ok(bandEnergyDb(ee, sr, 2200, 2380) > bandEnergyDb(ee, sr, 1500, 1650) + 6, 'ee F2')
    assert.ok(bandEnergyDb(ee, sr, 2200, 2380) > bandEnergyDb(ah, sr, 2200, 2380) + 6, 'ee has F2 where ah does not')
    assert.ok(bandEnergyDb(ah, sr, 680, 780) > bandEnergyDb(ee, sr, 680, 780) + 6, 'ah has F1 where ee does not')
  })
  test('the loudness mode opens the vowel as the voice gets louder', () => {
    const sr = 22050
    const nz = noiseBuf(sr, 3, 'pink', 5)
    const s = nz.ch[0]
    // loud first, then 30 dB quieter: the vowel is judged against the recent peak
    for (let i = 0; i < s.length; i++) s[i] *= i < 1.5 * sr ? 1 : 0.03
    const out = mono(run(formantfilter, nz, { pattern: 'envelope', resonance: 80 }).out)
    const loud = out.subarray(Math.round(0.5 * sr), Math.round(1.4 * sr))
    const quiet = out.subarray(Math.round(2.0 * sr), Math.round(2.9 * sr))
    // quiet reads "oo" (F1 300), loud reads "ah" (F1 730)
    const q = bandEnergyDb(quiet, sr, 680, 780) - bandEnergyDb(quiet, sr, 270, 330)
    const l = bandEnergyDb(loud, sr, 680, 780) - bandEnergyDb(loud, sr, 270, 330)
    assert.ok(l > q + 6, 'ah against oo: quiet ' + q.toFixed(1) + ' dB, loud ' + l.toFixed(1) + ' dB')
  })
})

// ---------------------------------------------------------------- 4. live

describe('synthvoice live versions', () => {
  const v = voice(48000, 1.2, { f0: 160 })
  const cases = [
    [vocoder, {}, (r) => r],
    [talkbox, { notes: 'held' }, (r) => r],
    [kazoo, {}, (r) => (r.fork ? r.fork('pair0') : r)],
    [formantfilter, { pattern: 'aeiou' }, (r) => r],
  ]
  for (const [mod, params, rngFor] of cases) {
    test(mod.id + ': live equals offline, shifted by its latency', () => {
      const p = resolveParams(mod, params)
      const off = run(mod, v, params, { seed: 'live' }).out.ch[0]
      const lat = mod.live.latency(p, 48000)
      const eng = mod.live.create(48000, p, rngFor(makeRng('live')))
      const n = v.ch[0].length
      const out = new Float32Array(n)
      const sizes = [128, 480, 1, 77, 128]
      for (let s = 0, k = 0; s < n; k++) {
        const m = Math.min(sizes[k % sizes.length], n - s)
        eng.process([v.ch[0].subarray(s, s + m)], [out.subarray(s, s + m)], m)
        s += m
      }
      let worst = 0
      for (let i = lat; i < n; i++) {
        const d = Math.abs(out[i] - off[i - lat])
        if (d > worst) worst = d
      }
      assert.ok(worst < 1e-4, 'largest difference ' + worst)
    })
    test(mod.id + ': live in place, stereo, and while settings change', () => {
      const p = resolveParams(mod, params)
      const eng = mod.live.create(48000, p, makeRng('live2'))
      const L = new Float32Array(v.ch[0])
      const R = new Float32Array(v.ch[0])
      const rng = makeRng('settings')
      let peak = 0
      for (let s = 0, k = 0; s < L.length; s += 128, k++) {
        const m = Math.min(128, L.length - s)
        if (k % 24 === 23) {
          const q = {}
          for (const par of mod.params) {
            if (par.type === 'number') q[par.id] = par.min + (par.max - par.min) * rng.next()
            else if (par.type === 'choice') q[par.id] = par.options[rng.int(par.options.length)].v
            else q[par.id] = rng.next() < 0.5
          }
          eng.set(resolveParams(mod, q))
        }
        const views = [L.subarray(s, s + m), R.subarray(s, s + m)]
        eng.process(views, views, m)
        for (let i = 0; i < m; i++) {
          assert.ok(Number.isFinite(views[0][i]) && Number.isFinite(views[1][i]), 'not finite')
          peak = Math.max(peak, Math.abs(views[0][i]), Math.abs(views[1][i]))
        }
      }
      assert.ok(peak < 8, 'peak ' + peak)
      eng.reset()
      const z = new Float32Array(256)
      eng.process([z], [z], 256)
      for (const x of z) assert.ok(Number.isFinite(x))
    })
  }
  test('with mix at zero the live dry path is the input delayed by the latency', () => {
    for (const mod of [vocoder, talkbox]) {
      const p = resolveParams(mod, { mix: 0 })
      const lat = mod.live.latency(p, 48000)
      const eng = mod.live.create(48000, p, makeRng('dry'))
      const out = new Float32Array(v.ch[0].length)
      eng.process([v.ch[0]], [out], out.length)
      let worst = 0
      for (let i = lat; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - v.ch[0][i - lat]))
      assert.ok(worst < 1e-6, mod.id + ' dry path off by ' + worst)
    }
  })
  test('talk box live follows the voice with its own small tracker', () => {
    const g = voice(48000, 2.5, { f0: 196, intonation: 0 })
    const p = resolveParams(talkbox, {})
    const eng = talkbox.live.create(48000, p, makeRng('follow'))
    const out = new Float32Array(g.ch[0].length)
    for (let s = 0; s < out.length; s += 128) {
      const m = Math.min(128, out.length - s)
      eng.process([g.ch[0].subarray(s, s + m)], [out.subarray(s, s + m)], m)
    }
    near(medianF0(out, 48000, { minHz: 80, maxHz: 600 }), 196, 0.03, 'live follow')
  })
})

// ---------------------------------------------------------------- 5. speed and real speech

describe('synthvoice speed', () => {
  const v = voice(48000, 10, { f0: 140 })
  const bound = { 1: 60, 2: 60, 3: 200, 4: 300, 5: 400 }
  for (const mod of MODS) {
    test(mod.id + ' renders 10 s of 48 kHz speech in time', (t) => {
      const p = resolveParams(mod, {})
      const ms = timeIt(() => mod.process(copyBuf(v), p, { sr: 48000, rng: makeRng(1), progress() {}, cancelled: () => false, side: null, note() {} }), 1)
      const perSec = ms / 10
      t.diagnostic(mod.id + ': ' + perSec.toFixed(1) + ' ms per second of 48 kHz mono')
      assert.ok(perSec < bound[mod.cost], perSec.toFixed(1) + ' ms per second, cost ' + mod.cost)
    })
  }
})

describe('synthvoice on real speech', { skip: !HAVE_SPEECH && 'speech files not found' }, () => {
  const a = HAVE_SPEECH ? loadWav(SPEECH_A) : null
  const b = HAVE_SPEECH ? loadWav(SPEECH_B) : null
  test('every module at its defaults keeps the words moving', (t) => {
    for (const mod of MODS) {
      const out = run(mod, a).out
      assertSane(out)
      const c = envCorr(a.ch[0], mono(out), a.sr)
      const wrong = envCorr(b.ch[0].subarray(0, a.ch[0].length), mono(out).subarray(0, b.ch[0].length), a.sr)
      t.diagnostic(mod.id + ': envelope correlation ' + c.toFixed(3) + ' (against another take ' + wrong.toFixed(3) + ')')
      assert.ok(c > 0.55, mod.id + ' envelope correlation ' + c.toFixed(3))
      assert.ok(c > wrong + 0.3, mod.id + ' no closer to its own take than to another')
    }
  })
  test('the talk box and the vocoder keep the vowels of real speech', () => {
    for (const mod of [talkbox, vocoder]) {
      const out = mono(run(mod, b).out)
      const mine = shapeCorr(b.ch[0], out, b.sr)
      assert.ok(mine > 0.55, mod.id + ' vowel shape correlation ' + mine.toFixed(3))
    }
  })
})
