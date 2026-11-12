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

import { balanceSteeringRuns } from './steeringBalance';
import { kadeSwitchOn } from './kadeSwitch';

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
// Aug 21 2026 (the length-cap sweep, after the admin scrub's 81-char cap bit
// live): v130+ personas teach LAYERED directions that outgrow every old cap,
// and the old charset refused digits and periods -- the same two gaps the TTS
// normalizer fixed July 27. Widened to match: anything but % or newline, 160.
const SLOPPY_VOICE_TAG_RE = /%{2,4}([a-zA-Z][^%\n]{0,160}?)%{2,4}/g;

/**
 * Aug 6 2026 — multi-speaker voice SCENES (ideas 16+52). A saved message can
 * carry double-bracket speaker tags — "[[Deuce]] line" / "[[Voice 214]] line"
 * — which the TTS proxy performs as a true multi-voice scene. On every READ
 * surface (bubble, captions, screen reader, copy, export) the tag renders as
 * a clean screenplay cue: "Deuce: line". Double brackets only — single
 * [bracket] spans (fish cues, sound tokens) are other machinery and are
 * handled elsewhere. Applied inside stripVoiceTags so all seven existing
 * call sites get it with zero call-site changes.
 */
const SCENE_TAG_DISPLAY_RE = /\[\[([^\[\]\n]{1,60})\]\]\s*/g;

function sceneTagsToScript(text: string): string {
  if (!text || text.indexOf('[[') === -1) {
    return text;
  }
  return text.replace(SCENE_TAG_DISPLAY_RE, (_m, inner: string) => {
    const name = String(inner).trim().replace(/[:\s]+$/, '');
    return name ? `${name}: ` : '';
  });
}

/**
 * Aug 7 2026 (Kade: "If I say copy text, it should be exactly that, well
 * formatted text" — her pick: clean prose). Copied/exported text loses
 * markdown SCAFFOLDING but keeps its structure: ## headers lose the hashes,
 * double-star bold, underscore underline, and tilde strike keep their words,
 * bracket-paren links keep the text, code ticks drop, and list lines are
 * normalized to a simple "- " dash
 * (her explicit call — structure survives pasting, weird symbols don't).
 * Display surfaces don't use this (web renders markdown; native strips it
 * its own way) — this is the CLIPBOARD contract only.
 */
export function markdownToCleanProse(text: string): string {
  if (!text) {
    return text;
  }
  if (
    !text.includes('#') &&
    !text.includes('**') &&
    !text.includes('__') &&
    !text.includes('~~') &&
    !text.includes('](') &&
    !text.includes('`')
  ) {
    return text;
  }
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^(\s*)[*\u2022]\s+/gm, '$1- ')
    .replace(/#{2,}/g, '')
    .replace(/\*{2,}/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

/* Nov 12 2026 (WEB-12) -- pair %%% runs by SHAPE, exactly as the voice proxy and the rooms do
 * (api/server/utils/steeringStrip.js), so a stray run can no longer flip the rest of a reply into
 * tag words on screen and in announcements. steeringBalance.js is a generated copy of the server's
 * pinned balancer (scripts/sync-steering-balance.mjs); never edit it here. Undo on one browser:
 * localStorage kadeBalancedTags = '0' (back to left-to-right pairing). */
const ANY_RUN_RE = /%{2,}/g;
/** Fenced blocks (an unclosed fence runs to the end while streaming) and inline code spans. */
const CODE_SPAN_RE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;
// The U+0001/U+0002 pair marks a held-out code span; they never occur in chat text.
// eslint-disable-next-line no-control-regex
const HELD_CODE_RE = /\u0001(\d+)\u0002/g;
/** The balancer hands texts past this on untouched (its MAX_CHARS). */
const BALANCE_MAX_CHARS = 150000;
/** A tag still streaming in is short; past this, or past a line break, the run was a stray. */
const IN_FLIGHT_MAX = 200;
/** Read once per page load: this runs on every render of every reply. */
const BALANCE_ON = kadeSwitchOn('balancedVoiceTags');

/** The balanced text, or null when the balancer could not run (the caller keeps the old pairing). */
function balanced(text: string): string | null {
  if (!BALANCE_ON || text.length > BALANCE_MAX_CHARS) {
    return null;
  }
  try {
    return balanceSteeringRuns(text);
  } catch {
    return null;
  }
}

const tagMarks = (text: string): number => text.split('%%%').length - 1;

/**
 * Streaming only. The balancer drops an opener whose closer has not arrived yet as a stray, which
 * would put the direction's words on screen until the closer lands (July 19 2026, Kade: tags
 * flashing in the web chat view). So when the LAST run of the text is not the closer of a tag, the
 * balancer did not close it itself (a forgotten closer: `%%%warm Hello`), and a word touches it on
 * the right with no line break after it, the text is cut at that run until more arrives.
 */
function cutTagInFlight(text: string): string {
  let start = -1;
  let end = -1;
  for (const m of text.matchAll(ANY_RUN_RE)) {
    start = m.index ?? -1;
    end = start + m[0].length;
  }
  if (start === -1 || end >= text.length) {
    return text;
  }
  const tail = text.slice(end);
  if (/\s/.test(tail[0]) || tail.length > IN_FLIGHT_MAX || tail.indexOf('\n') !== -1) {
    return text;
  }
  const before = balanced(text.slice(0, end));
  const whole = balanced(text);
  if (before == null || whole == null) {
    return text;
  }
  // the run closes a tag (the balancer writes `%%%direction%%%`), or the balancer closed it itself
  if (before.endsWith('%%%') || tagMarks(whole) > tagMarks(before)) {
    return text;
  }
  return text.slice(0, start);
}

/**
 * @param streaming pass true ONLY for text that is still streaming in (the same gate as
 *   hideDanglingVoiceTag): it also hides a tag whose closer has not arrived yet.
 */
export function stripVoiceTags(text: string, streaming = false): string {
  if (!text) {
    return text;
  }
  text = sceneTagsToScript(text);
  if (text.indexOf('%%') === -1) {
    return text;
  }
  // Code keeps its doubled percent signs (printf "%%d", batch "%%i"): held out of the pairing and
  // put back untouched at the end.
  const held: string[] = [];
  let work = text;
  if (BALANCE_ON && text.indexOf('`') !== -1) {
    work = text.replace(CODE_SPAN_RE, (code) => {
      if (code.indexOf('%%') === -1) {
        return code;
      }
      held.push(code);
      return `\u0001${held.length - 1}\u0002`;
    });
  }
  if (streaming && BALANCE_ON) {
    work = cutTagInFlight(work);
  }
  const paired = balanced(work);
  let out = (paired == null ? work : paired)
    .replace(VOICE_TAG_RE, '')
    .replace(SLOPPY_VOICE_TAG_RE, '');
  if (paired != null) {
    // a stray the balancer left, which it should not, never stays on screen (as steeringStrip.js)
    out = out.replace(ANY_RUN_RE, '');
  }
  out = out
    // A removed leading tag often leaves a stray space before the next
    // word, and removing one mid-sentence can leave doubled spaces behind.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '')
    // A removed tag at the very start of the message leaves a blank line
    // (the tag's own trailing newline) above the first real line. Trim
    // leading whitespace/newlines from the start of the whole string only --
    // never mid-document, where blank lines are real paragraph breaks.
    .replace(/^\s+/, '');
  return held.length ? out.replace(HELD_CODE_RE, (m, n: string) => held[Number(n)] ?? m) : out;
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
  // Two distinct things to hide, and only these two:
  //  1. A COMPLETE opener that has no closer yet. stripVoiceTags already
  //     removed every complete %%%...%%% pair, so any "%%%" still present is
  //     by definition an opener whose closer hasn't streamed in yet.
  //  2. A PARTIAL opener still mid-arrival at the very end of the text --
  //     "%" or "%%" that is about to become "%%%" on the next token.
  // Refined July 19 2026 (self-audit): this originally cut at the first "%%"
  // anywhere, which also truncated a literal double-percent in ordinary prose
  // ("I am 100%% sure about that." rendered as "I am 100" while streaming).
  // That was transient -- the gate is streaming-only, so the full text came
  // back the moment the message finished -- but it was still real text
  // disappearing mid-stream for no good reason. Anchoring case 2 to the end
  // of the string fixes it: a "%%" with more text after it cannot be an
  // in-progress opener, because the rest of the token already arrived.
  const openerIndex = strippedText.indexOf('%%%');
  if (openerIndex !== -1) {
    return strippedText.slice(0, openerIndex);
  }
  const partial = /%{1,2}$/.exec(strippedText);
  return partial ? strippedText.slice(0, partial.index) : strippedText;
}
