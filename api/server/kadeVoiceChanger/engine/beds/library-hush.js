// beds/library-hush.js - Library: soft air, pages turning, a whisper now and then, footsteps on carpet.
//
// Techniques and their published sources:
// - Paper: a page turn is a burst of tiny crackles from the sheet bending
//   (the crumpling-sound statistics of Houle and Sethna 1996, "Acoustic
//   emission from crumpling paper": many small clicks with a wide spread of
//   sizes) riding on a soft whoosh of air as the page sweeps over, then a
//   faint settle. Books close with a thud and a puff of air, slide off
//   shelves with a scrape, and land on tables.
// - Whispers: the places kit's talkers with the voice turned off, so the
//   breath noise through the vocal tract carries the vowels (whispered
//   speech is aspiration filtered by the same formants), in short quiet
//   exchanges.
// - Pencil strokes are short bands of friction noise in the rhythm of
//   handwriting; a wooden chair creaks by stick-slip, a run of clicks that
//   speeds up through the wood's resonance; the wall clock ticks and tocks.
// - Room tone is the quiet supply air of a big room; books and carpet soak
//   up the highs, so the decay is moderate and dark.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, walker, poisson, logRange, pickW, filt, thump, noiseBurst,
  modal, buf, addAt, seed32, trim, objectModes, sizedRoom, sizeSpread,
} from './cafe.js'

/** A page turn. */
function pageTurn(sr, rng) {
  const dur = rng.range(0.18, 0.4)
  const out = buf(sr, dur + 0.3)
  let s = seed32(rng)
  // crackles: many tiny clicks with a wide range of sizes
  for (let t = 0; t < dur; t += rng.range(0.001, 0.008)) {
    const u = t / dur
    const env = Math.sin(Math.PI * Math.min(1, u * 1.2))
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const size = Math.pow((s >>> 0) / 4294967296, 3)
    const c = noiseBurst(sr, rng, 0.005, { att: 0.0005, dec: 0.0009 })
    addAt(out, c, t * sr, (0.08 + size) * env * 0.5)
  }
  filt(out, sr, [['highpass', 1500, 0.7], ['peak', 4000, 0.8, 3], ['lowpass', 7500, 0.7]])
  // the sweep of air
  addAt(out, noiseBurst(sr, rng, dur + 0.1, { att: dur * 0.5, dec: 0.06, hz: 700, q: 0.5 }), 0, 0.35)
  // it settles
  addAt(out, noiseBurst(sr, rng, 0.04, { att: 0.002, dec: 0.01, hz: 1800, q: 0.7 }), (dur + 0.05) * sr, 0.15)
  return out
}

/** A book: closed, set down, or slid off the shelf. */
function book(sr, rng, kind) {
  const out = buf(sr, 0.9)
  if (kind === 0) {
    addAt(out, thump(sr, rng, rng.range(110, 160), 0.03, { noise: 0.6, noiseHz: 700 }), 0, 0.8)
    addAt(out, noiseBurst(sr, rng, 0.12, { att: 0.002, dec: 0.03, hz: 500, q: 0.6 }), 0, 0.5)
  } else if (kind === 1) {
    addAt(out, thump(sr, rng, rng.range(90, 130), 0.04, { noise: 0.4, noiseHz: 600 }), 0, 0.9)
    addAt(out, modal(sr, objectModes('wood', rng, 0.8), { hard: 3000, tick: 0.3, tickHz: 800, seed: seed32(rng) }), 0, 0.4)
  } else {
    addAt(out, noiseBurst(sr, rng, 0.35, { att: 0.05, dec: 0.12, hz: rng.range(900, 1600), q: 0.8 }), 0, 0.35)
    addAt(out, thump(sr, rng, 140, 0.02, { noise: 0.3 }), 0.33 * sr, 0.3)
  }
  return trim(out)
}

/** A word written in pencil: friction strokes. */
function pencil(sr, rng) {
  const n = 3 + rng.int(8)
  const out = buf(sr, n * 0.25 + 0.2)
  let t = 0
  for (let k = 0; k < n; k++) {
    const d = rng.range(0.05, 0.2)
    addAt(out, noiseBurst(sr, rng, d, { att: d * 0.3, dec: d * 0.4, hz: rng.range(2500, 5000), q: 1.2 }), t * sr, rng.range(0.5, 1))
    t += d + rng.range(0.02, 0.12)
  }
  return trim(out)
}

/** A wooden chair creak: stick-slip clicks speeding up through the wood. */
function creak(sr, rng) {
  const dur = rng.range(0.25, 0.8)
  const out = buf(sr, dur + 0.1)
  let t = 0
  let rate = rng.range(30, 60)
  const top = rng.range(90, 220)
  const click = modal(sr, [rng.range(500, 900), 0.008, 1, rng.range(1300, 1900), 0.005, 0.5], { tick: 0.2, tickHz: 1200, seed: seed32(rng) })
  while (t < dur) {
    addAt(out, click, t * sr, Math.sin((Math.PI * t) / dur) * rng.range(0.6, 1))
    t += 1 / rate
    rate = Math.min(top, rate * rng.range(1.01, 1.06))
  }
  return trim(out)
}

const bed = {
  id: 'library-hush',
  name: 'Library',
  group: 'places',
  about: 'A quiet library: soft air, pages turning, a whisper now and then, and footsteps on carpet.',
  params: [
    { id: 'intensity', name: 'Activity', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 80] },
    { id: 'size', name: 'Room size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'pages', name: 'Page turns', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'whispers', name: 'Whispers', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'clock', name: 'Wall clock', type: 'bool', def: true },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.3, airHz: 13000, airM: 9, roomR: 15 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('air'), { db: -58, color: [['lowpass', 1400, 0.6], ['peak', 220, 0.8, 3]], hum: [[120, -80]], buzzDb: -82, drift: 0.15, corr: 0.5 })
    // pages
    const pg = r.fork('pages')
    const readers = []
    for (let k = 0; k < 2 + Math.round(busy * 5); k++) readers.push([pg.range(-0.95, 0.95), k === 0 ? pg.range(1.2, 2.5) : logRange(pg, 2.5, 12)])
    for (const t of poisson(pg, (q.pages / 100) * (0.08 + busy * 0.25), -1, sc.dur)) {
      const [pan, d] = readers[pg.int(readers.length)]
      emit(sc, pageTurn(sc.sr, pg), t * sc.sr, pan, d, 0.35)
    }
    // books, pencils, chairs, the odd shush
    const ms = r.fork('misc')
    for (const t of poisson(ms, 0.03 + busy * 0.12, -1, sc.dur)) {
      const k = pickW(ms, [2, 2, 1.5, 1.2, 0.2])
      const [pan, d] = readers[ms.int(readers.length)]
      if (k < 3) emit(sc, k === 2 ? pencil(sc.sr, ms) : book(sc.sr, ms, ms.int(3)), t * sc.sr, pan, d, k === 2 ? 0.08 : 0.5)
      else if (k === 3) emit(sc, creak(sc.sr, ms), t * sc.sr, pan, d, 0.12)
      else emit(sc, noiseBurst(sc.sr, ms, ms.range(0.6, 1), { att: 0.08, dec: 0.4, hz: 3000, q: 1.6, rel: 0.15 }), t * sc.sr, ms.range(-0.9, 0.9), ms.range(5, 9), 0.25)
    }
    // whispers
    const wh = q.whispers / 100
    if (wh > 0) crowd(sc, r.fork('whisper'), { groups: Math.round(1 + wh * 2), size: [2, 2], dist: [2.5 * sp, 9 * sp], whisper: true, effort: 0.25, rate: 4.2, react: 0.3, silence: 0.55 - wh * 0.3, gain: 0.7 })
    // footsteps on carpet
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.02 + busy * 0.08, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'carpet', shoe: 'soft', closest: logRange(wk, 1.5, 7), gain: 0.4, pace: wk.range(1.6, 1.9) })
    }
    // the wall clock
    if (q.clock) {
      const cl = r.fork('clock')
      const tick = trim(modal(sc.sr, [cl.range(2400, 3000), 0.006, 1, cl.range(4200, 5000), 0.004, 0.5, cl.range(700, 900), 0.01, 0.4], { tick: 0.6, tickHz: 3000, seed: seed32(cl) }))
      const tock = trim(modal(sc.sr, [cl.range(1900, 2300), 0.007, 1, cl.range(3600, 4100), 0.004, 0.5, cl.range(600, 800), 0.012, 0.5], { tick: 0.6, tickHz: 2500, seed: seed32(cl) }))
      const pan = cl.range(-0.8, 0.8)
      const d = cl.range(3, 6)
      for (let k = 0, t = cl.next(); t < sc.dur; k++, t += 1) emit(sc, k % 2 ? tock : tick, t * sc.sr, pan, d, 0.05)
    }
    // a door far off
    const dr = r.fork('door')
    for (const t of poisson(dr, 0.008 + busy * 0.01, 0, sc.dur)) emit(sc, thump(sc.sr, dr, 80, 0.08, { noise: 0.3, noiseHz: 400 }), t * sc.sr, dr.range(-0.9, 0.9), dr.range(12, 25), 1)
    return finish(sc, sizedRoom({ size: 1.3, rt60: 1.0, rt60High: 0.45, predelayMs: 10, wet: 0.75 }, q.size / 100), -35 + (q.intensity - 40) * 0.05)
  },
}

export default bed
