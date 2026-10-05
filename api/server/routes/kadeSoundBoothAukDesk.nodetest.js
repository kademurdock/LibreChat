'use strict';
/* The AuK script desk and the voice in ONE place (Oct 2 2026).
 *
 * Her report: "When I tell it to write a script on the hq speech thing, it
 * writes things in the wrong places like voice descriptions." These run the
 * real /script and /render handlers with fixture writer replies and a captured
 * bridge call: no model, no GPU, no database. They pin down:
 *   - the writer is told the chosen voice as a fixed choice, and a draft
 *     written for someone else is asked for once more, then flagged;
 *   - the script box gets the performance, the voice comes back on its own;
 *   - iPhone 2.2.2, which reads only `screenplay`, still renders the same voice;
 *   - header lines and [cues] are never performed aloud (the Oct 1 Codex find);
 *   - an AuK edit is described as an edit, not as a script to hear;
 *   - the ten minors from review 1, one test each;
 *   - Seed writing modes, dialogue space and its existing over-cap repair.
 * Run: node --test kadeSoundBoothAukDesk.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const screenplay = require('./kadeSoundBoothScreenplay');
const ts = require('typescript');
function loadTs(filename) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports: loaded.exports, module: loaded,
    require: (name) => name.startsWith('.') ? loadTs(path.resolve(path.dirname(filename), name + '.ts')) : require(name),
  });
  return loaded.exports;
}
const writing = loadTs(path.join(__dirname, '../../../packages/api/src/music/writing.ts'));
const ideas = loadTs(path.join(__dirname, '../../../packages/api/src/music/idea.ts'));

const ROUTE = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
const LOCAL = ['./kadeSoundBoothSplit', './kadeSoundBoothScreenplay', './kadeSoundBoothPaste', './kadeSoundBoothCarry'];

/** The route, loaded the way the app loads it, with the writer answering from `replies` in order. */
function booth(replies = [], env = {}) {
  const handlers = new Map();
  const writerCalls = [];
  const bridgeCalls = [];
  const saved = [];
  const warnings = [];
  let project;
  class Project {
    constructor(fields) {
      Object.assign(this, { _id: 'project-fixture', title: 'Untitled', state: 'draft', jobs: [], options: {}, parts: [] }, fields);
      project = this;
    }
    async save() { saved.push({ script: this.script, readback: this.readback, options: this.options }); }
    static async findById() { return project; }
  }
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch', 'use'].map((m) => [m, (p, ...v) => handlers.set(m + p, v.at(-1))]));
  const context = {
    module: { exports: {} }, Buffer, URL, console,
    process: { env: { REFRAME_PROXY_SECRET: 'offline-fixture', BRIDGE_SECRET: 'offline-fixture', ...env } },
    require(name) {
      if (name === 'express') return { Router: () => router, json: () => () => {} };
      if (name === 'multer') return Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
      if (name === 'axios') return { post: async (url, body) => {
        if (url.endsWith('/audio/scenema/start')) {
          bridgeCalls.push(body);
          return { data: { jobId: 'offline-job', estimate: {} } };
        }
        assert.match(url, /chat\/completions$/);
        writerCalls.push(body);
        const reply = replies[writerCalls.length - 1];
        assert.ok(reply !== undefined, 'the writer was asked more times than this test expected');
        return { data: { choices: [{ message: { content: typeof reply === 'string' ? reply : reply.text }, finish_reason: typeof reply === 'string' ? 'stop' : reply.finishReason }], usage: { cost: 0 } } };
      } };
      if (name === 'crypto') return require(name);
      if (name === '@librechat/api') return {
        writingCost: () => ({ costUSD: 0, measured: true }),
        validateMusicReference: async (_user, url) => url, musicReferenceSeconds: async () => 10,
        ...(() => { const mod = { exports: {} }; const code = require('typescript').transpileModule(require('node:fs').readFileSync(path.join(__dirname, '../../../packages/api/src/speech/edit.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS } }).outputText; require('node:vm').runInNewContext(code, { exports: mod.exports, module: mod, URL, process: { env: { AWS_ENDPOINT_URL: 'https://example.invalid', AWS_BUCKET_NAME: 'recordings' } } }); return mod.exports; })(),
        ...writing, ...ideas, ...loadTs(path.join(__dirname, '../../../packages/api/src/music/title.ts')), musicWritingPrompt: async (base) => base,
        yueStylesEnabled: () => false, yueStyles: {}, effectsGuide: {},
        createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {},
      };
      if (name === '@librechat/data-schemas') return { logger: { info() {}, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) } };
      if (name === '~/models/kadeUsage') return { logKadeUsage: async () => {} };
      if (name === '~/server/utils/kadeSongAudience') return { songAudience: async () => 'explicit', explicitSungLines: () => [] };
      if (name === '~/models/kadeSoundBoothProject') return { KadeSoundBoothProject: Project };
      if (name === './kadeSoundBoothChain') return { acquire: async () => 'fixture-lease', release: async () => {}, MAX_PARTS: 12 };
      if (LOCAL.includes(name)) return require(name);
      if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => () => {}, guideFor: (g) => g };
      return {};
    },
  };
  vm.runInNewContext(ROUTE, context);
  const request = async (key, body, params = {}, userId = 'offline-owner') => {
    let status = 200;
    let result;
    const res = { status(v) { status = v; return this; }, json(v) { result = v; return this; } };
    await handlers.get(key)({ user: { id: userId }, body, params }, res);
    return { status, result };
  };
  const call = async (key, body) => {
    const { status, result } = await request(key, body);
    assert.equal(status, 200, JSON.stringify(result));
    return result;
  };
  return {
    writerCalls, bridgeCalls, saved, warnings, request, internals: context.module.exports._internals,
    write: (body) => call('post/script', { engine: 'scenema', mode: 'write', text: 'A short story.', gender: 'female', ...body }),
    render: (body) => call('post/render', { engine: 'scenema', gender: 'female', ...body }),
  };
}

const unescape = (s) => screenplay.unescapeXml(s);
/** The words AuK performs from a <speak> script: no tag, no direction, no sound. */
function spoken(xml) {
  return unescape(String(xml).replace(/<speak\b[^>]*>|<\/speak>/g, '').replace(/<(action|sound)>[\s\S]*?<\/\1>/g, ''))
    .replace(/\s+/g, ' ').trim();
}
/** voice= off the <speak> tag, read here rather than with the module's own reader. */
const voiceOf = (xml) => {
  const m = String(xml).match(/<speak\b[^>]*\svoice="([^"]*)"/i);
  return m ? unescape(m[1]) : undefined;
};

const GIRL = 'A cheerful little girl, about five years old, with a bright, high voice.';
const WOMAN_XML = '<speak voice="A woman in her early thirties, hushed and intimate." gender="female">\nThe storm had been building all evening when I found the key under the floorboard.\n</speak>';
const WOMAN_READBACK = 'READBACK: A woman in her early thirties tells, in hushed tones, how she found a key during a storm. About thirty seconds.';
const GIRL_XML = `<speak voice="${GIRL}" gender="female">\nThe thunder went boom and I hid under the table with my bunny!\n</speak>`;
const GIRL_READBACK = 'READBACK: A little girl about five tells how she hid from the thunder with her bunny. About ten seconds.';

test('Sol writes and formats speech with the chosen thought, without unsupported sampling controls', async () => {
  for (const mode of ['write', 'format']) {
    for (const thinkMode of ['auto', 'low', 'medium', 'high']) {
      const desk = booth([`${GIRL_XML}\n${GIRL_READBACK}`]);
      const result = await desk.write({ mode, thinkMode, voice_description: GIRL });
      const sent = desk.writerCalls[0];
      assert.equal(sent.model, 'openai/gpt-6.1-sol');
      assert.equal(Object.hasOwn(sent, 'temperature'), false);
      assert.equal(Object.hasOwn(sent, 'top_p'), false);
      assert.equal(sent.max_tokens, thinkMode === 'high' ? 65536 : 16384);
      if (thinkMode === 'auto') {
        assert.equal(sent.reasoning, undefined);
        assert.equal(sent.kade_think_max_effort, 'medium');
      } else {
        assert.equal(sent.reasoning.effort, thinkMode);
        assert.equal(sent.reasoning.exclude, true);
        assert.equal(sent.kade_think_max_effort, undefined);
      }
      assert.equal(result.performance, 'The thunder went boom and I hid under the table with my bunny!');
    }
  }
});

test('song length stays in the brief while all four thought modes use resumable jobs', async () => {
  for (const thinkMode of ['auto', 'low', 'medium', 'high']) {
    const desk = booth(['A four-minute instrumental with a quiet ending.\nREADBACK: A full instrumental.']);
    const start = await desk.request('post/script', { engine: 'lyria', mode: 'write', text: 'A four-minute instrumental with a quiet ending.', instrumental: true, thinkMode, notify: false });
    assert.equal(start.status, 202);
    const id = start.result.job;
    let polled;
    for (let i = 0; i < 10; i++) {
      await new Promise(setImmediate);
      polled = await desk.request('get/script/job/:id', {}, { id });
      if (polled.result.state !== 'working') break;
    }
    assert.equal(polled.status, 200);
    assert.equal(polled.result.state, 'done', JSON.stringify(polled.result));
    assert.match(desk.writerCalls[0].messages[1].content, /four-minute instrumental/);
    assert.equal(desk.writerCalls[0].model, 'openai/gpt-6.1-sol');
    assert.equal(desk.writerCalls[0].reasoning?.effort, thinkMode === 'auto' ? undefined : thinkMode);
    assert.match(polled.result.result.script, /four-minute instrumental/);
    assert.equal((await desk.request('get/script/job/:id', {}, { id }, 'other-owner')).status, 404);
  }
});

test('legacy background and deepWrite retain medium; a new explicit choice overrides delivery', () => {
  const base = { engine: 'lyria', mode: 'write' };
  assert.equal(writing.musicWritingSettings(base).reasoning.effort, 'low');
  for (const legacy of [{ background: true }, { deepWrite: true }, { deep: true }]) {
    assert.equal(writing.musicWritingSettings({ ...base, ...legacy }).reasoning.effort, 'medium');
    assert.equal(writing.musicWritingBackground({ ...base, ...legacy }), true);
    assert.equal(writing.musicWritingSettings({ ...base, ...legacy, thinkMode: 'low' }).reasoning.effort, 'low');
    assert.equal(writing.musicWritingSettings({ ...base, ...legacy, thinkMode: 'auto' }).reasoning, undefined);
  }
  assert.equal(writing.musicWritingBackground({ engine: 'seed', mode: 'write', thinkMode: 'medium' }), false);
  assert.equal(writing.musicWritingBackground({ engine: 'lyria', mode: 'format', thinkMode: 'medium' }), false);
});

test('unsupported effort is rejected before the writing desk is charged', async () => {
  const desk = booth();
  for (const route of ['post/script', 'post/idea']) {
    const result = await desk.request(route, { engine: 'lyria', mode: 'write', text: 'A song.', thinkMode: 'xhigh' });
    assert.equal(result.status, 400);
    assert.match(result.result.error, /Auto, Low, Medium or High/);
  }
  assert.equal(desk.writerCalls.length, 0);
});

test('the writer supplies separate title metadata without changing a manual title or legacy draft', async () => {
  const titles = loadTs(path.join(__dirname, '../../../packages/api/src/music/title.ts'));
  const song = 'Warm folk, guitar and a playful alto.\n\nLyrics:\n[Verse 1]\nKite climbs over the barn\nREADBACK: A kite escapes.';
  for (const header of ['TITLE: Ribbon Thief', '**Title:** “Ribbon Thief”', 'Song Title: Ribbon Thief']) {
    const parsed = titles.splitLyricTitle(header + '\n' + song);
    assert.equal(parsed.title, 'Ribbon Thief');
    assert.equal(parsed.script, song);
  }
  assert.equal(titles.splitLyricTitle(song).title, undefined);
  assert.equal(titles.splitLyricTitle(song).script, song);
  assert.equal(titles.splitLyricTitle('TITLE: Untitled\n' + song).title, undefined);
  assert.equal(titles.splitLyricTitle('Warm folk.\nLyrics:\nTitle: a line I wrote').script, 'Warm folk.\nLyrics:\nTitle: a line I wrote');
  for (const title of ['', 'My title']) {
    const desk = booth(['TITLE: Ribbon Thief\n' + song], { KADE_LYRIC_REPEATS: '0' });
    const start = await desk.request('post/script', { engine: 'lyria', mode: 'write', text: 'A short kite jingle.', title, thinkMode: 'high', notify: false });
    let polled;
    for (let i = 0; i < 10; i++) { await new Promise(setImmediate); polled = await desk.request('get/script/job/:id', {}, { id: start.result.job }); if (polled.result.state !== 'working') break; }
    assert.equal(polled.result.state, 'done', JSON.stringify(polled.result));
    assert.equal(polled.result.result.title, title || 'Ribbon Thief');
    assert.doesNotMatch(polled.result.result.script, /TITLE:|Ribbon Thief/);
    assert.match(polled.result.result.script, /Kite climbs/);
    assert.equal(desk.writerCalls[0].reasoning.effort, 'high');
    assert.equal(desk.writerCalls[0].kade_think_max_effort, undefined);
    assert.equal(desk.writerCalls[0].max_tokens, 65536);
  }
  const prompt = await writing.musicWritingPrompt('Engine format.', { engine: 'lyria', mode: 'write' }, async () => ({ instructions: 'Lyric persona.' }));
  assert.match(prompt, /TITLE:.*specific, original song title/);
  assert.match(prompt, /metadata, never a sung line/);
  const chosen = await writing.musicWritingPrompt('Engine format.', { engine: 'lyria', mode: 'write', title: 'My title' }, async () => ({ instructions: 'Lyric persona.' }));
  assert.match(chosen, /chosen title, exactly: "My title"/);
  const yue = await writing.musicWritingPrompt('No headings other than Lyrics:; an instrumental is only a direction.', { engine: 'yue2', mode: 'write' }, async () => ({ instructions: 'Lyric persona.' }));
  assert.ok(yue.indexOf('No headings other than Lyrics:') < yue.indexOf('SOUND BOOTH DELIVERY CONTRACT'));
  assert.match(yue, /TITLE: metadata line is an exception/);
});

test('a song that reaches the output ceiling is reported rather than returned as a complete draft', async () => {
  const desk = booth([{ text: 'TITLE: Ribbon Thief\nWarm folk.\nLyrics:\n[Verse 1]\nAn unfinished', finishReason: 'length' }]);
  const start = await desk.request('post/script', { engine: 'lyria', mode: 'write', text: 'A kite song.', thinkMode: 'high', notify: false });
  let polled;
  for (let i = 0; i < 10; i++) { await new Promise(setImmediate); polled = await desk.request('get/script/job/:id', {}, { id: start.result.job }); if (polled.result.state !== 'working') break; }
  assert.equal(polled.result.state, 'failed');
  assert.match(polled.result.error, /output limit.*no audio/);
  assert.equal(desk.writerCalls.length, 1);
});

test('the song idea helper uses Sol and respects the same selected thought', async () => {
  for (const thinkMode of ['auto', 'low', 'medium', 'high']) {
    const idea = 'Meter Hearing: Deadpan western swing follows an apologetic driver addressing a broken meter as a judge; after its repaired coin slot accepts his payment, he treats the receipt as a full pardon.';
    const desk = booth([idea]);
    const result = await desk.request('post/idea', { thinkMode });
    assert.equal(result.status, 200, JSON.stringify({ result: result.result, warnings: desk.warnings }));
    assert.equal(result.result.idea, idea);
    const sent = desk.writerCalls[0];
    assert.equal(sent.model, 'openai/gpt-6.1-sol');
    assert.equal(Object.hasOwn(sent, 'temperature'), false);
    assert.equal(Object.hasOwn(sent, 'top_p'), false);
    assert.equal(sent.reasoning?.effort, thinkMode === 'auto' ? undefined : thinkMode);
  }
});

test('a chosen voice is a fixed choice: written for, kept in voice=, and out of the script box', async () => {
  const desk = booth([`${GIRL_XML}\n${GIRL_READBACK}`]);
  const out = await desk.write({ voice_description: GIRL });
  const user = desk.writerCalls[0].messages[1].content;
  assert.match(user, /THE VOICE IS CHOSEN: A cheerful little girl/);
  assert.doesNotMatch(user, /WHO IS SPEAKING|VOICE SEX/, 'neither screen has a sex setting for AuK, so no default "female" is pushed on the writer');
  assert.match(desk.writerCalls[0].messages[0].content, /THE VOICE IS CHOSEN, put that description in voice= exactly as given/);
  assert.equal(voiceOf(out.script), GIRL);
  assert.equal(out.voice_description, GIRL);
  assert.equal(out.performance, 'The thunder went boom and I hid under the table with my bunny!');
  assert.equal(out.screenplay, out.performance, 'with her voice in its box, iPhone 2.2.2 gets no VOICE: line either');
  assert.equal(out.problem, null);
  assert.equal(desk.writerCalls.length, 1);
});

test('the Oct 1 shape: a grown woman written for a little girl is asked for once more, naming the mismatch', async () => {
  const desk = booth([`${WOMAN_XML}\n${WOMAN_READBACK}`, `${GIRL_XML}\n${GIRL_READBACK}`]);
  const out = await desk.write({ voice_description: GIRL });
  assert.equal(desk.writerCalls.length, 2);
  assert.match(desk.writerCalls[1].messages[1].content, /YOUR LAST DRAFT WAS WRITTEN FOR A WOMAN, but the voice is chosen and cannot change: A cheerful little girl/);
  assert.equal(voiceOf(out.script), GIRL);
  assert.match(out.readback, /^A little girl about five/);
  assert.ok(out.repairs.includes('wrote it again for the voice you chose'));
  assert.equal(out.problem, null);
  assert.equal(out.note, null);
});

test('a draft still written for someone else is said out loud on both writing paths, and the voice stays hers', async () => {
  const desk = booth([`${WOMAN_XML}\n${WOMAN_READBACK}`, `${WOMAN_XML}\n${WOMAN_READBACK}`]);
  const out = await desk.write({ voice_description: GIRL });
  const warning = 'The writer wrote this for a woman, not the voice you chose. Ask for the script again, or change the voice, before you generate.';
  assert.equal(out.problem, warning, '"Turn my words into a script" says problem');
  assert.equal(out.note, warning, '"Help write this" says note');
  assert.equal(voiceOf(out.script), GIRL);
  const off = booth([`${WOMAN_XML}\n${WOMAN_READBACK}`], { KADE_AUK_VOICE_RETRY: '0' });
  const once = await off.write({ voice_description: GIRL });
  assert.equal(off.writerCalls.length, 1, 'the kill switch skips the second ask');
  assert.equal(once.problem, warning);
});

test('with no voice chosen, the writer picks one and it comes back as the voice, not as script text', async () => {
  const cowboy = 'An old cowboy, gravelly and slow, telling it by a campfire.';
  const desk = booth([`<speak voice="${cowboy}" gender="male">\nMy first horse was a roan mare named Dusty.\n</speak>\nREADBACK: An old cowboy tells about his first horse. About five seconds.`]);
  const out = await desk.write({ text: 'An old cowboy and his first horse.' });
  assert.match(desk.writerCalls[0].messages[1].content, /THE VOICE IS NOT CHOSEN YET/);
  assert.doesNotMatch(desk.writerCalls[0].messages[1].content, /VOICE SEX: female/);
  assert.equal(out.voice_description, cowboy);
  assert.equal(out.performance, 'My first horse was a roan mare named Dusty.');
  assert.match(out.screenplay, /^VOICE: An old cowboy/, 'iPhone 2.2.2 carries the writer\'s voice to its render this way');
});

test('both screens render the same voice and the same words from what the desk handed back', async () => {
  const cowboy = 'An old cowboy, gravelly and slow.';
  const reply = `<speak voice="${cowboy}" gender="male">\n<action>remembering</action>\nMy first horse was a roan mare named "Dusty" & she was wild.\n</speak>\nREADBACK: An old cowboy remembers his first horse.`;
  const out = await booth([reply]).write({ text: 'An old cowboy and his first horse.' });
  /* iPhone 2.2.2: its voice box is empty, it sends the screenplay as the script. */
  const phone = booth();
  await phone.render({ script: out.screenplay });
  /* This page: the voice went into Describe a new voice, the script box holds the performance. */
  const web = booth();
  await web.render({ script: out.performance, voice_description: out.voice_description });
  for (const wire of [phone.bridgeCalls[0], web.bridgeCalls[0]]) {
    assert.equal(voiceOf(wire.prompt), cowboy);
    assert.equal(spoken(wire.prompt), spoken(out.script));
    assert.match(wire.prompt, /<action>remembering<\/action>/);
  }
  /* And with a voice she chose: the phone's screenplay has no header, her box goes with it. */
  const chosen = await booth([`${GIRL_XML}\n${GIRL_READBACK}`]).write({ voice_description: GIRL });
  const phoneChosen = booth();
  await phoneChosen.render({ script: chosen.screenplay, voice_description: GIRL });
  assert.equal(voiceOf(phoneChosen.bridgeCalls[0].prompt), GIRL);
  assert.equal(spoken(phoneChosen.bridgeCalls[0].prompt), spoken(chosen.script));
});

test('a reply in the screenplay format is compiled, never wrapped: headers and [cues] are not spoken (Oct 1 Codex find)', async () => {
  const desk = booth(['VOICE: A crisp adult narrator.\nSEX: male\n\nHello. [pause briefly] Please come in.\n(warmly)\nSit down.\nREADBACK: A short greeting.']);
  const out = await desk.write();
  assert.equal(out.problem, null);
  assert.equal(voiceOf(out.script), 'A crisp adult narrator.');
  assert.equal(spoken(out.script), 'Hello. Please come in. Sit down.');
  assert.match(out.script, /<action>pause briefly<\/action>[\s\S]*<action>warmly<\/action>/);
  assert.doesNotMatch(out.performance, /VOICE:|SEX:/);
  assert.equal(out.voice_description, 'A crisp adult narrator.');
  assert.equal(out.readback, 'A short greeting.');
});

test('the desk and /render read one format one way: what the desk says is spoken is what the render speaks', async () => {
  const replies = [
    'Welcome (yes, you). Read the label [A] twice.\nREADBACK: A welcome.',
    '%%%gently%%% Stay a while.\n[smiling]\nThe kettle is on.\nREADBACK: An invitation.',
    '<action>softly</action>\nHello there.\nREADBACK: A hello.',
    'SPEAKER: A tired nurse at the end of a shift.\nWHERE: a hospital break room\n\nOne more hour. ((a door closes)) Then home.\nREADBACK: A nurse, tired.',
    '<speak voice="A calm voice." gender="female" pace="1.2">Read the label [laughing] twice. <emphasis>Then</emphasis> say <break time="1s"/> the end &amp; go.<!-- a note --></speak>\nHope this helps!\nREADBACK: A label.',
  ];
  for (const reply of replies) {
    const out = await booth([reply]).write();
    const phone = booth();
    await phone.render({ script: out.screenplay });
    const flat = (s) => s.replace(/\s+/g, ' ');
    assert.equal(flat(phone.bridgeCalls[0].prompt), flat(out.script), 'the XML handed back is the XML the render sends, line breaks aside');
    assert.equal(spoken(phone.bridgeCalls[0].prompt), spoken(out.script), reply);
    assert.doesNotMatch(spoken(out.script), /%%%|SPEAKER:|WHERE:|\[|<|emphasis|break|note|Hope this helps|pace/, reply);
  }
  const marked = await booth([replies.at(-1)]).write();
  assert.equal(spoken(marked.script), 'Read the label twice. Then say the end & go.');
  assert.ok(marked.repairs.includes('took out markup the engine would have read aloud'));
});

test('a voice line the writer left inside the XML body moves into the tag instead of being performed', async () => {
  const out = await booth(['<speak voice="A calm man." gender="male">\nVOICE: A calm man.\nSEX: male\n\nGood evening.\n</speak>\nREADBACK: A calm man says good evening.']).write();
  assert.equal(spoken(out.script), 'Good evening.');
  assert.ok(out.repairs.includes('moved a voice line out of the spoken words'));
  const typed = booth();
  await typed.render({ script: '<speak voice="A calm man." gender="male">\nVOICE: A calm man.\nGood evening.\n</speak>' });
  assert.equal(spoken(typed.bridgeCalls[0].prompt), 'Good evening.');
});

test('mood and reference lines agree with the AuK worker; Seed keeps its own', async () => {
  const xml = `${GIRL_XML}\n${GIRL_READBACK}`;
  const plain = booth([xml]);
  await plain.write({ voice_description: GIRL, mood: 'tender' });
  const user = plain.writerCalls[0].messages[1].content;
  assert.match(user, /Give it once, as one short <action> direction before the first spoken word/);
  assert.doesNotMatch(user, /Work this into the directions/);
  const cloned = booth([xml]);
  await cloned.write({ voice_description: GIRL, mood: 'tender', reference_voice_url: 'https://example.invalid/clip.wav' });
  const clonedUser = cloned.writerCalls[0].messages[1].content;
  assert.match(clonedUser, /The imported recording sets the delivery, so let the words suit this mood and add no directions/);
  assert.match(clonedUser, /the clip supplies the voice, accent and delivery/);
  const format = booth([xml]);
  await format.write({ mode: 'format', text: 'Hello there, little one.' });
  assert.doesNotMatch(format.writerCalls[0].messages[0].content, /structural tags BETWEEN/);
  assert.match(format.writerCalls[0].messages[0].content, /Do not add directions, speaker names, sound effects or pauses of your own/);
  const seedScript = '[Setting: A quiet room.]\nAvery (calm adult) says: "Hello."';
  const seed = booth([`${seedScript}\nREADBACK: A short scene.`]);
  const seedOut = await seed.write({ engine: 'seed', mood: 'tender' });
  assert.equal(seedOut.script, seedScript);
  assert.equal(seedOut.screenplay, seedScript);
  assert.equal(seedOut.performance, undefined);
  assert.equal(seedOut.voice_description, undefined);
  assert.match(seed.writerCalls[0].messages[1].content, /VOICE SEX: female/);
  assert.match(seed.writerCalls[0].messages[1].content, /Work this into the directions/);
});

test('Describe a new voice still wins at render, and now says so when the script named someone else', async () => {
  const old = booth();
  await old.render({ script: WOMAN_XML, voice_description: GIRL });
  assert.equal(voiceOf(old.bridgeCalls[0].prompt), GIRL);
  const said = 'The voice in Describe a new voice was used. The voice written in the script was not.';
  const quiet = booth();
  const same = await quiet.render({ script: GIRL_XML, voice_description: GIRL });
  assert.ok(!String(same.estimate.spoken).includes(said));
  const loud = booth();
  const differs = await loud.render({ script: WOMAN_XML, voice_description: GIRL });
  assert.ok(String(differs.estimate.spoken).includes(said), differs.estimate.spoken);
  const cloned = booth();
  const withClip = await cloned.render({ script: WOMAN_XML, voice_description: GIRL, reference_voice_url: 'https://example.invalid/clip.wav' });
  assert.ok(!String(withClip.estimate.spoken).includes(said), 'a reference sets the voice by itself');
});

test('an AuK edit is saved and shown as an edit, never as a script to hear', async () => {
  const instruction = 'Make the delivery cheerful. Preserve the words.';
  const desk = booth();
  await desk.render({ auk_task: 'edit', instruction, reference_voice_url: 'https://example.invalid/recordings/audios/offline-owner/take.wav', readback: 'Whatever the screen showed.' });
  assert.equal(desk.bridgeCalls[0].auk_task, 'edit');
  assert.equal(desk.bridgeCalls[0].instruction, instruction);
  assert.equal(desk.saved.at(-1).readback, `Your imported recording, edited: ${instruction}`);
  const { projectView } = desk.internals;
  const before = projectView({ _id: 'p1', engine: 'scenema', script: instruction, readback: instruction, options: { auk_task: 'edit', instruction } });
  assert.equal(before.screenplay, '', 'iPhone 2.2.2 puts screenplay in the script box; the instruction stays in Edit instructions');
  assert.equal(before.performance, '');
  assert.equal(before.readback, `Your imported recording, edited: ${instruction}`);
  assert.equal(before.why, 'AuK — an edit of an imported recording');
  /* A speech take on the same project does not carry the edit's description forward. */
  const speech = booth();
  await speech.render({ script: GIRL_XML, readback: `Your imported recording, edited: ${instruction}` });
  assert.equal(speech.saved.at(-1).readback, '');
});

test('a saved speech project opens with the voice in its own place', async () => {
  const { projectView } = booth().internals;
  const boxed = projectView({ _id: 'p2', engine: 'scenema', script: GIRL_XML, options: { voice_description: GIRL } });
  assert.doesNotMatch(boxed.screenplay, /VOICE:/);
  assert.equal(boxed.performance, 'The thunder went boom and I hid under the table with my bunny!');
  assert.equal(boxed.voice_description, GIRL);
  const writers = projectView({ _id: 'p3', engine: 'scenema', script: WOMAN_XML, options: {} });
  assert.match(writers.screenplay, /^VOICE: A woman in her early thirties/, 'the only place this project keeps its voice, for iPhone 2.2.2');
  assert.doesNotMatch(writers.performance, /VOICE:/);
  assert.equal(writers.voice_description, 'A woman in her early thirties, hushed and intimate.');
  const lyria = projectView({ _id: 'p4', engine: 'lyria', script: 'A brief.', options: {} });
  assert.equal(lyria.performance, undefined);
});

test('previews keep a child voice out of the spoken words (carried over from the Oct 1 Codex work)', async () => {
  const empty = booth();
  const result = await empty.render({ preview: true, script: `<speak voice="${GIRL}" gender="female"></speak>`, voice_description: GIRL });
  const wire = empty.bridgeCalls[0];
  assert.equal(voiceOf(wire.prompt), GIRL);
  assert.equal(wire.mode, 'voice_design');
  assert.doesNotMatch(result.estimate.spoken, /little girl|<speak|VOICE:/);
  const shaped = booth();
  const r2 = await shaped.render({ preview: true, script: `VOICE: ${GIRL}\nSEX: female\n\n[gentle]\nHello, everyone. Welcome to the show.` });
  assert.equal(voiceOf(shaped.bridgeCalls[0].prompt), GIRL);
  assert.equal(r2.estimate.sampleText, 'Hello, everyone. Welcome to the show.');
  const cloned = booth();
  await cloned.render({ preview: true, script: '<speak voice="A youthful voice." gender="female">Hello.</speak>', reference_voice_url: 'https://example.invalid/ref.wav' });
  assert.equal(cloned.bridgeCalls[0].mode, undefined);
  assert.equal(cloned.bridgeCalls[0].reference_voice_url, 'https://example.invalid/ref.wav');
});

test('who a voice is: only a plain contradiction counts', () => {
  const { voicesDisagree, voiceTraits, speakerClause } = screenplay;
  assert.equal(voicesDisagree(GIRL, 'A woman in her early thirties, hushed.'), 'a woman');
  assert.equal(voicesDisagree('A gravelly old man in his seventies.', 'A bright young woman.'), 'a woman');
  assert.equal(voicesDisagree(GIRL, 'A grown-up narrator.'), 'a grown-up');
  assert.equal(voicesDisagree('A deep male voice.', 'A soft female voice.'), 'a female voice');
  assert.equal(voicesDisagree(GIRL, speakerClause('A little girl tells how she and her mom found a kitten.')), null, 'her mom is not the speaker');
  assert.equal(speakerClause('In hushed tones, a woman in her thirties recounts the night of the storm.'), 'In hushed tones, a woman in her thirties');
  assert.equal(voicesDisagree('A warm grandmother.', speakerClause('A bedtime story about a little boy and his puppy, told warmly.')), null, 'a character in the story is not the voice');
  assert.equal(voicesDisagree('A warm grandmother.', speakerClause('A grandmother tells a story about a little boy and his puppy.')), null);
  assert.equal(voicesDisagree('A woman remembering her childhood.', 'A woman in her forties.'), null, 'childhood is not a child');
  assert.equal(voicesDisagree('A sassy girl from Atlanta.', 'A woman with a quick laugh.'), null, 'a bare "girl" says nothing about age');
  assert.deepEqual(voiceTraits('About one minute of a cheerful voice.'), { age: null, sex: null }, 'one minute is not an age');
  assert.deepEqual(voiceTraits('A shy boy, around seven, soft-spoken.'), { age: 'child', sex: 'male' });
});

/** The page's main script as served, and `cut(name)` to lift one of its functions out whole. */
function pageScript() {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  const html = context.module.exports.soundBoothHtml;
  const main = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('function takeDeskVoice('));
  assert.ok(main, 'takeDeskVoice is on the page');
  const cut = (name) => {
    const at = main.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is on the page');
    const start = main.slice(at - 6, at) === 'async ' ? at - 6 : at;
    let depth = 0;
    for (let i = main.indexOf('{', at); i < main.length; i++) {
      if (main[i] === '{') depth++;
      else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + name);
  };
  return { main, cut };
}

test('the page puts the performance in the script box and the voice in its own box', () => {
  const { cut } = pageScript();
  const make = new Function('state', 'renderSettings', 'writingUndo',
    `${['deskScript', 'deskVoiceUntouched', 'forDesk', 'takeDeskVoice'].map(cut).join('\n')}\nreturn { deskScript, forDesk, takeDeskVoice, undo: () => writingUndo };`);
  const fresh = (values = {}, clips = []) => {
    const state = { engine: 'scenema', values, clips };
    return { state, page: make(state, () => {}, { engine: 'scenema', text: 'before' }) };
  };
  const data = { script: WOMAN_XML, screenplay: 'VOICE: x\n\nWords.', performance: 'Words.', voice_description: 'A calm man.' };
  const a = fresh();
  assert.equal(a.page.deskScript(data), 'Words.');
  assert.equal(a.page.takeDeskVoice(data, true), 'The voice it wrote for is now in Describe a new voice.');
  assert.equal(a.state.values.voice_description, 'A calm man.');
  assert.equal(a.page.undo().voice, '', 'Undo writing change empties the box again');
  /* The desk's voice, left alone, is not her choice: the next idea gets its own voice. */
  assert.equal(a.page.forDesk({ voice_description: 'A calm man.', text: 'x' }).voice_description, undefined);
  a.page.takeDeskVoice({ ...data, voice_description: 'A bright young woman.' }, true);
  assert.equal(a.state.values.voice_description, 'A bright young woman.');
  a.state.values.voice_description = 'A bright young woman, a little hoarse.';
  assert.equal(a.page.forDesk({ voice_description: 'A bright young woman, a little hoarse.' }).voice_description, 'A bright young woman, a little hoarse.', 'once she edits it, it is hers');
  assert.equal(a.page.takeDeskVoice(data, true), '');
  assert.equal(a.state.values.voice_description, 'A bright young woman, a little hoarse.');
  const mine = fresh({ voice_description: GIRL });
  assert.equal(mine.page.takeDeskVoice(data, true), '');
  assert.equal(mine.state.values.voice_description, GIRL, 'a voice she typed is never replaced');
  const clip = fresh({}, [{ url: 'https://example.invalid/c.wav' }]);
  assert.equal(clip.page.takeDeskVoice(data, true), '');
  assert.equal(clip.state.values.voice_description, undefined, 'a recording sets the voice by itself');
  assert.equal(fresh().page.deskScript({ screenplay: 'Seed script.', script: 'x' }), 'Seed script.', 'other engines are unchanged');
});

/* ---- review 1: the ten minor fixes ---------------------------------------- */

test('review 1 (1): with a reference clip the box is a note about the speaker, never a check or a second ask', async () => {
  for (const clip of [{ reference_voice_url: 'https://example.invalid/clip.wav' }, { audio_urls: ['https://example.invalid/clip.wav'] }]) {
    const desk = booth([`${WOMAN_XML}\n${WOMAN_READBACK}`]);
    const out = await desk.write({ voice_description: GIRL, ...clip });
    assert.equal(desk.writerCalls.length, 1, 'the clip is the voice, so the draft is not asked for again over the box');
    const user = desk.writerCalls[0].messages[1].content;
    assert.doesNotMatch(user, /THE VOICE IS CHOSEN/);
    assert.match(user, /THE SPEAKER, AS DESCRIBED: A cheerful little girl[^\n]*\nThe reference clip supplies the voice itself\. Put this description in voice= as written, and let the words suit this speaker\./);
    assert.equal(out.problem, null);
    assert.equal(out.note, null, 'no "not the voice you chose" about a voice the clip replaces');
    assert.equal(voiceOf(out.script), GIRL);
  }
  const format = booth([`${GIRL_XML}\n${GIRL_READBACK}`]);
  await format.write({ mode: 'format', text: 'Hello there, little one.', voice_description: GIRL, reference_voice_url: 'https://example.invalid/clip.wav' });
  assert.match(format.writerCalls[0].messages[1].content, /Put this description in voice= as written, and keep their words as they are\./);
});

test('review 1 (2): a voice no one named is the neutral voice, and nothing goes in her voice box', async () => {
  const { wrapSpeak } = booth().internals;
  assert.equal(voiceOf(wrapSpeak({ body: 'Hello.' })), screenplay.NEUTRAL_VOICE, 'the old fallback was an adult woman');
  for (const reply of [
    '<action>softly</action>\nHello there.\nREADBACK: A hello.',
    '<speak gender="female">\nHello there.\n</speak>\nREADBACK: A hello.',
    'Hello there.\nREADBACK: A hello.',
  ]) {
    const out = await booth([reply]).write({ text: 'Say hello.' });
    assert.equal(voiceOf(out.script), screenplay.NEUTRAL_VOICE, reply);
    assert.doesNotMatch(out.script, /woman/i, reply);
    assert.equal(out.voice_description, '', reply);
    assert.doesNotMatch(out.screenplay, /VOICE:|SEX:/, reply);
    assert.equal(spoken(out.script), 'Hello there.', reply);
    /* iPhone 2.2.2 renders that screenplay with an empty box: the same neutral voice. */
    const phone = booth();
    await phone.render({ script: out.screenplay });
    assert.equal(voiceOf(phone.bridgeCalls[0].prompt), screenplay.NEUTRAL_VOICE, reply);
  }
  /* Bare pieces with the writer's own voice line are still the writer's voice. */
  const named = await booth(['<action>softly</action>\nVOICE: A calm man.\nGood evening.\nREADBACK: A calm man says good evening.']).write();
  assert.equal(named.voice_description, 'A calm man.');
  assert.equal(voiceOf(named.script), 'A calm man.');
  assert.equal(spoken(named.script), 'Good evening.');
  /* Her box still wins over bare pieces, with no woman anywhere. */
  const boxed = await booth(['<action>softly</action>\nHello there.\nREADBACK: A calm man says hello.']).write({ voice_description: 'A calm man.' });
  assert.equal(boxed.voice_description, 'A calm man.');
  assert.equal(voiceOf(boxed.script), 'A calm man.');
  /* The page leaves the box alone when the desk names no voice. */
  const { cut } = pageScript();
  const state = { engine: 'scenema', values: {}, clips: [] };
  const page = new Function('state', 'renderSettings', 'writingUndo',
    `${['deskVoiceUntouched', 'takeDeskVoice'].map(cut).join('\n')}\nreturn { takeDeskVoice };`)(state, () => {}, null);
  assert.equal(page.takeDeskVoice({ performance: 'Hello there.', voice_description: '' }, true), '');
  assert.equal(state.values.voice_description, undefined);
});

test('review 1 (3): VOICE: and SEX: lines after the opening directions are lifted, never spoken', async () => {
  /* The probe from the review: XML with a direction first. */
  const xml = await booth(['<speak voice="A calm man.">\n<action>softly</action>\nVOICE: A calm man.\nSEX: male\nGood evening.\n</speak>\nREADBACK: A calm man says good evening.']).write();
  assert.equal(spoken(xml.script), 'Good evening.');
  assert.match(xml.script, /<action>softly<\/action>\nGood evening\./);
  assert.ok(xml.repairs.includes('moved a voice line out of the spoken words'));
  /* A screenplay reply that opens with [tender]. */
  const sp = await booth(['[tender]\n\nVOICE: A calm man.\nSEX: male\n\nGood evening.\nREADBACK: A calm man says good evening.']).write();
  assert.equal(spoken(sp.script), 'Good evening.');
  assert.equal(voiceOf(sp.script), 'A calm man.');
  assert.equal(sp.voice_description, 'A calm man.');
  assert.match(sp.script, /<action>tender<\/action>/);
  assert.equal(sp.performance, '[tender]\nGood evening.');
  /* The same in what she types: a screenplay, and raw XML. */
  const typed = booth();
  await typed.render({ script: '[tender] ((rain on the roof))\nVOICE: A calm man.\nGood evening.' });
  assert.equal(voiceOf(typed.bridgeCalls[0].prompt), 'A calm man.');
  assert.equal(spoken(typed.bridgeCalls[0].prompt), 'Good evening.');
  const raw = booth();
  await raw.render({ script: '<speak gender="male">\n<action>softly</action>\nVOICE: A calm man.\nGood evening.\n</speak>' });
  assert.equal(voiceOf(raw.bridgeCalls[0].prompt), 'A calm man.');
  assert.equal(spoken(raw.bridgeCalls[0].prompt), 'Good evening.');
  assert.match(raw.bridgeCalls[0].prompt, /<action>softly<\/action>/);
  /* After a direction only the voice words count; after a spoken word nothing does. */
  assert.equal(spoken(screenplay.screenplayToSpeak('[knocking]\nWho: is there at the door?').xml), 'Who: is there at the door?');
  assert.equal(spoken(screenplay.liftBodyHeaders('<speak voice="A calm man.">\n<action>knocking</action>\nWho: is there?\n</speak>').xml), 'Who: is there?');
  assert.equal(spoken(screenplay.screenplayToSpeak('Hello.\nVOICE: A calm man.').xml), 'Hello. VOICE: A calm man.');
});

test('review 1 (4): a single-quoted voice is still the writer\'s voice', async () => {
  assert.deepEqual(screenplay.speakAttrs("<speak voice='A calm man.' gender='male'>"), { voice: 'A calm man.', gender: 'male' });
  assert.equal(screenplay.speakAttrs(`<speak voice="The narrator's own voice." gender='female'>`).voice, "The narrator's own voice.");
  const out = await booth(["<speak voice='A calm man.' gender='male'>\nGood evening.\n</speak>\nREADBACK: A calm man says good evening."]).write();
  assert.equal(out.voice_description, 'A calm man.', 'it used to come back as the generic voice');
  assert.equal(voiceOf(out.script), 'A calm man.');
  assert.match(out.script, /gender="male"/);
  assert.equal(spoken(out.script), 'Good evening.');
});

test('review 1 (5): a structural problem and a voice warning are said together', async () => {
  const onlyDirections = '<speak voice="A woman in her early thirties." gender="female">\n<action>sighs</action>\n</speak>\nREADBACK: A woman in her early thirties sighs.';
  const desk = booth([onlyDirections], { KADE_AUK_VOICE_RETRY: '0' });
  const out = await desk.write({ voice_description: GIRL });
  const structural = desk.internals.checkScenema(out.script);
  assert.match(structural, /no spoken words/);
  const warning = 'The writer wrote this for a woman, not the voice you chose. Ask for the script again, or change the voice, before you generate.';
  assert.equal(out.problem, `${structural} ${warning}`, '"Turn my words into a script" reads only problem');
  assert.equal(out.note, warning);
});

test('review 1 (6): in "Turn my words into a script" a readback alone naming someone else is the description being off', async () => {
  const words = 'The thunder went boom and I hid under the table with my bunny!';
  const readbackOff = 'READBACK: A woman in her early thirties reads a line about hiding from the thunder.';
  const format = booth([`${GIRL_XML}\n${readbackOff}`], { KADE_AUK_VOICE_RETRY: '0' });
  const out = await format.write({ mode: 'format', text: words, voice_description: GIRL });
  const said = 'The description of what you will hear says a woman is speaking, but your words are kept as you wrote them and the voice you chose is used. Only that description is off.';
  assert.equal(out.problem, said);
  assert.equal(out.note, said);
  assert.equal(voiceOf(out.script), GIRL);
  assert.equal(spoken(out.script), words);
  /* The second ask still runs when it is on; the wording follows the draft she keeps. */
  const again = booth([`${GIRL_XML}\n${readbackOff}`, `${GIRL_XML}\n${readbackOff}`]);
  assert.equal((await again.write({ mode: 'format', text: words, voice_description: GIRL })).problem, said);
  assert.equal(again.writerCalls.length, 2);
  /* In Help write this the words are the writer's, so the draft itself is what is off. */
  const write = await booth([`${GIRL_XML}\n${readbackOff}`], { KADE_AUK_VOICE_RETRY: '0' }).write({ voice_description: GIRL });
  assert.match(write.problem, /^The writer wrote this for a woman, not the voice you chose/);
  const { aukVoiceOff, aukVoiceWarning } = format.internals;
  assert.deepEqual({ ...aukVoiceOff(GIRL, 'A woman in her thirties.', '') }, { who: 'a woman', by: 'voice' });
  assert.deepEqual({ ...aukVoiceOff(GIRL, GIRL, readbackOff.slice(10)) }, { who: 'a woman', by: 'readback' });
  /* Review 2: in format mode her words and her voice are kept, so even a wrong voice= is only the description being off. */
  assert.match(aukVoiceWarning({ who: 'a woman', by: 'voice' }, 'format'), /^The description of what you will hear says a woman is speaking/);
  assert.match(aukVoiceWarning({ who: 'a woman', by: 'voice' }, 'write'), /^The writer wrote this for a woman/);
  assert.equal(aukVoiceWarning(null, 'format'), '');
});

test('review 1 (7): a kindergarten teacher or a preschool class is not a child', async () => {
  const { voiceTraits } = screenplay;
  assert.equal(voiceTraits('A kindergarten teacher, warm and patient.').age, null);
  assert.equal(voiceTraits('A kindergarten-teacher voice.').age, null);
  assert.equal(voiceTraits('Her preschool class is singing.').age, null);
  assert.equal(voiceTraits('A preschool teacher with a soft laugh.').age, null);
  assert.equal(voiceTraits('A kindergartner, giggly and quick.').age, 'child');
  assert.equal(voiceTraits('A preschooler who loves trucks.').age, 'child');
  assert.equal(voiceTraits('A kindergarten girl with a lisp.').age, 'child');
  const box = 'A calm woman in her forties.';
  const desk = booth([`<speak voice="${box}" gender="female">\nGood morning, friends. Coats on the hooks, please.\n</speak>\nREADBACK: A kindergarten teacher welcomes her class back after the summer.`]);
  const out = await desk.write({ voice_description: box });
  assert.equal(desk.writerCalls.length, 1, 'no second ask over a teacher');
  assert.equal(out.problem, null);
  assert.equal(out.note, null);
});

test('review 1 (8): the screenplay for older screens has no SEX: line, and VOICE: only when the box was empty', async () => {
  const cowboy = 'An old cowboy, gravelly and slow.';
  const reply = `<speak voice="${cowboy}" gender="male">\nMy first horse was a roan mare.\n</speak>\nREADBACK: An old cowboy tells about his first horse.`;
  const empty = await booth([reply]).write({ text: 'An old cowboy.' });
  assert.equal(empty.screenplay, `VOICE: ${cowboy}\n\nMy first horse was a roan mare.`);
  assert.equal(empty.voice_description, cowboy);
  const phone = booth();
  await phone.render({ script: empty.screenplay });
  assert.equal(voiceOf(phone.bridgeCalls[0].prompt), cowboy);
  assert.equal(spoken(phone.bridgeCalls[0].prompt), spoken(empty.script));
  const chosen = await booth([reply]).write({ text: 'An old cowboy.', voice_description: 'A gravelly old voice.' });
  assert.equal(chosen.screenplay, 'My first horse was a roan mare.');
  const { projectView } = booth().internals;
  const saved = projectView({ _id: 'p5', engine: 'scenema', script: `<speak voice="${cowboy}" gender="male" scene="a campfire">\nHello.\n</speak>`, options: {} });
  assert.equal(saved.screenplay, `VOICE: ${cowboy}\nSCENE: a campfire\n\nHello.`);
  assert.doesNotMatch(saved.screenplay, /SEX:/);
  assert.match(screenplay.speakToScreenplay(`<speak voice="${cowboy}" gender="male">\nHello.\n</speak>`), /^VOICE: .*\nSEX: male\n/, 'the module default still writes SEX: for anyone else who asks');
});

test('review 1 (9): /render lifts header lines out of raw XML, but not spoken lines that start with a header word', async () => {
  for (const line of ['Who: is there at the door?', 'Where: did you put it?', 'Scene: one, take two.', 'Speaker: is this thing on?', 'Language: that is what I teach.']) {
    const desk = booth();
    await desk.render({ script: `<speak voice="A calm man." gender="male">\n${line}\n</speak>` });
    assert.equal(spoken(desk.bridgeCalls[0].prompt), line);
    assert.equal(voiceOf(desk.bridgeCalls[0].prompt), 'A calm man.');
  }
  const typed = booth();
  await typed.render({ script: '<speak voice="A calm man.">\nGENDER: male\nSEX: male\nVOICE: Someone else.\nGood evening.\n</speak>' });
  assert.equal(spoken(typed.bridgeCalls[0].prompt), 'Good evening.');
  assert.equal(voiceOf(typed.bridgeCalls[0].prompt), 'A calm man.', 'the tag keeps the voice it had');
  /* Header words in capitals still lift in any order (review 2: SCENE: before or after VOICE:). */
  for (const body of ['VOICE: A calm man.\nSCENE: a porch at dusk', 'SCENE: a porch at dusk\nVOICE: A calm man.']) {
    const pasted = booth();
    await pasted.render({ script: `<speak>\n${body}\nGood evening.\n</speak>` });
    assert.equal(spoken(pasted.bridgeCalls[0].prompt), 'Good evening.');
    assert.equal(voiceOf(pasted.bridgeCalls[0].prompt), 'A calm man.');
  }
  const lang = booth();
  await lang.render({ script: '<speak voice="A calm man.">\nLANGUAGE: en\nGood evening.\n</speak>' });
  assert.equal(spoken(lang.bridgeCalls[0].prompt), 'Good evening.');
  /* After a direction, a mixed-case Voice: line is speech, not a header (review 2, P9). */
  assert.equal(spoken(screenplay.liftBodyHeaders('<speak voice="A narrator.">\n<action>whispers</action>\nVoice: that is all I have left.\n</speak>').xml), 'Voice: that is all I have left.');
  /* The desk still reads every header word a writer leaves at the top of its own XML. */
  const desk = await booth(['<speak voice="A tired nurse.">\nWHERE: a hospital break room\nOne more hour.\n</speak>\nREADBACK: A tired nurse.']).write();
  assert.equal(spoken(desk.script), 'One more hour.');
});

test('review 1 (10): a voice the desk filled in is hers once she renders with it', async () => {
  const { cut } = pageScript();
  const make = new Function('state', 'document', 'referenceReady', 'updateRenderControls', 'collect', 'isUpload', 'post', 'say', 'startPoll', 'loadLibrary',
    `${['deskVoiceUntouched', 'forDesk', 'doRender'].map(cut).join('\n')}\nreturn { forDesk, doRender };`);
  const run = async (reply) => {
    const els = {};
    const document = { getElementById: (id) => els[id] || (els[id] = { value: '', textContent: '', hidden: true, disabled: false, focus() {} }) };
    document.getElementById('script').value = 'Good evening.';
    const state = { engine: 'scenema', values: { voice_description: 'A calm man.' }, clips: [], deskVoice: 'A calm man.' };
    const sent = [];
    const page = make(state, document, () => true, () => {}, () => ({ engine: 'scenema', voice_description: state.values.voice_description, gender: 'female' }),
      () => false, async (url, body) => { sent.push(body); return reply; }, () => {}, () => {}, () => {});
    assert.equal(page.forDesk({ voice_description: 'A calm man.' }).voice_description, undefined, 'before: the desk voice is not sent as her choice');
    await page.doRender(false);
    assert.equal(sent[0].voice_description, 'A calm man.');
    return { state, page };
  };
  const ok = await run({ ok: true, data: { queued: true, jobId: 'offline-job', projectId: 'project-fixture', estimate: { spoken: 'About a cent.' } } });
  assert.equal(ok.state.deskVoice, null);
  assert.equal(ok.page.forDesk({ voice_description: 'A calm man.' }).voice_description, 'A calm man.', 'the next Help write this sends it as hers');
  const failed = await run({ ok: false, data: { error: 'No.' } });
  assert.equal(failed.state.deskVoice, 'A calm man.', 'a render that never started changes nothing');
});

const SEED_SCENE = [
  '[Setting: Rain taps the roof of a closed repair shop. No music.]',
  'Mira (a low, practical adult voice) says: "You put the radio on my bench again. We agreed I would fix the kettle first."',
  'Otis (an older, eager voice) answers: "The kettle can wait until morning. The school broadcast starts in an hour, and they asked me to listen."',
  'Mira: "They asked you to listen, not to turn this place upside down. Pass me the small screwdriver, please."',
  '[A drawer slides open; loose tools clink.]',
  'Otis: "This one? I kept it separate so you would not have to hunt for it. Can you hear anything through the speaker?"',
  'Mira: "Only a hum. Hold the lamp over here. I need both hands, and I cannot see the wire behind that dial."',
  'Otis: "I can do that. My hand shakes a little, so tell me when it slips. You used to make me hold this same lamp."',
  'Mira: "And you used to explain every repair before you let me touch it. Now let me find the loose connection."',
  '[The radio crackles, then falls quiet.]',
  'Otis: "Was that the station? I thought I heard the presenter take a breath. Try the dial just a little to the left."',
  'Mira: "Keep the lamp still. Yes, there. It is the station, but the speaker cable needs a fresh joint before it will stay."',
  'Otis: "I will fetch the solder. Then you can finish the kettle. I did not mean to leave all the work to you tonight."',
  'Mira: "Look at the cable first. You were the one who spotted it, and I would like you to see why it keeps losing contact."',
  'Otis: "I see it now. I was watching the dial instead. Next time I will bring you a better explanation than a radio that does not work."',
  'Mira: "You have not. Sit beside me and hold this cable while it cools. We can listen without trying to fix anything else."',
  'Otis: "And tomorrow I will make the tea. Provided your kettle really is going to work."',
  'Mira: "It will. Tonight, you get to be the audience. Turn the volume up just enough for the two of us."',
  '[The steady radio signal settles under the rain.]',
].join('\n');
const SEED_READBACK = 'Two people repair a radio together in a rainy shop. Their disagreement softens as they share the work.';

test('Seed writes a developed conversation without the old short default, and returns the near-cap draft intact', async () => {
  assert.ok(SEED_SCENE.length > 1800 && SEED_SCENE.length <= 2048, `fixture is ${SEED_SCENE.length} characters`);
  const desk = booth([`${SEED_SCENE}\nREADBACK: ${SEED_READBACK}`]);
  const out = await desk.write({ engine: 'seed', text: 'Two people repair a radio after closing.', audio_urls: ['https://fixtures.invalid/voice.wav'] });
  const system = desk.writerCalls[0].messages[0].content;
  assert.match(system, /sustained, natural dialogue/);
  assert.match(system, /distinct wants and concrete things to do/);
  assert.match(system, /1,600 to 2,000 characters/);
  assert.doesNotMatch(system, /30 to 60 seconds|80 to 160 words|under 1,800|cut the number of lines before/);
  assert.match(system, /redundant descriptions before meaningful dialogue/);
  assert.match(desk.writerCalls[0].messages[1].content, /REFERENCE CLIPS IMPORTED: 1.*@Audio1/);
  assert.equal(desk.writerCalls[0].max_tokens, 16384, 'the writer has room for reasoning and the complete draft');
  assert.equal(desk.writerCalls.length, 1, 'READBACK is separate and does not cause an extra paid shortening pass');
  assert.equal(out.script, SEED_SCENE);
  assert.equal(out.screenplay, SEED_SCENE);
  assert.equal(out.readback, SEED_READBACK);
  assert.equal(out.problem, null);
  assert.equal(Object.hasOwn(out, 'performance'), false, 'AuK field placement is not applied to Seed');
  assert.equal(Object.hasOwn(out, 'voice_description'), false);
});

test('Seed formatting keeps supplied wording, repetition and order without the write-mode length target', async () => {
  const words = 'Ari says: "Wait. Wait, I said. I can\'t hear you."\nBo answers: "I can\'t hear you either; leave it where it is."';
  const desk = booth([`${words}\nREADBACK: Two people try to hear each other.`]);
  const out = await desk.write({ engine: 'seed', mode: 'format', text: words });
  const system = desk.writerCalls[0].messages[0].content;
  assert.match(system, /Keep every sentence they wrote, in their order, in their wording/);
  assert.doesNotMatch(system, /1,600 to 2,000|developed scene carried by sustained/);
  assert.equal(desk.writerCalls[0].messages[1].content.split('\n\n')[0], `THEIR WORDS:\n${words}`);
  assert.equal(out.script, words);
  assert.equal(desk.writerCalls.length, 1);
});

test('Seed sound-only requests accept bracketed ambience with no cast, music or invented spoken words', async () => {
  const ambient = '[Steady rain on an open courtyard, occasional water dripping into a metal bucket. No music, voices or narration.]';
  const brief = 'Courtyard rain and dripping water only. No speech, no voices, no music.';
  const desk = booth([`${ambient}\nREADBACK: Rain and dripping water in a courtyard, with no voices or music.`]);
  const out = await desk.write({ engine: 'seed', text: brief });
  const system = desk.writerCalls[0].messages[0].content;
  assert.match(system, /without speech, keep it wordless and do not pad/);
  assert.match(system, /no voices, narrator, dialogue or sung words/);
  assert.doesNotMatch(system, /include all five/);
  assert.ok(desk.writerCalls[0].messages[1].content.includes(brief));
  assert.equal(out.script, ambient);
  assert.equal(out.problem, null);
  assert.equal(desk.writerCalls.length, 1);
});

test('Seed explicitly short and single-narrator requests remain short and keep their requested form', async () => {
  for (const [brief, script] of [
    ['A ten-second spoken station ident.', 'Announcer (warm): "You are listening to the evening service. Stay with us."'],
    ['A single narrator reads a twenty-second letter; no dialogue.', 'Narrator (quiet): "I left the gate open for you. Come in when you get here; I will be in the kitchen."'],
    ['A single narrator tells a story about two sisters, no dialogue.', 'Narrator (warm): "The sisters spent the morning looking for their old home. At the last corner, they recognized the steps."'],
  ]) {
    const desk = booth([`${script}\nREADBACK: One voice speaks the requested short piece.`]);
    const out = await desk.write({ engine: 'seed', text: brief });
    assert.match(desk.writerCalls[0].messages[0].content, /Honor their requested form and length/);
    assert.match(desk.writerCalls[0].messages[0].content, /a short ident, jingle or a single narrated voice/);
    assert.match(desk.writerCalls[0].messages[0].content, /have not asked for narration, a monologue or no dialogue/);
    assert.equal(out.script, script);
    assert.equal(desk.writerCalls.length, 1);
  }
});

test('Seed overflow asks for concise directions before cutting dialogue and keeps a complete repaired draft', async () => {
  const over = `[Repeated weather detail: ${'rain on the roof, '.repeat(35)}]\n${SEED_SCENE}`;
  const desk = booth([`${over}\nREADBACK: ${SEED_READBACK}`, SEED_SCENE]);
  const out = await desk.write({ engine: 'seed', text: 'Two people repair a radio after closing.' });
  assert.equal(desk.writerCalls.length, 2, 'only the existing over-cap rewrite runs');
  const rewrite = desk.writerCalls[1].messages[0].content;
  assert.match(rewrite, /target is under 2000/);
  assert.match(rewrite, /redundant setting descriptions, repeated voice traits and unnecessary delivery cues before cutting meaningful dialogue/);
  assert.match(rewrite, /requested sound constraints and its complete ending/);
  assert.match(rewrite, /wordless piece wordless; never invent speech/);
  assert.equal(desk.writerCalls[1].max_tokens, 16384);
  assert.equal(out.script, SEED_SCENE);
  assert.ok(out.repairs.some((note) => note.startsWith('cut to fit Seed\'s cap:')));
  assert.equal(out.problem, null);
});

test('Seed still has a deterministic 2048-character fallback when the existing rewrite stays too long', async () => {
  const over = `${SEED_SCENE}\n${'Otis: "The lamp can stay here until we finish the repair."\n'.repeat(18)}[The steady radio signal settles under the rain.]`;
  const desk = booth([`${over}\nREADBACK: ${SEED_READBACK}`, over]);
  const out = await desk.write({ engine: 'seed', text: 'Two people repair a radio after closing.' });
  assert.equal(desk.writerCalls.length, 2);
  assert.ok(out.script.length <= 2048);
  assert.ok(out.script.endsWith('[The steady radio signal settles under the rain.]'));
  assert.ok(out.repairs.some((note) => note.startsWith('Cut to fit Seed Audio:')));
  assert.equal(out.problem, null);
});
