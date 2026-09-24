'use strict';
/* Part 181 (Sep 11 2026). The Reading Room's parser, proven on the shapes
 * that five real Bookshare DAISY downloads showed on the day it was written:
 * the notice is one <level1 id="bookshare_note"> ending in BEGIN CONTENT;
 * chapters may live in <frontmatter>; some books have no headings at all.
 * Run: node --test kadeReadingRoomParse.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { walkMarkup, chunkParagraphs, splitSentences, classify, buildJacket, readOpfMeta, listenEstimate, parseBook, CHUNK_TARGET } = require('./kadeReadingRoomParse');

const NOTICE = `<level1 id="bookshare_note"><h1>NOTICE</h1><p>This accessible media has been made available to people with bona fide disabilities that affect reading.</p>
<level2><h2>Copyright Notice</h2><p>Bookshare distributes this accessible media under restrictions.</p></level2>
<level2><h2>Permitted Use</h2><p>This material was downloaded by Kade Murdock and is digitally fingerprinted.</p></level2>
<p>BEGIN CONTENT</p></level1>`;

function dtbook(body) {
  return `<?xml version="1.0"?><dtbook xmlns="http://www.daisy.org/z3986/2005/dtbook/"><head><meta name="dc:Title" content="T"/></head><book>${body}</book></dtbook>`;
}

test('page markers disappear mid-sentence across DAISY and EPUB without deleting story numbers', () => {
  for (const marker of ['<pagenum>22</pagenum>', '<span class="page-normal"><a>22</a></span>',
    '<span class="page-front">xxii</span>', '<span epub:type="pagebreak">22</span>',
    '<span role="doc-pagebreak"><span>22</span></span>', '<span class="page-number">22</span>']) {
    const sections = walkMarkup('<h1>Story</h1><p>I was going to tell her, but I '+marker+' stopped and stared. She was 24 and paid $22.</p>', []);
    assert.equal(sections.at(-1).paras.join(' '), 'I was going to tell her, but I stopped and stared. She was 24 and paid $22.');
  }
});

test('HTML metadata and nested skipped tags do not swallow the book body', () => {
 const sections = walkMarkup('<html><head><meta name="title" content="Book"><title>Hidden</title></head><body><h1>Story</h1><p>Un\u00adbroken words. <span role="doc-pagebreak"><pagenum>24</pagenum></span> Still reading.</p></body></html>', []);
 assert.equal(sections.at(-1).paras.join(' '), 'Unbroken words. Still reading.');
});

test('the Bookshare notice is skipped whole, and the name in it never reaches a chunk', async () => {
  const xml = dtbook(`<frontmatter><doctitle>Sample</doctitle>${NOTICE}<level1 class="cover"><p><img src="c.jpg"/></p></level1></frontmatter>
  <bodymatter><level1><h1>Chapter 1</h1><p>It was a bright cold day in April, and the clocks were striking thirteen.</p><pagenum>1</pagenum><p>Winston Smith slipped quickly through the glass doors.</p></level1></bodymatter>`);
  const sections = walkMarkup(xml, []);
  const { kept, skipped } = classify(sections);
  assert.ok(skipped.every((s) => s.reason === 'bookshare-notice'), 'only the notice was skipped: ' + skipped.map((s) => s.reason));
  assert.ok(skipped.length >= 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'Chapter 1');
  const text = kept.map((s) => s.paras.join(' ')).join(' ');
  assert.ok(!/Kade Murdock/.test(text));
  assert.ok(!/BEGIN CONTENT/.test(text));
  assert.ok(!/\b1\b/.test(kept[0].paras.join(' ')), 'page numbers are not read');
});

test('chapters inside <frontmatter> are kept (All the Light We Cannot See shape)', () => {
  const xml = dtbook(`<frontmatter>${NOTICE}<level1 id="part00"><h1>Zero</h1></level1><level1 id="part00-ch01"><h1>Leaflets</h1><p>At dusk they pour from the sky. They blow across the ramparts, turn cartwheels over rooftops, flutter into the ravines between houses.</p></level1></frontmatter><bodymatter><level1><h1>One</h1><p>Marie-Laure lives with her father in Paris.</p></level1></bodymatter>`);
  const { kept } = classify(walkMarkup(xml, []));
  assert.deepEqual(kept.map((s) => s.title), ['Zero', 'Leaflets', 'One']);
});

test('copyright page, contents list and publisher sign-up page are skipped; dedication is kept', () => {
  const xml = dtbook(`<frontmatter>${NOTICE}
  <level1 class="copyright"><p>Copyright © 2014 by Someone. All rights reserved. ISBN 978-1-4767-4658-6. Printed in the United States.</p></level1>
  <level1><p>Thank you for downloading this Scribner eBook. Join our mailing list and get updates. CLICK HERE TO SIGN UP</p></level1>
  <level1><p>For Wendy Weil 1940-2012</p></level1>
  <level1 class="toc"><h1>Contents</h1><p>Chapter 1</p><p>Chapter 2</p></level1>
  </frontmatter><bodymatter><level1><h1>Chapter 1</h1><p>${'A long chapter sentence that goes on for a while. '.repeat(60)}</p></level1></bodymatter>`);
  const { kept, skipped } = classify(walkMarkup(xml, []));
  const reasons = skipped.map((s) => s.reason);
  assert.ok(reasons.includes('copyright'), reasons.join());
  assert.ok(reasons.includes('contents'), reasons.join());
  assert.ok(reasons.includes('publisher'), reasons.join());
  assert.ok(kept.some((s) => s.paras.join(' ').includes('For Wendy Weil')), 'the dedication stays');
  assert.equal(kept[kept.length - 1].title, 'Chapter 1');
});

test('chapters carried in paragraph classes (the Narnia omnibus shape) become real sections, and the contents list is skipped', async () => {
  const body = `<frontmatter>${NOTICE}</frontmatter><bodymatter><level1 class="chapter" id="Contents"><h1>Contents</h1>
  <level2><h2>Introduction</h2><p class="toc1">Chapter One: The Wrong Door</p><p class="toc1">Chapter Two: Digory and His Uncle</p><p class="toc">The Lion, the Witch and the Wardrobe</p></level2>
  <level2 class="chapter"><p class="chapter-heads">To The Kilmer Family</p>
  <p class="CN">Chapter One</p><p class="CT">The Wrong Door</p><p class="Text">${'This is a story about something that happened long ago when your grandfather was a child. '.repeat(12)}</p>
  <p class="CN">Chapter Two</p><p class="CT">Digory and His Uncle</p><p class="Text">${'It was so sudden, and so horribly unlike anything that had ever happened to Digory. '.repeat(12)}</p>
  <p class="Ext">Make your choice, adventurous Stranger;</p><p class="Text">${'Digory read it and read it again. '.repeat(20)}</p>
  <p class="A-HEAD">Aslan</p><p class="Text">${'A lion. '.repeat(120)}</p></level2></level1></bodymatter>`;
  const xml = dtbook(body);
  const { kept, skipped } = classify(walkMarkup(xml, []));
  assert.ok(skipped.some((x) => x.reason === 'contents'), 'the toc paragraphs are skipped: ' + skipped.map((x) => x.reason));
  assert.ok(!kept.some((x) => x.paras.join(' ').includes('Chapter Two: Digory')), 'toc lines never reach a chunk');
  const r = await parseBook(Buffer.from(xml), 'narnia.xml');
  const titles = r.sections.map((x) => x.title);
  assert.ok(titles.includes('Chapter One: The Wrong Door'), titles.join(' | '));
  assert.ok(titles.includes('Chapter Two: Digory and His Uncle'), titles.join(' | '));
  assert.ok(titles.includes('Aslan'), titles.join(' | '));
  assert.ok(!titles.some((t) => /adventurous Stranger/.test(t)), 'a verse extract is not a heading');
  const two = r.sections.find((x) => x.title === 'Chapter Two: Digory and His Uncle');
  assert.ok(two.chunks.join(' ').includes('adventurous Stranger'), 'the verse stays inside the chapter');
});

test('chunks are whole sentences under the target and abbreviations do not split', () => {
  const paras = [
    'Dr. Smith went to Washington. He met Mr. and Mrs. Jones at 5 p.m. on the dot! "Really?" she asked. Yes.',
    'x'.repeat(30) + '. ' + 'A very long sentence without any punctuation at all that just keeps going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going and going.',
  ];
  const chunks = chunkParagraphs(paras);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 600, 'chunk too long: ' + c.length);
  assert.ok(chunks[0].startsWith('Dr. Smith went to Washington. He met Mr. and Mrs. Jones at 5 p.m. on the dot!'));
  const s = splitSentences('Dr. Smith went to Washington. He met Mr. Jones.');
  assert.deepEqual(s, ['Dr. Smith went to Washington.', 'He met Mr. Jones.']);
});

test('every chunk of a parsed book fits the proxy streamed lane (<= 600) and most sit under the target', async () => {
  const body = `<bodymatter>${Array.from({ length: 5 }, (_, i) => `<level1><h1>Chapter ${i + 1}</h1>${Array.from({ length: 20 }, (_, j) => `<p>Paragraph ${j} of chapter ${i + 1}. It has a few sentences in it. Some are short. Some go on a little longer than others, but not by much.</p>`).join('')}</level1>`).join('')}</bodymatter>`;
  const r = await parseBook(Buffer.from(dtbook(`<frontmatter>${NOTICE}</frontmatter>${body}`)), 'x.xml');
  const lens = r.sections.flatMap((s) => s.chunks.map((c) => c.length));
  assert.ok(Math.max(...lens) <= 600);
  assert.ok(lens.filter((l) => l <= CHUNK_TARGET).length / lens.length > 0.9);
  assert.equal(r.sections[0].kind, 'jacket');
  assert.equal(r.sections.length, 6);
  assert.equal(r.skipped.length, 3);
});

test('the jacket reads like NLS: title, author, publisher and year, synopsis, length', () => {
  const opf = `<package><metadata><dc-metadata><dc:Title>Thug Notes</dc:Title><dc:Creator>Sparky Sweets</dc:Creator><dc:Publisher>Bookshare</dc:Publisher><dc:Rights>Copyright © 2015 by Wisecrack, Inc.</dc:Rights><dc:Identifier scheme="BKSH">Bookshare-1085272_12004838</dc:Identifier></dc-metadata><x-metadata><meta name="dtb:sourcePublisher" content="Vintage"/><meta name="Synopsis" content="A guide to literature.You&amp;apos;ll laugh."/></x-metadata></metadata></package>`;
  const meta = readOpfMeta(opf);
  assert.equal(meta.title, 'Thug Notes');
  assert.equal(meta.author, 'Sparky Sweets');
  assert.equal(meta.sourcePublisher, 'Vintage');
  assert.equal(meta.copyrightYear, '2015');
  assert.equal(meta.source, 'bookshare');
  const jacket = buildJacket(meta, [{}, {}, {}], 300000);
  assert.ok(jacket.startsWith('Thug Notes. By Sparky Sweets. Published by Vintage, 2015. A guide to literature. You\'ll laugh.'), jacket);
  assert.ok(jacket.includes('3 sections, about 5 hours of listening.'), jacket);
  assert.ok(jacket.includes('This book was produced for people with bona fide print disabilities.'));
  assert.ok(!jacket.includes('Bookshare'));
  assert.equal(listenEstimate(45 * 1000), '45 minutes');
  assert.equal(listenEstimate(61 * 1000), '1 hour and 1 minute');
});

test('accessibility notices from other sources stay out of the narrated book', async () => {
  const markup = '<html><body><h1>Accessibility notice</h1><p>This book is provided exclusively for people with bona fide print disabilities. Authorized readers only.</p><h1>Chapter One</h1><p>' + 'The lighthouse shone over the water. '.repeat(40) + '</p></body></html>';
  const parsed = await parseBook(Buffer.from(markup), 'book.html');
  assert.ok(parsed.skipped.some(section => section.reason === 'accessibility-notice'));
  assert.ok(parsed.jacket.includes('This book was produced for people with bona fide print disabilities.'));
  assert.ok(!parsed.sections.slice(1).flatMap(section => section.chunks).join(' ').includes('Authorized readers'));
  assert.ok(parsed.sections.slice(1).flatMap(section => section.chunks).join(' ').includes('lighthouse'));
});

test('an untitled notice from any source is skipped; the jacket names no source and no reader', async () => {
  const epubNotice = '<html><body><p>This accessible format is made available under Section 121 exclusively for persons with print disabilities. It may not be copied or distributed.</p><h1>Chapter One</h1><p>' + 'The lighthouse shone over the water. '.repeat(40) + '</p></body></html>';
  const parsed = await parseBook(Buffer.from(epubNotice), 'nnels.html');
  assert.deepEqual(parsed.skipped.map((s) => [s.title, s.reason]), [['Accessibility notice', 'accessibility-notice']]);
  assert.deepEqual(parsed.sections.map((s) => s.title), ['About this book', 'Chapter One']);
  assert.ok(parsed.jacket.endsWith('This book was produced for people with bona fide print disabilities.'), parsed.jacket);
  // Bookshare's own notice: the same neutral line, nothing about Bookshare or who downloaded it
  const daisy = await parseBook(Buffer.from(dtbook(`<frontmatter>${NOTICE}</frontmatter><bodymatter><level1><h1>Chapter 1</h1><p>${'It was a bright cold day. '.repeat(80)}</p></level1></bodymatter>`)), 'b.xml');
  const heard = daisy.sections.flatMap((s) => s.chunks).join(' ');
  assert.ok(heard.includes('This book was produced for people with bona fide print disabilities.'));
  assert.ok(!/bookshare|kade murdock|pass this book on|fingerprint/i.test(heard), heard.slice(0, 300));
});

test('a book that only talks about print disabilities keeps its words', async () => {
  const intro = '<html><body><h1>Introduction</h1><p>Readers with print disabilities were provided almost nothing in 1930. This is their story.</p><h1>Chapter 1</h1><p>' + 'The first talking books arrived. '.repeat(60) + '</p><h1>Chapter 2</h1><p>Some copies were made available only to people with print disabilities, and that was the law. ' + 'Records spun on. '.repeat(60) + '</p></body></html>';
  const parsed = await parseBook(Buffer.from(intro), 'history.html');
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.sections.map((s) => s.title), ['About this book', 'Introduction', 'Chapter 1', 'Chapter 2']);
  assert.ok(!parsed.jacket.includes('bona fide'), 'no notice line for a book that had no notice');
});

test('a book with no headings still gets navigable parts, and number-only headings fold into the next', async () => {
  const p = (n) => `<p>${('Sentence number ' + n + ' goes here. ').repeat(40)}</p>`;
  const xml = dtbook(`<frontmatter>${NOTICE}</frontmatter><bodymatter><level1>${p(1)}</level1><level1>${p(2)}</level1><level1><h1>4</h1></level1><level1><h1>Triumphs</h1>${p(3)}</level1></bodymatter>`);
  const r = await parseBook(Buffer.from(xml), 'k.xml');
  const titles = r.sections.slice(1).map((s) => s.title);
  assert.deepEqual(titles, ['Part 1', 'Part 2', '4: Triumphs']);
});

test('a plain text file with Chapter lines splits into chapters and a pasted notice is skipped', async () => {
  const txt = `This accessible media has been made available to people with bona fide disabilities. Bookshare distributes this. BEGIN CONTENT\n\nChapter One\n\nIt was the best of times, it was the worst of times.\n\nChapter Two\n\nThere were a king with a large jaw.`;
  const r = await parseBook(Buffer.from(txt), 'tale.txt');
  assert.equal(r.meta.title, 'tale');
  assert.deepEqual(r.sections.slice(1).map((s) => s.title), ['Chapter One', 'Chapter Two']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'bookshare-notice');
});
