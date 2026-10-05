const test = require('node:test');
const assert = require('node:assert/strict');
const { planAukEdit, isAukStorageReference } = (() => { const mod = { exports: {} }; const code = require('typescript').transpileModule(require('node:fs').readFileSync(require('node:path').join(__dirname, 'edit.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS } }).outputText; require('node:vm').runInNewContext(code, { exports: mod.exports, module: mod, URL, process }); return mod.exports; })();

test('edit references stay inside configured storage buckets, with signed URLs preserved', () => {
  const env = { AWS_ENDPOINT_URL: 'https://s3.us-west-004.backblazeb2.com', AWS_BUCKET_NAME: 'recordings', KADE_MEDIA_BUCKET: 'masters' };
  for (const url of [
    'https://s3.us-west-004.backblazeb2.com/recordings/voice.wav?X-Amz-Signature=signed',
    'https://recordings.s3.us-west-004.backblazeb2.com/audio/take.wav',
    'https://s3.us-west-004.backblazeb2.com/masters/audio/take.wav',
  ]) assert.equal(isAukStorageReference(url, env), true, url);
  for (const url of [
    'http://s3.us-west-004.backblazeb2.com/recordings/voice.wav',
    'https://user@s3.us-west-004.backblazeb2.com/recordings/voice.wav',
    'https://s3.us-west-004.backblazeb2.com:444/recordings/voice.wav',
    'https://s3.us-west-004.backblazeb2.com/other/voice.wav',
    'https://s3.us-west-004.backblazeb2.com/recordings/',
    'https://s3.us-west-004.backblazeb2.com/recordings/../other/voice.wav',
    'https://s3.us-west-004.backblazeb2.com/recordings%2Fvoice.wav',
    'https://s3.us-west-004.backblazeb2.com/recordings/voice.wav#fragment',
    'https://recordings.s3.us-west-004.backblazeb2.com.evil.test/voice.wav',
    'https://s3.us-west-004.backblazeb2.com.evil.test/recordings/voice.wav',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/recordings/voice.wav',
    '/recordings/voice.wav',
  ]) assert.equal(isAukStorageReference(url, env), false, url);
  assert.equal(isAukStorageReference('https://recordings.s3.amazonaws.com/voice.wav', {}), false);
});

test('AWS and explicit endpoint prefixes match exactly', () => {
  const env = { AWS_BUCKET_NAME: 'recordings', AWS_REGION: 'us-east-2' };
  for (const host of ['s3.amazonaws.com', 's3.us-east-2.amazonaws.com', 's3-us-east-2.amazonaws.com']) {
    assert.equal(isAukStorageReference('https://' + host + '/recordings/voice.wav', env), true);
    assert.equal(isAukStorageReference('https://recordings.' + host + '/voice.wav', env), true);
  }
  assert.equal(isAukStorageReference('https://recordings.s3.us-west-2.amazonaws.com/voice.wav', env), false);
  assert.equal(isAukStorageReference('https://recordings.s3.cn-north-1.amazonaws.com.cn/voice.wav', { ...env, AWS_REGION: 'cn-north-1' }), true);
  const custom = { ...env, AWS_ENDPOINT_URL: 'https://storage.test:8443/objects/' };
  assert.equal(isAukStorageReference('https://storage.test:8443/objects/recordings/voice.wav', custom), true);
  assert.equal(isAukStorageReference('https://recordings.storage.test:8443/objects/voice.wav', custom), true);
  assert.equal(isAukStorageReference('https://storage.test:8443/objects-other/recordings/voice.wav', custom), false);
  assert.equal(isAukStorageReference('https://storage.test/objects/recordings/voice.wav', custom), false);
});

test('long edits preserve the entire input once and bound each paid job', () => {
  for (const seconds of [0.2, 14, 42, 84, 251.73, 1800]) {
    const parts = planAukEdit(seconds, {});
    assert.equal(parts[0].editStart, 0);
    assert.equal(parts.at(-1).editEnd, seconds);
    assert.equal(parts.filter(p => p.preserveBefore).length, 1);
    assert.equal(parts.filter(p => p.preserveAfter).length, 1);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      assert.ok(p.editEnd - p.editStart + p.targetSeconds <= 84.00001);
      if (i) assert.equal(p.editStart, parts[i - 1].editEnd);
    }
    assert.ok(Math.abs(parts.reduce((n, p) => n + p.targetSeconds, 0) - seconds) < 0.00001);
  }
});

test('range duration applies only to the selection, and unchanged edges occur only once', () => {
  const parts = planAukEdit(600, { edit_start: 15, edit_end: 135, gen_seconds: 180 });
  assert.equal(parts.length, 4);
  assert.equal(parts[0].editStart, 15);
  assert.equal(parts.at(-1).editEnd, 135);
  assert.equal(parts.reduce((n, p) => n + p.targetSeconds, 0), 180);
  assert.equal(parts[0].preserveAfter, false);
  assert.equal(parts.at(-1).preserveBefore, false);
});

test('invalid or unbounded edits fail before a render', () => {
  assert.throws(() => planAukEdit(10, { edit_start: 10.01, edit_end: 10.02 }));
  for (const options of [{ edit_start: -1 }, { edit_end: 601 }, { edit_start: 7, edit_end: 7 },
    { gen_seconds: NaN }, { gen_seconds: Infinity }, { gen_seconds: 0 }, { gen_seconds: 20000 }]) {
    assert.throws(() => planAukEdit(600, options));
  }
});
