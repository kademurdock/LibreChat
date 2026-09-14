import type { RequestHandler } from 'express';

const helpOrigin = 'https://inworld-tts-proxy-production.up.railway.app';
const browserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const downloads = new Map([
  ['/help/android-download', { path: '/Kade-AI.apk', type: 'application/vnd.android.package-archive', name: 'Kade-AI.apk' }],
  ['/help/library-uploader-download', { path: '/Kade-Library-Uploader.exe', type: 'application/octet-stream', name: 'Kade-Library-Uploader.exe' }],
  ['/help/library-uploader-zip', { path: '/Kade-Library-Uploader.zip', type: 'application/zip', name: 'Kade-Library-Uploader.zip' }],
]);

/** Only public, authored help pages cross this boundary; no account headers do. */
export const publicHelp: RequestHandler = async (req, res) => {
  const path = req.path.replace(/\/$/, '');
  if (!/^\/help(?:\/[a-z0-9-]+)?$/.test(path)) {
    res.status(404).type('text/plain').send('Help page not found. Visit /help.');
    return;
  }
  try {
    const download = downloads.get(path);
    const upstream = await fetch(helpOrigin + (download?.path ?? path), {
      headers: { 'User-Agent': browserAgent, Accept: download?.type ?? 'text/html', 'X-Kade-Help-Proxy': '1' },
      redirect: 'error',
      signal: AbortSignal.timeout(download ? 60000 : 12000),
    });
    if (upstream.status === 404) {
      res
        .status(404)
        .type('html')
        .send(
          '<!doctype html><html lang="en"><title>Help page not found — Kade-AI</title><main><h1>Help page not found</h1><p><a href="/help">Search Kade-AI Help</a></p></main></html>',
        );
      return;
    }
    const expected = download?.type ?? 'text/html';
    if (!upstream.ok || !upstream.headers.get('content-type')?.includes(expected)) {
      throw new Error('Help unavailable');
    }
    if (download) {
      const length = Number(upstream.headers.get('content-length'));
      if (!length || length > 32 * 1024 * 1024) throw new Error('Invalid download size');
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length !== length) throw new Error('Incomplete download');
      res.set('Content-Disposition', `attachment; filename="${download.name}"`);
      res.set('Cache-Control', 'public, max-age=60');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type(expected).send(body);
      return;
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.type('html').send(await upstream.text());
  } catch {
    res.set('Cache-Control', 'no-store');
    res
      .status(503)
      .type('html')
      .send(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Help is temporarily unavailable — Kade-AI</title><main><h1>Help is temporarily unavailable</h1><p>Please try again shortly, or contact Kade.</p><p><a href="/home">Return to Kade Home</a></p></main></html>',
      );
  }
};
