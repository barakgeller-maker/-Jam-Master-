const C='jm-v1';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok&&!r.headers.get('content-range')){const cl=r.clone();caches.open(C).then(c=>c.put(e.request,cl));}return r;}).catch(()=>caches.match(e.request)));
});
