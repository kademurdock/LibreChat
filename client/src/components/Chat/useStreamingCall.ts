/**
 * useStreamingCall — Streaming Call (beta) engine for ConversationMode.
 * (July 9 2026, Track A of the duplex-voice workup.)
 *
 * Talks to the kade-ai-bridge's /ws/web-voice WebSocket — the SAME streaming
 * engine as the phone line (Deepgram streaming STT, sentence-streamed Inworld
 * TTS, voice barge-in, echo gates, backchannel drops, spoken agent/voice/rate
 * switching) — from the browser:
 *
 *   mic -> AudioWorklet (ScriptProcessor fallback) -> resample to PCM16 16k
 *       -> binary WS frames (the mic NEVER pauses: talk over the agent and
 *          the server stops her mid-word, no Stop button hunting)
 *   agent -> WAV clips (binary) scheduled gaplessly via Web Audio
 *         + JSON control events: ready / state / caption / clear / error / cue
 *
 * Auth: short-lived HMAC ticket from GET /api/kade/web-voice/ticket (JWT).
 * Transcripts land in Call History server-side (bridge ingest, surface 'web')
 * — callers of this hook must NOT also POST /api/kade/calls/mine.
 */
import { useRef, useCallback } from 'react';

export type StreamStatus = 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface StreamingHandlers {
  onStatus: (s: StreamStatus) => void;
  onUserCaption: (text: string) => void;
  onAgentCaption: (text: string) => void;
  onError: (message: string) => void;
  /** Server closed the socket (any reason). Fires once per call. */
  onEnded: (graceful: boolean) => void;
  /** A game table changed — redraw the GameTable widget for this id. */
  onTable?: (id: string) => void;
  /** Video events: {type:'video-notice'|'video-state', ...} (July 16 2026). */
  onVideo?: (m: Record<string, unknown>) => void;
}

export interface StreamingStartArgs {
  agentId?: string | null;
  /** Unlocked playback AudioContext from ConversationMode (iOS gesture). */
  ctx: AudioContext;
  /** Existing output analyser (drives the orb pulse); already wired to destination. */
  analyser: AnalyserNode | null;
  token?: string | null;
  handlers: StreamingHandlers;
}

const TARGET_RATE = 16000;
const SEND_CHUNK_MS = 100;

export default function useStreamingCall() {
  const wsRef         = useRef<WebSocket | null>(null);
  const micStreamRef  = useRef<MediaStream | null>(null);
  const micCtxRef     = useRef<AudioContext | null>(null);
  const micNodeRef    = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const outCtxRef     = useRef<AudioContext | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextTimeRef   = useRef(0);
  const sourcesRef    = useRef<Set<AudioBufferSourceNode>>(new Set());
  const decodeChainRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef     = useRef(false);
  const endedFiredRef = useRef(false);
  const byeSentRef    = useRef(false);
  const floatBufRef   = useRef<Float32Array[]>([]);
  const floatLenRef   = useRef(0);
  // Bumped on every flush: an in-flight decode from BEFORE a barge-in must
  // never schedule its (now stale) clip after the flush.
  const flushSeqRef   = useRef(0);

  const flushPlayback = useCallback(() => {
    flushSeqRef.current += 1;
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch { /* stopped */ } });
    sourcesRef.current.clear();
    nextTimeRef.current = 0;
    decodeChainRef.current = Promise.resolve();
  }, []);

  // Decode + schedule serially so clips can never play out of order (the same
  // reserve-your-slot-synchronously lesson enqueueAudio learned on July 4).
  const enqueueWav = useCallback((ab: ArrayBuffer) => {
    const seq = flushSeqRef.current;
    const chain = decodeChainRef.current.then(async () => {
      if (!activeRef.current || seq !== flushSeqRef.current) return;
      const ctx = outCtxRef.current;
      if (!ctx) return;
      let buf: AudioBuffer;
      try {
        buf = await ctx.decodeAudioData(ab.slice(0));
      } catch (err) {
        console.warn('[StreamingCall] wav decode failed:', err);
        return;
      }
      if (!activeRef.current || seq !== flushSeqRef.current) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(outAnalyserRef.current ?? ctx.destination);
      const t = Math.max(ctx.currentTime + 0.03, nextTimeRef.current || 0);
      try { src.start(t); } catch { return; }
      nextTimeRef.current = t + buf.duration;
      sourcesRef.current.add(src);
      src.onended = () => sourcesRef.current.delete(src);
    });
    decodeChainRef.current = chain.catch(() => { /* keep the chain alive */ });
  }, []);

  // Linear resample whatever the mic context runs at down to 16k PCM16.
  const drainMicBuffer = useCallback((force = false) => {
    const ctx = micCtxRef.current;
    const ws = wsRef.current;
    if (!ctx || !ws || ws.readyState !== WebSocket.OPEN) return;
    const srcRate = ctx.sampleRate;
    const minSamples = Math.round((srcRate * SEND_CHUNK_MS) / 1000);
    if (!force && floatLenRef.current < minSamples) return;
    if (floatLenRef.current === 0) return;
    const all = new Float32Array(floatLenRef.current);
    let off = 0;
    for (const c of floatBufRef.current) { all.set(c, off); off += c.length; }
    floatBufRef.current = [];
    floatLenRef.current = 0;
    const outLen = Math.floor((all.length * TARGET_RATE) / srcRate);
    if (outLen === 0) return;
    const pcm = new Int16Array(outLen);
    const ratio = srcRate / TARGET_RATE;
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, all.length - 1);
      const frac = pos - i0;
      let v = all[i0] * (1 - frac) + all[i1] * frac;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    try { ws.send(pcm.buffer); } catch { /* socket raced closed */ }
  }, []);

  const pushMicChunk = useCallback((chunk: Float32Array) => {
    if (!activeRef.current) return;
    floatBufRef.current.push(chunk);
    floatLenRef.current += chunk.length;
    drainMicBuffer(false);
  }, [drainMicBuffer]);

  const stopMic = useCallback(() => {
    try {
      const node = micNodeRef.current as any;
      if (node) {
        if (node.port && node.port.onmessage) node.port.onmessage = null;
        if ('onaudioprocess' in node) node.onaudioprocess = null;
        try { node.disconnect(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    micNodeRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    micStreamRef.current = null;
    try { void micCtxRef.current?.close(); } catch { /* ignore */ }
    micCtxRef.current = null;
    floatBufRef.current = [];
    floatLenRef.current = 0;
  }, []);

  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    micStreamRef.current = stream;
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctor();
    micCtxRef.current = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }
    const source = ctx.createMediaStreamSource(stream);
    let attached = false;
    if (typeof (ctx as any).audioWorklet?.addModule === 'function') {
      try {
        const workletSrc =
          'class KadePcm extends AudioWorkletProcessor{process(inputs){' +
          'const ch=inputs[0]&&inputs[0][0];if(ch&&ch.length)this.port.postMessage(ch.slice(0));return true}}' +
          "registerProcessor('kade-pcm',KadePcm);";
        const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'kade-pcm', { numberOfInputs: 1, numberOfOutputs: 0 });
        node.port.onmessage = (e: MessageEvent) => pushMicChunk(e.data as Float32Array);
        source.connect(node);
        micNodeRef.current = node;
        attached = true;
      } catch (err) {
        console.warn('[StreamingCall] AudioWorklet unavailable, falling back:', err);
      }
    }
    if (!attached) {
      // ScriptProcessor is deprecated but still everywhere; it only fires
      // when routed to the destination, so route it through zero gain.
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => pushMicChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(sp);
      sp.connect(mute).connect(ctx.destination);
      micNodeRef.current = sp;
    }
  }, [pushMicChunk]);

  const stop = useCallback((graceful = true) => {
    const ws = wsRef.current;
    activeRef.current = false;
    if (ws) {
      try {
        if (graceful && ws.readyState === WebSocket.OPEN && !byeSentRef.current) {
          byeSentRef.current = true;
          drainMicBuffer(true);
          ws.send(JSON.stringify({ type: 'bye' }));
        }
      } catch { /* ignore */ }
      try { ws.close(1000, 'bye'); } catch { /* ignore */ }
      wsRef.current = null;
    }
    stopMic();
    flushPlayback();
  }, [drainMicBuffer, stopMic, flushPlayback]);

  const barge = useCallback(() => {
    flushPlayback();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'barge' })); } catch { /* ignore */ }
    }
  }, [flushPlayback]);

  const start = useCallback(async ({ agentId, ctx, analyser, token, handlers }: StreamingStartArgs) => {
    if (activeRef.current) return;
    activeRef.current = true;
    endedFiredRef.current = false;
    byeSentRef.current = false;
    outCtxRef.current = ctx;
    outAnalyserRef.current = analyser;
    nextTimeRef.current = 0;
    handlers.onStatus('connecting');

    let ticket = '';
    let wsUrl = '';
    try {
      const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const resp = await fetch(`/api/kade/web-voice/ticket${q}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`ticket ${resp.status}`);
      const j = await resp.json();
      ticket = j.ticket;
      wsUrl = j.wsUrl;
      if (!ticket || !wsUrl) throw new Error('ticket payload incomplete');
    } catch (err: any) {
      activeRef.current = false;
      throw new Error(`Could not start the streaming call (${err?.message || 'ticket error'}).`);
    }

    try {
      await startMic();
    } catch (err) {
      activeRef.current = false;
      throw new Error('Microphone access is blocked. Enable mic permission, then end and start the call again.');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        stop(false);
        reject(new Error(msg));
      };
      const connectTimer = setTimeout(() => fail('The streaming call timed out while connecting.'), 15000);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        clearTimeout(connectTimer);
        fail('Could not open the call connection.');
        return;
      }
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        try { ws.send(JSON.stringify({ type: 'hello', ticket })); } catch { /* ignore */ }
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (ev.data instanceof ArrayBuffer) { enqueueWav(ev.data); return; }
        let m: any;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        switch (m.type) {
          case 'ready':
            if (!settled) { settled = true; clearTimeout(connectTimer); resolve(); }
            handlers.onStatus('listening');
            break;
          case 'state':
            handlers.onStatus(
              m.state === 'speaking' ? 'speaking' : m.state === 'thinking' ? 'thinking' : 'listening',
            );
            break;
          case 'caption':
            if (m.role === 'user') handlers.onUserCaption(String(m.text || ''));
            else handlers.onAgentCaption(String(m.text || ''));
            break;
          case 'clear':
            flushPlayback();
            break;
          case 'table':
            if (handlers.onTable && m.id) handlers.onTable(String(m.id));
            break;
          case 'video-notice':
          case 'video-state':
            handlers.onVideo?.(m);
            break;
          case 'error':
            handlers.onError(String(m.message || 'Call error.'));
            if (!settled) { settled = true; clearTimeout(connectTimer); stop(false); reject(new Error(String(m.message || 'Call error.'))); }
            break;
          default:
            break; // 'cue' and future events: ignore quietly
        }
      };
      ws.onerror = () => fail('The call connection failed.');
      ws.onclose = () => {
        clearTimeout(connectTimer);
        const wasGraceful = byeSentRef.current;
        if (!settled) { fail('The call connection closed before it was ready.'); return; }
        if (activeRef.current && !endedFiredRef.current) {
          endedFiredRef.current = true;
          activeRef.current = false;
          stopMic();
          flushPlayback();
          handlers.onEnded(wasGraceful);
        }
      };
    });
  }, [startMic, stop, stopMic, flushPlayback, enqueueWav]);

  const isActive = useCallback(() => activeRef.current, []);

  /** Send a JSON control message on the live call socket (video toggles, frames). */
  const sendJson = useCallback((obj: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* socket raced closed */ }
    }
  }, []);

  return { start, stop, barge, isActive, sendJson };
}
