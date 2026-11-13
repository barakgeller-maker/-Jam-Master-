// Network-first, always revalidating with the server (GitHub Pages sends max-age=600,
// which otherwise keeps an old version for 10 minutes after an update).
const C = 'jm-v3';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== C) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || req.headers.get('range')) return;
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
    if (r.ok) { const cl = r.clone(); caches.open(C).then(c => c.put(req, cl)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
