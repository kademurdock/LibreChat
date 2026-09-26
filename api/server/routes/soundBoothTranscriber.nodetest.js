/* Part 293: the Sound Booth's lyric transcriber (packages/api/src/music/lyrics.ts).
 *
 * The prompt now asks Gemini for section tags from an allowed list, the draft's warning depends
 * on which transcriber wrote it, and every fall back to the backup transcriber is logged with
 * Gemini's reason, so RECITATION refusals on commercial songs can be counted. No model is ever
 * called: axios answers through a fake adapter, and the logger is a recording stand-in.
 * (The router, the cache and Mongo are covered by musicControls.selftest.cjs.)
 *
 * Run: node --test api/server/routes/soundBoothTranscriber.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const axios = require('axios');

const logs = [];
const forms = [];
class FakeForm {
  constructor() { this.fields = []; forms.push(this); }
  append(name, value) { this.fields.push([name, value]); }
  getHeaders() { return { 'content-type': 'multipart/form-data; boundary=fixture' }; }
}
const stubs = {
  'form-data': FakeForm,
  '@librechat/data-schemas': {
    logger: {
      info: (line) => logs.push(['info', String(line)]),
      warn: (line) => logs.push(['warn', String(line)]),
      error: (line) => logs.push(['error', String(line)]),
    },
  },
};
function musicLyrics() {
  const ts = require('typescript');
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  compiled._compile(source, filename);
  return compiled.exports;
}
const lyrics = musicLyrics();

/* ---------- fake providers ---------- */
const GEMINI_KEY = 'gemini-key-for-tests';
const SCRIBE_KEY = 'scribe-key-for-tests';
process.env.GEMINI_API_KEY = GEMINI_KEY;
process.env.ELEVENLABS_API_KEY = SCRIBE_KEY;
const calls = [];
/** How Gemini answers: (config, body) => data, or throws. */
let gemini = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Words' }] } }] });
axios.defaults.adapter = async (config) => {
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  calls.push({ url: config.url, body, config });
  let data;
  if (config.url.includes('generativelanguage.googleapis.com')) data = gemini(config, body);
  else if (config.url === 'https://api.elevenlabs.io/v1/speech-to-text') data = { text: 'Backup words. Second line.' };
  else throw new Error('unexpected request ' + config.url);
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
const MP3 = Buffer.from('ID3 fixture audio');
test.beforeEach(() => {
  logs.length = 0;
  calls.length = 0;
  forms.length = 0;
});
const fallbackLine = () => logs.find(([, line]) => line.includes('lyrics gemini fallback'));

test('prompt: Gemini is asked for section tags only where the music marks a section, from the allowed list, on Flash low', async () => {
  let asked;
  gemini = (config, body) => {
    asked = { url: config.url, body };
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[Verse]\nWords' }] } }] };
  };
  const got = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
  assert.equal(got.model, 'gemini-3.8-flash');
  assert.match(asked.url, /\/models\/gemini-3\.8-flash:generateContent$/);
  assert.deepEqual(asked.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  const prompt = asked.body.contents[0].parts[1].text;
  assert.match(prompt, /^Transcribe the complete sung lyrics from this audio/);
  assert.match(prompt, /fill gaps from memory/);
  assert.match(prompt, /only where the music audibly marks a new section: \[Verse\], \[Pre-Chorus\], \[Chorus\], \[Post-Chorus\], \[Bridge\], \[Intro\] or \[Outro\]\./);
  assert.match(prompt, /A block whose words come back as a refrain is \[Chorus\]\. Do not number the labels\./);
  assert.match(prompt, /Return only the lyric transcript with those labels, with no commentary or timestamps\.$/);
  assert.doesNotMatch(prompt, /invented section labels/);
  assert.equal(logs.length, 0, 'a good draft logs nothing');
});

test('tags: only the allowed labels survive, unnumbered and in their proper case; lyric lines are untouched', () => {
  const tidy = lyrics.tidySectionTags;
  assert.equal(
    tidy('[intro]\nOoh\n\n[Verse 1]\nFirst line\nSecond line\n\n[pre chorus]\nRising\n\n[CHORUS x2]\nHook line\n\n[Post-Chorus]\nOh oh\n\n[Interlude]\n\n[Verse 2]\nMore words\n\n[Bridge]\nTurn\n\n[Outro]\nFade'),
    '[Intro]\nOoh\n\n[Verse]\nFirst line\nSecond line\n\n[Pre-Chorus]\nRising\n\n[Chorus]\nHook line\n\n[Post-Chorus]\nOh oh\n\n[Verse]\nMore words\n\n[Bridge]\nTurn\n\n[Outro]\nFade',
  );
  assert.equal(tidy('[Instrumental]\nWords\n[Guitar Solo]\n[Spoken]\nMore'), 'Words\nMore');
  assert.equal(tidy('I sang [unclear] here\n[unclear]\nAnd [Chorus] inside a line'), 'I sang [unclear] here\n[unclear]\nAnd [Chorus] inside a line');
  assert.equal(tidy('No tags at all\nJust words'), 'No tags at all\nJust words');
  assert.equal(tidy('[Interlude]\n[Solo]'), '');
});

test('tags: a draft that was nothing but labels is no draft, and the backup transcriber is used', async () => {
  gemini = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[Instrumental]\n\n[Interlude]' }] } }] });
  const got = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
  assert.equal(got.model, 'scribe_v2');
  assert.match(fallbackLine()[1], /reason=finish:STOP-empty /);
});

test('warning: Gemini tags are guesses to check; the backup draft says plainly it has no tags', () => {
  const fromGemini = lyrics.lyricsWarning('gemini-3.8-flash');
  assert.match(fromGemini, /wrong or missing words/);
  assert.match(fromGemini, /the section tags are guesses from the music/);
  assert.match(fromGemini, /correct the words and the tags in the Lyrics box before generating\.$/);
  const fromBackup = lyrics.lyricsWarning('scribe_v2');
  assert.match(fromBackup, /^Draft lyrics from the backup transcriber, so they have no section tags\. Add tags such as \[Verse\] and \[Chorus\] yourself\./);
  assert.match(fromBackup, /wrong or missing words/);
  assert.doesNotMatch(fromBackup, /guesses/);
  // An unknown or missing model is never promised tags.
  assert.equal(lyrics.lyricsWarning(undefined), fromBackup);
  assert.equal(lyrics.lyricsWarning('nova-3'), fromBackup);
});

test('log: RECITATION, a safety block, MAX_TOKENS and an empty answer are each counted before the fallback', async () => {
  for (const [answer, reason] of [
    [{ candidates: [{ finishReason: 'RECITATION' }] }, 'finish:RECITATION'],
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'blocked:PROHIBITED_CONTENT'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Half a song' }] } }] }, 'finish:MAX_TOKENS'],
    [{ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'reasoning only' }] } }] }, 'finish:STOP-empty'],
    [{}, 'finish:no-candidate'],
  ]) {
    logs.length = 0;
    forms.length = 0;
    gemini = () => answer;
    const got = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 192.4);
    assert.equal(got.model, 'scribe_v2', reason);
    assert.equal(got.transcript, 'Backup words.\nSecond line.');
    assert.deepEqual(forms[0].fields.find(([name]) => name === 'model_id'), ['model_id', 'scribe_v2']);
    const [level, line] = fallbackLine();
    assert.equal(level, 'warn');
    assert.equal(line, `[music/lyrics] lyrics gemini fallback reason=${reason} model=gemini-3.8-flash audio/mpeg ${MP3.length}B 192s; using scribe_v2`);
  }
});

test('log: an HTTP refusal and a timeout from Gemini name their status or code, never the key', async () => {
  gemini = (config) => {
    throw new axios.AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, null, {
      status: 429, statusText: 'Too Many Requests', headers: {}, config,
      data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },
    });
  };
  assert.equal((await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30)).model, 'scribe_v2');
  assert.match(fallbackLine()[1], /reason=http:429:RESOURCE_EXHAUSTED /);

  logs.length = 0;
  gemini = (config) => { throw new axios.AxiosError('timeout of 60000ms exceeded', 'ECONNABORTED', config); };
  await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
  assert.match(fallbackLine()[1], /reason=error:ECONNABORTED /);

  logs.length = 0;
  gemini = () => { throw new Error('socket hang up\n  at somewhere'); };
  await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
  assert.match(fallbackLine()[1], /reason=error:socket hang up at somewhere /);
  assert.ok(logs.every(([, line]) => !line.includes(GEMINI_KEY) && !line.includes(SCRIBE_KEY)));
  assert.equal(lyrics.geminiFailureReason('plain text'), 'error:plain text');
});

test('log: recordings Gemini is never asked about are logged as skips, not failures', async () => {
  const big = Buffer.alloc(14 * 1024 * 1024 + 1);
  big.write('ID3');
  await lyrics.transcribeMusicLyrics(big, 'audio/mpeg', 300);
  assert.equal(calls.filter((call) => call.url.includes('generativelanguage')).length, 0);
  assert.deepEqual(fallbackLine().slice(0, 1), ['info']);
  assert.match(fallbackLine()[1], /reason=skip:over-14MiB /);

  logs.length = 0;
  await lyrics.transcribeMusicLyrics(Buffer.from('not audio at all'), 'text/plain', 30);
  assert.match(fallbackLine()[1], /reason=skip:not-audio /);
  assert.equal(fallbackLine()[0], 'info');

  logs.length = 0;
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const savedEmbed = process.env.KADE_EMBED_GEMINI_KEY;
  delete process.env.KADE_EMBED_GEMINI_KEY;
  try {
    await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
    assert.match(fallbackLine()[1], /reason=skip:no-key /);
  } finally {
    process.env.GEMINI_API_KEY = saved;
    if (savedEmbed !== undefined) process.env.KADE_EMBED_GEMINI_KEY = savedEmbed;
  }
});
