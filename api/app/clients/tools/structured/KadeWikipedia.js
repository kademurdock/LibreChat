const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const turnGuard = require('../util/kadeTurnToolGuard');

const wikiJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: "Topic to look up (e.g. 'Ozarks', 'photosynthesis', 'Miles Davis').",
    },
    full_intro: {
      type: 'boolean',
      description: 'true = longer introduction section instead of the one-paragraph summary.',
    },
  },
  required: ['query'],
};

/**
 * KadeWikipedia — free encyclopedia lookups via the Wikipedia REST API.
 * No key, no cost, no Tavily spend. Good for stable facts; use web_search
 * for anything current or local.
 */
class KadeWikipedia extends Tool {
  constructor(fields = {}) {
    super();
    /* Oct 20 2026: the request is this turn's key for the lookup cap and the 429 stop
     * (util/kadeTurnToolGuard); without one the cap counts per tool instance. */
    this.req = fields.req;
    this.name = 'kade_wikipedia';
    this.description =
      'Look up a topic on Wikipedia — free, instant, no cost (unlike web search). Best for stable encyclopedic facts: ' +
      'people, places, history, science, definitions. For breaking news, prices, or local info use web_search instead. ' +
      'Returns a summary and the article link. NEVER invent article content — only report what this tool returns.';
    this.schema = wikiJsonSchema;
  }

  async _call(data) {
    const { query, full_intro } = data || {};
    if (!query) return 'I need a topic to look up.';
    /* Oct 20 2026: at most 8 lookups per turn, none after Wikipedia says "too many requests". */
    const turnKey = this.req || this;
    const gate = turnGuard.beginCall(turnKey, turnGuard.WIKIPEDIA);
    if (!gate.ok) return gate.text;
    const ua = { 'User-Agent': 'KadeAI/1.0 (kademurdock.com)' };
    try {
      const s = await axios.get('https://en.wikipedia.org/w/rest.php/v1/search/page', {
        params: { q: query, limit: 3 },
        headers: ua,
        timeout: 10000,
      });
      const hit = s.data?.pages?.[0];
      if (!hit) return `Wikipedia has no article matching "${query}".`;
      const title = hit.title;
      if (full_intro) {
        const e = await axios.get('https://en.wikipedia.org/w/api.php', {
          params: { action: 'query', prop: 'extracts', exintro: 1, explaintext: 1, format: 'json', titles: title, redirects: 1 },
          headers: ua,
          timeout: 10000,
        });
        const pages = e.data?.query?.pages || {};
        const page = Object.values(pages)[0];
        const text = (page?.extract || '').slice(0, 4000);
        return `${title} — https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}\n\n${text || 'No intro text found.'}`;
      }
      const r = await axios.get(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        { headers: ua, timeout: 10000 },
      );
      const d = r.data || {};
      const others = (s.data.pages || []).slice(1).map((p) => p.title).filter(Boolean);
      return (
        `${d.title}: ${d.extract || 'No summary available.'}\n` +
        `Link: ${d.content_urls?.desktop?.page || ''}` +
        (others.length ? `\nOther matches: ${others.join(', ')}` : '')
      );
    } catch (err) {
      logger.warn(`[KadeWikipedia] failed: ${err.message}`);
      if (turnGuard.guardOn() && turnGuard.isProviderQuotaError(err)) {
        turnGuard.markUnavailable(turnKey, turnGuard.WIKIPEDIA);
        return turnGuard.UNAVAILABLE[turnGuard.WIKIPEDIA];
      }
      return `Wikipedia lookup failed: ${err.message}`;
    }
  }
}

module.exports = KadeWikipedia;
