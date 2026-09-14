const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/kadeReadingRoom.js','utf8');
const configs=[];const multer=opts=>{configs.push(opts);return {single(){return (_q,_s,next)=>next()}}};
multer.diskStorage=()=> 'disk';multer.memoryStorage=()=> 'memory';
const context={multer,MAX_UPLOAD_BYTES:4*1024**3,TEXT_IMPORT_LIMIT:256*1024**2};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('const upload = multer'),source.indexOf('const isId =')),context);
assert.equal(configs[0].storage,'disk');assert.equal(configs[1].storage,'memory');assert.equal(configs[1].limits.fileSize,256*1024**2);
let handlers,bytes;
const item={_id:'owned',title:'A recording',tracks:[],async save(){},toObject(){return this}};
Object.assign(context,{router:{post(_p,...h){handlers=h}},requireJwtAuth(){},ownAudio:async()=>item,
 mimeFor:()=>({mime:'audio/mpeg',ext:'mp3',kind:'audio'}),trackKey:()=> 'test',
 putBuffer:async(_k,b)=>{bytes=b},refreshListen(){},summary:b=>b,logger:{info(){},error(){}}
});
const start=source.indexOf("router.post('/media/:id/track/upload'");
vm.runInContext(source.slice(start,source.indexOf("router.post('/media/:id/track/:t/remove'",start)),context);
(async()=>{
 const request={user:{id:'owner'},params:{id:'owned'},body:{},file:{originalname:'one.mp3',buffer:Buffer.from('recording')}};
 const response={code:200,status(n){this.code=n;return this},json(body){this.body=body;return this}};
 await handlers[1](request,response,()=>{});await handlers[2](request,response);
 assert.equal(response.code,200);assert.equal(bytes.toString(),'recording');assert.equal(item.tracks[0].bytes,9);
 console.log('Individual media fallback retains its own 256 MB memory handler and accepts buffered audio without a disk path.');
})().catch(error=>{console.error(error);process.exitCode=1});
