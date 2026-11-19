// modules/mod/underwater.js - Underwater: talking with your head under water.
//
// A voice heard under water is muffled (water and the air-water boundary take
// away nearly everything above a few hundred hertz to a couple of kilohertz,
// depending on how deep and how far), boomy (the low resonance of the air in
// the mouth and the body coupling into the water), slowly wavering (the
// moving water and the listener bobbing), smeared (sound travels four times
// faster in water, so a pool's reflections arrive dense and close together)
// and full of bubbles, which come out in bursts whenever you speak. Each part
// is modelled from published work:
// - Muffling: a fourth-order low pass (two cascaded topology-preserving
//   state-variable filters, Zavalishin, "The Art of VA Filter Design")
//   from 3.2 kHz at the surface down to about 320 Hz at full depth, its
//   cutoff gently swaying with the water, plus a low resonant peak (RBJ
//   cookbook peaking filter) for the boom.
// - Wavering: the voice runs through a delay line whose length drifts with
//   a slow sine (half a cycle per second) and a smooth random walk (up to
//   7 ms, about 15 cents of drift at the default and 40 at full), which bends
//   the pitch slowly up and down, plus a faster gurgle flutter.
// - Smear: three Schroeder allpass diffusers (Schroeder, "Natural Sounding
//   Artificial Reverberation", JAES 1962) with short, mutually prime delays.
// - Bubbles: the Minnaert resonance of a gas bubble, synthesised the way
//   Kees van den Doel describes in "Physically Based Models for Liquid
//   Sounds" (ACM Transactions on Applied Perception, 2005): each bubble is a
//   damped sine whose frequency rises as it nears the surface,
//   f(t) = f0 (1 + xi f0 t), with decay rate 0.13 f0 + 0.0072 f0^1.5 per
//   second (slowed a little so they read clearly). Bubbles come out in
//   bursts of one to six, a few every second in the background and many
//   more while you talk (driven by your own loudness, so loud words blow
//   more bubbles), and deeper water gives bigger, lower bubbles.
// - Gurgle: talking with water in your mouth flutters the level and pitch at
//   about 6 to 12 Hz while you speak.
// One streaming kernel serves offline and live; the voice path sits behind a
// short fixed delay (so it can waver both ways), which live mode reports as
// latency and the offline render removes. The loudness reference for the
// bubbles is measured from the take offline and followed adaptively live.

import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const SLOTS = 14
const CTL = 32
const WOB_MS = 7
const GURGLE_MS = 0.35
const AP_MS = [4.7, 7.9, 12.3]

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'depth', name: 'How deep', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 85] },
  { id: 'bubbles', name: 'Bubbles', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  { id: 'wobble', name: 'Wobble', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [20, 70] },
  { id: 'gurgle', name: 'Gurgle', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
  { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [80, 100] },
]

function latencyFor(sr) {
  return Math.ceil(((WOB_MS + GURGLE_MS + 0.1) / 1000) * sr) + 2
}

/** Peaking-filter coefficients (RBJ cookbook) written into c[0..4], no allocation. */
function peakCoefs(c, sr, f, q, db) {
  const A = Math.pow(10, db / 40)
  const w0 = (TWO_PI * Math.min(f, sr * 0.45)) / sr
  const cs = Math.cos(w0)
  const al = Math.sin(w0) / (2 * q)
  const a0 = 1 + al / A
  c[0] = (1 + al * A) / a0
  c[1] = (-2 * cs) / a0
  c[2] = (1 - al * A) / a0
  c[3] = (-2 * cs) / a0
  c[4] = (1 - al / A) / a0
}

/** The take's speaking level: 90th percentile of a 10 ms peak envelope. */
function loudLevel(chs, sr) {
  const n = chs[0].length
  const hop = Math.max(1, Math.round(sr * 0.01))
  const frames = Math.floor(n / hop)
  if (frames < 1) return 0
  const att = 1 - Math.exp(-1 / (0.005 * sr))
  const rel = 1 - Math.exp(-1 / (0.08 * sr))
  const lv = new Float32Array(frames)
  const g = 1 / chs.length
  let env = 0
  let f = 0
  for (let i = 0; i < frames * hop; i++) {
    let x = 0
    for (let c = 0; c < chs.length; c++) x += chs[c][i]
    x *= g
    x = x < 0 ? -x : x
    if (!(x < 1e30)) x = 0
    env += (x - env) * (x > env ? att : rel)
    if ((i + 1) % hop === 0) lv[f++] = env
  }
  lv.sort()
  return lv[Math.min(frames - 1, Math.floor(frames * 0.9))]
}

function createKernel(sr, p0, rngIn, refInit) {
  const rng = rngIn || makeRng('mod.underwater')
  const rngW = typeof rng.fork === 'function' ? rng.fork('wobble') : rng
  const rngB = typeof rng.fork === 'function' ? rng.fork('bubbles') : rng
  const lat = latencyFor(sr)
  const msS = sr / 1000
  const fMax = sr * 0.45
  const lines = [new DelayLine(2 * lat + 8), new DelayLine(2 * lat + 8)]
  const dryLines = [new DelayLine(lat + 8), new DelayLine(lat + 8)]
  // two cascaded state-variable low passes per channel
  const s1a = new Float64Array(2), s1b = new Float64Array(2), s2a = new Float64Array(2), s2b = new Float64Array(2)
  // boom peak (Direct Form I) per channel
  const pc = new Float64Array(5)
  const px1 = new Float64Array(2), px2 = new Float64Array(2), py1 = new Float64Array(2), py2 = new Float64Array(2)
  // allpass diffusers per channel
  const apLen = AP_MS.map((ms) => Math.max(1, Math.round(ms * msS)))
  const ap = [AP_MS.map((_, k) => new Float32Array(apLen[k])), AP_MS.map((_, k) => new Float32Array(apLen[k]))]
  const apPos = new Int32Array(AP_MS.length)
  // bubble slots
  const bAmp = new Float64Array(SLOTS), bDec = new Float64Array(SLOTS), bF = new Float64Array(SLOTS)
  const bDf = new Float64Array(SLOTS), bFmax = new Float64Array(SLOTS)
  const bC = new Float64Array(SLOTS), bS = new Float64Array(SLOTS), bCr = new Float64Array(SLOTS), bSr = new Float64Array(SLOTS)
  const bPanL = new Float64Array(SLOTS), bPanR = new Float64Array(SLOTS)
  const bLp = new Float64Array(2)
  const cBub = 1 - Math.exp((-TWO_PI * Math.min(3200, fMax)) / sr)
  const att = 1 - Math.exp(-1 / (0.005 * sr))
  const rel = 1 - Math.exp(-1 / (0.08 * sr))
  const refFall = Math.exp(-1 / (8 * sr))
  const sm = 1 - Math.exp(-1 / (0.05 * sr))
  const smC = 1 - Math.exp(-CTL / (0.05 * sr))
  const ref0 = refInit > 1e-4 ? refInit : 0.1
  let depthT = 0.6, bubT = 0.5, wobT = 0.4, gurT = 0.25, mixT = 1
  let depth = 0.6, bub = 0.5, wob = 0.4, gur = 0.25, mix = 1
  let env = 0, ref = ref0, level = 0
  let t = 0, wa = 0, wb = 0, wp = 0, wv = 0, gph = 0, grate = 9
  let fc = 800, g1 = 0
  let A1 = 1, A2 = 0, A3 = 0, B1 = 1, B2 = 0, B3 = 0
  // control-rate ramps: wavering (ms), gurgle sine
  let wav = 0, wavStep = 0, gs = 0, gsStep = 0
  let burstLeft = 0, burstWait = 0
  let ctl = 0

  function set(p) {
    depthT = clamp(num(p.depth, 60), 0, 100) / 100
    bubT = clamp(num(p.bubbles, 50), 0, 100) / 100
    wobT = clamp(num(p.wobble, 40), 0, 100) / 100
    gurT = clamp(num(p.gurgle, 25), 0, 100) / 100
    mixT = clamp(num(p.mix, 100), 0, 100) / 100
  }
  function control() {
    depth += (depthT - depth) * smC
    bub += (bubT - bub) * smC
    wob += (wobT - wob) * smC
    gur += (gurT - gur) * smC
    // slow random walk for the wavering
    wp += (0.9 * CTL) / sr
    if (wp >= 1) {
      wp -= 1
      wa = wb
      wb = rngW.next() * 2 - 1
    }
    wv = wa + (wb - wa) * (0.5 - 0.5 * Math.cos(Math.PI * wp))
    // gurgle rate wanders between about 6 and 12 Hz
    grate = 9 + 3 * wv
    // swaying low pass
    const ts = t / sr
    const base = 3200 * Math.pow(0.1, depth)
    fc = base * (1 + 0.18 * wob * Math.sin(TWO_PI * 0.17 * ts + 1.3) + 0.06 * wob * wv)
    if (fc > fMax) fc = fMax
    g1 = Math.tan((Math.PI * fc) / sr)
    A1 = 1 / (1 + g1 * (g1 + 1 / 0.55))
    A2 = g1 * A1
    A3 = g1 * A2
    B1 = 1 / (1 + g1 * (g1 + 1 / 0.9))
    B2 = g1 * B1
    B3 = g1 * B2
    peakCoefs(pc, sr, 230 + 120 * (1 - depth), 1.1, 2 + 3.5 * depth)
    // wavering and gurgle, ramped linearly across the next CTL samples
    const t1 = (t + CTL) / sr
    const wNow = wob * WOB_MS * (0.55 * Math.sin(TWO_PI * 0.5 * ts) + 0.45 * wv)
    const wEnd = wob * WOB_MS * (0.55 * Math.sin(TWO_PI * 0.5 * t1) + 0.45 * wv)
    wav = wNow
    wavStep = (wEnd - wNow) / CTL
    const g0 = Math.sin(TWO_PI * gph)
    gph += (grate * CTL) / sr
    if (gph >= 1) gph -= Math.floor(gph)
    gs = g0
    gsStep = (Math.sin(TWO_PI * gph) - g0) / CTL
    // bubbles: rise in pitch, new rotation for each one's oscillator
    for (let k = 0; k < SLOTS; k++) {
      if (bAmp[k] === 0) continue
      const nf = bF[k] + bDf[k] * CTL
      bF[k] = nf < bFmax[k] ? nf : bFmax[k]
      const w = (TWO_PI * bF[k]) / sr
      bCr[k] = Math.cos(w)
      bSr[k] = Math.sin(w)
    }
    for (let c = 0; c < 2; c++) {
      if (s1a[c] < 1e-20 && s1a[c] > -1e-20) s1a[c] = 0
      if (s1b[c] < 1e-20 && s1b[c] > -1e-20) s1b[c] = 0
      if (s2a[c] < 1e-20 && s2a[c] > -1e-20) s2a[c] = 0
      if (s2b[c] < 1e-20 && s2b[c] > -1e-20) s2b[c] = 0
    }
  }
  function spawn(stereo) {
    let s = -1
    let quiet = Infinity
    for (let k = 0; k < SLOTS; k++) {
      if (bAmp[k] === 0) {
        s = k
        break
      }
      if (bAmp[k] < quiet) {
        quiet = bAmp[k]
        s = k
      }
    }
    // bigger, lower bubbles in deeper water
    const lo = 320 * (1 - 0.35 * depth)
    const hi = 1700 * (1 - 0.4 * depth)
    const f0 = lo * Math.exp(Math.log(hi / lo) * rngB.next())
    const xi = 0.015 + 0.035 * rngB.next()
    const decay = 0.55 * (0.13 * f0 + 0.0072 * f0 * Math.sqrt(f0))
    const lvl = (ref > 0.02 ? ref : 0.02) * (0.35 + 0.65 * rngB.next()) * 1.3 * (0.45 + 0.55 * bub)
    bAmp[s] = lvl
    bDec[s] = Math.exp(-decay / sr)
    bF[s] = f0
    bDf[s] = (xi * f0 * f0) / sr
    bFmax[s] = Math.min(f0 * 2.6, fMax)
    // a phasor starting at zero phase, turned by a rotation each sample
    bC[s] = 1
    bS[s] = 0
    const w = (TWO_PI * f0) / sr
    bCr[s] = Math.cos(w)
    bSr[s] = Math.sin(w)
    const pan = stereo ? rngB.next() * 2 - 1 : 0
    const th = (pan * 0.7 + 1) * 0.25 * Math.PI
    bPanL[s] = Math.cos(th) * Math.SQRT2
    bPanR[s] = Math.sin(th) * Math.SQRT2
  }
  function snap() {
    depth = depthT
    bub = bubT
    wob = wobT
    gur = gurT
    mix = mixT
  }
  function reset() {
    for (let c = 0; c < 2; c++) {
      lines[c].clear()
      dryLines[c].clear()
      s1a[c] = s1b[c] = s2a[c] = s2b[c] = 0
      px1[c] = px2[c] = py1[c] = py2[c] = 0
      bLp[c] = 0
      for (let k = 0; k < AP_MS.length; k++) ap[c][k].fill(0)
    }
    apPos.fill(0)
    bAmp.fill(0)
    env = 0
    ref = ref0
    t = 0
    wa = rngW.next() * 2 - 1
    wb = rngW.next() * 2 - 1
    wp = 0
    gph = 0
    burstLeft = 0
    burstWait = 0
    snap()
    ctl = 0
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nc = outs.length < 2 ? outs.length : 2
      const nIn = ins.length
      const stereo = nc > 1
      for (let i = 0; i < n; i++) {
        if (ctl === 0) {
          control()
          ctl = CTL
        }
        ctl--
        t++
        mix += (mixT - mix) * sm
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        // how loudly you are talking, against your own loud level
        let a = 0.5 * (x0 + x1)
        a = a < 0 ? -a : a
        if (!(a < 1e30)) a = 0
        env += (a - env) * (a > env ? att : rel)
        if (env < 1e-12) env = 0
        if (env > ref) ref = env
        else {
          ref *= refFall
          if (ref < ref0 * 0.03) ref = ref0 * 0.03
        }
        let u = env / ref
        u = u > 1 ? 1 : u
        level = u * u
        // bubble bursts: a few in the background, many while you talk
        if (burstLeft > 0) {
          if (--burstWait <= 0) {
            spawn(stereo)
            burstLeft--
            burstWait = Math.round((0.006 + 0.03 * rngB.next()) * sr)
          }
        } else {
          const rate = bub * (0.6 + 22 * level)
          if (rngB.next() < rate / sr) {
            burstLeft = 1 + Math.floor(rngB.next() * 6 * (0.4 + 0.6 * bub))
            burstWait = 0
          }
        }
        // wavering read point (slow sine + random walk + gurgle flutter)
        wav += wavStep
        gs += gsStep
        const d = lat + (wav + gur * level * GURGLE_MS * gs) * msS
        const am = 1 - gur * 0.5 * level * (0.5 + 0.5 * gs)
        // bubbles for this sample
        let bl = 0
        let br = 0
        for (let k = 0; k < SLOTS; k++) {
          const amp = bAmp[k]
          if (amp === 0) continue
          const c0 = bC[k]
          const s0 = bS[k]
          const s = amp * s0
          bl += s * bPanL[k]
          br += s * bPanR[k]
          bC[k] = c0 * bCr[k] - s0 * bSr[k]
          bS[k] = c0 * bSr[k] + s0 * bCr[k]
          const na = amp * bDec[k]
          bAmp[k] = na < 1e-6 ? 0 : na
        }
        const makeup = 1 + 0.25 * depth
        const dry = 1 - mix
        for (let c = 0; c < nc; c++) {
          const x = c === 0 ? x0 : x1
          const line = lines[c]
          line.write(x)
          dryLines[c].write(x)
          let v = line.read(d) * am
          // low pass 1
          {
            const v3 = v - s1b[c]
            const v1 = A1 * s1a[c] + A2 * v3
            const v2 = s1b[c] + A2 * s1a[c] + A3 * v3
            s1a[c] = 2 * v1 - s1a[c]
            s1b[c] = 2 * v2 - s1b[c]
            v = v2
          }
          // low pass 2
          {
            const v3 = v - s2b[c]
            const v1 = B1 * s2a[c] + B2 * v3
            const v2 = s2b[c] + B2 * s2a[c] + B3 * v3
            s2a[c] = 2 * v1 - s2a[c]
            s2b[c] = 2 * v2 - s2b[c]
            v = v2
          }
          // boom
          const y = pc[0] * v + pc[1] * px1[c] + pc[2] * px2[c] - pc[3] * py1[c] - pc[4] * py2[c]
          px2[c] = px1[c]
          px1[c] = v
          py2[c] = py1[c]
          py1[c] = y < 1e-20 && y > -1e-20 ? 0 : y
          // bubbles join the voice before the smear, slightly softened
          const bs = stereo ? (c === 0 ? bl : br) : 0.5 * (bl + br)
          let b = bLp[c] + (bs - bLp[c]) * cBub
          if (b < 1e-20 && b > -1e-20) b = 0
          bLp[c] = b
          let w = y * makeup + b
          // diffusion
          let z = w
          const apc = ap[c]
          for (let m = 0; m < 3; m++) {
            const buf = apc[m]
            const pos = apPos[m]
            const dv = buf[pos]
            const inp = z + 0.55 * dv
            buf[pos] = inp < 1e-20 && inp > -1e-20 ? 0 : inp
            z = dv - 0.55 * inp
          }
          w = 0.78 * w + 0.42 * z
          if (!(w < 1e6 && w > -1e6)) w = 0
          outs[c][i] = dryLines[c].read(lat) * dry + w * mix
        }
        for (let m = 0; m < 3; m++) {
          const q = apPos[m] + 1
          apPos[m] = q < apLen[m] ? q : 0
        }
      }
    },
  }
}

export default {
  id: 'mod.underwater',
  name: 'Underwater',
  family: 'mod',
  about: 'Your voice with your head under water: muffled, wavering and bubbling every time you speak.',
  params,
  stereo: 'keep',
  tail: () => 0.15,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const nch = Math.min(2, input.ch.length)
    const len = nch ? input.ch[0].length : 0
    if (!len) return input
    const lat = latencyFor(sr)
    const tailN = Math.round(0.15 * sr)
    const total = len + lat + tailN
    const chs = input.ch.slice(0, nch)
    const ins = chs.map((c) => {
      const y = new Float32Array(total)
      y.set(c)
      return y
    })
    const full = ins.map(() => new Float32Array(total))
    const k = createKernel(sr, p, ctx && ctx.rng, loudLevel(chs, sr))
    const B = 1 << 15
    for (let a = 0; a < total; a += B) {
      const b = Math.min(total, a + B)
      k.process(ins.map((c) => c.subarray(a, b)), full.map((c) => c.subarray(a, b)), b - a)
      if (ctx && typeof ctx.progress === 'function') ctx.progress(b / total)
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
    return { sr, ch: full.map((c) => c.slice(lat)) }
  },
  live: {
    latency: (p, sr) => latencyFor(sr || 48000),
    create(sr, p, rng) {
      return createKernel(sr, p, rng, 0.1)
    },
  },
}
