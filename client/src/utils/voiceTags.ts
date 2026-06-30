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

export function stripVoiceTags(text: string): string {
  if (!text || text.indexOf('%%%') === -1) {
    return text;
  }
  return text
    .replace(VOICE_TAG_RE, '')
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
