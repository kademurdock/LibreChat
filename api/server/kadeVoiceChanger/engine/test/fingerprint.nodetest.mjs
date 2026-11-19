// test/fingerprint.nodetest.mjs - the fingerprint gate (tools/fingerprint.js): its test clip
// (a pause, a noise floor, mouth clicks) and its one definition of a near-duplicate, which
// must give the same answer for a category whether it is run alone or with everything.
//
// Run from api/server/kadeVoiceChanger with Node 24:
//   node --test "engine/test/fingerprint.nodetest.mjs"

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { synthVoice } from './fixtures.mjs'

const ENGINE = fileURLToPath(new URL('../', import.meta.url))
if (!existsSync(join(ENGINE, 'registry.js')) || !existsSync(join(ENGINE, 'presets.generated.js'))) {
  spawnSync(process.execPath, [join(ENGINE, 'tools', 'make_registry.js'), '--quiet'], { encoding: 'utf8' })
}

const FP = await import('../tools/fingerprint.js')
const { renderPreset } = await import('../render.js')
const { sliceBuf } = await import('../core/buf.js')

const { testClip, fingerprint, stepsApart, nearDuplicates, findPause, GATE } = FP

function rmsDb(s, a, b, top) {
  let e = 0
  for (let i = a; i < b; i++) e += s[i] * s[i]
  return 10 * Math.log10(e / Math.max(1, b - a) / (top * top) + 1e-30)
}

function peakOf(s) {
  let m = 0
  for (let i = 0; i < s.length; i++) m = Math.max(m, Math.abs(s[i]))
  return m
}

const take = synthVoice(48000, 4)
const T = testClip(take, 3)
const render = (clip, chain) => fingerprint(renderPreset(clip, { id: 'x', name: 'Test chain', chain }).buf)
const dry = render(T.clip, [])

const TOOLS = {
  trim: [{ m: 'time.trim', p: { longerThan: 400, keepMs: 200 } }],
  declick: [{ m: 'tone.declick', p: { sensitivity: 75 } }],
  deess: [{ m: 'tone.deess', p: { threshold: -34, range: 10 } }],
  deessToo: [{ m: 'tone.deess', p: { threshold: -33, range: 10 } }],
  gate: [{ m: 'tone.gate', p: { reduce: 30, hold: 40, release: 80 } }],
  deeper: [{ m: 'pitch.voice', p: { semitones: -5 } }],
}
const VEC = {}
for (const [k, chain] of Object.entries(TOOLS)) VEC[k] = render(T.clip, chain)

test('the test clip: a pause with speech either side, a quiet noise floor, three mouth clicks, the same every time', () => {
  const { clip, pause, clicks } = T
  const sr = clip.sr
  const s = clip.ch[0]
  assert.equal(s.length, 3 * sr)
  // this voice has no pause of its own, so one is spliced in
  assert.ok(Math.abs(pause[1] - pause[0] - 0.6) < 0.01, 'pause ' + pause)
  assert.ok(pause[0] > 0.8 && pause[1] < 2.2, 'speech either side ' + pause)
  const top = peakOf(s)
  // the pause, away from its clicks, is the noise floor: about 60 dB under the peak
  const quiet = rmsDb(s, Math.round((pause[0] + 0.02) * sr), Math.round((pause[0] + 0.15) * sr), top)
  assert.ok(quiet > -66 && quiet < -56, 'noise floor ' + quiet.toFixed(1) + ' dB')
  assert.ok(rmsDb(s, 0, Math.round(pause[0] * sr), top) > -30, 'speech before the pause')
  assert.equal(clicks.length, 3)
  assert.equal(clicks.filter((t) => t > pause[0] && t < pause[1]).length, 2, 'two clicks in the pause')
  for (const t of clicks.slice(0, 2)) {
    const i = Math.round(t * sr)
    const near = peakOf(s.subarray(i, i + Math.round(0.002 * sr)))
    assert.ok(near > top * 0.04, 'a click is there at ' + t.toFixed(2) + ' s')
  }
  const again = testClip(take, 3)
  assert.deepEqual(again.pause, pause)
  assert.deepEqual(Array.from(again.clip.ch[0]), Array.from(s))
})

test('the test clip is centred on the recording\'s own first pause when it has one', () => {
  const a = synthVoice(48000, 1.6, { seed: 2 })
  const b = synthVoice(48000, 1.6, { seed: 3 })
  const gap = Math.round(0.5 * 48000)
  const ch = new Float32Array(a.ch[0].length + gap + b.ch[0].length)
  ch.set(a.ch[0], 0)
  ch.set(b.ch[0], a.ch[0].length + gap)
  const rec = { sr: 48000, ch: [ch] }
  const p = findPause(rec, 0.3)
  assert.ok(p && Math.abs(p[0] - 1.6) < 0.1 && Math.abs(p[1] - 2.1) < 0.1, 'found ' + p)
  const t = testClip(rec, 3)
  assert.ok(Math.abs((t.pause[0] + t.pause[1]) / 2 - 1.5) < 0.05, 'centred ' + t.pause)
  assert.ok(t.pause[1] - t.pause[0] > 0.4, 'the pause is kept whole ' + t.pause)
})

test('steps: zero for the same sound, the same both ways, and the dry voice is zero steps from itself', () => {
  assert.equal(stepsApart(dry, dry), 0)
  assert.equal(stepsApart(VEC.trim, VEC.gate), stepsApart(VEC.gate, VEC.trim))
  assert.ok(stepsApart(VEC.deeper, dry) > 10, 'five semitones down is a big change: ' + stepsApart(VEC.deeper, dry).toFixed(1))
})

test('pause, click, de-ess and gate tools come apart on the test clip (and click tools would not on plain speech)', () => {
  const ks = ['trim', 'declick', 'deess', 'gate']
  for (const k of ks) assert.ok(stepsApart(VEC[k], dry) > GATE.steps, k + ' changes the clip: ' + stepsApart(VEC[k], dry).toFixed(2))
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      const d = stepsApart(VEC[ks[i]], VEC[ks[j]])
      assert.ok(d > GATE.steps * 1.5, ks[i] + ' and ' + ks[j] + ' are ' + d.toFixed(2) + ' steps apart')
    }
  }
  // the reason the clip carries clicks: on plain speech a click remover does nothing at all
  const plain = sliceBuf(take, 0.1, 2.6)
  const plainDry = render(plain, [])
  assert.ok(stepsApart(render(plain, TOOLS.declick), plainDry) < 0.5)
})

test('one gate definition: a category flags the same pairs, with the same numbers, alone or among everything', () => {
  const rows = (cat, ks) => ks.map((k) => ({ id: k, cat, vec: VEC[k] }))
  const alone = nearDuplicates(rows('a', ['trim', 'declick', 'deess', 'deessToo']), dry)
  const all = nearDuplicates([...rows('a', ['trim', 'declick', 'deess', 'deessToo']), ...rows('b', ['gate', 'deeper', 'trim'])], dry)
  const key = (list) => list.filter((d) => d.a.cat === 'a').map((d) => [d.a.id, d.b.id, d.steps, d.similarity])
  assert.deepEqual(key(all), key(alone))
  // the two de-essers a decibel apart are the near-duplicate; nothing else in the category is
  assert.deepEqual(alone.map((d) => [d.a.id, d.b.id]), [['deess', 'deessToo']])
  // categories are never compared with each other: trim is in both, and only matches within its own
  assert.ok(!all.some((d) => d.a.cat !== d.b.cat))
  // changes are set on every row and do not depend on the company
  const r = { id: 'trim', cat: 'c', vec: VEC.trim }
  nearDuplicates([r], dry)
  assert.equal(r.change, stepsApart(VEC.trim, dry))
})
