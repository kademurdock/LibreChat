const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');
const test = require('node:test');

// This package builds ES syntax into CommonJS. Load its actual source with Node 24's
// TypeScript stripper so these accounting tests need no installed monorepo dependencies.
const source = readFileSync(path.join(__dirname, 'monthly.ts'), 'utf8');
const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
const modulePromise = import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
);
const from = '2026-09-01T00:00:00-05:00';
const to = '2026-10-01T00:00:00-05:00';
const account = (user, role, accountFound = true) => ({ user, role, accountFound });
const chat = (user, role, nominalUSD, rows = 1, accountFound = true) => ({
  _id: account(user, role, accountFound),
  nominalUSD,
  rows,
});
const extra = (user, role, costUSD, chargedUSD, options = {}) => ({
  _id: account(user, role, options.accountFound ?? true),
  costUSD,
  chargedUSD,
  recordedChargedUSD: options.recordedChargedUSD ?? chargedUSD,
  inferredChargedUSD: options.inferredChargedUSD ?? 0,
  rows: options.rows ?? 1,
  legacyRows: options.legacyRows ?? 0,
  voiceEstimateUSD: options.voiceEstimateUSD ?? 0,
  voiceEstimateRows: options.voiceEstimateRows ?? 0,
});

test('explicit timestamp bounds preserve Chicago offsets and reject invalid windows', async () => {
  const { monthlyWindow, MonthlyWindowError } = await modulePromise;
  const window = monthlyWindow(from, to);
  assert.equal(window.from.toISOString(), '2026-09-01T05:00:00.000Z');
  assert.equal(window.to.toISOString(), '2026-10-01T05:00:00.000Z');
  for (const [start, end] of [
    [undefined, to],
    [[from], to],
    ['2026-09-01', to],
    ['2026-09-01T00:00:00', to],
    [from, from],
    [to, from],
    [from, '2026-10-04T00:00:00-05:00'],
    ['2026-02-30T00:00:00Z', '2026-03-01T00:00:00Z'],
    ['2026-09-01T24:00:00Z', to],
  ]) {
    assert.throws(() => monthlyWindow(start, end), MonthlyWindowError);
  }
  assert.doesNotThrow(() => monthlyWindow('2026-01-01T00:00:00Z', '2026-02-02T00:00:00Z'));
});

test('query contracts use half-open bounds and chat debit rows only', async () => {
  const { monthlyWindow, monthlyPipelines } = await modulePromise;
  const window = monthlyWindow(from, to);
  const pipelines = monthlyPipelines(window, 'accountcollection');
  assert.deepEqual(pipelines.chat[0], {
    $match: {
      createdAt: { $gte: window.from, $lt: window.to },
      tokenType: { $in: ['prompt', 'completion'] },
      tokenValue: { $lt: 0 },
    },
  });
  assert.deepEqual(pipelines.extras[0], {
    $match: { createdAt: { $gte: window.from, $lt: window.to } },
  });
  assert.deepEqual(pipelines.ledger[0], {
    $match: {
      at: { $gte: window.from, $lt: window.to },
      voidedAt: null,
      kind: { $in: ['repayment', 'grant'] },
    },
  });
  assert.equal(pipelines.chat[1].$lookup.from, 'accountcollection');
  assert.deepEqual(pipelines.chat[1].$lookup.pipeline, [{ $project: { _id: 0, role: 1 } }]);
  const match = pipelines.chat[0].$match;
  const accepted = (date, type, value) =>
    date >= match.createdAt.$gte &&
    date < match.createdAt.$lt &&
    match.tokenType.$in.includes(type) &&
    value < match.tokenValue.$lt;
  assert.equal(accepted(window.from, 'prompt', -1), true);
  assert.equal(accepted(window.to, 'completion', -1), false);
  assert.equal(accepted(new Date(window.from.getTime() - 1), 'prompt', -1), false);
  assert.equal(accepted(window.from, 'credits', -1), false);
  assert.equal(accepted(window.from, 'autoRefill', 1_000_000), false);
  assert.equal(accepted(window.from, 'prompt', 1_000_000), false);
});

test('extras retain numeric zero charges and infer only nonnumeric legacy charges', async () => {
  const { monthlyWindow, monthlyPipelines } = await modulePromise;
  const group = monthlyPipelines(monthlyWindow(from, to)).extras[2].$group;
  assert.deepEqual(group.chargedUSD, {
    $sum: {
      $cond: [
        { $isNumber: '$chargedUSD' },
        { $toDouble: '$chargedUSD' },
        { $cond: [{ $isNumber: '$costUSD' }, { $toDouble: '$costUSD' }, 0] },
      ],
    },
  });
  assert.deepEqual(group.legacyRows, { $sum: { $cond: [{ $isNumber: '$chargedUSD' }, 0, 1] } });
});

test('administrator usage never enters wallet charges and recorded extras stay separate', async () => {
  const { monthlyWindow, summarizeMonthlyBooks } = await modulePromise;
  const result = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [chat('private-admin-id', 'ADMIN', 12), chat('private-user-id', 'USER', 15)],
    [
      extra('private-admin-id', 'ADMIN', 7, 0),
      extra('private-user-id', 'USER', 2, 4),
      extra('private-user-id', 'USER', 3, 3, {
        legacyRows: 1,
        recordedChargedUSD: 0,
        inferredChargedUSD: 3,
      }),
      extra('private-admin-id', 'ADMIN', 0.15, 0, {
        voiceEstimateUSD: 0.15,
        voiceEstimateRows: 1,
      }),
    ],
    [],
  );
  assert.deepEqual(result.ownerExempt, { chatNominalUSD: 12, extrasNominalUSD: 7.15 });
  assert.deepEqual(result.nonAdmin, {
    chatChargedUSD: 15,
    extrasChargedUSD: 7,
    walletChargedUSD: 22,
    extrasRecordedChargedUSD: 4,
    extrasInferredChargedUSD: 3,
    walletRecordedChargedUSD: 19,
  });
  assert.deepEqual(result.extraRecords, {
    costUSD: 12.15,
    voiceEstimateUSD: 0.15,
    voiceEstimateRows: 1,
  });
  assert.equal(result.coverage.legacyExtraRows, 1);
  assert.equal(result.coverage.nonAdminLegacyExtraRows, 1);
  assert.equal(result.coverage.ownerLegacyExtraRows, 0);
  assert.match(result.coverage.ownerExtrasBasis, /recorded cost basis/);
  assert.match(result.coverage.legacyExtrasChargeBasis, /inferred/);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('missing and custom roles remain visible without being assigned wallet charges', async () => {
  const { monthlyWindow, summarizeMonthlyBooks } = await modulePromise;
  const result = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [
      chat('deleted-account', null, 2, 2, false),
      chat('custom-account', 'RESEARCHER', 4),
      chat(null, null, 1, 1, false),
      chat('admin-account', ' admin ', 3),
    ],
    [
      extra('deleted-account', null, 5, 10, { rows: 2, accountFound: false }),
      extra('custom-account', 'RESEARCHER', 6, 12),
    ],
    [],
  );
  assert.deepEqual(result.unclassified, { chatNominalUSD: 7, extrasNominalUSD: 11 });
  assert.deepEqual(result.nonAdmin, {
    chatChargedUSD: 0,
    extrasChargedUSD: 0,
    walletChargedUSD: 0,
    extrasRecordedChargedUSD: 0,
    extrasInferredChargedUSD: 0,
    walletRecordedChargedUSD: 0,
  });
  assert.equal(result.ownerExempt.chatNominalUSD, 3);
  assert.equal(result.coverage.unknownRoleRows, 7);
  assert.equal(result.coverage.unknownRoleAccounts, 2);
  assert.equal(result.coverage.missingAccountRows, 5);
  assert.equal(result.coverage.missingAccounts, 1);
  assert.deepEqual(result.coverage.recognizedRoles, ['ADMIN', 'USER']);
  assert.match(result.coverage.notes.join(' '), /Deleted-account records remain included/);
  assert.equal(JSON.stringify(result).includes('deleted-account'), false);
});

test('repayments and net grants do not change recorded usage charges', async () => {
  const { monthlyWindow, summarizeMonthlyBooks } = await modulePromise;
  const result = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [chat('user', 'USER', 10)],
    [],
    [
      { _id: 'repayment', usd: 30, count: 2 },
      { _id: 'grant', usd: 5, count: 1 },
      { _id: 'grant', usd: -2, count: 1 },
    ],
  );
  assert.deepEqual(result.repayments, { recordedUSD: 30, count: 2 });
  assert.deepEqual(result.grants, { netUSD: 3, count: 2 });
  assert.equal(result.nonAdmin.walletChargedUSD, 10);
});

test('refund-only months retain signed recorded and inferred extras separately', async () => {
  const { monthlyWindow, summarizeMonthlyBooks } = await modulePromise;
  const result = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [],
    [
      extra('user', 'USER', -2, -4),
      extra('user', 'USER', -1, -1, {
        legacyRows: 1,
        recordedChargedUSD: 0,
        inferredChargedUSD: -1,
      }),
    ],
    [],
  );
  assert.deepEqual(result.nonAdmin, {
    chatChargedUSD: 0,
    extrasChargedUSD: -5,
    walletChargedUSD: -5,
    extrasRecordedChargedUSD: -4,
    extrasInferredChargedUSD: -1,
    walletRecordedChargedUSD: -4,
  });
  assert.equal(result.extraRecords.costUSD, -3);
  assert.match(result.coverage.notes.join(' '), /signed net charges/);
});

test('owner legacy extras do not increase the non-administrator legacy count', async () => {
  const { monthlyWindow, summarizeMonthlyBooks } = await modulePromise;
  const result = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [],
    [
      extra('owner', 'ADMIN', 2, 2, {
        legacyRows: 1,
        recordedChargedUSD: 0,
        inferredChargedUSD: 2,
      }),
    ],
    [],
  );
  assert.equal(result.coverage.legacyExtraRows, 1);
  assert.equal(result.coverage.nonAdminLegacyExtraRows, 0);
  assert.equal(result.coverage.ownerLegacyExtraRows, 1);
  assert.equal(result.nonAdmin.walletChargedUSD, 0);
});

test('rounding happens after aggregation and before presentation only', async () => {
  const { monthlyWindow, summarizeMonthlyBooks } = await modulePromise;
  const result = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [chat('one', 'USER', 0.004), chat('two', 'USER', 0.004)],
    [extra('one', 'USER', 0.004, 0.004)],
    [
      { _id: 'grant', usd: -0.004, count: 1 },
      { _id: 'grant', usd: -0.004, count: 1 },
    ],
  );
  assert.equal(result.nonAdmin.chatChargedUSD, 0.01);
  assert.equal(result.nonAdmin.extrasChargedUSD, 0);
  assert.equal(result.nonAdmin.walletChargedUSD, 0.01);
  assert.equal(result.grants.netUSD, -0.01);
  const combined = summarizeMonthlyBooks(
    monthlyWindow(from, to),
    [chat('one', 'USER', 0.004)],
    [extra('one', 'USER', 0.004, 0.004)],
    [],
  );
  assert.equal(combined.nonAdmin.chatChargedUSD, 0);
  assert.equal(combined.nonAdmin.extrasChargedUSD, 0);
  assert.equal(combined.nonAdmin.walletChargedUSD, 0.01);
  assert.throws(
    () => summarizeMonthlyBooks(monthlyWindow(from, to), [chat('one', 'USER', NaN)], [], []),
    /non-finite aggregate/,
  );
});

test('monthlyBooks reads three aggregate pipelines and returns no individual records', async () => {
  const { monthlyWindow, monthlyBooks, monthlyPipelines } = await modulePromise;
  const window = monthlyWindow(from, to);
  const observed = [];
  const reader = (rows) => ({
    aggregate: async (pipeline) => {
      observed.push(pipeline);
      return rows;
    },
  });
  const result = await monthlyBooks(window, {
    Transaction: reader([chat('private-user', 'USER', 1)]),
    KadeUsage: reader([]),
    KadeFundingEntry: reader([]),
    userCollection: 'testusers',
  });
  const expected = monthlyPipelines(window, 'testusers');
  assert.deepEqual(observed, [expected.chat, expected.extras, expected.ledger]);
  assert.equal(result.version, 1);
  assert.deepEqual(result.window, {
    from: '2026-09-01T05:00:00.000Z',
    to: '2026-10-01T05:00:00.000Z',
    timeZone: 'America/Chicago',
    endExclusive: true,
  });
  assert.equal(JSON.stringify(result).includes('private-user'), false);
});

test('route contract requires JWT and administrator capability', () => {
  const route = readFileSync(path.join(__dirname, '../../../../api/server/routes/kade.js'), 'utf8');
  assert.match(route, /router\.get\('\/monthly-books', requireJwtAuth, requireAdminAccess,/);
  assert.match(
    route,
    /const requireAdminAccess = requireCapability\(SystemCapabilities\.ACCESS_ADMIN\)/,
  );
  const monthlyRoute = route.slice(
    route.indexOf("router.get('/monthly-books'"),
    route.indexOf("router.get('/work-options'"),
  );
  assert.match(monthlyRoute, /monthlyWindow\(req\.query\.from, req\.query\.to\)/);
  assert.match(monthlyRoute, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(monthlyRoute, /\.save\(|\.update|\.create\(/);
});
