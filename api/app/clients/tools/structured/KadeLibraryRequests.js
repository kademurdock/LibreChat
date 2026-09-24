const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const {
  libraryRequestsDescription,
  libraryRequestsSchema,
  compactRequestResult,
  LibraryRequestError,
} = require('@librechat/api');
const { requests, requestReader } = require('~/server/services/kadeLibraryRequests');

/** Library requests (Sep 24 2026): the librarian saves and follows up on what people want in
 * the family library. It acts as the person on the line (kadeOnBehalfOf on phone turns), so owner
 * powers come only from that person's own account. */
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
      const result = await requests.run(input || {}, actor);
      logger.info(
        `[kade_library_requests] action=${input?.action} owner=${actor.admin} duplicate=${result.duplicate === true}`,
      );
      return JSON.stringify(compactRequestResult(result));
    } catch (error) {
      if (error instanceof LibraryRequestError) return JSON.stringify({ error: error.message });
      logger.warn(`[kade_library_requests] ${input?.action} failed: ${error.message}`);
      return JSON.stringify({
        error:
          'Library requests are not answering right now. Do not say anything was saved or changed. Offer to try again in a moment.',
      });
    }
  }
}

module.exports = KadeLibraryRequests;
