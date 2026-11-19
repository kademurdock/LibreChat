// core/wav.js - WAV files in and out for the Voice Changer engine.
//
// encodeWav() writes canonical RIFF/WAVE (Microsoft "Multimedia Programming
// Interface and Data Specifications 1.0" and the later WAVE_FORMAT_EXTENSIBLE
// notes):
// - 16-bit PCM (default) with TPDF dither: the difference of two uniform
//   random numbers, one LSB each, added before rounding (Lipshitz, Wannamaker
//   and Vanderkooy, "Quantization and Dither: A Theoretical Survey", JAES
//   1992). It decorrelates the rounding error from the signal so quiet tails
//   fade into a steady hiss instead of crunching. Samples that are exactly
//   zero stay zero, so digital silence stays silent. The dither comes from the
//   engine's seeded rng (seed opts.seed, default 'wav-dither'), so the same
//   buffer always encodes to the same bytes.
// - 24-bit PCM, rounded, no dither (its floor is far below hearing).
// - 8-bit unsigned PCM with TPDF dither, for retro effects that want it.
// - 32-bit IEEE float, with the 18-byte format chunk and the fact chunk the
//   specification asks for.
// Non-finite samples are written as 0, and integer formats clip at full scale.
//
// decodeWav() reads PCM 8 (unsigned), 16, 24 and 32-bit integer, 32 and
// 64-bit float, G.711 A-law and mu-law (decoded with the ITU G.711 segment
// tables, as in the classic Sun reference code), and WAVE_FORMAT_EXTENSIBLE
// (the sub-format GUID decides). Containers wider than the valid bits are
// fine because samples are left-justified. It walks the chunk list, skips
// unknown chunks (LIST, bext, cue, junk...), honours the pad byte after odd
// sized chunks, accepts RF64 (64-bit sizes from the ds64 chunk), and trusts
// the bytes actually present over a data size written by a recorder that
// never went back to fill it in. Files with more than two channels are folded
// to stereo (centre to both sides at -3 dB, LFE dropped, the rest alternating
// left and right at -3 dB) unless opts.keepChannels is set.
// Errors are plain sentences.

import { makeRng } from './rng.js'

const FMT_PCM = 1
const FMT_FLOAT = 3
const FMT_ALAW = 6
const FMT_MULAW = 7
const FMT_EXT = 0xfffe

function writeStr(u8, off, s) {
  for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i)
}

/**
 * Encode a buffer { sr, ch } as a WAV file. bits: 16 (default), 24, 8 or 32
 * (32 means float). opts: { dither=true (16 and 8 bit), seed='wav-dither' }.
 * Returns a Uint8Array.
 */
export function encodeWav(b, bits = 16, opts = {}) {
  const chs = b && b.ch && b.ch.length ? b.ch : [new Float32Array(0)]
  const nch = chs.length
  const n = chs[0].length
  let sr = Math.round(Number(b && b.sr) || 48000)
  if (!(sr > 0)) sr = 48000
  const bitsN = bits === 'float' ? 32 : Number(bits)
  if (![8, 16, 24, 32].includes(bitsN)) throw new Error('A WAV file can be written at 8, 16, 24 or 32 bits, not ' + String(bits) + '.')
  const isFloat = bitsN === 32
  const bps = bitsN / 8
  const blockAlign = nch * bps
  const dataBytes = n * blockAlign
  const pad = dataBytes & 1
  const fmtSize = isFloat ? 18 : 16
  const factSize = isFloat ? 12 : 0
  const total = 12 + 8 + fmtSize + factSize + 8 + dataBytes + pad
  const u8 = new Uint8Array(total)
  const dv = new DataView(u8.buffer)
  writeStr(u8, 0, 'RIFF')
  dv.setUint32(4, total - 8, true)
  writeStr(u8, 8, 'WAVE')
  let o = 12
  writeStr(u8, o, 'fmt ')
  dv.setUint32(o + 4, fmtSize, true)
  dv.setUint16(o + 8, isFloat ? FMT_FLOAT : FMT_PCM, true)
  dv.setUint16(o + 10, nch, true)
  dv.setUint32(o + 12, sr, true)
  dv.setUint32(o + 16, sr * blockAlign, true)
  dv.setUint16(o + 20, blockAlign, true)
  dv.setUint16(o + 22, bitsN, true)
  if (isFloat) dv.setUint16(o + 24, 0, true)
  o += 8 + fmtSize
  if (isFloat) {
    writeStr(u8, o, 'fact')
    dv.setUint32(o + 4, 4, true)
    dv.setUint32(o + 8, n, true)
    o += 12
  }
  writeStr(u8, o, 'data')
  dv.setUint32(o + 4, dataBytes, true)
  o += 8
  const dither = opts.dither !== false && (bitsN === 16 || bitsN === 8)
  // One xorshift32 word per sample gives both 16-bit uniforms of the TPDF
  // pair; it is seeded from the engine rng so the bytes stay reproducible.
  let xs = dither ? makeRng(opts.seed !== undefined ? opts.seed : 'wav-dither').uint32() | 1 : 1
  if (bitsN === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let x = chs[c][i]
        let q = 0
        if (x !== 0 && x <= 1e30 && x >= -1e30) {
          x *= 32768
          if (dither) {
            xs ^= xs << 13
            xs ^= xs >>> 17
            xs ^= xs << 5
            x += ((xs & 0xffff) - (xs >>> 16)) * (1 / 65536)
          }
          q = Math.round(x)
          if (q > 32767) q = 32767
          else if (q < -32768) q = -32768
        }
        u8[o] = q & 0xff
        u8[o + 1] = (q >> 8) & 0xff
        o += 2
      }
    }
  } else if (bitsN === 24) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const x = chs[c][i]
        let q = 0
        if (x <= 1e30 && x >= -1e30) {
          q = Math.round(x * 8388608)
          if (q > 8388607) q = 8388607
          else if (q < -8388608) q = -8388608
        }
        u8[o] = q & 0xff
        u8[o + 1] = (q >> 8) & 0xff
        u8[o + 2] = (q >> 16) & 0xff
        o += 3
      }
    }
  } else if (bitsN === 8) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let x = chs[c][i]
        let q = 0
        if (x !== 0 && x <= 1e30 && x >= -1e30) {
          x *= 128
          if (dither) {
            xs ^= xs << 13
            xs ^= xs >>> 17
            xs ^= xs << 5
            x += ((xs & 0xffff) - (xs >>> 16)) * (1 / 65536)
          }
          q = Math.round(x)
          if (q > 127) q = 127
          else if (q < -128) q = -128
        }
        u8[o++] = q + 128
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const x = chs[c][i]
        dv.setFloat32(o, x <= 3.4e38 && x >= -3.4e38 ? x : 0, true)
        o += 4
      }
    }
  }
  return u8
}

// ---------------------------------------------------------------- decoding

function toU8(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  throw new Error('A WAV file must be given as bytes (a Uint8Array or ArrayBuffer).')
}

function tag(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
}

// G.711 expansions to the 16-bit range (ITU-T G.711, Sun g711.c).
const ALAW = new Float32Array(256)
const MULAW = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  let a = i ^ 0x55
  let t = (a & 0x0f) << 4
  const seg = (a & 0x70) >> 4
  if (seg === 0) t += 8
  else if (seg === 1) t += 0x108
  else {
    t += 0x108
    t <<= seg - 1
  }
  ALAW[i] = ((a & 0x80) ? t : -t) / 32768
  const u = ~i & 0xff
  let m = ((u & 0x0f) << 3) + 0x84
  m <<= (u & 0x70) >> 4
  MULAW[i] = ((u & 0x80) ? 0x84 - m : m - 0x84) / 32768
}

const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]

function parse(input) {
  const u8 = toU8(input)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const len = u8.length
  if (len < 12) throw new Error('This file is too short to be a WAV file.')
  const riff = tag(u8, 0)
  if ((riff !== 'RIFF' && riff !== 'RF64') || tag(u8, 8) !== 'WAVE') {
    if (riff === 'RIFX') throw new Error('This WAV file is big-endian (RIFX), which cannot be read.')
    throw new Error('This file is not a WAV file.')
  }
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  let ds64Data = -1
  let o = 12
  while (o + 8 <= len) {
    const id = tag(u8, o)
    let size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'ds64' && size >= 16 && body + 16 <= len) {
      ds64Data = dv.getUint32(body + 8, true) + dv.getUint32(body + 12, true) * 4294967296
    }
    if (id === 'fmt ') {
      if (size < 14 || body + 14 > len) throw new Error('This WAV file has a broken format chunk.')
      let format = dv.getUint16(body, true)
      const channels = dv.getUint16(body + 2, true)
      const sr = dv.getUint32(body + 4, true)
      const blockAlign = dv.getUint16(body + 12, true)
      const bits = size >= 16 && body + 16 <= len ? dv.getUint16(body + 14, true) : 8 * Math.floor(blockAlign / Math.max(1, channels))
      if (format === FMT_EXT) {
        if (size < 40 || body + 40 > len) throw new Error('This WAV file says it is extensible but its format chunk is too short.')
        const sub = dv.getUint16(body + 24, true)
        let okGuid = true
        for (let k = 0; k < 14; k++) if (u8[body + 26 + k] !== GUID_TAIL[k]) okGuid = false
        if (!okGuid) throw new Error('This WAV file uses a sub-format this reader does not know.')
        format = sub
      }
      fmt = { format, channels, sr, blockAlign, bits }
    } else if (id === 'data') {
      dataOff = body
      if (riff === 'RF64' && size === 0xffffffff && ds64Data >= 0) size = ds64Data
      // a recorder that never filled the size in, or a cut-off file: use what is there
      dataLen = size === 0xffffffff || body + size > len ? len - body : size
      if (fmt) break
    }
    let next = body + size + (size & 1)
    if (riff === 'RF64' && size === 0xffffffff) next = len
    if (next <= o) break
    o = next
  }
  if (!fmt) throw new Error('This WAV file has no format chunk.')
  if (dataOff < 0) throw new Error('This WAV file has no sound data.')
  const { format, channels, sr, bits } = fmt
  if (!(channels >= 1)) throw new Error('This WAV file says it has no channels.')
  if (!(sr >= 1000 && sr <= 768000)) throw new Error('This WAV file has a sample rate of ' + sr + ', which cannot be right.')
  let bps
  if (format === FMT_PCM) {
    if (![8, 16, 24, 32].includes(bits) && !(bits > 0 && bits <= 32)) throw new Error('This WAV file uses ' + bits + '-bit samples, which cannot be read.')
    bps = Math.ceil(bits / 8)
    // container may be wider than the valid bits
    const cont = Math.floor(fmt.blockAlign / channels)
    if (cont > bps && cont <= 4) bps = cont
  } else if (format === FMT_FLOAT) {
    if (bits !== 32 && bits !== 64) throw new Error('This WAV file uses ' + bits + '-bit floating point, which cannot be read.')
    bps = bits / 8
  } else if (format === FMT_ALAW || format === FMT_MULAW) {
    bps = 1
  } else {
    throw new Error('This WAV file uses a compressed format (code ' + format + ') that cannot be read. Save it as plain PCM.')
  }
  const frame = bps * channels
  const frames = Math.floor(dataLen / frame)
  return { u8, dv, format, channels, sr, bits: format === FMT_PCM ? bps * 8 : bits, bps, frame, frames, dataOff }
}

/** Header facts without decoding: { sr, channels, bits, format, frames, seconds }. */
export function wavInfo(input) {
  const p = parse(input)
  const names = { 1: 'pcm', 3: 'float', 6: 'alaw', 7: 'mulaw' }
  return { sr: p.sr, channels: p.channels, bits: p.bits, format: names[p.format], frames: p.frames, seconds: p.frames / p.sr }
}

/**
 * Decode WAV bytes into { sr, ch }. opts: { keepChannels=false }.
 */
export function decodeWav(input, opts = {}) {
  const p = parse(input)
  const { u8, dv, format, channels, sr, bps, frame, frames, dataOff } = p
  const ch = new Array(channels)
  for (let c = 0; c < channels; c++) ch[c] = new Float32Array(frames)
  for (let c = 0; c < channels; c++) {
    const out = ch[c]
    let q = dataOff + c * bps
    if (format === FMT_FLOAT) {
      if (bps === 4) {
        for (let i = 0; i < frames; i++, q += frame) {
          const v = dv.getFloat32(q, true)
          out[i] = v <= 3.4e38 && v >= -3.4e38 ? v : 0
        }
      } else {
        for (let i = 0; i < frames; i++, q += frame) {
          const v = dv.getFloat64(q, true)
          out[i] = v <= 3.4e38 && v >= -3.4e38 ? v : 0
        }
      }
    } else if (format === FMT_ALAW) {
      for (let i = 0; i < frames; i++, q += frame) out[i] = ALAW[u8[q]]
    } else if (format === FMT_MULAW) {
      for (let i = 0; i < frames; i++, q += frame) out[i] = MULAW[u8[q]]
    } else if (bps === 1) {
      for (let i = 0; i < frames; i++, q += frame) out[i] = (u8[q] - 128) / 128
    } else if (bps === 2) {
      for (let i = 0; i < frames; i++, q += frame) out[i] = (((u8[q] | (u8[q + 1] << 8)) << 16) >> 16) / 32768
    } else if (bps === 3) {
      for (let i = 0; i < frames; i++, q += frame) out[i] = (((u8[q] | (u8[q + 1] << 8) | (u8[q + 2] << 16)) << 8) >> 8) / 8388608
    } else {
      for (let i = 0; i < frames; i++, q += frame) out[i] = (u8[q] | (u8[q + 1] << 8) | (u8[q + 2] << 16) | (u8[q + 3] << 24)) / 2147483648
    }
  }
  if (channels <= 2 || opts.keepChannels) return { sr, ch }
  // fold to stereo
  const L = new Float32Array(frames)
  const R = new Float32Array(frames)
  L.set(ch[0])
  R.set(ch[1])
  const k = Math.SQRT1_2
  for (let c = 2; c < channels; c++) {
    const s = ch[c]
    if (c === 2) {
      for (let i = 0; i < frames; i++) {
        L[i] += k * s[i]
        R[i] += k * s[i]
      }
    } else if (c === 3 && channels >= 6) {
      continue // LFE
    } else {
      const dst = c % 2 === 0 ? L : R
      for (let i = 0; i < frames; i++) dst[i] += k * s[i]
    }
  }
  return { sr, ch: [L, R] }
}
