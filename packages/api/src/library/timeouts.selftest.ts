import assert from 'node:assert/strict';
import http from 'node:http';
import { configureBookUploadTimeouts } from './timeouts';

async function main(): Promise<void> {
  const server = http.createServer((request,response) => { request.resume(); request.on('end',()=>response.end('ok')); });
  server.requestTimeout=80;
  const headers=server.headersTimeout;
  configureBookUploadTimeouts(server);
  assert.equal(server.headersTimeout,headers);
  assert.equal(server.requestTimeout,7200000);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address && typeof address!=='string');
  try {
    const slow = (path: string): Promise<boolean> => new Promise(resolve=>{
      const request=http.request({host:'127.0.0.1',port:address.port,path,method:'POST',headers:{'Content-Length':'10'}},response=>{
        response.resume();response.on('end',()=>resolve(response.statusCode===200));
      });
      request.on('error',()=>resolve(false));
      request.write('a');
      setTimeout(()=>{if(!request.destroyed)request.end('123456789');},180);
    });
    assert.equal(await slow('/ordinary'),false);
    assert.equal(await slow('/api/kade/reading-room/upload'),true);
    console.log('Slow audiobook request survives; ordinary request retains its short deadline; header timeout unchanged.');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
