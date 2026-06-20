/* ============================================================
   ACC LMS — Service Worker  v7.0.0
   Arabian Cement Company Lubrication Management System
   Phase 7 — Security + Performance + Background Sync

   Changes from v5.0.0:
     - Cache version bumped to acc-lms-v7.0.0 (F-07)
     - Background Sync handler for offline queue
     - Improved activate: clean ALL stale caches
============================================================ */

const CACHE_VERSION = 'acc-lms-v7.0.0';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;

// Core assets that must be cached for offline use
const STATIC_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/tokens.css',
  'css/base.css',
  'css/sidebar.css',
  'css/login.css',
  'js/core.js',
  'js/shell.js',
  'js/i18n/en.json',
  'js/i18n/ar.json',
  'assets/logo.png',
  'pages/dashboard.html',
  'pages/points.html',
  'pages/pending.html',
  'pages/history.html',
  'pages/analysis.html',
  'pages/reports.html',
  'pages/notifications.html',
  'pages/users.html',
  'pages/settings.html',
  'offline.html',
];

const CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Cairo:wght@400;500;600;700&display=swap',
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing v7.0.0...');
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => {
      return caches.open(DYNAMIC_CACHE).then(cache => {
        return Promise.allSettled(
          CDN_ASSETS.map(url =>
            fetch(url, { mode: 'no-cors' })
              .then(res => cache.put(url, res))
              .catch(() => {})
          )
        );
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating v7.0.0, cleaning old caches...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch Strategy ────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Skip Google Apps Script API calls
  if (url.hostname.includes('script.google.com') ||
      (url.hostname.includes('googleapis.com') && url.pathname.includes('/macros/'))) {
    return;
  }

  if (request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

// ── Background Sync (Phase 7 — Offline Queue) ────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'acc-lms-offline-sync') {
    console.log('[SW] Background Sync triggered: acc-lms-offline-sync');
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'SYNC_FLUSH' })
        );
      })
    );
  }
});

// ── Strategy: Network-First (HTML) ───────────────────────────
async function networkFirstHTML(request) {
  try {
    const networkRes = await fetch(request);
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, networkRes.clone());
    return networkRes;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match('/offline.html');
  }
}

// ── Strategy: Cache-First (Static Assets) ────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const networkRes = await fetch(request);
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, networkRes.clone());
    return networkRes;
  } catch {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

// ── Strategy: Stale-While-Revalidate (Fonts) ─────────────────
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(DYNAMIC_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then(res => {
    cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || networkFetch || new Response('Font unavailable', { status: 503 });
}

// ── Helpers ──────────────────────────────────────────────────
function isStaticAsset(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return ['css', 'js', 'json', 'png', 'jpg', 'svg', 'ico', 'woff', 'woff2'].includes(ext);
}

// ── Push Notifications ────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'ACC LMS', {
      body:  data.body  || '',
      icon:  '/assets/logo.png',
      badge: '/assets/logo.png',
      tag:   data.tag   || 'acc-lms',
      data:  data.url   ? { url: data.url } : {},
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/pages/dashboard.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
