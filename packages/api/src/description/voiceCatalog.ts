export type NarratorCatalog = {
  voices: string[];
  renames?: Record<string, string>;
  hidden?: string[];
  aliases?: string[];
  fish?: string[];
};

/** Visible choices and retained saved bindings are separate sets. */
export function narratorLabel(
  catalog: NarratorCatalog,
  name?: string | null,
  includeRetained = false,
): string | undefined {
  if (!name) return undefined;
  const allowed = includeRetained
    ? [...catalog.voices, ...(catalog.hidden ?? []), ...(catalog.aliases ?? [])]
    : catalog.voices;
  if (allowed.includes(name)) return name;
  const renamed = catalog.renames?.[name];
  /**
   * Since Oct 15 2026 every Inworld voice is listed as "<label> (Classic)" while a stored "Voice N"
   * still renames to the plain label, which is hidden: without the Classic spelling the house
   * narrator fell back to the first voice in the list (a Fish voice) and "Good for describing"
   * came up empty.
   */
  for (const candidate of [renamed, renamed && `${renamed} (Classic)`, `${name} (Classic)`])
    if (candidate && allowed.includes(candidate)) return candidate;
  return undefined;
}

/** Whether a catalog label is this visible choice, itself or its "(Classic)" spelling. */
export const sameNarrator = (label: string, visible: string): boolean =>
  label === visible || `${label} (Classic)` === visible;

export const retainedNarrators = (catalog: NarratorCatalog): string[] => [
  ...new Set([...(catalog.hidden ?? []), ...(catalog.aliases ?? [])]),
];
