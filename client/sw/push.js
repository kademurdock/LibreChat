/* Runs inside the generated service worker via workbox `importScripts`
 * (same mechanism as sw-heal.js). Handles Web Push for the Kade nudge
 * engine: reminders, birthdays, and anything else the server sends.
 * iOS note: push only reaches installed Home Screen PWAs (16.4+), which is
 * how this app is used anyway. Payload: { title, body, url }. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Kade-AI';
  const options = {
    body: data.body || '',
    data: { url: data.url || '/', kadeRoute: data.kadeRoute, kadeAgentId: data.kadeAgentId },
    ...(data.announcementId ? { tag: String(data.announcementId) } : {}),
    /* icon/badge reuse the PWA's own assets so nudges look native.
     * KADE Sep 25 2026: the brass-dots install icon, and the braille K
     * (dots 1 and 3) as a transparent mask, because Android draws a badge
     * from its alpha channel only. The old files stay on disk. */
    icon: '/assets/art/icon-brass-dots-192.png',
    badge: '/assets/art/icon-brass-dots-badge-96.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = new URL('/', self.location.origin);
  try {
    target = new URL(typeof data.url === 'string' ? data.url : '/', self.location.origin);
  } catch {
    /* use home */
  }
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  if (
    data.kadeRoute === 'agent-chat' &&
    /^agent_[A-Za-z0-9_-]{1,100}$/.test(data.kadeAgentId || '')
  ) {
    target = new URL('/c/new', self.location.origin);
    target.searchParams.set('agent_id', data.kadeAgentId);
    let nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    try {
      if (self.crypto?.randomUUID) nonce = self.crypto.randomUUID();
    } catch {
      /* retain the route nonce */
    }
    target.searchParams.set('fresh', nonce);
  }
  const url = target.href;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            try {
              const navigated = await client.navigate(url);
              return (navigated || client).focus();
            } catch {
              return self.clients.openWindow(url);
            }
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
