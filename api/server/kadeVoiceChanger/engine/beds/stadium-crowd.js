// beds/stadium-crowd.js - Stadium crowd: a roaring murmur that swells, cheers, applause, whistles and chants.
//
// This file also holds the applause and big-crowd voices other beds borrow.
// Techniques and their published sources:
// - The mass of thousands: when many voices overlap, their sum tends to a
//   noise with the long-term average speech spectrum (Byrne and others 1994,
//   "An international comparison of long-term average speech spectra")
//   whose syllable flutter shrinks as the crowd grows; so the far crowd is
//   wide stereo speech-shaped noise with a slow swell and a faint fast
//   flutter, under dozens of the places kit's babble talkers at stadium
//   distances, which give it the grain of real voices.
// - Cheers and groans: dozens of individual voices at once, each a long
//   shouted vowel that rises and falls (laughter-free reactions), spread
//   over half a second, on top of a surge of the mass; whistles are fast
//   gliding near-sine tones.
// - Applause after Peltola, Erkut, Cook and Valimaki 2007 ("Synthesis of
//   hand-clapping sounds", IEEE TASLP): every clap is a short noise burst
//   through the resonance of the cupped hands (each person has their own),
//   each clapper keeps a rate of three to five claps a second with small
//   timing jitter, and far clappers merge into a dense rain.
// - Chants: the whole crowd clapping a rhythm together (each section a few
//   tens of milliseconds late, as sound and people are) with a shout on the
//   accent, or singing a three-note call on an open vowel.
// - The bowl: an open stadium's long, sparse late echoes from the stands
//   over a light wash; outside the gates the walls take the highs away.

import {
  makeScene, emptyBed, finish, emit, crowd, makeTalker, reactFrames, renderFrames, lowBus, mixLow, announce,
  poisson, rexp, logRange, clamp, filt, noiseBurst, tone, buf, addAt, seed32, trim, pushFrame, VOWELS, wander,
  curveAt, harmonicTable, bandTable, dbg, TAU,
} from './cafe.js'
import { pink } from '../core/noise.js'

/** A set of clap voices for one person (their own hand resonance). */
export function clapVoices(sr, rng, n = 3) {
  const out = []
  const hz = rng.range(800, 2200)
  const q = rng.range(1.5, 5)
  for (let k = 0; k < n; k++) {
    const c = noiseBurst(sr, rng, 0.035, { att: 0.0004, dec: rng.range(0.004, 0.009), hz: hz * rng.range(0.92, 1.08), q })
    out.push(trim(c))
  }
  return out
}

/**
 * Applause from t for dur seconds. o: { near (clappers you hear one by one),
 * far (claps per second of the merged crowd), dist: [near, far], gain, swell }
 */
export function applause(sc, rng, t, dur, o = {}) {
  const sr = sc.sr
  const near = Math.round(o.near ?? 12)
  const env = (u) => Math.min(1, u / 0.25) * (u < 0.55 ? 1 : Math.max(0, 1 - (u - 0.55) / 0.45))
  const dist = o.dist || [2, 10]
  for (let k = 0; k < near; k++) {
    const v = clapVoices(sr, rng)
    const pan = rng.range(-0.95, 0.95)
    const d = logRange(rng, dist[0], dist[1])
    const rate = rng.range(3.2, 5.2)
    const start = t + rng.range(0, 0.4)
    const stop = t + dur * rng.range(0.7, 1)
    for (let tt = start; tt < stop; tt += (1 / rate) * (1 + rng.gauss() * 0.05)) {
      const u = (tt - t) / dur
      emit(sc, v[rng.int(v.length)], tt * sr, pan, d, (o.gain ?? 1) * 0.5 * env(u) * rng.range(0.7, 1.1))
    }
  }
  const far = o.far ?? 200
  if (far > 0) {
    const bank = []
    for (let k = 0; k < 12; k++) bank.push(clapVoices(sr, rng, 1)[0])
    const fd = o.farDist || [15, 60]
    for (let tt = t; tt < t + dur; tt += rexp(rng, 1 / far)) {
      const u = (tt - t) / dur
      const e = env(u)
      if (e <= 0.01) continue
      emit(sc, bank[rng.int(bank.length)], tt * sr, rng.range(-1, 1), logRange(rng, fd[0], fd[1]), (o.gain ?? 1) * 0.45 * e * rng.range(0.5, 1))
    }
  }
}

/** A two-finger whistle: a fast-gliding near-sine. */
export function whistle(sr, rng) {
  const dur = rng.range(0.4, 1.4)
  const out = buf(sr, dur)
  const f0 = rng.range(2000, 3200)
  const shape = rng.int(3)
  let ph = 0
  let s = seed32(rng)
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length
    let f
    if (shape === 0) f = f0 * (1 + 0.25 * Math.sin(Math.PI * u))
    else if (shape === 1) f = f0 * (u < 0.3 ? 0.8 + (0.2 * u) / 0.3 : 1 - 0.3 * (u - 0.3))
    else f = f0 * (1 + 0.04 * Math.sin(TAU * 7 * u * dur))
    ph += (TAU * f) / sr
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const e = Math.min(1, u * 20) * Math.min(1, (1 - u) * 8)
    out[i] = (Math.sin(ph) + 0.06 * (s / 2147483648)) * e * 0.5
  }
  return out
}

/**
 * Many people shouting at once: count voices of kind 'cheer', 'aw', 'oh',
 * 'hey', 'ooh' spread over `spread` seconds from t. o: { dist: [lo, hi], gain, dur }
 */
export function crowdShout(sc, rng, t, type, count, o = {}) {
  const lo = lowBus(sc)
  const dist = o.dist || [4, 60]
  for (let k = 0; k < count; k++) {
    const T = makeTalker(rng, rng.chance(0.15) ? 'child' : 'adult', { effort: 0.95, expr: 0.9 })
    const f = []
    reactFrames(T, rng, f, 0, type, { effort: type === 'aw' ? 0.75 : 1, level: 1, dur: (o.dur ?? 1.6) * rng.range(0.6, 1.4) })
    const sig = renderFrames(T, f, lo.wr, T.seed)
    const off = Math.round((t + rng.range(0, o.spread ?? 0.5)) * lo.wr)
    mixLow(sc, sig, off, rng.range(-1, 1), logRange(rng, dist[0], dist[1]), (o.gain ?? 1) * 1.2 * T.gain, 1)
  }
}

/** Frames for a sung chant: notes [[t, dur, hz]...] on one vowel. */
function sungFrames(T, rng, notes, vowel) {
  const fr = []
  const F = vowel.map((v) => v * T.fs)
  pushFrame(fr, 0, 0, 0, 0, 3000, F[0], F[1], F[2], notes[0][2])
  for (const [t, d, hz] of notes) {
    const h = hz * (1 + rng.gauss() * 0.012)
    pushFrame(fr, t, 0.05, 0.1, 0, 3000, F[0], F[1], F[2], h)
    pushFrame(fr, t + 0.06, 0.95, 0.15, 0, 3000, F[0], F[1], F[2], h)
    pushFrame(fr, t + d - 0.08, 0.85, 0.15, 0, 3000, F[0], F[1], F[2], h * (1 + rng.gauss() * 0.01))
    pushFrame(fr, t + d, 0.1, 0.05, 0, 3000, F[0], F[1], F[2], h)
  }
  const last = notes[notes.length - 1]
  pushFrame(fr, last[0] + last[1] + 0.05, 0, 0, 0, 3000, F[0], F[1], F[2], last[2])
  return fr
}

/** A chant: clapped rhythm with a shout, or a sung three-note call. */
function chant(sc, rng, t, o) {
  const sr = sc.sr
  const bpm = rng.range(96, 126)
  const beat = 60 / bpm
  const reps = 3 + rng.int(5)
  if (rng.chance(0.55)) {
    // clap clap, clap clap clap ... and a shout on the last
    const pattern = rng.pick([[0, 1, 2.5, 3, 3.5], [0, 0.5, 1, 2, 3], [0, 1, 2, 2.5, 3]])
    const sections = 8
    const voices = []
    for (let s = 0; s < sections; s++) voices.push({ v: clapVoices(sr, rng, 4), pan: rng.range(-1, 1), d: logRange(rng, 8, 70), late: rng.range(0, 0.05) })
    for (let r = 0; r < reps; r++) {
      const t0 = t + r * 4 * beat
      for (const sec of voices) {
        for (const pb of pattern) {
          // a section is many people: a handful of claps a few milliseconds apart
          for (let k = 0; k < 6; k++) emit(sc, sec.v[rng.int(4)], (t0 + pb * beat + sec.late + rng.range(0, 0.035)) * sr, clamp(sec.pan + rng.range(-0.15, 0.15), -1, 1), sec.d, 0.6 * o.gain)
        }
      }
      crowdShout(sc, rng, t0 + pattern[pattern.length - 1] * beat + 0.15, 'hey', 10, { dist: [8, 70], gain: 0.7 * o.gain, spread: 0.12, dur: 0.5 })
    }
  } else {
    // a sung call on an open vowel, three notes over and over
    const root = rng.range(190, 260)
    const motif = rng.pick([[0, 4, 7, 4], [7, 4, 0, 0], [0, 0, 4, 7], [4, 7, 4, 0]])
    const durs = rng.pick([[1, 1, 1, 1], [1.5, 0.5, 1, 1], [2, 1, 0.5, 0.5]])
    const lo = lowBus(sc)
    const vowel = rng.pick([VOWELS.oh, VOWELS.ah, VOWELS.aw])
    const singers = 24
    for (let k = 0; k < singers; k++) {
      const T = makeTalker(rng, 'adult', { effort: 0.85 })
      const oct = T.kind === 'man' ? 0.5 : 1
      const notes = []
      let tt = 0
      for (let r = 0; r < reps; r++) {
        for (let m = 0; m < motif.length; m++) {
          const d = durs[m] * beat
          notes.push([tt + rng.range(0, 0.04), d * 0.92, root * oct * Math.pow(2, motif[m] / 12)])
          tt += d
        }
      }
      const sig = renderFrames(T, sungFrames(T, rng, notes, vowel), lo.wr, T.seed)
      mixLow(sc, sig, Math.round((t + rng.range(0, 0.06)) * lo.wr), rng.range(-1, 1), logRange(rng, 6, 70), 1.1 * T.gain * o.gain, 1)
    }
  }
}

/** The far mass: wide speech-shaped noise, following the crowd's swell. */
function mass(sc, rng, level, swell) {
  const n = sc.n
  const sr = sc.sr
  const a = pink(n, rng.fork('ml'))
  const b = pink(n, rng.fork('mr'))
  const color = [['highpass', 220, 0.7], ['highpass', 220, 0.7], ['lowpass', 3200, 0.7], ['peak', 650, 0.8, 4], ['peak', 1700, 1.2, 2]]
  filt(a, sr, color)
  filt(b, sr, color)
  const dt = 0.02
  const fl = wander(rng.fork('flutter'), sc.dur, dt, 0.18)
  const fr = wander(rng.fork('flutter2'), sc.dur, dt, 0.21)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const sw = curveAt(swell, t, dt)
    const g = level * sw
    sc.L[i] += a[i] * g * (1 + 0.1 * curveAt(fl, t, dt))
    sc.R[i] += b[i] * g * (1 + 0.1 * curveAt(fr, t, dt))
    sc.S[i] += (a[i] + b[i]) * g * 0.3
  }
}

/**
 * Crowd multiplication: the talkers already on the buses are copied many
 * times, each copy from a different moment of the take (read round the
 * loop), from its own side, so a few dozen voices become thousands with the
 * true grain of speech (the layering trick of film crowd editing). The
 * copies follow the crowd's swell. mono is the talker-rate mix to copy.
 */
function multiply(sc, rng, mono, copies, level, swell) {
  const lo = sc.low
  if (!lo || !mono.length) return
  const nl = mono.length
  const dt = 0.02
  for (let c = 0; c < copies; c++) {
    const shift = Math.floor(rng.range(0.15, 0.85) * nl)
    const a = ((rng.range(-1, 1) + 1) * Math.PI) / 4
    const gl = Math.cos(a) * level
    const gr = Math.sin(a) * level
    const gs = level * sc.send * 0.5
    for (let i = 0; i < lo.n - 4; i++) {
      let j = i - shift
      if (j < 0) j += nl
      const v = mono[j] * curveAt(swell, i / lo.wr, dt)
      lo.L[i] += v * gl
      lo.R[i] += v * gr
      lo.S[i] += v * gs
    }
  }
  lo.used = true
}

/** An air horn blast from the stands. */
function airHorn(sr, rng) {
  const dur = rng.range(0.8, 2)
  const out = buf(sr, dur)
  const f = rng.range(380, 480)
  const parts = []
  for (let k = 1; k <= 12; k++) parts.push([k, Math.pow(1 / k, 0.7)])
  for (const r of [1, 1.26, 1.5]) addAt(out, tone(sr, f * r * (1 + rng.gauss() * 0.003), dur, { partials: parts, att: 0.03, rel: 0.1 }), 0, 0.25)
  filt(out, sr, [['highpass', 300, 0.7], ['peak', 2200, 1.5, 6]])
  return out
}

/** A short organ riff over the stadium speakers. */
function organRiff(sr, rng) {
  const full = harmonicTable([[1, 1], [2, 0.8], [3, 0.6], [4, 0.5], [6, 0.3], [8, 0.25]])
  const root = 60 + rng.int(7)
  const steps = rng.pick([[0, 4, 7, 12], [0, 4, 7, 9, 12], [7, 4, 7, 12], [0, 2, 4, 7, 12, 7]])
  const nl = rng.range(0.14, 0.2)
  const out = buf(sr, steps.length * nl + 1)
  steps.forEach((st, k) => {
    const hz = 440 * Math.pow(2, (root + st - 69) / 12)
    const tbl = bandTable(full, hz, sr)
    const len = k === steps.length - 1 ? nl * 3 : nl * 0.9
    const n = Math.round(len * sr)
    const off = Math.round(k * nl * sr)
    let ph = 0
    for (let i = 0; i < n && off + i < out.length; i++) {
      const x = ph * 2048
      const i0 = x | 0
      const e = Math.min(1, i / 200) * Math.min(1, (n - i) / 400)
      out[off + i] += (tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * (x - i0)) * e * 0.3
      ph += hz / sr
      if (ph >= 1) ph -= 1
    }
  })
  return out
}

const SEATS = {
  stands: { near: true, mass: 1, far: [12, 70], wet: 0.65 },
  field: { near: false, mass: 1.2, far: [25, 110], wet: 0.9 },
  outside: { near: false, mass: 1, far: [30, 90], wet: 0.6 },
}

const bed = {
  id: 'stadium-crowd',
  name: 'Stadium crowd',
  group: 'places',
  about: 'A big stadium crowd: a roaring murmur that swells, cheers, applause, whistles and chants.',
  params: [
    { id: 'intensity', name: 'Crowd size', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 100] },
    { id: 'excitement', name: 'Excitement', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 95] },
    { id: 'chants', name: 'Chants', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 80] },
    {
      id: 'seat',
      name: 'Where you are',
      type: 'choice',
      def: 'stands',
      options: [
        { v: 'stands', name: 'In the stands' },
        { v: 'field', name: 'Down on the field' },
        { v: 'outside', name: 'Outside the gates' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.07, airHz: 16000, airM: 40, roomR: 80 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const size = q.intensity / 100
    const ex = q.excitement / 100
    const seat = SEATS[q.seat] || SEATS.stands
    // cheers and groans on the game's clock
    const ev = r.fork('events')
    const events = []
    for (const t of poisson(ev, 0.006 + ex * 0.07, -6, sc.dur)) events.push(t)
    if (!events.length && sc.dur < 120 && ex >= 0.2) events.push(ev.range(0.15, 0.65) * sc.dur)
    events.sort((a, b) => a - b)
    const kinds = events.map(() => (ev.chance(0.72) ? 'cheer' : 'aw'))
    // the swell curve of the whole crowd
    const dt = 0.02
    const m = Math.ceil(sc.dur / dt) + 2
    const swell = new Float32Array(m)
    const slow = wander(ev.fork('slow'), sc.dur, dt, 6)
    for (let i = 0; i < m; i++) swell[i] = 0.75 + 0.3 * slow[i] * (0.4 + ex)
    events.forEach((t0, k) => {
      const big = kinds[k] === 'cheer' ? ev.range(0.8, 1.2) * (1.4 + 1.8 * ex) : 1.4
      const pre = ev.chance(0.5) ? ev.range(1, 4) : 0
      const tau = ev.range(3, 6)
      for (let i = 0; i < m; i++) {
        const t = i * dt
        let v = 0
        if (pre > 0 && t > t0 - pre && t < t0) v = 0.6 * ((t - (t0 - pre)) / pre) ** 2
        else if (t >= t0) {
          const u = t - t0
          v = Math.min(1, u / 0.35) * Math.exp(-u / tau)
        }
        swell[i] += v * (big - 1)
      }
    })
    mass(sc, r.fork('mass'), 0.35 * (0.4 + size) * seat.mass, swell)
    // dozens of voices in the stands, then copied into thousands
    crowd(sc, r.fork('stands'), { groups: 4 + Math.round(size * 10), size: [2, 3], dist: seat.far, effort: 0.65 + ex * 0.2, react: 0.6, silence: 0.03, gap: 0.05, expr: 0.8 })
    const lo0 = lowBus(sc)
    const mono = new Float32Array(lo0.n)
    for (let i = 0; i < lo0.n; i++) mono[i] = 0.5 * (lo0.L[i] + lo0.R[i])
    multiply(sc, r.fork('copies'), mono, 10, 0.45 * (0.4 + size) * seat.mass, swell)
    if (seat.near) {
      crowd(sc, r.fork('neighbours'), { groups: 1, size: [2, 3], dist: [1.5, 4], width: 0.8, effort: 0.7, react: 0.6, silence: 0.15, expr: 0.8, gain: 0.6 })
      crowd(sc, r.fork('behind'), { groups: 1, size: [2, 2], dist: [2.5, 6], width: 0.8, effort: 0.7, react: 0.6, silence: 0.2, expr: 0.8, gain: 0.6 })
    }
    // the cheers themselves
    events.forEach((t0, k) => {
      const er = ev.fork('e' + k)
      if (kinds[k] === 'cheer') {
        crowdShout(sc, er, t0, 'cheer', Math.round(18 + size * 22), { dist: seat.near ? [4, 70] : seat.far, gain: 0.7, spread: 0.6, dur: er.range(1.4, 2.6) })
        crowdShout(sc, er, t0 + er.range(0.8, 1.6), er.pick(['yeah', 'hey', 'wow', 'cheer']), 10, { dist: seat.far, gain: 0.8, spread: 1 })
        for (let w = 0; w < 3 + er.int(6 + ex * 6); w++) emit(sc, whistle(sc.sr, er), (t0 + er.range(0.3, 4)) * sc.sr, er.range(-1, 1), logRange(er, 3, 50), 1.2)
        applause(sc, er, t0 + er.range(0.8, 1.6), er.range(3, 7), { near: seat.near ? 10 : 0, far: 150 + size * 350, dist: [1.5, 8], farDist: seat.far, gain: 0.25 + 0.5 * ex })
      } else {
        crowdShout(sc, er, t0, 'aw', Math.round(14 + size * 16), { dist: seat.near ? [3, 70] : seat.far, gain: 0.9, spread: 0.4, dur: 1.3 })
        if (er.chance(0.5)) applause(sc, er, t0 + 1.5, er.range(2, 3), { near: seat.near ? 4 : 0, far: 60 + size * 80, farDist: seat.far, gain: 0.5 })
      }
    })
    // chants
    const ch = r.fork('chants')
    for (const t of poisson(ch, (q.chants / 100) * 0.035, -10, sc.dur)) chant(sc, ch.fork('c' + Math.round(t * 100)), t, { gain: 0.6 + size * 0.5 })
    // the announcer, the organ and the odd air horn
    const pa = r.fork('pa')
    const spk = [[-0.6, 45], [0.5, 70], [0.1, 110], [-0.9, 150]]
    for (const t of poisson(pa, 0.012, -6, sc.dur)) announce(sc, pa.fork('a' + Math.round(t * 100)), t, { speakers: spk, phrases: 1 + pa.int(3), gain: 0.22, effort: 0.8, rate: 4, send: 1.4, drive: 2.5 })
    for (const t of poisson(pa, 0.002 + ex * 0.018, 0, sc.dur)) {
      const riff = organRiff(sc.sr, pa)
      for (const [pan, d] of spk) emit(sc, riff, (t + d / 343) * sc.sr, pan, d, Math.sqrt(d) * 0.4, 1.3)
      crowdShout(sc, pa, t + riff.length / sc.sr - 0.4, 'cheer', 12, { dist: seat.far, gain: 0.8, spread: 0.3, dur: 0.8 })
    }
    for (const t of poisson(pa, 0.001 + ex * 0.014, 0, sc.dur)) emit(sc, airHorn(sc.sr, pa), t * sc.sr, pa.range(-1, 1), logRange(pa, 8, 60), 3)
    const taps = [[90, 0.25, -0.8], [170, 0.22, 0.75], [260, 0.16, -0.5], [380, 0.12, 0.6], [520, 0.07, -0.2]]
    const out = finish(sc, { size: 1.8, rt60: 2.2, rt60High: 1.0, predelayMs: 40, wet: seat.wet, taps, tapGain: 1 }, -21 + (q.intensity - 50) * 0.05)
    if (q.seat === 'outside') {
      // the concrete walls between you and the bowl take the highs away
      for (const c of out.ch) filt(c, out.sr, [['lowpass', 520, 0.7], ['lowpass', 900, 0.7], ['highpass', 35, 0.7], ['lowshelf', 120, 0.7, 3]])
      let e = 0
      for (const c of out.ch) for (let i = 0; i < c.length; i++) e += c[i] * c[i]
      const rv = Math.sqrt(e / (2 * Math.max(1, out.ch[0].length)))
      const g = rv > 1e-9 ? dbg(-25 + (q.intensity - 50) * 0.05) / rv : 0
      for (const c of out.ch) for (let i = 0; i < c.length; i++) c[i] = Math.max(-0.95, Math.min(0.95, c[i] * g))
    }
    return out
  },
}

export default bed
