const {test}=require('node:test');
const assert=require('node:assert/strict');
const {scrubForSpeech}=require('./scrubForSpeech');
const {stripAiTells}=require('../../../utils/stripAiTells');
test('internal citation IDs disappear from voice and saved prose, preserving steering',()=>{
  const text='%%%warm%%% It opens at nine. Turn0local0 turn0tech0 TURN3NEWS7 Turn0local0turn1search2';
  for(const fn of [scrubForSpeech,stripAiTells]) {
    const clean=fn(text);
    assert.doesNotMatch(clean,/turn\d+[a-z]+\d+/i);
    assert.match(clean,/%%%warm%%%/);
    assert.match(clean,/It opens at nine/);
  }
});
