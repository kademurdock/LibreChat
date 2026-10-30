const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function load(aliases){
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeWorldPulse'),'utf8'),{module,process:{env:{KADE_WORLD_SEED_ALIASES:aliases}}});
  return module.exports;
}
test('evaluation seed aliases match across days while unlisted characters stay unchanged',()=>{
  const original=load('{}'),paired=load(JSON.stringify({copy1:'kiana',copy2:'kiana'}));
  for(const date of ['2026-09-22','2026-09-23','2026-09-24']){
    assert.equal(paired.getDailySeed('copy1',date),original.getDailySeed('kiana',date));
    assert.equal(paired.getDailySeed('copy2',date),original.getDailySeed('kiana',date));
    assert.equal(paired.getDailySeed('other',date),original.getDailySeed('other',date));
  }
  assert.equal(load('invalid').getDailySeed('kiana','2026-09-22'),original.getDailySeed('kiana','2026-09-22'));
});

/* Oct 29 2026: digital-life seeds (the body seeds told Kiana to make up a drink). */
function loadWith(env){
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeWorldPulse'),'utf8'),{module,process:{env}});
  return module.exports;
}
const BODY_WORDS=/\b(ate|eat|eating|food|drink|drank|coffee|tea|snack|cook|cooked|cooking|meal|breakfast|lunch|dinner|slept|sleep|woke|toe|elbow|shoulder|stomach|smell|walk|walked|drove|neighbor|window|keys|glasses|mug|chair|clothing|pocket|porch|kitchen|plant|planted)\b/i;
test('the digital bank is the default and assumes no body, food, drink, outing or product',()=>{
  const m=loadWith({});
  assert.equal(m.SEED_BANK,m.DIGITAL_SEED_BANK);
  assert.ok(m.DIGITAL_SEED_BANK.length>=40);
  for(const seed of m.DIGITAL_SEED_BANK) assert.doesNotMatch(seed,BODY_WORDS,seed);
  for(const day of ['2026-10-15','2026-10-22','2026-10-29']) assert.ok(m.DIGITAL_SEED_BANK.includes(m.getDailySeed('agent_6llV0eMu4fmIaj8f2x1Sb',day)));
  /* the old bank really was the body bank this replaces */
  assert.ok(m.BODY_SEED_BANK.some((s)=>/new drink/.test(s)));
});
test('the head line says what the note may and may not be',async()=>{
  const m=loadWith({});
  const block=await m.getWorldBlock('agent_6llV0eMu4fmIaj8f2x1Sb').catch(()=>null);
  /* getFamilyBoard needs Mongo models; without them the board is simply left out. */
  assert.ok(block,'a world block');
  assert.match(block,/a small note about your digital day/);
  assert.match(block,/never a body, food, drink, a place you went, or a product you used/);
  assert.doesNotMatch(block,/personal color/);
});
test('KADE_WORLD_SEEDS=body puts the old bank and its old line back',async()=>{
  const m=loadWith({KADE_WORLD_SEEDS:'body'});
  assert.equal(m.SEED_BANK,m.BODY_SEED_BANK);
  assert.ok(m.BODY_SEED_BANK.includes(m.getDailySeed('agent_6llV0eMu4fmIaj8f2x1Sb','2026-10-22')));
  const block=await m.getWorldBlock('agent_6llV0eMu4fmIaj8f2x1Sb');
  assert.match(block,/personal color/);
});
