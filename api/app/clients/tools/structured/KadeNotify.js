const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const notifyJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['send', 'schedule_checkin', 'list_checkins', 'pause_checkin', 'cancel_checkin', 'test_checkin'],
      description:
        "What to do. 'send' (default) pushes a notification to the user's phone RIGHT NOW. The others manage RECURRING CHECK-INS where YOU reach out to the user on a schedule: 'schedule_checkin' creates/updates one (needs time), 'list_checkins' lists the user's, 'pause_checkin' pauses/resumes one, 'cancel_checkin' deletes one, 'test_checkin' fires one immediately so they can hear it. Only set up a check-in when the user asks you to.",
    },
    body: {
      type: 'string',
      description:
        "REQUIRED for action='send'. The notification text shown on the user's phone lock screen. Keep it short and clear (under ~200 characters), written the way you would text them.",
    },
    title: {
      type: 'string',
      description: "Optional short title / sender line (a few words). Defaults to your name. Examples: 'Reminder', 'Ki'.",
    },
    urgent: {
      type: 'boolean',
      description:
        "Optional (action='send'). Set true ONLY for genuinely time-sensitive alerts — they bypass quiet hours (9pm-8am Central). Use very sparingly.",
    },
    time: {
      type: 'string',
      description:
        "For schedule_checkin: the daily time to reach out, 24-hour US Central 'HH:mm' (e.g. '18:00'). Must be a daytime/evening time — roughly 8am to 9pm; quiet hours are not allowed.",
    },
    days: {
      type: 'string',
      description: "For schedule_checkin: 'daily' (default) or comma-separated day names like 'mon,wed,fri'.",
    },
    topic: {
      type: 'string',
      description:
        "For schedule_checkin, optional: what to weave into the check-in (e.g. 'ask how her writing is going, remind her to stretch').",
    },
    schedule_id: {
      type: 'string',
      description: 'For pause_checkin / cancel_checkin / test_checkin: the id from list_checkins or schedule_checkin.',
    },
  },
  required: [],
};

/**
 * KadeNotify — send a push notification to the user's own iPhone (action='send'),
 * OR manage recurring "check in on me" schedules where this agent reaches out on
 * its own (schedule_checkin / list_checkins / pause_checkin / cancel_checkin /
 * test_checkin). Everything routes through the kade-ai-bridge, which enforces
 * anti-spam guardrails server-side (quiet hours, per-agent + global daily caps,
 * cooldown, mute) that no agent can bypass. Authenticates with the SCOPED
 * NOTIFY_AGENT_SECRET, never the admin BRIDGE_SECRET.
 */
class KadeNotify extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.userName = fields.userName || fields.req?.user?.name || fields.req?.user?.username || 'the user';
    this.agentId = fields.agentId;
    this.agentName = fields.agentName || 'Kade-AI';
    this.isAdmin = fields.req?.user?.role === 'ADMIN';
    this.name = 'kade_notify';
    this.description =
      "Send a push notification to the user's own phone (their Kade-AI app), or set up a recurring check-in where YOU reach out to them on a schedule. " +
      "Use 'send' when the user asked to be pinged/reminded on their phone or to report a finished background job. Use the check-in actions when the user asks you to check in on them regularly (e.g. 'text me every evening'). " +
      'The server enforces quiet hours (9pm-8am), a cooldown, and daily caps, so keep notifications meaningful, not chatter. ' +
      'Do NOT duplicate something you just said in chat unless the user asked to be notified on their phone.';
    this.description_for_model =
      this.description +
      " For 'send', write the 'body' in your own voice, short and plain (under ~200 chars). The tool tells you whether it ACTUALLY sent: if it reports blocked (quiet hours, cooldown, cap) or that no phone is registered, say so plainly and do NOT claim you notified them. NEVER claim you sent or scheduled anything unless the tool confirms it. " +
      "For a recurring check-in, use action='schedule_checkin' with a 'time' (and optional 'days'/'topic'); confirm the time with the user first. Offer a 'test_checkin' so they can hear one. Only set urgent:true for truly time-critical alerts.";
    this.schema = notifyJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.notifySecret = process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '';
  }

  _hdrs() {
    return { 'x-notify-secret': this.notifySecret, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };
  }

  async _call(data) {
    if (!this.notifySecret) {
      return 'Notifications are not configured on this server (missing NOTIFY_AGENT_SECRET).';
    }
    const action = (data && data.action) || 'send';
    if (action === 'send') {
      return await this._send(data || {});
    }
    const SCHED = ['schedule_checkin', 'list_checkins', 'pause_checkin', 'cancel_checkin', 'test_checkin'];
    if (SCHED.includes(action)) {
      return await this._schedule(action, data || {});
    }
    return `Unknown action "${action}". Use 'send' or a check-in action.`;
  }

  async _send(data) {
    const body = String(data.body || '').trim();
    if (!body) {
      return "I need the notification text (the 'body') to send.";
    }
    const title = String(data.title || this.agentName || 'Kade-AI').slice(0, 40);
    const urgent = Boolean(data.urgent);
    try {
      const r = await axios.post(
        `${this.bridgeUrl}/notify`,
        { secret: this.notifySecret, agentId: this.agentId || 'unknown', agentName: this.agentName, title, body: body.slice(0, 300), urgent, userId: this.userId },
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
      logger.warn(`[KadeNotify] send failed: ${msg}`);
      return `Could not send the notification: ${msg}. Do not claim it was sent.`;
    }
  }

  async _schedule(action, data) {
    // Device tokens are linked to individual users (bridge /push-register +
    // /outreach target only the requesting user's own device — see kade-ai-bridge
    // July 2026 multi-user push targeting), so every user can manage their own
    // check-ins now, not just the account owner.
    const uid = String(this.userId || '');
    const { time, days, topic, schedule_id } = data;
    try {
      if (action === 'list_checkins') {
        const r = await axios.get(`${this.bridgeUrl}/outreach?userId=${encodeURIComponent(uid)}`, { timeout: 15000, headers: this._hdrs() });
        const rows = (r.data && r.data.schedules) || [];
        if (!rows.length) {
          return 'No check-in schedules yet. Create one with schedule_checkin (needs a time; days and topic optional).';
        }
        return rows
          .map((o) => `id ${o.id}: ${o.agentName} checks in ${o.days === 'daily' ? 'every day' : (Array.isArray(o.days) ? o.days.join('/') : o.days)} at ${o.time} Central${o.topic ? ` (about: ${o.topic})` : ''} — ${o.enabled ? 'ACTIVE' : 'PAUSED'}${o.lastRun ? `, last ran ${o.lastRun}` : ', never run yet'}`)
          .join('\n');
      }
      if (action === 'schedule_checkin') {
        if (!time) {
          return "schedule_checkin needs a time ('HH:mm', 24-hour Central, e.g. '18:00'). Optional: days ('daily' or 'mon,wed,fri') and topic.";
        }
        const r = await axios.post(
          `${this.bridgeUrl}/outreach`,
          { agentId: this.agentId, agentName: this.agentName, userId: uid, userName: this.userName, time, days: days || 'daily', topic: topic || '', title: this.agentName },
          { timeout: 15000, headers: this._hdrs() },
        );
        const o = r.data && r.data.schedule;
        return (
          `Check-in scheduled (id ${o.id}): I'll reach out ${o.days === 'daily' ? 'every day' : 'on ' + (Array.isArray(o.days) ? o.days.join(', ') : o.days)} at ${o.time} Central with a short warm note to their phone` +
          `${o.topic ? `, working in: ${o.topic}` : ''}. It rides the same quiet-hours and daily caps as every notification. ` +
          'Offer a test_checkin with this id so they can hear one right now.'
        );
      }
      if (action === 'test_checkin') {
        if (!schedule_id) return 'test_checkin needs schedule_id (from list_checkins or schedule_checkin).';
        const r = await axios.post(`${this.bridgeUrl}/outreach/fire`, { id: schedule_id, urgent: true }, { timeout: 30000, headers: this._hdrs() });
        const d = r.data || {};
        if (d.ok && d.delivery && d.delivery.sent > 0) return `Test check-in sent to their phone now: "${d.generated}"`;
        if (d.delivery && d.delivery.blocked) return `Generated "${d.generated}" but it was not delivered — ${d.delivery.blocked}.`;
        if (d.ok && d.delivery && d.delivery.sent === 0) return `Generated "${d.generated}" but no phone is registered yet — ask them to open the app once.`;
        return `Could not run the test: ${d.error || JSON.stringify(d).slice(0, 160)}`;
      }
      if (action === 'pause_checkin') {
        if (!schedule_id) return 'pause_checkin needs schedule_id (from list_checkins).';
        const r = await axios.post(`${this.bridgeUrl}/outreach/toggle`, { id: schedule_id }, { timeout: 15000, headers: this._hdrs() });
        const o = r.data && r.data.schedule;
        return `Schedule ${schedule_id} is now ${o && o.enabled ? 'ACTIVE again' : 'PAUSED (no check-ins until resumed — run pause_checkin again to resume)'}.`;
      }
      if (action === 'cancel_checkin') {
        if (!schedule_id) return 'cancel_checkin needs schedule_id (from list_checkins).';
        await axios.delete(`${this.bridgeUrl}/outreach?id=${encodeURIComponent(schedule_id)}`, { timeout: 15000, headers: this._hdrs() });
        return 'Check-in schedule cancelled. No more scheduled reach-outs for it.';
      }
      return 'Unknown check-in action.';
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadeNotify] ${action} failed: ${msg}`);
      return `Could not complete ${action}: ${msg}`;
    }
  }
}

module.exports = KadeNotify;
