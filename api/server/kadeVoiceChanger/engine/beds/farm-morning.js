// beds/farm-morning.js - Early morning in a farmyard.
//
// Roosters crowing back and forth across the farm, hens clucking and
// scratching close by, sparrows chirping in the barn eaves, pigeons cooing on
// the roof, a cow lowing far out in the pasture and a fly buzzing past, with
// the slap of the barn wall in the space (SPACES.farmyard).
//
// The animal voices are the harmonic source-filter voice from wolves-far.js,
// shaped from what their spectrograms show:
// - the crow: four connected syllables ("cock-a-doodle-doo"), a harmonic-rich
//   rasping voice near 400 to 750 Hz whose pitch climbs syllable by syllable
//   and holds on the long last one before falling, with vowel-like
//   resonances that open and close, strong roughness and jitter. It is kept
//   at farmyard distance, where the barn's reflections soften it;
// - hen clucks: short low nasal "buk" notes in loose series, and now and
//   then the rising "ba-GAWK";
// - the cow: a low harmonic voice (100 to 140 Hz) that starts closed and
//   nasal ("mm") and opens into "ooh" as the resonances move, far away.
// Sparrow chirps and pigeon coos use the bird note engine (forest-birds.js);
// the fly uses the insect flight engine (beehive.js).

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, renderNotes, makeSingers, runSingers, drawPan, drawDist, SPACES, clamp } from './forest-birds.js'
import { harmonicVoice } from './wolves-far.js'
import { addFlyBys } from './beehive.js'

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function join(parts, sr) {
  let end = 0
  for (const [t, s] of parts) end = Math.max(end, Math.round(t * sr) + s.length)
  const out = new Float32Array(end + 1)
  for (const [t, s] of parts) {
    const o = Math.round(t * sr)
    for (let i = 0; i < s.length; i++) out[o + i] += s[i]
  }
  return out
}

/** A rooster's crow. k = the bird's pitch factor (about 0.85..1.15). */
export function crow(sr, rng, k = 1) {
  const v = (d, f, amp, fa, fb, morph, rough) => harmonicVoice(sr, rng, {
    dur: d, f, amp, formants: fa, formants2: fb, morph,
    tilt: -3, nh: 16, jitter: 45, vibR: R(rng, 6, 8), vibC: 25, vibOn: 0.2, rough, breath: 0.28,
  })
  const U = [[600, 260, 0], [1250, 320, -4], [2600, 500, -12]]
  const A = [[900, 300, 0], [1650, 350, -3], [2700, 500, -10]]
  const O = [[650, 260, 0], [1100, 300, -5], [2500, 500, -14]]
  // syllables overlap by X seconds and fade in and out across it, so the
  // joins are smooth crossfades and never clicks
  const X = 0.014
  const parts = []
  let t = 0
  const d1 = R(rng, 0.15, 0.2)
  parts.push([t, v(d1, [[0, 380 * k], [d1, 520 * k]], [[0, 0], [0.03, 0.8], [d1 - X, 0.35], [d1, 0]], U, A, [[0, 0], [d1, 1]], 0.25)])
  t += d1 - X
  const d2 = R(rng, 0.09, 0.13)
  parts.push([t, v(d2, [[0, 480 * k], [d2, 560 * k]], [[0, 0], [X, 0.85], [d2 - X, 0.4], [d2, 0]], A, A, null, 0.25)])
  t += d2 - X
  const d3 = R(rng, 0.17, 0.22)
  parts.push([t, v(d3, [[0, 540 * k], [d3, 720 * k]], [[0, 0], [X + 0.01, 1], [d3 - X, 0.55], [d3, 0]], A, U, [[0, 0], [d3, 0.6]], 0.3)])
  t += d3 - X
  const d4 = R(rng, 0.8, 1.15)
  const top = R(rng, 720, 790) * k
  parts.push([t, v(d4, [[0, 700 * k], [0.25, top], [d4 * 0.75, top * 0.97], [d4, 520 * k]], [[0, 0], [X + 0.03, 1], [d4 * 0.7, 0.85], [d4, 0]], A, O, [[0, 0], [d4 * 0.5, 0.4], [d4, 1]], 0.35)])
  return join(parts, sr)
}

/** A hen's cluck series, sometimes ending in "ba-GAWK". */
export function clucks(sr, rng, k = 1) {
  const buk = (d, f0) => harmonicVoice(sr, rng, {
    dur: d,
    f: [[0, f0], [d, f0 * 0.85]],
    amp: [[0, 0], [0.008, 1], [d * 0.5, 0.7], [d, 0]],
    formants: [[R(rng, 650, 850), 300, 0], [1700, 400, -6], [2800, 500, -14]],
    tilt: -6, nh: 12, jitter: 20, rough: 0.25, breath: 0.15,
  })
  const parts = []
  let t = 0
  const n = 2 + rng.int(7)
  for (let i = 0; i < n; i++) {
    parts.push([t, buk(R(rng, 0.055, 0.09), R(rng, 290, 350) * k)])
    t += R(rng, 0.14, 0.42)
  }
  if (rng.next() < 0.18) {
    const d = R(rng, 0.3, 0.4)
    parts.push([t, harmonicVoice(sr, rng, {
      dur: d,
      f: [[0, 420 * k], [0.08, 660 * k], [d * 0.8, 600 * k], [d, 470 * k]],
      amp: [[0, 0], [0.02, 1], [d * 0.8, 0.85], [d, 0]],
      formants: [[800, 300, 0], [1500, 400, -4], [2700, 500, -12]],
      formants2: [[700, 280, 0], [1150, 330, -5], [2600, 500, -14]],
      morph: [[0, 0], [d, 1]],
      tilt: -4, nh: 14, jitter: 30, rough: 0.55, breath: 0.25,
    })])
  }
  return join(parts, sr)
}

/** A cow lowing. */
export function moo(sr, rng) {
  const d = R(rng, 1.4, 2.6)
  const F = R(rng, 98, 128)
  return harmonicVoice(sr, rng, {
    dur: d,
    f: [[0, F * 0.95], [0.4, F * 1.15], [d * 0.6, F * 1.22], [d, F * 0.9]],
    amp: [[0, 0], [0.2, 0.6], [0.5, 1], [d - 0.3, 0.8], [d, 0]],
    formants: [[250, 120, 0], [1000, 300, -25], [2500, 400, -30]],
    formants2: [[R(rng, 500, 600), 160, 0], [1050, 220, -6], [2500, 400, -14]],
    morph: [[0, 0], [0.45, 1], [d, 0.8]],
    tilt: -4, nh: 30, jitter: 15, rough: 0.15, breath: 0.12,
  })
}

/** Sparrow chirp notes (one chirp). */
function chirp(rng, F) {
  if (rng.next() < 0.6) return [{ t: 0, d: R(rng, 0.08, 0.12), f0: F, f1: F * 0.9, arch: R(rng, 0.15, 0.3), h2: 0.35, h3: 0.12, att: 0.006, rel: 0.025, a: 1 }]
  return [
    { t: 0, d: 0.05, f0: F * 0.95, f1: F * 1.1, h2: 0.35, h3: 0.1, att: 0.004, rel: 0.012, a: 0.9 },
    { t: 0.055, d: 0.06, f0: F * 1.1, f1: F * 0.85, h2: 0.35, h3: 0.1, att: 0.004, rel: 0.02, a: 1 },
  ]
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'farm-morning',
  name: 'Farmyard morning',
  group: 'nature',
  about: 'Early morning on a farm: roosters crowing, hens clucking nearby, sparrows, doves, a far cow.',
  params: [
    { id: 'intensity', name: 'Farm life', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'distance', name: 'Distance to the barnyard', type: 'number', min: 4, max: 60, step: 1, def: 14, unit: 'meters' },
    { id: 'rooster', name: 'Roosters', type: 'bool', def: true },
    { id: 'hens', name: 'Hens', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'cows', name: 'Cow far off', type: 'bool', def: true },
    { id: 'breeze', name: 'Breeze', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('farm-morning')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const d = q.distance
    addAir(sc, { hushDb: -60, wind: 0.04 + 0.7 * (q.breeze / 100), gust: 0.5, body: 400, foliage: 0.45, foliageHz: 3500, rustle: 0.15, rumble: 0.1 }, r.fork('air'))
    if (I <= 0) return finishScene(sc, SPACES.farmyard, r.fork('space'), -14.5)
    // roosters answer each other
    if (q.rooster) {
      const rr = r.fork('roosters')
      const birds = [0, 1].map((i) => ({ k: R(rr, 0.88, 1.12), pan: drawPan(rr, 0.85), dist: drawDist(rr, Math.max(25, d * 3), 0.4, 15, 300) }))
      let t = R(rr, 0.5, 2.5)
      let who = rr.int(2)
      while (t < sc.dur) {
        const b = birds[who]
        const ev = crow(sc.sr, rr, b.k * R(rr, 0.98, 1.02))
        emit(sc, ev, t * sc.sr, b.pan, b.dist, 2.2, 0.55)
        t += ev.length / sc.sr + (rr.next() < 0.6 ? R(rr, 1, 3.5) : R(rr, 5, 14) / (0.4 + I))
        who = rr.next() < 0.65 ? 1 - who : who
      }
    }
    // hens scratching and clucking near
    const hn = Math.round((q.hens / 100) * (2 + I * 5))
    for (let h = 0; h < hn; h++) {
      const hr = r.fork('hen' + h)
      const k = R(hr, 0.9, 1.12)
      let pan = drawPan(hr)
      let dist = drawDist(hr, d * 0.7, 0.4, 2, 60)
      let t = R(hr, 0, 4)
      while (t < sc.dur) {
        const ev = clucks(sc.sr, hr, k)
        emit(sc, ev, t * sc.sr, pan, dist, 0.75, 0.35)
        t += ev.length / sc.sr + R(hr, 1.5, 8)
        pan = clamp(pan + R(hr, -0.2, 0.2), -0.95, 0.95)
        dist = clamp(dist * R(hr, 0.85, 1.15), 2, 60)
      }
    }
    // sparrows in the eaves
    const sr2 = r.fork('sparrows')
    const ns = 2 + Math.round(I * 4)
    for (let s = 0; s < ns; s++) {
      const F = R(sr2, 2900, 3800)
      const pan = drawPan(sr2)
      const dist = drawDist(sr2, d, 0.4, 3, 60)
      let t = R(sr2, 0, 5)
      while (t < sc.dur) {
        const k = 3 + sr2.int(12)
        for (let i = 0; i < k; i++) {
          const ev = renderNotes(chirp(sr2, F * R(sr2, 0.95, 1.05)), sc.sr, sr2)
          emit(sc, ev, (t + i * R(sr2, 0.22, 0.5)) * sc.sr, pan, dist, 0.35, 0.35)
        }
        t += k * 0.36 + R(sr2, 2, 10)
      }
    }
    // pigeons cooing on the roof
    const doves = makeSingers(['dove', 'dove'], r.fork('pigeons'), { dist: d * 0.5, gainMul: 0.7 })
    runSingers(sc, doves, r.fork('coo'), { rate: 0.5 + 0.5 * I, start: [2, 9] })
    if (q.cows) {
      const cr = r.fork('cow')
      const pan = drawPan(cr, 0.8)
      let t = R(cr, 3, 9)
      while (t < sc.dur) {
        const ev = moo(sc.sr, cr)
        emit(sc, ev, t * sc.sr, pan, R(cr, 90, 180), 4.5, 0.6)
        t += ev.length / sc.sr + R(cr, 8, 22)
      }
    }
    addFlyBys(sc, r.fork('fly'), { kind: 'fly', rate: 2 + 3 * I, closest: 1.2, gain: 1, send: 0.2, first: R(r, 4, 10) })
    return finishScene(sc, SPACES.farmyard, r.fork('space'), -14.5)
  },
}

export default bed
