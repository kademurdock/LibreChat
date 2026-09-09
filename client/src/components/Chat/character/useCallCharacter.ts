import { useCallback, useEffect, useRef, useState } from 'react';
import { createCallCharacter } from './adapter.mjs';
import { createPortraitRig, hasPreparedPortrait } from './portrait-rig.mjs';
import type { CallPresentation, PresentationStatus } from './playback';

const STORAGE_KEY = 'kadeCharacterMotion';

export default function useCallCharacter({ open, agentId, avatarUrl, liveMode, status }: {
  open: boolean; agentId: string | null | undefined; avatarUrl: string;
  liveMode: boolean; status: PresentationStatus;
}) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(agentId ?? null);
  const adapter = useRef<ReturnType<typeof createCallCharacter> | null>(null);
  const applyPreferences = useRef<(() => void) | null>(null);
  const latest = useRef({ status, enabled, liveMode });
  latest.current = { status, enabled, liveMode };
  const [presentation] = useState<CallPresentation>(() => ({
    select: id => adapter.current?.select(id),
    scheduled: segment => adapter.current?.scheduled(segment),
    clear: () => adapter.current?.clear(),
    status: value => adapter.current?.status(value),
  }));
  const toggle = useCallback((value: boolean) => {
    setEnabled(value);
    try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0'); } catch { /* session still works */ }
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setEnabled(event.newValue === '1');
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    setSpeaker(agentId ?? null);
    if (!open) return;
    let prepared = false;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rig: ReturnType<typeof createPortraitRig> | undefined;
    let currentSpeaker: string | null = agentId ?? null;
    const player = createCallCharacter({
      resolveProfile: (id: string | null) => ({ id: id || 'unknown',
        rigReady: prepared && id === agentId, tiltDegrees: .7, nodDegrees: .5 }),
      render: (frame: { characterId: string }) => {
        const id = frame.characterId === 'unknown' ? null : frame.characterId;
        if (id !== currentSpeaker) { currentSpeaker=id; setSpeaker(id); }
        rig?.render(frame);
      },
      requestFrame: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
      cancelFrame: (id: number) => cancelAnimationFrame(id),
    });
    adapter.current=player;
    const preferences = () => {
      const visible = !document.hidden && !latest.current.liveMode;
      player.preferences({ enabled: latest.current.enabled, reducedMotion: motion.matches, visible });
      // Only a currently authorized portrait can load artwork, and only when
      // motion is usable. Off/reduced/hidden calls do not fetch the rig assets.
      if (!rig && canvas && visible && latest.current.enabled && !motion.matches && hasPreparedPortrait(agentId, avatarUrl)) {
        rig = createPortraitRig(canvas, { id: agentId, portrait: '/assets/characters/kiana/portrait.png',
          atlas: '/assets/characters/kiana/facial-source.png', blink: '/assets/characters/kiana/eyes-closed.png',
          onReady: () => { prepared = true; player.refreshProfile(); },
        });
      }
    };
    applyPreferences.current = preferences;
    player.select(agentId ?? null); preferences(); player.status(latest.current.status);
    motion.addEventListener('change',preferences);
    document.addEventListener('visibilitychange',preferences);
    return () => {
      motion.removeEventListener('change',preferences); document.removeEventListener('visibilitychange',preferences);
      if (adapter.current === player) adapter.current=null;
      if (applyPreferences.current === preferences) applyPreferences.current = null;
      player.dispose(); rig?.dispose();
    };
  }, [open, agentId, avatarUrl, canvas]);
  useEffect(() => {
    applyPreferences.current?.();
  }, [enabled, liveMode]);
  return { presentation, enabled, toggle, setCanvas,
    showPortrait: speaker === (agentId ?? null) && !liveMode };
}
