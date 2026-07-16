const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeHelp — "what does the site's own help center say about this?" (July 15
 * 2026). Lets any character answer questions about Kade-AI itself (how a
 * feature works, what something costs, accessibility tips, troubleshooting)
 * from the REAL, current help pages instead of guessing or going stale the
 * moment something changes. The topic list below is the only thing carried in
 * every agent's tool schema; actual page content is fetched on demand, so
 * nothing bloats the system prompt for a question that's never asked.
 *
 * Source of truth: kademurdock/inworld-tts-proxy's help.js (SECTIONS/PAGES),
 * served at kademurdock.com/help/*. Keep HELP_TOPICS in sync if pages are
 * added/renamed there.
 */

const HELP_TOPICS = [
  { key: 'home', label: 'Help home — overview of every section' },
  { key: 'starthere', label: 'Start Here — brand new to AI in general' },
  { key: 'quickstart', label: 'Your First Five Minutes — first-time orientation' },
  { key: 'faq', label: 'Questions & Answers — general FAQ' },
  { key: 'whatsnew', label: "What's New — recent features and changes, dated" },
  { key: 'voice', label: 'Talking & Listening — voice input/output, in-app calls basics' },
  { key: 'phone', label: 'Phone Calls — the real phone number, calls FOR you, deep think, family check-in calls' },
  { key: 'describe', label: 'Describe My World — photo/document/video description' },
  { key: 'characters', label: 'Characters & the Marketplace' },
  { key: 'rooms', label: 'The Debate Room' },
  { key: 'games', label: 'The Game Parlor' },
  { key: 'build', label: 'Build Your Own Character' },
  { key: 'memory', label: 'What It Remembers — memory cards, forgetting, consolidation' },
  { key: 'images', label: 'Making Pictures' },
  { key: 'audio', label: 'Making Audio & Voices' },
  { key: 'temporary', label: 'Starting Over & Private/Temporary Chats' },
  { key: 'cheatsheet', label: 'The Cheat Sheet — quick command reference' },
  { key: 'tokens', label: 'What Are Tokens?' },
  { key: 'costs', label: 'What This Costs Kade' },
  { key: 'donate', label: 'Feed the Server — balance, usage, donating' },
  { key: 'accessibility', label: 'Accessibility Tips' },
  { key: 'troubleshooting', label: 'When Something Breaks / how to report a bug' },
  { key: 'notifications', label: 'Notifications & Reminders — push setup, reminder delivery choices, agent check-ins' },
];
const TOPIC_KEYS = HELP_TOPICS.map((t) => t.key);

const kadeHelpJsonSchema = {
  type: 'object',
  properties: {
    topic: {
      type: 'string',
      enum: TOPIC_KEYS,
      description:
        'Which help page to pull — pick the closest match to what the user is actually asking. If genuinely unsure, use "faq" or "home". ' +
        'Topics: ' + HELP_TOPICS.map((t) => `${t.key} = ${t.label}`).join('; ') + '.',
    },
  },
  required: ['topic'],
};

const HELP_BASE = (process.env.HELP_SITE_URL || 'https://inworld-tts-proxy-production.up.railway.app').replace(/\/$/, '');
// "notifications" lives on the main site itself (a live settings page), not
// under the proxy's /help/* set — route it there instead.
const NOTIFICATIONS_URL = (process.env.CHAT_SITE_URL || 'https://kademurdock.com').replace(/\/$/, '') + '/notifications';

/** Turn a help page's HTML into clean, read-aloud-friendly plain text. Many
 * users here listen by voice or screen reader, so links become their visible
 * text (a raw URL read aloud is useless), headings get a clear spoken
 * separator, and list items get a plain dash instead of a bullet glyph. */
function htmlToSpeechText(html) {
  let s = String(html || '');
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1'); // keep link text, drop the href
  s = s.replace(/<h[1-4][^>]*>/gi, '\n\n== ').replace(/<\/h[1-4]>/gi, ' ==\n');
  s = s
    .replace(/<(li|label|legend|button)[^>]*>/gi, '\n- ')
    .replace(/<\/(li|label|legend|button|p|div|tr|fieldset)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&rsquo;|&#0?39;|&apos;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&hellip;/g, '...').replace(/&rarr;/g, '->').replace(/&larr;/g, '<-')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// Help content changes maybe once a day at most — a short courtesy cache
// avoids refetching the same page for every question in a busy session.
// In-memory only (per server instance); fine for a "nice to have" cache.
const CACHE_TTL_MS = 10 * 60 * 1000;
const pageCache = new Map();

class KadeHelp extends Tool {
  constructor() {
    super();
    this.name = 'kade_help';
    this.description =
      "Look up a page from Kade-AI's own help center so you can answer questions about the SITE ITSELF accurately — how a feature works, " +
      "what something costs, accessibility tips, troubleshooting, what's new — instead of guessing or relying on stale training knowledge. " +
      'Use this whenever someone asks how to use something here, what a feature does or costs, what changed recently, or says something ' +
      "isn't working. Returns the real current page text, cleaned up for reading aloud — put it in your own words for the user rather than " +
      'reciting it verbatim, unless they specifically want the exact wording.';
    this.schema = kadeHelpJsonSchema;
  }

  async _call(data) {
    const topic = String((data && data.topic) || '').trim();
    if (!TOPIC_KEYS.includes(topic)) {
      return `Not a recognized help topic. Available topics: ${HELP_TOPICS.map((t) => `${t.key} (${t.label})`).join(', ')}.`;
    }

    const cached = pageCache.get(topic);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.text;
    }

    const url = topic === 'notifications' ? NOTIFICATIONS_URL : `${HELP_BASE}${topic === 'home' ? '/help' : `/help/${topic}`}`;
    try {
      const r = await axios.get(url, {
        timeout: 15000,
        responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-Help/1.0)' },
        maxRedirects: 3,
      });
      const text = htmlToSpeechText(r.data).slice(0, 8000);
      if (!text || text.length < 40) {
        return `Fetched the "${topic}" help page but it came back empty or unreadable — tell the user you couldn't check rather than guessing.`;
      }
      pageCache.set(topic, { text, at: Date.now() });
      return text;
    } catch (err) {
      logger.warn(`[KadeHelp] fetch failed for topic "${topic}": ${err.message}`);
      return `Couldn't load the "${topic}" help page right now (${err.message}). Don't guess at what it says — tell the user you couldn't check.`;
    }
  }
}

module.exports = KadeHelp;
