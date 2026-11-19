// modules/spec/paul.js - Extreme stretch: one sentence becomes an endless ambient cloud.
//
// Technique: the extreme time-stretch method published by Nasca Octavian Paul
// in 2006 (public-domain description and reference code, "Paulstretch").
// Long windows (a quarter second by default) are taken from the input at a
// crawling read position, their magnitudes are kept and every phase is
// replaced with a random one, and the frames are overlap-added at the normal
// output hop. Random phases dissolve all timing inside each window, so a
// word smears into a slowly evolving chord instead of the stutter or
// chirping of an ordinary phase vocoder. Here: Hann windows on both sides at
// a quarter-window output hop, a power-of-two window nearest the chosen
// length (at most 32768 points), and the random-phase overlap-add level loss
// undone exactly (_spectral.js noiseOlaGain over the window sum). Output is
// the input length times the stretch, capped at three minutes (the report
// says so when the cap bites).

import { FFT } from '../../core/fft.js'
import { hann } from '../../core/window.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, rngOf, progressTo, stopAsked, noteTo, noiseOlaGain, olaSum, cleanSig, PH_COS, PH_SIN } from './_spectral.js'

const MAX_SECONDS = 180

function paulChannel(src, outLen, factor, N, rng, ctx, pBase, pSpan) {
  const len = src.length
  const nb = (N >> 1) + 1
  const hop = N >> 2
  const half = N >> 1
  const w = hann(N)
  const fft = new FFT(N)
  const frame = new Float64Array(N)
  const re = new Float64Array(nb)
  const im = new Float64Array(nb)
  const out = new Float32Array(outLen)
  const g = noiseOlaGain(w, hop) / olaSum(w, hop)
  const inHop = hop / factor
  const frames = Math.ceil((outLen + half) / hop) + 1
  const every = Math.max(1, Math.floor(frames / 25))
  for (let j = 0; j < frames; j++) {
    const oc = j * hop
    const ic = j * inHop
    const s0 = Math.round(ic) - half
    for (let i = 0; i < N; i++) {
      const q = s0 + i
      frame[i] = q >= 0 && q < len ? src[q] * w[i] : 0
    }
    fft.realForward(frame, re, im)
    for (let k = 0; k < nb; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const j = (rng.next() * 4096) | 0
      re[k] = m * PH_COS[j]
      im[k] = m * PH_SIN[j]
    }
    re[0] = 0
    im[0] = 0
    im[nb - 1] = 0
    fft.realInverse(re, im, frame)
    const o0 = oc - half
    const i0 = o0 < 0 ? -o0 : 0
    const i1 = o0 + N > outLen ? outLen - o0 : N
    for (let i = i0; i < i1; i++) out[o0 + i] += frame[i] * w[i] * g
    if (j % every === 0) {
      progressTo(ctx, pBase + (pSpan * j) / frames)
      if (stopAsked(ctx)) break
    }
  }
  return cleanSig(out)
}

const paul = {
  id: 'spec.paul',
  name: 'Extreme stretch',
  family: 'spec',
  about: 'Stretches your voice many times longer into a slow, shimmering ambient cloud.',
  params: [
    { id: 'factor', name: 'Stretch', type: 'number', min: 2, max: 50, step: 0.5, def: 8, unit: 'x', rand: [3, 12] },
    { id: 'window', name: 'Smear length', type: 'number', min: 0.05, max: 0.68, step: 0.01, def: 0.25, unit: 'seconds', rand: [0.12, 0.45] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  surprise: false,
  cost: 5,
  process(input, params, ctx) {
    const p = resolveParams(paul, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    let outLen = Math.round(len * p.factor)
    const cap = Math.round(MAX_SECONDS * sr)
    if (outLen > cap) {
      outLen = cap
      noteTo(ctx, 'The extreme stretch stopped at three minutes, so the end of the take was left out.')
    }
    const N = frameSize(sr, p.window * 1000, 256, 32768)
    const rng = rngOf(ctx, 'spec.paul')
    const ch = []
    for (let c = 0; c < nch; c++) {
      ch.push(paulChannel(input.ch[c], outLen, p.factor, N, rng.fork('ch' + c), ctx, c / nch, 1 / nch))
    }
    progressTo(ctx, 1)
    return { sr, ch }
  },
}

export default paul
