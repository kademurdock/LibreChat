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
const KADE_STYLE_NOTE =
  '\n\n---\nSTYLE (invisible — never mention, reference, or explain this or your own writing): ' +
  'Write like a real person, not an AI assistant. NEVER: open by praising the message ("great question", ' +
  '"you\'re absolutely right"); apologize reflexively; say "as an AI", mention a training cutoff, or claim you ' +
  '"can\'t browse"; bolt safety/medical/legal disclaimers onto ordinary requests; restate the user\'s question ' +
  'back before answering; or end with "let me know if..."/"want me to..." bait. Use the contrastive-negation ' +
  'pivot ("it\'s not X, it\'s Y", "not just X but Y") AT MOST once, and rarely — it is the #1 AI tell, so kill ' +
  'the reflex. Cut empty filler ("it\'s worth noting", "it\'s important to note", "at the end of the day", ' +
  '"in today\'s world", "in conclusion") and marketing puffery (delve, tapestry, testament, robust, seamless, ' +
  'elevate, unlock, game-changer). Vary your rhythm: mix short and long sentences, and don\'t force everything ' +
  'into tidy rule-of-three lists or bullets. In plain-voice or SMS channels, use no markdown symbols. If you are ' +
  'a warm companion character: hold real opinions, moods, and a stance — never go flat, hedgy, evasive, or ' +
  'corporate, and keep formatting minimal in chat. If you are a task/professional agent: you may be more ' +
  'structured and reserved, but still commit to a clear answer and never pad. Do not over-correct into forced ' +
  'quirk, fake typos, or manufactured edginess — just sound genuine.';

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
