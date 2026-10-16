import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VoicePlayback } from './voice-playback.mjs';
import { useLiveAnnouncer } from '~/Providers';
import { useLocalize } from '~/hooks';
import { voicePlayback } from './voice-playback.mjs';
import { createPortraitRig } from './portrait-rig.mjs';
import CharacterMotion from './character-motion.mjs';
import {
  voiceMessagePose,
  expressionSchedule,
  syllableLevel,
  textSeed,
} from './voice-message-motion.mjs';
import { useVoicePortraitPreference } from './useVoicePortraitPreference';
import { useCharacterLook } from './useCharacterLook';

const phaseLabels = {
  paused: 'com_ui_voice_portrait_paused',
  waiting: 'com_ui_voice_portrait_waiting',
  playing: 'com_ui_voice_portrait_playing',
} as const;

type PortraitPlan = NonNullable<ReturnType<typeof useCharacterLook>['plan']>;

export default function VoiceMessagePortrait({
  messageId,
  agentId,
  text,
}: {
  messageId: string;
  agentId?: string | null;
  text?: string;
}) {
  const playback = useSyncExternalStore(voicePlayback.subscribe, voicePlayback.snapshot);
  const [enabled] = useVoicePortraitPreference();
  const selected = playback?.messageId === messageId;
  const { agent, path, plan } = useCharacterLook(agentId, selected && enabled);
  // The description lives on the message (CharacterDescription), so with animation off
  // there is nothing for this card to carry.
  if (!enabled || !selected || !playback || !agentId || !agent) return null;
  if (!path && !plan) return null;
  return (
    <PortraitSurface
      key={agentId + path}
      playback={playback}
      messageId={messageId}
      agentId={agentId}
      path={path}
      plan={plan}
      name={agent.name ?? ''}
      text={text ?? ''}
    />
  );
}

function PortraitSurface({
  playback,
  messageId,
  agentId,
  path,
  plan,
  name,
  text,
}: {
  playback: VoicePlayback;
  messageId: string;
  agentId: string;
  path: string;
  plan: PortraitPlan | null;
  name: string;
  text: string;
}) {
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();
  const [playError, setPlayError] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshRef.current?.();
    setPlayError(false);
  }, [playback.phase]);
  const root = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fallbackImage = useRef<HTMLImageElement>(null);
  const latest = useRef(playback);
  latest.current = playback;
  const words = useRef({ localize, announcePolite });
  words.current = { localize, announcePolite };
  // The card goes when its clip ends. If keyboard or screen-reader focus is inside it,
  // hand focus to something that stays on the message (its description, else the message
  // itself) before the card leaves, instead of letting it fall to the top of the page.
  useLayoutEffect(() => {
    const card = root.current;
    return () => {
      if (!card || !card.contains(document.activeElement)) return;
      const message = document.getElementById(messageId);
      const summary = document.querySelector<HTMLElement>(
        `[data-character-description="${CSS.escape(messageId)}"] summary`,
      );
      const target = summary ?? message;
      if (target === message && message && !message.hasAttribute('tabindex'))
        message.setAttribute('tabindex', '-1');
      target?.focus({ preventScroll: true });
      if (!voicePlayback.snapshot()) {
        const { localize: say, announcePolite: announce } = words.current;
        const message = say('com_ui_voice_portrait_finished');
        setTimeout(() => announce({ message, isStatus: true }), 0);
      }
    };
  }, [messageId]);
  // The character's own %%%directions%%%, placed along the audio once its
  // length is known (and again if a streamed file's length arrives late).
  const spoken = useRef(text);
  spoken.current = text;
  const schedule = useRef<{
    text: string;
    duration: number;
    cues: ReturnType<typeof expressionSchedule>;
  }>({
    text: '',
    duration: -1,
    cues: [],
  });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (failed || !element.current || !canvas.current) return;
    const surface = element.current,
      target = canvas.current;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false,
      inView = true,
      rigFailed = false,
      frame = 0,
      lastTick = 0;
    let rig: ReturnType<typeof createPortraitRig> | undefined;
    let envelope: { levels: Float32Array; sibilance?: Float32Array; step: number } | undefined;
    let source = '',
      generation = 0;
    let abort: AbortController | undefined;
    const prepared = plan;
    // A puppet has no matching picture underneath, so it stays drawn (as a still) when the
    // other rigs would hide and leave the photo: paused, reduced motion.
    const selfDrawn = !!prepared && 'vector' in prepared && prepared.vector === 'puppet';
    const seed = textSeed(messageId);
    async function readEnvelope(audio: HTMLAudioElement) {
      const src = audio.currentSrc || audio.src;
      if (source === src) return;
      abort?.abort();
      source = src;
      envelope = undefined;
      const mine = ++generation;
      if (!src.startsWith('blob:')) return;
      abort = new AbortController();
      // Decode a bounded copy of an existing local blob. Never re-route the
      // element through WebAudio: failed animation must never silence playback.
      try {
        const response = await fetch(src, { signal: abort.signal });
        if (!response.ok) return;
        const blob = await response.blob();
        if (blob.size > 12 * 1024 * 1024 || disposed || mine !== generation) return;
        const context = new OfflineAudioContext(1, 1, 24000);
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        if (!disposed && mine === generation) envelope = CharacterMotion.envelope(decoded);
      } catch {
        /* streaming (MediaSource) and unsupported blobs talk with the syllable stand-in */
      }
    }
    function tick(now: number) {
      frame = 0;
      if (disposed) return;
      const visible = inView && !document.hidden;
      const usable = visible && !motion.matches;
      const value = latest.current;
      const audio = value.audio;
      const active =
        usable &&
        !!prepared &&
        !rigFailed &&
        value.phase === 'playing' &&
        !audio.paused &&
        !audio.ended &&
        !audio.seeking &&
        audio.readyState >= 3;
      if ((usable || (selfDrawn && visible)) && prepared && !rig && !rigFailed)
        rig = createPortraitRig(target, {
          id: agentId,
          ...prepared,
          onFailure: () => {
            rigFailed = true;
            refresh();
          },
          onVisibilityChange: (show) => {
            if (fallbackImage.current)
              fallbackImage.current.style.visibility = show ? 'hidden' : '';
          },
        });
      if (usable && prepared) void readEnvelope(audio);
      const at = envelope ? Math.floor(audio.currentTime / envelope.step) : 0;
      const level = envelope ? envelope.levels[at] || 0 : syllableLevel(audio.currentTime, seed);
      const length = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (schedule.current.text !== spoken.current || schedule.current.duration !== length)
        schedule.current = {
          text: spoken.current,
          duration: length,
          cues: expressionSchedule(spoken.current, length),
        };
      const pose = voiceMessagePose({
        id: agentId,
        time: audio.currentTime,
        level,
        sibilance: envelope?.sibilance?.[at] || 0,
        active,
        cues: schedule.current.cues,
      });
      rig?.render(pose);
      // Vector rigs (Angel, puppets) move their own head; the others sway the card.
      surface.style.transform =
        prepared && 'vector' in prepared ? '' : `rotate(${pose.tilt}deg) translateY(${pose.nod}px)`;
      // Rig also moves its canvas; neutralize the duplicate transform.
      target.style.transform = '';
      lastTick = now;
      if (active) frame = requestAnimationFrame(loop);
    }
    function loop(now: number) {
      if (now - lastTick < 1000 / 24) {
        frame = requestAnimationFrame(loop);
        return;
      }
      tick(now);
    }
    function refresh() {
      cancelAnimationFrame(frame);
      tick(performance.now());
    }
    refreshRef.current = refresh;
    const observer = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? false;
      refresh();
    });
    observer.observe(surface);
    const audio = playback.audio;
    const events = [
      'playing',
      'pause',
      'waiting',
      'seeking',
      'seeked',
      'ended',
      'emptied',
      'loadstart',
    ];
    for (const event of events) audio.addEventListener(event, refresh);
    motion.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      refreshRef.current = null;
      disposed = true;
      generation++;
      abort?.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      rig?.dispose();
      for (const event of events) audio.removeEventListener(event, refresh);
      motion.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // `plan` is rebuilt only when the agent, its avatar or its body changes (useMemo).
  }, [agentId, messageId, path, plan, playback.audio, failed]);
  return (
    <div
      ref={root}
      className="my-3 max-w-full rounded-3xl border border-border-light bg-surface-secondary p-2.5 shadow-sm"
      style={{ width: '16rem' }}
    >
      <div aria-hidden="true" className="flex items-center justify-between gap-2 px-1 pb-2 text-sm">
        <span className="truncate font-medium text-text-primary">{name}</span>
        <span className="shrink-0 text-xs text-text-secondary">
          {localize(phaseLabels[playback.phase])}
        </span>
      </div>
      {!failed && (
        <div aria-hidden="true" className="pointer-events-none">
          <div ref={element} className="relative aspect-square overflow-hidden rounded-2xl">
            {path && (
              <img
                ref={fallbackImage}
                src={path}
                alt=""
                onError={() => setFailed(true)}
                className="h-full w-full object-cover"
              />
            )}
            <canvas
              hidden
              ref={canvas}
              aria-hidden="true"
              className="absolute inset-0 h-full w-full"
            />
          </div>
        </div>
      )}
      <button
        type="button"
        className="mt-1 min-h-[44px] w-full rounded-xl px-3 text-text-primary focus-visible:outline focus-visible:outline-2"
        onClick={() => {
          setPlayError(false);
          if (playback.audio.paused) {
            const requested = playback;
            void requested.audio.play().catch(() => {
              if (latest.current.audio === requested.audio && requested.audio.paused)
                setPlayError(true);
            });
          } else playback.audio.pause();
        }}
      >
        {localize(
          playback.phase === 'paused'
            ? 'com_ui_voice_portrait_resume'
            : 'com_ui_voice_portrait_pause',
        )}
      </button>
      {playError && <p role="status">{localize('com_ui_voice_portrait_play_error')}</p>}
    </div>
  );
}
