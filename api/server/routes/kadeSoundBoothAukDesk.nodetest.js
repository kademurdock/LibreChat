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
 *   - an AuK edit is described as an edit, not as a script to hear.
 * Run: node --test kadeSoundBoothAukDesk.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const screenplay = require('./kadeSoundBoothScreenplay');

const ROUTE = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
const LOCAL = ['./kadeSoundBoothSplit', './kadeSoundBoothScreenplay', './kadeSoundBoothPaste', './kadeSoundBoothCarry'];

/** The route, loaded the way the app loads it, with the writer answering from `replies` in order. */
function booth(replies = [], env = {}) {
  const handlers = new Map();
  const writerCalls = [];
  const bridgeCalls = [];
  const saved = [];
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
        return { data: { choices: [{ message: { content: reply } }], usage: { cost: 0 } } };
      } };
      if (name === '@librechat/api') return {
        writingCost: () => ({ costUSD: 0, measured: true }),
        musicWritingPrompt: async (base) => base, musicWritingSettings: () => ({}),
        yueStylesEnabled: () => false, yueStyles: {}, effectsGuide: {},
        createYueRouter: () => () => {}, createEffectsRouter: () => () => {}, createLyricsRouter: () => () => {},
      };
      if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
      if (name === '~/models/kadeUsage') return { logKadeUsage: async () => {} };
      if (name === '~/models/kadeSoundBoothProject') return { KadeSoundBoothProject: Project };
      if (name === './kadeSoundBoothChain') return { acquire: async () => 'fixture-lease', release: async () => {}, MAX_PARTS: 12 };
      if (LOCAL.includes(name)) return require(name);
      if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => () => {}, guideFor: (g) => g };
      return {};
    },
  };
  vm.runInNewContext(ROUTE, context);
  const call = async (key, body) => {
    let status = 200;
    let result;
    const res = { status(v) { status = v; return this; }, json(v) { result = v; return this; } };
    await handlers.get(key)({ user: { id: 'offline-owner' }, body }, res);
    assert.equal(status, 200, JSON.stringify(result));
    return result;
  };
  return {
    writerCalls, bridgeCalls, saved, internals: context.module.exports._internals,
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
  await desk.render({ auk_task: 'edit', instruction, reference_voice_url: 'https://example.invalid/take.wav', readback: 'Whatever the screen showed.' });
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

test('the page puts the performance in the script box and the voice in its own box', () => {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  const html = context.module.exports.soundBoothHtml;
  const main = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('function takeDeskVoice('));
  assert.ok(main, 'takeDeskVoice is on the page');
  const cut = (name) => {
    const start = main.indexOf('function ' + name + '(');
    let depth = 0;
    for (let i = main.indexOf('{', start); i < main.length; i++) {
      if (main[i] === '{') depth++;
      else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + name);
  };
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
