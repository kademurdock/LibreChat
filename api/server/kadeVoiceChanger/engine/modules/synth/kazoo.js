// modules/synth/kazoo.js - synth.kazoo, kazoo and comb-and-paper buzzers.
//
// Technique: a driven, amplitude-limited membrane, the textbook picture of a
// mirliton (the kazoo family in the Hornbostel-Sachs classification, 1914):
// the singer's voice pushes a thin membrane that slaps against its frame once
// or twice per cycle, which turns the hum into a buzz full of upper
// harmonics, and the little tube body then colours it. In signal terms:
// 1. The voice is level-normalised by a fast peak follower (so the buzz is
//    set by the Buzz control, not by how loud someone sings), and lightly
//    low-passed, because the membrane is pushed mainly by the strong low
//    partials, the fundamental and the first formant.
// 2. Membrane: an asymmetric limiter with a small give past each stop (the
//    membrane is softer one way than the other), which squares off each
//    cycle. It is computed with first-order antiderivative anti-aliasing
//    (Parker, Zavalishin and Le Bivic 2016, "Reducing the aliasing of
//    nonlinear waveshaping using continuous-time convolution", DAFx), without
//    which the sharp corners fold back as a noisy hash at 24 kHz. The
//    overshoot past the stops also drives a burst of paper rattle (filtered
//    noise), strongest for the comb and paper.
// 3. The membrane's own mode, a resonant state-variable bandpass
//    (Zavalishin / Simper TPT form, core/biquad.js), adds the nasal ring, and
//    the body is a highpass, a peaking resonance and a lowpass (RBJ cookbook
//    biquads).
// 4. The voice's own envelope is put back, a little of the plain hum leaks
//    through as it does from a real kazoo, and a slow level follower keeps the
//    result as loud as the dry voice.
// Unvoiced sounds ("s", "t") are recognised by their high-to-low band energy
// ratio and are not driven into the membrane: air through a kazoo hisses, it
// does not buzz. The live version is the same engine.

import { Biquad, SVF } from '../../core/biquad.js'
import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'

const TYPES = {
  kazoo: { pre: 1800, tp: 0.5, tn: -0.34, fm: 2400, qm: 2.5, gm: 1.2, hp: 300, pk: 1100, pq: 1.5, pg: 5, lp: 6500, rattle: 0.03, leak: 0.12 },
  comb: { pre: 2600, tp: 0.36, tn: -0.3, fm: 3800, qm: 2, gm: 1.4, hp: 450, pk: 2600, pq: 1.2, pg: 5, lp: 9500, rattle: 0.2, leak: 0.08 },
  giant: { pre: 1100, tp: 0.6, tn: -0.42, fm: 900, qm: 3, gm: 1.3, hp: 110, pk: 520, pq: 1.5, pg: 6, lp: 3600, rattle: 0.04, leak: 0.15 },
}

const TINY = 1e-25
const GIVE = 0.04 // slope past the stops

/**
 * A second-order section whose coefficients can be redesigned without
 * allocating (RBJ cookbook lowpass, highpass and peaking EQ, Direct Form I),
 * for filters that live set() calls retune.
 */
class Bq {
  constructor(sr) {
    this.sr = sr
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }

  /** kind: 0 lowpass, 1 highpass, 2 peaking (gainDb). */
  design(kind, freq, q, gainDb) {
    let f = freq > 1 ? freq : 1
    if (f > this.sr * 0.49) f = this.sr * 0.49
    const w0 = (2 * Math.PI * f) / this.sr
    const cs = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * (q > 0.01 ? q : 0.01))
    let b0, b1, b2, a0, a1, a2
    if (kind === 2) {
      const A = Math.pow(10, (gainDb || 0) / 40)
      b0 = 1 + alpha * A
      b1 = -2 * cs
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cs
      a2 = 1 - alpha / A
    } else {
      b1 = kind === 1 ? -(1 + cs) : 1 - cs
      b0 = Math.abs(b1) / 2
      b2 = b0
      a0 = 1 + alpha
      a1 = -2 * cs
      a2 = 1 - alpha
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
    return this
  }

  tick(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    if (y < 1e-25 && y > -1e-25) y = 0
    if (!(y > -1e6 && y < 1e6)) y = 0
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

// The membrane's stops: straight between tn and tp, nearly flat beyond.
function clipf(x, tp, tn) {
  if (x > tp) return tp + (x - tp) * GIVE
  if (x < tn) return tn + (x - tn) * GIVE
  return x
}

// Its antiderivative (for the anti-aliased form).
function clipF(x, tp, tn) {
  if (x > tp) {
    const u = x - tp
    return 0.5 * tp * tp + tp * u + 0.5 * GIVE * u * u
  }
  if (x < tn) {
    const u = x - tn
    return 0.5 * tn * tn + tn * u + 0.5 * GIVE * u * u
  }
  return 0.5 * x * x
}

class KazooEngine {
  constructor(sr, p, rng) {
    this.sr = sr > 0 ? sr : 48000
    const r = rng || makeRng('synth.kazoo')
    this.noise = (r.uint32 ? r.uint32() : Math.floor(r.next() * 4294967295)) >>> 0 || 0x9e3779b9
    this.pre = [new SVF(this.sr), new SVF(this.sr)]
    this.mem = [new SVF(this.sr), new SVF(this.sr)]
    this.rat = [new SVF(this.sr), new SVF(this.sr)]
    this.hp = [new Bq(this.sr), new Bq(this.sr)]
    this.pk = [new Bq(this.sr), new Bq(this.sr)]
    this.lp = [new Bq(this.sr), new Bq(this.sr)]
    this.vLp = new Biquad('lowpass', this.sr, Math.min(900, this.sr * 0.45), 0.707)
    this.vHp = new Biquad('highpass', this.sr, Math.min(3000, this.sr * 0.4), 0.707)
    this.env = new Float64Array(2)
    this.ratEnv = new Float64Array(2)
    this.dPrev = new Float64Array(2)
    this.FPrev = new Float64Array(2)
    this.eLo = 0
    this.eHi = 0
    this.voiced = 1
    this.pIn = 0
    this.pOut = 0
    this.agc = 1
    this.mixNow = 1
    this.buzzNow = 0.7
    this.cAtt = Math.exp(-1 / (0.001 * this.sr))
    this.cRel = Math.exp(-1 / (0.04 * this.sr))
    this.cE = 1 - Math.exp(-1 / (0.015 * this.sr))
    this.cV = 1 - Math.exp(-1 / (0.01 * this.sr))
    this.cPow = 1 - Math.exp(-1 / (0.25 * this.sr))
    this.cAgc = 1 - Math.exp(-1 / (0.05 * this.sr))
    this.cS = 1 - Math.exp(-1 / (0.02 * this.sr))
    this.cRat = Math.exp(-1 / (0.004 * this.sr))
    this.t = TYPES.kazoo
    this.set(p)
    this.mixNow = this.mixT
    this.buzzNow = this.buzzT
  }

  set(p) {
    const t = TYPES[p.type] || TYPES.kazoo
    this.t = t
    const b = clamp(Number(p.brightness), 0, 100) / 100
    this.buzzT = clamp(Number(p.buzz), 0, 100) / 100
    this.mixT = clamp(Number(p.mix), 0, 100) / 100
    const nyq = this.sr * 0.45
    this.fPre = Math.min(t.pre, nyq)
    this.fMem = Math.min(t.fm * (0.8 + 0.4 * b), nyq)
    this.fRat = Math.min(t.fm * 1.9, nyq)
    for (let c = 0; c < 2; c++) {
      this.hp[c].design(1, Math.min(t.hp, nyq), 0.707, 0)
      this.pk[c].design(2, Math.min(t.pk, nyq), t.pq, t.pg)
      this.lp[c].design(0, Math.min(t.lp * (0.5 + b), nyq), 0.707, 0)
    }
  }

  reset() {
    for (let c = 0; c < 2; c++) {
      this.pre[c].reset()
      this.mem[c].reset()
      this.rat[c].reset()
      this.hp[c].reset()
      this.pk[c].reset()
      this.lp[c].reset()
    }
    this.vLp.reset()
    this.vHp.reset()
    this.env.fill(0)
    this.ratEnv.fill(0)
    this.dPrev.fill(0)
    this.FPrev.fill(0)
    this.eLo = 0
    this.eHi = 0
    this.voiced = 1
    this.pIn = 0
    this.pOut = 0
    this.agc = 1
  }

  process(ins, outs, n) {
    const nin = ins.length
    const nout = outs.length
    const nch = nout < 2 ? 1 : 2
    const t = this.t
    const env = this.env
    const ratEnv = this.ratEnv
    for (let i = 0; i < n; i++) {
      const xl0 = ins[0][i]
      const xr0 = nin > 1 ? ins[1][i] : xl0
      const xa = xl0 === xl0 && xl0 < 1e6 && xl0 > -1e6 ? xl0 : 0
      const xb = xr0 === xr0 && xr0 < 1e6 && xr0 > -1e6 ? xr0 : 0
      const mono = nin > 1 ? 0.5 * (xa + xb) : xa
      this.mixNow += (this.mixT - this.mixNow) * this.cS
      this.buzzNow += (this.buzzT - this.buzzNow) * this.cS
      // voiced or not: low band against high band energy
      const lo = this.vLp.tick(mono)
      const hi = this.vHp.tick(mono)
      this.eLo += (lo * lo - this.eLo) * this.cE
      this.eHi += (hi * hi - this.eHi) * this.cE
      if (this.eLo < TINY) this.eLo = 0
      if (this.eHi < TINY) this.eHi = 0
      const ratio = this.eHi / (this.eLo + 1e-12)
      let vt = (0.8 - ratio) / 0.65
      vt = vt < 0 ? 0 : vt > 1 ? 1 : vt
      this.voiced += (vt - this.voiced) * this.cV
      const b = this.buzzNow
      const drive = (0.8 + 7 * b) * this.voiced + (1 - this.voiced)
      const buzzMix = b * this.voiced
      let w0 = 0
      let w1 = 0
      let sq = 0
      let isq = 0
      for (let c = 0; c < nch; c++) {
        const x = nch === 1 ? mono : c === 0 ? xa : xb
        const ax = x < 0 ? -x : x
        const ce = ax > env[c] ? this.cAtt : this.cRel
        let e = ax + ce * (env[c] - ax)
        if (e < TINY) e = 0
        env[c] = e
        const xn = x / (e + 1e-3)
        // membrane: pushed by the low partials, stopped by its frame
        const d = this.pre[c].tick(xn, this.fPre, 0.6).lp * drive
        // the stop, with first-order antiderivative anti-aliasing (Parker,
        // Zavalishin and Le Bivic 2016): the average of the clipper over the
        // step from the last input to this one, so the corners do not fold
        // back as hash
        const dp = this.dPrev[c]
        this.dPrev[c] = d
        const Fd = clipF(d, t.tp, t.tn)
        let cl
        const dd = d - dp
        if (dd > 1e-5 || dd < -1e-5) cl = (Fd - this.FPrev[c]) / dd
        else cl = clipf(0.5 * (d + dp), t.tp, t.tn)
        this.FPrev[c] = Fd
        const over = (d - clipf(d, t.tp, t.tn)) / (drive > 1 ? drive : 1)
        const ao = over < 0 ? -over : over
        ratEnv[c] = ao > ratEnv[c] ? ao : ao + this.cRat * (ratEnv[c] - ao)
        if (ratEnv[c] < TINY) ratEnv[c] = 0
        // paper rattle: noise burst while the membrane is on its stops
        let s = this.noise
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        s >>>= 0
        this.noise = s
        const nz = (s / 2147483648 - 1) * ratEnv[c]
        const rat = this.rat[c].tick(nz, this.fRat, 1.2).bp * t.rattle * 2.5
        const ring = this.mem[c].tick(cl, this.fMem, t.qm).bp * (t.gm / t.qm)
        let buzz = cl + ring * 2 + rat
        // blend toward the plain (unclipped) hum as the buzz control drops
        buzz = buzzMix * buzz + (1 - buzzMix) * (d / (drive > 1e-6 ? drive : 1)) * 0.7
        let y = this.hp[c].tick(buzz)
        y = this.pk[c].tick(y)
        y = this.lp[c].tick(y)
        y = y * e + t.leak * x
        if (!(y > -1e3 && y < 1e3)) y = 0
        sq += y * y
        isq += x * x
        if (c === 0) w0 = y
        else w1 = y
      }
      this.pIn += (isq - this.pIn) * this.cPow
      this.pOut += (sq - this.pOut) * this.cPow
      if (this.pIn < TINY) this.pIn = 0
      if (this.pOut < TINY) this.pOut = 0
      if (this.pIn > 1e-8) {
        let tg = Math.sqrt((this.pIn + 1e-12) / (this.pOut + 1e-12))
        tg = clamp(tg, 0.25, 8)
        this.agc += (tg - this.agc) * this.cAgc
      }
      const g = this.agc
      const m = this.mixNow
      for (let c = 0; c < nout; c++) {
        const dry = c === 0 ? xa : nin > 1 ? xb : xa
        const wet = (c === 0 || nch === 1 ? w0 : w1) * g
        outs[c][i] = dry + m * (wet - dry)
      }
    }
  }
}

const BLOCK = 8192

function runOffline(input, p, ctx) {
  const n = bufLen(input)
  if (!n) return input
  const rng = ctx && ctx.rng ? ctx.rng : makeRng('synth.kazoo')
  const nch = input.ch.length
  const outs = []
  for (let c = 0; c < nch; c++) outs.push(new Float32Array(n))
  const engines = []
  for (let c = 0; c < nch; c += 2) engines.push(new KazooEngine(input.sr, p, rng.fork ? rng.fork('pair' + c) : rng))
  for (let s = 0; s < n; s += BLOCK) {
    const m = Math.min(BLOCK, n - s)
    for (let c = 0, e = 0; c < nch; c += 2, e++) {
      const iv = input.ch.slice(c, c + 2).map((x) => x.subarray(s, s + m))
      const ov = outs.slice(c, c + 2).map((x) => x.subarray(s, s + m))
      engines[e].process(iv, ov, m)
    }
    if (ctx && typeof ctx.progress === 'function') ctx.progress((s + m) / n)
    if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
  }
  return { sr: input.sr, ch: outs }
}

export default {
  id: 'synth.kazoo',
  name: 'Kazoo',
  family: 'synth',
  about: 'Your voice through a buzzing kazoo, a comb and paper, or a giant kazoo. Hum, sing or talk into it.',
  params: [
    {
      id: 'type', name: 'Buzzer', type: 'choice', def: 'kazoo',
      options: [
        { v: 'kazoo', name: 'Kazoo' },
        { v: 'comb', name: 'Comb and paper' },
        { v: 'giant', name: 'Giant kazoo' },
      ],
    },
    { id: 'buzz', name: 'Buzz', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [45, 95] },
    { id: 'brightness', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [80, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    return runOffline(input, p, ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new KazooEngine(sr, p, rng)
    },
  },
}

export { KazooEngine }
