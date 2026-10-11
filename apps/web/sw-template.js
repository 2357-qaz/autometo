/* AuTomeDo service worker — generated at build time (see pwa-plugin.ts). */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `automedo-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', ...PRECACHE])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('automedo-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/v1/')) return; // sync API: always live
  if (req.mode === 'navigate') {
    // App shell: network first so updates arrive, cached copy when offline.
    // Only a good HTML response may replace the cached shell; on a server error,
    // prefer the last known-good shell over the error page.
    const cached = () => caches.match('./', { ignoreSearch: true });
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          const html = (res.headers.get('content-type') || '').includes('text/html');
          if (res.ok && html) {
            const copy = res.clone();
            const write = caches.open(CACHE).then((c) => c.put('./', copy));
            if (event.waitUntil) event.waitUntil(write);
            return res;
          }
          if (res.status >= 500) return (await cached()) || res;
          return res;
        })
        .catch(cached),
    );
    return;
  }
  // Hashed assets and icons: cache first.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.includes('/assets/')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'AuTomeDo', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'AuTomeDo', {
      body: data.body || '',
      tag: data.tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: data.url || './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.postMessage({ type: 'open', url: target });
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
