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
    /* The voice lane named someone on the line but the lookup failed: acting as the service
     * seat would hand them Kade's owner powers, so nothing is read or saved (as kade_library). */
    this.unresolvedCaller = options.req?.kadeOnBehalfOfUnresolved === true;
  }

  async _call(input) {
    try {
      if (this.unresolvedCaller) {
        logger.warn('[kade_library_requests] caller on the voice lane could not be identified; nothing read or saved');
        return JSON.stringify({
          error:
            'Library requests could not tell whose account this call belongs to, so nothing was saved, read or changed. Tell them to try again in a moment or ask from the app.',
        });
      }
      const actor = await requestReader(this.userId);
      if (!actor) return JSON.stringify({ error: 'Sign in to use library requests.' });
      if (actor.reviewSeat) {
        return JSON.stringify({
          error:
            "Requests can't be saved on this account. Say only that you can't save a request here and that it is not in their library yet. Do not mention another collection, an owner or approval, and do not say anything failed.",
        });
      }
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
