const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/* Nov 12 2026 craft review. These songs go straight to YuE2 with no desk and no checks, and YuE2 sings whatever is
 * in parentheses and only what is written, so the character is told what a singer's sheet looks like: craft in the
 * tool description, layout in the lyrics field. KADE_LYRIC_CRAFT_NOV12=0 puts the Nov 10 wording back. */
const songCraftOn = process.env.KADE_LYRIC_CRAFT_NOV12 !== '0';

/* Kept identical to kadeStudioSchema in packages/api/src/tools/registry/definitions.ts. */
const kadeStudioSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['quote', 'start', 'status', 'list', 'cancel'],
      description:
        'quote = the price of a song, before anything is made (always first; needs direction and lyrics). start = make it, only in a later reply after their own message said yes to the price. status = is my song ready. list = their recent songs. cancel = stop one.',
    },
    title: { type: 'string', description: 'quote. The song title, up to 80 characters.' },
    direction: {
      type: 'string',
      description: songCraftOn
        ? 'quote. The music in one or two short sentences: the language, the genre, the rhythmic feel, a few instruments and the lead singing voice chosen for this song.'
        : 'quote. The music in a sentence or two: genre, instruments, tempo, and the singing voice (for example "warm female lead vocal").',
    },
    lyrics: {
      type: 'string',
      description: songCraftOn
        ? "quote. The exact words to sing, laid out as a singer's sheet: [Verse 1], [Chorus] and [Bridge] tags alone on their own lines; one sung phrase per line, short enough for one breath; every chorus written out in full each time it is sung; words in (parentheses) are sung as backing vocals, so put no direction or repeat note there; numbers written as words. Leave out only for an instrumental."
        : 'quote. The exact words to sing, with [Verse] and [Chorus] tags on their own lines. Leave out only for an instrumental.',
    },
    instrumental: { type: 'boolean', description: 'quote. True for music with no singing.' },
    takes: { type: 'integer', minimum: 1, maximum: 4, description: 'quote. How many versions (takes) to make. Leave out for 1. Ask for more ONLY when they asked for more than one version in their own words: every take is charged, so 2 takes cost twice as much.' },
    style: { type: 'string', description: 'quote. A trained style by name, only if they ask for one. Usually leave out.' },
    quoteId: { type: 'string', description: 'start. The quoteId from quote.' },
    jobId: { type: 'string', description: 'status or cancel. The jobId from start. Leave out for their newest song.' },
  },
  required: ['action'],
};

/**
 * KADE STUDIO, the character's side (Nov 10 2026). The engine is api/server/services/kadeStudio.js,
 * which reaches the Sound Booth's own routes as the person being served. The character quotes
 * the price, the person says yes in their next message, the character starts the song and goes
 * on talking; the finished song arrives later in the conversation as the character's message.
 */
class KadeStudio extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_studio';
    this.description =
      'Make a real song with sung lyrics (YuE2, the Sound Booth) by talking. YOU write the words with them: ask what the song is about, write the lyrics, read them back, change what they ask. ' +
      (songCraftOn
        ? 'Write a song people can sing: a hook someone would say out loud, a chorus in plain words, verses in plain speech with end rhymes a listener can hear, and a second verse that says something the first did not. '
        : '') +
      'Then the song is made in the background; when it is ready a message from you says so here and it is in their Sound Booth library. ' +
      'ALWAYS quote first, say the price in your reply in plain words, and call start only in a LATER reply after their own message says yes. Never say a song has started unless start answered started. ' +
      'If you are talking by voice or on a phone call, a song cannot be started: say so at once, before writing any words, and ask them to ask again in the text chat. Use this for songs, not fal_studio, unless they ask for Lyria or MiniMax by name. Also answers "is my song ready" (status).';
    this.schema = kadeStudioSchema;
    this.req = fields.req;
    this.agentId = fields.agentId;
    this.agentName = fields.agentName;
  }

  async _call(data) {
    const studio = require('~/server/services/kadeStudio');
    const action = String((data && data.action) || '');
    const base = { req: this.req, agentId: this.agentId, agentName: this.agentName };
    try {
      if (action === 'quote') {
        const q = await studio.quote({ ...base, input: data });
        if (!q.ok) return this.refusal('No price yet', q);
        return JSON.stringify({ quoteId: q.quoteId, title: q.title, takes: q.takes, tellThem: q.tellThem });
      }
      if (action === 'start') {
        const s = await studio.start({ ...base, quoteId: data.quoteId });
        if (!s.ok) return this.refusal('Not started', s);
        return JSON.stringify({ started: true, jobId: s.jobId, title: s.title, takes: s.takes, charged: s.charged, tellThem: s.tellThem });
      }
      const actions = { status: studio.status, list: studio.list, cancel: studio.cancel, draft: studio.draft, draft_read: studio.draftRead };
      const run = actions[action];
      /* draft and draft_read are not offered (the lyric desk is off from a conversation); a call to one is answered with how to write the words instead. */
      if (!run) return 'Unknown action. Use quote, start, status, list or cancel.';
      const out = await run({ ...base, jobId: data.jobId, draftId: data.draftId, idea: data.idea, instrumental: data.instrumental });
      if (!out.ok) return this.refusal('Not done', out);
      const { ok: _ok, ...rest } = out;
      return JSON.stringify(rest);
    } catch (e) {
      logger.warn('[KadeStudio] ' + (e && e.message));
      return `FAILED: the song service had a problem: ${String((e && e.message) || e).slice(0, 160)}. Tell them plainly; do not pretend anything started.`;
    }
  }

  refusal(lead, r) {
    /* A clean-song refusal is never explained to the person (Kade's standing rule for children's accounts). */
    if (r.soft) return `${lead}: ${r.error}.`;
    return `${lead}: ${r.error}. Tell them plainly and do not pretend a song is being made.`;
  }
}

module.exports = KadeStudio;
