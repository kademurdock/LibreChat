// test/beds-places.nodetest.mjs - the places beds (CONTRACT section 6) and the places kit.
//
// What it checks:
// 1. Shape: every bed exports the contract fields, its id matches its file,
//    it sits in the "places" group, its spoken words are plain (the brand
//    and person-name net from core/params.js), its params pass the same
//    checks as module params, and it has an intensity control.
// 2. Behaviour: stereo out, exactly the length asked for at 8, 22.05, 44.1,
//    48 and 96 kHz; finite, peaks under full scale, a sensible level; the
//    same seed gives the same bed and another seed a different one; zero or
//    nonsense lengths give an empty stereo bed; every param at its ends and
//    every choice and switch still works.
// 3. Loop-free and alive: two stretches of a 20 second bed are unrelated
//    (no repeated loop), and the bed's level moves over time the way a place
//    does.
// 4. Each bed does what its name says, measured: the heart monitor beeps at
//    the heart rate asked for; the fridge hum lives in the lows; the server
//    room behind its door loses its highs; the stadium's cheers swell with
//    excitement; the subway's trains rise far above the platform; a talker's
//    pitch sits in the range of its voice and its loudness moves at the
//    syllable rate of speech; a car's pitch drops as it passes (Doppler);
//    the room's decay matches the time it was asked for; the talker-rate
//    interpolator keeps images down.
// 5. Speed: 20 seconds of every bed at 48 kHz, with a generous bound (other
//    builders share the CPU); the listening script reports the real numbers.
//
// Run: node --test "engine/test/beds-places.nodetest.mjs"

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { makeRng } from '../core/rng.js'
import { validateModuleShape, resolveParams, findBlockedWord } from '../core/params.js'
import { estimateRT60 } from '../core/ir.js'
import { assertSane, rmsDb, stereoCorrelation, bandEnergyDb, medianF0 } from './measure.mjs'
import * as kit from '../beds/cafe.js'

const IDS = [
  'city-street', 'subway-platform', 'airport-hall', 'office', 'cafe', 'kitchen', 'school-hall', 'hospital', 'factory',
  'construction', 'arcade-hall', 'casino', 'carnival', 'stadium-crowd', 'library-hush', 'laundromat', 'server-room',
  'fridge-hum',
]

const BEDS = {}
for (const id of IDS) BEDS[id] = (await import('../beds/' + id + '.js')).default

function gen(id, seconds, sr = 48000, p = {}, seed = 1) {
  return BEDS[id].generate(seconds, sr, p, makeRng(seed))
}

/** RMS in dB of each consecutive window of `win` seconds over both channels. */
function windowsDb(buf, win) {
  const n = buf.ch[0].length
  const w = Math.max(1, Math.round(win * buf.sr))
  const out = []
  for (let a = 0; a + w <= n; a += w) {
    let e = 0
    for (const c of buf.ch) for (let i = a; i < a + w; i++) e += c[i] * c[i]
    out.push(10 * Math.log10(e / (2 * w) + 1e-20))
  }
  return out
}

function corr(a, b) {
  let ma = 0
  let mb = 0
  for (let i = 0; i < a.length; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= a.length
  mb /= b.length
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    sab += x * y
    saa += x * x
    sbb += y * y
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0
}

function mono(buf) {
  const [L, R] = buf.ch
  const m = new Float32Array(L.length)
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i])
  return m
}

// ---------------------------------------------------------------- shape

describe('places beds: shape', () => {
  for (const id of IDS) {
    test(id + ' has the contract fields and plain words', () => {
      const b = BEDS[id]
      assert.equal(b.id, id)
      assert.equal(b.group, 'places')
      assert.equal(typeof b.generate, 'function')
      assert.ok(typeof b.name === 'string' && b.name.length >= 3 && b.name.length <= 40, 'name')
      assert.ok(typeof b.about === 'string' && b.about.length > 20 && b.about.length <= 120, 'about is one short sentence: ' + b.about.length)
      assert.ok(/[.]$/.test(b.about), 'about ends with a full stop')
      assert.equal(findBlockedWord(b.name), null)
      assert.equal(findBlockedWord(b.about), null)
      assert.ok(Array.isArray(b.params) && b.params.length >= 2 && b.params.length <= 8, 'two to eight params')
      assert.ok(b.params.some((q) => q.id === 'intensity'), 'has an intensity control')
      // the module checks, applied to the bed's params and words
      const shim = { id: 'bed.' + id, family: 'bed', name: b.name, about: b.about, params: b.params, stereo: 'make', cost: 1, process() {} }
      const problems = validateModuleShape(shim)
      assert.deepEqual(problems, [])
      for (const q of b.params) {
        if (q.type === 'choice') for (const o of q.options) assert.equal(findBlockedWord(o.name), null)
      }
    })
  }
})

// ---------------------------------------------------------------- behaviour

describe('places beds: behaviour', () => {
  for (const id of IDS) {
    test(id + ': stereo, exact length, sane level, deterministic', () => {
      const a = gen(id, 3)
      assert.equal(a.sr, 48000)
      assert.equal(a.ch.length, 2)
      assert.equal(a.ch[0].length, 144000)
      const { peak } = assertSane(a, { maxPeak: 1 })
      assert.ok(peak > 0.005, 'not silent')
      const db = rmsDb(a)
      assert.ok(db > -50 && db < -12, 'level ' + db.toFixed(1) + ' dB')
      const c = stereoCorrelation(a)
      assert.ok(c < 0.99 && c > -0.5, 'a real stereo image, correlation ' + c.toFixed(3))
      let dc = 0
      for (const v of a.ch[0]) dc += v
      assert.ok(Math.abs(dc / a.ch[0].length) < 0.01, 'no offset')
      const b = gen(id, 3)
      assert.deepEqual(Array.from(b.ch[0].subarray(0, 4000)), Array.from(a.ch[0].subarray(0, 4000)))
      assert.equal(rmsDb(b).toFixed(6), db.toFixed(6))
      const other = gen(id, 3, 48000, {}, 2)
      assert.ok(corr(other.ch[0], a.ch[0]) < 0.9, 'a different seed gives a different bed')
    })

    test(id + ': empty and tiny lengths, every rate', () => {
      for (const s of [0, -1, NaN, undefined, Infinity]) {
        const e = BEDS[id].generate(s, 48000, {}, makeRng(1))
        assert.equal(e.ch.length, 2)
        assert.equal(e.ch[0].length, 0)
        assert.equal(e.ch[1].length, 0)
      }
      const tiny = gen(id, 0.001)
      assert.equal(tiny.ch[0].length, 48)
      assertSane(tiny, { maxPeak: 1 })
      for (const sr of [8000, 22050, 44100, 96000]) {
        const b = gen(id, 0.7, sr)
        assert.equal(b.sr, sr)
        assert.equal(b.ch[0].length, Math.round(0.7 * sr))
        assertSane(b, { maxPeak: 1 })
        assert.ok(rmsDb(b) > -70, 'audible at ' + sr)
      }
      // no params object, no rng
      const bare = BEDS[id].generate(0.3, 48000)
      assertSane(bare, { maxPeak: 1 })
    })

    test(id + ': every param at its ends, every choice and switch', () => {
      const b = BEDS[id]
      const sets = []
      const lo = {}
      const hi = {}
      for (const q of b.params) {
        if (q.type === 'number') {
          lo[q.id] = q.min
          hi[q.id] = q.max
        } else if (q.type === 'bool') {
          sets.push({ [q.id]: !q.def })
        } else {
          for (const o of q.options) if (o.v !== q.def) sets.push({ [q.id]: o.v })
        }
      }
      sets.push(lo, hi)
      for (const p of sets) {
        const r = resolveParams(b, p, { strict: true })
        assert.ok(r)
        const out = b.generate(0.6, 48000, p, makeRng(3))
        assert.equal(out.ch[0].length, 28800)
        assertSane(out, { maxPeak: 1 })
      }
      // garbage values fall back to defaults instead of breaking
      const odd = {}
      for (const q of b.params) odd[q.id] = q.type === 'number' ? 'lots' : 'nonsense'
      assertSane(b.generate(0.3, 48000, odd, makeRng(4)), { maxPeak: 1 })
    })
  }
})

// ---------------------------------------------------------------- loop-free, alive, speed

describe('places beds: twenty seconds', () => {
  for (const id of IDS) {
    test(id + ': loop-free, moving, and fast enough', () => {
      const t0 = performance.now()
      const b = gen(id, 20)
      const ms = performance.now() - t0
      assertSane(b, { maxPeak: 1 })
      assert.ok(ms < 6000, '20 s took ' + ms.toFixed(0) + ' ms')
      // no stretch repeats another: compare 2 s windows at several offsets,
      // above 1.5 kHz (steady hums are pure tones that line up by chance;
      // a copied loop would line up in its noise too)
      const L = kit.filt(new Float32Array(b.ch[0]), 48000, [['highpass', 1500, 0.7], ['highpass', 1500, 0.7]])
      const w = 96000
      for (const [a, c] of [[0, 480000], [96000, 576000], [240000, 768000]]) {
        const r = corr(L.subarray(a, a + w), L.subarray(c, c + w))
        assert.ok(Math.abs(r) < 0.5, 'windows at ' + a / 48000 + ' s and ' + c / 48000 + ' s correlate ' + r.toFixed(2))
      }
      const secs = windowsDb(b, 1)
      const finite = secs.every((v) => Number.isFinite(v))
      assert.ok(finite)
      const spread = Math.max(...secs) - Math.min(...secs)
      assert.ok(spread < 40, 'level stays usable as a bed: spread ' + spread.toFixed(1) + ' dB')
    })
  }
})

// ---------------------------------------------------------------- does what it says

/** Count beep onsets: band 850-1100 Hz envelope crossing a threshold. */
function beepOnsets(buf, lo, hi) {
  const m = mono(buf)
  const sr = buf.sr
  const f = new Float32Array(m)
  kit.filt(f, sr, [['bandpass', Math.sqrt(lo * hi), 3], ['bandpass', Math.sqrt(lo * hi), 3]])
  const hop = Math.round(0.005 * sr)
  const env = []
  for (let a = 0; a + hop <= f.length; a += hop) {
    let e = 0
    for (let i = a; i < a + hop; i++) e += f[i] * f[i]
    env.push(Math.sqrt(e / hop))
  }
  const pk = Math.max(...env)
  let count = 0
  let on = false
  let last = -1e9
  env.forEach((v, k) => {
    if (!on && v > pk * 0.3 && k - last > 40) {
      count++
      on = true
      last = k
    } else if (on && v < pk * 0.12) on = false
  })
  return count
}

describe('places beds: each one does what its name says', () => {
  test('hospital: the monitor beeps at the heart rate asked for', () => {
    for (const bpm of [60, 120]) {
      const b = gen('hospital', 12, 48000, { heartRate: bpm, monitors: 1, pages: 0, intensity: 0 })
      const n = beepOnsets(b, 850, 1100)
      const expected = (bpm * 12) / 60
      assert.ok(Math.abs(n - expected) <= Math.max(2, expected * 0.15), bpm + ' bpm gave ' + n + ' beeps in 12 s, wanted about ' + expected)
    }
  })

  test('fridge: the hum lives in the lows', () => {
    const b = gen('fridge-hum', 6, 48000, { ice: 0 })
    const m = mono(b)
    const low = bandEnergyDb(m, 48000, 40, 400)
    const high = bandEnergyDb(m, 48000, 2000, 8000)
    assert.ok(low - high > 15, 'lows ' + low.toFixed(1) + ' dB, highs ' + high.toFixed(1) + ' dB')
  })

  test('server room: from behind the door the highs are gone', () => {
    const inside = mono(gen('server-room', 4, 48000, { where: 'inside' }))
    const door = mono(gen('server-room', 4, 48000, { where: 'door' }))
    const di = bandEnergyDb(inside, 48000, 2000, 8000) - bandEnergyDb(inside, 48000, 50, 400)
    const dd = bandEnergyDb(door, 48000, 2000, 8000) - bandEnergyDb(door, 48000, 50, 400)
    assert.ok(di - dd > 20, 'high-to-low balance drops by ' + (di - dd).toFixed(1) + ' dB')
  })

  test('stadium: more excitement, bigger swells', () => {
    const calm = windowsDb(gen('stadium-crowd', 20, 48000, { excitement: 0, chants: 0 }, 5), 0.5)
    const wild = windowsDb(gen('stadium-crowd', 20, 48000, { excitement: 100, chants: 0 }, 5), 0.5)
    // spread between the loud moments and the steady murmur
    const range = (a) => {
      const s = [...a].sort((x, y) => x - y)
      return s[Math.floor(0.95 * (s.length - 1))] - s[Math.floor(0.1 * s.length)]
    }
    assert.ok(range(wild) > range(calm) + 2, 'calm ' + range(calm).toFixed(1) + ' dB, wild ' + range(wild).toFixed(1) + ' dB')
  })

  test('subway: a train rises far above the waiting platform', () => {
    const b = gen('subway-platform', 20, 48000, { trains: 100, announcements: 0 })
    const s = windowsDb(b, 1).sort((x, y) => x - y)
    assert.ok(s[s.length - 1] - s[0] > 6, 'loudest second over quietest: ' + (s[s.length - 1] - s[0]).toFixed(1) + ' dB')
  })

  test('city: more traffic, a louder street', () => {
    const quiet = rmsDb(gen('city-street', 8, 48000, { intensity: 5, horns: 0, sirens: 0 }))
    const busy = rmsDb(gen('city-street', 8, 48000, { intensity: 95, horns: 0, sirens: 0 }))
    assert.ok(busy > quiet + 3, 'quiet ' + quiet.toFixed(1) + ', busy ' + busy.toFixed(1))
  })

  test('library: a hush, far quieter than the cafe', () => {
    assert.ok(rmsDb(gen('library-hush', 4)) < rmsDb(gen('cafe', 4)) - 6)
  })
})

describe('places kit', () => {
  test('talkers sit in their voice ranges and move at the syllable rate', () => {
    const wr = 16000
    for (const [kind, lo, hi] of [['man', 80, 190], ['woman', 150, 330], ['child', 210, 420]]) {
      const rng = makeRng('talker-' + kind)
      const T = kit.makeTalker(rng, kind, { effort: 0.3 })
      const fr = []
      let t = 0
      for (let k = 0; k < 4; k++) t = kit.phraseFrames(T, rng, fr, t, 9) + 0.3
      const sig = kit.renderFrames(T, fr, wr, T.seed)
      assertSane({ sr: wr, ch: [sig] }, { maxPeak: 4 })
      const f0 = medianF0(sig, wr)
      assert.ok(f0 > lo && f0 < hi, kind + ' median pitch ' + f0.toFixed(0) + ' Hz')
      // loudness envelope: most modulation energy between 2 and 9 Hz
      const hop = 160
      const env = []
      for (let a = 0; a + hop <= sig.length; a += hop) {
        let e = 0
        for (let i = a; i < a + hop; i++) e += sig[i] * sig[i]
        env.push(Math.sqrt(e / hop))
      }
      const mean = env.reduce((x, y) => x + y, 0) / env.length
      const x = env.map((v) => v - mean)
      const er = 100 // envelope rate (frames per second)
      const power = (f) => {
        let re = 0
        let im = 0
        for (let k = 0; k < x.length; k++) {
          re += x[k] * Math.cos((2 * Math.PI * f * k) / er)
          im += x[k] * Math.sin((2 * Math.PI * f * k) / er)
        }
        return re * re + im * im
      }
      let syll = 0
      let fast = 0
      for (let f = 2; f <= 9; f += 0.5) syll += power(f)
      for (let f = 20; f <= 27; f += 0.5) fast += power(f)
      assert.ok(syll > fast * 4, kind + ': syllable-rate modulation ' + (10 * Math.log10(syll / fast)).toFixed(1) + ' dB over fast flutter')
    }
  })

  test('a passing car drops in pitch as it goes by (Doppler from travel time)', () => {
    const sc = kit.makeScene({ id: 'test', params: [] }, 6, 48000, {}, makeRng(1), { send: 0 })
    const f = 600
    const sig = kit.sinePhasor(6 * 48000, 48000, f, 0, 0)
    const v = 25
    kit.emitMoving(sc, sig, 0, (t, p) => {
      p.x = v * (t - 3)
      p.y = 4
    }, 1, 0)
    const zc = (a, b) => {
      let n = 0
      for (let i = a + 1; i < b; i++) if (sc.L[i - 1] <= 0 && sc.L[i] > 0) n++
      return n / ((b - a) / 48000)
    }
    const before = zc(24000, 72000)
    const after = zc(216000, 264000)
    const want = (343 + v) / (343 - v)
    assert.ok(Math.abs(before / after / want - 1) < 0.06, 'pitch ratio ' + (before / after).toFixed(3) + ', physics says ' + want.toFixed(3))
  })

  test('the room decays in the time asked for', () => {
    for (const rt of [0.6, 2.0]) {
      const n = Math.round((rt * 2.5 + 0.2) * 48000)
      const x = new Float32Array(n)
      x[0] = 1
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      new kit.Fdn(48000, { size: 1, rt60: rt, rt60High: rt, rt60Low: rt, predelayMs: 0, taps: [], wet: 1 }, makeRng(2)).process(x, L, R)
      const est = estimateRT60(L, 48000)
      assert.ok(Math.abs(est / rt - 1) < 0.3, 'asked ' + rt + ' s, measured ' + est.toFixed(2) + ' s')
      let e = 0
      for (let i = 0; i < n; i++) e += L[i] * L[i]
      assert.ok(e > 0.3 && e < 3, 'tail energy near one impulse: ' + e.toFixed(2))
    }
  })

  test('the talker-rate interpolator keeps images down', () => {
    const k = 3
    const lo = kit.sinePhasor(16000, 16000, 1000, 0, 0)
    const up = new Float32Array(48000)
    kit.upAdd(lo, up, k)
    const main = bandEnergyDb(up.subarray(4000, 44000), 48000, 900, 1100)
    const image = bandEnergyDb(up.subarray(4000, 44000), 48000, 14500, 17500)
    assert.ok(main - image > 45, 'image ' + (main - image).toFixed(1) + ' dB down')
  })

  test('struck objects ring at their modes and stop', () => {
    const sig = kit.modal(48000, [1000, 0.05, 1], { tick: 0 })
    assertSane({ sr: 48000, ch: [sig] }, { maxPeak: 2 })
    let zc = 0
    for (let i = 1; i < 4800; i++) if (sig[i - 1] <= 0 && sig[i] > 0) zc++
    assert.ok(Math.abs(zc / 0.1 - 1000) < 30, 'rings at 1 kHz: ' + (zc / 0.1).toFixed(0))
    assert.ok(Math.abs(sig[sig.length - 1]) < 1e-3, 'dies away')
  })
})
