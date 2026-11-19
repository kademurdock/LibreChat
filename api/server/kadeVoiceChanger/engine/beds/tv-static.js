// beds/tv-static.js - An old television tuned to nothing: the roar of snow.
//
// Technique: an analogue set with no signal turns receiver noise straight
// into sound, so the "snow" is broadband white noise through the set's small
// speaker (a band pass from about 150 Hz to 7 kHz with the cone and cabinet
// resonances). Two tones ride on it in old sets, both from the published
// analogue television standards (ITU-R BT.470): the horizontal scan
// transformer's whine at the 15,734 Hz line rate (the high whistle many
// people hear from tube sets), and the 59.94 Hz frame-rate sync buzz with
// its harmonics (a narrow pulse train) when the set half-catches a carrier.
// The antenna's reception wanders, so the hiss level and colour drift and
// now and then a burst of interference crackles through. "In the next room"
// is a wall low pass with a small room behind it.

import { setup, stereo, finish, clamp, dB, wander, whiteArr, noisePair, norm, normPeak, addTo, bq, harmonicTable, oscInto, SINE, eventTimes, Fdn } from './car-highway.js'
import { crackle } from '../core/noise.js'

const bed = {
  id: 'tv-static',
  name: 'TV static',
  group: 'spooky',
  about: 'An old tube television tuned to nothing: the hiss of snow, the high whine and a buzz of sync.',
  params: [
    { id: 'intensity', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'whine', name: 'High whine', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    { id: 'buzz', name: 'Sync buzz', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
    {
      id: 'place',
      name: 'Where it is',
      type: 'choice',
      def: 'close',
      options: [
        { v: 'close', name: 'Right in front of it' },
        { v: 'next', name: 'In the next room' },
      ],
    },
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
    const M = new Float32Array(n)

    // the snow: white noise through a small speaker, reception drifting
    const hiss = whiteArr(n, r.fork('snow'))
    bq(hiss, SR, 'highpass', 150, 0.707)
    bq(hiss, SR, 'peak', 320, 1.5, 3)
    bq(hiss, SR, 'peak', 2600, 1.2, 3)
    bq(hiss, SR, 'lowpass', 7000, 0.707)
    bq(hiss, SR, 'lowpass', 7500, 0.707)
    norm(hiss, 1)
    const rec = wander(n, SR, 0.4, r.fork('rec'))
    const flick = wander(n, SR, 9, r.fork('flick'))
    const g = dB(-4 + 6 * k)
    for (let i = 0; i < n; i++) M[i] += hiss[i] * g * (1 + 0.12 * rec[i] + 0.04 * flick[i])

    // sync buzz: a narrow pulse train at the frame rate, swelling as the set half-locks
    const bz = q.buzz / 100
    if (bz > 0) {
      const buzz = new Float32Array(n)
      const amps = []
      for (let h = 1; h <= 40; h++) amps.push(1 / Math.sqrt(h))
      oscInto(buzz, SR, 59.94, 1, harmonicTable(amps), r.next(), 40)
      bq(buzz, SR, 'highpass', 100, 0.707)
      bq(buzz, SR, 'lowpass', 3000, 0.707)
      normPeak(buzz, 1)
      const sw = wander(n, SR, 0.25, r.fork('lock'))
      const gb = dB(-20 + 12 * bz)
      for (let i = 0; i < n; i++) {
        const e = clamp(0.55 + 0.45 * sw[i], 0, 1)
        M[i] += buzz[i] * gb * e * e
      }
    }

    // the line-rate whine (only where the rate can carry it)
    const wh = q.whine / 100
    if (wh > 0 && SR > 33000) {
      const f = 15734 * r.range(0.999, 1.001)
      oscInto(M, SR, f, dB(-30 + 14 * wh), SINE, 0, 1)
    }

    // interference bursts
    for (const t of eventTimes(0.08 + 0.1 * k, dur, r.fork('burst'), 1)) {
      const len = r.range(0.05, 0.4)
      const m = Math.round(len * SR)
      const c = crackle(m, SR, r.range(200, 1200), r.fork('c' + t), { maxWidthMs: 0.5, minAmp: 0.2 })
      for (let j = 0; j < m; j++) c[j] *= Math.sin((Math.PI * j) / m)
      bq(c, SR, 'bandpass', 2500, 0.5)
      normPeak(c, 1)
      addTo(M, c, g * r.range(0.6, 1.4), Math.round(t * SR))
    }

    for (let i = 0; i < n; i++) {
      L[i] = M[i]
      R[i] = M[i]
    }
    if (q.place === 'next') {
      bq(L, SR, 'lowpass', 900, 0.707)
      bq(R, SR, 'lowpass', 950, 0.707)
      bq(L, SR, 'lowpass', 1400, 0.707)
      bq(R, SR, 'lowpass', 1400, 0.707)
      new Fdn(SR, { size: 0.9, rt60: 0.6, damp: 0.6, predelayMs: 5 }).process(L, R, 0.45, 0.8)
      const [hl, hr] = noisePair(n, r.fork('room'), 'pink', 0.2)
      norm(hl, 0.003)
      norm(hr, 0.003)
      addTo(L, hl)
      addTo(R, hr)
    } else {
      // a set in a room still has a little room around it
      new Fdn(SR, { size: 0.8, rt60: 0.4, damp: 0.5, predelayMs: 3 }).process(L, R, 0.1, 1)
    }
    return finish(L, R, SR, -26 + (k - 0.6) * 8 + (q.place === 'next' ? -3 : 0), -14)
  },
}

export default bed
