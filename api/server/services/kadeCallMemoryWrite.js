/* Calls TEACH memory now (July 2026, Kade: "in-chat calls should have the same
 * memory access as text — the only difference is the pipeline").
 *
 * Text chat runs the mistral-small memory-writer after every exchange, so new
 * durable facts get filed. Calls never did — the merge (kadeCallMerge.js) only
 * MIRRORS the transcript into a conversation; nothing LEARNED from it. So a
 * caller could tell Kiana "dad's surgery moved to August" on the phone and it
 * evaporated. This runs the SAME writer, with the SAME salience-fixed
 * instructions (memory.agent.instructions in librechat.yaml — "questions aren't
 * preferences"), over a finished call transcript. Reading parity already
 * existed (GET /call-memories); this closes the WRITING half.
 *
 * Design notes:
 *  - Reuses processMemory + resolveMemoryAgentLLMConfig from @librechat/api,
 *    exactly like the on-demand /consolidate route and the weekly sweep — no new
 *    model wiring, no duplicated tool-parsing, headless via a stub res.
 *  - Salience is inherited for free: same writer, same instructions the text
 *    path uses, so it will NOT over-save one-off call chatter.
 *  - Runs ONCE per transcript (atomic memoryExtractedAt stamp) so /ingest retries
 *    (stop + close both fire) can't double-file.
 *  - Fire-and-forget + fully fail-soft: a writer hiccup never touches call
 *    logging, the merge, or a live call.
 *  - Env hatch KADE_CALL_MEMORY=0 disables instantly (no redeploy), matching the
 *    KADE_SIGHT / KADE_VOICE_TAGS pattern.
 */
const { logger } = require('@librechat/data-schemas');
const { processMemory, resolveMemoryAgentLLMConfig } = require('@librechat/api');
const { HumanMessage, AIMessage, getBufferString } = require('@librechat/agents/langchain/messages');
const {
  setMemory,
  deleteMemory,
  getFormattedMemories,
  getUserKey,
  getUserKeyValues,
} = require('~/models');
const { KadeCallTranscript } = require('~/models/kadeCallTranscript');
const { getAppConfig } = require('~/server/services/Config');

/* Keep the writer's input bounded — a long ramble call is fine, but we cap the
 * buffer so one giant call can't blow the writer's context or cost. The tail is
 * the most memory-worthy part (where they land on the real news). */
const MAX_CALL_BUFFER_CHARS = 120000;

/**
 * Run the memory-writer over one finished call transcript so durable facts get
 * saved, just like a text chat. Idempotent + fail-soft. Returns a small status
 * object (never throws).
 *
 * @param {object} transcriptDoc  lean KadeCallTranscript ({_id, user, agentId, turns, ...})
 */
async function extractMemoryFromCall(transcriptDoc) {
  try {
    if (String(process.env.KADE_CALL_MEMORY || '') === '0') {
      return { ran: false, reason: 'disabled' };
    }
    const doc = transcriptDoc;
    if (!doc || !doc.user || !doc._id) {
      return { ran: false, reason: 'no-doc' };
    }
    const userId = String(doc.user);
    const turns = Array.isArray(doc.turns) ? doc.turns.filter((t) => t && t.text) : [];
    if (turns.length < 2) {
      return { ran: false, reason: 'too-short' }; // nothing worth learning from a one-liner
    }

    /* Run-once guard: atomically claim this transcript. If memoryExtractedAt is
     * already set (a prior /ingest retry got here first), bail — no double-file. */
    const claim = await KadeCallTranscript.updateOne(
      { _id: doc._id, $or: [{ memoryExtractedAt: { $exists: false } }, { memoryExtractedAt: null }] },
      { $set: { memoryExtractedAt: new Date() } },
    );
    const claimed = claim && (claim.modifiedCount === 1 || claim.nModified === 1);
    if (!claimed) {
      return { ran: false, reason: 'already-extracted' };
    }

    const appConfig = await getAppConfig();
    const memoryConfig = appConfig && appConfig.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return { ran: false, reason: 'memory-disabled' };
    }
    /* Same guard the /consolidate route uses — the writer needs a provider+model. */
    if (!memoryConfig.agent || !memoryConfig.agent.provider || !memoryConfig.agent.model) {
      return { ran: false, reason: 'no-writer-configured' };
    }

    const agentId = doc.agentId ? String(doc.agentId).slice(0, 64) : undefined;

    /* Render the call as a normal conversation buffer, mirroring the text path's
     * runMemory() exactly ("# Current Chat:\n\n" + getBufferString). Same shape
     * the writer instructions were tuned against, so behavior matches chat. */
    const messages = turns.map((t) =>
      t.role === 'user'
        ? new HumanMessage(String(t.text || ''))
        : new AIMessage(String(t.text || '')),
    );
    let bufferString = getBufferString(messages);
    if (bufferString.length > MAX_CALL_BUFFER_CHARS) {
      bufferString =
        '[Earlier call content omitted due to memory input limit]\n\n' +
        bufferString.slice(-MAX_CALL_BUFFER_CHARS);
    }
    const memoryInput = `# Current Chat:\n\n${bufferString}`;

    /* Resolve the writer's real credentials/baseURL (OpenRouter is a custom
     * endpoint) — identical resolution to the /consolidate route + weekly sweep. */
    const llmConfig = await resolveMemoryAgentLLMConfig({
      appConfig,
      memoryConfig,
      userId,
      db: { getUserKey, getUserKeyValues },
    });

    /* Existing memories in context so the writer doesn't re-file known facts
     * (shared bucket + this agent's own bucket, same as the chat path). */
    const { withKeys, totalTokens } = await getFormattedMemories({ userId, agentId });

    const stubRes = { headersSent: false };
    await processMemory({
      res: stubRes,
      userId,
      agentId,
      messages: [new HumanMessage(memoryInput)],
      validKeys: undefined, // free-form memory-cards mode, same as chat
      llmConfig,
      messageId: `call-mem-${doc._id}`,
      tokenLimit: memoryConfig.tokenLimit,
      conversationId: doc.mergedConversationId
        ? String(doc.mergedConversationId)
        : `call-${doc._id}`,
      memory: withKeys || '',
      totalTokens: totalTokens || 0,
      instructions: memoryConfig.agent.instructions, // the SALIENCE-fixed writer prompt
      setMemory,
      deleteMemory,
      user: { id: userId },
    });

    logger.info(
      `[kadeCallMemoryWrite] extracted memory from call ${doc._id} (${turns.length} turns, surface=${doc.surface || '?'}, agent=${agentId || 'shared-only'})`,
    );
    return { ran: true };
  } catch (err) {
    /* Never let a writer problem surface to the caller/merge/live call. If we
     * had claimed the stamp, clear it so a later maintenance pass can retry. */
    try {
      if (transcriptDoc && transcriptDoc._id) {
        await KadeCallTranscript.updateOne(
          { _id: transcriptDoc._id },
          { $unset: { memoryExtractedAt: '' } },
        );
      }
    } catch (_) {
      /* ignore */
    }
    logger.warn(
      `[kadeCallMemoryWrite] extract failed for call ${transcriptDoc && transcriptDoc._id}: ${err && err.message}`,
    );
    return { ran: false, reason: 'error' };
  }
}

module.exports = { extractMemoryFromCall };
