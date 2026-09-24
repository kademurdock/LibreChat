import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Types } from 'mongoose';
import { readLibraryCatalog } from './catalog';
import type { CatalogItem, LibraryDependencies } from './catalog';
import { printDisabilityNotice, readingJacket, readingPassages, readingText } from './text';

/* Run from the repo root:
 * node --import <tsx esm loader> --test packages/api/src/library/text.test.ts */

test('every steering form the platform voices use stays off the page', () => {
  // The canonical performance direction, content and delimiters both.
  assert.equal(readingText('%%%warm and gentle%%% Hello there.'), 'Hello there.');
  // Layered directions run long; the canonical pair has no length cap.
  const layered = `%%%${'slow, low, a little amused, '.repeat(8)}%%%`;
  assert.equal(readingText(`She waited. ${layered} Then she spoke.`), 'She waited. Then she spoke.');
  // Mistyped delimiters the models sometimes produce.
  assert.equal(readingText('%%sigh%% Fine.'), 'Fine.');
  assert.equal(readingText('%%%laughing%% Fine. %%%%reset%%%% Done.'), 'Fine. Done.');
  // A long direction's closer is never paired with the next opener.
  const long = `%%%${'quiet and careful, '.repeat(12)}%%%`;
  assert.equal(readingText(`${long}Then she spoke. %%%sad%%%`), 'Then she spoke.');
  // Game Parlor cues are machine decoration.
  assert.equal(readingText('The dealer shuffles. [sound:card_deal] [table:ab12] Your turn.'), 'The dealer shuffles. Your turn.');
  // A multi-voice scene cue reads as a screenplay line, the way the chat shows it.
  assert.equal(readingText('[[Deuce]] Hold on. [[Voice 214]] No.'), 'Deuce: Hold on. Voice 214: No.');
});

test('ordinary bracketed prose, percentages and symbols stay exactly as written', () => {
  const prose = [
    'He wrote [sic] in the margin.',
    '[A handwritten note is tucked inside the cover.]',
    'Stage direction: [Enter the Duke, laughing.]',
    '[Voice: a whisper from the dark] Who is there?',
    '[Sound of rain] It kept raining.',
    'Prices rose 10% in March and 20% in April.',
    'The printf pattern "%%d" prints a percent sign.',
    'Footnote [1] and footnote [23].',
    '[[unfinished',
  ];
  for (const text of prose) assert.equal(readingText(text), text);
  assert.equal(readingText(''), '');
});

test('the old Bookshare jacket line becomes the one source-neutral notice', () => {
  const old = 'Thug Notes. By Sparky Sweets. 3 sections, about 5 hours of listening. From Bookshare, for people with print disabilities. Please do not pass this book on.';
  const cleaned = readingJacket(old);
  assert.equal(cleaned, `Thug Notes. By Sparky Sweets. 3 sections, about 5 hours of listening. ${printDisabilityNotice}`);
  assert.ok(!/bookshare|pass this book on/i.test(cleaned));
  // The chunker can cut between the two sentences; each half is handled alone.
  assert.equal(readingJacket('From Bookshare, for people with print disabilities.'), printDisabilityNotice);
  assert.equal(readingJacket('Please do not pass this book on.'), '');
  // A jacket written after the change is left alone.
  assert.equal(readingJacket(`A book. ${printDisabilityNotice}`), `A book. ${printDisabilityNotice}`);
  assert.equal(printDisabilityNotice, 'This book was produced for people with bona fide print disabilities.');
});

test('a reading page is the stored passages, cleaned, with positions kept', () => {
  const chunks = ['Chapter One.', '%%%tense%%% It was late.', 'She ran.', 'He followed.'];
  assert.deepEqual(readingPassages(chunks, 'section', 1, 2), ['It was late.', 'She ran.']);
  assert.deepEqual(readingPassages(chunks, 'section', 3, 10), ['He followed.']);
  assert.deepEqual(readingPassages(chunks, 'section', 9, 10), []);
  // Jacket passages lose the old notice; an emptied passage keeps its slot so
  // positions still line up with the narration.
  const jacket = ['A book. From Bookshare, for people with print disabilities.', 'Please do not pass this book on.'];
  assert.deepEqual(readingPassages(jacket, 'jacket', 0, 5), [`A book. ${printDisabilityNotice}`, '']);
  // Only the jacket is rewritten; a novel quoting the sentence keeps it.
  assert.deepEqual(readingPassages(['Please do not pass this book on.'], 'section', 0, 1), ['Please do not pass this book on.']);
});

test('the librarian reads an old jacket the way the reader sees it', async () => {
  const id = new Types.ObjectId();
  const oldJacket = 'Thug Notes. By Sparky Sweets. From Bookshare, for people with print disabilities. Please do not pass this book on.';
  const item: CatalogItem = {
    _id: id,
    owner: new Types.ObjectId(),
    state: 'ready',
    kind: 'text',
    title: 'Thug Notes',
    jacket: oldJacket,
    sections: [
      { title: 'About this book', chunkCount: 1, kind: 'jacket' },
      { title: 'Chapter 1', chunkCount: 1, kind: 'section' },
    ],
  };
  const chunks = [[oldJacket], ['Please do not pass this book on.']];
  const deps: LibraryDependencies = {
    search: async () => [],
    details: async () => item,
    passage: async (_id, section, chunk) => ({ text: chunks[section][chunk], title: '', chunks: 1, sections: 2 }),
  };
  const reader = { id: String(new Types.ObjectId()), child: false, hidden: false };
  const details = await readLibraryCatalog({ action: 'details', id: String(id) }, reader, deps);
  assert.ok('jacket' in details);
  assert.equal(details.jacket, `Thug Notes. By Sparky Sweets. ${printDisabilityNotice}`);
  const jacket = await readLibraryCatalog({ action: 'passage', id: String(id), section: 0, chunk: 0 }, reader, deps);
  assert.ok('text' in jacket);
  assert.ok(!/bookshare|pass this book on/i.test(jacket.text || ''), jacket.text);
  // a novel quoting the sentence keeps it
  const story = await readLibraryCatalog({ action: 'passage', id: String(id), section: 1, chunk: 0 }, reader, deps);
  assert.ok('text' in story);
  assert.equal(story.text, 'Please do not pass this book on.');
});
