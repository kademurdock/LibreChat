import { Router } from 'express';
import type { RequestHandler } from 'express';

interface LibraryAccount {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  kadeLibraryAccess?: string;
}

/** Existing family accounts keep access; new registrations do not inherit it. */
export function familyLibraryMember(user: LibraryAccount | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (user.kadeLibraryAccess === 'family') return true;
  if (user.kadeLibraryAccess === 'none') return false;
  const id = user.id || user._id?.toString() || '';
  if (!/^[a-f\d]{24}$/i.test(id)) return false;
  return parseInt(id.slice(0, 8), 16) * 1000 <= Date.parse('2026-09-24T20:32:09Z');
}

export function trustedLibraryContributor(id: string): boolean {
  const ids = (process.env.KADE_LIBRARY_TRUSTED_UPLOADERS ?? '6a5fc5fa351af41332734161')
    .split(',')
    .map((value) => value.trim());
  return ids.includes(id);
}

type MembershipDependencies = {
  auth: RequestHandler;
  admin: RequestHandler;
  users: () => Promise<{ id: string; name: string; member: boolean; admin: boolean }[]>;
  update: (id: string, access: 'family' | 'none') => Promise<boolean>;
  approveUploads: (id: string, apply: boolean) => Promise<{ books: number; submissions: number }>;
};

export function libraryMembershipRouter(deps: MembershipDependencies): Router {
  const router = Router();
  router.use(deps.auth, deps.admin);
  router.post('/approve-uploads', async (req, res) => {
    const { id, apply } = req.body as { id?: string; apply?: boolean };
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id) || !trustedLibraryContributor(id)) {
      res.status(400).json({ error: 'Choose a trusted contributor.' });
      return;
    }
    try {
      res.json({ applied: apply === true, ...(await deps.approveUploads(id, apply === true)) });
    } catch {
      res.status(503).json({ error: 'Could not finish approving uploads. Preview before retrying.' });
    }
  });
  router.get('/', async (_req, res) => {
    try {
      res.json({ users: await deps.users() });
    } catch {
      res.status(503).json({ error: 'Could not read library access.' });
    }
  });
  router.post('/', async (req, res) => {
    const { id, access } = req.body as { id?: string; access?: string };
    if (
      typeof id !== 'string' ||
      !/^[a-f\d]{24}$/i.test(id) ||
      !['family', 'none'].includes(access || '')
    ) {
      res.status(400).json({ error: 'Choose an account and its library access.' });
      return;
    }
    try {
      if (!(await deps.update(id, access as 'family' | 'none'))) {
        res.status(404).json({ error: 'Account not found or it is an administrator.' });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: 'Could not save library access. Refresh before retrying.' });
    }
  });
  return router;
}
