import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, UploadPartCommand, AbortMultipartUploadCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { storeAudioStream } from './stream';

async function main(): Promise<void> {
  const client = new S3Client({ region:'us-east-1', credentials:{ accessKeyId:'test',secretAccessKey:'test' } });
  let total = 0, largest = 0, aborted = false, complete = false;
  client.middlewareStack.add((() => async (args: { input: { Body?: Buffer; UploadId?: string; MultipartUpload?: object } }) => {
    if (args.input.Body) { total += args.input.Body.length; largest = Math.max(largest,args.input.Body.length); }
    if (args.input.MultipartUpload) complete = true;
    return { response:{}, output:{ $metadata:{}, UploadId:'test-upload', ETag:'test-etag' } };
  }), { step:'initialize',name:'fakeTransport' });
  async function* chunks(): AsyncGenerator<Buffer> { for(let n=0;n<300;n++) yield Buffer.alloc(1024*1024,n%256); }
  const stored = await storeAudioStream(client,'bucket','audio',Readable.from(chunks()),'audio/mpeg');
  assert.equal(total,300*1024**2); assert(largest<=8*1024**2); assert(complete);
  // The hash is taken while the bytes stream (the one-file rule), with no second read.
  const expected = createHash('sha256'); for await (const chunk of chunks()) expected.update(chunk);
  assert.deepEqual(stored, { bytes: 300*1024**2, sha256: expected.digest('hex') });
  const empty = new S3Client({region:'us-east-1',credentials:{accessKeyId:'test',secretAccessKey:'test'}});
  empty.middlewareStack.add((() => async () => ({ response:{}, output:{ $metadata:{}, UploadId:'empty-upload' } })),{step:'initialize',name:'emptyTransport'});
  assert.deepEqual(await storeAudioStream(empty,'bucket','audio',Readable.from([]),'audio/mpeg'), { bytes: 0, sha256: createHash('sha256').digest('hex') });
  const failed = new S3Client({region:'us-east-1',credentials:{accessKeyId:'test',secretAccessKey:'test'}});
  failed.middlewareStack.add(((_next, context) => async () => {
    if(context.commandName===UploadPartCommand.name) throw new Error('storage failed');
    if(context.commandName===AbortMultipartUploadCommand.name) aborted=true;
    assert.notEqual(context.commandName,CompleteMultipartUploadCommand.name);
    return { response:{},output:{$metadata:{},UploadId:'failed-upload'} };
  }),{step:'initialize',name:'failingTransport'});
  const source=Readable.from(chunks());
  await assert.rejects(storeAudioStream(failed,'bucket','audio',source,'audio/mpeg'),/storage failed/);
  assert(aborted); assert(source.destroyed);
  console.log('300 MB transfer uses at most 8 MB per part and returns its SHA-256; storage failure aborts multipart upload and closes source.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
