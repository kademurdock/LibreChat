/** Kade's yes before Forge ships: her words, the button, and what is never kept. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

let mongo;
let approvals;
let turn;
const calls = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  process.env.KADE_APPROVAL_SECRET = 'approval-key';
  process.env.BRIDGE_SECRET = 'bridge-key';
  approvals = require('./kadeApprovals');
  turn = require('./kadeCharacterTurn');
  jest.spyOn(turn, 'post').mockResolvedValue({ conversationId: 'c-forge', messageId: 'm1', created: false });
  jest.spyOn(turn, 'notifyPost').mockResolvedValue({ ok: true });
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).endsWith('/approvals/execute')) {
      const body = JSON.parse(opts.body);
      if (body.kind === 'railway-vars') return { ok: true, status: 200, json: async () => ({ ok: true, result: { set: true, name: body.params.name } }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { merged: true, sha: 'abcdef1234567890', watchingDeploy: true } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) };
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('her words: a plain yes approves; any hold-on word does not', () => {
  for (const yes of ['yes', 'Yeah, ship it', 'go ahead and merge it', 'ok do it', 'approved']) expect(approvals.herWordsApprove(yes)).toBe(true);
  for (const no of ['no', "don't merge that yet", 'wait', 'yes but hold on', 'not yet', 'what does it change?', '']) expect(approvals.herWordsApprove(no)).toBe(false);
});

test('a request is recorded, pings her phone, and runs on approve; the outcome is posted to her', async () => {
  const { approvalId } = await approvals.create({ kind: 'github-merge', params: { owner: 'kademurdock', repo: 'LibreChat', number: 7 }, summary: 'Merge pull request 7 into kade.', agentId: 'agent_forge' });
  expect(approvalId).toMatch(/^a[0-9a-f]{10}$/);
  const push = calls.find((c) => String(c.url).endsWith('/notify'));
  expect(JSON.parse(push.opts.body)).toMatchObject({ route: 'approvals', adminAlert: true, urgent: true });
  const listed = await approvals.list();
  expect(listed[0]).toMatchObject({ approvalId, status: 'pending', summary: 'Merge pull request 7 into kade.' });
  expect(listed[0].params).toBeUndefined();

  const done = await approvals.decide({ approvalId, decision: 'approve', by: 'button' });
  expect(done).toMatchObject({ status: 'done', decidedBy: 'button' });
  expect(done.resultWords).toMatch(/Merged as abcdef123456; I am watching the deploy/);
  const exec = calls.find((c) => String(c.url).endsWith('/approvals/execute'));
  expect(exec.opts.headers['x-kade-approval-secret']).toBe('approval-key');
  expect(turn.post).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent_forge', kind: 'approval' }));

  await expect(approvals.decide({ approvalId, decision: 'approve', by: 'button' })).rejects.toThrow(/already done/);
});

test('a setting\'s value is gone once the request has run', async () => {
  const { approvalId } = await approvals.create({ kind: 'railway-vars', params: { name: 'X', value: 'secret-value' }, summary: 'Set X (value hidden).' });
  await approvals.decide({ approvalId, decision: 'approve', by: 'words' });
  const raw = await mongoose.connection.collection('kadeapprovals').findOne({ approvalId });
  expect(raw.params.value).toBeUndefined();
  expect(raw.params.name).toBe('X');
});

test('deny runs nothing; an expired request cannot be approved', async () => {
  const before = calls.filter((c) => String(c.url).endsWith('/approvals/execute')).length;
  const a = await approvals.create({ kind: 'railway-deploy', params: { commitSha: 'abc' }, summary: 'Deploy abc.' });
  const out = await approvals.decide({ approvalId: a.approvalId, decision: 'deny', by: 'words' });
  expect(out.status).toBe('denied');
  const b = await approvals.create({ kind: 'railway-deploy', params: { commitSha: 'def' }, summary: 'Deploy def.' });
  await mongoose.connection.collection('kadeapprovals').updateOne({ approvalId: b.approvalId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expect(approvals.decide({ approvalId: b.approvalId, decision: 'approve', by: 'button' })).rejects.toThrow(/expired/);
  expect(calls.filter((c) => String(c.url).endsWith('/approvals/execute')).length).toBe(before);
});

test('the went-live report reaches her', async () => {
  const { approvalId } = await approvals.create({ kind: 'github-merge', params: { owner: 'k', repo: 'r', number: 1 }, summary: 'Merge 1.' });
  await approvals.followup({ approvalId, deploy: { status: 'SUCCESS', service: 'the website', commitSha: 'abc123' } });
  const a = await approvals.get(approvalId);
  expect(a.deployWords).toBe("It's live: the website is running abc123.");
});
