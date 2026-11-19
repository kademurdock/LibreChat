// beds/graveyard.js - A graveyard at night: wind in the trees, crickets, an owl,
// a far bell tolling and an iron gate creaking.
//
// Techniques and sources: leaves are pink noise high passed and fluttered by
// fast random amplitude under slow gusts (Farnell, "Designing Sound", the
// wind and foliage chapters); the gate is the stick-slip creak of
// beds/haunted-house.js through metal resonances instead of wood (Avanzini,
// Serafin and Rocchesso 2005); the bell is the church-bell partial set
// (hum, prime, tierce, quint, nominal) as decaying beating mode pairs
// (van den Doel and Pai 1998, modal synthesis); crickets are field-cricket
// chirps of three or four carrier pulses near 4.5 kHz; the owl is a soft
// hooting pattern. Distance is a low pass, a level drop and more of the
// open-air reverb (the shared feedback delay network, sparse and wide).

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, eventTimes, Fdn } from './car-highway.js'
import { windPair, addCreak, addBell, addOwl, addCrickets, METAL } from './haunted-house.js'

const bed = {
  id: 'graveyard',
  name: 'Graveyard at night',
  group: 'spooky',
  about: 'An old graveyard after dark: wind in bare trees, crickets, an owl, a far bell and a creaking iron gate.',
  params: [
    { id: 'intensity', name: 'How much happens', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 85] },
    { id: 'wind', name: 'Wind', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'bell', name: 'Far bell', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
    { id: 'creatures', name: 'Crickets and owl', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [10, 90] },
    { id: 'distance', name: 'Bell and owl distance', type: 'number', min: 50, max: 2000, step: 10, def: 400, unit: 'meters', rand: [150, 1200] },
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
    const act = q.intensity / 100
    const windAmt = q.wind / 100
    const far = clamp(Math.log10(q.distance / 50) / Math.log10(40), 0, 1) // 0 near .. 1 far

    // wind body, low and moving
    const [wl, wr, gust] = windPair(n, SR, r.fork('wind'), { strength: windAmt, gust: 0.8, howl: 0.15 + 0.3 * windAmt, dark: 0.9, rate: 0.09 })
    const wg = dB(-24 + 22 * windAmt)
    addTo(L, wl, wg)
    addTo(R, wr, wg)
    // dry leaves and bare twigs: high flutter that rises with the gusts
    {
      const [ll, lr] = noisePair(n, r.fork('leaves'), 'pink', 0.15)
      const fl = wander(n, SR, 22, r.fork('fl'))
      const fr = wander(n, SR, 19, r.fork('fr'))
      for (const sig of [ll, lr]) {
        bq(sig, SR, 'highpass', 1500, 0.7)
        bq(sig, SR, 'lowpass', 9000, 0.7)
      }
      for (let i = 0; i < n; i++) {
        const g = clamp(gust[i] - 0.25, 0, 1)
        const e = g * g * (0.4 + 0.6 * windAmt)
        ll[i] *= e * (0.55 + 0.45 * fl[i])
        lr[i] *= e * (0.55 + 0.45 * fr[i])
      }
      norm(ll, 1)
      norm(lr, 1)
      const g = dB(-26 + 20 * windAmt)
      addTo(L, ll, g)
      addTo(R, lr, g)
    }

    // events go through the open-air space
    const EL = new Float32Array(n)
    const ER = new Float32Array(n)
    const crit = q.creatures / 100
    if (crit > 0) {
      addCrickets(EL, ER, SR, r.fork('crickets'), { count: 2 + Math.round(5 * crit), amp: 0.05 + 0.1 * crit })
      for (const t of eventTimes(0.015 + 0.05 * crit, dur - 2.5, r.fork('owl'), 6, -0.5)) {
        addOwl(EL, ER, Math.max(0, t), SR, r, { f: r.range(290, 360), amp: 0.5 * dB(-14 * far), pan: r.range(-0.9, 0.9) })
      }
    }
    // the gate, swinging a little in the wind
    for (const t of eventTimes(0.02 + 0.07 * act * (0.4 + windAmt), dur, r.fork('gate'), 5)) {
      const r0 = r.range(20, 50)
      addCreak(EL, ER, Math.round(t * SR), SR, r, {
        dur: r.range(0.8, 2.2), rate0: r0, peak: r0 * r.range(2, 6), rate1: r.range(25, 90), modes: METAL, jitter: 0.08, wobble: 0.4,
        amp: r.range(0.25, 0.55), pan: r.range(-0.7, 0.7), rub: 0.05,
      })
      if (r.next() < 0.5) {
        // it swings shut: a clank
        const i0 = Math.round((t + r.range(1.0, 2.5)) * SR)
        addBellClank(EL, ER, i0, SR, r, r.range(380, 520))
      }
    }
    // the far bell, tolling slowly
    const bellAmt = q.bell / 100
    if (bellAmt > 0) {
      for (const t of eventTimes(0.012 + 0.04 * bellAmt, dur - 1, r.fork('bell'), 12, -2)) {
        const strokes = 2 + r.int(4)
        const per = r.range(3.2, 4.6)
        const f = r.range(170, 240)
        const pan = r.range(-0.6, 0.6)
        for (let k = 0; k < strokes; k++) {
          const tt = t + k * per
          if (tt < 0 || tt > dur) continue
          addBell(EL, ER, Math.round(tt * SR), SR, r, { f, amp: 0.65 * dB(-10 * far) * (0.6 + 0.6 * bellAmt), pan, tau: 4.5 })
        }
      }
    }
    // distance: highs fade with air
    const cut = 9000 - 6500 * far
    bq(EL, SR, 'lowpass', cut, 0.707)
    bq(ER, SR, 'lowpass', cut, 0.707)
    new Fdn(SR, { size: 3.5, rt60: 1.6 + far, damp: 0.6, predelayMs: 25, diffuse: 0.7 }).process(EL, ER, 0.12 + 0.2 * far, 1 - 0.3 * far)
    addTo(L, EL)
    addTo(R, ER)
    // very low night air
    const [al, ar] = noisePair(n, r.fork('air'), 'brown', 0.3)
    bq(al, SR, 'lowpass', 120, 0.7)
    bq(ar, SR, 'lowpass', 120, 0.7)
    norm(al, 0.05)
    norm(ar, 0.05)
    addTo(L, al)
    addTo(R, ar)
    return finish(L, R, SR, -25 + (act - 0.5) * 4 + (windAmt - 0.5) * 3, -15)
  },
}

/** An iron gate swinging shut against its post. */
function addBellClank(L, R, i0, sr, rng, f) {
  const pan = rng.range(-0.6, 0.6)
  addBell(L, R, i0, sr, rng, { f, amp: 0.22, pan, tau: 0.5 })
  addBell(L, R, i0 + Math.round(rng.range(0.03, 0.08) * sr), sr, rng, { f: f * 1.07, amp: 0.1, pan, tau: 0.35 })
}

export default bed
