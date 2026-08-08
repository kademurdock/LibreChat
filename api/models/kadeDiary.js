/**
 * KADE LIVING DIARY — Tier 2 of the tiered memory design (Aug 7 2026, her four
 * answers locked: hot core stays 8K, retrieval = automatic AND explicit tool,
 * ALL agents share the capability with card-style scoping, diary stays passive).
 * Design doc: MEMORY_TIERED_DIARY_DESIGN_2026-08-07.md in her folder.
 *
 * WHAT THIS IS: the unbounded, retrieval-only archive. Day-to-day episodic
 * entries land HERE (dated, embedded, searchable) instead of the 8K hot core
 * that rides every turn. Nothing in this collection is ever injected wholesale;
 * entries surface only via semantic lookup (client.js tail) or the
 * kade_memory_search tool. That is the whole point: the diary can grow to
 * thousands of entries at zero per-turn token cost.
 *
 * WHY MONGO AND NOT PG_VECTOR (deliberate deviation from the design doc's
 * sketch): (1) the nightly 09:00 UTC Backblaze job backs up MONGO — diary
 * entries here ride the proven backup path for free, pgvector rows would not;
 * (2) no cross-service dependency — a RAG-service hiccup can never break a
 * chat turn; (3) at family scale (even 10K entries) in-process cosine over a
 * scoped slice is sub-10ms — a vector DB buys nothing yet. If the diary ever
 * outgrows this (~50K+ entries), the search function below is the single seam
 * to swap.
 *
 * SCOPING mirrors memory cards exactly (the July 18 privacy standard):
 * agentId = null means shared; a string means only that character's diary.
 * Default scope is AGENT — you told ONE character about your day.
 *
 * EMBEDDINGS: Google gemini-embedding-001 at 1536 dims via
 * KADE_EMBED_GEMINI_KEY (the AI Studio key already powering the Live video
 * lane; live-tested Aug 7 2026 — $0.15/M tokens, an entry costs ~a hundredth
 * of a cent). Discovered same day: the RAG service's OPENAI_API_KEY is DEAD
 * (401 on a live embeddings call), so the OpenAI lane is only a fallback if
 * KADE_EMBED_OPENAI_KEY is ever set with a fresh key. Query and entry vectors
 * only compare when embedModel matches — a future model swap needs a backfill
 * pass, never silent cross-model cosine. Fail-soft everywhere: an entry that
 * can't embed still SAVES (embedding null, searchable after backfill); a
 * search that can't embed falls back to date/recency. The diary must never
 * lose her day over a flaky embedding call.
 *
 * KILL SWITCH: KADE_DIARY=0 disables writes and retrieval (both surfaces).
 *
 * Plain Mongoose on purpose — no data-schemas TS build (kadeMemorySummary /
 * kadeNudge precedent).
 */
const axios = require('axios');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const kadeDiarySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    /** null = shared (every character may recall it); string = that character only. */
    agentId: { type: String, default: null },
    /** The entry itself — one or two plain sentences, the keeper writes like a person. */
    text: { type: String, required: true, maxlength: 2000 },
    /** YYYY-MM-DD in US Central — the diary is a calendar, so this is the spine. */
    entryDate: { type: String, required: true, index: true },
    /** 1536-dim vector from whichever lane embedModel names, or null if embedding failed at write. */
    embedding: { type: [Number], default: null },
    embedModel: { type: String, default: null },
    /** 'keeper' (memory agent) | 'manual' (future diary surface) | 'backfill' */
    source: { type: String, default: 'keeper' },
  },
  { timestamps: true },
);
kadeDiarySchema.index({ userId: 1, agentId: 1, entryDate: -1 });

const KadeDiaryEntry =
  mongoose.models.KadeDiaryEntry ||
  mongoose.model('KadeDiaryEntry', kadeDiarySchema, 'kadediaryentries');

function diaryEnabled() {
  return process.env.KADE_DIARY !== '0';
}

/** Central-time YYYY-MM-DD (whole family is Missouri; DST-safe). */
function centralDateString(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // en-CA gives YYYY-MM-DD directly
}

const EMBED_TIMEOUT_MS = 8000;
const EMBED_DIMS = 1536;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

/** Which embedding lane is live right now → { provider, model, key } or null. */
function embedLane() {
  if (process.env.KADE_EMBED_GEMINI_KEY) {
    return { provider: 'gemini', model: GEMINI_EMBED_MODEL, key: process.env.KADE_EMBED_GEMINI_KEY };
  }
  if (process.env.KADE_EMBED_OPENAI_KEY) {
    return { provider: 'openai', model: OPENAI_EMBED_MODEL, key: process.env.KADE_EMBED_OPENAI_KEY };
  }
  return null;
}

/** The model name entries are being written with right now (drives the match guard). */
function currentEmbedModel() {
  const lane = embedLane();
  return lane ? lane.model : null;
}

/** Embed one string. Returns float array or null (never throws). */
async function embedText(text) {
  const lane = embedLane();
  if (!lane || !text) {
    return null;
  }
  try {
    if (lane.provider === 'gemini') {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${lane.model}:embedContent?key=${lane.key}`,
        {
          model: `models/${lane.model}`,
          content: { parts: [{ text: String(text).slice(0, 4000) }] },
          outputDimensionality: EMBED_DIMS,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: EMBED_TIMEOUT_MS },
      );
      const vec = resp.data?.embedding?.values;
      return Array.isArray(vec) && vec.length > 0 ? vec : null;
    }
    const resp = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: lane.model, input: String(text).slice(0, 4000) },
      { headers: { Authorization: `Bearer ${lane.key}` }, timeout: EMBED_TIMEOUT_MS },
    );
    const vec = resp.data?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length > 0 ? vec : null;
  } catch (e) {
    logger.warn('[kadeDiary] embedding call failed (entry still usable):', e.message);
    return null;
  }
}

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
 * Write one diary entry. scope 'shared' → agentId null; anything else → the
 * given agentId (privacy default). Saves even when embedding fails.
 */
async function logDiaryEntry({ userId, agentId = null, text, scope = 'agent', source = 'keeper', entryDate = null }) {
  if (!diaryEnabled()) {
    return { ok: false, error: 'diary disabled' };
  }
  if (!userId || !text || !String(text).trim()) {
    return { ok: false, error: 'missing userId or text' };
  }
  const cleanText = String(text).trim().slice(0, 2000);
  /* Meta-guard (Aug 7 2026, caught twice in live tests): the keeper kept
   * logging the ACT of being asked to search the diary — once even writing
   * "not a genuine moment to record" while recording it. Narrow pattern on
   * the observed failure shape only; a rare false positive just means one
   * borderline entry politely refused. Keeper-sourced writes only — a human
   * typing on the Diary page is never second-guessed. */
  if (
    source === 'keeper' &&
    /\basked|\brequested|\bran\b|\bwants? (?:me|a)\b/i.test(cleanText) &&
    /\b(?:diary|logbook|memory|memories|notes?)\b/i.test(cleanText) &&
    /\b(?:search|check|look(?:ed)?\s?up|read back|record)/i.test(cleanText)
  ) {
    return {
      ok: false,
      error:
        'That describes the diary mechanism itself, not a life moment — log nothing for this turn.',
    };
  }
  const effectiveAgentId = scope === 'shared' ? null : agentId || null;
  /* entryDate override is for BACKFILL lanes only (supervised card sort,
   * history mining) — live keeper writes always stamp today. */
  const effectiveDate =
    entryDate && /^\d{4}-\d{2}-\d{2}$/.test(String(entryDate)) ? String(entryDate) : centralDateString();
  const embedding = await embedText(cleanText);
  try {
    await KadeDiaryEntry.create({
      userId: String(userId),
      agentId: effectiveAgentId,
      text: cleanText,
      entryDate: effectiveDate,
      embedding,
      embedModel: embedding ? currentEmbedModel() : null,
      source,
    });
    return { ok: true, date: effectiveDate };
  } catch (e) {
    logger.error('[kadeDiary] failed to save entry:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Cheap indexed count so per-turn retrieval can skip the embed round-trip entirely. */
async function countEntries(userId, agentId = null) {
  try {
    return await KadeDiaryEntry.countDocuments({
      userId: String(userId),
      $or: [{ agentId: null }, ...(agentId ? [{ agentId: String(agentId) }] : [])],
    });
  } catch (_e) {
    return 0;
  }
}

/**
 * Search the diary. Scope is ALWAYS shared + (optionally) one agent's own —
 * an agent can never see another agent's entries, same as cards.
 *
 * query        → semantic (embeds the query, cosine-ranks)
 * dateFrom/To  → YYYY-MM-DD range filter (Central), works with or without query
 * No query     → newest-first chronological (a diary flip-through)
 *
 * Returns [{ date, text, agentScoped, score }] — capped, small, prompt-ready.
 */
async function searchDiary({
  userId,
  agentId = null,
  query = null,
  dateFrom = null,
  dateTo = null,
  limit = 5,
  minScore = 0.18,
}) {
  if (!diaryEnabled() || !userId) {
    return [];
  }
  const cap = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 12);
  const filter = {
    userId: String(userId),
    $or: [{ agentId: null }, ...(agentId ? [{ agentId: String(agentId) }] : [])],
  };
  if (dateFrom || dateTo) {
    filter.entryDate = {};
    if (dateFrom) {
      filter.entryDate.$gte = String(dateFrom);
    }
    if (dateTo) {
      filter.entryDate.$lte = String(dateTo);
    }
  }
  try {
    if (!query) {
      const rows = await KadeDiaryEntry.find(filter)
        .sort({ entryDate: -1, createdAt: -1 })
        .limit(cap)
        .lean();
      return rows.map((r) => ({
        date: r.entryDate,
        text: r.text,
        agentScoped: Boolean(r.agentId),
        score: null,
      }));
    }
    const qVec = await embedText(String(query));
    if (!qVec) {
      /* embedding down → degrade to recency within the same filter */
      const rows = await KadeDiaryEntry.find(filter)
        .sort({ entryDate: -1, createdAt: -1 })
        .limit(cap)
        .lean();
      return rows.map((r) => ({
        date: r.entryDate,
        text: r.text,
        agentScoped: Boolean(r.agentId),
        score: null,
      }));
    }
    /* Family scale: load the scoped slice and rank in-process (see header note). */
    const rows = await KadeDiaryEntry.find(filter)
      .sort({ createdAt: -1 })
      .limit(3000)
      .select('text entryDate agentId embedding embedModel')
      .lean();
    const scored = [];
    const activeModel = currentEmbedModel();
    for (const r of rows) {
      if (!Array.isArray(r.embedding) || r.embedding.length === 0) {
        continue;
      }
      /* Cross-model cosine is noise, not recall — skip until a backfill re-embeds. */
      if (r.embedModel && activeModel && r.embedModel !== activeModel) {
        continue;
      }
      const score = cosine(qVec, r.embedding);
      if (score >= minScore) {
        scored.push({
          date: r.entryDate,
          text: r.text,
          agentScoped: Boolean(r.agentId),
          score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, cap);
  } catch (e) {
    logger.warn('[kadeDiary] search failed (returning empty, never breaking a turn):', e.message);
    return [];
  }
}

module.exports = {
  KadeDiaryEntry,
  diaryEnabled,
  centralDateString,
  embedText,
  currentEmbedModel,
  logDiaryEntry,
  searchDiary,
  countEntries,
};
