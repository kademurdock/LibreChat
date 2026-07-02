import { useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import store from '~/store';

/**
 * KADE July 2 2026 — soft two-note chime when a reply finishes generating.
 * Accessibility-first: a blind user (or anyone tabbed away) knows the answer
 * is ready without re-polling the screen reader or watching the spinner.
 * Off by default; Settings → General → Accessibility → "Chime when a reply
 * finishes". WebAudio oscillator, no audio asset, fail-soft everywhere.
 */
let audioCtx: AudioContext | null = null;

function playChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      return;
    }
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') {
      // resume() needs a prior user gesture; sending the message was one.
      audioCtx.resume().catch(() => {});
    }
    const t0 = audioCtx.currentTime;
    [523.25, 783.99].forEach((freq, i) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {
    // never let a sound effect break the chat
  }
}

export default function useCompletionChime(isSubmitting: boolean) {
  const enabled = useRecoilValue(store.chimeOnCompletion);
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (wasSubmitting.current && !isSubmitting && enabled) {
      playChime();
    }
    wasSubmitting.current = isSubmitting;
  }, [isSubmitting, enabled]);
}
