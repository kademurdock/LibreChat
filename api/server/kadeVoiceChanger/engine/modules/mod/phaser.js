// modules/mod/phaser.js - Phaser: the soft, liquid swirl of moving notches.
//
// Technique: the allpass-cascade phaser described by J. O. Smith III,
// "Physical Audio Signal Processing" (CCRMA, online book), section "Phasing
// with First-Order Allpass Filters", after the analog phase-shift pedals of
// the 1970s. A chain of first-order allpass sections
//     H(z) = (a + z^-1) / (1 + a z^-1),  a = (tan(pi f / fs) - 1) / (tan(pi f / fs) + 1)
// leaves every frequency at full level but delays its phase; mixed back with
// the dry voice, the frequencies where the chain has turned the phase by an
// odd multiple of 180 degrees cancel. Two stages give one notch, four give
// two, and so on. A slow oscillator sweeps the break frequency of every stage
// together over up to two octaves either side of the centre, on a log scale,
// so the notches glide evenly. Feedback from the chain's output to its input
// sharpens the notches into resonant peaks. Coefficients are recomputed
// every 16 samples from a sample counter and interpolated linearly in
// between, so the sweep is smooth and the result does not depend on how the
// host slices its blocks. Changing the number of stages crossfades between
// the old and new tap of the same chain, so it never clicks. A stereo input
// sweeps its right channel a quarter cycle behind the left.

const TWO_PI = 2 * Math.PI
const MAXS = 12
const CTL = 16

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'stages', name: 'Stages', type: 'number', min: 2, max: 12, step: 2, def: 6, unit: 'count', noun: ['stage', 'stages'], rand: [4, 8] },
  { id: 'rate', name: 'Sweep speed', type: 'number', min: 0.02, max: 5, step: 0.01, def: 0.35, unit: 'hz', rand: [0.08, 1.2] },
  { id: 'depth', name: 'Sweep depth', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [50, 100] },
  {
    id: 'feedback', name: 'Feedback', type: 'number', min: -90, max: 90, step: 1, def: 45, unit: 'percent',
    words: { neg: 'negative', pos: 'positive', zero: 'none' }, rand: [-60, 75],
  },
  { id: 'center', name: 'Sweep center', type: 'number', min: 150, max: 4000, step: 10, def: 800, unit: 'hz', rand: [400, 1600] },
  { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [40, 60] },
]

function softLimit(v) {
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
  const st = [new Float64Array(MAXS), new Float64Array(MAXS)]
  const ph = new Float64Array(2)
  const aCur = new Float64Array(2)
  const aStep = new Float64Array(2)
  const fbPrev = new Float64Array(2)
  const smC = 1 - Math.exp(-CTL / (0.04 * sr))
  const xfInc = CTL / (0.03 * sr)
  const fMax = sr * 0.45
  let inc = 0.35 / sr, depthT = 0.8, fbT = 0.45, centerT = 800, mixT = 0.5
  let depth = 0.8, fb = 0.45, center = 800, mix = 0.5
  let tapFrom = 6, tapTo = 6, xf = 1
  let ctl = 0

  function set(p) {
    inc = clamp(num(p.rate, 0.35), 0, 20) / sr
    depthT = clamp(num(p.depth, 80), 0, 100) / 100
    fbT = clamp(num(p.feedback, 45), -90, 90) / 100
    centerT = clamp(num(p.center, 800), 20, fMax)
    mixT = clamp(num(p.mix, 50), 0, 100) / 100
    let s = 2 * Math.round(clamp(num(p.stages, 6), 2, MAXS) / 2)
    if (s < 2) s = 2
    if (s !== tapTo) {
      // start a crossfade from whatever is heard now to the new tap
      tapFrom = xf >= 0.5 ? tapTo : tapFrom
      tapTo = s
      xf = 0
    }
  }
  function coef(f) {
    let fr = f < 20 ? 20 : f > fMax ? fMax : f
    const t = Math.tan((Math.PI * fr) / sr)
    return (t - 1) / (t + 1)
  }
  function snap() {
    depth = depthT
    fb = fbT
    center = centerT
    mix = mixT
    tapFrom = tapTo
    xf = 1
  }
  function reset() {
    st[0].fill(0)
    st[1].fill(0)
    fbPrev[0] = fbPrev[1] = 0
    ph[0] = 0
    ph[1] = 0.25
    snap()
    aCur[0] = coef(center)
    aCur[1] = aCur[0]
    ctl = 0
  }
  set(p0)
  tapFrom = tapTo
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nc = outs.length < 2 ? outs.length : 2
      const nIn = ins.length
      for (let i = 0; i < n; i++) {
        if (ctl === 0) {
          depth += (depthT - depth) * smC
          fb += (fbT - fb) * smC
          center += (centerT - center) * smC
          mix += (mixT - mix) * smC
          if (xf < 1) {
            xf += xfInc
            if (xf >= 1) {
              xf = 1
              tapFrom = tapTo
            }
          }
          for (let c = 0; c < 2; c++) {
            // phase CTL samples ahead, so the ramp ends where the LFO will be
            const q = ph[c] + inc * CTL
            const target = coef(center * Math.pow(2, 2 * depth * Math.sin(TWO_PI * q)))
            aStep[c] = (target - aCur[c]) / CTL
            const s = st[c]
            for (let k = 0; k < MAXS; k++) if (s[k] < 1e-20 && s[k] > -1e-20) s[k] = 0
          }
          ctl = CTL
        }
        ctl--
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        const comp = 1 / Math.sqrt((1 - mix) * (1 - mix) + mix * mix)
        const dry = (1 - mix) * comp
        const wet = mix * comp
        for (let c = 0; c < nc; c++) {
          let q = ph[c] + inc
          if (q >= 1) q -= 1
          ph[c] = q
          const a = aCur[c] + aStep[c]
          aCur[c] = a
          const x = c === 0 ? x0 : x1
          const s = st[c]
          let y = softLimit(x + fb * fbPrev[c])
          let yf = 0
          let yt = 0
          for (let k = 0; k < MAXS; k++) {
            const o = a * y + s[k]
            s[k] = y - a * o
            y = o
            if (k + 1 === tapFrom) yf = y
            if (k + 1 === tapTo) yt = y
          }
          const out = yf + (yt - yf) * xf
          fbPrev[c] = out
          outs[c][i] = x * dry + out * wet
        }
        if (nc < 2) {
          // keep the unused channel's sweep clock in step
          let q = ph[1] + inc
          if (q >= 1) q -= 1
          ph[1] = q
          aCur[1] += aStep[1]
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
  id: 'mod.phaser',
  name: 'Phaser',
  family: 'mod',
  about: 'A soft, liquid swirl that sweeps through your voice, from gentle shimmer to bubbling space sounds.',
  params,
  stereo: 'keep',
  tail: () => 0.03,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr
    const nch = Math.min(2, input.ch.length)
    const len = nch ? input.ch[0].length : 0
    if (!len) return input
    const extra = Math.round(0.03 * sr)
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
