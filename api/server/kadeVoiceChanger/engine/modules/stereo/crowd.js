// stereo.crowd - Crowd of you: a choir, a mob or an army, every one of them you.
//
// Technique: ensemble synthesis from one voice, after the choir-effect
// literature (Ternstrom 1991, "Physical and acoustic factors that interact
// with the singer to produce the choral sound", Journal of Voice 5(2), which
// measures how real ensembles differ: a few cents to a semitone of pitch
// scatter, tens of milliseconds of onset scatter, different voice sizes, and
// every singer at a different place in the room), built from published
// pieces:
// - Each person is a separate pitch-and-timbre shift of the take
//   (core/voice.js shiftVoice: pitch-synchronous overlap-add with formant
//   resampling), spread so the crowd covers the pitch range evenly, with
//   timbre partly following pitch (bigger people speak lower) and partly
//   independent; each also gets its own slow intonation wander, so the
//   melodies of their sentences differ and they never move in lockstep the
//   way a harmonizer does.
// - Timing: every person starts each phrase at their own moment. Their
//   lateness is re-drawn in every pause between phrases (core/segment.js) and
//   only drifts slowly inside phrases (see _lib.js phraseDelayTrack), which is
//   also their tempo jitter: some rush, some drag, within each line.
// - Voice character: a random formant-region bell and a brighter or darker
//   top for each throat, and a loudness that wobbles by word (people stress
//   different words).
// - Place: each person stands at their own direction and distance, with the
//   interaural delay and head shadow of the Brown and Duda 1998 head model,
//   the "behind you" dulling, and the distance law, and the whole crowd is
//   heard in a room (core/ir.js) fed by every person at full voice.
// - Cost: the six nearest people are made at the take's own rate; everyone
//   further back is made at 16 kHz (their highs would be lost to distance and
//   the room anyway) on a shared back-row bus that is resampled up once.
//   Past 16 people, the back rows borrow the pitch-shifted voice of the
//   back-row person nearest them in pitch and keep their own timing, place,
//   throat colour and loudness, which at that distance still reads as
//   another person.

import { shiftVoice } from '../../core/voice.js'
import { trackPitch } from '../../core/pitch.js'
import { findPhrases } from '../../core/segment.js'
import { resampleTo } from '../../core/resample.js'
import { Biquad } from '../../core/biquad.js'
import { makeRng } from '../../core/rng.js'
import {
  clamp, finite, monoOf, makeWander, phraseDelayTrack, trackAt, readCubic, cleanSig,
  directionCues, shadowCoefs, distGain, applyBackShelf, applyRearFix, addRoom, roomTail, roomOptions, ROOMS,
} from './_lib.js'

const ROOM_IDS = ['none', 'small-room', 'big-hall', 'church', 'stadium', 'outdoors', 'cave']
const FRONT = 6
const LOW_SR = 16000
const MAX_RENDERS = 16

function shuffled(rng, n) {
  const a = new Int32Array(n)
  for (let i = 0; i < n; i++) a[i] = i
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

function timingTailMs(p) {
  const t = clamp(finite(p && p.timing, 120), 0, 500)
  return t * 1.36 + 30
}

/** Plan everybody in the crowd from the settings and the rng. */
function planPeople(p, rng) {
  const N = clamp(Math.round(finite(p.people, 12)), 2, 40)
  const pS = clamp(finite(p.pitchSpread, 4), 0, 12)
  const tS = clamp(finite(p.timbreSpread, 2), 0, 6)
  const tm = clamp(finite(p.timing, 120), 0, 500)
  const sp = clamp(finite(p.spread, 80), 0, 100) / 100
  const loose = clamp(finite(p.loose, 50), 0, 100) / 100
  const pitchSlots = shuffled(rng, N)
  const placeSlots = shuffled(rng, N)
  const half = sp * 150
  const depth = 1.5 + 0.18 * N
  const people = []
  for (let k = 0; k < N; k++) {
    const r = rng.fork('person' + k)
    let u = ((pitchSlots[k] + 0.5) / N) * 2 - 1 + (r.next() - 0.5) * (1.6 / N)
    u = clamp(u, -1, 1)
    const v = r.next() * 2 - 1
    const az = -half + ((placeSlots[k] + 0.5) / N) * 2 * half + (r.next() - 0.5) * ((1.6 * half) / N)
    const dist = 1.3 + depth * Math.pow(r.next(), 0.8)
    people.push({
      rng: r,
      semis: clamp(pS * u, -24, 24),
      formant: clamp(tS * clamp(0.6 * u + 0.4 * v, -1, 1), -12, 12),
      wander: 0.12 + 0.5 * loose * (0.6 + 0.4 * r.next()),
      az,
      el: r.range(-6, 14),
      dist,
      lvl: Math.pow(10, r.range(-3, 2) / 20) * distGain(dist),
      base: tm * Math.pow(r.next(), 1.4),
      perPhrase: 0.35 * tm * loose,
      drift: Math.min(25, 0.15 * tm) * loose,
      eqF: 600 * Math.pow(2, r.next() * 2.5),
      eqG: r.range(-5, 5),
      shelfG: r.range(-5, 3),
      wobbleDb: 0.5 + 2.5 * loose,
    })
  }
  people.sort((a, b) => a.dist - b.dist)
  return people
}

/**
 * Render one person from src (at rate sr) into the bus L, R and the room send.
 */
function voiceOf(P, src, sr, track, k) {
  const wv = makeWander(P.rng.fork('intonation'), src.length / sr + 1, 0.3 + 0.25 * P.rng.next())
  const semis = P.semis
  const wa = P.wander
  return shiftVoice(src, sr, { semitones: (t) => semis + wa * wv.at(t), formant: P.formant, track, seed: 'crowd' + k })
}

function renderPerson(P, y, sr, phrases, L, R, send, nOut, gain, sendGain) {
  new Biquad('peak', sr, Math.min(P.eqF, 0.4 * sr), 1.2, P.eqG).run(y)
  new Biquad('highshelf', sr, Math.min(3000, 0.4 * sr), 0.707, P.shelfG).run(y)
  const cues = directionCues(P.az, P.el, {})
  applyBackShelf(y, sr, cues.back)
  applyRearFix(y, sr, { az: P.az, el: P.el })
  // a loudness that wobbles word by word
  const wob = makeWander(P.rng, y.length / sr + 1, 0.22 + 0.2 * P.rng.next())
  const wdb = P.wobbleDb
  for (let i0 = 0; i0 < y.length; i0 += 64) {
    const g = Math.pow(10, (wdb * wob.at(i0 / sr)) / 20)
    const e = Math.min(y.length, i0 + 64)
    for (let i = i0; i < e; i++) y[i] *= g
  }
  const dt = phraseDelayTrack(nOut, sr, phrases, P.rng, {
    base: (P.base / 1000) * sr,
    perPhrase: (P.perPhrase / 1000) * sr,
    wander: (P.drift / 1000) * sr,
    minDelay: 0,
    maxSlope: 0.004,
  })
  const tr = dt.track
  const itdL = cues.itdL * sr
  const itdR = cues.itdR * sr
  const c = shadowCoefs(sr)
  const bL0 = c.p0 + cues.aL * c.q0, bL1 = c.p1 + cues.aL * c.q1
  const bR0 = c.p0 + cues.aR * c.q0, bR1 = c.p1 + cues.aR * c.q1
  const a1 = c.a1
  let xl1 = 0, yl1 = 0, xr1 = 0, yr1 = 0
  const hasSend = send && sendGain > 0
  for (let i = 0; i < nOut; i++) {
    const d = trackAt(tr, i)
    const sl = readCubic(y, i - d - itdL)
    const s2 = readCubic(y, i - d - itdR)
    let yl = bL0 * sl + bL1 * xl1 - a1 * yl1
    xl1 = sl
    if (yl < 1e-25 && yl > -1e-25) yl = 0
    yl1 = yl
    let yr = bR0 * s2 + bR1 * xr1 - a1 * yr1
    xr1 = s2
    if (yr < 1e-25 && yr > -1e-25) yr = 0
    yr1 = yr
    L[i] += yl * gain
    R[i] += yr * gain
    if (hasSend) send[i] += 0.5 * (sl + s2) * sendGain
  }
}

export default {
  id: 'stereo.crowd',
  name: 'Crowd of you',
  family: 'stereo',
  about: 'A whole crowd made of you: every person a different pitch, size, timing and place, from a small group to a choir or an army.',
  params: [
    { id: 'people', name: 'People', type: 'number', min: 2, max: 40, step: 1, def: 12, unit: 'count', noun: ['person', 'people'], rand: [4, 24] },
    { id: 'pitchSpread', name: 'Pitch spread', type: 'number', min: 0, max: 12, step: 0.5, def: 4, unit: 'semitones', rand: [1.5, 7] },
    { id: 'timbreSpread', name: 'Size spread', type: 'number', min: 0, max: 6, step: 0.5, def: 2, unit: 'semitones', rand: [1, 4] },
    { id: 'timing', name: 'Timing spread', type: 'number', min: 0, max: 500, step: 5, def: 120, unit: 'ms', rand: [30, 250] },
    { id: 'loose', name: 'Looseness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'spread', name: 'Spread around you', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [50, 100] },
    { id: 'room', name: 'Room', type: 'choice', def: 'big-hall', options: roomOptions(ROOM_IDS) },
    { id: 'you', name: 'Your own voice in front', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [0, 80] },
  ],
  stereo: 'make',
  tail: (p) => timingTailMs(p) / 1000 + roomTail(p && ROOMS[p.room] ? p.room : 'none'),
  warps: false,
  cost: 5,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    const n = x.length
    if (n === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const rng = (ctx && ctx.rng ? ctx.rng : makeRng('stereo.crowd')).fork('crowd')
    const cancelled = ctx && typeof ctx.cancelled === 'function' ? ctx.cancelled : () => false
    const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : () => {}
    const people = planPeople(p, rng)
    const N = people.length
    const roomId = ROOMS[p.room] && ROOMS[p.room].space ? p.room : 'none'
    const extra = Math.ceil((timingTailMs(p) / 1000) * sr)
    const nOut = n + extra
    const roomExtra = Math.round(roomTail(roomId) * sr)
    const L = new Float32Array(nOut + roomExtra)
    const R = new Float32Array(nOut + roomExtra)
    let pw = 0
    for (let k = 0; k < N; k++) pw += people[k].lvl * people[k].lvl
    const norm = 1 / Math.sqrt(Math.max(1e-9, pw))
    const send = roomId !== 'none' ? new Float32Array(nOut) : null

    const useLow = sr > 30000 && N > FRONT
    const nFront = useLow ? FRONT : N
    const track = trackPitch(x, sr)
    const phrases = findPhrases(x, sr)
    let done = 0
    for (let k = 0; k < nFront; k++) {
      if (cancelled()) break
      const P = people[k]
      renderPerson(P, voiceOf(P, x, sr, track, k), sr, phrases, L, R, send, nOut, P.lvl * norm, (P.lvl / distGain(P.dist)) * norm)
      progress(++done / N)
    }
    if (useLow && !cancelled()) {
      const xl = resampleTo(x, sr, LOW_SR)
      const trackL = trackPitch(xl, LOW_SR)
      const phrasesL = findPhrases(xl, LOW_SR)
      const nLow = Math.ceil((nOut * LOW_SR) / sr) + 8
      const bl = new Float32Array(nLow)
      const br = new Float32Array(nLow)
      const bs = send ? new Float32Array(nLow) : null
      // who borrows whose voice: each extra person takes the rendered
      // back-row person nearest in pitch, spreading the borrowing evenly
      const nRender = Math.min(N, MAX_RENDERS)
      const borrowers = []
      for (let k = nFront; k < nRender; k++) borrowers.push([])
      const uses = new Int32Array(nRender)
      for (let j = nRender; j < N; j++) {
        let best = nFront
        let bestCost = Infinity
        for (let k = nFront; k < nRender; k++) {
          const cost = Math.abs(people[k].semis - people[j].semis) + 2 * uses[k]
          if (cost < bestCost) {
            bestCost = cost
            best = k
          }
        }
        uses[best]++
        borrowers[best - nFront].push(j)
      }
      for (let k = nFront; k < nRender; k++) {
        if (cancelled()) break
        const P = people[k]
        const raw = voiceOf(P, xl, LOW_SR, trackL, k)
        const list = borrowers[k - nFront]
        for (let q = 0; q < list.length; q++) {
          const B = people[list[q]]
          renderPerson(B, new Float32Array(raw), LOW_SR, phrasesL, bl, br, bs, nLow, B.lvl * norm, (B.lvl / distGain(B.dist)) * norm)
          progress(++done / N)
        }
        renderPerson(P, raw, LOW_SR, phrasesL, bl, br, bs, nLow, P.lvl * norm, (P.lvl / distGain(P.dist)) * norm)
        progress(++done / N)
      }
      const ul = resampleTo(bl, LOW_SR, sr)
      const ur = resampleTo(br, LOW_SR, sr)
      const m = Math.min(nOut, ul.length, ur.length)
      for (let i = 0; i < m; i++) {
        L[i] += ul[i]
        R[i] += ur[i]
      }
      if (bs && send) {
        const us = resampleTo(bs, LOW_SR, sr)
        const ms = Math.min(nOut, us.length)
        for (let i = 0; i < ms; i++) send[i] += us[i]
      }
    }
    if (send) addRoom(L, R, send, roomId, sr, rng.fork('room'), 0.8 / ROOMS[roomId].dc)
    // your own voice, up front in the middle
    const you = clamp(finite(p.you, 50), 0, 100) / 100
    const all = 1 / Math.sqrt(1 + you * you)
    const yg = you * Math.SQRT1_2
    for (let i = 0; i < n; i++) {
      L[i] += x[i] * yg
      R[i] += x[i] * yg
    }
    for (let i = 0; i < L.length; i++) {
      L[i] *= all
      R[i] *= all
    }
    return { sr, ch: [cleanSig(L), cleanSig(R)] }
  },
}
