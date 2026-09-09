const {chromium}=require('@playwright/test');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto('http://127.0.0.1:8168/workshop.html');await p.getByRole('checkbox').check();await p.getByRole('button',{name:'Play Kiana’s Windflower sample'}).click();
await p.waitForFunction(()=>JSON.parse(document.querySelector('#frames').dataset.frame).mouth>.1);
await p.waitForFunction(()=>JSON.parse(document.querySelector('#frames').dataset.frame).blink>.5);
await p.screenshot({path:path.join(process.env.CHARACTER_RECEIPTS,'workshop-windflower.png')});
await p.getByRole('button',{name:'Interrupt',exact:true}).click();assert.equal(await p.evaluate(()=>JSON.parse(document.querySelector('#frames').dataset.frame).mouth),0);
assert.deepEqual(errors,[]);console.log('Saved Windflower sample drives mouth and blink; interrupt closes both');}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
