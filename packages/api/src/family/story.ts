import { familyHash, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY STORIES (docs/FAMILY_HISTORY.md, "Stories and Listen")
 *
 * A story is markdown written in the owner's voice. The server turns it into
 * blocks the app draws natively (headings, paragraphs, list items, quotes;
 * bracketed source paths become numbered source chips and never reach a
 * reader), into parts for Listen (cut like the Library reader cuts a book:
 * whole sentences, about 450 characters, never more than 600), and into
 * caption cues, one per sentence, timed by each sentence's share of its part.
 * The inline reader is a port of the web page's (history.js parseInline and
 * parseMarkdown) and the cutter a port of kadeReadingRoomParse.js; the tests
 * check each against its original.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'source'; v: string }
  | { t: 'link'; href: string; c: FamilyInline[] }
  | { t: 'span'; c: FamilyInline[] }
  | { t: 'strong'; c: FamilyInline[] }
  | { t: 'em'; c: FamilyInline[] };

export type FamilyMarkdownBlock =
  | { type: 'paragraph'; inline: FamilyInline[] }
  | { type: 'heading'; level: number; inline: FamilyInline[] }
  | { type: 'rule' }
  | { type: 'code'; text: string }
  | { type: 'table'; head: FamilyInline[][]; rows: FamilyInline[][][] }
  | { type: 'list'; ordered: boolean; items: FamilyInline[][] }
  | { type: 'quote'; inline: FamilyInline[] };

export interface FamilyRun {
  text: string;
  em?: true;
  strong?: true;
  link?: string;
  /** A source chip: the number in the story's source list. */
  source?: number;
}

export interface FamilyStoryBlock {
  type: 'h2' | 'h3' | 'p' | 'li' | 'quote';
  runs: FamilyRun[];
  /** List items: the number for an ordered list. */
  n?: number;
}

export interface FamilyStorySource {
  n: number;
  title: string;
  url: string | null;
}

export interface FamilyCue {
  text: string;
  start: number;
  end: number;
}

export interface FamilyStoryPart {
  i: number;
  text: string;
  /** Sentence cues as fractions of the part (0 to 1). */
  cues: FamilyCue[];
}

/** What a source path can be named by, looked up in the bundle. */
export interface FamilySourceLookup {
  record: (key: string) => { collection?: string; url?: string } | undefined;
  memorial: (
    id: string,
  ) => { name?: string; cemetery?: string | null; url?: string | null } | undefined;
}

export const FAMILY_PART_TARGET: number = 450;
export const FAMILY_PART_MAX: number = 600;

/* ── the reader (port of history.js) ────────────────────────────────────── */

const FILE_END = /\.(json|md|txt|pdf|jpe?g|png|gif|webp|tiff?|html?|csv|ged|xml|docx?)$/i;

/** A bracketed list of file paths ("[records/ancestry/1/2.json; notes.md]"), not a link or a checkbox. */
export function familyIsSourcePath(inner: string): boolean {
  const t = String(inner || '').trim();
  if (!t || t.length > 400 || /^\s*[xX ]\s*$/.test(t)) return false;
  return t
    .split(/\s*;\s*/)
    .every(
      (p) =>
        !!p && !/\s{2,}/.test(p) && (/[/\\]/.test(p) || FILE_END.test(p)) && !/^https?:/i.test(p),
    );
}

export function familySafeHref(href: string): string | null {
  const h = String(href || '').trim();
  if ([...h].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  if (/^https?:\/\/[^\s]+$/i.test(h)) return h;
  if (/^mailto:[^\s]+$/i.test(h)) return h;
  if (/^#\/[^\s]*$/.test(h)) return h;
  return null;
}

function closingBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

function emphasisEnd(src: string, from: number, mark: string): number {
  if (from >= src.length || /\s/.test(src.charAt(from))) return -1;
  for (let j = from + 1; j < src.length; j++) {
    if (src.charAt(j) === '\\') {
      j++;
      continue;
    }
    if (src.charAt(j) !== mark || /\s/.test(src.charAt(j - 1))) continue;
    if (src.charAt(j + 1) === mark) {
      j++;
      continue;
    }
    if (mark === '_' && /\w/.test(src.charAt(j + 1))) continue;
    return j;
  }
  return -1;
}

export function familyParseInline(text: string): FamilyInline[] {
  const src = String(text == null ? '' : text);
  const out: FamilyInline[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < src.length) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (c === '\\' && next && /[\\`*_[\]()#+\-.!>|~]/.test(next)) {
      buf += next;
      i += 2;
      continue;
    }
    if (c === '`') {
      const endCode = src.indexOf('`', i + 1);
      if (endCode > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, endCode) });
        i = endCode + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = closingBracket(src, i);
      if (close > i) {
        const inner = src.slice(i + 1, close);
        if (src.charAt(close + 1) === '(') {
          const paren = src.indexOf(')', close + 2);
          if (paren > close) {
            const href = familySafeHref(
              src
                .slice(close + 2, paren)
                .trim()
                .split(/\s+/)[0],
            );
            flush();
            out.push(
              href
                ? { t: 'link', href, c: familyParseInline(inner) }
                : { t: 'span', c: familyParseInline(inner) },
            );
            i = paren + 1;
            continue;
          }
        }
        if (familyIsSourcePath(inner)) {
          flush();
          for (const p of inner.trim().split(/\s*;\s*/)) out.push({ t: 'source', v: p });
          i = close + 1;
          continue;
        }
      }
    }
    if ((c === '*' || c === '_') && next === c) {
      const endStrong = src.indexOf(c + c, i + 2);
      if (endStrong > i + 2 && !/\s/.test(src.charAt(i + 2))) {
        flush();
        out.push({ t: 'strong', c: familyParseInline(src.slice(i + 2, endStrong)) });
        i = endStrong + 2;
        continue;
      }
    }
    if (c === '*' || (c === '_' && !/\w/.test(src.charAt(i - 1)))) {
      const endEm = emphasisEnd(src, i + 1, c);
      if (endEm > i + 1) {
        flush();
        out.push({ t: 'em', c: familyParseInline(src.slice(i + 1, endEm)) });
        i = endEm + 1;
        continue;
      }
    }
    if (
      (c === 'h' || c === 'H') &&
      /^https?:\/\//i.test(src.slice(i, i + 8)) &&
      !/[\w/]/.test(src.charAt(i - 1))
    ) {
      const m = /^https?:\/\/[^\s<>"]*[^\s<>".,;:!?)'\]]/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function splitRow(line: string): FamilyInline[][] {
  let t = line.trim();
  if (t.charAt(0) === '|') t = t.slice(1);
  if (t.slice(-1) === '|' && t.slice(-2) !== '\\|') t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (c === '\\' && t.charAt(i + 1) === '|') {
      cur += '\\|';
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  return cells.map((cell) => familyParseInline(cell.trim()));
}

export function familyParseMarkdown(md: string): FamilyMarkdownBlock[] {
  const lines = String(md == null ? '' : md)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks: FamilyMarkdownBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const endPara = (): void => {
    if (para.length) blocks.push({ type: 'paragraph', inline: familyParseInline(para.join(' ')) });
    para = [];
  };
  const endList = (): void => {
    if (list)
      blocks.push({
        type: 'list',
        ordered: list.ordered,
        items: list.items.map(familyParseInline),
      });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      endPara();
      endList();
      continue;
    }
    const fence = /^(```|~~~)/.exec(t);
    if (fence) {
      endPara();
      endList();
      const code: string[] = [];
      for (i++; i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0; i++)
        code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
    if (heading) {
      endPara();
      endList();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        inline: familyParseInline(heading[2]),
      });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(t)) {
      endPara();
      endList();
      blocks.push({ type: 'rule' });
      continue;
    }
    if (
      t.charAt(0) === '|' &&
      i + 1 < lines.length &&
      /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[i + 1].trim())
    ) {
      endPara();
      endList();
      const head = splitRow(t);
      const rows: FamilyInline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim().charAt(0) === '|'; i++)
        rows.push(splitRow(lines[i]));
      i--;
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    const item = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      const ordered = /\d/.test(item[1]);
      if (!list || list.ordered !== ordered) {
        endList();
        list = { ordered, items: [] };
      }
      list.items.push(item[2]);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) {
      endPara();
      endList();
      const said = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim()))
        said.push(lines[++i].trim().replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', inline: familyParseInline(said.join(' ').trim()) });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${t}`;
      continue;
    }
    endList();
    para.push(t);
  }
  endPara();
  endList();
  return blocks;
}

/* ── v1: the markdown the web page reads ────────────────────────────────── */

function printable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 9 || code === 10 || (code >= 32 && code !== 127);
}

/** Markdown with no raw HTML, no control characters and plain line ends; autolinks survive. */
export function familyStoryMarkdown(text: string): string {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, '')
    .split('')
    .filter(printable)
    .join('');
}

/* ── blocks and sources for the app ─────────────────────────────────────── */

/** A plain title for a source path, never the path itself (file names can carry names). */
function sourceTitle(
  path: string,
  lookup: FamilySourceLookup,
): { title: string; url: string | null } {
  const p = path.replace(/\\/g, '/');
  const https = (url: string | null | undefined): string | null =>
    url && /^https:\/\/[^\s]+$/i.test(url) ? url : null;
  const record = /(?:^|\/)records\/[^/]+\/([^/]+)\/([^/.]+)\.(json|jpe?g|png)$/i.exec(p);
  if (record) {
    const found = lookup.record(`${record[1]}:${record[2]}`);
    const name = found?.collection ? found.collection : 'A record';
    return {
      title: /json/i.test(record[3]) ? name : `${name}, the scan`,
      url: https(found?.url),
    };
  }
  const grave = /(?:^|\/)findagrave\/(\d+)\//i.exec(p);
  if (grave) {
    const found = lookup.memorial(grave[1]);
    const where = found?.cemetery || '';
    return {
      title: where ? `Find a Grave memorial, ${where}` : 'A Find a Grave memorial',
      url: https(found?.url),
    };
  }
  if (/(?:^|\/)sources-codex\//i.test(p)) return { title: 'A source document', url: null };
  if (/\.md$/i.test(p) || /(?:^|\/)research\//i.test(p))
    return { title: 'Research notes', url: null };
  if (/\.(jpe?g|png|gif|webp|tiff?|pdf)$/i.test(p))
    return { title: 'A picture or scan', url: null };
  return { title: 'A source', url: null };
}

function sameMarks(a: FamilyRun, b: FamilyRun): boolean {
  return (
    a.em === b.em &&
    a.strong === b.strong &&
    a.link === b.link &&
    a.source === undefined &&
    b.source === undefined
  );
}

/**
 * The story as the app's blocks: the first top heading is the title and is left out; source
 * chips are numbered in order of first use; links are web links only.
 */
export function familyStoryBlocks(
  markdown: string,
  lookup: FamilySourceLookup,
): { blocks: FamilyStoryBlock[]; sources: FamilyStorySource[] } {
  const numbers = new Map<string, number>();
  const sources: FamilyStorySource[] = [];
  const numberFor = (path: string): number => {
    const key = path.trim().replace(/\\/g, '/');
    const known = numbers.get(key);
    if (known) return known;
    const n = sources.length + 1;
    numbers.set(key, n);
    const { title, url } = sourceTitle(key, lookup);
    sources.push({ n, title, url });
    return n;
  };
  const runs = (inline: FamilyInline[], marks: Omit<FamilyRun, 'text'> = {}): FamilyRun[] => {
    const out: FamilyRun[] = [];
    const add = (run: FamilyRun): void => {
      const last = out[out.length - 1];
      if (last && run.source === undefined && sameMarks(last, run)) last.text += run.text;
      else out.push(run);
    };
    for (const node of inline) {
      if (node.t === 'text' || node.t === 'code') {
        if (node.v) add({ ...marks, text: node.v });
      } else if (node.t === 'source') add({ text: '', source: numberFor(node.v) });
      else if (node.t === 'link') {
        const href = /^https?:\/\//i.test(node.href) ? node.href : undefined;
        for (const run of runs(node.c, { ...marks, ...(href ? { link: href } : {}) })) add(run);
      } else if (node.t === 'span') for (const run of runs(node.c, marks)) add(run);
      else if (node.t === 'strong')
        for (const run of runs(node.c, { ...marks, strong: true })) add(run);
      else if (node.t === 'em') for (const run of runs(node.c, { ...marks, em: true })) add(run);
    }
    return tidy(out);
  };
  const blocks: FamilyStoryBlock[] = [];
  let titleSeen = false;
  const push = (block: FamilyStoryBlock): void => {
    if (block.runs.some((run) => run.text.trim() || run.source !== undefined)) blocks.push(block);
  };
  for (const block of familyParseMarkdown(markdown)) {
    if (block.type === 'heading') {
      if (block.level === 1 && !titleSeen && !blocks.length) {
        titleSeen = true;
        continue;
      }
      push({ type: block.level <= 2 ? 'h2' : 'h3', runs: runs(block.inline) });
    } else if (block.type === 'paragraph') push({ type: 'p', runs: runs(block.inline) });
    else if (block.type === 'quote') push({ type: 'quote', runs: runs(block.inline) });
    else if (block.type === 'list') {
      block.items.forEach((item, index) =>
        push({ type: 'li', runs: runs(item), ...(block.ordered ? { n: index + 1 } : {}) }),
      );
    } else if (block.type === 'code') push({ type: 'p', runs: [{ text: block.text.trim() }] });
    else if (block.type === 'table') {
      for (const row of block.rows) {
        const cells = row
          .map((cell) =>
            runs(cell)
              .map((run) => run.text)
              .join('')
              .trim(),
          )
          .filter(Boolean);
        if (cells.length) push({ type: 'p', runs: [{ text: cells.join(', ') }] });
      }
    }
  }
  return { blocks, sources };
}

/** Whitespace squashed inside runs, none before a source chip, the paragraph's ends trimmed. */
function tidy(runs: FamilyRun[]): FamilyRun[] {
  const out = runs.map((run) => ({ ...run, text: run.text.replace(/\s+/g, ' ') }));
  for (let i = 0; i + 1 < out.length; i++)
    if (out[i].source === undefined && out[i + 1].source !== undefined)
      out[i].text = out[i].text.replace(/\s+$/, '');
  const firstText = out.findIndex((run) => run.source === undefined);
  if (firstText >= 0) out[firstText].text = out[firstText].text.replace(/^\s+/, '');
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].source !== undefined) continue;
    out[i].text = out[i].text.replace(/\s+$/, '');
    break;
  }
  return out.filter((run) => run.source !== undefined || run.text !== '');
}

/** A block's words as they are read aloud: no source chips, and a heading ends in a full stop. */
export function familyBlockText(block: FamilyStoryBlock): string {
  const text = block.runs
    .filter((run) => run.source === undefined)
    .map((run) => run.text)
    .join('')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text) return '';
  if (
    (block.type === 'h2' || block.type === 'h3' || block.type === 'li') &&
    !/[.!?:;…"”)]$/.test(text)
  )
    return `${text}.`;
  return text;
}

/* ── the cutter (port of kadeReadingRoomParse.js) ───────────────────────── */

const ABBREV =
  /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Gen|Col|Lt|Sgt|Capt|Rev|Hon|vs|etc|e\.g|i\.e|Inc|Ltd|Co|No|Vol|Ch|pp|p|a\.m|p\.m|U\.S|U\.K|Ph\.D|B\.C|A\.D)\.$/i;

function squash(s: string): string {
  return String(s)
    .replace(/[\u00ad\u200b\ufeff]/g, '')
    .replace(/[ \t\r\n\f\v\u00a0]+/g, ' ')
    .trim();
}

export function familySplitSentences(text: string): string[] {
  const out: string[] = [];
  const parts = squash(text).split(/(?<=[.!?…]["'”’)\]]?)\s+(?=["'“‘([]?[A-Z0-9])/);
  let buf = '';
  for (const p of parts) {
    buf = buf ? `${buf} ${p}` : p;
    if (ABBREV.test(buf) || /\b[A-Z]\.$/.test(buf)) continue;
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(', ', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut + (rest[cut] === ',' ? 1 : 0)).trim());
    rest = rest.slice(cut).replace(/^[,\s]+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** Paragraphs to parts of whole sentences, at most `target` characters, crossing a paragraph
 * end only for short paragraphs (the Library reader's chunkParagraphs). */
export function familyChunkParagraphs(
  paras: string[],
  target: number = FAMILY_PART_TARGET,
): string[] {
  const chunks: string[] = [];
  let buf = '';
  const push = (): void => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };
  for (const p of paras) {
    const sentences = familySplitSentences(p).flatMap((s) =>
      s.length > FAMILY_PART_MAX ? hardSplit(s, target) : [s],
    );
    if (buf && buf.length + 1 + p.length > target) push();
    for (const s of sentences) {
      if (buf && buf.length + 1 + s.length > target) push();
      buf = buf ? `${buf} ${s}` : s;
    }
    if (buf.length > target * 0.6) push();
    else buf += '\n';
  }
  push();
  return chunks.map((c) => c.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** One cue per sentence, each timed by its share of the part's characters, from 0 to `length`. */
export function familyCues(text: string, length: number = 1): FamilyCue[] {
  const sentences = familySplitSentences(text).filter(Boolean);
  const total = sentences.reduce((sum, s) => sum + s.length + 1, 0);
  if (!total) return [];
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const out: FamilyCue[] = [];
  let at = 0;
  for (const sentence of sentences) {
    const start = at;
    at += sentence.length + 1;
    out.push({
      text: sentence,
      start: round((start / total) * length),
      end: round((at / total) * length),
    });
  }
  out[out.length - 1].end = round(length);
  return out;
}

/** The story's parts for Listen, with fraction cues. */
export function familyStoryParts(blocks: FamilyStoryBlock[]): FamilyStoryPart[] {
  const paras = blocks.map(familyBlockText).filter(Boolean);
  return familyChunkParagraphs(paras).map((text, i) => ({ i, text, cues: familyCues(text) }));
}

/** The story's words, without its chips, for the reading-time estimate. */
export function familyStoryChars(blocks: FamilyStoryBlock[]): number {
  return blocks.reduce((sum, block) => sum + familyBlockText(block).length + 1, 0);
}

/* ── Listen: audio keys and WAV files ───────────────────────────────────── */

/** A hash of the story's words that stays the same across exports while the words do. */
export function familyStoryHash(markdown: string): string {
  return familyHash(familyStoryMarkdown(markdown).trim(), 20);
}

/** Where one part's audio and its note live: "<prefix>/audio/<story hash>/<part hash>". The part
 * hash covers the voice, its direction and the words, so audio that exists is never made again
 * and a changed sentence only remakes its own part. */
export function familyAudioBase(
  prefix: string,
  storyHash: string,
  voiceTag: string,
  text: string,
): string {
  return `${prefix}/audio/${storyHash}/${familyHash(`${voiceTag}\n${text}`, 20)}`;
}

export interface FamilyWavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  dataOffset: number;
  dataBytes: number;
  /** Seconds. */
  duration: number;
}

/** A RIFF WAVE file's format and length; a streamed file's missing sizes are taken from its bytes. */
export function familyWavInfo(buffer: Buffer): FamilyWavInfo | null {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  let at = 12;
  let fmt: Omit<FamilyWavInfo, 'dataOffset' | 'dataBytes' | 'duration'> | null = null;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= buffer.length) {
      fmt = {
        channels: buffer.readUInt16LE(at + 10),
        sampleRate: buffer.readUInt32LE(at + 12),
        byteRate: buffer.readUInt32LE(at + 16),
        bitsPerSample: buffer.readUInt16LE(at + 22),
      };
    }
    if (id === 'data') {
      if (!fmt || !fmt.byteRate) return null;
      const dataOffset = at + 8;
      const room = buffer.length - dataOffset;
      const dataBytes = size === 0 || size === 0xffffffff || size > room ? room : size;
      return {
        ...fmt,
        dataOffset,
        dataBytes,
        duration: Math.round((dataBytes / fmt.byteRate) * 1000) / 1000,
      };
    }
    if (size === 0xffffffff) return null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/** The same WAV with its RIFF and data sizes set from its real length (a streamed file says
 * "unknown", which some players refuse). Anything that is not a WAV comes back unchanged. */
export function familyFixWav(buffer: Buffer): Buffer {
  const info = familyWavInfo(buffer);
  if (!info) return buffer;
  const out = Buffer.from(buffer.subarray(0, info.dataOffset + info.dataBytes));
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(info.dataBytes, info.dataOffset - 4);
  return out;
}

/** The file ending for an audio type. */
export function familyAudioExtension(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  return 'wav';
}

/** Records the lookup helpers use, so a test can hand in plain maps. */
export function familySourceLookup(
  records: Record<string, { collection?: string; url?: string }>,
  memorials: Record<string, { name?: string; cemetery?: string | null; url?: string | null }>,
): FamilySourceLookup {
  return {
    record: (key) => own(records, key),
    memorial: (id) => own(memorials, id),
  };
}
