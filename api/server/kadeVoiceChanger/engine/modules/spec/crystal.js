// modules/spec/crystal.js - Crystallize: only the brightest spectral peaks survive, and ring.
//
// Technique: peak picking and sinusoidal resynthesis in the STFT domain, in
// the spirit of McAulay and Quatieri 1986 ("Speech analysis/synthesis based on
// a sinusoidal representation", IEEE ASSP) and Serra's spectral modelling:
// every frame keeps only its N strongest local maxima (each with the two
// bins beside it, the main lobe), and everything else is dropped. Each kept
// bin remembers its true frequency (phase-vocoder estimate) and keeps ringing
// after the voice moves on: its level decays by 60 decibels over the ring
// time while its phase advances at its own frequency, so held peaks are clean
// sustained sines, like struck glass. "Sparkle" adds an octave-up copy of the
// ringing peaks, written as exact partials with inverse-FFT additive
// synthesis (_spectral.js addPartial; Rodet and Depalle 1992) at twice the
// frequency and twice the phase, which stays phase-coherent from frame to frame.

import { spectralProcess } from '../../core/stft.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, padSig, cleanSig, blendInto, addPartial, lobeGain, TWO_PI } from './_spectral.js'

function crystalChannel(src, sr, N, p) {
  const nb = (N >> 1) + 1
  const hop = N >> 2
  const P = Math.max(1, Math.round(p.peaks))
  const decay = p.sustain > 0 ? Math.exp((-6.9 * hop) / ((p.sustain / 1000) * sr)) : 0
  const sparkle = p.sparkle / 100
  const prevPh = new Float64Array(nb)
  const mag = new Float64Array(nb)
  const ph = new Float64Array(nb)
  const om = new Float64Array(nb)
  const hMag = new Float64Array(nb)
  const hOm = new Float64Array(nb)
  const hPh = new Float64Array(nb)
  const topK = new Int32Array(P)
  const topM = new Float64Array(P)
  const refreshed = new Uint8Array(nb)
  const binW = TWO_PI / N
  let first = true
  return spectralProcess(src, { size: N, hop }, (re, im) => {
    for (let k = 0; k < nb; k++) {
      const a = re[k]
      const b = im[k]
      mag[k] = Math.sqrt(a * a + b * b)
      const q = Math.atan2(b, a)
      ph[k] = q
      if (first) om[k] = k * binW
      else {
        let d = q - prevPh[k] - k * binW * hop
        d -= TWO_PI * Math.round(d / TWO_PI)
        om[k] = k * binW + d / hop
      }
      prevPh[k] = q
    }
    first = false
    // the P strongest local maxima
    let mx = 0
    for (let k = 1; k < nb - 1; k++) if (mag[k] > mx) mx = mag[k]
    let n = 0
    const floor = mx * 1e-4
    for (let k = 2; k < nb - 2; k++) {
      const m = mag[k]
      if (!(m > floor) || !(m > mag[k - 1]) || !(m >= mag[k + 1])) continue
      if (n < P) {
        let j = n++
        while (j > 0 && topM[j - 1] < m) {
          topM[j] = topM[j - 1]
          topK[j] = topK[j - 1]
          j--
        }
        topM[j] = m
        topK[j] = k
      } else if (m > topM[P - 1]) {
        let j = P - 1
        while (j > 0 && topM[j - 1] < m) {
          topM[j] = topM[j - 1]
          topK[j] = topK[j - 1]
          j--
        }
        topM[j] = m
        topK[j] = k
      }
    }
    refreshed.fill(0)
    for (let q = 0; q < n; q++) {
      const kp = topK[q]
      const w = om[kp]
      for (let k = kp - 1; k <= kp + 1; k++) {
        if (mag[k] >= hMag[k] * decay) {
          hMag[k] = mag[k]
          hOm[k] = w
          hPh[k] = ph[k]
          refreshed[k] = 1
        }
      }
    }
    for (let k = 0; k < nb; k++) {
      if (!refreshed[k]) {
        let m = hMag[k] * decay
        if (m < 1e-20) m = 0
        hMag[k] = m
        if (m > 0) {
          let q = hPh[k] + hOm[k] * hop
          q -= TWO_PI * Math.round(q / TWO_PI)
          hPh[k] = q
        }
      }
      const m = hMag[k]
      re[k] = m > 0 ? m * Math.cos(hPh[k]) : 0
      im[k] = m > 0 ? m * Math.sin(hPh[k]) : 0
    }
    re[0] = 0
    im[0] = 0
    re[nb - 1] = 0
    im[nb - 1] = 0
    if (sparkle > 0) {
      // octave-up partials from the ringing peaks
      for (let k = 2; k < nb - 2; k++) {
        const m = hMag[k]
        if (!(m > 0) || m < hMag[k - 1] || m < hMag[k + 1]) continue
        const b = (hOm[k] * N) / TWO_PI
        const amp = ((m * 4) / N / Math.max(0.5, lobeGain(k - b))) * sparkle * 0.7
        const start = hPh[k] + Math.PI * (k - b)
        addPartial(re, im, N, 2 * b, amp, 2 * start)
      }
    }
  })
}

const crystal = {
  id: 'spec.crystal',
  name: 'Crystallize',
  family: 'spec',
  about: 'Keeps only the brightest notes inside your voice and lets them ring like glass and ice.',
  params: [
    { id: 'peaks', name: 'Notes kept', type: 'number', min: 1, max: 64, step: 1, def: 12, unit: 'count', noun: ['note', 'notes'], rand: [5, 30] },
    { id: 'sustain', name: 'Ring time', type: 'number', min: 0, max: 5000, step: 10, def: 900, unit: 'ms', rand: [300, 2500] },
    { id: 'sparkle', name: 'Sparkle', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: (p) => (p && p.sustain >= 0 ? p.sustain / 1000 : 0.9),
  warps: false,
  cost: 3,
  process(input, params, ctx) {
    const p = resolveParams(crystal, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    // an empty take still gets its tail (silence), as every stage promises input + tail
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(Math.round((p.sustain / 1000) * sr))) }
    const N = frameSize(sr, 42.7)
    const extra = Math.round((p.sustain / 1000) * sr)
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = padSig(input.ch[c], extra)
      const wet = crystalChannel(src, sr, N, p)
      ch.push(cleanSig(blendInto(wet, src, p.mix / 100)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default crystal
