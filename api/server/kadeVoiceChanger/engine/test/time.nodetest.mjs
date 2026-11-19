// test/time.nodetest.mjs - the time family (modules/time/*.js): reversing,
// stuttering, rearranging, tape stops, scratches, glitches, gap trimming and
// slow-motion stretching.
//
// What it checks:
// 1. Shape: every module passes core/params.js validateModuleShape, sits in
//    the file its id names, is in the time family, sets warps (timing
//    changes) and has no live version.
// 2. Robustness (CONTRACT section 4): empty input, silence, a single click,
//    a very short take, mono and stereo, 8, 22.05 and 48 kHz, and every param
//    at min, default and max plus every choice on its own: no exceptions, no
//    NaN or Infinity, peak under 8, channels of equal length, channel count
//    kept. Deterministic: the same seed gives the same output.
// 3. Prove it (MODULES_PLAN section 7): reverse equals the reversed input;
//    reversewords keeps the phrase boundaries and reverses each unit in its
//    place; palindrome's second half is the first half reversed; stutter and
//    scratch insert exactly the material they promise; trim shortens a take
//    by the pause lengths; shuffle keeps length, energy and phrase edges;
//    glitch's "Keep the timing" keeps the length; tape stop ends in silence
//    with the pitch falling; drawl stretches by its factor with the pitch
//    kept or dropped.
// 4. No clicks: on a sine-burst "voice", every splice-based module leaves the
//    band above 4 kHz more than 55 dB under the signal (a hard cut at a
//    random phase would put a broadband click there).
// 5. Real speech (the Oct 16 Fish recordings, skipped when the drive is not
//    there) and speed per second of 48 kHz audio against generous bounds.
//
// Run with Node 24:
//   node --test engine/test/time.nodetest.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

import { synthVoice, impulse, silence } from './fixtures.mjs'
import { assertSane, medianF0, rmsDb, timeIt, spectralCentroid, bandEnergyDb } from './measure.mjs'
import { resolveParams, validateModuleShape } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'
import { findPhrases } from '../core/segment.js'
import { unitCore } from '../modules/time/_lib.js'

const IDS = ['reverse', 'reversewords', 'palindrome', 'stutter', 'tapestop', 'scratch', 'glitch', 'shuffle', 'trim', 'drawl']
const MODS = {}
for (const id of IDS) MODS[id] = (await import(new URL('../modules/time/' + id + '.js', import.meta.url))).default

const SPEECH = [
  'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav',
  'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav',
]

// ---------------------------------------------------------------- helpers

function ctxOf(seed = 1, sr = 48000) {
  return { sr, rng: makeRng(seed), progress() {}, cancelled: () => false, note() {} }
}

function run(mod, buf, p = {}, seed = 1) {
  const params = resolveParams(mod, p)
  const copy = { sr: buf.sr, ch: buf.ch.map((c) => new Float32Array(c)) }
  return mod.process(copy, params, ctxOf(seed, buf.sr))
}

function mono(buf) {
  return { sr: buf.sr, ch: [buf.ch[0]] }
}

const VOICE48 = mono(synthVoice(48000, 3, { seed: 7 }))
const VOICE22 = mono(synthVoice(22050, 1.6, { seed: 8, f0: 210 }))
const VOICE8 = mono(synthVoice(8000, 1.2, { seed: 9 }))

function stereoOf(buf) {
  const a = buf.ch[0]
  const b = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) b[i] = 0.7 * a[i] + (i > 20 ? 0.2 * a[i - 20] : 0)
  return { sr: buf.sr, ch: [new Float32Array(a), b] }
}

/** A clean "voice" of sine bursts: on 420 ms, off 220 ms, 25 ms fades. */
function sineBursts(sr, seconds, hz = 300) {
  const n = Math.round(seconds * sr)
  const s = new Float32Array(n)
  const on = Math.round(0.42 * sr)
  const off = Math.round(0.22 * sr)
  const f = Math.round(0.025 * sr)
  const lead = Math.round(0.15 * sr)
  for (let i = lead; i < n; i++) {
    const k = (i - lead) % (on + off)
    if (k >= on) continue
    let a = 0.5
    if (k < f) a *= 0.5 - 0.5 * Math.cos((Math.PI * k) / f)
    if (on - 1 - k < f) a *= 0.5 - 0.5 * Math.cos((Math.PI * (on - 1 - k)) / f)
    s[i] = a * Math.sin((2 * Math.PI * hz * i) / sr)
  }
  return { sr, ch: [s] }
}

function corr(a, b) {
  const n = Math.min(a.length, b.length)
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) {
    sab += a[i] * b[i]
    saa += a[i] * a[i]
    sbb += b[i] * b[i]
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0
}

function reversed(sig, a, b) {
  const out = new Float32Array(b - a)
  for (let i = 0; i < b - a; i++) out[i] = sig[b - 1 - i]
  return out
}

function energy(sig) {
  let e = 0
  for (let i = 0; i < sig.length; i++) e += sig[i] * sig[i]
  return e
}

/** Params with every number at min or max, choices and switches at default. */
function extremes(mod, which) {
  const p = {}
  for (const q of mod.params) if (q.type === 'number') p[q.id] = which === 'min' ? q.min : q.max
  return p
}

// ---------------------------------------------------------------- 1. shape

describe('time family: shape', () => {
  test('the folder holds these modules and one helper file', () => {
    const files = readdirSync(new URL('../modules/time/', import.meta.url)).filter((f) => f.endsWith('.js'))
    const mods = files.filter((f) => !f.startsWith('_')).map((f) => f.slice(0, -3)).sort()
    assert.deepEqual(mods, IDS.slice().sort())
    assert.deepEqual(files.filter((f) => f.startsWith('_')), ['_lib.js'])
  })
  for (const id of IDS) {
    test(id + ' passes the module shape check', () => {
      const mod = MODS[id]
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.id, 'time.' + id)
      assert.equal(mod.family, 'time')
      assert.equal(mod.warps, true, 'timing changes, so warps must be true')
      assert.equal(mod.live, undefined, 'no live version in this family')
      assert.ok(mod.params.length >= 2 && mod.params.length <= 8, 'two to eight params')
      assert.equal(mod.stereo, 'keep')
    })
  }
})

// ---------------------------------------------------------------- 2. robustness

describe('time family: robustness', () => {
  const inputs = [
    ['empty mono', { sr: 48000, ch: [new Float32Array(0)] }],
    ['empty stereo', { sr: 48000, ch: [new Float32Array(0), new Float32Array(0)] }],
    ['silence', silence(48000, 1)],
    ['one click', impulse(48000, 1, 0.5)],
    ['tiny take', { sr: 48000, ch: [VOICE48.ch[0].slice(4000, 6400)] }],
    ['voice 48 kHz', VOICE48],
    ['voice 22 kHz stereo', stereoOf(VOICE22)],
    ['voice 8 kHz', VOICE8],
  ]
  for (const id of IDS) {
    test(id + ': every input, params at min, default and max', () => {
      const mod = MODS[id]
      for (const [label, buf] of inputs) {
        for (const which of ['def', 'min', 'max']) {
          // the heaviest settings run on the shorter takes only
          if (which === 'max' && label === 'voice 48 kHz') continue
          const p = which === 'def' ? {} : extremes(mod, which)
          let out
          assert.doesNotThrow(() => {
            out = run(mod, buf, p)
          }, id + ' threw on ' + label + ' at ' + which)
          const s = assertSane(out)
          assert.equal(out.ch.length, buf.ch.length, id + ' changed the channel count on ' + label)
          assert.equal(out.sr, buf.sr)
          if (buf.ch[0].length === 0) assert.equal(s.length, 0, id + ' made sound from nothing')
          if (label === 'silence') assert.ok(rmsDb(out) < -100, id + ' made noise from silence')
        }
      }
    })
    test(id + ': every choice on its own, and switches flipped', () => {
      const mod = MODS[id]
      for (const q of mod.params) {
        const values = q.type === 'choice' ? q.options.map((o) => o.v) : q.type === 'bool' ? [!q.def] : []
        for (const v of values) {
          for (const buf of [VOICE22, stereoOf(VOICE22)]) {
            const out = run(mod, buf, { [q.id]: v })
            assertSane(out)
            assert.equal(out.ch.length, buf.ch.length)
          }
        }
      }
    })
    test(id + ': same seed, same sound', () => {
      const mod = MODS[id]
      const a = run(mod, VOICE22, {}, 42)
      const b = run(mod, VOICE22, {}, 42)
      assert.equal(a.ch[0].length, b.ch[0].length)
      assert.deepEqual(a.ch[0], b.ch[0])
    })
  }
  test('random modules change with the seed', () => {
    for (const id of ['stutter', 'glitch', 'shuffle']) {
      const a = run(MODS[id], VOICE48, {}, 1)
      const b = run(MODS[id], VOICE48, {}, 2)
      const same = a.ch[0].length === b.ch[0].length && a.ch[0].every((v, i) => v === b.ch[0][i])
      assert.ok(!same, id + ' ignored its seed')
    }
  })
  test('extreme settings never grow a take without bound', () => {
    const n = VOICE48.ch[0].length
    const cap = n + Math.max(10 * 48000, 3 * n)
    const cases = [
      ['stutter', { where: 'everywhere', chance: 100, repeats: 12, pieceMs: 400 }, 12 * 0.4],
      ['glitch', { density: 100, repeats: 16, roll: 0, tempo: 60 }, 16 * 0.5],
      ['scratch', { where: 'words', chance: 100, beats: 8, tempo: 70 }, 8 * (60 / 70)],
    ]
    for (const [id, p, oneEvent] of cases) {
      const out = run(MODS[id], VOICE48, p)
      assertSane(out)
      assert.ok(out.ch[0].length <= cap + oneEvent * 48000, id + ' grew to ' + (out.ch[0].length / 48000).toFixed(1) + ' s')
    }
  })
  test('stereo channels get the same edit', () => {
    for (const id of IDS) {
      const st = stereoOf(VOICE48)
      const out = run(MODS[id], st, {})
      // the right channel is 0.7 times the left plus a small echo, so the
      // edited channels must stay strongly correlated
      const c = corr(out.ch[0], out.ch[1])
      assert.ok(c > 0.9, id + ' edited the channels differently (correlation ' + c.toFixed(3) + ')')
    }
  })
})

// ---------------------------------------------------------------- 3. prove it

describe('time family: each effect does what its name says', () => {
  test('Backwards equals the reversed input', () => {
    const x = VOICE48.ch[0]
    const out = run(MODS.reverse, VOICE48, { smooth: 0 })
    const y = out.ch[0]
    assert.equal(y.length, x.length)
    for (let i = 0; i < x.length; i++) if (y[i] !== x[x.length - 1 - i]) assert.fail('sample ' + i + ' differs')
    // with smoothing only the ends change
    const s = run(MODS.reverse, VOICE48, { smooth: 3 }).ch[0]
    const e = Math.round(0.003 * 48000)
    for (let i = e; i < x.length - e; i++) if (s[i] !== x[x.length - 1 - i]) assert.fail('smoothing touched the middle at ' + i)
    // forward voice underneath adds the forward take
    const f = run(MODS.reverse, VOICE48, { smooth: 0, forward: 50 }).ch[0]
    for (let i = 0; i < x.length; i += 997) assert.ok(Math.abs(f[i] - (x[x.length - 1 - i] + 0.5 * x[i])) < 1e-6)
  })

  test('Backwards words: nothing turned is the input, untouched', () => {
    const x = VOICE48.ch[0]
    for (const unit of ['syllables', 'words', 'phrases', 'slices']) {
      const y = run(MODS.reversewords, VOICE48, { unit, amount: 0 }).ch[0]
      assert.equal(y.length, x.length)
      let err = 0
      for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]))
      assert.ok(err < 1e-5, unit + ': joins changed the sound by ' + err)
    }
  })

  test('Backwards words: each phrase is reversed in its own place', () => {
    const x = VOICE48.ch[0]
    const y = run(MODS.reversewords, VOICE48, { unit: 'phrases', amount: 100 }).ch[0]
    assert.equal(y.length, x.length)
    const ph = findPhrases(x, 48000)
    assert.ok(ph.length >= 2)
    for (const ph0 of ph) {
      // the sounding middle of the phrase turns; its quiet edges stay
      const u = unitCore(x, 48000, ph0)
      assert.ok(u.end - u.start > 0.5 * (ph0.end - ph0.start))
      const m = Math.round(0.01 * 48000) // skip the crossfades
      const a = u.start + m
      const b = u.end - m
      const c = corr(y.subarray(a, b), reversedAround(x, u.start, u.end, a, b))
      assert.ok(c > 0.98, 'phrase at ' + (u.start / 48000).toFixed(2) + ' s correlates ' + c.toFixed(3) + ' with its reversal')
    }
  })

  test('Backwards words: syllables keep the rhythm and the phrase boundaries', () => {
    const x = VOICE48.ch[0]
    const y = run(MODS.reversewords, VOICE48, { unit: 'syllables' }).ch[0]
    const pa = findPhrases(x, 48000)
    const pb = findPhrases(y, 48000)
    assert.equal(pb.length, pa.length, 'phrase count changed')
    for (let k = 0; k < pa.length; k++) {
      assert.ok(Math.abs(pa[k].start - pb[k].start) < 0.06 * 48000, 'phrase ' + k + ' start moved')
      assert.ok(Math.abs(pa[k].end - pb[k].end) < 0.06 * 48000, 'phrase ' + k + ' end moved')
    }
    // the sound really changed inside the phrases
    assert.ok(corr(x, y) < 0.6, 'syllables were not reversed')
    // the loudness contour in 120 ms frames still follows the original
    const env = (s) => {
      const hop = Math.round(0.12 * 48000)
      const e = new Float32Array(Math.floor(s.length / hop))
      for (let f = 0; f < e.length; f++) {
        let acc = 0
        for (let i = f * hop; i < (f + 1) * hop; i++) acc += s[i] * s[i]
        e[f] = Math.sqrt(acc / hop)
      }
      return e
    }
    const c = corr(env(x), env(y))
    assert.ok(c > 0.8, 'the rhythm (loudness contour) changed: correlation ' + c.toFixed(3))
  })

  test('There and back: the backward half is the forward half reversed', () => {
    const x = VOICE48.ch[0]
    const n = x.length
    const ph = findPhrases(x, 48000)
    const E = ph[ph.length - 1].end
    const gap = Math.round(0.12 * 48000)
    const y = run(MODS.palindrome, VOICE48, {}).ch[0]
    assert.equal(y.length, E + gap + E + (n - E))
    const m = Math.round(0.01 * 48000)
    const back = y.subarray(E + gap + m, E + gap + E - m)
    const want = reversed(x, m, E - m)
    assert.ok(corr(back, want) > 0.999)
    // the forward half is the input
    assert.ok(corr(y.subarray(0, E - m), x.subarray(0, E - m)) > 0.9999)
    // per phrase: each phrase gets its own turn, so the take grows by the
    // phrases plus a pause each
    const z = run(MODS.palindrome, VOICE48, { unit: 'phrases', gapMs: 50 }).ch[0]
    let add = 0
    for (const u of ph) add += u.end - u.start + Math.round(0.05 * 48000)
    assert.equal(z.length, n + add)
  })

  test('Stutter inserts exactly its repeats, and they are the word start', () => {
    const x = VOICE48.ch[0]
    const n = x.length
    const ph = findPhrases(x, 48000)
    const R = 4
    const L = Math.round(0.08 * 48000)
    const out = run(MODS.stutter, VOICE48, { where: 'phrases', chance: 100, repeats: R, pieceMs: 80, gate: 25 }).ch[0]
    assert.equal(out.length, n + ph.length * R * L)
    // the first repeat is the first phrase's opening piece
    const s = ph[0].start
    const sound = Math.round(L * 0.75)
    const m = Math.round(0.002 * 48000)
    const c = corr(out.subarray(s + m, s + sound - m), x.subarray(s + m, s + sound - m))
    assert.ok(c > 0.999, 'repeat does not match the word start: ' + c.toFixed(4))
    // and the second repeat too, one piece later
    const c2 = corr(out.subarray(s + L + m, s + L + sound - m), x.subarray(s + m, s + sound - m))
    assert.ok(c2 > 0.999)
    // the gap after each repeat is quiet
    assert.ok(rmsDb(out.subarray(s + sound + m, s + L - m)) < -80)
    // rolls shorten the pieces, pitch steps change them, and nothing breaks
    const roll = run(MODS.stutter, VOICE48, { where: 'phrases', chance: 100, repeats: 4, roll: 'faster', pitchStep: 1, level: -3 }).ch[0]
    assert.ok(roll.length > n && roll.length < out.length + n)
  })

  test('Close the gaps shortens the take by the pause lengths', () => {
    const sr = 48000
    const v = synthVoice(sr, 1.2, { seed: 11 }).ch[0]
    const sp = findPhrases(v, sr)
    const speech = v.subarray(sp[0].start, sp[sp.length - 1].end)
    const gaps = [0.9, 1.3]
    const lead = 0.3
    const total = Math.round(lead * sr) + 3 * speech.length + Math.round((gaps[0] + gaps[1]) * sr) + Math.round(0.3 * sr)
    const x = new Float32Array(total)
    let at = Math.round(lead * sr)
    for (let k = 0; k < 3; k++) {
      x.set(speech, at)
      at += speech.length + (k < 2 ? Math.round(gaps[k] * sr) : 0)
    }
    // a faint noise floor, like a real room
    const r = makeRng(3)
    for (let i = 0; i < total; i++) x[i] += (r.next() - 0.5) * 2e-4
    const keep = 0.1
    const out = run(MODS.trim, { sr, ch: [x] }, { longerThan: 500, keepMs: keep * 1000, ends: false }).ch[0]
    // each long pause loses its length minus what is kept, give or take the
    // detector's padding (30 ms before and 60 ms after each phrase, measured
    // from where the soft onsets and decays cross its threshold)
    const removed = (total - out.length) / sr
    const most = gaps[0] - keep + gaps[1] - keep
    assert.ok(removed <= most + 0.02, 'removed ' + removed.toFixed(3) + ' s, more than the pauses (' + most.toFixed(3) + ' s)')
    assert.ok(removed >= most - 2 * 0.15, 'removed only ' + removed.toFixed(3) + ' s of ' + most.toFixed(3) + ' s of pause')
    // no speech was lost
    assert.ok(Math.abs(10 * Math.log10(energy(out) / energy(x))) < 0.3)
    // trimming the ends too takes the lead-in and tail down as well
    const out2 = run(MODS.trim, { sr, ch: [x] }, { longerThan: 500, keepMs: keep * 1000, ends: true }).ch[0]
    assert.ok(out2.length < out.length - 0.3 * sr)
    // pauses shorter than the setting stay
    const same = run(MODS.trim, { sr, ch: [x] }, { longerThan: 2000, keepMs: 100, ends: false }).ch[0]
    assert.equal(same.length, total)
  })

  test('Scrambled order keeps length, energy and phrase edges, and really scrambles', () => {
    const x = VOICE48.ch[0]
    const id = run(MODS.shuffle, VOICE48, { amount: 0 }).ch[0]
    let err = 0
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(id[i] - x[i]))
    assert.ok(err < 1e-5, 'amount 0 changed the sound')
    for (const unit of ['words', 'syllables', 'slices']) {
      const y = run(MODS.shuffle, VOICE48, { unit, amount: 100 }).ch[0]
      assert.equal(y.length, x.length)
      assert.ok(Math.abs(10 * Math.log10(energy(y) / energy(x))) < 0.5, unit + ': energy changed')
      assert.ok(corr(x, y) < 0.9, unit + ': order did not change')
      if (unit === 'slices') continue // even slices ignore the speech on purpose
      const pa = findPhrases(x, 48000)
      const pb = findPhrases(y, 48000)
      assert.equal(pb.length, pa.length, unit + ': phrase count changed')
      for (let k = 0; k < pa.length; k++) {
        assert.ok(Math.abs(pa[k].start - pb[k].start) < 0.08 * 48000, unit + ': phrase ' + k + ' start moved')
        assert.ok(Math.abs(pa[k].end - pb[k].end) < 0.08 * 48000, unit + ': phrase ' + k + ' end moved')
      }
    }
    const ph = run(MODS.shuffle, VOICE48, { unit: 'phrases', amount: 100 }).ch[0]
    assert.equal(ph.length, x.length)
    assert.ok(corr(x, ph) < 0.9)
  })

  test('Glitch: keep the timing keeps the length, adding them makes it longer', () => {
    const x = VOICE48.ch[0]
    const ins = run(MODS.glitch, VOICE48, { density: 80 }).ch[0]
    assert.ok(ins.length > x.length + 0.1 * 48000, 'no glitches were added')
    const rep = run(MODS.glitch, VOICE48, { density: 80, mode: 'replace' }).ch[0]
    assert.equal(rep.length, x.length, 'replace mode changed the length')
    assert.ok(corr(rep, x) < 0.98, 'replace mode did nothing')
    // even at the lowest density above zero something happens
    const one = run(MODS.glitch, VOICE48, { density: 1 }).ch[0]
    assert.ok(one.length > x.length)
  })

  test('Record scratch inserts its beats at each phrase', () => {
    const x = VOICE48.ch[0]
    const ph = findPhrases(x, 48000)
    const beat = Math.round((60 / 100) * 48000)
    for (const pattern of ['baby', 'chirp', 'transformer', 'scribble', 'tear', 'flare']) {
      const y = run(MODS.scratch, VOICE48, { pattern, chance: 100, tempo: 100, beats: 2 }).ch[0]
      assert.equal(y.length, x.length + ph.length * 2 * beat, pattern)
      // the scratch itself is not silent
      const s = ph[0].start
      assert.ok(rmsDb(y.subarray(s, s + 2 * beat)) > rmsDb(x) - 20, pattern + ' scratch is too quiet')
    }
    const spin = run(MODS.scratch, VOICE48, { pattern: 'backspin', where: 'end' }).ch[0]
    assert.ok(spin.length > x.length + 0.5 * 48000)
  })

  test('Tape stop slows to silence at the end, pitch falling', () => {
    const sr = 48000
    const v = mono(synthVoice(sr, 3, { seed: 5, f0: 180, fricatives: false }))
    const x = v.ch[0]
    const n = x.length
    const ph = findPhrases(x, sr)
    const E = ph[ph.length - 1].end
    const D = Math.round(1.2 * sr)
    const y = run(MODS.tapestop, v, { stopMs: 1200 }).ch[0]
    // a steady stop reads half its length of input
    assert.ok(Math.abs(y.length - (n + D - D / 2)) < 0.01 * sr)
    const P = Math.round(E - D / 2)
    const early = spectralCentroid(y.subarray(P, P + Math.round(0.25 * D)), sr)
    const late = spectralCentroid(y.subarray(P + Math.round(0.55 * D), P + Math.round(0.8 * D)), sr)
    assert.ok(late < 0.7 * early, 'centroid ' + early.toFixed(0) + ' -> ' + late.toFixed(0) + ' Hz did not fall')
    // after the stop: silence
    assert.ok(rmsDb(y.subarray(P + D, y.length)) < -90)
    // before it: the input, untouched
    assert.ok(corr(y.subarray(0, P - 1000), x.subarray(0, P - 1000)) > 0.99999)
    // a start-up begins in silence and catches up
    const z = run(MODS.tapestop, v, { motion: 'start', stopMs: 600 }).ch[0]
    const S = ph[0].start
    assert.ok(rmsDb(z.subarray(S, S + Math.round(0.05 * sr))) < rmsDb(x.subarray(S + Math.round(0.3 * sr), S + Math.round(0.35 * sr))) - 15)
    assert.ok(z.length > n)
  })

  test('Slow-motion stretch: longer by the factor, pitch kept or dropped', () => {
    const sr = 48000
    const v = mono(synthVoice(sr, 2.5, { seed: 6, f0: 150 }))
    const x = v.ch[0]
    const f0 = medianF0(x, sr)
    for (const vowels of [false, true]) {
      const y = run(MODS.drawl, v, { factor: 2, vowels }).ch[0]
      assert.ok(Math.abs(y.length / x.length - 2) < 0.06, 'keep, vowels ' + vowels + ': length ratio ' + (y.length / x.length).toFixed(3))
      const g = medianF0(y, sr)
      assert.ok(Math.abs(g / f0 - 1) < 0.05, 'keep, vowels ' + vowels + ': pitch moved ' + f0.toFixed(1) + ' -> ' + g.toFixed(1))
      const z = run(MODS.drawl, v, { factor: 2, vowels, pitch: 'drop' }).ch[0]
      assert.ok(Math.abs(z.length / x.length - 2) < 0.06, 'drop: length ratio ' + (z.length / x.length).toFixed(3))
      // slowed tape: the pitch falls by the factor (vowel weighting is for
      // the kept-pitch drawl only)
      const h = medianF0(z, sr, { minHz: 40 })
      assert.ok(Math.abs(h / (f0 / 2) - 1) < 0.06, 'drop: pitch ' + h.toFixed(1) + ', wanted about ' + (f0 / 2).toFixed(1))
    }
    for (const ramp of ['slowing', 'catching']) {
      const y = run(MODS.drawl, v, { factor: 2, ramp }).ch[0]
      assert.ok(Math.abs(y.length / x.length - 2) < 0.1, ramp + ': length ratio ' + (y.length / x.length).toFixed(3))
    }
  })
})

function reversedAround(x, start, end, a, b) {
  // the reversal of x[start, end) placed in its own spot, read over [a, b)
  const out = new Float32Array(b - a)
  for (let p = a; p < b; p++) out[p - a] = x[start + end - 1 - p]
  return out
}

// ---------------------------------------------------------------- 4. no clicks

describe('time family: splices are smooth', () => {
  const sr = 48000
  const tone = sineBursts(sr, 4)
  const cases = [
    ['reverse', {}],
    ['reversewords', { unit: 'slices', sliceMs: 70 }],
    ['reversewords', {}],
    ['palindrome', { unit: 'phrases', gapMs: 0 }],
    ['stutter', { where: 'everywhere', chance: 100, pieceMs: 37, gate: 30 }],
    ['stutter', { chance: 100, roll: 'faster', repeats: 6, gate: 0 }],
    ['glitch', { density: 100, pitch: 0, roll: 0 }],
    ['glitch', { density: 100, pitch: 0, roll: 100, reverse: 100 }],
    ['shuffle', { unit: 'slices', sliceMs: 90, amount: 100, reverse: 50 }],
    ['tapestop', { when: 'random', motion: 'both' }],
    ['trim', { longerThan: 100, keepMs: 0 }],
  ]
  for (const [id, p] of cases) {
    test(id + ' ' + JSON.stringify(p) + ' adds no clicks', () => {
      const out = run(MODS[id], tone, p)
      const all = bandEnergyDb(out.ch[0], sr, 0, sr / 2)
      const hi = bandEnergyDb(out.ch[0], sr, 4000, sr / 2)
      assert.ok(hi - all < -55, 'energy above 4 kHz is ' + (hi - all).toFixed(1) + ' dB under the signal')
    })
  }
  test('the ruler hears a hard splice', () => {
    // 37 ms pieces taken from scattered places and butted together with
    // hard cuts, for comparison
    const x = tone.ch[0]
    const y = new Float32Array(x.length)
    const L = Math.round(0.037 * sr)
    for (let i = 0; i < x.length; i++) {
      const k = Math.floor(i / L)
      y[i] = x[((k * 7919) % (x.length - L)) + (i % L)]
    }
    const all = bandEnergyDb(y, sr, 0, sr / 2)
    const hi = bandEnergyDb(y, sr, 4000, sr / 2)
    assert.ok(hi - all > -55, 'hard splices measured ' + (hi - all).toFixed(1) + ' dB')
  })
})

// ---------------------------------------------------------------- 5. real speech and speed

describe('time family: real speech', () => {
  const have = SPEECH.filter((f) => existsSync(f))
  test('every module at its defaults on two real voices', { skip: have.length ? false : 'speech files not found' }, () => {
    for (const f of have) {
      const b = decodeWav(new Uint8Array(readFileSync(f)))
      const take = { sr: b.sr, ch: [b.ch[0].slice(0, Math.min(b.ch[0].length, 9 * b.sr))] }
      for (const id of IDS) {
        const out = run(MODS[id], take, {})
        assertSane(out)
        assert.ok(out.ch[0].length > 0.5 * take.ch[0].length, id + ' lost most of the take')
        assert.ok(rmsDb(out) > rmsDb(take) - 6, id + ' came out far too quiet')
      }
    }
  })
})

describe('time family: speed', () => {
  const sec = 10
  const take = mono(synthVoice(48000, sec, { seed: 21 }))
  const bound = { 1: 60, 2: 60, 3: 150, 4: 400, 5: 1200 } // ms per second of 48 kHz mono, generous for a shared machine
  for (const id of IDS) {
    test(id + ' runs fast enough', () => {
      const mod = MODS[id]
      run(mod, take, {}) // warm up
      const ms = timeIt(() => run(mod, take, {}), 2) / sec
      assert.ok(ms < bound[mod.cost], id + ' took ' + ms.toFixed(1) + ' ms per second (cost ' + mod.cost + ')')
    })
  }
})
