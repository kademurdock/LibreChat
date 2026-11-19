// beds/airport-hall.js - Airport hall: rolling suitcases, footsteps, chimes, announcements, a big murmur.
//
// Techniques and their published sources:
// - The hall: a very large, hard space full of people, so a long but
//   well-damped decay (two to three and a half seconds, highs soaked up by
//   the crowd) from the places kit's feedback delay network, with late
//   early reflections for the far walls and glass.
// - Rolling suitcases: wheels on a smooth floor are a rough rolling rumble
//   (the rolling-contact noise model of van den Doel, Kry and Pai 2001,
//   "FoleyAutomatic"), and every tile joint gives a double tick, front
//   wheels then back, at the rate set by walking speed over the tile size.
// - Announcements: a soft three-note chime and garbled speech from ceiling
//   speakers spread along the hall, each heard with its own delay, so the
//   voice smears the way terminal announcements do (places kit babble).
// - Jets outside: a far turbofan through the glass, a low roar with a faint
//   fan whine that swells as it taxis or takes off.
// - An electric cart beeping its way through, footsteps, the murmur of
//   many groups near and far.

import {
  makeScene, emptyBed, finish, roomTone, emit, emitPath, crowd, walker, announce, poisson, logRange, pickW,
  filt, thump, noiseBurst, tone, addAt, seed32, passPath, sinePhasor,
} from './cafe.js'

/** A rolling suitcase pulled past on tiles. */
function suitcase(sc, rng, o) {
  const sr = sc.sr
  const speed = o.speed
  const dir = o.dir
  const x0 = o.x0
  const close = o.closest
  const dur = (Math.abs(x0) * 2) / speed
  const n = Math.ceil(dur * sr)
  const sig = new Float32Array(n)
  // rolling rumble: noise through the wheel and case resonances, roughened
  let s = seed32(rng)
  let a = 0
  let b = 0
  let rough = 0
  const g1 = 1 - Math.exp((-2 * Math.PI * 450) / sr)
  const g2 = 1 - Math.exp((-2 * Math.PI * 120) / sr)
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const w = s / 2147483648
    a += (w - a) * g1
    b += (a - b) * g2
    if ((i & 511) === 0) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      rough = 0.7 + 0.3 * (s / 2147483648)
    }
    sig[i] = (a - b) * 2.2 * rough
  }
  filt(sig, sr, [['peak', o.caseHz, 3, 8], ['peak', o.caseHz * 2.3, 4, 4]])
  // the case rattles a little on every tile joint: two ticks, front then back wheels
  const tile = o.tile
  const tickA = thump(sr, rng, rng.range(250, 400), 0.006, { noise: 0.9, noiseHz: 2500 })
  for (let x = tile * rng.next(); x < speed * dur; x += tile) {
    addAt(sig, tickA, (x / speed) * sr, rng.range(0.5, 1))
    addAt(sig, tickA, ((x + o.wheelbase) / speed) * sr, rng.range(0.4, 0.8))
  }
  const f = Math.min(n >> 1, Math.round(0.5 * sr))
  for (let i = 0; i < f; i++) {
    sig[i] *= i / f
    sig[n - 1 - i] *= i / f
  }
  const path = passPath(x0, dir * speed, close, 1)
  emitPath(sc, sig, o.t * sr, (t, p) => path(t - o.t, p), o.gain)
}

/** A far jet through the terminal glass: low roar, faint whine, a slow swell. */
function jet(sc, rng, t, amount) {
  const sr = sc.sr
  const dur = rng.range(14, 30)
  const n = Math.ceil(dur * sr)
  const sig = new Float32Array(n)
  let s = seed32(rng)
  let lo = 0
  let lo2 = 0
  const g = 1 - Math.exp((-2 * Math.PI * 300) / sr)
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    lo += (s / 2147483648 - lo) * g
    lo2 += (lo - lo2) * g
    sig[i] = lo2 * 6
  }
  const whine = sinePhasor(n, sr, rng.range(1800, 3200), 0, 0.01)
  const up = rng.chance(0.4)
  for (let i = 0; i < n; i++) {
    const u = i / n
    const env = up ? Math.min(1, u * 3) * (u > 0.7 ? Math.max(0, 1 - (u - 0.7) / 0.3) : 1) : Math.sin(Math.PI * u)
    sig[i] = (sig[i] + whine[i] * 0.01) * env * env
  }
  emit(sc, sig, t * sr, rng.range(-0.9, 0.9), 60, 3.5 * amount, 0.7)
}

/** An electric cart beeping its way through the crowd. */
function cart(sc, rng, t) {
  const sr = sc.sr
  const speed = rng.range(2.5, 4)
  const dir = rng.chance(0.5) ? 1 : -1
  const x0 = -dir * rng.range(15, 25)
  const close = rng.range(3, 9)
  const dur = (Math.abs(x0) * 2) / speed
  const n = Math.ceil(dur * sr)
  const sig = new Float32Array(n)
  const motor = sinePhasor(n, sr, rng.range(500, 800), 0, 0.01)
  const hz = rng.range(1800, 2600)
  const beep = tone(sr, hz, 0.14, { partials: [[1, 1], [3, 0.3]], att: 0.004, rel: 0.02 })
  const fe = Math.round(0.8 * sr)
  for (let i = 0; i < n; i++) sig[i] = motor[i] * 0.02 * Math.min(1, i / fe, (n - i) / fe)
  addAt(sig, noiseBurst(sr, rng, dur, { att: 0.5, dec: 1e6, hz: 300, q: 0.7, rel: 0.8 }), 0, 0.05)
  for (let tt = rng.range(0, 1); tt < dur; tt += rng.range(1.2, 2.5)) {
    addAt(sig, beep, tt * sr, 0.3)
    addAt(sig, beep, (tt + 0.25) * sr, 0.3)
  }
  const path = passPath(x0, dir * speed, close, 1)
  emitPath(sc, sig, t * sr, (tt, p) => path(tt - t, p), 1)
}

const bed = {
  id: 'airport-hall',
  name: 'Airport hall',
  group: 'places',
  about: 'A big airport terminal: rolling suitcases, footsteps, chimes and announcements over a crowd murmur.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 90] },
    { id: 'size', name: 'Hall size', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 100] },
    { id: 'announcements', name: 'Announcements', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'suitcases', name: 'Rolling suitcases', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'jets', name: 'Jets outside', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.15, airHz: 14000, airM: 14, roomR: 40 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const busy = q.intensity / 100
    const size = q.size / 100
    roomTone(sc, r.fork('air'), { db: -46, color: [['lowpass', 1200, 0.7], ['peak', 200, 1, 4]], rumbleDb: -50, rumbleHz: 90, hum: [[60, -70]], drift: 0.3, corr: 0.25 })
    crowd(sc, r.fork('near'), { groups: 1 + Math.round(busy * 6), size: [2, 4], dist: [2.5, 12], effort: 0.4 + busy * 0.15, react: 0.4, kinds: { man: 1, woman: 1, child: 0.2 } })
    crowd(sc, r.fork('far'), { groups: 2 + Math.round(busy * 10), size: [2, 4], dist: [12, 35 + size * 25], effort: 0.45, react: 0.3 })
    // footsteps
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.1 + busy * 0.4, -5, sc.dur)) {
      const w = wk.fork('w' + Math.round(t * 1000))
      walker(sc, w, { t, surface: 'tile', shoe: ['hard', 'heel', 'soft'][pickW(w, [4, 3, 3])], closest: logRange(w, 1.2, 14), gain: 0.45, pace: w.range(1.8, 2.3), squeak: 0.04 })
    }
    // suitcases, each with its owner's steps
    const sk = r.fork('cases')
    for (const t of poisson(sk, (q.suitcases / 100) * (0.05 + busy * 0.25), -6, sc.dur)) {
      const w = sk.fork('c' + Math.round(t * 1000))
      const pace = w.range(1.8, 2.2)
      const speed = pace * w.range(0.65, 0.78)
      const dir = w.chance(0.5) ? 1 : -1
      const x0 = -dir * w.range(9, 16)
      const closest = logRange(w, 1.2, 10)
      suitcase(sc, w, { t, speed, dir, x0, closest, tile: w.pick([0.5, 0.6, 0.6, 0.9]), wheelbase: w.range(0.3, 0.4), caseHz: w.range(140, 320), gain: 0.35 })
      walker(sc, w, { t, pace, speed, dir, x0: x0 + dir * 0.5, closest: closest + 0.3, surface: 'tile', shoe: w.chance(0.4) ? 'heel' : 'hard', gain: 0.4 })
    }
    // announcements
    const an = r.fork('announce')
    for (const t of poisson(an, (q.announcements / 100) * 0.035, -8, sc.dur)) {
      announce(sc, an.fork('a' + Math.round(t * 100)), t, {
        speakers: [[-0.6, 8], [0.5, 14], [0, 24], [-0.85, 34], [0.85, 46]],
        chime: [[an.pick([523, 587]), 0], [659, 0.32], [784, 0.64]],
        phrases: 3 + an.int(3),
        gain: 0.45,
        send: 1.5,
        drive: 1.6,
        rate: 4.2,
      })
    }
    // jets beyond the glass
    const jr = r.fork('jets')
    for (const t of poisson(jr, (q.jets / 100) * 0.05, -20, sc.dur)) jet(sc, jr.fork('j' + Math.round(t * 100)), t, 0.4 + q.jets / 100)
    // an electric cart now and then
    const cr = r.fork('cart')
    for (const t of poisson(cr, 0.008 + busy * 0.01, -10, sc.dur)) cart(sc, cr.fork('k' + Math.round(t * 100)), t)
    const s = 1.2 + size * 1.8
    return finish(sc, { size: s, rt60: 1.6 + size * 1.9, rt60High: 0.8 + size * 0.7, predelayMs: 12 + size * 20, wet: 0.95 }, -24 + (q.intensity - 50) * 0.06)
  },
}

export default bed
