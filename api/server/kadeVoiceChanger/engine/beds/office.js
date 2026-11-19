// beds/office.js - Open office: air conditioning, keyboards, distant phones, a printer, quiet talk.
//
// Techniques and their published sources:
// - Air handling as broadband noise with a low-mid hump, diffuser hiss and
//   the blade-pass hum of the supply fan (the HVAC spectrum shapes in ASHRAE
//   Handbook, "Noise and Vibration Control"), with a slow breathing drift.
// - Keyboards: every key is a modal click (keycap plastic modes, a short
//   contact tick and the bottom-out thud of the board), the release a
//   lighter click about 60 to 90 ms later; typists type in bursts of words
//   at five to nine keys a second with heavier space and enter keys, after
//   the inter-key timing statistics of typing studies (Salthouse 1986,
//   "Perceptual, cognitive, and motoric aspects of transcription typing").
//   Each keyboard draws a small set of key voices, as a real board has.
// - Desk phones: electronic two-tone warble ringers on a ring cadence
//   (two seconds on, four off), heard across the room.
// - Laser printer: fan and motor hum while it works, and for each page the
//   pick-up clack, the swish of paper through the rollers and the drop
//   into the tray.
// - People: the places kit's babble at normal effort, plus one person on a
//   phone call (long turns with listening pauses).
// - Room: a dry, carpeted office with a tiled ceiling (short decay, soft
//   highs) from the kit's feedback delay network.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, makeTalker, conversation, addTalker, walker, poisson,
  rexp, logRange, pickW, filt, strike, modal, thump, noiseBurst, addAt, buf, phoneRings, seed32, objectModes,
  TAU, sinePhasor, trim, sizedRoom, sizeSpread,
} from './cafe.js'

/** A keyboard: a few key voices for normal keys, space and enter. */
function keyboard(sr, rng, kind) {
  const loud = kind === 'clicky'
  const make = (size, thud) => {
    const out = buf(sr, 0.16)
    const modes = objectModes('plastic', rng, size)
    const press = modal(sr, modes, { hard: loud ? 9000 : 5000, tick: loud ? 0.9 : 0.4, tickHz: loud ? 2500 : 1500, tickMs: 0.8, seed: seed32(rng) })
    addAt(out, press, 0, loud ? 1 : 0.6)
    addAt(out, thump(sr, rng, rng.range(180, 320) / size, 0.008, { noise: 0.3, noiseHz: 900 }), rng.range(0.002, 0.006) * sr, thud)
    const rel = modal(sr, objectModes('plastic', rng, size * 1.1), { hard: 6000, tick: 0.3, tickHz: 2000, tickMs: 0.6, seed: seed32(rng) })
    addAt(out, rel, rng.range(0.06, 0.09) * sr, loud ? 0.5 : 0.25)
    return trim(out)
  }
  const keys = []
  for (let i = 0; i < 6; i++) keys.push(make(rng.range(0.9, 1.1), 0.5))
  return { keys, space: make(1.8, 0.9), enter: make(1.3, 0.8) }
}

/** A typist at a desk: bursts of words with pauses. */
function typist(sc, rng, pan, dist, amount) {
  const kb = keyboard(sc.sr, rng, rng.chance(0.3) ? 'clicky' : 'soft')
  const g = rng.range(0.07, 0.13)
  const speed = rng.range(5, 8.5)
  let t = -rng.range(0, 8)
  let guard = 0
  while (t < sc.dur && guard++ < 2000) {
    const burst = rng.range(1.5, 10) * (0.5 + amount)
    const end = t + burst
    while (t < end && t < sc.dur) {
      const letters = 2 + rng.int(7)
      for (let k = 0; k < letters; k++) {
        if (t >= 0) emit(sc, kb.keys[rng.int(kb.keys.length)], t * sc.sr, pan, dist, g * rng.range(0.6, 1.1))
        t += Math.max(0.045, rexp(rng, 1 / speed) * 0.6 + 0.4 / speed)
      }
      if (rng.chance(0.08)) {
        // a run of backspaces
        const nb = 2 + rng.int(5)
        for (let k = 0; k < nb; k++) {
          if (t >= 0) emit(sc, kb.keys[0], t * sc.sr, pan, dist, g * 0.9)
          t += rng.range(0.09, 0.14)
        }
      }
      if (t >= 0) emit(sc, rng.chance(0.08) ? kb.enter : kb.space, t * sc.sr, pan, dist, g * 1.2)
      t += rng.range(0.1, 0.25)
    }
    t += rng.range(1.5, 14) / (0.4 + amount)
    if (rng.chance(0.3)) {
      // mouse clicks between bursts
      const mc = modal(sc.sr, objectModes('plastic', rng, 0.6), { hard: 8000, tick: 0.5, tickHz: 3000, tickMs: 0.5, seed: seed32(rng) })
      const dbl = rng.chance(0.4)
      emit(sc, mc, (t - 0.6) * sc.sr, pan, dist, g * 0.5)
      if (dbl) emit(sc, mc, (t - 0.47) * sc.sr, pan, dist, g * 0.5)
    }
  }
}

/** One page going through a laser printer. */
function printerPage(sr, rng) {
  const out = buf(sr, 2.4)
  // pick-up roller: a plastic clack and a solenoid thunk
  addAt(out, thump(sr, rng, 140, 0.025, { noise: 0.6, noiseHz: 1200 }), 0, 0.7)
  addAt(out, modal(sr, objectModes('plastic', rng, 1.5), { tick: 0.8, tickHz: 1500, seed: seed32(rng) }), 0.01 * sr, 0.5)
  // paper sliding through: a swish that rises and falls
  const sw = noiseBurst(sr, rng, 1.4, { att: 0.25, dec: 0.5, hz: 2200, q: 0.5 })
  addAt(out, sw, 0.2 * sr, 0.35)
  // exit rollers and the drop into the tray
  addAt(out, thump(sr, rng, 220, 0.015, { noise: 0.4, noiseHz: 1500 }), 1.6 * sr, 0.25)
  addAt(out, noiseBurst(sr, rng, 0.2, { att: 0.01, dec: 0.05, hz: 900, q: 0.6 }), 1.85 * sr, 0.35)
  return out
}

/** The printer's motor and fan during a job. */
function printerMotor(sr, rng, dur) {
  const n = Math.ceil(dur * sr)
  const out = sinePhasor(n, sr, rng.range(95, 130), 0, 0.003)
  const h2 = sinePhasor(n, sr, rng.range(380, 520), 1, 0.004)
  let s = seed32(rng)
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const t = i / sr
    const e = Math.min(1, t / 0.6) * Math.min(1, (dur - t) / 0.8)
    out[i] = (out[i] * 0.4 + h2[i] * 0.15 + (s / 2147483648) * 0.5) * e
  }
  filt(out, sr, [['lowpass', 2500, 0.7], ['highpass', 60, 0.7]])
  return out
}

/** A water cooler glug: rising bubble tones (Minnaert resonance of bubbles). */
function glug(sr, rng) {
  const n = 2 + rng.int(4)
  const out = buf(sr, 0.25 * n + 0.3)
  for (let k = 0; k < n; k++) {
    const f0 = rng.range(220, 420)
    const len = Math.round(0.12 * sr)
    const off = Math.round((k * rng.range(0.18, 0.26) + 0.01) * sr)
    let ph = 0
    for (let i = 0; i < len && off + i < out.length; i++) {
      const t = i / sr
      ph += (TAU * f0 * (1 + 4 * t)) / sr
      out[off + i] += Math.sin(ph) * Math.exp(-t / 0.035) * (1 - Math.exp(-t / 0.003))
    }
  }
  return out
}

const bed = {
  id: 'office',
  name: 'Office',
  group: 'places',
  about: 'An open office: air conditioning, keyboards clicking, phones ringing far off, a printer and quiet talk.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'size', name: 'Office size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'typing', name: 'Typing', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [20, 90] },
    { id: 'phones', name: 'Phones ringing', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
    { id: 'talk', name: 'People talking', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'printer', name: 'Printer', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'hvac', name: 'Air conditioning', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.45, airHz: 14000, airM: 8, roomR: 10 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    const hv = q.hvac / 100
    roomTone(sc, r.fork('hvac'), {
      db: -50 + hv * 14,
      color: [['lowpass', 1600, 0.6], ['peak', 260, 0.8, 5], ['highshelf', 3500, 0.7, -4]],
      rumbleDb: -60 + hv * 12,
      rumbleHz: 110,
      hum: [[118, -70 + hv * 8], [59, -76 + hv * 6]],
      buzzDb: -70,
      drift: 0.25,
      corr: 0.4,
    })
    // diffuser hiss straight overhead
    roomTone(sc, r.fork('diffuser'), { db: -64 + hv * 12, color: [['highpass', 2500, 0.7], ['lowpass', 9000, 0.7]], drift: 0.1, corr: 0.7 })
    // typists
    const nType = Math.round((1 + busy * 6) * (q.typing / 60))
    for (let i = 0; i < nType; i++) {
      const tr = r.fork('typist' + i)
      typist(sc, tr, tr.range(-0.95, 0.95), i === 0 ? tr.range(1.2, 2.5) : logRange(tr, 2.5, 14), q.typing / 100)
    }
    // talking
    const tk = q.talk / 100
    if (tk > 0) {
      crowd(sc, r.fork('talk'), { groups: Math.round(tk * (1 + busy * 4)), size: [2, 3], dist: [4 * sp, 16 * sp], effort: 0.3, react: 0.45, silence: 0.25 })
      if (tk > 0.2) {
        // someone on a call: long turns, then listening
        const cr = r.fork('call')
        const T = makeTalker(cr, 'adult', { effort: 0.38 })
        const sp = conversation(cr, [T], -2, sc.dur, { silence: 0.5, phrases: [1, 3] })
        addTalker(sc, T, sp[0], cr.range(-0.8, 0.8), cr.range(4, 9))
      }
    }
    // phones
    const pr = r.fork('phones')
    for (const t of poisson(pr, (q.phones / 100) * (0.02 + busy * 0.05), -6, sc.dur)) {
      const rings = 1 + pr.int(4)
      phoneRings(sc, pr, t, rings, pr.range(-0.95, 0.95), logRange(pr, 4, 20), 0.12)
    }
    // printer jobs
    const prn = r.fork('printer')
    const pPan = prn.range(-0.8, 0.8)
    const pDist = prn.range(5, 10)
    for (const t of poisson(prn, (q.printer / 100) * 0.04, -10, sc.dur)) {
      const pages = 1 + prn.int(5)
      const dur = 2.5 + pages * 2.1
      emit(sc, printerMotor(sc.sr, prn, dur), t * sc.sr, pPan, pDist, 0.12)
      for (let k = 0; k < pages; k++) emit(sc, printerPage(sc.sr, prn), (t + 1.2 + k * 2.1) * sc.sr, pPan, pDist, 0.35)
    }
    // footsteps on carpet, a door, a chair, the water cooler
    const misc = r.fork('misc')
    for (const t of poisson(misc, 0.03 + busy * 0.07, -4, sc.dur)) {
      walker(sc, misc.fork('w' + Math.round(t * 1000)), { t, surface: 'carpet', shoe: misc.chance(0.3) ? 'heel' : 'soft', closest: logRange(misc, 1.5, 8), gain: 0.5 })
    }
    for (const t of poisson(misc, 0.01 + busy * 0.02, 0, sc.dur)) {
      const k = pickW(misc, [2, 2, 1, 1])
      const pan = misc.range(-0.9, 0.9)
      const d = logRange(misc, 3, 15)
      if (k === 0) {
        // a door closing on its closer, then the latch
        emit(sc, thump(sc.sr, misc, 85, 0.06, { noise: 0.4, noiseHz: 500 }), t * sc.sr, pan, d, 0.8)
        emit(sc, strike(sc.sr, misc, 'metal', { size: 0.4, hard: 6000, tick: 0.8 }), (t + 0.02) * sc.sr, pan, d, 0.05)
      } else if (k === 1) {
        // an office chair: casters rolling, then the tilt spring creak
        emit(sc, noiseBurst(sc.sr, misc, 0.6, { att: 0.1, dec: 0.2, hz: 300, q: 0.8 }), t * sc.sr, pan, d, 0.25)
        emit(sc, strike(sc.sr, misc, 'metal', { size: 1.2, hard: 2500, tick: 0.2 }), (t + 0.5) * sc.sr, pan, d, 0.02)
      } else if (k === 2) {
        emit(sc, glug(sc.sr, misc), t * sc.sr, pan, d, 0.25)
      } else {
        // a stapler
        emit(sc, thump(sc.sr, misc, 200, 0.02, { noise: 0.8, noiseHz: 2500 }), t * sc.sr, pan, d, 0.5)
        emit(sc, strike(sc.sr, misc, 'cutlery', { size: 1.5 }), (t + 0.005) * sc.sr, pan, d, 0.05)
      }
    }
    return finish(sc, sizedRoom({ size: 0.65, rt60: 0.5, rt60High: 0.28, predelayMs: 5, wet: 0.7 }, q.size / 100), -27 + (q.intensity - 50) * 0.06)
  },
}

export default bed
