// test/presets.nodetest.mjs - every preset validates and renders.
//
// Presets are read straight from presets/*.json and the Mix and match
// ingredients (tools/make_registry.js loadEngine), so a new preset file is
// checked before the registry is regenerated. Every hand-made preset renders
// 1.5 s of a synthetic voice at 48 kHz: no NaN or Infinity, true peak at or
// under -0.9 dBTP, not silent, and at least as long as the input unless a
// stage warps time. All Mix and match combinations validate; a covering sample
// renders (every voice, place, device and motion at least once).
// VC_ALL_COMBOS=1 renders every combination.
//
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test "engine/test/presets.nodetest.mjs"

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { synthVoice } from './fixtures.mjs'
import { loadEngine, checkPresets, scanEngine, readPresetFiles } from '../tools/make_registry.js'
import { validatePreset } from '../catalog.js'
import { renderPreset } from '../render.js'
import { truePeakDb, lufs } from '../core/loudness.js'

const engine = await loadEngine()
const scan = await scanEngine()
const read = readPresetFiles()
const VOICE = synthVoice(48000, 1.5, { seed: 21 })

test('every preset file reads and every preset validates', () => {
  const checked = checkPresets(scan, read)
  const problems = read.problems.concat(checked.problems)
  assert.deepEqual(problems, [], problems.slice(0, 60).join('\n'))
  let total = 0
  for (const f of read.files) total += f.presets.length
  assert.equal(checked.valid.length, total)
})

function renderCheck(p) {
  const { buf, report } = renderPreset(VOICE, p, { getModule: engine.getModule, getBed: engine.getBed })
  const fails = []
  for (const c of buf.ch) {
    for (let i = 0; i < c.length; i++) {
      if (!Number.isFinite(c[i])) {
        fails.push('sample ' + i + ' is ' + c[i])
        break
      }
    }
  }
  const tp = truePeakDb(buf)
  if (tp > -0.9) fails.push('true peak ' + tp.toFixed(2) + ' dBTP')
  if (!(lufs(buf) > -70)) fails.push('silent')
  const warps = (p.chain || []).some((s) => {
    const m = engine.getModule(s.m)
    return m && m.warps
  })
  if (!warps && buf.ch[0].length < VOICE.ch[0].length - 480) fails.push('shorter than the input: ' + (buf.ch[0].length / 48000).toFixed(3) + ' s')
  if (report.fixedNaN) fails.push(report.fixedNaN + ' broken samples were silenced')
  return fails
}

for (const p of engine.presets) {
  test('preset ' + p.id + ' renders', { timeout: 120000 }, () => {
    const fails = renderCheck(p)
    assert.deepEqual(fails, [], p.id + ': ' + fails.join('; '))
  })
}

function comboSample() {
  const all = engine.combos
  if (process.env.VC_ALL_COMBOS) return all
  const ing = engine.ingredients || {}
  const voices = ing.voices || []
  const others = [...(ing.places || []), ...(ing.devices || []), ...(ing.motions || [])]
  const want = new Set()
  const n = Math.max(voices.length, others.length)
  for (let i = 0; i < n; i++) {
    const v = voices[i % Math.max(1, voices.length)]
    const x = others[i % Math.max(1, others.length)]
    if (v && x) want.add('mix-' + v.id + '-' + x.id)
  }
  return all.filter((p) => want.has(p.id))
}

test('every Mix and match combination validates', () => {
  const problems = []
  for (const c of engine.combos) for (const s of validatePreset(c, { getModule: engine.getModule, getBed: engine.getBed, mix: true, checkDefaults: false })) problems.push(s)
  assert.deepEqual(problems, [], problems.slice(0, 40).join('\n'))
  const ids = new Set(engine.combos.map((c) => c.id))
  assert.equal(ids.size, engine.combos.length)
})

for (const p of comboSample()) {
  test('combo ' + p.id + ' renders', { timeout: 120000 }, () => {
    const fails = renderCheck(p)
    assert.deepEqual(fails, [], p.id + ': ' + fails.join('; '))
  })
}
