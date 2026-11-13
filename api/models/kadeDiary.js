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
 * EMBEDDINGS: KADE_EMBED_MODEL selects the compatible provider. Production
 * uses Qwen3-Embedding-8B at 1536 dimensions, with the original Google index
 * retained for rollback. The model, dimensions and text recipe must all
 * match before vectors compare. Staged vectors also require a current text
 * hash. The old Google/OpenAI lanes are used only when no explicit model is
 * selected. Fail-soft everywhere: an entry that
 * can't embed still SAVES (embedding null, searchable after backfill); a
 * search that can't embed falls back to date/recency. The diary must never
 * lose her day over a flaky embedding call.
 *
 * KILL SWITCH: KADE_DIARY=0 disables writes and retrieval (both surfaces).
 *
 * Plain Mongoose on purpose — no data-schemas TS build (kadeMemorySummary /
 * kadeNudge precedent).
 */
const mongoose = require('mongoose');
const {
  diaryWriteOrigins,
  diaryWriteOrigin,
  memoryEmbeddingLane,
  memoryEmbeddingPurpose,
  memoryEmbeddingTimeoutMs,
  requestMemoryEmbedding,
  indexedEmbedding,
  embeddingTextHash,
} = require('@librechat/api');
const {
  logger,
  memorySourceStorage,
  memorySourceAllowed,
  excludedMemoryConversations,
} = require('@librechat/data-schemas');
/* DB-2 (platform audit, Nov 12 2026): reads the reply waits on give up after KADE_TURN_READ_MAX_MS
 * (3000 ms; 0 = no limit, the old behaviour). The same rule as api/server/utils/kadeTurnRead.js,
 * written out here because several tests load this file in a bare vm with no module paths. */
function turnReadOptions() {
  const raw = process.env.KADE_TURN_READ_MAX_MS;
  const n = raw == null || String(raw).trim() === '' ? 3000 : Number(raw);
  return Number.isFinite(n) && n > 0 ? { maxTimeMS: Math.floor(n) } : {};
}

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
    embeddingNext: { type: [Number], default: null },
    embedNextModel: { type: String, default: null },
    embedNextHash: { type: String, default: null },
    /** 'keeper' (memory agent) | 'manual' (future diary surface) | 'backfill' */
    source: { type: String, default: 'keeper' },
    sourceConversationIds: { type: [String], default: [] },
    writeActivity: Object.fromEntries(
      diaryWriteOrigins.map((origin) => [origin, { createdAt: Date, amendedAt: Date }]),
    ),
    /* ⭐ ONE ENTRY PER EPISODE (Part 112, Aug 31 2026 — her call, made on the
     * read of her own Aug-31 logbook: ten entries covering three episodes,
     * Kid Tunes alone filed five times in 23 minutes. Her choice of key, put
     * to her explicitly: ONE CONVERSATION = ONE ENTRY, amended as it goes.
     * A live keeper write that lands in a conversation which already has an
     * entry TODAY extends that entry instead of stacking a sibling.
     *
     * Stated loudly, because it was decided before code was written:
     * - The key is (userId, agentId, conversationId, entryDate). An episode
     *   that crosses midnight Central is TWO dates and becomes two entries —
     *   entryDate stays the spine of the diary, exactly as designed.
     * - A topic returned to across two chats is two entries. Phone and app
     *   calls are each their own temporary conversation, so each call is its
     *   own entry. She knows; she chose this key anyway.
     * - Null for every pre-Part-112 row and for lanes that pass no
     *   conversation (mining, imports, manual page) — those behave exactly
     *   as before. */
    conversationId: { type: String, default: null, index: true },
    /* The amend trail: every pre-amend wording, verbatim, oldest first —
     * the preRepairText principle (an update must never lose the earlier
     * wording) applied to a lane that can now update. */
    priorTexts: { type: [String], default: [] },
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

/** Which embedding lane is live right now → { provider, model, key } or null. */
function embedLane() {
  return memoryEmbeddingLane();
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
  return lane ? lane.identity : null;
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
const embedHealth = {
  ok: 0,
  failed: 0,
  lastError: null,
  lastErrorAt: null,
  lastOkAt: null,
  /* Nov 10 2026: who failed. One total could not tell a blind memory query from a tool query
   * nobody was waiting for any more, or from a background write. */
  byPurpose: {
    query: { ok: 0, failed: 0 },
    tools: { ok: 0, failed: 0 },
    document: { ok: 0, failed: 0 },
  },
  secondTries: 0 /* memory queries that needed their second request */,
  secondTryWon: 0 /* ...and were answered by it */,
  docRetries: 0 /* Nov 13 2026: document embeds that timed out and were asked once more */,
  docRetryWon: 0 /* ...and were answered by that second request */,
};
/* Nov 10 2026: the live log showed the memory query timing out at exactly 3000 ms on more than half
 * of the turns (33 first-try timeouts and 61 failures in 56 turns, Nov 8 to 10) while the tool query,
 * sent to the same host a moment earlier, almost never did. That pattern fits this server's own event
 * loop being held (the timer fires before the answer that already arrived is read) at least as well
 * as it fits a slow host. So a failed embed now says how long the loop was held: a big number
 * convicts this server, a small one the host.
 *
 * Nov 10 review: the first version read one shared histogram and cleared it only when an embed
 * failed, so a reading covered everything since the previous failure (or since the server
 * started), and one unrelated stall hours earlier could convict the server. Each call now keeps
 * its own watch: a 20 ms ticker that lives only while that call is waiting and remembers the
 * latest tick. The number is the longest hold DURING THIS CALL and nothing else. */
const LOOP_TICK_MS = 20;
function watchLoop() {
  let last = Date.now();
  let worst = 0;
  let ticker = null;
  const tick = () => {
    const now = Date.now();
    worst = Math.max(worst, now - last - LOOP_TICK_MS);
    last = now;
  };
  try {
    ticker = setInterval(tick, LOOP_TICK_MS);
    if (ticker && typeof ticker.unref === 'function') ticker.unref();
  } catch (_) {
    ticker = null;
  }
  /** Stops the watch; returns the longest hold in ms (null when the watch could not run). */
  return () => {
    if (!ticker) return null;
    tick(); /* a hold that ended just now has not reached the ticker yet */
    clearInterval(ticker);
    ticker = null;
    return Math.max(0, Math.round(worst));
  };
}
function noteEmbed(purpose, ok) {
  const row = embedHealth.byPurpose[purpose] || embedHealth.byPurpose.document;
  row[ok ? 'ok' : 'failed'] += 1;
}
function readEmbedHealth() {
  const lane = embedLane();
  return {
    ...embedHealth,
    byPurpose: JSON.parse(JSON.stringify(embedHealth.byPurpose)),
    provider: lane ? lane.provider : null,
    model: lane ? lane.identity : null,
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

/** A timeout, as axios reports one (code depends on its transitional settings). */
const embedTimedOut = (e) =>
  e?.code === 'ECONNABORTED' ||
  e?.code === 'ETIMEDOUT' ||
  /\btimeout\b/i.test(String(e?.message || ''));

/* Nov 10 2026 -- THE MEMORY QUERY'S TWO TRIES OVERLAP.
 *
 * Memory health read AMBER: 61 of 175 embedding calls failed, last error "timeout of 3000ms
 * exceeded". The Oct 16 rule was: wait 3 s, and on a timeout ask once more for another 3 s. A
 * request that would have answered at second 4 was thrown away at second 3 and a fresh one
 * started from nothing, so a slow spell failed both tries and the turn's recall went blind.
 *
 * Same budget, used better: the first request now keeps the whole window (twice the query
 * timeout, 6 s by default: what the two tries took together), and if it has not answered after
 * KADE_EMBED_HEDGE_MS (1200) a second request starts beside it. The first answer wins. A turn
 * never waits longer than before; a slow answer inside the window is no longer lost. An
 * embedding call costs about a thousandth of a cent, and at most two are ever made, as before.
 * A refusal that is not a timeout (402, 429, a bad key) still fails at once with no second try.
 * KADE_EMBED_HEDGE_MS=0 puts back the old one-after-the-other tries. */
function embedHedgeMs() {
  const set = Number(process.env.KADE_EMBED_HEDGE_MS);
  return Number.isFinite(set) && set >= 0 && set <= 30000 ? set : 1200;
}
function requestQueryEmbedding(lane, text) {
  const windowMs = memoryEmbeddingTimeoutMs('query') * 2;
  const hedgeMs = Math.min(embedHedgeMs(), windowMs - 500);
  if (!(hedgeMs > 0)) {
    return requestMemoryEmbedding(lane, text, 'query').catch((e) => {
      if (!embedTimedOut(e)) throw e;
      embedHealth.secondTries += 1;
      logger.warn(
        `[kadeDiary] query embedding timed out (${lane.provider}/${lane.model}); asking once more`,
      );
      return requestMemoryEmbedding(lane, text, 'query').then((vec) => {
        embedHealth.secondTryWon += 1;
        return vec;
      });
    });
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let open = 0;
    let secondStarted = false;
    let timer = null;
    let refusal = null;
    const win = (vec, second) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (second) embedHealth.secondTryWon += 1;
      resolve(vec);
    };
    const lose = (e) => {
      open -= 1;
      if (settled) return;
      /* A refusal (not a timeout) fails the query at once only when no other request is still
       * on its way: a first request refused before the second has started ends the query with
       * no second try, as before. But a refused or broken request must never throw away the
       * other one while it is still open (Nov 10 review: a 429 on the second request was
       * discarding a healthy first request, which the old one-after-the-other rule never did).
       * It is remembered, and reported if the other request fails too. */
      if (!embedTimedOut(e)) {
        if (open > 0) {
          refusal = refusal || e;
          return;
        }
        settled = true;
        clearTimeout(timer);
        return reject(refusal || e);
      }
      /* A timeout of the first request, when the second has not started yet, starts it now
       * (the Oct 16 behaviour). */
      if (!secondStarted) return second();
      if (open === 0) {
        settled = true;
        reject(refusal || e);
      }
    };
    const ask = (isSecond) => {
      open += 1;
      const left = Math.max(500, windowMs - (Date.now() - started));
      Promise.resolve()
        .then(() => requestMemoryEmbedding(lane, text, 'query', left))
        .then((vec) => win(vec, isSecond), lose);
    };
    function second() {
      if (settled || secondStarted) return;
      secondStarted = true;
      clearTimeout(timer);
      embedHealth.secondTries += 1;
      ask(true);
    }
    timer = setTimeout(second, hedgeMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    ask(false);
  });
}

/* Nov 13 2026 (sweep 8.2) -- A DOCUMENT EMBED GETS A SECOND, LONGER TRY.
 *
 * Since the 05:42Z boot, 7 of 36 document embeds had timed out (memory queries: 0 of 3). A
 * document embed is a write: a logbook entry, a card vector, a repair. Nothing the person is
 * waiting to hear depends on it, so it is not on the reply's clock, and an entry saved without
 * its vector cannot be found by meaning until a later repair pass reaches it. So a document embed
 * that TIMES OUT is asked once more, with a longer wait (KADE_EMBED_DOC_RETRY_TIMEOUT_MS, default
 * 12000, never shorter than the first try). A refusal (402, 429, a bad key) is still final at
 * once, and at most two requests are ever made (about a thousandth of a cent each).
 * KADE_EMBED_DOC_RETRY=0 puts back the single try. */
function docRetryOn() {
  return String(process.env.KADE_EMBED_DOC_RETRY ?? '').trim() !== '0';
}
function docRetryTimeoutMs() {
  const set = Number(process.env.KADE_EMBED_DOC_RETRY_TIMEOUT_MS);
  const wait = Number.isFinite(set) && set >= 500 && set <= 60000 ? set : 12000;
  return Math.max(wait, memoryEmbeddingTimeoutMs('document'));
}
function requestDocumentEmbedding(lane, text) {
  return requestMemoryEmbedding(lane, text, 'document').catch((e) => {
    if (!docRetryOn() || !embedTimedOut(e)) throw e;
    embedHealth.docRetries += 1;
    logger.warn(
      `[kadeDiary] document embedding timed out (${lane.provider}/${lane.model}); asking once more with a longer wait`,
    );
    return requestMemoryEmbedding(lane, text, 'document', docRetryTimeoutMs()).then((vec) => {
      embedHealth.docRetryWon += 1;
      return vec;
    });
  });
}

/* Nov 13 2026 (sweep 8.2): memory-health said nothing while one embed in five was failing (the
 * amber line only spoke above 25%). It now speaks above KADE_EMBED_WARN_RATIO (default 0.10) of
 * the calls since this process started, once at least three have failed, so one early failure
 * on a fresh process is not a warning. The old over-25% rule still speaks at any count.
 * KADE_EMBED_WARN_RATIO=0.25 is the old threshold. Returns the amber warning, or null. */
function embedWarnRatio(env = process.env) {
  const raw = env && env.KADE_EMBED_WARN_RATIO;
  const set = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(set) && set > 0 && set < 1 ? set : 0.1;
}
function embedHealthAmber(eh, env = process.env) {
  if (!eh || !(eh.failed > 0) || !(eh.ok > 0)) return null;
  const total = eh.ok + eh.failed;
  const share = eh.failed / total;
  const ratio = embedWarnRatio(env);
  if (!(share > 0.25) && !(share > ratio && eh.failed >= 3)) return null;
  const by = eh.byPurpose || {};
  const part = (name, label) =>
    by[name] && by[name].failed > 0
      ? `${label} ${by[name].failed} of ${by[name].ok + by[name].failed}`
      : '';
  const who = [
    part('query', 'memory queries'),
    part('tools', 'tool queries'),
    part('document', 'writes'),
  ]
    .filter(Boolean)
    .join(', ');
  return {
    lane: 'embedding',
    severity: 'amber',
    detail:
      `${eh.failed} of ${total} embedding calls have failed since this process started (${Math.round(share * 100)}%, ${eh.provider}/${eh.model}) — recall is intermittently blind` +
      (who ? ` (${who})` : '') +
      `. Last error: ${eh.lastError || 'unknown'}`,
  };
}

/** Embed one string. Returns float array or null (never throws).
 * Oct 16 2026: a memory query that times out is asked once more (the lane's
 * timeouts come and go); documents, backfills and tool queries fail soft at once.
 * Nov 10 2026: the query's two tries overlap (requestQueryEmbedding above).
 * Nov 13 2026: a document that times out is asked once more with a longer wait
 * (requestDocumentEmbedding above); the tools query still fails soft at once. */
async function embedText(text, { purpose = 'document' } = {}) {
  const lane = embedLane();
  if (!lane || !text) {
    return null;
  }
  const stopLoopWatch = watchLoop();
  try {
    let vec;
    if (purpose === 'query') {
      vec = await requestQueryEmbedding(lane, String(text));
    } else if (purpose === 'document') {
      vec = await requestDocumentEmbedding(lane, String(text));
    } else {
      vec = await requestMemoryEmbedding(lane, String(text), purpose);
    }
    stopLoopWatch();
    embedHealth.ok += 1;
    noteEmbed(purpose, true);
    embedHealth.lastOkAt = new Date().toISOString();
    return vec;
  } catch (e) {
    const detail = embedErrorText(e);
    embedHealth.failed += 1;
    noteEmbed(purpose, false);
    embedHealth.lastError = detail;
    embedHealth.lastErrorAt = new Date().toISOString();
    const held = stopLoopWatch();
    embedHealth.lastLoopHeldMs = held;
    logger.warn(
      `[kadeDiary] embedding call FAILED -- semantic recall is blind for this turn (${lane.provider}/${lane.model}): ${detail}` +
        ` [purpose ${purpose}${held == null ? '' : `, event loop held up to ${held} ms during this call`}]`,
    );
    /* Part 295: an empty prepaid balance (the Aug 28 cause) or a refused key tells Kade, at most
     * once every few hours, instead of only filling the log. Fire-and-forget. */
    if (lane.provider === 'gemini') {
      try {
        require('~/server/services/kadeGoogleKeyAlarm')
          .reportGoogleKeyTrouble('memory recall', e)
          .catch(() => {});
      } catch (_) {
        /* the alarm must never take a turn down */
      }
    }
    return null;
  }
}

/** The purpose a per-turn memo should key `purpose` under on the live lane (a lane that reads
 * no instruction embeds a tools query exactly like a memory query, so they share one call). */
function embedPurpose(purpose = 'query') {
  return typeof memoryEmbeddingPurpose === 'function'
    ? memoryEmbeddingPurpose(embedLane(), purpose)
    : purpose;
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
async function logDiaryEntry({
  userId,
  agentId = null,
  text,
  scope = 'agent',
  source = 'keeper',
  entryDate = null,
  salience = 1,
  conversationId = null,
  origin = 'unknown',
}) {
  const memorySource =
    memorySourceStorage.getStore() ||
    (conversationId ? { userId: String(userId), conversationId, kind: 'conversation' } : undefined);
  if (!(await memorySourceAllowed(memorySource)))
    return { ok: false, error: 'Conversation memory is excluded' };
  /* KADE Nov 11 2026 (card 8): never log a fact the person asked to forget. A marker read that
   * fails is left to the write below, which uses the same database and reports the real error. */
  let tomb = { blocked: false };
  try {
    tomb = await require('../server/services/kadeKnownTombstones').check(userId, text);
  } catch (_) {
    /* the write below reports any real error */
  }
  if (tomb && tomb.blocked) return { ok: false, error: 'they asked for that to be forgotten' };
  conversationId = conversationId || memorySource?.conversationId || null;
  const writeOrigin = diaryWriteOrigin({ source, conversationId, origin });
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
    /\basked|\brequested|\bran\b|\bwants? (?:me|a)\b|\bchecked\b|\bswept?\b|\bpass(?:ed)?\b|\bhousekeeping\b|\bconsolidat/i.test(
      cleanText,
    ) &&
    /\b(?:diary|logbook|memory|memories|notes?)\b/i.test(cleanText) &&
    /\b(?:search|check|look(?:ed)?\s?up|read back|record|housekeeping|consolidat|merge|repair|sweep|consolidation pass|nothing needed changing)/i.test(
      cleanText,
    )
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
    entryDate && /^\d{4}-\d{2}-\d{2}$/.test(String(entryDate))
      ? String(entryDate)
      : centralDateString();
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
        .select('text embedding embedModel embeddingNext embedNextModel embedNextHash')
        .limit(40)
        .lean();
      const norm = (t) =>
        String(t || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const mine = norm(cleanText);
      const threshold = (() => {
        const v = parseFloat(process.env.KADE_DIARY_DEDUP_SIM);
        return Number.isFinite(v) && v > 0.5 && v <= 1 ? v : 0.93;
      })();
      for (const row of sameDay) {
        if (norm(row.text) === mine) {
          return {
            ok: false,
            error: 'duplicate: an identical entry already exists for that day',
            duplicate: true,
          };
        }
        const vector = indexedEmbedding(
          row,
          currentEmbedModel(),
          row.text,
          embedLane()?.dimensions || 1536,
        );
        if (embedding && vector && embedding.length === vector.length) {
          if (cosine(embedding, vector) >= threshold) {
            return {
              ok: false,
              error: 'duplicate: a near-identical entry already exists for that day',
              duplicate: true,
            };
          }
        }
      }
    } catch (e) {
      /* A dedup hiccup must never block a real entry — the gap this guard
       * exists for is worse than an occasional double. */
      logger.warn('[kadeDiary] dedup check skipped:', e.message);
    }
  }

  const cleanSalience = Math.min(Math.max(parseInt(salience, 10) || 1, 1), 3);

  /* ── ONE ENTRY PER EPISODE (Part 112) ─────────────────────────────────────
   * Runs AFTER the dedup guard on purpose: a near-identical re-file of the
   * same moment ("went down the rabbit hole" for the fifth time) is still
   * refused outright; only a genuinely NEW development reaches this point and
   * extends the episode's entry. The keeper was told nothing about any of
   * this — machine lanes get less instruction, not more (law 19); the key
   * decides, not the model.
   *
   * The amend APPENDS rather than replaces, so the earlier wording stays in
   * the searchable text itself, and the full pre-amend text is additionally
   * kept verbatim in priorTexts. Re-embeds the combined text; if the embed
   * lane is down (the Aug-28 shape) the old embedding is KEPT rather than
   * nulled — close is better than absent, and the backfill pass can redo it. */
  if (conversationId && process.env.KADE_DIARY_EPISODE !== '0') {
    try {
      const existing = await KadeDiaryEntry.findOne({
        userId: String(userId),
        agentId: effectiveAgentId,
        conversationId: String(conversationId),
        entryDate: effectiveDate,
      });
      if (existing) {
        const combined = `${existing.text.replace(/\s+$/, '')} ${cleanText}`.slice(0, 2000);
        if (combined === existing.text) {
          return {
            ok: false,
            error: 'duplicate: entry is already at its text limit',
            duplicate: true,
          };
        }
        const newEmbedding = await embedText(combined);
        existing.priorTexts = [...(existing.priorTexts || []), existing.text];
        existing.text = combined;
        if (newEmbedding) {
          existing.embedding = newEmbedding;
          existing.embedModel = currentEmbedModel();
        }
        existing.salience = Math.max(existing.salience || 1, cleanSalience);
        if (!(await memorySourceAllowed(memorySource)))
          return { ok: false, error: 'Memory policy changed during this write' };
        existing.sourceConversationIds = [
          ...new Set([
            ...(existing.sourceConversationIds || []),
            ...(memorySource?.conversationIds || [conversationId]).filter(Boolean),
          ]),
        ];
        existing.set(`writeActivity.${writeOrigin}.amendedAt`, new Date());
        await existing.save();
        return { ok: true, date: effectiveDate, amended: true };
      }
    } catch (e) {
      /* An amend hiccup must never eat the moment — fall through and create. */
      logger.warn('[kadeDiary] episode amend skipped:', e.message);
    }
  }

  try {
    if (!(await memorySourceAllowed(memorySource))) {
      return { ok: false, error: 'Memory policy changed during this write' };
    }
    const created = await KadeDiaryEntry.create({
      writeActivity: { [writeOrigin]: { createdAt: new Date() } },
      sourceConversationIds: (memorySource?.conversationIds || [conversationId]).filter(Boolean),
      userId: String(userId),
      agentId: effectiveAgentId,
      text: cleanText,
      entryDate: effectiveDate,
      embedding,
      embedModel: embedding ? currentEmbedModel() : null,
      source,
      salience: cleanSalience,
      conversationId: conversationId ? String(conversationId) : null,
    });
    if (!(await memorySourceAllowed(memorySource))) {
      await KadeDiaryEntry.deleteOne({
        _id: created._id,
        userId: String(userId),
        agentId: effectiveAgentId,
      });
      return { ok: false, error: 'Memory policy changed during this write' };
    }
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
  /** Part 128 (memory share): other companions' entries this seat has opened to this one. */
  extraAgentIds = [],
}) {
  if (!diaryEnabled() || !userId) {
    return [];
  }
  const cap = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 12);
  /* TURN-14 (turn audit, Nov 12 2026): one read of the exclusion list, not two. */
  const excluded = await excludedMemoryConversations(String(userId));
  const filter = {
    userId: String(userId),
    conversationId: { $nin: excluded },
    sourceConversationIds: { $nin: excluded },
    $or: [
      { agentId: null },
      ...(agentId ? [{ agentId: String(agentId) }] : []),
      ...(Array.isArray(extraAgentIds) ? extraAgentIds.map((a) => ({ agentId: String(a) })) : []),
    ],
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
  /* DB-2 (platform audit, Nov 12 2026): recall runs inside the turn; each read gives up after
   * KADE_TURN_READ_MAX_MS (3 s) and the catch below returns nothing, as for any failure. */
  const readOptions = turnReadOptions();
  try {
    if (!query) {
      const rows = await KadeDiaryEntry.find(filter, null, readOptions)
        .sort({ entryDate: -1, createdAt: -1 })
        .limit(cap)
        .lean();
      return rows.map((r) => ({
        date: r.entryDate,
        text: r.text,
        agentScoped: Boolean(r.agentId),
        agentId: r.agentId ? String(r.agentId) : null,
        score: null,
      }));
    }
    const qVec =
      Array.isArray(queryVector) && queryVector.length > 0
        ? queryVector
        : await embedText(String(query), { purpose: 'query' });
    if (!qVec) {
      /* embedding down → degrade to recency within the same filter */
      const rows = await KadeDiaryEntry.find(filter, null, readOptions)
        .sort({ entryDate: -1, createdAt: -1 })
        .limit(cap)
        .lean();
      return rows.map((r) => ({
        date: r.entryDate,
        text: r.text,
        agentScoped: Boolean(r.agentId),
        agentId: r.agentId ? String(r.agentId) : null,
        score: null,
      }));
    }
    const scored = [];
    const activeModel = currentEmbedModel();
    const dimensions = embedLane()?.dimensions;
    /* Family scale: load the scoped slice and rank in-process (see header note).
     * TURN-14 (turn audit, Nov 12 2026): only a vector this lane can compare crosses
     * the wire. A row keeps its rollback vector beside the live one, and both were read
     * on every turn (two 1,536-number arrays per row, up to 3,000 rows).
     * indexedEmbedding() below reads `embedding` only when embedModel is the active
     * model and `embeddingNext` only when embedNextModel is, so it picks the same field
     * as before. aggregate() does not cast: every value in `filter` is already a string. */
    const rows = await KadeDiaryEntry.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $limit: 3000 },
      {
        $project: {
          text: 1,
          entryDate: 1,
          agentId: 1,
          salience: 1,
          embedModel: 1,
          embedNextModel: 1,
          embedNextHash: 1,
          embedding: {
            $cond: [{ $eq: ['$embedModel', activeModel] }, '$embedding', '$$REMOVE'],
          },
          embeddingNext: {
            $cond: [{ $eq: ['$embedNextModel', activeModel] }, '$embeddingNext', '$$REMOVE'],
          },
        },
      },
    ], readOptions);
    /* TIME-AWARE RECALL (Aug 9 2026, Zep's lesson from the northstar pass):
     * relevance gates (raw cosine >= minScore), but the RANKING blends in
     * recency and salience. A fresh entry gets up to +0.05; the boost halves
     * every ~42 days and is gone by a season — old entries still win when
     * they're plainly more relevant. Salience multiplies AFTER the gate:
     * ordinary 1.0x, notable 1.12x, big 1.24x — a salience-3 day (a loss, a
     * milestone) structurally outranks a same-relevance product note. */
    const todayMs = Date.now();
    for (const r of rows) {
      const vector =
        activeModel && dimensions ? indexedEmbedding(r, activeModel, r.text, dimensions) : null;
      if (!vector || qVec.length !== vector.length) continue;
      const score = cosine(qVec, vector);
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
          agentId: r.agentId ? String(r.agentId) : null,
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
      .select('-embedding -embeddingNext -embedNextHash')
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

/* Oct 16 2026: the admin backfill (POST /memories/diary-embed-backfill) counted
 * every entry whose embedModel was not the live lane, so with Qwen live it saw
 * all 1,251 staged entries as unembedded, and a real run paid for them again
 * and wrote over the Google vectors kept for rollback. An entry now needs an
 * embed only when nothing it carries is searchable on the live lane (its own
 * vector, or a staged one for the same model and words), and a new vector is
 * staged beside another model's index instead of replacing it. Streams the
 * candidates, so the vectors are never all in memory at once.
 * Returns null when no lane is configured. */
const BACKFILL_FIELDS = '_id text embedding embedModel embeddingNext embedNextModel embedNextHash';
async function diaryEmbedBacklog(model, dimensions, limit, { newestFirst = false } = {}) {
  const filter = {
    $or: [{ embedding: null }, { embedding: { $size: 0 } }, { embedModel: { $ne: model } }],
  };
  const rows = [];
  let needing = 0;
  let found = KadeDiaryEntry.find(filter).select(BACKFILL_FIELDS);
  if (newestFirst) found = found.sort({ _id: -1 });
  for await (const r of found.lean().cursor()) {
    if (indexedEmbedding(r, model, String(r.text || ''), dimensions)) continue;
    needing += 1;
    if (rows.length < limit) {
      const otherIndex =
        Array.isArray(r.embedding) &&
        r.embedding.length > 0 &&
        !!r.embedModel &&
        r.embedModel !== model;
      rows.push({ _id: r._id, text: r.text, otherIndex });
    }
  }
  return { needing, rows };
}

async function backfillDiaryEmbeddings({ dry = false, limit = 300, pauseMs = 150 } = {}) {
  const lane = embedLane();
  const model = currentEmbedModel();
  if (!lane || !model) return null;
  const { needing, rows } = await diaryEmbedBacklog(model, lane.dimensions, dry ? 0 : limit);
  if (dry) return { dry: true, needing, model };
  let embedded = 0;
  let failed = 0;
  for (const r of rows) {
    const text = String(r.text || '');
    const vec = await embedText(text.slice(0, 4000));
    if (vec) {
      await KadeDiaryEntry.updateOne(
        { _id: r._id, text: r.text },
        {
          $set: r.otherIndex
            ? { embeddingNext: vec, embedNextModel: model, embedNextHash: embeddingTextHash(text) }
            : { embedding: vec, embedModel: model },
        },
      );
      embedded += 1;
    } else {
      failed += 1;
      /* Provider still failing? Stop after three straight so a dead lane
       * costs three calls, not a thousand. */
      if (failed >= 3 && embedded === 0) {
        break;
      }
    }
    if (pauseMs > 0) await new Promise((ok) => setTimeout(ok, pauseMs));
  }
  const remaining = (await diaryEmbedBacklog(model, lane.dimensions, 0)).needing;
  return { scanned: rows.length, embedded, failed, remaining, model };
}

/* Nov 10 2026 -- THE LOGBOOK HEALS ITSELF AT NIGHT.
 *
 * A logbook entry whose embed failed when it was written has no vector, and
 * search by meaning can never find it. Cards mend themselves a few at a time on
 * every turn (kadeCardRecall's background sync); the logbook only mended when
 * somebody called the admin backfill route. The nightly summary sweep now calls
 * this once a night.
 *
 * Capped on purpose, because every embed draws on the shared prepaid credit:
 * at most KADE_DIARY_NIGHTLY_EMBED_MAX rows a night (default 60, about a
 * hundredth of a cent), newest first, and it stops after three failures in a
 * row so a dead lane costs three calls. Background only: nothing here runs on
 * a turn. Kill switch: KADE_DIARY_NIGHTLY_EMBED=0. */
const NIGHTLY_STRAIGHT_FAILURES = 3;
function nightlyEmbedCap() {
  const n = parseInt(process.env.KADE_DIARY_NIGHTLY_EMBED_MAX, 10);
  return Number.isFinite(n) && n >= 1 && n <= 500 ? n : 60;
}

/**
 * The repair loop itself, with everything it touches handed in so it can be
 * tested bare. Walks at most `cap` rows; a row with no text is skipped and is
 * not a failure; `maxStraight` failures in a row stop the pass.
 */
async function repairEmbedLoop({ rows, cap, embed, save, pause, maxStraight = 3 }) {
  const out = { scanned: 0, embedded: 0, failed: 0, skipped: 0, stopped: false };
  let straight = 0;
  for (const r of (rows || []).slice(0, Math.max(0, cap))) {
    out.scanned += 1;
    const text = String((r && r.text) || '');
    if (!text.trim()) {
      out.skipped += 1;
      continue;
    }
    let vec = null;
    try {
      vec = await embed(text.slice(0, 4000));
    } catch (_) {
      vec = null;
    }
    if (Array.isArray(vec) && vec.length > 0) {
      await save(r, vec, text);
      out.embedded += 1;
      straight = 0;
    } else {
      out.failed += 1;
      straight += 1;
      if (straight >= maxStraight) {
        out.stopped = true;
        break;
      }
    }
    if (pause) await pause();
  }
  return out;
}

async function nightlyDiaryEmbedRepair({ pauseMs = 150 } = {}) {
  if (process.env.KADE_DIARY_NIGHTLY_EMBED === '0') return { ran: false, reason: 'disabled' };
  if (!diaryEnabled()) return { ran: false, reason: 'diary-off' };
  const lane = embedLane();
  const model = currentEmbedModel();
  if (!lane || !model) return { ran: false, reason: 'no-lane' };
  const cap = nightlyEmbedCap();
  const { needing, rows } = await diaryEmbedBacklog(model, lane.dimensions, cap, {
    newestFirst: true,
  });
  const result = await repairEmbedLoop({
    rows,
    cap,
    embed: (text) => embedText(text),
    save: (r, vec, text) =>
      KadeDiaryEntry.updateOne(
        { _id: r._id, text: r.text },
        {
          $set: r.otherIndex
            ? { embeddingNext: vec, embedNextModel: model, embedNextHash: embeddingTextHash(text) }
            : { embedding: vec, embedModel: model },
        },
      ),
    pause: pauseMs > 0 ? () => new Promise((ok) => setTimeout(ok, pauseMs)) : null,
    maxStraight: NIGHTLY_STRAIGHT_FAILURES,
  });
  return { ran: true, needing, cap, model, ...result };
}

module.exports = {
  KadeDiaryEntry,
  diaryEnabled,
  centralDateString,
  embedText,
  embedPurpose,
  currentEmbedModel,
  readEmbedHealth,
  embedHealthAmber,
  stripLeadingDateStamp,
  logDiaryEntry,
  editDiaryEntry,
  backfillDiaryEmbeddings,
  nightlyDiaryEmbedRepair,
  repairEmbedLoop,
  searchDiary,
  countEntries,
};
