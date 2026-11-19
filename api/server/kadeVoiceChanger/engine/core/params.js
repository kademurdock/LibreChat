// core/params.js - module parameters: defaults, clamping, spoken values, shape checks.
//
// resolveParams() turns whatever a preset, a saved chain or a slider sent
// into the full, safe parameter object a module's process() receives: every
// declared param present, numbers clamped to min..max and snapped to the
// step grid (snapping counts from min, then rounding noise is trimmed so
// 0.1 steps give 0.3 and not 0.30000000000000004), choices checked against
// their options (matched by value, or by spoken name ignoring case), and
// switches read from true/false, on/off, yes/no, 1/0. Anything unusable falls
// back to the default. Unknown keys and unusable values are reported as plain
// sentences through opts.problems, and with opts.strict a ParamError is
// thrown instead. Clamping is not a problem: macros push values past the
// ends on purpose.
//
// speakValue() says a value the way a person would say it out loud, for
// screen readers and VoiceOver: "up 3 semitones", "no change", "250
// milliseconds", "1.2 seconds", "40 percent", "minus 6 decibels", "2.5
// kilohertz", "90 degrees right", "on". The words come from the param's unit
// (CONTRACT section 4). A param may refine them with two optional fields:
// - words: { neg, pos, zero } names the two directions of a signed value,
//   e.g. { neg: 'left', pos: 'right', zero: 'center' } turns -40 percent
//   into "40 percent left";
// - noun: 'voice' or ['voice', 'voices'] names what a count counts.
// Degrees without words are read as a direction from the param's id and
// name: height or elevation reads up/down, phase or rotation reads plain
// degrees, everything else reads left/right with 0 as "straight ahead" and
// 180 as "behind".
//
// validateModuleShape() checks a module object against CONTRACT section 4 and
// returns a list of plain problems (empty when the module is fine). The
// registry tool and the tests use it. It also runs a small brand and
// person-name smoke check over every spoken string; that list is a net for
// obvious slips, not a legal review.

export const UNITS = ['semitones', 'cents', 'percent', 'ms', 'seconds', 'hz', 'db', 'x', 'bits', 'degrees', 'meters', 'bpm', 'count', 'steps']
export const PARAM_TYPES = ['number', 'choice', 'bool']
export const STEREO_MODES = ['keep', 'make', 'mono']

const INTEGER_UNITS = { count: 1, steps: 1, bits: 0 }

export class ParamError extends Error {
  constructor(message, problems) {
    super(message)
    this.name = 'ParamError'
    this.problems = problems || [message]
  }
}

function hasOwn(o, k) {
  return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
}

function decimalsOf(step) {
  if (!(step > 0) || !Number.isFinite(step)) return 2
  const s = String(step)
  const e = s.indexOf('e-')
  if (e >= 0) return Math.min(6, parseInt(s.slice(e + 2), 10) || 0)
  const d = s.indexOf('.')
  return d < 0 ? 0 : Math.min(6, s.length - d - 1)
}

function trimNoise(v) {
  const r = Math.round(v * 1e9) / 1e9
  return r === 0 ? 0 : r // never -0
}

function label(param) {
  return '"' + (param && (param.name || param.id) ? param.name || param.id : 'setting') + '"'
}

/** Resolve one param value (exported for sliders that edit a single value). */
export function resolveValue(param, raw, problems) {
  const type = param.type || 'number'
  if (type === 'bool') {
    if (raw === undefined) return !!param.def
    if (raw === true || raw === false) return raw
    if (raw === 1 || raw === 0) return raw === 1
    const s = String(raw).trim().toLowerCase()
    if (s === 'on' || s === 'true' || s === 'yes' || s === '1') return true
    if (s === 'off' || s === 'false' || s === 'no' || s === '0') return false
    if (problems) problems.push(label(param) + ' must be on or off, not ' + JSON.stringify(raw) + '.')
    return !!param.def
  }
  if (type === 'choice') {
    const opts = Array.isArray(param.options) ? param.options : []
    if (raw === undefined) return param.def
    for (let i = 0; i < opts.length; i++) if (opts[i].v === raw) return opts[i].v
    const s = String(raw)
    for (let i = 0; i < opts.length; i++) if (String(opts[i].v) === s) return opts[i].v
    const low = s.trim().toLowerCase()
    for (let i = 0; i < opts.length; i++) if (String(opts[i].name || '').toLowerCase() === low) return opts[i].v
    if (problems) {
      const names = opts.map((o) => o.name || String(o.v)).join(', ')
      problems.push(label(param) + ' has no choice called ' + JSON.stringify(raw) + '. The choices are: ' + names + '.')
    }
    return param.def
  }
  // number
  const min = Number.isFinite(param.min) ? param.min : -Infinity
  const max = Number.isFinite(param.max) ? param.max : Infinity
  let def = Number(param.def)
  if (!Number.isFinite(def)) def = Number.isFinite(min) ? min : 0
  let v
  if (raw === undefined) v = def
  else {
    v = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw)
    if (raw === null || raw === '' || !Number.isFinite(v)) {
      if (problems) problems.push(label(param) + ' must be a number, not ' + JSON.stringify(raw) + '.')
      v = def
    }
  }
  if (v < min) v = min
  if (v > max) v = max
  let step = Number(param.step)
  if (!(step > 0) && hasOwn(INTEGER_UNITS, param.unit) && INTEGER_UNITS[param.unit]) step = 1
  if (step > 0 && Number.isFinite(step)) {
    const base = Number.isFinite(min) ? min : 0
    v = base + Math.round((v - base) / step) * step
    if (v > max) v -= step
    if (v < min) v = min
    v = trimNoise(v)
  } else {
    v = trimNoise(v)
  }
  return v
}

/**
 * Full params for a module: defaults filled, numbers clamped and snapped,
 * choices and switches validated. opts: { strict=false, problems: [] }.
 */
export function resolveParams(module, p, opts = {}) {
  const problems = Array.isArray(opts.problems) ? opts.problems : []
  const start = problems.length
  const list = module && Array.isArray(module.params) ? module.params : []
  const out = {}
  const known = Object.create(null)
  for (let i = 0; i < list.length; i++) {
    const param = list[i]
    if (!param || typeof param.id !== 'string') continue
    known[param.id] = true
    const raw = hasOwn(p, param.id) ? p[param.id] : undefined
    out[param.id] = resolveValue(param, raw, problems)
  }
  if (p && typeof p === 'object') {
    const who = module && (module.name || module.id) ? module.name || module.id : 'This effect'
    for (const k of Object.keys(p)) {
      if (!known[k]) problems.push(who + ' has no setting called "' + k + '".')
    }
  }
  if (opts.strict && problems.length > start) {
    const mine = problems.slice(start)
    throw new ParamError(mine.join(' '), mine)
  }
  return out
}

/** Defaults of a module as an object (no problems possible). */
export function defaultParams(module) {
  return resolveParams(module, null)
}

// ---------------------------------------------------------------- speaking

function fmt(v, decimals) {
  const d = Math.max(0, Math.min(6, decimals))
  let s = (Math.round(Math.abs(v) * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d)
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

function plural(n, one, many) {
  return n === '1' ? one : many
}

function nounOf(param) {
  const nn = param.noun
  if (Array.isArray(nn) && nn.length >= 2) return [String(nn[0]), String(nn[1])]
  if (typeof nn === 'string' && nn) return [nn, nn.endsWith('s') ? nn : nn + 's']
  return null
}

function degreeMode(param) {
  const key = ((param.id || '') + ' ' + (param.name || '')).toLowerCase()
  if (/height|elev|tilt|vertical|above|below/.test(key)) return 'updown'
  if (/phase|rotat|spin|twist|turn|polarity/.test(key)) return 'plain'
  return 'leftright'
}

/**
 * Plain spoken words for a value of a param. v defaults to the param's default.
 */
export function speakValue(param, v) {
  if (!param) return String(v)
  if (v === undefined) v = param.def
  const type = param.type || 'number'
  if (type === 'bool') {
    const on = v === true || v === 1 || /^(on|true|yes|1)$/i.test(String(v))
    return on ? 'on' : 'off'
  }
  if (type === 'choice') {
    const opts = Array.isArray(param.options) ? param.options : []
    for (let i = 0; i < opts.length; i++) if (opts[i].v === v || String(opts[i].v) === String(v)) return String(opts[i].name || opts[i].v)
    return String(v)
  }
  let x = Number(v)
  if (!Number.isFinite(x)) return 'not set'
  if (x === 0) x = 0
  const dec = param.step > 0 ? Math.max(decimalsOf(param.step), 0) : 2
  const d2 = Math.max(dec, 2)
  const mag = fmt(x, d2)
  const neg = x < 0 && mag !== '0'
  const sign = neg ? 'minus ' : ''
  const words = param.words && typeof param.words === 'object' ? param.words : null
  const dir = (unitWords) => {
    // "40 percent left", "center"
    const u = plural(mag, unitWords[0], unitWords[1])
    const num = u ? mag + ' ' + u : mag
    if (mag === '0') return words.zero ? String(words.zero) : num
    return num + ' ' + String(neg ? words.neg || 'down' : words.pos || 'up')
  }
  switch (param.unit) {
    case 'semitones':
    case 'cents': {
      const u = param.unit === 'semitones' ? ['semitone', 'semitones'] : ['cent', 'cents']
      if (words) return dir(u)
      if (mag === '0') return 'no change'
      return (neg ? 'down ' : 'up ') + mag + ' ' + plural(mag, u[0], u[1])
    }
    case 'percent':
      if (words) return dir(['percent', 'percent'])
      return sign + mag + ' percent'
    case 'ms': {
      if (Math.abs(x) >= 1000) {
        const s = fmt(x / 1000, 2)
        return sign + s + ' ' + plural(s, 'second', 'seconds')
      }
      return sign + mag + ' ' + plural(mag, 'millisecond', 'milliseconds')
    }
    case 'seconds': {
      if (Math.abs(x) > 0 && Math.abs(x) < 1) {
        const m = fmt(x * 1000, Math.max(0, d2 - 3))
        return sign + m + ' ' + plural(m, 'millisecond', 'milliseconds')
      }
      return sign + mag + ' ' + plural(mag, 'second', 'seconds')
    }
    case 'hz': {
      if (Math.abs(x) >= 1000) return sign + fmt(x / 1000, 2) + ' kilohertz'
      return sign + mag + ' hertz'
    }
    case 'db':
      if (words) return dir(['decibel', 'decibels'])
      if (mag === '0') return '0 decibels'
      return (x < 0 ? 'minus ' : 'plus ') + mag + ' ' + plural(mag, 'decibel', 'decibels')
    case 'x':
      if (mag === '1') return 'no change'
      return sign + mag + ' times'
    case 'bits':
      return sign + mag + ' ' + plural(mag, 'bit', 'bits')
    case 'degrees': {
      if (words) return dir(['degree', 'degrees'])
      const mode = degreeMode(param)
      if (mode === 'plain') return sign + mag + ' ' + plural(mag, 'degree', 'degrees')
      if (mode === 'updown') {
        if (mag === '0') return 'level'
        return mag + ' ' + plural(mag, 'degree', 'degrees') + (neg ? ' down' : ' up')
      }
      // direction around the head
      let a = ((x % 360) + 540) % 360 - 180 // -180..180
      if (a === -180) a = 180
      const am = fmt(Math.abs(a), d2)
      if (am === '0') return 'straight ahead'
      if (am === '180') return 'behind'
      return am + ' ' + plural(am, 'degree', 'degrees') + (a < 0 ? ' left' : ' right')
    }
    case 'meters':
      return sign + mag + ' ' + plural(mag, 'meter', 'meters')
    case 'bpm':
      return sign + mag + ' ' + plural(mag, 'beat', 'beats') + ' per minute'
    case 'steps':
      return sign + mag + ' ' + plural(mag, 'step', 'steps')
    case 'count': {
      const nn = nounOf(param)
      return nn ? sign + mag + ' ' + plural(mag, nn[0], nn[1]) : sign + mag
    }
    default:
      if (words) return dir(['', ''])
      return sign + mag
  }
}

/** "from down 24 semitones to up 24 semitones" (numbers) or the choice list. */
export function speakRange(param) {
  if (!param) return ''
  if (param.type === 'bool') return 'on or off'
  if (param.type === 'choice') return (param.options || []).map((o) => o.name || String(o.v)).join(', ')
  return 'from ' + speakValue(param, param.min) + ' to ' + speakValue(param, param.max)
}

// ---------------------------------------------------------------- shape checks

// Whole-word, case-insensitive. Obvious brands, products and characters that
// a voice-effect author might reach for. Not exhaustive.
const BLOCKED = [
  'auto-tune', 'autotune', 'melodyne', 'antares', 'leslie', 'morphvox', 'screaming bee', 'voicemod',
  'clownfish', 'roland', 'korg', 'moog', 'yamaha', 'fender', 'marshall', 'eventide', 'lexicon',
  'izotope', 'soundtoys', 'dalek', 'darth', 'vader', 'cylon', 'optimus', 'siri', 'alexa', 'cortana',
  'chipmunks', 't-pain', 'cher', 'daft punk', 'kraftwerk', 'hawking', 'mickey', 'donald duck',
  'smurf', 'smurfs', 'gollum', 'yoda', 'groot', 'batman', 'pikachu', 'mario',
  'nintendo', 'sega', 'atari', 'game boy', 'gameboy', 'commodore 64', 'speak and spell', 'speak & spell',
  'iphone', 'skype', 'discord', 'walkman', 'star wars', 'star trek',
  'terminator', 'hal 9000', 'spongebob', 'shrek', 'sonic the hedgehog',
]

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const BLOCKED_RE = new RegExp('(^|[^a-z0-9])(' + BLOCKED.map(escapeRe).join('|') + ')(?=$|[^a-z0-9])', 'i')

/** Returns the blocked word found in text, or null. */
export function findBlockedWord(text) {
  if (typeof text !== 'string') return null
  const m = BLOCKED_RE.exec(text)
  return m ? m[2] : null
}

const ID_RE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/
const PARAM_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*$/

/**
 * Check a module object against CONTRACT section 4. Returns an array of
 * plain sentences; empty means the module is fine.
 */
export function validateModuleShape(mod) {
  const out = []
  if (!mod || typeof mod !== 'object') return ['The module is missing or is not an object.']
  const who = typeof mod.id === 'string' && mod.id ? mod.id : 'This module'
  const say = (s) => out.push(who + ': ' + s)
  const spoken = (field, text) => {
    const w = findBlockedWord(text)
    if (w) say(field + ' uses "' + w + '", which looks like a brand, product or person. Use plain words.')
  }
  // identity
  if (typeof mod.id !== 'string' || !ID_RE.test(mod.id)) {
    say('the id must look like family.name in lowercase (for example pitch.voice), not ' + JSON.stringify(mod.id) + '.')
  }
  if (typeof mod.family !== 'string' || !mod.family) say('the family is missing.')
  else if (typeof mod.id === 'string' && mod.id.split('.')[0] !== mod.family) {
    say('the family "' + mod.family + '" does not match the start of the id.')
  }
  if (typeof mod.name !== 'string' || !mod.name.trim()) say('the spoken name is missing.')
  else {
    if (mod.name.length > 40) say('the spoken name is longer than 40 characters.')
    spoken('the name', mod.name)
  }
  if (typeof mod.about !== 'string' || !mod.about.trim()) say('the about sentence is missing.')
  else {
    if (mod.about.length > 240) say('the about text is longer than 240 characters.')
    spoken('the about text', mod.about)
  }
  // behaviour
  if (!STEREO_MODES.includes(mod.stereo)) say('stereo must be keep, make or mono, not ' + JSON.stringify(mod.stereo) + '.')
  if (typeof mod.process !== 'function') say('process must be a function.')
  if (!(Number.isInteger(mod.cost) && mod.cost >= 1 && mod.cost <= 5)) say('cost must be a whole number from 1 to 5.')
  if (mod.warps !== undefined && typeof mod.warps !== 'boolean') say('warps must be true or false.')
  if (mod.surprise !== undefined && typeof mod.surprise !== 'boolean') say('surprise must be true or false.')
  // params
  const params = mod.params
  const defs = {}
  if (!Array.isArray(params)) say('params must be a list (it may be empty).')
  else {
    const seen = new Set()
    params.forEach((p, i) => {
      const where = 'setting ' + (i + 1) + (p && p.name ? ' ("' + p.name + '")' : '')
      if (!p || typeof p !== 'object') {
        say(where + ' is not an object.')
        return
      }
      if (typeof p.id !== 'string' || !PARAM_ID_RE.test(p.id)) say(where + ' needs an id made of letters and digits.')
      else if (seen.has(p.id)) say(where + ' repeats the id "' + p.id + '".')
      else seen.add(p.id)
      if (typeof p.name !== 'string' || !p.name.trim()) say(where + ' needs a spoken name.')
      else spoken(where + ' name', p.name)
      const type = p.type
      if (!PARAM_TYPES.includes(type)) {
        say(where + ' has type ' + JSON.stringify(type) + '; it must be number, choice or bool.')
        return
      }
      if (p.words !== undefined) {
        const w = p.words
        if (!w || typeof w !== 'object' || ['neg', 'pos', 'zero'].some((k) => w[k] !== undefined && typeof w[k] !== 'string')) {
          say(where + ' words must be an object of neg, pos and zero strings.')
        }
      }
      if (type === 'number') {
        const okNum = (v) => typeof v === 'number' && Number.isFinite(v)
        if (!okNum(p.min) || !okNum(p.max)) say(where + ' needs a numeric min and max.')
        else if (!(p.min < p.max)) say(where + ' has min ' + p.min + ' not below max ' + p.max + '.')
        if (p.step !== undefined && !(okNum(p.step) && p.step > 0)) say(where + ' has a step that is not a positive number.')
        if (!okNum(p.def)) say(where + ' needs a numeric default.')
        else if (okNum(p.min) && okNum(p.max) && (p.def < p.min || p.def > p.max)) {
          say(where + ' has a default of ' + p.def + ', outside ' + p.min + ' to ' + p.max + '.')
        } else if (okNum(p.min) && okNum(p.step) && p.step > 0) {
          const k = (p.def - p.min) / p.step
          if (Math.abs(k - Math.round(k)) > 1e-6) say(where + ' has a default of ' + p.def + ' that is not on its step of ' + p.step + '.')
        }
        if (!UNITS.includes(p.unit)) say(where + ' has unit ' + JSON.stringify(p.unit) + '; use one of ' + UNITS.join(', ') + '.')
        else if (p.unit === 'percent' && okNum(p.min) && okNum(p.max) && (p.min < -100 || p.max > 100)) {
          say(where + ' is a percent but runs past -100..100.')
        }
        if (p.id === 'mix' && (p.unit !== 'percent' || p.min !== 0 || p.max !== 100)) say(where + ' is a mix and must be percent from 0 to 100.')
        if (p.rand !== undefined) {
          const r = p.rand
          if (!Array.isArray(r) || r.length !== 2 || !okNum(r[0]) || !okNum(r[1]) || r[0] > r[1]) {
            say(where + ' rand must be [low, high] with low not above high.')
          } else if (okNum(p.min) && okNum(p.max) && (r[0] < p.min || r[1] > p.max)) {
            say(where + ' rand runs outside min and max.')
          }
        }
        if (p.noun !== undefined && !(typeof p.noun === 'string' || (Array.isArray(p.noun) && p.noun.length === 2))) {
          say(where + ' noun must be a word or a [one, many] pair.')
        }
      } else if (type === 'choice') {
        const o = p.options
        if (!Array.isArray(o) || !o.length) say(where + ' needs a list of options.')
        else {
          const vs = new Set()
          o.forEach((opt, j) => {
            if (!opt || typeof opt !== 'object' || (typeof opt.v !== 'string' && typeof opt.v !== 'number')) {
              say(where + ' option ' + (j + 1) + ' needs a value v (text or number).')
              return
            }
            if (vs.has(opt.v)) say(where + ' repeats the option value ' + JSON.stringify(opt.v) + '.')
            vs.add(opt.v)
            if (typeof opt.name !== 'string' || !opt.name.trim()) say(where + ' option ' + JSON.stringify(opt.v) + ' needs a spoken name.')
            else spoken(where + ' option name', opt.name)
          })
          if (!o.some((opt) => opt && opt.v === p.def)) say(where + ' has a default ' + JSON.stringify(p.def) + ' that is not one of its options.')
        }
      } else if (type === 'bool') {
        if (typeof p.def !== 'boolean') say(where + ' is on or off, so its default must be true or false.')
      }
      if (typeof p.id === 'string') defs[p.id] = p.def
    })
  }
  // tail and live, called with defaults to make sure they answer sensibly
  let resolved = null
  try {
    resolved = Array.isArray(params) ? resolveParams(mod, null) : {}
  } catch {
    resolved = defs
  }
  if (mod.tail !== undefined) {
    if (typeof mod.tail !== 'function') say('tail must be a function of (params, sampleRate).')
    else {
      try {
        const t = mod.tail(resolved, 48000)
        if (!(typeof t === 'number' && Number.isFinite(t) && t >= 0)) say('tail must return a number of seconds, 0 or more; it returned ' + String(t) + '.')
      } catch (e) {
        say('tail threw an error with the default settings: ' + (e && e.message ? e.message : String(e)))
      }
    }
  }
  if (mod.live !== undefined) {
    const lv = mod.live
    if (!lv || typeof lv !== 'object') say('live must be an object with latency and create.')
    else {
      if (typeof lv.create !== 'function') say('live.create must be a function.')
      if (typeof lv.latency !== 'function') say('live.latency must be a function.')
      else {
        try {
          const l = lv.latency(resolved, 48000)
          if (!(typeof l === 'number' && Number.isFinite(l) && l >= 0)) say('live.latency must return samples, 0 or more; it returned ' + String(l) + '.')
        } catch (e) {
          say('live.latency threw an error with the default settings: ' + (e && e.message ? e.message : String(e)))
        }
      }
    }
  }
  return out
}
