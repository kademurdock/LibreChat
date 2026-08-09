const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KADE MEMORY SEARCH — the explicit half of Living Diary retrieval (Aug 7 2026).
 * Design: MEMORY_TIERED_DIARY_DESIGN_2026-08-07.md (her answers: retrieval =
 * automatic AND explicit; all agents, card-style scoping).
 *
 * The automatic per-turn lookup (client.js tail) quietly surfaces the top few
 * related entries. THIS tool is the deliberate reach — "let me think, what did
 * you tell me about that…" — for when the user plainly asks what they've said
 * before, what they were up to on some date, or when the character chooses to
 * check its notes. Searches the LOGBOOK archive only; memory cards already ride
 * the character's own head and never need a tool to see.
 *
 * PRIVACY: the search is server-side scoped to shared entries + THIS agent's
 * own — another character's logbook is structurally unreachable, same rule as
 * cards. Kill switch KADE_DIARY=0 empties every search.
 */

const memorySearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "What to look for, in plain words (e.g. 'her dog's vet visits', 'that show she was watching', 'how the SSA paperwork went'). Meaning-based — related wording still matches. Omit to just flip through recent entries by date.",
    },
    date_from: {
      type: 'string',
      description:
        "Optional start date YYYY-MM-DD (US Central). Use with date_to for ranges like 'last week' — work the real dates out from today's date.",
    },
    date_to: {
      type: 'string',
      description: 'Optional end date YYYY-MM-DD (US Central), inclusive.',
    },
    limit: {
      type: 'integer',
      description: 'Max entries to return (1-12). Default 5.',
    },
  },
  required: [],
};

class KadeMemorySearch extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.agentId = fields.agentId;
    this.name = 'kade_memory_search';
    this.description =
      "Search the user's private dated logbook — the long-term archive of their day-to-day life beyond your always-visible memory cards. " +
      "Use it when the user asks what they've told you before ('have I mentioned…', 'what was I up to last week', 'when did I…'), when they ask you to check your notes, or when a specific past detail would genuinely help and isn't in your cards. " +
      'Search by meaning (query), by date range, or both.';
    this.description_for_model =
      this.description +
      ' Weave whatever you find in naturally, like a friend recalling — mention the day in passing if it helps ("back at the start of the month you said…"). Never read entries out as a list unless the user asks for exactly that, never invent entries, and if the tool returns nothing say honestly that your notes don\'t show it. If an entry contradicts what the user is telling you right now, believe the user. For date ranges, compute real YYYY-MM-DD dates from today\'s date first. WHEN-shaped questions (\'when did I\u2026\', \'how long ago\u2026\', \'when did X change\') are temporal: every entry returns dated, so answer from the DATES \u2014 name the day or the distance plainly (\'that was July 12th, about a month back\'), and if the story changed over time, tell it in date order using a wider limit.';
    this.schema = memorySearchJsonSchema;
  }

  async _call(data) {
    const { query, date_from, date_to, limit } = data || {};
    if (!this.userId) {
      return 'Memory search is unavailable right now (no user context).';
    }
    if (!query && !date_from && !date_to) {
      return "Give me a query (what to look for) and/or a date range (date_from/date_to). Example: query='her garden project' or date_from=2026-08-01, date_to=2026-08-07 for that week.";
    }
    const dateOk = (s) => !s || /^\d{4}-\d{2}-\d{2}$/.test(String(s));
    if (!dateOk(date_from) || !dateOk(date_to)) {
      return 'Dates must be formatted YYYY-MM-DD (e.g. 2026-08-01).';
    }
    try {
      const { searchDiary, diaryEnabled } = require('~/models/kadeDiary');
      if (!diaryEnabled()) {
        return 'The logbook is currently turned off.';
      }
      const hits = await searchDiary({
        userId: this.userId,
        agentId: this.agentId,
        query: query || null,
        dateFrom: date_from || null,
        dateTo: date_to || null,
        limit: limit || 5,
      });
      if (!hits || hits.length === 0) {
        return query
          ? `No logbook entries match "${query}"${date_from || date_to ? ' in that date range' : ''}. The logbook only holds day-to-day entries logged since it began — do not guess; say your notes don't show it.`
          : 'No logbook entries in that date range.';
      }
      const lines = hits.map((h) => `[${h.date}] ${h.text}`);
      return (
        `${hits.length} logbook ${hits.length === 1 ? 'entry' : 'entries'} found (newest relevance first). Weave in naturally — never recite as a list unless asked:\n` +
        lines.join('\n')
      );
    } catch (e) {
      logger.error('[KadeMemorySearch] search failed:', e.message);
      return 'The logbook search hit an error just now — let the user know you could not check your notes.';
    }
  }
}

module.exports = KadeMemorySearch;
