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

(async () => {
  const ts = require('typescript'), Module = require('node:module'), path = require('node:path');
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = module.paths;
  compiled._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  let handler, duration = 433.1, stores = 0, registeredSeconds;
  const audio = Buffer.from('original audio');
  const context = {
    router: { post(_route, ...handlers) { handler = handlers.at(-1); } },
    requireJwtAuth() {}, refUpload: { single() {} },
    REF_EXT: { 'audio/mpeg': 'mp3' }, ENGINE_REF_FORMATS: { seed: { exts: ['mp3'] }, scenema: { exts: ['mp3'] } },
    require: () => ({ durationOf: async () => duration }),
    musicReferenceError: compiled.exports.musicReferenceError,
    saveBufferToS3: async ({ buffer }) => { assert.equal(buffer, audio); stores++; return 'https://assets.test/reference.mp3'; },
    registerMusicReference: async (_user, _url, seconds) => { registeredSeconds = seconds; },
    logger: { warn() {}, info() {}, error() {} },
  };
  const uploadStart = source.indexOf("router.post('/reference',");
  const uploadEnd = source.indexOf("router.post('/suggest',", uploadStart);
  vm.runInNewContext(source.slice(uploadStart, uploadEnd), context);
  async function upload(engine) {
    let code = 200, body;
    await handler({ user: { id: 'fixture' }, body: { engine }, file: { buffer: audio, mimetype: 'audio/mpeg', originalname: 'reference.mp3' } }, {
      status(value) { code = value; return this; }, json(value) { body = value; return this; },
    });
    return { code, body };
  }
  const rejected = await upload('yue2');
  assert.equal(rejected.code, 400); assert.match(rejected.body.error, /7 minutes 13 seconds.*6 minutes/); assert.equal(stores, 0);
  duration = null; assert.equal((await upload('yue2')).code, 400); assert.equal(stores, 0);
  duration = 360; assert.equal((await upload('yue2')).code, 200); assert.equal(stores, 1); assert.equal(registeredSeconds, 360);
  duration = 433.1; assert.equal((await upload('scenema')).code, 200); assert.equal(stores, 2);
  console.log('Cover imports reject overlong/unreadable audio before storage, accept six minutes, preserve original bytes and leave speech imports unchanged.');
})().catch(error => { console.error(error); process.exitCode = 1; });
