const assert = require('node:assert/strict');
const fs = require('node:fs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { reverieWeather, reverieForecast, compileReverie } = require('@librechat/api');
let checks=0;function check(value,label){assert(value,label);checks++;console.log('PASS',label);}
(async()=>{
 const start=Date.parse('2026-01-01T00:00:00Z');let prev=null;const kinds=new Set();let maximumJump=0;
 for(let i=0;i<365*24;i++){
  const now=new Date(start+i*3600000);const wx=reverieWeather(now);kinds.add(wx.kind);
  assert.deepEqual(wx,reverieWeather(new Date(now)));
  if(prev)maximumJump=Math.max(maximumJump,Math.abs(prev.temperatureC-wx.temperatureC));
  if(wx.kind==='snow')assert(wx.temperatureC<=1);
  if(wx.kind==='heat')assert(wx.temperatureC>=30);
  if(wx.kind==='storm')assert(wx.temperatureC>=12);
  prev=wx;
 }
 check(kinds.size===7,'a full year contains all seven seasonal conditions');
 check(maximumJump<=2,'hourly temperatures change gradually throughout a full year');
 for(const at of ['2026-03-08T07:59:59Z','2026-11-01T06:59:59Z','2026-12-31T23:59:59Z']){
  const a=reverieWeather(new Date(at)),b=reverieWeather(new Date(Date.parse(at)+1000));assert(Math.abs(a.temperatureC-b.temperatureC)<=2);
 }
 check(true,'DST and year rollover do not reroll the weather front');
 const at=new Date('2026-09-18T01:00:00Z');const forecast=reverieForecast(at);
 check(forecast[2]===`In 6 hours: ${reverieWeather(new Date(+at+21600000)).line}`,'forecast is the same world state at the future time');
 assert.throws(()=>reverieWeather(new Date('bad')));check(true,'invalid weather date rejected');
 const source=fs.readFileSync('api/app/clients/tools/kademoo/world/waterfront.rev','utf8');
 check(compileReverie(source).places.length===3,'readable source compiles three places');
 for(const bad of [source+'\nExecute: process.exit()',source.replace('Outside: yes','Outside: maybe'),source.replace('North: reed_pavilion','North: __proto__'),source+'\n'+source,source.replace('Smell: River','Unknown: River')]) assert.throws(()=>compileReverie(bad));
 check(true,'unknown instructions, duplicate places, invalid fields, and unsafe keys fail closed');
 const db=await MongoMemoryServer.create();await mongoose.connect(db.getUri());
 try{
  const {MooChar,MooRoom,MooEvent}=require('../../../../api/models/kadeMoo');
  const old=require('../../../../api/app/clients/tools/kademoo/engine');const life=require('../../../../api/app/clients/tools/kademoo/life');
  const ch=await old.getOrCreateChar('waterfront-test','Waterfront Tester');
  await MooChar.updateOne({_id:ch._id},{$set:{roomId:'ferry_dock_hook','attrs.life':{created:true,look:{build:'tall',hair:'locs',style:'a coat'},needs:{fun:30,rested:60},needsAt:Date.now()},'attrs.coin':35}});
  const run=command=>life.runCommand({userId:ch.userId,displayName:ch.name,command,isWizard:true,live:true});
  let r=await run('n');check(r.room.roomId==='ropewalk','actual ferry dock exit enters Ropewalk');
  check(r.room.sensory.ambience==='amb.ropewalk.water','room sound follows the authored source');
  check(r.actions.some(a=>a.cmd==='sit by the water'),'authored action has a phone button');
  const concurrent=await Promise.all([run('sit by the water'),run('sit by the water')]);check(concurrent.filter(r=>r.ok).length===1,'duplicate simultaneous actions produce one result');
  check(await MooEvent.countDocuments({actorUserId:ch.userId,text:/Ropewalk bench/})===1,'shared action recorded once');
  r=await run('e');check(r.room.roomId==='net_loft'&&!r.room.outdoor,'shelter is indoors');
  check(!(await run('sit by the water')).ok,'room-specific action refused from the wrong place');
  r=await run('w');r=await run('n');check(r.room.roomId==='reed_pavilion','continuous route reaches pavilion');
  r=await run('n');check(r.room.roomId==='sweetwater_park','waterfront connects both neighborhoods');
  r=await run('se');check(r.room.roomId==='reed_pavilion','Sweetwater return direction works');
  check((await run('places')).choices.length===9,'neighborhood picker has bounded buttons');
  check((await run('places hook')).choices.some(c=>c.cmd==='go to ropewalk'),'destination buttons address actual places');
  check((await run('places pavilion')).choices.some(c=>c.cmd==='go to reed_pavilion'),'place name search works');
  check((await run('forecast')).lines.some(l=>l.startsWith('In 12 hours:')),'forecast works through actual engine');
  r=await run('pink hair');check(r.hud.appearance.hair==='pink hair','natural dictated pink hair updates own appearance');
  r=await run('wear a blue dress and headphones');check(r.hud.appearance.style==='a blue dress and headphones','dictated clothes preserved');
  const saved=await MooChar.findById(ch._id).lean();check(saved.attrs.coin===35&&saved.attrs.life.look.build==='tall','wardrobe preserves money and other appearance');
  check((await run('look')).hud.appearance.hair==='pink hair','appearance persists on a fresh command');
  check(!(await run('hair '+ 'a'.repeat(121))).ok,'oversize appearance refused without truncating silently');
  await MooRoom.updateOne({roomId:'net_loft'},{$set:{desc:'Founder edits remain.'}});
  const authored=require('../../../../api/app/clients/tools/kademoo/life/authored');await authored.seed();
  check((await MooRoom.findOne({roomId:'net_loft'})).desc==='Founder edits remain.','reseeding preserves Founder edits');
  await MooRoom.updateOne({roomId:'ferry_dock_hook'},{$set:{'exits.n':'the_docks'}});await authored.seed();
  check((await MooRoom.findOne({roomId:'ferry_dock_hook'})).exits.n==='the_docks','occupied connector directions are preserved');
 }finally{await mongoose.disconnect();await db.stop();}
 console.log('Waterfront checks:',checks);
})().catch(e=>{console.error(e);process.exitCode=1});

