const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/* Kept identical to kadeApprovalsSchema in packages/api/src/tools/registry/definitions.ts. */
const kadeApprovalsSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'approve', 'deny'],
      description:
        'list = requests waiting on Kade and recent outcomes. approve = run a waiting request, ONLY when the message Kade just sent is a plain yes to it and the request was made in an EARLIER reply (never one made in this reply). One approve per reply. deny = drop it when she says no.',
    },
    approvalId: { type: 'string', description: 'approve or deny: the request id (starts with "a"), from list or from the held action.' },
  },
  required: ['action'],
};

/* Audit fix SEC-1 (Nov 12 2026): an approval follows the same yes rules as a paid start
 * (services/kadeSpendGate.js, kade_task):
 *   - only her own latest words count (a voice turn's folded history is cut off; a retried or
 *     edited message is never a new yes);
 *   - the whole message must BE the yes: "ok, fix the login bug" and "ok, make a PR" are not a
 *     yes to a merge;
 *   - the request must have existed before her message, so Forge cannot hold an action and
 *     approve it in the same reply. Only a time PROVEN earlier passes;
 *   - Kade's rule (Nov 12 2026): when more than one request made before her message is still
 *     waiting, a plain yes approves none of them. Forge must say which ones are waiting and ask
 *     her which; her yes is not tied to any one of them;
 *   - one approval per message, claimed only for a request that can still run.
 * No off switch, like the spend gate: roll back the build if it misbehaves. */
const SHIP_TOPIC = ['merge', 'merged', 'deploy', 'deployed', 'ship', 'shipped', 'commit', 'push', 'pr', 'pull', 'request', 'change', 'changes', 'setting', 'live', 'approval'];
/* The yes words include "make", "start", "send", "a" (a price yes: "make it", "start it"). Next to
 * the shipping words they would let a NEW job through ("ok, make a PR", "send me the PR", "can
 * you commit and push that"), so here they count only as "make it / that / this". */
const NEW_WORK =
  /\b(?:make|start|begin|run|send|work|want|like|love)\b(?!\s+(?:it|that|this)\b)|\b(?:a|an|another)\b|\b(?:can|could|would|will)\s+you\b/;

const NOT_A_YES =
  'Not approved: her message this turn is not a plain yes to it. Tell her what it does, ask her plainly, and approve only after her next message is a yes. Or she can tap Approve on her phone.';
const WHICH_ONE =
  'Not approved: more than one request is waiting, so a plain yes does not say which. Nothing was run. Tell her, in a sentence each, what is waiting, and ask which one she means. Or she can tap Approve on her phone.';

async function approveRefusal(req, approvals, approvalId) {
  const spend = require('~/server/services/kadeSpendGate');
  const said = spend.latestWords(req && req.body && req.body.text);
  if (!said.ok || spend.isReplay(req)) return NOT_A_YES;
  if (!spend.approvesPrice(said.words, { names: ['Forge'], topic: SHIP_TOPIC })) return NOT_A_YES;
  if (NEW_WORK.test(said.words.toLowerCase())) return NOT_A_YES;
  const pending = await approvals.get(approvalId);
  if (!pending) return 'No such request. Use list to see what is waiting.';
  if (pending.status !== 'pending' || !(new Date(pending.expiresAt).getTime() > Date.now())) {
    return `That request is not waiting any more (${pending.status === 'pending' ? 'expired' : pending.status}). Use list to see what is waiting.`;
  }
  const arrived = Number(req && req.kadeMessageArrivedAt) || 0;
  const created = new Date(pending.createdAt).getTime();
  /* Written so NaN (no time on either side) refuses. */
  if (!(arrived > 0 && created < arrived)) {
    return 'Not approved: that request was made during this reply, so she has not heard it yet. Tell her what it does and ask; approve only after her next message says yes.';
  }
  /* Kade's rule: two or more waiting from before her message, and a plain yes names none of them.
   * list() marks a run-out row 'expired', so only live ones count. Fails closed. */
  let waiting;
  try {
    waiting = (await approvals.list({ status: 'pending', limit: 50 })).filter(
      (row) => row && row.status === 'pending' && new Date(row.createdAt).getTime() < arrived,
    );
  } catch (_) {
    return 'Not approved: I could not check what else is waiting. Ask her again in a moment, or she can tap Approve on her phone.';
  }
  if (waiting.length > 1) return WHICH_ONE;
  if (!spend.claimOnce(req, 'kade_approvals_approve')) return 'One approval per message. Ask her about the next one.';
  return null;
}

/**
 * KADE APPROVALS, the chat side (Oct 16 2026; services/kadeApprovals.js).
 * Forge cannot approve his own request: approve works only when Kade's own
 * message on this very turn says yes, on her own seat. The button on her
 * phone is the other way in.
 */
class KadeApprovals extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_approvals';
    this.description =
      'Kade\'s approvals for shipping work: merges into live branches, commits straight to live branches, deploys and setting changes wait for her yes. ' +
      'list shows what is waiting. approve runs a waiting request, and only works when the message she just sent is a plain yes and the request was made in an earlier reply; ' +
      'a request you made in this reply cannot be approved in this reply: tell her what it does, ask, and stop. When more than one request is waiting, a plain yes approves none: ask her which one. ' +
      'Never call approve on your own judgment. deny drops one.';
    this.schema = kadeApprovalsSchema;
    this.req = fields.req;
  }

  async _call(data) {
    const approvals = require('~/server/services/kadeApprovals');
    const action = String((data && data.action) || '');
    const req = this.req || {};
    const user = req.user || {};
    try {
      if (String(user.role || '').toUpperCase() !== 'ADMIN') return 'Approvals are Kade\'s alone.';
      if (action === 'list') {
        const rows = await approvals.list({ limit: 10 });
        return JSON.stringify({ approvals: rows });
      }
      if (action !== 'approve' && action !== 'deny') return 'Use list, approve or deny.';
      const { ownsPrivateMemory } = require('@librechat/api');
      if (!ownsPrivateMemory(req) || req.kadeHiddenRun === true) {
        return 'Not from here: an approval has to come from Kade herself, on her own seat.';
      }
      if (action === 'approve') {
        const refusal = await approveRefusal(req, approvals, data && data.approvalId);
        if (refusal) return refusal;
      }
      const out = await approvals.decide({ approvalId: data.approvalId, decision: action, by: 'words' });
      return JSON.stringify({ status: out.status, said: out.resultWords || out.error || '', summary: out.summary });
    } catch (e) {
      logger.warn('[KadeApprovals] ' + (e && e.message));
      return `Approvals had a problem: ${String((e && e.message) || e).slice(0, 160)}. Say so plainly.`;
    }
  }
}

module.exports = KadeApprovals;
module.exports.approveRefusal = approveRefusal;
module.exports.NEW_WORK = NEW_WORK;
