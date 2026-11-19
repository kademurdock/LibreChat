// beds/hospital.js - Hospital ward: a heart monitor beeping, soft steps, a hushed nurses' station, a distant page.
//
// Techniques and their published sources:
// - Heart monitors beep once per beat. The beat-to-beat timing is not a
//   metronome: it carries the slow swing of breathing (respiratory sinus
//   arrhythmia, about a quarter of a hertz) and a little random spread, the
//   heart-rate variability described in the Task Force of the European
//   Society of Cardiology 1996 standards. Each beep is a soft-edged sine
//   near 900 Hz (a pulse oximeter's pitch tracks oxygen; here it holds
//   steady), and other monitors behind the curtains keep their own rates
//   and pitches farther away.
// - Infusion pumps and call lights: the alarm patterns of IEC 60601-1-8
//   (a medium-priority burst of three tones), the two-tone nurse call chime.
// - The ward: soft-soled steps on vinyl with the odd squeak, a cart's
//   rattling wheels, a curtain's rings sliding on the rail, the sanitizer
//   pump, quiet talk at the station (places kit babble at low effort), and an
//   overhead page through ceiling speakers.
// - Room tone is the hush of filtered supply air; the room is plaster and
//   vinyl, a short bright decay from the kit's feedback delay network.

import {
  makeScene, emptyBed, finish, roomTone, emit, emitPath, crowd, walker, announce, poisson, logRange, pickW,
  clamp, strike, thump, noiseBurst, tone, chime, buf, addAt, passPath, sizedRoom, sizeSpread,
} from './cafe.js'

/** Beat times for a heart at bpm with breathing swing and random spread. */
export function heartBeats(rng, bpm, t0, t1) {
  const out = []
  const rr = 60 / clamp(bpm, 20, 240)
  const resp = rng.range(0.2, 0.3)
  const rsa = rng.range(0.02, 0.05)
  let ph = rng.next() * 2 * Math.PI
  let t = t0 + rng.next() * rr
  while (t < t1 && out.length < 100000) {
    out.push(t)
    ph += 2 * Math.PI * resp * rr
    t += rr * (1 + rsa * Math.sin(ph) + rng.gauss() * 0.012)
  }
  return out
}

/** A monitor's beep. */
function beep(sr, hz, len) {
  return tone(sr, hz, len, { partials: [[1, 1], [2, 0.06], [3, 0.03]], att: 0.006, rel: 0.035 })
}

/** A medium-priority alarm burst: three tones. */
function alarmBurst(sr, hz) {
  const out = buf(sr, 0.9)
  const parts = [[1, 1], [2, 0.4], [3, 0.3], [4, 0.2], [5, 0.15]]
  for (let k = 0; k < 3; k++) addAt(out, tone(sr, hz, 0.2, { partials: parts, att: 0.02, rel: 0.04 }), k * 0.28 * sr, 0.5)
  return out
}

/** A cart rolling past: rattling wheels, one of them squeaking. */
function cartPass(sc, rng, t) {
  const sr = sc.sr
  const speed = rng.range(0.9, 1.4)
  const dir = rng.chance(0.5) ? 1 : -1
  const x0 = -dir * rng.range(6, 10)
  const close = rng.range(1.5, 4)
  const dur = (Math.abs(x0) * 2) / speed
  const sig = noiseBurst(sr, rng, dur, { att: 0.5, dec: 1e6, hz: 600, q: 0.6, rel: 0.5 })
  for (let i = 0; i < sig.length; i++) sig[i] *= 0.4
  for (let tt = rng.range(0, 0.2); tt < dur; tt += rng.range(0.03, 0.12)) addAt(sig, noiseBurst(sr, rng, 0.01, { att: 0.0004, dec: 0.002, hz: 3000, q: 1 }), tt * sr, rng.range(0.1, 0.4))
  if (rng.chance(0.5)) {
    const per = 0.18 / speed
    const sq = tone(sr, rng.range(1500, 2500), 0.06, { partials: [[1, 1], [2, 0.3]], att: 0.01, rel: 0.03 })
    for (let tt = 0; tt < dur; tt += per) addAt(sig, sq, tt * sr, 0.12)
  }
  const path = passPath(x0, dir * speed, close, 1)
  emitPath(sc, sig, t * sr, (tt, p) => path(tt - t, p), 0.3)
}

const bed = {
  id: 'hospital',
  name: 'Hospital ward',
  group: 'places',
  about: 'A hospital ward: a heart monitor beeping, soft footsteps, a hushed nurses station and a distant page.',
  params: [
    { id: 'intensity', name: 'Activity', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 80] },
    { id: 'size', name: 'Ward size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'heartRate', name: 'Heart rate', type: 'number', min: 40, max: 160, step: 1, def: 72, unit: 'bpm', rand: [55, 110] },
    { id: 'monitors', name: 'Monitors', type: 'number', min: 1, max: 4, step: 1, def: 2, unit: 'count', noun: ['monitor', 'monitors'], rand: [1, 3] },
    { id: 'pages', name: 'Pages and alarms', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.45, airHz: 16000, airM: 10, roomR: 10 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('air'), { db: -47, color: [['lowpass', 2200, 0.6], ['highshelf', 4000, 0.7, -3], ['peak', 300, 0.8, 2]], hum: [[120, -72]], drift: 0.15, corr: 0.5 })
    // the bedside monitor and the ones behind the curtains
    const mr = r.fork('monitors')
    for (let m = 0; m < q.monitors; m++) {
      const mk = mr.fork('m' + m)
      const near = m === 0
      const bpm = near ? q.heartRate : mk.range(58, 96)
      const hz = near ? 960 : mk.pick([880, 920, 1000, 1040, 820])
      const pan = near ? -0.35 : mk.range(-0.95, 0.95)
      const d = near ? 1.4 : mk.range(4, 11)
      const b = beep(sc.sr, hz * (1 + mk.gauss() * 0.003), near ? 0.085 : mk.range(0.06, 0.1))
      for (const t of heartBeats(mk, bpm, -1, sc.dur)) emit(sc, b, t * sc.sr, pan, d, near ? 0.08 : 0.06, 0.8)
    }
    // soft talk at the nurses' station
    crowd(sc, r.fork('station'), { groups: Math.round(1 + busy * 2), size: [2, 3], dist: [6 * sp, 14 * sp], effort: 0.2, react: 0.5, silence: 0.3, rate: 4.4 })
    // steps on vinyl
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.04 + busy * 0.16, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'vinyl', shoe: 'soft', closest: logRange(wk, 1.5, 9), gain: 0.4, squeak: 0.15 })
    }
    // carts, curtains, the sanitizer, a door
    const misc = r.fork('misc')
    for (const t of poisson(misc, 0.012 + busy * 0.03, -6, sc.dur)) cartPass(sc, misc.fork('c' + Math.round(t * 100)), t)
    for (const t of poisson(misc, 0.01 + busy * 0.04, 0, sc.dur)) {
      const k = pickW(misc, [2, 1.5, 1])
      const pan = misc.range(-0.95, 0.95)
      const d = logRange(misc, 2, 9)
      if (k === 0) {
        // curtain rings slide along the rail
        const dur = misc.range(0.5, 1.2)
        const out = buf(sc.sr, dur + 0.3)
        for (let tt = 0; tt < dur; tt += misc.range(0.02, 0.06)) addAt(out, strike(sc.sr, misc, 'cutlery', { size: 1.8, hard: 7000, tick: 0.5, maxSec: 0.15 }), tt * sc.sr, misc.range(0.05, 0.2))
        addAt(out, noiseBurst(sc.sr, misc, dur, { att: 0.05, dec: dur, hz: 2500, q: 0.6, rel: 0.1 }), 0, 0.15)
        emit(sc, out, t * sc.sr, pan, d, 0.5)
      } else if (k === 1) {
        // the hand sanitizer pump
        emit(sc, thump(sc.sr, misc, 300, 0.01, { noise: 0.7, noiseHz: 2000 }), t * sc.sr, pan, d, 0.25)
        emit(sc, noiseBurst(sc.sr, misc, 0.15, { att: 0.005, dec: 0.04, hz: 4000, q: 0.8 }), (t + 0.02) * sc.sr, pan, d, 0.15)
      } else {
        emit(sc, thump(sc.sr, misc, 75, 0.08, { noise: 0.3, noiseHz: 400 }), t * sc.sr, pan, d * 1.5, 0.8)
        emit(sc, strike(sc.sr, misc, 'metal', { size: 0.5, hard: 6000, tick: 0.5 }), (t + 0.02) * sc.sr, pan, d * 1.5, 0.05)
      }
    }
    // pages, pump alarms and the call chime
    const pg = r.fork('pages')
    const amt = q.pages / 100
    for (const t of poisson(pg, amt * 0.02, -8, sc.dur)) {
      announce(sc, pg.fork('a' + Math.round(t * 100)), t, { speakers: [[-0.5, 7], [0.6, 15], [0, 26]], chime: pg.chance(0.5) ? [[587, 0], [740, 0.4]] : null, phrases: 1 + pg.int(2), gain: 0.25, effort: 0.45, send: 1.4, drive: 1.3 })
    }
    for (const t of poisson(pg, amt * 0.02, -10, sc.dur)) {
      // an infusion pump alarming until someone comes
      const pan = pg.range(-0.95, 0.95)
      const d = pg.range(4, 10)
      const al = alarmBurst(sc.sr, pg.pick([700, 800, 880]))
      const reps = 2 + pg.int(5)
      for (let k = 0; k < reps; k++) emit(sc, al, (t + k * pg.range(2.4, 2.6)) * sc.sr, pan, d, 0.05)
    }
    for (const t of poisson(pg, amt * 0.025, 0, sc.dur)) {
      const c = chime(sc.sr, pg, [[pg.pick([784, 659]), 0], [pg.pick([523, 494]), 0.5]], { decay: 0.4 })
      emit(sc, c, t * sc.sr, pg.range(-0.9, 0.9), pg.range(6, 15), 0.25)
    }
    return finish(sc, sizedRoom({ size: 0.7, rt60: 0.7, rt60High: 0.4, predelayMs: 6, wet: 0.85 }, q.size / 100), -29 + (q.intensity - 50) * 0.05)
  },
}

export default bed
