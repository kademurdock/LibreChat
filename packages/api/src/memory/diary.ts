import type { Collection, Document } from 'mongodb';

export const diaryWriteOrigins = [
  'live_chat',
  'temporary_unknown',
  'canary',
  'brief',
  'consolidation',
  'manual',
  'backfill',
  'unknown',
] as const;

export type DiaryWriteOrigin = (typeof diaryWriteOrigins)[number];

export function diaryChatOrigin(options: {
  isTemporary?: boolean;
  toolPolicy?: string;
}): DiaryWriteOrigin {
  if (options.toolPolicy === 'morning-brief') {
    return 'brief';
  }
  return options.isTemporary ? 'temporary_unknown' : 'live_chat';
}

export function diaryWriteOrigin(options: {
  source?: string;
  conversationId?: string | null;
  origin?: DiaryWriteOrigin;
}): DiaryWriteOrigin {
  if (/^consolidat/.test(options.conversationId ?? '')) {
    return 'consolidation';
  }
  if (options.source === 'manual') {
    return 'manual';
  }
  if (['mined', 'backfill', 'gpt-import'].includes(options.source ?? '')) {
    return 'backfill';
  }
  if (options.source !== 'keeper') {
    return 'unknown';
  }
  return options.origin && diaryWriteOrigins.includes(options.origin) ? options.origin : 'unknown';
}

interface OriginActivity {
  entries: number;
  createdEntries24h: number;
  amendedEntries24h: number;
  lastCreatedAt: string | null;
  lastAmendedAt: string | null;
  lastWriteAt: string | null;
}

interface OriginRow {
  _id: DiaryWriteOrigin;
  entries: number;
  createdEntries24h: number;
  amendedEntries24h: number;
  lastCreatedAt: Date | null;
  lastAmendedAt: Date | null;
}

const diarySources = ['keeper', 'manual', 'mined', 'backfill', 'gpt-import', 'other'] as const;
type DiarySource = (typeof diarySources)[number];

interface HistoryRow {
  _id: DiarySource;
  entries: number;
  newestCreatedAt: Date | null;
  newestDocumentUpdatedAt: Date | null;
}

interface HistoryActivity {
  entries: number;
  newestCreatedAt: string | null;
  newestDocumentUpdatedAt: string | null;
}

interface DiagnosticRows {
  byOrigin: OriginRow[];
  legacy: HistoryRow[];
  sourceHistory: HistoryRow[];
}

export interface DiaryDiagnostic {
  schemaVersion: 1;
  evidence: 'persisted-successful-writes';
  generatedAt: string;
  countSemantics: string;
  coverage: string;
  byOrigin: Record<DiaryWriteOrigin, OriginActivity>;
  legacy: HistoryActivity;
  sourceHistory: Record<DiarySource, HistoryActivity>;
  historicalUpdatedAtMeaning: string;
}

function validDate(path: string, now: Date): Document {
  return {
    $cond: [{ $and: [{ $eq: [{ $type: path }, 'date'] }, { $lte: [path, now] }] }, path, null],
  };
}

function iso(date: Date | null | undefined): string | null {
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function history(row?: HistoryRow): HistoryActivity {
  return {
    entries: row?.entries ?? 0,
    newestCreatedAt: iso(row?.newestCreatedAt),
    newestDocumentUpdatedAt: iso(row?.newestDocumentUpdatedAt),
  };
}

/** Reads only bounded metadata. Historical updatedAt cannot identify the writer or an amendment. */
export async function diaryDiagnostic(
  collection: Pick<Collection, 'aggregate'>,
  now: Date = new Date(),
): Promise<DiaryDiagnostic> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const originFields = diaryWriteOrigins.map((origin) => ({
    origin,
    createdAt: validDate(`$writeActivity.${origin}.createdAt`, now),
    amendedAt: validDate(`$writeActivity.${origin}.amendedAt`, now),
  }));
  const historyGroup = {
    entries: { $sum: 1 },
    newestCreatedAt: { $max: '$createdAt' },
    newestDocumentUpdatedAt: { $max: '$updatedAt' },
  };
  const [result] = await collection
    .aggregate<DiagnosticRows>(
      [
        {
          $project: {
            _id: 0,
            origins: originFields,
            source: {
              $cond: [
                { $in: [{ $ifNull: ['$source', 'keeper'] }, diarySources] },
                { $ifNull: ['$source', 'keeper'] },
                'other',
              ],
            },
            createdAt: validDate('$createdAt', now),
            updatedAt: validDate('$updatedAt', now),
          },
        },
        {
          $facet: {
            byOrigin: [
              { $unwind: '$origins' },
              {
                $match: {
                  $or: [
                    { 'origins.createdAt': { $ne: null } },
                    { 'origins.amendedAt': { $ne: null } },
                  ],
                },
              },
              {
                $group: {
                  _id: '$origins.origin',
                  entries: { $sum: 1 },
                  lastCreatedAt: { $max: '$origins.createdAt' },
                  lastAmendedAt: { $max: '$origins.amendedAt' },
                  createdEntries24h: {
                    $sum: { $cond: [{ $gte: ['$origins.createdAt', since] }, 1, 0] },
                  },
                  amendedEntries24h: {
                    $sum: { $cond: [{ $gte: ['$origins.amendedAt', since] }, 1, 0] },
                  },
                },
              },
            ],
            legacy: [
              {
                $match: {
                  origins: {
                    $not: {
                      $elemMatch: {
                        $or: [{ createdAt: { $ne: null } }, { amendedAt: { $ne: null } }],
                      },
                    },
                  },
                },
              },
              { $group: { _id: null, ...historyGroup } },
            ],
            sourceHistory: [{ $group: { _id: '$source', ...historyGroup } }],
          },
        },
      ],
      { maxTimeMS: 5000 },
    )
    .toArray();

  const byOrigin = Object.fromEntries(
    diaryWriteOrigins.map((origin) => {
      const row = result?.byOrigin.find((item) => item._id === origin);
      const lastCreatedAt = iso(row?.lastCreatedAt);
      const lastAmendedAt = iso(row?.lastAmendedAt);
      return [
        origin,
        {
          entries: row?.entries ?? 0,
          createdEntries24h: row?.createdEntries24h ?? 0,
          amendedEntries24h: row?.amendedEntries24h ?? 0,
          lastCreatedAt,
          lastAmendedAt,
          lastWriteAt:
            (lastCreatedAt ?? '') > (lastAmendedAt ?? '') ? lastCreatedAt : lastAmendedAt,
        },
      ];
    }),
  ) as Record<DiaryWriteOrigin, OriginActivity>;

  return {
    schemaVersion: 1,
    evidence: 'persisted-successful-writes',
    generatedAt: now.toISOString(),
    countSemantics:
      'Entries per operation in the past 24h; repeated amendments of one entry count once.',
    coverage:
      'live_chat covers non-temporary chat. Temporary traffic includes human calls and probes whose origin cannot be verified; it is reported separately.',
    byOrigin,
    legacy: history(result?.legacy[0]),
    sourceHistory: Object.fromEntries(
      diarySources.map((source) => [
        source,
        history(result?.sourceHistory.find((row) => row._id === source)),
      ]),
    ) as Record<DiarySource, HistoryActivity>,
    historicalUpdatedAtMeaning:
      'Writer unknown; document updates include maintenance and cannot establish historical amendment times.',
  };
}
