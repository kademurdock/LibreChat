// test/lofi.nodetest.mjs - the lofi family: distortion, bit depth, codecs, broken speakers.
//
// What is proved here, module by module (MODULES_PLAN section 4, "Prove it"):
// - Every module passes the contract shape check and survives the contract's
//   torture list (no input, silence, a click, 30 s of speech, stereo, 8 kHz
//   and 96 kHz takes, every setting at its minimum, default and maximum and
//   every choice) with finite output, peaks under 8 and the declared length.
// - lofi.crush really reduces the number of distinct levels and holds
//   samples for the sample-rate period; its smoothing filters remove aliases.
// - lofi.companding matches ITU-T G.711 sample for sample at 8 kHz. The
//   reference here is written independently from the standard's decision
//   intervals (not from the module's segment search).
// - lofi.adpcm's coder is checked against an independent IMA/OKI decoder.
// - lofi.console: the delta coder moves only in steps of two inside 0..127;
//   the block coder's output is reproduced by the hardware decoder and its
//   arithmetic matches hand-worked examples; the Gaussian weights are a
//   partition of 2048 with the chip's soft top end; the hardware echo
//   repeats at its 16 ms-step delay; quality settings are ordered.
// - lofi.mp3 low-passes, smears noise before sharp sounds (pre-echo), keeps
//   a mono-compatible stereo take mono, and its quality ladder is ordered.
// - lofi.speaker band-limits per size; lofi.drive adds harmonics with drive
//   and keeps aliases down; lofi.blown cuts out with crackle and buzzes;
//   lofi.saturate has its head bump and its bias.
// - Live versions: same samples as offline (shifted by the declared
//   latency) for every block size, in-place buffers work, setting changes
//   do not click; the phone-line live path sounds like the offline one.
// - Speed per second of 48 kHz audio against generous bounds.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { validateModuleShape, resolveParams } from '../core/params.js'
import { decodeWav } from '../core/wav.js'
import { makeRng } from '../core/rng.js'
import { resampleTo } from '../core/resample.js'
import { synthVoice, impulse, silence, sine, noiseBuf } from './fixtures.mjs'
import { assertSane, rmsDb, bandEnergyDb, timeIt, cfft } from './measure.mjs'

import drive from '../modules/lofi/drive.js'
import crush from '../modules/lofi/crush.js'
import speaker from '../modules/lofi/speaker.js'
import blown from '../modules/lofi/blown.js'
import companding from '../modules/lofi/companding.js'
import adpcm from '../modules/lofi/adpcm.js'
import consoleChip from '../modules/lofi/console.js'
import mp3 from '../modules/lofi/mp3.js'
import saturate from '../modules/lofi/saturate.js'
import { adpcmCode, IMA_STEPS, OKI_STEPS, brrEncode, brrDecode, brrSample, GAUSS, dpcmCode } from '../modules/lofi/_chips.js'

const ALL = [drive, crush, speaker, blown, companding, adpcm, consoleChip, mp3, saturate]
const LIVE = [drive, crush, speaker, blown, companding, saturate]

const SPEECH = [
  'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav',
  'F:/Kade ai info/Fish talking listen (Oct 16)/06 Molasses Dusk, today.wav',
]

function loadSpeech(i) {
  try {
    if (!existsSync(SPEECH[i])) return null
    return decodeWav(new Uint8Array(readFileSync(SPEECH[i])))
  } catch {
    return null
  }
}

function ctxFor(seed = 1) {
  return { rng: makeRng(seed), progress() {}, cancelled: () => false, note() {} }
}

function run(mod, buf, p = {}, seed = 1) {
  const params = resolveParams(mod, p)
  const copy = { sr: buf.sr, ch: buf.ch.map((c) => Float32Array.from(c)) }
  return mod.process(copy, params, ctxFor(seed))
}

function expectLen(mod, p, buf) {
  const params = resolveParams(mod, p)
  const n = buf.ch[0].length
  return n + Math.round((mod.tail ? mod.tail(params, buf.sr) : 0) * buf.sr)
}

function stereoOf(a, b) {
  const n = Math.min(a.ch[0].length, b.ch[0].length)
  return { sr: a.sr, ch: [a.ch[0].slice(0, n), b.ch[0].slice(0, n)] }
}

function snrDb(ref, y) {
  let ab = 0
  let aa = 0
  const n = Math.min(ref.length, y.length)
  for (let i = 0; i < n; i++) {
    ab += ref[i] * y[i]
    aa += ref[i] * ref[i]
  }
  const g = aa > 0 ? ab / aa : 0
  let e = 0
  for (let i = 0; i < n; i++) {
    const d = y[i] - g * ref[i]
    e += d * d
  }
  return 10 * Math.log10((g * g * aa + 1e-30) / (e + 1e-30))
}

/** Settings worth trying: defaults, all at min, all at max, and every choice and switch. */
function paramSets(mod) {
  const sets = [{}]
  const lo = {}
  const hi = {}
  for (const q of mod.params) {
    if (q.type === 'number') {
      lo[q.id] = q.min
      hi[q.id] = q.max
    } else if (q.type === 'bool') {
      lo[q.id] = false
      hi[q.id] = true
    } else {
      lo[q.id] = q.options[0].v
      hi[q.id] = q.options[q.options.length - 1].v
    }
  }
  sets.push(lo, hi)
  for (const q of mod.params) {
    if (q.type === 'choice') for (const o of q.options) sets.push({ [q.id]: o.v })
    if (q.type === 'bool') sets.push({ [q.id]: !q.def })
  }
  return sets
}

// ---------------------------------------------------------------- shape

describe('lofi: contract shape', () => {
  for (const mod of ALL) {
    test(mod.id + ' passes the module shape check', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'lofi')
      assert.equal(mod.stereo, 'keep')
    })
  }
  test('the brief asks for live versions of drive, crush, speaker, blown, companding and saturate', () => {
    for (const m of LIVE) assert.ok(m.live && typeof m.live.create === 'function', m.id)
  })
})

// ---------------------------------------------------------------- robustness

describe('lofi: torture list', () => {
  const v48 = synthVoice(48000, 1.2, { seed: 2 })
  const v48b = synthVoice(48000, 1.2, { seed: 9, f0: 210 })
  const inputs = [
    ['empty mono', { sr: 48000, ch: [new Float32Array(0)] }],
    ['empty stereo', { sr: 48000, ch: [new Float32Array(0), new Float32Array(0)] }],
    ['silence', silence(48000, 0.6)],
    ['a click', impulse(48000, 0.6, 0.3, 1)],
    ['voice', v48],
    ['stereo voice', stereoOf(v48, v48b)],
    ['8 kHz voice', synthVoice(8000, 1, { seed: 4 })],
    ['96 kHz voice', synthVoice(96000, 0.4, { seed: 5 })],
  ]
  for (const mod of ALL) {
    test(mod.id + ': every input and setting gives finite, bounded output of the right length', () => {
      for (const p of paramSets(mod)) {
        for (const [name, buf] of inputs) {
          // the heavy settings only on short inputs, to keep the suite quick
          if (name === '96 kHz voice' && Object.keys(p).length > 1) continue
          let out
          try {
            out = run(mod, buf, p)
          } catch (e) {
            assert.fail(mod.id + ' threw on ' + name + ' with ' + JSON.stringify(p) + ': ' + e.message)
          }
          const where = mod.id + ' ' + name + ' ' + JSON.stringify(p)
          if (buf.ch[0].length === 0 && expectLen(mod, p, buf) === 0) {
            assert.equal(out.ch[0].length, 0, where)
            continue
          }
          assertSane(out, { maxPeak: 8 })
          assert.equal(out.ch.length, buf.ch.length, where + ' channel count')
          assert.equal(out.ch[0].length, expectLen(mod, p, buf), where + ' length')
          assert.equal(out.sr, buf.sr, where + ' rate')
        }
      }
    })
  }
  test('30 seconds of speech through every module at its defaults', () => {
    const sp = loadSpeech(0)
    const long = sp ? { sr: sp.sr, ch: [new Float32Array(sp.sr * 30)] } : synthVoice(24000, 30, { seed: 11 })
    if (sp) {
      const s = sp.ch[0]
      for (let i = 0; i < long.ch[0].length; i++) long.ch[0][i] = s[i % s.length]
    }
    for (const mod of ALL) {
      const out = run(mod, long)
      assertSane(out, { maxPeak: 8 })
      assert.equal(out.ch[0].length, expectLen(mod, {}, long), mod.id)
    }
  })
  test('the same seed gives the same sound', () => {
    for (const mod of ALL) {
      const a = run(mod, v48, {}, 7).ch[0]
      const b = run(mod, v48, {}, 7).ch[0]
      assert.deepEqual(a, b, mod.id)
    }
  })
})

// ---------------------------------------------------------------- real speech

describe('lofi: real speech files', () => {
  for (let i = 0; i < SPEECH.length; i++) {
    const sp = loadSpeech(i)
    test('defaults on ' + SPEECH[i].split('/').pop(), { skip: sp ? false : 'speech file not found' }, () => {
      const clip = { sr: sp.sr, ch: [sp.ch[0].slice(0, sp.sr * 8)] }
      for (const mod of ALL) {
        const out = run(mod, clip)
        assertSane(out, { maxPeak: 8 })
        const d = rmsDb(out) - rmsDb(clip)
        assert.ok(d > -24 && d < 18, mod.id + ' changed the level by ' + d.toFixed(1) + ' dB')
      }
    })
  }
})

// ---------------------------------------------------------------- crush

describe('lofi.crush', () => {
  test('fewer bits means fewer distinct levels', () => {
    const s = sine(48000, 0.5, 220, 0.9)
    for (const bits of [1, 2, 4, 8]) {
      const y = run(crush, s, { bits, rate: 48000 }).ch[0]
      const levels = new Set(Array.from(y))
      assert.ok(levels.size <= Math.pow(2, bits) + 1, bits + ' bits gave ' + levels.size + ' levels')
    }
    const many = new Set(Array.from(run(crush, s, { bits: 12, rate: 48000 }).ch[0])).size
    assert.ok(many > 500, 'twelve bits keeps many levels')
  })
  test('the sample rate holds each value for the sample period', () => {
    const v = synthVoice(48000, 1, { seed: 3 })
    const y = run(crush, v, { bits: 16, rate: 8000 }).ch[0]
    let runs = 0
    for (let i = 1; i < y.length; i++) if (y[i] !== y[i - 1]) runs++
    const mean = y.length / Math.max(1, runs)
    assert.ok(mean > 5 && mean < 7, 'mean hold ' + mean.toFixed(2) + ' samples (6 expected)')
  })
  test('smoothing filters keep aliases out', () => {
    const ch = sine(48000, 1, 6500, 0.5)
    const rough = run(crush, ch, { bits: 16, rate: 8000 }).ch[0]
    const smooth = run(crush, ch, { bits: 16, rate: 8000, smooth: true }).ch[0]
    // a 6.5 kHz tone sampled at 8 kHz aliases to 1.5 kHz
    const a = bandEnergyDb(rough, 48000, 1300, 1700)
    const b = bandEnergyDb(smooth, 48000, 1300, 1700)
    assert.ok(a - b > 30, 'alias only ' + (a - b).toFixed(1) + ' dB lower with smoothing')
  })
  test('mix at zero is the dry voice', () => {
    const v = synthVoice(48000, 0.5, { seed: 6 })
    const y = run(crush, v, { mix: 0 }).ch[0]
    for (let i = 0; i < y.length; i++) assert.ok(Math.abs(y[i] - v.ch[0][i]) < 1e-6)
  })
})

// ---------------------------------------------------------------- companding

// Independent G.711 reference from the standard's decision intervals.
function g711Ref(v16, isA) {
  if (!isA) {
    const neg = v16 < 0
    let m = Math.abs(Math.floor(v16 / 4))
    if (m > 8159) m = 8159
    const v = m + 33
    for (let s = 0; s < 8; s++) {
      for (let q = 0; q < 16; q++) {
        const lo = (16 + q) * 2 ** (s + 1)
        if (v >= lo && v < lo + 2 ** (s + 1)) {
          const r = 4 * ((33 + 2 * q) * 2 ** s - 33)
          return neg ? -r : r
        }
      }
    }
    // the top of the scale clips to the last level
    const r = 4 * ((33 + 30) * 2 ** 7 - 33)
    return neg ? -r : r
  }
  const neg = v16 < 0
  let m = Math.floor(v16 / 8)
  if (neg) m = -m - 1
  if (m > 4095) m = 4095
  let r
  if (m < 32) r = 16 * (m >> 1) + 8
  else if (m < 64) r = 16 * ((m >> 1) & 15) + 264
  else {
    let s = 2
    while (m >= 2 ** (s + 5)) s++
    const q = (m >> s) & 15
    r = (16 * q + 264) * 2 ** (s - 1)
  }
  return neg ? -r : r
}

describe('lofi.companding', () => {
  test('at 8 kHz it is exactly ITU-T G.711, mu-law and A-law', () => {
    const v = synthVoice(8000, 1.5, { seed: 8 })
    const x = v.ch[0]
    // add quiet and loud stretches so every segment is used
    for (let i = 0; i < 2000; i++) x[i] *= 0.01
    for (let i = 2000; i < 4000; i++) x[i] *= 1.9
    for (const law of ['mu', 'a']) {
      const y = run(companding, v, { law, band: false, rate: 8000 }).ch[0]
      let bad = 0
      for (let i = 0; i < x.length; i++) {
        let s = Math.round(x[i] * 32768)
        if (s > 32767) s = 32767
        if (s < -32768) s = -32768
        const want = g711Ref(s, law === 'a') / 32768
        if (y[i] !== Math.fround(want)) bad++
      }
      assert.equal(bad, 0, law + '-law mismatches')
    }
  })
  test('fewer bits use fewer of the 255 code levels', () => {
    const v = synthVoice(8000, 1, { seed: 9 })
    const full = new Set(Array.from(run(companding, v, { band: false }).ch[0])).size
    const four = new Set(Array.from(run(companding, v, { band: false, bits: 4 }).ch[0])).size
    assert.ok(full > 100 && full <= 255, 'eight bits used ' + full + ' levels')
    assert.ok(four <= 16, 'four bits used ' + four + ' levels')
  })
  test('the phone band filter removes lows and highs', () => {
    const nz = noiseBuf(48000, 2, 'pink', 3, 1, 0.3)
    const y = run(companding, nz).ch[0]
    const mid = bandEnergyDb(y, 48000, 800, 2000) - bandEnergyDb(nz.ch[0], 48000, 800, 2000)
    const low = bandEnergyDb(y, 48000, 50, 150) - bandEnergyDb(nz.ch[0], 48000, 50, 150)
    const high = bandEnergyDb(y, 48000, 4500, 10000) - bandEnergyDb(nz.ch[0], 48000, 4500, 10000)
    assert.ok(mid - low > 15, 'lows only ' + (mid - low).toFixed(1) + ' dB down')
    assert.ok(mid - high > 30, 'highs only ' + (mid - high).toFixed(1) + ' dB down')
  })
})

// ---------------------------------------------------------------- ADPCM

function imaDecodeRef(codes, chip) {
  const steps = chip === 'oki' ? OKI_STEPS : IMA_STEPS
  const lo = chip === 'oki' ? -2048 : -32768
  const hi = chip === 'oki' ? 2047 : 32767
  const IDX = [-1, -1, -1, -1, 2, 4, 6, 8]
  const out = new Float64Array(codes.length)
  let pred = 0
  let idx = 0
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    const step = steps[idx]
    let diff = step >> 3
    if (c & 4) diff += step
    if (c & 2) diff += step >> 1
    if (c & 1) diff += step >> 2
    pred = c & 8 ? pred - diff : pred + diff
    pred = Math.max(lo, Math.min(hi, pred))
    idx = Math.max(0, Math.min(steps.length - 1, idx + IDX[c & 7]))
    out[i] = pred
  }
  return out
}

describe('lofi.adpcm', () => {
  const v = synthVoice(11025, 2, { seed: 12 })
  test('4-bit IMA and OKI codes decode identically with an independent decoder', () => {
    for (const chip of ['ima', 'oki']) {
      const full = chip === 'oki' ? 1800 : 29000
      const t = Float64Array.from(v.ch[0], (x) => x * full * 1.6)
      const dec = new Float64Array(t.length)
      const codes = new Uint8Array(t.length)
      adpcmCode(t, dec, 4, chip, codes)
      const ref = imaDecodeRef(codes, chip)
      for (let i = 0; i < ref.length; i++) assert.equal(dec[i], ref[i], chip + ' sample ' + i)
      assert.ok(snrDb(t, dec) > 12, chip + ' coding SNR ' + snrDb(t, dec).toFixed(1))
    }
  })
  test('more bits sound cleaner', () => {
    const s = [2, 3, 4, 5].map((bits) => snrDb(v.ch[0], run(adpcm, v, { bits, rate: 11025 }).ch[0]))
    for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1] + 2, 'SNR by bits ' + s.map((x) => x.toFixed(1)).join(', '))
  })
  test('stair-stepped playback adds the converter images', () => {
    const w = synthVoice(48000, 1, { seed: 13 })
    const a = run(adpcm, w, { rate: 8000 }).ch[0]
    const b = run(adpcm, w, { rate: 8000, playback: 'stepped' }).ch[0]
    assert.ok(bandEnergyDb(b, 48000, 5000, 11000) - bandEnergyDb(a, 48000, 5000, 11000) > 20)
  })
})

// ---------------------------------------------------------------- console

describe('lofi.console', () => {
  test('the delta coder only steps by two and stays inside the 7-bit counter', () => {
    const t = Float32Array.from({ length: 4000 }, (_, i) => 64 + 70 * Math.sin(i / 30))
    for (const depth of [0, 4]) {
      const c = dpcmCode(t, depth, 64)
      let prev = 64
      for (let i = 0; i < c.length; i++) {
        const d = c[i] - prev
        assert.ok(d === 2 || d === -2 || (d === 0 && (c[i] >= 126 || c[i] <= 1)), 'step ' + d + ' at ' + i)
        assert.ok(c[i] >= 0 && c[i] <= 127)
        prev = c[i]
      }
    }
    // silence idles between two levels (the faint whine of a real console)
    const idle = dpcmCode(new Float32Array(200).fill(64), 0, 64)
    assert.deepEqual(new Set(Array.from(idle.slice(10))), new Set([62, 64]))
  })
  test('block coding: hardware arithmetic, decodable stream, legal headers', () => {
    assert.equal(brrSample(7, 12, 0, 0, 0), 28672)
    assert.equal(brrSample(-8, 12, 0, 0, 0), -32768)
    assert.equal(brrSample(0, 0, 1, 1000, 0), 936) // filter 1: 15/16 of the previous sample
    // a value past half scale wraps when doubled, as on the real chip
    assert.equal(brrSample(7, 12, 1, 30000, 0), ((((7 << 12) >> 1) + (30000 >> 1) + (-30000 >> 5)) * 2 << 16) >> 16)
    const v = synthVoice(32000, 1, { seed: 14 })
    const t = Float64Array.from(v.ch[0], (x) => Math.round(x * 50000))
    const { dec, headers, nibbles } = brrEncode(t)
    assert.deepEqual(brrDecode(headers, nibbles), dec)
    assert.equal(headers[0] & 0x0c, 0, 'first block uses no prediction')
    for (const h of headers) assert.ok(h >> 4 <= 12, 'shift ' + (h >> 4))
    assert.ok(snrDb(t, Float64Array.from(dec).subarray(0, t.length)) > 18, 'block coding SNR ' + snrDb(t, dec).toFixed(1))
  })
  test('Gaussian weights split 2048 at every phase and soften the top like the chip', () => {
    for (let p = 0; p < 256; p++) {
      const s = GAUSS[p * 4] + GAUSS[p * 4 + 1] + GAUSS[p * 4 + 2] + GAUSS[p * 4 + 3]
      assert.ok(Math.abs(s - 2048) <= 2, 'phase ' + p + ' sums to ' + s)
    }
    // response at the sample rate's Nyquist at whole-sample positions
    const nyq = (GAUSS[1] - GAUSS[0] - GAUSS[2] + GAUSS[3]) / 2048
    const db = 20 * Math.log10(Math.abs(nyq))
    assert.ok(db < -9 && db > -14, 'Nyquist response ' + db.toFixed(1) + ' dB')
  })
  test('the 16-bit console echo repeats at its delay and fits in the declared tail', () => {
    const click = impulse(48000, 0.4, 0.05, 0.8)
    const p = { system: 'brr', quality: 'best', echo: 80, echoTime: 96, echoRepeats: 50 }
    const out = run(consoleChip, click, p).ch[0]
    const tail = consoleChip.tail(resolveParams(consoleChip, p), 48000)
    assert.equal(out.length, click.ch[0].length + Math.round(tail * 48000))
    // energy around 0.05 + 0.096 * k s
    const e = (t0) => {
      let s = 0
      for (let i = Math.round((t0 - 0.004) * 48000); i < Math.round((t0 + 0.006) * 48000); i++) s += out[i] * out[i]
      return s
    }
    const between = e(0.05 + 0.048)
    for (const k of [1, 2]) assert.ok(e(0.05 + 0.096 * k) > 20 * between, 'repeat ' + k)
    assert.ok(e(0.05 + 0.096) > e(0.05 + 0.192), 'repeats fade')
    // the last 10 ms of the tail are near silence
    let last = 0
    for (let i = out.length - 480; i < out.length; i++) last = Math.max(last, Math.abs(out[i]))
    assert.ok(last < 0.01, 'tail ends quiet: ' + last)
    assert.equal(consoleChip.tail(resolveParams(consoleChip, { system: 'dpcm' }), 48000), 0)
  })
  test('quality settings are ordered: best is cleaner than squeezed', () => {
    const v = synthVoice(48000, 2, { seed: 15 })
    for (const system of ['brr', 'arcade', 'pcm8', 'wave4', 'dpcm']) {
      const s = ['best', 'typical', 'cheap'].map((quality) => {
        const y = run(consoleChip, v, { system, quality, echo: 0 }).ch[0]
        // compare in the band every setting keeps
        const ref = resampleTo(resampleTo(v.ch[0], 48000, 4000), 4000, 48000)
        const yy = resampleTo(resampleTo(y, 48000, 4000), 4000, 48000)
        return Math.abs(snrDb(ref, yy))
      })
      assert.ok(s[0] >= s[1] - 0.5 && s[1] > s[2], system + ' SNR ' + s.map((x) => x.toFixed(1)).join(', '))
    }
  })
  test('every system sounds different', () => {
    const v = synthVoice(48000, 1.5, { seed: 16 })
    const sys = consoleChip.params[0].options.map((o) => o.v)
    const outs = sys.map((system) => run(consoleChip, v, { system, echo: 0 }).ch[0])
    // alike = nearly the same waveform AND nearly the same spectral balance
    const bands = [[0, 300], [300, 1000], [1000, 2000], [2000, 4000], [4000, 8000], [8000, 16000]]
    const prof = outs.map((y) => bands.map(([a, b]) => bandEnergyDb(y, 48000, a, b)))
    for (let i = 0; i < outs.length; i++) {
      for (let j = i + 1; j < outs.length; j++) {
        const wave = snrDb(outs[i], outs[j])
        let spread = 0
        for (let b = 0; b < bands.length; b++) spread = Math.max(spread, Math.abs(prof[i][b] - prof[j][b] - (prof[i][1] - prof[j][1])))
        assert.ok(wave < 15 || spread > 5, sys[i] + ' and ' + sys[j] + ' are too alike (' + wave.toFixed(1) + ' dB, spread ' + spread.toFixed(1) + ')')
      }
    }
  })
})

// ---------------------------------------------------------------- mp3

describe('lofi.mp3', () => {
  test('the encoder low pass removes the top', () => {
    const nz = noiseBuf(48000, 2, 'pink', 5, 1, 0.3)
    const y = run(mp3, nz, { quality: 'bad' }).ch[0]
    const top = bandEnergyDb(y, 48000, 5000, 12000) - bandEnergyDb(nz.ch[0], 48000, 5000, 12000)
    const mid = bandEnergyDb(y, 48000, 500, 2000) - bandEnergyDb(nz.ch[0], 48000, 500, 2000)
    assert.ok(mid - top > 40, 'top only ' + (mid - top).toFixed(1) + ' dB down')
  })
  test('a sharp sound after silence gets a pre-echo', () => {
    const sr = 48000
    const x = new Float32Array(sr)
    // a burst of noise at 0.6 s, after silence
    const r = makeRng(3)
    for (let i = Math.round(0.6 * sr); i < Math.round(0.62 * sr); i++) x[i] = (r.next() * 2 - 1) * 0.8
    const y = run(mp3, { sr, ch: [x] }, { quality: 'bad' }).ch[0]
    let pre = 0
    for (let i = Math.round(0.53 * sr); i < Math.round(0.59 * sr); i++) pre += y[i] * y[i]
    let burst = 0
    for (let i = Math.round(0.6 * sr); i < Math.round(0.62 * sr); i++) burst += y[i] * y[i]
    const rel = 10 * Math.log10((pre / 0.06) / (burst / 0.02) + 1e-30)
    assert.ok(rel > -45, 'pre-echo ' + rel.toFixed(1) + ' dB under the burst')
    assert.ok(rel < -3, 'pre-echo louder than the sound itself')
  })
  test('the quality ladder is ordered and re-saving makes it worse', () => {
    const sp = loadSpeech(0)
    const v = sp ? { sr: sp.sr, ch: [sp.ch[0].slice(0, sp.sr * 6)] } : synthVoice(24000, 6, { seed: 17 })
    const ref = resampleTo(resampleTo(v.ch[0], v.sr, 5000), 5000, v.sr)
    const s = ['awful', 'bad', 'poor', 'ok'].map((quality) => {
      const y = run(mp3, v, { quality }).ch[0]
      return snrDb(ref, resampleTo(resampleTo(y, v.sr, 5000), 5000, v.sr))
    })
    for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], 'SNR ladder ' + s.map((x) => x.toFixed(1)).join(', '))
    const once = snrDb(v.ch[0], run(mp3, v, { quality: 'poor' }).ch[0])
    const thrice = snrDb(v.ch[0], run(mp3, v, { quality: 'poor', copies: 3 }).ch[0])
    assert.ok(thrice < once - 1, 're-saved ' + thrice.toFixed(1) + ' vs ' + once.toFixed(1))
    const calm = snrDb(v.ch[0], run(mp3, v, { quality: 'poor', swirl: 0 }).ch[0])
    const wild = snrDb(v.ch[0], run(mp3, v, { quality: 'poor', swirl: 100 }).ch[0])
    assert.ok(wild < calm - 3, 'swirl ' + wild.toFixed(1) + ' vs ' + calm.toFixed(1))
  })
  test('joint stereo keeps a centred voice centred', () => {
    const v = synthVoice(48000, 1, { seed: 18 })
    const y = run(mp3, { sr: 48000, ch: [v.ch[0], Float32Array.from(v.ch[0])] }, { quality: 'poor' })
    for (let i = 0; i < y.ch[0].length; i++) assert.equal(y.ch[0][i], y.ch[1][i])
  })
})

// ---------------------------------------------------------------- speaker, drive, blown, saturate

describe('lofi.speaker', () => {
  test('each size band-limits like the thing it is named after', () => {
    const nz = noiseBuf(48000, 2, 'pink', 6, 1, 0.2)
    const resp = (size, lo, hi) => {
      const y = run(speaker, nz, { size, push: 0, rattle: 0 }).ch[0]
      return bandEnergyDb(y, 48000, lo, hi) - bandEnergyDb(nz.ch[0], 48000, lo, hi)
    }
    const lowLoss = (size) => resp(size, 1000, 3000) - resp(size, 60, 160)
    const highLoss = (size) => resp(size, 1000, 3000) - resp(size, 9000, 16000)
    for (const s of ['earbud', 'phone', 'toy', 'megaphone', 'handheld', 'horn']) assert.ok(lowLoss(s) > 20, s + ' lows ' + lowLoss(s).toFixed(1))
    for (const s of ['tv', 'cabinet', 'portable']) assert.ok(lowLoss(s) < lowLoss('phone') - 8, s + ' keeps more lows')
    for (const s of ['toy', 'radio', 'megaphone']) assert.ok(highLoss(s) > 20, s + ' highs ' + highLoss(s).toFixed(1))
    assert.ok(lowLoss('portable') < 8, 'the portable speaker has bass')
  })
  test('rattle buzzes on loud lows', () => {
    const s = sine(48000, 1, 120, 0.8)
    const a = run(speaker, s, { size: 'phone', push: 12, rattle: 0 }).ch[0]
    const b = run(speaker, s, { size: 'phone', push: 12, rattle: 100 }).ch[0]
    assert.ok(bandEnergyDb(b, 48000, 2500, 6000) - bandEnergyDb(a, 48000, 2500, 6000) > 6)
  })
})

function harmonicReport(y, sr, f0) {
  const N = 16384
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const off = Math.floor((y.length - N) / 2)
  for (let i = 0; i < N; i++) re[i] = y[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
  cfft(re, im)
  let harm = 0
  let fund = 0
  let other = 0
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N
    const p = re[k] * re[k] + im[k] * im[k]
    const h = f / f0
    const near = Math.abs(h - Math.round(h)) * f0 < 25
    if (near && Math.round(h) === 1) fund += p
    else if (near) harm += p
    else other += p
  }
  return { thd: 10 * Math.log10(harm / fund), alias: 10 * Math.log10(other / (harm + fund)) }
}

describe('lofi.drive', () => {
  test('more drive, more harmonics', () => {
    const s = sine(48000, 1, 220, 0.3)
    for (const character of ['warm', 'crunch', 'fuzz', 'hard', 'fold']) {
      const lo = harmonicReport(run(drive, s, { character, drive: 0 }).ch[0], 48000, 220).thd
      const hi = harmonicReport(run(drive, s, { character, drive: 30 }).ch[0], 48000, 220).thd
      assert.ok(hi > lo + 6, character + ' THD ' + lo.toFixed(1) + ' -> ' + hi.toFixed(1))
    }
  })
  test('oversampling keeps aliases well under the harmonics', () => {
    const s = sine(48000, 1, 2489, 0.5)
    const r = harmonicReport(run(drive, s, { character: 'hard', drive: 24, tone: 0 }).ch[0], 48000, 2489)
    assert.ok(r.alias < -25, 'alias level ' + r.alias.toFixed(1) + ' dB')
  })
  test('mix at zero is the dry voice, aligned', () => {
    const v = synthVoice(48000, 0.5, { seed: 19 })
    const y = run(drive, v, { mix: 0 }).ch[0]
    for (let i = 0; i < y.length; i++) assert.ok(Math.abs(y[i] - v.ch[0][i]) < 1e-6)
  })
  test('the output level stays near the input level as drive rises', () => {
    const v = synthVoice(48000, 1, { seed: 20 })
    for (const d of [0, 24, 48]) {
      const dd = rmsDb(run(drive, v, { drive: d }).ch[0]) - rmsDb(v)
      assert.ok(Math.abs(dd) < 9, 'drive ' + d + ' changed the level ' + dd.toFixed(1) + ' dB')
    }
  })
})

describe('lofi.blown', () => {
  test('crackle cuts the sound out now and then; none without it', () => {
    const s = sine(48000, 4, 300, 0.5)
    const dips = (y) => {
      let n = 0
      let inDip = false
      const w = 96
      for (let i = 4800; i + w < y.length; i += w) {
        let e = 0
        for (let k = 0; k < w; k++) e = Math.max(e, Math.abs(y[i + k]))
        const low = e < 0.08
        if (low && !inDip) n++
        inDip = low
      }
      return n
    }
    assert.equal(dips(run(blown, s, { crackle: 0, rattle: 0, buzz: 0 }).ch[0]), 0)
    assert.ok(dips(run(blown, s, { crackle: 100, rattle: 0, buzz: 0 }).ch[0]) >= 4)
  })
  test('buzz adds fizz on loud words', () => {
    const v = synthVoice(48000, 1.5, { seed: 21 })
    const a = run(blown, v, { buzz: 0, crackle: 0 }).ch[0]
    const b = run(blown, v, { buzz: 100, crackle: 0 }).ch[0]
    assert.ok(bandEnergyDb(b, 48000, 2000, 6000) - bandEnergyDb(a, 48000, 2000, 6000) > 3)
  })
})

describe('lofi.saturate', () => {
  test('the head bump lifts the lows by about its setting', () => {
    for (const [speed, f] of [['7.5', 48], ['15', 85], ['30', 150]]) {
      const lo = run(saturate, sine(48000, 1, f, 0.01), { drive: 0, bump: 6, speed }).ch[0]
      const mid = run(saturate, sine(48000, 1, 1000, 0.01), { drive: 0, bump: 6, speed }).ch[0]
      const d = rmsDb(lo.subarray(24000)) - rmsDb(mid.subarray(24000))
      assert.ok(d > 4 && d < 8, speed + ' bump ' + d.toFixed(1) + ' dB')
    }
  })
  test('under-bias distorts more than aligned bias', () => {
    const s = sine(48000, 1, 220, 0.4)
    const a = harmonicReport(run(saturate, s, { drive: 12, bias: 0 }).ch[0], 48000, 220).thd
    const b = harmonicReport(run(saturate, s, { drive: 12, bias: -100 }).ch[0], 48000, 220).thd
    assert.ok(b > a + 3, 'THD ' + a.toFixed(1) + ' vs under-biased ' + b.toFixed(1))
  })
})

// ---------------------------------------------------------------- live

function runLive(mod, buf, p, block, seed, inPlace = false) {
  const params = resolveParams(mod, p)
  const k = mod.live.create(buf.sr, params, makeRng(seed))
  const n = buf.ch[0].length
  const outs = buf.ch.map(() => new Float32Array(n))
  for (let s = 0; s < n; s += block) {
    const e = Math.min(n, s + block)
    if (inPlace) {
      const views = outs.map((o, c) => {
        o.set(buf.ch[c].subarray(s, e), s)
        return o.subarray(s, e)
      })
      k.process(views, views, e - s)
    } else {
      k.process(buf.ch.map((c) => c.subarray(s, e)), outs.map((o) => o.subarray(s, e)), e - s)
    }
  }
  return { k, outs }
}

describe('lofi: live versions', () => {
  const v = stereoOf(synthVoice(48000, 1, { seed: 22 }), synthVoice(48000, 1, { seed: 23, f0: 190 }))
  for (const mod of LIVE.filter((m) => m !== companding)) {
    test(mod.id + ' live gives the offline samples for any block size, in place too', () => {
      const params = resolveParams(mod, {})
      const L = mod.live.latency(params, 48000)
      const off = mod.process({ sr: 48000, ch: v.ch.map((c) => Float32Array.from(c)) }, params, ctxFor(5))
      for (const [block, inPlace] of [[128, false], [480, true], [1, false], [1000, true]]) {
        const { outs } = runLive(mod, v, {}, block, 5, inPlace)
        for (let c = 0; c < 2; c++) {
          let worst = 0
          for (let i = 0; i + L < outs[c].length; i++) worst = Math.max(worst, Math.abs(outs[c][i + L] - off.ch[c][i]))
          assert.ok(worst < 1e-5, mod.id + ' block ' + block + ' channel ' + c + ' differs by ' + worst)
        }
      }
    })
  }
  test('lofi.companding live sounds like the offline version', () => {
    const w = synthVoice(48000, 2, { seed: 24 })
    for (const p of [{}, { law: 'a', bits: 6 }, { band: false, rate: 11000 }]) {
      const params = resolveParams(companding, p)
      const L = companding.live.latency(params, 48000)
      const off = run(companding, w, p).ch[0]
      const { outs } = runLive(companding, w, p, 128, 1)
      const live = outs[0].subarray(L)
      assert.ok(snrDb(off.subarray(0, live.length), live) > 8, JSON.stringify(p) + ' live SNR ' + snrDb(off.subarray(0, live.length), live).toFixed(1))
      for (const [lo, hi] of [[300, 1000], [1000, 3000]]) {
        const d = bandEnergyDb(live, 48000, lo, hi) - bandEnergyDb(off, 48000, lo, hi)
        assert.ok(Math.abs(d) < 2, 'band ' + lo + '-' + hi + ' differs ' + d.toFixed(1) + ' dB')
      }
    }
  })
  test('mono in, mono out; reset clears the state', () => {
    const m = synthVoice(48000, 0.3, { seed: 25 })
    for (const mod of LIVE) {
      const params = resolveParams(mod, {})
      const k = mod.live.create(48000, params, makeRng(1))
      const out = new Float32Array(m.ch[0].length)
      k.process([m.ch[0]], [out], out.length)
      assertSane({ sr: 48000, ch: [out] })
      k.reset()
      const z = new Float32Array(4800)
      const o2 = new Float32Array(4800)
      k.process([z], [o2], 4800)
      let pk = 0
      for (const x of o2) pk = Math.max(pk, Math.abs(x))
      assert.ok(pk < 1e-3, mod.id + ' rang on after reset: ' + pk)
      // a stray NaN or Infinity from a host is treated as silence
      const bad = Float32Array.from(m.ch[0].subarray(0, 2048))
      bad[100] = NaN
      bad[700] = Infinity
      bad[1500] = -Infinity
      const o3 = new Float32Array(2048)
      k.process([bad], [o3], 2048)
      assertSane({ sr: 48000, ch: [o3] })
      k.process([m.ch[0].subarray(0, 2048)], [o3], 2048)
      assertSane({ sr: 48000, ch: [o3] })
    }
  })
  test('changing settings while playing does not click', () => {
    const s = sine(48000, 1, 200, 0.4)
    const changes = {
      'lofi.drive': [{ drive: 6 }, { drive: 36, character: 'fuzz', tone: 60, mix: 50 }],
      'lofi.crush': [{ bits: 8, mix: 100 }, { bits: 8, mix: 20 }],
      'lofi.speaker': [{ size: 'phone', push: 0 }, { size: 'tv', push: 20 }],
      'lofi.blown': [{ crackle: 0, rattle: 0, buzz: 0 }, { crackle: 0, rattle: 90, buzz: 90 }],
      'lofi.companding': [{}, { bits: 7 }],
      'lofi.saturate': [{ drive: 0 }, { drive: 20, bias: -50, speed: '30' }],
    }
    for (const mod of LIVE) {
      const [p0, p1] = changes[mod.id]
      const k = mod.live.create(48000, resolveParams(mod, p0), makeRng(1))
      const out = new Float32Array(s.ch[0].length)
      const B = 128
      for (let i = 0; i < out.length; i += B) {
        if (i === 24064) k.set(resolveParams(mod, p1))
        k.process([s.ch[0].subarray(i, i + B)], [out.subarray(i, i + B)], Math.min(B, out.length - i))
      }
      let steady = 0
      for (let i = 12000; i < 23000; i++) steady = Math.max(steady, Math.abs(out[i] - out[i - 1]))
      let jump = 0
      for (let i = 24064; i < 24064 + 2400; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]))
      let after = 0
      for (let i = 36000; i < 47000; i++) after = Math.max(after, Math.abs(out[i] - out[i - 1]))
      assert.ok(jump <= 1.5 * Math.max(steady, after) + 0.02, mod.id + ' jump ' + jump.toFixed(3) + ' vs steady ' + steady.toFixed(3) + '/' + after.toFixed(3))
    }
  })
})

// ---------------------------------------------------------------- speed

describe('lofi: speed', () => {
  test('milliseconds per second of 48 kHz mono speech', (t) => {
    const v = synthVoice(48000, 10, { seed: 26 })
    const bound = { 1: 60, 2: 60, 3: 250, 4: 600, 5: 1200 }
    const rows = []
    for (const mod of ALL) {
      const params = resolveParams(mod, {})
      const ms = timeIt(() => mod.process({ sr: 48000, ch: [Float32Array.from(v.ch[0])] }, params, ctxFor(1)), 2) / 10
      rows.push(mod.id + ' ' + ms.toFixed(1))
      assert.ok(ms < bound[mod.cost], mod.id + ' took ' + ms.toFixed(1) + ' ms per second (cost ' + mod.cost + ')')
    }
    // the heaviest settings of the heavy modules
    const heavy = [
      [consoleChip, { system: 'brr', quality: 'best' }],
      [consoleChip, { system: 'dpcm', quality: 'best' }],
      [mp3, { quality: 'ok', copies: 4 }],
    ]
    for (const [mod, p] of heavy) {
      const params = resolveParams(mod, p)
      const ms = timeIt(() => mod.process({ sr: 48000, ch: [Float32Array.from(v.ch[0])] }, params, ctxFor(1)), 1) / 10
      rows.push(mod.id + ' ' + JSON.stringify(p) + ' ' + ms.toFixed(1))
      assert.ok(ms < 600, mod.id + ' heavy setting took ' + ms.toFixed(1) + ' ms per second')
    }
    for (const mod of LIVE) {
      const params = resolveParams(mod, {})
      const k = mod.live.create(48000, params, makeRng(1))
      const out = new Float32Array(128)
      const ms = timeIt(() => {
        for (let i = 0; i + 128 <= v.ch[0].length; i += 128) k.process([v.ch[0].subarray(i, i + 128)], [out], 128)
      }, 1) / 10
      rows.push(mod.id + ' live ' + ms.toFixed(1))
      assert.ok(ms < 100, mod.id + ' live took ' + ms.toFixed(1) + ' ms per second')
    }
    t.diagnostic('ms per second of 48 kHz mono: ' + rows.join('; '))
  })
})
