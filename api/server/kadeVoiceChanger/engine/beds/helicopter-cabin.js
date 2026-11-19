// beds/helicopter-cabin.js - Inside a helicopter: the rotor's thump, turbine
// whine, the gearbox and the wind.
//
// Techniques and sources:
// - Main-rotor noise is periodic at the blade-passage rate; each passing
//   blade throws a low, impulsive pressure pulse (thickness and loading
//   noise), and in turns and descents the blade meets the vortex of the
//   one before and slaps (blade-vortex interaction): Leverton, "Helicopter
//   noise: can it be adequately controlled?" and the review by Brentner and
//   Farassat, "Modeling aerodynamically generated sound of helicopter rotors"
//   (Progress in Aerospace Sciences 39, 2003). Here every pass is a short low
//   modal thump with a band of noise, the slap strength wandering with the
//   flying, and the cabin roar is amplitude-modulated at the same rate.
// - The tail rotor adds a faster buzz, the turbine a high double whine with
//   its broadband hiss, and the main gearbox a mid whine at the gear-mesh
//   rate, the tone passengers notice most inside (Farnell, "Designing
//   Sound", the helicopter chapter, uses the same parts).
// - Doors open: much more wind and a rawer thump, less of the whine.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, oscInto, harmonicTable, SINE, addModes, addBurst, Fdn } from './car-highway.js'

const BUZZ = harmonicTable([1, 0.8, 0.6, 0.45, 0.32, 0.22, 0.15, 0.1])

const bed = {
  id: 'helicopter-cabin',
  name: 'Helicopter cabin',
  group: 'vehicles',
  about: 'Inside a helicopter in flight: the deep rotor thump, the turbine whine, the gearbox and rushing wind.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'rate', name: 'Rotor beat', type: 'number', min: 3, max: 14, step: 0.1, def: 5.5, unit: 'hz', rand: [4.5, 9] },
    { id: 'whine', name: 'Turbine whine', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [15, 80] },
    {
      id: 'doors',
      name: 'Doors',
      type: 'choice',
      def: 'closed',
      options: [
        { v: 'closed', name: 'Doors closed' },
        { v: 'open', name: 'Doors open' },
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
    const open = q.doors === 'open'
    const rate0 = q.rate
    const slapW = wander(n, SR, 0.12, r.fork('slap'))
    const rateW = wander(n, SR, 0.07, r.fork('rpm'))

    // blade passes: an exact schedule from the rotor speed (it holds within about a percent)
    const passes = []
    let t = r.range(0, 1 / rate0)
    while (t < dur) {
      passes.push(t)
      const rr = rate0 * (1 + 0.008 * rateW[Math.min(n - 1, Math.round(t * SR))])
      t += 1 / rr
    }
    // cabin roar, beating with the blades
    const [nl, nr] = noisePair(n, r.fork('roar'), 'pink', 0.5)
    for (const sig of [nl, nr]) {
      bq(sig, SR, 'lowpass', open ? 2400 : 900, 0.707)
      bq(sig, SR, 'highpass', 40, 0.707)
      norm(sig, 1)
    }
    const am = new Float32Array(n)
    for (const tp of passes) {
      const i0 = Math.round(tp * SR)
      const m = Math.round((0.6 / rate0) * SR)
      for (let j = 0; j < m && i0 + j < n; j++) {
        const x = j / m
        am[i0 + j] += Math.exp(-x * 5) * (1 - Math.exp(-x * 60))
      }
    }
    for (let i = 0; i < n; i++) {
      const g = 0.6 + 0.55 * am[i]
      L[i] += nl[i] * g
      R[i] += nr[i] * g
    }
    // the thump of each blade, with the slap wandering in and out
    const thumpG = dB(4 + (open ? 3 : 0))
    for (let j = 0; j < passes.length; j++) {
      const tp = passes[j]
      const i0 = Math.round(tp * SR)
      if (i0 >= n) break
      const slap = clamp(0.35 + 0.65 * slapW[Math.min(n - 1, i0)], 0, 1)
      const a = thumpG * r.range(0.9, 1.1) * (j % 2 ? 0.93 : 1)
      addModes(L, R, i0, SR, [[r.range(52, 60), 0.045, 1], [r.range(105, 120), 0.025, 0.55], [r.range(190, 230), 0.012, 0.25]], a, r.range(-0.1, 0.1), r)
      addBurst(L, R, i0, SR, r, { amp: a * (0.25 + 0.9 * slap * slap), pan: 0, tau: 0.008 + 0.006 * slap, f: 520 + 500 * slap, q: 0.7 })
    }
    // tail rotor buzz
    {
      const f = new Float32Array(n)
      for (let i = 0; i < n; i++) f[i] = rate0 * 5.3 * (1 + 0.008 * rateW[i])
      const tl = new Float32Array(n)
      oscInto(tl, SR, f, 1, BUZZ, r.next(), 8)
      bq(tl, SR, 'lowpass', 700, 0.707)
      norm(tl, 1)
      const g = dB(-16 + (open ? 3 : 0))
      addTo(L, tl, g * 0.8)
      addTo(R, tl, g)
    }
    // turbine: two high tones and their hiss; gearbox mesh whine in the middle
    const wh = q.whine / 100
    if (wh > 0) {
      const gW = dB(-30 + 14 * wh + (open ? -6 : 0))
      const wobble = wander(n, SR, 0.5, r.fork('tw'))
      const f1 = new Float32Array(n)
      const f2 = new Float32Array(n)
      const f3 = new Float32Array(n)
      const a = r.range(5600, 6400)
      const b = r.range(8100, 8900)
      const c = rate0 * r.range(190, 220)
      for (let i = 0; i < n; i++) {
        const w = 1 + 0.004 * wobble[i] + 0.006 * rateW[i]
        f1[i] = a * w
        f2[i] = b * w
        f3[i] = c * (1 + 0.008 * rateW[i])
      }
      oscInto(L, SR, f1, gW, SINE, 0, 1)
      oscInto(R, SR, f1, gW * 0.8, SINE, 0.3, 1)
      oscInto(L, SR, f2, gW * 0.5, SINE, 0.1, 1)
      oscInto(R, SR, f2, gW * 0.6, SINE, 0.6, 1)
      const gear = new Float32Array(n)
      oscInto(gear, SR, f3, 1, harmonicTable([1, 0.4, 0.15]), r.next(), 3)
      const gg = dB(-24 + 8 * wh + (open ? -4 : 0))
      addTo(L, gear, gg)
      addTo(R, gear, gg)
      const [hl, hr] = noisePair(n, r.fork('hiss'), 'white', 0.5)
      for (const sig of [hl, hr]) {
        bq(sig, SR, 'bandpass', 4200, 0.8)
        norm(sig, 1)
      }
      addTo(L, hl, gW * 0.6)
      addTo(R, hr, gW * 0.6)
    }
    // wind past the doors
    {
      const [wl, wr] = noisePair(n, r.fork('wind'), 'pink', 0.2)
      const gust = wander(n, SR, 0.3, r.fork('gust'))
      for (const sig of [wl, wr]) {
        bq(sig, SR, 'highpass', 250, 0.707)
        bq(sig, SR, 'lowpass', open ? 7000 : 2500, 0.707)
        norm(sig, 1)
      }
      const g = dB(open ? 2 : -12)
      for (let i = 0; i < n; i++) {
        const e = 1 + 0.25 * gust[i]
        L[i] += wl[i] * g * e
        R[i] += wr[i] * g * (2 - e)
      }
    }
    new Fdn(SR, { size: 0.5, rt60: 0.3, damp: 0.6, predelayMs: 2 }).process(L, R, open ? 0.04 : 0.1, 1)
    return finish(L, R, SR, -21 + (k - 0.6) * 8, -10)
  },
}

export default bed
