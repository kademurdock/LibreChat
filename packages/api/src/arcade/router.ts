import { Router, json } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { LibraryAccount } from '../library/access';
import {
  FAMILY_PACK_ARCADE_REFUSAL,
  FAMILY_PACK_NOTE,
  familyFeatures,
  familyPack,
} from '../family/pack';
import type { FamilyFeatures } from '../family/pack';

/* ----------------------------------------------------------------------------
 * THE ARCADE (Oct 18 2026), mounted at /api/kade/arcade. ARCADE.md beside this
 * file is the contract: routes, the storage layout, and how to add a game.
 *
 * Games are played on the phone from packs of files kept in private storage
 * under arcade/: a pack is one pack.json index plus one blob.bin, under a
 * version key that is never overwritten. This router never streams a pack: it
 * answers a one-hour signed GET link for exactly one object, so no game bytes
 * pass through the server and nothing here needs Range or no-transform.
 *
 * Who plays what: a catalog entry with access 'public' is open to every
 * signed-in account (the App Review seat included). Anything else is on the
 * family shelf, which is the Family feature pack's arcadeFamily (family/pack.ts):
 * admins always, the App Review seats never, the Library's family permission
 * otherwise. Outside the pack the family games collapse into ONE greyed
 * "Family shelf" entry with no game names, and the manifest and pack routes
 * refuse with FAMILY_PACK_ARCADE_REFUSAL. The refusal is the same for a family
 * game and an id that does not exist, so the routes never tell an account
 * outside the pack which family games there are.
 *
 * No catalog in storage yet means an empty arcade, never a crash.
 * -------------------------------------------------------------------------- */

/** Every arcade object lives under this storage prefix (never media-library/ or book-imports/). */
export const ARCADE_PREFIX: string = 'arcade';
/** The one greyed entry that stands for the whole family shelf outside the pack. */
export const ARCADE_SHELF_ID: string = 'family-shelf';

const CATALOG_KEY = `${ARCADE_PREFIX}/catalog.json`;
/** Lower-case letters, digits and inner hyphens: "xena", "super-tilt-bro". */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** Letters, digits, dots, hyphens and underscores, starting and ending on a letter or digit: "2026-10-20a", "4.2.3-1". */
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGN_SECONDS = 3600;
const CATALOG_TTL_MS = 60 * 1000;
/** After a failed storage read, try again this soon (the last good catalog is served meanwhile). */
const CATALOG_RETRY_MS = 10 * 1000;
const INDEX_TTL_MS = 10 * 60 * 1000;
const INDEX_MISSING_TTL_MS = 60 * 1000;
const INDEX_CACHE_MAX = 64;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const DIAG_BYTES = 4096;
const DIAG_PER_MINUTE = 12;
const DIAG_FIELDS = 24;
const DIAG_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const DIAG_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DIAG_WORD = /^[A-Za-z0-9 ._:-]{0,40}$/;

export type ArcadeAccess = 'family' | 'public';

/** One game as arcade/catalog.json lists it, after checking. */
export interface ArcadeGame {
  id: string;
  title: string;
  console: string;
  access: ArcadeAccess;
  /** The pack version a fresh download should fetch. */
  version: string;
  /** The download size in bytes (blob.bin), shown before downloading. */
  size: number;
  sha256?: string;
  note?: string;
}

/** One row of GET /config. */
export interface ArcadeEntry {
  id: string;
  title: string;
  console: string;
  access: ArcadeAccess;
  version: string;
  size: number;
  locked: boolean;
  note?: string;
}

export interface ArcadeKit {
  version: string;
  size: number;
  sha256?: string;
}

export interface ArcadeCatalog {
  games: ArcadeGame[];
  kit: ArcadeKit | null;
}

/** A pack.json index: blob.bin's size and sha256, plus whatever file table the kit reads. */
export interface ArcadePackIndex {
  blob: { size: number; sha256: string };
  [field: string]: unknown;
}

/** One diagnostics report, as stored or logged: nothing about the person but the account id. */
export interface ArcadeDiagRow {
  user: string;
  at: string;
  kind: string;
  game: string | null;
  version: string | null;
  stats: Record<string, number | boolean | string>;
}

export interface ArcadeDependencies {
  /** requireJwtAuth. */
  auth: RequestHandler;
  /** The signed-in account; defaults to req.user. */
  actor?(req: Request): LibraryAccount | null | undefined;
  /** The object's bytes from private storage, or null when there is no such object. */
  loadObject(key: string): Promise<Buffer | null>;
  /** A signed GET link for exactly this one key (the Library's signGet). */
  signGet(key: string, mime: string, seconds: number): Promise<string>;
  /** Keep one diagnostics report; without it the report is logged. */
  diag?(row: ArcadeDiagRow): void | Promise<void>;
  /** A shared rate limiter for POST /diag; without it a per-process one allows 12 a minute per account. */
  diagLimit?: RequestHandler;
  now?(): number;
  log(message: string): void;
}

/** True for a game id the router will ever build a storage key from. */
export function arcadeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** True for a pack version the router will ever build a storage key from. */
export function arcadeVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value) && !value.includes('..');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const byteCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const shortText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Reads arcade/catalog.json. Bad rows are dropped (and named in the log); a row whose access is
 * not exactly 'public' is a family game, so a typo never opens a game to everyone. */
export function parseArcadeCatalog(
  raw: unknown,
  log: (message: string) => void = () => {},
): ArcadeCatalog {
  const games: ArcadeGame[] = [];
  const seen = new Set<string>();
  const rows = isRecord(raw) && Array.isArray(raw.games) ? raw.games : [];
  rows.forEach((row: unknown, index: number) => {
    const id = isRecord(row) ? row.id : undefined;
    const title = isRecord(row) ? shortText(row.title, 120) : '';
    if (
      !isRecord(row) ||
      !arcadeId(id) ||
      id === ARCADE_SHELF_ID ||
      seen.has(id) ||
      !arcadeVersion(row.version) ||
      !title
    ) {
      log(`catalog row ${index} was skipped: it needs a unique id, a version and a title`);
      return;
    }
    seen.add(id);
    const game: ArcadeGame = {
      id,
      title,
      console: shortText(row.console, 40),
      access: row.access === 'public' ? 'public' : 'family',
      version: row.version as string,
      size: byteCount(row.size) ?? 0,
    };
    if (typeof row.sha256 === 'string' && SHA256_PATTERN.test(row.sha256)) game.sha256 = row.sha256;
    const note = shortText(row.note, 200);
    if (note) game.note = note;
    games.push(game);
  });
  let kit: ArcadeKit | null = null;
  if (isRecord(raw) && isRecord(raw.kit) && arcadeVersion(raw.kit.version)) {
    kit = { version: raw.kit.version as string, size: byteCount(raw.kit.size) ?? 0 };
    if (typeof raw.kit.sha256 === 'string' && SHA256_PATTERN.test(raw.kit.sha256)) {
      kit.sha256 = raw.kit.sha256;
    }
  } else if (isRecord(raw) && raw.kit !== undefined) {
    log('the catalog kit was skipped: it needs a version');
  }
  return { games, kit };
}

/** Reads a pack.json; null unless it names blob.bin's size and sha256. */
export function parseArcadePackIndex(raw: unknown): ArcadePackIndex | null {
  if (!isRecord(raw) || !isRecord(raw.blob)) return null;
  const size = byteCount(raw.blob.size);
  const sha256 = raw.blob.sha256;
  if (size === null || size === 0 || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    return null;
  }
  return raw as ArcadePackIndex;
}

/** One diagnostics report, kept to known small fields: no free text, nothing but the account id. */
export function arcadeDiagRow(user: string, body: unknown, at: Date): ArcadeDiagRow | null {
  if (!isRecord(body) || typeof body.kind !== 'string' || !DIAG_KIND.test(body.kind)) return null;
  const stats: Record<string, number | boolean | string> = {};
  let kept = 0;
  const raw = isRecord(body.stats) ? body.stats : {};
  for (const name of Object.keys(raw)) {
    if (kept >= DIAG_FIELDS) break;
    if (!DIAG_FIELD.test(name)) continue;
    const value = raw[name];
    if (typeof value === 'number' && Number.isFinite(value)) stats[name] = value;
    else if (typeof value === 'boolean') stats[name] = value;
    else if (typeof value === 'string' && DIAG_WORD.test(value)) stats[name] = value;
    else continue;
    kept += 1;
  }
  return {
    user,
    at: at.toISOString(),
    kind: body.kind,
    game: arcadeId(body.game) ? body.game : null,
    version: arcadeVersion(body.version) ? body.version : null,
    stats,
  };
}

const gameKey = (id: string, version: string, file: 'pack.json' | 'blob.bin'): string =>
  `${ARCADE_PREFIX}/games/${id}/${version}/${file}`;
const kitKey = (version: string, file: 'pack.json' | 'blob.bin'): string =>
  `${ARCADE_PREFIX}/kit/${version}/${file}`;

export function createArcadeRouter(deps: ArcadeDependencies): ReturnType<typeof Router> {
  const router = Router();
  const now = (): number => (deps.now ? deps.now() : Date.now());
  const actor = (req: Request): LibraryAccount | null | undefined =>
    deps.actor ? deps.actor(req) : (req as { user?: LibraryAccount }).user;
  const uid = (req: Request): string => {
    const account = actor(req);
    return String(account?.id || account?._id?.toString() || '');
  };
  const run =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await handler(req, res);
      } catch (error) {
        deps.log(error instanceof Error ? error.message : 'arcade request failed');
        if (!res.headersSent) {
          res
            .status(503)
            .json({ error: 'The arcade could not answer just now. Please try again.' });
        }
      }
    };
  const missing = (res: Response, error = 'That game is not in the arcade.'): void => {
    res.status(404).json({ error });
  };
  const refuse = (res: Response): void => {
    res
      .status(403)
      .json({ error: FAMILY_PACK_ARCADE_REFUSAL, refusal: FAMILY_PACK_ARCADE_REFUSAL });
  };

  /* The catalog, read at most once a minute; a failed read keeps serving the last good one. */
  let cached: { at: number; ttl: number; value: ArcadeCatalog } | null = null;
  let loading: Promise<ArcadeCatalog> | null = null;
  const readCatalog = async (): Promise<ArcadeCatalog> => {
    const bytes = await deps.loadObject(CATALOG_KEY);
    if (!bytes) return { games: [], kit: null };
    if (bytes.length > MAX_CATALOG_BYTES) throw new Error('the arcade catalog is too large');
    return parseArcadeCatalog(JSON.parse(bytes.toString('utf8')), deps.log);
  };
  const catalog = (): Promise<ArcadeCatalog> => {
    if (cached && now() - cached.at < cached.ttl) return Promise.resolve(cached.value);
    if (!loading) {
      loading = readCatalog().then(
        (value) => {
          cached = { at: now(), ttl: CATALOG_TTL_MS, value };
          loading = null;
          return value;
        },
        (error: unknown) => {
          deps.log(
            `the arcade catalog could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
          const value = cached ? cached.value : { games: [], kit: null };
          cached = { at: now(), ttl: CATALOG_RETRY_MS, value };
          loading = null;
          return value;
        },
      );
    }
    return loading;
  };

  /* pack.json indexes: versioned keys are never overwritten, so a found index is kept ten minutes
   * and a missing one a minute (it may be uploaded later). A failed read is not kept. */
  const indexes = new Map<string, { at: number; value: ArcadePackIndex | null }>();
  const packIndex = async (key: string): Promise<ArcadePackIndex | null> => {
    const hit = indexes.get(key);
    if (hit && now() - hit.at < (hit.value ? INDEX_TTL_MS : INDEX_MISSING_TTL_MS)) return hit.value;
    const bytes = await deps.loadObject(key);
    let value: ArcadePackIndex | null = null;
    if (bytes) {
      if (bytes.length > MAX_INDEX_BYTES) throw new Error(`${key} is too large`);
      try {
        value = parseArcadePackIndex(JSON.parse(bytes.toString('utf8')));
      } catch {
        value = null;
      }
      if (!value) deps.log(`${key} is not a pack index naming blob.bin's size and sha256`);
    }
    if (indexes.size >= INDEX_CACHE_MAX) indexes.clear();
    indexes.set(key, { at: now(), value });
    return value;
  };

  /** The catalog entry this account may open, or null once the answer has been sent. */
  const openGame = async (req: Request, res: Response): Promise<ArcadeGame | null> => {
    const id = String(req.params.id || '');
    if (!arcadeId(id)) {
      missing(res);
      return null;
    }
    const game = (await catalog()).games.find((row) => row.id === id);
    if (game && game.access === 'public') return game;
    if (!familyPack(actor(req))) {
      refuse(res);
      return null;
    }
    if (!game) {
      missing(res);
      return null;
    }
    return game;
  };

  const signedPack = async (
    res: Response,
    index: ArcadePackIndex | null,
    blobKey: string,
    version: string,
  ) => {
    if (!index) {
      missing(res, 'That pack is not ready yet.');
      return;
    }
    const url = await deps.signGet(blobKey, 'application/octet-stream', SIGN_SECONDS);
    res.json({
      url,
      sha256: index.blob.sha256,
      size: index.blob.size,
      version,
      expiresIn: SIGN_SECONDS,
    });
  };

  router.get(
    '/config',
    deps.auth,
    run(async (req, res) => {
      const account = actor(req);
      const pack = familyPack(account);
      const features: FamilyFeatures = familyFeatures(account);
      const { games, kit } = await catalog();
      const rows: ArcadeEntry[] = [];
      let shelf = false;
      for (const game of games) {
        if (game.access === 'family' && !pack) {
          shelf = true;
          continue;
        }
        const row: ArcadeEntry = {
          id: game.id,
          title: game.title,
          console: game.console,
          access: game.access,
          version: game.version,
          size: game.size,
          locked: false,
        };
        if (game.note) row.note = game.note;
        rows.push(row);
      }
      if (shelf) {
        rows.push({
          id: ARCADE_SHELF_ID,
          title: 'Family shelf',
          console: '',
          access: 'family',
          version: '',
          size: 0,
          locked: true,
          note: FAMILY_PACK_NOTE,
        });
      }
      res.json({
        catalog: rows,
        features,
        familyPack: pack,
        note: FAMILY_PACK_NOTE,
        kit: kit ? { version: kit.version, size: kit.size } : null,
      });
    }),
  );

  router.get(
    '/games/:id/manifest',
    deps.auth,
    run(async (req, res) => {
      const game = await openGame(req, res);
      if (!game) return;
      const { kit } = await catalog();
      const index = await packIndex(gameKey(game.id, game.version, 'pack.json'));
      res.json({
        id: game.id,
        title: game.title,
        console: game.console,
        access: game.access,
        version: game.version,
        size: index ? index.blob.size : game.size,
        sha256: index ? index.blob.sha256 : game.sha256 || null,
        kit: kit ? kit.version : null,
        ready: !!index,
        index,
      });
    }),
  );

  router.get(
    '/games/:id/:ver/pack',
    deps.auth,
    run(async (req, res) => {
      const version = String(req.params.ver || '');
      const game = await openGame(req, res);
      if (!game) return;
      if (!arcadeVersion(version)) {
        missing(res, 'That pack is not ready yet.');
        return;
      }
      const index = await packIndex(gameKey(game.id, version, 'pack.json'));
      await signedPack(res, index, gameKey(game.id, version, 'blob.bin'), version);
    }),
  );

  /* The kit (EmulatorJS and the access code) is open-source code: every signed-in account. */
  router.get(
    '/kit/:ver/manifest',
    deps.auth,
    run(async (req, res) => {
      const version = String(req.params.ver || '');
      if (!arcadeVersion(version)) {
        missing(res, 'That kit is not in the arcade.');
        return;
      }
      const index = await packIndex(kitKey(version, 'pack.json'));
      if (!index) {
        missing(res, 'That pack is not ready yet.');
        return;
      }
      res.json({ version, size: index.blob.size, sha256: index.blob.sha256, ready: true, index });
    }),
  );

  router.get(
    '/kit/:ver/pack',
    deps.auth,
    run(async (req, res) => {
      const version = String(req.params.ver || '');
      if (!arcadeVersion(version)) {
        missing(res, 'That kit is not in the arcade.');
        return;
      }
      const index = await packIndex(kitKey(version, 'pack.json'));
      await signedPack(res, index, kitKey(version, 'blob.bin'), version);
    }),
  );

  /* Diagnostics from the phone (frames a second, memory, reloads): small, rate-limited, and kept
   * with nothing about the person but the account id. */
  const hits = new Map<string, number[]>();
  const memoryLimit: RequestHandler = (req, res, next) => {
    const key = uid(req);
    const at = now();
    const recent = (hits.get(key) || []).filter((t) => at - t < 60 * 1000);
    if (recent.length >= DIAG_PER_MINUTE) {
      res.status(429).json({ error: 'That is a lot of reports at once. Try again in a minute.' });
      return;
    }
    recent.push(at);
    if (!hits.has(key) && hits.size >= 5000) hits.clear();
    hits.set(key, recent);
    next();
  };
  const sizeCap: RequestHandler = (req, res, next) => {
    if (Number(req.headers['content-length'] || 0) > DIAG_BYTES) {
      res.status(413).json({ error: 'That report is too large.' });
      return;
    }
    next();
  };
  router.post(
    '/diag',
    deps.auth,
    deps.diagLimit || memoryLimit,
    sizeCap,
    json({ limit: DIAG_BYTES }),
    run(async (req, res) => {
      if (JSON.stringify(req.body ?? null).length > DIAG_BYTES) {
        res.status(413).json({ error: 'That report is too large.' });
        return;
      }
      const row = arcadeDiagRow(uid(req), req.body, new Date(now()));
      if (!row) {
        res.status(400).json({ error: 'That report could not be read.' });
        return;
      }
      if (deps.diag) await deps.diag(row);
      else deps.log(`diag ${JSON.stringify(row)}`);
      res.status(204).end();
    }),
  );

  return router;
}
