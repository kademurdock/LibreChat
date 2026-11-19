// test/stereo.nodetest.mjs - the stereo family: width, short-delay widen, double-track,
// crowd, split, place, orbit, fly-by, walk away, ping-pong.
// Run (from api/server/kadeVoiceChanger):
//   node --test engine/test/stereo.nodetest.mjs   (Node 24)
//
// Every module: contract shape, robustness (empty, silence, click, stereo in,
// every param at min and max, 8 kHz and 96 kHz), an acceptable mono fold-down,
// determinism, and a property test that proves it does what its name says.
// The live versions (width, haas, double, place, orbit) are run in blocks of
// 128 and 480 with outputs aliasing inputs, set() mid-stream, and compared
// with the offline sound.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import { validateModuleShape, resolveParams } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'
import { resampleTo } from '../core/resample.js'
import { findPhrases } from '../core/segment.js'
import { Biquad } from '../core/biquad.js'
import { synthVoice, sine, impulse, silence, noiseBuf } from './fixtures.mjs'
import { assertSane, medianF0, bandEnergyDb, stereoCorrelation, rmsDb } from './measure.mjs'

import width from '../modules/stereo/width.js'
import haas from '../modules/stereo/haas.js'
import double from '../modules/stereo/double.js'
import crowd from '../modules/stereo/crowd.js'
import split from '../modules/stereo/split.js'
import place from '../modules/stereo/place.js'
import orbit from '../modules/stereo/orbit.js'
import flyby from '../modules/stereo/flyby.js'
import walkaway from '../modules/stereo/walkaway.js'
import pingpong from '../modules/stereo/pingpong.js'

const SR = 48000
const ALL = [width, haas, double, crowd, split, place, orbit, flyby, walkaway, pingpong]
const LIVE = [width, haas, double, place, orbit]
const SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'
const SPEECH2 = 'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav'

function loadSpeech(path) {
  try {
    if (!existsSync(path)) return null
    const b = decodeWav(new Uint8Array(readFileSync(path)))
    return { sr: b.sr, ch: [b.ch[0]] }
  } catch {
    return null
  }
}
const speech24 = loadSpeech(SPEECH)
const speech24b = loadSpeech(SPEECH2)
const speech48 = speech24 ? { sr: SR, ch: [resampleTo(speech24.ch[0], speech24.sr, SR).slice(0, SR * 8)] } : null

function ctxOf(seed = 1) {
  return { sr: SR, rng: makeRng(seed), progress() {}, cancelled: () => false, note() {} }
}

function run(mod, input, p = {}, seed = 1) {
  const rp = resolveParams(mod, p, { strict: true })
  const ib = { sr: input.sr, ch: input.ch.map((c) => new Float32Array(c)) }
  return mod.process(ib, rp, { ...ctxOf(seed), sr: input.sr })
}

function voice(sr = SR, seconds = 2, opts = {}) {
  return synthVoice(sr, seconds, { seed: 3, ...opts })
}

function rmsOf(s, a = 0, b = s.length) {
  let e = 0
  const lo = Math.max(0, a | 0)
  const hi = Math.min(s.length, b | 0)
  for (let i = lo; i < hi; i++) e += s[i] * s[i]
  return hi > lo ? Math.sqrt(e / (hi - lo)) : 0
}

function db(x) {
  return 20 * Math.log10(Math.max(1e-12, x))
}

function foldRatio(buf) {
  const [L, R] = buf.ch
  const n = L.length
  const m = new Float32Array(n)
  for (let i = 0; i < n; i++) m[i] = 0.5 * (L[i] + R[i])
  const ch = Math.sqrt(0.5 * (rmsOf(L) ** 2 + rmsOf(R) ** 2))
  return rmsOf(m) / Math.max(1e-12, ch)
}

function extremes(mod, which) {
  const p = {}
  for (const q of mod.params) {
    if (q.type === 'number') p[q.id] = which === 'min' ? q.min : q.max
    else if (q.type === 'choice') p[q.id] = which === 'min' ? q.options[0].v : q.options[q.options.length - 1].v
    else if (q.type === 'bool') p[q.id] = which !== 'min'
  }
  return p
}

function checkOut(mod, inBuf, out, p) {
  assertSane(out, { maxPeak: 8 })
  assert.equal(out.ch.length, 2, mod.id + ' must give stereo out')
  const n = inBuf.ch[0].length
  const rp = resolveParams(mod, p)
  const tail = mod.tail ? mod.tail(rp, inBuf.sr) : 0
  assert.ok(out.ch[0].length >= n, mod.id + ' output shorter than input')
  assert.ok(out.ch[0].length <= n + Math.ceil(tail * inBuf.sr) + 2, mod.id + ' output longer than input plus tail: ' + out.ch[0].length + ' vs ' + n + ' + ' + tail)
}

// ---------------------------------------------------------------- shape

describe('stereo family shape', () => {
  for (const mod of ALL) {
    test(mod.id + ' matches the contract', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'stereo')
      assert.equal(mod.stereo, 'make')
      assert.ok(mod.params.length >= 2 && mod.params.length <= 8, mod.id + ' should have 2..8 params')
    })
  }
  test('no spoken text carries a researcher\'s name', () => {
    for (const mod of ALL) {
      const words = [mod.name, mod.about]
      for (const q of mod.params) {
        words.push(q.name)
        for (const o of q.options || []) words.push(o.name)
      }
      for (const w of words) assert.ok(!/haas|doppler|woodworth|blauert/i.test(w || ''), mod.id + ': ' + w)
    }
  })
  test('live versions exist where promised', () => {
    for (const mod of LIVE) assert.ok(mod.live && typeof mod.live.create === 'function', mod.id + ' has no live')
  })
})

// ---------------------------------------------------------------- robustness

describe('stereo robustness', () => {
  const inputs = [
    ['empty', { sr: SR, ch: [new Float32Array(0)] }],
    ['silence', silence(SR, 0.6)],
    ['click', impulse(SR, 0.6, 0.2)],
    ['stereo speech', (() => {
      const v = voice(SR, 1).ch[0]
      const r = new Float32Array(v.length)
      for (let i = 0; i < v.length; i++) r[i] = 0.6 * v[Math.max(0, i - 30)]
      return { sr: SR, ch: [v, r] }
    })()],
  ]
  for (const mod of ALL) {
    test(mod.id + ': empty, silence, click and stereo input at defaults', () => {
      for (const [name, b] of inputs) {
        const out = run(mod, b, {})
        if (name === 'empty') {
          assert.equal(out.ch.length, 2)
          assert.equal(out.ch[0].length, 0)
          continue
        }
        checkOut(mod, b, out, {})
        if (name === 'silence') assert.ok(rmsDb(out.ch[0]) < -100, mod.id + ' made sound from silence')
      }
    })
    test(mod.id + ': every param at min and at max', () => {
      const v = voice(SR, 1.2)
      for (const which of ['min', 'max']) {
        const p = extremes(mod, which)
        checkOut(mod, v, run(mod, v, p), p)
        checkOut(mod, impulse(SR, 0.4, 0.1), run(mod, impulse(SR, 0.4, 0.1), p), p)
      }
    })
    test(mod.id + ': 8 kHz and 96 kHz', () => {
      for (const sr of [8000, 96000]) {
        const v = voice(sr, sr === 8000 ? 1.2 : 0.7)
        checkOut(mod, v, run(mod, v, {}), {})
      }
    })
    test(mod.id + ': deterministic for a seed', () => {
      const v = voice(SR, 1)
      const a = run(mod, v, {}, 'same')
      const b = run(mod, v, {}, 'same')
      for (let c = 0; c < 2; c++) assert.deepEqual(a.ch[c], b.ch[c])
    })
    test(mod.id + ': folds down to mono acceptably', () => {
      const v = speech48 || voice(SR, 3)
      const out = run(mod, v, {})
      const r = foldRatio(out)
      assert.ok(r > 0.5, mod.id + ' mono fold loses too much: ratio ' + r.toFixed(2))
    })
  }
  test('30 seconds of speech through every module', { skip: !speech24 }, () => {
    const s = speech24.ch[0]
    const n = 30 * speech24.sr
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = s[i % s.length]
    const b = { sr: speech24.sr, ch: [x] }
    for (const mod of ALL) checkOut(mod, b, run(mod, b, {}), {})
  })
})

// ---------------------------------------------------------------- properties

describe('stereo.width', () => {
  test('width 0 gives identical ears (correlation 1)', () => {
    const v = voice(SR, 1.5)
    const out = run(width, v, { width: 0 })
    assert.ok(stereoCorrelation(out) > 0.9999)
    const st = { sr: SR, ch: [v.ch[0], noiseBuf(SR, 1.5, 'pink', 4).ch[0].map((x) => x * 0.2)] }
    const o2 = run(width, st, { width: 0 })
    assert.ok(stereoCorrelation(o2) > 0.9999)
  })
  test('a mono voice becomes wide, and folds back to exactly the voice', () => {
    const v = voice(SR, 2)
    const out = run(width, v, {})
    const c = stereoCorrelation(out)
    assert.ok(c < 0.85 && c > 0, 'correlation ' + c)
    const x = v.ch[0]
    let err = 0
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(0.5 * (out.ch[0][i] + out.ch[1][i]) - x[i]))
    assert.ok(err < 1e-5, 'mono fold differs by ' + err)
  })
  test('wider settings mean lower correlation', () => {
    const v = voice(SR, 2)
    const a = stereoCorrelation(run(width, v, { width: 1, fill: 30 }))
    const b = stereoCorrelation(run(width, v, { width: 2.2, fill: 90 }))
    assert.ok(b < a - 0.2, a + ' vs ' + b)
  })
  test('stereo input: side scales with width, bass side kept', () => {
    const L = voice(SR, 1.5).ch[0]
    const R = voice(SR, 1.5, { seed: 9, f0: 180 }).ch[0]
    const st = { sr: SR, ch: [L, R] }
    const side = (b) => {
      const s = new Float32Array(b.ch[0].length)
      for (let i = 0; i < s.length; i++) s[i] = 0.5 * (b.ch[0][i] - b.ch[1][i])
      return rmsOf(s)
    }
    const s1 = side(run(width, st, { width: 1, fill: 0 }))
    const s2 = side(run(width, st, { width: 2, fill: 0 }))
    assert.ok(s2 > s1 * 1.6, s1 + ' vs ' + s2)
  })
})

describe('stereo.haas', () => {
  test('the late ear is late by the delay, and the lead ear is untouched', () => {
    const v = voice(SR, 1)
    for (const [lead, ms] of [['left', 10], ['right', 25]]) {
      const out = run(haas, v, { delay: ms, lead, soften: 0, level: 0 })
      const first = lead === 'left' ? out.ch[0] : out.ch[1]
      const late = lead === 'left' ? out.ch[1] : out.ch[0]
      for (let i = 0; i < 2000; i++) assert.ok(Math.abs(first[i + 5000] - v.ch[0][i + 5000]) < 1e-6)
      // best lag by cross-correlation
      let best = -1, bestV = -Infinity
      for (let lag = 0; lag < 0.04 * SR; lag += 4) {
        let acc = 0
        for (let i = 4000; i < 40000; i += 3) acc += first[i] * late[i + lag]
        if (acc > bestV) { bestV = acc; best = lag }
      }
      assert.ok(Math.abs(best - (ms / 1000) * SR) <= 8, lead + ' lag ' + best)
    }
  })
})

describe('stereo.double', () => {
  test('adds wide, detuned, later copies', () => {
    const v = voice(SR, 2.5)
    const out = run(double, v, {})
    const c = stereoCorrelation(out)
    assert.ok(c < 0.95, 'correlation ' + c)
    // one copy: the original is left and the copy right, a few ms late
    const one = run(double, v, { copies: 1, spread: 100, pitch: 0, timing: 10 })
    const L = one.ch[0], R = one.ch[1]
    let best = 0, bestV = -Infinity
    for (let lag = 0; lag < 0.03 * SR; lag += 8) {
      let acc = 0
      for (let i = 4000; i < 80000; i += 5) acc += L[i] * R[i + lag]
      if (acc > bestV) { bestV = acc; best = lag }
    }
    assert.ok(best >= 0.004 * SR && best <= 0.024 * SR, 'copy lag ' + best)
  })
  test('pitch looseness changes the copy pitch by about the cents asked', () => {
    const v = voice(SR, 3, { f0: 150, intonation: 0 })
    const out = run(double, v, { copies: 1, spread: 100, pitch: 40, timing: 0 })
    const fL = medianF0(out.ch[0], SR)
    const fR = medianF0(out.ch[1], SR)
    const cents = Math.abs(1200 * Math.log2(fR / fL))
    assert.ok(cents > 10 && cents < 80, 'copy detune ' + cents.toFixed(1) + ' cents')
  })
})

describe('stereo.crowd', () => {
  test('people differ in pitch and place: two people at opposite sides', () => {
    const v = voice(SR, 3, { f0: 140, intonation: 0 })
    const out = run(crowd, v, { people: 2, pitchSpread: 10, timbreSpread: 2, timing: 0, loose: 0, spread: 100, room: 'none', you: 0 })
    // above 1.5 kHz the head shadow makes each ear hear mostly its own person
    const hp = (c) => {
      const y = new Float32Array(c)
      new Biquad('highpass', SR, 1500, 0.707).run(y)
      new Biquad('highpass', SR, 1500, 0.707).run(y)
      return y
    }
    const fL = medianF0(hp(out.ch[0]), SR)
    const fR = medianF0(hp(out.ch[1]), SR)
    assert.ok(fL > 0 && fR > 0)
    const semis = Math.abs(12 * Math.log2(fL / fR))
    assert.ok(semis > 4, 'the two people are only ' + semis.toFixed(1) + ' semitones apart')
  })
  test('a crowd is wide, keeps talking after you stop (timing spread) and stays in level', () => {
    const v = speech48 || voice(SR, 4)
    const n = v.ch[0].length
    const out = run(crowd, v, { people: 16, timing: 300, room: 'none', you: 0 })
    const c = stereoCorrelation(out)
    assert.ok(c < 0.8, 'correlation ' + c)
    const lvIn = rmsDb(v.ch[0])
    const lvOut = rmsDb(out.ch[0].subarray(0, n))
    assert.ok(Math.abs(lvOut - lvIn) < 10, 'level moved from ' + lvIn.toFixed(1) + ' to ' + lvOut.toFixed(1))
    // the input's last phrase end: some people are still talking after it
    const ph = findPhrases(v.ch[0], SR)
    const end = ph.length ? ph[ph.length - 1].end : n
    const after = rmsOf(out.ch[0], end + 0.05 * SR, end + 0.25 * SR)
    const during = rmsOf(out.ch[0], 0, end)
    assert.ok(db(after) > db(during) - 30, 'nobody is late: ' + db(after).toFixed(1) + ' vs ' + db(during).toFixed(1))
  })
  test('a crowd is not a copy: the voices are decorrelated from the original', () => {
    const v = voice(SR, 3)
    const out = run(crowd, v, { people: 8, room: 'none', you: 0 })
    const x = v.ch[0]
    const m = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) m[i] = 0.5 * (out.ch[0][i] + out.ch[1][i])
    let xy = 0, xx = 0, yy = 0
    for (let i = 0; i < x.length; i++) { xy += x[i] * m[i]; xx += x[i] * x[i]; yy += m[i] * m[i] }
    const corr = xy / Math.sqrt(xx * yy)
    assert.ok(Math.abs(corr) < 0.5, 'crowd correlates ' + corr.toFixed(2) + ' with the original')
  })
  test('forty people stay fast enough', () => {
    const v = voice(SR, 4)
    const t = performance.now()
    run(crowd, v, { people: 40, room: 'stadium' })
    const msPerSec = (performance.now() - t) / 4
    assert.ok(msPerSec < 1500, 'crowd of 40 took ' + msPerSec.toFixed(0) + ' ms per second')
  })
})

describe('stereo.split', () => {
  test('left voice is lower than the right voice', () => {
    const v = voice(SR, 3, { f0: 150, intonation: 0 })
    const out = run(split, v, { apart: 100 })
    const fL = medianF0(out.ch[0], SR)
    const fR = medianF0(out.ch[1], SR)
    const semis = 12 * Math.log2(fR / fL)
    assert.ok(semis > 7 && semis < 13, 'right is ' + semis.toFixed(1) + ' semitones above left')
  })
  test('taking turns hands phrases from ear to ear', { skip: !speech24 }, () => {
    const v = speech24
    const out = run(split, v, { mode: 'turns', apart: 100 })
    const ph = findPhrases(v.ch[0], v.sr)
    assert.ok(ph.length >= 4)
    const side = ph.map((q) => Math.sign(rmsOf(out.ch[1], q.start, q.end) - rmsOf(out.ch[0], q.start, q.end)))
    let alt = 0
    for (let k = 1; k < side.length; k++) if (side[k] !== side[k - 1]) alt++
    assert.ok(alt >= 0.8 * (side.length - 1), 'alternations ' + alt + ' of ' + (side.length - 1))
  })
})

describe('stereo.place', () => {
  const noise = noiseBuf(SR, 1.5, 'pink', 2, 1, 0.3)
  const lr = (out) => db(rmsOf(out.ch[1])) - db(rmsOf(out.ch[0]))
  test('right is right, left is left, ahead is centred', () => {
    assert.ok(lr(run(place, noise, { angle: 90, room: 'none' })) > 6)
    assert.ok(lr(run(place, noise, { angle: -90, room: 'none' })) < -6)
    assert.ok(Math.abs(lr(run(place, noise, { angle: 0, room: 'none' }))) < 0.5)
    assert.ok(Math.abs(lr(run(place, noise, { angle: 180, room: 'none' }))) < 0.5)
  })
  test('behind sounds duller than in front; above changes the pinna band', () => {
    const front = run(place, noise, { angle: 0, room: 'none' })
    const back = run(place, noise, { angle: 180, room: 'none' })
    const hiF = bandEnergyDb(front.ch[0], SR, 4000, 12000)
    const hiB = bandEnergyDb(back.ch[0], SR, 4000, 12000)
    assert.ok(hiF - hiB > 4, 'behind is only ' + (hiF - hiB).toFixed(1) + ' dB duller')
    const up = run(place, noise, { angle: 0, height: 70, room: 'none' })
    const d = Math.abs(bandEnergyDb(up.ch[0], SR, 6000, 9000) - bandEnergyDb(front.ch[0], SR, 6000, 9000))
    assert.ok(d > 1.5, 'height moved the 6-9 kHz band by ' + d.toFixed(1) + ' dB')
  })
  test('far is quieter, and in a room far is wetter', () => {
    const near = run(place, noise, { distance: 1, room: 'none' })
    const far = run(place, noise, { distance: 16, room: 'none' })
    assert.ok(db(rmsOf(near.ch[0])) - db(rmsOf(far.ch[0])) > 18)
    // the room's share: the sound after the input ends, relative to the level during it
    const n = noise.ch[0].length
    const tailShare = (o) => db(rmsOf(o.ch[0], n + 0.02 * SR, n + 0.3 * SR)) - db(rmsOf(o.ch[0], 0, n))
    const a = tailShare(run(place, noise, { distance: 1, room: 'hallway' }))
    const b = tailShare(run(place, noise, { distance: 12, room: 'hallway' }))
    assert.ok(b > a + 6, 'far is not wetter: ' + a.toFixed(1) + ' vs ' + b.toFixed(1))
  })
})

describe('stereo.orbit', () => {
  test('the voice goes round: right, behind, left, front', () => {
    const noise = noiseBuf(SR, 4, 'pink', 5, 1, 0.3)
    const out = run(orbit, noise, { period: 2, distance: 1.2 })
    const at = (t) => db(rmsOf(out.ch[1], (t - 0.05) * SR, (t + 0.05) * SR)) - db(rmsOf(out.ch[0], (t - 0.05) * SR, (t + 0.05) * SR))
    assert.ok(at(0.5) > 6, 'not right at 0.5 s: ' + at(0.5))
    assert.ok(at(1.5) < -6, 'not left at 1.5 s: ' + at(1.5))
    assert.ok(at(2.5) > 6, 'not right again at 2.5 s')
    assert.ok(Math.abs(at(1.0)) < 3, 'not centred behind at 1 s')
    const ccw = run(orbit, noise, { period: 2, direction: 'counterclockwise' })
    const at2 = db(rmsOf(ccw.ch[1], 0.45 * SR, 0.55 * SR)) - db(rmsOf(ccw.ch[0], 0.45 * SR, 0.55 * SR))
    assert.ok(at2 < -6, 'counterclockwise should start toward the left')
  })
})

describe('stereo.flyby', () => {
  test('doppler: higher coming, lower going; left then right', () => {
    const s = sine(SR, 4, 1000, 0.5)
    const out = run(flyby, s, { speed: 'car', closest: 3, room: 'none' })
    const L = out.ch[0], R = out.ch[1]
    const freq = (ch, t0, t1) => {
      let z = 0
      const a = Math.round(t0 * SR), b = Math.round(t1 * SR)
      for (let i = a + 1; i < b; i++) if (ch[i - 1] <= 0 && ch[i] > 0) z++
      return z / (t1 - t0)
    }
    const early = freq(L, 0.6, 1.4)
    const late = freq(R, 2.8, 3.6)
    assert.ok(early / late > 1.08, 'doppler ratio ' + (early / late).toFixed(3))
    assert.ok(early > 1030 && late < 970, early + ' / ' + late)
    const side = (t) => db(rmsOf(R, (t - 0.1) * SR, (t + 0.1) * SR)) - db(rmsOf(L, (t - 0.1) * SR, (t + 0.1) * SR))
    assert.ok(side(1.2) < -3 && side(2.8) > 3, 'sides ' + side(1.2) + ' ' + side(2.8))
  })
  test('passes make the voice come back', () => {
    const s = noiseBuf(SR, 4, 'pink', 3, 1, 0.3)
    const out = run(flyby, s, { passes: 2, speed: 'car', closest: 2, room: 'none' })
    const lv = (t) => db(rmsOf(out.ch[0], (t - 0.1) * SR, (t + 0.1) * SR) + rmsOf(out.ch[1], (t - 0.1) * SR, (t + 0.1) * SR))
    assert.ok(lv(1) - lv(2) > 8 && lv(3) - lv(2) > 8, 'levels ' + lv(1) + ' ' + lv(2) + ' ' + lv(3))
  })
  test('output is exactly input plus the declared tail, short and long takes', () => {
    const cases = [
      [1, {}], [1, { speed: 'jet', closest: 0.5 }], [1, { passes: 8, room: 'tunnel' }],
      [10, {}], [10, { speed: 'jet', room: 'none' }], [10, { speed: 'walk', passes: 3, room: 'stadium' }],
    ]
    for (const [secs, raw] of cases) {
      for (const sr of [48000, 22050]) {
        const v = voice(sr, secs)
        const out = run(flyby, v, raw)
        const want = v.ch[0].length + Math.round(flyby.tail(resolveParams(flyby, raw), sr) * sr)
        assert.ok(Math.abs(out.ch[0].length - want) <= 2, secs + ' s ' + JSON.stringify(raw) + ' at ' + sr + ': ' + out.ch[0].length + ' vs ' + want)
      }
    }
  })
  test('a long take stays audible from start to end', () => {
    const v = speech24 ? { sr: speech24.sr, ch: [speech24.ch[0].slice(0, speech24.sr * 10)] } : voice(SR, 10)
    const sr = v.sr
    for (const raw of [{}, { speed: 'jet' }, { closest: 30 }, { passes: 3 }]) {
      const out = run(flyby, v, raw)
      const lvIn = [], lvOut = []
      for (let s = 0; s < 10; s++) {
        lvIn.push(db(rmsOf(v.ch[0], s * sr, (s + 1) * sr)))
        lvOut.push(db(Math.sqrt(0.5 * (rmsOf(out.ch[0], s * sr, (s + 1) * sr) ** 2 + rmsOf(out.ch[1], s * sr, (s + 1) * sr) ** 2))))
      }
      for (let s = 0; s < 10; s++) {
        assert.ok(lvOut[s] - lvIn[s] > -16, JSON.stringify(raw) + ' second ' + s + ': ' + lvOut[s].toFixed(1) + ' dB against ' + lvIn[s].toFixed(1))
      }
      const all = db(Math.sqrt(0.5 * (rmsOf(out.ch[0], 0, 10 * sr) ** 2 + rmsOf(out.ch[1], 0, 10 * sr) ** 2)))
      assert.ok(all - db(rmsOf(v.ch[0])) > -12, JSON.stringify(raw) + ' overall ' + all.toFixed(1))
    }
  })
  test('jet doppler follows the moving-source law (well over 1.5 times coming)', () => {
    const s = sine(SR, 4, 500, 0.5)
    const out = run(flyby, s, { speed: 'jet', closest: 3, room: 'none' })
    const m = new Float32Array(out.ch[0].length)
    for (let i = 0; i < m.length; i++) m[i] = out.ch[0][i] + out.ch[1][i]
    let top = 0
    for (let t = 0.5; t < 3.4; t += 0.05) {
      let z = 0
      const a = Math.round(t * SR), b = Math.round((t + 0.1) * SR)
      for (let i = a + 1; i < b; i++) if (m[i - 1] <= 0 && m[i] > 0) z++
      top = Math.max(top, z / 0.1)
    }
    assert.ok(top > 1.6 * 500, 'highest pitch ' + top)
  })
})

describe('stereo.walkaway', () => {
  test('walking away fades out, walking toward fades in', () => {
    const s = noiseBuf(SR, 4, 'pink', 6, 1, 0.3)
    const away = run(walkaway, s, { room: 'none' })
    const a0 = db(rmsOf(away.ch[0], 0, 0.5 * SR)), a1 = db(rmsOf(away.ch[0], 3.4 * SR, 3.9 * SR))
    assert.ok(a0 - a1 > 12, 'away fade ' + (a0 - a1).toFixed(1))
    const toward = run(walkaway, s, { from: 12, to: 1, room: 'none' })
    const b0 = db(rmsOf(toward.ch[0], 0, 0.5 * SR)), b1 = db(rmsOf(toward.ch[0], 3.4 * SR, 3.9 * SR))
    assert.ok(b1 - b0 > 12, 'toward rise ' + (b1 - b0).toFixed(1))
  })
  test('in a hallway the room fades less than the voice', () => {
    const s = noiseBuf(SR, 4, 'pink', 6, 1, 0.3)
    const dry = run(walkaway, s, { room: 'none' })
    const wet = run(walkaway, s, { room: 'hallway' })
    const fall = (o) => db(rmsOf(o.ch[0], 0, 0.5 * SR)) - db(rmsOf(o.ch[0], 3.4 * SR, 3.9 * SR))
    assert.ok(fall(wet) < fall(dry) - 3, 'room did not hold up: ' + fall(wet) + ' vs ' + fall(dry))
  })
})

describe('stereo.pingpong', () => {
  test('phrases alternate ears', { skip: !speech24 }, () => {
    const v = speech24
    const out = run(pingpong, v, { width: 100 })
    const ph = findPhrases(v.ch[0], v.sr)
    const side = ph.map((q) => Math.sign(rmsOf(out.ch[1], q.start + 0.05 * v.sr, q.end - 0.05 * v.sr) - rmsOf(out.ch[0], q.start + 0.05 * v.sr, q.end - 0.05 * v.sr)))
    assert.equal(side[0], -1, 'first phrase should be left')
    let alt = 0
    for (let k = 1; k < side.length; k++) if (side[k] !== side[k - 1]) alt++
    assert.ok(alt >= 0.9 * (side.length - 1), 'alternations ' + alt + ' of ' + (side.length - 1))
  })
  test('synthetic talker: both ears get phrases', () => {
    const v = voice(SR, 4)
    const out = run(pingpong, v, { width: 100, start: 'right' })
    assert.ok(rmsDb(out.ch[0]) > -40 && rmsDb(out.ch[1]) > -40)
  })
})

// ---------------------------------------------------------------- live

function runLive(mod, input, p, block, opts = {}) {
  const rp = resolveParams(mod, p)
  const inst = mod.live.create(input.sr, rp, makeRng('live'))
  const n = input.ch[0].length
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const two = input.ch.length > 1
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    if (opts.setAt !== undefined && i <= opts.setAt && opts.setAt < i + m) inst.set(resolveParams(mod, opts.setTo))
    const lv = L.subarray(i, i + m)
    const rv = R.subarray(i, i + m)
    if (opts.alias) {
      // outputs alias the inputs: copy the input into the output views first
      lv.set(input.ch[0].subarray(i, i + m))
      if (two) rv.set(input.ch[1].subarray(i, i + m))
      inst.process(two ? [lv, rv] : [lv], [lv, rv], m)
    } else {
      inst.process(two ? [input.ch[0].subarray(i, i + m), input.ch[1].subarray(i, i + m)] : [input.ch[0].subarray(i, i + m)], [lv, rv], m)
    }
  }
  return { sr: input.sr, ch: [L, R], inst }
}

describe('stereo live', () => {
  for (const mod of LIVE) {
    test(mod.id + ' live: blocks of 128 and 480, aliased, set() mid-stream, reset', () => {
      const v = voice(SR, 1.5)
      for (const block of [128, 480, 37]) {
        const a = runLive(mod, v, {}, block, { alias: true, setAt: 30000, setTo: extremes(mod, 'max') })
        assertSane(a, { maxPeak: 8 })
        const b = runLive(mod, v, {}, block, { setAt: 30000, setTo: extremes(mod, 'min') })
        assertSane(b, { maxPeak: 8 })
        b.inst.reset()
      }
      const st = { sr: SR, ch: [v.ch[0], v.ch[0].map((x) => 0.5 * x)] }
      assertSane(runLive(mod, st, {}, 128, { alias: true }), { maxPeak: 8 })
      const lat = mod.live.latency(resolveParams(mod, {}), SR)
      assert.ok(Number.isFinite(lat) && lat >= 0)
    })
    test(mod.id + ' live runs faster than real time', () => {
      const v = voice(SR, 2)
      const t = performance.now()
      runLive(mod, v, {}, 128)
      const ms = performance.now() - t
      assert.ok(ms < 2000 * 0.5, mod.id + ' live took ' + ms.toFixed(0) + ' ms for 2 s')
    })
  }
  test('width and haas live equal their offline output', () => {
    const v = voice(SR, 1)
    for (const mod of [width, haas]) {
      const off = run(mod, v, {})
      const on = runLive(mod, v, {}, 128)
      let err = 0
      for (let c = 0; c < 2; c++) for (let i = 0; i < v.ch[0].length; i++) err = Math.max(err, Math.abs(off.ch[c][i] - on.ch[c][i]))
      assert.ok(err < 1e-5, mod.id + ' live differs by ' + err)
    }
  })
  test('place live matches offline direction and level', () => {
    const noise = noiseBuf(SR, 1.5, 'pink', 2, 1, 0.3)
    for (const angle of [-90, -30, 60, 150]) {
      const p = { angle, room: 'none' }
      const off = run(place, noise, p)
      const on = runLive(place, noise, p, 128)
      for (let c = 0; c < 2; c++) {
        const d = db(rmsOf(off.ch[c], 2000, noise.ch[0].length)) - db(rmsOf(on.ch[c], 2000, noise.ch[0].length))
        assert.ok(Math.abs(d) < 0.5, 'angle ' + angle + ' ear ' + c + ' differs by ' + d.toFixed(2) + ' dB')
      }
    }
    const lr = runLive(place, noise, { angle: 90, room: 'small-room' }, 128)
    assert.ok(db(rmsOf(lr.ch[1])) - db(rmsOf(lr.ch[0])) > 4)
  })
  test('orbit live goes round like the offline one', () => {
    const noise = noiseBuf(SR, 3, 'pink', 5, 1, 0.3)
    const on = runLive(orbit, noise, { period: 2 }, 128)
    const at = (t) => db(rmsOf(on.ch[1], (t - 0.05) * SR, (t + 0.05) * SR)) - db(rmsOf(on.ch[0], (t - 0.05) * SR, (t + 0.05) * SR))
    assert.ok(at(0.5) > 6 && at(1.5) < -6 && at(2.5) > 6, [at(0.5), at(1.5), at(2.5)].join(' '))
  })
  test('double live is wide and keeps the copies short', () => {
    const v = voice(SR, 2)
    const on = runLive(double, v, { timing: 60 }, 128)
    const c = stereoCorrelation(on)
    assert.ok(c < 0.97, 'correlation ' + c)
  })
})

describe('stereo second real voice', () => {
  test('crowd and orbit on the second speech take', { skip: !speech24b }, () => {
    const b = { sr: speech24b.sr, ch: [speech24b.ch[0].slice(0, speech24b.sr * 6)] }
    checkOut(crowd, b, run(crowd, b, { people: 10 }), { people: 10 })
    checkOut(orbit, b, run(orbit, b, {}), {})
  })
})
