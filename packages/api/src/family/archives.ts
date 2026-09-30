import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { FamilyHistoryAccount, FamilyHistoryDependencies } from './history';
import { familyHistoryCandidate, familyHistoryPrefix, familyHistoryRouter } from './history';
import { libraryReviewSeat, libraryTestSeat } from '../library/access';

/** Private server configuration only. A tree attachment is never inferred from an account name. */
export interface FamilyArchiveMember {
  userId: string;
  /** A checked identity in this archive; omitted means guest, without sensitive findings. */
  personId?: string;
}

export interface FamilyArchiveDefinition {
  id: string;
  title: string;
  prefix: string;
  /** This version uses a verified ADMIN owner; ordinary readers require explicit member entries. */
  ownerUserId: string;
  members: FamilyArchiveMember[];
}

export interface FamilyArchiveOptions {
  /** Read on each request so revocation takes effect without a build. */
  archives?: () => readonly FamilyArchiveDefinition[];
  defaultTitle?: string;
}

const ACCOUNT_ID = /^[a-f\d]{24}$/i;
const ARCHIVE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const PREFIX = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Invalid configuration fails closed for all extra archives; the default archive is unchanged. */
export function familyArchiveDefinitions(
  raw: string | undefined,
  defaultPrefix: string = familyHistoryPrefix(),
): FamilyArchiveDefinition[] {
  if (!raw || !raw.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 20)
    throw new Error('Invalid family archive catalog');
  const ids = new Set(['default']);
  const prefixes = new Set([defaultPrefix]);
  const archives: FamilyArchiveDefinition[] = [];
  for (const value of parsed) {
    const entry = object(value);
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !ARCHIVE_ID.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.title !== 'string' ||
      !entry.title.trim() ||
      entry.title.length > 120 ||
      typeof entry.prefix !== 'string' ||
      !PREFIX.test(entry.prefix) ||
      entry.prefix.length > 160 ||
      Array.from(prefixes).some(
        (prefix) =>
          entry.prefix === prefix ||
          String(entry.prefix).startsWith(prefix + '/') ||
          prefix.startsWith(String(entry.prefix) + '/'),
      ) ||
      typeof entry.ownerUserId !== 'string' ||
      !ACCOUNT_ID.test(entry.ownerUserId) ||
      !Array.isArray(entry.members) ||
      entry.members.length > 200
    )
      throw new Error('Invalid family archive catalog');
    const memberIds = new Set<string>();
    const members: FamilyArchiveMember[] = [];
    for (const value of entry.members) {
      const member = object(value);
      if (
        !member ||
        typeof member.userId !== 'string' ||
        !ACCOUNT_ID.test(member.userId) ||
        memberIds.has(member.userId.toLowerCase()) ||
        (member.personId !== undefined &&
          (typeof member.personId !== 'string' ||
            !member.personId.trim() ||
            member.personId.length > 120))
      )
        throw new Error('Invalid family archive member');
      memberIds.add(member.userId.toLowerCase());
      members.push({
        userId: member.userId.toLowerCase(),
        ...(typeof member.personId === 'string' ? { personId: member.personId } : {}),
      });
    }
    ids.add(entry.id);
    prefixes.add(entry.prefix);
    archives.push({
      id: entry.id,
      title: entry.title.trim(),
      prefix: entry.prefix,
      ownerUserId: entry.ownerUserId.toLowerCase(),
      members,
    });
  }
  return archives;
}

function account(req: Request): FamilyHistoryAccount | undefined {
  return (req as Request & { user?: FamilyHistoryAccount }).user;
}

function allowed(
  user: FamilyHistoryAccount | undefined,
  archive: FamilyArchiveDefinition,
): boolean {
  if (!user || libraryReviewSeat(user) || libraryTestSeat(user)) return false;
  const id = String(user.id || user._id?.toString() || '').toLowerCase();
  return (
    (id === archive.ownerUserId && user.role === 'ADMIN') ||
    archive.members.some((member) => member.userId === id)
  );
}

function projected(
  user: FamilyHistoryAccount,
  archive: FamilyArchiveDefinition,
): FamilyHistoryAccount {
  const id = String(user.id || user._id?.toString() || '').toLowerCase();
  const member = archive.members.find((entry) => entry.userId === id);
  return {
    ...user,
    id,
    role: id === archive.ownerUserId ? user.role : 'USER',
    kadeFamilyTreePerson: member?.personId || undefined,
    kadeFamilyHistory: member?.personId ? undefined : 'guest',
    kadeFamilyHistoryAskedAt: undefined,
  };
}

/** An additive catalog and archive query selector around the existing single-archive router.
 * Every extra tree gets its own storage, view/signing/audio/inbox caches and explicit audience.
 * Its bindings are configuration-owned: legacy account matching cannot overwrite another tree. */
export function familyHistoryArchivesRouter(
  deps: FamilyHistoryDependencies,
  options: FamilyArchiveOptions = {},
): Router {
  const router = Router();
  const noAuth: RequestHandler = (_req, _res, next) => next();
  const defaultRouter = familyHistoryRouter({ ...deps, auth: noAuth });
  let revision = '';
  let definitions: readonly FamilyArchiveDefinition[] = [];
  const scoped = new Map<string, Router>();
  const read = (): readonly FamilyArchiveDefinition[] => {
    try {
      const next = options.archives?.() || [];
      // Revalidate even injected definitions; do not trust a caller to normalize private config.
      const valid = familyArchiveDefinitions(
        JSON.stringify(next),
        deps.prefix || familyHistoryPrefix(),
      );
      const key = JSON.stringify(valid);
      if (key !== revision) {
        revision = key;
        definitions = valid;
        scoped.clear();
      }
      return definitions;
    } catch {
      definitions = [];
      scoped.clear();
      revision = '';
      deps.log?.('Extra family archives are unavailable: invalid private catalog');
      return definitions;
    }
  };
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(deps.auth);
  router.get('/archives', (req, res) => {
    const user = account(req);
    const archives = [
      ...(familyHistoryCandidate(user, deps.ownerUserId?.())
        ? [{ id: 'default', title: options.defaultTitle || 'My family history' }]
        : []),
      ...read()
        .filter((entry) => allowed(user, entry))
        .map((entry) => ({ id: entry.id, title: entry.title })),
    ];
    res.json({ archives, defaultArchive: archives[0]?.id || null });
  });
  router.use((req, res, next) => {
    if (Object.keys(req.query).some((key) => key.startsWith('archive[')))
      return res
        .status(404)
        .json({ error: 'This family archive is not available to this account.' });
    const selected = req.query.archive;
    if (selected === undefined || selected === 'default') return defaultRouter(req, res, next);
    const definition =
      typeof selected === 'string' ? read().find((entry) => entry.id === selected) : undefined;
    const user = account(req);
    if (!definition || !allowed(user, definition) || !user)
      return res
        .status(404)
        .json({ error: 'This family archive is not available to this account.' });
    if (/^\/(?:ask|accounts|match)(?:\/|$)/i.test(req.path))
      return res
        .status(403)
        .json({ error: 'Access to this archive is managed separately by its owner.' });
    let child = scoped.get(definition.id);
    if (!child) {
      child = familyHistoryRouter({
        ...deps,
        auth: noAuth,
        prefix: definition.prefix,
        ownerUserId: () => definition.ownerUserId,
        ownerIsTreePerson: (account, bundle) => account.kadeFamilyTreePerson === bundle.owner,
        sensitiveReadAllowed: () => false,
        findUsers: async () => [],
        setUserFields: async () => {
          throw new Error('Separate archive bindings are managed in private configuration');
        },
      });
      scoped.set(definition.id, child);
    }
    (req as Request & { user?: FamilyHistoryAccount }).user = projected(user, definition);
    child(req, res, (error?: unknown) => {
      (req as Request & { user?: FamilyHistoryAccount }).user = user;
      next(error);
    });
  });
  return router;
}
