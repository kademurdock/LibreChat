// modules/mod/chorus.js - Chorus: a few extra copies of the voice that drift
// gently in time and pitch around it.
//
// Technique: the modulated-delay chorus described by Jon Dattorro, "Effect
// Design, Part 2: Delay-Line Modulation and Chorus" (JAES 45(10), 1997).
// Every extra voice reads the input from a delay line 5 to 60 milliseconds
// back, and a slow oscillator sweeps that read point, so each copy runs a
// little late and slides a little sharp and flat against the dry voice. Up to
// six copies get their own sweep speed, starting phase and base delay so they
// never move together, and each sweep carries a small slow random wander (a
// cosine-interpolated random walk) so the ensemble never settles into an
// obvious repeating pattern. The copies are spread across the stereo field
// with a constant-power pan law and blended with the dry voice by an
// equal-power crossfade. Fractional reads use the cubic Hermite interpolator
// of core/delay.js.
//
// The same streaming kernel serves the offline render and live mode, so the
// two sound identical. Parameter changes glide (30 ms smoothing) so a moving
// slider never clicks or zips.

import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'

const MAXV = 6
// Per-voice character: base delay factor, sweep speed factor, start phase.
const BASE = [1.0, 1.31, 0.77, 1.17, 0.88, 1.45]
const SPEED = [1.0, 0.83, 1.19, 0.91, 1.33, 0.71]
const PHASE = [0, 0.37, 0.71, 0.18, 0.55, 0.88]
const CTL = 32 // control-rate period in samples
const TWO_PI = 2 * Math.PI
const MAX_DEPTH_MS = 6

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'voices', name: 'Voices', type: 'number', min: 1, max: 6, step: 1, def: 3, unit: 'count', noun: ['voice', 'voices'], rand: [2, 4] },
  { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [20, 70] },
  { id: 'rate', name: 'Speed', type: 'number', min: 0.05, max: 5, step: 0.05, def: 0.7, unit: 'hz', rand: [0.2, 1.5] },
  { id: 'delay', name: 'Delay time', type: 'number', min: 5, max: 40, step: 1, def: 14, unit: 'ms', rand: [8, 25] },
  { id: 'spread', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [50, 100] },
  { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 60] },
]

function tailSeconds(p) {
  return (num(p && p.delay, 14) * 1.45 + MAX_DEPTH_MS + 2) / 1000
}

function createKernel(sr, p0, rngIn) {
  const rng = rngIn || makeRng('mod.chorus')
  const msToS = sr / 1000
  const dl = new DelayLine(Math.ceil((40 * 1.45 + MAX_DEPTH_MS + 4) * msToS) + 8)
  const ph = new Float64Array(MAXV)
  const wa = new Float64Array(MAXV)
  const wb = new Float64Array(MAXV)
  const wp = new Float64Array(MAXV)
  const wInc = new Float64Array(MAXV)
  const wv = new Float64Array(MAXV)
  const vg = new Float64Array(MAXV)
  const vgT = new Float64Array(MAXV)
  const pan = new Float64Array(MAXV)
  const panT = new Float64Array(MAXV)
  const gl = new Float64Array(MAXV)
  const gr = new Float64Array(MAXV)
  for (let v = 0; v < MAXV; v++) {
    ph[v] = PHASE[v]
    wa[v] = rng.next() * 2 - 1
    wb[v] = rng.next() * 2 - 1
    wp[v] = rng.next()
    wInc[v] = ((0.15 + 0.25 * rng.next()) * CTL) / sr
  }
  const sm = 1 - Math.exp(-1 / (0.03 * sr))
  const smC = 1 - Math.exp(-CTL / (0.03 * sr))
  let depthT = 0.4, delayT = 14, spreadT = 0.8, mixT = 0.5, inc = 0.7 / sr
  let depth = 0, delay = 14, spread = 0, mix = 0
  let dg = 1, wg = 0
  let ctl = 0

  function set(p) {
    const nv = clamp(Math.round(num(p.voices, 3)), 1, MAXV)
    depthT = clamp(num(p.depth, 40), 0, 100) / 100
    inc = clamp(num(p.rate, 0.7), 0, 20) / sr
    delayT = clamp(num(p.delay, 14), 1, 40)
    spreadT = clamp(num(p.spread, 80), 0, 100) / 100
    mixT = clamp(num(p.mix, 50), 0, 100) / 100
    const g = 1 / Math.sqrt(nv)
    for (let v = 0; v < MAXV; v++) {
      vgT[v] = v < nv ? g : 0
      panT[v] = nv === 1 ? 0 : -1 + (2 * v) / (nv - 1)
    }
  }

  function control() {
    spread += (spreadT - spread) * smC
    mix += (mixT - mix) * smC
    dg = Math.cos(mix * 0.5 * Math.PI)
    wg = Math.sin(mix * 0.5 * Math.PI)
    for (let v = 0; v < MAXV; v++) {
      let q = wp[v] + wInc[v]
      if (q >= 1) {
        q -= 1
        wa[v] = wb[v]
        wb[v] = rng.next() * 2 - 1
      }
      wp[v] = q
      wv[v] = wa[v] + (wb[v] - wa[v]) * (0.5 - 0.5 * Math.cos(Math.PI * q))
      pan[v] += (panT[v] - pan[v]) * smC
      vg[v] += (vgT[v] - vg[v]) * smC
      if (vg[v] < 1e-6 && vgT[v] === 0) vg[v] = 0
      const th = (pan[v] * spread + 1) * 0.25 * Math.PI
      gl[v] = Math.cos(th) * Math.SQRT2
      gr[v] = Math.sin(th) * Math.SQRT2
    }
  }

  function snap() {
    depth = depthT
    delay = delayT
    spread = spreadT
    mix = mixT
    for (let v = 0; v < MAXV; v++) {
      vg[v] = vgT[v]
      pan[v] = panT[v]
    }
    ctl = 0
  }

  set(p0)
  snap()

  return {
    set,
    reset() {
      dl.clear()
      for (let v = 0; v < MAXV; v++) ph[v] = PHASE[v]
      snap()
    },
    process(ins, outs, n) {
      const inL = ins[0]
      const inR = ins.length > 1 ? ins[1] : ins[0]
      const oL = outs[0]
      const oR = outs.length > 1 ? outs[1] : null
      for (let i = 0; i < n; i++) {
        if (ctl === 0) {
          control()
          ctl = CTL
        }
        ctl--
        const xl = inL[i]
        const xr = inR[i]
        const x = 0.5 * (xl + xr)
        depth += (depthT - depth) * sm
        delay += (delayT - delay) * sm
        dl.write(x)
        let amp = depth * MAX_DEPTH_MS
        const lim = delay * 0.77 * 0.8
        if (amp > lim) amp = lim
        let wl = 0
        let wr = 0
        for (let v = 0; v < MAXV; v++) {
          let q = ph[v] + inc * SPEED[v]
          if (q >= 1) q -= 1
          ph[v] = q
          const g = vg[v]
          if (g === 0) continue
          const mod = 0.85 * Math.sin(TWO_PI * q) + 0.15 * wv[v]
          const s = dl.read((delay * BASE[v] + amp * mod) * msToS) * g
          wl += s * gl[v]
          wr += s * gr[v]
        }
        oL[i] = xl * dg + wl * wg
        if (oR) oR[i] = xr * dg + wr * wg
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
  id: 'mod.chorus',
  name: 'Chorus',
  family: 'mod',
  about: 'Extra copies of your voice drift gently around it, for a thick, shimmering, doubled sound.',
  params,
  stereo: 'make',
  tail: (p) => tailSeconds(p),
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch.length ? input.ch[0].length : 0
    if (!len) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const extra = Math.round(tailSeconds(p) * sr)
    const k = createKernel(sr, p, ctx && ctx.rng)
    return { sr, ch: runOffline(k, input, 2, extra, ctx) }
  },
  live: {
    latency: () => 0,
    create(sr, p, rng) {
      return createKernel(sr, p, rng)
    },
  },
}
