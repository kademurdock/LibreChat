import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneModel, figureActivity, activityPose, describePicture } from './presentation.mjs';
test('room scenes follow actual room identity',()=>{
  for(const [id,type] of [['dezs_bar','bar'],['records_office','office'],['the_bowling_alley','bowling'],['laundromat','laundry']])
    assert.equal(sceneModel({roomId:id}).type,type);
});
test('public activities determine props without inventing player actions',()=>{
  const model=sceneModel({roomId:'pats_diner',peopleDetail:[{id:'npc:pat',name:'Pat',tag:'working the grill'}]});
  assert.equal(figureActivity(model,model.people[0]),'idle');
  assert.equal(figureActivity(model,model.people[1]),'cooking');
  assert.match(describePicture(model),/Pat is working the grill/);
  assert.equal(figureActivity(model,{tag:'not reading'}),'idle');
});
test('gathering activity replaces the work gesture until the resident leaves',()=>{
 const model=sceneModel({roomId:'pats_diner',hangout:{title:'Story night',guests:['Pat']},peopleDetail:[{id:'npc:pat',name:'Pat',tag:'working the grill'}]});
 assert.equal(figureActivity(model,model.people[1]),'reading');
});
test('activity poses are bounded over long sessions and invalid clocks',()=>{
 for(const activity of ['idle','reading','carrying','cooking','sweeping','drinking','fishing','talking','dance'])
  for(const time of [0,1,8,1000,1e8,NaN,Infinity])
   for(const value of Object.values(activityPose(activity,time,123)))assert(Number.isFinite(value)&&Math.abs(value)<1.6);
});
