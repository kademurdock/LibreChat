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
    let submissions = 0, state = 'IN_QUEUE', failSubmit = false, completions = 0;
    axios_1.default.defaults.adapter = async (config) => {
        const path = config.url || '';
        strict_1.default.ok(path.startsWith('https://api.runpod.ai/v2/fixture/'));
        if (path.endsWith('/run')) {
            submissions++;
            if (failSubmit)
                throw new Error('lost response');
        }
        if (path.includes('/cancel/'))
            state = 'CANCELLED';
        return { data: path.endsWith('/run') ? { id: 'provider1' } : { status: state, executionTime: 60000, output: state === 'COMPLETED' ? { url: 'https://assets.test/song.mp3', duration_s: 20, truncated: false } : undefined }, status: 200, statusText: 'OK', headers: {}, config };
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
        console.log('YuE2 integration: validation, no-charge quote, durable queue, duplicate rejection, owner isolation, completion idempotency, uncertain submission, cancellation passed.');
    }
    finally {
        server.close();
        await mongoose_1.default.disconnect();
        await mongo.stop();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
