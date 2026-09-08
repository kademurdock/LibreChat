import type { RequestHandler } from 'express';

const helpOrigin = 'https://inworld-tts-proxy-production.up.railway.app';
const browserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Only public, authored help pages cross this boundary; no account headers do. */
export const publicHelp: RequestHandler = async (req, res) => {
  const path = req.path.replace(/\/$/, '');
  if (!/^\/help(?:\/[a-z0-9-]+)?$/.test(path)) {
    res.status(404).type('text/plain').send('Help page not found. Visit /help.');
    return;
  }
  try {
    const download = path === '/help/android-download';
    const upstream = await fetch(helpOrigin + (download ? '/Kade-AI.apk' : path), {
      headers: { 'User-Agent': browserAgent, Accept: 'text/html', 'X-Kade-Help-Proxy': '1' },
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
    const expected = download ? 'application/vnd.android.package-archive' : 'text/html';
    if (!upstream.ok || !upstream.headers.get('content-type')?.includes(expected)) {
      throw new Error('Help unavailable');
    }
    if (download) {
      const length = Number(upstream.headers.get('content-length'));
      if (!length || length > 32 * 1024 * 1024) throw new Error('Invalid download size');
      res.set('Content-Disposition', 'attachment; filename="Kade-AI.apk"');
      res.set('Cache-Control', 'public, max-age=60');
      res.type(expected).send(Buffer.from(await upstream.arrayBuffer()));
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
