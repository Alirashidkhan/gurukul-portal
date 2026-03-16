// Gurukul ERP Service Worker — PWA Support
const CACHE = 'gurukul-v1';
const OFFLINE_PAGE = '/portal/index.html';
const PRECACHE = [
  '/',
  '/portal/index.html',
  '/portal/admin-dashboard.html',
  '/portal/teacher-dashboard.html',
  '/portal/login.html',
  '/portal/parent-dashboard.html',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return; // Never cache API calls
  e.respondWith(
    fetch(e.request)
      .then(resp => { const clone = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); return resp; })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match(OFFLINE_PAGE)))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Gurukul ERP', body: 'New notification' };
  e.waitUntil(self.registration.showNotification(data.title || 'Gurukul ERP', {
    body: data.body || '',
    icon: '/assets/images/logo.png',
    badge: '/assets/images/logo.png',
    tag: data.tag || 'gurukul',
    data: data.url ? { url: data.url } : {},
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.notification.data && e.notification.data.url) {
    e.waitUntil(clients.openWindow(e.notification.data.url));
  }
});
