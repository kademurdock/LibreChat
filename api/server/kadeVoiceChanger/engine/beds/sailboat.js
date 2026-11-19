// beds/sailboat.js - Aboard a sailboat: wind in the rigging, the sail
// flapping, lines creaking, a halyard tinking on the mast, water at the hull.
//
// Techniques and sources:
// - Wind is the gusting pink-noise wind of beds/haunted-house.js, with the
//   narrow howl of wind over taut wire (an aeolian tone, the vortex
//   shedding of Strouhal: f = 0.2 v / d) rising and falling with the gusts.
// - A luffing sail flutters: noise amplitude-modulated by a fast irregular
//   flapping rate with a low "whump" on each snap (Farnell, "Designing
//   Sound", the flag and cloth sounds).
// - Creaks are the stick-slip creaks of the toolkit through rope and wood
//   resonances (Avanzini, Serafin and Rocchesso 2005), timed to the boat's
//   roll on the swell, as lines and blocks take the load.
// - A loose halyard slapping an aluminium mast is a hollow tube ring:
//   decaying inharmonic modes (modal synthesis, van den Doel and Pai 1998)
//   in little clusters when gusts swing it.
// - Water: the hull slaps and gurgles of beds/boat-engine.js, gentler.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, addModes, addBurst, eventTimes, Fdn } from './car-highway.js'
import { windPair, addCreak, ROPE, WOOD } from './haunted-house.js'
import { addHullWater, washPair } from './boat-engine.js'

const bed = {
  id: 'sailboat',
  name: 'Sailboat',
  group: 'vehicles',
  about: 'Aboard a sailboat: wind in the rigging, a flapping sail, creaking lines, a halyard tinking and water at the hull.',
  params: [
    { id: 'intensity', name: 'Wind', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'waves', name: 'Waves', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [15, 85] },
    { id: 'creaks', name: 'Creaking', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 90] },
    { id: 'rigging', name: 'Rigging and sail', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 90] },
  ],

  generate(seconds, sr, p, rng) {
    const s = setup(bed, seconds, sr, p, rng)
    const { n, q } = s
    const SR = s.sr
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return stereo(SR, L, R)
    const r = s.rng
    const dur = s.dur
    const k = q.intensity / 100
    const wv = q.waves / 100
    const rig = q.rigging / 100
    const crk = q.creaks / 100

    // wind, with the rigging's howl
    const [wl, wr, gust] = windPair(n, SR, r.fork('wind'), { strength: k, gust: 0.7, howl: 0.15 + 0.5 * rig * k, dark: 1.2, rate: 0.14 })
    const wg = dB(-8 + 9 * k)
    addTo(L, wl, wg)
    addTo(R, wr, wg)
    // the swell: one roll period that the creaks and slaps follow
    const period = r.range(3, 5.5) / (0.7 + 0.5 * wv)
    // water at the hull
    {
      const [al, ar] = washPair(n, SR, r.fork('wash'), 0.8)
      const sw = wander(n, SR, 1 / period, r.fork('sw'))
      const g = dB(-16 + 6 * wv + 3 * k)
      for (let i = 0; i < n; i++) {
        const m = 0.6 + 0.4 * sw[i]
        L[i] += al[i] * g * m
        R[i] += ar[i] * g * (1.2 - m)
      }
      if (wv > 0) addHullWater(L, R, SR, r.fork('hull'), { dur, period: period * 0.5, amp: 0.3 + 0.9 * wv, hull: 1.1, lap: 1 + wv })
    }
    // the sail luffs now and then
    if (rig > 0) {
      for (const t of eventTimes(0.03 + 0.12 * rig * (0.3 + k), dur, r.fork('luff'), 3)) {
        const len = r.range(0.6, 2.2)
        const m = Math.round(len * SR)
        const i0 = Math.round(t * SR)
        const [fl, fr] = noisePair(m, r.fork('f' + t), 'pink', 0.6)
        const rate = r.range(7, 14)
        let ph = 0
        const pan = r.range(-0.5, 0.5)
        for (let j = 0; j < m; j++) {
          const x = j / m
          ph += (rate * (1 + 0.3 * Math.sin(j * 0.0007))) / SR
          const flap = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * ph), 6)
          const env = Math.sin(Math.PI * x) * (0.25 + flap)
          fl[j] *= env
          fr[j] *= env
        }
        bq(fl, SR, 'lowpass', 1600, 0.707)
        bq(fr, SR, 'lowpass', 1500, 0.707)
        norm(fl, 1)
        norm(fr, 1)
        const g = (0.5 + 0.6 * rig) * (0.6 + 0.6 * k)
        for (let j = 0; j < m && i0 + j < n; j++) {
          L[i0 + j] += fl[j] * g * (1 - pan) * 0.7
          R[i0 + j] += fr[j] * g * (1 + pan) * 0.7
        }
        addModes(L, R, i0 + Math.round(len * 0.4 * SR), SR, [[r.range(60, 80), 0.06, 1]], g * 0.8, pan, r)
      }
      // the halyard tinking on the mast, in clusters with the gusts
      for (const t of eventTimes(0.12 + 0.4 * rig, dur, r.fork('tink'), 0.8)) {
        const gi = gust[Math.min(n - 1, Math.round(t * SR))]
        if (gi < 0.6 && r.next() < 0.5) continue
        const hits = 1 + r.int(3)
        let tt = t
        const f = r.range(620, 900)
        for (let h = 0; h < hits; h++) {
          const a = (0.15 + 0.25 * rig) * r.range(0.5, 1)
          addModes(L, R, Math.round(tt * SR), SR, [[f, 0.5, 1], [f * 2.76, 0.25, 0.5], [f * 5.4, 0.1, 0.3], [f * 8.9, 0.05, 0.15]], a, 0.2, r)
          addBurst(L, R, Math.round(tt * SR), SR, r, { amp: a * 0.4, pan: 0.2, tau: 0.001, f: 4000, q: 0.7 })
          tt += r.range(0.12, 0.4)
        }
      }
    }
    // creaks as the boat rolls: lines on winches, blocks and the wooden hull
    if (crk > 0) {
      let t = r.range(0, period)
      while (t < dur) {
        const c = 1 + (r.next() < crk ? 1 : 0) + (r.next() < crk * 0.5 ? 1 : 0)
        for (let j = 0; j < c; j++) {
          if (r.next() > 0.35 + 0.6 * crk) continue
          const rope = r.next() < 0.55
          const tt = t + r.range(0, period * 0.5)
          const r0 = rope ? r.range(25, 60) : r.range(12, 30)
          addCreak(L, R, Math.round(tt * SR), SR, r, {
            dur: r.range(0.4, 1.4), rate0: r0, peak: r0 * r.range(1.3, 3), rate1: r0 * r.range(0.8, 1.5), modes: rope ? ROPE : WOOD,
            amp: (0.15 + 0.4 * crk) * r.range(0.5, 1), pan: r.range(-0.8, 0.8), wobble: 0.3,
          })
        }
        t += period * r.range(0.85, 1.15)
      }
    }
    // open air around the boat, a little sail and deck reflection
    new Fdn(SR, { size: 1.4, rt60: 0.5, damp: 0.5, predelayMs: 8 }).process(L, R, 0.08, 1)
    return finish(L, R, SR, -23 + (k - 0.5) * 6 + clamp(wv - 0.45, -0.45, 0.55) * 2, -16)
  },
}

export default bed
