const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeReadPage — "read this messy webpage to me" (July 2 2026, Kade's ask).
 * Strong accessibility story: blind users paste a link and get the actual
 * article text, no nav bars, cookie banners, ads, or link soup.
 *
 * Primary: Jina Reader (r.jina.ai) — free keyless tier, renders JS pages and
 * returns clean markdown. Fallback: direct fetch + tag stripping, so a Jina
 * hiccup degrades to "slightly messier text" instead of failure.
 */

const kadeReadPageJsonSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Full http(s) URL of the page to read.',
    },
    max_chars: {
      type: 'integer',
      description:
        'Cap on returned text length (2000-40000). Default 12000 — plenty for a normal article. Raise it only if the user wants a long page in full.',
    },
  },
  required: ['url'],
};

/* Nov 13 2026 (sweep 0.0) -- THE PAGE READER NEVER FETCHES A PRIVATE ADDRESS.
 *
 * The fallback fetch below runs from inside the website's own network. A page, a search result or
 * a pasted message could tell a character to read http://<service>.railway.internal:port/... (or a
 * public link that redirects there), and whatever answered was read back to the person. The check
 * used to be "starts with http".
 *
 * Now, before anything is fetched and again on every redirect hop, the address is refused when it
 * is loopback, private, link-local, a known inside name, *.internal / *.local, or resolves to one
 * (the fork's own helpers: packages/api/src/auth/domain.ts isSSRFTarget and resolveHostnameSSRF).
 * Redirects are followed by hand (maxRedirects 0, at most 5 hops) so each hop is checked, and the
 * connection itself refuses a private address (createSSRFSafeAgents), which covers a name that
 * changes its answer between the check and the connect. If the helpers cannot be loaded the
 * fetch is refused, not allowed. KADE_READ_PAGE_SSRF=0 puts back the old unchecked fetch. */
const MAX_REDIRECT_HOPS = 5;
function ssrfGuardOn(env = process.env) {
  return String((env && env.KADE_READ_PAGE_SSRF) ?? '').trim() !== '0';
}
function ssrfHelpers() {
  try {
    const api = require('@librechat/api');
    if (typeof api.isSSRFTarget === 'function' && typeof api.resolveHostnameSSRF === 'function') {
      return api;
    }
  } catch (_) {
    /* fall through: refused below */
  }
  return null;
}
/** True when this address must not be fetched from the server. Fails closed. */
async function isPrivateTarget(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch (_) {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'railway.internal' || host.endsWith('.railway.internal')) return true;
  const helpers = ssrfHelpers();
  if (!helpers) return true;
  if (helpers.isSSRFTarget(host)) return true;
  try {
    return (await helpers.resolveHostnameSSRF(host)) === true;
  } catch (_) {
    return true;
  }
}
const PRIVATE_REFUSAL =
  "I can't read that address: it points inside a private network, not to a public web page.";
class PrivateTargetError extends Error {}
/** GET with every hop checked. Throws PrivateTargetError when a hop is private. */
async function fetchPublicPage(url, options) {
  const helpers = ssrfHelpers();
  const agents =
    helpers && typeof helpers.createSSRFSafeAgents === 'function'
      ? helpers.createSSRFSafeAgents()
      : {};
  let current = String(url);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (await isPrivateTarget(current)) {
      throw new PrivateTargetError(PRIVATE_REFUSAL);
    }
    const r = await axios.get(current, {
      ...options,
      ...agents,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    if (r.status < 300) return r;
    const location = r.headers && (r.headers.location || r.headers.Location);
    if (!location) throw new Error(`Request failed with status code ${r.status}`);
    current = new URL(String(location), current).toString();
  }
  throw new Error('too many redirects');
}

function stripHtml(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = s.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main) s = main[2];
  s = s.replace(/<(p|div|br|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*(\n\s*)+/g, '\n\n')
    .trim();
  return s;
}

class KadeReadPage extends Tool {
  constructor() {
    super();
    this.name = 'kade_read_page';
    /* Card 10: its output is outside text, kept away from memory (services/kadeUntrustedTools.js). */
    this.untrustedSource = true;
    this.description =
      'Fetch a webpage and return ONLY its readable content — article text with the ads, menus, pop-ups, and link ' +
      'clutter stripped out. Free, no key, no cost. Perfect when a user shares a link and wants it read to them, ' +
      'summarized, or discussed — many users here listen by voice or screen reader, so present the content cleanly ' +
      'and in reading order. Use the ACTUAL returned text; never guess what a page says. If the user just wants the ' +
      'gist, summarize; if they say "read it to me", give them the real text (lightly cleaned up for listening).';
    this.schema = kadeReadPageJsonSchema;
  }

  async _call(data) {
    const { url, max_chars } = data || {};
    if (!url || !/^https?:\/\//i.test(url)) return 'I need a full http(s) URL.';
    const cap = Math.min(40000, Math.max(2000, parseInt(max_chars, 10) || 12000));
    const guarded = ssrfGuardOn();
    /* Sweep 0.0: a private address is refused before anything is asked, the outside reader included. */
    if (guarded && (await isPrivateTarget(url))) {
      logger.warn('[KadeReadPage] refused a private address');
      return PRIVATE_REFUSAL;
    }

    // 1) Jina Reader — free tier, no key, handles JS-rendered pages.
    try {
      const r = await axios.get(`https://r.jina.ai/${url}`, {
        timeout: 25000,
        responseType: 'text',
        headers: {
          Accept: 'text/plain',
          'X-Retain-Images': 'none',
          'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-Reader/1.0)',
        },
        maxContentLength: 5 * 1024 * 1024,
      });
      let text = String(r.data || '').trim();
      if (text.length > 200) {
        if (text.length > cap) text = text.slice(0, cap) + `\n\n[Trimmed at ${cap} characters — the page continues. Raise max_chars for more.]`;
        return text;
      }
    } catch (err) {
      logger.warn(`[KadeReadPage] Jina Reader failed for ${url}: ${err.message}`);
    }

    // 2) Fallback: fetch the raw page ourselves and strip the tags.
    try {
      const fetchOptions = {
        timeout: 20000,
        responseType: 'text',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        maxContentLength: 5 * 1024 * 1024,
      };
      const r = guarded
        ? await fetchPublicPage(url, fetchOptions)
        : await axios.get(url, { ...fetchOptions, maxRedirects: 5 });
      const titleMatch = String(r.data).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      let text = stripHtml(r.data);
      if (!text || text.length < 100) return `I fetched ${url} but couldn't find readable text on it — it may be an app-style page or behind a login.`;
      if (text.length > cap) text = text.slice(0, cap) + `\n\n[Trimmed at ${cap} characters — the page continues. Raise max_chars for more.]`;
      const title = titleMatch ? stripHtml(titleMatch[1]) : '';
      return (title ? `PAGE TITLE: ${title}\n\n` : '') + text;
    } catch (err) {
      if (err instanceof PrivateTargetError) {
        logger.warn('[KadeReadPage] refused a redirect to a private address');
        return PRIVATE_REFUSAL;
      }
      logger.warn(`[KadeReadPage] direct fetch failed for ${url}: ${err.message}`);
      return `I couldn't read that page (${err.message}). It may be blocking readers or require a login.`;
    }
  }
}

module.exports = KadeReadPage;
module.exports.isPrivateTarget = isPrivateTarget;
module.exports.PRIVATE_REFUSAL = PRIVATE_REFUSAL;
