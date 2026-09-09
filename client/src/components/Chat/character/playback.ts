import type { CharacterCue } from './metadata';

export type PresentationStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface PlaybackSegment {
  buffer: AudioBuffer;
  start: number;
  clock: () => number;
  speech: boolean;
  agentId?: string | null;
  cues?: CharacterCue[];
}

/** Presentation observers never own audio, captions, microphone access or call state. */
export interface CallPresentation {
  scheduled(segment: PlaybackSegment): (() => void) | void;
  clear(): void;
  status(status: PresentationStatus): void;
  select(agentId: string | null): void;
}

/** A stable call-scoped handle follows replacement renderers without stale closures. */
export function createPresentationRelay(
  current: () => CallPresentation | undefined,
): CallPresentation {
  return {
    scheduled: (segment) => current()?.scheduled(segment),
    clear: () => current()?.clear(),
    status: (status) => current()?.status(status),
    select: (agentId) => current()?.select(agentId),
  };
}

export function presentationStatus(
  observer: CallPresentation | undefined,
  status: PresentationStatus,
) {
  try {
    observer?.status(status);
  } catch {
    /* Presentation cannot interrupt a call. */
  }
}

export function clearPresentation(observer: CallPresentation | undefined) {
  try {
    observer?.clear();
  } catch {
    /* Presentation cannot interrupt a call. */
  }
}

export function selectPresentation(observer: CallPresentation | undefined, agentId: string | null) {
  try {
    observer?.select(agentId);
  } catch {
    /* Keep the existing portrait. */
  }
}

/** Call only after source.start succeeds. Leaves the caller's onended handler intact. */
export function observePlayback(
  observer: CallPresentation | undefined,
  source: AudioBufferSourceNode,
  segment: PlaybackSegment,
) {
  try {
    const ended = observer?.scheduled(segment);
    if (ended)
      source.addEventListener(
        'ended',
        () => {
          try {
            ended();
          } catch {
            /* Audio cleanup still runs. */
          }
        },
        { once: true },
      );
  } catch {
    /* Malformed visual data must not break the playback queue. */
  }
}
