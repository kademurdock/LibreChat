// test/device.nodetest.mjs - the device family (modules/device/*.js).
//
// 1. Shape: every module passes core/params.js validateModuleShape, sits in
//    the file its id names, and the eighteen devices the brief lists have a
//    live version.
// 2. Robustness: empty input, silence, a single click, stereo in, every
//    choice, every number at its min and its max, and the rates 8, 22.05,
//    44.1 and 96 kHz: always finite, peak under 8, length = input + tail
//    (except the gramophone off its right speed, which warps time);
//    the same seed gives the same output.
// 3. Speed at 48 kHz on 10 s of synthetic speech (generous bounds; the
//    numbers are reported as test diagnostics).
// 4. Live: blocks of 128, 480 and 1500 samples, outputs aliasing inputs,
//    every setting changed while running, and the declared latency lines a
//    live render up with the offline one.
// 5. Prove it: each device does what its name says, measured with the
//    independent rulers of test/measure.mjs plus a Goertzel tone detector and
//    a zero-crossing frequency tracker written here.
// 6. Real speech (when the listening files are on this machine): every device
//    at its defaults stays sane, near its input level and not much peakier
//    than its input (crest factor up by under 6.5 dB).
//
// Run: node --test engine/test/device.nodetest.mjs (Node 24)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { synthVoice, sine, silence } from './fixtures.mjs'
import { assertSane, bandEnergyDb, medianF0, rmsDb, timeIt, stereoCorrelation } from './measure.mjs'
import { validateModuleShape, resolveParams } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'
import { findPhrases } from '../core/segment.js'

const DIR = fileURLToPath(new URL('../modules/device/', import.meta.url))
const NAMES = [
  'phone', 'walkie', 'cb', 'radio', 'shortwave', 'scanner', 'spaceradio', 'intercom', 'megaphone', 'pa',
  'gramophone', 'cylinder', 'vinyl', 'cassette', 'microcassette', 'vhs', 'tincan', 'babymonitor', 'toy', 'tv',
]
const LIVE = NAMES.filter((n) => n !== 'spaceradio' && n !== 'pa')
const MODS = {}
for (const n of NAMES) MODS[n] = (await import('../modules/device/' + n + '.js')).default

const SR = 48000
const VOICE = synthVoice(SR, 3, { seed: 11 }).ch[0]

function run(name, p = {}, input = VOICE, sr = SR, seed = 'test') {
  const m = MODS[name]
  const src = { sr, ch: [new Float32Array(input)] }
  return m.process(src, resolveParams(m, p), { rng: makeRng(seed) })
}

/**
 * True when the output should line up with the input (length = input +
 * tail). Only the gramophone warps time, and only off its right speed.
 */
function keepsTime(m, p) {
  return !m.warps || (m.id === 'device.gramophone' && p.speed === '78')
}

/** Peak over RMS in dB. */
function crestDb(x) {
  let pk = 0
  let e = 0
  for (let i = 0; i < x.length; i++) {
    const a = x[i] < 0 ? -x[i] : x[i]
    if (a > pk) pk = a
    e += x[i] * x[i]
  }
  return 20 * Math.log10(pk / Math.sqrt(e / Math.max(1, x.length) + 1e-30) + 1e-30)
}

/** Speech, a long pause, speech: two transmissions. */
function twoBursts(sr = SR) {
  const a = synthVoice(sr, 1.2, { seed: 21 }).ch[0]
  const b = synthVoice(sr, 1.2, { seed: 22 }).ch[0]
  const gap = Math.round(2.2 * sr)
  const x = new Float32Array(a.length + gap + b.length + Math.round(0.6 * sr))
  x.set(a, 0)
  x.set(b, a.length + gap)
  return { x, aEnd: a.length / sr, bStart: (a.length + gap) / sr }
}

function seg(x, sr, t0, t1) {
  const a = Math.max(0, Math.round(t0 * sr))
  const b = Math.min(x.length, Math.round(t1 * sr))
  return x.slice(a, Math.max(a, b))
}

function msDb(x) {
  let e = 0
  for (let i = 0; i < x.length; i++) e += x[i] * x[i]
  return x.length ? 10 * Math.log10(e / x.length + 1e-30) : -300
}

/** Goertzel power of one frequency over a stretch, in dB (relative). */
function toneDb(x, sr, hz) {
  const w = (2 * Math.PI * hz) / sr
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / x.length)) + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2
  return 10 * Math.log10(p / (x.length * x.length) + 1e-30)
}

/** Frequency of a sine-like signal per cycle (upward zero crossings), then its modulation spectrum peak. */
function modulationRate(x, sr, lo = 0.2, hi = 20) {
  const t = []
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) t.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]))
  }
  const f = []
  const tt = []
  for (let k = 1; k < t.length; k++) {
    f.push(sr / (t[k] - t[k - 1]))
    tt.push((t[k] + t[k - 1]) / 2 / sr)
  }
  const mean = f.reduce((a, b) => a + b, 0) / f.length
  let best = 0
  let bestHz = 0
  for (let hz = lo; hz <= hi; hz += 0.05) {
    let re = 0
    let im = 0
    for (let k = 0; k < f.length; k++) {
      re += (f[k] - mean) * Math.cos(2 * Math.PI * hz * tt[k])
      im += (f[k] - mean) * Math.sin(2 * Math.PI * hz * tt[k])
    }
    const m = re * re + im * im
    if (m > best) {
      best = m
      bestHz = hz
    }
  }
  let dev = 0
  for (const v of f) dev = Math.max(dev, Math.abs(v - mean))
  return { hz: bestHz, mean, dev }
}

/** Correlation of a and b with b shifted by lag samples. */
function corrAt(a, b, lag, from, to) {
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = from; i < to; i++) {
    const x = a[i]
    const y = b[i + lag]
    sab += x * y
    saa += x * x
    sbb += y * y
  }
  return sab / Math.sqrt(saa * sbb + 1e-30)
}

// ---------------------------------------------------------------- 1. shape

describe('device: shape', () => {
  test('every module file is one of the twenty and passes the contract shape check', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.js') && !f.startsWith('_')).map((f) => f.slice(0, -3)).sort()
    assert.deepEqual(files, NAMES.slice().sort())
    for (const n of NAMES) {
      const m = MODS[n]
      assert.deepEqual(validateModuleShape(m), [], n)
      assert.equal(m.id, 'device.' + n)
      assert.equal(m.family, 'device')
      assert.ok(['keep', 'make'].includes(m.stereo))
      // only the gramophone warps time (its turntable speed choice)
      assert.equal(m.warps, n === 'gramophone', n + ' warps')
    }
  })

  test('names are unique and short, abouts are one sentence', () => {
    const names = new Set()
    for (const n of NAMES) {
      const m = MODS[n]
      assert.ok(!names.has(m.name), 'duplicate name ' + m.name)
      names.add(m.name)
      assert.ok(m.name.split(' ').length <= 5, m.name)
      assert.ok(m.about.length <= 160, n + ' about is ' + m.about.length + ' characters')
      assert.ok(/\.$/.test(m.about), n + ' about should end with a full stop')
      assert.ok(m.params.length >= 4 && m.params.length <= 8, n + ' has ' + m.params.length + ' params')
    }
  })

  test('the eighteen listed devices have live versions with sane latency', () => {
    for (const n of LIVE) {
      const m = MODS[n]
      assert.ok(m.live, n + ' has no live')
      const p = resolveParams(m, {})
      const l = m.live.latency(p, 48000)
      assert.ok(Number.isInteger(l) && l >= 0 && l <= 0.03 * 48000, n + ' latency ' + l)
    }
  })

  test('the shared kit is not a module', async () => {
    const kit = await import('../modules/device/_kit.js')
    assert.equal(kit.default, undefined)
  })

  test('source rules: comment header, imports only from core or the family, no host globals', () => {
    const rules = [
      [/(?<![.\w$])(window|document|navigator|localStorage|sessionStorage|process|Buffer)\s*\./, 'a browser or Node global'],
      [/(?<![.\w$])(require|fetch|setTimeout|setInterval|requestAnimationFrame|importScripts|eval)\s*\(/, 'a host function'],
      [/\bMath\.random\b/, 'Math.random'],
      [/\bperformance\s*\.\s*now\b|\bDate\.now\b/, 'wall-clock time'],
      [/\.(findLast|findLastIndex|toSorted|toReversed|toSpliced)\s*\(/, 'an ES2023 method'],
    ]
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(DIR + f, 'utf8')
      assert.ok(/^\s*\/\//.test(src), f + ' has no comment header')
      for (const m of src.matchAll(/^\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
        assert.ok(m[1].startsWith('../../core/') || /^\.\/[a-z_]+\.js$/.test(m[1]), f + ' imports ' + m[1])
      }
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const [re, what] of rules) assert.ok(!re.test(code), f + ' uses ' + what)
    }
  })
})

// ---------------------------------------------------------------- 2. robustness

describe('device: robustness', () => {
  for (const n of NAMES) {
    test(n + ': empty, silence, click, stereo, every setting, every rate', () => {
      const m = MODS[n]
      const def = resolveParams(m, {})
      const empty = m.process({ sr: SR, ch: [new Float32Array(0)] }, def, { rng: makeRng(1) })
      assert.equal(empty.ch[0].length, 0)
      const tailN = (p, sr) => Math.round((m.tail ? m.tail(p, sr) : 0) * sr)
      const quiet = m.process(silence(SR, 1), def, { rng: makeRng(1) })
      assertSane(quiet)
      assert.equal(quiet.ch[0].length, SR + tailN(def, SR))
      const click = new Float32Array(SR)
      click[200] = 1
      assertSane(m.process({ sr: SR, ch: [click] }, def, { rng: makeRng(1) }))
      const st = m.process({ sr: SR, ch: [new Float32Array(VOICE), new Float32Array(VOICE)] }, def, { rng: makeRng(1) })
      assertSane(st)
      assert.equal(st.ch.length, 2)
      // every choice, every switch, every number at both ends
      const variants = []
      const lo = {}
      const hi = {}
      for (const p of m.params) {
        if (p.type === 'choice') for (const o of p.options) variants.push({ [p.id]: o.v })
        else if (p.type === 'bool') variants.push({ [p.id]: !p.def })
        else {
          lo[p.id] = p.min
          hi[p.id] = p.max
        }
      }
      variants.push(lo, hi)
      const short = VOICE.subarray(0, SR * 1.5)
      for (const v of variants) {
        const p = resolveParams(m, v)
        const out = m.process({ sr: SR, ch: [new Float32Array(short)] }, p, { rng: makeRng(2) })
        assertSane(out)
        if (keepsTime(m, p)) assert.equal(out.ch[0].length, short.length + tailN(p, SR), n + ' ' + JSON.stringify(v))
        else assert.ok(out.ch[0].length > 0.5 * short.length && out.ch[0].length < 2 * short.length, n + ' ' + JSON.stringify(v))
      }
      for (const sr of [8000, 22050, 44100, 96000]) {
        const v = synthVoice(sr, 0.8, { seed: 5 }).ch[0]
        const out = m.process({ sr, ch: [v] }, def, { rng: makeRng(3) })
        assertSane(out)
        assert.equal(out.sr, sr)
        assert.equal(out.ch[0].length, v.length + tailN(def, sr))
      }
    })

    test(n + ': deterministic for a seed', () => {
      const a = run(n, {}, VOICE.subarray(0, SR), SR, 'same')
      const b = run(n, {}, VOICE.subarray(0, SR), SR, 'same')
      assert.deepEqual(a.ch[0], b.ch[0])
    })
  }
})

// ---------------------------------------------------------------- 3. speed

describe('device: speed at 48 kHz (generous bounds)', () => {
  const ten = synthVoice(SR, 10, { seed: 9 }).ch[0]
  for (const n of NAMES) {
    test(n, (t) => {
      const m = MODS[n]
      const p = resolveParams(m, {})
      const ms = timeIt(() => m.process({ sr: SR, ch: [new Float32Array(ten)] }, p, { rng: makeRng(4) }), 2)
      const perSec = ms / 10
      t.diagnostic(n + ': ' + perSec.toFixed(1) + ' ms per second of audio (cost ' + m.cost + ')')
      const bound = m.cost <= 2 ? 80 : m.cost === 3 ? 150 : 600
      assert.ok(perSec < bound, n + ' took ' + perSec.toFixed(1) + ' ms per second')
    })
  }
})

// ---------------------------------------------------------------- 4. live

function liveRun(m, p, x, block, aliased, seed = 'live') {
  const inst = m.live.create(SR, resolveParams(m, p), makeRng(seed))
  const out = new Float32Array(x.length)
  const buf = new Float32Array(block)
  for (let o = 0; o < x.length; o += block) {
    const k = Math.min(block, x.length - o)
    if (aliased) {
      const v = buf.subarray(0, k)
      v.set(x.subarray(o, o + k))
      inst.process([v], [v], k)
      out.set(v, o)
    } else inst.process([x.subarray(o, o + k)], [out.subarray(o, o + k)], k)
  }
  return { out, inst }
}

describe('device: live', () => {
  for (const n of NAMES.filter((x) => MODS[x].live)) {
    test(n + ': runs in any block size, survives every setting change', () => {
      const m = MODS[n]
      for (const [block, aliased] of [[128, false], [480, true], [1500, false]]) {
        const { out } = liveRun(m, {}, VOICE, block, aliased)
        assertSane({ sr: SR, ch: [out] })
        assert.ok(rmsDb(out) > -60, n + ' live output is silent with block ' + block)
      }
      const { inst } = liveRun(m, {}, VOICE.subarray(0, SR), 128, false)
      const o = new Float32Array(480)
      const changes = [{}]
      for (const p of m.params) {
        if (p.type === 'choice') for (const op of p.options) changes.push({ [p.id]: op.v })
        else if (p.type === 'bool') changes.push({ [p.id]: !p.def })
        else changes.push({ [p.id]: p.max }, { [p.id]: p.min })
      }
      let pos = 0
      for (const c of changes) {
        inst.set(resolveParams(m, c))
        for (let k = 0; k < 3; k++) {
          inst.process([VOICE.subarray(pos, pos + 480)], [o], 480)
          assertSane({ sr: SR, ch: [o] })
          pos = (pos + 480) % (VOICE.length - 480)
        }
      }
      inst.reset()
      inst.process([VOICE.subarray(0, 480)], [o], 480)
      assertSane({ sr: SR, ch: [o] })
    })
  }

  test('declared latency lines live up with offline (quiet tape, quiet phone, quiet toy)', () => {
    const cases = [
      ['cassette', { hiss: 0, wow: 0, flutter: 0, dropouts: 0, chewed: 0 }],
      ['phone', { era: 'rotary', noise: 0, hum: 0, crackle: 0, signal: 100 }],
      ['toy', { chip: 'sample', rattle: 0 }],
      ['vhs', { hiss: 0, wobble: 0, hum: 0, tracking: 0 }],
    ]
    for (const [n, p] of cases) {
      const m = MODS[n]
      const off = run(n, p, VOICE, SR, 'same').ch[0]
      const { out } = liveRun(m, p, VOICE, 480, false, 'same')
      const L = m.live.latency(resolveParams(m, p), SR)
      const c0 = corrAt(off, out, L, SR, VOICE.length - L - 1)
      assert.ok(c0 > 0.9, n + ' live vs offline correlation at the declared latency is ' + c0.toFixed(3))
    }
  })
})

// ---------------------------------------------------------------- 5. prove it

describe('device: prove it', () => {
  test('phone: the eras differ clearly in band and character', () => {
    const eras = ['candlestick', 'rotary', 'cordless', 'cellular', 'flip', 'voip', 'speaker']
    const bands = [[100, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 3200], [3600, 7000]]
    const prof = {}
    for (const e of eras) {
      const y = run('phone', { era: e }).ch[0]
      const lv = bands.map(([a, b]) => bandEnergyDb(y, SR, a, b))
      const mx = Math.max(...lv)
      prof[e] = lv.map((v) => v - mx)
    }
    // rotary: the 300-3400 Hz phone band
    assert.ok(prof.rotary[5] < -25, 'rotary leaks above 3.6 kHz: ' + prof.rotary[5].toFixed(1))
    // the 8 kHz digital phones: nothing above 3.6 kHz
    assert.ok(prof.cellular[5] < -40 && prof.flip[5] < -40, 'digital phones leak above 3.6 kHz')
    // internet call: wideband
    assert.ok(prof.voip[5] > prof.rotary[5] + 12, 'internet call is not wider than the landline')
    // candlestick: narrower at the bottom than rotary
    assert.ok(prof.candlestick[1] < prof.rotary[1] - 6, 'candlestick is not thinner than rotary')
    // every pair differs by at least 3 dB somewhere
    for (let i = 0; i < eras.length; i++) {
      for (let j = i + 1; j < eras.length; j++) {
        const d = Math.max(...prof[eras[i]].map((v, k) => Math.abs(v - prof[eras[j]][k])))
        if (d < 3) {
          // close in spectrum: they must differ in noise or level behaviour instead
          const a = run('phone', { era: eras[i] }).ch[0]
          const b = run('phone', { era: eras[j] }).ch[0]
          assert.ok(Math.abs(corrAt(a, b, 0, 0, a.length)) < 0.9, eras[i] + ' and ' + eras[j] + ' sound alike')
        }
      }
    }
  })

  test('phone: the carbon candlestick distorts a tone far more than the rotary phone', () => {
    const tone = sine(SR, 1, 700, 0.3).ch[0]
    const q = { noise: 0, hum: 0, crackle: 0, signal: 100, rough: 60 }
    const harm = (era) => {
      const y = seg(run('phone', { ...q, era }, tone).ch[0], SR, 0.3, 0.9)
      const h = Math.pow(10, toneDb(y, SR, 1400) / 10) + Math.pow(10, toneDb(y, SR, 2100) / 10) + Math.pow(10, toneDb(y, SR, 2800) / 10)
      return 10 * Math.log10(h) - toneDb(y, SR, 700)
    }
    assert.ok(harm('candlestick') > harm('rotary') + 6, 'candlestick ' + harm('candlestick').toFixed(1) + ' rotary ' + harm('rotary').toFixed(1))
  })

  test('walkie: squelch tail at the end of a transmission, silence between, roger beep', () => {
    const { x, aEnd, bStart } = twoBursts()
    const y = run('walkie', { squelch: 100, beep: 'none' }, x).ch[0]
    const tail = msDb(seg(y, SR, aEnd, aEnd + 0.4))
    const between = msDb(seg(y, SR, aEnd + 0.9, bStart - 0.3))
    const speech = msDb(seg(y, SR, 0.2, aEnd - 0.1))
    assert.ok(tail > between + 25, 'tail ' + tail.toFixed(1) + ' between ' + between.toFixed(1))
    assert.ok(tail > speech - 12, 'tail is too weak: ' + (tail - speech).toFixed(1))
    const y2 = run('walkie', { squelch: 0, beep: 'two' }, x).ch[0]
    const w = seg(y2, SR, aEnd, aEnd + 0.45)
    assert.ok(toneDb(w, SR, 1800) > toneDb(w, SR, 600) + 10, 'no roger beep')
    // live: the gate closes the transmission and the tail comes after the hold
    const { out } = liveRun(MODS.walkie, { squelch: 100 }, x, 480, false)
    const lt = msDb(seg(out, SR, aEnd, aEnd + 1.0))
    const lb = msDb(seg(out, SR, aEnd + 1.3, bStart - 0.2))
    assert.ok(lt > lb + 20, 'live squelch tail missing: ' + lt.toFixed(1) + ' vs ' + lb.toFixed(1))
  })

  test('cb: open squelch keeps static between transmissions; a tight one shuts it; the whistle is a tone', () => {
    const { x, aEnd, bStart } = twoBursts()
    const open = msDb(seg(run('cb', { squelch: 0, static: 60 }, x).ch[0], SR, aEnd + 0.8, bStart - 0.2))
    const shut = msDb(seg(run('cb', { squelch: 100, static: 60 }, x).ch[0], SR, aEnd + 0.8, bStart - 0.2))
    assert.ok(open > shut + 15, 'open ' + open.toFixed(1) + ' shut ' + shut.toFixed(1))
    const y = run('cb', { whistle: 100, static: 0, skip: 0, squelch: 0 }, silence(SR, 2).ch[0]).ch[0]
    const s = seg(y, SR, 0.5, 1.5)
    let best = -300
    for (let hz = 650; hz <= 1850; hz += 5) best = Math.max(best, toneDb(s, SR, hz))
    assert.ok(best > toneDb(s, SR, 2600) + 20, 'no heterodyne whistle')
  })

  test('radio: between stations the voice sinks under the noise; the pocket set is thinner than the cabinet', () => {
    const on = run('radio', { tuning: 'on' }).ch[0]
    const btw = run('radio', { tuning: 'between' }).ch[0]
    const ph = findPhrases(VOICE, SR)
    const gapAt = ph.length > 1 ? (ph[0].end + ph[1].start) / 2 / SR : 2.9
    const snr = (y) => msDb(seg(y, SR, ph[0].start / SR, ph[0].end / SR)) - msDb(seg(y, SR, gapAt - 0.05, gapAt + 0.05))
    assert.ok(snr(on) > snr(btw) + 10, 'on ' + snr(on).toFixed(1) + ' between ' + snr(btw).toFixed(1))
    const cab = run('radio', { era: '1930s', static: 0, hum: 0 }).ch[0]
    const pocket = run('radio', { era: '1960s', static: 0, hum: 0 }).ch[0]
    const low = (y) => bandEnergyDb(y, SR, 100, 300) - bandEnergyDb(y, SR, 1000, 2000)
    assert.ok(low(pocket) < low(cab) - 12, 'pocket ' + low(pocket).toFixed(1) + ' cabinet ' + low(cab).toFixed(1))
  })

  test('shortwave: a mistuned sideband moves every frequency by the detune', () => {
    const tone = sine(SR, 1.5, 1000, 0.3).ch[0]
    const y = seg(run('shortwave', { detune: 200, fading: 0, noise: 0, warble: 0 }, tone).ch[0], SR, 0.4, 1.4)
    assert.ok(toneDb(y, SR, 1200) > toneDb(y, SR, 1000) + 20, 'tone did not move to 1200 Hz')
    const y2 = seg(run('shortwave', { detune: -150, fading: 0, noise: 0, warble: 0 }, tone).ch[0], SR, 0.4, 1.4)
    assert.ok(toneDb(y2, SR, 850) > toneDb(y2, SR, 1000) + 20, 'tone did not move to 850 Hz')
  })

  test('scanner: analog tails after transmissions; digital is silent between and band-limited', () => {
    const { x, aEnd, bStart } = twoBursts()
    const a = run('scanner', { mode: 'analog', tail: 100, chirps: false }, x).ch[0]
    assert.ok(msDb(seg(a, SR, aEnd, aEnd + 0.25)) > msDb(seg(a, SR, aEnd + 0.8, bStart - 0.4)) + 25, 'no squelch tail')
    const d = run('scanner', { mode: 'digital', chirps: false }, x).ch[0]
    assert.ok(msDb(seg(d, SR, aEnd + 0.8, bStart - 0.4)) < -90, 'digital scanner hisses between calls')
    assert.ok(bandEnergyDb(d, SR, 4000, 12000) < bandEnergyDb(d, SR, 500, 2500) - 35, 'digital scanner is not band-limited')
    const c = run('scanner', { chirps: true }, x).ch[0]
    const w = seg(c, SR, bStart - 0.25, bStart)
    assert.ok(toneDb(w, SR, 1200) > toneDb(w, SR, 3000) + 10 || toneDb(w, SR, 1800) > toneDb(w, SR, 3000) + 10, 'no data chirp')
  })

  test('space radio: 2525 Hz before each transmission, 2475 Hz after it', () => {
    const { x, aEnd, bStart } = twoBursts()
    const y = run('spaceradio', { hiss: 10, dropouts: 0 }, x).ch[0]
    const ph = findPhrases(x, SR, { minSilenceMs: 500 })
    const second = ph.find((p) => p.start / SR > aEnd + 1)
    const s0 = second.start / SR
    const intro = seg(y, SR, s0 - 0.3, s0)
    assert.ok(toneDb(intro, SR, 2525) > toneDb(intro, SR, 2475) + 3 && toneDb(intro, SR, 2525) > toneDb(intro, SR, 1000) + 10, 'no 2525 Hz intro tone')
    const first = ph[ph.length > 1 && ph[1].start / SR < aEnd ? 1 : 0]
    const e0 = ph.filter((p) => p.end / SR <= aEnd + 0.2).pop().end / SR
    const outro = seg(y, SR, e0, e0 + 0.3)
    assert.ok(toneDb(outro, SR, 2475) > toneDb(outro, SR, 2525) + 3 && toneDb(outro, SR, 2475) > toneDb(outro, SR, 1000) + 10, 'no 2475 Hz outro tone')
    assert.ok(first)
    const none = run('spaceradio', { beeps: 'none', hiss: 10, dropouts: 0 }, x).ch[0]
    const intro2 = seg(none, SR, s0 - 0.3, s0)
    assert.ok(toneDb(intro2, SR, 2525) < toneDb(intro, SR, 2525) - 20, 'beeps did not switch off')
  })

  test('intercom: a narrow box with buzz while the line is open', () => {
    const y = run('intercom', { style: 'door', buzz: 100, noise: 0 }).ch[0]
    assert.ok(bandEnergyDb(y, SR, 80, 300) < bandEnergyDb(y, SR, 800, 2500) - 15, 'door box is not narrow')
    const { x, aEnd } = twoBursts()
    const z = run('intercom', { style: 'door', buzz: 100, noise: 0, clicks: false }, x).ch[0]
    const inPause = seg(z, SR, aEnd - 0.05, aEnd + 0.05)
    const closed = seg(z, SR, aEnd + 1.0, aEnd + 1.8)
    assert.ok(toneDb(inPause, SR, 360) > toneDb(closed, SR, 360) + 20, 'no buzz on the open line')
  })

  test('megaphone: horn band, the siren before the first words, the squeal builds', () => {
    const y = run('megaphone', { outdoors: 0 }).ch[0]
    assert.ok(bandEnergyDb(y, SR, 60, 300) < bandEnergyDb(y, SR, 1000, 2500) - 18, 'megaphone keeps its lows')
    const { x, aEnd, bStart } = twoBursts()
    const lead = new Float32Array(x.length + 1.5 * SR)
    lead.set(x, 1.5 * SR)
    const s = run('megaphone', { siren: 'start', outdoors: 0 }, lead).ch[0]
    const quiet = run('megaphone', { siren: 'off', outdoors: 0 }, lead).ch[0]
    assert.ok(msDb(seg(s, SR, 0.1, 1.35)) > msDb(seg(quiet, SR, 0.1, 1.35)) + 20, 'no siren before talking')
    // no room before the first words: the whoop waits for the long pause instead
    const s2 = run('megaphone', { siren: 'start', outdoors: 0 }, x).ch[0]
    const q2 = run('megaphone', { siren: 'off', outdoors: 0 }, x).ch[0]
    assert.ok(msDb(seg(s2, SR, aEnd + 0.3, bStart - 0.1)) > msDb(seg(q2, SR, aEnd + 0.3, bStart - 0.1)) + 20, 'siren did not wait for the pause')
    assert.ok(Math.abs(msDb(seg(s2, SR, 0.1, aEnd - 0.1)) - msDb(seg(q2, SR, 0.1, aEnd - 0.1))) < 1, 'siren covered the first words')
    const peaky = (p) => {
      const z = run('megaphone', { outdoors: 0, ...p }).ch[0]
      let best = -300
      for (let hz = 2150; hz <= 3250; hz += 10) best = Math.max(best, toneDb(z, SR, hz))
      return best - bandEnergyDb(z, SR, 1000, 2000)
    }
    assert.ok(peaky({ squeal: 100 }) > peaky({ squeal: 0 }) + 10, 'no feedback squeal')
  })

  test('pa: stereo, with the venue ringing on after the voice', () => {
    const y = run('pa', { venue: 'stadium' })
    assert.equal(y.ch.length, 2)
    assert.ok(stereoCorrelation(y) < 0.97, 'pa is not spacious')
    const n = VOICE.length
    const tail = msDb(y.ch[0].slice(n + Math.round(0.1 * SR), n + Math.round(0.6 * SR)))
    const body = msDb(y.ch[0].slice(0, n))
    assert.ok(tail > body - 40, 'no venue tail')
    const c = run('pa', { venue: 'airport', chime: 'two' }, (() => {
      const z = new Float32Array(VOICE.length + 2 * SR)
      z.set(VOICE, 2 * SR)
      return z
    })()).ch[0]
    const ch = seg(c, SR, 0, 1.6)
    assert.ok(toneDb(ch, SR, 659.3) > toneDb(ch, SR, 900) + 15, 'no chime')
  })

  test('gramophone: horn band and the once-a-turn wow at 78 turns a minute', () => {
    const tone = sine(SR, 6, 1000, 0.3).ch[0]
    const y = run('gramophone', { surface: 0, crackle: 0, wear: 0, wow: 80 }, tone).ch[0]
    const m = modulationRate(seg(y, SR, 0.5, 5.5), SR, 0.5, 4)
    assert.ok(Math.abs(m.hz - 1.3) < 0.25, 'wow at ' + m.hz.toFixed(2) + ' Hz')
    const v = run('gramophone').ch[0]
    assert.ok(bandEnergyDb(v, SR, 7000, 16000) < bandEnergyDb(v, SR, 800, 2000) - 30, 'gramophone is too wide')
  })

  test('gramophone: the turntable speed moves pitch and timing together; the spring runs down at the end', () => {
    const tone = sine(SR, 4, 1000, 0.3).ch[0]
    const q = { surface: 0, crackle: 0, wear: 0, wow: 0 }
    const zcHz = (x, a, b) => {
      let c = 0
      let first = -1
      let last = -1
      for (let i = Math.max(1, Math.round(a * SR)); i < Math.round(b * SR); i++) {
        if (x[i - 1] < 0 && x[i] >= 0) {
          c++
          if (first < 0) first = i
          last = i
        }
      }
      return ((c - 1) * SR) / (last - first)
    }
    const at78 = run('gramophone', { ...q, speed: '78' }, tone).ch[0]
    assert.equal(at78.length, tone.length)
    assert.ok(Math.abs(zcHz(at78, 0.5, 3.5) - 1000) < 2, '78 moved the pitch')
    for (const [speed, rpm] of [['70', 70], ['80', 80], ['90', 90]]) {
      const y = run('gramophone', { ...q, speed }, tone).ch[0]
      const want = (tone.length * 78) / rpm
      assert.ok(Math.abs(y.length - want) < 0.01 * SR, speed + ': length ' + (y.length / SR).toFixed(3) + ' s')
      const hz = zcHz(y, 0.3, y.length / SR - 0.3)
      assert.ok(Math.abs(hz - (1000 * rpm) / 78) < 3, speed + ': tone at ' + hz.toFixed(1) + ' Hz')
    }
    // the once-a-turn wobble follows the turntable: 90 turns a minute is 1.5 Hz
    const w90 = run('gramophone', { ...q, wow: 80, speed: '90' }, sine(SR, 6, 1000, 0.3).ch[0]).ch[0]
    const m = modulationRate(seg(w90, SR, 0.5, w90.length / SR - 0.5), SR, 0.5, 4)
    assert.ok(Math.abs(m.hz - 1.5) < 0.2, 'wow at ' + m.hz.toFixed(2) + ' Hz at 90')
    // running down: full speed at first, then the end sags (longer, lower)
    const rd = run('gramophone', { ...q, speed: 'rundown' }, tone).ch[0]
    assert.ok(rd.length > tone.length + 0.1 * SR, 'running down did not lengthen the take')
    assert.ok(Math.abs(zcHz(rd, 0.3, 1.8) - 1000) < 3, 'running down changed the start')
    const endHz = zcHz(rd, rd.length / SR - 0.4, rd.length / SR - 0.1)
    assert.ok(12 * Math.log2(1000 / endHz) > 4, 'the end only sagged to ' + endHz.toFixed(0) + ' Hz')
    // and the live version keeps going at any speed setting (it cannot change timing)
    const inst = MODS.gramophone.live.create(SR, resolveParams(MODS.gramophone, { speed: 'rundown' }), makeRng(1))
    const o = new Float32Array(480)
    inst.process([tone.subarray(0, 480)], [o], 480)
    assertSane({ sr: SR, ch: [o] })
  })

  test('cylinder: narrower than the gramophone, with hiss over silence', () => {
    const c = run('cylinder', { hiss: 0, groove: 0, wear: 0 }).ch[0]
    const g = run('gramophone', { surface: 0, crackle: 0, wear: 0 }).ch[0]
    const lowc = bandEnergyDb(c, SR, 100, 300) - bandEnergyDb(c, SR, 1000, 2000)
    const lowg = bandEnergyDb(g, SR, 100, 300) - bandEnergyDb(g, SR, 1000, 2000)
    assert.ok(lowc < lowg - 6, 'cylinder ' + lowc.toFixed(1) + ' gramophone ' + lowg.toFixed(1))
    const h = run('cylinder', {}, silence(SR, 1.5).ch[0]).ch[0]
    assert.ok(rmsDb(h) > -55, 'no cylinder hiss: ' + rmsDb(h).toFixed(1))
  })

  test('vinyl: spiky crackle over silence, wow at the turning rate (33 or 45)', () => {
    const y = run('vinyl', { pops: 0, rumble: 0, crackle: 70 }, silence(SR, 3).ch[0]).ch[0]
    let m2 = 0
    let m4 = 0
    for (const v of y) {
      m2 += v * v
      m4 += v * v * v * v
    }
    const kurt = (m4 / y.length) / Math.pow(m2 / y.length, 2)
    assert.ok(kurt > 20, 'crackle is not spiky: kurtosis ' + kurt.toFixed(1))
    const tone = sine(SR, 8, 1000, 0.3).ch[0]
    const q = { crackle: 0, pops: 0, rumble: 0, wear: 0, warp: 60 }
    const r33 = modulationRate(seg(run('vinyl', { ...q, speed: '33' }, tone).ch[0], SR, 0.5, 7.5), SR, 0.3, 2)
    const r45 = modulationRate(seg(run('vinyl', { ...q, speed: '45' }, tone).ch[0], SR, 0.5, 7.5), SR, 0.3, 2)
    assert.ok(Math.abs(r33.hz - 0.555) < 0.12, '33: ' + r33.hz.toFixed(2))
    assert.ok(Math.abs(r45.hz - 0.75) < 0.12, '45: ' + r45.hz.toFixed(2))
  })

  test('cassette: hiss follows its setting, worn tape is duller than chrome, flutter is fast wobble', () => {
    const h0 = rmsDb(run('cassette', { hiss: 10 }, silence(SR, 1).ch[0]).ch[0])
    const h1 = rmsDb(run('cassette', { hiss: 90 }, silence(SR, 1).ch[0]).ch[0])
    assert.ok(h1 > h0 + 15, 'hiss ' + h0.toFixed(1) + ' to ' + h1.toFixed(1))
    const top = (tape) => {
      const y = run('cassette', { tape, hiss: 0, highLoss: 0 }).ch[0]
      return bandEnergyDb(y, SR, 6000, 12000) - bandEnergyDb(y, SR, 500, 2000)
    }
    assert.ok(top('worn') < top('chrome') - 10, 'worn ' + top('worn').toFixed(1) + ' chrome ' + top('chrome').toFixed(1))
    const tone = sine(SR, 4, 1000, 0.3).ch[0]
    const m = modulationRate(seg(run('cassette', { hiss: 0, wow: 0, flutter: 100, dropouts: 0 }, tone).ch[0], SR, 0.3, 3.7), SR, 4, 20)
    assert.ok(Math.abs(m.hz - 9.5) < 1.5, 'flutter at ' + m.hz.toFixed(2) + ' Hz')
  })

  test('answering machine: the beep comes before the first words', () => {
    const z = new Float32Array(VOICE.length + 1.5 * SR)
    z.set(VOICE, 1.5 * SR)
    const ph = findPhrases(z, SR)
    const s0 = ph[0].start / SR
    const y = run('microcassette', { beep: 'start' }, z).ch[0]
    const w = seg(y, SR, s0 - 0.9, s0 - 0.2)
    assert.ok(toneDb(w, SR, 1040) > toneDb(w, SR, 600) + 15, 'no beep')
    const n = run('microcassette', { beep: 'none' }, z).ch[0]
    assert.ok(toneDb(seg(n, SR, s0 - 0.9, s0 - 0.2), SR, 1040) < toneDb(w, SR, 1040) - 20, 'beep did not switch off')
  })

  test('answering machine: the first word after a pause does not jump out (the level control looks ahead)', () => {
    // the level control lifts the room noise in a pause; without look-ahead
    // the first milliseconds of the next word came out about 8 dB too hot
    // a steady tone that stops, pauses 2.5 s and starts again abruptly
    const tone = sine(SR, 1.5, 1000, 0.2).ch[0]
    const b0 = 3.5
    const x = new Float32Array(Math.round(5.5 * SR))
    x.set(tone.subarray(0, SR), 0)
    x.set(tone, Math.round(b0 * SR))
    const q = { beep: 'none', hiss: 0, motor: 0, wobble: 0, age: 0 }
    for (const line of [true, false]) {
      const y = run('microcassette', { ...q, line }, x).ch[0]
      let onset = 0
      for (const v of seg(y, SR, b0 - 0.005, b0 + 0.03)) onset = Math.max(onset, Math.abs(v))
      let steady = 0
      for (const v of seg(y, SR, b0 + 0.3, b0 + 1.3)) steady = Math.max(steady, Math.abs(v))
      assert.ok(onset < 1.2 * steady, 'line ' + line + ': onset peak ' + onset.toFixed(3) + ' against a steady ' + steady.toFixed(3))
    }
  })

  test('video tape: slower speeds are duller; hum and buzz sit on the mains harmonics', () => {
    const top = (speed) => {
      const y = run('vhs', { speed, hiss: 0, hum: 0, tracking: 0 }).ch[0]
      return bandEnergyDb(y, SR, 6000, 12000) - bandEnergyDb(y, SR, 500, 2000)
    }
    assert.ok(top('ep') < top('sp') - 12, 'ep ' + top('ep').toFixed(1) + ' sp ' + top('sp').toFixed(1))
    const y = seg(run('vhs', { hiss: 0, hum: 100, tracking: 0 }, silence(SR, 2).ch[0]).ch[0], SR, 0.5, 1.8)
    assert.ok(toneDb(y, SR, 120) > toneDb(y, SR, 150) + 15, 'no mains hum')
  })

  test('tin-can phone: thin, ringing at the can modes, with string echoes', () => {
    const y = run('tincan', { can: 'soup' }).ch[0]
    assert.ok(bandEnergyDb(y, SR, 80, 300) < bandEnergyDb(y, SR, 1000, 3000) - 25, 'tin can keeps its lows')
    const click = new Float32Array(SR)
    click[1000] = 0.8
    const r = run('tincan', { can: 'soup', zing: 0, length: 8 }, click).ch[0]
    const ring = seg(r, SR, 0.03, 0.2)
    let peak = -300
    for (let hz = 1350; hz <= 1500; hz += 10) peak = Math.max(peak, toneDb(ring, SR, hz))
    assert.ok(peak > toneDb(ring, SR, 1150) + 6, 'no 1.4 kHz can ring')
    const e = run('tincan', { zing: 100, length: 10, ring: 0 }, click).ch[0]
    const D = (2 * 10) / 420
    assert.ok(msDb(seg(e, SR, 1000 / SR + D - 0.005, 1000 / SR + D + 0.015)) > msDb(seg(e, SR, 1000 / SR + D * 0.5 - 0.005, 1000 / SR + D * 0.5 + 0.015)) + 6, 'no string echo')
  })

  test('baby monitor: voice activation silences the pauses, the hiss pumps with the voice', () => {
    const { x, aEnd, bStart } = twoBursts()
    const v = run('babymonitor', { vox: true }, x).ch[0]
    const nv = run('babymonitor', { vox: false }, x).ch[0]
    const gap = (y) => msDb(seg(y, SR, aEnd + 0.9, bStart - 0.3))
    assert.ok(gap(v) < gap(nv) - 20, 'vox ' + gap(v).toFixed(1) + ' always on ' + gap(nv).toFixed(1))
    // hiss band (above the voice) during speech versus in the long pause, voice activation off
    const hb = (a, b) => bandEnergyDb(seg(nv, SR, a, b), SR, 2800, 3400)
    const voice = bandEnergyDb(seg(run('babymonitor', { vox: false, hiss: 0 }, x).ch[0], SR, 0.2, aEnd - 0.1), SR, 2800, 3400)
    assert.ok(hb(0.2, aEnd - 0.1) > hb(aEnd + 0.9, bStart - 0.3) + 6 || voice > hb(aEnd + 0.9, bStart - 0.3) + 6, 'no pumping')
  })

  test('talking toy: a low battery drags the pitch down; the speech chip is band-limited', () => {
    const f0 = medianF0(run('toy', { battery: 0 }).ch[0], SR)
    const f1 = medianF0(run('toy', { battery: 90 }).ch[0], SR)
    const st = 12 * Math.log2(f0 / f1)
    assert.ok(st > 2.5, 'battery sag only ' + st.toFixed(2) + ' semitones')
    const y = run('toy', { chip: 'chip', rattle: 0 }).ch[0]
    assert.ok(bandEnergyDb(y, SR, 6000, 16000) < bandEnergyDb(y, SR, 800, 2500) - 25, 'speech chip is too wide')
  })

  test('tv: the wall leaves only the low murmur', () => {
    const tilt = (wall) => {
      const y = run('tv', { wall, hum: 0, whine: 0 }).ch[0]
      return bandEnergyDb(y, SR, 1500, 4000) - bandEnergyDb(y, SR, 150, 400)
    }
    assert.ok(tilt('wall') < tilt('closed') - 8, 'wall vs closed door')
    assert.ok(tilt('closed') < tilt('same') - 15, 'closed door vs same room')
  })
})

// ---------------------------------------------------------------- 6. real speech

const FILES = ['F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav', 'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav']

describe('device: real speech', () => {
  const takes = []
  for (const f of FILES) {
    if (!existsSync(f)) continue
    try {
      const b = decodeWav(new Uint8Array(readFileSync(f)))
      takes.push({ name: f.includes('Crisp') ? 'crisp' : 'molasses', b: { sr: b.sr, ch: [b.ch[0].slice(0, Math.min(b.ch[0].length, b.sr * 8))] } })
    } catch {
      // unreadable: skip
    }
  }
  test('every device at its defaults on real speech', { skip: takes.length ? false : 'speech files not on this machine' }, () => {
    for (const t of takes) {
      for (const n of NAMES) {
        const m = MODS[n]
        const out = m.process({ sr: t.b.sr, ch: [new Float32Array(t.b.ch[0])] }, resolveParams(m, {}), { rng: makeRng('real') })
        assertSane(out)
        const d = rmsDb(out.ch[0].subarray(0, t.b.ch[0].length)) - rmsDb(t.b.ch[0])
        assert.ok(d > -14 && d < 12, n + ' on ' + t.name + ' changed the level by ' + d.toFixed(1) + ' dB')
        // no device may make speech much peakier (an overshoot at word onsets
        // makes the final limiter pull the whole take down)
        const c = crestDb(out.ch[0].subarray(0, t.b.ch[0].length)) - crestDb(t.b.ch[0])
        assert.ok(c < 6.5, n + ' on ' + t.name + ' raised the crest factor by ' + c.toFixed(1) + ' dB')
      }
    }
  })
})
