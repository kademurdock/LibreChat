export function speechContext(source?: string): string {
  if (source !== 'voice_transcript') return '';
  return '[Message source: voice message transcribed to text, possibly edited or mixed with typing. Names, punctuation and repeated words may be transcription errors. Use the intended meaning and established names when clear; ask only when ambiguity affects the answer. This is text from a recording, not a live call or access to the speaker’s audio, tone or surroundings.]';
}
