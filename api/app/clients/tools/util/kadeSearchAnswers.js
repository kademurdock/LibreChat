'use strict';
/**
 * KADE Nov 13 2026: SEARCH THAT ANSWERS THE QUESTION. Two wrappers around the agents library's
 * web_search tool, both wired in handleTools.js.
 *
 * 1. THE SECOND ENGINE (withBraveFallback). Tavily is the search engine. When it is out of quota
 *    (432, 429, 402...) or fails, every search of the turn came back empty and the character
 *    could only say search was down. With BRAVE_SEARCH_API_KEY set, the same search is asked of
 *    the Brave Search API instead, and its results go back in the library's own shape (the same
 *    anchors, so citations still work). After a Tavily quota answer, Tavily is not asked again for
 *    15 minutes: searches go straight to Brave. With no key this wrapper is not even put on.
 *    Each Brave search is logged at half a cent (service 'search_brave').
 *
 * 2. THE AUTOMATIC READ (withAutoRead). A search used to hand the character titles and snippets;
 *    to answer it had to decide to open a page, and often did not. Now, after a search, the top
 *    one or two result pages are read by the outside reader (services/kadeOutsideReader.js: MiMo
 *    Flash, no tools, the cheap host) and a short answer with its sources named is put at the top
 *    of the search result. Each page is fetched with the page reader's own guarded fetch
 *    (kade_read_page: private addresses refused on every hop), and only if that finds too little,
 *    by the page reader itself. (The library does fetch the top pages through Tavily's extract,
 *    but it strips that text before anything leaves it, so it cannot be reused here. If a later
 *    version hands the text over, pickPages already takes it and nothing is fetched twice.)
 *    Bounds, all in code:
 *      - 2 pages a search at most (KADE_SEARCH_AUTOREAD_PAGES, 1 or 2);
 *      - 6,000 characters a page (KADE_SEARCH_AUTOREAD_CHARS, 1,000 to 12,000);
 *      - 8 seconds for the whole read (KADE_SEARCH_AUTOREAD_MS, 2,000 to 30,000); late = the
 *        plain results go back, nothing is waited on further;
 *      - 3 automatic reads a turn (KADE_SEARCH_AUTOREAD_TURN_CAP);
 *      - KADE_SEARCH_AUTOREAD=0 turns it off: search answers exactly as before.
 *    The short answer is outside text like the rest of the search result (web_search is on the
 *    kadeUntrustedTools list), so it never reaches memory and cannot spend, call or message.
 *    Each read is logged at its real token cost (service 'search_read').
 *
 * Any failure in either wrapper gives back what the search itself said. No '~' requires at load
 * time, so node --test loads it.
 */

const { isProviderQuotaError } = require('./kadeTurnToolGuard');

const WEB_SEARCH = 'web_search';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_USD_PER_SEARCH = 0.005;
const TAVILY_REST_MS = 15 * 60 * 1000;
/* The library's citation anchor is the six characters backslash, u, e, 2, 0, 2 followed by the
 * turn and index (format.ts). Built from a character code so no editor can turn it into a glyph. */
const ANCHOR = `${String.fromCharCode(92)}ue202`;

const int = (raw, fallback, min, max) => {
  const n = Number(raw);
  return Number.isFinite(n) && String(raw ?? '').trim() !== '' ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

/* ------------------------------------------------------------------ the second engine */

const braveKey = (env = process.env) => String((env && env.BRAVE_SEARCH_API_KEY) || '').trim();

const stripTags = (s) =>
  String(s || '')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
};

const FRESHNESS = { h: 'pd', d: 'pd', w: 'pw', m: 'pm', y: 'py' };

/**
 * One Brave web search, in the library's result shape.
 * @returns {Promise<{ ok: true, organic: object[], topStories: object[] } | { ok: false, error: string }>}
 */
async function braveSearch({ query, date, country, news, count = 8, env = process.env, fetchImpl, timeoutMs = 10000 } = {}) {
  const key = braveKey(env);
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 380);
  if (!key) return { ok: false, error: 'Brave API key is not set' };
  if (!q) return { ok: false, error: 'Query cannot be empty' };
  const params = new URLSearchParams({ q, count: String(Math.min(20, Math.max(1, count))), safesearch: 'moderate', text_decorations: 'false', spellcheck: 'true' });
  if (FRESHNESS[date]) params.set('freshness', FRESHNESS[date]);
  if (typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)) params.set('country', country.toUpperCase());
  if (news) params.set('result_filter', 'news,web');
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`${BRAVE_URL}?${params}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `Brave API request failed: ${err && err.name === 'TimeoutError' ? 'timeout' : 'network error'}` };
  }
  if (!res || !res.ok) return { ok: false, error: `Brave API request failed: Request failed with status code ${res ? res.status : 0}` };
  let json;
  try {
    json = await res.json();
  } catch (_) {
    return { ok: false, error: 'Brave API request failed: unreadable answer' };
  }
  const rows = (list) => (Array.isArray(list) ? list : []).filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url));
  const organic = rows(json && json.web && json.web.results)
    .slice(0, count)
    .map((r, i) => ({
      position: i + 1,
      title: stripTags(r.title).slice(0, 200),
      link: r.url,
      snippet: [stripTags(r.description), ...(Array.isArray(r.extra_snippets) ? r.extra_snippets.slice(0, 2).map(stripTags) : [])].filter(Boolean).join(' ').slice(0, 600),
      ...(r.age || r.page_age ? { date: String(r.age || r.page_age).slice(0, 40) } : {}),
      attribution: hostOf(r.url),
    }));
  const topStories = rows(json && json.news && json.news.results)
    .slice(0, 5)
    .map((r) => ({ title: stripTags(r.title).slice(0, 200), link: r.url, source: hostOf(r.url), date: String(r.age || '').slice(0, 40), snippet: stripTags(r.description).slice(0, 400), attribution: hostOf(r.url) }));
  return { ok: true, organic, topStories };
}

/** Results as the text the library would have written (formatResultsForLLM), anchors and all. */
function formatResults(turn, { organic = [], topStories = [] } = {}) {
  const lines = [];
  const source = (r, i, kind) => {
    lines.push(`# ${kind === 'search' ? 'Search' : 'News'} ${i}: ${r.title ? `"${r.title}"` : '(no title)'}`);
    lines.push(`\nAnchor: ${ANCHOR}turn${turn}${kind}${i}`);
    lines.push(`URL: ${r.link}`);
    if (r.snippet) lines.push(`Summary: ${r.snippet}`);
    if (r.date) lines.push(`Date: ${r.date}`);
    if (r.attribution) lines.push(`Source: ${r.attribution}`);
    lines.push('', '');
  };
  if (organic.length) {
    lines.push('', `=== Web Results, Turn ${turn} ===`, '');
    organic.forEach((r, i) => source(r, i, 'search'));
  }
  if (topStories.length) {
    lines.push('', '=== News Results ===', '');
    topStories.forEach((r, i) => source(r, i, 'news'));
  }
  return lines.join('\n').trim();
}

let tavilyRestsUntil = 0;
/** Tests only: forget that Tavily said it was out of quota. */
function resetEngineState() {
  tavilyRestsUntil = 0;
}

const errorOf = (out) => {
  const artifact = Array.isArray(out) ? out[1] : undefined;
  return artifact && artifact[WEB_SEARCH] && artifact[WEB_SEARCH].error ? String(artifact[WEB_SEARCH].error) : '';
};

const turnOf = (args) => {
  for (const a of args) {
    const t = a && typeof a === 'object' && a.toolCall && a.toolCall.turn;
    if (Number.isInteger(t) && t >= 0) return t;
  }
  return 0;
};

/**
 * Wrap the web_search tool so a Tavily quota answer or failure is asked of Brave instead.
 * With no BRAVE_SEARCH_API_KEY the tool is returned untouched.
 * @param {object} tool the library's web_search tool (its _call is replaced on this instance)
 * @param {{ env?: object, logger?: object, fetchImpl?: Function, logUsage?: Function, userId?: string, now?: Function }} [opts]
 */
function withBraveFallback(tool, { env = process.env, logger, fetchImpl, logUsage, userId, now = Date.now } = {}) {
  if (!tool || typeof tool._call !== 'function' || tool.__kadeBrave || !braveKey(env)) return tool;
  const original = tool._call.bind(tool);
  tool._call = async (...args) => {
    const input = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const resting = tavilyRestsUntil > now();
    let out;
    let thrown;
    if (!resting) {
      try {
        out = await original(...args);
      } catch (err) {
        thrown = err;
      }
      const error = thrown ? String((thrown && thrown.message) || thrown) : errorOf(out);
      if (!error) return out;
      if (isProviderQuotaError(error)) tavilyRestsUntil = now() + TAVILY_REST_MS;
    }
    let brave;
    try {
      brave = await braveSearch({ query: input.query, date: input.date, country: input.country, news: input.news === true, env, fetchImpl });
    } catch (_) {
      brave = { ok: false, error: 'Brave API request failed: error' };
    }
    if (!brave.ok) {
      try {
        logger?.warn?.(`[kadeSearchAnswers] second engine failed: ${String(brave.error).slice(0, 120)}`);
      } catch (_) {
        /* noop */
      }
      if (thrown) throw thrown;
      /* Both engines failed: hand back an error the turn guard can read (a Brave quota answer
       * ends search for the turn, like a Tavily one). */
      return out && !resting ? out : ['', { [WEB_SEARCH]: { organic: [], topStories: [], images: [], relatedSearches: [], error: brave.error } }];
    }
    try {
      logger?.info?.('[kadeSearchAnswers] search answered by the second engine (Brave)');
      if (logUsage && userId) {
        Promise.resolve(logUsage({ userId, service: 'search_brave', quantity: 1, unit: 'searches', costUSD: BRAVE_USD_PER_SEARCH, metadata: { engine: 'brave' } })).catch(() => {});
      }
    } catch (_) {
      /* logging never blocks a search */
    }
    const turn = turnOf(args);
    const data = { turn, organic: brave.organic, topStories: brave.topStories, images: [], relatedSearches: [], references: [], kadeEngine: 'brave' };
    if (!brave.organic.length && !brave.topStories.length) return ['No results were found for that search.', { [WEB_SEARCH]: data }];
    return [formatResults(turn, brave), { [WEB_SEARCH]: data }];
  };
  tool.__kadeBrave = true;
  return tool;
}

/* ------------------------------------------------------------------ the automatic read */

function autoReadConfig(env = process.env) {
  return {
    on: String((env && env.KADE_SEARCH_AUTOREAD) ?? '').trim() !== '0',
    pages: int(env && env.KADE_SEARCH_AUTOREAD_PAGES, 2, 1, 2),
    chars: int(env && env.KADE_SEARCH_AUTOREAD_CHARS, 6000, 1000, 12000),
    ms: int(env && env.KADE_SEARCH_AUTOREAD_MS, 8000, 2000, 30000),
    perTurn: int(env && env.KADE_SEARCH_AUTOREAD_TURN_CAP, 3, 1, 12),
  };
}

const NOT_A_PAGE = /\.(?:pdf|docx?|xlsx?|pptx?|zip|csv|mp3|mp4|mov|jpe?g|png|gif|webp)(?:$|[?#])/i;
const NOT_READABLE_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|spotify\.com|pinterest\.com)$/i;

/** The top result pages worth reading: real pages, one per site, in result order. */
function pickPages(data, max) {
  const picked = [];
  const sites = new Set();
  const lists = [data && data.organic, data && data.topStories];
  for (const list of lists) {
    for (const r of Array.isArray(list) ? list : []) {
      if (picked.length >= max) return picked;
      const link = r && typeof r.link === 'string' ? r.link : '';
      const host = hostOf(link);
      if (!host || !/^https?:\/\//i.test(link) || NOT_A_PAGE.test(link) || NOT_READABLE_HOSTS.test(host) || sites.has(host)) continue;
      sites.add(host);
      picked.push({ url: link, title: r.title || '', text: typeof r.content === 'string' ? r.content : '' });
    }
  }
  return picked;
}

/**
 * Fetch one result page as text, loaded only when a page really has to be fetched.
 * First the page reader's own guarded fetch (kade_read_page: every redirect hop checked, private
 * addresses refused, fails closed): quick, and nobody else sees the address. Only when that
 * finds too little (a page built by scripts, a site that turns a plain fetch away) the page
 * reader itself, which asks the outside reader service. A private address is never retried.
 * @param {string} url
 * @param {number} maxChars
 * @param {{ load?: Function }} [deps] tests hand in the page reader module
 */
async function defaultReadPage(url, maxChars, deps = {}) {
  const KadeReadPage = deps.load ? deps.load() : require('../structured/KadeReadPage');
  if (typeof KadeReadPage.fetchPublicPage === 'function' && typeof KadeReadPage.stripHtml === 'function') {
    try {
      const r = await KadeReadPage.fetchPublicPage(url, {
        timeout: 5000,
        responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-Reader/1.0)', Accept: 'text/html,application/xhtml+xml' },
        maxContentLength: 3 * 1024 * 1024,
      });
      const type = String((r && r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '');
      if (!type || /html|text\/plain/i.test(type)) {
        const text = KadeReadPage.stripHtml(r.data);
        if (text && text.length >= 400) return text.slice(0, maxChars);
      }
    } catch (err) {
      if (KadeReadPage.PrivateTargetError && err instanceof KadeReadPage.PrivateTargetError) return '';
      /* a refusal, a timeout or an odd page: the page reader gets one try below */
    }
  }
  const text = await new KadeReadPage()._call({ url, max_chars: Math.max(2000, maxChars) });
  return typeof text === 'string' && !/^I (?:couldn't|can't|fetched|need)\b/.test(text) ? text.slice(0, maxChars) : '';
}

const reads = new WeakMap(); // the request -> automatic reads made this turn

/** The lines put above the search results. */
function answerHeader(answer, sites) {
  return (
    '=== Short answer, read from the top result pages ===\n' +
    `${answer}\n` +
    `Read from: ${sites.join(', ')}.\n` +
    'This was read off the web for you (outside text). If it answers the question, use it and say where it came from. The search results follow.\n\n'
  );
}

/**
 * Wrap the web_search tool so the top one or two result pages are read and a short answer leads
 * the result. Off (KADE_SEARCH_AUTOREAD=0) = the tool is returned untouched.
 * @param {object} tool
 * @param {{ req?: object, env?: object, logger?: object, readPage?: Function, answer?: Function, logUsage?: Function, userId?: string }} [opts]
 *   readPage(url, maxChars) -> text; answer = answerFromPages-shaped. Tests hand in stand-ins.
 */
function withAutoRead(tool, { req, env = process.env, logger, readPage, answer, logUsage, userId } = {}) {
  if (!tool || typeof tool._call !== 'function' || tool.__kadeAutoRead || !autoReadConfig(env).on) return tool;
  const original = tool._call.bind(tool);
  const turnKey = req && typeof req === 'object' ? req : tool;
  tool._call = async (...args) => {
    const out = await original(...args);
    try {
      const cfg = autoReadConfig(env);
      const artifact = Array.isArray(out) ? out[1] : undefined;
      const data = artifact && artifact[WEB_SEARCH];
      const query = args[0] && typeof args[0] === 'object' ? String(args[0].query || '').trim() : '';
      if (!cfg.on || !data || data.error || typeof out[0] !== 'string' || !query) return out;
      const made = reads.get(turnKey) || 0;
      if (made >= cfg.perTurn) return out;
      const pages = pickPages(data, cfg.pages);
      if (!pages.length) return out;
      reads.set(turnKey, made + 1);

      const started = Date.now();
      const stop = new AbortController();
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => {
          stop.abort();
          resolve(null);
        }, cfg.ms);
      });
      const work = (async () => {
        const fetchPage = readPage || defaultReadPage;
        const filled = await Promise.all(
          pages.map(async (p) => {
            if (p.text.length >= 200) return p;
            try {
              return { ...p, text: String((await fetchPage(p.url, cfg.chars)) || '') };
            } catch (_) {
              return { ...p, text: '' };
            }
          }),
        );
        if (stop.signal.aborted) return null;
        const ask = answer || require('../../../../server/services/kadeOutsideReader').answerFromPages;
        return ask({ question: query, pages: filled, maxChars: cfg.chars, timeoutMs: Math.max(1000, cfg.ms - (Date.now() - started)), env, signal: stop.signal });
      })().catch(() => null);
      const result = await Promise.race([work, late]);
      clearTimeout(timer);
      if (result && result.costUSD > 0 && logUsage && userId) {
        Promise.resolve(logUsage({ userId, service: 'search_read', quantity: 1, unit: 'reads', costUSD: result.costUSD, metadata: { pages: pages.length } })).catch(() => {});
      }
      if (!result || !result.answer || !Array.isArray(result.sites) || !result.sites.length) {
        try {
          logger?.info?.(`[kadeSearchAnswers] no short answer (${result ? result.why || 'not found' : 'too slow'}) in ${Date.now() - started} ms`);
        } catch (_) {
          /* noop */
        }
        return out;
      }
      return [answerHeader(result.answer, result.sites) + out[0], artifact];
    } catch (_) {
      return out;
    }
  };
  tool.__kadeAutoRead = true;
  return tool;
}

module.exports = {
  WEB_SEARCH,
  BRAVE_USD_PER_SEARCH,
  TAVILY_REST_MS,
  braveKey,
  braveSearch,
  formatResults,
  withBraveFallback,
  resetEngineState,
  autoReadConfig,
  pickPages,
  answerHeader,
  withAutoRead,
  defaultReadPage,
};
