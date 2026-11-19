// test/modules.nodetest.mjs - the contract battery for EVERY module and bed on disk.
//
// Modules and beds are found by tools/make_registry.js scanEngine (the files on
// disk, not a possibly stale registry.js). For each module:
// - validateModuleShape is clean;
// - process at the default, at min and max of each number param (one at a
//   time), every choice and the other side of every switch, on a 1 s synthetic
//   voice at 48 kHz and at 22.05 kHz: no exception, no NaN or Infinity, peak
//   under 8, the right channel count for its stereo mode, and an output length
//   of input + tail (within 10 ms) unless the module warps time;
// - at the defaults also on silence, a single click, a stereo take and an
//   empty take (which may come back empty, so its length is not judged);
// - the same seed gives the same output;
// - when it has live: run at block sizes 128 and 480 and compared (within 1e-4
//   unless two different seeds already give different outputs, which marks a
//   module as random), plus a stereo run, an in-place run (outs aliasing ins),
//   a set() to the far ends of every param and a reset(), with no exceptions or
//   NaN.
// Each module is one test that collects every failure before it reports, so
// one run lists everything wrong with it. There is no list of excused modules:
// an earlier version ran known failures as todo, which let the suite report
// zero failures while real ones remained, so every failure now fails the suite.
// Beds: 3 s at 48 kHz, stereo, exactly 3 s long, not silent, peak under 1.5, deterministic.
//
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test "engine/test/modules.nodetest.mjs"
// VC_ONLY=<id prefix> limits the run (for example VC_ONLY=pitch.).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { synthVoice, silence, impulse } from './fixtures.mjs'
import { scanEngine } from '../tools/make_registry.js'
import { validateModuleShape, resolveParams } from '../core/params.js'
import { makeRng } from '../core/rng.js'

const scan = await scanEngine()
const ONLY = process.env.VC_ONLY || ''

const V48 = synthVoice(48000, 1, { seed: 11 })
const V22 = synthVoice(22050, 1, { seed: 12 })
const V48B = synthVoice(48000, 1, { seed: 13, f0: 210 })
const STEREO = { sr: 48000, ch: [V48.ch[0], V48B.ch[0]] }
const SILENCE = silence(48000, 1)
const CLICK = impulse(48000, 0.5, 0.25, 1)
const EMPTY = { sr: 48000, ch: [new Float32Array(0)] }

function clone(b) {
  return { sr: b.sr, ch: b.ch.map((c) => new Float32Array(c)) }
}

function ctxFor(mod, sr, seed = 'battery') {
  return {
    sr,
    rng: makeRng(seed).fork(mod.id),
    progress() {},
    cancelled: () => false,
    side: null,
    note() {},
    seconds: 1,
  }
}

function variants(mod) {
  const out = [{ label: 'defaults', p: {} }]
  for (const param of mod.params || []) {
    if (param.type === 'number') {
      out.push({ label: param.id + '=min ' + param.min, p: { [param.id]: param.min } })
      out.push({ label: param.id + '=max ' + param.max, p: { [param.id]: param.max } })
    } else if (param.type === 'choice') {
      for (const o of param.options || []) if (o.v !== param.def) out.push({ label: param.id + '=' + o.v, p: { [param.id]: o.v } })
    } else if (param.type === 'bool') {
      out.push({ label: param.id + '=' + !param.def, p: { [param.id]: !param.def } })
    }
  }
  return out
}

function checkOut(out, input, mod, p, label, fails, skipLength) {
  if (!out || !Array.isArray(out.ch) || !out.ch.length) {
    fails.push(label + ': returned no buffer')
    return null
  }
  if (out.sr !== input.sr) fails.push(label + ': sample rate changed from ' + input.sr + ' to ' + out.sr)
  const n = out.ch[0].length
  let pk = 0
  for (let c = 0; c < out.ch.length; c++) {
    const s = out.ch[c]
    if (!(s instanceof Float32Array)) fails.push(label + ': channel ' + c + ' is not a Float32Array')
    if (s.length !== n) fails.push(label + ': channel lengths differ')
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (!Number.isFinite(v)) {
        fails.push(label + ': sample ' + i + ' of channel ' + c + ' is ' + v)
        return null
      }
      const a = v < 0 ? -v : v
      if (a > pk) pk = a
    }
  }
  if (pk >= 8) fails.push(label + ': peak ' + pk.toFixed(2) + ' is 8 or more')
  const want = mod.stereo === 'make' ? 2 : mod.stereo === 'mono' ? 1 : input.ch.length
  if (out.ch.length !== want) fails.push(label + ': ' + out.ch.length + ' channels out, expected ' + want + ' (stereo: ' + mod.stereo + ')')
  if (!mod.warps && !skipLength) {
    let tail = 0
    try {
      tail = typeof mod.tail === 'function' ? Number(mod.tail(p, input.sr)) || 0 : 0
    } catch (e) {
      fails.push(label + ': tail threw ' + e.message)
    }
    const expect = input.ch[0].length + Math.round(tail * input.sr)
    if (Math.abs(n - expect) > 0.01 * input.sr) {
      fails.push(label + ': length ' + (n / input.sr).toFixed(3) + ' s, expected input + tail = ' + (expect / input.sr).toFixed(3) + ' s')
    }
  }
  return out
}

function run(mod, input, raw, label, fails, seed, skipLength = false) {
  const p = resolveParams(mod, raw)
  const inp = clone(input)
  let out
  try {
    out = mod.process(inp, p, ctxFor(mod, input.sr, seed))
  } catch (e) {
    fails.push(label + ': threw ' + (e && e.message ? e.message : String(e)))
    return null
  }
  if (out && typeof out.then === 'function') {
    fails.push(label + ': process returned a promise')
    return null
  }
  return checkOut(out, input, mod, p, label, fails, skipLength)
}

function same(a, b, tol = 0) {
  if (!a || !b || a.ch.length !== b.ch.length) return false
  for (let c = 0; c < a.ch.length; c++) {
    if (a.ch[c].length !== b.ch[c].length) return false
    for (let i = 0; i < a.ch[c].length; i++) if (Math.abs(a.ch[c][i] - b.ch[c][i]) > tol) return false
  }
  return true
}

function liveRun(mod, p, input, block, seed, opts = {}) {
  const sr = input.sr
  const inst = mod.live.create(sr, p, makeRng(seed).fork(mod.id + ':live'))
  const nIn = input.ch.length
  const nOut = mod.stereo === 'make' ? 2 : mod.stereo === 'mono' ? 1 : nIn
  const n = input.ch[0].length
  const src = input.ch.map((c) => new Float32Array(c))
  const outs = []
  for (let c = 0; c < nOut; c++) outs.push(new Float32Array(n))
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    if (opts.setAt !== undefined && i >= opts.setAt && !opts._set) {
      inst.set(opts.setP)
      opts._set = true
    }
    const ins = src.map((c) => c.subarray(i, i + m))
    let o
    if (opts.alias && nOut === nIn) o = ins
    else o = outs.map((c) => c.subarray(i, i + m))
    inst.process(ins, o, m)
    if (opts.alias && nOut === nIn) for (let c = 0; c < nOut; c++) outs[c].set(ins[c], i)
  }
  if (opts.reset) inst.reset()
  return { sr, ch: outs }
}

function finiteBuf(b) {
  for (const c of b.ch) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) return false
  return true
}

function extremes(mod, which) {
  const p = {}
  for (const param of mod.params || []) {
    if (param.type === 'number') p[param.id] = which === 'max' ? param.max : param.min
    else if (param.type === 'choice') {
      const o = param.options || []
      if (o.length) p[param.id] = which === 'max' ? o[o.length - 1].v : o[0].v
    } else if (param.type === 'bool') p[param.id] = which === 'max'
  }
  return resolveParams(mod, p)
}

const timing = []

for (const { rel, mod } of scan.modules) {
  if (ONLY && !mod.id.startsWith(ONLY)) continue
  test('module ' + mod.id + ' (' + rel + ')', { timeout: 600000 }, () => {
    const fails = []
    for (const s of validateModuleShape(mod)) fails.push('shape: ' + s)
    const t0 = performance.now()
    const def48 = run(mod, V48, {}, '48k defaults', fails, 'battery')
    timing.push({ id: mod.id, ms: performance.now() - t0, cost: mod.cost })
    const again = run(mod, V48, {}, '48k defaults again', fails, 'battery')
    if (def48 && again && !same(def48, again)) fails.push('the same seed gave a different output')
    for (const v of variants(mod)) {
      if (v.label !== 'defaults') run(mod, V48, v.p, '48k ' + v.label, fails)
      run(mod, V22, v.p, '22k ' + v.label, fails)
    }
    run(mod, SILENCE, {}, 'silence', fails)
    run(mod, CLICK, {}, 'click', fails)
    run(mod, STEREO, {}, 'stereo', fails)
    // an empty take may come back empty: a tail after nothing is not required
    run(mod, EMPTY, {}, 'empty take', fails, 'battery', true)
    if (mod.live) {
      try {
        const p = resolveParams(mod, {})
        const a = liveRun(mod, p, V48, 128, 'live')
        const b = liveRun(mod, p, V48, 480, 'live')
        const c = liveRun(mod, p, V48, 128, 'other-seed')
        if (!finiteBuf(a) || !finiteBuf(b)) fails.push('live: NaN or Infinity in the output')
        const random = !same(a, c, 1e-9)
        if (!random && !same(a, b, 1e-4)) {
          let worst = 0
          for (let ch = 0; ch < a.ch.length; ch++) for (let i = 0; i < a.ch[ch].length; i++) worst = Math.max(worst, Math.abs(a.ch[ch][i] - b.ch[ch][i]))
          fails.push('live: blocks of 128 and 480 differ by up to ' + worst.toExponential(2))
        }
        const st = liveRun(mod, p, STEREO, 128, 'live')
        if (!finiteBuf(st)) fails.push('live stereo: NaN or Infinity')
        const al = liveRun(mod, p, V48, 128, 'live', { alias: true })
        if (!finiteBuf(al)) fails.push('live in place: NaN or Infinity')
        for (const which of ['min', 'max']) {
          const s = liveRun(mod, p, V48, 480, 'live', { setAt: 24000, setP: extremes(mod, which), reset: true })
          if (!finiteBuf(s)) fails.push('live set() to ' + which + ': NaN or Infinity')
          let pk = 0
          for (const ch of s.ch) for (const x of ch) pk = Math.max(pk, Math.abs(x))
          if (pk >= 8) fails.push('live set() to ' + which + ': peak ' + pk.toFixed(2))
        }
        const lat = mod.live.latency(p, 48000)
        if (!(Number.isFinite(lat) && lat >= 0)) fails.push('live latency is ' + lat)
      } catch (e) {
        fails.push('live: threw ' + (e && e.message ? e.message : String(e)))
      }
    }
    assert.deepEqual(fails, [], mod.id + ' has ' + fails.length + ' problems:\n' + fails.slice(0, 40).join('\n'))
  })
}

for (const { rel, bed } of scan.beds) {
  if (ONLY && !('bed:' + bed.id).startsWith(ONLY)) continue
  test('bed ' + bed.id + ' (' + rel + ')', { timeout: 300000 }, () => {
    const fails = []
    const p = resolveParams(bed, {})
    const gen = (seed) => bed.generate(3, 48000, p, makeRng(seed).fork('bed:' + bed.id))
    let a
    let b
    try {
      a = gen('bed')
      b = gen('bed')
    } catch (e) {
      assert.fail('generate threw ' + e.message)
    }
    if (!a || !Array.isArray(a.ch)) assert.fail('generate returned no buffer')
    if (a.ch.length !== 2) fails.push(a.ch.length + ' channels, expected stereo')
    if (a.sr !== 48000) fails.push('sample rate ' + a.sr)
    for (const c of a.ch) if (Math.abs(c.length - 144000) > 1) fails.push('length ' + c.length / 48000 + ' s, expected 3 s')
    let pk = 0
    let e = 0
    for (const c of a.ch) {
      for (let i = 0; i < c.length; i++) {
        const v = c[i]
        if (!Number.isFinite(v)) {
          fails.push('sample ' + i + ' is ' + v)
          break
        }
        pk = Math.max(pk, Math.abs(v))
        e += v * v
      }
    }
    if (pk >= 1.5) fails.push('peak ' + pk.toFixed(2) + ' is 1.5 or more')
    if (Math.sqrt(e / (2 * 144000)) < 1e-4) fails.push('silent')
    if (!same(a, b)) fails.push('the same seed gave a different background')
    assert.deepEqual(fails, [], bed.id + ':\n' + fails.join('\n'))
  })
}

test('speed per second of 48 kHz audio at defaults (printed, not judged)', () => {
  const rows = timing.sort((x, y) => y.ms - x.ms).map((t) => t.id + ' ' + t.ms.toFixed(0) + ' ms (cost ' + t.cost + ')')
  if (process.env.VC_TIMING) console.log(rows.join('\n'))
  assert.ok(true)
})
