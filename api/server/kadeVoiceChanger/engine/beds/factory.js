// beds/factory.js - Factory floor: a pounding press, a rattling conveyor, motors humming, bursts of air.
//
// This file also holds the machine sounds other place beds borrow (motor
// hum, fans, air blasts, reversing beepers). Techniques and their sources:
// - Electric motors: a mains-locked hum at 60 Hz and its harmonics from
//   magnetostriction and pole passing, the shaft's rotation rate and its
//   harmonics from imbalance, and a faint bearing whine (the machinery noise
//   picture of Harris and Piersol, "Shock and Vibration Handbook").
// - Fans: broadband turbulent noise with tones at the blade-pass frequency
//   (rpm / 60 times the number of blades) and its harmonics, drifting
//   slightly as speed controllers hunt (Bies and Hansen, "Engineering Noise
//   Control", the fan noise chapter).
// - Machines with cycles are built as events on their own clocks: a
//   mechanical press strikes once per stroke (a body thump, a ring of steel
//   from modal synthesis, the pneumatic clutch and the part falling into a
//   bin), never as a looped recording, so strokes vary in strength and
//   timing by small amounts as real ones do; a second press runs at its own
//   rate, so the floor never settles into one repeating bar.
// - Conveyor chains are a fast periodic rattle with random link strengths;
//   compressed air is a turbulent jet hiss; a reversing forklift beeps at
//   about a kilohertz as it passes.
// - The hall: a big hard metal space with ringing modes, decay set by the
//   hall size.

import {
  makeScene, emptyBed, finish, roomTone, emit, emitPath, makeTalker, speech, voiceAtRate, poisson, logRange,
  clamp, filt, strike, thump, noiseBurst, tone, buf, addAt, seed32, sinePhasor, passPath, squareParts, trim,
  TAU, harmonicTable, periodic,
} from './cafe.js'

/**
 * Motor hum: mains harmonics, shaft rotation and a bearing whine.
 * o: { mains (Hz, 60), rot (shaft Hz), harm: [[multiple of mains, level]...], whine (Hz), whineLevel, rough }
 */
export function motorHum(sr, rng, dur, o = {}) {
  const n = Math.max(2, Math.ceil(dur * sr))
  const out = new Float32Array(n)
  const mains = o.mains ?? 60
  const harm = o.harm || [[1, 0.5], [2, 1], [3, 0.3], [4, 0.35], [6, 0.15]]
  const mt = harmonicTable(harm.map(([k, a]) => [k, a, rng.range(0, TAU)]))
  periodic(n, sr, mains * (1 + rng.gauss() * 0.0005), mt, rng.next(), 0.0008, out, 1)
  if (o.rot) {
    const rt = harmonicTable([[1, 0.6, rng.range(0, TAU)], [2, 0.3, rng.range(0, TAU)], [3, 0.12, rng.range(0, TAU)]])
    periodic(n, sr, o.rot, rt, rng.next(), 0.002, out, o.rotLevel ?? 0.6)
  }
  if (o.whine) {
    periodic(n, sr, o.whine, harmonicTable([[1, 1, rng.range(0, TAU)]]), rng.next(), 0.003, out, o.whineLevel ?? 0.05)
  }
  const rough = o.rough ?? 0.2
  if (rough > 0) {
    let s = seed32(rng)
    let lp = 0
    const g = 1 - Math.exp((-TAU * 400) / sr)
    for (let i = 0; i < n; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      lp += (s / 2147483648 - lp) * g
      out[i] += lp * rough * 2
    }
  }
  return out
}

/**
 * A fan or blower: broadband noise plus blade-pass tones.
 * o: { bpf (Hz), tones (harmonics count), toneLevel, color: filter list, drift }
 */
export function fanSound(sr, rng, dur, o = {}) {
  const n = Math.max(2, Math.ceil(dur * sr))
  const out = new Float32Array(n)
  let s = seed32(rng)
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = s / 2147483648
  }
  filt(out, sr, o.color || [['lowpass', 2500, 0.6], ['peak', 500, 0.7, 3], ['highpass', 60, 0.7]])
  let e = 0
  for (let i = 0; i < n; i++) e += out[i] * out[i]
  const g = e > 0 ? 1 / Math.sqrt(e / n) : 0
  for (let i = 0; i < n; i++) out[i] *= g
  if (o.bpf) {
    const tl = o.toneLevel ?? 0.15
    const nt = o.tones ?? 3
    for (let k = 1; k <= nt; k++) {
      const t = sinePhasor(n, sr, o.bpf * k, rng.range(0, TAU), o.drift ?? 0.004)
      const a = tl / k
      for (let i = 0; i < n; i++) out[i] += t[i] * a
    }
  }
  return out
}

/** A blast of compressed air: a turbulent jet hiss with a sharp start. */
export function airBlast(sr, rng, dur) {
  const out = noiseBurst(sr, rng, dur, { att: 0.004, dec: dur * 0.6, hz: rng.range(3000, 5000), q: 0.5, hz2: 12000 })
  addAt(out, noiseBurst(sr, rng, 0.05, { att: 0.001, dec: 0.01, hz: 1500, q: 0.7 }), 0, 0.5)
  return out
}

/** Reversing beeper: beeps of about a kilohertz, half a second on, half off. */
export function beeperRun(sr, rng, dur, o = {}) {
  const out = buf(sr, dur + 0.1)
  const hz = o.hz ?? rng.range(1000, 1250)
  const b = tone(sr, hz, o.on ?? 0.45, { partials: squareParts(4, 0.4), att: 0.01, rel: 0.02 })
  const per = o.period ?? 1
  for (let t = 0; t < dur; t += per) addAt(out, b, t * sr, 0.5)
  return out
}

/** A fast chain rattle: periodic link clicks with random strengths. */
export function chainRattle(sr, rng, dur, rate) {
  const out = buf(sr, dur)
  const click = noiseBurst(sr, rng, 0.006, { att: 0.0003, dec: 0.0012, hz: 2500, q: 1.2 })
  const click2 = thump(sr, rng, 400, 0.004, { noise: 0.3 })
  let t = rng.next() / rate
  let k = 0
  while (t < dur) {
    const a = rng.range(0.3, 1)
    addAt(out, k % 2 ? click : click2, t * sr, a)
    t += (1 / rate) * (1 + rng.gauss() * 0.02)
    k++
  }
  return out
}

/** One stroke of a mechanical press. */
function pressStroke(sr, rng, size) {
  const out = buf(sr, 2.2)
  // pneumatic clutch valve
  addAt(out, noiseBurst(sr, rng, 0.08, { att: 0.001, dec: 0.02, hz: 3500, q: 0.8 }), 0, 0.4)
  addAt(out, thump(sr, rng, 180, 0.015, { noise: 0.6, noiseHz: 1500 }), 0, 0.4)
  // the ram comes down
  const tHit = 0.18
  addAt(out, noiseBurst(sr, rng, 0.18, { att: 0.12, dec: 0.03, hz: 400, q: 0.6 }), 0.02 * sr, 0.3)
  addAt(out, thump(sr, rng, rng.range(38, 52) / size, 0.12, { noise: 1, noiseHz: 900, drop: 0.8 }), tHit * sr, 1.5)
  addAt(out, strike(sr, rng, 'metal', { size: 2.4 * size, hard: 4000, tick: 1.2 }), tHit * sr, 0.6)
  addAt(out, strike(sr, rng, 'bar', { size: 1.6 * size, hard: 3000, tick: 0.3 }), tHit * sr, 0.25)
  // air exhaust and the part dropping into the bin
  addAt(out, airBlast(sr, rng, 0.35), (tHit + 0.25) * sr, 0.25)
  let t = tHit + rng.range(0.5, 0.7)
  for (let k = 0; k < 2 + rng.int(3); k++) {
    addAt(out, strike(sr, rng, 'metal', { size: 0.7, hard: 6000, tick: 0.8, maxSec: 0.5 }), t * sr, 0.2 * Math.pow(0.7, k))
    t += rng.range(0.05, 0.15)
  }
  return trim(out)
}

/** A press running at bpm strokes a minute from t0 to t1. */
function press(sc, rng, bpm, pan, d, g, size) {
  const per = 60 / clamp(bpm, 5, 200)
  const strokes = []
  for (let i = 0; i < 4; i++) strokes.push(pressStroke(sc.sr, rng, size))
  let t = -rng.next() * per
  let drift = 0
  while (t < sc.dur) {
    emit(sc, strokes[rng.int(strokes.length)], t * sc.sr, pan, d, g * rng.range(0.85, 1.1))
    drift = drift * 0.9 + rng.gauss() * 0.004
    t += per * (1 + drift)
    // now and then the operator pauses to load a sheet
    if (rng.chance(0.04)) t += rng.range(2, 6)
  }
  // the flywheel motor never stops
  const hum = motorHum(sc.sr, rng, sc.dur + 0.5, { rot: rng.range(14, 22), rotLevel: 0.8, whine: rng.range(1800, 2600), whineLevel: 0.03, rough: 0.3 })
  emit(sc, hum, 0, pan, d, g * 0.08)
}

/** A forklift backing and driving past with its beeper. */
function forklift(sc, rng, t) {
  const sr = sc.sr
  const speed = rng.range(1.5, 3)
  const dir = rng.chance(0.5) ? 1 : -1
  const x0 = -dir * rng.range(10, 20)
  const close = rng.range(4, 12)
  const dur = (Math.abs(x0) * 2) / speed
  const sig = beeperRun(sr, rng, dur)
  const motor = sinePhasor(sig.length, sr, rng.range(300, 500), 0, 0.02)
  for (let i = 0; i < sig.length; i++) sig[i] = sig[i] * 0.6 + motor[i] * 0.04
  addAt(sig, noiseBurst(sr, rng, dur, { att: 0.5, dec: 1e6, hz: 250, q: 0.7, rel: 0.5 }), 0, 0.2)
  const path = passPath(x0, dir * speed, close, 1)
  emitPath(sc, sig, t * sr, (tt, p) => path(tt - t, p), 1.6)
}

/** A spot welder: a short fat buzz with a crackle. */
function spotWeld(sr, rng) {
  const dur = rng.range(0.15, 0.5)
  const out = buf(sr, dur + 0.05)
  let s = seed32(rng)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const hum = Math.sin(TAU * 120 * t)
    const cr = (s >>> 0) < 0.02 * 4294967296 ? (s / 2147483648) * 4 : 0
    const e = t < dur ? Math.min(1, t / 0.005) : 0
    out[i] = (Math.sign(hum) * Math.min(1, Math.abs(hum) * 3) * 0.4 + (s / 2147483648) * 0.3 * Math.abs(hum) + cr) * e
  }
  filt(out, sr, [['highpass', 100, 0.7], ['peak', 3000, 1, 4]])
  return out
}

const bed = {
  id: 'factory',
  name: 'Factory floor',
  group: 'places',
  about: 'A factory floor: a pounding press, a rattling conveyor, motors humming, and bursts of compressed air.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 95] },
    { id: 'tempo', name: 'Press beats', type: 'number', min: 10, max: 120, step: 1, def: 40, unit: 'bpm', rand: [20, 80] },
    { id: 'size', name: 'Hall size', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 100] },
    { id: 'air', name: 'Air bursts', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'distance', name: 'Distance from the machines', type: 'number', min: 2, max: 30, step: 1, def: 6, unit: 'meters', rand: [3, 15] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.2, airHz: 15000, airM: 18, roomR: 30 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const busy = q.intensity / 100
    const size = q.size / 100
    const d0 = q.distance
    roomTone(sc, r.fork('hall'), { db: -40 + busy * 6, color: [['lowpass', 1500, 0.7], ['peak', 120, 1, 6]], rumbleDb: -38 + busy * 4, rumbleHz: 80, hum: [[60, -56], [120, -52], [180, -62], [240, -64]], drift: 0.2, corr: 0.3 })
    // the main press and a second one farther off
    const pr = r.fork('press')
    press(sc, pr.fork('a'), q.tempo, pr.range(-0.5, 0.5), d0, 3.2, 1)
    if (busy > 0.2) press(sc, pr.fork('b'), q.tempo * pr.pick([0.62, 0.75, 1.33, 1.5]), pr.range(-0.95, 0.95), d0 * 2.5 + 6, 2.5, 0.8)
    // the conveyor line
    const cv = r.fork('conveyor')
    const cPan = cv.range(-0.9, 0.9)
    const cd = d0 * 0.8 + 2
    emit(sc, chainRattle(sc.sr, cv, sc.dur + 0.5, cv.range(16, 26)), 0, cPan, cd, 0.12 * (0.5 + busy))
    emit(sc, motorHum(sc.sr, cv, sc.dur + 0.5, { rot: cv.range(25, 30), rough: 0.6 }), 0, cPan, cd, 0.06)
    for (const t of poisson(cv, 0.3 + busy * 0.6, -1, sc.dur)) {
      const a = thump(sc.sr, cv, cv.range(90, 160), 0.04, { noise: 0.6, noiseHz: 900 })
      addAt(a, strike(sc.sr, cv, 'tray', { size: 1.4, hard: 3000, tick: 0.5, maxSec: 0.5 }), 0, 0.2)
      emit(sc, a, t * sc.sr, clamp(cPan + cv.range(-0.3, 0.3), -1, 1), cd * cv.range(0.8, 1.4), 0.5)
    }
    // the hydraulic unit and the air compressor
    const hy = r.fork('hydraulic')
    const pump = motorHum(sc.sr, hy, sc.dur + 0.5, { harm: [[1, 0.3], [2, 0.5]], rot: 29.2, rotLevel: 0.3, whine: hy.range(240, 300), whineLevel: 0.5, rough: 0.4 })
    emit(sc, pump, 0, hy.range(-0.9, 0.9), d0 * 2 + 5, 0.4)
    emit(sc, fanSound(sc.sr, hy, sc.dur + 0.5, { bpf: hy.range(90, 140), tones: 4, toneLevel: 0.3, color: [['lowpass', 1800, 0.6], ['peak', 300, 0.7, 4], ['highpass', 40, 0.7]] }), 0, hy.range(-0.9, 0.9), 25, 2.5)
    // air bursts
    const ar = r.fork('air')
    for (const t of poisson(ar, (q.air / 100) * (0.1 + busy * 0.4), -1, sc.dur)) {
      const a = airBlast(sc.sr, ar, ar.range(0.15, 1.2))
      emit(sc, a, t * sc.sr, ar.range(-0.95, 0.95), logRange(ar, d0 * 0.6 + 1, d0 * 3 + 10), 1.1)
    }
    // forklifts, welders, dropped parts, a call across the floor
    const fl = r.fork('forklift')
    for (const t of poisson(fl, 0.01 + busy * 0.02, -15, sc.dur)) forklift(sc, fl.fork('f' + Math.round(t * 100)), t)
    const wl = r.fork('weld')
    const wPan = wl.range(-0.9, 0.9)
    for (const t of poisson(wl, busy * 0.12, 0, sc.dur)) emit(sc, spotWeld(sc.sr, wl), t * sc.sr, wPan, d0 * 1.5 + 4, 0.6)
    const dp = r.fork('drops')
    for (const t of poisson(dp, 0.04 + busy * 0.1, 0, sc.dur)) {
      emit(sc, strike(sc.sr, dp, dp.chance(0.5) ? 'bar' : 'metal', { size: dp.range(0.7, 1.6), hard: 5000, tick: 1 }), t * sc.sr, dp.range(-0.95, 0.95), logRange(dp, 4, 30), 0.5)
    }
    const sh = r.fork('shouts')
    for (const t of poisson(sh, 0.01 + busy * 0.03, -1, sc.dur)) {
      const T = makeTalker(sh, 'man', { effort: 0.95 })
      emit(sc, voiceAtRate(sc, T, speech(T, sh, 1, { effort: 0.95, syl: [2, 4] }).fr), t * sc.sr, sh.range(-0.9, 0.9), logRange(sh, 6, 25), 2.4)
    }
    const rs = 1.4 + size * 1.6
    return finish(sc, { size: rs, rt60: 1.5 + size * 1.5, rt60High: 0.8 + size * 0.6, predelayMs: 10 + size * 15, wet: 0.9 }, -22 + (q.intensity - 50) * 0.06)
  },
}

export default bed
