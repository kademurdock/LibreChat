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

test('instrumental intent and stored lyrics survive both music-engine directions', () => {
  const out = carry.carryOver({ ...LYRIA, script: 'An instrumental.', options: { instrumental: true } }, 'yue2');
  assert.equal(out.draft.options.singing, 'Instrumental, no singing');
  assert.ok(!out.notes.some((n) => /will not sing without words|instrumental switch/.test(n)), out.notes.join(' | '));
  const back = carry.carryOver({ ...out.draft, options: { ...out.draft.options, lyrics: LYRICS } }, 'lyria');
  assert.equal(back.draft.options.instrumental, true);
  assert.equal(back.draft.options.lyrics, LYRICS);
  const sung = carry.carryOver({ ...LYRIA, script: 'A song.', options: {} }, 'yue2');
  assert.ok(sung.notes.some((n) => /will not sing without words/.test(n)));
});

test('copying never truncates authored lyrics and reports incompatible extra references', () => {
  const lyrics = 'My authored words\n'.repeat(600).trim();
  assert.equal(carry.carryOver({ ...YUE, options: { lyrics } }, 'lyria').draft.options.lyrics, lyrics);
  const out = carry.carryOver({ engine: 'seed', script: 'A scene.', options: { audio_urls: ['https://example.invalid/one.wav', 'https://example.invalid/two.wav'] } }, 'scenema');
  assert.equal(out.draft.options.reference_voice_url, 'https://example.invalid/one.wav');
  assert.match(out.notes.join(' '), /remaining recordings stay in the original draft/);
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

test("a YuE2 trained style's trigger words do not ride into another engine's description", () => {
  assert.strictEqual(
    carry.stripTrainedLead('kdsona, in the style of kdsona. English, female lead vocal. A modern neo-soul song.'),
    'English, female lead vocal. A modern neo-soul song.',
  );
  assert.strictEqual(carry.stripTrainedLead('A song in the style of 1970s soul.'), 'A song in the style of 1970s soul.');
  const out = carry.carryOver({ ...YUE, script: 'kdkids, in the style of kdkids. English, children\'s choir. Bright folk.', options: { ...(YUE.options || {}), band: 'kids' } }, 'lyria');
  assert.strictEqual(out.draft.script, "English, children's choir. Bright folk.");
  assert.ok(out.notes.some((n) => /trained style/.test(n)), 'and the style itself is still said to be left behind');
});

test('a trigger that re-rendering put in front twice is taken off every time', () => {
  const lead = 'kdsona, in the style of kdsona. ';
  assert.strictEqual(carry.stripTrainedLead(lead + lead + 'English, female lead vocal. Neo-soul.'), 'English, female lead vocal. Neo-soul.');
  assert.strictEqual(carry.stripTrainedLead(lead + ' ' + lead), '');
  const out = carry.carryOver({ ...YUE, script: lead + lead + 'Warm neo-soul, Rhodes.' }, 'lyria');
  assert.strictEqual(out.draft.script, 'Warm neo-soul, Rhodes.');
  assert.doesNotMatch(out.draft.script, /kdsona/);
});

test('every copy of the trigger goes, wherever it sits, and a Lyrics heading keeps its line', () => {
  const lead = 'kdsona, in the style of kdsona. ';
  assert.strictEqual(carry.stripTrainedLead('Warm neo-soul. ' + lead + 'Rhodes and a round bass.'), 'Warm neo-soul. Rhodes and a round bass.');
  assert.strictEqual(carry.stripTrainedLead('KDSona, in the style of kdsona.\nEnglish, female lead vocal.'), 'English, female lead vocal.');
  assert.strictEqual(carry.stripTrainedLead('Warm neo-soul. kdsona, in the style of kdsona.\n\nLyrics:\n[Verse 1]\nla la'), 'Warm neo-soul. \n\nLyrics:\n[Verse 1]\nla la');
  assert.strictEqual(carry.stripTrainedLead('kdsona, in the style of kdkids. Folk.'), 'kdsona, in the style of kdkids. Folk.', 'two different words are not a trigger');
  assert.strictEqual(carry.stripTrainedLead('the akdsona, in the style of akdsona. band'), 'the akdsona, in the style of akdsona. band', 'only a whole word starting kd');
  const out = carry.carryOver({ ...YUE, script: lead + 'Warm neo-soul, ' + lead + 'Rhodes.' }, 'lyria');
  assert.strictEqual(out.draft.script, 'Warm neo-soul, Rhodes.');
});

/* ---------- ACE-Step XL (Oct 10 2026): behind ACE_ENABLED and the admin gate ---------- */
const ACE_ON = { ace: true };
const ACE = {
  _id: 'ace987',
  engine: 'ace',
  title: 'The Long Way',
  mode: 'easy',
  sourceText: 'a slow country song about somebody driving home late',
  script: 'Slow country ballad, 88 BPM, female alto lead, pedal steel.',
  options: { quality: 'Best', length: '3:00', singing: 'Sung, with my lyrics', lyrics: LYRICS, seed: 42 },
};
const said = (out) => out.notes.join(' ');

test('ACE-Step XL is invisible to everyone the route has not said may use it', () => {
  assert.ok(carry.ENGINE_KEYS.includes('ace'), 'the table has it');
  for (const opts of [undefined, {}, { ace: false }, { ace: 'yes' }, { ace: 1 }]) {
    assert.deepStrictEqual(carry.destinationsFor('lyria', opts).map((d) => d.engine), ['yue2'], JSON.stringify(opts));
    assert.deepStrictEqual(carry.destinationsFor('yue2', opts).map((d) => d.engine), ['lyria'], JSON.stringify(opts));
    assert.deepStrictEqual(carry.destinationsFor('ace', opts), [], 'and it offers nothing of its own');
    assert.deepStrictEqual(carry.canCarry('yue2', 'ace', opts), { ok: false, why: 'There is no engine by that name.' });
    assert.deepStrictEqual(carry.canCarry('ace', 'yue2', opts), { ok: false, why: 'That project was not made by an engine this can carry.' });
  }
  for (const [project, to] of [[YUE, 'ace'], [LYRIA, 'ace'], [ACE, 'yue2'], [ACE, 'lyria']]) {
    for (const helpers of [undefined, {}, { ace: false }, { toScreenplay: () => 'x' }]) {
      const out = carry.carryOver(project, to, helpers);
      assert.strictEqual(out.ok, false, `${project.engine} -> ${to} was allowed without access`);
      assert.strictEqual(out.draft, undefined, 'and no draft came out');
    }
  }
  /* The listing the library sends is what it was: no ace anywhere. */
  for (const from of ['lyria', 'yue2', 'scenema', 'seed', 'stable']) {
    assert.ok(!carry.destinationsFor(from).some((d) => d.engine === 'ace'), from);
  }
});

test('with access it is on offer between the two song engines, and nowhere near a sound engine', () => {
  assert.deepStrictEqual(carry.destinationsFor('lyria', ACE_ON).map((d) => d.engine), ['yue2', 'ace']);
  assert.deepStrictEqual(carry.destinationsFor('yue2', ACE_ON).map((d) => d.engine), ['lyria', 'ace']);
  assert.deepStrictEqual(carry.destinationsFor('ace', ACE_ON).map((d) => d.engine), ['lyria', 'yue2']);
  assert.deepStrictEqual(carry.destinationsFor('ace', ACE_ON).map((d) => d.label), ['Lyria', 'YuE2']);
  assert.deepStrictEqual(carry.destinationsFor('scenema', ACE_ON).map((d) => d.engine).sort(), ['seed', 'stable']);
  assert.deepStrictEqual(carry.destinationsFor('stable', ACE_ON).map((d) => d.engine).sort(), ['scenema', 'seed']);
  for (const from of carry.ENGINE_KEYS) {
    for (const d of carry.destinationsFor(from, ACE_ON)) {
      assert.strictEqual(carry.canCarry(from, d.engine, ACE_ON).ok, true, `${from} offered ${d.engine} but refuses it`);
    }
  }
  const trade = carry.canCarry('ace', 'stable', ACE_ON);
  assert.strictEqual(trade.ok, false);
  assert.match(trade.why, /ACE-Step XL makes music and Stable Audio makes sound/);
  assert.strictEqual(carry.canCarry('ace', 'ace', ACE_ON).ok, false);
  assert.match(carry.canCarry('ace', 'ace', ACE_ON).why, /already a ACE-Step XL project/);
});

test('YuE2 to ACE keeps the words, their tags and the seed, and says what stayed behind', () => {
  const before = JSON.stringify(YUE);
  const out = carry.carryOver({ ...YUE, options: { ...YUE.options, weirdness: 70, guidance: 2, reference_voice_url: 'https://example.invalid/cover.wav', singing: 'Sung, with my lyrics' } }, 'ace', ACE_ON);
  assert.strictEqual(out.ok, true, out.why);
  assert.strictEqual(out.draft.engine, 'ace');
  assert.strictEqual(out.draft.options.lyrics, LYRICS, 'the words changed on the way');
  assert.match(out.draft.options.lyrics, /\[Verse 1\][\s\S]*\[Chorus\]/, 'the section tags did not survive');
  assert.strictEqual(out.draft.options.seed, 42);
  assert.strictEqual(out.draft.options.singing, 'Sung, with my lyrics');
  assert.strictEqual(out.draft.script, YUE.script, 'the style line comes across as it was');
  assert.strictEqual(out.draft.sourceText, YUE.sourceText);
  assert.strictEqual(out.draft.title, 'The Long Way (on ACE-Step XL)');
  assert.strictEqual(out.draft.state, 'draft');
  assert.deepStrictEqual(out.draft.options.carriedFrom, { project: 'def456', engine: 'yue2' });
  for (const key of ['band', 'abc', 'count', 'reference_voice_url', 'quality', 'length']) {
    assert.strictEqual(out.draft.options[key], undefined, `${key} was carried to an engine that has no such thing`);
  }
  /* ACE-Step XL has the same two dials as YuE2 (Creative variation and Prompt guidance), so they come across. */
  assert.strictEqual(out.draft.options.weirdness, 70);
  assert.strictEqual(out.draft.options.guidance, 2);
  const text = said(out);
  assert.match(text, /Your lyrics and their section tags came across whole/);
  for (const word of ['trained style', 'composition score']) assert.ok(text.includes(word), `nothing told her ${word} was left behind`);
  assert.doesNotMatch(text, /weirdness|guidance/, 'and nothing claims ACE-Step XL lacks the dials it has');
  assert.match(text, /ACE-Step XL has no trained style, which only YuE2 has, no composition score, so those were left behind\./);
  assert.match(text, /ACE-Step XL makes one take at a time, so the 2 takes you asked for became one\./);
  assert.match(text, /ACE-Step XL does not take an imported recording, so that stayed behind\./);
  assert.strictEqual(out.rewriteAdvised, false, 'both read a style line and separate words');
  assert.strictEqual(JSON.stringify(YUE), before, 'the original project was touched');
});

test('ACE to YuE2 keeps the words, their tags and the seed, and says which of its own choices were left', () => {
  const before = JSON.stringify(ACE);
  const out = carry.carryOver(ACE, 'yue2', ACE_ON);
  assert.strictEqual(out.ok, true, out.why);
  assert.strictEqual(out.draft.engine, 'yue2');
  assert.strictEqual(out.draft.options.lyrics, LYRICS);
  assert.strictEqual(out.draft.options.seed, 42);
  assert.strictEqual(out.draft.options.singing, 'Sung, with my lyrics');
  assert.strictEqual(out.draft.script, ACE.script);
  assert.strictEqual(out.draft.title, 'The Long Way (on YuE2)');
  assert.deepStrictEqual(out.draft.options.carriedFrom, { project: 'ace987', engine: 'ace' });
  assert.strictEqual(out.draft.options.quality, undefined);
  assert.strictEqual(out.draft.options.length, undefined);
  const text = said(out);
  assert.match(text, /Your lyrics and their section tags came across whole/);
  assert.match(text, /YuE2 has no quality choice, no length choice, so those were left behind\./);
  assert.strictEqual(JSON.stringify(ACE), before, 'the original project was touched');
  /* The usual Fast and Match my lyrics are not worth a sentence; a count above one is only ACE's to drop. */
  const plain = carry.carryOver({ ...ACE, options: { ...ACE.options, quality: 'Fast', length: 'Match my lyrics' } }, 'yue2', ACE_ON);
  assert.doesNotMatch(said(plain), /quality choice|length choice|left behind/);
  const onlyLength = carry.carryOver({ ...ACE, options: { ...ACE.options, quality: 'Fast' } }, 'lyria', ACE_ON);
  assert.match(said(onlyLength), /Lyria has no length choice, so that was left behind\./);
  assert.doesNotMatch(said(carry.carryOver({ ...YUE, options: { ...YUE.options, count: 3 } }, 'lyria')), /one take at a time/);
});

test('Creative variation and Prompt guidance cross between YuE2 and ACE-Step XL, and are said to be left behind by Lyria', () => {
  const dialled = { weirdness: 70, guidance: 2 };
  const toYue = carry.carryOver({ ...ACE, options: { ...ACE.options, ...dialled } }, 'yue2', ACE_ON);
  assert.strictEqual(toYue.draft.options.weirdness, 70);
  assert.strictEqual(toYue.draft.options.guidance, 2);
  assert.doesNotMatch(said(toYue), /weirdness|guidance/);
  const toAce = carry.carryOver({ ...YUE, options: { ...YUE.options, ...dialled } }, 'ace', ACE_ON);
  assert.deepStrictEqual([toAce.draft.options.weirdness, toAce.draft.options.guidance], [70, 2]);
  /* Lyria has neither dial: the sentence is the one it always was for YuE2, and ACE-Step XL's usual 50 and 1 are not worth one. */
  assert.match(said(carry.carryOver({ ...ACE, options: { ...ACE.options, ...dialled } }, 'lyria', ACE_ON)), /Lyria has no weirdness, no guidance, no quality choice, no length choice, so those were left behind\./);
  assert.match(said(carry.carryOver({ ...ACE, options: { ...ACE.options, quality: 'Fast', length: 'Match my lyrics', weirdness: 70 } }, 'lyria', ACE_ON)), /Lyria has no weirdness, so that was left behind\./);
  assert.doesNotMatch(said(carry.carryOver({ ...ACE, options: { ...ACE.options, quality: 'Fast', length: 'Match my lyrics', weirdness: 50, guidance: 1 } }, 'lyria', ACE_ON)), /weirdness|guidance|left behind/);
  assert.strictEqual(carry.carryOver({ ...ACE, options: { ...ACE.options, ...dialled } }, 'lyria', ACE_ON).draft.options.weirdness, undefined);
  assert.match(said(carry.carryOver(YUE, 'lyria')), /Lyria has no trained style, which only YuE2 has, no composition score, no weirdness, no guidance, so those were left behind\./, 'YuE2 to Lyria says what it always said');
  assert.match(said(carry.carryOver({ ...YUE, options: { ...YUE.options, weirdness: 50, guidance: 1 } }, 'lyria')), /no weirdness, no guidance/, 'and still says it at the usual values: that is how a YuE2 project always read');
  assert.ok(carry.SHARED_KNOBS.includes('weirdness') && carry.SHARED_KNOBS.includes('guidance'));
  assert.deepStrictEqual(carry.carryOver(LYRIA, 'ace', ACE_ON).draft.options.weirdness, undefined, 'Lyria has none to bring');
});

test('ACE to Lyria and Lyria to ACE: the words come out of, and go back into, the right place', () => {
  const toLyria = carry.carryOver(ACE, 'lyria', ACE_ON);
  assert.strictEqual(toLyria.ok, true, toLyria.why);
  assert.strictEqual(toLyria.draft.options.lyrics, LYRICS);
  assert.strictEqual(toLyria.draft.options.seed, 42);
  assert.strictEqual(toLyria.draft.options.instrumental, false);
  assert.strictEqual(toLyria.rewriteAdvised, true, 'a style line is not a Lyria brief');
  const fromLyria = carry.carryOver(LYRIA, 'ace', ACE_ON);
  assert.strictEqual(fromLyria.ok, true, fromLyria.why);
  assert.strictEqual(fromLyria.draft.options.lyrics, LYRICS, 'the lyrics heading was split out of the brief');
  assert.doesNotMatch(fromLyria.draft.script, /Lyrics:/i);
  assert.match(fromLyria.draft.script, /pedal steel/);
  assert.strictEqual(fromLyria.draft.options.seed, 42);
  assert.strictEqual(fromLyria.draft.options.singing, 'Sung, with my lyrics');
  assert.strictEqual(fromLyria.rewriteAdvised, true);
  assert.match(said(fromLyria), /ACE-Step XL reads a concise style direction and separate lyrics\. Check the direction for the genre, instruments and voice; you can shorten it or ask the desk to format it\./);
  /* The YuE2 sentence is the one it always was. */
  assert.match(said(carry.carryOver(LYRIA, 'yue2')), /YuE2 reads a concise style direction and separate lyrics\. Check the direction for the genre, instruments and voice; you can shorten it or ask the desk to format it\./);
});

test('an instrumental crosses in both directions, and a song with no words is warned in its own engine’s name', () => {
  const instrumental = { ...ACE, script: 'A slow instrumental theme.', options: { singing: 'Instrumental, no singing', lyrics: LYRICS, quality: 'Fast', length: 'Match my lyrics' } };
  const toYue = carry.carryOver(instrumental, 'yue2', ACE_ON);
  assert.strictEqual(toYue.draft.options.singing, 'Instrumental, no singing');
  assert.strictEqual(toYue.draft.options.lyrics, LYRICS, 'stored lyrics stay available');
  assert.doesNotMatch(said(toYue), /will not sing without words/);
  assert.match(said(toYue), /Instrumental mode came across/);
  const toLyria = carry.carryOver(instrumental, 'lyria', ACE_ON);
  assert.strictEqual(toLyria.draft.options.instrumental, true);
  const fromLyria = carry.carryOver({ ...LYRIA, script: 'An instrumental.', options: { instrumental: true } }, 'ace', ACE_ON);
  assert.strictEqual(fromLyria.draft.options.singing, 'Instrumental, no singing');
  assert.doesNotMatch(said(fromLyria), /will not sing without words|instrumental switch/);
  const fromYue = carry.carryOver({ ...YUE, options: { singing: 'Instrumental, no singing' } }, 'ace', ACE_ON);
  assert.strictEqual(fromYue.draft.options.singing, 'Instrumental, no singing');
  /* No words and not an instrumental: each engine is warned by its own name. */
  assert.match(said(carry.carryOver({ ...LYRIA, script: 'A song.', options: {} }, 'ace', ACE_ON)), /ACE-Step XL will not sing without words, so put something in Lyrics before you generate\./);
  assert.match(said(carry.carryOver({ ...LYRIA, script: 'A song.', options: {} }, 'yue2', ACE_ON)), /YuE2 will not sing without words, so put something in Lyrics before you generate\./);
});

test('a carry to or from ACE never touches the original and never carries an engine-private word', () => {
  const frozen = JSON.parse(JSON.stringify(ACE));
  const deep = (value) => { Object.freeze(value); for (const v of Object.values(value)) if (v && typeof v === 'object') deep(v); return value; };
  for (const project of [deep(structuredClone(ACE)), deep(structuredClone(YUE)), deep(structuredClone(LYRIA))]) {
    for (const to of ['ace', 'yue2', 'lyria']) {
      if (to === project.engine) continue;
      const out = carry.carryOver(project, to, ACE_ON);
      assert.strictEqual(out.ok, true, `${project.engine} -> ${to}: ${out.why}`);
      assert.strictEqual(out.draft.state, 'draft');
      for (const key of ['assets', 'jobs', 'parts', 'costUSD', 'lastRenderAt', 'stitchedAssetId']) assert.strictEqual(out.draft[key], undefined, key);
      assert.strictEqual(out.draft.sourceText, project.sourceText, 'her typed words survive the hop');
    }
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ACE)), frozen);
  /* steps is still not shared: YuE2's number would mean nothing to ACE. */
  assert.strictEqual(carry.carryOver({ ...YUE, options: { ...YUE.options, steps: 1800 } }, 'ace', ACE_ON).draft.options.steps, undefined);
  /* A project made by ACE then carried round the loop keeps its title tidy. */
  const there = carry.carryOver(ACE, 'yue2', ACE_ON);
  const back = carry.carryOver({ ...YUE, title: there.draft.title }, 'ace', ACE_ON);
  assert.strictEqual(back.draft.title, 'The Long Way (on ACE-Step XL)');
});
