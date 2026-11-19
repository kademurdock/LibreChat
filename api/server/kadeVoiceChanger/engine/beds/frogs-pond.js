// beds/frogs-pond.js - A spring pond at night, and the frog and small-water engine.
//
// Frog calls are built from what their spectrograms show:
// - peepers: a single rising whistle near 3 kHz, about a tenth of a second,
//   repeated about once a second; a chorus of them is the sleigh-bell sound
//   of a spring night;
// - chorus frogs: a rising train of short clicks, like a thumbnail run
//   along a comb (built with the insect rasp from night-crickets.js);
// - toads: a long, sweet trill (a 1.6 to 2 kHz tone pulsed 30 to 45 times a
//   second) lasting many seconds;
// - tree frogs: a short loud trill with two spectral peaks;
// - green frogs: the "gunk" of a loose banjo string, made with the
//   Karplus-Strong plucked string (Karplus and Strong, Computer Music
//   Journal 1983) with a short noisy pluck;
// - deep croakers: a low pulse train (about 100 per second) ringing a
//   throat-and-sac resonance near 230 Hz and a second one near 1.2 kHz,
//   with a rough wobble, in the "jug-o-rum" rhythm, kept at a distance.
// Water: bubbles are Minnaert resonances whose pitch rises as they reach
// the surface (van den Doel, "Physically based models for liquid sounds",
// ACM Transactions on Applied Perception 2005); a frog jumping in is a short
// splash of noise plus a few bubbles; lapping is soft low noise swells with
// gurgles; drips are a tick plus one small bright bubble.
//
// Named exports: addPeepers, addChorusFrogs, addToads, addTreeFrogs,
// addGreenFrogs, addDeepCroakers, addCricketFrogs, bubbleInto, addPlops,
// addMudBubbles, addDrips, addLapping, addTinks.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, renderNote, drawPan, drawDist, SPACES, clamp } from './forest-birds.js'
import { raspCall, addCrickets } from './night-crickets.js'

const TAU = Math.PI * 2
const TINY = 1e-20

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function bandInto(buf, out, sr, f, q, g) {
  if (f >= 0.45 * sr) return
  const w0 = (TAU * f) / sr
  const al = Math.sin(w0) / (2 * q)
  const a0 = 1 + al
  const b0 = al / a0
  const a1 = (-2 * Math.cos(w0)) / a0
  const a2 = (1 - al) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y < TINY && y > -TINY ? 0 : y
    out[i] += y1 * g
  }
}

/** Peepers: o { count, dist, gain, send }. */
export function addPeepers(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 12)))
  const nt = { t: 0, d: 0.12, f0: 2700, f1: 3000, bend: 0.7, h2: 0.06, h3: 0.01, att: 0.012, rel: 0.03, swell: 0.3, a: 1 }
  for (let c = 0; c < count; c++) {
    const r = rng.fork('peeper' + c)
    const f = R(r, 2650, 3150)
    const d0 = R(r, 0.09, 0.15)
    const per = R(r, 0.6, 1.3)
    const pan = drawPan(r)
    const dist = c < 2 ? drawDist(r, num(o.dist, 10), 0.3, 1, 200) : drawDist(r, num(o.dist, 10) * (1.5 + c * 0.25), 0.4, 2, 400)
    const g = num(o.gain, 0.6) * (0.7 + 0.6 * r.next())
    let t = R(r, -1, 1.5)
    let boutEnd = t + R(r, 6, 30)
    while (t < sc.dur) {
      const len = Math.ceil((d0 + 0.03) * sr)
      const ev = new Float32Array(len)
      nt.d = d0 * (0.92 + 0.16 * r.next())
      nt.f0 = f * 0.9
      nt.f1 = f * (1.03 + 0.02 * r.next())
      renderNote(ev, sr, nt, r)
      emit(sc, ev, t * sr, pan, dist, g, num(o.send, 0.45))
      t += per * (1 + 0.08 * r.gauss())
      if (t > boutEnd) {
        t += R(r, 1, 6)
        boutEnd = t + R(r, 6, 30)
      }
    }
  }
}

/** Chorus frogs: rising click trains. o { count, dist, gain, send }. */
export function addChorusFrogs(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 4)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('chorusfrog' + c)
    const f = R(r, 2500, 3300)
    const pan = drawPan(r)
    const dist = drawDist(r, num(o.dist, 12), 0.45, 2, 300)
    const g = num(o.gain, 0.6) * (0.7 + 0.6 * r.next())
    let t = R(r, -1, 2)
    while (t < sc.dur) {
      const np = 10 + r.int(9)
      const pulses = []
      let tt = 0
      let per = R(r, 0.07, 0.085)
      for (let k = 0; k < np; k++) {
        pulses.push([tt, 0.007, 0.6 + 0.4 * Math.min(1, k / 4)])
        tt += per
        per *= 0.965
      }
      const ev = raspCall(sr, r, { pulses, tooth: 1300, jitter: 0.25, f1: f, q1: 4.5, f2: f * 2.05, q2: 4, g2: 0.35, noise: 0.35 })
      emit(sc, ev, t * sr, pan, dist, g, num(o.send, 0.45))
      t += ev.length / sr + R(r, 0.6, 2.2)
    }
  }
}

/** Toads: long sweet trills. o { count, dist, gain, send }. */
export function addToads(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 2)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('toad' + c)
    const f = R(r, 1500, 2000)
    const pr = R(r, 30, 45)
    const pan = drawPan(r)
    const dist = drawDist(r, num(o.dist, 15), 0.4, 2, 300)
    let t = c === 0 ? R(r, -3, 1) : R(r, 0, 12)
    while (t < sc.dur) {
      const dur = R(r, 4, 13)
      const ev = new Float32Array(Math.ceil((dur + 0.05) * sr))
      renderNote(ev, sr, { t: 0, d: dur, f0: f * 0.99, f1: f * 0.97, h2: 0.15, h3: 0.04, amR: pr, amD: 0.93, fmR: R(r, 2, 4), fmD: 0.004, att: 0.5, rel: 0.25, a: 1 }, r)
      emit(sc, ev, t * sr, pan, dist, num(o.gain, 0.45) * (0.8 + 0.4 * r.next()), num(o.send, 0.5))
      t += dur + R(r, 5, 22)
    }
  }
}

/** Tree frogs: short loud trills. o { count, dist, gain, send }. */
export function addTreeFrogs(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 3)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('treefrog' + c)
    const f = R(r, 1050, 1250)
    const pr = R(r, 18, 30)
    const pan = drawPan(r)
    const dist = drawDist(r, num(o.dist, 12), 0.4, 2, 300)
    let t = R(r, 0, 6)
    while (t < sc.dur) {
      const dur = R(r, 0.35, 0.9)
      const ev = new Float32Array(Math.ceil((dur + 0.05) * sr))
      renderNote(ev, sr, { t: 0, d: dur, f0: f, f1: f * 0.98, h2: 0.8, h3: 0.25, h4: 0.1, amR: pr, amD: 0.95, att: 0.04, rel: 0.05, a: 0.8 }, r)
      emit(sc, ev, t * sr, pan, dist, num(o.gain, 0.5) * (0.8 + 0.4 * r.next()), num(o.send, 0.5))
      t += dur + R(r, 3, 10)
    }
  }
}

/** Karplus-Strong pluck: a loose string "gunk". Returns a Float32Array. */
export function pluck(sr, rng, f, dur, bright = 0.5) {
  const len = Math.ceil(dur * sr)
  const out = new Float32Array(len)
  const p = Math.max(2, Math.round(sr / f))
  const line = new Float32Array(p)
  // noisy pluck, low passed by brightness
  let s = 0
  const c = 0.2 + 0.7 * clamp(bright, 0, 1)
  for (let i = 0; i < p; i++) {
    s += c * (rng.next() * 2 - 1 - s)
    line[i] = s
  }
  const loss = Math.exp(-1 / (dur * 0.35 * f))
  let idx = 0
  let prev = 0
  for (let i = 0; i < len; i++) {
    const x = line[idx]
    const y = 0.5 * (x + prev) * loss
    prev = x
    line[idx] = y < TINY && y > -TINY ? 0 : y
    out[i] = x
    if (++idx >= p) idx = 0
  }
  // gentle fade at the end so the event never clicks
  const fl = Math.min(len, Math.round(0.02 * sr))
  for (let i = 0; i < fl; i++) out[len - 1 - i] *= i / fl
  return out
}

/** Green frogs: one to four twangy gunks. o { count, dist, gain, send }. */
export function addGreenFrogs(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 2)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('greenfrog' + c)
    const f = R(r, 170, 260)
    const pan = drawPan(r)
    const dist = drawDist(r, num(o.dist, 12), 0.4, 2, 200)
    let t = R(r, 0.5, 8)
    while (t < sc.dur) {
      const k = 1 + r.int(4)
      for (let i = 0; i < k; i++) {
        const raw = pluck(sr, r, f * (1 - 0.03 * i), R(r, 0.18, 0.28), 0.45)
        // a throat resonance and a little body
        const ev = new Float32Array(raw.length)
        bandInto(raw, ev, sr, R(r, 500, 700), 2.5, 1.4)
        for (let j = 0; j < raw.length; j++) ev[j] += raw[j] * 0.2
        emit(sc, ev, (t + i * R(r, 0.3, 0.5)) * sr, pan, dist, num(o.gain, 0.6) * (1 - 0.15 * i), num(o.send, 0.5))
      }
      t += k * 0.45 + R(r, 4, 16)
    }
  }
}

/**
 * Deep croaker call ("jug-o-rum"): a pulse train ringing throat resonances.
 * Returns a Float32Array.
 */
export function croak(sr, rng, f0, dur) {
  const len = Math.ceil((dur + 0.08) * sr)
  const exc = new Float32Array(len)
  const jug = dur * R(rng, 0.15, 0.22)
  const gap = dur * 0.06
  const wob = R(rng, 9, 16)
  let t = 0.002
  while (t < dur) {
    let env
    if (t < jug) env = Math.sin((Math.PI * t) / jug) * 0.75
    else if (t < jug + gap) env = 0.05
    else {
      const u = (t - jug - gap) / (dur - jug - gap)
      env = Math.min(1, u * 6) * (u > 0.75 ? (1 - u) / 0.25 : 1)
    }
    env *= 0.75 + 0.25 * Math.sin(TAU * wob * t)
    const i = Math.round(t * sr)
    if (i + 1 < len) {
      exc[i] += env
      exc[i + 1] -= env * 0.5
    }
    const fNow = f0 * (t < jug ? 1.08 : 1 - 0.06 * ((t - jug) / dur))
    t += (1 / fNow) * (1 + 0.025 * (rng.next() * 2 - 1))
  }
  const out = new Float32Array(len)
  // an impulse train's harmonics are 2 f0 / sr tall: scale so the throat peak sits near 1
  const k = (0.15 * sr) / f0
  bandInto(exc, out, sr, R(rng, 210, 260), 3, 0.5 * k)
  bandInto(exc, out, sr, R(rng, 1100, 1350), 5, 0.22 * k)
  bandInto(exc, out, sr, R(rng, 2300, 2600), 4, 0.05 * k)
  return out
}

/** Deep croakers, kept at a distance. o { count, dist, gain, send }. */
export function addDeepCroakers(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 1)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('croaker' + c)
    const f0 = R(r, 92, 125)
    const pan = drawPan(r, 0.85)
    const dist = drawDist(r, Math.max(18, num(o.dist, 30)), 0.35, 12, 300)
    let t = R(r, 0.5, 10)
    while (t < sc.dur) {
      const k = 2 + r.int(5)
      for (let i = 0; i < k; i++) {
        const ev = croak(sr, r, f0, R(r, 0.5, 0.85))
        emit(sc, ev, (t + i * R(r, 0.9, 1.3)) * sr, pan, dist, num(o.gain, 0.9), num(o.send, 0.6))
      }
      t += k * 1.2 + R(r, 8, 25)
    }
  }
}

/** Cricket frogs: dry "gick" clicks speeding up. o { count, dist, gain, send }. */
export function addCricketFrogs(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 2)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('cricketfrog' + c)
    const f = R(r, 3200, 3800)
    const pan = drawPan(r)
    const dist = drawDist(r, num(o.dist, 10), 0.4, 2, 200)
    let t = R(r, 0, 6)
    while (t < sc.dur) {
      const k = 8 + r.int(20)
      const pulses = []
      let tt = 0
      let per = R(r, 0.45, 0.6)
      for (let i = 0; i < k; i++) {
        pulses.push([tt, 0.018, 0.7 + 0.3 * Math.min(1, i / 5)])
        tt += per
        per = Math.max(0.1, per * 0.9)
      }
      const ev = raspCall(sr, r, { pulses, tooth: 260, jitter: 0.1, f1: f, q1: 6, f2: f * 0.5, q2: 3, g2: 0.3, noise: 0.15 })
      emit(sc, ev, t * sr, pan, dist, num(o.gain, 0.6), num(o.send, 0.45))
      t += ev.length / sr + R(r, 3, 12)
    }
  }
}

/**
 * Add one Minnaert bubble into out at sample off: f0 Hz, tau (decay, s),
 * rise (pitch rise factor over the decay), amp.
 */
export function bubbleInto(out, off, sr, f0, tau, rise, amp) {
  const len = Math.min(out.length - off, Math.ceil(tau * 6 * sr))
  if (len <= 0 || off < 0) return
  const lim = 0.45 * sr
  let ph = 0
  const k = Math.exp(-1 / (tau * sr))
  let a = amp
  const att = Math.max(1, Math.round(0.0008 * sr))
  for (let i = 0; i < len; i++) {
    const t = i / sr
    const f = Math.min(lim, f0 * (1 + (rise * t) / tau))
    ph += (TAU * f) / sr
    const e = i < att ? i / att : 1
    out[off + i] += Math.sin(ph) * a * e
    a *= k
  }
}

/** Frogs jumping in: a splash and a few bubbles. o { rate (per minute), dist, gain, send }. */
export function addPlops(sc, rng, o = {}) {
  const sr = sc.sr
  const rate = Math.max(0, num(o.rate, 4)) / 60
  if (!(rate > 0)) return
  const r = rng.fork('plops')
  let t = R(r, 0.5, 5)
  while (t < sc.dur) {
    const len = Math.ceil(0.35 * sr)
    const ev = new Float32Array(len)
    // splash: noise burst, low passed
    const sl = Math.round(R(r, 0.03, 0.07) * sr)
    let s = 0
    const c = 1 - Math.exp((-TAU * R(r, 1500, 3500)) / sr)
    for (let i = 0; i < sl; i++) {
      s += c * (r.next() * 2 - 1 - s)
      ev[i] += s * Math.exp(-i / (sl * 0.3)) * 0.8
    }
    const nb = 1 + r.int(4)
    for (let k = 0; k < nb; k++) {
      bubbleInto(ev, Math.round(R(r, 0, 0.08) * sr), sr, R(r, 400, 1100), R(r, 0.012, 0.035), R(r, 0.1, 0.3), R(r, 0.2, 0.6))
    }
    emit(sc, ev, t * sr, drawPan(r, 0.8), drawDist(r, num(o.dist, 10), 0.4, 2, 100), num(o.gain, 0.5), num(o.send, 0.4))
    t += -Math.log(1 - r.next()) / rate
  }
}

/** Mud bubbles rising in a swamp: low "blup"s in little clusters. o { rate, dist, gain, send }. */
export function addMudBubbles(sc, rng, o = {}) {
  const sr = sc.sr
  const rate = Math.max(0, num(o.rate, 10)) / 60
  if (!(rate > 0)) return
  const r = rng.fork('mud')
  let t = R(r, 0.2, 3)
  while (t < sc.dur) {
    const nb = 1 + r.int(5)
    const len = Math.ceil((nb * 0.12 + 0.3) * sr)
    const ev = new Float32Array(len)
    let tt = 0
    for (let k = 0; k < nb; k++) {
      bubbleInto(ev, Math.round(tt * sr), sr, R(r, 140, 480), R(r, 0.02, 0.06), R(r, 0.15, 0.5), R(r, 0.4, 1))
      tt += R(r, 0.03, 0.12)
    }
    emit(sc, ev, t * sr, drawPan(r, 0.8), drawDist(r, num(o.dist, 6), 0.4, 2, 60), num(o.gain, 0.4), num(o.send, 0.35))
    t += -Math.log(1 - r.next()) / rate
  }
}

/** Drips from leaves: tick plus a small bright bubble. o { rate (per second), dist, gain, send }. */
export function addDrips(sc, rng, o = {}) {
  const sr = sc.sr
  const rate = Math.max(0, num(o.rate, 1))
  if (!(rate > 0)) return
  const r = rng.fork('drips')
  const spots = []
  for (let k = 0; k < 6; k++) spots.push({ pan: drawPan(r), dist: drawDist(r, num(o.dist, 6), 0.5, 1, 80), f: R(r, 1400, 3800), per: R(r, 1.5, 6) })
  let t = R(r, 0, 1)
  while (t < sc.dur) {
    const s = spots[r.int(spots.length)]
    const len = Math.ceil(0.12 * sr)
    const ev = new Float32Array(len)
    ev[0] += R(r, 0.2, 0.5)
    ev[1] -= 0.2
    bubbleInto(ev, Math.round(0.002 * sr), sr, s.f * R(r, 0.92, 1.08), R(r, 0.006, 0.016), R(r, 0.3, 0.9), R(r, 0.3, 0.8))
    emit(sc, ev, t * sr, s.pan, s.dist, num(o.gain, 0.4), num(o.send, 0.5))
    t += -Math.log(1 - r.next()) / rate
  }
}

/** Tropical "tink" frogs: tiny bright pings. o { count, dist, gain, send }. */
export function addTinks(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 6)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('tink' + c)
    const f = R(r, 2200, 4200)
    const pan = drawPan(r)
    const dist = drawDist(r, num(o.dist, 10), 0.5, 1, 200)
    const per = R(r, 0.5, 2.5)
    let t = R(r, -1, 2)
    while (t < sc.dur) {
      const reps = r.next() < 0.3 ? 2 + r.int(3) : 1
      const len = Math.ceil((reps * 0.12 + 0.05) * sr)
      const ev = new Float32Array(len)
      for (let k = 0; k < reps; k++) {
        renderNote(ev, sr, { t: k * R(r, 0.08, 0.12), d: R(r, 0.025, 0.045), f0: f * 1.02, f1: f * 0.98, h2: 0.12, att: 0.002, rel: 0.02, a: 1 }, r)
      }
      emit(sc, ev, t * sr, pan, dist, num(o.gain, 0.45), num(o.send, 0.55))
      t += per * (1 + 0.3 * r.gauss() * 0.5) + (r.next() < 0.05 ? R(r, 2, 8) : 0)
    }
  }
}

/** Water lapping at an edge or against a hull. o { level (0..1), dist, gain, send, size }. */
export function addLapping(sc, rng, o = {}) {
  const sr = sc.sr
  const n = sc.n
  const level = clamp(num(o.level, 0.4), 0, 1)
  if (!(level > 0) || !n) return
  const r = rng.fork('lap')
  const size = clamp(num(o.size, 1), 0.3, 3)
  // little waves every 1.5 to 4 seconds, each a few gurgles and a soft wash
  let t = R(r, -0.5, 1)
  while (t < sc.dur) {
    const dur = R(r, 0.5, 1.2) * size
    const len = Math.ceil((dur + 0.3) * sr)
    const ev = new Float32Array(len)
    // wash: noise through a sweeping low pass, raised-cosine swell
    let s1 = 0, s2 = 0
    const fTop = R(r, 700, 1600) / Math.sqrt(size)
    for (let i = 0; i < Math.min(len, Math.round(dur * sr)); i++) {
      const u = i / (dur * sr)
      const env = Math.sin(Math.PI * Math.min(1, u * 1.4)) * (u < 0.7 ? 1 : (1 - u) / 0.3)
      const fc = 150 + fTop * env
      const c = 1 - Math.exp((-TAU * fc) / sr)
      s1 += c * (r.next() * 2 - 1 - s1)
      s2 += c * (s1 - s2)
      ev[i] += s2 * env * 0.9
    }
    // gurgles and slaps
    const ng = 2 + r.int(6)
    for (let k = 0; k < ng; k++) {
      const off = Math.round(R(r, 0.05, dur) * sr)
      bubbleInto(ev, off, sr, R(r, 180, 700) / Math.sqrt(size), R(r, 0.01, 0.04), R(r, 0.05, 0.4), R(r, 0.05, 0.25))
    }
    emit(sc, ev, t * sr, drawPan(r, 0.7), drawDist(r, num(o.dist, 4), 0.3, 0.5, 60), num(o.gain, 0.6) * level, num(o.send, 0.3))
    t += R(r, 1.2, 3.8) * Math.sqrt(size) * 0.7
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'frogs-pond',
  name: 'Frog pond',
  group: 'nature',
  about: 'A spring pond after dark: peepers ringing, trilling toads, twangy frogs, and the odd splash.',
  params: [
    { id: 'intensity', name: 'Frog chorus', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'distance', name: 'Distance to the water', type: 'number', min: 2, max: 60, step: 1, def: 10, unit: 'meters' },
    { id: 'peepers', name: 'Peepers', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent' },
    { id: 'toads', name: 'Trilling toads', type: 'bool', def: true },
    { id: 'croakers', name: 'Deep croakers', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent' },
    { id: 'water', name: 'Splashes and lapping', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('frogs-pond')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const d = q.distance
    addAir(sc, { hushDb: -60, wind: 0.07, gust: 0.4, body: 350, foliage: 0.3, foliageHz: 2800, rustle: 0.08, rumble: 0.08 }, r.fork('air'))
    addPeepers(sc, r.fork('peepers'), { count: Math.round(I * (q.peepers / 100) * 26), dist: d, gain: 0.5, send: 0.45 })
    addChorusFrogs(sc, r.fork('chorus'), { count: Math.round(I * 4), dist: d * 1.3, gain: 0.5, send: 0.45 })
    if (q.toads) addToads(sc, r.fork('toads'), { count: I > 0 ? 1 + Math.round(I * 1.5) : 0, dist: d * 1.6, gain: 0.35, send: 0.5 })
    addGreenFrogs(sc, r.fork('green'), { count: Math.round(I * 3), dist: d, gain: 0.6, send: 0.45 })
    const cc = Math.round((q.croakers / 100) * 3 * Math.min(1, I * 2))
    addDeepCroakers(sc, r.fork('croak'), { count: cc, dist: Math.max(20, d * 2.5), gain: 0.9, send: 0.6 })
    if (I > 0) addCrickets(sc, r.fork('crickets'), { count: 3 + Math.round(I * 4), dist: 25, warmth: 0.35, kind: 'field', gain: 0.2, send: 0.4 })
    const w = q.water / 100
    if (w > 0) {
      addPlops(sc, r.fork('plops'), { rate: 1 + 7 * w, dist: d, gain: 0.5, send: 0.35 })
      addLapping(sc, r.fork('lap'), { level: w, dist: Math.max(1.5, d * 0.4), gain: 0.18, send: 0.2, size: 0.6 })
    }
    return finishScene(sc, SPACES.pond, r.fork('space'), -15)
  },
}

export default bed
