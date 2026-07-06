import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';
import { logger } from '~/utils';

/**
 * ♿ KADE — shared "audition as you browse" engine.
 *
 * Used by BOTH the agent builder's Default-voice picker (AgentVoicePicker) and
 * the Settings → Speech voice list (ExternalVoiceDropdown). Extracted from
 * AgentVoicePicker on 2026-07-05 so both surfaces play samples through the
 * identical, iOS-reliable Web Audio path (Kade browses voices in Settings →
 * Speech, so it has to work there too — not just in the builder).
 *
 * Why Web Audio and not <audio>.play(): iOS only lets a page play sound on its
 * own after a real user gesture unlocks it. A VoiceOver swipe fires `focus`,
 * NOT a gesture, and current iOS stopped honoring a stale <audio> element-unlock
 * across later focus events — so focus-driven samples went silent. An
 * AudioContext resumed inside the list-open tap stays unlocked, so buffer
 * sources can start on later focus events. Same pipeline ConversationMode uses
 * for the call voice.
 */

export const AUDITION_DEBOUNCE_MS = 200; // Kade wanted the sample to start
                                         // quickly after landing on a voice.
export const AUDITION_CACHE_MAX = 40;

/** Audition line for one voice. Prefers the proxy-served template (single
 * source of truth, `{voice}` placeholder); falls back to a matching built-in.
 * Both carry %%% emotion steering, which the proxy converts to [bracket]
 * delivery direction on the synth path — short AND performed. */
export function auditionLine(voice: string, template?: string) {
  const line =
    template ??
    "%%%warm, playful, quietly showing off%%% Hey — {voice} here! And this right here? That's exactly how I sound.";
  return line.split('{voice}').join(voice);
}

/**
 * useVoiceAudition — debounced, latest-wins, cached Web Audio sampler.
 * Returns { unlock, audition, stop, playingVoice, error }:
 *   - unlock(): call inside the tap that opens the list (arms the AudioContext).
 *   - audition(voice): call on option focus/hover (debounced play).
 *   - stop(): halt current sample (e.g. on close / focus leaving the widget).
 */
export function useVoiceAudition({ auditionTemplate, speed }: { auditionTemplate?: string; speed?: number }) {
  const { token } = useAuthContext();
  /** ONE AudioContext, unlocked inside the tap that opens the list. */
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  /** cacheKey (voice|variant|rate) -> decoded AudioBuffer */
  const cacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  /** latest-wins guard: bumping it invalidates any pending/in-flight play */
  const seqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Stop whatever buffer source is sounding. Unlike clearing an <audio> src,
   * stopping a BufferSource fires no error event. */
  const stopSource = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null;
        sourceRef.current.stop();
      } catch {
        /* already stopped */
      }
      try {
        sourceRef.current.disconnect();
      } catch {
        /* already disconnected */
      }
      sourceRef.current = null;
    }
  }, []);

  /** MUST be called inside a real user gesture (the tap that opens the list):
   * creates the context if needed and resumes it (iOS starts it suspended). */
  const unlock = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (ctxRef.current.state === 'suspended') {
      void ctxRef.current.resume().catch(() => {});
    }
  }, []);

  const stop = useCallback(() => {
    window.clearTimeout(timerRef.current);
    seqRef.current += 1;
    stopSource();
    setPlayingVoice(null);
  }, [stopSource]);

  const playNow = useCallback(
    async (voice: string) => {
      const ctx = ctxRef.current;
      if (!ctx) {
        return;
      }
      // iOS can quietly re-suspend a context between samples; nudge it awake.
      // Best-effort: if the OS refuses outside a gesture, reopening the list
      // re-arms it via unlock().
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      const seq = ++seqRef.current;
      setError(null);
      try {
        // Cache key covers the text variant AND the rate — a sample recorded
        // at 1.0 must not be replayed when the agent's rate is now 1.3.
        const cacheKey = `${voice}|${auditionTemplate ? 's' : 'f'}|${speed ?? ''}`;
        let buffer = cacheRef.current.get(cacheKey);
        if (buffer == null) {
          const fd = new FormData();
          fd.append('input', auditionLine(voice, auditionTemplate));
          fd.append('voice', voice);
          if (typeof speed === 'number') {
            fd.append('speed', String(speed));
          }
          const res = await fetch('/api/files/speech/tts/manual', {
            method: 'POST',
            body: fd,
            credentials: 'include',
            // JWT strategy reads ONLY the Authorization header (P5 lesson)
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          if (!res.ok) {
            logger.error(`[VoiceAudition] HTTP ${res.status}`);
            if (seq === seqRef.current) {
              setError(`Sample failed: server error ${res.status}.`);
            }
            return;
          }
          // Proxy returns WAV bytes regardless of declared content type (C3
          // lesson). decodeAudioData detaches its input, so hand it a copy.
          const raw = await res.arrayBuffer();
          buffer = await ctx.decodeAudioData(raw.slice(0));
          if (cacheRef.current.size >= AUDITION_CACHE_MAX) {
            const oldest = cacheRef.current.keys().next().value as string | undefined;
            if (oldest != null) {
              cacheRef.current.delete(oldest);
            }
          }
          cacheRef.current.set(cacheKey, buffer);
        }
        if (buffer == null || seq !== seqRef.current) {
          return; // decode produced nothing, or user moved to another voice
        }
        stopSource();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => {
          if (seq === seqRef.current) {
            setPlayingVoice(null);
          }
        };
        sourceRef.current = src;
        src.start();
        setPlayingVoice(voice);
      } catch (err) {
        logger.error('[VoiceAudition] play failed:', err);
        if (seq === seqRef.current) {
          setError('Sample failed: this device could not play the audio.');
        }
      }
    },
    [token, auditionTemplate, speed, stopSource],
  );

  /** Debounced audition — call on option focus/hover. Rapid movement through
   * the list only plays the voice the user actually rests on. */
  const audition = useCallback(
    (voice: string) => {
      window.clearTimeout(timerRef.current);
      seqRef.current += 1;
      timerRef.current = window.setTimeout(() => {
        void playNow(voice);
      }, AUDITION_DEBOUNCE_MS);
    },
    [playNow],
  );

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      window.clearTimeout(timerRef.current);
      seqRef.current += 1;
      if (sourceRef.current) {
        try {
          sourceRef.current.onended = null;
          sourceRef.current.stop();
        } catch {
          /* already stopped */
        }
        sourceRef.current = null;
      }
      cache.clear();
      if (ctxRef.current) {
        void ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
    };
  }, []);

  return { unlock, audition, stop, playingVoice, error };
}
