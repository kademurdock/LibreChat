const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./kadeReadingRoom'),'utf8');
function setup(){
 const handlers={};let length=0,completed=0;const item={_id:'item',tracks:[],save:async()=>{},toObject(){return this}};
 const c={takeUploadBytes:()=>true,pinnedPart:()=>0,router:{post:(path,...a)=>handlers[path]=a.at(-1)},express:{json:()=>()=>{}},requireJwtAuth:()=>{},ownAudio:async()=>item,mimeFor:()=>({mime:'video/mp4',ext:'mp4'}),MAX_TRACK_BYTES:20*1024**3,MULTIPART_ABOVE:150*1024**2,MULTIPART_PART_BYTES:50*1024**2,trackKey:()=> 'media/item/file.mp4',createMultipart:async()=> 'upload',signPart:async(k,u,n)=> 'https://storage/part'+n,signPut:async()=> 'https://storage/whole',MEDIA_PREFIX:()=> 'media',summary:x=>x,headObject:async()=>{if(!length)throw Error('absent');return {ContentLength:length}},completeMultipart:async()=>{completed++;length=200*1024**2},MEDIA_EXT:{mp4:'video/mp4'},VIDEO_EXT:{mp4:true},refreshListen:()=>{},pendingCheck:()=>({}),logger:{error:()=>{},info:()=>{}}};
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

/* Audit SEC-11 (Nov 12 2026): the daily storage allowance and the pinned part lengths. */
test('SEC-11: a daily storage allowance per person; admin exempt; parts are pinned to their declared size', () => {
  const start = source.indexOf("let uploadDay = '';");
  const end = source.indexOf('async function ownAudio(req, id)', start);
  assert.ok(start > 0 && end > start);
  const family = new Set(['fam']);
  const c = {
    isAdmin: (req) => req.user && req.user.role === 'ADMIN',
    require: (name) => {
      assert.equal(name, '@librechat/api');
      return { familyLibraryMember: (u) => family.has(u.id) };
    },
    logger: { warn() {} },
    process: { env: {} },
    Intl, Date, Map, Number, String, Math,
    MULTIPART_PART_BYTES: 50 * 1024 ** 2,
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.take = takeUploadBytes; this.pin = pinnedPart; this.reset = () => { uploadDay = "x"; };', c);
  const GB = 1024 ** 3;
  const admin = { user: { id: 'kade', role: 'ADMIN' } };
  const fam = { user: { id: 'fam' } };
  const guest = { user: { id: 'guest' } };
  assert.equal(c.take(admin, 999 * GB), true);
  assert.equal(c.take(admin, 0), true, 'the admin push tool may send an unsized file');
  assert.equal(c.take(fam, 40 * GB), true);
  assert.equal(c.take(fam, 40 * GB), false);
  assert.equal(c.take(fam, 10 * GB), true);
  assert.equal(c.take(guest, 1 * GB), true);
  assert.equal(c.take(guest, 1.5 * GB), false);
  assert.equal(c.take(guest, 0), false, 'no size, no URL');
  assert.equal(c.take({ user: { id: 'other' } }, 0), false);
  c.reset();
  assert.equal(c.take(guest, 1.5 * GB), true, 'a new day clears the count');
  const MB = 1024 ** 2;
  assert.deepEqual([1, 2, 3, 4].map((i) => c.pin(fam, 200 * MB, i)), [50 * MB, 50 * MB, 50 * MB, 50 * MB]);
  assert.deepEqual([1, 2, 3].map((i) => c.pin(fam, 120 * MB, i)), [50 * MB, 50 * MB, 20 * MB]);
  assert.equal(c.pin(admin, 120 * MB, 1), 0);
  c.process.env.KADE_LIBRARY_PIN_PARTS = '0';
  assert.equal(c.pin(fam, 120 * MB, 1), 0);
});
