'use strict';
/* Audit fix (Nov 12 2026, SEC-7): may this person use this character outside the chat route? The
 * same VIEW rule the chat route applies (canAccessAgentFromBody): the admin, the author, or an ACL
 * grant (shared with them, or public). Fails closed. Lookups by id read three fields only: an
 * agent document carries every saved version and can be many megabytes. */
const mongoose = require('mongoose');
const { ResourceType, PermissionBits } = require('librechat-data-provider');

const isAdmin = (user) => String((user && user.role) || '').toUpperCase() === 'ADMIN';
const uidOf = (user) => String((user && (user.id || user._id)) || '');

async function canUseAgent(user, agentOrId) {
  try {
    const uid = uidOf(user);
    if (!uid) return false;
    const agent =
      typeof agentOrId === 'string'
        ? await mongoose.models.Agent.findOne({ id: agentOrId }, '_id id author').lean()
        : agentOrId;
    if (!agent || !agent._id) return false;
    if (isAdmin(user)) return true;
    if (String(agent.author) === uid) return true;
    const { checkPermission } = require('~/server/services/PermissionService');
    return (
      (await checkPermission({
        userId: uid,
        role: user.role,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        requiredPermission: PermissionBits.VIEW,
      })) === true
    );
  } catch (_) {
    return false;
  }
}

/* The ids out of `ids` this person may use, in two queries however long the list is. */
async function usableAgentIds(user, ids) {
  try {
    const uid = uidOf(user);
    const list = [...new Set((ids || []).map(String))].filter(Boolean).slice(0, 5000);
    if (!uid || !list.length) return new Set();
    if (isAdmin(user)) return new Set(list);
    const { findAccessibleResources } = require('~/server/services/PermissionService');
    const [agents, granted] = await Promise.all([
      mongoose.models.Agent.find({ id: { $in: list } }, '_id id author').lean(),
      findAccessibleResources({
        userId: uid,
        role: user.role,
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      }),
    ]);
    const ok = new Set((granted || []).map((oid) => String(oid)));
    return new Set(
      (agents || [])
        .filter((a) => a && a._id && (String(a.author) === uid || ok.has(String(a._id))))
        .map((a) => String(a.id)),
    );
  } catch (_) {
    return new Set();
  }
}

/* "Personas are private" (Part 215) for the side lanes that build their own system prompt.
 * Same exemption and kill switch as the chat lane (Endpoints/agents/build.js). */
function confidentialNoteFor(user) {
  if (process.env.KADE_CONFIDENTIAL_NOTE === '0' || isAdmin(user)) return '';
  try {
    return String(require('~/server/services/Endpoints/agents/build').KADE_CONFIDENTIAL_NOTE || '').trim();
  } catch (_) {
    return '';
  }
}

module.exports = { canUseAgent, usableAgentIds, confidentialNoteFor };
