const { readFileSync } = require('node:fs');
const { strict: assert } = require('node:assert');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/kadeSoundBooth.js`, 'utf8');
const start = source.indexOf("router.post('/render'");
const body = source.slice(source.indexOf('  const b = req.body || {};', start), source.indexOf('  let script =', start));
const check = vm.runInNewContext(`(req, res) => { ${body}; return 'continue'; }`);
for (const engine of ['scenema', 'seed']) {
  for (const fields of [{}, { reference_voice_url: '', audio_urls: [] }, { reference_voice_url: ' ', audio_urls: [''] }]) {
    let status;
    const result = check({ body: { engine, referenceExpected: true, ...fields } }, {
      status(value) { status = value; return this; },
      json(value) { return value; },
    });
    assert.equal(status, 400);
    assert.match(result.error, /expected reference clip is missing/);
  }
  const clip = engine === 'seed' ? { audio_urls: ['https://example.test/clip.wav'] } : { reference_voice_url: 'https://example.test/clip.wav' };
  assert.equal(check({ body: { engine, referenceExpected: true, ...clip } }, {}), 'continue');
  assert.equal(check({ body: { engine } }, {}), 'continue');
}
assert.equal(check({ body: { engine: 'lyria', referenceExpected: true } }, {}), 'continue');
console.log('Reference validation passed: missing expected references stop before generation; optional and music paths remain valid.');
