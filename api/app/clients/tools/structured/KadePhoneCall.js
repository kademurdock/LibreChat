const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

// July 2 2026 round 3: guards against agent tool-loops (a live turn hit
// langgraph's recursion limit polling check_result 17 times, and dialed twice).
const _lastPlaced = new Map(); // userId -> ts of last successful place_call
const _lastChecked = new Map(); // userId -> ts of last check_result

const phoneCallJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['place_call', 'check_result', 'schedule_checkin', 'list_checkins', 'pause_checkin', 'cancel_checkin', 'test_checkin'],
      description:
        "'place_call' (default) dials a number. 'check_result' fetches the status and transcript of the user's most recent call (or a specific call_sid) so you can report back what was said. " +
        "The checkin actions manage FAMILY WELLNESS CALLS — recurring companion check-in calls to registered family members: 'schedule_checkin' creates/updates one (who + time required), 'list_checkins' shows the user's schedules, 'pause_checkin' pauses/resumes one, 'cancel_checkin' deletes one, 'test_checkin' places one RIGHT NOW so the user can hear it (use for the first-ever run — the user should experience a test to THEIR OWN number before family gets enrolled).",
    },
    to_number: {
      type: 'string',
      description:
        "Required for place_call. US/Canada phone number, 10 digits (e.g. '4175551234'). ALWAYS confirm the exact number with the user before calling.",
    },
    purpose: {
      type: 'string',
      description:
        "Required for place_call. Short plain-language reason for the call, phrased to complete the sentence \"I'm calling because ...\" (e.g. 'Kade wants to know if the pharmacy has her refill ready'). It is read aloud to whoever answers and guides the whole call — make it specific and include any facts the phone agent needs (names, order numbers, questions to ask).",
    },
    callee_name: {
      type: 'string',
      description:
        "ONLY set this if you genuinely know the name of the person or business being called (e.g. \"Tony's Pizza\", \"Gene\"). NEVER fill it with placeholders like 'whoever answers' or 'the person' — leave it out instead; the greeting adapts.",
    },
    call_sid: {
      type: 'string',
      description: 'Optional, for check_result: a specific call SID. Omit to get the most recent call.',
    },
    who: {
      type: 'string',
      description: "For schedule_checkin: the registered family member's NAME as Kade registered it (e.g. 'Skylee', 'Dad'). Check-ins can ONLY go to registered family numbers — the tool lists the registered names if the match fails.",
    },
    time: {
      type: 'string',
      description: "For schedule_checkin: call time, 24-hour US Central, 'HH:mm' (e.g. '10:30'). Scheduled check-ins only run between 08:00 and 21:00.",
    },
    days: {
      type: 'string',
      description: "For schedule_checkin: 'daily' (default) or comma-separated day names like 'mon,wed,fri'.",
    },
    topics: {
      type: 'string',
      description: "For schedule_checkin, optional: what the user wants woven into the calls or listened for (e.g. 'ask about his garden, make sure he's eating, remind him we love him').",
    },
    schedule_id: {
      type: 'string',
      description: 'For pause_checkin / cancel_checkin / test_checkin: the schedule id from list_checkins or schedule_checkin.',
    },
    call_as: {
      type: 'string',
      description:
        "HOST PRIVILEGE — works ONLY when you are Kiana. The NAME of another character who should place this call instead of you (their own voice and persona), e.g. call_as='Lilly' to have Lilly call Skylee. Any other character given this request must tell the user to ask Kiana — she is the host and the only one who can hand calls to the rest of the cast.",
    },
  },
  required: [],
};

/**
 * KadePhoneCall — places a real outbound phone call through the kade-ai-bridge.
 * The bridge runs the live conversation (streaming voice pipeline), enforces
 * caps (15 min hard limit, 4/user/day), records for QA, discloses AI +
 * recording to the callee, and bills actual Twilio cost to the requesting
 * user's Feed-the-Server tab via /api/kade/usage-event.
 */
class KadePhoneCall extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;
    this.userId = fields.userId;
    this.userName = fields.userName || fields.req?.user?.name || fields.req?.user?.username || 'a Kade-AI user';
    this.agentId = fields.agentId;
    this.agentName = fields.agentName || 'Kiana';
    this.isAdmin = fields.req?.user?.role === 'ADMIN';
    this.name = 'kade_phone_call';
    this.description =
      'Place a REAL outbound phone call from the Kade-AI phone line (+1 833-530-0313) to a person or business, on behalf of the current user. ' +
      'An AI voice agent speaks on the call following the purpose you provide. Costs real money (~1.5 cents/minute, billed to the user\'s tab), ' +
      'hard-capped at 15 minutes and 10 calls per user per day. ONLY use when the user explicitly asks for a call, and ALWAYS confirm the exact ' +
      'number and reason with them first. When confirming, ALSO tell the user (casually, not as a warning): the call will identify them by ' +
      "first name as the person who requested it, and the call's cost is added to their Feed the Server page.";
    this.description_for_model =
      this.description +
      ' After placing the call you get a confirmation only — the conversation happens live on the phone. Tell the user the call is underway. ' +
      "To report back what the callee said, call action='check_result' ONCE — it WAITS for the call to finish (up to ~1 minute) and returns the transcript. NEVER call check_result more than once in a turn, and never place the same call twice. " +
      "If it says the call is still in progress, tell the user you'll report when they ask, and END your reply. NEVER invent a call result — only report what the transcript actually says. " +
      'FAMILY WELLNESS CHECK-INS (schedule_checkin / list_checkins / pause_checkin / cancel_checkin / test_checkin): recurring companion calls to REGISTERED family only — you (this agent) make the call, chat warmly, and afterwards a detailed summary of how they seemed and what they said is delivered to the user as a nudge. ' +
      'Before creating or un-pausing a schedule: state the rough cost (about 5 to 10 cents per call — a daily schedule runs a few dollars a month) and get an explicit yes. For a FIRST-EVER setup, offer a test_checkin to the user so they can hear exactly what their family will hear. Calls run 08:00-21:00 Central only.';
    this.schema = phoneCallJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.bridgeSecret = process.env.BRIDGE_SECRET || '';
  }

  async _call(data) {
    if (!this.bridgeSecret) {
      return 'Phone calling is not configured on this server (missing BRIDGE_SECRET env var).';
    }
    const { action, to_number, purpose, callee_name, call_sid } = data || {};
    if (action === 'check_result') {
      const uid = String(this.userId || '');
      const lastCheck = _lastChecked.get(uid) || 0;
      if (Date.now() - lastCheck < 15000) {
        return (
          'STOP: you just checked. Do NOT call this tool again in this turn. ' +
          'Tell the user the call is still going and that you will report back when they ask. End your reply now.'
        );
      }
      _lastChecked.set(uid, Date.now());
      try {
        // waitSec: the BRIDGE waits for the call to wrap (up to ~50s) so one
        // check usually returns the finished transcript — the model must not poll.
        const r = await axios.post(
          `${this.bridgeUrl}/outbound/result`,
          { secret: this.bridgeSecret, userId: uid, callSid: call_sid || undefined, waitSec: 50 },
          { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } },
        );
        const d = r.data || {};
        if (!d.found) return 'No outbound calls found for this user yet.';
        if (d.status === 'in-progress') {
          return (
            `The call to ${d.calleeName || d.to} is still in progress after waiting (started ${d.startedSecondsAgo}s ago). ` +
            'STOP: do NOT call this tool again in this turn. Tell the user the call is running long and you will report back when they ask. End your reply now.'
          );
        }
        const lines = (d.transcript || [])
          .map((t) => `${t.role === 'assistant' ? 'Agent' : 'Callee'}: ${t.content}`)
          .join('\n');
        return (
          `Call ${d.callSid} to ${d.calleeName || d.to} — status: ${d.status}, duration ${d.durationSec}s.\n` +
          `Transcript:\n${lines || '(no speech captured)'}\n\n` +
          'Report the relevant answer(s) back to the user in your own words — only what the transcript actually says.'
        );
      } catch (err) {
        const msg = err?.response?.data?.error || err.message;
        logger.warn(`[KadePhoneCall] check_result failed: ${msg}`);
        return `Could not fetch the call result: ${msg}`;
      }
    }
    const WELLNESS_ACTIONS = ['schedule_checkin', 'list_checkins', 'pause_checkin', 'cancel_checkin', 'test_checkin'];
    if (WELLNESS_ACTIONS.includes(action)) {
      return await this._wellness(action, data);
    }
    if (!to_number || !purpose) {
      return "To place a call I need both to_number and purpose. (Or use action='check_result' to get the last call's transcript.)";
    }
    // KIANA-ONLY DELEGATION (July 12 2026, Kade: "she's the host"): Kiana may
    // hand a call to any other character; everyone else routes through her.
    const KIANA_ID = 'agent_6llV0eMu4fmIaj8f2x1Sb';
    let callAgentId = this.agentId;
    let callAgentName = this.agentName;
    const callAs = String(data?.call_as || '').trim();
    if (callAs && callAs.toLowerCase() !== String(this.agentName || '').toLowerCase()) {
      if (this.agentId !== KIANA_ID) {
        return (
          'Only Kiana can hand a call to another character — she is the host. ' +
          'Tell the user to ask Kiana (e.g. "Kiana, have ' + callAs + ' call...").'
        );
      }
      try {
        const mongoose = require('mongoose');
        const AgentModel = mongoose.models.Agent;
        const esc = callAs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found =
          (await AgentModel.findOne({ name: new RegExp('^' + esc + '$', 'i') }).lean()) ||
          (await AgentModel.findOne({ name: new RegExp(esc, 'i') }).lean());
        if (!found) {
          return `I couldn't find a character named "${callAs}" — check the name and try again.`;
        }
        callAgentId = found.id;
        callAgentName = found.name;
      } catch (err) {
        logger.warn(`[KadePhoneCall] call_as lookup failed: ${err.message}`);
        return `Couldn't look up "${callAs}" right now — try again in a moment.`;
      }
    }
    const uidPlace = String(this.userId || '');
    if (Date.now() - (_lastPlaced.get(uidPlace) || 0) < 30000) {
      return (
        'STOP: you already placed a call moments ago — do NOT dial again. ' +
        "Use action='check_result' (once) to get its result, or just tell the user the call is underway."
      );
    }
    try {
      const r = await axios.post(
        `${this.bridgeUrl}/outbound-call`,
        {
          to: to_number,
          purpose,
          calleeName: callee_name,
          userId: String(this.userId || ''),
          userName: this.userName,
          agentId: callAgentId,
          agentName: callAgentName,
          secret: this.bridgeSecret,
        },
        { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } },
      );
      const d = r.data || {};
      _lastPlaced.set(uidPlace, Date.now());
      return (
        `Call placed to ${d.to}${callAgentId !== this.agentId ? ` — ${callAgentName} is making this call in their own voice` : ''} — it is dialing now, capped at ${d.timeLimitMin} minutes. ` +
        `The user has ${d.callsLeftToday} outbound call(s) left today. The cost will appear on their Feed-the-Server tab after the call ends. ` +
        "Tell the user the call is underway and that you'll have the answer when they next check in. " +
        "IMPORTANT: on the user's NEXT message (even just 'hey' or 'well?'), run action='check_result' FIRST and report what the callee said before anything else."
      );
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadePhoneCall] call failed: ${msg}`);
      return `Could not place the call: ${msg}`;
    }
  }

  async _wellness(action, data) {
    const { who, time, days, topics, schedule_id } = data || {};
    const uid = String(this.userId || '');
    const hdrs = { 'User-Agent': 'Mozilla/5.0' };
    try {
      if (action === 'list_checkins') {
        const qs = this.isAdmin ? '' : `&userId=${encodeURIComponent(uid)}`;
        const r = await axios.get(`${this.bridgeUrl}/wellness?secret=${encodeURIComponent(this.bridgeSecret)}${qs}`, { timeout: 15000, headers: hdrs });
        const rows = (r.data && r.data.schedules) || [];
        if (!rows.length) {
          return 'No check-in schedules yet. Create one with schedule_checkin (who + time; days and topics optional).';
        }
        return rows
          .map((w) => `id ${w.id}: ${w.targetName} — ${w.days === 'daily' ? 'every day' : (Array.isArray(w.days) ? w.days.join('/') : w.days)} at ${w.time} Central with ${w.agentName}${w.topics ? ` (topics: ${w.topics})` : ''} — ${w.enabled ? 'ACTIVE' : 'PAUSED'}${w.lastRun ? `, last ran ${w.lastRun}` : ', never run yet'}${this.isAdmin ? ` [set up by ${w.enrolledBy && w.enrolledBy.userName}]` : ''}`)
          .join('\n');
      }
      if (action === 'schedule_checkin') {
        if (!who || !time) {
          return "schedule_checkin needs at least: who (a registered family member's name) and time ('HH:mm', 24-hour Central). Optional: days ('daily' or 'mon,wed,fri'), topics.";
        }
        const r = await axios.post(`${this.bridgeUrl}/wellness`, {
          secret: this.bridgeSecret,
          who,
          time,
          days: days || 'daily',
          topics: topics || '',
          agentId: this.agentId,
          agentName: this.agentName,
          enrolledBy: { userId: uid, userName: this.userName },
        }, { timeout: 15000, headers: hdrs });
        const w = r.data && r.data.schedule;
        return (
          `Check-in schedule created (id ${w.id}): I'll call ${w.targetName} ${w.days === 'daily' ? 'every day' : 'on ' + w.days.join(', ')} at ${w.time} Central, chat with them warmly, and deliver the user a detailed report afterwards (as a nudge, their chosen way). ` +
          'Each call costs roughly 5-10 cents, billed to the user\'s Feed the Server tab. ' +
          'If this is the user\'s FIRST schedule, strongly suggest a test_checkin with this id so they can hear one themselves before their family gets a call.'
        );
      }
      if (action === 'test_checkin') {
        if (!schedule_id) return 'test_checkin needs schedule_id (from list_checkins).';
        const r = await axios.post(`${this.bridgeUrl}/wellness/fire`, { secret: this.bridgeSecret, id: schedule_id }, { timeout: 35000, headers: hdrs });
        return `${(r.data && r.data.note) || 'Test call dialing now.'} Tell the user the phone should ring within seconds; after they hang up, the written report lands as a nudge a minute or two later (check_result also works for the raw transcript).`;
      }
      if (action === 'pause_checkin' || action === 'cancel_checkin') {
        if (!schedule_id) return `${action} needs schedule_id (from list_checkins).`;
        if (!this.isAdmin) {
          const check = await axios.get(`${this.bridgeUrl}/wellness?secret=${encodeURIComponent(this.bridgeSecret)}&userId=${encodeURIComponent(uid)}`, { timeout: 15000, headers: hdrs });
          if (!((check.data && check.data.schedules) || []).some((w) => w.id === schedule_id)) {
            return 'That schedule id does not belong to this user (list_checkins shows theirs).';
          }
        }
        if (action === 'cancel_checkin') {
          await axios.delete(`${this.bridgeUrl}/wellness?secret=${encodeURIComponent(this.bridgeSecret)}&id=${encodeURIComponent(schedule_id)}`, { timeout: 15000, headers: hdrs });
          return 'Check-in schedule cancelled. No more calls will be placed for it.';
        }
        const r = await axios.post(`${this.bridgeUrl}/wellness/toggle`, { secret: this.bridgeSecret, id: schedule_id }, { timeout: 15000, headers: hdrs });
        const w = r.data && r.data.schedule;
        return `Schedule ${schedule_id} is now ${w && w.enabled ? 'ACTIVE again' : 'PAUSED (no calls until resumed — run pause_checkin again to resume)'}.`;
      }
      return 'Unknown check-in action.';
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadePhoneCall] ${action} failed: ${msg}`);
      return `Could not complete ${action}: ${msg}`;
    }
  }
}

module.exports = KadePhoneCall;
