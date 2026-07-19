/**
 * TTS-2 voice performance tags (see TTS2_EMOTION_TAGS_BUILD_PROMPT.md).
 *
 * Agents (Kiana first) can wrap a delivery direction or an inline non-verbal
 * sound in a plain-ASCII symmetric delimiter, "%%%", the same token at both
 * ends (like markdown **bold**). An earlier version of this used an
 * asymmetric PUA codepoint pair (U+F003/U+F004); live testing the same
 * session showed the model didn't reproduce that reliably (wrong character,
 * missing close, or skipped entirely in several live replies), so it was
 * swapped for "%%%", which models reproduce far more consistently. The
 * canonical saved message KEEPS the delimiter -- that's what lets
 * read-aloud, Conversation Mode, and the phone bridge all stay expressive,
 * since inworld-tts-proxy converts it to real [bracket] steering right
 * before synthesis. Everywhere a human actually READS the message instead of
 * hearing it -- the chat bubble, search results, copy-to-clipboard,
 * conversation export, and Conversation Mode's live captions -- must never
 * show the tag, so this helper strips the ENTIRE tagged span (delimiters and
 * content both) before display.
 *
 * Never call this on text headed for the TTS request path -- that text needs
 * to keep the delimiter so the proxy can convert it to real steering brackets.
 */

const VOICE_TAG_RE = /%%%([\s\S]*?)%%%/g;

/**
 * Tag-typo tolerance (July 2 2026, seen live): the model sometimes emits a
 * malformed delimiter -- "%%sigh%%" or "%%%sigh%%" -- which the canonical
 * regex above misses, leaking the raw tag into the chat bubble. This second
 * pass catches 2-4 percent signs around a short, direction-looking span
 * (must start with a letter, no % or newline inside, <= ~80 chars) so real
 * prose that legitimately contains doubled percent signs (e.g. printf-style
 * "%%d" in code discussions) is left alone as much as possible.
 */
const SLOPPY_VOICE_TAG_RE = /%{2,4}([a-zA-Z][a-zA-Z ’',!-]{0,60}?)%{2,4}/g;

export function stripVoiceTags(text: string): string {
  if (!text || text.indexOf('%%') === -1) {
    return text;
  }
  return text
    .replace(VOICE_TAG_RE, '')
    .replace(SLOPPY_VOICE_TAG_RE, '')
    // A removed leading tag often leaves a stray space before the next
    // word, and removing one mid-sentence can leave doubled spaces behind.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '')
    // A removed tag at the very start of the message leaves a blank line
    // (the tag's own trailing newline) above the first real line. Trim
    // leading whitespace/newlines from the start of the whole string only --
    // never mid-document, where blank lines are real paragraph breaks.
    .replace(/^\s+/, '');
}

/**
 * Hides a NOT-YET-CLOSED "%%%" tag from a piece of text that is still
 * actively streaming in -- a live assistant reply mid-generation, or a live
 * Conversation Mode caption (July 19 2026, Kade: "the web chat view ... is
 * showing the emotional expressive steering tags").
 *
 * Root cause: `stripVoiceTags` only removes a COMPLETE `%%%...%%%` pair. The
 * model emits the opening delimiter and its direction text BEFORE the
 * closing delimiter exists yet, so for the brief window while a reply is
 * still typing in, the raw "%%%gentle, warm..." fragment has no match yet
 * and flashes on screen -- then vanishes the instant the closing "%%%"
 * arrives and `stripVoiceTags` can see the whole pair. Confirmed live: two
 * real captured messages ("%%%gentle, warm but direct...%%%Which three...",
 * "%%%laughing, warm%%%That was you, Kade...") both strip perfectly clean
 * once complete -- the gap is specifically the in-flight/partial window,
 * not the regex itself.
 *
 * Call this ONLY on text that is known to still be streaming (gate on
 * `isSubmitting && isLatestMessage`, or an always-live surface like
 * Conversation Mode's caption). Deliberately NOT applied to a
 * finished/saved message: after `stripVoiceTags` has already removed every
 * COMPLETE pair, anything left starting with "%%" in a message that is
 * actually done streaming would mean a tag was truly never closed (a rare
 * model mistake) -- showing that raw fragment is safer than silently
 * swallowing whatever real text follows it, matching this app's existing
 * "never silently hide a loading problem" stance elsewhere in the chat UI.
 */
export function hideDanglingVoiceTag(strippedText: string): string {
  const danglingIndex = strippedText.indexOf('%%');
  return danglingIndex === -1 ? strippedText : strippedText.slice(0, danglingIndex);
}
