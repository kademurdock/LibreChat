const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const out=process.env.REVERIE_RECEIPTS || path.join(__dirname,'scene-receipts');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1100,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8169/world');await page.waitForSelector('.has-stage');
 for(const [room,name] of [['dezs_bar','bar'],['bowling_lanes','bowling'],['records_office','records']]){
  await page.locator('#cmdInput').fill('@tp '+room);await page.locator('#cmdInput').press('Enter');
  await page.waitForFunction(()=>document.getElementById('cmdForm').getAttribute('aria-busy')!=='true');
  await page.locator('#reverieIllustration').screenshot({path:path.join(out,name+'.png')});
  assert.equal(await page.locator('canvas').count(),1);
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'scenes.json'),JSON.stringify({realEngineRooms:3,errors}));
 await browser.close();console.log('Three actual-engine interiors render without page errors');
})().catch(e=>{console.error(e);process.exit(1)});
