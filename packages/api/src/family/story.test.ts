/* Family history stories and Listen (Sep 29 2026, docs/FAMILY_HISTORY.md): the story reader is a
 * port of the web page's, the cutter a port of the Library reader's, and both must agree with
 * their originals; blocks, sources, cues and the audio file helpers are checked on invented text.
 * THE REPOSITORY IS PUBLIC: every story, person and record here is made up.
 * Run from the repo root:
 * node --require <tsx cjs register> --test packages/api/src/family/story.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAMILY_PART_MAX,
  FAMILY_PART_TARGET,
  familyAudioBase,
  familyAudioExtension,
  familyBlockText,
  familyChunkParagraphs,
  familyCues,
  familyFixWav,
  familyIsSourcePath,
  familyParseInline,
  familyParseMarkdown,
  familySourceLookup,
  familySplitSentences,
  familyStoryBlocks,
  familyStoryHash,
  familyStoryParts,
  familyWavInfo,
} from './story';

/* eslint-disable @typescript-eslint/no-require-imports */
const web: { parseInline: (s: string) => unknown; parseMarkdown: (s: string) => unknown; isSourcePath: (s: string) => boolean } =
  require('../../../../client/public/assets/family/history.js');
const reader: {
  splitSentences: (s: string) => string[];
  chunkParagraphs: (paras: string[], target?: number) => string[];
  CHUNK_TARGET: number;
} = require('../../../../api/server/routes/kadeReadingRoomParse.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const SAMPLES = [
  '# The farm on Example Road\n\nThe **farm** was _invented_ in 1901. See [the census](https://example.com/c) and [records/ancestry/1/2.json; notes/farm.md].',
  'A list:\n\n- first *item*\n- second item with `code`\n  continued\n\n1. one\n2. two\n\n> A quoted line\n> and its second line.',
  '| Name | Year |\n|---|---|\n| Ada Example | 1850 |\n| Ben Example | 1880 |\n\n---\n\nAfter the rule, a link <https://example.com/x> and a bare https://example.com/y.',
  'Escaped \\*stars\\* and snake_case_words and a [link with no address](javascript:alert(1)) and [x] and [ ].',
  '```\ncode block\n```\n\n### A small heading ###\n\nMr. Example met Dr. Sample at St. Invented\'s in the U.S. on 3 Mar. 1901. They talked. "Really?" she asked. Yes!',
];

test('the story reader agrees with the web page on every sample', () => {
  for (const md of SAMPLES) {
    assert.deepEqual(familyParseMarkdown(md), web.parseMarkdown(md), md.slice(0, 40));
    for (const line of md.split('\n')) assert.deepEqual(familyParseInline(line), web.parseInline(line), line);
  }
  for (const inner of ['records/a/b.json', 'notes.md; photos/x.jpg', 'x', ' ', 'https://example.com/a.json', 'a  b/c.json'])
    assert.equal(familyIsSourcePath(inner), web.isSourcePath(inner), inner);
});

test('the Listen cutter agrees with the Library reader: whole sentences, about 450 characters, never over 600', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} tells an invented part of the story, Mr. Example said.`).join(' ');
  const run = 'word '.repeat(200).trim();
  const paras = [long, 'Short line.', 'Another short line.', run, SAMPLES[4]];
  assert.equal(FAMILY_PART_TARGET, reader.CHUNK_TARGET);
  for (const p of paras) assert.deepEqual(familySplitSentences(p), reader.splitSentences(p));
  const parts = familyChunkParagraphs(paras);
  assert.deepEqual(parts, reader.chunkParagraphs(paras));
  for (const part of parts) assert.ok(part.length <= FAMILY_PART_MAX, `${part.length} characters`);
});

test('blocks: the title heading goes, sources become numbered chips with plain titles, never file paths', () => {
  const lookup = familySourceLookup(
    { 'c1:r1': { collection: 'Invented Census 1940', url: 'https://example.com/r' } },
    { '5001': { cemetery: 'Invented Cemetery', url: 'https://example.com/m' } },
  );
  const { blocks, sources } = familyStoryBlocks(
    '# Title\n\nWe lived there [records/ancestry/c1/r1.json]. Later [findagrave/5001/memorial.json; records/ancestry/c1/r1.json].\n\n## Part two\n\n- *one*\n- [a link](https://example.com)\n\n> Said once.\n\n```\nkept as text\n```',
    lookup,
  );
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'h2', 'li', 'li', 'quote', 'p']);
  assert.deepEqual(blocks[0].runs, [
    { text: 'We lived there' },
    { text: '', source: 1 },
    { text: '. Later' },
    { text: '', source: 2 },
    { text: '', source: 1 },
    { text: '.' },
  ]);
  assert.deepEqual(sources, [
    { n: 1, title: 'Invented Census 1940', url: 'https://example.com/r' },
    { n: 2, title: 'Find a Grave memorial, Invented Cemetery', url: 'https://example.com/m' },
  ]);
  assert.deepEqual(blocks[2].runs, [{ text: 'one', em: true }]);
  assert.deepEqual(blocks[3].runs, [{ text: 'a link', link: 'https://example.com' }]);
  assert.equal(familyBlockText(blocks[1]), 'Part two.', 'a heading is read with a full stop');
  assert.equal(JSON.stringify({ blocks, sources }).includes('records/ancestry'), false, 'no file path reaches a reader');
});

test('cues: one per sentence, in order, from 0 to the part length', () => {
  const cues = familyCues('One. Two words here. And a third sentence that is longer than the rest.', 12);
  assert.deepEqual(cues.map((c) => c.text), ['One.', 'Two words here.', 'And a third sentence that is longer than the rest.']);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[cues.length - 1].end, 12);
  for (let i = 1; i < cues.length; i++) {
    assert.equal(cues[i].start, cues[i - 1].end);
    assert.ok(cues[i].end > cues[i].start);
  }
  assert.deepEqual(familyCues(''), []);
  const parts = familyStoryParts([{ type: 'p', runs: [{ text: 'A. B.' }] }, { type: 'h2', runs: [{ text: 'Later' }] }]);
  assert.deepEqual(parts.map((p) => [p.i, p.text]), [[0, 'A. B. Later.']]);
  assert.equal(parts[0].cues[parts[0].cues.length - 1].end, 1, 'fractions of the part');
});

function wav(dataBytes: number, declared: number | null = dataBytes): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(declared === null ? 0xffffffff : 36 + declared, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(declared === null ? 0xffffffff : declared, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

test('audio: a WAV file says its length; a streamed one with unknown sizes is mended; keys never repeat work', () => {
  const info = familyWavInfo(wav(96000));
  assert.deepEqual([info?.sampleRate, info?.dataBytes, info?.duration], [24000, 96000, 2]);
  const streamed = wav(48000, null);
  assert.equal(familyWavInfo(streamed)?.duration, 1, 'unknown sizes are read from the bytes');
  const mended = familyFixWav(streamed);
  assert.equal(mended.readUInt32LE(4), mended.length - 8);
  assert.equal(mended.readUInt32LE(40), 48000);
  assert.equal(familyWavInfo(Buffer.from('not audio at all, just words')), null);
  assert.deepEqual(familyFixWav(Buffer.from('ID3 an mp3')), Buffer.from('ID3 an mp3'));
  assert.equal(familyAudioExtension('audio/mpeg'), 'mp3');
  assert.equal(familyAudioExtension('audio/wav'), 'wav');

  const story = '# A story\n\nOne sentence.';
  assert.equal(familyStoryHash(story), familyStoryHash(story.replace(/\n/g, '\r\n') + '\n'), 'the same words, the same hash');
  assert.notEqual(familyStoryHash(story), familyStoryHash(`${story} Two.`));
  const base = familyAudioBase('family-history', familyStoryHash(story), 'voice A', 'One sentence.');
  assert.match(base, /^family-history\/audio\/[0-9a-f]{20}\/[0-9a-f]{20}$/);
  assert.notEqual(base, familyAudioBase('family-history', familyStoryHash(story), 'voice B', 'One sentence.'), 'a new voice makes new audio');
  assert.doesNotMatch(base.slice('family-history/'.length), /story|sentence/i, 'no title, slug or words in a key');
});
