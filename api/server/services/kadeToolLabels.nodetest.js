'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { LABELS, spokenToolLabel, withToolLabels } = require('./kadeToolLabels');

test('every kade_ tool has a spoken label', () => {
  const dir = path.join(__dirname, '../../app/clients/tools/structured');
  const missing = [];
  let found = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!/^Kade[A-Za-z]+\.js$/.test(file)) continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of source.matchAll(/this\.name\s*=\s*'(kade_[a-z_]+)'/g)) {
      found += 1;
      if (!LABELS[m[1]]) missing.push(m[1]);
    }
  }
  assert.ok(found >= 36, `scan found only ${found} kade_ tool names`);
  assert.deepStrictEqual(missing, []);
});

test('labels line up with tool_calls and leave data alone', () => {
  const frame = {
    event: 'on_run_step',
    data: {
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ name: 'web_search' }, { function: { name: 'kade_known' } }, {}],
      },
    },
  };
  const out = withToolLabels(frame);
  assert.deepStrictEqual(out.kade.toolLabels, ['web search', 'what I know', '']);
  assert.strictEqual(out.data, frame.data);
  assert.strictEqual(
    withToolLabels({ event: 'on_run_step', data: { stepDetails: { type: 'message_creation' } } })
      .kade,
    undefined,
  );
  assert.strictEqual(spokenToolLabel('startHarnessRun_action_a2FkZS1oYX'), 'start harness run');
});

test('fail-soft on odd frames', () => {
  assert.strictEqual(withToolLabels(null), null);
  assert.strictEqual(withToolLabels(undefined), undefined);
  const noCalls = {
    event: 'on_run_step',
    data: { stepDetails: { type: 'tool_calls', tool_calls: [] } },
  };
  assert.strictEqual(withToolLabels(noCalls), noCalls);
  assert.strictEqual(spokenToolLabel(undefined), '');
});

test('KADE_TOOL_LABELS=0 sends the plain frame', () => {
  const frame = {
    event: 'on_run_step',
    data: { stepDetails: { type: 'tool_calls', tool_calls: [{ name: 'web_search' }] } },
  };
  const before = process.env.KADE_TOOL_LABELS;
  process.env.KADE_TOOL_LABELS = '0';
  try {
    assert.strictEqual(withToolLabels(frame), frame);
  } finally {
    if (before === undefined) delete process.env.KADE_TOOL_LABELS;
    else process.env.KADE_TOOL_LABELS = before;
  }
});
