// core/rng.js - seeded random numbers. The engine never calls Math.random.
//
// Generator: sfc32, Chris Doty-Humphrey's "Small Fast Counting" generator
// from the PractRand suite. It passes PractRand to many terabytes, uses only
// 32-bit integer operations (fast in every JavaScript engine, including
// JavaScriptCore on iPhone), and has a counter so no seed falls into a short
// cycle. The four state words are filled from the seed with splitmix32
// (the 32-bit cousin of Vigna's SplitMix64), and the first 12 outputs are
// discarded so nearby seeds give unrelated streams.
//
// Seeds may be numbers or strings. Strings are hashed with a 32-bit
// FNV-1a pass followed by the MurmurHash3 finaliser (fmix32), which spreads
// short labels like "stage-3" across all 32 bits. Non-integer numbers are
// hashed through their decimal text so 1.5 and 1 are different seeds.
//
// fork(label) derives a child generator from the ORIGINAL seed and the
// label only, never from how many numbers the parent has drawn. A preset
// stage that adds one more random draw therefore cannot change the sound of
// any other stage. Forking the same label twice gives the same stream.
//
// gauss() is the Marsaglia polar method (a rejection form of Box-Muller)
// with the spare value cached, so it allocates nothing.
//
// clone() makes an independent generator in exactly this one's current state
// (same seed, so fork() still works); getState(out) and setState(s) copy that
// state through a 6-number array without allocating, so something that must
// replay its random stream later (an LFO's reset) can rewind a private copy.

function fmix32(h) {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** 32-bit hash of a string (FNV-1a, then fmix32). */
export function hashString(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return fmix32(h)
}

/** Turn any seed (number, string, other) into a 32-bit unsigned key. */
export function seedKey(seed) {
  if (typeof seed === 'number' && Number.isInteger(seed) && Math.abs(seed) <= 0xffffffff) {
    return fmix32((seed >>> 0) ^ 0x9e3779b9)
  }
  if (seed === undefined || seed === null) return fmix32(0x9e3779b9)
  return hashString(String(seed))
}

/**
 * Make a seeded generator.
 * @returns {{ next(): number, range(a:number,b:number): number, gauss(): number,
 *   int(n:number): number, pick(arr:any[]): any, fork(label:any): object,
 *   uint32(): number, sign(): number, chance(p:number): boolean, key: number }}
 */
export function makeRng(seed = 1) {
  const key = seedKey(seed)
  // splitmix32 to fill the four state words
  let sm = key
  function split() {
    sm = (sm + 0x9e3779b9) | 0
    let z = sm
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return (z ^ (z >>> 15)) >>> 0
  }
  let a = split() | 0
  let b = split() | 0
  let c = split() | 0
  let d = 1 | 0

  function u32() {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return t >>> 0
  }
  for (let i = 0; i < 12; i++) u32()

  let spare = 0
  let hasSpare = false

  const rng = {
    key,
    /** Uniform in [0, 1), 32 bits of resolution. */
    next() {
      return u32() / 4294967296
    },
    uint32: u32,
    /** Uniform in [a, b). */
    range(lo, hi) {
      return lo + (hi - lo) * (u32() / 4294967296)
    },
    /** Standard normal (mean 0, deviation 1). */
    gauss() {
      if (hasSpare) {
        hasSpare = false
        return spare
      }
      let u, v, s
      do {
        u = (u32() / 4294967296) * 2 - 1
        v = (u32() / 4294967296) * 2 - 1
        s = u * u + v * v
      } while (s >= 1 || s === 0)
      const m = Math.sqrt((-2 * Math.log(s)) / s)
      spare = v * m
      hasSpare = true
      return u * m
    },
    /** Integer in [0, n). */
    int(n) {
      const k = Math.floor(n)
      if (!(k > 0)) return 0
      return Math.floor((u32() / 4294967296) * k)
    },
    /** One element of arr (undefined for an empty array). */
    pick(arr) {
      if (!arr || !arr.length) return undefined
      return arr[Math.floor((u32() / 4294967296) * arr.length)]
    },
    /** +1 or -1 with equal chance. */
    sign() {
      return u32() & 1 ? 1 : -1
    },
    /** True with probability p. */
    chance(p) {
      return u32() / 4294967296 < p
    },
    /** Child generator that depends only on this seed and the label. */
    fork(label) {
      return makeRng(fmix32((key ^ Math.imul(hashString(String(label)), 0x9e3779b1)) >>> 0) >>> 0)
    },
    /** Write the current state into out (any array of 6 numbers). Returns out. */
    getState(out) {
      const o = out || new Float64Array(6)
      o[0] = a
      o[1] = b
      o[2] = c
      o[3] = d
      o[4] = spare
      o[5] = hasSpare ? 1 : 0
      return o
    },
    /** Jump to a state written by getState (of this or any other generator). */
    setState(s) {
      a = s[0] | 0
      b = s[1] | 0
      c = s[2] | 0
      d = s[3] | 0
      spare = +s[4] || 0
      hasSpare = s[5] === 1
      return rng
    },
    /** An independent generator in exactly this state, with the same seed (fork() matches). */
    clone() {
      return makeRng(seed).setState(rng.getState(new Float64Array(6)))
    },
  }
  return rng
}
