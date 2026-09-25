'use strict';
/* PASTING A FINISHED SONG FROM CHATGPT (Sep 25 2026).
 *
 * Kade writes songs in ChatGPT with a prompt whose answer is exactly three
 * sections, each a heading followed by a fenced block:
 *
 *   Lyrics Box          -> the words to sing
 *   Tag Box             -> the music direction (genre, tempo, voice, band...)
 *   Negative Tag Box    -> things to avoid
 *
 * She will paste that whole answer into the booth. Before this file, the
 * booth either sent all three sections to the engine as one "brief" (so the
 * headings, the fences and the avoid-list were performed or sung), or handed
 * it to the writing desk, which spent money rewriting a song that was already
 * finished.
 *
 * This splits it with NO model call, exactly and cheaply:
 *   - the Lyrics Box becomes the lyrics (the "Your own lyrics" box);
 *   - the Tag Box becomes the music direction;
 *   - the Negative Tag Box is NEVER sent to an engine. Neither YuE2 nor
 *     Lyria 3.5 has a negative field, and "avoid X" words inside a positive
 *     prompt tend to ADD X. The project has no natural note field for them,
 *     so they are dropped and the person is told so (NEGATIVE_TAGS_NOTE).
 *
 * Tolerant on purpose, because pasted text is messy: CRLF, missing or extra
 * fences, extra blank lines, headings with or without a colon, markdown #
 * or **bold**, a number in front ("1. Lyrics Box").
 *
 * Deliberately NOT a paste: a brief with the booth's own "Lyrics:" heading.
 * That is the desk's format and splitLyricsBlock (kadeSoundBoothCarry.js)
 * handles it. Only the "... Box" headings count here.
 *
 * The web page runs the very same functions: PAGE_SOURCE is their source
 * text, spliced into the page's script by kadeSoundBoothPage.js, so the page
 * and the server can never disagree about what a paste is.
 */

const NEGATIVE_TAGS_NOTE =
  'The Negative Tag Box was left out: neither YuE2 nor Lyria has a place for things to avoid, and naming them in the music direction tends to add them to the song.';

/** Which box a line names, or null. Returns { key, inline } where inline is
 *  any text that followed the heading on the same line after a colon. */
function songPasteHeading(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 200) return null;
  const colon = raw.indexOf(':');
  const head = colon === -1 ? raw : raw.slice(0, colon);
  if (head.length > 60) return null;
  const words = head
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*\d{1,2}[.)]\s*/, '')
    .replace(/[*_#>`]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  let key = null;
  if (/^(?:the )?negative tags? box$/.test(words)) key = 'negative';
  else if (/^(?:the )?tags? box$/.test(words)) key = 'tags';
  else if (/^(?:the )?lyrics? box$/.test(words)) key = 'lyrics';
  if (!key) return null;
  const inline = colon === -1 ? '' : raw.slice(colon + 1).replace(/^[\s*_]+|[\s*_]+$/g, '');
  return { key, inline: /^(?:```|~~~)/.test(inline) ? '' : inline };
}

/** The body of one box. A fenced box is what sits between its fences, so any
 *  chatter after the closing fence is left out; a box whose closing fence is
 *  missing runs to the next heading; an unfenced box is kept whole. Blank
 *  edges go either way. */
function songPasteBody(lines) {
  const fence = /^\s*(?:```|~~~)[^`~]*$/;
  let ls = lines.slice();
  while (ls.length && !ls[0].trim()) ls.shift();
  if (ls.length && fence.test(ls[0])) {
    ls.shift();
    let close = -1;
    for (let i = 0; i < ls.length; i++) {
      if (fence.test(ls[i])) { close = i; break; }
    }
    if (close !== -1) ls = ls.slice(0, close);
  }
  while (ls.length && (!ls[ls.length - 1].trim() || fence.test(ls[ls.length - 1]))) ls.pop();
  while (ls.length && !ls[0].trim()) ls.shift();
  return ls.map((l) => l.replace(/\s+$/, '')).join('\n');
}

/**
 * Split a pasted three-box song. Returns null when the text is not one, so a
 * caller can do `const pasted = splitSongPaste(text); if (pasted) ...`.
 *
 * @returns {{lyrics: string, tags: string, negative: string, boxes: string[]} | null}
 */
function splitSongPaste(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = null;
  let startsWithHeading = false;
  let seenText = false;
  for (const line of lines) {
    const h = songPasteHeading(line);
    if (h) {
      if (!seenText) startsWithHeading = true;
      seenText = true;
      current = { key: h.key, lines: h.inline ? [h.inline] : [] };
      sections.push(current);
      continue;
    }
    if (line.trim()) seenText = true;
    if (current) current.lines.push(line);
  }
  if (!sections.length) return null;
  const boxes = [];
  for (const s of sections) if (boxes.indexOf(s.key) === -1) boxes.push(s.key);
  /* Two different boxes anywhere is unmistakable. One box on its own counts
   * only when it is the first thing in the paste and its body is fenced, so
   * a brief that happens to mention a "tag box" in passing is left alone. */
  if (boxes.length < 2) {
    const firstBody = sections[0].lines.filter((l) => l.trim());
    if (!startsWithHeading || !firstBody.length || !/^\s*(?:```|~~~)/.test(firstBody[0])) return null;
  }
  const out = { lyrics: '', tags: '', negative: '', boxes };
  for (const s of sections) {
    const body = songPasteBody(s.lines);
    if (body) out[s.key] = out[s.key] ? out[s.key] + '\n\n' + body : body;
  }
  return out;
}

/** The split in the shape both clients already split a desk draft on:
 *  the direction, a blank line, "Lyrics:", then the words. */
function songPasteDraft(pasted) {
  if (!pasted) return '';
  const tags = String(pasted.tags || '').trim();
  const lyrics = String(pasted.lyrics || '').trim();
  return lyrics ? tags + '\n\nLyrics:\n' + lyrics : tags;
}

/** What to tell the person about a paste, in one or two sentences. */
function songPasteNote(pasted, { lyricsReplaced = false } = {}) {
  if (!pasted) return '';
  const parts = [];
  const moved = [];
  if (pasted.tags) moved.push('the Tag Box became the music direction');
  if (pasted.lyrics) moved.push('the Lyrics Box became the lyrics');
  if (moved.length) parts.push('Your pasted song was sorted into its boxes: ' + moved.join(' and ') + '.');
  if (lyricsReplaced) parts.push('The pasted lyrics replaced what was in the lyrics box.');
  if (pasted.negative) parts.push(NEGATIVE_TAGS_NOTE);
  return parts.join(' ');
}

/**
 * The render-time guard. A client that does not split pastes itself (the
 * iPhone until its next build, or a person who pastes and presses Generate
 * straight away) sends the whole paste as `script`. This rewrites the body in
 * place so the engine receives only the direction and the words.
 *
 * The pasted Lyrics Box wins over the lyrics box: a three-box paste is one
 * finished song, and its tags were written for its own words.
 *
 * @returns {{ note: string, pasted: object } | null}
 */
function applySongPasteToBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.engine !== 'lyria' && body.engine !== 'yue2') return null;
  if (typeof body.script !== 'string') return null;
  const pasted = splitSongPaste(body.script);
  if (!pasted) return null;
  const before = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
  body.script = pasted.tags;
  let lyricsReplaced = false;
  if (pasted.lyrics) {
    lyricsReplaced = !!before && before !== pasted.lyrics.trim();
    body.lyrics = pasted.lyrics;
  }
  return { note: songPasteNote(pasted, { lyricsReplaced }), pasted };
}

/* The page's copy: the same functions, as source text. Only helpers that use
 * nothing from this module's scope belong here. */
const PAGE_SOURCE =
  [songPasteHeading, songPasteBody, splitSongPaste, songPasteDraft, songPasteNote].map(String).join('\n') +
  '\nvar NEGATIVE_TAGS_NOTE = ' + JSON.stringify(NEGATIVE_TAGS_NOTE) + ';\n';

module.exports = {
  NEGATIVE_TAGS_NOTE,
  songPasteHeading,
  songPasteBody,
  splitSongPaste,
  songPasteDraft,
  songPasteNote,
  applySongPasteToBody,
  PAGE_SOURCE,
};
