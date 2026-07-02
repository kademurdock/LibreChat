const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const phoneCallJsonSchema = {
  type: 'object',
  properties: {
    to_number: {
      type: 'string',
      description:
        "US/Canada phone number to call, 10 digits (e.g. '4175551234'). ALWAYS confirm the exact number with the user before calling.",
    },
    purpose: {
      type: 'string',
      description:
        "Short plain-language reason for the call, phrased to complete the sentence \"I'm calling because ...\" (e.g. 'Kade wants to know if the pharmacy has her refill ready'). It is read aloud to whoever answers and guides the whole call — make it specific and include any facts the phone agent needs (names, order numbers, questions to ask).",
    },
    callee_name: {
      type: 'string',
      description: "Optional: name of the person or business being called (e.g. \"Tony's Pizza\"), used in the greeting.",
    },
  },
  required: ['to_number', 'purpose'],
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
      'hard-capped at 15 minutes and 4 calls per user per day. ONLY use when the user explicitly asks for a call, and ALWAYS confirm the exact ' +
      'number and reason with them first. Never call emergency services, never harass anyone, never redial the same number repeatedly.';
    this.description_for_model =
      this.description +
      ' After placing the call you get a confirmation only — the conversation happens live on the phone and you will NOT see its transcript here. ' +
      'Tell the user the call is underway. A recording and transcript are kept for quality review (admin can fetch them from the bridge).';
    this.schema = phoneCallJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.bridgeSecret = process.env.BRIDGE_SECRET || '';
  }

  async _call(data) {
    if (!this.bridgeSecret) {
      return 'Phone calling is not configured on this server (missing BRIDGE_SECRET env var).';
    }
    const { to_number, purpose, callee_name } = data || {};
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
