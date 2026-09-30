const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { familyHistoryToolDescription, familyHistoryToolSchema, readFamilyHistoryTool } = require('@librechat/api');
const { getUserById } = require('~/models');

class KadeFamilyHistory extends Tool {
  constructor(options = {}) {
    super();
    this.name = 'kade_family_history';
    this.description = familyHistoryToolDescription;
    this.schema = familyHistoryToolSchema;
    this.userId = options.req?.kadeOnBehalfOf?.id || options.req?.user?.id;
    this.unresolvedCaller = options.req?.kadeOnBehalfOfUnresolved === true;
  }

  async _call(input) {
    if (!this.userId || this.unresolvedCaller)
      return JSON.stringify({ error: 'The current account could not be identified. No archive was read or note saved.' });
    try {
      // Reload grants on every invocation: the authenticated actor cannot be overridden by tool input.
      const user = await getUserById(this.userId,
        'name username email role kadeFamilyTreePerson kadeFamilyHistory kadeFamilyHistoryAskedAt');
      if (!user) return JSON.stringify({ error: 'Sign in to use family history.' });
      const actor = { ...user, id: String(this.userId) };
      const { familyToolCall } = require('~/server/routes/kadeFamilyHistory');
      return JSON.stringify(await readFamilyHistoryTool(input, familyToolCall(actor)));
    } catch (error) {
      logger.warn(`[kade_family_history] lookup failed: ${error.message}`);
      return JSON.stringify({ error: 'The family archive action could not finish. A save may have completed; check research notes before retrying. Do not infer a missing record.' });
    }
  }
}

module.exports = KadeFamilyHistory;
