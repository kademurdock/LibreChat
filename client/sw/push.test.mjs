import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./push.js', import.meta.url), 'utf8');
const agent = 'agent_NkG_Fb8_xLz8HFJyx4gNv';
function worker(crypto = undefined) {
  const events = new Map(),
    visits = [],
    shown = [];
  let serial = 0;
  const client = {
    navigate: async (url) => {
      visits.push(url);
      return client;
    },
    focus: async () => {},
  };
  const self = {
    location: { origin: 'https://kademurdock.com' },
    crypto: crypto === undefined ? { randomUUID: () => `fresh-${++serial}` } : crypto,
    addEventListener: (name, fn) => events.set(name, fn),
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: { matchAll: async () => [client], openWindow: async (url) => visits.push(url) },
  };
  runInNewContext(source, { self, URL });
  return { events, visits, shown };
}
test('announcement push retains the fixed agent destination and each click requests a fresh chat', async () => {
  const fixture = worker();
  let work;
  fixture.events.get('push')({
    data: {
      json: () => ({
        title: 'Meet Angel',
        body: 'Tiny Halloween wonder',
        announcementId: 'announcement-1',
        url: `https://kademurdock.com/c/new?agent_id=${agent}`,
        kadeRoute: 'agent-chat',
        kadeAgentId: agent,
      }),
    },
    waitUntil: (promise) => {
      work = promise;
    },
  });
  await work;
  const options = fixture.shown[0].options;
  assert.equal(options.tag, 'announcement-1');
  for (let i = 0; i < 2; i++) {
    fixture.events.get('notificationclick')({
      notification: { data: options.data, close() {} },
      waitUntil: (promise) => {
        work = promise;
      },
    });
    await work;
    const url = new URL(fixture.visits[i]);
    assert.equal(url.pathname, '/c/new');
    assert.equal(url.searchParams.get('agent_id'), agent);
    assert.equal(url.searchParams.get('fresh'), `fresh-${i + 1}`);
  }
});
test('a notification cannot navigate to an external destination', async () => {
  const fixture = worker();
  let work;
  fixture.events.get('notificationclick')({
    notification: { data: { url: 'https://external.invalid/' }, close() {} },
    waitUntil: (promise) => {
      work = promise;
    },
  });
  await work;
  assert.equal(fixture.visits[0], 'https://kademurdock.com/');
});

test('malformed notification URLs safely return home', async () => {
  const fixture = worker();
  let work;
  fixture.events.get('notificationclick')({
    notification: { data: { url: 'http://[' }, close() {} },
    waitUntil: (promise) => {
      work = promise;
    },
  });
  await work;
  assert.equal(fixture.visits[0], 'https://kademurdock.com/');
});

test('Angel links still open fresh chats when randomUUID is absent or throws', async () => {
  for (const crypto of [
    null,
    {},
    {
      randomUUID() {
        throw new Error('unavailable');
      },
    },
  ]) {
    const fixture = worker(crypto);
    let work;
    fixture.events.get('notificationclick')({
      notification: { data: { kadeRoute: 'agent-chat', kadeAgentId: agent }, close() {} },
      waitUntil: (promise) => {
        work = promise;
      },
    });
    await work;
    const url = new URL(fixture.visits[0]);
    assert.equal(url.pathname, '/c/new');
    assert.equal(url.searchParams.get('agent_id'), agent);
    assert.ok(url.searchParams.get('fresh'));
  }
});
