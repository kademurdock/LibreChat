import JSZip from 'jszip';
import { Readable } from 'node:stream';

export type DaisyClip = { path: string; title: string; clipBegin: number; clipEnd?: number };
export type DaisyAudio = { title: string; author: string; format: string; clips: DaisyClip[]; zip: JSZip };

export function readDaisyFile(zip: JSZip, path: string, limit = 128 * 1024 * 1024): Promise<Buffer> {
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

function text(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? text(match[2]) : '';
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
  if (names.length > 20000) throw new Error('This ZIP contains too many files.');
  if (!names.some((n) => /\.(mp3|mp4|m4a|wav|ogg|aac)$/i.test(n))) return null;
  const opfPath = names.find((n) => /\.opf$/i.test(n));
  const nccPath = names.find((n) => /(^|\/)ncc\.html?$/i.test(n));
  if (!opfPath && !nccPath) return null;
  const read = async (path: string): Promise<string> => {
    const file = zip.file(path);
    if (!file) throw new Error(`A file is missing from the DAISY ZIP: ${path.slice(0, 100)}`);
    return (await readDaisyFile(zip, path, 8 * 1024 * 1024)).toString('utf8');
  };
  const doc = await read(opfPath || nccPath || '');
  const dc = (name: string): string => text(doc.match(new RegExp(`<(?:dc:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${name}>`, 'i'))?.[1] || '') ||
    [...doc.matchAll(/<meta\b[^>]*>/gi)].filter((m) => attr(m[0], 'name').toLowerCase() === `dc:${name}`).map((m) => attr(m[0], 'content'))[0] || '';
  const order: string[] = [];
  const labels = new Map<string, string>();
  if (opfPath) {
    const manifest = new Map<string, string>();
    for (const m of doc.matchAll(/<item\b[^>]*>/gi)) manifest.set(attr(m[0], 'id'), resolve(opfPath, attr(m[0], 'href')));
    for (const m of doc.matchAll(/<itemref\b[^>]*>/gi)) {
      const path = manifest.get(attr(m[0], 'idref'));
      if (path && /\.smil$/i.test(path) && !order.includes(path)) order.push(path);
    }
    const ncx = names.find((n) => /\.ncx$/i.test(n));
    if (ncx) {
      const navigation = await read(ncx);
      for (const m of navigation.matchAll(/<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)>/gi)) {
        const src = attr(m[2], 'src');
        if (src) labels.set(resolve(ncx, src) + (src.includes('#') ? '#' + src.split('#')[1] : ''), text(m[1]));
      }
    }
  } else if (nccPath) {
    for (const m of doc.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attr(m[1], 'href');
      if (!href) continue;
      const path = resolve(nccPath, href);
      if (!/\.smil$/i.test(path)) continue;
      if (!order.includes(path)) order.push(path);
      labels.set(path + (href.includes('#') ? '#' + href.split('#')[1] : ''), text(m[2]));
    }
  }
  if (!order.length) return null;
  const clips: DaisyClip[] = [];
  for (const path of order) {
    const smil = await read(path);
    let title = labels.get(path) || `Chapter ${order.indexOf(path) + 1}`;
    for (const m of smil.matchAll(/<(?:[\w-]+:)?([\w-]+)\b[^>]*>/g)) {
      const id = attr(m[0], 'id');
      const label = id && labels.get(path + '#' + id);
      if (label) title = label;
      if (m[1].toLowerCase() !== 'audio') continue;
      const src = attr(m[0], 'src');
      const audioPath = resolve(path, src);
      if (!zip.file(audioPath)) throw new Error(`Missing DAISY audio: ${audioPath.slice(0, 100)}`);
      if (!/\.(mp3|mp4|m4a|wav|ogg|aac)$/i.test(audioPath)) throw new Error('This DAISY audio format is not supported.');
      const begin = daisyClock(attr(m[0], 'clip-begin') || attr(m[0], 'clipBegin'));
      const endValue = attr(m[0], 'clip-end') || attr(m[0], 'clipEnd');
      const end = endValue ? daisyClock(endValue) : undefined;
      if (end !== undefined && end <= begin) throw new Error('A DAISY audio segment ends before it starts.');
      const previous = clips[clips.length - 1];
      if (previous && previous.path === audioPath && previous.title === title && previous.clipEnd === begin) previous.clipEnd = end;
      else clips.push({ path: audioPath, title, clipBegin: begin, clipEnd: end });
      if (clips.length > 5000) throw new Error('This DAISY book has too many audio sections.');
    }
  }
  if (!clips.length) return null;
  return { title: dc('title'), author: dc('creator'), format: opfPath ? 'daisy3-audio' : 'daisy2-audio', clips, zip };
}
