import test from 'node:test';
import assert from 'node:assert/strict';
import { agentChatLaunch, needsAgentChatLaunch } from './agent-chat-launch.ts';
import { getPostLoginRedirect, persistRedirectToSession } from '../utils/redirect.ts';

const agentId = 'agent_NkG_Fb8_xLz8HFJyx4gNv';
const path = `/c/new?agent_id=${agentId}`;
const request = (key, search = `?agent_id=${agentId}`) => agentChatLaunch('new', search, key);

test('an explicit Angel launch initializes a fresh chat even when an old or same-agent draft is already set', () => {
  assert.equal(request('notification').agentId, agentId);
  assert.equal(needsAgentChatLaunch(request('notification'), null, 'POP'), true);
  assert.equal(needsAgentChatLaunch(request('new-tap'), request('previous-tap'), 'PUSH'), true);
  assert.equal(
    needsAgentChatLaunch(
      request('new-tap', `?agent_id=${agentId}&fresh=2`),
      request('old-tap'),
      'REPLACE',
    ),
    true,
  );
});

test('internal focus and route replacements do not repeatedly erase the new draft', () => {
  const consumed = request('notification');
  assert.equal(needsAgentChatLaunch(consumed, consumed, 'POP'), false);
  assert.equal(needsAgentChatLaunch(request('focus-replacement'), consumed, 'REPLACE'), false);
  assert.equal(
    needsAgentChatLaunch(request('second-focus-replacement'), consumed, 'REPLACE'),
    false,
  );
  assert.equal(needsAgentChatLaunch(request('back-to-link'), consumed, 'POP'), true);
});

test('old conversation paths and malformed identities are not launch commands', () => {
  assert.equal(agentChatLaunch('old-conversation', `?agent_id=${agentId}`, 'a'), null);
  for (const search of ['', '?agent_id=Angel', '?agent_id=agent_', '?agent_id=agent_%2Fwrong'])
    assert.equal(agentChatLaunch('new', search, 'a'), null);
});

test('sign-in continuation preserves the exact new-chat agent query through URL and stored redirects', () => {
  const items = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
  assert.equal(getPostLoginRedirect(new URLSearchParams({ redirect_to: path })), path);
  persistRedirectToSession(path);
  assert.equal(getPostLoginRedirect(new URLSearchParams()), path);
  assert.equal(getPostLoginRedirect(new URLSearchParams()), null);
});
