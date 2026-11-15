'use strict';
/* Change words on AuK (Nov 14 2026): kadeSoundBoothWords.js and the page's Change words form.
 * No network, no GPU, no database: the listener, the cutter and the bridge are fixtures.
 * Route-level tests are in kadeSoundBoothAukDesk.nodetest.js (search "Change words").
 * Run: node --test kadeSoundBoothWords.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const axios = require('axios');
const words = require('./kadeSoundBoothWords');

test('a change from the setting boxes, and a list, are checked and ordered latest spot first', () => {
  const one = words.planWordChanges({ words_kind: 'sung', old_text: '  rear  view ', new_text: 'like you', words_from: '3.36', words_to: 5.68 }, 9);
  assert.deepEqual(one, [{ kind: 'vocal', oldText: 'rear view', newText: 'like you', rangeStart: 3.36, rangeEnd: 5.68 }]);
  const list = words.planWordChanges({ changes: [
    { kind: 'spoken', oldText: 'a', newText: 'b', rangeStart: 1, rangeEnd: 2 },
    { kind: 'spoken', oldText: 'c', newText: 'd', rangeStart: 20, rangeEnd: 24 },
    { kind: 'spoken', oldText: 'e', newText: 'f', rangeStart: 8, rangeEnd: 12 },
  ] }, 30);
  assert.deepEqual(list.map((c) => c.oldText), ['c', 'e', 'a']);
  assert.throws(() => words.planWordChanges({ changes: Array.from({ length: 7 }, (_, i) => ({ oldText: 'a', newText: 'b', rangeStart: i * 2, rangeEnd: i * 2 + 1 })) }, 30), /Up to 6/);
  assert.throws(() => words.planWordChanges({ old_text: 'Hello', new_text: 'hello!', words_from: 1, words_to: 2 }, 9), /same as the old/);
  assert.throws(() => words.planWordChanges({ old_text: 'a', new_text: 'b', words_from: 1, words_to: 1.2 }, 9), /half a second/);
  assert.throws(() => words.planWordChanges({ old_text: 'a', new_text: 'b', words_from: 1, words_to: 40 }, 90), /too wide/);
  assert.throws(() => words.planWordChanges({ changes: [{ oldText: 'a', newText: 'b', rangeStart: 1, rangeEnd: 2 }, { oldText: '', newText: 'b', rangeStart: 3, rangeEnd: 4 }] }, 9), /^Error: Change 2: type the words it says now/);
  assert.equal(words.planWordChanges({ old_text: 'a', new_text: 'b', words_from: 1, words_to: 9.04 }, 9)[0].rangeEnd, 9, 'a hair past the end is the end');
});

test('takes default to three, are capped at four, and every draw of seeds is fresh', () => {
  assert.equal(words.takesFrom(undefined), 3);
  assert.equal(words.takesFrom('2'), 2);
  assert.throws(() => words.takesFrom(5), /1 to 4/);
  assert.throws(() => words.takesFrom(1.5), /1 to 4/);
  const a = words.freshSeeds(4);
  const b = words.freshSeeds(4);
  assert.equal(new Set(a).size, 4);
  assert.equal(a.some((s) => b.includes(s)), false);
  assert.ok(a.every((s) => Number.isInteger(s) && s > 0 && s < 2147483647));
});

test('AuK\'s own templates, and the free-form word changes that are sent to the form instead', () => {
  assert.equal(words.wordTemplate('speech', 'Tuesday', 'Thursday'), "Replace 'Tuesday' with 'Thursday'.");
  assert.equal(words.wordTemplate('vocal', 'rear view', 'like "you"'), 'Change "rear view" to "like you" in the vocal recording.');
  for (const text of ['Replace "Tuesday" with "Thursday". Preserve the speaker.', "change 'cat' to 'dog'", 'Swap “red” for “blue”', 'Make her say "yes" instead of "no".']) {
    assert.equal(words.looksLikeWordChange(text), true, text);
  }
  for (const text of ['Remove background noise and reverberation. Preserve the voice and every spoken word.', 'Change the mood to cheerful.', 'Keep the spoken content unchanged and change the timbre to: "a youthful, light voice with clear diction"', 'Raise the pitch by two semitones.']) {
    assert.equal(words.looksLikeWordChange(text), false, text);
  }
});

test('the summary her project shows names every change in the order it runs', () => {
  const plan = words.planWordChanges({ changes: [{ kind: 'spoken', oldText: 'a', newText: 'b', rangeStart: 1, rangeEnd: 2 }, { kind: 'sung', oldText: 'c', newText: 'd', rangeStart: 5, rangeEnd: 7.25 }] }, 9);
  assert.equal(words.summary(plan), 'Change "c" to "d" (sung, 5 to 7.3 seconds); then Change "a" to "b" (spoken, 1 to 2 seconds)');
  assert.equal(words.sameChanges(plan, words.planWordChanges({ changes: [{ kind: 'sung', oldText: 'c', newText: 'd', rangeStart: 5, rangeEnd: 7.25 }, { kind: 'spoken', oldText: 'a', newText: 'b', rangeStart: 1, rangeEnd: 2 }] }, 9)), true);
  assert.equal(words.sameChanges(plan, plan.slice(1)), false);
});

test('Find the spot: windows carry our own times, a missed window is said, and a long recording comes in stretches', async () => {
  const heard = { 0: 'so I will see you', 4: 'on Tuesday then', 8: '' };
  const cut = async (_buffer, from, to) => {
    const out = [];
    for (let t = from; t < to; t += words.WINDOW_S) out.push({ start: t, end: Math.min(to, t + words.WINDOW_S), buffer: Buffer.from(String(t)) });
    return out;
  };
  const hear = async (buffer) => {
    const t = Number(buffer.toString());
    if (t === 12) throw new Error('host down');
    return { text: heard[t] ?? 'more words', costUSD: 0.00001 };
  };
  const result = await words.timedTranscript(Buffer.from('audio'), 14, {}, { cut, hear });
  assert.deepEqual(result.lines.map((l) => [l.start, l.end, l.text]), [[0, 4, 'so I will see you'], [4, 8, 'on Tuesday then'], [8, 12, ''], [12, 14, '']]);
  assert.equal(result.lines[3].missed, true);
  assert.match(result.spoken, /Transcribed 0:00 to 0:14 in 4 stretches of 4 seconds; 2 have words\. 1 could not be heard\. Times are close, not exact/);
  const long = await words.timedTranscript(Buffer.from('audio'), 400, { from: 10 }, { cut, hear: async () => ({ text: 'x' }) });
  assert.equal(long.to, 190);
  assert.match(long.spoken, /ask again from 3:10 for the rest/);
  await assert.rejects(words.timedTranscript(Buffer.from('audio'), 8, {}, { cut, hear: async () => { throw new Error('down'); } }), /could not hear this recording/);
});

test('the listener is MiMo Flash on zero-retention hosts, and a reply that never heard the audio is refused', async (t) => {
  const real = axios.post;
  t.after(() => { axios.post = real; });
  const calls = [];
  axios.post = async (url, body) => { calls.push({ url, body }); return { data: { choices: [{ message: { content: ' on Tuesday then ' } }], usage: { prompt_tokens: 80, cost: 0.00001 } } }; };
  const out = await words.mimoHear(Buffer.from('RIFF'), { OPENROUTER_KEY: 'synthetic-only' });
  assert.equal(out.text, 'on Tuesday then');
  assert.match(calls[0].url, /openrouter\.ai/);
  assert.equal(calls[0].body.model, 'xiaomi/mimo-v2.6-flash');
  assert.equal(calls[0].body.provider.zdr, true);
  assert.equal(calls[0].body.provider.data_collection, 'deny');
  assert.equal(calls[0].body.messages[0].content[1].type, 'input_audio');
  axios.post = async () => ({ data: { choices: [{ message: { content: 'a made-up line' } }], usage: { prompt_tokens: 30 } } });
  await assert.rejects(words.mimoHear(Buffer.from('RIFF'), { OPENROUTER_KEY: 'synthetic-only' }), /did not hear/);
  await assert.rejects(words.mimoHear(Buffer.from('RIFF'), {}), /not configured/);
});

/* ---------- the page ---------- */
function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  return context.module.exports.soundBoothHtml;
}
const html = buildPage();
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('function confirmRender('));
function pageFunction(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('the page builds each change from the boxes and says exactly what is missing', () => {
  const ctx = { state: { values: {}, wordQueue: [] } };
  vm.runInNewContext(['secOf', 'changeLine', 'fieldChange', 'fieldsEmpty', 'changeProblem', 'wordChangesToSend'].map(pageFunction).join('\n') +
    '\nthis.f={fieldChange,changeProblem,wordChangesToSend,changeLine};', ctx);
  const f = ctx.f;
  assert.deepEqual(f.wordChangesToSend(), [], 'empty boxes add nothing');
  ctx.state.values = { old_text: 'Tuesday' };
  assert.deepEqual([...f.changeProblem(f.fieldChange())], ['set_new_text', 'Type the new words.']);
  ctx.state.values = { old_text: 'Tuesday', new_text: 'Thursday', words_from: '3' };
  assert.deepEqual([...f.changeProblem(f.fieldChange())], ['set_words_to', 'Set To, the second a little after the words.']);
  ctx.state.values = { old_text: 'Tuesday', new_text: 'Thursday', words_from: '3', words_to: '2' };
  assert.equal(f.changeProblem(f.fieldChange())[1], 'To has to be after From.');
  ctx.state.values = { words_kind: 'sung', old_text: 'rear view', new_text: 'like you', words_from: '3', words_to: '6.5' };
  assert.equal(f.changeProblem(f.fieldChange()), null);
  ctx.state.wordQueue = [{ kind: 'spoken', oldText: 'a', newText: 'b', rangeStart: 10, rangeEnd: 12 }];
  const sent = f.wordChangesToSend();
  assert.equal(sent.length, 2, 'the list, then the change still in the boxes');
  assert.equal(f.changeLine(sent[1]), 'Sung: "rear view" to "like you", from 3 to 6.5 seconds');
});

test('the Change words controls are labelled buttons and lists, and every result is said in the status line', () => {
  const extras = pageFunction('wordExtras');
  assert.match(extras, /id="btnAddChange" aria-describedby="addChangeHint">Add this change to the list</);
  assert.match(extras, /<ol id="wordQueue" aria-label="Changes to make">/);
  assert.match(extras, /data-rmchange="'\+i\+'">Remove change '\+\(i\+1\)\+'</);
  assert.match(extras, /role="group" aria-labelledby="spotHead"><h3 id="spotHead">Find the spot</);
  assert.match(extras, /say\('Change '\+q\.length\+' added: '/);
  assert.match(extras, /say\('Spot set: from '/);
  const spots = pageFunction('spotsHtml');
  assert.match(spots, /aria-label="What is said, four seconds at a time"/);
  assert.match(spots, /">Play '\+esc\(when\)\+'</);
  assert.match(spots, /">Use '\+esc\(when\)\+' as the spot</);
  assert.doesNotMatch(spots, /autoplay/);
  assert.match(pageFunction('findSpot'), /list\.focus\(\)[\s\S]*say\(r\.data\.spoken/);
  /* an edit never sends the project's voice seed */
  assert.match(script, /b\.seed === undefined && b\.auk_task!=='edit' && b\.auk_task!=='change_words' && b\.auk_task!=='clean_up_or_change'\) b\.seed = state\.voiceSeed;/);
  assert.match(script, /if\(state\.engine==='scenema' && b\.auk_task==='change_words'\) b\.changes=wordChangesToSend\(\);/);
});

test('unquoted word changes are caught too; style edits and the timbre template are not', () => {
  for (const text of ['Replace Tuesday with Thursday', 'Change the word Tuesday to Thursday', 'Make it say Thursday instead of Tuesday',
    'Sing "like you" instead of "rear view"', 'Swap Tuesday for Thursday', 'Fix the lyrics in the chorus.', '"a" -> "b"']) {
    assert.equal(words.looksLikeWordChange(text), true, text);
  }
  for (const text of ['Make this a whisper.', 'Give this voice an Irish accent.', 'Change the emotion to happy.', 'Replace the background noise with silence.', "Keep the speaker's room sound."]) {
    assert.equal(words.looksLikeWordChange(text), false, text);
  }
});

test('the widest range is 28 seconds, since the worker adds a second each side and stops at 30', () => {
  assert.equal(words.MAX_RANGE_S, 28);
  assert.throws(() => words.planWordChanges({ old_text: 'a', new_text: 'b', words_from: 0, words_to: 29 }, 60), /Choose 28 seconds or less/);
  assert.equal(words.planWordChanges({ old_text: 'a', new_text: 'b', words_from: 0, words_to: 28 }, 60)[0].rangeEnd, 28);
});

test('two changes need two seconds between them, because each remakes a second either side', () => {
  const near = { changes: [{ oldText: 'a', newText: 'b', rangeStart: 10, rangeEnd: 12 }, { oldText: 'c', newText: 'd', rangeStart: 7, rangeEnd: 9.5 }] };
  assert.throws(() => words.planWordChanges(near, 30), /less than 2 seconds apart \(9\.5 and 10 seconds\)/);
  const apart = { changes: [{ oldText: 'a', newText: 'b', rangeStart: 10, rangeEnd: 12 }, { oldText: 'c', newText: 'd', rangeStart: 5, rangeEnd: 8 }] };
  assert.deepEqual(words.planWordChanges(apart, 30).map((c) => c.oldText), ['a', 'c']);
});

test('sung words lose their double quotes, since the worker puts them inside its own quotes', () => {
  const [c] = words.planWordChanges({ words_kind: 'sung', old_text: '"rear" view', new_text: 'like \u201cyou\u201d', words_from: 1, words_to: 3 }, 9);
  assert.deepEqual([c.oldText, c.newText], ['rear view', 'like you']);
  const [spoken] = words.planWordChanges({ words_kind: 'spoken', old_text: 'say "hi"', new_text: 'say "bye"', words_from: 1, words_to: 3 }, 9);
  assert.equal(spoken.oldText, 'say "hi"');
});

test('Find the spot reads only the asked stretch from the URL with ffmpeg', async () => {
  const calls = [];
  const cp = require('child_process');
  const real = cp.execFile;
  cp.execFile = (bin, args, opts, cb) => { calls.push(args); cb(new Error('no ffmpeg here'), '', 'Protocol not found'); };
  try {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothWords.js'), 'utf8'), { module: mod, exports: mod.exports, require, process, Buffer, console, URL });
    await assert.rejects(mod.exports.cutWindows({ url: 'https://storage.test/her.mp3' }, 8, 20), (e) => e.ffmpeg === true);
  } finally { cp.execFile = real; }
  const args = [...calls[0]];
  assert.deepEqual(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2), ['-protocol_whitelist', 'https,tls,tcp']);
  assert.equal(args[args.indexOf('-ss') + 1], '8');
  assert.equal(args[args.indexOf('-t') + 1], '12');
  assert.equal(args[args.indexOf('-i') + 1], 'https://storage.test/her.mp3');
});

/* Nov 14 2026: sung word changes are hit or miss in AuK (Tencent's own sung sample is garbled too),
 * so singing gets four takes by default and the form says so plainly; speech keeps three. */
test('takes default to four when a change is sung and three for speech; a set number always wins', () => {
  assert.equal(words.takesFrom(undefined, [{ kind: 'speech' }]), 3);
  assert.equal(words.takesFrom('', [{ kind: 'sung' }]), 4);
  assert.equal(words.takesFrom(undefined, [{ kind: 'vocal' }]), 4);
  assert.equal(words.takesFrom(undefined, [{ kind: 'spoken' }, { kind: 'vocal' }]), 4, 'any sung change in the list');
  assert.equal(words.takesFrom('2', [{ kind: 'vocal' }]), 2);
  assert.equal(words.takesFrom(undefined, []), 3);
  const plan = words.planWordChanges({ words_kind: 'sung', old_text: 'rear view', new_text: 'like you', words_from: 3, words_to: 6.5 }, 9);
  assert.equal(words.takesFrom(undefined, plan), 4);
});

test('the form shows and says one plain line when the words are sung, and the takes box shows the right normal', () => {
  const NOTE = 'Changing sung words is hit or miss with AuK. It makes several takes and keeps the one where the new words are heard.';
  assert.ok(script.includes("var SUNG_NOTE='" + NOTE + "';"));
  const field = pageFunction('settingField');
  assert.match(field, /if\(s\.key==='words_kind' && v==='sung'\) head\+='<p class="hint" id="'\+id\+'_sung">'\+esc\(SUNG_NOTE\)\+'<\/p>';/);
  assert.match(field, /aria-describedby="'\+id\+'_h'\+\(s\.key==='words_kind'&&v==='sung'\?' '\+id\+'_sung':''\)\+'"/);
  assert.match(field, /s\.key==='takes'\?esc\('normal is '\+takesDefault\(\)\)/);
  assert.match(script, /if\(el\.dataset\.key==='words_kind'&&el\.value==='sung'\) say\(SUNG_NOTE\);/);
  const ctx = { state: { values: {}, wordQueue: [] } };
  vm.runInNewContext(pageFunction('takesDefault') + '\nthis.t=takesDefault;', ctx);
  assert.equal(ctx.t(), 3);
  ctx.state.values.words_kind = 'sung';
  assert.equal(ctx.t(), 4);
  ctx.state.values.words_kind = 'spoken';
  ctx.state.wordQueue = [{ kind: 'sung' }];
  assert.equal(ctx.t(), 4);
});
