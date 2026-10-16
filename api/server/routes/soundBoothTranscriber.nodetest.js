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
process.env.KADE_MUSIC_LISTENER_MODEL = 'gemini-3.8-flash';
const SCRIBE_KEY = 'scribe-key-for-tests';
process.env.GEMINI_API_KEY = GEMINI_KEY;
process.env.ELEVENLABS_API_KEY = SCRIBE_KEY;
const calls = [];
/** How Gemini answers: (config, body) => data, or throws. */
let gemini = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Words' }] } }] });
/** How the MiMo listener (through OpenRouter) answers: (config, body) => data. */
let mimo = () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Words' } }] });
axios.defaults.adapter = async (config) => {
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  calls.push({ url: config.url, body, config });
  let data;
  if (config.url.includes('generativelanguage.googleapis.com')) data = gemini(config, body);
  else if (config.url === 'https://openrouter.ai/api/v1/chat/completions') data = mimo(config, body);
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
  assert.deepEqual(asked.body.generationConfig, {
    maxOutputTokens: 8192,
    thinkingConfig: { thinkingLevel: 'low' },
  });
  const prompt = asked.body.contents[0].parts[1].text;
  assert.match(prompt, /^Transcribe the complete sung lyrics from this audio/);
  assert.match(prompt, /fill gaps from memory/);
  assert.match(prompt, /clearly separate backing, harmony, response, or secondary vocal phrase in parentheses/);
  assert.match(prompt, /Do not add another copy of the lead words merely because the lead is doubled or harmonized/);
  assert.match(prompt, /When the voices cannot be distinguished, leave the words unparenthesized/);
  assert.match(prompt, /Do not infer or invent backing words/);
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

test('backing vocal cues become parentheses without adding words or reclassifying ambiguous lead lines', () => {
  const tidy = lyrics.tidySectionTags;
  assert.equal(
    tidy('[Chorus]\nI am coming home (come home)\nBacking vocals: stay with me\n[Backing Vocals]\nOoh, ooh\nLead line\n\n[Verse]\nKeep walking'),
    '[Chorus]\nI am coming home (come home)\n(stay with me)\n(Ooh, ooh)\nLead line\n\n[Verse]\nKeep walking',
  );
  assert.equal(tidy('[Backing Vocals]\n[Verse]\nThe only audible words'), '[Verse]\nThe only audible words');
  assert.equal(tidy('Backing vocals: [unclear]\n[Secondary vocals: ah-ah]\nHarmony vocals: (ooh)'), '([unclear])\n(ah-ah)\n(ooh)');
  assert.equal(tidy('[unclear]\nIt might be one singer'), '[unclear]\nIt might be one singer');
});

test('cover transcripts discard provider time ranges while keeping lyric words and vocal structure', () => {
  const raw = '0:14.30-0:42.00\r\n[Verse]\r\nThe lights stay on (stay on)\r\n\r\n[0:42.00 – 1:03.50] [Chorus]\r\n00:01:03,500 --> 00:01:08,000 Come home\r\nBacking vocals:\r\n(1:08.00-1:12.00)\r\nOoh, ooh';
  assert.equal(lyrics.tidySectionTags(raw), '[Verse]\nThe lights stay on (stay on)\n\n[Chorus]\nCome home\n(Ooh, ooh)');
  assert.equal(lyrics.stripLyricTimestamps('[0:14.30] Keep walking\n0:42.00-0:49.00: Stay with me'), 'Keep walking\nStay with me');
  const words = '[Verse]\nMeet me at 9:05\n9:05\nFourteen to forty-two\n(come home)\nI sang [unclear] here';
  assert.equal(lyrics.stripLyricTimestamps(words), words);
  assert.equal(lyrics.stripLyricTimestamps(lyrics.stripLyricTimestamps(raw)), lyrics.stripLyricTimestamps(raw));
});

test('tags: a draft that was nothing but labels is no draft, and the backup transcriber is used', async () => {
  gemini = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[Instrumental]\n\n[Interlude]' }] } }] });
  const got = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
  assert.equal(got.model, 'scribe_v2');
  assert.match(fallbackLine()[1], /reason=finish:STOP-empty /);
});

test('warning: Gemini backing roles and tags are guesses; the backup draft cannot reliably mark them', () => {
  const fromGemini = lyrics.lyricsWarning('gemini-3.8-flash');
  assert.match(fromGemini, /wrong or missing words/);
  assert.match(fromGemini, /Parentheses for separate backing vocals and the section tags are guesses from the music/);
  assert.match(fromGemini, /the section tags are guesses from the music/);
  assert.match(fromGemini, /correct the words, parentheses and tags in the Lyrics box before generating\.$/);
  const fromBackup = lyrics.lyricsWarning('scribe_v2');
  assert.match(fromBackup, /^Draft lyrics from the backup transcriber, so they have no section tags\. Add tags such as \[Verse\] and \[Chorus\] yourself\./);
  assert.match(fromBackup, /wrong or missing words/);
  assert.match(fromBackup, /cannot reliably mark separate backing vocals in parentheses/);
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

test('Part 295: an HTTP failure reaches the Google key alarm hook; a refused song or a skip does not', async () => {
  const heard = [];
  const hook = (error) => heard.push(error);
  gemini = (config) => {
    throw new axios.AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, null, {
      status: 429, statusText: 'Too Many Requests', headers: {}, config,
      data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.' } },
    });
  };
  assert.equal((await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30, hook)).model, 'scribe_v2', 'the fallback is unchanged');
  assert.equal(heard.length, 1);
  assert.equal(heard[0].response.status, 429);
  gemini = () => ({ candidates: [{ finishReason: 'RECITATION' }] });
  await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30, hook);
  const big = Buffer.alloc(14 * 1024 * 1024 + 1);
  big.write('ID3');
  await lyrics.transcribeMusicLyrics(big, 'audio/mpeg', 300, hook);
  assert.equal(heard.length, 1, 'a RECITATION refusal and an over-size skip are not the key');
  /* A hook that throws never changes the fallback. */
  gemini = (config) => { throw new axios.AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, null, { status: 403, statusText: 'Forbidden', headers: {}, config, data: {} }); };
  assert.equal((await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30, () => { throw new Error('alarm down'); })).model, 'scribe_v2');
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

/* ---------- Oct 16 2026: a cover draft with blank lines between everything, chorus first ----------
 * Kade's cover upload (199 s) came back from MiMo with a blank line after every line, labels too,
 * and with a chorus ahead of the intro and first verse. The stored draft had every newline run
 * exactly "\n\n"; these fixtures have that shape with made-up words. */
const doubleSpace = (text) => text.split('\n').filter(Boolean).join('\n\n');
const sungLines = (text) => text.split('\n').filter((line) => line.trim());
const coverDraft = [
  '[Intro]', 'Ooh, da-da', '', '[Verse]', 'Walking out the door again', 'Leaving every light on (light on)', 'Nothing left to say', '',
  '[Chorus]', 'Hold the line tonight', 'Let the rain come down', 'Hold the line tonight', '',
  '[Bridge]', 'Turn it all around', '', '[Chorus]', 'Hold the line tonight', 'Let the rain come down', 'Hold the line tonight',
].join('\n');

test('prompt: sections in the order they are sung, and no blank lines inside a section or after a label', async () => {
  let prompt;
  gemini = (config, body) => {
    prompt = body.contents[0].parts[1].text;
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[Verse]\nWords' }] } }] };
  };
  await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 30);
  assert.match(prompt, /^Transcribe the complete sung lyrics from this audio, from beginning to end, in the original language\. Write the sections in the order they are sung, starting with the first sound of the recording; never move a chorus or any other section ahead of where it is sung, and write a chorus only where it is sung\. Use only words audibly present/);
  assert.match(prompt, /Put each sung phrase on its own line, with a blank line between sections\. Do not put blank lines between the lines of a section or after a section label\./);
  assert.match(prompt, /Preserve repeated choruses, repetitions, contractions, and audible vocalizations\./, 'the earlier rules stay');
  assert.doesNotMatch(prompt, /Hold the line|Walking out/, 'no example lyric lines in the prompt');
});

test('spacing: a draft with a blank line after every line comes out one sung line per line, one blank between sections', () => {
  const { tidySectionTags, tidyLyricSpacing } = lyrics;
  const stored = doubleSpace(coverDraft);
  assert.match(stored, /\[Chorus\]\n\nHold the line tonight\n\nLet the rain come down/, 'fixture has the stored shape');
  assert.equal(tidySectionTags(stored), coverDraft);
  assert.equal(tidyLyricSpacing(stored), coverDraft, 'the same cleanup a cached draft gets');
  assert.deepEqual(sungLines(tidySectionTags(stored)), sungLines(stored), 'no word, label or order changes');
  /* The second Oct 16 draft: single-spaced sections, but a blank line right after every label. */
  assert.equal(
    tidySectionTags('[Intro]\n\nMm, ah\n\n[Verse]\n\nFirst line here\nSecond line here\n\n[Chorus]\n\nHook line (hook)\nHook again'),
    '[Intro]\nMm, ah\n\n[Verse]\nFirst line here\nSecond line here\n\n[Chorus]\nHook line (hook)\nHook again',
  );
  /* A timed reply, one entry per phrase with a blank line between entries: the timestamps go and
   * so do the blank lines they left behind. */
  for (const timed of [
    '[00:05.10] Ooh\n\n[00:12.34] Line one\n\n[00:15.00] Line two\n\n[00:18.20] Line three',
    '[00:05.10]\nOoh\n\n[00:12.34]\nLine one\n\n[00:15.00]\nLine two\n\n[00:18.20]\nLine three',
    '0:05 - 0:10\nOoh\n\n0:12 - 0:15\nLine one\n\n0:15 - 0:18\nLine two\n\n0:18 - 0:21\nLine three',
    '00:00:05,100 --> 00:00:10,000\nOoh\n\n00:00:12,340 --> 00:00:15,000\nLine one\n\n00:00:15,000 --> 00:00:18,000\nLine two\n\n00:00:18,200 --> 00:00:21,000\nLine three',
  ]) {
    assert.equal(tidySectionTags(timed), 'Ooh\nLine one\nLine two\nLine three', timed);
    assert.equal(tidyLyricSpacing(lyrics.stripLyricTimestamps(timed)), 'Ooh\nLine one\nLine two\nLine three', timed);
  }
  /* Runs of blank lines, whitespace-only lines and CR line ends collapse to one blank line. */
  assert.equal(tidySectionTags('[Verse]\nOne\nTwo\n \t\n\n\n[Chorus]\nThree\nFour'), '[Verse]\nOne\nTwo\n\n[Chorus]\nThree\nFour');
  assert.equal(tidySectionTags('[Verse]\r\r\nOne\r\r\nTwo\r\r\nThree\r\r\n[Chorus]\r\r\nFour\r\r\nFive'), '[Verse]\nOne\nTwo\nThree\n\n[Chorus]\nFour\nFive');
  /* A label glued to the line before it still starts its own section. */
  assert.equal(tidySectionTags('[Verse]\nOne\nTwo\n[Chorus]\nThree'), '[Verse]\nOne\nTwo\n\n[Chorus]\nThree');
  /* An ordinary draft is left alone, including an unlabelled stanza break inside a section, and a
   * double-spaced draft keeps a wider gap (two or more blank lines) as its section break. */
  const ordinary = '[Verse]\nOne\nTwo\n\nThree\nFour\n\n[Chorus]\nFive\nSix';
  assert.equal(tidySectionTags(ordinary), ordinary);
  assert.equal(tidySectionTags('A\nB\n\nC\nD\n\nE\nF'), 'A\nB\n\nC\nD\n\nE\nF');
  assert.equal(tidyLyricSpacing('One\n\nTwo\n\nThree\n\n\n\nFour\n\nFive'), 'One\nTwo\nThree\n\nFour\nFive');
  assert.equal(tidyLyricSpacing(''), '');
});

test('labels: an intro or verse label with extra words keeps its place, so [Chorus] is not left as the first label', () => {
  const tidy = lyrics.tidySectionTags;
  assert.equal(
    tidy('[Intro (spoken)]\nOoh\n\n[Verse 1: lead vocal]\nLine one\nLine two\n\n[Chorus]\nHook one'),
    '[Intro]\nOoh\n\n[Verse]\nLine one\nLine two\n\n[Chorus]\nHook one',
  );
  /* Both Oct 16 symptoms from one timed reply: descriptive labels after the times, blank lines
   * between timed phrases. The intro and the verse keep their labels and their places. */
  assert.equal(
    tidy('[00:00.00 - 00:09.50] [Intro - instrumental]\n\n[00:09.50 - 00:13.00] [Chorus]\nhook line A\n\n[00:13.00 - 00:16.40]\nhook line B\n\n[00:16.40 - 00:21.00] [Verse 1: lead vocal]\nverse line 1\n\n[00:21.00 - 00:25.00]\nverse line 2\n\n[00:25.00 - 00:29.00]\nverse line 3'),
    '[Intro]\n\n[Chorus]\nhook line A\nhook line B\n\n[Verse]\nverse line 1\nverse line 2\nverse line 3',
  );
  for (const [label, tag] of [
    ['[Instrumental Intro]', '[Intro]'], ['[Spoken Intro]', '[Intro]'], ['[Introduction]', '[Intro]'],
    ['[Verse 1 - 0:12 to 0:40]', '[Verse]'], ['[Verse 2 (0:40-1:05)]', '[Verse]'], ['[First Verse]', '[Verse]'], ['[Rap Verse]', '[Verse]'],
    ['[Hook]', '[Chorus]'], ['[Refrain]', '[Chorus]'], ['[Final Chorus]', '[Chorus]'], ['[Chorus (repeat)]', '[Chorus]'], ['[Chorusx2]', '[Chorus]'],
    ['[Pre Hook]', '[Pre-Chorus]'], ['[Prechorus]', '[Pre-Chorus]'], ['[Post Chorus]', '[Post-Chorus]'],
    ['[Bridge - half time]', '[Bridge]'], ['[Outro (fade)]', '[Outro]'],
  ]) assert.equal(tidy(`${label}\nWords`), `${tag}\nWords`, label);
  for (const label of ['[Interlude]', '[Instrumental]', '[Guitar Solo]', '[Spoken]', '[Hooked on a feeling]', '[Breakdown]'])
    assert.equal(tidy(`${label}\nWords`), 'Words', label);
});

test('MiMo: the Oct 16 cover draft shape is served single-spaced, in the order the listener wrote it', async () => {
  const savedModel = process.env.KADE_MUSIC_LISTENER_MODEL;
  process.env.KADE_MUSIC_LISTENER_MODEL = 'xiaomi/mimo-v2.6-flash';
  process.env.OPENROUTER_KEY = 'openrouter-key-for-tests';
  try {
    let asked;
    mimo = (config, body) => {
      asked = body;
      return { choices: [{ finish_reason: 'stop', message: { content: doubleSpace(coverDraft) } }], usage: { prompt_tokens: 1531, completion_tokens: 446 } };
    };
    const got = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 199);
    assert.equal(got.model, 'xiaomi/mimo-v2.6-flash');
    assert.equal(got.transcript, coverDraft);
    assert.ok(got.transcript.startsWith('[Intro]\nOoh, da-da\n\n[Verse]\n'), 'the intro and verse stay ahead of the chorus');
    assert.match(asked.messages[0].content[0].text, /Write the sections in the order they are sung/);
    assert.deepEqual(got.usage, { inputTokens: 1531, outputTokens: 446 });
    assert.equal(logs.length, 0, 'a draft that opens on its intro logs nothing');

    /* The stored Oct 16 draft opened on a chorus that every later chorus repeats word for word. A
     * song can really open on its chorus, so it is never moved or cut; it is counted in the log. */
    const chorusFirst = '[Chorus]\nHold the line tonight\nLet the rain come down\n\n[Verse]\nWalking out the door again\n\n[Chorus]\nHold the line tonight\nLet the rain come down';
    mimo = () => ({ choices: [{ finish_reason: 'stop', message: { content: doubleSpace(chorusFirst) } }], usage: { prompt_tokens: 1531, completion_tokens: 446 } });
    const opened = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 199);
    assert.equal(opened.transcript, chorusFirst);
    assert.deepEqual(logs, [['info', '[music/lyrics] draft opens on a repeated chorus model=xiaomi/mimo-v2.6-flash 199s']]);
    assert.equal(lyrics.opensOnRepeatedChorus(coverDraft), false);
    assert.equal(lyrics.opensOnRepeatedChorus('[Chorus]\nOnly once here\nAnd never again\n\n[Verse]\nSomething else'), false);
    assert.equal(lyrics.opensOnRepeatedChorus('Sung first\n\n[Chorus]\nA line\nB line\n\n[Chorus]\nA line\nB line'), false);
  } finally {
    process.env.KADE_MUSIC_LISTENER_MODEL = savedModel;
    delete process.env.OPENROUTER_KEY;
  }
});

test('MiMo: a reply whose prompt counted no audio is not shown as the singer\'s words', async () => {
  const savedModel = process.env.KADE_MUSIC_LISTENER_MODEL;
  process.env.KADE_MUSIC_LISTENER_MODEL = 'xiaomi/mimo-v2.6-flash';
  process.env.OPENROUTER_KEY = 'openrouter-key-for-tests';
  try {
    /* Oct 16 check: a host that dropped the recording counted 288 prompt tokens (the words alone)
     * and still answered "stop" with an invented song, chorus first, double-spaced. */
    mimo = () => ({ choices: [{ finish_reason: 'stop', message: { content: doubleSpace('[Chorus]\nMade up line\nAnother made up line\n\n[Verse]\nNot from the song') } }], usage: { prompt_tokens: 288, completion_tokens: 670 } });
    const got = await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 199);
    assert.equal(got.model, 'scribe_v2');
    assert.equal(got.transcript, 'Backup words.\nSecond line.');
    const [level, line] = logs.find(([, entry]) => entry.includes('lyrics listener fallback'));
    assert.equal(level, 'warn');
    assert.equal(line, `[music/lyrics] lyrics listener fallback reason=unheard:tokens=288 model=xiaomi/mimo-v2.6-flash audio/mpeg ${MP3.length}B 199s; using scribe_v2`);
    /* A heard recording passes at any length, and a reply without usage figures is not judged. */
    for (const [seconds, usage] of [[199, { prompt_tokens: 1531, completion_tokens: 446 }], [213.52, { prompt_tokens: 1622, completion_tokens: 670 }], [5, { prompt_tokens: 330, completion_tokens: 9 }], [199, undefined]]) {
      mimo = () => ({ choices: [{ finish_reason: 'stop', message: { content: '[Verse]\nHeard words' } }], usage });
      assert.equal((await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', seconds)).model, 'xiaomi/mimo-v2.6-flash', String(seconds));
    }
    /* Only the measured listener is judged: Pro's audio rate was never measured. */
    process.env.KADE_MUSIC_LISTENER_MODEL = 'xiaomi/mimo-v2.6-pro';
    mimo = () => ({ choices: [{ finish_reason: 'stop', message: { content: '[Verse]\nHeard words' } }], usage: { prompt_tokens: 288, completion_tokens: 9 } });
    assert.equal((await lyrics.transcribeMusicLyrics(MP3, 'audio/mpeg', 199)).model, 'xiaomi/mimo-v2.6-pro');
  } finally {
    process.env.KADE_MUSIC_LISTENER_MODEL = savedModel;
    delete process.env.OPENROUTER_KEY;
  }
});
