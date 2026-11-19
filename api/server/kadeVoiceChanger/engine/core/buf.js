// core/buf.js - audio buffer helpers for the Voice Changer engine.
//
// A buffer is always { sr, ch: [Float32Array, ...] } with one or two (or more)
// channels of equal length. Everything here is plain typed-array arithmetic;
// there is no DOM and no Web Audio. Functions that build a new buffer say so;
// the few that work in place (mixInto, fade, sanitize) say so too and return
// what they changed so calls can be chained.
//
// Choices worth knowing:
// - Level helpers (peak, rms) accept either a buffer or a bare Float32Array.
// - gainToDb never returns -Infinity: silence reads as -200 dB, which keeps
//   later arithmetic finite and still prints as "silent".
// - Fades are raised-cosine (equal-gain Hann halves) so they click less than
//   linear ramps on low voices.
// - mixInto offsets are in samples, not seconds, so stages that place grains
//   or echoes can be sample-exact.

/** Make a silent buffer. */
export function makeBuf(sr, nch = 1, len = 0) {
  const n = Math.max(0, Math.floor(len) || 0)
  const c = Math.max(1, Math.floor(nch) || 1)
  const ch = new Array(c)
  for (let i = 0; i < c; i++) ch[i] = new Float32Array(n)
  return { sr, ch }
}

/** Deep copy of a buffer. */
export function cloneBuf(b) {
  const ch = new Array(b.ch.length)
  for (let i = 0; i < b.ch.length; i++) ch[i] = new Float32Array(b.ch[i])
  return { sr: b.sr, ch }
}

/** Length in samples (0 when the buffer has no channels). */
export function bufLen(b) {
  return b && b.ch && b.ch.length ? b.ch[0].length : 0
}

/** New mono buffer: the average of all channels. */
export function toMono(b) {
  const n = bufLen(b)
  const nc = b.ch.length
  const out = new Float32Array(n)
  if (nc === 1) {
    out.set(b.ch[0])
  } else {
    const g = 1 / nc
    for (let c = 0; c < nc; c++) {
      const s = b.ch[c]
      for (let i = 0; i < n; i++) out[i] += s[i] * g
    }
  }
  return { sr: b.sr, ch: [out] }
}

/** New stereo buffer: mono is copied to both sides, extra channels dropped. */
export function toStereo(b) {
  const n = bufLen(b)
  if (b.ch.length === 1) {
    return { sr: b.sr, ch: [new Float32Array(b.ch[0]), new Float32Array(b.ch[0])] }
  }
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  L.set(b.ch[0])
  R.set(b.ch[1])
  return { sr: b.sr, ch: [L, R] }
}

/** New buffer holding startSec..endSec (clamped to the buffer). */
export function sliceBuf(b, startSec = 0, endSec = Infinity) {
  const n = bufLen(b)
  let s = Math.round((Number(startSec) || 0) * b.sr)
  let e = endSec === Infinity || endSec == null ? n : Math.round(Number(endSec) * b.sr)
  if (!(s >= 0)) s = 0
  if (s > n) s = n
  if (!(e <= n)) e = n
  if (e < s) e = s
  const ch = b.ch.map((x) => x.slice(s, e))
  return { sr: b.sr, ch }
}

/** New buffer with `seconds` of silence added at the end. */
export function padBuf(b, seconds) {
  const n = bufLen(b)
  const add = Math.max(0, Math.round((Number(seconds) || 0) * b.sr))
  const ch = b.ch.map((x) => {
    const y = new Float32Array(n + add)
    y.set(x)
    return y
  })
  return { sr: b.sr, ch }
}

function mixSig(d, s, gain, offset) {
  const dn = d.length
  const sn = s.length
  let i0 = 0
  if (offset < 0) i0 = -offset
  const iEnd = Math.min(sn, dn - offset)
  for (let i = i0; i < iEnd; i++) d[i + offset] += s[i] * gain
}

/**
 * Add src into dst in place, scaled by gain, starting at dst sample `offset`.
 * Works on buffers or bare Float32Arrays. A mono source feeds every
 * destination channel; a stereo source into a mono destination is averaged.
 * dst never grows: anything past its end is dropped. Returns dst.
 */
export function mixInto(dst, src, gain = 1, offset = 0) {
  const off = Math.round(Number(offset) || 0)
  const g = Number.isFinite(gain) ? gain : 0
  if (dst instanceof Float32Array || dst instanceof Float64Array) {
    if (src instanceof Float32Array || src instanceof Float64Array) {
      mixSig(dst, src, g, off)
    } else {
      const k = g / src.ch.length
      for (let c = 0; c < src.ch.length; c++) mixSig(dst, src.ch[c], k, off)
    }
    return dst
  }
  if (src instanceof Float32Array || src instanceof Float64Array) {
    for (let c = 0; c < dst.ch.length; c++) mixSig(dst.ch[c], src, g, off)
    return dst
  }
  const dc = dst.ch.length
  const sc = src.ch.length
  if (sc === dc) {
    for (let c = 0; c < dc; c++) mixSig(dst.ch[c], src.ch[c], g, off)
  } else if (sc === 1) {
    for (let c = 0; c < dc; c++) mixSig(dst.ch[c], src.ch[0], g, off)
  } else if (dc === 1) {
    const k = g / sc
    for (let c = 0; c < sc; c++) mixSig(dst.ch[0], src.ch[c], k, off)
  } else {
    for (let c = 0; c < dc; c++) mixSig(dst.ch[c], src.ch[c % sc], g, off)
  }
  return dst
}

function chans(b) {
  if (b instanceof Float32Array || b instanceof Float64Array) return [b]
  return b.ch
}

/** Largest absolute sample over all channels (non-finite samples ignored). */
export function peak(b) {
  let m = 0
  const cs = chans(b)
  for (let c = 0; c < cs.length; c++) {
    const s = cs[c]
    for (let i = 0; i < s.length; i++) {
      const v = s[i] < 0 ? -s[i] : s[i]
      if (v > m && v !== Infinity) m = v
    }
  }
  return m
}

/** Root mean square over all channels together. */
export function rms(b) {
  let acc = 0
  let n = 0
  const cs = chans(b)
  for (let c = 0; c < cs.length; c++) {
    const s = cs[c]
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (v === v && v !== Infinity && v !== -Infinity) acc += v * v
    }
    n += s.length
  }
  return n ? Math.sqrt(acc / n) : 0
}

export function dbToGain(db) {
  const d = Number(db)
  if (!Number.isFinite(d)) return d === Infinity ? 1e10 : 0
  return Math.pow(10, d / 20)
}

export function gainToDb(g) {
  const v = Math.abs(Number(g))
  if (!(v > 1e-10)) return -200
  return 20 * Math.log10(v)
}

/**
 * Replace NaN and +-Infinity with 0, in place, and flush float32 denormals.
 * Accepts a buffer or a Float32Array. Returns the number of non-finite
 * samples replaced (denormal flushes are not counted).
 */
export function sanitize(b) {
  let fixed = 0
  const cs = chans(b)
  for (let c = 0; c < cs.length; c++) {
    const s = cs[c]
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (v !== v || v === Infinity || v === -Infinity) {
        s[i] = 0
        fixed++
      } else if (v !== 0 && v < 1e-30 && v > -1e-30) {
        s[i] = 0
      }
    }
  }
  return fixed
}

/** Raised-cosine fade in and fade out, in place. Returns b. */
export function fade(b, inSec = 0, outSec = 0) {
  const n = bufLen(b)
  let ni = Math.min(n, Math.max(0, Math.round((Number(inSec) || 0) * b.sr)))
  let no = Math.min(n, Math.max(0, Math.round((Number(outSec) || 0) * b.sr)))
  for (let c = 0; c < b.ch.length; c++) {
    const s = b.ch[c]
    for (let i = 0; i < ni; i++) {
      s[i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / ni)
    }
    for (let i = 0; i < no; i++) {
      s[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / no)
    }
  }
  return b
}

/**
 * New buffer from fn(sig, channelIndex) per channel. fn may return a new
 * Float32Array (any length; the shortest wins so channels stay equal) or
 * nothing, in which case the (possibly mutated) input channel is kept.
 */
export function mapChannels(b, fn) {
  const out = new Array(b.ch.length)
  let minLen = Infinity
  for (let c = 0; c < b.ch.length; c++) {
    const r = fn(b.ch[c], c)
    let y = r == null ? b.ch[c] : r
    if (!(y instanceof Float32Array)) y = Float32Array.from(y)
    out[c] = y
    if (y.length < minLen) minLen = y.length
  }
  for (let c = 0; c < out.length; c++) {
    if (out[c].length !== minLen) out[c] = out[c].subarray(0, minLen).slice()
  }
  return { sr: b.sr, ch: out }
}
