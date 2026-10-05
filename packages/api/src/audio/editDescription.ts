export interface AudioDescriptionAsset {
  kind?: string;
  service?: string;
  model?: string;
  prompt?: string;
  description?: string;
  metadata?: { aukTask?: string; editInstruction?: string; descriptionSource?: string; title?: string; engine?: string };
}

/** An edit request is not evidence that the requested audible change succeeded. */
export function aukEditDescription(instruction: string): string {
  const words = String(instruction || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const requested = words ? `Edit requested: ${words}${/[.!?]$/.test(words) ? '' : '.'} ` : 'Audio edit requested. ';
  return requested + 'The recording was processed. Listen to check whether the change worked.';
}

/** Old speech prompts are XML; plain AuK edit prompts need project evidence before relabeling. */
export function legacyAukEditCandidate(asset: AudioDescriptionAsset): boolean {
  return asset.kind === 'audio' && asset.metadata?.aukTask !== 'edit' &&
    (asset.service === 'auk_audio' || asset.model === 'tencent/AuK' || asset.metadata?.engine === 'auk') &&
    !!asset.prompt?.trim() && !/<speak\b/i.test(asset.prompt);
}

/** Read-time presentation only: stored descriptions and explicit user titles remain intact. */
export function audioAssetDescription(asset: AudioDescriptionAsset, legacyEdit = false): string {
  const description = asset.description || '';
  const metadata = asset.metadata;
  if (metadata?.descriptionSource === 'user' || (metadata?.title && description === metadata.title)) return description;
  if (asset.kind === 'audio' && (metadata?.aukTask === 'edit' || (legacyEdit && legacyAukEditCandidate(asset)))) {
    // A project can be edited again before its earlier take finishes filing.
    return aukEditDescription(asset.prompt || metadata?.editInstruction || '');
  }
  return description;
}
