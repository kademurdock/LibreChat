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
  /* Sep 21 2026. "Certainly!" and "I'd be happy to" are the two assistant
   * openers with no human left in them at all -- the sentence after each one
   * stands perfectly well alone, which is the only test for putting a phrase
   * on this list. "Of course" and "Sure" are NOT here: people say those. */
  /^\s*certainly[!.,:]\s*/i,
  /^\s*i['’]d\s+be\s+happy\s+to\s+(?:help\s+(?:you\s+)?)?(?:with\s+that\s*)?[!.,:]\s*/i,
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
  /* Part 292 (Sep 25 2026), her ear: "College essay crap." The two most
   * frequent essay shapes in 45 real casual replies on her seat were a label
   * sentence standing on its own ("That's the whole design.", "That's the
   * trap.": 22 times in 15 replies) and a "Same X, different Y." fragment.
   * Both only name what the sentences before them already said, so the reply
   * stands without them. Whole sentences only, never the last words of a
   * longer one, and only with a period: "That's the spirit!" and "That's the
   * one?" are people talking. "the whole X" takes any noun; without "whole",
   * only nouns that label a situation. The never-empty guard in scrubCore
   * keeps a one-sentence reply intact. */
  /(?:^|(?<=[.!?]["”’)]?\s+)|(?<=%{3}\s?))that['’]s\s+the\s+(?:whole|entire)\s+[a-z]+(?:\s+[a-z]+)?\.[ \t]*/gi,
  /(?:^|(?<=[.!?]["”’)]?\s+)|(?<=%{3}\s?))that['’]s\s+the\s+(?:real\s+|actual\s+|exact\s+)?(?:trick|trap|loop|move|register|design|game|catch|tell|pattern|kicker|magic|genius|beauty|hook|engine|mechanism|math|whole\s+thing)\.[ \t]*/gi,
  /(?:^|(?<=[.!?]["”’)]?\s+)|(?<=%{3}\s?))same\s+[a-z]+(?:\s+[a-z]+)?,\s+(?:different|opposite|new|other)\s+[a-z]+(?:\s+[a-z]+)?\.[ \t]*/gi,
];
const AI_TELL_PHRASE_BANS = [
  /\bit['’]s\s+(?:worth\s+noting|important\s+to\s+(?:note|remember|mention|consider))\s+that\s+/gi,
  /\bplease\s+note\s+that\s+/gi,
  /\bkeep\s+in\s+mind\s+that\s+/gi,
  /\bneedless\s+to\s+say,?\s+/gi,
  /\bit\s+goes\s+without\s+saying\s+that\s+/gi,
  /\bat\s+the\s+end\s+of\s+the\s+day,?\s+/gi,
  /* Sep 21 2026: the essay-shaped connectives. KADE_STYLE_NOTE has banned
   * these in words since July; the meter is there to say whether that worked,
   * and these three can be cut without touching the sentence. */
  /\bin\s+(?:conclusion|summary),?\s+/gi,
  /\bto\s+sum\s+up,?\s+/gi,
  /\bin\s+today['’]s\s+(?:world|fast-?paced\s+world|digital\s+age),?\s+/gi,
  /* Part 292: the build-up before a point ("Here's the thing:", "Here's my
   * read --"). Only with the colon or dash that makes it a lead-in; the point
   * after it stands alone and is recapitalised. */
  /\bhere['’]s\s+(?:the\s+thing|the\s+deal|the\s+kicker|the\s+catch|my\s+(?:read|take)|what\s+(?:i\s+think|gets\s+me|kills\s+me|matters))\s*(?::|\s[—–-]{1,2})\s*/gi,
];
const AI_TELL_TRAIL_BANS = [
  /\s*(?:i\s+)?hope\s+(?:this|that)\s+(?:helps?|is\s+helpful|gives\s+you[^.!?]*)!?[.!?]?\s*$/i,
  /\s*(?:please\s+)?(?:feel\s+free\s+to|don['’]t\s+hesitate\s+to)\s+reach\s+out[^.!?]*[.!?]?\s*$/i,
  /\s*let\s+me\s+know\s+if\s+(?:you\s+)?(?:have\s+any\s+questions|(?:you\s+)?need\s+anything(?:\s+else)?)[^.!?]*[.!?]?\s*$/i,
  /\s*is\s+there\s+anything\s+else\s+i\s+can\s+(?:help|assist)[^.!?]*\??\s*$/i,
];

function scrubSegment(t, includeTrail) {
  t = t.replace(/\b(?:turn\d+[a-z]+\d+)+\b/gi, '');
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

// July 27 2026 (Kade: "make sure it applies to all users, all AI on the
// platform"): the PROMPT-layer style note used to live only in the chat
// lane's build.js — the direct-completion persona lanes (Clubhouse bot
// guests, Parlor table talk, agent card seats, Debate Room) never saw it,
// which is exactly where replies read "more AI" than chat. Canonical copy
// now lives HERE (the anti-tell home file, dependency-free = no require
// cycles); build.js and every direct lane import it. Edit it in ONE place.
const KADE_CONVERSATION_NOTE = "\n\n---\nCONVERSATION (private instructions): Companionship is a full use of this platform. A person can share a day, enjoy an argument, tell a ridiculous story or hang out without needing a task solved. Respond with your character's own tastes, temperament, humor and curiosity. You may tease, disagree, riff, laugh or bring an interesting connection. A brief response can be enough, and a good story or explanation can take room. Match their interest, not a sentence count. Keep each character distinct. Do not borrow another character's slang, background or attitude. Expertise belongs in the conversation when relevant; use tools decisively when the person needs real work. A capable friend can research something and still sound like the same person afterward. React to the actual detail, then follow what interests you. A joke, an honest opinion or a question about how they feel can be a good contribution. Ordinary uncertainty does not automatically need a plan. Do not manufacture worries, diagnoses, motives, biography or chores to have something to say. Respect a correction and continue the conversation without withdrawing warmth. Your personality does not require a moral, polished maxim, forced punchline, dialect quota, therapy script or closing question. Let an emotional tone continue as long as it fits. Keep laughter and supported vocal sounds. A serious subject can still allow affectionate humor when the person welcomes it; avoid mockery of distress. Requested creative performances keep their own style. Remain truthful about facts, capabilities and actions.";

/* ── THE ANTI-TELL RULES, RESTORED (Sep 21 2026) ──────────────────────────
 *
 * WHAT HAPPENED. This constant used to carry the platform's anti-tell block,
 * and the rewrite that turned it into the CONVERSATION note above took every
 * one of those rules with it: the contrastive-pivot ban, the puffery list,
 * "as an AI", praise openers, restating the question, the tool-narration ban
 * and the rule-of-three warning. All seven were checked for across BOTH house
 * notes afterwards and none of them survived anywhere. The companionship text
 * above is hers and is good and is untouched; this is the half that went
 * missing beside it.
 *
 * WHY IT MATTERS RIGHT NOW, with a number. The Jev voice-flags lane read the
 * day's 24 real replies five times over and flagged the reframe tic in 12 of
 * them every single pass, while the regex beside it caught 3. Half of every
 * reply carries the tell, and as of the rewrite nothing in the prompt was
 * telling it not to.
 *
 * WHAT IS DIFFERENT THIS TIME, because the old ban ran for two months and did
 * not work. It was a prohibition with no replacement: the model has a thought
 * to land and the pivot is the shape it reaches for, so "do not" leaves it
 * nowhere to go. This gives it the repair instead, worked through three times,
 * and names the reason the repair always works -- the first half of the
 * construction never carries anything, so deleting the denial loses nothing.
 * Prompts on this platform teach by example far better than by rule; that is
 * why the voice-tag block lands and this one did not.
 *
 * Written deliberately in plain speech and checked against the platform's own
 * essayVoice detector, which reads it clean. A ban on literary phrasing that
 * is itself written in literary phrasing teaches the opposite of what it says. *
 * SEP 22 2026 -- THE EXAMPLES WERE TEACHING THE TIC. The first battery run
 * under this note (07:00Z) read Kiana's reframe tic at 9 of 24 judgments,
 * up from 6, against the control's 4, and two of her five flagged sentences
 * were near-copies of the Before examples that used to sit here: "that's not
 * a kitchen, that's an appliance showroom with a couch in it" (the diner
 * example) and "That's not weird. That's what a body does..." (the laziness
 * example). The note quoted the construction six times, and the platform's
 * own tellsIn() flagged the house note itself for 'pivot'. A model reproduces
 * what it is shown, including under a "do not". So the habit is now described
 * in words and taught only through plain statements; the note must carry no
 * instance of the construction, and a test holds it to that with the same
 * detector that reads the replies.
 *
 * SAME DAY, 20:16Z -- AND THE RE-RUN DID NOT BEAR THAT OUT. With this note
 * live, a manual battery read Kiana 15 of 24 and the control 8 of 24 on the
 * LLM judges (both the highest ever) while Jev read them flat, and Kiana made
 * the same kitchen joke with no example in sight. The probes invite the
 * construction, so the lookalike sentences were a hypothesis, not a cause.
 * This note stands on its principle (never demonstrate a banned form), not
 * on proof. The revert rule and the numbers are in
 * ANDROID_PARITY_AND_PIVOT_2026-09-22_PART265.md in the project folder.
 */
const KADE_TELL_NOTE = `

---
HABITS TO DROP (private instructions, never mention them): a few phrasings mark writing as machine-made. Do not open by praising what they said. Do not apologise unless you did something. Do not say you are an AI, mention a training cutoff, or say you cannot browse. Do not say their question back to them before answering it. Do not close by offering more help. Skip delve, tapestry, testament, seamless, robust, elevate, unlock, game-changer, and "it is worth noting". Do not narrate choosing a tool. Use it and answer. Watch one habit harder than the rest, the correction move: leading up to your point by first saying what something is not, when nobody said it was. That denial carries nothing, so delete the denial and say the true thing on its own. Plain statements like these are the whole repair: "Your body is asking for a rest." "That place is basically a living room with a grill." "He buys kitchen gadgets the way some people buy shoes." When the person really did get something wrong, correct it once, plainly, and move on. Most replies should not contain the move at all.`;

const KADE_STYLE_NOTE = KADE_CONVERSATION_NOTE + KADE_TELL_NOTE;

module.exports = { stripAiTells, scrubMessageForTransmit, createStreamScrubber, KADE_STYLE_NOTE };
