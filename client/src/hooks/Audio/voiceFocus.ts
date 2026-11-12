import { kadeSwitchOn } from '~/utils/kadeSwitch';

/** Nov 12 2026 (WEB-5): one reply voice at a time. Whichever player starts pauses the one that
 * was speaking. Undo on one browser: localStorage kadeOneVoice = '0'. */
const speaking = new Set<HTMLMediaElement>();
const RELEASE_EVENTS = ['pause', 'ended', 'emptied'] as const;

function release(this: HTMLMediaElement) {
  speaking.delete(this);
}

/** Call from a player's 'playing' event. Safe to call again each time 'playing' re-fires. */
export function claimVoice(audio: HTMLMediaElement | null | undefined): void {
  if (!audio || !kadeSwitchOn('oneVoice')) {
    return;
  }
  for (const other of speaking) {
    if (other !== audio && !other.paused) {
      other.pause();
    }
  }
  speaking.clear();
  speaking.add(audio);
  for (const type of RELEASE_EVENTS) {
    audio.addEventListener(type, release, { once: true });
  }
}

/** A voice call is taking the speakers. Pausing is not enough on iOS (see startCall in
 * ConversationMode): a clip that is not in the page is also emptied, because the
 * `document.querySelectorAll('audio')` sweep there cannot reach it. */
export function silenceAllVoices(): void {
  for (const audio of speaking) {
    try {
      audio.pause();
      if (!audio.isConnected) {
        const src = audio.src;
        audio.removeAttribute('src');
        audio.load();
        if (src.startsWith('blob:')) {
          URL.revokeObjectURL(src);
        }
      }
    } catch {
      /* ignore */
    }
  }
  speaking.clear();
}
