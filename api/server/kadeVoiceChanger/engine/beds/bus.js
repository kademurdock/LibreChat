// beds/bus.js - Riding a city bus: the diesel at the back, stops and doors,
// air brakes, gear changes and rattling windows.
//
// Techniques and sources:
// - The engine is the toolkit's combustion-pulse model (beds/car-highway.js;
//   Farnell, "Designing Sound", 2010; Baldan and others, "Physically informed
//   car engine sound synthesis", 2015) as a six-cylinder four-stroke diesel:
//   three firings per turn, so 30 Hz at a 600 rpm idle and about 95 Hz near
//   the top of each gear, with the hard injection knock of a diesel.
// - A drive cycle (the stop-start shape of urban bus duty cycles, as in the
//   published city-bus test cycles) sets speed and engine speed: stand at
//   the stop, pull away through three automatic gears (each shift drops the
//   revs and the load for a moment), cruise, brake, stop again.
// - Turbo whine is a faint tone rising with engine speed and load. Road
//   noise rises about 30 dB per decade of speed.
// - Air systems are band-passed noise bursts: the brake "pssht", the
//   pneumatic doors with their mechanism thunk (modal synthesis, van den
//   Doel and Pai 1998), plus a generic three-beep door warning and the
//   passenger stop bell (a small bell with church-bell partials).
// - Loose windows and panels rattle in short trains of impacts when the
//   road jolts the body.

import {
  setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, engine, oscInto, SINE, addModes, addBurst,
  addTone, eventTimes, Fdn,
} from './car-highway.js'
import { addBell } from './haunted-house.js'

/**
 * A stop-and-go drive cycle as per-sample speed (m/s), engine speed (rpm)
 * and load (0..1), plus the event times. o: { dur, idle=620, vmax=13,
 * gears=[[0, 4.5], [4.5, 9], [9, 99]], rpmLo=1200, rpmHi=1950, stopLen=[6, 10],
 * accelLen=[8, 11], cruiseLen=[3, 8], brakeLen=[3.5, 5], highway=false }.
 */
export function driveCycle(n, sr, rng, o = {}) {
  const v = new Float32Array(n)
  const rpm = new Float32Array(n)
  const load = new Float32Array(n)
  const ev = { stops: [], shifts: [], pullAway: [], brakeEnds: [] }
  const dur = n / sr
  const idle = o.idle ?? 620
  const vmax = o.vmax ?? 13
  const gears = o.gears || [[0, 4.5], [4.5, 9], [9, 99]]
  const lo = o.rpmLo ?? 1200
  const hi = o.rpmHi ?? 1950
  const rpmFor = (vv, accel) => {
    for (let g = 0; g < gears.length; g++) {
      const [a, b] = gears[g]
      if (vv < b || g === gears.length - 1) {
        const span = Math.min(b, vmax) - a
        const f = span > 0 ? clamp((vv - a) / span, 0, 1) : 0
        const bottom = g === 0 ? idle + 150 : lo
        return accel ? bottom + (hi - bottom) * f : Math.max(idle, bottom * 0.9 + (hi - bottom) * 0.5 * f)
      }
    }
    return idle
  }
  // build phases starting somewhere inside a cycle
  const phases = []
  const R = (x) => rng.range(x[0], x[1])
  let t = -rng.range(0, 25)
  if (o.highway) {
    phases.push({ kind: 'cruise', t0: -1, t1: dur + 1 })
  } else {
    while (t < dur + 1) {
      const sLen = R(o.stopLen || [6, 10])
      phases.push({ kind: 'stop', t0: t, t1: t + sLen })
      t += sLen
      const aLen = R(o.accelLen || [8, 11])
      phases.push({ kind: 'accel', t0: t, t1: t + aLen })
      t += aLen
      const cLen = R(o.cruiseLen || [3, 8])
      phases.push({ kind: 'cruise', t0: t, t1: t + cLen })
      t += cLen
      const bLen = R(o.brakeLen || [3.5, 5])
      phases.push({ kind: 'brake', t0: t, t1: t + bLen })
      t += bLen
    }
  }
  const wv = wander(n, sr, 0.15, rng.fork('wv'))
  const blk = 32
  let pi = 0
  let shiftGear = -1
  for (let i = 0; i < n; i += blk) {
    const tt = i / sr
    while (pi < phases.length - 1 && tt >= phases[pi].t1) pi++
    const ph = phases[pi]
    const x = clamp((tt - ph.t0) / Math.max(0.01, ph.t1 - ph.t0), 0, 1)
    let vv, rr, ld
    if (ph.kind === 'stop') {
      vv = 0
      rr = idle * (1 + 0.01 * wv[i])
      ld = 0.35
    } else if (ph.kind === 'accel') {
      vv = vmax * (1 - Math.pow(1 - x, 1.6))
      rr = rpmFor(vv, true)
      ld = 1
      // a shift: find the gear and remember the moment it changed
      let g = 0
      while (g < gears.length - 1 && vv >= gears[g][1]) g++
      if (g !== shiftGear) {
        if (shiftGear >= 0 && g > shiftGear) ev.shifts.push(tt)
        shiftGear = g
      }
    } else if (ph.kind === 'cruise') {
      vv = (o.highway ? vmax : vmax) * (1 + 0.04 * wv[i])
      rr = (o.highway ? hi * 0.92 : lo + (hi - lo) * 0.35) * (1 + 0.03 * wv[i])
      ld = 0.55 + 0.15 * wv[i]
      shiftGear = -1
    } else {
      vv = vmax * Math.pow(1 - x, 1.3)
      rr = Math.max(idle, rpmFor(vv, false) * (1 - 0.3 * x))
      ld = 0.15
    }
    const e = Math.min(n, i + blk)
    for (let j = i; j < e; j++) {
      v[j] = vv
      rpm[j] = rr
      load[j] = ld
    }
  }
  // shifts dip the revs and load for a moment (smoothed below)
  for (const ts of ev.shifts) {
    const i0 = Math.round(ts * sr)
    const m = Math.round(0.45 * sr)
    for (let j = 0; j < m && i0 + j < n; j++) {
      const w = Math.sin((Math.PI * j) / m)
      load[i0 + j] *= 1 - 0.65 * w
    }
  }
  // smooth everything so revs glide (one-pole, about 0.25 s)
  const a = 1 - Math.exp(-1 / (0.25 * sr))
  const al = 1 - Math.exp(-1 / (0.08 * sr))
  let sr0 = rpm[0], sl = load[0], sv = v[0]
  for (let i = 0; i < n; i++) {
    sr0 += a * (rpm[i] - sr0)
    sl += al * (load[i] - sl)
    sv += a * (v[i] - sv)
    rpm[i] = sr0
    load[i] = sl
    v[i] = sv
  }
  for (const ph of phases) {
    if (ph.kind === 'stop') ev.stops.push({ t0: ph.t0, t1: ph.t1 })
    if (ph.kind === 'accel') ev.pullAway.push(ph.t0)
    if (ph.kind === 'brake') ev.brakeEnds.push(ph.t1)
  }
  return { v, rpm, load, ev }
}

/** A pneumatic hiss: o { t, len, amp, pan, f } */
export function addHiss(L, R, sr, rng, o) {
  addBurst(L, R, Math.round(o.t * sr), sr, rng, { amp: o.amp ?? 0.5, pan: o.pan ?? 0, attack: 0.03, hold: o.len ?? 0.5, tau: (o.len ?? 0.5) * 0.35, f: o.f ?? 4200, q: 0.6 })
}

const bed = {
  id: 'bus',
  name: 'City bus',
  group: 'vehicles',
  about: 'Riding a city bus: the diesel growling at the back, stops, hissing doors and brakes, rattling windows.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    {
      id: 'route',
      name: 'Route',
      type: 'choice',
      def: 'city',
      options: [
        { v: 'city', name: 'Stopping around town' },
        { v: 'highway', name: 'Out on the highway' },
      ],
    },
    { id: 'rattles', name: 'Rattles', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [10, 85] },
    { id: 'bells', name: 'Bells and beeps', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
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
    const hw = q.route === 'highway'
    const cyc = driveCycle(n, SR, r.fork('cycle'), hw ? { highway: true, vmax: 24, rpmHi: 1900 } : {})
    const { v, rpm, load, ev } = cyc

    // the diesel at the back
    const eng = engine(n, SR, rpm, { cyl: 6, pulseHz: 150, pulseQ: 1.8, rough: 0.1, uneven: 0.06, knock: 0.55, knockHz: 2300, res: [[85, 2, 5], [330, 2.5, 3]] }, r.fork('engine'))
    bq(eng, SR, 'lowpass', 1600, 0.707)
    const eg = dB(-3 + 4 * k)
    for (let i = 0; i < n; i++) {
      const x = eng[i] * eg * (0.45 + 0.75 * load[i])
      L[i] += x * 0.95
      R[i] += x
    }
    // turbo whine
    {
      const f = new Float32Array(n)
      const a = new Float32Array(n)
      const g = dB(-31 + 4 * k)
      for (let i = 0; i < n; i++) {
        f[i] = rpm[i] * 2.1
        const lr = clamp((rpm[i] - 900) / 1100, 0, 1)
        a[i] = g * lr * lr * load[i]
      }
      oscInto(L, SR, f, a, SINE, 0, 1)
      oscInto(R, SR, f, a, SINE, 0.3, 1)
    }
    // road and tyres, rising with speed
    {
      const [rl, rr] = noisePair(n, r.fork('road'), 'brown', 0.5)
      const [tl, tr] = noisePair(n, r.fork('tyre'), 'pink', 0.4)
      for (const sig of [rl, rr]) {
        bq(sig, SR, 'lowpass', 180, 0.7)
        norm(sig, 1)
      }
      for (const sig of [tl, tr]) {
        bq(sig, SR, 'bandpass', 600, 0.5)
        bq(sig, SR, 'lowpass', 2200, 0.707)
        norm(sig, 1)
      }
      const vref = hw ? 24 : 13
      for (let i = 0; i < n; i++) {
        const x = v[i] / vref
        const gr = 0.55 * x * Math.sqrt(x)
        const gt = 0.5 * x * x
        L[i] += rl[i] * gr + tl[i] * gt
        R[i] += rr[i] * gr + tr[i] * gt
      }
    }
    // rattles on bumps while moving
    const rat = q.rattles / 100
    if (rat > 0) {
      for (const t of eventTimes(0.3 + 1.8 * rat, dur, r.fork('rattle'), 0.2)) {
        const vv = v[Math.min(n - 1, Math.round(t * SR))]
        if (vv < 1.5 && r.next() < 0.85) continue
        const hits = 3 + r.int(8)
        const pan = r.range(-0.9, 0.9)
        const f = r.range(700, 1500)
        let tt = t
        const a = (0.15 + 0.35 * rat) * r.range(0.5, 1)
        for (let h = 0; h < hits; h++) {
          addModes(L, R, Math.round(tt * SR), SR, [[f * r.range(0.97, 1.03), 0.01, 1], [f * 2.4, 0.005, 0.5]], a * (1 - h / (hits + 2)), pan)
          tt += r.range(0.022, 0.045)
        }
      }
    }
    // stops: brakes set, doors open and close, the warning beeps, the brake release
    const bells = q.bells / 100
    for (const st of ev.stops) {
      const len = st.t1 - st.t0
      addHiss(L, R, SR, r, { t: st.t0 + 0.25, len: r.range(0.3, 0.6), amp: 0.5, pan: r.range(-0.3, 0.3), f: 3800 })
      const tOpen = st.t0 + 1.2
      const tClose = st.t1 - 2.4
      for (const [tt, open] of [[tOpen, true], [tClose, false]]) {
        if (tt < -1 || tt > dur) continue
        if (!open && bells > 0) {
          for (let b = 0; b < 3; b++) addTone(L, R, Math.round((tt - 1 + b * 0.28) * SR), SR, { f: 2300, attack: 0.004, hold: 0.12, tau: 0.01, amp: 0.12 * (0.4 + bells), pan: 0.5 })
        }
        addHiss(L, R, SR, r, { t: tt, len: 0.7, amp: 0.55, pan: 0.6, f: 3000 })
        addBurst(L, R, Math.round(tt * SR), SR, r, { amp: 0.4, pan: 0.6, attack: 0.1, hold: 0.5, tau: 0.1, f: 220, q: 0.7, type: 'lowpass' })
        addModes(L, R, Math.round((tt + 0.75) * SR), SR, [[r.range(85, 100), 0.06, 1], [r.range(210, 250), 0.04, 0.6], [r.range(900, 1100), 0.015, 0.3]], 0.9, 0.6, r)
      }
      if (len > 4) addHiss(L, R, SR, r, { t: st.t1 - 0.4, len: 0.25, amp: 0.45, pan: -0.2, f: 5000 })
    }
    // pulling out: the indicator ticks
    for (const t of ev.pullAway) {
      for (let f = 0; f < 5; f++) {
        const i1 = Math.round((t - 1.5 + f * 0.7) * SR)
        addModes(L, R, i1, SR, [[1650, 0.006, 1], [3600, 0.003, 0.6]], 0.3, -0.6)
        addModes(L, R, i1 + Math.round(0.35 * SR), SR, [[1400, 0.006, 1], [3100, 0.003, 0.5]], 0.22, -0.6)
      }
    }
    // squealing brakes at the end of some stops
    for (const t of ev.brakeEnds) {
      if (r.next() < 0.5) addTone(L, R, Math.round((t - 1.4) * SR), SR, { f: r.range(1500, 2600), attack: 0.2, hold: 0.9, tau: 0.15, amp: 0.06, pan: r.range(-0.4, 0.4), vibrato: 0.01, vibratoRate: 6 })
    }
    // a passenger pulls the cord
    if (bells > 0) {
      for (const t of eventTimes(0.02 + 0.06 * bells, dur, r.fork('ding'), 8)) {
        if (v[Math.min(n - 1, Math.round(t * SR))] < 2) continue
        addBell(L, R, Math.round(t * SR), SR, r, { f: r.range(1150, 1350), amp: 0.25, pan: r.range(-0.3, 0.3), tau: 0.5 })
      }
    }
    new Fdn(SR, { size: 0.9, rt60: 0.45, damp: 0.55, predelayMs: 4 }).process(L, R, 0.15, 1)
    return finish(L, R, SR, -23 + (k - 0.55) * 8, -10)
  },
}

export default bed
