import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {test}=require('node:test'),assert=require('node:assert/strict');
const {cue,timeline,controller}=(await import('./avatar-expression.mjs')).default;
test('existing steering tags map conservatively without classifying spoken words',()=>{
 assert.equal(cue('amused and fond').expression,'amused');
 assert.equal(cue('warm but completely serious').expression,'serious');
 assert.equal(cue('skeptical but friendly').expression,'skeptical');
 for(const s of ['not amused','without sadness','unsurprised','fast','resetting','<script>alert(1)</script>'])assert.equal(cue(s).expression,'neutral');
 assert.equal(cue('gasp').kind,'moment');assert.equal(cue('reset').kind,'reset');
});
test('offsets retain exact source text and ignore partial or oversized tags',()=>{
 const s='I am sad. %%%amused and fond%%% Hi 😀 %%%gasp%%% Oh. %%%reset%%% Fine.';
 const result=timeline(s);assert.equal(result.length,3);
 for(const c of result)assert.equal(s.slice(c.offset,c.end),'%%%'+c.tag+'%%%');
 assert.equal(timeline('%%%unfinished').length,0);
 assert.equal(timeline('%%%'+ 'a'.repeat(161)+'%%%').length,0);
 assert.throws(()=>timeline('a'.repeat(100001)),RangeError);
});
test('sound overlays preserve direction; reset and stop clear it',()=>{
 const c=controller();c.start('one');c.apply('one','warm');const gasp=c.apply('one','gasp');
 assert.equal(c.state().expression,'surprised');assert.equal(c.endMoment('one',gasp.revision).expression,'warm');
 assert.equal(c.apply('one','reset').expression,'neutral');c.apply('one','amused');
 assert.equal(c.stop('one').expression,'neutral');assert.equal(c.state().owner,null);
});
test('a stale one-shot timer cannot clear a later reaction in the same reply',()=>{
 const c=controller();c.start('one');c.apply('one','warm');const first=c.apply('one','gasp');
 const second=c.apply('one','laugh');c.endMoment('one',first.revision);assert.equal(c.state().expression,'amused');
 c.endMoment('one',second.revision);assert.equal(c.state().expression,'warm');
 c.apply('one','cough');assert.equal(c.state().expression,'warm');assert.equal(c.state().persistent,'warm');
});
test('late events from a cancelled or previous speaker cannot change the new face',()=>{
 const c=controller();c.start('one');c.apply('one','sad');c.start('two');c.apply('two','skeptical');
 c.apply('one','amused');c.stop('one');c.endMoment('one');assert.equal(c.state().expression,'skeptical');
 c.stop('two');c.apply('two','amused');assert.equal(c.state().expression,'neutral');
});
test('a wide vocabulary: real directions from a day of deepseek land on an expression',()=>{
 const want={
  "dry a little raspy like I'm on my second cup and you're not":'dry',
  "flat and hot like I'm mad on her behalf":'angry',
  'flat and clipped with no patience left':'frustrated',
  'genuinely delighted leaning in with a raised pitch on the first word':'excited',
  'warm but not letting it slide':'warm',
  'quiet taking it in':'tender',
  'steady the pitch coming down a notch taking charge':'serious',
  'light and teasing':'playful',
  'dry a little smug':'smug',
  'curious leaning in pitch lifting on the question':'curious',
  'worn out and yawning':'tired',
  'voice shaking a little scared':'afraid',
  'heavy hearted close to crying':'sad',
  'wide eyed like you cannot believe it':'surprised',
  'one eyebrow raised not buying it':'skeptical',
  'settled and unhurried':'calm',
  'slow and careful choosing each word':'thoughtful',
  'lip curled in contempt':'disgusted',
  'worried and protective':'concerned',
  'brisk and sure of it':'confident',
 };
 for(const [tag,expression] of Object.entries(want))assert.equal(cue(tag).expression,expression,tag);
 assert.equal(cue('soft chuckle').kind,'moment');assert.equal(cue('soft chuckle').expression,'amused');
 assert.equal(cue('yawn').expression,'tired');assert.equal(cue('cough').expression,null);
});
test('every expression has a complete bounded style and unknown names fall back to neutral',async()=>{
 const E=(await import('./avatar-expression.mjs')).default;
 assert.ok(E.expressions.length>=20);
 for(const name of E.expressions){const s=E.expressionStyle(name);
  for(const k of ['brow','browTalk','tilt','sway','nod','tempo','blink','lift'])assert.ok(Number.isFinite(s[k]),name+'.'+k);
  assert.ok(s.brow>=0&&s.brow<=1&&Math.abs(s.tilt)<=1&&s.tempo>=0.4&&s.tempo<=1.6);}
 assert.equal(E.expressionStyle('nonsense'),E.expressionStyle('neutral'));
});
test('nine drawn faces serve every expression; warmth outranks mere confidence',async()=>{
 const E=(await import('./avatar-expression.mjs')).default;
 const drawn=new Set(['neutral','smile','laugh','surprised','skeptical','angry','sad','worried']);
 for(const name of E.expressions)assert.ok(drawn.has(E.expressionFace(name)),name);
 assert.equal(E.expressionFace('nonsense'),'neutral');
 assert.equal(cue('warm and sure in your corner').expression,'warm');assert.equal(E.expressionFace('warm'),'smile');
 assert.equal(cue('warm but completely serious').expression,'serious');
});
