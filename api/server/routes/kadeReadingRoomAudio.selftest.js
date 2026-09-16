const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('reading speech forwards each delivery choice and defaults unsupported values safely', async () => {
  const source = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
  const start = source.indexOf("router.get('/book/:id/audio/:s/:c'");
  const end = source.indexOf('/* ── progress and bookmarks', start);
  let handler, sent;
  const context = {router: {get: (_p, _auth, fn) => { handler = fn; }}, requireJwtAuth: () => {},
    openBook: async () => ({_id:'fixture'}), chunkAt: async () => ({text:'She paid $4.99.'}),
    clampInt: Number, DEFAULT_VOICE: () => 'test', STEER: () => '', PROXY_BASE: () => 'https://voice.invalid',
    axios: {post: async (_url, body) => { sent = body; return {status:200,headers:{'content-length':'0'}}; }},
    logger:{error: e => {throw Error(e);}}, Date};
  vm.runInNewContext(source.slice(start,end), context);
  for (const delivery of ['STABLE','BALANCED','CREATIVE',undefined,'invalid']) {
    const req={params:{id:'fixture',s:0,c:0},query:{delivery},user:{id:'synthetic'}};
    const res={status(){return this;},end(){},json(e){throw Error(JSON.stringify(e));}};
    await handler(req,res);
    assert.equal(sent.delivery, ['STABLE','BALANCED','CREATIVE'].includes(delivery) ? delivery : 'STABLE');
    assert.equal(sent.input, 'She paid $4.99.');
  }
});

test('generated library browser script parses after template expansion', () => {
  const context={require:()=>({SHARED_HEAD:''}),module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomPage'),'utf8'),context);
  const html=context.module.exports.readingRoomHtml;
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.match(html,/id="deliverySel"/);
});
