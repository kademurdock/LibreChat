/**
 * Oct 28 2026: one row per live video face session the server minted. The
 * phone's usage report must name a row it owns; the row is settled once,
 * and the seconds billed are capped by the row's own clock (now - mintedAt)
 * and ceiling, so a client can neither invent minutes nor bill a session
 * that never existed.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    agentId: { type: String, required: true, maxlength: 64 },
    lane: { type: String, default: 'chat', maxlength: 16 },
    faceId: { type: String, default: null, maxlength: 120 },
    mintedAt: { type: Date, required: true, index: true },
    ceilingSeconds: { type: Number, required: true },
    settledAt: { type: Date, default: null },
    billedSeconds: { type: Number, default: 0 },
  },
  { timestamps: false },
);
schema.index({ userId: 1, settledAt: 1, mintedAt: -1 });

const KadeLiveFaceSession =
  mongoose.models.KadeLiveFaceSession || mongoose.model('KadeLiveFaceSession', schema);

async function mint({ userId, agentId, lane, faceId, ceilingSeconds, now = new Date() }) {
  const row = await KadeLiveFaceSession.create({
    userId: String(userId),
    agentId: String(agentId).slice(0, 64),
    lane: String(lane || 'chat').slice(0, 16),
    faceId: faceId ? String(faceId).slice(0, 120) : null,
    mintedAt: now,
    ceilingSeconds,
  });
  return String(row._id);
}

/* How many sessions this person opened since `since` (the mint rate cap). */
async function mintedSince(userId, since) {
  return KadeLiveFaceSession.countDocuments({ userId: String(userId), mintedAt: { $gte: since } });
}

/* Settles a session once. Returns {row, seconds} or null when it is not this
 * person's, does not exist, or was already settled. */
async function settle({ sessionId, userId, claimedSeconds, now = new Date() }) {
  if (!mongoose.Types.ObjectId.isValid(String(sessionId || ''))) return null;
  const row = await KadeLiveFaceSession.findOne({ _id: sessionId, userId: String(userId), settledAt: null }).lean();
  if (!row) return null;
  const seconds = billableSeconds({
    claimed: claimedSeconds,
    mintedAt: row.mintedAt,
    ceiling: row.ceilingSeconds,
    now,
  });
  const done = await KadeLiveFaceSession.findOneAndUpdate(
    { _id: row._id, settledAt: null },
    { $set: { settledAt: now, billedSeconds: seconds } },
    { new: true },
  ).lean();
  if (!done) return null;
  return { row: done, seconds };
}

const { billableSeconds } = require('~/server/routes/LiveFace/policy');

module.exports = { KadeLiveFaceSession, mint, mintedSince, settle, billableSeconds };
