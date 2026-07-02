const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const phoneCallJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['place_call', 'check_result'],
      description:
        "'place_call' (default) dials a number. 'check_result' fetches the status and transcript of the user's most recent call (or a specific call_sid) so you can report back what was said.",
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
    this.name = 'kade_phone_call';
    this.description =
      'Place a REAL outbound phone call from the Kade-AI phone line (+1 833-530-0313) to a person or business, on behalf of the current user. ' +
      'An AI voice agent speaks on the call following the purpose you provide. Costs real money (~1.5 cents/minute, billed to the user\'s tab), ' +
      'hard-capped at 15 minutes and 10 calls per user per day. ONLY use when the user explicitly asks for a call, and ALWAYS confirm the exact ' +
      'number and reason with them first. Never call emergency services, never harass anyone, never redial the same number repeatedly.';
    this.description_for_model =
      this.description +
      ' After placing the call you get a confirmation only — the conversation happens live on the phone. Tell the user the call is underway. ' +
      "When the call ends, use action='check_result' to fetch the transcript and REPORT BACK what the callee said — if the user asked you to find something out, checking and reporting is part of the job, do not just stop after dialing. " +
      "If check_result says the call is still in progress, tell the user and check again when they ask (or after a bit). NEVER invent a call result — only report what the transcript actually says.";
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
      try {
        const r = await axios.post(
          `${this.bridgeUrl}/outbound/result`,
          { secret: this.bridgeSecret, userId: String(this.userId || ''), callSid: call_sid || undefined },
          { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } },
        );
        const d = r.data || {};
        if (!d.found) return 'No outbound calls found for this user yet.';
        if (d.status === 'in-progress') {
          return `The call to ${d.calleeName || d.to} is still in progress (started ${d.startedSecondsAgo}s ago). Check again shortly.`;
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
    if (!to_number || !purpose) {
      return "To place a call I need both to_number and purpose. (Or use action='check_result' to get the last call's transcript.)";
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
          agentId: this.agentId,
          agentName: this.agentName,
          secret: this.bridgeSecret,
        },
        { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } },
      );
      const d = r.data || {};
      return (
        `Call placed to ${d.to} — it is dialing now, capped at ${d.timeLimitMin} minutes. ` +
        `The user has ${d.callsLeftToday} outbound call(s) left today. The cost will appear on their Feed-the-Server tab after the call ends.`
      );
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadePhoneCall] call failed: ${msg}`);
      return `Could not place the call: ${msg}`;
    }
  }
}

module.exports = KadePhoneCall;
