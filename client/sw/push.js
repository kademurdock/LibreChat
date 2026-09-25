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
    data: { url: data.url || '/' },
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
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
