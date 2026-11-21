/* TeamTask — Web Push service worker.
 *
 * Lives at the site root (next to index.html) so its scope covers the
 * whole app. It does NO network calls of its own: it only shows the
 * notification the Edge Function sent and opens/focuses the app when
 * the notification is tapped.
 *
 * No icon is set: at the time this file was written the deploy
 * directory contained no icon asset (no .png/.svg/manifest). Add an
 * `icon` (and `badge`) to showNotification below once a real app icon
 * ships — do not point at an asset that does not exist.
 */

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_e) {
      // Non-JSON payload: treat the raw text as the body.
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'TeamTask';
  const body = data.body || '';
  const url = data.url || './';

  const promise = self.registration.showNotification(title, {
    body,
    data: { url },
    tag: 'teamtask', // collapses repeat notifications into one entry
  });
  event.waitUntil(promise);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';

  const promise = self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => {
      // Focus an already-open app tab if there is one.
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      // Otherwise open the app at the notification's URL.
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    });
  event.waitUntil(promise);
});
