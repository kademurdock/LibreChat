/* Public regression fixtures: every name, archive, account and source is invented. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { familyHistoryToolSchema, readFamilyHistoryTool } from './tool';
import type { FamilyToolCall } from './tool';

function fixture(options: { denied?: boolean; multiple?: boolean; storyStatus?: number } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const call: FamilyToolCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/archives') return { status: 200, body: { archives: [{ id: 'default' }, ...(options.multiple ? [{ id: 'second' }] : [])] } };
    if (path === '/me?archive=default') return options.denied
      ? { status: 403, body: { error: 'Private archive unavailable.' } }
      : { status: 200, body: { viewer: { inTree: false } } };
    if (path === '/stories?v=2&archive=default') return { status: 200, body: { stories: [{ slug: 'invented-farm' }] } };
    if (path === '/story/invented-farm?v=2&archive=default') return options.storyStatus
      ? { status: options.storyStatus, body: { error: 'Source unavailable.' } }
      : { status: 200, body: { markdown: '# An invented farm\n\nA synthetic source.', whoswho: [{ id: '@I1@', name: 'Example Person' }] } };
    throw new Error(`Unexpected route: ${method} ${path}`);
  };
  return { call, calls };
}

test('schema exposes saved stories and exact slugs without accepting actor fields', () => {
  const schema = familyHistoryToolSchema as { additionalProperties: boolean; properties: Record<string, { enum?: string[] }> };
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.action.enum?.includes('stories'));
  assert.ok(schema.properties.action.enum?.includes('story'));
  assert.ok(schema.properties.story_slug);
  assert.equal(schema.properties.userId, undefined);
});

test('stories and story use read-only archive routes and preserve the entire saved reply', async () => {
  const { call, calls } = fixture();
  const catalog = await readFamilyHistoryTool({ action: 'stories', archive: 'default' }, call) as Record<string, unknown>;
  assert.deepEqual(catalog.result, { stories: [{ slug: 'invented-farm' }] });
  const story = await readFamilyHistoryTool({ action: 'story', archive: 'default', story_slug: 'invented-farm' }, call) as Record<string, unknown>;
  assert.deepEqual(story.result, { markdown: '# An invented farm\n\nA synthetic source.', whoswho: [{ id: '@I1@', name: 'Example Person' }] });
  assert.deepEqual(story.accountContext, { viewer: { inTree: false } });
  assert.ok(typeof story.guidance === 'string');
  assert.ok(calls.every(({ method, body }) => method === 'GET' && body === undefined));
});

test('an existing access refusal stops before reading a private story', async () => {
  const { call, calls } = fixture({ denied: true });
  assert.deepEqual(await readFamilyHistoryTool({ action: 'story', archive: 'default', story_slug: 'invented-farm' }, call), { error: 'Private archive unavailable.' });
  assert.deepEqual(calls.map(({ path }) => path), ['/archives', '/me?archive=default']);
});

test('invalid slugs never become story or arbitrary storage routes', async () => {
  for (const story_slug of ['', '../current', 'a/b', 'https://example.invalid', 'A-story', 'a'.repeat(121)]) {
    const { call, calls } = fixture();
    const reply = await readFamilyHistoryTool({ action: 'story', archive: 'default', story_slug }, call) as Record<string, unknown>;
    assert.ok(reply.error);
    assert.ok(calls.every(({ path }) => !path.startsWith('/story/')));
  }
});

test('multiple archives require explicit selection and model arguments cannot set the actor', async () => {
  const multiple = fixture({ multiple: true });
  const reply = await readFamilyHistoryTool({ action: 'story', story_slug: 'invented-farm' }, multiple.call) as Record<string, unknown>;
  assert.ok(reply.error);
  assert.equal(multiple.calls.length, 1);
  const override = fixture();
  assert.ok((await readFamilyHistoryTool({ action: 'story', archive: 'default', story_slug: 'invented-farm', userId: 'invented-owner' }, override.call) as Record<string, unknown>).error);
  assert.equal(override.calls.length, 0);
});

test('story route failures remain failures without leaking a successful result', async () => {
  const { call } = fixture({ storyStatus: 404 });
  const reply = await readFamilyHistoryTool({ action: 'story', archive: 'default', story_slug: 'invented-farm' }, call) as Record<string, unknown>;
  assert.deepEqual(reply.error, { error: 'Source unavailable.' });
  assert.equal(reply.result, undefined);
});

test('story retrieval does not weaken the existing explicit note-save requirement', async () => {
  const { call, calls } = fixture();
  assert.ok((await readFamilyHistoryTool({ action: 'save_note', archive: 'default', text: 'Invented note.' }, call) as Record<string, unknown>).error);
  assert.ok(calls.every(({ method }) => method === 'GET'));
});
