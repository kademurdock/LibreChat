/**
 * Session 21i (Kade: "make sure everyone's spotter shows up that way" + text
 * spotter should see + text/call should share memory). Each account's Spotter
 * becomes a real, PRIVATE, textable LibreChat agent, auto-created and kept in
 * sync from their /spotter config. Text chat and live calls point at the SAME
 * agentId, so they share the same per-agent memory automatically. The text
 * agent uses a VISION model so it can describe photos/screenshots sent in chat
 * (calls stay on Gemini Live, same persona). Fail-soft everywhere: a hiccup
 * here must never break saving a Spotter or minting a call.
 */
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const { ResourceType, AccessRoleIds, PrincipalType } = require('librechat-data-provider');
const db = require('~/models');
const { grantPermission } = require('~/server/services/PermissionService');
const { getSpotter } = require('./kadeSpotter');

const SPOTTER_TEXT_MODEL = process.env.KADE_SPOTTER_TEXT_MODEL || 'google/gemini-3.1-pro-preview';

function KadeSpotterModel() {
  return mongoose.models.KadeSpotter || mongoose.model('KadeSpotter');
}

/** Persona framed so the same character reads naturally in text AND on a call. */
function spotterInstructions(name, persona) {
  return (
    `You are ${name} — the user's personal Spotter. On a live video call you are their eyes through the camera; ` +
    `in text chat you are the very same person: warm, sharp, honest company who can also describe any photo or ` +
    `screenshot they send you and help with anything else. They can reach you either way, and you remember both ` +
    `sides of the relationship. Everything below is who you are.\n\n` +
    (persona || '')
  );
}

/**
 * Make sure `userId` has a Spotter agent that matches their current /spotter
 * config; create it the first time, update it on later edits. Returns the
 * agentId, or null if they haven't set up a Spotter yet.
 */
async function ensureSpotterAgent(userId, spotter) {
  try {
    const uid = String(userId || '');
    if (!uid) return null;
    const sp = spotter || (await getSpotter(uid));
    if (!sp || !sp.name) return null; // no Spotter configured yet — nothing to mirror
    const Model = KadeSpotterModel();
    const row = await Model.findOne({ userId: uid }).lean();
    const instructions = spotterInstructions(sp.name, sp.persona);

    if (row && row.agentId) {
      try {
        await db.updateAgent({ id: row.agentId }, { name: sp.name, instructions });
      } catch (e) {
        logger.warn('[spotterAgent] update failed for ' + row.agentId + ': ' + (e && e.message));
      }
      return row.agentId;
    }

    const agentData = {
      id: `agent_${nanoid()}`,
      author: uid,
      name: sp.name,
      description: `Your personal Spotter — call ${sp.name} to see through your camera, or just text ${sp.name} anytime.`,
      instructions,
      provider: 'OpenRouter',
      model: SPOTTER_TEXT_MODEL,
      model_parameters: { temperature: 0.8, top_p: 0.9, maxContextTokens: 600000 },
      category: 'general',
      tools: [],
    };
    const agent = await db.createAgent(agentData);
    try {
      await Promise.all([
        grantPermission({
          principalType: PrincipalType.USER,
          principalId: uid,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          accessRoleId: AccessRoleIds.AGENT_OWNER,
          grantedBy: uid,
        }),
        grantPermission({
          principalType: PrincipalType.USER,
          principalId: uid,
          resourceType: ResourceType.REMOTE_AGENT,
          resourceId: agent._id,
          accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
          grantedBy: uid,
        }),
      ]);
    } catch (e) {
      logger.warn('[spotterAgent] permission grant failed for ' + agent.id + ': ' + (e && e.message));
    }
    await Model.updateOne({ userId: uid }, { $set: { agentId: agent.id } });
    logger.info('[spotterAgent] created ' + agent.id + ' (' + sp.name + ') for user ' + uid);
    return agent.id;
  } catch (e) {
    logger.error('[spotterAgent] ensure failed: ' + (e && e.message));
    return null;
  }
}

module.exports = { ensureSpotterAgent, spotterInstructions };
