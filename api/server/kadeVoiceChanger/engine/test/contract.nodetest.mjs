// test/contract.nodetest.mjs - audit of engine/core against CONTRACT.md section 3.
//
// What it checks, in order:
// 1. The contract itself is the source of truth. Section 3 of CONTRACT.md is
//    parsed at load time: every `core/<file>.js` bullet, every name written
//    as name(args) or as a bare `name`, and the number of positional
//    arguments the contract shows for it. A small hand table below says which
//    of those names are classes, class methods or methods of a returned
//    object (the contract's prose says so, but not in a machine-readable way);
//    a name the table cannot place fails the test, so the table can never
//    silently fall behind the contract.
// 2. Shape: every contract name is exported (or is a method of the exported
//    class, or of makeRng's result) with the right kind. Arity is checked in
//    the only way that is meaningful in JavaScript: the implementation must
//    DECLARE at least the contract's positional parameters (so every contract
//    argument lands in a named slot) and must not REQUIRE more than the
//    contract passes (Function.length, which stops at the first default).
// 3. Source rules from sections 1 and 3: ES modules only, relative imports
//    inside core only, no DOM, Web Audio or Node globals, no Math.random,
//    nothing newer than ES2022, and a comment header on every file.
// 4. Smoke runs at 48 kHz and 22.05 kHz on a 1 second synthetic voice
//    (test/fixtures.mjs synthVoice): every contract function is called the
//    way the contract writes it, and its result is checked for kind, length,
//    finiteness and a coarse sense of being right (an independent ruler from
//    test/measure.mjs judges pitch). Functions the contract calls pure are
//    also checked to leave their input untouched, and Math.random is trapped
//    during every run so a stray call fails the test.
// 5. Speeds of the heavy calls on 10 and 30 second takes, against generous
//    bounds (the contract's cost-5 target of 400 ms per second of 48 kHz
//    audio for the voice and space calls). The test logs nothing; the audit
//    report carries the measured numbers.
// 6. Known contract gaps found by this audit are recorded as todo tests:
//    they run, they do not fail the suite, and they flip to passing once the
//    owning file is fixed.
//
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test "engine/test/*.nodetest.mjs"

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { synthVoice } from './fixtures.mjs'
import { assertSane, medianF0, rmsDb, timeIt, formantShiftSemitones } from './measure.mjs'

const CORE_DIR = fileURLToPath(new URL('../core/', import.meta.url))
const ENGINE_DIR = fileURLToPath(new URL('../', import.meta.url))
const CONTRACT_TEXT = readFileSync(fileURLToPath(new URL('../../CONTRACT.md', import.meta.url)), 'utf8')

// ---------------------------------------------------------------- contract parsing

/** Text of a numbered section ("## 3." up to the next "## "). */
function sectionOf(text, num) {
  const start = text.indexOf('\n## ' + num + '.')
  assert.ok(start >= 0, 'CONTRACT.md has no section ' + num)
  const end = text.indexOf('\n## ', start + 4)
  return text.slice(start, end < 0 ? text.length : end)
}

/**
 * Count the positional arguments of the parenthesised list that opens at
 * src[open] === '('. Commas inside brackets, braces, strings and block
 * comments do not count. Returns { count, close } or { count: null } for '...'.
 */
function countArgs(src, open) {
  let depth = 0
  let commas = 0
  let any = false
  let str = null
  let body = ''
  for (let k = open; k < src.length; k++) {
    const ch = src[k]
    if (str) {
      if (ch === '\\') {
        k++
        continue
      }
      if (ch === str) str = null
      continue
    }
    if (ch === '/' && src[k + 1] === '*') {
      const e = src.indexOf('*/', k + 2)
      k = e < 0 ? src.length : e + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch
      any = true
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      if (depth > 1) any = true
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        if (body.trim() === '...') return { count: null, close: k }
        return { count: any ? commas + 1 : 0, close: k }
      }
      continue
    }
    if (depth === 1) {
      body += ch
      if (ch === ',') commas++
      else if (!/\s/.test(ch)) any = true
    } else if (depth > 1 && !/\s/.test(ch)) any = true
  }
  return { count: -1, close: src.length }
}

/** Contract section 3 as [{ file, items: [{ name, count, cls }] }] in document order. */
function parseSection3(text) {
  const sec = sectionOf(text, 3)
  const bullets = sec.split(/\n- (?=`core\/)/).slice(1)
  const out = []
  for (const b of bullets) {
    const fm = /^`core\/([\w]+\.js)`/.exec(b)
    if (!fm) continue
    const spans = [...b.matchAll(/`([^`]*)`/g)].map((m) => m[1]).slice(1)
    const items = []
    for (const span of spans) {
      const s = span.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(s)) {
        items.push({ name: s, count: null, cls: false })
        continue
      }
      const re = /(class\s+)?([A-Za-z_$][\w$]*)\s*\(/g
      let m
      while ((m = re.exec(span))) {
        const open = m.index + m[0].length - 1
        const { count, close } = countArgs(span, open)
        items.push({ name: m[2], count, cls: !!m[1] })
        re.lastIndex = close + 1
      }
    }
    out.push({ file: fm[1], items })
  }
  return out
}

// Which contract names are classes, class methods or methods of a returned
// object. Everything else the contract names in a core bullet must be a
// module-level function, except the plain words in NOT_API (argument names
// and type names the prose puts in backticks).
const CLASSES = {
  'fft.js': { FFT: ['forward', 'inverse'] },
  'biquad.js': { Biquad: ['set', 'tick', 'run', 'reset'], OnePole: [], SVF: ['tick'] },
  'delay.js': { DelayLine: ['write', 'read', 'readLinear', 'tap', 'clear'] },
  'lfo.js': { LFO: ['next'] },
}
const RETURNS = { 'rng.js': { makeRng: ['next', 'range', 'gauss', 'int', 'pick', 'fork'] } }
const NOT_API = new Set(['spec', 'semitones', 'formant', 'rateFn', 'path', 'Float64Array', 'Float32Array', 'targetFn', 'sig'])

/** Parameters a function or method declares, from its source text. */
function declaredParams(fn) {
  const src = Function.prototype.toString.call(fn)
  if (/^class[\s{]/.test(src)) {
    const k = src.indexOf('constructor(')
    if (k < 0) return 0
    return countArgs(src, k + 'constructor'.length).count
  }
  const open = src.indexOf('(')
  if (open < 0) return 1 // a bare-parameter arrow function: x => ...
  return countArgs(src, open).count
}

function isClass(fn) {
  return typeof fn === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

/** Assert fn accepts every contract positional argument and needs no more. */
function assertArity(fn, count, label) {
  assert.equal(typeof fn, 'function', label + ' is not a function')
  if (count === null || count === undefined) return
  const declared = declaredParams(fn)
  assert.ok(declared >= count, `${label} declares ${declared} parameters; the contract passes ${count}`)
  assert.ok(fn.length <= count, `${label} requires ${fn.length} arguments; the contract passes only ${count}`)
}

const SECTION3 = parseSection3(CONTRACT_TEXT)
const MODS = {}
for (const f of readdirSync(CORE_DIR).filter((x) => x.endsWith('.js')).sort()) {
  MODS[f] = await import(new URL('../core/' + f, import.meta.url))
}

// ---------------------------------------------------------------- helpers

const RATES = [48000, 22050]

function allFinite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
  return true
}

function assertSig(a, len, label) {
  assert.ok(a instanceof Float32Array, label + ' is not a Float32Array')
  if (len !== undefined) assert.equal(a.length, len, label + ' length')
  assert.ok(allFinite(a), label + ' holds a non-finite sample')
}

/** Run fn with Math.random trapped; the engine must never call it. */
function noRandom(fn) {
  const real = Math.random
  let calls = 0
  Math.random = () => {
    calls++
    return real()
  }
  try {
    return fn()
  } finally {
    Math.random = real
    assert.equal(calls, 0, 'Math.random was called ' + calls + ' times; the contract says never')
  }
}

/** fn(sig) must not change sig (the contract's pure functions). */
function untouched(sig, fn, label) {
  const copy = Float32Array.from(sig)
  const r = fn(sig)
  for (let i = 0; i < sig.length; i++) {
    if (!Object.is(sig[i], copy[i])) assert.fail(label + ' changed its input at sample ' + i)
  }
  return r
}

function ratio(y, x, sr) {
  const a = medianF0(y, sr, { minHz: 25, maxHz: 1200 })
  const b = medianF0(x, sr, { minHz: 25, maxHz: 1200 })
  return b > 0 ? a / b : NaN
}

function zeroCrossHz(sig, sr, from) {
  let zc = 0
  for (let i = from + 1; i < sig.length; i++) if (sig[i - 1] < 0 && sig[i] >= 0) zc++
  return zc / ((sig.length - from) / sr)
}

function sineSig(sr, seconds, hz, amp = 0.5) {
  const n = Math.round(sr * seconds)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr)
  return s
}

/** Minimal WAV writer for formats core/wav.js cannot write (32-bit int, 64-bit float). */
function wavBytes(format, bits, sr, chans) {
  const nch = chans.length
  const n = chans[0].length
  const bps = bits / 8
  const dataBytes = n * nch * bps
  const u8 = new Uint8Array(44 + dataBytes)
  const dv = new DataView(u8.buffer)
  const tag = (o, s) => {
    for (let i = 0; i < 4; i++) u8[o + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, format, true)
  dv.setUint16(22, nch, true)
  dv.setUint32(24, sr, true)
  dv.setUint32(28, sr * nch * bps, true)
  dv.setUint16(32, nch * bps, true)
  dv.setUint16(34, bits, true)
  tag(36, 'data')
  dv.setUint32(40, dataBytes, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = chans[c][i]
      if (format === 1) dv.setInt32(o, Math.round(x * 2147483647), true)
      else dv.setFloat64(o, x, true)
      o += bps
    }
  }
  return u8
}

// One synthetic talker per rate (a low and a higher voice), made outside the
// Math.random trap because the fixture is not part of the engine.
const VOICES = {}
for (const sr of RATES) {
  VOICES[sr] = {
    low: synthVoice(sr, 1, { f0: 140, seed: 11 }).ch[0],
    high: synthVoice(sr, 1, { f0: 230, seed: 12 }).ch[0],
  }
}

// ---------------------------------------------------------------- 1 and 2: shape

describe('contract section 3: every name exists with the right shape', () => {
  test("the audit's own parsers count arguments correctly", () => {
    const byName = {}
    for (const { items } of SECTION3) for (const it of items) if (!(it.name in byName)) byName[it.name] = it.count
    const want = { makeBuf: 3, mixInto: 4, trackPitch: 3, spectralProcess: 3, filterChain: 3, burstEnvelope: null, next: 0, range: 2, LFO: 2, Biquad: 5, retuneVoice: 3, pvShift: 4, tanh: null, reset: 0 }
    for (const [k, v] of Object.entries(want)) assert.equal(byName[k], v, 'contract count for ' + k)
    assert.equal(declaredParams(function (a, b = { x: 1, y: [2, 3] }, c = (1, 2)) {}), 3)
    assert.equal(declaredParams(function () {}), 0)
    assert.equal(declaredParams(class { constructor(a, b = 'x,y') {} }), 2)
    assert.equal(declaredParams(class { m() {} }), 0)
    assert.equal(declaredParams({ f(p, { q = 1, r = 2 } = {}) {} }.f), 2)
    assert.throws(() => assertArity(function (a, b, c) {}, 2, 'needs three'))
    assert.throws(() => assertArity(function (a) {}, 2, 'declares one'))
    assertArity(function (a, b = 1, c = 2) {}, 2, 'extra optional parameters are fine')
  })

  test('section 3 parses into the expected files and names', () => {
    const files = SECTION3.map((s) => s.file)
    assert.ok(files.length >= 26, 'only ' + files.length + ' core bullets found in CONTRACT.md section 3')
    for (const f of files) assert.ok(existsSync(join(CORE_DIR, f)), 'core/' + f + ' is in the contract but missing on disk')
    // the hand tables must only name things the contract names
    for (const [f, classes] of Object.entries(CLASSES)) {
      const names = new Set((SECTION3.find((s) => s.file === f) || { items: [] }).items.map((i) => i.name))
      for (const [cls, methods] of Object.entries(classes)) {
        assert.ok(names.has(cls), 'the audit table names class ' + cls + ' that core/' + f + ' does not list in the contract')
        for (const m of methods) assert.ok(names.has(m), 'the audit table names method ' + cls + '.' + m + ' that the contract does not list')
      }
    }
    for (const [f, fns] of Object.entries(RETURNS)) {
      const names = new Set((SECTION3.find((s) => s.file === f) || { items: [] }).items.map((i) => i.name))
      for (const [fn, methods] of Object.entries(fns)) {
        assert.ok(names.has(fn))
        for (const m of methods) assert.ok(names.has(m), 'the audit table names ' + fn + '().' + m + ' that the contract does not list')
      }
    }
  })

  for (const { file, items } of SECTION3) {
    test('core/' + file + ': ' + items.filter((i) => !NOT_API.has(i.name)).map((i) => i.name).join(', '), () => {
      const mod = MODS[file]
      assert.ok(mod, 'core/' + file + ' did not load')
      const classes = CLASSES[file] || {}
      const returns = RETURNS[file] || {}
      let curClass = null
      let curReturn = null
      let checked = 0
      for (const it of items) {
        if (NOT_API.has(it.name)) continue
        if (it.cls || classes[it.name]) {
          assert.ok(classes[it.name], 'the contract calls ' + it.name + ' a class but this audit does not know it')
          const C = mod[it.name]
          assert.ok(isClass(C), 'core/' + file + ' must export class ' + it.name)
          assertArity(C, it.count, it.name + ' constructor')
          curClass = it.name
          curReturn = null
          checked++
          continue
        }
        if (curClass && classes[curClass].includes(it.name)) {
          const m = mod[curClass].prototype[it.name]
          assertArity(m, it.count, curClass + '.' + it.name)
          checked++
          continue
        }
        if (curReturn && returns[curReturn].includes(it.name)) {
          const obj = noRandom(() => mod[curReturn](1))
          assertArity(obj[it.name], it.count, curReturn + '().' + it.name)
          checked++
          continue
        }
        // a module-level function
        const fn = mod[it.name]
        assert.equal(typeof fn, 'function', 'core/' + file + ' must export function ' + it.name)
        assert.ok(!isClass(fn), it.name + ' must be a plain function, not a class')
        assertArity(fn, it.count, it.name)
        curClass = null
        curReturn = returns[it.name] ? it.name : null
        checked++
      }
      assert.ok(checked > 0, 'nothing checked for core/' + file)
    })
  }

  test('the lists the contract spells out in prose', () => {
    const sec = sectionOf(CONTRACT_TEXT, 3)
    for (const t of ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'lowshelf', 'highshelf', 'allpass']) assert.ok(sec.includes(t))
    for (const s of ['sine', 'triangle', 'square', 'saw', 'ramp', 'random', 'smooth']) assert.ok(sec.includes(s))
    for (const w of ['up 3 semitones', '250 milliseconds', '40 percent', 'minus 6 decibels', '1.5 times', 'off']) assert.ok(sec.includes('"' + w + '"'))
    for (const s of ['room', 'hall', 'plate', 'spring', 'pipe', 'box', 'outdoor']) assert.ok(sec.includes("'" + s + "'"))
  })
})

// ---------------------------------------------------------------- 3: source rules

/** Source with comments and string contents removed (template text kept out too). */
function codeOnly(src) {
  let out = ''
  let str = null
  for (let k = 0; k < src.length; k++) {
    const ch = src[k]
    if (str) {
      if (ch === '\\') {
        k++
        continue
      }
      if (ch === str) {
        str = null
        out += ch
      }
      continue
    }
    if (ch === '/' && src[k + 1] === '/') {
      const e = src.indexOf('\n', k)
      k = e < 0 ? src.length : e - 1
      continue
    }
    if (ch === '/' && src[k + 1] === '*') {
      const e = src.indexOf('*/', k + 2)
      k = e < 0 ? src.length : e + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch
      out += ch
      continue
    }
    out += ch
  }
  return out
}

describe('contract sections 1 and 3: source rules for core/', () => {
  const files = readdirSync(CORE_DIR).filter((x) => x.endsWith('.js')).sort()

  test('package.json makes everything an ES module', () => {
    const pkg = JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf8'))
    assert.equal(pkg.type, 'module')
  })

  test('every core file loads, starts with a comment header and imports only core siblings', () => {
    for (const f of files) {
      assert.ok(MODS[f], f + ' did not load')
      const src = readFileSync(join(CORE_DIR, f), 'utf8')
      assert.ok(/^\s*(\/\/|\/\*)/.test(src), f + ' has no comment header')
      assert.ok(!src.startsWith('#!'), f + ' starts with a hashbang (ES2023)')
      for (const m of src.matchAll(/^\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1]
        assert.ok(spec.startsWith('./'), f + ' imports "' + spec + '"; core may only import its own siblings')
        assert.ok(existsSync(join(CORE_DIR, spec.slice(2))), f + ' imports missing file ' + spec)
      }
    }
  })

  test('no DOM, Web Audio, Node globals, CommonJS, Math.random, eval or post-ES2022 features', () => {
    const rules = [
      [/(?<![.\w$])(window|document|navigator|localStorage|sessionStorage|process|Buffer)\s*\./, 'a browser or Node global'],
      [/\bnew\s+(AudioContext|OfflineAudioContext|AudioWorkletNode|AudioBuffer|MediaRecorder|Worker|XMLHttpRequest)\b/, 'a Web Audio or browser object'],
      [/(?<![.\w$])(require|fetch|setTimeout|setInterval|requestAnimationFrame|importScripts|eval)\s*\(/, 'a host function'],
      [/\bnew\s+Function\b/, 'new Function'],
      [/(?<![.\w$])(__dirname|__filename)(?![\w$])/, 'a Node global'],
      [/\bmodule\.exports\b|(?<![.\w$])exports\./, 'CommonJS'],
      [/\bMath\.random\b/, 'Math.random'],
      [/\bperformance\s*\.\s*now\b|\bDate\.now\b/, 'wall-clock time (core is pure)'],
      [/\.(findLast|findLastIndex|toSorted|toReversed|toSpliced|isWellFormed|toWellFormed|union|intersection|symmetricDifference|transferToFixedLength)\s*\(/, 'an ES2023+ method'],
      [/\b(Object|Map)\.groupBy\b|\bPromise\.withResolvers\b|\bArray\.fromAsync\b|\bFloat16Array\b|\bIterator\.from\b|\bRegExp\.escape\b|\bMath\.sumPrecise\b|\bError\.isError\b|\bAtomics\.waitAsync\b|\bstructuredClone\b/, 'an ES2023+ or host built-in'],
      [/(?<![\w$])using\s+[A-Za-z_$][\w$]*\s*=/, 'an explicit resource declaration'],
    ]
    const problems = []
    for (const f of files) {
      const code = codeOnly(readFileSync(join(CORE_DIR, f), 'utf8'))
      const lines = code.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const [re, what] of rules) if (re.test(lines[i])) problems.push(f + ':' + (i + 1) + ' uses ' + what + ': ' + lines[i].trim())
      }
    }
    assert.deepEqual(problems, [])
  })
})

// ---------------------------------------------------------------- 4: smoke runs

for (const sr of RATES) {
  const V = VOICES[sr]
  const n = V.low.length
  const kHz = (sr / 1000).toFixed(sr % 1000 ? 2 : 0) + ' kHz'

  describe('smoke at ' + kHz + ' on a 1 s synthetic voice', () => {
    test('core/buf.js', () => noRandom(() => {
      const B = MODS['buf.js']
      const mb = B.makeBuf(sr, 2, sr)
      assert.equal(mb.sr, sr)
      assert.equal(mb.ch.length, 2)
      assert.equal(mb.ch[0].length, sr)
      assert.equal(B.makeBuf(sr).ch.length, 1)
      const st = { sr, ch: [Float32Array.from(V.low), Float32Array.from(V.high)] }
      const cl = untouched(st.ch[0], () => B.cloneBuf(st), 'cloneBuf')
      cl.ch[0][5] += 1
      assert.notEqual(cl.ch[0][5], st.ch[0][5], 'cloneBuf must deep copy')
      assert.equal(B.bufLen(st), n)
      const mo = untouched(st.ch[0], () => B.toMono(st), 'toMono')
      assert.equal(mo.ch.length, 1)
      assertSig(mo.ch[0], n, 'toMono')
      assert.ok(Math.abs(mo.ch[0][1234] - 0.5 * (st.ch[0][1234] + st.ch[1][1234])) < 1e-6)
      const ster = B.toStereo({ sr, ch: [V.low] })
      assert.equal(ster.ch.length, 2)
      assert.deepEqual(ster.ch[0], ster.ch[1])
      const sl = untouched(st.ch[0], () => B.sliceBuf(st, 0.25, 0.75), 'sliceBuf')
      assert.equal(B.bufLen(sl), Math.round(0.75 * sr) - Math.round(0.25 * sr))
      const pd = untouched(st.ch[0], () => B.padBuf(st, 0.5), 'padBuf')
      assert.equal(B.bufLen(pd), n + Math.round(0.5 * sr))
      assert.equal(pd.ch[1][pd.ch[1].length - 1], 0)
      const dst = { sr, ch: [new Float32Array(n)] }
      // the contract does not give offset's unit; buf.js documents samples
      B.mixInto(dst, { sr, ch: [V.low] }, 0.5, 10)
      assert.ok(Math.abs(dst.ch[0][110] - 0.5 * V.low[100]) < 1e-7)
      assert.equal(dst.ch[0][5], 0)
      const pk = B.peak(st)
      const rm = B.rms(st)
      assert.ok(pk > 0 && pk <= 1.5 && rm > 0 && rm <= pk)
      assert.ok(Math.abs(B.dbToGain(-6) - 0.501187) < 1e-5)
      assert.ok(Math.abs(B.gainToDb(0.5) + 6.0206) < 1e-3)
      assert.ok(Number.isFinite(B.gainToDb(0)), 'gainToDb(0) must stay finite')
      const dirty = { sr, ch: [Float32Array.from(V.low)] }
      dirty.ch[0][3] = NaN
      dirty.ch[0][4] = Infinity
      dirty.ch[0][5] = -Infinity
      assert.equal(B.sanitize(dirty), 3)
      assertSig(dirty.ch[0], n, 'sanitize')
      const fd = B.fade({ sr, ch: [new Float32Array(n).fill(1)] }, 0.1, 0.1)
      assert.ok(fd.ch[0][0] < 0.01 && fd.ch[0][n - 1] < 0.01 && fd.ch[0][n >> 1] === 1)
      const mc = untouched(st.ch[0], () => B.mapChannels(st, (x) => x.map((v) => v * 0.5)), 'mapChannels')
      assert.equal(mc.ch.length, 2)
      assertSig(mc.ch[1], n, 'mapChannels')
    }))

    test('core/rng.js', () => noRandom(() => {
      const { makeRng } = MODS['rng.js']
      const a = makeRng('stage-1')
      const b = makeRng('stage-1')
      for (let i = 0; i < 1000; i++) {
        const x = a.next()
        assert.ok(x >= 0 && x < 1)
        assert.equal(x, b.next(), 'same seed, same stream')
      }
      assert.notEqual(makeRng(1).next(), makeRng(2).next())
      const r = makeRng(sr)
      let g = 0
      for (let i = 0; i < 4000; i++) {
        const v = r.range(-3, 5)
        assert.ok(v >= -3 && v < 5)
        const k = r.int(7)
        assert.ok(Number.isInteger(k) && k >= 0 && k < 7)
        g += r.gauss()
      }
      assert.ok(Math.abs(g / 4000) < 0.1, 'gauss() mean near 0')
      assert.ok(['x', 'y', 'z'].includes(r.pick(['x', 'y', 'z'])))
      const f1 = makeRng(5).fork('reverb').next()
      const p = makeRng(5)
      p.next()
      p.next()
      assert.equal(p.fork('reverb').next(), f1, 'fork depends only on the seed and the label')
    }))

    test('core/fft.js, core/window.js and core/stft.js', () => noRandom(() => {
      const { FFT, rfft, irfft } = MODS['fft.js']
      for (const N of [16, 1024, 32768]) {
        const f = new FFT(N)
        const re = new Float64Array(N)
        const im = new Float64Array(N)
        for (let i = 0; i < N; i++) re[i] = V.low[i % n]
        const keep = Float64Array.from(re)
        f.forward(re, im)
        f.inverse(re, im)
        let e = 0
        for (let i = 0; i < N; i++) e = Math.max(e, Math.abs(re[i] - keep[i]), Math.abs(im[i]))
        assert.ok(e < 1e-9, 'FFT ' + N + ' round trip error ' + e)
      }
      const f = new FFT(2048)
      const frame = V.low.subarray(4000, 6048)
      const sp = untouched(frame, () => rfft(f, frame), 'rfft')
      assert.equal(sp.re.length, 1025)
      assert.equal(sp.im.length, 1025)
      const back = irfft(f, sp.re, sp.im)
      assertSig(back, 2048, 'irfft')
      for (let i = 0; i < 2048; i++) assert.ok(Math.abs(back[i] - frame[i]) < 1e-5)
      const W = MODS['window.js']
      for (const w of [W.hann(511), W.sqrtHann(512), W.hamming(512), W.blackman(512), W.kaiser(129, 8)]) {
        assert.ok(w.length === 511 || w.length === 512 || w.length === 129)
        assert.ok(allFinite(w) && Math.max(...w) <= 1 + 1e-12 && Math.min(...w) >= -1e-12)
      }
      const S = MODS['stft.js']
      const idt = untouched(V.low, () => S.spectralProcess(V.low, {}, () => {}), 'spectralProcess')
      assertSig(idt, n, 'spectralProcess')
      let e = 0
      for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(idt[i] - V.low[i]))
      assert.ok(e < 1e-5, 'spectralProcess with a do-nothing callback must give the input back, error ' + e)
      let frames = 0
      const lp = S.spectralProcess(V.low, { size: 512, hop: 128, window: 'hann' }, (re, im, fr) => {
        assert.equal(re.length, 257)
        assert.equal(typeof fr, 'number')
        frames++
        for (let k = 64; k < re.length; k++) {
          re[k] = 0
          im[k] = 0
        }
      })
      assert.ok(frames > 0)
      assertSig(lp, n, 'spectralProcess lowpass')
      assert.ok(rmsDb(lp) < rmsDb(V.low))
      const fr = untouched(V.low, () => S.stftFrames(V.low, { size: 1024 }), 'stftFrames')
      assert.ok(Array.isArray(fr) && fr.length > 0 && fr[0].re.length === 513)
      const rs = S.istftFrames(fr, { size: 1024 }, n)
      assertSig(rs, n, 'istftFrames')
      for (let i = 0; i < n; i += 97) assert.ok(Math.abs(rs[i] - V.low[i]) < 1e-5)
    }))

    test('core/biquad.js, core/delay.js and core/lfo.js', () => noRandom(() => {
      const { Biquad, filterChain, OnePole, SVF } = MODS['biquad.js']
      for (const type of ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'lowshelf', 'highshelf', 'allpass']) {
        const bq = new Biquad(type, sr, 1000, 0.707, 6)
        const x = Float32Array.from(V.low)
        bq.run(x)
        assertSig(x, n, type)
        if (type !== 'allpass') assert.ok(x.some((s, i) => s !== V.low[i]), type + ' run filters in place')
        assert.equal(typeof bq.tick(0.1), 'number')
        bq.set(type, 2000, 1.2, -3)
        assert.ok(Number.isFinite(bq.tick(0.2)))
        bq.reset()
        assert.equal(bq.tick(0), 0, type + ' reset clears the state')
      }
      // bandpass is the constant 0 dB peak form
      for (const q of [0.5, 5]) {
        const bp = new Biquad('bandpass', sr, 1000, q)
        const y = bp.run(sineSig(sr, 1, 1000))
        const g = rmsDb(y.subarray(sr >> 1)) - rmsDb(sineSig(sr, 0.5, 1000))
        assert.ok(Math.abs(g) < 0.3, 'bandpass Q ' + q + ' gain at the centre ' + g.toFixed(2) + ' dB')
      }
      const fc = Float32Array.from(V.low)
      filterChain(fc, sr, [{ type: 'highpass', freq: 80 }, { type: 'peak', freq: 2500, q: 1, gain: 4 }])
      assertSig(fc, n, 'filterChain')
      assert.ok(fc.some((s, i) => s !== V.low[i]), 'filterChain works in place')
      const lp = new OnePole(sr, 700, 'lp')
      const hp = new OnePole(sr, 700, 'hp')
      assert.equal(typeof lp.tick, 'function', 'OnePole needs a tick (the contract names no method, but a filter must filter)')
      for (let i = 0; i < 2000; i++) {
        const x = V.low[i]
        const s = lp.tick(x) + hp.tick(x)
        assert.ok(Math.abs(s - x) < 1e-6, 'one-pole lowpass plus highpass gives the input')
      }
      const svf = new SVF(sr)
      for (let i = 0; i < n; i++) {
        const o = svf.tick(V.low[i], 200 + 4800 * (i / n), 0.5 + 4 * (i / n))
        if (i === 0) for (const k of ['lp', 'bp', 'hp', 'notch']) assert.equal(typeof o[k], 'number', 'SVF tick gives ' + k)
        if (!(Number.isFinite(o.lp) && Number.isFinite(o.bp) && Number.isFinite(o.hp) && Number.isFinite(o.notch))) assert.fail('SVF non-finite at ' + i)
      }
      const { DelayLine } = MODS['delay.js']
      const dl = new DelayLine(2000)
      const D = 777
      for (let i = 0; i < 3000; i++) {
        dl.write(V.low[i])
        if (i >= D) assert.equal(dl.read(D), V.low[i - D], 'integer delay must be exact')
        if (i >= D + 2) {
          const fr = dl.read(D + 0.5)
          assert.ok(Number.isFinite(fr) && Math.abs(fr) <= 2)
          assert.equal(dl.tap(D + 0.25), dl.read(D + 0.25))
          assert.ok(Number.isFinite(dl.readLinear(D + 0.3)))
        }
      }
      dl.clear()
      assert.equal(dl.read(10), 0)
      const { LFO } = MODS['lfo.js']
      const rng = MODS['rng.js'].makeRng('lfo-test')
      for (const shape of ['sine', 'triangle', 'square', 'saw', 'ramp', 'random', 'smooth']) {
        const l = new LFO(sr, { shape, rate: 5, phase: 0, rng: rng.fork(shape) })
        let lo = Infinity
        let hi = -Infinity
        for (let i = 0; i < sr; i++) {
          const v = l.next()
          if (!(v >= -1 && v <= 1)) assert.fail(shape + ' LFO left -1..1: ' + v)
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        assert.ok(hi - lo > 0.3, shape + ' LFO barely moves')
      }
      const sine = new LFO(sr, { shape: 'sine', rate: 5 })
      let crossings = 0
      let prev = sine.next()
      for (let i = 1; i < sr; i++) {
        const v = sine.next()
        if (prev < 0 && v >= 0) crossings++
        prev = v
      }
      assert.ok(crossings >= 4 && crossings <= 5, 'a 5 Hz sine LFO crosses upward 4 or 5 times in a second, got ' + crossings)
    }))

    test('core/env.js and core/dyn.js', () => noRandom(() => {
      const { follow, rmsEnv } = MODS['env.js']
      const fo = untouched(V.low, () => follow(V.low, sr, 1, 50), 'follow')
      assertSig(fo, n, 'follow')
      assert.ok(fo.every((v) => v >= 0))
      const re = untouched(V.low, () => rmsEnv(V.low, sr, 20), 'rmsEnv')
      assertSig(re, n, 'rmsEnv')
      const { compress, limitBuf, gate } = MODS['dyn.js']
      const c = Float32Array.from(V.low)
      compress(c, sr, { thresholdDb: -30, ratio: 4, attackMs: 5, releaseMs: 80 })
      assertSig(c, n, 'compress')
      assert.ok(rmsDb(c) < rmsDb(V.low) - 1, 'compress turns a voice above threshold down, in place')
      const loud = { sr, ch: [Float32Array.from(V.low, (v) => v * 6), Float32Array.from(V.low, (v) => v * 3)] }
      limitBuf(loud, { ceilingDb: -1, lookaheadMs: 5, releaseMs: 80 })
      const ceil = Math.pow(10, -1 / 20)
      let link = 0
      for (let i = 0; i < n; i++) {
        assert.ok(Math.abs(loud.ch[0][i]) <= ceil && Math.abs(loud.ch[1][i]) <= ceil, 'limitBuf left a sample over the ceiling at ' + i)
        link = Math.max(link, Math.abs(loud.ch[1][i] - 0.5 * loud.ch[0][i]))
      }
      assert.ok(link < 1e-6, 'limitBuf is channel-linked (same gain on both sides), off by ' + link)
      const tailed = new Float32Array(n + (sr >> 1))
      tailed.set(V.low)
      const nr = MODS['rng.js'].makeRng('gate-noise')
      for (let i = n; i < tailed.length; i++) tailed[i] = (nr.next() * 2 - 1) * 3e-4
      const gt = Float32Array.from(tailed)
      gate(gt, sr, { thresholdDb: -40, attackMs: 1, releaseMs: 100, holdMs: 20 })
      assertSig(gt, tailed.length, 'gate')
      assert.ok(rmsDb(gt.subarray(n + (sr >> 2))) < rmsDb(tailed.subarray(n + (sr >> 2))) - 30, 'gate shuts on quiet noise')
      assert.ok(Math.abs(rmsDb(gt.subarray(sr >> 3, n >> 1)) - rmsDb(tailed.subarray(sr >> 3, n >> 1))) < 1, 'gate leaves the voice alone')
    }))

    test('core/resample.js and core/pitch.js', () => noRandom(() => {
      const { resample, resampleTo, varispeed } = MODS['resample.js']
      for (const r of [0.5, 1.37, 2]) {
        const y = untouched(V.low, () => resample(V.low, r), 'resample')
        assertSig(y, Math.round(n * r), 'resample ' + r)
      }
      for (const to of [8000, 16000, 44100, 48000]) {
        const y = untouched(V.low, () => resampleTo(V.low, sr, to), 'resampleTo')
        assertSig(y, Math.round((n * to) / sr), 'resampleTo ' + to)
      }
      // the contract's own form, a rate function of seconds; sr passed so the clock is right
      const vs = untouched(V.low, () => varispeed(V.low, (t) => (t < 0.5 ? 1 : 2), sr), 'varispeed')
      assertSig(vs, undefined, 'varispeed')
      assert.ok(Math.abs(vs.length - 0.75 * sr) < 0.01 * sr, 'varispeed 1 then 2: ' + vs.length + ' samples')
      const twice = varispeed(V.low, 2, sr)
      assert.ok(Math.abs(twice.length - n / 2) <= 4)
      assert.ok(Math.abs(ratio(twice, V.low, sr) - 2) < 0.06, 'double speed is an octave up')
      const { trackPitch, f0At, noteOf, hzOf } = MODS['pitch.js']
      for (const [v, want] of [[V.low, 140], [V.high, 230]]) {
        const tr = untouched(v, () => trackPitch(v, sr), 'trackPitch')
        assert.equal(tr.hop, Math.round(0.005 * sr))
        assert.ok(tr.f0 instanceof Float32Array && tr.conf instanceof Float32Array)
        assert.equal(tr.f0.length, Math.floor((n - 1) / tr.hop) + 1)
        assert.equal(tr.conf.length, tr.f0.length)
        assert.ok(allFinite(tr.f0) && allFinite(tr.conf))
        assert.ok(tr.conf.every((c) => c >= 0 && c <= 1))
        const voiced = Array.from(tr.f0).filter((h) => h > 0).sort((a, b) => a - b)
        assert.ok(voiced.length > 0.4 * tr.f0.length, 'a talker is mostly voiced, got ' + voiced.length + ' of ' + tr.f0.length)
        const med = voiced[voiced.length >> 1]
        const ruler = medianF0(v, sr)
        assert.ok(Math.abs(med / ruler - 1) < 0.03, 'trackPitch ' + med.toFixed(1) + ' Hz vs ruler ' + ruler.toFixed(1))
        assert.ok(Math.abs(med / want - 1) < 0.1)
        // f0At reads the track at an input sample: frame f is at sample f * hop
        let f = tr.f0.length >> 2
        while (f < tr.f0.length - 1 && !(tr.f0[f] > 0 && tr.f0[f + 1] > 0)) f++
        assert.ok(Math.abs(f0At(tr, f * tr.hop) - tr.f0[f]) < 1e-3, 'f0At at a frame centre is that frame')
        const between = f0At(tr, (f + 0.5) * tr.hop)
        assert.ok(Math.abs(between - 0.5 * (tr.f0[f] + tr.f0[f + 1])) < 1e-3, 'f0At between voiced frames interpolates')
      }
      assert.equal(noteOf(440), 69)
      assert.equal(hzOf(69), 440)
      assert.ok(Math.abs(noteOf(hzOf(60.5)) - 60.5) < 1e-9)
    }))

    test('core/voice.js', () => noRandom(() => {
      const { shiftVoice, retuneVoice } = MODS['voice.js']
      const v = V.low
      const same = untouched(v, () => shiftVoice(v, sr), 'shiftVoice')
      assertSig(same, n, 'shiftVoice with no change')
      const lvl0 = rmsDb(v)
      for (const [st, fm] of [[5, 0], [-5, 0], [0, 3], [5, 3], [-5, 3], [24, 0], [-24, 0], [0, 12], [0, -12]]) {
        const y = untouched(v, () => shiftVoice(v, sr, { semitones: st, formant: fm }), 'shiftVoice')
        assertSig(y, n, `shiftVoice ${st}/${fm}`)
        assertSane({ sr, ch: [y] })
        const r = ratio(y, v, sr) / Math.pow(2, st / 12)
        assert.ok(Math.abs(r - 1) < 0.03, `shiftVoice ${st} st, formant ${fm}: pitch off by ${((r - 1) * 100).toFixed(1)}%`)
        const dl = rmsDb(y) - lvl0
        assert.ok(dl > -6 && dl < 6, `shiftVoice ${st}/${fm} level moved ${dl.toFixed(1)} dB`)
      }
      for (const fm of [3, -3]) {
        const y = shiftVoice(v, sr, { formant: fm })
        const est = formantShiftSemitones(v, y, sr)
        assert.ok(Math.abs(est - fm) < 1, 'timbre ' + fm + ' measured ' + est.toFixed(2))
      }
      const moving = shiftVoice(v, sr, { semitones: (t) => 6 * t, formant: (t) => -4 * t })
      assertSig(moving, n, 'shiftVoice with functions of time')
      const fast = shiftVoice(v, sr, { semitones: 5, quality: 'fast' })
      assertSig(fast, n, "shiftVoice quality 'fast'")
      assert.ok(Math.abs(ratio(fast, v, sr) / Math.pow(2, 5 / 12) - 1) < 0.03)
      const track = MODS['pitch.js'].trackPitch(v, sr)
      const a = shiftVoice(v, sr, { semitones: 3, formant: -2 })
      const b = shiftVoice(v, sr, { semitones: 3, formant: -2, track })
      assert.deepEqual(a, b, 'a precomputed track gives the same result')
      let calls = 0
      let argsOk = true
      const mono = untouched(v, () => retuneVoice(v, sr, {
        targetFn: (t, f0) => {
          calls++
          if (!(t >= 0 && t <= 1.01 && f0 > 0 && f0 < 2000)) argsOk = false
          return 180
        },
      }), 'retuneVoice')
      assert.ok(argsOk, 'targetFn gets (time in seconds, f0 in Hz)')
      assertSig(mono, n, 'retuneVoice')
      assert.ok(calls > 50, 'targetFn called per cycle')
      assert.ok(Math.abs(medianF0(mono, sr) / 180 - 1) < 0.03, 'monotone at 180 Hz')
      const kept = retuneVoice(v, sr, { targetFn: () => 0 })
      assertSig(kept, n, 'retuneVoice keeping pitch')
      assert.ok(Math.abs(ratio(kept, v, sr) - 1) < 0.02, '0 keeps the original pitch')
    }))

    test('core/pv.js and core/envelope.js', () => noRandom(() => {
      const { stretch, pvShift } = MODS['pv.js']
      const v = V.high
      for (const f of [1.5, 0.5, 2]) {
        const y = untouched(v, () => stretch(v, sr, f), 'stretch')
        assertSig(y, Math.round(n * f), 'stretch ' + f)
        assert.ok(Math.abs(ratio(y, v, sr) - 1) < 0.03, 'stretch ' + f + ' keeps the pitch')
      }
      for (const keepFormants of [true, false]) {
        const y = untouched(v, () => pvShift(v, sr, 1.5, { keepFormants }), 'pvShift')
        assertSig(y, n, 'pvShift')
        assert.ok(Math.abs(ratio(y, v, sr) / 1.5 - 1) < 0.03, 'pvShift 1.5 keepFormants ' + keepFormants)
      }
      const { cepstralEnvelope, lpc, lpcEnvelope } = MODS['envelope.js']
      const { FFT, rfft } = MODS['fft.js']
      const N = 2048
      const frame = new Float64Array(N)
      const hw = MODS['window.js'].hann(N)
      for (let i = 0; i < N; i++) frame[i] = v[4000 + i] * hw[i]
      const sp = rfft(new FFT(N), frame)
      const mag = new Float32Array(N / 2 + 1)
      for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(sp.re[k], sp.im[k])
      const env = untouched(mag, () => cepstralEnvelope(mag, Math.round(0.0016 * sr)), 'cepstralEnvelope')
      assertSig(env, mag.length, 'cepstralEnvelope')
      assert.ok(env.every((e) => e > 0))
      const peaks = (a) => {
        let c = 0
        for (let k = 1; k < a.length - 1; k++) if (a[k] > a[k - 1] && a[k] >= a[k + 1]) c++
        return c
      }
      assert.ok(peaks(env) < peaks(mag) / 4, 'the envelope is smooth: ' + peaks(env) + ' peaks against ' + peaks(mag))
      const fr = v.subarray(4000, 4000 + Math.round(0.03 * sr))
      const L = untouched(fr, () => lpc(fr, 16), 'lpc')
      assert.ok(L.a instanceof Float64Array && L.a.length === 17 && L.a[0] === 1)
      assert.ok(Number.isFinite(L.err) && L.err >= 0)
      const le = lpcEnvelope(L.a, L.err, 513)
      assertSig(le, 513, 'lpcEnvelope')
      assert.ok(le.every((e) => e > 0))
    }))

    test('core/ir.js and core/conv.js', () => noRandom(() => {
      const { roomIR, namedIR } = MODS['ir.js']
      const { makeRng } = MODS['rng.js']
      for (const shape of ['room', 'hall', 'plate', 'spring', 'pipe', 'box', 'outdoor']) {
        const ir = roomIR(sr, { shape, decay: 0.8, predelayMs: 5 }, makeRng(shape))
        assert.equal(ir.sr, sr)
        assert.equal(ir.ch.length, 2, shape + ' is stereo')
        assertSane(ir)
        assert.ok(ir.ch[0].length > 0.1 * sr)
      }
      const spec = { shape: 'room', seconds: 0.6, decay: 0.5, size: [4, 5, 3], early: [[10, 0.5, -0.5], [23, 0.3, 0.6]], damping: 0.4, lowCut: 80, highCut: 9000, density: 0.8, modes: [[120, 4, 6]] }
      const r1 = roomIR(sr, spec, makeRng(9))
      const r2 = roomIR(sr, spec, makeRng(9))
      assert.equal(r1.ch[0].length, Math.round(0.6 * sr))
      assert.deepEqual(r1.ch[1], r2.ch[1], 'roomIR is deterministic for a seed')
      assertSane(roomIR(sr, { size: 6, decay: 1, early: 'auto', modes: 'auto' }, makeRng(3)))
      // every named space in section 8, at this rate
      const names = sectionOf(CONTRACT_TEXT, 8).split('\n').slice(2).join(' ').replace(/[.\s]+$/, '').split(',').map((s) => s.trim()).filter(Boolean)
      assert.equal(names.length, 54)
      const rng = makeRng('spaces')
      for (const name of names) {
        const ir = namedIR(name, sr, rng)
        assert.equal(ir.sr, sr, name)
        assert.equal(ir.ch.length, 2, name + ' is stereo')
        assertSane(ir)
      }
      const { convolve, convolveBuf } = MODS['conv.js']
      const cath = namedIR('cathedral', sr, rng)
      const w = untouched(V.low, () => convolve(V.low, cath.ch[0]), 'convolve')
      assertSig(w, n + cath.ch[0].length - 1, 'convolve')
      const tiny = Float32Array.of(0.5, -0.25, 0.125)
      const wt = convolve(V.low, tiny)
      assert.equal(wt.length, n + 2)
      for (const i of [0, 1, 2, 777, n - 1, n + 1]) {
        let s = 0
        for (let j = 0; j < 3; j++) if (i - j >= 0 && i - j < n) s += V.low[i - j] * tiny[j]
        assert.ok(Math.abs(wt[i] - s) < 1e-6)
      }
      const mono = { sr, ch: [V.low] }
      const wet = convolveBuf(mono, cath, 30)
      assert.equal(wet.sr, sr)
      assert.equal(wet.ch.length, 2, 'mono voice through a stereo space is stereo')
      assertSane(wet)
      assert.equal(wet.ch[0].length, n + cath.ch[0].length - 1)
      const dry = convolveBuf(mono, cath, 0)
      for (let i = 0; i < n; i += 101) assert.ok(Math.abs(dry.ch[1][i] - V.low[i]) < 1e-6, 'mix 0 is the dry voice')
      const st = convolveBuf({ sr, ch: [V.low, V.high] }, { sr, ch: [cath.ch[0]] }, 100)
      assert.equal(st.ch.length, 2)
      assertSane(st)
    }))

    test('core/hilbert.js and core/space3d.js', () => noRandom(() => {
      const { freqShift, analytic } = MODS['hilbert.js']
      const fs = untouched(V.low, () => freqShift(V.low, sr, 50), 'freqShift')
      assertSig(fs, n, 'freqShift')
      const tone = sineSig(sr, 1, 1000)
      const settle = Math.round(0.1 * sr)
      const up = zeroCrossHz(freqShift(tone, sr, 150), sr, settle)
      const down = zeroCrossHz(freqShift(tone, sr, -150), sr, settle)
      assert.ok(Math.abs(up - 1150) < 3, 'freqShift +150 Hz of 1 kHz gave ' + up.toFixed(1))
      assert.ok(Math.abs(down - 850) < 3, 'freqShift -150 Hz of 1 kHz gave ' + down.toFixed(1))
      assertSig(freqShift(V.low, sr, (t) => 30 * Math.sin(2 * Math.PI * t)), n, 'freqShift by a function')
      const an = untouched(V.low, () => analytic(V.low), 'analytic')
      assertSig(an.re, n, 'analytic re')
      assertSig(an.im, n, 'analytic im')
      const at = analytic(tone)
      for (let i = settle; i < n; i += 37) {
        const m = Math.hypot(at.re[i], at.im[i])
        assert.ok(Math.abs(m - 0.5) < 0.01, 'analytic magnitude of a 0.5 sine is 0.5, got ' + m)
      }
      const { place } = MODS['space3d.js']
      const right = untouched(V.low, () => place(V.low, sr, (t) => ({ az: 90, el: 0, dist: 1 })), 'place')
      assertSig(right.L, n, 'place L')
      assertSig(right.R, n, 'place R')
      assert.ok(rmsDb(right.R) - rmsDb(right.L) > 4, 'a source at +90 is louder on the right')
      const left = place(V.low, sr, { az: -90, el: 0, dist: 1 })
      assert.ok(rmsDb(left.L) - rmsDb(left.R) > 4, 'a source at -90 is louder on the left')
      const ahead = place(V.low, sr, { az: 0, el: 0, dist: 1 })
      assert.ok(Math.abs(rmsDb(ahead.L) - rmsDb(ahead.R)) < 0.1, 'straight ahead is centred')
      const moving = place(V.low, sr, (t) => ({ az: -180 + 360 * t, el: 30 * Math.sin(6 * t), dist: 0.5 + 3 * t }))
      assertSig(moving.L, n, 'place moving L')
      assertSig(moving.R, n, 'place moving R')
    }))

    test('core/shape.js and core/noise.js', () => noRandom(() => {
      const S = MODS['shape.js']
      const xs = []
      for (let i = 0; i < n; i += 7) xs.push(V.low[i] * 4)
      for (let x = -3; x <= 3; x += 0.01) xs.push(x)
      for (const x of xs) {
        const vals = [S.tanh(x), S.softClip(x, 3), S.hardClip(x, 0.5), S.fold(x, 0.6), S.rectify(x, 1), S.rectify(x, -1), S.tube(x, 0.2),
          S.crush(x, 4), S.muLaw(x), S.muLawInv(S.muLaw(x)), S.aLaw(x), S.aLawInv(S.aLaw(x))]
        if (!vals.every(Number.isFinite)) assert.fail('a shaper gave a non-finite value for ' + x)
        assert.ok(Math.abs(vals[2]) <= 0.5 && Math.abs(vals[3]) <= 0.6 + 1e-12 && vals[4] >= 0 && vals[5] >= 0)
        assert.ok(Math.abs(vals[7] * 8 - Math.round(vals[7] * 8)) < 1e-9, 'crush to 4 bits sits on 1/8 steps')
        const c = Math.max(-1, Math.min(1, x))
        assert.ok(Math.abs(vals[9] - c) < 1e-9 && Math.abs(vals[11] - c) < 1e-9, 'companders invert')
      }
      assert.equal(S.tanh(0), 0)
      assert.ok(Math.abs(S.softClip(1, 2) - 1) < 1e-12)
      assert.ok(Math.abs(S.tube(0, 0.3)) < 1e-12, 'tube removes its bias offset')
      const N = MODS['noise.js']
      const { makeRng } = MODS['rng.js']
      for (const name of ['white', 'pink', 'brown']) {
        const a = N[name](n, makeRng(name))
        assertSig(a, n, name)
        assert.deepEqual(a, N[name](n, makeRng(name)), name + ' is deterministic')
        assert.ok(rmsDb(a) > -30 && rmsDb(a) < 0)
      }
      assert.ok(N.white(n, makeRng(1)).every((x) => x >= -1 && x <= 1))
      const vel = N.velvet(n, sr, 2000, makeRng('v'))
      assertSig(vel, n, 'velvet')
      let pulses = 0
      for (const x of vel) {
        assert.ok(x === 0 || x === 1 || x === -1)
        if (x) pulses++
      }
      assert.ok(Math.abs(pulses - 2000) <= 2, 'velvet at 2000 per second gave ' + pulses)
      const cr = N.crackle(n, sr, 20, makeRng('c'))
      assertSig(cr, n, 'crackle')
      assert.ok(cr.some((x) => x !== 0))
      const be = N.burstEnvelope(n, sr, { rate: 3 }, makeRng('b'))
      assertSig(be, n, 'burstEnvelope')
      assert.ok(be.every((x) => x >= 0 && x <= 1))
    }))

    test('core/segment.js and core/automate.js', () => noRandom(() => {
      const { findPhrases, findSyllables } = MODS['segment.js']
      const gap = Math.round(0.4 * sr)
      const two = new Float32Array(2 * n + gap)
      two.set(V.low)
      two.set(V.high, n + gap)
      const ph = untouched(two, () => findPhrases(two, sr, { minSilenceMs: 180, minPhraseMs: 120 }), 'findPhrases')
      assert.ok(Array.isArray(ph) && ph.length === 2, 'two takes with a 400 ms pause are two phrases, got ' + ph.length)
      for (const p of ph) assert.ok(Number.isInteger(p.start) && Number.isInteger(p.end) && p.start >= 0 && p.end <= two.length && p.end > p.start)
      assert.ok(ph[0].end <= ph[1].start)
      assert.ok(ph[0].end < n + gap / 2 && ph[1].start > n)
      const sy = untouched(V.low, () => findSyllables(V.low, sr), 'findSyllables')
      assert.ok(Array.isArray(sy) && sy.length >= 1)
      for (const s of sy) assert.ok(s.start <= s.peak && s.peak < s.end && s.start >= 0 && s.end <= n)
      const { curve, at } = MODS['automate.js']
      assert.ok(curve(3, n, sr).every((x) => x === 3))
      const lin = curve({ from: 0, to: 1, shape: 'lin' }, n, sr)
      assertSig(lin, n, 'curve lin')
      assert.ok(lin[0] === 0 && Math.abs(lin[n - 1] - 1) < 1e-6)
      for (let i = 1; i < n; i++) if (lin[i] < lin[i - 1]) assert.fail('a lin sweep must rise')
      for (const shape of ['exp', 'sine']) {
        const c = curve({ from: 100, to: 1000, shape }, n, sr)
        assertSig(c, n, 'curve ' + shape)
        assert.ok(Math.abs(c[0] - 100) < 1e-3 && Math.abs(c[n - 1] - 1000) < 1e-2)
      }
      const pts = [[0, 0], [0.5, 1], [1, 0]]
      const pc = curve(pts, n, sr)
      assertSig(pc, n, 'curve points')
      assert.ok(Math.abs(pc[Math.round(0.5 * sr)] - 1) < 1e-3 && Math.abs(pc[Math.round(0.25 * sr)] - 0.5) < 1e-3)
      assert.ok(Math.abs(at(pts, 0.25, 1) - 0.5) < 1e-9)
      assert.ok(Math.abs(at({ from: 0, to: 10 }, 0.5, 1) - 5) < 1e-9)
      assert.equal(at(7, 0.3, 1), 7)
    }))

    test('core/loudness.js, core/wav.js and core/params.js', () => noRandom(() => {
      const { lufs, normalizeLufs, truePeakDb } = MODS['loudness.js']
      const b = { sr, ch: [Float32Array.from(V.low)] }
      const l0 = untouched(b.ch[0], () => lufs(b), 'lufs')
      assert.ok(Number.isFinite(l0) && l0 > -60 && l0 < 0)
      normalizeLufs(b, -20)
      assert.ok(Math.abs(lufs(b) + 20) < 0.1, 'normalizeLufs to -20 (in place) gave ' + lufs(b))
      normalizeLufs(b)
      assert.ok(Math.abs(lufs(b) + 16) < 0.1, 'normalizeLufs defaults to -16')
      const tp = untouched(b.ch[0], () => truePeakDb(b), 'truePeakDb')
      assert.ok(tp >= 20 * Math.log10(MODS['buf.js'].peak(b)) - 1e-6)
      const { encodeWav, decodeWav } = MODS['wav.js']
      const st = { sr, ch: [Float32Array.from(V.low, (x) => 0.8 * x), Float32Array.from(V.high, (x) => 0.8 * x)] }
      for (const [bits, tol] of [[16, 3 / 32768], [24, 2 / 8388608], [8, 3 / 128], [32, 1e-7]]) {
        const u8 = untouched(st.ch[0], () => encodeWav(st, bits), 'encodeWav')
        assert.ok(u8 instanceof Uint8Array)
        assert.equal(String.fromCharCode(u8[0], u8[1], u8[2], u8[3]), 'RIFF')
        const back = decodeWav(u8)
        assert.equal(back.sr, sr)
        assert.equal(back.ch.length, 2)
        for (let c = 0; c < 2; c++) {
          assertSig(back.ch[c], n, 'decodeWav ' + bits)
          let e = 0
          for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(back.ch[c][i] - st.ch[c][i]))
          assert.ok(e <= tol, bits + '-bit round trip error ' + e)
        }
      }
      assert.ok(encodeWav({ sr, ch: [V.low] }).length > 2 * n, 'encodeWav defaults to 16 bits')
      for (const [format, bits, tol] of [[1, 32, 1e-7], [3, 64, 1e-7]]) {
        const back = decodeWav(wavBytes(format, bits, sr, st.ch))
        assert.equal(back.sr, sr)
        for (let i = 0; i < n; i += 13) assert.ok(Math.abs(back.ch[1][i] - st.ch[1][i]) < tol, 'decodeWav format ' + format + ' ' + bits + ' bit')
      }
      const { resolveParams, speakValue } = MODS['params.js']
      const mod = {
        id: 'pitch.voice', name: 'Pitch and timbre', family: 'pitch',
        params: [
          { id: 'semitones', name: 'Pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones' },
          { id: 'formant', name: 'Timbre', type: 'number', min: -12, max: 12, step: 0.5, def: 0, unit: 'semitones' },
          { id: 'mode', name: 'Method', type: 'choice', def: 'auto', options: [{ v: 'auto', name: 'Automatic' }, { v: 'smooth', name: 'Smooth' }] },
          { id: 'keepBreath', name: 'Keep breath', type: 'bool', def: true },
        ],
      }
      assert.deepEqual(resolveParams(mod, {}), { semitones: 0, formant: 0, mode: 'auto', keepBreath: true })
      assert.deepEqual(resolveParams(mod, { semitones: 30, formant: 3.3, mode: 'smooth', keepBreath: false }), { semitones: 24, formant: 3.5, mode: 'smooth', keepBreath: false })
      assert.equal(resolveParams(mod, { mode: 'no such mode' }).mode, 'auto', 'a bad choice falls back to the default')
      assert.equal(resolveParams(mod, { formant: -100 }).formant, -12)
      const cases = [
        [{ id: 'semitones', name: 'Pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones' }, 3, 'up 3 semitones'],
        [{ id: 'time', name: 'Echo time', type: 'number', min: 1, max: 2000, step: 1, def: 250, unit: 'ms' }, 250, '250 milliseconds'],
        [{ id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent' }, 40, '40 percent'],
        [{ id: 'level', name: 'Level', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'db' }, -6, 'minus 6 decibels'],
        [{ id: 'speed', name: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.05, def: 1, unit: 'x' }, 1.5, '1.5 times'],
        [{ id: 'keepBreath', name: 'Keep breath', type: 'bool', def: true }, false, 'off'],
      ]
      for (const [p, v, words] of cases) assert.equal(speakValue(p, v), words)
    }))
  })
}

// ---------------------------------------------------------------- 5: speed

describe('speed of the heavy calls at 48 kHz (generous bounds; numbers go in the audit report)', () => {
  const sr = 48000
  const v10 = synthVoice(sr, 10, { f0: 130, seed: 21 }).ch[0]
  const v30 = synthVoice(sr, 30, { f0: 170, seed: 22 }).ch[0]
  // the contract's cost-5 target is 400 ms per second of 48 kHz mono
  const COST5_10S = 4000

  test('shiftVoice on 10 s: +5, -5, timbre +3, and +5 with timbre +3', () => {
    const { shiftVoice } = MODS['voice.js']
    for (const opts of [{ semitones: 5 }, { semitones: -5 }, { formant: 3 }, { semitones: 5, formant: 3 }]) {
      let y
      const ms = timeIt(() => {
        y = shiftVoice(v10, sr, opts)
      })
      assert.equal(y.length, v10.length)
      assert.ok(ms < COST5_10S, 'shiftVoice ' + JSON.stringify(opts) + ' took ' + ms.toFixed(0) + ' ms for 10 s')
    }
  })

  test('stretch 10 s by 1.5', () => {
    const { stretch } = MODS['pv.js']
    let y
    const ms = timeIt(() => {
      y = stretch(v10, sr, 1.5)
    })
    assert.equal(y.length, Math.round(v10.length * 1.5))
    assert.ok(ms < COST5_10S, 'stretch took ' + ms.toFixed(0) + ' ms for 10 s')
  })

  test("convolve 10 s with namedIR('cathedral')", () => {
    const { namedIR } = MODS['ir.js']
    const { convolve, convolveBuf } = MODS['conv.js']
    const ir = namedIR('cathedral', sr, MODS['rng.js'].makeRng('speed'))
    let y
    const one = timeIt(() => {
      y = convolve(v10, ir.ch[0])
    })
    assert.equal(y.length, v10.length + ir.ch[0].length - 1)
    assert.ok(one < COST5_10S, 'convolve (one side) took ' + one.toFixed(0) + ' ms')
    let b
    const both = timeIt(() => {
      b = convolveBuf({ sr, ch: [v10] }, ir, 35)
    })
    assert.equal(b.ch.length, 2)
    assert.ok(both < COST5_10S, 'convolveBuf (stereo space) took ' + both.toFixed(0) + ' ms')
  })

  test('trackPitch on 30 s', () => {
    const { trackPitch } = MODS['pitch.js']
    let tr
    const ms = timeIt(() => {
      tr = trackPitch(v30, sr)
    })
    assert.ok(tr.f0.length > 5000)
    // the contract's cost 1-2 target is 20 ms per second; allow five times that under a loaded test run
    assert.ok(ms < 3000, 'trackPitch took ' + ms.toFixed(0) + ' ms for 30 s')
  })
})

// ---------------------------------------------------------------- 6: known gaps

// Each gap is a probe that answers true once the contract holds. While a gap
// is open the test is listed as todo (one line, no stack trace, no failure);
// once the owning file is fixed it becomes an ordinary test that asserts the
// probe, so the fix stays guarded.
const GAPS = [
  {
    // CONTRACT section 3 now reads varispeed(sig, rate, sr, opts) "always pass sr".
    name: 'varispeed(sig, rate, sr) reads a rate function in real seconds at 22.05 kHz, and a missing sr falls back without an error',
    open: 'core/resample.js varispeed must read the rate function in seconds of the sr it is given, and must not throw or emit NaN when sr (or sig) is missing',
    holds: () => {
      const { varispeed } = MODS['resample.js']
      const sr = 22050
      const x = VOICES[sr].low
      const y = varispeed(x, (t) => (t < 0.5 ? 1 : 2), sr)
      if (!(Math.abs(y.length - 0.75 * sr) < 0.01 * sr)) return false
      // the documented fallback: no usable sr means 48 kHz seconds, never an error
      for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
        const z = varispeed(x, (t) => (t < 0.5 ? 1 : 2), bad)
        if (!(z instanceof Float32Array) || !allFinite(z) || z.length !== x.length) return false
      }
      const e = varispeed(undefined, 1, sr)
      return e instanceof Float32Array && e.length === 0
    },
  },
  {
    name: 'Biquad.run, Biquad.tick and OnePole.tick read a non-finite sample as silence, like the rest of core',
    open: 'core/biquad.js run() lets one NaN make every later sample of that block NaN (it resets only after the block); tick() and OnePole.tick() never recover',
    holds: () => {
      const { Biquad, OnePole } = MODS['biquad.js']
      const s = sineSig(48000, 0.01, 440)
      s[10] = NaN
      new Biquad('lowpass', 48000, 2000).run(s)
      const b = new Biquad('lowpass', 48000, 2000)
      b.tick(NaN)
      const o = new OnePole(48000, 2000)
      o.tick(NaN)
      return allFinite(s.subarray(11)) && Number.isFinite(b.tick(0)) && Number.isFinite(o.tick(0))
    },
  },
  {
    name: 'rectify stays finite for infinite input',
    open: 'core/shape.js rectify(Infinity, amt) and rectify(-Infinity, amt) return NaN (Infinity minus Infinity)',
    holds: () => {
      const { rectify } = MODS['shape.js']
      for (const x of [Infinity, -Infinity]) for (const amt of [1, 0.5, -1]) if (!Number.isFinite(rectify(x, amt))) return false
      return true
    },
  },
  {
    name: 'freqShift and place never emit NaN, even without a usable sample rate',
    open: 'core/hilbert.js freqShift and core/space3d.js place return NaN when sr is missing or 0; voice.js, pitch.js and pv.js fall back instead',
    holds: () => {
      const s = sineSig(48000, 0.01, 440)
      const H = MODS['hilbert.js']
      const p = MODS['space3d.js'].place(s, undefined, { az: 30, el: 0, dist: 2 })
      return allFinite(H.freqShift(s, undefined, 100)) && allFinite(H.freqShift(s, 0, 100)) && allFinite(p.L) && allFinite(p.R)
    },
  },
]

describe('contract gaps found by the audit (todo while open)', () => {
  for (const g of GAPS) {
    let ok = false
    try {
      ok = g.holds()
    } catch {
      ok = false
    }
    if (ok) test(g.name, () => assert.ok(g.holds()))
    else test(g.name, { todo: g.open })
  }
})
