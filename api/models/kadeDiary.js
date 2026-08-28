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
    /** MEMORY QUALITY PACK (Aug 9 2026): how much this entry matters. 1 = ordinary
     * note, 2 = notable day, 3 = big one (loss, family news, milestone, health
     * scare). Set by the keeper at write time; big things outrank product notes
     * in retrieval STRUCTURALLY (searchDiary weights by it), not by luck. */
    salience: { type: Number, default: 1, min: 1, max: 3 },
    /** DIARY VOICE REPAIR (Aug 15 2026, Part 70): the one-time retrofit pass.
     * voiceRepairedAt set = this entry was reviewed (rewritten or vetted);
     * preRepairText holds the ORIGINAL wording verbatim when it was rewritten
     * — never silent loss, same law as the card ledger. */
    preRepairText: { type: String, default: null },
    voiceRepairedAt: { type: Date, default: null },
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

/* ⭐ AUG 28 2026 — THE STRIP BECOMES A FUNCTION, BECAUSE THERE WERE TWO DOORS.
 *
 * Aug 26 put this regex "at the write door" — logDiaryEntry — after three
 * prompts saying "no dates inside the text" failed to hold. TODAY THE VOICE
 * REPAIR REINTRODUCED A STAMP THROUGH ITS OWN DOOR: diaryVoiceRepair writes
 * via updateOne, never through logDiaryEntry, and its rewrite model added
 * "[2026-08-20] Got curious about Don Wildman…" back to an entry the Aug-26
 * cleanup had verified clean. One regex at the door is only a guarantee if
 * every machine door is the same door. Both machine writers now call THIS.
 * editDiaryEntry stays un-second-guessed — a human typing is not a machine.
 * KADE_DIARY_DATE_STRIP=0 disables, both doors at once. */
function stripLeadingDateStamp(raw) {
  let cleanText = String(raw == null ? '' : raw).trim();
  if (process.env.KADE_DIARY_DATE_STRIP === '0') {
    return cleanText;
  }
  const beforeStrip = cleanText;
  cleanText = cleanText
    .replace(/^\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '')
    .replace(
      /^\s*(?:On|Back on)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\s*[,:\u2014-]?\s*/i,
      '',
    )
    .replace(/^\s*\d{4}-\d{2}-\d{2}\s*[,:\u2014-]\s*/, '')
    .trim();
  if (!cleanText) {
    return beforeStrip; /* never let the strip eat a whole entry */
  }
  if (cleanText !== beforeStrip) {
    cleanText = cleanText.charAt(0).toUpperCase() + cleanText.slice(1);
  }
  return cleanText;
}

/** The model name entries are being written with right now (drives the match guard). */
function currentEmbedModel() {
  const lane = embedLane();
  return lane ? lane.model : null;
}

/* ⭐⭐⭐ AUG 28 2026 — THE EMBEDDING LANE CAN DIE SILENTLY, AND IT DID.
 *
 * Her Aug-28 report was "she had no idea I went to a Shinedown concert." The
 * card said `Saw Shinedown on July 28, 2026` the whole time. So did three
 * logbook entries. Nothing was missing and nothing was mis-written.
 *
 * WHAT WAS ACTUALLY HAPPENING: every query embedding on the platform was
 * failing with a 429 — the Gemini prepay credits ran dry — and this function
 * returns null on failure by design. `getRecallTailBlock` reads
 *
 *     const qv = await embedText(text);
 *     const cardHits = qv ? await searchCardVectors(...) : [];
 *
 * so a null query vector means card recall is skipped ENTIRELY and the
 * logbook falls back to its non-vector path, which returns the same handful
 * of recent entries no matter what was asked. The recall audit showed it
 * plainly once somebody looked: `cards=[]` and the identical four logbook
 * dates on EVERY turn, including one that asked "what was the last concert I
 * went to" and one that asked for her cats' names.
 *
 * ⚠️ AND THE LOG LINE THAT SHOULD HAVE CAUGHT IT PRINTED NOTHING. It logged
 * `e.message`, and an axios HTTP error carries the provider's explanation in
 * `e.response.data`, not in `message` — so the warning read
 * "[kadeDiary] embedding call failed (entry still usable):" with an empty
 * space where the reason belonged, dozens of times a day, for days. A
 * diagnostic that prints nothing is worse than no diagnostic: it looks like
 * it is doing its job. Same family as the Aug-26 stale comment and the
 * lying mining gauge.
 *
 * TWO CHANGES: say the actual status and provider message, and COUNT, so
 * memory-health can state the verdict instead of leaving it in a log nobody
 * greps. Fail-soft stays — a dead embed lane must never take a turn down. */
const embedHealth = { ok: 0, failed: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
function readEmbedHealth() {
  const lane = embedLane();
  return {
    ...embedHealth,
    provider: lane ? lane.provider : null,
    model: lane ? lane.model : null,
    configured: Boolean(lane),
  };
}
/** The provider's own words, wherever the HTTP client happened to put them. */
function embedErrorText(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const providerMsg =
    (data && data.error && data.error.message) ||
    (typeof data === 'string' ? data.slice(0, 300) : null) ||
    e?.message ||
    'no detail from the provider';
  return status ? `HTTP ${status}: ${providerMsg}` : String(providerMsg);
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
      if (Array.isArray(vec) && vec.length > 0) {
        embedHealth.ok += 1;
        embedHealth.lastOkAt = new Date().toISOString();
        return vec;
      }
      embedHealth.failed += 1;
      embedHealth.lastError = 'the provider answered 200 with no vector in it';
      embedHealth.lastErrorAt = new Date().toISOString();
      return null;
    }
    const resp = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: lane.model, input: String(text).slice(0, 4000) },
      { headers: { Authorization: `Bearer ${lane.key}` }, timeout: EMBED_TIMEOUT_MS },
    );
    const vec = resp.data?.data?.[0]?.embedding;
    if (Array.isArray(vec) && vec.length > 0) {
      embedHealth.ok += 1;
      embedHealth.lastOkAt = new Date().toISOString();
      return vec;
    }
    embedHealth.failed += 1;
    embedHealth.lastError = 'the provider answered 200 with no vector in it';
    embedHealth.lastErrorAt = new Date().toISOString();
    return null;
  } catch (e) {
    const detail = embedErrorText(e);
    embedHealth.failed += 1;
    embedHealth.lastError = detail;
    embedHealth.lastErrorAt = new Date().toISOString();
    logger.warn(
      `[kadeDiary] embedding call FAILED -- semantic recall is blind for this turn (${lane.provider}/${lane.model}): ${detail}`,
    );
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
async function logDiaryEntry({ userId, agentId = null, text, scope = 'agent', source = 'keeper', entryDate = null, salience = 1 }) {
  if (!diaryEnabled()) {
    return { ok: false, error: 'diary disabled' };
  }
  if (!userId || !text || !String(text).trim()) {
    return { ok: false, error: 'missing userId or text' };
  }
  /* ── DATE-PREFIX STRIP (Aug 26 2026) ──────────────────────────────────────
   * Every entry already carries its day in `entryDate`, and the reader shows
   * it. A date repeated inside the text is heard TWICE by a screen reader,
   * which is the whole audience.
   *
   * Found the hard way: the Aug-26 backfill wrote 44 entries opening
   * "[2026-08-24] User had..." or "On August 25, we talked about...". The
   * writer's own rule already says "No dates inside the text — the entry is
   * dated automatically", and both the miner and the voice-repair pass walked
   * straight past it. A rule stated once in a prompt is a hope; a strip at the
   * write door is a guarantee.
   *
   * Only a LEADING machine-looking stamp is removed. A date the person
   * actually said mid-sentence ("she's had that limp since 2018") is content
   * and is never touched. This is the MACHINE write path only — editDiaryEntry
   * below is a human typing and is not second-guessed.
   * KADE_DIARY_DATE_STRIP=0. */
  let cleanText = stripLeadingDateStamp(String(text).trim().slice(0, 2000));
  /* Meta-guard (Aug 7 2026, caught twice in live tests): the keeper kept
   * logging the ACT of being asked to search the diary — once even writing
   * "not a genuine moment to record" while recording it. Narrow pattern on
   * the observed failure shape only; a rare false positive just means one
   * borderline entry politely refused. Keeper-sourced writes only — a human
   * typing on the Diary page is never second-guessed.
   *
   * ⚠️ AUG 26 2026 — WIDENED, BECAUSE THE CONSOLIDATION PASS WAS WALKING
   * STRAIGHT THROUGH IT. Real entries found in her logbook: "Checked through
   * shared memory at 4 AM — everything's clean, no merges or repairs needed"
   * and "Did a memory housekeeping pass — nothing needed changing." Both name
   * the mechanism, which is the whole thing this guard is for, and both got in
   * because the first clause demanded one of asked/requested/ran/wants and
   * neither sentence contains any of them. The pass describes itself in the
   * PAST tense — checked, swept, passed — so those are in the net now, along
   * with housekeeping and consolidat*. The logbook is her life, not the
   * machine's chores. */
  if (
    (source === 'keeper' || source === 'mined') &&
    /\basked|\brequested|\bran\b|\bwants? (?:me|a)\b|\bchecked\b|\bswept?\b|\bpass(?:ed)?\b|\bhousekeeping\b|\bconsolidat/i.test(cleanText) &&
    /\b(?:diary|logbook|memory|memories|notes?)\b/i.test(cleanText) &&
    /\b(?:search|check|look(?:ed)?\s?up|read back|record|housekeeping|consolidat|merge|repair|sweep|consolidation pass|nothing needed changing)/i.test(cleanText)
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

  /* ── RE-MINE GUARD (Aug 26 2026) ──────────────────────────────────────────
   * There was no dedup here at all: logDiaryEntry only ever created. That was
   * safe while every conversation was mined exactly once, and it stops being
   * safe the moment a re-mine exists — which it now does, because the logbook
   * went silent Aug 20-26 and those days have to be walked again.
   *
   * Cheapest correct check: entries are already scoped by day, so only the
   * SAME (user, bucket, date) can collide. Exact text is caught by string
   * compare; a reworded second pass at the same moment is caught with the
   * embedding THIS CALL ALREADY COMPUTED, so the guard costs one small indexed
   * find and no extra model call.
   *
   * ⚠️ Deliberately NOT global: the same sentence on two different days is two
   * real days, and refusing that would eat a genuine repeat. Kill switch:
   * KADE_DIARY_DEDUP=0. */
  if (process.env.KADE_DIARY_DEDUP !== '0') {
    try {
      const sameDay = await KadeDiaryEntry.find({
        userId: String(userId),
        agentId: effectiveAgentId,
        entryDate: effectiveDate,
      })
        .select('text embedding')
        .limit(40)
        .lean();
      const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const mine = norm(cleanText);
      const threshold = (() => {
        const v = parseFloat(process.env.KADE_DIARY_DEDUP_SIM);
        return Number.isFinite(v) && v > 0.5 && v <= 1 ? v : 0.93;
      })();
      for (const row of sameDay) {
        if (norm(row.text) === mine) {
          return { ok: false, error: 'duplicate: an identical entry already exists for that day', duplicate: true };
        }
        if (embedding && Array.isArray(row.embedding) && row.embedding.length) {
          if (cosine(embedding, row.embedding) >= threshold) {
            return { ok: false, error: 'duplicate: a near-identical entry already exists for that day', duplicate: true };
          }
        }
      }
    } catch (e) {
      /* A dedup hiccup must never block a real entry — the gap this guard
       * exists for is worse than an occasional double. */
      logger.warn('[kadeDiary] dedup check skipped:', e.message);
    }
  }

  try {
    const cleanSalience = Math.min(Math.max(parseInt(salience, 10) || 1, 1), 3);
    await KadeDiaryEntry.create({
      userId: String(userId),
      agentId: effectiveAgentId,
      text: cleanText,
      entryDate: effectiveDate,
      embedding,
      embedModel: embedding ? currentEmbedModel() : null,
      source,
      salience: cleanSalience,
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
  /** Precomputed embedding of `query` (Part 69 card-recall shares ONE embed per
   * turn across cards + diary). When provided, no embed call happens here. */
  queryVector = null,
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
    const qVec =
      Array.isArray(queryVector) && queryVector.length > 0
        ? queryVector
        : await embedText(String(query));
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
      .select('text entryDate agentId embedding embedModel salience')
      .lean();
    const scored = [];
    const activeModel = currentEmbedModel();
    /* TIME-AWARE RECALL (Aug 9 2026, Zep's lesson from the northstar pass):
     * relevance gates (raw cosine >= minScore), but the RANKING blends in
     * recency and salience. A fresh entry gets up to +0.05; the boost halves
     * every ~42 days and is gone by a season — old entries still win when
     * they're plainly more relevant. Salience multiplies AFTER the gate:
     * ordinary 1.0x, notable 1.12x, big 1.24x — a salience-3 day (a loss, a
     * milestone) structurally outranks a same-relevance product note. */
    const todayMs = Date.now();
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
        let ageDays = 0;
        const t = Date.parse(`${r.entryDate}T12:00:00-06:00`);
        if (Number.isFinite(t)) {
          ageDays = Math.max(0, (todayMs - t) / 86400000);
        }
        const salienceMult = 1 + 0.12 * (Math.min(Math.max(r.salience || 1, 1), 3) - 1);
        const recencyBonus = 0.05 * Math.exp(-ageDays / 60);
        const ranked = score * salienceMult + recencyBonus;
        scored.push({
          date: r.entryDate,
          text: r.text,
          agentScoped: Boolean(r.agentId),
          score,
          ranked,
          salience: Math.min(Math.max(r.salience || 1, 1), 3),
        });
      }
    }
    scored.sort((a, b) => b.ranked - a.ranked);
    return scored.slice(0, cap);
  } catch (e) {
    logger.warn('[kadeDiary] search failed (returning empty, never breaking a turn):', e.message);
    return [];
  }
}

/**
 * Edit one entry's text (and optionally salience) in place — id, date, scope,
 * and source all survive; the embedding is recomputed so search keeps working
 * on the new words (fail-soft: a failed re-embed leaves the entry searchable
 * by date, same rule as writes). `filter` must already carry the ownership
 * constraint (userId at minimum) — routes decide who may touch what.
 */
async function editDiaryEntry(filter, { text = null, salience = null } = {}) {
  const update = {};
  if (text !== null) {
    const cleanText = String(text).trim().slice(0, 2000);
    if (!cleanText) {
      return { ok: false, error: 'empty text' };
    }
    update.text = cleanText;
    const embedding = await embedText(cleanText);
    update.embedding = embedding;
    update.embedModel = embedding ? currentEmbedModel() : null;
  }
  if (salience !== null) {
    update.salience = Math.min(Math.max(parseInt(salience, 10) || 1, 1), 3);
  }
  if (Object.keys(update).length === 0) {
    return { ok: false, error: 'nothing to change' };
  }
  try {
    const row = await KadeDiaryEntry.findOneAndUpdate(filter, { $set: update }, { new: true })
      .select('-embedding')
      .lean();
    if (!row) {
      return { ok: false, error: 'not found' };
    }
    return { ok: true, entry: row };
  } catch (e) {
    logger.error('[kadeDiary] edit failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  KadeDiaryEntry,
  diaryEnabled,
  centralDateString,
  embedText,
  currentEmbedModel,
  readEmbedHealth,
  stripLeadingDateStamp,
  logDiaryEntry,
  editDiaryEntry,
  searchDiary,
  countEntries,
};
