/** Oct 30 2026: one speed number everywhere, on every voice. Her words: "The brisk and all that,
 * that wasn't original, that was just because we couldn't get fish api to sound right. Inworld
 * originally just had a speed, 1x 1.2x whatever, up and down." The proxy now stretches the finished
 * take to the exact number, so the same list serves Fish and Inworld. It keeps the numbers shipped
 * apps send (0.75, 0.9, 1, 1.2, 1.5). */
export const voiceSpeeds = [0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

export function generationRate(base?: number | null, preference?: number | null): number {
  const rate = preference ?? base ?? 1;
  return Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1;
}

/** What a person sees: "1.2x". */
export function speedLabel(rate: number): string {
  return `${rate}x`;
}

/** What a screen reader says: "1.2 times", not "one point two ex". */
export function speedSpoken(rate: number): string {
  return `${rate} times`;
}

/** The list to show. A saved number that is not on it (an old 0.6 or 1.25) shows as itself, in
 * order, so the control is never blank and nothing changes unless the person changes it. */
export function speedOptions(saved?: number | null): number[] {
  const list: number[] = [...voiceSpeeds];
  if (typeof saved !== 'number' || !Number.isFinite(saved) || list.includes(saved)) {
    return list;
  }
  return [...list, saved].sort((a, b) => a - b);
}

/** A character's speed belongs to its own builder voice. A listener who picked a different voice
 * hears that voice at their own number or 1x, so this answers undefined for them. Picking the
 * builder's voice by hand is still the builder's voice. */
export function characterSpeedFor(
  builderVoice?: string | null,
  personalVoice?: string | null,
  speakingRate?: number | null,
): number | undefined {
  if (typeof speakingRate !== 'number' || !builderVoice) {
    return undefined;
  }
  return personalVoice == null || personalVoice === builderVoice ? speakingRate : undefined;
}

const VOICE_CACHE_VERSION = 'pacing-v4';
const VOICE_CACHE_PATH = '/__voice-cache/';
const VOICE_CACHE_PURGED_KEY = 'voiceCachePurged';

/** Oct 16 2026: v3 added the listener's filler switch, so audio made with fillers on never
 * replays after they are switched off (and the other way round).
 * Oct 30 2026: v4 because the same speed number now sounds different: a 1.2 used to play at
 * about 1.05 and is now a real 1.2. Older entries are never matched again; purgeOldVoiceCache
 * deletes them, since nothing else ever would. */
export function voiceCacheKey(
  text: string,
  voice: string | null | undefined,
  speed: number,
  fillers: boolean,
): string {
  return `${VOICE_CACHE_PATH}${VOICE_CACHE_VERSION}?${new URLSearchParams({
    text,
    voice: voice ?? '',
    speed: String(speed),
    fillers: fillers ? '1' : '0',
  })}`;
}

/** Deletes every older /__voice-cache/ entry, once per browser. Fail-soft: blocked storage or no
 * Cache API just leaves the old entries unmatched. Returns how many it removed. */
export async function purgeOldVoiceCache(): Promise<number> {
  try {
    if (typeof caches === 'undefined') {
      return 0;
    }
    if (localStorage.getItem(VOICE_CACHE_PURGED_KEY) === VOICE_CACHE_VERSION) {
      return 0;
    }
    const cache = await caches.open('tts-responses');
    const current = `${VOICE_CACHE_PATH}${VOICE_CACHE_VERSION}`;
    const stale = (await cache.keys()).filter((request) => {
      const { pathname } = new URL(request.url);
      return pathname.startsWith(VOICE_CACHE_PATH) && pathname !== current;
    });
    await Promise.all(stale.map((request) => cache.delete(request)));
    localStorage.setItem(VOICE_CACHE_PURGED_KEY, VOICE_CACHE_VERSION);
    return stale.length;
  } catch {
    return 0;
  }
}
