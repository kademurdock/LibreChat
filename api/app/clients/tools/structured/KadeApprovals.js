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
        'list = requests waiting on Kade and recent outcomes. approve = run a waiting request, ONLY when the message Kade just sent says yes to it. deny = drop it when she says no.',
    },
    approvalId: { type: 'string', description: 'approve or deny: the request id (starts with "a"), from list or from the held action.' },
  },
  required: ['action'],
};

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
      'list shows what is waiting. approve runs a waiting request, and only works when the message she just sent says yes; never call it on your own judgment. deny drops one.';
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
      const herText = typeof req.body?.text === 'string' ? req.body.text : '';
      if (action === 'approve' && !approvals.herWordsApprove(herText)) {
        return 'Not approved: her message this turn does not say yes to it. Ask her plainly, and approve only after she says yes. Or she can tap Approve on her phone.';
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
