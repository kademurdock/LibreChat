import { useQuery } from '@tanstack/react-query';

/** Same proxy base the ConversationMode voice pipeline points at. */
export const TTS_PROXY_BASE = 'https://inworld-tts-proxy-production.up.railway.app';

/** One picker section: category name + the display labels filed under it.
 * Served by the proxy (/voices.json `categories`, July 23 2026) — presentation
 * only, derived from the voice catalog's descriptions. */
export type VoiceCategory = { name: string; voices: string[] };

/**
 * ♿ KADE D2c/D2d — voice-catalog metadata from the TTS proxy (GET /voices.json).
 * Moved out of components/Audio/Voices.tsx on Sep 2 2026 (Part 118) because the
 * TTS hooks now need it too and Voices.tsx imports those hooks (circular).
 *
 * Part 118 fields:
 *   `renames`  old picker spelling -> current label. The catalog stopped being
 *              numbered ("Voice 69") and became described ("husky low
 *              middle-aged woman, Black American · flurry"); a stored pick in
 *              the old spelling migrates through this map instead of being
 *              snapped to voices[0] — which would PERMANENTLY rewrite a
 *              person's voice the first time they opened the site.
 *   `describe` label -> one plain sentence about the sound, for the picker to
 *              read and to search.
 *   `ready`    true once the catalog fetch has settled (success OR failure).
 *              The reconciliation effects in useTTSExternal / useTextToSpeech
 *              must not snap a missing voice before this is true, or the
 *              race (voices list loads first) does the exact rewrite the map
 *              exists to prevent.
 */
export function useVoiceCatalog(): {
  sample?: string;
  audition?: string;
  categories?: VoiceCategory[];
  renames?: Record<string, string>;
  describe?: Record<string, string>;
  /** Part 129: label -> its one-word tag ("flurry"), the voice's spoken name. */
  tags?: Record<string, string>;
  ready: boolean;
} {
  const { data, status } = useQuery(
    ['kade', 'voiceCatalog'],
    async () => {
      const res = await fetch(`${TTS_PROXY_BASE}/voices.json`);
      if (!res.ok) {
        throw new Error(`voices.json ${res.status}`);
      }
      return (await res.json()) as {
        sample?: string;
        audition?: string;
        categories?: VoiceCategory[];
        renames?: Record<string, string>;
        describe?: Record<string, string>;
        tags?: Record<string, string>;
      };
    },
    { staleTime: 5 * 60 * 1000, retry: 1, refetchOnWindowFocus: false },
  );
  const categories = Array.isArray(data?.categories)
    ? data?.categories.filter(
        (c): c is VoiceCategory =>
          !!c && typeof c.name === 'string' && Array.isArray((c as VoiceCategory).voices),
      )
    : undefined;
  const renames =
    data?.renames != null && typeof data.renames === 'object' ? data.renames : undefined;
  const describe =
    data?.describe != null && typeof data.describe === 'object' ? data.describe : undefined;
  const tags = data?.tags != null && typeof data.tags === 'object' ? data.tags : undefined;
  return {
    sample: typeof data?.sample === 'string' && data.sample !== '' ? data.sample : undefined,
    audition: typeof data?.audition === 'string' && data.audition !== '' ? data.audition : undefined,
    categories: categories && categories.length > 0 ? categories : undefined,
    renames,
    describe,
    tags,
    ready: status === 'success' || status === 'error',
  };
}
