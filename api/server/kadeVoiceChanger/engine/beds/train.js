// beds/train.js - Riding in a passenger train: clickety-clack over the rail
// joints, the rolling rumble, and the horn far ahead at a crossing.
//
// Techniques and sources:
// - Rail joints: on jointed track every wheel drops over every joint, so
//   the rhythm is set by geometry: each axle meets a joint at
//   t = t_joint + x / v, where x is the axle's place along the train. A
//   passenger car rides on two bogies of two axles each (about 2.5 m apart,
//   bogie centres about 16 m apart), so a seat near one end hears the pair
//   under it loudly and the next car's pair a moment later: the classic
//   "di-dum ... di-dum". Loudness falls with distance along the floor as
//   1 / (1 + (dx / h)^2). This is the joint-impact view of wheel-rail noise
//   in Thompson, "Railway Noise and Vibration" (Elsevier 2009). Each impact
//   is a low body thump plus the short ring of the wheel and rail (modal
//   synthesis; van den Doel and Pai 1998).
// - Rolling noise: broadband roughness noise rising about 30 dB per decade
//   of speed (Thompson 2009), a low body boom and a gently drifting speed.
// - Switches now and then give a fast clatter of axles over the frog, and
//   curves bring a thin flange squeal.
// - The horn: a reedy four-note chord blown in the long, long, short, long
//   pattern used at road crossings in North America (the common operating
//   rule for grade crossings), far ahead and through air absorption; then
//   the crossing bell passes outside with its doppler drop
//   (f' = f / (1 - v_r / c), c = 343 m/s).

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, addModes, addBurst, addTone, eventTimes, harmonicTable, Fdn } from './car-highway.js'
import { addBell } from './haunted-house.js'

const REED = harmonicTable([1, 0.7, 0.55, 0.42, 0.3, 0.22, 0.16, 0.11, 0.08, 0.05])

// axle positions in metres from the front of our car (train moves toward negative x)
const AXLES = [-5.25, -2.75, 2.75, 5.25, 18.75, 21.25, 26.75, 29.25, 42.75, 45.25]

const bed = {
  id: 'train',
  name: 'Train ride',
  group: 'vehicles',
  about: 'Inside a train car: clickety-clack over the rails, the rumble of the wheels and a horn far ahead.',
  params: [
    { id: 'intensity', name: 'Speed', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    {
      id: 'track',
      name: 'Track',
      type: 'choice',
      def: 'jointed',
      options: [
        { v: 'jointed', name: 'Old jointed rails' },
        { v: 'welded', name: 'Smooth welded rails' },
      ],
    },
    {
      id: 'seat',
      name: 'Seat',
      type: 'choice',
      def: 'wheels',
      options: [
        { v: 'wheels', name: 'Over the wheels' },
        { v: 'middle', name: 'Middle of the car' },
      ],
    },
    { id: 'horn', name: 'Horn and crossings', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
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
    const v0 = 12 + 22 * k
    const sp = v0 / 24
    const vw = wander(n, SR, 0.04, r.fork('v'))
    const vAt = (t) => v0 * (1 + 0.04 * vw[Math.min(n - 1, Math.max(0, Math.round(t * SR)))])

    // rolling noise and the car body
    const [rl, rr] = noisePair(n, r.fork('roll'), 'brown', 0.6)
    const [ml, mr] = noisePair(n, r.fork('roar'), 'pink', 0.35)
    const sway = wander(n, SR, 0.6, r.fork('sway'))
    for (const sig of [rl, rr]) {
      bq(sig, SR, 'lowpass', 220, 0.7)
      bq(sig, SR, 'peak', 52, 1.5, 4)
      norm(sig, 1)
    }
    for (const sig of [ml, mr]) {
      bq(sig, SR, 'bandpass', 480 + 160 * sp, 0.55)
      bq(sig, SR, 'peak', 900 * sp + 300, 3, 3)
      bq(sig, SR, 'lowpass', 2600, 0.707)
      norm(sig, 1)
    }
    const gR = dB(-3 + 24 * Math.log10(sp))
    const gM = dB(-5 + 30 * Math.log10(sp) + (q.track === 'welded' ? 0 : 1))
    for (let i = 0; i < n; i++) {
      const sw = 1 + 0.12 * sway[i]
      L[i] += (rl[i] * gR + ml[i] * gM) * sw
      R[i] += (rr[i] * gR + mr[i] * gM) * (2 - sw)
    }

    // one wheel over one joint: a thump and a short metallic clack
    const seatX = q.seat === 'middle' ? 12 : 20
    const h = q.seat === 'middle' ? 4.5 : 3.4
    const hit = (t, amp, pan) => {
      const i0 = Math.round(t * SR)
      const a = amp * r.range(0.8, 1.2)
      addModes(L, R, i0, SR, [[r.range(68, 85), 0.04, 1], [r.range(150, 175), 0.025, 0.5]], a, pan * 0.3, r)
      addModes(L, R, i0, SR, [[r.range(900, 1100), 0.014, 0.9], [r.range(1900, 2300), 0.009, 0.6], [r.range(3300, 3800), 0.005, 0.3]], a * (0.6 + 0.5 * sp), pan * 0.4, r)
      addBurst(L, R, i0, SR, r, { amp: a * 1.3, pan: pan * 0.4, tau: 0.005, f: 1200, q: 0.5 })
    }
    const joints = []
    if (q.track === 'jointed') {
      const railLen = r.pick([18.3, 25, 25, 11.9]) * r.range(0.995, 1.005)
      let t = -2
      while (t < dur) {
        joints.push(t)
        t += (railLen * r.range(0.995, 1.005)) / vAt(t)
      }
    }
    const strength = 4.5 * dB(10 * Math.log10(sp))
    for (const tj of joints) {
      const v = vAt(tj)
      for (const x of AXLES) {
        const dx = (x - seatX) / h
        const g = 1 / (1 + dx * dx)
        if (g < 0.02) continue
        const t = tj + (x + 8) / v
        if (t < 0 || t >= dur) continue
        // left and right wheels a hair apart
        hit(t, strength * g, -1)
        hit(t + r.range(0, 0.0015), strength * g * 0.9, 1)
      }
    }
    // a switch: a quick clatter over the frog
    for (const t of eventTimes(q.track === 'welded' ? 0.04 : 0.025, dur, r.fork('switch'), 10)) {
      const v = vAt(t)
      for (const x of AXLES) {
        for (const off of [0, 3.1, 4.4]) {
          const dx = (x - seatX) / h
          const g = 1 / (1 + dx * dx)
          if (g < 0.03) continue
          const tt = t + (x + off + 8) / v
          if (tt < 0 || tt >= dur) continue
          hit(tt, strength * g * 0.8, r.sign())
        }
      }
    }
    // flange squeal on curves
    for (const t of eventTimes(0.02, dur, r.fork('squeal'), 12)) {
      const f = r.range(2800, 4600)
      addTone(L, R, Math.round(t * SR), SR, { f, attack: 0.4, hold: r.range(0.8, 2.5), tau: 0.4, amp: 0.05 * sp, pan: r.range(-0.6, 0.6), vibrato: 0.006, vibratoRate: r.range(3, 7) })
    }

    // the horn far ahead, then the crossing bell going by
    const hornAmt = q.horn / 100
    if (hornAmt > 0) {
      const HL = new Float32Array(n)
      const HR = new Float32Array(n)
      for (const t0 of eventTimes(0.012 + 0.05 * hornAmt, dur, r.fork('horn'), 25, -3)) {
        const chord = r.pick([[311, 370, 440, 523], [277, 330, 392, 466], [349, 415, 494, 587]])
        const pat = [[0, 2.2], [2.7, 2.2], [5.4, 0.8], [6.7, 3]]
        for (const [dt, len] of pat) {
          for (const f of chord) {
            const st = Math.round((t0 + dt) * SR)
            addTone(HL, HR, st, SR, { f: (x) => f * (1 - 0.03 * Math.exp(-x * 9)), attack: 0.08, hold: len, tau: 0.12, amp: 0.25, pan: -0.15, table: REED, maxHarm: 10 })
          }
        }
        // the crossing bell passes as we reach the road
        const tc = t0 + 9 + r.range(2, 5)
        const fb = r.range(780, 980)
        for (let j = -10; j <= 10; j++) {
          const tb = tc + j / 1.8
          if (tb < 0 || tb >= dur) continue
          const d = Math.hypot(j / 1.8 * v0, 12)
          const vr = (-v0 * (j / 1.8) * v0) / d // closing speed along the line of sight
          const fd = fb / (1 - vr / 343)
          const amp = clamp(12 / d, 0, 1) * 0.6
          addBell(L, R, Math.round(tb * SR), SR, r, { f: fd / 2, amp: amp * 0.8, pan: clamp(-0.9 + j * 0.03, -0.95, -0.4), tau: 0.8 })
        }
      }
      bq(HL, SR, 'lowpass', 1300, 0.707)
      bq(HR, SR, 'lowpass', 1300, 0.707)
      new Fdn(SR, { size: 3, rt60: 1.4, damp: 0.6, predelayMs: 30 }).process(HL, HR, 0.6, 0.7)
      const g = dB(-12 + 6 * hornAmt)
      addTo(L, HL, g)
      addTo(R, HR, g)
    }
    // the car's own interior: a short boxy room
    new Fdn(SR, { size: 0.6, rt60: 0.35, damp: 0.6, predelayMs: 3 }).process(L, R, 0.12, 1)
    return finish(L, R, SR, -23 + (k - 0.55) * 8, -12)
  },
}

export default bed
