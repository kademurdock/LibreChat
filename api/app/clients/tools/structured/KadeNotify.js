const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const notifyJsonSchema = {
  type: 'object',
  properties: {
    body: {
      type: 'string',
      description:
        "REQUIRED. The notification text shown on the user's phone lock screen. Keep it short and clear (under ~200 characters), written the way you would text them.",
    },
    title: {
      type: 'string',
      description:
        "Optional short title / sender line (a few words). Defaults to your name. Examples: 'Reminder', 'Ki'.",
    },
    urgent: {
      type: 'boolean',
      description:
        "Optional. Set true ONLY for genuinely time-sensitive alerts — urgent notifications bypass the user's quiet hours (9pm to 8am Central). Use very sparingly; leave off for normal reminders.",
    },
  },
  required: ['body'],
};

/**
 * KadeNotify — send a push notification to the user's own iPhone through the
 * kade-ai-bridge /notify primitive. The BRIDGE enforces anti-spam guardrails
 * server-side (quiet hours, per-agent + global daily caps, a cooldown, and
 * mute controls) that NO agent can bypass, so this tool cannot spam the user.
 * Authenticates with the SCOPED NOTIFY_AGENT_SECRET (never the admin
 * BRIDGE_SECRET) — a leak of it can at most fire rate-capped, guardrailed pushes.
 */
class KadeNotify extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.userName = fields.userName || fields.req?.user?.name || fields.req?.user?.username || 'the user';
    this.agentId = fields.agentId;
    this.agentName = fields.agentName || 'Kade-AI';
    this.name = 'kade_notify';
    this.description =
      "Send a push notification to the user's own phone (their Kade-AI app). Use ONLY when the user asked to be pinged or reminded on their phone, " +
      'or to tell them a background job you were running has finished. The message lands on their lock screen. ' +
      'The server enforces quiet hours (9pm to 8am), a cooldown, and daily caps, so keep notifications meaningful, not chatter. ' +
      'Do NOT use this to duplicate something you just said in chat unless the user explicitly asked to be notified on their phone.';
    this.description_for_model =
      this.description +
      " Write the 'body' in your own voice, short and plain (under ~200 chars). The tool tells you whether it ACTUALLY sent: " +
      'if it reports blocked (quiet hours, cooldown, or a cap) or that no phone is registered, say so plainly and do NOT claim you notified them. ' +
      'NEVER say you sent a notification unless the tool confirms it sent. Only set urgent:true for truly time-critical alerts (it overrides quiet hours).';
    this.schema = notifyJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    // Prefer the SCOPED agent secret; fall back to BRIDGE_SECRET only if the
    // scoped one is unset (misconfig) so the tool never silently hard-breaks.
    this.notifySecret = process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '';
  }

  async _call(data) {
    if (!this.notifySecret) {
      return 'Notifications are not configured on this server (missing NOTIFY_AGENT_SECRET).';
    }
    const body = String((data && data.body) || '').trim();
    if (!body) {
      return "I need the notification text (the 'body') to send.";
    }
    const title = String((data && data.title) || this.agentName || 'Kade-AI').slice(0, 40);
    const urgent = Boolean(data && data.urgent);
    try {
      const r = await axios.post(
        `${this.bridgeUrl}/notify`,
        {
          secret: this.notifySecret,
          agentId: this.agentId || 'unknown',
          agentName: this.agentName,
          title,
          body: body.slice(0, 300),
          urgent,
        },
        { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } },
      );
      const d = r.data || {};
      if (d.ok && d.sent > 0) {
        return `Notification delivered to the user's phone (${d.sent} device${d.sent === 1 ? '' : 's'}). You can let them know it is on their phone.`;
      }
      if (d.blocked) {
        const tip = /quiet/.test(String(d.blocked)) ? ' You can retry after 8am, or set urgent:true only if it is truly time-critical.' : '';
        return `Not sent — ${d.blocked}. Tell the user plainly and do NOT claim you notified them.${tip}`;
      }
      if (d.ok && d.sent === 0) {
        return "The user's phone is not registered for notifications yet (no device token). Ask them to open the Kade-AI app once so it can register, then try again.";
      }
      return `Notification result unclear: ${JSON.stringify(d).slice(0, 200)}. Do not claim it was sent.`;
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadeNotify] failed: ${msg}`);
      return `Could not send the notification: ${msg}. Do not claim it was sent.`;
    }
  }
}

module.exports = KadeNotify;
