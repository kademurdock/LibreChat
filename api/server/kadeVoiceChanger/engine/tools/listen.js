// tools/listen.js - a listening folder: presets rendered on one recording (Node only).
//
// Usage (from api/server/kadeVoiceChanger/engine):
//   node tools/listen.js --out <folder> [--in speech.wav] [--seconds N] [--start N]
//        [--cat <category id>]... [--all] [--no-mix] [--limit N] [preset-id ...]
//
// Pick presets by id, by category (--cat, repeatable), or --all for every preset
// (hand-made and Mix and match; --no-mix leaves the generated ones out). Each one
// is written as "<Category> - <Name>.wav" (16-bit) and index.txt lists them in
// plain words, with what each one is meant to sound like, so a listener with a
// screen reader can flick through the folder and read along. Presets are read
// straight from presets/*.json and the Mix and match ingredients (through
// tools/make_registry.js loadEngine), never from presets.generated.js, so a
// preset author hears a new preset before the registry is regenerated.
// Without --in the first of Kade's Fish listening clips is used when present.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { loadEngine } from './make_registry.js'
import { renderPreview } from '../render.js'
import { decodeWav, encodeWav } from '../core/wav.js'
import { categoryShortName, CATEGORIES } from '../catalog.js'

export const DEFAULT_SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'

/** A file name every system accepts, keeping the spoken words. */
export function safeName(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 150)
}

function usage() {
  return 'node tools/listen.js --out <folder> [--in speech.wav] [--seconds N] [--start N] [--cat <id>]... [--all] [--no-mix] [--limit N] [preset-id ...]'
}

export function parseArgs(argv) {
  const o = { ids: [], cats: [], all: false, mix: true, seconds: 12, start: 0, limit: Infinity }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') o.out = argv[++i]
    else if (a === '--in') o.input = argv[++i]
    else if (a === '--seconds') o.seconds = Number(argv[++i])
    else if (a === '--start') o.start = Number(argv[++i])
    else if (a === '--cat') o.cats.push(argv[++i])
    else if (a === '--all') o.all = true
    else if (a === '--no-mix') o.mix = false
    else if (a === '--limit') o.limit = Number(argv[++i])
    else if (a === '--help' || a === '-h') o.help = true
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a + '.')
    else o.ids.push(a)
  }
  if (!o.help && !o.out) throw new Error('Say where to write the folder with --out.')
  if (!o.help && !o.all && !o.cats.length && !o.ids.length) throw new Error('Name some preset ids, a category with --cat, or use --all.')
  return o
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
  const input = o.input || DEFAULT_SPEECH
  if (!existsSync(input)) {
    console.error('The recording ' + input + ' is not there. Give one with --in.')
    return 2
  }
  for (const c of o.cats) {
    if (!CATEGORIES.some((x) => x.id === c)) {
      console.error('There is no category "' + c + '". The categories are: ' + CATEGORIES.map((x) => x.id).join(', ') + '.')
      return 2
    }
  }
  const engine = await loadEngine()
  const all = engine.catalog.presets()
  let list = []
  const seen = new Set()
  const add = (p) => {
    if (p && !seen.has(p.id)) {
      seen.add(p.id)
      list.push(p)
    }
  }
  for (const id of o.ids) {
    const p = engine.catalog.getPreset(id)
    if (!p) console.error('Skipping "' + id + '": there is no such preset.')
    add(p)
  }
  for (const p of all) {
    if (o.all || o.cats.includes(p.cat)) {
      if (!o.mix && p.generated) continue
      add(p)
    }
  }
  if (Number.isFinite(o.limit)) list = list.slice(0, o.limit)
  const take = decodeWav(new Uint8Array(readFileSync(input)))
  const out = resolve(o.out)
  mkdirSync(out, { recursive: true })
  const lines = []
  lines.push('Listening folder, made ' + new Date().toISOString().slice(0, 10) + '.')
  lines.push('Recording: ' + input + (o.start ? ', from ' + o.start + ' seconds' : '') + ', ' + o.seconds + ' seconds of it.')
  lines.push(list.length + (list.length === 1 ? ' preset.' : ' presets.') + ' Each line: file name, then what it should sound like.')
  lines.push('')
  let failed = 0
  const t0 = Date.now()
  for (const p of list) {
    const file = safeName(categoryShortName(p.cat) + ' - ' + p.name) + '.wav'
    try {
      const { buf, report } = renderPreview(take, p, { start: o.start, seconds: o.seconds, getModule: engine.getModule, getBed: engine.getBed })
      writeFileSync(join(out, file), encodeWav(buf, 16))
      const extra = []
      if (p.live) extra.push('works live')
      if (report.notes.length) extra.push(report.notes.join(' '))
      lines.push(file + ': ' + p.about + ' (id ' + p.id + (extra.length ? '; ' + extra.join('; ') : '') + ')')
    } catch (e) {
      failed++
      lines.push(file + ': NOT MADE, ' + (e && e.message ? e.message : String(e)) + ' (id ' + p.id + ')')
    }
  }
  writeFileSync(join(out, 'index.txt'), lines.join('\r\n') + '\r\n')
  console.log('Wrote ' + (list.length - failed) + ' of ' + list.length + ' presets to ' + out + ' in ' + Math.round((Date.now() - t0) / 1000) + ' seconds.' + (failed ? ' ' + failed + ' failed; see index.txt.' : ''))
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase().endsWith('listen.js')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(e && e.stack ? e.stack : String(e))
      process.exit(1)
    }
  )
}
