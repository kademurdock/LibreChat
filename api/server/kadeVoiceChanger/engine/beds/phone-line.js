// beds/phone-line.js - A telephone line: dial tone, ringing or busy, with the
// hiss, hum, clicks and faint crosstalk of old copper.
//
// Techniques and published sources:
// - Call-progress tones follow the published tone plans: the North American
//   Precise Tone Plan (dial tone 350 + 440 Hz continuous; ringback 440 + 480 Hz,
//   2 s on and 4 s off; busy 480 + 620 Hz, half a second on and off; reorder,
//   the fast busy, a quarter second on and off) and the common European dial
//   tone of 425 Hz (ITU-T Recommendation E.180 lists them all).
// - The line is band limited to the classic 300 to 3400 Hz telephone channel
//   (ITU-T G.712).
// - Line noise: white hiss, power-line induction hum at 60 Hz with its odd
//   harmonics (longitudinal induction from power lines is rich in the third
//   and fifth), crackle from corroded joints (Poisson clicks and short
//   "frying" bursts), and crosstalk: a faint babbling conversation from a
//   neighbouring pair, too far down to understand (the babble of
//   beds/radio-static.js, high-passed, as crosstalk couples highs best).
// The line is mono by nature; it is written to both sides with a hint of
// width from the earpiece room.

import { setup, stereo, finish, clamp, dB, whiteArr, norm, normPeak, addTo, bq, harmonicTable, oscInto, SINE, eventTimes, wander, addAir, Fdn } from './car-highway.js'
import { babble } from './radio-static.js'
import { crackle } from '../core/noise.js'

const TONES = {
  none: null,
  dial: { f: [350, 440], on: 0, off: 0 },
  europe: { f: [425], on: 0, off: 0 },
  ring: { f: [440, 480], on: 2, off: 4 },
  busy: { f: [480, 620], on: 0.5, off: 0.5 },
  reorder: { f: [480, 620], on: 0.25, off: 0.25 },
}

const bed = {
  id: 'phone-line',
  name: 'Telephone line',
  group: 'spooky',
  about: 'An old phone line: a dial tone, ringing or busy signal, with hiss, hum, clicks and faint crosstalk.',
  params: [
    {
      id: 'tone',
      name: 'Tone',
      type: 'choice',
      def: 'dial',
      options: [
        { v: 'none', name: 'An open line, no tone' },
        { v: 'dial', name: 'Dial tone' },
        { v: 'europe', name: 'Dial tone, European' },
        { v: 'ring', name: 'Ringing' },
        { v: 'busy', name: 'Busy signal' },
        { v: 'reorder', name: 'Fast busy' },
      ],
    },
    { id: 'intensity', name: 'Line noise', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [15, 85] },
    { id: 'hum', name: 'Hum', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 70] },
    { id: 'crosstalk', name: 'Crosstalk voices', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'clicks', name: 'Clicks and crackle', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
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

    // the tone, at the level a line carries it (the reference everything else sits under)
    const tone = TONES[q.tone]
    if (tone) {
      const env = new Float32Array(n)
      if (tone.on > 0) {
        const per = tone.on + tone.off
        const t0 = r.range(0, per)
        const edge = 0.004 * SR
        for (let i = 0; i < n; i++) {
          const t = (i / SR + t0) % per
          const x = t * SR
          const y = (tone.on - t) * SR
          env[i] = t < tone.on ? Math.min(1, x / edge, y / edge) : 0
        }
      } else env.fill(1)
      for (const f of tone.f) oscInto(M, SR, f, env, SINE, r.next(), 1)
      // a carbon-era line adds a whisper of distortion to the tone
      for (let i = 0; i < n; i++) {
        const v = M[i] * 0.3
        M[i] = v + 0.04 * v * v * 3
      }
    }
    const ref = 0.6

    // hiss
    const hiss = whiteArr(n, r.fork('hiss'))
    norm(hiss, 1)
    const hg = dB(-34 + 18 * k) * ref
    addTo(M, hiss, hg)
    // hum: 60 Hz with odd harmonics, drifting a little in level
    const hu = q.hum / 100
    if (hu > 0) {
      const h = new Float32Array(n)
      oscInto(h, SR, 60 * r.range(0.998, 1.002), 1, harmonicTable([0.4, 0, 1, 0, 0.6, 0, 0.3, 0, 0.15]), r.next(), 9)
      const w = wander(n, SR, 0.3, r.fork('hum'))
      const g = dB(-32 + 16 * hu) * ref
      for (let i = 0; i < n; i++) M[i] += h[i] * g * (1 + 0.2 * w[i])
    }
    // crosstalk from the next pair
    const ct = q.crosstalk / 100
    if (ct > 0) {
      const a = babble(n, SR, r.fork('ct1'), { pitch: r.range(100, 140), rate: 4.4, talk: 0.7 })
      const b = babble(n, SR, r.fork('ct2'), { pitch: r.range(180, 230), rate: 4.8, talk: 0.55 })
      for (let i = 0; i < n; i++) a[i] = a[i] + 0.8 * b[i]
      bq(a, SR, 'highpass', 900, 0.707)
      normPeak(a, 1)
      addTo(M, a, dB(-34 + 12 * ct) * ref)
    }
    // clicks and frying
    const ck = q.clicks / 100
    if (ck > 0) {
      const c = crackle(n, SR, 1 + 12 * ck, r.fork('clicks'), { maxWidthMs: 0.8, popChance: 0.05 })
      normPeak(c, 1)
      addTo(M, c, dB(-18 + 8 * ck) * ref)
      for (const t of eventTimes(0.05 + 0.2 * ck, dur, r.fork('fry'), 1)) {
        const len = r.range(0.1, 0.6)
        const m = Math.round(len * SR)
        const f = crackle(m, SR, r.range(400, 1500), r.fork('f' + t), { maxWidthMs: 0.3, minAmp: 0.3 })
        for (let j = 0; j < m; j++) f[j] *= Math.sin((Math.PI * j) / m)
        normPeak(f, 1)
        addTo(M, f, dB(-24 + 8 * ck) * ref, Math.round(t * SR))
      }
    }

    // the telephone channel
    bq(M, SR, 'highpass', 300, 0.707)
    bq(M, SR, 'highpass', 300, 0.707)
    bq(M, SR, 'lowpass', 3400, 0.707)
    bq(M, SR, 'lowpass', 3400, 0.707)
    for (let i = 0; i < n; i++) {
      L[i] = M[i]
      R[i] = M[i]
    }
    new Fdn(SR, { size: 0.4, rt60: 0.25, damp: 0.5, predelayMs: 1 }).process(L, R, 0.06, 1)
    addAir(L, R, SR, r.fork('air'), 0.0008)
    return finish(L, R, SR, -24 + (tone ? 0 : -4) + clamp(k - 0.45, -0.45, 0.55) * (tone ? 2 : 8), -40)
  },
}

export default bed
