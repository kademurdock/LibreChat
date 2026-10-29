/**
 * Oct 28 2026 (Kade: "what if someone dreams up a char they want to talk to
 * through the builder... consider that pipeline for future agents"). One row
 * per character that has, or is getting, a live video face: the face the
 * video service built from the character's own portrait.
 *
 *   status: 'pending' | 'processing' | 'completed' | 'failed'
 *   faceId: the service's id (usable once completed)
 *
 * Kiana and Harley may also come from the SIMLI_FACES env map; the router
 * merges both (env wins, so a hand-made face is never shadowed).
 */
const mongoose = require('mongoose');

const STATUSES = ['pending', 'processing', 'completed', 'failed'];

const schema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, unique: true, index: true },
    faceId: { type: String, default: null, maxlength: 120 },
    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    requestedBy: { type: String, default: null },
    portrait: { type: String, default: null, maxlength: 2000 },
    warnings: { type: [String], default: [] },
    dispatchAfter: { type: Number, default: null },
    error: { type: String, default: null, maxlength: 500 },
    checkedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const KadeLiveFace = mongoose.models.KadeLiveFace || mongoose.model('KadeLiveFace', schema);

function plain(row) {
  if (!row) return null;
  return {
    agentId: row.agentId,
    faceId: row.status === 'completed' ? row.faceId : null,
    status: row.status,
    warnings: row.warnings || [],
    dispatchAfter: row.dispatchAfter || null,
    error: row.error || null,
    updatedAt: row.updatedAt || null,
  };
}

async function getFace(agentId) {
  return plain(await KadeLiveFace.findOne({ agentId: String(agentId) }).lean());
}

/* Every finished face, as {agentId: faceId}, for the session gate. */
async function completedFaces() {
  const rows = await KadeLiveFace.find({ status: 'completed', faceId: { $ne: null } }, { agentId: 1, faceId: 1 }).lean();
  const out = {};
  for (const r of rows) out[r.agentId] = r.faceId;
  return out;
}

async function recordRequest(agentId, { faceId, requestedBy, portrait, warnings, dispatchAfter }) {
  const row = await KadeLiveFace.findOneAndUpdate(
    { agentId: String(agentId) },
    {
      $set: {
        faceId: faceId || null,
        status: 'pending',
        requestedBy: requestedBy ? String(requestedBy) : null,
        portrait: portrait ? String(portrait).slice(0, 2000) : null,
        warnings: Array.isArray(warnings) ? warnings.map(String).slice(0, 20) : [],
        dispatchAfter: Number.isFinite(dispatchAfter) ? dispatchAfter : null,
        error: null,
        checkedAt: new Date(),
      },
      $setOnInsert: { agentId: String(agentId) },
    },
    { upsert: true, new: true },
  ).lean();
  return plain(row);
}

async function recordStatus(agentId, status, { error, dispatchAfter } = {}) {
  if (!STATUSES.includes(status)) throw new Error('bad status ' + status);
  const $set = { status, checkedAt: new Date() };
  if (error !== undefined) $set.error = error ? String(error).slice(0, 500) : null;
  if (dispatchAfter !== undefined) $set.dispatchAfter = Number.isFinite(dispatchAfter) ? dispatchAfter : null;
  const row = await KadeLiveFace.findOneAndUpdate({ agentId: String(agentId) }, { $set }, { new: true }).lean();
  return plain(row);
}

/* Pending or processing rows older than `olderThanMs` since their last check. */
async function dueForCheck(olderThanMs) {
  const since = new Date(Date.now() - olderThanMs);
  return KadeLiveFace.find({
    status: { $in: ['pending', 'processing'] },
    $or: [{ checkedAt: null }, { checkedAt: { $lt: since } }],
  }).lean();
}

/* Builds this person started since `since` (the per-day cap). */
async function requestsSince(userId, since) {
  return KadeLiveFace.countDocuments({ requestedBy: String(userId), createdAt: { $gte: since } });
}

const { mergeFaces } = require('~/server/routes/LiveFace/policy');

module.exports = { KadeLiveFace, STATUSES, getFace, completedFaces, recordRequest, recordStatus, dueForCheck, requestsSince, mergeFaces, plain };
