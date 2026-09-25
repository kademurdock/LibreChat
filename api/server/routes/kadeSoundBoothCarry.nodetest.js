/* Carrying a project between engines.
 *
 * The whole of the carry is pure, which is on purpose: the thing that must not
 * go wrong is that HER WORDS survive the hop, and that is a property you can
 * assert rather than a thing you hope about.
 *
 * Run: node --test api/server/routes/kadeSoundBoothCarry.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const carry = require('./kadeSoundBoothCarry');

const LYRICS = [
  '[Verse 1]',
  'The porch light stays on past midnight',
  'and the gravel remembers the car',
  '',
  '[Chorus]',
  'Come back the long way (the long way)',
  'Come back however you are',
].join('\n');

const LYRIA = {
  _id: 'abc123',
  engine: 'lyria',
  title: 'The Long Way',
  mode: 'easy',
  sourceText: 'a slow country song about somebody driving home late',
  script:
    'A modern Nashville country ballad, unhurried and plainspoken. A pedal steel ' +
    'carries the long notes, brushed drums keep it soft, an upright bass walks ' +
    'underneath. [Intro] -> [Verse 1] -> [Chorus] -> [Outro]. A female vocalist, ' +
    'warm alto, close to the microphone. Melancholy, hopeful. Around 70 BPM, in D ' +
    'minor, a three-minute song.\n\nLyrics:\n' + LYRICS,
  options: { instrumental: false, seed: 42 },
};

const YUE = {
  _id: 'def456',
  engine: 'yue2',
  title: 'The Long Way',
  mode: 'easy',
  sourceText: 'a slow country song about somebody driving home late',
  script: 'English, country ballad, female lead vocal, pedal steel, slow.',
  options: {
    lyrics: LYRICS,
    band: 'soul',
    abc: 'X:1\nT:none\n',
    weirdness: 0.4,
    guidance: 3,
    seed: 42,
    count: 2,
  },
};

const AUK = {
  _id: 'ghi789',
  engine: 'scenema',
  title: 'The Voicemail',
  mode: 'advanced',
  sourceText: 'read this like you are leaving a message you will regret',
  script: '<speak voice="a tired woman in her fifties" gender="female">I got your note.</speak>',
  voiceSeed: 8123,
  options: { reference_voice_url: 'https://example.invalid/clip.wav', pace: 1.5 },
};

test('the lyrics and their tags jump over, which is the whole ask', () => {
  const out = carry.carryOver(YUE, 'lyria');
  assert.strictEqual(out.ok, true, out.why);
  assert.strictEqual(out.draft.options.lyrics, LYRICS, 'the words changed on the way');
  assert.ok(/\[Chorus\]/.test(out.draft.options.lyrics), 'the section tags did not survive');
  assert.ok(out.notes.some((n) => /section tags/i.test(n)), 'nothing said the tags came across');
});

test('Lyria keeps its words inside the brief, and they come out into the lyrics field', () => {
  const out = carry.carryOver(LYRIA, 'yue2');
  assert.strictEqual(out.ok, true, out.why);
  assert.strictEqual(out.draft.options.lyrics, LYRICS);
  assert.ok(!/Lyrics:/i.test(out.draft.script), 'the words were left duplicated in the style text');
  assert.ok(/pedal steel/.test(out.draft.script), 'the description did not come across');
});

test('her own typed words survive every hop', () => {
  for (const [project, to] of [[LYRIA, 'yue2'], [YUE, 'lyria'], [AUK, 'seed'], [AUK, 'stable']]) {
    const out = carry.carryOver(project, to);
    assert.strictEqual(out.ok, true, out.why);
    assert.strictEqual(out.draft.sourceText, project.sourceText, `${project.engine} -> ${to}`);
  }
});

test('a carry is a NEW draft and never a finished project', () => {
  const out = carry.carryOver(YUE, 'lyria');
  assert.strictEqual(out.draft.state, 'draft');
  for (const key of ['assets', 'jobs', 'parts', 'costUSD', 'lastRenderAt', 'stitchedAssetId']) {
    assert.strictEqual(out.draft[key], undefined, `${key} was carried and should not have been`);
  }
  assert.deepStrictEqual(out.draft.options.carriedFrom, { project: 'def456', engine: 'yue2' });
});

test('engine-private knobs are dropped, and the drop is said out loud', () => {
  const out = carry.carryOver(YUE, 'lyria');
  for (const key of ['band', 'abc', 'weirdness', 'guidance']) {
    assert.strictEqual(out.draft.options[key], undefined, `${key} was carried to an engine that has no such thing`);
  }
  const said = out.notes.join(' ');
  for (const word of ['trained style', 'composition score', 'weirdness', 'guidance']) {
    assert.ok(said.includes(word), `nothing told her ${word} was left behind`);
  }
});

test('steps is NOT carried between engines that mean different things by it', () => {
  /* YuE2 steps and Stable Audio steps are the same word for different dials.
   * Carrying the number would silently ruin a render. */
  const out = carry.carryOver({ ...YUE, options: { ...YUE.options, steps: 1800 } }, 'lyria');
  assert.strictEqual(out.draft.options.steps, undefined);
  assert.ok(!carry.SHARED_KNOBS.includes('steps'));
});

test('the seed carries where both engines have one', () => {
  assert.strictEqual(carry.carryOver(YUE, 'lyria').draft.options.seed, 42);
  assert.strictEqual(carry.carryOver(LYRIA, 'yue2').draft.options.seed, 42);
});

test('an imported recording follows under whichever name the new engine uses', () => {
  const toSeed = carry.carryOver(AUK, 'seed');
  assert.deepStrictEqual(toSeed.draft.options.audio_urls, ['https://example.invalid/clip.wav']);
  const toStable = carry.carryOver(AUK, 'stable');
  assert.strictEqual(toStable.draft.options.audio_urls, undefined);
  assert.ok(toStable.notes.some((n) => /stayed behind/.test(n)));
});

test('AuK XML is handed on as a screenplay, never as XML', () => {
  const out = carry.carryOver(AUK, 'seed', { toScreenplay: () => 'WOMAN: I got your note.' });
  assert.strictEqual(out.draft.script, 'WOMAN: I got your note.');
  assert.ok(!/<speak/.test(out.draft.script));
});

test('a song cannot be carried into a sound engine, and the refusal says why', () => {
  const out = carry.carryOver(LYRIA, 'stable');
  assert.strictEqual(out.ok, false);
  assert.ok(/music/.test(out.why) && /sound/.test(out.why), out.why);
  assert.strictEqual(carry.carryOver(LYRIA, 'lyria').ok, false, 'carrying to itself was allowed');
  assert.strictEqual(carry.carryOver(LYRIA, 'nonesuch').ok, false);
  assert.strictEqual(carry.carryOver({ engine: 'nonesuch' }, 'lyria').ok, false);
});

test('the destinations offered are only the ones that make sense', () => {
  assert.deepStrictEqual(carry.destinationsFor('lyria').map((d) => d.engine), ['yue2']);
  assert.deepStrictEqual(carry.destinationsFor('yue2').map((d) => d.engine), ['lyria']);
  assert.deepStrictEqual(carry.destinationsFor('scenema').map((d) => d.engine).sort(), ['seed', 'stable']);
  assert.deepStrictEqual(carry.destinationsFor('seed').map((d) => d.engine).sort(), ['scenema', 'stable']);
  assert.deepStrictEqual(carry.destinationsFor('nonesuch'), []);
  /* Every destination on offer must actually accept the carry. */
  for (const from of carry.ENGINE_KEYS) {
    for (const d of carry.destinationsFor(from)) {
      assert.strictEqual(carry.canCarry(from, d.engine).ok, true, `${from} offered ${d.engine} but refuses it`);
    }
  }
});

test('YuE2 says plainly that it will not sing without words', () => {
  const out = carry.carryOver({ ...LYRIA, script: 'An instrumental.', options: { instrumental: true } }, 'yue2');
  assert.ok(out.notes.some((n) => /will not sing without words/.test(n)), out.notes.join(' | '));
  assert.ok(out.notes.some((n) => /instrumental switch/.test(n)), out.notes.join(' | '));
});

test('the title says where it went, and does not stack up over two hops', () => {
  const one = carry.carryOver(YUE, 'lyria');
  assert.strictEqual(one.draft.title, 'The Long Way (on Lyria)');
  const two = carry.carryOver({ ...LYRIA, title: one.draft.title }, 'yue2');
  assert.strictEqual(two.draft.title, 'The Long Way (on YuE2)');
});

test('splitLyricsBlock finds the heading and nothing else', () => {
  assert.deepStrictEqual(carry.splitLyricsBlock('A brief.\n\nLyrics:\nthe words'), {
    prose: 'A brief.',
    lyrics: 'the words',
  });
  /* "lyrics" inside a sentence is not a heading. */
  assert.strictEqual(carry.splitLyricsBlock('Write the lyrics: warm and plain.').lyrics, '');
  assert.strictEqual(carry.splitLyricsBlock('').prose, '');
  assert.strictEqual(carry.splitLyricsBlock(undefined).lyrics, '');
});

test('a rewrite is advised exactly when the two grammars differ', () => {
  assert.strictEqual(carry.carryOver(LYRIA, 'yue2').rewriteAdvised, true);
  assert.strictEqual(carry.carryOver(AUK, 'seed').rewriteAdvised, true);
  /* YuE2 and Stable Audio both take a short style line, but they are not on
   * offer to each other, so there is no same-grammar pair to assert. What
   * matters is that the advice is never silently absent when it differs. */
  for (const from of carry.ENGINE_KEYS) {
    for (const d of carry.destinationsFor(from)) {
      const out = carry.carryOver({ engine: from, script: 'x', options: {} }, d.engine);
      if (carry.ENGINES[from].script !== carry.ENGINES[d.engine].script) {
        assert.strictEqual(out.rewriteAdvised, true, `${from} -> ${d.engine}`);
        assert.ok(out.notes.length, `${from} -> ${d.engine} advised a rewrite and said nothing about why`);
      }
    }
  }
});

/* Sep 25 2026: the carry route's rewrite once saved "[object Object]" as a
 * Lyria direction. A script is read as text whatever shape it arrives in, and
 * the broken string is never carried on as somebody's description. */
test('a script arriving as a model reply object is read as its text', () => {
  assert.strictEqual(carry.scriptText({ text: 'A warm neo-soul groove.', usage: {} }), 'A warm neo-soul groove.');
  assert.strictEqual(carry.scriptText('plain words'), 'plain words');
  assert.strictEqual(carry.scriptText(undefined), '');
  assert.strictEqual(carry.scriptText({ usage: {} }), '', 'an object with no text is nothing, not "[object Object]"');
  const out = carry.carryOver({ ...YUE, script: { text: 'A warm neo-soul groove.' } }, 'lyria');
  assert.strictEqual(out.draft.script, 'A warm neo-soul groove.');
  assert.doesNotMatch(JSON.stringify(out.draft), /object Object/);
});

test('the damaged "[object Object]" row carries on empty and says why', () => {
  assert.strictEqual(carry.isBrokenScript('[object Object]'), true);
  assert.strictEqual(carry.isBrokenScript(' [object Object] '), true);
  assert.strictEqual(carry.isBrokenScript('A song about an [object] on the porch'), false);
  const damaged = { _id: 'bad1', engine: 'lyria', title: 'Neo-soul (on Lyria)', script: '[object Object]', options: { lyrics: LYRICS } };
  const out = carry.carryOver(damaged, 'yue2');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.draft.script, '');
  assert.strictEqual(out.draft.options.lyrics, LYRICS, 'the words still come across whole');
  assert.ok(out.notes.some((n) => /damaged by an old bug/.test(n)));
});
