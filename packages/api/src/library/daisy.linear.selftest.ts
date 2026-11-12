/* Audit SEC-4 (Nov 12 2026): the DAISY reader runs on the main thread, so hostile markup must be
 * read in linear time. Before the fix a 200 KB ncc of bare "<a" took 4.7 s and the SMIL tag scan
 * 14.4 s; these inputs are 8 MB and must each finish in well under a second.
 * Run: npx tsx packages/api/src/library/daisy.linear.selftest.ts */
import assert from 'node:assert/strict';
import { parseDaisyPublication } from './daisy';

const MB = 1024 * 1024;
const big = (piece: string) => piece.repeat(Math.ceil((8 * MB) / piece.length));

async function timed(label: string, files: Record<string, string>): Promise<unknown> {
  const names = [...Object.keys(files), 'x.mp3'];
  const t0 = Date.now();
  const out = await parseDaisyPublication(names, async (path) => files[path] ?? '').catch((e: Error) => e);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `${label} took ${ms} ms`);
  return out;
}

async function main() {
  // DAISY 2: an ncc of "<a" with no '>' anywhere, and one of open anchors that never close.
  assert.equal(await timed('ncc bare <a', { 'ncc.html': big('<a ') }), null);
  assert.equal(await timed('ncc open anchors', { 'ncc.html': big('<a href="x.smil">') }), null);
  // The title read: "<dc:title " with no '>' (2.2 s at 200 KB before) and opens with no close.
  assert.equal(await timed('opf title head', { 'book.opf': big('<dc:title ') }), null);
  assert.equal(await timed('meta head', { 'ncc.html': big('<meta name="dc:title" ') }), null);
  // An attribute value that never closes its quote, inside one huge tag.
  assert.equal(await timed('open quote', { 'ncc.html': '<a ' + big('href="x ') + '>t</a>' }), null);
  // DAISY 3: a navigation file of labels with no content tag, and a SMIL of tags with no '>'.
  const opf = '<package><metadata><dc:title>T</dc:title></metadata><manifest><item id="s" href="s.smil"/></manifest><spine><itemref idref="s"/></spine></package>';
  assert.equal(await timed('ncx labels', { 'book.opf': opf, 'nav.ncx': big('<navLabel><text>x</text>'), 's.smil': '<smil></smil>' }), null);
  assert.equal(await timed('smil heads', { 'book.opf': opf, 's.smil': big('<audio src="x.mp3" ') }), null);
  // A well-formed book still reads the same way.
  const ok = await timed('normal book', {
    'ncc.html': '<html><head><meta content="My book" name="dc:title"></head><body><h1><a href="z.smil#start">First</a></h1></body></html>',
    'z.smil': '<smil><par id="start"><audio src="x.mp3" clip-begin="npt=2s" clip-end="4s"/></par></smil>',
  }) as { title: string; clips: Array<{ title: string; clipBegin: number; clipEnd?: number }> };
  assert.equal(ok.title, 'My book');
  assert.deepEqual(ok.clips.map((c) => [c.title, c.clipBegin, c.clipEnd]), [['First', 2, 4]]);
  console.log('DAISY reader: 8 MB hostile ncc, opf, ncx and SMIL inputs each read in under a second; a normal book unchanged.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
