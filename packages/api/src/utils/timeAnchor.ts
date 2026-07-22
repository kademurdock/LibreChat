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
