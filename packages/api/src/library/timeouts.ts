import type { Server } from 'node:http';

/** Node's default five-minute request-body deadline cuts off large ZIPs.
 * Keep that deadline for ordinary routes and the existing short header timeout.
 * Authentication, byte limits and concurrent-import limits remain in the route.
 */
export function configureBookUploadTimeouts(server: Server): void {
  const ordinaryTimeout = server.requestTimeout || 300000;
  server.requestTimeout = Math.max(ordinaryTimeout, 2 * 60 * 60 * 1000);
  server.prependListener('request', (request) => {
    if ((request.url || '').split('?')[0] === '/api/kade/reading-room/upload') return;
    const timeout = setTimeout(() => request.destroy(), ordinaryTimeout);
    timeout.unref();
    const clear = (): void => { clearTimeout(timeout); };
    request.once('end', clear);
    request.once('close', clear);
  });
}
