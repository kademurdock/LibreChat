// ── Anti-AI-tells scrubber (July 21 2026) ───────────────────────────────────
// Fork copy of the deterministic engine in kade-ai-bridge/voice-commands.js
// (session 21j; taxonomy: AI_WRITING_TELLS_STOPGAP_REFERENCE). Removes the
// PHRASE-based universal [BAN] tells (sycophancy openers, reflexive apology,
// mask-slips, empty signposts, canned closers) — mechanical noise a regex can
// safely delete. Structure-level tells (negation pivot, cadence) are NOT
// touched (the prompt layer owns those). Applied to the FINAL saved assistant
// message in BaseClient.saveMessageToDatabase, to the final SSE event in the
// agents request controller, and — via createStreamScrubber below — to the
// LIVE token stream so tells never even flash on screen mid-stream. Keep the
// two copies (bridge + fork) in sync when editing the ban lists.
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

function scrubSegment(t, includeTrail) {
  for (const re of AI_TELL_LEAD_BANS) t = t.replace(re, '');
  for (const re of AI_TELL_SENTENCE_BANS) t = t.replace(re, '');
  for (const re of AI_TELL_PHRASE_BANS) t = t.replace(re, '');
  if (includeTrail) for (const re of AI_TELL_TRAIL_BANS) t = t.replace(re, '');
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_all, pre, ch) => pre + ch.toUpperCase());
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function scrubCore(text, includeTrail, allowEmpty) {
  if (!text || typeof text !== 'string') return text;
  try {
    const parts = text.split(/(```[\s\S]*?(?:```|$))/);
    const out = parts
      .map((p, i) => (i % 2 === 1 ? p : scrubSegment(p, includeTrail)))
      .join('');
    const trimmed = out.trim();
    // Never scrub a whole MESSAGE down to nothing -- an empty saved reply is
    // worse than a tell-y one. Stream PREFIXES opt out (allowEmpty): an empty
    // prefix just means "nothing safe to show yet," and resurrecting the raw
    // text there would leak the very tell being held back.
    if (allowEmpty) return trimmed;
    return trimmed.length > 0 ? trimmed : text;
  } catch {
    return text;
  }
}

/**
 * Remove phrase-based AI-writing tells from assistant text. Fenced code
 * blocks (``` ... ```) pass through UNTOUCHED — the recapitalization step
 * must never rewrite code. Fail-soft: any internal error returns the input.
 */
function stripAiTells(text) {
  return scrubCore(text, true);
}

/**
 * Scrub a message object's text + text content parts for transmission in a
 * final SSE event (or an abort-path save), the same way
 * BaseClient.saveMessageToDatabase scrubs the persisted copy — so what stays
 * on screen after streaming matches what's in the database. Returns a new
 * object; the input is not mutated. Fail-soft: any error returns the input.
 */
function scrubMessageForTransmit(message) {
  try {
    if (!message || message.isCreatedByUser === true) return message;
    const out = { ...message };
    if (typeof out.text === 'string') out.text = stripAiTells(out.text);
    if (Array.isArray(out.content)) {
      out.content = out.content.map((part) =>
        part && part.type === 'text' && typeof part.text === 'string'
          ? { ...part, text: stripAiTells(part.text) }
          : part,
      );
    }
    return out;
  } catch {
    return message;
  }
}

// ── Live stream scrubber ────────────────────────────────────────────────────
// Scrubs the OUTGOING message-delta stream so tells never flash on screen.
// Approach: per-step sentence buffering with a "stable prefix" — text is only
// emitted once it ends at a sentence boundary (or clears a size valve), and
// each emission is `scrub(prefix).slice(alreadyEmitted)`. Because the lead /
// sentence / phrase bans and the recapitalizer are all local (no lookahead
// across sentence boundaries), scrubbing a growing sentence-complete prefix
// yields monotonically extending output, which is exactly what an append-only
// SSE delta stream requires. The END-anchored trail bans are deliberately
// EXCLUDED here (they'd retract already-shown text when more arrives); the
// final SSE event + the saved copy apply the full filter including trails.
// Fail-soft at every layer: any internal error flips the scrubber into pure
// pass-through for the rest of the request — streaming can never break.
const STREAM_FLUSH_CHARS = 280; // no-sentence-boundary safety valve

/** Index just past the last complete sentence boundary in `raw`, or -1. */
function lastStableCut(raw) {
  let cut = -1;
  const re = /[.!?\n][)"'’”\]]*(?:\s+|$)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    cut = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
  }
  return cut;
}

function createStreamScrubber() {
  const streams = new Map(); // id -> { raw, sent, template, mode, passthrough }
  let dead = false;

  function stateFor(id) {
    let st = streams.get(id);
    if (!st) {
      st = { raw: '', sent: '', template: null, mode: null, passthrough: false };
      streams.set(id, st);
    }
    return st;
  }

  /** Extract streamable text from a delta data object, or null. */
  function textOf(data) {
    const c = data && data.delta && data.delta.content;
    if (typeof c === 'string') return { text: c, mode: 's' };
    if (
      Array.isArray(c) &&
      c.length === 1 &&
      c[0] &&
      c[0].type === 'text' &&
      typeof c[0].text === 'string'
    ) {
      return { text: c[0].text, mode: 'a' };
    }
    return null;
  }

  /** Rebuild a delta data object carrying `chunk` instead of its original text. */
  function withText(data, mode, chunk) {
    if (mode === 's') return { ...data, delta: { ...data.delta, content: chunk } };
    const first = data.delta.content[0];
    return { ...data, delta: { ...data.delta, content: [{ ...first, text: chunk }] } };
  }

  /** Advance a stream's stable prefix; returns the newly-emittable chunk or ''. */
  function advance(st, upTo) {
    const clean = scrubCore(st.raw.slice(0, upTo), false, true);
    if (typeof clean !== 'string' || !clean.startsWith(st.sent)) {
      // Extension property violated (should not happen) — degrade to
      // pass-through for this stream rather than ever re-writing history.
      st.passthrough = true;
      return '';
    }
    const chunk = clean.slice(st.sent.length);
    st.sent = clean;
    return chunk;
  }

  return {
    /**
     * Transform one ON_MESSAGE_DELTA data object. Returns an array of data
     * objects to emit in order (possibly empty while text is held back).
     */
    transform(data) {
      if (dead) return [data];
      try {
        const id = data && data.id;
        const t = textOf(data);
        if (id == null || t == null) {
          // Non-text or unrecognized shape: flush anything held, pass through.
          const flushed = id != null ? this.flushId(id) : [];
          return [...flushed, data];
        }
        if (t.text === '') return [data]; // protocol no-op, keep as-is
        const st = stateFor(id);
        if (st.passthrough) return [data];
        st.template = data;
        st.mode = t.mode;
        st.raw += t.text;
        let end = lastStableCut(st.raw);
        if (end < 0) end = 0;
        if (st.raw.length - end > STREAM_FLUSH_CHARS) end = st.raw.length;
        if (end === 0) return [];
        const chunk = advance(st, end);
        if (st.passthrough) return [data]; // degraded mid-delta: emit raw
        return chunk === '' ? [] : [withText(data, st.mode, chunk)];
      } catch {
        dead = true;
        return [data];
      }
    },

    /** Flush one stream's held tail (scrubbed, no trail bans). */
    flushId(id) {
      try {
        const st = streams.get(id);
        if (!st || st.passthrough || !st.template) return [];
        const chunk = advance(st, st.raw.length);
        streams.delete(id);
        return chunk ? [withText(st.template, st.mode, chunk)] : [];
      } catch {
        dead = true;
        return [];
      }
    },

    /** Flush every stream (call at model end so no tail is left held back). */
    flushAll() {
      try {
        const out = [];
        for (const id of [...streams.keys()]) out.push(...this.flushId(id));
        return out;
      } catch {
        dead = true;
        return [];
      }
    },
  };
}

module.exports = { stripAiTells, scrubMessageForTransmit, createStreamScrubber };
