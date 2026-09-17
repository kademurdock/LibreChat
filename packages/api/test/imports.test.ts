import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { bookImportRouter, validateImport, bookImportId } from '../src/library/imports.ts';
const rows = new Map();
function matches(row,filter){return Object.entries(filter).every(([k,v])=> k==='$or'?v.some(f=>matches(row,f)):v&&typeof v==='object'&&!(v instanceof Date)?('$lt'in v?row[k]<v.$lt:'$in'in v?v.$in.includes(row[k]):false):row[k] instanceof Date?row[k].getTime()===v.getTime():row[k]===v)}
function query(value){return {lean:async()=>structuredClone(value),limit(){return this}}}
function update(row,u){Object.assign(row,u.$set||{});for(const k of Object.keys(u.$unset||{}))delete row[k];row.updatedAt=new Date();return row}
const fake={
 findById(id){return query(rows.get(id)||null)},
 findOne(f){return query([...rows.values()].find(r=>matches(r,f))||null)},
 find(f){return query([...rows.values()].filter(r=>matches(r,f)))},
 findOneAndUpdate(f,u,o){let row=[...rows.values()].find(r=>matches(r,f));if(!row&&o.upsert){row={...u.$setOnInsert,createdAt:new Date(),updatedAt:new Date()};if([...rows.values()].some(r=>r.owner===row.owner&&r.slot===row.slot))throw Object.assign(new Error('duplicate'),{code:11000});rows.set(row._id,row)}if(row)update(row,u);return query(row||null)},
 async updateOne(f,u){const row=[...rows.values()].find(r=>matches(r,f));if(row)update(row,u);return {modifiedCount:row?1:0}}
};
mongoose.models.KadeBookImport=fake;
test('limits and recovery identities',()=>{
 assert.equal(validateImport('book.zip',4*1024**3).bytes,4*1024**3);
 for(const [name,n] of [['x.zip',4*1024**3+1],['x.txt',256*1024**2+1],['x.exe',4],['x.txt',0]])assert.throws(()=>validateImport(name,n));
 assert.equal(bookImportId('a','request_1234567890'),bookImportId('a','request_1234567890'));
 assert.notEqual(bookImportId('a','request_1234567890'),bookImportId('b','request_1234567890'));
});
test('HTTP import: asynchronous, owned, recoverable, size checked and idempotent',async()=>{
 let stored=null, imports=0, release;let wait=new Promise(r=>release=r);let existing=null;
 const app=express();app.use(express.json());app.use('/imports',bookImportRouter({auth:(q,s,n)=>n(),actor:q=>({id:q.headers['x-owner']||'owner'}),sign:async()=> 'https://storage.example/book',head:async()=>{if(!stored)throw Error('absent');return {ContentLength:stored.length}},download:async()=>Readable.from([stored]),remove:async()=>{stored=null},existing:async()=>existing,importFile:async(job,path)=>{imports++;await wait;existing={book:{id:job._id}};return existing},log:()=>{}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 async function call(path,body,owner='owner'){const r=await fetch(base+'/imports'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-owner':owner},body:body?JSON.stringify(body):undefined});return {code:r.status,...await r.json()}}
 try{
 const input={requestId:'request_1234567890',fileName:'book.txt',bytes:7,private:true};
 let first=await call('',input);assert.equal(first.uploadRequired,true);assert.equal(first.url,'https://storage.example/book');const id=first.id;
 assert.equal((await call('/'+id,undefined,'other')).code,404);
 assert.equal((await call('',{...input,bytes:8})).code,409);
 assert.equal((await call('/'+id+'/commit',{})).code,503);
 stored=Buffer.from('fixture');assert.equal((await call('',input)).uploadRequired,false);
 assert.equal((await call('/'+id+'/commit',{})).code,202);
 await new Promise(r=>setTimeout(r,30));assert.equal((await call('/'+id)).state,'importing');assert.equal(imports,1);
 await call('/'+id+'/commit',{});assert.equal(imports,1);
 release();for(let i=0;i<50&&(await call('/'+id)).state!=='ready';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await call('',input)).state,'ready');assert.equal((await call('/'+id+'/commit',{})).state,'ready');assert.equal(imports,1);
 // A crash after saving the book is recovered from the deterministic ID.
 const row=rows.get(id);row.state='importing';row.lease=new Date(0);await call('/'+id);
 for(let i=0;i<50&&rows.get(id).state!=='ready';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(rows.get(id).state,'ready');assert.equal(imports,1);
 // A failed job whose staging object disappeared can be uploaded again.
 row.state='failed';const retry=await call('',input);assert.equal(retry.uploadRequired,true);assert.equal(retry.id,id);
 }finally{release();server.close();}
});
