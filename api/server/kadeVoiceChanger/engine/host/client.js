// host/client.js - the page-side engine API for the website's /voice-changer page.
//
//   import { createEngine } from '/vc-engine/<version>/host/client.js'
//   const vc = createEngine({ base: '/vc-engine/<version>/' })
//   await vc.load(audioBuffer)                       // the recording (an AudioBuffer or { sr, ch })
//   await vc.load(otherBuffer, 'side')               // optional: the other sound
//   const job = vc.preview('giant-in-a-cave', { macros: { pitch: 2 }, onProgress: (f) => {} })
//   vc.cancel(job.req)                               // or vc.cancel() for everything
//   const { sr, ch, report } = await job
//
// The engine runs in a module Worker (host/worker.js) so the page never stalls.
// When module Workers are missing (older browsers, some embedded views) or the
// Worker does not say it is ready within a few seconds, the same handler is
// imported and run on the page instead; the API does not change. catalog()
// fetches the generated catalog.json from the engine folder.

let nextReq = 1

function channelsOf(audio) {
  if (!audio) throw new Error('There is no sound to load.')
  if (Array.isArray(audio.ch)) return { sr: Number(audio.sr), ch: audio.ch.map((c) => new Float32Array(c)) }
  if (typeof audio.getChannelData === 'function') {
    const n = Math.min(2, audio.numberOfChannels || 1)
    const ch = []
    for (let c = 0; c < n; c++) ch.push(new Float32Array(audio.getChannelData(c)))
    return { sr: Number(audio.sampleRate), ch }
  }
  throw new Error('That sound is neither an AudioBuffer nor { sr, ch }.')
}

/**
 * opts: { base (engine folder URL, default the folder above this file), worker=true, readyTimeoutMs=6000 }.
 */
export function createEngine(opts = {}) {
  const here = new URL('../', import.meta.url)
  const baseHref = typeof location !== 'undefined' && location.href ? location.href : here.href
  const base = opts.base ? new URL(opts.base, baseHref) : here
  const pending = new Map()
  let send = null
  let worker = null
  let mode = null
  let catalogPromise = null

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    const p = msg.req !== undefined && msg.req !== null ? pending.get(msg.req) : null
    if (msg.t === 'progress') {
      if (p && typeof p.onProgress === 'function') {
        try {
          p.onProgress(msg.f)
        } catch {
          // the page's progress callback must not break the engine
        }
      }
      return
    }
    if (!p) return
    if (msg.t === 'error') {
      pending.delete(msg.req)
      const e = new Error(msg.message)
      e.code = msg.code
      p.reject(e)
    } else if (msg.t === 'done' || msg.t === 'loaded' || msg.t === 'preset') {
      pending.delete(msg.req)
      p.resolve(msg)
    }
  }

  async function startInline() {
    const m = await import('./worker.js')
    const handle = m.createHandler((msg) => {
      // replies arrive asynchronously, as they would from a Worker
      setTimeout(() => onMessage(msg), 0)
    })
    mode = 'inline'
    send = (msg) => {
      handle(msg)
    }
  }

  function startWorker() {
    return new Promise((resolve, reject) => {
      let w
      try {
        w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      } catch (e) {
        reject(e)
        return
      }
      const timer = setTimeout(() => {
        try {
          w.terminate()
        } catch {
          // already gone
        }
        reject(new Error('The engine Worker did not start in time.'))
      }, opts.readyTimeoutMs || 6000)
      w.onerror = (e) => {
        clearTimeout(timer)
        try {
          w.terminate()
        } catch {
          // already gone
        }
        reject(new Error((e && e.message) || 'The engine Worker failed to start.'))
        if (e && typeof e.preventDefault === 'function') e.preventDefault()
      }
      w.onmessage = (e) => {
        const msg = e.data
        if (msg && msg.t === 'ready' && mode === null) {
          clearTimeout(timer)
          worker = w
          mode = 'worker'
          send = (m, transfer) => w.postMessage(m, transfer || [])
          w.onmessage = (ev) => onMessage(ev.data)
          w.onerror = (ev) => {
            // a crash after start: fail everything waiting
            for (const [req, p] of pending) {
              pending.delete(req)
              p.reject(new Error((ev && ev.message) || 'The engine stopped working.'))
            }
          }
          resolve()
        }
      }
    })
  }

  const ready = (async () => {
    if (opts.worker !== false && typeof Worker === 'function') {
      try {
        await startWorker()
        return mode
      } catch {
        // fall through to running on the page
      }
    }
    await startInline()
    return mode
  })()

  function request(msg, transfer, onProgress) {
    const req = msg.req !== undefined ? msg.req : nextReq++
    msg.req = req
    let resolveFn
    let rejectFn
    const promise = new Promise((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
    pending.set(req, { resolve: resolveFn, reject: rejectFn, onProgress })
    ready.then(
      () => send(msg, transfer),
      (e) => {
        pending.delete(req)
        rejectFn(e)
      }
    )
    promise.req = req
    return promise
  }

  function job(kind, preset, o = {}) {
    const msg = {
      t: kind,
      macros: o.macros,
      start: o.start,
      seconds: o.seconds,
      seed: o.seed,
      loudness: o.loudness,
      cleanup: o.cleanup,
    }
    // a list of stages is a custom rack; anything else is a preset id or a preset object
    if (Array.isArray(preset)) msg.chain = preset
    else msg.preset = preset
    const p = request(msg, [], o.onProgress)
    const out = p.then((m) => ({ sr: m.sr, ch: m.ch, report: m.report }))
    out.req = p.req
    return out
  }

  return {
    /** 'worker' or 'inline' once started. */
    get mode() {
      return mode
    },
    ready,
    /** The browsable index (categories, picker lists, presets, beds). */
    catalog() {
      if (!catalogPromise) {
        catalogPromise = fetch(new URL('catalog.json', base)).then((r) => {
          if (!r.ok) throw new Error('The preset list could not be loaded.')
          return r.json()
        })
        catalogPromise.catch(() => {
          catalogPromise = null
        })
      }
      return catalogPromise
    },
    /** Hand the engine a sound: id 'take' (default), 'side', or 'bed:<id>'. */
    load(audio, id = 'take') {
      const b = channelsOf(audio)
      return request({ t: 'load', id, sr: b.sr, ch: b.ch }, b.ch.map((c) => c.buffer)).then((m) => ({ id: m.id, seconds: m.seconds }))
    },
    unload(id) {
      ready.then(() => send({ t: 'unload', id }))
    },
    /** A short preview (6 seconds from opts.start by default). Resolves to { sr, ch, report }; .req to cancel. */
    preview(preset, o) {
      return job('preview', preset, o)
    },
    /** The whole take. */
    render(preset, o) {
      return job('render', preset, o)
    },
    /** Cancel one job by its req, or everything waiting. */
    cancel(req) {
      ready.then(() => send({ t: 'cancel', req: req === undefined ? null : req }))
    },
    /** The full preset (with its chain) by id; resolves to null when unknown. */
    getPreset(id) {
      return request({ t: 'getPreset', id }).then((m) => m.preset)
    },
    dispose() {
      for (const [req, p] of pending) {
        pending.delete(req)
        p.reject(new Error('The engine was closed.'))
      }
      if (worker) worker.terminate()
      worker = null
    },
  }
}
