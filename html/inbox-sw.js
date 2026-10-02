// Only public shell assets are cached. Never cache API/auth requests or task data.
const CACHE = 'todo-inbox-shell-v3';
const ASSETS = ['/inbox.html', '/styles.css', '/theme.js', '/inbox.css', '/inbox.js', '/inbox-store.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request).then(cached => cached || fetch(event.request))));
});
