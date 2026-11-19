// beds/night-crickets.js - A warm night of crickets, and the insect engine the other beds use.
//
// Crickets sing by rubbing a toothed file against a scraper; a tuned "harp"
// on the wing rings at the tooth rate, so each sound pulse is an almost pure
// tone near 4 to 5 kHz (field crickets) or 2.5 to 3 kHz (tree crickets).
// Pulses come in chirps of three to five, and the chirp rate rises with
// temperature (Dolbear, "The cricket as a thermometer", The American
// Naturalist, 1897: about four chirps a minute more per degree Fahrenheit).
// Here each individual has its own pitch, pulse count, pulse length and
// rate, drifts a little, and sometimes stops for a breath. Tree crickets
// fall into step with each other (they entrain to their neighbours, as
// described by Walker, "Acoustic synchrony: two mechanisms in the snowy tree
// cricket", Science 1969), which gives that pulsing night-wide beat.
//
// Katydids are raspier: a tooth-strike pulse train (hundreds of strikes a
// second) rings two broad resonances, three or so pulses per call
// ("ka-ty-did"), and neighbours answer each other in turn. Cicadas: tymbal
// clicks at a few hundred per second exciting an abdomen resonance, a slow
// swell, a throb, and the falling whine at the end. Grasshoppers: short
// rasps of noisy tooth strikes in series. All filtering is RBJ-cookbook band
// pass or the TPT state-variable band pass (Zavalishin, "The Art of VA
// Filter Design"), written inline over each event.
//
// Named exports for other beds: addCrickets, addTrillers, addKatydids,
// addCicadas, addGrasshoppers, raspCall, cicadaSong.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, renderNote, drawPan, drawDist, SPACES, clamp } from './forest-birds.js'

const TAU = Math.PI * 2
const TINY = 1e-20

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

// Constant-peak band pass over buf (RBJ cookbook), added into out with gain g.
function bandInto(buf, out, sr, f, q, g) {
  if (f >= 0.45 * sr) return
  const w0 = (TAU * f) / sr
  const al = Math.sin(w0) / (2 * q)
  const a0 = 1 + al
  const b0 = al / a0
  const a1 = (-2 * Math.cos(w0)) / a0
  const a2 = (1 - al) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const n = buf.length
  for (let i = 0; i < n; i++) {
    const x = buf[i]
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y < TINY && y > -TINY ? 0 : y
    out[i] += y1 * g
  }
}

/**
 * Field and tree crickets. o: { count, dist (nearest typical, m), spread,
 * warmth 0..1, kind 'field'|'tree'|'mixed', gain, send, pitch (factor) }.
 */
export function addCrickets(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 10)))
  if (!count || !sc.n) return
  const warm = clamp(num(o.warmth, 0.5), 0, 1)
  const kind = o.kind || 'mixed'
  const dist = num(o.dist, 8)
  const gain = num(o.gain, 1)
  const send = num(o.send, 0.4)
  const pitch = num(o.pitch, 1)
  const tempo = 1.25 - 0.5 * warm
  const nt = { t: 0, d: 0.015, f0: 4800, f1: 4700, h2: 0.08, h3: 0.02, att: 0.003, rel: 0.007, a: 1, swell: 0.2 }
  // shared beat for tree crickets
  const beat = 1 / ((1.3 + 1.7 * warm) * R(rng, 0.92, 1.08))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('cricket' + c)
    const tree = kind === 'tree' || (kind === 'mixed' && c % 3 === 2)
    // the first few are near, the rest fade into a far chorus
    const d = c < 3 ? drawDist(r, dist, 0.35, 1, 60) : drawDist(r, dist * (2 + c * 0.6), 0.4, 3, 400)
    const pan = drawPan(r)
    const g = gain * (0.75 + 0.5 * r.next())
    if (tree) {
      const fc = pitch * R(r, 2500, 2950) * (0.92 + 0.16 * warm)
      const pd = R(r, 0.045, 0.07) * tempo
      const off = R(r, -0.02, 0.02)
      const amR = R(r, 110, 170)
      let k = Math.floor(R(r, -2, 0) / beat)
      let silentUntil = -1
      while (true) {
        const t = k * beat + off + 0.012 * r.gauss()
        k++
        if (t > sc.dur) break
        if (t < silentUntil) continue
        if (r.next() < 0.015) silentUntil = t + R(r, 1, 4)
        if (r.next() < 0.06) continue
        const len = Math.ceil((pd + 0.01) * sr)
        const ev = new Float32Array(len)
        nt.t = 0; nt.d = pd; nt.f0 = fc * 1.01; nt.f1 = fc * 0.99; nt.h2 = 0.06; nt.h3 = 0.015
        nt.att = pd * 0.3; nt.rel = pd * 0.35; nt.a = 0.8 + 0.2 * r.next(); nt.swell = 0.2
        nt.amR = amR; nt.amD = 0.35
        renderNote(ev, sr, nt, r)
        emit(sc, ev, t * sr, pan, d, g * 0.8, send)
      }
      nt.amR = 0
      nt.amD = 0
    } else {
      const fc = pitch * R(r, 4200, 5200)
      const np = 3 + r.int(3)
      const pd = R(r, 0.011, 0.018) * tempo
      const pp = pd + R(r, 0.01, 0.016) * tempo
      const rate = (1 + 2.3 * warm) * R(r, 0.8, 1.2)
      let t = R(r, -0.5, 1.2)
      let drift = 0
      while (t < sc.dur) {
        const len = Math.ceil((np * pp + 0.01) * sr)
        const ev = new Float32Array(len)
        for (let p = 0; p < np; p++) {
          nt.t = p * pp; nt.d = pd; nt.f0 = fc * 1.012; nt.f1 = fc * 0.985; nt.h2 = 0.08; nt.h3 = 0.02
          nt.att = pd * 0.22; nt.rel = pd * 0.5; nt.a = (p === 0 ? 0.75 : 1) * (0.9 + 0.1 * r.next()); nt.swell = 0.2
          renderNote(ev, sr, nt, r)
        }
        if (t + len / sr > 0) emit(sc, ev, t * sr, pan, d, g, send)
        drift = clamp(drift + 0.02 * r.gauss(), -0.12, 0.12)
        t += (1 / rate) * (1 + drift) * (1 + 0.04 * r.gauss())
        if (r.next() < 0.012) t += R(r, 1, 5)
      }
    }
  }
}

/** Long trills of tiny ground crickets: o { count, dist, gain, send }. */
export function addTrillers(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 2)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('triller' + c)
    const fc = R(r, 5600, 7400)
    const pr = R(r, 28, 60)
    const pan = drawPan(r)
    const d = drawDist(r, num(o.dist, 10), 0.4, 1, 300)
    let t = R(r, -4, 2)
    while (t < sc.dur) {
      const bout = R(r, 3, 12)
      const len = Math.ceil((bout + 0.02) * sr)
      const ev = new Float32Array(len)
      renderNote(ev, sr, { t: 0, d: bout, f0: fc, f1: fc * 0.995, h2: 0.05, amR: pr, amD: 0.92, att: 0.4, rel: 0.3, a: 1 }, r)
      emit(sc, ev, t * sr, pan, d, num(o.gain, 0.5), num(o.send, 0.4))
      t += bout + R(r, 0.5, 5)
    }
  }
}

/**
 * A rasped call: pulses of tooth strikes ringing two broad resonances.
 * spec: { pulses: [[t, d, amp], ...], tooth (strikes per second), jitter
 * (0..0.5), f1, q1, f2, q2, g2, noise (0..1), cascade (run the main band
 * twice for a cleaner, steeper band) }. Returns a Float32Array.
 */
export function raspCall(sr, rng, spec) {
  const pulses = spec.pulses || []
  let end = 0
  for (const p of pulses) end = Math.max(end, p[0] + p[1])
  const len = Math.ceil((end + 0.03) * sr)
  const exc = new Float32Array(len)
  const tooth = Math.max(20, num(spec.tooth, 800))
  const jit = clamp(num(spec.jitter, 0.15), 0, 0.6)
  const nz = clamp(num(spec.noise, 0.2), 0, 1)
  for (const [t0, d, amp] of pulses) {
    const s = Math.round(t0 * sr)
    const e = Math.min(len, s + Math.round(d * sr))
    // noise share
    if (nz > 0) {
      for (let i = s; i < e; i++) {
        const u = (i - s) / Math.max(1, e - s)
        const env = Math.sin(Math.PI * Math.min(1, u * 1.6)) * (u < 0.62 ? 1 : 1 - (u - 0.62) / 0.38)
        exc[i] += nz * amp * env * (rng.next() * 2 - 1) * 0.5
      }
    }
    let t = t0
    while (t < t0 + d) {
      const i = Math.round(t * sr)
      if (i >= len) break
      const u = (t - t0) / d
      const env = Math.sin(Math.PI * Math.min(1, u * 1.6)) * (u < 0.62 ? 1 : 1 - (u - 0.62) / 0.38)
      exc[i] += amp * env * (0.7 + 0.6 * rng.next()) * (1 - nz * 0.5)
      t += (1 / tooth) * (1 + jit * (rng.next() * 2 - 1))
    }
  }
  const out = new Float32Array(len)
  if (spec.cascade) {
    // two band passes in series: a cleaner band, no low tooth-rate leakage
    const mid = new Float32Array(len)
    bandInto(exc, mid, sr, num(spec.f1, 5000), num(spec.q1, 4), 1)
    bandInto(mid, out, sr, num(spec.f1, 5000), num(spec.q1, 4), 2)
  } else bandInto(exc, out, sr, num(spec.f1, 5000), num(spec.q1, 4), 1.4)
  if (num(spec.g2, 0) > 0) bandInto(exc, out, sr, num(spec.f2, 9000), num(spec.q2, 3), 1.4 * spec.g2)
  return out
}

/** Katydids answering each other: o { count, dist, gain, send }. */
export function addKatydids(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 3)))
  if (!count) return
  // pairs alternate: the second waits for the first
  const callers = []
  for (let c = 0; c < count; c++) {
    const r = rng.fork('katydid' + c)
    callers.push({
      r,
      pan: drawPan(r),
      dist: drawDist(r, num(o.dist, 12), 0.45, 2, 300),
      f1: R(r, 4200, 5600),
      tooth: R(r, 600, 1100),
      pd: R(r, 0.035, 0.06),
      sp: R(r, 0.12, 0.16),
      period: R(r, 0.85, 1.4),
      g: num(o.gain, 0.8) * (0.7 + 0.6 * r.next()),
    })
  }
  for (let c = 0; c < count; c++) {
    const k = callers[c]
    const r = k.r
    const lead = c % 2 === 0
    let t = R(r, -0.5, 1) + (lead ? 0 : k.period * 0.5)
    let bout = R(r, 4, 14)
    let boutEnd = t + bout
    while (t < sc.dur) {
      const np = r.next() < 0.6 ? 3 : r.next() < 0.6 ? 2 : 4
      const pulses = []
      for (let p = 0; p < np; p++) pulses.push([p * k.sp, k.pd * (p === np - 1 ? 1.15 : 1), p === 0 ? 0.8 : 1])
      const ev = raspCall(sr, r, { pulses, tooth: k.tooth, jitter: 0.2, f1: k.f1, q1: 3, f2: k.f1 * 1.9, q2: 2.5, g2: 0.3, noise: 0.25, cascade: true })
      emit(sc, ev, t * sr, k.pan, k.dist, k.g, num(o.send, 0.45))
      t += k.period * (1 + 0.05 * r.gauss())
      if (t > boutEnd) {
        t += R(r, 1, 6)
        boutEnd = t + R(r, 4, 14)
      }
    }
  }
}

/**
 * One cicada song. spec: { dur, att, rel, rate (clicks per second), rate0
 * (start rate, for accelerating singers), fc, q, amR, amD, drop (pitch
 * fall at the end, 0..0.4), noise }. Returns a Float32Array.
 */
export function cicadaSong(sr, rng, spec) {
  const dur = Math.max(0.2, num(spec.dur, 8))
  const len = Math.ceil(dur * sr)
  const att = Math.max(0.05, num(spec.att, 2))
  const rel = Math.max(0.05, num(spec.rel, 1.8))
  const rate = Math.max(5, num(spec.rate, 420))
  const rate0 = Math.max(2, num(spec.rate0, rate))
  const fc = num(spec.fc, 4800)
  const q = Math.max(0.5, num(spec.q, 6))
  const amR = num(spec.amR, 9)
  const amD = clamp(num(spec.amD, 0.3), 0, 1)
  const drop = clamp(num(spec.drop, 0.18), 0, 0.5)
  const nz = clamp(num(spec.noise, 0.25), 0, 1)
  const exc = new Float32Array(len)
  // click train
  let t = 0
  while (t < dur) {
    const u = t / dur
    const tr = t > dur - rel ? (dur - t) / rel : 1
    const ta = t < att ? t / att : 1
    const rNow = rate0 + (rate - rate0) * Math.min(1, ta * ta) - rate * 0.25 * (1 - tr)
    const i = Math.round(t * sr)
    if (i >= len) break
    let env = Math.min(1, t / att)
    env = env * env * (3 - 2 * env)
    if (t > dur - rel) env *= Math.max(0, (dur - t) / rel)
    env *= 1 - amD * (0.5 + 0.5 * Math.cos(TAU * amR * t))
    // a click train's harmonics are 2 rate / sr tall: scale so the band sits near full level
    exc[i] += env * (0.8 + 0.4 * rng.next()) * Math.min(40, sr / (8 * Math.max(5, rNow)))
    t += (1 / Math.max(5, rNow)) * (1 + 0.04 * (rng.next() * 2 - 1))
    if (u > 1) break
  }
  if (nz > 0) {
    for (let i = 0; i < len; i++) {
      const tt = i / sr
      let env = Math.min(1, tt / att)
      if (tt > dur - rel) env *= Math.max(0, (dur - tt) / rel)
      exc[i] += nz * env * 0.5 * (rng.next() * 2 - 1)
    }
  }
  // time-varying band pass (TPT state variable), corner falls in the release
  const out = new Float32Array(len)
  const lim = 0.45 * sr
  const k = 1 / q
  let ic1 = 0, ic2 = 0, jc1 = 0, jc2 = 0, mc1 = 0, mc2 = 0
  const B = 32
  for (let b = 0; b < len; b += B) {
    const e = b + B < len ? b + B : len
    const tt = b / sr
    const fall = tt > dur - rel ? (tt - (dur - rel)) / rel : 0
    const f = Math.min(lim * 0.95, fc * (1 - drop * fall * fall))
    const f2 = Math.min(lim * 0.95, f * 1.92)
    const g = Math.tan((Math.PI * f) / sr)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const g2 = Math.tan((Math.PI * f2) / sr)
    const k2 = 1 / (q * 0.6)
    const c1 = 1 / (1 + g2 * (g2 + k2))
    const c2 = g2 * c1
    const c3 = g2 * c2
    for (let i = b; i < e; i++) {
      const x = exc[i]
      let v3 = x - ic2
      let v1 = a1 * ic1 + a2 * v3
      let v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      // second stage of the main band, in series
      const x2 = v1 * k
      v3 = x2 - mc2
      v1 = a1 * mc1 + a2 * v3
      v2 = mc2 + a2 * mc1 + a3 * v3
      mc1 = 2 * v1 - mc1
      mc2 = 2 * v2 - mc2
      const bp = v1 * k
      v3 = x - jc2
      const u1 = c1 * jc1 + c2 * v3
      const u2 = jc2 + c2 * jc1 + c3 * v3
      jc1 = 2 * u1 - jc1
      jc2 = 2 * u2 - jc2
      out[i] = (bp + u1 * k2 * 0.3) * 2.2
    }
    if (!(ic1 > -1e9 && ic1 < 1e9)) ic1 = ic2 = 0
    if (!(mc1 > -1e9 && mc1 < 1e9)) mc1 = mc2 = 0
    if (!(jc1 > -1e9 && jc1 < 1e9)) jc1 = jc2 = 0
  }
  return out
}

/**
 * Cicadas swelling and fading in the trees. o: { count (singers at once on
 * average), dist, gain, send, kind: 'whine'|'rise' (tropical accelerating) }.
 */
export function addCicadas(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, num(o.count, 1.5))
  if (!(count > 0) || !sc.n) return
  const lanes = Math.max(1, Math.ceil(count))
  for (let l = 0; l < lanes; l++) {
    const r = rng.fork('cicada' + l)
    const share = Math.min(1, count - l)
    let t = l === 0 ? R(r, -6, 0.5) : R(r, -4, 8) / Math.max(0.3, share)
    while (t < sc.dur) {
      const rise = o.kind === 'rise'
      const dur = rise ? R(r, 5, 9) : R(r, 7, 15)
      const spec = rise
        ? { dur, att: dur * 0.55, rel: 0.25, rate: R(r, 240, 330), rate0: R(r, 12, 25), fc: R(r, 3600, 5200), q: 7, amR: R(r, 3, 6), amD: 0.15, drop: 0.05, noise: 0.15 }
        : { dur, att: R(r, 1.2, 2.5), rel: R(r, 1.4, 2.4), rate: R(r, 360, 520), fc: R(r, 4300, 5600), q: R(r, 5, 8), amR: R(r, 6, 14), amD: R(r, 0.2, 0.4), drop: R(r, 0.12, 0.22), noise: 0.25 }
      const ev = cicadaSong(sr, r, spec)
      emit(sc, ev, t * sr, drawPan(r, 0.9), drawDist(r, num(o.dist, 25), 0.35, 4, 400), num(o.gain, 0.5) * (0.7 + 0.6 * r.next()), num(o.send, 0.4))
      t += dur + R(r, 1, 9) / Math.max(0.3, share)
    }
  }
}

/** Grasshoppers rasping in short series: o { count, dist, gain, send }. */
export function addGrasshoppers(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 3)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('hopper' + c)
    const pan = drawPan(r)
    const d = drawDist(r, num(o.dist, 6), 0.5, 1, 100)
    const f1 = R(r, 6500, 9500)
    const tooth = R(r, 180, 420)
    const rd = R(r, 0.08, 0.2)
    const per = R(r, 0.18, 0.32)
    let t = R(r, 0, 6)
    while (t < sc.dur) {
      const reps = 5 + r.int(12)
      const pulses = []
      for (let k = 0; k < reps; k++) pulses.push([k * per, rd * (0.9 + 0.2 * r.next()), k === 0 ? 0.6 : 1])
      const ev = raspCall(sr, r, { pulses, tooth, jitter: 0.35, f1, q1: 1.8, f2: f1 * 1.5, q2: 2, g2: 0.4, noise: 0.6, cascade: true })
      emit(sc, ev, t * sr, pan, d, num(o.gain, 0.5) * (0.7 + 0.6 * r.next()), num(o.send, 0.3))
      t += ev.length / sr + R(r, 2, 9)
    }
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'night-crickets',
  name: 'Night crickets',
  group: 'nature',
  about: 'A warm summer night: crickets near and far, katydids answering each other, a still breeze.',
  params: [
    { id: 'intensity', name: 'How many crickets', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'warmth', name: 'Warm night', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent' },
    { id: 'kind', name: 'Crickets', type: 'choice', def: 'mixed', options: [{ v: 'mixed', name: 'Field and tree crickets' }, { v: 'field', name: 'Field crickets' }, { v: 'tree', name: 'Tree crickets in time' }] },
    { id: 'katydids', name: 'Katydids', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent' },
    { id: 'distance', name: 'Nearest cricket', type: 'number', min: 1, max: 40, step: 1, def: 6, unit: 'meters' },
    { id: 'breeze', name: 'Breeze', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('night-crickets')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    addAir(sc, { hushDb: -58, wind: 0.05 + 0.8 * (q.breeze / 100), gust: 0.5, body: 380, foliage: 0.35, foliageHz: 3000, rustle: 0.12, rumble: 0.08 }, r.fork('air'))
    const count = Math.round(I * 22)
    addCrickets(sc, r.fork('crickets'), { count, dist: q.distance, warmth: q.warmth / 100, kind: q.kind, gain: 0.55, send: 0.45 })
    if (I > 0.3 && q.kind !== 'tree') addTrillers(sc, r.fork('trill'), { count: 1 + Math.round(I), dist: q.distance * 3, gain: 0.18, send: 0.4 })
    const kc = Math.round((q.katydids / 100) * 5)
    if (kc > 0) addKatydids(sc, r.fork('katydids'), { count: kc, dist: q.distance * 2.5 + 6, gain: 0.55, send: 0.5 })
    return finishScene(sc, SPACES.night, r.fork('space'), -13.5)
  },
}

export default bed
