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
  return renamed && allowed.includes(renamed) ? renamed : undefined;
}

export const retainedNarrators = (catalog: NarratorCatalog): string[] => [
  ...new Set([...(catalog.hidden ?? []), ...(catalog.aliases ?? [])]),
];
