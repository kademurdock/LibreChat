const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./kadeReadingRoom'),'utf8');
function setup(){
 const handlers={};let length=0,completed=0;const item={_id:'item',tracks:[],save:async()=>{},toObject(){return this}};
 const c={router:{post:(path,...a)=>handlers[path]=a.at(-1)},express:{json:()=>()=>{}},requireJwtAuth:()=>{},ownAudio:async()=>item,mimeFor:()=>({mime:'video/mp4',ext:'mp4'}),MAX_TRACK_BYTES:20*1024**3,MULTIPART_ABOVE:150*1024**2,MULTIPART_PART_BYTES:50*1024**2,trackKey:()=> 'media/item/file.mp4',createMultipart:async()=> 'upload',signPart:async(k,u,n)=> 'https://storage/part'+n,signPut:async()=> 'https://storage/whole',MEDIA_PREFIX:()=> 'media',summary:x=>x,headObject:async()=>{if(!length)throw Error('absent');return {ContentLength:length}},completeMultipart:async()=>{completed++;length=200*1024**2},MEDIA_EXT:{mp4:'video/mp4'},VIDEO_EXT:{mp4:true},refreshListen:()=>{},logger:{error:()=>{},info:()=>{}}};
 const start=source.indexOf("router.post('/media/:id/track/presign'");const end=source.indexOf("router.post('/media/:id/track/upload'",start);
 vm.runInNewContext(source.slice(start,end),c);
 async function call(path,body){let code=200,result;await handlers[path]({params:{id:'item'},user:{id:'owner'},body},{status(n){code=n;return this},json(x){result=x;return this}});return {code,...result}}
 return {call,item,completed:()=>completed,setLength:n=>length=n};
}
test('large recording negotiates storage multipart; legacy and small uploads keep PUT',async()=>{
 const s=setup();const path='/media/:id/track/presign';
 let r=await s.call(path,{fileName:'video.mp4',bytes:200*1024**2,multipart:true});assert.equal(r.multipart.parts.length,4);assert.equal(r.url,undefined);assert.ok(r.multipart.parts.every(p=>p.url.startsWith('https://storage/')));
 r=await s.call(path,{fileName:'video.mp4',bytes:200*1024**2});assert.equal(r.url,'https://storage/whole');
 r=await s.call(path,{fileName:'video.mp4',bytes:100,multipart:true});assert.equal(r.url,'https://storage/whole');
});
test('completion recovers lost receipt and rejects cross-item keys and incomplete bytes',async()=>{
 const s=setup(),path='/media/:id/track/done';const body={key:'media/item/file.mp4',bytes:200*1024**2,multipart:{uploadId:'upload',parts:[{partNumber:1,etag:'etag'}]}};
 assert.equal((await s.call(path,{...body,key:'media/other/file.mp4'})).code,400);
 assert.equal((await s.call(path,body)).code,200);assert.equal(s.completed(),1);assert.equal(s.item.tracks.length,1);
 assert.equal((await s.call(path,body)).code,200);assert.equal(s.completed(),1);assert.equal(s.item.tracks.length,1);
 const t=setup();t.setLength(body.bytes);assert.equal((await t.call(path,body)).code,200);assert.equal(t.completed(),0);
 const u=setup();u.setLength(7);assert.equal((await u.call(path,{key:body.key,bytes:8})).code,400);assert.equal(u.item.tracks.length,0);
});
