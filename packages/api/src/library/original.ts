import type { CatalogItem } from './catalog';

type OriginalMime = 'application/pdf' | 'image/jpeg';
type LibraryId = string | { toString(): string };
type Librarian = NonNullable<CatalogItem['librarian']> & { identified?: string };

export interface LibraryOriginal {
  key: string;
  mime: OriginalMime;
  bytes: number;
  sha256: string;
  originalName: string;
}

export interface LibraryOriginalBook {
  _id?: LibraryId;
  fileId?: LibraryId;
  kind?: string;
  state?: string;
  format?: string;
  fileKey?: string;
  fileBytes?: number;
  fileSha256?: string;
  originalName?: string;
  librarian?: Librarian | null;
  meta?: {
    curatedOriginal?: Partial<LibraryOriginal> & { schemaVersion?: number; reviewed?: boolean };
  };
}

const filename = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/;
const mimeOf = (name: string): OriginalMime | null => {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : null;
};

/** A reviewed text edition retains its own original in ordinary file reference accounting. */
export function reviewedLibraryOriginal(book: LibraryOriginalBook): LibraryOriginal | null {
  const original = book.meta?.curatedOriginal;
  if (
    book.kind !== 'text' ||
    book.state !== 'ready' ||
    book.format !== 'curated-source' ||
    !original ||
    original.schemaVersion !== 1 ||
    original.reviewed !== true
  ) {
    return null;
  }
  const id = String(book.fileId || book._id || '');
  if (!/^[a-f\d]{24}$/.test(id)) return null;
  if (typeof original.key !== 'string' || typeof original.originalName !== 'string') return null;
  const prefix = `media-library/${id}/`;
  if (!original.key.startsWith(prefix)) return null;
  const name = original.key.slice(prefix.length);
  if (!filename.test(name) || !filename.test(original.originalName)) return null;
  const mime = mimeOf(name);
  if (!mime || mime !== original.mime || mime !== mimeOf(original.originalName)) return null;
  if (!Number.isSafeInteger(original.bytes) || !original.bytes || original.bytes < 0) return null;
  if (typeof original.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(original.sha256)) return null;
  if (
    original.key !== book.fileKey ||
    original.bytes !== book.fileBytes ||
    original.sha256 !== book.fileSha256 ||
    original.originalName !== book.originalName
  ) {
    return null;
  }
  return {
    key: original.key,
    mime,
    bytes: original.bytes,
    sha256: original.sha256,
    originalName: original.originalName,
  };
}

/** Call only after the normal book access check; signed links are response data, never stored. */
export async function libraryOriginalLibrarian(
  book: LibraryOriginalBook,
  sign: (
    key: string,
    mime: OriginalMime,
    expiresIn: number,
    downloadName: string,
  ) => Promise<string>,
  onFailure?: () => void,
): Promise<Librarian | null> {
  const existing = book.librarian?.state ? book.librarian : null;
  const original = reviewedLibraryOriginal(book);
  if (!original) return existing;
  try {
    const url = await sign(original.key, original.mime, 12 * 3600, original.originalName);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('Invalid original link');
    return {
      ...existing,
      state: 'done',
      sources: [
        ...(existing?.sources || []),
        {
          title:
            original.mime === 'application/pdf'
              ? 'Download original PDF'
              : 'Download original image',
          url,
        },
      ],
    };
  } catch {
    onFailure?.();
    return existing;
  }
}
