import type { PipelineStage } from 'mongoose';

const DAY_MS = 86_400_000;
const VOICE_ESTIMATE_SERVICE = 'voice_chat';
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface MonthlyWindow {
  from: Date;
  to: Date;
}

export interface MonthlyPipelines {
  chat: PipelineStage[];
  extras: PipelineStage[];
  ledger: PipelineStage[];
}

export interface MonthlyBooksReport {
  version: 1;
  window: {
    from: string;
    to: string;
    timeZone: 'America/Chicago';
    endExclusive: true;
  };
  ownerExempt: { chatNominalUSD: number; extrasNominalUSD: number };
  nonAdmin: {
    chatChargedUSD: number;
    extrasChargedUSD: number;
    walletChargedUSD: number;
    extrasRecordedChargedUSD: number;
    extrasInferredChargedUSD: number;
    walletRecordedChargedUSD: number;
  };
  unclassified: { chatNominalUSD: number; extrasNominalUSD: number };
  extraRecords: { costUSD: number; voiceEstimateUSD: number; voiceEstimateRows: number };
  repayments: { recordedUSD: number; count: number };
  grants: { netUSD: number; count: number };
  coverage: {
    chatRows: number;
    extraRows: number;
    legacyExtraRows: number;
    nonAdminLegacyExtraRows: number;
    ownerLegacyExtraRows: number;
    unknownRoleRows: number;
    unknownRoleAccounts: number;
    missingAccountRows: number;
    missingAccounts: number;
    recognizedRoles: ('ADMIN' | 'USER')[];
    roleBasis: 'current';
    legacyExtrasChargeBasis: string;
    ownerExtrasBasis: string;
    unclassifiedExtrasBasis: string;
    notes: string[];
  };
}

export class MonthlyWindowError extends Error {
  constructor() {
    super('from and to must be ISO timestamps with a positive window of at most 32 days');
    this.name = 'MonthlyWindowError';
  }
}

function timestamp(value: string): Date {
  const parts = typeof value === 'string' ? ISO_TIMESTAMP.exec(value) : null;
  if (!parts) {
    throw new MonthlyWindowError();
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const parsed = new Date(value);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    !Number.isFinite(parsed.getTime())
  ) {
    throw new MonthlyWindowError();
  }
  return parsed;
}

/** Explicit bounds only: the caller supplies the intended Chicago calendar month. */
export function monthlyWindow(from: string, to: string): MonthlyWindow {
  const window = { from: timestamp(from), to: timestamp(to) };
  const duration = window.to.getTime() - window.from.getTime();
  if (duration <= 0 || duration > 32 * DAY_MS) {
    throw new MonthlyWindowError();
  }
  return window;
}

interface AccountGroup {
  user: string | null;
  role: string | null;
  accountFound: boolean;
}

export interface MonthlyChatGroup {
  _id: AccountGroup;
  nominalUSD: number;
  rows: number;
}

export interface MonthlyExtraGroup {
  _id: AccountGroup;
  costUSD: number;
  chargedUSD: number;
  recordedChargedUSD: number;
  inferredChargedUSD: number;
  rows: number;
  legacyRows: number;
  voiceEstimateUSD: number;
  voiceEstimateRows: number;
}

export interface MonthlyLedgerGroup {
  _id: 'repayment' | 'grant';
  usd: number;
  count: number;
}

interface AggregateReader<Row> {
  aggregate(pipeline: PipelineStage[]): PromiseLike<Row[]>;
}

export interface MonthlyBooksDependencies {
  Transaction: AggregateReader<MonthlyChatGroup>;
  KadeUsage: AggregateReader<MonthlyExtraGroup>;
  KadeFundingEntry: AggregateReader<MonthlyLedgerGroup>;
  userCollection?: string;
}

function accountLookup(userCollection: string): PipelineStage.Lookup {
  return {
    $lookup: {
      from: userCollection,
      localField: 'user',
      foreignField: '_id',
      pipeline: [{ $project: { _id: 0, role: 1 } }],
      as: 'account',
    },
  };
}

const ACCOUNT_GROUP = {
  user: { $convert: { input: '$user', to: 'string', onError: null, onNull: null } },
  role: { $ifNull: [{ $arrayElemAt: ['$account.role', 0] }, null] },
  accountFound: { $gt: [{ $size: '$account' }, 0] },
};
const RECORDED_COST = {
  $cond: [{ $isNumber: '$costUSD' }, { $toDouble: '$costUSD' }, 0],
};
const EXPLICIT_CHARGE = { $isNumber: '$chargedUSD' };

/** Aggregate accounting fields only. Chat credits/refills never enter these sums. */
export function monthlyPipelines(
  window: MonthlyWindow,
  userCollection = 'users',
): MonthlyPipelines {
  const createdAt = { $gte: window.from, $lt: window.to };
  const chat: PipelineStage[] = [
    { $match: { createdAt, tokenType: { $in: ['prompt', 'completion'] }, tokenValue: { $lt: 0 } } },
    accountLookup(userCollection),
    {
      $group: {
        _id: ACCOUNT_GROUP,
        nominalUSD: { $sum: { $multiply: ['$tokenValue', -1 / 1_000_000] } },
        rows: { $sum: 1 },
      },
    },
  ];
  const extras: PipelineStage[] = [
    { $match: { createdAt } },
    accountLookup(userCollection),
    {
      $group: {
        _id: ACCOUNT_GROUP,
        costUSD: { $sum: RECORDED_COST },
        chargedUSD: {
          $sum: { $cond: [EXPLICIT_CHARGE, { $toDouble: '$chargedUSD' }, RECORDED_COST] },
        },
        recordedChargedUSD: {
          $sum: { $cond: [EXPLICIT_CHARGE, { $toDouble: '$chargedUSD' }, 0] },
        },
        inferredChargedUSD: {
          $sum: { $cond: [EXPLICIT_CHARGE, 0, RECORDED_COST] },
        },
        rows: { $sum: 1 },
        legacyRows: { $sum: { $cond: [EXPLICIT_CHARGE, 0, 1] } },
        voiceEstimateUSD: {
          $sum: { $cond: [{ $eq: ['$service', VOICE_ESTIMATE_SERVICE] }, RECORDED_COST, 0] },
        },
        voiceEstimateRows: {
          $sum: { $cond: [{ $eq: ['$service', VOICE_ESTIMATE_SERVICE] }, 1, 0] },
        },
      },
    },
  ];
  const ledger: PipelineStage[] = [
    {
      $match: {
        at: { $gte: window.from, $lt: window.to },
        voidedAt: null,
        kind: { $in: ['repayment', 'grant'] },
      },
    },
    { $group: { _id: '$kind', usd: { $sum: '$usd' }, count: { $sum: 1 } } },
  ];
  return { chat, extras, ledger };
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Monthly accounting contains a non-finite aggregate');
  }
  return value;
}

function cents(value: number): number {
  const absolute = Math.abs(finite(value));
  const result = Math.round((absolute + Number.EPSILON * Math.max(1, absolute)) * 100) / 100;
  return result === 0 ? 0 : Math.sign(value) * result;
}

function roleOf(group: AccountGroup): 'ADMIN' | 'USER' | null {
  const role = typeof group.role === 'string' ? group.role.trim().toUpperCase() : '';
  return role === 'ADMIN' || role === 'USER' ? role : null;
}

/** Summation precedes rounding, including the combined wallet total. No runtime repricing. */
export function summarizeMonthlyBooks(
  window: MonthlyWindow,
  chat: MonthlyChatGroup[],
  extras: MonthlyExtraGroup[],
  ledger: MonthlyLedgerGroup[],
): MonthlyBooksReport {
  const sums = {
    ownerChat: 0,
    ownerExtras: 0,
    userChat: 0,
    userExtras: 0,
    userExtrasRecorded: 0,
    userExtrasInferred: 0,
    unknownChat: 0,
    unknownExtras: 0,
    extraCost: 0,
    voiceEstimate: 0,
    repayment: 0,
    grant: 0,
  };
  const counts = {
    chatRows: 0,
    extraRows: 0,
    legacyExtraRows: 0,
    nonAdminLegacyExtraRows: 0,
    ownerLegacyExtraRows: 0,
    voiceEstimateRows: 0,
    unknownRoleRows: 0,
    missingAccountRows: 0,
    repayment: 0,
    grant: 0,
  };
  const unknownAccounts = new Set<string>();
  const missingAccounts = new Set<string>();
  const coverageFor = (group: AccountGroup, rows: number) => {
    if (!roleOf(group)) {
      counts.unknownRoleRows += finite(rows);
      if (group.user !== null) {
        unknownAccounts.add(group.user);
      }
    }
    if (!group.accountFound) {
      counts.missingAccountRows += finite(rows);
      if (group.user !== null) {
        missingAccounts.add(group.user);
      }
    }
  };

  for (const row of chat) {
    const amount = finite(row.nominalUSD);
    const role = roleOf(row._id);
    if (role === 'ADMIN') sums.ownerChat += amount;
    else if (role === 'USER') sums.userChat += amount;
    else sums.unknownChat += amount;
    counts.chatRows += finite(row.rows);
    coverageFor(row._id, row.rows);
  }
  for (const row of extras) {
    const cost = finite(row.costUSD);
    const charge = finite(row.chargedUSD);
    const recorded = finite(row.recordedChargedUSD);
    const inferred = finite(row.inferredChargedUSD);
    const role = roleOf(row._id);
    if (role === 'ADMIN') {
      sums.ownerExtras += cost;
      counts.ownerLegacyExtraRows += finite(row.legacyRows);
    } else if (role === 'USER') {
      sums.userExtras += charge;
      sums.userExtrasRecorded += recorded;
      sums.userExtrasInferred += inferred;
      counts.nonAdminLegacyExtraRows += finite(row.legacyRows);
    } else sums.unknownExtras += cost;
    sums.extraCost += cost;
    sums.voiceEstimate += finite(row.voiceEstimateUSD);
    counts.extraRows += finite(row.rows);
    counts.legacyExtraRows += finite(row.legacyRows);
    counts.voiceEstimateRows += finite(row.voiceEstimateRows);
    coverageFor(row._id, row.rows);
  }
  for (const row of ledger) {
    if (row._id === 'repayment') {
      sums.repayment += finite(row.usd);
      counts.repayment += finite(row.count);
    } else if (row._id === 'grant') {
      sums.grant += finite(row.usd);
      counts.grant += finite(row.count);
    }
  }

  return {
    version: 1,
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      timeZone: 'America/Chicago',
      endExclusive: true,
    },
    ownerExempt: {
      chatNominalUSD: cents(sums.ownerChat),
      extrasNominalUSD: cents(sums.ownerExtras),
    },
    nonAdmin: {
      chatChargedUSD: cents(sums.userChat),
      extrasChargedUSD: cents(sums.userExtras),
      walletChargedUSD: cents(sums.userChat + sums.userExtras),
      extrasRecordedChargedUSD: cents(sums.userExtrasRecorded),
      extrasInferredChargedUSD: cents(sums.userExtrasInferred),
      walletRecordedChargedUSD: cents(sums.userChat + sums.userExtrasRecorded),
    },
    unclassified: {
      chatNominalUSD: cents(sums.unknownChat),
      extrasNominalUSD: cents(sums.unknownExtras),
    },
    extraRecords: {
      costUSD: cents(sums.extraCost),
      voiceEstimateUSD: cents(sums.voiceEstimate),
      voiceEstimateRows: counts.voiceEstimateRows,
    },
    repayments: { recordedUSD: cents(sums.repayment), count: counts.repayment },
    grants: { netUSD: cents(sums.grant), count: counts.grant },
    coverage: {
      chatRows: counts.chatRows,
      extraRows: counts.extraRows,
      legacyExtraRows: counts.legacyExtraRows,
      nonAdminLegacyExtraRows: counts.nonAdminLegacyExtraRows,
      ownerLegacyExtraRows: counts.ownerLegacyExtraRows,
      unknownRoleRows: counts.unknownRoleRows,
      unknownRoleAccounts: unknownAccounts.size,
      missingAccountRows: counts.missingAccountRows,
      missingAccounts: missingAccounts.size,
      recognizedRoles: ['ADMIN', 'USER'],
      roleBasis: 'current',
      legacyExtrasChargeBasis: 'costUSD inferred when chargedUSD is not numeric',
      ownerExtrasBasis: 'recorded cost basis (costUSD), not an administrator wallet debit',
      unclassifiedExtrasBasis:
        'recorded cost basis (costUSD), wallet charge classification unknown',
      notes: [
        'Current roles do not establish historical roles; missing and unknown roles are unclassified.',
        'Deleted-account records remain included; unknown account counts require a recorded user ID.',
        'Chat amounts are recorded prompt/completion debits, not independently verified provider cost.',
        'Extras retain recorded costs and voice estimates; extraRecords is not added to wallet totals.',
        'Voice estimates can overlap chat records; do not sum owner chat and extras as provider cost.',
        'Legacy extras charges are inferred from costUSD, not independently verified wallet debits.',
        'extrasChargedUSD and walletChargedUSD include inferred legacy extras; recorded fields exclude them.',
        'Extras and wallet amounts are signed net charges, preserving recorded negative refunds.',
        'Repayments are recorded cash received; grants are net credit allocations, not repayments.',
        'Provider-wide spend, unrecorded helpers and missing records are outside this accounting report.',
      ],
    },
  };
}

export async function monthlyBooks(
  window: MonthlyWindow,
  dependencies: MonthlyBooksDependencies,
): Promise<MonthlyBooksReport> {
  const pipelines = monthlyPipelines(window, dependencies.userCollection);
  const [chat, extras, ledger] = await Promise.all([
    dependencies.Transaction.aggregate(pipelines.chat),
    dependencies.KadeUsage.aggregate(pipelines.extras),
    dependencies.KadeFundingEntry.aggregate(pipelines.ledger),
  ]);
  return summarizeMonthlyBooks(window, chat, extras, ledger);
}
