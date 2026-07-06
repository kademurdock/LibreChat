import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';
import { logger } from '~/utils';

/**
 * ♿ KADE — shared "audition as you browse" engine (Web Audio).
 *
 * Used by the Settings → Speech voice list (ExternalVoiceDropdown). The agent
 * builder keeps its own inline copy for now (deliberately NOT migrated here so
 * this Settings work can't disturb the known-good builder picker).
 *
 * Why Web Audio, not <audio>.play(): iOS only lets a page play sound on its own
 * after a real gesture unlocks it. A VoiceOver swipe fires `focus`, NOT a
 * gesture, and current iOS stopped honoring a stale <audio> element-unlock
 * across focus events — so focus-driven samples went silent. An AudioContext
 * resumed inside the list-open tap stays unlocked, so buffer sources start on
 * later focus events. Same pipeline ConversationMode uses for the call voice.
 */

export const AUDITION_DEBOUNCE_MS = 200;
export const AUDITION_CACHE_MAX = 40;

/** Audition line for one voice. Prefers the proxy-served template (`{voice}`
 * placeholder); falls back to a built-in. Both carry %%% emotion steering the
 * proxy converts to [bracket] delivery direction — short AND performed. */
export function auditionLine(voice: string, template?: string) {
  const line =
    template ??
    "%%%warm, playful, quietly showing off%%% Hey — {voice} here! And this right here? That's exactly how I sound.";
  return line.split('{voice}').join(voice);
}

export function useVoiceAudition({ auditionTemplate, speed }: { auditionTemplate?: string; speed?: number }) {
  const { token } = useAuthContext();
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const cacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const seqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  /** MUST be called inside a real user gesture (the tap that opens the list). */
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
    setPlayingVoice((prev) => (prev === null ? prev : null));
  }, [stopSource]);

  const playNow = useCallback(
    async (voice: string) => {
      const ctx = ctxRef.current;
      if (!ctx) {
        return;
      }
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      const seq = ++seqRef.current;
      setError(null);
      try {
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
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          if (!res.ok) {
            logger.error(`[VoiceAudition] HTTP ${res.status}`);
            if (seq === seqRef.current) {
              setError(`Sample failed: server error ${res.status}.`);
            }
            return;
          }
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
          return;
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
