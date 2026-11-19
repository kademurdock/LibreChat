// modules/device/pa.js - device.pa, PA system (offline only, stereo out).
//
// An announcement over public-address speakers in a big space:
// - the announcer's chain: a close microphone, a compressor, and the PA
//   loudspeakers of the venue (column horns in a gym or a station, a grid
//   of ceiling speakers in an airport or a shop, big horns in a stadium),
//   pushed a little;
// - feedback ring: one narrow, high-gain resonance that rings on after the
//   words, the sound of a PA system just short of howling;
// - delay towers: the same voice arriving again from speakers farther
//   away, each later, quieter and duller (distributed sound systems; in a
//   stadium they are a fifth of a second and more apart, in a shop ceiling
//   only a few tens of milliseconds);
// - the venue: a synthetic impulse response from core/ir.js (gym, subway
//   station, stadium, or custom airport-hall and shop specs) through core
//   convolution, with listener distance setting how much of the space you
//   hear;
// - an optional attention chime before the first words (a struck-bar
//   two-note or three-note chime, placed in the pause before the first
//   phrase that core/segment.js finds).

import { Bank, butter, Bq, Rand, Squash, Tone, speechRef, BLOCK, SPEECH, frac, db } from './_kit.js'
import { DelayLine } from '../../core/delay.js'
import { namedIR, roomIR } from '../../core/ir.js'
import { convolveBuf } from '../../core/conv.js'
import { findPhrases } from '../../core/segment.js'
import { resolveParams } from '../../core/params.js'
import { makeRng } from '../../core/rng.js'
import { bufLen, fade } from '../../core/buf.js'

const VENUES = ['gym', 'airport', 'station', 'stadium', 'store']
const TAIL = [2.6, 3.0, 3.0, 3.4, 1.6]
// speaker EQ: [hp, hpOrder, lp, peaks...[hz, q, db]]
const EQ = [
  [200, 4, 6000, [[2000, 1, 4], [600, 1, 2]]],
  [180, 2, 7000, [[1000, 1, 2], [3000, 1.2, 2]]],
  [300, 4, 5000, [[1800, 1.2, 5]]],
  [250, 4, 5500, [[1500, 1, 4], [3000, 1.5, 3]]],
  [150, 2, 8000, [[1200, 1, 2]]],
]
// delay towers: [ms, dB, lowpass Hz]
const TOWERS = [
  [[38, -6, 4000], [72, -10, 3000]],
  [[24, -4, 5000], [47, -6, 4500], [71, -8, 4000], [96, -11, 3500]],
  [[60, -5, 3500], [140, -8, 3000], [230, -12, 2500]],
  [[110, -4, 3500], [250, -7, 3000], [420, -10, 2400]],
  [[18, -4, 6000], [36, -7, 5000], [55, -10, 4500]],
]
const AIRPORT = { shape: 'hall', size: [80, 40, 12], decay: 2.4, damping: 0.6, bassRatio: 0.9, distance: 10, erMs: 200, density: 0.85, irregular: 0.4 }
const STORE = { shape: 'room', size: [40, 30, 4], decay: 1.1, damping: 0.65, distance: 5, erMs: 120, irregular: 0.5 }

function venueIR(v, sr, rng) {
  if (v === 0) return namedIR('gym', sr, rng)
  if (v === 2) return namedIR('subway-station', sr, rng)
  if (v === 3) return namedIR('stadium', sr, rng)
  if (v === 1) return roomIR(sr, AIRPORT, rng.fork('pa-airport'))
  return roomIR(sr, STORE, rng.fork('pa-store'))
}

const mod = {
  id: 'device.pa',
  name: 'PA system',
  family: 'device',
  about: 'An announcement over loudspeakers in a big place: a school gym, an airport, a train station, a stadium or a store.',
  params: [
    {
      id: 'venue', name: 'Place', type: 'choice', def: 'gym',
      options: [
        { v: 'gym', name: 'School gym' },
        { v: 'airport', name: 'Airport hall' },
        { v: 'station', name: 'Train station' },
        { v: 'stadium', name: 'Stadium' },
        { v: 'store', name: 'Store ceiling speakers' },
      ],
    },
    { id: 'ring', name: 'Feedback ring', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [0, 40] },
    { id: 'towers', name: 'Far speakers', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'distance', name: 'Listener distance', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    {
      id: 'chime', name: 'Chime first', type: 'choice', def: 'none',
      options: [
        { v: 'none', name: 'No chime' },
        { v: 'two', name: 'Two-note chime' },
        { v: 'three', name: 'Three-note chime' },
      ],
    },
    { id: 'push', name: 'Speaker push', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
  ],
  stereo: 'make',
  warps: false,
  cost: 4,
  tail: (p) => TAIL[Math.max(0, VENUES.indexOf(p && p.venue))],
  process(input, pIn, ctx) {
    const c = ctx || {}
    const p = resolveParams(mod, pIn)
    const sr = input.sr
    const n = bufLen(input)
    if (n === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const rng = c.rng || makeRng('device.pa')
    let v = VENUES.indexOf(p.venue)
    if (v < 0) v = 0
    const nch = input.ch.length
    const mono = new Float32Array(n)
    for (let k = 0; k < nch; k++) {
      const ch = input.ch[k]
      for (let i = 0; i < n; i++) {
        const x = ch[i]
        mono[i] += x === x && x < 1e6 && x > -1e6 ? x / nch : 0
      }
    }
    const ref = speechRef(mono, sr)
    const pre = SPEECH / ref
    const tailN = Math.round(mod.tail(p) * sr)
    const len = n + tailN
    const x = new Float32Array(len)
    for (let i = 0; i < n; i++) x[i] = mono[i] * pre
    // the chime, in the pause before the first words
    if (p.chime !== 'none') {
      const t = new Tone(sr, new Rand(rng, 'pa-chime'))
      const a = SPEECH * 3
      if (p.chime === 'two') t.add(659.3, 659.3, 700, a, 2).add(523.3, 523.3, 1100, a, 2)
      else t.add(523.3, 523.3, 450, a, 2).add(659.3, 659.3, 450, a, 2).add(784, 784, 1100, a, 2)
      // before the first words when there is room, else in the first pause
      // long enough to hold it, else at the very start, softer
      const ph = findPhrases(mono, sr, { minSilenceMs: 300 })
      const need = t.length + Math.round(0.25 * sr)
      let start = -1
      for (let k = 0; k < ph.length && start < 0; k++) {
        const gap = k === 0 ? ph[0].start : ph[k].start - ph[k - 1].end
        if (gap >= need) start = ph[k].start - need
      }
      let cg = 1
      if (start < 0) {
        start = 0
        cg = 0.5
      }
      t.start(0)
      const L = Math.max(0, Math.min(t.length, len - start))
      const tmp = new Float32Array(L)
      t.render(tmp, L, cg)
      for (let i = 0; i < L; i++) x[start + i] += tmp[i]
    }
    // announcer chain and loudspeakers
    const mic = new Bank(sr, 3)
    mic.f[0].hp(120, 0.7071)
    mic.f[1].peak(3000, 1, 2)
    const comp = new Squash(sr)
    comp.set(-28, 4, 3, 150, 6, 6)
    const E = EQ[v]
    const spk = new Bank(sr, 8)
    let j = butter(spk, 0, 'hp', E[0], E[1])
    j = butter(spk, j, 'lp', E[2], 4)
    for (const pk of E[3]) spk.f[j++].peak(pk[0], pk[1], pk[2])
    const ringHz = 700 + 2500 * rng.fork('pa-ring').next()
    const ring = new Bq(sr).peak(ringHz, 35, 3 + 15 * frac(p.ring))
    const drive = 1 + 5 * frac(p.push)
    const towers = TOWERS[v]
    const tw = frac(p.towers) * 1.2
    const dl = new DelayLine(Math.ceil(0.45 * sr) + 8)
    const tf = towers.map((t) => new Bq(sr).lp(t[2], 0.7071))
    const tg = towers.map((t) => db(t[1]) * tw)
    const td = towers.map((t) => (t[0] * sr) / 1000)
    const s = new Float32Array(BLOCK)
    const y = new Float32Array(len)
    for (let pos = 0; pos < len; pos += BLOCK) {
      const m = Math.min(BLOCK, len - pos)
      for (let q = 0; q < m; q++) s[q] = x[pos + q]
      mic.run(s, m)
      comp.run(s, m)
      for (let q = 0; q < m; q++) s[q] = Math.tanh(s[q] * drive) / drive
      ring.run(s, m)
      spk.run(s, m)
      for (let q = 0; q < m; q++) {
        const d = s[q]
        dl.write(d)
        let acc = d
        if (tw > 0) for (let k = 0; k < td.length; k++) acc += tf[k].tick(dl.read(td[k])) * tg[k]
        y[pos + q] = acc
      }
      if (typeof c.cancelled === 'function' && c.cancelled()) break
    }
    if (typeof c.progress === 'function') c.progress(0.4)
    // the venue
    const ir = venueIR(v, sr, rng)
    const mix = 25 + 65 * frac(p.distance)
    const wet = convolveBuf({ sr, ch: [y] }, ir, mix, { law: 'power' })
    if (typeof c.progress === 'function') c.progress(0.95)
    const post = (ref / SPEECH) * db(2)
    const out = [new Float32Array(len), new Float32Array(len)]
    for (let k = 0; k < 2; k++) {
      const w = wet.ch[Math.min(k, wet.ch.length - 1)]
      const o = out[k]
      const L = Math.min(len, w.length)
      for (let i = 0; i < L; i++) {
        let val = w[i] * post
        if (!(val === val) || val > 1e6 || val < -1e6) val = 0
        const a = val < 0 ? -val : val
        if (a > 1.5) val = (val < 0 ? -1 : 1) * (1.5 + 1.5 * Math.tanh((a - 1.5) / 1.5))
        o[i] = val
      }
    }
    const res = { sr, ch: out }
    fade(res, 0, Math.min(0.08, tailN / sr))
    return res
  },
}

export default mod
