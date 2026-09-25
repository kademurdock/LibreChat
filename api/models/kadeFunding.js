const mongoose = require('mongoose');

/**
 * KADE Sep 25 2026 (Part 291) — THE FUNDING LEDGER.
 *
 * Her words: "I have added credits to people's accounts to keep them funded so they can beta test
 * for me, but so far Amber A is the only one who has sent me thirty dollars."
 *
 * Kade pays the real provider bills for everyone. This is her hand-kept record of money people
 * have paid her back ('repayment'), plus an informational row for every credit she loads with
 * add-credits ('grant'). A grant is NEVER counted as a repayment: only kind 'repayment' that is not
 * voided counts toward "paid back". Removing an entry is a void (kept, left out of the sums), never a
 * delete, and it can be restored.
 *
 * addedBy is the signed-in admin; an entry made through the server-to-server ops secret has no
 * signed-in person, so addedBy stays empty and `via` says 'ops'.
 */
const kadeFundingEntrySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    kind: { type: String, enum: ['repayment', 'grant'], default: 'repayment', index: true },
    /* Repayments are 0.01..1000 (checked by the service); a grant is the credit added, and a
     * balance correction (add-credits setUSD) may be negative. */
    usd: { type: Number, required: true, min: -1000, max: 1000 },
    note: { type: String, maxlength: 280, default: '' },
    at: { type: Date, required: true, default: Date.now },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    via: { type: String, enum: ['admin', 'ops'], default: 'admin' },
    /* Balance after a grant, for the record. */
    balanceAfterUSD: { type: Number, default: null },
    /* One per form submit: a double tap records once. */
    clientKey: { type: String, maxlength: 64 },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, maxlength: 200, default: '' },
  },
  { timestamps: true },
);

kadeFundingEntrySchema.index(
  { clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } },
);
kadeFundingEntrySchema.index({ user: 1, kind: 1, voidedAt: 1, at: -1 });

const KadeFundingEntry =
  mongoose.models.KadeFundingEntry ||
  mongoose.model('KadeFundingEntry', kadeFundingEntrySchema, 'kadefundingledger');

module.exports = { KadeFundingEntry, kadeFundingEntrySchema };
