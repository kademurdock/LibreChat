import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openAudioArchive } from './archive';

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-archive-test-'));
  const file = path.join(dir, 'book.zip');
  const write = async (zip: JSZip): Promise<void> => { await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' })); };
  try {
    let zip = new JSZip();
    zip.file('Chaos Raining/Part 10.mp3', Buffer.from('tenth recording'));
    zip.file('Chaos Raining/Part 2.mp3', Buffer.from('second recording'));
    zip.file('__MACOSX/._Part 1.mp3', 'metadata');
    zip.file('cover.jpg', 'jacket');
    await write(zip);
    console.log('Checking MP3 archive');
    let archive = await openAudioArchive(file);
    console.log('Directory indexed');
    assert(archive);
    assert.equal(archive.publication.format, 'audio-zip');
    assert.deepEqual(archive.publication.clips.map((clip) => clip.title), ['Part 2', 'Part 10']);
    const parts: Buffer[] = [];
    const audioStream = await archive.stream('Chaos Raining/Part 2.mp3');
    console.log('Audio stream opened');
    for await (const chunk of audioStream) parts.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(parts).toString(), 'second recording');
    archive.close();
    console.log('Checking M4B and DAISY archives');
    zip = new JSZip(); zip.file('one.m4b', 'm4b'); await write(zip);
    archive = await openAudioArchive(file); assert.equal(archive?.publication.clips.length, 1); archive?.close();
    zip = new JSZip(); zip.file('ncc.html', '<meta name="dc:title" content="A DAISY"><a href="b.smil">First</a><a href="a.smil">Second</a>');
    zip.file('b.smil', '<audio src="voice.mp3" clip-begin="1s" clip-end="2s"/>');
    zip.file('a.smil', '<audio src="voice.mp3" clip-begin="2s" clip-end="3s"/>');
    zip.file('voice.mp3', 'audio'); await write(zip);
    archive = await openAudioArchive(file); assert(archive);
    assert.equal(archive.publication.title, 'A DAISY');
    assert.deepEqual(archive.publication.clips.map((c) => [c.title,c.clipBegin,c.clipEnd]), [['First',1,2],['Second',2,3]]);
    archive.close();
    console.log('Checking invalid archives');
    zip = new JSZip(); zip.file('book.txt', 'a text book'); await write(zip); assert.equal(await openAudioArchive(file), null);
    zip = new JSZip(); zip.file('book.aax', 'audio'); await write(zip); await assert.rejects(openAudioArchive(file), /cannot play/);
    await fs.writeFile(file, 'broken zip'); await assert.rejects(openAudioArchive(file));
    // A directory-declared oversized file is rejected before any extraction.
    zip = new JSZip(); zip.file('huge.mp3','x');
    const oversized = await zip.generateAsync({ type: 'nodebuffer' });
    const central = oversized.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    oversized.writeUInt32LE(0xffffffff, central+24);
    await fs.writeFile(file, oversized); await assert.rejects(openAudioArchive(file));
    console.log('MP3/M4B ZIPs, numeric ordering, hidden metadata, DAISY order, text fallback, unsupported/corrupt/oversized ZIPs passed.');
  } finally { await fs.rm(dir, { recursive:true,force:true }); }
}
const deadline = setTimeout(() => { console.error('Archive test did not settle'); process.exit(1); }, 10000);
main().catch((error) => { console.error(error); process.exitCode=1; }).finally(() => clearTimeout(deadline));
