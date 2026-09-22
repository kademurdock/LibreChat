const assert = require('node:assert/strict');
const express = require('express');
const { descriptionOperations, fillLibraryDescriptions, descriptionBatchRouter } = require('../.description-tests/descriptions.js');
const owner = 'a'.repeat(24), other = 'b'.repeat(24);
const id = n => n.toString(16).padStart(24, '0');
const rows = new Map([
  [id(1), { owner, state:'ready', kind:'video', description:'' }],
  [id(2), { owner, state:'ready', kind:'audio', description:'My notes' }],
  [id(3), { owner:other, state:'ready', kind:'video', description:'' }],
  [id(4), { owner, state:'pending', kind:'video', description:'' }],
  [id(5), { owner, state:'ready', kind:'text', description:'' }],
  [id(6), { owner, state:'ready', kind:'audio', description:' \n' }],
]);
let failRead = false;
const deps = {
  write: async ops => { for (const { updateOne: op } of ops) {
    assert.equal(op.filter.owner, owner);
    assert.deepEqual(op.filter.$or, [{description:{$exists:false}},{description:null},{description:{$regex:'^\\s*$'}}]);
    assert.deepEqual(Object.keys(op.update.$set), ['description']);
    const r = rows.get(op.filter._id);
    if (r && r.owner===owner && r.state==='ready' && ['audio','video'].includes(r.kind) && !r.description?.trim()) r.description = op.update.$set.description;
  } },
  read: async filter => {
    if (failRead) { failRead=false; throw Error('response lost'); }
    assert.equal(filter.owner, owner);
    return [...rows].filter(([i,r])=>filter._id.$in.includes(i)&&r.owner===owner&&r.state==='ready'&&['audio','video'].includes(r.kind)).map(([i,r])=>({_id:i,description:r.description}));
  },
};
(async()=>{
  for (const entries of [[],Array(201).fill({id:id(1),description:'x'}),[{id:id(1),description:' '}],[{id:id(1),description:'x'.repeat(2001)}],[{id:id(1),description:'x'},{id:id(1),description:'y'}]]) assert.throws(()=>descriptionOperations(entries,owner));
  const entries = [1,2,3,4,5,6].map(n=>({id:id(n),description:'Source '+n}));
  failRead=true;
  await assert.rejects(fillLibraryDescriptions(entries,owner,deps));
  const result=await fillLibraryDescriptions(entries,owner,deps);
  assert.deepEqual(result.map(r=>r.status),['confirmed','preserved','unavailable','unavailable','unavailable','confirmed']);
  assert.equal(rows.get(id(2)).description,'My notes');
  assert.equal(rows.get(id(3)).description,'');
  const app=express();
  app.use('/archive/descriptions',descriptionBatchRouter({...deps,auth:(req,res,next)=>req.headers.authorization==='test'?next():res.sendStatus(401),owner:()=>owner}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
    const base='http://127.0.0.1:'+server.address().port+'/archive/descriptions';
    assert.equal((await fetch(base+'/capabilities')).status,401);
    const cap=await fetch(base+'/capabilities',{headers:{authorization:'test'}});assert.equal((await cap.json()).maxItems,200);
    const response=await fetch(base,{method:'POST',headers:{authorization:'test','content-type':'application/json'},body:JSON.stringify({items:entries,owner:other})});
    assert.equal(response.status,200);assert.equal((await response.json()).items[2].status,'unavailable');
    const invalid=await fetch(base,{method:'POST',headers:{authorization:'test','content-type':'application/json'},body:JSON.stringify({items:[]})});assert.equal(invalid.status,400);
    console.log('Description batch: validation, ownership, existing notes, text/pending exclusion, readback, lost-response replay and authenticated HTTP routes passed.');
  } finally { server.closeAllConnections();server.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
