// tools/render_cli.js - render one WAV with a preset or a chain file (Node only).
//
// Usage (from api/server/kadeVoiceChanger/engine):
//   node tools/render_cli.js in.wav <preset-id | chain.json> out.wav
//        [--seconds N] [--start N] [--seed N]
//        [--pitch N] [--timbre N] [--speed N] [--amount N] [--width N] [--volume N]
//        [--side other.wav] [--bed-file sound.wav] [--no-cleanup] [--no-loudness] [--bits 16|24|32]
//
// A chain file holds either a list of stages ([{"m": "pitch.voice", "p": {...}}])
// or a whole preset object. Preset ids are looked up in presets/*.json and the
// Mix and match combinations, read straight from disk (tools/make_registry.js
// loadEngine), so a freshly written preset renders before the registry is
// regenerated. The output is a 16-bit WAV (core/wav.js, TPDF dither) unless
// --bits says otherwise, and a plain report is printed.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadEngine } from './make_registry.js'
import { renderPreset, renderPreview } from '../render.js'
import { decodeWav, encodeWav } from '../core/wav.js'

function usage() {
  return 'node tools/render_cli.js in.wav <preset-id | chain.json> out.wav [--seconds N] [--start N] [--seed N] [--pitch N] [--timbre N] [--speed N] [--amount N] [--width N] [--volume N] [--side other.wav] [--bed-file sound.wav] [--no-cleanup] [--no-loudness] [--bits 16|24|32]'
}

export function parseArgs(argv) {
  const pos = []
  const o = { macros: {} }
  const numArg = (i, name) => {
    const v = Number(argv[i])
    if (!Number.isFinite(v)) throw new Error(name + ' needs a number.')
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const k = a.slice(2)
    if (['pitch', 'timbre', 'speed', 'amount', 'width', 'volume'].includes(k)) o.macros[k] = numArg(++i, a)
    else if (k === 'seconds') o.seconds = numArg(++i, a)
    else if (k === 'start') o.start = numArg(++i, a)
    else if (k === 'seed') o.seed = numArg(++i, a)
    else if (k === 'bits') o.bits = numArg(++i, a)
    else if (k === 'side') o.side = argv[++i]
    else if (k === 'bed-file') o.bedFile = argv[++i]
    else if (k === 'no-cleanup') o.cleanup = false
    else if (k === 'no-loudness') o.loudness = null
    else if (k === 'help' || k === 'h') o.help = true
    else throw new Error('Unknown option ' + a + '.')
  }
  if (!o.help && pos.length !== 3) throw new Error('Give an input WAV, a preset id or chain file, and an output WAV.')
  o.input = pos[0]
  o.what = pos[1]
  o.output = pos[2]
  return o
}

function readWav(path) {
  return decodeWav(new Uint8Array(readFileSync(path)))
}

/** The preset for an id or a chain/preset JSON file. */
export function presetFor(what, engine) {
  if (/\.json$/i.test(what)) {
    const data = JSON.parse(readFileSync(resolve(what), 'utf8').replace(/^﻿/, ''))
    if (Array.isArray(data)) return { id: null, name: 'Custom chain', chain: data, seed: 1 }
    if (data && Array.isArray(data.chain)) return data
    throw new Error(what + ' holds neither a chain nor a preset.')
  }
  const p = engine.catalog.getPreset(what)
  if (p) return p
  const near = engine.catalog.search(what.replace(/-/g, ' '), { limit: 5 }).map((x) => x.id)
  throw new Error('There is no preset called "' + what + '".' + (near.length ? ' Close matches: ' + near.join(', ') + '.' : ''))
}

export async function main(argv = process.argv.slice(2)) {
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    console.error(e.message + '\n' + usage())
    return 2
  }
  if (o.help) {
    console.log(usage())
    return 0
  }
  const engine = await loadEngine()
  const preset = presetFor(o.what, engine)
  const take = readWav(o.input)
  const opts = {
    macros: o.macros,
    seed: o.seed,
    cleanup: o.cleanup,
    loudness: o.loudness,
    getModule: engine.getModule,
    getBed: engine.getBed,
  }
  if (o.side) opts.sideAudio = readWav(o.side)
  if (o.bedFile) opts.bedAudio = readWav(o.bedFile)
  let lastPct = -1
  opts.progress = (f) => {
    const pct = Math.floor(f * 10) * 10
    if (pct > lastPct && process.stderr.isTTY) {
      lastPct = pct
      process.stderr.write('\r' + pct + ' percent ')
    }
  }
  const useSlice = o.seconds !== undefined || o.start !== undefined
  const { buf, report } = useSlice
    ? renderPreview(take, preset, { ...opts, start: o.start || 0, seconds: o.seconds !== undefined ? o.seconds : 1e6 })
    : renderPreset(take, preset, opts)
  if (process.stderr.isTTY) process.stderr.write('\r')
  writeFileSync(o.output, encodeWav(buf, o.bits === 24 ? 24 : o.bits === 32 ? 32 : 16))
  const name = preset.name || preset.id || 'Custom chain'
  console.log(name + ': ' + report.seconds.toFixed(2) + ' seconds, ' + (report.channels === 2 ? 'stereo' : 'mono') + ', loudness ' + report.lufs + ' LUFS, true peak ' + report.truePeakDb + ' dBTP, made in ' + Math.round(report.ms) + ' milliseconds.')
  for (const s of report.stages) console.log('  ' + s.m + ': ' + Math.round(s.ms) + ' milliseconds')
  for (const n of report.notes) console.log('  Note: ' + n)
  if (report.fixedNaN) console.log('  ' + report.fixedNaN + ' broken samples were silenced.')
  console.log('Wrote ' + o.output)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase().endsWith('render_cli.js')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(process.env.VC_DEBUG && e && e.stack ? e.stack : e && e.message ? e.message : String(e))
      process.exit(1)
    }
  )
}
