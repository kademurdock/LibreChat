// test/beds-nature.nodetest.mjs - the nature beds (birds, insects, frogs, wolves,
// bees, owls, gulls, summit, meadow, field, swamp, farm, jungle, rainforest night)
// and the outdoor kit they share (forest-birds.js named exports).
// Run (from api/server/kadeVoiceChanger):
//   node --test engine/test/beds-nature.nodetest.mjs   (Node 24)
//
// Every bed: the CONTRACT section 6 shape, stereo of exactly the asked length
// at any rate, finite and under full scale at every setting, deterministic
// for a seed, never silent, fast (20 s at 48 kHz well inside the 1.5 s
// budget, asserted generously because builders share the CPU), loudness near
// the beds' common level, and no repeating loop. Then one "does what its
// name says" property per bed, and checks of the kit: distance law, pan,
// reverb decay, note sweeps, the harmonic voice's pitch and the fast noise.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng } from '../core/rng.js'
import { findBlockedWord, UNITS, resolveParams } from '../core/params.js'
import { estimateRT60 } from '../core/ir.js'
import { lufs } from '../core/loudness.js'
import { assertSane, bandEnergyDb, stereoCorrelation, rmsDb, spectralCentroid, medianF0, cfft } from './measure.mjs'

import * as K from '../beds/forest-birds.js'
import { addCrickets } from '../beds/night-crickets.js'
import { harmonicVoice } from '../beds/wolves-far.js'
import { hiveHum } from '../beds/beehive.js'
import { crow } from '../beds/farm-morning.js'

const IDS = [
  'forest-birds', 'jungle', 'rainforest-night', 'night-crickets', 'summer-field', 'swamp', 'farm-morning',
  'wolves-far', 'beehive', 'frogs-pond', 'seagulls-harbor', 'owl-woods', 'mountain-top', 'meadow-dawn',
]

const BEDS = {}
for (const id of IDS) BEDS[id] = (await import('../beds/' + id + '.js')).default

const SR = 48000

function gen(id, seconds, p = {}, seed = 1, sr = SR) {
  return BEDS[id].generate(seconds, sr, p, makeRng(seed))
}

function left(b) {
  return b.ch[0]
}

function mono(b) {
  const n = b.ch[0].length
  const m = new Float32Array(n)
  for (let i = 0; i < n; i++) m[i] = 0.5 * (b.ch[0][i] + b.ch[1][i])
  return m
}

function band(b, lo, hi) {
  return bandEnergyDb(mono(b), b.sr, lo, hi)
}

function sameBuf(a, b) {
  if (a.ch.length !== b.ch.length) return false
  for (let c = 0; c < a.ch.length; c++) {
    const x = a.ch[c]
    const y = b.ch[c]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  }
  return true
}

function checkBed(b, n, label) {
  assert.ok(b && Array.isArray(b.ch), label + ': no channels')
  assert.equal(b.ch.length, 2, label + ': beds are stereo')
  assert.equal(b.ch[0].length, n, label + ': length')
  const { peak } = assertSane(b, { maxPeak: 1 })
  return peak
}

// Largest normalised autocorrelation of the (4x decimated) mono mix at lags of
// at least minLag seconds. A looped bed scores near 1 at its loop length.
function maxLongAutocorr(b, minLag = 1) {
  const m = mono(b)
  const D = 4
  const n = Math.floor(m.length / D)
  let N = 1
  while (N < 2 * n) N <<= 1
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  let mean = 0
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < D; k++) s += m[i * D + k]
    re[i] = s / D
    mean += re[i] / n
  }
  for (let i = 0; i < n; i++) re[i] -= mean
  cfft(re, im)
  for (let k = 0; k < N; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k]
    im[k] = 0
  }
  cfft(re, im, true)
  const r0 = re[0]
  if (!(r0 > 0)) return 0
  const sr = b.sr / D
  let best = 0
  for (let lag = Math.round(minLag * sr); lag < n / 2; lag++) {
    // unbiased: scale by the overlap so late lags are not favoured or hidden
    const v = (re[lag] / r0) * (n / (n - lag))
    if (v > best) best = v
  }
  return best
}

// ---------------------------------------------------------------- shape

describe('nature beds: shape (CONTRACT section 6)', () => {
  for (const id of IDS) {
    test(id + ' has a valid shape', () => {
      const bed = BEDS[id]
      assert.equal(bed.id, id)
      assert.equal(bed.group, 'nature')
      assert.equal(typeof bed.generate, 'function')
      assert.ok(typeof bed.name === 'string' && bed.name.length > 0 && bed.name.length <= 40, 'name')
      assert.ok(typeof bed.about === 'string' && bed.about.length > 0 && bed.about.length <= 120, 'about is one sentence under 120 characters')
      assert.equal(findBlockedWord(bed.name), null)
      assert.equal(findBlockedWord(bed.about), null)
      assert.ok(Array.isArray(bed.params) && bed.params.length >= 2 && bed.params.length <= 8)
      const ids = new Set()
      for (const p of bed.params) {
        assert.ok(/^[a-zA-Z][a-zA-Z0-9]*$/.test(p.id), 'param id ' + p.id)
        assert.ok(!ids.has(p.id), 'repeated param ' + p.id)
        ids.add(p.id)
        assert.ok(typeof p.name === 'string' && p.name.trim().length > 0)
        assert.equal(findBlockedWord(p.name), null, p.name)
        if (p.type === 'number') {
          assert.ok(p.min < p.max && p.def >= p.min && p.def <= p.max, p.id + ' range')
          assert.ok(UNITS.includes(p.unit), p.id + ' unit ' + p.unit)
          if (p.step) assert.ok(Math.abs((p.def - p.min) / p.step - Math.round((p.def - p.min) / p.step)) < 1e-9, p.id + ' default on its step')
          if (p.unit === 'percent') assert.ok(p.min >= -100 && p.max <= 100)
        } else if (p.type === 'choice') {
          assert.ok(p.options.length >= 2)
          assert.ok(p.options.some((o) => o.v === p.def))
          for (const o of p.options) {
            assert.ok(typeof o.name === 'string' && o.name.trim().length > 0)
            assert.equal(findBlockedWord(o.name), null, o.name)
          }
        } else {
          assert.equal(p.type, 'bool')
          assert.equal(typeof p.def, 'boolean')
        }
      }
      assert.ok(ids.has('intensity'), 'every nature bed has an intensity')
      assert.ok(ids.has('distance') || ids.has('valley'), 'and a distance or size')
      // defaults resolve without problems
      const problems = []
      resolveParams(bed, {}, { problems })
      assert.deepEqual(problems, [])
    })
  }
})

// ---------------------------------------------------------------- battery

describe('nature beds: battery', () => {
  for (const id of IDS) {
    test(id + ': stereo, exact length, finite, audible, deterministic', () => {
      const a = gen(id, 3)
      const peak = checkBed(a, 3 * SR, id)
      assert.ok(peak < 0.9, id + ' peak ' + peak)
      assert.ok(rmsDb(a) > -70, id + ' must not be silent: ' + rmsDb(a).toFixed(1) + ' dB')
      const b = gen(id, 3)
      assert.ok(sameBuf(a, b), id + ' same seed, same bed')
      const c = gen(id, 3, {}, 2)
      assert.ok(!sameBuf(a, c), id + ' another seed gives another bed')
      // stereo, not mono
      assert.ok(stereoCorrelation(a) < 0.98, id + ' is stereo: correlation ' + stereoCorrelation(a).toFixed(3))
    })

    test(id + ': any rate, odd lengths, missing params and rng', () => {
      for (const sr of [8000, 22050, 44100, 96000]) checkBed(gen(id, 1, {}, 3, sr), sr, id + ' at ' + sr)
      checkBed(gen(id, 0), 0, id + ' zero seconds')
      checkBed(gen(id, -2), 0, id + ' negative seconds')
      checkBed(gen(id, NaN), 0, id + ' not a number')
      checkBed(gen(id, 0.01), 480, id + ' ten milliseconds')
      checkBed(BEDS[id].generate(0.5, SR, undefined, undefined), 24000, id + ' without params or rng')
      checkBed(BEDS[id].generate(0.5, SR, { nonsense: 3 }, makeRng(1)), 24000, id + ' with an unknown param')
    })

    test(id + ': every setting at its ends stays clean', () => {
      const bed = BEDS[id]
      const sr = 22050
      const all = { min: {}, max: {} }
      for (const p of bed.params) {
        let vals
        if (p.type === 'number') {
          vals = [p.min, p.max]
          all.min[p.id] = p.min
          all.max[p.id] = p.max
        } else if (p.type === 'bool') vals = [true, false]
        else vals = p.options.map((o) => o.v)
        for (const v of vals) checkBed(gen(id, 1.5, { [p.id]: v }, 5, sr), Math.round(1.5 * sr), id + ' ' + p.id + '=' + v)
      }
      checkBed(gen(id, 3, all.min, 6), 3 * SR, id + ' everything at minimum')
      checkBed(gen(id, 3, all.max, 6), 3 * SR, id + ' everything at maximum')
    })

    test(id + ': 20 seconds is quick, at the common level, and never a loop', (t) => {
      const t0 = performance.now()
      const b = gen(id, 20, {}, 11)
      const ms = performance.now() - t0
      checkBed(b, 20 * SR, id)
      t.diagnostic(id + ' 20 s at 48 kHz: ' + ms.toFixed(0) + ' ms')
      assert.ok(ms < 4000, id + ' took ' + ms.toFixed(0) + ' ms for 20 s (budget 1500 ms, asserted at 4000 for a shared CPU)')
      const L = lufs(b)
      assert.ok(L > -32 && L < -17, id + ' loudness ' + L.toFixed(1) + ' LUFS')
      const ac = maxLongAutocorr(b, 1)
      t.diagnostic(id + ' longest-lag self-similarity ' + ac.toFixed(3))
      assert.ok(ac < 0.5, id + ' repeats itself: autocorrelation ' + ac.toFixed(3))
    })
  }
})

// ---------------------------------------------------------------- does what its name says

describe('nature beds: each one sounds like its name', () => {
  test('forest-birds: birdsong lives in 2-8 kHz and grows with the birdsong setting', () => {
    const quiet = gen('forest-birds', 12, { intensity: 0, wind: 0 }, 4)
    const busy = gen('forest-birds', 12, { intensity: 80, wind: 0 }, 4)
    assert.ok(band(busy, 2000, 8000) - band(quiet, 2000, 8000) > 10)
    assert.ok(band(busy, 2000, 8000) > band(busy, 150, 1000) + 6)
  })

  test('night-crickets: field crickets ring near 4-5.5 kHz', () => {
    const b = gen('night-crickets', 8, { kind: 'field', katydids: 0, breeze: 0 }, 4)
    assert.ok(band(b, 4000, 5600) > band(b, 1000, 3000) + 15)
  })

  test('night-crickets: a warm night makes a cricket chirp faster (Dolbear)', () => {
    const count = (warmth) => {
      const sc = K.makeScene(10, SR, makeRng(3))
      addCrickets(sc, makeRng(8), { count: 1, dist: 3, warmth, kind: 'field', gain: 1, send: 0 })
      const x = sc.L
      const env = new Float32Array(x.length)
      let e = 0
      const k = 1 - Math.exp(-1 / (0.004 * SR))
      let mx = 0
      for (let i = 0; i < x.length; i++) {
        e += k * (Math.abs(x[i]) - e)
        env[i] = e
        if (e > mx) mx = e
      }
      // a chirp starts when the envelope rises after at least 60 ms of quiet
      // (the gaps between the pulses inside one chirp are about 10-20 ms)
      let n = 0
      let quiet = 0
      for (let i = 1; i < x.length; i++) {
        if (env[i] < 0.1 * mx) quiet++
        else if (env[i] > 0.3 * mx) {
          if (quiet > 0.06 * SR) n++
          quiet = 0
        }
      }
      return n
    }
    const cold = count(0)
    const warm = count(1)
    assert.ok(cold >= 4, 'cold chirps ' + cold)
    assert.ok(warm >= 2 * cold, 'warm ' + warm + ' vs cold ' + cold)
  })

  test('frogs-pond: peepers whistle near 2.6-3.3 kHz', () => {
    const none = gen('frogs-pond', 10, { peepers: 0, water: 0 }, 4)
    const many = gen('frogs-pond', 10, { peepers: 100, water: 0 }, 4)
    assert.ok(band(many, 2600, 3300) - band(none, 2600, 3300) > 8)
  })

  test('wolves-far: howls fill 300-1200 Hz, and farther packs are quieter and darker', () => {
    const none = gen('wolves-far', 14, { intensity: 0, wind: 0, insects: 0 }, 4)
    const near = gen('wolves-far', 14, { intensity: 100, distance: 150, wind: 0, insects: 0 }, 4)
    const far = gen('wolves-far', 14, { intensity: 100, distance: 3000, wind: 0, insects: 0 }, 4)
    assert.ok(band(near, 300, 1200) - band(none, 300, 1200) > 15)
    assert.ok(rmsDb(near) > rmsDb(far) + 3)
    assert.ok(spectralCentroid(mono(near), SR) > spectralCentroid(mono(far), SR))
  })

  test('beehive: the hum sits low, and pressing your ear to the hive muffles it', () => {
    const hum = (muffle) => {
      const sc = K.makeScene(6, SR, makeRng(3))
      hiveHum(sc, makeRng(4), { bees: 60, dist: 2, muffle, gain: 1, send: 0 })
      return { sr: SR, ch: [sc.L, sc.R] }
    }
    const open = hum(0.15)
    const muffled = hum(0.85)
    assert.ok(band(open, 150, 600) > band(open, 2000, 4000) + 10, 'warm hum')
    // the wingbeat fundamental (about 205-265 Hz) is present
    assert.ok(band(open, 190, 290) > band(open, 2000, 4000) + 10)
    // muffling takes the highs down against the body of the hum
    const tilt = (b) => band(b, 1000, 4000) - band(b, 150, 600)
    assert.ok(tilt(open) - tilt(muffled) > 5, 'muffled by ' + (tilt(open) - tilt(muffled)).toFixed(1) + ' dB')
    const garden = gen('beehive', 8, { flybys: 0, breeze: 0 }, 4)
    const inside = gen('beehive', 8, { flybys: 0, breeze: 0, place: 'inside' }, 4)
    assert.ok(spectralCentroid(mono(inside), SR) < spectralCentroid(mono(garden), SR))
  })

  test('seagulls-harbor: gulls call in 1-4 kHz', () => {
    const p = { water: 0, rigging: 0, boats: false, wind: 0 }
    const none = gen('seagulls-harbor', 10, Object.assign({ intensity: 0 }, p), 4)
    const gulls = gen('seagulls-harbor', 10, Object.assign({ intensity: 100 }, p), 4)
    assert.ok(band(gulls, 1000, 4000) - band(none, 1000, 4000) > 15)
  })

  test('owl-woods: deep hoots are low (about 220-420 Hz)', () => {
    const b = gen('owl-woods', 16, { owls: 'deep', intensity: 100, wind: 0, insects: 0 }, 4)
    const none = gen('owl-woods', 16, { owls: 'deep', intensity: 0, wind: 0, insects: 0 }, 4)
    assert.ok(band(b, 200, 500) - band(none, 200, 500) > 10)
    const f = medianF0(mono(b), SR, { minHz: 150, maxHz: 700 })
    assert.ok(f > 220 && f < 420, 'hoot pitch ' + f.toFixed(0))
  })

  test('mountain-top: stronger wind is much louder, and the hawk adds a high cry', () => {
    const calm = gen('mountain-top', 10, { intensity: 10, hawk: false }, 4)
    const gale = gen('mountain-top', 10, { intensity: 100, hawk: false }, 4)
    assert.ok(rmsDb(gale) > rmsDb(calm) + 10)
    const hawk = gen('mountain-top', 14, { intensity: 20, hawk: true }, 4)
    const no = gen('mountain-top', 14, { intensity: 20, hawk: false }, 4)
    assert.ok(band(hawk, 1800, 3600) > band(no, 1800, 3600) + 3)
  })

  test('meadow-dawn: the skylark adds high song overhead', () => {
    const lark = gen('meadow-dawn', 10, { intensity: 10, lark: true, doves: false }, 4)
    const none = gen('meadow-dawn', 10, { intensity: 10, lark: false, doves: false }, 4)
    assert.ok(band(lark, 2500, 7000) - band(none, 2500, 7000) > 6)
  })

  test('summer-field: cicadas sing in a band near 4-6 kHz', () => {
    const p = { intensity: 0, bees: 0, birds: 0, breeze: 0 }
    const none = gen('summer-field', 12, Object.assign({ cicadas: 0 }, p), 4)
    const cic = gen('summer-field', 12, Object.assign({ cicadas: 100 }, p), 4)
    assert.ok(band(cic, 4000, 6000) - band(none, 4000, 6000) > 15)
    assert.ok(band(cic, 4000, 6000) > band(cic, 1000, 3000) + 10)
  })

  test('swamp: frogs boom and twang low', () => {
    const p = { insects: 0, bubbles: 0 }
    const none = gen('swamp', 14, Object.assign({ intensity: 0 }, p), 4)
    const frogs = gen('swamp', 14, Object.assign({ intensity: 100 }, p), 4)
    assert.ok(band(frogs, 80, 400) - band(none, 80, 400) > 6)
  })

  test('farm-morning: a crow climbs syllable by syllable and lasts about two seconds', () => {
    const c = crow(SR, makeRng(5), 1)
    const dur = c.length / SR
    assert.ok(dur > 1.1 && dur < 2.2, 'crow length ' + dur.toFixed(2))
    const first = medianF0(c.subarray(0, Math.round(0.15 * SR)), SR, { minHz: 200, maxHz: 1200 })
    const last = medianF0(c.subarray(Math.round(0.65 * SR), Math.round(1.0 * SR)), SR, { minHz: 200, maxHz: 1200 })
    assert.ok(first > 300 && last > first * 1.2, 'first ' + first.toFixed(0) + ' last ' + last.toFixed(0))
    const p = { hens: 0, cows: false, breeze: 0 }
    const off = gen('farm-morning', 12, Object.assign({ rooster: false }, p), 4)
    const on = gen('farm-morning', 12, Object.assign({ rooster: true }, p), 4)
    assert.ok(band(on, 500, 2500) > band(off, 500, 2500) + 6)
  })

  test('jungle: insects fill 3.5-6 kHz and the far calls sound in 0.5-1.5 kHz', () => {
    const p = { birds: 0, drips: 0 }
    const quiet = gen('jungle', 14, Object.assign({ insects: 0, calls: 0 }, p), 4)
    const bugs = gen('jungle', 14, Object.assign({ insects: 100, calls: 0 }, p), 4)
    const calls = gen('jungle', 14, Object.assign({ insects: 0, calls: 100 }, p), 4)
    assert.ok(band(bugs, 3500, 6000) - band(quiet, 3500, 6000) > 10)
    assert.ok(band(calls, 500, 1500) - band(quiet, 500, 1500) > 6)
  })

  test('rainforest-night: tree frogs fill 1-2.6 kHz', () => {
    const p = { insects: 0, nightBird: false, drips: 0 }
    const none = gen('rainforest-night', 10, Object.assign({ frogs: 0 }, p), 4)
    const frogs = gen('rainforest-night', 10, Object.assign({ frogs: 100 }, p), 4)
    assert.ok(band(frogs, 1000, 2600) - band(none, 1000, 2600) > 10)
  })
})

// ---------------------------------------------------------------- kit

describe('outdoor kit', () => {
  function tone(hz, sec, amp = 0.5) {
    const n = Math.round(sec * SR)
    const s = new Float32Array(n)
    for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR) * Math.min(1, i / 480, (n - i) / 480)
    return s
  }

  test('emit: inverse distance (6 dB per doubling) and equal-power pan', () => {
    const at = (dist, pan) => {
      const sc = K.makeScene(1, SR, makeRng(1))
      K.emit(sc, tone(1000, 0.8), 0.1 * SR, pan, dist, 1, 0)
      return sc
    }
    const a = at(10, 0)
    const b = at(40, 0)
    const d = rmsDb(a.L) - rmsDb(b.L)
    assert.ok(Math.abs(d - 12.04) < 1, 'level drop 10 m to 40 m: ' + d.toFixed(2))
    const r = at(10, 1)
    assert.ok(rmsDb(r.R) > rmsDb(r.L) + 40, 'hard right is right')
    const l = at(10, -0.5)
    assert.ok(rmsDb(l.L) > rmsDb(l.R) + 5, 'half left leans left')
  })

  test('emit: far sources lose their highs (air absorption)', () => {
    const near = K.makeScene(1, SR, makeRng(1))
    const far = K.makeScene(1, SR, makeRng(1))
    const lo = tone(500, 0.8)
    const hi = tone(8000, 0.8)
    K.emit(near, lo.slice(), 0, 0, 20, 1, 0)
    K.emit(near, hi.slice(), 0, 0, 20, 1, 0)
    K.emit(far, lo.slice(), 0, 0, 600, 1, 0)
    K.emit(far, hi.slice(), 0, 0, 600, 1, 0)
    const tiltNear = bandEnergyDb(near.L, SR, 7000, 9000) - bandEnergyDb(near.L, SR, 400, 600)
    const tiltFar = bandEnergyDb(far.L, SR, 7000, 9000) - bandEnergyDb(far.L, SR, 400, 600)
    assert.ok(tiltNear - tiltFar > 10, 'highs lost with distance: ' + (tiltNear - tiltFar).toFixed(1) + ' dB')
  })

  test('renderSpace: the tail decays in about the asked time and stays finite', () => {
    for (const rt of [0.8, 2]) {
      const n = Math.round(4 * SR)
      const S = new Float32Array(n)
      S[100] = 1
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      K.renderSpace(S, SR, { rt60: rt, damp: 0.2, size: 1, predelayMs: 5, early: 0, earlyMs: 10, wet: 1, lowCut: 30 }, makeRng(2), L, R)
      assertSane({ sr: SR, ch: [L, R] })
      const est = estimateRT60(L, SR)
      assert.ok(est > rt * 0.6 && est < rt * 1.4, 'asked ' + rt + ' s, measured ' + est.toFixed(2) + ' s')
      assert.ok(stereoCorrelation({ ch: [L, R] }) < 0.5, 'the tail is wide')
    }
  })

  test('renderNote: a sweep starts and ends where it is told', () => {
    const out = new Float32Array(Math.round(0.6 * SR))
    K.renderNote(out, SR, { t: 0, d: 0.5, f0: 1000, f1: 2000, h2: 0, h3: 0, att: 0.005, rel: 0.005 }, makeRng(1))
    const zc = (a, b) => {
      let n = 0
      for (let i = a + 1; i < b; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) n++
      return (n / 2) / ((b - a) / SR)
    }
    const f0 = zc(Math.round(0.01 * SR), Math.round(0.05 * SR))
    const f1 = zc(Math.round(0.45 * SR), Math.round(0.49 * SR))
    assert.ok(f0 > 950 && f0 < 1150, 'start ' + f0.toFixed(0))
    assert.ok(f1 > 1800 && f1 < 2050, 'end ' + f1.toFixed(0))
    assertSane({ sr: SR, ch: [out] }, { maxPeak: 1.01 })
  })

  test('harmonicVoice: pitch follows its contour', () => {
    const v = harmonicVoice(SR, makeRng(1), { dur: 1, f: [[0, 300], [1, 300]], amp: [[0, 0], [0.05, 1], [0.95, 1], [1, 0]], formants: [[800, 400, 0]], tilt: -6, nh: 12 })
    const f = medianF0(v, SR, { minHz: 100, maxHz: 800 })
    assert.ok(Math.abs(f - 300) < 9, 'pitch ' + f.toFixed(1))
    assertSane({ sr: SR, ch: [v] }, { maxPeak: 4 })
  })

  test('fastWhite: deterministic, in range, centred, white-level', () => {
    const a = K.fastWhite(200000, makeRng(4))
    const b = K.fastWhite(200000, makeRng(4))
    let same = true
    let mean = 0
    let e = 0
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) same = false
      assert.ok(a[i] >= -1 && a[i] <= 1)
      mean += a[i] / a.length
      e += a[i] * a[i]
    }
    assert.ok(same)
    assert.ok(Math.abs(mean) < 0.01)
    assert.ok(Math.abs(Math.sqrt(e / a.length) - 0.577) < 0.01)
    const p = K.fastPink(200000, makeRng(4))
    let pe = 0
    for (let i = 0; i < p.length; i++) pe += p[i] * p[i]
    assert.ok(Math.abs(Math.sqrt(pe / p.length) - 0.2) < 0.03, 'pink level')
  })

  test('the scene keeps its gust curve in 0..1 for other layers', () => {
    const sc = K.makeScene(5, SR, makeRng(1))
    K.addAir(sc, { wind: 0.5, gust: 1, gustBias: 0.4 }, makeRng(2))
    for (const g of sc.gust) assert.ok(g >= 0 && g <= 1)
    assert.ok(K.gustAt(sc, 2.5) >= 0 && K.gustAt(sc, 99) <= 1)
  })
})
