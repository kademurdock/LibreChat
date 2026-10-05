export function splitLyricTitle(draft: string): { title?: string; script: string } {
  const script = draft
    .trim()
    .replace(/^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/i, '$1')
    .trim();
  const header =
    /^(?:#{1,6}\s*)?(?:\*\*|__)?(?:song\s+)?title(?:\*\*|__)?\s*:\s*(?:\*\*|__)?([^\r\n]*)\r?\n?/i.exec(
      script,
    );
  if (!header) return { script: draft };
  const title = header[1]
    .trim()
    .replace(/(?:\*\*|__)$/, '')
    .trim()
    .replace(/^["“‘']|["”’']$/g, '')
    .trim()
    .slice(0, 80);
  return {
    title: title && !/^(?:untitled|your song|song title|title)$/i.test(title) ? title : undefined,
    script: script.slice(header[0].length).trim(),
  };
}

export function lyricTitleFromSong(draft: string): string | undefined {
  const lyrics = /^\s*lyrics\s*:\s*$/im.exec(draft);
  if (!lyrics) return undefined;
  let first: string | undefined;
  let hook = false;
  for (const raw of draft.slice(lyrics.index + lyrics[0].length).split('\n')) {
    if (/^\s*readback\s*:/i.test(raw)) break;
    const line = raw.trim();
    if (/^\[[^\]]*\]$/.test(line)) {
      hook = /^\[\s*(?:(?:final|last)\s+)?(?:chorus|hook|refrain)\b/i.test(line);
      continue;
    }
    const words = line
      .replace(/^(?:\[[^\]]*\]\s*)+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!words || /^(?:untitled|your song|song title|title)$/i.test(words)) continue;
    const shortened = words.length > 80 ? words.slice(0, 81).replace(/\s+\S*$/, '') : words;
    const title = shortened
      .slice(0, 80)
      .replace(/[.!?,;:]+$/, '')
      .trim();
    if (!title) continue;
    first ??= title;
    if (hook) return title;
  }
  return first;
}
