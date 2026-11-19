// beds/eerie-whine.js - The wavering, gliding electric whine of old horror and space films.
//
// Technique: this is the sound of the hand-played electronic instrument
// usually called by its inventor's name (the theremin), which the film
// scores of the 1940s and 1950s made the voice of ghosts and flying saucers.
// The instrument beats two radio-frequency oscillators against each other
// and plays their difference tone, so its voice is close to a sine with a
// few low harmonics that grow as the volume rises (Skeldon, Reid, McInally,
// Dougan and Fulton, "Physics of the Theremin", American Journal of Physics
// 66, 1998). Here that voice is a phase accumulator whose second, third and
// fourth harmonics are made from the fundamental by the double-angle
// identities, each faded out before it could alias.
// Nothing is touched, so the pitch never steps: it follows the player's
// hand. The hand is a damped second-order system pulled toward each target
// note, the same critically damped "command response" used for the pitch
// contours of speech (Fujisaki and Hirose 1984); an underdamped setting
// gives the slight overshoot and settle of a real player. Vibrato is the
// hand trembling at 5 to 8 times a second (sung vibrato sits near six;
// Prame, JASA 1994), it starts small on each new note and grows (delayed
// vibrato), and its rate and depth wander. The volume hand swells and fades
// with one-pole envelopes and a small unsteady tremor.
// The music is generated, never looped and never borrowed: ghostly swoops
// of wide leaps that droop away at the end of each phrase; an original slow
// tune on the harmonic minor scale whose phrases sometimes echo an earlier
// motif; a slow rise and fall like a distant siren; or a high trembling note
// bending by half and quarter steps. Two players can answer each other, or,
// in the trembling style, hold two notes together that beat and grind.
// The player stands by an old tube amplifier (its 60 Hz hum and hiss), with
// a tape echo (a ping-pong feedback delay darkened and thinned on each
// pass) and the toolkit's feedback delay network for the room.

import { setup, stereo, finish, clamp, wander, noisePair, norm, bq, Fdn, addAir, oscInto, harmonicTable, panL, panR, TAU } from './car-highway.js'

const STYLES = {
  ghost: { rate: [5.3, 6.3], bright: 0.75, zeta: 0.6, answer: -5, rest: [0.6, 2.6] },
  tune: { rate: [5.8, 6.8], bright: 1, zeta: 0.78, answer: -12, rest: [0.8, 2.2] },
  siren: { rate: [4.8, 5.8], bright: 0.85, zeta: 0.95, answer: -7, rest: [0.8, 2.4] },
  tremble: { rate: [6.9, 8.2], bright: 0.6, zeta: 0.7, answer: -6, rest: [0.5, 1.8] },
}

// the bottom of each register, as a MIDI note (A3, E4, B4)
const BASE = { low: 57, middle: 64, high: 71 }

// ghostly leaps, in semitones; the fourths, fifths and octaves come most often
const LEAPS = [3, 4, 5, 5, 7, 7, 9, 12, 12]

// harmonic minor from the fifth below the root to the tenth above; the root is index 3
const SCALE = [-5, -4, -1, 0, 2, 3, 5, 7, 8, 11, 12, 14, 15]
const TUNE_BEATS = [1, 1, 1, 1.5, 2, 2, 0.5, 3]

/**
 * One gesture of the hands, from time t (seconds): pitch target p
 * (semitones over the register's base) reached with glide time g and
 * damping z; volume target a (-1 keeps the current one) with time constant
 * at; vibrato depth multiplier vib; re restarts the delayed vibrato.
 */
function seg(t, p, g, z, a, at, vib, re) {
  return { t, p, g, z, a, at, vib, re }
}

// ------------------------------------------------------------------ phrase makers
// Each pushes one phrase of gestures starting at t, ending with a fade, and
// returns the time by which the sound has died away.

function ghost(out, t, r, z) {
  let p = r.range(-4, 5)
  out.push(seg(t, p, r.range(0.25, 0.5), z, r.range(0.75, 1), r.range(0.15, 0.45), 1, true))
  t += r.range(0.6, 1.4)
  const swoops = 2 + r.int(4)
  for (let i = 0; i < swoops; i++) {
    let leap = r.pick(LEAPS) * (r.next() < 0.5 ? 1 : -1)
    if (p + leap > 14 || p + leap < -7) leap = -leap
    p += leap
    const g = r.range(0.3, 1.1)
    out.push(seg(t, p, g, z, r.range(0.6, 1), r.range(0.2, 0.6), 1, true))
    const hold = g * 1.2 + r.range(0.3, 1.4)
    if (r.next() < 0.08) {
      // a hand comes too close to the pitch rod: a quick squeal up and back
      const tc = t + hold * r.range(0.4, 0.65)
      out.push(seg(tc, p + r.range(9, 17), 0.05, 0.5, -1, -1, 0.3, false))
      out.push(seg(tc + r.range(0.08, 0.15), p, 0.12, 0.6, -1, -1, 1, false))
    }
    t += hold
  }
  // the phrase droops away as the volume hand lifts
  const fade = r.range(0.4, 0.9)
  out.push(seg(t, p - r.range(3, 12), r.range(0.6, 1.6), 0.9, 0, fade, 0.7, false))
  return t + fade * 2
}

function tune(out, t, r, z, st) {
  const beat = 60 / st.bpm
  const count = 4 + r.int(5)
  const deg = []
  let d
  if (st.motif && r.next() < 0.4) {
    // echo an earlier motif, sometimes a step higher or lower
    const sh = r.pick([0, 0, 1, -1, 2])
    for (const m of st.motif) deg.push(clamp(m + sh, 0, SCALE.length - 1))
    d = deg[deg.length - 1]
  } else {
    d = r.pick([3, 5, 7, 7, 10, 3])
    deg.push(d)
  }
  while (deg.length < count - 1) {
    const u = r.next()
    const step = u < 0.55 ? 1 : u < 0.8 ? 2 : u < 0.92 ? 3 + r.int(2) : 0
    let dir = r.next() < 0.5 ? 1 : -1
    if (d > 8 && r.next() < 0.3) dir = -1
    if (d < 3 && r.next() < 0.3) dir = 1
    if (d + step * dir > 11 || d + step * dir < 1) dir = -dir
    d = clamp(d + step * dir, 0, SCALE.length - 1)
    deg.push(d)
  }
  // land on the root, the fifth or the octave
  deg.push(r.pick([3, 3, 7, 10]))
  st.motif = deg.slice(0, 3)
  let prev = SCALE[deg[0]]
  for (let i = 0; i < deg.length; i++) {
    const p = SCALE[deg[i]]
    const last = i === deg.length - 1
    const dur = Math.max(0.15, (last ? r.range(3, 4) : r.pick(TUNE_BEATS)) * beat * (1 + 0.05 * r.gauss()))
    const arc = deg.length > 1 ? Math.sin((Math.PI * i) / (deg.length - 1)) : 1
    const vol = clamp((0.62 + 0.32 * arc) * r.range(0.88, 1.05), 0.3, 1)
    if (i > 0 && (p === prev || r.next() < 0.28)) {
      // the volume hand dips to part two notes
      out.push(seg(t - 0.06, prev, 0.2, z, 0.1, 0.02, 0.5, false))
      out.push(seg(t, p, 0.035, z, vol, 0.035, 1, true))
    } else {
      // slurred: the pitch slides over, now and then slowly
      const g = i === 0 ? 0.18 : r.next() < 0.15 ? r.range(0.25, 0.45) : r.range(0.05, 0.12)
      out.push(seg(t, p, g, z, vol, i === 0 ? 0.12 : 0.1, 1, true))
    }
    prev = p
    t += dur
  }
  const fade = r.range(0.3, 0.6)
  out.push(seg(t, prev - r.pick([0, 0, 1, 2]), 0.5, 0.9, 0, fade, 0.8, false))
  return t + fade * 2
}

function siren(out, t, r, z) {
  const lo = r.range(-6, -1)
  const hi = r.range(7, 14)
  out.push(seg(t, lo, 0.5, z, 0.5, 0.5, 0.8, true))
  t += r.range(0.6, 1.2)
  const cycles = 2 + r.int(4)
  let p = lo
  for (let c = 0; c < cycles; c++) {
    const up = r.range(1.2, 3)
    p = hi + r.range(-2, 2)
    out.push(seg(t, p, up * 0.5, z, r.range(0.85, 1), up * 0.5, 1, false))
    t += up + r.range(0.1, 0.8)
    const down = r.range(1.2, 3)
    p = lo + r.range(-2, 2)
    out.push(seg(t, p, down * 0.5, z, r.range(0.45, 0.7), down * 0.5, 0.8, false))
    t += down + r.range(0.1, 0.6)
  }
  const fade = r.range(0.5, 1)
  out.push(seg(t, p - r.range(2, 6), 1.2, 0.95, 0, fade, 0.7, false))
  return t + fade * 2
}

function tremble(out, t, r, z) {
  let p = r.range(5, 11)
  out.push(seg(t, p, 0.3, z, r.range(0.55, 0.85), r.range(0.4, 0.9), 1.6, true))
  t += r.range(1, 2.5)
  const bends = 2 + r.int(4)
  for (let i = 0; i < bends; i++) {
    p = clamp(p + r.pick([1, -1, 2, -2, 0.5, -0.5, 1, -1]), 3, 14)
    out.push(seg(t, p, r.range(0.2, 0.7), z, r.range(0.45, 0.95), r.range(0.3, 1), r.range(1.3, 1.9), r.next() < 0.5))
    t += r.range(0.9, 2.6)
  }
  const fade = r.range(0.5, 1.2)
  out.push(seg(t, p - r.range(0.5, 3), 1.2, 0.9, 0, fade, 1.2, false))
  return t + fade * 2
}

const MAKERS = { ghost, tune, siren, tremble }

// ------------------------------------------------------------------ the instrument

function nyq(f, lim, w) {
  return f < lim ? 1 : f > lim + w ? 0 : 1 - (f - lim) / w
}

/**
 * Play one player's gestures into L and R. o: { base (MIDI), depth
 * (vibrato semitones), rate [lo, hi] Hz, bright, amp, pan, panMove }.
 */
function play(list, L, R, SR, o, r) {
  const n = L.length
  if (!list.length || !n) return
  const blk = clamp(Math.round(SR / 1500), 1, 32)
  const dt = blk / SR
  const nb = Math.ceil(n / blk) + 2
  const crate = SR / blk
  const wDrift = wander(nb, crate, 0.35, r.fork('drift'))
  const wJit = wander(nb, crate, 9, r.fork('jit'))
  const wRate = wander(nb, crate, 0.5, r.fork('rate'))
  const wDepth = wander(nb, crate, 0.8, r.fork('depth'))
  const wTrem = wander(nb, crate, 3.5, r.fork('trem'))
  const wPan = wander(nb, crate, 0.04, r.fork('pan'))
  const rate0 = r.range(o.rate[0], o.rate[1])
  const vibC = 1 - Math.exp(-dt / 0.35)
  const lim = SR * 0.42
  const fw = SR * 0.05
  const inv = 1 / SR
  let si = -1
  let tp = list[0].p
  let w = 20
  let zz = 0.8
  let aT = 0
  let aC = 1 - Math.exp(-dt / 0.3)
  let vibT = 0
  let x = list[0].p
  let vel = 0
  let a = 0
  let vibD = 0
  let vph = r.next()
  let ph = r.next()
  let fPrev = 440 * Math.pow(2, (o.base + x - 69) / 12)
  let aPrev = 0
  for (let b = 0, i0 = 0; i0 < n; b++, i0 += blk) {
    const tNow = i0 / SR
    while (si + 1 < list.length && list[si + 1].t <= tNow) {
      si++
      const s = list[si]
      tp = s.p
      w = 4 / Math.max(0.02, s.g)
      zz = s.z
      if (s.a >= 0) {
        aT = s.a
        aC = 1 - Math.exp(-dt / Math.max(0.005, s.at))
      }
      vibT = s.vib
      if (s.re) vibD *= 0.35
    }
    // the pitch hand: a damped spring toward the target, sub-stepped when fast
    const sub = w * dt > 0.25 ? Math.ceil((w * dt) / 0.25) : 1
    const h = dt / sub
    for (let k = 0; k < sub; k++) {
      vel += (w * w * (tp - x) - 2 * zz * w * vel) * h
      x += vel * h
    }
    if (!(x > -48 && x < 48) || !(vel > -1e4 && vel < 1e4)) {
      x = clamp(tp, -48, 48)
      vel = 0
    }
    a += (aT - a) * aC
    if (a < 1e-9) a = 0
    vibD += (vibT * o.depth * (1 + 0.25 * wDepth[b]) - vibD) * vibC
    vph += rate0 * (1 + 0.07 * wRate[b]) * dt
    if (vph >= 1) vph -= 1
    const semis = o.base + x + vibD * Math.sin(TAU * vph) + 0.12 * wDrift[b] + 0.035 * wJit[b]
    const f = 440 * Math.pow(2, (semis - 69) / 12)
    const amp = a * o.amp * (1 + 0.06 * wTrem[b])
    const m = Math.min(blk, n - i0)
    if (aPrev === 0 && amp === 0) {
      // silent: keep the oscillator turning so the next note starts in phase
      ph += 0.5 * (fPrev + f) * inv * m
      ph -= Math.floor(ph)
      fPrev = f
      continue
    }
    // the voice gets a little richer as it gets louder
    const g1 = nyq(f, lim, fw)
    const g2 = o.bright * (0.12 + 0.18 * a) * nyq(2 * f, lim, fw)
    const g3 = o.bright * (0.05 + 0.12 * a) * nyq(3 * f, lim, fw)
    const g4 = o.bright * (0.02 + 0.06 * a) * nyq(4 * f, lim, fw)
    const pan = clamp(o.pan + o.panMove * wPan[b], -1, 1)
    const gl = panL(pan)
    const gr = panR(pan)
    const df = (f - fPrev) / m
    const da = (amp - aPrev) / m
    let ff = fPrev
    let aa = aPrev
    for (let j = 0; j < m; j++) {
      ff += df
      aa += da
      ph += ff * inv
      if (ph >= 1) ph -= 1
      const th = TAU * ph
      const s1 = Math.sin(th)
      const c1 = Math.cos(th)
      const s2 = 2 * s1 * c1
      const c2 = c1 * c1 - s1 * s1
      const s3 = s2 * c1 + c2 * s1
      const c4 = c2 * c2 - s2 * s2
      const y = (g1 * s1 - g2 * c2 + g3 * s3 + g4 * c4) * aa
      L[i0 + j] += y * gl
      R[i0 + j] += y * gr
    }
    fPrev = f
    aPrev = amp
  }
}

/** Ping-pong tape echo, darkened and thinned on every pass. In place. */
function tapeEcho(L, R, SR, amt, r) {
  const n = L.length
  if (!(amt > 0) || !n) return
  const d = Math.max(1, Math.round(SR * r.range(0.27, 0.36)))
  const bl = new Float32Array(d)
  const br = new Float32Array(d)
  const fb = 0.3 + 0.38 * amt
  const wet = 0.6 * amt
  const aLp = 1 - Math.exp((-TAU * Math.min(2600, SR * 0.4)) / SR)
  const aHp = 1 - Math.exp((-TAU * 160) / SR)
  let zl = 0
  let zr = 0
  let hl = 0
  let hr = 0
  let j = 0
  for (let i = 0; i < n; i++) {
    const ol = bl[j]
    const or = br[j]
    zl += aLp * (ol - zl)
    zr += aLp * (or - zr)
    hl += aHp * (zl - hl)
    hr += aHp * (zr - hr)
    if (zl < 1e-20 && zl > -1e-20) zl = 0
    if (zr < 1e-20 && zr > -1e-20) zr = 0
    if (hl < 1e-20 && hl > -1e-20) hl = 0
    if (hr < 1e-20 && hr > -1e-20) hr = 0
    bl[j] = 0.5 * (L[i] + R[i]) + fb * (zr - hr)
    br[j] = fb * (zl - hl)
    L[i] += wet * ol
    R[i] += wet * or
    if (++j >= d) j = 0
  }
}

// ------------------------------------------------------------------ the bed

const bed = {
  id: 'eerie-whine',
  name: 'Eerie wavering whine',
  group: 'spooky',
  about: 'The wavering electric whine of old horror and space films: ghostly swoops, a strange tune or a trembling note.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    {
      id: 'style',
      name: 'What it plays',
      type: 'choice',
      def: 'ghost',
      options: [
        { v: 'ghost', name: 'Ghostly swoops' },
        { v: 'tune', name: 'A strange slow tune' },
        { v: 'siren', name: 'Slow rising and falling' },
        { v: 'tremble', name: 'A high trembling note' },
      ],
    },
    {
      id: 'pitch',
      name: 'Pitch',
      type: 'choice',
      def: 'middle',
      options: [
        { v: 'low', name: 'Low and moaning' },
        { v: 'middle', name: 'Middle' },
        { v: 'high', name: 'High and thin' },
      ],
    },
    { id: 'wobble', name: 'Wobble', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    {
      id: 'company',
      name: 'Players',
      type: 'choice',
      def: 'alone',
      options: [
        { v: 'alone', name: 'Just one' },
        { v: 'pair', name: 'Two answering each other' },
      ],
    },
    { id: 'echo', name: 'Tape echo', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    {
      id: 'size',
      name: 'Room',
      type: 'choice',
      def: 'hall',
      options: [
        { v: 'close', name: 'Right beside you' },
        { v: 'room', name: 'A dark room' },
        { v: 'hall', name: 'A big empty hall' },
      ],
    },
    { id: 'hum', name: 'Old amplifier hum', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
  ],

  generate(seconds, sr, p, rng) {
    const s = setup(bed, seconds, sr, p, rng)
    const { n, q } = s
    const SR = s.sr
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return stereo(SR, L, R)
    const r = s.rng
    const dur = s.dur
    const k = q.intensity / 100
    const st = STYLES[q.style] || STYLES.ghost
    const make = MAKERS[q.style] || ghost
    const pair = q.company === 'pair'
    const together = pair && q.style === 'tremble'
    const base = BASE[q.pitch] ?? BASE.middle
    const restScale = 1.35 - 0.7 * k

    // the score: one list of gestures per player
    const players = pair ? [[], []] : [[]]
    const tuneState = { bpm: r.range(52, 72), motif: null }
    const place = (v, tmp, off, r2) => {
      const list = players[v]
      const t0 = tmp[0].t
      const lastT = list.length ? list[list.length - 1].t : -1e9
      const prepT = Math.max(lastT + 0.02, t0 - 0.3)
      // while silent, the pitch hand moves to just below (or above) the first note
      if (prepT < t0) list.push(seg(prepT, tmp[0].p + off + (r2.next() < 0.75 ? -1 : 1) * r2.range(2, 6), 0.1, 0.8, -1, -1, 0.4, false))
      for (const g of tmp) {
        g.p += off
        list.push(g)
      }
    }
    const run = (v, r2, off, t, alternate) => {
      let idx = 0
      while (t < dur) {
        const tmp = []
        const who = alternate ? idx % 2 : v
        const o = alternate && who === 1 ? st.answer : off
        const end = make(tmp, t, r2, st.zeta, tuneState)
        place(who, tmp, o, r2)
        let rest = r2.range(st.rest[0], st.rest[1]) * restScale
        if (alternate) rest *= 0.45
        else if (r2.next() < 0.15) rest += r2.range(1.5, 3.5) * restScale
        t = end + rest
        idx++
      }
    }
    if (together) {
      run(0, r.fork('first'), 0, r.range(0.05, 0.4), false)
      run(1, r.fork('second'), st.answer, r.range(0.8, 3), false)
    } else {
      run(0, r.fork('first'), 0, r.range(0.05, 0.4), pair)
    }

    // vibrato depth in semitones: about half a semitone either way at the default
    const depth = (q.wobble / 100) * 0.9
    for (let v = 0; v < players.length; v++) {
      play(players[v], L, R, SR, {
        base,
        depth,
        rate: st.rate,
        bright: st.bright,
        amp: v === 0 ? 0.25 : together ? 0.18 : 0.22,
        pan: pair ? (v === 0 ? -0.5 : 0.5) : 0,
        panMove: pair ? 0.12 : 0.18,
      }, r.fork('player' + v))
    }

    // the old amplifier's speaker
    bq(L, SR, 'highpass', 90, 0.707)
    bq(R, SR, 'highpass', 90, 0.707)
    bq(L, SR, 'peak', 1000, 0.8, 2)
    bq(R, SR, 'peak', 1000, 0.8, 2)
    bq(L, SR, 'lowpass', Math.min(7500, SR * 0.45), 0.707)
    bq(R, SR, 'lowpass', Math.min(7500, SR * 0.45), 0.707)
    tapeEcho(L, R, SR, q.echo / 100, r.fork('echo'))

    // its hum and hiss
    if (q.hum > 0) {
      const g = 0.014 * Math.pow(q.hum / 100, 1.5)
      const hb = new Float32Array(n)
      oscInto(hb, SR, 60, 1, harmonicTable([0.35, 1, 0.3, 0.45, 0.12, 0.2, 0.06, 0.08]), r.next(), 8)
      const [hl, hr] = noisePair(n, r.fork('hiss'), 'white', 0.6)
      for (const sig of [hl, hr]) {
        bq(sig, SR, 'highpass', 2000, 0.707)
        bq(sig, SR, 'lowpass', Math.min(9000, SR * 0.45), 0.707)
        norm(sig, 0.5)
      }
      for (let i = 0; i < n; i++) {
        L[i] += (hb[i] + hl[i]) * g
        R[i] += (hb[i] * 0.95 + hr[i]) * g
      }
    }

    const room = q.size === 'close' ? { size: 0.4, rt60: 0.35, damp: 0.5, wet: 0.08 } : q.size === 'room' ? { size: 1, rt60: 1.1, damp: 0.5, wet: 0.25 } : { size: 2.4, rt60: 3.2, damp: 0.45, wet: 0.42 }
    new Fdn(SR, { size: room.size, rt60: room.rt60, damp: room.damp, predelayMs: 6 + 10 * room.size }).process(L, R, room.wet, 1)
    addAir(L, R, SR, r.fork('air'), 0.0006)
    return finish(L, R, SR, -24 + (k - 0.55) * 10)
  },
}

export default bed
