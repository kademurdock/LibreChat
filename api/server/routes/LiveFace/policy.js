/**
 * Who may open a live video face, and for which character. Pure, so the
 * decision is testable without a server (kadeLiveFace.nodetest.js).
 *
 * Kade's rule (Oct 28 2026): live faces are for people who can see them. A
 * blind account never pays for a video it cannot watch; it keeps the free
 * painted faces. Nobody is charged until they have said they use the screen.
 */
function parseFaces(raw) {
  // SIMLI_FACES: JSON {"agent_id": "faceId", ...} or "agent_id=faceId,agent_id=faceId"
  const text = String(raw || '').trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        if (k && typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    } catch (_) {
      return {};
    }
  }
  const out = {};
  for (const pair of text.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) {
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
  }
  return out;
}

/* Returns { ok: true, faceId } or { ok: false, code, reason }. */
function decide({ configured, faces, agentId, sight, liveFaces }) {
  if (!configured) return { ok: false, code: 'unconfigured', reason: 'Live faces are not set up on this server yet.' };
  const faceId = faces && agentId ? faces[String(agentId)] : null;
  if (!faceId) return { ok: false, code: 'no_face', reason: 'This character has no live face yet.' };
  if (sight !== 'sighted') {
    return { ok: false, code: 'not_sighted', reason: 'Live faces are only opened for accounts that use the screen.' };
  }
  if (liveFaces === false) return { ok: false, code: 'off', reason: 'Live faces are turned off for this account.' };
  return { ok: true, faceId };
}

/* The env map wins over the registry, so a hand-made face is never shadowed. */
function mergeFaces(envFaces, registryFaces) {
  return { ...(registryFaces || {}), ...(envFaces || {}) };
}

module.exports = { parseFaces, decide, mergeFaces };
