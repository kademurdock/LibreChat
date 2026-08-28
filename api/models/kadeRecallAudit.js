/* kadeRecallAudit — WHAT RECALL HANDED OVER, KEPT LONG ENOUGH TO ASK.
 *
 * Aug 28 2026, built the day it would have mattered twice. The 92.36 audit
 * line answered the Shinedown question ("cards=[] on every turn") only
 * because somebody looked within hours — the proxy redeploys several times a
 * day and Railway's log window goes with it. Her morning voice-clip error
 * from the same day was UNPROVABLE for exactly that reason. A question that
 * can only be answered while the logs happen to be fresh is a question that
 * mostly can't be answered.
 *
 * So the same audit now also lands in mongo, with the same privacy rule the
 * log line has had since 92.36: KEYS AND DATES, NEVER VALUES. Card text is
 * the person's life and does not belong in an audit row any more than in a
 * log line. Rows expire on their own after seven days — long enough that
 * "she said something off on Tuesday" is investigable on Friday, short
 * enough that this never becomes a shadow archive of anybody's memory.
 *
 * Cost honesty (this writes on every recall-bearing turn, which is why it
 * needed her yes, given Aug 28): one small insert per turn, fire-and-forget,
 * failure swallowed — recall must never wait on, or die with, its own audit.
 * Kill switch: KADE_RECALL_AUDIT_STORE=0.
 */
const mongoose = require('mongoose');

const TTL_DAYS = 7;

const schema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    agentId: { type: String, default: null },
    /** Card KEYS surfaced by retrieval this turn (pinned-head cards are not
     * listed — they ride every turn by definition; this is the variable set). */
    cards: { type: [String], default: [] },
    /** Logbook entry DATES surfaced this turn. */
    logbook: { type: [String], default: [] },
    hit: { type: Boolean, default: false },
    ms: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: TTL_DAYS * 86400 },
  },
  { versionKey: false },
);
schema.index({ userId: 1, createdAt: -1 });

const KadeRecallAudit =
  mongoose.models.KadeRecallAudit ||
  mongoose.model('KadeRecallAudit', schema, 'kaderecallaudits');

/** Shape the row. Pure, so the keys-not-values rule is testable: whatever a
 * caller passes, only bounded strings survive, and there is no field a card
 * VALUE could ride in at all. */
function buildAuditRow({ userId, agentId, cards, logbook, hit, ms }) {
  const capStr = (v) => String(v == null ? '' : v).slice(0, 120);
  return {
    userId: capStr(userId),
    agentId: agentId == null ? null : capStr(agentId),
    cards: (Array.isArray(cards) ? cards : []).slice(0, 16).map(capStr),
    logbook: (Array.isArray(logbook) ? logbook : []).slice(0, 16).map(capStr),
    hit: Boolean(hit),
    ms: Number.isFinite(ms) ? Math.round(ms) : 0,
  };
}

/** Fire-and-forget. Never throws, never awaited by the turn. */
function storeRecallAudit(fields) {
  if (process.env.KADE_RECALL_AUDIT_STORE === '0') {
    return;
  }
  try {
    KadeRecallAudit.create(buildAuditRow(fields)).catch(() => {});
  } catch (_e) {
    /* the audit is a witness, not a dependency */
  }
}

async function readRecallAudits({ userId, limit = 50 }) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const filter = userId ? { userId: String(userId) } : {};
  return KadeRecallAudit.find(filter).sort({ createdAt: -1 }).limit(cap).lean();
}

module.exports = { KadeRecallAudit, buildAuditRow, storeRecallAudit, readRecallAudits, TTL_DAYS };
