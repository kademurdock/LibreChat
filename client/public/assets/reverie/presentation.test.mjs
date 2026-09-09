import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneModel, describePicture, furnitureKind } from './presentation.mjs';
test('existing room facts select distinct scenes', () => {
  for(const [room,type] of [
    [{roomId:'alder_trail',outdoor:true,sensory:{nature:true}},'woodland'],
    [{roomId:'reedbank_creek',outdoor:true,sensory:{nature:true,water:'river'}},'creek'],
    [{roomId:'alder_camp',outdoor:true},'camp'],
    [{roomId:'pier_seven',outdoor:true},'harbor'],
    [{roomId:'gate',outdoor:true},'town'],
    [{roomId:'pats_diner'},'diner'],
    [{roomId:'records_office'},'library'],
    [{roomId:'new_home',home:{mine:true}},'home'],
  ])assert.equal(sceneModel(room).type,type);
});
test('empty homes are not silently furnished',()=>{
 const model=sceneModel({name:'My room',roomId:'my_room',home:{mine:true},furniture:[]});
 assert.deepEqual(model.furniture,[]);assert.match(describePicture(model),/unfurnished/);
});
test('furnishing and day/night changes appear in accessible description',()=>{
 const model=sceneModel({name:'Home',home:{},furniture:['a worn sofa','a radio']},{dark:true});
 assert.match(describePicture(model),/worn sofa, a radio/);assert.match(describePicture(model),/deep blue/);
 assert.equal(furnitureKind('a worn couch'),'sofa');
});
test('people are bounded visually and overflow is disclosed, never represented as absent',()=>{
 const peopleDetail=Array.from({length:18},(_,i)=>({id:String(i),name:'Person '+i,kind:i%2?'player':'citizen'}));
 const room={name:'Town',peopleDetail};const before=JSON.stringify(room);
 const m=sceneModel(room,{name:'Alex'});
 assert.equal(m.people.length,12);assert.equal(m.totalPeople,19);assert.match(describePicture(m),/7 more occupants/);
 assert.doesNotMatch(describePicture(m),/citizen|synth|player|bot/);assert.equal(JSON.stringify(room),before);
});
test('indoor scenery never describes outdoor weather effects',()=>{
 assert.doesNotMatch(describePicture(sceneModel({name:'Room',weather:'rain'})),/current rain/);
 assert.match(describePicture(sceneModel({name:'Path',outdoor:true,weather:'snow'})),/current snow/);
});
