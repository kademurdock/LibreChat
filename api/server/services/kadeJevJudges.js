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

/* ── 1b. THE COMMERCIAL SHELF (Part 237, Sep 20 2026) ─────────────────────
 * Kade's ask: "organise my backblaze library." The catalog's 4,866 catch-all
 * items are almost all one thing — `Video/Commercials/Other Commercials/<decade>`,
 * a commercial whose PRODUCT the filing regexes could not name. Part 185 filed
 * 2,866 and wrote "unknown titles were not guessed", because the filer is a
 * brand-name list and these brands are not on it: "Tegrin ad, 1969",
 * "Gulf Spray ad, 1968", "Toast'em ad, 1968", "American Tourister ad, 1978".
 * A list cannot know what Tegrin is. Jev can.
 *
 * The 49 categories below are the exact union of filingData's prefixes,
 * strong and generic keys, so a Jev answer lands on a shelf the library
 * already has and no new folder is ever invented. The decade stays where the
 * old path put it — Jev is weak at dates and is never asked for one.
 *
 * Two questions: is this even a product advertisement, and which product. A
 * filing needs BOTH — decisive on the ad question and confident on the shelf —
 * otherwise the item stays exactly where it is, which is no worse than today.
 */
const AD_CATEGORY_CRITERIA = {
  'Airlines & Rail': 'An airline, a railroad, Amtrak, air or rail travel itself.',
  'Baby & Kids': 'Diapers, formula, baby food, car seats, strollers, baby care. Not toys.',
  'Banks & Insurance': 'A bank, savings and loan, credit union, credit card, or an insurance company of any kind.',
  'Beer, Wine & Spirits': 'Alcohol: beer, wine, liquor, coolers.',
  'Breakfast Cereal': 'Breakfast cereal specifically, hot or cold.',
  'Cable & Satellite Services': 'A cable or satellite TV provider or package.',
  'Candy, Gum & Chocolate': 'Candy bars, sweets, chewing gum, mints, chocolate.',
  'Car Rental & Transport': 'Car rental, moving trucks, taxis, buses, shipping and courier services.',
  'Cars and Trucks': 'A car or truck itself, a car maker, a dealership, a model year.',
  'Charities & Nonprofits': 'A charity, a church appeal, a nonprofit, a fundraising drive.',
  'Cleaning & Household': 'Cleaning the house and its laundry: detergent, bleach, soap for dishes, polish, air freshener, trash bags, foil, insecticide, paper towels.',
  'Clothing & Shoes': 'Clothes, shoes, jeans, underwear, hosiery, coats, luggage and handbags.',
  'Drinks (Non-Alcoholic)': 'Soda, juice, coffee, tea, milk, bottled water, drink mixes.',
  'Education & Careers': 'A school, college, trade school, correspondence course, job training or recruiting.',
  'Electronics & Tech': 'Televisions, stereos, computers, video game consoles as hardware, cameras as electronics, batteries.',
  'Feminine & Personal Care': 'Feminine hygiene, tampons, pads, douches, and adult incontinence.',
  'Food & Grocery': 'Food to cook or eat at home that is not cereal, snack, candy or drink: canned goods, frozen dinners, meat, bread, condiments, baking, a grocery brand.',
  'Furniture & Mattresses': 'Furniture, mattresses, carpet and flooring, a furniture store.',
  'Gas, Oil & Auto Care': 'Gasoline, motor oil, tires, car batteries, car repair, car wash, auto parts.',
  'Greeting Cards & Gifts': 'Greeting cards, flowers, gift shops, collectibles and figurines.',
  'Health & Beauty': 'Grooming and looking after yourself: shampoo, soap, deodorant, toothpaste, shaving, make-up, skin and hair care, perfume.',
  'Healthcare & Safety Services': 'A hospital, clinic, doctor, dentist, health plan, a safety campaign or emergency service.',
  'Home & Appliances': 'Large and small household appliances: refrigerators, washers, vacuums, microwaves, and housewares.',
  'Home Improvement': 'Paint, tools, lumber, building supplies, a hardware or home improvement store, remodelling and contractors.',
  'Internet & Online Services': 'An internet provider, an online service, a website, software as a service.',
  'Jewelry & Watches': 'Jewellery, diamonds, watches, a jeweller.',
  'Lawn, Garden & Hardware': 'Lawn mowers, fertiliser, seed, garden tools, outdoor and yard care.',
  'Lottery & Gambling': 'A lottery, scratch-offs, a casino, betting.',
  'Medicine & Pharmacy': 'Something you take for an ailment: pain relievers, cold and allergy remedies, antacids, sleep aids, laxatives, vitamins, prescription drugs, a pharmacy.',
  'Movies & Home Entertainment': 'A film in theatres, a movie trailer, a VHS or DVD release, a video rental store.',
  'Music & Records': 'A record label, an album or artist being promoted, a concert, a music store.',
  'Music Offers': 'A mail-order music compilation or record club: "not available in stores", K-Tel and its kind.',
  'Newspapers, Magazines & Books': 'A newspaper, magazine, book, book club or publisher.',
  'Office & Business': 'Office supplies, copiers, business equipment and services sold to businesses.',
  'Pet Products': 'Pet food, pet care, pet supplies, a veterinarian.',
  'Phone & Wireless': 'A phone company, long distance, cellular service, pagers, telephones.',
  'Photography & Film': 'Cameras, film, photo developing, a film brand.',
  'Real Estate': 'Houses or land for sale, a realtor, an apartment complex.',
  'Restaurants & Fast Food': 'A restaurant or fast food chain, a sit-down meal out, a pizza delivery.',
  'Snacks, Chips & Cookies': 'Chips, crackers, cookies, popcorn, pretzels, snack cakes.',
  'Sporting Goods': 'Sports equipment, bicycles, athletic shoes as sporting goods, outdoor recreation gear.',
  'Sports & Fitness': 'A gym, exercise equipment, a fitness programme, a sports league or event.',
  'Stores & Retail': 'A shop you walk into, sold as the shop rather than one product: department stores, discount chains, supermarkets, catalogue showrooms, a sale event.',
  'Sweepstakes & Direct Response': 'A sweepstakes, a contest, a mail-in offer, an "operators are standing by" direct-response pitch for a gadget.',
  'Taxes & Financial Services': 'Tax preparation, investing, brokerages, loans, financial planning.',
  'Tobacco': 'Cigarettes, cigars, chewing tobacco, snuff.',
  'Toys & Video Games': 'Toys, dolls, action figures, board games, and video games as games.',
  'Travel & Attractions': 'A hotel, a resort, a theme park, a tourist attraction, a state or city tourism campaign, a cruise.',
  'Weight Loss & Diet': 'A diet programme, diet food, weight-loss aids.',
};
const AD_CATEGORY_Q = {
  type: 'choice',
  instructions:
    'A television or radio commercial from an archive is described by `title` and `decade`. The title is usually a brand or product name followed by the word ad. Say which kind of product or service the commercial is advertising. Use what you know about the brand named in the title, and judge by what the product actually IS, not by what a word in its name sounds like: a bug spray called Gulf Spray is a household insecticide, not petrol; a soap called Irish Spring is soap, not travel. When a brand is unfamiliar, use the ordinary meaning of the words in the title. Pick the single best fit.',
  criteria: AD_CATEGORY_CRITERIA,
};
const IS_AD_Q = {
  type: 'noul',
  instructions:
    'Is the item described by `title` a commercial or advertisement for a product, a service or a shop?',
  criteria: {
    true: 'An advert for something you can buy: a brand, a product, a service, a shop, a restaurant, a car, a film. The title usually names it and says ad, advert, commercial or spot.',
    false: 'Anything that is not selling a product: a public service announcement, a station identification, a bumper, a promo for a TV show, a news clip, an episode of a programme, a political advert, a home recording, or a title so bare or cryptic that it names no product at all.',
  },
};

function adState(item) {
  const path = String(item.path || '');
  const decade = (path.match(/\/((?:19|20)\d0s|Undated|Unknown[^/]*|Multiple decades)$/i) || [])[1] || 'unknown';
  return {
    title: String(item.title || '').slice(0, 300),
    decade: String(decade),
  };
}

/** The decade folder the item already sits in, kept exactly as it was. */
function adDecade(item) {
  return adState(item).decade;
}

function adKnobs() {
  return {
    minConfidence: num('KADE_JEV_ADS_MIN_CONF', 0.7),
    minIsAd: num('KADE_JEV_ADS_MIN_ISAD', 0.5),
  };
}

/** Pure: one Jev answer → a destination category, or null when not decisive. */
function decideAd(answers, knobs = adKnobs()) {
  const c = answers && answers.category;
  const category = c && c.choice;
  if (!category || !Object.prototype.hasOwnProperty.call(AD_CATEGORY_CRITERIA, category)) return null;
  if (typeof c.confidence !== 'number' || c.confidence < knobs.minConfidence) return null;
  let isAd;
  try {
    isAd = jev.noulOf(answers, 'isAd');
  } catch (_) {
    return null;
  }
  /* Not an advert at all (a PSA, a station ID, a bare title) — the product
   * shelves are the wrong place for it, so leave it where it is. */
  if (isAd < knobs.minIsAd) return null;
  return { category, confidence: c.confidence, isAd };
}

/**
 * Read a batch of catch-all commercials. Returns
 * { moves: [{id, title, from, to, category, confidence}], skipped, costUSD }.
 * NEVER throws. A move only ever renames the PRODUCT folder; the decade and
 * everything above `Commercials/` are copied from the path it already had.
 */
async function fileAds(items, { ask = jev.ask, timeoutMs = 6000, concurrency = 5, onProgress } = {}) {
  const moves = [];
  const skipped = [];
  let inputTokens = 0;
  let done = 0;
  if (!jev.enabled('KADE_JEV_LIBRARY')) return { moves, skipped: [...items], costUSD: 0 };
  const knobs = adKnobs();
  const queue = [...items];
  async function worker() {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const { answers, usage } = await ask(adState(it), { category: AD_CATEGORY_Q, isAd: IS_AD_Q }, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        const d = decideAd(answers, knobs);
        if (d) {
          const from = String(it.path || '');
          const to = from.replace(
            /Commercials\/Other Commercials(?=\/|$)/i,
            'Commercials/' + d.category,
          );
          if (to && to !== from) {
            moves.push({ id: String(it._id || it.id), title: it.title, from, to, category: d.category, confidence: d.confidence, isAd: d.isAd });
          } else skipped.push(it);
        } else skipped.push(it);
      } catch (_) {
        skipped.push(it);
      }
      if (typeof onProgress === 'function' && ++done % 100 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const order = new Map(items.map((b, i) => [String(b._id || b.id), i]));
  moves.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { moves, skipped, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

/* ── 1c. THE LOCAL SHELF (Part 238, Sep 20 2026) ──────────────────────────
 * Kade's word this session: "My main expectation is that people can find my
 * local stuff quickly and easily, as far as ozarks springfield missouri type
 * stuff." Today it cannot be. `Video/Ozarks (Springfield Area)` holds 1,672
 * items in nine folders named only for a decade, and 1,207 of them sit in the
 * single folder called 1990s. A screen reader reads that list one item at a
 * time. A long flat list is the hardest shape there is to hunt through and a
 * short list at each turning is the easiest, so the fix is depth, not search.
 *
 * The titles are nearly all one template: "<CALL>-TV Channel <N> <NET>
 * Springfield Mo <the actual subject> Back In <when>". The station prefix is
 * WHERE it came from and says nothing about what it is, which is why the
 * question below tells Jev to read past it. What is left is a judgement call
 * a list of words cannot make: "Promo For Maury" is a syndicated show, "Promo
 * For KOLR 10 Newsbeat" is the local news, and "Promo's Back In May Of 1987"
 * is neither — it is a reel of promos about nothing in particular.
 *
 * Two things the trial taught, both kept in the wording below because both
 * cost real accuracy when they were missing:
 *   - Promo Reels had to exist. Without it the 233 bare "Promo's + a date"
 *     items scattered between Show Promos and Station IDs at 0.3-0.6 and
 *     nearly all fell under the floor. With it they answer at 0.89-1.00.
 *   - A local advert is named, a break is not. "Commercials Meeks" is one ad
 *     for Meeks the Springfield lumber yard; "Commercials Back In October Of
 *     1988" is a break. Before that sentence went in, Meeks answered
 *     Commercial Breaks at 0.43; after it, Local Commercials at 0.93.
 *     Smitty's, GFS, Colony, Oak Express and Carpet Barn all moved the same
 *     way. These are the crown jewels of a local archive — the shops that are
 *     gone — so the wording that finds them is load-bearing, not decoration.
 *
 * The station is NOT asked for and NOT used as a folder: `meta.callSign`,
 * `author` and the tags already carry it and /search already reads all three,
 * so "KOLR" finds its 608 either way. Decade comes off the path, never Jev.
 */
const LOCAL_ROOT = 'Video/Ozarks (Springfield Area)';
const LOCAL_KIND_CRITERIA = {
  'Local Commercials':
    'ONE advertisement, for a business, shop, restaurant, car dealer, bank, hospital or service in the Springfield / Ozarks area. A title of the form "Commercials <name>" names the single business the advert is for, even when that name is unfamiliar, and belongs here.',
  'Local News':
    "Local news itself or the local news brand: a newscast, a news opening, a news story, an anchor or reporter, or a promo for that station's own local news programme.",
  Weather:
    "Local weather: a forecast, a weather segment, a storm, or the station's weather team or weatherman.",
  'Local Sports':
    'Local sport: a team, a game, a coach, a local sports report or sports personality, a hall of fame.',
  'Station IDs & Sign-offs':
    'The station announcing itself rather than a programme: a station identification, a sign-on or sign-off, a bumper, a movie opening or a movie bumper, a channel logo.',
  'Show Promos':
    'A promo advertising a television programme that is not local news: a syndicated or network show such as Maury, Donahue, Roseanne, Designing Women, a movie the station is airing, or a Saturday cartoon.',
  'Commercial Breaks':
    'A recorded stretch of a broadcast holding several different adverts, with NO single business named in the title. "Commercials & Promos" and a bare "Commercials" and a date mean this. If the title names a business, it is not this.',
  'Promo Reels':
    'Several promos by the station itself recorded together with no one subject named, so that no single programme, newscast or advert is what the item is about. A title that is only the word Promos and a date means this.',
  'Around the Ozarks':
    'The place and its people rather than a broadcast: a town, a landmark, a fair, a parade, a festival, a school or college, local history, a local musician or notable person, a community event.',
};
const LOCAL_KIND_Q = {
  type: 'choice',
  instructions:
    'An item from a Springfield, Missouri television archive is described by `title`, `station` and `decade`. Say what kind of thing it is. Almost every title begins with the station call letters, the channel number, the network and the words Springfield Mo — that part describes WHERE it came from and never what it is; judge only by what comes after it. The word "Promo" alone does not decide anything: a promo for the station\'s own news is Local News, a promo for Maury or Roseanne is a Show Promos, and a promo for the weather team is Weather. A title that names no subject at all, only the word Promos and a date, is a Promo Reels. A word or two sitting directly after the word Commercials is the name of a local business, however odd it looks, and makes the item one Local Commercial rather than a break. Pick the single best fit.',
  criteria: LOCAL_KIND_CRITERIA,
};

/** The decade folder, read off the path. Jev is never asked for a date. */
const LOCAL_DECADE = /^Video\/Ozarks \(Springfield Area\)\/((?:19|20)\d0s|Undated|Multiple decades)$/i;

function localState(item) {
  return {
    title: String(item.title || '').slice(0, 300),
    station: String(item.author || (item.meta || {}).callSign || 'unknown'),
    decade: String((item.meta || {}).decade || 'unknown'),
  };
}

function localKnobs() {
  return { minConfidence: num('KADE_JEV_LOCAL_MIN_CONF', 0.7) };
}

/** Pure: one Jev answer → a kind, or null when Jev is not confident enough. */
function decideLocal(answers, knobs = localKnobs()) {
  const k = answers && answers.kind;
  const kind = k && k.choice;
  if (!kind || !Object.prototype.hasOwnProperty.call(LOCAL_KIND_CRITERIA, kind)) return null;
  if (typeof k.confidence !== 'number' || k.confidence < knobs.minConfidence) return null;
  return { kind, confidence: k.confidence };
}

/**
 * Where an item goes, or null to leave it alone. Pure, so a test can hold the
 * rule still. Only an item sitting DIRECTLY in a decade folder under the
 * Ozarks root is ever moved: once it has a kind in its path the pattern no
 * longer matches, so a second run is a no-op rather than a second burrowing.
 */
function localDestination(path, kind) {
  const m = LOCAL_DECADE.exec(String(path || ''));
  if (!m) return null;
  return LOCAL_ROOT + '/' + kind + '/' + m[1];
}

/**
 * Read a batch of Ozarks items. Returns
 * { moves: [{id, title, from, to, kind, confidence}], skipped, costUSD }.
 * NEVER throws. Nothing leaves the Ozarks root and nothing loses its decade,
 * so the worst case of a wrong answer is a local item on the wrong local
 * shelf — still local, still tagged, still found by search.
 */
async function fileLocal(items, { ask = jev.ask, timeoutMs = 6000, concurrency = 5, onProgress } = {}) {
  const moves = [];
  const skipped = [];
  let inputTokens = 0;
  let done = 0;
  if (!jev.enabled('KADE_JEV_LIBRARY')) return { moves, skipped: [...items], costUSD: 0 };
  const knobs = localKnobs();
  const queue = [...items];
  async function worker() {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const { answers, usage } = await ask(localState(it), { kind: LOCAL_KIND_Q }, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        const d = decideLocal(answers, knobs);
        const to = d && localDestination(it.path, d.kind);
        if (to && to !== String(it.path || '')) {
          moves.push({ id: String(it._id || it.id), title: it.title, from: String(it.path || ''), to, kind: d.kind, confidence: d.confidence });
        } else skipped.push(it);
      } catch (_) {
        skipped.push(it);
      }
      if (typeof onProgress === 'function' && ++done % 100 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const order = new Map(items.map((b, i) => [String(b._id || b.id), i]));
  moves.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { moves, skipped, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

/* ── 1d. THE AUDIO SHELF (Part 238, Sep 20 2026) ──────────────────────────
 * Her rule, given this session: "audio and video will be organised by
 * category and decade whenever possible." Her audio was not organised at all.
 * All 214 radio items sat under `./old radio ads from 90s 2000s` — the literal
 * folder she dragged in, leading dot and all, not even beneath `Audio/` — with
 * `category: radio`, no `meta`, and therefore no decade.
 *
 * Three different things are mixed in there and only one of them is a
 * commercial, so the kind has to be settled before the shelf:
 *   - 119 real radio adverts, titled "<Brand> - '<Spot>'".
 *   - 80 spoof adverts from Grand Theft Auto IV's radio stations. Written for
 *     a game, never broadcast. Filing those beside real 2005 radio would
 *     quietly corrupt the archive.
 *   - 13 airchecks — stations being stations. TWELVE OF THE THIRTEEN are
 *     Springfield: KTTS, KWTO, KTXR, KXUS, KOSP, KKLH, KCTG, Mix 92.9. Her
 *     local radio history was sitting in a junk folder, which is exactly the
 *     thing she said she wanted findable.
 *
 * The trial (scratchpad jev_audio_trial2.js, all 214 read live) answered 205
 * decisively at the 0.70 floor and left 2 as Other Audio, both genuinely
 * unplaceable ("starberst mittens"). One sentence in the wording was worth ~30
 * items: without it, "Sprint - 'Mrs Chavez'" and "US Navy - 'Freedom'" read as
 * songs and fell to Other Audio at 0.17–0.30. Naming the archive's title
 * template — advertiser, dash, spot name in quotes — put them back.
 *
 * The decade is NEVER asked of Jev. It comes off the year folder the file was
 * dropped in, or a four-digit year in the title, or it stays Undated.
 */
const AUDIO_ROOT = 'Audio';
const AUDIO_LOCAL_ROOT = 'Audio/Ozarks (Springfield Area)';
const AUDIO_KIND_CRITERIA = {
  'Radio Commercial':
    'A real radio advertisement for a product, a shop or a service. The title is usually a brand name and then the name of the spot in quotes.',
  'Video Game Radio':
    'A spoof advert or radio segment written for a video game rather than broadcast on real radio — the fake stations in Grand Theft Auto and its kind.',
  Aircheck:
    'A recording of a radio station being a station: a station identification, a jingle, a legal ID, a DJ on air, a segment of a broadcast, a live interview.',
  'Other Audio':
    'Anything else: a song or piece of music, a speech, a whole programme, a sound effect, a home recording, or a title so bare it names nothing at all. Do not put an advertiser and a spot name here.',
};
const AUDIO_KIND_Q = {
  type: 'choice',
  instructions:
    'An item from an audio archive of old radio recordings is described by `title` and `folder`. Say what kind of recording it is. Nearly every real advert in this archive is titled with the advertiser, then a dash, then the name of the spot in quotation marks, as in "Folgers - Checkout Commotion" or "Sprint - Mrs Chavez": the quoted part names the spot, never a song, so that shape is a Radio Commercial even when the quoted words sound like a title. The folder is where the file was dropped and is a hint, not the answer. Pick the single best fit.',
  criteria: AUDIO_KIND_CRITERIA,
};
/* Asked of audio only. The call letters are listed because they are the one
 * fact that settles it, and they are facts about her town, not a judgement. */
const OZARKS_Q = {
  type: 'noul',
  instructions:
    'Is this recording from the Springfield, Missouri / Ozarks area? Radio call letters are the strongest evidence: KTTS, KWTO, KTXR, KXUS, KOSP, KKLH, KCTG, KOMG, KOBC and KADI are Springfield-area stations, and a title naming Springfield, Ozark, Nixa, Republic, Branson, Marshfield, Bolivar or the Ozarks is local too.',
  criteria: {
    true: 'A station, business, place or event in the Springfield / Ozarks area of southwest Missouri.',
    false: 'A national brand, a station somewhere else, or nothing in the title that ties it to the Ozarks.',
  },
};

function audioKnobs() {
  return {
    minKind: num('KADE_JEV_AUDIO_MIN_KIND', 0.7),
    minCategory: num('KADE_JEV_AUDIO_MIN_CAT', 0.7),
    minOzarks: num('KADE_JEV_AUDIO_MIN_OZ', 0.5),
  };
}

/** The decade, from the folder or the title. Pure, and never from Jev. */
function audioDecade(item) {
  const folder = String(item.path || '').split('/').pop() || '';
  const y = folder.match(/^((?:19|20)\d\d)$/) || String(item.title || '').match(/\b((?:19|20)\d\d)\b/);
  return y ? y[1].slice(0, 3) + '0s' : 'Undated';
}

/** "Grand Theft Auto IV - Commercials" → "Grand Theft Auto IV". */
function audioGame(item) {
  const folder = String(item.path || '').split('/').pop() || '';
  const name = folder.split(' - ')[0].trim();
  /* Must start with a word character, so a segment that is only dots can
   * never become a path segment. {0,58} and not {1,58}: a one-character name
   * is odd but legal, and rejecting it was a bug a test caught. */
  return /^[\w][\w '.&-]{0,58}$/.test(name) ? name : 'Other Games';
}

/**
 * Pure: Jev's answers → a destination path, or null to leave it alone.
 * A commercial Jev cannot shelve still moves — to `Other Commercials` under
 * its decade — because being out of the drop folder and under a decade is
 * what she asked for, and a shelf can be refined later. Only Other Audio and
 * an undecided kind stay put.
 */
function audioDestination(item, answers, knobs = audioKnobs()) {
  const k = answers && answers.kind;
  if (!k || !Object.prototype.hasOwnProperty.call(AUDIO_KIND_CRITERIA, k.choice)) return null;
  if (typeof k.confidence !== 'number' || k.confidence < knobs.minKind) return null;
  const kind = k.choice;
  if (kind === 'Other Audio') return null;
  if (kind === 'Video Game Radio') return AUDIO_ROOT + '/Video Game Radio/' + audioGame(item);
  let ozarks = 0;
  try {
    ozarks = jev.noulOf(answers, 'ozarks');
  } catch (_) {
    ozarks = 0;
  }
  const decade = audioDecade(item);
  const local = ozarks >= knobs.minOzarks;
  if (kind === 'Aircheck') {
    return (local ? AUDIO_LOCAL_ROOT : AUDIO_ROOT) + '/Radio Airchecks/' + decade;
  }
  /* A local advert is local first: a Springfield car dealer on KTTS belongs
   * with her Ozarks material, not filed away under Cars and Trucks. */
  if (local) return AUDIO_LOCAL_ROOT + '/Radio Commercials/' + decade;
  const c = answers && answers.category;
  const shelf =
    c && Object.prototype.hasOwnProperty.call(AD_CATEGORY_CRITERIA, c.choice) && typeof c.confidence === 'number' && c.confidence >= knobs.minCategory
      ? c.choice
      : 'Other Commercials';
  return AUDIO_ROOT + '/Radio Commercials/' + shelf + '/' + decade;
}

/**
 * Read a batch of audio items. Returns
 * { moves: [{id, title, from, to, kind, confidence}], skipped, costUSD }.
 * NEVER throws. Writes nothing itself — the caller applies the moves.
 */
async function fileAudio(items, { ask = jev.ask, timeoutMs = 6000, concurrency = 5, onProgress } = {}) {
  const moves = [];
  const skipped = [];
  let inputTokens = 0;
  let done = 0;
  if (!jev.enabled('KADE_JEV_LIBRARY')) return { moves, skipped: [...items], costUSD: 0 };
  const knobs = audioKnobs();
  const queue = [...items];
  async function worker() {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const state = {
          title: String(it.title || '').slice(0, 200),
          folder: String(String(it.path || '').split('/').pop() || '').slice(0, 120),
        };
        const { answers, usage } = await ask(state, { kind: AUDIO_KIND_Q, ozarks: OZARKS_Q, category: AD_CATEGORY_Q }, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        const to = audioDestination(it, answers, knobs);
        if (to && to !== String(it.path || '')) {
          moves.push({
            id: String(it._id || it.id),
            title: it.title,
            from: String(it.path || ''),
            to,
            kind: answers.kind.choice,
            confidence: answers.kind.confidence,
          });
        } else skipped.push(it);
      } catch (_) {
        skipped.push(it);
      }
      if (typeof onProgress === 'function' && ++done % 100 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const order = new Map(items.map((b, i) => [String(b._id || b.id), i]));
  moves.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { moves, skipped, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

/* ── 1e. THE LYRIC TELLS (Part 238, Sep 20 2026) ──────────────────────────
 * Her ask: "whether it's ai tells in lyrics or just whatever you can think of."
 *
 * The Sound Booth already hunts tells, with `lyricTells` in
 * packages/api/src/music/writing.ts: fourteen regexes over the sung lines, and
 * every line that matches is handed to a repair model to be rewritten. A word
 * list has the two failures a word list always has, and here both cost her
 * something real:
 *
 *   FALSE ALARMS. /\b(?:clean|steady)\b/ fires on any use of either word, and
 *   /\bshadows?\b/ and /\bscenes?\b/ on any use of those. "I scrubbed the truck
 *   bed clean and drove it to your mother" is flagged today and sent away to be
 *   rewritten. The list's own comment accepts this — "a false alarm costs one
 *   rewritten line" — but a rewritten line is a line she wrote and lost.
 *
 *   MISSES. "The weight of everything we never said" and "In the quiet of the
 *   in-between" carry no banned word, so the list cannot see them at all, and
 *   those are the lines that actually sound like a machine.
 *
 * TRIAL (scratchpad jev_lyric_trial.js, live). Ground truth was her own: the
 * fourteen BAD/FIX pairs inside the desk's writing system, plus eight lines
 * invented for the trial that the current list flags and a person would keep,
 * plus six stock lines with no banned word in them. Four of the BAD/FIX pairs
 * turned out to be craft instructions rather than lyrics and are not data. On
 * the 35 real lines Jev agreed with the label 33 times. What matters more than
 * the total is where the two kinds of error fell:
 *   - all EIGHT false alarms scored 0.10-0.38, so all eight are saved;
 *   - all SIX invisible stock lines scored 0.88-0.92, so all six are caught;
 *   - the only over-flag, "I ain't tryna hold on" at 0.61, sits below the 0.70
 *     flagging floor and is therefore kept anyway.
 * So at these thresholds the trial had no false positive on a real lyric line.
 *
 * Two independent switches, because they do opposite things and she may want
 * one without the other. Both fail OPEN: any error, any timeout, any switch
 * off, and the word list's answer stands exactly as it does today.
 */
const LYRIC_STOCK_Q = {
  type: 'noul',
  instructions:
    'A single sung line from a song draft is given as `line`. Is it stock writing — the kind of line a machine assembles because it fits anywhere, rather than a line this writer wrote about one particular person, place or moment? Judge the whole line, not one word in it: a common word used about something concrete and specific is not stock. Abstraction, borrowed profundity, named feelings and lines that would fit in any song are stock; a name, a place, a brand, an object, a piece of plain speech or a specific action are not.',
  criteria: {
    true: 'It could be dropped into any song by anyone. It names a feeling instead of showing a thing, reaches for wisdom, or uses an image from the worn pile — the kind of line that sounds like lyrics rather than like somebody talking.',
    false: 'It is anchored to something in particular: a named person or place, a physical object, an action somebody actually did, or plain conversational speech. Even a common word is fine when it is attached to something real.',
  },
};

function lyricKnobs() {
  return {
    /* Flag a line the list missed only well above the middle. A missed tell
     * costs one mediocre line; a wrong flag costs one of her good ones. */
    minFlag: num('KADE_JEV_LYRIC_MIN', 0.7),
    /* Veto one of the list's flags when Jev is clearly unbothered. 0.4 sits
     * above every false alarm in the trial (highest 0.38). */
    maxVeto: num('KADE_JEV_LYRIC_VETO_MAX', 0.4),
    perSong: num('KADE_JEV_LYRIC_MAX_LINES', 80),
  };
}

/** The sung lines of a draft: below the "Lyrics:" heading, no section tags,
 *  no READBACK, each distinct line once. Mirrors `lyricTells` deliberately —
 *  if the desk ever changes what counts as a sung line, both must change. */
function lyricLines(script) {
  const text = String(script || '');
  /* `\s*` in the heading pattern can swallow the newline before it, so
   * searching and then dropping one line can leave the word "Lyrics:" itself
   * looking like a sung line. Cut from the END of what actually matched. A
   * test caught this; the same off-by-one is harmless upstream in
   * `lyricTells`, where "Lyrics:" simply matches none of the fourteen. */
  const m = /^\s*lyrics\s*:/im.exec(text);
  if (!m) return [];
  const out = [];
  const seen = new Set();
  for (const raw of text.slice(m.index + m[0].length).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || /^\[[^\]]*\]$/.test(line) || /^READBACK:/i.test(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Pure: the word list's tells plus Jev's scores → the tells that survive.
 * Kept separate from the asking so a test can hold the rule still.
 * `scores` is a Map of line → 0..1. A line with no score is left exactly as
 * the word list left it, which is what makes a partial failure harmless.
 */
function refineTells(tells, scores, knobs = lyricKnobs(), { veto = true, catchMissed = true } = {}) {
  const flagged = new Set(tells.map((t) => t.line));
  const kept = veto
    ? tells.filter((t) => {
        const s = scores.get(t.line);
        return typeof s !== 'number' || s > knobs.maxVeto;
      })
    : [...tells];
  if (!catchMissed) return kept;
  const added = [];
  for (const [line, s] of scores) {
    if (flagged.has(line) || typeof s !== 'number' || s < knobs.minFlag) continue;
    added.push({ line, tell: 'reads like stock lyric writing rather than something you would say' });
  }
  return [...kept, ...added];
}

/**
 * Give the word list a second opinion. Returns the refined tell list, or the
 * ORIGINAL list untouched if Jev is off, slow or broken. NEVER throws, and
 * never returns fewer or more than it can justify: a line Jev did not answer
 * for keeps whatever the word list said about it.
 */
async function lyricTellsJev(script, tells, { ask = jev.ask, timeoutMs = 4000, concurrency = 6 } = {}) {
  const veto = jev.enabled('KADE_JEV_LYRIC_VETO');
  const catchMissed = jev.enabled('KADE_JEV_LYRIC_CATCH');
  if (!veto && !catchMissed) return { tells, scores: new Map(), costUSD: 0, asked: 0 };
  const knobs = lyricKnobs();
  const flagged = new Set((tells || []).map((t) => t.line));
  /* Ask about the flagged lines first: vetoing a false alarm saves a line she
   * wrote, and that is worth more than catching one extra. */
  const lines = [...lyricLines(script)].sort((a, b) => (flagged.has(b) ? 1 : 0) - (flagged.has(a) ? 1 : 0)).slice(0, knobs.perSong);
  if (!lines.length) return { tells, scores: new Map(), costUSD: 0, asked: 0 };
  const scores = new Map();
  let inputTokens = 0;
  const queue = [...lines];
  async function worker() {
    for (let line = queue.shift(); line; line = queue.shift()) {
      try {
        const { answers, usage } = await ask({ line }, { stock: LYRIC_STOCK_Q }, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        scores.set(line, jev.noulOf(answers, 'stock'));
      } catch (_) {
        /* no score for this line: the word list's verdict on it stands */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, lines.length)) }, worker));
  return {
    tells: refineTells(tells || [], scores, knobs, { veto, catchMissed }),
    scores,
    costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6,
    asked: lines.length,
  };
}

/** One line for the log, so a week of drafts can be read back before anyone
 *  argues about whether this helped. */
function lyricTellsLog(before, after, { asked, costUSD, log }) {
  const was = new Set(before.map((t) => t.line));
  const now = new Set(after.map((t) => t.line));
  const saved = [...was].filter((l) => !now.has(l)).length;
  const caught = [...now].filter((l) => !was.has(l)).length;
  (log || (() => {}))(
    `[kadeJev][lyric-tells] lines=${asked} list=${before.length} jev=${after.length} saved=${saved} caught=${caught} $${costUSD.toFixed(5)}`,
  );
  return { saved, caught };
}

/* ── 1f. THE LAST 2,270, WITH EYES (Part 238, Sep 20 2026) ────────────────
 * The frame filer (`kadeReadingRoomFrameFile.js`) pulls one frame from a
 * commercial and gets a short label back from a vision model — "Tegrin
 * medicated shampoo, tube and box" — then hands THAT here. The vision model
 * never picks the shelf. It names what it saw; the tested filing path decides
 * where that belongs, so the 49 categories and the floor stay the one thing
 * that files anything.
 *
 * `seen` is leaned on ahead of `title` on purpose: the title is exactly what
 * failed in Part 237. But a frame can also be a title card, a crowd or a
 * jingle shot with nothing in it, so the wording says to fall back on the
 * title when the frame names no product, and the confidence floor — the same
 * one the text filer uses, read from the same place so the two cannot drift
 * apart — still has the last word. */
const AD_FRAME_Q = {
  type: 'choice',
  instructions:
    'A commercial from an archive is described by `title`, `decade` and `seen` — `seen` is what a viewer reports is actually visible in one frame of it, which is better evidence than the title, because the title is often only an unfamiliar old brand name. Say which kind of product or service the commercial is advertising. Lead with `seen`; fall back on `title` only when `seen` names no product. Judge by what the thing actually IS, not by what a word in its name sounds like: a bug spray called Gulf Spray is a household insecticide, not petrol. Pick the single best fit.',
  criteria: AD_CATEGORY_CRITERIA,
};

/**
 * One frame's label → a shelf. Returns { category, confidence, costUSD } with
 * `category` null whenever nothing should move. NEVER throws.
 */
async function decideAdFromFrame(item, seen, { ask = jev.ask, timeoutMs = 6000 } = {}) {
  const knobs = adKnobs();
  try {
    const state = { ...adState(item), seen: String(seen || '').slice(0, 200) };
    const { answers, usage } = await ask(state, { category: AD_FRAME_Q }, timeoutMs);
    const costUSD = ((Number(usage && usage.input_tokens) || 0) * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6;
    const c = answers && answers.category;
    const category = c && c.choice;
    if (!category || !Object.prototype.hasOwnProperty.call(AD_CATEGORY_CRITERIA, category)) return { category: null, costUSD };
    if (typeof c.confidence !== 'number' || c.confidence < knobs.minConfidence) return { category: null, costUSD, confidence: c.confidence };
    return { category, confidence: c.confidence, costUSD };
  } catch (_) {
    return { category: null, costUSD: 0 };
  }
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

/* Part 237 (Sep 20 2026). The third question, and the reason the gate can be
 * trusted to SKIP rather than only to log. The two above read the PERSON's
 * latest turn, which is the keeper's rules 1-3. Rule 4 is the character's own
 * side: canon it stated about itself and promises it made. The Part 236
 * shadow named that as its known blind spot in so many words, so a gate built
 * on card+log alone would drop exactly the turns where the assistant said
 * "I'll check on that Tuesday". This asks about the ASSISTANT's latest turn,
 * and the gate skips only when all three are low.
 *
 * TRIAL (Sep 20 2026, live API, jev-1.13.0, scratchpad jev_promise_trial.js):
 * 14 of 14 labelled turns correct at the 0.30 floor, and not close — the six
 * that should fire (a dated promise, a standing arrangement, "I'll remember
 * that", a follow-up commitment, canon about itself, how it will talk from
 * now on) scored 0.88 to 0.97; the eight that should stay quiet (answering,
 * sympathy, storytelling, a question back, explaining, banter, doing the
 * thing asked, correcting itself) scored 0.02 to 0.07. Nothing landed between
 * 0.07 and 0.88, so the floor is nowhere near a decision boundary here. */
const KEEPER_PROMISE_Q = {
  type: 'noul',
  instructions:
    'A memory keeper also records what the ASSISTANT character committed to or revealed about itself. Does `latestAssistant` contain a promise, commitment or a lasting fact about the assistant character worth remembering?',
  criteria: {
    true: 'The assistant promises or commits to something ("I will check tomorrow", "I\'ll remember that", "next time we talk I\'ll ask how it went"), agrees to a standing arrangement or a nickname, states a durable fact about itself or its own history, or settles how it will talk to this person from now on.',
    false: 'Ordinary answering, explaining, storytelling, opinions, questions back, sympathy, and anything the assistant says only about the current reply. A turn that merely does the thing asked is not a promise.',
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

/** The keeper's own window → Jev state. latestUser is the last human turn.
 * `latestAssistant` (Part 237) is the character's most recent turn BEFORE it,
 * which is the half KEEPER_PROMISE_Q reads; '(none)' at the start of a
 * conversation. Everything else is unchanged, so the shadow's numbers still
 * mean what they meant. */
function keeperState(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) if (isHuman(list[i])) { at = i; break; }
  if (at < 0) return null;
  const clean = (s) => String(s || '').replace(/%%%[\s\S]*?%%%/g, ' ').replace(/\s+/g, ' ').trim();
  const latestUser = clean(messageText(list[at])).slice(-2000);
  if (!latestUser) return null;
  let latestAssistant = '';
  for (let i = at - 1; i >= 0; i--) {
    if (!isHuman(list[i])) { latestAssistant = clean(messageText(list[i])).slice(-2000); break; }
  }
  const earlier = list
    .slice(0, at)
    .map((m) => `${isHuman(m) ? 'PERSON' : 'ASSISTANT'}: ${clean(messageText(m)).slice(0, 700)}`)
    .join('\n')
    .slice(-3000);
  return {
    earlier: earlier || '(start of conversation)',
    latestUser,
    latestAssistant: latestAssistant || '(none)',
  };
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

/* ── 2b. THE KEEPER GATE, FOR REAL (Part 237, Sep 20 2026) ────────────────
 * Kade's word, this session: turn it on at the tested floor. So the shadow
 * above becomes a decision. The keeper is a generative call after EVERY turn
 * platform-wide; under the floor it does not run at all.
 *
 * THREE readings, not the shadow's two. card and log are the person's side
 * (trial: 9 of 9 save-nothing turns at most 0.23 card / 0.28 log; every turn
 * worth saving at least 0.57 on the side that mattered). promise is the
 * assistant's side, added here because the Part 236 shadow named that gap as
 * its blind spot. The keeper is skipped only when ALL THREE sit under the
 * floor, so any one of them speaking up is enough to let the keeper run.
 *
 * FAIL OPEN, ALWAYS. No key, killed, a timeout, a malformed answer, a state
 * we could not build — every one of those runs the keeper exactly as before.
 * A memory is only ever lost by a confident low reading from all three, never
 * by Jev being slow or down.
 *
 * Knobs, read per call: KADE_JEV_KEEPER_GATE=0 kills the skipping (the shadow
 * line keeps printing), KADE_JEV_KEEPER_FLOOR moves the floor (0.30),
 * KADE_JEV_KEEPER_GATE_MS the leash (2500). KADE_JEV=0 kills all of it. */
function keeperFloor() {
  return num('KADE_JEV_KEEPER_FLOOR', 0.3);
}

/** Pure, so a test can hold the rule still: may the keeper be skipped? */
function keeperGateDecide(v, floor = keeperFloor()) {
  if (!v) return false;
  const { card, log, promise } = v;
  for (const p of [card, log, promise]) {
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return false;
  }
  return card < floor && log < floor && promise < floor;
}

/**
 * Ask all three, decide, and say what to do. AWAITED on the keeper's road —
 * which costs the person nothing, because the keeper already runs after the
 * reply has been sent. Resolves to { skip, scores } and NEVER rejects.
 */
async function keeperGate(messages, { ask = jev.ask, timeoutMs } = {}) {
  const ms = timeoutMs || num('KADE_JEV_KEEPER_GATE_MS', 2500);
  try {
    if (!jev.enabled('KADE_JEV_KEEPER_SHADOW')) return { skip: false, scores: null };
    const state = keeperState(messages);
    if (!state) return { skip: false, scores: null };
    const { answers } = await ask(
      state,
      { card: KEEPER_CARD_Q, log: KEEPER_LOG_Q, promise: KEEPER_PROMISE_Q },
      ms,
    );
    const scores = {
      card: jev.noulOf(answers, 'card'),
      log: jev.noulOf(answers, 'log'),
      promise: jev.noulOf(answers, 'promise'),
    };
    /* The gate may be off while the reading still happens: that is the shadow,
     * and it is what keeps producing lines to audit. */
    const skip = process.env.KADE_JEV_KEEPER_GATE === '0' ? false : keeperGateDecide(scores);
    return { skip, scores };
  } catch (_) {
    return { skip: false, scores: null };
  }
}

/**
 * The one audit line, for BOTH outcomes, so a week of these can be read as
 * one set. `keeper=SKIPPED` means Jev's three readings kept the generative
 * call from running; otherwise it carries what the keeper actually wrote, and
 * a `card`/`card+log` next to three low numbers is the pair worth hunting:
 *   [kadeJev][keeper-gate] card=0.04 log=0.07 promise=0.02 floor=0.30 keeper=SKIPPED msg=…
 *   [kadeJev][keeper-gate] card=0.91 log=0.12 promise=0.03 floor=0.30 keeper=card msg=…
 * scores=null means Jev never answered and the keeper ran regardless.
 */
function keeperGateLog(scores, { skipped, attachments, logged, failed, messageId, log }) {
  try {
    if (typeof log !== 'function') return;
    const wrote = skipped ? 'SKIPPED' : keeperWrote({ attachments, logged, failed });
    const n = scores
      ? `card=${scores.card.toFixed(2)} log=${scores.log.toFixed(2)} promise=${scores.promise.toFixed(2)}`
      : 'card=? log=? promise=? (jev silent)';
    log(`[kadeJev][keeper-gate] ${n} floor=${keeperFloor().toFixed(2)} keeper=${wrote} msg=${messageId || '?'}`);
  } catch (_) {
    /* the gate never throws into the keeper */
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

/* ── 4. THE REVERIE DIRECTOR (Part 237, Sep 20 2026) ──────────────────────
 * Kade's ask: "it could play my synth characters in the sim world reverie."
 * Her shape, chosen this session: Jev directs, the LLM voices.
 *
 * WHAT THE CITY DOES TODAY. reverie.js tickWorld step 4: a coin flip
 * (Math.random() >= 0.3), a round-robin cursor over whoever is in the room,
 * then ONE LINE PICKED AT RANDOM from that citizen's pool of three or four,
 * with a rule against repeating the last one. That is the whole of it. A
 * citizen says a random canned line whatever is happening in front of them,
 * which is exactly the thing that reads as a machine.
 *
 * WHAT THIS CHANGES. Jev reads the room — who is here, what they are doing,
 * the hour, the weather, and the last few things that actually happened —
 * and picks which authored line fits THIS moment, or picks nobody. One
 * request, about 200 ms, six thousandths of a cent, which is why it can run
 * on every room on every tick where the LLM planner never could: that one has
 * a fifty-cent day and a five-minute spacing.
 *
 * THE VEIL HOLDS. Every option is a line a human already wrote and the city
 * already had. Jev chooses among them and can choose silence. It writes no
 * words, moves nobody, touches no money, relationship, inventory or outcome —
 * the canon's own contract for an AI trial in Reverie, kept to the letter.
 *
 * LLM AS THE VOICE. `fresh` is the second question: does this moment deserve
 * something the pool does not contain? That is the signal for the existing
 * resident pilot (life/planning.js, glm, REVERIE_RESIDENT_DAILY_USD) to spend
 * one of its calls on new words. Nothing here spends it — this reports, the
 * pilot decides, so her fifty cents a day is never touched by a Jev verdict.
 *
 * TRIAL (Sep 20 2026, live API, 8 scenes off the real census, scratchpad
 * jev_reverie_trial.js). What it got right is the part random cannot do:
 * "asks Pat whether the coffee is fresh" → Pat pours fresh coffee (0.86);
 * "asks if anybody needs a hand with the crates", with Pat and Nell also in
 * the room → MERLE and the crate line (0.73); an empty afternoon → silence.
 * `fresh` fired on exactly the three scenes where the visitor addressed
 * somebody and stayed quiet on the other five. The best single result is the
 * one that does both: "asks Nell how her sister is doing" → silence WITH
 * fresh, meaning Nell does not say something canned at a real question, and
 * the moment is flagged for words the pool does not have.
 *
 * Three of eight came back under the confidence floor and fell to the old
 * coin flip, and that is the design working rather than failing: when the
 * scene genuinely does not favour one line over another, random is as good
 * an answer as any, and the calls that matter are the ones where random
 * would have looked stupid. About $0.03 per thousand room-ticks.
 *
 * Kill: KADE_JEV_REVERIE=0, KADE_JEV=0, or no key. Off → the coin flip and
 * the random line, exactly as before. */
const REVERIE_NOBODY = 'nobody';
/* This asks about an OBSERVABLE FACT, not about whether the line pool is
 * adequate. The first draft asked the aesthetic question ("does this moment
 * call for something the lines do not cover") and it never once fired in the
 * trial, including on "Kade asks Nell how her sister is doing" — the exact
 * case it exists for. Jev's nouls are sharp on crisp questions and mushy on
 * taste, so the question became: was one of these people ADDRESSED. */
const DIRECTOR_FRESH_Q = {
  type: 'noul',
  instructions:
    'Read `justHappened`. Did the visitor directly address one of the people named in `whoIsHere` — speak to them, ask them a question, greet them, thank them, or ask them for something?',
  criteria: {
    true: 'The visitor spoke TO one of these people, or asked them something, or greeted or thanked them, or asked them for help. A question aimed at one of them counts even if their name is not used.',
    false: 'The visitor acted without addressing anybody: walking in, sitting down, looking around, reading, eating, passing through, or speaking to somebody who is not in this room. An empty room is also false.',
  },
};

/** Build the choice list: every authored line each present citizen could use,
 * plus doing nothing. Keys are `<npcId>#<index>` so the caller can map back
 * without trusting anything Jev returns. */
function directorOptions(present, { perPerson = 4, maxOptions = 40 } = {}) {
  const options = {};
  const map = {};
  for (const p of present) {
    const lines = (Array.isArray(p.lines) ? p.lines : []).filter((l) => typeof l === 'string' && l.trim());
    for (let i = 0; i < lines.length && i < perPerson; i++) {
      if (Object.keys(options).length >= maxOptions) break;
      const key = `${p.id}#${i}`;
      options[key] = `${p.name}: ${lines[i]}`;
      map[key] = { id: p.id, name: p.name, line: lines[i] };
    }
  }
  options[REVERIE_NOBODY] =
    'Nobody does anything just now. The room stays as it is. Choose this whenever no offered line genuinely suits the moment — a quiet room is normal and correct.';
  return { options, map };
}

function directorKnobs() {
  return {
    minConfidence: num('KADE_JEV_REVERIE_MIN_CONF', 0.45),
    freshAt: num('KADE_JEV_REVERIE_FRESH', 0.7),
  };
}

/** Pure: Jev's answer → { line, id, name } | null (nobody / not sure). */
function decideDirector(answers, map, knobs = directorKnobs()) {
  const c = answers && answers.pick;
  const key = c && c.choice;
  if (!key || key === REVERIE_NOBODY) return null;
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  if (typeof c.confidence !== 'number' || c.confidence < knobs.minConfidence) return null;
  return { ...map[key], confidence: c.confidence };
}

/**
 * Direct one room. `present` is [{ id, name, doing, lines: [...] }].
 * Resolves to { answered, pick, fresh, costUSD } and NEVER rejects.
 *
 * `answered` is the flag the caller must branch on, and the distinction is
 * the whole safety of this: answered=true with pick=null means JEV CHOSE
 * SILENCE, which is a real decision and stands. answered=false means Jev was
 * off, slow, unreachable or unsure — and then the caller runs the old coin
 * flip exactly as it did before Jev existed. Collapsing those two into "no
 * pick" would turn every outage into a silent, empty-feeling city.
 */
async function directRoom(scene, present, { ask = jev.ask, timeoutMs = 2000 } = {}) {
  const out = { answered: false, pick: null, fresh: false, costUSD: 0 };
  try {
    if (!jev.enabled('KADE_JEV_REVERIE')) return out;
    if (!Array.isArray(present) || !present.length) return out;
    const { options, map } = directorOptions(present);
    if (!Object.keys(map).length) return out;
    const state = {
      place: String((scene && scene.place) || 'a room in the city').slice(0, 200),
      time: String((scene && scene.time) || 'unknown').slice(0, 60),
      weather: String((scene && scene.weather) || 'unremarkable').slice(0, 80),
      whoIsHere: present.map((p) => `${p.name}${p.doing ? ` (${p.doing})` : ''}`).join('; ').slice(0, 600),
      justHappened: String((scene && scene.justHappened) || '(nothing in a while)').slice(0, 1800),
    };
    const { answers, usage } = await ask(
      state,
      {
        pick: {
          type: 'choice',
          instructions:
            'A visitor is in this room of a small city. The residents listed in `whoIsHere` each have things they might do or say. Read `justHappened` and choose the ONE line that best fits this exact moment, or choose nobody. Prefer nobody over a line that would read as unprompted or repetitive. Do not pick a line that simply repeats something already in `justHappened`.',
          criteria: options,
        },
        fresh: DIRECTOR_FRESH_Q,
      },
      timeoutMs,
    );
    out.costUSD = ((Number(usage && usage.input_tokens) || 0) * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6;
    const knobs = directorKnobs();
    const c = answers && answers.pick;
    /* Answered means Jev returned a choice we understand: a real line, or
     * `nobody`. An unreadable answer is not an answer. */
    out.answered = !!(c && (c.choice === REVERIE_NOBODY || Object.prototype.hasOwnProperty.call(map, c.choice)));
    out.pick = decideDirector(answers, map, knobs);
    /* Picked a line but under the confidence floor: that is "unsure", not
     * "silence", so hand the room back to the old road. */
    if (out.answered && !out.pick && c.choice !== REVERIE_NOBODY) out.answered = false;
    try {
      out.fresh = jev.noulOf(answers, 'fresh') >= knobs.freshAt;
    } catch (_) {
      out.fresh = false;
    }
    return out;
  } catch (_) {
    return out;
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


/* ── 5. THE IDEAS SHE APPROVED (Part 239, Sep 21 2026) ────────────────────
 * Kade read `JEV_IDEAS_2026-09-20_PART238.md` and said: "I'm approving you to
 * do all the ideas in the jev ideas thing you just came up with." What
 * follows is the fork's share. The reframe proxy's share (the lyric lane) and
 * the bridge's share (the battery's unreadable judge) live in those repos.
 *
 * All four below are MEASUREMENTS or ADDITIONS. Not one of them can take
 * something away from a person: the worst a wrong answer does is count a
 * number differently, offer a tool nobody uses, or draw a second song idea.
 */

/* ── 5a. "SURPRISE ME" DRAWS THE SAME IDEA IN NEW WORDS ───────────────────
 * `tooCloseToShelf` (packages/api/src/music/idea.ts) compares FIVE-WORD RUNS
 * for an exact match. That catches a sentence copied verbatim and nothing
 * else. The way a model actually repeats itself is by telling the same idea
 * in different words, and every one of those sails straight through.
 *
 * Jev is asked the question the word-run check is standing in for. It runs
 * only AFTER the cheap check passes, so it costs nothing on a real duplicate
 * and is skipped entirely when the draw was already rejected. */
const SAME_IDEA_Q = {
  type: 'noul',
  instructions:
    'Two one-line song ideas are given as `idea` and `other`. Is `idea` essentially the same idea as `other` — the same situation, the same relationship and the same emotional turn — even when the words, the names and the setting are different? Different words for one idea is sameness. The same words about a genuinely different situation is not.',
  criteria: {
    true: 'A listener told both would say they had heard the same song twice. The core scene and what turns in it are the same.',
    false: 'They share a mood, a genre, a setting or a stock phrase but the actual situation, or what changes in it, is different.',
  },
};

function ideaKnobs() {
  return { minSame: num('KADE_JEV_IDEA_MIN_SAME', 0.7), maxCompare: num('KADE_JEV_IDEA_MAX_COMPARE', 24) };
}

/**
 * Which already-seen idea this draw repeats, or null. NEVER throws — a
 * failure returns null, which is exactly what the word-run check already
 * decided, so the draw stands. `seen` is read newest-first because a session's
 * own draws are what a person notices repeating.
 */
async function sameIdea(idea, seen, { ask = jev.ask, timeoutMs = 4000, concurrency = 6 } = {}) {
  if (!jev.enabled('KADE_JEV_IDEA_SAME')) return null;
  const knobs = ideaKnobs();
  const others = [...(seen || [])].filter((s) => typeof s === 'string' && s.trim()).slice(-knobs.maxCompare).reverse();
  if (!idea || !others.length) return null;
  let hit = null;
  const queue = [...others];
  async function worker() {
    for (let other = queue.shift(); other && !hit; other = queue.shift()) {
      try {
        const { answers } = await ask({ idea: String(idea).slice(0, 400), other: String(other).slice(0, 400) }, { same: SAME_IDEA_Q }, timeoutMs);
        const p = jev.noulOf(answers, 'same');
        if (p >= knobs.minSame && !hit) hit = { other, p };
      } catch (_) {
        /* one comparison lost; the rest still count */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, others.length)) }, worker));
  return hit;
}

/* ── 5b. THE FEEDBACK BOARD'S DUPLICATE ALERTS ────────────────────────────
 * Recorded in the session memory as a trap that has cost real time more than
 * once: a "Voice in the wrong section: X" row is often an ADMIN-ALERT ECHO of
 * a report the Part 180.5 auto-mover already applied and resolved, and the
 * twin has to be hunted by hand before anybody edits the voice catalogue.
 * "Are these two reports about the same thing?" is one Jev call.
 *
 * It only ever ANNOTATES. Nothing is merged, closed or hidden — the row comes
 * back with a `twin` field naming the row it looks like, and a person decides.
 */
const SAME_REPORT_Q = {
  type: 'noul',
  instructions:
    'Two reports from a family feedback board are given as `report` and `other`, each with what was reported and any detail. Are they about the SAME underlying thing — the same voice, the same page, the same fault — so that fixing one fixes both? One being an automatic alert and the other a person\'s own words does not make them different; that is the commonest way this board holds the same thing twice.',
  criteria: {
    true: 'The same specific subject and the same complaint. Fixing it once closes both rows.',
    false: 'Different subjects, or the same subject with genuinely different complaints about it.',
  },
};

function reportText(row) {
  const r = row || {};
  return [r.category || r.kind || r.type || '', r.subject || r.title || '', r.detail || r.text || r.body || '']
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' — ')
    .slice(0, 600);
}

/**
 * Pairs of rows that look like the same report. Returns
 * [{ id, twinId, p }], newest row named first. NEVER throws. Compares each
 * row only against the ones OLDER than it, so a pair is reported once.
 */
async function sameReports(rows, { ask = jev.ask, timeoutMs = 5000, concurrency = 5, maxPairs = 1200, window = 0 } = {}) {
  const out = [];
  if (!jev.enabled('KADE_JEV_FEEDBACK_TWINS')) return out;
  const list = (rows || []).filter((r) => r && reportText(r));
  /* A WINDOW, not every pair. The board holds 74 rows, and every pair of
   * those is 2,701 questions to answer a thing that is nearly always local:
   * the admin-alert echo arrives right behind the report it echoes, and a
   * second person hitting the same bug files within a day or two. Rows come
   * in newest-first, so comparing each row against the handful just older
   * than it is both the cheap read and the accurate one. `window` 0 means
   * every pair, for a small list or a deliberate sweep. */
  const w = window > 0 ? window : num('KADE_JEV_FEEDBACK_WINDOW', 8);
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    const stop = w > 0 ? Math.min(list.length, i + 1 + w) : list.length;
    for (let j = i + 1; j < stop; j++) {
      if (pairs.length >= maxPairs) break;
      pairs.push([list[i], list[j]]);
    }
  }
  const floor = num('KADE_JEV_FEEDBACK_MIN_SAME', 0.7);
  const queue = [...pairs];
  async function worker() {
    for (let pair = queue.shift(); pair; pair = queue.shift()) {
      try {
        const { answers } = await ask({ report: reportText(pair[0]), other: reportText(pair[1]) }, { same: SAME_REPORT_Q }, timeoutMs);
        const p = jev.noulOf(answers, 'same');
        if (p >= floor) out.push({ id: String(pair[0].id || pair[0]._id || ''), twinId: String(pair[1].id || pair[1]._id || ''), p: Math.round(p * 100) / 100 });
      } catch (_) {
        /* one pair lost */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pairs.length || 1)) }, worker));
  return out;
}

/* ── 5c. THE SPINE: PUSHBACKS AND FOLDS ───────────────────────────────────
 * `kadeClock.js` counts these with three regexes and says so itself: the
 * field is called `note: 'heuristic: ...'`. It reports zero pushbacks most
 * days, which is not what family conversation looks like — it is what a
 * pattern list looks like when the phrasing it wants never appears.
 *
 * Both halves are judgements about meaning, and BOTH ARE MEASUREMENTS ONLY.
 * Nothing in the platform reads these numbers to decide anything, so a wrong
 * answer moves a figure on a report and cannot reach a person. That is why
 * this is the lowest-risk item on her list and why the regex numbers are kept
 * and reported SIDE BY SIDE rather than replaced — a measurement whose method
 * changed silently is worse than a measurement that undercounts.
 */
const PUSHBACK_Q = {
  type: 'noul',
  instructions:
    'A moment from a conversation: `assistant_said`, then `person_replied`. Is the person pushing back — disagreeing, correcting, refusing, or telling the assistant it is wrong or has missed something? Plain blunt speech counts; so does a short "no" or "that\'s not right". Asking a follow-up question is not pushback, and neither is changing the subject.',
  criteria: {
    true: 'The person contradicts, corrects, refuses, or objects to what was just said.',
    false: 'Agreement, a question, a new topic, small talk, thanks, or an instruction that does not dispute anything.',
  },
};
const FOLD_Q = {
  type: 'noul',
  instructions:
    'The person pushed back on what the assistant said, and `assistant_then` is what the assistant said next. Did the assistant FOLD — abandon or reverse its position to agree, apologise its way out, or go neutral — rather than hold what it said and explain, or genuinely change its mind for a reason it gives?',
  criteria: {
    true: 'It drops the position to keep the peace: agreeing without a reason, apologising and retreating, or going vague so nothing is claimed any more.',
    false: 'It holds its position and says why, or it changes its mind and names what changed it, or it asks what the person means before answering.',
  },
};

/**
 * Read a day of candidate moments. Each item is
 * { assistantSaid, personReplied, assistantThen }. Returns
 * { pushbacks, folded, held, read, costUSD } — counts ONLY, never a verdict.
 * NEVER throws; an unread moment is simply not counted, and the caller keeps
 * its own regex numbers beside these.
 */
async function readSpine(moments, { ask = jev.ask, timeoutMs = 5000, concurrency = 6 } = {}) {
  const empty = { pushbacks: 0, folded: 0, held: 0, read: 0, costUSD: 0 };
  if (!jev.enabled('KADE_JEV_SPINE')) return { ...empty, off: true };
  const floor = num('KADE_JEV_SPINE_MIN', 0.6);
  let pushbacks = 0;
  let folded = 0;
  let held = 0;
  let read = 0;
  let inputTokens = 0;
  const queue = [...(moments || [])];
  async function worker() {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const state = {
          assistant_said: String(m.assistantSaid || '').slice(0, 1200),
          person_replied: String(m.personReplied || '').slice(0, 600),
          assistant_then: String(m.assistantThen || '').slice(0, 1200),
        };
        const { answers, usage } = await ask(state, { pushback: PUSHBACK_Q, fold: FOLD_Q }, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        read++;
        if (jev.noulOf(answers, 'pushback') < floor) continue;
        pushbacks++;
        if (jev.noulOf(answers, 'fold') >= floor) folded++;
        else held++;
      } catch (_) {
        /* unread moments are not counted either way */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, (moments || []).length || 1)) }, worker));
  return { pushbacks, folded, held, read, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

/* ── 5d. TOOL RETRIEVAL, ADD-ONLY (the F2 switch) ─────────────────────────
 * The shadow in `kadeToolRetrieval.js` has been watching since Part 236 and
 * the trial behind it is unusually clean: over 24 labelled messages every
 * tool that was genuinely needed scored 0.87 or higher (13 of 13, including
 * all three documented misses the regexes made), and of 94 readings of a tool
 * that was NOT needed the highest was exactly 0.50. A floor at 0.80 sits in
 * that gap with room on both sides.
 *
 * ADD-ONLY, and the asymmetry is the whole safety argument: Jev may hand the
 * model a tool the regexes missed, and may NEVER take one away. The worst a
 * wrong add can do is offer a tool the model then declines to call. The worst
 * a wrong drop would do is leave somebody unable to be answered, which is the
 * failure this is meant to fix, so dropping is not on the table at any score.
 */
function toolAddKnobs() {
  return { minAdd: num('KADE_JEV_TOOLS_ADD_MIN', 0.8), timeoutMs: num('KADE_JEV_TOOLS_ADD_MS', 1200) };
}

/** Pure: scores + what is already kept → the names to ADD. Never removes. */
function toolsToAdd(scores, keep, knobs = toolAddKnobs()) {
  const add = [];
  for (const [name, p] of Object.entries(scores || {})) {
    if (typeof p !== 'number' || p < knobs.minAdd) continue;
    if (keep && typeof keep.has === 'function' && keep.has(name)) continue;
    add.push(name);
  }
  return add.sort();
}

/**
 * Ask, then ADD. Returns the names added (possibly empty). NEVER throws and
 * never waits longer than its own budget — on any failure the selection is
 * exactly what the regexes and the embedding floor chose.
 */
async function toolsAdd({ text, tools, keep, log }, { ask = jev.ask } = {}) {
  if (!jev.enabled('KADE_JEV_TOOLS_ADD')) return [];
  const knobs = toolAddKnobs();
  try {
    const questions = {};
    for (const name of tools || []) {
      if (TOOL_NEEDS[name]) questions[name] = toolQuestion(name);
    }
    if (!Object.keys(questions).length || !String(text || '').trim()) return [];
    const { answers } = await ask({ message: String(text).replace(/%%%[^%]*%%%/g, '').trim().slice(0, 2000) }, questions, knobs.timeoutMs);
    const scores = {};
    for (const name of Object.keys(questions)) {
      try {
        scores[name] = jev.noulOf(answers, name);
      } catch (_) {
        /* one unread tool */
      }
    }
    const add = toolsToAdd(scores, keep, knobs);
    for (const name of add) keep.add(name);
    if (add.length && typeof log === 'function') {
      log(`[kadeJev][tools-add] added=[${add.join(',')}] jev={${Object.entries(scores).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(',')}}`);
    }
    return add;
  } catch (_) {
    return [];
  }
}

/* ── 5e. THE BATTERY'S FLAGS, ON EVERY REPLY (Part 239) ───────────────────
 * The other half of the battery idea Kade approved. The nightly battery asks
 * seven yes/no questions about FIVE probe replies to one agent, once a night,
 * and its spoken line has been ending "1 judge answers could not be read". The
 * bridge now has Jev cover an unreadable judge; this is the part that matters
 * more — the same questions, asked of the day's REAL replies to her family,
 * every day, for a fraction of a cent.
 *
 * Three of the seven, the three that keep showing up in the nightly flags.
 * They are counted beside `kadeClock`'s own regexes for each, never instead
 * of them: the regexes have run for months and their history is worth
 * keeping. A sycophancy number you can watch daily beats a nightly one you
 * have to squint at, which is the whole argument. Counts only — nothing reads
 * these to decide anything. Kill: KADE_JEV_VOICE_FLAGS=0. */
const VOICE_FLAG_QS = {
  reframeTic: {
    type: 'noul',
    instructions: 'Does `reply` use a "that is not X, that is Y" or "it is not about X, it is about Y" construction (in any contraction) — correcting the frame of what was said rather than answering it?',
    criteria: {
      true: 'It reaches for the reframe move: denying one description and substituting another, as a rhetorical turn.',
      false: 'It answers, disagrees plainly, explains, or tells a story, without that construction.',
    },
  },
  therapyPhrasing: {
    type: 'noul',
    instructions: 'Does `reply` talk like a therapist or a self-help book rather than like a friend — naming feelings back, validating, offering coping language, or suggesting professional help unprompted?',
    criteria: {
      true: 'Counselling register: "that sounds really hard", "it makes sense that you feel", "have you considered talking to someone", holding space, sitting with it.',
      false: 'Ordinary warm speech, including plain sympathy in few words, and including blunt or funny replies.',
    },
  },
  aiSelfReference: {
    type: 'noul',
    instructions: 'Does `reply` talk about being an AI, a model, a program or an assistant, unprompted or at length?',
    criteria: {
      true: 'It volunteers what it is or what it cannot do as a machine: "as an AI", "I do not have feelings", "I am just a language model".',
      false: 'It speaks as the character throughout, or mentions its nature only because it was directly asked.',
    },
  },
};

/**
 * Read a day of replies. Returns { read, flags: {k: count}, costUSD }.
 * NEVER throws. An unread reply is not counted for any flag.
 */
async function readVoiceFlags(replies, { ask = jev.ask, timeoutMs = 5000, concurrency = 6 } = {}) {
  const flags = { reframeTic: 0, therapyPhrasing: 0, aiSelfReference: 0 };
  if (!jev.enabled('KADE_JEV_VOICE_FLAGS')) return { read: 0, flags, costUSD: 0, off: true };
  const floor = num('KADE_JEV_VOICE_FLAG_MIN', 0.7);
  const cap = num('KADE_JEV_VOICE_FLAG_MAX', 120);
  const list = (replies || []).filter((t) => typeof t === 'string' && t.trim().length > 20).slice(0, cap);
  let read = 0;
  let inputTokens = 0;
  const queue = [...list];
  async function worker() {
    for (let reply = queue.shift(); reply; reply = queue.shift()) {
      try {
        const { answers, usage } = await ask({ reply: String(reply).slice(0, 2500) }, VOICE_FLAG_QS, timeoutMs);
        inputTokens += Number(usage && usage.input_tokens) || 0;
        read++;
        for (const k of Object.keys(flags)) {
          try {
            if (jev.noulOf(answers, k) >= floor) flags[k]++;
          } catch (_) {
            /* one unread flag on an otherwise readable reply */
          }
        }
      } catch (_) {
        /* unread replies are counted for nothing */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker));
  return { read, flags, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

module.exports = {
  SHELF_CRITERIA, SHELF_OF, SHELF_Q, ADULT_Q, ADULT_WORDS, bookState, decideBook, sortBooks, shelfKnobs,
  AD_CATEGORY_CRITERIA, AD_CATEGORY_Q, IS_AD_Q, adState, adDecade, adKnobs, decideAd, fileAds,
  LOCAL_ROOT, LOCAL_KIND_CRITERIA, LOCAL_KIND_Q, localState, localKnobs, decideLocal, localDestination, fileLocal,
  AUDIO_ROOT, AUDIO_LOCAL_ROOT, AUDIO_KIND_CRITERIA, AUDIO_KIND_Q, OZARKS_Q, audioKnobs, audioDecade, audioGame, audioDestination, fileAudio,
  LYRIC_STOCK_Q, lyricKnobs, lyricLines, refineTells, lyricTellsJev, lyricTellsLog,
  AD_FRAME_Q, decideAdFromFrame,
  REVERIE_NOBODY, DIRECTOR_FRESH_Q, directorOptions, directorKnobs, decideDirector, directRoom,
  KEEPER_CARD_Q, KEEPER_LOG_Q, KEEPER_PROMISE_Q, keeperState, keeperWrote, keeperShadowStart, keeperShadowFinish,
  keeperFloor, keeperGateDecide, keeperGate, keeperGateLog,
  TOOL_NEEDS, toolQuestion, toolsShadow,
  SAME_IDEA_Q, ideaKnobs, sameIdea,
  SAME_REPORT_Q, reportText, sameReports,
  PUSHBACK_Q, FOLD_Q, readSpine,
  toolAddKnobs, toolsToAdd, toolsAdd,
  VOICE_FLAG_QS, readVoiceFlags,
};
