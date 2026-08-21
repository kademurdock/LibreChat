const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const mediaJsonSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The link to watch or listen to — a YouTube URL, or a direct audio/video file link (mp3, m4a, wav, ogg, flac, mp4, mov, webm).',
    },
    focus: {
      type: 'string',
      description: "Optional: what the person especially wants to know (e.g. 'the instrumentation', 'what happens on screen', 'the cello part').",
    },
  },
  required: ['url'],
};

/**
 * KadeMedia — real ears and eyes for linked media (Part 82, Aug 21 2026).
 *
 * Kade's ask: "users send agents a song on youtube or anywhere, and they can
 * describe the video, describe the instrumentation." The engine lives on the
 * bridge (/media/describe): Gemini with native YouTube ingestion — no
 * downloads, no storage. This tool is a thin authenticated client; every
 * failure path returns a plain sentence (never throws — a thrown tool error
 * feeds the agent-graph's dead-air failure mode).
 */
class KadeMedia extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.name = 'kade_media';
    this.description =
      'WATCH or LISTEN to linked media — a YouTube video or a direct audio/video file — and get back an accurate ' +
      'description of what happens on screen and how the music is built: the instrumentation, the arrangement, the ' +
      "vocal style, section by section. Use whenever someone shares a song or video link and wants you to experience " +
      'it ("check this out", "describe this video", "what instruments are in this"). Covers roughly the first ten ' +
      'minutes of long videos and says so. Free for the user, costs the house a few cents on long videos. Report what ' +
      'it returns faithfully in your own voice; NEVER invent sights or sounds it did not mention, and never claim you ' +
      'watched anything without calling this first.';
    this.schema = mediaJsonSchema;
  }

  async _call(data) {
    const url = String((data && data.url) || '').trim();
    if (!url) return 'I need a link to watch or listen to.';
    const secret = process.env.MEDIA_TOOL_SECRET;
    const base = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    if (!secret) return 'The media lane is missing its key on this server — tell Kade.';
    try {
      const r = await axios.post(
        `${base}/media/describe`,
        { url, focus: (data && data.focus) || undefined, userId: this.userId || 'unknown' },
        { headers: { 'x-media-secret': secret, 'Content-Type': 'application/json' }, timeout: 150000 },
      );
      const d = r.data || {};
      if (d.description) return d.description;
      return 'The media lane came back empty — try the link once more, and if it keeps happening tell Kade.';
    } catch (e) {
      logger.warn(`[kade_media] bridge call failed: ${e.message}`);
      return `I couldn't take that one in (${String(e.message).slice(0, 80)}). Give it another try in a minute.`;
    }
  }
}

module.exports = KadeMedia;
