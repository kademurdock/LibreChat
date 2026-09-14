import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseDaisyAudio, daisyClock, readDaisyFile } from './daisy';
import { libraryPath, libraryCategory } from './shelves';
import { commercialPath } from './commercials';
import { correctedBookShelf } from './books';

async function main() {
  assert.equal(commercialPath('Video/Commercials/Other Commercials/1980s', 'Unisom 1988 commercial'), 'Video/Commercials/Medicine & Pharmacy/1980s');
  assert.equal(commercialPath('Video/Commercials/Other Commercials', 'Unisom and Eggo compilation'), null);
  assert.equal(commercialPath('Video/Commercials/Hand sorted', 'Unisom'), null);
  assert.equal(commercialPath('Video/Commercials/Other Commercials', 'Unisomatic'), null);
  assert.equal(correctedBookShelf('Chicken Soup for the Teenage Soul', ''), 'Nonfiction — Inspirational stories');
  assert.equal(daisyClock('npt=01:02:03.5'), 3723.5);
  assert.equal(daisyClock('1500ms'), 1.5);
  assert.throws(() => daisyClock('-3'));
  const zip = new JSZip();
  zip.file('book/ncc.html', `<html><head><meta content="My book" name="dc:title"></head><body><h1><a href="z.smil#start">First chapter</a></h1><h1><a href="a.smil#next">Second chapter</a></h1></body></html>`);
  zip.file('book/z.smil', `<smil><par id="start"><audio src="audio.mp3" clip-begin="npt=2s" clip-end="4s"/></par><par><audio src="audio.mp3" clip-begin="4s" clip-end="5s"/></par></smil>`);
  zip.file('book/a.smil', `<smil><par id="next"><audio src="audio.mp3" clip-begin="5s" clip-end="8s"/></par></smil>`);
  zip.file('book/audio.mp3', Buffer.from('synthetic audio bytes'));
  let result = await parseDaisyAudio(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result?.title, 'My book');
  assert.deepEqual(result?.clips.map((c) => [c.title, c.clipBegin, c.clipEnd]), [['First chapter', 2, 5], ['Second chapter', 5, 8]]);
  await assert.rejects(readDaisyFile(zip, 'book/audio.mp3', 5), /too large/);
  zip.file('book/book.opf', `<package><metadata><dc:title>Audio three</dc:title><dc:creator>Narrator</dc:creator></metadata><manifest><item id="b" href="a.smil"/><item id="a" href="z.smil"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`);
  zip.file('book/nav.ncx', `<ncx><navPoint><navLabel><text>Opening</text></navLabel><content src="z.smil#start"/></navPoint><navPoint><navLabel><text>Closing</text></navLabel><content src="a.smil#next"/></navPoint></ncx>`);
  result = await parseDaisyAudio(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result?.format, 'daisy3-audio');
  assert.deepEqual(result?.clips.map((c) => c.title), ['Opening', 'Closing']);
  zip.file('book/a.smil', '<smil><audio src="https://example.org/audio.mp3"/></smil>');
  await assert.rejects(parseDaisyAudio(await zip.generateAsync({ type: 'nodebuffer' })), /included in the ZIP/);
  zip.file('book/a.smil', '<smil><audio src="missing.mp3"/></smil>');
  await assert.rejects(parseDaisyAudio(await zip.generateAsync({ type: 'nodebuffer' })), /Missing DAISY audio/);
  const textZip = new JSZip(); textZip.file('book.opf', '<package/>');
  assert.equal(await parseDaisyAudio(await textZip.generateAsync({ type: 'nodebuffer' })), null);
  const items = [
    { kind: 'video', path: 'Video/Commercials/Medicine/1980s', category: 'commercials' },
    { kind: 'audio', path: 'Video/Radio/1990s', category: 'radio' },
    { kind: 'text', path: 'Books/Fiction â€” Fantasy', category: 'book' },
    { kind: 'audio', path: '', category: 'audiobook' },
    { kind: 'video', path: '', category: 'other' },
    { kind: 'text', category: 'book' },
  ];
  assert.equal(libraryPath(items[0]), 'Videos/Commercials/Medicine/1980s');
  assert.equal(libraryPath(items[1]), 'Audio/Radio/1990s');
  assert.equal(libraryCategory({ kind: 'video', category: 'audiobook' }), 'other');
  console.log('DAISY navigation, clip clocks, bounded reads, missing/external media, text fallback and virtual shelves passed.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
