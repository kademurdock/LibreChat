// ── Anti-AI-tells scrubber (July 21 2026) ───────────────────────────────────
// Fork copy of the deterministic engine in kade-ai-bridge/voice-commands.js
// (session 21j; taxonomy: AI_WRITING_TELLS_STOPGAP_REFERENCE). Removes the
// PHRASE-based universal [BAN] tells (sycophancy openers, reflexive apology,
// mask-slips, empty signposts, canned closers) — mechanical noise a regex can
// safely delete. Structure-level tells (negation pivot, cadence) are NOT
// touched (the prompt layer owns those). Applied to the FINAL saved assistant
// message in BaseClient.saveMessageToDatabase — the low-risk MVP from the
// live-stream-filter plan: the persisted/re-read text is clean even if the
// live stream briefly showed raw. Keep the two copies in sync when editing.
const AI_TELL_LEAD_BANS = [
  /^\s*(?:great|excellent|fantastic|wonderful|brilliant|good|interesting|fascinating|love(?:d)?)\s+(?:question|point|catch|observation|idea|ask)\s*!?[.,]?\s*/i,
  /^\s*(?:that['’]s|what)\s+(?:a\s+)?(?:great|excellent|fascinating|wonderful|brilliant|interesting)\b[^.!?]*[.!?]\s*/i,
  /^\s*you['’]re\s+(?:absolutely\s+)?right[^.!?]*[.!?]\s*/i,
  /^\s*i\s+love\s+(?:that|how)\b[^.!?]*[.!?]\s*/i,
];
const AI_TELL_SENTENCE_BANS = [
  /\bas an ai(?:\s+language model)?\b[^.!?]*[.!?]/gi,
  /\bi(?:'m| am)\s+(?:just\s+)?an ai\b[^.!?]*[.!?]/gi,
  /\bi\s+don['’]t\s+have\s+(?:personal\s+)?(?:feelings|opinions|emotions|experiences|a body)\b[^.!?]*[.!?]/gi,
  /\bas of my last (?:knowledge\s+)?(?:update|training)[^.!?]*[.!?]/gi,
  /\bi\s+don['’]t\s+have\s+access\s+to\s+real-?time[^.!?]*[.!?]/gi,
  /\bi\s+(?:can(?:'|no)?t|am unable to)\s+browse[^.!?]*[.!?]/gi,
  /\bi\s+(?:sincerely\s+|deeply\s+)?apologize(?:\s+for[^.!?]*)?[.!?]/gi,
  /\b(?:my\s+apologies|i'?m\s+(?:so\s+|really\s+)?sorry\s+for\s+(?:the\s+)?(?:confusion|any confusion|the mix-?up))[^.!?]*[.!?]/gi,
];
const AI_TELL_PHRASE_BANS = [
  /\bit['’]s\s+(?:worth\s+noting|important\s+to\s+(?:note|remember|mention|consider))\s+that\s+/gi,
  /\bplease\s+note\s+that\s+/gi,
  /\bkeep\s+in\s+mind\s+that\s+/gi,
  /\bneedless\s+to\s+say,?\s+/gi,
  /\bit\s+goes\s+without\s+saying\s+that\s+/gi,
  /\bat\s+the\s+end\s+of\s+the\s+day,?\s+/gi,
];
const AI_TELL_TRAIL_BANS = [
  /\s*(?:i\s+)?hope\s+(?:this|that)\s+helps?!?\s*$/i,
  /\s*(?:please\s+)?(?:feel\s+free\s+to|don['’]t\s+hesitate\s+to)\s+reach\s+out[^.!?]*[.!?]?\s*$/i,
  /\s*let\s+me\s+know\s+if\s+(?:you\s+)?(?:have\s+any\s+questions|(?:you\s+)?need\s+anything(?:\s+else)?)[^.!?]*[.!?]?\s*$/i,
  /\s*is\s+there\s+anything\s+else\s+i\s+can\s+(?:help|assist)[^.!?]*\??\s*$/i,
];

function scrubSegment(t) {
  for (const re of AI_TELL_LEAD_BANS) t = t.replace(re, '');
  for (const re of AI_TELL_SENTENCE_BANS) t = t.replace(re, '');
  for (const re of AI_TELL_PHRASE_BANS) t = t.replace(re, '');
  for (const re of AI_TELL_TRAIL_BANS) t = t.replace(re, '');
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_all, pre, ch) => pre + ch.toUpperCase());
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

/**
 * Remove phrase-based AI-writing tells from assistant text. Fenced code
 * blocks (``` ... ```) pass through UNTOUCHED — the recapitalization step
 * must never rewrite code. Fail-soft: any internal error returns the input.
 */
function stripAiTells(text) {
  if (!text || typeof text !== 'string') return text;
  try {
    const parts = text.split(/(```[\s\S]*?(?:```|$))/);
    const out = parts.map((p, i) => (i % 2 === 1 ? p : scrubSegment(p))).join('');
    const trimmed = out.trim();
    // Never scrub a message down to nothing -- an empty saved reply is worse
    // than a tell-y one.
    return trimmed.length > 0 ? trimmed : text;
  } catch {
    return text;
  }
}

module.exports = { stripAiTells };
