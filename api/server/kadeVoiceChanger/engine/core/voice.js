// core/voice.js - pitch and timbre changes for speech, the heart of every voice preset.
//
// quality 'best' is the "change gender" family of methods from Praat
// (Boersma and Weenink; Sound: Change gender), built on TD-PSOLA, the
// time-domain pitch-synchronous overlap-add of Moulines and Charpentier
// 1990, "Pitch-synchronous waveform processing techniques for text-to-speech
// synthesis using diphones" (Speech Communication 9):
//
// 1. Pitch track (core/pitch.js, YIN plus a Viterbi path).
// 2. Pitch marks, one per glottal cycle, on glottal closure estimates. In each
//    voiced stretch a seed mark goes on the strongest peak (of the polarity
//    that dominates that stretch) of a band-limited copy, and the march goes
//    forward and backward one period at a time. Each next mark is where the
//    waveform best matches the previous cycle (normalised cross-correlation
//    over one period, searched from 0.75 to 1.3 periods ahead, the period
//    taken from the f0 track, with a mild pull toward the expected spot), then
//    snapped to the local peak within 7 percent of a period, so marks keep the
//    same phase in every cycle and do not drift (the cross-correlation method
//    of Praat's "To PointProcess (cc)", plus peak picking guided by the track).
//    The march carries on up to two cycles past the tracker's voicing edges
//    while the cycles still match, so weak onsets and offsets are moved with
//    the vowel instead of keeping the old pitch. Unvoiced stretches get marks
//    about 100 per second with spacing randomised by plus or minus 25 percent,
//    which keeps repeated noise grains from buzzing at a fixed rate.
// 3. Timbre (formants) moves first, by resampling the whole signal by the
//    formant ratio k (core/resample.js; a varying ratio uses varispeed): the
//    copy plays k times faster, so every resonance, breath and "s" sound moves
//    up by k, while its pitch also rises by k and its duration shrinks by k.
// 4. TD-PSOLA on that copy restores the duration and sets the pitch. Output
//    marks are laid along the original timeline at the target period: the
//    analysis marks' own local period divided by the pitch ratio (or
//    retuneVoice's target), so output and analysis marks stay locked, every
//    voiced run starting exactly on its first analysis mark. With the pitch
//    unchanged each cycle then maps to itself, so a timbre-only change never
//    repeats or skips a cycle (a smooth-track grid drifting half a cycle off
//    the marks makes the nearest-grain choice flip and doubles the period),
//    and shifted voices keep their natural cycle-to-cycle jitter. Each takes
//    the two-period Hann grain around the analysis mark nearest in time
//    (asymmetric halves reaching the neighbouring marks, as in Praat), placed
//    unscaled, so the grain keeps the shifted formants while the spacing sets
//    the new pitch. No half is longer than the output spacing, which matters
//    when raising the pitch: two-period grains laid half a period apart see
//    the short-time spectrum through a comb (an octave up keeps only the even
//    harmonics, and a soft voice whose fundamental dominates loses up to 20 dB
//    in places), while halves capped at the output spacing are exactly
//    complementary and see the envelope smoothed at the new harmonic spacing,
//    which is what the new harmonics should sample. Unvoiced grains keep their
//    own spacing, so they are only repeated or skipped to restore duration; a
//    repeated noise grain is played time-reversed every other time (Moulines
//    and Laroche 1995) to stay noise-like. Noise grains never step backwards,
//    and a noise grain that carries an attack (a plosive burst or a click,
//    found by core/pv.js findOnsets) is never repeated or skipped, so each
//    consonant is heard exactly once: on bursts in noise, timbre changes of
//    plus or minus 4 semitones keep every burst single, and down to -12 lose
//    none (they may move by up to one output grain). Neighbouring grains where
//    either side is unvoiced use exactly complementary crossfades over the
//    output spacing, so voiced and unvoiced joins are seamless.
// 5. Energy-normalised overlap-add: raising the pitch, the complementary
//    halves already sum to one; lowering it, the grains spread apart with
//    quiet between them, so each is scaled by sqrt(output period / analysis
//    period) to keep the power. Measured on four real voices from -24 to +24
//    semitones, the level in 80 ms frames stays within about 2 dB of the input.
//
// The copy is high-passed at 25 Hz first: overlap-add with an uneven window
// sum would otherwise turn a DC offset into a buzz at the new pitch.
//
// Material with almost no voicing (music, effects, noise) or pitched above the
// tracker's range (a whistle, a beep) cannot be pitch-marked, so 'best' hands
// it to the phase vocoder (quality 'fast', core/pv.js pvShift with
// envelope-corrected formants), which is also the choice for speed or for
// non-speech sources.
//
// The work is split into a plan (marks, output marks, grain halves, gains)
// and a render per channel. shiftVoiceBuf and retuneVoiceBuf take a whole
// buffer: one pitch analysis of the channels' mix makes one plan and every
// channel is rendered from it, so a stereo voice keeps its image. retuneVoice's
// target function is called once per voiced output cycle, in time order, so it
// may keep state (a retune speed, a melody). It gets targetFn(t, f0, smoothF0):
// f0 is that cycle's own frequency (the spacing of its pitch marks), which
// jumps by a semitone or more from cycle to cycle (median 30 cents, 90th
// percentile 170 cents on real speech) and is the right base for RELATIVE
// changes (f0 times a ratio keeps every output cycle locked to its analysis
// cycle, so nothing is repeated or skipped); smoothF0 is the pitch track's f0
// at that moment, smoothed over 12 ms (a triangular weight over the voiced
// track frames, in log frequency), steady enough to choose notes on. When the
// track has nothing voiced nearby smoothF0 equals f0. (Re-pitching relative
// to smoothF0 instead of f0 roughly doubles the repeated and skipped cycles
// of a small vibrato, 2.7 to 5.0 percent on real speech, so f0 stays second.)
//
// semitones and formant may be numbers or functions of time in seconds (glides,
// vibrato, wobble). Output length always equals input length.

import { trackPitch, f0At, analysisSignal } from './pitch.js'
import { resample, varispeedWithMap } from './resample.js'
import { pvShift, findOnsets } from './pv.js'
import { makeRng } from './rng.js'
import { Biquad } from './biquad.js'

const UNVOICED_HZ = 100
const MIN_OUT_HZ = 20
const MAX_OUT_HZ = 4000
const EXTEND_CYCLES = 2
const SMOOTH_F0_SEC = 0.012

// Raised-cosine half window F(v) = 0.5 + 0.5 cos(pi v), v in 0..1.
const WT_N = 4096
const WT = new Float32Array(WT_N + 2)
for (let i = 0; i <= WT_N; i++) WT[i] = 0.5 + 0.5 * Math.cos((Math.PI * i) / WT_N)

function finite(v, def) {
  const x = Number(v)
  return x === x && x !== Infinity && x !== -Infinity ? x : def
}

/** A number or a function of time, as { value, fn }. */
function asSpec(v, lo, hi) {
  if (typeof v === 'function') {
    return {
      value: null,
      fn: (t) => {
        const x = finite(v(t), 0)
        return x < lo ? lo : x > hi ? hi : x
      },
    }
  }
  const x = finite(v, 0)
  return { value: x < lo ? lo : x > hi ? hi : x, fn: null }
}

function cleanCopy(sig) {
  const n = sig.length
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = sig[i]
    x[i] = v === v && v !== Infinity && v !== -Infinity ? v : 0
  }
  return x
}

function quality(q) {
  const s = String(q || 'best').toLowerCase()
  if (s === 'fast' || s === 'smooth' || s === 'pv' || s === 'vocoder') return 'fast'
  return 'best'
}

function trackFits(track, n, sr) {
  if (!track || !(track.hop > 0) || !track.f0 || !track.f0.length) return false
  if (track.sr && track.sr !== sr) return false
  const want = n > 0 ? Math.floor((n - 1) / track.hop) + 1 : 0
  return Math.abs(track.f0.length - want) <= 2
}

/** Share of the clearly audible frames that are voiced (1 for silence). */
function voicedShare(track) {
  const f0 = track.f0
  const lv = track.levelDb
  let mx = -200
  if (lv) for (let i = 0; i < lv.length; i++) if (lv[i] > mx) mx = lv[i]
  let loud = 0
  let v = 0
  for (let i = 0; i < f0.length; i++) {
    if (lv && !(lv[i] > mx - 35)) continue
    loud++
    if (f0[i] > 0) v++
  }
  return loud ? v / loud : 1
}

// ---------------------------------------------------------------- pitch marks

/**
 * Pitch marks for PSOLA. Voiced marks sit on glottal closure estimates, one
 * per cycle; unvoiced stretches get randomised marks about 100 per second.
 * @returns {{ pos: Float64Array, voiced: Uint8Array, period: Float32Array, count: number }}
 *   pos in input samples (ascending, first <= 0, last >= length - 1);
 *   period: the local pitch period in input samples at voiced marks (0 unvoiced).
 */
export function pitchMarks(sig, sr, track, opts = {}) {
  const n = sig.length
  const an = opts.analysis && opts.analysis.z ? opts.analysis : analysisSignal(sig, sr)
  const { z, srd, D } = an
  const delay = an.delay || 0
  const nz = z.length
  const rng = makeRng(opts.seed !== undefined ? opts.seed : 'pitch-marks')
  const S2 = new Float64Array(nz + 1)
  for (let i = 0; i < nz; i++) S2[i + 1] = S2[i] + z[i] * z[i]

  const hop = track.hop
  const f0 = track.f0
  const nf = f0.length
  const runs = []
  for (let f = 0; f < nf; ) {
    if (f0[f] > 0) {
      let g = f
      while (g < nf && f0[g] > 0) g++
      runs.push([f, g - 1])
      f = g
    } else f++
  }

  const pos = []
  const vo = []
  const per = []
  const Du = srd / UNVOICED_HZ
  const endZ = n > 0 ? (n - 1) / D : 0
  let last = -Infinity

  const push = (p, v, T) => {
    pos.push(p)
    vo.push(v)
    per.push(T)
  }
  const fill = (a, b, isEnd) => {
    let p = a
    if (p === -Infinity) {
      if (!isEnd && b <= 0.5) return
      push(0, 0, 0)
      p = 0
    }
    for (let guard = 0; guard < 1e7; guard++) {
      if (isEnd && p >= endZ) break
      const q = p + Du * (0.75 + 0.5 * rng.next())
      if (!isEnd && q > b - 0.5 * Du) break
      push(q, 0, 0)
      p = q
    }
  }

  const cc = { pos: 0, ncc: 0 }
  for (let r = 0; r < runs.length; r++) {
    const [fa, fb] = runs[r]
    const xa = fa * hop
    const xb = fb * hop
    const zs = Math.max(0, ((fa - 0.5) * hop) / D)
    const ze = Math.min(nz - 1, ((fb + 0.5) * hop) / D)
    const periodAt = (q) => {
      let xq = q * D
      if (xq < xa) xq = xa
      else if (xq > xb) xq = xb
      const hz = f0At(track, xq)
      return hz > 0 ? srd / hz : srd / 150
    }
    // polarity: which side carries the bigger peak in most cycles
    let sMax = 0
    let sMin = 0
    for (let q = Math.floor(zs); q < ze; ) {
      const T = Math.max(2, Math.round(periodAt(q)))
      let mx = -Infinity
      let mn = Infinity
      const e = Math.min(nz, q + T)
      for (let i = q; i < e; i++) {
        const v = z[i]
        if (v > mx) mx = v
        if (v < mn) mn = v
      }
      if (mx > -Infinity) {
        sMax += mx
        sMin -= mn
      }
      q += T
    }
    const pol = sMax >= sMin ? 1 : -1
    // seed: strongest peak in the middle of the run
    const span = ze - zs
    let lo = Math.floor(zs + 0.2 * span)
    let hi = Math.ceil(ze - 0.2 * span)
    if (hi <= lo) {
      lo = Math.floor(zs)
      hi = Math.ceil(ze)
    }
    if (hi > nz - 1) hi = nz - 1
    let seed = lo
    let bv = -Infinity
    for (let i = lo; i <= hi; i++) {
      const v = pol * z[i]
      if (v > bv) {
        bv = v
        seed = i
      }
    }
    const nextStart = r + 1 < runs.length ? Math.max(0, ((runs[r + 1][0] - 0.5) * hop) / D) : nz - 1
    const prevLimit = last === -Infinity ? 0 : last
    // forward
    const fwd = []
    {
      let m = seed
      let ext = 0
      for (let guard = 0; guard < 1e6; guard++) {
        const T = periodAt(m)
        if (!ccStep(z, S2, nz, m, T, 1, cc)) break
        let next = cc.ncc >= 0.35 ? snapPeak(z, nz, cc.pos, 0.07 * T, pol) : snapPeak(z, nz, m + T, 0.15 * T, pol)
        if (!(next > m + 0.5 * T)) next = m + T
        if (next > ze) {
          if (ext < EXTEND_CYCLES && cc.ncc >= 0.6 && next < nextStart - 0.5 * T && next < nz - 1) ext++
          else break
        }
        fwd.push(next)
        m = next
      }
    }
    const bwd = []
    {
      let m = seed
      let ext = 0
      for (let guard = 0; guard < 1e6; guard++) {
        const T = periodAt(m)
        if (!ccStep(z, S2, nz, m, T, -1, cc)) break
        let next = cc.ncc >= 0.35 ? snapPeak(z, nz, cc.pos, 0.07 * T, pol) : snapPeak(z, nz, m - T, 0.15 * T, pol)
        if (!(next < m - 0.5 * T)) next = m - T
        if (next < zs) {
          if (ext < EXTEND_CYCLES && cc.ncc >= 0.6 && next > prevLimit + 0.5 * T && next > 0) ext++
          else break
        }
        bwd.push(next)
        m = next
      }
    }
    const runMarks = []
    for (let i = bwd.length - 1; i >= 0; i--) runMarks.push(bwd[i])
    runMarks.push(seed)
    for (let i = 0; i < fwd.length; i++) runMarks.push(fwd[i])
    // keep only marks after everything placed so far
    let k0 = 0
    while (k0 < runMarks.length && runMarks[k0] <= last + 1) k0++
    if (k0 >= runMarks.length) continue
    fill(last, runMarks[k0], false)
    for (let i = k0; i < runMarks.length; i++) push(runMarks[i], 1, periodAt(runMarks[i]))
    last = runMarks[runMarks.length - 1]
  }
  fill(last, endZ, true)
  if (!pos.length) push(0, 0, 0)
  // the delay correction below may pull a final voiced mark a few samples
  // short of the end; one more unvoiced mark then closes the timeline
  if ((pos[pos.length - 1] * D - (vo[vo.length - 1] ? delay : 0)) < n - 1) push((n - 1) / D + 1, 0, 0)

  const count = pos.length
  const out = { pos: new Float64Array(count), voiced: new Uint8Array(count), period: new Float32Array(count), count }
  for (let i = 0; i < count; i++) {
    out.pos[i] = pos[i] * D - (vo[i] ? delay : 0)
    out.voiced[i] = vo[i]
    out.period[i] = per[i] * D
  }
  // ascending order is kept by construction; make sure of it after the delay shift
  for (let i = 1; i < count; i++) if (out.pos[i] <= out.pos[i - 1]) out.pos[i] = out.pos[i - 1] + 1
  if (out.pos[0] > 0) out.pos[0] = 0
  return out
}

/**
 * Next mark by normalised cross-correlation of one period around m with one
 * period around each candidate; result in res.pos / res.ncc. False at the edges.
 */
function ccStep(z, S2, nz, m, T, dir, res) {
  const im = Math.round(m)
  const h = Math.max(2, Math.round(0.5 * T))
  if (im - h < 0 || im + h >= nz) return false
  const expect = m + dir * T
  let lo = Math.round(dir > 0 ? m + 0.75 * T : m - 1.3 * T)
  let hi = Math.round(dir > 0 ? m + 1.3 * T : m - 0.75 * T)
  if (lo < h) lo = h
  if (hi > nz - 1 - h) hi = nz - 1 - h
  if (hi < lo) return false
  const eRef = S2[im + h + 1] - S2[im - h]
  let best = -Infinity
  let bestC = lo
  let bestN = 0
  let sPrev = -Infinity
  let sBest = -Infinity
  let sNext = -Infinity
  let prevScore = -Infinity
  const pen = 0.15 / (0.09 * T * T)
  for (let c = lo; c <= hi; c++) {
    const o = c - im
    let dot = 0
    for (let j = im - h; j <= im + h; j++) dot += z[j] * z[j + o]
    const eC = S2[c + h + 1] - S2[c - h]
    const den = Math.sqrt(eRef * eC)
    const ncc = den > 1e-20 ? dot / den : 0
    const dv = c - expect
    const sc = ncc - pen * dv * dv
    if (sc > best) {
      best = sc
      bestC = c
      bestN = ncc
      sPrev = prevScore
      sBest = sc
      sNext = -Infinity
    } else if (c === bestC + 1) {
      sNext = sc
    }
    prevScore = sc
  }
  let off = 0
  if (sPrev > -Infinity && sNext > -Infinity) {
    const den = sPrev - 2 * sBest + sNext
    if (den < 0) {
      off = (0.5 * (sPrev - sNext)) / den
      if (off > 0.5) off = 0.5
      else if (off < -0.5) off = -0.5
    }
  }
  res.pos = bestC + off
  res.ncc = bestN
  return true
}

/** Local peak of pol * z within radius of pos (sub-sample); pos itself if none. */
function snapPeak(z, nz, pos, radius, pol) {
  const r = radius < 1 ? 1 : radius
  let lo = Math.floor(pos - r)
  let hi = Math.ceil(pos + r)
  if (lo < 1) lo = 1
  if (hi > nz - 2) hi = nz - 2
  if (hi <= lo) return pos
  let bi = lo
  let bv = -Infinity
  for (let i = lo; i <= hi; i++) {
    const v = pol * z[i]
    if (v > bv) {
      bv = v
      bi = i
    }
  }
  if (bi <= lo || bi >= hi) return pos
  const a = pol * z[bi - 1]
  const c = pol * z[bi + 1]
  const den = a - 2 * bv + c
  let off = 0
  if (den < 0) {
    off = (0.5 * (a - c)) / den
    if (off > 0.5) off = 0.5
    else if (off < -0.5) off = -0.5
  }
  return bi + off
}

// ---------------------------------------------------------------- PSOLA

/**
 * The pitch track's f0 around input sample s, smoothed over SMOOTH_F0_SEC: a
 * triangular weight (full width 12 ms, never narrower than two track hops)
 * over the voiced frames, averaged in log frequency. 0 when nothing near s is
 * voiced. half is half the window in samples.
 */
function smoothF0At(track, s, half) {
  const f0 = track.f0
  const hop = track.hop
  const nf = f0 ? f0.length : 0
  if (!nf || !(hop > 0)) return 0
  const w = (half > hop ? half : hop) / hop
  const c = s / hop
  let j0 = Math.ceil(c - w)
  let j1 = Math.floor(c + w)
  if (j0 < 0) j0 = 0
  if (j1 > nf - 1) j1 = nf - 1
  let sw = 0
  let sl = 0
  for (let j = j0; j <= j1; j++) {
    const v = f0[j]
    if (!(v > 0) || v === Infinity) continue
    const d = j - c
    const wt = 1 - (d < 0 ? -d : d) / w
    if (wt <= 0) continue
    sw += wt
    sl += wt * Math.log(v)
  }
  return sw > 0 ? Math.exp(sl / sw) : 0
}

class Grow {
  constructor(n) {
    this.a = new Float64Array(Math.max(16, n))
    this.n = 0
  }
  push(v) {
    if (this.n >= this.a.length) {
      const b = new Float64Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = v
  }
}

/** The formant-shifted copy y of x, and how y's time maps to x's. */
function formantCopy(x, sr, formant) {
  let y
  let k = 1
  let map = null
  let mapStep = 1
  if (formant.fn === null) {
    k = Math.pow(2, formant.value / 12)
    if (Math.abs(k - 1) < 1e-9) {
      k = 1
      y = Float32Array.from(x)
    } else {
      y = resample(x, 1 / k)
    }
  } else {
    const fn = formant.fn
    const r = varispeedWithMap(x, (t) => Math.pow(2, fn(t) / 12), sr, { clock: 'in', stopFade: 0 })
    y = r.out
    map = r.map
    mapStep = r.mapStep
  }
  new Biquad('highpass', sr, 25, 0.7071).run(y)
  return { y, k, map, mapStep }
}

/**
 * Plan the overlap-add: analysis grains in y, output marks, grain halves,
 * gains and reversals. It depends only on the marks, the track, the target
 * and the time map, so every channel is rendered from the same plan, and a
 * stateful targetAt is called exactly once per voiced output cycle, in time
 * order. targetAt(tSeconds, f0, smoothF0) returns output Hz for a voiced
 * cycle: f0 is the cycle's own frequency, smoothF0 the track's, smoothed.
 */
function psolaPlan(n, sr, track, marks, targetAt, fc, onsets) {
  const M = marks.count
  const mp = marks.pos
  const mv = marks.voiced
  const { k, map, mapStep } = fc
  // unvoiced grains that carry an attack (a plosive burst, a click) with real
  // weight: those must be played exactly once, never repeated or skipped
  const burst = new Uint8Array(M)
  if (onsets && onsets.length && M > 1) {
    // an attack lasts a few milliseconds: look at its start and 3 and 6 ms in
    const d3 = 0.003 * sr
    for (let q = 0; q < onsets.length; q++) {
      for (let s3 = 0; s3 < 3; s3++) {
        const o = onsets[q] + s3 * d3
        let lo = 0
        let hi = M - 1
        if (!(o >= mp[0] && o < mp[M - 1])) continue
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          if (mp[mid] <= o) lo = mid
          else hi = mid
        }
        const span = mp[lo + 1] - mp[lo]
        if (!(span > 0)) continue
        // window weights of the two grains around this point
        const wl = 0.5 + 0.5 * Math.cos((Math.PI * (o - mp[lo])) / span)
        if (wl > 0.2 && !mv[lo]) burst[lo] = 1
        if (1 - wl > 0.2 && !mv[lo + 1]) burst[lo + 1] = 1
      }
    }
  }
  // analysis marks in y samples, and each grain's half lengths
  const A = new Float64Array(M)
  if (!map) {
    for (let i = 0; i < M; i++) A[i] = mp[i] / k
  } else {
    let q = 0
    const last = map.length - 1
    for (let i = 0; i < M; i++) {
      const m = mp[i]
      while (q + 1 < last && map[q + 1] <= m) q++
      const a = map[q]
      const b = map[q + 1]
      const slope = b - a > 1e-9 ? b - a : 1e-9
      A[i] = (q + (m - a) / slope) * mapStep
    }
  }
  const AL = new Float64Array(M)
  const AR = new Float64Array(M)
  for (let i = 0; i < M; i++) {
    let dl = i > 0 ? A[i] - A[i - 1] : M > 1 ? A[1] - A[0] : 1
    let dr = i + 1 < M ? A[i + 1] - A[i] : dl
    if (mv[i]) {
      const lv = i > 0 && mv[i - 1]
      const rv = i + 1 < M && mv[i + 1]
      if (!lv && rv) dl = Math.min(dl, dr * 1.25)
      if (!rv && lv) dr = Math.min(dr, dl * 1.25)
    }
    AL[i] = dl > 1 ? dl : 1
    AR[i] = dr > 1 ? dr : 1
  }

  // output marks along the output (= input) timeline. Voiced ones step by the
  // analysis marks' own local period over the pitch ratio (the track only vets
  // it), and each voiced run starts exactly on its first analysis mark, so the
  // two sets of marks stay locked (see the header).
  const smoothHalf = 0.5 * SMOOTH_F0_SEC * sr
  const est = Math.min(Math.ceil(n / Math.max(1, sr / MAX_OUT_HZ)) + 16, Math.ceil(n / 8) + 64)
  const sPos = new Grow(est)
  const sIdx = new Grow(est)
  const sT = new Grow(est)
  let s = mp[0]
  let i = 0
  for (let guard = 0; guard < 1e8 && s < n + 1; guard++) {
    while (i + 1 < M && mp[i + 1] <= s) i++
    let near = i
    if (i + 1 < M) {
      const span = mp[i + 1] - mp[i]
      if (span > 0 && (s - mp[i]) / span >= 0.5) near = i + 1
    }
    let T
    if (i + 1 < M && !mv[i] && mv[i + 1] && s < mp[i + 1] - 0.5) {
      // approaching a voiced run: an unvoiced grain, landing on its first mark
      near = i
      T = 0.5 * (AL[i] + AR[i])
      if (!(T >= 1)) T = 1
      if (s + 1.3 * T >= mp[i + 1]) T = mp[i + 1] - s
    } else if (mv[near]) {
      let Tact = 0
      if (near + 1 < M && mv[near + 1]) Tact = mp[near + 1] - mp[near]
      else if (near > 0 && mv[near - 1]) Tact = mp[near] - mp[near - 1]
      const ftr = f0At(track, s)
      const Ttr = ftr > 0 ? sr / ftr : marks.period[near] > 0 ? marks.period[near] : 0
      if (!(Tact > 0) || (Ttr > 0 && (Tact > 1.35 * Ttr || Tact < 0.74 * Ttr))) Tact = Ttr
      if (!(Tact > 0)) Tact = sr / 120
      const f0 = sr / Tact
      let fs = smoothF0At(track, s, smoothHalf)
      if (!(fs > 0)) fs = f0
      let ft = targetAt(s / sr, f0, fs)
      if (!(ft > 0) || ft === Infinity) ft = f0
      if (ft < MIN_OUT_HZ) ft = MIN_OUT_HZ
      else if (ft > MAX_OUT_HZ) ft = MAX_OUT_HZ
      T = sr / ft
    } else {
      // never repeat or skip a grain that carries an attack; the timing
      // catches up on the following noise grains
      const prevG = sIdx.n ? sIdx.a[sIdx.n - 1] : -1
      if (prevG >= 0 && near < prevG && !mv[prevG]) near = prevG // noise grains never go backwards
      if (prevG >= 0 && near === prevG && burst[near] && near + 1 < M && !mv[near + 1]) near++
      else if (prevG >= 0 && near > prevG + 1) {
        for (let g = prevG + 1; g < near; g++) {
          if (burst[g]) {
            near = g
            break
          }
        }
      }
      T = 0.5 * (AL[near] + AR[near])
      if (!(T >= 1)) T = 1
    }
    sPos.push(s)
    sIdx.push(near)
    sT.push(T)
    s += T
  }
  const NS = sPos.n
  const SP = sPos.a
  const SI = sIdx.a
  const STo = sT.a

  // grain halves, gains, reversals; complementary crossfades at unvoiced joins
  const P = new Int32Array(NS)
  const C = new Int32Array(NS)
  const Lh = new Int32Array(NS)
  const Rh = new Int32Array(NS)
  const G = new Float32Array(NS)
  const rev = new Uint8Array(NS)
  for (let q = 0; q < NS; q++) {
    P[q] = Math.round(SP[q])
    C[q] = Math.round(A[SI[q]])
  }
  let voicedGrains = 0
  for (let q = 0; q < NS; q++) {
    const gi = SI[q]
    const v = mv[gi]
    if (q === 0) Lh[q] = Math.max(1, Math.round(AL[gi]))
    if (q + 1 < NS) {
      const g2 = SI[q + 1]
      const dd = Math.max(1, P[q + 1] - P[q])
      if (v && mv[g2]) {
        // two periods, but never longer than the output spacing: raising the
        // pitch then uses exactly complementary halves (see the header)
        Rh[q] = Math.max(1, Math.min(dd, Math.round(AR[gi])))
        Lh[q + 1] = Math.max(1, Math.min(dd, Math.round(AL[g2])))
      } else {
        Rh[q] = dd
        Lh[q + 1] = dd
      }
    } else {
      Rh[q] = Math.max(1, Math.round(AR[gi]))
    }
    if (v) {
      voicedGrains++
      // lowering spreads the grains apart: scale them to keep the power
      const spread = STo[q] / (0.5 * (AL[gi] + AR[gi]))
      let g = spread > 1 ? Math.sqrt(spread) : 1
      if (g > 4) g = 4
      G[q] = g
    } else {
      G[q] = 1
      if (q > 0 && SI[q - 1] === gi && !rev[q - 1]) rev[q] = 1
    }
  }
  let maxHalf = 1
  let minP = 0
  let maxP = n
  for (let q = 0; q < NS; q++) {
    if (Lh[q] > maxHalf) maxHalf = Lh[q]
    if (Rh[q] > maxHalf) maxHalf = Rh[q]
    if (P[q] < minP) minP = P[q]
    if (P[q] > maxP) maxP = P[q]
  }
  const off = maxHalf + 2 - minP
  return { n, NS, P, C, Lh, Rh, G, rev, off, outLen: maxP + off + maxHalf + 4, voicedGrains }
}

/** Overlap-add one channel's formant copy y with a plan. */
function psolaRender(y, plan) {
  const { n, NS, P, C, Lh, Rh, G, rev, off, outLen } = plan
  const ny = y.length
  const out = new Float32Array(outLen)
  for (let q = 0; q < NS; q++) {
    const c = C[q]
    const p0 = P[q] + off
    const g = G[q]
    const Lq = Lh[q]
    const Rq = Rh[q]
    const sL = WT_N / Lq
    const sR = WT_N / Rq
    if (!rev[q]) {
      let u0 = 1 - Lq
      if (c + u0 < 0) u0 = -c
      let u1 = Rq - 1
      if (c + u1 > ny - 1) u1 = ny - 1 - c
      const uMid = u1 < 0 ? u1 : 0
      for (let u = u0; u <= uMid; u++) {
        const t = -u * sL
        const ii = t | 0
        const w = WT[ii] + (t - ii) * (WT[ii + 1] - WT[ii])
        out[p0 + u] += g * w * y[c + u]
      }
      for (let u = u0 > 1 ? u0 : 1; u <= u1; u++) {
        const t = u * sR
        const ii = t | 0
        const w = WT[ii] + (t - ii) * (WT[ii + 1] - WT[ii])
        out[p0 + u] += g * w * y[c + u]
      }
    } else {
      // time-reversed noise grain: content y[c - u]
      let u0 = 1 - Lq
      if (c - u0 > ny - 1) u0 = c - (ny - 1)
      let u1 = Rq - 1
      if (c - u1 < 0) u1 = c
      const uMid = u1 < 0 ? u1 : 0
      for (let u = u0; u <= uMid; u++) {
        const t = -u * sL
        const ii = t | 0
        const w = WT[ii] + (t - ii) * (WT[ii + 1] - WT[ii])
        out[p0 + u] += g * w * y[c - u]
      }
      for (let u = u0 > 1 ? u0 : 1; u <= u1; u++) {
        const t = u * sR
        const ii = t | 0
        const w = WT[ii] + (t - ii) * (WT[ii + 1] - WT[ii])
        out[p0 + u] += g * w * y[c - u]
      }
    }
  }
  const res = new Float32Array(n)
  for (let t = 0; t < n; t++) {
    const v = out[t + off]
    res[t] = v === v && v < 1e30 && v > -1e30 ? v : 0
  }
  return res
}

// ---------------------------------------------------------------- public API

function monoOf(xs) {
  if (xs.length === 1) return xs[0]
  const n = xs[0].length
  const m = new Float32Array(n)
  const g = 1 / xs.length
  for (let c = 0; c < xs.length; c++) {
    const s = xs[c]
    for (let i = 0; i < n; i++) m[i] += s[i] * g
  }
  return m
}

/**
 * The shared driver: one pitch track and one set of marks from the channels'
 * mix, one plan, then every channel rendered from it (stereo stays coherent).
 */
function runVoice(chans, sr, opts, targetFromF0, pitchIsIdentity, semis) {
  const nch = chans.length
  const n = nch ? chans[0].length : 0
  const info = opts.info && typeof opts.info === 'object' ? opts.info : null
  if (n === 0) return chans.map(() => new Float32Array(0))
  const xs = chans.map(cleanCopy)
  // without a usable sample rate there is no time scale to work on: no change
  if (!(sr > 0 && sr < Infinity)) return xs
  const formant = asSpec(opts.formant, -24, 24)
  const formantIdentity = formant.fn === null && formant.value === 0
  if (pitchIsIdentity && formantIdentity) {
    if (info) info.method = 'copy'
    return xs
  }
  const fast = () => {
    if (info) info.method = 'pv'
    const ratio = semis.fn ? (t) => Math.pow(2, semis.fn(t) / 12) : Math.pow(2, semis.value / 12)
    const fr = formant.fn ? (t) => Math.pow(2, formant.fn(t) / 12) : Math.pow(2, formant.value / 12)
    return xs.map((x) => pvShift(x, sr, ratio, { keepFormants: true, formantRatio: fr }))
  }
  if (semis && quality(opts.quality) === 'fast') return fast()
  const mono = monoOf(xs)
  const an = analysisSignal(mono, sr)
  let track = opts.track
  if (!trackFits(track, n, sr)) track = trackPitch(mono, sr, { analysis: an })
  const share = voicedShare(track)
  if (info) info.voicedShare = share
  // unpitched material only needs the vocoder for a pitch change (a timbre
  // change of noise is exactly the resampling below); material pitched above
  // the tracker's range always does, since its marks would be subharmonics
  if (semis && ((!pitchIsIdentity && share < 0.12) || track.aboveShare > 0.5)) return fast()
  const marks = pitchMarks(mono, sr, track, { analysis: an, seed: opts.seed })
  const fc0 = formantCopy(xs[0], sr, formant)
  const plan = psolaPlan(n, sr, track, marks, targetFromF0, fc0, findOnsets(mono, sr))
  const out = [psolaRender(fc0.y, plan)]
  for (let c = 1; c < nch; c++) out.push(psolaRender(formantCopy(xs[c], sr, formant).y, plan))
  if (info) {
    info.method = 'psola'
    info.marks = marks.count
    info.voicedMarks = 0
    for (let q = 0; q < marks.count; q++) info.voicedMarks += marks.voiced[q]
    info.grains = plan.NS
    info.voicedGrains = plan.voicedGrains
  }
  return out
}

function shiftTarget(semis) {
  if (semis.fn === null) {
    const ratio = Math.pow(2, semis.value / 12)
    return (t, f0) => f0 * ratio
  }
  const fn = semis.fn
  return (t, f0) => f0 * Math.pow(2, fn(t) / 12)
}

function retuneTarget(fn) {
  return fn
    ? (t, f0, fs) => {
        const v = Number(fn(t, f0, fs))
        return v > 0 && v < Infinity ? v : f0
      }
    : (t, f0) => f0
}

/**
 * Move pitch and timbre independently.
 * @param {Float32Array} sig mono speech
 * @param {number} sr
 * @param {{ semitones?: number|((t:number)=>number), formant?: number|((t:number)=>number),
 *   track?: object, quality?: 'best'|'fast', seed?: any, info?: object }} opts
 *   semitones: pitch change (-36..36); formant: timbre change in semitones
 *   (-24..24; up sounds smaller, down sounds bigger). Functions get seconds.
 *   track: a trackPitch() result for this same signal, to skip tracking.
 *   quality: 'best' (PSOLA, the default) or 'fast' (phase vocoder).
 *   info: optional object that is filled with what was done.
 * @returns {Float32Array} same length as sig
 */
export function shiftVoice(sig, sr, opts = {}) {
  const o = opts || {}
  const semis = asSpec(o.semitones, -36, 36)
  const identity = semis.fn === null && semis.value === 0
  return runVoice([sig || new Float32Array(0)], sr, o, shiftTarget(semis), identity, semis)[0]
}

/**
 * Re-pitch every glottal cycle: targetFn(tSeconds, f0, smoothF0) returns the
 * wanted Hz for the cycle at that time, or 0 to keep the original. It is called
 * in time order, once per voiced output cycle, so it may keep state (smoothing,
 * retune speed). Pitch correction, monotone robots and melodies.
 * f0 is the cycle's own frequency: multiply it for relative changes (vibrato,
 * a shift, a pull toward a note), so the output stays locked to the voice.
 * smoothF0 is the pitch track at that time smoothed over 12 ms: decide notes
 * on it (a single cycle's own f0 is too jumpy to pick a note from).
 * @param {{ targetFn: (t:number, f0:number, smoothF0:number)=>number, track?: object,
 *   formant?: number|((t:number)=>number), seed?: any, info?: object }} opts
 * @returns {Float32Array} same length as sig
 */
export function retuneVoice(sig, sr, opts = {}) {
  const o = opts || {}
  const fn = typeof o.targetFn === 'function' ? o.targetFn : null
  return runVoice([sig || new Float32Array(0)], sr, o, retuneTarget(fn), !fn, null)[0]
}

/**
 * shiftVoice for a whole buffer { sr, ch }: one pitch analysis of the channels'
 * mix drives every channel, so a stereo voice keeps its image. opts.track, if
 * given, must be a trackPitch() of that mix. Returns a new buffer.
 */
export function shiftVoiceBuf(buf, opts = {}) {
  const o = opts || {}
  const semis = asSpec(o.semitones, -36, 36)
  const identity = semis.fn === null && semis.value === 0
  return { sr: buf.sr, ch: runVoice(buf.ch, buf.sr, o, shiftTarget(semis), identity, semis) }
}

/** retuneVoice for a whole buffer, channels kept coherent like shiftVoiceBuf. */
export function retuneVoiceBuf(buf, opts = {}) {
  const o = opts || {}
  const fn = typeof o.targetFn === 'function' ? o.targetFn : null
  return { sr: buf.sr, ch: runVoice(buf.ch, buf.sr, o, retuneTarget(fn), !fn, null) }
}
