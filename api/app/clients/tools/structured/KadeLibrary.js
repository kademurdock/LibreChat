const { Tool } = require('@librechat/agents/langchain/tools');
const {
  readLibraryCatalog,
  catalogProjection,
  libraryToolDescription,
  libraryToolSchema,
  familyLibraryMember,
  familyLibraryAccessNote,
  familyLibraryEmptyGuidance,
  libraryReviewSeat,
  ownUploadsOnlyNote,
} = require('@librechat/api');
const { KadeBook, KadeBookText } = require('~/models/kadeBook');
const { getUserById } = require('~/models');
const { logger } = require('@librechat/data-schemas');

class KadeLibrary extends Tool {
  constructor(options = {}) {
    super();
    this.name = 'kade_library';
    this.description = libraryToolDescription;
    this.schema = libraryToolSchema;
    this.userId = options.req?.kadeOnBehalfOf?.id || options.req?.user?.id;
    /* The voice lane named someone on the line but the lookup failed: searching as the
     * service seat would open Kade's whole library to them, so nothing is searched. */
    this.unresolvedCaller = options.req?.kadeOnBehalfOfUnresolved === true;
  }

  async _call(input) {
    try {
      if (this.unresolvedCaller) {
        logger.warn('[kade_library] caller on the voice lane could not be identified; not searching');
        return JSON.stringify({
          error:
            'The library could not tell whose account this call belongs to, so it did not search. Tell them to try again in a moment or ask from the app. Do not say the library lacks the item.',
        });
      }
      if (!this.userId) return JSON.stringify({ error: 'Sign in to search the library.' });
      const user = await getUserById(this.userId, 'name username email role kadeAccountType kadeLibraryAccess');
      if (!user) return JSON.stringify({ error: 'Sign in to search the library.' });
      /* Family library access (Sep 24 2026) covers the review seat, KADE_LIBRARY_HIDDEN_FROM,
       * test seats and accounts Kade has not approved: they search their own uploads only. */
      const reader = {
        id: String(this.userId),
        // Unknown account types fail closed as child; the owner's untyped admin seat sees everything.
        child: user.role !== 'ADMIN' && user.kadeAccountType !== 'adult',
        hidden: !familyLibraryMember({ ...user, id: String(this.userId) }),
      };
      const result = await readLibraryCatalog(input, reader, {
        search: (pipeline) => KadeBook.aggregate(pipeline).option({ maxTimeMS: 8000 }).exec(),
        details: (filter) =>
          KadeBook.findOne(filter).select(catalogProjection).maxTimeMS(8000).lean(),
        passage: async (id, section, chunk) => {
          const document = await KadeBookText.findOne({ book: id })
            .select({ sections: { $slice: [section, 1] } })
            .maxTimeMS(8000)
            .lean();
          const part = document?.sections?.[0];
          const text = part?.chunks?.[chunk];
          if (typeof text !== 'string') return null;
          const book = await KadeBook.findById(id).select('sections').lean();
          return {
            text,
            title: book?.sections?.[section]?.title || '',
            chunks: part.chunks.length,
            sections: book?.sections?.length || 0,
          };
        },
      });
      logger.info(
        `[kade_library] action=${input?.action} items=${result.items?.length ?? '-'} approximate=${result.approximate === true}${reader.hidden ? ' own-uploads-only' : ''}`,
      );
      if (!reader.hidden) return JSON.stringify(result);
      // The App Review seat keeps a silent own-uploads shelf: no word of a collection it cannot open.
      if (libraryReviewSeat({ ...user, id: String(this.userId) })) return JSON.stringify({ library: ownUploadsOnlyNote, ...result });
      /* Said in her tool result, every time, so she never calls a closed shelf empty or broken. */
      return JSON.stringify({
        familyLibrary: familyLibraryAccessNote,
        ...result,
        ...(Array.isArray(result.items) && !result.items.length ? { guidance: familyLibraryEmptyGuidance } : {}),
      });
    } catch (error) {
      logger.warn(`[kade_library] lookup failed: ${error.message}`);
      return JSON.stringify({
        error:
          'The library lookup could not finish. Try a shorter search; do not infer that an item is absent.',
      });
    }
  }
}

module.exports = KadeLibrary;
