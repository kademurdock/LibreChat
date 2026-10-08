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
  assert.ok(
    search.$match.$and[0].$or.some((row: Record<string, unknown>) => '_browseYear.match' in row),
  );
});
