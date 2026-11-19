// test/fixtures.mjs - test signals with known ground truth (Node only).
//
// synthVoice is a small formant synthesiser in the tradition of Klatt 1980,
// "Software for a cascade/parallel formant synthesizer":
// - Source: Rosenberg 1971 glottal flow pulses ("Effect of glottal pulse
//   shape on the quality of natural vowels", his preferred trigonometric
//   shape: 40 percent rising, 16 percent falling, closed for the rest),
//   differentiated for lip radiation. Every cycle draws its own period
//   (jitter, default 0.5 percent) and amplitude (shimmer, default 4 percent),
//   and turbulent aspiration noise, gated by the glottal opening, adds
//   breathiness.
// - Tract: five Klatt cascade resonators (unity gain at 0 Hz) per vowel.
//   F1 to F3 are the averages of Hillenbrand, Getty, Clark and Wheeler 1995,
//   "Acoustic characteristics of American English vowels", for men or
//   women (chosen from the pitch); F4 and F5 are typical adult values.
//   Formants glide from the previous vowel over the first third of every
//   syllable (coarticulation). Resonators above 0.45 * sr are skipped, so
//   8 kHz works.
// - Prosody: phrases of three to five syllables (160 to 280 ms each) with
//   dips between syllables, pauses of 120 to 250 ms between phrases, a gentle
//   sinusoidal intonation (default +-2 percent when f0 is a number, so the
//   median pitch is still exactly f0), and noise-burst fricatives ("s", "sh",
//   "f", and an "h" that is noise through the vowel's own formants) before
//   some syllables.
// The return value is { sr, ch: [mono], meta } where meta carries the truth:
// meta.f0 (Hz per 5 ms hop, 0 where unvoiced), meta.voiced, meta.hop
// (samples), meta.formants (the table used) and meta.segments (seconds).
//
// The other fixtures are the classic test signals: impulse, silence, sine,
// chirp, and coloured noise, plus loadWav for real recordings (through
// core/wav.js when that file exists, otherwise a small local reader).

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { makeRng } from '../core/rng.js'
import { white, pink, brown, velvet } from '../core/noise.js'

// Hillenbrand et al. 1995 (F1, F2, F3), plus typical F4, F5. Hz.
const FORMANTS = {
  male: {
    a: [768, 1333, 2522, 3500, 4500],
    i: [342, 2322, 3000, 3700, 4500],
    u: [378, 997, 2343, 3400, 4400],
    e: [476, 2089, 2691, 3550, 4500],
    o: [497, 910, 2459, 3400, 4400],
  },
  female: {
    a: [936, 1551, 2815, 4100, 4950],
    i: [437, 2761, 3372, 4300, 5000],
    u: [459, 1105, 2735, 4000, 4900],
    e: [536, 2530, 3047, 4200, 5000],
    o: [555, 1035, 2828, 4000, 4900],
  },
}
const BANDWIDTHS = {
  male: [60, 90, 120, 180, 250],
  female: [70, 100, 130, 200, 280],
}

const FRIC = {
  s: { center: 5500, q: 1.8, level: 0.5 },
  sh: { center: 3000, q: 2.2, level: 0.45 },
  f: { center: 4000, q: 0.5, level: 0.18 },
  h: { center: 0, q: 0, level: 0.25 }, // through the tract
}
const FRIC_KINDS = ['s', 'sh', 'f', 'h']

function smooth01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

// Second-order bandpass (RBJ constant-peak) used only for fricative colour.
function bandpass(sig, sr, center, q) {
  const f = Math.min(center, sr * 0.42)
  const w0 = (2 * Math.PI * f) / sr
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0
  const b2 = -alpha / a0
  const a1 = (-2 * Math.cos(w0)) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    sig[i] = y
  }
  return sig
}

/**
 * A synthetic talker with known pitch and formants.
 * @param {number} sr
 * @param {number} seconds
 * @param {{ f0?: number|((t:number)=>number), vowels?: string[], breathiness?: number,
 *   fricatives?: boolean, seed?: number|string, formantScale?: number, jitter?: number,
 *   shimmer?: number, intonation?: number, sex?: 'auto'|'male'|'female' }} opts
 */
export function synthVoice(sr = 48000, seconds = 3, opts = {}) {
  const {
    f0 = 140,
    vowels = ['a', 'i', 'u', 'e', 'o'],
    breathiness = 0.05,
    fricatives = true,
    seed = 1,
    formantScale = 1,
    jitter = 0.005,
    shimmer = 0.04,
    sex = 'auto',
  } = opts
  const intonation = opts.intonation !== undefined ? opts.intonation : typeof f0 === 'number' ? 0.02 : 0
  const rng = makeRng(seed)
  const n = Math.max(0, Math.round(seconds * sr))
  const f0fn = typeof f0 === 'function' ? f0 : () => f0
  // pick the table from the typical pitch
  let typical = 0
  for (let k = 0; k < 8; k++) typical += f0fn((seconds * (k + 0.5)) / 8) / 8
  const who = sex === 'male' || sex === 'female' ? sex : typical > 165 ? 'female' : 'male'
  const table = FORMANTS[who]
  const bws = BANDWIDTHS[who]
  const vlist = vowels.filter((v) => table[v])
  if (!vlist.length) vlist.push('a')

  // ---- timeline ----
  const segs = [] // { kind, start, end, vowel, fric, first, last }
  let t = 0.06
  const endT = seconds - 0.05
  let vi = 0
  const fricRng = rng.fork('fric')
  while (t < endT - 0.15) {
    const nSyl = 3 + rng.int(3)
    for (let s = 0; s < nSyl && t < endT - 0.12; s++) {
      if (fricatives && fricRng.next() < 0.35) {
        const d = 0.06 + 0.06 * fricRng.next()
        segs.push({ kind: 'fric', start: t, end: t + d, fric: FRIC_KINDS[fricRng.int(FRIC_KINDS.length)] })
        t += d
      }
      const d = Math.min(0.16 + 0.12 * rng.next(), endT - t)
      if (d < 0.05) break
      segs.push({ kind: 'vowel', start: t, end: t + d, vowel: vlist[vi % vlist.length], first: s === 0, last: s === nSyl - 1 })
      vi++
      t += d
    }
    // mark phrase end, then a pause
    for (let k = segs.length - 1; k >= 0; k--) {
      if (segs[k].kind === 'vowel') {
        segs[k].last = true
        break
      }
    }
    t += 0.12 + 0.13 * rng.next()
  }
  // a vowel right after a fricative or pause starts a fresh attack
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]
    if (s.kind !== 'vowel') continue
    const p = segs[k - 1]
    if (!p || p.kind !== 'vowel' || p.end < s.start - 1e-9) s.first = true
  }

  // ---- control signals ----
  const vAmp = new Float32Array(n)
  const nAmp = new Float32Array(n) // fricative noise (outside the tract)
  const hAmp = new Float32Array(n) // aspiration "h" (through the tract)
  const fricSig = new Float32Array(n)
  const nrng = rng.fork('noise')
  for (const s of segs) {
    const i0 = Math.max(0, Math.round(s.start * sr))
    const i1 = Math.min(n, Math.round(s.end * sr))
    const D = Math.max(1, i1 - i0)
    if (s.kind === 'vowel') {
      const att = Math.round((s.first ? 0.03 : 0.015) * sr)
      const rel = Math.round((s.last ? 0.05 : 0.02) * sr)
      const a0 = s.first ? 0 : 0.3
      const a1 = s.last ? 0 : 0.3
      for (let i = i0; i < i1; i++) {
        const k = i - i0
        let a = 1 - 0.2 * (k / D)
        if (k < att) a = a0 + (a - a0) * (0.5 - 0.5 * Math.cos((Math.PI * k) / att))
        const kr = i1 - 1 - i
        if (kr < rel) a = a1 + (a - a1) * (0.5 - 0.5 * Math.cos((Math.PI * kr) / rel))
        vAmp[i] = a
      }
    } else {
      const spec = FRIC[s.fric]
      const att = Math.max(1, Math.round(0.015 * sr))
      const rel = Math.max(1, Math.round(0.025 * sr))
      const burst = white(D, nrng)
      if (spec.center > 0) bandpass(burst, sr, spec.center, spec.q)
      for (let i = i0; i < i1; i++) {
        const k = i - i0
        let a = spec.level
        if (k < att) a *= 0.5 - 0.5 * Math.cos((Math.PI * k) / att)
        const kr = i1 - 1 - i
        if (kr < rel) a *= 0.5 - 0.5 * Math.cos((Math.PI * kr) / rel)
        if (spec.center > 0) {
          nAmp[i] = a
          fricSig[i] = burst[k] * a
        } else {
          hAmp[i] = a
        }
      }
    }
  }
  // de-click the voicing envelope (5 ms one-pole, forward)
  {
    const c = Math.exp(-1 / (0.005 * sr))
    let y = 0
    for (let i = 0; i < n; i++) {
      y = c * y + (1 - c) * vAmp[i]
      vAmp[i] = y
    }
  }

  // ---- source and tract ----
  const out = new Float32Array(n)
  const hopT = Math.max(1, Math.round(0.005 * sr))
  const nh = Math.ceil(n / hopT)
  const truthF0 = new Float32Array(nh)
  const voiced = new Uint8Array(nh)
  const jr = rng.fork('jitter')
  const ar = rng.fork('aspiration')
  const intPhase = rng.next() * 2 * Math.PI
  const nyq = 0.45 * sr
  // formant state
  const y1 = new Float64Array(5)
  const y2 = new Float64Array(5)
  const cA = new Float64Array(5)
  const cB = new Float64Array(5)
  const cC = new Float64Array(5)
  const on = new Uint8Array(5)
  const cur = new Float64Array(5)
  const BLOCK = 32
  let segIdx = 0
  let prevVowel = vlist[0]
  let lastVowelSeg = null
  let phase = 0.999
  let perMul = 1
  let ampMul = 1
  let gPrev = 0
  const srcScale = sr / 1500
  for (let b0 = 0; b0 < n; b0 += BLOCK) {
    const tb = (b0 + BLOCK / 2) / sr
    while (segIdx < segs.length && segs[segIdx].end <= tb) {
      if (segs[segIdx].kind === 'vowel') {
        prevVowel = segs[segIdx].vowel
        lastVowelSeg = segs[segIdx]
      }
      segIdx++
    }
    // formant targets for this block
    let target = table[prevVowel]
    let fromV = table[prevVowel]
    let mixT = 1
    const s = segs[segIdx]
    if (s && s.kind === 'vowel' && s.start <= tb) {
      target = table[s.vowel]
      fromV = lastVowelSeg ? table[lastVowelSeg.vowel] : target
      mixT = smooth01((tb - s.start) / Math.max(1e-3, (s.end - s.start) / 3))
    }
    for (let k = 0; k < 5; k++) {
      const F = (fromV[k] + (target[k] - fromV[k]) * mixT) * formantScale
      cur[k] = F
      if (F >= nyq) {
        on[k] = 0
        continue
      }
      on[k] = 1
      const bw = bws[k] * Math.max(0.6, Math.min(2, formantScale))
      const C = -Math.exp((-2 * Math.PI * bw) / sr)
      const B = 2 * Math.exp((-Math.PI * bw) / sr) * Math.cos((2 * Math.PI * F) / sr)
      cA[k] = 1 - B - C
      cB[k] = B
      cC[k] = C
    }
    const bEnd = Math.min(n, b0 + BLOCK)
    for (let i = b0; i < bEnd; i++) {
      const ti = i / sr
      let f = f0fn(ti)
      if (!(f > 20)) f = 20
      if (f > sr * 0.2) f = sr * 0.2
      f *= 1 + intonation * Math.sin(2 * Math.PI * 0.6 * ti + intPhase)
      if (i % hopT === 0) {
        const h = (i / hopT) | 0
        const isV = vAmp[i] > 0.05
        voiced[h] = isV ? 1 : 0
        truthF0[h] = isV ? f : 0
      }
      phase += f / sr / perMul
      if (phase >= 1) {
        phase -= Math.floor(phase)
        let jg = jr.gauss()
        if (jg > 3) jg = 3
        if (jg < -3) jg = -3
        perMul = 1 + jitter * jg
        let sg = jr.gauss()
        if (sg > 3) sg = 3
        if (sg < -3) sg = -3
        ampMul = 1 + shimmer * sg
      }
      // Rosenberg glottal flow
      let g
      if (phase < 0.4) g = 0.5 - 0.5 * Math.cos((Math.PI * phase) / 0.4)
      else if (phase < 0.56) g = Math.cos((Math.PI * (phase - 0.4)) / 0.32)
      else g = 0
      const dg = (g - gPrev) * srcScale
      gPrev = g
      const va = vAmp[i] * ampMul
      const asp = (ar.next() * 2 - 1) * (0.25 + g) * breathiness * 0.6
      let x = va * (dg + asp) + hAmp[i] * (ar.next() * 2 - 1) * 0.5
      for (let k = 0; k < 5; k++) {
        if (!on[k]) continue
        const y = cA[k] * x + cB[k] * y1[k] + cC[k] * y2[k]
        y2[k] = y1[k]
        y1[k] = y + 1e-30 - 1e-30
        x = y
      }
      out[i] = x + fricSig[i]
    }
  }
  // normalise to a -6 dBFS peak
  let pk = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i])
    if (a > pk) pk = a
  }
  if (pk > 0) {
    const g = 0.5 / pk
    for (let i = 0; i < n; i++) out[i] *= g
  }
  const formants = {}
  for (const v of vlist) formants[v] = table[v].map((F) => F * formantScale)
  return {
    sr,
    ch: [out],
    meta: {
      hop: hopT,
      f0: truthF0,
      voiced,
      formants,
      sex: who,
      segments: segs.map((s) => ({ ...s })),
    },
  }
}

/** One full-scale sample at `at` seconds (default the first sample). */
export function impulse(sr, seconds, at = 0, amp = 1) {
  const n = Math.max(1, Math.round(seconds * sr))
  const s = new Float32Array(n)
  const i = Math.min(n - 1, Math.max(0, Math.round(at * sr)))
  s[i] = amp
  return { sr, ch: [s] }
}

export function silence(sr, seconds, nch = 1) {
  const n = Math.max(0, Math.round(seconds * sr))
  const ch = []
  for (let c = 0; c < nch; c++) ch.push(new Float32Array(n))
  return { sr, ch }
}

export function sine(sr, seconds, hz = 440, amp = 0.5, phase = 0) {
  const n = Math.max(0, Math.round(seconds * sr))
  const s = new Float32Array(n)
  const w = (2 * Math.PI * hz) / sr
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin(w * i + phase)
  return { sr, ch: [s] }
}

/** Sweep from f0 to f1 Hz, logarithmic (default) or linear. */
export function chirp(sr, seconds, f0 = 50, f1 = Math.min(16000, 0.45 * sr), amp = 0.5, mode = 'log') {
  const n = Math.max(0, Math.round(seconds * sr))
  const s = new Float32Array(n)
  const T = Math.max(1e-9, seconds)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = mode === 'lin' ? f0 + ((f1 - f0) * t) / T : f0 * Math.pow(f1 / f0, t / T)
    s[i] = amp * Math.sin(ph)
    ph += (2 * Math.PI * f) / sr
    if (ph > 1e6) ph -= 2 * Math.PI * Math.floor(ph / (2 * Math.PI))
  }
  return { sr, ch: [s] }
}

/** Noise buffer: color 'white' | 'pink' | 'brown' | 'velvet'. */
export function noiseBuf(sr, seconds, color = 'white', seed = 1, nch = 1, amp = 1) {
  const n = Math.max(0, Math.round(seconds * sr))
  const rng = makeRng(seed)
  const ch = []
  for (let c = 0; c < nch; c++) {
    const r = rng.fork('ch' + c)
    let s
    if (color === 'pink') s = pink(n, r)
    else if (color === 'brown') s = brown(n, r)
    else if (color === 'velvet') s = velvet(n, sr, 2000, r)
    else s = white(n, r)
    if (amp !== 1) for (let i = 0; i < n; i++) s[i] *= amp
    ch.push(s)
  }
  return { sr, ch }
}

// ---------- WAV ----------

function localDecodeWav(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= u8.length) {
    const id = tag(off)
    const size = dv.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true)
      const nch = dv.getUint16(body + 2, true)
      const sr = dv.getUint32(body + 4, true)
      const bits = dv.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true)
      fmt = { format, nch, sr, bits }
    } else if (id === 'data') {
      data = { off: body, size: Math.min(size, u8.length - body) }
    }
    off = body + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('WAV file has no fmt or data chunk')
  const { format, nch, sr, bits } = fmt
  const bps = bits / 8
  const frames = Math.floor(data.size / (bps * nch))
  const ch = []
  for (let c = 0; c < nch; c++) ch.push(new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const p = data.off + (i * nch + c) * bps
      let v
      if (format === 3) v = bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true)
      else if (bits === 8) v = (u8[p] - 128) / 128
      else if (bits === 16) v = dv.getInt16(p, true) / 32768
      else if (bits === 24) v = (((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) << 8) >> 8) / 8388608
      else if (bits === 32) v = dv.getInt32(p, true) / 2147483648
      else throw new Error('Unsupported WAV bit depth ' + bits)
      ch[c][i] = Number.isFinite(v) ? v : 0
    }
  }
  return { sr, ch }
}

let wavDecoder = null

function decoder() {
  if (wavDecoder) return wavDecoder
  const wavPath = fileURLToPath(new URL('../core/wav.js', import.meta.url))
  if (existsSync(wavPath)) {
    try {
      const require = createRequire(import.meta.url)
      const m = require(wavPath)
      if (m && typeof m.decodeWav === 'function') wavDecoder = m.decodeWav
    } catch {
      wavDecoder = null
    }
  }
  if (!wavDecoder) wavDecoder = localDecodeWav
  return wavDecoder
}

/** Read a WAV file into { sr, ch } (synchronous). */
export function loadWav(path) {
  const u8 = new Uint8Array(readFileSync(path))
  return decoder()(u8)
}

export { localDecodeWav }
