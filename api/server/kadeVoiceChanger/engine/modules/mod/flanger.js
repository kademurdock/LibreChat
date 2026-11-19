// modules/mod/flanger.js - Flanger: the swooshing jet-plane sweep.
//
// Technique: the feedback flanger of Dattorro, "Effect Design, Part 2: Delay-
// Line Modulation and Chorus" (JAES 1997), the digital form of two tape
// machines running together while a thumb drags one flange. The voice is
// added to a copy of itself delayed by a fraction of a millisecond up to a
// dozen milliseconds; the sum is a comb filter whose notches sit at odd
// multiples of half the inverse delay. Sweeping the delay slides every notch
// up and down together, which is the jet sound. The sweep runs on an
// exponential scale (equal musical intervals per unit of sweep), as tape
// flanging does, so the low end of the sweep does not rush past. Feedback
// sends the delayed signal back into the line: positive feedback rings at
// the comb peaks (metallic, whistling), negative feedback rings an octave
// lower with a hollow tone. A gentle one-pole low pass inside the loop and a
// bounded soft limiter keep high feedback musical and always finite, and
// the wet level is scaled by sqrt(1 - feedback^2) so the average loudness
// stays put while the resonance grows. A stereo input sweeps its right
// channel a quarter cycle behind the left.
//
// One streaming kernel serves offline and live; every parameter glides.

import { DelayLine } from '../../core/delay.js'

const TWO_PI = 2 * Math.PI

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'rate', name: 'Sweep speed', type: 'number', min: 0.02, max: 5, step: 0.01, def: 0.2, unit: 'hz', rand: [0.06, 0.8] },
  { id: 'depth', name: 'Sweep depth', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [50, 100] },
  {
    id: 'feedback', name: 'Feedback', type: 'number', min: -95, max: 95, step: 1, def: 55, unit: 'percent',
    words: { neg: 'negative', pos: 'positive', zero: 'none' }, rand: [-70, 85],
  },
  { id: 'delay', name: 'Delay time', type: 'number', min: 0.5, max: 12, step: 0.1, def: 4, unit: 'ms', rand: [1.5, 8] },
  {
    id: 'shape', name: 'Sweep shape', type: 'choice', def: 'sine',
    options: [{ v: 'sine', name: 'Smooth sweep' }, { v: 'triangle', name: 'Even sweep' }],
  },
  { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [40, 60] },
]

function tailSeconds(p) {
  const fb = Math.abs(clamp(num(p && p.feedback, 55), -95, 95) / 100)
  const d = clamp(num(p && p.delay, 4), 0.5, 12) / 1000
  if (fb < 0.01) return d + 0.002
  // time for the recirculation to fall 60 dB
  return Math.min(2.5, d * (Math.log(1000) / -Math.log(fb)) + 0.002)
}

function softLimit(v) {
  // unity slope near zero, bounded by +-2
  if (v > 1) {
    const a = v - 1
    return 1 + a / (1 + a)
  }
  if (v < -1) {
    const a = -v - 1
    return -1 - a / (1 + a)
  }
  return v
}

function createKernel(sr, p0) {
  const msToS = sr / 1000
  const lines = [new DelayLine(Math.ceil(12.5 * msToS) + 8), new DelayLine(Math.ceil(12.5 * msToS) + 8)]
  const lp = new Float64Array(2)
  const ph = new Float64Array(2)
  const dampC = 1 - Math.exp((-TWO_PI * Math.min(9000, sr * 0.4)) / sr)
  const sm = 1 - Math.exp(-1 / (0.04 * sr))
  let inc = 0.2 / sr, depthT = 0.8, fbT = 0.55, dmaxT = 4, mixT = 0.5, tri = false
  let depth = 0.8, fb = 0.55, dmax = 4, mix = 0.5

  function set(p) {
    inc = clamp(num(p.rate, 0.2), 0, 20) / sr
    depthT = clamp(num(p.depth, 80), 0, 100) / 100
    fbT = clamp(num(p.feedback, 55), -95, 95) / 100
    dmaxT = clamp(num(p.delay, 4), 0.2, 12)
    mixT = clamp(num(p.mix, 50), 0, 100) / 100
    tri = p.shape === 'triangle'
  }
  function snap() {
    depth = depthT
    fb = fbT
    dmax = dmaxT
    mix = mixT
  }
  function reset() {
    lines[0].clear()
    lines[1].clear()
    lp[0] = lp[1] = 0
    ph[0] = 0
    ph[1] = 0.25
    snap()
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nc = outs.length < 2 ? outs.length : 2
      const nIn = ins.length
      for (let i = 0; i < n; i++) {
        depth += (depthT - depth) * sm
        fb += (fbT - fb) * sm
        dmax += (dmaxT - dmax) * sm
        mix += (mixT - mix) * sm
        const dmin = dmax * (1 - 0.97 * depth)
        const lr = Math.log(dmax / dmin)
        const norm = Math.sqrt(1 - fb * fb)
        const comp = 1 / Math.sqrt((1 - mix) * (1 - mix) + mix * mix)
        const dry = (1 - mix) * comp
        const wet = mix * norm * comp

        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        for (let c = 0; c < nc; c++) {
          const x = c === 0 ? x0 : x1
          let q = ph[c] + inc
          if (q >= 1) q -= 1
          ph[c] = q
          const u = tri ? (q < 0.5 ? 2 * q : 2 - 2 * q) : 0.5 - 0.5 * Math.cos(TWO_PI * q)
          const d = dmin * Math.exp(lr * u) * msToS - 1
          const line = lines[c]
          const tap = line.read(d > 0 ? d : 0)
          let s = lp[c] + (tap - lp[c]) * dampC
          if (s < 1e-20 && s > -1e-20) s = 0
          lp[c] = s
          line.write(softLimit(x + fb * s))
          outs[c][i] = x * dry + tap * wet
        }
      }
    },
  }
}

function runOffline(kernel, input, nOut, extra, ctx) {
  const len = input.ch[0].length
  const total = len + extra
  const ins = input.ch.map((c) => {
    if (extra === 0) return c
    const y = new Float32Array(total)
    y.set(c)
    return y
  })
  const outs = []
  for (let c = 0; c < nOut; c++) outs.push(new Float32Array(total))
  const B = 1 << 15
  for (let a = 0; a < total; a += B) {
    const b = Math.min(total, a + B)
    kernel.process(ins.map((c) => c.subarray(a, b)), outs.map((c) => c.subarray(a, b)), b - a)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(b / total)
    if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
  }
  return outs
}

export default {
  id: 'mod.flanger',
  name: 'Flanger',
  family: 'mod',
  about: 'A sweeping whoosh like a jet plane passing overhead, from gentle swirl to metallic whistle.',
  params,
  stereo: 'keep',
  tail: (p) => tailSeconds(p),
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr
    const nch = Math.min(2, input.ch.length)
    const len = nch ? input.ch[0].length : 0
    if (!len) return input
    const extra = Math.round(tailSeconds(p) * sr)
    const k = createKernel(sr, p)
    const src = nch === input.ch.length ? input : { sr, ch: input.ch.slice(0, 2) }
    return { sr, ch: runOffline(k, src, nch, extra, ctx) }
  },
  live: {
    latency: () => 0,
    create(sr, p) {
      return createKernel(sr, p)
    },
  },
}
