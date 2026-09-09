const {chromium}=require('@playwright/test');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:900,height:900}});
  await page.goto('http://127.0.0.1:8168/workshop.html');
  await page.evaluate(async()=>{
   const {createPortraitRig}=await import('./portrait-rig.mjs');
   document.body.innerHTML='<canvas id="rig"></canvas>';const c=document.querySelector('canvas');
   c.style.width=c.style.height='768px';
   window.baseFrame={characterId:'kiana',active:true,mouth:0,blink:0,tilt:0};
   await new Promise(resolve=>{window.rig=createPortraitRig(c,{id:'kiana',portrait:'portrait.png',atlas:'kiana-atlas-draft.png',blink:'eyes-closed.png',onReady:resolve});});
   await new Promise(r=>setTimeout(r,100));
   window.rig.render(window.baseFrame);
  });
  const out=process.env.CHARACTER_RECEIPTS;
  const neutral=await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(0,0,512,512).data));
  await page.locator('canvas').screenshot({path:path.join(out,'rig-neutral.png')});
  await page.evaluate(()=>window.rig.render({...window.baseFrame,blink:1}));
  await page.locator('canvas').screenshot({path:path.join(out,'rig-blink.png')});
  const closed=await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(0,0,512,512).data));
  let changed=0,outside=0;
  for(let y=0;y<512;y++)for(let x=0;x<512;x++){
   const i=(y*512+x)*4;if(neutral.slice(i,i+4).some((v,k)=>v!==closed[i+k])){
    changed++;const nx=x/512,ny=y/512;
    if(!((nx>=.35&&nx<=.49&&ny>=.26&&ny<=.36)||(nx>=.51&&nx<=.65&&ny>=.21&&ny<=.31)))outside++;
   }
  }
  assert.ok(changed>300);assert.equal(outside,0);
  await page.evaluate(()=>window.rig.render({...window.baseFrame,blink:1,mouth:1}));
  await page.locator('canvas').screenshot({path:path.join(out,'rig-speaking-blink.png')});
  await page.evaluate(()=>window.rig.render({...window.baseFrame,active:false,blink:1,mouth:1}));
  assert.equal(await page.locator('canvas').isVisible(),false);
  fs.writeFileSync(path.join(out,'rig-pixels.json'),JSON.stringify({changedPixels:changed,outsideEyeRegions:outside},null,2));
  console.log('Blink pixels confined to eye regions',changed);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
