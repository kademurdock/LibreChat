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
 * version key that is never overwritten, in the layout the Revival kit's
 * tools/upload_pack.py writes: arcade/public/kit/<ver>/ for the kit and
 * arcade/<family|public>/<id>/<ver>/ for a game (the catalog row's access picks
 * the folder). pack.json is read in the shape tools/packlib.py writes it
 * (blob.bytes; rows with length and type). This router never streams a pack: it
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
 * A catalog row marked grownUpsOnly is absent for a child account, as a
 * grown-ups-only Library book is: not listed, and opened like an id that is
 * not in the catalog.
 *
 * pack.json is never passed through as is: only the blob and a checked file
 * table leave the server, and a kit pack that lists anything under games/ is
 * refused, so no route can name a family game to an account outside the pack.
 *
 * No catalog in storage yet means an empty arcade, never a crash.
 * -------------------------------------------------------------------------- */

/** Every arcade object lives under this storage prefix (never media-library/ or book-imports/). */
export const ARCADE_PREFIX: string = 'arcade';
/** The one greyed entry that stands for the whole family shelf outside the pack. */
export const ARCADE_SHELF_ID: string = 'family-shelf';
/** The kit's pack id in a manifest's `packs`, so no game may use it. */
export const ARCADE_KIT_ID: string = 'kit';

const CATALOG_KEY = `${ARCADE_PREFIX}/catalog.json`;
/** Lower-case letters, digits and inner hyphens: "xena", "super-tilt-bro". */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** Letters, digits, dots, hyphens and underscores, starting and ending on a letter or digit. The
 * kit's versions are YYYYMMDD-<first 8 hex of blob.bin's sha256>: "20261018-27899e08". */
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** One part of a file path inside a pack, up to 255 characters (the kit's cloned-voice clip names
 * are the spoken line, 163 characters in the longest so far): no "." or ".." part, no slash,
 * backslash or colon. */
const PATH_PART = /^[A-Za-z0-9_](?:[A-Za-z0-9 ._,'()+-]{0,253}[A-Za-z0-9._,'()+-])?$/;
/** A B2 key's limit. The phone only looks paths up in the pack's table; it never makes these files. */
const PATH_MAX = 1024;
const PATH_PARTS_MAX = 16;
/** A MIME type, with an optional charset as the kit writes for text: "text/javascript; charset=utf-8". */
const MIME_PATTERN =
  /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,80}(?:; ?charset=[a-z0-9-]{1,20})?$/;
const SIGN_SECONDS = 3600;
const CATALOG_TTL_MS = 60 * 1000;
/** After a failed storage read, try again this soon (the last good catalog is served meanwhile). */
const CATALOG_RETRY_MS = 10 * 1000;
const INDEX_TTL_MS = 10 * 60 * 1000;
const INDEX_MISSING_TTL_MS = 60 * 1000;
/** Found and missing pack.json answers are kept in separate caches of this size, oldest out first. */
const INDEX_CACHE_MAX = 64;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** Manifest and pack requests a minute per account (each new version can cost a storage read). */
const READ_PER_MINUTE = 60;
const DIAG_BYTES = 4096;
/** A report every five seconds is 12 a minute; this leaves room for timer drift and retries. */
const DIAG_PER_MINUTE = 30;

/** The kinds of report POST /diag keeps. */
const DIAG_KINDS: ReadonlySet<string> = new Set([
  'boot',
  'tick',
  'soak',
  'telemetry',
  'mode',
  'audio',
  'saved',
  'download',
  'install',
  'start',
  'pause',
  'resume',
  'exit',
  'reload',
  'terminated',
  'recovered',
  'crash',
  'error',
]);

/** How one stat is checked: a number, a flag, a word from a fixed list, or a fixed pattern. */
type DiagRule = 'number' | 'boolean' | readonly string[] | RegExp;

/** The only stats a report keeps. Names and words are fixed here, so no field can carry free
 * text: a stat with any other name, or a string outside its list, is dropped. */
const DIAG_STATS: ReadonlyMap<string, DiagRule> = new Map<string, DiagRule>([
  /* The kit's soak telemetry (core/telemetry.js, every five seconds). */
  ['loads', 'number'],
  ['uptime', 'number'],
  ['heap', 'number'],
  ['heapMax', 'number'],
  ['fps', 'number'],
  ['fpsMin', 'number'],
  ['frames', 'number'],
  ['opus', 'number'],
  ['flac', 'number'],
  ['clips', 'number'],
  ['clipBytes', 'number'],
  ['contexts', 'number'],
  ['audio', ['running', 'suspended', 'closed', 'interrupted']],
  ['mode', ['menu', 'fight', 'pause']],
  ['core', ['mupen64plus_next', 'parallel_n64']],
  /* The app's own counters (ArcadeTelemetry). */
  ['reloads', 'number'],
  ['terminations', 'number'],
  ['recoveries', 'number'],
  ['touchSends', 'number'],
  ['infoSends', 'number'],
  ['keySends', 'number'],
  ['controllerSends', 'number'],
  ['errors', 'number'],
  ['saves', 'number'],
  ['downloadBytes', 'number'],
  ['downloadMs', 'number'],
  ['latencyMs', 'number'],
  ['input', ['touch', 'keyboard', 'controller']],
  /* The phone. */
  ['battery', 'number'],
  ['lowPower', 'boolean'],
  ['lockdown', 'boolean'],
  ['voiceOver', 'boolean'],
  ['headphones', 'boolean'],
  ['charging', 'boolean'],
  ['vision', 'boolean'],
  ['thermal', ['nominal', 'fair', 'serious', 'critical']],
  ['route', ['speaker', 'receiver', 'wired', 'bluetooth', 'airplay', 'usb', 'carplay', 'other']],
  ['device', /^(?:iPhone|iPad|iPod)\d{1,2},\d{1,2}$/],
  ['os', /^\d{1,2}(?:\.\d{1,2}){0,2}$/],
  ['app', /^\d{1,4}(?:\.\d{1,4}){0,3}$/],
]);

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
  /** Absent for child accounts (only when the catalog says exactly true). */
  grownUpsOnly?: boolean;
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

/** One file inside blob.bin, as the phone serves it. */
export interface ArcadePackFile {
  path: string;
  offset: number;
  size: number;
  mime?: string;
  sha256?: string;
}

/** A checked pack.json: blob.bin's size and sha256 and its file table, nothing else. */
export interface ArcadePackIndex {
  format: number;
  blob: { size: number; sha256: string };
  files: ArcadePackFile[];
  /** The game page inside the pack, when it is not games/<id>/play.html. */
  entry?: string;
  /** EmulatorJS's data folder inside the kit pack (the kit writes emulatorjs/). */
  emulatorData?: string;
}

/** One pack in a manifest's `packs`: what to download, how to check it and where to ask for its link. */
export interface ArcadePackRef {
  kind: 'kit' | 'game';
  id: string;
  version: string;
  size: number;
  sha256: string;
  signPath: string;
  files: ArcadePackFile[];
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
  /** True for a child account (the Library's isChild). Without it nobody is a child. */
  child?(req: Request): boolean | Promise<boolean>;
  /** The object's bytes from private storage, or null when there is no such object. */
  loadObject(key: string): Promise<Buffer | null>;
  /** A signed GET link for exactly this one key (the Library's signGet). */
  signGet(key: string, mime: string, seconds: number): Promise<string>;
  /** Keep one diagnostics report; without it the report is logged. */
  diag?(row: ArcadeDiagRow): void | Promise<void>;
  /** A shared rate limiter for POST /diag; without it a per-process one allows 30 a minute per account. */
  diagLimit?: RequestHandler;
  /** A shared rate limiter for the manifest and pack routes; without it a per-process one allows 60 a minute per account. */
  readLimit?: RequestHandler;
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

/** True for a relative file path inside a pack: "games/xena/play.html", "emulatorjs/loader.js",
 * "games/xena/local/audio/voice/2 of 3.mp3". Never absolute, never a "." or ".." part, never a
 * backslash or colon. */
export function arcadePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > PATH_MAX) return false;
  const parts = value.split('/');
  return parts.length <= PATH_PARTS_MAX && parts.every((part) => PATH_PART.test(part));
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
      id === ARCADE_KIT_ID ||
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
    if (row.grownUpsOnly === true) game.grownUpsOnly = true;
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

/** Reads a pack.json into only the fields the phone needs: blob.bin's size and sha256 and a file
 * table whose every row is a safe relative path inside the blob. Any other field is dropped, and
 * null comes back unless the whole table checks out (one bad row and the pack is not ready).
 * The kit's tools/packlib.py names the blob's size `bytes`, a row's size `length` and its MIME
 * `type`; `blob.size` and a row's `size` and `mime` are read as well, and win when both are there. */
export function parseArcadePackIndex(raw: unknown): ArcadePackIndex | null {
  if (!isRecord(raw) || !isRecord(raw.blob) || !Array.isArray(raw.files)) return null;
  const blobSize = byteCount(raw.blob.size !== undefined ? raw.blob.size : raw.blob.bytes);
  const blobSha = raw.blob.sha256;
  if (blobSize === null || blobSize === 0) return null;
  if (typeof blobSha !== 'string' || !SHA256_PATTERN.test(blobSha)) return null;
  const files: ArcadePackFile[] = [];
  const seen = new Set<string>();
  for (const row of raw.files as unknown[]) {
    if (!isRecord(row) || !arcadePath(row.path) || seen.has(row.path)) return null;
    const offset = byteCount(row.offset);
    const size = byteCount(row.size !== undefined ? row.size : row.length);
    if (offset === null || size === null || offset > blobSize || size > blobSize - offset) {
      return null;
    }
    seen.add(row.path);
    const file: ArcadePackFile = { path: row.path, offset, size };
    const mime = typeof row.mime === 'string' ? row.mime : row.type;
    if (typeof mime === 'string' && MIME_PATTERN.test(mime)) file.mime = mime;
    if (typeof row.sha256 === 'string' && SHA256_PATTERN.test(row.sha256)) file.sha256 = row.sha256;
    files.push(file);
  }
  if (!files.length) return null;
  const index: ArcadePackIndex = {
    format: byteCount(raw.format) || 1,
    blob: { size: blobSize, sha256: blobSha },
    files,
  };
  if (raw.entry !== undefined) {
    if (!arcadePath(raw.entry)) return null;
    index.entry = raw.entry;
  }
  if (raw.emulatorData !== undefined) {
    const folder = typeof raw.emulatorData === 'string' ? raw.emulatorData.replace(/\/$/, '') : '';
    if (!arcadePath(folder)) return null;
    index.emulatorData = `${folder}/`;
  }
  return index;
}

/** One stat kept as is, or undefined when its name or value is not on the list. */
function diagStat(name: string, value: unknown): number | boolean | string | undefined {
  const rule = DIAG_STATS.get(name);
  if (rule === undefined) return undefined;
  if (rule === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (rule === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (rule instanceof RegExp) return rule.test(value) ? value : undefined;
  return rule.includes(value) ? value : undefined;
}

/** One diagnostics report, kept to the listed stats: no free text, nothing but the account id. */
export function arcadeDiagRow(user: string, body: unknown, at: Date): ArcadeDiagRow | null {
  if (!isRecord(body) || typeof body.kind !== 'string' || !DIAG_KINDS.has(body.kind)) return null;
  const stats: Record<string, number | boolean | string> = {};
  const raw = isRecord(body.stats) ? body.stats : {};
  for (const name of Object.keys(raw)) {
    const value = diagStat(name, raw[name]);
    if (value !== undefined) stats[name] = value;
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

/* The keys tools/upload_pack.py writes: arcade/<shelf>/<id>/<version>/, where the shelf is
 * 'public' only for a pack whose shelf is exactly public and 'family' otherwise. A game's folder
 * comes from its catalog access, which must equal its pack's shelf; the kit is always public. */
const gameKey = (
  access: ArcadeAccess,
  id: string,
  version: string,
  file: 'pack.json' | 'blob.bin',
): string =>
  `${ARCADE_PREFIX}/${access === 'public' ? 'public' : 'family'}/${id}/${version}/${file}`;
const kitKey = (version: string, file: 'pack.json' | 'blob.bin'): string =>
  `${ARCADE_PREFIX}/public/${ARCADE_KIT_ID}/${version}/${file}`;

/** Sets a cache entry, dropping the oldest entry first when the cache is full. */
function remember<V>(cache: Map<string, V>, key: string, value: V, max: number): void {
  cache.delete(key);
  if (cache.size >= max) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

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

  /* A per-process limit per account, used when the server passes no shared limiter. */
  const perMinute = (max: number, error: string): RequestHandler => {
    const hits = new Map<string, number[]>();
    return (req, res, next) => {
      const key = uid(req);
      const at = now();
      const recent = (hits.get(key) || []).filter((t) => at - t < 60 * 1000);
      if (recent.length >= max) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(429).json({ error });
        return;
      }
      recent.push(at);
      remember(hits, key, recent, 5000);
      next();
    };
  };
  const readLimit =
    deps.readLimit ||
    perMinute(READ_PER_MINUTE, 'That is a lot of arcade requests at once. Try again in a minute.');
  const diagLimit =
    deps.diagLimit ||
    perMinute(DIAG_PER_MINUTE, 'That is a lot of reports at once. Try again in a minute.');

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

  /* The catalog rows this account may see: a grown-ups-only game is absent for a child. The child
   * check runs only when some row needs it, and a failed check counts as a child. */
  const visibleGames = async (req: Request, games: ArcadeGame[]): Promise<ArcadeGame[]> => {
    if (!deps.child || !games.some((game) => game.grownUpsOnly)) return games;
    let child = true;
    try {
      child = (await deps.child(req)) !== false;
    } catch {
      child = true;
    }
    return child ? games.filter((game) => !game.grownUpsOnly) : games;
  };

  /* pack.json indexes: versioned keys are never overwritten, so a found index is kept ten minutes
   * and a missing one a minute (it may be uploaded later). Found and missing answers live in
   * separate caches that each drop their oldest entry when full, so a flood of made-up versions
   * never pushes out a real index. A failed read is not kept. */
  const found = new Map<string, { at: number; value: ArcadePackIndex }>();
  const absent = new Map<string, number>();
  const packIndex = async (key: string, kit: boolean): Promise<ArcadePackIndex | null> => {
    const hit = found.get(key);
    if (hit && now() - hit.at < INDEX_TTL_MS) return hit.value;
    const miss = absent.get(key);
    if (miss !== undefined && now() - miss < INDEX_MISSING_TTL_MS) return null;
    const bytes = await deps.loadObject(key);
    let value: ArcadePackIndex | null = null;
    if (bytes) {
      if (bytes.length > MAX_INDEX_BYTES) throw new Error(`${key} is too large`);
      try {
        value = parseArcadePackIndex(JSON.parse(bytes.toString('utf8')));
      } catch {
        value = null;
      }
      if (!value) {
        deps.log(
          `${key} is not a usable pack index: it needs blob.bin's size (blob.bytes) and sha256 and a file table of safe relative paths inside the blob`,
        );
      } else if (kit && value.files.some((file) => /^games\//i.test(file.path))) {
        /* The kit is open to every account: a kit that carries game files would hand them out. */
        deps.log(`${key} lists files under games/, so the kit pack is refused`);
        value = null;
      }
    }
    if (value) {
      absent.delete(key);
      remember(found, key, { at: now(), value }, INDEX_CACHE_MAX);
    } else {
      found.delete(key);
      remember(absent, key, now(), INDEX_CACHE_MAX);
    }
    return value;
  };

  /** The catalog entry this account may open, or null once the answer has been sent. */
  const openGame = async (req: Request, res: Response): Promise<ArcadeGame | null> => {
    const id = String(req.params.id || '');
    if (!arcadeId(id)) {
      missing(res);
      return null;
    }
    const games = await visibleGames(req, (await catalog()).games);
    const game = games.find((row) => row.id === id);
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

  const packRef = (
    kind: 'kit' | 'game',
    id: string,
    version: string,
    index: ArcadePackIndex,
    signPath: string,
  ): ArcadePackRef => ({
    kind,
    id,
    version,
    size: index.blob.size,
    sha256: index.blob.sha256,
    signPath,
    files: index.files,
  });
  const kitSignPath = (req: Request, version: string): string =>
    `${req.baseUrl}/kit/${version}/pack`;
  const gameSignPath = (req: Request, id: string, version: string): string =>
    `${req.baseUrl}/games/${id}/${version}/pack`;

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
      const { games: listed, kit } = await catalog();
      const games = await visibleGames(req, listed);
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

  /* The manifest names both packs a game needs, the kit first, each with its file table and the
   * path that signs its link. Until both pack.json files are uploaded and check out, `packs` is
   * empty and `ready` is false, so the phone never installs half a game. */
  router.get(
    '/games/:id/manifest',
    deps.auth,
    readLimit,
    run(async (req, res) => {
      const game = await openGame(req, res);
      if (!game) return;
      const { kit } = await catalog();
      const [gameIndex, kitIndex] = await Promise.all([
        packIndex(gameKey(game.access, game.id, game.version, 'pack.json'), false),
        kit ? packIndex(kitKey(kit.version, 'pack.json'), true) : Promise.resolve(null),
      ]);
      const ready = !!(kit && kitIndex && gameIndex);
      const body: Record<string, unknown> = {
        id: game.id,
        title: game.title,
        console: game.console,
        access: game.access,
        version: game.version,
        ready,
        packs:
          kit && kitIndex && gameIndex
            ? [
                packRef('kit', ARCADE_KIT_ID, kit.version, kitIndex, kitSignPath(req, kit.version)),
                packRef(
                  'game',
                  game.id,
                  game.version,
                  gameIndex,
                  gameSignPath(req, game.id, game.version),
                ),
              ]
            : [],
      };
      if (ready && gameIndex?.entry) body.entry = gameIndex.entry;
      if (ready && kitIndex?.emulatorData) body.emulatorData = kitIndex.emulatorData;
      res.json(body);
    }),
  );

  router.get(
    '/games/:id/:ver/pack',
    deps.auth,
    readLimit,
    run(async (req, res) => {
      const version = String(req.params.ver || '');
      const game = await openGame(req, res);
      if (!game) return;
      if (!arcadeVersion(version)) {
        missing(res, 'That pack is not ready yet.');
        return;
      }
      const index = await packIndex(gameKey(game.access, game.id, version, 'pack.json'), false);
      await signedPack(res, index, gameKey(game.access, game.id, version, 'blob.bin'), version);
    }),
  );

  /* The kit (EmulatorJS and the access code) is open-source code: every signed-in account. */
  router.get(
    '/kit/:ver/manifest',
    deps.auth,
    readLimit,
    run(async (req, res) => {
      const version = String(req.params.ver || '');
      if (!arcadeVersion(version)) {
        missing(res, 'That kit is not in the arcade.');
        return;
      }
      const index = await packIndex(kitKey(version, 'pack.json'), true);
      if (!index) {
        missing(res, 'That pack is not ready yet.');
        return;
      }
      const body: Record<string, unknown> = {
        ...packRef('kit', ARCADE_KIT_ID, version, index, kitSignPath(req, version)),
        ready: true,
      };
      if (index.emulatorData) body.emulatorData = index.emulatorData;
      res.json(body);
    }),
  );

  router.get(
    '/kit/:ver/pack',
    deps.auth,
    readLimit,
    run(async (req, res) => {
      const version = String(req.params.ver || '');
      if (!arcadeVersion(version)) {
        missing(res, 'That kit is not in the arcade.');
        return;
      }
      const index = await packIndex(kitKey(version, 'pack.json'), true);
      await signedPack(res, index, kitKey(version, 'blob.bin'), version);
    }),
  );

  /* Diagnostics from the phone (frames a second, memory, reloads): small, rate-limited, and kept
   * with nothing about the person but the account id. */
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
    diagLimit,
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
