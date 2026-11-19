// modules/space/reverb.js - space.reverb, an algorithmic hall reverb, and the
// feedback delay network engine every live space in this family runs on.
//
// Technique: a feedback delay network (FDN) after Jot and Chaigne 1991,
// "Digital delay networks for designing artificial reverberators" (AES
// preprint 3030), and Jot 1992, "An analysis/synthesis approach to real-time
// artificial reverberation" (ICASSP).
// - 16 delay lines (8 for the cheap helpers) with lengths spread over a 3.1
//   to 1 range, rounded to primes so no two lines share echoes.
// - Lossless feedback matrix: the Kronecker product of two 4 by 4 Householder
//   reflections, I - (1/2) 1 1^T (Jot's "Householder of Householders"), so
//   every entry is plus or minus one quarter. It is orthogonal (no energy is
//   created) and maximally diffusing, and costs 32 additions per sample
//   instead of 256 multiplies. The 8-line form is a 4 by 4 Householder
//   crossed with a 2 by 2 Hadamard.
// - Frequency-dependent decay, Jot's absorptive filters: each line carries a
//   gain for the requested mid decay time (10^(-3 d / (fs T60)) for a line of
//   d samples) and two first-order shelves (topology-preserving one-poles
//   after Zavalishin, "The Art of VA Filter Design") that make highs die
//   sooner (damping) and lows a little later (warmth). Each shelf's magnitude
//   lies between its two end gains, so the loop gain never exceeds the
//   largest decay gain and the network is provably stable.
// - Input diffusion: four Schroeder allpasses in series (Schroeder 1962,
//   "Natural sounding artificial reverberation", JAES 10), with the lengths
//   and gains of Dattorro's plate (1997, "Effect design part 1", JAES 45),
//   so the first echoes arrive as a dense wash, not a train of clicks.
// - Modulated line lengths (Dattorro's chorusing of the tank, after the
//   1980s studio reverbs): each line's length drifts by up to about a
//   millisecond on its own slow sine, which melts the metallic ringing a
//   static network has. Reads use cubic Hermite interpolation (Niemitalo
//   2001), the same as core/delay.js, inlined for speed.
// - Early reflections: a tapped delay line on the predelayed send, panned
//   left and right, so the room is heard before the tail.
// - An optional pitch shifter inside the loop (the shimmer): the late output
//   is shifted by a delay-line granular shifter (two read taps sweeping
//   through a short buffer under sine-squared windows that sum to one) and
//   fed back into the send, so every trip round the network climbs an
//   interval. Its loop gain is normalised and soft-limited, so it cannot run
//   away.
//
// Levels: the late response is normalised from the network's expected
// energy, 1 / (N (1 - g^2)) for a unit send, so the tail's loudness follows
// a gentle power of the decay time instead of exploding for long decays.
//
// The offline process runs exactly the live code over the take and its
// tail, so live mode sounds the same as a render. Everything is allocated in
// create(); process() and set() allocate nothing and create no closures.

const TINY = 1e-20

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function nextPow2(n) {
  let p = 16
  while (p < n) p <<= 1
  return p
}

function isPrime(n) {
  if (n < 2) return false
  if (n % 2 === 0) return n === 2
  for (let k = 3; k * k <= n; k += 2) if (n % k === 0) return false
  return true
}

/** Nearest prime at or above 2 (searching outwards). */
function nearPrime(x) {
  const n = Math.max(2, Math.round(x))
  for (let k = 0; k < 4000; k++) {
    if (isPrime(n + k)) return n + k
    if (n - k >= 2 && isPrime(n - k)) return n - k
  }
  return n
}

/**
 * Complex response of the TPT one-pole low pass with g = tan(pi fc / fs) at
 * the angle whose cosine and sine are cw and sw:
 * g (1 + z^-1) / ((1 + g) + (g - 1) z^-1). Writes [re, im] into out.
 */
function lpAt(g, cw, sw, out) {
  const nr = g * (1 + cw)
  const ni = -g * sw
  const dr = 1 + g + (g - 1) * cw
  const di = -(g - 1) * sw
  const dd = dr * dr + di * di
  out[0] = (nr * dr + ni * di) / dd
  out[1] = (ni * dr - nr * di) / dd
}

/** One-pole TPT coefficient G = g / (1 + g), g = tan(pi f / fs). */
function onePoleG(sr, hz) {
  const f = clamp(hz, 1, sr * 0.49)
  const g = Math.tan((Math.PI * f) / sr)
  return g / (1 + g)
}

// Line length ratios, a near-geometric spread of 3.1 to 1, listed in an order
// that puts short and long lines into every row and column of the 4 by 4
// matrix layout (index 4 r + c).
const RATIOS16 = [1.0, 2.124, 1.351, 2.873, 1.162, 1.827, 2.47, 1.571, 1.077, 2.664, 1.457, 1.97, 3.098, 1.253, 2.291, 1.694]
const RATIOS8 = [1.0, 1.97, 1.351, 2.664, 1.162, 2.291, 1.571, 3.098]

// Sign patterns for the send and the two outputs: fixed, balanced and
// mutually near-orthogonal, and deliberately not eigenvectors of the
// matrix, so the send excites every mode and the two sides decorrelate.
const SIGN_IN = [1, 1, -1, 1, -1, 1, 1, 1, 1, -1, 1, -1, -1, -1, 1, 1]
const SIGN_L = [1, -1, 1, 1, 1, 1, -1, -1, 1, 1, 1, -1, 1, -1, -1, 1]
const SIGN_R = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1, 1, 1, -1, -1]

// Dattorro's input diffusers, at 29761 Hz: 142, 107, 379, 277 samples.
const DIFF_MS = [4.771, 3.595, 12.735, 9.307]
const DIFF_G = [0.75, 0.75, 0.625, 0.625]

const MAX_TAPS = 32
const CTRL = 32 // samples per control step (modulation and slews)

/** A plain, preallocatable FDN configuration. */
export function fdnConfig() {
  return {
    minDelayMs: 12, // shortest line
    spread: 3.1, // longest / shortest
    decay: 1.8, // mid-band seconds to fall 60 dB
    hiRatio: 0.65, // high-band decay as a fraction of decay
    hiHz: 4500, // where the high band starts
    bassRatio: 1.1, // low-band decay as a multiple of decay
    bassHz: 250,
    mod: 0.3, // modulation depth 0..1
    modRate: 0.6, // base modulation rate, Hz
    predelayMs: 10,
    diffusion: 1, // 0..1 scales the diffuser gains
    sendHp: 90, // Hz, high pass on the send
    sendLp: 12000, // Hz, low pass on the send
    lateGain: 1, // amplitude of the late tail after normalisation (1 = unit energy)
    earlyGain: 1, // amplitude multiplier for the taps
    earlyLp: 0, // Hz, one-pole low pass on the taps (0 = off)
    width: 1, // 0 mono .. 1 full .. 1.5 extra wide
    freeze: 0, // 1 holds the tail (gains 1, no send)
    shimmer: 0, // 0..1 loop amount of the pitch-shifted feedback
    shRatioA: 2, // first shifter ratio
    shRatioB: 0, // second shifter ratio (0 = off)
    shMixB: 0.6,
    shLp: 7000, // Hz, low pass in the shimmer loop
  }
}

/**
 * The feedback delay network. new FdnEngine(sr, { lines: 16|8, maxLineMs,
 * maxPreMs, rng, shimmer: true }) then configure(cfg), setTaps(...) and
 * run(inL, inR, outL, outR, n), which writes the WET signal only.
 */
export class FdnEngine {
  constructor(sr, opts = {}) {
    this.sr = sr
    const N = opts.lines === 8 ? 8 : 16
    this.N = N
    this.ratios = N === 8 ? RATIOS8 : RATIOS16
    const maxLine = Math.max(4, num(opts.maxLineMs, 200)) / 1000
    this.modMax = Math.ceil(0.0015 * sr)
    this.L = nextPow2(Math.ceil(maxLine * sr) + this.modMax + 8)
    this.mask = this.L - 1
    this.maxD = this.L - this.modMax - 6
    this.lines = new Float32Array(N * this.L)
    this.w = 0
    this.dCur = new Float64Array(N) // slewed base length
    this.dTgt = new Float64Array(N)
    this.eff = new Float64Array(N) // length used this sample (base + modulation)
    this.inc = new Float64Array(N)
    this.g = new Float64Array(N)
    this.rHi = new Float64Array(N)
    this.qLo = new Float64Array(N)
    this.sF = new Float64Array(N)
    this.sB = new Float64Array(N)
    this.v = new Float64Array(N)
    this.lfRef = new Float64Array(2)
    this.lbRef = new Float64Array(2)
    this.ph = new Float64Array(N)
    this.phInc = new Float64Array(N)
    this.depth = 0
    this.bIn = new Float64Array(N)
    this.cL = new Float64Array(N)
    this.cR = new Float64Array(N)
    const s = 1 / Math.sqrt(N)
    for (let i = 0; i < N; i++) {
      this.bIn[i] = SIGN_IN[i] * s
      this.cL[i] = SIGN_L[i] * s
      this.cR[i] = SIGN_R[i] * s
    }
    const rng = opts.rng
    for (let i = 0; i < N; i++) {
      // Modulation phases and rate spreads come from the seeded stream only.
      this.ph[i] = rng ? rng.next() : (i * 0.618034) % 1
    }
    this.rateMul = new Float64Array(N)
    for (let i = 0; i < N; i++) this.rateMul[i] = 0.55 + 0.9 * ((i * 0.381966 + (rng ? rng.next() * 0.2 : 0)) % 1)
    // Send: predelay and early taps.
    const maxPre = Math.max(1, num(opts.maxPreMs, 600)) / 1000
    this.P = nextPow2(Math.ceil(maxPre * sr) + 8)
    this.pmask = this.P - 1
    this.pre = new Float32Array(this.P)
    this.pw = 0
    this.preCur = 0
    this.preTgt = 0
    // Diffusers (fixed lengths, set at the first configure).
    this.apBuf = []
    this.apLen = new Int32Array(4)
    this.apPos = new Int32Array(4)
    this.apG = new Float64Array(4)
    const apMax = Math.ceil(0.0135 * sr) + 4
    for (let k = 0; k < 4; k++) this.apBuf.push(new Float32Array(apMax))
    this.apMax = apMax
    this.apSet = false
    // Taps, two banks for click-free changes.
    this.tapD = [new Int32Array(MAX_TAPS), new Int32Array(MAX_TAPS)]
    this.tapL = [new Float64Array(MAX_TAPS), new Float64Array(MAX_TAPS)]
    this.tapR = [new Float64Array(MAX_TAPS), new Float64Array(MAX_TAPS)]
    this.tapN = new Int32Array(2)
    this.bank = 0
    this.xf = 0 // crossfade samples left
    this.xfLen = Math.max(1, Math.round(0.02 * sr))
    this.tapsSet = false
    this.pMs = new Float64Array(MAX_TAPS)
    this.pL = new Float64Array(MAX_TAPS)
    this.pR = new Float64Array(MAX_TAPS)
    this.pN = 0
    this.pendTaps = false
    // Send filters.
    this.hpS = 0
    this.lpS = 0
    this.hpG = 0
    this.lpG = 0
    this.GF = 0
    this.GB = 0
    // Output smoothing.
    this.lateCur = 0
    this.lateTgt = 0
    this.earlyCur = 0
    this.earlyTgt = 0
    this.eLpG = 0
    this.eLpL = 0
    this.eLpR = 0
    this.widthCur = 1
    this.widthTgt = 1
    this.smooth = 1 - Math.exp(-1 / (0.02 * sr))
    this.ctr = 0
    this.first = true
    // Shimmer.
    this.hasShimmer = !!opts.shimmer
    if (this.hasShimmer) {
      this.shW = Math.round(0.07 * sr)
      this.shN = nextPow2(this.shW + 16)
      this.shMask = this.shN - 1
      this.shBuf = new Float32Array(this.shN)
      this.shPos = 0
      this.shPhA = 0
      this.shPhB = 0
      this.shTab = new Float32Array(1025)
      for (let k = 0; k <= 1024; k++) {
        const s1 = Math.sin((Math.PI * k) / 1024)
        this.shTab[k] = s1 * s1
      }
      this.shLpS = 0
      this.shHpS = 0
      this.shPrev = 0
    }
    this.shAmt = 0
    this.shAmtCur = 0
    this.cfg = fdnConfig()
  }

  /** Apply a configuration (all numbers). Allocates nothing. */
  configure(c) {
    const sr = this.sr
    const N = this.N
    this.cfg = c
    const minD = Math.max(3, (num(c.minDelayMs, 12) / 1000) * sr)
    const spread = clamp(num(c.spread, 3.1), 1.2, 6)
    const top = this.ratios[N === 8 ? 7 : 12]
    const decay = clamp(num(c.decay, 1.8), 0.03, 300)
    const hiR = clamp(num(c.hiRatio, 0.65), 0.03, 1)
    const loR = clamp(num(c.bassRatio, 1), 0.3, 3)
    let sum = 0
    for (let i = 0; i < N; i++) {
      const r = 1 + ((this.ratios[i] - 1) * (spread - 1)) / (top - 1)
      let d = nearPrime(minD * r)
      // Keep every line distinct.
      for (let j = 0; j < i; j++) if (Math.round(this.dTgt[j]) === d) d = nearPrime(d + 2)
      d = clamp(d, 3, this.maxD)
      this.dTgt[i] = d
      if (this.first) {
        this.dCur[i] = d
        this.eff[i] = d
      }
      sum += d
    }
    this.meanD = sum / N
    // Modulation depth: never more than a quarter of the shortest line.
    const depth = clamp(num(c.mod, 0.3), 0, 1) * Math.min(0.0011 * sr, 0.22 * minD, this.modMax)
    this.depth = depth
    const rate = clamp(num(c.modRate, 0.6), 0.02, 8)
    for (let i = 0; i < N; i++) this.phInc[i] = (rate * this.rateMul[i] * CTRL) / sr
    // Decay gains and shelves.
    const freeze = num(c.freeze, 0) >= 0.5
    const hiHz = clamp(num(c.hiHz, 4500), 200, sr * 0.45)
    const bassHz = clamp(num(c.bassHz, 250), 20, hiHz * 0.5)
    this.GF = onePoleG(sr, hiHz)
    this.GB = onePoleG(sr, bassHz)
    // A first-order shelf leans on the octaves around its corner, so each
    // line's gain is divided by the two shelves' magnitude at the middle
    // reference frequency: the mid band then decays in exactly the asked
    // time. The loop stays below unity: |high shelf| <= 1 and
    // |low shelf| <= max(1, q), and the gain is capped by both.
    const fRef = Math.sqrt(hiHz * bassHz)
    const wRef = (2 * Math.PI * fRef) / sr
    const cw = Math.cos(wRef)
    const sw = Math.sin(wRef)
    const tf = Math.tan((Math.PI * hiHz) / sr)
    const tb = Math.tan((Math.PI * bassHz) / sr)
    const lf = this.lfRef
    const lb = this.lbRef
    lpAt(tf, cw, sw, lf)
    lpAt(tb, cw, sw, lb)
    let gsum = 0
    for (let i = 0; i < N; i++) {
      const d = this.dTgt[i]
      let gm = Math.pow(10, (-3 * d) / (sr * decay))
      let gh = Math.pow(10, (-3 * d) / (sr * decay * hiR))
      let gl = Math.pow(10, (-3 * d) / (sr * decay * loR))
      if (freeze) gm = gh = gl = 0.99995
      gm = Math.min(gm, 0.99995)
      gh = Math.min(gh, gm)
      gl = Math.min(gl, 0.99995)
      const r = gh / gm
      const q = gl / gm
      // |r + (1 - r) LPf| |1 + (q - 1) LPb| at the reference frequency.
      const hr = r + (1 - r) * lf[0]
      const hi = (1 - r) * lf[1]
      const br = 1 + (q - 1) * lb[0]
      const bi = (q - 1) * lb[1]
      const mag = Math.sqrt((hr * hr + hi * hi) * (br * br + bi * bi))
      let ge = freeze ? gm : gm / Math.max(0.5, mag)
      ge = Math.min(ge, 0.99995 / Math.max(1, q))
      this.g[i] = ge
      this.rHi[i] = r
      this.qLo[i] = q
      gsum += ge * ge
    }
    // Expected late energy for a unit send: (1 / N) sum over passes of g^2k.
    const g2 = Math.min(0.999999, gsum / N)
    const eLate = 1 / (N * (1 - g2))
    this.lateTgt = num(c.lateGain, 1) / Math.sqrt(eLate)
    if (freeze) this.lateTgt = num(c.lateGain, 1) * 0.25
    this.freeze = freeze
    this.earlyTgt = num(c.earlyGain, 1)
    const elp = num(c.earlyLp, 0)
    this.eLpG = elp > 0 && elp < 0.45 * sr ? onePoleG(sr, elp) : 0
    this.widthTgt = clamp(num(c.width, 1), 0, 1.5)
    // Predelay.
    this.preTgt = clamp((num(c.predelayMs, 0) / 1000) * sr, 0, this.P - 8)
    // Diffusers: lengths fixed on the first call (live changes would click).
    const dif = clamp(num(c.diffusion, 1), 0, 1)
    if (!this.apSet) {
      const sizeK = clamp(minD / ((0.012 * sr)), 0.15, 1)
      for (let k = 0; k < 4; k++) this.apLen[k] = clamp(Math.round((DIFF_MS[k] / 1000) * sr * sizeK), 1, this.apMax - 1)
      this.apSet = true
    }
    for (let k = 0; k < 4; k++) this.apG[k] = DIFF_G[k] * dif
    this.hpG = onePoleG(sr, clamp(num(c.sendHp, 90), 10, sr * 0.2))
    this.lpG = onePoleG(sr, clamp(num(c.sendLp, 12000), 200, sr * 0.49))
    // Shimmer.
    if (this.hasShimmer) {
      this.shAmt = clamp(num(c.shimmer, 0), 0, 1)
      this.shRA = clamp(num(c.shRatioA, 2), 0.25, 4)
      this.shRB = num(c.shRatioB, 0) > 0 ? clamp(num(c.shRatioB, 0), 0.25, 4) : 0
      this.shMixB = clamp(num(c.shMixB, 0.6), 0, 1)
      this.shLpG = onePoleG(sr, clamp(num(c.shLp, 7000), 500, sr * 0.45))
      this.shHpG = onePoleG(sr, 160)
      // Loop gain: the late output carries about lateGain^2 / 2 of energy for
      // a unit send (two decorrelated sides averaged), so a return of
      // 0.9 sqrt(2) / lateGain makes one trip round the loop lose at least
      // a fifth of its energy at full shimmer. The soft limit bounds the rest.
      const lgain = Math.max(0.05, num(c.lateGain, 1))
      const pair = this.shRB ? Math.sqrt(0.85 * 0.85 + this.shMixB * this.shMixB) : 1
      this.shNorm = (0.9 * Math.SQRT2) / (lgain * pair)
    }
    if (this.first) {
      this.lateCur = this.lateTgt
      this.earlyCur = this.earlyTgt
      this.widthCur = this.widthTgt
      this.preCur = this.preTgt
      this.shAmtCur = this.shAmt
      this.first = false
    }
  }

  /**
   * Early reflections: count taps at times (ms after the predelay) with left
   * and right gains. Arrays are read, not kept. Click-free (20 ms crossfade).
   */
  setTaps(count, ms, gl, gr) {
    const n = clamp(count | 0, 0, MAX_TAPS)
    if (this.tapsSet && this.xf > 0) {
      // A crossfade is running: this set follows when it ends, so the bank
      // fading in is never rewritten under the signal.
      for (let k = 0; k < n; k++) {
        this.pMs[k] = num(ms[k], 0)
        this.pL[k] = num(gl[k], 0)
        this.pR[k] = num(gr[k], 0)
      }
      this.pN = n
      this.pendTaps = true
      return
    }
    this._applyTaps(n, ms, gl, gr)
  }

  _applyTaps(n, ms, gl, gr) {
    const sr = this.sr
    const base = this.preTgt
    const b = this.bank
    if (this.tapsSet && this.tapN[b] === n) {
      // Nothing moved: keep the current bank.
      let same = true
      for (let k = 0; k < n && same; k++) {
        same =
          this.tapD[b][k] === clamp(Math.round(base + (num(ms[k], 0) / 1000) * sr), 0, this.P - 4) &&
          this.tapL[b][k] === num(gl[k], 0) &&
          this.tapR[b][k] === num(gr[k], 0)
      }
      if (same) return
    }
    const nb = this.tapsSet ? 1 - b : b
    for (let k = 0; k < n; k++) {
      this.tapD[nb][k] = clamp(Math.round(base + (num(ms[k], 0) / 1000) * sr), 0, this.P - 4)
      this.tapL[nb][k] = num(gl[k], 0)
      this.tapR[nb][k] = num(gr[k], 0)
    }
    this.tapN[nb] = n
    if (!this.tapsSet) {
      this.tapsSet = true
      this.xf = 0
    } else {
      this.bank = nb
      this.xf = this.xfLen
    }
  }

  reset() {
    this.lines.fill(0)
    this.pre.fill(0)
    for (let k = 0; k < 4; k++) this.apBuf[k].fill(0)
    this.sF.fill(0)
    this.sB.fill(0)
    this.hpS = this.lpS = 0
    this.eLpL = this.eLpR = 0
    for (let i = 0; i < this.N; i++) {
      this.dCur[i] = this.dTgt[i]
      this.eff[i] = this.dTgt[i]
      this.inc[i] = 0
    }
    this.preCur = this.preTgt
    this.lateCur = this.lateTgt
    this.earlyCur = this.earlyTgt
    this.widthCur = this.widthTgt
    this.xf = 0
    this.ctr = 0
    if (this.hasShimmer) {
      this.shBuf.fill(0)
      this.shLpS = this.shHpS = this.shPrev = 0
      this.shAmtCur = this.shAmt
    }
  }

  /** Control-rate update: slew lengths, advance modulation, set per-sample increments. */
  _control() {
    const N = this.N
    const k = 1 - Math.exp(-CTRL / (0.06 * this.sr))
    for (let i = 0; i < N; i++) {
      this.dCur[i] += (this.dTgt[i] - this.dCur[i]) * k
      let p = this.ph[i] + this.phInc[i]
      if (p >= 1) p -= 1
      this.ph[i] = p
      const target = this.dCur[i] + this.depth * Math.sin(2 * Math.PI * p)
      this.inc[i] = (target - this.eff[i]) / CTRL
    }
  }

  /**
   * Process n samples, reading ins from inOff and writing from outOff. inR
   * may equal inL (mono). Writes the wet signal to outL and outR (outR may
   * be null: then the two sides are averaged into outL). Each input sample
   * is read before its output is written, so outs may alias ins.
   */
  run(inL, inR, outL, outR, n, inOff = 0, outOff = 0) {
    const N = this.N
    const L = this.L
    const mask = this.mask
    const lines = this.lines
    const eff = this.eff
    const inc = this.inc
    const v = this.v
    const g = this.g
    const rHi = this.rHi
    const qLo = this.qLo
    const sF = this.sF
    const sB = this.sB
    const bIn = this.bIn
    const cL = this.cL
    const cR = this.cR
    const GF = this.GF
    const GB = this.GB
    const pre = this.pre
    const pmask = this.pmask
    const apBuf0 = this.apBuf[0], apBuf1 = this.apBuf[1], apBuf2 = this.apBuf[2], apBuf3 = this.apBuf[3]
    const apLen = this.apLen
    const apPos = this.apPos
    const apG0 = this.apG[0], apG1 = this.apG[1], apG2 = this.apG[2], apG3 = this.apG[3]
    const hpG = this.hpG
    const lpG = this.lpG
    const sm = this.smooth
    const freeze = this.freeze
    const sixteen = N === 16
    const sq = Math.SQRT1_2
    let w = this.w
    let pw = this.pw
    let hpS = this.hpS
    let lpS = this.lpS
    const shim = this.hasShimmer
    for (let t = 0; t < n; t++) {
      if (this.ctr === 0) this._control()
      this.ctr = (this.ctr + 1) % CTRL
      const j = inOff + t
      const o = outOff + t
      let xl = inL[j]
      let xr = inR ? inR[j] : xl
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      let x = (xl + xr) * 0.5
      if (freeze) x = 0
      // Send filters: high pass then low pass, one pole each.
      let tv = (x - hpS) * hpG
      let lp = tv + hpS
      hpS = lp + tv
      x -= lp
      tv = (x - lpS) * lpG
      lp = tv + lpS
      lpS = lp + tv
      x = lp
      if (hpS < TINY && hpS > -TINY) hpS = 0
      if (lpS < TINY && lpS > -TINY) lpS = 0
      pre[pw] = x
      // Early taps.
      let eL = 0
      let eR = 0
      {
        const b = this.bank
        const nT = this.tapN[b]
        const D = this.tapD[b]
        const TL = this.tapL[b]
        const TR = this.tapR[b]
        for (let k = 0; k < nT; k++) {
          const s = pre[(pw - D[k]) & pmask]
          eL += s * TL[k]
          eR += s * TR[k]
        }
        if (this.xf > 0) {
          const a = this.xf / this.xfLen
          const o = 1 - b
          const nO = this.tapN[o]
          const DO = this.tapD[o]
          const OL = this.tapL[o]
          const OR = this.tapR[o]
          let oL = 0
          let oR = 0
          for (let k = 0; k < nO; k++) {
            const s = pre[(pw - DO[k]) & pmask]
            oL += s * OL[k]
            oR += s * OR[k]
          }
          eL = eL * (1 - a) + oL * a
          eR = eR * (1 - a) + oR * a
          this.xf--
          if (this.xf === 0 && this.pendTaps) {
            this.pendTaps = false
            this._applyTaps(this.pN, this.pMs, this.pL, this.pR)
          }
        }
      }
      if (this.eLpG > 0) {
        let a = (eL - this.eLpL) * this.eLpG
        eL = a + this.eLpL
        this.eLpL = eL + a
        a = (eR - this.eLpR) * this.eLpG
        eR = a + this.eLpR
        this.eLpR = eR + a
        if (this.eLpL < TINY && this.eLpL > -TINY) this.eLpL = 0
        if (this.eLpR < TINY && this.eLpR > -TINY) this.eLpR = 0
      }
      // Predelayed send (linear interpolation, slewed).
      this.preCur += (this.preTgt - this.preCur) * sm
      const pd = this.preCur
      const pi = pd | 0
      const pf = pd - pi
      const s0 = pre[(pw - pi) & pmask]
      const s1 = pre[(pw - pi - 1) & pmask]
      let u = s0 + (s1 - s0) * pf
      pw = (pw + 1) & pmask
      // Shimmer return.
      if (shim) {
        this.shAmtCur += (this.shAmt - this.shAmtCur) * sm
        if (this.shAmtCur > 1e-4) u += this._shimmer() * this.shAmtCur
      }
      // Diffusers.
      {
        let p = apPos[0]
        let d = apBuf0[p]
        let ww = u + apG0 * d
        u = d - apG0 * ww
        apBuf0[p] = ww
        apPos[0] = p + 1 >= apLen[0] ? 0 : p + 1
        p = apPos[1]
        d = apBuf1[p]
        ww = u + apG1 * d
        u = d - apG1 * ww
        apBuf1[p] = ww
        apPos[1] = p + 1 >= apLen[1] ? 0 : p + 1
        p = apPos[2]
        d = apBuf2[p]
        ww = u + apG2 * d
        u = d - apG2 * ww
        apBuf2[p] = ww
        apPos[2] = p + 1 >= apLen[2] ? 0 : p + 1
        p = apPos[3]
        d = apBuf3[p]
        ww = u + apG3 * d
        u = d - apG3 * ww
        apBuf3[p] = ww
        apPos[3] = p + 1 >= apLen[3] ? 0 : p + 1
      }
      // Read every line (cubic Hermite), filter, sum the outputs.
      let oL = 0
      let oR = 0
      for (let i = 0; i < N; i++) {
        const D = (eff[i] += inc[i])
        const di = D | 0
        const f = D - di
        const base = i * L
        const q = w - di
        const y0 = lines[base + (q & mask)]
        const ym1 = lines[base + ((q + 1) & mask)]
        const y1 = lines[base + ((q - 1) & mask)]
        const y2 = lines[base + ((q - 2) & mask)]
        const c1 = 0.5 * (y1 - ym1)
        const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
        const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
        const s = ((c3 * f + c2) * f + c1) * f + y0
        oL += cL[i] * s
        oR += cR[i] * s
        // High shelf cut then low shelf lift, then the mid decay gain.
        let a = (s - sF[i]) * GF
        const lf = a + sF[i]
        let st = lf + a
        sF[i] = st < TINY && st > -TINY ? 0 : st
        const h = lf + rHi[i] * (s - lf)
        a = (h - sB[i]) * GB
        const lb = a + sB[i]
        st = lb + a
        sB[i] = st < TINY && st > -TINY ? 0 : st
        v[i] = g[i] * (h + (qLo[i] - 1) * lb)
      }
      // Lossless mixing matrix.
      if (sixteen) {
        for (let r = 0; r < 16; r += 4) {
          const m = (v[r] + v[r + 1] + v[r + 2] + v[r + 3]) * 0.5
          v[r] -= m
          v[r + 1] -= m
          v[r + 2] -= m
          v[r + 3] -= m
        }
        for (let c = 0; c < 4; c++) {
          const m = (v[c] + v[c + 4] + v[c + 8] + v[c + 12]) * 0.5
          v[c] -= m
          v[c + 4] -= m
          v[c + 8] -= m
          v[c + 12] -= m
        }
      } else {
        for (let r = 0; r < 8; r += 4) {
          const m = (v[r] + v[r + 1] + v[r + 2] + v[r + 3]) * 0.5
          v[r] -= m
          v[r + 1] -= m
          v[r + 2] -= m
          v[r + 3] -= m
        }
        for (let c = 0; c < 4; c++) {
          const a = v[c]
          const b = v[c + 4]
          v[c] = (a + b) * sq
          v[c + 4] = (a - b) * sq
        }
      }
      for (let i = 0; i < N; i++) {
        let y = v[i] + bIn[i] * u
        if (y < TINY && y > -TINY) y = 0
        else if (!(y < 1e6 && y > -1e6)) y = 0
        lines[i * L + w] = y
      }
      w = (w + 1) & mask
      // Output.
      this.lateCur += (this.lateTgt - this.lateCur) * sm
      this.earlyCur += (this.earlyTgt - this.earlyCur) * sm
      this.widthCur += (this.widthTgt - this.widthCur) * sm
      const lg = this.lateCur
      if (shim) this.shPrev = (oL + oR) * 0.5 * lg
      let wl = oL * lg + eL * this.earlyCur
      let wr = oR * lg + eR * this.earlyCur
      const mid = (wl + wr) * 0.5
      const side = (wl - wr) * 0.5 * this.widthCur
      wl = mid + side
      wr = mid - side
      if (outR) {
        outL[o] = wl
        outR[o] = wr
      } else {
        outL[o] = mid
      }
    }
    this.w = w
    this.pw = pw
    this.hpS = hpS
    this.lpS = lpS
  }

  /** One sample of the shimmer return, from the previous late output. */
  _shimmer() {
    const buf = this.shBuf
    const msk = this.shMask
    const W = this.shW
    let x = this.shPrev
    // Soft limit what goes round the loop (tanh-like, unity for small signals).
    x = x / (1 + Math.abs(x) * 0.5)
    buf[this.shPos] = x
    const pos = this.shPos
    this.shPos = (pos + 1) & msk
    let y = this._shiftTap(buf, msk, pos, W, this.shRA, 0)
    if (this.shRB > 0) y = y * 0.85 + this._shiftTap(buf, msk, pos, W, this.shRB, 1) * this.shMixB
    // Keep the climbing octaves from turning to whistles, and drop rumble.
    let a = (y - this.shLpS) * this.shLpG
    const lp = a + this.shLpS
    this.shLpS = lp + a
    y = lp
    a = (y - this.shHpS) * this.shHpG
    const hl = a + this.shHpS
    this.shHpS = hl + a
    y -= hl
    if (this.shLpS < TINY && this.shLpS > -TINY) this.shLpS = 0
    if (this.shHpS < TINY && this.shHpS > -TINY) this.shHpS = 0
    return y * this.shNorm
  }

  /** Two-tap granular shift of ratio r; which picks the phase state. */
  _shiftTap(buf, msk, pos, W, r, which) {
    const step = Math.abs(r - 1) / W
    let p = which === 0 ? this.shPhA : this.shPhB
    p += step
    if (p >= 1) p -= 1
    if (which === 0) this.shPhA = p
    else this.shPhB = p
    let out = 0
    for (let k = 0; k < 2; k++) {
      let q = p + k * 0.5
      if (q >= 1) q -= 1
      const d = (r > 1 ? 1 - q : q) * W + 2
      const di = d | 0
      const f = d - di
      const a = buf[(pos - di) & msk]
      const b = buf[(pos - di - 1) & msk]
      const wi = q * 1024
      const wk = wi | 0
      const win = this.shTab[wk] + (this.shTab[wk + 1 > 1024 ? 1024 : wk + 1] - this.shTab[wk]) * (wi - wk)
      out += (a + (b - a) * f) * win
    }
    return out
  }
}

// ---------------------------------------------------------------- shared live helpers

/**
 * An allocation-free biquad for live paths (RBJ "Audio EQ Cookbook"
 * coefficients, Direct Form I with float64 state, flushed below 1e-20).
 * setType(type, sr, freq, q, gainDb) recomputes in place.
 */
export class LiveBiquad {
  constructor() {
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    this.on = false
  }

  set(type, sr, freq, q = 0.707, gainDb = 0) {
    const f = clamp(num(freq, 1000), 1, sr * 0.4999)
    const Q = clamp(num(q, 0.707), 0.05, 400)
    const A = Math.pow(10, num(gainDb, 0) / 40)
    const w0 = (2 * Math.PI * f) / sr
    const cs = Math.cos(w0)
    const sn = Math.sin(w0)
    const al = sn / (2 * Q)
    let b0, b1, b2, a0, a1, a2
    if (type === 'lowpass') {
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
    } else if (type === 'highpass') {
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
    } else if (type === 'bandpass') {
      b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
    } else if (type === 'notch') {
      b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
    } else if (type === 'lowshelf') {
      const s2 = 2 * Math.sqrt(A) * al
      b0 = A * ((A + 1) - (A - 1) * cs + s2); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s2)
      a0 = (A + 1) + (A - 1) * cs + s2; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s2
    } else if (type === 'highshelf') {
      const s2 = 2 * Math.sqrt(A) * al
      b0 = A * ((A + 1) + (A - 1) * cs + s2); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s2)
      a0 = (A + 1) - (A - 1) * cs + s2; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s2
    } else {
      // peak
      b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
    this.on = true
    return this
  }

  off() {
    this.on = false
    return this
  }

  tick(x) {
    if (!this.on) return x
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y < TINY && y > -TINY ? 0 : y > 1e6 || y < -1e6 || y !== y ? 0 : y
    return this.y1
  }

  /** Power gain |H|^2 at hz (for level matching). */
  power(sr, hz) {
    if (!this.on) return 1
    const w = (2 * Math.PI * hz) / sr
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2
    const ni = -(this.b1 * s1 + this.b2 * s2)
    const dr = 1 + this.a1 * c1 + this.a2 * c2
    const di = -(this.a1 * s1 + this.a2 * s2)
    return (nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di)
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

/** Equal-power dry gain for a mix in percent. */
export function dryGain(mixPct) {
  const m = clamp(num(mixPct, 100), 0, 100) / 100
  return m >= 1 ? 0 : Math.cos((m * Math.PI) / 2)
}

/** Equal-power wet gain for a mix in percent. */
export function wetGain(mixPct) {
  const m = clamp(num(mixPct, 100), 0, 100) / 100
  return m <= 0 ? 0 : Math.sin((m * Math.PI) / 2)
}

/**
 * Run a live instance over a whole buffer plus `tailSec` of silence and return
 * a new stereo buffer (the offline render of every FDN-based module here).
 * The last fadeSec are faded with a raised cosine.
 */
export function renderLive(inst, input, tailSec, ctx, fadeSec = 0.05) {
  const sr = input.sr
  const inL = input.ch[0] || new Float32Array(0)
  const inR = input.ch.length > 1 ? input.ch[1] : inL
  const len = inL.length
  if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
  const tail = Math.max(0, Math.round(num(tailSec, 0) * sr))
  const total = len + tail
  const outL = new Float32Array(total)
  const outR = new Float32Array(total)
  const B = 4096
  const zero = new Float32Array(B)
  const viewsIn = [null, null]
  const viewsOut = [null, null]
  for (let s = 0; s < total; s += B) {
    const n = Math.min(B, total - s)
    if (s + n <= len) {
      viewsIn[0] = inL.subarray(s, s + n)
      viewsIn[1] = inR.subarray(s, s + n)
    } else if (s >= len) {
      viewsIn[0] = zero.subarray(0, n)
      viewsIn[1] = zero.subarray(0, n)
    } else {
      const a = new Float32Array(n)
      const b = new Float32Array(n)
      a.set(inL.subarray(s, len))
      b.set(inR.subarray(s, len))
      viewsIn[0] = a
      viewsIn[1] = b
    }
    viewsOut[0] = outL.subarray(s, s + n)
    viewsOut[1] = outR.subarray(s, s + n)
    inst.process(viewsIn, viewsOut, n)
    if (ctx) {
      if (typeof ctx.progress === 'function') ctx.progress(Math.min(1, (s + n) / total))
      if (typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
  }
  const fadeN = Math.min(total, tail > 0 ? Math.round(Math.min(fadeSec, tail / sr) * sr) : 0)
  for (let k = 0; k < fadeN; k++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * (k + 0.5)) / fadeN)
    outL[total - 1 - k] *= g
    outR[total - 1 - k] *= g
  }
  for (let i = 0; i < total; i++) {
    const a = outL[i]
    const b = outR[i]
    if (!(a > -1e9 && a < 1e9)) outL[i] = 0
    if (!(b > -1e9 && b < 1e9)) outR[i] = 0
  }
  return { sr, ch: [outL, outR] }
}

// ---------------------------------------------------------------- space.reverb

// Pseudo-random early pattern for the plain reverb: times in units of the
// shortest line (so they scale with size), gains, and sides.
const ER_T = [0.31, 0.47, 0.62, 0.83, 1.04, 1.21, 1.47, 1.66, 1.93, 2.2, 2.51, 2.86]
const ER_PAN = [-0.7, 0.6, -0.25, 0.85, -0.9, 0.35, 0.7, -0.5, 0.15, -0.8, 0.9, -0.3]

function sizeToMinMs(sizePct) {
  // 0 percent: a small room (3 ms shortest line); 50: a hall (12 ms); 100: a vast space (48 ms).
  return 12 * Math.pow(2, (clamp(sizePct, 0, 100) - 50) / 25)
}

/** Fill cfg and taps for the plain reverb from its resolved params. */
function reverbSetup(st, p) {
  const c = st.cfg
  const size = num(p.size, 50)
  const decay = num(p.decay, 1.8)
  const damp = clamp(num(p.damping, 40), 0, 100) / 100
  c.minDelayMs = sizeToMinMs(size)
  c.spread = 3.1
  c.decay = decay
  c.hiRatio = 1 / (1 + 2.6 * damp)
  c.hiHz = 9000 * Math.pow(0.28, damp)
  c.bassRatio = 1.12
  c.bassHz = 220
  c.mod = clamp(num(p.modulation, 30), 0, 100) / 100
  c.modRate = 0.35 + 0.5 * c.mod
  c.predelayMs = num(p.predelay, 15)
  c.diffusion = 1
  c.sendHp = 110
  c.sendLp = 15000 * Math.pow(0.5, damp)
  // Tail loudness rises gently with decay (square root), so long settings
  // sound long without burying the voice.
  c.lateGain = 0.85 * Math.pow(clamp(decay, 0.1, 30) / 1.8, 0.25)
  c.earlyGain = 1
  c.width = clamp(num(p.width, 1), 0, 1.5)
  st.fdn.configure(c)
  // Early reflections: energy about a third of the tail's, scaled with size.
  const minMs = c.minDelayMs
  let e = 0
  for (let k = 0; k < ER_T.length; k++) {
    const gk = Math.exp(-1.1 * ER_T[k])
    e += gk * gk
  }
  const er = Math.sqrt(0.32 / e) * c.lateGain
  for (let k = 0; k < ER_T.length; k++) {
    const gk = Math.exp(-1.1 * ER_T[k]) * er
    const pan = ER_PAN[k]
    st.tMs[k] = ER_T[k] * minMs * 1.4 + 1.5
    st.tL[k] = gk * Math.sqrt(0.5 * (1 - pan))
    st.tR[k] = gk * Math.sqrt(0.5 * (1 + pan))
  }
  st.fdn.setTaps(ER_T.length, st.tMs, st.tL, st.tR)
  st.dryT = dryGain(p.mix)
  st.wetT = wetGain(p.mix)
}

/**
 * The live mixing wrapper every module here uses: an engine with
 * run(inL, inR, wetL, wetR, n, inOff, outOff) fills preallocated wet scratch,
 * then dry and wet are blended with smoothed gains. Mono or stereo ins and
 * outs; outs may alias ins (each sample is read before it is written).
 */
export class MixInstance {
  constructor(sr, maxBlock = 2048) {
    this.sr = sr
    this.wl = new Float32Array(maxBlock)
    this.wr = new Float32Array(maxBlock)
    this.maxBlock = maxBlock
    this.dry = 1
    this.wet = 0
    this.dryT = 1
    this.wetT = 0
    this.sm = 1 - Math.exp(-1 / (0.02 * sr))
    this.inited = false
  }

  mixBlock(ins, outs, n, eng) {
    const inL = ins[0]
    const inR = ins.length > 1 && ins[1] ? ins[1] : inL
    const outL = outs[0]
    const outR = outs.length > 1 && outs[1] ? outs[1] : null
    if (!this.inited) {
      this.dry = this.dryT
      this.wet = this.wetT
      this.inited = true
    }
    const wl = this.wl
    const wr = this.wr
    const sm = this.sm
    let done = 0
    while (done < n) {
      const m = Math.min(this.maxBlock, n - done)
      eng.run(inL, inR, wl, wr, m, done, 0)
      for (let i = 0; i < m; i++) {
        const j = done + i
        this.dry += (this.dryT - this.dry) * sm
        this.wet += (this.wetT - this.wet) * sm
        let xl = inL[j]
        let xr = inR[j]
        if (!(xl > -1e9 && xl < 1e9)) xl = 0
        if (!(xr > -1e9 && xr < 1e9)) xr = 0
        const yl = xl * this.dry + wl[i] * this.wet
        const yr = xr * this.dry + wr[i] * this.wet
        if (outR) {
          outL[j] = yl
          outR[j] = yr
        } else outL[j] = (yl + yr) * 0.5
      }
      done += m
    }
  }
}

function makeReverbLive(sr, p, rng) {
  const fdn = new FdnEngine(sr, { lines: 16, maxLineMs: 160, maxPreMs: 520, rng: rng && rng.fork ? rng.fork('fdn') : rng })
  const st = {
    fdn,
    cfg: fdnConfig(),
    tMs: new Float64Array(16),
    tL: new Float64Array(16),
    tR: new Float64Array(16),
    dryT: 1,
    wetT: 0,
  }
  const mix = new MixInstance(sr)
  reverbSetup(st, p)
  mix.dryT = st.dryT
  mix.wetT = st.wetT
  return {
    process(ins, outs, n) {
      mix.mixBlock(ins, outs, n, fdn)
    },
    set(np) {
      reverbSetup(st, np)
      mix.dryT = st.dryT
      mix.wetT = st.wetT
    },
    reset() {
      fdn.reset()
      mix.inited = false
    },
  }
}

function reverbTail(p) {
  const decay = clamp(num(p.decay, 1.8), 0.2, 20)
  return Math.min(30, num(p.predelay, 15) / 1000 + decay * 1.12 + 0.15)
}

export default {
  id: 'space.reverb',
  name: 'Reverb',
  family: 'space',
  about: 'A smooth studio reverb you shape yourself: how big, how long, how dark, and how much.',
  params: [
    { id: 'size', name: 'Size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'decay', name: 'Decay time', type: 'number', min: 0.2, max: 20, step: 0.1, def: 1.8, unit: 'seconds', rand: [0.8, 4] },
    { id: 'damping', name: 'Darkness', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'predelay', name: 'Gap before the echo', type: 'number', min: 0, max: 250, step: 1, def: 15, unit: 'ms', rand: [0, 60] },
    { id: 'modulation', name: 'Swirl', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
    { id: 'width', name: 'Width', type: 'number', min: 0, max: 1.5, step: 0.05, def: 1, unit: 'x', rand: [0.7, 1.3] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [15, 45] },
  ],
  stereo: 'make',
  tail: (p) => reverbTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const inst = makeReverbLive(sr, p, ctx && ctx.rng)
    return renderLive(inst, input, reverbTail(p), ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return makeReverbLive(sr, p, rng)
    },
  },
}
