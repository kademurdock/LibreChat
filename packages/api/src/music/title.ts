export function splitLyricTitle(draft: string): { title?: string; script: string } {
  const script = draft.trim().replace(/^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/i, '$1').trim();
  const header = /^(?:#{1,6}\s*)?(?:\*\*|__)?(?:song\s+)?title(?:\*\*|__)?\s*:\s*(?:\*\*|__)?([^\r\n]*)\r?\n?/i.exec(script);
  if (!header) return { script: draft };
  const title = header[1].trim().replace(/(?:\*\*|__)$/, '').trim()
    .replace(/^["“‘']|["”’']$/g, '').trim().slice(0, 80);
  return {
    title: title && !/^(?:untitled|your song|song title|title)$/i.test(title) ? title : undefined,
    script: script.slice(header[0].length).trim(),
  };
}
