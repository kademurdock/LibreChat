/** Exact reviewed retained24 addon. Call only inside the existing authorized book response.
 * These immutable supporting archive objects do not replace the one fileKey original.
 */
import { createHash } from 'node:crypto';

export type RetainedNativeMime = 'image/jp2' | 'image/png' | 'text/html';
export interface RetainedNativeBook {
  meta?: Record<string, unknown>;
}
export interface RetainedAccessOriginal {
  sha256: string;
  bytes: number;
  mime: string;
}
export interface RetainedNativeDownload {
  key: string;
  sha256: string;
  bytes: number;
  mime: RetainedNativeMime;
  originalName: string;
}

/** The descriptor is private S3 configuration, not shipped in the public application. */
export const retainedNativeDescriptorSha256 =
  'ceafc85cd20b6772d580d08b60131710c8fdf3776e113dc7eb43ceda669a7a2f';
export const retainedNativeDescriptorKey: string = `library-private-config/${retainedNativeDescriptorSha256}.json`;

export interface RetainedNativeDescriptor {
  cardKey: string;
  sourceKind: string;
  sourceUrl: string;
  originalSourceUrl: string;
  accessFile: RetainedAccessOriginal;
  retainedSourceAccess: unknown;
  marker: RetainedNativeDownload & {
    schemaVersion: number;
    reviewed: boolean;
    registrySha256: string;
    cardKey: string;
  };
  accessDownloadTitle: string;
  nativeDownloadTitle: string;
}

/** The caller supplies the existing private-storage GET only after normal book authorization.
 * No path, descriptor, source URL, parser text or exception is exposed on configuration failure.
 */
export async function loadRetainedNativeDescriptors(
  load?: () => Promise<Uint8Array>,
): Promise<readonly RetainedNativeDescriptor[]> {
  if (!load) return [];
  try {
    const raw = await load();
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 512 * 1024)
      return [];
    if (createHash('sha256').update(raw).digest('hex') !== retainedNativeDescriptorSha256)
      return [];
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.records) ||
      parsed.records.length !== 24
    )
      return [];
    return parsed.records as RetainedNativeDescriptor[];
  } catch {
    return [];
  }
}

/** Strict JSON equality: absence, null, booleans, numbers, and extra keys stay distinct. */
function sameJson(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== typeof expected) return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => sameJson(value, expected[index]))
    );
  }
  if (typeof actual !== 'object' || typeof expected !== 'object') return false;
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(e).length &&
    Object.keys(e).every(
      (key) => Object.prototype.hasOwnProperty.call(a, key) && sameJson(a[key], e[key]),
    )
  );
}

/** Access-file identity and all provenance fields must match the frozen finite entry. */
function recordFor(
  book: RetainedNativeBook,
  access: RetainedAccessOriginal,
  records: readonly RetainedNativeDescriptor[],
) {
  return records.find(
    (row) =>
      access.sha256 === row.accessFile.sha256 &&
      access.bytes === row.accessFile.bytes &&
      access.mime === row.accessFile.mime &&
      book.meta?.sourceKind === row.sourceKind &&
      book.meta?.sourceUrl === row.sourceUrl &&
      book.meta?.originalSourceUrl === row.originalSourceUrl &&
      sameJson(book.meta?.retainedSourceAccess, row.retainedSourceAccess),
  );
}

/** Accurate access labels apply even when the native object's marker is absent or invalid. */
export function retainedAccessDownloadTitle(
  book: RetainedNativeBook,
  access: RetainedAccessOriginal,
  records: readonly RetainedNativeDescriptor[] = [],
): string | null {
  const reviewed = recordFor(book, access, records)?.accessDownloadTitle;
  if (reviewed) return reviewed;
  const provenance = book.meta?.retainedSourceAccess;
  return provenance &&
    typeof provenance === 'object' &&
    !Array.isArray(provenance) &&
    (provenance as Record<string, unknown>).representation === 'derived_access_representation'
    ? 'Download access representation'
    : null;
}

/** A descriptor is installed only after a separately guarded upload and full readback.
 * The finite review data owns every key/hash/name; the marker cannot name arbitrary storage.
 */
export function reviewedRetainedNative(
  book: RetainedNativeBook,
  access: RetainedAccessOriginal,
  records: readonly RetainedNativeDescriptor[] = [],
): RetainedNativeDownload | null {
  const row = recordFor(book, access, records);
  if (!row || !sameJson(book.meta?.retainedNativeOriginal, row.marker)) return null;
  const { key, sha256, bytes, mime, originalName } = row.marker;
  return { key, sha256, bytes, mime: mime as RetainedNativeMime, originalName };
}

/** Returns only a newly signed HTTPS download, never a persisted or source-page URL. */
export async function retainedNativeDownloadSources(
  book: RetainedNativeBook,
  access: RetainedAccessOriginal,
  sign: (key: string, mime: RetainedNativeMime, expiresIn: number, name: string) => Promise<string>,
  onFailure?: () => void,
  records: readonly RetainedNativeDescriptor[] = [],
): Promise<Array<{ title: string; url: string }>> {
  const native = reviewedRetainedNative(book, access, records);
  if (!native) return [];
  try {
    const url = await sign(native.key, native.mime, 12 * 3600, native.originalName);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('Invalid native source link');
    const row = recordFor(book, access, records)!;
    return [{ title: row.nativeDownloadTitle, url }];
  } catch {
    onFailure?.();
    return [];
  }
}
