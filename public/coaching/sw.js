'use strict';

const CACHE_NAME = 'lion-elite-coaching-v2';
const APP_SHELL = [
  '/coaching/',
  '/coaching/index.html',
  '/coaching/styles.css',
  '/coaching/app.js',
  '/coaching/manifest.webmanifest',
  '/coaching/icons/icon.svg',
  '/coaching/icons/icon-192.png',
  '/coaching/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('lion-elite-coaching-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (!url.pathname.startsWith('/coaching/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/coaching/index.html')));
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});

self.addEventListener('push', event => {
  let payload = { title: 'Lion Elite Coaching', body: 'You have a new update.', url: '/coaching/', tag: 'lion-elite-update' };
  try { payload = { ...payload, ...event.data.json() }; } catch { /* Use privacy-safe fallback. */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/coaching/icons/icon-192.png',
    badge: '/coaching/icons/icon-192.png',
    tag: payload.tag,
    data: { url: payload.url },
    renotify: true
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/coaching/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => client.url.startsWith(`${self.location.origin}/coaching/`));
      if (existing) {
        existing.navigate(target);
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
