const { Tool } = require('@librechat/agents/langchain/tools');
const {
  readLibraryCatalog,
  catalogProjection,
  libraryToolDescription,
  libraryToolSchema,
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
  }

  async _call(input) {
    try {
      if (!this.userId) return JSON.stringify({ error: 'Sign in to search the library.' });
      const user = await getUserById(this.userId, 'email kadeAccountType');
      if (!user) return JSON.stringify({ error: 'Sign in to search the library.' });
      const hiddenFrom = String(
        process.env.KADE_LIBRARY_HIDDEN_FROM || 'kadeai.vischeck722@gmail.com',
      )
        .toLowerCase()
        .split(',')
        .map((value) => value.trim());
      const reader = {
        id: String(this.userId),
        child: user.kadeAccountType !== 'adult',
        hidden:
          hiddenFrom.includes(String(this.userId).toLowerCase()) ||
          hiddenFrom.includes(String(user.email || '').toLowerCase()),
      };
      // The existing account schema defaults to adult; unknown values fail closed.
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
        `[kade_library] action=${input?.action} items=${result.items?.length ?? '-'} approximate=${result.approximate === true}`,
      );
      return JSON.stringify(result);
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
