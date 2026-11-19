// test/mod.nodetest.mjs - the mod family (modulation, rhythm and choppers).
//
// What it proves, module by module ("Prove it" lines of MODULES_PLAN section 6):
// - every module passes validateModuleShape, survives empty input, silence, a
//   click, stereo input and every numeric setting at its ends and every choice,
//   at 48 kHz and 22.05 kHz, with no NaN or Infinity, peak under 8, the right
//   channel count and the declared length;
// - same seed, same output; the live versions give identical output whatever
//   block size the host uses, work in place, survive parameter changes in
//   mid-stream, and (for the modules whose offline render is the live kernel)
//   match the offline render sample for sample once latency is allowed for;
// - and that each effect does what its name says: chorus is a delayed copy at
//   its delay time; flanger and phaser cut their notches where the formulas
//   say; tremolo, auto-pan, chopper and rotary modulate at their rates (the
//   rotary's horn and drum at their own, different speeds, with Doppler pitch
//   wobble and the slow-to-fast ramp); the chopper dips highs deeper than lows;
//   the envelope filter opens with loudness; the rhythm gate follows its
//   pattern; the pass-by follows the Doppler formula and pans across; underwater
//   muffles, wavers and bubbles; keyed gates, ducks, follows and uses the other
//   sound, and says so when it is missing.
// Real speech from F:/Kade ai info is used when present (skipped otherwise).
//
// Run: node --test engine/test/mod.nodetest.mjs   (Node 24)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import { synthVoice, sine, noiseBuf, impulse, silence } from './fixtures.mjs'
import { assertSane, rmsDb, spectralCentroid, bandEnergyDb, stereoCorrelation, timeIt, cfft } from './measure.mjs'
import { validateModuleShape, resolveParams } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { decodeWav } from '../core/wav.js'

import chorus from '../modules/mod/chorus.js'
import flanger from '../modules/mod/flanger.js'
import phaser from '../modules/mod/phaser.js'
import tremolo from '../modules/mod/tremolo.js'
import autopan from '../modules/mod/autopan.js'
import rotary from '../modules/mod/rotary.js'
import autowah from '../modules/mod/autowah.js'
import gate from '../modules/mod/gate.js'
import chopper from '../modules/mod/chopper.js'
import doppler from '../modules/mod/doppler.js'
import underwater from '../modules/mod/underwater.js'
import keyed, { builtinSource } from '../modules/mod/keyed.js'

const ALL = [chorus, flanger, phaser, tremolo, autopan, rotary, autowah, gate, chopper, doppler, underwater, keyed]
// modules whose offline render is exactly the live kernel
const SAME_KERNEL = ['mod.chorus', 'mod.flanger', 'mod.phaser', 'mod.tremolo', 'mod.autopan', 'mod.rotary', 'mod.chopper', 'mod.gate']

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

// ---------------------------------------------------------------- helpers

function ctxFor(sr, seed = 1, extra = {}) {
  const notes = []
  return { sr, rng: makeRng(seed), progress() {}, cancelled: () => false, note: (s) => notes.push(s), notes, ...extra }
}

function copyBuf(b) {
  return { sr: b.sr, ch: b.ch.map((c) => new Float32Array(c)) }
}

function run(mod, buf, over = {}, seed = 1, extra = {}) {
  const ctx = ctxFor(buf.sr, seed, extra)
  const out = mod.process(copyBuf(buf), resolveParams(mod, over), ctx)
  out.notes = ctx.notes
  return out
}

function expectChannels(mod, nIn) {
  return mod.stereo === 'make' ? 2 : mod.stereo === 'mono' ? 1 : nIn
}

function checkLength(mod, p, inLen, out, sr) {
  if (mod.warps) return
  const want = inLen + Math.round(mod.tail(p, sr) * sr)
  assert.ok(Math.abs(out.ch[0].length - want) <= Math.round(0.01 * sr), mod.id + ' length ' + out.ch[0].length + ' expected ' + want)
}

function mono(b) {
  if (b.ch.length === 1) return b.ch[0]
  const n = b.ch[0].length
  const m = new Float32Array(n)
  for (const c of b.ch) for (let i = 0; i < n; i++) m[i] += c[i] / b.ch.length
  return m
}

function slice(sig, sr, a, b) {
  return sig.subarray(Math.round(a * sr), Math.round(b * sr))
}

function rmsDbOf(sig) {
  return rmsDb(sig)
}

/** Mean absolute value per 1 ms hop: an envelope sampled at 1 kHz. */
function envelope(sig, sr) {
  const hop = Math.max(1, Math.round(sr / 1000))
  const n = Math.floor(sig.length / hop)
  const e = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let i = k * hop; i < (k + 1) * hop; i++) s += Math.abs(sig[i])
    e[k] = s / hop
  }
  return e
}

/** Strongest modulation frequency of an envelope (1 kHz rate) between lo and hi Hz. */
function modRate(env, lo, hi) {
  const n = env.length
  let N = 1
  while (N < n * 8) N <<= 1
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  let mean = 0
  for (let i = 0; i < n; i++) mean += env[i]
  mean /= n
  for (let i = 0; i < n; i++) re[i] = (env[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n))
  cfft(re, im)
  const mag = (k) => Math.hypot(re[k], im[k])
  let best = -1
  let bk = 0
  const k0 = Math.max(1, Math.floor((lo * N) / 1000))
  const k1 = Math.min(N / 2 - 1, Math.ceil((hi * N) / 1000))
  for (let k = k0; k <= k1; k++) {
    const m = mag(k)
    if (m > best) {
      best = m
      bk = k
    }
  }
  const a = mag(bk - 1), b = mag(bk), c = mag(bk + 1)
  const den = a - 2 * b + c
  const off = den < 0 ? (0.5 * (a - c)) / den : 0
  return ((bk + off) * 1000) / N
}

/** Frequency of a near-sinusoid from rising zero crossings (interpolated). */
function zcFreq(sig, sr) {
  let first = -1
  let last = -1
  let count = 0
  for (let i = 1; i < sig.length; i++) {
    if (sig[i - 1] < 0 && sig[i] >= 0) {
      const t = i - 1 + -sig[i - 1] / (sig[i] - sig[i - 1])
      if (first < 0) first = t
      else count++
      last = t
    }
  }
  return count > 0 ? (count * sr) / (last - first) : 0
}

function corr(a, b) {
  const n = Math.min(a.length, b.length)
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    sab += x * y
    saa += x * x
    sbb += y * y
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0
}

/** Run a live kernel over a mono or stereo buffer in blocks. */
function runLive(mod, buf, over, block, seed = 7, inPlace = false) {
  const p = resolveParams(mod, over)
  const k = mod.live.create(buf.sr, p, makeRng(seed))
  const n = buf.ch[0].length
  const nOut = expectChannels(mod, buf.ch.length)
  const outs = []
  for (let c = 0; c < nOut; c++) outs.push(new Float32Array(n))
  const ins = buf.ch.map((c) => new Float32Array(c))
  for (let a = 0; a < n; a += block) {
    const b = Math.min(n, a + block)
    const iv = ins.map((c) => c.subarray(a, b))
    const ov = inPlace && nOut === ins.length ? iv : outs.map((c) => c.subarray(a, b))
    k.process(iv, ov, b - a)
  }
  return inPlace && nOut === ins.length ? ins : outs
}

function maxDiff(a, b, from = 0) {
  let m = 0
  const n = Math.min(a.length, b.length)
  for (let i = from; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

const V48 = synthVoice(48000, 1, { seed: 11 })
const V22 = synthVoice(22050, 1, { seed: 12 })

// ---------------------------------------------------------------- battery

describe('mod family: contract battery', () => {
  for (const mod of ALL) {
    test(mod.id + ' shape, names and defaults', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'mod')
      assert.ok(mod.params.length >= 2 && mod.params.length <= 8, mod.id + ' should have 2 to 8 settings')
      if (mod.id === 'mod.doppler') assert.equal(mod.live, undefined)
      else assert.ok(mod.live && typeof mod.live.create === 'function', mod.id + ' needs live')
    })

    test(mod.id + ' edge inputs at 48 kHz and 22.05 kHz', () => {
      for (const sr of [48000, 22050]) {
        const p = resolveParams(mod, {})
        const empty = mod.process({ sr, ch: [new Float32Array(0)] }, p, ctxFor(sr))
        assert.equal(empty.ch[0].length, 0)
        assert.equal(empty.ch.length, expectChannels(mod, 1))
        for (const b of [silence(sr, 0.5), impulse(sr, 0.5, 0.1), sr === 48000 ? V48 : V22]) {
          const out = run(mod, b)
          assertSane(out)
          assert.equal(out.ch.length, expectChannels(mod, 1))
          checkLength(mod, p, b.ch[0].length, out, sr)
        }
        // stereo in
        const v = sr === 48000 ? V48 : V22
        const st = { sr, ch: [new Float32Array(v.ch[0]), new Float32Array(v.ch[0]).map((x, i) => x * 0.5 + (i % 7) * 1e-4)] }
        const out = run(mod, st)
        assertSane(out)
        assert.equal(out.ch.length, expectChannels(mod, 2))
      }
    })

    test(mod.id + ' every setting at its ends and every choice', () => {
      for (const sr of [48000, 22050]) {
        const v = sr === 48000 ? V48 : V22
        for (const prm of mod.params) {
          const values = prm.type === 'number' ? [prm.min, prm.max] : prm.type === 'bool' ? [true, false] : prm.options.map((o) => o.v)
          for (const val of values) {
            const over = { [prm.id]: val }
            const out = run(mod, v, over)
            const s = assertSane(out)
            assert.ok(s.peak < 8, mod.id + ' ' + prm.id + '=' + val + ' peak ' + s.peak)
            checkLength(mod, resolveParams(mod, over), v.ch[0].length, out, sr)
          }
        }
      }
    })

    test(mod.id + ' is deterministic and runs at 8 kHz and 96 kHz', () => {
      const a = run(mod, V48, {}, 5)
      const b = run(mod, V48, {}, 5)
      for (let c = 0; c < a.ch.length; c++) assert.equal(maxDiff(a.ch[c], b.ch[c]), 0)
      for (const sr of [8000, 96000]) assertSane(run(mod, synthVoice(sr, 0.6, { seed: 2 })))
    })

    if (mod.live) {
      test(mod.id + ' live: block size, in place, parameter changes', () => {
        const sr = 48000
        const v = synthVoice(sr, 1.5, { seed: 21 })
        const a = runLive(mod, v, {}, 128)
        const b = runLive(mod, v, {}, 480)
        const c = runLive(mod, v, {}, 37)
        for (let ch = 0; ch < a.length; ch++) {
          assert.ok(maxDiff(a[ch], b[ch]) < 1e-6, mod.id + ' blocks 128 and 480 differ')
          assert.ok(maxDiff(a[ch], c[ch]) < 1e-6, mod.id + ' blocks 128 and 37 differ')
          for (const x of a[ch]) assert.ok(Number.isFinite(x))
        }
        if (mod.stereo === 'keep') {
          const ip = runLive(mod, v, {}, 128, 7, true)
          assert.ok(maxDiff(ip[0], a[0]) < 1e-6, mod.id + ' in-place output differs')
        }
        // stereo input to the live kernel
        const st = { sr, ch: [v.ch[0], new Float32Array(v.ch[0]).reverse()] }
        for (const ch of runLive(mod, st, {}, 128)) for (const x of ch) assert.ok(Number.isFinite(x))
        // settings jumping between their ends every 0.1 s
        const p = resolveParams(mod, {})
        const k = mod.live.create(sr, p, makeRng(3))
        assert.ok(Number.isFinite(mod.live.latency(p, sr)) && mod.live.latency(p, sr) >= 0)
        const n = v.ch[0].length
        const nOut = expectChannels(mod, 1)
        const outs = []
        for (let q = 0; q < nOut; q++) outs.push(new Float32Array(n))
        let flip = 0
        for (let at = 0; at < n; at += 480) {
          if (at % 4800 === 0) {
            const over = {}
            for (const prm of mod.params) {
              if (prm.type === 'number') over[prm.id] = flip & 1 ? prm.max : prm.min
              else if (prm.type === 'choice') over[prm.id] = prm.options[flip % prm.options.length].v
              else over[prm.id] = !!(flip & 1)
            }
            k.set(resolveParams(mod, over))
            flip++
          }
          const e = Math.min(n, at + 480)
          k.process([v.ch[0].subarray(at, e)], outs.map((o) => o.subarray(at, e)), e - at)
        }
        let pk = 0
        for (const o of outs) for (const x of o) {
          assert.ok(Number.isFinite(x))
          pk = Math.max(pk, Math.abs(x))
        }
        assert.ok(pk < 8, mod.id + ' live peak ' + pk)
        k.reset()
        k.process([v.ch[0].subarray(0, 128)], outs.map((o) => o.subarray(0, 128)), 128)
      })
    }

    if (SAME_KERNEL.includes(mod.id)) {
      test(mod.id + ' live matches the offline render', () => {
        const sr = 48000
        const v = synthVoice(sr, 1.2, { seed: 31 })
        const over = mod.id === 'mod.gate' ? { sync: false } : {}
        const off = run(mod, v, over, 7)
        const lv = runLive(mod, v, over, 128, 7)
        const lat = mod.live.latency(resolveParams(mod, over), sr)
        const n = v.ch[0].length
        for (let c = 0; c < lv.length; c++) {
          let m = 0
          for (let i = lat; i < n; i++) m = Math.max(m, Math.abs(lv[c][i] - off.ch[c][i - lat]))
          assert.ok(m < 1e-4, mod.id + ' live and offline differ by ' + m)
        }
      })
    }
  }
})

// ---------------------------------------------------------------- what each one does

describe('mod family: each effect does what its name says', () => {
  test('chorus: one voice at depth 0 is the input delayed by the delay time; spread decorrelates', () => {
    const sr = 48000
    const x = noiseBuf(sr, 0.5, 'white', 3, 1, 0.3)
    const out = run(chorus, x, { voices: 1, depth: 0, mix: 100, spread: 0, delay: 20 })
    const d = Math.round(0.02 * sr)
    let err = 0
    for (let i = d + 10; i < x.ch[0].length; i++) err = Math.max(err, Math.abs(out.ch[0][i] - x.ch[0][i - d]))
    assert.ok(err < 1e-3, 'delayed copy error ' + err)
    assert.equal(maxDiff(run(chorus, x, { mix: 0 }).ch[0], x.ch[0]), 0)
    const wide = run(chorus, synthVoice(sr, 2, { seed: 4 }), { spread: 100, mix: 100, voices: 4 })
    assert.ok(stereoCorrelation(wide) < 0.9, 'spread chorus correlation ' + stereoCorrelation(wide))
  })

  test('flanger: a still comb at 2 ms cuts 250 Hz and keeps 500 Hz', () => {
    const sr = 48000
    const over = { depth: 0, feedback: 0, mix: 50, delay: 2 }
    const notch = run(flanger, sine(sr, 0.5, 250, 0.5), over)
    const peak = run(flanger, sine(sr, 0.5, 500, 0.5), over)
    const inDb = rmsDbOf(slice(sine(sr, 0.5, 250, 0.5).ch[0], sr, 0.1, 0.45))
    assert.ok(rmsDbOf(slice(notch.ch[0], sr, 0.1, 0.45)) < inDb - 30, 'notch at 250 Hz')
    assert.ok(rmsDbOf(slice(peak.ch[0], sr, 0.1, 0.45)) > inDb - 1, 'peak at 500 Hz')
    // sweeping: the spectrum moves over time
    const swept = run(flanger, noiseBuf(sr, 4, 'white', 2, 1, 0.3), { rate: 0.5 })
    const c1 = spectralCentroid(slice(swept.ch[0], sr, 0.2, 1.0), sr)
    const c2 = spectralCentroid(slice(swept.ch[0], sr, 1.2, 2.0), sr)
    assert.ok(Math.abs(c1 - c2) > 50, 'flanger sweep should move the comb (' + c1.toFixed(0) + ' vs ' + c2.toFixed(0) + ')')
  })

  test('phaser: four still stages notch exactly where the allpass phase reaches 180 degrees', () => {
    const sr = 48000
    const t = Math.tan((Math.PI * 1000) / sr)
    const a = (t - 1) / (t + 1)
    // phase of N first-order sections (a + z^-1) / (1 + a z^-1)
    const phase = (f) => {
      const w = (2 * Math.PI * f) / sr
      const nr = a + Math.cos(w), ni = -Math.sin(w)
      const dr = 1 + a * Math.cos(w), di = -a * Math.sin(w)
      return 4 * (Math.atan2(ni, nr) - Math.atan2(di, dr))
    }
    let lo = 50, hi = 1000
    for (let it = 0; it < 60; it++) {
      const mid = 0.5 * (lo + hi)
      if (phase(mid) > -Math.PI) lo = mid
      else hi = mid
    }
    const fn = 0.5 * (lo + hi)
    const over = { stages: 4, depth: 0, feedback: 0, center: 1000, mix: 50 }
    const x = sine(sr, 0.6, fn, 0.5)
    const y = run(phaser, x, over)
    assert.ok(rmsDbOf(slice(y.ch[0], sr, 0.2, 0.55)) < rmsDbOf(slice(x.ch[0], sr, 0.2, 0.55)) - 25, 'notch at ' + fn.toFixed(0) + ' Hz')
    const y2 = run(phaser, sine(sr, 0.6, 1000, 0.5), over)
    assert.ok(rmsDbOf(slice(y2.ch[0], sr, 0.2, 0.55)) > rmsDbOf(slice(x.ch[0], sr, 0.2, 0.55)) - 4, 'no notch at the centre')
  })

  test('tremolo: the level pulses at its rate; full-depth choppy wave reaches silence', () => {
    const sr = 48000
    const x = sine(sr, 3, 1000, 0.5)
    const y = run(tremolo, x, { rate: 5.5, depth: 100 })
    const r = modRate(envelope(y.ch[0], sr), 1, 30)
    assert.ok(Math.abs(r - 5.5) < 0.15, 'tremolo rate ' + r)
    const sq = run(tremolo, x, { rate: 4, depth: 100, shape: 'square' })
    const env = envelope(sq.ch[0], sr)
    let mn = Infinity, mx = 0
    for (let i = 200; i < env.length - 200; i++) {
      mn = Math.min(mn, env[i])
      mx = Math.max(mx, env[i])
    }
    assert.ok(mn < mx * 0.01, 'choppy wave should reach near silence')
    const st = run(tremolo, x, { rate: 3, depth: 100, phase: 180 })
    assert.ok(corr(envelope(st.ch[0], sr), envelope(st.ch[1], sr)) < -0.8, 'half-cycle offset swaps the sides')
  })

  test('auto-pan: the voice swings between the ears at its rate', () => {
    const sr = 48000
    const x = sine(sr, 4, 500, 0.5)
    const y = run(autopan, x, { rate: 1, width: 100, head: false })
    const eL = envelope(y.ch[0], sr)
    const eR = envelope(y.ch[1], sr)
    assert.ok(corr(eL, eR) < -0.8, 'left and right should move against each other')
    assert.ok(Math.abs(modRate(eL, 0.3, 5) - 1) < 0.08, 'pan rate')
    // starts toward the right
    const early = slice(y.ch[1], sr, 0.2, 0.3)
    assert.ok(rmsDbOf(early) > rmsDbOf(slice(y.ch[0], sr, 0.2, 0.3)) + 6, 'starts toward the right')
  })

  test('rotary: horn and drum spin at their own speeds, with Doppler wobble and the ramp', () => {
    const sr = 48000
    const hornIn = sine(sr, 6, 2500, 0.4)
    const drumIn = sine(sr, 6, 150, 0.4)
    const hf = run(rotary, hornIn, { speed: 'fast', mix: 100, drive: 0 })
    const df = run(rotary, drumIn, { speed: 'fast', mix: 100, drive: 0 })
    const hr = modRate(envelope(slice(hf.ch[0], sr, 0.5, 6), sr), 2, 12)
    const dr = modRate(envelope(slice(df.ch[0], sr, 0.5, 6), sr), 2, 12)
    assert.ok(Math.abs(hr - 6.75) < 0.25, 'horn fast rate ' + hr)
    assert.ok(Math.abs(dr - 5.83) < 0.25, 'drum fast rate ' + dr)
    // Doppler: the horn's pitch moves (zero-crossing frequency over 20 ms windows)
    let fmin = Infinity, fmax = 0
    for (let t = 1; t < 2; t += 0.02) {
      const f = zcFreq(slice(hf.ch[0], sr, t, t + 0.02), sr)
      fmin = Math.min(fmin, f)
      fmax = Math.max(fmax, f)
    }
    assert.ok(fmax / fmin > 1.01, 'horn Doppler wobble ' + (fmax / fmin).toFixed(4))
    const hs = run(rotary, sine(sr, 8, 2500, 0.4), { speed: 'slow', mix: 100 })
    const sr2 = modRate(envelope(slice(hs.ch[0], sr, 0.5, 8), sr), 0.3, 3)
    assert.ok(Math.abs(sr2 - 0.83) < 0.12, 'horn slow rate ' + sr2)
    // speeding up after 2 s. The horn's wall reflection makes a lone tone
    // shimmer many times per turn (as on the real cabinet), so the ramp is
    // read from the drum, which has a single path: slow swings before the
    // switch, close to its fast speed once its heavier rotor has caught up.
    const swings = (raw) => {
      // 61 ms moving average first: a 150 Hz tone ripples the 1 ms envelope
      const e = new Float64Array(raw.length)
      for (let i = 0; i < raw.length; i++) {
        let s = 0, c = 0
        for (let j = Math.max(0, i - 30); j <= Math.min(raw.length - 1, i + 30); j++) {
          s += raw[j]
          c++
        }
        e[i] = s / c
      }
      let m = 0
      for (const v of e) m += v
      m /= e.length
      let c = 0
      let armed = true
      for (let i = 1; i < e.length; i++) {
        if (armed && e[i] >= m * 1.05) {
          c++
          armed = false
        } else if (!armed && e[i] < m * 0.95) armed = true
      }
      return c / (e.length / 1000)
    }
    const dUp = run(rotary, sine(sr, 9, 150, 0.4), { speed: 'up', switchAt: 2, mix: 100, drive: 0 })
    const before = envelope(slice(dUp.ch[0], sr, 0.1, 1.95), sr)
    const after = envelope(slice(dUp.ch[0], sr, 6.5, 9), sr)
    assert.ok(swings(before) < 1.6, 'drum slow before the switch: ' + swings(before).toFixed(2) + ' swings per second')
    const dAfter = modRate(after, 2, 12)
    assert.ok(dAfter > 5.2 && dAfter < 6.1, 'drum fast after: ' + dAfter.toFixed(2))
    // the light horn gets there first: fast within about a second of the switch
    const hUp = run(rotary, sine(sr, 5, 2500, 0.4), { speed: 'up', switchAt: 2, mix: 100, drive: 0 })
    const hAfter = modRate(envelope(slice(hUp.ch[0], sr, 3.2, 5), sr), 2, 12)
    assert.ok(Math.abs(hAfter - 6.75) < 0.5, 'horn fast soon after the switch: ' + hAfter.toFixed(2))
    const dEarly = modRate(envelope(slice(dUp.ch[0], sr, 3.2, 5), sr), 1, 12)
    assert.ok(dEarly < hAfter - 0.5, 'the drum is still catching up (' + dEarly.toFixed(2) + ' vs horn ' + hAfter.toFixed(2) + ')')
    // the two microphones hear different things
    assert.ok(stereoCorrelation(run(rotary, synthVoice(sr, 2, { seed: 9 }), { speed: 'fast' })) < 0.95)
  })

  test('envelope filter: brighter when louder, darker when the direction is down', () => {
    const sr = 48000
    const n = noiseBuf(sr, 2, 'pink', 4, 1, 1)
    const s = n.ch[0]
    for (let i = 0; i < s.length; i++) s[i] *= i < sr ? 0.02 : 0.3
    const up = run(autowah, n, {})
    const cq = spectralCentroid(slice(up.ch[0], sr, 0.3, 0.95), sr)
    const cl = spectralCentroid(slice(up.ch[0], sr, 1.3, 1.95), sr)
    assert.ok(cl > cq * 1.5, 'loud part should be brighter (' + cq.toFixed(0) + ' -> ' + cl.toFixed(0) + ')')
    const dn = run(autowah, n, { direction: 'down' })
    const dq = spectralCentroid(slice(dn.ch[0], sr, 0.3, 0.95), sr)
    const dl = spectralCentroid(slice(dn.ch[0], sr, 1.3, 1.95), sr)
    assert.ok(dl < dq / 1.5, 'down: loud part darker (' + dq.toFixed(0) + ' -> ' + dl.toFixed(0) + ')')
  })

  test('rhythm gate: steps follow the pattern at the tempo', () => {
    const sr = 48000
    const x = sine(sr, 2.1, 440, 0.5)
    const y = run(gate, x, { pattern: 'stutter', tempo: 120, steps: '4', depth: 100, smooth: 2 })
    const step = 60 / 120 / 4
    for (let k = 0; k < 14; k++) {
      const seg = slice(y.ch[0], sr, k * step + 0.015, (k + 1) * step - 0.015)
      const db = rmsDbOf(seg)
      if (k % 2 === 0) assert.ok(db > -12, 'step ' + k + ' should be open: ' + db.toFixed(1))
      else assert.ok(db < -60, 'step ' + k + ' should be closed: ' + db.toFixed(1))
    }
    // half depth leaves the closed steps 6 dB down
    const h = run(gate, x, { pattern: 'stutter', depth: 50, smooth: 2 })
    const o = rmsDbOf(slice(h.ch[0], sr, 0.015, step - 0.015))
    const c = rmsDbOf(slice(h.ch[0], sr, step + 0.015, 2 * step - 0.015))
    assert.ok(Math.abs(o - c - 6.02) < 0.5, 'half depth drop ' + (o - c).toFixed(2))
    // start on the first word: the first open step begins at the sound, not at zero
    const late = { sr, ch: [new Float32Array(Math.round(2 * sr))] }
    late.ch[0].set(sine(sr, 1.4, 440, 0.5).ch[0], Math.round(0.4 * sr))
    const ys = run(gate, late, { pattern: 'offbeat', smooth: 2 })
    // offbeat: steps 0 and 1 closed, step 2 open, counted from about 0.39 s
    assert.ok(rmsDbOf(slice(ys.ch[0], sr, 0.42, 0.62)) < -50, 'first steps after the word start are closed')
    assert.ok(rmsDbOf(slice(ys.ch[0], sr, 0.66, 0.74)) > -12, 'third step is open')
  })

  test('chopper: chops at its rate with a blade envelope; highs dip deeper than lows', () => {
    const sr = 48000
    const x = sine(sr, 3, 1000, 0.5)
    for (const rate of [18, 45]) {
      const y = run(chopper, x, { rate, wobble: 0 })
      const r = modRate(envelope(y.ch[0], sr), 4, 100)
      assert.ok(Math.abs(r / rate - 1) < 0.01, 'chop rate ' + r + ' for ' + rate)
      const yw = run(chopper, x, { rate })
      const rw = modRate(envelope(yw.ch[0], sr), 4, 100)
      assert.ok(Math.abs(rw / rate - 1) < 0.04, 'chop rate with wobble ' + rw + ' for ' + rate)
    }
    const depthDb = (f) => {
      const y = run(chopper, sine(sr, 1.5, f, 0.5), { rate: 12, wobble: 0, colour: 0, blade: 'wide' })
      const env = envelope(slice(y.ch[0], sr, 0.3, 1.4), sr)
      // the envelope of a sine at 1 kHz frames needs a little smoothing for low tones
      const sm = new Float64Array(env.length)
      const w = Math.max(1, Math.round(2000 / f))
      for (let i = 0; i < env.length; i++) {
        let s = 0, c = 0
        for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++) {
          s += env[j]
          c++
        }
        sm[i] = s / c
      }
      let mn = Infinity, mx = 0
      for (const v of sm) {
        mn = Math.min(mn, v)
        mx = Math.max(mx, v)
      }
      return 20 * Math.log10(mx / mn)
    }
    const lowDb = depthDb(150)
    const highDb = depthDb(4000)
    assert.ok(highDb > lowDb + 6, 'diffraction: high dip ' + highDb.toFixed(1) + ' dB vs low ' + lowDb.toFixed(1) + ' dB')
    // nothing chopping: the voice passes untouched
    const v = synthVoice(sr, 1, { seed: 6 })
    const clean = run(chopper, v, { depth: 0, wobble: 0, colour: 0, noise: 0 })
    assert.ok(maxDiff(clean.ch[0], v.ch[0]) < 1e-4, 'depth 0 should pass the voice')
    // spinning up: slow chops at the start, full rate later
    const up = run(chopper, sine(sr, 5, 1000, 0.5), { spin: 'up', rate: 20, wobble: 0 })
    const rEnd = modRate(envelope(slice(up.ch[0], sr, 3.7, 5), sr), 4, 60)
    assert.ok(Math.abs(rEnd - 20) < 1.5, 'spun up to full rate: ' + rEnd)
    const env0 = envelope(slice(up.ch[0], sr, 0, 0.6), sr)
    let crossings = 0
    let m = 0
    for (const e of env0) m += e
    m /= env0.length
    for (let i = 1; i < env0.length; i++) if (env0[i - 1] < m && env0[i] >= m) crossings++
    assert.ok(crossings < 6, 'still slow at the start: ' + crossings + ' chops in 0.6 s')
  })

  test('pass-by pitch: follows the Doppler formula and pans across', () => {
    const sr = 48000
    const x = sine(sr, 4, 1000, 0.5)
    const y = run(doppler, x, { speed: 'race', closest: 6, passes: 'once', direction: 'ltr', fade: 0 })
    assert.equal(y.ch.length, 2)
    assert.equal(y.ch[0].length, x.ch[0].length)
    const m = mono(y)
    const fEarly = zcFreq(slice(m, sr, 0.3, 0.6), sr)
    const fLate = zcFreq(slice(m, sr, 3.4, 3.7), sr)
    // v = 80 m/s, almost head-on far away: 343 / (343 -+ 80)
    assert.ok(Math.abs(fEarly - 1304) < 15, 'approaching pitch ' + fEarly.toFixed(1))
    assert.ok(Math.abs(fLate - 811) < 10, 'receding pitch ' + fLate.toFixed(1))
    assert.ok(rmsDbOf(slice(y.ch[0], sr, 0.3, 0.6)) > rmsDbOf(slice(y.ch[1], sr, 0.3, 0.6)) + 6, 'starts on the left')
    assert.ok(rmsDbOf(slice(y.ch[1], sr, 3.4, 3.7)) > rmsDbOf(slice(y.ch[0], sr, 3.4, 3.7)) + 6, 'ends on the right')
    // distance fade: loudest as it passes. The approach is squeezed in time
    // (that is the Doppler effect), so the sound of the pass at 2 s reaches
    // the output (160 m - 6 m) / 343 m/s = 0.45 s earlier.
    const yf = run(doppler, x, { passes: 'once', fade: 100 })
    const ef = envelope(mono(yf), sr)
    let at = 0
    for (let i = 1; i < ef.length; i++) if (ef[i] > ef[at]) at = i
    assert.ok(Math.abs(at / 1000 - 1.551) < 0.03, 'pass heard at ' + (at / 1000).toFixed(3) + ' s')
    assert.ok(rmsDbOf(slice(mono(yf), sr, 1.5, 1.6)) > rmsDbOf(slice(mono(yf), sr, 0.2, 0.4)) + 15, 'louder up close')
    // every phrase: a swoop inside each phrase of a real-shaped take
    const v = synthVoice(sr, 4, { seed: 8 })
    assertSane(run(doppler, v, { passes: 'phrase', direction: 'alternate' }))
  })

  test('underwater: muffled, wavering and bubbling', () => {
    const sr = 48000
    const v = synthVoice(sr, 3, { seed: 13 })
    const y = run(underwater, v, {})
    // muffled: the band above 2 kHz falls more than 20 dB further than the band below 800 Hz
    const tilt = (b) => bandEnergyDb(b, sr, 2000, 20000) - bandEnergyDb(b, sr, 50, 800)
    assert.ok(tilt(y) < tilt(v) - 20, 'muffled (' + tilt(v).toFixed(1) + ' -> ' + tilt(y).toFixed(1) + ' dB)')
    const deep = run(underwater, v, { depth: 100 })
    assert.ok(spectralCentroid(deep, sr) < spectralCentroid(y, sr) && spectralCentroid(y, sr) < spectralCentroid(v, sr), 'deeper is darker')
    // wobble bends the pitch of a steady tone; none without it
    const tone = sine(sr, 3, 400, 0.4)
    const spread = (b) => {
      let mn = Infinity, mx = 0
      for (let t = 0.3; t < 2.8; t += 0.05) {
        const f = zcFreq(slice(b.ch[0], sr, t, t + 0.05), sr)
        mn = Math.min(mn, f)
        mx = Math.max(mx, f)
      }
      return mx / mn
    }
    assert.ok(spread(run(underwater, tone, { wobble: 100, gurgle: 0, bubbles: 0 })) > 1.004, 'wobble moves the pitch')
    assert.ok(spread(run(underwater, tone, { wobble: 0, gurgle: 0, bubbles: 0 })) < 1.001, 'no wobble, steady pitch')
    // bubbles: talking makes bursts of them; silence makes a few
    const quiet = run(underwater, v, { bubbles: 0 })
    const busy = run(underwater, v, { bubbles: 100 })
    let d = 0
    for (let i = 0; i < quiet.ch[0].length; i++) d += (busy.ch[0][i] - quiet.ch[0][i]) ** 2
    const bubbleDb = 10 * Math.log10(d / quiet.ch[0].length)
    assert.ok(bubbleDb > rmsDb(quiet) - 12, 'bubbles are clearly there (' + bubbleDb.toFixed(1) + ' dB vs voice ' + rmsDb(quiet).toFixed(1) + ')')
    const s = run(underwater, silence(sr, 6), { bubbles: 100 })
    assert.ok(rmsDb(s) > -90 && rmsDb(s) < -30, 'a few bubbles in silence: ' + rmsDb(s).toFixed(1))
  })

  test('keyed: gates, ducks and follows the voice, at the chosen level', () => {
    const sr = 48000
    const n = Math.round(3.5 * sr)
    const voice = new Float32Array(n)
    const burst = sine(sr, 1, 220, 0.3).ch[0]
    voice.set(burst, 0)
    voice.set(burst, Math.round(2.5 * sr))
    const b = { sr, ch: [voice] }
    const base = { source: 'pad', voice: 0, attack: 10, release: 100 }
    const gb = run(keyed, b, { ...base, mode: 'gate' })
    // both channels together: the pad's two sides are detuned, so a mono fold would read 3 dB low
    const win = (buf, a, z) => rmsDb({ ch: buf.ch.map((c) => slice(c, sr, a, z)) })
    const g = mono(gb)
    const on = win(gb, 0.2, 0.9)
    const off = win(gb, 1.7, 2.4)
    assert.ok(off < on - 40, 'gate closes in the pause (' + on.toFixed(1) + ' / ' + off.toFixed(1) + ')')
    assert.ok(rmsDbOf(slice(g, sr, 0.2, 0.9)) > -40)
    // level: the pad sits 6 dB under the voice's speaking loudness (sine RMS -13.5 dB)
    assert.ok(Math.abs(on - (20 * Math.log10(0.3 / Math.SQRT2) - 6)) < 2.5, 'level ' + on.toFixed(1))
    const dk = mono(run(keyed, b, { ...base, mode: 'duck' }))
    assert.ok(rmsDbOf(slice(dk, sr, 0.3, 0.9)) < rmsDbOf(slice(dk, sr, 1.6, 2.4)) - 30, 'duck dips under the voice')
    const two = new Float32Array(n)
    two.set(burst, 0)
    const soft = sine(sr, 1, 220, 0.3 / 4).ch[0]
    two.set(soft, Math.round(2 * sr))
    const fl = mono(run(keyed, { sr, ch: [two] }, { ...base, mode: 'follow', release: 50 }))
    assert.ok(rmsDbOf(slice(fl, sr, 0.3, 0.9)) > rmsDbOf(slice(fl, sr, 2.3, 2.9)) + 6, 'follow swells with the voice')
    // every built-in source plays and is about 0.1 RMS
    for (const s of ['pad', 'rain', 'crowd', 'engine', 'drone']) {
      const src = builtinSource(s, sr, 3, makeRng(1))
      assertSane(src)
      assert.ok(Math.abs(rmsDb(src) + 20) < 2.5, s + ' level ' + rmsDb(src).toFixed(1))
      assert.ok(stereoCorrelation(src) < 0.999 || s === 'engine', s + ' should be stereo')
    }
  })

  test('keyed: uses the other sound, and says so when it is missing', () => {
    const sr = 48000
    const v = synthVoice(sr, 2, { seed: 14 })
    const side = noiseBuf(sr, 2, 'white', 5, 2, 0.2)
    const y = run(keyed, v, { source: 'side', voice: 0, depth: 0 }, 1, { side })
    assert.equal(y.notes.length, 0)
    assert.ok(corr(y.ch[0], side.ch[0]) > 0.999 && corr(y.ch[1], side.ch[1]) > 0.999, 'the output is the other sound')
    // a shorter other sound at another rate is looped and resampled
    const shortSide = noiseBuf(24000, 0.5, 'pink', 6, 1, 0.2)
    assertSane(run(keyed, v, { source: 'side' }, 1, { side: shortSide }))
    const none = run(keyed, v, { source: 'side' })
    assert.equal(none.notes.length, 1)
    assert.match(none.notes[0], /pad/)
    assertSane(none)
  })
})

// ---------------------------------------------------------------- real speech and speed

describe('mod family: real speech and speed', () => {
  const s1 = loadSpeech(0)
  const s2 = loadSpeech(1)
  test('real speech through every module at defaults', { skip: !s1 && 'speech file missing' }, () => {
    for (const mod of ALL) {
      const out = run(mod, s1, {}, 3, { side: s2 })
      const s = assertSane(out)
      assert.ok(s.peak < 4, mod.id + ' speech peak ' + s.peak)
      assert.ok(rmsDb(out) > rmsDb(s1) - 12, mod.id + ' should not swallow the voice: ' + rmsDb(out).toFixed(1))
    }
    // the chopper still chops at its rate on a real voice
    const y = run(chopper, s1, { rate: 20, wobble: 0 })
    const r = modRate(envelope(y.ch[0], s1.sr), 8, 60)
    assert.ok(Math.abs(r - 20) < 0.5, 'chopper on speech ' + r)
  })

  test('speed per second of 48 kHz audio', (t) => {
    const v = synthVoice(48000, 10, { seed: 15 })
    const lines = []
    for (const mod of ALL) {
      run(mod, synthVoice(48000, 0.5, { seed: 1 })) // warm up
      const ms = timeIt(() => run(mod, v), 2) / 10
      lines.push(mod.id + ' ' + ms.toFixed(1) + ' ms/s')
      // generous bounds: the CPU is shared with other builders
      const bound = mod.cost <= 2 ? 80 : 250
      assert.ok(ms < bound, mod.id + ' took ' + ms.toFixed(1) + ' ms per second (bound ' + bound + ')')
      if (mod.live) {
        const p = resolveParams(mod, {})
        const k = mod.live.create(48000, p, makeRng(1))
        const outs = [new Float32Array(128), new Float32Array(128)].slice(0, expectChannels(mod, 1))
        const t = timeIt(() => {
          for (let a = 0; a + 128 <= v.ch[0].length; a += 128) k.process([v.ch[0].subarray(a, a + 128)], outs, 128)
        }, 1) / 10
        assert.ok(t < bound, mod.id + ' live took ' + t.toFixed(1) + ' ms per second')
        lines[lines.length - 1] += ', live ' + t.toFixed(1) + ' ms/s'
      }
    }
    t.diagnostic('mod speeds: ' + lines.join('; '))
  })
})
