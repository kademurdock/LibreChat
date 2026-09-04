/**
 * KADE CANON, read side (Part 124, Sep 4 2026). A character's own life — the
 * self-facts it has said to anyone — is stored as memory cards under a fixed
 * owner id (CANON_USER_ID in @librechat/api) scoped by agentId, and read back
 * into that character's STABLE head for every person it talks to. The write
 * side (scope "self" on set_memory, the fabrication guard) lives in
 * packages/api/src/agents/memory.ts. This file exists because client.js builds
 * the head from the pinned-card split when card recall is on, which discards
 * anything appended to `withoutKeys` — so canon needs its own hook.
 */
const { getFormattedMemories } = require('~/models');
const { CANON_USER_ID, CANON_HEADER } = require('@librechat/api');

const CANON_MAX_CHARS = parseInt(process.env.KADE_CANON_MAX_CHARS || '4000', 10);

async function getCanonBlock(agentId) {
  if (!agentId || process.env.KADE_CANON === '0') return '';
  const { withoutKeys } = await getFormattedMemories({ userId: CANON_USER_ID, agentId });
  const body = String(withoutKeys || '').trim();
  if (!body) return '';
  const clipped = body.length > CANON_MAX_CHARS ? body.slice(0, CANON_MAX_CHARS) + '\n(…canon clipped; retire old cards)' : body;
  return `${CANON_HEADER}\n${clipped}`;
}

module.exports = { getCanonBlock };
