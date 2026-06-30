/**
 * ConversationMode — Patch F2 (+ a11y/streaming repair, June 30 2026)
 *
 * Web/PWA "Skype-style" voice conversation overlay. A phone button appears in
 * the chat area; tapping it opens a full-screen voice call UI where the user
 * can speak naturally and hear the active agent reply in their Inworld voice.
 *
 * Architecture:
 *   Web Speech API (STT) -> LibreChat /api/agents/chat (resumable SSE)
 *   -> SentenceStreamer -> Inworld TTS proxy /v1/audio/speech -> Web Audio API
 *
 * iOS note: AudioContext is unlocked on the "Start Call" button tap (user
 * gesture), which is the only reliable way to enable auto-play audio on iOS.
 *
 * Half-duplex: the agent speaks first, user listens; when audio ends, listening
 * restarts. While the agent is speaking, an amber "Stop" button lets the user
 * interrupt and take the turn immediately.
 *
 * Accessibility (June 30 fix):
 *   - The overlay is NOT a live region. Captions are visual-only (aria-hidden)
 *     so a screen reader never reads the streaming transcript over the user or
 *     over the agent's own TTS voice.
 *   - A single polite status region announces turn-taking ("Listening. Your
 *     turn.", "One moment.") and falls SILENT while the agent is speaking so
 *     VoiceOver doesn't talk over the reply.
 *   - Errors surface in an assertive alert region instead of failing silently.
 *   - Modal focus management: focus moves into the dialog on open and back to
 *     the trigger on close; Escape ends the call; Tab is trapped in the dialog.
 *
 * Networking (June 30 fix):
 *   - POSTs the real LibreChat agent submission ({ endpoint, agent_id, text,
 *     conversationId, parentMessageId }); threads multi-turn via the returned
 *     conversation + responseMessage ids (streamId === conversationId).
 *   - Parses the resumable SSE: run-step `on_message_delta` text deltas for low
 *     latency, reconciled against the `final` event so the full reply is always
 *     spoken even if a delta shape is missed.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Phone, PhoneOff, Mic, StopCircle } from 'lucide-react';
import { useAuthContext } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

// -- SentenceStreamer ----------------------------------------------------------
// Port of the phase4 POC sentence splitter. Buffers streaming tokens and emits
// complete sentences (split on .!?) with abbreviation-awareness.
class SentenceStreamer {
  private buf = '';
  private abbrevs = new Set([
    'dr','mr','mrs','ms','prof','vs','etc','e.g','i.e','a.m','p.m',
    'st','ave','jr','sr','no','vol','fig','dept','inc','ltd','corp',
  ]);
  onsentence?: (s: string) => void;

  push(token: string) {
    this.buf += token;
    this.flush(false);
  }

  end() {
    this.flush(true);
    const rem = this.buf.trim();
    if (rem.length > 3 && this.onsentence) this.onsentence(rem);
    this.buf = '';
  }

  private isAbbrev(word: string) {
    return this.abbrevs.has(word.toLowerCase().replace(/\./g, ''));
  }

  private flush(isFinal: boolean) {
    let pos = 0;
    while (pos < this.buf.length) {
      const rel = this.buf.slice(pos).search(/[.!?]/);
      if (rel < 0) break;
      const abs = pos + rel;
      const term = this.buf[abs];
      const next = this.buf[abs + 1];
      if (!next && !isFinal) break;
      if (term === '.' && next && /\d/.test(next)) { pos = abs + 1; continue; }
      const pre = this.buf.slice(0, abs).split(/\s+/).pop() ?? '';
      if (term === '.' && this.isAbbrev(pre)) { pos = abs + 1; continue; }
      if (!next || /[\s.!?]/.test(next)) {
        let end = abs;
        while (end < this.buf.length && /[.!?]/.test(this.buf[end])) end++;
        const sentence = this.buf.slice(0, end).trim();
        if (sentence.length > 4 && this.onsentence) this.onsentence(sentence);
        this.buf = this.buf.slice(end).trimStart();
        pos = 0;
        // Safety valve: flush if buffer grows very large (no punctuation)
        if (this.buf.length > 1400) {
          if (this.onsentence) this.onsentence(this.buf.trim());
          this.buf = '';
          break;
        }
        continue;
      }
      pos = abs + 1;
    }
  }
}

// -- Types & constants ---------------------------------------------------------
type CallStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

// Inworld TTS proxy (same service LibreChat uses for in-chat TTS)
const TTS_BASE = 'https://inworld-tts-proxy-production.up.railway.app';
// LibreChat conversation-threading sentinels (mirror data-provider Constants)
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const NEW_CONVO = 'new';

// -- Text extraction helpers (stable, module-level) ---------------------------
function partToText(p: any): string {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (typeof p.text === 'string') return p.text;
  if (p.text && typeof p.text.value === 'string') return p.text.value;
  return '';
}
function contentToText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partToText).join('');
  return partToText(content);
}
function messageText(msg: any): string {
  if (!msg) return '';
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  return contentToText(msg.content);
}
function makeId(): string {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return 'id-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
}

// -- Component -----------------------------------------------------------------
interface ConversationModeProps {
  index?: number;
}

export default function ConversationMode({ index = 0 }: ConversationModeProps) {
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(index));
  const voice   = useRecoilValue(store.voice);
  const { token } = useAuthContext();

  const [open,       setOpen]       = useState(false);
  const [status,     setStatus]     = useState<CallStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [aiText,     setAiText]     = useState('');
  const [srAvail,    setSrAvail]    = useState(false);
  const [error,      setError]      = useState('');

  // Refs that survive re-renders and break hook circular deps
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const recRef             = useRef<any>(null);
  const abortRef           = useRef(false);
  const conversationIdRef  = useRef<string | null>(null);
  const parentMessageIdRef = useRef<string>(NO_PARENT);
  const playQueueRef       = useRef<Promise<void>>(Promise.resolve());
  const statusRef          = useRef<CallStatus>('idle');
  // Stable ref to the latest startListening so streamTurn can call it without
  // the circular useCallback dep chain.
  const startListeningRef  = useRef<() => void>(() => {});
  // Modal focus management
  const triggerRef         = useRef<HTMLButtonElement | null>(null);
  const dialogRef          = useRef<HTMLDivElement | null>(null);
  const wasOpenRef         = useRef(false);

  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSrAvail(!!SR);
  }, []);

  // -- Audio context -----------------------------------------------------------
  // Must be called inside a user gesture to unlock iOS auto-play.
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  // Enqueue decoded audio on the Web Audio API. Ordered — each clip waits for
  // the previous to finish. Returns the tail promise so callers can await
  // "all audio done."
  const enqueueAudio = useCallback((raw: ArrayBuffer): Promise<void> => {
    const tail = playQueueRef.current.then(async () => {
      if (abortRef.current) return;
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      try {
        const decoded = await ctx.decodeAudioData(raw.slice(0));
        await new Promise<void>(resolve => {
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          src.onended = () => resolve();
          src.start();
        });
      } catch (err) {
        console.warn('[ConvMode] audio decode error:', err);
      }
    });
    playQueueRef.current = tail;
    return tail;
  }, []);

  // Synthesize one sentence via Inworld TTS and enqueue it for playback.
  const speakSentence = useCallback(async (text: string) => {
    if (abortRef.current) return;
    const useVoice = voice || 'Kiana (Comedian)';
    try {
      const resp = await fetch(`${TTS_BASE}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', input: text, voice: useVoice }),
      });
      if (!resp.ok) return;
      const buf = await resp.arrayBuffer();
      if (!abortRef.current) enqueueAudio(buf);
    } catch (err) {
      console.warn('[ConvMode] TTS error:', err);
    }
  }, [voice, enqueueAudio]);

  // -- LLM streaming turn ------------------------------------------------------
  const streamTurn = useCallback(async (userText: string) => {
    if (abortRef.current) return;
    setError('');
    setStatus('thinking');
    setAiText('');
    setTranscript('');

    const streamer = new SentenceStreamer();
    let acc = '';            // text already handed to TTS / shown
    let firstChunk = true;

    streamer.onsentence = (sentence) => {
      if (abortRef.current) return;
      if (firstChunk) { setStatus('speaking'); firstChunk = false; }
      void speakSentence(sentence);
    };

    const pushText = (chunk: string) => {
      if (!chunk) return;
      acc += chunk;
      setAiText(prev => prev + chunk);
      streamer.push(chunk);
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Standard LibreChat agent submission. The server rebuilds history from
      // conversationId + parentMessageId, so we thread rather than resend.
      const body: Record<string, unknown> = {
        endpoint: 'agents',
        agent_id: agentId,
        text: userText,
        messageId: makeId(),
        parentMessageId: parentMessageIdRef.current || NO_PARENT,
        conversationId: conversationIdRef.current || NEW_CONVO,
      };

      // Phase 1: start the generation job (returns streamId === conversationId)
      const startResp = await fetch('/api/agents/chat', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!startResp.ok) throw new Error(`chat start ${startResp.status}`);
      const startData = await startResp.json() as { streamId?: string; conversationId?: string };
      if (startData.conversationId) conversationIdRef.current = startData.conversationId;
      if (!startData.streamId) throw new Error('no streamId from chat start');

      // Phase 2: subscribe to the SSE token stream
      const sseResp = await fetch(
        `/api/agents/chat/stream/${encodeURIComponent(startData.streamId)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          credentials: 'include',
        },
      );
      if (!sseResp.ok || !sseResp.body) throw new Error(`SSE ${sseResp.status}`);

      const reader  = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      let curEvent = 'message';
      let finalized = false;

      streamLoop: while (true) {
        if (abortRef.current) { await reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');
          if (line === '') { curEvent = 'message'; continue; }
          if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') break streamLoop;
          if (!payload) continue;

          let obj: any;
          try { obj = JSON.parse(payload); } catch { continue; }

          if (curEvent === 'error' || obj?.error) {
            throw new Error(typeof obj?.error === 'string' ? obj.error : 'stream error');
          }

          // Created: capture the real conversation id, nothing to speak yet.
          if (obj.created != null) {
            if (obj?.conversation?.conversationId) {
              conversationIdRef.current = obj.conversation.conversationId;
            }
            continue;
          }

          // Final: full reply + thread ids. Speak any not-yet-spoken remainder.
          if (obj.final != null) {
            const rm = obj.responseMessage;
            const full = messageText(rm) || (typeof obj.text === 'string' ? obj.text : '');
            if (full && full.length > acc.length && full.startsWith(acc)) {
              pushText(full.slice(acc.length));
            } else if (full && acc === '') {
              pushText(full);
            }
            if (rm?.messageId) parentMessageIdRef.current = rm.messageId;
            if (obj?.conversation?.conversationId) {
              conversationIdRef.current = obj.conversation.conversationId;
            }
            finalized = true;
            break streamLoop;
          }

          if (obj.sync != null) continue;
          // Never speak the model's private reasoning.
          if (obj.event === 'on_reasoning_delta') continue;

          // Run-step message delta (low-latency incremental text).
          const deltaContent = obj?.data?.delta?.content ?? obj?.delta?.content;
          if (deltaContent != null) { pushText(contentToText(deltaContent)); continue; }

          // Legacy cumulative-text event.
          if (typeof obj.text === 'string') {
            if (obj.text.length > acc.length && obj.text.startsWith(acc)) {
              pushText(obj.text.slice(acc.length));
            }
            continue;
          }
        }
      }

      streamer.end();
      if (!finalized && acc === '' && !abortRef.current) {
        setError("I didn't catch a reply — your turn, go ahead and try again.");
      }

      // Once all queued audio finishes, hand the mic back to the user
      playQueueRef.current.then(() => {
        if (!abortRef.current) {
          setAiText('');
          setStatus('listening');
          startListeningRef.current();
        }
      });
    } catch (err) {
      console.error('[ConvMode] streamTurn error:', err);
      if (!abortRef.current) {
        setError('Connection hiccup — your turn, try again.');
        setStatus('listening');
        startListeningRef.current();
      }
    }
  }, [agentId, token, speakSentence]);

  // -- Speech recognition ------------------------------------------------------
  const startListening = useCallback(() => {
    if (abortRef.current) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setError('Speech recognition is not available in this browser. Try Safari or Chrome.'); return; }

    const rec = new SR() as any;
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.maxAlternatives = 1;
    recRef.current = rec;

    rec.onstart = () => setStatus('listening');

    rec.onresult = (e: any) => {
      const result = e.results[e.results.length - 1];
      const t = (result[0]?.transcript ?? '') as string;
      setTranscript(t);
      if (result.isFinal && t.trim()) {
        rec.stop();
        void streamTurn(t.trim());
      }
    };

    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone access is blocked. Enable mic permission, then end and restart the call.');
        return;
      }
      // 'aborted' fires when we .stop() intentionally — ignore. 'no-speech'
      // just means a silent window; the onend handler restarts listening.
      if (e.error !== 'aborted' && e.error !== 'no-speech' && !abortRef.current) {
        setTimeout(() => startListeningRef.current(), 1000);
      }
    };

    rec.onend = () => {
      // If we ended without a final result and we're still in listening mode,
      // restart (handles the browser's automatic stop after silence)
      if (!abortRef.current && statusRef.current === 'listening') {
        setTimeout(() => startListeningRef.current(), 300);
      }
    };

    try { rec.start(); } catch { /* ignore if already started */ }
  }, [streamTurn]);

  // Keep the ref in sync with the latest callback
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  // -- Call controls -----------------------------------------------------------
  const startCall = useCallback(() => {
    getAudioCtx();               // iOS: unlock AudioContext on user gesture
    abortRef.current = false;
    conversationIdRef.current = null;
    parentMessageIdRef.current = NO_PARENT;
    playQueueRef.current = Promise.resolve();
    setError('');
    setOpen(true);
    setAiText('');
    setTranscript('');
    setStatus('connecting');
    // Small delay to let React settle the open state before starting SR
    setTimeout(() => startListeningRef.current(), 250);
  }, [getAudioCtx]);

  const endCall = useCallback(() => {
    abortRef.current = true;
    try { recRef.current?.stop(); } catch { /* ignore */ }
    recRef.current = null;
    playQueueRef.current = Promise.resolve();
    setOpen(false);
    setStatus('idle');
    setTranscript('');
    setAiText('');
    setError('');
    conversationIdRef.current = null;
    parentMessageIdRef.current = NO_PARENT;
  }, []);

  // Stop AI mid-speech and hand the mic back immediately
  const interruptAI = useCallback(() => {
    abortRef.current = true;
    playQueueRef.current = Promise.resolve();
    setTimeout(() => {
      if (!open) return; // call was ended
      abortRef.current = false;
      setAiText('');
      setStatus('listening');
      startListeningRef.current();
    }, 150);
  }, [open]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current = true;
      try { recRef.current?.stop(); } catch { /* ignore */ }
    };
  }, []);

  // Modal focus management: into the dialog on open, back to trigger on close.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const t = setTimeout(() => dialogRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Escape to end; trap Tab within the dialog's controls.
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); endCall(); return; }
    if (e.key !== 'Tab') return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (active === dialogRef.current) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  // Announced only on turn hand-offs; SILENT while the agent speaks so the
  // screen reader never talks over the agent's voice.
  const srStatus =
    error                    ? '' :
    status === 'listening'   ? 'Listening. Your turn to talk.' :
    status === 'thinking'    ? 'Got it. One moment.' :
    status === 'connecting'  ? 'Connecting.' :
                               '';
  const visibleStatus =
    status === 'listening'   ? 'Listening' :
    status === 'thinking'    ? 'Thinking' :
    status === 'speaking'    ? 'Speaking' :
    status === 'connecting'  ? 'Connecting' :
                               'Starting';

  // -- Trigger button ----------------------------------------------------------
  if (!open) {
    return (
      <button
        ref={triggerRef}
        onClick={startCall}
        aria-label="Start voice conversation with the active agent"
        title={
          !srAvail ? 'Voice calls need a browser with speech recognition (Safari or Chrome)'
          : agentId ? 'Voice call mode'
          : 'Open a conversation to use voice call mode'
        }
        disabled={!agentId || !srAvail}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
          agentId && srAvail
            ? 'bg-surface-tertiary text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            : 'cursor-not-allowed opacity-30 bg-surface-tertiary text-text-secondary',
        )}
      >
        <Phone size={15} aria-hidden="true" />
      </button>
    );
  }

  // -- Call overlay ------------------------------------------------------------
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950/97 focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation. Listening starts automatically. Press Escape or activate End call to hang up."
    >
      {/* Single polite status region for screen readers (turn-taking only) */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {srStatus}
      </p>
      {/* Assertive alert region for errors */}
      <p className="sr-only" role="alert" aria-live="assertive">
        {error}
      </p>

      {/* Status orb (decorative) */}
      <div
        className={cn(
          'mb-6 h-28 w-28 rounded-full flex items-center justify-center transition-all duration-300',
          status === 'listening' ? 'bg-blue-500/20 ring-4 ring-blue-500/40 scale-105' :
          status === 'thinking'  ? 'bg-amber-500/20 ring-4 ring-amber-500/40' :
          status === 'speaking'  ? 'bg-green-500/20 ring-4 ring-green-500/40 scale-110' :
                                   'bg-white/5',
        )}
        aria-hidden="true"
      >
        {status === 'listening'  && <Mic size={44} className="text-blue-400 animate-pulse" />}
        {status === 'thinking'   && (
          <div className="h-7 w-7 rounded-full border-[3px] border-amber-400 border-t-transparent animate-spin" />
        )}
        {status === 'speaking'   && <Phone size={44} className="text-green-400" />}
        {(status === 'idle' || status === 'connecting') && <Phone size={44} className="text-gray-400" />}
      </div>

      {/* Visible status label (decorative — announced via the sr-only region) */}
      <p className="mb-6 text-sm uppercase tracking-widest text-gray-300" aria-hidden="true">
        {visibleStatus}
      </p>

      {/* Visible error (also announced via the alert region above) */}
      {error && (
        <p className="mb-4 max-w-xs px-4 text-center text-sm text-amber-300" aria-hidden="true">
          {error}
        </p>
      )}

      {/* Live captions — VISUAL ONLY. Hidden from screen readers so they are
          never read over the user's speech or the agent's TTS voice. */}
      <div className="w-full max-w-xs space-y-3 px-4 min-h-[7rem]" aria-hidden="true">
        {transcript && (
          <div className="rounded-2xl bg-blue-950/60 px-4 py-3 text-sm leading-relaxed">
            <span className="mb-1 block text-xs uppercase tracking-wider text-blue-300">You</span>
            <span className="text-blue-100">{transcript}</span>
          </div>
        )}
        {aiText && (
          <div className="rounded-2xl bg-white/5 px-4 py-3 text-sm leading-relaxed">
            <span className="mb-1 block text-xs uppercase tracking-wider text-gray-300">Agent</span>
            <span className="text-gray-100">{aiText}</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-10 flex items-center gap-6">
        {/* Amber interrupt button — only while agent is thinking/speaking */}
        {(status === 'speaking' || status === 'thinking') && (
          <button
            onClick={interruptAI}
            aria-label="Interrupt the agent and start listening"
            title="Interrupt agent"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-600/90 text-white shadow-lg transition-colors hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <StopCircle size={24} aria-hidden="true" />
          </button>
        )}

        {/* Red end-call button */}
        <button
          onClick={endCall}
          aria-label="End voice conversation"
          title="End call"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white shadow-xl transition-colors hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          <PhoneOff size={28} aria-hidden="true" />
        </button>
      </div>

      <p className="mt-5 text-xs text-gray-400" aria-hidden="true">
        {status === 'speaking' || status === 'thinking'
          ? 'Tap amber to interrupt · Red to end call'
          : 'Red button ends the call'}
      </p>
    </div>
  );
}
