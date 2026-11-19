// tools/make_registry.js - builds the generated files of the engine (Node only).
//
// Usage (from api/server/kadeVoiceChanger/engine):
//   node tools/make_registry.js              validate everything, write the generated files
//   node tools/make_registry.js --check      validate everything, write nothing
//   node tools/make_registry.js --only presets/robots.json [more files]
//                                            validate just those preset files against the
//                                            modules and beds on disk, write nothing
//
// It scans modules/**/*.js and beds/*.js (files and folders starting with "_"
// are helpers and are skipped), imports each one, checks it with
// core/params.js validateModuleShape (beds get the same check on their
// params), reads presets/*.json (files starting with "_" are included; the one
// holding an object of voices, places, devices and motions is the Mix and match
// ingredient list), validates every preset with catalog.js, and writes:
//   registry.js           static imports; MODULES, BEDS, getModule, getBed
//   presets.generated.js  export default [every valid hand-made preset], INGREDIENTS
//   manifest.json         { version, files }: version is the first 12 hex digits of a
//                         SHA-256 over every engine file except generated ones and tests
//                         (line endings normalised, so a Windows checkout gives the same version)
//   catalog.json          categories with counts and groups, picker lists, presets, beds
//   modules.json, beds.json
// Every file is written atomically (a temporary file in the same folder, then a
// rename), so several preset authors can run this at the same time and a reader
// never sees half a file. Broken modules and invalid presets are left out of the
// generated files and listed; the exit code is 1 whenever there was a problem.
//
// Other tools import loadEngine() from here to work from the files on disk
// rather than from a possibly stale presets.generated.js.

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { join, relative, resolve, basename, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { validateModuleShape } from '../core/params.js'
import { validatePreset, buildCombos, ingredientProblems, makeCatalog, CATEGORIES, categoryShortName } from '../catalog.js'

export const ENGINE_DIR = fileURLToPath(new URL('../', import.meta.url))

export const GENERATED = new Set(['registry.js', 'presets.generated.js', 'manifest.json', 'catalog.json', 'modules.json', 'beds.json'])

const BED_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function posix(p) {
  return p.split(sep).join('/')
}

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).sort()) {
    if (f.startsWith('_') || f.startsWith('.')) continue
    const p = join(dir, f)
    const st = statSync(p)
    if (st.isDirectory()) walkJs(p, out)
    else if (f.endsWith('.js')) out.push(p)
  }
  return out
}

async function importDefault(file) {
  const url = pathToFileURL(file).href
  const m = await import(url)
  return m && m.default
}

/**
 * Import every module and bed. Returns { modules: [{rel, mod}], beds: [{rel, bed}], problems }.
 * Modules with a bad id, a duplicate id or no process function are left out.
 */
export async function scanEngine(engineDir = ENGINE_DIR) {
  const problems = []
  const modules = []
  const beds = []
  const seen = new Map()
  for (const file of walkJs(join(engineDir, 'modules'))) {
    const rel = posix(relative(engineDir, file))
    let mod
    try {
      mod = await importDefault(file)
    } catch (e) {
      problems.push(rel + ': could not be loaded: ' + (e && e.message ? e.message.split('\n')[0] : String(e)))
      continue
    }
    if (!mod || typeof mod !== 'object') {
      problems.push(rel + ': has no default export.')
      continue
    }
    const shape = validateModuleShape(mod)
    for (const s of shape) problems.push(rel + ': ' + s)
    const parts = rel.split('/')
    const expect = parts.length === 3 ? parts[1] + '.' + parts[2].replace(/\.js$/, '') : null
    if (typeof mod.id !== 'string' || !/^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/.test(mod.id) || typeof mod.process !== 'function') {
      problems.push(rel + ': left out of the registry because its id or process function is unusable.')
      continue
    }
    if (expect && mod.id !== expect) problems.push(rel + ': the id "' + mod.id + '" does not match the file (expected "' + expect + '").')
    if (seen.has(mod.id)) {
      problems.push(rel + ': the id "' + mod.id + '" is already used by ' + seen.get(mod.id) + '; left out.')
      continue
    }
    seen.set(mod.id, rel)
    modules.push({ rel, mod })
  }
  const bedSeen = new Map()
  for (const file of walkJs(join(engineDir, 'beds'))) {
    const rel = posix(relative(engineDir, file))
    if (rel.split('/').length !== 2) continue
    let bed
    try {
      bed = await importDefault(file)
    } catch (e) {
      problems.push(rel + ': could not be loaded: ' + (e && e.message ? e.message.split('\n')[0] : String(e)))
      continue
    }
    const probs = validateBedShape(bed)
    for (const s of probs) problems.push(rel + ': ' + s)
    if (!bed || typeof bed.id !== 'string' || !BED_ID_RE.test(bed.id) || typeof bed.generate !== 'function') {
      problems.push(rel + ': left out of the registry because its id or generate function is unusable.')
      continue
    }
    if (bed.id !== basename(file, '.js')) problems.push(rel + ': the id "' + bed.id + '" does not match the file name.')
    if (bedSeen.has(bed.id)) {
      problems.push(rel + ': the id "' + bed.id + '" is already used by ' + bedSeen.get(bed.id) + '; left out.')
      continue
    }
    bedSeen.set(bed.id, rel)
    beds.push({ rel, bed })
  }
  return { modules, beds, problems }
}

/** CONTRACT section 6 shape check for a bed, reusing the module param checks. */
export function validateBedShape(bed) {
  if (!bed || typeof bed !== 'object') return ['the file has no default export object.']
  const out = []
  if (typeof bed.id !== 'string' || !BED_ID_RE.test(bed.id)) out.push('the bed id must be lowercase words joined by hyphens, not ' + JSON.stringify(bed.id) + '.')
  if (typeof bed.group !== 'string' || !bed.group.trim()) out.push('the group is missing.')
  if (typeof bed.generate !== 'function') out.push('generate must be a function.')
  // the module checker covers name, about, params and the brand list
  const fake = { id: 'bed.' + (typeof bed.id === 'string' ? bed.id : 'x'), family: 'bed', name: bed.name, about: bed.about, params: bed.params, stereo: 'make', cost: 1, process() {} }
  for (const s of validateModuleShape(fake)) out.push(s.replace(/^bed\.[^:]*: /, ''))
  return out
}

/**
 * Read presets/*.json. Returns { files: [{rel, presets}], ingredients, ingredientsFile, problems }.
 * Each preset gets a non-enumerable _file naming its file.
 */
export function readPresetFiles(engineDir = ENGINE_DIR) {
  const dir = join(engineDir, 'presets')
  const problems = []
  const files = []
  let ingredients = null
  let ingredientsFile = null
  if (!existsSync(dir)) return { files, ingredients, ingredientsFile, problems }
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue
    const rel = 'presets/' + f
    let data
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^﻿/, ''))
    } catch (e) {
      problems.push(rel + ': is not valid JSON: ' + (e && e.message ? e.message : String(e)))
      continue
    }
    if (Array.isArray(data)) {
      for (const p of data) if (p && typeof p === 'object') Object.defineProperty(p, '_file', { value: rel, enumerable: false })
      files.push({ rel, presets: data })
    } else if (data && typeof data === 'object' && (Array.isArray(data.voices) || Array.isArray(data.places))) {
      if (ingredients) problems.push(rel + ': a second Mix and match ingredient file; only ' + ingredientsFile + ' is used.')
      else {
        ingredients = data
        ingredientsFile = rel
      }
    } else problems.push(rel + ': must hold a list of presets.')
  }
  return { files, ingredients, ingredientsFile, problems }
}

function lookups(scan) {
  const modById = new Map(scan.modules.map((x) => [x.mod.id, x.mod]))
  const bedById = new Map(scan.beds.map((x) => [x.bed.id, x.bed]))
  return { modById, bedById, getModule: (id) => modById.get(id) || null, getBed: (id) => bedById.get(id) || null }
}

/**
 * Validate presets and combos. Returns { valid: [hand presets], combos, problems }.
 * onlyFiles (a Set of 'presets/x.json') limits which files' problems are reported.
 */
export function checkPresets(scan, read, onlyFiles = null) {
  const { getModule, getBed } = lookups(scan)
  const problems = []
  const wanted = (rel) => !onlyFiles || onlyFiles.has(rel)
  const valid = []
  const ids = new Map()
  const names = new Map()
  for (const { rel, presets } of read.files) {
    presets.forEach((p, i) => {
      const own = validatePreset(p, { getModule, getBed })
      const where = rel + ' #' + (i + 1)
      if (p && typeof p.id === 'string') {
        if (ids.has(p.id)) own.push('Preset "' + p.id + '": the id is also used in ' + ids.get(p.id) + '.')
        else ids.set(p.id, where)
      }
      if (p && typeof p.name === 'string' && typeof p.cat === 'string') {
        const k = p.cat + '\u0000' + p.name.trim().toLowerCase()
        if (names.has(k)) own.push('Preset "' + p.id + '": the name "' + p.name + '" is also used by ' + names.get(k) + ' in ' + categoryShortName(p.cat) + '.')
        else names.set(k, '"' + p.id + '"')
      }
      if (own.length) {
        if (wanted(rel)) for (const s of own) problems.push(where + ': ' + s)
      } else valid.push(p)
    })
  }
  let combos = []
  if (read.ingredients) {
    const rel = read.ingredientsFile
    const ip = ingredientProblems(read.ingredients)
    if (wanted(rel)) for (const s of ip) problems.push(rel + ': ' + s)
    const all = buildCombos(read.ingredients)
    const ok = []
    for (const c of all) {
      const own = validatePreset(c, { getModule, getBed, mix: true, checkDefaults: false })
      if (ids.has(c.id)) own.push('Preset "' + c.id + '": the id is also used in ' + ids.get(c.id) + '.')
      else ids.set(c.id, rel)
      if (own.length) {
        if (wanted(rel)) for (const s of own) problems.push(rel + ' (Mix and match): ' + s)
      } else ok.push(c)
    }
    combos = ok
  }
  return { valid, combos, problems }
}

// ---------------------------------------------------------------- files and version

function walkAll(dir, base, out = []) {
  for (const f of readdirSync(dir).sort()) {
    if (f.startsWith('.') || f === 'node_modules' || f.endsWith('.tmp')) continue
    const p = join(dir, f)
    const st = statSync(p)
    const rel = posix(relative(base, p))
    if (st.isDirectory()) {
      if (rel === 'test') continue
      walkAll(p, base, out)
    } else out.push(rel)
  }
  return out
}

const TEXT_EXT = /\.(js|mjs|json|md|txt|css|html)$/i

/** { version, files } for the engine folder. */
export function computeManifest(engineDir = ENGINE_DIR) {
  const all = walkAll(engineDir, engineDir)
  const hashed = all.filter((r) => !GENERATED.has(r))
  const h = createHash('sha256')
  for (const rel of hashed) {
    let buf = readFileSync(join(engineDir, rel))
    if (TEXT_EXT.test(rel)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    h.update(rel + '\u0000')
    h.update(buf)
    h.update('\u0000')
  }
  const files = Array.from(new Set(all.concat([...GENERATED]))).sort()
  return { version: h.digest('hex').slice(0, 12), files }
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const t = Date.now() + ms
    while (Date.now() < t) {
      // spin
    }
  }
}

/** Write a file atomically: a temporary file in the same folder, then a rename. */
export function writeAtomic(file, text) {
  const dir = resolve(file, '..')
  const tmp = join(dir, '.' + basename(file) + '.' + process.pid + '.' + Math.floor(Math.random() * 1e9).toString(36) + '.tmp')
  writeFileSync(tmp, text)
  let lastErr = null
  for (let k = 0; k < 20; k++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      lastErr = e
      if (!e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break
      sleepMs(25 + k * 25)
    }
  }
  try {
    unlinkSync(tmp)
  } catch {
    // already gone
  }
  throw lastErr
}

// ---------------------------------------------------------------- outputs

function jsString(s) {
  return JSON.stringify(s)
}

export function registrySource(scan, version) {
  const lines = []
  lines.push('// registry.js - GENERATED by tools/make_registry.js. Never hand-edit; run the tool again.')
  lines.push('// Every effect module and background bed of this engine version, by stable id.')
  lines.push('')
  scan.modules.forEach((x, i) => lines.push('import m' + i + ' from ' + jsString('./' + x.rel)))
  scan.beds.forEach((x, i) => lines.push('import b' + i + ' from ' + jsString('./' + x.rel)))
  lines.push('')
  lines.push('export const VERSION = ' + jsString(version))
  lines.push('export const MODULES = [' + scan.modules.map((_, i) => 'm' + i).join(', ') + ']')
  lines.push('export const BEDS = [' + scan.beds.map((_, i) => 'b' + i).join(', ') + ']')
  lines.push('')
  lines.push('const MOD_BY_ID = new Map(MODULES.map((m) => [m.id, m]))')
  lines.push('const BED_BY_ID = new Map(BEDS.map((b) => [b.id, b]))')
  lines.push('')
  lines.push('/** The module with this id, or null. */')
  lines.push('export function getModule(id) {')
  lines.push('  return MOD_BY_ID.get(id) || null')
  lines.push('}')
  lines.push('')
  lines.push('/** The background bed with this id, or null. */')
  lines.push('export function getBed(id) {')
  lines.push('  return BED_BY_ID.get(id) || null')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

export function presetsSource(valid, ingredients, version) {
  const lines = []
  lines.push('// presets.generated.js - GENERATED by tools/make_registry.js from presets/*.json. Never hand-edit.')
  lines.push('')
  lines.push('export const VERSION = ' + jsString(version))
  lines.push('export const INGREDIENTS = ' + JSON.stringify(ingredients || null))
  lines.push('')
  lines.push('export default [')
  for (const p of valid) lines.push('  ' + JSON.stringify(p) + ',')
  lines.push(']')
  lines.push('')
  return lines.join('\n')
}

function moduleInfo(m) {
  return {
    id: m.id,
    name: m.name,
    family: m.family,
    about: m.about,
    params: JSON.parse(JSON.stringify(m.params || [])),
    stereo: m.stereo,
    warps: m.warps === true,
    cost: m.cost,
    side: m.side === true,
    surprise: m.surprise !== false,
    live: !!(m.live && typeof m.live.create === 'function'),
  }
}

function bedInfo(b) {
  return { id: b.id, name: b.name, group: b.group, about: b.about, params: JSON.parse(JSON.stringify(b.params || [])) }
}

export function catalogJson(version, hand, ingredients, scan) {
  const { getModule } = lookups(scan)
  const cat = makeCatalog({ presets: hand, ingredients, getModule, moduleList: scan.modules.map((x) => x.mod) })
  const all = cat.presets()
  const categories = CATEGORIES.map((c) => {
    const groups = cat.byCategory(c.id)
    return { id: c.id, name: c.name, count: groups.reduce((a, g) => a + g.count, 0), subs: groups.map((g) => ({ name: g.sub, count: g.count })) }
  })
  return {
    version,
    categories,
    lists: cat.pickerLists(),
    presets: all.map((p) => ({ id: p.id, name: p.name, cat: p.cat, sub: p.sub, about: p.about, tags: p.tags || [], live: !!p.live })),
    beds: scan.beds.map((x) => ({ id: x.bed.id, name: x.bed.name, group: x.bed.group, about: x.bed.about })),
  }
}

/**
 * Everything a Node tool needs, straight from the files on disk:
 * { getModule, getBed, modules, beds, presets (valid hand-made), combos, catalog, problems }.
 */
export async function loadEngine(engineDir = ENGINE_DIR) {
  const scan = await scanEngine(engineDir)
  const read = readPresetFiles(engineDir)
  const checked = checkPresets(scan, read)
  const { getModule, getBed } = lookups(scan)
  const catalog = makeCatalog({ presets: checked.valid, ingredients: read.ingredients, getModule, moduleList: scan.modules.map((x) => x.mod) })
  return {
    getModule,
    getBed,
    modules: scan.modules.map((x) => x.mod),
    beds: scan.beds.map((x) => x.bed),
    moduleFiles: scan.modules,
    bedFiles: scan.beds,
    presets: checked.valid,
    combos: checked.combos,
    ingredients: read.ingredients,
    catalog,
    problems: scan.problems.concat(read.problems, checked.problems),
  }
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const o = { check: false, only: null, quiet: false, dir: ENGINE_DIR }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') o.check = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--dir') o.dir = resolve(argv[++i])
    else if (a === '--only') {
      o.only = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.only.push(argv[++i])
    } else if (a === '--help' || a === '-h') o.help = true
    else if (o.only) o.only.push(a)
    else throw new Error('Unknown option ' + a + '. Use --check, --only <files...>, --dir <engine folder> or --quiet.')
  }
  return o
}

export async function main(argv = process.argv.slice(2)) {
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    console.error(e.message)
    return 2
  }
  if (o.help) {
    console.log('node tools/make_registry.js [--check] [--only presets/file.json ...] [--dir engine-folder] [--quiet]')
    return 0
  }
  const dir = o.dir
  const scan = await scanEngine(dir)
  const read = readPresetFiles(dir)
  let only = null
  if (o.only) {
    only = new Set(
      o.only.map((f) => {
        const abs = resolve(f)
        const relToEngine = posix(relative(dir, abs))
        if (!relToEngine.startsWith('..')) return relToEngine
        return 'presets/' + basename(f)
      })
    )
    for (const f of only) if (!read.files.some((x) => x.rel === f) && read.ingredientsFile !== f) {
      if (!read.problems.some((s) => s.startsWith(f))) read.problems.push(f + ': no such preset file in presets/.')
    }
  }
  const checked = checkPresets(scan, read, only)
  const problems = only
    ? read.problems.filter((s) => [...only].some((f) => s.startsWith(f))).concat(checked.problems)
    : scan.problems.concat(read.problems, checked.problems)
  const summary =
    scan.modules.length + ' effects, ' + scan.beds.length + ' backgrounds, ' + checked.valid.length + ' hand-made presets, ' + checked.combos.length + ' Mix and match presets'
  if (only || o.check) {
    if (problems.length) {
      console.log(problems.length + (problems.length === 1 ? ' problem:' : ' problems:'))
      for (const s of problems) console.log('- ' + s)
    } else if (!o.quiet) console.log('All good: ' + summary + '.')
    return problems.length ? 1 : 0
  }
  const manifest = computeManifest(dir)
  const v = manifest.version
  writeAtomic(join(dir, 'registry.js'), registrySource(scan, v))
  writeAtomic(join(dir, 'presets.generated.js'), presetsSource(checked.valid, read.ingredients, v))
  writeAtomic(join(dir, 'modules.json'), JSON.stringify(scan.modules.map((x) => moduleInfo(x.mod)), null, 1) + '\n')
  writeAtomic(join(dir, 'beds.json'), JSON.stringify(scan.beds.map((x) => bedInfo(x.bed)), null, 1) + '\n')
  writeAtomic(join(dir, 'catalog.json'), JSON.stringify(catalogJson(v, checked.valid, read.ingredients, scan)) + '\n')
  writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  if (!o.quiet) console.log('Engine version ' + v + ': ' + summary + '.')
  if (problems.length) {
    console.log(problems.length + (problems.length === 1 ? ' problem (left out of the generated files):' : ' problems (left out of the generated files):'))
    for (const s of problems) console.log('- ' + s)
  }
  return problems.length ? 1 : 0
}

function isMain() {
  if (!process.argv[1]) return false
  try {
    return resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch {
    return false
  }
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error('make_registry failed: ' + (e && e.stack ? e.stack : String(e)))
      process.exit(2)
    }
  )
}
