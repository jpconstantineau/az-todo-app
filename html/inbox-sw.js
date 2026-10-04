// Only public shell assets are cached. Never cache API/auth requests or task data.
const CACHE = 'todo-inbox-shell-v48';
// The agent module is public shell code, without model downloads or user data.
const ASSETS = ['/capture-extraction.js?v=48', '/workspaces.js', '/workspaces.js?v=48', '/local-guidance.js?v=48', '/', '/index.html', '/inbox.html', '/styles.css', '/theme.js', '/inbox.css', '/inbox.js', '/inbox-store.js', '/inbox-fields.js', '/inbox-export.js', '/reviews.js', '/clarification.js', '/clarification.js?v=48', '/reviews.js?v=48', '/pwa.js?v=48', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
// Fresh module URLs bypass older workers' exact asset allowlists.
ASSETS.push('/inbox.js?v=48', '/inbox-store.js?v=48', '/inbox-fields.js?v=48', '/inbox-export.js?v=48', '/briefs.js', '/briefs.js?v=48', '/help.html');
ASSETS.push('/shared.html', '/shared.js', '/shared.js?v=48', '/shared.css', '/local-agent.js?v=48');
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
