import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

/* ACE-Step XL (Oct 10 2026) takes the YuE2 writing-desk path: the same song prompt, craft notes, section tags and deep lane,
 * with its own name in the one sentence that names the engine. writing.node-test.mjs holds the rest of the desk (it is CRLF,
 * so these live apart). The module is assembled the way that test assembles it. Words below are invented. */
const read = (relative) => stripTypeScriptTypes(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const seedSource = read('../audio/script.ts');
const hitSource = read('../music/hitSystem.ts').replace('export const hitWritingSystem', 'const hitWritingSystem');
const rhymeLexiconSource = read('../music/rhymeLexicon.ts');
const rhymeSource = read('../music/rhyme.ts').replace("import { rhymeKeyTable, rhymeWordTable } from './rhymeLexicon';", '');
const writingSource = read('../music/writing.ts')
  .replace("import { hitWritingSystem } from './hitSystem';", '')
  .replace(/import \{[^}]*\} from '\.\/rhyme';/, '')
  .replace("import { seedWritingPrompt } from '../audio/script';", '');
const musicSource = [seedSource, hitSource, rhymeLexiconSource, rhymeSource, writingSource].join('\n');
const { musicWritingPrompt, musicWritingSettings, musicWritingBackground, lyricAgentId } = await import('data:text/javascript;base64,' + Buffer.from(musicSource).toString('base64'));
const { seedWritingPrompt } = await import('data:text/javascript;base64,' + Buffer.from(seedSource).toString('base64'));

const PERSONA = 'Saved persona: protect meaning and use internal rhyme.';
const read_ = async () => ({ instructions: PERSONA });
const YUE_DIRECTION =
  'YuE2 direction is 25 to 45 words in one or two compact sentences: language, genre, rhythmic feel, a few defining instruments and the lead vocal character. No section-by-section arrangement narrative, production essay, technical duration line or story summary. The full development belongs in the lyrics and section tags, not in a Lyria-style brief. In the lyrics, mix the two forms of backing vocal: echoes in parentheses after a lead phrase, and a few replies or fills on a line of their own in parentheses.';
const LYRIA_DIRECTION_START = 'Lyria direction is music production prose: genre, BPM and feel, instrumentation, the lead voice, backing vocals and arrangement dynamics as appropriate.';

test('ACE-Step XL is a song engine for the writing desk: it drafts, and a draft can go to the deep lane, exactly as YuE2 does', () => {
  for (const request of [
    { engine: 'ace', mode: 'write', deep: true },
    { engine: 'ace', mode: 'write', background: true },
    { engine: 'ace', mode: 'write', deepWrite: true },
    { engine: 'ace', mode: 'write', thinkMode: 'high' },
  ]) {
    assert.equal(musicWritingBackground(request), true, JSON.stringify(request));
    assert.equal(musicWritingBackground({ ...request, engine: 'yue2' }), true);
  }
  assert.equal(musicWritingBackground({ engine: 'ace', mode: 'write' }), false, 'a plain draft is not a background job');
  assert.equal(musicWritingBackground({ engine: 'ace', mode: 'format', deep: true }), false, 'formatting is not drafting');
  assert.equal(musicWritingBackground({ engine: 'acf', mode: 'write', deep: true }), false, 'no other name is a song engine');
  for (const mode of ['write']) {
    for (const extra of [{}, { patient: true }, { deep: true }, { thinkMode: 'low' }, { thinkMode: 'auto' }, { thinkMode: 'high' }]) {
      assert.deepEqual(musicWritingSettings({ engine: 'ace', mode, ...extra }), musicWritingSettings({ engine: 'yue2', mode, ...extra }), JSON.stringify(extra));
    }
  }
});

test('the ACE-Step XL song prompt is the YuE2 song prompt with its own name in the direction sentence', async () => {
  const yue = await musicWritingPrompt('Sound Booth format', { engine: 'yue2', mode: 'write' }, read_);
  const ace = await musicWritingPrompt('Sound Booth format', { engine: 'ace', mode: 'write' }, read_);
  assert.ok(yue.includes(YUE_DIRECTION), 'the YuE2 text is untouched');
  assert.equal(ace.includes('YuE2 direction'), false);
  assert.ok(ace.includes(YUE_DIRECTION.replace('YuE2 direction', 'ACE-Step XL direction')));
  assert.equal(ace, yue.replace('YuE2 direction', 'ACE-Step XL direction'), 'nothing else differs');
  assert.ok(ace.includes(PERSONA));
  assert.match(ace, /SONGWRITING CRAFT FOR THE SOUND BOOTH/);
  assert.match(ace, /about four minutes, 50 to 70 sung lines/);
  assert.match(ace, /There is no Lyrics Box, Tag Box or Negative Tag Box here/);
  assert.match(ace, /BACKING VOCALS ARE PART OF THE SONG/, 'the craft notes the YuE2 path has');
  assert.doesNotMatch(ace, /Lyria direction/);
  /* The Lyria prompt keeps its own direction sentence, and the length line that only Lyria gets. */
  const lyria = await musicWritingPrompt('Sound Booth format', { engine: 'lyria', mode: 'write' }, read_);
  assert.ok(lyria.includes(LYRIA_DIRECTION_START));
  assert.ok(lyria.includes('the technical line says about four minutes, '));
  assert.equal(ace.includes('the technical line says about four minutes, '), false);
  assert.equal(yue.includes('the technical line says about four minutes, '), false);
});

test('the title instruction, the audience note and the persona lookup are the same for ACE-Step XL as for YuE2', async () => {
  const reads = [];
  const record = async (filter) => { reads.push(filter); return { instructions: PERSONA }; };
  for (const request of [{ title: 'Rain Song' }, { title: '' }, {}]) {
    const ace = await musicWritingPrompt('Format', { engine: 'ace', mode: 'write', ...request }, record, 'clean');
    const yue = await musicWritingPrompt('Format', { engine: 'yue2', mode: 'write', ...request }, record, 'clean');
    assert.equal(ace, yue.replace('YuE2 direction', 'ACE-Step XL direction'), JSON.stringify(request));
  }
  assert.deepEqual(reads, Array(6).fill({ id: lyricAgentId }));
  const withTitle = await musicWritingPrompt('Format', { engine: 'ace', mode: 'write', title: 'Rain Song' }, read_);
  assert.match(withTitle, /the person's chosen title, exactly: "Rain Song"/);
  await assert.rejects(() => musicWritingPrompt('Format', { engine: 'ace', mode: 'write' }, async () => null), (error) => error.status === 503 && /temporarily unavailable/.test(error.message));
});

test('formatting and speech are not drafting: ACE-Step XL in format mode gets the plain prompt, as YuE2 does', async () => {
  for (const mode of ['format']) {
    for (const engine of ['ace', 'yue2', 'lyria']) {
      assert.equal(await musicWritingPrompt('Original format', { engine, mode }, read_), seedWritingPrompt('Original format', engine, mode), `${engine}/${mode}`);
    }
  }
});
