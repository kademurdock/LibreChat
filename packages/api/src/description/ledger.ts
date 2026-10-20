import type { Continuity, Cue, Person, Word } from './types';

/**
 * The listener ledger: when each name becomes known to the listener, and the code-level gate
 * that keeps names out of narration, captions and continuity until then.
 */

/** Titles and family words that do not identify one person on their own. */
const common: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'aunt',
  'auntie',
  'baby',
  'big',
  'brother',
  'captain',
  'coach',
  'cousin',
  'dad',
  'doctor',
  'dr',
  'father',
  'grandma',
  'grandpa',
  'granny',
  'jr',
  'lady',
  'little',
  'lord',
  'madam',
  'mama',
  'miss',
  'mom',
  'mother',
  'mr',
  'mrs',
  'ms',
  'mx',
  'nana',
  'of',
  'officer',
  'old',
  'papa',
  'saint',
  'sir',
  'sister',
  'sr',
  'st',
  'the',
  'uncle',
  'young',
]);
const honorific =
  '(?:mr|mrs|ms|mx|miss|dr|sgt|sen|rev|lt|uncle|aunt|auntie|grandma|grandpa|coach|officer|captain|sir|saint|st)\\.?\\s+';
const edge = '(?<![\\p{L}\\p{N}])';
const after = '(?![\\p{L}\\p{N}])';
const patterns = new Map<string, RegExp>();
function pattern(source: string, flags: string): RegExp {
  const key = `${flags}:${source}`;
  let value = patterns.get(key);
  if (!value) {
    if (patterns.size > 1000) patterns.clear();
    value = new RegExp(source, flags);
    patterns.set(key, value);
  }
  value.lastIndex = 0;
  return value;
}
const cachedPattern = pattern;

/** Lowercase name key used by `Continuity.reveals` and `heard.names`. */
export const nameKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A well-known fictional character the model recognized on sight (Daffy Duck, Big Bird, Mario):
 * named from the first appearance instead of waiting for the dialogue. Real people never
 * qualify; that rests on the prompt, so KADE_DESCRIPTION_KNOWN_CHARACTERS=off turns it off.
 */
export const recognized = (person: Pick<Person, 'name' | 'nameFrom'>): boolean =>
  person.nameFrom === 'known' &&
  !!person.name.trim() &&
  process.env.KADE_DESCRIPTION_KNOWN_CHARACTERS !== 'off';

/** Lowercase letter-and-digit tokens; accents, a possessive 's and inner apostrophes are dropped. */
export function tokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’]s(?![\p{L}\p{N}])/gu, '')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when two tokens match exactly, or within one edit when both have five or more letters. */
export function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a[0] !== b[0] && Math.min(a.length, b.length) < 7) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return Math.max(a.length, b.length) - start - end <= 1;
}

type Said = { token: string; at: number; capital: boolean; raw: string };

function said(words: Word[]): Said[] {
  const ordered = [...words].sort((a, b) => a.start - b.start);
  return ordered.flatMap((word) => {
    const capital = /^[^\p{L}]*\p{Lu}/u.test(word.word);
    return tokens(word.word).map((token) => ({ token, at: word.start, capital, raw: word.word }));
  });
}

/** The name's tokens that single a person out, without titles such as Mr or Uncle. */
const distinctive = (parts: string[]): string[] =>
  parts.filter((part) => part.length > 1 && !common.has(part));

function firstSaid(stream: Said[], parts: string[]): number | undefined {
  if (!parts.length) return undefined;
  const own = distinctive(parts);
  for (let i = 0; i < stream.length; i++) {
    if (parts.length > 1 && i + parts.length <= stream.length) {
      let whole = true;
      for (let j = 0; j < parts.length && whole; j++) whole = near(stream[i + j].token, parts[j]);
      if (whole) return stream[i].at;
    }
    if (!stream[i].capital) continue;
    const single = parts.length === 1 ? parts : own;
    const modal =
      /^(will|may)$/i.test(stream[i].token) &&
      !/[!,]$/.test(stream[i].raw) &&
      /^(i|you|we|he|she|they|it|be|have|not)$/i.test(stream[i + 1]?.token ?? '');
    if (
      !modal &&
      single.some(
        (part) => stream[i].token === part || (parts.length === 1 && near(stream[i].token, part)),
      )
    )
      return stream[i].at;
  }
  return undefined;
}

/** First whole-video time each name is spoken, tolerant of one edit for names of 5+ letters. */
export function spokenReveals(words: Word[], names: string[]): Record<string, number> {
  const stream = said(words);
  const reveals: Record<string, number> = {};
  for (const name of names) {
    const key = nameKey(name);
    if (!key || key in reveals) continue;
    const at = firstSaid(stream, tokens(name));
    if (at !== undefined) reveals[key] = at;
  }
  return reveals;
}

/** Names the listener's own notes mention; she knows them from the start. */
export function notedNames(notes: string, names: string[]): string[] {
  return names.filter((name) => {
    const parts = tokens(name);
    if (!parts.length) return false;
    for (const hit of notes.matchAll(
      pattern(`${edge}${escape(name).replace(/\s+/g, '\\s+')}${after}`, 'giu'),
    )) {
      const at = hit.index ?? 0;
      const before = notes.slice(0, at);
      const rest = notes.slice(at + hit[0].length);
      if (/^may$/i.test(name) && /^\s+\d/.test(rest)) continue;
      if (/^(will|may)$/i.test(name) && /^\s+(?:open|be|have|not|you|i|we)\b/i.test(rest)) continue;
      if (
        parts.some((part) => common.has(part)) ||
        /(?:uncle|aunt|grandma|grandpa|named|called)\s+$/i.test(before) ||
        /^\s+is\s+(?:my|the|a)\b/i.test(rest) ||
        /^\p{Lu}/u.test(hit[0])
      )
        return true;
    }
    return false;
  });
}

/** Stretches of a description that read on-screen words aloud ("A sign reads …"). */
export function readings(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(
    /\b(?:text|caption|sign|banner|mailbox|label|title|card|screen|lettering|logo|words)\s+(?:reads|read|reading|displays|spells out)\b[:,]?\s*/gi,
  )) {
    const from = (match.index ?? 0) + match[0].length;
    const rest = text.slice(from);
    let stop = -1;
    if (/^["“]/.test(rest)) {
      const end = rest.slice(1).search(/["”]/);
      if (end >= 0) {
        spans.push([from, from + end + 2]);
        continue;
      }
    }
    for (const end of rest.matchAll(/[.!?](?=\s+[\p{Lu}"“]|\s*$)/gu)) {
      const at = end.index ?? 0;
      const prefix = rest.slice(0, at);
      if (end[0] === '.' && /(?:\b(?:Mr|Mrs|Ms|Dr|Sgt|Sen|Rev|Lt|St|Capt)|\b[A-Z])$/i.test(prefix))
        continue;
      stop = at;
      break;
    }
    spans.push([from, stop < 0 ? text.length : from + stop + 1]);
  }
  return spans;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A reading's words without its lead-in ("Text reads,"), lowercased, for comparing cards. */
function cardWords(text: string): string {
  const read = /\breads?\b[:,]?\s*/i.exec(text);
  const words = (read ? text.slice(read.index + read[0].length) : text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .match(/[\p{L}\p{N}']+/gu);
  return (words ?? []).join(' ');
}

/** A sentence that opens with the card lead-in, at the start of a cue or after a sentence end. */
const cardLeadIn = /(?:^|(?<=[.!?]["”’)]?\s))Text reads\b/;

/**
 * A description that also reads a card ("A spider sits in its web. Text reads, Wildlife Camera
 * Malcolm Ludgate ACS.") without being marked a reading: on Napoleon's end credits (Oct 20 2026)
 * one look marked such cues and another did not, and the unmarked ones, long and never frozen to
 * finish, crowded each other out of pause mode. The picture part stays an ordinary description
 * and the card part becomes a reading in the same window, marked or not, so a reading holds only
 * the card's words.
 */
export function splitCardReadings(cues: Cue[]): Cue[] {
  return cues.flatMap((cue) => {
    const found = cardLeadIn.exec(cue.text);
    if (!found || (cue.reading && found.index === 0)) return [cue];
    const before = cue.text.slice(0, found.index).trim();
    const card = cue.text.slice(found.index).trim();
    const reading: Cue = { ...cue, text: card, shortText: card, reading: true };
    return before
      ? [{ ...cue, text: before, shortText: before, reading: false }, reading]
      : [reading];
  });
}

/**
 * No-pause mode only: a credit group alone on its card gets its first sentence (the lead-in, the
 * first role and its names) as its short text, which the planner tries when the whole group does
 * not fit while it is on screen. A rolling credit group is on screen 3 to 4 s and takes longer to
 * say even at the fastest speed (Napoleon's end credits, Oct 20 2026: 1 of 31 groups fit whole),
 * so the roll is kept pace with by reading each group's first role. A card read in several chunks
 * keeps its full words or none, and pause mode always reads the whole group.
 */
export function creditShortText(cues: Cue[]): Cue[] {
  const windows = new Map<string, number>();
  for (const cue of cues)
    if (cue.reading) {
      const key = `${cue.at}:${cue.until}:${cue.pauseAt ?? cue.at}`;
      windows.set(key, (windows.get(key) ?? 0) + 1);
    }
  return cues.map((cue) => {
    if (!cue.reading) return cue;
    /** Only words from the card are ever said: never a short text the model wrote itself. */
    const whole = { ...cue, shortText: cue.text };
    if (windows.get(`${cue.at}:${cue.until}:${cue.pauseAt ?? cue.at}`) !== 1) return whole;
    const read = /\breads?\b[:,]?\s*/i.exec(cue.text);
    const from = read ? read.index + read[0].length : 0;
    for (const end of cue.text.slice(from).matchAll(/[.!?](?=\s+\p{Lu})/gu)) {
      const at = from + (end.index ?? 0);
      if (
        /(?:\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Dept|Co|Inc|Ltd|No)|\b\p{Lu})$/u.test(cue.text.slice(0, at))
      )
        continue;
      return { ...cue, shortText: cue.text.slice(0, at + 1) };
    }
    return whole;
  });
}

/**
 * Credits are read word for word since Oct 20 2026 (Kade: "I would also like it to read the
 * credits instead of just saying, credits appear"), so a rolling credit group that straddles two
 * clips could be read at the end of one and again at the start of the next, or twice in one clip.
 * A reading of three words or more is left out when the previous clip's last spoken lines
 * (`state.recent`) already said those words, or when an earlier reading of this clip (or one
 * carried over from the last, still unplaced) with an overlapping window said them.
 */
export function dropRereadCards(
  cues: Cue[],
  state: Continuity | null,
  carried: Cue[] = [],
): { cues: Cue[]; dropped: string[] } {
  const said = (state?.recent ?? []).map(cardWords).filter(Boolean);
  const kept: Cue[] = [];
  /** Readings carried over from the previous clip, still to be placed, count as earlier ones. */
  const earlier = [...carried];
  const dropped: string[] = [];
  for (const cue of cues) {
    const words = cardWords(cue.text);
    const again =
      cue.reading &&
      words.split(' ').length >= 3 &&
      (said.some((line) => ` ${line} `.includes(` ${words} `)) ||
        earlier.some(
          (other) =>
            other.reading &&
            other.at <= cue.until + 1 &&
            cue.at <= other.until + 1 &&
            cardWords(other.text) === words,
        ));
    if (again) dropped.push(cue.text);
    else {
      kept.push(cue);
      earlier.push(cue);
    }
  }
  return { cues: kept, dropped };
}

type Hit = { index: number; length: number };

/**
 * Where a name appears in a description, outside the words it reads from the screen: the whole
 * name, or for a longer name any distinctive part of it, capitalised, with an optional title.
 */
function hits(text: string, name: string, labels: string[] = []): Hit[] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const partial =
    parts.length > 1 ? parts.filter((part) => distinctive(tokens(part)).length > 0) : [];
  const blocked: Hit[] = [
    ...readings(text).map(([from, to]) => ({ index: from, length: to - from })),
    ...labels.flatMap((label) => labelHits(text, label)),
  ];
  const overlaps = (index: number, length: number) =>
    blocked.some((hit) => index < hit.index + hit.length && index + length > hit.index);
  const found: Hit[] = [];
  for (const pattern of [parts.map(escape).join('\\s+'), ...partial.map(escape)]) {
    for (const match of text.matchAll(
      cachedPattern(`${edge}(${honorific})?(${pattern})${after}`, 'giu'),
    )) {
      const index = match.index ?? 0;
      const length = match[0].length;
      if (!/^\p{Lu}/u.test(match[2]) || overlaps(index, length)) continue;
      const rest = text.slice(index + length);
      if (/^\s+(?:\p{Lu}[\p{L}.']*\s+)*(?:logo|sign|shirt|store|dealership|brand)\b/u.test(rest))
        continue;
      if (
        parts.length > 1 &&
        match[2].toLowerCase() !== name.toLowerCase() &&
        /^(?:brown|white|black|green|rose|price|will|may)$/i.test(match[2]) &&
        /^\s+(?:boxes|cards|flowers|paint|shirt|coat|you|i)\b/i.test(rest)
      )
        continue;
      const hit = { index, length };
      found.push(hit);
      blocked.push(hit);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** True when a description says the name (whole, or a distinctive part of a longer name). */
export function voicesName(text: string, name: string, labels: string[] = []): boolean {
  return hits(text, name, labels).length > 0;
}

/** True when the whole name is read aloud from the screen in this text. */
export function readsName(text: string, name: string): boolean {
  const spans = readings(text);
  if (!spans.length) return false;
  const regex = pattern(`${edge}${escape(name.trim()).replace(/\s+/g, '\\s+')}${after}`, 'iu');
  return spans.some(([from, to]) => regex.test(text.slice(from, to)));
}

const labelCore = (label: string): string =>
  label
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim()
    .toLowerCase();

const labelPattern = (label: string, flags: string): RegExp | undefined => {
  const core = labelCore(label);
  return core
    ? pattern(`${edge}${escape(core).replace(/\s+/g, '\\s+')}${after}`, flags)
    : undefined;
};

/** True when a spoken text uses this person's label (with any article). */
export function mentionsLabel(text: string, label: string): boolean {
  return labelPattern(label, 'iu')?.test(text) ?? false;
}

/** Where a label appears in a text, so a name inside another person's label is left alone. */
function labelHits(text: string, label: string): Hit[] {
  const pattern = labelPattern(label, 'giu');
  if (!pattern) return [];
  return [...text.matchAll(pattern)].map((match) => ({
    index: match.index ?? 0,
    length: match[0].length,
  }));
}

export const capitalize = (value: string): string =>
  value ? value[0].toUpperCase() + value.slice(1) : value;

/** A visual label ("the host", "a woman in red") rather than a name or an id. */
export const looksLikeLabel = (who: string): boolean => /^(?:the|a|an)\s+\S/i.test(who.trim());

const startsSentence = (text: string, index: number) =>
  index === 0 || /[.!?]["'”’)]?\s+$/.test(text.slice(0, index));

/** The label as it reads at this point of a sentence: capitalised at the start, article lowercased inside. */
function labelAt(text: string, index: number, label: string): string {
  if (startsSentence(text, index)) return capitalize(label);
  return /^(?:the|a|an)\s/i.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

/** Finds the person a speaker entry or cue refers to: by id, then label, then name. */
export function resolvePerson(who: string, people: Person[]): Person | undefined {
  const key = who.trim().toLowerCase();
  if (!key) return undefined;
  return (
    people.find((person) => person.id?.toLowerCase() === key) ??
    people.find((person) => person.label.toLowerCase() === key) ??
    people.find((person) => labelCore(person.label) === labelCore(key)) ??
    people.find((person) => person.name && person.name.toLowerCase() === key)
  );
}

/** Replaces every use of a name the listener cannot know yet with the person's label. */
function hideName(text: string, name: string, label: string, labels: string[]): string {
  let out = text;
  const core = escape(labelCore(label)).replace(/\s+/g, '\\s+');
  for (const hit of hits(out, name, labels).reverse()) {
    let start = hit.index;
    let end = hit.index + hit.length;
    const before = out.slice(0, start);
    const named = pattern(`(?:the\\s+|a\\s+|an\\s+)?${core}\\s+(?:named|called)\\s*$`, 'iu').exec(
      before,
    );
    if (named) {
      out = before.replace(/\s+(?:named|called)\s*$/i, '') + out.slice(end);
      continue;
    }
    const joinedBefore = pattern(`(?:the\\s+|a\\s+|an\\s+)?${core},\\s*$`, 'iu').exec(before);
    const joinedAfter = pattern(
      `^(?:,\\s*|\\s+)(?:the\\s+|a\\s+|an\\s+)?${core}${after}`,
      'iu',
    ).exec(out.slice(end));
    if (joinedBefore) {
      start = before.length - joinedBefore[0].length + joinedBefore[0].indexOf(',');
      if (out[end] === ',') end++;
      out = out.slice(0, start) + out.slice(end);
      continue;
    }
    if (joinedAfter) {
      end += joinedAfter[0].length;
      if (out[end] === ',') end++;
    }
    const possessive = /^['’](?!s\b)/.test(out.slice(end));
    out =
      out.slice(0, start) +
      labelAt(out, start, label) +
      (possessive ? "'s" : '') +
      out.slice(end + (possessive ? 1 : 0));
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
}

/** Joins "label, name" at the first use of a name the listener has not had linked to a person. */
function joinName(text: string, name: string, label: string, labels: string[]): string {
  if (mentionsLabel(text, label)) return text;
  const hit = hits(text, name, labels).find(
    (item) =>
      !/^['’]/.test(text.slice(item.index + item.length)) &&
      !/,\s*$/.test(text.slice(0, item.index)) &&
      !/^\s+and\b/.test(text.slice(item.index + item.length)),
  );
  if (!hit) return text;
  const end = hit.index + hit.length;
  const rest = text.slice(end);
  const comma = /^\s*[\p{L}\p{N}]/u.test(rest) ? ',' : '';
  return (
    text.slice(0, hit.index) +
    `${labelAt(text, hit.index, label)}, ${text.slice(hit.index, end)}${comma}` +
    rest
  );
}

/**
 * Once the listener has the name linked to the label, a "label, name" or "name, label" join the
 * model wrote again shrinks to the name alone.
 */
function dropJoin(text: string, name: string, label: string): string {
  const core = labelCore(label);
  if (!core) return text;
  const article = '(?:the\\s+|a\\s+|an\\s+)?';
  const said = `${escape(core).replace(/\s+/g, '\\s+')}`;
  const spoken = `${escape(name.trim()).replace(/\s+/g, '\\s+')}`;
  const keep = (_match: string, found: string, offset: number, whole: string) =>
    startsSentence(whole, offset) ? capitalize(found) : found;
  return text
    .replace(pattern(`${edge}${article}${said},\\s*(${spoken})${after},?`, 'giu'), keep)
    .replace(pattern(`${edge}(${spoken}),\\s*${article}${said}${after},?`, 'giu'), keep)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1');
}

/** The noun a label is built on: "the pink and grey bird" -> "bird", "the man in a red coat" -> "man". */
function labelHead(label: string): string | undefined {
  const core = labelCore(label).split(
    /\s+(?:in|with|on|at|of|from|wearing|holding|carrying|near|under|by|beside|behind|who|that)\s+/,
  )[0];
  const head = core.split(/\s+/).pop();
  return head && /^\p{L}[\p{L}'’-]*$/u.test(head) ? head : undefined;
}
/** Heads too common to stand for one person unless the description is about that person. */
const everyday = new Set(['man', 'woman', 'boy', 'girl', 'person', 'kid', 'child', 'guy', 'lady']);

/**
 * Once the listener knows a character's name, the model sometimes drifts back to the label: on
 * Kade's Napoleon (Oct 18 2026) the cockatoo was "Birdo" from minute 10, then "the pink and grey
 * bird" and "the bird" for nine descriptions around minute 37, and Napoleon "the white puppy",
 * while the look itself still listed both by name. Here the label with "the" ("the pink and grey
 * bird", "the pink and grey bird's") becomes the name, and so does its bare noun ("the bird") when
 * nobody else in the clip is labelled with that noun (an everyday noun such as "the man" only in a
 * description about that person). "A pink and grey bird" is left alone: it may be another one.
 */
function useName(text: string, person: Person, present: Person[], about: boolean): string {
  const name = person.name.trim();
  /** "Napoleon the white puppy" keeps the name once, not "Napoleon Napoleon". */
  const swap = (out: string, words: string) =>
    out.replace(
      pattern(
        `${edge}(?:(${escape(name).replace(/\s+/g, '\\s+')})\\s+)?the\\s+${escape(words).replace(/\s+/g, '\\s+')}((?:['’]s)?)${after}`,
        'giu',
      ),
      (_match: string, written: string | undefined, possessive: string) =>
        (written ?? name) + (possessive ? "'s" : ''),
    );
  const core = labelCore(person.label);
  let out = core ? swap(text, core) : text;
  const head = labelHead(person.label);
  if (
    head &&
    head.toLowerCase() !== core &&
    (about || !everyday.has(head.toLowerCase())) &&
    !present.some(
      (other) =>
        other.label.toLowerCase() !== person.label.toLowerCase() &&
        labelHead(other.label)?.toLowerCase() === head.toLowerCase(),
    )
  )
    out = swap(out, head);
  return out;
}

function known(people: Person[], state: Continuity | null): Person[] {
  const all: Person[] = [];
  for (const person of [...people, ...(state?.people ?? [])]) {
    if (!person.label) continue;
    const same = all.find(
      (item) =>
        (person.id && item.id === person.id) ||
        item.label.toLowerCase() === person.label.toLowerCase(),
    );
    if (!same) all.push({ ...person });
    else if (!same.name && person.name) {
      same.name = person.name;
      same.nameFrom = person.nameFrom;
    } else if (!same.nameFrom && person.name && nameKey(same.name) === nameKey(person.name))
      same.nameFrom = person.nameFrom;
  }
  return all;
}

/** Reveal times from every source the listener could know a name by: notes, speech and earlier state. */
export function revealsFor(
  names: string[],
  words: Word[],
  notes: string,
  previous?: Record<string, number>,
): Record<string, number> {
  const reveals: Record<string, number> = { ...(previous ?? {}) };
  const earliest = (key: string, at: number) => {
    if (reveals[key] === undefined || at < reveals[key]) reveals[key] = at;
  };
  for (const name of notedNames(notes, names)) earliest(nameKey(name), 0);
  for (const [key, at] of Object.entries(spokenReveals(words, names))) earliest(key, at);
  return reveals;
}

function cardReadings(order: { cue: Cue; index: number }[]): Map<number, string> {
  const cards = new Map<number, string>();
  let start = 0;
  while (start < order.length) {
    const first = order[start];
    if (!first.cue.reading) {
      start++;
      continue;
    }
    let end = start + 1;
    while (
      end < order.length &&
      order[end].cue.reading &&
      order[end].cue.at === first.cue.at &&
      order[end].cue.until === first.cue.until
    )
      end++;
    cards.set(
      first.index,
      order
        .slice(start, end)
        .map(({ cue }) => cue.text)
        .join(' '),
    );
    start = end;
  }
  return cards;
}

/**
 * Replaces names the listener cannot know yet at each cue's time with the person's label
 * (capitalised at a sentence start); joins "label, name" the first time a name is voiced.
 * A name read from the screen in a cue ("A caption reads …") is revealed at that cue. A
 * recognized character (nameFrom "known") is revealed from the section start and introduced by
 * name, so no label is joined to it by code.
 */
export function gateCues(input: {
  cues: Cue[];
  people: Person[];
  state: Continuity | null;
  words: Word[];
  notes: string;
  sectionStart: number;
  reference?: Person[];
}): {
  cues: Cue[];
  reveals: Record<string, number>;
  rejoin: (placed: { cue: Cue; spoken: string }[]) => (Cue | undefined)[];
} {
  const everyone = known(input.people, input.state);
  for (const ref of input.reference ?? []) {
    const same = everyone.find((person) => labelCore(person.label) === labelCore(ref.label));
    if (same) {
      if (!same.name) {
        same.name = ref.name;
        same.nameFrom = ref.nameFrom;
      }
    } else everyone.push({ ...ref, id: undefined });
  }
  const people = everyone.filter((person) => person.name);
  /** Everyone the look saw in this clip, as the ledger knows them. */
  const present = input.people.map(
    (person) => resolvePerson(person.id ?? person.label, everyone) ?? person,
  );
  const names = [...new Set(people.map((person) => person.name))];
  const labels = everyone.map((person) => person.label);
  const reveals = revealsFor(names, input.words, input.notes, input.state?.reveals);
  for (const person of people) {
    if (!recognized(person)) continue;
    const key = nameKey(person.name);
    if (reveals[key] === undefined || reveals[key] > input.sectionStart)
      reveals[key] = input.sectionStart;
  }
  const linked = new Set(Object.keys(input.state?.heard?.names ?? {}).map(nameKey));
  const heardLabels = input.state?.heard?.labels ?? [];
  const introduced = new Set<string>();
  const order = input.cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.at - b.cue.at || a.index - b.index);
  const cards = cardReadings(order);
  const out: Cue[] = [...input.cues];
  for (const { cue, index } of order) {
    const time = input.sectionStart + cue.at;
    for (const name of names) {
      const key = nameKey(name);
      const shown = cue.reading
        ? pattern(`${edge}${escape(name.trim()).replace(/\s+/g, '\\s+')}${after}`, 'iu').test(
            cards.get(index) ?? '',
          )
        : readsName(cue.text, name);
      if (shown && (reveals[key] === undefined || time < reveals[key])) reveals[key] = time;
    }
    if (cue.reading) {
      out[index] = { ...cue, importance: 3 };
      continue;
    }
    let text = cue.text;
    let shortText = cue.shortText;
    const joined: string[] = [];
    for (const person of people) {
      const key = nameKey(person.name);
      if (pattern(`${edge}${escape(key)}${after}`, 'iu').test(labelCore(person.label))) continue;
      const reveal = reveals[key];
      if (reveal === undefined || reveal > time + 1e-6) {
        text = hideName(text, person.name, person.label, labels);
        shortText = hideName(shortText, person.name, person.label, labels);
        continue;
      }
      if (linked.has(key)) {
        const about = (cue.who ?? []).some(
          (id) => resolvePerson(id, everyone)?.label.toLowerCase() === person.label.toLowerCase(),
        );
        text = useName(dropJoin(text, person.name, person.label), person, present, about);
        shortText = useName(dropJoin(shortText, person.name, person.label), person, present, about);
        continue;
      }
      if (recognized(person)) {
        if (voicesName(text, person.name, labels) || voicesName(shortText, person.name, labels))
          joined.push(key);
        continue;
      }
      const fullText = joinName(text, person.name, person.label, labels);
      const fullShort = joinName(shortText, person.name, person.label, labels);
      const voiced = (value: string) =>
        mentionsLabel(value, person.label) && hits(value, person.name, labels).length > 0;
      if (voiced(fullText) || voiced(fullShort)) joined.push(key);
      text = fullText;
      shortText = fullShort;
    }
    for (const key of joined) linked.add(key);
    let importance = cue.importance;
    for (const id of cue.who ?? []) {
      const person = resolvePerson(id, everyone);
      if (!person || introduced.has(person.label.toLowerCase())) continue;
      introduced.add(person.label.toLowerCase());
      if (!heardLabels.some((label) => label.toLowerCase() === person.label.toLowerCase()))
        importance = 3;
    }
    out[index] = { ...cue, text, shortText, importance };
  }
  const rejoin = (placed: { cue: Cue; spoken: string }[]): (Cue | undefined)[] => {
    const heard = new Set(Object.keys(input.state?.heard?.names ?? {}).map(nameKey));
    return placed.map(({ cue, spoken }) => {
      if (cue.reading) return undefined;
      let text = cue.text,
        shortText = cue.shortText;
      for (const person of people) {
        const key = nameKey(person.name);
        if (reveals[key] === undefined || reveals[key] > input.sectionStart + cue.at) continue;
        if (recognized(person)) continue;
        if (!heard.has(key) && hits(spoken, person.name, labels).length) {
          text = joinName(text, person.name, person.label, labels);
          shortText = joinName(shortText, person.name, person.label, labels);
          if (mentionsLabel(text, person.label)) heard.add(key);
        }
      }
      return text === cue.text && shortText === cue.shortText
        ? undefined
        : { ...cue, text, shortText };
    });
  };
  return { cues: out, reveals, rejoin };
}

/**
 * The name to print for a speaker at a whole-video time: the name only once revealed, else the
 * label, else "Speaker N".
 */
export function speakerAt(continuity: Continuity, speaker: number, at: number): string {
  const fallback = `Speaker ${speaker + 1}`;
  const entry = continuity.speakers.find((item) => item.speaker === speaker);
  const person = entry ? resolvePerson(entry.who, continuity.people) : undefined;
  if (!person) return entry && looksLikeLabel(entry.who) ? capitalize(entry.who.trim()) : fallback;
  const reveal = person.name ? continuity.reveals?.[nameKey(person.name)] : undefined;
  if (person.name && reveal !== undefined && reveal <= at + 1e-6) return person.name;
  return capitalize(person.label) || fallback;
}
