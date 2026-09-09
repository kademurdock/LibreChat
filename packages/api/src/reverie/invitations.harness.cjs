const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MooRoom, MooChar } = require(root + '/api/models/kadeMoo');
const engine = require(root + '/api/app/clients/tools/kademoo/life');
const old = require(root + '/api/app/clients/tools/kademoo/engine');
let checks=0;
const check=(condition,label)=>{assert(condition,label);checks++;console.log('PASS',label);};
(async()=>{
 const mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
 try {
  for(const [id,name] of [['invite-test','Alex Example'],['invite-human','Bea Example']]) {
   const ch=await old.getOrCreateChar(id,name);
   await MooChar.updateOne({_id:ch._id},{$set:{roomId:'pats_diner','attrs.life':{created:true,needs:{fed:80,rested:80,clean:80,fun:80,company:80},needsAt:Date.now()}}});
  }
  const run=command=>engine.runCommand({userId:'invite-test',displayName:'Alex Example',command,live:true});
  await run('look');
  const resident=await MooChar.findOne({userId:/^npc:/});
  await MooChar.updateOne({_id:resident._id},{$set:{roomId:'pats_diner'}});
  check(!(await run('hangout invite '+resident.name)).ok,'cannot invite without gathering');
  check((await run('hangout host cookout')).ok,'host a shared cookout');
  check(!(await run('hangout invite Missing Person')).ok,'reject absent target');
  const results=await Promise.all([run('hangout invite '+resident.name),run('hangout invite '+resident.name)]);
  check(results.every(r=>r.ok),'concurrent duplicate invitations resolve');
  let room=await MooRoom.findOne({roomId:'pats_diner'}).lean();
  check(room.props.hangout.guests.filter(g=>g.userId===resident.userId).length===1,'resident joins once');
  check(room.props.hangout.entries.filter(g=>g.userId===resident.userId).length===1,'contribution records once');
  check(results.some(r=>r.sounds?.length),'participation has an existing sound cue');
  const human=await run('hangout invite Bea');
  check(human.ok,'can invite a human player');
  room=await MooRoom.findOne({roomId:'pats_diner'}).lean();
  check(!room.props.hangout.guests.some(g=>g.userId==='invite-human'),'human is never joined without accepting');
  const looked=await run('look');
  check(looked.people.filter(p=>['player','citizen'].includes(p.kind)).every(p=>p.cmds.some(c=>c.label==='Invite to hangout')),'same invite control on all adult people');
  await run('hangout leave');
  room=await MooRoom.findOne({roomId:'pats_diner'}).lean();
  check(!room.props.hangout,'only remaining residents do not strand host ownership');
  check(room.props.hangoutAlbum[0].entries.some(e=>e.userId===resident.userId),'resident contribution archived with everyone else');
  check((await run('hangout memories')).lines.some(l=>l.includes('Cookout')),'shared album readable through existing commands');
  console.log(checks+' invitation checks passed');
 }finally{await mongoose.disconnect();await mongo.stop();}
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
