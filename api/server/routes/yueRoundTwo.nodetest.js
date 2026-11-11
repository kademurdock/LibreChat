'use strict';
/* Nov 10 2026, round two: what the booth SENDS to the YuE2 worker for a trained style (packages/api/src/music/yue.ts).
 *
 * On by default: a short styled new song carries a length ceiling, a styled direction says the language once, and a plain
 * cover keeping its chords names its score's key. Built and OFF until they are switched on, after four test songs showed no
 * gain and one unusable take: bracketed directions lifted out of the lyrics (and, separately, added to the style), and
 * parenthesised backing phrases thinned. All of it happens when a request is sent, never when it is saved. With every
 * round-two switch set back the request is the one round one sent, key for key.
 *
 * Every line and lyric here is invented for the test. Nothing is sent anywhere.
 *
 * Run: node --test api/server/routes/yueRoundTwo.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const yue = require(path.resolve(__dirname, '../../../packages/api/src/music/yue.ts'));

const COVER = 'https://assets.test/cover.mp3';
const ON = { YUE_COVERS_V2: '1' };
const ROUND_ONE = { YUE_LIFT_DIRECTIONS: '0', YUE_STYLE_BACKING_MAX: '0', YUE_STYLE_LENGTH_CAP: '0', YUE_LANGUAGE_ONCE: '0', YUE_COVER_KEY: '0' };
const BEFORE_ROUND_ONE = { YUE_PREFORMAT: '0', YUE_SAMPLING_V2: '0', YUE_COVER_TEMPO_ALWAYS: '0' };
/* The three that are off until asked for, all asked for. */
const SHEET_ON = { YUE_LIFT_DIRECTIONS: 'styled', YUE_LIFT_FOLD: '1', YUE_STYLE_BACKING_MAX: '8' };

/* A sheet shaped like hers: directions on their own lines under a section tag, one inside a tag, one inside a sung line,
 * and backing phrases of every kind. */
const SHEET = [
  '[Intro]',
  '[strummed guitar, soft pads]',
  '',
  '[Verse 1]',
  'Paper boats along the drain (along the drain)',
  'Carry all the morning rain',
  'Window lights begin to glow (ooh)',
  'Telling stories soft and slow (soft and slow)',
  '',
  '[Chorus]',
  '[full band, layered vocals]',
  'Sing it loud and sing it clear (sing it clear)',
  'Every word for you to hear',
  '(We hear you now)',
  'Count the steps from one to ten (one to ten)',
  'Then we start the song again',
  '',
  '[Bridge - whispered]',
  '[drums drop out]',
  'Hold the quiet [spoken] in your hand',
  '(yeah, yeah)',
  '',
  '[Final Chorus]',
  '[belting]',
  'Sing it loud and sing it clear (sing it clear)',
  'Every word for you to hear',
  '(We hear you now)',
  'Count the steps from one to ten (one to ten)',
  'Then we start the song again',
  '',
  '[Hard Stop]',
].join('\n');
const saved = (body, env = ON) => yue.yueInput({ script: 'Warm soul, female lead vocal', lyrics: SHEET, seed: 11, ...body }, env);
const before = (input) => { const { my_voice: _myVoice, ...rest } = input; return rest; };
const SHAPES = {
  'a plain new song': {},
  'a styled new song': { band: 'soul', style_strength: 0.7 },
  'a styled new song whose direction opens with the language': { band: 'soul', script: 'English, 1990s R&B, warm keys' },
  'a plain cover keeping its chords': { reference_voice_url: COVER },
  'a styled cover keeping its chords': { band: 'soul', reference_voice_url: COVER },
  'a styled cover with a new accompaniment': { band: 'suno', reference_voice_url: COVER, keep_chords: 'No' },
  'a sung score': { abc: 'X:1\nK:C\nCDEF|', keep_chords: 'Yes' },
  'a styled short song': { band: 'kids', lyrics: '[Verse]\nOne short line\nAnother short line (short line)' },
  'an instrumental': { singing: 'Instrumental, no singing', lyrics: '[Verse]\n[Chorus]\n[big finish]' },
  'a song in her own voice': { my_voice: 'On' },
};

test.beforeEach(() => { process.env.YUE_STYLES_ENABLED = '1'; });
test.after(() => { delete process.env.YUE_STYLES_ENABLED; });

test('with every round-two switch set back, each kind of request is sent exactly as round one sent it', () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    const input = saved(body);
    const styled = !!input.lora_key;
    const sent = yue.yueWorkerInput(input, { ...ON, ...ROUND_ONE });
    for (const key of ['max_seconds', 'match_score_key', 'score_section_tags']) assert.equal(key in sent, false, `${name}: ${key}`);
    /* round one's own rule for the two things round two touches */
    assert.equal(sent.lyrics, yue.yueNativeLyrics(input.lyrics, styled), `${name}: lyrics`);
    assert.equal(sent.style, styled ? yue.yueTidyStyle(input.style, input.band) : input.style, `${name}: style`);
    /* and with round one's switches set back too, nothing at all is changed */
    assert.deepEqual(yue.yueWorkerInput(input, { ...ON, ...ROUND_ONE, ...BEFORE_ROUND_ONE }), before(input), name);
  }
});

test('sending never changes what was saved: the job keeps her own sheet, style and numbers', () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    const input = saved(body);
    const copy = JSON.parse(JSON.stringify(input));
    yue.yueWorkerInput(input, ON);
    yue.yueWorkerInput(input, { ...ON, ...SHEET_ON, YUE_LIFT_DIRECTIONS: 'all', YUE_COVER_KEY: 'all', YUE_COVER_SCORE_TAGS: '1' });
    assert.deepEqual(JSON.parse(JSON.stringify(input)), copy, name);
  }
  assert.equal(saved({ band: 'soul' }).lyrics, SHEET, 'yueInput itself still stores the sheet as typed');
});

test('lifting: section tags stay, a direction leaves the lyrics, and every sung word keeps its place', () => {
  const { lyrics, directions } = yue.yueLiftedLyrics(SHEET);
  assert.equal(lyrics, [
    '[Intro]',
    '',
    '[Verse 1]',
    'Paper boats along the drain (along the drain)',
    'Carry all the morning rain',
    'Window lights begin to glow (ooh)',
    'Telling stories soft and slow (soft and slow)',
    '',
    '[Chorus]',
    'Sing it loud and sing it clear (sing it clear)',
    'Every word for you to hear',
    '(We hear you now)',
    'Count the steps from one to ten (one to ten)',
    'Then we start the song again',
    '',
    '[Bridge]',
    'Hold the quiet in your hand',
    '(yeah, yeah)',
    '',
    '[Final Chorus]',
    'Sing it loud and sing it clear (sing it clear)',
    'Every word for you to hear',
    '(We hear you now)',
    'Count the steps from one to ten (one to ten)',
    'Then we start the song again',
  ].join('\n'));
  assert.deepEqual(directions, [
    { section: 'intro', text: 'strummed guitar, soft pads' },
    { section: 'chorus', text: 'full band, layered vocals' },
    { section: 'bridge', text: 'whispered' },
    { section: 'bridge', text: 'drums drop out' },
    { section: 'bridge', text: 'spoken' },
    { section: 'final chorus', text: 'belting' },
    { section: 'ending', text: 'Hard Stop' },
  ]);
  /* the words that are sung, in order, are the same before and after */
  const sung = (sheet) => sheet.split('\n').map((line) => line.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(sung(lyrics), sung(SHEET));
});

test('lifting: what counts as a section and what counts as a direction', () => {
  const lift = (sheet) => yue.yueLiftedLyrics(sheet);
  /* every tag YuE2 knows, numbered or not, stays exactly as typed */
  const known = '[Intro]\n[Verse 1]\nla\n[Pre-Chorus]\nla\n[Post-Chorus]\nla\n[Guitar Solo]\n[Middle 8]\nla\n[Outro]\nla';
  assert.deepEqual(lift(known), { lyrics: known, directions: [] });
  /* a section name with a direction keeps the name; the direction goes */
  for (const [tag, head, text] of [
    ['[Final Chorus - belting]', '[Final Chorus]', 'belting'],
    ['[Verse 2: spoken]', '[Verse 2]', 'spoken'],
    ['[Outro, fading out]', '[Outro]', 'fading out'],
    ['[Chorus (big, wide)]', '[Chorus]', 'big, wide'],
    ['[Final Chorus belting]', '[Final Chorus]', 'belting'],
    ['[Rap Verse]', '[Verse]', 'Rap'],
    ['[Pre-Chorus - soft]', '[Pre-Chorus]', 'soft'],
  ]) {
    const got = lift(`${tag}\nA sung line`);
    assert.equal(got.lyrics, `${head}\nA sung line`, tag);
    assert.equal(got.directions.length, 1, tag);
    assert.equal(got.directions[0].text, text, tag);
  }
  /* a repeat is not a direction: it stays as typed, wherever it stands */
  for (const tag of ['[Chorus x2]', '[Chorus 2x]', '[Verse x 2]'])
    assert.deepEqual(lift(`[Verse]\nla\n${tag}\nla la`), { lyrics: `[Verse]\nla\n${tag}\nla la`, directions: [] }, tag);
  /* an unknown tag that opens a block of sung words is doing a section's job: it stays */
  const block = '[Verse]\nla la\n\n[Half-Time Breakdown]\nSlow it down now\n\n[Chorus]\nla';
  assert.deepEqual(lift(block), { lyrics: block, directions: [] });
  /* the same tag right under a section tag, or between sung lines, is a direction */
  assert.equal(lift('[Bridge]\n[Half-Time Breakdown]\nSlow it down now').lyrics, '[Bridge]\nSlow it down now');
  assert.equal(lift('[Verse]\nla la\n[belting]\nla la la').lyrics, '[Verse]\nla la\nla la la');
  /* a direction with no sung words after it, alone between blank lines, is a break or the ending */
  assert.deepEqual(lift('[Verse]\nla\n\n[Band Drops Out]\n\n[Chorus]\nla la').directions, [{ section: 'break', text: 'Band Drops Out' }]);
  assert.equal(lift('[Verse]\nla\n\n[Band Drops Out]\n\n[Chorus]\nla la').lyrics, '[Verse]\nla\n\n[Chorus]\nla la');
  /* brackets inside a sung line: the words stay, the bracket goes; a line that was only brackets and marks is gone */
  assert.equal(lift('[Verse]\n[softly] Hold on , [louder] hold on').lyrics, '[Verse]\nHold on, hold on');
  /* repeated section names are numbered in what is folded, so two choruses are told apart */
  assert.deepEqual(lift('[Chorus]\n[big]\nla\n\n[Chorus]\n[bigger]\nla').directions, [{ section: 'chorus 1', text: 'big' }, { section: 'chorus 2', text: 'bigger' }]);
  /* before any section */
  assert.deepEqual(lift('[soft piano]\n[Verse]\nla').directions, [{ section: 'opening', text: 'soft piano' }]);
  /* an empty or wordless bracket is dropped without a direction */
  assert.deepEqual(lift('[Verse]\nla la []\n[ ... ]\nla'), { lyrics: '[Verse]\nla la\nla', directions: [] });
  /* a sheet with nothing to lift comes back the very same string */
  for (const sheet of ['', '[Verse]\n\n\n\nla la  \n\n\n[Chorus]\nla (la)\n', 'no tags at all\njust words'])
    assert.equal(lift(sheet).lyrics, sheet);
});

test('folding: the lifted directions follow the style, section by section, inside their room', () => {
  const { directions } = yue.yueLiftedLyrics(SHEET);
  assert.equal(
    yue.yueFoldedStyle('Warm soul, female lead vocal, 92 BPM.', directions),
    'Warm soul, female lead vocal, 92 BPM, arrangement: intro - strummed guitar, soft pads; chorus - full band, layered vocals; bridge - whispered, drums drop out, spoken; final chorus - belting; ending - Hard Stop',
  );
  assert.equal(yue.yueFoldedStyle('Warm soul', []), 'Warm soul');
  /* the same direction twice in one section is said once */
  assert.equal(yue.yueFoldedStyle('Soul', [{ section: 'bridge', text: 'Drums drop out' }, { section: 'bridge', text: 'drums drop out' }]), 'Soul, arrangement: bridge - Drums drop out');
  /* whole sections only, never past the room */
  const many = Array.from({ length: 30 }, (_, index) => ({ section: `part ${index + 1}`, text: 'a long direction about the band and the room' }));
  const folded = yue.yueFoldedStyle('Soul', many);
  assert.ok(folded.length <= 'Soul, arrangement: '.length + 320, String(folded.length));
  assert.ok(folded.endsWith('a long direction about the band and the room'));
  assert.equal(yue.yueFoldedStyle('Soul', many, 10), 'Soul', 'no room, no change');
  /* never past the 3000 characters a style may have */
  const long = 'x'.repeat(2990);
  assert.equal(yue.yueFoldedStyle(long, directions), long);
});

test('thinning: echoes go first, then wordless fills, and a reply with new words goes last', () => {
  const lifted = yue.yueLiftedLyrics(SHEET).lyrics;
  const all = yue.yueThinnedBacking(lifted, 99);
  assert.deepEqual(all, { lyrics: lifted, total: 10, removed: 0 }, 'at or under the limit the sheet is the very same string');
  assert.equal(yue.yueThinnedBacking(lifted, 10).lyrics, lifted);
  /* 10 phrases to 8: the two verse echoes */
  const eight = yue.yueThinnedBacking(lifted, 8);
  assert.equal(eight.removed, 2);
  assert.match(eight.lyrics, /Paper boats along the drain\nCarry all the morning rain\nWindow lights begin to glow \(ooh\)\nTelling stories soft and slow\n/);
  assert.match(eight.lyrics, /sing it clear \(sing it clear\)/);
  /* to 4: the chorus echoes too, in both choruses together, so the two choruses still match */
  const four = yue.yueThinnedBacking(lifted, 4);
  assert.equal(four.removed, 6);
  assert.doesNotMatch(four.lyrics, /\(sing it clear\)|\(one to ten\)|\(along the drain\)|\(soft and slow\)/);
  assert.equal(four.lyrics.match(/\(We hear you now\)/g).length, 2);
  assert.match(four.lyrics, /\(ooh\)/);
  assert.match(four.lyrics, /\(yeah, yeah\)/);
  /* to 2: the wordless fills go, the replies stay */
  const two = yue.yueThinnedBacking(lifted, 2);
  assert.equal(two.removed, 8);
  assert.doesNotMatch(two.lyrics, /\(ooh\)|\(yeah, yeah\)/);
  assert.equal(two.lyrics.match(/\(We hear you now\)/g).length, 2);
  /* to 0: everything, and a line that was only a backing phrase is gone with it */
  const none = yue.yueThinnedBacking(lifted, 0);
  assert.equal(none.removed, 10);
  assert.doesNotMatch(none.lyrics, /[()]/);
  /* the lead words, in order, never change */
  const lead = (sheet) => sheet.split('\n').map((line) => line.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const thin of [eight, four, two, none]) assert.deepEqual(lead(thin.lyrics), lead(lifted));
  /* section tags never move, and a parenthesis with no word in it is not a backing phrase */
  assert.deepEqual(yue.yueThinnedBacking('[Verse (soft)]\nla la (2)\nla (la)', 0), { lyrics: '[Verse (soft)]\nla la (2)\nla', total: 1, removed: 1 });
});

test('by default the sheet goes as round one sent it: nothing is lifted, folded or thinned until it is switched on', () => {
  for (const body of [{ band: 'soul' }, {}, { band: 'suno', reference_voice_url: COVER }]) {
    const input = saved(body);
    const sent = yue.yueWorkerInput(input, ON);
    assert.equal(sent.lyrics, yue.yueNativeLyrics(SHEET, !!input.lora_key));
    assert.doesNotMatch(sent.style, /arrangement:/);
    assert.match(sent.lyrics, /\[spoken\]/);
    assert.equal((sent.lyrics.match(/\([^()]*\)/g) || []).length, 10);
  }
  assert.equal(yue.yueLiftDirections({}), 'off');
  assert.equal(yue.yueLiftDirections({ YUE_LIFT_DIRECTIONS: 'styled' }), 'styled');
  assert.equal(yue.yueLiftDirections({ YUE_LIFT_DIRECTIONS: '1' }), 'styled');
  assert.equal(yue.yueLiftDirections({ YUE_LIFT_DIRECTIONS: ' ALL ' }), 'all');
  for (const off of ['0', 'off', 'nonsense', '']) assert.equal(yue.yueLiftDirections({ YUE_LIFT_DIRECTIONS: off }), 'off', off);
  assert.equal(yue.yueFoldDirectionsEnabled({}), false);
  assert.equal(yue.yueFoldDirectionsEnabled({ YUE_LIFT_FOLD: '1' }), true);
  assert.equal(yue.yueFoldDirectionsEnabled({ YUE_LIFT_FOLD: 'yes' }), false);
  assert.equal(yue.yueBackingMax({}), undefined);
  assert.equal(yue.yueBackingMax({ YUE_STYLE_BACKING_MAX: '8' }), 8);
  assert.equal(yue.yueBackingMax({ YUE_STYLE_BACKING_MAX: '12' }), 12);
  for (const off of ['0', 'off', 'false', 'No', 'lots', '-3']) assert.equal(yue.yueBackingMax({ YUE_STYLE_BACKING_MAX: off }), undefined, off);
});

test('switched on: a styled song is sent the lifted, thinned sheet, with the directions in its style only when folding is on too', () => {
  const styled = yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, ...SHEET_ON });
  assert.doesNotMatch(styled.lyrics, /spoken|belting|drums drop out|strummed|Hard Stop|whispered/);
  assert.match(styled.lyrics, /^\[intro\]\n\n\[verse\]\nPaper boats along the drain\n/);
  assert.match(styled.lyrics, /\n\[bridge\]\nHold the quiet in your hand\n/);
  assert.equal((styled.lyrics.match(/\([^()]*\)/g) || []).length, 8, 'at most eight backing phrases');
  assert.equal(styled.style, `${yue.yueStyles.soul.lead} Warm soul, female lead vocal, arrangement: intro - strummed guitar, soft pads; chorus - full band, layered vocals; bridge - whispered, drums drop out, spoken; final chorus - belting; ending - Hard Stop`);
  /* lifting without folding: the directions leave the sheet and go nowhere */
  const noFold = yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, ...SHEET_ON, YUE_LIFT_FOLD: '0' });
  assert.equal(noFold.lyrics, styled.lyrics);
  assert.equal(noFold.style, `${yue.yueStyles.soul.lead} Warm soul, female lead vocal`);
  /* folding without lifting does nothing: there is nothing lifted to fold */
  const foldOnly = yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, YUE_LIFT_FOLD: '1' });
  assert.match(foldOnly.lyrics, /\[spoken\]/);
  assert.doesNotMatch(foldOnly.style, /arrangement:/);
  /* thinning alone */
  const thinOnly = yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, YUE_STYLE_BACKING_MAX: '3' });
  assert.match(thinOnly.lyrics, /\[spoken\]/);
  assert.equal((thinOnly.lyrics.match(/\([^()]*\)/g) || []).length, 3);
  /* "styled" leaves plain YuE2 alone: its own guide says a tag such as [saxophone solo] can help there */
  const plain = yue.yueWorkerInput(saved({}), { ...ON, ...SHEET_ON });
  assert.equal(plain.lyrics, yue.yueNativeLyrics(SHEET, false));
  assert.equal(plain.style, 'Warm soul, female lead vocal');
  /* "all" lifts for plain YuE2 too; backing phrases are thinned for a trained style only */
  const asked = yue.yueWorkerInput(saved({}), { ...ON, ...SHEET_ON, YUE_LIFT_DIRECTIONS: 'all' });
  assert.doesNotMatch(asked.lyrics, /spoken|belting|drums drop out/);
  assert.equal((asked.lyrics.match(/\([^()]*\)/g) || []).length, 10);
  assert.match(asked.style, /^Warm soul, female lead vocal, arrangement: intro - /);
  /* an instrumental's tags only guide the plan: they are left as they are */
  const instrumental = yue.yueWorkerInput(saved({ singing: 'Instrumental, no singing', lyrics: '[Verse]\n[big finish]' }), { ...ON, ...SHEET_ON, YUE_LIFT_DIRECTIONS: 'all' });
  assert.equal(instrumental.lyrics, '[Verse]\n[big finish]');
});

test('the length ceiling: generous for a short sheet, never set for a long one, and only for a styled new song', () => {
  const sheet = (lines) => `[Verse]\n${Array.from({ length: lines }, (_, index) => `Sung line number ${index + 1}`).join('\n')}`;
  assert.equal(yue.yueLengthCapSeconds(sheet(16)), 222);
  assert.equal(yue.yueLengthCapSeconds(sheet(4)), 168);
  assert.equal(yue.yueLengthCapSeconds(sheet(20)), 240);
  assert.equal(yue.yueLengthCapSeconds(sheet(30)), 330);
  assert.equal(yue.yueLengthCapSeconds(sheet(31)), 339);
  for (const long of [32, 45, 57, 66, 77]) assert.equal(yue.yueLengthCapSeconds(sheet(long)), undefined, `${long} lines`);
  assert.equal(yue.yueLengthCapSeconds('[Verse]\n[Chorus]\n\n'), undefined, 'no sung line, no ceiling');
  /* the measured takes it has to clear: a 16-line test sheet ran 158 s; nothing she made on 57 to 77 lines gets a ceiling */
  assert.ok(yue.yueLengthCapSeconds(sheet(16)) > 158 * 1.3);
  /* tags, blank lines and bracket-only lines are not sung lines; a backing line is */
  assert.equal(yue.yueLengthCapSeconds('[Verse]\nla la\n\n[big]\n(ooh)\n[Chorus]\nla'), yue.yueLengthCapSeconds(sheet(3)));
  const short = { band: 'kids', lyrics: sheet(16) };
  assert.equal(yue.yueWorkerInput(saved(short), ON).max_seconds, 222);
  assert.equal(yue.yueWorkerInput(saved(short), { ...ON, YUE_STYLE_LENGTH_CAP: '0' }).max_seconds, undefined);
  assert.equal(yue.yueWorkerInput(saved({ lyrics: sheet(16) }), ON).max_seconds, undefined, 'plain YuE2 writes a score: no ceiling');
  assert.equal(yue.yueWorkerInput(saved({ ...short, reference_voice_url: COVER }), ON).max_seconds, undefined, 'a cover has its own length guard');
  assert.equal(yue.yueWorkerInput(saved({ ...short, abc: 'X:1\nK:C\nCDEF|' }), ON).max_seconds, undefined);
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), ON).max_seconds, 222, 'the test sheet has 16 sung lines; a bracket-only line is not one');
  assert.equal(yue.yueWorkerInput(saved({ band: 'soul' }), { ...ON, ...SHEET_ON }).max_seconds, 222, 'the same once its directions are lifted');
  assert.equal(yue.yueWorkerInput(saved({ ...short, style_strength: 0 }), ON).max_seconds, undefined, 'strength 0 is plain YuE2');
});

test('a Soul or Kids direction that opens with the language says it once', () => {
  const style = (script, band, env = ON) => yue.yueWorkerInput(saved({ band, script, lyrics: '[Verse]\nla la' }), env).style;
  assert.equal(style('English, 1990s R&B, warm keys', 'soul'), `${yue.yueStyles.soul.lead} 1990s R&B, warm keys`);
  assert.equal(style('American English, bright pop, hand claps', 'kids'), `${yue.yueStyles.kids.lead} bright pop, hand claps`);
  assert.equal(style('English, 1990s R&B, warm keys', 'soul', { ...ON, YUE_LANGUAGE_ONCE: '0' }), `${yue.yueStyles.soul.lead} English, 1990s R&B, warm keys`);
  /* not a language at the front, another language, or no comma: left whole */
  assert.equal(style('English slow jam', 'soul'), `${yue.yueStyles.soul.lead} English slow jam`);
  assert.equal(style('Spanish, bolero, slow', 'soul'), `${yue.yueStyles.soul.lead} Spanish, bolero, slow`);
  assert.equal(style('Englishman in the rain, folk', 'soul'), `${yue.yueStyles.soul.lead} Englishman in the rain, folk`);
  /* the writing desk opened its first rich direction "English vocals,": that is the language again, under any lead */
  assert.equal(style('English vocals, 90s R&B slow jam, 66 BPM', 'soul'), `${yue.yueStyles.soul.lead} 90s R&B slow jam, 66 BPM`);
  assert.equal(style('English vocals, 90s R&B slow jam, 66 BPM', 'suno'), 'kdsuno, in the style of kdsuno. English, 90s R&B slow jam, 66 BPM');
  assert.equal(style('English lyrics, folk', 'sona'), 'kdsona, in the style of kdsona. English, folk');
  assert.equal(style('English vocals, 90s R&B', 'suno', { ...ON, YUE_LANGUAGE_ONCE: '0' }), 'kdsuno, in the style of kdsuno. English, vocals, 90s R&B', 'round one alone takes only the word');
  /* Suno and Sona leads end "English,": a bare "English," there is round one's rule (yueTidyStyle), unchanged */
  assert.equal(style('English, slow jam R&B', 'suno'), 'kdsuno, in the style of kdsuno. English, slow jam R&B');
  assert.equal(style('English, slow jam R&B', 'suno', { ...ON, YUE_PREFORMAT: '0' }), 'kdsuno, in the style of kdsuno. English, English, slow jam R&B');
  assert.equal(yue.yueLanguageOnce('English, English folk', undefined), 'English, English folk');
  assert.equal(yue.yueLanguageOnce('English, English folk', 'constructor'), 'English, English folk');
  assert.equal(yue.yueWorkerInput(saved({ script: 'English, folk, fiddle' }), ON).style, 'English, folk, fiddle', 'plain YuE2 keeps the direction whole');
});

test('a plain cover keeping its chords asks the worker to name the score\'s key, unless Music direction names one', () => {
  const sent = (body, env = ON) => yue.yueWorkerInput(saved(body), env);
  assert.equal(sent({ reference_voice_url: COVER }).match_score_key, true);
  assert.equal(sent({ abc: 'X:1\nK:C\nCDEF|', keep_chords: 'Yes' }).match_score_key, true);
  /* a trained style's captions never named a key: it waits to be asked for */
  assert.equal(sent({ band: 'soul', reference_voice_url: COVER }).match_score_key, undefined);
  assert.equal(sent({ band: 'soul', reference_voice_url: COVER }, { ...ON, YUE_COVER_KEY: 'all' }).match_score_key, true);
  /* a new accompaniment: a misread key could steer the new chords, so it waits to be asked for too */
  assert.equal(sent({ reference_voice_url: COVER, keep_chords: 'No' }).match_score_key, undefined);
  assert.equal(sent({ reference_voice_url: COVER, keep_chords: 'No' }, { ...ON, YUE_COVER_KEY: 'all' }).match_score_key, true);
  assert.equal(sent({ abc: 'X:1\nK:C\nCDEF|', keep_chords: 'No' }).match_score_key, undefined);
  /* a new song has no score to read a key from */
  assert.equal(sent({}).match_score_key, undefined);
  assert.equal(sent({ band: 'soul' }, { ...ON, YUE_COVER_KEY: 'all' }).match_score_key, undefined);
  /* her own key wins */
  for (const script of ['Slow jam in A minor', 'G major folk, fiddle', 'Soul, key of D', 'B-flat major swing', 'F# minor ballad', 'Bb maj jazz'])
    assert.equal(sent({ reference_voice_url: COVER, script }).match_score_key, undefined, script);
  /* "a minor" in plain words reads as a key too; the only cost is that the key is not added */
  assert.equal(sent({ reference_voice_url: COVER, script: 'Soul in a minor mood, organ' }).match_score_key, undefined);
  assert.equal(sent({ reference_voice_url: COVER, script: 'Amazing gospel, big choir' }).match_score_key, true);
  for (const off of ['0', 'off']) assert.equal(sent({ reference_voice_url: COVER }, { ...ON, YUE_COVER_KEY: off }).match_score_key, undefined);
  assert.equal(yue.yueCoverKey({}), 'plain');
  assert.equal(yue.yueCoverKey({ YUE_COVER_KEY: 'ALL' }), 'all');
});

test('a cover\'s tags from its score: off unless it is switched on, and only for a sung cover of a recording', () => {
  const sent = (body, env = ON) => yue.yueWorkerInput(saved(body), env);
  assert.equal(sent({ reference_voice_url: COVER }).score_section_tags, undefined);
  const on = { ...ON, YUE_COVER_SCORE_TAGS: '1' };
  assert.equal(sent({ reference_voice_url: COVER }, on).score_section_tags, true);
  assert.equal(sent({ abc: 'X:1\nK:C\nCDEF|' }, on).score_section_tags, undefined);
  assert.equal(sent({}, on).score_section_tags, undefined);
  assert.equal(sent({ reference_voice_url: COVER, singing: 'Instrumental, no singing' }, on).score_section_tags, undefined);
});
