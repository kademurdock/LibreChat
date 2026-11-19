// catalog.js - the preset catalog: categories, loading, picker lists, search,
// validation, Mix and match combinations and "Surprise me".
//
// Presets come from the GENERATED presets.generated.js (tools/make_registry.js
// writes it from presets/*.json) and the Mix and match combinations are built
// here from the ingredient lists it carries, so their ids are derived from the
// ingredient ids and never drift. Both generated files (that one and
// registry.js) are loaded with a guarded dynamic import: the tools import this
// file to validate presets before anything has been generated, and they use
// makeCatalog() with presets read straight from the JSON files.
//
// Search is a small ranked token search, the inverted-index idea of classic
// information retrieval (Salton and McGill, "Introduction to Modern
// Information Retrieval", 1983) without the index: every word of the query must
// match a word in the preset (exactly, as a prefix, or for longer words inside
// a word), and matches count more in the name than in the tags, group,
// category or about sentence. A trailing plural "s" is forgiven.
//
// Picker lists keep every list a person flicks through at 150 presets or fewer
// (CONTRACT section 9): a bigger category becomes one list per group (sub), and
// a group that is still too big is split into numbered parts.

import { findBlockedWord, resolveValue } from './core/params.js'
import { makeRng, hashString } from './core/rng.js'

let REG = null
let GEN = null
const loadProblems = []
try {
  REG = await import('./registry.js')
} catch (e) {
  loadProblems.push('registry.js could not be loaded: ' + (e && e.message ? e.message : String(e)))
}
try {
  GEN = await import('./presets.generated.js')
} catch (e) {
  loadProblems.push('presets.generated.js could not be loaded: ' + (e && e.message ? e.message : String(e)))
}

/** Problems met while loading the generated files (empty when all is well). */
export function catalogStatus() {
  return loadProblems.slice()
}

// ---------------------------------------------------------------- categories

export const CATEGORIES = [
  { id: 'quick', name: 'Quick picks' },
  { id: 'singing', name: 'Singing and mixing' },
  { id: 'everyday', name: 'Everyday voices' },
  { id: 'disguise', name: 'Disguises' },
  { id: 'robots', name: 'Robots and machines' },
  { id: 'creatures', name: 'Creatures and monsters' },
  { id: 'fantasy', name: 'Fantasy and magic' },
  { id: 'scifi', name: 'Space and sci-fi' },
  { id: 'critters', name: 'Critters and animals' },
  { id: 'comedy', name: 'Cartoon and comedy' },
  { id: 'phones', name: 'Phones and radios' },
  { id: 'retro', name: 'Retro tech and old games' },
  { id: 'places', name: 'Places and rooms' },
  { id: 'nature', name: 'Weather and nature' },
  { id: 'vehicles', name: 'On the move' },
  { id: 'stereo', name: 'Stereo and 3D' },
  { id: 'echo', name: 'Echoes and time tricks' },
  { id: 'music', name: 'Singing and music effects' },
  { id: 'broadcast', name: 'Announcers and broadcast' },
  { id: 'strange', name: 'Strange and experimental' },
  { id: 'spooky', name: 'Spooky and haunted' },
  { id: 'studio', name: 'Studio and cleanup' },
  { id: 'asmr', name: 'ASMR and close-up' },
  { id: 'amps', name: 'Guitar amps and pedals' },
  { id: 'beats', name: 'Rhythm, beats and DJ tricks' },
  { id: 'instruments', name: 'Your voice as an instrument' },
  { id: 'mastering', name: 'Music and mastering (for songs and any audio, not only voices)' },
  { id: 'mix', name: 'Mix and match (generated)' },
]

const CAT_BY_ID = new Map(CATEGORIES.map((c, i) => [c.id, { ...c, order: i }]))

/** The spoken category name without its bracketed note ("Mix and match"). */
export function categoryShortName(id) {
  const c = CAT_BY_ID.get(id)
  return c ? c.name.replace(/\s*\(.*\)\s*$/, '') : String(id)
}

export function categoryName(id) {
  const c = CAT_BY_ID.get(id)
  return c ? c.name : String(id)
}

export const PICKER_LIMIT = 150

// ---------------------------------------------------------------- naming law

// Common first names. A preset name holding one of these probably names a
// person. Names that are also everyday words (Rose, Grace, Will, Robin...) are
// left out on purpose.
const FIRST_NAMES = new Set(
  (
    'james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony ' +
    'donald steven steve paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan ' +
    'jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander ' +
    'patrick raymond dennis tyler aaron jose adam nathan henry douglas zachary peter kyle ethan walter noah ' +
    'jeremy keith roger sean gerald carl harold dylan arthur lawrence jesse bryan bruce gabriel logan albert ' +
    'willie alan eugene russell vincent philip bobby johnny bradley mary patricia jennifer linda elizabeth ' +
    'barbara susan jessica sarah karen lisa nancy betty sandra margaret ashley kimberly emily donna michelle ' +
    'amanda melissa deborah stephanie dorothy rebecca sharon laura cynthia amy kathleen angela shirley brenda ' +
    'emma anna pamela nicole samantha katherine christine helen debra rachel carolyn janet maria catherine ' +
    'heather diane olivia julie joyce kelly christina lauren joan evelyn judith megan andrea cheryl hannah ' +
    'jacqueline martha gloria teresa sara madison frances kathryn janice abigail alice judy sophia denise ' +
    'beverly danielle marilyn diana natalie brittany kayla alexis lori kiana kade elvis oprah britney madonna ' +
    'beyonce shakespeare einstein elmo kermit homer bart garfield snoopy scooby'
  ).split(/\s+/)
)

// Brands, products and characters beyond core/params.js's own list.
const BRAND_WORDS = [
  'chewbacca', 'r2-d2', 'r2d2', 'c-3po', 'c3po', 'gandalf', 'sauron', 'godzilla', 'king kong', 'dracula',
  'frankenstein', 'grinch', 'minion', 'minions', 'autobot', 'decepticon', 'megatron', 'jarvis', 'glados',
  'skynet', 'robocop', 'wall-e', 'tardis', 'jedi', 'sith', 'hogwarts', 'voldemort', 'harry potter', 'hobbit',
  'smeagol', 'ewok', 'wookiee', 'wookie', 'klingon', 'borg', 'xenomorph', 'pokemon', 'zelda', 'kirby', 'luigi',
  'bowser', 'yoshi', 'pac-man', 'pacman', 'tetris', 'playstation', 'xbox', 'sony', 'microsoft', 'google',
  'facetime', 'whatsapp', 'tiktok', 'youtube', 'netflix', 'disney', 'pixar', 'looney tunes', 'bugs bunny',
  'daffy', 'tweety', 'porky', 'muppet', 'muppets', 'sesame street', 'teletubbies', 'casio', 'nokia',
  'motorola', 'polaroid', 'kodak', 'wurlitzer', 'hammond', 'dolby', 'bose', 'jbl', 'shure', 'neumann',
  'ibanez', 'gibson', 'peavey', 'ampeg', 'electro-harmonix', 'big muff', 'tube screamer', 'echoplex',
  'space echo', 'memory man', 'telecaster', 'stratocaster', 'vocaloid', 'zoom call', 'teams call',
  'sims', 'simlish', 'minecraft', 'fortnite', 'roblox', 'barbie', 'lego', 'furby', 'teddy ruxpin', 'tamagotchi',
  'walkman', 'ipod', 'android auto', 'chatgpt', 'kitt', 'knight rider', 'johnny 5', 'bumblebee', 'ultron',
  'thanos', 'hulk', 'superman', 'spider-man', 'spiderman', 'joker', 'scooby-doo', 'chucky', 'freddy',
  'jigsaw', 'pennywise', 'ghostface', 'beetlejuice', 'casper', 'slimer', 'ghostbusters', 'alvin',
]
const BRAND_RE = new RegExp(
  '(^|[^a-z0-9])(' + BRAND_WORDS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=$|[^a-z0-9])',
  'i'
)

/** The first person name, brand or character word found in text, or null. */
export function findBannedWord(text) {
  if (typeof text !== 'string' || !text) return null
  const core = findBlockedWord(text)
  if (core) return core
  const m = BRAND_RE.exec(text)
  if (m) return m[2]
  const words = text.toLowerCase().split(/[^a-z']+/)
  for (const w of words) {
    const base = w.replace(/'s$/, '')
    if (base && FIRST_NAMES.has(base)) return base
  }
  return null
}

const PRESET_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRESET_KEYS = new Set(['id', 'name', 'cat', 'sub', 'about', 'tags', 'chain', 'bed', 'seed', 'side', 'cleanup'])

function asLookup(x, fallback) {
  if (typeof x === 'function') return x
  if (x instanceof Map) return (id) => x.get(id) || null
  if (Array.isArray(x)) {
    const m = new Map(x.map((v) => [v.id, v]))
    return (id) => m.get(id) || null
  }
  if (x && typeof x === 'object') return (id) => x[id] || null
  return fallback
}

const regModule = (id) => (REG && typeof REG.getModule === 'function' ? REG.getModule(id) || null : null)
const regBed = (id) => (REG && typeof REG.getBed === 'function' ? REG.getBed(id) || null : null)

function sameValue(param, v) {
  if (param.type === 'number') return Math.abs(Number(v) - Number(param.def)) < 1e-9
  return v === param.def || String(v) === String(param.def)
}

/** Problems with one stage's or one bed's settings, as plain sentences. */
function paramProblems(owner, p, where, out, checkDefaults) {
  if (p === undefined || p === null) return
  if (typeof p !== 'object' || Array.isArray(p)) {
    out.push(where + ': the settings must be an object of setting names and values.')
    return
  }
  const byId = new Map((owner.params || []).map((x) => [x.id, x]))
  for (const k of Object.keys(p)) {
    const param = byId.get(k)
    if (!param) {
      out.push(where + ': ' + (owner.name || owner.id) + ' has no setting called "' + k + '".')
      continue
    }
    const v = p[k]
    const probs = []
    const r = resolveValue(param, v, probs)
    if (probs.length) {
      for (const s of probs) out.push(where + ': ' + s)
      continue
    }
    if (param.type === 'number') {
      const x = Number(v)
      if (x < param.min || x > param.max) {
        out.push(where + ': "' + param.name + '" is ' + x + ', outside its range of ' + param.min + ' to ' + param.max + '.')
        continue
      }
      if (param.step > 0 && Math.abs(r - x) > 1e-6) {
        out.push(where + ': "' + param.name + '" is ' + x + ', which is not on its step of ' + param.step + '.')
        continue
      }
    }
    if (param.type === 'choice' && v !== r) {
      out.push(where + ': "' + param.name + '" should use the choice value "' + r + '", not "' + v + '".')
      continue
    }
    if (checkDefaults && sameValue(param, r)) {
      out.push(where + ': "' + param.name + '" is set to its default; leave it out.')
    }
  }
}

/** Problems with a preset's name (also used for ingredient names). */
export function nameProblems(name, label = 'The name') {
  const out = []
  if (typeof name !== 'string' || !name.trim()) return [label + ' is missing.']
  const words = name.trim().split(/\s+/)
  if (words.length < 2 || words.length > 6) out.push(label + ' "' + name + '" has ' + words.length + (words.length === 1 ? ' word' : ' words') + '; use 2 to 6.')
  if (name.length > 64) out.push(label + ' "' + name + '" is longer than 64 characters.')
  if (/^[\d\s.,:;'"!?-]+$/.test(name)) out.push(label + ' "' + name + '" is only numbers; say what you will hear.')
  if (name !== name.trim() || /\s{2,}/.test(name)) out.push(label + ' "' + name + '" has extra spaces.')
  const banned = findBannedWord(name)
  if (banned) out.push(label + ' "' + name + '" uses "' + banned + '", which looks like a person, character or brand. Use plain words.')
  return out
}

/**
 * Check one preset. Returns a list of plain problems (empty when it is fine).
 * opts: { getModule | modules, getBed | beds, checkDefaults=true, mix=false }.
 */
export function validatePreset(preset, opts = {}) {
  const out = []
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return ['The preset is not an object.']
  const getModule = asLookup(opts.getModule || opts.modules, regModule)
  const getBed = asLookup(opts.getBed || opts.beds, regBed)
  const checkDefaults = opts.checkDefaults !== false
  const who = typeof preset.id === 'string' && preset.id ? 'Preset "' + preset.id + '"' : 'A preset'
  const say = (s) => out.push(who + ': ' + s)
  for (const k of Object.keys(preset)) if (!PRESET_KEYS.has(k)) say('has an unknown field "' + k + '".')
  if (typeof preset.id !== 'string' || !PRESET_ID_RE.test(preset.id) || preset.id.length > 90) {
    say('the id must be lowercase words joined by hyphens (for example giant-in-a-cave), not ' + JSON.stringify(preset.id) + '.')
  }
  for (const s of nameProblems(preset.name)) say(s.charAt(0).toLowerCase() + s.slice(1))
  if (!CAT_BY_ID.has(preset.cat)) say('the category ' + JSON.stringify(preset.cat) + ' is not one of the 28 categories.')
  else if (preset.cat === 'mix' && !opts.mix) say('the Mix and match category is generated; put this preset in another category.')
  if (typeof preset.sub !== 'string' || !preset.sub.trim()) say('the group (sub) is missing.')
  else {
    if (preset.sub.length > 48) say('the group name "' + preset.sub + '" is longer than 48 characters.')
    const b = findBannedWord(preset.sub)
    if (b) say('the group name uses "' + b + '", which looks like a person, character or brand.')
  }
  if (typeof preset.about !== 'string' || !preset.about.trim()) say('the about sentence is missing.')
  else {
    if (preset.about.length >= 120) say('the about sentence is ' + preset.about.length + ' characters; keep it under 120.')
    if (/[.!?]\s+\S/.test(preset.about.trim())) say('the about text should be one sentence.')
    const b = findBannedWord(preset.about)
    if (b) say('the about sentence uses "' + b + '", which looks like a person, character or brand.')
  }
  if (preset.tags !== undefined) {
    if (!Array.isArray(preset.tags) || preset.tags.some((t) => typeof t !== 'string' || !t.trim())) say('tags must be a list of words.')
    else {
      for (const t of preset.tags) {
        const b = findBannedWord(t)
        if (b) say('the tag "' + t + '" looks like a person, character or brand.')
      }
    }
  }
  if (!Array.isArray(preset.chain) || preset.chain.length < 1 || preset.chain.length > 8) {
    say('the chain must hold 1 to 8 effects.')
  } else {
    preset.chain.forEach((st, i) => {
      const where = 'effect ' + (i + 1)
      if (!st || typeof st !== 'object' || typeof st.m !== 'string') {
        say(where + ' must look like {"m": "family.name", "p": {...}}.')
        return
      }
      for (const k of Object.keys(st)) if (k !== 'm' && k !== 'p') say(where + ' has an unknown field "' + k + '".')
      const mod = getModule(st.m)
      if (!mod) {
        say(where + ' uses "' + st.m + '", which is not an effect that exists.')
        return
      }
      const probs = []
      paramProblems(mod, st.p, where + ' (' + st.m + ')', probs, checkDefaults)
      for (const s of probs) say(s)
    })
  }
  if (preset.bed !== undefined && preset.bed !== null) {
    const bed = preset.bed
    if (typeof bed !== 'object' || Array.isArray(bed)) say('the bed must be an object like {"b": "rain", "level": -20}.')
    else {
      for (const k of Object.keys(bed)) if (!['b', 'file', 'level', 'p', 'duck', 'fade'].includes(k)) say('the bed has an unknown field "' + k + '".')
      if (typeof bed.b === 'string') {
        const g = getBed(bed.b)
        if (!g) say('the background "' + bed.b + '" does not exist.')
        else {
          const probs = []
          paramProblems(g, bed.p, 'the bed (' + bed.b + ')', probs, false)
          for (const s of probs) say(s)
        }
      } else if (typeof bed.file === 'string') {
        if (!PRESET_ID_RE.test(bed.file)) say('the bed file id must be lowercase words joined by hyphens.')
      } else say('the bed needs "b" (a background id) or "file" (a sound-file id).')
      if (bed.level !== undefined && !(typeof bed.level === 'number' && bed.level >= -60 && bed.level <= 6)) say('the bed level must be a number of decibels from -60 to 6.')
      if (bed.duck !== undefined && !(typeof bed.duck === 'boolean' || (typeof bed.duck === 'number' && bed.duck >= 0 && bed.duck <= 40))) say('the bed duck must be true, false, or 0 to 40 decibels.')
      if (bed.fade !== undefined && !(typeof bed.fade === 'number' || typeof bed.fade === 'boolean' || (bed.fade && typeof bed.fade === 'object'))) say('the bed fade must be seconds or {"in": s, "out": s}.')
    }
  }
  if (preset.side !== undefined && !(typeof preset.side === 'string' && PRESET_ID_RE.test(preset.side))) say('the side sound must be a sound-file id (lowercase words joined by hyphens).')
  if (preset.seed !== undefined && !((typeof preset.seed === 'number' && Number.isFinite(preset.seed)) || typeof preset.seed === 'string')) say('the seed must be a number.')
  if (preset.cleanup !== undefined && typeof preset.cleanup !== 'boolean') say('cleanup must be true or false.')
  return out
}

/** Check a whole list: every preset, plus duplicate ids and duplicate names in a category. */
export function validatePresets(list, opts = {}) {
  const out = []
  const ids = new Map()
  const names = new Map()
  for (const p of list || []) {
    for (const s of validatePreset(p, opts)) out.push(s)
    if (!p || typeof p !== 'object') continue
    if (typeof p.id === 'string') {
      if (ids.has(p.id)) out.push('Preset "' + p.id + '": the id is used twice' + (p._file ? ' (' + ids.get(p.id) + ' and ' + p._file + ')' : '') + '.')
      else ids.set(p.id, p._file || '')
    }
    if (typeof p.name === 'string' && typeof p.cat === 'string') {
      const k = p.cat + '\u0000' + p.name.trim().toLowerCase()
      if (names.has(k)) out.push('Preset "' + p.id + '": the name "' + p.name + '" is already used by "' + names.get(k) + '" in ' + categoryShortName(p.cat) + '.')
      else names.set(k, p.id)
    }
  }
  return out
}

// ---------------------------------------------------------------- Mix and match

function capital(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function aboutOf(a, b) {
  let s = capital(String(a || '').trim()) + ' ' + String(b || '').trim()
  s = s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '') + '.'
  if (s.length >= 120) s = s.slice(0, 116).replace(/\s+\S*$/, '') + '...'
  return s
}

/**
 * Mix and match presets from ingredient lists:
 * { voices:[{id,name,say,chain,tags}], places:[...], devices:[...], motions:[...] }.
 * Names: "<voice>, <place>", "<voice> on <device>", "<voice> <motion>".
 * Ids: mix-<voice>-<other> (ingredient ids are unique across all four lists).
 */
export function buildCombos(ing) {
  if (!ing || typeof ing !== 'object') return []
  const voices = Array.isArray(ing.voices) ? ing.voices : []
  const groups = [
    { list: Array.isArray(ing.places) ? ing.places : [], kind: 'place', join: (v, x) => v.name + ', ' + x.name },
    { list: Array.isArray(ing.devices) ? ing.devices : [], kind: 'device', join: (v, x) => v.name + ' on ' + x.name },
    { list: Array.isArray(ing.motions) ? ing.motions : [], kind: 'motion', join: (v, x) => v.name + ' ' + x.name },
  ]
  const out = []
  for (const v of voices) {
    if (!v || typeof v.id !== 'string') continue
    for (const g of groups) {
      for (const x of g.list) {
        if (!x || typeof x.id !== 'string') continue
        const chain = [...(v.chain || []), ...(x.chain || [])].map((s) => ({ m: s.m, p: { ...(s.p || {}) } }))
        if (!chain.length || chain.length > 8) continue
        const tags = []
        for (const t of [...(v.tags || []), ...(x.tags || []), g.kind]) if (!tags.includes(t)) tags.push(t)
        const p = {
          id: 'mix-' + v.id + '-' + x.id,
          name: g.join(v, x),
          cat: 'mix',
          sub: v.name,
          about: aboutOf(v.say || v.name, (g.kind === 'device' ? 'on ' : '') + (x.say || x.name)),
          tags,
          chain,
          seed: hashString('mix-' + v.id + '-' + x.id) % 100000,
        }
        const bed = x.bed || v.bed
        if (bed) p.bed = { ...bed }
        const side = x.side || v.side
        if (side) p.side = side
        out.push(p)
      }
    }
  }
  return out
}

/** Problems with the ingredient lists themselves (ids, names). */
export function ingredientProblems(ing) {
  const out = []
  if (!ing || typeof ing !== 'object') return ['The Mix and match ingredients are missing.']
  const seen = new Map()
  for (const key of ['voices', 'places', 'devices', 'motions']) {
    const list = ing[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      out.push('Mix and match: "' + key + '" must be a list.')
      continue
    }
    list.forEach((x, i) => {
      const where = 'Mix and match ' + key + ' ' + (i + 1)
      if (!x || typeof x.id !== 'string' || !PRESET_ID_RE.test(x.id)) out.push(where + ': the id must be lowercase words joined by hyphens.')
      else if (seen.has(x.id)) out.push(where + ': the id "' + x.id + '" is also used in ' + seen.get(x.id) + '.')
      else seen.set(x.id, key)
      if (!x || typeof x.name !== 'string' || !x.name.trim()) out.push(where + ': the name is missing.')
      else {
        const b = findBannedWord(x.name) || findBannedWord(x.say || '')
        if (b) out.push(where + ': "' + b + '" looks like a person, character or brand.')
      }
      if (!x || !Array.isArray(x.chain) || !x.chain.length) out.push(where + ': the chain is missing.')
    })
  }
  return out
}

// ---------------------------------------------------------------- search

const FIELD_WEIGHTS = { name: 5, tags: 3, sub: 2.5, cat: 2, about: 1 }

function words(text) {
  const s = String(text || '').toLowerCase()
  const parts = s.split(/[^a-z0-9]+/).filter(Boolean)
  // "walkie-talkie" also matches "walkietalkie"
  const joined = s.split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w && !parts.includes(w))
  return parts.concat(joined)
}

function variants(t) {
  const v = [t]
  if (t.length > 3 && t.endsWith('s')) v.push(t.slice(0, -1))
  if (t.length > 4 && t.endsWith('es')) v.push(t.slice(0, -2))
  return v
}

function tokenScore(fieldWords, token) {
  let best = 0
  for (const t of variants(token)) {
    for (const w of fieldWords) {
      let s = 0
      if (w === t) s = 1
      else if (w.startsWith(t)) s = 0.7
      else if (t.length > 3 && w.length > t.length && w.endsWith('s') && w.slice(0, -1) === t) s = 0.95
      else if (t.length >= 4 && w.includes(t)) s = 0.3
      if (s > best) best = s
      if (best === 1) return 1
    }
  }
  return best
}

// ---------------------------------------------------------------- the catalog

/**
 * A catalog over a given preset list. opts: { presets, ingredients, getModule | modules }.
 * The module-level exports below use the generated presets.
 */
export function makeCatalog(opts = {}) {
  const hand = Array.isArray(opts.presets) ? opts.presets : []
  const ingredients = opts.ingredients || null
  const getModule = asLookup(opts.getModule || opts.modules, regModule)
  const moduleList = Array.isArray(opts.moduleList) ? opts.moduleList : REG && Array.isArray(REG.MODULES) ? REG.MODULES : []
  let all = null
  let byId = null
  let index = null

  const liveOf = (chain) => {
    if (!Array.isArray(chain) || !chain.length) return false
    for (const st of chain) {
      const m = st && getModule(st.m)
      if (!m || !m.live || typeof m.live.create !== 'function') return false
    }
    return true
  }

  function load() {
    if (all) return
    const combos = buildCombos(ingredients)
    all = []
    byId = new Map()
    for (const p of hand.concat(combos)) {
      if (!p || typeof p.id !== 'string' || byId.has(p.id)) continue
      const q = { ...p, live: liveOf(p.chain) }
      if (p.cat === 'mix' && combos.includes(p)) q.generated = true
      all.push(q)
      byId.set(q.id, q)
    }
  }

  function presets() {
    load()
    return all
  }

  function getPreset(id) {
    load()
    return byId.get(id) || null
  }

  function byCategory(cat) {
    load()
    const subs = new Map()
    for (const p of all) {
      if (p.cat !== cat) continue
      const s = p.sub || 'Other'
      if (!subs.has(s)) subs.set(s, [])
      subs.get(s).push(p)
    }
    return [...subs.entries()].map(([sub, list]) => ({ sub, count: list.length, presets: list }))
  }

  function pickerLists(o = {}) {
    load()
    const lists = []
    for (const c of CATEGORIES) {
      const groups = byCategory(c.id)
      const count = groups.reduce((a, g) => a + g.count, 0)
      if (!count && !o.includeEmpty) continue
      if (count <= PICKER_LIMIT) {
        lists.push({ id: c.id, name: categoryShortName(c.id), cat: c.id, sub: null, count, ids: groups.flatMap((g) => g.presets.map((p) => p.id)) })
        continue
      }
      for (const g of groups) {
        const ids = g.presets.map((p) => p.id)
        const parts = Math.ceil(ids.length / PICKER_LIMIT)
        for (let k = 0; k < parts; k++) {
          const slice = ids.slice(k * PICKER_LIMIT, (k + 1) * PICKER_LIMIT)
          const base = categoryShortName(c.id) + ': ' + g.sub
          lists.push({
            id: c.id + ':' + slug(g.sub) + (parts > 1 ? '-' + (k + 1) : ''),
            name: parts > 1 ? base + ', part ' + (k + 1) : base,
            cat: c.id,
            sub: g.sub,
            count: slice.length,
            ids: slice,
          })
        }
      }
    }
    return lists
  }

  function buildIndex() {
    load()
    index = all.map((p) => ({
      p,
      f: {
        name: words(p.name),
        tags: words((p.tags || []).join(' ')),
        sub: words(p.sub),
        cat: words(categoryName(p.cat) + ' ' + p.cat),
        about: words(p.about),
      },
      low: String(p.name || '').toLowerCase(),
    }))
  }

  function search(query, o = {}) {
    if (!index) buildIndex()
    const limit = Number.isFinite(o.limit) ? o.limit : 50
    const q = String(query || '').toLowerCase().trim()
    const tokens = q.split(/[^a-z0-9]+/).filter((t, i, a) => t && a.indexOf(t) === i)
    if (!tokens.length) return []
    const hits = []
    for (const e of index) {
      if (o.cat && e.p.cat !== o.cat) continue
      let score = 0
      let ok = true
      for (const t of tokens) {
        let best = 0
        for (const k of Object.keys(FIELD_WEIGHTS)) {
          const s = tokenScore(e.f[k], t) * FIELD_WEIGHTS[k]
          if (s > best) best = s
        }
        if (best <= 0) {
          ok = false
          break
        }
        score += best
      }
      if (!ok) continue
      if (e.low === q) score += 10
      else if (e.low.startsWith(q)) score += 4
      // hand-made presets are curated, so they lead a tie with the generated ones
      if (!e.p.generated) score += 2
      hits.push({ p: e.p, score })
    }
    hits.sort((a, b) => b.score - a.score || (CAT_BY_ID.get(a.p.cat)?.order ?? 99) - (CAT_BY_ID.get(b.p.cat)?.order ?? 99) || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0))
    return hits.slice(0, limit).map((h) => h.p)
  }

  function surprise(seed, o = {}) {
    const rng = makeRng(seed === undefined ? 1 : seed)
    if (!o.fresh) {
      load()
      const pool = o.cat ? all.filter((p) => p.cat === o.cat) : all
      return pool.length ? pool[rng.int(pool.length)] : null
    }
    return freshChain(rng, moduleList, liveOf, seed)
  }

  return { presets, getPreset, byCategory, pickerLists, search, surprise, isLive: liveOf }
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const FAMILY_ORDER = ['pitch', 'time', 'synth', 'spec', 'mod', 'lofi', 'device', 'tone', 'echo', 'stereo', 'space']

/** A brand-new random 2 to 4 stage chain from the modules that allow it. */
function freshChain(rng, modules, liveOf, seed) {
  const pool = modules.filter((m) => m && m.surprise !== false && typeof m.process === 'function')
  if (!pool.length) return null
  const want = 2 + rng.int(3)
  const picked = []
  let warps = 0
  let heavy = 0
  let spaces = 0
  for (let tries = 0; picked.length < want && tries < 60; tries++) {
    const m = pool[rng.int(pool.length)]
    if (picked.includes(m)) continue
    if (m.warps && warps) continue
    if (m.cost >= 5 && heavy) continue
    if ((m.family === 'space' || m.family === 'echo') && spaces) continue
    picked.push(m)
    if (m.warps) warps++
    if (m.cost >= 5) heavy++
    if (m.family === 'space' || m.family === 'echo') spaces++
  }
  picked.sort((a, b) => {
    const fa = FAMILY_ORDER.indexOf(a.family)
    const fb = FAMILY_ORDER.indexOf(b.family)
    return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
  })
  const chain = picked.map((m) => {
    const p = {}
    for (const param of m.params || []) {
      let v
      if (param.type === 'number') {
        let lo = param.min
        let hi = param.max
        if (Array.isArray(param.rand)) [lo, hi] = param.rand
        else if (param.id === 'mix') [lo, hi] = [35, 100]
        v = resolveValue(param, lo + rng.next() * (hi - lo))
      } else if (param.type === 'choice') {
        const opts = (param.options || []).filter((o) => o.v !== 'side')
        v = opts.length ? opts[rng.int(opts.length)].v : param.def
      } else if (param.type === 'bool') {
        v = /listen|solo/i.test(param.id) ? false : rng.next() < 0.5
      }
      if (v !== undefined && !sameValue(param, v)) p[param.id] = v
    }
    return { m: m.id, p }
  })
  const key = hashString(String(seed)).toString(36)
  const names = picked.map((m) => m.name.toLowerCase())
  const name = 'Surprise: ' + capital(names[0]) + (names[1] ? ' into ' + names[1] : '') + (names.length > 2 ? ' and more' : '')
  return {
    id: 'surprise-' + key,
    name,
    cat: 'strange',
    sub: 'Surprise me',
    about: aboutOf('A random chain:', names.join(', ')),
    tags: ['surprise', 'random'],
    chain,
    seed: typeof seed === 'number' ? seed : hashString(String(seed)) % 100000,
    live: liveOf(chain),
    generated: true,
  }
}

// ---------------------------------------------------------------- default catalog

const HAND = GEN && Array.isArray(GEN.default) ? GEN.default : []
const INGREDIENTS = GEN && GEN.INGREDIENTS ? GEN.INGREDIENTS : null
const DEFAULT = makeCatalog({ presets: HAND, ingredients: INGREDIENTS })

/** Every preset (hand-made, then Mix and match), each with a live flag. */
export function allPresets() {
  return DEFAULT.presets()
}
export function getPreset(id) {
  return DEFAULT.getPreset(id)
}
/** [{ sub, count, presets }] in authoring order. */
export function byCategory(cat) {
  return DEFAULT.byCategory(cat)
}
/** One list per category, or per group for categories over 150 presets. */
export function pickerLists(opts) {
  return DEFAULT.pickerLists(opts)
}
/** Ranked token search over names, tags, groups, categories and about sentences. */
export function search(query, opts) {
  return DEFAULT.search(query, opts)
}
/** A random existing preset, or with { fresh: true } a brand-new random chain. */
export function surprise(seed, opts) {
  return DEFAULT.surprise(seed, opts)
}
export function ingredients() {
  return INGREDIENTS
}
