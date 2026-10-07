import { Types } from 'mongoose';
import type { PipelineStage } from 'mongoose';
import type { LibraryReader } from './catalog';

export interface BrowseInput {
  q?: string;
  scope?: string;
  kind?: string;
  type?: string;
  decade?: string;
  path?: string;
  sort?: string;
  after?: string;
}

interface BrowseCursor {
  id: string;
  key: string;
  sort: string;
  query: string;
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (value: string | undefined, length = 120): string =>
  typeof value === 'string' ? value.trim().slice(0, length) : '';
const text = (field: string) => ({
  $convert: { input: field, to: 'string', onNull: '', onError: '' },
});

export function browseInput(input: BrowseInput): Required<BrowseInput> {
  return {
    q: clean(input.q),
    scope: input.scope === 'mine' ? 'mine' : 'public',
    kind: ['text', 'audio', 'video'].includes(input.kind || '') ? input.kind! : '',
    type: clean(input.type, 60),
    decade: /^(?:\d{4}s|Undated|Multiple decades)$/.test(input.decade || '') ? input.decade! : '',
    path: clean(input.path, 400).replace(/^\/+|\/+$/g, ''),
    sort: input.sort === 'title' ? 'title' : 'recent',
    after: clean(input.after, 2000),
  };
}

function queryKey(input: Required<BrowseInput>): string {
  return JSON.stringify([input.q, input.scope, input.kind, input.type, input.decade, input.path]);
}

function cursor(input: Required<BrowseInput>): BrowseCursor | null {
  if (!input.after) return null;
  try {
    const value: BrowseCursor = JSON.parse(Buffer.from(input.after, 'base64url').toString());
    if (!value || !/^[a-f\d]{24}$/i.test(value.id) || typeof value.key !== 'string') return null;
    if (value.sort !== input.sort || value.query !== queryKey(input)) return null;
    if (input.sort === 'recent' && !Number.isFinite(Date.parse(value.key))) return null;
    return value;
  } catch {
    return null;
  }
}

export function browseCursor(input: BrowseInput, id: string, key: string): string {
  const normalized = browseInput(input);
  return Buffer.from(
    JSON.stringify({ id, key, sort: normalized.sort, query: queryKey(normalized) }),
  ).toString('base64url');
}

/** All branches use the same authorized catalog; the cursor only narrows that view. */
export function browsePipeline(
  reader: LibraryReader,
  raw: BrowseInput,
  pathExpression: PipelineStage.AddFields['$addFields'][string],
): PipelineStage[] {
  const input = browseInput(raw);
  const own = reader.hidden || input.scope === 'mine';
  const match = {
    state: 'ready',
    ...(own ? { owner: new Types.ObjectId(reader.id) } : { shared: true }),
    ...(reader.child ? { grownUpsOnly: { $ne: true } } : {}),
  };
  const filters: PipelineStage.Match['$match'][] = [];
  if (input.kind) filters.push({ kind: input.kind });
  if (input.type) filters.push({ _browseType: input.type });
  if (input.decade) filters.push({ _browseDecade: input.decade });
  if (input.path) filters.push({ path: new RegExp('^' + escape(input.path) + '(?:/|$)', 'i') });
  for (const word of input.q.split(/\s+/).filter(Boolean).slice(0, 8)) {
    const pattern = new RegExp(escape(word), 'i');
    filters.push({
      $or: [
        'title',
        'author',
        'path',
        'tags',
        'description',
        'meta.market',
        'meta.brand',
        'meta.callSign',
        'meta.sourceDescription',
      ].map((field) => ({ [field]: pattern })),
    });
  }
  const filtered: PipelineStage.FacetPipelineStage[] = filters.length
    ? [{ $match: { $and: filters } }]
    : [];
  const after = cursor(input);
  const field = input.sort === 'title' ? '_browseTitle' : '_browseRecent';
  const direction = input.sort === 'title' ? 1 : -1;
  const key = after && input.sort === 'recent' ? new Date(after.key) : after?.key;
  const paged: PipelineStage.FacetPipelineStage[] = after
    ? [
        {
          $match: {
            $or: [
              { [field]: { [direction === 1 ? '$gt' : '$lt']: key } },
              {
                [field]: key,
                _id: { [direction === 1 ? '$gt' : '$lt']: new Types.ObjectId(after.id) },
              },
            ],
          },
        },
      ]
    : [];
  return [
    { $match: match },
    { $addFields: { path: pathExpression } },
    {
      $addFields: {
        _browseTitle: { $toLower: { $ifNull: ['$title', ''] } },
        _browseRecent: { $ifNull: ['$sharedAt', { $ifNull: ['$createdAt', new Date(0)] }] },
        _browseType: {
          $switch: {
            branches: [
              {
                case: {
                  $or: [
                    {
                      $regexMatch: { input: text('$meta.sourceKind'), regex: /^newspaper(?:_|$)/i },
                    },
                    { $regexMatch: { input: '$path', regex: /(?:^|\/)Newspapers?(?:\/|$)/i } },
                  ],
                },
                then: 'newspaper',
              },
              {
                case: {
                  $or: [
                    {
                      $regexMatch: { input: text('$meta.sourceKind'), regex: /^yearbook(?:_|$)/i },
                    },
                    { $regexMatch: { input: '$path', regex: /(?:^|\/)Yearbooks?(?:\/|$)/i } },
                  ],
                },
                then: 'yearbook',
              },
              { case: { $eq: ['$kind', 'text'] }, then: 'book' },
            ],
            default: { $ifNull: ['$category', '$kind'] },
          },
        },
        _browseYear: {
          $regexFind: {
            input: { $concat: [text('$meta.year'), ' ', text('$copyrightYear')] },
            regex: /(?:1[0-9]{3}|20[0-9]{2})/,
          },
        },
        _browsePathDecade: {
          $regexFind: { input: '$path', regex: /(?:^|\/)([12][0-9]{3}s)(?:\/|$)/ },
        },
      },
    },
    {
      $addFields: {
        _browseDecade: {
          $switch: {
            branches: [
              {
                case: {
                  $regexMatch: {
                    input: { $concat: [text('$meta.decade'), ' ', '$path'] },
                    regex: /multiple decades/i,
                  },
                },
                then: 'Multiple decades',
              },
              {
                case: { $regexMatch: { input: text('$meta.decade'), regex: /^[12][0-9]{3}s$/ } },
                then: '$meta.decade',
              },
              {
                case: { $ne: ['$_browseYear', null] },
                then: { $concat: [{ $substrCP: ['$_browseYear.match', 0, 3] }, '0s'] },
              },
              {
                case: { $ne: ['$_browsePathDecade', null] },
                then: { $arrayElemAt: ['$_browsePathDecade.captures', 0] },
              },
            ],
            default: 'Undated',
          },
        },
      },
    },
    {
      $facet: {
        items: [
          ...filtered,
          ...paged,
          { $sort: { [field]: direction, _id: direction } },
          { $limit: 61 },
          { $project: { 'tracks.description.scenes': 0, 'tracks.recaps': 0 } },
        ],
        total: [...filtered, { $count: 'count' }],
        types: [{ $group: { _id: '$_browseType', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        decades: [{ $group: { _id: '$_browseDecade', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      },
    },
  ];
}
