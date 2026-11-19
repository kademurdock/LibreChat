// beds/rocket-launch.js - A rocket launch: ignition, the crackling roar
// building to full thrust, then climbing away into the distance.
//
// Techniques and sources:
// - Rocket noise is broadband jet-mixing roar plus "crackle": steep,
//   positively skewed shock-like spikes that the ear hears as tearing
//   paper or frying (Ffowcs Williams, Simson and Virchis, "Crackle: an
//   annoying component of jet noise", J. Fluid Mech. 71, 1975; Gee and
//   colleagues' measurements of launch-vehicle noise, JASA 2007 onward).
//   Here the roar is pink and brown noise under a cutoff that opens with
//   thrust, with turbulent flutter and a little second-order distortion to
//   skew it, and the crackle is a train of one-sided spikes with
//   heavy-tailed (Pareto) sizes whose rate follows the thrust.
// - Distance: air absorbs highs (a lower cutoff), sound arrives later, the
//   ground and far structures add a wide echo (the shared feedback delay
//   network, large and sparse). As the rocket climbs away its roar darkens
//   and falls.
// - "Steady" holds full thrust for a background that never ends.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, sweep, addModes, addBurst, Fdn } from './car-highway.js'

const DIST = {
  near: { cut: 1, crack: 1, delay: 0, wet: 0.12, low: 0 },
  viewing: { cut: 0.5, crack: 0.55, delay: 0.6, wet: 0.22, low: 1 },
  far: { cut: 0.2, crack: 0.15, delay: 1.5, wet: 0.32, low: 3 },
}

const bed = {
  id: 'rocket-launch',
  name: 'Rocket launch',
  group: 'vehicles',
  about: 'A rocket launch: ignition, a crackling roar building to full thrust, then climbing away into the sky.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 90] },
    {
      id: 'distance',
      name: 'Where you watch from',
      type: 'choice',
      def: 'viewing',
      options: [
        { v: 'near', name: 'Close to the pad' },
        { v: 'viewing', name: 'The viewing stands' },
        { v: 'far', name: 'Miles away' },
      ],
    },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 95] },
    {
      id: 'shape',
      name: 'Shape',
      type: 'choice',
      def: 'launch',
      options: [
        { v: 'launch', name: 'The whole launch' },
        { v: 'steady', name: 'A steady roar' },
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
    const dist = DIST[q.distance] || DIST.viewing
    const ck = q.crackle / 100

    // thrust envelope and how far away the rocket is
    const env = new Float32Array(n)
    const away = new Float32Array(n) // 0 on the pad .. 1 far up
    const tIgn = q.shape === 'launch' ? clamp(0.06 * dur, 0.3, 3) + dist.delay : 0
    const build = clamp(0.25 * dur, 1.5, 8)
    const tRec = Math.max(tIgn + build + 1, 0.55 * dur)
    const fl = wander(n, SR, 0.3, r.fork('slow'))
    for (let i = 0; i < n; i++) {
      const t = i / SR
      let e
      let a = 0
      if (q.shape === 'steady') e = Math.min(1, t / 1.2) * (1 + 0.06 * fl[i])
      else if (t < tIgn) e = 0
      else if (t < tIgn + build) {
        const x = (t - tIgn) / build
        e = 0.25 + 0.75 * x * x * (3 - 2 * x)
      } else if (t < tRec) e = 1 + 0.05 * fl[i]
      else {
        const x = clamp((t - tRec) / Math.max(1, dur - tRec), 0, 1)
        a = x
        e = 1 - 0.75 * x
      }
      env[i] = e
      away[i] = a
    }
    // the roar: low rumble and a mid roar whose cutoff opens with thrust
    const [bl, br] = noisePair(n, r.fork('low'), 'brown', 0.5)
    const [pl, pr] = noisePair(n, r.fork('mid'), 'pink', 0.35)
    for (const sig of [bl, br]) {
      bq(sig, SR, 'lowpass', 160, 0.7)
      bq(sig, SR, 'highpass', 18, 0.7)
      norm(sig, 1)
    }
    const cut = (i) => (300 + 3800 * env[i] * (1 - 0.7 * away[i])) * dist.cut + 150
    sweep(pl, SR, 'lowpass', cut, 0.6)
    sweep(pr, SR, 'lowpass', (i) => cut(i) * 0.95, 0.6)
    norm(pl, 1)
    norm(pr, 1)
    const flut = wander(n, SR, 14, r.fork('flut'))
    const flut2 = wander(n, SR, 11, r.fork('flut2'))
    const gLow = dB(dist.low)
    for (let i = 0; i < n; i++) {
      const e = env[i]
      const fa = 1 + 0.22 * flut[i]
      const fb = 1 + 0.22 * flut2[i]
      let a = (bl[i] * gLow + pl[i] * 0.9) * e * fa
      let b = (br[i] * gLow + pr[i] * 0.9) * e * fb
      // skew: the roar's pressure peaks are sharper than its troughs
      a += 0.18 * a * a
      b += 0.18 * b * b
      L[i] += a
      R[i] += b
    }
    bq(L, SR, 'highpass', 18, 0.7)
    bq(R, SR, 'highpass', 18, 0.7)
    // crackle: one-sided spikes with heavy-tailed sizes, rate following thrust
    if (ck > 0) {
      const CL = new Float32Array(n)
      const CR = new Float32Array(n)
      const d = Math.exp(-1 / (0.00025 * SR))
      let el = 0
      let er = 0
      const base = (150 + 1400 * ck) / SR
      for (let i = 0; i < n; i++) {
        const e = env[i] * (1 - 0.8 * away[i])
        const pr2 = base * e * e
        let sl = 0
        let sr2 = 0
        if (r.next() < pr2) sl = Math.min(12, Math.pow(1 - r.next(), -1 / 1.6) - 0.7)
        if (r.next() < pr2) sr2 = Math.min(12, Math.pow(1 - r.next(), -1 / 1.6) - 0.7)
        el = el * d + sl
        er = er * d + sr2
        if (el < 1e-20) el = 0
        if (er < 1e-20) er = 0
        CL[i] = el
        CR[i] = er
      }
      for (const sig of [CL, CR]) {
        bq(sig, SR, 'highpass', 350, 0.707)
        bq(sig, SR, 'lowpass', 9000 * dist.cut + 500, 0.707)
        norm(sig, 1)
      }
      const g = dB(-6 + 6 * ck) * dist.crack
      addTo(L, CL, g)
      addTo(R, CR, g)
    }
    // ignition: a deep whump and a crack
    if (q.shape === 'launch' && tIgn < dur) {
      const i0 = Math.round(tIgn * SR)
      addModes(L, R, i0, SR, [[r.range(28, 36), 0.4, 1], [r.range(55, 70), 0.25, 0.6]], 2.2, 0, r)
      addBurst(L, R, i0, SR, r, { amp: 1.4 * dist.crack + 0.3, pan: 0, tau: 0.08, f: 900 * dist.cut + 200, q: 0.5, type: 'lowpass' })
    }
    // ground and far buildings throw it back
    new Fdn(SR, { size: 5, rt60: 2.2, damp: 0.55, predelayMs: 40, diffuse: 0.6 }).process(L, R, dist.wet, 1)
    // before ignition: open air
    const [al, ar] = noisePair(n, r.fork('air'), 'pink', 0.2)
    for (const sig of [al, ar]) {
      bq(sig, SR, 'lowpass', 1200, 0.7)
      norm(sig, 0.02)
    }
    addTo(L, al)
    addTo(R, ar)
    return finish(L, R, SR, -20 + (k - 0.6) * 8, -10)
  },
}

export default bed
