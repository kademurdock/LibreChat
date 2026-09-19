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

// Sep 19 2026: the chat player follows the character's own %%%directions%%%.
{
  const { expressionSchedule, styleAt, messageSpeechText } = await import('./voice-message-motion.mjs');
  const Expr = (await import('./avatar-expression.mjs')).default;
  test('directions are placed by spoken position; tags and cues do not count as speech', () => {
    const text = '%%%flat and hot like you are mad on her behalf%%% ' + 'a'.repeat(100) + ' %%%laugh%%% ' + 'b'.repeat(100) + ' %%%quiet and tender%%% ' + 'c'.repeat(100);
    const cues = expressionSchedule(text, 30);
    assert.deepEqual(cues.map((c) => c.expression), ['angry', 'amused', 'tender']);
    assert.deepEqual(cues.map((c) => c.kind), ['direction', 'moment', 'direction']);
    assert.equal(cues[0].at, 0);
    assert.ok(Math.abs(cues[1].at - 10) < 0.6 && Math.abs(cues[2].at - 20) < 0.6);
    assert.ok(expressionSchedule(text, NaN)[2].at > 10, 'an unknown length is estimated from the text');
    assert.deepEqual(expressionSchedule('no tags here', 5), []);
  });
  test('the face travels between expressions and a laugh is a passing moment', () => {
    const cues = [{ at: 0, expression: 'angry', kind: 'direction' }, { at: 5, expression: 'amused', kind: 'moment' }, { at: 10, expression: 'sad', kind: 'direction' }];
    assert.equal(styleAt(cues, 3).expression, 'angry');
    assert.equal(styleAt(cues, 5.3).expression, 'amused');
    assert.equal(styleAt(cues, 7).expression, 'angry');
    const mid = styleAt(cues, 10.25).style.lift, end = styleAt(cues, 12).style.lift;
    assert.ok(mid > Expr.expressionStyle('angry').lift && mid < end, 'a change is blended, not cut');
    assert.equal(end, Expr.expressionStyle('sad').lift);
  });
  test('the same audio moves differently under different directions, within safe bounds', () => {
    const pose = (expression, time) => voiceMessagePose({ id: 'agent_x', time, level: 0.12, active: true, cues: [{ at: 0, expression, kind: 'direction' }] });
    assert.ok(pose('surprised', 3).brow > pose('serious', 3).brow + 0.3);
    assert.equal(pose('excited', 3).expression, 'excited');
    for (const name of Expr.expressions) for (let t = 0; t < 12; t += 0.37) {
      const p = pose(name, t);
      assert.ok(p.brow >= 0 && p.brow <= 1 && Math.abs(p.tilt) <= 1.4 && Math.abs(p.nod) <= 1.8 && p.mouth >= 0 && p.mouth <= 1, name);
    }
    assert.equal(voiceMessagePose({ id: 'agent_x', time: 1, level: 0.1, active: true }).expression, 'neutral');
  });
  test('speech text comes from content parts or text and never from the person', () => {
    assert.equal(messageSpeechText({ content: [{ type: 'think', think: 'x' }, { type: 'text', text: '%%%warm%%% Hi' }, { type: 'text', text: { value: 'there' } }] }), '%%%warm%%% Hi there');
    assert.equal(messageSpeechText({ text: 'plain' }), 'plain');
    assert.equal(messageSpeechText({ isCreatedByUser: true, text: '%%%angry%%% mine' }), '');
  });
}
