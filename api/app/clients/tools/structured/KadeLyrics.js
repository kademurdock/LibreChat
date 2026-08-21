const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const lyricsJsonSchema = {
  type: 'object',
  properties: {
    artist: {
      type: 'string',
      description: "Artist name, e.g. 'Sleep Token'.",
    },
    title: {
      type: 'string',
      description: "Song title, e.g. 'Gethsemane'.",
    },
  },
  required: ['artist', 'title'],
};

const MAX_CHARS = 6000;

/**
 * KadeLyrics — song lyric lookups via open lyric APIs (Part 81, Aug 21 2026).
 *
 * Born from a real night in Amber A's chat: she asked Kiana to pull Sleep
 * Token lyrics and the general-purpose page reader hit AZLyrics' bot-check
 * wall and Genius's client-rendered shell — Kiana rattled locked doors while
 * the person waited. Lyric SITES fight scrapers; lyric APIs built for lookup
 * don't. Primary: LRCLIB (lrclib.net — open, no key, community-sourced,
 * exact match then search). Fallback: lyrics.ovh. No key, no cost.
 *
 * Failure discipline: this tool NEVER throws — every path returns a plain
 * sentence, because a thrown tool error feeds the agent-graph's worst
 * behavior (the parked multi-round termination bug shows as dead air to a
 * screen-reader user).
 */
class KadeLyrics extends Tool {
  constructor() {
    super();
    this.name = 'kade_lyrics';
    this.description =
      'Look up the lyrics of a song by artist and title — free, instant, no cost. Built for lyric lookups: use THIS ' +
      '(never web_search or kade_read_page — lyric sites block page readers with bot-walls) whenever someone asks about ' +
      "a song's words, quotes a lyric, or wants a verse checked. Returns the full lyric text when found. Quote what it " +
      'returns faithfully and NEVER invent or fill in lines it did not return. If it misses, say so and ask the person ' +
      'to paste the part they mean — do not retry the same lookup.';
    this.schema = lyricsJsonSchema;
  }

  async _call(data) {
    const artist = String((data && data.artist) || '').trim();
    const title = String((data && data.title) || '').trim();
    if (!artist || !title) {
      return 'I need both an artist and a song title to look up lyrics.';
    }
    const headers = { 'User-Agent': 'KadeAI/1.0 (kademurdock.com)' };
    const clip = (text, source) => {
      const t = String(text || '').trim();
      if (!t) return null;
      const cut = t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n\n[lyrics truncated — the song continues]` : t;
      return `${title} — ${artist} (via ${source})\n\n${cut}`;
    };

    // 1) LRCLIB exact match
    try {
      const r = await axios.get('https://lrclib.net/api/get', {
        params: { artist_name: artist, track_name: title },
        headers,
        timeout: 10000,
      });
      if (r.data && r.data.instrumental === true) {
        return `${title} — ${artist}: LRCLIB lists this track as an instrumental (no lyrics).`;
      }
      const hit = clip(r.data && r.data.plainLyrics, 'LRCLIB');
      if (hit) return hit;
    } catch (e) {
      if (!(e.response && e.response.status === 404)) {
        logger.warn(`[kade_lyrics] LRCLIB get failed: ${e.message}`);
      }
    }

    // 2) LRCLIB search (misspellings, alternate titles)
    try {
      const s = await axios.get('https://lrclib.net/api/search', {
        params: { q: `${artist} ${title}` },
        headers,
        timeout: 10000,
      });
      const rows = Array.isArray(s.data) ? s.data : [];
      const best = rows.find((row) => row && row.plainLyrics);
      if (best) {
        const label = `${best.trackName || title} — ${best.artistName || artist}`;
        const t = String(best.plainLyrics).trim();
        const cut = t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n\n[lyrics truncated — the song continues]` : t;
        return `${label} (via LRCLIB search — closest match)\n\n${cut}`;
      }
    } catch (e) {
      logger.warn(`[kade_lyrics] LRCLIB search failed: ${e.message}`);
    }

    // 3) lyrics.ovh fallback
    try {
      const o = await axios.get(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { headers, timeout: 10000 },
      );
      const hit = clip(o.data && o.data.lyrics, 'lyrics.ovh');
      if (hit) return hit;
    } catch (e) {
      if (!(e.response && e.response.status === 404)) {
        logger.warn(`[kade_lyrics] lyrics.ovh failed: ${e.message}`);
      }
    }

    return (
      `I couldn't find lyrics for "${title}" by ${artist} on the open lyric services. ` +
      'The spelling might differ, or the song may be too new or too obscure for them. ' +
      'Ask the person to paste the part they mean.'
    );
  }
}

module.exports = KadeLyrics;
