// modules/space/spring.js - space.spring, the spring tank of guitar amps and
// old organ and radio reverbs: twangy, drippy, bouncing chirps.
//
// Technique: the parametric spring model of Valimaki, Parker and Abel 2010,
// "Parametric spring reverberation effect" (JAES 58(7)), the same model
// core/ir.js uses for its "spring" space, but run directly on the voice
// instead of through a convolution, so the live version and the offline
// render are one and the same code.
// - Each spring is a feedback loop: a delay of a few tens of milliseconds
//   (the time a wave takes to run along the spring and back) and a cascade of
//   40 stretched first-order allpass sections, (a + z^-K) / (1 + a z^-K),
//   with K = fs / (2 fc). Its group delay, K (1 - a^2) / (1 + a^2 + 2 a
//   cos(w K)), grows from the lows up to the spring's transition frequency
//   fc, as a real spring's does below its transition, so a click comes out
//   as a rising chirp (the highs arrive last), and every trip round the loop
//   spreads it further: that is the drip. The coefficient a sets how strong
//   the chirp is.
// - Inside the loop, two one-pole low passes just above fc (the spring cannot
//   carry what is above it) and a one-pole high pass at 90 Hz, then the loop
//   gain for the requested decay time: 10^(-3 T / T60) per loop of T seconds,
//   where T counts the cascade's group delay too.
// - Up to three springs of different lengths, fed from the same transducer,
//   picked up left, right and centre, as in a three-spring tank.
// - Output: a pickup tone low pass and a gentle high pass, then normalised
//   from the loop's expected energy so a long decay does not get louder and
//   louder.
// Every state value is flushed below 1e-20 so long silent tails stay fast.

import { MixInstance, dryGain, wetGain, renderLive } from './reverb.js'

const TINY = 1e-20
const SECTIONS = 40
const SPRING_MS = [33.1, 41.7, 37.3]
const SPRING_FC = [4300, 3900, 4100]
const SPRING_PAN = [-0.9, 0.9, 0]

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function onePoleG(sr, hz) {
  const f = clamp(hz, 1, sr * 0.49)
  const g = Math.tan((Math.PI * f) / sr)
  return g / (1 + g)
}

/**
 * The spring tank engine. new SpringEngine(sr, { maxSprings: 3 }), then
 * configure({ springs, drip 0..1, decay seconds, tone 0..1, length 0..1,
 * level }) and run(inL, inR, outL, outR, n, inOff, outOff) for the wet signal.
 */
export class SpringEngine {
  constructor(sr, opts = {}) {
    this.sr = sr
    const maxS = clamp(num(opts.maxSprings, 3) | 0, 1, 3)
    this.maxS = maxS
    // Stretch factor K for the highest rate this engine might be asked for.
    this.Kmax = Math.max(1, Math.round(sr / (2 * 3000)))
    this.K = new Int32Array(maxS)
    this.xs = []
    this.ys = []
    this.dl = []
    this.dlLen = new Int32Array(maxS)
    this.dlPos = new Int32Array(maxS)
    this.apPos = new Int32Array(maxS)
    const maxT = Math.ceil(0.075 * sr) + 8
    for (let s = 0; s < maxS; s++) {
      this.xs.push(new Float64Array(SECTIONS * this.Kmax))
      this.ys.push(new Float64Array(SECTIONS * this.Kmax))
      this.dl.push(new Float32Array(maxT))
    }
    this.maxT = maxT
    this.T = new Int32Array(maxS)
    this.gLoop = new Float64Array(maxS)
    this.lp1 = new Float64Array(maxS)
    this.lp2 = new Float64Array(maxS)
    this.hp = new Float64Array(maxS)
    this.gLp = new Float64Array(maxS)
    this.gHp = onePoleG(sr, 90)
    this.panL = new Float64Array(maxS)
    this.panR = new Float64Array(maxS)
    this.a = 0.6
    this.aCur = 0.6
    this.n = 2
    this.level = 1
    this.levelCur = 1
    this.toneG = onePoleG(sr, 4000)
    this.toneS1 = 0
    this.toneS2 = 0
    this.toneS3 = 0
    this.toneS4 = 0
    this.outHpG = onePoleG(sr, 120)
    this.outHpL = 0
    this.outHpR = 0
    this.sm = 1 - Math.exp(-1 / (0.03 * sr))
    this.inHp = 0
    this.first = true
  }

  configure(c) {
    const sr = this.sr
    const n = clamp(Math.round(num(c.springs, 2)), 1, this.maxS)
    this.n = n
    const drip = clamp(num(c.drip, 0.6), 0, 1)
    this.a = 0.3 + 0.5 * drip
    const decay = clamp(num(c.decay, 2.4), 0.2, 10)
    const lenK = Math.pow(2, (clamp(num(c.length, 0.5), 0, 1) - 0.5) * 1.4)
    const tone = clamp(num(c.tone, 0.5), 0, 1)
    let eSum = 0
    for (let s = 0; s < this.maxS; s++) {
      const fc = Math.min(SPRING_FC[s] * Math.pow(lenK, -0.35), 0.45 * sr)
      const K = clamp(Math.round(sr / (2 * fc)), 1, this.Kmax)
      if (this.first) this.K[s] = K
      const T = clamp(Math.round((SPRING_MS[s] * lenK * sr) / 1000), 8, this.maxT - 2)
      if (this.first) {
        this.T[s] = T
        this.dlLen[s] = T
      }
      // Loop time: the delay plus the cascade's group delay near 1 kHz.
      const Ku = this.K[s]
      const w = (2 * Math.PI * 1000 * Ku) / sr
      const a = this.a
      const gd = (Ku * (1 - a * a)) / (1 + a * a + 2 * a * Math.cos(w))
      const loop = (this.T[s] + SECTIONS * gd) / sr
      // The loop filters already lose up to 3 percent per trip in the voice
      // band (most near 1 kHz, least near 550 Hz); make that up so the decay
      // time is honest, while the loop stays below unity at every frequency.
      const g = Math.pow(10, (-3 * loop) / decay)
      this.gLoop[s] = Math.min(0.9995 / 0.974, g / 0.974)
      this.gLp[s] = onePoleG(sr, fc * 1.1)
      const pan = n === 1 ? 0 : SPRING_PAN[s]
      this.panL[s] = Math.sqrt(0.5 * (1 - pan))
      this.panR[s] = Math.sqrt(0.5 * (1 + pan))
      // Energy of one spring's response for a unit click: the sum of g^2k
      // over the trips (the allpass cascade itself keeps all energy).
      if (s < n) eSum += 1 / (1 - Math.min(0.9999, g * g))
    }
    // Normalise: unit energy summed over the springs, times the level.
    // Springs fed from one transducer add partly in phase in the voice band,
    // so more springs need a little less each (measured on speech).
    const countK = n === 1 ? 1.2 : n === 3 ? 0.85 : 1
    this.level = (num(c.level, 1) * countK) / Math.sqrt(Math.max(1e-6, eSum))
    this.toneG = onePoleG(sr, 2200 * Math.pow(3.2, tone))
    if (this.first) {
      this.aCur = this.a
      this.levelCur = this.level
      this.first = false
    }
  }

  reset() {
    for (let s = 0; s < this.maxS; s++) {
      this.xs[s].fill(0)
      this.ys[s].fill(0)
      this.dl[s].fill(0)
      this.lp1[s] = this.lp2[s] = this.hp[s] = 0
      this.dlPos[s] = 0
      this.apPos[s] = 0
    }
    this.toneS1 = this.toneS2 = this.toneS3 = this.toneS4 = 0
    this.outHpL = this.outHpR = 0
    this.inHp = 0
    this.aCur = this.a
    this.levelCur = this.level
  }

  run(inL, inR, outL, outR, n, inOff = 0, outOff = 0) {
    const nS = this.n
    const sm = this.sm
    const gHp = this.gHp
    const tG = this.toneG
    const hG = this.outHpG
    for (let t = 0; t < n; t++) {
      const j = inOff + t
      let xl = inL[j]
      let xr = inR ? inR[j] : xl
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      let x = (xl + xr) * 0.5
      // The transducer does not pass deep lows.
      let tv = (x - this.inHp) * gHp
      const il = tv + this.inHp
      this.inHp = il + tv
      if (this.inHp < TINY && this.inHp > -TINY) this.inHp = 0
      x -= il
      this.aCur += (this.a - this.aCur) * sm
      this.levelCur += (this.level - this.levelCur) * sm
      const a = this.aCur
      let sL = 0
      let sR = 0
      for (let s = 0; s < nS; s++) {
        const dl = this.dl[s]
        const T = this.dlLen[s]
        let dp = this.dlPos[s]
        // Read the loop's delayed output (T samples ago) and add the input.
        let v = x + this.gLoop[s] * dl[dp]
        const K = this.K[s]
        const xs = this.xs[s]
        const ys = this.ys[s]
        const p = this.apPos[s]
        for (let m = 0, o = p; m < SECTIONS; m++, o += K) {
          const xd = xs[o]
          const yd = ys[o]
          let y = a * v + xd - a * yd
          if (y < TINY && y > -TINY) y = 0
          xs[o] = v
          ys[o] = y
          v = y
        }
        this.apPos[s] = p + 1 >= K ? 0 : p + 1
        // Loop filters: two low passes above fc, one high pass.
        const gl = this.gLp[s]
        tv = (v - this.lp1[s]) * gl
        let l1 = tv + this.lp1[s]
        this.lp1[s] = l1 + tv
        tv = (l1 - this.lp2[s]) * gl
        const l2 = tv + this.lp2[s]
        this.lp2[s] = l2 + tv
        tv = (l2 - this.hp[s]) * gHp
        const hl = tv + this.hp[s]
        this.hp[s] = hl + tv
        let y = l2 - hl
        if (y < TINY && y > -TINY) y = 0
        else if (!(y < 1e6 && y > -1e6)) y = 0
        if (this.lp1[s] < TINY && this.lp1[s] > -TINY) this.lp1[s] = 0
        if (this.lp2[s] < TINY && this.lp2[s] > -TINY) this.lp2[s] = 0
        if (this.hp[s] < TINY && this.hp[s] > -TINY) this.hp[s] = 0
        dl[dp] = y
        dp++
        if (dp >= T) dp = 0
        this.dlPos[s] = dp
        sL += y * this.panL[s]
        sR += y * this.panR[s]
      }
      // Pickup tone (two poles) and a gentle high pass.
      tv = (sL - this.toneS1) * tG
      let o1 = tv + this.toneS1
      this.toneS1 = o1 + tv
      tv = (o1 - this.toneS2) * tG
      o1 = tv + this.toneS2
      this.toneS2 = o1 + tv
      tv = (sR - this.toneS3) * tG
      let o2 = tv + this.toneS3
      this.toneS3 = o2 + tv
      tv = (o2 - this.toneS4) * tG
      o2 = tv + this.toneS4
      this.toneS4 = o2 + tv
      tv = (o1 - this.outHpL) * hG
      const h1 = tv + this.outHpL
      this.outHpL = h1 + tv
      tv = (o2 - this.outHpR) * hG
      const h2 = tv + this.outHpR
      this.outHpR = h2 + tv
      if (this.toneS1 < TINY && this.toneS1 > -TINY) this.toneS1 = 0
      if (this.toneS2 < TINY && this.toneS2 > -TINY) this.toneS2 = 0
      if (this.toneS3 < TINY && this.toneS3 > -TINY) this.toneS3 = 0
      if (this.toneS4 < TINY && this.toneS4 > -TINY) this.toneS4 = 0
      if (this.outHpL < TINY && this.outHpL > -TINY) this.outHpL = 0
      if (this.outHpR < TINY && this.outHpR > -TINY) this.outHpR = 0
      const lv = this.levelCur
      const wl = (o1 - h1) * lv
      const wr = (o2 - h2) * lv
      const o = outOff + t
      if (outR) {
        outL[o] = wl
        outR[o] = wr
      } else outL[o] = (wl + wr) * 0.5
    }
  }
}

function springSetup(st, p) {
  const c = st.cfg
  c.springs = num(p.springs, 2)
  c.drip = clamp(num(p.drip, 60), 0, 100) / 100
  c.decay = num(p.decay, 2.4)
  c.tone = clamp(num(p.tone, 50), 0, 100) / 100
  c.length = clamp(num(p.length, 50), 0, 100) / 100
  c.level = 1.65
  st.eng.configure(c)
  st.mix.dryT = dryGain(p.mix)
  st.mix.wetT = wetGain(p.mix)
}

function makeSpringLive(sr, p) {
  const eng = new SpringEngine(sr, { maxSprings: 3 })
  const st = { eng, mix: new MixInstance(sr), cfg: { springs: 2, drip: 0.6, decay: 2.4, tone: 0.5, length: 0.5, level: 1 } }
  springSetup(st, p)
  return {
    process(ins, outs, n) {
      st.mix.mixBlock(ins, outs, n, eng)
    },
    set(np) {
      springSetup(st, np)
    },
    reset() {
      eng.reset()
      st.mix.inited = false
    },
  }
}

function springTail(p) {
  return Math.min(12, clamp(num(p.decay, 2.4), 0.5, 6) * 1.15 + 0.2)
}

export default {
  id: 'space.spring',
  name: 'Spring tank',
  family: 'space',
  about: 'The twangy, drippy spring reverb of old amps and surf radio: every word bounces down the springs.',
  params: [
    { id: 'springs', name: 'Springs', type: 'number', min: 1, max: 3, step: 1, def: 2, unit: 'count', noun: ['spring', 'springs'], rand: [1, 3] },
    { id: 'drip', name: 'Drip', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'decay', name: 'Decay time', type: 'number', min: 0.5, max: 6, step: 0.1, def: 2.4, unit: 'seconds', rand: [1.2, 3.5] },
    { id: 'tone', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 75] },
    { id: 'length', name: 'Spring length', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [20, 50] },
  ],
  stereo: 'make',
  tail: (p) => springTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const inst = makeSpringLive(input.sr, p)
    return renderLive(inst, input, springTail(p), ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      return makeSpringLive(sr, p)
    },
  },
}
