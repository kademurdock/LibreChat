'use strict';
/* ACE-Step XL (Oct 10 2026): the pure half of packages/api music/ace.ts. No server, no database.
 * The lyrics here are invented placeholders. The route and the router are in kadeSoundBoothAce.selftest.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) =>
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    filename,
  );
const ace = require('../../../packages/api/src/music/ace.ts');
const { yueSinging, yueTakeCost } = require('../../../packages/api/src/music/yue.ts');
const { isOwnedAudioReference } = require('../../../packages/api/src/speech/edit.ts');

const SUNG = yueSinging.sung;
const INSTRUMENTAL = yueSinging.instrumental;
const ON = { ACE_ENABLED: '1' };
const sheet = (n) => Array.from({ length: n }, (_, i) => `la la ${i}`).join('\n');
const base = { script: 'Slow soul, 88 BPM, Rhodes', lyrics: '[Verse]\nWalking home\n[Chorus]\nHold on', seed: 7 };
const refusal = (body, message, env = {}) => assert.throws(() => ace.aceInput(body, env), { message });

test('every flag is off, closed or at its stated default until it is set', () => {
  assert.equal(ace.aceEnabled({}), false);
  assert.equal(ace.aceEnabled(ON), true);
  for (const said of ['0', 'true', 'yes', 'on', '', 'ON']) assert.equal(ace.aceEnabled({ ACE_ENABLED: said }), false, said);

  for (const env of [{}, { ACE_ADMIN_ONLY: '' }, { ACE_ADMIN_ONLY: '1' }, { ACE_ADMIN_ONLY: 'true' }, { ACE_ADMIN_ONLY: 'yes' }, { ACE_ADMIN_ONLY: 'maybe' }])
    assert.equal(ace.aceAdminOnly(env), true, JSON.stringify(env));
  for (const said of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) assert.equal(ace.aceAdminOnly({ ACE_ADMIN_ONLY: said }), false, said);

  assert.equal(ace.aceConfigured({}), false);
  assert.equal(ace.aceConfigured({ ACE_ENDPOINT_ID: 'x' }), false);
  assert.equal(ace.aceConfigured({ RUNPOD_API_KEY: 'x' }), false);
  assert.equal(ace.aceConfigured({ ACE_ENDPOINT_ID: 'x', RUNPOD_API_KEY: 'x' }), true);
  assert.equal(ace.aceConfigured({ ACE_ENDPOINT_ID: 'x', RUNPOD_API_KEY: 'x', ACE_ENABLED: '0' }), true, 'the flag is not part of configured: queued takes must finish');

  assert.equal(ace.aceDefaultModel({}), 'xl-turbo');
  assert.equal(ace.aceDefaultModel({ ACE_DEFAULT_MODEL: 'xl-sft' }), 'xl-sft');
  assert.equal(ace.aceDefaultModel({ ACE_DEFAULT_MODEL: ' XL-SFT ' }), 'xl-sft');
  for (const said of ['xl-turbo', 'sft', 'turbo', 'xl-sft2', '']) assert.equal(ace.aceDefaultModel({ ACE_DEFAULT_MODEL: said }), 'xl-turbo', said);

  assert.equal(ace.aceMaxSeconds({}), 360);
  for (const [said, want] of [['300', 300], ['60', 60], ['600', 600], ['59', 360], ['601', 360], ['abc', 360], ['', 360], ['360.5', 360], ['-1', 360], [' 240 ', 240]])
    assert.equal(ace.aceMaxSeconds({ ACE_MAX_SECONDS: said }), want, said);
});

test('access: nobody while it is off, admins only while admin-only is on, then everyone signed in', () => {
  const admin = { role: 'ADMIN' }, user = { role: 'USER' };
  const OFF = 'ACE-Step XL is not turned on yet.', CLOSED = 'ACE-Step XL is not open to your account yet.';
  for (const who of [admin, user, null, undefined, {}]) {
    assert.deepEqual(ace.aceAccess(who, {}), { ok: false, error: OFF });
    assert.deepEqual(ace.aceAccess(who, { ACE_ADMIN_ONLY: '0' }), { ok: false, error: OFF }, 'opening it to everyone does not turn it on');
    assert.equal(ace.aceAllowed(who, {}), false);
  }
  assert.deepEqual(ace.aceAccess(admin, ON), { ok: true });
  assert.deepEqual(ace.aceAccess({ role: 'admin' }, ON), { ok: true }, 'the role is read without regard to case');
  for (const who of [user, {}, { role: null }, { role: 'MODERATOR' }, null, undefined])
    assert.deepEqual(ace.aceAccess(who, ON), { ok: false, error: CLOSED }, JSON.stringify(who));
  assert.deepEqual(ace.aceAccess(user, { ...ON, ACE_ADMIN_ONLY: '0' }), { ok: true });
  assert.deepEqual(ace.aceAccess({}, { ...ON, ACE_ADMIN_ONLY: 'off' }), { ok: true });
  assert.deepEqual(ace.aceAccess(null, { ...ON, ACE_ADMIN_ONLY: '0' }), { ok: false, error: CLOSED }, 'no account, no access');
  assert.equal(ace.aceAllowed(admin, ON), true);
  assert.equal(ace.aceAllowed(user, ON), false);
  for (const sentence of [OFF, CLOSED]) assert.doesNotMatch(sentence, /Kade|admin|ADMIN/);
});

test('caption: a tempo moves into the bpm field, everything else stays', () => {
  const cases = [
    ['Slow soul, 88 BPM, Rhodes', 'Slow soul, Rhodes', 88],
    ['Around 70 BPM, in D minor', 'in D minor', 70],
    ['120bpm funk', 'funk', 120],
    ['Funk at 96 BPM with horns', 'Funk with horns', 96],
    ['Funk ~96bpm', 'Funk', 96],
    ['Roughly 60 bpm lullaby', 'lullaby', 60],
    ['Soul ballad (72 BPM)', 'Soul ballad', 72],
    ['Soul ballad (72 BPM, Rhodes)', 'Soul ballad (Rhodes)', 72],
    ['Soul ballad (Rhodes, 72 BPM)', 'Soul ballad (Rhodes)', 72],
    ['Slow soul. 88 BPM. Rhodes', 'Slow soul. Rhodes', 88],
    ['Slow soul, 88 BPM. Rhodes', 'Slow soul. Rhodes', 88],
    ['Slow soul, Rhodes, 88 BPM.', 'Slow soul, Rhodes.', 88],
    ['Slow soul, Rhodes, 88 BPM', 'Slow soul, Rhodes', 88],
    ['Funk 96 BPM, then 96 BPM again', 'Funk, then again', 96],
    ['Funk, 88.4 BPM', 'Funk', 88],
    ['Slow soul\n88 BPM\nRhodes and brushed drums', 'Slow soul Rhodes and brushed drums', 88],
    ['Slow  88 BPM  groove', 'Slow groove', 88],
    ['a 90-BPM groove', 'a groove', 90],
    ['a 90 - bpm groove', 'a groove', 90],
    ['30 BPM drone', 'drone', 30],
    ['drone 300 BPM', 'drone', 300],
  ];
  for (const [direction, caption, bpm] of cases)
    assert.deepEqual(ace.aceCaption(direction), { caption, bpm, trimmed: false }, JSON.stringify(direction));
});

test('caption: no tempo, two tempos or an impossible one send no bpm and leave the words alone', () => {
  for (const direction of [
    'Slow soul, Rhodes',
    '88 BPM and 120 BPM',
    'Starts at 60 BPM and ends at 90 BPM',
    'Slow 88-92 BPM groove',
    'Slow 88 to 92 BPM groove',
    '400 BPM',
    '29 BPM',
    '301 BPM',
    'a beat of 5 bpm',
    'In A minor, 4/4',
    'about 88 beats per minute',
  ]) assert.deepEqual(ace.aceCaption(direction), { caption: direction, trimmed: false }, direction);
  assert.deepEqual(ace.aceCaption('  padded  '), { caption: 'padded', trimmed: false });
  assert.deepEqual(ace.aceCaption('88 BPM'), { caption: '88 BPM', bpm: 88, trimmed: false }, 'a direction that is only a tempo keeps its words');
  assert.deepEqual(ace.aceCaption('around 88 BPM.'), { caption: 'around 88 BPM.', bpm: 88, trimmed: false });
});

test('caption: trimmed to 512 characters at a word boundary, never inside a word or a pair', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ');
  const exact = 'a'.repeat(512);
  assert.deepEqual(ace.aceCaption(exact), { caption: exact, trimmed: false }, 'exactly 512 is kept');
  const spaced = `${'a'.repeat(500)} ${'b'.repeat(12)}`;
  assert.equal(Array.from(spaced).length, 513);
  assert.deepEqual(ace.aceCaption(spaced), { caption: 'a'.repeat(500), trimmed: true }, '513 with the space at 500 cuts there');
  const edge = `${'a'.repeat(511)} ${'b'.repeat(20)}`;
  assert.equal(ace.aceCaption(edge).caption, 'a'.repeat(511), 'a word that starts at 512 is dropped whole');
  const neat = `${'a'.repeat(511)} ${'b'.repeat(2)} ${'c'.repeat(9)}`;
  assert.deepEqual(ace.aceCaption(neat), { caption: `${'a'.repeat(511)}`, trimmed: true }, '"bb" would end at 514: it is dropped, not cut');
  const fits = `${'a'.repeat(509)} bb cc`;
  assert.deepEqual(ace.aceCaption(fits), { caption: `${'a'.repeat(509)} bb`, trimmed: true }, 'whole words up to 512 are kept');
  const long = words(100);
  const cut = ace.aceCaption(long);
  assert.equal(cut.trimmed, true);
  assert.ok(Array.from(cut.caption).length <= 512);
  assert.match(cut.caption, /word\d{3}$/, 'ends on a whole word');
  assert.ok(long.startsWith(cut.caption));
  assert.equal(long[cut.caption.length], ' ');
  const hard = ace.aceCaption('x'.repeat(600));
  assert.deepEqual(hard, { caption: 'x'.repeat(512), trimmed: true }, 'one unbroken word is the only hard cut');
  const pairs = ace.aceCaption('\u{1F3B5}'.repeat(600));
  assert.equal(Array.from(pairs.caption).length, 512, 'counted in code points, as the worker counts');
  assert.ok(!/[\uD800-\uDBFF]$/.test(pairs.caption), 'no half of a surrogate pair is left');
  assert.equal(pairs.caption, '\u{1F3B5}'.repeat(512));
  assert.equal(ace.aceCaption(`${'ab '.repeat(200)}`).caption.endsWith('ab'), true, 'trailing spaces and commas go');
  const commas = ace.aceCaption(`${'a'.repeat(505)}, ${'b'.repeat(30)}`);
  assert.equal(commas.caption, 'a'.repeat(505), 'a comma left at the cut is dropped');
  const withTempo = ace.aceCaption(`Slow soul, 88 BPM, ${words(100)}`);
  assert.equal(withTempo.bpm, 88);
  assert.ok(withTempo.caption.startsWith('Slow soul, word000'));
});

test('Match my lyrics: 20 seconds plus 3.7 a sung line, to the nearest five, from 30 seconds to 5 minutes', () => {
  const table = [[0, 120], [1, 30], [4, 35], [10, 55], [20, 95], [30, 130], [40, 170], [50, 205], [60, 240], [80, 300], [100, 300], [1000, 300]];
  for (const [lines, seconds] of table) assert.equal(ace.aceLyricSeconds(sheet(lines)), seconds, `${lines} lines`);
  assert.equal(ace.aceLyricSeconds(''), 120, 'no sung line is an instrumental');
  assert.equal(ace.aceLyricSeconds('[Verse]\n\n[Chorus]\n   \n[Instrumental]'), 120, 'tags and blank lines are not sung');
  assert.equal(ace.aceLyricSeconds('[Verse]\nla\n\n[Chorus: big]\nla\n(oh oh)\n[Outro]\n'), 30, 'three sung lines: a backing line counts, tags do not');
  assert.equal(ace.aceLyricSeconds(`[Verse]\r\n${sheet(40)}\r\n`), 170, 'Windows line ends read the same');
  assert.equal(ace.aceLyricSeconds(sheet(100), 200), 200, 'ACE_MAX_SECONDS caps it');
  assert.equal(ace.aceLyricSeconds(sheet(40), 120), 120);
  assert.equal(ace.aceLyricSeconds(sheet(100), 600), 300, 'never beyond five minutes whatever the cap');
  assert.equal(ace.aceLyricSeconds('', 60), 60);
  assert.equal(ace.aceLyricSeconds(sheet(40)), ace.aceLyricSeconds(sheet(40)), 'pure: the same lyrics, the same length');
});

test('Length: Match my lyrics, a fixed M:SS length, and plain refusals', () => {
  const lyrics = sheet(40);
  assert.deepEqual(ace.aceLength(undefined, lyrics, false, 360), { seconds: 170, label: 'Match my lyrics' });
  for (const said of ['', ' ', 'Match my lyrics', 'match my lyrics', ' MATCH MY LYRICS ', null])
    assert.deepEqual(ace.aceLength(said, lyrics, false, 360), { seconds: 170, label: 'Match my lyrics' }, JSON.stringify(said));
  assert.deepEqual(ace.aceLength('Match my lyrics', lyrics, true, 360), { seconds: 120, label: 'Match my lyrics' }, 'an instrumental ignores its lyrics');
  assert.deepEqual(ace.aceLength('Match my lyrics', lyrics, false, 150), { seconds: 150, label: 'Match my lyrics' });
  for (const [said, seconds, label] of [['1:00', 60, '1:00'], ['3:00', 180, '3:00'], ['6:00', 360, '6:00'], ['03:00', 180, '3:00'], ['0:30', 30, '0:30'], ['2:35', 155, '2:35'], [' 4:00 ', 240, '4:00'], [180, 180, '3:00'], [95.4, 95, '1:35']])
    assert.deepEqual(ace.aceLength(said, lyrics, false, 360), { seconds, label }, String(said));
  assert.deepEqual(ace.aceLength('3:00', '', true, 360), { seconds: 180, label: '3:00' }, 'an instrumental can still choose a length');
  assert.throws(() => ace.aceLength('6:01', lyrics, false, 360), { message: 'Choose a length up to 6:00.' });
  assert.throws(() => ace.aceLength('7:00', lyrics, false, 360), { message: 'Choose a length up to 6:00.' });
  assert.throws(() => ace.aceLength('5:00', lyrics, false, 240), { message: 'Choose a length up to 4:00.' });
  assert.throws(() => ace.aceLength(361, lyrics, false, 360), { message: 'Choose a length up to 6:00.' });
  assert.throws(() => ace.aceLength('0:29', lyrics, false, 360), { message: 'Choose a length of at least 0:30.' });
  assert.throws(() => ace.aceLength(10, lyrics, false, 360), { message: 'Choose a length of at least 0:30.' });
  for (const said of ['long', '3', '3:5', '3:60', '3:00:00', '-1:00', 'one minute', NaN, Infinity, true, {}])
    assert.throws(() => ace.aceLength(said, lyrics, false, 360), { message: 'Under Length, choose Match my lyrics or a length such as 3:00.' }, String(said));
});

test('Quality: Fast is the turbo checkpoint, Best the sft one, nothing takes the default', () => {
  assert.equal(ace.aceModelChoice('Fast', {}), 'xl-turbo');
  assert.equal(ace.aceModelChoice('Best', {}), 'xl-sft');
  assert.equal(ace.aceModelChoice(' best ', {}), 'xl-sft');
  assert.equal(ace.aceModelChoice('FAST', {}), 'xl-turbo');
  assert.equal(ace.aceModelChoice(undefined, {}), 'xl-turbo');
  assert.equal(ace.aceModelChoice('', {}), 'xl-turbo');
  assert.equal(ace.aceModelChoice(undefined, { ACE_DEFAULT_MODEL: 'xl-sft' }), 'xl-sft');
  assert.equal(ace.aceModelChoice('Fast', { ACE_DEFAULT_MODEL: 'xl-sft' }), 'xl-turbo', 'a choice always beats the default');
  for (const said of ['Great', 'xl-turbo', 'xl-sft', 'Fast and Best', 7, true])
    assert.throws(() => ace.aceModelChoice(said, {}), { message: 'Under Quality, choose Fast or Best.' }, String(said));
});

test('parse: a good request, every default applied, and the fields ACE does not have ignored', () => {
  const input = ace.aceInput(base, {});
  assert.deepEqual(input, {
    style: 'Slow soul, 88 BPM, Rhodes',
    title: 'Slow soul, 88 BPM, Rhodes',
    count: 1,
    lyrics: '[Verse]\nWalking home\n[Chorus]\nHold on',
    duration: 30,
    model: 'xl-turbo',
    bpm: 88,
    length_choice: 'Match my lyrics',
    seed: 7,
  });
  assert.equal('instrumental' in input, false);
  const loud = ace.aceInput({ ...base, abc: 'X:1', band: 'soul', cot: 'full', weirdness: 5, steps: 99, guidance: 3, count: 4, my_voice: true, soundModel: 'x', keep_chords: 'Yes', style_strength: 0.3, duration: 9 }, {});
  assert.deepEqual(loud, input, 'YuE2 fields change nothing, and a take count of 4 is still one take');
  const chosen = ace.aceInput({ ...base, quality: 'Best', length: '3:00', title: '  My song  ' }, {});
  assert.equal(chosen.model, 'xl-sft');
  assert.equal(chosen.duration, 180);
  assert.equal(chosen.length_choice, '3:00');
  assert.equal(chosen.title, 'My song');
  assert.equal(ace.aceInput({ ...base }, { ACE_DEFAULT_MODEL: 'xl-sft' }).model, 'xl-sft');
  assert.equal(ace.aceInput({ ...base, length: '6:00' }, { ACE_MAX_SECONDS: '360' }).duration, 360);
  assert.throws(() => ace.aceInput({ ...base, length: '6:00' }, { ACE_MAX_SECONDS: '300' }), { message: 'Choose a length up to 5:00.' });
  assert.equal(ace.aceInput({ ...base, lyrics: `\n  ${base.lyrics}  \n` }, {}).lyrics, base.lyrics, 'surrounding blank space is the only thing trimmed');
  assert.equal(ace.aceInput({ ...base, script: 'One two three four five six seven eight nine ten' }, {}).title, 'One two three four five six seven');
  assert.equal(ace.aceInput({ ...base, script: `${'x'.repeat(200)} tail` }, {}).title.length, 80);
  assert.equal(ace.aceInput({ ...base, title: '' }, {}).title, 'Slow soul, 88 BPM, Rhodes');
  assert.equal('bpm' in ace.aceInput({ ...base, script: 'Slow soul, Rhodes' }, {}), false);
});

test('parse: the direction is kept as typed; only the worker caption drops the tempo', () => {
  const input = ace.aceInput({ ...base, script: 'Around 70 BPM, in D minor, warm alto' }, {});
  assert.equal(input.style, 'Around 70 BPM, in D minor, warm alto', 'her words are not edited in the project');
  assert.equal(input.bpm, 70);
  assert.equal(ace.aceRequest(input).caption, 'in D minor, warm alto');
  assert.equal(ace.aceInput({ ...base, script: '   a long direction   ' }, {}).style, 'a long direction');
  const huge = ace.aceInput({ ...base, script: `Warm soul. ${'more words '.repeat(290)}`.slice(0, 3000) }, {});
  assert.ok(huge.style.length <= 3000);
  assert.ok(Array.from(ace.aceRequest(huge).caption).length <= 512, 'a 3000-character direction is trimmed for the worker, not refused');
});

test('parse: an instrumental sends no words and sizes the song itself', () => {
  const input = ace.aceInput({ script: 'Banjo breakdown', singing: INSTRUMENTAL, seed: 3 }, {});
  assert.equal(input.instrumental, true);
  assert.equal(input.lyrics, '');
  assert.equal(input.duration, 120);
  assert.equal(input.length_choice, 'Match my lyrics');
  const withSheet = ace.aceInput({ script: 'Banjo breakdown', singing: INSTRUMENTAL, lyrics: sheet(60), seed: 3 }, {});
  assert.equal(withSheet.duration, 120, 'the leftover sheet does not size an instrumental');
  assert.equal(withSheet.lyrics, sheet(60), 'and is kept so the project reopens on it');
  assert.equal(ace.aceInput({ script: 'Banjo breakdown', singing: 'instrumental', seed: 3 }, {}).instrumental, true);
  assert.equal(ace.aceInput({ script: 'Banjo breakdown', singing: true, seed: 3 }, {}).instrumental, true);
  assert.equal('instrumental' in ace.aceInput({ ...base, singing: SUNG }, {}), false);
  assert.equal('instrumental' in ace.aceInput({ ...base, singing: 'sung' }, {}), false);
  assert.equal('instrumental' in ace.aceInput({ ...base, singing: false }, {}), false);
  assert.equal(ace.aceInput({ script: 'Banjo breakdown', singing: INSTRUMENTAL, length: '2:00' }, {}).duration, 120);
});

test('parse: every refusal is one plain sentence and nothing is cut to fit', () => {
  const DIRECTION = 'Describe the music in 3 to 3000 characters.';
  refusal({ ...base, reference_voice_url: 'https://assets.test/a.wav' }, 'ACE-Step XL does not take a recording to cover. Use YuE2 for covers.');
  refusal({ ...base, referenceExpected: true }, 'ACE-Step XL does not take a recording to cover. Use YuE2 for covers.');
  for (const script of [undefined, null, 42, '', '  ', 'ab', '  ab  ', 'x'.repeat(3001)]) refusal({ ...base, script }, DIRECTION);
  assert.equal(ace.aceInput({ ...base, script: 'abc' }, {}).style, 'abc');
  assert.equal(ace.aceInput({ ...base, script: 'x'.repeat(3000) }, {}).style.length, 3000);
  refusal({ ...base, title: 'x'.repeat(81) }, 'Use a title up to 80 characters.');
  refusal({ ...base, title: 7 }, 'Use a title up to 80 characters.');
  assert.equal(ace.aceInput({ ...base, title: 'x'.repeat(80) }, {}).title.length, 80);
  refusal({ ...base, singing: 'hummed' }, 'Under Singing or instrumental, choose Sung or Instrumental.');

  const WORDS = 'Add the words to sing in Lyrics, or choose Instrumental under Singing or instrumental.';
  for (const lyrics of [undefined, null, '', '   \n ', 12, {}]) refusal({ ...base, lyrics }, WORDS);
  const full = 'a'.repeat(4096);
  const kept = ace.aceInput({ ...base, lyrics: full }, {});
  assert.equal(kept.lyrics.length, 4096, '4096 characters go through whole');
  assert.equal(ace.aceRequest(kept).lyrics.length, 4096);
  refusal({ ...base, lyrics: `${full}a` }, 'Those lyrics are 4097 characters; ACE-Step XL reads at most 4096. Cut a verse or a repeated chorus and try again.');
  refusal({ ...base, lyrics: 'a'.repeat(9000) }, 'Those lyrics are 9000 characters; ACE-Step XL reads at most 4096. Cut a verse or a repeated chorus and try again.');
  const astral = '\u{1F3B5}'.repeat(4096);
  assert.equal(ace.aceInput({ ...base, lyrics: astral }, {}).lyrics, astral, 'counted in code points, as the worker counts: 4096 of them fit');
  refusal({ ...base, lyrics: `${astral}\u{1F3B5}` }, 'Those lyrics are 4097 characters; ACE-Step XL reads at most 4096. Cut a verse or a repeated chorus and try again.');
  refusal({ script: 'Banjo', singing: INSTRUMENTAL, lyrics: 'a'.repeat(4097) }, 'Keep Lyrics to 4096 characters. An instrumental sings none of them.');
  assert.equal(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, lyrics: full }, {}).instrumental, true);

  const SEED = 'Seed must be a whole number from 0 to 2147483647.';
  for (const seed of [-1, 1.5, 2147483648, NaN, Infinity, '5', true]) refusal({ ...base, seed }, SEED);
  assert.equal(ace.aceInput({ ...base, seed: 0 }, {}).seed, 0);
  assert.equal(ace.aceInput({ ...base, seed: 2147483647 }, {}).seed, 2147483647);
  for (const seed of [undefined, null]) {
    const picked = ace.aceInput({ ...base, seed }, {}).seed;
    assert.ok(Number.isInteger(picked) && picked >= 0 && picked <= 2147483647, `random seed ${picked}`);
  }
  refusal({ ...base, quality: 'Great' }, 'Under Quality, choose Fast or Best.');
  refusal({ ...base, length: '9:00' }, 'Choose a length up to 6:00.');
  refusal({ ...base, length: 'long' }, 'Under Length, choose Match my lyrics or a length such as 3:00.');
  /* The order a person meets them in: a recording first, then the direction, then the title, singing, words. */
  refusal({ script: '', title: 'x'.repeat(99), singing: 'hummed', lyrics: '', reference_voice_url: 'https://a.test/x.wav' }, 'ACE-Step XL does not take a recording to cover. Use YuE2 for covers.');
  refusal({ script: '', title: 'x'.repeat(99), singing: 'hummed', lyrics: '' }, DIRECTION);
  refusal({ script: 'Jazz', title: 'x'.repeat(99), singing: 'hummed', lyrics: '' }, 'Use a title up to 80 characters.');
  refusal({ script: 'Jazz', singing: 'hummed', lyrics: '' }, 'Under Singing or instrumental, choose Sung or Instrumental.');
  refusal({ script: 'Jazz', lyrics: '' }, WORDS);
  for (const sentence of [DIRECTION, WORDS, SEED]) assert.doesNotMatch(sentence, /Kade/);
});

test('request: exactly the worker contract, one take, no custom style, no key or time signature', () => {
  const input = ace.aceInput(base, {});
  const request = ace.aceRequest(input);
  assert.deepEqual(request, {
    model: 'xl-turbo',
    caption: 'Slow soul, Rhodes',
    lyrics: '[Verse]\nWalking home\n[Chorus]\nHold on',
    duration: 30,
    seed: 7,
    batch_size: 1,
    bpm: 88,
  });
  assert.deepEqual(Object.keys(request), ['model', 'caption', 'lyrics', 'duration', 'seed', 'batch_size', 'bpm']);
  for (const key of ['lora_key', 'mode', 'thinking', 'steps', 'guidance_scale', 'shift', 'vocal_language', 'keyscale', 'timesignature', 'count', 'instrumental'])
    assert.equal(key in request, false, `${key} is not sent`);
  const noTempo = ace.aceRequest(ace.aceInput({ ...base, script: 'Slow soul, Rhodes' }, {}));
  assert.equal('bpm' in noTempo, false);
  assert.equal(noTempo.caption, 'Slow soul, Rhodes');
  assert.equal(ace.aceRequest(ace.aceInput({ ...base, quality: 'Best' }, {})).model, 'xl-sft');
  assert.equal(ace.aceRequest(ace.aceInput({ ...base, length: '4:00' }, {})).duration, 240);
  assert.equal(ace.aceRequest({ ...input, seed: 8 }).seed, 8, 'the router sends each take its own seed');
  const instrumental = ace.aceRequest(ace.aceInput({ script: 'Banjo breakdown', singing: INSTRUMENTAL, lyrics: 'ignored words', seed: 1 }, {}));
  assert.equal(instrumental.lyrics, '[Instrumental]');
  assert.equal(instrumental.duration, 120);
  assert.equal(instrumental.batch_size, 1);
  const longDirection = ace.aceRequest(ace.aceInput({ ...base, script: `Soul ${'warm '.repeat(150)}` }, {}));
  assert.ok(Array.from(longDirection.caption).length <= 512);
  assert.deepEqual(ace.aceRequest(JSON.parse(JSON.stringify(input))), request, 'a request rebuilt from the stored job is the same');
  assert.equal(ace.aceRequest({ style: 'Jazz', title: 't', count: 1, seed: 1, lyrics: 'la' }).model, 'xl-turbo', 'a job saved without a model asks for the default');
  assert.equal(ace.aceRequest({ style: 'Jazz', title: 't', count: 1, seed: 1, lyrics: 'la' }).duration, 30);
});

test('estimate: length, quality, a note when the direction is cut, then the cost; no names, no figures', () => {
  const said = ace.aceEstimate(ace.aceInput({ ...base, length: '3:00' }, {}));
  assert.equal(said, `About 3:00 of music, fast quality. ${ace.aceCost}`);
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, quality: 'Best' }, {})), `About 0:30 of music, best quality. ${ace.aceCost}`);
  assert.equal(ace.aceEstimate(ace.aceInput({ ...base, lyrics: sheet(40) }, {})), `About 2:50 of music, fast quality. ${ace.aceCost}`);
  const cut = ace.aceEstimate(ace.aceInput({ ...base, script: `Soul ${'warm '.repeat(150)}` }, {}));
  assert.match(cut, /^About 0:30 of music, fast quality\. Only the first part of Music direction fits; ACE-Step XL reads 512 characters\. ACE-Step XL does not deduct/);
  assert.doesNotMatch(said, /Kade|\$|\d+\s*cents/);
  assert.match(ace.aceCost, /does not deduct from your credit balance/);
  assert.match(ace.aceCost, /billed by the second, including startup and two minutes awake after the last job; Best uses more\.$/);
});

test('the project keeps the settings in the words the guide shows, and the library line says what it is', () => {
  const sung = ace.aceProjectOptions(ace.aceInput({ ...base, quality: 'Best', length: '3:00' }, {}));
  assert.deepEqual(sung, { quality: 'Best', length: '3:00', singing: SUNG, lyrics: base.lyrics, seed: 7 });
  const matched = ace.aceProjectOptions(ace.aceInput(base, {}));
  assert.deepEqual(matched, { quality: 'Fast', length: 'Match my lyrics', singing: SUNG, lyrics: base.lyrics, seed: 7 });
  const card = ace.aceGuide({}).settings;
  const options = (key) => card.find((s) => s.key === key).options;
  assert.ok(options('quality').includes(sung.quality) && options('length').includes(sung.length) && options('singing').includes(sung.singing), 'every saved value is one the card offers');
  assert.ok(options('length').includes(matched.length));
  const played = ace.aceProjectOptions(ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, seed: 2 }, {}));
  assert.equal(played.singing, INSTRUMENTAL);
  assert.equal(played.lyrics, '');
  assert.deepEqual(Object.keys(sung), ['quality', 'length', 'singing', 'lyrics', 'seed']);

  assert.equal(ace.aceProjectWhy(undefined), 'ACE-Step XL — a song made on the sleeping music GPU');
  assert.equal(ace.aceProjectWhy({}), 'ACE-Step XL — a song made on the sleeping music GPU');
  assert.equal(ace.aceProjectWhy(matched), 'ACE-Step XL — a song made on the sleeping music GPU');
  assert.equal(ace.aceProjectWhy(sung), 'ACE-Step XL — a song made on the sleeping music GPU, best quality');
  assert.equal(ace.aceProjectWhy(played), 'ACE-Step XL — an instrumental made on the sleeping music GPU');
  assert.equal(ace.aceProjectWhy({ ...played, quality: 'Best' }), 'ACE-Step XL — an instrumental made on the sleeping music GPU, best quality');
  assert.ok(ace.aceProjectWhy(sung).split(/\s+/).length <= 14, 'one short phrase');
});

/* A worker answer shaped like the contract: take 0 at the top level, every take in `takes`. */
const WORKER_ANSWER = {
  engine: 'ace',
  model: 'xl-turbo',
  key: 'ace/0b7e/master.mp3',
  wav_key: 'ace/0b7e/master.wav',
  url: 'https://assets.test/ace/0b7e/master.mp3',
  wav_url: 'https://assets.test/ace/0b7e/master.wav',
  duration_s: 31.2,
  bytes: 1250000,
  seed: 7,
  processing_ms: 14100,
  truncated: false,
  takes: [{ index: 0, seed: 7, key: 'ace/0b7e/master.mp3', wav_key: 'ace/0b7e/master.wav', url: 'https://assets.test/ace/0b7e/master.mp3', wav_url: 'https://assets.test/ace/0b7e/master.wav', duration_s: 31.2, bytes: 1250000 }],
  timing: { model_load_s: 0, plan_s: 2.1, render_s: 9.8, encode_s: 1.1, upload_s: 0.9 },
  memory: { render_peak_gib: 21.4 },
  gpu: 'NVIDIA RTX A6000',
  features: ['ace-xl-turbo', 'ace-xl-sft', 'batch', 'instrumental', 'probe'],
  versions: { ace_step_commit: 'ca1e85f', torch: '2.8.0+cu128', worker: 'ace-1' },
  worker_notes: ['Used 8 steps.', 'The planner chose the key.'],
  plan: { bpm: 88, keyscale: 'A minor', duration: 31 },
};

test('a worker answer is read with take 0 at the top level; the top level wins when it is there', () => {
  assert.equal(ace.aceOutput(WORKER_ANSWER), WORKER_ANSWER, 'an answer shaped like the contract is the very same object');
  const { key: _key, wav_key: _wavKey, url: _url, wav_url: _wavUrl, duration_s: _seconds, bytes: _bytes, seed: _seed, ...listed } = WORKER_ANSWER;
  const lifted = ace.aceOutput(listed);
  const [first] = WORKER_ANSWER.takes;
  assert.deepEqual([lifted.key, lifted.wav_key, lifted.url, lifted.wav_url, lifted.duration_s, lifted.bytes, lifted.seed], [first.key, first.wav_key, first.url, first.wav_url, first.duration_s, first.bytes, first.seed]);
  assert.equal(lifted.gpu, WORKER_ANSWER.gpu, 'everything else is kept');
  assert.deepEqual(lifted.takes, WORKER_ANSWER.takes);
  assert.equal(ace.aceOutput({ ...listed, seed: 9 }).seed, 9, 'a seed the worker reported at the top is kept');
  const other = { ...WORKER_ANSWER, takes: [{ ...first, url: 'https://assets.test/ace/other/master.mp3' }] };
  assert.equal(ace.aceOutput(other).url, WORKER_ANSWER.url, 'the top level wins');
  for (const same of [{ error: 'The music model ran out of memory.' }, { takes: [] }, { takes: [{ index: 0, seed: 1 }] }, {}]) assert.equal(ace.aceOutput(same), same, JSON.stringify(same));
});

test('a finished take keeps the card, the checkpoint and what the planner chose, only when the worker said', () => {
  const input = ace.aceInput(base, {});
  assert.deepEqual(ace.aceTakeFacts(WORKER_ANSWER, input), { gpu: 'NVIDIA RTX A6000', model: 'xl-turbo', bpm: 88, keyscale: 'A minor' });
  assert.deepEqual(ace.aceTakeFacts(undefined, input), {});
  assert.deepEqual(ace.aceTakeFacts({ url: 'x' }, input), {}, 'an answer that says nothing adds nothing');
  assert.deepEqual(ace.aceTakeFacts({ ...WORKER_ANSWER, plan: undefined }, input), { gpu: 'NVIDIA RTX A6000', model: 'xl-turbo' });
  assert.deepEqual(ace.aceTakeFacts({ ...WORKER_ANSWER, plan: { bpm: 'fast', keyscale: 5 } }, input), { gpu: 'NVIDIA RTX A6000', model: 'xl-turbo' });
  assert.deepEqual(ace.aceTakeFacts({ ...WORKER_ANSWER, plan: { bpm: NaN } }, input), { gpu: 'NVIDIA RTX A6000', model: 'xl-turbo' });
  const played = ace.aceInput({ script: 'Banjo', singing: INSTRUMENTAL, seed: 2 }, {});
  assert.equal(ace.aceTakeFacts({ gpu: 'x' }, played).instrumental, true, 'an instrumental request says so');
  assert.equal(ace.aceTakeFacts({ gpu: 'x', instrumental: false }, played).instrumental, false, 'the worker has the last word');
  assert.equal('takeNote' in ace.aceTakeFacts(WORKER_ANSWER, input), false, 'engineering notes are not read to a listener');
});

test('cost: the card the worker names sets the price, an unnamed one is priced as the A40', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  near(yueTakeCost(60000, WORKER_ANSWER.gpu), 60 * 0.000339);
  near(yueTakeCost(90000, 'NVIDIA GeForce RTX 5090'), 90 * 0.000439);
  near(yueTakeCost(90000, 'NVIDIA L40S'), 90 * 0.000486);
  near(yueTakeCost(90000, 'NVIDIA RTX 6000 Ada Generation'), 90 * 0.000486);
  near(yueTakeCost(60000, 'A card from next year'), 60 * 0.000339);
  near(yueTakeCost(60000, undefined), (60000 / 3600000) * 1.22);
});

const EXPECTED_CARD = {
  name: 'ACE-Step XL',
  tagline: 'Songs with your own lyrics, in the style you describe.',
  where: 'Runs on a music GPU that sleeps between songs.',
  cost: ace.aceCost,
  bestFor: ['songs with your own lyrics', 'a quick draft to hear an idea', 'a longer song in one pass'],
  notFor: ['covers of a recording: use YuE2', 'cloning a singer’s voice'],
  howToWrite: [
    'Describe the style, instruments and singing voice in Music direction. A tempo such as 88 BPM is read out for you.',
    'Put the exact words under Lyrics, with [Verse] and [Chorus] tags. Words in (parentheses) are sung as backing vocals.',
    'Leave Length on Match my lyrics, or choose a length. Quality Best is slower and costs more.',
  ],
  settings: [
    { key: 'singing', label: 'Singing or instrumental', hint: 'Instrumental plays the tune on instruments and ignores any lyrics.', kind: 'choice', options: [SUNG, INSTRUMENTAL], default: SUNG },
    { key: 'lyrics', label: 'Lyrics', hint: 'The words to sing, with [Verse] and [Chorus] tags. Write my song idea can draft them.', kind: 'text' },
    { key: 'quality', label: 'Quality', hint: 'Fast is quick. Best is slower and costs more.', kind: 'choice', options: ['Fast', 'Best'], default: 'Fast' },
    { key: 'length', label: 'Length', hint: 'Match my lyrics sizes the song from your lyric lines.', kind: 'choice', options: ['Match my lyrics', '1:00', '2:00', '3:00', '4:00', '5:00', '6:00'], default: 'Match my lyrics' },
    { key: 'seed', label: 'Optional seed', hint: 'Leave blank for a new take; reuse a number for a similar start.', kind: 'number', min: 0, max: 2147483647, advanced: true },
  ],
};

test('the guide card: exact, short, advanced settings tucked away, defaults from the flags', () => {
  assert.deepEqual(ace.aceGuide({}), EXPECTED_CARD);
  assert.deepEqual(ace.aceGuide({ ACE_DEFAULT_MODEL: 'xl-turbo' }), EXPECTED_CARD);
  const best = ace.aceGuide({ ACE_DEFAULT_MODEL: 'xl-sft' });
  assert.equal(best.settings.find((s) => s.key === 'quality').default, 'Best');
  assert.deepEqual(best.settings.find((s) => s.key === 'quality').options, ['Fast', 'Best']);
  assert.deepEqual(ace.aceGuide({ ACE_MAX_SECONDS: '300' }).settings.find((s) => s.key === 'length').options, ['Match my lyrics', '1:00', '2:00', '3:00', '4:00', '5:00']);
  assert.deepEqual(ace.aceGuide({ ACE_MAX_SECONDS: '600' }).settings.find((s) => s.key === 'length').options.slice(-2), ['9:00', '10:00']);
  assert.deepEqual(ace.aceGuide({ ACE_MAX_SECONDS: '90' }).settings.find((s) => s.key === 'length').options, ['Match my lyrics', '1:00']);
  assert.deepEqual(ace.aceGuide({}).settings.filter((s) => s.advanced).map((s) => s.key), ['seed'], 'only the seed sits under More settings');
  assert.deepEqual(ace.aceGuide({}).settings.map((s) => s.key), ['singing', 'lyrics', 'quality', 'length', 'seed']);
  /* Every option the card offers is one the parser accepts, and every default is what an untouched card means. */
  const offered = (key) => ace.aceGuide({}).settings.find((s) => s.key === key).options;
  for (const quality of offered('quality')) ace.aceInput({ ...base, quality }, {});
  for (const length of offered('length')) ace.aceInput({ ...base, length }, {});
  for (const singing of offered('singing')) ace.aceInput({ ...base, singing }, {});
  const untouched = ace.aceInput(base, {});
  assert.equal(untouched.model, 'xl-turbo');
  assert.equal(untouched.length_choice, 'Match my lyrics');
  /* Her rules: the booth names no person and no private folder, and each hint is about one sentence. */
  const words = [EXPECTED_CARD.tagline, EXPECTED_CARD.where, ...EXPECTED_CARD.bestFor, ...EXPECTED_CARD.notFor, ...EXPECTED_CARD.howToWrite, ...EXPECTED_CARD.settings.flatMap((s) => [s.label, s.hint])];
  for (const text of words) assert.doesNotMatch(text, /Kade|Desktop|C:|F:|admin/i, text);
  for (const setting of EXPECTED_CARD.settings) assert.ok(setting.hint.split(/\s+/).length <= 20, setting.hint);
  for (const line of EXPECTED_CARD.howToWrite) assert.ok(line.split(/\s+/).length <= 25, line);
  assert.equal(EXPECTED_CARD.howToWrite.length, 3);
});

function sampleGuide() {
  return Object.freeze({
    starters: Object.freeze([]),
    engines: Object.freeze({
      scenema: Object.freeze({ name: 'AuK HQ' }),
      yue2: Object.freeze({ name: 'YuE2', settings: Object.freeze([{ key: 'lyrics' }]) }),
      lyria: Object.freeze({ name: 'Lyria' }),
    }),
  });
}

test('the guide for a person: the very same object unless they may use ACE, then the card last', () => {
  const admin = { role: 'ADMIN' }, user = { role: 'USER' };
  const guide = sampleGuide();
  for (const who of [admin, user, null, undefined]) assert.equal(ace.withAceGuide(guide, who, {}), guide, 'ACE_ENABLED unset: not a copy, the same object');
  assert.equal(ace.withAceGuide(guide, user, ON), guide, 'a USER while admin-only is on');
  assert.equal(ace.withAceGuide(guide, null, ON), guide);
  assert.equal(ace.withAceGuide(guide, admin, { ACE_ADMIN_ONLY: '0' }), guide, 'opening it to everyone does not turn it on');
  const shown = ace.withAceGuide(guide, admin, ON);
  assert.notEqual(shown, guide);
  assert.deepEqual(Object.keys(shown.engines), ['scenema', 'yue2', 'lyria', 'ace'], 'the card is placed last');
  assert.deepEqual(shown.engines.ace, EXPECTED_CARD);
  assert.equal(shown.engines.yue2, guide.engines.yue2, 'the YuE2 entry is the same object, untouched');
  assert.equal(shown.engines.lyria, guide.engines.lyria);
  assert.equal(shown.starters, guide.starters);
  assert.equal('ace' in guide.engines, false, 'the shared guide is never changed');
  assert.deepEqual(ace.withAceGuide(guide, user, { ...ON, ACE_ADMIN_ONLY: '0' }).engines.ace, EXPECTED_CARD);
  assert.deepEqual(ace.withAceGuide(guide, admin, { ...ON, ACE_DEFAULT_MODEL: 'xl-sft' }).engines.ace.settings[2].default, 'Best');
  assert.equal(JSON.stringify(ace.withAceGuide(guide, user, {})), JSON.stringify(guide), 'serialised, byte for byte');
});

test('the contract names: a worker answer is read by the shared router through take 0 at the top level', () => {
  /* createAudioRouter completes a take when response.output.url is set and output.error is not; the worker puts take 0 there. */
  assert.equal(typeof WORKER_ANSWER.url, 'string');
  assert.equal(WORKER_ANSWER.takes[0].url, WORKER_ANSWER.url);
  assert.equal(WORKER_ANSWER.takes[0].wav_url, WORKER_ANSWER.wav_url);
  assert.equal(WORKER_ANSWER.takes[0].seed, WORKER_ANSWER.seed);
  assert.equal(WORKER_ANSWER.takes.length, 1, 'the booth asks for one take');
});

test('an ACE take is a valid YuE2 cover source: its MP3 and its WAV master are owned by the account that made it', () => {
  /* The complete hook stores the MP3 as the asset's url and the WAV master as metadata.wavUrl, which is what the cover
   * check reads (the booth's audioReferenceGuard.savedSources). The worker writes to the same bucket as YuE2 does. */
  const env = { AWS_BUCKET_NAME: 'booth-bucket', AWS_ENDPOINT_URL: 'https://s3.example.test', AWS_REGION: 'us-east-1' };
  const signed = (key, signature) => `https://s3.example.test/booth-bucket/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${signature}`;
  const mp3 = 'ace/3f2c9a0e-5b1d-4c7a-9e11-0a6d2b7c8e44/master.mp3';
  const wav = 'ace/3f2c9a0e-5b1d-4c7a-9e11-0a6d2b7c8e44/master.wav';
  const saved = [signed(mp3, 'aaa'), signed(wav, 'aaa')];
  for (const value of [signed(mp3, 'aaa'), signed(wav, 'aaa'), signed(mp3, 'bbb'), signed(wav, 'ccc')])
    assert.equal(isOwnedAudioReference('someone', value, saved, env), true, value);
  assert.equal(isOwnedAudioReference('someone', signed('ace/11111111-5b1d-4c7a-9e11-0a6d2b7c8e44/master.mp3', 'aaa'), saved, env), false, 'another take is not theirs');
  assert.equal(isOwnedAudioReference('someone', signed(mp3, 'aaa'), [], env), false, 'an account with no such take');
  assert.equal(isOwnedAudioReference('someone', `http://s3.example.test/booth-bucket/${mp3}`, saved, env), false, 'https only');
  /* The same worker key shape that YuE2 uses (three parts), so the library re-signs it like any YuE2 take. */
  assert.match(mp3, /^[a-z0-9]+\/[0-9a-f-]{36}\/master\.mp3$/);
  assert.match(WORKER_ANSWER.key, /^ace\/[^/]+\/master\.mp3$/);
});
