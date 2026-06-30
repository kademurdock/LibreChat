/**
 * ConversationMode — Patch F2
 *
 * Web/PWA "Skype-style" voice conversation overlay. A phone button appears in
 * the chat area; tapping it opens a full-screen voice call UI where the user
 * can speak naturally and hear the active agent reply in their Inworld voice.
 *
 * Architecture:
 *   Web Speech API (STT) → LibreChat /api/agents/chat SSE → SentenceStreamer
 *   → Inworld TTS proxy /v1/audio/speech → Web Audio API playback
 *
 * iOS note: AudioContext is unlocked on the "Start Call" button tap (user
 * gesture), which is the only reliable way to enable auto-play audio on iOS.
 *
 * Half-duplex: the agent speaks first, user listens; when audio ends, listening
 * restarts. While the agent is speaking, an amber "Stop" button lets the user
 * interrupt and take the turn immediately.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Phone, PhoneOff, Mic, StopCircle } from 'lucide-react';
import { useAuthContext } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

// ── SentenceStreamer ──────────────────────────────────────────────────────────
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

// ── Types ─────────────────────────────────────────────────────────────────────
type CallStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

// Inworld TTS proxy (same service LibreChat uses for in-chat TTS)
const TTS_BASE = 'https://inworld-tts-proxy-production.up.railway.app';

// ── Component ─────────────────────────────────────────────────────────────────
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

  // Refs that survive re-renders and break hook circular deps
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const recRef            = useRef<any>(null);
  const abortRef          = useRef(false);
  const historyRef        = useRef<Array<{ role: string; content: string }>>([]);
  const conversationIdRef = useRef<string | null>(null);
  const playQueueRef      = useRef<Promise<void>>(Promise.resolve());
  const statusRef         = useRef<CallStatus>('idle');
  // Stable ref to the latest startListening so streamTurn can call it without
  // the circular useCallback dep chain.
  const startListeningRef = useRef<() => void>(() => {});

  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSrAvail(!!SR);
  }, []);

  // ── Audio context ────────────────────────────────────────────────────────────
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

  // ── LLM streaming turn ───────────────────────────────────────────────────────
  const streamTurn = useCallback(async (userText: string) => {
    if (abortRef.current) return;
    setStatus('thinking');
    setAiText('');
    setTranscript('');

    historyRef.current.push({ role: 'user', content: userText });
    // Keep last 20 messages (~10 turns) for context
    if (historyRef.current.length > 20) historyRef.current.splice(0, 2);

    const streamer = new SentenceStreamer();
    let fullReply = '';
    let firstToken = true;

    streamer.onsentence = (sentence) => {
      if (abortRef.current) return;
      if (firstToken) { setStatus('speaking'); firstToken = false; }
      void speakSentence(sentence);
    };

    try {
      const authHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; LibreChat)',
      };
      if (token) authHeaders['Authorization'] = `Bearer ${token}`;

      const body: Record<string, unknown> = {
        agent_id: agentId,
        messages: historyRef.current,
      };
      if (conversationIdRef.current) body['conversationId'] = conversationIdRef.current;

      // Phase 1: start the agent stream
      const startResp = await fetch('/api/agents/chat', {
        method: 'POST',
        headers: authHeaders,
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!startResp.ok) throw new Error(`chat start ${startResp.status}`);

      const startData = await startResp.json() as { streamId: string; conversationId?: string };
      if (startData.conversationId && !conversationIdRef.current) {
        conversationIdRef.current = startData.conversationId;
      }

      // Phase 2: consume SSE token stream
      const sseResp = await fetch(`/api/agents/chat/stream/${startData.streamId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'include',
      });
      if (!sseResp.ok || !sseResp.body) throw new Error(`SSE ${sseResp.status}`);

      const reader  = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';

      streamLoop: while (true) {
        if (abortRef.current) { await reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { await reader.cancel(); break streamLoop; }
          try {
            const d = JSON.parse(raw) as any;
            // on_message_delta format: d.data.delta.content[0].text
            const tok: string =
              d?.data?.delta?.content?.[0]?.text ??
              d?.delta?.content?.[0]?.text ??
              d?.token ??
              '';
            if (tok) {
              fullReply += tok;
              setAiText(prev => prev + tok);
              streamer.push(tok);
            }
          } catch { /* ignore malformed events */ }
        }
      }

      streamer.end();
      if (fullReply) historyRef.current.push({ role: 'assistant', content: fullReply });

      // Once all queued audio finishes, hand the mic back to the user
      playQueueRef.current.then(() => {
        if (!abortRef.current) {
          setStatus('listening');
          setAiText('');
          startListeningRef.current();
        }
      });
    } catch (err) {
      console.error('[ConvMode] streamTurn error:', err);
      if (!abortRef.current) {
        setStatus('listening');
        startListeningRef.current();
      }
    }
  }, [agentId, token, speakSentence]);

  // ── Speech recognition ───────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (abortRef.current) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;

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
      // 'aborted' fires when we .stop() intentionally — ignore
      if (e.error !== 'aborted' && !abortRef.current) {
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

  // ── Call controls ────────────────────────────────────────────────────────────
  const startCall = useCallback(() => {
    getAudioCtx();               // iOS: unlock AudioContext on user gesture
    abortRef.current = false;
    historyRef.current = [];
    conversationIdRef.current = null;
    playQueueRef.current = Promise.resolve();
    setOpen(true);
    setAiText('');
    setTranscript('');
    setStatus('listening');
    // Small delay to let React settle the open state before starting SR
    setTimeout(() => startListeningRef.current(), 100);
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
    historyRef.current = [];
    conversationIdRef.current = null;
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

  // ── Trigger button ───────────────────────────────────────────────────────────
  if (!open) {
    return (
      <button
        onClick={startCall}
        aria-label="Start voice conversation with the active agent"
        title={agentId ? 'Voice call mode' : 'Open a conversation to use voice call mode'}
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

  // ── Call overlay ─────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-950/97"
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation mode — press the red button to end the call"
      aria-live="polite"
    >
      {/* Status orb */}
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
        {status === 'listening' && <Mic size={44} className="text-blue-400 animate-pulse" />}
        {status === 'thinking'  && (
          <div className="h-7 w-7 rounded-full border-[3px] border-amber-400 border-t-transparent animate-spin" />
        )}
        {status === 'speaking'  && <Phone size={44} className="text-green-400" />}
        {status === 'idle'      && <Phone size={44} className="text-gray-500" />}
      </div>

      {/* Status label */}
      <p className="mb-8 text-sm uppercase tracking-widest text-gray-400" aria-live="polite">
        {status === 'listening' ? 'Listening...' :
         status === 'thinking'  ? 'Thinking...' :
         status === 'speaking'  ? 'Speaking' :
                                  'Starting...'}
      </p>

      {/* Live text display */}
      <div className="w-full max-w-xs space-y-3 px-4 min-h-[7rem]">
        {transcript && (
          <div className="rounded-2xl bg-blue-950/60 px-4 py-3 text-sm leading-relaxed">
            <span className="mb-1 block text-xs uppercase tracking-wider text-blue-400">You</span>
            <span className="text-blue-100">{transcript}</span>
          </div>
        )}
        {aiText && (
          <div className="rounded-2xl bg-white/5 px-4 py-3 text-sm leading-relaxed">
            <span className="mb-1 block text-xs uppercase tracking-wider text-gray-400">Agent</span>
            <span className="text-gray-200">{aiText}</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-10 flex items-center gap-6">
        {/* Amber interrupt button — only while agent is speaking */}
        {(status === 'speaking' || status === 'thinking') && (
          <button
            onClick={interruptAI}
            aria-label="Interrupt — stop agent and start listening"
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

      <p className="mt-5 text-xs text-gray-600">
        {status === 'speaking' || status === 'thinking'
          ? 'Tap amber to interrupt · Red to end call'
          : 'Red button ends the call'}
      </p>
    </div>
  );
}
