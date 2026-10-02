/* Oct 2 2026: a provider's failure in plain words (kadeSoundBoothErrors.js). The first fixture is
 * the exact answer fal gave three Seed renders that night, which the booth read out as
 * "[object Object]". No network: every error here is built by hand in the shapes axios hands back.
 *
 * Run: node --test api/server/routes/kadeSoundBoothErrors.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { providerError, errorText, redactUrls, sayLink, logInput } = require('./kadeSoundBoothErrors');

/** Runs `fn` with only the storage settings in `env` (the server reads them each time a link is said). */
function withStorage(env, fn) {
  const keys = ['AWS_ENDPOINT_URL', 'AWS_BUCKET_NAME', 'KADE_MEDIA_BUCKET', 'AWS_REGION'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const OUR_STORAGE = { AWS_ENDPOINT_URL: 'https://store.test', AWS_BUCKET_NAME: 'bucket' };

/** An axios-shaped failure: what `axios.post` throws when the server answers with an error status. */
function answered(status, data, message = `Request failed with status code ${status}`) {
  const e = new Error(message);
  e.response = { status, data };
  e.code = status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
  return e;
}
/** An axios-shaped failure with no answer at all. */
function unanswered(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const SIGNED = 'https://s3.us-east-005.backblazeb2.com/bucket/audios/u1/soundbooth-ref-abc.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';
const FAL_422 = {
  detail: [{
    loc: ['body', 'audio_urls', 0],
    msg: 'Audio duration exceeds the maximum allowed. Maximum is 30.0 seconds.',
    type: 'audio_duration_too_long',
    ctx: { max_duration: 30 },
    input: SIGNED,
  }],
};

test('fal 422 detail array: the clip and the limit, in words, and the whole answer for the log', () => {
  const said = providerError(answered(422, FAL_422), { name: 'Seed Audio' });
  assert.equal(said.message, 'Clip 1 is too long. Seed Audio takes clips up to 30 seconds.');
  assert.equal(said.status, 422);
  assert.match(said.detail, /status=422/);
  assert.match(said.detail, /audio_duration_too_long/);
  assert.match(said.detail, /max_duration/);
  assert.doesNotMatch(said.detail, /deadbeef|X-Amz/, 'a signed link never reaches the log with its signature');
  assert.match(said.detail, /soundbooth-ref-abc\.wav\?\[signed\]/);
});

test('fal 422 with two problems says both, once each, and names the clip by its place', () => {
  const said = providerError(answered(422, { detail: [
    { loc: ['body', 'audio_urls', 2], msg: 'Audio duration exceeds the maximum allowed. Maximum is 30.0 seconds.', type: 'audio_duration_too_long', ctx: { max_duration: 30 } },
    { loc: ['body', 'audio_urls', 2], msg: 'Audio duration exceeds the maximum allowed. Maximum is 30.0 seconds.', type: 'audio_duration_too_long', ctx: { max_duration: 30 } },
    { loc: ['body', 'prompt'], msg: 'String should have at most 2048 characters', type: 'string_too_long' },
    { loc: ['body', 'audio_urls', 1], msg: 'File is too large', type: 'file_too_large' },
  ] }), { name: 'Seed Audio' });
  assert.equal(said.message, 'Clip 3 is too long. Seed Audio takes clips up to 30 seconds. prompt: String should have at most 2048 characters Clip 2 is too big a file for Seed Audio.');
});

test('FastAPI string detail, Google {error:{message}}, the bridge {error}, {message}', () => {
  assert.equal(providerError(answered(400, { detail: 'Prompt is required.' }), { name: 'Seed Audio' }).message, 'Prompt is required.');
  assert.equal(providerError(answered(429, { error: { code: 429, message: 'Quota exceeded for this project.', status: 'RESOURCE_EXHAUSTED' } }), { name: 'Lyria' }).message, 'Quota exceeded for this project.');
  assert.equal(providerError(answered(400, { error: 'One render at a time. Wait for the last one to finish.' }), { name: 'The render service' }).message, 'One render at a time. Wait for the last one to finish.');
  assert.equal(providerError(answered(500, { message: 'Worker crashed.' }), { name: 'X' }).message, 'Worker crashed.');
  assert.equal(providerError(answered(403, { detail: 'User is locked. Reason: Exhausted balance.' }), { name: 'Seed Audio' }).message, 'User is locked. Reason: Exhausted balance.');
});

test('a JSON body that arrived as text or as bytes is still read', () => {
  assert.equal(providerError(answered(422, JSON.stringify(FAL_422)), { name: 'Seed Audio' }).message, 'Clip 1 is too long. Seed Audio takes clips up to 30 seconds.');
  assert.equal(providerError(answered(422, Buffer.from(JSON.stringify(FAL_422))), { name: 'Seed Audio' }).message, 'Clip 1 is too long. Seed Audio takes clips up to 30 seconds.');
});

test('timeouts and unreachable hosts say so, without axios wording', () => {
  assert.equal(providerError(unanswered('ECONNABORTED', 'timeout of 180000ms exceeded'), { name: 'Seed Audio' }).message, 'Seed Audio did not answer in time.');
  assert.equal(providerError(unanswered('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443'), { name: 'Seed Audio' }).message, 'Seed Audio did not answer in time.');
  assert.equal(providerError(unanswered('ENOTFOUND', 'getaddrinfo ENOTFOUND fal.run'), { name: 'Seed Audio' }).message, 'Seed Audio could not be reached.');
  assert.equal(providerError(unanswered('ECONNRESET', 'socket hang up'), { name: 'Lyria' }).message, 'Lyria could not be reached.');
  const said = providerError(unanswered('ECONNABORTED', 'timeout of 180000ms exceeded'), { name: 'Seed Audio' });
  assert.match(said.detail, /code=ECONNABORTED/);
  assert.match(said.detail, /timeout of 180000ms exceeded/);
});

test('a status with nothing useful in the body says what the status means; an HTML page is not read out', () => {
  assert.equal(providerError(answered(502, '<html><body><h1>502 Bad Gateway</h1></body></html>'), { name: 'Seed Audio' }).message, 'Seed Audio had a problem on its side. Try again in a minute.');
  assert.equal(providerError(answered(429, ''), { name: 'Seed Audio' }).message, 'Seed Audio is busy right now. Try again in a minute.');
  assert.equal(providerError(answered(401, null), { name: 'Seed Audio' }).message, "Seed Audio refused the server's key.");
  assert.equal(providerError(answered(422, {}), { name: 'Seed Audio' }).message, 'Seed Audio could not use that request.');
  assert.equal(providerError(answered(422, { detail: [{}] }), { name: 'Seed Audio' }).message, 'Seed Audio could not use that request.');
});

test('ffmpeg failing says the audio tool, never its command line', () => {
  const e = new Error('Command failed: ffmpeg -nostdin -hide_banner -f concat -safe 0 -i /tmp/booth-stitch-x/parts.txt /tmp/booth-stitch-x/joined.mp3');
  e.cmd = 'ffmpeg -nostdin ...';
  e.stderr = 'parts.txt: Invalid data found when processing input';
  const said = providerError(e, { name: 'The audio tool' });
  assert.equal(said.message, 'The audio tool could not read that file.');
  assert.match(said.detail, /Invalid data found/);
});

test('never "[object Object]", whatever arrives', () => {
  const shapes = [
    answered(422, { detail: [{}] }),
    answered(422, { detail: { nested: { deeper: true } } }),
    answered(400, { error: { code: 7 } }),
    answered(400, [{ msg: 'a' }, { msg: 'b' }]),
    { response: { status: 500, data: { error: { message: { text: 'odd' } } } } },
    { error: { reason: 'bridge object' } },
    null,
    undefined,
    42,
    'plain words',
    new Error(''),
  ];
  for (const shape of shapes) {
    const said = providerError(shape, { name: 'Seed Audio' });
    assert.equal(typeof said.message, 'string');
    assert.ok(said.message.length > 0, `empty for ${JSON.stringify(shape)}`);
    assert.doesNotMatch(said.message, /\[object Object\]/);
    assert.doesNotMatch(said.detail, /\[object Object\]/);
  }
  assert.equal(providerError(null, { name: 'Seed Audio' }).message, 'Seed Audio did not say why.');
  assert.equal(providerError('plain words').message, 'plain words');
});

test('long answers are cut at a word, short enough to hear', () => {
  const long = 'word '.repeat(200);
  const said = providerError(answered(400, { detail: long }), { name: 'Seed Audio', max: 120 });
  assert.ok(said.message.length <= 120, said.message.length);
  assert.match(said.message, /word…$/);
});

test('errorText reads a bridge job error of any shape', () => {
  assert.equal(errorText('GPU out of memory'), 'GPU out of memory');
  assert.equal(errorText({ message: 'GPU out of memory' }), 'GPU out of memory');
  assert.equal(errorText({ error: { message: 'No worker free' } }), 'No worker free');
  assert.equal(errorText(null, { fallback: 'render failed' }), 'render failed');
  assert.equal(errorText(undefined), '');
  assert.equal(errorText({ odd: 1 }), '', 'an unfamiliar shape is not read out as JSON');
  assert.equal(errorText({ odd: 1 }, { fallback: 'The render service did not say why.' }), 'The render service did not say why.');
  assert.equal(errorText('[object Object]', { fallback: 'render failed' }), 'render failed', 'a job saved as "[object Object]" is not read out either');
  assert.equal(errorText('{"error":{"message":"No worker free"}}'), 'No worker free', 'a JSON string is read as what it holds');
  assert.equal(errorText('[Errno 2] No such file'), '[Errno 2] No such file', 'words that start with a bracket stay words');
});

test('no raw JSON is ever read aloud; it goes to the log instead', () => {
  const shapes = [
    answered(500, { state: 'FAILED' }),
    answered(400, { foo: 'bar', n: 1 }),
    answered(422, { detail: { nested: { deeper: true } } }),
    answered(400, { detail: '{"inner":"json"}' }),
    { response: { data: { state: 'FAILED' } } },
    { state: 'FAILED' },
  ];
  for (const shape of shapes) {
    const said = providerError(shape, { name: 'Seed Audio' });
    assert.doesNotMatch(said.message, /[{}"]/, `${JSON.stringify(shape)} said as ${said.message}`);
  }
  assert.equal(providerError(answered(500, { state: 'FAILED' }), { name: 'Seed Audio' }).message, 'Seed Audio had a problem on its side. Try again in a minute.');
  assert.equal(providerError({ response: { data: { state: 'FAILED' } } }, { name: 'Seed Audio' }).message, 'Seed Audio did not say why.');
  assert.match(providerError(answered(500, { state: 'FAILED' }), { name: 'Seed Audio' }).detail, /"state":"FAILED"/);
});

test('a link is said as its file name, never its address, signature or account folder', () => {
  const said = providerError(answered(422, { detail: [{ loc: ['body', 'audio_urls', 1], msg: `Failed to download file from ${SIGNED}`, type: 'file_download_error' }] }), { name: 'Seed Audio' });
  assert.equal(said.message, 'Clip 2: Failed to download file from soundbooth-ref-abc.wav');
  assert.match(said.detail, /audios\/u1\/soundbooth-ref-abc\.wav\?\[signed\]/, 'the log keeps the redacted address');
  assert.doesNotMatch(said.detail, /deadbeef/);
  const account = '6a0000000000000000000abc';
  assert.equal(errorText(`Could not fetch https://store.test/bucket/audios/${account}/soundbooth-ref-x.mp3.`), 'Could not fetch soundbooth-ref-x.mp3.');
  assert.equal(withStorage(OUR_STORAGE, () => errorText('Could not fetch https://store.test/bucket/clips/abc?sig=1, try again')), 'Could not fetch the clip, try again', 'in our storage, no file name: "the clip"');
  assert.equal(errorText(`NoSuchKey: audios/${account}/soundbooth-ref-x.wav`), 'NoSuchKey: soundbooth-ref-x.wav', 'a storage path loses its account folder');
  assert.equal(errorText(`No balance left for user ${account}.`), 'No balance left for user.');
  for (const text of [said.message, errorText(`see https://store.test/bucket/audios/${account}/a.wav?X-Amz-Signature=1`)]) {
    assert.doesNotMatch(text, /https?:|X-Amz|\[signed\]|6a0{3}/);
  }
});

test('"the clip" only for an audio file, our storage or fal.media; any other link is its host, or "a link"', () => {
  withStorage(OUR_STORAGE, () => {
    /* A link that is not a clip: a help page, a model's address, a page with a file name. */
    assert.equal(errorText('Quota exceeded. See https://ai.google.dev/gemini-api/docs/rate-limits.'), 'Quota exceeded. See ai.google.dev.');
    assert.equal(errorText('Model https://fal.run/bytedance/seed-audio-1.0 is warming up'), 'Model fal.run is warming up');
    assert.equal(errorText('Read https://www.example.com/help/limits.html first'), 'Read example.com first', 'a page is not a clip, and its file name is not said');
    assert.equal(errorText('Could not reach http://10.0.0.5:8000/run'), 'Could not reach a link', 'an address in numbers is not read out');
    assert.equal(sayLink('http://localhost:3080/api/x'), 'a link');
    assert.equal(sayLink('http://[::1]:8000/run'), 'a link');
    assert.equal(sayLink('https://store.test/otherbucket/clips/abc'), 'store.test', 'the same host, but not our bucket');
    /* A clip: an audio file anywhere, or anything in our storage or on fal.media. */
    assert.equal(sayLink('https://elsewhere.test/a/b/voice.wav?sig=1'), 'voice.wav');
    assert.equal(sayLink(`https://elsewhere.test/a/${'x'.repeat(90)}.mp3`), 'the clip', 'an audio file whose name is too long to say');
    assert.equal(sayLink('https://store.test/bucket/clips/abc?sig=1'), 'the clip');
    assert.equal(sayLink('https://bucket.store.test/clips/abc'), 'the clip', 'our bucket in front of the host');
    assert.equal(sayLink('https://v3b.fal.media/files/b/abc123'), 'the clip');
    assert.equal(sayLink('https://fal.media/files/b/abc123'), 'the clip');
    assert.equal(sayLink('https://notfal.media/files/b/abc123'), 'notfal.media');
  });
  /* With no endpoint set, our storage is Amazon's own host. */
  withStorage({ AWS_BUCKET_NAME: 'bucket', AWS_REGION: 'us-east-1' }, () => {
    assert.equal(sayLink('https://bucket.s3.us-east-1.amazonaws.com/clips/abc'), 'the clip');
    assert.equal(sayLink('https://s3.amazonaws.com/bucket/clips/abc'), 'the clip');
    assert.equal(sayLink('https://store.test/bucket/clips/abc'), 'store.test');
  });
  /* The whole path, from fal's answer to the words. */
  const said = withStorage(OUR_STORAGE, () => providerError(answered(429, { error: { message: 'Resource exhausted. Please see https://ai.google.dev/gemini-api/docs/rate-limits for details.' } }), { name: 'Lyria' }));
  assert.equal(said.message, 'Resource exhausted. Please see ai.google.dev for details.');
  assert.doesNotMatch(said.message, /the clip/);
});

test('an engine error keeps its XML tag names; only an HTML page loses its markup', () => {
  assert.equal(errorText('Unknown tag <emotion> in line 3'), 'Unknown tag emotion in line 3');
  assert.equal(errorText('prompt must be Scenema <speak ...> XML'), 'prompt must be Scenema speak XML');
  assert.equal(errorText('Close the </voice> tag before <break time="1s"/>.'), 'Close the voice tag before break.');
  assert.equal(errorText('Error: <html><body><h1>Bad Gateway</h1></body></html>'), 'Error: Bad Gateway');
  assert.equal(errorText('Keep 2 < 3 as it is'), 'Keep 2 < 3 as it is');
});

test('a rejected value echoed back is logged only as its type and length, unless it is a link', () => {
  const script = 'Narrator (warm): ' + 'A long line of her own writing that must never sit whole in a log. '.repeat(30);
  const said = providerError(answered(422, { detail: [{ loc: ['body', 'prompt'], msg: 'String should have at most 2048 characters', type: 'string_too_long', input: script, ctx: { max_length: 2048 } }] }), { name: 'Seed Audio' });
  const logged = JSON.parse(said.detail.replace(/^status=422 code=\S+ body=/, ''));
  assert.deepEqual(logged.detail[0].input, { type: 'string', length: script.length });
  assert.equal(logged.detail[0].ctx.max_length, 2048, 'everything else is kept');
  assert.ok(!said.detail.includes('Narrator'), 'not one word of her script reaches the log');
  /* A link is kept whole, without its signature. */
  const link = 'https://s3.us-east-005.backblazeb2.com/bucket/audios/6a0000000000000000000abc/soundbooth-ref-mq3x9k2-a1b2c3.wav?X-Amz-Signature=deadbeef';
  const clip = providerError(answered(422, { detail: [{ loc: ['body', 'audio_urls', 0], msg: 'too long', type: 'audio_duration_too_long', input: link }] }), { name: 'Seed Audio' });
  const input = JSON.parse(clip.detail.replace(/^status=422 code=\S+ body=/, '')).detail[0].input;
  assert.equal(input, 'https://s3.us-east-005.backblazeb2.com/bucket/audios/6a0000000000000000000abc/soundbooth-ref-mq3x9k2-a1b2c3.wav?[signed]');
  assert.doesNotMatch(clip.detail, /deadbeef/);
  /* A bare list (no `detail`) is logged the same way, however short its input. */
  const bare = providerError(answered(400, [{ msg: 'bad', input: script }, { msg: 'ok', input: 'short' }]), { name: 'X' });
  const list = JSON.parse(bare.detail.replace(/^status=400 code=\S+ body=/, ''));
  assert.deepEqual(list[0].input, { type: 'string', length: script.length });
  assert.deepEqual(list[1].input, { type: 'string', length: 5 });
  /* Every other shape: its type and its length (items for a list, characters for the rest). */
  assert.deepEqual(logInput([link, link]), { type: 'array', length: 2 });
  assert.deepEqual(logInput({ text: 'her words' }), { type: 'object', length: 20 });
  assert.deepEqual(logInput(3.5), { type: 'number', length: 3 });
  assert.deepEqual(logInput(true), { type: 'boolean', length: 4 });
  assert.deepEqual(logInput(null), { type: 'null', length: 0 });
  assert.deepEqual(logInput('a line with https://example.com/x in it'), { type: 'string', length: 39 }, 'words with a link in them are still words');
  /* A very long link keeps its end, where the file name is. */
  const long = `https://store.test/${'a/'.repeat(200)}voice.wav?sig=1`;
  const kept = logInput(long);
  assert.ok(kept.length <= 300, kept.length);
  assert.match(kept, /^….*\/voice\.wav\?\[signed\]$/);
});

test('redactUrls keeps the address and drops the signature', () => {
  assert.equal(redactUrls(`see ${SIGNED} now`), 'see https://s3.us-east-005.backblazeb2.com/bucket/audios/u1/soundbooth-ref-abc.wav?[signed] now');
  assert.equal(redactUrls('https://fal.run/bytedance/seed-audio-1.0'), 'https://fal.run/bytedance/seed-audio-1.0');
});
