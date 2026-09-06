/* node -r <local dependency bootstrap> packages/api/src/reverie/harness.cjs */
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  let checks = 0;
  const check = (ok, label) => { assert.ok(ok, label); checks++; console.log('PASS', label); };
  try {
    const engine = require('../../../../api/app/clients/tools/kademoo/engine');
    const life = require('../../../../api/app/clients/tools/kademoo/life');
    const { MooChar, MooRoom, MooEvent } = require('../../../../api/models/kadeMoo');
    const run = (id, command) => life.runCommand({ userId:id, displayName:id==='party-a'?'Robin Test':'Sam Test',command,live:true });
    for (const id of ['party-a','party-b','party-c']) {
      const ch=await engine.getOrCreateChar(id,id==='party-a'?'Robin Test':id==='party-b'?'Sam Test':'Guest Test');
      await MooChar.updateOne({_id:ch._id},{$set:{roomId:'pats_diner','attrs.life':{created:true,needs:{fed:80,rested:80,clean:80,fun:80,company:80},needsAt:Date.now()}}});
    }
    let r=await run('party-a','hangout host cookout');
    check(r.ok && r.room.hangout.title==='Cookout','host creates a persistent room activity');
    const firstId=r.room.hangout.id;
    check((await run('party-a','hangout host records')).ok===false,'second host cannot replace an active gathering');
    const joined=await Promise.all([run('party-b','hangout join'),run('party-c','hangout join')]);
    check(joined.every(r=>r.ok)&&(await MooRoom.findOne({roomId:'pats_diner'})).props.hangout.guests.length===3,'simultaneous joins preserve both guests');
    check(!(await run('party-b','hangout finish')).ok,'a guest cannot finish someone else’s public gathering');
    const shared=await Promise.all([run('party-a','hangout add I have one coin and a terrible idea.'),run('party-b','hangout add <b>chips</b> & dips')]);
    const room=await MooRoom.findOne({roomId:'pats_diner'});
    check(shared.every(r=>r.ok)&&room.props.hangout.entries.length===2,'simultaneous contributions are both saved');
    check(room.props.hangout.entries.some(e=>e.text==='I have one coin and a terrible idea.'),'a player’s wording is never rewritten by currency edits');
    r=await run('party-b','hangout add <b>chips</b> & dips');
    check(r.ok&&(await MooRoom.findOne({roomId:'pats_diner'})).props.hangout.entries.length===2,'retrying the latest contribution does not duplicate it');
    check(!(await run('party-c','hangout add '+'x'.repeat(401))).ok,'overlong shared text is rejected');
    r=await run('party-a','hangout leave');
    check(r.ok&&(r.room.hangout.summary.startsWith('Sam Test')||r.room.hangout.summary.startsWith('Guest Test')),'leaving passes hosting to another guest');
    const host=(await MooRoom.findOne({roomId:'pats_diner'})).props.hangout.host.userId;
    check((await run(host,'hangout finish')).ok,'the new host can finish');
    r=await run('party-b','hangout memories');
    check(r.lines.join(' ').includes('terrible idea'),'room memories survive finishing');
    await run('party-b','hangout host records');
    check(!(await run('party-c','hangout join @'+firstId)).ok,'stale buttons cannot act on a replacement hangout');
    await MooRoom.create({roomId:'private-home-test',name:'Private test home',district:'patch',props:{home:{owner:'party-a',tenants:[]}}});
    await MooChar.updateOne({userId:'party-b'},{$set:{roomId:'private-home-test'}});
    check(!(await run('party-b','hangout host stories')).ok,'visiting someone’s home does not grant hosting permission');
    await MooChar.updateOne({userId:'party-a'},{$set:{roomId:'private-home-test'}});
    check((await run('party-a','hangout host stories')).ok,'a resident can host at home');
    check(!(await run('party-b','hangout memories')).lines.join(' ').includes('terrible idea'),'another room’s memories do not leak into this one');
    const cast=require('@librechat/api');
    await MooChar.updateOne({userId:'npc:dez'},{$set:{name:'Owner-edited name','attrs.desc':'Owner-written description'}});
    await cast.refreshReverieCast(MooChar);
    check((await MooChar.findOne({userId:'npc:dez'})).name==='Owner-edited name','cast migration preserves owner-authored names');
    r=await run('party-a','money');check(r.ok&&r.lines.join(' ').includes('$'),'wallet uses dollars with the same saved balance');
    await MooChar.updateOne({userId:'party-a'},{$set:{'attrs.coin':50}});
    r=await run('party-a','look');
    const give=r.room.peopleDetail.find(p=>p.id==='party-b').cmds.find(c=>c.label==='Give $5');
    check(give.cmd==='give 5 dollars to Sam Test','the money button targets the full name');
    const before=(await MooChar.findOne({userId:'party-b'})).attrs.coin||0;
    check((await run('party-a',give.cmd)).ok,'the dollars button transfers money');
    check((await run('party-a','give 5 coins to Sam Test')).ok,'saved coin commands remain compatible');
    check((await MooChar.findOne({userId:'party-b'})).attrs.coin===before+10,'both spellings credit the same wallet');
    check(await MooEvent.countDocuments({kind:'hangout'})>=8,'shared actions produce room-stream events');
    console.log('Reverie hangouts:',checks,'checks passed.');
  } finally { await mongoose.disconnect(); await mongo.stop(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
