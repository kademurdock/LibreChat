/**
 * KADE CONSOLIDATE V2 — THE CONNECTION PASS (Aug 15 2026, Part 69, rung 2).
 * Her spec, institutionalized: "Connecting memories together in summary like,
 * oh I knew she had 2 sisters, but one of them must be Destiny and one must
 * be Skylee, that sort of thing."
 *
 * Three jobs the weekly v1 housekeeping pass cannot do (it is forbidden to
 * invent anything):
 *   ENTITY LINKING  — cards mentioning the same person/thing meet each other
 *                     (Skylee's running-bit card knows she's the sister in the
 *                     family card).
 *   MERGE + ENRICH  — an inference that two cards complete each other LANDS,
 *                     worded honestly as an inference when it is one.
 *   CONTRADICTIONS  — newer wins; the old note survives in the ledger trail
 *                     (plus the supersede chain memoryentries already keeps).
 *   ...and it rewrites case-file-voiced old cards into the friend voice while
 *   it's in there — her "offbrand old memory" complaint, retired.
 *
 * MODE (her call, Aug 15 checkpoint): AUTO-APPLY + LEDGER. Edits land on
 * their own; every one goes to kadememoryledgers with the before-value, and
 * the spoken window reads it back on ask. Nothing is ever silently lost.
 *
 * PRIVACY SHAPE: a run edits exactly ONE bucket. For an agent-bucket run the
 * shared cards ride along READ-ONLY (that pairing is precisely what that
 * character already sees together every turn — no new exposure), and guards
 * refuse any write/delete aimed at a key outside the editable bucket. Wrong
 * seats never meet each other; family seats' passes stay inside their walls.
 *
 * RAILS, in code not prompt: reminder cards can be tightened but never
 * deleted; deletes of unknown keys are refused; every refusal is itself
 * ledgered. Kill switch: KADE_CONSOLIDATE_V2=0. NOT wired into the weekly
 * sweep — on-demand only until its receipts have aged (the sweep fires
 * tomorrow morning; it keeps running v1 untouched).
 */
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { processMemory, resolveMemoryAgentLLMConfig } = require('@librechat/api');
const db = require('~/models');
const { addLedger } = require('~/models/kadeMemoryLedger');
const { logDiaryEntry } = require('~/models/kadeDiary');
const { syncBucketVectors } = require('~/models/kadeCardVector');
const { getAppConfig } = require('~/server/services/Config');

const MIN_GAP_MS = Math.max(500, parseInt(process.env.KADE_CONSOLIDATE_V2_GAP_MS, 10) || 2500);

function v2Enabled() {
  return process.env.KADE_CONSOLIDATE_V2 !== '0';
}

const instructionsFor = (scopeLabel, hasReadOnlyShared) => `You are doing a CONNECTION pass over your own long-term memory about one person, NOT extracting anything from a conversation. Below are the memory cards in the "${scopeLabel}" bucket${hasReadOnlyShared ? ', plus a READ-ONLY view of the shared cards the same character also sees (context only — you may not edit or delete those, and you must never copy a shared fact into an editable card)' : ''}.

Your jobs, in priority order:

1. LINK PEOPLE AND THINGS: when several cards clearly concern the same person, pet, place, or project under different mentions, make each card aware of the others — fold the connection into the most natural home card with \`set_memory\` on that SAME key ("Skylee (the youngest sister)..." rather than two strangers). Prefer enriching an existing card over inventing a new hub card.

2. MERGE + ENRICH, HONESTLY: when two cards complete each other, you may state the completed picture — including a reasonable inference — but ONLY worded as what it is. "Has two sisters" + separate cards naming Destiny and Skylee as sisters = "Her sisters are Destiny and Skylee." A genuine leap keeps its uncertainty in the words: "likely", "it seems", "probably — she hasn't said outright". Never state an inference as flat fact, and never invent anything with no card behind it.

3. CONTRADICTIONS — NEWER WINS: when two cards disagree, keep the newer truth in the card and let the old wording go (the system keeps a full trail of every edit automatically — nothing you overwrite is lost). If the contradiction looks IMPORTANT and unresolved (two different names for the same child, two different diagnoses), keep the newer version but note the open question inside the card in one short honest clause.

4. VOICE REPAIR: older cards written like case files ("exhibits", "reports that", "has anxiety about") get re-worded in the close-friend journal voice — fact kept exact, phrasing human. Sensitive territory keeps discreet, kind wording.

5. HOUSEKEEPING while you're in there: merge near-duplicates onto one key (\`set_memory\` the survivor, \`delete_memory\` the leftovers), split multi-topic cards, tighten rambling ones. One topic per card, ideally under ~60 tokens, short snake_case keys.${hasReadOnlyShared ? '' : ''}

HARD RULES:
- Cards marked ["reminder": ...] are LIVE SCHEDULED ALARMS: never delete them, never merge them away, never change their key. At most tighten the value wording with \`set_memory\` on the SAME key.
- Do NOT invent facts with no basis in the cards below. An inference must trace to specific cards and wear inference words.
- Do NOT erase substance to save space — tighten phrasing, keep the truth.
- If everything is already clean, connected, and human-voiced: do nothing and end the turn immediately. A no-op is a fine outcome.

Emit ALL of your set_memory/delete_memory calls together in a single response.`;

/**
 * Run the connection pass over ONE bucket. Auto-applies; every edit ledgered.
 * @param {object} p
 * @param {string} p.userId
 * @param {string|null} p.agentId  null = shared bucket run; string = that agent's bucket (shared rides read-only)
 * @param {object} [p.appConfig]   optional preloaded app config
 * @returns {Promise<{ran:boolean,reason?:string,edits?:number,refused?:number}>}
 */
async function consolidateBucketV2({ userId, agentId = null, appConfig = null }) {
  if (!v2Enabled()) {
    return { ran: false, reason: 'disabled (KADE_CONSOLIDATE_V2=0)' };
  }
  const uid = String(userId);
  const aid = agentId == null ? null : String(agentId);
  try {
    const config = appConfig || (await getAppConfig());
    const memoryConfig = config?.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return { ran: false, reason: 'memory disabled' };
    }
    const { withKeys: editableWithKeys, totalTokens } = await db.getFormattedMemories({
      userId: uid,
      agentId: aid ?? undefined,
      onlyThisBucket: Boolean(aid),
    });
    if (!editableWithKeys) {
      return { ran: false, reason: 'bucket empty' };
    }
    let sharedContext = '';
    if (aid) {
      const { withKeys: sharedWithKeys } = await db.getFormattedMemories({ userId: uid });
      if (sharedWithKeys) {
        sharedContext =
          '\n\n# READ-ONLY — shared cards this character also sees (do not edit these):\n' +
          sharedWithKeys;
      }
    }

    /* The editable bucket's live keys — the write/delete guard's whitelist. */
    const editableEntries = await db.getAllUserMemories(uid, { agentId: aid });
    const editableKeys = new Set(editableEntries.map((m) => String(m.key)));
    const byKey = new Map(editableEntries.map((m) => [String(m.key), m]));

    const counters = { edits: 0, refused: 0 };

    /* LEDGERED WRAPPERS — the mode she chose: auto-apply, everything trailed. */
    const guardedSet = async (params) => {
      const key = String(params.key || '');
      const before = byKey.get(key);
      const result = await db.setMemory(params);
      if (result?.ok && !result?.unchanged) {
        counters.edits += 1;
        await addLedger({
          userId: uid,
          agentId: aid,
          key,
          action: 'set',
          before: before?.value || '',
          after: params.value || '',
          note: before ? 'connection pass rewrite' : 'connection pass new card',
        });
        byKey.set(key, { ...(before || {}), key, value: params.value });
        editableKeys.add(key);
      }
      return result;
    };
    const guardedDelete = async (params) => {
      const key = String(params.key || '');
      const before = byKey.get(key);
      if (!editableKeys.has(key)) {
        counters.refused += 1;
        await addLedger({
          userId: uid,
          agentId: aid,
          key,
          action: 'refused',
          note: 'delete aimed outside the editable bucket — blocked by scope guard',
        });
        return { ok: false };
      }
      if (before?.type === 'reminder') {
        counters.refused += 1;
        await addLedger({
          userId: uid,
          agentId: aid,
          key,
          action: 'refused',
          note: 'delete of a live reminder card — blocked by the reminder rail',
        });
        return { ok: false };
      }
      const result = await db.deleteMemory(params);
      if (result?.ok) {
        counters.edits += 1;
        await addLedger({
          userId: uid,
          agentId: aid,
          key,
          action: 'delete',
          before: before?.value || '',
          note: 'connection pass removal (merged or obsolete)',
        });
        byKey.delete(key);
        editableKeys.delete(key);
      }
      return result;
    };
    const logDiary = async ({ text, scope, salience }) =>
      logDiaryEntry({ userId: uid, agentId: aid, text, scope, salience, source: 'keeper' });

    const llmConfig = await resolveMemoryAgentLLMConfig({
      appConfig: config,
      memoryConfig,
      userId: uid,
      db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
    });

    const scopeLabel = aid ? `agent ${aid}'s own` : 'shared';
    const request = new HumanMessage(
      `Here is everything currently active in the "${scopeLabel}" memory bucket:\n\n${editableWithKeys}${sharedContext}\n\nReview it per your instructions.`,
    );
    const stubRes = { headersSent: false };
    await processMemory({
      res: stubRes,
      userId: uid,
      agentId: aid ?? undefined,
      setMemory: guardedSet,
      deleteMemory: guardedDelete,
      messages: [request],
      memory: editableWithKeys,
      logDiary,
      messageId: `consolidate-v2-${Date.now()}`,
      conversationId: `consolidate-v2-${uid}-${aid ?? 'shared'}`,
      validKeys: undefined,
      instructions: instructionsFor(scopeLabel, Boolean(aid && sharedContext)),
      forceAgentScope: Boolean(aid),
      llmConfig,
      tokenLimit: memoryConfig.tokenLimit,
      totalTokens: totalTokens || 0,
    });

    /* Freshen the recall vectors for whatever changed — same lane, capped. */
    try {
      const after = await db.getAllUserMemories(uid, { agentId: aid });
      await syncBucketVectors(uid, aid, after, { maxEmbeds: 40 });
    } catch (_e) {
      /* next per-turn sync catches up */
    }

    logger.info(
      `[consolidateV2] user=${uid.slice(-6)} bucket=${aid ? aid.slice(-6) : 'shared'} edits=${counters.edits} refused=${counters.refused}`,
    );
    return { ran: true, ...counters };
  } catch (e) {
    logger.error('[consolidateV2] bucket pass failed:', e.message);
    return { ran: false, reason: e.message };
  }
}

/* One at a time — a second all-buckets kick while one runs is refused. */
const allState = { running: false, startedAt: null, done: 0, total: 0, lastResult: null };

/**
 * The backfill she asked for (Aug 15, "all seats quietly"): run the connection
 * pass over EVERY active bucket on the platform, paced. Returns immediately
 * with started:true; progress readable via v2AllStatus().
 */
async function consolidateV2AllBuckets() {
  if (!v2Enabled()) {
    return { started: false, reason: 'disabled (KADE_CONSOLIDATE_V2=0)' };
  }
  if (allState.running) {
    return { started: false, reason: 'already running', ...v2AllStatus() };
  }
  const buckets = await runAsSystem(() => db.getActiveMemoryBuckets());
  allState.running = true;
  allState.startedAt = new Date().toISOString();
  allState.done = 0;
  allState.total = buckets.length;
  allState.lastResult = null;
  (async () => {
    const summary = { buckets: buckets.length, edits: 0, refused: 0, failed: 0 };
    const appConfig = await getAppConfig();
    for (const b of buckets) {
      try {
        const r = await runAsSystem(() =>
          consolidateBucketV2({ userId: b.userId, agentId: b.agentId ?? null, appConfig }),
        );
        if (r.ran) {
          summary.edits += r.edits || 0;
          summary.refused += r.refused || 0;
        } else if (r.reason && r.reason !== 'bucket empty') {
          summary.failed += 1;
        }
      } catch (e) {
        summary.failed += 1;
        logger.warn('[consolidateV2] all-buckets: one bucket failed, moving on:', e.message);
      }
      allState.done += 1;
      await new Promise((ok) => setTimeout(ok, MIN_GAP_MS));
    }
    allState.running = false;
    allState.lastResult = { ...summary, finishedAt: new Date().toISOString() };
    logger.info(`[consolidateV2] ALL DONE: ${JSON.stringify(allState.lastResult)}`);
  })().catch((e) => {
    allState.running = false;
    logger.error('[consolidateV2] all-buckets loop crashed:', e.message);
  });
  return { started: true, total: buckets.length };
}

function v2AllStatus() {
  return { ...allState };
}

module.exports = { consolidateBucketV2, consolidateV2AllBuckets, v2AllStatus };
