const offlineCache = 'les-manager-offline-v2';
const offlinePage = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(offlineCache).then(cache => cache.add(offlinePage)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith('les-manager-offline-') && name !== offlineCache)
    .map(name => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' || url.origin !== self.location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(offlinePage)) ?? Response.error()));
});
