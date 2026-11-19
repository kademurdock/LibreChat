// test/rack.nodetest.mjs - the effects-rack work of Nov 18 2026: the modules
// tone.limit, lofi.downsample, space.hall, space.plate and pitch.harmonizer,
// and the backing track in render.js.
//
// What it proves, module by module, on impulses, tones, noise and the
// synthetic talker (test/fixtures.mjs):
// - every module passes core/params.js validateModuleShape;
// - the robustness battery of CONTRACT section 4: empty input, silence, a
//   click, speech, stereo input, every numeric param at min, default and max
//   one at a time, every choice and switch, at 48 kHz and 22.05 kHz (8 and
//   96 kHz at defaults): no NaN or Infinity, peak under 8, output length
//   exactly input plus the declared tail, silence stays silent, the same
//   seed gives the same output;
// - live versions (the two reverbs): block size does not matter, in-place
//   buffers work, set() mid-stream stays finite;
// - render.js: a sound-file bed with sync is a backing track (lined up with the
//   take, played once, a preview starts it part way in), and an empty rack is
//   allowed;
// - "prove it" behaviour: the limiter really holds the ceiling and Push
//   really makes it louder; the sample rate reducer folds aliases with steps
//   and removes the top when clean; the plate answers at once with no gap
//   while the hall waits for its gap, both decay at about the asked time and
//   are wide; the harmonizer's third follows the key (four semitones above
//   C in C major, three above D), and without the lead only the harmony's
//   pitch is left.
//
// Run: node --test engine/test/rack.nodetest.mjs (Node 24).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { synthVoice, impulse, silence, sine, noiseBuf } from './fixtures.mjs'
import { assertSane, rmsDb, bandEnergyDb, stereoCorrelation, medianF0 } from './measure.mjs'
import { resolveParams, validateModuleShape } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { renderPreset, renderPreview } from '../render.js'

import limit from '../modules/tone/limit.js'
import downsample from '../modules/lofi/downsample.js'
import hall from '../modules/space/hall.js'
import plate from '../modules/space/plate.js'
import harmonizer, { moveInScale } from '../modules/pitch/harmonizer.js'

const ALL = [limit, downsample, hall, plate, harmonizer]
const LIVE = [hall, plate]
const MAKES_STEREO = new Set([hall.id, plate.id, harmonizer.id])

function run(mod, input, p = {}, seed = 1) {
  const rp = resolveParams(mod, p)
  return mod.process(input, rp, { sr: input.sr, rng: makeRng(seed), progress() {}, cancelled: () => false })
}

function copyOf(b) {
  return { sr: b.sr, ch: b.ch.map((c) => new Float32Array(c)) }
}

function stereoOf(b) {
  const L = new Float32Array(b.ch[0])
  const R = new Float32Array(b.ch[0].length)
  for (let i = 0; i < R.length; i++) R[i] = -0.7 * L[R.length - 1 - i]
  return { sr: b.sr, ch: [L, R] }
}

function expectLen(mod, input, out, p) {
  const rp = resolveParams(mod, p)
  // the space family answers an empty take with an empty one (no tail of nothing), as space.reverb does
  if (!input.ch[0].length && mod.family === 'space') return assert.equal(out.ch[0].length, 0, mod.id + ' keeps an empty take empty')
  const want = input.ch[0].length + Math.round(mod.tail(rp, input.sr) * input.sr)
  assert.equal(out.ch[0].length, want, mod.id + ' length is input plus tail for ' + JSON.stringify(p))
}

function sweepSettings(mod) {
  const list = [{}]
  for (const p of mod.params) {
    if (p.type === 'number') list.push({ [p.id]: p.min }, { [p.id]: p.max })
    else if (p.type === 'choice') {
      for (const o of p.options) if (o.v !== p.def) list.push({ [p.id]: o.v })
    } else if (p.type === 'bool') list.push({ [p.id]: !p.def })
  }
  return list
}

function peakOf(b) {
  let pk = 0
  for (const s of b.ch) for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > pk) pk = Math.abs(s[i])
  return pk
}

function energy(s, a, b) {
  let e = 0
  for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) e += s[i] * s[i]
  return e
}

// ---------------------------------------------------------------- shape

describe('rack modules: shape', () => {
  for (const mod of ALL) {
    test(mod.id + ' passes validateModuleShape', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.id.split('.')[0], mod.family)
      assert.equal(mod.warps, false)
      assert.equal(mod.stereo, MAKES_STEREO.has(mod.id) ? 'make' : 'keep')
      assert.ok(mod.params.length >= 3 && mod.params.length <= 9, 'three to nine params')
      for (const p of mod.params) assert.ok(/^[A-Z]/.test(p.name), mod.id + ' setting "' + p.name + '" starts with a capital')
    })
  }
  test('the two reverbs have live versions with no latency; the rest are offline only', () => {
    for (const m of LIVE) {
      assert.ok(m.live && typeof m.live.create === 'function', m.id + ' has live')
      assert.equal(m.live.latency(resolveParams(m, {}), 48000), 0)
    }
    for (const m of [limit, downsample, harmonizer]) assert.equal(m.live, undefined)
  })
})

// ---------------------------------------------------------------- robustness

describe('rack modules: robustness battery', () => {
  for (const mod of ALL) {
    test(mod.id + ' survives empty, silence, click, speech, stereo, every setting at 48 and 22.05 kHz', () => {
      for (const sr of [48000, 22050]) {
        const voice = synthVoice(sr, mod.cost >= 5 ? 0.7 : 1, { seed: 3 })
        const inputs = [{ sr, ch: [new Float32Array(0)] }, silence(sr, 0.5), impulse(sr, 0.5, 0.1), { sr, ch: [voice.ch[0]] }, stereoOf(voice)]
        const settings = sr === 48000 ? sweepSettings(mod) : sweepSettings(mod).filter((_, i) => i % 2 === 0)
        for (const p of settings) {
          for (const inp of inputs) {
            const out = run(mod, copyOf(inp), p)
            assertSane(out, { maxPeak: 8 })
            if (MAKES_STEREO.has(mod.id)) assert.equal(out.ch.length, 2, mod.id + ' makes stereo')
            else assert.equal(out.ch.length, inp.ch.length, mod.id + ' keeps the channel count')
            expectLen(mod, inp, out, p)
          }
        }
        const s = run(mod, silence(sr, 0.5))
        assert.equal(rmsDb(s), -200, mod.id + ' keeps silence silent')
      }
    })

    test(mod.id + ' at 8 kHz and 96 kHz, and deterministic', () => {
      for (const sr of [8000, 96000]) {
        const v = synthVoice(sr, 0.6, { seed: 4 })
        const out = run(mod, v)
        assertSane(out, { maxPeak: 8 })
        expectLen(mod, v, out, {})
      }
      const v = synthVoice(48000, 1, { seed: 5 })
      const a = run(mod, copyOf(v), {}, 9)
      const b = run(mod, copyOf(v), {}, 9)
      for (let c = 0; c < a.ch.length; c++) assert.deepEqual(a.ch[c], b.ch[c])
    })

    test(mod.id + ' tail is a finite number of seconds, at most 30, for every setting', () => {
      for (const p of sweepSettings(mod)) {
        const t = mod.tail(resolveParams(mod, p), 48000)
        assert.ok(Number.isFinite(t) && t >= 0 && t <= 30, mod.id + ' tail ' + t + ' for ' + JSON.stringify(p))
      }
    })

    test(mod.id + ' handles NaN and Infinity in the input', () => {
      const v = synthVoice(48000, 0.5, { seed: 6 })
      v.ch[0][100] = NaN
      v.ch[0][2000] = Infinity
      v.ch[0][3000] = -Infinity
      assertSane(run(mod, v), { maxPeak: 8 })
    })
  }
})

// ---------------------------------------------------------------- live

function runLive(mod, input, p, block, { inPlace = false, changeAt = -1, change = null } = {}) {
  const sr = input.sr
  const k = mod.live.create(sr, resolveParams(mod, p), makeRng(1))
  const n = input.ch[0].length
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  let src = input.ch
  if (inPlace) {
    L.set(input.ch[0])
    R.set(input.ch.length > 1 ? input.ch[1] : input.ch[0])
    src = [L, R]
  }
  let changed = false
  for (let s = 0; s < n; s += block) {
    const e = Math.min(n, s + block)
    if (change && !changed && s >= changeAt) {
      k.set(resolveParams(mod, Object.assign({}, p, change)))
      changed = true
    }
    k.process(src.map((c) => c.subarray(s, e)), [L.subarray(s, e), R.subarray(s, e)], e - s)
  }
  return { sr, ch: [L, R] }
}

describe('rack modules: live reverbs', () => {
  for (const mod of LIVE) {
    test(mod.id + ' live: finite at block sizes 128 and 480, in place, and through a settings change', () => {
      const v = synthVoice(48000, 1.2, { seed: 7 })
      const a = runLive(mod, v, {}, 128)
      const b = runLive(mod, v, {}, 480)
      assertSane(a, { maxPeak: 8 })
      assertSane(b, { maxPeak: 8 })
      // the same sound whatever the block size (control steps may land differently, so compare levels)
      assert.ok(Math.abs(rmsDb(a) - rmsDb(b)) < 0.5, mod.id + ' level differs with block size: ' + rmsDb(a) + ' vs ' + rmsDb(b))
      const c = runLive(mod, stereoOf(v), {}, 128, { inPlace: true })
      assertSane(c, { maxPeak: 8 })
      assert.ok(rmsDb(c) > -60, mod.id + ' in place still sounds')
      const d = runLive(mod, v, {}, 128, { changeAt: 24000, change: { decay: mod.params.find((x) => x.id === 'decay').max, mix: 100 } })
      assertSane(d, { maxPeak: 8 })
    })
  }
})

// ---------------------------------------------------------------- limiter

describe('tone.limit: holds the ceiling', () => {
  test('nothing leaves above the ceiling, for sample peaks and loud stereo', () => {
    const sr = 48000
    for (const ceiling of [-1, -6, -12, 0]) {
      const v = stereoOf(synthVoice(sr, 1.5, { seed: 8 }))
      for (const s of v.ch) for (let i = 0; i < s.length; i++) s[i] *= 3
      const out = run(limit, v, { ceiling, push: 6 })
      const lim = Math.pow(10, ceiling / 20)
      assert.ok(peakOf(out) <= lim + 1e-6, 'peak ' + peakOf(out) + ' above ceiling ' + lim)
    }
  })
  test('a quiet take with no push passes unchanged', () => {
    const v = synthVoice(48000, 1, { seed: 9 })
    for (let i = 0; i < v.ch[0].length; i++) v.ch[0][i] *= 0.1
    const before = new Float32Array(v.ch[0])
    const out = run(limit, v, {})
    assert.deepEqual(out.ch[0], before)
  })
  test('Push makes it louder while the peak stays put', () => {
    const v = synthVoice(48000, 2, { seed: 10 })
    const a = run(limit, copyOf(v), { push: 0, ceiling: -1 })
    const b = run(limit, copyOf(v), { push: 12, ceiling: -1 })
    assert.ok(rmsDb(b) > rmsDb(a) + 5, 'pushed take should be clearly louder: ' + rmsDb(a) + ' -> ' + rmsDb(b))
    assert.ok(peakOf(b) <= Math.pow(10, -1 / 20) + 1e-6)
  })
  test('the two sides of a stereo take get the same gain', () => {
    const sr = 48000
    const L = sine(sr, 0.5, 220, 0.2).ch[0]
    const R = sine(sr, 0.5, 220, 1.6).ch[0]
    const out = run(limit, { sr, ch: [L, R] }, { ceiling: -6 })
    // the right side is 18 dB hotter going in and must still be 18 dB hotter coming out
    const d = rmsDb(out.ch[1]) - rmsDb(out.ch[0])
    assert.ok(Math.abs(d - 18.06) < 0.3, 'side balance moved: ' + d)
  })
})

// ---------------------------------------------------------------- sample rate reducer

describe('lofi.downsample: a lower sample rate', () => {
  test('a new rate at or above the take\'s own leaves it unchanged', () => {
    const v = synthVoice(22050, 0.5, { seed: 11 })
    const before = new Float32Array(v.ch[0])
    const out = run(downsample, v, { rate: 48000 })
    assert.deepEqual(out.ch[0], before)
  })
  test('gritty steps hold each value and fold aliases; clean removes the top instead', () => {
    const sr = 48000
    const tone = sine(sr, 1, 3000, 0.5)
    const steps = run(downsample, copyOf(tone), { rate: 4000, style: 'steps' })
    // held: at most one new value every 12 samples
    let changes = 0
    for (let i = 1; i < steps.ch[0].length; i++) if (steps.ch[0][i] !== steps.ch[0][i - 1]) changes++
    assert.ok(changes <= steps.ch[0].length / 12 + 2, 'too many value changes for a 4 kHz hold: ' + changes)
    // 3 kHz sampled at 4 kHz folds to 1 kHz
    assert.ok(bandEnergyDb(steps.ch[0], sr, 900, 1100) > -20, 'no alias at 1 kHz: ' + bandEnergyDb(steps.ch[0], sr, 900, 1100))
    const clean = run(downsample, copyOf(tone), { rate: 4000, style: 'clean' })
    assert.ok(rmsDb(clean) < -40, 'a 3 kHz tone should be gone at a clean 4 kHz: ' + rmsDb(clean))
    const low = sine(sr, 1, 500, 0.5)
    const kept = run(downsample, copyOf(low), { rate: 4000, style: 'clean' })
    assert.ok(Math.abs(rmsDb(kept) - rmsDb(low)) < 1, 'a 500 Hz tone should pass a clean 4 kHz: ' + rmsDb(kept))
  })
  test('straight lines are smoother than steps', () => {
    const sr = 48000
    const v = noiseBuf(sr, 1, 'pink', 3, 1, 0.3)
    const steps = run(downsample, copyOf(v), { rate: 6000, style: 'steps' })
    const lines = run(downsample, copyOf(v), { rate: 6000, style: 'lines' })
    assert.ok(bandEnergyDb(lines.ch[0], sr, 9000, 20000) < bandEnergyDb(steps.ch[0], sr, 9000, 20000) - 6, 'lines should carry less staircase hash')
  })
  test('mix 0 is the dry sound', () => {
    const v = synthVoice(48000, 0.5, { seed: 12 })
    const before = new Float32Array(v.ch[0])
    const out = run(downsample, v, { rate: 2000, mix: 0 })
    assert.deepEqual(out.ch[0], before)
  })
})

// ---------------------------------------------------------------- hall and plate

describe('space.hall and space.plate: what makes each one itself', () => {
  test('the plate answers at once, the hall waits for its gap', () => {
    const sr = 48000
    const click = impulse(sr, 0.3, 0)
    const p = run(plate, copyOf(click), { mix: 100, predelay: 0 })
    const h = run(hall, copyOf(click), { mix: 100, predelay: 60 })
    const win = Math.round(0.03 * sr)
    assert.ok(energy(p.ch[0], 1, win) > 1e-6, 'the plate should sound inside the first 30 ms')
    assert.ok(energy(h.ch[0], 1, win) < energy(p.ch[0], 1, win) * 0.01, 'the hall should be nearly silent before its gap is over')
    assert.ok(energy(h.ch[0], Math.round(0.06 * sr), Math.round(0.3 * sr)) > 1e-6, 'the hall answers after the gap')
  })
  for (const [mod, decay] of [[hall, 2], [plate, 1.5]]) {
    test(mod.id + ' dies away at about the asked decay time, wet only', () => {
      const sr = 48000
      const click = impulse(sr, 0.2, 0)
      const out = run(mod, copyOf(click), { mix: 100, decay })
      const s = out.ch[0]
      // level in a 100 ms window early in the tail and one decay/2 later: about 30 dB down
      const w = Math.round(0.1 * sr)
      const a = Math.round(0.25 * sr)
      const b = a + Math.round((decay / 2) * sr)
      const drop = 10 * Math.log10(energy(s, a, a + w) / Math.max(1e-30, energy(s, b, b + w)))
      assert.ok(drop > 18 && drop < 45, mod.id + ' fell ' + drop.toFixed(1) + ' dB in half its decay time (30 expected)')
    })
    test(mod.id + ' is wide, and mix 0 is the dry voice on both sides', () => {
      const v = synthVoice(48000, 1.5, { seed: 13 })
      const wet = run(mod, copyOf(v), { mix: 100 })
      assert.ok(stereoCorrelation(wet) < 0.6, mod.id + ' wet sides too alike: ' + stereoCorrelation(wet))
      const dry = run(mod, copyOf(v), { mix: 0 })
      let worst = 0
      for (let i = 0; i < v.ch[0].length; i++) worst = Math.max(worst, Math.abs(dry.ch[0][i] - v.ch[0][i]), Math.abs(dry.ch[1][i] - v.ch[0][i]))
      assert.ok(worst < 1e-3, mod.id + ' mix 0 changed the voice by ' + worst)
    })
  }
  test('a darker hall has less top in its tail', () => {
    const sr = 48000
    const v = noiseBuf(sr, 0.3, 'white', 5, 1, 0.3)
    const bright = run(hall, copyOf(v), { mix: 100, damping: 0 })
    const dark = run(hall, copyOf(v), { mix: 100, damping: 100 })
    const from = Math.round(0.6 * sr)
    const hb = bandEnergyDb(bright.ch[0].subarray(from), sr, 5000, 12000) - bandEnergyDb(bright.ch[0].subarray(from), sr, 300, 1200)
    const hd = bandEnergyDb(dark.ch[0].subarray(from), sr, 5000, 12000) - bandEnergyDb(dark.ch[0].subarray(from), sr, 300, 1200)
    assert.ok(hd < hb - 6, 'the dark hall should lose its top: ' + hb.toFixed(1) + ' vs ' + hd.toFixed(1))
  })
})

// ---------------------------------------------------------------- harmonizer

describe('pitch.harmonizer: harmony that stays in the key', () => {
  test('moveInScale counts in scale steps', () => {
    const major = [0, 2, 4, 5, 7, 9, 11]
    assert.equal(moveInScale(60, 2, major, 0), 64) // C -> E, a major third
    assert.equal(moveInScale(62, 2, major, 0), 65) // D -> F, a minor third
    assert.equal(moveInScale(64, 4, major, 0), 71) // E -> B, a fifth
    assert.equal(moveInScale(60, 7, major, 0), 72) // an octave
    assert.equal(moveInScale(60, -2, major, 0), 57) // C -> A below
    assert.equal(moveInScale(59, 1, major, 0), 60) // B -> C across the octave
    assert.equal(moveInScale(66, 2, major, 2), 69) // in D major, F sharp -> A
    const penta = [0, 2, 4, 7, 9]
    assert.equal(moveInScale(60, 1, penta, 0), 62)
    assert.equal(moveInScale(69, 1, penta, 0), 72)
  })
  const C4 = 261.626
  const D4 = 293.665
  for (const [name, f0, semis] of [['C', C4, 4], ['D', D4, 3]]) {
    test('a third above ' + name + ' in C major is ' + semis + ' semitones', () => {
      const sr = 48000
      const v = synthVoice(sr, 1.6, { f0, seed: 14, fricatives: false, intonation: 0, jitter: 0.002 })
      const out = run(harmonizer, copyOf(v), { key: 'C', scale: 'major', part1: 'third-up', lead: false, snap: 100, spread: 0, level: 0 })
      const got = medianF0(out.ch[0], sr, { minHz: 120, maxHz: 700 })
      const want = f0 * Math.pow(2, semis / 12)
      const cents = 1200 * Math.log2(got / want)
      assert.ok(Math.abs(cents) < 35, 'harmony at ' + got.toFixed(1) + ' Hz, wanted ' + want.toFixed(1) + ' (' + cents.toFixed(0) + ' cents off)')
    })
  }
  test('an octave below is half the pitch, and both parts off leaves the take alone', () => {
    const sr = 48000
    const v = synthVoice(sr, 1.4, { f0: 220, seed: 15, fricatives: false, intonation: 0, jitter: 0.002 })
    const out = run(harmonizer, copyOf(v), { key: 'A', scale: 'minor', part1: 'octave-down', lead: false, snap: 100, level: 0 })
    const got = medianF0(out.ch[0], sr, { minHz: 70, maxHz: 400 })
    assert.ok(Math.abs(1200 * Math.log2(got / 110)) < 35, 'octave below 220 Hz came out at ' + got.toFixed(1))
    const same = run(harmonizer, copyOf(v), { part1: 'off', part2: 'off' })
    assert.deepEqual(same.ch[0], v.ch[0])
    assert.deepEqual(same.ch[1], v.ch[0])
  })
  test('with the lead kept, the take is still there and the harmony is added; two parts sit left and right', () => {
    const sr = 48000
    const v = synthVoice(sr, 1.4, { f0: 196, seed: 16 })
    const one = run(harmonizer, copyOf(v), { key: 'G', part1: 'third-up' })
    assert.ok(rmsDb(one) > rmsDb(v) + 0.5, 'adding a harmony should add level')
    const two = run(harmonizer, copyOf(v), { key: 'G', part1: 'third-up', part2: 'fifth-up', lead: false, spread: 100 })
    assert.ok(stereoCorrelation(two) < 0.5, 'two parts at full spread should differ left and right: ' + stereoCorrelation(two))
  })
})

// ---------------------------------------------------------------- backing track (render.js)

describe('render: a backing track is a sound-file bed with sync', () => {
  const sr = 48000
  /** One second of silence with a 0.2 s burst of noise starting at 0.5 s. */
  function track() {
    const n = noiseBuf(sr, 0.2, 'pink', 9, 1, 0.5).ch[0]
    const s = new Float32Array(sr)
    s.set(n, Math.round(0.5 * sr))
    return { sr, ch: [s] }
  }
  function quietVoice(seconds) {
    const v = synthVoice(sr, seconds, { seed: 20 })
    for (let i = 0; i < v.ch[0].length; i++) v.ch[0][i] *= 0.2
    return v
  }
  const PLAIN = { id: null, name: 'Plain', chain: [] }
  /** Where the track sounds in the result: [first, last] sample where it differs from the voice alone. */
  function whereBed(mixed, alone) {
    let first = -1
    let last = -1
    const a = mixed.ch[0]
    const b = alone.ch[0]
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-4) {
        if (first < 0) first = i
        last = i
      }
    }
    return [first, last]
  }
  const opts = (extra) => ({ loudness: null, cleanup: false, ...extra })

  test('it starts where the take starts, plays once and never loops', () => {
    const voice = quietVoice(3)
    const alone = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: null } })).buf
    const r = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: { file: 'backing', level: -6, sync: true } }, bedAudio: track() }))
    assertSane(r.buf, { maxPeak: 1 })
    assert.equal(r.buf.ch.length, 2)
    assert.equal(r.report.bed.sync, true)
    const [first, last] = whereBed(r.buf, alone)
    assert.ok(Math.abs(first - 0.5 * sr) < 0.005 * sr, 'the burst begins at 0.5 s, got ' + (first / sr).toFixed(4))
    assert.ok(last < 0.75 * sr, 'nothing of the track after its burst ends (no loop): last at ' + (last / sr).toFixed(3))
    // the same seed or another seed: a backing track never starts at a random place
    const again = renderPreset(copyOf(voice), PLAIN, opts({ seed: 777, macros: { bed: { file: 'backing', level: -6, sync: true } }, bedAudio: track() }))
    assert.deepEqual(whereBed(again.buf, alone), [first, last])
  })

  test('without sync the same file is a looping background, as before', () => {
    const voice = quietVoice(3)
    const alone = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: null } })).buf
    const r = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: { file: 'backing', level: -6, fade: false } }, bedAudio: track() }))
    assert.equal(r.report.bed.sync, undefined)
    const [, last] = whereBed(r.buf, alone)
    assert.ok(last > 1.2 * sr, 'a one-second loop under a three-second take sounds again later: last at ' + (last / sr).toFixed(3))
  })

  test('a preview that starts part way in starts the track there too', () => {
    const voice = quietVoice(3)
    const aloneFull = renderPreview(copyOf(voice), PLAIN, opts({ start: 0.3, seconds: 1.5, macros: { bed: null } })).buf
    const r = renderPreview(copyOf(voice), PLAIN, opts({ start: 0.3, seconds: 1.5, macros: { bed: { file: 'backing', level: -6, sync: true } }, bedAudio: track() }))
    const [first] = whereBed(r.buf, aloneFull)
    assert.ok(Math.abs(first - 0.2 * sr) < 0.005 * sr, 'the burst begins 0.2 s into a preview that starts at 0.3 s, got ' + (first / sr).toFixed(4))
  })

  test('level is decibels against the voice, and a changed speed is said in the notes', () => {
    const voice = quietVoice(2)
    const alone = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: null } })).buf
    const power = (level) => {
      const r = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: { file: 'backing', level, sync: true } }, bedAudio: track() })).buf
      let e = 0
      for (let i = 0; i < alone.ch[0].length; i++) e += (r.ch[0][i] - alone.ch[0][i]) ** 2
      return 10 * Math.log10(e)
    }
    assert.ok(Math.abs(power(0) - power(-12) - 12) < 0.3, 'twelve decibels down is twelve decibels down')
    const sped = renderPreset(copyOf(voice), PLAIN, opts({ macros: { speed: 1.25, bed: { file: 'backing', level: -6, sync: true } }, bedAudio: track() }))
    assert.ok(sped.report.notes.some((s) => /backing track no longer lines up/.test(s)), JSON.stringify(sped.report.notes))
    const plain = renderPreset(copyOf(voice), PLAIN, opts({ macros: { bed: { file: 'backing', level: -6, sync: true } }, bedAudio: track() }))
    assert.ok(!(plain.report.notes || []).some((s) => /lines up/.test(s)))
  })

  test('an empty rack is allowed: the plain voice comes back', () => {
    const voice = quietVoice(1)
    const r = renderPreset(copyOf(voice), PLAIN, opts({}))
    assertSane(r.buf, { maxPeak: 1 })
    assert.equal(r.report.stages.length, 0)
    let worst = 0
    for (let i = 0; i < voice.ch[0].length; i++) worst = Math.max(worst, Math.abs(r.buf.ch[0][i] - voice.ch[0][i]))
    assert.ok(worst < 1e-4, 'nothing in the rack changed the voice by ' + worst)
  })
})
