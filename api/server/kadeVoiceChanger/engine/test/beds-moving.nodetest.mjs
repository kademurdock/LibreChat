// test/beds-moving.nodetest.mjs - the moving and spooky background beds
// (CONTRACT section 6): vehicles, haunted places, heartbeat, clock, static,
// phone line and the broken music box.
//
// Every bed: shape and plain names, exact stereo length at many rates,
// finite and under full scale with every setting at min, default and max
// and every choice, deterministic per seed, never a short repeating loop,
// louder or busier with intensity, and fast enough (20 s at 48 kHz, budget
// 1.5 s; the assert is generous because other builders share the CPU).
// Then each bed proves it does what its name says: train joints click,
// rotor beats at its rate, heartbeat at its rate, clocks at theirs, dial
// tone at 350 + 440 Hz inside the phone band, sonar pings, cabin chimes,
// the music box in A minor, the rocket building and receding, distance
// darkening, the eerie whine gliding and wobbling as set, and more.
//
// Measures come from test/measure.mjs (an independent FFT and band meters)
// plus small envelope helpers below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { makeRng } from '../core/rng.js'
import { findBlockedWord, UNITS } from '../core/params.js'
import { lufs } from '../core/loudness.js'
import { bandEnergyDb, spectralCentroid, rmsDb, stereoCorrelation, assertSane, cfft, f0Track } from './measure.mjs'

const IDS = [
  'car-highway', 'car-rain', 'bus', 'train', 'subway-car', 'airplane-cabin', 'helicopter-cabin', 'boat-engine', 'sailboat',
  'spaceship-bridge', 'engine-room', 'submarine', 'rocket-launch', 'haunted-house', 'graveyard', 'dungeon', 'heartbeat',
  'clock-tick', 'radio-static', 'tv-static', 'phone-line', 'music-box-broken', 'eerie-whine',
]

const BEDS = {}
for (const id of IDS) BEDS[id] = (await import('../beds/' + id + '.js')).default

const gen = (id, secs, sr, p = {}, seed = 1) => BEDS[id].generate(secs, sr, p, makeRng(seed))

function mono(b) {
  const n = b.ch[0].length
  const m = new Float32Array(n)
  for (let i = 0; i < n; i++) m[i] = 0.5 * (b.ch[0][i] + b.ch[1][i])
  return m
}

/** Energy envelope in frames of frameMs; optional crude band: 'low' (moving average), 'high' (first difference). */
function envelope(sig, sr, frameMs = 5, band = 'all') {
  let x = sig
  if (band === 'high') {
    x = new Float32Array(sig.length)
    for (let i = 1; i < sig.length; i++) x[i] = sig[i] - sig[i - 1]
  } else if (band === 'low') {
    x = new Float32Array(sig.length)
    const a = 1 - Math.exp((-2 * Math.PI * 200) / sr)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < sig.length; i++) {
      s1 += a * (sig[i] - s1)
      s2 += a * (s1 - s2)
      x[i] = s2
    }
  }
  const f = Math.max(1, Math.round((frameMs / 1000) * sr))
  const m = Math.floor(x.length / f)
  const e = new Float64Array(m)
  for (let j = 0; j < m; j++) {
    let s = 0
    for (let i = j * f; i < (j + 1) * f; i++) s += x[i] * x[i]
    e[j] = s / f
  }
  return { e, frameSec: f / sr }
}

/** Lag (seconds) of the strongest normalised autocorrelation peak of an envelope between lo and hi seconds. */
function envPeriod(env, frameSec, lo, hi) {
  const e = env
  const n = e.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += e[i]
  mean /= n
  const d = new Float64Array(n)
  let v = 0
  for (let i = 0; i < n; i++) {
    d[i] = e[i] - mean
    v += d[i] * d[i]
  }
  let best = -2
  let bestLag = 0
  const l0 = Math.max(1, Math.round(lo / frameSec))
  const l1 = Math.min(n - 2, Math.round(hi / frameSec))
  const ac = new Float64Array(l1 + 2)
  for (let lag = l0 - 1; lag <= l1 + 1; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag]
    ac[lag] = s / v
  }
  for (let lag = l0; lag <= l1; lag++) {
    if (ac[lag] > best && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      best = ac[lag]
      bestLag = lag
    }
  }
  return { period: bestLag * frameSec, strength: best }
}

/** Largest normalised autocorrelation of the signal over lags lo..hi seconds (FFT, independent of the engine). */
function maxAutocorr(sig, sr, lo, hi) {
  let N = 1
  while (N < 2 * sig.length) N <<= 1
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  let mean = 0
  for (let i = 0; i < sig.length; i++) mean += sig[i]
  mean /= sig.length
  for (let i = 0; i < sig.length; i++) re[i] = sig[i] - mean
  cfft(re, im, false)
  for (let k = 0; k < N; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k]
    im[k] = 0
  }
  cfft(re, im, true)
  const z = re[0]
  let best = -1
  for (let lag = Math.round(lo * sr); lag <= Math.round(hi * sr) && lag < sig.length; lag++) {
    // unbiased: correct for the shrinking overlap
    const v = (re[lag] / z) * (sig.length / (sig.length - lag))
    if (v > best) best = v
  }
  return best
}

// ------------------------------------------------------------------ shape

test('every moving and spooky bed has the contract shape and plain spoken names', () => {
  for (const id of IDS) {
    const b = BEDS[id]
    assert.equal(b.id, id, 'id matches the file name')
    assert.ok(typeof b.name === 'string' && b.name.length >= 3 && b.name.length <= 40, id + ' name')
    assert.ok(['vehicles', 'spooky'].includes(b.group), id + ' group ' + b.group)
    assert.ok(typeof b.about === 'string' && b.about.length > 20 && b.about.length <= 120, id + ' about length ' + b.about.length)
    assert.equal(typeof b.generate, 'function')
    assert.ok(Array.isArray(b.params) && b.params.length >= 2 && b.params.length <= 8, id + ' has 2 to 8 settings')
    const texts = [b.name, b.about]
    const seen = new Set()
    for (const p of b.params) {
      assert.ok(/^[a-zA-Z][a-zA-Z0-9]*$/.test(p.id) && !seen.has(p.id), id + ' param id ' + p.id)
      seen.add(p.id)
      assert.ok(typeof p.name === 'string' && p.name.trim(), id + ' param name')
      texts.push(p.name)
      if (p.type === 'number') {
        assert.ok(p.min < p.max && p.def >= p.min && p.def <= p.max, id + '.' + p.id + ' range')
        assert.ok(UNITS.includes(p.unit), id + '.' + p.id + ' unit ' + p.unit)
        if (p.step) assert.ok(Math.abs((p.def - p.min) / p.step - Math.round((p.def - p.min) / p.step)) < 1e-6, id + '.' + p.id + ' default on step')
        if (p.unit === 'percent') assert.ok(p.min >= -100 && p.max <= 100)
        if (p.rand) assert.ok(p.rand[0] >= p.min && p.rand[1] <= p.max && p.rand[0] <= p.rand[1], id + '.' + p.id + ' rand')
      } else if (p.type === 'choice') {
        assert.ok(p.options.length >= 2, id + '.' + p.id + ' options')
        assert.ok(p.options.some((o) => o.v === p.def), id + '.' + p.id + ' default is an option')
        for (const o of p.options) texts.push(o.name)
      } else {
        assert.equal(p.type, 'bool')
        assert.equal(typeof p.def, 'boolean')
      }
    }
    assert.ok(b.params.some((p) => p.id === 'intensity'), id + ' has an intensity setting')
    for (const t of texts) assert.equal(findBlockedWord(t), null, id + ': "' + t + '" uses a blocked word')
  }
})

// ------------------------------------------------------------------ buffers

test('every bed returns stereo of exactly the asked length at many rates, finite and under full scale', () => {
  for (const id of IDS) {
    for (const [secs, sr] of [[0, 48000], [0.01, 48000], [0.37, 44100], [1.5, 8000], [1.2, 22050], [1.5, 96000], [2.5, 48000]]) {
      const b = gen(id, secs, sr)
      assert.equal(b.sr, sr, id + ' rate')
      assert.equal(b.ch.length, 2, id + ' is stereo')
      const n = Math.round(secs * sr)
      assert.equal(b.ch[0].length, n, id + ' length at ' + sr)
      assert.equal(b.ch[1].length, n)
      if (n) {
        const { peak } = assertSane(b, { maxPeak: 1 })
        if (secs >= 1) assert.ok(rmsDb(b) > -60, id + ' at ' + sr + ' Hz is not silent (' + rmsDb(b).toFixed(1) + ' dB)')
        assert.ok(peak <= 0.951, id + ' peak ' + peak)
      }
    }
  }
})

test('every setting at min, max, and every choice renders cleanly and audibly', () => {
  for (const id of IDS) {
    const b = BEDS[id]
    const mins = {}
    const maxs = {}
    for (const p of b.params) {
      if (p.type === 'number') {
        mins[p.id] = p.min
        maxs[p.id] = p.max
      } else if (p.type === 'bool') {
        mins[p.id] = false
        maxs[p.id] = true
      }
    }
    const runs = [mins, maxs]
    for (const p of b.params) {
      if (p.type === 'choice') for (const o of p.options) runs.push({ [p.id]: o.v })
      if (p.type === 'bool') runs.push({ [p.id]: !p.def })
    }
    for (const pp of runs) {
      const out = gen(id, 2.5, 24000, pp, 4)
      assertSane(out, { maxPeak: 1 })
      assert.equal(out.ch[0].length, 60000)
      assert.ok(rmsDb(out) > -70, id + ' ' + JSON.stringify(pp) + ' is audible (' + rmsDb(out).toFixed(1) + ' dB)')
    }
    // unknown and junk settings are ignored, never thrown
    const junk = gen(id, 0.5, 16000, { nonsense: 3, intensity: 'loud' })
    assertSane(junk, { maxPeak: 1 })
  }
})

test('beds are deterministic per seed and differ between seeds', () => {
  for (const id of IDS) {
    const a = gen(id, 1.5, 16000, {}, 11)
    const b = gen(id, 1.5, 16000, {}, 11)
    const c = gen(id, 1.5, 16000, {}, 12)
    assert.deepEqual(a.ch[0], b.ch[0], id + ' same seed, same sound')
    let diff = 0
    for (let i = 0; i < a.ch[0].length; i++) diff += Math.abs(a.ch[0][i] - c.ch[0][i])
    assert.ok(diff > 1e-3, id + ' another seed sounds different')
  }
})

test('beds are truly stereo (the two sides are not identical)', () => {
  for (const id of IDS) {
    const b = gen(id, 3, 16000)
    const rho = stereoCorrelation(b)
    assert.ok(rho < 0.999, id + ' left and right differ (correlation ' + rho.toFixed(4) + ')')
  }
})

test('no bed is a short repeating loop', () => {
  // A looped bed correlates near 1 with itself at the loop length. Tones
  // that are periodic by nature (the dial tone) are tested on an open line.
  const p = { 'phone-line': { tone: 'none' } }
  for (const id of IDS) {
    const b = gen(id, 14, 8000, p[id] || {}, 21)
    const m = mono(b)
    const ac = maxAutocorr(m, 8000, 0.6, 7)
    assert.ok(ac < 0.9, id + ' repeats itself (autocorrelation ' + ac.toFixed(3) + ')')
  }
})

test('intensity changes the bed: louder or busier at the top of its range', () => {
  const extra = { 'phone-line': { tone: 'none' } }
  for (const id of IDS) {
    const ip = BEDS[id].params.find((q) => q.id === 'intensity')
    const lo = gen(id, 6, 16000, { ...(extra[id] || {}), intensity: ip.min }, 3)
    const hi = gen(id, 6, 16000, { ...(extra[id] || {}), intensity: ip.max }, 3)
    const d = rmsDb(hi) - rmsDb(lo)
    assert.ok(d > 2, id + ' intensity raises the level by more than 2 dB (got ' + d.toFixed(1) + ')')
  }
})

test('speed: 20 seconds of every bed at 48 kHz (budget 1.5 s each)', () => {
  const times = []
  for (const id of IDS) {
    const t0 = performance.now()
    const b = gen(id, 20, 48000)
    const ms = performance.now() - t0
    assertSane(b, { maxPeak: 1 })
    times.push([id, ms])
    assert.ok(ms < 4500, id + ' took ' + ms.toFixed(0) + ' ms for 20 s')
  }
  console.log('beds-moving timings (ms per 20 s at 48 kHz): ' + times.map(([id, ms]) => id + ' ' + ms.toFixed(0)).join(', '))
})

// ------------------------------------------------------------------ prove it

test('train: jointed rails click in an axle rhythm; welded rails do not', () => {
  const sr = 16000
  const count = (b) => {
    const { e } = envelope(mono(b), sr, 5, 'high')
    const s = Array.from(e).sort((a, c) => a - c)
    const med = s[Math.floor(s.length / 2)]
    let c = 0
    for (let i = 1; i < e.length - 1; i++) if (e[i] > 6 * med && e[i] >= e[i - 1] && e[i] >= e[i + 1]) c++
    return c
  }
  const jointed = gen('train', 12, sr, { track: 'jointed', horn: 0 }, 5)
  const welded = gen('train', 12, sr, { track: 'welded', horn: 0 }, 5)
  const cj = count(jointed)
  const cw = count(welded)
  assert.ok(cj >= 15 && cj > 3 * Math.max(1, cw), 'clicks jointed ' + cj + ', welded ' + cw)
})

test('helicopter: the rotor thump beats at its set rate', () => {
  const sr = 8000
  for (const rate of [5.5, 9]) {
    const b = gen('helicopter-cabin', 10, sr, { rate, whine: 0 }, 2)
    const { e, frameSec } = envelope(mono(b), sr, 4, 'low')
    const { period } = envPeriod(e, frameSec, 0.6 / rate, 1.6 / rate)
    assert.ok(Math.abs(1 / period - rate) / rate < 0.08, 'rate ' + rate + ' measured ' + (1 / period).toFixed(2))
  }
})

test('heartbeat: beats at the set rate, and speeding up really speeds up', () => {
  const sr = 8000
  for (const bpm of [60, 110]) {
    const b = gen('heartbeat', 16, sr, { rate: bpm, pattern: 'steady' }, 3)
    const { e, frameSec } = envelope(mono(b), sr, 10, 'low')
    const { period } = envPeriod(e, frameSec, (0.7 * 60) / bpm, (1.35 * 60) / bpm)
    const got = 60 / period
    assert.ok(Math.abs(got - bpm) / bpm < 0.08, bpm + ' bpm measured ' + got.toFixed(1))
  }
  // speeding up: more beats in the second half than the first
  const b = gen('heartbeat', 20, sr, { rate: 60, pattern: 'faster' }, 3)
  const { e, frameSec } = envelope(mono(b), sr, 10, 'low')
  const half = Math.floor(e.length / 2)
  const p1 = envPeriod(e.subarray(0, half), frameSec, 0.45, 1.3).period
  const p2 = envPeriod(e.subarray(half), frameSec, 0.3, 1.3).period
  assert.ok(p2 < p1 * 0.9, 'period first half ' + p1.toFixed(2) + ' s, second half ' + p2.toFixed(2) + ' s')
})

test('clock: each clock ticks at its own rate', () => {
  const sr = 16000
  const rates = { watch: 5, mantel: 2.5, wall: 2, tall: 1 }
  for (const [clock, rate] of Object.entries(rates)) {
    const b = gen('clock-tick', 8, sr, { clock, size: 'close' }, 4)
    const { e, frameSec } = envelope(mono(b), sr, 2, 'high')
    const { period } = envPeriod(e, frameSec, 0.75 / rate, 1.3 / rate)
    assert.ok(Math.abs(period * rate - 1) < 0.08, clock + ' tick period ' + period.toFixed(3) + ' s, expected ' + (1 / rate).toFixed(3))
  }
})

test('phone line: dial tone is 350 + 440 Hz inside the telephone band; busy goes on and off once a second', () => {
  const sr = 16000
  const b = gen('phone-line', 4, sr, { tone: 'dial' }, 1)
  const m = mono(b)
  const t350 = bandEnergyDb(m, sr, 335, 365)
  const t440 = bandEnergyDb(m, sr, 425, 455)
  const gap = bandEnergyDb(m, sr, 370, 420)
  assert.ok(t350 > gap + 20 && t440 > gap + 20, 'tones ' + t350.toFixed(1) + ' / ' + t440.toFixed(1) + ' vs between ' + gap.toFixed(1))
  const above = bandEnergyDb(m, sr, 4500, 7900)
  assert.ok(above < t440 - 40, 'nothing above the 3.4 kHz telephone band (' + above.toFixed(1) + ' dB)')
  const busy = gen('phone-line', 6, sr, { tone: 'busy' }, 1)
  const { e, frameSec } = envelope(mono(busy), sr, 10)
  const { period, strength } = envPeriod(e, frameSec, 0.7, 1.4)
  assert.ok(Math.abs(period - 1) < 0.06 && strength > 0.5, 'busy cadence ' + period.toFixed(2) + ' s, strength ' + strength.toFixed(2))
})

test('submarine: sonar pings put energy at the ping pitch', () => {
  const sr = 16000
  const on = mono(gen('submarine', 14, sr, { pings: 100 }, 6))
  const off = mono(gen('submarine', 14, sr, { pings: 0 }, 6))
  const dOn = bandEnergyDb(on, sr, 2300, 3500) - rmsDb(on)
  const dOff = bandEnergyDb(off, sr, 2300, 3500) - rmsDb(off)
  assert.ok(dOn > dOff + 6, 'ping band ' + dOn.toFixed(1) + ' vs ' + dOff.toFixed(1))
})

test('airplane: cabin chimes ring out over the roar between 0.9 and 1.3 kHz', () => {
  const sr = 16000
  // the loudest half second in the chime band, against the median half second
  const lift = (m) => {
    const w = sr / 2
    const vals = []
    for (let s = 0; s + w <= m.length; s += w) vals.push(bandEnergyDb(m.subarray(s, s + w), sr, 900, 1300))
    const sorted = [...vals].sort((a, b) => a - b)
    return Math.max(...vals) - sorted[Math.floor(sorted.length / 2)]
  }
  const on = lift(mono(gen('airplane-cabin', 20, sr, { chimes: 100 }, 8)))
  const off = lift(mono(gen('airplane-cabin', 20, sr, { chimes: 0 }, 8)))
  assert.ok(on > 8 && on > off + 6, 'chime lift ' + on.toFixed(1) + ' dB with chimes, ' + off.toFixed(1) + ' dB without')
})

test('music box: the tune lives on the A minor scale', () => {
  const sr = 16000
  const m = mono(gen('music-box-broken', 16, sr, { broken: 0 }, 2))
  const note = (midi) => 880 * Math.pow(2, (midi - 69) / 12)
  let inScale = 0
  let off = 0
  // A minor with the raised seventh: A B C D E F G G#; off scale: A# C# D# F#
  for (const pc of [0, 2, 3, 5, 7, 8, 11]) {
    const f = note(69 + pc)
    inScale = Math.max(inScale, bandEnergyDb(m, sr, f * 0.985, f * 1.015))
  }
  let offMax = -200
  for (const pc of [1, 4, 6, 9]) {
    const f = note(69 + pc)
    offMax = Math.max(offMax, bandEnergyDb(m, sr, f * 0.985, f * 1.015))
  }
  off = offMax
  assert.ok(inScale > off + 15, 'scale tones ' + inScale.toFixed(1) + ' dB, off-scale ' + off.toFixed(1) + ' dB')
})

test('rocket: the launch builds from quiet and recedes; the steady roar holds', () => {
  const sr = 8000
  const b = mono(gen('rocket-launch', 20, sr, { shape: 'launch' }, 3))
  const seg = (a, z) => rmsDb(b.subarray(Math.round(a * sr), Math.round(z * sr)))
  assert.ok(seg(7, 10) > seg(0, 0.8) + 15, 'full thrust ' + seg(7, 10).toFixed(1) + ' vs before ignition ' + seg(0, 0.8).toFixed(1))
  assert.ok(seg(7, 10) > seg(18, 20) + 4, 'it climbs away: ' + seg(18, 20).toFixed(1))
  const st = mono(gen('rocket-launch', 20, sr, { shape: 'steady' }, 3))
  const s1 = rmsDb(st.subarray(4 * sr, 8 * sr))
  const s2 = rmsDb(st.subarray(15 * sr, 19 * sr))
  assert.ok(Math.abs(s1 - s2) < 4, 'steady roar ' + s1.toFixed(1) + ' / ' + s2.toFixed(1))
})

test('distance and walls darken the sound', () => {
  const sr = 24000
  const near = spectralCentroid(mono(gen('rocket-launch', 10, sr, { distance: 'near', shape: 'steady' }, 2)), sr)
  const far = spectralCentroid(mono(gen('rocket-launch', 10, sr, { distance: 'far', shape: 'steady' }, 2)), sr)
  assert.ok(far < near * 0.6, 'rocket centroid near ' + near.toFixed(0) + ', far ' + far.toFixed(0))
  const close = spectralCentroid(mono(gen('tv-static', 6, sr, { place: 'close' }, 2)), sr)
  const next = spectralCentroid(mono(gen('tv-static', 6, sr, { place: 'next' }, 2)), sr)
  assert.ok(next < close * 0.5, 'tv centroid close ' + close.toFixed(0) + ', next room ' + next.toFixed(0))
  const engine = spectralCentroid(mono(gen('boat-engine', 8, sr, { boat: 'outboard', seat: 'engine', waves: 0 }, 2)), sr)
  const bow = spectralCentroid(mono(gen('boat-engine', 8, sr, { boat: 'outboard', seat: 'bow', waves: 0 }, 2)), sr)
  assert.ok(engine !== bow, 'seat changes the boat sound')
})

test('radio: medium wave is narrow, FM hiss is wide', () => {
  const sr = 32000
  const am = mono(gen('radio-static', 6, sr, { band: 'am' }, 2))
  const fm = mono(gen('radio-static', 6, sr, { band: 'fm' }, 2))
  const amHi = bandEnergyDb(am, sr, 7000, 14000) - rmsDb(am)
  const fmHi = bandEnergyDb(fm, sr, 7000, 14000) - rmsDb(fm)
  assert.ok(amHi < fmHi - 15, 'above 7 kHz: AM ' + amHi.toFixed(1) + ', FM ' + fmHi.toFixed(1))
})

test('car: an open window lets in wind and the buffeting; seams add axle thumps', () => {
  const sr = 24000
  const closed = mono(gen('car-highway', 8, sr, { windows: 'closed', traffic: 0 }, 2))
  const open = mono(gen('car-highway', 8, sr, { windows: 'open', traffic: 0 }, 2))
  const hc = bandEnergyDb(closed, sr, 2000, 8000) - rmsDb(closed)
  const ho = bandEnergyDb(open, sr, 2000, 8000) - rmsDb(open)
  assert.ok(ho > hc + 6, 'wind band closed ' + hc.toFixed(1) + ', open ' + ho.toFixed(1))
  const smooth = mono(gen('car-highway', 10, sr, { surface: 'smooth', traffic: 0 }, 3))
  const seams = mono(gen('car-highway', 10, sr, { surface: 'seams', traffic: 0 }, 3))
  // thumps: low-band envelope peaks 9 dB over the median
  const thumps = (m) => {
    const { e } = envelope(m, sr, 10, 'low')
    const s = Array.from(e).sort((a, c) => a - c)
    const med = s[Math.floor(s.length / 2)]
    let c = 0
    for (let i = 1; i < e.length - 1; i++) if (e[i] > 8 * med && e[i] >= e[i - 1] && e[i] >= e[i + 1]) c++
    return c
  }
  const ts = thumps(seams)
  const tm = thumps(smooth)
  assert.ok(ts >= 15 && ts > 3 * Math.max(1, tm), 'thumps on seams ' + ts + ', on smooth road ' + tm)
})

test('dungeon: dripping water lives in the drip band; spooky beds stay quiet when emptied', () => {
  const sr = 16000
  const wet = mono(gen('dungeon', 10, sr, { drips: 100, chains: 0, groans: 0, intensity: 0 }, 2))
  const dry = mono(gen('dungeon', 10, sr, { drips: 0, chains: 0, groans: 0, intensity: 0 }, 2))
  assert.ok(bandEnergyDb(wet, sr, 800, 3000) > bandEnergyDb(dry, sr, 800, 3000) + 15, 'drips add the drip band')
  // emptied scenes are much quieter than the default scene, not boosted room tone
  for (const [id, empty] of [
    ['dungeon', { drips: 0, chains: 0, groans: 0, intensity: 0 }],
    ['haunted-house', { intensity: 0, wind: 0, moans: 0 }],
    ['graveyard', { intensity: 0, wind: 0, bell: 0, creatures: 0 }],
    ['spaceship-bridge', { hum: 0, beeps: 0 }],
  ]) {
    const full = gen(id, 8, sr, {}, 2)
    const none = gen(id, 8, sr, empty, 2)
    assert.ok(lufs(none) < lufs(full) - 6, id + ' emptied ' + lufs(none).toFixed(1) + ' LUFS vs default ' + lufs(full).toFixed(1))
    assert.ok(rmsDb(none) < rmsDb(full), id + ' emptied is quieter by plain level too')
  }
})

test('bus: the city route stops (doors and air hiss) and the highway does not', () => {
  const sr = 16000
  const city = mono(gen('bus', 40, sr, { route: 'city' }, 2))
  const hw = mono(gen('bus', 40, sr, { route: 'highway' }, 2))
  // level spread over 2 s blocks: stop-and-go swings far more than cruising
  const spread = (m) => {
    const vals = []
    for (let s = 0; s + 2 * sr <= m.length; s += 2 * sr) vals.push(rmsDb(m.subarray(s, s + 2 * sr)))
    return Math.max(...vals) - Math.min(...vals)
  }
  assert.ok(spread(city) > spread(hw) + 2, 'city spread ' + spread(city).toFixed(1) + ' dB, highway ' + spread(hw).toFixed(1) + ' dB')
})

// ------------------------------------------------------------------ the eerie whine

/** Pitch track of the whine as MIDI note numbers per 10 ms frame (NaN where unvoiced). */
function whineTrack(p, seed = 3, secs = 16) {
  const sr = 16000
  const m = mono(gen('eerie-whine', secs, sr, { size: 'close', echo: 0, hum: 0, company: 'alone', ...p }, seed))
  const { f0 } = f0Track(m, sr, { minHz: 100, maxHz: 2000, hopMs: 10, voicing: 0.7, gateDb: 30 })
  return Array.from(f0, (f) => (f > 0 ? 12 * Math.log2(f / 440) + 69 : NaN))
}

/**
 * From a pitch track: wobble (RMS cents left after a 170 ms moving average,
 * which spans about one vibrato cycle), its rate (zero crossings), the share
 * of sounding time spent sliding faster than 4 semitones a second, the voiced
 * share and the median note.
 */
function whineStats(tr) {
  const W = 8
  const sm = new Float64Array(tr.length).fill(NaN)
  let e = 0
  let c = 0
  let cross = 0
  let pairs = 0
  let prev = NaN
  for (let i = W; i < tr.length - W; i++) {
    let s = 0
    let ok = true
    for (let j = -W; j <= W; j++) {
      const v = tr[i + j]
      if (!(v === v)) {
        ok = false
        break
      }
      s += v
    }
    if (!ok) {
      prev = NaN
      continue
    }
    sm[i] = s / (2 * W + 1)
    const d = tr[i] - sm[i]
    e += d * d
    c++
    if (prev === prev) {
      pairs++
      if ((d > 0) !== (prev > 0)) cross++
    }
    prev = d
  }
  let slide = 0
  let both = 0
  for (let i = 5; i < tr.length - 5; i++) {
    if (sm[i - 5] === sm[i - 5] && sm[i + 5] === sm[i + 5]) {
      both++
      if (Math.abs(sm[i + 5] - sm[i - 5]) / 0.1 > 4) slide++
    }
  }
  const v = tr.filter((x) => x === x).sort((a, b) => a - b)
  return {
    wobble: 100 * Math.sqrt(e / Math.max(1, c)),
    rate: pairs ? cross / 2 / (pairs * 0.01) : 0,
    slide: slide / Math.max(1, both),
    voiced: v.length / tr.length,
    median: v.length ? v[v.length >> 1] : 0,
  }
}

test('eerie whine: a pitched tone that sounds most of the time and sits in the register asked for', () => {
  for (const seed of [3, 7]) {
    const d = whineStats(whineTrack({}, seed))
    assert.ok(d.voiced > 0.6, 'a clear pitched tone ' + (100 * d.voiced).toFixed(0) + '% of the time')
    const lo = whineStats(whineTrack({ pitch: 'low' }, seed)).median
    const hi = whineStats(whineTrack({ pitch: 'high' }, seed)).median
    assert.ok(hi - lo > 10, 'high register ' + hi.toFixed(1) + ', low ' + lo.toFixed(1) + ' (MIDI)')
  }
})

test('eerie whine: the swoops and the siren glide; the tune mostly holds its notes', () => {
  const ghostS = whineStats(whineTrack({ style: 'ghost' }, 3)).slide
  const sirenS = whineStats(whineTrack({ style: 'siren' }, 3)).slide
  const tuneS = whineStats(whineTrack({ style: 'tune' }, 3)).slide
  assert.ok(ghostS > 0.25 && sirenS > 0.25, 'sliding share: swoops ' + ghostS.toFixed(2) + ', siren ' + sirenS.toFixed(2))
  assert.ok(ghostS > 2 * tuneS, 'swoops slide ' + ghostS.toFixed(2) + ', tune ' + tuneS.toFixed(2))
})

test('eerie whine: wobble sets the vibrato, at a trembling hand rate', () => {
  for (const [style, ratio, lo, hi] of [['tune', 2.5, 4.8, 7.5], ['tremble', 4, 6.3, 9]]) {
    const still = whineStats(whineTrack({ style, wobble: 0 }, 3))
    const shaky = whineStats(whineTrack({ style, wobble: 100 }, 3))
    assert.ok(shaky.wobble > ratio * still.wobble && shaky.wobble > 30, style + ' wobble ' + shaky.wobble.toFixed(1) + ' cents vs still ' + still.wobble.toFixed(1))
    assert.ok(shaky.rate > lo && shaky.rate < hi, style + ' vibrato rate ' + shaky.rate.toFixed(2) + ' Hz')
  }
})

test('eerie whine: two players answer from either side; hum 100 brings in the 120 Hz amplifier hum', () => {
  const sr = 16000
  const balance = (company) => {
    const b = gen('eerie-whine', 20, sr, { size: 'close', echo: 0, hum: 0, company }, 5)
    const w = sr / 2
    const out = []
    for (let s0 = 0; s0 + w <= b.ch[0].length; s0 += w) {
      let el = 0
      let er = 0
      for (let i = s0; i < s0 + w; i++) {
        el += b.ch[0][i] * b.ch[0][i]
        er += b.ch[1][i] * b.ch[1][i]
      }
      if (el + er > 1e-6 * w) out.push(10 * Math.log10((el + 1e-12) / (er + 1e-12)))
    }
    return out
  }
  const one = balance('alone')
  const two = balance('pair')
  assert.ok(Math.max(...one.map(Math.abs)) < 3.5, 'one player stays near the middle')
  assert.ok(Math.max(...two) > 4 && Math.min(...two) < -4, 'two players: left ' + Math.max(...two).toFixed(1) + ' dB, right ' + Math.min(...two).toFixed(1) + ' dB')
  const quiet = mono(gen('eerie-whine', 8, sr, { size: 'close', echo: 0, hum: 0 }, 2))
  const humming = mono(gen('eerie-whine', 8, sr, { size: 'close', echo: 0, hum: 100 }, 2))
  const h0 = bandEnergyDb(quiet, sr, 110, 130) - rmsDb(quiet)
  const h1 = bandEnergyDb(humming, sr, 110, 130) - rmsDb(humming)
  assert.ok(h1 > h0 + 25, '120 Hz band ' + h1.toFixed(1) + ' dB with hum, ' + h0.toFixed(1) + ' dB without')
})
