/**
 * KADE 2026-08-11 — THE PROMISE GUARD.
 *
 * WHY THIS EXISTS, in one true story: Amber asked Kiana for two reminders —
 * her mother's dentist appointment, and a call to the podiatrist about foot
 * surgery. Kiana said "Done and done. I'll ping your phone Wednesday at 3:30."
 * She never called the tool. The bridge's reminder store was empty, the
 * appointment was two days out, and Amber was relying on a ping that was
 * never going to come. Nothing errored. Nothing logged. It just quietly
 * wasn't true.
 *
 * The rule already existed in kade_notify's own description — "NEVER claim
 * you sent, scheduled, or reminded anything unless the tool confirms it" —
 * and an instruction is a request, not a guarantee. This is the guarantee.
 *
 * WHAT IT DOES: after a turn finishes, if the reply CLAIMS a reminder is set
 * and no kade_notify call in that same turn came back confirmed, one honest
 * correction is appended to the reply. It never deletes or rewrites what the
 * character said — the user sees the claim AND the correction, because
 * silently editing a companion's words is its own kind of dishonesty.
 *
 * DELIBERATELY NARROW. It only fires on reminder-shaped claims, only when the
 * agent actually carries kade_notify, and never when the character already
 * said it couldn't do it. A false positive here would put an apology in a
 * character's mouth for no reason, which is worse than the bug.
 *
 * Kill switch: KADE_REMINDER_GUARD=0 (no deploy needed).
 */

/** Phrases that assert a reminder now exists. Tight on purpose. */
const PROMISE_PATTERNS = [
  /reminder\s+(?:is\s+|has\s+been\s+|was\s+)?(?:all\s+)?set\b/i,
  /\b(?:I|i)['’]?ve\s+set\s+(?:that|a|the|your|this)\s+reminder/i,
  /\bset\s+(?:that|the|a|your|this)\s+reminder\b/i,
  /\b(?:I|i)['’]?ll\s+remind\s+you\b/i,
  /\byou['’]?ll\s+get\s+a\s+reminder\b/i,
  /\breminder['’]?s?\s+locked\s+in\b/i,
  /\bgot\s+(?:that|your)\s+reminder\s+(?:set|down|in)\b/i,
];

/* A claim to deliver something to their phone LATER, in a sentence that is
 * about a reminder. This is the shape the phrase list misses and the one that
 * actually bit Amber: "Done — I'll hit your phone tomorrow at 10 AM sharp with
 * the reminder to have your mom call the podiatrist." Nothing in that sentence
 * says "reminder is set", so it needs the two halves matched together.
 * The reminder word is REQUIRED, which is what keeps the legitimate long-job
 * promise ("I'll ping your phone when it's done") from ever tripping it. */
const DELIVERY_CLAIM =
  /\b(?:I|i)['’]?(?:ll|m\s+gonna|\s+will)\s+(?:ping|hit|text|buzz|nudge|message|get|shoot)\b[^.!?]{0,80}\b(?:you|your\s+phone)\b/i;
const REMINDER_WORD = /\bremind(?:er|ers)?\b/i;

/** The character is already being honest about a failure — leave it alone. */
const HONEST_PATTERNS = [
  /\b(?:can(?:no|')?t|could\s?n[o']?t|unable\s+to|wasn['’]?t\s+able\s+to|didn['’]?t|failed\s+to)\s+(?:set|schedule|create)\b/i,
  /\bno\s+reminder\s+(?:was\s+)?(?:set|created|scheduled)\b/i,
  /\breminder\s+did\s?n[o']?t\s+(?:get\s+)?set\b/i,
  /\bnot\s+actually\s+set\b/i,
];

/** The exact success markers kade_notify returns. Anything else is a miss. */
const CONFIRMATIONS = ['Reminder set (id', 'Check-in scheduled (id'];

const CORRECTION =
  '\n\n— Correction, and I am sorry: that reminder did **not** actually get set. ' +
  'Nothing is scheduled, so nothing will arrive. Tell me the day and time once more and I will set it for real.';

function textOf(part) {
  if (!part || part.type !== 'text') return '';
  const t = part.text;
  if (typeof t === 'string') return t;
  if (t && typeof t.value === 'string') return t.value;
  return '';
}

/**
 * @param {Array} contentParts - the finished turn's content parts
 * @param {{ agentTools?: string[], logger?: object, agentId?: string }} [ctx]
 * @returns {Array} contentParts, with one correction appended if warranted
 */
function applyReminderPromiseGuard(contentParts, ctx = {}) {
  if (process.env.KADE_REMINDER_GUARD === '0') return contentParts;
  if (!Array.isArray(contentParts) || contentParts.length === 0) return contentParts;

  /* Only speak up for agents that actually hold the tool. A character with no
   * kade_notify promising a reminder is a different bug (a missing tool, not
   * a false claim) and gets logged, not corrected. */
  const tools = Array.isArray(ctx.agentTools) ? ctx.agentTools : null;
  const hasNotify = tools ? tools.includes('kade_notify') : true;

  let claimed = false;
  let honest = false;
  let confirmed = false;
  let lastTextIndex = -1;

  for (let i = 0; i < contentParts.length; i++) {
    const part = contentParts[i];
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text') {
      const t = textOf(part);
      if (t) {
        lastTextIndex = i;
        if (!claimed && PROMISE_PATTERNS.some((re) => re.test(t))) claimed = true;
        if (!claimed && DELIVERY_CLAIM.test(t) && REMINDER_WORD.test(t)) claimed = true;
        if (!honest && HONEST_PATTERNS.some((re) => re.test(t))) honest = true;
      }
      continue;
    }

    if (part.type === 'tool_call') {
      const call = part.tool_call || {};
      if (call.name !== 'kade_notify') continue;
      /* Read the OUTPUT, not the fact that a call happened: a set_reminder
       * that came back "Could not complete" is a failure the reply must not
       * dress up as success. */
      const out = typeof call.output === 'string' ? call.output : JSON.stringify(call.output || '');
      if (CONFIRMATIONS.some((marker) => out.includes(marker))) confirmed = true;
    }
  }

  if (!claimed || confirmed || honest || lastTextIndex < 0) return contentParts;

  if (!hasNotify) {
    ctx.logger?.warn?.(
      `[kade/promise-guard] agent ${ctx.agentId || '?'} promised a reminder but carries no kade_notify — not corrected, but it cannot keep that promise.`,
    );
    return contentParts;
  }

  ctx.logger?.warn?.(
    `[kade/promise-guard] CAUGHT a false reminder promise from agent ${ctx.agentId || '?'} — appended a correction.`,
  );

  const next = contentParts.slice();
  const part = next[lastTextIndex];
  const existing = textOf(part);
  if (typeof part.text === 'string') {
    next[lastTextIndex] = { ...part, text: existing + CORRECTION };
  } else if (part.text && typeof part.text.value === 'string') {
    next[lastTextIndex] = { ...part, text: { ...part.text, value: existing + CORRECTION } };
  }
  return next;
}

module.exports = {
  applyReminderPromiseGuard,
  PROMISE_PATTERNS,
  DELIVERY_CLAIM,
  REMINDER_WORD,
  HONEST_PATTERNS,
  CONFIRMATIONS,
};
