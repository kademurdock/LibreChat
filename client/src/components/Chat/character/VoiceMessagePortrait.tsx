import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useGetAgentByIdQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { voicePlayback } from './voice-playback.mjs';
import { createPortraitRig, hasPreparedPortrait } from './portrait-rig.mjs';
import CharacterMotion from './character-motion.mjs';
import { voiceMessagePose } from './voice-message-motion.mjs';
import { useVoicePortraitPreference } from './useVoicePortraitPreference';

export default function VoiceMessagePortrait({
  messageId,
  agentId,
}: {
  messageId: string;
  agentId?: string | null;
}) {
  const playback = useSyncExternalStore(voicePlayback.subscribe, voicePlayback.snapshot);
  const [enabled] = useVoicePortraitPreference();
  const selected = enabled && playback?.messageId === messageId;
  const { data: agent } = useGetAgentByIdQuery(agentId, { enabled: selected });
  if (!selected || !agentId || !agent) return null;
  const path = agent.avatar?.filepath;
  if (!path) return null;
  return <PortraitSurface key={agentId + path} playback={playback} agentId={agentId} path={path} />;
}

function PortraitSurface({
  playback,
  agentId,
  path,
}: {
  playback: any;
  agentId: string;
  path: string;
}) {
  const localize = useLocalize();
  const [playError, setPlayError] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshRef.current?.();
  }, [playback.phase]);
  const element = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(playback);
  latest.current = playback;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (failed || !element.current || !canvas.current) return;
    const surface = element.current,
      target = canvas.current;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false,
      inView = true,
      frame = 0,
      lastTick = 0;
    let rig: ReturnType<typeof createPortraitRig> | undefined;
    let envelope: { levels: Float32Array; step: number } | undefined;
    let source = '',
      generation = 0;
    const abort = new AbortController();
    const prepared = hasPreparedPortrait(agentId, path);
    async function readEnvelope(audio: HTMLAudioElement) {
      const src = audio.currentSrc || audio.src;
      if (source === src || !src.startsWith('blob:')) return;
      source = src;
      envelope = undefined;
      const mine = ++generation;
      // Decode a bounded copy of an existing local blob. Never re-route the
      // element through WebAudio: failed animation must never silence playback.
      try {
        const response = await fetch(src, { signal: abort.signal });
        const blob = await response.blob();
        if (blob.size > 12 * 1024 * 1024 || disposed) return;
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
      const audio = value.audio as HTMLAudioElement;
      const active =
        usable &&
        value.phase === 'playing' &&
        !audio.paused &&
        !audio.ended &&
        audio.readyState >= 3;
      if (usable && prepared && !rig)
        rig = createPortraitRig(target, {
          id: agentId,
          portrait: '/assets/characters/kiana/portrait.png',
          atlas: '/assets/characters/kiana/facial-source.png',
          blink: '/assets/characters/kiana/eyes-closed.png',
        });
      if (usable && prepared) void readEnvelope(audio);
      const level = envelope?.levels[Math.floor(audio.currentTime / envelope.step)] || 0;
      const pose = voiceMessagePose({ id: agentId, time: audio.currentTime, level, active });
      rig?.render(pose);
      surface.style.transform = `rotate(${pose.tilt}deg) translateY(${pose.nod}px)`;
      // Rig also moves its canvas; neutralize the duplicate transform.
      target.style.transform = '';
      lastTick = now;
      if (usable && value.phase === 'playing') frame = requestAnimationFrame(loop);
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
    const audio = playback.audio as HTMLAudioElement;
    for (const event of ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended'])
      audio.addEventListener(event, refresh);
    motion.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      refreshRef.current = null;
      disposed = true;
      generation++;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      rig?.dispose();
      for (const event of ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended'])
        audio.removeEventListener(event, refresh);
      motion.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [agentId, path, playback.audio, failed]);
  if (failed) return null;
  return (
    <div className="my-3 w-44 max-w-full rounded-3xl bg-surface-secondary p-1.5">
      <div aria-hidden="true" className="pointer-events-none">
        <div ref={element} className="relative aspect-square overflow-hidden rounded-2xl">
          <img
            src={path}
            alt=""
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
          <canvas hidden ref={canvas} aria-hidden="true" className="absolute inset-0 h-full w-full" />
        </div>
      </div>
      <button
        type="button"
        className="mt-1 min-h-[44px] w-full rounded-xl px-3 text-text-primary focus-visible:outline focus-visible:outline-2"
        onClick={() => {
          setPlayError(false);
          if (playback.audio.paused) void playback.audio.play().catch(() => setPlayError(true));
          else playback.audio.pause();
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
