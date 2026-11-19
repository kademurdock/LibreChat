// beds/rain-window.js - Rain on a window, heard from inside the room.
//
// Technique: the rain engine of beds/rain.js on its glass surface (each drop
// a sharp contact tick plus one or two short glass modes, a lightly damped
// pane body shared by all drops; Farnell, "Designing Sound", 2010), with the
// rain outside heard through the glass (a lowpassed wash), drips running off
// the frame onto the sill, a gutter trickle outside (Minnaert bubbles,
// Minnaert 1933, with van den Doel 2005 damping and chirp), and the room
// itself as a small feedback delay network (Jot and Chaigne 1991).

import { rainLayer, finishBed, Rand32, Impacts, Fdn, eq, addInto, clamp, runBed } from './rain.js'

/** A gutter or downpipe trickle outside: small bubbles and a thin flow, muffled. */
function trickle(n, sr, rng, amount) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (amount <= 0) return { L, R }
  const rnd = new Rand32(rng.fork('trickle'))
  const imp = new Impacts(L, R, sr, rnd)
  const dur = n / sr
  const pan = rnd.range(0.35, 0.8) * (rnd.chance(0.5) ? 1 : -1)
  let t = 0
  let burstEnd = 0
  let rateNow = 60
  while (t < dur) {
    if (t >= burstEnd) {
      // The flow surges and eases every second or so.
      burstEnd = t + rnd.range(0.3, 1.6)
      rateNow = rnd.range(25, 140) * amount
    }
    const r = rnd.logRange(0.0009, 0.0042)
    imp.bubble(t, rnd.range(0.02, 0.08), pan + rnd.bi() * 0.12, 3 / r, rnd.range(0.05, 0.2))
    t += rnd.exp(1 / Math.max(5, rateNow))
  }
  for (const s of [L, R]) eq(s, sr, [['lowpass', 2200, 0.7], ['highpass', 180, 0.7]])
  return { L, R }
}

const bed = {
  id: 'rain-window',
  name: 'Rain on a window',
  group: 'weather',
  about: 'Indoors by a window while rain taps the glass, runs off the frame and trickles down the gutter outside.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 85] },
    { id: 'drips', name: 'Drips off the frame', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
    { id: 'trickle', name: 'Gutter trickle', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'room', name: 'Room sound', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = rainLayer(n, s.sr, s.rng.fork('rain'), {
        intensity: q.intensity,
        surface: 'window',
        drips: q.drips / 100,
        dripSurface: 'window',
        waves: 0.35,
      })
      const tr = trickle(n, s.sr, s.rng, q.trickle / 100)
      addInto(L, tr.L, 1)
      addInto(R, tr.R, 1)
      const room = clamp(q.room / 100, 0, 1)
      if (room > 0) new Fdn(s.sr, { size: 0.32, rt60: 0.5, damp: 0.55, predelayMs: 3 }).process(L, R, 0.35 * room, 1)
      finishBed(L, R, s.sr, -20.5 + (q.intensity - 50) * 0.08)
      return { L, R }
    })
  },
}

export default bed
