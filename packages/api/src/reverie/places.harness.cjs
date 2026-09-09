const assert=require('node:assert/strict');
const mongoose=require('mongoose');const {MongoMemoryServer}=require('mongodb-memory-server');
(async()=>{
 const mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
 let n=0;const check=(v,label)=>{assert(v,label);n++;console.log('PASS',label);};
 const {MooChar,MooRoom}=require('../../../../api/models/kadeMoo');
 const engine=require('../../../../api/app/clients/tools/kademoo/engine');
 const life=require('../../../../api/app/clients/tools/kademoo/life');
 const places=require('../../../../api/app/clients/tools/kademoo/life/places');
 const run=command=>life.runCommand({userId:'laundry-test',displayName:'Wash Test',command,isWizard:true,live:true});
 try {
  const ch=await engine.getOrCreateChar('laundry-test','Wash Test');
  await MooChar.updateOne({_id:ch._id},{$set:{roomId:'patch_gully_road','attrs.life':{created:true,needs:{clean:30,fed:80,rested:80,fun:80,company:80},needsAt:Date.now()}}});
  const before=(await MooChar.findById(ch._id)).attrs.coin;
  let r=await run('ne');check(r.room.roomId==='gully_laundry','new door is reachable through actual movement');
  check(r.room.peopleDetail.some(p=>p.id==='npc:nell'),'Nell is seeded in the actual room');
  check(r.room.sensory.ambience==='amb.laundry.quiet','washer ambience belongs to the room');
  check(r.actions.some(a=>a.cmd==='wash clothes'),'laundry action is discoverable');
  const results=await Promise.all([run('wash clothes'),run('wash clothes')]);
  check(results.filter(r=>r.ok).length===1,'concurrent washing grants one result');
  check((await MooChar.findById(ch._id)).attrs.coin===before,'laundry never charges game money');
  check((await MooChar.findById(ch._id)).attrs.life.needs.clean>30,'washing improves comfort');
  await MooChar.updateOne({_id:ch._id},{$set:{'attrs.busyUntil':0,'attrs.life.laundryAt':0}});
  check((await run('fold laundry')).ok,'folding uses the same actual room');
  await MooChar.updateOne({_id:ch._id},{$set:{'attrs.busyUntil':0}});
  r=await run('sw');check(r.room.roomId==='patch_gully_road','return path leads back to Gully Road');
  check(!(await run('wash clothes')).ok,'wash action requires the actual machines');
  await MooRoom.updateOne({roomId:'patch_gully_road'},{$set:{'exits.ne':'owner-door'}});
  await MooRoom.updateOne({roomId:'gully_laundry'},{$set:{desc:'Owner edited room'}});
  await places.seed();
  check((await MooRoom.findOne({roomId:'patch_gully_road'})).exits.ne==='owner-door','seed never replaces an owner exit');
  check((await MooRoom.findOne({roomId:'gully_laundry'})).desc==='Owner edited room','seed never replaces edited room prose');
  check(await MooChar.countDocuments({userId:'npc:nell'})===1,'population seed creates exactly one Nell');
  console.log(n+' washhouse checks passed');
 }finally{await mongoose.disconnect();await mongo.stop();}
})().catch(e=>{console.error(e);process.exit(1);});
