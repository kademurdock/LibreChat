/* ----------------------------------------------------------------------------
 * THE LIBRARY'S READING TEXT (Sep 24 2026). Kade: "just the book as it is
 * being narrated, but without any steering tags on screen", and the notice
 * "should probably just say something like, this book was produced for
 * people with bona fide print disabilities ... Doesn't matter where the epub
 * etc came from."
 *
 * Display only. Narration keeps the stored chunk exactly as it is: the voice
 * proxy turns %%% directions into real steering, so this must never run on
 * text headed for the audio route (the chat's stripVoiceTags rule).
 *
 * The forms removed are the ones the platform's voices actually use, matched
 * the way the voice proxy matches them, and nothing wider: a book's own
 * [bracketed] words, footnote marks and percentages stay on the page.
 * -------------------------------------------------------------------------- */

/** The one notice a reader hears or sees about an accessible edition. No
 * title, no source, no instructions. */
export const printDisabilityNotice: string =
  'This book was produced for people with bona fide print disabilities.';

/** A mistyped direction ("%%sigh%%", "%%%%reset%%%%"). The proxy rewrites 2
 * to 5 percent signs around a short, letter-bearing span into the canonical
 * delimiters before it pairs them (inworld-tts-proxy applySteeringTags), so
 * such a span is steering, never words. Same rewrite here, then the pairs go:
 * removing loose matches outright could pair the closer of one long direction
 * with the opener of the next and take the sentence between them. */
const LOOSE_DIRECTION = /%{2,5}((?=[^%\n]{0,160}[a-zA-Z])[a-zA-Z0-9][^%\n]{0,159}?)%{2,5}/g;
/** The canonical performance direction, delimiters and words both; layered
 * directions run long, so no length cap (the chat's VOICE_TAG_RE). */
const DIRECTION = /%%%[\s\S]*?%%%/g;
/** Game Parlor sound and table cues: machine decoration, never words. */
const CUE = /\[(?:sound:[a-z0-9_]+|table:[a-z0-9]{1,12})\]/gi;
/** A multi-voice scene cue ("[[Deuce]]", "[[Voice 214]]") reads as a
 * screenplay line, the way the chat bubble shows it. */
const SCENE = /\[\[([^[\]\n]{1,60})\]\]\s*/g;

/** A stored passage as a reader should see it. */
export function readingText(text: string): string {
  const source = String(text == null ? '' : text);
  if (source.indexOf('%%') === -1 && source.indexOf('[') === -1) return source.trim();
  return source
    .replace(LOOSE_DIRECTION, '%%%$1%%%')
    .replace(DIRECTION, ' ')
    .replace(CUE, ' ')
    .replace(SCENE, (_whole: string, name: string) => {
      const who = name.trim().replace(/[:\s]+$/, '');
      return who ? `${who}: ` : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Jackets cut before Sep 24 2026 end with "From Bookshare, for people with
 * print disabilities. Please do not pass this book on." The chunker can cut
 * between the two sentences, so each is handled on its own. Applies to the
 * jacket section only: a novel may quote either sentence. */
export function readingJacket(text: string): string {
  return String(text == null ? '' : text)
    .replace(/From Bookshare, for people with print disabilities\./gi, printDisabilityNotice)
    .replace(/\s*Please do not pass this book on\./gi, '')
    .trim();
}

/** One reading-view page: `count` passages of a section from `from`, cleaned
 * for the screen. An emptied passage keeps its slot so positions still match
 * the narration's. */
export function readingPassages(
  chunks: readonly string[],
  kind: string,
  from: number,
  count: number,
): string[] {
  return chunks
    .slice(from, from + count)
    .map((chunk) => readingText(kind === 'jacket' ? readingJacket(chunk) : chunk));
}
