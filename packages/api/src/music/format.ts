const SECTION_TAG =
  /\[[ \t]*(?:(?:final|last)[ \t]+)?(?:intro|verse|pre[- ]?chorus|post[- ]?chorus|chorus|bridge|outro|hook|refrain|interlude|breakdown|solo|drop|instrumental|vamp|coda)(?=[ \t\d:—–-]|\])[^\]\r\n]*\]/gi;

/** Plain punctuation for a sung line, because a generator sings the text as written: straight
 *  quotes and apostrophes, no semicolons, and a dash becomes a comma (a trailing one goes). */
function plainPunctuation(line: string): string {
  return line
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/\s*[—–]\s*$/, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*;\s*/g, ', ');
}

function formatLines(lyrics: string): string {
  const lines: string[] = [];
  const appendWords = (words: string): void => {
    const line = plainPunctuation(words.trim()).trim();
    if (line) lines.push(line);
  };

  for (const raw of lyrics.split(/\r\n?|\n/)) {
    let from = 0;
    for (const section of raw.matchAll(SECTION_TAG)) {
      appendWords(raw.slice(from, section.index));
      if (lines.length) lines.push('');
      lines.push(section[0]);
      from = section.index + section[0].length;
    }
    appendWords(raw.slice(from));
  }
  return lines.join('\n');
}

/** Formats only a desk-generated Lyrics block; callers must keep supplied lyrics out of this path. */
export function formatGeneratedLyricsDraft(script: string): string {
  const heading = /^[ \t]*lyrics[ \t]*:[ \t]*/im.exec(script);
  if (!heading) return script;

  const from = heading.index + heading[0].length;
  const readback = /^[ \t]*READBACK[ \t]*:/im.exec(script.slice(from));
  const to = readback ? from + readback.index : script.length;
  const lyrics = formatLines(script.slice(from, to));
  if (!lyrics) return script;

  const suffix = readback ? `\n\n${script.slice(to)}` : '';
  return `${script.slice(0, from)}\n${lyrics}${suffix}`;
}
