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

const applyKadeAudience = (req) => (agent) => {
  if (!agent) return agent;
  // Platform-wide anti-tell style note on EVERY agent, every user.
  agent.instructions = (agent.instructions || '') + KADE_STYLE_NOTE;
  // Child accounts additionally get the clean-content audience note.
  if (req?.user?.kadeAccountType === 'child') {
    agent.instructions = agent.instructions + KADE_CHILD_NOTE;
  }
  return agent;
};

const buildOptions = (req, endpoint, parsedBody, endpointType) => {
  const { spec, iconURL, agent_id, chatProjectId, ...model_parameters } = parsedBody;
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
