export interface VoicePlayback {
  audio: HTMLAudioElement;
  messageId: string;
  phase: 'playing' | 'paused' | 'waiting';
}

export const voicePlayback: {
  subscribe(callback: () => void): () => void;
  snapshot(): VoicePlayback | null;
};

export function watchVoiceAudio(audio: HTMLAudioElement, messageId?: string): () => void;
export function stopWatchingVoiceAudio(audio: HTMLAudioElement): void;
