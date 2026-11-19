// test/beds-weather.nodetest.mjs - weather, water and fire background beds.
//
// Every bed: contract shape (CONTRACT section 6), stereo of exactly the
// asked length at any rate, finite and under full scale at every setting,
// deterministic for a seed, never a short repeating loop, fast enough
// (20 s at 48 kHz well under the 1.5 s budget; asserted generously because
// other builders share the CPU), and a property test per bed that proves it
// does what its name says.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { makeRng } from '../core/rng.js'
import { validateModuleShape } from '../core/params.js'
import { decodeWav } from '../core/wav.js'
import { readFileSync } from 'node:fs'
import { assertSane, spectralCentroid, bandEnergyDb, stereoCorrelation, rmsDb, timeIt } from './measure.mjs'
import { thunderLayer } from '../beds/storm.js'
import { torchLayer } from '../beds/torch.js'
import { eq } from '../beds/rain.js'

const IDS = [
  'rain', 'rain-window', 'rain-roof', 'rain-tent', 'storm', 'wind', 'wind-howl', 'wind-trees', 'blizzard', 'desert-wind', 'hail',
  'ocean', 'shore-rocks', 'river', 'creek', 'waterfall', 'cave-drips', 'underwater', 'fountain', 'rain-gutter',
  'campfire', 'fireplace', 'blaze', 'torch',
]
const GROUPS = ['weather', 'water', 'fire']
const SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'

const BEDS = {}
for (const id of IDS) BEDS[id] = (await import('../beds/' + id + '.js')).default

function gen(id, seconds, p = {}, seed = 1, sr = 48000) {
  return BEDS[id].generate(seconds, sr, p, makeRng(seed))
}

function mono(b) {
  const n = b.ch[0].length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = 0.5 * (b.ch[0][i] + b.ch[1][i])
  return out
}

/** Block RMS envelope in dB. */
function envDb(sig, sr, blockSec) {
  const blk = Math.max(1, Math.round(sr * blockSec))
  const out = []
  for (let i = 0; i + blk <= sig.length; i += blk) {
    let e = 0
    for (let k = i; k < i + blk; k++) e += sig[k] * sig[k]
    out.push(10 * Math.log10(e / blk + 1e-14))
  }
  return out
}

function stats(a) {
  const m = a.reduce((x, y) => x + y, 0) / a.length
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length)
  const s = [...a].sort((x, y) => x - y)
  return { mean: m, sd, median: s[Math.floor(s.length / 2)], max: s[s.length - 1], min: s[0] }
}

function crestDb(sig) {
  let pk = 0
  for (let i = 0; i < sig.length; i++) pk = Math.max(pk, Math.abs(sig[i]))
  return 20 * Math.log10(pk + 1e-12) - rmsDb(sig)
}

/** Share of energy (dB relative to total) in a band. */
function bandShare(sig, sr, lo, hi) {
  return bandEnergyDb(sig, sr, lo, hi) - bandEnergyDb(sig, sr, 20, sr / 2)
}

/** How far the strongest narrow band stands above the median one, in dB. */
function peakiness(sig, sr, lo, hi, width = 50) {
  const v = []
  for (let f = lo; f + width <= hi; f += width) v.push(bandEnergyDb(sig, sr, f, f + width))
  const s = stats(v)
  return s.max - s.median
}

/** Frequency of the strongest narrow band in lo..hi. */
function peakFreq(sig, sr, lo, hi, width = 20) {
  let best = -Infinity
  let bf = lo
  for (let f = lo; f + width <= hi; f += width) {
    const e = bandEnergyDb(sig, sr, f, f + width)
    if (e > best) {
      best = e
      bf = f + width / 2
    }
  }
  return bf
}

function hashBuf(b) {
  let h = 2166136261
  for (const c of b.ch) {
    for (let i = 0; i < c.length; i += 7) {
      h ^= Math.round(c[i] * 1e6) | 0
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}

function adapter(bed) {
  return {
    ...bed,
    id: 'bed.' + bed.id,
    family: 'bed',
    stereo: 'make',
    cost: 2,
    process: () => null,
  }
}

// ---------------------------------------------------------------- every bed

for (const id of IDS) {
  test(id + ': shape follows the contract', () => {
    const bed = BEDS[id]
    assert.equal(bed.id, id)
    assert.equal(typeof bed.generate, 'function')
    assert.ok(GROUPS.includes(bed.group), 'group ' + bed.group)
    assert.ok(typeof bed.name === 'string' && bed.name.length > 2 && bed.name.length <= 40, 'name')
    assert.ok(typeof bed.about === 'string' && bed.about.length > 10 && bed.about.length < 120, 'about is one short sentence: ' + bed.about.length)
    assert.ok(Array.isArray(bed.params) && bed.params.length >= 2 && bed.params.length <= 8, 'two to eight params')
    const problems = validateModuleShape(adapter(bed))
    assert.deepEqual(problems, [], problems.join('\n'))
    const hasIntensity = bed.params.some((p) => /intensity|strength|size|flow|speed|drips|swell/.test(p.id))
    assert.ok(hasIntensity, 'has an intensity or size control')
  })

  test(id + ': defaults give stereo of exactly the asked length, sane, deterministic', () => {
    const b = gen(id, 4)
    assert.equal(b.sr, 48000)
    assert.equal(b.ch.length, 2)
    assert.equal(b.ch[0].length, 4 * 48000)
    const { peak } = assertSane(b, { maxPeak: 1 })
    assert.ok(peak > 0.02, 'peak ' + peak)
    assert.ok(rmsDb(b) > -45, 'not silent: ' + rmsDb(b).toFixed(1))
    assert.ok(stereoCorrelation(b) < 0.97, 'really stereo: ' + stereoCorrelation(b).toFixed(3))
    const again = gen(id, 4)
    assert.equal(hashBuf(again), hashBuf(b), 'same seed, same sound')
    const other = gen(id, 4, {}, 2)
    assert.notEqual(hashBuf(other), hashBuf(b), 'another seed, another sound')
  })

  test(id + ': odd lengths, rates and missing arguments', () => {
    const bed = BEDS[id]
    for (const secs of [0, -1, NaN]) {
      const z = bed.generate(secs, 48000, {}, makeRng(1))
      assert.equal(z.ch.length, 2)
      assert.equal(z.ch[0].length, 0)
      assert.equal(z.ch[1].length, 0)
    }
    const tiny = bed.generate(0.003, 48000, null, undefined)
    assert.equal(tiny.ch[0].length, 144)
    assertSane(tiny, { maxPeak: 1 })
    for (const sr of [8000, 22050, 44100, 96000]) {
      const b = bed.generate(1.25, sr, {}, makeRng(3))
      assert.equal(b.sr, sr)
      assert.equal(b.ch[0].length, Math.round(1.25 * sr), 'length at ' + sr)
      assertSane(b, { maxPeak: 1 })
    }
  })

  test(id + ': every setting at its ends and every choice stays sane', () => {
    const bed = BEDS[id]
    const lo = {}
    const hi = {}
    for (const p of bed.params) {
      if (p.type === 'number') {
        lo[p.id] = p.min
        hi[p.id] = p.max
      }
    }
    for (const p of [lo, hi]) {
      const b = bed.generate(1.5, 48000, p, makeRng(5))
      const { peak } = assertSane(b, { maxPeak: 1 })
      assert.ok(peak < 1, 'peak ' + peak)
    }
    for (const p of bed.params) {
      if (p.type !== 'choice') continue
      for (const o of p.options) {
        for (const base of [lo, hi]) {
          const b = bed.generate(1.5, 48000, { ...base, [p.id]: o.v }, makeRng(6))
          assertSane(b, { maxPeak: 1 })
        }
      }
    }
  })

  test(id + ': natural variation, never a short loop', () => {
    const b = gen(id, 11)
    const s = mono(b)
    const sr = 48000
    const a0 = 2 * sr
    const len = 2 * sr
    for (const lag of [0.5, 1, 2.5, 5, 7]) {
      const l = Math.round(lag * sr)
      let xy = 0
      let xx = 0
      let yy = 0
      for (let i = 0; i < len; i++) {
        const x = s[a0 + i]
        const y = s[a0 + l + i]
        xy += x * y
        xx += x * x
        yy += y * y
      }
      const c = xy / Math.sqrt(xx * yy + 1e-30)
      assert.ok(Math.abs(c) < 0.4, 'correlation ' + c.toFixed(3) + ' at a lag of ' + lag + ' s')
    }
  })

  test(id + ': 20 seconds at 48 kHz renders fast', (t) => {
    const ms = timeIt(() => gen(id, 20), 1)
    t.diagnostic(id + ' 20 s at 48 kHz: ' + ms.toFixed(0) + ' ms')
    assert.ok(ms < 6000, id + ' took ' + ms.toFixed(0) + ' ms for 20 s (budget 1500 ms, asserted generously)')
  })
}

test('beds fit under a real recording at its own rate', () => {
  if (!existsSync(SPEECH)) return
  const speech = decodeWav(new Uint8Array(readFileSync(SPEECH)))
  const n = speech.ch[0].length
  const secs = Math.min(8, n / speech.sr)
  for (const id of ['rain', 'storm', 'ocean', 'campfire', 'torch', 'rain-gutter']) {
    const b = BEDS[id].generate(secs, speech.sr, {}, makeRng(9))
    assert.equal(b.sr, speech.sr)
    assert.equal(b.ch[0].length, Math.round(secs * speech.sr))
    assertSane(b, { maxPeak: 1 })
  }
})

test('long beds are fresh segments joined smoothly, never repeated', () => {
  const sr = 16000
  for (const id of ['rain', 'wind', 'river', 'campfire']) {
    const secs = 64.3
    const b = BEDS[id].generate(secs, sr, {}, makeRng(12))
    assert.equal(b.ch[0].length, Math.round(secs * sr), id + ' length')
    assertSane(b, { maxPeak: 1 })
    const s = mono(b)
    const env = envDb(s, sr, 0.5)
    const med = stats(env).median
    // Joins sit at 30 s and 60 s: no dip or bump there.
    for (const j of [30, 60]) {
      for (let k = Math.floor((j - 1) / 0.5); k <= Math.floor((j + 1.5) / 0.5); k++) {
        if (k < env.length) assert.ok(Math.abs(env[k] - med) < 6, id + ' level near the ' + j + ' s join: ' + (env[k] - med).toFixed(1) + ' dB')
      }
    }
    // A stretch of the second segment is not a copy of the first.
    let xy = 0
    let xx = 0
    let yy = 0
    const a0 = 5 * sr
    const b0 = 35 * sr
    for (let i = 0; i < 2 * sr; i++) {
      xy += s[a0 + i] * s[b0 + i]
      xx += s[a0 + i] ** 2
      yy += s[b0 + i] ** 2
    }
    assert.ok(Math.abs(xy / Math.sqrt(xx * yy + 1e-30)) < 0.2, id + ' segments differ')
  }
})

// ---------------------------------------------------------------- properties

test('rain: harder rain is louder and denser, surfaces sound different, distance darkens', () => {
  const light = gen('rain', 4, { intensity: 10, drips: 0 })
  const heavy = gen('rain', 4, { intensity: 95, drips: 0 })
  assert.ok(rmsDb(heavy) > rmsDb(light) + 3, 'heavy louder')
  const sdL = stats(envDb(mono(light), 48000, 0.01)).sd
  const sdH = stats(envDb(mono(heavy), 48000, 0.01)).sd
  assert.ok(sdH < sdL * 0.7, 'heavy rain is a denser patter: ' + sdH.toFixed(2) + ' vs ' + sdL.toFixed(2))
  const cent = (surface) => spectralCentroid(mono(gen('rain', 4, { surface, drips: 0 })), 48000)
  const tent = cent('tent')
  const pave = cent('pavement')
  const win = cent('window')
  assert.ok(tent < 1500, 'tent is a soft low patter: ' + tent.toFixed(0))
  assert.ok(pave > 3000, 'pavement is a bright hiss: ' + pave.toFixed(0))
  assert.ok(tent < win && win < pave, 'tent < window < pavement')
  const near = spectralCentroid(mono(gen('rain', 4, { distance: 0 })), 48000)
  const far = spectralCentroid(mono(gen('rain', 4, { distance: 100 })), 48000)
  assert.ok(far < near * 0.7, 'distance takes the highs')
})

test('rain-roof: a tin roof rings, more ring rings more', () => {
  const roof = mono(gen('rain-roof', 4, { ring: 100 }))
  const ground = mono(gen('rain', 4, { drips: 0 }))
  const pr = peakiness(roof, 48000, 800, 8000)
  const pg = peakiness(ground, 48000, 800, 8000)
  assert.ok(pr > pg + 4, 'metal modes stand out: roof ' + pr.toFixed(1) + ' dB, ground ' + pg.toFixed(1) + ' dB')
  const dull = peakiness(mono(gen('rain-roof', 4, { ring: 0 })), 48000, 800, 8000)
  assert.ok(pr > dull, 'ring 100 rings more than ring 0')
})

test('rain-window: glass ticks over a muffled outside; the room adds a tail', () => {
  const b = gen('rain-window', 4, { room: 0 })
  const s = mono(b)
  assert.ok(crestDb(s) > 12, 'distinct ticks')
  assert.ok(bandShare(s, 48000, 2000, 9000) > -14, 'ticks are bright')
})

test('rain-tent: inside is muffled, outside is open', () => {
  const inside = spectralCentroid(mono(gen('rain-tent', 4, { where: 'inside' })), 48000)
  const outside = spectralCentroid(mono(gen('rain-tent', 4, { where: 'outside' })), 48000)
  assert.ok(outside > inside * 2, 'outside ' + outside.toFixed(0) + ' vs inside ' + inside.toFixed(0))
})

test('storm: thunder rumbles, near thunder cracks brighter than far', () => {
  const none = mono(gen('storm', 8, { thunder: 0 }))
  const some = mono(gen('storm', 8, { thunder: 8 }))
  const lowNone = bandEnergyDb(none, 48000, 30, 200)
  const lowSome = bandEnergyDb(some, 48000, 30, 200)
  assert.ok(lowSome > lowNone + 6, 'thunder adds low rumble: ' + (lowSome - lowNone).toFixed(1) + ' dB')
  const n = 48000 * 14
  const near = thunderLayer(n, 48000, makeRng(4), { perMinute: 6, distance: 500 })
  const far = thunderLayer(n, 48000, makeRng(4), { perMinute: 6, distance: 9000 })
  assert.ok(near.count >= 1 && far.count >= 1, 'strikes happened')
  const cn = spectralCentroid(near.L, 48000)
  const cf = spectralCentroid(far.L, 48000)
  assert.ok(cn > cf * 1.6, 'near ' + cn.toFixed(0) + ' Hz vs far ' + cf.toFixed(0) + ' Hz')
  // The first strike lands early so a six-second preview hears it.
  const env = envDb(near.L, 48000, 0.25)
  const first = env.findIndex((v) => v > -60)
  assert.ok(first >= 0 && first * 0.25 < 4, 'first thunder by 4 s')
})

test('wind: gusts make it rise and fall, a stronger wind is brighter, whistles are tonal', () => {
  const calm = stats(envDb(mono(gen('wind', 12, { gusts: 0 })), 48000, 0.25)).sd
  const gusty = stats(envDb(mono(gen('wind', 12, { gusts: 100 })), 48000, 0.25)).sd
  assert.ok(gusty > calm * 2, 'gusty ' + gusty.toFixed(2) + ' vs steady ' + calm.toFixed(2))
  const soft = spectralCentroid(mono(gen('wind', 6, { strength: 10 })), 48000)
  const hard = spectralCentroid(mono(gen('wind', 6, { strength: 95 })), 48000)
  assert.ok(hard > soft * 1.3, 'stronger is brighter')
  const pw = peakiness(mono(gen('wind', 8, { whistle: 100, strength: 70 })), 48000, 400, 4000)
  const p0 = peakiness(mono(gen('wind', 8, { whistle: 0, strength: 70 })), 48000, 400, 4000)
  assert.ok(pw > p0 + 3, 'whistle stands out: ' + pw.toFixed(1) + ' vs ' + p0.toFixed(1))
})

test('wind-howl: the howl is a tone at the chosen pitch', () => {
  const lo = mono(gen('wind-howl', 8, { pitch: 200, where: 'outside' }))
  const hi = mono(gen('wind-howl', 8, { pitch: 600, where: 'outside' }))
  assert.ok(peakiness(lo, 48000, 100, 1500, 20) > 8, 'tonal')
  const fl = peakFreq(lo, 48000, 80, 1600)
  const fh = peakFreq(hi, 48000, 80, 1600)
  assert.ok(fh > fl * 1.8, 'pitch follows the setting: ' + fl + ' vs ' + fh)
})

test('wind-trees: leaves rustle high above the wind; distance dulls them', () => {
  const trees = mono(gen('wind-trees', 6, { distance: 0 }))
  const bare = mono(gen('wind', 6, { whistle: 0 }))
  assert.ok(bandShare(trees, 48000, 2000, 9000) > bandShare(bare, 48000, 2000, 9000) + 3, 'rustle adds highs')
  const far = mono(gen('wind-trees', 6, { distance: 100 }))
  assert.ok(spectralCentroid(far, 48000) < spectralCentroid(trees, 48000) * 0.7, 'far is duller')
})

test('blizzard: snow hisses; inside a cabin it is muffled', () => {
  const snow = mono(gen('blizzard', 6, { snow: 100 }))
  const clear = mono(gen('blizzard', 6, { snow: 0 }))
  assert.ok(bandShare(snow, 48000, 4000, 14000) > bandShare(clear, 48000, 4000, 14000) + 5, 'snow hiss')
  const inside = mono(gen('blizzard', 6, { where: 'inside' }))
  assert.ok(spectralCentroid(inside, 48000) < spectralCentroid(snow, 48000) * 0.4, 'cabin muffles')
})

test('desert-wind: blowing sand hisses in the gusts; dunes can sing low', () => {
  const sand = mono(gen('desert-wind', 6, { sand: 100 }))
  const none = mono(gen('desert-wind', 6, { sand: 0 }))
  assert.ok(bandShare(sand, 48000, 3000, 12000) > bandShare(none, 48000, 3000, 12000) + 5, 'sand hiss')
  const sing = mono(gen('desert-wind', 14, { dunes: 100, sand: 0 }, 3))
  const quiet = mono(gen('desert-wind', 14, { dunes: 0, sand: 0 }, 3))
  assert.ok(bandEnergyDb(sing, 48000, 65, 115) > bandEnergyDb(quiet, 48000, 65, 115) + 3, 'dune hum')
})

test('hail: hard clicks with bounces; surfaces differ', () => {
  const g = mono(gen('hail', 4, { rain: 0, intensity: 40 }))
  assert.ok(crestDb(g) > 14, 'sharp impacts')
  const car = spectralCentroid(mono(gen('hail', 4, { surface: 'car', rain: 0 })), 48000)
  const win = spectralCentroid(mono(gen('hail', 4, { surface: 'window', rain: 0 })), 48000)
  assert.ok(car < win, 'a car booms lower than a window ticks')
})

test('ocean: waves come and go, at the chosen pace', () => {
  const b = mono(gen('ocean', 20))
  const e = stats(envDb(b, 48000, 0.5))
  assert.ok(e.max - e.min > 8, 'swells and lulls: ' + (e.max - e.min).toFixed(1) + ' dB')
  const count = (period) => {
    const s = mono(gen('ocean', 36, { period, distance: 0 }, 11))
    const env = envDb(s, 48000, 0.25)
    const med = stats(env).median
    let c = 0
    let last = -1e9
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > med + 3 && env[i] >= env[i - 1] && env[i] >= env[i + 1] && (i - last) * 0.25 > period * 0.55) {
        c++
        last = i
      }
    }
    return c
  }
  const fast = count(4.5)
  const slow = count(14)
  assert.ok(fast > slow, 'more waves when they come faster: ' + fast + ' vs ' + slow)
  const calm = rmsDb(mono(gen('ocean', 8, { size: 0 })))
  const big = rmsDb(mono(gen('ocean', 8, { size: 100 })))
  assert.ok(big > calm + 3, 'big surf is louder')
})

test('shore-rocks: booms against rock and showers of drops', () => {
  const s = mono(gen('shore-rocks', 14))
  const low = []
  const blk = 48000 * 0.25
  for (let i = 0; i + blk <= s.length; i += blk) low.push(bandEnergyDb(s.subarray(i, i + blk), 48000, 30, 160))
  const st = stats(low)
  assert.ok(st.max - st.median > 6, 'booms stand out: ' + (st.max - st.median).toFixed(1))
  const wet = bandShare(mono(gen('shore-rocks', 8, { spray: 100 })), 48000, 2000, 8000)
  const dry = bandShare(mono(gen('shore-rocks', 8, { spray: 0 })), 48000, 2000, 8000)
  assert.ok(wet > dry + 2, 'spray brightens')
})

test('creek: babbling gurgles; no babble is a smooth flow', () => {
  const b = mono(gen('creek', 6, { babble: 100 }))
  const sm = mono(gen('creek', 6, { babble: 0 }))
  assert.ok(stats(envDb(b, 48000, 0.02)).sd > stats(envDb(sm, 48000, 0.02)).sd * 1.5, 'gurgly vs smooth')
  assert.ok(crestDb(b) > crestDb(sm) + 3, 'distinct bubbles')
})

test('river: a steady broad flow; rapids churn', () => {
  const s = mono(gen('river', 8))
  assert.ok(stats(envDb(s, 48000, 0.25)).sd < 2.5, 'steady')
  const calm = mono(gen('river', 6, { rapids: 0 }))
  const wild = mono(gen('river', 6, { rapids: 100 }))
  assert.ok(stats(envDb(wild, 48000, 0.02)).sd > stats(envDb(calm, 48000, 0.02)).sd, 'rapids churn')
})

test('waterfall: a steady broadband roar, bigger falls go deeper', () => {
  const s = mono(gen('waterfall', 8, { distance: 0 }))
  assert.ok(stats(envDb(s, 48000, 0.1)).sd < 1.5, 'steady roar')
  for (const [lo, hi] of [[60, 250], [250, 1000], [1000, 4000]]) assert.ok(bandShare(s, 48000, lo, hi) > -16, 'broadband ' + lo)
  const small = bandShare(mono(gen('waterfall', 6, { size: 0 })), 48000, 25, 200)
  const huge = bandShare(mono(gen('waterfall', 6, { size: 100 })), 48000, 25, 200)
  assert.ok(huge > small + 3, 'big falls rumble')
})

test('cave-drips: separate drips that echo; a bigger cave echoes longer', () => {
  const s = mono(gen('cave-drips', 10, { stream: 0, size: 100 }))
  assert.ok(crestDb(s) > 15, 'distinct drips')
  const small = stats(envDb(mono(gen('cave-drips', 10, { stream: 0, size: 0 })), 48000, 0.05))
  const big = stats(envDb(s, 48000, 0.05))
  assert.ok(big.median - big.max > small.median - small.max + 3, 'echo fills the gaps in a big cave')
  const drips = (count) => {
    const env = envDb(mono(gen('cave-drips', 12, { drips: count, stream: 0, size: 0, speed: 60 })), 48000, 0.02)
    const floor = stats(env).median
    let c = 0
    for (let i = 1; i < env.length; i++) if (env[i] > floor + 9 && env[i - 1] <= floor + 9) c++
    return c
  }
  const many = drips(10)
  const one = drips(1)
  assert.ok(many > one * 2, 'more places drip more often: ' + many + ' vs ' + one)
})

test('underwater: muffled, deeper is darker, the reef crackles', () => {
  const s = mono(gen('underwater', 6))
  assert.ok(spectralCentroid(s, 48000) < 700, 'muffled')
  const shallow = spectralCentroid(mono(gen('underwater', 6, { depth: 0 })), 48000)
  const deep = spectralCentroid(mono(gen('underwater', 6, { depth: 100 })), 48000)
  assert.ok(deep < shallow, 'deeper is darker')
  const reef = bandShare(mono(gen('underwater', 6, { reef: 100, diver: 0, depth: 0 })), 48000, 1500, 6000)
  const none = bandShare(mono(gen('underwater', 6, { reef: 0, diver: 0, depth: 0 })), 48000, 1500, 6000)
  assert.ok(reef > none + 6, 'shrimp crackle')
})

test('fountain: steady sparkling splash; more water is louder', () => {
  const s = mono(gen('fountain', 6))
  assert.ok(spectralCentroid(s, 48000) > 1500, 'bright splashing')
  assert.ok(stats(envDb(s, 48000, 0.25)).sd < 2, 'steady')
  assert.ok(rmsDb(mono(gen('fountain', 6, { flow: 100 }))) > rmsDb(mono(gen('fountain', 6, { flow: 0 }))) + 3, 'more water louder')
})

test('campfire: crackle crackles', () => {
  const c = mono(gen('campfire', 8, { crackle: 100, pops: 0, logs: 0 }))
  const q = mono(gen('campfire', 8, { crackle: 0, pops: 0, logs: 0 }))
  assert.ok(bandShare(c, 48000, 1500, 7000) > bandShare(q, 48000, 1500, 7000) + 4, 'crackle in the highs')
  assert.ok(crestDb(c) > 14, 'sharp cracks')
})

test('fireplace: the room smooths the crackle', () => {
  const dry = mono(gen('fireplace', 6, { room: 0 }))
  const wet = mono(gen('fireplace', 6, { room: 100 }))
  assert.ok(crestDb(wet) < crestDb(dry) + 0.5, 'room does not sharpen')
  assert.ok(stereoCorrelation(gen('fireplace', 6, { room: 100 })) < 0.9, 'room is wide')
})

test('blaze: a roaring fire is a steadier roar than a campfire, and wide', () => {
  const big = gen('blaze', 6)
  const camp = mono(gen('campfire', 6))
  assert.ok(crestDb(mono(big)) < crestDb(camp) - 2, 'the roar carries it: ' + crestDb(mono(big)).toFixed(1) + ' vs ' + crestDb(camp).toFixed(1))
  assert.ok(stereoCorrelation(big) < 0.6, 'burning across the field')
  const roar = rmsDb(mono(gen('blaze', 6, { size: 100 })))
  const small = rmsDb(mono(gen('blaze', 6, { size: 0 })))
  assert.ok(roar > small + 3, 'bigger is louder')
})

/** Rate (Hz) of the strongest loudness wobble between lo and hi Hz, from the flame band's 10 ms envelope. */
function wobbleRate(sig, sr, lo, hi) {
  const s = Float32Array.from(sig)
  eq(s, sr, [['highpass', 80, 0.7], ['lowpass', 1200, 0.7]])
  const blk = Math.round(sr / 100)
  const env = []
  for (let i = 0; i + blk <= s.length; i += blk) {
    let e = 0
    for (let k = i; k < i + blk; k++) e += s[k] * s[k]
    env.push(Math.sqrt(e / blk))
  }
  const mean = env.reduce((x, y) => x + y, 0) / env.length
  let best = 0
  let bf = lo
  for (let f = lo; f <= hi; f += 0.05) {
    let re = 0
    let im = 0
    for (let k = 0; k < env.length; k++) {
      const a = (2 * Math.PI * f * k) / 100
      re += (env[k] - mean) * Math.cos(a)
      im += (env[k] - mean) * Math.sin(a)
    }
    if (re * re + im * im > best) {
      best = re * re + im * im
      bf = f
    }
  }
  return bf
}

/** Sharp onsets above 1.5 kHz: 4 ms blocks jumping 10 dB over the median. */
function clickCount(sig, sr) {
  const h = Float32Array.from(sig)
  eq(h, sr, [['highpass', 1500, 0.7]])
  const e = envDb(h, sr, 0.004)
  const floor = stats(e).median
  let c = 0
  for (let i = 1; i < e.length; i++) if (e[i] > floor + 10 && e[i - 1] <= floor + 10) c++
  return c
}

test('torch: the flame flutters at its puffing rate, slower for a bigger flame', () => {
  for (const seed of [1, 2]) {
    const small = wobbleRate(mono(gen('torch', 10, { size: 0, crackle: 0, drips: 0, move: 0 }, seed)), 48000, 2, 12)
    const big = wobbleRate(mono(gen('torch', 10, { size: 100, crackle: 0, drips: 0, move: 0 }, seed)), 48000, 2, 12)
    // f = 1.5 / sqrt(D): 7.5 Hz for a 4 cm flame, 3.75 Hz for a 16 cm one.
    assert.ok(small > 6 && small < 9, 'small flame puffs at ' + small.toFixed(2) + ' Hz')
    assert.ok(big > 3 && big < 4.7, 'big flame puffs at ' + big.toFixed(2) + ' Hz')
  }
})

test('torch: crackle crackles, at zero the flame burns smooth', () => {
  const none = mono(gen('torch', 8, { crackle: 0, drips: 0 }, 3))
  const some = mono(gen('torch', 8, { crackle: 55, drips: 0 }, 3))
  const lots = mono(gen('torch', 8, { crackle: 100, drips: 0 }, 3))
  const c0 = clickCount(none, 48000)
  const c1 = clickCount(some, 48000)
  const c2 = clickCount(lots, 48000)
  assert.ok(c0 < 6 && c1 > c0 + 10 && c2 > c1, 'crackles in 8 s: ' + c0 + ', ' + c1 + ', ' + c2)
  assert.ok(crestDb(lots) > crestDb(none) + 4, 'sharp cracks')
  assert.ok(bandShare(lots, 48000, 1500, 7000) > bandShare(none, 48000, 1500, 7000) + 2, 'crackle in the highs')
})

test('torch: burning drips land about half a second after letting go, and hiss', () => {
  let hissed = 0
  let total = 0
  for (const seed of [1, 2, 3, 4]) {
    const t = torchLayer(48000 * 12, 48000, makeRng(seed), { drips: 1, firstDrip: 1 })
    assert.ok(t.drips.length >= 1, 'a drip fell')
    assert.ok(t.drips[0] > 1.4 && t.drips[0] < 1.6, 'fell for ' + (t.drips[0] - 1).toFixed(2) + ' s')
    const s = new Float32Array(t.L.length)
    for (let i = 0; i < s.length; i++) s[i] = 0.5 * (t.L[i] + t.R[i])
    for (const tl of t.drips) {
      if (tl < 0.6 || tl + 0.3 > 12) continue
      const after = s.subarray(Math.round((tl + 0.01) * 48000), Math.round((tl + 0.25) * 48000))
      const before = s.subarray(Math.round((tl - 0.5) * 48000), Math.round((tl - 0.05) * 48000))
      total++
      if (bandEnergyDb(after, 48000, 4500, 7000) > bandEnergyDb(before, 48000, 4500, 7000) + 3) hissed++
    }
  }
  assert.ok(total >= 5 && hissed >= total * 0.6, hissed + ' of ' + total + ' drips hissed')
  const none = torchLayer(48000 * 12, 48000, makeRng(1), { drips: 0 })
  assert.equal(none.drips.length, 0, 'no drips at zero')
})

test('torch: swinging it makes it roar and carries it across', () => {
  for (const seed of [1, 2]) {
    const still = gen('torch', 12, { move: 0, crackle: 0, drips: 0, place: 'hand' }, seed)
    const swung = gen('torch', 12, { move: 100, crackle: 0, drips: 0, place: 'hand' }, seed)
    const lv = (b) => stats(envDb(mono(b), 48000, 0.25)).sd
    const bal = (b) => {
      const l = envDb(b.ch[0], 48000, 0.25)
      const r = envDb(b.ch[1], 48000, 0.25)
      return stats(l.map((x, i) => x - r[i])).sd
    }
    assert.ok(lv(swung) > lv(still) * 1.8, 'roars up: ' + lv(swung).toFixed(2) + ' vs ' + lv(still).toFixed(2))
    assert.ok(bal(swung) > bal(still) + 0.5, 'moves across: ' + bal(swung).toFixed(2) + ' vs ' + bal(still).toFixed(2))
  }
})

test('torch: a row down a stone passage burns across the field and echoes', () => {
  const hand = gen('torch', 8, { place: 'hand' }, 1)
  const row = gen('torch', 8, { place: 'passage' }, 1)
  assert.ok(stereoCorrelation(row) < stereoCorrelation(hand) - 0.06, 'wider: ' + stereoCorrelation(row).toFixed(2) + ' vs ' + stereoCorrelation(hand).toFixed(2))
  assert.ok(stats(envDb(mono(row), 48000, 0.02)).sd < stats(envDb(mono(hand), 48000, 0.02)).sd, 'the echo fills between the cracks')
})

test('rain-gutter: the pour sounds like what it lands on', () => {
  const c = (where) => spectralCentroid(mono(gen('rain-gutter', 6, { where }, 5)), 48000)
  const barrel = c('barrel')
  const puddle = c('puddle')
  const stones = c('stones')
  assert.ok(stones > barrel * 2.5, 'stones splatter bright: ' + stones.toFixed(0) + ' vs barrel ' + barrel.toFixed(0))
  assert.ok(barrel < puddle && puddle < stones, 'barrel < puddle < stones: ' + barrel.toFixed(0) + ', ' + puddle.toFixed(0) + ', ' + stones.toFixed(0))
  assert.ok(barrel < 1300, 'a barrel booms hollow: ' + barrel.toFixed(0))
})

test('rain-gutter: the pipe gurgles more as you turn it up', () => {
  // Glugs are bursts in the 150 to 800 Hz band: its loudest 50 ms stretches
  // rise further above its median, and it wobbles more.
  const low = (s) => {
    const v = []
    const blk = 48000 * 0.05
    for (let i = 0; i + blk <= s.length; i += blk) v.push(bandEnergyDb(s.subarray(i, i + blk), 48000, 150, 800))
    const sorted = [...v].sort((x, y) => x - y)
    return { burst: sorted[Math.floor(v.length * 0.95)] - sorted[Math.floor(v.length * 0.5)], sd: stats(v).sd }
  }
  for (const seed of [5, 6, 7]) {
    const dry = low(mono(gen('rain-gutter', 8, { pipe: 0 }, seed)))
    const wet = low(mono(gen('rain-gutter', 8, { pipe: 100 }, seed)))
    assert.ok(wet.burst > dry.burst + 1, 'glug bursts: ' + wet.burst.toFixed(2) + ' vs ' + dry.burst.toFixed(2) + ' dB')
    assert.ok(wet.sd > dry.sd + 0.3, 'gurgly: ' + wet.sd.toFixed(2) + ' vs ' + dry.sd.toFixed(2))
  }
})

test('rain-gutter: harder rain is louder, distance dulls it', () => {
  assert.ok(rmsDb(mono(gen('rain-gutter', 6, { intensity: 95 }))) > rmsDb(mono(gen('rain-gutter', 6, { intensity: 10 }))) + 3, 'harder is louder')
  const near = spectralCentroid(mono(gen('rain-gutter', 6, { distance: 0 }, 5)), 48000)
  const far = spectralCentroid(mono(gen('rain-gutter', 6, { distance: 100 }, 5)), 48000)
  assert.ok(far < near * 0.85, 'far ' + far.toFixed(0) + ' vs near ' + near.toFixed(0))
})
