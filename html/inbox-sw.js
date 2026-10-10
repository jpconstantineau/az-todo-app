// Only public shell assets are cached. Never cache API/auth requests or task data.
const CACHE = 'todo-inbox-shell-v40';
// The agent module is public shell code, without model downloads or user data.
const ASSETS = [
  '/', '/index.html', '/help.html', '/shared.html',
  '/styles.css', '/theme.js', '/inbox.css', '/shared.css',
  '/inbox.js?v=38', '/inbox.js?v=37', '/inbox.js?v=36', '/inbox.js?v=35', '/inbox.js?v=34', '/inbox.js?v=33', '/inbox.js?v=32', '/inbox.js?v=31', '/inbox.js?v=30', '/inbox.js?v=29', '/inbox.js?v=28', '/inbox.js?v=27', '/inbox.js?v=26', '/inbox.js?v=25', '/inbox.js?v=24', '/inbox.js?v=23', '/plan.js?v=5', '/plan.js?v=4', '/inbox-store.js?v=17', '/inbox-store.js?v=16', '/inbox-store.js?v=15', '/inbox-store.js?v=14', '/inbox-store.js?v=13', '/inbox-store.js?v=12', '/inbox-store.js?v=11', '/inbox-store.js?v=10', '/inbox-store.js?v=9', '/inbox-fields.js?v=5', '/inbox-fields.js?v=4', '/inbox-fields.js?v=3', '/inbox-fields.js?v=2', '/inbox-export.js?v=19', '/inbox-export.js?v=18', '/inbox-export.js?v=17', '/inbox-export.js?v=16', '/inbox-export.js?v=15', '/inbox-export.js?v=14', '/inbox-export.js?v=13', '/inbox-export.js?v=12', '/local-defaults.js?v=1', '/search-model.js?v=1',
  '/collection-model.js?v=5', '/collection-model.js?v=4', '/collection-model.js?v=3', '/collections.js?v=5', '/collections.js?v=4', '/workspace-move.js?v=5', '/workspace-move.js?v=4', '/workspaces.js?v=5', '/workspaces.js?v=4', '/recurrence-model.js?v=1', '/recurrence-ui.js?v=3', '/recurrence-ui.js?v=2', '/recurrence-ui.js?v=1',
  '/clarification.js?v=13', '/clarification.js?v=12', '/clarification.js?v=11', '/clarification.js?v=10', '/clarification.js?v=9', '/clarification.js?v=8', '/clarification-preferences.js?v=3', '/clarification-preferences.js?v=2', '/clarification-flow.js?v=4', '/reviews.js?v=11', '/reviews.js?v=10', '/reviews.js?v=9', '/briefs.js?v=6', '/briefs.js?v=5', '/briefs.js?v=4', '/project-planning.js?v=1', '/project-planning-model.js?v=1',
  '/capture-extraction.js?v=5', '/capture-extraction.js?v=4', '/capture-extraction.js?v=3', '/capture-extraction.js?v=2', '/capture-cloud-preference.js?v=1', '/local-guidance.js?v=3', '/local-guidance.js?v=2', '/local-guidance.js?v=1', '/local-agent.js?v=2', '/local-agent.js?v=1', '/cloud-ai.js?v=1', '/shared.js?v=36', '/shared.js?v=35', '/shared.js?v=34', '/shared.js?v=33', '/shared.js?v=32', '/shared.js?v=31', '/shared.js?v=30', '/shared.js?v=29', '/shared.js?v=28', '/shared.js?v=27', '/shared.js?v=26', '/shared.js?v=25', '/shared.js?v=24', '/shared.js?v=23', '/shared.js?v=22', '/shared.js?v=21',
  '/pwa.js?v=36', '/pwa.js?v=35', '/pwa.js?v=34', '/pwa.js?v=33', '/pwa.js?v=32', '/pwa.js?v=31', '/pwa.js?v=30', '/pwa.js?v=29', '/pwa.js?v=28', '/pwa.js?v=27', '/pwa.js?v=26', '/pwa.js?v=25', '/pwa.js?v=24', '/pwa.js?v=23', '/pwa.js?v=22', '/pwa.js?v=21', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(ASSETS);
    // This compatibility URL is used by offline recovery checks and older open tabs.
    await cache.add('/inbox-store.js?v=9');
  }));
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
