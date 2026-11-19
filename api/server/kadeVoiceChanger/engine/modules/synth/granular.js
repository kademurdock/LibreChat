// modules/synth/granular.js - grain cloud (synth.granular).
//
// Technique: asynchronous granular synthesis (Roads, "Microsound", MIT
// Press 2001, chapters 3 and 5; Truax, "Real-time granular synthesis with a
// digital signal processor", Computer Music Journal 12(2), 1988). The voice
// is cut into short overlapping grains, each with a Hann window, and every
// grain gets its own start time (scattered around a steady rate), its own
// read point a little back in time, its own transposition (an overall pitch
// plus a gaussian spread in cents), its own direction (some play
// backwards) and its own place in the stereo field (equal-power pan). A
// few grains with little scatter shimmer and double the voice; many grains
// with a wide pitch spread become a swarm of you; long scatter and many
// backwards grains sound like a memory breaking up.
//
// Each grain reads the voice with 4-point cubic Hermite interpolation
// (Niemitalo, "Polynomial Interpolators for High-Quality Resampling of
// Oversampled Audio", 2001), centred on its own moment so a transposed
// grain stays in time with the words. Windows come from one precomputed
// Hann table. At most 48 grains overlap at once (the density is lowered for
// very long grains), which keeps the cost under control.
//
// Output is stereo ('make'); a stereo input is summed to mono for the grains,
// and the dry part keeps its own stereo. The cloud is matched in RMS to the
// voice over the take and mixed with equal power. The output is one grain
// longer than the take (the module's tail), so the last grains finish
// their window instead of being cut off. All randomness comes from the
// stage's seeded rng.

import { bufLen } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'

const WIN_N = 2048
const WIN = new Float32Array(WIN_N + 2)
for (let i = 0; i <= WIN_N + 1; i++) {
  const t = Math.min(1, i / WIN_N)
  WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * t)
}
const MAX_OVERLAP = 48

function cubicAt(sig, n, t) {
  const i = Math.floor(t)
  if (i < -2 || i > n) return 0
  const f = t - i
  const ym1 = i - 1 >= 0 && i - 1 < n ? sig[i - 1] : 0
  const y0 = i >= 0 && i < n ? sig[i] : 0
  const y1 = i + 1 >= 0 && i + 1 < n ? sig[i + 1] : 0
  const y2 = i + 2 >= 0 && i + 2 < n ? sig[i + 2] : 0
  const c1 = 0.5 * (y1 - ym1)
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
  return ((c3 * f + c2) * f + c1) * f + y0
}

/** Grain length in samples. */
function grainSamples(p, sr) {
  return Math.max(4, Math.round((Math.max(1, Number(p.grain) || 70) / 1000) * sr))
}

function grainTail(p) {
  return Math.min(0.6, Math.max(0.01, (Number(p && p.grain) || 70) / 1000))
}

function cloud(src, sr, p, rng, total) {
  const n = src.length
  const L = new Float32Array(total)
  const R = new Float32Array(total)
  let G = grainSamples(p, sr)
  let dens = Math.max(0.5, Number(p.density) || 40)
  // never more than MAX_OVERLAP grains at once
  const maxDens = (MAX_OVERLAP * sr) / G
  if (dens > maxDens) dens = maxDens
  const interval = sr / dens
  const pitchC = (Number(p.pitch) || 0) * 100
  const spreadC = Math.max(0, Number(p.spread) || 0)
  const scatter = (Math.max(0, Number(p.scatter) || 0) / 1000) * sr
  const rev = Math.min(1, Math.max(0, (Number(p.reverse) || 0) / 100))
  const width = Math.min(1, Math.max(0, (Number(p.width) || 0) / 100))
  const winStep = WIN_N / G
  // first grain starts half a grain early so the take opens at full density
  let t = -G * 0.5 * rng.next()
  while (t < n) {
    const start = Math.round(t)
    t += interval * (0.5 + rng.next())
    let g = 0
    if (spreadC > 0) {
      g = rng.gauss()
      if (g > 2.5) g = 2.5
      if (g < -2.5) g = -2.5
    }
    let ratio = Math.pow(2, (pitchC + spreadC * g) / 1200)
    if (ratio > 4) ratio = 4
    if (ratio < 0.25) ratio = 0.25
    const back = rng.next() < rev
    const pan = width * (rng.next() * 2 - 1)
    const ang = ((pan + 1) * Math.PI) / 4
    const amp = 0.75 + 0.25 * rng.next()
    const gl = Math.cos(ang) * amp
    const gr = Math.sin(ang) * amp
    // read span, centred on this grain's moment minus a scattered look-back
    const centre = start + G * 0.5 - scatter * rng.next()
    const span = G * ratio
    let pos = back ? centre + span * 0.5 : centre - span * 0.5
    const step = back ? -ratio : ratio
    let i0 = start
    let k0 = 0
    if (i0 < 0) {
      k0 = -i0
      pos += step * k0
      i0 = 0
    }
    // the last grains finish in the tail (one grain long)
    const i1 = Math.min(total, start + G)
    let wp = k0 * winStep
    for (let i = i0; i < i1; i++) {
      const wi = wp | 0
      const wf = wp - wi
      const w = WIN[wi] + (WIN[wi + 1] - WIN[wi]) * wf
      const v = cubicAt(src, n, pos) * w
      L[i] += v * gl
      R[i] += v * gr
      pos += step
      wp += winStep
    }
  }
  return [L, R]
}

export default {
  id: 'synth.granular',
  name: 'Grain cloud',
  family: 'synth',
  about: 'Breaks your voice into tiny grains and scatters them: a shimmer, a swarm of you, or a memory falling apart.',
  params: [
    { id: 'grain', name: 'Grain length', type: 'number', min: 10, max: 500, step: 1, def: 70, unit: 'ms', rand: [25, 180] },
    {
      id: 'density',
      name: 'Grains per second',
      type: 'number',
      min: 2,
      max: 400,
      step: 1,
      def: 40,
      unit: 'count',
      noun: ['grain per second', 'grains per second'],
      rand: [12, 120],
    },
    { id: 'pitch', name: 'Pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones', rand: [-7, 7] },
    {
      id: 'spread',
      name: 'Pitch spread',
      type: 'number',
      min: 0,
      max: 1200,
      step: 5,
      def: 20,
      unit: 'cents',
      words: { pos: 'either way', zero: 'none' },
      rand: [0, 350],
    },
    { id: 'scatter', name: 'Time scatter', type: 'number', min: 0, max: 2000, step: 5, def: 60, unit: 'ms', rand: [0, 400] },
    { id: 'reverse', name: 'Backwards grains', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent', rand: [0, 60] },
    { id: 'width', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [30, 100] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
  ],
  stereo: 'make',
  tail: (p) => grainTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const n = bufLen(input)
    const sr = input.sr || (ctx && ctx.sr) || 48000
    if (!n) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    // one grain of tail, and never less than the longest grain
    const total = n + Math.max(Math.round(grainTail(p) * sr), grainSamples(p, sr))
    const rng = (ctx && ctx.rng ? ctx.rng : makeRng('synth.granular')).fork('grains')
    const nch = input.ch.length
    // grains read a mono mix
    const src = new Float32Array(n)
    for (let c = 0; c < nch; c++) {
      const s = input.ch[c]
      for (let i = 0; i < n; i++) {
        const v = s[i]
        if (v > -1e9 && v < 1e9) src[i] += v / nch
      }
    }
    const [L, R] = cloud(src, sr, p, rng, total)
    // level is matched over the take itself
    let ed = 0
    let ew = 0
    for (let i = 0; i < n; i++) {
      ed += src[i] * src[i]
      ew += 0.5 * (L[i] * L[i] + R[i] * R[i])
    }
    let g = ew > 1e-20 && ed > 1e-20 ? Math.sqrt(ed / ew) : 1
    if (g > 100) g = 100
    if (g < 0.01) g = 0.01
    const m = Math.min(1, Math.max(0, p.mix / 100))
    const gd = Math.cos((m * Math.PI) / 2)
    const gw = Math.sin((m * Math.PI) / 2) * g
    const dl = input.ch[0]
    const dr = nch > 1 ? input.ch[1] : input.ch[0]
    for (let i = 0; i < n; i++) {
      let a = dl[i]
      let b = dr[i]
      if (!(a > -1e9 && a < 1e9)) a = 0
      if (!(b > -1e9 && b < 1e9)) b = 0
      L[i] = gd * a + gw * L[i]
      R[i] = gd * b + gw * R[i]
    }
    for (let i = n; i < total; i++) {
      L[i] *= gw
      R[i] *= gw
    }
    return { sr, ch: [L, R] }
  },
}
