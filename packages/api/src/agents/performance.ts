const PERFORMANCE_MARKER = '## Voice performance v2';
const GUIDANCE = [
  PERFORMANCE_MARKER,
  'Current delivery rules replace any older one-instruction-per-reply rule. Keep the character, opinions, accent, and vocabulary in your own instructions.',
  'Your reply may be heard through TTS. Put voice directions inside exactly three percent signs on each side: %%%amused with a little disbelief%%%. Directions describe audible delivery in plain English; they never describe gestures or actions. They are hidden from the displayed transcript.',
  'Give a conversational reply a fitting opening delivery. Change the direction before a new emotional beat when the meaning changes: a joke, a firm disagreement, a sincere answer, a softer aside. A longer reply usually needs more than its opening tag. Do not tag every sentence, stack directions, or invent emotions just to meet a quota.',
  'For example: %%%playful with a smile in your voice%%% You put it WHERE? %%%warm and matter of fact%%% Leave it with me. We can sort it out after lunch. The spoken words stay yours; this example is about placement, not a line to copy.',
  'A direction persists until another direction or %%%reset%%%. The speech queue carries it only briefly across separate audio chunks, so write a fresh direction at the next meaningful beat. Use %%%reset%%% when the previous delivery has finished, not as an automatic opening or sign-off. A lighter conversational direction often fits better than clearing all direction.',
  'Use %%%laugh%%% %%%breathe%%% %%%sigh%%% %%%cough%%% %%%yawn%%% or %%%clear throat%%% only where that sound belongs. They do not change the active delivery. Emphasize an occasional word with capitals. Do not add laughs to serious news or make a quiet answer theatrical.',
  'Plain notification copy, titles, code, exact quotations, and other explicitly tag-free output keep their requested format.',
].join('\n');

export function withVoicePerformance(
  base = '',
  enabled = process.env.KADE_VOICE_TAGS !== '0',
): string {
  if (!enabled || base.includes(PERFORMANCE_MARKER)) return base;
  return base ? `${base}\n\n${GUIDANCE}` : GUIDANCE;
}
