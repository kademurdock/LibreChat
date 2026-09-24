'use strict';
/* ----------------------------------------------------------------------------
 * THE MEDIA LIBRARIAN (Part 270, Sep 23 2026)
 *
 * Kade: "build the workflow next where jev and whatever sorts the stuff I push
 * through the cloud tab. Those videos need to be filed, things that are filed
 * should be checked for accuracy, I know when I pushed those video files
 * originally they were organised by a dumb script. I want them to be organised
 * publicly so people can easy find and view. Jev would probably need to know
 * that my described movies are in a described movies folder for example so it
 * didn't think they were books."
 *
 * Until now Jev filed the library only when someone pressed a button (the
 * catch-all commercials, the Ozarks shelf, the radio drop folder). New
 * uploads were filed by title rules alone, and whatever the rules could not
 * place piled up in `Needs Filing/Archive Intake`. This is the decision half
 * of a librarian that runs by itself; routes/kadeReadingRoomMediaSweep.js is
 * the timer and the writes.
 *
 * Three kinds of item, three levels of freedom:
 *   - FOLDER FACTS. A folder name that states a fact wins over any judgement:
 *     `described movies and TV` holds audio-described films (not books, not
 *     radio), `Cassette tapes` holds her cassettes. These move out of Needs
 *     Filing by rule, keeping her own sub-folders, and Jev is never asked.
 *   - INTAKE (Needs Filing, Archive Intake, the TubeVault "(Review)" folders,
 *     no folder at all). Jev decides the whole shelf: what the item IS, which
 *     product for an advert, whether it is Missouri. The network, the show and
 *     the decade are read off the title by rule, never asked of Jev.
 *   - ALREADY FILED. Only a clear contradiction moves: an advert sitting in a
 *     channel folder, a PSA in a product shelf, a commercial break filed as one
 *     advert. Thresholds are high because the item already has a home that is
 *     probably right. The Ozarks and Missouri shelves are never moved from.
 *
 * Flags are never moves and never deletions. They are short notes in
 * `meta.review` in the same words TubeVault uses ("Jev review: made outside
 * the US (0.93).", "Space review: family or local home recording."), so she
 * can search for them there and decide. Her keep rules (Sep 23 2026): keep
 * VHS openings, previews, kids' tapes and anything she could have seen growing
 * up; flag other people's home movies and local community recordings, full
 * sports games and anything made outside the US.
 *
 * Jev lessons carried in the wording (see memory jev-decision-model): ask for
 * an observable fact, split compound choices into yes/no questions, say that
 * a pasted company history is not where a recording aired, and never ask Jev
 * for a date, a count or a name.
 * -------------------------------------------------------------------------- */
const jev = require('./kadeJev');
const judges = require('./kadeJevJudges');

const VERSION = 1;

function num(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function knobs() {
  return {
    kind: num('KADE_MEDIA_MIN_KIND', 0.7),
    category: num('KADE_MEDIA_MIN_CAT', 0.7),
    auditKind: num('KADE_MEDIA_AUDIT_KIND', 0.9),
    auditCategory: num('KADE_MEDIA_AUDIT_CAT', 0.9),
    foreign: num('KADE_MEDIA_FOREIGN', 0.9),
    missouri: num('KADE_MEDIA_MISSOURI', 0.75),
    home: num('KADE_MEDIA_HOME', 0.85),
    elsewhere: num('KADE_MEDIA_ELSEWHERE', 0.85),
    elsewhereFlag: num('KADE_MEDIA_ELSEWHERE_FLAG', 0.8),
    tape: num('KADE_MEDIA_MIN_TAPE', 0.7),
  };
}

/* ── facts read off the item by rule ─────────────────────────────────────── */
const DECADE_SEG = /^((?:19|20)\d0s|Undated|Multiple decades)$/i;

function decadeOf(item) {
  const last = String(item.path || '').split('/').pop();
  if (DECADE_SEG.test(last)) return last;
  const y = String(item.title || '').match(/\b(19[2-9]\d|20[0-2]\d)\b/);
  if (y) return y[1].slice(0, 3) + '0s';
  const m = item.meta || {};
  if (/^(?:19|20)\d0s$/.test(String(m.decade || ''))) return String(m.decade);
  if (/^(?:19|20)\d\d$/.test(String(m.year || ''))) return String(m.year).slice(0, 3) + '0s';
  return 'Undated';
}

const HEADER = /^(?:Source:|Matched by:|Publisher description|Archive item description|Recovered from)/i;
const BOILER = /(?:copyright|do not own|no copyright infringement|all rights reserved|subscribe|like and share|fair use|belongs to (?:their|the) (?:original|respective))/i;
/** The uploader's own words, without the headers, links and disclaimers. */
function clean(desc, limit = 700) {
  const out = [];
  for (let line of String(desc || '').split('\n')) {
    line = line.trim();
    if (!line || HEADER.test(line) || BOILER.test(line)) continue;
    line = line.replace(/https?:\/\/\S+/g, '').replace(/^[\s\-:|]+|[\s\-:|]+$/g, '');
    if (line.replace(/\W/g, '').length < 3) continue;
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/* The channel folders that exist, and the words a title uses for them. Order
 * matters: the longer name is tried first (ABC Family before ABC). */
const NETWORKS = [
  [/\babc family\b/i, 'ABC Family'], [/\bfox family\b/i, 'ABC Family'],
  [/\bplayhouse disney\b/i, 'Disney Channel/Playhouse Disney'],
  [/\btoon disney\b/i, 'Toon Disney'], [/\b(?:disney channel|disney junior|zoog disney)\b/i, 'Disney Channel'],
  [/\bteen?\s?nick\b/i, 'TeenNick'], [/\bsprout\b/i, 'Sprout'],
  [/\bnoggin\b/i, 'Noggin'], [/\b(?:nick jr\.?|nick at nite|nickelodeon|nicktoons)\b/i, 'Nickelodeon'], [/\bthe n\b/i, 'The N'],
  [/\bcartoon network\b/i, 'Cartoon Network'], [/\bcomedy central\b/i, 'Comedy Central'],
  [/\b(?:cnn headline news|headline news)\b/i, 'CNN Headline News'], [/\bcnn\b/i, 'CNN'],
  [/\bdiscovery kids\b/i, 'Discovery Kids'], [/\bdiscovery channel\b/i, 'Discovery Channel'],
  [/\b(?:the learning channel|tlc)\b/i, 'The Learning Channel'], [/\banimal planet\b/i, 'Animal Planet'],
  [/\btravel channel\b/i, 'Travel Channel'], [/\bfood network\b/i, 'Food Network'], [/\bhgtv\b/i, 'HGTV'],
  [/\b(?:weather channel)\b/i, 'Weather Channel'], [/\b(?:sci-?fi channel)\b/i, 'SciFi Channel'],
  [/\b(?:family channel|cbn)\b/i, 'The Family Channel (CBN - FAM)'], [/\b(?:pax tv|pax|ion television)\b/i, 'ION (PAX TV)'],
  [/\bhallmark channel\b/i, 'Hallmark Channel'], [/\bodyssey channel\b/i, 'Odyssey Channel'],
  [/\b(?:tv land|tvland)\b/i, 'TV Land'], [/\b(?:turner classic movies|tcm)\b/i, 'TCM'], [/\btnt\b/i, 'TNT'], [/\btbs\b/i, 'TBS'],
  [/\bwgn\b/i, 'WGN Superstation'], [/\bwwor\b/i, 'WWOR Superstation'], [/\busa network\b/i, 'USA Network'],
  [/\bvh1\b/i, 'VH1'], [/\bmtv\b/i, 'MTV'], [/\bespn\b/i, 'ESPN'], [/\ba&e\b/i, 'A&E'], [/\bamc\b/i, 'AMC'],
  [/\b(?:game show network|gsn)\b/i, 'GSN'], [/\blifetime\b/i, 'Lifetime'], [/\bbravo\b/i, 'Bravo'], [/\bbet\b/i, 'BET'],
  [/\bhbo\b/i, 'HBO'], [/\bshowtime\b/i, 'Showtime'], [/\bcinemax\b/i, 'Cinemax'], [/\bstarz\b/i, 'Starz'],
  [/\bthe movie channel\b/i, 'The Movie Channel'], [/\btnn\b/i, 'TNN'], [/\b(?:prevue|tv guide channel)\b/i, 'Prevue & TV Guide Channel'],
  [/\bqvc\b/i, 'QVC'], [/\bhsn\b/i, 'HSN'], [/\bupn\b/i, 'UPN'], [/\b(?:the wb|kids'? ?wb)\b/i, 'The WB'], [/\bthe cw\b/i, 'The CW'],
  [/\bpbs\b/i, 'PBS'], [/\bcbs\b/i, 'CBS'], [/\bnbc\b/i, 'NBC'], [/\bfox\b/i, 'FOX'], [/\babc\b/i, 'ABC'],
];
function networkOf(title) {
  const t = String(title || '');
  for (const [re, name] of NETWORKS) if (re.test(t)) return name;
  return null;
}

/* ── where an item stands ────────────────────────────────────────────────── */
const LOCAL_SHELF = /^(?:Videos?|Audio)\/(?:Ozarks \(Springfield Area\)|Missouri)(?:\/|$)/i;
/* Other Commercials is not audited: two Jev passes (title only, then with descriptions) already left what is
 * there, and a third wording only re-guesses obscure brands worse (trial: Mueller's pasta to Medicine). */
const INTAKE = /(?:^|\/)(?:Needs Filing|Archive Intake|Found Media|Broadcast Presentation|Advertising)(?:\/|$)|\(Review\)/i;
function zoneOf(item) {
  const p = String(item.path || '');
  if (item.kind !== 'video' && item.kind !== 'audio') return 'skip';
  if (!p || /^(?:Videos?|Audio)\/?$/i.test(p)) return 'intake';
  if (LOCAL_SHELF.test(p)) return 'local';
  if (INTAKE.test(p)) return 'intake';
  return 'filed';
}

/** Folder names that state a fact. Returns a path or null. Never asks Jev. */
function folderFact(item) {
  if (item.kind !== 'audio') return null;
  const p = String(item.path || '');
  const o = String(item.originalPath || '');
  const described = /(?:^|\/)described movies(?: and| &)? ?(?:tv|television)?(?:\/(.*))?$/i.exec(p);
  if (described && /Needs Filing/i.test(p)) return 'Audio/Described Movies & TV' + (described[1] ? '/' + described[1] : '');
  const tapes = /(?:^|\/)Cassette tapes(?:\/(.*))?$/i.exec(p);
  if (tapes && /Needs Filing/i.test(p)) return 'Audio/Cassettes' + (tapes[1] ? '/' + tapes[1] : '');
  if (/Needs Filing/i.test(p) && /described (?:movie|video|tv)/i.test(o)) return 'Audio/Described Movies & TV';
  return null;
}

function familyOf(path) {
  const t = String(path || '').replace(/^(?:Videos?|Audio)\//i, '');
  if (/^Commercials\/Commercial Breaks(?:\/|$)/i.test(t)) return 'break';
  if (/^Commercials\/Political Ads(?:\/|$)/i.test(t)) return 'political';
  if (/^Commercials\/Infomercials/i.test(t)) return 'infomercial';
  if (/^Commercials\/Other Commercials(?:\/|$)/i.test(t)) return 'otherads';
  if (/^Commercials\//i.test(t)) return 'ad';
  if (/^Channels\//i.test(t)) return 'channel';
  if (/^TV Shows\/Assorted \(One-Offs\)(?:\/|$)/i.test(t)) return 'oneoffs';
  if (/^PSAs(?:\/|$)/i.test(t)) return 'psa';
  if (/^Home Video \(VHS\)\/((?:19|20)\d0s|Undated|Multiple decades)$/i.test(t)) return 'vhs';
  return 'other';
}

function categoryOf(path, kind) {
  const p = String(path || '');
  if (/\/Commercials(?:\/|$)|\/Radio Commercials(?:\/|$)|\/Political Ads(?:\/|$)/i.test(p)) return 'commercials';
  if (/\/PSAs(?:\/|$)/i.test(p)) return 'psa';
  if (/\/Movies & Studios(?:\/|$)/i.test(p)) return 'movie';
  if (/\/Home Video \(VHS\)(?:\/|$)/i.test(p)) return 'vhs';
  if (/\/Cassettes(?:\/|$)/i.test(p)) return kind === 'audio' ? 'cassette' : 'vhs';
  if (/\/Described Movies & TV(?:\/|$)/i.test(p)) return 'movie';
  if (/\/Audiobooks(?:\/|$)/i.test(p)) return 'audiobook';
  if (/\/Music(?:\/|$)/i.test(p)) return 'music';
  if (/\/(?:Radio|Radio Airchecks)(?:\/|$)/i.test(p)) return 'radio';
  if (/\/(?:Channels|TV Shows|Station IDs & Sign-offs|Ozarks \(Springfield Area\)|Missouri)(?:\/|$)/i.test(p)) return 'tv';
  return 'other';
}

/* ── the questions ───────────────────────────────────────────────────────── */
const KIND_CRITERIA = {
  'One product advert': 'ONE advertisement for something you can buy: a brand, a product, a service, a shop, a restaurant, a car, a film in cinemas, a record.',
  'Political advert': 'A campaign advert for a candidate, a party or a ballot measure.',
  'Block of several commercials': 'A block, break or compilation holding several DIFFERENT adverts, or a recorded commercial break, often with bumpers or promos between them.',
  Infomercial: 'A long-form infomercial or paid programme: a half-hour sales show.',
  'Public service announcement': 'A public service announcement, or a government or charity message that sells nothing.',
  'Promo for a TV programme or channel': 'A promo, preview, teaser or "coming up next" for a television programme, a channel or its line-up.',
  'Station ID, bumper or sign-off': 'A station or network identification, a bumper between a programme and the adverts, a sign-on or sign-off, a test pattern, an emergency alert test.',
  'Episode or clip of a TV programme': 'The programme itself or part of it: an episode, a scene, an intro or theme, credits, a talk show or game show segment.',
  'News or special report': 'A news broadcast or report, a weather report, or live coverage of an event.',
  'Movie trailer': 'A trailer for a film.',
  'VHS or DVD opening, closing or previews': 'The start or end of a tape or disc: the previews, trailers, warnings and logos before or after the feature.',
  'Music video or performance': 'A music video, a song, a concert or a musical performance.',
  'Home movie': "A family's or person's own recording of their life: a party, wedding, school event, holiday, recital.",
  'Special-interest or instructional tape': 'A tape sold for its subject: how-to, workout, lecture, documentary, travel, training.',
  'Something else': 'Anything else, or a title and description too bare to say.',
};
const KIND_Q = {
  type: 'choice',
  instructions:
    "An item from a television and radio archive is described by `title`, `folder` and `description`. The description is the uploader's own note about the recording; it may be empty, or only repeat the title. Say what the item IS. Judge by what the title and description say it shows; the folder is only where an older script put it, and may be wrong.",
  criteria: KIND_CRITERIA,
};
const CATEGORY_Q = {
  type: 'choice',
  instructions:
    'A television or radio commercial from an archive is described by `title`, `decade` and `description`. The description is the uploader\'s note; when it says what the product is ("spot for the backache pain reliever", "the Milton Bradley board game", "the chili brand"), believe it over the look of the brand name. Ignore any history of the company, where it is headquartered, or links. Say which kind of product or service the commercial is advertising, judging by what the product actually IS, not by what a word in its name sounds like: a bug spray called Gulf Spray is a household insecticide, not petrol. Pick the single best fit.',
  criteria: judges.AD_CATEGORY_CRITERIA,
};
const MO_NOTE =
  ' Company histories pasted into descriptions ("headquartered in St. Louis", "founded in Kansas City", a list of states it sells in) do NOT count; only where THIS recording was made or shown, or who it was made for.';
const RECORDED_Q = {
  type: 'noul',
  instructions:
    'Does the title or description of the item described by `title`, `folder` and `description` say it was recorded off, or broadcast on, television or radio in a Missouri city or TV market, or carry a Missouri station call letters? Kansas City counts: its TV stations are in Missouri, so "recorded in the Greater Kansas City Area" means yes. So do Springfield MO, Joplin, Branson, St. Louis, Columbia, Jefferson City and Cape Girardeau.' + MO_NOTE,
  criteria: { true: 'It says where it was recorded or aired, and that place is in Missouri or is Kansas City.', false: 'Nothing says it was recorded or aired in Missouri.' },
};
const MADEFOR_Q = {
  type: 'noul',
  instructions:
    'Was the item described by `title`, `folder` and `description` made for people in Missouri: an advert for a Missouri or Kansas City business, the campaign of a Missouri politician, Missouri news, weather or sport, a promo by a Missouri station for itself, or a Missouri place, school or event?' + MO_NOTE,
  criteria: { true: 'Made for a Missouri audience or about a Missouri place.', false: 'Made for a national audience or for somewhere else.' },
};
const LOCAL_Q = {
  type: 'noul',
  instructions: 'Is the thing shown LOCAL to one area, rather than national content that stations across the country also aired?',
  criteria: {
    true: "Local: an advert for a local or regional business, local news, weather or sport, a local station's own promo, ID or programme, a local event.",
    false: 'National: a national brand\'s advert, a network or syndicated programme or promo, a national PSA, even if the tape was recorded off a local station.',
  },
};
const AREA_Q = {
  type: 'choice',
  instructions: 'Which part of Missouri is this item from?',
  criteria: {
    'Springfield and the Ozarks': 'Springfield, Branson, Joplin, Lebanon, West Plains, Rolla, the Lake of the Ozarks and southwest or south-central Missouri; stations KYTV KY3, KOLR, KSPR, KDEB, KOZK, KODE, KSNF, KOAM, KTTS, KWTO.',
    'St. Louis': 'St. Louis and its area; stations KSDK, KMOV, KTVI, KPLR, KDNL, KETC, KMOX.',
    'Kansas City': 'Kansas City and its area; stations WDAF, KMBC, KCTV, KSHB, KSMO, KCPT.',
    'Elsewhere in Missouri': 'Columbia, Jefferson City, Cape Girardeau, St. Joseph, Kirksville, Hannibal, or Missouri as a whole.',
  },
};
const AREA_DEST = {
  'Springfield and the Ozarks': 'Video/Ozarks (Springfield Area)',
  'St. Louis': 'Video/Missouri/St. Louis (Local)',
  'Kansas City': 'Video/Missouri/Kansas City (Local)',
  'Elsewhere in Missouri': 'Video/Missouri/Missouri (Local)',
};
const AREA_TAG = { 'Springfield and the Ozarks': 'Ozarks', 'St. Louis': 'St. Louis', 'Kansas City': 'Kansas City', 'Elsewhere in Missouri': 'Missouri' };
const FOREIGN_Q = {
  type: 'noul',
  instructions:
    'Kade collects only what was shown in the United States. Was the item described by `title` and `description` made for and shown to an audience OUTSIDE the United States, such as a British, Canadian, Australian, Mexican or Japanese advert or broadcast? A history of the company pasted into the description, or a brand that is also sold abroad, does not count; only where THIS recording was shown.',
  criteria: { true: 'Made for and shown outside the United States.', false: 'Shown in the United States, or nothing says otherwise.' },
};
const VHS_CRITERIA = {
  'Openings & Previews': 'The start or end of a tape: the previews, trailers, warnings, logos and adverts before or after the feature.',
  'Children & Family': "A tape made for children or families: cartoons, a kids' show, a sing-along, Disney, Barney, Sesame Street, a children's story.",
  'Recorded Off TV': 'Something recorded off television: a broadcast, often with its commercials, a TV special, news coverage.',
  'Home Movies': "A family's or person's own recording of their life: a party, wedding, school event, recital, holiday.",
  'Special Interest': 'A tape sold for its subject: how-to, workout, lecture, seminar, documentary, travel, training, a product or corporate tape.',
  'Feature Films': 'A full-length film released on tape.',
  'Music & Concerts': 'Music videos, a concert, a musical or stage performance.',
  'Other Tapes': 'Anything else, or too little to tell.',
};
const VHS_Q = {
  type: 'choice',
  instructions: 'The item described by `title` and `description` is a videotape from a collection of old VHS tapes. Say what is on it. Pick the single best fit.',
  criteria: VHS_CRITERIA,
};

const MO_RE = /\b(?:Missouri|Springfield,? M[Oo]|Joplin|Branson|Ozarks?|St\.? Louis|Kansas City|Columbia,? M[Oo]|Jefferson City|Cape Girardeau|Sedalia|Rolla|Lebanon,? M[Oo]|West Plains|Poplar Bluff|Nixa|Republic,? M[Oo]|Hannibal|Kirksville|St\.? Joseph|Independence,? M[Oo]|Lake of the Ozarks|Osage Beach|Neosho|Carthage,? M[Oo]|Bolivar,? M[Oo]|Warrensburg|El Dorado Springs|Silver Dollar City|Bass Pro|Show-Me|KSDK|KMOV|KTVI|KPLR|KDNL|KETC|WDAF|KMBC|KCTV|KSHB|KSMO|KCPT|KYTV|KY3|KOLR|KSPR|KDEB|KOZK|KODE|KSNF|KOAM|KFVS|KOMU|KRCG|KMIZ|KQTV|KTVO|KHQA|KTTS|KWTO|KGBX|KXUS|KMOX|KSHE|KCMO|KPRS)\b/;
const NONUS_RE = /\b(?:UK|U\.K\.|British|Britain|England|English advert|Scotland|Scottish|Welsh|Ireland|Irish TV|Canada|Canadian|Australia|Australian|New Zealand|ITV|BBC|Channel 4|Channel 5|Sky One|CBC|CTV|Global TV|YTV|Teletoon|MuchMusic|Nine Network|Seven Network|Network Ten|Mexico|Mexican|Japan|Japanese|Germany|German|France|French|Spain|Spanish|Brazil|Brazilian|Italy|Italian|Netherlands|Dutch|Philippines|Filipino|India|Indian TV|Europe|European)\b/;
/* Her part of the country besides Missouri: Arkansas and the Ozarks edges of Kansas and
 * Oklahoma. Anything naming them is never "local to another area". */
const AR_OZARKS_RE = /\b(?:Arkansas|Razorbacks?|Little Rock|Fayetteville|Springdale|Bentonville|Rogers,? AR|Harrison,? AR|Mountain Home|Calico Rock|Jonesboro|Fort Smith|Hot Springs|Eureka Springs|Batesville|Searcy|Conway,? AR|Pine Bluff|Texarkana|Grove,? OK|Miami,? OK|Tahlequah|Pittsburg,? KS|Coffeyville|KATV|KARK|KTHV|KLRT|KASN|KAIT|KFSM|KHBS|KHOG|KNWA|KFTA|KAFT|KETS|KTVE|KARZ)\b/i;
const ourArea = (text) => MO_RE.test(text) || AR_OZARKS_RE.test(text);
/* Kade, Sep 23 2026: "all the non-local to me material that is local to someone else but was
 * never syndicated ... Like local car commercials from other states." Trial on 600 of her
 * library items ($0.013): all 16 at 0.9 or more were local elsewhere (Louisiana furniture
 * stores, a Colorado Springs waterbed shop, Louisiana governor races, a Scranton Fox ID
 * montage), and so were the 0.8 to 0.9 near misses (an Indianapolis car dealer, state
 * lotteries). Whole breaks and blocks are mixed, mostly national, and never count. */
const ELSEWHERE_Q = {
  type: 'noul',
  instructions:
    "Was the item described by `title`, `folder` and `description` made only for viewers in ONE local area: an advert for a local business such as a car dealer, furniture store, restaurant, lawyer or bank branch; a local election; local news, weather or sport; or a local TV station's own promo, ID or programme? Network and cable channel material, national brands' adverts, syndicated shows, and whole commercial breaks or programme blocks recorded off a station are NOT local. Judge what this recording is; a company history pasted into the description does not count.",
  criteria: { true: 'Made only for one local area.', false: 'Shown nationally, a whole commercial break or block, or it does not say.' },
};
const SPORTS_GAME_RE = /(?:@| at | vs\.? | & ).*\b(?:college football|ncaa|nfl|mlb|nba|nhl|bowl)\b|\b(?:college football|ncaa)\b.*(?:@| at | vs)|rookie game/i;
const LOCAL_TEAM_RE = /missouri|st\.? ?louis|saint louis|kansas city|royals|chiefs|cardinals|blues|springfield|mizzou|ozark/i;

/** The state Jev reads, and which questions an item needs. */
function stateOf(item) {
  return {
    title: String(item.title || '').slice(0, 300),
    folder: String(item.path || '').slice(0, 200),
    decade: decadeOf(item),
    description: clean(item.description) || '(none)',
  };
}

function questionsFor(item) {
  const zone = zoneOf(item);
  if (zone === 'skip' || folderFact(item)) return null;
  const text = String(item.title || '') + ' ' + String(item.description || '');
  const q = {};
  if (item.kind === 'audio') {
    if (zone !== 'intake') return null;
    Object.assign(q, { audioKind: judges.AUDIO_KIND_Q, ozarks: judges.OZARKS_Q, category: CATEGORY_Q });
  } else {
    const family = familyOf(item.path);
    if (zone === 'intake' || !['other', 'otherads', 'break', 'political', 'infomercial'].includes(family)) q.kind = KIND_Q;
    if (zone === 'intake' || ['ad', 'channel', 'oneoffs', 'psa'].includes(family)) q.category = CATEGORY_Q;
    if (family === 'vhs') q.tape = VHS_Q;
    if (zone !== 'local' && MO_RE.test(text)) Object.assign(q, { recorded: RECORDED_Q, madefor: MADEFOR_Q, local: LOCAL_Q, area: AREA_Q, localKind: judges.LOCAL_KIND_Q });
  }
  if (NONUS_RE.test(text)) q.foreign = FOREIGN_Q;
  if (item.kind === 'video' && zone === 'intake' && !ourArea(text + ' ' + String(item.path || ''))) q.elsewhere = ELSEWHERE_Q;
  return Object.keys(q).length ? q : null;
}

/* ── pure decision ───────────────────────────────────────────────────────── */
function choiceOf(a, id) {
  const x = a && a[id];
  return x && typeof x.choice === 'string' && typeof x.confidence === 'number' ? { choice: x.choice, confidence: x.confidence } : { choice: null, confidence: 0 };
}
function noulOf(a, id) {
  const p = a && a[id] && a[id].noul;
  return typeof p === 'number' && p >= 0 && p <= 1 ? p : null;
}
const two = (n) => Number(n).toFixed(2);

/**
 * Where a kind goes. `root` is Video; the decade, network and show come from
 * rules. Returns a path, or null when the kind has no confident home.
 */
function routeByKind(item, kind, category, dec, deps) {
  const root = 'Video';
  const net = networkOf(item.title);
  switch (kind) {
    case 'One product advert':
      return `${root}/Commercials/${category || 'Other Commercials'}/${dec}`;
    case 'Political advert':
      return `${root}/Commercials/Political Ads/${dec}`;
    case 'Block of several commercials':
      return net ? `${root}/Commercials/Commercial Breaks/${net}/${dec}` : `${root}/Commercials/Commercial Breaks/${dec}`;
    case 'Infomercial':
      return `${root}/Commercials/Infomercials & Paid Programming/${dec}`;
    case 'Public service announcement':
      return `${root}/PSAs/${dec}`;
    case 'Promo for a TV programme or channel': {
      if (net) return `${root}/Channels/${net}/${dec}`;
      const show = deps.broadcastShelf ? deps.broadcastShelf(item.title || '', (item.meta || {}).franchise || '') : null;
      return show ? `${root}/${show}/${dec}` : `${root}/Channels/Other Channels/${dec}`;
    }
    case 'Station ID, bumper or sign-off':
      return net ? `${root}/Channels/${net}/${dec}` : `${root}/Station IDs & Sign-offs/${dec}`;
    case 'Episode or clip of a TV programme': {
      const show = deps.broadcastShelf ? deps.broadcastShelf(item.title || '', (item.meta || {}).franchise || '') : null;
      return show ? `${root}/${show}/${dec}` : net ? `${root}/Channels/${net}/${dec}` : `${root}/TV Shows/Assorted (One-Offs)/${dec}`;
    }
    case 'News or special report':
      return net ? `${root}/Channels/${net}/${dec}` : `${root}/TV Shows/Assorted (One-Offs)/${dec}`;
    case 'Movie trailer':
      return `${root}/Movies & Studios/Trailers & Previews`;
    case 'VHS or DVD opening, closing or previews':
      return `${root}/Home Video (VHS)/Openings & Previews/${dec}`;
    case 'Music video or performance':
      return `${root}/Music/Assorted Music`;
    case 'Home movie':
      return `${root}/Home Video (VHS)/Home Movies/${dec}`;
    case 'Special-interest or instructional tape':
      return `${root}/Home Video (VHS)/Special Interest/${dec}`;
    default:
      return null;
  }
}

/**
 * One item and Jev's answers → { to, why, confidence, flags, tags }.
 * `to` is null when it stays put. Pure: a test holds every rule still.
 */
function decide(item, answers, deps = {}, k = knobs()) {
  const a = answers || {};
  const out = { to: null, why: '', confidence: 0, flags: [], tags: [] };
  const from = String(item.path || '');
  const zone = zoneOf(item);
  const dec = decadeOf(item);
  const fact = folderFact(item);
  if (fact) return { ...out, to: fact !== from ? fact : null, why: 'folder says so', confidence: 1 };

  const foreign = noulOf(a, 'foreign');
  if (foreign !== null && foreign >= k.foreign) out.flags.push(`Jev review: made outside the US (${two(foreign)}).`);
  const elsewhere = noulOf(a, 'elsewhere');
  if (elsewhere !== null && elsewhere >= k.elsewhereFlag && zone !== 'local' && !ourArea(`${item.title || ''} ${item.description || ''} ${from}`)) {
    out.flags.push(`Space review: local to another area (${two(elsewhere)}).`);
  }
  if (item.kind === 'video' && zone !== 'local' && SPORTS_GAME_RE.test(item.title || '') && !LOCAL_TEAM_RE.test(item.title || '') && Number(item.bytes || 0) > 3e8) {
    out.flags.push('Space review: full sports game broadcast.');
  }

  if (item.kind === 'audio') {
    if (zone !== 'intake') return out;
    const to = judges.audioDestination(item, { kind: a.audioKind, ozarks: a.ozarks, category: a.category });
    if (to && to !== from) Object.assign(out, { to, why: 'audio: ' + (a.audioKind && a.audioKind.choice), confidence: (a.audioKind && a.audioKind.confidence) || 0 });
    return out;
  }

  const kind = choiceOf(a, 'kind');
  const cat = choiceOf(a, 'category');
  const category = Object.prototype.hasOwnProperty.call(judges.AD_CATEGORY_CRITERIA, cat.choice) && cat.confidence >= k.category ? cat.choice : null;
  if (kind.choice === 'Home movie' && kind.confidence >= 0.8 && zone !== 'local') out.flags.push('Space review: family or local home recording.');

  /* Missouri first: a local item belongs on her local shelves whatever it is. */
  const recorded = noulOf(a, 'recorded');
  const madefor = noulOf(a, 'madefor');
  const local = noulOf(a, 'local');
  if (zone !== 'local' && recorded !== null && madefor !== null && local !== null && Math.max(recorded, madefor) >= k.missouri) {
    const area0 = choiceOf(a, 'area');
    const area = area0.confidence >= 0.7 && AREA_DEST[area0.choice] ? area0.choice : 'Elsewhere in Missouri';
    if (local >= 0.75 && madefor >= 0.6) {
      out.tags.push('Missouri');
      if (AREA_TAG[area] !== 'Missouri') out.tags.push(AREA_TAG[area]);
      let to;
      if (kind.choice === 'Political advert' && kind.confidence >= 0.8) to = `Video/Missouri/Political Ads/${dec}`;
      else if (area === 'Springfield and the Ozarks') {
        const lk = choiceOf(a, 'localKind');
        to = Object.prototype.hasOwnProperty.call(judges.LOCAL_KIND_CRITERIA, lk.choice) && lk.confidence >= 0.7
          ? `${judges.LOCAL_ROOT}/${lk.choice}/${dec}` : `${judges.LOCAL_ROOT}/${dec}`;
      } else to = `${AREA_DEST[area]}/${dec}`;
      out.flags = out.flags.filter((f) => !f.startsWith('Space review'));
      return Object.assign(out, { to: to !== from ? to : null, why: `Missouri local (${area})`, confidence: Math.min(Math.max(recorded, madefor), local) });
    }
    if (local <= 0.35 && recorded >= 0.75) out.tags.push(area === 'Springfield and the Ozarks' ? 'Aired in the Ozarks' : `Aired in ${AREA_TAG[area]}`);
    else out.flags.push(`Jev review: Missouri (${area.replace(/^Springfield and the /, '')}), unsure if local (${two(local)}).`);
  }
  if (zone === 'local') return out;

  if (zone === 'intake') {
    if (kind.confidence < k.kind || !kind.choice) return out;
    const to = routeByKind(item, kind.choice, category, dec, deps);
    if (to && to !== from) Object.assign(out, { to, why: 'intake: ' + kind.choice + (category && kind.choice === 'One product advert' ? ' / ' + category : ''), confidence: kind.confidence });
    return out;
  }

  /* Already filed: only a clear contradiction moves. */
  const family = familyOf(from);
  const strong = kind.confidence >= k.auditKind;
  const strongCat = Object.prototype.hasOwnProperty.call(judges.AD_CATEGORY_CRITERIA, cat.choice) && cat.confidence >= k.auditCategory ? cat.choice : null;
  const net = networkOf(item.title);
  let to = null;
  let why = '';
  const byKind = (kinds) => (strong && kinds.includes(kind.choice) ? routeByKind(item, kind.choice, category, dec, deps) : null);
  if (family === 'ad') {
    to = byKind(['Block of several commercials', 'Public service announcement', 'Political advert', 'Infomercial']);
    if (!to && strong && kind.choice === 'Promo for a TV programme or channel' && net) to = `Video/Channels/${net}/${dec}`;
    const current = (/\/Commercials\/([^/]+)/.exec(from) || [])[1];
    /* A store's advert often shows what the store sells; the store is still the right shelf (trial: Kmart with
     * Martha Stewart went to Clothing). And a re-shelving needs near-certainty, because the old shelf came from
     * brand lists that are usually right. */
    if (!to && kind.choice === 'One product advert' && kind.confidence >= 0.8 && strongCat && current && strongCat !== current
      && current !== 'Stores & Retail' && cat.confidence >= Math.max(k.auditCategory, 0.95)) {
      to = from.replace('/Commercials/' + current, '/Commercials/' + strongCat);
      why = `product shelf: ${current} → ${strongCat}`;
    }
  } else if (family === 'channel') {
    if (strong && kind.choice === 'One product advert' && category && cat.confidence >= 0.8) to = `Video/Commercials/${category}/${dec}`;
    else to = byKind(['Public service announcement', 'Political advert', 'Infomercial']);
  } else if (family === 'oneoffs') {
    if (kind.choice === 'One product advert' && kind.confidence >= 0.85 && category && cat.confidence >= 0.75) to = `Video/Commercials/${category}/${dec}`;
    else if (kind.choice === 'Political advert' && kind.confidence >= 0.85) to = `Video/Commercials/Political Ads/${dec}`;
    else to = byKind(['Public service announcement', 'Block of several commercials']) || (strong && kind.choice === 'Promo for a TV programme or channel' && net ? `Video/Channels/${net}/${dec}` : null);
  } else if (family === 'psa') {
    if (kind.choice === 'One product advert' && kind.confidence >= 0.92 && category && cat.confidence >= 0.8) to = `Video/Commercials/${category}/${dec}`;
    else to = byKind(['Political advert']);
  } else if (family === 'vhs') {
    const t = choiceOf(a, 'tape');
    if (t.choice && t.choice !== 'Other Tapes' && VHS_CRITERIA[t.choice] && t.confidence >= (t.choice === 'Home Movies' ? 0.85 : k.tape)) {
      to = `Video/Home Video (VHS)/${t.choice}/${dec}`;
      why = 'tape: ' + t.choice;
      if (t.choice === 'Home Movies' && t.confidence >= 0.8 && !out.flags.some((f) => f.includes('home recording'))) out.flags.push('Space review: family or local home recording.');
    }
  }
  if (to && to !== from) Object.assign(out, { to, why: why || `${family}: ${kind.choice}`, confidence: why.startsWith('tape') ? choiceOf(a, 'tape').confidence : kind.confidence });
  return out;
}

/* ── WHAT SHE PROBABLY DOES NOT WANT (Part 272, Sep 23 2026) ─────────────
 * Kade, about batch downloads straight to the cloud: "make it skip videos I
 * probably mostlikely wouldn't want". Her keep rules: what ran on US TV, tape
 * openings, kids' and store-bought tapes, anything from Missouri. What she
 * does not want: things made outside the US, other people's home movies, full
 * sports games. TubeVault asks before it downloads, knowing only the title
 * and the channel. A skip is never a deletion: the queue keeps the item and
 * Retry downloads it anyway.
 *
 * Trial on 650 of her queued titles (live Jev, $0.017): foreign at 0.9 or more
 * caught Nicktoons UK, Cartoon Network Australia and Canada, BBC, CITV and
 * RTL4, and nothing American except AFN Germany, which is American TV for
 * troops abroad and is exempt. The home-movie question found none at 0.85 in
 * a queue of TV archives; its near misses (a Rose Parade band, a high-school
 * game) stayed below. The sports rule skips 19 full college and NBA games in
 * 57,413 and keeps every promo, commercial and highlight reel.
 */
const HOME_Q = {
  type: 'noul',
  instructions:
    "Is the video described by `title` (posted by `channel`) somebody's own home recording of their family or a local event: a birthday, wedding, Christmas morning, family trip, school concert or play, recital, graduation, church service, or a kids' game? A tape of a TV broadcast, a store-bought or rented tape, a tape's opening or previews, an advert, a TV show or a film is not a home recording, even when the title says VHS.",
  criteria: { true: "Somebody's own home recording of family or a local event.", false: 'Something shown on TV, sold on tape, or made by a company; or it does not say.' },
};
const WANT_EPHEMERA_RE = /commercial|advert|\bads?\b|promo|intro|opening|\bopen\b|bumper|\bIDs?\b|break|halftime|theme|highlights?|preview|trailer/i;
const US_ABROAD_RE = /\bAFN\b|American Forces|\bAFRTS\b/i;

function wantState(item) {
  const channel = String(item.channel || '').slice(0, 120);
  return {
    title: String(item.title || '').slice(0, 300),
    channel: channel || '(unknown)',
    folder: '(not filed yet)',
    description: channel ? `Posted by the YouTube channel "${channel}". No description has been read yet.` : 'No description has been read yet.',
  };
}

function fullSportsGame(item) {
  const t = String(item.title || '');
  return SPORTS_GAME_RE.test(t) && !LOCAL_TEAM_RE.test(t) && !WANT_EPHEMERA_RE.test(t);
}

/** The questions a queued download needs; null when a rule already decides. */
function wantQuestions(item) {
  const text = `${item.title || ''} ${item.channel || ''}`;
  if (ourArea(text) || fullSportsGame(item)) return null;
  return US_ABROAD_RE.test(text) ? { home: HOME_Q, elsewhere: ELSEWHERE_Q } : { foreign: FOREIGN_Q, home: HOME_Q, elsewhere: ELSEWHERE_Q };
}

/** { skip: reason or null, confidence }. Missouri, Arkansas and the Ozarks are always wanted. */
function wantVerdict(item, answers = {}, k = knobs()) {
  const text = `${item.title || ''} ${item.channel || ''}`;
  if (ourArea(text)) return { skip: null, why: 'her part of the country' };
  if (fullSportsGame(item)) return { skip: 'a full sports game', confidence: 1 };
  const foreign = US_ABROAD_RE.test(text) ? null : noulOf(answers, 'foreign');
  if (foreign !== null && foreign >= k.foreign) return { skip: `made outside the US (${two(foreign)})`, confidence: foreign };
  const elsewhere = noulOf(answers, 'elsewhere');
  if (elsewhere !== null && elsewhere >= k.elsewhere) return { skip: `local to another area (${two(elsewhere)})`, confidence: elsewhere };
  const home = noulOf(answers, 'home');
  if (home !== null && home >= k.home) return { skip: `somebody's home movie (${two(home)})`, confidence: home };
  return { skip: null };
}

/** Judge a batch of queued downloads. Never throws; a failed item comes back wanted. */
async function judgeWanted(items, { ask = jev.ask, timeoutMs = 8000, concurrency = 6 } = {}) {
  const verdicts = [];
  let inputTokens = 0;
  const k = knobs();
  const queue = [...items];
  async function worker() {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const questions = wantQuestions(item);
      try {
        let answers = {};
        if (questions) {
          const r = await ask(wantState(item), questions, timeoutMs);
          answers = r.answers || {};
          inputTokens += Number(r.usage && r.usage.input_tokens) || 0;
        }
        verdicts.push({ key: item.key, ...wantVerdict(item, answers, k) });
      } catch (e) {
        verdicts.push({ key: item.key, skip: null, error: String((e && e.message) || e).slice(0, 120) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return { verdicts, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

/**
 * Ask Jev about a batch and decide each. Never throws: an item Jev fails on
 * comes back with `error` and is left exactly where it is.
 * Returns { decisions: [{item, to, why, confidence, flags, tags, error?}], costUSD }.
 */
async function fileMedia(items, { ask = jev.ask, deps = {}, timeoutMs = 8000, concurrency = 6 } = {}) {
  const decisions = [];
  let inputTokens = 0;
  const k = knobs();
  const queue = [...items];
  async function worker() {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const questions = questionsFor(item);
      try {
        let answers = {};
        if (questions) {
          const r = await ask(stateOf(item), questions, timeoutMs);
          answers = r.answers || {};
          inputTokens += Number(r.usage && r.usage.input_tokens) || 0;
        }
        decisions.push({ item, answers, ...decide(item, answers, deps, k) });
      } catch (e) {
        decisions.push({ item, to: null, flags: [], tags: [], error: String((e && e.message) || e).slice(0, 120) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return { decisions, costUSD: (inputTokens * num('KADE_JEV_IN_USD_PER_M', 0.042)) / 1e6 };
}

module.exports = {
  VERSION, knobs, decadeOf, clean, networkOf, zoneOf, folderFact, familyOf, categoryOf, stateOf, questionsFor,
  routeByKind, decide, fileMedia, KIND_Q, KIND_CRITERIA, CATEGORY_Q, VHS_Q, VHS_CRITERIA, FOREIGN_Q, MO_RE, NONUS_RE,
  HOME_Q, ELSEWHERE_Q, AR_OZARKS_RE, ourArea, wantState, wantQuestions, wantVerdict, judgeWanted, fullSportsGame,
};
