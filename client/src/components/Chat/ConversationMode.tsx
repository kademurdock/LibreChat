/**
 * ConversationMode — Patch F2 (+ F3 a11y/streaming repair + F4 STT alignment)
 *
 * Web/PWA "Skype-style" voice conversation overlay. A phone button appears in
 * the chat area; tapping it opens a full-screen voice call UI where the user
 * can speak naturally and hear the active agent reply in their Inworld voice.
 *
 * Architecture:
 *   MediaRecorder + silence VAD -> LibreChat /api/files/speech/stt (Whisper)
 *   -> /api/agents/chat (resumable SSE) -> SentenceStreamer
 *   -> Inworld TTS proxy /v1/audio/speech -> Web Audio API playback
 *
 * F4 (June 30 2026): speech-to-text now uses the SAME server-side Whisper path
 * as the in-app mic (useSpeechToTextExternal): record with MediaRecorder, detect
 * end-of-turn with an AnalyserNode, POST the clip to /api/files/speech/stt. The
 * previous build used the browser Web Speech API (webkitSpeechRecognition),
 * which is unreliable in iOS home-screen PWAs. MediaRecorder + server Whisper
 * works there, matching the phone line's server-side STT philosophy (Deepgram).
 *
 * iOS note: AudioContext + getUserMedia are unlocked on the "Start Call" button
 * tap (user gesture), the only reliable way to enable auto-play + mic on iOS.
 *
 * Half-duplex: the agent speaks first, user listens; when audio ends, recording
 * restarts. While the agent is speaking, an amber "Stop" button lets the user
 * interrupt and take the turn immediately.
 *
 * Accessibility:
 *   - The overlay is NOT a live region. Captions are visual-only (aria-hidden)
 *     so a screen reader never reads them over the user or the agent's voice.
 *   - One polite status region announces turn-taking and falls SILENT while the
 *     agent speaks; errors surface in an assertive alert region.
 *   - Modal focus management, Escape to end, Tab trapped in the dialog.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Phone, PhoneOff, Mic, StopCircle } from 'lucide-react';
import { useAuthContext } from '~/hooks';
import { cn } from '~/utils';
import { stripVoiceTags } from '~/utils/voiceTags';
import { stripGameSoundTags } from '~/utils/gameSounds';
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

const TTS_BASE = 'https://inworld-tts-proxy-production.up.railway.app';
const STT_URL = '/api/files/speech/stt';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const NEW_CONVO = 'new';
// VAD tuning
const VAD_MIN_DECIBELS = -40;     // below this is treated as silence (was -45;
                                   // nudged up slightly so room echo/ambient
                                   // noise on speakerphone is less likely to
                                   // register as speech -- if this makes it
                                   // too hard to be heard, dial back toward
                                   // -45)
const VAD_SILENCE_MS = 2000;      // end the turn after this much trailing silence
                                   // (was 1500; bumped 2026-07-01 -- natural
                                   // mid-sentence pauses on the FIRST utterance
                                   // of a call were ending the turn early)
const VAD_MAX_TURN_MS = 30000;    // hard cap on a single utterance
const VAD_NOSPEECH_MS = 12000;    // give the mic back if nothing is said

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
function pickMimeType(): string {
  const types = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg','audio/wav'];
  for (const t of types) {
    try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t; } catch { /* ignore */ }
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('safari') && !ua.includes('chrome')) return 'audio/mp4';
  }
  return '';
}
function fileExt(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

// -- Component -----------------------------------------------------------------
interface ConversationModeProps {
  index?: number;
}

export default function ConversationMode({ index = 0 }: ConversationModeProps) {
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(index));
  const voice   = useRecoilValue(store.voice);
  const voiceSpeed = useRecoilValue(store.voiceSpeed); // Kade D2d: agent's speaking rate
  const setVoiceCallActive = useSetRecoilState(store.voiceCallActiveState);
  const { token } = useAuthContext();

  const [open,       setOpen]       = useState(false);
  const [status,     setStatus]     = useState<CallStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [aiText,     setAiText]     = useState('');
  const [mediaAvail, setMediaAvail] = useState(false);
  const [error,      setError]      = useState('');

  // Audio out (TTS playback)
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const playQueueRef       = useRef<Promise<void>>(Promise.resolve());
  // Output analyser (drives the volume-reactive "speaking" pulse -- decorative
  // only, never read by anything assistive tech touches) + the orb DOM node it
  // animates directly via rAF (bypassing React state for smoothness) + the
  // rAF handle so it can be torn down cleanly.
  const outputAnalyserRef  = useRef<AnalyserNode | null>(null);
  const orbRef              = useRef<HTMLDivElement | null>(null);
  const pulseRafRef         = useRef<number | null>(null);
  // Thinking-gap sound (same clip that plays on the phone line, ported here
  // as a tactile "still working on it" cue): cached decoded buffer (fetched
  // once, reused every turn), the currently-playing source node (so it can
  // be stopped immediately the moment thinking ends), and the start-delay
  // timer (so a fast reply never even triggers a blip of sound).
  const thinkingBufferRef   = useRef<AudioBuffer | null>(null);
  const thinkingSourceRef   = useRef<AudioBufferSourceNode | null>(null);
  const thinkingDelayRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Audio in (mic capture + VAD)
  const micStreamRef       = useRef<MediaStream | null>(null);
  const vadCtxRef          = useRef<AudioContext | null>(null);
  const analyserRef        = useRef<AnalyserNode | null>(null);
  const rafRef             = useRef<number | null>(null);
  const mediaRecorderRef   = useRef<MediaRecorder | null>(null);
  const audioChunksRef     = useRef<Blob[]>([]);
  const spokeRef           = useRef(false);
  // Flow control + threading
  const abortRef           = useRef(false);
  // Synchronous re-entry guard: statusRef updates a render late, so a fast
  // double-tap on the phone button could start TWO overlapping call
  // sessions (two mics, two turn loops = clips stepping on each other).
  const callActiveRef      = useRef(false);
  const conversationIdRef  = useRef<string | null>(null);
  const parentMessageIdRef = useRef<string>(NO_PARENT);
  const statusRef          = useRef<CallStatus>('idle');
  // Stable cross-call refs (break circular useCallback deps)
  const startListeningRef  = useRef<() => void>(() => {});
  const stopRecordingRef   = useRef<() => void>(() => {});
  const handleUtteranceRef = useRef<(mime: string) => void>(() => {});
  // Modal focus management
  const triggerRef         = useRef<HTMLButtonElement | null>(null);
  const dialogRef          = useRef<HTMLDivElement | null>(null);
  const wasOpenRef         = useRef(false);

  useEffect(() => { statusRef.current = status; }, [status]);

  // -- Volume-reactive "speaking" pulse -----------------------------------
  // Purely decorative, purely visual: reads real amplitude off the agent's
  // own TTS audio (via the analyser wired up in getAudioCtx/enqueueAudio)
  // and scales the orb live off of it, so sighted family in the room get a
  // genuine "she's talking" visual instead of a static icon. Skipped
  // entirely under prefers-reduced-motion -- the existing static scale-110
  // class on the orb is the fallback in that case. Never touches anything a
  // screen reader reads; the srStatus live region above is unaffected.
  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (status !== 'speaking' || reduceMotion) {
      if (pulseRafRef.current != null) {
        window.cancelAnimationFrame(pulseRafRef.current);
        pulseRafRef.current = null;
      }
      if (orbRef.current) orbRef.current.style.transform = '';
      return;
    }

    const analyser = outputAnalyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length / 255; // 0..1
      // Map to a gentle 1.0 - 1.16 scale range -- noticeable but not manic.
      const scale = 1 + Math.min(avg * 0.6, 0.16);
      if (orbRef.current) orbRef.current.style.transform = `scale(${scale.toFixed(3)})`;
      pulseRafRef.current = window.requestAnimationFrame(tick);
    };
    pulseRafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (pulseRafRef.current != null) {
        window.cancelAnimationFrame(pulseRafRef.current);
        pulseRafRef.current = null;
      }
      if (orbRef.current) orbRef.current.style.transform = '';
    };
  }, [status]);

  useEffect(() => {
    const ok = typeof navigator !== 'undefined'
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && typeof window !== 'undefined'
      && typeof (window as any).MediaRecorder !== 'undefined';
    setMediaAvail(ok);
  }, []);

  // -- Audio output ------------------------------------------------------------
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume();
    }
    if (!outputAnalyserRef.current) {
      const an = audioCtxRef.current.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.6;
      an.connect(audioCtxRef.current.destination);
      outputAnalyserRef.current = an;
    }
    return audioCtxRef.current;
  }, []);

  // -- Thinking-gap sound --------------------------------------------------
  // Same idea as the phone line's typing-sound filler: a quiet, looping
  // texture that plays only while genuinely waiting on a reply, so a long
  // pause reads as "still working on it" instead of dead air. 500ms delay
  // before it starts (matches the phone's tuned delay) so ordinary fast
  // replies never trigger even a blip of it. Stops the instant thinking
  // ends, whichever way it ends (reply arrives, error, call hung up).
  useEffect(() => {
    if (status !== 'thinking') {
      if (thinkingDelayRef.current != null) {
        clearTimeout(thinkingDelayRef.current);
        thinkingDelayRef.current = null;
      }
      if (thinkingSourceRef.current) {
        try { thinkingSourceRef.current.stop(); } catch { /* already stopped */ }
        thinkingSourceRef.current = null;
      }
      return;
    }

    let cancelled = false;

    thinkingDelayRef.current = setTimeout(async () => {
      thinkingDelayRef.current = null;
      if (cancelled || abortRef.current) return;
      const ctx = getAudioCtx();
      try {
        if (!thinkingBufferRef.current) {
          const resp = await fetch('/assets/sounds/thinking-loop.wav');
          const raw = await resp.arrayBuffer();
          thinkingBufferRef.current = await ctx.decodeAudioData(raw);
        }
        if (cancelled || abortRef.current || statusRef.current !== 'thinking') return;
        const src = ctx.createBufferSource();
        src.buffer = thinkingBufferRef.current;
        src.loop = true;
        // Quiet -- a tactile texture in the background, not a sound effect
        // competing with anything. Never routed through outputAnalyserRef:
        // it's not Kiana's voice, so it shouldn't drive the speaking pulse.
        const gain = ctx.createGain();
        gain.gain.value = 0.35;
        src.connect(gain).connect(ctx.destination);
        src.start();
        thinkingSourceRef.current = src;
      } catch (err) {
        console.warn('[ConvMode] thinking-sound error:', err);
      }
    }, 500);

    return () => {
      cancelled = true;
      if (thinkingDelayRef.current != null) {
        clearTimeout(thinkingDelayRef.current);
        thinkingDelayRef.current = null;
      }
      if (thinkingSourceRef.current) {
        try { thinkingSourceRef.current.stop(); } catch { /* already stopped */ }
        thinkingSourceRef.current = null;
      }
    };
  }, [status, getAudioCtx]);

  // Reserves this sentence's spot in the playback queue THE INSTANT it's
  // called -- synchronously, in the order sentences were actually written --
  // and only THEN waits on its audio fetch. The fetch itself can resolve
  // whenever it wants, fast or slow, without changing play order, because
  // the queue position was already locked in before anyone awaited anything.
  //
  // This used to be backwards: fetch the audio FIRST, and only call this
  // (queue-reservation) function after the fetch resolved. That meant a
  // short/fast-to-synthesize LATER sentence could finish fetching before an
  // earlier, longer sentence and jump the queue -- playing out of order.
  // That's what was making replies sound scrambled and rambly on the call
  // screen, and it explains "reading the emotions strangely" too: a
  // steering tag attached to one sentence would end up landing on whatever
  // ELSE happened to be playing at that moment, not the content it was
  // actually written for. The phone bridge never had this bug (its
  // equivalent chain is built the same synchronous way already); this was
  // web-only.
  const enqueueAudio = useCallback((bufPromise: Promise<ArrayBuffer | null>): Promise<void> => {
    const tail = playQueueRef.current.then(async () => {
      if (abortRef.current) return;
      const raw = await bufPromise;
      if (!raw || abortRef.current) return;
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      try {
        const decoded = await ctx.decodeAudioData(raw.slice(0));
        await new Promise<void>(resolve => {
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          // Route through the output analyser (falls back to a direct connect
          // if it somehow isn't set up yet) so the speaking-state pulse has
          // real amplitude data to animate from.
          if (outputAnalyserRef.current) src.connect(outputAnalyserRef.current);
          else src.connect(ctx.destination);
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

  // Fetches one sentence's TTS audio. Called immediately on sentence
  // detection so the network round-trip overlaps with everything else --
  // but per the note on enqueueAudio above, this promise is only ever
  // awaited FROM INSIDE an already-queued chain link, never used to decide
  // WHEN that link gets queued.
  const fetchSentenceAudio = useCallback(async (text: string): Promise<ArrayBuffer | null> => {
    if (abortRef.current) return null;
    const useVoice = voice || 'Kiana (Comedian)';
    try {
      const resp = await fetch(`${TTS_BASE}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // speed: Kade D2d — the active agent's speaking rate (undefined drops out)
        body: JSON.stringify({ model: 'tts-1', input: text, voice: useVoice, speed: voiceSpeed }),
      });
      if (!resp.ok) return null;
      return await resp.arrayBuffer();
    } catch (err) {
      console.warn('[ConvMode] TTS error:', err);
      return null;
    }
  }, [voice, voiceSpeed]);

  // -- LLM streaming turn ------------------------------------------------------
  const streamTurn = useCallback(async (userText: string) => {
    if (abortRef.current) return;
    setError('');
    setStatus('thinking');
    setAiText('');

    const streamer = new SentenceStreamer();
    let acc = '';
    let firstChunk = true;
    // Every sentence's full fetch-decode-play promise, so we can wait for
    // the LAST one to actually finish playing before going back to
    // 'listening' -- see the race-condition note below.
    const speechPromises: Promise<void>[] = [];

    streamer.onsentence = (sentence) => {
      if (abortRef.current) return;
      if (firstChunk) { setStatus('speaking'); firstChunk = false; }
      // Queue reservation happens synchronously right here, in detection
      // order -- see enqueueAudio's note on why that matters. The fetch
      // itself is passed in as a promise, not awaited before queuing.
      speechPromises.push(enqueueAudio(fetchSentenceAudio(sentence)));
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

      const body: Record<string, unknown> = {
        endpoint: 'agents',
        agent_id: agentId,
        text: userText,
        messageId: makeId(),
        parentMessageId: parentMessageIdRef.current || NO_PARENT,
        conversationId: conversationIdRef.current || NEW_CONVO,
      };

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
          if (obj.created != null) {
            if (obj?.conversation?.conversationId) conversationIdRef.current = obj.conversation.conversationId;
            continue;
          }
          if (obj.final != null) {
            const rm = obj.responseMessage;
            const full = messageText(rm) || (typeof obj.text === 'string' ? obj.text : '');
            if (full && full.length > acc.length && full.startsWith(acc)) pushText(full.slice(acc.length));
            else if (full && acc === '') pushText(full);
            if (rm?.messageId) parentMessageIdRef.current = rm.messageId;
            if (obj?.conversation?.conversationId) conversationIdRef.current = obj.conversation.conversationId;
            finalized = true;
            break streamLoop;
          }
          if (obj.sync != null) continue;
          if (obj.event === 'on_reasoning_delta') continue;

          const deltaContent = obj?.data?.delta?.content ?? obj?.delta?.content;
          if (deltaContent != null) { pushText(contentToText(deltaContent)); continue; }

          if (typeof obj.text === 'string') {
            if (obj.text.length > acc.length && obj.text.startsWith(acc)) pushText(obj.text.slice(acc.length));
            continue;
          }
        }
      }

      streamer.end();
      if (!finalized && acc === '' && !abortRef.current) {
        setError("I didn't catch a reply — your turn, go ahead and try again.");
      }

      // Wait for every dispatched sentence to actually finish playing --
      // NOT a snapshot of playQueueRef.current taken right here. Sentences
      // are TTS-fetched over the network, each on its own timer; the SSE
      // text stream can finish (and this code can run) while the LAST
      // sentence's fetch is still in flight and hasn't chained onto
      // playQueueRef yet. Reading the queue at that instant used to catch a
      // stale/already-resolved reference, so 'listening' could fire before
      // or during the final sentence's playback -- the "speaking and
      // listening both come in at the same time" bug. Promise.all() over
      // the actual per-sentence promises can't go stale like that.
      Promise.all(speechPromises).then(() => {
        if (abortRef.current) return;
        setAiText('');
        // Brief settle delay: onended fires the instant the buffer finishes,
        // but trailing room echo/reverb (especially on speakerphone) can
        // still be audible for a moment after. Re-arming the mic instantly
        // was picking that tail up as if it were the caller talking.
        setTimeout(() => {
          if (abortRef.current) return;
          setStatus('listening');
          startListeningRef.current();
        }, 350);
      });
    } catch (err) {
      console.error('[ConvMode] streamTurn error:', err);
      if (!abortRef.current) {
        setError('Connection hiccup — your turn, try again.');
        setStatus('listening');
        startListeningRef.current();
      }
    }
  }, [agentId, token, enqueueAudio, fetchSentenceAudio]);

  // -- Speech-to-text (MediaRecorder -> Whisper) -------------------------------
  // Transcribe one recorded utterance via the server STT route, then take a turn.
  const handleUtterance = useCallback(async (mime: string) => {
    if (abortRef.current) return;
    const chunks = audioChunksRef.current;
    audioChunksRef.current = [];
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });

    // Nothing meaningful was said — hand the mic straight back.
    if (!spokeRef.current || blob.size < 1200) {
      if (!abortRef.current) { setStatus('listening'); startListeningRef.current(); }
      return;
    }

    setStatus('thinking');
    try {
      const fd = new FormData();
      fd.append('audio', blob, `audio.${fileExt(mime)}`);
      const resp = await fetch(STT_URL, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'include',
        body: fd,
      });
      if (!resp.ok) throw new Error(`stt ${resp.status}`);
      const data = await resp.json() as { text?: string };
      const text = (data?.text ?? '').trim();
      if (abortRef.current) return;
      if (text) {
        setTranscript(text);
        void streamTurn(text);
      } else {
        setStatus('listening');
        startListeningRef.current();
      }
    } catch (err) {
      console.error('[ConvMode] STT error:', err);
      if (!abortRef.current) {
        setError("Couldn't transcribe that — your turn, try again.");
        setStatus('listening');
        startListeningRef.current();
      }
    }
  }, [token, streamTurn]);
  useEffect(() => { handleUtteranceRef.current = handleUtterance; }, [handleUtterance]);

  // Watch the mic level and stop recording once the user finishes speaking.
  const monitorSilence = useCallback(() => {
    const an = analyserRef.current;
    if (!an) return;
    const data = new Uint8Array(an.frequencyBinCount);
    spokeRef.current = false;
    let lastSound = Date.now();
    const startedAt = Date.now();

    const tick = () => {
      const rec = mediaRecorderRef.current;
      if (abortRef.current || !rec || rec.state !== 'recording') return;
      an.getByteFrequencyData(data);
      let sound = false;
      for (let i = 0; i < data.length; i++) { if (data[i] > 0) { sound = true; break; } }
      const now = Date.now();
      if (sound) { spokeRef.current = true; lastSound = now; }
      const silentFor = now - lastSound;
      const total = now - startedAt;
      if ((spokeRef.current && silentFor > VAD_SILENCE_MS) || total > VAD_MAX_TURN_MS) {
        stopRecordingRef.current();
        return;
      }
      if (!spokeRef.current && total > VAD_NOSPEECH_MS) {
        stopRecordingRef.current();
        return;
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const stopRecording = useCallback(() => {
    if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === 'recording') {
      try { rec.stop(); } catch { /* ignore */ } // fires 'stop' -> handleUtterance
    }
  }, []);
  useEffect(() => { stopRecordingRef.current = stopRecording; }, [stopRecording]);

  const startListening = useCallback(() => {
    if (abortRef.current) return;
    const stream = micStreamRef.current;
    if (!stream || typeof (window as any).MediaRecorder === 'undefined') {
      setError('Recording is not available in this browser.');
      return;
    }
    try {
      audioChunksRef.current = [];
      const mime = pickMimeType();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      rec.addEventListener('dataavailable', (e: BlobEvent) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      });
      rec.addEventListener('stop', () => { void handleUtteranceRef.current(rec.mimeType || mime); });
      rec.start(100);
      setStatus('listening');
      monitorSilence();
    } catch (err) {
      console.error('[ConvMode] startListening error:', err);
      if (!abortRef.current) setTimeout(() => startListeningRef.current(), 900);
    }
  }, [monitorSilence]);
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  // -- Mic / analyser lifecycle ------------------------------------------------
  const setupAnalyser = useCallback((stream: MediaStream) => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.minDecibels = VAD_MIN_DECIBELS;
      an.fftSize = 2048;
      source.connect(an);
      vadCtxRef.current = ctx;
      analyserRef.current = an;
    } catch (err) {
      console.warn('[ConvMode] analyser setup failed:', err);
    }
  }, []);

  const teardownMic = useCallback(() => {
    if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { mediaRecorderRef.current?.state === 'recording' && mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    try { micStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    micStreamRef.current = null;
    try { void vadCtxRef.current?.close(); } catch { /* ignore */ }
    vadCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  // -- Call controls -----------------------------------------------------------
  const startCall = useCallback(async () => {
    if (callActiveRef.current) return; // double-tap guard (see ref note)
    callActiveRef.current = true;
    setVoiceCallActive(true);
    /* KADE (July 2 2026): the call owns the speakers. Silence every other
     * audio surface FIRST — the hidden auto-play element, any per-message
     * read-aloud clip mid-play, and browser speech synthesis (devices still
     * on engineTTS "browser") — live report from Skylee: taps the phone
     * button and old clips all talk over each other. */
    try {
      document.querySelectorAll('audio').forEach((el) => {
        try { (el as HTMLAudioElement).pause(); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
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
    try {
      // Explicit constraints instead of bare `audio: true` -- echoCancellation
      // in particular matters a lot more on speakerphone (loud, direct
      // acoustic path from speaker back into the mic) than on headphones,
      // and leaving it implicit means whatever the browser's default happens
      // to be, which isn't consistent across browsers/devices.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (abortRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
      micStreamRef.current = stream;
      setupAnalyser(stream);
      setTimeout(() => startListeningRef.current(), 200);
    } catch (err) {
      console.error('[ConvMode] mic permission error:', err);
      setError('Microphone access is blocked. Enable mic permission, then end and start the call again.');
    }
  }, [getAudioCtx, setupAnalyser, setVoiceCallActive]);

  const endCall = useCallback(() => {
    callActiveRef.current = false;
    setVoiceCallActive(false);
    abortRef.current = true;
    teardownMic();
    playQueueRef.current = Promise.resolve();
    setOpen(false);
    setStatus('idle');
    setTranscript('');
    setAiText('');
    setError('');
    conversationIdRef.current = null;
    parentMessageIdRef.current = NO_PARENT;
  }, [teardownMic, setVoiceCallActive]);

  // Stop AI mid-speech and hand the mic back immediately
  const interruptAI = useCallback(() => {
    abortRef.current = true;
    playQueueRef.current = Promise.resolve();
    setTimeout(() => {
      if (!open) return;
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
      callActiveRef.current = false;
      setVoiceCallActive(false);
      teardownMic();
    };
  }, [teardownMic, setVoiceCallActive]);

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

  // Kept to single words on purpose: a screen reader interrupts/ducks whatever
  // audio is currently playing every time this live region's text changes, so
  // longer phrases here meant longer interruptions of the agent's actual voice.
  // 'speaking' now gets a one-word announcement too (it used to be silent) --
  // it fires once at the start of a reply, before the TTS fetch has even
  // returned audio, so in practice it doesn't overlap the agent's voice.
  // 'thinking' covers two very different waits: the model still reasoning
  // (nothing streamed yet) vs. the reply text already streaming in while the
  // first sentence's audio is being fetched. aiText is empty during the
  // former and non-empty during the latter, so it cleanly splits the label
  // into Thinking -> Typing without any extra state. (2026-07-01)
  const thinkingLabel = aiText ? 'Typing' : 'Thinking';
  const srStatus =
    error                    ? '' :
    status === 'listening'   ? 'Listening' :
    status === 'thinking'    ? thinkingLabel :
    status === 'speaking'    ? 'Speaking' :
    status === 'connecting'  ? 'Connecting' :
                               '';
  const visibleStatus =
    status === 'listening'   ? 'Listening' :
    status === 'thinking'    ? thinkingLabel :
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
          !mediaAvail ? 'Voice calls need a browser with microphone recording support'
          : agentId ? 'Voice call mode'
          : 'Open a conversation to use voice call mode'
        }
        disabled={!agentId || !mediaAvail}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full transition-all',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
          agentId && mediaAvail
            ? 'bg-surface-tertiary text-text-secondary hover:text-white ' +
              'hover:bg-gradient-to-br hover:from-[#ff2e87] hover:to-[#ffac2f] ' +
              'focus-visible:bg-gradient-to-br focus-visible:from-[#ff2e87] focus-visible:to-[#ffac2f] focus-visible:text-white'
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
      aria-label="Voice conversation. Escape or End call to hang up."
    >
      {/* Ambient brand-gradient glow -- decorative atmosphere only, sits behind
          everything, never affects layout, contrast, or focus order. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div
          className="absolute left-1/2 top-1/2 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.10] blur-3xl"
          style={{ background: 'radial-gradient(circle, #ff2e87 0%, #ffac2f 60%, transparent 75%)' }}
        />
      </div>

      {/* Single polite status region for screen readers (turn-taking only) */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {srStatus}
      </p>
      {/* Assertive alert region for errors */}
      <p className="sr-only" role="alert" aria-live="assertive">
        {error}
      </p>

      {/* Status orb (decorative). ref={orbRef}: the speaking-state pulse sets
          transform directly via rAF for smoothness (see the effect above);
          the listening-state "nod" is a plain CSS animation class instead,
          since it doesn't need live audio data. Both are no-ops under
          prefers-reduced-motion. */}
      <div
        ref={orbRef}
        className={cn(
          'mb-6 h-28 w-28 rounded-full flex items-center justify-center transition-all duration-300',
          status === 'listening' ? 'bg-blue-500/20 ring-4 ring-blue-500/40 scale-105 animate-kade-nod' :
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

      {/* Live captions — VISUAL ONLY (hidden from screen readers). */}
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
            {/* aiText accumulates the raw streamed reply, which may carry an
                invisible TTS-2 voice performance tag (see utils/voiceTags.ts)
                meant only for the audio path -- strip it for this caption.
                fetchSentenceAudio() above gets the untouched chunk, so the
                voice itself stays expressive. */}
            <span className="text-gray-100">{stripGameSoundTags(stripVoiceTags(aiText))}</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-10 flex items-center gap-6">
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
