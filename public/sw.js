/* airloom-v27 service worker — cache-first for basemap tiles only.
 * Persists Bay Area tiles across visits on iPhone Safari / Android Chrome / CT47.
 * Never touches HTML, /adsb/*, /arrivals/* or /status (always live). */
const TILE_CACHE = 'airloom-tiles-v27';
const MAX_ENTRIES = 9000;
const isTile = (url) =>
  (url.origin === self.location.origin && /^\/tiles\/(sat|hill|orbit|relief|usgs)\/\d+\/\d+\/\d+/.test(url.pathname))
  || (/(^|\.)arcgisonline\.com$/.test(url.hostname) && /\/MapServer\/tile\/\d+\/\d+\/\d+/.test(url.pathname));

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('airloom-tiles-') && k !== TILE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

let puts = 0;
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  const drop = keys.length - MAX_ENTRIES + 500;
  for (let i = 0; i < drop; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (!isTile(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(TILE_CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
      const copy = res.clone();
      event.waitUntil(cache.put(req, copy).then(() => { if (++puts % 400 === 0) return trim(cache); }).catch(() => {}));
    }
    return res;
  })());
});
