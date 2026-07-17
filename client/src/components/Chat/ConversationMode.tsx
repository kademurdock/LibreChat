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
import { Phone, PhoneOff, Mic, StopCircle, Camera, CameraOff, ScanEye, Radio, Flashlight, FlashlightOff, SwitchCamera } from 'lucide-react';
import { useAuthContext } from '~/hooks';
import { usePauseGlobalAudio } from '~/hooks/Audio';
import { cn } from '~/utils';
import { stripVoiceTags } from '~/utils/voiceTags';
import { stripGameSoundTags, gameSoundSrcsIn, gameTableIdIn } from '~/utils/gameSounds';
import { INVALID_CITATION_REGEX, CLEANUP_REGEX, LITERAL_NBSP_REGEX } from '~/utils/citations';

/** July 13 2026 scrub audit: live captions also showed citation glyphs and
 * literal escape-text on web-search turns — captions are READ surfaces. */
function scrubCaption(text: string): string {
  return stripGameSoundTags(stripVoiceTags(text))
    .replace(INVALID_CITATION_REGEX, '')
    .replace(CLEANUP_REGEX, '')
    .replace(LITERAL_NBSP_REGEX, ' ')
    .replace(/turn\d+(?:search|image|news|video|ref|file)\d+/g, '');
}
import GameTable from '~/components/Chat/Messages/Content/GameTable';
import useStreamingCall from './useStreamingCall';
import store from '~/store';

// Bigger synth units = better prosody (context batching, July 4 2026).
const TTS_CHUNK_TARGET = 320;

// -- SentenceStreamer ----------------------------------------------------------
// Port of the phase4 POC sentence splitter. Buffers streaming tokens and emits
// complete sentences (split on .!?) with abbreviation-awareness.
class SentenceStreamer {
  private buf = '';
  private held = '';
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
    let rem = this.buf.trim();
    if (this.held) { rem = rem ? `${this.held} ${rem}` : this.held; this.held = ''; }
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
      // KADE July 4 2026 (choppy speech, same fix as the phone bridge):
      // a line-start number's period is a LIST marker ("\n 1. Card text"),
      // not a sentence end — splitting there made every numbered card two
      // tiny TTS clips with a fetch gap between them.
      if (term === '.' && /(^|\n)[ \t]*\d{1,3}$/.test(this.buf.slice(0, abs))) { pos = abs + 1; continue; }
      const pre = this.buf.slice(0, abs).split(/\s+/).pop() ?? '';
      if (term === '.' && this.isAbbrev(pre)) { pos = abs + 1; continue; }
      if (!next || /[\s.!?]/.test(next)) {
        let end = abs;
        while (end < this.buf.length && /[.!?]/.test(this.buf[end])) end++;
        let sentence = this.buf.slice(0, end).trim();
        // Short-fragment merging: "Round one." as its own synth = a
        // stop-to-think pause mid-speech. Under 24 chars rides in the
        // same breath as whatever comes next.
        if (this.held) { sentence = `${this.held} ${sentence}`; this.held = ''; }
        if (sentence.length > 4) {
          if (sentence.length < 24 && !isFinal) this.held = sentence;
          else if (this.onsentence) this.onsentence(sentence);
        } else if (sentence.length > 0 && !isFinal) {
          this.held = this.held ? `${this.held} ${sentence}` : sentence;
        }
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
const VAD_MAX_TURN_MS = 300000;   // hard cap on a single utterance.
                                   // July 4 2026 (Kade: "cuts me off after
                                   // a minute or so of talking... I can't
                                   // have multi-minute rants"): was 30s,
                                   // which force-stopped the recorder mid-
                                   // word on any long turn. Turns still end
                                   // naturally on 2s of trailing silence
                                   // (VAD_SILENCE_MS); this cap is now a
                                   // pure runaway-mic emergency brake.
                                   // 5 min of webm/opus is well under the
                                   // STT size limits.
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

// KADE July 16 2026 (?kade=call — Action Button / Siri deep link): capture the
// param at MODULE scope, before any router redirect can strip the query string
// (the iPhone Action Button intent and "Hey Siri, talk to Kiana" load
// kademurdock.com/?kade=call, and the app's boot redirects don't preserve
// search params). Consumed exactly once per page load by the effect below.
const KADE_AUTO_CALL = (() => {
  try { return new URLSearchParams(window.location.search).get('kade') === 'call'; } catch { return false; }
})();
let kadeAutoCallConsumed = false;

export default function ConversationMode({ index = 0 }: ConversationModeProps) {
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(index));
  const voice   = useRecoilValue(store.voice);
  const voiceSpeed = useRecoilValue(store.voiceSpeed); // Kade D2d: agent's speaking rate
  const setVoiceCallActive = useSetRecoilState(store.voiceCallActiveState);
  const { pauseGlobalAudio } = usePauseGlobalAudio(index);
  const { token } = useAuthContext();

  const [open,       setOpen]       = useState(false);
  const [status,     setStatus]     = useState<CallStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [aiText,     setAiText]     = useState('');
  // Game Parlor visual: sticky "current table" for this call. Set whenever a
  // streamed reply carries a [table:id] token; turnSeq keys the refetch so a
  // fresh move redraws the same table. Cleared on close.
  const [liveTable,  setLiveTable]  = useState<{ id: string; seq: number } | null>(null);
  // FaceTime Lite (July 9 2026, sister's ask): the agent's avatar photo fills
  // the call orb so the screen feels like a video call. Fail-soft — no
  // avatar, no fetch, or an error just keeps the classic orb. Decorative
  // only (aria-hidden with the rest of the visuals).
  const [avatarUrl,  setAvatarUrl]  = useState<string>('');
  const tableSeqRef = useRef(0);
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
  // Call-start "pickup" cue (July 15 2026): cached decoded buffer, one-shot.
  const pickupBufferRef     = useRef<AudioBuffer | null>(null);
  // Call-end "hangup" cue (July 15 2026): the pickup clip played backwards,
  // cached decoded buffer, one-shot.
  const hangupBufferRef     = useRef<AudioBuffer | null>(null);
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
  // Turn generation (July 4 2026 — Kade: "interrupt button doesn't work" +
  // "hung on app conversation"): the old interrupt set abortRef true for
  // 150ms and flipped it back — a pure race. If the SSE read loop didn't
  // happen to check the flag inside that window, the reply kept streaming,
  // chained onto the FRESH play queue, and the agent talked straight
  // through the interrupt; the stale turn's finish handler then re-armed
  // the mic a second time. A monotonic turn id can't race: every async
  // callback captures its turn number and bails forever once superseded.
  // Also new: the currently-playing source and live SSE reader are held in
  // refs so interrupt/end can stop them INSTANTLY (the old code never
  // stopped the buffer already coming out of the speakers), and a stall
  // watchdog kills turns that stop producing bytes (the "hung on app
  // conversation" report — there was no turn deadline at all).
  const turnIdRef          = useRef(0);
  const currentSourceRef   = useRef<AudioBufferSourceNode | null>(null);
  const sseReaderRef       = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const lastByteAtRef      = useRef(0);
  // Synchronous re-entry guard: statusRef updates a render late, so a fast
  // double-tap on the phone button could start TWO overlapping call
  // sessions (two mics, two turn loops = clips stepping on each other).
  const callActiveRef      = useRef(false);
  // Streaming Call (beta) — July 9 2026, duplex workup Track A. When the
  // localStorage flag is on, startCall uses the phone bridge's WebSocket
  // engine (continuous mic, VOICE barge-in, server Deepgram STT, filler,
  // spoken agent/voice switching) instead of the classic record->upload
  // turn loop. Engine choice is read AT CALL START (no mid-call flips).
  const streamingRef       = useRef(false);
  const streamingEngine    = useStreamingCall();

  /* -- Video call (July 16 2026, Kade's yes): caller camera -> agent vision.
   * Two lanes: 'standard' (front camera, cheap presence frames) and 'hq'
   * (rear camera, the platform's best eyes for labels/text/details).
   * Frames sample every 2s over the SAME call socket; the bridge holds only
   * the newest one in memory. Server is the gatekeeper (VIDEO_ENABLED flag,
   * daily minutes, first-use notice) — this side just captures and obeys. */
  const [videoMode,   setVideoMode]   = useState<'off' | 'standard' | 'hq'>('off');
  const [videoNotice, setVideoNotice] = useState<{ text: string; mode: 'standard' | 'hq' } | null>(null);
  const [videoInfo,   setVideoInfo]   = useState('');
  // Gemini Live lane (July 16 2026): while on, the LIVE session owns sight and
  // speech (different voice, continuous). liveModeRef mirrors the state for
  // callbacks that fire out of render order (video-state races at handoff).
  const [liveMode,   setLiveMode]   = useState(false);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const liveModeRef    = useRef(false);
  const liveConfirmRef = useRef<HTMLButtonElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  // Which physical camera is live right now (July 17, Kade's calls: Spotters
  // ALWAYS use the back camera; regular HQ video gets a flip button).
  const camFacingRef = useRef<'user' | 'environment'>('user');
  const camVideoRef  = useRef<HTMLVideoElement | null>(null);
  const camTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoConfirmRef = useRef<HTMLButtonElement | null>(null);

  /* -- Torch (July 17 2026, Kade's ask): a flashlight button during video.
   * WebKit has supported the MediaStream `torch` constraint since iOS 17.5,
   * so this works from the web call — no native code. Rear camera only by
   * hardware reality: the button renders ONLY when the RUNNING video track
   * actually reports the torch capability, so front-camera sessions and
   * older devices simply never see it. Fail-soft: if applyConstraints
   * rejects anyway, the button hides itself and says so politely. */
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopCamera = useCallback(() => {
    setTorchAvailable(false);
    setTorchOn(false);
    if (camTimerRef.current) { clearInterval(camTimerRef.current); camTimerRef.current = null; }
    try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    camStreamRef.current = null;
    if (camVideoRef.current) { try { camVideoRef.current.srcObject = null; } catch { /* ignore */ } }
    camVideoRef.current = null;
  }, []);

  const startCamera = useCallback(async (mode: 'standard' | 'hq', facing?: 'user' | 'environment') => {
    stopCamera();
    const face = facing ?? (mode === 'hq' ? 'environment' : 'user');
    camFacingRef.current = face;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: face, width: { ideal: 1024 } },
      audio: false,
    });
    camStreamRef.current = stream;
    // Torch: advertise the button only if this exact track can actually do it.
    setTorchOn(false);
    try {
      const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean })
        | undefined;
      setTorchAvailable(caps?.torch === true);
    } catch {
      setTorchAvailable(false);
    }
    const v = document.createElement('video');
    v.muted = true;
    (v as HTMLVideoElement & { playsInline: boolean }).playsInline = true;
    v.srcObject = stream;
    camVideoRef.current = v;
    try { await v.play(); } catch { /* iOS may defer to next tick */ }
    const canvas = document.createElement('canvas');
    camTimerRef.current = setInterval(() => {
      const vid = camVideoRef.current;
      if (!vid || !vid.videoWidth) return;
      const w = 768;
      const h = Math.round((vid.videoHeight / vid.videoWidth) * w) || 576;
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      if (!g) return;
      g.drawImage(vid, 0, 0, w, h);
      const b64 = canvas.toDataURL('image/jpeg', 0.65).split(',')[1];
      if (b64) streamingEngine.sendJson({ type: 'frame', data: b64 });
    }, 2000);
  }, [stopCamera, streamingEngine]);

  const toggleTorch = useCallback(async () => {
    const track = camStreamRef.current?.getVideoTracks()[0];
    if (!track) { return; }
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
      setVideoInfo(next ? 'Flashlight on.' : 'Flashlight off.');
    } catch {
      setTorchAvailable(false);
      setVideoInfo('The flashlight is not available on this camera.');
    }
  }, [torchOn]);

  const flipCamera = useCallback(async () => {
    const mode = videoMode === 'off' ? 'hq' : videoMode;
    const next = camFacingRef.current === 'environment' ? 'user' : 'environment';
    try {
      await startCamera(mode, next);
      setVideoInfo(next === 'environment' ? 'Rear camera — pointing at the world.' : 'Front camera — pointing at you.');
    } catch {
      setVideoInfo('Could not switch cameras.');
    }
  }, [videoMode, startCamera]);

  const requestVideo = useCallback((mode: 'standard' | 'hq', ack = false) => {
    streamingEngine.sendJson({ type: 'video', on: true, mode, ...(ack ? { ack: true } : {}) });
  }, [streamingEngine]);

  const turnVideoOff = useCallback(() => {
    streamingEngine.sendJson({ type: 'video', on: false });
    stopCamera();
    setVideoMode('off');
    setVideoNotice(null);
    setVideoInfo('Video off.');
  }, [streamingEngine, stopCamera]);

  const onVideoEvent = useCallback((m: Record<string, unknown>) => {
    if (m.type === 'live-notice') {
      // Bridge speaks the first-use cost notice too; this is the visible half.
      setLiveNotice(String(m.text || ''));
      return;
    }
    if (m.type === 'live-state') {
      if (m.on) {
        setLiveNotice(null);
        setLiveMode(true);
        liveModeRef.current = true;
        const who = m.spotterName ? String(m.spotterName) : 'Your Spotter';
        setVideoInfo(
          `${who} is on the line${typeof m.minutesLeft === 'number' ? ` — about ${m.minutesLeft} live minutes left today` : ''}. ` +
            'Continuous sight, instant replies. Say "live off" or tap the button to bring your character back.',
        );
        // Live needs eyes: if no camera is running, start one WITHOUT arming
        // the snapshot lane (frames route to the live relay server-side).
        if (!camStreamRef.current) {
          // Spotters always use the BACK camera (Kade, July 17): their job is
          // seeing the world, not the caller's face.
          startCamera('standard', 'environment').catch(() => {
            setVideoInfo('Live mode is on but the camera is blocked — it can hear you, just not see. Enable camera permission for this site to add sight.');
          });
        }
      } else {
        const wasLive = liveModeRef.current;
        setLiveMode(false);
        liveModeRef.current = false;
        if (wasLive) { stopCamera(); setVideoMode('off'); }
        setVideoInfo(
          m.message
            ? String(m.message)
            : m.reason === 'cap'
              ? 'Out of live minutes for today — the regular call continues as normal.'
              : 'Your Spotter is off the line — your character is back. Tap the camera button if you want regular video.',
        );
      }
      return;
    }
    if (m.type === 'video-notice') {
      // The bridge SPEAKS this notice too — this panel is the visible +
      // focusable half of the one-time cost heads-up.
      setVideoNotice({ text: String(m.text || ''), mode: m.mode === 'hq' ? 'hq' : 'standard' });
      return;
    }
    if (m.on) {
      setVideoNotice(null);
      const mode = m.mode === 'hq' ? 'hq' : 'standard';
      setVideoMode(mode);
      setVideoInfo(
        `Video on — ${mode === 'hq' ? 'HQ (rear camera)' : 'standard (front camera)'}${
          typeof m.minutesLeft === 'number' ? `. About ${m.minutesLeft} video minutes left today.` : '.'
        }`,
      );
      startCamera(mode).catch(() => {
        streamingEngine.sendJson({ type: 'video', on: false });
        setVideoMode('off');
        setVideoInfo('');
        setError('Camera access is blocked. Enable camera permission for this site, then try video again.');
      });
    } else {
      if (liveModeRef.current) {
        // Live handoff: the snapshot lane stood down (so it stops billing),
        // but live still needs the camera — keep it rolling.
        setVideoMode('off');
        return;
      }
      stopCamera();
      setVideoMode('off');
      setVideoInfo(m.message ? String(m.message) : m.reason === 'cap' ? 'Out of video minutes for today — voice continues as normal.' : 'Video off.');
    }
  }, [startCamera, stopCamera, streamingEngine]);

  // Move keyboard focus onto the confirm button when the notice appears.
  useEffect(() => {
    if (videoNotice) {
      const t = setTimeout(() => videoConfirmRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [videoNotice]);
  useEffect(() => {
    if (liveNotice) {
      const t = setTimeout(() => liveConfirmRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [liveNotice]);
  const conversationIdRef  = useRef<string | null>(null);
  const callTurnsRef       = useRef<Array<{ role: string; text: string }>>([]);
  const callStartedRef     = useRef<string | null>(null);
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

  // -- Call-start pickup sound ----------------------------------------------
  // A quick, soft "something just happened" cue the instant Start Call is
  // tapped -- fires before the call even connects, the audio equivalent of
  // physically lifting a phone receiver. One-shot (unlike the looped
  // thinking-gap sound below), cached buffer reused on every call. Never
  // routed through outputAnalyserRef -- it's not Kiana's voice, so it
  // shouldn't drive the speaking pulse. Fail-soft: a fetch/decode hiccup
  // just means a silent call start, never a blocked one.
  const playPickupSound = useCallback(async () => {
    try {
      const ctx = getAudioCtx();
      if (!pickupBufferRef.current) {
        const resp = await fetch('/assets/sounds/phone-pickup.wav');
        const raw = await resp.arrayBuffer();
        pickupBufferRef.current = await ctx.decodeAudioData(raw);
      }
      const src = ctx.createBufferSource();
      src.buffer = pickupBufferRef.current;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      src.connect(gain).connect(ctx.destination);
      src.start();
    } catch (err) {
      console.warn('[ConvMode] pickup-sound error:', err);
    }
  }, [getAudioCtx]);

  // Same cue, played backwards, for hanging up -- the audio equivalent of
  // setting the receiver back down. Fires the instant End Call is tapped,
  // same fail-soft rule as pickup: a fetch/decode hiccup just means a
  // silent hang-up, never a blocked one.
  const playHangupSound = useCallback(async () => {
    try {
      const ctx = getAudioCtx();
      if (!hangupBufferRef.current) {
        const resp = await fetch('/assets/sounds/phone-hangup.wav');
        const raw = await resp.arrayBuffer();
        hangupBufferRef.current = await ctx.decodeAudioData(raw);
      }
      const src = ctx.createBufferSource();
      src.buffer = hangupBufferRef.current;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      src.connect(gain).connect(ctx.destination);
      src.start();
    } catch (err) {
      console.warn('[ConvMode] hangup-sound error:', err);
    }
  }, [getAudioCtx]);

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
  const enqueueAudio = useCallback((bufPromise: Promise<ArrayBuffer | null>, gain?: number): Promise<void> => {
    const myTurn = turnIdRef.current;
    const tail = playQueueRef.current.then(async () => {
      if (abortRef.current || turnIdRef.current !== myTurn) return;
      const raw = await bufPromise;
      if (!raw || abortRef.current || turnIdRef.current !== myTurn) return;
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
          const sink = outputAnalyserRef.current ?? ctx.destination;
          if (typeof gain === 'number' && gain !== 1) {
            // Game Parlor cue clips are peak-normalized way hotter than the
            // -20 dBFS speech the TTS proxy sends; duck them under the voice.
            const g = ctx.createGain();
            g.gain.value = gain;
            src.connect(g);
            g.connect(sink);
          } else {
            src.connect(sink);
          }
          src.onended = () => {
            if (currentSourceRef.current === src) currentSourceRef.current = null;
            resolve();
          };
          src.start();
          currentSourceRef.current = src;
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
    const myTurn = ++turnIdRef.current;
    const superseded = () => abortRef.current || turnIdRef.current !== myTurn;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    setError('');
    setStatus('thinking');
    setAiText('');

    const streamer = new SentenceStreamer();
    tableSeqRef.current += 1;
    let acc = '';
    let firstChunk = true;
    // Every sentence's full fetch-decode-play promise, so we can wait for
    // the LAST one to actually finish playing before going back to
    // 'listening' -- see the race-condition note below.
    const speechPromises: Promise<void>[] = [];

    const processUnit = (sentence: string) => {
      if (superseded()) return;
      if (firstChunk) { setStatus('speaking'); firstChunk = false; }
      // Game Parlor phase 3: any [sound:x] cue in this sentence plays as a
      // real clip IN the speech queue (so it lands between sentences, in
      // order), and the token never reaches TTS. Clips are ducked to sit
      // under the voice (they're mastered much hotter than -20 dBFS speech).
      for (const cueSrc of gameSoundSrcsIn(sentence)) {
        speechPromises.push(
          enqueueAudio(
            fetch(cueSrc).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
            0.45,
          ),
        );
      }
      const spoken = stripGameSoundTags(sentence);
      if (spoken.trim().length < 2) return; // token-only fragment, nothing to say
      // Queue reservation happens synchronously right here, in detection
      // order -- see enqueueAudio's note on why that matters. The fetch
      // itself is passed in as a promise, not awaited before queuing.
      speechPromises.push(enqueueAudio(fetchSentenceAudio(spoken)));
    };
    // TTS context batching (July 4 2026 — Kade: "make the chunks bigger; it
    // can't remember it sounds like it's listing games"): sentence 1 ships
    // alone for fast first audio; after that, sentences accumulate to
    // ~TTS_CHUNK_TARGET chars and synth as ONE passage so the voice keeps
    // its rhythm through lists. Cue/table sentences flush and pass solo;
    // a leading %%%direction%%% tag starts its own chunk.
    let chunkBuf = '';
    let firstShipped = false;
    const flushChunk = () => {
      if (chunkBuf) { const c = chunkBuf; chunkBuf = ''; processUnit(c); }
    };
    streamer.onsentence = (sentence) => {
      if (superseded()) return;
      if (!firstShipped) { firstShipped = true; processUnit(sentence); return; }
      if (sentence.indexOf('[sound:') !== -1 || sentence.indexOf('[table:') !== -1) {
        flushChunk();
        processUnit(sentence);
        return;
      }
      if (/^\s*%%%/.test(sentence)) {
        flushChunk();
        chunkBuf = sentence;
        return;
      }
      chunkBuf = chunkBuf ? `${chunkBuf} ${sentence}` : sentence;
      if (chunkBuf.length >= TTS_CHUNK_TARGET) flushChunk();
    };

    const pushText = (chunk: string) => {
      if (!chunk) return;
      acc += chunk;
      const tid = gameTableIdIn(acc);
      if (tid) {
        setLiveTable((prev) =>
          prev && prev.id === tid && prev.seq === tableSeqRef.current
            ? prev
            : { id: tid, seq: tableSeqRef.current },
        );
      }
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
      sseReaderRef.current = reader;
      lastByteAtRef.current = Date.now();
      // Stall watchdog: LibreChat's resumable-streams subsystem is known to
      // occasionally strand a turn (documented open watch item). The phone
      // bridge got a 45s deadline long ago; Conversation Mode had NOTHING —
      // a stranded stream meant "thinking" forever. 75s with zero bytes =
      // cancel the reader; the normal end-of-stream path hands the mic back.
      watchdog = setInterval(() => {
        if (turnIdRef.current !== myTurn) { if (watchdog) clearInterval(watchdog); return; }
        if (Date.now() - lastByteAtRef.current > 75000) {
          if (watchdog) clearInterval(watchdog);
          console.warn('[ConvMode] turn stalled >75s — cancelling stream');
          try { void reader.cancel(); } catch { /* ignore */ }
        }
      }, 5000);
      const decoder = new TextDecoder();
      let sseBuf = '';
      let curEvent = 'message';
      let finalized = false;

      streamLoop: while (true) {
        if (superseded()) { await reader.cancel(); break; }
        const { done, value } = await reader.read();
        lastByteAtRef.current = Date.now();
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
      flushChunk();
      try {
        const clean = acc.replace(/\[(?:table|sound):[^\]]*\]/g, '').replace(/%%%[\s\S]*?%%%/g, '').trim();
        if (clean) callTurnsRef.current.push({ role: 'assistant', text: clean });
      } catch { /* ignore */ }
      if (!finalized && acc === '' && !superseded()) {
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
        if (superseded()) return;
        setAiText('');
        // Brief settle delay: onended fires the instant the buffer finishes,
        // but trailing room echo/reverb (especially on speakerphone) can
        // still be audible for a moment after. Re-arming the mic instantly
        // was picking that tail up as if it were the caller talking.
        setTimeout(() => {
          if (superseded()) return;
          setStatus('listening');
          startListeningRef.current();
        }, 350);
      });
    } catch (err) {
      console.error('[ConvMode] streamTurn error:', err);
      if (!superseded()) {
        setError('Connection hiccup — your turn, try again.');
        setStatus('listening');
        startListeningRef.current();
      }
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (sseReaderRef.current && turnIdRef.current === myTurn) sseReaderRef.current = null;
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
        callTurnsRef.current.push({ role: 'user', text });
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
    /* KADE (July 9 2026 — Skylee's iOS PWA bug): pause() alone was not
     * enough. On iOS, a per-message clip that was loaded but not finished
     * keeps its buffered src queued; the moment the call unlocks the audio
     * system (getAudioCtx below is a fresh user gesture), iOS flushes ALL of
     * those queued clips at once and they play overlapping on top of the
     * call. So we now fully NEUTRALIZE every audio surface BEFORE unlocking:
     * clear the app's global-audio player state, then pause + strip src +
     * reload each <audio> element so there is physically nothing buffered
     * left to flush. Elements get a fresh src the next time a message is
     * played, so this doesn't harm post-call playback. */
    try { pauseGlobalAudio(); } catch { /* ignore */ }
    try {
      document.querySelectorAll('audio').forEach((el) => {
        const a = el as HTMLAudioElement;
        try {
          a.pause();
          a.autoplay = false;
          try { a.srcObject = null; } catch { /* not a stream */ }
          a.removeAttribute('src');
          try { a.currentTime = 0; } catch { /* ignore */ }
          a.load(); // flush the buffered audio so nothing can auto-flush on unlock
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    getAudioCtx();               // iOS: unlock AudioContext on user gesture (now safe — queue is empty)
    void playPickupSound();       // soft "receiver lift" cue -- fires immediately, before the call connects
    abortRef.current = false;
    conversationIdRef.current = null;
    parentMessageIdRef.current = NO_PARENT;
    playQueueRef.current = Promise.resolve();
    setError('');
    callTurnsRef.current = [];
    callStartedRef.current = new Date().toISOString();
    setOpen(true);
    setAiText('');
    setTranscript('');
    setLiveTable(null);
    setStatus('connecting');
    setAvatarUrl('');
    if (agentId) {
      fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => {
          const fp = a?.avatar?.filepath;
          if (fp && !abortRef.current) setAvatarUrl(String(fp));
        })
        .catch(() => { /* keep the orb */ });
    }
    // Streaming is the DEFAULT engine now (promoted from beta July 9 2026 —
    // Kade's device test passed). localStorage kadeStreamingCall='0' is the
    // silent escape hatch back to the classic engine (debug/emergencies).
    let useStreaming = typeof WebSocket !== 'undefined';
    try { if (localStorage.getItem('kadeStreamingCall') === '0') useStreaming = false; } catch { /* stay streaming */ }
    if (useStreaming) {
      // -- Streaming Call (beta): the phone engine over a WebSocket --------
      // Mic capture, STT, barge-in, and TTS all live server-side (bridge);
      // this client streams PCM up and schedules WAV clips down. Transcript
      // is ingested by the bridge (surface 'web') — endCall must NOT also
      // POST /api/kade/calls/mine or the call would appear twice.
      streamingRef.current = true;
      try {
        await streamingEngine.start({
          agentId,
          ctx: getAudioCtx(),
          analyser: outputAnalyserRef.current,
          token,
          handlers: {
            onStatus: (st) => { if (!abortRef.current) setStatus(st); },
            onUserCaption: (t) => {
              if (!abortRef.current) { setTranscript(t); setAiText(''); }
            },
            onAgentCaption: (t) => {
              if (!abortRef.current) setAiText((prev) => (prev ? `${prev} ${t}` : t));
            },
            onError: (m) => { if (!abortRef.current) setError(m); },
            onTable: (id) => {
              // Same widget classic mode draws; every event = one move = one
              // refetch (seq bump). GameTable is fail-soft, so a table the
              // signed-in user can't see (bridge games run under the admin
              // session — the known phone-guest caveat) renders nothing.
              if (abortRef.current || !id) return;
              tableSeqRef.current += 1;
              setLiveTable({ id, seq: tableSeqRef.current });
            },
            onVideo: (m) => { if (!abortRef.current) onVideoEvent(m); },
            onEnded: (graceful) => {
              if (abortRef.current || !callActiveRef.current) return;
              if (!graceful) setError('The call connection dropped. End the call and try again.');
            },
          },
        });
        return; // streaming call is live
      } catch (err: any) {
        // Ticket/WS/mic trouble: fall back to the classic engine in the SAME
        // call so the phone button always works. (If the mic itself is
        // blocked, classic will surface its own clear error below.)
        console.error('[ConvMode] streaming start failed — falling back to classic:', err);
        streamingRef.current = false;
        try { streamingEngine.stop(false); } catch { /* ignore */ }
        setError('');
        setStatus('connecting');
      }
    }
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
  }, [getAudioCtx, setupAnalyser, setVoiceCallActive, pauseGlobalAudio]);

  const endCall = useCallback(() => {
    void playHangupSound();       // soft "receiver down" cue -- fires immediately, mirrors playPickupSound on start
    callActiveRef.current = false;
    stopCamera();
    setVideoMode('off');
    setVideoNotice(null);
    setVideoInfo('');
    if (streamingRef.current) {
      streamingRef.current = false;
      try { streamingEngine.stop(true); } catch { /* ignore */ }
      callTurnsRef.current = []; // bridge already ingested this transcript
    }
    try {
      const turns = callTurnsRef.current;
      if (turns && turns.length) {
        const payload = JSON.stringify({
          agentId,
          conversationId: conversationIdRef.current,
          startedAt: callStartedRef.current,
          endedAt: new Date().toISOString(),
          turns,
        });
        callTurnsRef.current = [];
        fetch('/api/kade/calls/mine', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          credentials: 'include',
          keepalive: true,
          body: payload,
        }).catch(() => {});
      }
    } catch { /* never block hang-up */ }
    setVoiceCallActive(false);
    abortRef.current = true;
    turnIdRef.current += 1;
    try { void sseReaderRef.current?.cancel(); } catch { /* ignore */ }
    sseReaderRef.current = null;
    try { currentSourceRef.current?.stop(); } catch { /* ignore */ }
    currentSourceRef.current = null;
    teardownMic();
    playQueueRef.current = Promise.resolve();
    setOpen(false);
    setStatus('idle');
    setTranscript('');
    setAiText('');
    setError('');
    setAvatarUrl('');
    conversationIdRef.current = null;
    parentMessageIdRef.current = NO_PARENT;
  }, [teardownMic, setVoiceCallActive, agentId, token, playHangupSound, stopCamera]);

  // Stop AI mid-speech and hand the mic back immediately.
  // July 4 2026 rewrite: supersede the turn (monotonic id — no 150ms flag
  // window to race), cancel the live SSE stream, and STOP the buffer that
  // is coming out of the speakers right now (the old version never did —
  // that's why the button "didn't work": the current sentence kept playing
  // and, if the stream was still live, the rest of the reply followed it).
  const interruptAI = useCallback(() => {
    if (streamingRef.current) {
      // Same effect as talking over her: flush local audio now, tell the
      // server to kill generation. Status follows the server's events.
      streamingEngine.barge();
      setAiText('');
      return;
    }
    turnIdRef.current += 1;
    try { void sseReaderRef.current?.cancel(); } catch { /* ignore */ }
    sseReaderRef.current = null;
    try { currentSourceRef.current?.stop(); } catch { /* already stopped */ }
    currentSourceRef.current = null;
    playQueueRef.current = Promise.resolve();
    setTimeout(() => {
      if (abortRef.current) return; // call ended meanwhile
      setAiText('');
      setStatus('listening');
      startListeningRef.current();
    }, 150);
  }, []);

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
  /* KADE July 12 2026 (her ask: "take the thinking/listening/speaking labels
   * off voiceover specifically so they don't talk over the AI"): the per-turn
   * state words are silenced for screen readers — every live-region change
   * ducks/interrupts the agent's actual voice, and the states are already
   * audible by design (typing sound = thinking, her voice = speaking, quiet =
   * your turn). Only the one-time 'Connecting' survives, so a blind caller
   * still knows the tap worked. The VISIBLE label keeps all states. */
  const srStatus =
    error                    ? '' :
    status === 'connecting'  ? 'Connecting' :
                               '';
  const visibleStatus =
    status === 'listening'   ? 'Listening' :
    status === 'thinking'    ? thinkingLabel :
    status === 'speaking'    ? 'Speaking' :
    status === 'connecting'  ? 'Connecting' :
                               'Starting';

  // KADE July 16 2026 (?kade=call): hands-free call start for the Action
  // Button / Siri path. Fires once, only when the trigger button below WOULD
  // be tappable (agent ready + mic support), and strips the param defensively
  // so a manual refresh can't re-dial. A failed deep link never breaks chat.
  useEffect(() => {
    if (!KADE_AUTO_CALL || kadeAutoCallConsumed || open) return;
    if (!agentId || !mediaAvail) return;
    kadeAutoCallConsumed = true;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('kade') === 'call') {
        params.delete('kade');
        const rest = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
      }
    } catch { /* cosmetic only */ }
    void startCall();
  }, [open, agentId, mediaAvail, startCall]);

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
          'relative mb-6 rounded-full flex items-center justify-center transition-all duration-300',
          avatarUrl ? 'h-44 w-44' : 'h-28 w-28',
          liveMode ? 'ring-4 ring-emerald-500/60' :
          status === 'listening' ? 'ring-4 ring-blue-500/40 scale-105 animate-kade-nod' :
          status === 'thinking'  ? 'ring-4 ring-amber-500/40' :
          status === 'speaking'  ? 'ring-4 ring-green-500/40 scale-110' : '',
          avatarUrl
            ? 'bg-white/5'
            : status === 'listening' ? 'bg-blue-500/20'
            : status === 'thinking'  ? 'bg-amber-500/20'
            : status === 'speaking'  ? 'bg-green-500/20'
            : 'bg-white/5',
        )}
        aria-hidden="true"
      >
        {liveMode ? (
          /* SPOTTER orb (July 16 2026): while live, a different SOMEBODY has
             the call — showing the character's face would be a lie. Emerald
             radio orb instead; the rAF pulse still breathes with the
             Spotter's voice (live PCM feeds the same analyser). */
          <div className="flex h-full w-full items-center justify-center rounded-full bg-emerald-600/25">
            <Radio size={avatarUrl ? 64 : 44} aria-hidden="true" className="text-emerald-300" />
          </div>
        ) : avatarUrl ? (
          <>
            {/* FaceTime Lite: the character's face IS the orb. The rAF
                speaking pulse scales this whole container, so the photo
                breathes with the voice. onError falls back to the orb. */}
            <img
              src={avatarUrl}
              alt=""
              draggable={false}
              onError={() => setAvatarUrl('')}
              className="h-full w-full select-none rounded-full object-cover"
            />
            <span
              className={cn(
                'absolute -bottom-1 -right-1 flex h-11 w-11 items-center justify-center rounded-full border-2 border-gray-950',
                status === 'listening' ? 'bg-blue-500/90' :
                status === 'thinking'  ? 'bg-amber-500/90' :
                status === 'speaking'  ? 'bg-green-600/90' : 'bg-gray-700/90',
              )}
            >
              {status === 'listening' && <Mic size={20} className="text-white animate-pulse" />}
              {status === 'thinking' && (
                <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              )}
              {(status === 'speaking' || status === 'idle' || status === 'connecting') && (
                <Phone size={20} className="text-white" />
              )}
            </span>
          </>
        ) : (
          <>
            {status === 'listening'  && <Mic size={44} className="text-blue-400 animate-pulse" />}
            {status === 'thinking'   && (
              <div className="h-7 w-7 rounded-full border-[3px] border-amber-400 border-t-transparent animate-spin" />
            )}
            {status === 'speaking'   && <Phone size={44} className="text-green-400" />}
            {(status === 'idle' || status === 'connecting') && <Phone size={44} className="text-gray-400" />}
          </>
        )}
      </div>

      {/* Visible status label (decorative — announced via the sr-only region) */}
      <p className="mb-6 text-sm uppercase tracking-widest text-gray-300" aria-hidden="true">
        {visibleStatus}
      </p>

      {/* Video status line — spoken politely (minutes left, on/off, cap) */}
      {videoInfo && (
        <p className="mb-3 max-w-xs px-4 text-center text-xs text-gray-300" role="status" aria-live="polite">
          {videoInfo}
        </p>
      )}

      {/* First-use video cost notice: the bridge speaks it; this is the
          visible + focusable half. Confirm actually turns the camera on. */}
      {videoNotice && (
        <div className="mb-4 w-full max-w-xs rounded-2xl bg-white/10 px-4 py-3" role="group" aria-label="Video cost notice">
          <p className="mb-3 text-sm leading-relaxed text-gray-100">{videoNotice.text}</p>
          <div className="flex gap-3">
            <button
              ref={videoConfirmRef}
              onClick={() => requestVideo(videoNotice.mode, true)}
              className="flex-1 rounded-full bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-400"
            >
              Turn camera on
            </button>
            <button
              onClick={() => { setVideoNotice(null); setVideoInfo('Video canceled.'); }}
              className="flex-1 rounded-full bg-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-gray-400"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* First-use LIVE cost notice: bridge speaks it; confirm actually starts. */}
      {liveNotice && (
        <div className="mb-4 w-full max-w-xs rounded-2xl bg-white/10 px-4 py-3" role="group" aria-label="Spotter first-use notice">
          <p className="mb-3 text-sm leading-relaxed text-gray-100">{liveNotice}</p>
          <div className="flex gap-3">
            <button
              ref={liveConfirmRef}
              onClick={() => streamingEngine.sendJson({ type: 'live', on: true, ack: true })}
              className="flex-1 rounded-full bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-400"
            >
              Put them on
            </button>
            <button
              onClick={() => { setLiveNotice(null); setVideoInfo('Okay — no Spotter this time.'); }}
              className="flex-1 rounded-full bg-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-gray-400"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* Visible error (also announced via the alert region above) */}
      {error && (
        <p className="mb-4 max-w-xs px-4 text-center text-sm text-amber-300" aria-hidden="true">
          {error}
        </p>
      )}

      {/* Live captions — VISUAL ONLY (hidden from screen readers). */}
      {liveTable != null && (
        <div className="w-full max-w-xs px-4">
          <GameTable gameId={liveTable.id} refreshKey={liveTable.seq} compact />
        </div>
      )}
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
            <span className="text-gray-100">{scrubCaption(aiText)}</span>
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

        {streamingRef.current && !liveMode && !liveNotice && (
          <button
            onClick={() => streamingEngine.sendJson({ type: 'live', on: true })}
            aria-label="Call your Spotter — your personal live companion: continuous sight, instant back-and-forth, their own voice. Has its own small daily allowance. Design them under Explore, Your Spotter."
            title="Your Spotter (live mode — continuous sight, their own voice)"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white shadow-lg transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            <Radio size={22} aria-hidden="true" />
          </button>
        )}
        {liveMode && (
          <button
            onClick={() => streamingEngine.sendJson({ type: 'live', on: false })}
            aria-label="Send your Spotter home and bring the character back"
            title="Spotter off — back to your character"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600/90 text-white shadow-lg transition-colors hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            <Radio size={22} aria-hidden="true" />
          </button>
        )}
        {streamingRef.current && !liveMode && videoMode === 'off' && !videoNotice && (
          /* ONE video button (Kade July 16: three modes confused everyone —
             now it's Video and your Spotter). Everyone gets the HQ eyes. */
          <button
            onClick={() => requestVideo('hq')}
            aria-label="Turn on video. The agent sees your rear camera with its best eyes — for describing, reading labels, and details."
            title="Video (the agent's best eyes)"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white shadow-lg transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <Camera size={22} aria-hidden="true" />
          </button>
        )}
        {videoMode !== 'off' && !liveMode && (
          <button
            onClick={turnVideoOff}
            aria-label={`Turn off video (currently ${videoMode === 'hq' ? 'HQ' : 'standard'})`}
            title="Video off"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-600/90 text-white shadow-lg transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <CameraOff size={22} aria-hidden="true" />
          </button>
        )}
        {videoMode !== 'off' && !liveMode && (
          <button
            onClick={flipCamera}
            aria-label={
              camFacingRef.current === 'environment'
                ? 'Switch to the front camera — it will see you instead of the world'
                : 'Switch to the rear camera — it will see the world instead of you'
            }
            title="Flip camera"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white shadow-lg transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <SwitchCamera size={22} aria-hidden="true" />
          </button>
        )}
        {torchAvailable && (videoMode !== 'off' || liveMode) && (
          <button
            onClick={toggleTorch}
            aria-label={
              torchOn
                ? 'Turn the flashlight off'
                : 'Turn the flashlight on — lights up whatever the camera is pointed at in the dark'
            }
            title={torchOn ? 'Flashlight off' : 'Flashlight'}
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-full text-white shadow-lg transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-400',
              torchOn ? 'bg-yellow-500/90 hover:bg-yellow-500' : 'bg-white/10 hover:bg-white/20',
            )}
          >
            {torchOn ? <FlashlightOff size={22} aria-hidden="true" /> : <Flashlight size={22} aria-hidden="true" />}
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
          ? streamingRef.current
            ? 'Just start talking to interrupt · Red to end call'
            : 'Tap amber to interrupt · Red to end call'
          : 'Red button ends the call'}
      </p>
    </div>
  );
}
