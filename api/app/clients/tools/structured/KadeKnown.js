const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/* Kept identical to kadeKnownSchema in packages/api/src/tools/registry/definitions.ts. */
const kadeKnownSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['count', 'read', 'correct', 'forget', 'forget_source', 'forget_all'],
      description:
        'count = how many things you know about them, by group (always first). read = the facts in one group. correct = fix one fact. forget = forget one fact. forget_source = forget everything from mail or from errands. forget_all = forget everything (asks first).',
    },
    group: { type: 'string', enum: ['told', 'errand', 'mail', 'others', 'all'], description: 'read. Which group. others = facts about other people.' },
    ref: { type: 'string', description: 'correct or forget. The ref of the fact, from read.' },
    value: { type: 'string', description: 'correct. The fact as it should be, in their words.' },
    source: { type: 'string', enum: ['mail', 'errand'], description: 'forget_source. Which source.' },
    offset: { type: 'integer', description: 'read. Skip this many, to hear more.' },
  },
  required: ['action'],
};

/**
 * KADE KNOWN (Nov 11 2026, card 8): "what do you know about me", "you remember that wrong",
 * "forget that". The engine is api/server/services/kadeKnownCard.js; deleting is done in code,
 * never by the model, and only in the signed-in app or website.
 */
class KadeKnown extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_known';
    this.description =
      'What you know about them, and fixing or forgetting it. Use when they ask what you know or remember about them, say you remember something wrong, or ask you to forget something. ' +
      'Call count first and say the counts; then read the group they pick. To forget or correct, read first and use the ref. If you are not sure which fact they mean, read it back and ask before forgetting. ' +
      'Never say a fact is forgotten unless forget answered ok.';
    this.schema = kadeKnownSchema;
    this.req = fields.req;
    this.agentId = fields.agentId;
  }

  async _call(data) {
    const known = require('~/server/services/kadeKnownCard');
    const action = String((data && data.action) || '');
    const base = { req: this.req, agentId: this.agentId };
    try {
      let out;
      if (action === 'count') out = await known.count(base);
      else if (action === 'read') out = await known.read({ ...base, group: data.group, offset: data.offset });
      else if (action === 'correct') out = await known.correct({ ...base, ref: data.ref, value: data.value });
      else if (action === 'forget') out = await known.forget({ ...base, ref: data.ref });
      else if (action === 'forget_source') out = await known.forgetSource({ ...base, source: data.source });
      else if (action === 'forget_all') out = await known.forgetAll(base);
      else return 'FAILED: unknown action. Use count, read, correct, forget, forget_source or forget_all.';
      const { ok, why: _why, ...rest } = out;
      return `${ok ? 'OK' : 'FAILED'}: ${JSON.stringify(rest)}`;
    } catch (e) {
      logger.warn('[KadeKnown] ' + (e && e.message));
      return 'FAILED: memory could not be reached just now. Tell them plainly; do not say anything was forgotten or changed.';
    }
  }
}

module.exports = KadeKnown;
