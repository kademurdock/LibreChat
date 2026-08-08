/**
 * KADE LIVING DIARY — the automatic per-turn retrieval half (Aug 7 2026).
 * Model + search live in api/models/kadeDiary.js; this service turns "what the
 * user just said" into a small, tail-riding context block of the few diary
 * entries that actually relate — or nothing at all, which is the normal case.
 *
 * CACHE RELIGION: retrieved entries CHANGE per turn, so this block rides
 * `additional_instructions` (the volatile dynamic tail), NEVER the stable
 * instructions head. The head stays byte-stable; the prefix cache lives.
 *
 * BUDGETS (the anti-blurt teeth): at most 3 entries, similarity ≥ 0.32 (real
 * relevance, not vibes), whole block hard-capped ~1,200 chars, and the whole
 * lookup races a 2.5s timeout — a slow embed API means a diary-less turn, not
 * a slow turn. Empty archive short-circuits before any network call.
 */
const { logger } = require('@librechat/data-schemas');
const { diaryEnabled, searchDiary, countEntries } = require('~/models/kadeDiary');

const AUTO_TOP_K = 3;
const AUTO_MIN_SCORE = 0.32;
const AUTO_TIMEOUT_MS = 2500;
const AUTO_BLOCK_CHAR_CAP = 1200;

/**
 * Build the diary context block for this turn, or null (the common case).
 * Never throws; never exceeds its time or size budget.
 * @param {string} userId
 * @param {string|undefined} agentId - active persona; scopes what may surface
 * @param {string} userText - what the user just said this turn
 */
async function getDiaryTailBlock(userId, agentId, userText) {
  if (!diaryEnabled() || !userId) {
    return null;
  }
  const text = String(userText || '').trim();
  /* One-word turns ("ok", "lol") don't need the diary reaching for meaning. */
  if (text.length < 12) {
    return null;
  }
  try {
    const work = (async () => {
      const n = await countEntries(userId, agentId);
      if (n === 0) {
        return null;
      }
      const hits = await searchDiary({
        userId,
        agentId,
        query: text.slice(0, 1500),
        limit: AUTO_TOP_K,
        minScore: AUTO_MIN_SCORE,
      });
      if (!hits || hits.length === 0) {
        return null;
      }
      let block =
        '# Logbook recall (auto-surfaced for THIS turn only)\n' +
        'A few dated entries from your private logbook about this person, pulled because they seem related to what was just said. ' +
        'Wear them lightly: weave one in only if it truly fits, as a friend naturally would. Never recite, never list, never mention the logbook mechanism. ' +
        "If an entry contradicts what the person is saying right now, believe the person — their live word always beats an old note.\n";
      for (const h of hits) {
        const line = `- [${h.date}] ${h.text}\n`;
        if (block.length + line.length > AUTO_BLOCK_CHAR_CAP) {
          break;
        }
        block += line;
      }
      return block.trimEnd();
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), AUTO_TIMEOUT_MS));
    return await Promise.race([work, timeout]);
  } catch (e) {
    logger.warn('[kadeDiaryService] tail lookup failed (diary-less turn, non-fatal):', e.message);
    return null;
  }
}

module.exports = { getDiaryTailBlock, AUTO_TOP_K, AUTO_MIN_SCORE };
