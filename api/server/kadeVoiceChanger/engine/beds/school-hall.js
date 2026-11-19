// beds/school-hall.js - School hallway between classes: chatter, lockers slamming, sneakers squeaking, a bell.
//
// Techniques and their published sources:
// - Voices: the places kit's babble talkers (Klatt-style formant synthesis)
//   with children's or teenagers' pitch and vocal tract length (Lee,
//   Potamianos and Narayanan 1999, "Acoustics of children's speech"),
//   talking loud and fast in a loud place, calling out and reacting, but
//   never saying a word.
// - Lockers: thin steel doors are modal plates with many close modes and a
//   short ring (modal synthesis, van den Doel and Pai 1998), slammed over a
//   body thump with the latch's click and a rattle of the louvres.
// - The bell: an electric bell is a hammer striking a gong twenty-odd
//   times a second, so it is one gong strike (inharmonic modes) laid down
//   again on every hammer blow, its ring building into the familiar
//   clangour and dying away when the current stops.
// - Sneakers squeak on the polished floor (a short gliding friction tone),
//   kids run, zips open, books drop.
// - The hallway: long and narrow with hard walls, so a quick flutter of
//   reflections between the walls (early taps every few milliseconds) over
//   a medium decay from the kit's feedback delay network.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, makeTalker, speech, reactFrames, voiceAtRate, walker,
  poisson, logRange, pickW, strike, thump, noiseBurst, modal, buf, addAt, seed32, trim, sizedRoom, sizeSpread,
} from './cafe.js'

/** An electric school bell ringing for dur seconds. */
export function electricBell(sr, rng, dur, o = {}) {
  const f1 = o.hz ?? rng.range(620, 900)
  const one = modal(sr, [f1, 0.25, 1, f1 * 2.32, 0.15, 0.7, f1 * 4.11, 0.09, 0.5, f1 * 5.83, 0.06, 0.3, f1 * 7.9, 0.04, 0.2], { hard: 7000, tick: 0.3, tickHz: 3000, maxSec: 1.2, seed: seed32(rng) })
  const rate = o.rate ?? rng.range(19, 26)
  const out = buf(sr, dur + 1.3)
  for (let t = 0; t < dur; t += (1 / rate) * (1 + rng.gauss() * 0.03)) addAt(out, one, t * sr, 0.18 * rng.range(0.8, 1.1))
  return out
}

/** A locker: opened (latch and creak) or slammed (bang, latch, rattle). */
function locker(sr, rng, slam) {
  const out = buf(sr, 1.2)
  const latch = strike(sr, rng, 'cutlery', { size: 1.4, hard: 8000, tick: 1 })
  if (slam) {
    addAt(out, thump(sr, rng, rng.range(70, 100), 0.05, { noise: 0.7, noiseHz: 900 }), 0, 0.8)
    addAt(out, strike(sr, rng, 'locker', { hard: 6000, tick: 0.8 }), 0, 0.7)
    addAt(out, latch, 0.003 * sr, 0.25)
    for (let k = 0; k < 4; k++) addAt(out, strike(sr, rng, 'tray', { size: 0.5, hard: 7000, tick: 0.4, maxSec: 0.2 }), (0.02 + k * rng.range(0.015, 0.03)) * sr, 0.12 * Math.pow(0.7, k))
  } else {
    addAt(out, latch, 0, 0.35)
    addAt(out, thump(sr, rng, 160, 0.02, { noise: 0.4 }), 0.01 * sr, 0.2)
    addAt(out, strike(sr, rng, 'locker', { size: 1.2, hard: 2500, tick: 0.2 }), 0.15 * sr, 0.12)
  }
  return trim(out)
}

/** A backpack zip: a run of tiny ticks speeding up. */
function zipper(sr, rng) {
  const dur = rng.range(0.35, 0.8)
  const out = buf(sr, dur + 0.05)
  let t = 0
  let rate = rng.range(25, 40)
  const top = rng.range(90, 160)
  while (t < dur) {
    addAt(out, noiseBurst(sr, rng, 0.006, { att: 0.0003, dec: 0.0012, hz: rng.range(2500, 4500), q: 1.5 }), t * sr, rng.range(0.5, 1))
    t += 1 / rate
    rate = Math.min(top, rate * 1.06)
  }
  return out
}

const bed = {
  id: 'school-hall',
  name: 'School hallway',
  group: 'places',
  about: 'A school hallway between classes: kids chattering, lockers slamming, sneakers squeaking, and the bell.',
  params: [
    { id: 'intensity', name: 'How crowded', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 95] },
    { id: 'size', name: 'Hallway size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'lockers', name: 'Lockers', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 85] },
    { id: 'bell', name: 'School bell', type: 'bool', def: true },
    {
      id: 'age',
      name: 'Who is in the hall',
      type: 'choice',
      def: 'teens',
      options: [
        { v: 'teens', name: 'Teenagers' },
        { v: 'young', name: 'Young children' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.55, airHz: 16000, airM: 12, roomR: 15 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    const young = q.age === 'young'
    const kinds = young ? { child: 1 } : { teen: 1 }
    roomTone(sc, r.fork('air'), { db: -54, color: [['lowpass', 1000, 0.7]], hum: [[120, -70]], buzzDb: -68, drift: 0.2 })
    crowd(sc, r.fork('kids'), {
      groups: 1 + Math.round(busy * 10),
      size: [2, 4],
      dist: [1.5 * sp, 22 * sp],
      kinds,
      effort: 0.55 + busy * 0.25,
      rate: young ? 5.2 : 5.6,
      expr: 0.85,
      react: 0.7,
      silence: 0.04,
      gap: 0.1,
    })
    // calls down the hall
    const cl = r.fork('calls')
    for (const t of poisson(cl, 0.04 + busy * 0.18, -1, sc.dur)) {
      const c = cl.fork('c' + Math.round(t * 1000))
      const T = makeTalker(c, young ? 'child' : 'teen', { effort: 0.95, expr: 0.9 })
      const f = []
      if (c.chance(0.5)) reactFrames(T, c, f, 0, c.pick(['hey', 'oh', 'wow', 'yeah']), { effort: 1, level: 1 })
      else {
        const sp = speech(T, c, 1, { effort: 0.95, syl: [2, 3] })
        f.push(...sp.fr)
      }
      emit(sc, voiceAtRate(sc, T, f), t * sc.sr, c.range(-0.95, 0.95), logRange(c, 3, 20), 1.6)
    }
    // a teacher now and then
    const te = r.fork('teacher')
    for (const t of poisson(te, 0.015 + busy * 0.02, -2, sc.dur)) {
      const T = makeTalker(te, 'adult', { effort: 0.75, rate: 4.4 })
      emit(sc, voiceAtRate(sc, T, speech(T, te, 1 + te.int(2), { effort: 0.75 }).fr), t * sc.sr, te.range(-0.9, 0.9), logRange(te, 3, 12), 1.4)
    }
    // footsteps, running, squeaks
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.15 + busy * 0.5, -4, sc.dur)) {
      const w = wk.fork('w' + Math.round(t * 1000))
      const run = w.chance(0.15 + busy * 0.1)
      const pace = run ? w.range(2.8, 3.4) : w.range(1.8, 2.4)
      walker(sc, w, { t, pace, speed: pace * (run ? w.range(1.1, 1.3) : w.range(0.6, 0.75)), surface: 'vinyl', shoe: w.chance(0.8) ? 'soft' : 'hard', weight: young ? 0.25 : 0.5, closest: logRange(w, 1, 8), gain: run ? 0.6 : 0.4, squeak: run ? 0.5 : 0.12 })
    }
    // lockers
    const lk = r.fork('lockers')
    for (const t of poisson(lk, (q.lockers / 100) * (0.15 + busy * 0.6), -1, sc.dur)) {
      const l = lk.fork('l' + Math.round(t * 1000))
      const pan = l.range(-0.95, 0.95)
      const d = logRange(l, 1.5, 18)
      emit(sc, locker(sc.sr, l, false), t * sc.sr, pan, d, 0.4)
      if (l.chance(0.85)) emit(sc, locker(sc.sr, l, true), (t + l.range(1.5, 8)) * sc.sr, pan, d, l.range(0.5, 1.1))
    }
    // zips, dropped books, doors
    const misc = r.fork('misc')
    for (const t of poisson(misc, 0.05 + busy * 0.15, 0, sc.dur)) {
      const k = pickW(misc, [3, 1.5, 1])
      const pan = misc.range(-0.95, 0.95)
      const d = logRange(misc, 1.2, 12)
      if (k === 0) emit(sc, zipper(sc.sr, misc), t * sc.sr, pan, d, 0.25)
      else if (k === 1) {
        const a = thump(sc.sr, misc, misc.range(90, 140), 0.04, { noise: 0.9, noiseHz: 1500 })
        addAt(a, noiseBurst(sc.sr, misc, 0.15, { att: 0.002, dec: 0.03, hz: 1200, q: 0.6 }), 0, 0.5)
        emit(sc, a, t * sc.sr, pan, d, 0.8)
      } else {
        emit(sc, thump(sc.sr, misc, 80, 0.07, { noise: 0.5, noiseHz: 500 }), t * sc.sr, pan, d * 1.5, 1.2)
        emit(sc, strike(sc.sr, misc, 'metal', { size: 0.5, hard: 6000, tick: 0.8 }), (t + 0.01) * sc.sr, pan, d * 1.5, 0.08)
      }
    }
    // the bell
    if (q.bell) {
      const bl = r.fork('bell')
      const pan = bl.range(-0.7, 0.7)
      const d = bl.range(4, 9)
      let t = bl.range(0.05, 0.7) * Math.max(1, sc.dur)
      while (t < sc.dur) {
        const ring = electricBell(sc.sr, bl, bl.range(2.5, 4.5))
        emit(sc, ring, t * sc.sr, pan, d, 1.6, 1.1)
        t += bl.range(120, 240)
      }
    }
    const taps = [[7, 0.5, -0.85], [9, 0.45, 0.85], [21, 0.35, -0.75], [23, 0.32, 0.75], [36, 0.25, -0.6], [38, 0.22, 0.6], [52, 0.15, -0.4], [67, 0.11, 0.4]]
    return finish(sc, sizedRoom({ size: 1.0, rt60: 1.35, rt60High: 0.7, predelayMs: 6, wet: 0.95, taps }, q.size / 100), -23 + (q.intensity - 50) * 0.08)
  },
}

export default bed
