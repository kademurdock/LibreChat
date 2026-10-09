import type { voiceMessagePose } from './voice-message-motion.mjs';

export type CallAudioIdentity = {
  speakerId: string | null;
  speech: boolean;
  expression: string;
  moment: string | null;
};
export type CallPresentation = ReturnType<typeof createCallPresentation>;
export function characterAudioIdentity(value: unknown): CallAudioIdentity | null;
export function authoredCallIdentity(
  speakerId: string | null | undefined,
  text: string,
): CallAudioIdentity | null;
export function outputLevel(samples: Float32Array): { level: number; sibilance: number };
export function createCallPresentation(): {
  token(): number;
  clear(): void;
  schedule(
    token: number,
    start: number,
    duration: number,
    identity: CallAudioIdentity | null,
  ): number | null;
  finish(token: number | null): void;
  current(
    time: number,
  ): { start: number; duration: number; identity: CallAudioIdentity | null; token: number } | null;
  pose(options: {
    id: string;
    time: number;
    level?: number;
    sibilance?: number;
    enabled: boolean;
    visible: boolean;
    reducedMotion: boolean;
    running: boolean;
    status: string;
    live: boolean;
  }): ReturnType<typeof voiceMessagePose>;
};
