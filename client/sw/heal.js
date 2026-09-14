/* Runs inside the generated service worker via workbox `importScripts`.
 * When a new build's worker activates, pages served from a previous build
 * can no longer load their hashed chunks (the old precache is purged) and
 * carry no recovery code of their own — the worker is the only code path
 * stale clients fetch fresh. Only visible chat-app routes participate.
 * Standalone tools (Sound Booth, Library, etc.) do not use these chunks
 * or the app's ping listener; silence is not evidence that they broke. */
const PING_TYPE = 'LC_SW_PING';
const PONG_TYPE = 'LC_SW_PONG';
const PONG_TIMEOUT_MS = 1500;

const pendingPongs = new Map();

function isRecoverableAppClient(client) {
  if (client.frameType === 'nested' || client.visibilityState !== 'visible') return false;
  try {
    const scope = new URL(self.registration.scope);
    const url = new URL(client.url);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
    const path = url.pathname.slice(scope.pathname.length);
    return /^(?:$|(?:c|search|login|register|forgot-password|reset-password|verify|oauth|share|d|agent-builder|bookmarks|memories|files|settings|prompts|skills|projects|agents)(?:\/|$))/.test(path);
  } catch {
    return false;
  }
}

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== PONG_TYPE || !event.source) {
    return;
  }
  const resolvePong = pendingPongs.get(event.source.id);
  if (resolvePong) {
    pendingPongs.delete(event.source.id);
    resolvePong(true);
  }
});

function pingClient(client) {
  return new Promise((resolve) => {
    pendingPongs.set(client.id, resolve);
    setTimeout(() => {
      if (pendingPongs.delete(client.id)) {
        resolve(false);
      }
    }, PONG_TIMEOUT_MS);
    client.postMessage({ type: PING_TYPE });
  });
}

async function reloadUnresponsiveClients() {
  await self.clients.claim();
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const topLevelClients = windowClients.filter(isRecoverableAppClient);
  await Promise.all(
    topLevelClients.map(async (client) => {
      const responsive = await pingClient(client);
      if (responsive) {
        return;
      }
      try {
        // The user may have switched tabs or opened a tool while the ping waited.
        const current = await self.clients.get(client.id);
        if (current && current.url === client.url && isRecoverableAppClient(current)) {
          await current.navigate(current.url);
        }
      } catch {
        /* client closed or no longer controllable */
      }
    }),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(reloadUnresponsiveClients());
});
