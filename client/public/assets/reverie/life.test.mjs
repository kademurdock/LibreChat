import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneModel, figurePosition, residentFace, walkPose, figureActivity, describePicture } from './presentation.mjs';

test('figures use activity stations; guests always face their gathering instead', () => {
  const model = sceneModel({roomId:'pats_diner', peopleDetail:[{id:'npc:pat',name:'Pat',tag:'working the grill'}]});
  const pat = model.people[1];
  assert.equal(figurePosition(model,pat,1).x,-4.65);
  model.hangout={title:'Record night',guests:['Pat']};
  assert.equal(figurePosition(model,pat,1).gathering,true);
  assert.equal(figureActivity(model,pat),'talking');
});
test('walking faces travel, stops at destination, and never overshoots', () => {
  const from={x:-3,z:2},to={x:2,z:0,rotation:.4};
  for(let t=0;t<6;t+=.02) {
    const frame=walkPose(from,to,t,17);
    assert(frame.x>=-3 && frame.x<=2 && frame.z>=0 && frame.z<=2);
    assert(Object.values(frame).every(v=>typeof v==='boolean'||Number.isFinite(v)));
  }
  assert.equal(walkPose(from,to,10).rotation,.4);
  assert.equal(walkPose(from,to,10).walking,false);
  assert.equal(walkPose(from,to,Infinity).x,2);
});
test('faces are bounded and have independent blink timing', () => {
  let different=false;
  for(let t=0;t<12;t+=.02) {
    const a=residentFace('reading',t,1), b=residentFace('talking',t,92);
    assert(a.blink>=0 && a.blink<=1 && b.blink>=0 && b.blink<=1);
    assert(Object.values(a).every(Number.isFinite));
    if(Math.abs(a.blink-b.blink)>.2)different=true;
  }
  assert(different);
  assert.equal(residentFace('reading',1).brow,-.12);
});
test('new canonical rooms describe what they render', () => {
  for(const [id,type] of [['levis_chairs','barber'],['the_garages','workshop']]) {
    const model=sceneModel({roomId:id,name:id});
    assert.equal(model.type,type);
    assert(describePicture(model).includes(type==='barber'?'barber chair':'workbench'));
  }
});
