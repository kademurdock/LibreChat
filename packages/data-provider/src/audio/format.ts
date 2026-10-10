export type SpeechAudioFormat = {
  mimeType: string;
  extension: string;
};

const WAV = { mimeType: 'audio/wav', extension: 'wav' };
const MP3 = { mimeType: 'audio/mpeg', extension: 'mp3' };
const OGG = { mimeType: 'audio/ogg', extension: 'ogg' };
const FLAC = { mimeType: 'audio/flac', extension: 'flac' };
const MP4 = { mimeType: 'audio/mp4', extension: 'm4a' };
const UNKNOWN = { mimeType: 'application/octet-stream', extension: 'bin' };

export function sniffSpeechAudioFormat(bytes: Uint8Array): SpeechAudioFormat | null {
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return WAV;
  if (bytes.length >= 3 && ascii(bytes, 0, 'ID3')) return MP3;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0 &&
    (bytes[1] & 0x18) !== 0x08 &&
    (bytes[1] & 0x06) !== 0 &&
    (bytes[2] & 0xf0) !== 0xf0 &&
    (bytes[2] & 0xf0) !== 0 &&
    (bytes[2] & 0x0c) !== 0x0c
  )
    return MP3;
  if (bytes.length >= 4 && ascii(bytes, 0, 'OggS')) return OGG;
  if (bytes.length >= 4 && ascii(bytes, 0, 'fLaC')) return FLAC;
  if (bytes.length >= 8 && ascii(bytes, 4, 'ftyp')) return MP4;
  return null;
}

export function speechAudioFormat(
  bytes: Uint8Array,
  contentType?: string | null,
): SpeechAudioFormat {
  const sniffed = sniffSpeechAudioFormat(bytes);
  if (sniffed) return sniffed;
  const type = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (type === 'audio/wav' || type === 'audio/wave' || type === 'audio/x-wav') return WAV;
  if (type === 'audio/mpeg' || type === 'audio/mp3') return MP3;
  if (type === 'audio/ogg') return OGG;
  if (type === 'audio/flac') return FLAC;
  if (type === 'audio/mp4' || type === 'audio/x-m4a') return MP4;
  return UNKNOWN;
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}
