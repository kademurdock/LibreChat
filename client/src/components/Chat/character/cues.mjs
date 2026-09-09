const TAGS = new Set(['reset', 'warm', 'amused', 'serious', 'concerned', 'skeptical', 'surprised',
  'laugh', 'chuckle', 'giggle', 'cackle', 'gasp', 'scoff', 'sigh', 'cry', 'sob']);

/** Only bounded, canonical delivery cues cross the audio presentation boundary. */
export function readCues(value, duration = 120) {
  if (!Array.isArray(value) || value.length > 8) return [];
  let previous = -1;
  const cues = [];
  for (const cue of value) {
    if (!cue || !Number.isFinite(cue.at) || cue.at < 0 || cue.at < previous ||
        cue.at >= duration || !TAGS.has(cue.tag)) return [];
    previous = cue.at;
    cues.push({ at: cue.at, tag: cue.tag });
  }
  return cues;
}
