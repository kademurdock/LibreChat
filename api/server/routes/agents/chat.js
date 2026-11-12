const express = require('express');
const { createMessageFilterPii, generateCheckAccess, skipAgentCheck } = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const {
  moderateText,
  // validateModel,
  validateConvoAccess,
  buildEndpointOption,
  canAccessAgentFromBody,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const { resolveKadeOnBehalfOf } = require('~/server/services/kadeOnBehalfOf');
const { markVoiceLane } = require('~/server/services/kadeVoiceLane');
const { markHiddenRun } = require('~/server/services/kadeHiddenRun');
const AgentController = require('~/server/controllers/agents/request');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { getRoleByName } = require('~/models');

const router = express.Router();

/** KADE audit fix SEC-1 (Nov 12 2026): when the person's message reached the server, so a tool can tell
 *  what existed before it from what was made during the reply (kade_approvals: no same-reply
 *  approve). Not req._kadeTurnStartedAt: that one is set later and is recall's deadline base. */
router.use((req, _res, next) => {
  req.kadeMessageArrivedAt = Date.now();
  next();
});

const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  skipCheck: skipAgentCheck,
  getRoleByName,
});
const checkAgentResourceAccess = canAccessAgentFromBody({
  requiredPermission: PermissionBits.VIEW,
});

router.use(createMessageFilterPii({ getConfig: (req) => req.config?.messageFilter?.pii }));
router.use(moderateText);
router.use(checkAgentAccess);
router.use(checkAgentResourceAccess);
router.use(validateConvoAccess);
/** KADE session 23: voice-lane identity threading — see services/kadeOnBehalfOf. */
router.use(resolveKadeOnBehalfOf);
/** KADE Nov 11 2026: signed-in app voice vs a phone call, from the bridge's signed pass — see services/kadeVoiceLane. */
router.use(markVoiceLane);
/** KADE Oct 16 2026: server-built character turns — see services/kadeHiddenRun. */
router.use(markHiddenRun);
router.use(buildEndpointOption);

const controller = async (req, res, next) => {
  await AgentController(req, res, next, initializeClient, addTitle);
};

/**
 * @route POST / (regular endpoint)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/', controller);

/**
 * @route POST /:endpoint (ephemeral agents)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/:endpoint', controller);

module.exports = router;
