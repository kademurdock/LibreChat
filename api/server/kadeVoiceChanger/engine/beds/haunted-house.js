// beds/haunted-house.js - Inside an old house at night: creaks, wind, distant moans.
//
// This file also carries the spooky toolkit that the graveyard, dungeon,
// sailboat and submarine beds share (they import it from here).
//
// Techniques and published sources:
// - Creaks are stick-slip friction: a train of slip impulses whose rate
//   follows the sliding speed and pressure, with jitter, exciting a bank of
//   wood (or metal) resonances. This is the creaking-door design of Andy
//   Farnell, "Designing Sound" (MIT Press 2010), and the friction models of
//   Avanzini, Serafin and Rocchesso, "Interactive simulation of rigid body
//   interaction with friction-induced sound generation" (IEEE TSAP 2005).
//   A slow rate gives separate ticks (the "crrrk" of a floorboard); a fast
//   rate becomes the squeal of a hinge.
// - Moans are formant-filtered wind: breath noise plus a faint soft buzz,
//   through band passes that glide between the first two formants of "oo",
//   "oh" and "ah" (Peterson and Barney 1952 vowel formants), with a slow
//   pitch drift, far away and through the room.
// - Wind is pink noise under a gusting low pass with a narrow resonant howl
//   whose centre follows the gusts (Farnell, the wind chapter).
// - Footsteps on the floor above are low modal thumps through a ceiling low
//   pass; shutters are wood knocks; chains are runs of inharmonic metal-link
//   impacts (modal synthesis, van den Doel and Pai 1998); drips are Minnaert
//   bubble resonances that rise in pitch as they decay (van den Doel,
//   "Physically based models for liquid sounds", ACM TAP 2005); bells use
//   the classic church-bell partials (hum, prime, tierce, quint, nominal),
//   each split into a slowly beating pair.
// - The room is the shared feedback delay network (beds/car-highway.js).

import {
  setup, stereo, finish, clamp, dB, TAU, wander, noise, noisePair, norm, normPeak, addTo, bq, sweep, resBank,
  addPanned, addModes, addMode, addBurst, addTone, eventTimes, harmonicTable, oscInto, panL, panR, Fdn,
} from './car-highway.js'

// ------------------------------------------------------------------ spooky toolkit

export const WOOD = [[170, 5, 0.7], [410, 9, 1], [720, 12, 0.85], [1130, 15, 0.6], [1850, 18, 0.4], [2750, 20, 0.22]]
export const FLOOR = [[95, 4, 1], [210, 6, 0.9], [380, 8, 0.6], [640, 10, 0.4], [1050, 12, 0.2]]
export const METAL = [[530, 40, 0.6], [1270, 60, 1], [2140, 70, 0.7], [3350, 80, 0.45], [4900, 90, 0.25]]
export const HULL = [[38, 6, 1], [71, 9, 0.8], [118, 12, 0.6], [193, 16, 0.45], [310, 22, 0.3]]
export const ROPE = [[260, 6, 0.8], [600, 9, 1], [1100, 10, 0.6], [1900, 12, 0.3]]

/**
 * Stick-slip creak into L/R from sample i0. o: { dur=1 (s), rate0=30,
 * rate1=60 (slips per second at the start and end), peak (rate in the
 * middle, optional), wobble=0.25, modes=WOOD, jitter=0.12 (mode tuning
 * spread), amp=1, pan=0, rub=0.15 (friction hiss), tail=0.25 (s) }.
 */
export function addCreak(L, R, i0, sr, rng, o = {}) {
  const dur = Math.max(0.05, o.dur ?? 1)
  const tail = o.tail ?? 0.25
  const m = Math.round((dur + tail) * sr)
  const nd = Math.round(dur * sr)
  const src = new Float32Array(m)
  const r0 = o.rate0 ?? 30
  const r1 = o.rate1 ?? 60
  const pk = o.peak ?? (r0 + r1) / 2
  const wob = o.wobble ?? 0.25
  const wv = wander(nd, sr, 9, rng)
  let ph = rng.next()
  for (let i = 0; i < nd; i++) {
    const t = i / nd
    // rate along a curve through r0 -> peak -> r1
    const base = t < 0.5 ? r0 + (pk - r0) * Math.sin(Math.PI * t) : r1 + (pk - r1) * Math.sin(Math.PI * t)
    const rate = Math.max(2, base * (1 + wob * 0.5 * wv[i]))
    ph += rate / sr
    if (ph >= 1) {
      ph -= 1
      const env = Math.pow(Math.sin(Math.PI * t), 0.6)
      const a = env * (0.55 + 0.45 * rng.next())
      src[i] += a
      if (i + 1 < m) src[i + 1] -= a * 0.6
    }
  }
  const rub = o.rub ?? 0.15
  if (rub > 0) {
    for (let i = 0; i < nd; i++) {
      const env = Math.sin((Math.PI * i) / nd)
      src[i] += (rng.next() * 2 - 1) * env * rub * 0.08
    }
  }
  const jit = o.jitter ?? 0.12
  const modes = (o.modes || WOOD).map((md) => [md[0] * (1 + jit * (rng.next() * 2 - 1)), md[1], md[2]])
  const out = resBank(src, sr, modes)
  normPeak(out, 1)
  addPanned(L, R, out, i0, o.amp ?? 1, o.pan ?? 0)
}

/**
 * Formant-filtered wind moan. o: { dur=3, f0=170 (Hz), glide=-3 (semitones
 * over the moan), vowels=['oo','oh','oo'], breath=0.75 (noise share),
 * amp=1, pan=0, q=9, dark=2500 (low pass Hz) }.
 */
const VOWELS = { oo: [300, 870, 2240], oh: [520, 900, 2400], ah: [730, 1090, 2440], uh: [640, 1190, 2390], ee: [290, 2250, 2900] }
export function addMoan(L, R, i0, sr, rng, o = {}) {
  const dur = Math.max(0.3, o.dur ?? 3)
  const m = Math.round(dur * sr)
  const f0 = o.f0 ?? 170
  const glide = o.glide ?? -3
  const breath = clamp(o.breath ?? 0.75, 0, 1)
  const seq = (o.vowels || ['oo', 'oh', 'oo']).map((v) => VOWELS[v] || VOWELS.oo)
  const fr = new Float32Array(m)
  const drift = wander(m, sr, 1.5, rng)
  for (let i = 0; i < m; i++) {
    const t = i / m
    fr[i] = f0 * Math.pow(2, (glide * t + 0.4 * drift[i]) / 12) * (1 + 0.012 * Math.sin((TAU * 4.6 * i) / sr))
  }
  const voiced = new Float32Array(m)
  oscInto(voiced, sr, fr, 1, harmonicTable([1, 0.35, 0.18, 0.08, 0.04]), rng.next(), 5)
  const nz = noise(m, rng, 'pink')
  norm(nz, 1)
  norm(voiced, 1)
  const src = new Float32Array(m)
  for (let i = 0; i < m; i++) src[i] = nz[i] * breath + voiced[i] * (1 - breath) * 0.8
  const fAt = (k, i) => {
    const pos = (i / m) * (seq.length - 1)
    const a = Math.floor(pos)
    const b = Math.min(seq.length - 1, a + 1)
    const t = pos - a
    const s = t * t * (3 - 2 * t)
    return seq[a][k] + (seq[b][k] - seq[a][k]) * s
  }
  const q = o.q ?? 9
  const f1 = new Float32Array(src)
  const f2 = new Float32Array(src)
  sweep(f1, sr, 'bandpass', (i) => fAt(0, i), q)
  sweep(f2, sr, 'bandpass', (i) => fAt(1, i), q * 1.2)
  const out = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    const t = i / m
    const env = Math.pow(Math.sin(Math.PI * t), 1.4) * (1 + 0.15 * drift[i])
    out[i] = (f1[i] + 0.55 * f2[i]) * env
  }
  bq(out, sr, 'lowpass', o.dark ?? 2500, 0.707)
  normPeak(out, 1)
  addPanned(L, R, out, i0, o.amp ?? 1, o.pan ?? 0)
}

/**
 * Gusting wind as a stereo pair. o: { strength=0.5, gust=0.6, howl=0.4,
 * dark=1 (1 = outdoors bright enough, smaller = heard through walls),
 * rate=0.12 (gusts per second) }.
 */
export function windPair(n, sr, rng, o = {}) {
  const st = clamp(o.strength ?? 0.5, 0, 1)
  const gu = clamp(o.gust ?? 0.6, 0, 1)
  const howl = clamp(o.howl ?? 0.4, 0, 1)
  const dark = clamp(o.dark ?? 1, 0.1, 1.5)
  const [a, b] = noisePair(n, rng.fork('wn'), 'pink', 0.35)
  const g1 = wander(n, sr, o.rate ?? 0.12, rng.fork('g1'))
  const g2 = wander(n, sr, (o.rate ?? 0.12) * 3.1, rng.fork('g2'))
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const g = 0.5 + 0.5 * g1[i]
    env[i] = clamp(0.48 + 0.52 * (gu * (0.75 * g + 0.25 * (0.5 + 0.5 * g2[i])) + (1 - gu) * 0.6), 0.05, 1.2)
  }
  const fc = (i) => (180 + (700 + 900 * st) * env[i]) * dark
  sweep(a, sr, 'lowpass', fc, 0.8)
  sweep(b, sr, 'lowpass', (i) => fc(i) * 0.93, 0.8)
  for (let i = 0; i < n; i++) {
    a[i] *= env[i] * Math.sqrt(env[i])
    b[i] *= env[i] * Math.sqrt(env[i])
  }
  norm(a, 1)
  norm(b, 1)
  if (howl > 0) {
    const h = noise(n, rng.fork('howl'), 'pink')
    const hc = (i) => (380 + 520 * env[i] + 120 * g2[i]) * Math.min(1, dark * 1.2)
    sweep(h, sr, 'bandpass', hc, 18)
    for (let i = 0; i < n; i++) {
      const e = env[i]
      h[i] *= e * e * e
    }
    norm(h, 1)
    const g = 0.75 * howl
    for (let i = 0; i < n; i++) {
      a[i] += h[i] * g * (0.6 + 0.4 * g1[i])
      b[i] += h[i] * g * (0.6 - 0.4 * g1[i])
    }
  }
  return [a, b, env]
}

/** Steps on the floor above or in another room. o: { steps=6, rate=1.8 (per s), amp, pan0, pan1, heavy=1 }. */
export function addFootsteps(L, R, t0, sr, rng, o = {}) {
  const steps = o.steps ?? 6
  const per = 1 / (o.rate ?? 1.8)
  const heavy = o.heavy ?? 1
  for (let k = 0; k < steps; k++) {
    const t = t0 + k * per * rng.range(0.92, 1.08)
    const pan = (o.pan0 ?? -0.5) + ((o.pan1 ?? 0.5) - (o.pan0 ?? -0.5)) * (k / Math.max(1, steps - 1))
    const i0 = Math.round(t * sr)
    const a = (o.amp ?? 1) * rng.range(0.75, 1.1) * (k % 2 ? 0.9 : 1)
    addModes(L, R, i0, sr, [[rng.range(55, 70) * heavy, 0.06, 1], [rng.range(110, 140), 0.035, 0.6], [rng.range(230, 280), 0.02, 0.3]], a, pan, rng)
    addBurst(L, R, i0, sr, rng, { amp: a * 0.5, pan, tau: 0.02, f: 300, q: 0.7, type: 'lowpass' })
    if (rng.next() < 0.3) addCreak(L, R, i0 + Math.round(0.02 * sr), sr, rng, { dur: rng.range(0.15, 0.35), rate0: 25, rate1: 45, modes: FLOOR, amp: a * 0.5, pan })
  }
}

/** A run of chain-link clinks. o: { links=8, amp=1, pan=0, heavy=0 (0 light .. 1 heavy), spread=0.06 (s), drag=0.3 }. */
export function addChain(L, R, t0, sr, rng, o = {}) {
  const links = o.links ?? 8
  const heavy = clamp(o.heavy ?? 0, 0, 1)
  const base = 2600 - 1500 * heavy
  let t = t0
  for (let k = 0; k < links; k++) {
    const f = base * rng.range(0.8, 1.25)
    const a = (o.amp ?? 1) * rng.range(0.3, 1) * (k === 0 ? 1.2 : 1)
    const pan = (o.pan ?? 0) + rng.range(-0.15, 0.15)
    const i0 = Math.round(t * sr)
    addModes(L, R, i0, sr, [[f, 0.05 + 0.05 * heavy, 1], [f * 2.71, 0.03, 0.6], [f * 5.2, 0.015, 0.35], [f * 0.53, 0.06, 0.25]], a * 0.5, pan, rng)
    addBurst(L, R, i0, sr, rng, { amp: a * 0.6, pan, tau: 0.0012, f: 5000, q: 0.6, type: 'highpass' })
    t += (o.spread ?? 0.06) * rng.range(0.25, 1.6)
  }
  if ((o.drag ?? 0.3) > rng.next()) {
    addBurst(L, R, Math.round(t0 * sr), sr, rng, { amp: (o.amp ?? 1) * 0.25, pan: o.pan ?? 0, attack: 0.08, hold: (t - t0) * 0.6, tau: 0.1, f: 3200, q: 0.9 })
  }
}

/** One water drop into a pool: a Minnaert bubble whose pitch rises as it rings. o: { f=1600, amp=1, pan=0, rise=30 }. */
export function addDrip(L, R, i0, sr, rng, o = {}) {
  const f0 = o.f ?? 1600
  const damp = 0.043 * f0 + 0.0014 * Math.pow(f0, 1.5)
  const tau = clamp(1.6 / damp, 0.004, 0.06)
  const rise = o.rise ?? 30
  addTone(L, R, i0, sr, { f: (t) => f0 * (1 + rise * t), attack: 0.0006, hold: 0, tau, amp: o.amp ?? 1, pan: o.pan ?? 0 })
  addBurst(L, R, i0, sr, rng, { amp: (o.amp ?? 1) * 0.25, pan: o.pan ?? 0, tau: 0.0008, f: 4000, q: 0.8 })
}

/** A church bell stroke. o: { f=220 (prime), amp=1, pan=0, tau=4 (s, hum decay) }. */
const BELL = [[0.5, 1.0, 0.55], [1.0, 0.7, 0.8], [1.19, 0.5, 0.6], [1.5, 0.38, 0.35], [2.0, 0.42, 0.7], [2.5, 0.25, 0.3], [2.66, 0.22, 0.25], [3.01, 0.18, 0.2], [4.0, 0.12, 0.12]]
export function addBell(L, R, i0, sr, rng, o = {}) {
  const f = o.f ?? 220
  const tau = o.tau ?? 4
  const amp = o.amp ?? 1
  const pan = o.pan ?? 0
  const modes = []
  for (const [ratio, tScale, g] of BELL) {
    const beat = rng.range(0.4, 1.6)
    modes.push([f * ratio, tau * tScale, g * 0.6])
    modes.push([f * ratio + beat, tau * tScale * 0.95, g * 0.4])
  }
  addModes(L, R, i0, sr, modes, amp * 0.3, pan, rng)
  addBurst(L, R, i0, sr, rng, { amp: amp * 0.08, pan, tau: 0.004, f: 2500, q: 0.6 })
}

/** An owl's call far off: hoo, h'hoo, hoo, hoo. o: { f=330, amp=1, pan=0 }. */
export function addOwl(L, R, t0, sr, rng, o = {}) {
  const f = (o.f ?? 330) * rng.range(0.94, 1.06)
  const pat = [[0, 0.32, 1], [0.52, 0.13, 0.75], [0.7, 0.26, 0.9], [1.22, 0.42, 1], [1.86, 0.4, 0.85]]
  const tb = harmonicTable([1, 0.12, 0.05])
  for (const [dt, len, g] of pat) {
    const i0 = Math.round((t0 + dt) * sr)
    addTone(L, R, i0, sr, { f: (t) => f * (1 + 0.05 * Math.exp(-t * 12)) * (1 - 0.04 * t), attack: 0.05, hold: len * 0.6, tau: len * 0.18, amp: (o.amp ?? 1) * g, pan: o.pan ?? 0, table: tb, maxHarm: 3 })
  }
}

/** A chorus of distant crickets (field-cricket chirps of three or four pulses). o: { count=4, amp=1, dur }. */
export function addCrickets(L, R, sr, rng, o = {}) {
  const dur = o.dur ?? L.length / sr
  const count = o.count ?? 4
  for (let c = 0; c < count; c++) {
    const f = rng.range(4200, 5200)
    const period = rng.range(0.45, 0.9)
    const pulses = 3 + rng.int(2)
    const pan = rng.range(-0.85, 0.85)
    const amp = (o.amp ?? 1) * rng.range(0.4, 1)
    let t = rng.range(0, period)
    let on = true
    while (t < dur) {
      // crickets pause now and then
      if (rng.next() < 0.04) on = !on
      if (on) {
        for (let k = 0; k < pulses; k++) {
          addTone(L, R, Math.round((t + k * 0.034) * sr), sr, { f: f * rng.range(0.995, 1.005), attack: 0.003, hold: 0.011, tau: 0.004, amp, pan })
        }
      }
      t += period * rng.range(0.96, 1.04)
    }
  }
}

// ------------------------------------------------------------------ the haunted house bed

const SIZES = {
  small: { size: 0.8, rt60: 1.0, damp: 0.55, wet: 0.22 },
  mansion: { size: 1.6, rt60: 2.0, damp: 0.5, wet: 0.32 },
  hall: { size: 2.6, rt60: 3.2, damp: 0.45, wet: 0.42 },
}

const bed = {
  id: 'haunted-house',
  name: 'Haunted house',
  group: 'spooky',
  about: 'An old house at night: creaking doors and floors, steps upstairs, wind at the windows and far-off moans.',
  params: [
    { id: 'intensity', name: 'How much happens', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 85] },
    { id: 'wind', name: 'Wind outside', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [20, 90] },
    { id: 'moans', name: 'Distant moans', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
    {
      id: 'size',
      name: 'House',
      type: 'choice',
      def: 'mansion',
      options: [
        { v: 'small', name: 'A small cottage' },
        { v: 'mansion', name: 'A big old mansion' },
        { v: 'hall', name: 'An empty great hall' },
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
    const act = q.intensity / 100
    const room = SIZES[q.size] || SIZES.mansion
    const dur = s.dur

    // the dry events go into ev, then through the room; the wind stays mostly outside
    const EL = new Float32Array(n)
    const ER = new Float32Array(n)

    // door creaks: long glides
    for (const t of eventTimes(0.03 + 0.12 * act, dur, r.fork('door'), 3, -0.5)) {
      const d = r.range(0.9, 2.6)
      const r0 = r.range(14, 40)
      addCreak(EL, ER, Math.round(Math.max(0, t) * SR), SR, r, {
        dur: d, rate0: r0, peak: r0 * r.range(1.5, 4.5), rate1: r.range(12, 60), wobble: 0.35, modes: WOOD,
        amp: r.range(0.5, 1), pan: r.range(-0.8, 0.8),
      })
    }
    // floorboards: short, lower
    for (const t of eventTimes(0.05 + 0.2 * act, dur, r.fork('floor'), 1.2)) {
      addCreak(EL, ER, Math.round(t * SR), SR, r, {
        dur: r.range(0.2, 0.7), rate0: r.range(18, 35), peak: r.range(30, 70), rate1: r.range(15, 40), modes: FLOOR, wobble: 0.3,
        amp: r.range(0.35, 0.8), pan: r.range(-0.7, 0.7),
      })
    }
    // someone walking upstairs
    for (const t of eventTimes(0.006 + 0.03 * act, dur - 2, r.fork('steps'), 8)) {
      const steps = 4 + r.int(6)
      const rate = r.range(1.5, 2.1)
      const m = Math.round((steps / rate + 1.2) * SR)
      const fl = new Float32Array(m)
      const fr = new Float32Array(m)
      const p0 = r.range(-0.9, 0.9)
      addFootsteps(fl, fr, 0.01, SR, r, { steps, rate, amp: 0.9, pan0: p0, pan1: clamp(p0 + r.range(-1, 1), -0.9, 0.9) })
      bq(fl, SR, 'lowpass', 500, 0.7)
      bq(fr, SR, 'lowpass', 500, 0.7)
      addTo(EL, fl, 1, Math.round(t * SR))
      addTo(ER, fr, 1, Math.round(t * SR))
    }
    // a loose shutter knocking in the gusts
    const windAmt = q.wind / 100
    for (const t of eventTimes(0.02 + 0.07 * act * windAmt, dur, r.fork('shutter'), 4)) {
      const knocks = 1 + r.int(3)
      const pan = r.range(-0.9, 0.9)
      let tt = t
      for (let k = 0; k < knocks; k++) {
        const i0 = Math.round(tt * SR)
        const a = r.range(0.5, 1) * (k ? 0.6 : 1)
        addModes(EL, ER, i0, SR, [[r.range(140, 180), 0.05, 1], [r.range(430, 520), 0.03, 0.7], [r.range(1100, 1300), 0.012, 0.4]], a * 0.8, pan, r)
        addBurst(EL, ER, i0, SR, r, { amp: a * 0.6, pan, tau: 0.006, f: 900, q: 0.6 })
        tt += r.range(0.1, 0.3)
      }
    }
    // the far door slam, rarely
    for (const t of eventTimes(0.004 + 0.012 * act, dur, r.fork('slam'), 15)) {
      const i0 = Math.round(t * SR)
      const pan = r.range(-0.6, 0.6)
      addModes(EL, ER, i0, SR, [[r.range(55, 70), 0.12, 1], [r.range(120, 150), 0.07, 0.6], [r.range(300, 380), 0.04, 0.3]], 1.4, pan, r)
      addBurst(EL, ER, i0, SR, r, { amp: 0.9, pan, tau: 0.03, f: 250, q: 0.7, type: 'lowpass' })
    }
    // distant moans
    const moanAmt = q.moans / 100
    if (moanAmt > 0) {
      for (const t of eventTimes(0.02 + 0.08 * moanAmt, dur, r.fork('moan'), 4, -1)) {
        const d = r.range(2.2, 5)
        addMoan(EL, ER, Math.round(Math.max(0, t) * SR), SR, r, {
          dur: d, f0: r.range(140, 260), glide: r.range(-5, 2), vowels: r.pick([['oo', 'oh', 'oo'], ['oo', 'ah', 'oh'], ['uh', 'oo'], ['oh', 'oo', 'oo']]),
          breath: r.range(0.55, 0.85), pan: r.range(-0.8, 0.8), dark: 1800, amp: 0.55 + 0.6 * moanAmt,
        })
      }
    }
    new Fdn(SR, { size: room.size, rt60: room.rt60, damp: room.damp, predelayMs: 12 }).process(EL, ER, room.wet, 1)

    // wind outside, heard through old windows
    if (windAmt > 0) {
      const [wl, wr] = windPair(n, SR, r.fork('wind'), { strength: windAmt, gust: 0.75, howl: 0.25 + 0.6 * windAmt, dark: 0.75, rate: 0.1 })
      const g = dB(-7 + 10 * windAmt)
      addTo(L, wl, g)
      addTo(R, wr, g)
    }
    // the house's own hush
    const [hl, hr] = noisePair(n, r.fork('hush'), 'brown', 0.5)
    bq(hl, SR, 'lowpass', 200, 0.7)
    bq(hr, SR, 'lowpass', 200, 0.7)
    norm(hl, 0.015)
    norm(hr, 0.015)
    addTo(L, hl)
    addTo(R, hr)
    addTo(L, EL, 1.2)
    addTo(R, ER, 1.2)
    return finish(L, R, SR, -24 + (act - 0.5) * 6, -14)
  },
}

export default bed
