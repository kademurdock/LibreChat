'use strict';
/* Part 236 (Sep 20 2026). The three judgments the fork hands to Jev first.
 * The helper and the contract are in kadeJev.js; read that header before
 * touching this file. One is WIRED (the book shelf sort, with the old LLM
 * call standing behind it), two are SHADOW ONLY (they log a line and change
 * nothing, so she can read a week of lines and pick a threshold herself).
 *
 * Every question below was run against the live API on labelled cases before
 * it was wired (scratchpad jev_fork_*_trial.js); the numbers are beside each
 * one. No app dependencies on purpose: the logger is handed in by the caller,
 * so node:test and the trial scripts can load this file bare. */
const jev = require('./kadeJev');

/* ── 1. THE BOOK SHELF SORT (wired, LLM behind it) ────────────────────────
 * The 26 shelves of routes/kadeReadingRoomSort.js, one line each, carrying
 * the librarian prompt's own distinctions. Keys are plain slugs because the
 * shelf names carry an em dash; SHELF_OF maps them back, and a test holds the
 * two lists together. */
const SHELF_CRITERIA = {
  fiction_romance: 'A novel whose main story is a love story or courtship, including steamy ones. A novel about sex is fiction, not a manual.',
  fiction_urban: 'Street lit / urban fiction: novels of city street life, hustlers, the drug game, hood drama and loyalty.',
  fiction_mystery_thriller: 'A novel of crime solving, detectives, suspense, spies, legal or psychological thrills.',
  fiction_scifi_fantasy: 'A novel of science fiction or fantasy: space, the future, magic, dragons, other worlds, dystopias for adults.',
  fiction_horror: 'A novel meant to frighten: hauntings, monsters, the supernatural, slashers.',
  fiction_young_adult: 'A novel written for teenagers, with teen protagonists and teen concerns.',
  fiction_children: 'A made-up story for young children or middle-grade readers: picture books, chapter books, talking animals.',
  fiction_literary_classics: 'Literary fiction and the classics: character-driven serious novels, canon authors, prize winners, old books still read.',
  fiction_historical: 'A novel whose point is its period setting in the past: wars, frontier, royal courts, family sagas across old decades.',
  fiction_short_stories: 'A collection or anthology of short fiction rather than one novel.',
  nonfiction_biography_memoir: 'The true story of a real life, told by the person or by someone else.',
  nonfiction_self_help_relationships: 'Advice for living better: habits, confidence, grief, marriage, parenting, communication.',
  nonfiction_sex_dating: 'Nonfiction guidance about sex, dating or attraction: manuals, advice, how-to. Not novels.',
  nonfiction_humor_jokes: 'Joke books, comic essays, stand-up material, funny observations.',
  nonfiction_music_entertainment: 'Nonfiction about music, film, television, celebrities, bands, the business of show.',
  nonfiction_business_money: 'Business, careers, investing, personal finance, economics for the general reader.',
  nonfiction_health_fitness: 'Bodies and medicine: diet plans, exercise, illness, mental health treatment, nutrition science. A diet book belongs here, not with cookbooks.',
  nonfiction_history_society: 'History, politics, current affairs, race, culture, sociology.',
  nonfiction_science_nature: 'Science explained, animals, space, the environment, technology, mathematics.',
  nonfiction_cooking_home: 'Actual cookbooks with recipes, plus gardening, crafts, home repair, housekeeping. A book merely about food (history, memoir, a novel set in a kitchen) does NOT belong here.',
  nonfiction_religion_spirituality: 'Scripture, devotionals, theology, prayer, faith practice, new-age spirituality.',
  nonfiction_true_crime: 'True accounts of real crimes, killers, trials and investigations.',
  nonfiction_reference_howto: 'Dictionaries, guides, textbooks, manuals, test prep, computer how-to, travel guides.',
  nonfiction_inspirational_stories: 'Inspirational TRUE stories and personal essays meant to uplift (the Chicken Soup kind). These are nonfiction even when written for children or teens.',
  poetry: 'Poems: a collection, an anthology, a verse novel.',
  other: 'The metadata does not support any shelf: a bare or cryptic title with no synopsis, or something that truly fits nowhere. Do not invent a plot or infer genre from an author name.',
};
const SHELF_OF = {
  fiction_romance: 'Fiction — Romance',
  fiction_urban: 'Fiction — Urban',
  fiction_mystery_thriller: 'Fiction — Mystery & thriller',
  fiction_scifi_fantasy: 'Fiction — Science fiction & fantasy',
  fiction_horror: 'Fiction — Horror',
  fiction_young_adult: 'Fiction — Young adult',
  fiction_children: 'Fiction — Children',
  fiction_literary_classics: 'Fiction — Literary & classics',
  fiction_historical: 'Fiction — Historical',
  fiction_short_stories: 'Fiction — Short stories',
  nonfiction_biography_memoir: 'Nonfiction — Biography & memoir',
  nonfiction_self_help_relationships: 'Nonfiction — Self-help & relationships',
  nonfiction_sex_dating: 'Nonfiction — Sex & dating',
  nonfiction_humor_jokes: 'Nonfiction — Humor & jokes',
  nonfiction_music_entertainment: 'Nonfiction — Music & entertainment',
  nonfiction_business_money: 'Nonfiction — Business & money',
  nonfiction_health_fitness: 'Nonfiction — Health & fitness',
  nonfiction_history_society: 'Nonfiction — History & society',
  nonfiction_science_nature: 'Nonfiction — Science & nature',
  nonfiction_cooking_home: 'Nonfiction — Cooking & home',
  nonfiction_religion_spirituality: 'Nonfiction — Religion & spirituality',
  nonfiction_true_crime: 'Nonfiction — True crime',
  nonfiction_reference_howto: 'Nonfiction — Reference & how-to',
  nonfiction_inspirational_stories: 'Nonfiction — Inspirational stories',
  poetry: 'Poetry',
  other: 'Other',
};

const SHELF_Q = {
  type: 'choice',
  instructions:
    'You are the librarian of a family library. File the book described by `title`, `author`, `year` and `synopsis` on exactly one shelf. Distinguish subject from genre. Judge only from the metadata given.',
  criteria: SHELF_CRITERIA,
};
const ADULT_Q = {
  type: 'noul',
  instructions:
    'Is the book described by `title` and `synopsis` ADULT: explicit sexual content, or clearly for grown-ups only, so that it should be hidden from a child\'s account?',
  criteria: {
    true: 'The title or synopsis says or plainly shows explicit sexual content (erotica, explicit scenes, a graphic sex manual), or the book is clearly marketed for adults only.',
    false: 'Anything else. Jokes, romance, street fiction, crime, horror, war and ordinary grown-up subjects are NOT adult unless the title or synopsis says explicit.',
  },
};

/* A belt under the braces. `grownUpsOnly` hides a book from child accounts,
 * so the costly mistake is Jev saying "not adult" about a book that is. Any
 * book whose own metadata uses one of these words never takes Jev's "not
 * adult" on trust: it goes to the LLM like before. Words, not judgment. */
const ADULT_WORDS = /\b(erotic\w*|explicit\w*|xxx|porn\w*|bdsm|kink\w*|fetish\w*|smut\w*|adults? only|(?:readers|ages?) 18|18 and (?:over|older|up)|mature (?:readers|audiences|content)|sexual\w*|sex|orgasm\w*|nsfw|taboo|steamy|menage|ménage)\b/i;

function bookState(b) {
  return {
    title: String(b.title || '').slice(0, 300),
    author: String(b.author || 'unknown').slice(0, 200),
    year: String(b.copyrightYear || 'unknown'),
    synopsis: String(b.synopsis || '').slice(0, 1200) || '(none)',
  };
}

function num(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

/** Thresholds, read per call. The defaults are the trial's; see sortBooks. */
function shelfKnobs() {
  return {
    minConfidence: num('KADE_JEV_LIBRARY_MIN_CONF', 0.7),
    adultLow: num('KADE_JEV_LIBRARY_ADULT_LOW', 0.15),
    adultHigh: num('KADE_JEV_LIBRARY_ADULT_HIGH', 0.85),
  };
}

/** Pure: one Jev answer → a filing, or null when Jev is not decisive. */
function decideBook(book, answers, knobs = shelfKnobs()) {
  const s = answers && answers.shelf;
  const shelf = s && SHELF_OF[s.choice];
  if (!shelf || typeof s.confidence !== 'number' || s.confidence < knobs.minConfidence) return null;
  let p;
  try {
    p = jev.noulOf(answers, 'adult');
  } catch (_) {
    return null;
  }
  /* grownUpsOnly hides a book from child accounts. Jev alone never hides
   * anything from anybody, so an adult reading goes to the second reader
   * (the LLM) unless KADE_JEV_LIBRARY_ADULT_FILES=1. */
  if (p >= knobs.adultHigh) return process.env.KADE_JEV_LIBRARY_ADULT_FILES === '1' ? { shelf, adult: true } : null;
  if (p > knobs.adultLow) return null;
  /* Jev says plainly not adult. The words get a veto. */
  const st = bookState(book);
  if (ADULT_WORDS.test(`${st.title} ${st.synopsis}`)) return null;
  /* A shelf that is about sex, filed as not adult, is a contradiction worth
   * a second reader. */
  if (s.choice === 'nonfiction_sex_dating') return null;
  return { shelf, adult: false };
}

/**
 * Jev reads each book (one request a book, five at a time). Returns
 * { out: {id: {shelf, adult}}, leftovers: [book...], costUSD }. A book lands in
 * leftovers when Jev failed, was unsure of the shelf, was not decisive on
 * adult, or the adult words vetoed a "not adult". NEVER throws.
 *
 * TRIAL (Sep 20 2026, jev_fork_library_trial.js, live API, jev-1.13.0):
 * see the numbers in the header of routes/kadeReadingRoomSort.js classify().
 */
async function sortBooks(books, { ask = jev.ask, timeoutMs = 4000, concurrency = 5 } = {}) {
  const out = {};
  const leftovers = [];
  let inputTokens = 0;
  if (!jev.enabled('KADE_JEV_LIBRARY')) return { out, leftovers: [...books], costUSD: 0 };
  const knobs = shelfKnobs();
  const queue = [...books];
  async function worker() {
    for (let b = queue.shift(); b; b = queue.shift()) {
      try {
        const { answers, usage } = await ask(bookState(b), { shelf: SHELF_Q, adult: ADULT_Q }, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        const c = decideBook(b, answers, knobs);
        if (c) out[String(b._id)] = c;
        else leftovers.push(b);
      } catch (_) {
        leftovers.push(b);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, books.length)) }, worker));
  /* keep the LLM's batch in the order the sweep found them */
  const order = new Map(books.map((b, i) => [String(b._id), i]));
  leftovers.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
  /* $0.042 per million in, output free: about six thousandths of a cent a book. */
  return { out, leftovers, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

/* ── 2. THE MEMORY KEEPER GATE (SHADOW ONLY) ──────────────────────────────
 * The keeper is a generative call after every turn platform-wide, and its own
 * instructions say "Most turns should save NOTHING". These two nouls are the
 * keeper's WHAT TO SAVE and LOGBOOK rules asked as yes/no. Today they only
 * log; after a week of lines she can pick a floor under which the keeper call
 * is skipped. Nothing here can skip it. */
const KEEPER_CARD_Q = {
  type: 'noul',
  instructions:
    'A memory keeper files small durable cards about the person. Does `latestUser` (read with `earlier` for context) state a lasting fact about the person worth a memory card?',
  criteria: {
    true: 'The person states something durable and reusable about themselves: identity facts, the people and pets in their life, a taste or dislike they plainly claim ("I love X"), how they like to be talked to, a running project, a plan with a date, an ongoing health or money matter, a strong ongoing feeling, an ENDING (a cancellation, a break-up, a death, "we are not doing that any more"), a correction of an earlier fact, or a direct "remember this", "forget that" or "remind me". It would still matter in a month.',
    false: 'One-off chatter, greetings, reactions, jokes, task or work chatter, requests for a story or an opinion, and QUESTIONS: asking about a subject is curiosity, never a fact about the person. Details needed only for the current reply. Events inside a game or roleplay. Anything said off the record.',
  },
};
const KEEPER_LOG_Q = {
  type: 'noul',
  instructions:
    'A memory keeper also keeps a dated logbook of the person\'s day-to-day life. Is `latestUser` (read with `earlier` for context) a moment worth one dated logbook line?',
  criteria: {
    true: 'The person shares a genuine moment of their day or life: what they did, how it went, a mood, a small win or gripe, family news, a health scare, a milestone. Or the conversation in `earlier` plus `latestUser` is a real rabbit hole: they asked, dug, reacted and clearly enjoyed it over several turns.',
    false: 'A passing one-line question (a drive-by, not a dig), greetings, banter, task or work chatter, asking the assistant to check or search memory, requests, commands, and events inside a game or roleplay. Anything said off the record.',
  },
};

function messageText(m) {
  const c = m && m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ');
  return '';
}
function isHuman(m) {
  const t = m && (typeof m._getType === 'function' ? m._getType() : m.role || m.type);
  return t === 'human' || t === 'user';
}

/** The keeper's own window → Jev state. latestUser is the last human turn. */
function keeperState(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) if (isHuman(list[i])) { at = i; break; }
  if (at < 0) return null;
  const clean = (s) => String(s || '').replace(/%%%[\s\S]*?%%%/g, ' ').replace(/\s+/g, ' ').trim();
  const latestUser = clean(messageText(list[at])).slice(-2000);
  if (!latestUser) return null;
  const earlier = list
    .slice(0, at)
    .map((m) => `${isHuman(m) ? 'PERSON' : 'ASSISTANT'}: ${clean(messageText(m)).slice(0, 700)}`)
    .join('\n')
    .slice(-3000);
  return { earlier: earlier || '(start of conversation)', latestUser };
}

/** What the keeper did, in one word, from what the JS side can see. */
function keeperWrote({ attachments, logged, failed }) {
  if (failed) return 'error';
  const cards = (Array.isArray(attachments) ? attachments : []).filter((a) => {
    const art = a && a.memory;
    return art && art.type !== 'error';
  }).length;
  if (cards && logged) return 'card+log';
  if (cards) return 'card';
  if (logged) return 'log';
  return 'nothing';
}

/**
 * Start the shadow read. Returns a promise that NEVER rejects (null on any
 * failure or when off). The caller must not await it on the keeper's road.
 *
 * TRIAL numbers (20 labelled turns) are in the comment at the call site,
 * runMemory in controllers/agents/client.js, beside the log line they explain.
 */
function keeperShadowStart(messages, { ask = jev.ask, timeoutMs = 3000 } = {}) {
  try {
    if (!jev.enabled('KADE_JEV_KEEPER_SHADOW')) return Promise.resolve(null);
    const state = keeperState(messages);
    if (!state) return Promise.resolve(null);
    return ask(state, { card: KEEPER_CARD_Q, log: KEEPER_LOG_Q }, timeoutMs)
      .then(({ answers }) => ({ card: jev.noulOf(answers, 'card'), log: jev.noulOf(answers, 'log') }))
      .catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

/** Log the one line once both Jev and the keeper are known. Fire and forget. */
function keeperShadowFinish(shadow, { attachments, logged, failed, messageId, log }) {
  try {
    if (!shadow || typeof shadow.then !== 'function') return;
    shadow
      .then((v) => {
        if (!v || typeof log !== 'function') return;
        log(
          `[kadeJev][keeper-shadow] card=${v.card.toFixed(2)} log=${v.log.toFixed(2)} keeper_wrote=${keeperWrote({ attachments, logged, failed })} msg=${messageId || '?'}`,
        );
      })
      .catch(() => {});
  } catch (_) {
    /* a shadow never throws into the keeper */
  }
}

/* ── 3. TOOL RETRIEVAL (SHADOW ONLY) ──────────────────────────────────────
 * services/kadeToolRetrieval.js picks tools by regex and embedding, and its
 * header comments are a list of misses ("whats the news looking like
 * tonight", the iPhone rumor turn, the Clancy trial). This asks Jev the same
 * question about the five tools that matter most and logs the answer beside
 * the [kadeToolRag] line. It never changes the selection. */
const TOOL_NEEDS = {
  web_search: 'looking something up on the live web: facts about the world that change over time or that a person could not be sure of from memory, such as product releases and specs, prices, scores, schedules, who holds a job, a trial, a rumor, whether a store is open (the weather forecast is NOT this, it has its own tool)',
  kade_news: "today's news headlines or what is going on in the world, the country or the town (weather, prices and store hours are NOT news)",
  kade_weather: 'the current weather or a forecast for a place',
  kade_notify: 'setting a reminder, an alarm, a nudge or a notification for the person at some time',
  kade_memory_search: 'looking up what the person said, did or told the assistant in an earlier conversation: their past words, their diary or logbook',
};
function toolQuestion(name) {
  return {
    type: 'noul',
    instructions: `Would answering \`message\` well need ${TOOL_NEEDS[name]}?`,
    criteria: {
      true: 'Yes. A good reply depends on it, even if the person did not name the tool or use a question mark.',
      false: 'No. Greetings, small talk, feelings, opinions, jokes, stories, advice and things a friend answers from what they already know need no tool. So do asks that a DIFFERENT kind of lookup serves.',
    },
  };
}

/**
 * Fire and forget. `tools` is every tool name loaded for the turn; only the
 * five above are asked about. Returns the promise for tests; production never
 * awaits it. NEVER rejects.
 */
function toolsShadow({ text, tools, keep, log }, { ask = jev.ask, timeoutMs = 3000 } = {}) {
  try {
    if (!jev.enabled('KADE_JEV_TOOLS_SHADOW')) return Promise.resolve(null);
    const message = String(text || '').replace(/%%%[\s\S]*?%%%/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const have = new Set(tools || []);
    const names = Object.keys(TOOL_NEEDS).filter((n) => have.has(n));
    if (!message || names.length === 0) return Promise.resolve(null);
    const questions = {};
    for (const n of names) questions[n] = toolQuestion(n);
    return ask({ message }, questions, timeoutMs)
      .then(({ answers }) => {
        const scores = {};
        for (const n of names) scores[n] = jev.noulOf(answers, n);
        const kept = names.filter((n) => keep && keep.has(n));
        if (typeof log === 'function') {
          log(
            `[kadeJev][tools-shadow] kept=[${kept.join(',')}] jev={${names.map((n) => `${n}:${scores[n].toFixed(2)}`).join(',')}}`,
          );
        }
        return scores;
      })
      .catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

module.exports = {
  SHELF_CRITERIA, SHELF_OF, SHELF_Q, ADULT_Q, ADULT_WORDS, bookState, decideBook, sortBooks, shelfKnobs,
  KEEPER_CARD_Q, KEEPER_LOG_Q, keeperState, keeperWrote, keeperShadowStart, keeperShadowFinish,
  TOOL_NEEDS, toolQuestion, toolsShadow,
};
