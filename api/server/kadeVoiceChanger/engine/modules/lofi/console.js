// modules/lofi/console.js - lofi.console, "Old console sound chip".
//
// Technique: each system codes and plays the voice the way its sound
// hardware did, following published hardware documentation (the nesdev wiki
// for the 8-bit console, anomie's and Martin Korth's "fullsnes" references
// for the 16-bit console, the "Pan Docs" for the handheld, the Dialogic and
// MSM5205 data for the arcade voice chip). This is coding, not a generic
// bit crusher: every system has its own kind of damage.
//
// - 8-bit console: the sample channel's 1-bit delta modulation. A 7-bit
//   counter steps up or down by two per bit at the channel's fastest rate,
//   about 33.1 kHz (the cheap setting uses about 16.9 kHz). Loud, bright
//   sounds outrun the counter (slope overload: a dull, gritty edge), quiet
//   ones become a fizzy granular hiss, silence is a faint 16 kHz idle whine.
//   Played through the console's non-linear resistor DAC and its output
//   filters (high passes at 90 and 440 Hz, a 14 kHz low pass), which make
//   its famously thin sound. The best setting records a little lower (less
//   overload) and uses a smarter encoder with four bits of lookahead.
// - 16-bit console, smooth: 4-bit block-compressed samples (BRR: 16 samples
//   per block with a shift and one of four prediction filters, encoded
//   closed-loop and exhaustively), stored at 32, 16 or 8 kHz to fit the
//   chip's 64 KB of sound memory, played on the chip's 32 kHz clock through
//   four-point Gaussian interpolation (the soft, muffled sound) and its
//   hardware echo: a delay in 16 ms steps, feedback, and the eight-tap FIR
//   filter games commonly loaded (-1, 8, 23, 36, 36, 23, 8, -1 over 128),
//   which darkens each repeat. All in the chip's 16-bit integer arithmetic.
// - 16-bit console, gritty: the rival console's 8-bit sample DAC, fed by a
//   sound CPU loop, with samples converted the cheap way (point sampled at
//   13, 8.7 or 6.5 kHz behind only a gentle filter, so aliases fold into
//   the voice). Samples arrive unevenly (the loop's timing wanders and
//   stalls once a frame while the main CPU borrows the bus), the converter's
//   "ladder effect" opens a gap of nearly a step around zero
//   (crossover grit on quiet sounds), and the first model's output stage is
//   a first-order low pass near 3.4 kHz, the figure emulators commonly use.
// - Handheld: 4-bit samples streamed through the wave channel (16 levels;
//   the cheap setting plays at half volume, which shifts away one more bit)
//   at 10.9, 8.2 or 5.5 kHz, held without interpolation (bright, buzzy
//   images), through the DAC (its inversion left out, so a blend with the
//   dry voice cannot cancel) and the output capacitor's high pass.
// - 8-bit computer: unsigned 8-bit samples at 11, 8 or 5.5 kHz from a cheap
//   sampler (a gentle input filter, so some aliasing gets through, and point
//   sampling), held on a bare resistor-ladder converter with next to no
//   output filter, so its images ring bright and buzzy above the voice.
// - Arcade voice chip: 4-bit OKI ADPCM at 8, 6 or 4 kHz (the MSM5205's
//   clock divisions), its 12-bit predictor played through a 10-bit DAC and
//   the board's low pass: the gravelly announcer of the 1980s arcade.
// "Its own speaker" then plays it through a CRT television, the handheld's
// little speaker or an arcade cabinet (_speakers.js).
// The voice is normalised into each chip (as a developer would) and its
// level is given back afterwards; "Recording level" pushes it harder.

import { resampleTo } from '../../core/resample.js'
import { peak } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'
import { brrEncode, gaussPlay, dpcmCode, nesDac, DMC_RATES, adpcmCode } from './_chips.js'
import { holdToRate, fitLength, FilterBank, LP, HP1, LP1, clamp, num, dbg, runStream } from './_lib.js'
import { SpeakerKernel } from './_speakers.js'

const SYSTEMS = {
  dpcm: { name: '8-bit console', speaker: 'tv' },
  brr: { name: '16-bit console, smooth', speaker: 'tv' },
  dac8: { name: '16-bit console, gritty', speaker: 'tv' },
  wave4: { name: 'Handheld', speaker: 'handheld' },
  pcm8: { name: '8-bit computer', speaker: 'tv' },
  arcade: { name: 'Arcade voice chip', speaker: 'cabinet' },
}

const QUALITY = { best: 0, typical: 1, cheap: 2 }

const RATES = {
  dpcm: [DMC_RATES[15], DMC_RATES[15], DMC_RATES[12]],
  brr: [32000, 16000, 8000],
  dac8: [13000, 8700, 6500],
  wave4: [10922.67, 8192, 5461.33],
  pcm8: [11025, 8000, 5512],
  arcade: [8000, 6000, 4000],
}

const BRR_FIR = [-1, 8, 23, 36, 36, 23, 8, -1]
const BRR_FIR_GAIN = 132 / 128
const BRR_SCALE = 0.8 * 32767

function filt(sig, sr, rows) {
  return new FilterBank(sr, rows.length).load(rows).run(sig)
}

// ---------------------------------------------------------------- systems

function runDpcm(x, sr, q) {
  const n = x.length
  const R = RATES.dpcm[q]
  const y = resampleTo(x, sr, R)
  const t = new Float32Array(y.length)
  // the best setting records a little lower (less slope overload) and looks ahead
  const amp = q === 0 ? 32 : 47
  for (let i = 0; i < y.length; i++) {
    // the developer's source was an 8-bit sample, so silence is exactly zero
    const v = 64 + (Math.round(y[i] * 127.5) / 127.5) * amp
    t[i] = v < 0 ? 0 : v > 127 ? 127 : v
  }
  // in pauses of more than 10 ms the sample ends and the channel rests
  const c = dpcmCode(t, q === 0 ? 4 : 0, 64, Math.round(0.01 * R))
  const mid = nesDac(64)
  const s = (2 * (47 / amp)) / (nesDac(111) - nesDac(17))
  const lev = new Float32Array(c.length)
  for (let i = 0; i < c.length; i++) lev[i] = (nesDac(c[i]) - mid) * s
  const out = holdToRate(lev, R, sr, n)
  return filt(out, sr, [[HP1, 90, 0, 0], [HP1, 440, 0, 0], [LP1, 14000, 0, 0]])
}

/** The 16-bit console's echo unit, in place on a 32 kHz 16-bit-domain stream. */
function brrEcho(v, levelPct, timeMs, repeatsPct) {
  const D = Math.max(1, Math.min(15, Math.round(timeMs / 16))) * 512
  const buf = new Float64Array(D)
  const hist = new Float64Array(8)
  const evol = (levelPct / 100) * 0.8
  const efb = repeatsPct / 100
  let pos = 0
  let hp = 0
  for (let j = 0; j < v.length; j++) {
    hist[hp] = buf[pos]
    hp = (hp + 1) & 7
    let f = 0
    for (let k = 0; k < 8; k++) f += BRR_FIR[k] * hist[(hp + k) & 7]
    f = Math.trunc(f / 128)
    if (f > 32767) f = 32767
    else if (f < -32768) f = -32768
    const dry = v[j]
    let o = dry + Math.trunc(f * evol)
    v[j] = o > 32767 ? 32767 : o < -32768 ? -32768 : o
    let w = dry + Math.trunc(f * efb)
    if (w > 32767) w = 32767
    else if (w < -32768) w = -32768
    buf[pos] = w & ~1
    if (++pos >= D) pos = 0
  }
  return v
}

function runBrr(x, sr, q, p, tailN) {
  const n = x.length
  const R = RATES.brr[q]
  const y = resampleTo(x, sr, R)
  const tgt = new Float64Array(y.length)
  for (let i = 0; i < y.length; i++) {
    const v = Math.round(y[i] * BRR_SCALE)
    tgt[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v
  }
  const { dec } = brrEncode(tgt)
  const total = n + tailN
  const len32 = Math.ceil((total * 32000) / sr) + 8
  const v = gaussPlay(dec, R, len32)
  if (p.echo > 0) brrEcho(v, p.echo, p.echoTime, p.echoRepeats)
  const f = new Float32Array(len32)
  for (let i = 0; i < len32; i++) f[i] = v[i] / BRR_SCALE
  return fitLength(sr === 32000 ? f : resampleTo(f, 32000, sr), total)
}

// When each sample reaches the converter: a cycle-counted loop on a steady
// clock, so the timing error never accumulates. Each sample wobbles a little
// (the loop's branches take different times) and once per video frame the
// main CPU takes the bus and the loop stalls for about half a sample; the
// loop's average rate already allows for that, which leaves a 60 Hz sawtooth
// of timing error: the scratchy buzz of this console's sample playback.
function dac8Times(m, R, rng) {
  const t = new Float64Array(m + 1)
  const frame = Math.max(1, Math.round(R / 60))
  const stall = 0.45
  const sc = m > 0 ? m / (m + stall * Math.floor(m / frame)) : 1
  for (let k = 0; k <= m; k++) {
    const j = k > 0 && k < m ? 0.08 * (rng.next() * 2 - 1) : 0
    t[k] = (k + stall * Math.floor(k / frame)) * sc + j
  }
  t[0] = 0
  t[m] = m
  return t
}

/** A cheap converter: a gentle input filter and point sampling (some aliasing gets through). */
function pointSample(x, sr, R, fc) {
  const n = x.length
  const xf = Float32Array.from(x)
  filt(xf, sr, [[LP, fc, 0.7, 0]])
  const m = Math.max(1, Math.round((n * R) / sr))
  const y = new Float32Array(m)
  const step = sr / R
  for (let k = 0; k < m; k++) {
    const pos = k * step
    const i0 = Math.floor(pos)
    const f = pos - i0
    const a = i0 < n ? xf[i0] : 0
    const b = i0 + 1 < n ? xf[i0 + 1] : 0
    y[k] = a + (b - a) * f
  }
  return y
}

function runDac8(x, sr, q, times) {
  const n = x.length
  const R = RATES.dac8[q]
  const y = pointSample(x, sr, R, 0.5 * R)
  const lev = new Float32Array(y.length)
  for (let i = 0; i < y.length; i++) {
    // from a 16-bit source, top byte kept (truncation), as the tools did
    let v = (Math.round(y[i] * 0.9 * 32767) >> 8) + 128
    v = v < 0 ? 0 : v > 255 ? 255 : v
    const s = v - 128
    lev[i] = (s >= 0 ? s + 0.4 : s - 0.4) / 128
  }
  const tt = times && times.length === lev.length + 1 ? times : null
  const out = holdToRate(lev, R, sr, n, tt)
  return filt(out, sr, [[LP1, 3390, 0, 0], [HP1, 20, 0, 0]])
}

function runWave4(x, sr, q) {
  const n = x.length
  const R = RATES.wave4[q]
  const shift = q === 2 ? 1 : 0
  const top = 15 >> shift
  const y = resampleTo(x, sr, R)
  const lev = new Float32Array(y.length)
  for (let i = 0; i < y.length; i++) {
    // signed 4-bit (-8..7) stored with an offset of 8, so silence is a level
    let d = 8 + Math.round(y[i] * 7.4)
    d = d < 0 ? 0 : d > 15 ? 15 : d
    d >>= shift
    // The real DAC's slope is negative; the polarity is kept here so the
    // effect blends with the dry voice instead of cancelling it.
    lev[i] = (d - top / 2) / (top / 2)
  }
  const out = holdToRate(lev, R, sr, n)
  return filt(out, sr, [[HP1, 30, 0, 0]])
}

function runPcm8(x, sr, q) {
  const n = x.length
  const R = RATES.pcm8[q]
  const y = pointSample(x, sr, R, 0.42 * R)
  const m = y.length
  const lev = new Float32Array(m)
  for (let k = 0; k < m; k++) {
    let v = (Math.round(y[k] * 0.95 * 32767) >> 8) + 128
    v = v < 0 ? 0 : v > 255 ? 255 : v
    lev[k] = (v - 127.5) / 128
  }
  const out = holdToRate(lev, R, sr, n)
  return filt(out, sr, [[LP1, 0.9 * R, 0, 0], [HP1, 20, 0, 0]])
}

function runArcade(x, sr, q) {
  const n = x.length
  const R = RATES.arcade[q]
  const y = resampleTo(x, sr, R)
  const sc = 2047 * 0.85
  for (let i = 0; i < y.length; i++) y[i] *= sc
  const dec = new Float32Array(y.length)
  adpcmCode(y, dec, 4, 'oki')
  for (let i = 0; i < dec.length; i++) dec[i] = (Math.floor(dec[i] / 4) * 4 + 2) / sc
  const out = holdToRate(dec, R, sr, n)
  return filt(out, sr, [[LP, 0.48 * R, 0.6, 0], [LP1, 0.75 * R, 0, 0], [HP1, 20, 0, 0]])
}

/**
 * The developer's preparation of a game sample: silences become digital
 * silence. A smooth downward expander fades everything more than about 42 dB
 * under the take's peak to exactly zero, so room noise does not flicker
 * across the chip's coarse steps in the pauses. Its level is a fast peak
 * follower (1 ms attack, 15 ms release) held at its maximum over 40 ms either
 * side (a sliding maximum), so it opens just before a word, stays open
 * through it and closes soon after, without chattering. In place; x is
 * already normalised to a peak of 1.
 */
function devPrep(x, sr) {
  const thr = 0.008
  const lo = thr / 4
  const n = x.length
  const ca = 1 - Math.exp(-1 / (0.001 * sr))
  const cr = 1 - Math.exp(-1 / (0.015 * sr))
  const e = new Float32Array(n)
  let env = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i])
    env += (a - env) * (a > env ? ca : cr)
    e[i] = env
  }
  // sliding maximum over [i - H, i + H] with a monotonic queue
  const H = Math.max(1, Math.round(0.04 * sr))
  const q = new Int32Array(n + 1)
  let qh = 0
  let qt = 0
  let next = 0
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + H)
    while (next <= hi) {
      while (qt > qh && e[q[qt - 1]] <= e[next]) qt--
      q[qt++] = next++
    }
    while (q[qh] < i - H) qh++
    const m = e[q[qh]]
    let g = 1
    if (m < thr) {
      const u = m > lo ? (m - lo) / (thr - lo) : 0
      g = u * u
    }
    x[i] *= g
  }
  return x
}

// ---------------------------------------------------------------- module

const TAIL_CAP = 10

/** Seconds of echo after the take: repeats until about -50 dB, uncapped. */
function rawEchoTail(p) {
  if (!p || p.system !== 'brr' || !(num(p.echo, 0) > 0)) return 0
  const D = Math.max(1, Math.min(15, Math.round(num(p.echoTime, 80) / 16))) * 0.016
  const g = (clamp(num(p.echoRepeats, 45), 0, 100) / 100) * BRR_FIR_GAIN
  const reps = g > 0.01 ? Math.ceil(Math.log(0.003) / Math.log(Math.min(0.995, g))) : 1
  return (reps + 1) * D + 0.02
}

function echoTail(p) {
  return Math.min(TAIL_CAP, rawEchoTail(p))
}

const SPEAKER_SET = { tv: { push: 3, rattle: 6 }, handheld: { push: 6, rattle: 10 }, cabinet: { push: 6, rattle: 0 } }

export default {
  id: 'lofi.console',
  name: 'Old console sound chip',
  family: 'lofi',
  about: 'Your voice as a sample inside an old game: coded the way each console, handheld, computer or arcade chip really stored and played it.',
  params: [
    {
      id: 'system', name: 'System', type: 'choice', def: 'dpcm',
      options: Object.keys(SYSTEMS).map((v) => ({ v, name: SYSTEMS[v].name })),
    },
    {
      id: 'quality', name: 'Sample quality', type: 'choice', def: 'typical',
      options: [
        { v: 'best', name: 'Best the chip can do' },
        { v: 'typical', name: 'Typical game' },
        { v: 'cheap', name: 'Squeezed to save memory' },
      ],
    },
    { id: 'level', name: 'Recording level', type: 'number', min: -12, max: 12, step: 0.5, def: 0, unit: 'db', rand: [-3, 6] },
    {
      id: 'speaker', name: 'Played through', type: 'choice', def: 'direct',
      options: [
        { v: 'direct', name: 'Straight out of the chip' },
        { v: 'own', name: 'Its own speaker' },
      ],
    },
    { id: 'echo', name: 'Hardware echo, 16-bit console', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 60] },
    { id: 'echoTime', name: 'Echo time', type: 'number', min: 16, max: 240, step: 16, def: 80, unit: 'ms', rand: [48, 192] },
    { id: 'echoRepeats', name: 'Echo repeats', type: 'number', min: 0, max: 90, step: 1, def: 45, unit: 'percent', rand: [20, 70] },
  ],
  stereo: 'keep',
  tail: (p) => echoTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch && input.ch.length ? input.ch[0].length : 0
    const sys = p.system in SYSTEMS ? p.system : 'dpcm'
    const q = p.quality in QUALITY ? QUALITY[p.quality] : 1
    const tailN = Math.round(echoTail(p) * sr)
    const nch = input.ch && input.ch.length ? input.ch.length : 1
    if (n === 0) {
      const ch = []
      for (let c = 0; c < nch; c++) ch.push(new Float32Array(tailN))
      return { sr, ch }
    }
    const pk = peak(input)
    const lg = (pk > 1e-9 ? Math.min(1 / pk, 1000) : 1) * dbg(clamp(num(p.level, 0), -24, 24))
    const rng = ctx && ctx.rng ? ctx.rng.fork('console') : makeRng('lofi.console')
    let times = null
    if (sys === 'dac8') {
      const R = RATES.dac8[q]
      times = dac8Times(Math.round((n * R) / sr), R, rng.fork('timing'))
    }
    const total = n + tailN
    const ch = input.ch.map((x, c) => {
      const xs = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const v = x[i] * lg
        xs[i] = Number.isFinite(v) ? v : 0
      }
      devPrep(xs, sr)
      let y
      if (sys === 'dpcm') y = runDpcm(xs, sr, q)
      else if (sys === 'brr') y = runBrr(xs, sr, q, p, tailN)
      else if (sys === 'dac8') y = runDac8(xs, sr, q, times)
      else if (sys === 'wave4') y = runWave4(xs, sr, q)
      else if (sys === 'pcm8') y = runPcm8(xs, sr, q)
      else y = runArcade(xs, sr, q)
      y = fitLength(y, total)
      if (p.speaker === 'own') {
        const size = SYSTEMS[sys].speaker
        const k = new SpeakerKernel(sr, { size, ...SPEAKER_SET[size] }, rng.fork('speaker' + c))
        y = runStream(k, { sr, ch: [y] }, 0, 0, null).ch[0]
      }
      const inv = 1 / lg
      for (let i = 0; i < total; i++) {
        const v = y[i] * inv
        y[i] = Number.isFinite(v) ? v : 0
      }
      // end the echo tail with a fade: long when the tail was cut at the cap
      if (tailN > 0) {
        const f = Math.min(tailN, Math.round((rawEchoTail(p) > TAIL_CAP ? 2 : 0.02) * sr))
        for (let k = 0; k < f; k++) y[total - 1 - k] *= 0.5 - 0.5 * Math.cos((Math.PI * (k + 0.5)) / f)
      }
      return y
    })
    return { sr, ch }
  },
}
