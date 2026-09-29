import type { FamilyDate } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY WORDS (docs/FAMILY_HISTORY.md, "Words")
 *
 * Every visible and spoken sentence the family history sends is written here,
 * so the iPhone app and the web page only draw what the server says, and new
 * wording needs no app build. Relationship words are always said from the
 * viewer's place ("your grandmother"); a guest, or a family member whose own
 * view has not been built, reads the owner's words ("Ada's grandmother").
 * Spoken strings never carry dashes, middle dots, arrows or shouted words
 * (familySpoken enforces it; a test runs it over every route).
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilySide = 'self' | 'father' | 'mother' | 'both' | 'marriage' | 'descendant';
export type FamilyProofLevel = 'records' | 'dna' | 'guess';
export type FamilyImageCategory = 'portrait' | 'photo' | 'record' | 'grave' | 'document' | 'story';

export interface FamilyVoice {
  /** "your", or "Ada's" when the words are the owner's (guests, and viewers with no view file). */
  poss: string;
  /** "you", or the owner's first name. */
  self: string;
  /** "You", or the owner's first name, to start a sentence. */
  selfCapital: string;
  ownerFirst: string;
  /** True when the relationships are the owner's, not the viewer's own. */
  borrowed: boolean;
  /** "her", "his" or "their": the owner's, for "her DNA test". */
  ownerPoss: string;
}

export interface FamilyPronouns {
  subject: string;
  object: string;
  poss: string;
}

export interface FamilyProof {
  level: FamilyProofLevel;
  text: string;
  spoken: string;
}

export interface FamilyHistoryEvent {
  key: string;
  title: string;
  from: number;
  to: number;
  /** "the Civil War", for "lived through the Civil War"; null when the phrase does not fit. */
  lived: string | null;
  /** The context line for a decade, from how many ancestors it counts and whose they are. */
  line: (count: number, poss: string) => string;
}

const were = (count: number): string => (count === 1 ? 'was' : 'were');
const grown = (count: number): string => (count === 1 ? 'was an adult' : 'were adults');

/** About fifteen moments of national history, for the timeline and "lived through". A public
 * constant: dates are the commonly taught ones (United States involvement for the World Wars). */
export const FAMILY_HISTORY_EVENTS: readonly FamilyHistoryEvent[] = [
  {
    key: 'revolution',
    title: 'The Revolutionary War',
    from: 1775,
    to: 1783,
    lived: 'the Revolutionary War',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the Revolutionary War.`,
  },
  {
    key: 'war1812',
    title: 'The War of 1812',
    from: 1812,
    to: 1815,
    lived: 'the War of 1812',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the War of 1812.`,
  },
  {
    key: 'removal',
    title: 'Indian removal',
    from: 1830,
    to: 1850,
    lived: null,
    line: (n, poss) =>
      `${n} of ${poss} ancestors ${grown(n)} in the years of Indian removal, when tribes were forced west.`,
  },
  {
    key: 'goldrush',
    title: 'The Gold Rush',
    from: 1848,
    to: 1855,
    lived: 'the Gold Rush',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the Gold Rush.`,
  },
  {
    key: 'census1850',
    title: 'The 1850 census',
    from: 1850,
    to: 1850,
    lived: null,
    line: (n, poss) =>
      `${n} of ${poss} ancestors ${were(n)} alive for the 1850 census, the first to name everyone in a household.`,
  },
  {
    key: 'civilwar',
    title: 'The Civil War',
    from: 1861,
    to: 1865,
    lived: 'the Civil War',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the Civil War.`,
  },
  {
    key: 'homestead',
    title: 'The Homestead Act',
    from: 1862,
    to: 1862,
    lived: null,
    line: (n, poss) =>
      `${n} of ${poss} ancestors ${grown(n)} when the Homestead Act offered free land in 1862.`,
  },
  {
    key: 'census1890',
    title: 'The lost 1890 census',
    from: 1890,
    to: 1890,
    lived: null,
    line: (n, poss) =>
      `${n} of ${poss} ancestors ${were(n)} alive for the 1890 census, most of which was later lost in a fire.`,
  },
  {
    key: 'ww1',
    title: 'World War I',
    from: 1917,
    to: 1918,
    lived: 'World War I',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during World War I.`,
  },
  {
    key: 'flu',
    title: 'The 1918 flu',
    from: 1918,
    to: 1919,
    lived: 'the 1918 flu',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the 1918 flu.`,
  },
  {
    key: 'depression',
    title: 'The Great Depression',
    from: 1929,
    to: 1939,
    lived: 'the Great Depression',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the Great Depression.`,
  },
  {
    key: 'dustbowl',
    title: 'The Dust Bowl',
    from: 1930,
    to: 1936,
    lived: 'the Dust Bowl',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during the Dust Bowl years.`,
  },
  {
    key: 'ww2',
    title: 'World War II',
    from: 1941,
    to: 1945,
    lived: 'World War II',
    line: (n, poss) => `${n} of ${poss} ancestors ${grown(n)} during World War II.`,
  },
  {
    key: 'census1950',
    title: 'The 1950 census',
    from: 1950,
    to: 1950,
    lived: null,
    line: (n, poss) => `${n} of ${poss} ancestors ${were(n)} alive for the 1950 census.`,
  },
];

export const FAMILY_RESTORED_LABEL: string = 'Restored with AI: colours and repairs may be guessed';
export const FAMILY_DESCRIBED_NOTE: string = 'Described automatically';
export const FAMILY_MYSTERIES_TITLE: string = 'Family mysteries';
export const FAMILY_MYSTERIES_HEADS_UP: string =
  'This part is about who some of your ancestors really were. It may be news to some of the family.';
export const FAMILY_STORY_RESEARCH_BANNER: string =
  'This story rests on research findings. They are not proven by records.';
export const FAMILY_PAPER_NOTE: string =
  'These are averages. Further back the real share varies a lot, and some ancestors pass down no DNA at all.';
export const FAMILY_BIRTHPLACES_NOTE: string =
  'From birthplaces in records. This is not a DNA ethnicity estimate.';
export const FAMILY_DNA_FOOTNOTE: string =
  'Full siblings share about half their DNA, but not the same half. A test would show your own pieces. It would not change who your ancestors are.';

const SHOUTED_OK: ReadonlySet<string> = new Set([
  'USA',
  'US',
  'UK',
  'DNA',
  'WWI',
  'WWII',
  'OK',
  'TV',
  'II',
  'III',
  'IV',
  'VI',
  'VII',
  'VIII',
  'IX',
  'XI',
  'XII',
  'JR',
  'SR',
  'CM',
]);

/**
 * A sentence made safe to speak: dashes between numbers become "to", other dashes and middle
 * dots become commas, arrows go, "%" is said, and a shouted word from the records ("EXAMPLE")
 * is said as a name. Known abbreviations (USA, DNA) stay.
 */
export function familySpoken(text: string): string {
  return String(text || '')
    .replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s*·\s*/g, ', ')
    .replace(/[▲▶◀►▼→←]/g, ' ')
    .replace(/\s*->\s*/g, ', then ')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\b[A-Z][A-Z'’]{2,}\b/g, (word) =>
      SHOUTED_OK.has(word) ? word : word.charAt(0) + word.slice(1).toLowerCase(),
    )
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Words the spoken-text test refuses: dashes, dots, arrows and shouted words. */
export function familySpokenProblems(text: string): string[] {
  const out: string[] = [];
  if (/[–—·▲▶◀►▼]/.test(text)) out.push('symbol');
  for (const word of text.match(/\b[A-Z]{3,}\b/g) || []) if (!SHOUTED_OK.has(word)) out.push(word);
  return out;
}

export function familyCapital(text: string): string {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function familyOrdinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'}`;
}

/** "Parents", "Grandparents", "Great-grandparents", "2nd great-grandparents". */
export function familyGenerationName(gen: number): string {
  if (gen === 1) return 'Parents';
  if (gen === 2) return 'Grandparents';
  if (gen === 3) return 'Great-grandparents';
  return `${familyOrdinal(gen - 2)} great-grandparents`;
}

/** "Children", "Grandchildren", "Great-grandchildren", "2nd great-grandchildren". */
export function familyDescendantName(level: number): string {
  if (level === 1) return 'Children';
  if (level === 2) return 'Grandchildren';
  if (level === 3) return 'Great-grandchildren';
  return `${familyOrdinal(level - 2)} great-grandchildren`;
}

export function familyPronouns(sex: string | null | undefined): FamilyPronouns {
  if (sex === 'F') return { subject: 'she', object: 'her', poss: 'her' };
  if (sex === 'M') return { subject: 'he', object: 'him', poss: 'his' };
  return { subject: 'they', object: 'them', poss: 'their' };
}

export function familyVoice(
  ownerFirst: string,
  ownerSex: string | null | undefined,
  borrowed: boolean,
): FamilyVoice {
  return {
    poss: borrowed ? `${ownerFirst}’s` : 'your',
    self: borrowed ? ownerFirst : 'you',
    selfCapital: borrowed ? ownerFirst : 'You',
    ownerFirst,
    borrowed,
    ownerPoss: familyPronouns(ownerSex).poss,
  };
}

/** A view file's term without the lifespan it sometimes carries: "wife of your uncle, Ned Example". */
export function familyCleanTerm(term: string | null | undefined): string {
  return String(term || '')
    .replace(/\s*\((?:[^()]*\d{4}[^()]*|living|Living)\)/g, '')
    .replace(/[\s,]+$/, '')
    .trim();
}

/**
 * "your grandmother" (or "Ada's grandmother"), "you" for the viewer, null for no term. A term that
 * already says "your" ("wife of your uncle") keeps its words, with "your" made the owner's when
 * the words are borrowed.
 */
export function familyTermText(
  term: string | null | undefined,
  group: string | null | undefined,
  voice: FamilyVoice,
): string | null {
  const clean = familyCleanTerm(term);
  if (group === 'self' || /^you$/i.test(clean)) return voice.self;
  if (!clean) return null;
  if (/\byour\b/i.test(clean))
    return voice.borrowed ? clean.replace(/\byour\b/gi, voice.poss) : clean;
  return `${voice.poss} ${clean}`;
}

/** "Dad's side" (or "Ada's dad's side"), "Both sides", "By marriage"; null when there is none to say. */
export function familySideText(side: FamilySide | null, voice: FamilyVoice): string | null {
  const whose = voice.borrowed ? `${voice.poss} ` : '';
  if (side === 'father') return voice.borrowed ? `${whose}dad’s side` : 'Dad’s side';
  if (side === 'mother') return voice.borrowed ? `${whose}mom’s side` : 'Mom’s side';
  if (side === 'both') return 'Both sides';
  if (side === 'marriage') return 'By marriage';
  return null;
}

/** The one proof scale: "Proven by records", "Strong DNA evidence (about 90-95% sure)", "Best guess". */
export function familyProof(level: FamilyProofLevel, band?: string | null): FamilyProof {
  /* The research's own words for how sure, shown only when they carry a figure ("about 90 to 95%
   * sure"); a bare "strong" says nothing the scale does not. */
  const text = String(band || '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanBand = /\d/.test(text) ? text : '';
  if (level === 'records') return { level, text: 'Proven by records', spoken: 'Proven by records' };
  if (level === 'dna') {
    return {
      level,
      text: cleanBand ? `Strong DNA evidence (${cleanBand})` : 'Strong DNA evidence',
      spoken: familySpoken(
        `Research finding, strong DNA evidence${cleanBand ? `, ${cleanBand}` : ''}, not proven by records`,
      ),
    };
  }
  return {
    level,
    text: 'Best guess',
    spoken: 'Research finding, a best guess, not proven by records',
  };
}

/** A year with its "about": "about 1850", "1850", or null. */
export function familyYearText(date: FamilyDate): string | null {
  if (date.year == null) return null;
  return date.approx ? `about ${date.year}` : String(date.year);
}

/** "1850–1921" and "1850 to 1921"; "born 1990"; "died 1921"; nulls when no year is known. */
export function familyYearsText(
  birth: FamilyDate,
  death: FamilyDate,
  living: boolean,
): { years: string | null; spoken: string | null } {
  const b = familyYearText(birth);
  const d = living ? null : familyYearText(death);
  if (b && d) return { years: `${b}–${d}`, spoken: `${b} to ${d}` };
  if (b) return { years: `born ${b}`, spoken: `born ${b}` };
  if (d) return { years: `died ${d}`, spoken: `died ${d}` };
  return { years: null, spoken: null };
}

export interface FamilySpokenPersonInput {
  name: string;
  term: string | null;
  yearsSpoken: string | null;
  sideText: string | null;
  proof: FamilyProof | null;
}

/** "Your 2nd great-grandmother, Ada Example, 1850 to 1921, Mom's side." plus the research words. */
export function familySpokenPerson(input: FamilySpokenPersonInput): string {
  const parts: string[] = [];
  if (input.term) parts.push(familyCapital(input.term));
  parts.push(input.name);
  if (input.yearsSpoken) parts.push(input.yearsSpoken);
  if (input.sideText) parts.push(input.sideText);
  let text = `${parts.join(', ')}.`;
  if (input.proof && input.proof.level !== 'records') text += ` ${input.proof.spoken}.`;
  return familySpoken(text);
}

export type FamilyStep = { up: boolean; sex: string | null | undefined };

const stepWord = (step: FamilyStep): string => {
  if (step.up) return step.sex === 'F' ? 'mom' : step.sex === 'M' ? 'dad' : 'parent';
  return step.sex === 'F' ? 'daughter' : step.sex === 'M' ? 'son' : 'child';
};

/** "your mom's mom's dad", for a straight line of two or three steps; null otherwise. */
export function familyChain(steps: FamilyStep[], voice: FamilyVoice): string | null {
  if (steps.length < 2 || steps.length > 3) return null;
  if (!steps.every((step) => step.up === steps[0].up)) return null;
  return `${voice.poss} ${steps.map(stepWord).join('’s ')}`;
}

/** The generation ladder: ["You", "Mom", "Grandma", "Her dad"]. */
export function familyLadder(steps: FamilyStep[], voice: FamilyVoice): string[] {
  const out = [voice.selfCapital];
  let previousSex: string | null | undefined = null;
  steps.forEach((step, i) => {
    const word = stepWord(step);
    const allUpSoFar = steps.slice(0, i + 1).every((s) => s.up);
    const allDownSoFar = steps.slice(0, i + 1).every((s) => !s.up);
    if (i === 0) out.push(familyCapital(word));
    else if (i === 1 && allUpSoFar)
      out.push(step.sex === 'F' ? 'Grandma' : step.sex === 'M' ? 'Grandpa' : 'Grandparent');
    else if (i === 1 && allDownSoFar)
      out.push(step.sex === 'F' ? 'Granddaughter' : step.sex === 'M' ? 'Grandson' : 'Grandchild');
    else out.push(`${familyCapital(familyPronouns(previousSex).poss)} ${word}`);
    previousSex = step.sex;
  });
  return out;
}

export interface FamilyNutshellEvent {
  year: number | null;
  approx: boolean;
  place: string | null;
}

export interface FamilyNutshellInput {
  birth: FamilyNutshellEvent | null;
  death: FamilyNutshellEvent | null;
  living: boolean;
  marriedAt: number | null;
  children: number;
  moved: { place: string; year: number } | null;
}

const when = (event: FamilyNutshellEvent): string =>
  event.year == null ? '' : event.approx ? ` about ${event.year}` : ` in ${event.year}`;
const where = (event: FamilyNutshellEvent): string => (event.place ? ` in ${event.place}` : '');

/** Three plain sentences: "Born in 1850 in Town. Married at 21 and raised 7 children. Moved to
 * City by 1880 and died there at 68." Null when nothing is known. */
export function familyNutshell(input: FamilyNutshellInput): string | null {
  const sentences: string[] = [];
  const birth = input.birth && (input.birth.year != null || input.birth.place) ? input.birth : null;
  if (birth) sentences.push(`Born${when(birth)}${where(birth)}.`);
  const kids =
    input.children === 1
      ? 'had a child'
      : input.children > 1
        ? `raised ${input.children} children`
        : '';
  if (input.marriedAt != null && input.marriedAt >= 12 && input.marriedAt < 90) {
    sentences.push(`Married at ${input.marriedAt}${kids ? ` and ${kids}` : ''}.`);
  } else if (kids) sentences.push(`${familyCapital(kids)}.`);
  const death =
    !input.living && input.death && (input.death.year != null || input.death.place)
      ? input.death
      : null;
  let age = '';
  if (death && birth && birth.year != null && death.year != null && death.year >= birth.year) {
    age = `${birth.approx || death.approx ? ' at about ' : ' at '}${death.year - birth.year}`;
  }
  if (input.moved && death && death.place && death.place === input.moved.place) {
    sentences.push(`Moved to ${input.moved.place} by ${input.moved.year} and died there${age}.`);
  } else {
    if (input.moved) sentences.push(`Moved to ${input.moved.place} by ${input.moved.year}.`);
    if (death) sentences.push(`Died${when(death)}${where(death)}${age ? `,${age}` : ''}.`);
  }
  return sentences.length ? sentences.join(' ') : null;
}

/** "Born 1805; lived through the War of 1812 and the Civil War." Null with no birth year or no event. */
export function familyLivedThrough(
  birth: FamilyDate,
  death: FamilyDate,
  living: boolean,
  thisYear: number,
): string | null {
  if (birth.year == null) return null;
  const end = living ? thisYear : death.year;
  if (end == null) return null;
  const lived = FAMILY_HISTORY_EVENTS.filter(
    (event) => event.lived && birth.year != null && birth.year <= event.to && end >= event.from,
  ).map((event) => event.lived as string);
  if (!lived.length) return null;
  return `Born ${familyYearText(birth)}; lived through ${familyList(lived)}.`;
}

/** "About 18 minutes" for a story of this many characters (1,000 characters a minute, the
 * Library's rule of thumb). */
export function familyListenTime(chars: number): string {
  const minutes = Math.round(chars / 1000);
  if (minutes < 1) return 'Under a minute';
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `About ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` and ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

export const FAMILY_IMAGE_KIND_WORD: Readonly<Record<FamilyImageCategory, string>> = {
  portrait: 'Portrait',
  photo: 'Photo',
  record: 'Record scan',
  grave: 'Grave photo',
  document: 'Document',
  story: 'Story or clipping',
};

/** "Showing 49 to 96 of 250". */
export function familyPageSpoken(from: number, count: number, total: number): string {
  if (!total) return 'Nothing to show yet';
  return `Showing ${from + 1} to ${from + count} of ${total}`;
}

/** "1 in 8": the average share of DNA from an ancestor this many generations up. */
export function familyShare(gen: number): string {
  return `1 in ${2 ** Math.max(0, gen)}`;
}

/** "about 12.5%", "about 3%", "less than 1%" for a coefficient of relationship. */
export function familyPercent(coefficient: number): string {
  const pct = coefficient * 100;
  if (pct < 1) return 'less than 1%';
  if (pct >= 10) return `about ${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
  return `about ${Math.round(pct)}%`;
}

/** Joins names with commas and a final "and". */
export function familyList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
