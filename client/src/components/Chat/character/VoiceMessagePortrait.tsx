import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VoicePlayback } from './voice-playback.mjs';
import { useGetAgentByIdQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { voicePlayback } from './voice-playback.mjs';
import { createPortraitRig, preparedPortrait } from './portrait-rig.mjs';
import CharacterMotion from './character-motion.mjs';
import { voiceMessagePose, expressionSchedule } from './voice-message-motion.mjs';
import { useVoicePortraitPreference } from './useVoicePortraitPreference';
import { characterAppearanceKey } from './appearance';

const phaseLabels = {
  paused: 'com_ui_voice_portrait_paused',
  waiting: 'com_ui_voice_portrait_waiting',
  playing: 'com_ui_voice_portrait_playing',
} as const;

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
  const { data: agent } = useGetAgentByIdQuery(agentId, { enabled: selected });
  if (!selected || !playback || !agentId || !agent) return null;
  const path = agent.avatar?.filepath;
  if (!path) return null;
  if (!enabled && !characterAppearanceKey(agentId, path)) return null;
  return (
    <PortraitSurface
      key={agentId + path}
      playback={playback}
      agentId={agentId}
      path={path}
      enabled={enabled}
      name={agent.name ?? ''}
      text={text ?? ''}
    />
  );
}

function PortraitSurface({
  playback,
  agentId,
  path,
  enabled,
  name,
  text,
}: {
  playback: VoicePlayback;
  agentId: string;
  path: string;
  enabled: boolean;
  name: string;
  text: string;
}) {
  const localize = useLocalize();
  const appearanceKey = characterAppearanceKey(agentId, path);
  const [playError, setPlayError] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshRef.current?.();
    setPlayError(false);
  }, [playback.phase]);
  const element = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(playback);
  latest.current = playback;
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
    if (!enabled || failed || !element.current || !canvas.current) return;
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
    const prepared = preparedPortrait(agentId, path);
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
        /* streaming/unsupported blobs keep a closed mouth */
      }
    }
    function tick(now: number) {
      frame = 0;
      if (disposed) return;
      const usable = inView && !document.hidden && !motion.matches;
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
      if (usable && prepared && !rig && !rigFailed)
        rig = createPortraitRig(target, {
          id: agentId,
          ...prepared,
          onFailure: () => {
            rigFailed = true;
            refresh();
          },
        });
      if (usable && prepared) void readEnvelope(audio);
      const level = envelope?.levels[Math.floor(audio.currentTime / envelope.step)] || 0;
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
        sibilance: envelope?.sibilance?.[Math.floor(audio.currentTime / envelope.step)] || 0,
        active,
        cues: schedule.current.cues,
      });
      rig?.render(pose);
      surface.style.transform = `rotate(${pose.tilt}deg) translateY(${pose.nod}px)`;
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
  }, [agentId, path, playback.audio, failed, enabled]);
  return (
    <div
      className="my-3 max-w-full rounded-3xl border border-border-light bg-surface-secondary p-2.5 shadow-sm"
      style={{ width: '16rem' }}
    >
      <div aria-hidden="true" className="flex items-center justify-between gap-2 px-1 pb-2 text-sm">
        <span className="truncate font-medium text-text-primary">{name}</span>
        <span className="shrink-0 text-xs text-text-secondary">
          {localize(phaseLabels[playback.phase])}
        </span>
      </div>
      {enabled && !failed && (
        <div aria-hidden="true" className="pointer-events-none">
          <div ref={element} className="relative aspect-square overflow-hidden rounded-2xl">
            <img
              src={path}
              alt=""
              onError={() => setFailed(true)}
              className="h-full w-full object-cover"
            />
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
      {appearanceKey && (
        <details className="rounded-xl px-3 text-sm text-text-primary">
          <summary className="min-h-[44px] cursor-pointer py-3 focus-visible:outline focus-visible:outline-2">
            {localize('com_ui_character_describe')}
          </summary>
          <p className="pb-3 leading-relaxed">{localize(appearanceKey)}</p>
        </details>
      )}
      {playError && <p role="status">{localize('com_ui_voice_portrait_play_error')}</p>}
    </div>
  );
}
