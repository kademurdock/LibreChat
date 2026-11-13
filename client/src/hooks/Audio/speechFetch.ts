/**
 * Nov 13 2026 (sweep 5.0): auto read-aloud must never end in silence.
 *
 * WEB-2 keeps the screen reader quiet once the reply voice has "taken" a reply. Three paths left
 * a taken reply with no voice and no screen reader:
 *   1. the speech request hangs before its first byte (nothing timed it out);
 *   2. the request is cancelled after the run was claimed (the first reply of a new chat changes
 *      the route from /c/new to /c/<id>), and the claim stopped any retry;
 *   3. that same route change paused a clip that had already started.
 * StreamAudio uses the helpers below for all three. Undo on one browser:
 * localStorage kadeVoiceFallback = '0' (the old claim, no timeout, pause on every route change).
 * The wait itself: localStorage kadeVoiceFetchTimeoutMs = milliseconds (0 = wait for ever).
 */
import { kadeSwitchOn } from '~/utils/kadeSwitch';

export const SPEECH_FETCH_TIMEOUT_MS = 25000;

export const voiceFallbackOn = (): boolean => kadeSwitchOn('voiceFallback');

/** How long the speech request may take to answer at all. 0 = no limit. */
export function speechFetchTimeoutMs(): number {
  if (!voiceFallbackOn()) {
    return 0;
  }
  try {
    const raw = globalThis.localStorage?.getItem('kadeVoiceFetchTimeoutMs');
    if (raw == null || raw.trim() === '') {
      return SPEECH_FETCH_TIMEOUT_MS;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 600000 ? n : SPEECH_FETCH_TIMEOUT_MS;
  } catch {
    return SPEECH_FETCH_TIMEOUT_MS;
  }
}

export class SpeechFetchTimeout extends Error {
  constructor(ms: number) {
    super(`The voice did not answer within ${Math.round(ms / 1000)} seconds`);
    this.name = 'SpeechFetchTimeout';
  }
}

/**
 * Waits for `request`, but only `ms` long. On a timeout it REJECTS with SpeechFetchTimeout and
 * does not abort anything itself: an aborted controller reads as "cancelled", and a cancelled
 * request is dropped without a word. The caller reports the failure first, then aborts.
 */
export function withAnswerTimeout<T>(request: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) {
    return request;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SpeechFetchTimeout(ms)), ms);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * True when a route change is only the first reply of a new chat getting its address
 * (/c/new -> /c/<the id of the chat on screen>): the reply voice for that chat must keep going.
 */
export function sameChatGotItsAddress(
  previousParam: string | undefined,
  nextParam: string | undefined,
  latestConversationId: string | null | undefined,
): boolean {
  return (
    voiceFallbackOn() &&
    previousParam === 'new' &&
    !!nextParam &&
    nextParam !== 'new' &&
    latestConversationId === nextParam
  );
}
