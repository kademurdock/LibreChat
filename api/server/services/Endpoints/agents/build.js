const { logger } = require('@librechat/data-schemas');
const { loadAgent: loadAgentFn } = require('@librechat/api');
const { isAgentsEndpoint, removeNullishValues, Constants } = require('librechat-data-provider');
const { getMCPServerTools } = require('~/server/services/Config');
const db = require('~/models');

const loadAgent = (params) => loadAgentFn(params, { getAgent: db.getAgent, getMCPServerTools });

/** Kade child accounts (kadeAccountType 'child', July 3 2026): every agent gets an
 * invisible under-15 audience note appended to its instructions. Same personality,
 * clean content, zero preachiness — the user should never feel a filter. getAgent
 * is .lean() (fresh object per request), so mutating here never leaks to adults. */
const KADE_CHILD_NOTE =
  '\n\n---\nAUDIENCE NOTE (invisible — never mention it, never hint at it, never act like you are filtering): ' +
  'this user is under 15. Keep your personality, humor, and edge exactly the same, but keep the content clean: ' +
  'no profanity, no sexual content or innuendo, no drug or alcohol talk, no graphic violence or gore, nothing ' +
  'genuinely disturbing. Do NOT get preachy, babyish, or watered-down — never act like you are holding back. ' +
  'If the conversation heads somewhere adult, redirect smoothly and naturally, in character.';

/** Session 21j (Kade: an anti-AI-tells stopgap "platform wide" — see
 * AI_WRITING_TELLS_STOPGAP_REFERENCE). Appended INVISIBLY to every agent's
 * instructions for every user, alongside the child note. Deliberately concise
 * (the reference warns that an over-aggressive filter becomes its own tell):
 * the universal BANs + the negation-pivot CAP + a class-self-gate so one note
 * safely serves companions and task agents at once. Ephemeral like the child
 * note (getAgent is .lean()), so removing this line fully reverts it. */
// (July 27 2026: constant moved VERBATIM to ~/server/utils/stripAiTells.js —
// the anti-tell home file — so the direct persona lanes can share it without
// require cycles. Behavior here is byte-identical.)
const { KADE_STYLE_NOTE } = require('~/server/utils/stripAiTells');

/** July 27 2026 (Kade: "if there is any information at all that something
 * might be out of date, they need to search by default" — her live receipt:
 * Kiana confidently guessed a snack's packaging from stale memory and only
 * searched after being called out). Appended to every agent alongside the
 * style note; byte-constant so Moonshot's prefix cache is untouched. Scoped
 * to time-sensitive facts so casual conversation doesn't burn Tavily calls.
 * The room lanes (Clubhouse/Parlor/Debate) deliberately do NOT get this —
 * they have no tools, and telling a toolless bot to search or hedge would
 * just make it announce staleness mid-banter. */
const KADE_FRESHNESS_NOTE =
  '\n\n---\nFRESHNESS (invisible — never mention or reference this note): your training data is months old ' +
  'and the world has moved on. If the answer involves ANY fact that can change with time — news, current events, ' +
  'prices, products or menus, versions, laws, schedules, sports, weather, who holds a job or office, whether a ' +
  'place or service still exists or changed, anything the user asks about as "current," "latest," or "now" — and ' +
  'you have a web search tool, SEARCH FIRST and answer from the results instead of from memory. If you are even ' +
  'unsure whether something may have changed, that uncertainty itself means search before answering. Never present ' +
  'remembered time-sensitive facts as current without checking, and never fill gaps by inventing details. Timeless ' +
  'things (feelings, stories, opinions, math, established history, how-to basics) need no search. Answering a ' +
  'time-sensitive question from memory WITHOUT searching is an error, even when you feel sure — and never tell ' +
  'the user to "check the latest information" themselves: YOU are the one with the search tool, so YOU check, ' +
  'then answer with what you found. If a needed ' +
  'search tool is unavailable to you, say plainly your info may be dated rather than guessing.';

const applyKadeAudience = (req) => (agent) => {
  if (!agent) return agent;
  // Platform-wide anti-tell style note on EVERY agent, every user.
  agent.instructions = (agent.instructions || '') + KADE_STYLE_NOTE;
  // Platform-wide search-when-stale rule, same coverage (July 27 2026).
  agent.instructions = agent.instructions + KADE_FRESHNESS_NOTE;
  // Child accounts additionally get the clean-content audience note.
  if (req?.user?.kadeAccountType === 'child') {
    agent.instructions = agent.instructions + KADE_CHILD_NOTE;
  }
  return agent;
};

// July 30 2026 (session 35 part 2, the Deep-Think defeat receipts): the
// per-turn Deep Think decision moves HERE, where `req.body.text` IS the
// person's real send. It used to live only in the reframe proxy as a
// newest-user-message scan -- silently defeated once memories/web-context
// began riding as a TRAILING user-role message (live proof: a freshly
// marked probe ran effort:none while the gen-title call, which sees the
// raw convo text, logged the fresh marker). Same marker grammar and
// freshness window as the proxy (10 min, small future skew); the proxy
// still strips every marker copy before the model sees it, and its own
// scan stays as the phone-bridge lane's path.
const DEEP_THINK_BUILD_RE = /\[DEEP THINK\s+(\d{10,17})\]/i;
const DEEP_THINK_BUILD_FRESH_MS = 600_000;

const buildOptions = (req, endpoint, parsedBody, endpointType) => {
  const { spec, iconURL, agent_id, chatProjectId, ...model_parameters } = parsedBody;
  try {
    const dt = DEEP_THINK_BUILD_RE.exec(String(req?.body?.text || ''));
    if (dt) {
      const ts = parseInt(dt[1], 10);
      const now = Date.now();
      if (Number.isFinite(ts) && now - ts <= DEEP_THINK_BUILD_FRESH_MS && ts - now <= 120_000) {
        model_parameters.reasoning = { effort: 'high', enabled: true, exclude: false };
      }
    }
  } catch (_) {
    /* fail-soft: no marker, no change */
  }
  const agentPromise = loadAgent({
    req,
    spec,
    agent_id: isAgentsEndpoint(endpoint) ? agent_id : Constants.EPHEMERAL_AGENT_ID,
    endpoint,
    model_parameters,
  })
    .then(applyKadeAudience(req))
    .catch((error) => {
    logger.error(`[/agents/:${agent_id}] Error retrieving agent during build options step`, error);
    return undefined;
  });

  /** @type {import('librechat-data-provider').TConversation | undefined} */
  const addedConvo = req.body?.addedConvo;

  return removeNullishValues({
    spec,
    iconURL,
    endpoint,
    agent_id,
    endpointType,
    chatProjectId,
    model_parameters,
    agent: agentPromise,
    addedConvo,
  });
};

module.exports = { buildOptions };
