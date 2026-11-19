// render.js - turns a take and a preset (or a custom rack) into the finished sound.
//
// The pipeline is CONTRACT section 7, in this order:
//   sanitize -> cleanup (a 70 Hz Butterworth high pass, which also removes DC)
//   -> speed macro (tempo without pitch: the phase vocoder of core/pv.js)
//   -> pitch and timbre macros (added to the first pitch.voice stage, or a
//      pitch.voice stage inserted first)
//   -> every chain stage (each with its own seeded rng, progress shared)
//   -> Effect strength (amount) blends the wet sound with the aligned dry one,
//      skipped when any stage warps time
//   -> background bed mixed under the voice, its level relative to the voice's
//      own loudness, faded in and out, optionally ducked
//   -> stereo width by mid/side
//   -> loudness normalised (ITU-R BS.1770 integrated loudness, core/loudness.js)
//   -> true-peak lookahead limiter at -1 dBTP (core/dyn.js). The limiter may
//      take at most 6 dB off the loudest peaks to reach the target: a chain
//      with sharper peaks than that is left that much quieter instead of being
//      squashed (report.loudnessLoweredDb, and a plain note in report.notes).
//
// Sound-file beds and the other sound (side input) are decoded buffers the host
// hands in. They are resampled to the take's rate with the engine's windowed
// sinc (core/resample.js) and looped with an equal-power crossfade: the end of
// the file fades out while its start fades in over 0.6 s, the classic
// sin/cos pair that keeps the summed power steady for uncorrelated material
// (as in any loop-based sampler or ambience player). Beds start at a seeded
// random offset into the file so the same loop does not always begin the same
// way; the side input starts at the beginning.
//
// Every render runs as a generator that yields between stages. renderPreset,
// renderPreview and renderChain drive it straight through (synchronous, exactly
// the contract's shape). The *Async versions wait one macrotask at every yield,
// so a Worker or the iPhone page can receive a cancel message between stages;
// ctx.cancelled() also lets long modules stop early from inside their loops.
//
// The module registry comes from the generated registry.js. It is loaded with a
// guarded dynamic import, so this file still loads (and tools can pass their own
// module lookup through opts.getModule and opts.getBed) when the registry has
// not been generated yet.

import { cloneBuf, bufLen, toMono, toStereo, sliceBuf, mixInto, peak, dbToGain, gainToDb, sanitize, fade } from './core/buf.js'
import { makeRng } from './core/rng.js'
import { Biquad } from './core/biquad.js'
import { stretch } from './core/pv.js'
import { lufs, normalizeLufs, truePeakDb } from './core/loudness.js'
import { limitBuf } from './core/dyn.js'
import { resampleTo } from './core/resample.js'
import { follow } from './core/env.js'
import { resolveParams } from './core/params.js'

let REG = null
let registryProblem = null
try {
  REG = await import('./registry.js')
} catch (e) {
  REG = null
  registryProblem = 'The effect list (registry.js) could not be loaded: ' + (e && e.message ? e.message : String(e))
}

/** Why the generated registry could not be loaded, or null when it loaded. */
export function registryStatus() {
  return registryProblem
}

/** A plain-sentence error for anything a person or a preset author did wrong. */
export class VCError extends Error {
  constructor(message, code = 'bad-input') {
    super(message)
    this.name = 'VCError'
    this.code = code
  }
}

const CEILING_DB = -1
const MAX_LIMIT_DB = 6 // most gain reduction the final limiter may apply to reach the loudness target
const LOOP_XFADE = 0.6
const MAX_STAGES = 16
const SILENT_REF_LUFS = -23

const now = () => (globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now())

function num(v, d) {
  const x = Number(v)
  return v === undefined || v === null || v === '' || !Number.isFinite(x) ? d : x
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function isBuf(b) {
  return !!(b && typeof b === 'object' && Array.isArray(b.ch) && b.ch.length > 0 && b.ch[0] && typeof b.ch[0].length === 'number')
}

function lookupModule(opts, id) {
  if (opts && typeof opts.getModule === 'function') return opts.getModule(id) || null
  return REG && typeof REG.getModule === 'function' ? REG.getModule(id) || null : null
}

function lookupBed(opts, id) {
  if (opts && typeof opts.getBed === 'function') return opts.getBed(id) || null
  return REG && typeof REG.getBed === 'function' ? REG.getBed(id) || null : null
}

/** Copy a host buffer into a clean engine buffer (Float32Array channels, equal lengths). */
function takeIn(input) {
  if (!isBuf(input)) throw new VCError('There is no recording to change. Record or load some sound first.', 'no-input')
  const sr = Number(input.sr)
  if (!(sr >= 4000 && sr <= 192000)) throw new VCError('The recording has a sample rate of ' + String(input.sr) + ', which the voice changer cannot use.', 'bad-input')
  let n = Infinity
  for (const c of input.ch) n = Math.min(n, c.length)
  const nch = Math.min(2, input.ch.length)
  const ch = []
  for (let c = 0; c < nch; c++) {
    const src = input.ch[c]
    const d = new Float32Array(n)
    if (src instanceof Float32Array) d.set(src.subarray(0, n))
    else for (let i = 0; i < n; i++) d[i] = Number(src[i]) || 0
    ch.push(d)
  }
  return { sr, ch }
}

/** Make whatever a module returned into a well-formed buffer at rate sr. */
function checkStageOut(out, sr, who) {
  if (!isBuf(out)) throw new VCError(who + ' did not return any sound.', 'module-failed')
  let ch = out.ch
  for (let c = 0; c < ch.length; c++) {
    if (!(ch[c] instanceof Float32Array)) ch[c] = Float32Array.from(ch[c], (v) => Number(v) || 0)
  }
  if (ch.length > 2) ch = ch.slice(0, 2)
  let n = Infinity
  for (const c of ch) n = Math.min(n, c.length)
  for (let c = 0; c < ch.length; c++) if (ch[c].length !== n) ch[c] = ch[c].slice(0, n)
  let b = { sr: out.sr, ch }
  if (b.sr !== sr && b.sr > 0) b = { sr, ch: b.ch.map((s) => resampleTo(s, out.sr, sr)) }
  b.sr = sr
  return b
}

/**
 * Loop or trim channels to exactly n samples starting at offset, with an
 * equal-power crossfade of xfadeSec where the end meets the start.
 */
export function loopTo(chs, n, sr, offset = 0, xfadeSec = LOOP_XFADE) {
  const out = chs.map(() => new Float32Array(n))
  const L = chs.length ? chs[0].length : 0
  if (!L || !n) return out
  if (!offset && L >= n) {
    for (let c = 0; c < chs.length; c++) out[c].set(chs[c].subarray(0, n))
    return out
  }
  const X = Math.max(0, Math.min(Math.round(xfadeSec * sr), Math.floor(L / 3)))
  const P = L - X
  const half = Math.PI / 2
  for (let c = 0; c < chs.length; c++) {
    const s = chs[c]
    const o = out[c]
    let k = ((Math.floor(offset) % P) + P) % P
    for (let j = 0; j < n; j++) {
      let v
      if (k < X) {
        const t = (k + 0.5) / X
        v = s[k] * Math.sin(half * t) + s[P + k] * Math.cos(half * t)
      } else v = s[k]
      o[j] = v
      k++
      if (k >= P) k = 0
    }
  }
  return out
}

/** A host-supplied sound (bed file or side input) at rate sr. */
function soundAt(buf, sr) {
  if (!isBuf(buf)) return null
  const from = Number(buf.sr) > 0 ? Number(buf.sr) : sr
  const chs = buf.ch.slice(0, 2).map((s) => {
    const f = s instanceof Float32Array ? s : Float32Array.from(s, (v) => Number(v) || 0)
    const y = from === sr ? new Float32Array(f) : resampleTo(f, from, sr)
    sanitize(y)
    return y
  })
  let n = Infinity
  for (const c of chs) n = Math.min(n, c.length)
  return chs.map((c) => (c.length === n ? c : c.slice(0, n)))
}

function pickBedAudio(bedAudio, id) {
  if (!bedAudio) return null
  if (isBuf(bedAudio)) return bedAudio
  if (typeof bedAudio === 'object') return bedAudio[id] || bedAudio['bed:' + id] || null
  return null
}

function resolveStrict(mod, p, who) {
  const problems = []
  const r = resolveParams(mod, p && typeof p === 'object' ? p : null, { problems })
  if (problems.length) throw new VCError(who + ': ' + problems.join(' '), 'bad-params')
  return r
}

/** Turn chain entries into checked stages. Throws VCError with a plain sentence. */
function prepareStages(chain, opts) {
  if (!Array.isArray(chain)) throw new VCError('The preset has no list of effects.', 'bad-preset')
  if (chain.length > MAX_STAGES) throw new VCError('A chain can hold at most ' + MAX_STAGES + ' effects; this one has ' + chain.length + '.', 'bad-preset')
  const stages = []
  chain.forEach((st, i) => {
    if (!st || typeof st !== 'object' || typeof st.m !== 'string') throw new VCError('Effect ' + (i + 1) + ' in the chain does not say which effect it is.', 'bad-preset')
    if (st.off === true || st.bypass === true) return
    const mod = lookupModule(opts, st.m)
    if (!mod) throw new VCError('There is no effect called "' + st.m + '".', 'unknown-module')
    const p = resolveStrict(mod, st.p, mod.name || st.m)
    stages.push({ m: st.m, mod, raw: st.p && typeof st.p === 'object' ? { ...st.p } : {}, p, label: 'stage' + i + ':' + st.m })
  })
  return stages
}

function applyMacroPitch(stages, pitch, timbre, opts, notes) {
  if (!pitch && !timbre) return
  const idx = stages.findIndex((s) => s.m === 'pitch.voice')
  if (idx >= 0) {
    const s = stages[idx]
    const raw = { ...s.raw, semitones: num(s.p.semitones, 0) + pitch, formant: num(s.p.formant, 0) + timbre }
    s.raw = raw
    s.p = resolveParams(s.mod, raw)
    return
  }
  const mod = lookupModule(opts, 'pitch.voice')
  if (!mod) {
    notes.push('The pitch and timbre controls need the Pitch and timbre effect, which is not installed, so they were left alone.')
    return
  }
  const raw = { semitones: pitch, formant: timbre }
  stages.unshift({ m: 'pitch.voice', mod, raw, p: resolveParams(mod, raw), label: 'macro-pitch', macro: true })
}

function cleanupBuf(b) {
  for (let c = 0; c < b.ch.length; c++) new Biquad('highpass', b.sr, 70, Math.SQRT1_2).run(b.ch[c])
}

function widthBuf(b, width) {
  if (b.ch.length < 2 || width === 100) return
  const k = width / 100
  const L = b.ch[0]
  const R = b.ch[1]
  for (let i = 0; i < L.length; i++) {
    const m = 0.5 * (L[i] + R[i])
    const s = 0.5 * (L[i] - R[i]) * k
    L[i] = m + s
    R[i] = m - s
  }
}

function fadeSpec(f) {
  if (f === false || f === 0) return [0, 0]
  if (typeof f === 'number' && f > 0) return [Math.min(10, f), Math.min(10, f)]
  if (f && typeof f === 'object') return [clamp(num(f.in, 0.5), 0, 10), clamp(num(f.out, 1), 0, 10)]
  return [0.5, 1]
}

/** Mix the background under the voice. Returns the (maybe now stereo) buffer and facts for the report. */
function mixBed(buf, spec, opts, rng, notes) {
  const n = bufLen(buf)
  const sr = buf.sr
  if (!n) return { buf, info: null }
  let bedCh = null
  let what
  let synced = false
  if (typeof spec.file === 'string' && spec.file) {
    what = 'file:' + spec.file
    const src = soundAt(pickBedAudio(opts.bedAudio, spec.file), sr)
    if (!src || !src[0].length) {
      notes.push('The background sound was not loaded, so the voice plays without it.')
      return { buf, info: null }
    }
    if (spec.sync === true) {
      // A backing track (Nov 18 2026): lined up with the take from its own start (a
      // preview that starts part way in starts the track there too), played once,
      // silent after it ends. Never looped, never started at a random place.
      synced = true
      const at = Math.max(0, Math.round(num(opts.bedStart, 0) * sr))
      bedCh = src.map((s) => {
        const y = new Float32Array(n)
        if (at < s.length) y.set(s.subarray(at, Math.min(s.length, at + n)))
        return y
      })
    } else {
      const P = Math.max(1, src[0].length - Math.min(Math.round(LOOP_XFADE * sr), Math.floor(src[0].length / 3)))
      const offset = rng.fork('bed-offset').int(P)
      bedCh = loopTo(src, n, sr, offset)
    }
  } else if (typeof spec.b === 'string' && spec.b) {
    what = spec.b
    const bed = lookupBed(opts, spec.b)
    if (!bed) throw new VCError('There is no background called "' + spec.b + '".', 'unknown-bed')
    const p = resolveStrict(bed, spec.p, bed.name || spec.b)
    const g = bed.generate(n / sr, sr, p, rng.fork('bed:' + spec.b))
    if (!isBuf(g)) throw new VCError((bed.name || spec.b) + ' did not make any sound.', 'bed-failed')
    bedCh = g.ch.slice(0, 2).map((s) => {
      const y = new Float32Array(n)
      const src = s instanceof Float32Array ? s : Float32Array.from(s, (v) => Number(v) || 0)
      y.set(src.subarray(0, Math.min(n, src.length)))
      return y
    })
    if (g.sr && g.sr !== sr) bedCh = g.ch.slice(0, 2).map((s) => {
      const r = resampleTo(s, g.sr, sr)
      const y = new Float32Array(n)
      y.set(r.subarray(0, Math.min(n, r.length)))
      return y
    })
  } else {
    return { buf, info: null }
  }
  if (bedCh.length === 1) bedCh = [bedCh[0], new Float32Array(bedCh[0])]
  const bedBuf = { sr, ch: bedCh }
  sanitize(bedBuf)
  const level = clamp(num(spec.level, -18), -60, 6)
  const voiceL = lufs(buf)
  const ref = voiceL > -70 ? voiceL : SILENT_REF_LUFS
  const bedL = lufs(bedBuf)
  if (!(bedL > -70)) return { buf, info: { bed: what, level, silent: true } }
  const g = dbToGain(ref + level - bedL)
  // a backing track keeps its own start and end unless a fade is asked for
  const [fi, fo] = fadeSpec(synced && spec.fade === undefined ? false : spec.fade)
  fade(bedBuf, Math.min(fi, n / sr / 2), Math.min(fo, n / sr / 2))
  const duckDb = spec.duck === true ? 6 : clamp(num(spec.duck, 0), 0, 40)
  let duck = null
  if (duckDb > 0) {
    const env = follow(toMono(buf).ch[0], sr, 25, 450)
    let top = 0
    for (let i = 0; i < n; i++) if (env[i] > top) top = env[i]
    if (top > 1e-6) {
      duck = new Float32Array(n)
      const ref2 = top * 0.35
      const k = -duckDb / 20
      for (let i = 0; i < n; i++) {
        const d = env[i] >= ref2 ? 1 : env[i] / ref2
        duck[i] = Math.pow(10, k * d)
      }
    }
  }
  const out = buf.ch.length === 1 ? toStereo(buf) : buf
  for (let c = 0; c < 2; c++) {
    const o = out.ch[c]
    const s = bedCh[c]
    if (duck) for (let i = 0; i < n; i++) o[i] += s[i] * g * duck[i]
    else for (let i = 0; i < n; i++) o[i] += s[i] * g
  }
  const info = { bed: what, level, duck: duckDb, gainDb: Math.round(gainToDb(g) * 10) / 10 }
  if (synced) info.sync = true
  return { buf: out, info }
}

function finish(buf, target, volume, report) {
  const n = bufLen(buf)
  if (!n) return
  if (target !== null) {
    let T = target + volume
    normalizeLufs(buf, T)
    let pre = truePeakDb(buf)
    // Limiting guard: a chain with very sharp peaks (a pulse train, a click
    // track) would need more than MAX_LIMIT_DB of gain reduction to reach the
    // loudness target, which squashes it audibly. Lower the target for this
    // render just enough that the limiter takes MAX_LIMIT_DB at most, and say
    // so. Gain the make-up loop below adds counts toward the same budget.
    let budget = MAX_LIMIT_DB
    if (Number.isFinite(pre) && pre - CEILING_DB > MAX_LIMIT_DB) {
      const lower = pre - CEILING_DB - MAX_LIMIT_DB
      const g = dbToGain(-lower)
      for (const s of buf.ch) for (let i = 0; i < s.length; i++) s[i] *= g
      T -= lower
      pre -= lower
      budget = 0
      report.loudnessLoweredDb = round1(lower)
    } else if (Number.isFinite(pre)) {
      budget = MAX_LIMIT_DB - Math.max(0, pre - CEILING_DB)
    }
    report.preLimitPeakDb = round1(pre)
    limitBuf(buf, { ceilingDb: CEILING_DB, lookaheadMs: 5, releaseMs: 80, truePeak: true })
    for (let k = 0; k < 3; k++) {
      const L = lufs(buf)
      if (!(L > -70) || L >= T - 0.4) break
      let gDb = Math.min(6, T - L)
      if (gDb > budget) {
        // more make-up gain would squash it past the budget: stop here
        const short = gDb - budget
        report.loudnessLoweredDb = round1((report.loudnessLoweredDb || 0) + short)
        gDb = budget
      }
      if (!(gDb > 0.05)) break
      budget -= gDb
      const g = dbToGain(gDb)
      for (const s of buf.ch) for (let i = 0; i < s.length; i++) s[i] *= g
      limitBuf(buf, { ceilingDb: CEILING_DB, lookaheadMs: 5, releaseMs: 80, truePeak: true })
    }
    if (report.loudnessLoweredDb > 0) {
      const d = report.loudnessLoweredDb
      report.notes.push(
        'This sound has very sharp peaks, so it was made ' + (d < 1 ? 'slightly' : (Math.round(d * 10) / 10) + ' decibels') +
          ' quieter than usual instead of being squashed to full loudness.',
      )
    }
  } else {
    if (volume) {
      const g = dbToGain(volume)
      for (const s of buf.ch) for (let i = 0; i < s.length; i++) s[i] *= g
    }
    report.preLimitPeakDb = round1(truePeakDb(buf))
    limitBuf(buf, { ceilingDb: CEILING_DB, lookaheadMs: 5, releaseMs: 80, truePeak: true })
  }
}

function round1(x) {
  return Math.round(x * 10) / 10
}

function* renderGen(input, preset, opts) {
  const t0 = now()
  const o = opts || {}
  if (!preset || typeof preset !== 'object') throw new VCError('There is no preset to play.', 'bad-preset')
  const notes = []
  const noteSet = new Set()
  const note = (msg) => {
    const s = String(msg || '').trim()
    if (s && !noteSet.has(s)) {
      noteSet.add(s)
      notes.push(s)
    }
  }
  const cancelled = typeof o.cancelled === 'function' ? o.cancelled : () => false
  const checkCancel = () => {
    if (cancelled()) throw new VCError('The render was cancelled.', 'cancelled')
  }

  let buf = takeIn(input)
  const report = {
    ms: 0,
    stages: [],
    peakDb: -200,
    lufs: -200,
    truePeakDb: -200,
    fixedNaN: 0,
    notes,
    sr: buf.sr,
    channels: buf.ch.length,
    seconds: 0,
    inputSeconds: bufLen(buf) / buf.sr,
    amountSkipped: null,
    loudnessLoweredDb: 0,
    bed: null,
    preset: typeof preset.id === 'string' ? preset.id : null,
  }
  report.fixedNaN += sanitize(buf)

  const macros = o.macros && typeof o.macros === 'object' ? o.macros : {}
  const pitch = clamp(num(macros.pitch, 0), -24, 24)
  const timbre = clamp(num(macros.timbre, 0), -12, 12)
  const speed = clamp(num(macros.speed, 1), 0.25, 4)
  const amount = clamp(num(macros.amount, 100), 0, 100)
  const width = clamp(num(macros.width, 100), 0, 200)
  const volume = clamp(num(macros.volume, 0), -24, 12)
  const bedSpec = macros.bed === undefined ? preset.bed || null : macros.bed
  const target = o.loudness === null ? null : clamp(num(o.loudness, -16), -40, -6)
  const cleanup = o.cleanup !== false && preset.cleanup !== false
  const seed = o.seed !== undefined && o.seed !== null ? o.seed : preset.seed !== undefined ? preset.seed : 1
  const rng = makeRng(seed)

  const stages = prepareStages(preset.chain || [], o)
  applyMacroPitch(stages, pitch, timbre, o, notes)
  const warper = stages.find((s) => s.mod.warps === true)

  // progress shared across every step, weighted by each module's cost
  const weights = stages.map((s) => (Number.isFinite(s.mod.cost) ? clamp(s.mod.cost, 1, 5) : 2))
  const wSpeed = speed !== 1 ? 3 : 0
  const wBed = bedSpec ? 1 : 0
  const wFinish = 1
  const total = weights.reduce((a, b) => a + b, 0) + wSpeed + wBed + wFinish
  let done = 0
  let lastF = -1
  const report01 = (f) => {
    if (typeof o.progress !== 'function') return
    const v = clamp(f, 0, 1)
    if (v <= lastF && v < 1) return
    lastF = v
    try {
      o.progress(v)
    } catch {
      // a broken progress callback must not break the render
    }
  }
  const stepDone = (w) => {
    done += w
    report01(done / total)
  }

  report01(0)
  if (cleanup && bufLen(buf)) cleanupBuf(buf)

  if (speed !== 1 && bufLen(buf)) {
    const ts = now()
    buf = { sr: buf.sr, ch: buf.ch.map((s) => stretch(s, buf.sr, 1 / speed)) }
    report.stages.push({ m: 'macro.speed', ms: round1(now() - ts) })
    stepDone(wSpeed)
    yield
    checkCancel()
  }

  const useAmount = amount < 100 && !warper
  if (amount < 100 && warper) {
    report.amountSkipped = 'Effect strength was left at full because ' + (warper.mod.name || warper.m) + ' changes the timing, so the dry voice no longer lines up.'
    note(report.amountSkipped)
  }
  const dry = useAmount ? cloneBuf(buf) : null

  // the other sound, looped or trimmed to each stage's input length
  let sideSrc = null
  let sideTried = false
  const sideCache = new Map()
  const sideFor = (len) => {
    if (!sideTried) {
      sideTried = true
      sideSrc = soundAt(o.sideAudio, buf.sr)
      if (sideSrc && !sideSrc[0].length) sideSrc = null
    }
    if (!sideSrc) return null
    if (!sideCache.has(len)) sideCache.set(len, { sr: buf.sr, ch: loopTo(sideSrc, len, buf.sr, 0) })
    const c = sideCache.get(len)
    return { sr: c.sr, ch: c.ch.map((s) => new Float32Array(s)) }
  }

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    const w = weights[i]
    const base = done
    const ts = now()
    const len = bufLen(buf)
    const ctx = {
      sr: buf.sr,
      rng: rng.fork(st.label),
      seconds: len / buf.sr,
      progress: (f) => report01((base + clamp(num(f, 0), 0, 1) * w) / total),
      cancelled,
      side: st.mod.side === true ? sideFor(len) : null,
      note,
      stage: i,
    }
    let out
    try {
      out = st.mod.process(buf, st.p, ctx)
      if (out && typeof out.then === 'function') out = yield out
    } catch (e) {
      if (e instanceof VCError) throw e
      if (cancelled()) throw new VCError('The render was cancelled.', 'cancelled')
      throw new VCError((st.mod.name || st.m) + ' ran into a problem: ' + (e && e.message ? e.message : String(e)), 'module-failed')
    }
    buf = checkStageOut(out, buf.sr, st.mod.name || st.m)
    report.fixedNaN += sanitize(buf)
    report.stages.push({ m: st.m, ms: round1(now() - ts) })
    done = base + w
    report01(done / total)
    yield
    checkCancel()
  }

  if (dry) {
    const a = amount / 100
    const n = Math.max(bufLen(buf), bufLen(dry))
    let wet = buf
    if (bufLen(wet) < n) wet = { sr: wet.sr, ch: wet.ch.map((s) => { const y = new Float32Array(n); y.set(s); return y }) }
    for (const s of wet.ch) for (let k = 0; k < s.length; k++) s[k] *= a
    mixInto(wet, dry, 1 - a, 0)
    buf = wet
  }

  if (bedSpec && typeof bedSpec === 'object') {
    if (bedSpec.sync === true && (speed !== 1 || warper)) {
      note('The backing track no longer lines up with the voice, because ' + (speed !== 1 ? 'Speed is not at 1' : (warper.mod.name || warper.m) + ' changes the timing') + '.')
    }
    const r = mixBed(buf, bedSpec, o, rng, notes)
    buf = r.buf
    report.bed = r.info
    stepDone(wBed)
    yield
    checkCancel()
  }

  widthBuf(buf, width)
  finish(buf, target, volume, report)
  report.fixedNaN += sanitize(buf)
  stepDone(wFinish)

  report.peakDb = round1(gainToDb(peak(buf)))
  report.truePeakDb = round1(truePeakDb(buf))
  report.lufs = round1(lufs(buf))
  report.channels = buf.ch.length
  report.seconds = bufLen(buf) / buf.sr
  report.ms = round1(now() - t0)
  report01(1)
  return { buf, report }
}

function runSync(gen) {
  let r = gen.next()
  while (!r.done) {
    if (r.value && typeof r.value.then === 'function') {
      throw new VCError('An effect works in the background and needs the waiting version of the renderer (renderPresetAsync).', 'needs-async')
    }
    r = gen.next()
  }
  return r.value
}

const tick = () => new Promise((res) => (typeof setTimeout === 'function' ? setTimeout(res, 0) : res()))

async function runAsync(gen) {
  let r = gen.next()
  while (!r.done) {
    let v
    if (r.value && typeof r.value.then === 'function') {
      try {
        v = await r.value
      } catch (e) {
        r = gen.throw(e)
        continue
      }
    } else await tick()
    r = gen.next(v)
  }
  return r.value
}

/** The stretch of the take a preview plays, and the options for it: bedStart tells a
 *  lined-up backing track (a sound-file bed with sync) where in the take the preview begins. */
function previewParts(input, opts) {
  const o = opts || {}
  const b = takeIn(input)
  const total = bufLen(b) / b.sr
  const start = clamp(num(o.start, 0), 0, Math.max(0, total))
  const secs = clamp(num(o.seconds, 6), 0.05, 600)
  return { take: sliceBuf(b, start, Math.min(total, start + secs)), opts: { ...o, bedStart: num(o.bedStart, 0) + start } }
}

/** Render a whole take with a preset. Returns { buf, report }. */
export function renderPreset(input, preset, opts = {}) {
  return runSync(renderGen(input, preset, opts))
}

/** Same as renderPreset on opts.start .. opts.start + opts.seconds (default 0 .. 6 s). */
export function renderPreview(input, preset, opts = {}) {
  const pv = previewParts(input, opts)
  return runSync(renderGen(pv.take, preset, pv.opts))
}

/** A custom rack: the chain as an ad hoc preset, with the same finishing steps. */
export function renderChain(input, chain, ctx = {}) {
  const c = ctx || {}
  return runSync(renderGen(input, { id: null, chain, bed: c.bed, seed: c.seed, side: c.side }, c))
}

/** Waiting versions: they pause between stages so a cancel message can get through. */
export function renderPresetAsync(input, preset, opts = {}) {
  try {
    return runAsync(renderGen(input, preset, opts))
  } catch (e) {
    return Promise.reject(e)
  }
}

export function renderPreviewAsync(input, preset, opts = {}) {
  try {
    const pv = previewParts(input, opts)
    return runAsync(renderGen(pv.take, preset, pv.opts))
  } catch (e) {
    return Promise.reject(e)
  }
}

export function renderChainAsync(input, chain, ctx = {}) {
  const c = ctx || {}
  try {
    return runAsync(renderGen(input, { id: null, chain, bed: c.bed, seed: c.seed, side: c.side }, c))
  } catch (e) {
    return Promise.reject(e)
  }
}

/** True when every stage of the chain has a live version (live mode can play it). */
export function chainIsLive(chain, opts = {}) {
  if (!Array.isArray(chain) || !chain.length) return false
  for (const st of chain) {
    const m = st && lookupModule(opts, st.m)
    if (!m || !m.live || typeof m.live.create !== 'function') return false
  }
  return true
}
