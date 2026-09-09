import test from 'node:test';
import assert from 'node:assert/strict';
import { watchVoiceAudio, stopWatchingVoiceAudio, voicePlayback } from './voice-playback.mjs';
import { messageCharacterId, voiceMessagePose } from './voice-message-motion.mjs';
class Audio extends EventTarget { paused=true; ended=false; src='blob:fixture'; currentSrc=''; currentTime=0; readyState=4;
  fire(name) { this.dispatchEvent(new Event(name)); }
}
test('prepared audio waits for actual start, pause/resume and waiting are observed without controlling audio', () => {
 const a=new Audio();const done=watchVoiceAudio(a,'one');assert.equal(voicePlayback.snapshot(),null);
 a.paused=false;a.fire('play');assert.equal(voicePlayback.snapshot(),null);
 a.fire('playing');assert.equal(voicePlayback.snapshot().phase,'playing');
 a.fire('waiting');assert.equal(voicePlayback.snapshot().phase,'waiting');
 a.paused=true;a.fire('pause');assert.equal(voicePlayback.snapshot().phase,'paused');
 a.paused=false;a.fire('playing');assert.equal(voicePlayback.snapshot().phase,'playing');
 a.ended=true;a.fire('ended');assert.equal(voicePlayback.snapshot(),null);done();
});
test('new speaker owns presentation; old buffering/completion/cleanup cannot erase it', () => {
 const a=new Audio(),b=new Audio();watchVoiceAudio(a,'one');a.paused=false;a.fire('playing');
 watchVoiceAudio(b,'two');b.paused=false;b.fire('playing');
 a.fire('waiting');a.fire('ended');stopWatchingVoiceAudio(a);assert.equal(voicePlayback.snapshot().messageId,'two');
 stopWatchingVoiceAudio(b);assert.equal(voicePlayback.snapshot(),null);
});
test('element reuse replaces identity and detaches old listeners',()=>{
 const a=new Audio();watchVoiceAudio(a,'one');a.paused=false;a.fire('playing');
 watchVoiceAudio(a,'two');assert.equal(voicePlayback.snapshot().messageId,'two');
 a.fire('emptied');assert.equal(voicePlayback.snapshot(),null);stopWatchingVoiceAudio(a);
});
test('only recorded authors select a character; no selected-chat or user-name guessing',()=>{
 assert.equal(messageCharacterId({model:'agent_della'}),'agent_della');
 assert.equal(messageCharacterId({agent_id:'agent_lilly',model:'agent_kiana'}),'agent_lilly');
 assert.equal(messageCharacterId({isCreatedByUser:true,model:'agent_kiana'}),null);
 assert.equal(messageCharacterId({model:'grok',sender:'Kiana'}),null);
});
test('silence, bad levels and disabled motion close mouth; seek uses current audio clock',()=>{
 assert.equal(voiceMessagePose({id:'a',time:1,level:0,active:true}).mouth,0);
 assert.equal(voiceMessagePose({id:'a',time:1,level:NaN,active:true}).mouth,0);
 assert.equal(voiceMessagePose({id:'a',time:1,level:1,active:false}).mouth,0);
 assert.ok(voiceMessagePose({id:'a',time:1,level:.5,active:true}).mouth>0);
 for (const id of ['agent_kiana','agent_della','agent_lilly']) for(let n=0;n<1000;n++) {
  const p=voiceMessagePose({id,time:n/24,level:.2,active:true});assert.ok(Math.abs(p.tilt)<=.6 && Math.abs(p.nod)<=.7);
 }
});
