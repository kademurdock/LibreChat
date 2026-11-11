import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Types } from 'mongoose';
import { browseCursor, browseInput, browsePipeline } from './browse';

const reader = { id: 'aaaaaaaaaaaaaaaaaaaaaa01', hidden: false, child: false };

test('one authorized catalog drives results, counts and facets; own and child rules survive', () => {
  const family = browsePipeline(reader, {}, '$path');
  assert.deepEqual(family[0], { $match: { state: 'ready', shared: true } });
  assert.deepEqual(browsePipeline({ ...reader, hidden: true, child: true }, {}, '$path')[0], {
    $match: { state: 'ready', owner: new Types.ObjectId(reader.id), grownUpsOnly: { $ne: true } },
  });
  assert.deepEqual(browsePipeline(reader, { scope: 'mine' }, '$path')[0], {
    $match: { state: 'ready', owner: new Types.ObjectId(reader.id) },
  });
});

test('cursor follows equal sort keys by object identity and cannot carry across filters', () => {
  const after = browseCursor({ sort: 'title', type: 'newspaper' }, reader.id, 'example news');
  const plan = browsePipeline(reader, { sort: 'title', type: 'newspaper', after }, '$path');
  const facet = plan.at(-1);
  assert.ok(facet && '$facet' in facet);
  assert.deepEqual(facet.$facet.items[1], {
    $match: {
      $or: [
        { _browseTitle: { $gt: 'example news' } },
        { _browseTitle: 'example news', _id: { $gt: new Types.ObjectId(reader.id) } },
      ],
    },
  });
  const changed = browsePipeline(reader, { sort: 'title', type: 'book', after }, '$path').at(-1);
  assert.ok(changed && '$facet' in changed);
  assert.equal(changed.$facet.items.length, facet.$facet.items.length - 1);
});

test('search escapes regex operators and folder prefixes keep the segment boundary', () => {
  const plan = browsePipeline(
    reader,
    { q: 'A+B [issue]', path: 'Books/Local (MO)', type: 'newspaper', decade: '1940s' },
    '$path',
  ).at(-1);
  assert.ok(plan && '$facet' in plan);
  const filters = plan.$facet.items[0];
  assert.ok('$match' in filters && Array.isArray(filters.$match.$and));
  const path = filters.$match.$and[2].path;
  assert.ok(path instanceof RegExp);
  assert.ok(path.test('Books/Local (MO)/1930s'));
  assert.ok(!path.test('Books/Local (MO)Extra'));
  assert.ok(!path.test('Books/Local MO/1930s'));
});

test('invalid controls and cursor content stay bounded and never widen authorized scope', () => {
  assert.deepEqual(
    browseInput({ kind: 'invalid', scope: 'anyone', decade: '$ne', q: 'x'.repeat(200) }),
    {
      q: 'x'.repeat(120),
      scope: 'public',
      kind: '',
      type: '',
      decade: '',
      path: '',
      sort: 'recent',
      after: '',
      page: '0',
    },
  );
  const plan = browsePipeline({ ...reader, hidden: true }, { after: 'bad' }, '$path');
  assert.deepEqual(plan[0], { $match: { state: 'ready', owner: new Types.ObjectId(reader.id) } });
});

test('a year query searches normalized metadata even when the title has no date', () => {
  const plan = browsePipeline(reader, { q: '1998' }, '$path').at(-1);
  assert.ok(plan && '$facet' in plan);
  const search = plan.$facet.items[0];
  assert.ok('$match' in search && Array.isArray(search.$match.$and));
  const choices = search.$match.$and[0].$or;
  assert.ok(choices);
  assert.ok(choices.some((row: Record<string, unknown>) => '_browseYear.match' in row));
});

test('a page number skips whole pages of the same sorted list, and a bad one is the first page', () => {
  const third = browsePipeline(reader, { page: '2', sort: 'title' }, '$path').at(-1);
  assert.ok(third && '$facet' in third);
  assert.deepEqual(third.$facet.items.slice(0, 3), [
    { $sort: { _browseTitle: 1, _id: 1 } },
    { $skip: 120 },
    { $limit: 61 },
  ]);
  assert.deepEqual(third.$facet.total, [{ $count: 'count' }]);
  for (const page of ['-1', '1.5', 'x', '99999', '']) {
    const first = browsePipeline(reader, { page }, '$path').at(-1);
    assert.ok(first && '$facet' in first);
    assert.ok(!first.$facet.items.some((stage: Record<string, unknown>) => '$skip' in stage));
  }
  assert.equal(browseInput({ page: '007' }).page, '7');
  const after = browseCursor({ sort: 'title' }, reader.id, 'm');
  const both = browsePipeline(reader, { page: '3', sort: 'title', after }, '$path').at(-1);
  assert.ok(both && '$facet' in both);
  assert.ok(!both.$facet.items.some((stage: Record<string, unknown>) => '$skip' in stage));
});
