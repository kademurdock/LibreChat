import { Router } from 'express';
import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';

/* ----------------------------------------------------------------------------
 * FAMILY LIBRARY ACCESS (Sep 24 2026)
 *
 * Her words: "Right now I want people to have access to all the public library
 * shelves because it's like, all family on this app. But if I ever let strange
 * people make accounts, I wouldn't want them having access to my library media.
 * Since even the librarian is a public agent with a dedicated button, she would
 * even have to be informed that the public files in the library are
 * subscription only, basically family only in technical terms."
 *
 * So the shared collection is a per-account permission, `kadeLibraryAccess`:
 *   - admins always have it;
 *   - the App Review / screenshot seat never has it (Part 288 verified its
 *     shared and filed counts at 0/0; KADE_LIBRARY_HIDDEN_FROM keeps working);
 *   - 'family' or 'none', once Kade sets it, is final;
 *   - otherwise accounts that existed when this shipped keep access, test seats
 *     do not, and every account made later waits for Kade's yes.
 * A restricted account keeps full use of its own uploads everywhere. Child
 * accounts keep their grown-ups-only rules on top, and nothing here tells a
 * child it is filtered.
 * -------------------------------------------------------------------------- */

export interface LibraryAccount {
  id?: string;
  _id?: { toString(): string };
  email?: string;
  role?: string;
  kadeLibraryAccess?: string;
  name?: string;
  username?: string;
}

/** Every family account on the platform was made before this moment (the Sep 24 account list's
 * newest is Sep 21); accounts made after it do not inherit the family collection. */
export const FAMILY_LIBRARY_CUTOFF: string = '2026-09-24T20:32:09Z';

/** The App Store review and screenshot seat ("Visibility Test", vischeck). It must keep seeing an
 * empty family library whatever else changes, so no grant reaches it. */
const REVIEW_SEAT = '6a6125d73939d20b95251078';

/** Test seats by id: tester (evalclean), Party Test (evalfixture) and the review seat, the ids
 * kadeNudges keeps away from real notifications. Kade can still grant one deliberately. */
const TEST_SEATS = [REVIEW_SEAT, '6a572e3be680dcdaadca0f04', '6a69074cc74d975de21f5b2a'];

/** Test seats known only by their account name (Kade's notes call it "Test Guest"; no one has
 * confirmed its id, and a wrong id would quietly shut a real family member out). */
const TEST_SEAT_NAMES = ['testguest'];

function seatName(value: string | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

const OBJECT_ID = /^[a-f\d]{24}$/i;

function accountId(user: LibraryAccount): string {
  return String(user.id || user._id?.toString() || '').toLowerCase();
}

function listFromEnv(value: string | undefined): string[] {
  return String(value || '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Accounts that must always see an empty family library: the review seat and anything named in
 * KADE_LIBRARY_HIDDEN_FROM (emails or ids; default the vischeck seat's email). */
export function libraryReviewSeat(user: LibraryAccount | null | undefined): boolean {
  if (!user) return false;
  const hidden = listFromEnv(process.env.KADE_LIBRARY_HIDDEN_FROM || 'kadeai.vischeck722@gmail.com');
  const id = accountId(user);
  const email = String(user.email || '').toLowerCase();
  return id === REVIEW_SEAT || (!!id && hidden.includes(id)) || (!!email && hidden.includes(email));
}

export function libraryTestSeat(user: LibraryAccount | null | undefined): boolean {
  if (!user) return false;
  const id = accountId(user);
  return (
    TEST_SEATS.includes(id) ||
    listFromEnv(process.env.NOTIFY_TEST_USER_IDS).includes(id) ||
    TEST_SEAT_NAMES.includes(seatName(user.name)) ||
    TEST_SEAT_NAMES.includes(seatName(user.username))
  );
}

function createdBeforeCutoff(id: string): boolean {
  if (!OBJECT_ID.test(id)) return false;
  return parseInt(id.slice(0, 8), 16) * 1000 <= Date.parse(FAMILY_LIBRARY_CUTOFF);
}

/** Can this account see the shared family collection? */
export function familyLibraryMember(user: LibraryAccount | null | undefined): boolean {
  if (!user) return false;
  if (libraryReviewSeat(user)) return false;
  if (user.role === 'ADMIN') return true;
  if (user.kadeLibraryAccess === 'family') return true;
  if (user.kadeLibraryAccess === 'none') return false;
  if (libraryTestSeat(user)) return false;
  return createdBeforeCutoff(accountId(user));
}

/** Uploaders whose items go straight into the family library, no approval step. Her words:
 * "Automatically approve anything Amber A uploads to the library, including books she just
 * uploaded." Amber A is 6a5fc5fa351af41332734161 (not Amber Lacey). */
export function trustedLibraryContributor(id: string): boolean {
  const ids = (process.env.KADE_LIBRARY_TRUSTED_UPLOADERS ?? '6a5fc5fa351af41332734161')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ids.includes(String(id || '').toLowerCase());
}

/** Added to every kade_library result for an account without family access, in words the
 * librarian can say as they are. It names no age rule, so it is safe for any account. */
export const familyLibraryAccessNote: string =
  "This account does not have family library access, so these results include only this person's own uploads. " +
  "The family's shared collection is only for family members the library owner, Kade, has approved, and only Kade can turn it on for an account. " +
  'If they are looking for something that is not among their own uploads, tell them that plainly. Do not say the library does not have it, and do not say the catalog failed.';

/** Replaces the "try other words" advice when a restricted search comes back empty: more
 * searching cannot reach the shared collection. */
export const familyLibraryEmptyGuidance: string =
  "Nothing matched among this person's own uploads. The shared collection is closed to this account, so more searches will not find it there. " +
  "Explain that the family collection needs Kade's approval for their account; this is not proof the library lacks the item.";

/** For the App Review and screenshot seat instead of the two notes above: it keeps Part 288's
 * silent empty shelf, so a reviewer is never told that a collection exists it cannot open. */
export const ownUploadsOnlyNote: string =
  "This account's library holds only its own uploads. If they look for something that is not among them, say it is not in their library yet. " +
  'Do not say the catalog failed.';

/* ── the owner's view ─────────────────────────────────────────────────── */

export type LibraryAccountRow = LibraryAccount;

export interface LibraryAccountView {
  id: string;
  name: string;
  member: boolean;
  /** One plain sentence a screen reader says after the name. */
  status: string;
  /** False for administrators and the review seat, whose access is fixed. */
  changeable: boolean;
  trusted: boolean;
}

export function familyLibraryAccountView(user: LibraryAccountRow): LibraryAccountView {
  const id = accountId(user);
  const member = familyLibraryMember(user);
  const trusted = trustedLibraryContributor(id);
  let status: string;
  let changeable = true;
  if (libraryReviewSeat(user)) {
    status = 'App Review and screenshot account. Always kept out of the family library.';
    changeable = false;
  } else if (user.role === 'ADMIN') {
    status = 'Library owner. Always has family access.';
    changeable = false;
  } else if (user.kadeLibraryAccess === 'family') {
    status = 'Has family access. You turned it on.';
  } else if (user.kadeLibraryAccess === 'none') {
    status = 'No family access. You turned it off.';
  } else if (libraryTestSeat(user)) {
    status = 'No family access. Test account.';
  } else if (member) {
    status = 'Has family access. Existing family account.';
  } else {
    status = 'No family access yet. New account.';
  }
  if (trusted && member) status += ' Trusted uploader: uploads go straight into the family library.';
  return {
    id,
    name: String(user.name || user.username || 'Unnamed account').trim(),
    member,
    status,
    changeable,
    trusted,
  };
}

/* ── the approval digest ─────────────────────────────────────────────── */

export interface LibraryDigestEntry {
  name: string;
  books: number;
  recordings: number;
  videos: number;
  links: number;
  reports: number;
}

const count = (n: number, word: string): string => (n > 0 ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
const spoken = (parts: string[]): string =>
  parts.length < 2 ? parts[0] || '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/** One chat note for everything waiting on the owner, never one per item. Her report of the
 * flood: every Amber upload queued its own note, and both librarian replies opened with the pile. */
export function libraryDigestText(entries: LibraryDigestEntry[]): string {
  const total = (e: LibraryDigestEntry) => e.books + e.recordings + e.videos + e.links + e.reports;
  const ordered = entries.filter((e) => total(e) > 0).sort((a, b) => total(b) - total(a));
  const sentences: string[] = [];
  for (const entry of ordered.slice(0, 4)) {
    const name = String(entry.name || '').trim() || 'Someone';
    const files = [count(entry.books, 'book'), count(entry.recordings, 'recording'), count(entry.videos, 'video')].filter(Boolean);
    const did: string[] = [];
    if (files.length) did.push(`uploaded ${spoken(files)}`);
    if (entry.links > 0) did.push(`suggested ${count(entry.links, 'link')}`);
    if (entry.reports > 0) did.push(`reported ${count(entry.reports, 'item')} on the wrong shelf`);
    sentences.push(`${name} ${spoken(did)}.`);
  }
  const rest = ordered.slice(4).reduce((n, e) => n + total(e), 0);
  if (rest > 0) sentences.push(`${count(rest, 'more item')} came from other people.`);
  if (!sentences.length) return '';
  return `Waiting for your yes or no on the Library page: ${sentences.join(' ')}`;
}

export interface LibraryItemRow {
  _id: Types.ObjectId;
  owner?: Types.ObjectId;
  title?: string;
  kind?: string;
  state?: string;
  shared?: boolean;
}

export interface LibrarySubmissionRow {
  _id: Types.ObjectId;
  user?: Types.ObjectId;
  userName?: string;
  type?: string;
  status?: string;
  url?: string;
  book?: Types.ObjectId | null;
  title?: string;
}

export interface LibraryModels {
  books: Model<LibraryItemRow>;
  submissions: Model<LibrarySubmissionRow>;
}

/** Everything still waiting, grouped by person, as the digest sentence ('' when nothing waits). */
export async function pendingLibraryDigest(models: LibraryModels): Promise<string> {
  const pending = await models.submissions
    .find({ status: 'pending' }, 'user userName type url book')
    .limit(5000)
    .lean<LibrarySubmissionRow[]>();
  if (!pending.length) return '';
  const bookIds = pending.filter((row) => row.book && row.type !== 'report').map((row) => row.book);
  const kinds = new Map<string, string>();
  if (bookIds.length) {
    const items = await models.books
      .find({ _id: { $in: bookIds } }, 'kind')
      .lean<LibraryItemRow[]>();
    for (const item of items) kinds.set(String(item._id), item.kind || 'text');
  }
  const people = new Map<string, LibraryDigestEntry>();
  for (const row of pending) {
    const key = String(row.user || row.userName || '');
    const entry = people.get(key) || { name: row.userName || 'Someone', books: 0, recordings: 0, videos: 0, links: 0, reports: 0 };
    people.set(key, entry);
    if (row.type === 'report') entry.reports++;
    else if (!row.book) entry.links++;
    else {
      const kind = kinds.get(String(row.book)) || 'text';
      if (kind === 'video') entry.videos++;
      else if (kind === 'audio') entry.recordings++;
      else entry.books++;
    }
  }
  return libraryDigestText([...people.values()]);
}

/* ── a trusted uploader's backlog ─────────────────────────────────────── */

export const trustedApprovalNote: string =
  "Approved automatically under Kade's trusted uploader rule.";

export interface UploadApprovalReceipt {
  applied: boolean;
  at: string;
  contributor: string;
  /** Items shared by this run (or that would be, in a preview). */
  approved: { id: string; title: string }[];
  /** Pending library requests for her files that this run marks approved. */
  submissionsSettled: number;
  /** Requests for items already in the family library; settled, nothing else changes. */
  alreadyShared: number;
  /** Requests whose file has not finished uploading; left waiting. */
  stillUploading: number;
  /** Requests whose item no longer exists; left for the owner. */
  missing: number;
  /** Link suggestions (not uploads); left for the owner's yes or no. */
  links: number;
  /** Ready items on her own shelf that she never asked to share; left as they are. */
  notRequested: number;
}

/**
 * Approves every file a trusted uploader has already asked to put in the family library.
 * Preview unless `apply`; running it again finds nothing left, so it is safe to repeat. Only her
 * own ready items with a pending request are shared: a link, a report, an unfinished upload or
 * an item she kept on her own shelf is counted and left alone.
 */
export async function approveTrustedUploads(
  models: LibraryModels,
  input: { contributor: string; decidedBy?: string; apply: boolean; now?: Date },
): Promise<UploadApprovalReceipt> {
  const now = input.now || new Date();
  const contributor = input.contributor;
  if (!OBJECT_ID.test(contributor)) throw new Error('Choose an account.');
  const owner = new Types.ObjectId(contributor);
  const pending = await models.submissions
    .find({ user: owner, status: 'pending', type: { $ne: 'report' } }, 'book url title')
    .limit(5000)
    .lean<LibrarySubmissionRow[]>();
  const fileRequests = pending.filter((row) => row.book);
  const items = fileRequests.length
    ? await models.books
        .find({ _id: { $in: fileRequests.map((row) => row.book) }, owner }, '_id title state shared')
        .lean<LibraryItemRow[]>()
    : [];
  const byId = new Map(items.map((item) => [String(item._id), item]));
  const approve = new Map<string, LibraryItemRow>();
  const settle: Types.ObjectId[] = [];
  let alreadyShared = 0,
    stillUploading = 0,
    missing = 0;
  for (const row of fileRequests) {
    const item = byId.get(String(row.book));
    if (!item) missing++;
    else if (item.state !== 'ready') stillUploading++;
    else {
      settle.push(row._id);
      if (item.shared) alreadyShared++;
      else approve.set(String(item._id), item);
    }
  }
  const requested = fileRequests.map((row) => row.book);
  const notRequested = await models.books.countDocuments({
    owner,
    state: 'ready',
    shared: { $ne: true },
    _id: { $nin: requested },
  });
  if (input.apply) {
    if (approve.size) {
      await models.books.updateMany(
        { _id: { $in: [...approve.values()].map((item) => item._id) }, owner, state: 'ready', shared: { $ne: true } },
        { $set: { shared: true, sharedAt: now } },
      );
    }
    if (settle.length) {
      await models.submissions.updateMany(
        { _id: { $in: settle }, status: 'pending' },
        {
          $set: {
            status: 'approved',
            decidedAt: now,
            decisionNote: trustedApprovalNote,
            ...(input.decidedBy && OBJECT_ID.test(input.decidedBy) ? { decidedBy: new Types.ObjectId(input.decidedBy) } : {}),
          },
        },
      );
    }
  }
  return {
    applied: input.apply,
    at: now.toISOString(),
    contributor,
    approved: [...approve.values()].map((item) => ({ id: String(item._id), title: item.title || 'Untitled' })),
    submissionsSettled: settle.length,
    alreadyShared,
    stillUploading,
    missing,
    links: pending.length - fileRequests.length,
    notRequested,
  };
}

/* ── the owner's routes ──────────────────────────────────────────────── */

export interface MembershipDependencies {
  auth: RequestHandler;
  /** Lets only the library owner through; answers everyone else itself. */
  owner: RequestHandler;
  accounts: () => Promise<LibraryAccountRow[]>;
  account: (id: string) => Promise<LibraryAccountRow | null>;
  setAccess: (id: string, access: 'family' | 'none') => Promise<LibraryAccountRow | null>;
  approveUploads: (contributor: string, apply: boolean, decidedBy: string) => Promise<UploadApprovalReceipt>;
  log?: (message: string) => void;
}

type AuthedRequest = { user?: { id?: string } };

/**
 * GET  /                  every account with its family access, in plain words
 * POST /                  { id, access: 'family' | 'none' }
 * POST /approve-uploads   { id, apply? } a trusted uploader's backlog: preview, then apply
 */
export function libraryMembershipRouter(deps: MembershipDependencies): Router {
  const router = Router();
  router.use(deps.auth, deps.owner);
  router.get('/', async (_req, res) => {
    try {
      const accounts = (await deps.accounts()).map(familyLibraryAccountView);
      accounts.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ accounts });
    } catch {
      res.status(503).json({ error: 'Could not read family library access. Try again in a moment.' });
    }
  });
  router.post('/', async (req, res) => {
    const { id, access } = (req.body || {}) as { id?: unknown; access?: unknown };
    if (typeof id !== 'string' || !OBJECT_ID.test(id) || (access !== 'family' && access !== 'none')) {
      res.status(400).json({ error: 'Choose an account, and whether it has family access.' });
      return;
    }
    try {
      const before = await deps.account(id);
      if (!before) {
        res.status(404).json({ error: 'That account was not found.' });
        return;
      }
      if (!familyLibraryAccountView(before).changeable) {
        res.status(409).json({ error: `${familyLibraryAccountView(before).name}'s access is fixed and cannot be changed here.` });
        return;
      }
      const after = await deps.setAccess(id, access);
      if (!after) {
        res.status(404).json({ error: 'That account was not found.' });
        return;
      }
      const view = familyLibraryAccountView(after);
      deps.log?.(`family access ${access} for ${id} by ${(req as AuthedRequest).user?.id || '?'}`);
      res.json({ ok: true, account: view });
    } catch {
      res.status(503).json({ error: 'Could not save that. Load the accounts again before retrying.' });
    }
  });
  router.post('/approve-uploads', async (req, res) => {
    const { id, apply } = (req.body || {}) as { id?: unknown; apply?: unknown };
    if (typeof id !== 'string' || !OBJECT_ID.test(id) || !trustedLibraryContributor(id)) {
      res.status(400).json({ error: "Only a trusted uploader's earlier uploads can be approved together." });
      return;
    }
    try {
      // Trust rides on family access: with hers turned off, her uploads wait for a decision again.
      const account = await deps.account(id);
      if (!account || !familyLibraryMember(account)) {
        res.status(409).json({ error: 'Turn on family library access for this account before approving its earlier uploads.' });
        return;
      }
      const receipt = await deps.approveUploads(id, apply === true, String((req as AuthedRequest).user?.id || ''));
      deps.log?.(
        `trusted backlog ${receipt.applied ? 'APPLIED' : 'preview'} for ${id}: ${receipt.approved.length} shared, ${receipt.submissionsSettled} requests settled, ${receipt.stillUploading} uploading, ${receipt.links} links left`,
      );
      res.json(receipt);
    } catch {
      res.status(503).json({ error: 'Could not finish. Nothing is lost; preview again before retrying.' });
    }
  });
  return router;
}
