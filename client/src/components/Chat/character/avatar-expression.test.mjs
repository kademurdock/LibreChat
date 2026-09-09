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
