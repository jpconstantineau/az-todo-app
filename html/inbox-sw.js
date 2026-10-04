// Only public shell assets are cached. Never cache API/auth requests or task data.
const CACHE = 'todo-inbox-shell-v54';
// The agent module is public shell code, without model downloads or user data.
const ASSETS = ['/capture-extraction.js?v=54', '/workspaces.js', '/workspaces.js?v=54', '/local-guidance.js?v=54', '/', '/index.html', '/inbox.html', '/styles.css', '/theme.js', '/inbox.css', '/inbox.js', '/inbox-store.js', '/inbox-fields.js', '/inbox-export.js', '/reviews.js', '/clarification.js', '/clarification.js?v=54', '/reviews.js?v=54', '/pwa.js?v=54', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
ASSETS.push('/clarification-flow.js', '/clarification-flow.js?v=54');
// Fresh module URLs bypass older workers' exact asset allowlists.
ASSETS.push('/inbox.js?v=54', '/inbox-store.js?v=54', '/inbox-fields.js?v=54', '/inbox-export.js?v=54', '/briefs.js', '/briefs.js?v=54', '/help.html');
ASSETS.push('/shared.html', '/shared.js', '/shared.js?v=54', '/shared.css', '/local-agent.js?v=54');
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
  const navigation = event.request.mode === 'navigate' && ['/', '/index.html', '/inbox.html', '/help.html', '/shared.html'].includes(url.pathname);
  if (!navigation && !ASSETS.includes(url.pathname + url.search)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(navigation ? url.pathname : event.request).then(cached => cached || fetch(event.request))));
});
