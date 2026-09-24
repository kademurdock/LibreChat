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
  '(?:mr|mrs|ms|mx|miss|dr|uncle|aunt|auntie|grandma|grandpa|coach|officer|captain|sir|saint|st)\\.?\\s+';
const edge = '(?<![\\p{L}\\p{N}])';
const after = '(?![\\p{L}\\p{N}])';

/** Lowercase name key used by `Continuity.reveals` and `heard.names`. */
export const nameKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase();

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

type Said = { token: string; at: number; capital: boolean };

function said(words: Word[]): Said[] {
  const ordered = [...words].sort((a, b) => a.start - b.start);
  return ordered.flatMap((word) => {
    const capital = /^[^\p{L}]*\p{Lu}/u.test(word.word);
    return tokens(word.word).map((token) => ({ token, at: word.start, capital }));
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
    if (single.some((part) => near(stream[i].token, part))) return stream[i].at;
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
  const written = tokens(notes);
  if (!written.length) return [];
  const has = (sequence: string[]) =>
    written.some((_, i) => sequence.every((part, j) => written[i + j] === part));
  return names.filter((name) => {
    const parts = tokens(name);
    if (!parts.length) return false;
    const own = distinctive(parts);
    return has(parts) || (own.length > 0 && own.some((part) => written.includes(part)));
  });
}

/** Stretches of a description that read on-screen words aloud ("A sign reads …"). */
export function readings(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(/\b(?:reads|read|reading|displays|spells out)\b[:,]?\s*/gi)) {
    const from = (match.index ?? 0) + match[0].length;
    const rest = text.slice(from);
    const stop = rest.search(/[.!?](?=\s+[\p{Lu}"“]|\s*$)/u);
    spans.push([from, stop < 0 ? text.length : from + stop + 1]);
  }
  return spans;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Hit = { index: number; length: number };

/**
 * Where a name appears in a description, outside the words it reads from the screen: the whole
 * name, or for a longer name any distinctive part of it, capitalised, with an optional title.
 */
function hits(text: string, name: string): Hit[] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const partial =
    parts.length > 1 ? parts.filter((part) => distinctive(tokens(part)).length > 0) : [];
  const blocked: Hit[] = readings(text).map(([from, to]) => ({ index: from, length: to - from }));
  const overlaps = (index: number, length: number) =>
    blocked.some((hit) => index < hit.index + hit.length && index + length > hit.index);
  const found: Hit[] = [];
  for (const pattern of [parts.map(escape).join('\\s+'), ...partial.map(escape)]) {
    for (const match of text.matchAll(new RegExp(`${edge}(${honorific})?(${pattern})${after}`, 'giu'))) {
      const index = match.index ?? 0;
      const length = match[0].length;
      if (!/^\p{Lu}/u.test(match[2]) || overlaps(index, length)) continue;
      const hit = { index, length };
      found.push(hit);
      blocked.push(hit);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** True when the name, or a distinctive part of it, is read aloud from the screen in this text. */
export function readsName(text: string, name: string): boolean {
  const spans = readings(text);
  if (!spans.length) return false;
  const pattern = new RegExp(`${edge}${escape(name.trim()).replace(/\s+/g, '\\s+')}${after}`, 'iu');
  return spans.some(([from, to]) => pattern.test(text.slice(from, to)));
}

const labelCore = (label: string): string =>
  label
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim()
    .toLowerCase();

/** True when a spoken text uses this person's label (with any article). */
export function mentionsLabel(text: string, label: string): boolean {
  const core = labelCore(label);
  if (!core) return false;
  return new RegExp(`${edge}${escape(core).replace(/\s+/g, '\\s+')}${after}`, 'iu').test(text);
}

export const capitalize = (value: string): string =>
  value ? value[0].toUpperCase() + value.slice(1) : value;

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
function hideName(text: string, name: string, label: string): string {
  let out = text;
  const core = escape(labelCore(label)).replace(/\s+/g, '\\s+');
  for (const hit of hits(out, name).reverse()) {
    let start = hit.index;
    let end = hit.index + hit.length;
    const before = out.slice(0, start);
    const joinedBefore = new RegExp(`(?:the\\s+|a\\s+|an\\s+)?${core},\\s*$`, 'iu').exec(before);
    const joinedAfter = new RegExp(`^,\\s*(?:the\\s+|a\\s+|an\\s+)?${core}${after}`, 'iu').exec(
      out.slice(end),
    );
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
    out = out.slice(0, start) + labelAt(out, start, label) + out.slice(end);
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
}

/** Joins "label, name" at the first use of a name the listener has not had linked to a person. */
function joinName(text: string, name: string, label: string): string {
  if (mentionsLabel(text, label)) return text;
  const hit = hits(text, name).find((item) => !/^['’]s\b/.test(text.slice(item.index + item.length)));
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
    else if (!same.name && person.name) same.name = person.name;
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

/**
 * Replaces names the listener cannot know yet at each cue's time with the person's label
 * (capitalised at a sentence start); joins "label, name" the first time a name is voiced.
 * A name read from the screen in a cue ("A caption reads …") is revealed at that cue.
 */
export function gateCues(input: {
  cues: Cue[];
  people: Person[];
  state: Continuity | null;
  words: Word[];
  notes: string;
  sectionStart: number;
}): { cues: Cue[]; reveals: Record<string, number> } {
  const everyone = known(input.people, input.state);
  const people = everyone.filter((person) => person.name);
  const names = [...new Set(people.map((person) => person.name))];
  const reveals = revealsFor(names, input.words, input.notes, input.state?.reveals);
  const linked = new Set(Object.keys(input.state?.heard?.names ?? {}).map(nameKey));
  const heardLabels = input.state?.heard?.labels ?? [];
  const introduced = new Set<string>();
  const order = input.cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.at - b.cue.at || a.index - b.index);
  const out: Cue[] = [...input.cues];
  for (const { cue, index } of order) {
    const time = input.sectionStart + cue.at;
    for (const name of names) {
      const key = nameKey(name);
      if (readsName(cue.text, name) && (reveals[key] === undefined || time < reveals[key]))
        reveals[key] = time;
    }
    let text = cue.text;
    let shortText = cue.shortText;
    const joined: string[] = [];
    for (const person of people) {
      const key = nameKey(person.name);
      const reveal = reveals[key];
      if (reveal === undefined || reveal > time + 1e-6) {
        text = hideName(text, person.name, person.label);
        shortText = hideName(shortText, person.name, person.label);
        continue;
      }
      if (linked.has(key)) continue;
      const fullText = joinName(text, person.name, person.label);
      const fullShort = joinName(shortText, person.name, person.label);
      if (fullText !== text || fullShort !== shortText) joined.push(key);
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
  return { cues: out, reveals };
}

/**
 * The name to print for a speaker at a whole-video time: the name only once revealed, else the
 * label, else "Speaker N".
 */
export function speakerAt(continuity: Continuity, speaker: number, at: number): string {
  const fallback = `Speaker ${speaker + 1}`;
  const entry = continuity.speakers.find((item) => item.speaker === speaker);
  const person = entry ? resolvePerson(entry.who, continuity.people) : undefined;
  if (!person) return fallback;
  const reveal = person.name ? continuity.reveals?.[nameKey(person.name)] : undefined;
  if (person.name && reveal !== undefined && reveal <= at + 1e-6) return person.name;
  return capitalize(person.label) || fallback;
}
