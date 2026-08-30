/* KADE July 22 2026 — the "last breaker" Moonshot-cache stabilizer.
 *
 * The reframe fingerprint receipts showed the injected memories/context user
 * message (~14,697 chars) mutating its hash EVERY request at constant length.
 * The mutator: `Conversation Date & Time: <iso ms>` from
 * buildWebSearchDynamicContext, anchored to req.conversationCreatedAt — which
 * on the CALL lane is minted fresh per turn (`conversationId: "new"` every
 * turn by design, see inworld proxy lcAsk), so the anchor IS wall-clock and
 * the whole cached prefix dies from that message on.
 *
 * Fix: floor the anchor to LC_TIME_ANCHOR_QUANTUM_MIN minutes (default 60)
 * ONLY where it feeds the LLM payload. Within a window the rendered
 * timestamp is byte-identical -> the context message hash holds -> cache
 * hits; the window roll pays one re-prefill (same trade LC_TRANSCRIPT_QUANTUM
 * makes for the transcript window). Precision loss is acceptable by prior
 * art: upstream already anchors these vars to conversation *creation* time,
 * which in an old chat is DAYS staler than an hour-floored now. Exact time
 * stays available to personas via the clock tool.
 *
 * Deliberately NOT applied to req.conversationCreatedAt itself —
 * BaseClient.saveConvo uses that value as the persisted conversation
 * createdAt on insert, and stored timestamps must stay exact.
 *
 * LC_TIME_ANCHOR_QUANTUM_MIN=0 restores the old exact behavior instantly.
 */

const DEFAULT_QUANTUM_MIN = 60;

export function quantizeTimeAnchor(input?: string | number | Date): Date | undefined {
  const raw = process.env.LC_TIME_ANCHOR_QUANTUM_MIN;
  const parsed = raw != null && raw !== '' ? Number(raw) : DEFAULT_QUANTUM_MIN;
  const quantumMin = Number.isFinite(parsed) ? parsed : DEFAULT_QUANTUM_MIN;

  const base = input != null ? new Date(input) : new Date();
  if (Number.isNaN(base.getTime())) {
    /** Unparseable anchor: hand back undefined so replaceSpecialVars falls
     *  through to its own `dayjs()` default rather than an Invalid Date. */
    return undefined;
  }
  if (!(quantumMin > 0)) {
    return base;
  }
  const quantumMs = quantumMin * 60_000;
  return new Date(Math.floor(base.getTime() / quantumMs) * quantumMs);
}

/* KADE Aug 30 2026 (Part 99.2) — THE HOUSE CLOCK, BECAUSE THE PROMPT HAS BEEN
 * CARRYING TWO OF THEM.
 *
 * Kiana's persona holds exactly one time line, `Current date: {{current_date}}`,
 * and replaceSpecialVars renders it against `req.body?.timezone`. Only ONE
 * caller ever sends that field: the web client, via createPayload's
 * `getUserTimezone()`. The iOS app, the phone/call lane and every headless ask
 * (the inworld proxy's lcAsk, spontaneous texts, check-ins, reminders) build
 * their own bodies and send nothing — and there is no TZ variable on the
 * LibreChat service, so those lanes fell through to the container default,
 * which on Railway is UTC.
 *
 * Meanwhile kadeWorldPulse's getWorldBlock injects `Today is <Central date>`
 * on EVERY turn. So after 7 PM Central the same prompt told the model it was
 * both Saturday and Sunday, and a model reconciling two contradictory dates
 * lands somewhere between them — which is what the family reported as "she
 * gets the time wrong," on the app, in the evening, and never on the website.
 *
 * Every other clock in this fork already hardcodes America/Chicago (~24 sites:
 * the reminder resolver, the diary, card recall, echoes, nudges, the daily
 * word, the clock routes, consolidation). This makes the prompt agree with
 * them. A REAL browser timezone still wins — a family member travelling keeps
 * their own wall clock; this only fills the hole where nothing was sent.
 *
 * LC_DEFAULT_TIMEZONE overrides; LC_DEFAULT_TIMEZONE='' restores the old
 * UTC-fallback behaviour exactly. */
export const HOUSE_TIMEZONE = 'America/Chicago';

export function resolveTimezone(supplied?: string): string | undefined {
  if (typeof supplied === 'string' && supplied.trim() !== '') {
    return supplied.trim();
  }
  const fallback = process.env.LC_DEFAULT_TIMEZONE;
  if (fallback === '') {
    return undefined;
  }
  return fallback != null && fallback.trim() !== '' ? fallback.trim() : HOUSE_TIMEZONE;
}
