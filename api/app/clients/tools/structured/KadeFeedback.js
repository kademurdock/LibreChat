const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const feedbackSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['bug', 'feature', 'feedback'],
      description:
        "What kind of report this is. 'bug' = something broken or not working right. " +
        "'feature' = something the user wishes existed. 'feedback' = a general thought, " +
        "compliment, or suggestion that doesn't fit the other two. Default 'feedback'.",
    },
    subject: {
      type: 'string',
      description:
        'A short title for the report, 3-10 words. Summarize what the user said — e.g. ' +
        "\"Game table not loading on mobile\" or \"Wish I could change Kiana's voice mid-chat\".",
    },
    detail: {
      type: 'string',
      description:
        "The full description of the issue or request, in the user's own words as best you " +
        'can capture them. Include what they were trying to do, what happened instead, and any ' +
        'details they mentioned (which page, which agent, what device). This goes straight to ' +
        'Kade — the platform owner — so make it clear and complete.',
    },
  },
  required: ['detail'],
};

/**
 * KadeFeedback — lets any agent file a bug report, feature request, or
 * general feedback to Kade (the platform owner) on behalf of the user.
 * The user just talks naturally; the agent offers to log it and calls this
 * tool. Reports are attributed to the logged-in user so Kade can follow up.
 *
 * No external API call, no cost. Writes directly to the kadefeedback Mongo
 * collection via the KadeFeedback model.
 */
class KadeFeedback extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.agentName = fields.agentName || 'Agent';
    this.name = 'kade_feedback';
    this.description =
      "File a bug report, feature request, or feedback to Kade (the platform owner) on behalf of the user. " +
      "Use this when a user mentions something broken, frustrating, or asks for a feature — offer to log it first " +
      '(\\"Want me to send that to Kade for you?\\"), then call this tool with their description. ' +
      "The report is attributed to the user so Kade can follow up. Free, instant, no cost. " +
      "NEVER file a report without the user's OK; NEVER invent details they didn't give you.";
    this.schema = feedbackSchema;
  }

  async _call(data) {
    const { category, subject, detail } = data || {};
    if (!detail || !String(detail).trim()) {
      return 'I need a description of the issue to file a report.';
    }
    try {
      const { KadeFeedback } = require('~/models/kadeFeedback');
      const validCat = ['bug', 'feature', 'feedback'].includes(category) ? category : 'feedback';
      const report = await KadeFeedback.create({
        user: this.userId,
        category: validCat,
        subject: String(subject || '').trim().slice(0, 200) || String(detail).trim().slice(0, 80),
        detail: String(detail).trim().slice(0, 8000),
        agent: this.agentName,
        surface: 'chat',
        status: 'open',
      });
      logger.info(`[KadeFeedback] report ${report._id} filed by user ${this.userId} via ${this.agentName}: ${report.subject}`);
      return `Report filed. Category: ${validCat}. Kade will see it in the feedback dashboard. Thank you for taking the time to share this.`;
    } catch (err) {
      logger.error(`[KadeFeedback] failed to file report: ${err.message}`);
      return `I couldn't file that report right now — something went wrong on the server side. The error was: ${err.message}`;
    }
  }
}

module.exports = KadeFeedback;
