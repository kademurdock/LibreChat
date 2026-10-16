/**
 * KADE Oct 16 2026 — a character's puppet body: the recipe a person built in the
 * Body editor (web or iPhone), compiled on demand into a code-drawn scene.
 *
 * Kept OUT of the Agent document on purpose: every agent save copies the whole
 * document into an uncapped `versions` array and every chat turn loads it, so a
 * body edited with sliders would bloat each turn (the Kiana 13.4 MB lesson), and
 * an agent revert would silently roll the body back. One row per agent, a revision
 * number for conflict checks, and the last ten revisions for undo.
 */
const mongoose = require('mongoose');

const HISTORY_LIMIT = 10;

const kadeAgentBodySchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, unique: true, index: true },
    rev: { type: Number, required: true, default: 1 },
    recipe: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, maxlength: 1500 },
    /* editor | words | picture | surprise | auto — how this revision was made. */
    source: { type: String, default: 'editor', maxlength: 24 },
    updatedBy: { type: String },
    history: [
      {
        _id: false,
        rev: Number,
        recipe: mongoose.Schema.Types.Mixed,
        description: String,
        source: String,
        updatedBy: String,
        at: Date,
      },
    ],
  },
  { timestamps: true, minimize: false },
);

const KadeAgentBody =
  mongoose.models.KadeAgentBody || mongoose.model('KadeAgentBody', kadeAgentBodySchema);

async function getAgentBody(agentId) {
  return KadeAgentBody.findOne({ agentId: String(agentId) }, { history: 0 }).lean();
}

async function getAgentBodies(agentIds) {
  const ids = [...new Set((agentIds || []).map(String))].slice(0, 200);
  if (!ids.length) {
    return [];
  }
  return KadeAgentBody.find({ agentId: { $in: ids } }, { history: 0 }).lean();
}

/**
 * Save a new revision. `baseRev` is the revision the editor started from (0 when
 * the agent had no body). Returns { ok: true, body } or { ok: false, conflict: body }
 * when someone else saved first (web and phone editing at once).
 */
async function saveAgentBody(agentId, { recipe, description, source, updatedBy, baseRev }) {
  const id = String(agentId);
  const now = new Date();
  const current = await KadeAgentBody.findOne({ agentId: id }).lean();
  if (!current) {
    if (Number(baseRev || 0) !== 0) {
      return { ok: false, conflict: null };
    }
    try {
      const created = await KadeAgentBody.create({
        agentId: id,
        rev: 1,
        recipe,
        description,
        source,
        updatedBy,
        history: [],
      });
      const body = created.toObject();
      delete body.history;
      return { ok: true, body };
    } catch (e) {
      if (e && e.code === 11000) {
        const latest = await getAgentBody(id);
        return { ok: false, conflict: latest };
      }
      throw e;
    }
  }
  if (Number(baseRev) !== current.rev) {
    const { history: _h, ...latest } = current;
    return { ok: false, conflict: latest };
  }
  const updated = await KadeAgentBody.findOneAndUpdate(
    { agentId: id, rev: current.rev },
    {
      $set: { recipe, description, source, updatedBy, rev: current.rev + 1 },
      $push: {
        history: {
          $each: [
            {
              rev: current.rev,
              recipe: current.recipe,
              description: current.description,
              source: current.source,
              updatedBy: current.updatedBy,
              at: current.updatedAt || now,
            },
          ],
          $slice: -HISTORY_LIMIT,
        },
      },
    },
    { new: true, projection: { history: 0 } },
  ).lean();
  if (!updated) {
    const latest = await getAgentBody(id);
    return { ok: false, conflict: latest };
  }
  return { ok: true, body: updated };
}

async function deleteAgentBody(agentId) {
  await KadeAgentBody.deleteOne({ agentId: String(agentId) });
}

async function getAgentBodyHistory(agentId) {
  const row = await KadeAgentBody.findOne({ agentId: String(agentId) }, { history: 1 }).lean();
  return row && Array.isArray(row.history) ? row.history : [];
}

module.exports = {
  KadeAgentBody,
  HISTORY_LIMIT,
  getAgentBody,
  getAgentBodies,
  saveAgentBody,
  deleteAgentBody,
  getAgentBodyHistory,
};
