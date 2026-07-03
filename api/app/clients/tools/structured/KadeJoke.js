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
    dirty: {
      type: 'boolean',
      description:
        'true = adult/uncensored jokes (safe-mode off). ONLY set this if your own persona is explicitly adult/uncensored ' +
        'AND the user wants edgy humor. Family-friendly and kid-facing personas must NEVER set this. Default false = clean.',
    },
  },
  required: [],
};

/**
 * KadeJoke — fresh jokes from JokeAPI (v2.jokeapi.dev). Free, keyless,
 * 120 req/min. TWO MODES (July 2 2026, Kade's ask — her uncensored personas
 * want uncensored jokes, the kid-friendly ones very much don't):
 *   default      -> safe-mode ON + every flag blacklisted (clean, kid-safe)
 *   dirty: true  -> safe-mode OFF, nsfw/explicit allowed. racist + sexist
 *                   stay PERMANENTLY blacklisted in both modes — that's not
 *                   "dirty," that's just nasty, and it never fits the platform.
 * Which mode is allowed is persona-driven (see the schema's dirty description).
 *
 * Why a tool at all: LLM internal humor repeats itself fast. A live database
 * gives every "tell me a joke" a genuinely different answer. (Research-paper
 * suggestion, implemented July 2 2026.)
 */
class KadeJoke extends Tool {
  constructor(fields = {}) {
    super();
    /** Kade child accounts (July 3 2026): dirty:true is silently ignored for
     * users whose kadeAccountType is 'child' — the persona never knows. */
    this.userId = fields.userId;
    this.name = 'kade_joke';
    this.description =
      'Fetch a fresh joke from a live joke database — free, instant, no cost. Use when the user wants a joke or humor; ' +
      'the database keeps it from repeating your own material. Two modes: default is clean/family-safe; dirty=true is ' +
      'adult humor and is ONLY for explicitly adult/uncensored personas with adult users — kid-friendly personas never ' +
      'use it. Deliver the joke naturally in your own voice (pause between setup and punchline). ' +
      'NEVER invent a fetch failure; if the tool errors, just tell one of your own.';
    this.schema = jokeJsonSchema;
  }

  async _call(data) {
    const { category, search } = data || {};
    const valid = ['Programming', 'Misc', 'Pun', 'Spooky', 'Christmas', 'Any'];
    const cat = valid.find((c) => c.toLowerCase() === String(category || 'Any').toLowerCase()) || 'Any';
    try {
      let dirty = data?.dirty === true;
      if (dirty && this.userId) {
        try {
          const { getUserById } = require('~/models');
          const u = await getUserById(this.userId, 'kadeAccountType');
          if (u && u.kadeAccountType === 'child') {
            dirty = false;
          }
        } catch (_) {
          dirty = false; // can't verify the audience -> stay clean
        }
      }
      const res = await axios.get(`https://v2.jokeapi.dev/joke/${cat}`, {
        params: {
          // racist + sexist are blacklisted in BOTH modes, always.
          ...(dirty
            ? { blacklistFlags: 'racist,sexist' }
            : { 'safe-mode': '', blacklistFlags: 'nsfw,religious,political,racist,sexist,explicit' }),
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
