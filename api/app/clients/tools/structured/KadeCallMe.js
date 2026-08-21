const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const callMeJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['schedule_call', 'list_calls', 'cancel_call', 'pause_call', 'test_call'],
      description:
        "What to do. 'schedule_call' sets up a future RING on the user's phone that answers straight into a live voice call with YOU — one-off (in_minutes, or fire_date+fire_time) or recurring (recurring_time, optional recurring_days). " +
        "'list_calls' shows their scheduled calls. 'cancel_call' removes one. 'pause_call' pauses/resumes one. 'test_call' rings their phone RIGHT NOW with an existing plan so they can hear the ringtone and try answering — offer it after a first setup.",
    },
    purpose: {
      type: 'string',
      description:
        "REQUIRED for schedule_call. WHY you are calling, in plain words — it is spoken in the ring announcement and you open the call knowing it (e.g. 'morning meds check-in', 'wake-up call', 'ask how the appointment went'). Keep it under ~200 characters.",
    },
    in_minutes: {
      type: 'number',
      description: "For a one-off call: ring this many minutes from now (e.g. 90). Use this OR fire_date+fire_time, not both.",
    },
    fire_date: {
      type: 'string',
      description:
        "For a one-off call (with fire_time): the calendar date to ring, US Central, as 'YYYY-MM-DD'. THE DATE LAW: compute the REAL date from today's date — never pass words like 'tomorrow'.",
    },
    fire_time: {
      type: 'string',
      description: "For a one-off call (with fire_date): the time that day, 24-hour US Central 'HH:mm'.",
    },
    recurring_time: {
      type: 'string',
      description: "For a recurring call: the time to ring, 24-hour US Central 'HH:mm' (e.g. '08:00' for a daily morning call).",
    },
    recurring_days: {
      type: 'string',
      description: "For a recurring call: 'daily' (default) or comma-separated day names like 'mon,wed,fri'.",
    },
    ringtone: {
      type: 'string',
      enum: ['ring_classic', 'ring_marimba', 'ring_chimes', 'ring_pulse', 'ring_harp'],
      description:
        "Optional ringtone for THIS call plan: ring_classic (a classic telephone bell), ring_marimba (warm wooden notes), ring_chimes (bright bells), ring_pulse (a soft modern pulse), ring_harp (a gentle rising sweep). Omit it to use the default from their app Settings.",
    },
    override_quiet_hours: {
      type: 'boolean',
      description:
        "Set true ONLY after the user explicitly says yes to ringing during quiet hours (9pm-8am Central) — e.g. a wake-up call. If the tool warns the time falls in quiet hours, ASK them, then re-schedule with this set true if they agree. Never assume.",
    },
    plan_id: {
      type: 'string',
      description: 'For cancel_call / pause_call / test_call: the id from list_calls or schedule_call.',
    },
  },
  required: [],
};

/**
 * KadeCallMe — schedule a real RING on the user's own phone that answers into
 * a live streaming voice call with this agent, primed on why it called
 * (Part 75 §2, Aug 21 2026 — "the ability to have agents like Kiana call you
 * from the app"). Everything routes through the kade-ai-bridge, which enforces
 * the guardrails server-side (per-user daily ring caps, quiet hours with the
 * user's own per-plan override, plan limits) that no agent can bypass.
 * Authenticates with the SCOPED NOTIFY_AGENT_SECRET, never the admin secret.
 */
class KadeCallMe extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.userName = fields.userName || fields.req?.user?.name || fields.req?.user?.username || 'the user';
    this.agentId = fields.agentId;
    this.agentName = fields.agentName || 'Kade-AI';
    this.name = 'kade_call_me';
    this.description =
      "Schedule a real phone-style CALL from you to the user: at the planned moment their Kade-AI app RINGS with a real ringtone, they tap Answer, and they're in a live voice call with you — and you already know why you called. " +
      'For reminders they want to HEAR you say, wake-up calls, scheduled check-ins by voice, or any moment they ask you to call them. Server-side caps and quiet hours apply and cannot be bypassed. ' +
      "This is different from kade_notify: notify is a silent lock-screen text; kade_call_me actually rings and becomes a conversation.";
    this.description_for_model =
      this.description +
      ' THE ORDER MATTERS, AND IT IS NOT OPTIONAL: call schedule_call FIRST, read what it returns, and only THEN tell them it is set. If you have not seen the tool answer "Call scheduled (id ...)" in this very turn, no call exists, and saying "done" or "I\'ll call you at 8" is false — someone will plan their morning around a phone that never rings. If you cannot schedule it, say so plainly and why. ' +
      "THE DATE LAW: this tool stores absolute datetimes only. Compute fire_date ('YYYY-MM-DD') and fire_time ('HH:mm' Central) from today's real date — never store or pass relative words like 'tomorrow'. " +
      'AFTER scheduling, read the confirmation back to them naturally: who is calling, the exact day and time in plain words, why, and which ringtone. ' +
      "If the tool returns a QUIET-HOURS warning, the phone will NOT ring at that time unless they override — ASK them ('want me to ring through quiet hours for this one?') and only re-schedule with override_quiet_hours:true on their explicit yes. A wake-up call usually needs it; everything else usually doesn't. " +
      "Offer a test_call after a first-ever setup so they can hear the ringtone and practice answering. If they miss a scheduled call, they get a follow-up note automatically — you don't need to do anything. " +
      'Only schedule calls the user actually asked for, and never more than they asked for.';
    this.schema = callMeJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.notifySecret = process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '';
  }

  _hdrs() {
    return { 'x-notify-secret': this.notifySecret, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };
  }

  _describeWhen(plan) {
    if (plan.recurring && plan.recurring.time) {
      const days = plan.recurring.days === 'daily' ? 'every day' : 'on ' + (Array.isArray(plan.recurring.days) ? plan.recurring.days.join(', ') : plan.recurring.days);
      return `${days} at ${plan.recurring.time} Central`;
    }
    return plan.fireAtCentral || plan.fireAt || 'the scheduled time';
  }

  async _call(data) {
    if (!this.notifySecret) {
      return 'Calls are not configured on this server (missing NOTIFY_AGENT_SECRET).';
    }
    const action = (data && data.action) || 'schedule_call';
    const uid = String(this.userId || '');
    try {
      if (action === 'list_calls') {
        const r = await axios.get(`${this.bridgeUrl}/call-plans?userId=${encodeURIComponent(uid)}`, { timeout: 15000, headers: this._hdrs() });
        const rows = (r.data && r.data.plans) || [];
        if (!rows.length) return 'No scheduled calls. Create one with schedule_call (needs a purpose and a time).';
        return rows
          .map((p) => `id ${p.id}: ${p.agentName} calls ${this._describeWhen(p)} about "${p.purpose}"${p.ringtone ? ` (ringtone ${p.ringtone})` : ''}${p.overrideQuiet ? ' [rings through quiet hours]' : ''} — ${p.enabled === false ? 'PAUSED' : 'ACTIVE'}`)
          .join('\n');
      }
      if (action === 'schedule_call') {
        const purpose = String((data && data.purpose) || '').trim();
        if (!purpose) return "schedule_call needs a 'purpose' — you must know why you're calling; it is announced in the ring and you open the call with it.";
        const body = {
          userId: uid,
          userName: this.userName,
          agentId: this.agentId,
          agentName: this.agentName,
          purpose,
          ringtone: data.ringtone || undefined,
          override_quiet: data.override_quiet_hours === true,
        };
        if (data.recurring_time) {
          body.recurring = { time: String(data.recurring_time), days: data.recurring_days ? String(data.recurring_days).split(',').map((d) => d.trim()) : 'daily' };
          if (data.recurring_days === 'daily') body.recurring.days = 'daily';
        } else if (data.in_minutes) {
          body.in_minutes = Number(data.in_minutes);
        } else if (data.fire_date && data.fire_time) {
          body.fire_date = String(data.fire_date);
          body.fire_time = String(data.fire_time);
        } else {
          return "schedule_call needs a time: 'in_minutes' (e.g. 90), or 'fire_date' (YYYY-MM-DD — compute the real date) + 'fire_time' (HH:mm Central), or 'recurring_time' for a repeating call.";
        }
        const r = await axios.post(`${this.bridgeUrl}/call-plans`, body, { timeout: 15000, headers: this._hdrs() });
        const d = r.data || {};
        const plan = d.plan;
        if (!plan) return `Scheduling result unclear: ${JSON.stringify(d).slice(0, 200)}. Do not claim the call is set.`;
        let out = `Call scheduled (id ${plan.id}): ${plan.agentName} will ring ${this.userName}'s phone ${this._describeWhen(plan)} about "${plan.purpose}", ringtone ${plan.ringtone || 'their app default'}. Read this back to them naturally — who, when, why, and the ringtone.`;
        if (d.quietWarning) out += ` ⚠ ${d.quietWarning}`;
        else out += ' Offer a test_call so they can hear the ring and practice answering, especially on a first setup.';
        return out;
      }
      if (action === 'test_call') {
        if (!data.plan_id) return 'test_call needs plan_id (from list_calls or schedule_call).';
        const r = await axios.post(`${this.bridgeUrl}/call-plans/fire`, { id: String(data.plan_id) }, { timeout: 30000, headers: this._hdrs() });
        const d = r.data || {};
        if (d.ok && d.sent > 0) return `Their phone is ringing right now (${d.ringtone}). When they tap Answer they'll land in a live call with you.`;
        if (d.blocked) return `The test ring was blocked — ${d.blocked}. Say so plainly.`;
        if (d.ok && d.sent === 0) return 'No phone is linked for calls yet — ask them to open the Kade-AI app once (a recent version) so it can register, then try again.';
        return `Test result unclear: ${JSON.stringify(d).slice(0, 160)}. Do not claim it rang.`;
      }
      if (action === 'pause_call') {
        if (!data.plan_id) return 'pause_call needs plan_id (from list_calls).';
        const r = await axios.post(`${this.bridgeUrl}/call-plans/toggle`, { id: String(data.plan_id) }, { timeout: 15000, headers: this._hdrs() });
        const p = r.data && r.data.plan;
        return `Call plan ${data.plan_id} is now ${p && p.enabled ? 'ACTIVE again' : 'PAUSED (no rings until resumed — run pause_call again to resume)'}.`;
      }
      if (action === 'cancel_call') {
        if (!data.plan_id) return 'cancel_call needs plan_id (from list_calls).';
        await axios.delete(`${this.bridgeUrl}/call-plans?id=${encodeURIComponent(String(data.plan_id))}`, { timeout: 15000, headers: this._hdrs() });
        return 'Call plan cancelled. That phone will not ring for it.';
      }
      return `Unknown action "${action}". Use schedule_call, list_calls, cancel_call, pause_call, or test_call.`;
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadeCallMe] ${action} failed: ${msg}`);
      return `Could not complete ${action}: ${msg}. Do not claim anything was scheduled or rung.`;
    }
  }
}

module.exports = KadeCallMe;
