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
          /* The one-file rule (Sep 25 2026): a shortcut reads its keeper's words, and only while
           * this reader could open that file (a shortcut is never more open than its file). */
          let book = await KadeBook.findById(id).select('shortcutOf owner sections').maxTimeMS(8000).lean();
          let fileId = id;
          if (book && book.shortcutOf) {
            const file = await KadeBook.findById(book.shortcutOf).select('owner shared grownUpsOnly state sections').maxTimeMS(8000).lean();
            const { canOpen } = require('~/server/services/kadeLibraryFilesPlan');
            if (!file || file.state !== 'ready') return null;
            if (String(file.owner) !== String(book.owner) && !canOpen({ ...reader, admin: user.role === 'ADMIN' }, file)) return null;
            if (reader.child && file.grownUpsOnly) return null;
            fileId = file._id;
            book = file;
          }
          const document = await KadeBookText.findOne({ book: fileId })
            .select({ sections: { $slice: [section, 1] } })
            .maxTimeMS(8000)
            .lean();
          const part = document?.sections?.[0];
          const text = part?.chunks?.[chunk];
          if (typeof text !== 'string') return null;
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
