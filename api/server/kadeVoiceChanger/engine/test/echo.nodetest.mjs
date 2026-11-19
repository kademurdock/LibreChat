// test/echo.nodetest.mjs - the echo family (modules/echo/*.js).
//
// What it proves, module by module, on impulses, tone bursts, chirps, the
// synthetic talker (test/fixtures.mjs) and, when present, real speech:
// - every module passes core/params.js validateModuleShape;
// - the robustness battery of CONTRACT section 4: empty input, silence, a
//   click, speech, stereo input, every numeric param at min, default and max
//   one at a time, every choice, at 48 kHz and 22.05 kHz (8 and 96 kHz at
//   defaults): no NaN or Infinity, peak under 8, output length exactly input
//   plus the declared tail, the same seed gives the same output;
// - live versions: block sizes 128 and 480 give the same output, the live
//   kernel gives exactly the offline output over the take, in-place buffers
//   (outs aliasing ins) work, and set() mid-stream stays finite without
//   clicks;
// - "prove it" behaviour: echo times and ping-pong sides, tempo lock, tape
//   wobble really wobbles pitch, rhythm taps land on the pattern's beats,
//   the slap and the stadium's second slap, reverse echo really is the input
//   backwards (and alternate repeats flip forwards again), canyon answers
//   arrive at the round-trip time of sound, come back the chosen number of
//   times and get darker, dub repeats are band limited and run away above
//   90 percent while staying bounded, and the reverse reverb swell rises
//   before a sound and stops at it;
// - speed per second of 48 kHz audio, against generous bounds.
//
// Run: node --test engine/test/echo.nodetest.mjs (Node 24).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { synthVoice, impulse, silence, sine, chirp } from './fixtures.mjs'
import { assertSane, timeIt, spectralCentroid, rmsDb, bandEnergyDb } from './measure.mjs'
import { resolveParams, validateModuleShape } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'

import delay from '../modules/echo/delay.js'
import multitap from '../modules/echo/multitap.js'
import slapback from '../modules/echo/slapback.js'
import reverse from '../modules/echo/reverse.js'
import canyon from '../modules/echo/canyon.js'
import dub from '../modules/echo/dub.js'
import preverb from '../modules/echo/preverb.js'

const ALL = [delay, multitap, slapback, reverse, canyon, dub, preverb]
const LIVE = [delay, multitap, slapback, reverse, canyon, dub]
const SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'

function run(mod, input, p = {}, seed = 1) {
  const rp = resolveParams(mod, p)
  return mod.process(input, rp, { sr: input.sr, rng: makeRng(seed) })
}

function expectLen(mod, input, out, p) {
  const rp = resolveParams(mod, p)
  const want = input.ch[0].length + Math.round(mod.tail(rp, input.sr) * input.sr)
  assert.equal(out.ch[0].length, want, mod.id + ' length is input plus tail for ' + JSON.stringify(p))
}

function stereoOf(b) {
  const L = new Float32Array(b.ch[0])
  const R = new Float32Array(b.ch[0].length)
  for (let i = 0; i < R.length; i++) R[i] = -0.7 * L[R.length - 1 - i]
  return { sr: b.sr, ch: [L, R] }
}

/** Envelope (4 ms release peak follower) of a signal. */
function envelope(s, sr) {
  const n = s.length
  const env = new Float32Array(n)
  const c = Math.exp(-1 / (0.004 * sr))
  let y = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(s[i])
    y = a > y ? a : c * y + (1 - c) * a
    env[i] = y
  }
  return env
}

/** Envelope peaks (time in ms, level) above thrDb of the loudest, at least 30 ms apart. */
function peaks(s, sr, thrDb = -40) {
  const env = envelope(s, sr)
  let mx = 0
  for (let i = 0; i < env.length; i++) if (env[i] > mx) mx = env[i]
  const thr = mx * Math.pow(10, thrDb / 20)
  const W = Math.round(0.03 * sr)
  const out = []
  for (let i = 0; i < env.length; i++) {
    if (env[i] < thr) continue
    let ok = true
    for (let j = Math.max(0, i - W); j <= Math.min(env.length - 1, i + W); j++) {
      if (env[j] > env[i] || (env[j] === env[i] && j < i)) {
        ok = false
        break
      }
    }
    if (ok) out.push({ ms: (i / sr) * 1000, v: env[i], db: 20 * Math.log10(env[i] / mx) })
  }
  return out
}

/** First sample index with |s| above thr at or after `from`. */
function firstAbove(s, thr, from = 0) {
  for (let i = from; i < s.length; i++) if (Math.abs(s[i]) > thr) return i
  return -1
}

function energy(s, a, b) {
  let e = 0
  for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) e += s[i] * s[i]
  return e
}

function corr(a, b) {
  let ab = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
}

/** Run a live kernel over a buffer in blocks; optionally in place. */
function runLive(mod, input, p, block, { seed = 1, inPlace = false, changeAt = -1, change = null } = {}) {
  const sr = input.sr
  const rp = resolveParams(mod, p)
  const k = mod.live.create(sr, rp, makeRng(seed))
  const n = input.ch[0].length
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  let src
  if (inPlace) {
    L.set(input.ch[0])
    if (input.ch.length > 1) R.set(input.ch[1])
    src = input.ch.length > 1 ? [L, R] : [L]
  } else {
    src = input.ch
  }
  let changed = false
  for (let s = 0; s < n; s += block) {
    const e = Math.min(n, s + block)
    if (change && !changed && s >= changeAt) {
      k.set(resolveParams(mod, Object.assign({}, p, change)))
      changed = true
    }
    const ins = src.map((c) => c.subarray(s, e))
    const outs = [L.subarray(s, e), R.subarray(s, e)]
    k.process(ins, outs, e - s)
  }
  return { sr, ch: [L, R] }
}

function maxDiff(s, a, b) {
  let m = 0
  for (let i = Math.max(1, a); i < Math.min(s.length, b); i++) {
    const d = Math.abs(s[i] - s[i - 1])
    if (d > m) m = d
  }
  return m
}

// ---------------------------------------------------------------- shape

describe('echo family: shape', () => {
  for (const mod of ALL) {
    test(mod.id + ' passes validateModuleShape', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'echo')
      assert.equal(mod.warps, false)
      assert.equal(mod.stereo, 'make')
      assert.ok(mod.params.length >= 2 && mod.params.length <= 8, 'two to eight params')
    })
  }
  test('live versions exist for delay, multitap, slapback, dub, canyon, reverse and not for the swell', () => {
    for (const m of LIVE) assert.ok(m.live && typeof m.live.create === 'function', m.id + ' has live')
    assert.equal(preverb.live, undefined)
    for (const m of LIVE) assert.equal(m.live.latency(resolveParams(m, {}), 48000), 0, m.id + ' adds no latency to the dry path')
  })
})

// ---------------------------------------------------------------- robustness

function sweepSettings(mod) {
  const list = [{}]
  for (const p of mod.params) {
    if (p.type === 'number') {
      list.push({ [p.id]: p.min }, { [p.id]: p.max })
    } else if (p.type === 'choice') {
      for (const o of p.options) if (o.v !== p.def) list.push({ [p.id]: o.v })
    } else if (p.type === 'bool') {
      list.push({ [p.id]: !p.def })
    }
  }
  return list
}

describe('echo family: robustness battery', () => {
  for (const mod of ALL) {
    test(mod.id + ' survives empty, silence, click, speech, stereo, every setting at 48 and 22.05 kHz', () => {
      for (const sr of [48000, 22050]) {
        const voice = synthVoice(sr, 1, { seed: 3 })
        const inputs = [
          { sr, ch: [new Float32Array(0)] },
          silence(sr, 0.5),
          impulse(sr, 0.5, 0.1),
          { sr, ch: [voice.ch[0]] },
          stereoOf(voice),
        ]
        const settings = sr === 48000 ? sweepSettings(mod) : sweepSettings(mod).filter((_, i) => i % 2 === 0)
        for (const p of settings) {
          for (const inp of inputs) {
            const copy = { sr, ch: inp.ch.map((c) => new Float32Array(c)) }
            const out = run(mod, copy, p)
            assertSane(out, { maxPeak: 8 })
            assert.equal(out.ch.length, 2, mod.id + ' makes stereo')
            expectLen(mod, inp, out, p)
          }
        }
        // silence stays silent
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
      const a = run(mod, { sr: v.sr, ch: [new Float32Array(v.ch[0])] }, {}, 9)
      const b = run(mod, { sr: v.sr, ch: [new Float32Array(v.ch[0])] }, {}, 9)
      assert.deepEqual(a.ch[0], b.ch[0])
      assert.deepEqual(a.ch[1], b.ch[1])
    })

    test(mod.id + ' tail is a finite number of seconds, at most 20, for every setting', () => {
      for (const p of sweepSettings(mod)) {
        const t = mod.tail(resolveParams(mod, p), 48000)
        assert.ok(Number.isFinite(t) && t >= 0 && t <= 20, mod.id + ' tail ' + t + ' for ' + JSON.stringify(p))
      }
    })
  }
})

// ---------------------------------------------------------------- live

describe('echo family: live versions', () => {
  for (const mod of LIVE) {
    test(mod.id + ' live: block size does not matter, matches offline, works in place', () => {
      const sr = 48000
      const v = synthVoice(sr, 1.5, { seed: 6 })
      const settings = [{}, ...sweepSettings(mod).filter((_, i) => i % 3 === 1)]
      for (const p of settings) {
        const a = runLive(mod, v, p, 128)
        const b = runLive(mod, v, p, 480)
        for (let c = 0; c < 2; c++) {
          let m = 0
          for (let i = 0; i < a.ch[c].length; i++) m = Math.max(m, Math.abs(a.ch[c][i] - b.ch[c][i]))
          assert.ok(m < 1e-4, mod.id + ' blocks 128 and 480 differ by ' + m + ' for ' + JSON.stringify(p))
        }
        const off = run(mod, v, p)
        for (let c = 0; c < 2; c++) {
          let m = 0
          for (let i = 0; i < a.ch[c].length; i++) m = Math.max(m, Math.abs(a.ch[c][i] - off.ch[c][i]))
          assert.ok(m < 1e-5, mod.id + ' live differs from offline by ' + m)
        }
        const ip = runLive(mod, v, p, 480, { inPlace: true })
        let m = 0
        for (let i = 0; i < ip.ch[0].length; i++) m = Math.max(m, Math.abs(ip.ch[0][i] - b.ch[0][i]), Math.abs(ip.ch[1][i] - b.ch[1][i]))
        assert.ok(m < 1e-6, mod.id + ' in-place differs by ' + m)
      }
      // stereo in, odd block sizes
      const st = stereoOf(v)
      const s1 = runLive(mod, st, {}, 1)
      const s2 = runLive(mod, st, {}, 333)
      let m = 0
      for (let i = 0; i < s1.ch[0].length; i++) m = Math.max(m, Math.abs(s1.ch[0][i] - s2.ch[0][i]), Math.abs(s1.ch[1][i] - s2.ch[1][i]))
      assert.ok(m < 1e-4, mod.id + ' stereo blocks differ by ' + m)
      assertSane(s1)
    })

    test(mod.id + ' live: set() mid-stream is smooth and reset() clears', () => {
      const sr = 48000
      const tone = sine(sr, 3, 220, 0.3)
      const half = Math.round(1.5 * sr)
      // a slider-like move on every numeric param at once (10 percent of its range)
      const change = {}
      for (const p of mod.params) {
        if (p.type !== 'number') continue
        change[p.id] = Math.min(p.max, p.def + 0.1 * (p.max - p.min))
      }
      const out = runLive(mod, tone, {}, 128, { changeAt: half, change })
      assertSane(out, { maxPeak: 8 })
      for (let c = 0; c < 2; c++) {
        const before = maxDiff(out.ch[c], half - sr / 2, half)
        const after = maxDiff(out.ch[c], half, half + sr / 4)
        assert.ok(after < Math.max(3 * before, 0.05), mod.id + ' jump after set: ' + after.toFixed(4) + ' vs ' + before.toFixed(4))
      }
      // every choice switched mid-stream stays finite
      for (const p of mod.params) {
        if (p.type !== 'choice') continue
        for (const o of p.options) {
          const o2 = runLive(mod, tone, {}, 480, { changeAt: half, change: { [p.id]: o.v } })
          assertSane(o2, { maxPeak: 8 })
        }
      }
      // reset clears every echo
      const k = mod.live.create(sr, resolveParams(mod, {}), makeRng(1))
      const ins = [tone.ch[0].subarray(0, 4800)]
      const L = new Float32Array(4800)
      const R = new Float32Array(4800)
      k.process(ins, [L, R], 4800)
      k.reset()
      const z = new Float32Array(48000)
      const L2 = new Float32Array(48000)
      const R2 = new Float32Array(48000)
      k.process([z], [L2, R2], 48000)
      assert.equal(rmsDb(L2), -200, mod.id + ' reset leaves nothing ringing')
      assert.equal(rmsDb(R2), -200)
      // a mono output array gets the fold-down
      const k2 = mod.live.create(sr, resolveParams(mod, {}), makeRng(1))
      const M = new Float32Array(4800)
      k2.process([tone.ch[0].subarray(0, 4800)], [M], 4800)
      assertSane({ sr, ch: [M] })
    })
  }
})

// ---------------------------------------------------------------- echo.delay

describe('echo.delay', () => {
  const sr = 48000
  test('first echo lands at the echo time; ping-pong alternates left and right', () => {
    const imp = impulse(sr, 0.2, 0)
    const out = run(delay, imp, { time: 250, feedback: 50, damping: 0, mix: 50 })
    const pl = peaks(out.ch[0], sr, -45).filter((x) => x.ms > 5)
    const pr = peaks(out.ch[1], sr, -45).filter((x) => x.ms > 5)
    assert.ok(Math.abs(pl[0].ms - 250) < 2, 'left first echo at ' + pl[0].ms)
    assert.ok(Math.abs(pr[0].ms - 500) < 2, 'right first echo at ' + pr[0].ms)
    assert.ok(Math.abs(pl[1].ms - 750) < 2, 'left second echo at ' + pl[1].ms)
    // each bounce is about the feedback quieter (filters take a little more)
    const r = pr[0].v / pl[0].v
    assert.ok(r > 0.3 && r < 0.55, 'bounce ratio ' + r)
  })

  test('centered mode on a mono voice gives identical channels; wide does not', () => {
    const v = synthVoice(sr, 1, { seed: 2 })
    const c = run(delay, v, { stereo: 'mono' })
    assert.deepEqual(c.ch[0], c.ch[1])
    const w = run(delay, v, { stereo: 'wide' })
    let d = 0
    for (let i = 0; i < w.ch[0].length; i++) d = Math.max(d, Math.abs(w.ch[0][i] - w.ch[1][i]))
    assert.ok(d > 0.01, 'wide channels differ')
  })

  test('tempo lock: a quarter note at 120 bpm is 500 ms, a dotted eighth at 100 bpm is 450 ms', () => {
    const imp = impulse(sr, 0.1, 0)
    const q = run(delay, imp, { division: 'quarter', tempo: 120, stereo: 'mono', feedback: 0, mix: 50 })
    assert.ok(Math.abs(firstAbove(q.ch[0], 0.05, 10) / sr - 0.5) < 0.002)
    const d = run(delay, imp, { division: 'dotted', tempo: 100, stereo: 'mono', feedback: 0, mix: 50 })
    assert.ok(Math.abs(firstAbove(d.ch[0], 0.05, 10) / sr - 0.45) < 0.002)
  })

  test('darker repeats lose highs; more repeats ring longer', () => {
    const noise = new Float32Array(sr * 0.05)
    const r = makeRng(3)
    for (let i = 0; i < noise.length; i++) noise[i] = r.next() * 2 - 1
    const x = { sr, ch: [noise] }
    const bright = run(delay, x, { damping: 0, stereo: 'mono', feedback: 60, mix: 100, time: 200 })
    const dark = run(delay, x, { damping: 90, stereo: 'mono', feedback: 60, mix: 100, time: 200 })
    const seg = (b) => b.ch[0].subarray(Math.round(0.6 * sr), Math.round(0.66 * sr))
    assert.ok(spectralCentroid(seg(dark), sr) < 0.6 * spectralCentroid(seg(bright), sr), 'damping darkens the third repeat')
    const few = run(delay, x, { feedback: 10, stereo: 'mono', mix: 100 })
    const many = run(delay, x, { feedback: 80, stereo: 'mono', mix: 100 })
    const late = (b) => rmsDb(b.ch[0].subarray(Math.round(1.5 * sr), Math.round(2 * sr)))
    assert.ok(late(many) > late(few) + 30, 'feedback makes the echoes last')
    assert.ok(delay.tail(resolveParams(delay, { feedback: 80 }), sr) > delay.tail(resolveParams(delay, { feedback: 10 }), sr))
  })

  test('tape wobble bends the pitch of the echoes', () => {
    const tone = sine(sr, 2, 500, 0.4)
    const spreadOf = (b) => {
      // zero-crossing period spread of the echo once the dry has stopped
      const s = b.ch[0]
      const a = Math.round(2.1 * sr)
      const e = Math.round(2.3 * sr)
      const per = []
      let last = -1
      for (let i = a + 1; i < e; i++) {
        if (s[i - 1] < 0 && s[i] >= 0) {
          const t = i - 1 + s[i - 1] / (s[i - 1] - s[i])
          if (last >= 0) per.push(t - last)
          last = t
        }
      }
      per.sort((x, y) => x - y)
      return per[Math.floor(per.length * 0.95)] - per[Math.floor(per.length * 0.05)]
    }
    const flat = run(delay, tone, { wobble: 0, stereo: 'mono', time: 400, feedback: 0, mix: 100 })
    const wob = run(delay, tone, { wobble: 100, stereo: 'mono', time: 400, feedback: 0, mix: 100 })
    assert.ok(spreadOf(wob) > spreadOf(flat) + 0.5, 'periods spread ' + spreadOf(wob) + ' vs ' + spreadOf(flat))
  })
})

// ---------------------------------------------------------------- echo.multitap

describe('echo.multitap', () => {
  const sr = 48000
  test('taps land on the pattern beats (gallop at 120 bpm) and spread across the ears', () => {
    const out = run(multitap, impulse(sr, 0.1, 0), { pattern: 'gallop', tempo: 120, feedback: 0, damping: 0, mix: 50, spread: 100 })
    const m = new Float32Array(out.ch[0].length)
    for (let i = 0; i < m.length; i++) m[i] = Math.abs(out.ch[0][i]) + Math.abs(out.ch[1][i])
    const pk = peaks(m, sr, -30).filter((x) => x.ms > 5).map((x) => x.ms)
    const want = [250, 375, 500, 750, 875, 1000]
    assert.equal(pk.length, want.length, 'six taps: ' + pk.map((x) => x.toFixed(0)).join(' '))
    for (let k = 0; k < want.length; k++) assert.ok(Math.abs(pk[k] - want[k]) < 2, 'tap ' + k + ' at ' + pk[k])
    // first tap leans left, third right
    const at = (ms) => Math.round((ms / 1000) * sr)
    const eL = energy(out.ch[0], at(240), at(270))
    const eR = energy(out.ch[1], at(240), at(270))
    assert.ok(eL > 4 * eR, 'first tap on the left')
    const e3L = energy(out.ch[0], at(490), at(520))
    const e3R = energy(out.ch[1], at(490), at(520))
    assert.ok(e3R > 2 * e3L, 'third tap to the right')
  })

  test('every pattern makes a distinct rhythm, and pattern repeats recirculate it', () => {
    const p = multitap.params.find((x) => x.id === 'pattern')
    const sigs = new Set()
    for (const o of p.options) {
      const out = run(multitap, impulse(sr, 0.1, 0), { pattern: o.v, tempo: 120, feedback: 0, mix: 50 })
      const m = new Float32Array(out.ch[0].length)
      for (let i = 0; i < m.length; i++) m[i] = Math.abs(out.ch[0][i]) + Math.abs(out.ch[1][i])
      const pk = peaks(m, sr, -30).filter((x) => x.ms > 5)
      assert.ok(pk.length >= 4, o.v + ' has at least four taps')
      sigs.add(pk.map((x) => Math.round(x.ms / 20)).join(','))
    }
    assert.equal(sigs.size, p.options.length, 'all patterns differ')
    const once = run(multitap, impulse(sr, 0.1, 0), { pattern: 'even', tempo: 120, feedback: 0, mix: 100 })
    const again = run(multitap, impulse(sr, 0.1, 0), { pattern: 'even', tempo: 120, feedback: 60, mix: 100 })
    // the "even" cycle is two beats (1 s): with repeats the pattern plays again from 1.25 s
    const late = (b) => energy(b.ch[0], Math.round(1.2 * sr), Math.round(2.1 * sr)) + energy(b.ch[1], Math.round(1.2 * sr), Math.round(2.1 * sr))
    assert.ok(late(again) > 100 * late(once) + 1e-6, 'pattern repeats')
  })
})

// ---------------------------------------------------------------- echo.slapback

describe('echo.slapback', () => {
  const sr = 48000
  test('one slap at the slap time and level, dry untouched', () => {
    const out = run(slapback, impulse(sr, 0.1, 0), { time: 120, level: 50, character: 'clean', spread: 0 })
    assert.ok(Math.abs(out.ch[0][0] - 1) < 1e-6, 'dry impulse kept')
    const i = firstAbove(out.ch[0], 0.05, 10)
    assert.ok(Math.abs(i / sr - 0.12) < 0.002, 'slap at ' + i / sr)
    assert.deepEqual(out.ch[0], out.ch[1], 'no spread: centred')
    // level: a 1 kHz burst comes back at the slap level (50 percent is -6 dB)
    const burst = new Float32Array(Math.round(0.5 * sr))
    for (let k = 0; k < Math.round(0.08 * sr); k++) burst[k] = 0.5 * Math.sin((2 * Math.PI * 1000 * k) / sr)
    const ob = run(slapback, { sr, ch: [burst] }, { time: 120, level: 50, character: 'clean', spread: 0 })
    // the burst ends at 80 ms, so 130..190 ms holds only the slap
    const slapDb = rmsDb(ob.ch[0].subarray(Math.round(0.13 * sr), Math.round(0.19 * sr)))
    const dryDb = rmsDb(burst.subarray(Math.round(0.01 * sr), Math.round(0.07 * sr)))
    assert.ok(Math.abs(slapDb - dryDb + 6) < 1.5, 'slap under the voice by ' + (dryDb - slapDb).toFixed(2) + ' dB')
    // nothing after the slap without extra slaps
    assert.ok(energy(out.ch[0], Math.round(0.2 * sr), out.ch[0].length) < 1e-8)
  })

  test('stadium answers again from the far stands and is darker than tape', () => {
    const out = run(slapback, impulse(sr, 0.1, 0), { time: 150, level: 80, character: 'stadium', spread: 0 })
    const e1 = energy(out.ch[0], Math.round(0.14 * sr), Math.round(0.2 * sr))
    const e2 = energy(out.ch[0], Math.round(0.23 * sr), Math.round(0.3 * sr))
    assert.ok(e2 > 0.05 * e1, 'second slap at 1.6 times the time')
    const v = synthVoice(sr, 1, { seed: 8 })
    const wetOnly = (ch) => {
      const o = run(slapback, v, { character: ch, level: 100, spread: 0 })
      const w = new Float32Array(v.ch[0].length)
      for (let k = 0; k < w.length; k++) w[k] = o.ch[0][k] - v.ch[0][k]
      return w
    }
    // darker: much less 3-8 kHz against the 0.5-2 kHz body than a clean slap
    const tilt = (w) => bandEnergyDb(w, sr, 3000, 8000) - bandEnergyDb(w, sr, 500, 2000)
    const ts = tilt(wetOnly('stadium'))
    const tc = tilt(wetOnly('clean'))
    assert.ok(ts < tc - 8, 'stadium top ' + ts.toFixed(1) + ' dB vs clean ' + tc.toFixed(1) + ' dB')
    const tt = tilt(wetOnly('tape'))
    assert.ok(tt < tc - 3, 'tape top ' + tt.toFixed(1) + ' dB, darker than clean too')
  })
})

// ---------------------------------------------------------------- echo.reverse

describe('echo.reverse', () => {
  const sr = 48000
  // a rising chirp from 50 to 450 ms, then silence
  function chirpTake() {
    const c = chirp(sr, 0.4, 300, 3000, 0.5)
    const x = new Float32Array(Math.round(1.6 * sr))
    x.set(c.ch[0], Math.round(0.05 * sr))
    return { sr, ch: [x] }
  }
  const seg = (s, a, b) => s.subarray(Math.round(a * sr), Math.round(b * sr))

  test('each echo is the slice played backwards', () => {
    const x = chirpTake()
    const out = run(reverse, x, { length: 500, feedback: 0, smooth: 0, damping: 0, spread: 0, mix: 100 })
    // the chirp at 0.05..0.45 s comes back reversed at 0.55..0.95 s
    const wet = seg(out.ch[0], 0.56, 0.94)
    const rev = new Float32Array(wet.length)
    const src = x.ch[0]
    for (let i = 0; i < rev.length; i++) rev[i] = src[Math.round(1.0 * sr) - Math.round(0.56 * sr) - i - 2]
    const fwd = seg(src, 0.06, 0.44)
    assert.ok(corr(wet, rev) > 0.95, 'matches the reversed input: ' + corr(wet, rev))
    assert.ok(Math.abs(corr(wet, fwd)) < 0.2, 'not the forward input')
    // and its pitch falls where the input rose
    const a = spectralCentroid(seg(out.ch[0], 0.56, 0.7), sr)
    const b = spectralCentroid(seg(out.ch[0], 0.8, 0.94), sr)
    assert.ok(a > 1.5 * b, 'falling sweep ' + a.toFixed(0) + ' then ' + b.toFixed(0))
    // the dry path is untouched at mix 50: during the first slice nothing has been
    // reversed yet, so the output is exactly the input
    const half = run(reverse, x, { mix: 50, length: 500 })
    for (let i = 0; i < Math.round(0.5 * sr); i++) {
      if (half.ch[0][i] !== x.ch[0][i] || half.ch[1][i] !== x.ch[0][i]) assert.fail('dry changed at sample ' + i)
    }
  })

  test('all backwards repeats stay backwards; alternate repeats flip forwards', () => {
    const x = chirpTake()
    const src = x.ch[0]
    const back = run(reverse, x, { length: 500, feedback: 60, repeats: 'backward', smooth: 0, damping: 0, spread: 0, mix: 100 })
    const alt = run(reverse, x, { length: 500, feedback: 60, repeats: 'alternate', smooth: 0, damping: 0, spread: 0, mix: 100 })
    const w1 = seg(back.ch[0], 1.06, 1.44)
    const w2 = seg(alt.ch[0], 1.06, 1.44)
    const revRef = new Float32Array(w1.length)
    for (let i = 0; i < revRef.length; i++) revRef[i] = src[Math.round(0.44 * sr) - i]
    const fwdRef = seg(src, 0.06, 0.44)
    // compare by shape of the falling or rising sweep (centroid of halves), robust to small offsets
    const trend = (w) => spectralCentroid(w.subarray(0, w.length >> 1), sr) / spectralCentroid(w.subarray(w.length >> 1), sr)
    assert.ok(trend(w1) > 1.4, 'second repeat still backwards (falling): ' + trend(w1))
    assert.ok(trend(w2) < 0.7, 'alternate second repeat forwards (rising): ' + trend(w2))
    assert.ok(trend(revRef) > 1.4 && trend(fwdRef) < 0.7)
  })

  test('spread puts alternate slices on alternate sides', () => {
    const v = synthVoice(sr, 3, { seed: 11 })
    const out = run(reverse, v, { length: 400, spread: 100, mix: 100, feedback: 0 })
    let leftHeavy = 0
    let rightHeavy = 0
    for (let k = 1; k < 7; k++) {
      const a = Math.round((k * 0.4 + 0.1) * sr)
      const b = Math.round((k * 0.4 + 0.3) * sr)
      const l = energy(out.ch[0], a, b)
      const r = energy(out.ch[1], a, b)
      if (l > 1.5 * r) leftHeavy++
      if (r > 1.5 * l) rightHeavy++
    }
    assert.ok(leftHeavy >= 2 && rightHeavy >= 2, 'slices alternate ears: ' + leftHeavy + ' left, ' + rightHeavy + ' right')
  })
})

// ---------------------------------------------------------------- echo.canyon

describe('echo.canyon', () => {
  test('the first answer comes after the round trip at the speed of sound', () => {
    const sr = 24000
    for (const d of [50, 170, 400]) {
      const out = run(canyon, impulse(sr, 0.1, 0), { distance: d, mix: 100 })
      const s = new Float32Array(out.ch[0].length)
      for (let i = 0; i < s.length; i++) s[i] = Math.abs(out.ch[0][i]) + Math.abs(out.ch[1][i])
      let mx = 0
      for (const v of s) mx = Math.max(mx, v)
      const i = firstAbove(s, mx * 0.05, 0)
      const want = (2 * d) / 343
      assert.ok(Math.abs(i / sr - want) < 0.02, d + ' m answers at ' + (i / sr).toFixed(3) + ' s, want ' + want.toFixed(3))
    }
  })

  test('Echoes sets how many answers come back, and later answers are darker', () => {
    const sr = 24000
    const x = new Float32Array(sr / 2)
    for (let i = 0; i < 0.06 * sr; i++) x[i] = Math.sin(i * 0.3) * Math.sin(i * 0.037) * 0.8
    const W = Math.round(0.02 * sr)
    for (let c = 1; c <= 8; c++) {
      const out = run(canyon, { sr, ch: [new Float32Array(x)] }, { count: c, mix: 100 })
      const e = []
      for (let s = 0; s + W <= out.ch[0].length; s += W) e.push(Math.sqrt((energy(out.ch[0], s, s + W) + energy(out.ch[1], s, s + W)) / W))
      let mx = 0
      for (const v of e) mx = Math.max(mx, v)
      const pk = []
      for (let k = 2; k < e.length - 2; k++) {
        if (e[k] > e[k - 1] && e[k] >= e[k + 1] && e[k] > mx * 0.0316) {
          const t = (k * W) / sr
          if (pk.length && t - pk[pk.length - 1] < 0.15) continue
          pk.push(t)
        }
      }
      assert.ok(Math.abs(pk.length - c) <= 1, c + ' echoes asked, ' + pk.length + ' heard')
    }
    // darker: the third answer has a lower centroid than the first
    const v = { sr, ch: [new Float32Array(sr)] }
    const r = makeRng(5)
    for (let i = 0; i < 0.08 * sr; i++) v.ch[0][i] = (r.next() * 2 - 1) * 0.5
    const out = run(canyon, v, { count: 6, distance: 170, mix: 100, darken: 60 })
    const m = new Float32Array(out.ch[0].length)
    for (let i = 0; i < m.length; i++) m[i] = out.ch[0][i] + out.ch[1][i]
    // first answer: the near wall at 0.99 s; third: both walls together at 0.99 + 1.37 s
    const first = m.subarray(Math.round(0.99 * sr), Math.round(1.12 * sr))
    const third = m.subarray(Math.round(2.35 * sr), Math.round(2.5 * sr))
    assert.ok(spectralCentroid(third, sr) < 0.75 * spectralCentroid(first, sr), 'answers darken')
  })
})

// ---------------------------------------------------------------- echo.dub

describe('echo.dub', () => {
  const sr = 48000
  test('repeats are band limited around the filter center', () => {
    const noise = new Float32Array(Math.round(0.05 * sr))
    const r = makeRng(4)
    for (let i = 0; i < noise.length; i++) noise[i] = r.next() * 2 - 1
    const x = { sr, ch: [noise] }
    const lo = run(dub, x, { tone: 500, sweep: 0, spring: 0, mix: 100, time: 300, feedback: 60 })
    const hi = run(dub, x, { tone: 3000, sweep: 0, spring: 0, mix: 100, time: 300, feedback: 60 })
    const rep = (b) => b.ch[0].subarray(Math.round(0.6 * sr), Math.round(0.66 * sr))
    const cl = spectralCentroid(rep(lo), sr)
    const ch = spectralCentroid(rep(hi), sr)
    assert.ok(cl < 1200 && ch > 2000 && ch > 2 * cl, 'centroids ' + cl.toFixed(0) + ' and ' + ch.toFixed(0))
  })

  test('above 90 percent it runs away and sings on, yet stays bounded', () => {
    const v = synthVoice(sr, 1, { seed: 12 })
    const tame = run(dub, v, { feedback: 60, spring: 0, mix: 100 })
    const wild = run(dub, v, { feedback: 100, spring: 0, mix: 100 })
    const lateDb = (b, t) => rmsDb(b.ch[0].subarray(Math.round(t * sr), Math.round((t + 0.5) * sr)))
    assert.ok(lateDb(wild, 5) > -35, 'runaway still singing at 5 s: ' + lateDb(wild, 5).toFixed(1))
    assert.ok(lateDb(wild, 5) > lateDb(tame, 3) + 20, 'runaway outlasts a tame loop')
    const pk = assertSane(wild).peak
    assert.ok(pk < 2, 'bounded at ' + pk)
    // and it fades out at the declared end
    const n = wild.ch[0].length
    assert.ok(Math.abs(wild.ch[0][n - 1]) < 1e-3)
  })

  test('spring splash adds dripping reverb between the echoes', () => {
    const imp = impulse(sr, 0.1, 0)
    const dry = run(dub, imp, { spring: 0, mix: 100, feedback: 0 })
    const wet = run(dub, imp, { spring: 100, mix: 100, feedback: 0 })
    // between the voice and the first echo there is only the spring
    const a = Math.round(0.03 * sr)
    const b = Math.round(0.3 * sr)
    assert.ok(energy(wet.ch[0], a, b) > 100 * energy(dry.ch[0], a, b) + 1e-6)
    // left and right springs differ
    assert.ok(corr(wet.ch[0].subarray(a, b), wet.ch[1].subarray(a, b)) < 0.9)
  })
})

// ---------------------------------------------------------------- echo.preverb

describe('echo.preverb', () => {
  const sr = 48000
  function burstTake(at = 2.0) {
    const x = new Float32Array(Math.round(3.5 * sr))
    const n = Math.round(0.1 * sr)
    const s0 = Math.round(at * sr)
    for (let i = 0; i < n; i++) x[s0 + i] = 0.5 * Math.sin((2 * Math.PI * 600 * i) / sr) * Math.sin((Math.PI * i) / n)
    return { sr, ch: [x] }
  }
  const bandDb = (s, a, b) => rmsDb(s.subarray(Math.round(a * sr), Math.round(b * sr)))

  test('the swell rises before the sound and stops at it', () => {
    for (const space of preverb.params.find((p) => p.id === 'space').options.map((o) => o.v)) {
      const out = run(preverb, burstTake(), { mix: 100, length: 1.4, gap: 40, space })
      const L = out.ch[0]
      // rising: each 300 ms window before the word is louder than the one before
      const w = [bandDb(L, 0.8, 1.1), bandDb(L, 1.1, 1.4), bandDb(L, 1.4, 1.7), bandDb(L, 1.7, 1.95)]
      for (let k = 1; k < w.length; k++) assert.ok(w[k] > w[k - 1] - 1, space + ' swell rises: ' + w.map((x) => x.toFixed(0)).join(' '))
      assert.ok(w[3] > w[0] + 15, space + ' swell grows by more than 15 dB')
      // before the swell starts and after the word: silence
      assert.equal(bandDb(L, 0, 0.45), -200, space + ' nothing long before')
      assert.equal(bandDb(L, 2.12, 3.5), -200, space + ' nothing after the word')
      assert.equal(out.ch[0].length, burstTake().ch[0].length, 'no tail without the halo')
    }
  })

  test('the gap moves the end of the swell ahead of the word', () => {
    const near = run(preverb, burstTake(), { mix: 100, gap: 0 })
    const far = run(preverb, burstTake(), { mix: 100, gap: 300 })
    // with a 300 ms gap the last 250 ms before the word holds almost nothing new
    const eNear = bandDb(near.ch[0], 1.8, 2.0)
    const eFar = bandDb(far.ch[0], 1.8, 2.0)
    assert.ok(eNear > eFar + 10, 'gap clears the run-in: ' + eNear.toFixed(1) + ' vs ' + eFar.toFixed(1))
  })

  test('the halo after the word adds a forward tail and declares it', () => {
    const x = burstTake(2.0)
    const p = { mix: 50, after: 60, length: 1.0 }
    const out = run(preverb, x, p)
    expectLen(preverb, x, out, p)
    assert.ok(bandDb(out.ch[0], 2.2, 2.6) > -60, 'sound after the word')
    assert.ok(out.ch[0].length > x.ch[0].length)
  })

  test('on a voice the swell sits a little under the words and is wide', () => {
    const v = synthVoice(sr, 3, { seed: 13 })
    const out = run(preverb, v, { mix: 100 })
    const d = rmsDb(v) - rmsDb(out)
    assert.ok(d > -4 && d < 8, 'wet level against the voice ' + d.toFixed(1) + ' dB')
    let c = corr(out.ch[0], out.ch[1])
    assert.ok(c < 0.9, 'stereo swell, correlation ' + c.toFixed(2))
  })
})

// ---------------------------------------------------------------- real speech and speed

describe('echo family: real speech and speed', () => {
  test('every module on real speech (24 kHz) when the file is present', { skip: !existsSync(SPEECH) && 'speech file missing' }, () => {
    const sp = decodeWav(new Uint8Array(readFileSync(SPEECH)))
    const take = { sr: sp.sr, ch: [sp.ch[0].subarray(0, Math.min(sp.ch[0].length, 8 * sp.sr)).slice()] }
    for (const mod of ALL) {
      const out = run(mod, { sr: take.sr, ch: [new Float32Array(take.ch[0])] })
      assertSane(out)
      expectLen(mod, take, out, {})
      // the effect is audible: output differs clearly from the dry voice
      const n = take.ch[0].length
      let diff = 0
      for (let i = 0; i < n; i++) diff += (out.ch[0][i] - take.ch[0][i]) ** 2
      assert.ok(10 * Math.log10(diff / n + 1e-20) > rmsDb(take) - 20, mod.id + ' is audible on speech')
    }
  })

  test('speed per second of 48 kHz mono speech', () => {
    const sr = 48000
    const v = synthVoice(sr, 10, { seed: 21 })
    const bound = { 1: 60, 2: 90, 3: 250 }
    const report = []
    for (const mod of ALL) {
      const ms = timeIt(() => run(mod, { sr, ch: [new Float32Array(v.ch[0])] }), 2) / 10
      report.push(mod.id + ' ' + ms.toFixed(1) + ' ms/s')
      assert.ok(ms < bound[mod.cost], mod.id + ' takes ' + ms.toFixed(1) + ' ms per second (cost ' + mod.cost + ')')
    }
    // live: 10 ms blocks of 480 samples, per second of audio
    for (const mod of LIVE) {
      const k = mod.live.create(sr, resolveParams(mod, {}), makeRng(1))
      const L = new Float32Array(480)
      const R = new Float32Array(480)
      const ms = timeIt(() => {
        for (let s = 0; s + 480 <= v.ch[0].length; s += 480) k.process([v.ch[0].subarray(s, s + 480)], [L, R], 480)
      }, 1) / 10
      report.push(mod.id + ' live ' + ms.toFixed(1) + ' ms/s')
      assert.ok(ms < 100, mod.id + ' live takes ' + ms.toFixed(1) + ' ms per second')
    }
    // print once so the report can quote the numbers
    console.log('echo speeds: ' + report.join(', '))
  })
})
