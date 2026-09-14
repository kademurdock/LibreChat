const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/kadeReadingRoom.js', 'utf8');
const start = source.indexOf("router.get('/librarian/inventory'");
const end = source.indexOf("router.get('/librarian/sort-status'", start);
const handlers = {}, calls = [];
const rows = [{_id:'a'}, {_id:'b'}, {_id:'c'}];
const context = {
 router: {get:(path,...args)=>handlers[path]=args.at(-1),post:(path,...args)=>handlers[path]=args.at(-1)},
 requireJwtAuth(){}, isAdmin:r=>r.user.role==='ADMIN', isId:s=>/^[a-f0-9]{24}$/.test(s),
 clampInt:(v,min,max,d)=>Number(v)||d, express:{json:()=>()=>{}}, logger:{warn(){},info(){}},
 KadeBook:{find(query,fields){calls.push({query,fields});return {sort(){return this},limit(){return this},async lean(){return rows.slice()}}},async bulkWrite(ops){calls.push(ops);return {matchedCount:0,modifiedCount:0}}},
 reviewedLibraryMoves:()=>[{updateOne:{filter:{title:'expected'},update:{$set:{path:'Videos/Commercials'}}}}], CATEGORIES:[]
};
vm.runInNewContext(source.slice(start,end),context);
const response=()=>({code:200,status(c){this.code=c;return this},json(body){this.body=body;return this}});
(async()=>{
 for(const path of Object.keys(handlers)){
  const res=response();await handlers[path]({user:{id:'friend',role:'USER'},query:{},body:{}},res);
  assert.equal(res.code,403);assert.equal(calls.length,0);
 }
 let res=response();await handlers['/librarian/inventory']({user:{id:'admin',role:'ADMIN'},query:{limit:2}},res);
 assert.equal(res.body.items.length,2);assert.equal(res.body.next,'b');
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].query)),{state:'ready',$or:[{shared:true},{owner:'admin'}]});
 res=response();await handlers['/librarian/organize']({user:{id:'admin',role:'ADMIN'},body:{moves:[]}},res);
 assert.deepEqual(JSON.parse(JSON.stringify(calls[1][0].updateOne.filter)),{title:'expected',$or:[{shared:true},{owner:'admin'}]});
 assert.equal(res.body.matched,0);assert.equal(res.body.changed,0);
 console.log('Library review route privacy, authorization, pagination and stale-write receipt checks passed.');
})().catch(e=>{console.error(e);process.exit(1)});
