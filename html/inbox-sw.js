// Only public shell assets are cached. Never cache API/auth requests or task data.
const CACHE = 'todo-inbox-shell-v26';
// The agent module is public shell code, without model downloads or user data.
const ASSETS = [
  '/', '/index.html', '/help.html', '/shared.html',
  '/styles.css', '/theme.js', '/inbox.css', '/shared.css',
  '/inbox.js?v=24', '/inbox.js?v=23', '/inbox.js?v=22', '/plan.js?v=4', '/inbox-store.js?v=12', '/inbox-store.js?v=11', '/inbox-store.js?v=10', '/inbox-store.js?v=9', '/inbox-fields.js?v=4', '/inbox-fields.js?v=3', '/inbox-fields.js?v=2', '/inbox-export.js?v=14', '/inbox-export.js?v=13', '/inbox-export.js?v=12',
  '/collection-model.js?v=4', '/collection-model.js?v=3', '/collections.js?v=4', '/workspace-move.js?v=5', '/workspace-move.js?v=4', '/workspaces.js?v=4', '/recurrence-model.js?v=1', '/recurrence-ui.js?v=2', '/recurrence-ui.js?v=1',
  '/clarification.js?v=9', '/clarification.js?v=8', '/clarification-preferences.js?v=2', '/clarification-flow.js?v=4', '/reviews.js?v=10', '/reviews.js?v=9', '/briefs.js?v=4',
  '/capture-extraction.js?v=2', '/local-guidance.js?v=1', '/local-agent.js?v=1', '/shared.js?v=22', '/shared.js?v=21', '/shared.js?v=20',
  '/pwa.js?v=22', '/pwa.js?v=21', '/pwa.js?v=20', '/manifest.json',
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
