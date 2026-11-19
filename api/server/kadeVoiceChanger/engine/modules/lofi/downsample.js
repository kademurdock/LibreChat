// modules/lofi/downsample.js - lofi.downsample, "Sample rate reducer".
//
// Technique: the sound is sampled again at a lower rate and played back at
// the take's own rate, the way an early sampler or a cheap converter would
// have stored it. Three ways of doing it, each a real machine's behaviour:
// - Gritty steps: a sample-and-hold driven by a phase accumulator (a new
//   value is taken each time the phase passes one and held until the next).
//   Nothing is filtered, so everything above half the new rate folds back
//   down as inharmonic aliases, the ringing metal of a low-rate sampler, and
//   the staircase adds its own bright images above.
// - Straight lines: the same samples joined by straight lines (first-order
//   hold) instead of steps. The aliases stay, the staircase images are
//   mostly gone: softer, like a sampler with a simple output filter.
// - Clean and dull: a windowed-sinc resampler down and back up
//   (core/resample.js resampleTo, anti-aliased both ways), the textbook
//   converter. Nothing folds; the top of the sound above half the new rate
//   is simply gone, like a telephone line or an old voice recorder.
// (Zolzer, ed., "DAFX: Digital Audio Effects", 2nd ed. 2011, chapter 1, on
// sampling and aliasing; Smith, "Digital Audio Resampling Home Page", for
// the band-limited interpolation used by the clean setting.)
// A new rate at or above the take's own rate leaves the sound unchanged.
// Bit depth is left alone: lofi.crush does both at once.

import { resampleTo } from '../../core/resample.js'

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function hold(x, sr, rate, lines) {
  const n = x.length
  const y = new Float32Array(n)
  const inc = rate / sr
  let ph = 1 // take a sample at once
  let cur = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    if (ph >= 1) {
      ph -= 1
      prev = cur
      const v = x[i]
      cur = v > -1e9 && v < 1e9 ? v : 0
    }
    y[i] = lines ? prev + (cur - prev) * ph : cur
    ph += inc
  }
  return y
}

function clean(x, sr, rate) {
  const n = x.length
  const safe = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = x[i]
    safe[i] = v > -1e9 && v < 1e9 ? v : 0
  }
  const low = resampleTo(safe, sr, rate)
  if (!low.length) return safe
  const back = resampleTo(low, rate, sr)
  const y = new Float32Array(n)
  y.set(back.length > n ? back.subarray(0, n) : back)
  return y
}

export default {
  id: 'lofi.downsample',
  name: 'Sample rate reducer',
  family: 'lofi',
  about: 'Stores the sound at a lower sample rate, like an early sampler: gritty and ringing, or clean and dull like an old voice recorder.',
  params: [
    { id: 'rate', name: 'New sample rate', type: 'number', min: 500, max: 48000, step: 50, def: 8000, unit: 'hz', rand: [2500, 14000] },
    {
      id: 'style', name: 'Sound', type: 'choice', def: 'steps',
      options: [
        { v: 'steps', name: 'Gritty steps' },
        { v: 'lines', name: 'Straight lines, softer' },
        { v: 'clean', name: 'Clean and dull' },
      ],
    },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr > 0 ? input.sr : 48000
    const n = input.ch && input.ch.length ? input.ch[0].length : 0
    if (!n) return input
    const rate = clamp(num(p && p.rate, 8000), 500, 48000)
    const mix = clamp(num(p && p.mix, 100) / 100, 0, 1)
    const style = p && (p.style === 'lines' || p.style === 'clean') ? p.style : 'steps'
    const ch = new Array(input.ch.length)
    for (let c = 0; c < input.ch.length; c++) {
      const x = input.ch[c]
      let y
      if (rate >= sr || mix === 0) {
        y = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const v = x[i]
          y[i] = v > -1e9 && v < 1e9 ? v : 0
        }
      } else {
        y = style === 'clean' ? clean(x, sr, rate) : hold(x, sr, rate, style === 'lines')
        if (mix < 1) {
          for (let i = 0; i < n; i++) {
            const v = x[i]
            const d = v > -1e9 && v < 1e9 ? v : 0
            y[i] = d + (y[i] - d) * mix
          }
        }
      }
      for (let i = 0; i < n; i++) if (!(y[i] > -1e9 && y[i] < 1e9)) y[i] = 0
      ch[c] = y
      if (ctx && typeof ctx.progress === 'function') ctx.progress((c + 1) / input.ch.length)
    }
    return { sr: input.sr, ch }
  },
}
