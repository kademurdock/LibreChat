/* KADE HISTORY MINER state — one row per conversation ever mined, the
 * atomic run-once guard (unique conversationId; create() throws on dupe =
 * claim lost). Survives deploys so a re-kick resumes, never re-mines. */
const mongoose = require('mongoose');

const kadeMiningStateSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    agentId: { type: String, default: null },
    /** 'claimed' | 'done' | 'skipped:<why>' | 'error' */
    status: { type: String, default: 'claimed' },
    entries: { type: Number, default: 0 },
    note: { type: String },
    minedAt: { type: Date },
  },
  { timestamps: true },
);

const KadeMiningState =
  mongoose.models.KadeMiningState ||
  mongoose.model('KadeMiningState', kadeMiningStateSchema, 'kademiningstates');

module.exports = { KadeMiningState };
