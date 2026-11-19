// core/pitch.js - fundamental frequency (pitch) tracking for speech.
//
// Estimator: YIN, de Cheveigne and Kawahara 2002, "YIN, a fundamental
// frequency estimator for speech and music" (JASA 111). For each frame:
// - the difference function d(tau) = sum over a window of (x[j] - x[j+tau])^2,
//   computed as energy(window) + energy(window shifted by tau) minus twice the
//   cross-correlation. The energies come from a running sum of squares and
//   the cross-correlation from one FFT product per frame (core/fft.js real
//   transforms), so a frame costs three small FFTs instead of W * tauMax
//   multiplies;
// - the cumulative mean normalised difference d'(tau) = d(tau) * tau /
//   sum(d(1..tau)), which is 1 for noise and near 0 at the period of a
//   periodic signal; its value at the chosen dip is the frame's aperiodicity;
// - dips (local minima of d') are candidates; the classic YIN choice is the
//   first dip under the absolute threshold (opts.threshold), followed down to
//   its local minimum;
// - each candidate's lag is refined by parabolic interpolation of d(tau)
//   through the dip and its two neighbours.
// The integration window is one longest period (1 / minHz), so a frame spans
// two of them (33 ms at the default 60 Hz floor).
//
// Path: instead of trusting each frame alone, the best path through every
// frame's candidates (up to five dips plus "unvoiced") is found by dynamic
// programming (Viterbi), in the manner of Boersma 1993's path finder in
// Praat ("Accurate short-term analysis of the fundamental frequency and the
// harmonics-to-noise ratio of a sampled sound") and the HMM of pYIN (Mauch
// and Dixon 2014). Local costs are the aperiodicity plus a small octave cost
// (0.02 per octave below the frame's highest plausible candidate, so it only
// ranks candidates and never biases voicing against low voices) that breaks
// ties toward the higher pitch, in the spirit of YIN's first-dip rule;
// transitions cost in proportion to the jump in octaves, and switching
// between voiced and unvoiced has a fixed cost. This is the
// octave-jump correction: an isolated frame that jumps an octave costs more
// than taking that frame's second-best dip. The unvoiced state costs the
// voicing threshold in loud frames and nothing in quiet ones, so the voicing
// decision uses both aperiodicity and energy. A stronger pull toward YIN's
// first dip was measured to cause octave-up errors on voices whose first
// formant sits on the second harmonic (a woman's "ee"), so it is not used.
//
// Afterwards voiced runs shorter than three frames are dropped and a
// five-frame median (over voiced neighbours only) removes single-frame
// outliers.
//
// Speed: analysis runs on a decimated copy (a 30 Hz high-pass and a sixth-order
// Butterworth low-pass at 4.8 kHz from core/biquad.js, then every Dth sample,
// about 16 kHz) because pitch lives far below that. The lag precision after
// parabolic interpolation is still a small fraction of a sample. 30 seconds
// of 48 kHz audio tracks in about 0.2 to 0.35 s in Node.
//
// The track: { hop, f0, conf, sr, levelDb, length, minHz, maxHz, aboveShare }.
// Frame f is centred on input sample f * hop. f0 is Hz, 0 where unvoiced. conf
// is the periodicity 1 - d' (0..1). levelDb is the frame's level in dBFS (of the
// analysis copy), used by voice.js to tell quiet from loud. aboveShare is the
// share of voiced frames that are at least as periodic at a lag shorter than
// maxHz allows (a whistle, a beep, a high sung note): voice.js hands those to
// the phase vocoder, since pitch marks would land on a subharmonic.

import { Biquad } from './biquad.js'
import { fftOf, nextPow2 } from './fft.js'

const K = 5 // candidates kept per frame
const VUV_COST = 0.15
const JUMP_COST = 0.35 // per octave between neighbouring frames
const OCTAVE_COST = 0.02 // per octave below the frame's highest plausible candidate
const QUIET_PENALTY = 2

/** A usable sample rate: anything that is not a positive finite number reads as 48 kHz. */
function validRate(sr) {
  const r = Number(sr)
  return r > 0 && r < Infinity ? r : 48000
}

function clampNum(v, lo, hi, def) {
  const x = Number(v)
  if (!(x === x) || x === Infinity || x === -Infinity) return def
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Band-limited, decimated copy used for pitch analysis and pitch marks.
 * @returns {{ z: Float32Array, srd: number, D: number, delay: number }}
 *   z at rate srd = sr / D; delay is the low-frequency group delay of the
 *   filters in input samples (subtract it from positions found in z * D).
 */
export function analysisSignal(sig, srIn) {
  const n = sig.length
  const sr = validRate(srIn)
  const D = Math.max(1, Math.floor(sr / 16000))
  const srd = sr / D
  const fc = Math.min(4800, 0.42 * srd)
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = sig[i]
    y[i] = v === v && v !== Infinity && v !== -Infinity ? v : 0
  }
  const filters = [
    new Biquad('highpass', sr, 30, 0.7071),
    new Biquad('lowpass', sr, fc, 0.5176),
    new Biquad('lowpass', sr, fc, 0.7071),
    new Biquad('lowpass', sr, fc, 1.9319),
  ]
  for (const f of filters) f.run(y)
  // group delay of the cascade around 150..250 Hz, from the exact phase response
  let delay = 0
  {
    const w1 = (2 * Math.PI * 150) / sr
    const w2 = (2 * Math.PI * 250) / sr
    let ph1 = 0
    let ph2 = 0
    for (const f of filters) {
      ph1 += biquadPhase(f, w1)
      ph2 += biquadPhase(f, w2)
    }
    let dp = ph2 - ph1
    while (dp > Math.PI) dp -= 2 * Math.PI
    while (dp < -Math.PI) dp += 2 * Math.PI
    delay = -dp / (w2 - w1)
    if (!(delay > 0 && delay < sr * 0.01)) delay = 0
  }
  if (D === 1) return { z: y, srd, D, delay }
  const nz = n > 0 ? Math.floor((n - 1) / D) + 1 : 0
  const z = new Float32Array(nz)
  for (let i = 0; i < nz; i++) z[i] = y[i * D]
  return { z, srd, D, delay }
}

function biquadPhase(f, w) {
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = f.b0 + f.b1 * c1 + f.b2 * c2
  const ni = -(f.b1 * s1 + f.b2 * s2)
  const dr = 1 + f.a1 * c1 + f.a2 * c2
  const di = -(f.a1 * s1 + f.a2 * s2)
  return Math.atan2(ni, nr) - Math.atan2(di, dr)
}

/**
 * Track the pitch of speech.
 * @param {Float32Array} sig
 * @param {number} sr
 * @param {{minHz?:number, maxHz?:number, hopMs?:number, threshold?:number,
 *   voicing?:number, gateDb?:number, analysis?:object}} opts
 *   threshold: YIN absolute threshold for the first-dip choice (0.15).
 *   voicing: highest aperiodicity still called voiced in loud frames (0.5).
 *   gateDb: frames this far below the loudest frame are unvoiced (50).
 * @returns {{hop:number, f0:Float32Array, conf:Float32Array, sr:number,
 *   levelDb:Float32Array, length:number, minHz:number, maxHz:number}}
 */
export function trackPitch(sig, srIn, opts = {}) {
  const n = sig ? sig.length : 0
  const sr = validRate(srIn)
  const minHz = clampNum(opts.minHz, 20, 2000, 60)
  const maxHz = Math.max(minHz * 1.5, clampNum(opts.maxHz, 40, 8000, 900))
  const hopMs = clampNum(opts.hopMs, 0.5, 100, 5)
  const thr = clampNum(opts.threshold, 0.01, 0.9, 0.15)
  const vthr = clampNum(opts.voicing, 0.05, 1, 0.5)
  const gateRel = clampNum(opts.gateDb, 10, 120, 50)
  const hop = Math.max(1, Math.round((hopMs * sr) / 1000))
  const nf = n > 0 ? Math.floor((n - 1) / hop) + 1 : 0
  const f0 = new Float32Array(nf)
  const conf = new Float32Array(nf)
  const levelDb = new Float32Array(nf)
  const track = { hop, f0, conf, sr, levelDb, length: n, minHz, maxHz, aboveShare: 0 }
  if (nf === 0) return track
  levelDb.fill(-200)

  const an = opts.analysis && opts.analysis.z && opts.analysis.D ? opts.analysis : analysisSignal(sig, sr)
  const { z, srd, D } = an
  const nz = z.length
  const tauMin = Math.max(2, Math.floor(srd / Math.min(maxHz, srd / 2.5)))
  const tauMax = Math.max(tauMin + 3, Math.ceil(srd / minHz) + 1)
  const W = tauMax
  const span = W + tauMax + 2
  const N = nextPow2(span + 1)
  const fft = fftOf(N)
  const nb = (N >> 1) + 1

  // running sum of squares, with implicit zeros outside the signal
  const S = new Float64Array(nz + 1)
  for (let i = 0; i < nz; i++) S[i + 1] = S[i] + z[i] * z[i]
  const E = (a, b) => {
    const lo = a < 0 ? 0 : a > nz ? nz : a
    const hi = b < 0 ? 0 : b > nz ? nz : b
    return hi > lo ? S[hi] - S[lo] : 0
  }

  const seg = new Float64Array(N)
  const aRe = new Float64Array(nb)
  const aIm = new Float64Array(nb)
  const bRe = new Float64Array(nb)
  const bIm = new Float64Array(nb)
  const r = new Float64Array(N)
  const d = new Float64Array(tauMax + 2)
  const dn = new Float64Array(tauMax + 2)
  const dipT = new Int32Array(tauMax + 2)
  const dipV = new Float64Array(tauMax + 2)

  const candT = new Float32Array(nf * K) // refined lag in z samples
  const candA = new Float32Array(nf * K) // aperiodicity d'
  const candN = new Uint8Array(nf)
  const bestA = new Float32Array(nf)
  const hiDip = new Float32Array(nf).fill(1)
  let maxLevel = -200

  for (let f = 0; f < nf; f++) {
    const cz = Math.round((f * hop) / D)
    const t0 = cz - ((W + tauMax) >> 1)
    const e0 = E(t0, t0 + W)
    const lvl = 10 * Math.log10(e0 / W + 1e-20)
    levelDb[f] = lvl
    if (lvl > maxLevel) maxLevel = lvl
    bestA[f] = 1
    if (!(e0 > 1e-14)) continue
    // window x1 = z[t0 .. t0+W), x2 = z[t0 .. t0+W+tauMax+1)
    for (let i = 0; i < N; i++) {
      const k = t0 + i
      seg[i] = i < W && k >= 0 && k < nz ? z[k] : 0
    }
    fft.realForward(seg, aRe, aIm)
    const l2 = W + tauMax + 2
    for (let i = 0; i < N; i++) {
      const k = t0 + i
      seg[i] = i < l2 && k >= 0 && k < nz ? z[k] : 0
    }
    fft.realForward(seg, bRe, bIm)
    // conj(A) * B -> cross-correlation r[tau] = sum_j x1[j] x2[j + tau]
    for (let k = 0; k < nb; k++) {
      const ar = aRe[k], ai = aIm[k], br = bRe[k], bi = bIm[k]
      bRe[k] = ar * br + ai * bi
      bIm[k] = ar * bi - ai * br
    }
    fft.realInverse(bRe, bIm, r)
    d[0] = 0
    dn[0] = 1
    let run = 0
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let v = e0 + E(t0 + tau, t0 + tau + W) - 2 * r[tau]
      if (!(v > 0)) v = 0
      d[tau] = v
      run += v
      dn[tau] = run > 0 ? (v * tau) / run : 1
    }
    // deepest dip at lags shorter than the range: a pitch above maxHz
    let hd = 1
    for (let tau = 2; tau < tauMin; tau++) {
      const v = dn[tau]
      if (v < hd && v < dn[tau - 1] && v <= dn[tau + 1]) hd = v
    }
    hiDip[f] = hd
    // dips of d' in [tauMin, tauMax]
    let nd = 0
    let gMin = 1e9
    let yin = -1
    for (let tau = tauMin; tau <= tauMax; tau++) {
      const v = dn[tau]
      if (v < gMin) gMin = v
      if (v < dn[tau - 1] && v <= dn[tau + 1]) {
        dipT[nd] = tau
        dipV[nd] = v
        if (yin < 0 && v < thr) yin = nd
        nd++
      }
    }
    // the YIN first-dip rule: the first time d' goes under the threshold,
    // followed down to its local minimum (that is the first dip under it)
    bestA[f] = gMin < 1 ? gMin : 1
    if (nd === 0) continue
    // choose up to K candidates: the YIN dip, then the deepest others
    let cn = 0
    const base = f * K
    const used = yin
    if (yin >= 0) {
      writeCand(base, cn++, dipT[yin], d, dn)
    }
    while (cn < K) {
      let bi = -1
      let bv = 0.98
      for (let q = 0; q < nd; q++) {
        if (q === used || dipT[q] < 0) continue
        if (dipV[q] < bv) {
          bv = dipV[q]
          bi = q
        }
      }
      if (bi < 0) break
      writeCand(base, cn++, dipT[bi], d, dn)
      dipT[bi] = -1
    }
    candN[f] = cn
  }

  function writeCand(base, slot, tau, dd, ddn) {
    const a = dd[tau - 1], b = dd[tau], c = dd[tau + 1]
    const den = a - 2 * b + c
    let off = den > 0 ? (0.5 * (a - c)) / den : 0
    if (off > 1) off = 1
    else if (off < -1) off = -1
    candT[base + slot] = tau + off
    // aperiodicity at the interpolated minimum of d'
    const pa = ddn[tau - 1], pb = ddn[tau], pc = ddn[tau + 1]
    const pden = pa - 2 * pb + pc
    let v = pb
    if (pden > 0) {
      let o2 = (0.5 * (pa - pc)) / pden
      if (o2 > 1) o2 = 1
      else if (o2 < -1) o2 = -1
      v = pb - 0.25 * (pa - pc) * o2
    }
    candA[base + slot] = v < 0 ? 0 : v
  }

  // ---- Viterbi over candidates (states 0..K-1 voiced, K unvoiced)
  const gate = Math.max(maxLevel - gateRel, -100)
  const NS = K + 1
  const back = new Uint8Array(nf * NS)
  let prev = new Float64Array(NS)
  let cur = new Float64Array(NS)
  const fPrev = new Float64Array(K)
  const fCur = new Float64Array(K)
  const BIG = 1e9
  for (let f = 0; f < nf; f++) {
    const cn = candN[f]
    const lvl = levelDb[f]
    const quiet = !(lvl > gate)
    let loud = (lvl - gate) / 12
    loud = loud < 0 ? 0 : loud > 1 ? 1 : loud
    const lu = quiet ? 0 : vthr * loud
    // octave cost relative to the highest plausible candidate of this frame,
    // so it only ranks candidates and never biases voicing against low voices
    let fRef = 0
    let fAny = 0
    for (let c = 0; c < K; c++) {
      fCur[c] = c < cn ? srd / candT[f * K + c] : 0
      if (c < cn) {
        if (fCur[c] > fAny) fAny = fCur[c]
        if (candA[f * K + c] <= 0.5 && fCur[c] > fRef) fRef = fCur[c]
      }
    }
    const logRef = Math.log2(fRef > 0 ? fRef : fAny > 0 ? fAny : maxHz)
    for (let c = 0; c < NS; c++) {
      let local
      if (c === K) local = lu
      else if (c < cn) {
        const oc = logRef - Math.log2(fCur[c])
        local = candA[f * K + c] + OCTAVE_COST * (oc > 0 ? oc : 0) + (quiet ? QUIET_PENALTY : 0)
      }
      else {
        cur[c] = BIG
        back[f * NS + c] = K
        continue
      }
      if (f === 0) {
        cur[c] = local
        back[c] = K
        continue
      }
      let best = BIG
      let arg = K
      for (let p = 0; p < NS; p++) {
        const pc = prev[p]
        if (pc >= BIG) continue
        let tc
        if (p === K) tc = c === K ? 0 : VUV_COST
        else if (c === K) tc = VUV_COST
        else {
          const lr = Math.log2(fCur[c] / fPrev[p])
          tc = JUMP_COST * (lr < 0 ? -lr : lr)
        }
        const v = pc + tc
        if (v < best) {
          best = v
          arg = p
        }
      }
      cur[c] = best + local
      back[f * NS + c] = arg
    }
    for (let c = 0; c < K; c++) fPrev[c] = fCur[c]
    const t = prev
    prev = cur
    cur = t
  }
  let state = K
  {
    let best = BIG
    for (let c = 0; c < NS; c++) {
      if (prev[c] < best) {
        best = prev[c]
        state = c
      }
    }
  }
  for (let f = nf - 1; f >= 0; f--) {
    if (state < K && state < candN[f]) {
      f0[f] = srd / candT[f * K + state]
      const a = candA[f * K + state]
      conf[f] = a < 0 ? 1 : a > 1 ? 0 : 1 - a
    } else {
      f0[f] = 0
      const a = bestA[f]
      conf[f] = a < 0 ? 1 : a > 1 ? 0 : 1 - a
    }
    state = back[f * NS + state]
  }

  // ---- drop voiced runs shorter than 3 frames
  for (let f = 0; f < nf; ) {
    if (f0[f] > 0) {
      let g = f
      while (g < nf && f0[g] > 0) g++
      if (g - f < 3) for (let q = f; q < g; q++) f0[q] = 0
      f = g
    } else f++
  }
  // ---- five-frame median over voiced neighbours
  const sm = new Float32Array(nf)
  const win = new Float64Array(5)
  for (let f = 0; f < nf; f++) {
    if (!(f0[f] > 0)) continue
    let m = 0
    for (let q = f - 2; q <= f + 2; q++) {
      if (q >= 0 && q < nf && f0[q] > 0) win[m++] = f0[q]
    }
    // insertion sort of at most 5 values
    for (let i = 1; i < m; i++) {
      const v = win[i]
      let j = i - 1
      while (j >= 0 && win[j] > v) {
        win[j + 1] = win[j]
        j--
      }
      win[j + 1] = v
    }
    sm[f] = m & 1 ? win[m >> 1] : 0.5 * (win[(m >> 1) - 1] + win[m >> 1])
  }
  f0.set(sm)
  // ---- share of voiced frames that are at least as periodic at a lag shorter
  // than the range allows: whistles, beeps, high singing (above maxHz)
  let nv = 0
  let above = 0
  for (let f = 0; f < nf; f++) {
    if (!(f0[f] > 0)) continue
    nv++
    if (hiDip[f] < thr && hiDip[f] <= 1 - conf[f] + 0.03) above++
  }
  track.aboveShare = nv ? above / nv : 0
  return track
}

/**
 * Pitch (Hz) at any input sample: linear between voiced frames, the nearest
 * frame's value (possibly 0, unvoiced) next to an unvoiced one.
 */
export function f0At(track, sampleIndex) {
  if (!track || !track.f0 || !track.f0.length) return 0
  const f0 = track.f0
  const nf = f0.length
  let p = sampleIndex / track.hop
  if (!(p > 0)) p = 0
  if (p >= nf - 1) return f0[nf - 1]
  const f = Math.floor(p)
  const a = p - f
  const v0 = f0[f]
  const v1 = f0[f + 1]
  if (v0 > 0 && v1 > 0) return v0 + a * (v1 - v0)
  return a < 0.5 ? v0 : v1
}

/** MIDI note number (fractional) of a frequency; -Infinity for 0 or less. */
export function noteOf(hz) {
  const h = Number(hz)
  if (!(h > 0) || h === Infinity) return -Infinity
  return 69 + 12 * Math.log2(h / 440)
}

/** Frequency (Hz) of a MIDI note number (fractional allowed); 0 for non-finite. */
export function hzOf(midi) {
  const m = Number(midi)
  if (!(m === m) || m === Infinity || m === -Infinity) return 0
  return 440 * Math.pow(2, (m - 69) / 12)
}

/** Median f0 of the voiced frames (0 when nothing is voiced). */
export function medianPitch(track) {
  if (!track || !track.f0) return 0
  const v = []
  for (let i = 0; i < track.f0.length; i++) if (track.f0[i] > 0) v.push(track.f0[i])
  if (!v.length) return 0
  v.sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length & 1 ? v[m] : 0.5 * (v[m - 1] + v[m])
}

/** Scales as semitone steps above the key note. */
export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  'whole-tone': [0, 2, 4, 6, 8, 10],
}

/**
 * Nearest note of a scale to a MIDI note number. key is the key note's
 * pitch class (0 = C, 9 = A) or a name like 'F#'. Unknown scales are chromatic.
 */
export function snapToScale(midi, scale = 'chromatic', key = 0) {
  const m = Number(midi)
  if (!(m === m) || m === Infinity || m === -Infinity) return m
  const steps = Array.isArray(scale) && scale.length ? scale : SCALES[scale] || SCALES.chromatic
  const k = typeof key === 'string' ? pitchClassOf(key) : ((Math.round(Number(key) || 0) % 12) + 12) % 12
  const rel = m - k
  const oct = Math.floor(rel / 12)
  let best = 0
  let bd = Infinity
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (let i = 0; i < steps.length; i++) {
      const cand = o * 12 + steps[i]
      const dd = Math.abs(cand - rel)
      if (dd < bd) {
        bd = dd
        best = cand
      }
    }
  }
  return best + k
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

function pitchClassOf(name) {
  const s = String(name).trim().toLowerCase()
  let pc = PC[s[0]]
  if (pc === undefined) return 0
  if (s[1] === '#') pc++
  else if (s[1] === 'b') pc--
  return (pc + 12) % 12
}

/** Note name of a MIDI note number, like 'A4' or 'C#3'. */
export function noteName(midi) {
  const m = Math.round(Number(midi))
  if (!Number.isFinite(m)) return ''
  return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)
}

/** MIDI note number of a name like 'A4', 'C#3' or 'Bb2' (NaN when unreadable). */
export function parseNote(name) {
  const s = String(name || '').trim()
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s)
  if (!m) return NaN
  let pc = PC[m[1].toLowerCase()]
  if (m[2] === '#') pc++
  else if (m[2] === 'b') pc--
  return (Number(m[3]) + 1) * 12 + pc
}
