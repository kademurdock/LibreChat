// modules/lofi/_chips.js - sample coders of real hardware (not a module).
//
// This file has no default export (registry builders skip names that start
// with an underscore). Every coder here follows a published specification or
// published hardware documentation, so the artefacts are the real ones and
// not a generic bit reduction:
//
// - G.711 (ITU-T Recommendation G.711, 1972/1988): the 8-bit segmented
//   mu-law and A-law codes of digital telephone lines. Encoding and decoding
//   follow the segment structure of the standard exactly (as in the widely
//   published public-domain reference implementation from Sun Microsystems):
//   mu-law works on a 14-bit magnitude with a bias of 33 and eight segments
//   of sixteen steps, A-law on a 13-bit magnitude with eight segments where
//   the first two share one step size. Optionally the four mantissa bits can
//   be cut down (bits < 8) for a deliberately worse line.
// - IMA ADPCM (Interactive Multimedia Association, "Recommended Practices for
//   Enhancing Digital Audio Compatibility in Multimedia Systems", 1992; the
//   DVI algorithm): a 4-bit code per sample, an 89-entry step table and the
//   index adaptation table {-1,-1,-1,-1,2,4,6,8}. The 2, 3 and 5-bit
//   variants use the same step table with the index tables published in the
//   SWF file format specification's ADPCM sound section.
// - OKI / Dialogic ADPCM (Dialogic Corporation, "Dialogic ADPCM Algorithm",
//   application note 00-1366-001, 1988; the coding of the MSM5205 family of
//   arcade and answering-machine voice chips): the same structure on a
//   12-bit predictor with a 49-entry step table from 16 to 1552.
// - BRR (the 16-bit console's "bit rate reduction" sample format, documented
//   in the public hardware references by anomie and in Martin Korth's
//   "fullsnes"; decoding below follows the integer arithmetic of blargg's
//   documented sound-processor emulation): blocks of sixteen 4-bit samples
//   with one header byte holding a shift (0..12) and one of four fixed
//   prediction filters (none, 15/16, 61/32 - 15/16, 115/64 - 13/16). The
//   decoder clamps to 16 bits and then doubles with a 16-bit wrap, exactly
//   as the hardware does. The encoder is closed-loop and exhaustive (every
//   shift and filter is tried per block against the exact decoder, the way
//   the developer tools of the time and today's converters do it).
// - The 16-bit console's playback interpolation: four-point Gaussian
//   interpolation on a 256-phase table. The real chip's table is a 512-entry
//   ROM; here the weights come from a Gaussian bell fitted to the published
//   table (centre weight about 0.63, neighbours about 0.18 at whole-sample
//   positions, zero two samples out), quantised to 11-bit integers like the
//   ROM. Its response is the chip's: about 11 dB down at the sample rate's
//   Nyquist frequency, the famous soft, muffled sound.
// - DPCM of the 8-bit console's sample channel (nesdev wiki, "APU DMC" and
//   "APU Mixer"): a 7-bit counter that steps up or down by two for each
//   1-bit sample, at one of sixteen fixed rates (the fastest about
//   33.1 kHz), mixed through the console's non-linear resistor-network DAC,
//   159.79 / (22638 / dmc + 100), and the console's output filters (first-
//   order high passes at 90 Hz and 440 Hz, a first-order low pass at 14 kHz).

// ---------------------------------------------------------------- G.711

/** mu-law code (0..255) of a 16-bit linear sample. */
export function muEncode(pcm) {
  let v = pcm >> 2
  let mask
  if (v < 0) {
    v = -v
    mask = 0x7f
  } else {
    mask = 0xff
  }
  if (v > 8159) v = 8159
  v += 33
  let seg = 0
  for (let t = v >> 6; t; t >>= 1) seg++
  if (seg >= 8) return 0x7f ^ mask
  return ((seg << 4) | ((v >> (seg + 1)) & 0x0f)) ^ mask
}

/** 16-bit linear value of a mu-law code. */
export function muDecode(code) {
  const u = ~code & 0xff
  let t = ((u & 0x0f) << 3) + 132
  t <<= (u & 0x70) >> 4
  return u & 0x80 ? 132 - t : t - 132
}

/** A-law code (0..255) of a 16-bit linear sample. */
export function aEncode(pcm) {
  let v = pcm >> 3
  let mask
  if (v >= 0) {
    mask = 0xd5
  } else {
    mask = 0x55
    v = -v - 1
  }
  let seg = 0
  for (let t = v >> 5; t; t >>= 1) seg++
  if (seg >= 8) return 0x7f ^ mask
  let aval = seg << 4
  aval |= (seg < 2 ? v >> 1 : v >> seg) & 0x0f
  return aval ^ mask
}

/** 16-bit linear value of an A-law code. */
export function aDecode(code) {
  const a = (code ^ 0x55) & 0xff
  let t = (a & 0x0f) << 4
  const seg = (a & 0x70) >> 4
  if (seg === 0) t += 8
  else if (seg === 1) t += 0x108
  else {
    t += 0x108
    t <<= seg - 1
  }
  return a & 0x80 ? t : -t
}

/**
 * Keep only (bits - 4) of the four mantissa bits of a G.711 code (bits 4..8),
 * putting the code in the middle of its coarser cell. bits 8 is untouched.
 */
export function coarsenG711(code, bits, isA) {
  const k = 8 - Math.max(4, Math.min(8, bits | 0))
  if (k <= 0) return code
  const x = isA ? 0x55 : 0x7f
  const r = code ^ x
  let m = r & 0x0f
  m = ((m >> k) << k) | (1 << (k - 1))
  return ((r & 0xf0) | m) ^ x
}

/**
 * G.711 round trip of a whole signal in place. sig is float -1..1; law 'mu'
 * or 'a'; bits 4..8 (8 = the standard). Returns sig.
 */
export function g711RoundTrip(sig, law, bits = 8) {
  const isA = law === 'a'
  const n = sig.length
  for (let i = 0; i < n; i++) {
    let v = Math.round(sig[i] * 32768)
    if (!(v >= -32768)) v = -32768
    if (v > 32767) v = 32767
    let code = isA ? aEncode(v) : muEncode(v)
    if (bits < 8) code = coarsenG711(code, bits, isA)
    sig[i] = (isA ? aDecode(code) : muDecode(code)) / 32768
  }
  return sig
}

// ---------------------------------------------------------------- ADPCM

export const IMA_STEPS = Int32Array.of(
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
)

export const OKI_STEPS = Int32Array.of(
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88,
  97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
  408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552,
)

export const ADPCM_INDEX = {
  2: Int8Array.of(-1, 2),
  3: Int8Array.of(-1, -1, 2, 4),
  4: Int8Array.of(-1, -1, -1, -1, 2, 4, 6, 8),
  5: Int8Array.of(-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16),
}

/**
 * Closed-loop ADPCM coding. target: integer-domain samples (rounded and
 * clamped to lo..hi here). Writes the decoder's output into dec and the
 * codes into codes (optional). bits 2..5. chip: 'ima' (16-bit, 89 steps) or
 * 'oki' (12-bit, 49 steps).
 */
export function adpcmCode(target, dec, bits = 4, chip = 'ima', codes = null) {
  const b = Math.max(2, Math.min(5, bits | 0))
  const oki = chip === 'oki'
  const steps = oki ? OKI_STEPS : IMA_STEPS
  const lo = oki ? -2048 : -32768
  const hi = oki ? 2047 : 32767
  const tab = ADPCM_INDEX[b]
  const mb = b - 1
  const signBit = 1 << mb
  const magMask = signBit - 1
  const maxIdx = steps.length - 1
  let pred = 0
  let idx = 0
  const n = target.length
  for (let i = 0; i < n; i++) {
    let s = Math.round(target[i])
    if (!(s >= lo)) s = lo
    if (s > hi) s = hi
    let diff = s - pred
    let code = 0
    if (diff < 0) {
      code = signBit
      diff = -diff
    }
    let step = steps[idx]
    let vp = step >> mb
    for (let bit = signBit >> 1; bit; bit >>= 1) {
      if (diff >= step) {
        code |= bit
        diff -= step
        vp += step
      }
      step >>= 1
    }
    pred += code & signBit ? -vp : vp
    if (pred > hi) pred = hi
    else if (pred < lo) pred = lo
    idx += tab[code & magMask]
    if (idx < 0) idx = 0
    else if (idx > maxIdx) idx = maxIdx
    dec[i] = pred
    if (codes) codes[i] = code
  }
  return dec
}

// ---------------------------------------------------------------- BRR

/** One BRR sample through the hardware decoder. p1 = previous output, p2 = the one before. */
export function brrSample(nib, shift, filter, p1, p2) {
  let s = (nib << shift) >> 1
  if (shift >= 13) s = nib < 0 ? -2048 : 0
  const p2h = p2 >> 1
  if (filter === 1) {
    s += p1 >> 1
    s += -p1 >> 5
  } else if (filter === 2) {
    s += p1
    s -= p2h
    s += p2h >> 4
    s += (p1 * -3) >> 6
  } else if (filter === 3) {
    s += p1
    s -= p2h
    s += (p1 * -13) >> 7
    s += (p2h * 3) >> 4
  }
  if (s > 32767) s = 32767
  else if (s < -32768) s = -32768
  return ((s * 2) << 16) >> 16
}

/** The filter part of the prediction (what the decoder adds before the nibble), half scale. */
function brrPred(filter, p1, p2) {
  const p2h = p2 >> 1
  if (filter === 1) return (p1 >> 1) + (-p1 >> 5)
  if (filter === 2) return p1 - p2h + (p2h >> 4) + ((p1 * -3) >> 6)
  if (filter === 3) return p1 - p2h + ((p1 * -13) >> 7) + ((p2h * 3) >> 4)
  return 0
}

/**
 * Encode target (stored-value domain, about -32767..32767) into BRR blocks
 * and return the exact decoded stream. The output is padded to whole blocks.
 * Returns { dec: Int32Array, headers: Uint8Array, nibbles: Int8Array }.
 */
export function brrEncode(target) {
  const n = target.length
  const blocks = Math.ceil(n / 16)
  const len = blocks * 16
  const dec = new Int32Array(len)
  const headers = new Uint8Array(blocks)
  const nibbles = new Int8Array(len)
  const t = new Float64Array(16)
  const bestNib = new Int8Array(16)
  const tryNib = new Int8Array(16)
  let P1 = 0
  let P2 = 0
  for (let b = 0; b < blocks; b++) {
    const o = b * 16
    for (let i = 0; i < 16; i++) {
      const v = o + i < n ? target[o + i] : 0
      t[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v === v ? v : 0
    }
    let bestErr = Infinity
    let bestF = 0
    let bestS = 0
    const fMax = b === 0 ? 0 : 3
    for (let f = 0; f <= fMax; f++) {
      for (let sh = 0; sh <= 12; sh++) {
        let p1 = P1
        let p2 = P2
        let err = 0
        const unit = sh === 0 ? 0.5 : 1 << (sh - 1)
        for (let i = 0; i < 16 && err < bestErr; i++) {
          const want = t[i]
          const pr = brrPred(f, p1, p2)
          let k0 = Math.round((want * 0.5 - pr) / unit)
          if (k0 > 7) k0 = 7
          else if (k0 < -8) k0 = -8
          let bestK = k0
          let bestV = brrSample(k0, sh, f, p1, p2)
          let bestE = (bestV - want) * (bestV - want)
          for (let d = -1; d <= 1; d += 2) {
            const k = k0 + d
            if (k > 7 || k < -8) continue
            const v = brrSample(k, sh, f, p1, p2)
            const e = (v - want) * (v - want)
            if (e < bestE) {
              bestE = e
              bestK = k
              bestV = v
            }
          }
          tryNib[i] = bestK
          err += bestE
          p2 = p1
          p1 = bestV
        }
        if (err < bestErr) {
          bestErr = err
          bestF = f
          bestS = sh
          bestNib.set(tryNib)
        }
      }
    }
    headers[b] = (bestS << 4) | (bestF << 2)
    let p1 = P1
    let p2 = P2
    for (let i = 0; i < 16; i++) {
      const v = brrSample(bestNib[i], bestS, bestF, p1, p2)
      nibbles[o + i] = bestNib[i]
      dec[o + i] = v
      p2 = p1
      p1 = v
    }
    P1 = p1
    P2 = p2
  }
  return { dec, headers, nibbles }
}

/** Decode BRR blocks (headers, nibbles) with the hardware arithmetic. */
export function brrDecode(headers, nibbles) {
  const out = new Int32Array(nibbles.length)
  let p1 = 0
  let p2 = 0
  for (let b = 0; b < headers.length; b++) {
    const sh = headers[b] >> 4
    const f = (headers[b] >> 2) & 3
    for (let i = 0; i < 16; i++) {
      const j = b * 16 + i
      if (j >= nibbles.length) break
      const v = brrSample(nibbles[j], sh, f, p1, p2)
      out[j] = v
      p2 = p1
      p1 = v
    }
  }
  return out
}

// Gaussian interpolation weights, 256 phases x 4 taps (11-bit integers).
export const GAUSS = (() => {
  const a = 1.232 // bell width fitted to the published table's whole-sample weights
  const tail = Math.exp(-4 * a)
  const g = (d) => Math.max(0, Math.exp(-a * d * d) - tail)
  const w = new Int32Array(256 * 4)
  for (let p = 0; p < 256; p++) {
    const f = p / 256
    const r0 = g(1 + f)
    const r1 = g(f)
    const r2 = g(1 - f)
    const r3 = g(2 - f)
    const s = r0 + r1 + r2 + r3
    w[p * 4] = Math.round((2048 * r0) / s)
    w[p * 4 + 1] = Math.round((2048 * r1) / s)
    w[p * 4 + 2] = Math.round((2048 * r2) / s)
    w[p * 4 + 3] = Math.round((2048 * r3) / s)
  }
  return w
})()

/**
 * Play a decoded BRR stream (rate R) on the sound processor's 32 kHz output
 * clock with Gaussian interpolation and the 14-bit pitch counter.
 * Returns Float64Array of 16-bit-domain samples, outLen long.
 */
export function gaussPlay(dec, R, outLen) {
  const out = new Float64Array(outLen)
  const pitch = Math.max(1, Math.min(0x3fff, Math.round((4096 * R) / 32000)))
  const m = dec.length
  let counter = 0
  for (let j = 0; j < outLen; j++) {
    const c = counter >> 12
    const ph = (counter >> 4) & 0xff
    const s0 = c - 1 >= 0 && c - 1 < m ? dec[c - 1] : 0
    const s1 = c < m ? dec[c] : 0
    const s2 = c + 1 < m ? dec[c + 1] : 0
    const s3 = c + 2 < m ? dec[c + 2] : 0
    const o = ph * 4
    let v = (GAUSS[o] * s0 + GAUSS[o + 1] * s1 + GAUSS[o + 2] * s2 + GAUSS[o + 3] * s3) >> 11
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    out[j] = v
    counter += pitch
  }
  return out
}

// The 8-bit console's sample channel ---------------------------------------

/** The sample-channel rates of the 8-bit console (NTSC), Hz, index 0..15. */
export const DMC_RATES = [4181.71, 4709.93, 5264.04, 5593.04, 6257.95, 7046.35, 7919.35, 8363.42, 9419.86, 11186.1, 12604.0, 13982.6, 16884.6, 21306.8, 24858.0, 33143.9]

const DAC_TOP = 159.79 / (22638 / 127 + 100)

/** The console's non-linear DAC for the sample channel alone (0..127 in, 0..1 out). */
export function nesDac(c) {
  return c > 0 ? 159.79 / (22638 / c + 100) / DAC_TOP : 0
}

/**
 * 1-bit delta coding. target: desired counter values (0..127, float).
 * depth: 0 = the usual greedy encoder (bit = target above counter); 1..6 =
 * a lookahead encoder that tries every bit pattern of that length, keeps the
 * first bit of the pattern with the least squared error and moves on (the
 * approach of later homebrew converters).
 * Returns Uint8Array of counter values after each bit (what the DAC plays).
 */
export function dpcmCode(target, depth = 0, start = 64, holdAfter = 0) {
  const n = target.length
  const out = new Uint8Array(n)
  const D = Math.max(0, Math.min(6, depth | 0))
  // holdAfter > 0: after that many samples of exact digital silence the
  // sample "ends" and the counter rests (no idle whine) until sound returns
  const H = holdAfter > 0 ? holdAfter | 0 : 0
  let quiet = 0
  let c = start
  if (D === 0) {
    for (let i = 0; i < n; i++) {
      if (H) {
        quiet = target[i] === start ? quiet + 1 : 0
        if (quiet > H && Math.abs(c - start) <= 2) {
          out[i] = c
          continue
        }
      }
      if (target[i] > c) {
        if (c <= 125) c += 2
      } else if (c >= 2) c -= 2
      out[i] = c
    }
    return out
  }
  const P = 1 << D
  for (let i = 0; i < n; i++) {
    if (H) {
      quiet = target[i] === start ? quiet + 1 : 0
      if (quiet > H && Math.abs(c - start) <= 2) {
        out[i] = c
        continue
      }
    }
    let best = Infinity
    let pick = c
    for (let pth = 0; pth < P; pth++) {
      let v = c
      let e = 0
      let first = c
      for (let d = 0; d < D && i + d < n; d++) {
        if ((pth >> d) & 1) {
          if (v <= 125) v += 2
        } else if (v >= 2) v -= 2
        if (d === 0) first = v
        const err = v - target[i + d]
        e += err * err
        if (e >= best) break
      }
      if (e < best) {
        best = e
        pick = first
      }
    }
    c = pick
    out[i] = c
  }
  return out
}
