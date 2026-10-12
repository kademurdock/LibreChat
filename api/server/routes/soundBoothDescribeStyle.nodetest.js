'use strict';
/* Oct 11 2026: a described Music direction and a trained Style (packages/api/src/music/yue.ts: yueInput, yueStyleDirection).
 *
 * "Describe the sound of the recording" fills Music direction with a line that opens with the language, then the genre, the pace
 * and the voice. A trained Style puts its own lead in front of Music direction, and every lead already says English; the Soul
 * and Kids leads also name their genre. The request must not repeat the language ("English, English") or fight the style's
 * genre, and a direction she wrote herself must go through untouched. The Style can be chosen after the fill, so the fix is on
 * the server, where the caption is built.
 *
 * Every line here is invented for the test. Nothing is sent anywhere.
 *
 * Run: node --test api/server/routes/soundBoothDescribeStyle.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const yue = require(path.resolve(__dirname, '../../../packages/api/src/music/yue.ts'));

const DESCRIBED = 'English, folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies';
const REST = 'mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies';
const COVER = 'https://assets.test/cover.mp3';
const LYRICS = '[Verse]\nSome made-up words';
const request = (script, band, extra = {}) => yue.yueInput({ script, lyrics: LYRICS, band, reference_voice_url: COVER, ...extra }, {});

test.beforeEach(() => { process.env.YUE_STYLES_ENABLED = '1'; });
test.after(() => { delete process.env.YUE_STYLES_ENABLED; });

test('Suno: the lead stops at the language, so the described line continues it with its genre and loses only its own language', () => {
  const style = request(DESCRIBED, 'suno').style;
  assert.equal(style, 'kdsuno, in the style of kdsuno. English, folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies');
  assert.doesNotMatch(style, /English, English/);
  assert.equal(style.match(/English/g).length, 1);
});

test('Soul: the lead names its genre, so the described line loses its language and its genre and keeps pace, voice and sound words', () => {
  const style = request(DESCRIBED, 'soul').style;
  assert.equal(style, `${yue.yueStyles.soul.lead} ${REST}`);
  assert.equal(style.match(/English/g).length, 1);
  assert.doesNotMatch(style, /folk/, 'the recording\'s genre does not fight the style\'s genre');
});

test('Kids: the same, after the lead that names a children\'s choir', () => {
  const style = request(DESCRIBED, 'kids').style;
  assert.equal(style, `${yue.yueStyles.kids.lead} ${REST}`);
  assert.equal(style.match(/English/g).length, 1);
  assert.doesNotMatch(style, /folk/);
});

test('every pace the describer writes is recognised', () => {
  for (const pace of ['slow tempo', 'mid-tempo', 'up-tempo']) {
    const line = `English, rock, ${pace}, male lead vocal, big drums`;
    assert.equal(request(line, 'soul').style, `${yue.yueStyles.soul.lead} ${pace}, male lead vocal, big drums`);
    assert.equal(request(line, 'suno').style, `${yue.yueStyles.suno.lead} rock, ${pace}, male lead vocal, big drums`);
  }
});

test('a direction she wrote herself goes through exactly as it did', () => {
  for (const mine of [
    'A slow blues cover with a gravel voice',
    'English, brisk, folk, with a banjo',
    'english-language folk, mid-tempo',
    'English and Spanish lyrics, latin pop, up-tempo, male lead vocal, bright trumpets',
    'Spanish, latin pop, up-tempo, male lead vocal, bright trumpets',
    'Instrumental, jazz, slow tempo, piano trio',
    'Warm English, folk, mid-tempo, female lead vocal',
  ]) {
    for (const band of ['suno', 'sona', 'soul', 'kids'])
      assert.equal(request(mine, band).style, `${yue.yueStyles[band].lead} ${mine}`, `${band}: ${mine}`);
  }
});

test('with no Style the described line is sent whole, as it always was', () => {
  assert.equal(request(DESCRIBED).style, DESCRIBED);
  assert.equal(request(DESCRIBED, 'none').style, DESCRIBED);
  assert.equal(request(DESCRIBED, 'soul', { style_strength: 0 }).style, DESCRIBED, 'a Style at strength zero is no Style');
});

test('what the worker is told apart from the caption is unchanged', () => {
  const plain = request(DESCRIBED, 'suno');
  assert.equal(plain.lora_key, yue.yueStyles.suno.key);
  assert.equal(plain.band, 'suno');
  assert.equal(plain.cot, 'melody');
  assert.equal(plain.lyrics, LYRICS);
  assert.equal(plain.reference_voice_url, COVER);
});

test('saving and opening again: the box gets back what the request carried, without the lead', () => {
  for (const band of ['suno', 'soul', 'kids']) {
    const style = request(DESCRIBED, band).style;
    const reopened = yue.yueMusicDirection(style);
    assert.equal(reopened, band === 'suno' ? 'folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies' : REST, band);
  }
});

test('the default title still comes from her direction (the page names a described cover after its recording)', () => {
  assert.equal(request(DESCRIBED, 'soul').title, 'English, folk, mid-tempo, female lead vocal, warm', 'the server default is the first seven words, which is why the page names the cover');
  assert.equal(request(DESCRIBED, 'soul', { title: 'Porch swing (cover)' }).title, 'Porch swing (cover)', 'a title she or the page set wins');
});

test('yueStyleDirection itself: pure, and the lead decides the genre', () => {
  assert.equal(yue.yueStyleDirection(DESCRIBED, 'kdsuno, in the style of kdsuno. English,'), `folk, ${REST}`);
  assert.equal(yue.yueStyleDirection(DESCRIBED, 'kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul.'), REST);
  assert.equal(yue.yueStyleDirection('Make it a lullaby', 'kdsuno, in the style of kdsuno. English,'), 'Make it a lullaby');
  assert.equal(yue.yueStyleDirection('', 'x English,'), '');
});
