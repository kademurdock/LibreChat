const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const filename = path.join(__dirname, 'tubevault.ts');
const compiled = new Module(filename, module);
compiled._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  filename,
);
const { tubeVaultDecision, tubeVaultHints, validTubeVaultItems } = compiled.exports;
const item = { title: 'sample.mp4', station: '', rejected: false };
const answers = (location = 'elsewhere', kind = 'commercial', confidence = 0.95) => ({
  location: { choice: location, confidence },
  kind: { choice: kind, confidence: 0.95 },
});
test('uncertain geography stays in Maybe Local even when kind is confident', () => {
  assert.equal(
    tubeVaultDecision(item, answers('elsewhere', 'commercial', 0.64)).shelf,
    'Unsorted (Review Me)/Maybe Local',
  );
  assert.equal(
    tubeVaultDecision(item, answers('unclear')).shelf,
    'Unsorted (Review Me)/Maybe Local',
  );
});
test('local evidence wins over a product kind', () => {
  assert.equal(tubeVaultDecision(item, answers('ozarks')).shelf, 'Ozarks (Springfield Area)');
});
test('unknown recording kinds and low confidence cannot reach a product shelf', () => {
  assert.equal(
    tubeVaultDecision(item, answers('elsewhere', 'unclear')).shelf,
    'Unsorted (Review Me)',
  );
  const a = answers();
  a.kind.confidence = 0.84;
  assert.equal(tubeVaultDecision(item, a).shelf, 'Unsorted (Review Me)');
});
test('malformed probabilities and labels fail closed', () => {
  for (const confidence of [NaN, Infinity, -1, 1.1, '0.99']) {
    assert.equal(tubeVaultDecision(item, answers('ozarks', 'commercial', confidence)), null);
  }
  assert.equal(tubeVaultDecision(item, answers('../escape')), null);
  assert.equal(tubeVaultDecision(item, {}), null);
});
test('station judgment cannot silently discard a possibly local recording', () => {
  const rejected = { ...item, station: 'KING', rejected: true };
  const a = { ...answers('ozarks'), station: { choice: 'elsewhere', confidence: 0.99 } };
  assert.equal(tubeVaultDecision(rejected, a).shelf, 'Unsorted (Review Me)/Maybe Local');
  a.location.choice = 'elsewhere';
  assert.equal(tubeVaultDecision(rejected, a).shelf, '');
  a.station.choice = 'not_a_station';
  assert.equal(tubeVaultDecision(rejected, a).shelf, 'Commercials/Other Commercials');
  a.station.choice = 'inside';
  assert.equal(tubeVaultDecision(rejected, a).shelf, 'Ozarks (Springfield Area)');
  a.station.confidence = 0.84;
  assert.equal(tubeVaultDecision(rejected, a).shelf, 'Unsorted (Review Me)/Maybe Local');
});
test('request validation bounds work before any provider call', () => {
  assert(validTubeVaultItems([item]));
  for (const rows of [
    null,
    [],
    [null],
    [{ ...item, title: 'x'.repeat(501) }],
    Array(51).fill(item),
    [{ ...item, rejected: 'true' }],
  ]) {
    assert.equal(validTubeVaultItems(rows), false);
  }
});
test('successful hints are cached; failed judgments remain retryable', async () => {
  let calls = 0;
  const ask = async () => {
    calls++;
    return { answers: answers(), usage: { input_tokens: 100 } };
  };
  const rows = [{ ...item, title: 'cache-check.mp4' }];
  assert.equal((await tubeVaultHints(rows, ask)).hints.length, 1);
  assert.equal((await tubeVaultHints(rows, ask)).inputTokens, 0);
  assert.equal(calls, 1);
  rows[0].title = 'failed-check.mp4';
  assert.equal(
    (
      await tubeVaultHints(rows, async () => {
        throw Error('provider unavailable');
      })
    ).failed.length,
    1,
  );
  assert.equal((await tubeVaultHints(rows, ask)).hints.length, 1);
});
