const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeErrand — "go run this for me and tell me how you know" (August 15 2026).
 *
 * The front door to the bridge's errand desk (/errand/*). An errand is a
 * tracked, resumable, multi-step job: Kade states a goal, walks away, and the
 * character comes back with what it DID and what it FOUND — a step-by-step
 * ledger, not a wall of links.
 *
 * Blind-first, and that is the whole point rather than a nicety: every read
 * this tool performs comes back with a `spokenSummary` the bridge composed
 * for the EAR — answer first, ledger second, money third, plain prose. The
 * character's job is to say it, not to reformat it into bullets. A list of
 * links is exactly the thing she cannot use.
 *
 * ⛔ OWNER-GATED, HARD, same four-way check as kade_drive_pc: the
 * authenticated seat AND the acting identity must both be Kade's own account
 * with the ADMIN role, and a turn acting on someone else's behalf (the phone
 * lane's kadeOnBehalfOf case) is refused even though it authenticates as the
 * service seat. Errands spend money and, from rung 2 on, place real phone
 * calls — this is not a lane to open by accident. The bridge re-checks the
 * user id server-side too; a tool gate stops a confused agent, a server gate
 * stops a leaked secret.
 *
 * Secrets: ERRAND_TOOL_SECRET (scoped — unlocks only the /errand lane, never
 * the admin BRIDGE_SECRET). Rides BRIDGE_URL like the other bridge tools.
 * Engine rails (per-errand spend cap, daily caps, owner check, the
 * append-only ledger) all live bridge-side where no prompt can strip them.
 */

const OWNER_ID_DEFAULT = '6a3cba4d0b0afa92194e42f7';

const errandSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'status', 'list', 'receipts', 'confirm', 'cancel'],
      description:
        "start = send her errand off to run in the background. status = where one errand stands right now, with its spoken summary. list = everything on the board. receipts = the full step-by-step ledger of one errand, every step and what it cost. confirm = answer the yes/no question an errand stopped to ask. cancel = call one off.",
    },
    goal: {
      type: 'string',
      description:
        "start only. The errand stated fully and concretely, the way she said it, with the details that decide the answer baked in — place, budget, timeframe, what 'best' means to her. Good: 'find the cheapest chest freezer at stores in Springfield, Missouri and tell me who has it and what it costs.' Bad: 'freezer prices.' If a detail is missing and it genuinely changes the answer, ask her for it BEFORE starting — an errand that guesses wastes real money.",
    },
    id: {
      type: 'string',
      description: 'The errand id from start. Needed for receipts, confirm and cancel; status without an id reports on the most recent errand.',
    },
    answer: {
      type: 'string',
      description: "confirm only. Her actual answer, 'yes' or 'no'. Send what she said — never assume a yes.",
    },
  },
  required: ['action'],
};

class KadeErrand extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_errand';
    this.userId = fields.userId;
    this.agentId = fields.agentId;
    this.agentName = fields.agentName;
    const ownerId = process.env.KADE_OWNER_USER_ID || OWNER_ID_DEFAULT;
    const authedId = String(fields.req?.user?.id || fields.req?.user?._id || '');
    const authedRole = fields.req?.user?.role;
    const actingId = String(fields.userId || '');
    const onBehalf = fields.req?.kadeOnBehalfOf?.id ? String(fields.req.kadeOnBehalfOf.id) : null;
    // Both the seat that logged in AND the person this turn acts for must be
    // Kade. A family phone call rides the service seat but acts as the caller;
    // that turn must never reach an errand.
    this.ownerOk =
      authedId === ownerId &&
      authedRole === 'ADMIN' &&
      (!actingId || actingId === ownerId) &&
      (!onBehalf || onBehalf === ownerId);

    this.description =
      "Run a real errand in the background — look things up across the web, keep a step-by-step record, and come back with the answer AND how you know it. Owner-only: answers to Kade's own account and nobody else's.";
    this.description_for_model =
      "OWNER-ONLY TOOL — it answers ONLY when the person on this very turn is Kade herself on her own seat. For anyone else it refuses; when it refuses, say plainly that errands are Kade-only and DROP it — never retry, never roleplay success. " +
      "WHAT AN ERRAND IS: a job you go do while she gets on with her day. She states a goal, you start it, and the desk works through it step by step — looking things up, cross-checking, keeping a receipt for every step. It taps her phone when it's done. Minutes, not seconds. " +
      "THE ONE RULE THAT MATTERS: every reply from this tool carries a spoken summary written for the EAR. SAY IT. Do not turn it into a bulleted list, do not paste links, do not add headings — she is blind and a list of URLs is worthless to her. Put it in your own voice if you like, but keep the shape: the answer first, then what you did, then what it cost. " +
      "THE FLOW: (1) action='start' with her goal stated fully — if a detail that changes the answer is missing, ask her for it first, because a guessed errand spends real money on the wrong question. Tell her the errand id in plain digits and that you'll ping her. (2) She can ask how it's going any time: action='status'. Relay it conversationally; never invent progress the tool didn't report. (3) If an errand stops to ask something, it comes back as awaiting a yes or no — read her the question EXACTLY as the tool words it, wait for her real answer, and send it with action='confirm'. Never assume a yes on her behalf. (4) action='receipts' when she wants the whole trail — read it as a short story of what happened, in order, not as a table. Offer it once when you deliver a finished errand; don't force it on her. (5) action='cancel' the moment she says stop. " +
      "HONESTY RAILS: never claim an errand found something without this tool's receipt for it. If an errand failed, came back empty, or stopped at its spending limit, say exactly that — a partial answer she can trust beats a confident one she can't. Errands cost real money and the tool reports the amount; if she asks, tell her the true number.";
    this.schema = errandSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.secret = process.env.ERRAND_TOOL_SECRET || '';
  }

  _hdrs() {
    return { 'x-errand-secret': this.secret, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };
  }

  async _call(data) {
    const action = (data && data.action) || 'status';
    if (!this.ownerOk) {
      logger.warn(`[KadeErrand] refused: non-owner turn (agent ${this.agentName || '?'})`);
      return "This tool is locked to Kade's own seat and this turn isn't hers. Tell the person plainly that errands are Kade-only, and let it go — do not retry or pretend.";
    }
    if (!this.secret) return 'The errand desk is not configured on this server (missing ERRAND_TOOL_SECRET).';
    if (!this.userId) return 'Errands are unavailable right now (no user context).';
    try {
      if (action === 'start') return await this._start(data || {});
      if (action === 'status') return await this._status(data || {});
      if (action === 'list') return await this._list();
      if (action === 'receipts') return await this._receipts(data || {});
      if (action === 'confirm') return await this._confirm(data || {});
      if (action === 'cancel') return await this._cancel(data || {});
      return `Unknown action "${action}". Use start, status, list, receipts, confirm, or cancel.`;
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      logger.error('[KadeErrand] error:', msg);
      return `The errand desk hit an error (${msg}). Tell her honestly and offer to try again.`;
    }
  }

  async _start({ goal }) {
    if (!goal || String(goal).trim().length < 8) {
      return 'An errand needs a real goal — state what she actually wants found out, with the details that decide the answer.';
    }
    const r = await axios.post(
      `${this.bridgeUrl}/errand`,
      { secret: this.secret, userId: this.userId, agentId: this.agentId, agentName: this.agentName, goal: String(goal).trim() },
      { headers: this._hdrs(), timeout: 20000, validateStatus: () => true },
    );
    if (r.status === 403) return "The errand desk refused this turn — errands are Kade's own seat only. Say so plainly and drop it.";
    if (r.status === 429) return `${r.data?.error || 'The errand desk is full.'} Tell her that in plain words and offer to try later.`;
    if (r.status !== 200 || !r.data?.ok) return `The errand couldn't start (${r.data?.error || `HTTP ${r.status}`}). Say so honestly.`;
    return (
      `Errand started. Id ${r.data.id}.\n\n` +
      `SAY THIS, in your own voice: ${r.data.spokenSummary}\n\n` +
      "Then get back to whatever she was doing. Her phone gets tapped when it's finished; don't sit and wait on it."
    );
  }

  async _fetchOne(id) {
    const params = { secret: this.secret, userId: this.userId };
    if (id) {
      const r = await axios.get(`${this.bridgeUrl}/errand/${encodeURIComponent(id)}`, { params, headers: this._hdrs(), timeout: 20000, validateStatus: () => true });
      return r;
    }
    const list = await axios.get(`${this.bridgeUrl}/errands`, { params, headers: this._hdrs(), timeout: 20000, validateStatus: () => true });
    const newest = list.data?.errands?.[0];
    if (!newest) return { status: 404, data: { error: 'no errands yet' } };
    return await axios.get(`${this.bridgeUrl}/errand/${encodeURIComponent(newest.id)}`, { params, headers: this._hdrs(), timeout: 20000, validateStatus: () => true });
  }

  async _status({ id }) {
    const r = await this._fetchOne(id);
    if (r.status === 404) return "No errand on file by that name. Use action='list' to see what's on the board.";
    if (r.status !== 200) return `Couldn't read that errand (${r.data?.error || `HTTP ${r.status}`}).`;
    const e = r.data;
    const head = `Errand ${e.id} — ${e.status}.`;
    if (e.status === 'awaiting_confirm') {
      return (
        `${head}\n\nIT IS WAITING ON HER. Read her this question EXACTLY as written, then send her real answer with action='confirm' and id='${e.id}':\n"${e.awaiting?.ask || ''}"\n\n` +
        `Context if she asks: ${e.spokenSummary}`
      );
    }
    return `${head}\n\nSAY THIS, in your own voice, no lists: ${e.spokenSummary}` +
      (e.status === 'done' ? "\n\nIf she wants the whole trail, offer action='receipts' — once, without pushing." : '');
  }

  async _list() {
    const r = await axios.get(`${this.bridgeUrl}/errands`, {
      params: { secret: this.secret, userId: this.userId },
      headers: this._hdrs(), timeout: 20000, validateStatus: () => true,
    });
    if (r.status !== 200) return `Couldn't read the errand board (${r.data?.error || `HTTP ${r.status}`}).`;
    const lines = (r.data.errands || []).map((e) => `  ${e.id} — ${e.status} — "${e.goal.slice(0, 90)}"`);
    return (
      `SAY THIS, in your own voice: ${r.data.spokenSummary}\n\n` +
      (lines.length ? `The board, for your reference — relay it conversationally, never as a printed list:\n${lines.join('\n')}` : 'Nothing on the board.')
    );
  }

  async _receipts({ id }) {
    const r = await this._fetchOne(id);
    if (r.status === 404) return 'No errand on file by that name.';
    if (r.status !== 200) return `Couldn't read that errand (${r.data?.error || `HTTP ${r.status}`}).`;
    const e = r.data;
    const steps = (e.steps || []).map((s, i) => {
      const cost = s.costUsd > 0 ? ` (${Math.max(1, Math.round(s.costUsd * 100))} cents)` : '';
      return `  ${i + 1}. ${s.summary}${cost}`;
    });
    return (
      `Receipts for errand ${e.id} — "${e.goal}". Status ${e.status}, ${e.stepCount} steps, ${Math.round(e.costUsd * 100)} cents total.\n\n` +
      `${steps.join('\n')}\n\n` +
      'READ THIS BACK AS A SHORT STORY of what you did, in order, in plain spoken sentences — not as a numbered list, not as a table. ' +
      'She wants to hear how you got there. End with the answer and how solid it is.'
    );
  }

  async _confirm({ id, answer }) {
    if (!id) return "Confirming needs the errand id — use action='status' to find the one that's waiting.";
    if (!answer) return 'Send her actual answer — yes or no, in her words. Never assume a yes on her behalf.';
    const r = await axios.post(
      `${this.bridgeUrl}/errand/${encodeURIComponent(id)}/confirm`,
      { secret: this.secret, userId: this.userId, answer: String(answer) },
      { headers: this._hdrs(), timeout: 20000, validateStatus: () => true },
    );
    if (r.status === 404) return 'No errand on file by that name.';
    if (r.status === 409) return `That errand isn't waiting on anything — ${r.data?.error || 'it has moved on'}. Tell her where it actually stands.`;
    if (r.status !== 200) return `Couldn't pass that answer along (${r.data?.error || `HTTP ${r.status}`}).`;
    return `SAY THIS, in your own voice: ${r.data.spokenSummary}`;
  }

  async _cancel({ id }) {
    if (!id) return "Cancelling needs the errand id — use action='list' to find it.";
    const r = await axios.post(
      `${this.bridgeUrl}/errand/${encodeURIComponent(id)}/cancel`,
      { secret: this.secret, userId: this.userId },
      { headers: this._hdrs(), timeout: 20000, validateStatus: () => true },
    );
    if (r.status === 404) return 'No errand on file by that name.';
    if (r.status !== 200) return `Couldn't cancel that one (${r.data?.error || `HTTP ${r.status}`}).`;
    return `SAY THIS, in your own voice: ${r.data.spokenSummary || 'Called off.'}`;
  }
}

module.exports = KadeErrand;
