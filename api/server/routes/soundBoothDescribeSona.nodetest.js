/* Oct 11 2026: the YuE2 Sona style and "Describe the sound of the recording" together (packages/api/src/music/yue.ts: yueStyles,
 * yueInput, yueStyleDirection; packages/api/src/music/lyrics.ts: checkSoundDirection).
 *
 * Sona's lead stops at "English," the way Suno's does, so a described line continues it with its genre and gives up only its
 * language. A trained lead already says English, so the word must be in the caption once whatever language part the describer
 * wrote: "English", "English and Spanish" and "Spanish and English" all give it up. A line in a single other language is left
 * alone (a recording the lead cannot speak for). Every line is run through the real describer check, so the lines are the ones the
 * Music direction box is filled with; nothing is sent anywhere and no model is called.
 *
 * Every line here is invented for the test.
 *
 * Run: node --test api/server/routes/soundBoothDescribeSona.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const compile = (source) =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
require.extensions['.ts'] = (mod, filename) => mod._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const yue = require(path.resolve(__dirname, '../../../packages/api/src/music/yue.ts'));

class FakeForm {
  append() {}
  getHeaders() { return {}; }
}
const stubs = { 'form-data': FakeForm, '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } } };
function musicLyrics() {
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
  return compiled.exports;
}
const check = musicLyrics().checkSoundDirection;

const COVER = 'https://assets.test/cover.mp3';
const LYRICS = '[Verse]\nSome made-up words';
const request = (script, band, extra = {}) => yue.yueInput({ script, lyrics: LYRICS, band, reference_voice_url: COVER, ...extra }, {});
const STYLES = ['kids', 'soul', 'suno', 'sona'];
const WORKER_LIMIT = 3000;

/* what a model might write, in the shape the describer's prompt asks for; the real check turns each into the line the page shows */
const REPLIES = [
  'English, Folk, Mid-tempo, Female lead vocal, Warm acoustic guitar, Soft harmonies',
  'English, Contemporary R&B, Slow tempo, Male lead vocal, Smooth falsetto, Rhodes piano, Warm bass',
  'English, Gospel, Mid-tempo, Group vocals, Hammond organ, Handclaps, Call and response',
  'English, Folk, Indie folk, Mid-tempo, Female lead vocal, Banjo, Soft strings',
  'english, country, slow tempo, male lead vocal, pedal steel, gravelly voice',
  'English and Spanish, Latin pop, Up-tempo, Male lead vocal, Bright trumpets, Handclaps',
  'Spanish and English, Pop, Mid-tempo, Female lead vocal, Nylon guitar, Light percussion',
  'english & spanish, latin pop, up-tempo, male lead vocal, bright trumpets',
  'Hindi and English, Pop, Up-tempo, Female lead vocal, Tabla, Bright synths',
];
const described = REPLIES.map((reply) => {
  const got = check(reply);
  assert.ok('direction' in got, `the real check should accept: ${reply}`);
  return got.direction;
});
const words = (text, word) => (text.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length;

test.beforeEach(() => { process.env.YUE_STYLES_ENABLED = '1'; });
test.after(() => { delete process.env.YUE_STYLES_ENABLED; });

test('Sona is a row of the registry whose lead stops at the language, like Suno', () => {
  assert.equal(yue.yueStyles.sona.lead, 'kdsona, in the style of kdsona. English,');
  assert.equal(yue.yueStyles.suno.lead, 'kdsuno, in the style of kdsuno. English,');
});

test('Sona: a described line continues the lead with its genre and loses only its language', () => {
  const style = request('English, folk, mid-tempo, female lead vocal, warm acoustic guitar', 'sona').style;
  assert.equal(style, 'kdsona, in the style of kdsona. English, folk, mid-tempo, female lead vocal, warm acoustic guitar');
  assert.equal(words(style, 'English'), 1);
});

test('a line with two languages, English among them, gives up the whole language part, for every Style', () => {
  for (const line of ['English and Spanish, latin pop, up-tempo, male lead vocal, bright trumpets', 'Spanish and English, latin pop, up-tempo, male lead vocal, bright trumpets']) {
    for (const band of ['suno', 'sona']) {
      assert.equal(request(line, band).style, `${yue.yueStyles[band].lead} latin pop, up-tempo, male lead vocal, bright trumpets`, `${band}: ${line}`);
    }
    for (const band of ['soul', 'kids']) {
      assert.equal(request(line, band).style, `${yue.yueStyles[band].lead} up-tempo, male lead vocal, bright trumpets`, `${band}: ${line}`);
    }
  }
});

test('a line in one other language is left alone: the lead cannot speak for that recording', () => {
  const line = 'Spanish, bolero, slow tempo, female lead vocal, nylon guitar';
  for (const band of STYLES) assert.equal(request(line, band).style, `${yue.yueStyles[band].lead} ${line}`, band);
});

test('every line the describer can fill the box with holds the word English once under every Style, and fits the worker', () => {
  for (const line of described) {
    for (const band of STYLES) {
      const style = request(line, band).style;
      assert.equal(words(style, 'English'), 1, `${band}: ${style}`);
      assert.ok(style.startsWith(`${yue.yueStyles[band].lead} `), `${band}: the lead is in front: ${style}`);
      assert.ok(style.length <= WORKER_LIMIT, `${band}: ${style.length} characters`);
      assert.ok(style.trim().length >= 3);
    }
    /* no Style: the line is sent whole, as it always was */
    assert.equal(request(line).style, line);
    assert.equal(request(line, 'none').style, line);
    assert.equal(request(line, 'sona', { style_strength: 0 }).style, line, 'a Style at strength zero is no Style');
  }
});

test('the longest description the check lets through, behind the longest lead, is far inside the worker limit', () => {
  const phrases = [
    'warm brass section', 'tight snare crack', 'deep round bass', 'shimmering spring reverb', 'bright electric piano',
    'smoky late night mood', 'crisp hi hat patterns', 'airy backing choir', 'gritty tape saturation', 'wide stereo strings',
    'dusty vinyl texture', 'punchy kick drum', 'soft muted trumpet', 'lush layered harmonies', 'slow building crescendo',
  ];
  const got = check(['English', 'Soul', 'Mid-tempo', 'Female lead vocal', ...phrases.map((phrase) => phrase[0].toUpperCase() + phrase.slice(1))].join(', '));
  assert.ok('direction' in got, 'the real check should accept the long reply');
  assert.ok(got.direction.length > 200 && got.direction.length <= 240, `the check cuts a description at 240 characters, got ${got.direction.length}`);
  const longestLead = Math.max(...Object.values(yue.yueStyles).map((row) => row.lead.length));
  for (const band of STYLES) {
    const style = request(got.direction, band).style;
    assert.ok(style.length <= longestLead + 1 + 240, `${band}: ${style.length}`);
    assert.ok(style.length < WORKER_LIMIT);
  }
  /* a direction she wrote at the page's limit is cut by the booth at the worker's limit, with the lead whole in front */
  const hers = `Slow soul, ${'warm '.repeat(700)}`.slice(0, WORKER_LIMIT);
  for (const band of STYLES) {
    const style = request(hers, band).style;
    assert.equal(style.length, WORKER_LIMIT, band);
    assert.ok(style.startsWith(yue.yueStyles[band].lead), band);
  }
});

test('Sona and a described line: the worker is told the same things apart from the caption', () => {
  const plain = request('English, folk, mid-tempo, female lead vocal, warm acoustic guitar', 'sona');
  assert.equal(plain.lora_key, 'yue2-loras/sona-step800.pt');
  assert.equal(plain.lora_scale, 1);
  assert.equal(plain.band, 'sona');
  assert.equal(plain.cot, 'melody');
  assert.equal(plain.reference_voice_url, COVER);
  assert.equal(request('English, folk, mid-tempo, female lead vocal, warm', 'sona', { style_strength: 0.4 }).lora_scale, 0.4);
});

test('a described line saved behind Sona opens again without the lead', () => {
  for (const line of described) {
    const style = request(line, 'sona').style;
    const reopened = yue.yueMusicDirection(style);
    assert.doesNotMatch(reopened, /kdsona|in the style of/, line);
    assert.ok(reopened.length >= 3, line);
  }
});
