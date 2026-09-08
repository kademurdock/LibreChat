const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { reverieSenses, REVERIE_OUTDOORS } = require('@librechat/api');
const { MooRoom, MooChar, MooItem, MooDistrict } = require(root + '/api/models/kadeMoo');
const engine = require(root + '/api/app/clients/tools/kademoo/life');
const seed = require(root + '/api/app/clients/tools/kademoo/life/outdoors').seed;
let checks = 0;
function check(value, label) { assert(value, label); checks++; console.log('PASS',label); }
(async()=>{
 const mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
 try {
  const old=require(root + '/api/app/clients/tools/kademoo/engine');
  const ch=await old.getOrCreateChar('outdoor-test','Alex Example');
  await MooChar.updateOne({_id:ch._id},{$set:{roomId:'pats_diner','attrs.life':{created:true,needs:{fed:80,rested:80,clean:80,fun:80,company:80},needsAt:Date.now()}}});
  const run=command=>engine.runCommand({userId:'outdoor-test',displayName:'Alex Example',command,live:true});
  let r=await run('look'); check(!r.actions.some(a=>a.cmd==='hunt'||a.cmd==='easy fish'||a.cmd==='rest by fire'),'outdoor controls hidden indoors');
  r=await run('go to Reedbank Creek'); check(r.ok&&r.room.roomId==='reedbank_creek','fresh world connects outdoors on first seed'); await run('go to pats');
  await seed(); await seed(); check(await MooRoom.countDocuments({roomId:{$in:REVERIE_OUTDOORS.map(r=>r.roomId)}})===4,'four rooms seeded idempotently');
  await MooRoom.updateOne({roomId:'alder_trail'},{$set:{desc:'Owner-edited prose'}}); await seed(); check((await MooRoom.findOne({roomId:'alder_trail'})).desc==='Owner-edited prose','seed preserves owner prose');
  r=await run('go to Alder Trail'); check(r.ok&&r.room.roomId==='alder_trail','trail reachable through existing city');
  check(r.kinds.some(k=>k.startsWith('move.step.')),'walking emits a material footstep');
  check(reverieSenses(REVERIE_OUTDOORS[0],'rain').surface==='mud.shallow','rain changes earth to mud');
  r=await run('track wildlife'); check(r.ok&&r.lines.some(l=>l.includes('journal')),'wildlife encounter saved');
  check(!(await run('track wildlife')).ok,'field discovery cooldown');
  check((await run('field journal')).lines.some(l=>l.includes('Alder Trail')),'journal recalls place');
  r=await run('go north'); check(r.ok&&r.room.roomId==='reedbank_creek','creek path connected');
  r=await run('easy fish'); check(r.ok&&r.choices.length===2,'fishing offers keep and release');
  const repeated=await run('easy fish'); check(repeated.ok&&repeated.lines.some(l=>l.includes('no timer')),'fish waits without reaction deadline');
  const keeps=await Promise.all([run('easy fish keep'),run('easy fish keep')]); check(keeps.filter(r=>r.ok).length===1,'concurrent keep creates one catch');
  check(await MooItem.countDocuments({'location.id':'outdoor-test','props.fish':true})===1,'one inventory fish');
  check((await MooItem.findOne({'props.fish':true})).props.ingredient==='fish','catch is a recipe ingredient');
  check(!(await run('easy fish')).ok,'fishing rewards cannot be spammed');
  await run('go to the Shack'); r=await run('sell'); check(r.ok&&!(await MooItem.countDocuments({'location.id':'outdoor-test','props.fish':true})),'catch sells through existing fish market');
  await run('go to Alder Hide'); r=await run('hunt'); check(r.ok&&r.choices.length===3,'hunt remains an explicit optional choice');
  check(!(await run('hunt Pat')).ok,'hunt cannot target a character');
  r=await run('hunt rabbit'); check(r.ok&&await MooItem.countDocuments({'location.id':'outdoor-test','props.ingredient':'meat'})===1,'rabbit yields cooking meat');
  check(!(await run('hunt rabbit')).ok,'hunting has cooldown');
  await run('go to Alder Camp'); check((await run('look')).actions.some(a=>a.cmd==='rest by fire'),'camp rest discoverable');
  check((await run('rest by fire')).ok,'rest at campsite');
  await run('go to pats'); r=await run('look'); check(r.people.find(p=>p.name==='Pat Harris').cmds.some(c=>c.cmd.startsWith('converse ')),'resident conversation discoverable');
  r=await run('converse Pat: Hello'); check(r.ok&&r.choices.some(c=>c.cmd.startsWith('talk to')),'missing provider offers authored fallback');
  check(await MooDistrict.countDocuments({districtId:'reverie_conversation_budget_153'})===0,'no model charge reserved without provider');
  const fetchBefore=global.fetch; let requests=0; let requestBody;
  process.env.REFRAME_PROXY_SECRET='local-test-placeholder';
  global.fetch=async(url,options)=>{ requests++;requestBody=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'%%%smiles%%% Less heat. Give the eggs a minute.'}}]})}; };
  try {
   r=await run('converse Pat: My eggs keep burning.'); check(r.ok&&r.lines.some(l=>l.includes('Less heat.'))&&!r.lines.join('').includes('%%%'),'model dialogue strips voice-only markup');
   check(requestBody.model==='z-ai/glm-5.3-flash'&&requestBody.max_tokens===220,'cheap model and bounded output');
   r=await run('reply I see: less heat.'); check(r.ok&&requests===2,'reply permits colons in natural speech');
   check(requestBody.messages.some(m=>m.role==='assistant'&&m.content.includes('Less heat')),'resident receives bounded conversation history');
   const saved=await MooChar.findOne({_id:ch._id});check(saved.attrs.life.conversations.pat.length===4,'history belongs to this player and resident');
   check(!(await run('reply '+ 'x'.repeat(601))).ok&&requests===2,'oversize messages rejected before spending');
   await MooDistrict.updateOne({districtId:'reverie_conversation_budget_153'},{$set:{'props.calls':100}});
   r=await run('reply Hello again');check(r.ok&&requests===2&&r.choices.some(c=>c.cmd.startsWith('talk to')),'exhausted persistent allowance makes no paid call');
   await run('go to Alder Trail');check(!(await run('reply Where did you go?')).ok,'cannot converse with absent resident');
  } finally {global.fetch=fetchBefore;delete process.env.REFRAME_PROXY_SECRET;}
  console.log('Outdoor integration checks:',checks);
 } finally { await mongoose.disconnect(); await mongo.stop(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
