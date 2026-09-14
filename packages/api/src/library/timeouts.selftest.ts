import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { configureBookUploadTimeouts } from './timeouts';

async function main(): Promise<void> {
  const server = http.createServer((request,response) => {
    if (request.url === '/events') { response.writeHead(200,{'Content-Type':'text/event-stream'}); response.write('data: ready\n\n'); return; }
    request.resume();
    if (request.url === '/early') { response.end('rejected'); return; }
    request.on('end',()=>response.end('ok'));
  });
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
    const early=net.connect(address.port,'127.0.0.1');
    early.on('error',()=>{});early.resume();
    await new Promise<void>(resolve=>early.once('connect',resolve));
    early.write('POST /early HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\nConnection: keep-alive\r\n\r\na');
    await new Promise(resolve=>setTimeout(resolve,180));
    const closed=early.destroyed;early.destroy();
    assert(closed,'An early response must not clear an unfinished ordinary request deadline');
    const events=http.get({host:'127.0.0.1',port:address.port,path:'/events'});
    events.on('error',()=>{});
    await new Promise<void>(resolve=>events.once('response',response=>{response.resume();resolve()}));
    await new Promise(resolve=>setTimeout(resolve,180));
    const connected=!events.destroyed;events.destroy();
    assert(connected,'A completed GET request must not end a long-running event response');
    console.log('Slow audiobook request survives; ordinary request retains its short deadline; header timeout unchanged.');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
