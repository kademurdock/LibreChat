// test/frame.nodetest.mjs - the engine frame: render pipeline, macros, beds, the side input,
// loudness and true peak, determinism, cancellation, catalog search and combos,
// make_registry in a temporary copy, the Worker message handler, the page client
// (inline mode) and the iPhone bridge protocol, all with mocks.
//
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test "engine/test/frame.nodetest.mjs"

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { synthVoice, silence } from './fixtures.mjs'
import { medianF0 } from './measure.mjs'

const ENGINE = fileURLToPath(new URL('../', import.meta.url))
const NODE = process.execPath
if (!existsSync(join(ENGINE, 'registry.js')) || !existsSync(join(ENGINE, 'presets.generated.js'))) {
  spawnSync(NODE, [join(ENGINE, 'tools', 'make_registry.js'), '--quiet'], { encoding: 'utf8' })
}

const R = await import('../render.js')
const C = await import('../catalog.js')
const { lufs, truePeakDb } = await import('../core/loudness.js')
const { encodeWav, decodeWav } = await import('../core/wav.js')
const { makeRng } = await import('../core/rng.js')
const { createHandler } = await import('../host/worker.js')
const { createBridge, install, b64encode, b64decode, SLICE_CHARS } = await import('../host/bridge.js')
const { createEngine } = await import('../host/client.js')
const { getModule: regModule } = await import('../registry.js')

const { renderPreset, renderPreview, renderChain, renderPresetAsync, VCError, loopTo } = R

function voice(sr = 48000, seconds = 2.5, opts = {}) {
  return synthVoice(sr, seconds, opts)
}

function scaled(b, g) {
  return { sr: b.sr, ch: b.ch.map((c) => c.map((v) => v * g)) }
}

function finite(b) {
  for (const c of b.ch) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) return false
  return true
}

function corr(a, b) {
  const n = Math.min(a.length, b.length)
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
}

function sameBuf(a, b) {
  if (a.ch.length !== b.ch.length) return false
  for (let c = 0; c < a.ch.length; c++) {
    if (a.ch[c].length !== b.ch[c].length) return false
    for (let i = 0; i < a.ch[c].length; i++) if (a.ch[c][i] !== b.ch[c][i]) return false
  }
  return true
}

const P = (chain, extra = {}) => ({ id: 'test', name: 'Test preset', chain, seed: 1, ...extra })

// ---------------------------------------------------------------- pipeline

test('renders a preset to -16 LUFS under -1 dBTP, same length, input untouched', () => {
  const v = voice()
  const copy = v.ch[0].slice()
  const { buf, report } = renderPreset(v, P([{ m: 'pitch.voice', p: { semitones: -4 } }]))
  assert.ok(finite(buf))
  assert.equal(buf.ch[0].length, v.ch[0].length)
  assert.ok(Math.abs(lufs(buf) + 16) <= 1, 'loudness ' + lufs(buf))
  assert.ok(truePeakDb(buf) <= -0.9, 'true peak ' + truePeakDb(buf))
  assert.deepEqual(v.ch[0], copy)
  assert.equal(report.stages.length, 1)
  assert.equal(report.stages[0].m, 'pitch.voice')
  assert.ok(report.ms > 0 && Array.isArray(report.notes))
})

test('a hot, distorted chain still lands within 1 LU of -16 and under the ceiling', () => {
  const v = scaled(voice(48000, 2.5, { seed: 3 }), 2.5)
  const { buf } = renderPreset(v, P([{ m: 'lofi.drive', p: { drive: 48, character: 'hard' } }, { m: 'tone.gain', p: { db: 18 } }]))
  assert.ok(Math.abs(lufs(buf) + 16) <= 1, 'loudness ' + lufs(buf))
  assert.ok(truePeakDb(buf) <= -0.9, 'true peak ' + truePeakDb(buf))
})

// Engine fix, Oct 22 2026: the final limiter takes at most 6 dB.
test('a chain with very sharp peaks is left quieter, with a note, instead of being squashed past 6 dB', () => {
  const v = voice(48000, 3, { seed: 5 })
  const clicks = {
    id: 'test.clicks', name: 'Clicks', family: 'test', params: [], stereo: 'keep', tail: () => 0, warps: false, cost: 1,
    process(input) {
      const s = input.ch[0]
      for (let i = 1000; i < s.length; i += 12000) s[i] += 3
      return input
    },
  }
  const getModule = (id) => (id === 'test.clicks' ? clicks : regModule(id))
  const pre = v.ch[0].slice()
  for (let i = 1000; i < pre.length; i += 12000) pre[i] += 3
  const { buf, report } = renderChain(v, [{ m: 'test.clicks' }], { getModule, cleanup: false })
  assert.ok(finite(buf))
  assert.ok(truePeakDb(buf) <= -0.9, 'true peak ' + truePeakDb(buf))
  assert.ok(report.loudnessLoweredDb > 3, 'lowered by ' + report.loudnessLoweredDb)
  assert.ok(report.preLimitPeakDb <= 5.05, 'pre-limit peak ' + report.preLimitPeakDb)
  assert.ok(report.notes.some((n) => /sharp peaks/.test(n) && /quieter/.test(n)), JSON.stringify(report.notes))
  assert.ok(Math.abs(report.lufs - (-16 - report.loudnessLoweredDb)) < 0.6, 'lufs ' + report.lufs + ' lowered ' + report.loudnessLoweredDb)
  // the gain the render applied away from the clicks, and so the limiting the clicks got
  const ratios = []
  for (let i = 0; i < pre.length; i += 7) {
    const near = (i - 1000) % 12000
    if (Math.abs(pre[i]) > 0.05 && near > 600 && near < 11400) ratios.push(buf.ch[0][i] / pre[i])
  }
  ratios.sort((a, b) => a - b)
  const g = ratios[ratios.length >> 1]
  let pk = 0
  for (let i = 0; i < pre.length; i++) pk = Math.max(pk, Math.abs(pre[i]))
  const gr = 20 * Math.log10(g * pk) + 1
  assert.ok(gr <= 6.5, 'the clicks were limited by ' + gr.toFixed(1) + ' dB')
  // an ordinary voice is not touched by the guard
  const plain = renderChain(voice(48000, 3, { seed: 5 }), [{ m: 'tone.gain' }])
  assert.equal(plain.report.loudnessLoweredDb, 0)
  assert.ok(!plain.report.notes.some((n) => /sharp peaks/.test(n)))
  assert.ok(Math.abs(plain.report.lufs + 16) <= 0.5)
})

test('loudness target and volume macro move the level; loudness null leaves it alone', () => {
  const v = voice()
  const a = renderPreset(v, P([{ m: 'tone.gain', p: {} }]), { loudness: -20 })
  assert.ok(Math.abs(lufs(a.buf) + 20) <= 1)
  const b = renderPreset(v, P([{ m: 'tone.gain', p: {} }]), { macros: { volume: -6 } })
  assert.ok(Math.abs(lufs(b.buf) + 22) <= 1)
  const q = scaled(v, 0.05)
  const c = renderPreset(q, P([{ m: 'tone.gain', p: {} }]), { loudness: null, cleanup: false })
  assert.ok(Math.abs(lufs(c.buf) - lufs(q)) < 0.5)
})

test('pitch macro inserts a pitch stage when the chain has none', () => {
  const v = voice(48000, 2)
  const { buf, report } = renderPreset(v, P([{ m: 'tone.gain', p: { db: -3 } }]), { macros: { pitch: 12 } })
  assert.equal(report.stages[0].m, 'pitch.voice')
  assert.equal(report.stages.length, 2)
  const ratio = medianF0(buf.ch[0], 48000) / medianF0(v.ch[0], 48000)
  assert.ok(Math.abs(ratio - 2) < 0.12, 'pitch ratio ' + ratio)
})

test('pitch macro adds to the first pitch.voice stage', () => {
  const v = voice(48000, 2)
  const { buf, report } = renderPreset(v, P([{ m: 'pitch.voice', p: { semitones: -12 } }]), { macros: { pitch: 12 } })
  assert.equal(report.stages.length, 1)
  const ratio = medianF0(buf.ch[0], 48000) / medianF0(v.ch[0], 48000)
  assert.ok(Math.abs(ratio - 1) < 0.05, 'pitch ratio ' + ratio)
})

test('speed macro changes the duration and keeps the pitch', () => {
  const v = voice(48000, 3)
  const { buf, report } = renderPreset(v, P([{ m: 'tone.gain', p: {} }]), { macros: { speed: 2 } })
  const secs = buf.ch[0].length / 48000
  assert.ok(Math.abs(secs - 1.5) < 0.05, 'seconds ' + secs)
  assert.equal(report.stages[0].m, 'macro.speed')
  const ratio = medianF0(buf.ch[0], 48000) / medianF0(v.ch[0], 48000)
  assert.ok(Math.abs(ratio - 1) < 0.07, 'pitch ratio ' + ratio)
})

test('amount 0 gives back the dry voice; 50 sits between', () => {
  const v = voice()
  const chain = [{ m: 'synth.ringmod', p: { freq: 300 } }]
  const dry = renderPreset(v, P([{ m: 'tone.gain', p: {} }])).buf
  const wet = renderPreset(v, P(chain)).buf
  const zero = renderPreset(v, P(chain), { macros: { amount: 0 } }).buf
  const half = renderPreset(v, P(chain), { macros: { amount: 50 } }).buf
  assert.ok(corr(zero.ch[0], dry.ch[0]) > 0.999)
  const cd = corr(half.ch[0], dry.ch[0])
  const cw = corr(half.ch[0], wet.ch[0])
  assert.ok(cd > 0.3 && cd < 0.99 && cw > 0.3 && cw < 0.99, cd + ' ' + cw)
})

test('amount is skipped, and says so, when a stage warps time', () => {
  const v = voice()
  const chain = [{ m: 'time.reverse', p: {} }]
  const full = renderPreset(v, P(chain))
  const half = renderPreset(v, P(chain), { macros: { amount: 50 } })
  assert.match(half.report.amountSkipped, /timing/)
  assert.ok(half.report.notes.some((n) => /timing/.test(n)))
  assert.equal(full.report.amountSkipped, null)
  assert.ok(sameBuf(full.buf, half.buf))
})

test('width 0 folds to mono, 200 widens', () => {
  const v = voice()
  const chain = [{ m: 'stereo.place', p: { angle: 60 } }]
  const narrow = renderPreset(v, P(chain), { macros: { width: 0 } }).buf
  assert.ok(corr(narrow.ch[0], narrow.ch[1]) > 0.9999)
  const base = renderPreset(v, P(chain)).buf
  const wide = renderPreset(v, P(chain), { macros: { width: 200 } }).buf
  assert.ok(corr(wide.ch[0], wide.ch[1]) < corr(base.ch[0], base.ch[1]))
})

// ---------------------------------------------------------------- beds

const TONE_BED = {
  id: 'test-hum',
  name: 'Test hum',
  group: 'test',
  about: 'A steady test tone.',
  params: [{ id: 'hz', name: 'Pitch', type: 'number', min: 50, max: 2000, def: 500, unit: 'hz' }],
  generate(seconds, sr, p, rng) {
    const n = Math.round(seconds * sr)
    const L = new Float32Array(n)
    const R2 = new Float32Array(n)
    const ph = rng.next()
    for (let i = 0; i < n; i++) {
      L[i] = 0.2 * Math.sin(2 * Math.PI * (p.hz * i / sr + ph))
      R2[i] = 0.2 * Math.sin(2 * Math.PI * (p.hz * i / sr + ph + 0.25))
    }
    return { sr, ch: [L, R2] }
  },
}
const getBed = (id) => (id === 'test-hum' ? TONE_BED : null)

function bedPart(withBed, without) {
  const n = withBed.ch[0].length
  const L = new Float32Array(n)
  const Rr = new Float32Array(n)
  const w0 = without.ch[0]
  const w1 = without.ch[without.ch.length - 1]
  for (let i = 0; i < n; i++) {
    L[i] = withBed.ch[0][i] - w0[i]
    Rr[i] = withBed.ch[1][i] - w1[i]
  }
  return { sr: withBed.sr, ch: [L, Rr] }
}

test('a synthesized bed sits at its level relative to the voice', () => {
  const v = scaled(voice(), 0.4)
  const opts = { loudness: null, cleanup: false, getBed }
  const without = renderPreset(v, P([{ m: 'tone.gain', p: {} }]), opts).buf
  const { buf, report } = renderPreset(v, P([{ m: 'tone.gain', p: {} }], { bed: { b: 'test-hum', level: -10, fade: false } }), opts)
  assert.equal(buf.ch.length, 2)
  const rel = lufs(bedPart(buf, without)) - lufs(without)
  assert.ok(Math.abs(rel + 10) < 0.8, 'bed sits ' + rel + ' dB from the voice')
  assert.equal(report.bed.bed, 'test-hum')
  // the macro can remove or replace the preset's bed
  const none = renderPreset(v, P([{ m: 'tone.gain', p: {} }], { bed: { b: 'test-hum', level: -10 } }), { ...opts, macros: { bed: null } })
  assert.equal(none.report.bed, null)
  assert.equal(none.buf.ch.length, 1)
})

test('ducking lowers the bed while the voice speaks', () => {
  const v = scaled(voice(), 0.4)
  const opts = { loudness: null, cleanup: false, getBed }
  const without = renderPreset(v, P([{ m: 'tone.gain', p: {} }]), opts).buf
  const plain = renderPreset(v, P([{ m: 'tone.gain', p: {} }], { bed: { b: 'test-hum', level: -10, fade: false } }), opts).buf
  const ducked = renderPreset(v, P([{ m: 'tone.gain', p: {} }], { bed: { b: 'test-hum', level: -10, fade: false, duck: 12 } }), opts).buf
  const d = lufs(bedPart(plain, without)) - lufs(bedPart(ducked, without))
  assert.ok(d > 4, 'ducking took off only ' + d + ' dB')
})

test('fades shape the bed in and out', () => {
  const v = silence(48000, 3)
  const opts = { loudness: null, cleanup: false, getBed }
  const { buf } = renderPreset(v, P([{ m: 'tone.gain', p: {} }], { bed: { b: 'test-hum', level: -10, fade: { in: 1, out: 1 } } }), opts)
  let first = 0
  let mid = 0
  for (let i = 0; i < 2400; i++) first = Math.max(first, Math.abs(buf.ch[0][i]))
  for (let i = 72000; i < 74400; i++) mid = Math.max(mid, Math.abs(buf.ch[0][i]))
  assert.ok(mid > 0.01 && first < mid * 0.05, first + ' ' + mid)
})

test('a sound-file bed is resampled, looped and started at a seeded offset', () => {
  const v = voice(48000, 3)
  const rng = makeRng('loop')
  const n = Math.round(0.7 * 22050)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = (rng.next() * 2 - 1) * 0.3
  const bedAudio = { sr: 22050, ch: [s] }
  const preset = P([{ m: 'tone.gain', p: {} }], { bed: { file: 'loop-test', level: -12 } })
  const a = renderPreset(v, preset, { bedAudio })
  const b = renderPreset(v, preset, { bedAudio: { 'loop-test': bedAudio } })
  const c = renderPreset(v, preset, { bedAudio, seed: 7 })
  assert.equal(a.buf.ch.length, 2)
  assert.ok(a.report.bed && a.report.bed.bed === 'file:loop-test')
  assert.ok(sameBuf(a.buf, b.buf))
  assert.ok(!sameBuf(a.buf, c.buf))
  // still sounding near the end, well past the 0.7 s file
  const end = a.buf.ch[0].subarray(a.buf.ch[0].length - 24000)
  let e = 0
  for (let i = 0; i < end.length; i++) e += end[i] * end[i]
  assert.ok(e > 0)
  const missing = renderPreset(v, preset, {})
  assert.ok(missing.report.notes.some((x) => /background/.test(x)))
})

test('loopTo: exact length, equal-power crossfade, no jump at the seam', () => {
  const sr = 1000
  const one = new Float32Array(3000).fill(1)
  const out = loopTo([one], 10000, sr, 1234)[0]
  assert.equal(out.length, 10000)
  let lo = Infinity
  let hi = 0
  for (const x of out) {
    lo = Math.min(lo, x)
    hi = Math.max(hi, x)
  }
  assert.ok(lo >= 0.999 && hi <= Math.SQRT2 + 1e-6, lo + ' ' + hi)
  // a slow ramp loops without a sample-to-sample jump bigger than the crossfade's own slope
  const ramp = new Float32Array(3000)
  for (let i = 0; i < 3000; i++) ramp[i] = Math.sin((2 * Math.PI * i) / 3000)
  const r = loopTo([ramp], 9000, sr, 0)[0]
  let jump = 0
  for (let i = 1; i < r.length; i++) jump = Math.max(jump, Math.abs(r[i] - r[i - 1]))
  assert.ok(jump < 0.02, 'jump ' + jump)
  const short = loopTo([new Float32Array([0.5, 0.25])], 7, sr, 0)[0]
  assert.equal(short.length, 7)
})

// ---------------------------------------------------------------- side input and notes

test('the side input reaches only side modules, at the take rate and length; notes are collected', () => {
  const seen = []
  const sideMod = {
    id: 'test.side',
    name: 'Side test',
    family: 'test',
    side: true,
    params: [],
    stereo: 'keep',
    cost: 1,
    process(input, p, ctx) {
      seen.push({ side: ctx.side, len: input.ch[0].length, sr: ctx.sr })
      ctx.note('Side test was here.')
      ctx.note('Side test was here.')
      return input
    },
  }
  const plain = { ...sideMod, id: 'test.plain', side: false }
  const getModule = (id) => (id === 'test.side' ? sideMod : id === 'test.plain' ? plain : regModule(id))
  const v = voice(48000, 2)
  const sideAudio = { sr: 24000, ch: [new Float32Array(12000).fill(0.1)] }
  const { report } = renderPreset(v, P([{ m: 'test.plain', p: {} }, { m: 'test.side', p: {} }]), { getModule, sideAudio })
  assert.equal(seen[0].side, null)
  assert.ok(seen[1].side && seen[1].side.sr === 48000)
  assert.equal(seen[1].side.ch[0].length, seen[1].len)
  assert.deepEqual(report.notes, ['Side test was here.'])
  // a stage that changes the length gets a side sound of its own new length
  seen.length = 0
  renderPreset(v, P([{ m: 'pitch.tempo', p: { tempo: 2 } }, { m: 'test.side', p: {} }]), { getModule, sideAudio })
  assert.equal(seen[0].side.ch[0].length, seen[0].len)
  assert.ok(Math.abs(seen[0].len - 48000) < 2000)
})

// ---------------------------------------------------------------- determinism, errors, cancel

test('same seed, same sound; renders are deterministic', () => {
  const v = voice()
  const preset = P([{ m: 'device.cb', p: {} }, { m: 'echo.delay', p: {} }])
  assert.ok(sameBuf(renderPreset(v, preset).buf, renderPreset(v, preset).buf))
})

test('bad presets throw VCError with a plain sentence', () => {
  const v = voice(48000, 0.5)
  assert.throws(() => renderPreset(v, P([{ m: 'nope.nothing' }])), (e) => e instanceof VCError && /no effect called/.test(e.message))
  assert.throws(() => renderPreset(v, P([{ m: 'pitch.voice', p: { wobble: 3 } }])), (e) => e instanceof VCError && /no setting called/.test(e.message))
  assert.throws(() => renderPreset(v, P([{ m: 'pitch.voice', p: { mode: 'loud' } }])), (e) => e instanceof VCError && e.code === 'bad-params')
  assert.throws(() => renderPreset(null, P([{ m: 'tone.gain' }])), (e) => e instanceof VCError && e.code === 'no-input')
  assert.throws(() => renderPreset(v, P([{ m: 'tone.gain' }], { bed: { b: 'no-such-bed' } })), (e) => e instanceof VCError && /no background/.test(e.message))
  // clamping is not an error: macros push past the ends on purpose
  assert.doesNotThrow(() => renderPreset(v, P([{ m: 'pitch.voice', p: { semitones: 99 } }])))
})

test('empty and silent takes come back clean', () => {
  const e = renderPreset({ sr: 48000, ch: [new Float32Array(0)] }, P([{ m: 'echo.delay', p: {} }]))
  assert.ok(finite(e.buf))
  const s = renderPreset(silence(48000, 1), P([{ m: 'pitch.voice', p: { semitones: 3 } }]))
  assert.ok(finite(s.buf))
  assert.equal(s.report.lufs <= -70, true)
})

test('cancellation stops a render between stages, sync and async', async () => {
  const v = voice(48000, 2)
  const preset = P([{ m: 'tone.gain', p: {} }, { m: 'echo.delay', p: {} }, { m: 'space.reverb', p: {} }])
  let stages = 0
  assert.throws(
    () => renderPreset(v, preset, { cancelled: () => stages++ > 0 }),
    (e) => e instanceof VCError && e.code === 'cancelled'
  )
  let flag = false
  const prog = []
  const job = renderPresetAsync(v, preset, { progress: (f) => prog.push(f), cancelled: () => flag })
  setTimeout(() => {
    flag = true
  }, 0)
  await assert.rejects(job, (e) => e.code === 'cancelled')
  const prog2 = []
  const ok = await renderPresetAsync(v, preset, { progress: (f) => prog2.push(f) })
  assert.ok(finite(ok.buf))
  assert.equal(prog2[0], 0)
  assert.equal(prog2[prog2.length - 1], 1)
  for (let i = 1; i < prog2.length; i++) assert.ok(prog2[i] >= prog2[i - 1], 'progress went backwards')
  assert.ok(prog.length > 0)
})

test('renderPreview renders the asked-for window; renderChain works like a preset', () => {
  const v = voice(48000, 3)
  const { report } = renderPreview(v, P([{ m: 'tone.gain', p: {} }]), { start: 0.5, seconds: 1 })
  assert.ok(Math.abs(report.inputSeconds - 1) < 0.01)
  assert.ok(Math.abs(report.seconds - 1) < 0.01)
  const d = renderPreview(v, P([{ m: 'tone.gain', p: {} }]))
  assert.ok(Math.abs(d.report.inputSeconds - 3) < 0.01)
  const a = renderChain(v, [{ m: 'pitch.voice', p: { semitones: 2 } }], { seed: 1 })
  const b = renderPreset(v, P([{ m: 'pitch.voice', p: { semitones: 2 } }]))
  assert.ok(sameBuf(a.buf, b.buf))
})

test('works at 22.05 kHz and with stereo takes', () => {
  const v = voice(22050, 1.5)
  const st = { sr: 22050, ch: [v.ch[0], v.ch[0].map((x) => x * 0.5)] }
  const { buf } = renderPreset(st, P([{ m: 'pitch.voice', p: { semitones: -3 } }, { m: 'space.room', p: { space: 'bathroom' } }]))
  assert.equal(buf.ch.length, 2)
  assert.equal(buf.sr, 22050)
  assert.ok(finite(buf) && truePeakDb(buf) <= -0.9)
})

// ---------------------------------------------------------------- catalog

test('catalog: the 26 categories in contract order', () => {
  const ids = C.CATEGORIES.map((c) => c.id)
  assert.deepEqual(ids, ['everyday', 'disguise', 'robots', 'creatures', 'fantasy', 'scifi', 'critters', 'comedy', 'phones', 'retro', 'places', 'nature', 'vehicles', 'stereo', 'echo', 'music', 'broadcast', 'strange', 'spooky', 'studio', 'asmr', 'amps', 'beats', 'instruments', 'mastering', 'mix'])
  assert.equal(C.categoryShortName('mix'), 'Mix and match')
})

const FIX_ING = {
  voices: [
    { id: 'giant', name: 'Giant', say: 'a huge giant', chain: [{ m: 'pitch.voice', p: { semitones: -7 } }], tags: ['deep'] },
    { id: 'fairy', name: 'Tiny fairy', say: 'a tiny fairy', chain: [{ m: 'pitch.voice', p: { semitones: 9 } }] },
  ],
  places: [{ id: 'cave', name: 'in a cave', say: 'in a cave', chain: [{ m: 'space.room', p: { space: 'cave' } }] }],
  devices: [{ id: 'walkie', name: 'a walkie-talkie', say: 'a walkie-talkie', chain: [{ m: 'device.walkie', p: {} }] }],
  motions: [{ id: 'orbit', name: 'circling your head', say: 'circling your head', chain: [{ m: 'stereo.orbit', p: {} }] }],
}

test('catalog: combos have stable ids, spoken names and valid chains', () => {
  const a = C.buildCombos(FIX_ING)
  const b = C.buildCombos(JSON.parse(JSON.stringify(FIX_ING)))
  assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id))
  assert.deepEqual(a.map((p) => p.id), ['mix-giant-cave', 'mix-giant-walkie', 'mix-giant-orbit', 'mix-fairy-cave', 'mix-fairy-walkie', 'mix-fairy-orbit'])
  assert.equal(a[0].name, 'Giant, in a cave')
  assert.equal(a[1].name, 'Giant on a walkie-talkie')
  assert.equal(a[2].name, 'Giant circling your head')
  assert.equal(a[0].sub, 'Giant')
  for (const p of a) assert.deepEqual(C.validatePreset(p, { mix: true, checkDefaults: false }), [])
  assert.deepEqual(C.ingredientProblems(FIX_ING), [])
  const dupe = { ...FIX_ING, motions: [{ id: 'cave', name: 'again', chain: [{ m: 'tone.gain' }] }] }
  assert.ok(C.ingredientProblems(dupe).length > 0)
})

test('catalog: search ranks names first, ANDs words and forgives plurals', () => {
  const presets = [
    { id: 'tin-invader', name: 'Tin invader', cat: 'robots', sub: 'Classic', about: 'Metal ring-modulated voice.', tags: ['robot', 'metal'], chain: [{ m: 'synth.ringmod', p: {} }] },
    { id: 'robot-choir', name: 'Robot choir', cat: 'robots', sub: 'Choirs', about: 'Many robots singing.', tags: ['choir'], chain: [{ m: 'spec.robot', p: {} }] },
    { id: 'walkie-low', name: 'Walkie-talkie, low battery', cat: 'phones', sub: 'Radios', about: 'A weak handheld radio.', tags: ['radio'], chain: [{ m: 'device.walkie', p: {} }] },
  ]
  const cat = C.makeCatalog({ presets, ingredients: FIX_ING })
  assert.equal(cat.search('robot')[0].id, 'robot-choir')
  assert.ok(cat.search('robots').some((p) => p.id === 'tin-invader'))
  assert.deepEqual(cat.search('walkie battery').map((p) => p.id), ['walkie-low'])
  assert.equal(cat.search('walkie-talkie')[0].id, 'walkie-low')
  assert.ok(cat.search('fai').some((p) => p.id === 'mix-fairy-cave'))
  assert.deepEqual(cat.search('zzzz'), [])
  assert.deepEqual(cat.search(''), [])
  assert.equal(cat.getPreset('mix-giant-orbit').live, !!(regModule('pitch.voice').live && regModule('stereo.orbit').live))
  assert.equal(cat.byCategory('robots').length, 2)
})

test('catalog: picker lists never hold more than 150 presets', () => {
  const presets = []
  for (let i = 0; i < 230; i++) presets.push({ id: 'p' + i, name: 'Preset number ' + i, cat: 'strange', sub: i < 200 ? 'Big group' : 'Small group', about: 'x.', chain: [{ m: 'tone.gain', p: {} }] })
  presets.push({ id: 'one', name: 'Only one', cat: 'studio', sub: 'A', about: 'x.', chain: [{ m: 'tone.gain', p: {} }] })
  const lists = C.makeCatalog({ presets }).pickerLists()
  for (const l of lists) assert.ok(l.count <= 150 && l.ids.length === l.count)
  const strange = lists.filter((l) => l.cat === 'strange')
  assert.deepEqual(strange.map((l) => l.name), ['Strange and experimental: Big group, part 1', 'Strange and experimental: Big group, part 2', 'Strange and experimental: Small group'])
  assert.equal(lists.find((l) => l.cat === 'studio').name, 'Studio and cleanup')
  assert.equal(strange.reduce((a, l) => a + l.count, 0), 230)
  // the real catalog too
  for (const l of C.pickerLists()) assert.ok(l.count <= 150, l.name + ' has ' + l.count)
})

test('catalog: validatePreset finds the plain problems', () => {
  const good = { id: 'much-deeper', name: 'Much deeper voice', cat: 'everyday', sub: 'Deeper', about: 'Lower.', chain: [{ m: 'pitch.voice', p: { semitones: -6 } }] }
  assert.deepEqual(C.validatePreset(good), [])
  const has = (p, re) => C.validatePreset(p).some((s) => re.test(s))
  assert.ok(has({ ...good, id: 'Bad Id' }, /lowercase words/))
  assert.ok(has({ ...good, name: 'Deep' }, /2 to 6/))
  assert.ok(has({ ...good, name: '1 2 3' }, /only numbers/))
  assert.ok(has({ ...good, name: 'Deep like Michael' }, /michael/i))
  assert.ok(has({ ...good, name: 'Tiny smurf voice' }, /smurf/))
  assert.ok(has({ ...good, name: 'Starship voice jarvis' }, /jarvis/))
  assert.ok(has({ ...good, cat: 'nope' }, /26 categories/))
  assert.ok(has({ ...good, cat: 'mix' }, /generated/))
  assert.ok(has({ ...good, about: 'x'.repeat(130) }, /under 120/))
  assert.ok(has({ ...good, about: 'One. Two.' }, /one sentence/))
  assert.ok(has({ ...good, chain: [] }, /1 to 8/))
  assert.ok(has({ ...good, chain: [{ m: 'nope.x' }] }, /not an effect/))
  assert.ok(has({ ...good, chain: [{ m: 'pitch.voice', p: { semi: 1 } }] }, /no setting called/))
  assert.ok(has({ ...good, chain: [{ m: 'pitch.voice', p: { semitones: 40 } }] }, /outside its range/))
  assert.ok(has({ ...good, chain: [{ m: 'pitch.voice', p: { semitones: 0.3 } }] }, /step/))
  assert.ok(has({ ...good, chain: [{ m: 'pitch.voice', p: { semitones: 0 } }] }, /default/))
  assert.ok(has({ ...good, chain: [{ m: 'pitch.voice', p: { mode: 'robot' } }] }, /no choice/))
  assert.ok(has({ ...good, bed: { b: 'nope' } }, /does not exist/))
  assert.ok(has({ ...good, chian: [] }, /unknown field/))
  // ordinary words that are also names are allowed
  assert.deepEqual(C.validatePreset({ ...good, name: 'Robin in the rose garden' }), [])
  const dup = C.validatePresets([good, { ...good }, { ...good, id: 'other' }])
  assert.ok(dup.some((s) => /used twice/.test(s)))
  assert.ok(dup.some((s) => /already used/.test(s)))
})

test('catalog: surprise picks deterministically and builds fresh chains that render', () => {
  const a = C.surprise(42)
  const b = C.surprise(42)
  assert.ok(a && a.id === b.id)
  const f1 = C.surprise(7, { fresh: true })
  const f2 = C.surprise(7, { fresh: true })
  assert.deepEqual(f1, f2)
  assert.ok(f1.chain.length >= 2 && f1.chain.length <= 4)
  for (const st of f1.chain) {
    const m = regModule(st.m)
    assert.ok(m && m.surprise !== false)
  }
  for (const seed of [1, 2, 3]) {
    const s = C.surprise(seed, { fresh: true })
    const { buf } = renderPreset(voice(48000, 1), s)
    assert.ok(finite(buf) && truePeakDb(buf) <= -0.9)
  }
})

// ---------------------------------------------------------------- make_registry

function copyEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-frame-'))
  cpSync(ENGINE, dir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ENGINE.length).replace(/\\/g, '/')
      return !rel.startsWith('test')
    },
  })
  return dir
}

function runTool(dir, args) {
  return spawnSync(NODE, [join(dir, 'tools', 'make_registry.js'), ...args], { cwd: dir, encoding: 'utf8', timeout: 120000 })
}

test('make_registry builds every generated file in a copy, atomically and repeatably', { timeout: 300000 }, async () => {
  const dir = copyEngine()
  try {
    for (const f of ['registry.js', 'presets.generated.js', 'manifest.json', 'catalog.json', 'modules.json', 'beds.json']) rmSync(join(dir, f), { force: true })
    const r = runTool(dir, [])
    assert.ok(r.status === 0 || r.status === 1, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.match(manifest.version, /^[0-9a-f]{12}$/)
    assert.ok(manifest.files.includes('render.js') && manifest.files.includes('registry.js'))
    assert.ok(!manifest.files.some((f) => f.startsWith('test/')))
    const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(catalog.version, manifest.version)
    assert.equal(catalog.categories.length, 26)
    assert.ok(catalog.presets.some((p) => p.cat === 'mix'))
    assert.ok(catalog.presets.every((p) => typeof p.live === 'boolean'))
    const mods = JSON.parse(readFileSync(join(dir, 'modules.json'), 'utf8'))
    assert.ok(mods.some((m) => m.id === 'pitch.voice'))
    assert.ok(JSON.parse(readFileSync(join(dir, 'beds.json'), 'utf8')).length > 0)
    const reg = await import(pathToFileURL(join(dir, 'registry.js')).href)
    assert.ok(reg.getModule('pitch.voice') && reg.MODULES.length === mods.length)
    const gen = await import(pathToFileURL(join(dir, 'presets.generated.js')).href)
    assert.ok(Array.isArray(gen.default) && gen.INGREDIENTS)
    // the same files give the same version; a changed preset gives a new one
    const again = runTool(dir, [])
    assert.ok(again.status === 0 || again.status === 1)
    assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version, manifest.version)
    const extra = [{ id: 'frame-test-extra', name: 'Frame test extra', cat: 'strange', sub: 'Tests', about: 'A test preset.', chain: [{ m: 'tone.gain', p: { db: -2 } }] }]
    writeFileSync(join(dir, 'presets', 'frametest.json'), JSON.stringify(extra))
    assert.ok([0, 1].includes(runTool(dir, []).status))
    const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.notEqual(m2.version, manifest.version)
    assert.ok(JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')).presets.some((p) => p.id === 'frame-test-extra'))
    // --check writes nothing
    rmSync(join(dir, 'catalog.json'))
    runTool(dir, ['--check'])
    assert.ok(!existsSync(join(dir, 'catalog.json')))
    // --only reports just the named file
    writeFileSync(join(dir, 'presets', 'broken.json'), JSON.stringify([{ id: 'Broken One', name: 'X', cat: 'nope', chain: [{ m: 'nope.thing' }] }]))
    const only = runTool(dir, ['--only', 'presets/broken.json'])
    assert.equal(only.status, 1)
    assert.match(only.stdout, /broken\.json/)
    assert.match(only.stdout, /not an effect that exists/)
    const onlyGood = runTool(dir, ['--only', 'presets/frametest.json'])
    assert.equal(onlyGood.status, 0, onlyGood.stdout)
    assert.ok(!existsSync(join(dir, 'catalog.json')))
    // a full run leaves the broken preset out and exits 1
    const full = runTool(dir, [])
    assert.equal(full.status, 1)
    assert.ok(!JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')).presets.some((p) => p.id === 'Broken One'))
    rmSync(join(dir, 'presets', 'broken.json'))
    // two runs at once both finish and leave whole files behind
    const both = await Promise.all(
      [0, 1].map(
        () =>
          new Promise((res) => {
            const ch = spawn(NODE, [join(dir, 'tools', 'make_registry.js'), '--quiet'], { cwd: dir })
            ch.on('exit', (code) => res(code))
          })
      )
    )
    for (const code of both) assert.ok(code === 0 || code === 1)
    JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'))
    JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.ok(statSync(join(dir, 'registry.js')).size > 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- hosts

function collector() {
  const msgs = []
  const transfers = []
  const post = (m, t) => {
    msgs.push(m)
    transfers.push(t || [])
  }
  return { msgs, transfers, post }
}

test('worker handler: load, getPreset, preview, render, errors and cancel', async () => {
  const { msgs, transfers, post } = collector()
  const handle = createHandler(post)
  const v = voice(48000, 1.5)
  await handle({ t: 'preview', req: 1, preset: 'tin-invader' })
  assert.equal(msgs.at(-1).t, 'error')
  assert.equal(msgs.at(-1).code, 'no-input')
  await handle({ t: 'load', req: 2, id: 'take', sr: v.sr, ch: [v.ch[0]] })
  assert.deepEqual([msgs.at(-1).t, msgs.at(-1).id], ['loaded', 'take'])
  await handle({ t: 'getPreset', req: 3, id: 'tin-invader' })
  assert.equal(msgs.at(-1).preset.id, 'tin-invader')
  await handle({ t: 'getPreset', req: 4, id: 'nope' })
  assert.equal(msgs.at(-1).preset, null)
  await handle({ t: 'preview', req: 5, preset: 'tin-invader', seconds: 1, macros: { pitch: 2 } })
  const done = msgs.at(-1)
  assert.equal(done.t, 'done')
  assert.equal(done.req, 5)
  assert.ok(done.ch[0] instanceof Float32Array && Math.abs(done.ch[0].length / done.sr - 1) < 0.2)
  assert.ok(transfers.at(-1).length === done.ch.length && transfers.at(-1)[0] === done.ch[0].buffer)
  assert.ok(msgs.some((m) => m.t === 'progress' && m.req === 5))
  assert.ok(done.report && done.report.lufs)
  await handle({ t: 'render', req: 6, chain: [{ m: 'pitch.voice', p: { semitones: 3 } }] })
  assert.equal(msgs.at(-1).t, 'done')
  await handle({ t: 'render', req: 7, preset: 'no-such-preset' })
  assert.match(msgs.at(-1).message, /no preset called/)
  await handle({ t: 'render', req: 8, chain: [{ m: 'nope.x' }] })
  assert.match(msgs.at(-1).message, /no effect called/)
  // a cancel that arrives while the render runs stops it
  const p = handle({ t: 'render', req: 9, chain: [{ m: 'tone.gain', p: {} }, { m: 'space.reverb', p: {} }, { m: 'echo.delay', p: {} }] })
  handle({ t: 'cancel', req: 9 })
  await p
  assert.equal(msgs.at(-1).code, 'cancelled')
  await handle({ t: 'whatever', req: 10 })
  assert.equal(msgs.at(-1).code, 'bad-request')
  await handle({ t: 'ping', req: 11 })
  assert.equal(msgs.at(-1).t, 'ready')
})

test('worker handler: the side and file-bed sounds are found by id', async () => {
  const { msgs, post } = collector()
  const handle = createHandler(post)
  const v = voice(48000, 1)
  await handle({ t: 'load', id: 'take', sr: 48000, ch: [v.ch[0]] })
  const noise = new Float32Array(24000)
  const rng = makeRng('n')
  for (let i = 0; i < noise.length; i++) noise[i] = rng.next() - 0.5
  await handle({ t: 'load', id: 'bed:test-loop', sr: 24000, ch: [noise] })
  await handle({ t: 'render', req: 1, preset: { id: 'x', name: 'X y', chain: [{ m: 'tone.gain', p: {} }], bed: { file: 'test-loop', level: -15 } } })
  const d = msgs.at(-1)
  assert.equal(d.t, 'done')
  assert.equal(d.report.bed.bed, 'file:test-loop')
  await handle({ t: 'render', req: 2, preset: { id: 'y', name: 'Y z', chain: [{ m: 'synth.ringmod', p: { shape: 'side' } }], side: 'test-loop' } })
  const e = msgs.at(-1)
  assert.equal(e.t, 'done')
  assert.ok(!e.report.notes.some((n) => /no other sound|instead/i.test(n)), e.report.notes.join(' '))
})

test('page client runs inline when there is no Worker', async () => {
  const vc = createEngine({ base: pathToFileURL(ENGINE).href })
  assert.equal(await vc.ready, 'inline')
  const v = voice(48000, 1)
  const fakeAudioBuffer = { sampleRate: 48000, numberOfChannels: 1, getChannelData: () => v.ch[0] }
  const loaded = await vc.load(fakeAudioBuffer)
  assert.ok(Math.abs(loaded.seconds - 1) < 0.01)
  assert.equal(v.ch[0].length, 48000, 'the page keeps its own audio')
  const prog = []
  const job = vc.preview('much-deeper-voice', { seconds: 1, onProgress: (f) => prog.push(f) })
  assert.ok(job.req)
  const r = await job
  assert.ok(r.ch[0].length > 40000 && r.report.lufs)
  assert.ok(prog.length > 0)
  assert.equal((await vc.getPreset('much-deeper-voice')).id, 'much-deeper-voice')
  await assert.rejects(vc.render('nope-nope'), /no preset/)
  vc.dispose()
})

test('base64 matches the standard encoder both ways', () => {
  const rng = makeRng('b64')
  for (const n of [0, 1, 2, 3, 4, 5, 1000, 4097]) {
    const u = new Uint8Array(n)
    for (let i = 0; i < n; i++) u[i] = rng.int(256)
    const s = b64encode(u)
    assert.equal(s, Buffer.from(u).toString('base64'))
    assert.deepEqual(Buffer.from(b64decode(s)), Buffer.from(u))
  }
})

test('iPhone bridge: feed a WAV in pieces, render, receive WAV slices, errors forwarded', async () => {
  const out = []
  const bridge = createBridge({ post: (m) => out.push(m), version: 'abc123' })
  assert.equal(bridge.catalogVersion(), 'abc123')
  const v = voice(24000, 1.2)
  const b64 = b64encode(encodeWav(v, 16))
  const third = Math.ceil(b64.length / 3)
  // pieces may come out of order; seq says where each goes
  bridge.feed('take', 1, b64.slice(third, 2 * third), false)
  bridge.feed('take', 0, b64.slice(0, third), false)
  assert.equal(bridge.feed('take', 2, b64.slice(2 * third), true), true)
  assert.equal(out.at(-1).t, 'loaded')
  assert.ok(Math.abs(out.at(-1).seconds - 1.2) < 0.01)
  const req = bridge.render(JSON.stringify({ req: 'p1', preset: 'tin-invader', preview: true, seconds: 1 }))
  assert.equal(req, 'p1')
  await bridge.handle({ t: 'ping' })
  await new Promise((r) => setTimeout(r, 0))
  const deadline = Date.now() + 30000
  while (!out.some((m) => m.t === 'done' && m.req === 'p1') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const chunks = out.filter((m) => m.t === 'chunk' && m.req === 'p1')
  const done = out.find((m) => m.t === 'done' && m.req === 'p1')
  assert.ok(done && done.chunks === chunks.length && chunks.at(-1).last === true)
  for (const c of chunks) assert.ok(c.b64.length <= SLICE_CHARS)
  const wav = decodeWav(b64decode(chunks.sort((a, b) => a.seq - b.seq).map((c) => c.b64).join('')))
  assert.equal(wav.sr, 24000)
  assert.ok(Math.abs(wav.ch[0].length / 24000 - 1) < 0.3)
  assert.ok(out.some((m) => m.t === 'progress' && m.req === 'p1'))
  assert.equal(JSON.parse(bridge.getPreset('tin-invader')).id, 'tin-invader')
  assert.equal(bridge.getPreset('nope'), 'null')
  assert.equal(bridge.render('{not json'), null)
  assert.equal(out.at(-1).t, 'error')
  bridge.feed('side', 0, 'AAAA', true)
  assert.match(out.at(-1).message, /could not be read/)
  bridge.render({ req: 'r2', preset: 'nope' })
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(out.some((m) => m.t === 'error' && m.req === 'r2'))
})

test('a sound the engine turns down is answered with its id, so a host waiting on that id hears', async () => {
  const { msgs, post } = collector()
  const handle = createHandler(post)
  await handle({ t: 'load', id: 'side', sr: 0, ch: [new Float32Array(10)] })
  assert.deepEqual([msgs.at(-1).t, msgs.at(-1).id, msgs.at(-1).code], ['error', 'side', 'bad-input'])
  assert.match(msgs.at(-1).message, /sample rate/)
  await handle({ t: 'load', req: 4, sr: 48000, ch: [] })
  assert.deepEqual([msgs.at(-1).t, msgs.at(-1).req, msgs.at(-1).id], ['error', 4, 'take'])
  // errors that are not about a sound keep their old shape
  await handle({ t: 'whatever', req: 5 })
  assert.equal('id' in msgs.at(-1), false)
  // the iPhone bridge passes the id on to native
  const out = []
  const bridge = createBridge({ post: (m) => out.push(m), version: 'v' })
  await bridge.handle({ t: 'load', id: 'bed:rain', sr: 0, ch: [new Float32Array(10)] })
  assert.deepEqual([out.at(-1).t, out.at(-1).req, out.at(-1).id, out.at(-1).code], ['error', null, 'bed:rain', 'bad-input'])
  // a file that cannot be decoded: feed says no, and the error names the sound
  assert.equal(bridge.feed('side', 0, 'AAAA', true), false)
  assert.deepEqual([out.at(-1).t, out.at(-1).id], ['error', 'side'])
  // a good file after a bad one still loads and feed says yes
  const b64 = b64encode(encodeWav(voice(24000, 0.5), 16))
  assert.equal(bridge.feed('side', 0, b64, true), true)
  assert.deepEqual([out.at(-1).t, out.at(-1).id], ['loaded', 'side'])
})

test('iPhone bridge installs on a window without webkit and says ready', async () => {
  const listeners = {}
  const win = { addEventListener: (k, fn) => (listeners[k] = fn) }
  const b = await install(win, { version: 'v-test' })
  assert.equal(win.vcBridge, b)
  assert.deepEqual(win.vcBridgeOut.at(-1), { t: 'ready', version: 'v-test' })
  listeners.error({ message: 'boom' })
  assert.match(win.vcBridgeOut.at(-1).message, /boom/)
  listeners.unhandledrejection({ reason: new Error('lost') })
  assert.match(win.vcBridgeOut.at(-1).message, /lost/)
  const sent = []
  const win2 = { webkit: { messageHandlers: { vc: { postMessage: (m) => sent.push(m) } } } }
  await install(win2, { version: 'v2' })
  assert.deepEqual(sent.at(-1), { t: 'ready', version: 'v2' })
})
