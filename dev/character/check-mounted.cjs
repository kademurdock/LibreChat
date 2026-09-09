const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({...(process.env.CHARACTER_BROWSER ? {channel:process.env.CHARACTER_BROWSER} : {}),headless:true});const page=await browser.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.CHARACTER_PREVIEW_URL || 'http://127.0.0.1:8165');
 const enabled=page.getByRole('checkbox');assert.equal(await enabled.isChecked(),false);
 assert.equal(await page.locator('canvas').isVisible(),false);
 await enabled.check();await page.waitForFunction(()=>!document.querySelector('canvas').hidden);
 await page.screenshot({path:'./rig-rest.png'});
 await page.getByRole('button',{name:'Play sample',exact:true}).click();await page.waitForTimeout(1600);
 await page.screenshot({path:'./rig-speech.png'});
 await page.getByRole('button',{name:'Interrupt',exact:true}).click();
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('canvas').hidden);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>!document.querySelector('canvas').hidden);
 await page.evaluate(()=>window.test.play(true,'unprepared-speaker'));await page.waitForTimeout(200);
 assert.equal(await page.locator('.stage img').count(),0);assert.equal(await page.locator('canvas').isVisible(),false);
 await page.evaluate(()=>window.test.play());await page.waitForTimeout(200);assert.equal(await page.locator('.stage img').count(),1);
 await page.evaluate(()=>window.test.setLive(true));await page.waitForFunction(()=>document.querySelector('canvas').hidden);assert.equal(await page.locator('.stage img').count(),0);
 await page.evaluate(()=>{window.test.setLive(false);window.test.stop();});
 await page.reload();assert.equal(await enabled.isChecked(),true);
 await page.getByRole('button',{name:'End preview',exact:true}).click();assert.equal(await page.locator('canvas').count(),0);
 await page.getByRole('button',{name:'Open preview',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('canvas').hidden);
 for(const [width,theme] of [[1040,'light'],[360,'dark']]){
  await page.setViewportSize({width,height:850});await page.emulateMedia({colorScheme:theme});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`./mounted-${width}.png`,fullPage:true});
 }
 assert.deepEqual(errors,[]);fs.writeFileSync('./mounted-browser.json',JSON.stringify({errors,checks:'React StrictMode; initially off; persisted; reduced-motion changes; speaker identity; Spotter; teardown/reopen; narrow/wide'},null,2));
 await browser.close();console.log('Mounted controller browser checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
