// tools/fingerprint.js - finds near-duplicate and broken presets by ear-like statistics (Node only).
//
// Usage (from api/server/kadeVoiceChanger/engine):
//   node tools/fingerprint.js [--in speech.wav] [--seconds 3] [--cat <id>]... [--no-mix]
//        [--steps 1] [--threshold 0.9] [--json report.json]
//
// Every preset is rendered on the same 3 second test clip (testClip) cut from
// DEFAULT_SPEECH (or samples/sample-woman.wav, the same recording, when that
// file is not on this computer): speech centred on its first pause, so trims, gates and
// expanders show what they do, with a quiet noise floor and three short mouth
// clicks mixed in, so noise and click removers have something to remove. The
// dry voice (the clip through an empty chain) is fingerprinted the same way,
// and a fingerprint is taken of every preset:
// - 24 mel bands (the mel scale of Stevens, Volkmann and Newman 1937, in the
//   O'Shaughnessy form 2595 log10(1 + f/700); triangular bands as in the MFCC
//   front end of Davis and Mermelstein 1980): the mean log energy of each band
//   with the overall level removed (spectral shape), and its standard deviation
//   over time (how the shape moves);
// - spectral flux, the mean positive change of the log mel spectrum from frame
//   to frame (Masri 1996), which tells smooth sounds from busy ones;
// - stereo correlation of left and right;
// - a 16-point loudness envelope over the clip (timing tricks, echoes, tails);
// - pitch and voice quality from the frame autocorrelation (the inverse FFT of
//   the power spectrum, Wiener-Khinchin): median pitch and its spread in
//   octaves, the share of voiced frames, and the mean autocorrelation peak
//   (harmonicity), so a ring modulator and a wobble through the same telephone
//   still tell apart.
// The gate has one definition, the same whatever is rendered with it (see
// STEP_GROUPS and GATE below): every feature is measured in fixed steps of
// about one just-noticeable change, a preset's change is how many steps it
// moves the dry voice, and two presets in one category are near-duplicates
// when they end up less than one step apart, or when they make more than 90
// percent of the same change (their distance is under a tenth of the larger
// change). Nothing is standardised over the rendered set, so a run of one
// category flags exactly the pairs a run of everything flags in it. Presets
// that come out silent, too quiet, made much quieter for sharp peaks (render.js
// lowers the loudness rather than limit by more than 6 dB), clipped, or with
// broken samples are listed too, and presets that change the clip by less than
// one step are listed for information. Presets are read straight from
// presets/*.json and the Mix and match ingredients, never from
// presets.generated.js. (standardise and cosine are the earlier measure, kept
// for scripts that use them.)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadEngine } from './make_registry.js'
import { renderPreset } from '../render.js'
import { decodeWav } from '../core/wav.js'
import { FFT } from '../core/fft.js'
import { hann } from '../core/window.js'
import { sliceBuf } from '../core/buf.js'
import { categoryShortName } from '../catalog.js'
import { makeRng } from '../core/rng.js'

export const DEFAULT_SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'
export const DEFAULT_SECONDS = 3
const BANDS = 24
const ENV_POINTS = 16
const PITCH_FEATURES = 4
// [start, size] of each feature group in the vector
export const GROUPS = [[0, BANDS], [BANDS, BANDS], [2 * BANDS, 1], [2 * BANDS + 1, 1], [2 * BANDS + 2, ENV_POINTS], [2 * BANDS + 2 + ENV_POINTS, PITCH_FEATURES]]

/** Level of every 10 ms block of the first channel, in decibels under the loudest block. */
function blockLevels(buf) {
  const s = buf.ch[0]
  const blk = Math.max(1, Math.round(buf.sr * 0.01))
  const lv = []
  let top = 0
  for (let i = 0; i + blk <= s.length; i += blk) {
    let e = 0
    for (let k = 0; k < blk; k++) e += s[i + k] * s[i + k]
    lv.push(e / blk)
    if (e / blk > top) top = e / blk
  }
  return { blk, db: lv.map((e) => (top > 0 ? 10 * Math.log10(e / top + 1e-15) : -150)) }
}

/**
 * The first pause in a recording that has speech on both sides of it: a run of
 * 10 ms blocks more than 35 dB under the loudest one, from minPause to
 * maxPause seconds long, that ends no later than maxEnd seconds. Returns
 * [start, end] in seconds, or null.
 */
export function findPause(buf, minPause = 0.3, maxEnd = Infinity, maxPause = Infinity) {
  const { db } = blockLevels(buf)
  let spoke = false
  let st = -1
  for (let j = 0; j < db.length; j++) {
    const quiet = db[j] < -35
    if (!quiet) {
      const len = (j - st) / 100
      if (st >= 0 && spoke && len >= minPause && len <= maxPause && j / 100 <= maxEnd) return [st / 100, j / 100]
      st = -1
      spoke = true
    } else if (st < 0) st = j
  }
  return null
}

const CLIP_PAUSE = 0.6 // seconds of silence spliced in when the recording has no pause of its own
const NOISE_FLOOR_DB = -60 // the clip's noise floor (room tone and hiss), under its loudest sample
const MEL_RANGE_DB = 80 // band energies further than this under the loudest band are heard as nothing
const CLICK_DB = [-24, -24, -16] // the three mouth clicks: two in the pause, one on a word

/** A short mouth click (a lip smack): a sharp, quickly dying ring around 2.5 kHz. */
function addClick(s, sr, at, amp) {
  const i0 = Math.round(at * sr)
  const len = Math.round(0.002 * sr)
  const tau = 0.00025 * sr
  for (let k = 0; k < len && i0 + k < s.length; k++) if (i0 + k >= 0) s[i0 + k] += amp * Math.exp(-k / tau) * Math.sin((2 * Math.PI * 2500 * k) / sr + 0.4)
}

/**
 * The clip every preset is fingerprinted on: `seconds` of the recording centred
 * on its first pause, so the tools that work on pauses (trims, gates,
 * expanders) show what they do. When the recording has no pause near its
 * start, one is made: CLIP_PAUSE seconds of silence spliced between two
 * stretches of speech. A quiet noise floor (60 dB under the loudest sample)
 * and three short mouth clicks (two in the pause, one on a word) are mixed in,
 * so noise and click removers have something to take out. The result depends
 * only on the recording and `seconds`.
 * Returns { clip, pause: [start, end], clicks: [times] } (seconds into the clip).
 */
export function testClip(take, seconds = DEFAULT_SECONDS) {
  const sr = take.sr
  const total = take.ch[0].length / sr
  const len = Math.max(1, Math.min(seconds, total))
  const pause = findPause(take, 0.3, Math.max(len, 12), len * 0.45)
  let clip
  let p0
  let p1
  if (pause) {
    const mid = (pause[0] + pause[1]) / 2
    const start = Math.max(0, Math.min(total - len, mid - len / 2))
    clip = sliceBuf(take, start, start + len)
    p0 = pause[0] - start
    p1 = pause[1] - start
  } else {
    // splice a pause into the first words
    const s0 = speechStart(take)
    const part = Math.max(0.2, (len - CLIP_PAUSE) / 2)
    const a = sliceBuf(take, s0, s0 + part)
    const b = sliceBuf(take, s0 + part, s0 + 2 * part)
    const na = a.ch[0].length
    const gap = Math.round(CLIP_PAUSE * sr)
    const fadeN = Math.min(Math.round(0.01 * sr), na >> 1)
    clip = { sr, ch: take.ch.map(() => new Float32Array(Math.round(len * sr))) }
    for (let c = 0; c < clip.ch.length; c++) {
      const out = clip.ch[c]
      const A = a.ch[Math.min(c, a.ch.length - 1)]
      const B = b.ch[Math.min(c, b.ch.length - 1)]
      for (let i = 0; i < A.length && i < out.length; i++) out[i] = A[i] * Math.min(1, (A.length - 1 - i) / Math.max(1, fadeN))
      for (let i = 0; i < B.length && na + gap + i < out.length; i++) out[na + gap + i] = B[i] * Math.min(1, i / Math.max(1, fadeN))
    }
    p0 = na / sr
    p1 = (na + gap) / sr
  }
  const n = clip.ch[0].length
  let top = 0
  for (const c of clip.ch) for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(c[i]))
  if (!(top > 0)) top = 0.5
  // the noise floor: white noise through a gentle one-pole low pass, the same in every channel
  const rng = makeRng('fingerprint-noise-floor')
  const noise = new Float32Array(n)
  let lp = 0
  let ss = 0
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1
    lp += 0.5 * (w - lp)
    noise[i] = lp
    ss += lp * lp
  }
  const g = (top * Math.pow(10, NOISE_FLOOR_DB / 20)) / Math.sqrt(ss / Math.max(1, n) || 1)
  // the word click goes on the loudest 10 ms of the first stretch of speech
  const { blk, db } = blockLevels(clip)
  let loudest = 0
  for (let j = 0; j < Math.min(db.length, Math.floor(p0 * 100)); j++) if (db[j] > db[loudest]) loudest = j
  const clicks = [p0 + 0.3 * (p1 - p0), p0 + 0.7 * (p1 - p0), (loudest * blk) / sr + 0.004]
  for (const c of clip.ch) {
    for (let i = 0; i < n; i++) c[i] += noise[i] * g
    clicks.forEach((t, k) => addClick(c, sr, t, top * Math.pow(10, CLICK_DB[k] / 20)))
  }
  return { clip, pause: [p0, p1], clicks }
}

/** Start of the first words: the first 10 ms block within 30 dB of the loudest, minus 50 ms. */
export function speechStart(buf) {
  const s = buf.ch[0]
  const blk = Math.max(1, Math.round(buf.sr * 0.01))
  let top = 0
  const lv = []
  for (let i = 0; i + blk <= s.length; i += blk) {
    let e = 0
    for (let k = 0; k < blk; k++) e += s[i + k] * s[i + k]
    lv.push(e / blk)
    if (e / blk > top) top = e / blk
  }
  const gate = top * 1e-3
  for (let j = 0; j < lv.length; j++) if (lv[j] > gate) return Math.max(0, (j * blk) / buf.sr - 0.05)
  return 0
}

function melOf(hz) {
  return 2595 * Math.log10(1 + hz / 700)
}
function hzOfMel(m) {
  return 700 * (Math.pow(10, m / 2595) - 1)
}

/** Fingerprint of a rendered buffer: a Float64Array of 24 + 24 + 1 + 1 + 16 + 4 numbers. */
export function fingerprint(buf) {
  const sr = buf.sr
  const n = buf.ch[0].length
  const mono = new Float32Array(n)
  for (const c of buf.ch) for (let i = 0; i < n; i++) mono[i] += c[i] / buf.ch.length
  let N = 1024
  while (N < 0.04 * sr) N <<= 1
  const hop = N >> 2
  const fft = new FFT(N)
  const win = hann(N)
  const nb = (N >> 1) + 1
  const re = new Float64Array(nb)
  const im = new Float64Array(nb)
  const frame = new Float32Array(N)
  // triangular mel bands, 60 Hz to 16 kHz (or Nyquist)
  const lo = melOf(60)
  const hi = melOf(Math.min(16000, sr * 0.48))
  const edges = []
  for (let b = 0; b < BANDS + 2; b++) edges.push((hzOfMel(lo + ((hi - lo) * b) / (BANDS + 1)) * N) / sr)
  const frames = Math.max(1, Math.floor((n - N) / hop) + 1)
  const mel = new Float64Array(frames * BANDS)
  const ac = new Float32Array(N)
  const pr = new Float64Array(nb)
  const pz = new Float64Array(nb)
  const lagLo = Math.max(2, Math.floor(sr / 900))
  const lagHi = Math.min((N >> 1) - 1, Math.ceil(sr / 60))
  const f0s = []
  let harm = 0
  let loud = 0
  let frameTop = 0
  const frameE = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let e = 0
    for (let i = 0; i < N; i++) {
      const v = f * hop + i < n ? mono[f * hop + i] : 0
      e += v * v
    }
    frameE[f] = e
    if (e > frameTop) frameTop = e
  }
  for (let f = 0; f < frames; f++) {
    const off = f * hop
    for (let i = 0; i < N; i++) frame[i] = off + i < n ? mono[off + i] * win[i] : 0
    fft.realForward(frame, re, im)
    if (frameE[f] > frameTop * 0.01) {
      // autocorrelation of the frame: inverse FFT of its power spectrum
      for (let k = 0; k < nb; k++) {
        pr[k] = re[k] * re[k] + im[k] * im[k]
        pz[k] = 0
      }
      fft.realInverse(pr, pz, ac)
      const r0 = ac[0]
      if (r0 > 0) {
        let best = 0
        let lag = 0
        for (let L = lagLo; L <= lagHi; L++) {
          const r = ac[L] / (r0 * (1 - L / N))
          if (r > best) {
            best = r
            lag = L
          }
        }
        loud++
        harm += Math.min(1, best)
        if (best > 0.45 && lag > 0) f0s.push(Math.log2(sr / lag))
      }
    }
    for (let b = 0; b < BANDS; b++) {
      const a = edges[b]
      const c = edges[b + 1]
      const d = edges[b + 2]
      let e = 1e-12
      for (let k = Math.max(0, Math.floor(a)); k <= Math.min(nb - 1, Math.ceil(d)); k++) {
        const w = k < c ? (k - a) / Math.max(1e-9, c - a) : (d - k) / Math.max(1e-9, d - c)
        if (w > 0) e += w * (re[k] * re[k] + im[k] * im[k])
      }
      mel[f * BANDS + b] = 10 * Math.log10(e)
    }
  }
  // what lies far under the loudest band is inaudible: a gate taking a pause
  // from very quiet to quieter still must not count like a change in the words
  let melTop = -Infinity
  for (let i = 0; i < mel.length; i++) if (mel[i] > melTop) melTop = mel[i]
  for (let i = 0; i < mel.length; i++) if (mel[i] < melTop - MEL_RANGE_DB) mel[i] = melTop - MEL_RANGE_DB
  const out = new Float64Array(BANDS * 2 + 2 + ENV_POINTS + PITCH_FEATURES)
  let overall = 0
  for (let b = 0; b < BANDS; b++) {
    let m = 0
    for (let f = 0; f < frames; f++) m += mel[f * BANDS + b]
    m /= frames
    out[b] = m
    overall += m / BANDS
    let v = 0
    for (let f = 0; f < frames; f++) v += (mel[f * BANDS + b] - m) ** 2
    out[BANDS + b] = Math.sqrt(v / frames) / 10
  }
  for (let b = 0; b < BANDS; b++) out[b] = (out[b] - overall) / 10
  let flux = 0
  for (let f = 1; f < frames; f++) {
    for (let b = 0; b < BANDS; b++) {
      const d = mel[f * BANDS + b] - mel[(f - 1) * BANDS + b]
      if (d > 0) flux += d
    }
  }
  out[BANDS * 2] = frames > 1 ? flux / ((frames - 1) * BANDS) / 3 : 0
  // stereo correlation
  let corr = 1
  if (buf.ch.length > 1) {
    const L = buf.ch[0]
    const R = buf.ch[1]
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = 0; i < n; i++) {
      sxy += L[i] * R[i]
      sxx += L[i] * L[i]
      syy += R[i] * R[i]
    }
    corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 1
  }
  out[BANDS * 2 + 1] = corr
  // loudness envelope, relative to its own loudest point
  const seg = Math.max(1, Math.floor(n / ENV_POINTS))
  const env = new Float64Array(ENV_POINTS)
  let top = -200
  for (let j = 0; j < ENV_POINTS; j++) {
    let e = 0
    for (let i = j * seg; i < Math.min(n, (j + 1) * seg); i++) e += mono[i] * mono[i]
    env[j] = 10 * Math.log10(e / seg + 1e-12)
    if (env[j] > top) top = env[j]
  }
  for (let j = 0; j < ENV_POINTS; j++) out[BANDS * 2 + 2 + j] = Math.max(-60, env[j] - top) / 20
  // pitch: median and spread in octaves, voiced share, harmonicity
  const pb = BANDS * 2 + 2 + ENV_POINTS
  f0s.sort((x, y) => x - y)
  const med = f0s.length ? f0s[f0s.length >> 1] : Math.log2(100)
  let spread = 0
  for (const x of f0s) spread += Math.abs(x - med)
  out[pb] = med - Math.log2(150)
  out[pb + 1] = f0s.length ? spread / f0s.length : 0
  out[pb + 2] = loud ? f0s.length / loud : 0
  out[pb + 3] = loud ? harm / loud : 0
  return out
}

/** Standardise every dimension over the set (in place). */
export function standardise(vectors) {
  if (!vectors.length) return vectors
  const d = vectors[0].length
  for (let k = 0; k < d; k++) {
    let m = 0
    for (const v of vectors) m += v[k]
    m /= vectors.length
    let s = 0
    for (const v of vectors) s += (v[k] - m) ** 2
    s = Math.sqrt(s / vectors.length)
    for (const v of vectors) v[k] = s > 1e-9 ? (v[k] - m) / s : 0
  }
  // each feature group counts the same, however many numbers it has
  if (d === GROUPS[GROUPS.length - 1][0] + GROUPS[GROUPS.length - 1][1]) {
    for (const [start, size] of GROUPS) {
      const w = 1 / Math.sqrt(size)
      for (const v of vectors) for (let k = start; k < start + size; k++) v[k] *= w
    }
  }
  return vectors
}

export function cosine(a, b) {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let k = 0; k < a.length; k++) {
    ab += a[k] * b[k]
    aa += a[k] * a[k]
    bb += b[k] * b[k]
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : aa === bb ? 1 : 0
}

// ---------------------------------------------------------------- the gate's measure
//
// Every feature is measured in steps. One step is about the smallest change a
// careful listener notices in that feature: half a decibel of spectral shape
// across the bands (the fingerprint keeps decibels over ten), half a decibel
// in how the shape moves, 0.06 decibels per band per frame of busyness, 0.05
// of stereo correlation, one decibel in the loudness envelope (decibels over
// twenty), a quarter of a semitone in pitch (1/48 octave), and 0.03 in pitch
// spread (octaves), voiced share and harmonicity. Each group counts once, as
// the root mean square of its steps, so 24 bands weigh no more than the
// pitch. The scale is fixed: nothing depends on which other presets were
// rendered, so a pair measures the same in a run of one category as in a run
// of everything.
const PB = BANDS * 2 + 2 + ENV_POINTS
export const STEP_GROUPS = [
  { name: 'spectral shape', start: 0, units: new Array(BANDS).fill(0.05) },
  { name: 'how the shape moves', start: BANDS, units: new Array(BANDS).fill(0.05) },
  { name: 'busyness', start: BANDS * 2, units: [0.02] },
  { name: 'stereo', start: BANDS * 2 + 1, units: [0.05] },
  { name: 'loudness over time', start: BANDS * 2 + 2, units: new Array(ENV_POINTS).fill(0.05) },
  { name: 'pitch', start: PB, units: [1 / 48] },
  { name: 'voice quality', start: PB + 1, units: [0.03, 0.03, 0.03] },
]

/** How many steps apart two fingerprints are. */
export function stepsApart(a, b) {
  let t = 0
  for (const g of STEP_GROUPS) {
    let e = 0
    for (let k = 0; k < g.units.length; k++) e += ((a[g.start + k] - b[g.start + k]) / g.units[k]) ** 2
    t += e / g.units.length
  }
  return Math.sqrt(t)
}

/**
 * The gate's one definition. Each preset is measured by its change: how many
 * steps it moves the dry voice (the same test clip through an empty chain).
 * Two presets in one category are near-duplicates when they end up closer
 * than GATE.steps steps (a listener cannot tell them apart), or when their
 * similarity, 1 minus their distance over the larger of their two changes, is
 * above GATE.threshold (they make more than 90 percent of the same change).
 */
export const GATE = { steps: 1, threshold: 0.9 }

/**
 * Near-duplicate pairs among fingerprinted rows ([{ id, cat, vec }]), compared
 * only within a category, against the dry voice's fingerprint `dry`. Sets
 * row.change (steps from the dry voice) on every row. Returns
 * [{ a, b, steps, similarity }], most similar first.
 */
export function nearDuplicates(rows, dry, opts = {}) {
  const steps = Number.isFinite(opts.steps) ? opts.steps : GATE.steps
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : GATE.threshold
  for (const r of rows) r.change = stepsApart(r.vec, dry)
  const byCat = new Map()
  for (const r of rows) {
    if (!byCat.has(r.cat)) byCat.set(r.cat, [])
    byCat.get(r.cat).push(r)
  }
  const out = []
  for (const [, list] of byCat) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const d = stepsApart(a.vec, b.vec)
        const big = Math.max(a.change, b.change)
        const similarity = big > 0 ? 1 - d / big : 1
        if (d < steps || similarity > threshold) out.push({ a, b, steps: d, similarity })
      }
    }
  }
  out.sort((x, y) => y.similarity - x.similarity || x.steps - y.steps)
  return out
}

const round2 = (x) => Math.round(x * 100) / 100

function parseArgs(argv) {
  const o = { cats: [], mix: true, seconds: DEFAULT_SECONDS, threshold: GATE.threshold, steps: GATE.steps }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--in') o.input = argv[++i]
    else if (a === '--seconds') o.seconds = Number(argv[++i])
    else if (a === '--cat') o.cats.push(argv[++i])
    else if (a === '--no-mix') o.mix = false
    else if (a === '--threshold') o.threshold = Number(argv[++i])
    else if (a === '--steps') o.steps = Number(argv[++i])
    else if (a === '--json') o.json = argv[++i]
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error('Unknown option ' + a + '.')
  }
  return o
}

export async function main(argv = process.argv.slice(2)) {
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    console.error(e.message)
    return 2
  }
  if (o.help) {
    console.log(
      'node tools/fingerprint.js [--in speech.wav] [--seconds ' + DEFAULT_SECONDS + '] [--cat <id>]... [--no-mix] [--steps ' + GATE.steps + '] [--threshold ' + GATE.threshold + '] [--json report.json]'
    )
    return 0
  }
  // the same recording ships with the engine as its woman's sample voice
  const SAMPLE = new URL('../samples/sample-woman.wav', import.meta.url)
  const input = o.input || (existsSync(DEFAULT_SPEECH) || !existsSync(SAMPLE) ? DEFAULT_SPEECH : SAMPLE)
  let take
  if (existsSync(input)) take = decodeWav(new Uint8Array(readFileSync(input)))
  else {
    const { synthVoice } = await import('../test/fixtures.mjs')
    console.log('The recording ' + input + ' is not there, so a synthetic voice is used.')
    take = synthVoice(48000, o.seconds + 1)
  }
  const { clip, pause, clicks } = testClip(take, o.seconds)
  const engine = await loadEngine()
  const ctx = { getModule: engine.getModule, getBed: engine.getBed }
  const dry = fingerprint(renderPreset(clip, { id: 'dry-voice', name: 'Dry voice', chain: [] }, ctx).buf)
  const list = engine.catalog.presets().filter((p) => (!o.cats.length || o.cats.includes(p.cat)) && (o.mix || !p.generated))
  const rows = []
  const t0 = Date.now()
  for (const p of list) {
    const row = { id: p.id, name: p.name, cat: p.cat, flags: [] }
    try {
      const { buf, report } = renderPreset(clip, p, ctx)
      row.vec = fingerprint(buf)
      row.lufs = report.lufs
      row.preLimitPeakDb = report.preLimitPeakDb
      row.loudnessLoweredDb = report.loudnessLoweredDb || 0
      if (report.lufs <= -70 || report.peakDb < -50) row.flags.push('silent')
      else if (row.loudnessLoweredDb >= 4) row.flags.push('sharp peaks: played ' + Math.round(row.loudnessLoweredDb) + ' decibels quieter than the others so the limiter does not squash it')
      else if (report.lufs < -20) row.flags.push('too quiet (' + report.lufs + ' LUFS)')
      if (report.preLimitPeakDb > 5) row.flags.push('clipped: ' + Math.round(report.preLimitPeakDb + 1) + ' decibels of limiting')
      if (report.fixedNaN) row.flags.push(report.fixedNaN + ' broken samples')
    } catch (e) {
      row.flags.push('failed: ' + (e && e.message ? e.message : String(e)))
    }
    rows.push(row)
  }
  const good = rows.filter((r) => r.vec)
  const dups = nearDuplicates(good, dry, { steps: o.steps, threshold: o.threshold })
  const barely = good.filter((r) => r.change < o.steps).sort((a, b) => a.change - b.change)
  const flagged = rows.filter((r) => r.flags.length)
  console.log(
    'Fingerprinted ' + rows.length + ' presets in ' + Math.round((Date.now() - t0) / 1000) + ' seconds, on a ' + round2(clip.ch[0].length / clip.sr) +
      '-second test clip: speech with a ' + round2(pause[1] - pause[0]) + '-second pause, a quiet noise floor and ' + clicks.length + ' mouth clicks.'
  )
  console.log('Each preset is measured by how far it moves the dry voice, in steps (one step is about the smallest change a careful listener notices).')
  if (!dups.length) console.log('No near-duplicates within a category.')
  else {
    console.log(dups.length + ' near-duplicate pairs (closer than ' + o.steps + ' step' + (o.steps === 1 ? '' : 's') + ', or similarity above ' + o.threshold + '):')
    for (const d of dups) {
      console.log(
        '- ' + categoryShortName(d.a.cat) + ': "' + d.a.name + '" (' + d.a.id + ') and "' + d.b.name + '" (' + d.b.id + '), ' + d.steps.toFixed(2) + ' steps apart, changes of ' +
          d.a.change.toFixed(1) + ' and ' + d.b.change.toFixed(1) + ' steps, similarity ' + d.similarity.toFixed(3)
      )
    }
  }
  if (!flagged.length) console.log('No silent, quiet, clipped or failed presets.')
  else {
    console.log(flagged.length + ' presets need a look:')
    for (const r of flagged) console.log('- ' + categoryShortName(r.cat) + ': "' + r.name + '" (' + r.id + '): ' + r.flags.join('; '))
  }
  if (barely.length) {
    console.log(
      'For information, ' + barely.length + ' preset' + (barely.length === 1 ? ' changes' : 's change') + ' the test clip by less than ' + o.steps +
        ' step. That is normal for a repair tool with nothing on the clip to repair; anywhere else it may be too gentle:'
    )
    for (const r of barely) console.log('- ' + categoryShortName(r.cat) + ': "' + r.name + '" (' + r.id + '), ' + r.change.toFixed(2) + ' steps')
  }
  if (o.json) {
    writeFileSync(
      o.json,
      JSON.stringify(
        {
          clip: { seconds: round2(clip.ch[0].length / clip.sr), pause: pause.map(round2), clicks: clicks.map(round2) },
          gate: { steps: o.steps, threshold: o.threshold },
          presets: rows.map((r) => ({
            id: r.id,
            cat: r.cat,
            change: r.vec ? round2(r.change) : null,
            lufs: r.lufs,
            preLimitPeakDb: r.preLimitPeakDb,
            loudnessLoweredDb: r.loudnessLoweredDb,
            flags: r.flags,
          })),
          duplicates: dups.map((d) => ({ a: d.a.id, b: d.b.id, steps: round2(d.steps), similarity: Math.round(d.similarity * 1000) / 1000 })),
        },
        null,
        1
      )
    )
  }
  return dups.length || flagged.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase().endsWith('fingerprint.js')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(e && e.stack ? e.stack : String(e))
      process.exit(1)
    }
  )
}
