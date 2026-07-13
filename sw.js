// ════════════════════════════════════════════════════
//  Karpathos UAS Grid Tool — Service Worker v2
//  Strategy:
//    App shell  → cache-first (install-time)
//    CDN assets → cache-first (cache on first fetch)
//    Map tiles  → stale-while-revalidate (cache grows as user browses)
//    Other      → network-first, fall back to cache
// ════════════════════════════════════════════════════

const CACHE_NAME = 'uas-grid-v3';

const APP_SHELL = [
  './manifest.json',
  // Leaflet CSS is inlined in index.html; cache the JS from primary CDN
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  // HTML pages are intentionally NOT pre-cached — always fetch fresh from server
];

// ── INSTALL: pre-cache app shell ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install failed:', err))
  );
});

// ── ACTIVATE: remove stale caches ────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // Tiles now served from same-origin /tiles/ proxy — match by path
  const isTile =
    (url.origin === self.location.origin && url.pathname.startsWith('/tiles/')) ||
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('arcgisonline.com');

  const isCDN = url.hostname === 'cdnjs.cloudflare.com';

  // Map tiles: serve from cache if available, fetch & cache in background
  if (isTile) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req).then(cached => {
          const networkFetch = fetch(req).then(resp => {
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
          }).catch(() => null);
          // Return cached immediately if available; otherwise wait for network
          return cached ?? networkFetch;
        })
      )
    );
    return;
  }

  // CDN assets: cache-first
  if (isCDN) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(resp => {
          if (resp && resp.ok) {
            caches.open(CACHE_NAME).then(c => c.put(req, resp.clone()));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Everything else (app shell, index.html, manifest): network-first → cache fallback
  event.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});
