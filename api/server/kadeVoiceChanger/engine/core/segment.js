// core/segment.js - phrases and syllables in recorded speech.
//
// findPhrases() splits a take into the stretches of speech between pauses.
// It is a classic energy detector with two thresholds (hysteresis, as in
// Rabiner and Sambur, "An Algorithm for Determining the Endpoints of Isolated
// Utterances", Bell System Technical Journal 1975), made relative to the
// clip itself so a quiet phone recording splits the same way as a loud
// studio one:
// 1. A copy is high-passed at 70 Hz (rumble and hum must not count as
//    speech) and cut into 10 ms hops; each frame's level is the mean square
//    over the three hops around it, in dB.
// 2. The speech level is the 95th percentile of frame levels and the noise
//    floor the 10th percentile (held within 70 dB of the speech level).
//    Speech starts above max(speech - 30 dB, halfway from floor to speech),
//    never closer than 6 dB below the speech level, and ends 6 dB lower.
//    floorDb, when given, is an absolute dBFS silence level instead.
// 3. Pauses shorter than minSilenceMs are bridged, then stretches shorter
//    than minPhraseMs are dropped (clicks, a cough of a few frames), and each
//    phrase is padded a little (30 ms before, 60 ms after, never past the
//    middle of the pause) so soft onsets and decays are not clipped.
// It returns [{ start, end }] in samples, in order, never overlapping.
//
// findSyllables() finds syllable nuclei the way de Jong and Wempe's
// speech-rate method does ("Praat script to detect syllable nuclei",
// Behavior Research Methods 2009): an intensity contour is taken of the
// vowel band (300 Hz to 2.5 kHz, which keeps s and sh from counting), local
// peaks within each phrase that are within 25 dB of that phrase's loudest
// moment are candidates, and a peak only counts as a new syllable when the
// dip between it and the previous one is at least minDipDb (2 dB by
// default) below the smaller of the two, and they are at least minGapMs
// apart; otherwise the louder of the two wins. Syllable boundaries are the
// quietest frame between neighbouring nuclei, and the first and last
// syllables run to the phrase edges. It returns
// [{ start, end, peak }] in samples.
//
// Both work on Float32Arrays at any sample rate and allocate only a few
// per-call arrays (one filtered copy, a frame-level array).

import { Biquad } from './biquad.js'

function num(v, d) {
  const x = Number(v)
  return v === undefined || v === null || !Number.isFinite(x) ? d : x
}

// Mean-square level per hop of a (filtered) copy, then smoothed over `span`
// hops centred on each hop, returned in dB.
function hopLevelsDb(x, hop, span) {
  const n = x.length
  const nh = Math.ceil(n / hop)
  const e = new Float64Array(nh)
  for (let h = 0; h < nh; h++) {
    const a = h * hop
    const b = Math.min(n, a + hop)
    let acc = 0
    for (let i = a; i < b; i++) {
      const v = x[i]
      if (v <= 1e30 && v >= -1e30) acc += v * v
    }
    e[h] = acc
  }
  const db = new Float32Array(nh)
  const back = Math.floor((span - 1) / 2)
  const fwd = span - 1 - back
  for (let h = 0; h < nh; h++) {
    const lo = Math.max(0, h - back)
    const hi = Math.min(nh - 1, h + fwd)
    let acc = 0
    let cnt = 0
    for (let k = lo; k <= hi; k++) {
      acc += e[k]
      cnt += k === nh - 1 ? n - k * hop : hop
    }
    const ms = cnt > 0 ? acc / cnt : 0
    db[h] = ms > 1e-20 ? 10 * Math.log10(ms) : -200
  }
  return db
}

function percentile(sorted, p) {
  if (!sorted.length) return -200
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[idx]
}

/**
 * Speech stretches between pauses: [{ start, end }] in samples.
 * opts: { minSilenceMs=180, minPhraseMs=120, floorDb, padStartMs=30, padEndMs=60 }.
 */
export function findPhrases(sig, sr, opts = {}) {
  const n = sig ? sig.length : 0
  if (!n || !(sr > 0)) return []
  const minSil = Math.max(0, num(opts.minSilenceMs, 180))
  const minPhr = Math.max(0, num(opts.minPhraseMs, 120))
  const padS = Math.max(0, num(opts.padStartMs, 30))
  const padE = Math.max(0, num(opts.padEndMs, 60))
  const hop = Math.max(1, Math.round(sr * 0.01))
  const x = new Float32Array(sig)
  new Biquad('highpass', sr, Math.min(70, sr * 0.2), 0.707).run(x)
  const db = hopLevelsDb(x, hop, 3)
  const nf = db.length
  let open
  let close
  if (opts.floorDb !== undefined && Number.isFinite(Number(opts.floorDb))) {
    close = Number(opts.floorDb)
    open = close + 6
  } else {
    const sorted = Float32Array.from(db).sort()
    const ref = percentile(sorted, 0.95)
    if (ref < -90) return []
    let noise = percentile(sorted, 0.1)
    if (noise < ref - 70) noise = ref - 70
    open = Math.max(ref - 30, noise + 0.5 * (ref - noise))
    if (open > ref - 6) open = ref - 6
    close = open - 6
  }
  // hysteresis
  const regions = []
  let inSp = false
  let s0 = 0
  for (let f = 0; f < nf; f++) {
    const v = db[f]
    if (!inSp) {
      if (v > open) {
        inSp = true
        s0 = f
      }
    } else if (v < close) {
      regions.push([s0, f])
      inSp = false
    }
  }
  if (inSp) regions.push([s0, nf])
  if (!regions.length) return []
  // bridge short pauses
  const gapF = Math.round(minSil / 10) - 2 // the 3-hop level window shortens pauses by about 2 hops
  const merged = [regions[0].slice()]
  for (let k = 1; k < regions.length; k++) {
    const last = merged[merged.length - 1]
    if (regions[k][0] - last[1] < gapF) last[1] = regions[k][1]
    else merged.push(regions[k].slice())
  }
  // drop short stretches
  const minF = Math.max(1, Math.round(minPhr / 10))
  const kept = merged.filter((r) => r[1] - r[0] >= minF)
  if (!kept.length) return []
  // to samples with padding, never past the middle of a pause
  const ps = Math.round((padS * sr) / 1000)
  const pe = Math.round((padE * sr) / 1000)
  const out = []
  for (let k = 0; k < kept.length; k++) {
    const a = kept[k][0] * hop
    const b = Math.min(n, kept[k][1] * hop)
    let lo = a - ps
    let hi = b + pe
    if (k > 0) {
      const prevEnd = Math.min(n, kept[k - 1][1] * hop)
      const mid = Math.floor((prevEnd + a) / 2)
      if (lo < mid) lo = mid
    }
    if (k < kept.length - 1) {
      const nextStart = kept[k + 1][0] * hop
      const mid = Math.floor((b + nextStart) / 2)
      if (hi > mid) hi = mid
    }
    if (lo < 0) lo = 0
    if (hi > n) hi = n
    if (hi > lo) out.push({ start: lo, end: hi })
  }
  return out
}

/**
 * Syllable nuclei: [{ start, end, peak }] in samples.
 * opts: { minDipDb=2, minGapMs=80, rangeDb=25, phrases, plus findPhrases options }.
 */
export function findSyllables(sig, sr, opts = {}) {
  const n = sig ? sig.length : 0
  if (!n || !(sr > 0)) return []
  const phrases = Array.isArray(opts.phrases) ? opts.phrases : findPhrases(sig, sr, opts)
  if (!phrases.length) return []
  const minDip = Math.max(0, num(opts.minDipDb, 2))
  const rangeDb = Math.max(1, num(opts.rangeDb, 25))
  const hopMs = 5
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000))
  const minGapF = Math.max(1, Math.round(num(opts.minGapMs, 80) / hopMs))
  const x = new Float32Array(sig)
  new Biquad('highpass', sr, Math.min(300, sr * 0.2), 0.707).run(x)
  new Biquad('lowpass', sr, Math.min(2500, sr * 0.45), 0.707).run(x)
  const db = hopLevelsDb(x, hop, 7) // about 35 ms of smoothing
  const nf = db.length
  const out = []
  for (let p = 0; p < phrases.length; p++) {
    const ph = phrases[p]
    const f0 = Math.max(0, Math.floor(ph.start / hop))
    const f1 = Math.min(nf, Math.ceil(ph.end / hop))
    if (f1 - f0 < 1) continue
    let top = -200
    for (let f = f0; f < f1; f++) if (db[f] > top) top = db[f]
    const floor = top - rangeDb
    // candidate peaks
    const peaks = []
    for (let f = f0; f < f1; f++) {
      const v = db[f]
      if (v < floor) continue
      const l = f > f0 ? db[f - 1] : -Infinity
      const r = f < f1 - 1 ? db[f + 1] : -Infinity
      if (v >= l && v > r) peaks.push(f)
    }
    if (!peaks.length) {
      out.push({ start: ph.start, end: ph.end, peak: Math.min(ph.end - 1, Math.max(ph.start, Math.round((ph.start + ph.end) / 2))) })
      continue
    }
    // dip and spacing rules: walk in time, keep or merge
    const kept = [peaks[0]]
    for (let k = 1; k < peaks.length; k++) {
      const f = peaks[k]
      const prev = kept[kept.length - 1]
      let dip = Infinity
      for (let g = prev + 1; g < f; g++) if (db[g] < dip) dip = db[g]
      const smaller = Math.min(db[prev], db[f])
      const deepEnough = dip <= smaller - minDip
      if (deepEnough && f - prev >= minGapF) kept.push(f)
      else if (db[f] > db[prev]) kept[kept.length - 1] = f
    }
    // boundaries at the quietest frame between nuclei
    let start = ph.start
    for (let k = 0; k < kept.length; k++) {
      let end = ph.end
      if (k < kept.length - 1) {
        let mf = kept[k] + 1
        for (let g = kept[k] + 1; g < kept[k + 1]; g++) if (db[g] < db[mf]) mf = g
        end = Math.min(ph.end, Math.max(start + 1, mf * hop + (hop >> 1)))
      }
      let pk = kept[k] * hop + (hop >> 1)
      if (pk < start) pk = start
      if (pk >= end) pk = end - 1
      if (end > start) out.push({ start, end, peak: pk })
      start = end
    }
  }
  return out
}
