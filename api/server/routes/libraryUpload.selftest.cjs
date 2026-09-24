const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/kadeReadingRoom.js','utf8');
const start=source.indexOf('const activeBookUploads =');
const end=source.indexOf("router.get('/book/:id'",start);
let handlers, closed=0, cleaned=0, removed=[], saved, fail=false, readBuffer=0;
class Book {constructor(data){Object.assign(this,data)} async save(){saved=this} toObject(){return this}}
const context={
 router:{post(_path,...args){handlers=args},use(){}},requireJwtAuth(){}, require, express:{json:()=>()=>{}}, bookImportRouter:()=>()=>{}, headObject(){}, signPut(){},
 upload:{single(){return (_req,_res,next)=>next()}}, logger:{info(){},warn(){},error(){}},
 bookTemp:{async mkdtemp(){return 'scratch'},async rm(){cleaned++},async readFile(){readBuffer++;return Buffer.from('text')}},
 openAudioArchive:async()=>({publication:{title:'',author:'',format:'audio-zip',clips:[{path:'Part 2.mp3',title:'Part 2',clipBegin:0},{path:'Part 10.mp3',title:'Part 10',clipBegin:0}]},bytes:()=>160,stream:async()=>null,close(){closed++}}),
 mongoose:{Types:{ObjectId:class{toString(){return 'test-book'}}}},
 mimeFor:()=>({ext:'mp3',mime:'audio/mpeg'}),trackKey:(_id,ext)=>'key'+removed.length+ext,
 storeAudioStream:async()=>{if(fail)throw Error('storage unavailable')},s3:()=>({}),MEDIA_BUCKET:()=> 'test',
 isAdmin:r=>r.user.role==='ADMIN',canPublish:r=>r.user.role==='ADMIN'||r.user.id==='trusted',KadeBook:Book,refreshListen(){},summary:b=>b,
 deleteKeys:async keys=>{removed.push(...keys)},TEXT_IMPORT_LIMIT:256*1024**2,
};
vm.runInNewContext(source.slice(start,end),context);
function res(){return {code:200,callbacks:{},once(n,fn){this.callbacks[n]=fn},status(n){this.code=n;return this},json(body){this.body=body;return this}}}
async function run(role,privateValue,id=role){
 const request={user:{id,role},body:{private:privateValue,grownUpsOnly:'1'},file:{path:'scratch/book',size:300*1024**2,originalname:'Chaos Raining.zip'}};
 const response=res();await handlers[1](request,response,()=>{});await handlers[2](request,response);response.callbacks.close();return response;
}
(async()=>{
 let response=await run('USER','0');assert.equal(response.code,200);assert.equal(saved.kind,'audio');assert.equal(saved.path,'Audio/Audiobooks');assert.equal(saved.title,'Chaos Raining');assert.equal(saved.shared,false);assert.equal(saved.grownUpsOnly,true);assert.equal(saved.fileBytes,300*1024**2);assert.equal(readBuffer,0);
 response=await run('ADMIN','1');assert.equal(response.body.book.shared,false);
 response=await run('ADMIN','0');assert.equal(response.body.book.shared,true);assert.equal(Object.prototype.toString.call(saved.sharedAt),'[object Date]');
 // Sep 24 2026: a trusted uploader's upload goes straight into the family library unless she keeps it private.
 response=await run('USER','0','trusted');assert.equal(response.body.book.shared,true);assert.equal(Object.prototype.toString.call(saved.sharedAt),'[object Date]');
 response=await run('USER','1','trusted');assert.equal(response.body.book.shared,false);assert.equal(saved.sharedAt,undefined);
 fail=true;response=await run('USER','0');assert.equal(response.code,400);assert(removed.length);assert.equal(closed,6);assert(cleaned>=6);
 console.log('Actual 300 MB upload handler preserves private/public (librarian and trusted uploader) and adult flags, files as audio, skips buffer reads and cleans failed storage/temp files.');
})().catch(error=>{console.error(error);process.exitCode=1});
