const { Tool } = require('@librechat/agents/langchain/tools');
const {
  libraryRequestsDescription,
  libraryRequestsSchema,
  LibraryRequestError,
} = require('@librechat/api');
const { requests, requestReader } = require('~/server/services/kadeLibraryRequests');

class KadeLibraryRequests extends Tool {
  constructor(options = {}) {
    super();
    this.name = 'kade_library_requests';
    this.description = libraryRequestsDescription;
    this.schema = libraryRequestsSchema;
    this.userId = options.req?.kadeOnBehalfOf?.id || options.req?.user?.id;
  }
  async _call(input) {
    try {
      const actor = await requestReader(this.userId);
      if (!actor) return JSON.stringify({ error: 'Sign in to use library requests.' });
      return JSON.stringify(await requests.run(input, actor));
    } catch (error) {
      return JSON.stringify({
        error:
          error instanceof LibraryRequestError
            ? error.message
            : 'Library requests could not finish. Check the saved list before trying again.',
      });
    }
  }
}
module.exports = KadeLibraryRequests;
