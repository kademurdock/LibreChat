// beds/fridge-hum.js - Refrigerator hum: a fridge in a quiet kitchen at night, clicks, gurgles, the odd ice drop.
//
// Techniques and their published sources:
// - The compressor: an induction motor turning just under mains speed
//   (slip puts it near 58 to 59 Hz on a 60 Hz supply) with harmonics from
//   the piston, beside the 120 Hz magnetic hum of the windings; the two
//   rates sit close, so the hum has a slow beat (the motor-noise picture of
//   Harris and Piersol, "Shock and Vibration Handbook"). An old fridge is
//   louder, richer in harmonics, and its loose panels buzz against the
//   cabinet, a rattle that comes and goes.
// - The thermostat: when the compressor starts there is a relay click, a
//   thump as the motor takes the load and the hum rising in; when it stops,
//   a click and a shudder as it spins down.
// - Refrigerant moving through the tubing gurgles and trickles: clusters
//   of small bubble tones (Minnaert 1933, "On musical air-bubbles and the
//   sounds of running water") over a faint hiss; the plastic liner ticks as
//   it cools.
// - The ice maker drops a tray of cubes into its bin (short hard clacks,
//   modal synthesis) and refills with the buzz of a water valve and the
//   hiss of water rising in pitch as it fills.
// - The evaporator fan whirs softly inside, the condenser fan under the
//   cabinet; the kitchen is small and quiet.

import {
  makeScene, emptyBed, finish, roomTone, emit, poisson, logRange, filt, strike, thump, noiseBurst, modal, buf,
  addAt, seed32, trim, harmonicTable, periodic, drifting, TAU,
} from './cafe.js'
import { fanSound } from './factory.js'

/** A cluster of refrigerant gurgles. */
function gurgle(sr, rng) {
  const dur = rng.range(0.6, 2.5)
  const out = buf(sr, dur + 0.1)
  const n = 6 + rng.int(20)
  for (let k = 0; k < n; k++) {
    const t = rng.next() * dur
    const f0 = logRange(rng, 500, 2600)
    const len = Math.round(rng.range(0.008, 0.03) * sr)
    const off = Math.round(t * sr)
    let ph = 0
    const rise = rng.range(1, 4)
    const tau = rng.range(0.004, 0.012)
    for (let i = 0; i < len && off + i < out.length; i++) {
      const tt = i / sr
      ph += (TAU * f0 * (1 + rise * tt)) / sr
      out[off + i] += Math.sin(ph) * Math.exp(-tt / tau) * (1 - Math.exp(-tt / 0.0008)) * rng.range(0.4, 1)
    }
  }
  addAt(out, noiseBurst(sr, rng, dur, { att: dur * 0.3, dec: dur * 0.4, hz: 2500, q: 0.6 }), 0, 0.08)
  return out
}

/** The ice maker: the cubes drop, then the water valve refills the tray. */
function iceHarvest(sc, rng, t, pan, d) {
  const sr = sc.sr
  // gear motor turning the tray
  const motor = periodic(Math.round(2.5 * sr), sr, rng.range(260, 340), harmonicTable([[1, 1], [2, 0.4], [3, 0.2]]), 0, 0.01)
  for (let i = 0; i < motor.length; i++) motor[i] *= Math.min(1, i / 2000) * Math.min(1, (motor.length - i) / 2000)
  emit(sc, motor, t * sr, pan, d, 0.01)
  // the cubes fall into the bin
  let tt = t + 2.6
  const n = 6 + rng.int(6)
  for (let k = 0; k < n; k++) {
    const a = strike(sr, rng, 'ice', { hard: 9000, tick: 1.2 })
    addAt(a, thump(sr, rng, rng.range(150, 260), 0.02, { noise: 0.5, noiseHz: 1500 }), 0, 0.4)
    emit(sc, trim(a), tt * sr, pan, d, rng.range(0.08, 0.2))
    tt += k < 3 ? rng.range(0.01, 0.05) : rng.range(0.03, 0.15)
  }
  // the valve buzzes and water hisses as the tray fills
  const fill = rng.range(4, 7)
  const t2 = tt + rng.range(1, 3)
  const valve = periodic(Math.round(fill * sr), sr, 120, harmonicTable([[1, 1], [2, 0.3], [3, 0.4]]), 0, 0)
  const water = noiseBurst(sr, rng, fill, { att: 0.2, dec: 1e6, hz: 1800, q: 1, rel: 0.2 })
  for (let i = 0; i < valve.length; i++) valve[i] = valve[i] * 0.02 * Math.min(1, i / 500) * Math.min(1, (valve.length - i) / 500) + water[i] * 0.08
  emit(sc, valve, t2 * sr, pan, d, 0.5)
}

const bed = {
  id: 'fridge-hum',
  name: 'Refrigerator hum',
  group: 'places',
  about: 'A refrigerator humming in a quiet kitchen at night, with clicks, gurgles and the odd drop of ice.',
  params: [
    { id: 'intensity', name: 'Hum', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 85] },
    {
      id: 'age',
      name: 'Fridge',
      type: 'choice',
      def: 'new',
      options: [
        { v: 'new', name: 'A quiet new one' },
        { v: 'old', name: 'A rattly old one' },
      ],
    },
    { id: 'ice', name: 'Ice maker', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'distance', name: 'Distance from the fridge', type: 'number', min: 0.5, max: 6, step: 0.5, def: 2, unit: 'meters', rand: [1, 4] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.4, airHz: 16000, airM: 8, roomR: 4 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const old = q.age === 'old'
    const level = 0.3 + q.intensity / 100
    const pan = r.range(-0.3, 0.3)
    const d = q.distance
    const sr2 = sc.sr
    const len = sc.dur + 0.3
    const n = Math.ceil(len * sr2)
    roomTone(sc, r.fork('kitchen'), { db: -64, color: [['lowpass', 900, 0.7]], drift: 0.1, corr: 0.4 })
    // when is the compressor running?
    const cy = r.fork('cycle')
    // runs of five to fifteen minutes, rests of two to eight; a short take
    // sometimes catches the compressor kicking in
    const startsHere = sc.dur < 120 && cy.chance(0.3)
    const on0 = startsHere ? false : cy.chance(0.85)
    const changes = []
    let st = on0
    let t = startsHere ? cy.range(0.15, 0.6) * sc.dur - cy.range(150, 480) : -cy.range(0, 60)
    while (t < sc.dur) {
      t += st ? cy.range(300, 900) : cy.range(150, 480)
      st = !st
      changes.push([t, st])
    }
    let state = on0
    for (const [tc, sv] of changes) if (tc <= 0) state = sv
    // the compressor sound, gated by the cycle (with soft starts and stops)
    const comp = new Float32Array(n)
    const mot = drifting(n, sr2, cy.range(58.2, 59.2), harmonicTable(old ? [[1, 1], [2, 0.7], [3, 0.55], [4, 0.4], [5, 0.3], [6, 0.25], [8, 0.15], [10, 0.1], [13, 0.06]] : [[1, 1], [2, 0.45], [3, 0.25], [4, 0.12], [6, 0.06]]), cy.fork('load'), old ? 0.006 : 0.004, 2.5)
    const mag = periodic(n, sr2, 120, harmonicTable([[1, 1], [2, 0.3], [3, 0.15]]), cy.next(), 0.0002)
    let s = seed32(cy)
    let lp = 0
    let rattle = 0
    let rTarget = 0
    let rTimer = 0
    const rhz = cy.range(1400, 2600)
    const gR = 1 - Math.exp((-TAU * rhz) / sr2)
    let gate = state ? 1 : 0
    let ci = 0
    let ph = 0
    const kOn = 1 - Math.exp(-1 / (0.25 * sr2))
    const kOff = 1 - Math.exp(-1 / (0.6 * sr2))
    for (let i = 0; i < n; i++) {
      const tt = i / sr2
      while (ci < changes.length && changes[ci][0] <= tt) {
        if (changes[ci][0] > 0) state = changes[ci][1]
        ci++
      }
      gate += ((state ? 1 : 0) - gate) * (state ? kOn : kOff)
      if (gate < 1e-6 && !state) gate = 0
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const w = s / 2147483648
      lp += (w - lp) * 0.05
      // the loose panel buzzes in short spells
      if (old) {
        rTimer -= 1 / sr2
        if (rTimer <= 0) {
          rTarget = rTarget > 0 ? 0 : 1
          rTimer = rTarget ? cy.range(0.5, 3) : cy.range(1, 6)
        }
        rattle += (rTarget - rattle) * 0.001
        ph += 58.7 / sr2
        if (ph >= 1) ph -= 1
      }
      const buzz = old && ph < 0.12 ? w * rattle * 0.8 : 0
      comp[i] = (mot[i] * 0.5 + mag[i] * 0.12 + lp * 0.6 + buzz) * gate
    }
    filt(comp, sr2, [['highpass', 40, 0.7], ['lowpass', old ? 3500 : 1800, 0.7], ['peak', rhz, 3, old ? 3 : 0]])
    emit(sc, comp, 0, pan, d, 0.12 * level * (old ? 1.8 : 1))
    // relay clicks, start thumps and stop shudders
    for (const [tc, nowOn] of changes) {
      if (tc < -0.5 || tc > sc.dur) continue
      const click = trim(modal(sr2, [cy.range(2500, 3500), 0.004, 1, cy.range(5000, 6000), 0.002, 0.4], { tick: 0.8, tickHz: 2500, seed: seed32(cy) }))
      emit(sc, click, tc * sr2, pan, d, 0.1)
      emit(sc, thump(sr2, cy, nowOn ? 70 : 55, nowOn ? 0.06 : 0.12, { noise: 0.4, noiseHz: 400 }), (tc + 0.05) * sr2, pan, d, nowOn ? 0.25 : 0.35)
    }
    // the fans
    const fanIn = fanSound(sr2, r.fork('evap'), len, { bpf: r.range(110, 170), tones: 2, toneLevel: 0.2, color: [['lowpass', 900, 0.6], ['highpass', 80, 0.7]] })
    emit(sc, fanIn, 0, pan, d + 0.3, 0.012 * level)
    const fanOut = fanSound(sr2, r.fork('cond'), len, { bpf: r.range(180, 260), tones: 2, toneLevel: 0.15, color: [['lowpass', 2500, 0.6], ['highpass', 150, 0.7], ['peak', 800, 1, 3]] })
    emit(sc, fanOut, 0, pan * 0.8, d + 0.2, 0.01 * level * (old ? 1.5 : 1))
    // gurgles and ticks
    const gr = r.fork('gurgle')
    for (const tg of poisson(gr, 0.05 + (old ? 0.04 : 0), -2, sc.dur)) emit(sc, gurgle(sr2, gr), tg * sr2, pan, d, 0.03)
    for (const tk of poisson(gr, 0.04, 0, sc.dur)) emit(sc, trim(modal(sr2, objectModes2(gr), { tick: 0.6, tickHz: 2500, seed: seed32(gr) })), tk * sr2, pan + gr.range(-0.1, 0.1), d, 0.03)
    // the ice maker
    const ic = r.fork('ice')
    if (q.ice > 0) {
      const ts = poisson(ic, (q.ice / 100) / 120, -10, sc.dur)
      if (!ts.length && sc.dur < 60 && ic.chance(q.ice / 100)) ts.push(ic.range(0, Math.max(0.5, sc.dur * 0.5)))
      for (const ti of ts) iceHarvest(sc, ic.fork('h' + Math.round(ti * 100)), ti, pan, d)
    }
    return finish(sc, { size: 0.5, rt60: 0.5, rt60High: 0.3, predelayMs: 3, wet: 0.7 }, -30 + (q.intensity - 50) * 0.06)
  },
}

/** Modes of the plastic liner ticking as it cools. */
function objectModes2(rng) {
  return [rng.range(1500, 3200), 0.006, 1, rng.range(3500, 5000), 0.003, 0.4]
}

export default bed
