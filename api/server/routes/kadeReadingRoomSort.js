'use strict';
/* ----------------------------------------------------------------------------
 * THE LIBRARIAN SORTS THE BOOKS (Part 181 continued, Sep 12 2026)
 *
 * Her word: "the librarian is going to have to organise the daisy books. I
 * don't have any folders or method to those things. I just uploaded the
 * whole batch." Clips arrive with the sorter's folders; books arrive bare.
 *
 * A sweep runs on its own (every SORT_INTERVAL_MIN minutes, up to SORT_BATCH
 * books a pass) over text books with no folder yet: the cheap model reads
 * title, author and synopsis and answers a shelf from a FIXED list, plus
 * whether it is adult. The book is filed under `Books/<shelf>` (so it browses
 * like the archive) and adult titles are marked grown-ups only. The
 * librarian can also press "Sort the books now". Cents a hundred books.
 * Knobs: KADE_LIBRARY_SORT=0 kills; KADE_LIBRARY_SORT_DAILY_USD (0.50).
 * -------------------------------------------------------------------------- */
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { KadeBook } = require('~/models/kadeBook');
const { correctedBookShelf } = require('@librechat/api');
const { logKadeUsage, KadeUsage } = require('~/models/kadeUsage');

const SHELVES = [
  'Fiction — Romance', 'Fiction — Urban', 'Fiction — Mystery & thriller', 'Fiction — Science fiction & fantasy', 'Fiction — Horror',
  'Fiction — Young adult', 'Fiction — Children', 'Fiction — Literary & classics', 'Fiction — Historical', 'Fiction — Short stories',
  'Nonfiction — Biography & memoir', 'Nonfiction — Self-help & relationships', 'Nonfiction — Sex & dating', 'Nonfiction — Humor & jokes',
  'Nonfiction — Music & entertainment', 'Nonfiction — Business & money', 'Nonfiction — Health & fitness', 'Nonfiction — History & society',
  'Nonfiction — Science & nature', 'Nonfiction — Cooking & home', 'Nonfiction — Religion & spirituality', 'Nonfiction — True crime',
  'Nonfiction — Reference & how-to', 'Nonfiction — Inspirational stories', 'Poetry', 'Other',
];
const MODEL = () => process.env.KADE_LIBRARIAN_MODEL || 'google/gemini-3.1-flash-lite';
const ENABLED = () => process.env.KADE_LIBRARY_SORT !== '0';
const DAILY_USD = () => Math.max(0, parseFloat(process.env.KADE_LIBRARY_SORT_DAILY_USD) || 0.5);
const BATCH = () => Math.max(1, parseInt(process.env.KADE_LIBRARY_SORT_BATCH, 10) || 25);
const INTERVAL_MIN = () => Math.max(2, parseInt(process.env.KADE_LIBRARY_SORT_INTERVAL_MIN, 10) || 10);
const IN_USD_PER_M = () => Number(process.env.KADE_DESCRIBE_IN_USD_PER_M || 0.1);
const OUT_USD_PER_M = () => Number(process.env.KADE_DESCRIBE_OUT_USD_PER_M || 0.4);

async function spentToday() {
  try {
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const rows = await KadeUsage.aggregate([{ $match: { service: 'describe', createdAt: { $gte: since }, 'metadata.source': 'librarian-sort' } }, { $group: { _id: null, usd: { $sum: '$costUSD' } } }]);
    return rows.length ? rows[0].usd || 0 : 0;
  } catch (_) { return 0; }
}

/* Part 236 (Sep 20 2026). JEV READS THE BOOKS FIRST. Her word: move every
 * judgment that can move onto the decision model. A shelf is a pick-one and
 * "is it adult" is a yes/no, which is all Jev does; it costs about six
 * thousandths of a cent a book and answers in a fifth of a second. The
 * questions and the deciding live in services/kadeJevJudges.js.
 *
 * The contract: Jev is a first opinion. A book is filed on Jev's word only
 * when it is sure of the shelf (confidence >= 0.70) AND decisive on adult
 * (<= 0.15 or >= 0.85). Every other book, and every book when Jev fails or
 * is switched off, goes to the LLM call below exactly as before, batched
 * into one call. `grownUpsOnly` hides a book from child accounts, so the
 * mistake that matters is "not adult" said about a book that is: on top of
 * the 0.15 line, any book whose own title or synopsis uses an adult word
 * (erotic, explicit, sex, adults only...) never takes Jev's "not adult" on
 * trust, and neither does anything Jev shelves under Sex & dating.
 *
 * TRIAL, live API, jev-1.13.0, 36 labelled books (scratchpad
 * jev_fork_library_trial.js), 26 shelves, 10 adult books of which 5 had coy
 * synopses with no explicit word in them:
 *   shelf: 36 of 36 on an acceptable shelf; zero wrong at any confidence.
 *          At 0.70, 32 of 36 accepted; the four under it were honestly
 *          two-shelf books (Letters to Penthouse 0.60, a bare-title Stephen
 *          King 0.69 which it rightly called Other).
 *   adult: the 10 adult books scored 0.99 0.99 0.99 0.98 0.99 0.92 0.94 0.96
 *          0.75 0.55. The LOWEST adult book was 0.55 against a 0.15 line, so
 *          ZERO false negatives, with room. The 26 non-adult books topped out
 *          at 0.59 (a dirty joke book) against a 0.85 line: zero false
 *          positives. Six sat between the lines and went to the LLM.
 *   whole rule: 26 filed by Jev, 10 to the LLM, 0 wrong shelves, 0 adult
 *          mistakes either way. 150-430 ms a book, one cold call 1.3 s.
 * Kill: KADE_JEV_LIBRARY=0 (or KADE_JEV=0, or no TYPESAFE_API_KEY): then this
 * is byte for byte the old road. Knobs: KADE_JEV_LIBRARY_MIN_CONF (0.70),
 * KADE_JEV_LIBRARY_ADULT_LOW (0.15), KADE_JEV_LIBRARY_ADULT_HIGH (0.85). */
async function classify(books) {
  let first = { out: {}, leftovers: books, costUSD: 0 };
  try {
    first = await require('~/server/services/kadeJevJudges').sortBooks(books);
  } catch (_) {
    first = { out: {}, leftovers: books, costUSD: 0 };
  }
  const byJev = Object.keys(first.out).length;
  if (!first.leftovers.length) {
    logger.info(`[kadeJev][library] jev filed ${byJev}, llm 0`);
    return { out: first.out, costUSD: first.costUSD };
  }
  let rest;
  try {
    rest = await classifyLLM(first.leftovers);
  } catch (e) {
    /* With nothing from Jev this is the old failure, thrown the old way. With
     * some filed, keep them: the leftovers stay unsorted for the next pass. */
    if (!byJev) throw e;
    logger.warn(`[kadeJev][library] jev filed ${byJev}, llm failed on ${first.leftovers.length}: ${e.message}`);
    return { out: first.out, costUSD: first.costUSD };
  }
  if (byJev) logger.info(`[kadeJev][library] jev filed ${byJev}, llm ${first.leftovers.length}`);
  return { out: { ...rest.out, ...first.out }, costUSD: rest.costUSD + first.costUSD };
}

async function classifyLLM(books) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not configured');
  const list = books.map((b, i) => `${i + 1}. id=${b._id} | title: ${b.title} | author: ${b.author || '?'} | year: ${b.copyrightYear || '?'} | synopsis: ${String(b.synopsis || '').slice(0, 1200)}`).join('\n');
  const prompt = `You are the librarian of a family library. File each book on exactly one shelf from this list (copy the shelf name exactly):\n${SHELVES.map((s) => '- ' + s).join('\n')}\n\nDistinguish subject from genre: inspirational true stories and personal essays are nonfiction, even when written for children or teens. A novel about sex is fiction, not a nonfiction sex manual. A book about food is not automatically a cookbook. Use Other when the metadata does not support a shelf; do not invent a plot or infer genre from an author's identity.\n\nAlso say whether the book is ADULT (explicit sexual content, or clearly for grown-ups only) — jokes, romance and street fiction are NOT adult unless the title or synopsis says explicit.\n\nBooks:\n${list}\n\nAnswer ONLY with JSON: {"books": [{"id": "...", "shelf": "...", "adult": true|false}]}`;
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions',
    { model: MODEL(), max_tokens: 4000, messages: [{ role: 'user', content: prompt }], usage: { include: true }, response_format: { type: 'json_object' } },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120000 });
  const text = String(r.data?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const usage = r.data?.usage || {};
  const est = ((Number(usage.prompt_tokens) || 0) * IN_USD_PER_M() + (Number(usage.completion_tokens) || 0) * OUT_USD_PER_M()) / 1e6;
  const costUSD = typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : est;
  let j = {};
  try { j = JSON.parse(text); } catch (_) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch (_) {} } }
  const out = {};
  for (const x of Array.isArray(j.books) ? j.books : []) {
    const shelf = SHELVES.find((s) => s.toLowerCase() === String(x.shelf || '').trim().toLowerCase()) || SHELVES.find((s) => String(x.shelf || '').toLowerCase().includes(s.split('— ')[1]?.toLowerCase() || '\u0000')) || 'Other';
    out[String(x.id)] = { shelf, adult: x.adult === true };
  }
  return { out, costUSD };
}

let running = false;
/** One pass: up to BATCH unsorted text books. Returns how many were filed. */
async function sortOnce({ force = false, userId = null } = {}) {
  if (!ENABLED() || running) return 0;
  running = true;
  try {
    const spent = await spentToday();
    if (spent >= DAILY_USD()) return 0;
    // A shortcut (the one-file rule, Sep 25 2026) stays where it was put, so it is never shelved here.
    const books = await KadeBook.find({ kind: 'text', state: 'ready', shortcutOf: { $exists: false }, $or: [{ path: '' }, { path: { $exists: false } }] }, '_id title author copyrightYear synopsis owner').sort({ createdAt: 1 }).limit(BATCH()).lean();
    if (!books.length) return 0;
    const { out, costUSD } = await classify(books);
    let filed = 0;
    for (const b of books) {
      const known = correctedBookShelf(b.title, b.author);
      const c = known ? { shelf: known, adult: out[String(b._id)]?.adult === true } : out[String(b._id)];
      if (!c) continue;
      const set = { path: `Books/${c.shelf}` };
      if (c.adult) set.grownUpsOnly = true;
      await KadeBook.updateOne({ _id: b._id, shortcutOf: { $exists: false }, $or: [{ path: '' }, { path: { $exists: false } }] }, { $set: set, $addToSet: { tags: c.shelf } });
      filed++;
    }
    logKadeUsage({ userId: userId || books[0].owner, service: 'describe', quantity: filed, unit: 'items', costUSD, metadata: { source: 'librarian-sort', model: MODEL(), books: filed } });
    logger.info(`[library/librarian-sort] filed ${filed} book(s) for $${costUSD.toFixed(4)} — ${Object.values(out).map((x) => x.shelf).reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {}) && JSON.stringify(Object.entries(Object.values(out).reduce((m, x) => { m[x.shelf] = (m[x.shelf] || 0) + 1; return m; }, {})).slice(0, 8))}`);
    return filed;
  } catch (e) {
    logger.warn(`[library/librarian-sort] failed: ${e.message}`);
    return 0;
  } finally {
    running = false;
  }
}

let timer = null;
function startSortSweep() {
  if (timer || !ENABLED()) return;
  const ms = INTERVAL_MIN() * 60 * 1000;
  timer = setInterval(() => { sortOnce().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  setTimeout(() => { sortOnce().catch(() => {}); }, 90 * 1000);
  logger.info(`[library/librarian-sort] sweep every ${INTERVAL_MIN()} min, ${BATCH()} books a pass, $${DAILY_USD().toFixed(2)} a day`);
}

async function unsortedCount() {
  return KadeBook.countDocuments({ kind: 'text', state: 'ready', shortcutOf: { $exists: false }, $or: [{ path: '' }, { path: { $exists: false } }] });
}

module.exports = { sortOnce, startSortSweep, unsortedCount, SHELVES, ENABLED };
