import yauzl from 'yauzl';
import { Readable } from 'node:stream';
import { parseDaisyPublication } from './daisy';
import type { DaisyPublication } from './daisy';

export const AUDIO_ZIP_LIMIT: number = 4 * 1024 ** 3;
export const TEXT_IMPORT_LIMIT: number = 256 * 1024 ** 2;
const EXPANDED_LIMIT = 8 * 1024 ** 3;
const AUDIO = /\.(mp3|m4a|m4b|aac|wav|ogg|oga|opus|flac|aiff|aif|wma)$/i;

export interface AudioArchive {
  publication: DaisyPublication;
  bytes: (name: string) => number;
  stream: (name: string) => Promise<Readable>;
  close: () => void;
}

/** Index on disk; read only bounded navigation text, and stream recordings. */
export async function openAudioArchive(path: string): Promise<AudioArchive | null> {
  const zip = await new Promise<yauzl.ZipFile>((accept, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, value) => {
      if (error || !value) { reject(error || new Error('The ZIP could not be opened.')); return; }
      accept(value);
    });
  });
  // Keep asynchronous descriptor errors handled after directory enumeration too.
  let zipError: Error | undefined;
  zip.on('error', (error: Error) => { zipError = error; });
  try {
    const entries = new Map<string, yauzl.Entry>();
    await new Promise<void>((accept, reject) => {
      let count = 0, expanded = 0;
      zip.once('error', reject);
      zip.once('end', () => { zip.removeListener('error', reject); accept(); });
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          if (++count > 20000) throw new Error('This ZIP contains too many files.');
          if (entry.generalPurposeBitFlag & 1) throw new Error('Password-protected ZIPs cannot be imported.');
          expanded += entry.uncompressedSize;
          if (expanded > EXPANDED_LIMIT) throw new Error('The expanded audiobook exceeds 8 GB.');
          if (/\/$/.test(entry.fileName) || /(^|\/)__MACOSX\/|(^|\/)\._/.test(entry.fileName)) { zip.readEntry(); return; }
          if (entries.has(entry.fileName)) throw new Error('The ZIP has duplicate file names.');
          entries.set(entry.fileName, entry);
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    const stream = (name: string): Promise<Readable> => new Promise((accept, reject) => {
      const entry = entries.get(name);
      if (zipError) { reject(zipError); return; }
      if (!entry) { reject(new Error(`A file is missing from the ZIP: ${name.slice(0, 100)}`)); return; }
      zip.openReadStream(entry, (error, value) => {
        if (error || !value) { reject(error || new Error('The recording could not be read.')); return; }
        const wrapped = new Readable().wrap(value);
        wrapped.once('close', () => value.destroy());
        accept(wrapped);
      });
    });
    let metadataBytes = 0;
    const read = async (name: string): Promise<string> => {
      if ((entries.get(name)?.uncompressedSize || 0) > 8 * 1024 ** 2) throw new Error('The audiobook navigation file is too large.');
      const source = await stream(name);
      const parts: Buffer[] = [];
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        metadataBytes += buffer.length;
        if (metadataBytes > 32 * 1024 ** 2) { source.destroy(); throw new Error('The audiobook navigation is too large.'); }
        parts.push(buffer);
      }
      return Buffer.concat(parts).toString('utf8');
    };
    const names = [...entries.keys()];
    let publication = await parseDaisyPublication(names, read);
    if (!publication) {
      const audio = names.filter((name) => AUDIO.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      if (!audio.length) {
        if (names.some((name) => /\.(aa|aax|aaxc)$/i.test(name))) throw new Error('This ZIP contains Audible AA/AAX recordings, which the library cannot play. Import an MP3 or M4B edition instead.');
        zip.close();
        return null;
      }
      if (audio.length > 5000) throw new Error('This audiobook has too many recordings.');
      publication = { title: '', author: '', format: 'audio-zip', clips: audio.map((name) => ({ path: name, title: name.split('/').pop()!.replace(/\.[^.]+$/, ''), clipBegin: 0 })) };
    }
    for (const clip of publication.clips) {
      if ((entries.get(clip.path)?.uncompressedSize || 0) > AUDIO_ZIP_LIMIT) throw new Error('One expanded recording exceeds 4 GB. Split it into parts.');
    }
    return { publication, stream, bytes: (name) => entries.get(name)?.uncompressedSize || 0, close: () => zip.close() };
  } catch (error) { zip.close(); throw error; }
}
