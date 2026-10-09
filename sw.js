/* WritePad service worker.
 *
 * Strategy: network-first for every same-origin GET, falling back to the
 * cache when offline. Successful network responses refresh the cache.
 * Core files are precached on install so the first offline launch works.
 *
 * Network-first means a fix pushed to GitHub Pages reaches devices on their
 * next launch. Nothing here ever reloads a page on its own, so a student
 * mid-exam is never interrupted by an update.
 *
 * Bump VERSION whenever any file changes so stale caches are purged.
 */

const VERSION = '1.0.0';
const CACHE = `writepad-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-48.png'
];

const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); },
                        (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Treat any navigation as a request for the app shell, ignoring query
  // strings like ?title=... so the cached copy still matches offline.
  const isNav = req.mode === 'navigate';
  const cacheKey = isNav ? './index.html' : url.pathname;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
      if (res && res.ok) {
        cache.put(cacheKey, res.clone()).catch(() => {});
      }
      return res;
    } catch (_) {
      const cached = await cache.match(cacheKey) || (isNav ? await cache.match('./') : undefined);
      if (cached) return cached;
      return new Response('Offline and not cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
