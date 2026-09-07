import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch(next);
  };

export function createHarnessRouter(): Router {
  const router = Router();
  const base = process.env.KADE_HARNESS_URL;
  const secret = process.env.KADE_HARNESS_SECRET;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get(
    ['/', '/:runId'],
    handle(async (req, res) => {
      if (!base || !secret) {
        return res.status(503).json({ error: 'Coding job history needs server setup.' });
      }
      const runId = req.params.runId;
      if (runId && !/^r[a-z0-9]{8,40}$/.test(runId)) {
        return res.status(404).json({ error: 'Job not found.' });
      }
      const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
      const endpoint = runId
        ? '/run/status?runId=' + encodeURIComponent(runId)
        : '/jobs?limit=20&offset=' + offset;
      try {
        const response = await fetch(base.replace(/\/$/, '') + endpoint, {
          headers: {
            Authorization: 'Bearer ' + secret,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(25000),
        });
        if (!response.ok) {
          return res.status(response.status === 404 ? 404 : 503).json({
            error:
              response.status === 404
                ? 'No saved record for this exact job.'
                : 'Coding job history is unavailable. Try Refresh.',
          });
        }
        return res.json(await response.json());
      } catch {
        return res.status(503).json({ error: 'Could not check coding jobs. Try Refresh.' });
      }
    }),
  );
  return router;
}
