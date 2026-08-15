/**
 * KADE CARD RECALL — vector store for MEMORY CARDS (Aug 15 2026, Part 69).
 * Design: SESSION_PLAN_2026-08-15_PART69_MEMORY.md (her words: "I'm most
 * excited about the rag thing... I need a great memory system"; her relevance
 * rule: "she like the color blah, isn't conversation relevant all the time").
 *
 * WHAT THIS IS: the diary already retrieves by meaning (kadeDiary.js, Aug 7);
 * this gives memory CARDS the same power. Each active card gets one embedding
 * row here, keyed by (userId, agentId, key) with a hash of the value — when a
 * card's text changes, the next sync re-embeds it; when a card dies, its
 * vector dies with it. Nothing here is authoritative: the card itself (in
 * memoryentries) is truth, this collection is just the searchable shadow.
 * Retrieval joins BACK to the live entries so a stale vector can never put
 * stale words in a character's mouth — worst case it misses one turn until
 * the sync catches up.
 *
 * SCOPING mirrors cards exactly (July 18 privacy standard): shared (agentId
 * null) + the active character's own bucket only. Another character's cards
 * are structurally unreachable.
 *
 * EMBEDDINGS: same lane as the diary (gemini-embedding-001 @1536 via
 * KADE_EMBED_GEMINI_KEY) — one corpus, one model, one bill (~pennies). The
 * embedModel match guard from the diary applies here too: query vectors only
 * compare against vectors written by the same model.
 *
 * Plain Mongoose on purpose (kadeDiary / kadeMemorySummary precedent).
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { embedText, currentEmbedModel } = require('~/models/kadeDiary');

const kadeCardVectorSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    /** null = shared bucket; string = that character's own bucket. */
    agentId: { type: String, default: null },
    /** The card's key in memoryentries — the join column. */
    key: { type: String, required: true },
    /** sha1 of the card value at embed time — change detection. */
    valueHash: { type: String, required: true },
    embedding: { type: [Number], default: null },
    embedModel: { type: String, default: null },
  },
  { timestamps: true },
);
kadeCardVectorSchema.index({ userId: 1, agentId: 1, key: 1 }, { unique: true });

const KadeCardVector =
  mongoose.models.KadeCardVector ||
  mongoose.model('KadeCardVector', kadeCardVectorSchema, 'kadecardvectors');

const hashValue = (value) =>
  crypto.createHash('sha1').update(String(value), 'utf8').digest('hex');

/* Same cosine as the diary — tiny, kept local so the two models stay
 * independently readable. */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Bring one bucket's vectors in line with its live cards. Embeds at most
 * `maxEmbeds` missing/stale cards per call (a per-turn call must never turn
 * into a 100-embed burst — the admin rag-sync lane passes a big cap instead),
 * and deletes vectors whose card is gone. Never throws.
 *
 * @param {string} userId
 * @param {string|null} agentId  exact bucket (null = shared)
 * @param {Array<{key:string,value:string}>} entries  the bucket's LIVE active cards
 * @param {{maxEmbeds?: number}} [opts]
 * @returns {Promise<{embedded:number,deleted:number,pending:number}>}
 */
async function syncBucketVectors(userId, agentId, entries, opts = {}) {
  const maxEmbeds = Number.isFinite(opts.maxEmbeds) ? opts.maxEmbeds : 6;
  const out = { embedded: 0, deleted: 0, pending: 0 };
  try {
    const uid = String(userId);
    const aid = agentId == null ? null : String(agentId);
    const live = new Map();
    for (const e of entries || []) {
      if (e && e.key) {
        live.set(String(e.key), String(e.value ?? ''));
      }
    }
    const rows = await KadeCardVector.find({ userId: uid, agentId: aid }).lean();
    const byKey = new Map(rows.map((r) => [r.key, r]));

    /* Vectors whose card no longer exists -> gone. */
    const dead = rows.filter((r) => !live.has(r.key)).map((r) => r.key);
    if (dead.length > 0) {
      await KadeCardVector.deleteMany({ userId: uid, agentId: aid, key: { $in: dead } });
      out.deleted = dead.length;
    }

    const model = currentEmbedModel();
    if (!model) {
      return out; /* no embedding lane configured — cards still ride pinned/head paths */
    }

    /* Missing or stale (value changed, model changed, or embed previously failed). */
    const work = [];
    for (const [key, value] of live) {
      const h = hashValue(value);
      const row = byKey.get(key);
      if (!row || row.valueHash !== h || row.embedModel !== model || !row.embedding) {
        work.push({ key, value, h });
      }
    }
    out.pending = Math.max(0, work.length - maxEmbeds);
    for (const w of work.slice(0, maxEmbeds)) {
      /* Embed key + value together — the key names the topic (dad_health) and
       * often carries the retrieval signal the prose omits. */
      const vec = await embedText(w.key.replace(/_/g, ' ') + ': ' + w.value);
      await KadeCardVector.updateOne(
        { userId: uid, agentId: aid, key: w.key },
        {
          $set: {
            valueHash: w.h,
            embedding: vec,
            embedModel: vec ? model : null,
          },
        },
        { upsert: true },
      );
      if (vec) {
        out.embedded += 1;
      }
    }
    return out;
  } catch (e) {
    logger.warn('[kadeCardVector] sync failed (non-fatal):', e.message);
    return out;
  }
}

/**
 * Rank candidate cards against a precomputed query vector. Pure in-process
 * cosine — no network. Returns [{key, agentId, score}] best-first, thresholded.
 *
 * @param {string} userId
 * @param {string|null|undefined} agentId  active character (its bucket + shared are searched)
 * @param {number[]} queryVector
 * @param {{limit?:number,minScore?:number,keys?:Set<string>}} [opts]
 *   opts.keys — when provided, only these (retrievable) keys compete; pinned
 *   cards already ride the head, so they never need to win a tail slot.
 *   Key format: `${agentId ?? ''}::${key}`.
 */
async function searchCardVectors(userId, agentId, queryVector, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 12);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.3;
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return [];
  }
  try {
    const model = currentEmbedModel();
    const filter = {
      userId: String(userId),
      $or: [{ agentId: null }, ...(agentId ? [{ agentId: String(agentId) }] : [])],
      embedding: { $ne: null },
      embedModel: model,
    };
    const rows = await KadeCardVector.find(filter).select('key agentId embedding').lean();
    const scored = [];
    for (const r of rows) {
      if (opts.keys && !opts.keys.has((r.agentId ?? '') + '::' + r.key)) {
        continue;
      }
      const score = cosine(queryVector, r.embedding);
      if (score >= minScore) {
        scored.push({ key: r.key, agentId: r.agentId ?? null, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch (e) {
    logger.warn('[kadeCardVector] search failed (non-fatal):', e.message);
    return [];
  }
}

module.exports = {
  KadeCardVector,
  hashValue,
  syncBucketVectors,
  searchCardVectors,
};
