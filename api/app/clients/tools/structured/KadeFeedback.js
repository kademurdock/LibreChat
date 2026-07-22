const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const feedbackSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['file', 'reopen'],
      description:
        "'file' (default) = submit a new report. 'reopen' = the user says a previously " +
        'fixed/closed issue is STILL happening (e.g. "it\'s still broken", "reopen it", ' +
        '"that bug came back") — reopens their most recently closed report and puts it ' +
        "back on Kade's list.",
    },
    reason: {
      type: 'string',
      description:
        "Only for action:'reopen' — what the user said about why it needs reopening " +
        '(what is still broken, in their words). Optional but include it when they said anything.',
    },
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
  required: [],
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
      'File a bug report, feature request, or feedback to Kade (the platform owner) on behalf of the user — ' +
      'or REOPEN one of their closed reports. ' +
      'Use this when a user mentions something broken, frustrating, or asks for a feature — offer to log it first ' +
      '("Want me to send that to Kade for you?"), then call this tool with their description. ' +
      "If the user says an issue that was marked solved is STILL happening (\"it's still broken\", \"reopen it\"), " +
      "call with action:'reopen' — that flips their most recent closed report back to open on Kade's list. " +
      'The report is attributed to the user so Kade can follow up. Free, instant, no cost. ' +
      "NEVER file a report without the user's OK; NEVER invent details they didn't give you.";
    this.schema = feedbackSchema;
  }

  async _call(data) {
    const { action, category, subject, detail, reason } = data || {};
    if (action === 'reopen') {
      return this._reopen(reason || detail);
    }
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
      /* Session 23: owner alert — in-chat nudge + app push to Kade the
       * moment a report lands. Fire-and-forget; a hiccup never breaks
       * the filing (the service is fail-soft end to end). */
      try {
        const { alertOwnerNewFeedback } = require('~/server/services/kadeOwnerAlerts');
        alertOwnerNewFeedback(report).catch(() => {});
      } catch (_) {
        /* non-fatal */
      }
      return `Report filed. Category: ${validCat}. Kade will see it in the feedback dashboard. Thank you for taking the time to share this.`;
    } catch (err) {
      logger.error(`[KadeFeedback] failed to file report: ${err.message}`);
      return `I couldn't file that report right now — something went wrong on the server side. The error was: ${err.message}`;
    }
  }

  /**
   * Session 23 — the other half of the resolved-relay loop: when Kade marks a
   * report solved, the reporter gets nudged ("say 'reopen it' if it's still
   * broken") — this is the reopen. Most recent CLOSED report for THIS user
   * flips back to 'open' with a dated note appended, so it lands back in
   * Kade's dashboard pile with the user's reason attached.
   */
  async _reopen(reason) {
    try {
      const { KadeFeedback } = require('~/models/kadeFeedback');
      const doc = await KadeFeedback.findOne({
        user: this.userId,
        status: { $in: ['resolved', 'wontfix', 'acknowledged'] },
      }).sort({ updatedAt: -1 });
      if (!doc) {
        return (
        'I could not find a closed report of yours to reopen. If something is broken, ' +
        'describe it and I can file a fresh report instead.'
        );
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const why = reason && String(reason).trim() ? `: ${String(reason).trim().slice(0, 500)}` : '';
      const note = `\n\n[Reopened by user via ${this.agentName} ${stamp}${why}]`;
      doc.detail = `${doc.detail || ''}${note}`.slice(0, 8000);
      doc.status = 'open';
      await doc.save();
      logger.info(
        `[KadeFeedback] report ${doc._id} REOPENED by user ${this.userId} via ${this.agentName}`,
      );
      return (
        `Reopened: "${doc.subject}" is back on Kade's list as an open ${doc.category}. ` +
        'If anything changed about how it happens, tell me and I can pass that along too.'
      );
    } catch (err) {
      logger.error(`[KadeFeedback] reopen failed: ${err.message}`);
      return `I couldn't reopen that right now — something went wrong server-side: ${err.message}`;
    }
  }
}

module.exports = KadeFeedback;
