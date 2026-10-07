// Only public shell assets are cached. Never cache API/auth requests or task data.
const CACHE = 'todo-inbox-shell-v16';
// The agent module is public shell code, without model downloads or user data.
const ASSETS = [
  '/', '/index.html', '/help.html', '/shared.html',
  '/styles.css', '/theme.js', '/inbox.css', '/shared.css',
  '/inbox.js?v=14', '/plan.js?v=2', '/inbox-store.js?v=7', '/inbox-fields.js?v=2', '/inbox-export.js?v=9',
  '/collection-model.js?v=2', '/collections.js?v=3', '/workspace-move.js?v=3', '/workspaces.js?v=3',
  '/clarification.js?v=5', '/clarification-preferences.js?v=1', '/clarification-flow.js?v=3', '/reviews.js?v=7', '/briefs.js?v=3',
  '/capture-extraction.js?v=1', '/local-guidance.js?v=1', '/local-agent.js?v=1', '/shared.js?v=14',
  '/pwa.js?v=14', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', event => {
  if (event.data === 'shell-version') event.ports[0]?.postMessage(CACHE);
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate' && ['/', '/index.html', '/help.html', '/shared.html'].includes(url.pathname);
  if (!navigation && !ASSETS.includes(url.pathname + url.search)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(navigation ? url.pathname : event.request).then(cached => cached || fetch(event.request))));
});
