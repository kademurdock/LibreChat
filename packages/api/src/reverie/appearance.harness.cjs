const path=require('node:path');
require(path.resolve(__dirname,'../../../../api/test/reverie-bootstrap.cjs'));
const assert=require('node:assert/strict');
const {reverieAppearance}=require('@librechat/api');
assert.deepEqual(reverieAppearance({life:{look:{build:'solid',hair:'locs',style:'denim',line:'private'},partnerName:'private',needs:{secret:1}}}),{build:'solid',hair:'locs',style:'denim'});
assert.equal(reverieAppearance({life:{look:{line:'private'}}}),null);
assert.equal(reverieAppearance({life:{look:{hair:{invalid:true}}}}),null);
assert.equal(reverieAppearance({life:{look:{style:'a'.repeat(300)}}}).style.length,160);
const {MooChar}=require(path.resolve(__dirname,'../../../../api/models/kadeMoo'));
const mongoose=require('mongoose');
const {MongoMemoryServer}=require('mongodb-memory-server');
const old=require(path.resolve(__dirname,'../../../../api/app/clients/tools/kademoo/engine'));
const engine=require(path.resolve(__dirname,'../../../../api/app/clients/tools/kademoo/life'));
(async()=>{
 const db=await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
 try {
  for(const id of ['appearance-viewer','appearance-other']) {
   const c=await old.getOrCreateChar(id,id);
   await MooChar.updateOne({_id:c._id},{$set:{roomId:'pats_diner','attrs.life':{created:true,look:{build:'solid',hair:'locs',style:'denim'},partnerName:'SECRET',needsAt:Date.now()}}});
  }
  const r=await engine.runCommand({userId:'appearance-viewer',displayName:'Viewer',command:'look',live:true,isWizard:true});
  assert.equal(r.hud.appearance.hair,'locs');
  assert.equal(r.room.peopleDetail.find(p=>p.id==='appearance-other').appearance.style,'denim');
  assert.ok(!JSON.stringify(r.room.peopleDetail).includes('SECRET'));
  console.log('Appearance: 7 checks including actual engine and private-field isolation pass');
 } finally {await mongoose.disconnect(); await db.stop();}
})().catch(e=>{console.error(e);process.exitCode=1});
