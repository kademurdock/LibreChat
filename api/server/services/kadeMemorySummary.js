/* KADE DREAMING — episodic/contextual summary engine (July 2026).
 *
 * Generates + serves the rolling per-relationship "what's been going on lately"
 * summary that sits BESIDE the durable memory cards (see api/models/
 * kadeMemorySummary.js). It reuses the SAME memory-writer model the cards use
 * (mistral-small via memory.agent in librechat.yaml) through the same
 * resolveMemoryAgentLLMConfig path as the /consolidate route + weekly sweep —
 * no new model wiring — but runs it TOOL-LESSLY (a plain completion) to produce
 * a short narrative instead of card tool-calls.
 *
 * Everything here is FAIL-SOFT and cheap: a hiccup in generation never touches
 * a chat, a call, the cards, or the merge. Injection reads a single already-
 * stored paragraph (~120 words) so per-turn cost is negligible.
 *
 * Env hatch: KADE_MEMORY_SUMMARY=0 disables generation AND injection instantly
 * (no redeploy) — matches KADE_CALL_MEMORY / KADE_SIGHT / KADE_VOICE_TAGS.
 */
const { logger } = require('@librechat/data-schemas');
const { Run } = require('@librechat/agents');
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const { resolveMemoryAgentLLMConfig } = require('@librechat/api');
const {
  getMemorySummary,
  setMemorySummary,
} = require('~/models/kadeMemorySummary');
const { getUserKey, getUserKeyValues } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

const MAX_CONVO_CHARS = 120000; // feed the summarizer plenty (cheap model, 600K+ window) -- Kade's high-cap rule
const MAX_SUMMARY_CHARS = 4000; // generous ceiling; the PROMPT keeps it focused, this is just a safety net

function enabled() {
  return String(process.env.KADE_MEMORY_SUMMARY || '') !== '0';
}

/** Pull plain text out of whatever Run.processStream(returnContent) hands back. */
function extractText(content) {
  try {
    if (!content) {
      return '';
    }
    if (typeof content === 'string') {
      return content.trim();
    }
    if (Array.isArray(content)) {
      // array of content parts ({type:'text',text}) OR array of messages
      const parts = content
        .map((c) => {
          if (typeof c === 'string') {
            return c;
          }
          if (c && typeof c.text === 'string') {
            return c.text;
          }
          if (c && typeof c.content === 'string') {
            return c.content;
          }
          if (c && Array.isArray(c.content)) {
            return c.content.map((p) => (p && p.text) || '').join('');
          }
          return '';
        })
        .filter(Boolean);
      return parts.join('').trim();
    }
    if (typeof content.content === 'string') {
      return content.content.trim();
    }
    if (Array.isArray(content.content)) {
      return content.content.map((p) => (p && p.text) || '').join('').trim();
    }
    return '';
  } catch (_) {
    return '';
  }
}

const SUMMARY_INSTRUCTIONS = `You keep a SHORT running summary of what's been going on LATELY between the user and a specific character/companion — like a close friend's mental note of someone's recent life, not a transcript and not a fact sheet.

You will get the PREVIOUS summary (may be empty) and the LATEST conversation. Write an UPDATED running summary that:
- captures what's CURRENTLY going on for the user and in this relationship: ongoing situations, plans, worries, feelings, recent events, running jokes, how things are between them;
- folds new developments from the latest conversation into the previous summary;
- drops anything now resolved, stale, or no longer relevant;
- is usually a focused paragraph or two, in plain warm sentences -- as long as it genuinely needs to be to hold what's going on, but a SUMMARY of what's current, never a transcript or a padded retelling.

Do NOT list durable facts that belong in permanent memory (names, birthdays, diagnoses, preferences) — those are stored elsewhere; capture the STORY and what's current, not a profile. Write in third person about the user ("She's been..."). Output ONLY the summary text — no preamble, no headings, no quotes, no bullet points.`;

/** Turn a list of {role,text} turns into a compact transcript string (tail-capped). */
function turnsToText(turns) {
  const lines = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && t.text && String(t.text).trim())
    .map((t) => `${t.role === 'user' ? 'User' : 'Companion'}: ${String(t.text).trim()}`);
  let text = lines.join('\n');
  if (text.length > MAX_CONVO_CHARS) {
    text = '[earlier turns omitted]\n' + text.slice(-MAX_CONVO_CHARS);
  }
  return text;
}

/**
 * Core: refresh one relationship's rolling summary from a chunk of recent
 * conversation text. Reuses the memory-writer model, tool-lessly. Fail-soft:
 * returns the new summary string, or null on any problem (leaves prior intact).
 */
async function refreshSummaryFromText({ userId, agentId, agentName, conversationText, lastActivityAt, source }) {
  try {
    if (!enabled() || !userId || !agentId) {
      return null;
    }
    const convo = String(conversationText || '').trim();
    if (convo.length < 40) {
      return null; // nothing meaningful to summarize
    }

    const appConfig = await getAppConfig();
    const memoryConfig = appConfig && appConfig.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return null;
    }
    if (!memoryConfig.agent || !memoryConfig.agent.provider || !memoryConfig.agent.model) {
      return null;
    }

    const prior = await getMemorySummary(userId, agentId);
    const priorText = (prior && prior.summary) || '';

    const llmConfig = await resolveMemoryAgentLLMConfig({
      appConfig,
      memoryConfig,
      userId: String(userId),
      db: { getUserKey, getUserKeyValues },
    });

    const finalLLMConfig = {
      ...(llmConfig || {}),
      temperature: 0.3,
      streaming: false,
      disableStreaming: true,
      maxRetries: 0,
    };

    const userContent =
      `CHARACTER: ${agentName || 'the companion'}\n\n` +
      `PREVIOUS SUMMARY (may be empty):\n${priorText || '(none yet)'}\n\n` +
      `LATEST CONVERSATION:\n${convo}\n\n` +
      `Write the updated running summary now.`;

    const run = await Run.create({
      runId: `memsum-${agentId}-${Date.now()}`,
      graphConfig: {
        type: 'standard',
        llmConfig: finalLLMConfig,
        tools: [],
        instructions: SUMMARY_INSTRUCTIONS,
        toolEnd: false,
      },
      customHandlers: {},
      returnContent: true,
    });

    const content = await run.processStream(
      { messages: [new HumanMessage(userContent)] },
      {
        runName: 'MemorySummaryRun',
        configurable: {
          user_id: String(userId),
          thread_id: `memsum-${userId}-${agentId}`,
          provider: llmConfig && llmConfig.provider,
        },
        streamMode: 'values',
        recursionLimit: 2,
        version: 'v2',
      },
    );

    let text = extractText(content);
    if (!text) {
      return null; // couldn't parse a summary; leave the prior one untouched
    }
    if (text.length > MAX_SUMMARY_CHARS) {
      text = text.slice(0, MAX_SUMMARY_CHARS);
    }

    await setMemorySummary(userId, agentId, {
      summary: text,
      agentName,
      lastActivityAt: lastActivityAt || new Date(),
      source: source || 'refresh',
    });
    logger.info(
      `[kadeMemorySummary] refreshed summary for user=${userId} agent=${agentId} (${text.length} chars, ${source || 'refresh'})`,
    );
    return text;
  } catch (err) {
    logger.warn(
      `[kadeMemorySummary] refresh failed for user=${userId} agent=${agentId}: ${err && err.message}`,
    );
    return null;
  }
}

/** Convenience: refresh from a call transcript doc ({user, agentId, agentName, turns}). */
async function refreshSummaryFromCall(doc) {
  if (!doc || !doc.user || !doc.agentId) {
    return null;
  }
  const turns = Array.isArray(doc.turns) ? doc.turns : [];
  if (turns.length < 2) {
    return null;
  }
  return refreshSummaryFromText({
    userId: String(doc.user),
    agentId: String(doc.agentId),
    agentName: doc.agentName,
    conversationText: turnsToText(turns),
    lastActivityAt: doc.endedAt || doc.updatedAt || new Date(),
    source: 'call',
  });
}

/** Raw stored summary text for a relationship (or '' ). Respects the env hatch. */
async function getRelationshipSummaryText(userId, agentId) {
  try {
    if (!enabled() || !userId || !agentId) {
      return '';
    }
    const row = await getMemorySummary(userId, agentId);
    return (row && row.summary) || '';
  } catch (_) {
    return '';
  }
}

/**
 * Formatted injection block for the TEXT chat context (beside the memory
 * cards). Returns '' when there's nothing to inject.
 */
async function getRelationshipSummaryBlock(userId, agentId) {
  const s = await getRelationshipSummaryText(userId, agentId);
  if (!s) {
    return '';
  }
  return (
    `# What's been going on lately\n` +
    `Recent context for THIS person and you — use it naturally like you remember their life; ` +
    `do not recite it or read it as a list:\n${s}`
  );
}

module.exports = {
  refreshSummaryFromText,
  refreshSummaryFromCall,
  getRelationshipSummaryText,
  getRelationshipSummaryBlock,
  turnsToText,
};
