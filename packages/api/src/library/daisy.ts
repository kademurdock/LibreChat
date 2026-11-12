import JSZip from 'jszip';
import { Readable } from 'node:stream';

export type DaisyClip = { path: string; title: string; clipBegin: number; clipEnd?: number };
export type DaisyAudio = { title: string; author: string; format: string; clips: DaisyClip[]; zip: JSZip };

export function readDaisyFile(zip: JSZip, path: string, limit: number = 128 * 1024 * 1024): Promise<Buffer> {
  const file = zip.file(path);
  if (!file) return Promise.reject(new Error('A DAISY file is missing.'));
  return new Promise((accept, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    const stream = new Readable().wrap(file.nodeStream());
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { reject(new Error('An expanded DAISY file is too large.')); stream.destroy(); return; }
      parts.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => accept(Buffer.concat(parts)));
  });
}

/* Audit fix SEC-4 (Nov 12 2026): the DAISY reader runs on the main thread, and its old regexes
 * ([^>]* after '<', lazy [\s\S]*? up to a closing tag, tried again from every '<') took seconds to
 * minutes on hostile markup (4.7 s for a 200 KB ncc of bare <a, 14.4 s for the SMIL tag scan). Every
 * read below is linear: one forward pass with indexOf, stopping at the first '<' that has no '>'
 * after it, and an attribute read that gives up on a quote kind once it has no closing quote. The
 * answers are the same as the old regexes on well-formed books (daisy.selftest.ts, archive.selftest.ts). */
type Tag = { name: string; local: string; close: boolean; raw: string; start: number; end: number };

/* A tag name: letters, digits, '_', ':', '.', '-' (the old regexes' [\w:-] plus '.'). */
const NAME_CHAR = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c === 46 || c === 45;

/** Every tag in order. A '<' with no '>' after it ends the scan (no later tag can close either). */
function tagsOf(src: string): Tag[] {
  const out: Tag[] = [];
  let i = 0;
  for (;;) {
    let lt = src.indexOf('<', i);
    if (lt < 0) break;
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) break;
    /* "<<item ...>": the tag is the last '<' before its '>', as the old regex read it. */
    const inner = src.lastIndexOf('<', gt);
    if (inner > lt) lt = inner;
    let k = lt + 1;
    const close = src.charCodeAt(k) === 47; // '/'
    if (close) k++;
    const from = k;
    while (k < gt && NAME_CHAR(src.charCodeAt(k))) k++;
    const name = from === k ? '' : src.slice(from, k).toLowerCase();
    out.push({ name, local: name.slice(name.lastIndexOf(':') + 1), close, raw: src.slice(lt, gt + 1), start: lt, end: gt + 1 });
    i = gt + 1;
  }
  return out;
}

/** The first `name` element's inner text, or ''. `names` are lower-case tag names it may carry. */
function firstElementText(src: string, tags: Tag[], names: string[]): string {
  for (let k = 0; k < tags.length; k++) {
    const open = tags[k];
    if (open.close || !names.includes(open.name)) continue;
    for (let j = k + 1; j < tags.length; j++) {
      if (tags[j].close && names.includes(tags[j].name)) return src.slice(open.end, tags[j].start);
    }
    return ''; // no closing tag after this one, so none after any later one either
  }
  return '';
}

const WORD = /[A-Za-z0-9_]/;

/** The next "<name ...>" at or after `from` in a lower-cased text, as /<name\b[^>]*>/ finds it:
 * { at, gt } (gt is the index of its '>'), or null when there is none. indexOf only. */
function nextOpen(low: string, name: string, from: number): { at: number; gt: number } | null {
  const head = '<' + name;
  let at = low.indexOf(head, from);
  while (at >= 0 && at + head.length < low.length && WORD.test(low[at + head.length])) at = low.indexOf(head, at + head.length);
  if (at < 0) return null;
  const gt = low.indexOf('>', at + head.length);
  return gt < 0 ? null : { at, gt };
}

/** Markup taken out, the five entities read. Same answer as replace(/<[^>]*>/g, ''), in one pass. */
function stripTags(value: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = value.indexOf('<', i);
    if (lt < 0) return out + value.slice(i);
    const gt = value.indexOf('>', lt + 1);
    if (gt < 0) return out + value.slice(i);
    out += value.slice(i, lt);
    i = gt + 1;
  }
}
function text(value: string): string {
  return stripTags(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
/** An attribute's value, as /\bname\s*=\s*(["'])([\s\S]*?)\1/i read it, in linear time. */
function attr(tag: string, name: string): string {
  const low = tag.toLowerCase();
  const want = name.toLowerCase();
  const dead = new Set<string>();
  let from = 0;
  for (;;) {
    const at = low.indexOf(want, from);
    if (at < 0) return '';
    from = at + 1;
    if (at > 0 && WORD.test(tag[at - 1])) continue;
    let k = at + want.length;
    while (k < tag.length && /\s/.test(tag[k])) k++;
    if (tag[k] !== '=') continue;
    k++;
    while (k < tag.length && /\s/.test(tag[k])) k++;
    const quote = tag[k];
    if (quote !== '"' && quote !== "'") continue;
    if (dead.has(quote)) continue;
    const endQuote = tag.indexOf(quote, k + 1);
    if (endQuote < 0) { dead.add(quote); continue; }
    return text(tag.slice(k + 1, endQuote));
  }
}
export function daisyClock(value: string): number {
  const v = value.replace(/^npt=/i, '').trim();
  if (!v) return 0;
  if (/^\d+(?:\.\d+)?ms$/.test(v)) return parseFloat(v) / 1000;
  if (/^\d+(?:\.\d+)?(?:s|min|h)?$/.test(v)) {
    return parseFloat(v) * (v.endsWith('min') ? 60 : v.endsWith('h') ? 3600 : 1);
  }
  if (/^\d+:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(v)) return v.split(':').reduce((n, p) => n * 60 + Number(p), 0);
  throw new Error('This DAISY book contains an invalid audio time.');
}
function resolve(base: string, reference: string): string {
  const decoded = decodeURIComponent(reference.split('#')[0]);
  if (/^[a-z][a-z\d+.-]*:|^[\\/]/i.test(decoded) || decoded.includes('\\')) throw new Error('DAISY audio must be included in the ZIP.');
  const parts = base.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') { if (!parts.length) throw new Error('Invalid DAISY file path.'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** Read the publication's SMIL sequence, never alphabetical MP3 order. */
export async function parseDaisyAudio(buffer: Buffer): Promise<DaisyAudio | null> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const publication = await parseDaisyPublication(names, async (path) => (await readDaisyFile(zip, path, 8 * 1024 * 1024)).toString('utf8'));
  return publication ? { ...publication, zip } : null;
}

export type DaisyPublication = { title: string; author: string; format: string; clips: DaisyClip[] };

/** Shared navigation reader for disk-backed and in-memory ZIPs. */
export async function parseDaisyPublication(names: string[], read: (path: string) => Promise<string>): Promise<DaisyPublication | null> {
  if (names.length > 20000) throw new Error('This ZIP contains too many files.');
  if (!names.some((n) => /\.(mp3|mp4|m4a|wav|ogg|aac)$/i.test(n))) return null;
  const opfPath = names.find((n) => /\.opf$/i.test(n));
  const nccPath = names.find((n) => /(^|\/)ncc\.html?$/i.test(n));
  if (!opfPath && !nccPath) return null;
  const doc = await read(opfPath || nccPath || '');
  let docTagsRead: Tag[] | null = null;
  const docTags = (): Tag[] => (docTagsRead = docTagsRead || tagsOf(doc)); // an ncc needs them only for its title
  const dc = (name: string): string => text(firstElementText(doc, docTags(), [name, `dc:${name}`])) ||
    docTags().filter((t) => !t.close && t.name === 'meta' && attr(t.raw, 'name').toLowerCase() === `dc:${name}`).map((t) => attr(t.raw, 'content'))[0] || '';
  const order: string[] = [];
  const labels = new Map<string, string>();
  if (opfPath) {
    const manifest = new Map<string, string>();
    for (const t of docTags()) if (!t.close && t.name === 'item') manifest.set(attr(t.raw, 'id'), resolve(opfPath, attr(t.raw, 'href')));
    for (const t of docTags()) {
      if (t.close || t.name !== 'itemref') continue;
      const path = manifest.get(attr(t.raw, 'idref'));
      if (path && /\.smil$/i.test(path) && !order.includes(path)) order.push(path);
    }
    const ncx = names.find((n) => /\.ncx$/i.test(n));
    if (ncx) {
      const navigation = await read(ncx);
      /* navLabel, then its <text>...</text>, then the next <content>, as
       * /<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)>/gi read it:
       * one forward pointer, indexOf only. Any missing piece ends the read. */
      const lowNav = navigation.toLowerCase();
      let from = 0;
      for (;;) {
        const label = nextOpen(lowNav, 'navlabel', from);
        const open = label && nextOpen(lowNav, 'text', label.gt + 1);
        const shut = open ? lowNav.indexOf('</text>', open.gt + 1) : -1;
        const content = shut >= 0 ? nextOpen(lowNav, 'content', shut + 7) : null;
        if (!open || !content) break;
        from = content.gt + 1;
        const src = attr(navigation.slice(content.at, content.gt + 1), 'src');
        if (src) labels.set(resolve(ncx, src) + (src.includes('#') ? '#' + src.split('#')[1] : ''), text(navigation.slice(open.gt + 1, shut)));
      }
    }
  } else if (nccPath) {
    /* <a ...>label</a>, as /<a\b([^>]*)>([\s\S]*?)<\/a>/gi read it, with indexOf only: an ncc can hold
     * hundreds of thousands of anchors, and a scan that builds every tag was too slow for one. */
    const low = doc.toLowerCase();
    let from = 0;
    for (;;) {
      const a = nextOpen(low, 'a', from);
      const shut = a ? low.indexOf('</a>', a.gt + 1) : -1;
      if (!a || shut < 0) break;
      const body = doc.slice(a.gt + 1, shut);
      from = shut + 4;
      const href = attr(doc.slice(a.at, a.gt + 1), 'href');
      if (!href) continue;
      const path = resolve(nccPath, href);
      if (!/\.smil$/i.test(path)) continue;
      if (!order.includes(path)) order.push(path);
      labels.set(path + (href.includes('#') ? '#' + href.split('#')[1] : ''), text(body));
    }
  }
  if (!order.length) return null;
  const clips: DaisyClip[] = [];
  for (const path of order) {
    const smil = await read(path);
    let title = labels.get(path) || `Chapter ${order.indexOf(path) + 1}`;
    for (const tag of tagsOf(smil)) {
      if (tag.close || !tag.local) continue;
      const id = attr(tag.raw, 'id');
      const label = id && labels.get(path + '#' + id);
      if (label) title = label;
      if (tag.local !== 'audio') continue;
      const src = attr(tag.raw, 'src');
      const audioPath = resolve(path, src);
      if (!names.includes(audioPath)) throw new Error(`Missing DAISY audio: ${audioPath.slice(0, 100)}`);
      if (!/\.(mp3|mp4|m4a|wav|ogg|aac)$/i.test(audioPath)) throw new Error('This DAISY audio format is not supported.');
      const begin = daisyClock(attr(tag.raw, 'clip-begin') || attr(tag.raw, 'clipBegin'));
      const endValue = attr(tag.raw, 'clip-end') || attr(tag.raw, 'clipEnd');
      const end = endValue ? daisyClock(endValue) : undefined;
      if (end !== undefined && end <= begin) throw new Error('A DAISY audio segment ends before it starts.');
      const previous = clips[clips.length - 1];
      if (previous && previous.path === audioPath && previous.title === title && previous.clipEnd === begin) previous.clipEnd = end;
      else clips.push({ path: audioPath, title, clipBegin: begin, clipEnd: end });
      if (clips.length > 5000) throw new Error('This DAISY book has too many audio sections.');
    }
  }
  if (!clips.length) return null;
  return { title: dc('title'), author: dc('creator'), format: opfPath ? 'daisy3-audio' : 'daisy2-audio', clips };
}
