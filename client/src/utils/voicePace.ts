export const fishPaces = [
  { value: 0.75, key: 'com_voice_pace_unhurried' },
  { value: 0.9, key: 'com_voice_pace_easygoing' },
  { value: 1, key: 'com_voice_pace_natural' },
  { value: 1.2, key: 'com_voice_pace_brisk' },
  { value: 1.5, key: 'com_voice_pace_quick' },
] as const;

export const inworldRates = Array.from({ length: 11 }, (_, index) => (index + 5) / 10);

export function generationRate(base?: number | null, preference?: number | null): number {
  const rate = preference ?? base ?? 1;
  return Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1;
}

export function fishPaceValue(rate: number): number {
  return fishPaces.reduce((best, pace) =>
    Math.abs(pace.value - rate) < Math.abs(best.value - rate) ? pace : best,
  ).value;
}

export function isFishVoice(
  voice?: string | null,
  providers?: { [voice: string]: string },
): boolean {
  const provider = voice ? providers?.[voice] : undefined;
  return provider ? provider === 'fish' : !voice?.endsWith('(Classic)');
}

/** Oct 16 2026: v3 adds the listener's filler switch, so audio made with fillers on never
 * replays after they are switched off (and the other way round). Older v2 entries are
 * never matched again. */
export function voiceCacheKey(
  text: string,
  voice: string | null | undefined,
  speed: number,
  fillers: boolean,
): string {
  return `/__voice-cache/pacing-v3?${new URLSearchParams({
    text,
    voice: voice ?? '',
    speed: String(speed),
    fillers: fillers ? '1' : '0',
  })}`;
}
