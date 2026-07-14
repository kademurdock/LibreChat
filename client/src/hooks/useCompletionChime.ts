import { useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { useLiveAnnouncer } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

/**
 * KADE July 2 2026 — soft two-note chime when a reply finishes generating.
 * Accessibility-first: a blind user (or anyone tabbed away) knows the answer
 * is ready without re-polling the screen reader or watching the spinner.
 * Off by default; Settings → General → Accessibility → "Chime when a reply
 * finishes". WebAudio oscillator, no audio asset, fail-soft everywhere.
 *
 * KADE July 4 2026 — screen-reader status announcements ride the same
 * transition (her report: "NVDA doesn't see the progress thing... I never
 * know when he's done"). Polite live region, always on: "Working on a
 * reply" at start, ONE non-repeating "Still generating" reassurance on a
 * long turn (July 13 2026: the old every-25s repeat read as obsessive to
 * the screen reader, per Kade), "Reply ready" at the end. Invisible to NVDA;
 * this is the non-visual twin of the Cowork-style progress feel.
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

/* July 13 2026: fires ONCE after this delay (was a repeating 25s interval). */
const STILL_WORKING_DELAY_MS = 30000;

export default function useCompletionChime(isSubmitting: boolean) {
  const enabled = useRecoilValue(store.chimeOnCompletion);
  const { announcePolite } = useLiveAnnouncer();
  const localize = useLocalize();
  const wasSubmitting = useRef(false);

  useEffect(() => {
    if (isSubmitting) {
      announcePolite({ message: localize('com_ui_reply_working'), isStatus: true });
      const t = setTimeout(() => {
        announcePolite({ message: localize('com_ui_reply_still_working'), isStatus: true });
      }, STILL_WORKING_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (wasSubmitting.current) {
      announcePolite({ message: localize('com_ui_reply_finished'), isStatus: true });
      if (enabled) {
        playChime();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting]);

  useEffect(() => {
    wasSubmitting.current = isSubmitting;
  }, [isSubmitting]);
}
