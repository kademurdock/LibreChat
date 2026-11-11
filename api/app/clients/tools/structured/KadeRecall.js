const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/* Kept identical to kadeRecallSchema in packages/api/src/tools/registry/definitions.ts. */
const kadeRecallSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look for, in a few words (for example "pharmacy phone number").' },
    everywhere: { type: 'boolean', description: 'True only when they ask you to look in all their chats, not just yours with them.' },
    limit: { type: 'integer', description: 'How many bits to bring back, 1 to 8. Default 5.' },
  },
  required: ['query'],
};

/**
 * KADE RECALL (Nov 11 2026, card 9): search the person's own past chats for something they said
 * or were told ("what was that pharmacy number from last week?"). The engine is
 * api/server/services/kadeRecallSearch.js: their own messages only, signed-in only, code-like
 * numbers masked.
 */
class KadeRecall extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_recall';
    this.description =
      'Search their own past chats for words they said or you said: a number, a name, a place, something from last week. ' +
      'Use when they ask what was said before and it is not in view. Answer from what comes back; if nothing comes back, say so and do not guess.';
    this.schema = kadeRecallSchema;
    this.req = fields.req;
    this.agentId = fields.agentId;
  }

  async _call(data) {
    try {
      const out = await require('~/server/services/kadeRecallSearch').search({
        req: this.req,
        agentId: this.agentId,
        query: data && data.query,
        everywhere: Boolean(data && data.everywhere),
        limit: data && data.limit,
      });
      const { ok, why: _why, ...rest } = out;
      return `${ok ? 'OK' : 'FAILED'}: ${JSON.stringify(rest)}`;
    } catch (e) {
      logger.warn('[KadeRecall] ' + (e && e.message));
      return 'FAILED: the chat search had a problem. Say so plainly; do not guess what was said.';
    }
  }
}

module.exports = KadeRecall;
