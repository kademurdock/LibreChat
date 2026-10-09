import { Router } from 'express';
import type { Request, RequestHandler } from 'express';

interface Ring {
  planId: string;
  ringId: string;
  agentId: string;
  agentName: string;
  purpose: string;
  firedAt: string;
  expiresAt: string;
}

interface Dependencies {
  auth: RequestHandler;
  userId: (request: Request) => string;
  bridgeUrl: string;
  secret: string;
  secretHeader?: 'x-notify-secret' | 'x-bridge-secret';
  request?: typeof fetch;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function cleanRing(value: Ring): Ring | null {
  if (!value || typeof value !== 'object') return null;
  const { planId, ringId, agentId, agentName, purpose, firedAt, expiresAt } = value;
  const fields = [planId, ringId, agentId, agentName, purpose, firedAt, expiresAt];
  if (fields.some((field) => typeof field !== 'string' || field.length > 500)) return null;
  if (!planId || !agentId || ringId !== `${planId}:${firedAt}`) return null;
  if (!Number.isFinite(Date.parse(firedAt)) || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { planId, ringId, agentId, agentName, purpose, firedAt, expiresAt };
}

export function webCallSessionId(value?: string): string | null {
  return typeof value === 'string' && /^web-[a-z0-9]+-[a-z0-9]{1,12}$/.test(value) ? value : null;
}

export function createDesktopCallsRouter(deps: Dependencies): ReturnType<typeof Router> {
  const router = Router();
  const request = deps.request ?? fetch;
  const bridge = async (
    path: string,
    userId: string,
    body?: { enabled: boolean; leaseId: string },
  ) => {
    if (!deps.secret) throw new Error('Incoming calls are not configured.');
    const target = new URL(path, deps.bridgeUrl);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new Error('Incoming calls are not configured.');
    }
    if (!body) target.searchParams.set('userId', userId);
    const response = await request(target, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        [deps.secretHeader ?? 'x-notify-secret']: deps.secret,
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
      },
      ...(body
        ? { body: JSON.stringify({ userId, enabled: body.enabled, leaseId: body.leaseId }) }
        : {}),
    });
    if (!response.ok) throw new Error('Incoming call service is unavailable.');
    return response;
  };

  router.get('/pending', deps.auth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = deps.userId(req);
    if (!userId) {
      res.status(401).json({ error: 'Sign in to receive calls.' });
      return;
    }
    try {
      const response = await bridge('/call-plans/pending', userId);
      const payload = (await response.json()) as { rings?: Ring[] } | null;
      if (!payload || !Array.isArray(payload.rings)) throw new Error('Invalid call response.');
      res.json({ rings: payload.rings.slice(0, 100).map(cleanRing).filter(Boolean) });
    } catch {
      res.status(503).json({ error: 'Incoming calls are temporarily unavailable.' });
    }
  });
  router.post('/presence', deps.auth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = deps.userId(req);
    if (!userId) {
      res.status(401).json({ error: 'Sign in to receive calls.' });
      return;
    }
    const body = req.body as { enabled?: boolean; leaseId?: string } | undefined;
    if (
      typeof body?.enabled !== 'boolean' ||
      typeof body.leaseId !== 'string' ||
      !uuid.test(body.leaseId)
    ) {
      res.status(400).json({ error: 'An enabled setting and UUID leaseId are required.' });
      return;
    }
    try {
      const response = await bridge('/call-presence', userId, {
        enabled: body.enabled,
        leaseId: body.leaseId,
      });
      const payload = (await response.json()) as { ok?: boolean; expiresAt?: string | null } | null;
      if (
        !payload?.ok ||
        (body.enabled &&
          (typeof payload.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(payload.expiresAt))))
      ) {
        throw new Error('Invalid presence response.');
      }
      res.json({ ok: true, expiresAt: body.enabled ? payload.expiresAt : null });
    } catch {
      res.status(503).json({ error: 'Incoming calls are temporarily unavailable.' });
    }
  });
  return router;
}
