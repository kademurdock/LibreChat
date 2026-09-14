import { filingData } from './filing-data';

export const normalizeFilingTitle = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const has = (name: string, phrase: string): boolean => (' ' + name + ' ').includes(' ' + normalizeFilingTitle(phrase) + ' ');
const ad = (s: string): boolean => /\b(?:ads?|advertisements?|adverts?|commercials?|radio spot)\b/.test(s);
const families: [string, string][] = [['my scene', 'My Scene'], ['myscene', 'My Scene'], ['bratz', 'Bratz'], ['kinderbot', 'Learning Toys'], ['kasey the kinderbot', 'Learning Toys'], ['kacey the kinderbot', 'Learning Toys']];
const channels: [string, string][] = [['disney channel', 'Disney Channel'], ['nickelodeon', 'Nickelodeon'], ['nick jr', 'Nickelodeon'], ['cartoon network', 'Cartoon Network'], ['pbs', 'PBS'], ['cfmt', 'CFMT']];

export function classifyMediaTitle(title: string): string | null {
  const s = normalizeFilingTitle(title);
  const isAd = ad(s);
  const radioAd = /\bradio (?:ads?|advertisements?|adverts?|commercials?|spots?)\b/.test(s);
  const productPath = (category: string): string => (radioAd ? 'Radio/Radio Commercials/' : 'Commercials/') + category;
  if (has(s, 'special k waffles')) return productPath('Food & Grocery');
  if (has(s, 'earth 2 1994 tv series')) return 'TV Shows/Earth 2';
  if (has(s, 'cfmt station id and promos')) return 'Channels/CFMT';
  if (/\b(?:commercial breaks?|commercial compilation|commercial collection|ad breaks?|commercials aired during|commercials from)\b/.test(s)) return radioAd ? 'Radio/Radio Commercials/Commercial Breaks' : 'Commercials/Commercial Breaks';

  if (isAd && /\b(?:for (?:[a-z]+ ){0,3}(?:governor|governer|congress|senate|senator|president|mayor|secretary of state|attorney general)|political ad|campaign ad|vote for|re elect|reelect)\b/.test(s)) {
    if (/\b(?:mo|missouri)\b/.test(s)) return 'Missouri/Political Ads';
    return productPath('Political Ads');
  }
  if (/\b(?:bumpers?|station ids?|station ident|sign off|sign on|program ident)\b/.test(s)) {
    const suffix = /\bbumper/.test(s) ? 'Bumpers' : 'Station IDs & Sign-offs';
    const channel = channels.find(([needle]) => has(s, needle));
    if (channel) return 'Channels/' + channel[1] + '/' + suffix;
    const call = title.match(/\b[WK][A-Z]{2,3}\b/);
    if (call) return 'Channels/' + call[0] + '/' + suffix;
    for (const [needle, show] of [['alvin and the chipmunks', 'Alvin and the Chipmunks'], ['new woody woodpecker show', 'The New Woody Woodpecker Show'], ['finders keepers', 'Finders Keepers'], ['the fitzpatricks', 'The Fitzpatricks'], ['all star junior pyramid', 'Game Shows/All-Star Junior Pyramid']]) {
      if (has(s, needle)) return 'TV Shows/' + show + '/' + suffix;
    }
    return 'Broadcast Presentation/' + suffix;
  }
  if (/\b(?:feature film|movie trailer|film trailer|theatrical trailer|movie preview|film preview|commercial movie|commercial film)\b/.test(s)) return 'Movies & Studios/Trailers & Previews';
  if (/\b(?:dvd|vhs|blu ray) (?:19\d\d |20\d\d )?(?:commercial|ad|release|preview)\b/.test(s)) return productPath('Movies & Home Entertainment');

  // Geography needs a state-qualified place or an explicit state marker.
  if (isAd && /\b(?:missouri|springfield mo|springfield missouri|columbia mo|jefferson city mo|st louis|saint louis|branson|ozarks)\b/.test(s)) return 'Missouri/Local Commercials';
  if (isAd && /\b(?:mo)\b/.test(s) && /\b(?:local|dealer|dealership|store|restaurant|business)\b/.test(s)) return 'Missouri/Local Commercials';
  if (/\b(?:radio aircheck|aircheck|radio broadcast)\b/.test(s) && !radioAd) return 'Radio/Airchecks & Broadcasts';
  if (!isAd && /\b(?:cassette|microcassette|reel to reel|audio tape|8 track)\b/.test(s)) {
    if (/\b(?:audiobook|audio book)\b/.test(s)) return 'Audiobooks';
    if (/\b(?:home recorded|home recording|family recording|personal recording|answering machine|dictation|microcassette|found cassette|found tape)\b/.test(s)) return 'Audio Tapes/Home & Found Recordings';
    if (/\b(?:lecture|sermon|interview|spoken word|speech)\b/.test(s)) return 'Audio Tapes/Spoken Word';
    if (/\b(?:music|album|mixtape|mix tape|concert)\b/.test(s)) return 'Audio Tapes/Music';
    return 'Audio Tapes/Unidentified Recordings';
  }

  if (/\b(?:compilation|collection)\b/.test(s)) return null;
  const toy = families.find(([needle]) => has(s, needle));
  if (toy) return productPath('Toys & Video Games/' + toy[1]);
  if (/\b(?:playset|dollhouse|styling heads?|action figures?|baby doll)\b/.test(s)) return productPath('Toys & Video Games');
  if (has(s, 'hallmark channel')) return 'Channels/Hallmark Channel/Promos';

  const start = s.replace(/^(?:(?:19|20)\d\d\s+|retro\s+|vintage\s+|classic\s+)/, '');
  const ambiguous = new Set(['all', 'joy', 'total', 'gap', 'sonic', 'miller', 'dove', 'shout', 'pledge', 'bold']);
  const prefixMatches = Object.entries(filingData.prefixes).flatMap(([category, names]) => names.filter((name) => (start === name || start.startsWith(name + ' ')) && (!ambiguous.has(name) || /^(?:ad\b|commercial\b|tv\b|television\b|19\d\d\b|20\d\d\b|detergent\b|soap\b|shampoo\b|polish\b|cleaner\b|laundry\b|ultra\b|plus\b)/.test(start.slice(name.length).trim()))).map((name) => ({ category, length: name.length })));
  prefixMatches.sort((a, b) => b.length - a.length);
  if (prefixMatches.length && !/\b(?:compilation|commercial collection)\b/.test(s)) return productPath(prefixMatches[0].category);

  const strong = Object.entries(filingData.strong).filter(([, names]) => names.some((name) => has(s, name)));
  if (strong.length === 1) return productPath(strong[0][0]);
  if (strong.length > 1) return null;
  const generic = Object.entries(filingData.generic).filter(([, names]) => names.some((name) => has(s, name)));
  if (generic.length === 1) return productPath(generic[0][0]);
  return radioAd ? 'Radio/Radio Commercials/Unidentified Products' : null;
}

/** Refine catch-alls and bare import roots. Specific custom folders stay put. */
export function commercialPath(path: string, title: string): string | null {
  const clean = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const catchall = clean.match(/^(.*?)(?:Commercials\/Other Commercials)(\/.*)?$/i)
    || clean.match(/^(Audio\/)(?:Radio\/Radio Commercials|Audio Tapes)(\/(?:\d{4}s|Unknown|Unknown Decade))?$/i);
  const generic = clean.match(/^(Videos?|Audio)(?:\/(?:Other|Unsorted|Unsorted \(Review Me\)))?$/i);
  if (!catchall && !generic) return null;
  const s = normalizeFilingTitle(title);
  if (!catchall && !ad(s) && !/\b(?:bumpers?|station ids?|aircheck|cassette|microcassette|audio tape|reel to reel|movie trailer|film trailer)\b/.test(s)) return null;
  const to = classifyMediaTitle(title);
  if (!to) return null;
  const prefix = catchall ? catchall[1] : generic![1] + '/';
  return prefix + to + (catchall?.[2] || '');
}

export function filingCategory(path: string, kind = 'video'): string {
  if (/\/(?:Political Ads|Local Commercials|Commercials|Radio Commercials)(?:\/|$)/i.test(path)) return 'commercials';
  if (/\/(?:Audio Tapes|Found Cassettes)(?:\/|$)/i.test(path)) return kind === 'audio' ? 'cassette' : 'vhs';
  if (/\/Audiobooks(?:\/|$)/i.test(path)) return kind === 'audio' ? 'audiobook' : 'other';
  if (/\/(?:Movies & Studios)(?:\/|$)/i.test(path)) return 'movie';
  if (/\/(?:Radio|Podcasts)(?:\/|$)/i.test(path)) return 'radio';
  if (/\/(?:Channels|TV Shows|Broadcast Presentation)(?:\/|$)/i.test(path)) return 'tv';
  return 'other';
}

/** Only media in machine catch-alls are eligible; ownership and source stay untouched. */
export function refineMediaFiling(item: { kind?: string; path?: string; title?: string }): { path: string; category: string } | null {
  if (item.kind !== 'audio' && item.kind !== 'video') return null;
  const path = commercialPath(item.path || '', item.title || '');
  return path && path !== item.path ? { path, category: filingCategory(path, item.kind) } : null;
}
