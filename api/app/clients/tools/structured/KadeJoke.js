const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const jokeJsonSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      description:
        "Optional category: 'Programming', 'Misc', 'Pun', 'Spooky', 'Christmas', or 'Any' (default).",
    },
    search: {
      type: 'string',
      description: 'Optional word the joke should contain (e.g. "cat").',
    },
  },
  required: [],
};

/**
 * KadeJoke — fresh jokes from JokeAPI (v2.jokeapi.dev). Free, keyless,
 * 120 req/min. safe-mode is ALWAYS on (family platform — Kade's sister and
 * friends use this), and NSFW/racist/sexist/religious/political flags are
 * blacklisted on top of it, belt and suspenders.
 *
 * Why a tool at all: LLM internal humor repeats itself fast. A live database
 * gives every "tell me a joke" a genuinely different answer. (Research-paper
 * suggestion, implemented July 2 2026.)
 */
class KadeJoke extends Tool {
  constructor() {
    super();
    this.name = 'kade_joke';
    this.description =
      'Fetch a fresh joke from a live joke database — free, instant, no cost. Use when the user wants a joke or humor; ' +
      'the database keeps it from repeating your own material. Deliver the joke naturally in your own voice ' +
      '(pause between setup and punchline). NEVER invent a fetch failure; if the tool errors, just tell one of your own.';
    this.schema = jokeJsonSchema;
  }

  async _call(data) {
    const { category, search } = data || {};
    const valid = ['Programming', 'Misc', 'Pun', 'Spooky', 'Christmas', 'Any'];
    const cat = valid.find((c) => c.toLowerCase() === String(category || 'Any').toLowerCase()) || 'Any';
    try {
      const res = await axios.get(`https://v2.jokeapi.dev/joke/${cat}`, {
        params: {
          'safe-mode': '',
          blacklistFlags: 'nsfw,religious,political,racist,sexist,explicit',
          ...(search ? { contains: search } : {}),
        },
        headers: { 'User-Agent': 'KadeAI/1.0 (kademurdock.com)' },
        timeout: 10000,
      });
      const d = res.data || {};
      if (d.error) return `No joke found${search ? ` containing "${search}"` : ''}. Try without a search word.`;
      if (d.type === 'twopart') return `Setup: ${d.setup}\nPunchline: ${d.delivery}`;
      return d.joke || 'The joke database returned nothing usable.';
    } catch (err) {
      logger.warn(`[KadeJoke] failed: ${err.message}`);
      return `Joke fetch failed: ${err.message}`;
    }
  }
}

module.exports = KadeJoke;
