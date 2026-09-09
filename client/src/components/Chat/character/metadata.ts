import { readCues } from './cues.mjs';

export interface CharacterCue {
  at: number;
  tag: string;
}

export interface CharacterAudioMetadata {
  type: 'character-audio';
  version: 1;
  agentId: string | null;
  speech: boolean;
  cues?: CharacterCue[];
}

export function readCharacterAudio(
  value: Partial<CharacterAudioMetadata> | null | undefined,
): CharacterAudioMetadata | null {
  if (
    !value ||
    value.type !== 'character-audio' ||
    value.version !== 1 ||
    typeof value.speech !== 'boolean' ||
    !(
      value.agentId === null ||
      (typeof value.agentId === 'string' && value.agentId.length > 0 && value.agentId.length <= 128)
    )
  )
    return null;
  return {
    type: 'character-audio',
    version: 1,
    agentId: value.agentId,
    speech: value.speech,
    ...(value.cues === undefined ? {} : { cues: value.speech ? readCues(value.cues) : [] }),
  };
}
