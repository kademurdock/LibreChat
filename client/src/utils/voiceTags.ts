/**
 * TTS-2 voice performance tags (see TTS2_EMOTION_TAGS_BUILD_PROMPT.md).
 *
 * Agents (Kiana first) can wrap a delivery direction or an inline non-verbal
 * sound in a private PUA sentinel pair (U+F003 / U+F004 -- distinct from the
 * reasoning-bubble marker U+F001/U+F002 used elsewhere in this fork). The
 * canonical saved message KEEPS the sentinel -- that's what lets read-aloud,
 * Conversation Mode, and the phone bridge all stay expressive, since
 * inworld-tts-proxy converts the sentinel to real [bracket] steering right
 * before synthesis. Everywhere a human actually READS the message instead of
 * hearing it -- the chat bubble, search results, copy-to-clipboard,
 * conversation export, and Conversation Mode's live captions -- must never
 * show the tag, so this helper strips the ENTIRE tagged span (delimiters and
 * content both) before display.
 *
 * Never call this on text headed for the TTS request path -- that text needs
 * to keep the sentinel so the proxy can convert it to real steering brackets.
 */

const VOICE_TAG_RE = /\uF003[\s\S]*?\uF004/g;

export function stripVoiceTags(text: string): string {
  if (!text || text.indexOf('\uF003') === -1) {
    return text;
  }
  return text
    .replace(VOICE_TAG_RE, '')
    // A removed leading tag often leaves a stray space before the next
    // word, and removing one mid-sentence can leave doubled spaces behind.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '');
}
