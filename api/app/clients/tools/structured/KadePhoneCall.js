const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { platformFactor, userPriceFactor, payerFromReq } = require('~/server/services/kadeRealCost');

// July 2 2026 round 3: guards against agent tool-loops (a live turn hit
// langgraph's recursion limit polling check_result 17 times, and dialed twice).
const _lastPlaced = new Map(); // userId -> ts of last successful place_call
const _lastChecked = new Map(); // userId -> ts of last check_result
// Nov 14 2026: did the bridge say it will report this user's last call back by itself?
const _lastReportBack = new Map(); // userId -> boolean
/* Nov 14 2026 review: the call this chat placed last, so check_result asks the bridge about THAT
 * call. Without an id the bridge answers with the newest call it has on record, which after a
 * bridge restart was an older call, reported as this one. */
const _lastPlacedSid = new Map(); // userId -> { sid, at }
const LAST_SID_MS = 6 * 3600 * 1000;

/* Nov 14 2026 (Kade's test call: "I don't think I like how it's like, message me back later and
 * I'll tell you what they said. It should be like, they message you when they're done with the
 * call."). The bridge now writes the character's report into this conversation when the call ends
 * (bridge call-report.js, through /api/kade/soul/speak), and answers reportBack:true when it will.
 * These lines tell the character so. A bridge that does not say so keeps the old wording. */
const SAYS_IT_WILL_MESSAGE =
  "When the call ends you will message them here yourself with how it went (written from the transcript, with a tap on their phone). " +
  "Tell them it is dialing and that you will message them when it is done. Do NOT ask them to message you back or check in for the result, and do NOT call check_result now. " +
  "If they ask about the call before your message arrives, call action='check_result' once.";
const STILL_GOING_WILL_MESSAGE =
  "Tell the user the call is still going and that you'll message them as soon as it ends; they don't need to ask again. End your reply now.";

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
        "Required for place_call. What you are calling about. It is said out loud right after the greeting, so keep it to ONE short sentence with the main question first. " +
        "For a business or a stranger, say what you will ask them, e.g. 'ask if you have any deals on hemp products right now' (never \"Kade wants to know ...\": they do not know who that is, and the greeting already says who you are calling for). " +
        "For family it can complete the sentence \"I'm calling because ...\", e.g. 'Kade wants to know if you are coming Sunday'. Put extra facts and follow-up questions in details.",
    },
    business: {
      type: 'boolean',
      description:
        'Required for place_call. true when the call is to a store, restaurant, gas station, office, clinic, or anyone else who does not personally know the user. ' +
        "The call then opens with \"Hi, this is <you>, an A I assistant calling on behalf of a customer, <the user's full name>. This call may be recorded.\" and you stay brief and professional. " +
        'false only for friends and family who know the user and you. If unsure, true.',
    },
    details: {
      type: 'string',
      description:
        'For place_call, optional: extra facts and follow-up questions the call needs (products, order numbers, what to ask next). Not spoken in the greeting; you use it during the call.',
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
 * Picks the character for a handed-off call from agents whose name matches.
 * Only an agent the caller owns or a public one is ever returned: an exact
 * name before a partial one, and within each, the caller's own before a
 * public one (oldest first, as the list comes). Null when none may be used,
 * which reads to the model exactly like "no such character".
 */
function pickCallAgent(candidates, { callAs, userId, publicIds }) {
  const wanted = String(callAs || '').trim().toLowerCase();
  const open = new Set((publicIds || []).map((id) => String(id)));
  const mine = (a) => !!userId && a.author != null && String(a.author) === String(userId);
  const isPublic = (a) => a._id != null && open.has(String(a._id));
  const named = (a) => wanted && String(a.name || '').toLowerCase().includes(wanted);
  const usable = (candidates || []).filter((a) => named(a) && (mine(a) || isPublic(a)));
  const exact = usable.filter((a) => String(a.name || '').toLowerCase() === wanted);
  return exact.find(mine) || exact.find(isPublic) || usable.find(mine) || usable.find(isPublic) || null;
}

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
    /* Nov 14 2026: the conversation the call was asked for in, so the character's report of how
     * it went lands there (bridge call-report.js). 'new' and anything else odd is left out. */
    this.conversationId =
      typeof fields.conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(fields.conversationId)
        ? fields.conversationId
        : undefined;
    this.isAdmin = fields.req?.user?.role === 'ADMIN';
    /* SEC-3 (Nov 12 2026): check-ins are decided for the person really asking, who on a voice
     * turn is not the service seat (services/kadeWellnessTarget.js wellnessActor). */
    this.req = fields.req;
    // Whose agents a handed-off call may use: the person really on the line
    // on a phone turn (the tool itself runs on the service seat), else the user.
    this.callerId = String(fields.req?.kadeOnBehalfOf?.id || fields.userId || '');
    // Part 291 (Sep 25 2026): who the call is FOR, so its bill, its daily cap and its result go to
    // them. On a phone or app-voice turn the tool runs on Kade's service seat and handleTools'
    // loader always sets userId to that seat, so handleTools passes the person on the line as
    // actingUserId (req.kadeOnBehalfOf, else the signed-in user). Unknown callers stay on the seat.
    this.actingUserId = String(fields.actingUserId || fields.req?.kadeOnBehalfOf?.id || fields.userId || '');
    /* Part 295 ("Yes, double everything"): the person the call is billed to pays the platform factor
     * x the phone line's price; Kade (the seat, calling for herself) is quoted the real price. */
    const payerIsKade = this.isAdmin && this.actingUserId === String(fields.req?.user?.id || fields.userId || '');
    /* Oct 20 2026: a payer the request holds (the signed-in person, or the caller on a phone turn)
     * is quoted their own price (factor 1 for a Family pack member); anyone else the platform's. */
    const payer = payerIsKade ? null : payerFromReq(fields.req, this.actingUserId);
    const f = payerIsKade ? 1 : payer ? userPriceFactor(payer) : platformFactor();
    const c = (cents) => +(cents * f).toFixed(1);
    this.priceNote = { perMinute: c(1.5), perCallLow: c(5), perCallHigh: c(10) };
    this.name = 'kade_phone_call';
    this.description =
      'Place a REAL outbound phone call from the Kade-AI phone line (+1 833-530-0313) to a person or business, on behalf of the current user. ' +
      `An AI voice agent speaks on the call following the purpose you provide. Costs real money (~${this.priceNote.perMinute} cents/minute, billed to the user's tab), ` +
      'hard-capped at 15 minutes and 10 calls per user per day. ONLY use when the user explicitly asks for a call, and ALWAYS confirm the exact ' +
      'number and reason with them first. When confirming, ALSO tell the user (casually, not as a warning): the call will identify them by ' +
      "name as the person who requested it (a store or other business hears their full name), and the call's cost is added to their Feed the Server page.";
    this.description_for_model =
      this.description +
      ' After placing the call you get a confirmation only — the conversation happens live on the phone. ' +
      /* Nov 14 2026: the character reports back by itself now (bridge call-report.js). */
      "When the call ends you normally message the user yourself with how it went (the tool's reply after dialing confirms it), so tell them it is dialing and that you'll message them when it's done. Never ask them to message you back or check in for the result. " +
      "Always say business: true for any store, restaurant, office or anyone who does not personally know the user (the call then says it is an A I assistant calling on behalf of a customer, the user's full name), false for family and friends who know the user. A call without it is not placed. " +
      "If they ask about a call before your message arrives, call action='check_result' ONCE — it WAITS for the call to finish (up to ~1 minute) and returns the transcript. NEVER call check_result more than once in a turn, and never place the same call twice. " +
      'If it says the call is still in progress, tell the user it is still going, and END your reply. NEVER invent a call result — only report what the transcript actually says. ' +
      'FAMILY WELLNESS CHECK-INS (schedule_checkin / list_checkins / pause_checkin / cancel_checkin / test_checkin): recurring companion calls to REGISTERED family only — you (this agent) make the call, chat warmly, and afterwards a detailed summary of how they seemed and what they said is delivered to the user as a nudge. ' +
      `Before creating or un-pausing a schedule: state the rough cost (about ${this.priceNote.perCallLow} to ${this.priceNote.perCallHigh} cents per call — a daily schedule runs a few dollars a month) and get an explicit yes.` + ' For a FIRST-EVER setup, offer a test_checkin to the user so they can hear exactly what their family will hear. Calls run 08:00-21:00 Central only.';
    this.schema = phoneCallJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.bridgeSecret = process.env.BRIDGE_SECRET || '';
  }

  async _call(data) {
    if (!this.bridgeSecret) {
      return 'Phone calling is not configured on this server (missing BRIDGE_SECRET env var).';
    }
    const { action, to_number, purpose, callee_name, call_sid, details } = data || {};
    /* Nov 14 2026: a business or a stranger (true), family who know the user (false), or not said
     * (review, the same day: then place_call is refused until the model says which). */
    const business =
      data && (data.business === true || data.business === 'true')
        ? true
        : data && (data.business === false || data.business === 'false')
          ? false
          : undefined;
    if (action === 'check_result') {
      const uid = this.actingUserId;
      const lastCheck = _lastChecked.get(uid) || 0;
      if (Date.now() - lastCheck < 15000) {
        return (
          'STOP: you just checked. Do NOT call this tool again in this turn. ' +
          (_lastReportBack.get(uid)
            ? STILL_GOING_WILL_MESSAGE
            : 'Tell the user the call is still going and that you will report back when they ask. End your reply now.')
        );
      }
      _lastChecked.set(uid, Date.now());
      // Nov 14 2026 review: ask about the call this chat placed, unless the model named another one.
      const lastSid = _lastPlacedSid.get(uid);
      const sid = call_sid || (lastSid && Date.now() - lastSid.at < LAST_SID_MS ? lastSid.sid : undefined);
      try {
        // waitSec: the BRIDGE waits for the call to wrap (up to ~50s) so one
        // check usually returns the finished transcript — the model must not poll.
        const r = await axios.post(
          `${this.bridgeUrl}/outbound/result`,
          { secret: this.bridgeSecret, userId: uid, callSid: sid || undefined, waitSec: 50 },
          { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } },
        );
        const d = r.data || {};
        if (!d.found) {
          return sid
            ? 'That call is not on record. It may have been cut off when the phone system restarted. Tell the user that plainly, and never guess what was said.'
            : 'No outbound calls found for this user yet.';
        }
        if (d.status === 'interrupted') {
          const heard = (d.transcript || [])
            .map((t) => `${t.role === 'assistant' ? 'Agent' : 'Callee'}: ${t.content}`)
            .join('\n');
          return (
            `Call ${d.callSid} to ${d.calleeName || 'that number'} was cut off: the phone system restarted on our side during or right after it.\n` +
            `What was saved:\n${heard || '(nothing)'}\n\n` +
            (d.reportedToChat
              ? 'You have ALREADY messaged them about this call (or that message is being written right now). Do not repeat it; answer what they asked, from what was saved above only.'
              : 'Tell the user plainly that the call was cut off by a restart on our side, and report only what was saved above. Never guess the rest.')
          );
        }
        if (d.status === 'in-progress') {
          return (
            `The call to ${d.calleeName || d.to} is still in progress after waiting (started ${d.startedSecondsAgo}s ago). ` +
            'STOP: do NOT call this tool again in this turn. ' +
            (d.reportBack
              ? STILL_GOING_WILL_MESSAGE
              : 'Tell the user the call is running long and you will report back when they ask. End your reply now.')
          );
        }
        const lines = (d.transcript || [])
          .map((t) => `${t.role === 'assistant' ? 'Agent' : 'Callee'}: ${t.content}`)
          .join('\n');
        return (
          `Call ${d.callSid} to ${d.calleeName || d.to} — status: ${d.status}, duration ${d.durationSec}s.\n` +
          `Transcript:\n${lines || '(no speech captured)'}\n\n` +
          (d.reportedToChat
            ? 'You have ALREADY messaged them about how this call went (or that message is being written right now). ' +
              'Do not repeat the whole report; answer what they asked, from this transcript only.'
            : 'Report the relevant answer(s) back to the user in your own words — only what the transcript actually says.')
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
        const found = await this._findCallAgent(callAs);
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
    /* Nov 14 2026 review: the greeting a stranger needs ("an A I assistant calling on behalf of a
     * customer ...") depended on the model sending business:true. Left out, the bridge decided by its
     * registry, and Kade's own number (registered, with Kiana as its character) got the friend
     * greeting again on a "call this gas station" test: no A I notice, no recording notice, her own
     * memories on the call. So the model has to say which it is. Nothing is dialed until it does.
     * "Not started:" reads as a failure to the ledger (kadeLedger.js), so the reply cannot claim a call. */
    if (business === undefined) {
      return (
        'Not started: no call was placed and nothing was charged. Say business: true for a store, office or anyone ' +
        'who does not personally know the user, or business: false for family and friends who know them (if unsure, true), ' +
        'then place the same call again.'
      );
    }
    const uidPlace = this.actingUserId;
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
          // The bridge bills the call (real Twilio cost) and counts the daily cap by this id.
          userId: uidPlace,
          userName: this.userName,
          agentId: callAgentId,
          agentName: callAgentName,
          secret: this.bridgeSecret,
          /* Nov 14 2026: a business call opens "<name>, an A I assistant calling for <first name>,
           * one of our users. This call may be recorded." disclose is the older bridge's word for
           * the same greeting, so either bridge gets it right. */
          business, // always said by now (the refusal above)
          ...(business === true ? { disclose: true } : {}),
          // A number nobody registered, asked for from a chat, is a store or a stranger unless
          // the character said business:false (the bridge's own briefings keep their old rules).
          unregisteredIsBusiness: true,
          // Extra facts for the call, kept out of the greeting (the bridge's mission material).
          ...(typeof details === 'string' && details.trim() ? { context: details.trim().slice(0, 3000) } : {}),
          // The character who was asked reports back, in this conversation, when the call ends.
          reportBack: true,
          conversationId: this.conversationId,
          reportAgentId: this.agentId,
          reportAgentName: this.agentName,
        },
        { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } },
      );
      const d = r.data || {};
      _lastPlaced.set(uidPlace, Date.now());
      _lastReportBack.set(uidPlace, d.reportBack === true);
      if (typeof d.callSid === 'string' && d.callSid) _lastPlacedSid.set(uidPlace, { sid: d.callSid, at: Date.now() });
      return (
        `Call placed to ${d.to}${d.callSid ? ` (call id ${d.callSid})` : ''}${callAgentId !== this.agentId ? ` — ${callAgentName} is making this call in their own voice` : ''} — it is dialing now, capped at ${d.timeLimitMin} minutes. ` +
        `The user has ${d.callsLeftToday} outbound call(s) left today. The cost will appear on their Feed-the-Server tab after the call ends. ` +
        (d.reportBack === true
          ? SAYS_IT_WILL_MESSAGE
          : "Tell the user the call is underway and that you'll have the answer when they next check in. " +
            "IMPORTANT: on the user's NEXT message (even just 'hey' or 'well?'), run action='check_result' FIRST and report what the callee said before anything else.")
      );
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      logger.warn(`[KadePhoneCall] call failed: ${msg}`);
      return `Could not place the call: ${msg}`;
    }
  }

  /**
   * The character Kiana hands a call to, by name, among the agents the person
   * asking may use: their own, or a public one (Sep 25 2026, Part 291 — the
   * old lookup took any agent with the name, so "have Lilly call me" reached
   * Skylee's private Lilly for everyone). On a phone turn the tool runs on
   * the service seat, so the person really on the line (req.kadeOnBehalfOf)
   * is the one whose agents count.
   */
  async _findCallAgent(callAs) {
    const mongoose = require('mongoose');
    const { ResourceType, PermissionBits } = require('librechat-data-provider');
    const { findPubliclyAccessibleResources } = require('~/server/services/PermissionService');
    const AgentModel = mongoose.models.Agent;
    const userId = this.callerId;
    // Same public set the Parlor seats and the Clubhouse guests use; it comes
    // back empty on an ACL error, which leaves only the caller's own agents.
    const publicIds =
      (await findPubliclyAccessibleResources({
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      })) || [];
    const allowed = [{ _id: { $in: publicIds } }];
    if (userId) allowed.push({ author: userId });
    const esc = callAs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Oldest first, the order the old findOne gave within each kind of match.
    const candidates = await AgentModel.find(
      { name: new RegExp(esc, 'i'), $or: allowed },
      { _id: 1, id: 1, name: 1, author: 1 },
    )
      .sort({ _id: 1 })
      .lean();
    return pickCallAgent(candidates || [], { callAs, userId, publicIds });
  }

  async _wellness(action, data) {
    const { who, time, days, topics, schedule_id } = data || {};
    const hdrs = { 'User-Agent': 'Mozilla/5.0' };
    /* Audit fix SEC-3 (Nov 12 2026): the rules and the identity come from one place,
     * services/kadeWellnessTarget.js. this.isAdmin is the SEAT's role and is true on every voice
     * turn, so it is not used here: admin means the person asking is Kade. Kade's decision: a
     * grown-up may still ring any registered relative; a child or teen sets up nothing, and the
     * calling character must be one the person may use. */
    const W = require('~/server/services/kadeWellnessTarget');
    let actor = W.wellnessActor(this.req);
    try {
      if (actor && !actor.admin) {
        // Account type from the account itself, not from whatever the request carried.
        const fresh = await require('~/models').getUserById(actor.id, 'email role kadeAccountType');
        actor = fresh
          ? W.actorFromUser({ id: actor.id, email: fresh.email, role: fresh.role, kadeAccountType: fresh.kadeAccountType })
          : null;
      }
      if (!actor) return W.NOT_KNOWN;
      const uid = actor.id;
      const admin = actor.admin;
      const ownSchedule = async (id) => {
        const check = await axios.get(`${this.bridgeUrl}/wellness?secret=${encodeURIComponent(this.bridgeSecret)}&userId=${encodeURIComponent(uid)}`, { timeout: 15000, headers: hdrs });
        return ((check.data && check.data.schedules) || []).find((w) => w.id === schedule_id) || null;
      };
      const NOT_THEIRS = 'That schedule id does not belong to this user (list_checkins shows theirs).';

      if (action === 'list_checkins') {
        const qs = admin ? '' : `&userId=${encodeURIComponent(uid)}`;
        const r = await axios.get(`${this.bridgeUrl}/wellness?secret=${encodeURIComponent(this.bridgeSecret)}${qs}`, { timeout: 15000, headers: hdrs });
        const rows = (r.data && r.data.schedules) || [];
        if (!rows.length) {
          return 'No check-in schedules yet. Create one with schedule_checkin (who + time; days and topics optional).';
        }
        return rows
          .map((w) => `id ${w.id}: ${w.targetName} — ${w.days === 'daily' ? 'every day' : (Array.isArray(w.days) ? w.days.join('/') : w.days)} at ${w.time} Central with ${w.agentName}${w.topics ? ` (topics: ${w.topics})` : ''} — ${w.enabled ? 'ACTIVE' : 'PAUSED'}${w.lastRun ? `, last ran ${w.lastRun}` : ', never run yet'}${admin ? ` [set up by ${w.enrolledBy && w.enrolledBy.userName}]` : ''}`)
          .join('\n');
      }
      if (action === 'schedule_checkin') {
        if (!who || !time) {
          return "schedule_checkin needs at least: who (a registered family member's name) and time ('HH:mm', 24-hour Central). Optional: days ('daily' or 'mon,wed,fri'), topics.";
        }
        const gate = await W.wellnessAllowed(actor, { agentId: this.agentId });
        if (gate.error) {
          return `Not scheduled, nothing was changed. ${gate.error} Tell the user that plainly; do not say a schedule was made.`;
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
          `Each call costs roughly ${this.priceNote.perCallLow}-${this.priceNote.perCallHigh} cents, billed to the user's Feed the Server tab. ` +
          'If this is the user\'s FIRST schedule, strongly suggest a test_checkin with this id so they can hear one themselves before their family gets a call.'
        );
      }
      if (action === 'test_checkin') {
        if (!schedule_id) return 'test_checkin needs schedule_id (from list_checkins).';
        let mine = false;
        if (!admin) {
          // SEC-3: a test call fires only the person's own schedule, and only from a grown-up.
          const row = await ownSchedule(schedule_id);
          if (!row) return NOT_THEIRS;
          const gate = await W.wellnessAllowed(actor, { agentId: row.agentId });
          if (gate.error) return `Not done, no call was placed. ${gate.error}`;
          mine = true;
        } else {
          // Kade may fire anyone's schedule; the call is on the account that set it up.
          mine = !!(await ownSchedule(schedule_id).catch(() => null));
        }
        const r = await axios.post(`${this.bridgeUrl}/wellness/fire`, { secret: this.bridgeSecret, id: schedule_id }, { timeout: 35000, headers: hdrs });
        /* Verification round, Nov 14 2026: check_result asks the bridge about the newest call this tool
         * placed, so that is this check-in now (before, a store call placed earlier was read back as the
         * check-in). The bridge files a check-in under the account that set the schedule up, so the id is
         * kept only for the asker's own schedule; otherwise check_result asks for their newest call, as
         * before this branch. A check-in reports through its own summary, not the chat call report. */
        const firedSid = r.data && typeof r.data.callSid === 'string' && r.data.callSid ? r.data.callSid : null;
        if (firedSid && mine) _lastPlacedSid.set(this.actingUserId, { sid: firedSid, at: Date.now() });
        else _lastPlacedSid.delete(this.actingUserId);
        _lastReportBack.set(this.actingUserId, false);
        return `${(r.data && r.data.note) || 'Test call dialing now.'} Tell the user the phone should ring within seconds; after they hang up, the written report lands as a nudge a minute or two later (check_result also works for the raw transcript).`;
      }
      if (action === 'pause_checkin' || action === 'cancel_checkin') {
        if (!schedule_id) return `${action} needs schedule_id (from list_checkins).`;
        if (!admin) {
          const row = await ownSchedule(schedule_id);
          if (!row) return NOT_THEIRS;
          if (action === 'pause_checkin' && !row.enabled) {
            // pause_checkin on a paused schedule RESUMES it: same rule as making one.
            const gate = await W.wellnessAllowed(actor, { agentId: row.agentId });
            if (gate.error) return `Not resumed, nothing was changed. ${gate.error}`;
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

KadePhoneCall.pickCallAgent = pickCallAgent;

module.exports = KadePhoneCall;
