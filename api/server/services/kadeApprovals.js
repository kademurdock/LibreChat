/**
 * KADE APPROVALS (Oct 16 2026). Kade's decision: "Approve, then he ships."
 *
 * Forge works on a branch and opens a pull request at once. Anything that
 * reaches a live service (a merge, a commit straight to a live branch, a
 * deploy, a setting change) is held by the voice server (inworld approvals.js)
 * and recorded HERE, in the site's database, so no redeploy loses it. Kade's
 * phone gets a push with the plain summary.
 *
 * A request runs only on HER yes, one of two ways:
 *   - the Approve button (iPhone Approvals screen, route "approvals"), which
 *     calls POST /api/kade/approvals/:id/decide with her own admin sign-in;
 *   - her own words in a chat with Forge: the kade_approvals tool approves only
 *     when the message SHE sent this turn says yes (and no "wait" or "don't"),
 *     on her own seat. The model cannot approve by itself; the words have to be
 *     hers.
 * The site then asks the voice server to run it (KADE_APPROVAL_SECRET, never
 * held by any agent action), and the outcome is posted into her conversation
 * with Forge, with a push. After a merge into a live branch the voice server
 * watches the deploy and the site says when it is live, or that it failed.
 *
 * Requests expire after 24 hours. Kill switch for the gate itself:
 * FORGE_APPROVALS=0 on the voice server.
 */
'use strict';

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');

const COLL = 'kadeapprovals';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DAY = 24 * 3600000;

function coll() {
  return require('mongoose').connection.collection(COLL);
}

function ownerId() {
  return require('./kadeHiddenRun').ownerId();
}

function inworldBase() {
  return (process.env.INWORLD_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app').replace(/\/$/, '');
}

/** What may be shown: the summary and the shape, never a setting's value or a file body. */
function publicView(a) {
  if (!a) return null;
  return {
    approvalId: a.approvalId,
    kind: a.kind,
    status: a.status,
    summary: a.summary,
    revert: a.revert || '',
    agentId: a.agentId,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt || null,
    decidedBy: a.decidedBy || null,
    resultWords: a.resultWords || '',
    deployWords: a.deployWords || '',
    error: a.error || '',
  };
}

async function notifyOwner({ title, body, urgent = true }) {
  const bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
  const secret = process.env.BRIDGE_SECRET || '';
  if (!secret) return null;
  try {
    const r = await fetch(`${bridgeUrl}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        secret,
        agentId: 'kade-approvals',
        agentName: 'Forge',
        title: String(title).slice(0, 40),
        body: String(body).slice(0, 300),
        userId: ownerId(),
        adminAlert: true,
        urgent,
        route: 'approvals',
      }),
      signal: AbortSignal.timeout(20000),
    });
    return await r.json().catch(() => null);
  } catch (e) {
    logger.warn('[kadeApprovals] push failed: ' + e.message);
    return null;
  }
}

async function create({ kind, params, summary, revert, agentId }) {
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(String(kind || ''))) throw new Error('bad kind');
  const now = new Date();
  const approvalId = `a${crypto.randomBytes(5).toString('hex')}`;
  const doc = {
    approvalId,
    kind,
    params: params || {},
    summary: String(summary || '').slice(0, 900),
    revert: String(revert || '').slice(0, 300),
    agentId: String(agentId || 'agent_FFecOqZ6hHCVpY507-VAD'),
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + DAY),
  };
  await coll().insertOne(doc);
  await notifyOwner({ title: 'Forge asks to ship', body: `${doc.summary} Approve or say no in Approvals, or tell Forge.` });
  logger.info(`[kadeApprovals] ${approvalId} pending: ${kind}`);
  return { approvalId };
}

async function get(approvalId) {
  return publicView(await coll().findOne({ approvalId: String(approvalId || '') }));
}

async function list({ status, limit = 20 } = {}) {
  const filter = status ? { status } : {};
  const rows = await coll().find(filter).sort({ createdAt: -1 }).limit(Math.min(50, limit)).toArray();
  const now = Date.now();
  return rows.map((r) => publicView(r.status === 'pending' && new Date(r.expiresAt).getTime() < now ? { ...r, status: 'expired' } : r));
}

function resultWords(kind, result) {
  if (!result) return 'Done.';
  if (kind === 'github-merge') return result.merged ? `Merged as ${String(result.sha || '').slice(0, 12)}${result.watchingDeploy ? '; I am watching the deploy and will say when it is live.' : '.'}` : 'GitHub did not merge it.';
  if (kind === 'github-commit' || kind === 'github-commit-files') return `Committed as ${String(result.commitSha || '').slice(0, 12)}.`;
  if (kind === 'railway-deploy') return result.deployed ? `Deploy started for ${String(result.commitSha || '').slice(0, 12)}.` : 'Railway did not start the deploy.';
  if (kind === 'railway-vars') return result.set ? `Set ${result.name}.` : 'Railway did not take the setting.';
  return 'Done.';
}

/** Post a plain message (no model call) into Kade's conversation with the requesting character. */
async function tellKade(approval, text) {
  try {
    const { post, notifyPost } = require('./kadeCharacterTurn');
    const placed = await post({ userId: ownerId(), agentId: approval.agentId, text, kind: 'approval' });
    await notifyPost({ userId: ownerId(), agentId: approval.agentId, agentName: 'Forge', text, conversationId: placed.conversationId, requested: true });
  } catch (e) {
    logger.warn('[kadeApprovals] could not post the outcome: ' + e.message);
  }
}

/**
 * Her decision. `by` is "button" or "words". Only a pending, unexpired request moves.
 * @returns {Promise<object>} the public view after the decision
 */
async function decide({ approvalId, decision, by }) {
  const now = new Date();
  const approve = decision === 'approve';
  const claimed = await coll().findOneAndUpdate(
    { approvalId: String(approvalId || ''), status: 'pending', expiresAt: { $gt: now } },
    { $set: { status: approve ? 'running' : 'denied', decidedAt: now, decidedBy: by } },
    { returnDocument: 'after' },
  );
  const doc = claimed && (claimed.value !== undefined ? claimed.value : claimed);
  if (!doc || !doc.approvalId) {
    const existing = await coll().findOne({ approvalId: String(approvalId || '') });
    if (!existing) throw Object.assign(new Error('no such request'), { status: 404 });
    throw Object.assign(new Error(`that request is already ${new Date(existing.expiresAt) < now && existing.status === 'pending' ? 'expired' : existing.status}`), { status: 409 });
  }
  if (!approve) {
    await tellKade(doc, `Okay, I won't. Nothing changed: ${doc.summary}`);
    return publicView(doc);
  }
  const secret = process.env.KADE_APPROVAL_SECRET || '';
  let update;
  try {
    if (!secret) throw new Error('the approval key is not set on the site');
    const r = await fetch(`${inworldBase()}/approvals/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-kade-approval-secret': secret },
      body: JSON.stringify({ approvalId: doc.approvalId, kind: doc.kind, params: doc.params }),
      signal: AbortSignal.timeout(120000),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) throw new Error(out.error || `the voice server said ${r.status}`);
    update = { status: 'done', result: out.result, resultWords: resultWords(doc.kind, out.result) };
  } catch (e) {
    update = { status: 'failed', error: String(e.message || e).slice(0, 300) };
  }
  /* A setting's value and a file's body are not kept once the request has run. */
  await coll().updateOne(
    { approvalId: doc.approvalId },
    { $set: { ...update, finishedAt: new Date() }, $unset: { 'params.value': 1, 'params.content': 1, 'params.files': 1 } },
  );
  const after = await coll().findOne({ approvalId: doc.approvalId });
  await tellKade(
    after,
    after.status === 'done'
      ? `You approved it, and it's done. ${after.resultWords} (${after.summary})`
      : `You approved it, but it didn't go through: ${after.error}. Nothing else changed.`,
  );
  return publicView(after);
}

/** The voice server's went-live report after a merge. */
async function followup({ approvalId, deploy }) {
  const doc = await coll().findOne({ approvalId: String(approvalId || '') });
  if (!doc) throw Object.assign(new Error('no such request'), { status: 404 });
  const d = deploy || {};
  const words =
    d.status === 'SUCCESS'
      ? `It's live: ${d.service || 'the service'} is running ${d.commitSha}.`
      : d.status === 'FAILED' || d.status === 'CRASHED'
        ? `The deploy of ${d.commitSha} to ${d.service || 'the service'} failed, so the old version is still running. I'll look at why.`
        : `I couldn't confirm the deploy of ${d.commitSha || 'that commit'} (${d.note || 'no answer'}). I'll check it by hand.`;
  await coll().updateOne({ approvalId: doc.approvalId }, { $set: { deploy: d, deployWords: words } });
  await tellKade(doc, words);
  return { ok: true };
}

/**
 * Did the person's own message this turn say yes? Plain words only; any hold-on word wins.
 * @param {string} text
 */
function herWordsApprove(text) {
  const t = String(text || '').toLowerCase().replace(/[’]/g, "'");
  if (!t.trim() || t.length > 600) return false;
  if (/\b(no|nope|don't|do not|wait|hold on|hold off|not yet|stop|cancel|never|deny|denied)\b/.test(t)) return false;
  return /\b(yes|yeah|yep|yup|approve[ds]?|go ahead|ship it|do it|merge it|deploy it|send it|okay|ok|sure|let's go|go for it)\b/.test(t);
}

module.exports = { create, get, list, decide, followup, herWordsApprove, publicView };
