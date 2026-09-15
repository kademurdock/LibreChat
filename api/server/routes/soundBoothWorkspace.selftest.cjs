const fs=require('fs'),vm=require('vm'),http=require('http'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=require('path').resolve(__dirname,'../../..');
const output=process.env.SOUND_BOOTH_TEST_OUTPUT;
if(output)fs.mkdirSync(output,{recursive:true});
const shared=require(root+'/api/server/routes/kadePages.js').SHARED_HEAD;
const context={module:{exports:{}},require:()=>({SHARED_HEAD:shared+'<script>async function getToken(){return "fixture"}</script>'})};
vm.runInNewContext(fs.readFileSync(root+'/api/server/routes/kadeSoundBoothPage.js','utf8'),context);
const html=context.module.exports.soundBoothHtml;
for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(m[1]);
const backend=fs.readFileSync(root+'/api/server/routes/kadeSoundBooth.js','utf8');
const a=backend.indexOf('const GUIDE = ')+14,b=backend.indexOf('\n};',a)+2;
const guide=vm.runInNewContext('('+backend.slice(a,b)+')',{SCREENPLAY_HELP:'Actor directions in brackets; spoken text outside brackets.'});
const sent=[],errors=[];
const server=http.createServer((req,res)=>{
 if(req.url==='/sound-booth'){res.setHeader('Content-Type','text/html');res.end(html);return;}
 if(req.url.startsWith('/assets/')){res.setHeader('Content-Type','application/javascript');res.end('');return;}
 res.setHeader('Content-Type','application/json');
 if(req.url.endsWith('/health')){res.end(JSON.stringify({guide,moods:[{key:'joyful',label:'Joyful'}]}));return;}
 if(req.url.endsWith('/projects')){res.end(JSON.stringify({projects:[{id:'failed-empty',title:'Failed empty attempt',engine:'scenema',state:'failed',takes:[]},{id:'recoverable',title:'Recoverable recording',engine:'scenema',state:'failed',hasRecoverableAudio:true,takes:[]}]}));return;}
 if(req.method==='GET'){res.end('{}');return;}
 let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=JSON.parse(raw||'{}');sent.push({url:req.url,body});
  if(req.url.endsWith('/render'))res.end(JSON.stringify(body.estimateOnly?{estimate:{spoken:'Fixture price: eight cents.'}}:{projectId:'music-fixture',spoken:'Fixture recording ready.'}));
  else res.end(JSON.stringify({}));
 });
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge',headless:true});
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/sound-booth');
  await page.locator('#app').waitFor({state:'visible'});
  await page.getByRole('heading',{name:'Recoverable recording',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Failed empty attempt',exact:true}).count(),0);
  await page.locator('#showFailed').check();
  await page.getByRole('heading',{name:'Failed empty attempt',exact:true}).waitFor();
  await page.locator('#showFailed').uncheck();
  await page.locator('#script').fill('Scenema spoken script');
  await page.locator('#text').fill('My exact spoken words');
  await page.locator('#set_voice_description').fill('Warm contralto');
  await page.locator('[data-engine="lyria"]').click();
  assert.equal(await page.locator('#writingPanel').isVisible(),false);
  assert.equal(await page.locator('#modePanel').isVisible(),false);
  assert.equal(await page.locator('#moodPanel').isVisible(),false);
  assert.equal(await page.locator('#btnPreview').isVisible(),false);
  assert.equal(await page.locator('#editorLabel').innerText(),'Music direction');
  assert.equal(await page.locator('#script').inputValue(),'');
  assert.equal(await page.locator('#set_lyrics').evaluate(el=>el.tagName),'TEXTAREA');
  await page.locator('#script').fill('Slow soul instrumental with piano and bass, 90 seconds.');
  await page.locator('#set_lyrics').fill('[Verse]\nMy own lyrics');
  await page.locator('#set_instrumental').check();
  assert.equal(await page.locator('#set_lyrics').count(),0);
  await page.locator('#btnRender').click();
  await page.locator('#btnRender').filter({hasText:'confirm'}).waitFor();
  assert.equal(sent.length,1);assert.equal(sent[0].body.estimateOnly,true);
  assert.equal(sent[0].body.engine,'lyria');assert.equal(sent[0].body.script,'Slow soul instrumental with piano and bass, 90 seconds.');
  for(const field of ['mood','gender','voice_description','reference_voice_url','audio_urls','lyrics'])assert.equal(sent[0].body[field],undefined,field);
  await page.locator('#script').fill('Edited music direction');
  assert.equal(await page.locator('#btnRender').innerText(),'Make music');
  await page.locator('#set_instrumental').uncheck();
  assert.equal(await page.locator('#set_lyrics').inputValue(),'[Verse]\nMy own lyrics');
  await page.locator('[data-engine="seed"]').click();
  assert.equal(await page.locator('#script').inputValue(),'');
  assert.equal(await page.locator('#editorLabel').innerText(),'Scene script');
  assert.equal(await page.locator('#set_audio_urls').isVisible(),true);
  assert.equal(await page.locator('#set_voice_description').count(),0);
  await page.locator('#script').fill('Seed scene and dialogue');
  await page.locator('[data-engine="scenema"]').click();
  assert.equal(await page.locator('#script').inputValue(),'Scenema spoken script');
  assert.equal(await page.locator('#text').inputValue(),'My exact spoken words');
  assert.equal(await page.locator('#set_voice_description').inputValue(),'Warm contralto');
  await page.locator('[data-engine="lyria"]').click();
  assert.equal(await page.locator('#script').inputValue(),'Edited music direction');
  assert.equal(await page.locator('#set_lyrics').inputValue(),'[Verse]\nMy own lyrics');
  assert.equal(await page.locator('#starter option').count(),3,'only music starters plus placeholder');
  await page.locator('#btnRender').click();await page.locator('#btnRender').filter({hasText:'confirm'}).waitFor();
  assert.equal(sent.length,2,'second quote, no generation or script-writing request');
  await page.locator('#btnRender').click();await page.locator('#status').filter({hasText:'Fixture recording ready'}).waitFor();
  assert.equal(sent.length,3);assert.equal(sent[2].body.estimateOnly,undefined);assert.equal(sent[2].body.lyrics,'[Verse]\nMy own lyrics');
  assert.deepEqual(errors,[]);
  if(output) await page.screenshot({path:output+'/lyria-workspace.png',fullPage:true});
  if(output) fs.writeFileSync(output+'/web-test-receipt.json',JSON.stringify({passed:true,engineDrafts:3,musicDirect:true,scriptRequests:0,confirmation:true,lyricsPreserved:true,noSpeechSettings:true},null,2));
  console.log('Web workspace tests passed: engine-specific controls, three drafts, music payload, lyric toggles and explicit quote confirmation.');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1;});
