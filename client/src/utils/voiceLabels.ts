/**
 * KADE July 23 2026 — graduated voice-label normalization.
 *
 * The fish-wave voices shipped July 22 with "(Beta)" in their picker labels
 * ("Voice 340 (Beta)", "Voice 327 (Beta) Kade calm and casual"). Kade
 * graduated them July 23: the served list now carries the clean spellings
 * ("Voice 340", "Voice 327 Kade calm and casual") and the old spellings live
 * on only as hidden aliases the TTS proxy resolves forever.
 *
 * This helper maps a STORED value (localStorage voice setting, per-agent
 * personal pick, agent tts.voiceId echoed into a form) onto the served list:
 *   - already in the list -> itself
 *   - beta-era spelling whose graduated form is in the list -> graduated form
 *   - anything else -> undefined (caller keeps its own fallback)
 *
 * Lives in utils (not Voices.tsx) because the TTS hooks need it too and
 * Voices.tsx imports those hooks — a component import from the hook side
 * would be circular.
 */
export function normalizeVoiceLabel(
  stored: string | undefined,
  voices: string[],
  renames?: Record<string, string>,
): string | undefined {
  if (stored == null || stored === '') {
    return undefined;
  }
  if (voices.includes(stored)) {
    return stored;
  }
  // Part 118 (Sep 2 2026): the catalog stopped being numbered. "Voice 69",
  // "Voice 69 Birta", "Birta", "Voice 340 (Beta)" all map through the
  // proxy's `renames` to the described label that now sits in the list.
  const renamed = renames?.[stored];
  if (renamed != null && voices.includes(renamed)) {
    return renamed;
  }
  const graduated = stored.replace(' (Beta)', '');
  if (graduated !== stored && voices.includes(graduated)) {
    return graduated;
  }
  return undefined;
}
