/**
 * KADE DIARY VOICE REPAIR — one-time retrofit pass (Aug 15 2026, Part 70).
 * The last "offbrand" remnant Part 69's audit named: 219 logbook entries
 * written BEFORE the taste rules landed on the keeper (Aug 9 2026 — "she read
 * the logbook and it read like a standup log"). Cards got their voice repaired
 * by consolidate-v2; this gives the logbook the same one-time kindness.
 *
 * HER RETROFIT POLICY (named this session): when a quality feature ships,
 * retrofitting it onto the past is ASSUMED RELEVANT and asked about, never
 * forgotten. This pass is that policy's first deliberate act.
 *
 * SHAPE: admin-only, dryRun-first (a census, zero writes, zero model calls).
 * The real run walks matching entries one privacy bucket at a time (one
 * user+agent bucket per model call — exactly the exposure the writer already
 * has), batches them through the SAME memory-writer model the cards use
 * (tool-less, the kadeMemorySummary pattern), and applies rewrites atomically:
 * new text + fresh embedding + the ORIGINAL text kept verbatim on the doc in
 * `preRepairText` — never silent loss, and the pre-pass file backup
 * (backups/memory_pre_v2_20260815/) already holds the whole logbook anyway.
 *
 * FACTS ARE SACRED: the instructions forbid changing any fact, name, date, or
 * number — phrasing only. Entries the model says are already warm get marked
 * vetted (voiceRepairedAt set, preRepairText null) so a re-run finds nothing:
 * the pass is idempotent like rag-sync. Failed batches stay unmarked and a
 * re-run retries just those. Kill: it's on-demand only; no schedule, no hook.
 */
const { logger } = require('@librechat/data-schemas');
const { Run } = require('@librechat/agents');
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const { resolveMemoryAgentLLMConfig } = require('@librechat/api');
const { KadeDiaryEntry, embedText, currentEmbedModel } = require('~/models/kadeDiary');
const { getUserKey, getUserKeyValues } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

/* Taste rules landed on the keeper Aug 9 2026 (packages/api memory.ts,
 * "HOW AN ENTRY SHOULD READ"). Everything written before Aug 10 UTC predates
 * settled taste; the dry run's census is the ground truth to adjust against. */
const DEFAULT_BEFORE = '2026-08-10T00:00:00.000Z';
const BATCH_SIZE = 12;
const CALL_GAP_MS = 1500;
const EMBED_GAP_MS = 120;

const INSTRUCTIONS = `You are repairing the VOICE of old private logbook entries about one person. An earlier version of the memory keeper wrote like a court reporter or a standup log; the house voice is a close friend keeping a journal.

For each numbered entry below, decide: does it read clinical, case-file, or standup-log ("exhibits", "reports that", "is experiencing", "engaged in debugging session")? If yes, rewrite it in the close-friend journal voice. If it already reads warm and human, skip it.

THE FACTS ARE SACRED: keep every fact, name, date, number, and event EXACTLY as written — you are changing phrasing only. Keep third person about the user. One or two plain sentences per entry. Never add information, never editorialize beyond the small human touch, never merge or split entries. Sensitive territory (health, money, family pain) keeps discreet, kind wording.

Reply with ONLY a JSON array of the entries you are CHANGING, in this exact shape:
[{"i": 3, "text": "the rewritten entry"}, {"i": 7, "text": "..."}]
If nothing needs changing, reply []. No prose, no code fences, nothing outside the JSON.`;

function parseModelJson(raw) {
  let t = String(raw || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  }
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (_e) {
    return null;
  }
}

function extractText(content) {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  if (typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

async function askWriter(finalLLMConfig, provider, userId, batchText) {
  const run = await Run.create({
    runId: `diaryrepair-${Date.now()}`,
    graphConfig: {
      type: 'standard',
      llmConfig: finalLLMConfig,
      tools: [],
      instructions: INSTRUCTIONS,
      toolEnd: false,
    },
    customHandlers: {},
    returnContent: true,
  });
  const content = await run.processStream(
    { messages: [new HumanMessage(batchText)] },
    {
      runName: 'DiaryVoiceRepairRun',
      configurable: {
        user_id: String(userId),
        thread_id: `diaryrepair-${userId}-${Date.now()}`,
        provider,
      },
      streamMode: 'values',
      recursionLimit: 2,
      version: 'v2',
    },
  );
  return extractText(content);
}

/**
 * @param {object} p
 * @param {boolean} [p.dryRun=true]  census only: counts, zero writes, zero model calls
 * @param {string}  [p.before]       ISO cutoff; entries created before this qualify
 * @param {number}  [p.limit=0]      cap on entries processed this run (0 = all)
 * @param {string}  [p.ownerUserId]  verbatim before/after samples allowed for THIS user only (privacy doctrine)
 */
async function repairDiaryVoice({ dryRun = true, before = DEFAULT_BEFORE, limit = 0, ownerUserId = null } = {}) {
  const t0 = Date.now();
  const beforeDate = new Date(before);
  if (Number.isNaN(beforeDate.getTime())) {
    return { ok: false, error: `bad before date: ${before}` };
  }
  const filter = { voiceRepairedAt: null, createdAt: { $lt: beforeDate } };

  const docs = await KadeDiaryEntry.find(filter)
    .select('_id userId agentId text entryDate source createdAt')
    .sort({ userId: 1, agentId: 1, createdAt: 1 })
    .lean();

  /* Census — the dry run's whole job, and the real run's denominator. */
  const bySource = {};
  const byDay = {};
  const bucketKeys = new Set();
  for (const d of docs) {
    bySource[d.source || 'unknown'] = (bySource[d.source || 'unknown'] || 0) + 1;
    byDay[d.entryDate] = (byDay[d.entryDate] || 0) + 1;
    bucketKeys.add(`${d.userId}::${d.agentId || 'shared'}`);
  }
  const census = {
    matched: docs.length,
    buckets: bucketKeys.size,
    bySource,
    byDay,
    before: beforeDate.toISOString(),
  };
  if (dryRun) {
    return { ok: true, dryRun: true, ...census, ms: Date.now() - t0 };
  }

  const appConfig = await getAppConfig();
  const memoryConfig = appConfig && appConfig.memory;
  if (!memoryConfig || memoryConfig.disabled === true) {
    return { ok: false, error: 'memory disabled' };
  }
  if (!memoryConfig.agent || !memoryConfig.agent.provider || !memoryConfig.agent.model) {
    return { ok: false, error: 'no memory-writer model configured' };
  }

  const work = limit > 0 ? docs.slice(0, limit) : docs;

  /* One privacy bucket per model call — group, then batch inside the bucket. */
  const buckets = new Map();
  for (const d of work) {
    const k = `${d.userId}::${d.agentId || 'shared'}`;
    if (!buckets.has(k)) {
      buckets.set(k, []);
    }
    buckets.get(k).push(d);
  }

  const out = { scanned: 0, rewritten: 0, vetted: 0, failedBatches: 0, samples: [] };

  for (const [, entries] of buckets) {
    const uid = String(entries[0].userId);
    let llmConfig;
    try {
      llmConfig = await resolveMemoryAgentLLMConfig({
        appConfig,
        memoryConfig,
        userId: uid,
        db: { getUserKey, getUserKeyValues },
      });
    } catch (e) {
      logger.warn('[diaryVoiceRepair] llm config failed for a bucket, skipping:', e.message);
      out.failedBatches += 1;
      continue;
    }
    const finalLLMConfig = {
      ...(llmConfig || {}),
      temperature: 0.3,
      streaming: false,
      disableStreaming: true,
      maxRetries: 0,
    };

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const numbered = batch
        .map((d, idx) => `${idx + 1}. [${d.entryDate}] ${d.text}`)
        .join('\n');
      let reply;
      try {
        reply = await askWriter(
          finalLLMConfig,
          llmConfig && llmConfig.provider,
          uid,
          `Entries:\n\n${numbered}\n\nReview them per your instructions.`,
        );
      } catch (e) {
        logger.warn('[diaryVoiceRepair] batch model call failed (will retry next run):', e.message);
        out.failedBatches += 1;
        continue;
      }
      const changes = parseModelJson(reply);
      if (changes == null) {
        logger.warn('[diaryVoiceRepair] unparseable reply, batch left unmarked for retry');
        out.failedBatches += 1;
        continue;
      }
      const changed = new Map();
      for (const c of changes) {
        const idx = parseInt(c && c.i, 10);
        const txt = c && typeof c.text === 'string' ? c.text.trim().slice(0, 2000) : '';
        if (Number.isInteger(idx) && idx >= 1 && idx <= batch.length && txt) {
          changed.set(idx - 1, txt);
        }
      }
      const now = new Date();
      for (let bIdx = 0; bIdx < batch.length; bIdx += 1) {
        const doc = batch[bIdx];
        out.scanned += 1;
        const newText = changed.get(bIdx);
        try {
          if (newText && newText !== doc.text) {
            const embedding = await embedText(newText);
            await KadeDiaryEntry.updateOne(
              { _id: doc._id },
              {
                $set: {
                  text: newText,
                  embedding,
                  embedModel: embedding ? currentEmbedModel() : null,
                  preRepairText: doc.text,
                  voiceRepairedAt: now,
                },
              },
            );
            out.rewritten += 1;
            if (ownerUserId && String(doc.userId) === String(ownerUserId) && out.samples.length < 3) {
              out.samples.push({ date: doc.entryDate, before: doc.text, after: newText });
            }
            await new Promise((ok) => setTimeout(ok, EMBED_GAP_MS));
          } else {
            await KadeDiaryEntry.updateOne(
              { _id: doc._id },
              { $set: { voiceRepairedAt: now } },
            );
            out.vetted += 1;
          }
        } catch (e) {
          logger.warn('[diaryVoiceRepair] apply failed for one entry (unmarked, retryable):', e.message);
        }
      }
      await new Promise((ok) => setTimeout(ok, CALL_GAP_MS));
    }
  }

  logger.info(
    `[diaryVoiceRepair] done: scanned=${out.scanned} rewritten=${out.rewritten} vetted=${out.vetted} failedBatches=${out.failedBatches} ms=${Date.now() - t0}`,
  );
  return { ok: true, dryRun: false, ...census, ...out, ms: Date.now() - t0 };
}

module.exports = { repairDiaryVoice };
