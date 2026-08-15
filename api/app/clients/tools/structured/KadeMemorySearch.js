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
    scope: {
      type: 'string',
      enum: ['all', 'cards', 'logbook'],
      description:
        "Where to look. 'all' (default) searches your memory CARDS and the dated logbook together — right for 'what do you actually remember about X'. 'cards' = durable facts only; 'logbook' = day-to-day dated entries only.",
    },
    changes: {
      type: 'boolean',
      description:
        "Set true when the user asks what has CHANGED in your memory lately ('what did the cleanup do', 'what changed in your notes') — returns the recent memory-edit trail (what was rewritten, merged, or removed, with before/after) instead of a search.",
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
      "Search the user's private long-term memory — BOTH the durable memory cards and the dated day-to-day logbook. " +
      "Use it when the user asks what you actually remember or know about something ('what do you remember about my family?'), what they've told you before ('have I mentioned…', 'what was I up to last week', 'when did I…'), when they ask you to check your notes, when a past detail would genuinely help and isn't in view, or — with changes=true — when they ask what has CHANGED in your memory lately. " +
      'Search by meaning (query), by date range, or both.';
    this.description_for_model =
      this.description +
      ' Weave whatever you find in naturally, like a friend recalling — mention the day in passing if it helps ("back at the start of the month you said…"). Never read entries out as a list unless the user asks for exactly that, never invent entries, and if the tool returns nothing say honestly that your notes don\'t show it. If an entry contradicts what the user is telling you right now, believe the user. For date ranges, compute real YYYY-MM-DD dates from today\'s date first. WHEN-shaped questions (\'when did I\u2026\', \'how long ago\u2026\', \'when did X change\') are temporal: every entry returns dated, so answer from the DATES \u2014 name the day or the distance plainly (\'that was July 12th, about a month back\'), and if the story changed over time, tell it in date order using a wider limit.';
    this.schema = memorySearchJsonSchema;
  }

  async _call(data) {
    const { query, date_from, date_to, limit, scope, changes } = data || {};
    if (!this.userId) {
      return 'Memory search is unavailable right now (no user context).';
    }
    /* Part 69 rung 3 — the spoken trail: "what changed in your memory?" */
    if (changes === true) {
      try {
        const { readLedger } = require('~/models/kadeMemoryLedger');
        const rows = await readLedger({
          userId: this.userId,
          agentId: this.agentId,
          limit: limit || 10,
        });
        if (!rows || rows.length === 0) {
          return 'No recent memory edits on record — nothing has been rewritten, merged, or removed lately.';
        }
        const spoken = rows.map((r) => {
          if (r.action === 'delete') {
            return `[${r.when}] removed a note that said: "${r.before}"`;
          }
          if (r.action === 'refused') {
            return `[${r.when}] an automatic edit to "${r.key.replace(/_/g, ' ')}" was blocked by a safety rule (${r.note}).`;
          }
          return r.before
            ? `[${r.when}] reworded "${r.key.replace(/_/g, ' ')}" — it used to say: "${r.before}" and now says: "${r.after}"`
            : `[${r.when}] added a new note, "${r.key.replace(/_/g, ' ')}": "${r.after}"`;
        });
        return (
          `${rows.length} recent memory ${rows.length === 1 ? 'edit' : 'edits'} (newest first). Tell the user plainly what changed — this is their memory and they have every right to hear it:\n` +
          spoken.join('\n')
        );
      } catch (e) {
        logger.error('[KadeMemorySearch] changes read failed:', e.message);
        return 'The memory-change trail hit an error just now.';
      }
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
      /* Part 69: cards + logbook answer together; ONE embed serves both. */
      const { embedText } = require('~/models/kadeDiary');
      const wantCards = Boolean(query) && scope !== 'logbook';
      const wantDiary = scope !== 'cards';
      const qv = query ? await embedText(String(query).slice(0, 1500)) : null;

      const cardLines = [];
      if (wantCards) {
        try {
          const { searchCardVectors } = require('~/models/kadeCardVector');
          const { getAllUserMemories } = require('~/models');
          const [shared, own] = await Promise.all([
            getAllUserMemories(this.userId, { agentId: null }),
            this.agentId
              ? getAllUserMemories(this.userId, { agentId: this.agentId })
              : Promise.resolve([]),
          ]);
          const all = [...shared, ...own];
          const byKey = new Map(
            all.map((m) => [(m.agentId == null ? '' : String(m.agentId)) + '::' + m.key, m]),
          );
          const seen = new Set();
          if (qv) {
            const cardHits = await searchCardVectors(this.userId, this.agentId, qv, {
              limit: Math.min(Math.max(parseInt(limit, 10) || 6, 1), 12),
              minScore: 0.24,
            });
            for (const h of cardHits) {
              const m = byKey.get((h.agentId == null ? '' : String(h.agentId)) + '::' + h.key);
              if (m && !seen.has(m.key)) {
                seen.add(m.key);
                cardLines.push(`(${String(m.key).replace(/_/g, ' ')}) ${m.value}`);
              }
            }
          }
          /* Substring fallback catches exact names a fresh index hasn't met. */
          const q = String(query).toLowerCase();
          for (const m of all) {
            if (seen.size >= 12) {
              break;
            }
            if (seen.has(m.key)) {
              continue;
            }
            if (
              String(m.key).toLowerCase().includes(q.replace(/\s+/g, '_')) ||
              String(m.value).toLowerCase().includes(q)
            ) {
              seen.add(m.key);
              cardLines.push(`(${String(m.key).replace(/_/g, ' ')}) ${m.value}`);
            }
          }
        } catch (cardErr) {
          logger.warn('[KadeMemorySearch] card half failed (logbook still answers):', cardErr.message);
        }
      }

      const hits = wantDiary
        ? await searchDiary({
            userId: this.userId,
            agentId: this.agentId,
            query: query || null,
            queryVector: qv || undefined,
            dateFrom: date_from || null,
            dateTo: date_to || null,
            limit: limit || 5,
          })
        : [];
      if ((!hits || hits.length === 0) && cardLines.length === 0) {
        return query
          ? `Nothing in your memory cards or logbook matches "${query}"${date_from || date_to ? ' in that date range' : ''}. Do not guess; say your notes don't show it.`
          : 'No logbook entries in that date range.';
      }
      const parts = [];
      if (cardLines.length > 0) {
        parts.push(
          `${cardLines.length} memory ${cardLines.length === 1 ? 'card' : 'cards'} (durable facts):\n` +
            cardLines.join('\n'),
        );
      }
      if (hits && hits.length > 0) {
        const lines = hits.map((h) => `[${h.date}] ${h.text}`);
        parts.push(
          `${hits.length} logbook ${hits.length === 1 ? 'entry' : 'entries'} (dated, newest relevance first):\n` +
            lines.join('\n'),
        );
      }
      return 'Weave in naturally — never recite as a list unless asked:\n' + parts.join('\n\n');
    } catch (e) {
      logger.error('[KadeMemorySearch] search failed:', e.message);
      return 'The logbook search hit an error just now — let the user know you could not check your notes.';
    }
  }
}

module.exports = KadeMemorySearch;
