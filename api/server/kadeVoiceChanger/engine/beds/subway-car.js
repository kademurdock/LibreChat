// beds/subway-car.js - Riding an underground train: the tunnel roar, motors
// singing up and down between stations, squealing curves and the door chime.
//
// Techniques and sources:
// - The station-to-station cycle is the stop-and-go drive cycle of
//   beds/bus.js with metro speeds (a few tens of seconds per station).
// - Traction motors whine at a pitch tied to wheel speed (gear mesh and
//   rotor slots), and an inverter-driven train adds the switching tone of
//   its power electronics, which steps between a few fixed carrier pitches at
//   low speed before it gives way to a pitch that follows the speed (the
//   modulation-mode changes of pulse-width-modulated traction inverters, as
//   described in Bose, "Modern Power Electronics and AC Drives", 2002). An
//   older line uses the growl of direct-current motors and gears instead.
// - Rolling noise and rail joints as in beds/train.js (Thompson, "Railway
//   Noise and Vibration", 2009), louder and boomier because the tunnel walls
//   return the sound; the tunnel is a large feedback delay network.
// - Curve squeal is the stick-slip of the wheel flange: a few unstable
//   narrow tones between 2 and 6 kHz that wobble and jump.
// - At stations: brakes hiss, the doors slide with a two-note chime.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, oscInto, SINE, harmonicTable, addModes, addBurst, addTone, eventTimes, Fdn } from './car-highway.js'
import { driveCycle, addHiss } from './bus.js'

const GEAR = harmonicTable([1, 0.5, 0.35, 0.2, 0.12])

const bed = {
  id: 'subway-car',
  name: 'Subway car',
  group: 'vehicles',
  about: 'Inside an underground train: tunnel roar, motors whining up and down, squealing curves and door chimes.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    {
      id: 'line',
      name: 'Train',
      type: 'choice',
      def: 'modern',
      options: [
        { v: 'modern', name: 'A modern train' },
        { v: 'old', name: 'An old rattling train' },
      ],
    },
    { id: 'squeal', name: 'Squealing curves', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
    { id: 'stops', name: 'Stops at stations', type: 'bool', def: true },
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
    const old = q.line === 'old'
    const cyc = driveCycle(n, SR, r.fork('cycle'), {
      highway: !q.stops, vmax: old ? 16 : 19, gears: [[0, 99]], idle: 0, rpmLo: 0, rpmHi: 1,
      stopLen: [6, 10], accelLen: [9, 13], cruiseLen: [5, 12], brakeLen: [6, 9],
    })
    const { v, load, ev } = cyc
    const vmax = old ? 16 : 19

    // rolling roar, boomed up by the tunnel
    const [rl, rr] = noisePair(n, r.fork('roll'), 'brown', 0.5)
    const [ml, mr] = noisePair(n, r.fork('roar'), 'pink', 0.3)
    for (const sig of [rl, rr]) {
      bq(sig, SR, 'lowpass', 240, 0.7)
      bq(sig, SR, 'peak', 60, 1.3, 5)
      norm(sig, 1)
    }
    for (const sig of [ml, mr]) {
      bq(sig, SR, 'bandpass', 700, 0.5)
      bq(sig, SR, 'lowpass', old ? 3500 : 2600, 0.707)
      norm(sig, 1)
    }
    const flutter = wander(n, SR, 2.5, r.fork('flut'))
    for (let i = 0; i < n; i++) {
      const x = v[i] / vmax
      const gr = 0.25 + 0.75 * x * Math.sqrt(x)
      const gm = (old ? 0.75 : 0.55) * x * x * (1 + 0.12 * flutter[i])
      L[i] += rl[i] * gr + ml[i] * gm
      R[i] += rr[i] * gr + mr[i] * gm
    }
    // ventilation, always running
    {
      const [fl, fr] = noisePair(n, r.fork('fan'), 'pink', 0.2)
      for (const sig of [fl, fr]) {
        bq(sig, SR, 'bandpass', 900, 0.7)
        norm(sig, 1)
      }
      addTo(L, fl, 0.12)
      addTo(R, fr, 0.12)
    }
    // motors: modern inverter steps then a speed-following whine; old DC growl
    {
      const f1 = new Float32Array(n)
      const a1 = new Float32Array(n)
      const f2 = new Float32Array(n)
      const a2 = new Float32Array(n)
      const steps = [r.range(380, 420), r.range(520, 560), r.range(690, 740)]
      for (let i = 0; i < n; i++) {
        const vv = v[i]
        const x = vv / vmax
        const ld = load[i]
        if (old) {
          f1[i] = 30 * vv + 20
          a1[i] = 0.22 * Math.min(1, x * 3) * (0.5 + 0.5 * ld)
          f2[i] = 92 * vv + 40
          a2[i] = 0.05 * Math.min(1, x * 2)
        } else {
          // gear and rotor whine follows speed
          f1[i] = 38 * vv + 10
          a1[i] = 0.12 * Math.min(1, x * 4) * (0.3 + 0.7 * ld)
          // the inverter's carrier: fixed steps at low speed, then it follows the speed
          const st = vv < 3 ? steps[0] : vv < 6 ? steps[1] : vv < 9 ? steps[2] : 80 * vv
          f2[i] = st
          a2[i] = 0.07 * (vv > 0.3 ? 1 : 0) * ld * (vv < 14 ? 1 : 0.4)
        }
      }
      // smooth the inverter's pitch steps a little so they glide like the real ones
      const aa = 1 - Math.exp(-1 / (0.04 * SR))
      let z = f2[0]
      let za = a2[0]
      for (let i = 0; i < n; i++) {
        z += aa * (f2[i] - z)
        za += aa * (a2[i] - za)
        f2[i] = z
        a2[i] = za
      }
      const g = dB(-2 + 4 * k)
      for (let i = 0; i < n; i++) {
        a1[i] *= g
        a2[i] *= g
      }
      oscInto(L, SR, f1, a1, GEAR, 0, 5)
      oscInto(R, SR, f1, a1, GEAR, 0.25, 5)
      oscInto(L, SR, f2, a2, old ? GEAR : SINE, 0, old ? 5 : 1)
      oscInto(R, SR, f2, a2, old ? GEAR : SINE, 0.5, old ? 5 : 1)
    }
    // rail joints, quick and sharp
    {
      const railLen = r.range(12, 18)
      let t = r.range(0, 0.5)
      while (t < dur) {
        const vv = v[Math.min(n - 1, Math.round(t * SR))]
        if (vv < 1.5) {
          t += 0.3
          continue
        }
        const a = (old ? 2.6 : 1.6) * (vv / vmax)
        for (const [dx, g] of [[0, 1], [2.5, 0.9], [7.5, 0.35], [10, 0.3]]) {
          const tt = t + dx / vv
          const i0 = Math.round(tt * SR)
          const pan = r.range(-0.3, 0.3)
          addModes(L, R, i0, SR, [[r.range(75, 90), 0.035, 1], [r.range(1000, 1300), 0.01, 0.6], [r.range(2400, 2900), 0.006, 0.35]], a * g, pan, r)
          addBurst(L, R, i0, SR, r, { amp: a * g, pan, tau: 0.004, f: 1300, q: 0.5 })
        }
        t += railLen / vv
      }
    }
    // rattles of the old train
    if (old) {
      for (const t of eventTimes(1.5, dur, r.fork('rattle'), 0.15)) {
        const vv = v[Math.min(n - 1, Math.round(t * SR))]
        if (vv < 3) continue
        let tt = t
        const f = r.range(600, 1300)
        const pan = r.range(-0.9, 0.9)
        for (let h = 0; h < 3 + r.int(6); h++) {
          addModes(L, R, Math.round(tt * SR), SR, [[f, 0.01, 1], [f * 2.3, 0.005, 0.5]], 0.25, pan)
          tt += r.range(0.02, 0.04)
        }
      }
    }
    // curve squeal
    const sq = q.squeal / 100
    if (sq > 0) {
      for (const t of eventTimes(0.02 + 0.08 * sq, dur, r.fork('squeal'), 4)) {
        const vv = v[Math.min(n - 1, Math.round(t * SR))]
        if (vv < 4) continue
        const len = r.range(1.2, 4)
        const parts = 1 + r.int(3)
        for (let j = 0; j < parts; j++) {
          const f = r.range(2200, 5800)
          const jump = r.range(0.97, 1.03)
          const off = r.range(0, len * 0.4)
          const wob = r.range(20, 40)
          addTone(L, R, Math.round((t + off) * SR), SR, {
            f: (x) => f * (x > len * 0.5 ? jump : 1) * (1 + 0.004 * Math.sin(x * wob)),
            attack: 0.25, hold: len * r.range(0.4, 0.8), tau: 0.3, amp: (0.04 + 0.05 * sq) * r.range(0.6, 1), pan: r.range(-0.7, 0.7), vibrato: 0.004, vibratoRate: r.range(4, 9),
          })
        }
      }
    }
    // stations: brakes, the doors and their chime
    for (const st of ev.stops) {
      addHiss(L, R, SR, r, { t: st.t0 + 0.2, len: 0.4, amp: 0.35, f: 4200, pan: 0 })
      const tOpen = st.t0 + 0.9
      const tClose = st.t1 - 2.2
      const chime = old ? [[740, 0.3]] : [[988, 0.38], [784, 0.6]]
      for (const tt of [tOpen, tClose]) {
        if (tt < -1 || tt > dur) continue
        let c = 0
        for (const [f, len] of chime) {
          addTone(L, R, Math.round((tt - 0.9 + c) * SR), SR, { f, attack: 0.005, hold: 0.02, tau: len * 0.6, amp: 0.2, pan: 0.2, table: harmonicTable([1, 0.15, 0.05]), maxHarm: 3 })
          c += 0.45
        }
        addBurst(L, R, Math.round(tt * SR), SR, r, { amp: 0.45, pan: 0.5, attack: 0.12, hold: 0.55, tau: 0.12, f: 300, q: 0.7, type: 'lowpass' })
        addModes(L, R, Math.round((tt + 0.8) * SR), SR, [[r.range(90, 110), 0.05, 1], [r.range(380, 450), 0.03, 0.5]], 0.7, 0.5, r)
      }
    }
    // the tunnel
    new Fdn(SR, { size: 2.2, rt60: 1.3, damp: 0.5, predelayMs: 14 }).process(L, R, 0.28, 1)
    return finish(L, R, SR, -22 + (k - 0.55) * 8, -10)
  },
}

export default bed
