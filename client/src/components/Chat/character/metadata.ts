export interface CharacterAudioMetadata {
  type: 'character-audio';
  version: 1;
  agentId: string | null;
  speech: boolean;
}

export function readCharacterAudio(value: Partial<CharacterAudioMetadata>): CharacterAudioMetadata | null {
  if (value.type !== 'character-audio' || value.version !== 1 ||
    typeof value.speech !== 'boolean' ||
    !(value.agentId === null || (typeof value.agentId === 'string' && value.agentId.length > 0 && value.agentId.length <= 128))) return null;
  return { type: 'character-audio', version: 1, agentId: value.agentId, speech: value.speech };
}
