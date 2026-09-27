"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const mongoose_1 = __importDefault(require("mongoose"));
const mongodb_memory_server_1 = require("mongodb-memory-server");

const fs=require('fs'),path=require('path'),Module=require('module'),ts=require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const source=path.resolve(__dirname,'../../../packages/api/src/music/yue.ts');
const compiled=new Module(source,module);compiled.filename=source;compiled.paths=module.paths;
compiled._compile(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,source);
const yue_1=compiled.exports;

async function main() {
    const mongo = await mongodb_memory_server_1.MongoMemoryServer.create();
    await mongoose_1.default.connect(mongo.getUri());
    process.env.YUE_ENDPOINT_ID = 'fixture';
    process.env.RUNPOD_API_KEY = 'fixture';
    let submissions = 0, state = 'IN_QUEUE', failSubmit = false, completions = 0, extraOutput = {};
    const sentInputs = [];
    axios_1.default.defaults.adapter = async (config) => {
        const path = config.url || '';
        strict_1.default.ok(path.startsWith('https://api.runpod.ai/v2/fixture/'));
        if (path.endsWith('/run')) {
            submissions++;
            if (failSubmit)
                throw new Error('lost response');
            sentInputs.push((typeof config.data === 'string' ? JSON.parse(config.data) : config.data).input);
        }
        if (path.includes('/cancel/'))
            state = 'CANCELLED';
        return { data: path.endsWith('/run') ? { id: 'provider1' } : { status: state, executionTime: 60000, delayTime: 110000, output: state === 'COMPLETED' ? { url: 'https://assets.test/song.mp3', duration_s: 20, truncated: false, ...extraOutput } : undefined }, status: 200, statusText: 'OK', headers: {}, config };
    };
    const app = (0, express_1.default)();
    app.use((0, yue_1.createYueRouter)({ auth: (_req, _res, next) => next(), user: req => String(req.headers['x-test-user'] || 'a'), validateReference: async (_user, url) => url,
        project: async () => new mongoose_1.default.Types.ObjectId().toString(), update: async () => { }, complete: async () => { completions++; } }));
    await mongoose_1.default.model('KadeYueJob').init();
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    strict_1.default.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    async function post(path, body, user = 'a') { return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) }); }
    try {
        strict_1.default.throws(() => (0, yue_1.yueInput)({ script: 'Jazz' }), /Lyrics|words to sing/);
        strict_1.default.throws(() => (0, yue_1.yueInput)({ script: 'Jazz', lyrics: 'Words', referenceExpected: true }), /finish importing/);
        strict_1.default.throws(() => (0, yue_1.yueInput)({ script: 'Jazz', lyrics: 'Words', abc: 'X:1', reference_voice_url: 'https://assets.test/source.wav' }), /Remove one/);
        strict_1.default.throws(() => (0, yue_1.yueInput)({ script: 'Jazz', lyrics: 'Words', reference_voice_url: 'http://assets.test/source.wav' }), /Import/);
        const cover = (0, yue_1.yueInput)({ script: 'Jazz', lyrics: 'Words', reference_voice_url: 'https://assets.test/source.wav' });
        strict_1.default.equal(cover.cot, 'melody');
        strict_1.default.equal(cover.reference_voice_url, 'https://assets.test/source.wav');
        let res = await post('/render', { engine: 'yue2', script: 'Jazz', lyrics: '[Verse]\nOriginal words', estimateOnly: true });
        strict_1.default.equal(res.status, 200);
        strict_1.default.equal(submissions, 0);
        res = await post('/render', { engine: 'yue2', script: 'Jazz', lyrics: '[Verse]\nOriginal words' });
        const job = await res.json();
        strict_1.default.equal(job.queued, true);
        strict_1.default.equal(submissions, 1);
        res = await post('/render', { engine: 'yue2', script: 'Jazz', lyrics: 'words' });
        strict_1.default.equal(res.status, 409);
        strict_1.default.equal(submissions, 1);
        res = await fetch(base + '/status/' + job.jobId, { headers: { 'x-test-user': 'b' } });
        strict_1.default.equal(res.status, 404);
        state = 'IN_PROGRESS';
        res = await fetch(base + '/status/' + job.jobId);
        strict_1.default.equal((await res.json()).state, 'running');
        state = 'COMPLETED';
        res = await fetch(base + '/status/' + job.jobId);
        strict_1.default.equal((await res.json()).state, 'done');
        strict_1.default.equal(completions, 1);
        const timedJob = await mongoose_1.default.connection.db.collection('kadeyuejobs').findOne({ id: job.jobId });
        const timed = timedJob.takes[0].output;
        strict_1.default.equal(timed.queue_ms, 110000, 'GPU wait is kept beside the take');
        strict_1.default.equal(timed.execution_ms, 60000);
        strict_1.default.equal(timedJob.takes[0].costUSD, (60000 / 3600000) * 1.22, 'a worker that names no card keeps the old $1.22 an hour');
        await fetch(base + '/status/' + job.jobId);
        strict_1.default.equal(completions, 1);
        failSubmit = true;
        res = await post('/render', { engine: 'yue2', script: 'Jazz', lyrics: 'words' }, 'b');
        strict_1.default.equal(res.status, 502);
        res = await post('/render', { engine: 'yue2', script: 'Jazz', lyrics: 'words' }, 'b');
        strict_1.default.equal(res.status, 409);
        strict_1.default.equal(submissions, 2);
        failSubmit = false;
        state = 'IN_QUEUE';
        res = await post('/render', { engine: 'yue2', script: 'Jazz', lyrics: 'words' }, 'c');
        const cancel = await res.json();
        res = await post('/cancel/' + cancel.jobId, {}, 'c');
        strict_1.default.equal(res.status, 200);
        res = await fetch(base + '/status/' + cancel.jobId, { headers: { 'x-test-user': 'c' } });
        strict_1.default.equal((await res.json()).state, 'cancelled');
        await covers(post, base, sentInputs, (next) => { state = next.state; extraOutput = next.output || {}; });
        console.log('YuE2 integration: validation, no-charge quote, durable queue, duplicate rejection, owner isolation, completion idempotency, uncertain submission, cancellation passed.');
        console.log('YuE2 covers (Part 295): flag-off requests unchanged, cover and instrumental fields, trained-style refusal, saved choices, guide choices, score chords on Keep the original chords with old cot requests unchanged (Part 296), price per card, take notes said once passed.');
    }
    finally {
        server.close();
        await mongoose_1.default.disconnect();
        await mongo.stop();
    }
}
/* Part 295: the official cover recipe (chords kept) and instrumentals, behind YUE_COVERS_V2=1. */
async function covers(post, base, sentInputs, provider) {
    const assert = strict_1.default;
    const { yueInput, yueCoverOptions, yueProjectWhy, yueCoverSettings, yueTakeCost, yueTakeNote, yueTakeFacts, yueSinging, yueKeepChords, yueCost } = yue_1;
    const ON = { YUE_COVERS_V2: '1' };
    const LEGACY_KEYS = ['style', 'title', 'count', 'weirdness', 'steps', 'guidance', 'lyrics', 'abc', 'reference_voice_url', 'cot', 'band', 'lora_key', 'lora_scale', 'seed'];
    const recording = 'https://assets.test/source.wav';
    const INSTRUMENTAL = 'Instrumental, no singing', SUNG = 'Sung, with my lyrics';
    const KEEP = 'Yes: sound closer to the original song', NEW = 'No: a new accompaniment that fits my style';
    assert.equal(yueSinging.sung, SUNG); assert.equal(yueSinging.instrumental, INSTRUMENTAL);
    assert.equal(yueKeepChords.yes, KEEP); assert.equal(yueKeepChords.no, NEW);

    // Flag off: the new choices are ignored and every request is exactly today's.
    for (const shape of [
        { script: 'Jazz', lyrics: 'Words', seed: 5 },
        { script: 'Jazz', lyrics: 'Words', seed: 5, reference_voice_url: recording, singing: INSTRUMENTAL, keep_chords: KEEP },
        { script: 'Jazz', lyrics: 'Words', seed: 5, abc: 'X:1', cot: 'full', singing: INSTRUMENTAL },
    ]) {
        const off = yueInput(shape, {});
        assert.deepEqual(Object.keys(off), LEGACY_KEYS);
        assert.equal(off.cot, shape.reference_voice_url ? 'melody' : 'full');
        assert.deepEqual(yueCoverOptions(off), {});
    }
    assert.throws(() => yueInput({ script: 'Jazz', lyrics: '', singing: INSTRUMENTAL }, {}), { message: 'Add the words to sing in Lyrics, up to 8000 characters.' });

    // Flag on, a sung new song: nothing new is sent.
    const song = yueInput({ script: 'Jazz', lyrics: 'Words', seed: 5, singing: SUNG }, ON);
    assert.deepEqual(Object.keys(song), LEGACY_KEYS);
    assert.equal(song.cot, 'full');
    assert.throws(() => yueInput({ script: 'Jazz', lyrics: ' ' }, ON), /or choose Instrumental under Singing or instrumental/);

    // A sung cover: the server default keeps the chords (YUE_COVER_KEEP_CHORDS_DEFAULT unset = 1).
    const kept = yueInput({ script: 'Jazz trio', lyrics: 'Words', seed: 5, reference_voice_url: recording }, ON);
    assert.equal(kept.cot, 'full');
    assert.equal(kept.keep_harmony, true); assert.equal(kept.match_score_tempo, true); assert.equal(kept.length_guard, true);
    assert.equal('instrumental' in kept, false);
    const ownTempo = yueInput({ script: 'Jazz trio at 96 BPM', lyrics: 'Words', reference_voice_url: recording, keep_chords: KEEP }, ON);
    assert.equal('match_score_tempo' in ownTempo, false, 'her own BPM is never overwritten');
    assert.equal(ownTempo.keep_harmony, true); assert.equal(ownTempo.length_guard, true);
    const melody = yueInput({ script: 'Jazz trio', lyrics: 'Words', reference_voice_url: recording, keep_chords: NEW }, ON);
    assert.equal(melody.cot, 'melody'); assert.equal(melody.keep_harmony, false); assert.equal('match_score_tempo' in melody, false); assert.equal(melody.length_guard, true);
    assert.equal(yueInput({ script: 'Jazz trio', lyrics: 'Words', reference_voice_url: recording }, { ...ON, YUE_COVER_KEEP_CHORDS_DEFAULT: '0' }).keep_harmony, false);
    assert.equal(yueInput({ script: 'Jazz trio', lyrics: 'Words', reference_voice_url: recording, keep_chords: true }, { ...ON, YUE_COVER_KEEP_CHORDS_DEFAULT: '0' }).keep_harmony, true);
    assert.throws(() => yueInput({ script: 'Jazz trio', lyrics: 'Words', reference_voice_url: recording, keep_chords: 'maybe' }, ON), /Under Keep the original chords, choose Yes or No/);
    assert.throws(() => yueInput({ script: 'Jazz trio', lyrics: 'Words', singing: 'hummed' }, ON), /Under Singing or instrumental, choose Sung or Instrumental/);
    assert.deepEqual(yueCoverOptions(kept), { singing: SUNG, keep_chords: KEEP });
    assert.deepEqual(yueCoverOptions(song), {});

    // Instrumentals: from text with no words, and from a recording.
    const planned = yueInput({ script: 'Banjo breakdown', singing: INSTRUMENTAL }, ON);
    assert.equal(planned.instrumental, true); assert.equal(planned.length_guard, true); assert.equal(planned.lyrics, ''); assert.equal(planned.cot, 'full');
    assert.equal('keep_harmony' in planned, false); assert.equal('match_score_tempo' in planned, false);
    assert.equal(yueInput({ script: 'Banjo breakdown', lyrics: '[Intro]\n[Verse]', singing: 'instrumental' }, ON).lyrics, '[Intro]\n[Verse]');
    assert.equal(yueInput({ script: 'Banjo breakdown', lyrics: '', singing: true }, ON).instrumental, true);
    const played = yueInput({ script: 'Banjo breakdown', lyrics: '', singing: INSTRUMENTAL, reference_voice_url: recording }, ON);
    assert.equal(played.instrumental, true); assert.equal(played.keep_harmony, true); assert.equal(played.cot, 'full'); assert.equal(played.match_score_tempo, true);
    assert.deepEqual(yueCoverOptions(played), { singing: INSTRUMENTAL, keep_chords: KEEP });
    // Part 296: a score's chords are the same Keep the original chords choice (Yes = cot full,
    // No = cot melody), on the same default as a recording; a sung score still sends no new field.
    const scored = yueInput({ script: 'Piano trio', abc: 'X:1', singing: INSTRUMENTAL }, ON);
    assert.equal(scored.cot, 'full'); assert.equal(scored.keep_harmony, true); assert.equal(scored.match_score_tempo, true);
    const scoreMelody = yueInput({ script: 'Piano trio', abc: 'X:1', singing: INSTRUMENTAL, keep_chords: NEW }, ON);
    assert.equal(scoreMelody.cot, 'melody'); assert.equal(scoreMelody.keep_harmony, false); assert.equal('match_score_tempo' in scoreMelody, false);
    assert.equal(yueInput({ script: 'Piano trio', abc: 'X:1', singing: INSTRUMENTAL }, { ...ON, YUE_COVER_KEEP_CHORDS_DEFAULT: '0' }).cot, 'melody');
    const sungScore = yueInput({ script: 'Piano trio', lyrics: 'la', abc: 'X:1' }, ON);
    assert.equal(sungScore.cot, 'full'); assert.deepEqual(Object.keys(sungScore), LEGACY_KEYS);
    const sungMelody = yueInput({ script: 'Piano trio', lyrics: 'la', abc: 'X:1', keep_chords: NEW }, ON);
    assert.equal(sungMelody.cot, 'melody'); assert.deepEqual(Object.keys(sungMelody), LEGACY_KEYS);
    assert.throws(() => yueInput({ script: 'Piano trio', lyrics: 'la', abc: 'X:1', keep_chords: 'maybe' }, ON), /Under Keep the original chords, choose Yes or No/);
    // An older client that still sends cot with a score renders exactly as before, whatever else it sends.
    assert.equal(yueInput({ script: 'Piano trio', abc: 'X:1', cot: 'full', singing: INSTRUMENTAL }, ON).keep_harmony, true);
    const oldMelody = yueInput({ script: 'Piano trio', abc: 'X:1', cot: 'melody', singing: INSTRUMENTAL, keep_chords: KEEP }, ON);
    assert.equal(oldMelody.cot, 'melody'); assert.equal(oldMelody.keep_harmony, false); assert.equal('match_score_tempo' in oldMelody, false);
    assert.equal(yueInput({ script: 'Piano trio', lyrics: 'la', abc: 'X:1', cot: 'melody' }, ON).cot, 'melody');
    assert.deepEqual(Object.keys(yueInput({ script: 'Piano trio', lyrics: 'la', abc: 'X:1', cot: 'full' }, ON)), LEGACY_KEYS);
    // cot never changes a recording or a brand-new song, as before.
    assert.equal(yueInput({ script: 'Jazz trio', lyrics: 'Words', reference_voice_url: recording, cot: 'melody' }, ON).cot, 'full');
    assert.equal(yueInput({ script: 'Jazz', lyrics: 'Words', cot: 'melody', keep_chords: NEW }, ON).cot, 'full');
    // Flag off: keep_chords is ignored for a score, which follows cot with its old melody default.
    const offScore = yueInput({ script: 'Piano trio', lyrics: 'la', abc: 'X:1', keep_chords: KEEP }, {});
    assert.equal(offScore.cot, 'melody'); assert.deepEqual(Object.keys(offScore), LEGACY_KEYS);
    assert.deepEqual(yueCoverOptions(scored), { singing: INSTRUMENTAL });
    // A saved score opens with its chords answer under Keep the original chords, including an old one.
    const { yueSavedOptions } = yue_1;
    assert.deepEqual(yueSavedOptions({ abc: 'X:1', cot: 'melody', lyrics: 'la' }, ON), { abc: 'X:1', cot: 'melody', lyrics: 'la', keep_chords: NEW });
    assert.equal(yueSavedOptions({ abc: 'X:1', cot: 'full' }, ON).keep_chords, KEEP);
    for (const saved of [{ abc: 'X:1', cot: 'full', keep_chords: NEW }, { cot: 'full', lyrics: 'la' }, { abc: '', cot: 'full' }, { abc: 'X:1', cot: 'off' }, { abc: 'X:1', cot: 'full', reference_voice_url: recording }])
        assert.equal(yueSavedOptions(saved, ON), saved, JSON.stringify(saved));
    const flagOff = { abc: 'X:1', cot: 'full' };
    assert.equal(yueSavedOptions(flagOff, {}), flagOff, 'flag off: saved options open unchanged');

    // Trained styles are singing styles sent score-free: an instrumental is refused up front.
    const before = process.env.YUE_STYLES_ENABLED;
    process.env.YUE_STYLES_ENABLED = '1';
    try {
        assert.throws(() => yueInput({ script: 'Lullaby', lyrics: '', singing: INSTRUMENTAL, band: 'kids' }, ON), { message: 'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.' });
        const styled = yueInput({ script: 'Lullaby', lyrics: 'Words', band: 'soul', reference_voice_url: recording }, ON);
        // Part 295: Soul is the real-music composer LoRA (soundBoothStyle.selftest.cjs has the rest).
        assert.equal(styled.lora_key, 'yue2-loras/soul-real-step1000.pt'); assert.equal(styled.cot, 'full'); assert.equal(styled.keep_harmony, true);
        assert.equal(styled.style, 'kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul. Lullaby');
        assert.equal(yueInput({ script: 'Lullaby', lyrics: 'Words', band: 'kids' }, ON).cot, 'off');
    } finally {
        if (before === undefined) delete process.env.YUE_STYLES_ENABLED; else process.env.YUE_STYLES_ENABLED = before;
    }

    // The library's reason line.
    assert.equal(yueProjectWhy(undefined), 'YuE2 — a song made on the sleeping music GPU');
    assert.equal(yueProjectWhy({ lyrics: 'x' }), 'YuE2 — a song made on the sleeping music GPU');
    assert.equal(yueProjectWhy({ singing: INSTRUMENTAL }), 'YuE2 — an instrumental made on the sleeping music GPU');
    assert.equal(yueProjectWhy({ singing: SUNG, keep_chords: KEEP, reference_voice_url: recording }), 'YuE2 — a song made on the sleeping music GPU, a cover keeping the original chords');
    assert.equal(yueProjectWhy({ singing: INSTRUMENTAL, keep_chords: NEW, reference_voice_url: recording }), 'YuE2 — an instrumental made on the sleeping music GPU, a cover with a new accompaniment');

    // Guide choices: real labelled choice settings, only with the flag on.
    const settings = [
        { key: 'lyrics', label: 'Lyrics', hint: 'The words to sing.', kind: 'text' },
        { key: 'reference_voice_url', label: 'Recording to cover (optional)', hint: 'Import one song.', kind: 'clip', max: 1 },
        { key: 'abc', label: 'Optional composition (ABC)', hint: 'A score.', kind: 'text' },
        { key: 'cot', label: 'Following a score (only used with an ABC composition)', hint: 'A cover from a recording always uses Melody.', kind: 'choice', options: ['melody', 'full'], default: 'melody' },
        { key: 'count', label: 'Number of takes', hint: 'One to four.', kind: 'number' },
    ];
    assert.equal(yueCoverSettings(settings, {}), settings);
    const shown = yueCoverSettings(settings, ON);
    // Part 296: one chords choice for a recording and a score, so the score's own choice leaves.
    assert.deepEqual(shown.map((s) => s.key), ['singing', 'lyrics', 'reference_voice_url', 'keep_chords', 'abc', 'count']);
    const singing = shown[0], chords = shown[3];
    assert.equal(singing.label, 'Singing or instrumental'); assert.equal(singing.kind, 'choice');
    assert.deepEqual(singing.options, [SUNG, INSTRUMENTAL]); assert.equal(singing.default, SUNG);
    assert.equal(chords.label, 'Keep the original chords'); assert.equal(chords.kind, 'choice');
    assert.deepEqual(chords.options, [KEEP, NEW]); assert.equal(chords.default, KEEP);
    assert.equal(yueCoverSettings(settings, { ...ON, YUE_COVER_KEEP_CHORDS_DEFAULT: '0' })[3].default, NEW);
    assert.match(chords.hint, /^For a cover or an ABC score; it does nothing for a brand-new song\./);
    assert.match(chords.hint, /unless Music direction names a BPM/, 'the tempo it keeps is still said');
    assert.equal('advanced' in singing || 'advanced' in chords, false, 'both stay on top');
    assert.doesNotMatch(singing.hint, /Style/);
    assert.match(yueCoverSettings(settings, { ...ON, YUE_STYLES_ENABLED: '1' })[0].hint, /Choose None under Style for an instrumental\.$/);
    // Her rule: the booth's own words name no person and no private folder.
    for (const words of [yueCost, singing.hint, chords.hint, SUNG, INSTRUMENTAL, KEEP, NEW, singing.label, chords.label])
        assert.doesNotMatch(words, /Kade|your own folders|1\.22/);
    // Part 296: short enough to be read aloud in one breath each.
    for (const words of [yueCost, singing.hint, chords.hint]) assert.ok(words.split(/\s+/).length <= 45, words);
    assert.match(yueCost, /does not deduct from your credit balance/);

    // Price per card, from the worker's gpu name; an unknown card is priced as the A40.
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
    for (const [gpu, perSecond] of [
        ['NVIDIA A40', 0.000339], ['NVIDIA RTX A6000', 0.000339], ['NVIDIA GeForce RTX 4090', 0.000306],
        ['NVIDIA GeForce RTX 5090', 0.000439], ['NVIDIA RTX 6000 Ada Generation', 0.000486], ['NVIDIA L40', 0.000486],
        ['NVIDIA L40S', 0.000486], ['NVIDIA A100-SXM4-80GB', 0.000756], ['NVIDIA A100 80GB PCIe', 0.000756],
        ['NVIDIA RTX PRO 6000 Blackwell Server Edition', 0.000969], ['NVIDIA H100 80GB HBM3', 0.001331],
        ['NVIDIA H200', 0.001647], ['NVIDIA B200', 0.0024], ['A card from next year', 0.000339],
    ]) near(yueTakeCost(100000, gpu), 100 * perSecond);
    near(yueTakeCost(60000, undefined), (60000 / 3600000) * 1.22);
    near(yueTakeCost(60000, ''), (60000 / 3600000) * 1.22);
    near(yueTakeCost(undefined, 'NVIDIA A40'), 0);

    // Take notes read `features` first, so an older worker never gets one.
    const fit = { sections: [
        { score_section: 'verse', lyrics_section: 'Verse 1', sung_notes: 56, syllables: 44, fit: 'close' },
        { score_section: 'chorus', lyrics_section: 'Chorus', sung_notes: 34, syllables: 12, fit: 'short' },
        { score_section: null, lyrics_section: 'Outro', sung_notes: null, syllables: 9, fit: 'no tune' },
    ], same_order: false };
    const features = ['keep-harmony', 'instrumental', 'lyric-fit', 'chord-check'];
    assert.equal(yueTakeNote({ cover_mode: 'melody', lyric_fit: fit }, kept), '');
    assert.equal(yueTakeNote({ features, cover_mode: 'harmony', lyric_fit: fit }, kept), 'The chorus words look short for its tune: 12 syllables for 34 notes.');
    assert.equal(yueTakeNote({ features, cover_mode: 'melody', lyric_fit: null }, kept), 'No chords were heard in the recording, so the cover used its melody with a new accompaniment.');
    assert.equal(yueTakeNote({ features: features.slice(0, 3), cover_mode: 'melody' }, kept), '', 'a worker without the chord check is not trusted on cover_mode');
    assert.equal(yueTakeNote({ features, cover_mode: 'melody' }, melody), '', 'she asked for a new accompaniment');
    assert.equal(yueTakeNote({ features, instrumental: true, cover_mode: 'harmony', lyric_fit: fit }, played), '');
    const many = { sections: ['Verse 1', 'Chorus', 'Verse 2', 'Bridge'].map((name) => ({ lyrics_section: name, sung_notes: 20, syllables: 40, fit: 'long' })) };
    assert.equal(yueTakeNote({ features, lyric_fit: many }, song), 'The verse 1 words look long for its tune: 40 syllables for 20 notes. The chorus words look long for its tune: 40 syllables for 20 notes. Words in 2 more sections may not fit their tune either.');
    assert.deepEqual(yueTakeFacts({ url: 'x' }, kept), {});
    assert.deepEqual(yueTakeFacts({ features, gpu: 'NVIDIA A40', cover_mode: 'melody', instrumental: false }, kept),
        { instrumental: false, coverMode: 'melody', gpu: 'NVIDIA A40', takeNote: 'No chords were heard in the recording, so the cover used its melody with a new accompaniment.' });

    // Through the router: the fields reach RunPod, the card sets the price, the note is said once.
    const beforeFlag = process.env.YUE_COVERS_V2;
    process.env.YUE_COVERS_V2 = '1';
    try {
        provider({ state: 'IN_QUEUE' });
        const sentBefore = sentInputs.length;
        let res = await post('/render', { engine: 'yue2', script: 'Jazz trio', lyrics: '[Verse]\nWords', reference_voice_url: recording, count: 2 }, 'd');
        assert.equal(res.status, 200);
        const job = await res.json();
        assert.equal(sentInputs.length, sentBefore + 2);
        for (const input of sentInputs.slice(sentBefore)) {
            assert.equal(input.keep_harmony, true); assert.equal(input.match_score_tempo, true);
            assert.equal(input.length_guard, true); assert.equal(input.cot, 'full');
        }
        provider({ state: 'COMPLETED', output: { features, gpu: 'NVIDIA GeForce RTX 5090', cover_mode: 'melody', instrumental: false, lyric_fit: fit } });
        res = await fetch(base + '/status/' + job.jobId, { headers: { 'x-test-user': 'd' } });
        const done = await res.json();
        assert.equal(done.state, 'done');
        assert.equal(done.spoken, '2 of 2 takes ready. Open your library to compare them. No chords were heard in the recording, so the cover used its melody with a new accompaniment. The chorus words look short for its tune: 12 syllables for 34 notes.');
        const stored = await mongoose_1.default.connection.db.collection('kadeyuejobs').findOne({ id: job.jobId });
        for (const take of stored.takes) near(take.costUSD, 60 * 0.000439);
        near(stored.costUSD, 2 * 60 * 0.000439);
        res = await post('/render', { engine: 'yue2', script: 'Banjo breakdown', lyrics: '', singing: INSTRUMENTAL, estimateOnly: true }, 'd');
        assert.equal(res.status, 200, 'an instrumental needs no words');
        assert.doesNotMatch((await res.json()).estimate.spoken, /1\.22|Kade/);
    } finally {
        if (beforeFlag === undefined) delete process.env.YUE_COVERS_V2; else process.env.YUE_COVERS_V2 = beforeFlag;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
