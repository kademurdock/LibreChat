'use strict';
/* The ACE-Step XL card on the Sound Booth web page (Oct 10 2026), without a browser. The page's functions are cut out of
 * its script by their braces and run as a browser would, the way kadeSoundBoothPage.nodetest.js does; the card itself
 * comes from the guide (ace.ts aceGuide), so what is checked here is every place the page decides by engine.
 * soundBoothAce.selftest.cjs drives the same page in a real browser. The words below are invented placeholders.
 * Run: node --test api/server/routes/kadeSoundBoothAcePage.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  return context.module.exports.soundBoothHtml;
}
const html = buildPage();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const main = scripts.find((s) => s.includes('function confirmRender('));

function pageFunction(name) {
  const start = main.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' is on the page');
  let depth = 0;
  for (let i = main.indexOf('{', start); i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

const SONG_ENGINES = ['lyria', 'yue2', 'ace'];
const DIRECTION = 'A slow soul song, Rhodes and brushed drums.';
const DRAFT = DIRECTION + '\n\nLyrics:\n[Verse 1]\nthe invented words';

test('the page script still compiles and no backspace character crept in', () => {
  assert.ok(main);
  new Function(main);
  assert.equal(html.includes('\b'), false);
});

test('no place that decides "a song engine" names Lyria and YuE2 and forgets ACE-Step XL', () => {
  const lines = main.split('\n').filter((line) => line.includes("'lyria'") && line.includes("'yue2'"));
  assert.ok(lines.length >= 20, 'the guard is looking at the places it should: ' + lines.length);
  const missing = lines.filter((line) => !line.includes("'ace'"));
  assert.deepEqual(missing.map((line) => line.trim().slice(0, 120)), [], 'a song-engine test that leaves ace out');
  /* The same for the arrays and the lists of names. */
  assert.match(main, /var engineOrder=\['scenema','lyria','yue2','ace','stable','seed'\];/);
  assert.match(main, /ENG_NAME = \{[^}]*ace:'ACE-Step XL'/);
  assert.match(main, /var music=\['lyria','yue2','ace'\], sound=\['scenema','seed','stable'\];/, 'Copy draft offers ACE-Step XL beside the other song engines');
  assert.match(main, /\['lyria','yue2','ace'\]\.indexOf\(saved\.engine\)>=0/, 'a song draft started on the ACE card is picked up again');
  assert.match(main, /\['lyria','yue2','ace'\]\.indexOf\(legacy\[1\]\)>=0/);
});

test('the ACE card says what the YuE2 card says: Make music, Write my song idea, a hint, and the announcement', () => {
  assert.match(pageFunction('renderLabel'), /\(state\.engine==='lyria'\|\|state\.engine==='yue2'\|\|state\.engine==='ace'\) \? 'Make music'/);
  const label = (engine) => {
    const ctx = { state: { engine, values: {} } };
    vm.runInNewContext('function isUpload(){return false;}' + pageFunction('renderLabel') + '\nthis.label = renderLabel();', ctx);
    return ctx.label;
  };
  for (const engine of SONG_ENGINES) assert.equal(label(engine), 'Make music', engine);
  assert.equal(label('stable'), 'Generate sounds');
  assert.equal(label('seed'), 'Generate scene');
  assert.equal(label('scenema'), 'Perform script');
  /* The sentence announced on choosing the card is the YuE2 one; the old pin on YuE2's own arm stays true. */
  assert.match(main, /e==='ace'\?'Describe the style, add lyrics, then choose Make music\.':e==='yue2'\?'Describe the style, add lyrics, then choose Make music\.'/);
  const apply = pageFunction('applyWorkflow');
  assert.match(apply, /textContent=\(state\.engine==='yue2'\|\|state\.engine==='ace'\)\?'Write my song idea':music\?'Shape my music idea'/);
  assert.match(apply, /if\(state\.engine==='ace'\)document\.getElementById\('scriptHint'\)\.textContent='Describe the style and singing voice\. Lyrics go in song settings; Write my song idea drafts the direction and the lyrics\.'/);
  assert.match(apply, /var music=\(state\.engine==='lyria'\|\|state\.engine==='yue2'\|\|state\.engine==='ace'\)/);
  /* The ACE hint does not promise a cover, which ACE-Step XL has none of. */
  assert.doesNotMatch(apply.match(/if\(state\.engine==='ace'\)[^\n]*/)[0], /cover/i);
});

test('a render from the ACE card carries no voice, mood, gender or recording, and a written draft is sorted like a YuE2 one', () => {
  const collect = pageFunction('collect');
  assert.match(collect, /state\.engine!=='lyria'&&state\.engine!=='yue2'&&state\.engine!=='ace'&&state\.engine!=='stable'&&!isUpload\(\)\) && !b\.gender/);
  assert.match(collect, /\(state\.engine==='lyria'\|\|state\.engine==='yue2'\|\|state\.engine==='ace'\) && b\.instrumental/);
  assert.match(collect, /state\.clips\.length && state\.engine!=='lyria' && state\.engine!=='ace'/, 'a clip left from another engine never rides along with an ACE render');
  const run = (engine) => {
    const els = { trackTitle: { value: ' Rain song ' }, mood: { value: 'joyful' }, text: { value: 'an idea' } };
    const ctx = {
      state: {
        engine, mode: 'easy', clips: [{ url: 'https://assets.test/old.wav' }],
        values: { lyrics: '[Verse]\nla', quality: 'Best', seed: '7' },
        guide: { engines: { [engine]: { settings: [
          { key: 'lyrics', kind: 'text' }, { key: 'quality', kind: 'choice', options: ['Fast', 'Best'], default: 'Fast' },
          { key: 'length', kind: 'choice', options: ['Match my lyrics', '1:00'], default: 'Match my lyrics' },
          { key: 'seed', kind: 'number', advanced: true },
        ] } } },
      },
      document: { getElementById: (id) => els[id] },
    };
    vm.runInNewContext('function isUpload(){return false;}' + collect + '\nthis.body = collect();', ctx);
    return JSON.parse(JSON.stringify(ctx.body));
  };
  const ace = run('ace');
  assert.deepEqual(ace, { title: 'Rain song', engine: 'ace', mode: 'easy', text: 'an idea', lyrics: '[Verse]\nla', quality: 'Best', seed: 7 }, 'an untouched Length is not sent; the server defaults it');
  const yue = run('yue2');
  assert.equal(yue.reference_voice_url, 'https://assets.test/old.wav', 'YuE2 still sends its cover recording');
  for (const field of ['gender', 'mood', 'voice_description', 'reference_voice_url', 'referenceExpected', 'audio_urls']) assert.equal(field in ace, false, field);
});

test('ACE: a written draft is split into direction and lyrics, and a sung draft with no lyrics heading is not accepted', () => {
  const sorter = (lyrics) => {
    const ctx = { state: { values: { lyrics } }, renders: 0, writingLyrics: undefined };
    vm.runInNewContext(pageFunction('sortDraft') + '\nfunction renderSettings(){ renders++; }\nthis.sortDraft = sortDraft;', ctx);
    return ctx;
  };
  for (const engine of ['yue2', 'ace']) {
    const ctx = sorter('');
    const out = ctx.sortDraft(engine, {}, DRAFT);
    assert.equal(out.result, DIRECTION, engine);
    assert.equal(ctx.state.values.lyrics, '[Verse 1]\nthe invented words');
    assert.equal(ctx.writingLyrics, '', 'Undo knows the lyrics box was empty');
    assert.equal(out.lead, 'The words the desk wrote are now in Lyrics, under Lyrics and song settings. ', 'she is told where the words went');
    assert.throws(() => sorter('').sortDraft(engine, {}, 'A style with no words.'), /did not provide separate lyrics/, engine);
    /* An instrumental draft stays whole, by the Singing choice or by the older switch. */
    const quiet = sorter('');
    quiet.state.values.singing = 'Instrumental, no singing';
    assert.equal(quiet.sortDraft(engine, {}, 'A slow instrumental theme.').result, 'A slow instrumental theme.');
    /* A pasted song is the paste's to explain, not the writer's. */
    const pasted = sorter('');
    assert.match(pasted.sortDraft(engine, { pasted: true, note: 'sorted', problem: 'no words' }, 'pop-punk, 172 BPM').lead, /^sorted One thing to fix first: no words/);
  }
  const replaced = sorter('[Verse]\nolder words');
  assert.equal(replaced.sortDraft('ace', {}, DRAFT).lead, 'Lyrics now holds the desk version of your words; Undo brings back yours. ');
  assert.doesNotThrow(() => sorter('').sortDraft('seed', {}, 'A scene with no heading.'));
});

test('ACE: a song pasted whole into Music direction or the lyrics box is sorted on the page; other engines still do not sort it', () => {
  const { PAGE_SOURCE } = require('./kadeSoundBoothPaste');
  const F3 = '`'.repeat(3);
  const paste = ['Lyrics Box', F3, '[Verse 1]\nsoup at midnight', F3, 'Tag Box', F3, 'pop-punk, 172 BPM', F3, 'Negative Tag Box', F3, 'no autotune', F3].join('\n');
  const rig = (engine) => {
    const els = { script: { value: 'A slow song.', focus() {} }, readback: { textContent: 'an old readback' }, btnRender: { textContent: '' }, set_lyrics: { focus() {} } };
    const ctx = { state: { engine, values: { lyrics: '', instrumental: false }, pendingRender: 'x' }, said: [], writingLyrics: undefined, document: { getElementById: (id) => els[id] }, window: {} };
    vm.runInNewContext(PAGE_SOURCE + pageFunction('sortPastedSong') + `
      function busy(){ return false; }
      function renderSettings(){}
      function renderLabel(){ return 'Make music'; }
      function say(m){ said.push(m); }
      function changeWriting(v){ document.getElementById('script').value = v; }
      this.sortPastedSong = sortPastedSong;`, ctx);
    ctx.paste = (field) => {
      const event = { prevented: false, clipboardData: { getData: () => paste }, preventDefault() { this.prevented = true; } };
      ctx.sortPastedSong(event, field);
      return event.prevented;
    };
    ctx.els = els;
    return ctx;
  };
  for (const engine of SONG_ENGINES) {
    const ctx = rig(engine);
    assert.equal(ctx.paste('lyrics'), true, engine + ': the raw paste is not inserted');
    assert.equal(ctx.state.values.lyrics, '[Verse 1]\nsoup at midnight');
    assert.match(ctx.said[0], /Negative Tag Box was left out/);
    assert.equal(ctx.els.script.value, 'A slow song.', 'her direction is kept when she pasted into the lyrics box');
  }
  for (const engine of ['seed', 'scenema', 'stable']) assert.equal(rig(engine).paste('script'), false, engine);
});

test('ACE: Make music asks for the words first, and lets an instrumental go through', async () => {
  const run = async (sent, engine = 'ace') => {
    const ctx = {
      state: { writing: false, engine }, said: [], rendered: 0, focused: [],
      referenceReady: () => true, collect: () => sent, isUpload: () => false,
      say: (words) => ctx.said.push(words),
      document: { getElementById: (id) => ({ focus() { ctx.focused.push(id); }, open: false }) },
    };
    ctx.doRender = () => { ctx.rendered++; };
    vm.runInNewContext(pageFunction('confirmRender') + '\nthis.confirmRender = confirmRender;', ctx);
    await ctx.confirmRender(false);
    return ctx;
  };
  assert.equal((await run({ singing: 'Instrumental, no singing' })).rendered, 1);
  assert.equal((await run({ lyrics: '[Verse]\nla', singing: 'Sung, with my lyrics' })).rendered, 1);
  for (const sent of [{ singing: 'Sung, with my lyrics' }, {}]) {
    const sung = await run(sent);
    assert.equal(sung.rendered, 0);
    assert.match(sung.said[0], /Add the words to sing/);
    assert.deepEqual(sung.focused, ['set_lyrics'], 'focus goes to the lyrics box');
  }
  assert.equal((await run({}, 'lyria')).rendered, 1, 'Lyria is not made to ask for words');
});

test('a draft started on the ACE card is picked up again only while the guide still has the card', () => {
  const owner = 'a'.repeat(24);
  const read = (saved, engines) => {
    const store = { ['kadeSoundBoothDraftJob:' + owner]: JSON.stringify(saved) };
    const ctx = {
      DRAFT_KEY: 'kadeSoundBoothDraftJob',
      state: { guide: { engines: Object.fromEntries(engines.map((e) => [e, {}])) } },
      localStorage: { getItem: (key) => (key in store ? store[key] : null), setItem() {}, removeItem() {} },
      draftOwner: () => owner,
    };
    vm.runInNewContext(pageFunction('pendingDraft') + '\nthis.kept = pendingDraft();', ctx);
    return JSON.parse(JSON.stringify(ctx.kept));
  };
  const saved = { owner, job: 'abc123', engine: 'ace', title: 'Rain song' };
  assert.deepEqual(read(saved, ['lyria', 'yue2', 'ace']), saved);
  assert.equal(read(saved, ['lyria', 'yue2']), null, 'ACE was switched off: nothing to resume into');
  assert.deepEqual(read({ ...saved, engine: 'yue2' }, ['lyria', 'yue2']), { ...saved, engine: 'yue2' }, 'YuE2 as before');
  assert.equal(read({ ...saved, engine: 'seed' }, ['seed']), null, 'only the song engines keep a draft job');
});

test('the library names ACE-Step XL, offers Cover this take on its takes, and attaches the MP3 for the cover', () => {
  assert.match(main, /p\.engine === 'ace' \? 'ACE-Step XL'/, 'the row names the engine');
  assert.match(main, /\(p\.engine==='yue2'\|\|p\.engine==='ace'\|\|upload\)\?' of execution; startup and idle are extra'/);
  assert.match(main, /\(p\.engine==='lyria'\|\|p\.engine==='yue2'\|\|p\.engine==='ace'\) \? '<button type="button" class="act quiet" data-take-project="'\+esc\(p\.id\)\+'" data-take="'\+n\+'" data-use="cover">Cover this take<\/button>'/);
  assert.match(main, /p\.engine==='lyria'\|\|p\.engine==='ace'\?'Music direction':'Script'/);
  assert.match(main, /'<p class="hint">Carried over from '\+\(p\.carriedFrom\.engine==='ace'\?'an ':'a '\)\+esc\(p\.carriedFrom\.engine==='yue2'\?'YuE2':p\.carriedFrom\.engine==='ace'\?'ACE-Step XL'/);
  /* The cover clip: the MP3 for an ACE take (the 24-bit WAV master is over the booth's twenty megabyte length check past about 70 seconds),
   * and exactly what it was for every other engine. */
  assert.match(main, /state\.clips=\[\{url:project\.engine==='ace'\?take\.url:\(take\.masterUrl\|\|take\.url\),name:project\.title\}\];/);
  assert.match(main, /setEngine\(covering\?'yue2':'scenema'\)/, 'an ACE take is covered on the YuE2 card, which is where covers are');
  /* Saved work of an engine the guide no longer offers does not throw. */
  assert.match(main, /if\(!state\.guide\.engines\[p\.engine\]\)\{ say\('That work was made with an engine that is not open to your account right now\./);
});

test('the download button names a song file for ACE too', () => {
  assert.match(main, /var music=state\.engine==='lyria'\|\|state\.engine==='yue2'\|\|state\.engine==='ace', text=document\.getElementById\('script'\)\.value;/);
  assert.match(main, /a\.download=music\?'music-direction\.txt':'sound-booth-script\.txt'/);
});
