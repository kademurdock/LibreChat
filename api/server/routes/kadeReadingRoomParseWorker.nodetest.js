/* Nov 12 2026 (audit SEC-4): a book is read on a worker thread with a time limit, so a hostile
 * upload cannot stop the server, and a ZIP entry cannot inflate without end.
 * Run: node --test api/server/routes/kadeReadingRoomParseWorker.nodetest.js (no network, no database). */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { parseBookIsolated } = require('./kadeReadingRoomParseWorker');
const { parseBook } = require('./kadeReadingRoomParse');

const ENV = ['KADE_BOOK_PARSE_TIMEOUT_MS', 'KADE_BOOK_PARSE_HEAP_MB', 'KADE_BOOK_PARSE_WORKER', 'KADE_BOOK_ENTRY_MAX_MB'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const zipOf = async (files) => {
  const z = new JSZip();
  for (const [n, t] of Object.entries(files)) z.file(n, t);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};
const chapters = Array.from({ length: 6 }, (_, i) => `<level1 id="c${i}"><h1>Chapter ${i + 1}</h1>${Array.from({ length: 30 }, (_, j) => `<p>Paragraph ${j} of chapter ${i + 1}. Dr. Smith met Mr. Jones at 5 p.m. "Really?" she asked. It went on.</p>`).join('')}</level1>`).join('');
const daisy3 = () => zipOf({
  'book.opf': '<package><metadata><dc:title>Sample Book</dc:title><dc:creator>A. Writer</dc:creator></metadata></package>',
  'book.xml': `<?xml version="1.0"?><dtbook><head><meta name="dc:Title" content="T"/></head><book><bodymatter>${chapters}</bodymatter></book></dtbook>`,
});
const page = (i) => `<html><head><title>x</title></head><body><h1>Chapter ${i}</h1>${'<p>It was a dark and stormy night. The rain fell in torrents. </p>'.repeat(40)}</body></html>`;

test('a hostile DAISY head is stopped at the time limit while the main thread keeps answering', async () => {
  process.env.KADE_BOOK_PARSE_TIMEOUT_MS = '2000';
  const hostile = await zipOf({ 'ncc.html': '<meta name="dc:title" '.repeat(2000) }); // 43 KB inflated, 69 s in-process
  let ticks = 0;
  const beat = setInterval(() => { ticks += 1; }, 100);
  const t0 = Date.now();
  await assert.rejects(parseBookIsolated({ buffer: hostile, filename: 'book.zip' }), (e) => e.code === 'KADE_PARSE_TIMEOUT' && /took too long/.test(e.message));
  clearInterval(beat);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `stopped in ${ms} ms`);
  assert.ok(ticks >= 15, `main thread ticked ${ticks} times in ${ms} ms`);
});

test('the worker returns exactly what in-process parseBook returns', async () => {
  const books = [
    ['daisy3.zip', await daisy3()],
    ['book.epub', await zipOf({
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf': '<package><metadata><dc:title>Epub Book</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
      'OEBPS/a.xhtml': page(1), 'OEBPS/b.xhtml': page(2),
    })],
    ['page.html', Buffer.from(page(7))],
    ['tale.txt', Buffer.from('CHAPTER ONE\n\n' + 'The rest of the story goes on and on for many pages. Caf\u00e9 na\u00efve. '.repeat(200))],
  ];
  for (const [name, buffer] of books) {
    const direct = await parseBook(buffer, name);
    assert.ok(direct.sections.length > 1, name);
    assert.deepEqual(await parseBookIsolated({ buffer, filename: name }), direct, name);
  }
});

test('a path is read inside the worker, and a missing file is a plain sentence with no path in it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kade-parse-test-')), 'book.zip');
  const buffer = await daisy3();
  fs.writeFileSync(file, buffer);
  try {
    assert.deepEqual(await parseBookIsolated({ path: file, filename: 'book.zip' }), await parseBook(buffer, 'book.zip'));
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  await assert.rejects(parseBookIsolated({ path: file, filename: 'book.zip' }), (e) => e.code === 'KADE_PARSE_FAILED' && !e.message.includes(os.tmpdir()) && !/ENOENT/.test(e.message));
});

test('a ZIP entry that inflates past the limit is refused, in the worker and in-process', async () => {
  process.env.KADE_BOOK_ENTRY_MAX_MB = '4';
  const bomb = await zipOf({ 'book.opf': '<package></package>', 'book.xml': Buffer.alloc(24 * 1024 * 1024, 0x20) });
  assert.ok(bomb.length < 64 * 1024, `the bomb is ${bomb.length} bytes on the wire`);
  await assert.rejects(parseBookIsolated({ buffer: bomb, filename: 'bomb.zip' }), /too large to read as a book/);
  await assert.rejects(parseBook(bomb, 'bomb.zip'), /too large to read as a book/);
});

test('a read that outgrows its memory budget is stopped and the process lives', async () => {
  process.env.KADE_BOOK_PARSE_HEAP_MB = '256';
  process.env.KADE_BOOK_ENTRY_MAX_MB = '4096';
  // 20 entries of 20 MB each: every one is under the entry limit, together they are 400 MB of text.
  const files = { 'META-INF/container.xml': '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>' };
  const big = Buffer.from(`<html><body>${'<p>word word word word word word word word word.</p>'.repeat(400000)}</body></html>`);
  let manifest = '';
  let spine = '';
  for (let i = 0; i < 20; i++) { files[`p${i}.xhtml`] = big; manifest += `<item id="i${i}" href="p${i}.xhtml" media-type="application/xhtml+xml"/>`; spine += `<itemref idref="i${i}"/>`; }
  files['c.opf'] = `<package><metadata><dc:title>Big</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
  await assert.rejects(parseBookIsolated({ buffer: await zipOf(files), filename: 'big.epub' }), (e) => e.code === 'KADE_PARSE_MEMORY');
});

test('KADE_BOOK_PARSE_WORKER=0 reads in-process as before', async () => {
  process.env.KADE_BOOK_PARSE_WORKER = '0';
  const buffer = Buffer.from(page(3));
  assert.deepEqual(await parseBookIsolated({ buffer, filename: 'page.html' }), await parseBook(buffer, 'page.html'));
});
