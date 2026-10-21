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
 * game and an id that does not exist, so /config and the manifest and pack
 * routes never tell an account outside the pack which family games there are.
 * GET /match is the one exception (below): it confirms that a ROM the caller
 * already has is on the family shelf, so it is capped.
 *
 * A catalog row marked grownUpsOnly is absent for a child account, as a
 * grown-ups-only Library book is: not listed, and opened like an id that is
 * not in the catalog.
 *
 * pack.json is never passed through as is: only the blob and a checked file
 * table leave the server, and a kit pack that lists anything under games/ but
 * the plain player's games/_plain/ is refused, so no route can name a family
 * game to an account outside the pack.
 *
 * No catalog in storage yet means an empty arcade, never a crash.
 *
 * ADD A GAME (Oct 19 2026): people add their own ROM files on the phone, which never leave it.
 * GET /match?sha1= takes the ROM's No-Intro sha1 and answers the catalog game whose romSha1 it
 * is, when that game has an accessibility pack (the game pack without the ROM, under its own
 * accessVersion). The pack follows its game's shelf: outside the Family feature pack a family
 * game answers only the locked "Family shelf" row with the pack note and the console, never its
 * id, title or links. That row still confirms that the caller's ROM is on the family shelf, and
 * No-Intro's public lists name every ROM by its sha1, so an account outside the pack hears it for
 * at most MATCH_LOCKED_PER_DAY distinct ROMs a day; past that it hears { match: null }. A
 * grown-ups-only row never matches for a child. /match has its own rate limit, so adding a pile
 * of ROMs never blocks a download, and a catalog that could not be read at all answers 503, never
 * a "no pack" the phone would keep. The match carries no file table: the access pack is fetched
 * like any pack, from its manifest /games/<id>/manifest?version=<accessVersion> (the kit and the
 * access pack with their files, entry, emulatorData and the pack's romPath, where the phone puts
 * the person's own ROM) and its link /games/<id>/<accessVersion>/pack, behind the same gate. A
 * pack served under an accessVersion must be an access pack (accessOnly, romPath inside
 * games/<id>/, no file at romPath), so a match never hands out a pack that carries the ROM, and
 * its blob must be the one the catalog's accessSize and accessSha256 name, so /match never
 * advertises one size while the manifest and link serve another.
 * -------------------------------------------------------------------------- */

/** Every arcade object lives under this storage prefix (never media-library/ or book-imports/). */
export const ARCADE_PREFIX: string = 'arcade';
/** The one greyed entry that stands for the whole family shelf outside the pack. */
export const ARCADE_SHELF_ID: string = 'family-shelf';
/** The kit's pack id in a manifest's `packs`, so no game may use it. */
export const ARCADE_KIT_ID: string = 'kit';
/** The header an app sends to say which arcade it was built for (Oct 21 2026). The iPhone app
 * from build 342 sends "X-Kade-Arcade-Level: 2"; an app that sends none is level 1. A catalog
 * with a `legacy` block serves that older catalog to any app below its `below` level, so a kit
 * or game pack that changed what the app must do never reaches an app that cannot do it. */
export const ARCADE_LEVEL_HEADER: string = 'x-kade-arcade-level';
const ARCADE_LEVEL_MAX = 1000;

const CATALOG_KEY = `${ARCADE_PREFIX}/catalog.json`;
/** Lower-case letters, digits and inner hyphens: "xena", "super-tilt-bro". */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** Letters, digits, dots, hyphens and underscores, starting and ending on a letter or digit. The
 * kit's versions are YYYYMMDD-<first 8 hex of blob.bin's sha256>: "20261018-27899e08". */
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** A ROM's sha1 as No-Intro hashes it (NES without its iNES header, N64 in .z64 byte order). The
 * catalog must write it in lower case; /match takes either case. */
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
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
/** /match requests a minute per account, in a bucket of their own: adding a pile of ROMs at once
 * must never use up the downloads' limit. */
const MATCH_PER_MINUTE = 60;
/** Distinct ROMs a day for which one account outside the Family feature pack may hear the locked
 * "Family shelf" row. A person rarely owns more than a handful of family-shelf ROMs; a list of
 * every N64 sha1 is about a thousand. */
const MATCH_LOCKED_PER_DAY = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A kit file under games/ (in any letter case) that is not the plain player's folder, spelled
 * exactly games/_plain/. No game can own games/_plain/: an id starts with a letter or digit
 * (ID_PATTERN). */
const kitGameFile = (path: string): boolean =>
  /^games\//i.test(path) && !path.startsWith('games/_plain/');
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

/** How one stat is checked: a number, a whole number (a count: 0, 1, 2 and up), a flag, a word
 * from a fixed list, or a fixed pattern. */
type DiagRule = 'number' | 'whole' | 'boolean' | readonly string[] | RegExp;

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
  /* Script time and its highest reading (ms), audio underruns (a count), the audio queue. */
  ['js', 'number'],
  ['jsMax', 'number'],
  ['underruns', 'whole'],
  ['audioQ', 'number'],
  ['audio', ['running', 'suspended', 'closed', 'interrupted']],
  ['mode', ['menu', 'fight', 'pause']],
  /* N64 packs, then the plain player's cores (games/_plain/systems.json): NES, Game Boy and
   * Game Boy Color, Game Boy Advance. */
  ['core', ['mupen64plus_next', 'parallel_n64', 'fceumm', 'gambatte', 'mgba']],
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
  /** The ROM's No-Intro sha1 (40 lower-case hex), which /match looks up. One game with an access
   * pack per sha1. */
  romSha1?: string;
  /** The accessibility pack (the game pack without the ROM): its own version under this game's
   * id and shelf, never the game's version, and its blob.bin's size (above 0) and sha256. The
   * three are kept together or not at all. */
  accessVersion?: string;
  accessSize?: number;
  accessSha256?: string;
}

/** What GET /match answers for a ROM that has an accessibility pack. */
export interface ArcadeMatch {
  id: string;
  title: string;
  console: string;
  access: ArcadeAccess;
  /** The access pack's version ('' when locked). */
  version: string;
  /** The access pack's blob.bin size (0 when locked). */
  size: number;
  /** The access pack's blob.bin sha256: always there when unlocked, never when locked. */
  sha256?: string;
  locked: boolean;
  note?: string;
  /** The access pack's manifest (the kit and the access pack, with romPath): unlocked only. */
  manifestPath?: string;
  /** The access pack's signed link: unlocked only. */
  signPath?: string;
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
  /** The whole catalog an app below level `below` gets instead (the packs it was built for). */
  legacy?: { below: number; catalog: ArcadeCatalog };
}

/** The arcade level an app says it was built for: a whole number from its ARCADE_LEVEL_HEADER,
 * 1 when the header is missing or not a plain number. */
export function arcadeLevel(value: unknown): number {
  /* Node joins a repeated header as "2, 2": the first value counts. */
  const raw = Array.isArray(value) ? value[0] : value;
  const text = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  if (!/^\d{1,4}$/.test(text)) return 1;
  const level = Number(text);
  return level >= 1 && level <= ARCADE_LEVEL_MAX ? level : 1;
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
  /** Where the game page expects the ROM (games/<id>/local/rom.<ext>). The kit's make_pack.py
   * writes it into every game pack; only an access pack's manifest passes it on, as where the
   * phone serves the person's own ROM. */
  romPath?: string;
  /** True only when pack.json says exactly `"accessOnly": true` (make_pack.py --access-only).
   * Server-side only: it is never sent. */
  accessOnly?: boolean;
  /** The kit's plain player page (games/_plain/play.html), kept only when it is a file in the
   * pack. */
  plain?: string;
}

/** The calls of an express-rate-limit store (limiterCache's RedisStore, or the package's own
 * MemoryStore) that the daily cap on locked /match answers uses: counters that expire a window
 * after their first hit. The router calls init with a one-day window. */
export interface ArcadeCounterStore {
  init?(options: { windowMs: number }): void;
  get(key: string): Promise<{ totalHits: number } | undefined> | { totalHits: number } | undefined;
  increment(key: string): Promise<{ totalHits: number }> | { totalHits: number };
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
  /** A shared rate limiter for GET /match alone; without it a per-process one allows 60 a minute per account. */
  matchLimit?: RequestHandler;
  /** Shared counters for the daily cap on locked /match answers; without it a per-process count. */
  matchLockedStore?: ArcadeCounterStore;
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
  nested = false,
): ArcadeCatalog {
  const games: ArcadeGame[] = [];
  const seen = new Set<string>();
  const roms = new Set<string>();
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
    /* Add a game. The accessibility pack counts only whole: a version of its own, a size above 0
     * and a sha256, so an unlocked match always has something to download and check. Anything
     * less drops all three, the log names each bad field, and the game itself stays. */
    if (
      row.accessVersion !== undefined ||
      row.accessSize !== undefined ||
      row.accessSha256 !== undefined
    ) {
      const bad: string[] = [];
      if (row.accessVersion === undefined) bad.push('accessVersion is missing');
      else if (!arcadeVersion(row.accessVersion) || row.accessVersion === row.version) {
        bad.push("accessVersion must be a version of its own, not the game's");
      }
      const accessSize = byteCount(row.accessSize);
      if (!accessSize) bad.push('accessSize must be a whole number of bytes above 0');
      if (typeof row.accessSha256 !== 'string' || !SHA256_PATTERN.test(row.accessSha256)) {
        bad.push('accessSha256 must be 64 lower-case hex digits');
      }
      if (bad.length) {
        log(`catalog row ${index} (${id}): the access pack was dropped: ${bad.join('; ')}`);
      } else {
        game.accessVersion = row.accessVersion as string;
        game.accessSize = accessSize as number;
        game.accessSha256 = row.accessSha256 as string;
      }
    }
    /* The ROM's sha1. One game per ROM, but only a row that keeps an access pack claims it, so a
     * row that can never match never blocks a later one that can. */
    if (row.romSha1 !== undefined) {
      if (typeof row.romSha1 !== 'string' || !SHA1_PATTERN.test(row.romSha1)) {
        log(
          `catalog row ${index} (${id}): romSha1 was dropped: it must be 40 lower-case hex digits`,
        );
      } else if (game.accessVersion && roms.has(row.romSha1)) {
        log(`catalog row ${index} (${id}): romSha1 was dropped: an earlier game has that ROM`);
      } else {
        if (game.accessVersion) roms.add(row.romSha1);
        game.romSha1 = row.romSha1;
      }
    }
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
  const result: ArcadeCatalog = { games, kit };
  /* The older catalog for apps below `below`: read by the same rules, one level deep (a legacy
   * block inside it is ignored). A bad `below` drops the block, so every app gets the main one. */
  if (isRecord(raw) && raw.legacy !== undefined && !nested) {
    const legacy = raw.legacy;
    const below = isRecord(legacy) ? legacy.below : undefined;
    if (
      !isRecord(legacy) ||
      typeof below !== 'number' ||
      !Number.isInteger(below) ||
      below < 2 ||
      below > ARCADE_LEVEL_MAX
    ) {
      log('the catalog legacy block was skipped: it needs "below", a whole number from 2');
    } else {
      result.legacy = {
        below,
        catalog: parseArcadeCatalog(legacy, (message) => log(`legacy: ${message}`), true),
      };
    }
  }
  return result;
}

/** Reads a pack.json into only the fields the phone needs: blob.bin's size and sha256 and a file
 * table whose every row is a safe relative path inside the blob. Any other field is dropped, and
 * null comes back unless the whole table checks out (one bad row and the pack is not ready).
 * The kit's tools/packlib.py names the blob's size `bytes`, a row's size `length` and its MIME
 * `type`; `blob.size` and a row's `size` and `mime` are read as well, and win when both are there.
 * A game pack's `romPath` is kept when it is a safe path (an unsafe one refuses the pack), and
 * `accessOnly` only when it is exactly true; `romSha1` is a build fact like the rest (the catalog
 * row is the source). The kit's `plain` (its plain player page) is kept only when it is a safe
 * path listed in the pack; otherwise it is left out and the app's default holds. */
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
  if (raw.romPath !== undefined) {
    if (!arcadePath(raw.romPath)) return null;
    index.romPath = raw.romPath;
  }
  if (raw.accessOnly === true) index.accessOnly = true;
  if (arcadePath(raw.plain) && seen.has(raw.plain)) index.plain = raw.plain;
  return index;
}

/** One stat kept as is, or undefined when its name or value is not on the list. */
function diagStat(name: string, value: unknown): number | boolean | string | undefined {
  const rule = DIAG_STATS.get(name);
  if (rule === undefined) return undefined;
  if (rule === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (rule === 'whole') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
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
  const matchLimit =
    deps.matchLimit ||
    perMinute(
      MATCH_PER_MINUTE,
      'That is a lot of games to check at once. The rest will be checked in a minute.',
    );

  /* Per-process counters for the locked-answer cap, used when the server passes no shared store:
   * each counter lives a window from its first hit, oldest out first past 50,000. */
  const memoryCounters = (): ArcadeCounterStore => {
    const counts = new Map<string, { at: number; hits: number }>();
    let windowMs = DAY_MS;
    const live = (key: string) => {
      const hit = counts.get(key);
      return hit && now() - hit.at < windowMs ? hit : undefined;
    };
    return {
      init: (options) => {
        windowMs = options.windowMs;
      },
      get: (key) => {
        const hit = live(key);
        return hit ? { totalHits: hit.hits } : undefined;
      },
      increment: (key) => {
        const hit = live(key) || { at: now(), hits: 0 };
        hit.hits += 1;
        remember(counts, key, hit, 50000);
        return { totalHits: hit.hits };
      },
    };
  };
  const lockedStore: ArcadeCounterStore = deps.matchLockedStore || memoryCounters();
  lockedStore.init?.({ windowMs: DAY_MS });
  /* True while this account outside the pack may hear the locked row for this ROM: a ROM it already
   * heard today always may; a new one counts against MATCH_LOCKED_PER_DAY. */
  const lockedAllowed = async (user: string, sha1: string): Promise<boolean> => {
    const heard = `match-locked:${user}:${sha1}`;
    if (Number((await lockedStore.get(heard))?.totalHits) > 0) return true;
    const count = await lockedStore.increment(`match-locked:${user}`);
    if (!(Number(count.totalHits) <= MATCH_LOCKED_PER_DAY)) return false;
    await lockedStore.increment(heard);
    return true;
  };

  /* The catalog, read at most once a minute; a failed read keeps serving the last good one.
   * catalogOk stays false until one read succeeds (a missing catalog.json is a success: an empty
   * arcade), so /match can tell "no such pack" from "storage could not answer". */
  let cached: { at: number; ttl: number; value: ArcadeCatalog } | null = null;
  let loading: Promise<ArcadeCatalog> | null = null;
  let catalogOk = false;
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
          catalogOk = true;
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
  /* The catalog this app was built for: the legacy block's for an app below its level, else the
   * main one. Every route reads the catalog through this, so an older app's list, manifests,
   * matches and pack links all agree with each other. */
  const catalogFor = async (req: Request): Promise<ArcadeCatalog> => {
    const main = await catalog();
    const legacy = main.legacy;
    return legacy && arcadeLevel(req.headers[ARCADE_LEVEL_HEADER]) < legacy.below
      ? legacy.catalog
      : main;
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
      } else if (kit && value.files.some((file) => kitGameFile(file.path))) {
        /* The kit is open to every account: a kit that carries game files would hand them out.
         * The plain player (games/_plain/, no game's folder) is the kit's own. */
        deps.log(
          `${key} lists game files under games/ (only games/_plain/ is allowed), so the kit pack is refused`,
        );
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

  /* A game's pack.json for one version, checked against what that version is for. Under the
   * game's accessVersion it must be an access pack: pack.json says accessOnly, its romPath lies
   * inside games/<id>/, and no file sits at romPath, so a match never hands out a pack that
   * carries the ROM (an accessVersion naming an older full upload, say). Its blob's size and
   * sha256 must also be the catalog's accessSize and accessSha256, which /match advertises: a
   * catalog edited by hand never shows one pack and serves another. Under the game's own
   * version it must not be one, so the shelf never installs a game without its ROM. Any other
   * version (an older upload a resumed download finishes) is read as is. */
  const gamePack = async (game: ArcadeGame, version: string): Promise<ArcadePackIndex | null> => {
    const key = gameKey(game.access, game.id, version, 'pack.json');
    const index = await packIndex(key, false);
    if (!index) return null;
    if (version === game.accessVersion) {
      const romPath = index.romPath;
      if (
        index.accessOnly !== true ||
        !romPath ||
        !romPath.startsWith(`games/${game.id}/`) ||
        index.files.some((file) => file.path === romPath)
      ) {
        deps.log(
          `${key} is not an access pack: it needs "accessOnly": true, a romPath under games/${game.id}/ and no file at that path`,
        );
        return null;
      }
      if (index.blob.size !== game.accessSize || index.blob.sha256 !== game.accessSha256) {
        deps.log(
          `${key} does not match the catalog: its blob (blob.bytes, blob.sha256) must be the game's accessSize and accessSha256, so the access pack is not ready`,
        );
        return null;
      }
    } else if (version === game.version && index.accessOnly) {
      deps.log(`${key} is an access pack (no ROM), so it cannot be the game's own version`);
      return null;
    }
    return index;
  };

  /** The catalog entry this account may open, or null once the answer has been sent. */
  const openGame = async (req: Request, res: Response): Promise<ArcadeGame | null> => {
    const id = String(req.params.id || '');
    if (!arcadeId(id)) {
      missing(res);
      return null;
    }
    const games = await visibleGames(req, (await catalogFor(req)).games);
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
      const { games: listed, kit } = await catalogFor(req);
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
   * empty and `ready` is false, so the phone never installs half a game. `?version=` may name the
   * game's accessVersion (Add a game: the accessibility pack for a ROM the person brings) or its
   * own version; only the access manifest carries the pack's `romPath`. A well-formed version
   * that is neither (a stored manifestPath whose access pack was since replaced) has its own 404,
   * so the phone asks /match again instead of waiting for a pack that will never be ready. */
  router.get(
    '/games/:id/manifest',
    deps.auth,
    readLimit,
    run(async (req, res) => {
      const game = await openGame(req, res);
      if (!game) return;
      const asked = req.query.version;
      let version = game.version;
      if (asked !== undefined) {
        if (typeof asked !== 'string' || !arcadeVersion(asked)) {
          missing(res, 'That pack is not ready yet.');
          return;
        }
        if (asked !== game.version && asked !== game.accessVersion) {
          missing(res, 'That accessibility pack has changed. Check the game again.');
          return;
        }
        version = asked;
      }
      const access = version === game.accessVersion;
      const { kit } = await catalogFor(req);
      const [gameIndex, kitIndex] = await Promise.all([
        gamePack(game, version),
        kit ? packIndex(kitKey(kit.version, 'pack.json'), true) : Promise.resolve(null),
      ]);
      const ready = !!(kit && kitIndex && gameIndex);
      const body: Record<string, unknown> = {
        id: game.id,
        title: game.title,
        console: game.console,
        access: game.access,
        version,
        ready,
        packs:
          kit && kitIndex && gameIndex
            ? [
                packRef('kit', ARCADE_KIT_ID, kit.version, kitIndex, kitSignPath(req, kit.version)),
                packRef('game', game.id, version, gameIndex, gameSignPath(req, game.id, version)),
              ]
            : [],
      };
      if (ready && gameIndex?.entry) body.entry = gameIndex.entry;
      if (ready && kitIndex?.emulatorData) body.emulatorData = kitIndex.emulatorData;
      if (ready && access && gameIndex?.romPath) body.romPath = gameIndex.romPath;
      res.json(body);
    }),
  );

  /* Add a game: the phone sends the No-Intro sha1 of a ROM the person added (the ROM itself never
   * leaves the phone) and hears whether an accessibility pack exists for it. Only rows with both a
   * romSha1 and an access pack match, after the child rule. A family game matched by an account
   * outside the pack answers the locked shelf row: the pack note and the console, no id, title,
   * version, size, hash or links. The row still says the caller's ROM is on the family shelf, so
   * an account outside the pack hears it for at most MATCH_LOCKED_PER_DAY distinct ROMs a day and
   * { match: null } after that (a real person never hears an error for it). Until the catalog has
   * been read once, a failed read answers 503, never a "no pack" the phone would keep. The answer
   * has no file table: the phone fetches manifestPath for the packs, files and romPath. */
  router.get(
    '/match',
    deps.auth,
    matchLimit,
    run(async (req, res) => {
      const raw = req.query.sha1;
      const sha1 = typeof raw === 'string' ? raw.toLowerCase() : '';
      if (!SHA1_PATTERN.test(sha1)) {
        res.status(400).json({ error: "That is not a ROM's sha1 (40 hex digits)." });
        return;
      }
      const { games: listed } = await catalogFor(req);
      if (!catalogOk) {
        res.status(503).json({ error: 'The arcade could not answer just now. Please try again.' });
        return;
      }
      const games = await visibleGames(req, listed);
      const game = games.find((row) => row.romSha1 === sha1 && row.accessVersion);
      if (!game || !game.accessVersion || !game.accessSize || !game.accessSha256) {
        res.json({ match: null });
        return;
      }
      if (game.access !== 'public' && !familyPack(actor(req))) {
        if (!(await lockedAllowed(uid(req), sha1))) {
          res.json({ match: null });
          return;
        }
        const locked: ArcadeMatch = {
          id: ARCADE_SHELF_ID,
          title: 'Family shelf',
          console: game.console,
          access: 'family',
          version: '',
          size: 0,
          locked: true,
          note: FAMILY_PACK_NOTE,
        };
        res.json({ match: locked });
        return;
      }
      const match: ArcadeMatch = {
        id: game.id,
        title: game.title,
        console: game.console,
        access: game.access,
        version: game.accessVersion,
        size: game.accessSize,
        sha256: game.accessSha256,
        locked: false,
        ...(game.note ? { note: game.note } : {}),
        manifestPath: `${req.baseUrl}/games/${game.id}/manifest?version=${game.accessVersion}`,
        signPath: gameSignPath(req, game.id, game.accessVersion),
      };
      res.json({ match });
    }),
  );

  /* Any uploaded version of a game signs behind the game's gate: the catalog version, an older
   * one (a resumed download can finish after the catalog moves on), and the accessVersion, whose
   * pack lives under the same id and shelf. The catalog and access versions are checked as in the
   * manifest (gamePack). */
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
      const index = await gamePack(game, version);
      await signedPack(res, index, gameKey(game.access, game.id, version, 'blob.bin'), version);
    }),
  );

  /* The kit (EmulatorJS, the access code and the plain player) is open-source code: every
   * signed-in account. Its manifest passes on the plain player page (`plain`) when the kit names
   * one. */
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
      if (index.plain) body.plain = index.plain;
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
