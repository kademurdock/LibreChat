const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeNews — free RSS morning news briefing (July 2 2026, Kade's ask).
 * No API key, no per-call cost. Curated free feeds per category, with a
 * custom feed_url escape hatch so users can add any publication they like.
 * The agent is instructed (tool description) to remember each user's
 * preferred categories/feeds via memory, so "my usual briefing" just works.
 */

const CATEGORY_FEEDS = {
  national: [
    { src: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { src: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main' },
  ],
  world: [
    { src: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { src: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml' },
  ],
  local: [
    { src: 'OzarksFirst (Springfield MO)', url: 'https://www.ozarksfirst.com/feed/' },
    { src: 'KY3 (Springfield MO)', url: 'https://www.ky3.com/arc/outboundfeeds/rss/' },
  ],
  tech: [
    { src: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
    { src: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  ],
  entertainment: [
    { src: 'Variety', url: 'https://variety.com/feed/' },
    { src: 'Rolling Stone', url: 'https://www.rollingstone.com/feed/' },
  ],
  music: [
    { src: 'Rolling Stone Music', url: 'https://www.rollingstone.com/music/feed/' },
    { src: 'Billboard', url: 'https://www.billboard.com/feed/' },
  ],
  sports: [
    { src: 'ESPN', url: 'https://www.espn.com/espn/rss/news' },
    { src: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/' },
  ],
};

const kadeNewsJsonSchema = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['national', 'world', 'local', 'tech', 'entertainment', 'music', 'sports'],
      },
      description:
        "Which news categories to include. 'local' = Springfield MO / Ozarks area. Default: ['national', 'local']. Use the user's remembered preferences when they have some.",
    },
    items_per_category: {
      type: 'integer',
      description: 'Headlines per category, 1-8. Default 4.',
    },
    feed_url: {
      type: 'string',
      description:
        'Optional: a specific RSS/Atom feed URL to read INSTEAD of the categories — lets a user follow any publication they like. Remember feeds a user asks for repeatedly.',
    },
  },
  required: [],
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function relativeAge(dateStr) {
  if (!dateStr) return '';
  const t = new Date(dateStr).getTime();
  if (!t || Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 0) return '';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Parses RSS 2.0 <item> AND Atom <entry> with plain regex — no deps. */
function parseFeed(xml, limit) {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, limit * 3)) {
    const title = decodeEntities(tag(b, 'title'));
    if (!title) continue;
    let summary = decodeEntities(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'));
    if (summary.length > 280) summary = summary.slice(0, 277).replace(/\s\S*$/, '') + '…';
    if (summary.toLowerCase() === title.toLowerCase()) summary = '';
    const when = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    items.push({ title, summary, age: relativeAge(decodeEntities(when)) });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchFeed(url) {
  const resp = await axios.get(url, {
    timeout: 12000,
    responseType: 'text',
    // Some outlets block default library UAs.
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-NewsReader/1.0)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    maxContentLength: 3 * 1024 * 1024,
  });
  return resp.data;
}

class KadeNews extends Tool {
  constructor() {
    super();
    this.name = 'kade_news';
    this.description =
      'Get REAL current news headlines from free RSS feeds — no key, no cost. Categories: national (NPR), world (BBC), ' +
      'local (Springfield MO / Ozarks), tech, entertainment, music, sports — or any custom feed_url the user wants. ' +
      "Use for 'what's the news', morning briefings, or anything happening today. IMPORTANT: users can customize their " +
      'briefing — when a user tells you which categories, topics, or feeds they like, SAVE that preference to memory and use ' +
      'it next time without asking. Read results conversationally (this is often listened to, not read). NEVER invent news — ' +
      'only report what this tool returns.';
    this.schema = kadeNewsJsonSchema;
  }

  async _call(data) {
    const { categories, items_per_category, feed_url } = data || {};
    const perCat = Math.min(8, Math.max(1, parseInt(items_per_category, 10) || 4));

    try {
      if (feed_url) {
        if (!/^https?:\/\//i.test(feed_url)) return 'feed_url must be a full http(s) URL.';
        const items = parseFeed(await fetchFeed(feed_url), perCat);
        if (!items.length) return `That feed (${feed_url}) returned no readable stories — it may not be an RSS/Atom feed.`;
        return [`Latest from ${feed_url}:`, ...items.map((i) => `- ${i.title}${i.age ? ` (${i.age})` : ''}${i.summary ? ` — ${i.summary}` : ''}`)].join('\n');
      }

      let cats = Array.isArray(categories) && categories.length ? categories : ['national', 'local'];
      cats = cats.map((c) => String(c).toLowerCase()).filter((c) => CATEGORY_FEEDS[c]);
      if (!cats.length) cats = ['national', 'local'];

      const sections = await Promise.all(
        cats.map(async (cat) => {
          for (const feed of CATEGORY_FEEDS[cat]) {
            try {
              const items = parseFeed(await fetchFeed(feed.url), perCat);
              if (items.length) {
                return [`== ${cat.toUpperCase()} (${feed.src}) ==`, ...items.map((i) => `- ${i.title}${i.age ? ` (${i.age})` : ''}${i.summary ? ` — ${i.summary}` : ''}`)].join('\n');
              }
            } catch (err) {
              logger.warn(`[KadeNews] ${feed.src} failed: ${err.message}`);
            }
          }
          return `== ${cat.toUpperCase()} ==\n(no stories available right now)`;
        }),
      );
      return sections.join('\n\n');
    } catch (err) {
      logger.warn(`[KadeNews] failed: ${err.message}`);
      return `News lookup failed: ${err.message}`;
    }
  }
}

module.exports = KadeNews;
