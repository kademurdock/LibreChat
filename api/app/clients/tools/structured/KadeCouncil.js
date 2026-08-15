const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeCouncil — "pitch the council" (August 15 2026, Part 68).
 *
 * The front door to the bridge's council lane (/council/*). The council is
 * Kade's five-seat AI ops advisory — Aria the screen-reader advisor, Prism
 * the visual advisor, Sentinel the compliance advisor, Vault the
 * janitor-treasurer, and Pilgrim the user's-eye seat (her names, Aug 15). She pitches an idea; the seats answer independently in parallel; a
 * composer folds them into ONE spoken summary that keeps disagreements
 * visible and closes with the decision framed as hers.
 *
 * THE CHARTER, the part this tool must never let a model forget: ADVISORS,
 * NEVER DECIDERS. The council informs; Kade decides. It cannot block, veto,
 * or touch the platform. It is backstage staff — it never appears in the
 * marketplace and never talks to family.
 *
 * ⛔ OWNER-GATED, HARD, the same four-way check as kade_errand/kade_drive_pc:
 * authed seat AND acting identity both Kade + ADMIN + no kadeOnBehalfOf.
 * The bridge re-checks the user id server-side; a tool gate stops a confused
 * agent, a server gate stops a leaked secret.
 *
 * Secrets: COUNCIL_TOOL_SECRET (scoped — unlocks only /council/*, never the
 * admin BRIDGE_SECRET). Rides BRIDGE_URL like the other bridge tools. Budget
 * rails (daily cap, checked before every spending step) live bridge-side
 * where no prompt can strip them.
 */

const OWNER_ID_DEFAULT = '6a3cba4d0b0afa92194e42f7';

const councilSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['pitch', 'minutes', 'last', 'findings', 'decide'],
      description:
        "pitch = put an idea in front of all five advisor seats and get back one composed spoken verdict. minutes = read back the last few council sessions from the ledger. last = just the most recent one. findings = read the findings board (what's new, known, parked, fixed). decide = record HER verdict on a finding: park it (council goes quiet unless it worsens), unpark it, or attach her note.",
    },
    pitch: {
      type: 'string',
      description:
        "pitch only. The idea stated fully, the way she said it, with enough meat for five advisors to chew on — what it is, who it's for, roughly how it would work. A sentence to a paragraph. If her idea is a fragment, ask her one clarifying question BEFORE pitching rather than padding it with your own guesses.",
    },
    n: {
      type: 'string',
      description: "minutes only. How many recent sessions to read back, 1 to 20. Default 3.",
    },
    id: {
      type: 'string',
      description: "decide only. The finding id from the findings board or the minutes (looks like 'axe:page name:rule').",
    },
    verdict: {
      type: 'string',
      enum: ['park', 'unpark', 'note'],
      description: "decide only. park = she wants it left alone (council stays quiet unless it worsens). unpark = it counts as open again. note = attach her words to the finding. Send only what SHE actually said — never park anything on your own judgment.",
    },
    word: {
      type: 'string',
      description: "decide only, optional. Her actual words about the finding, kept on the ledger.",
    },
  },
  required: ['action'],
};

class KadeCouncil extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_council';
    this.userId = fields.userId;
    this.agentId = fields.agentId;
    this.agentName = fields.agentName;
    const ownerId = process.env.KADE_OWNER_USER_ID || OWNER_ID_DEFAULT;
    const authedId = String(fields.req?.user?.id || fields.req?.user?._id || '');
    const authedRole = fields.req?.user?.role;
    const actingId = String(fields.userId || '');
    const onBehalf = fields.req?.kadeOnBehalfOf?.id ? String(fields.req.kadeOnBehalfOf.id) : null;
    this.ownerOk =
      authedId === ownerId &&
      authedRole === 'ADMIN' &&
      (!actingId || actingId === ownerId) &&
      (!onBehalf || onBehalf === ownerId);

    this.description =
      "Pitch an idea to Kade's five-seat AI advisory council and hear the composed verdict, or read back the council's minutes. Owner-only: answers to Kade's own account and nobody else's.";
    this.description_for_model =
      "OWNER-ONLY TOOL — it answers ONLY when the person on this very turn is Kade herself on her own seat. For anyone else it refuses; when it refuses, say plainly that the council is Kade-only and DROP it — never retry, never roleplay a council verdict. " +
      "WHAT THE COUNCIL IS: her backstage ops advisory — five AI advisor seats: Aria (screen-reader flow), Prism (visual design), Sentinel (compliance and platform rules), Vault (cost, cleanup, and cruft), and Pilgrim (a normal user's first-time eye). They are ADVISORS, NEVER DECIDERS: they inform, she decides, and nothing they say blocks anything. They are staff only she can hear — never mention them to family members or speak as them. " +
      "THE FLOW: (1) When she wants opinions on an idea — she might say 'pitch the council', 'ask the team', 'what would the council think' — send the idea with action='pitch', stated fully in her terms. (2) The tool returns ONE composed spoken summary. SAY IT — it is already written for the ear, plain prose, disagreements kept visible, decision framed as hers. Do not reformat it into lists, do not add headings, do not soften disagreements into consensus. You may wrap it in your own voice at the edges. (3) action='minutes' or action='last' when she asks what the council said before. " +
      "HONESTY RAILS: never invent a council verdict — if the tool errored or the budget cap stopped it, say exactly that. The council costs real money (well under a cent a pitch); if she asks what it cost, tell her the true number from the tool. If a seat couldn't answer, the summary says so — keep that in, honesty beats polish.";
    this.schema = councilSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.secret = process.env.COUNCIL_TOOL_SECRET || '';
  }

  _hdrs() {
    return { 'x-council-secret': this.secret, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };
  }

  async _call(data) {
    const action = (data && data.action) || 'last';
    if (!this.ownerOk) {
      logger.warn(`[KadeCouncil] refused: non-owner turn (agent ${this.agentName || '?'})`);
      return "This tool is locked to Kade's own seat and this turn isn't hers. Tell the person plainly that the council is Kade-only, and let it go — do not retry or pretend.";
    }
    if (!this.secret) return 'The council is not configured on this server (missing COUNCIL_TOOL_SECRET).';
    if (!this.userId) return 'The council is unavailable right now (no user context).';
    try {
      if (action === 'pitch') return await this._pitch(data || {});
      if (action === 'minutes') return await this._minutes(data || {});
      if (action === 'last') return await this._last();
      if (action === 'findings') return await this._findings();
      if (action === 'decide') return await this._decide(data || {});
      return `Unknown action "${action}". Use pitch, minutes, last, findings, or decide.`;
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      logger.error('[KadeCouncil] error:', msg);
      return `The council couldn't convene (${msg}). Tell her honestly and offer to try again.`;
    }
  }

  async _pitch({ pitch }) {
    if (!pitch || String(pitch).trim().length < 8) {
      return 'The council needs a real pitch — state the idea itself, a sentence to a paragraph, in her terms.';
    }
    const r = await axios.post(
      `${this.bridgeUrl}/council/pitch`,
      { secret: this.secret, userId: this.userId, pitch: String(pitch).trim() },
      { headers: this._hdrs(), timeout: 90000, validateStatus: () => true },
    );
    if (r.status === 403) return "The council refused this turn — it answers to Kade's own seat only. Say so plainly and drop it.";
    if (r.status !== 200) return `The council couldn't convene (${r.data?.error || `HTTP ${r.status}`}). Say so honestly.`;
    if (r.data?.stopped) return `SAY THIS, in your own voice: ${r.data.spokenSummary}`;
    const cost = r.data.costUsd < 0.01 ? 'under a cent' : `about ${Math.round(r.data.costUsd * 100)} cents`;
    return (
      `The council has answered (session ${r.data.id}, ${cost}).\n\n` +
      `SAY THIS — it is composed for the ear, disagreements and all; keep them visible: ${r.data.spokenSummary}`
    );
  }

  async _minutes({ n }) {
    const r = await axios.get(`${this.bridgeUrl}/council/minutes`, {
      params: { secret: this.secret, userId: this.userId, n: parseInt(n, 10) || 3 },
      headers: this._hdrs(), timeout: 20000, validateStatus: () => true,
    });
    if (r.status !== 200) return `Couldn't read the minutes (${r.data?.error || `HTTP ${r.status}`}).`;
    return `SAY THIS, in your own voice, as flowing speech: ${r.data.spokenSummary}`;
  }

  async _findings() {
    const r = await axios.get(`${this.bridgeUrl}/council/findings`, {
      params: { secret: this.secret, userId: this.userId },
      headers: this._hdrs(), timeout: 20000, validateStatus: () => true,
    });
    if (r.status !== 200) return `Couldn't read the findings board (${r.data?.error || `HTTP ${r.status}`}).`;
    return `SAY THIS, in your own voice, as flowing speech — never as a printed list: ${r.data.spokenSummary}`;
  }

  async _decide({ id, verdict, word }) {
    if (!id || !verdict) return "Recording her verdict needs the finding id and her verdict (park, unpark, or note). Read her the findings board first if she hasn't heard it.";
    const r = await axios.post(
      `${this.bridgeUrl}/council/decision`,
      { secret: this.secret, userId: this.userId, id, verdict, word },
      { headers: this._hdrs(), timeout: 20000, validateStatus: () => true },
    );
    if (r.status === 404) return 'No finding on the ledger by that id — read the findings board to get the exact id.';
    if (r.status !== 200) return `Couldn't record that (${r.data?.error || `HTTP ${r.status}`}).`;
    return `SAY THIS: ${r.data.spokenSummary}`;
  }

  async _last() {
    const r = await axios.get(`${this.bridgeUrl}/council/last`, {
      params: { secret: this.secret, userId: this.userId },
      headers: this._hdrs(), timeout: 20000, validateStatus: () => true,
    });
    if (r.status !== 200) return `Couldn't read the minutes (${r.data?.error || `HTTP ${r.status}`}).`;
    return `SAY THIS, in your own voice: ${r.data.spokenSummary}`;
  }
}

module.exports = KadeCouncil;
