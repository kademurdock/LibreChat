// host/worker.js - the engine's message handler, run as a module Worker on the website
// (and inline by host/client.js and host/bridge.js when a Worker is not available).
//
// Messages in (field t names the kind; "type" is accepted too):
//   { t:'load', id, sr, ch:[Float32Array] }   keep a sound: id 'take' (the recording),
//                                              'side' (the other sound) or 'bed:<id>' (a sound-file background)
//   { t:'unload', id }
//   { t:'preview', req, preset | chain, macros, start, seconds, seed, loudness, cleanup }
//   { t:'render',  req, ...same }              the whole take
//   { t:'cancel', req }                        (no req: cancel everything)
//   { t:'getPreset', req, id }
//   { t:'ping', req }
// Messages out:
//   { t:'ready', problems }                    once, when the Worker has loaded
//   { t:'loaded', req, id, sr, channels, seconds }
//   { t:'progress', req, f }                   0..1, at most about every 1 percent
//   { t:'done', req, sr, ch, report }          ch transferred, not copied
//   { t:'error', req, message, code }          a rejected load also carries the sound's id
//   { t:'preset', req, preset }                (null when unknown)
//
// Renders run one after another in the order they arrive. They use the waiting
// render (render.js renderPresetAsync), which pauses between stages, so a cancel
// that arrives during a render stops it at the next stage.

import { renderPresetAsync, renderPreviewAsync, VCError, registryStatus } from '../render.js'
import { getPreset, catalogStatus } from '../catalog.js'

function toBuffer(msg) {
  const sr = Number(msg.sr)
  const chIn = Array.isArray(msg.ch) ? msg.ch : []
  if (!(sr > 0) || !chIn.length) throw new VCError('That sound could not be read: it needs a sample rate and at least one channel.', 'bad-input')
  const ch = chIn.slice(0, 2).map((c) => (c instanceof Float32Array ? c : Float32Array.from(c || [], (v) => Number(v) || 0)))
  let n = Infinity
  for (const c of ch) n = Math.min(n, c.length)
  return { sr, ch: ch.map((c) => (c.length === n ? c : c.slice(0, n))) }
}

function transferable(ch) {
  // every channel must own a whole, distinct ArrayBuffer before it can be transferred
  const seen = new Set()
  return ch.map((c) => {
    if (c.byteOffset !== 0 || c.byteLength !== c.buffer.byteLength || seen.has(c.buffer)) c = new Float32Array(c)
    seen.add(c.buffer)
    return c
  })
}

/**
 * The handler behind every host. post(message, transferList) sends replies.
 * Returns handle(message) -> Promise (resolves when that message is dealt with).
 */
export function createHandler(post, opts = {}) {
  const store = new Map()
  const cancelled = new Set()
  let cancelAll = 0
  let queue = Promise.resolve()
  const lookupPreset = typeof opts.getPreset === 'function' ? opts.getPreset : getPreset

  const reply = (msg, transfer) => {
    try {
      post(msg, transfer || [])
    } catch (e) {
      try {
        post({ t: 'error', req: msg && msg.req, message: 'A reply could not be sent: ' + (e && e.message ? e.message : String(e)) })
      } catch {
        // nothing more can be done
      }
    }
  }
  const fail = (req, e, id) => {
    const vc = e instanceof VCError || (e && e.name === 'VCError')
    const m = {
      t: 'error',
      req,
      message: vc ? e.message : 'Something went wrong while making the sound: ' + (e && e.message ? e.message : String(e)),
      code: vc ? e.code : 'internal',
    }
    if (id !== undefined) m.id = id
    reply(m)
  }

  function presetOf(msg) {
    if (Array.isArray(msg.chain)) return { id: null, name: 'Custom chain', chain: msg.chain, bed: msg.bed, seed: msg.seed, side: msg.side }
    if (typeof msg.preset === 'string') {
      const p = lookupPreset(msg.preset)
      if (!p) throw new VCError('There is no preset called "' + msg.preset + '".', 'unknown-preset')
      return p
    }
    if (msg.preset && typeof msg.preset === 'object') return msg.preset
    if (typeof msg.id === 'string') {
      const p = lookupPreset(msg.id)
      if (!p) throw new VCError('There is no preset called "' + msg.id + '".', 'unknown-preset')
      return p
    }
    throw new VCError('Say which preset or chain to play.', 'bad-request')
  }

  async function doRender(msg, kind) {
    const req = msg.req
    const startedAt = cancelAll
    const isCancelled = () => cancelled.has(req) || cancelAll !== startedAt
    try {
      if (isCancelled()) throw new VCError('The render was cancelled.', 'cancelled')
      const take = store.get(typeof msg.take === 'string' ? msg.take : 'take')
      if (!take) throw new VCError('There is no recording loaded yet. Record or open a sound first.', 'no-input')
      const preset = presetOf(msg)
      const macros = msg.macros && typeof msg.macros === 'object' ? { ...msg.macros } : {}
      // the person's own other sound wins over the preset's named one
      let sideAudio = store.get('side') || null
      if (!sideAudio && typeof preset.side === 'string') sideAudio = store.get('bed:' + preset.side) || null
      const bed = macros.bed === undefined ? preset.bed : macros.bed
      let bedAudio = null
      if (bed && typeof bed.file === 'string') bedAudio = store.get('bed:' + bed.file) || null
      let lastF = -1
      let lastT = 0
      const progress = (f) => {
        const t = Date.now()
        if (f >= 1 || f - lastF >= 0.01 || t - lastT > 250) {
          lastF = f
          lastT = t
          reply({ t: 'progress', req, f: Math.round(f * 1000) / 1000 })
        }
      }
      const ro = {
        macros,
        seed: msg.seed,
        start: msg.start,
        seconds: msg.seconds,
        loudness: msg.loudness,
        cleanup: msg.cleanup,
        sideAudio,
        bedAudio,
        progress,
        cancelled: isCancelled,
      }
      const run = kind === 'preview' ? renderPreviewAsync : renderPresetAsync
      const { buf, report } = await run(take, preset, ro)
      const ch = transferable(buf.ch)
      reply({ t: 'done', req, sr: buf.sr, ch, report }, ch.map((c) => c.buffer))
    } catch (e) {
      fail(req, e)
    } finally {
      cancelled.delete(req)
    }
  }

  return function handle(msg) {
    if (!msg || typeof msg !== 'object') return Promise.resolve()
    const t = msg.t || msg.type
    try {
      switch (t) {
        case 'load': {
          const id = typeof msg.id === 'string' && msg.id ? msg.id : 'take'
          let b
          try {
            b = toBuffer(msg)
          } catch (e) {
            // a host waiting on this sound by its id (the iPhone page) needs the id back
            fail(msg.req, e, id)
            return Promise.resolve()
          }
          store.set(id, b)
          reply({ t: 'loaded', req: msg.req, id, sr: b.sr, channels: b.ch.length, seconds: b.ch[0].length / b.sr })
          return Promise.resolve()
        }
        case 'unload':
          store.delete(String(msg.id))
          return Promise.resolve()
        case 'preview':
        case 'render': {
          const p = queue.then(() => doRender(msg, t))
          queue = p
          return p
        }
        case 'cancel':
          if (msg.req === undefined || msg.req === null) cancelAll++
          else cancelled.add(msg.req)
          return Promise.resolve()
        case 'getPreset':
          reply({ t: 'preset', req: msg.req, preset: lookupPreset(String(msg.id)) || null })
          return Promise.resolve()
        case 'ping':
          reply({ t: 'ready', req: msg.req, problems: problems() })
          return Promise.resolve()
        default:
          reply({ t: 'error', req: msg.req, message: 'The engine does not understand the message "' + String(t) + '".', code: 'bad-request' })
          return Promise.resolve()
      }
    } catch (e) {
      fail(msg.req, e)
      return Promise.resolve()
    }
  }
}

function problems() {
  const out = catalogStatus()
  const r = registryStatus()
  if (r) out.push(r)
  return out
}

// Running as a real Worker: wire the handler to the message port.
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope
if (inWorker) {
  const handle = createHandler((m, transfer) => self.postMessage(m, transfer || []))
  self.onmessage = (e) => {
    handle(e.data)
  }
  self.postMessage({ t: 'ready', problems: problems() })
}
