/**
 * KADE MEMORY LEDGER — every consolidation edit, on the record (Aug 15 2026,
 * Part 69, rung 2). Her law for this lane: "Every edit logged to a ledger she
 * can hear"; contradiction handling is "newer wins, the old note kept in a
 * short trail — never silent loss."
 *
 * What lands here: one row per set/delete/refusal made by the connection pass
 * (consolidate-v2), with the BEFORE value captured at edit time — so even a
 * hard delete leaves its words behind. The spoken window (kade_memory_search
 * `changes` lane) reads this newest-first and says it plainly.
 *
 * SCOPING is the card rule: rows are keyed to the bucket they touched; a
 * character's ledger view = shared rows + its own bucket's rows only.
 *
 * Plain Mongoose on purpose (kadeDiary precedent).
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const kadeMemoryLedgerSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    /** null = shared bucket; string = that character's bucket. */
    agentId: { type: String, default: null },
    key: { type: String, required: true },
    /** 'set' (create or rewrite) | 'delete' | 'refused' (a guarded edit the pass was denied) */
    action: { type: String, required: true },
    /** Value before the edit ('' when the card is brand new). */
    before: { type: String, default: '' },
    /** Value after the edit ('' for deletes). */
    after: { type: String, default: '' },
    /** Plain-language note: why, or what rule refused it. */
    note: { type: String, default: '' },
    /** 'consolidate-v2' now; future lanes name themselves. */
    source: { type: String, default: 'consolidate-v2' },
  },
  { timestamps: true },
);
kadeMemoryLedgerSchema.index({ userId: 1, agentId: 1, createdAt: -1 });

const KadeMemoryLedger =
  mongoose.models.KadeMemoryLedger ||
  mongoose.model('KadeMemoryLedger', kadeMemoryLedgerSchema, 'kadememoryledgers');

/** Append one row. Never throws — a ledger hiccup must never block an edit
 * (the edit itself is already trailed by the supersede chain in memoryentries). */
async function addLedger({ userId, agentId = null, key, action, before = '', after = '', note = '', source = 'consolidate-v2' }) {
  try {
    await KadeMemoryLedger.create({
      userId: String(userId),
      agentId: agentId == null ? null : String(agentId),
      key: String(key),
      action,
      before: String(before || '').slice(0, 2000),
      after: String(after || '').slice(0, 2000),
      note: String(note || '').slice(0, 500),
      source,
    });
    return true;
  } catch (e) {
    logger.warn('[kadeMemoryLedger] append failed (edit stands, trail short one row):', e.message);
    return false;
  }
}

/**
 * Read the trail, newest first, scoped like cards (shared + this agent's own).
 * Returns rows shaped for the ear: { when, bucket, key, action, before, after, note }.
 */
async function readLedger({ userId, agentId = null, limit = 12, sinceDays = null }) {
  try {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 40);
    const filter = {
      userId: String(userId),
      $or: [{ agentId: null }, ...(agentId ? [{ agentId: String(agentId) }] : [])],
    };
    if (sinceDays && Number.isFinite(Number(sinceDays))) {
      filter.createdAt = { $gte: new Date(Date.now() - Number(sinceDays) * 86400000) };
    }
    const rows = await KadeMemoryLedger.find(filter).sort({ createdAt: -1 }).limit(cap).lean();
    return rows.map((r) => ({
      when: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '',
      bucket: r.agentId ? 'own' : 'shared',
      key: r.key,
      action: r.action,
      before: r.before,
      after: r.after,
      note: r.note,
    }));
  } catch (e) {
    logger.warn('[kadeMemoryLedger] read failed:', e.message);
    return [];
  }
}

module.exports = { KadeMemoryLedger, addLedger, readLedger };
