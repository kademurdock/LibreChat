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
