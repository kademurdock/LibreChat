const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/* Kept identical to kadeTaskSchema in packages/api/src/tools/registry/definitions.ts. */
const kadeTaskSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['quote', 'start', 'status', 'list', 'cancel'],
      description:
        'quote = the price of a job, before anything runs (always first). start = begin the job after they said yes to the price; needs quoteId. status = the newest job. list = recent jobs. cancel = stop a running job (needs taskId).',
    },
    goal: {
      type: 'string',
      description:
        'quote only. The whole job in plain words with the details that decide the answer (place, budget, dates, what "best" means to them).',
    },
    steps: {
      type: 'integer',
      minimum: 4,
      maximum: 40,
      description: 'quote only. Most rounds of tool work allowed, which is also the price ceiling. Default 20; small lookups need fewer.',
    },
    quoteId: { type: 'string', description: 'start only. The quoteId from quote.' },
    taskId: { type: 'string', description: 'status or cancel. The taskId from start or list.' },
  },
  required: ['action'],
};

/**
 * KADE BACKGROUND TASKS, the character's side (Oct 16 2026). The engine is
 * api/server/services/kadeTasks.js. The character quotes the price, the person
 * says yes, the character starts the job and goes on talking; the result comes
 * back later as the character's own message in this conversation, with a push.
 */
class KadeTask extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_task';
    this.description =
      'Take a bigger job into the background and come back with the answer: research, comparing options, reading several pages, working something out. ' +
      'You do the job yourself with your own tools, then your result arrives in this conversation as a message from you, and their phone gets a push. ' +
      'Always quote first (action quote), tell them the price in plain words, and start only after they say yes. One job at a time.';
    this.schema = kadeTaskSchema;
    this.req = fields.req;
    this.agentId = fields.agentId;
    this.agentName = fields.agentName;
  }

  async _call(data) {
    const tasks = require('~/server/services/kadeTasks');
    const action = String((data && data.action) || '');
    try {
      if (action === 'quote') {
        const q = await tasks.quote({ req: this.req, agentId: this.agentId, goal: data.goal, steps: data.steps });
        if (!q.ok) return this.refusal(q);
        return JSON.stringify({ quoteId: q.quoteId, steps: q.steps, tellThem: q.spoken });
      }
      if (action === 'start') {
        const s = await tasks.start({
          req: this.req,
          agentId: this.agentId,
          agentName: this.agentName,
          quoteId: data.quoteId,
          conversationId: this.req && this.req.body && this.req.body.conversationId,
        });
        if (!s.ok) return this.refusal(s);
        return JSON.stringify({
          taskId: s.taskId,
          started: true,
          tellThem:
            'It is running now. Tell them briefly that you are on it and that your answer will show up here as a message from you, with a notification. Do not do the job in this reply.',
        });
      }
      const userId = this.req && this.req.user && String(this.req.user.id);
      if (!userId) return 'Not available here.';
      if (action === 'list' || action === 'status') {
        const rows = await tasks.list({ userId, limit: action === 'status' ? 1 : 8 });
        const pick = data.taskId ? rows.filter((r) => r.taskId === data.taskId) : rows;
        return JSON.stringify({ tasks: pick });
      }
      if (action === 'cancel') {
        const c = await tasks.cancel({ userId, taskId: data.taskId });
        return JSON.stringify(c);
      }
      return 'Unknown action. Use quote, start, status, list or cancel.';
    } catch (e) {
      logger.warn('[KadeTask] ' + (e && e.message));
      return `The task service had a problem: ${String((e && e.message) || e).slice(0, 160)}. Tell them plainly; do not pretend it started.`;
    }
  }

  refusal(r) {
    if (r.soft) {
      /* Kids' accounts: never told they are restricted (Kade's standing rule). */
      return 'This one is not something you can send off in the background here. Offer to work on it together right now instead, in this conversation, and do not mention any rule.';
    }
    return `Not started: ${r.error}. Tell them plainly and do not pretend it is running.`;
  }
}

module.exports = KadeTask;
