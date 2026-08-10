const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeResearch — "let me really dig into that" (August 10 2026).
 *
 * The front door to the bridge's deep research engine. The character starts
 * a background research run (multi-search, multi-source, cited), the person
 * keeps talking with zero dead air, and a phone tap lands when the report
 * is ready. The report itself is composed FOR LISTENING — verdict first,
 * plain spoken prose, numbered sources, honest about what didn't check out.
 *
 * Rides the exact env the notify tool already uses: BRIDGE_URL +
 * NOTIFY_AGENT_SECRET. Zero new fork env vars. Engine rails (kill switch,
 * daily caps, spend receipts) live bridge-side in research.js.
 */

const researchJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'check', 'get', 'cancel'],
      description:
        "start = kick off a research run. check = progress on running/recent runs. get = fetch a finished report. cancel = stop a run.",
    },
    question: {
      type: 'string',
      description:
        "For start: the research question, stated fully and neutrally in one or two sentences, with the details that matter baked in (place, budget, timeframe, constraints). Good: 'What are the real pros, cons, and monthly costs of fiber versus Starlink for a rural home near Springfield, Missouri in 2026?' Bad: 'internet options?'",
    },
    depth: {
      type: 'string',
      enum: ['quick', 'standard', 'deep'],
      description:
        "start only. quick = ~2 minutes, a handful of sources, short answer. standard (default) = ~5 minutes, around ten sources, the right pick for most real questions. deep = ~10 minutes, up to twenty sources with follow-up rounds — only when the question truly earns it (big decisions, contested topics).",
    },
    focus: {
      type: 'string',
      description:
        "start, optional: a steer on what matters most to this person, in one sentence (e.g. 'wheelchair access and total out-the-door cost matter most').",
    },
    include_personal_notes: {
      type: 'boolean',
      description:
        "start, optional, default false. Set true ONLY when the question is about the user's own life or plans AND their saved notes would genuinely sharpen the answer (their town, their setup, their constraints). Their notes never leave the report engine.",
    },
    id: {
      type: 'string',
      description: 'The run id (from start/check). get and cancel need it; get without an id returns the most recently finished report.',
    },
  },
  required: ['action'],
};

class KadeResearch extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.agentId = fields.agentId;
    this.agentName = fields.agentName;
    this.name = 'kade_research';
    this.description =
      'Run REAL background research on a question: many web searches, many sources read and cross-checked, then a ' +
      'clear spoken-style report with numbered citations. Takes minutes, not seconds — the user gets a phone tap when ' +
      "it's ready. For questions that deserve actual digging, not quick lookups.";
    this.description_for_model =
      this.description +
      " WHEN TO REACH FOR THIS: comparisons and decisions ('which hearing aid brand', 'is this town worth moving to'), contested or scam-adjacent claims ('is this supplement legit'), anything where one page won't cut it. WHEN NOT TO: single facts (kade_wikipedia), today's headlines (kade_news), one specific page (kade_read_page), weather (kade_weather) — those answer in seconds and cost nothing. " +
      "THE FLOW, honestly narrated: (1) action='start' with a FULLY-STATED question — fold in the person's constraints (place, budget, needs) rather than researching a vague stub; pick depth honestly (standard for most things; deep costs real money and time, save it for questions that earn it; ask before going deep). (2) Tell the user plainly it's running in the background, roughly how long it'll take, and that their phone gets a tap when it's done — then keep the conversation moving; do NOT sit and poll. (3) If they ask how it's going, action='check' and read the progress note like a human would ('she's on source seven of ten'). (4) When they come back for it — or the tap lands — action='get', then DELIVER IT BY EAR: lead with the verdict in a breath or two, offer the full read, and read the report as written when they want it all (it's composed for listening — don't reformat it into lists). NEVER invent findings, never pad the report, and if it says the evidence was thin, say exactly that. " +
      "If include_personal_notes fits (their own life, their own plans), say you're factoring in what you already know about their situation — no surveillance vibes, just a friend who remembers.";
    this.schema = researchJsonSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.secret = process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '';
  }

  _hdrs() {
    return { 'x-notify-secret': this.secret, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };
  }

  async _call(data) {
    const action = (data && data.action) || 'start';
    if (!this.secret) return 'Research is not configured on this server (missing NOTIFY_AGENT_SECRET).';
    if (!this.userId) return 'Research is unavailable right now (no user context).';
    try {
      if (action === 'start') return await this._start(data || {});
      if (action === 'check') return await this._check(data || {});
      if (action === 'get') return await this._get(data || {});
      if (action === 'cancel') return await this._cancel(data || {});
      return `Unknown action "${action}". Use start, check, get, or cancel.`;
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      logger.warn(`[KadeResearch] ${action} failed: ${msg}`);
      return `The research desk hit an error (${msg}). Let the user know honestly and offer to try again.`;
    }
  }

  async _start({ question, depth, focus, include_personal_notes }) {
    if (!question || String(question).trim().length < 8) {
      return 'A real research question is required — state it fully, with the constraints that matter folded in.';
    }
    const r = await axios.post(
      `${this.bridgeUrl}/research/start`,
      {
        userId: this.userId,
        agentId: this.agentId,
        agentName: this.agentName,
        question: String(question).trim(),
        depth: depth || 'standard',
        focus: focus || undefined,
        include_personal_notes: include_personal_notes === true,
      },
      { headers: this._hdrs(), timeout: 15000 },
    );
    const { id, etaMinutes, position } = r.data || {};
    return (
      `Research started (run id ${id}, ${depth || 'standard'} depth). Expect roughly ${etaMinutes || 5} minutes` +
      (position ? ` — there ${position === 1 ? 'is one run' : `are ${position} runs`} ahead of it` : '') +
      ". Tell the user it's digging in the background and their phone will get a tap when the report's ready — then keep the conversation going normally. Check on it with action='check' only if they ask."
    );
  }

  async _check({ id }) {
    const url = `${this.bridgeUrl}/research/status?userId=${encodeURIComponent(this.userId)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
    const r = await axios.get(url, { headers: this._hdrs(), timeout: 15000 });
    const jobs = id ? [r.data] : (r.data?.jobs || []);
    if (!jobs.length) return 'No research runs on file for this user yet.';
    const lines = jobs.map((j) =>
      `[${j.id}] "${j.question}" (${j.depth}) — ${j.status}${j.stageNote ? `: ${j.stageNote}` : ''}${j.status === 'done' ? ` (${j.sourcesFound} sources — fetch it with action='get')` : ''}${j.error ? ` — ${j.error}` : ''}`,
    );
    return `Research runs, newest first. Relay progress conversationally, never as a list:\n${lines.join('\n')}`;
  }

  async _get({ id }) {
    const url = `${this.bridgeUrl}/research/report?userId=${encodeURIComponent(this.userId)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
    const r = await axios.get(url, { headers: this._hdrs(), timeout: 20000, validateStatus: (s) => s < 500 });
    if (r.status === 404) return "No finished report found. Use action='check' to see what's running.";
    if (r.status === 409) return `That run isn't finished yet — ${r.data?.stageNote || 'still working'}. Relay that naturally.`;
    const { report, sourceList, costs, question } = r.data || {};
    if (!report) return 'The report came back empty — tell the user honestly and offer to rerun it.';
    const srcs = (sourceList || []).map((s) => `Source ${s.n}: ${s.title} — ${s.url}`).join('\n');
    return (
      `THE FINISHED REPORT on "${question}" is below. Deliver it BY EAR: verdict first in your own breath or two, then offer the full read; when they want it all, read it as written — it is composed for listening. Never add findings it does not contain.\n` +
      `(For the curious: ${(costs && costs.estUSD) ? `this run cost about $${costs.estUSD.toFixed(2)}` : 'run cost logged'}.)\n\n${report}\n\nFULL LINKS (share only if asked):\n${srcs}`
    );
  }

  async _cancel({ id }) {
    if (!id) return 'Cancel needs the run id (see action=check).';
    await axios.post(
      `${this.bridgeUrl}/research/cancel`,
      { userId: this.userId, id },
      { headers: this._hdrs(), timeout: 15000 },
    );
    return 'Cancelled. Let the user know, and offer to restart it with a sharper question if they want.';
  }
}

module.exports = KadeResearch;
