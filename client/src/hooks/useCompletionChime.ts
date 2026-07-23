import { useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { useLiveAnnouncer } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

/**
 * KADE July 2 2026 — soft two-note chime when a reply finishes generating.
 * Accessibility-first: a blind user (or anyone tabbed away) knows the answer
 * is ready without re-polling the screen reader or watching the spinner.
 *
 * KADE July 4 2026 — screen-reader status announcements ride the same
 * transition (her report: "NVDA doesn't see the progress thing... I never
 * know when he's done"). Polite live region, always on: "Working on a
 * reply" at start, ONE non-repeating "Still generating" reassurance on a
 * long turn (July 13 2026: the old every-25s repeat read as obsessive to
 * the screen reader, per Kade), "Reply ready" at the end. Invisible to NVDA;
 * this is the non-visual twin of the Cowork-style progress feel.
 *
 * KADE July 22 2026 — the chime grew into her real chat sound kit (files she
 * recorded herself, masters in her folder's ui_sounds/):
 *   chat-sent.mp3          one-shot the instant a message is submitted
 *   chat-thinking-loop.wav quiet bubbling loop through the whole "working on
 *                          it" stretch (starts after a 500ms grace so snappy
 *                          replies never blip it — same tuned delay as
 *                          ConversationMode's call-side loop)
 *   chat-received.mp3      one-shot when the reply finishes (replaces the old
 *                          synth two-note chime; that oscillator remains ONLY
 *                          as the fail-soft fallback if the mp3 can't load)
 * All three ride the SAME `chimeOnCompletion` setting (Settings → General →
 * Accessibility, relabeled "Chat sounds"), which is now DEFAULT ON with the
 * toggle as the opt-out — Kade's July 22 call. The localStorage key keeps its
 * old name so anyone who already opted out stays opted out.
 * Screen-reader announcements are independent of the toggle, exactly as before.
 */
let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      return null;
    }
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') {
      // resume() needs a prior user gesture; sending the message was one.
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/** Old synth chime — kept verbatim as the fallback if chat-received.mp3
 *  ever fails to fetch/decode. Never let a sound effect break the chat. */
function playChime() {
  try {
    const ctx = getCtx();
    if (!ctx) {
      return;
    }
    const t0 = ctx.currentTime;
    [523.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {
    // never let a sound effect break the chat
  }
}

const SOUND_URLS: Record<string, string> = {
  sent: '/assets/sounds/chat-sent.mp3',
  received: '/assets/sounds/chat-received.mp3',
  thinking: '/assets/sounds/chat-thinking-loop.wav',
};

/** First-pass gains, tuned against each file's measured level (Sent peaks
 *  −4.7 dBFS = hot, the loop sits at −31 dBFS RMS = soft by design). One
 *  constant each — retune by ear here, nowhere else. */
const SOUND_GAINS: Record<string, number> = {
  sent: 0.5,
  received: 0.8,
  thinking: 0.55,
};

/** Matches ConversationMode's tuned call-side delay: ordinary fast replies
 *  never trigger even a blip of the loop. */
const THINKING_START_DELAY_MS = 500;

const soundBuffers: Record<string, AudioBuffer | undefined> = {};
const soundLoads: Record<string, Promise<AudioBuffer | null> | undefined> = {};

function loadSound(name: string): Promise<AudioBuffer | null> {
  const cached = soundBuffers[name];
  if (cached) {
    return Promise.resolve(cached);
  }
  const inFlight = soundLoads[name];
  if (inFlight) {
    return inFlight;
  }
  const ctx = getCtx();
  if (!ctx) {
    return Promise.resolve(null);
  }
  const p = (async () => {
    try {
      const resp = await fetch(SOUND_URLS[name]);
      const raw = await resp.arrayBuffer();
      const decoded = await ctx.decodeAudioData(raw);
      soundBuffers[name] = decoded;
      return decoded;
    } catch (err) {
      console.warn(`[chat-sounds] failed to load "${name}":`, err);
      soundLoads[name] = undefined; // allow a retry next time
      return null;
    }
  })();
  soundLoads[name] = p;
  return p;
}

/** Play a one-shot; resolves false when it couldn't (caller may fall back). */
async function playOneShot(name: string): Promise<boolean> {
  try {
    const ctx = getCtx();
    if (!ctx) {
      return false;
    }
    const buffer = await loadSound(name);
    if (!buffer) {
      return false;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = SOUND_GAINS[name] ?? 0.5;
    src.connect(gain).connect(ctx.destination);
    src.start();
    return true;
  } catch {
    return false;
  }
}

/* July 13 2026: fires ONCE after this delay (was a repeating 25s interval). */
const STILL_WORKING_DELAY_MS = 30000;

export default function useCompletionChime(isSubmitting: boolean) {
  const enabled = useRecoilValue(store.chimeOnCompletion);
  const { announcePolite } = useLiveAnnouncer();
  const localize = useLocalize();
  const wasSubmitting = useRef(false);
  const submittingRef = useRef(false);
  const thinkingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const thinkingGainRef = useRef<GainNode | null>(null);

  const stopThinkingLoop = () => {
    if (thinkingDelayRef.current != null) {
      clearTimeout(thinkingDelayRef.current);
      thinkingDelayRef.current = null;
    }
    const src = thinkingSourceRef.current;
    const gain = thinkingGainRef.current;
    thinkingSourceRef.current = null;
    thinkingGainRef.current = null;
    if (!src) {
      return;
    }
    try {
      const ctx = audioCtx;
      if (ctx && gain) {
        // Short fade-out so the loop never clicks off mid-bubble.
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0.0001, t + 0.18);
        src.stop(t + 0.2);
      } else {
        src.stop();
      }
    } catch {
      // already stopped
    }
  };

  const startThinkingLoop = () => {
    thinkingDelayRef.current = setTimeout(async () => {
      thinkingDelayRef.current = null;
      const ctx = getCtx();
      if (!ctx) {
        return;
      }
      const buffer = await loadSound('thinking');
      // Reply may have landed (or chat unmounted) while we were loading.
      if (!buffer || !submittingRef.current || thinkingSourceRef.current) {
        return;
      }
      try {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const gain = ctx.createGain();
        const target = SOUND_GAINS.thinking ?? 0.5;
        const t = ctx.currentTime;
        // Gentle fade-in: background texture, not a sound effect.
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(target, t + 0.15);
        src.connect(gain).connect(ctx.destination);
        src.start();
        thinkingSourceRef.current = src;
        thinkingGainRef.current = gain;
      } catch (err) {
        console.warn('[chat-sounds] thinking loop error:', err);
      }
    }, THINKING_START_DELAY_MS);
  };

  useEffect(() => {
    submittingRef.current = isSubmitting;
    if (isSubmitting) {
      announcePolite({ message: localize('com_ui_reply_working'), isStatus: true });
      const t = setTimeout(() => {
        announcePolite({ message: localize('com_ui_reply_still_working'), isStatus: true });
      }, STILL_WORKING_DELAY_MS);
      if (enabled) {
        void playOneShot('sent');
        startThinkingLoop();
      }
      return () => {
        clearTimeout(t);
        stopThinkingLoop();
      };
    }
    if (wasSubmitting.current) {
      stopThinkingLoop();
      announcePolite({ message: localize('com_ui_reply_finished'), isStatus: true });
      if (enabled) {
        void playOneShot('received').then((ok) => {
          if (!ok) {
            playChime();
          }
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting]);

  useEffect(() => {
    wasSubmitting.current = isSubmitting;
  }, [isSubmitting]);

  // Unmount safety: never leave the loop bubbling after the chat view goes away.
  useEffect(() => stopThinkingLoop, []); // eslint-disable-line react-hooks/exhaustive-deps
}
