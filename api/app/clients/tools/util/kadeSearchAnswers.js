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
 *    Tavily rests only on a true out-of-quota answer (402, 432, or plan/quota words): a passing
 *    429 does not move everybody's searches to Brave. If Brave fails while Tavily rests, Tavily
 *    is asked after all. A Tavily answer that says the request itself was bad (400, 401, 403,
 *    404, 422) is not asked of Brave. Brave is asked with the configured safe-search level, and
 *    with 'strict' for a child or teen account. A Brave 429 gets one more try a second later.
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
 *      - on a spoken turn (a phone call, the app's voice lane) somebody is listening to the
 *        silence: 1 read a turn and 3 seconds (KADE_SEARCH_AUTOREAD_VOICE_MS, 1,000 to 8,000);
 *      - never on a background run (req.kadeHiddenRun): nobody is waiting, nothing is charged;
 *      - OPT-IN: it runs only with KADE_SEARCH_AUTOREAD=1. Unset (or anything else), the search
 *        tool is not wrapped at all and answers exactly as it did before this file existed. It
 *        is also not wrapped when the reader has no key (OPENROUTER_KEY).
 *    Who sees what: the result page's own site gets one plain fetch from this server. No other
 *    party is told the address, unless KADE_SEARCH_AUTOREAD_READER=1 also lets a page that
 *    yielded too little go to the page reader (which asks the outside reader service, Jina).
 *    The page text goes to the reader model under her zero-retention rule.
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
async function braveSearch({ query, date, country, news, count = 8, safesearch = 'moderate', env = process.env, fetchImpl, timeoutMs = 10000, retryMs = 1100 } = {}) {
  const key = braveKey(env);
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 380);
  if (!key) return { ok: false, error: 'Brave API key is not set' };
  if (!q) return { ok: false, error: 'Query cannot be empty' };
  const params = new URLSearchParams({ q, count: String(Math.min(20, Math.max(1, count))), safesearch: ['off', 'moderate', 'strict'].includes(safesearch) ? safesearch : 'moderate', text_decorations: 'false', spellcheck: 'true' });
  if (FRESHNESS[date]) params.set('freshness', FRESHNESS[date]);
  if (typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)) params.set('country', country.toUpperCase());
  if (news) params.set('result_filter', 'news,web');
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    const ask = () =>
      doFetch(`${BRAVE_URL}?${params}`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal: AbortSignal.timeout(timeoutMs),
      });
    res = await ask();
    /* Brave allows about one search a second on the free plan; two searches made side by side
     * can trip it. One more try a second later, before calling it a quota answer. */
    if (res && res.status === 429 && retryMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      res = await ask();
    }
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

/* A true out-of-quota answer (the plan is used up), as opposed to "slow down for a second". */
const OUT_OF_QUOTA = /\b(?:status(?: code)?|HTTP)\s*:?\s*(?:402|432|433)\b|quota|usage limit|plan limit|credits? (?:exhausted|exceeded)|exceeds your plan/i;
/* The request itself was refused as bad: another engine would only be a second, billed, guess. */
const BAD_REQUEST = /\b(?:status(?: code)?|HTTP)\s*:?\s*(?:400|401|403|404|422)\b/i;

/** Brave's safe-search word: the configured level (0 off, 1 moderate, 2 strict), strict for a child or teen. */
function braveSafeSearch(level, req) {
  try {
    const { audienceOf, isChildLike } = require('../../../../server/services/kadeAccountType');
    if (req && isChildLike(audienceOf(req).user)) return 'strict';
  } catch (_) {
    /* fall through to the configured level */
  }
  const n = Number(level);
  return n === 0 ? 'off' : n === 2 ? 'strict' : 'moderate';
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
 * @param {{ env?: object, req?: object, safeSearch?: number, logger?: object, fetchImpl?: Function, logUsage?: Function, userId?: string, now?: Function, retryMs?: number }} [opts]
 */
function withBraveFallback(tool, { env = process.env, req, safeSearch, logger, fetchImpl, logUsage, userId, now = Date.now, retryMs } = {}) {
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
      if (BAD_REQUEST.test(error) && !OUT_OF_QUOTA.test(error)) {
        if (thrown) throw thrown;
        return out;
      }
      if (OUT_OF_QUOTA.test(error)) tavilyRestsUntil = now() + TAVILY_REST_MS;
    }
    let brave;
    try {
      brave = await braveSearch({ query: input.query, date: input.date, country: input.country, news: input.news === true, safesearch: braveSafeSearch(safeSearch, req), env, fetchImpl, ...(retryMs != null ? { retryMs } : {}) });
    } catch (_) {
      brave = { ok: false, error: 'Brave API request failed: error' };
    }
    if (!brave.ok && resting) {
      /* Brave is failing while Tavily rests: Tavily may have recovered, so it is asked after all
       * (and if it answers, the rest is over). */
      try {
        const late = await original(...args);
        if (!errorOf(late)) {
          tavilyRestsUntil = 0;
          return late;
        }
      } catch (_) {
        /* both are down: the Brave error below is what the guard reads */
      }
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
    /* Opt-in: only "1" turns it on, so a deploy with nothing set changes nothing. */
    on: String((env && env.KADE_SEARCH_AUTOREAD) ?? '').trim() === '1',
    voiceMs: int(env && env.KADE_SEARCH_AUTOREAD_VOICE_MS, 3000, 1000, 8000),
    /* Off unless asked: a page that yields too little may go to the page reader, which tells
     * the outside reader service (Jina) the address. */
    reader: String((env && env.KADE_SEARCH_AUTOREAD_READER) ?? '').trim() === '1',
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
 * @param {{ load?: Function, signal?: AbortSignal, reader?: boolean }} [deps] load: tests hand
 *   in the page reader module. signal: stops the fetch when the read's time is up. reader: may
 *   the page reader (and so the outside reader service) be asked when the plain fetch falls short.
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
        ...(deps.signal ? { signal: deps.signal } : {}),
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
  if (deps.reader !== true || (deps.signal && deps.signal.aborted)) return '';
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
 * the result. Opt-in: without KADE_SEARCH_AUTOREAD=1, or with no reader key, the tool is
 * returned untouched. A background run is never read for; a spoken turn gets one short read.
 * @param {object} tool
 * @param {{ req?: object, env?: object, logger?: object, readPage?: Function, answer?: Function, logUsage?: Function, userId?: string }} [opts]
 *   readPage(url, maxChars) -> text; answer = answerFromPages-shaped. Tests hand in stand-ins.
 */
function withAutoRead(tool, { req, env = process.env, logger, readPage, answer, logUsage, userId } = {}) {
  if (!tool || typeof tool._call !== 'function' || tool.__kadeAutoRead || !autoReadConfig(env).on) return tool;
  /* No reader key = no answer could ever come back, so nothing is fetched and nothing is waited on. */
  if (!answer && !(env && env.OPENROUTER_KEY)) return tool;
  /* A background run (a character's day, a reach-out, a task) has nobody waiting: plain results, no charge. */
  if (req && req.kadeHiddenRun === true) return tool;
  const original = tool._call.bind(tool);
  const turnKey = req && typeof req === 'object' ? req : tool;
  /* Somebody is listening to the silence on a call or the app's voice lane. */
  const spoken = !!(req && (req.kadeVoicePass || req.kadeAppVoice));
  tool._call = async (...args) => {
    const out = await original(...args);
    try {
      const cfg = autoReadConfig(env);
      const artifact = Array.isArray(out) ? out[1] : undefined;
      const data = artifact && artifact[WEB_SEARCH];
      const query = args[0] && typeof args[0] === 'object' ? String(args[0].query || '').trim() : '';
      if (!cfg.on || !data || data.error || typeof out[0] !== 'string' || !query) return out;
      if (req && req.kadeHiddenRun === true) return out;
      const ms = spoken ? Math.min(cfg.ms, cfg.voiceMs) : cfg.ms;
      const perTurn = spoken ? 1 : cfg.perTurn;
      const made = reads.get(turnKey) || 0;
      if (made >= perTurn) return out;
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
        }, ms);
      });
      /* A read that was already sent to the reader is paid for whether or not it came back in
       * time, so its cost is booked when it lands, not only when it was quick enough to use. */
      const book = (r) => {
        if (r && r.costUSD > 0 && logUsage && userId) {
          Promise.resolve(logUsage({ userId, service: 'search_read', quantity: 1, unit: 'reads', costUSD: r.costUSD, metadata: { pages: pages.length } })).catch(() => {});
        }
        return r;
      };
      const work = (async () => {
        const fetchPage = readPage || ((url, max) => defaultReadPage(url, max, { signal: stop.signal, reader: cfg.reader }));
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
        return ask({ question: query, pages: filled, maxChars: cfg.chars, timeoutMs: Math.max(1000, ms - (Date.now() - started)), env, signal: stop.signal });
      })()
        .then(book)
        .catch(() => null);
      const result = await Promise.race([work, late]);
      clearTimeout(timer);
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

/* ------------------------------------------------------------------ the wasted extract */

/*
 * Found Nov 13 2026 with the real library against a stand-in Tavily: on EVERY search the agents
 * library sends the top five result addresses to Tavily's extract service, and then removes that
 * page text before anything leaves it (highlights.ts: "Raw scraped content must never leave this
 * function"). With rerankerType "none", which is how this site is set, nothing is ever made from
 * it. By Tavily's price list a basic search is 1 credit and an extract is 1 credit per five
 * pages, so a search costs about 2 credits (1.9 measured in Part 415) where 1 would do, and a
 * news search about 4 where 2 would do.
 *
 * The library has no switch for it, so with KADE_TAVILY_EXTRACT=0 the extract address is pointed
 * at a closed port on this machine: the five-page request is refused in a millisecond, nothing
 * reaches Tavily, and the search itself is untouched. The one thing the extract did add was each
 * result's "Source:" name; fillAttribution puts that back from the address. Unset = as today.
 */
const NO_EXTRACT_URL = 'http://127.0.0.1:9/kade-no-extract';

const extractOff = (env = process.env) => String((env && env.KADE_TAVILY_EXTRACT) ?? '').trim() === '0';

/** The settings handed to the library's search tool, with the extract switched off when asked. */
function searchToolConfig(config, env = process.env) {
  const base = config && typeof config === 'object' ? config : {};
  if (!extractOff(env) || (base.scraperProvider && base.scraperProvider !== 'tavily')) return base;
  const quiet = (logger) => {
    if (!logger || typeof logger.error !== 'function') return logger;
    /* the refused extract is expected: its five "Error scraping" lines a search are not news */
    const drop = (first) => typeof first === 'string' && /^(?:Error scraping|Tavily Extract|Error in scrapeMany)/i.test(first);
    return { ...logger, debug: (...a) => logger.debug?.(...a), info: (...a) => logger.info?.(...a), warn: (...a) => (drop(a[0]) ? undefined : logger.warn?.(...a)), error: (...a) => (drop(a[0]) ? undefined : logger.error(...a)) };
  };
  return {
    ...base,
    tavilyExtractUrl: NO_EXTRACT_URL,
    tavilyScraperOptions: { ...(base.tavilyScraperOptions || {}), apiUrl: NO_EXTRACT_URL, timeout: 1500 },
    scraperTimeout: 1500,
    logger: quiet(base.logger),
  };
}

/** Give each result its site name when nothing else did (the extract used to), in the artifact and the text. */
function fillAttribution(out) {
  try {
    const data = Array.isArray(out) && out[1] && out[1][WEB_SEARCH];
    if (!data) return out;
    let text = typeof out[0] === 'string' ? out[0] : null;
    for (const list of [data.organic, data.topStories]) {
      for (const r of Array.isArray(list) ? list : []) {
        if (!r || r.attribution || typeof r.link !== 'string') continue;
        const host = hostOf(r.link);
        if (!host) continue;
        r.attribution = host;
        if (text != null) {
          const at = text.indexOf(`URL: ${r.link}\n`);
          if (at >= 0) {
            const end = text.indexOf('\n\n', at);
            const block = text.slice(at, end < 0 ? text.length : end);
            if (!/\nSource: /.test(block)) text = `${text.slice(0, at)}${block}\nSource: ${host}${end < 0 ? '' : text.slice(end)}`;
          }
        }
      }
    }
    return text != null ? [text, out[1]] : out;
  } catch (_) {
    return out;
  }
}

/** With the extract off, put the site names back on what the search tool answers. */
function withAttribution(tool, { env = process.env } = {}) {
  if (!tool || typeof tool._call !== 'function' || tool.__kadeAttribution || !extractOff(env)) return tool;
  const original = tool._call.bind(tool);
  tool._call = async (...args) => fillAttribution(await original(...args));
  tool.__kadeAttribution = true;
  return tool;
}

module.exports = {
  WEB_SEARCH,
  NO_EXTRACT_URL,
  extractOff,
  searchToolConfig,
  fillAttribution,
  withAttribution,
  braveSafeSearch,
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
