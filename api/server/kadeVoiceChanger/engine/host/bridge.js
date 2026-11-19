// host/bridge.js - the iPhone engine page (CONTRACT section 10).
//
// A hidden WKWebView loads the engine page, which imports this file. Native code
// talks to window.vcBridge and listens on webkit.messageHandlers.vc:
//   vcBridge.feed(id, seq, b64, last)  a WAV file (16-bit or float) in base64 pieces,
//                                      seq 0, 1, 2...; id 'take' is the recording, 'side'
//                                      the other sound, 'bed:<id>' a decoded sound-file
//                                      background. On the last piece the WAV is decoded
//                                      and kept under its id; {t:'loaded', id, seconds} follows.
//   vcBridge.render(json)              JSON {req, preset (id or object) | chain, macros,
//                                      start, seconds, seed, preview: true|false}
//                                      (or kind: 'preview' | 'render'); returns req.
//   vcBridge.cancel(req)
//   vcBridge.getPreset(id)             the preset as a JSON string ("null" when unknown)
//   vcBridge.catalogVersion()          the engine version from manifest.json
// Replies posted to native:
//   {t:'ready', version}
//   {t:'progress', req, f}
//   {t:'chunk', req, seq, b64, last}   the result as a 16-bit WAV, base64, in slices of
//                                      1,500,000 characters
//   {t:'done', req, report, chunks}
//   {t:'loaded', id, seconds}
//   {t:'error', req, message}          also for page errors and unhandled rejections (req null);
//                                      a sound that could not be read or kept also carries its id,
//                                      and feed() returns false for it
// Without window.webkit (a desktop browser, or a test) the messages go to
// window.vcBridgeOut (an array) and window.vcBridgeOnMessage (when set).
//
// The engine runs inline here (host/worker.js createHandler); the page is pure
// compute, so a long render only keeps this hidden page busy. Base64 is the
// RFC 4648 alphabet, done with lookup tables on typed arrays because the
// browser's atob/btoa need binary strings, which are slow at tens of megabytes.

import { createHandler } from './worker.js'
import { getPreset } from '../catalog.js'
import { encodeWav, decodeWav } from '../core/wav.js'

export const SLICE_CHARS = 1500000

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const ENC = new Uint8Array(64)
const DEC = new Int16Array(256).fill(-1)
for (let i = 0; i < 64; i++) {
  ENC[i] = ALPHA.charCodeAt(i)
  DEC[ALPHA.charCodeAt(i)] = i
}
DEC['-'.charCodeAt(0)] = 62
DEC['_'.charCodeAt(0)] = 63

const TD = typeof TextDecoder === 'function' ? new TextDecoder('latin1') : null

/** Uint8Array -> base64 string. */
export function b64encode(u8) {
  const n = u8.length
  const out = new Uint8Array(Math.ceil(n / 3) * 4)
  let j = 0
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2]
    out[j++] = ENC[v >> 18]
    out[j++] = ENC[(v >> 12) & 63]
    out[j++] = ENC[(v >> 6) & 63]
    out[j++] = ENC[v & 63]
  }
  if (i < n) {
    const v = (u8[i] << 16) | (i + 1 < n ? u8[i + 1] << 8 : 0)
    out[j++] = ENC[v >> 18]
    out[j++] = ENC[(v >> 12) & 63]
    out[j++] = i + 1 < n ? ENC[(v >> 6) & 63] : 61
    out[j++] = 61
  }
  if (TD) return TD.decode(out)
  let s = ''
  for (let k = 0; k < out.length; k += 8192) s += String.fromCharCode.apply(null, out.subarray(k, k + 8192))
  return s
}

/** base64 string (padding and white space allowed) -> Uint8Array. */
export function b64decode(str) {
  const s = String(str)
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3)
  let acc = 0
  let bits = 0
  let j = 0
  for (let i = 0; i < s.length; i++) {
    const d = DEC[s.charCodeAt(i) & 255]
    if (d < 0) continue
    acc = ((acc << 6) | d) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[j++] = (acc >> bits) & 255
    }
  }
  return out.subarray(0, j)
}

/**
 * The bridge object. opts: { post(message), version, getPreset }.
 * Returns { feed, render, cancel, getPreset, catalogVersion, handle }.
 */
export function createBridge(opts = {}) {
  const post = typeof opts.post === 'function' ? opts.post : () => {}
  let version = opts.version || 'unknown'
  const lookup = typeof opts.getPreset === 'function' ? opts.getPreset : getPreset
  const parts = new Map()

  const send = (m) => {
    try {
      post(m)
    } catch {
      // native side gone; nothing to do
    }
  }

  function onEngine(msg) {
    if (!msg) return
    if (msg.t === 'done') {
      let b64
      try {
        b64 = b64encode(encodeWav({ sr: msg.sr, ch: msg.ch }, 16))
      } catch (e) {
        send({ t: 'error', req: msg.req, message: 'The result could not be packed: ' + (e && e.message ? e.message : String(e)) })
        return
      }
      const count = Math.max(1, Math.ceil(b64.length / SLICE_CHARS))
      for (let k = 0; k < count; k++) {
        send({ t: 'chunk', req: msg.req, seq: k, b64: b64.slice(k * SLICE_CHARS, (k + 1) * SLICE_CHARS), last: k === count - 1 })
      }
      send({ t: 'done', req: msg.req, report: msg.report, chunks: count })
    } else if (msg.t === 'progress') send({ t: 'progress', req: msg.req, f: msg.f })
    else if (msg.t === 'error') {
      // a rejected load carries the sound's id, so native's waiter for that id hears about it
      const m = { t: 'error', req: msg.req === undefined ? null : msg.req, message: msg.message, code: msg.code }
      if (typeof msg.id === 'string') {
        m.id = msg.id
        if (loading === msg.id) loadFailed = true
      }
      send(m)
    } else if (msg.t === 'loaded') send({ t: 'loaded', id: msg.id, seconds: msg.seconds })
  }

  // the sound feed() is handing the engine right now, and whether the engine turned it down
  let loading = null
  let loadFailed = false
  const handle = createHandler(onEngine, { getPreset: lookup })

  let autoReq = 1
  return {
    handle,
    feed(id, seq, b64, last) {
      const key = typeof id === 'string' && id ? id : 'take'
      try {
        // a second piece 0 means native started this sound over
        if (!parts.has(key) || (Number(seq) === 0 && parts.get(key).has(0))) parts.set(key, new Map())
        const m = parts.get(key)
        m.set(Number(seq), String(b64 || ''))
        if (!last) return true
        parts.delete(key)
        const n = Math.max(...m.keys()) + 1
        const pieces = []
        for (let k = 0; k < n; k++) {
          if (!m.has(k)) throw new Error('piece ' + k + ' of ' + n + ' never arrived')
          pieces.push(m.get(k))
        }
        const buf = decodeWav(b64decode(pieces.join('')))
        // a load is dealt with at once (no waiting), so its answer is known when handle returns
        loading = key
        loadFailed = false
        try {
          handle({ t: 'load', id: key, sr: buf.sr, ch: buf.ch })
        } finally {
          loading = null
        }
        return !loadFailed
      } catch (e) {
        parts.delete(key)
        send({ t: 'error', req: null, id: key, message: 'The sound "' + key + '" could not be read: ' + (e && e.message ? e.message : String(e)) })
        return false
      }
    },
    render(json) {
      let msg
      try {
        msg = typeof json === 'string' ? JSON.parse(json) : { ...json }
        if (!msg || typeof msg !== 'object') throw new Error('it is not an object')
      } catch (e) {
        send({ t: 'error', req: null, message: 'The render request could not be read: ' + (e && e.message ? e.message : String(e)) })
        return null
      }
      if (msg.req === undefined || msg.req === null) msg.req = 'r' + autoReq++
      const kind = msg.kind === 'preview' || msg.kind === 'render' ? msg.kind : msg.preview ? 'preview' : 'render'
      handle({ ...msg, t: kind })
      return msg.req
    },
    cancel(req) {
      handle({ t: 'cancel', req: req === undefined ? null : req })
    },
    getPreset(id) {
      try {
        return JSON.stringify(lookup(String(id)) || null)
      } catch {
        return 'null'
      }
    },
    catalogVersion() {
      return version
    },
    setVersion(v) {
      version = String(v)
    },
  }
}

/** Put window.vcBridge on a window (or a mock of one) and say ready. */
export async function install(win, opts = {}) {
  const out = Array.isArray(win.vcBridgeOut) ? win.vcBridgeOut : (win.vcBridgeOut = [])
  const post = (m) => {
    const h = win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.vc
    if (h && typeof h.postMessage === 'function') h.postMessage(m)
    else {
      out.push(m)
      if (out.length > 500) out.splice(0, out.length - 500)
    }
    if (typeof win.vcBridgeOnMessage === 'function') {
      try {
        win.vcBridgeOnMessage(m)
      } catch {
        // a test hook must not break the bridge
      }
    }
  }
  const bridge = createBridge({ post, getPreset: opts.getPreset })
  win.vcBridge = bridge
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('error', (e) => post({ t: 'error', req: null, message: 'Page error: ' + ((e && e.message) || 'unknown') }))
    win.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason
      post({ t: 'error', req: null, message: 'Page error: ' + (r && r.message ? r.message : String(r)) })
    })
  }
  let version = opts.version
  if (!version && typeof fetch === 'function') {
    try {
      const r = await fetch(new URL('../manifest.json', import.meta.url))
      if (r.ok) version = (await r.json()).version
    } catch {
      // version stays unknown
    }
  }
  if (version) bridge.setVersion(version)
  post({ t: 'ready', version: bridge.catalogVersion() })
  return bridge
}

if (typeof window !== 'undefined' && window && !window.vcBridgeManual) install(window)
